/**
 * The streaming coordinator (SP4b spec §3, D9, D10, D16, D21; master §4.1-§4.3): a per-frame `update(camera)` that
 * feeds the pool the T, D, L and MESH_COLUMN jobs of the needed sets around the camera's column, nearest and forward
 * first, checks each result at intake and hands every MESH payload to the sink. SP4a's one-shot `load()` is gone
 * (§3.13, §7.6): the first entry runs on this same coordinator with the camera held at the spawn (§3.11).
 *
 * - **The slot table** (§3.1, D9): one entry per torus slot `(cx & 63) + 64·(cz & 63)` (4,096, preallocated typed
 *   arrays): the column it tracks, its stage (0 Absent, 1 Proto, 2 Decorated, 3 Published), `meshed`, `meshSeq`, the
 *   `busy` job (0 none, 1 T … 4 MESH), the reader pins, `protoAlive`, the window column with its flags, the retries,
 *   `failed` and the four heap positions. The store's `status` stays the truth the workers read; the table mirrors it
 *   from results.
 * - **Classification** (§3.2): on a crossing or an RD change every slot gets the column it would hold in the 64-wide
 *   window around the camera's column, per axis `c = camC + ((s − camC + 32) & 63) − 32`, and that column's flags from
 *   `membershipTable(rd)` (0 outside RD + 5). An Absent slot follows its window column at once (even with its T in
 *   flight: that T's result is then dropped, below); a slot holding another column at Proto or later keeps it until
 *   its voxel unload (§3.5, SP4b Task 12).
 * - **Heaps** (§3.3, D10): one binary heap per stage, slot indices over the keys of `core/streamScore.ts` (the view
 *   term from the last rebuild's centre and yaw), ties by colKey; Floyd rebuild on a crossing, an RD change or a turn
 *   of more than 30° from the last rebuild's yaw (wrapped: `|((yaw − last) % 360 + 540) % 360 − 180| > 30`). A newly
 *   eligible job is pushed with its score from the last rebuild. `pump` takes the smallest top among the stages whose
 *   cap allows another job, without popping the jobs a cap holds back, and re-checks eligibility at the pop.
 * - **Eligibility** (§3.3): T for an Absent column of the T set whose record is free; D for a Proto column of the D set
 *   whose 3 × 3 are ≥ Proto with live protos; L for a Decorated column of the L set whose 3 × 3 are ≥ Decorated; MESH
 *   for a Published, unmeshed column of the MESH set whose 3 × 3 are Published; never busy or failed.
 * - **Caps** (§3.8, D29): N = `jobs.liveWorkers()`; T + D + L in flight ≤ `throttle.cap()`; T ≤ max(1, N − 1);
 *   MESH ≤ N; at most N in total, so the pool's queue never holds more than N world jobs.
 * - **Pins** (§3.5, D3): at issue a D job adds 1 to `protoReaders` of its nine columns, an L or MESH job to
 *   `finalReaders`; every settle subtracts them. A column is freed only at zero pins and when it is not busy.
 * - **Intake** (§3.6): T and D carry no versions; an L result is compared on the nine `blockVersion`s (even indices: its
 *   own commit and its neighbours' L commits legitimately bump `lightVersion`), a MESH result on all 18, against
 *   `store.versionsInto` into one preallocated scratch; a MESH result is also dropped unless its seq is the slot's
 *   `meshSeq` and the column is still in keepMesh; a result for a column the slot no longer tracks is dropped (a T
 *   whose slot moved on while it ran: its committed record is freed at once, since no job can read a column the table
 *   never saw at Proto). A dropped result counts in `dropped` and requeues. A MESH is staged once, through
 *   `sink.stage(payload, seq)`, and sets `meshed`; MESH is issued only for an unmeshed column, so no path stages a
 *   revealed column again (D16). After every settle the coordinator pumps again within the caps (SP4a's intake), so a
 *   worker never waits for the next frame.
 * - **`meshSeq`** (master §4.1, per column): a MESH in flight whose column leaves keepMesh is superseded (its seq bumped
 *   at the classification), so a result that comes back after the column left and re-entered the range is dropped.
 * - **Strict mode** (§3.6, D12: the first entry keeps SP4a's rule): while `strict`, any job rejection (`JobCancelled`
 *   included), a dropped result, a MESH without a payload, an intake exception and `liveWorkers()` decreasing emit
 *   `fatal` (the stage and column in the message, the rejection or null as the cause), without retries, and the
 *   coordinator stops issuing. Not strict: `JobCancelled` and `WorkerFailed` requeue; `StoreCorrupt`,
 *   `StoreCorruptError`, an intake exception and zero live workers emit `fatal`; any other rejection marks the column
 *   failed (SP4b Task 12 gives D12's retry, skip notice and StoreFull pause).
 * - **`dispose()`**: cancels the queued world jobs, stops issuing, frees every tracked column whose pins and `busy` are
 *   clear, and the rest as their jobs settle; `update` after it is a no-op.
 *
 * Without a crossing, a turn or an arriving result, `update` allocates nothing (§3.10): the counts are written into the
 * caller's object, the heaps and the version scratch are preallocated.
 */
import { TORUS_SIZE, colKey } from '../core/coords';
import { STAGE_BONUS, streamScore } from '../core/streamScore';
import type { ColumnMeshPayload } from '../mesh/column';
import { StoreCorrupt } from '../world/store/pool';
import { RD_MIN } from './renderDistance';
import {
  KEEP_VOXELS_EXTRA, M_D, M_KEEP_MESH, M_L, M_MESH, M_T, assertTorusSafe, membershipTable, stageOffsets, type Stage,
} from './rings';
import type { Throttle } from './throttle';
import { JobCancelled, StoreCorruptError, WorkerFailed, type ColumnDone, type WorkerPool } from './workerPool';

/** The camera as the coordinator reads it: blocks and degrees (spec §3.13). */
export interface StreamCamera {
  readonly x: number;
  readonly z: number;
  readonly yawDeg: number;
}

/** What a job resolved with: T and D carry no versions; L its 3 × 3 versions (18); MESH its payload and its versions. */
export interface JobOutcome {
  readonly versions: Int32Array | null;
  readonly payload: ColumnMeshPayload | null;
}

/** The pool seen by the coordinator (spec §3.13; `worldJobsOf` adapts the pool). */
export interface CoordinatorJobs {
  /** One job; `protoOnly` (T only) is `T(protoOnly)` (spec §3.7). */
  run(stage: Stage, cx: number, cz: number, protoOnly: boolean): Promise<JobOutcome>;
  /** Rejects the queued world jobs matching `pred` with JobCancelled; jobs already running finish. */
  cancel(pred: (stage: Stage, cx: number, cz: number) => boolean): void;
  /** The workers that have not failed: the caps follow it. */
  liveWorkers(): number;
}

/** The page's attached store, as the coordinator needs it (spec §3.13; `VoxelStore` satisfies it). */
export interface StreamStore {
  /** The 18 versions of the 3 × 3 around (cx, cz) into `out`, −1 for an absent column. */
  versionsInto(cx: number, cz: number, out: Int32Array): void;
  /** Who holds the record (cx, cz) maps to. */
  holder(cx: number, cz: number): 'free' | 'self' | 'other';
  freeColumn(cx: number, cz: number): void;
  freeProto(cx: number, cz: number): void;
}

/** Where meshes go (spec §3.13): the section renderer's staging. */
export interface StreamSink {
  /** One column's payload, with the slot's `meshSeq` at issue. */
  stage(p: ColumnMeshPayload, seq: number): void;
  /** Hides a meshed column and releases its rows (the mesh unload, SP4b Task 12). */
  remove(cx: number, cz: number): void;
}

/** What the coordinator reports to the page (spec §3.6, §7.4). */
export type StreamEvent =
  | { readonly kind: 'skipped'; readonly cx: number; readonly cz: number }
  | { readonly kind: 'storeFull'; readonly lowerRd: number | null }
  | { readonly kind: 'fatal'; readonly message: string; readonly cause: unknown };

export interface CoordinatorOptions {
  readonly jobs: CoordinatorJobs;
  readonly store: StreamStore;
  readonly sink: StreamSink;
  /** The generation cap (spec §3.8); the coordinator re-clamps its max when `liveWorkers()` changes. */
  readonly throttle: Throttle;
  /** The render distance, an integer in [RD_MIN, rdMax]. */
  readonly rd: number;
  /** The largest render distance `setRenderDistance` accepts (the reservation's cap); `assertTorusSafe` holds for it. */
  readonly rdMax: number;
  /** Keep every proto (D11: the page's setting; nothing calls `freeProto`). */
  readonly retainAllProtos: boolean;
  /** The first entry's rule (D12): any error is fatal. */
  readonly strict: boolean;
  readonly onEvent: (e: StreamEvent) => void;
}

/** One stage's columns in the current set: needed, done, in flight and queued (in its heap). */
export interface StageCounts {
  needed: number;
  done: number;
  inFlight: number;
  queued: number;
}

/** The coordinator's counts, written into a caller-owned object (spec §3.10, §7.3). */
export interface CoordinatorCounts {
  T: StageCounts;
  D: StageCounts;
  L: StageCounts;
  MESH: StageCounts;
  dropped: number;
  failed: number;
  storeFull: number;
  collisionWaits: number;
  genCap: number;
  rd: number;
  /** The last rebuild's centre column and yaw: the ready queue's centre (spec §3.9). */
  cx: number;
  cz: number;
  yawDeg: number;
}

export interface Coordinator {
  /** Per frame: re-centres on a crossing, rebuilds on a turn, issues within the caps; allocates nothing at rest. */
  update(cam: StreamCamera): void;
  /** Validated first (RangeError outside [RD_MIN, rdMax]); acts at the next `update` (spec §5). */
  setRenderDistance(rd: number): void;
  /** Strict while the first entry loads; the page turns it off at the reveal (D12). */
  setStrict(on: boolean): void;
  /** Every MESH column of the current set meshed and handed to the sink. */
  firstFill(): boolean;
  counts(out: CoordinatorCounts): CoordinatorCounts;
  dispose(): void;
}

/** A slot that tracks no column. */
export const NO_COLUMN = 0x7fffffff;

const SLOTS = TORUS_SIZE * TORUS_SIZE;
const TORUS_MASK = TORUS_SIZE - 1;
const HALF = TORUS_SIZE >> 1;
const STAGES: readonly Stage[] = ['T', 'D', 'L', 'MESH'];
const SET_FLAG: readonly number[] = [M_T, M_D, M_L, M_MESH];
const BONUS: readonly number[] = [STAGE_BONUS.T, STAGE_BONUS.D, STAGE_BONUS.L, STAGE_BONUS.MESH];
/** A turn beyond this from the last rebuild's yaw rebuilds the heaps (spec §3.3). */
const TURN_DEG = 30;
const DEG = Math.PI / 180;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A fresh counts object for `Coordinator.counts` (the page keeps one and reuses it every frame). */
export function createCoordinatorCounts(): CoordinatorCounts {
  const stage = (): StageCounts => ({ needed: 0, done: 0, inFlight: 0, queued: 0 });
  return { T: stage(), D: stage(), L: stage(), MESH: stage(), dropped: 0, failed: 0, storeFull: 0, collisionWaits: 0, genCap: 0, rd: 0, cx: 0, cz: 0, yawDeg: 0 };
}

/**
 * The pool as the coordinator's jobs (ruling P30, spec §3.13): T, D, L and MESH run `terrain` (with `protoOnly`),
 * `decorate`, `light` and `meshColumn`. T, D and L resolve `{ versions: done.versions, payload: null }` (light's 18
 * versions, null for terrain and decorate), MESH `{ versions: p.versions, payload: p }`; rejections pass through.
 * `cancel` is `cancelWorld`, `liveWorkers` the pool's.
 */
export function worldJobsOf(pool: Pick<WorkerPool, 'terrain' | 'decorate' | 'light' | 'meshColumn' | 'cancelWorld' | 'liveWorkers'>): CoordinatorJobs {
  const column = (d: ColumnDone): JobOutcome => ({ versions: d.versions, payload: null });
  return {
    run(stage, cx, cz, protoOnly) {
      switch (stage) {
        case 'T': return pool.terrain(cx, cz, protoOnly).then(column);
        case 'D': return pool.decorate(cx, cz).then(column);
        case 'L': return pool.light(cx, cz).then(column);
        case 'MESH': return pool.meshColumn(cx, cz).then((p) => ({ versions: p.versions, payload: p }));
      }
    },
    cancel(pred) {
      pool.cancelWorld(pred);
    },
    liveWorkers() {
      return pool.liveWorkers();
    },
  };
}

const frac = (done: number, needed: number): number => (needed > 0 ? Math.min(1, done / needed) : 0);

/**
 * The loading bar's fraction (SP4a spec §8.3): `0.2·T + 0.05·D + 0.25·L + 0.35·MESH + 0.15·uploads`, each done/needed
 * of the current sets (an empty total counts 0). Summed in hundredths, so a finished load reads exactly 1.
 */
export function progressFraction(c: CoordinatorCounts, uploadsDone: number, uploadsTotal: number): number {
  const s = 20 * frac(c.T.done, c.T.needed) + 5 * frac(c.D.done, c.D.needed) + 25 * frac(c.L.done, c.L.needed)
    + 35 * frac(c.MESH.done, c.MESH.needed) + 15 * frac(uploadsDone, uploadsTotal);
  return s / 100;
}

/**
 * The loading screen's phase line (SP4a spec §8.3): the earliest stage still running, T and D being "Generating";
 * once every column is meshed, "Preparing the view" (uploads, compile and the reveal).
 */
export function phaseName(c: CoordinatorCounts, uploadsDone: number, uploadsTotal: number): 'Generating' | 'Lighting' | 'Meshing' | 'Preparing the view' {
  if (c.T.done < c.T.needed || c.D.done < c.D.needed) return 'Generating';
  if (c.L.done < c.L.needed) return 'Lighting';
  if (c.MESH.done < c.MESH.needed) return 'Meshing';
  void uploadsDone; void uploadsTotal; // the uploads run after meshing, in the last phase
  return 'Preparing the view';
}

/** Throws RangeError unless rd is an integer in [RD_MIN, rdMax]. */
function checkRd(rd: number, rdMax: number): void {
  if (!Number.isInteger(rd) || rd < RD_MIN || rd > rdMax) {
    throw new RangeError(`render distance ${rd} is not an integer in [${RD_MIN}, ${rdMax}]`);
  }
}

/** The torus slot of column (cx, cz) (master §2.3's record index). */
const slotOf = (cx: number, cz: number): number => (cx & TORUS_MASK) + TORUS_SIZE * (cz & TORUS_MASK);

/** Whether the yaw turned more than 30° from `last`, across north included (Review Focus 2). */
const turned = (yaw: number, last: number): boolean => Math.abs(((((yaw - last) % 360) + 540) % 360) - 180) > TURN_DEG;

export function createCoordinator(o: CoordinatorOptions): Coordinator {
  // Validation first (spec §7.6): nothing is allocated or called before the render distances are checked.
  if (!Number.isInteger(o.rdMax) || o.rdMax < RD_MIN) throw new RangeError(`the render distance maximum ${o.rdMax} is not an integer ≥ ${RD_MIN}`);
  assertTorusSafe(o.rdMax);
  checkRd(o.rd, o.rdMax);

  const { jobs, store, sink, throttle, onEvent } = o;
  const rdMax = o.rdMax;
  let rd = o.rd;
  let strict = o.strict;

  // The slot table (spec §3.1).
  const tcx = new Int32Array(SLOTS).fill(NO_COLUMN);
  const tcz = new Int32Array(SLOTS).fill(NO_COLUMN);
  /** 0 Absent, 1 Proto, 2 Decorated, 3 Published: also the index of the slot's next job (MESH while unmeshed). */
  const stage = new Uint8Array(SLOTS);
  const meshed = new Uint8Array(SLOTS);
  const meshSeq = new Uint32Array(SLOTS);
  /** `meshSeq` when the slot's MESH was issued. */
  const issuedSeq = new Uint32Array(SLOTS);
  /** The in-flight job: 0 none, 1 T, 2 D, 3 L, 4 MESH. */
  const busy = new Uint8Array(SLOTS);
  const protoReaders = new Uint16Array(SLOTS);
  const finalReaders = new Uint16Array(SLOTS);
  const protoAlive = new Uint8Array(SLOTS);
  /** The column the slot would hold in the window around the camera's column, and its membership flags. */
  const wcx = new Int32Array(SLOTS).fill(NO_COLUMN);
  const wcz = new Int32Array(SLOTS).fill(NO_COLUMN);
  const wflags = new Uint8Array(SLOTS);
  const retries = new Uint8Array(SLOTS);
  const failed = new Uint8Array(SLOTS);

  // The four heaps (spec §3.3): heap h's entries at [h·SLOTS, h·SLOTS + len[h]); each entry's key and colKey tie are
  // stored per (heap, slot) when pushed, so a heap's order never depends on state that changes while it waits.
  const heap = new Int32Array(4 * SLOTS);
  const heapPos = new Int32Array(4 * SLOTS).fill(-1);
  const heapKey = new Float64Array(4 * SLOTS);
  const heapTie = new Float64Array(4 * SLOTS);
  const heapLen = new Int32Array(4);

  const inFlight = new Int32Array(4);
  let total = 0;
  const scratch = new Int32Array(18);

  /** The camera's column at the last update, and whether one happened. */
  let camCx = 0;
  let camCz = 0;
  let placed = false;
  let reclassify = false;
  /** The last rebuild's centre and yaw, and its unit forward (`[sin yaw, −cos yaw]`, `player/fly.ts`'s convention). */
  let rcx = 0;
  let rcz = 0;
  let ryaw = 0;
  let fx = 0;
  let fz = -1;

  let dropped = 0;
  /** `liveWorkers()` at the last check; −1 before the first. */
  let live = -1;
  /** No more jobs are issued (a fatal error, or dispose). */
  let stopped = false;
  let fatalSent = false;
  let disposed = false;

  const tracks = (s: number, cx: number, cz: number): boolean => tcx[s] === cx && tcz[s] === cz;
  /** The tracked column's flags: its window flags when it is the window column, else none (it lies beyond RD + 5). */
  const flagsOf = (s: number): number => (tcx[s] === wcx[s] && tcz[s] === wcz[s] ? wflags[s]! : 0);

  function fatal(message: string, cause: unknown): void {
    stopped = true;
    if (fatalSent) return;
    fatalSent = true;
    onEvent({ kind: 'fatal', message, cause });
  }

  /** The stage index of the slot's next job if it is eligible now (spec §3.3), else −1. */
  function nextJob(s: number): number {
    if (stopped || busy[s] !== 0 || failed[s] !== 0) return -1;
    const f = flagsOf(s);
    if (f === 0) return -1;
    const st = stage[s]!;
    if (st === 3 && meshed[s] !== 0) return -1;
    if ((f & SET_FLAG[st]!) === 0) return -1;
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    if (st === 0) return store.holder(cx, cz) === 'free' ? 0 : -1;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (!tracks(n, cx + dx, cz + dz) || stage[n]! < st) return -1;
        if (st === 1 && protoAlive[n] === 0) return -1;
      }
    }
    return st;
  }

  // ---- the heaps

  /** Whether heap h's entry for slot a sorts before its entry for slot b. */
  function less(h: number, a: number, b: number): boolean {
    const ka = heapKey[h * SLOTS + a]!;
    const kb = heapKey[h * SLOTS + b]!;
    return ka < kb || (ka === kb && heapTie[h * SLOTS + a]! < heapTie[h * SLOTS + b]!);
  }

  function place(h: number, i: number, s: number): void {
    heap[h * SLOTS + i] = s;
    heapPos[h * SLOTS + s] = i;
  }

  function siftUp(h: number, i: number): void {
    const base = h * SLOTS;
    const s = heap[base + i]!;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const ps = heap[base + p]!;
      if (!less(h, s, ps)) break;
      place(h, i, ps);
      i = p;
    }
    place(h, i, s);
  }

  function siftDown(h: number, i: number): void {
    const base = h * SLOTS;
    const n = heapLen[h]!;
    const s = heap[base + i]!;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      let c = l;
      if (r < n && less(h, heap[base + r]!, heap[base + l]!)) c = r;
      const cs = heap[base + c]!;
      if (!less(h, cs, s)) break;
      place(h, i, cs);
      i = c;
    }
    place(h, i, s);
  }

  /** Sets the slot's key in heap h from the last rebuild's centre and forward. */
  function keyFor(h: number, s: number): void {
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    heapKey[h * SLOTS + s] = streamScore(cx - rcx, cz - rcz, fx, fz, BONUS[h]!);
    heapTie[h * SLOTS + s] = colKey(cx, cz);
  }

  function push(h: number, s: number): void {
    if (heapPos[h * SLOTS + s]! >= 0) return;
    keyFor(h, s);
    const i = heapLen[h]!;
    heapLen[h] = i + 1;
    place(h, i, s);
    siftUp(h, i);
  }

  function pop(h: number): number {
    const base = h * SLOTS;
    const top = heap[base]!;
    heapPos[base + top] = -1;
    const n = heapLen[h]! - 1;
    heapLen[h] = n;
    if (n > 0) {
      place(h, 0, heap[base + n]!);
      siftDown(h, 0);
    }
    return top;
  }

  function clearHeaps(): void {
    for (let h = 0; h < 4; h++) {
      const base = h * SLOTS;
      for (let i = 0; i < heapLen[h]!; i++) heapPos[base + heap[base + i]!] = -1;
      heapLen[h] = 0;
    }
  }

  /** Every eligible slot into its stage's heap, keyed from the last rebuild, then Floyd's O(n) heapify. */
  function rebuild(): void {
    clearHeaps();
    for (let s = 0; s < SLOTS; s++) {
      const h = nextJob(s);
      if (h < 0) continue;
      keyFor(h, s);
      const i = heapLen[h]!;
      heapLen[h] = i + 1;
      place(h, i, s);
    }
    for (let h = 0; h < 4; h++) for (let i = (heapLen[h]! >> 1) - 1; i >= 0; i--) siftDown(h, i);
  }

  /** Pushes the slot's next job when it is eligible (a newly eligible job keeps the last rebuild's centre and yaw). */
  function consider(s: number): void {
    const h = nextJob(s);
    if (h >= 0) push(h, s);
  }

  /** Considers the 3 × 3 around (cx, cz): a stage reached there may make each of them ready for its next job. */
  function considerAround(cx: number, cz: number): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (tracks(n, cx + dx, cz + dz)) consider(n);
      }
    }
  }

  // ---- re-centring

  function setView(cx: number, cz: number, yawDeg: number): void {
    rcx = cx;
    rcz = cz;
    ryaw = yawDeg;
    fx = Math.sin(yawDeg * DEG);
    fz = -Math.cos(yawDeg * DEG);
  }

  /** Every slot's window column and flags around the camera's column (spec §3.2). */
  function classify(): void {
    const table = membershipTable(rd);
    const R = rd + KEEP_VOXELS_EXTRA;
    const side = 2 * R + 1;
    for (let s = 0; s < SLOTS; s++) {
      const x = camCx + ((((s & TORUS_MASK) - camCx) + HALF) & TORUS_MASK) - HALF;
      const z = camCz + ((((s >> 6) - camCz) + HALF) & TORUS_MASK) - HALF;
      const dx = x - camCx;
      const dz = z - camCz;
      wcx[s] = x;
      wcz[s] = z;
      wflags[s] = dx >= -R && dx <= R && dz >= -R && dz <= R ? table[(dz + R) * side + dx + R]! : 0;
      if (stage[s] === 0 && !tracks(s, x, z)) {
        // An Absent slot follows its window column; a T still running for the old one is dropped at intake.
        tcx[s] = x;
        tcz[s] = z;
        meshed[s] = 0;
        protoAlive[s] = 0;
        failed[s] = 0;
        retries[s] = 0;
      }
      // A MESH in flight for a column outside keepMesh is superseded: its result is dropped even if the column returns.
      if (busy[s] === 4 && (flagsOf(s) & M_KEEP_MESH) === 0) meshSeq[s] = meshSeq[s]! + 1;
    }
  }

  // ---- issuing

  /** Reads `liveWorkers()`: the throttle's max follows it; while strict a decrease is fatal, and zero always is. */
  function checkLive(): void {
    const n = jobs.liveWorkers();
    if (n === live) return;
    const was = live;
    live = n;
    if (n <= 0) {
      fatal('no live worker is left', null);
      return;
    }
    if (strict && was > n) {
      fatal(`a worker failed: ${n} of ${was} workers live`, null);
      return;
    }
    throttle.setMax(Math.max(1, n - 1));
  }

  /** Issues ready jobs, the smallest score first among the stages whose cap allows one more (spec §3.3, §3.8). */
  function pump(): void {
    if (stopped) return;
    checkLive();
    for (;;) {
      if (stopped) return;
      const N = live;
      if (total >= N) return;
      const genFull = inFlight[0]! + inFlight[1]! + inFlight[2]! >= throttle.cap();
      let best = -1;
      for (let h = 0; h < 4; h++) {
        if (heapLen[h] === 0) continue;
        if (h < 3 && genFull) continue;
        if (h === 0 && inFlight[0]! >= Math.max(1, N - 1)) continue;
        if (h === 3 && inFlight[3]! >= N) continue;
        if (best < 0) {
          best = h;
          continue;
        }
        const a = heap[h * SLOTS]!;
        const b = heap[best * SLOTS]!;
        const ka = heapKey[h * SLOTS + a]!;
        const kb = heapKey[best * SLOTS + b]!;
        if (ka < kb || (ka === kb && heapTie[h * SLOTS + a]! < heapTie[best * SLOTS + b]!)) best = h;
      }
      if (best < 0) return;
      const s = pop(best);
      // Eligibility is checked again at the pop: a job whose column left its set (or whose state moved) leaves here.
      if (nextJob(s) !== best) continue;
      issue(best, s);
    }
  }

  /** Adds `d` to the pins a job of stage h at (cx, cz) holds on its 3 × 3 (D: proto readers; L, MESH: final readers). */
  function pin(h: number, cx: number, cz: number, d: number): void {
    if (h === 0) return;
    const pins = h === 1 ? protoReaders : finalReaders;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        pins[n] = pins[n]! + d;
      }
    }
  }

  function issue(h: number, s: number): void {
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    busy[s] = h + 1;
    inFlight[h] = inFlight[h]! + 1;
    total++;
    if (h === 3) issuedSeq[s] = meshSeq[s]!;
    const seq = issuedSeq[s]!;
    pin(h, cx, cz, 1);
    let job: Promise<JobOutcome>;
    try {
      job = jobs.run(STAGES[h]!, cx, cz, false);
    } catch (e) {
      job = Promise.reject(e);
    }
    job.then(
      (out) => settle(h, s, cx, cz, seq, out, null),
      (e: unknown) => settle(h, s, cx, cz, seq, null, e),
    );
  }

  // ---- intake

  function settle(h: number, s: number, cx: number, cz: number, seq: number, out: JobOutcome | null, err: unknown): void {
    inFlight[h] = inFlight[h]! - 1;
    total--;
    busy[s] = 0;
    pin(h, cx, cz, -1);
    try {
      if (disposed) {
        // A T that committed after dispose holds a record no job reads: free it; then whatever its settle unpinned.
        if (h === 0 && out !== null) store.freeColumn(cx, cz);
        sweep();
        return;
      }
      if (stopped) return;
      if (out === null) rejected(h, s, cx, cz, err);
      else intake(h, s, cx, cz, seq, out);
      pump();
    } catch (e) {
      fatal(`${STAGES[h]} at (${cx}, ${cz}): intake failed: ${errorText(e)}`, e);
    }
  }

  /** A dropped result (spec §3.6): counted, then requeued (fatal while strict). */
  function drop(h: number, s: number, cx: number, cz: number, why: string): void {
    dropped++;
    if (strict) {
      fatal(`dropped result: ${STAGES[h]} at (${cx}, ${cz}): ${why}`, null);
      return;
    }
    consider(s);
  }

  function intake(h: number, s: number, cx: number, cz: number, seq: number, out: JobOutcome): void {
    if (!tracks(s, cx, cz)) {
      // Only an Absent slot moves on, so this is a T whose slot now tracks its window column: the T committed a record
      // that no job can read (the table never saw it at Proto), so it is freed now and the slot's own T can claim it.
      if (h === 0) store.freeColumn(cx, cz);
      drop(h, s, cx, cz, `the slot now tracks (${tcx[s]}, ${tcz[s]})`);
      return;
    }
    if (h === 3 && out.payload === null) {
      if (strict) fatal(`MESH at (${cx}, ${cz}) returned no payload`, null);
      else failed[s] = 1;
      return;
    }
    if (h >= 2) {
      // L on the nine blockVersions (even indices), MESH on all 18 (SP4a's intake rule).
      const v = out.versions;
      store.versionsInto(cx, cz, scratch);
      const step = h === 2 ? 2 : 1;
      let same = v !== null && v.length === 18;
      for (let k = 0; same && k < 18; k += step) same = v![k] === scratch[k];
      if (!same) {
        const got = v === null ? 'none' : `[${Array.from(v).join(', ')}]`;
        drop(h, s, cx, cz, `recorded versions ${got}, the store's at intake are [${Array.from(scratch).join(', ')}]`);
        return;
      }
    }
    if (h === 3) {
      if (seq !== meshSeq[s]) {
        drop(h, s, cx, cz, `meshSeq ${seq} superseded by ${meshSeq[s]}`);
        return;
      }
      if ((flagsOf(s) & M_KEEP_MESH) === 0) {
        drop(h, s, cx, cz, 'the column left keepMesh');
        return;
      }
      sink.stage(out.payload!, seq);
      meshed[s] = 1;
      return;
    }
    stage[s] = h + 1;
    if (h === 0) protoAlive[s] = 1;
    considerAround(cx, cz);
  }

  /** A rejected job (spec §3.6): fatal while strict; else D12's first part (SP4b Task 12 completes it). */
  function rejected(h: number, s: number, cx: number, cz: number, e: unknown): void {
    if (strict || e instanceof StoreCorrupt || e instanceof StoreCorruptError) {
      fatal(`${STAGES[h]} at (${cx}, ${cz}) failed: ${errorText(e)}`, e);
      return;
    }
    if (!(e instanceof JobCancelled) && !(e instanceof WorkerFailed) && tracks(s, cx, cz)) failed[s] = 1;
    consider(s);
  }

  // ---- dispose

  /** Frees every tracked column that is neither busy nor pinned and forgets its slot (after dispose). */
  function sweep(): void {
    for (let s = 0; s < SLOTS; s++) {
      if (tcx[s] === NO_COLUMN || busy[s] !== 0 || protoReaders[s] !== 0 || finalReaders[s] !== 0) continue;
      if (stage[s]! >= 1) store.freeColumn(tcx[s]!, tcz[s]!);
      tcx[s] = NO_COLUMN;
      tcz[s] = NO_COLUMN;
      stage[s] = 0;
      meshed[s] = 0;
      protoAlive[s] = 0;
    }
  }

  /** The done counts of the current sets and the failed columns, from one pass over the table. */
  function countDone(out: CoordinatorCounts): void {
    let t = 0;
    let d = 0;
    let l = 0;
    let m = 0;
    let f = 0;
    for (let s = 0; s < SLOTS; s++) {
      if (failed[s] !== 0) f++;
      const fl = flagsOf(s);
      if (fl === 0) continue;
      const st = stage[s]!;
      if ((fl & M_T) !== 0 && st >= 1) t++;
      if ((fl & M_D) !== 0 && st >= 2) d++;
      if ((fl & M_L) !== 0 && st >= 3) l++;
      if ((fl & M_MESH) !== 0 && meshed[s] !== 0) m++;
    }
    out.T.done = t;
    out.D.done = d;
    out.L.done = l;
    out.MESH.done = m;
    out.failed = f;
  }

  return {
    update(cam) {
      if (stopped) return;
      checkLive();
      if (stopped) return;
      const cx = Math.floor(cam.x) >> 4;
      const cz = Math.floor(cam.z) >> 4;
      if (!placed || reclassify || cx !== camCx || cz !== camCz) {
        placed = true;
        reclassify = false;
        camCx = cx;
        camCz = cz;
        setView(cx, cz, cam.yawDeg);
        classify();
        rebuild();
      } else if (turned(cam.yawDeg, ryaw)) {
        setView(camCx, camCz, cam.yawDeg);
        rebuild();
      }
      pump();
    },

    setRenderDistance(r) {
      checkRd(r, rdMax);
      if (r === rd) return;
      rd = r;
      reclassify = true;
    },

    setStrict(on) {
      strict = on;
    },

    firstFill() {
      if (!placed || reclassify) return false;
      let m = 0;
      for (let s = 0; s < SLOTS; s++) if ((flagsOf(s) & M_MESH) !== 0 && meshed[s] !== 0) m++;
      return m === stageOffsets(rd).MESH.length;
    },

    counts(out) {
      const offs = stageOffsets(rd);
      out.T.needed = offs.T.length;
      out.D.needed = offs.D.length;
      out.L.needed = offs.L.length;
      out.MESH.needed = offs.MESH.length;
      countDone(out);
      out.T.inFlight = inFlight[0]!;
      out.D.inFlight = inFlight[1]!;
      out.L.inFlight = inFlight[2]!;
      out.MESH.inFlight = inFlight[3]!;
      out.T.queued = heapLen[0]!;
      out.D.queued = heapLen[1]!;
      out.L.queued = heapLen[2]!;
      out.MESH.queued = heapLen[3]!;
      out.dropped = dropped;
      out.storeFull = 0;
      out.collisionWaits = 0;
      out.genCap = throttle.cap();
      out.rd = rd;
      out.cx = rcx;
      out.cz = rcz;
      out.yawDeg = ryaw;
      return out;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopped = true;
      clearHeaps();
      jobs.cancel(() => true);
      sweep();
    },
  };
}

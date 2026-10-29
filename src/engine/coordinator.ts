/**
 * The streaming coordinator (SP4b spec §3, D3, D8-D12, D16, D18, D21; master §4.1-§4.3): a per-frame `update(camera)`
 * that feeds the pool the T, D, L and MESH_COLUMN jobs of the needed sets around the camera's column, nearest and
 * forward first, checks each result at intake, hands every MESH payload to the sink and unloads what the camera left
 * behind. SP4a's one-shot `load()` is gone (§3.13, §7.6): the first entry runs on this same coordinator with the camera
 * held at the spawn (§3.11).
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
 *   `finalReaders`; every settle (a reply, a rejection, a failure) subtracts them. They are main-thread counters, not
 *   locks (master §4.1). A column is freed, or its proto dropped, only at zero pins and when it is not busy.
 * - **Unloads** (§3.5, master §4.2's hysteresis), in `update`: a meshed column outside keepMesh (RD + 1) is hidden
 *   (`sink.remove`, `meshed` 0, `meshSeq` + 1), ≤ 64 per update; then a column outside keepVoxels (RD + 5), not busy,
 *   pins 0, is freed (`store.freeColumn`; a meshed one is hidden first, within the 64) and its slot returns to Absent
 *   with `failed` and the retries cleared, ≤ 16 per update, in the order of the T score of the needed column the slot's
 *   window maps to (the T the free unblocks; slots whose window column is not needed last), so after a long crossing
 *   terrain appears nearest-first. The candidates are collected on a crossing or an RD change, and queued again when a
 *   settle drops a pin of (or clears the job of) a column outside its keep set; at rest nothing is scanned.
 * - **Record collisions** (§3.5): a T whose record still holds another column (the slot tracks it until its voxel
 *   unload, or the store says `other`) waits; each such T counts once per wait in `collisionWaits`. No `SlotBusy`
 *   reaches a worker.
 * - **Cancellation** (§3.6, D8): on a crossing or an RD change, `jobs.cancel` drops the queued pool jobs whose columns
 *   left their stage's set; heap entries leave at the next pop or rebuild; in-flight jobs finish and are judged at
 *   intake.
 * - **Proto retention** (§3.7, D11; off while `retainAllProtos`, the page's setting): after the voxel frees, ≤ 16 protos
 *   are freed (`store.freeProto`) of columns at Decorated or later, with no job reading or writing them, outside the
 *   proto ring, and with no column of their 3 × 3 in the D set below Decorated. A D whose 3 × 3 holds a Decorated or
 *   Published column without a live proto first gets `T(protoOnly)` for it, at the D's score.
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
 *   coordinator stops issuing.
 * - **Errors after the reveal** (§3.6, D12; not strict): `JobCancelled` and `WorkerFailed` requeue silently, with no
 *   retry counted; any other rejection (INTERNAL), or a MESH without a payload, requeues once, and the second failure
 *   marks the column `failed` (skipped by every stage, so its neighbours' dependent jobs wait, until its voxels unload);
 *   the first failed column emits `skipped`, and more than 32 in the session (`FAILED_FATAL`) emit `fatal`;
 *   `StoreFullError` counts in `storeFull` and pauses new T jobs (and the job that met it) until the next voxel unload
 *   frees a column, emitting `storeFull` with `lowerRd(rd)` once per pause (the RD never changes on its own);
 *   `StoreCorrupt`, `StoreCorruptError`, an intake or unload exception and zero live workers emit `fatal`. The caps and
 *   `throttle.setMax(max(1, N − 1))` follow `liveWorkers()` whenever it changes.
 * - **`setRenderDistance(rd)`** (§5): validated (RangeError outside [RD_MIN, rdMax]); the next `update` re-classifies,
 *   collects the unloads, cancels and rebuilds, so lowering it drops the far terrain by the rules above.
 * - **`dispose()`**: cancels the queued world jobs, stops issuing, frees every tracked column whose pins and `busy` are
 *   clear, and the rest as their jobs settle; `update` after it is a no-op. After a fatal error nothing is freed (the
 *   store may be what failed; the page discards it).
 *
 * Without a crossing, a turn or an arriving result, `update` allocates nothing (§3.10): the counts are written into the
 * caller's object, the heaps (four stage heaps and three unload heaps) and the version scratch are preallocated, and
 * the cancel predicate is created once.
 *
 * SP4c (spec §4.2, §4.4-§4.6, D3, D5, D7, the technical review's C1):
 * - **The generation gate:** `pump` issues nothing unless `jobs.generation()` (the pool's epoch) equals
 *   `appliedGeneration` (the options' `generation`, then `adopt`'s), so a draft the map configured and the world has
 *   not applied holds the world; the heaps are kept. `adopt(generation)` sets it and rebuilds the heaps: no epoch
 *   changes, nothing is freed, staged or unstaged.
 * - **The per-column epoch:** `wEpoch` (the options' `epoch`) is the applied world; per slot `colEpoch` (the epoch its
 *   T was issued under, set at the T's intake; 0 for Absent), `shownEpoch` and `stagedEpoch` (the epochs of the payload
 *   the sink shows and of one staged and not yet shown) and `busyEpoch` (`wEpoch` at the job's issue). D, L and MESH
 *   need their 3 × 3 at the stage with `colEpoch === wEpoch`; MESH also needs the target (`stagedEpoch || shownEpoch`)
 *   ≠ `wEpoch`, and a Published current column whose target is `wEpoch` is marked `meshed` without one.
 * - **The sink's column** (`sinkCx`, `sinkCz`; `NO_COLUMN` when the sink holds nothing): set at `stage`, which also
 *   sets `stagedEpoch = wEpoch` (asserted 0 before: a column is staged at most once per epoch); every removal names it
 *   (`unmesh`), the mesh unloads key on it (outside keepMesh), and `classify` removes the mesh of a sink column an
 *   Absent slot will no longer track before the slot follows its window column.
 * - **Intake (D7):** T, D and L results are recorded as the store stands, whatever generation they ran under; a MESH
 *   whose `busyEpoch` ≠ `wEpoch` is dropped.
 * - **Counts:** `done` counts current columns only; `stale` the MESH-set columns with (stage ≥ 1 and `colEpoch` ≠
 *   `wEpoch`) or (target ≠ 0 and ≠ `wEpoch`); `epoch` is `wEpoch`.
 * - **`apply`** (spec §4.5, D6; "old meshes are kept on Apply", master §6.3): sets `wEpoch` and `appliedGeneration`,
 *   then in one pass over the slots resolves every pending payload of another epoch through `sink.unstage` (dropped:
 *   the shown payload stays, and with none shown the sink column is cleared; not dropped: it is shown), bumps the
 *   stale columns' `meshSeq` (stage ≥ 1, `colEpoch` ≠ `wEpoch`; their `meshed` cleared) and sets a current Published
 *   column's `meshed` to whether its target is `wEpoch`; then re-collects the unloads and rebuilds the stage heaps. A
 *   stale column is freeable inside keepVoxels too (zero pins, not busy), queued in the free heap by `apply` and by
 *   every settle's `unloadCheck`, ≤ 16 per update in the order of its own T score; such a free returns the slot to
 *   Absent but keeps the shown mesh (`sinkCx`, `sinkCz`, `shownEpoch`), which the column's next payload swaps. The mesh
 *   unload also hides a sink column outside the MESH set whose target is not `wEpoch` (no MESH replaces it), ≤ 64 per
 *   update. No Published final set is rewritten in place: SP5a's sim worker stays its first writer (master §4.1).
 *
 * SP5a (spec §2.1, §2.7):
 * - **The edit gate:** `editState(cx, cz)` is 0 when the 3 × 3 is tracked, Published, current and not failed; 2 when
 *   one of an otherwise loaded 3 × 3 is stale ("regenerating"); 1 otherwise ("not loaded"). The page posts an edit only
 *   at 0, so no L in flight reads the edited column (an L needs a Decorated column, which the gate excludes).
 * - **The sim's pins:** `simPin` adds 1 to `simPins` of the 3 × 3 until the reply's `simUnpin`; `freeable` also needs
 *   `simPins` 0. A sim reply is no job, so a slot whose count reaches 0 queues its unloads again itself, and a stale
 *   column pinned at `apply` is freed with no crossing. `simUnpinAll` is the sim failure path.
 * - **Edit remeshes** (§2.6, D22): `markEdited(colKeys)`, called at the reply, bumps each tracked slot's `editSeq` and
 *   `meshSeq` and puts it on the edit ring (a preallocated FIFO, a slot at most once), then pumps. `pump` drains the ring
 *   before the generation gate and the caps (a MESH reads only final sets): a slot that is not busy, Published, current
 *   and not failed, whose 3 × 3 is Published and current, inside keepMesh and in the MESH set or shown, gets its MESH
 *   (`edit` true: the pool's aux lane at −1000), counted in `inFlight[3]` and `total`, so the stream jobs yield; a busy
 *   slot stays on the ring until its settle; any other leaves it (the stream heap meshes it once it is eligible). A
 *   slot whose `editSeq` is newer than `stagedEditSeq` (the editSeq of the payload last staged) is exempt from the two
 *   "already meshed" rules and may be staged again at the same epoch (the renderers replace a pending payload and keep
 *   the shown one), so D16's one stage per epoch holds for every column without an edit. At intake, before the
 *   versions, a MESH whose slot's `editSeq` moved since its issue, or whose slot is pinned by the sim (published, not yet
 *   answered), is an edit drop: counted in `editDropped`, never fatal, requeued unless the slot is on the ring (which
 *   issues it again). `onEditStaged(cx, cz)` is called when a payload issued at or after the slot's latest
 *   `markEdited` is staged: the first reveal of that column after it is the edit's.
 */
import { TORUS_SIZE, colKey, colKeyCx, colKeyCz } from '../core/coords';
import { STAGE_BONUS, streamScore } from '../core/streamScore';
import type { ColumnMeshPayload } from '../mesh/column';
import type { ColumnDiff } from '../world/store/api';
import { StoreCorrupt } from '../world/store/pool';
import { RD_MIN, lowerRd } from './renderDistance';
import {
  KEEP_VOXELS_EXTRA, M_D, M_KEEP_MESH, M_KEEP_VOXELS, M_L, M_MESH, M_PROTO_RING, M_T, assertTorusSafe, membershipTable,
  stageOffsets, type Stage,
} from './rings';
import type { WorldStage } from './invalidation';
import type { Throttle } from './throttle';
import { JobCancelled, StoreCorruptError, StoreFullError, WorkerFailed, type ColumnDone, type WorkerPool } from './workerPool';

/** The camera as the coordinator reads it: blocks and degrees (spec §3.13). */
export interface StreamCamera {
  readonly x: number;
  readonly z: number;
  readonly yawDeg: number;
}

/**
 * What a job resolved with: T and D carry no versions; L its 3 × 3 versions (18); MESH its payload and its versions.
 * `generation` is the pool's epoch the job was issued under (SP4c spec §4.6, D7).
 */
export interface JobOutcome {
  readonly versions: Int32Array | null;
  readonly payload: ColumnMeshPayload | null;
  readonly generation: number;
}

/** The pool seen by the coordinator (spec §3.13; `worldJobsOf` adapts the pool). */
export interface CoordinatorJobs {
  /**
   * One job; `protoOnly` (T only) is `T(protoOnly)` (spec §3.7); `edit` (MESH only) is an edit's remesh, which the pool
   * runs first (SP5a spec §2.6, D22).
   */
  run(stage: Stage, cx: number, cz: number, protoOnly: boolean, edit: boolean): Promise<JobOutcome>;
  /** Rejects the queued world jobs matching `pred` with JobCancelled; jobs already running finish. */
  cancel(pred: (stage: Stage, cx: number, cz: number) => boolean): void;
  /** The workers that have not failed: the caps follow it. */
  liveWorkers(): number;
  /** The pool's generation now (its `epoch`): world jobs are issued only while it is the applied one (SP4c §4.2). */
  generation(): number;
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
  /** One column's payload, with the slot's `meshSeq` at issue (on a shown column: the swap, SP4c spec §5.1). */
  stage(p: ColumnMeshPayload, seq: number): void;
  /**
   * Drops the column's pending payload, if any (SP4c spec §4.4, §5.1): true when one was dropped (the shown payload
   * stays), false when the staged payload is already shown.
   */
  unstage(cx: number, cz: number): boolean;
  /** Hides a meshed column and releases its rows (the mesh unload, spec §3.5). */
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
  /** The pool's generation of the world's first configure: the applied generation (SP4c spec §4.2, §4.10). */
  readonly generation: number;
  /** The first configure's epoch (`epochOf` of its genKey; the page's is 1): the applied epoch, an integer ≥ 1. */
  readonly epoch: number;
  readonly onEvent: (e: StreamEvent) => void;
  /**
   * Called when a payload issued at or after the slot's latest `markEdited` is staged (SP5a spec §4.6, §6.2): the first
   * reveal of (cx, cz) after it shows the edit.
   */
  readonly onEditStaged?: (cx: number, cz: number) => void;
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
  /** MESH results dropped by an edit (SP5a spec §2.6): the slot's `editSeq` moved, or the sim pinned it; not in `dropped`. */
  editDropped: number;
  failed: number;
  storeFull: number;
  collisionWaits: number;
  genCap: number;
  rd: number;
  /** The last rebuild's centre column and yaw: the ready queue's centre (spec §3.9). */
  cx: number;
  cz: number;
  yawDeg: number;
  /**
   * The MESH-set columns that are stale (SP4c spec §4.4): stage ≥ 1 with `colEpoch` ≠ the applied epoch, or a target
   * mesh epoch that is non-zero and not the applied one. A column not yet generated is not stale.
   */
  stale: number;
  /** The applied epoch (`wEpoch`). */
  epoch: number;
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
  /**
   * The world applies the pool's generation `generation` with the same genKey (SP4c spec §4.3, §4.5): sets the applied
   * generation and rebuilds the heaps; changes no epoch, frees, stages and unstages nothing. Issuing resumes at the
   * next `update`. Allocates nothing.
   */
  adopt(generation: number): void;
  /**
   * The world applies a draft of another world (SP4c spec §4.5, D6): `epoch` (the interned genKey) and the pool's
   * `generation` become the applied ones; in one pass over the slots, a pending payload of another epoch is resolved
   * through `sink.unstage`, the stale columns' `meshSeq` is bumped (they become freeable inside keepVoxels, nearest
   * first, keeping their shown meshes), the current columns' `meshed` follows their target, and the unload and stage
   * heaps are rebuilt. SP4c regenerates from T whatever `from` says. Issuing resumes at the next `update`. Allocates
   * nothing.
   */
  apply(a: { readonly epoch: number; readonly generation: number; readonly from: WorldStage }): void;
  /**
   * True while (cx, cz)'s slot tracks it marked failed (skipped after two failures, spec §3.6) until its voxels
   * unload. Only that column is marked: the neighbours it stops short of MESH (its 7 × 7 when skipped at T, 5 × 5 at
   * D, 3 × 3 at L) are not. The page's fog scan counts as filled every column within 3 of a skipped one, so neither
   * the skipped column nor the hole around it holds the fog (final review UI-4, rulings R16).
   */
  isSkipped(cx: number, cz: number): boolean;
  /**
   * The edit gate (SP5a spec §2.1, D13): 0 when every column of (cx, cz)'s 3 × 3 is tracked, Published, at the applied
   * epoch (`colEpoch === wEpoch`) and not failed (an edit may be posted); 2 when every column is tracked, not failed
   * and Published or stale, and one is stale ("regenerating": generated under another epoch, after an Apply); 1
   * otherwise ("not loaded"). An in-flight MESH does not close it: the writer is copy-on-write and the MESH's result is
   * dropped by its versions. Allocates nothing.
   */
  editState(cx: number, cz: number): 0 | 1 | 2;
  /**
   * An edit posted to the sim (SP5a spec §2.1, §2.7): adds 1 to `simPins` of (cx, cz)'s 3 × 3, so none of them is freed
   * (`freeable` requires `simPins` 0) until its reply's `simUnpin`.
   */
  simPin(cx: number, cz: number): void;
  /**
   * The sim's reply (SP5a spec §2.7): subtracts 1 from `simPins` of (cx, cz)'s 3 × 3; a slot whose count reaches 0 runs
   * `unloadCheck` and `considerAround`, as a settle does (a sim reply is no job, so nothing else queues its free again).
   * A count already at 0 stays 0 and runs nothing (a backstop: the `Uint16Array` would wrap to 65535 and pin the column
   * for ever).
   */
  simUnpin(cx: number, cz: number): void;
  /** The sim failed (SP5a spec §2.1): every `simPins` count to 0, each such slot then as `simUnpin`. */
  simUnpinAll(): void;
  /**
   * The sim's `edited` reply's dirty columns (SP5a spec §2.6, D22; colKeys): each tracked one's `editSeq` and `meshSeq`
   * bumped (a MESH of it in flight drops at intake) and the slot queued on the edit ring, then issued at once past the
   * caps and the generation gate (a busy slot at its settle).
   */
  markEdited(keys: ArrayLike<number>): void;
  counts(out: CoordinatorCounts): CoordinatorCounts;
  dispose(): void;
}

/** A slot that tracks no column. */
export const NO_COLUMN = 0x7fffffff;
/** Meshed columns hidden for removal per update (spec §3.5, D18). */
export const MESH_REMOVALS_PER_FRAME = 64;
/** Columns freed per update (spec §3.5, D18). */
export const FREES_PER_FRAME = 16;
/** Protos freed per update, after the column frees (spec §3.7; the plan's bound). */
export const PROTO_FREES_PER_FRAME = 16;
/** More failed columns than this in a session is a systematic fault: `fatal` (spec §3.6). */
export const FAILED_FATAL = 32;

const SLOTS = TORUS_SIZE * TORUS_SIZE;
const TORUS_MASK = TORUS_SIZE - 1;
const HALF = TORUS_SIZE >> 1;
const STAGES: readonly Stage[] = ['T', 'D', 'L', 'MESH'];
const SET_FLAG: readonly number[] = [M_T, M_D, M_L, M_MESH];
const BONUS: readonly number[] = [STAGE_BONUS.T, STAGE_BONUS.D, STAGE_BONUS.L, STAGE_BONUS.MESH];
/** A turn beyond this from the last rebuild's yaw rebuilds the heaps (spec §3.3). */
const TURN_DEG = 30;
const DEG = Math.PI / 180;
/** The heaps: 0-3 the stages' jobs (spec §3.3), then the mesh unloads, the column frees and the proto frees. */
const H_MESH_OUT = 4;
const H_FREE = 5;
const H_PROTO = 6;
const HEAPS = 7;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The pool's option of an edit's remesh (SP5a spec §2.6), made once. */
const EDIT_MESH = Object.freeze({ edit: true });

/** A fresh counts object for `Coordinator.counts` (the page keeps one and reuses it every frame). */
export function createCoordinatorCounts(): CoordinatorCounts {
  const stage = (): StageCounts => ({ needed: 0, done: 0, inFlight: 0, queued: 0 });
  return {
    T: stage(), D: stage(), L: stage(), MESH: stage(), dropped: 0, editDropped: 0, failed: 0, storeFull: 0, collisionWaits: 0, genCap: 0, rd: 0,
    cx: 0, cz: 0, yawDeg: 0, stale: 0, epoch: 0,
  };
}

/**
 * D's read-through (SP5a spec §2.5, D21): whether column (cx, cz) holds edit entries, and its entries, null when it
 * holds none or the sim failed (§2.1). `SimClient` satisfies it.
 */
export interface ReadThrough {
  hasEntries(cx: number, cz: number): boolean;
  diff(cx: number, cz: number): Promise<ColumnDiff | null>;
}

/**
 * The pool as the coordinator's jobs (ruling P30, spec §3.13): T, D, L and MESH run `terrain` (with `protoOnly`),
 * `decorate`, `light` and `meshColumn` (an edit's with `{ edit: true }`, SP5a spec §2.6). T, D and L resolve
 * `{ versions: done.versions, payload: null }` (light's 18 versions, null for terrain and decorate), MESH
 * `{ versions: p.versions, payload: p }` from the pool's `MeshColumnDone`
 * (each outcome carries the reply's `generation`, the pool's epoch at issue, SP4c spec §4.6); rejections pass through.
 * `cancel` is `cancelWorld`, `liveWorkers` the pool's, `generation()` the pool's `epoch` now (SP4c spec §4.2).
 *
 * With a `readThrough` (SP5a spec §2.5, D21), a D on a column for which `hasEntries` is true first awaits its `diff`
 * and passes it on the decorate (none when it resolves null: the sim failed, and D runs without an overlay); every
 * other job runs as without one, with no wait. The coordinator sees the wait as the D's own time in flight. The pool
 * stamps a job's generation and scope when it is issued, so such a D captures the pool's `epoch` and decorate scope
 * (`scopeOf`) before the wait: if either moved when the diff resolves (a configure or a `bumpScope` meanwhile), it
 * rejects with JobCancelled, as a queued D would, and decorates nothing; the coordinator requeues it behind its
 * generation gate (SIM-4).
 */
export function worldJobsOf(
  pool: Pick<WorkerPool, 'epoch' | 'scopeOf' | 'terrain' | 'decorate' | 'light' | 'meshColumn' | 'cancelWorld' | 'liveWorkers'>,
  readThrough: ReadThrough | null = null,
): CoordinatorJobs {
  const column = (d: ColumnDone): JobOutcome => ({ versions: d.versions, payload: null, generation: d.generation });
  const mesh = ({ payload, generation }: { readonly payload: ColumnMeshPayload; readonly generation: number }): JobOutcome => (
    { versions: payload.versions, payload, generation }
  );
  /** D through the read-through: the diff, then the decorate, unless the generation or the decorate scope moved meanwhile. */
  const readDecorate = (rt: ReadThrough, cx: number, cz: number): Promise<ColumnDone> => {
    const epoch = pool.epoch;
    const scope = pool.scopeOf('decorate');
    return rt.diff(cx, cz).then((diff) => (
      pool.epoch !== epoch || pool.scopeOf('decorate') !== scope ? Promise.reject(new JobCancelled()) : pool.decorate(cx, cz, diff ?? undefined)
    ));
  };
  return {
    run(stage, cx, cz, protoOnly, edit) {
      switch (stage) {
        case 'T': return pool.terrain(cx, cz, protoOnly).then(column);
        case 'D': return (readThrough !== null && readThrough.hasEntries(cx, cz) ? readDecorate(readThrough, cx, cz) : pool.decorate(cx, cz)).then(column);
        case 'L': return pool.light(cx, cz).then(column);
        case 'MESH': return (edit ? pool.meshColumn(cx, cz, EDIT_MESH) : pool.meshColumn(cx, cz)).then(mesh);
      }
    },
    cancel(pred) {
      pool.cancelWorld(pred);
    },
    liveWorkers() {
      return pool.liveWorkers();
    },
    generation() {
      return pool.epoch;
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
  if (!Number.isInteger(o.epoch) || o.epoch < 1) throw new RangeError(`the first epoch ${o.epoch} is not an integer ≥ 1`);
  if (!Number.isInteger(o.generation)) throw new RangeError(`the first generation ${o.generation} is not an integer`);

  const { jobs, store, sink, throttle, onEvent } = o;
  const rdMax = o.rdMax;
  const retainAllProtos = o.retainAllProtos;
  let rd = o.rd;
  let strict = o.strict;
  /** The applied epoch (SP4c spec §4.4) and the pool generation the world applied (§4.2's gate). */
  let wEpoch = o.epoch;
  let appliedGeneration = o.generation;

  // The slot table (spec §3.1).
  const tcx = new Int32Array(SLOTS).fill(NO_COLUMN);
  const tcz = new Int32Array(SLOTS).fill(NO_COLUMN);
  /** 0 Absent, 1 Proto, 2 Decorated, 3 Published: also the index of the slot's next job (MESH while unmeshed). */
  const stage = new Uint8Array(SLOTS);
  const meshed = new Uint8Array(SLOTS);
  const meshSeq = new Uint32Array(SLOTS);
  /** `meshSeq` when the slot's MESH was issued. */
  const issuedSeq = new Uint32Array(SLOTS);
  /** The in-flight job: 0 none, 1 T (T(protoOnly) included), 2 D, 3 L, 4 MESH. */
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
  /** The slot's T waits on a record collision (counted once per wait in `collisionWaits`). */
  const colliding = new Uint8Array(SLOTS);
  /** The slot's job met StoreFull: it waits for the pause to end (spec §3.6). */
  const waitFull = new Uint8Array(SLOTS);
  // The per-column epoch (SP4c spec §4.4): the epoch the column's T was issued under (0 for Absent), the epochs of the
  // payload the sink shows for the slot's sink column and of one staged and not yet shown (0 when none), and `wEpoch`
  // at the in-flight job's issue.
  const colEpoch = new Int32Array(SLOTS);
  const shownEpoch = new Int32Array(SLOTS);
  const stagedEpoch = new Int32Array(SLOTS);
  const busyEpoch = new Int32Array(SLOTS);
  /** The column whose rows the sink holds for the slot (shown or staged), NO_COLUMN when none (C1). */
  const sinkCx = new Int32Array(SLOTS).fill(NO_COLUMN);
  const sinkCz = new Int32Array(SLOTS).fill(NO_COLUMN);
  /** The sim's edits in flight whose 3 × 3 holds the slot's column (SP5a spec §2.1, §2.7): it is not freed while > 0. */
  const simPins = new Uint16Array(SLOTS);
  // Edit remeshes (SP5a spec §2.6, D22): per slot the `markEdited` count, its value when the slot's MESH was issued and
  // when its last payload was staged (an edit is pending while `editSeq` is newer); the edit ring, a FIFO of slots.
  const editSeq = new Uint32Array(SLOTS);
  const issuedEditSeq = new Uint32Array(SLOTS);
  const stagedEditSeq = new Uint32Array(SLOTS);
  const editRing = new Int32Array(SLOTS);
  const onRing = new Uint8Array(SLOTS);
  let ringHead = 0;
  let ringLen = 0;
  const onEditStaged = o.onEditStaged ?? null;

  // The heaps (spec §3.3, §3.5, §3.7): heap h's entries at [h·SLOTS, h·SLOTS + len[h]); each entry's key and colKey tie
  // are stored per (heap, slot) when pushed, so a heap's order never depends on state that changes while it waits.
  const heap = new Int32Array(HEAPS * SLOTS);
  const heapPos = new Int32Array(HEAPS * SLOTS).fill(-1);
  const heapKey = new Float64Array(HEAPS * SLOTS);
  const heapTie = new Float64Array(HEAPS * SLOTS);
  const heapLen = new Int32Array(HEAPS);
  /** While set, pushes append without sifting (a rebuild or a collection heapifies once at the end). */
  let bulk = false;

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
  let editDropped = 0;
  let collisionWaits = 0;
  let storeFull = 0;
  /** New T jobs wait for the next voxel unload (StoreFull, spec §3.6). */
  let paused = false;
  /** The columns marked failed in this session (FAILED_FATAL), and whether `skipped` was sent. */
  let failedTotal = 0;
  let skippedSent = false;
  /** `liveWorkers()` at the last check; −1 before the first. */
  let live = -1;
  /** No more jobs are issued (a fatal error, or dispose). */
  let stopped = false;
  let fatalSent = false;
  let disposed = false;

  const tracks = (s: number, cx: number, cz: number): boolean => tcx[s] === cx && tcz[s] === cz;
  /** The tracked column's flags: its window flags when it is the window column, else none (it lies beyond RD + 5). */
  const flagsOf = (s: number): number => (tcx[s] === wcx[s] && tcz[s] === wcz[s] ? wflags[s]! : 0);
  /** The flags of column (cx, cz) (none beyond the window) and its stage in the table (0 when no slot tracks it). */
  const flagsAt = (cx: number, cz: number): number => {
    const s = slotOf(cx, cz);
    return wcx[s] === cx && wcz[s] === cz ? wflags[s]! : 0;
  };
  const stageAt = (cx: number, cz: number): number => {
    const s = slotOf(cx, cz);
    return tracks(s, cx, cz) ? stage[s]! : 0;
  };
  /** The epoch the slot's sink column will show once its uploads finish: its target (SP4c spec §4.4); 0 for none. */
  const targetOf = (s: number): number => stagedEpoch[s] || shownEpoch[s]!;
  /**
   * Whether the sink's column for the slot is to be hidden (the mesh unload, SP4c spec §4.5): it lies outside keepMesh,
   * or outside the MESH set with a target other than the applied epoch (no MESH will replace it).
   */
  const sinkOutside = (s: number): boolean => {
    if (sinkCx[s] === NO_COLUMN) return false;
    const f = flagsAt(sinkCx[s]!, sinkCz[s]!);
    return (f & M_KEEP_MESH) === 0 || ((f & M_MESH) === 0 && targetOf(s) !== wEpoch);
  };
  /** Whether the slot's column is stale: generated (stage ≥ 1) under another epoch than the applied one (§4.4). */
  const isStale = (s: number): boolean => stage[s]! >= 1 && colEpoch[s] !== wEpoch;
  /** Whether the slot has an edit not yet in a staged payload (SP5a spec §2.6): `editSeq` newer than the staged one. */
  const editPending = (s: number): boolean => editSeq[s]! > stagedEditSeq[s]!;

  function fatal(message: string, cause: unknown): void {
    stopped = true;
    if (fatalSent) return;
    fatalSent = true;
    onEvent({ kind: 'fatal', message, cause });
  }

  // ---- eligibility

  /** The stage index of the slot's next job if it is eligible now (spec §3.3), else −1. */
  function nextJob(s: number): number {
    if (stopped || busy[s] !== 0 || failed[s] !== 0) return -1;
    const f = flagsOf(s);
    if (f === 0) return -1;
    const st = stage[s]!;
    // An edited column is meshed again whatever its mesh (SP5a spec §2.6): neither "already meshed" rule applies.
    const edited = editPending(s);
    if (st === 3 && meshed[s] !== 0 && !edited) return -1;
    if ((f & SET_FLAG[st]!) === 0) return -1;
    if (paused && (st === 0 || waitFull[s] !== 0)) return -1;
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    if (st === 0) {
      const holder = store.holder(cx, cz);
      if (holder === 'free') return 0;
      if (holder === 'other') collide(s);
      return -1;
    }
    if (st === 3 && !edited && colEpoch[s] === wEpoch && targetOf(s) === wEpoch) {
      // A Published current column whose mesh is (or is staged) at the applied epoch needs no MESH (SP4c spec §4.4).
      meshed[s] = 1;
      return -1;
    }
    // D, L and MESH need their 3 × 3 at the stage, every column of it current (SP4c spec §4.4).
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (!tracks(n, cx + dx, cz + dz) || stage[n]! < st || colEpoch[n] !== wEpoch) return -1;
      }
    }
    if (st !== 1) return st;
    // D also needs the 3 × 3's protos (spec §3.7): a Decorated or Published neighbour without one first gets
    // T(protoOnly), at this D's score.
    let ready = true;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (protoAlive[n] !== 0) continue;
        ready = false;
        if (busy[n] === 0 && failed[n] === 0 && !paused) pushKeyed(0, n, score(cx, cz, 1), colKey(cx + dx, cz + dz));
      }
    }
    return ready ? 1 : -1;
  }

  /** Counts the slot's T as waiting on a record collision, once per wait (spec §3.5). */
  function collide(s: number): void {
    if (colliding[s] !== 0) return;
    colliding[s] = 1;
    collisionWaits++;
  }

  /** Whether a D of the D set below Decorated reads the slot's proto: one of its 3 × 3 at Proto (spec §3.7). */
  function protoNeeded(s: number): boolean {
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (tracks(n, cx + dx, cz + dz) && stage[n] === 1 && failed[n] === 0 && (flagsOf(n) & M_D) !== 0) return true;
      }
    }
    return false;
  }

  /** T(protoOnly) for the slot is eligible: a Decorated or Published column without a proto that a pending D needs. */
  function protoWanted(s: number): boolean {
    return !stopped && !paused && busy[s] === 0 && failed[s] === 0 && stage[s]! >= 2 && protoAlive[s] === 0 && protoNeeded(s);
  }

  /** Whether heap h's top slot s may be issued now: its own next job, or T(protoOnly) (re-checked at the pop). */
  function ready(h: number, s: number): boolean {
    return h === 0 && stage[s]! >= 2 ? protoWanted(s) : nextJob(s) === h;
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

  /** The stage score of column (cx, cz)'s job of stage h, from the last rebuild's centre and forward. */
  const score = (cx: number, cz: number, h: number): number => streamScore(cx - rcx, cz - rcz, fx, fz, BONUS[h]!);

  /**
   * Pushes slot s into heap h with this key, or lowers its key if it is there with a larger one (a T(protoOnly) wanted
   * by a nearer D). In bulk mode the entry is appended unsifted.
   */
  function pushKeyed(h: number, s: number, key: number, tie: number): void {
    const at = h * SLOTS + s;
    const pos = heapPos[at]!;
    if (pos >= 0) {
      if (key > heapKey[at]! || (key === heapKey[at]! && tie >= heapTie[at]!)) return;
      heapKey[at] = key;
      heapTie[at] = tie;
      if (!bulk) siftUp(h, pos);
      return;
    }
    heapKey[at] = key;
    heapTie[at] = tie;
    const i = heapLen[h]!;
    heapLen[h] = i + 1;
    place(h, i, s);
    if (!bulk) siftUp(h, i);
  }

  /** Slot s into stage heap h, keyed by its tracked column's score. */
  function push(h: number, s: number): void {
    pushKeyed(h, s, score(tcx[s]!, tcz[s]!, h), colKey(tcx[s]!, tcz[s]!));
  }

  /**
   * Slot s into unload heap h (spec §3.5): keyed by the T score of the needed column its window maps to (the T the
   * unload unblocks), slots whose window column is not needed last; ties by that column's colKey.
   */
  function pushUnload(h: number, s: number): void {
    const x = wcx[s]!;
    const z = wcz[s]!;
    pushKeyed(h, s, (wflags[s]! & M_T) !== 0 ? score(x, z, 0) : Infinity, colKey(x, z));
  }

  function top(h: number): number {
    return heap[h * SLOTS]!;
  }

  function pop(h: number): number {
    const base = h * SLOTS;
    const t = heap[base]!;
    heapPos[base + t] = -1;
    const n = heapLen[h]! - 1;
    heapLen[h] = n;
    if (n > 0) {
      place(h, 0, heap[base + n]!);
      siftDown(h, 0);
    }
    return t;
  }

  /** Takes slot s out of heap h, wherever it is. */
  function remove(h: number, s: number): void {
    const base = h * SLOTS;
    const i = heapPos[base + s]!;
    if (i < 0) return;
    heapPos[base + s] = -1;
    const n = heapLen[h]! - 1;
    heapLen[h] = n;
    if (i === n) return;
    const moved = heap[base + n]!;
    place(h, i, moved);
    siftDown(h, i);
    siftUp(h, heapPos[base + moved]!);
  }

  function clearHeap(h: number): void {
    const base = h * SLOTS;
    for (let i = 0; i < heapLen[h]!; i++) heapPos[base + heap[base + i]!] = -1;
    heapLen[h] = 0;
  }

  /** Floyd's O(n) heapify of heap h. */
  function heapify(h: number): void {
    for (let i = (heapLen[h]! >> 1) - 1; i >= 0; i--) siftDown(h, i);
  }

  /** Every eligible slot into its stage's heap, keyed from the last rebuild, then Floyd's O(n) heapify (spec §3.3). */
  function rebuild(): void {
    for (let h = 0; h < 4; h++) clearHeap(h);
    bulk = true;
    for (let s = 0; s < SLOTS; s++) consider(s);
    bulk = false;
    for (let h = 0; h < 4; h++) heapify(h);
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

  /** Requeues the slot's column and its 3 × 3 (a D around it may have waited for its T(protoOnly), L or MESH). */
  function requeue(s: number): void {
    if (tcx[s] === NO_COLUMN) return;
    considerAround(tcx[s]!, tcz[s]!);
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
      if (stage[s] === 0) {
        if (!tracks(s, x, z)) {
          // An Absent slot follows its window column; a T still running for the old one is dropped at intake. A mesh the
          // sink still holds for another column (one freed with its old mesh kept, SP4c spec §4.5) goes first: the slot
          // will no longer track it, so nothing else would remove it (no ghost geometry, C1).
          if (sinkCx[s] !== NO_COLUMN && (sinkCx[s] !== x || sinkCz[s] !== z)) unmesh(s);
          follow(s);
        } else if ((wflags[s]! & M_KEEP_VOXELS) === 0) {
          // An Absent column's voxel unload: no record to free, only its failed mark and retries go (spec §3.1).
          failed[s] = 0;
          retries[s] = 0;
        }
      } else if (tracks(s, x, z)) {
        colliding[s] = 0;
      } else if ((wflags[s]! & M_T) !== 0) {
        // The slot's needed column waits until the column the slot still holds is unloaded (spec §3.5).
        collide(s);
      }
      // A MESH in flight for a column outside keepMesh is superseded: its result is dropped even if the column returns.
      if (busy[s] === 4 && (flagsOf(s) & M_KEEP_MESH) === 0) meshSeq[s] = meshSeq[s]! + 1;
    }
  }

  /** The slot now tracks its window column at Absent, every per-column mark cleared (spec §3.1). */
  function follow(s: number): void {
    tcx[s] = wcx[s]!;
    tcz[s] = wcz[s]!;
    stage[s] = 0;
    colEpoch[s] = 0;
    meshed[s] = 0;
    protoAlive[s] = 0;
    failed[s] = 0;
    retries[s] = 0;
    colliding[s] = 0;
    waitFull[s] = 0;
    // A new (or regenerated) column has no edit pending: its first MESH reads its edits (D's overlay, SP5a spec §2.5).
    stagedEditSeq[s] = editSeq[s]!;
  }

  // ---- unloads (spec §3.5, §3.7)

  /**
   * Queues the slot's unloads: its sink column's mesh (outside keepMesh, or a stale one outside the MESH set), and its
   * voxels if it lies beyond keepVoxels or is stale (SP4c spec §4.5: a stale column is freed inside keepVoxels too, so
   * one busy or pinned at `apply` is queued again by the settle that ends its job).
   */
  function unloadCheck(s: number): void {
    // The mesh unload keys on the sink's column, apart from `meshed` (SP4c spec §4.5).
    if (sinkOutside(s)) pushUnload(H_MESH_OUT, s);
    if (tcx[s] === NO_COLUMN) return;
    if (stage[s]! >= 1 && ((flagsOf(s) & M_KEEP_VOXELS) === 0 || colEpoch[s] !== wEpoch)) pushUnload(H_FREE, s);
  }

  /** Queues the slot's proto free (with the rule off) if it is Decorated or Published with a live proto. */
  function protoCheck(s: number): void {
    if (!retainAllProtos && stage[s]! >= 2 && protoAlive[s] !== 0) pushUnload(H_PROTO, s);
  }

  /** Re-collects every unload candidate (on a crossing or an RD change): one pass, then one heapify per heap. */
  function collectUnloads(): void {
    clearHeap(H_MESH_OUT);
    clearHeap(H_FREE);
    clearHeap(H_PROTO);
    bulk = true;
    for (let s = 0; s < SLOTS; s++) {
      unloadCheck(s);
      protoCheck(s);
    }
    bulk = false;
    heapify(H_MESH_OUT);
    heapify(H_FREE);
    heapify(H_PROTO);
  }

  /**
   * Whether the slot's column may be freed now: tracked at Proto or later, beyond keepVoxels or stale (SP4c spec §4.5),
   * not busy, unpinned by jobs and by the sim's edits (SP5a spec §2.1).
   */
  function freeable(s: number): boolean {
    return tcx[s] !== NO_COLUMN && (isStale(s) || (stage[s]! >= 1 && (flagsOf(s) & M_KEEP_VOXELS) === 0)) && busy[s] === 0
      && protoReaders[s] === 0 && finalReaders[s] === 0 && simPins[s] === 0;
  }

  /** A slot whose `simPins` reached 0 (SP5a spec §2.7): its unloads queued again and its 3 × 3 considered, as a settle. */
  function simReleased(s: number): void {
    if (disposed) return;
    unloadCheck(s);
    if (tcx[s] !== NO_COLUMN) considerAround(tcx[s]!, tcz[s]!);
  }

  /**
   * Whether the slot's proto may be freed now (spec §3.7, master §4.2): Decorated or later with a live proto, no job
   * reading or writing it, outside the proto ring, and no column of its 3 × 3 in the D set below Decorated.
   */
  function protoFreeable(s: number): boolean {
    if (tcx[s] === NO_COLUMN || stage[s]! < 2 || protoAlive[s] === 0 || busy[s] !== 0 || protoReaders[s] !== 0) return false;
    if ((flagsOf(s) & M_PROTO_RING) !== 0) return false;
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((flagsAt(cx + dx, cz + dz) & M_D) !== 0 && stageAt(cx + dx, cz + dz) < 2) return false;
      }
    }
    return true;
  }

  /**
   * Hides the slot's mesh: the sink releases the rows of its sink column (SP4c spec §4.5, C1), both mesh epochs and the
   * sink column are cleared, and a MESH result of the old seq is dropped (spec §3.1).
   */
  function unmesh(s: number): void {
    sink.remove(sinkCx[s]!, sinkCz[s]!);
    sinkCx[s] = NO_COLUMN;
    sinkCz[s] = NO_COLUMN;
    shownEpoch[s] = 0;
    stagedEpoch[s] = 0;
    meshed[s] = 0;
    meshSeq[s] = meshSeq[s]! + 1;
    remove(H_MESH_OUT, s);
  }

  /**
   * The frame's unloads (spec §3.5, §3.7): ≤ 64 meshes hidden, then ≤ 16 columns freed in the order of their slots'
   * needed columns (a meshed one is hidden first, within the 64), then ≤ 16 protos freed. A candidate that is pinned
   * or busy leaves its heap; the settle that clears it queues it again. Returns whether a free ended a StoreFull pause.
   */
  function unload(): boolean {
    let hidden = 0;
    while (hidden < MESH_REMOVALS_PER_FRAME && heapLen[H_MESH_OUT]! > 0) {
      const s = pop(H_MESH_OUT);
      if (!sinkOutside(s)) continue;
      unmesh(s);
      hidden++;
    }
    let freed = 0;
    while (freed < FREES_PER_FRAME && heapLen[H_FREE]! > 0) {
      const s = top(H_FREE);
      if (!freeable(s)) {
        pop(H_FREE);
        continue;
      }
      // Beyond keepVoxels the mesh goes first; a stale column freed inside keepVoxels keeps its shown mesh until its new
      // payload replaces it (SP4c spec §4.5): `sinkCx`, `sinkCz` and `shownEpoch` stay, and the slot follows the same
      // column (its window column), so the swap finds them.
      if (sinkCx[s] !== NO_COLUMN && (flagsOf(s) & M_KEEP_VOXELS) === 0) {
        if (hidden >= MESH_REMOVALS_PER_FRAME) break;
        unmesh(s);
        hidden++;
      }
      pop(H_FREE);
      store.freeColumn(tcx[s]!, tcz[s]!);
      for (let h = 0; h < 4; h++) remove(h, s);
      remove(H_PROTO, s);
      follow(s);
      // The slot now tracks its needed column: its T, keyed from the last rebuild (none while paused: the caller rebuilds).
      consider(s);
      freed++;
    }
    let protos = 0;
    while (protos < PROTO_FREES_PER_FRAME && heapLen[H_PROTO]! > 0) {
      const s = pop(H_PROTO);
      if (!protoFreeable(s)) continue;
      store.freeProto(tcx[s]!, tcz[s]!);
      protoAlive[s] = 0;
      protos++;
    }
    if (freed > 0 && paused) {
      paused = false;
      waitFull.fill(0);
      return true;
    }
    return false;
  }

  /** Whether a queued pool job is no longer wanted (spec §3.6, D8): its column left its stage's set or its slot. */
  const unwanted = (st: Stage, cx: number, cz: number): boolean => {
    const s = slotOf(cx, cz);
    if (!tracks(s, cx, cz)) return true;
    const h = st === 'T' ? 0 : st === 'D' ? 1 : st === 'L' ? 2 : 3;
    if (h === 0 && stage[s]! >= 2) return !protoNeeded(s);
    return (flagsOf(s) & SET_FLAG[h]!) === 0;
  };

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

  /** Slot s onto the back of the edit ring, unless it is on it. */
  function ringPush(s: number): void {
    if (onRing[s] !== 0) return;
    onRing[s] = 1;
    editRing[(ringHead + ringLen) & (SLOTS - 1)] = s;
    ringLen++;
  }

  /**
   * Whether the slot's edit MESH may be issued now (SP5a spec §2.6): Published, current and not failed, its 3 × 3
   * Published and current, inside keepMesh, and in the MESH set or shown (a mesh kept by the hysteresis is redone too).
   */
  function editReady(s: number): boolean {
    if (tcx[s] === NO_COLUMN || stage[s] !== 3 || colEpoch[s] !== wEpoch || failed[s] !== 0) return false;
    const f = flagsOf(s);
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    if ((f & M_KEEP_MESH) === 0 || ((f & M_MESH) === 0 && (sinkCx[s] !== cx || sinkCz[s] !== cz))) return false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (!tracks(n, cx + dx, cz + dz) || stage[n] !== 3 || colEpoch[n] !== wEpoch) return false;
      }
    }
    return true;
  }

  /**
   * Drains the edit ring once round (SP5a spec §2.6, D22), past the caps and the generation gate: a busy slot goes to
   * the back until its settle; one whose edit is pending and ready gets its MESH; any other leaves the ring.
   */
  function drainEdits(): void {
    for (let n = ringLen; n > 0 && !stopped; n--) {
      const s = editRing[ringHead]!;
      ringHead = (ringHead + 1) & (SLOTS - 1);
      ringLen--;
      onRing[s] = 0;
      if (!editPending(s)) continue;
      if (busy[s] !== 0) ringPush(s);
      else if (editReady(s)) issue(3, s, true);
    }
  }

  /** Issues ready jobs, the smallest score first among the stages whose cap allows one more (spec §3.3, §3.8). */
  function pump(): void {
    if (stopped) return;
    checkLive();
    // Edit remeshes first, past the gate and the caps (SP5a spec §2.6): they count in `inFlight[3]` and `total`.
    if (ringLen > 0) drainEdits();
    // The generation gate (SP4c spec §4.2, D3): a configure the world has not applied holds every world job.
    if (jobs.generation() !== appliedGeneration) return;
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
        const a = top(h);
        const b = top(best);
        const ka = heapKey[h * SLOTS + a]!;
        const kb = heapKey[best * SLOTS + b]!;
        if (ka < kb || (ka === kb && heapTie[h * SLOTS + a]! < heapTie[best * SLOTS + b]!)) best = h;
      }
      if (best < 0) return;
      const s = pop(best);
      // Eligibility is checked again at the pop: a job whose column left its set (or whose state moved) leaves here.
      if (!ready(best, s)) continue;
      issue(best, s, false);
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

  /** Issues stage h's job for slot s; `edit` (MESH only): an edit's remesh (SP5a spec §2.6). */
  function issue(h: number, s: number, edit: boolean): void {
    const cx = tcx[s]!;
    const cz = tcz[s]!;
    const protoOnly = h === 0 && stage[s]! >= 2;
    busy[s] = h + 1;
    busyEpoch[s] = wEpoch;
    inFlight[h] = inFlight[h]! + 1;
    total++;
    if (h === 0) colliding[s] = 0;
    if (h === 3) {
      issuedSeq[s] = meshSeq[s]!;
      issuedEditSeq[s] = editSeq[s]!;
    }
    const seq = issuedSeq[s]!;
    pin(h, cx, cz, 1);
    let job: Promise<JobOutcome>;
    try {
      job = jobs.run(STAGES[h]!, cx, cz, protoOnly, edit);
    } catch (e) {
      job = Promise.reject(e);
    }
    job.then(
      (out) => settle(h, s, cx, cz, seq, protoOnly, out, null),
      (e: unknown) => settle(h, s, cx, cz, seq, protoOnly, null, e),
    );
  }

  // ---- intake

  function settle(h: number, s: number, cx: number, cz: number, seq: number, protoOnly: boolean, out: JobOutcome | null, err: unknown): void {
    inFlight[h] = inFlight[h]! - 1;
    total--;
    busy[s] = 0;
    pin(h, cx, cz, -1);
    if (disposed) {
      if (fatalSent) return;
      try {
        // A T that committed after dispose holds a record no job reads: free it; then whatever its settle unpinned.
        if (h === 0 && !protoOnly && out !== null && stage[s] === 0) store.freeColumn(cx, cz);
        sweep();
      } catch {
        fatalSent = true; // the store failed while the page tears down: it is discarded with the page
      }
      return;
    }
    try {
      if (stopped) return;
      if (out === null) rejected(h, s, cx, cz, protoOnly, err);
      else intake(h, s, cx, cz, seq, protoOnly, out);
      unpinned(h, s, cx, cz);
      pump();
    } catch (e) {
      fatal(`${STAGES[h]} at (${cx}, ${cz}): intake failed: ${errorText(e)}`, e);
    }
  }

  /**
   * After a settle (spec §3.5, §3.7): the columns whose pins dropped, and the job's own column, are queued for their
   * unloads if they lie outside their keep sets; after a D, its 3 × 3 are queued for the proto rule.
   */
  function unpinned(h: number, s: number, cx: number, cz: number): void {
    if (h === 0) {
      if (tracks(s, cx, cz)) unloadCheck(s);
      return;
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = slotOf(cx + dx, cz + dz);
        if (!tracks(n, cx + dx, cz + dz)) continue;
        unloadCheck(n);
        if (h === 1) protoCheck(n);
      }
    }
  }

  /** A dropped result (spec §3.6): counted, then requeued (fatal while strict). */
  function drop(h: number, s: number, cx: number, cz: number, why: string): void {
    dropped++;
    if (strict) {
      fatal(`dropped result: ${STAGES[h]} at (${cx}, ${cz}): ${why}`, null);
      return;
    }
    requeue(s);
  }

  function intake(h: number, s: number, cx: number, cz: number, seq: number, protoOnly: boolean, out: JobOutcome): void {
    if (!tracks(s, cx, cz)) {
      // Only an Absent slot moves on, so this is a T whose slot now tracks its window column: the T committed a record
      // that no job can read (the table never saw it at Proto), so it is freed now and the slot's own T can claim it.
      if (h === 0) store.freeColumn(cx, cz);
      drop(h, s, cx, cz, `the slot now tracks (${tcx[s]}, ${tcz[s]})`);
      return;
    }
    if (h === 3 && out.payload === null) {
      if (strict) fatal(`MESH at (${cx}, ${cz}) returned no payload`, null);
      else failure(h, s, cx, cz, new Error(`MESH at (${cx}, ${cz}) returned no payload`));
      return;
    }
    if (h === 3 && (editSeq[s] !== issuedEditSeq[s] || simPins[s] !== 0)) {
      // An edit drop (SP5a spec §2.6), before the versions an edit's publish moves: the slot was marked edited since
      // the issue, or an edit is published and not yet answered. Never fatal; the ring issues a slot it holds again.
      editDropped++;
      if (onRing[s] === 0) requeue(s);
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
      if (busyEpoch[s] !== wEpoch) {
        // Meshed under another applied epoch (SP4c spec §4.6): its seq no longer matches either.
        drop(h, s, cx, cz, `issued at epoch ${busyEpoch[s]}, the applied epoch is ${wEpoch}`);
        return;
      }
      if (seq !== meshSeq[s]) {
        drop(h, s, cx, cz, `meshSeq ${seq} superseded by ${meshSeq[s]}`);
        return;
      }
      if ((flagsOf(s) & M_KEEP_MESH) === 0) {
        drop(h, s, cx, cz, 'the column left keepMesh');
        return;
      }
      // A column is staged at most once per epoch (SP4c spec §4.4): a pending payload of another epoch was resolved by
      // `apply` before this MESH was issued, and one at this epoch makes the target this epoch (no MESH); an edit's
      // payload (issued with a newer `editSeq` than the staged one) is staged again at the same epoch (SP5a spec §2.6).
      const edited = issuedEditSeq[s]! > stagedEditSeq[s]!;
      if (stagedEpoch[s] !== 0 && !(edited && stagedEpoch[s] === wEpoch)) {
        throw new Error(`MESH at (${cx}, ${cz}) staged over a pending payload of epoch ${stagedEpoch[s]}`);
      }
      sink.stage(out.payload!, seq);
      sinkCx[s] = cx;
      sinkCz[s] = cz;
      stagedEpoch[s] = wEpoch;
      stagedEditSeq[s] = issuedEditSeq[s]!;
      meshed[s] = 1;
      if (edited && onEditStaged !== null) onEditStaged(cx, cz);
      considerAround(cx, cz);
      return;
    }
    if (protoOnly) {
      // T(protoOnly) restored the proto of a Decorated or Published column: the Ds around it may run (spec §3.7).
      protoAlive[s] = 1;
    } else {
      stage[s] = h + 1;
      if (h === 0) {
        protoAlive[s] = 1;
        // The column's epoch is the one its T was issued under (SP4c spec §4.4); D and L leave it (D7: recorded as the
        // store stands, whatever generation they ran under).
        colEpoch[s] = busyEpoch[s]!;
      }
    }
    considerAround(cx, cz);
  }

  /**
   * A rejected job (spec §3.6, D12). Strict, or a dead lock owner: fatal. `JobCancelled` and `WorkerFailed` requeue
   * with no retry counted (a dead worker is not the job's fault). `StoreFullError` pauses new T jobs until the next
   * voxel unload (the job itself waits too), counts and emits `storeFull` once per pause. Anything else (INTERNAL) is
   * a failure: requeued once, then the column is marked failed. A T rejected otherwise than by `StoreFullError` first
   * frees the record it may have left claimed (`releaseFailedT`).
   */
  function rejected(h: number, s: number, cx: number, cz: number, protoOnly: boolean, e: unknown): void {
    if (strict || e instanceof StoreCorrupt || e instanceof StoreCorruptError) {
      fatal(`${STAGES[h]} at (${cx}, ${cz}) failed: ${errorText(e)}`, e);
      return;
    }
    if (h === 0 && !protoOnly && !(e instanceof StoreFullError)) releaseFailedT(s, cx, cz);
    if (e instanceof JobCancelled || e instanceof WorkerFailed) {
      requeue(s);
      return;
    }
    if (e instanceof StoreFullError) {
      storeFull++;
      if (tracks(s, cx, cz)) waitFull[s] = 1;
      if (!paused) {
        paused = true;
        onEvent({ kind: 'storeFull', lowerRd: lowerRd(rd) });
      }
      return;
    }
    failure(h, s, cx, cz, e);
  }

  /**
   * A T of (cx, cz) settled rejected (spec §3.6, D12; rulings R14): `fillColumnT` claims the record before it writes
   * and frees it only on a stop or a throw inside the worker, so a worker that died mid-T (`WorkerFailed`), a reply
   * failing its guard (BAD_MESSAGE) or a reply naming another job or column can leave the record claimed by
   * (cx, cz), uncommitted or at Proto. Unless the table holds (cx, cz) at stage ≥ 1 (no job reads it, so the free is
   * safe), a record that still names (cx, cz) is freed, so the T can be issued again: otherwise `nextJob` meets
   * `'self'` for ever, and once the slot follows another column every column of that torus slot collides for ever. The
   * slot may have moved on while the T ran (the jump case, as in `intake`). A worker that died inside the pool lock
   * is marked dead first (`fail` calls `onWorkerDead` before it rejects), so this free throws `StoreCorrupt` → fatal
   * (D6). Accepted residual risk: a browser's `terminate()` is asynchronous, so a dead worker's in-flight store write
   * could land after this free; its script is aborted at the next opportunity, and the page fails outright once the
   * last worker is gone.
   */
  function releaseFailedT(s: number, cx: number, cz: number): void {
    if (tracks(s, cx, cz) && stage[s] !== 0) return;
    if (store.holder(cx, cz) === 'self') store.freeColumn(cx, cz);
  }

  /**
   * A job of the slot's column failed (spec §3.6): requeued once; the second failure marks the column failed (skipped
   * by every stage until its voxels unload), the first such column emits `skipped`, and more than 32 in the session
   * emit `fatal`.
   */
  function failure(h: number, s: number, cx: number, cz: number, e: unknown): void {
    if (!tracks(s, cx, cz)) {
      requeue(s);
      return;
    }
    retries[s] = retries[s]! + 1;
    if (retries[s]! < 2) {
      requeue(s);
      return;
    }
    failed[s] = 1;
    failedTotal++;
    if (failedTotal > FAILED_FATAL) {
      fatal(`${failedTotal} columns failed (more than ${FAILED_FATAL}): the last, ${STAGES[h]} at (${cx}, ${cz}): ${errorText(e)}`, e);
      return;
    }
    if (!skippedSent) {
      skippedSent = true;
      onEvent({ kind: 'skipped', cx, cz });
    }
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
      colEpoch[s] = 0;
      meshed[s] = 0;
      protoAlive[s] = 0;
    }
  }

  /**
   * The done counts of the current sets (current columns only, SP4c spec §4.5: T, D and L at `colEpoch === wEpoch`,
   * MESH meshed with its target at `wEpoch`), the stale MESH-set columns (§4.4) and the failed columns, in one pass.
   */
  function countDone(out: CoordinatorCounts): void {
    let t = 0;
    let d = 0;
    let l = 0;
    let m = 0;
    let f = 0;
    let stale = 0;
    for (let s = 0; s < SLOTS; s++) {
      if (failed[s] !== 0) f++;
      const fl = flagsOf(s);
      if (fl === 0) continue;
      const st = stage[s]!;
      const current = colEpoch[s] === wEpoch;
      const target = targetOf(s);
      if (current) {
        if ((fl & M_T) !== 0 && st >= 1) t++;
        if ((fl & M_D) !== 0 && st >= 2) d++;
        if ((fl & M_L) !== 0 && st >= 3) l++;
      }
      if ((fl & M_MESH) === 0) continue;
      if (meshed[s] !== 0 && target === wEpoch) m++;
      if ((st >= 1 && !current) || (target !== 0 && target !== wEpoch)) stale++;
    }
    out.T.done = t;
    out.D.done = d;
    out.L.done = l;
    out.MESH.done = m;
    out.failed = f;
    out.stale = stale;
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
        collectUnloads();
        // Cancellation (D8): the queued pool jobs whose columns left their sets; running ones finish.
        if (total > 0) jobs.cancel(unwanted);
        rebuild();
      } else if (turned(cam.yawDeg, ryaw)) {
        setView(camCx, camCz, cam.yawDeg);
        rebuild();
      }
      try {
        if (unload()) rebuild();
      } catch (e) {
        fatal(`unload failed: ${errorText(e)}`, e);
        return;
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

    adopt(generation) {
      appliedGeneration = generation;
      // Requeue (SP4c spec §4.5): the jobs a held pump left in the heaps, and any a rejection requeued, keyed afresh.
      rebuild();
    },

    apply(a) {
      if (stopped) return;
      wEpoch = a.epoch;
      appliedGeneration = a.generation;
      // SP4c regenerates from T for any `from` (spec §4.1): every stale column is freed and claimed again by its T.
      for (let s = 0; s < SLOTS; s++) {
        // A pending payload of another epoch is resolved (§4.4): dropped (the shown one stays; with none shown the sink
        // holds nothing for the column any more), or found already shown. One staged at `wEpoch` (an undo back to the
        // epoch pending) stays.
        const pending = stagedEpoch[s]!;
        if (pending !== 0 && pending !== wEpoch) {
          if (sink.unstage(sinkCx[s]!, sinkCz[s]!)) {
            stagedEpoch[s] = 0;
            // The dropped payload may have carried an edit the shown one lacks: an edited column meshes again once
            // current (SP5a spec §2.6; a regenerated one reads its edits anyway, `follow`).
            stagedEditSeq[s] = 0;
            if (shownEpoch[s] === 0) {
              sinkCx[s] = NO_COLUMN;
              sinkCz[s] = NO_COLUMN;
            }
          } else {
            shownEpoch[s] = pending;
            stagedEpoch[s] = 0;
          }
        }
        if (isStale(s)) {
          // A MESH in flight is dropped at intake; the column is freed by the unloads (queued below) once unpinned.
          meshSeq[s] = meshSeq[s]! + 1;
          meshed[s] = 0;
        } else if (stage[s] === 0) {
          // A column skipped at T failed under another draft: it is retried under the applied one (a stale column's
          // marks go with its free, `follow`). `failedTotal` still counts the session's failures.
          failed[s] = 0;
          retries[s] = 0;
        } else if (stage[s] === 3) {
          // A current Published column: meshed when its mesh is (or is staged) at `wEpoch`, else it gets a MESH (§4.4).
          meshed[s] = targetOf(s) === wEpoch ? 1 : 0;
        }
      }
      // The unloads re-collected (the stale frees, the stale meshes outside the MESH set), then the stage heaps.
      collectUnloads();
      rebuild();
    },

    isSkipped(cx, cz) {
      const s = slotOf(cx, cz);
      return failed[s] !== 0 && tracks(s, cx, cz);
    },

    editState(cx, cz) {
      let stale = false;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = slotOf(cx + dx, cz + dz);
          if (!tracks(n, cx + dx, cz + dz) || failed[n] !== 0) return 1;
          if (isStale(n)) stale = true;
          else if (stage[n] !== 3) return 1;
        }
      }
      return stale ? 2 : 0;
    },

    simPin(cx, cz) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = slotOf(cx + dx, cz + dz);
          simPins[n] = simPins[n]! + 1;
        }
      }
    },

    simUnpin(cx, cz) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = slotOf(cx + dx, cz + dz);
          if (simPins[n] === 0) continue;
          simPins[n] = simPins[n]! - 1;
          if (simPins[n] === 0) simReleased(n);
        }
      }
    },

    simUnpinAll() {
      for (let s = 0; s < SLOTS; s++) {
        if (simPins[s] === 0) continue;
        simPins[s] = 0;
        simReleased(s);
      }
    },

    markEdited(keys) {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const cx = colKeyCx(k);
        const cz = colKeyCz(k);
        const s = slotOf(cx, cz);
        if (!tracks(s, cx, cz)) continue;
        editSeq[s] = editSeq[s]! + 1;
        meshSeq[s] = meshSeq[s]! + 1;
        ringPush(s);
      }
      pump();
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
      out.editDropped = editDropped;
      out.storeFull = storeFull;
      out.collisionWaits = collisionWaits;
      out.genCap = throttle.cap();
      out.rd = rd;
      out.cx = rcx;
      out.cz = rcz;
      out.yawDeg = ryaw;
      out.epoch = wEpoch;
      return out;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopped = true;
      for (let h = 0; h < HEAPS; h++) clearHeap(h);
      jobs.cancel(() => true);
      // After a fatal error the store may be the failure (a dead lock owner): nothing more is freed, and the page
      // discards the store. A store that fails while the page tears down is discarded with it too.
      if (fatalSent) return;
      try {
        sweep();
      } catch {
        fatalSent = true; // as in settle: no more frees on a failed store
      }
    },
  };
}

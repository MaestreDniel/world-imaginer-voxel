import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { STAGE_BONUS, streamScore } from '../../src/core/streamScore';
import {
  FAILED_FATAL, FREES_PER_FRAME, MESH_REMOVALS_PER_FRAME, PROTO_FREES_PER_FRAME, createCoordinator, createCoordinatorCounts, phaseName,
  progressFraction, worldJobsOf,
  type Coordinator, type CoordinatorCounts, type CoordinatorJobs, type JobOutcome, type StreamCamera, type StreamEvent,
  type StreamSink, type StreamStore,
} from '../../src/engine/coordinator';
import { KEEP_VOXELS_EXTRA, M_D, M_KEEP_MESH, M_L, M_MESH, M_T, membershipTable, stageOffsets, type Stage } from '../../src/engine/rings';
import { createThrottle, type Throttle } from '../../src/engine/throttle';
import { JobCancelled, StoreCorruptError, StoreFullError, WorkerFailed, type ColumnDone, type WorkerPool } from '../../src/engine/workerPool';
import type { ColumnMeshPayload } from '../../src/mesh/column';
import { StoreCorrupt } from '../../src/world/store/pool';

const RANK: Record<Stage, number> = { T: 1, D: 2, L: 3, MESH: 4 };
const FLAG: Record<Stage, number> = { T: M_T, D: M_D, L: M_L, MESH: M_MESH };

interface Issued { readonly stage: Stage; readonly cx: number; readonly cz: number }
interface Pending extends Issued {
  /** The versions the job read at its start (L and MESH), which a test may tamper with before it settles. */
  readonly versions: Int32Array;
  readonly resolve: () => void;
  readonly reject: (e: unknown) => void;
}

const slotOf = (cx: number, cz: number): number => (cx & 63) + 64 * (cz & 63);

interface FakeOptions {
  /** N, the live workers (mutable through `fake.live`). */
  readonly workers?: number;
  /** An error to reject the job with, or null (asked once per settle). */
  readonly failOf?: (j: Issued) => unknown;
  /** Called on the recorded versions just before the job resolves. */
  readonly tamper?: (j: Issued, v: Int32Array) => void;
  /** Jobs resolve inside `run` (as replies arriving at once). */
  readonly sync?: boolean;
  readonly throttle?: Throttle;
  /** Whether the pending job at index i is running (`cancel` rejects only the others); the first one by default. */
  readonly runningOf?: (j: Issued, i: number) => boolean;
  /**
   * A T claims its record when it is issued, as `fillColumnT` does (an uncommitted record, status 0, read as absent),
   * so a rejected T leaves its record claimed, as a T whose worker died does (rulings R14).
   */
  readonly claims?: boolean;
}

/**
 * The world as the coordinator sees it: a store model of records (one per torus slot: the column holding it and its
 * status, 1 Proto … 3 Published; block and light versions; the proto's alive bit), fake jobs that settle on a manual
 * tick and commit into the model when they resolve, and a sink. Every issue is checked against the prerequisites (D
 * also against live protos), the record's holder, the caps (with the throttle's cap at that moment) and the columns
 * already busy; every free against the pending jobs that read the column (the pins, SP4b spec §3.5); every stage
 * against the columns the sink holds at the coordinator's epoch (staged at most once per epoch, SP4c spec §4.4) and
 * against a pending payload not resolved since (no `unstage` or remove), and every remove against the unrevealed ones.
 * The pool's generation (`fake.generation`) is the test's to move; each job resolves with the generation it was issued
 * under (SP4c spec §4.6). A T's record carries the coordinator's epoch at its issue, and every D, L and MESH is checked
 * against the epochs of its 3 × 3 (all the applied one); a MESH is a violation only for a column the sink holds at the
 * applied epoch (one showing another epoch's mesh gets its MESH: the swap). The sink keeps each held column's shown and
 * pending epochs; `unstage` answers `fake.unstageReturns` (true: the pending payload is dropped; false: it is shown).
 */
function fakeWorld(fo: FakeOptions = {}) {
  const fake = {
    live: fo.workers ?? 4,
    /** `epoch`: the coordinator's epoch when the record's T was issued (SP4c spec §4.4); absent for a test's own records. */
    records: new Map<number, { cx: number; cz: number; status: number; block: number; light: number; alive?: boolean; epoch?: number }>(),
    pending: [] as Pending[],
    issued: [] as Issued[],
    violations: [] as string[],
    frees: [] as Array<readonly [number, number]>,
    protoFrees: [] as Array<readonly [number, number]>,
    /** The indices in `issued` of the T(protoOnly) jobs. */
    protoOnly: [] as number[],
    cancels: 0,
    stages: [] as Array<{ readonly cx: number; readonly cz: number; readonly seq: number }>,
    removes: [] as Array<readonly [number, number]>,
    /** The columns staged and not removed since (colKey). */
    revealed: new Set<number>(),
    /** The epoch each held column will show once its uploads finish, its target (colKey → epoch, SP4c spec §4.4). */
    revealedEpoch: new Map<number, number>(),
    /** The epoch of the payload the sink shows for each column and of one staged and not yet resolved (colKey → epoch). */
    shown: new Map<number, number>(),
    staged: new Map<number, number>(),
    /** The coordinator's epoch at each stage (same indices as `stages`). */
    stageEpochs: [] as number[],
    /** What `unstage` answers (true: the pending payload was dropped; false: it is already shown), moved by the test. */
    unstageReturns: (_cx: number, _cz: number): boolean => false,
    /** Reads the coordinator's epoch at a stage (`make` sets it once the coordinator exists). */
    epochNow: (): number => 1,
    /** The pool's generation (`jobs.generation()`), moved by the test (SP4c spec §4.2). */
    generation: 0,
    /** The generation each job of `issued` was issued under (same indices). */
    issuedGen: [] as number[],
    unstages: [] as Array<readonly [number, number]>,
    /** Every stage and remove in order, as `+colKey` and `-colKey`. */
    sinkOps: [] as number[],
    events: [] as StreamEvent[],
    /** `issued.length` when each event arrived. */
    eventIssued: [] as number[],
    /** Thrown by the next `freeColumn` (once). */
    freeThrows: null as unknown,
  };
  const throttle = fo.throttle ?? createThrottle({ max: Math.max(1, fake.live - 1) });
  const statusAt = (cx: number, cz: number): number => {
    const r = fake.records.get(slotOf(cx, cz));
    return r !== undefined && r.cx === cx && r.cz === cz ? r.status : 0;
  };
  const inFlight: Record<Stage, number> = { T: 0, D: 0, L: 0, MESH: 0 };
  let total = 0;

  const store: StreamStore = {
    versionsInto(cx, cz, out) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = 2 * (3 * (dz + 1) + (dx + 1));
          const r = fake.records.get(slotOf(cx + dx, cz + dz));
          const held = r !== undefined && r.cx === cx + dx && r.cz === cz + dz && r.status > 0;
          out[k] = held ? r.block : -1;
          out[k + 1] = held ? r.light : -1;
        }
      }
    },
    holder(cx, cz) {
      const r = fake.records.get(slotOf(cx, cz));
      return r === undefined ? 'free' : r.cx === cx && r.cz === cz ? 'self' : 'other';
    },
    freeColumn(cx, cz) {
      if (fake.freeThrows !== null) { const e = fake.freeThrows; fake.freeThrows = null; throw e; }
      const r = fake.records.get(slotOf(cx, cz));
      if (r === undefined || r.cx !== cx || r.cz !== cz) return;
      const reader = fake.pending.find((p) => (p.cx === cx && p.cz === cz) || (p.stage !== 'T' && Math.abs(p.cx - cx) <= 1 && Math.abs(p.cz - cz) <= 1));
      if (reader !== undefined) violations(`(${cx}, ${cz}) freed under ${reader.stage} at (${reader.cx}, ${reader.cz})`);
      fake.records.delete(slotOf(cx, cz));
      fake.frees.push([cx, cz]);
    },
    freeProto(cx, cz) {
      const r = fake.records.get(slotOf(cx, cz));
      if (r === undefined || r.cx !== cx || r.cz !== cz) { violations(`freeProto of the absent (${cx}, ${cz})`); return; }
      if (r.status < 2) violations(`freeProto of (${cx}, ${cz}) at status ${r.status}`);
      if (r.alive === false) violations(`freeProto of (${cx}, ${cz}) twice`);
      const reader = fake.pending.find((p) => (p.cx === cx && p.cz === cz) || (p.stage === 'D' && Math.abs(p.cx - cx) <= 1 && Math.abs(p.cz - cz) <= 1));
      if (reader !== undefined) violations(`proto of (${cx}, ${cz}) freed under ${reader.stage} at (${reader.cx}, ${reader.cz})`);
      r.alive = false;
      fake.protoFrees.push([cx, cz]);
    },
  };
  const aliveAt = (cx: number, cz: number): boolean => {
    const r = fake.records.get(slotOf(cx, cz));
    return r !== undefined && r.cx === cx && r.cz === cz && r.alive !== false;
  };

  const commit = (stage: Stage, cx: number, cz: number, protoOnly: boolean, epoch: number): void => {
    const s = slotOf(cx, cz);
    if (protoOnly) fake.records.get(s)!.alive = true;
    else if (stage === 'T') fake.records.set(s, { cx, cz, status: 1, block: 1, light: 0, alive: true, epoch });
    else if (stage === 'D') { const r = fake.records.get(s)!; r.status = 2; r.block++; }
    else if (stage === 'L') { const r = fake.records.get(s)!; r.status = 3; r.light++; }
  };

  const epochAt = (cx: number, cz: number): number | undefined => {
    const r = fake.records.get(slotOf(cx, cz));
    return r !== undefined && r.cx === cx && r.cz === cz ? r.epoch : undefined;
  };
  const check = (stage: Stage, cx: number, cz: number, protoOnly: boolean, epoch: number): void => {
    const what = `${stage} at (${cx}, ${cz})`;
    if (fake.pending.some((p) => p.cx === cx && p.cz === cz)) violations(`${what} issued for a busy column`);
    if (protoOnly) {
      if (stage !== 'T') violations(`${what} with protoOnly`);
      if (statusAt(cx, cz) < 2) violations(`T(protoOnly) at (${cx}, ${cz}) with its column at ${statusAt(cx, cz)}`);
      if (aliveAt(cx, cz)) violations(`T(protoOnly) at (${cx}, ${cz}) over a live proto`);
    } else if (stage === 'T') {
      if (store.holder(cx, cz) !== 'free') violations(`${what} issued with its record held (SlotBusy)`);
    } else {
      const need = RANK[stage] - 1;
      if (statusAt(cx, cz) !== need) violations(`${what} issued with its column at ${statusAt(cx, cz)}`);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (statusAt(cx + dx, cz + dz) < need) violations(`${what} before (${cx + dx}, ${cz + dz}) reached ${need}`);
          if (stage === 'D' && !aliveAt(cx + dx, cz + dz)) violations(`${what} with no live proto at (${cx + dx}, ${cz + dz})`);
          // Every column of the 3 × 3 generated under the applied epoch (SP4c spec §4.4).
          const e = epochAt(cx + dx, cz + dz);
          if (e !== undefined && e !== epoch) violations(`${what} at epoch ${epoch} with (${cx + dx}, ${cz + dz}) at epoch ${e}`);
        }
      }
      // A column the sink holds at the applied epoch needs no MESH; one showing another epoch's mesh gets one (the swap).
      if (stage === 'MESH' && fake.revealed.has(colKey(cx, cz)) && fake.revealedEpoch.get(colKey(cx, cz)) === epoch) violations(`${what} issued for a column held at epoch ${epoch}`);
    }
    // Each cap is checked when a job it bounds is issued (a cap that drops, as N does, binds the next such issue).
    const N = fake.live;
    if (stage !== 'MESH' && inFlight.T + inFlight.D + inFlight.L > throttle.cap()) violations(`${inFlight.T + inFlight.D + inFlight.L} T + D + L in flight above genCap ${throttle.cap()}`);
    if (stage === 'T' && inFlight.T > Math.max(1, N - 1)) violations(`${inFlight.T} T in flight`);
    if (stage === 'MESH' && inFlight.MESH > N) violations(`${inFlight.MESH} MESH in flight`);
    if (total > N) violations(`${total} jobs in flight`);
  };
  const violations = (v: string): void => { fake.violations.push(v); };

  const outcome = (stage: Stage, cx: number, cz: number, versions: Int32Array, generation: number): JobOutcome => {
    const v = stage === 'L' || stage === 'MESH' ? versions : null;
    const payload = stage === 'MESH' ? ({ cx, cz, versions: v } as unknown as ColumnMeshPayload) : null;
    return { versions: v, payload, generation };
  };

  const jobs: CoordinatorJobs = {
    run(stage, cx, cz, protoOnly) {
      if (protoOnly) fake.protoOnly.push(fake.issued.length);
      fake.issued.push({ stage, cx, cz });
      const generation = fake.generation;
      fake.issuedGen.push(generation);
      inFlight[stage]++;
      total++;
      const epoch = fake.epochNow();
      check(stage, cx, cz, protoOnly, epoch);
      if (fo.claims === true && stage === 'T' && !protoOnly) fake.records.set(slotOf(cx, cz), { cx, cz, status: 0, block: 1, light: 0 });
      const versions = new Int32Array(18);
      store.versionsInto(cx, cz, versions);
      return new Promise<JobOutcome>((resolve, reject) => {
        const done = () => { inFlight[stage]--; total--; };
        const p: Pending = {
          stage, cx, cz, versions,
          resolve: () => {
            done();
            fo.tamper?.({ stage, cx, cz }, versions);
            commit(stage, cx, cz, protoOnly, epoch);
            resolve(outcome(stage, cx, cz, versions, generation));
          },
          reject: (e) => { done(); reject(e); },
        };
        if (fo.sync === true) p.resolve();
        else fake.pending.push(p);
      });
    },
    cancel(pred) {
      fake.cancels++;
      // The running jobs (the first pending one by default) finish; the others are queued and leave with JobCancelled.
      const running = fo.runningOf ?? ((_: Issued, i: number) => i === 0);
      const keep: Pending[] = [];
      fake.pending.forEach((p, i) => {
        if (!running(p, i) && pred(p.stage, p.cx, p.cz)) p.reject(new JobCancelled());
        else keep.push(p);
      });
      fake.pending.splice(0, fake.pending.length, ...keep);
    },
    liveWorkers: () => fake.live,
    generation: () => fake.generation,
  };
  const sink: StreamSink = {
    stage(p, seq) {
      // Staged at most once per epoch (SP4c spec §4.4): a stage over a column held at the same epoch, with no remove
      // since, is a violation; over a column held at another epoch it is the swap.
      const k = colKey(p.cx, p.cz);
      const epoch = fake.epochNow();
      if (fake.revealed.has(k) && fake.revealedEpoch.get(k) === epoch) violations(`(${p.cx}, ${p.cz}) staged again at epoch ${epoch} while held (D16)`);
      // A payload staged and not resolved since (no unstage, no remove) is still pending: staging over it would leave
      // the column with two pending seqs (SP4c spec §4.4: `stage` only with `stagedEpoch` 0).
      if (fake.staged.has(k)) violations(`(${p.cx}, ${p.cz}) staged at epoch ${epoch} over a pending payload of epoch ${fake.staged.get(k)}`);
      fake.revealed.add(k);
      fake.revealedEpoch.set(k, epoch);
      fake.staged.set(k, epoch);
      fake.stages.push({ cx: p.cx, cz: p.cz, seq });
      fake.stageEpochs.push(epoch);
      fake.sinkOps.push(k + 1);
    },
    unstage(cx, cz) {
      fake.unstages.push([cx, cz]);
      const k = colKey(cx, cz);
      const pending = fake.staged.get(k);
      if (!fake.revealed.has(k) || pending === undefined) {
        violations(`unstage of (${cx}, ${cz}) with no pending payload`);
        return false;
      }
      fake.staged.delete(k);
      const dropped = fake.unstageReturns(cx, cz);
      if (!dropped) {
        // Already shown: the target stays.
        fake.shown.set(k, pending);
        return false;
      }
      const shown = fake.shown.get(k);
      if (shown === undefined) {
        // A first reveal dropped: the sink holds nothing for the column any more.
        fake.revealed.delete(k);
        fake.revealedEpoch.delete(k);
      } else {
        fake.revealedEpoch.set(k, shown);
      }
      return true;
    },
    remove(cx, cz) {
      if (!fake.revealed.delete(colKey(cx, cz))) violations(`remove of the unstaged (${cx}, ${cz})`);
      fake.revealedEpoch.delete(colKey(cx, cz));
      fake.shown.delete(colKey(cx, cz));
      fake.staged.delete(colKey(cx, cz));
      fake.removes.push([cx, cz]);
      fake.sinkOps.push(-(colKey(cx, cz) + 1));
    },
  };
  /** Settles the pending job at index i (FIFO by default). */
  const settle = (i = 0): void => {
    const p = fake.pending.splice(i, 1)[0]!;
    const fail = fo.failOf?.(p) ?? null;
    if (fail !== null) p.reject(fail);
    else p.resolve();
  };
  return { fake, store, jobs, sink, throttle, settle };
}

type World = ReturnType<typeof fakeWorld>;

interface MakeOptions extends FakeOptions {
  readonly rd?: number;
  readonly rdMax?: number;
  readonly strict?: boolean;
  readonly retainAllProtos?: boolean;
  /** The first configure's epoch (SP4c spec §4.10; the page's is 1). */
  readonly epoch?: number;
}

function make(mo: MakeOptions = {}): { w: World; c: Coordinator } {
  const w = fakeWorld(mo);
  const inner = createCoordinator({
    jobs: w.jobs, store: w.store, sink: w.sink, throttle: w.throttle, rd: mo.rd ?? 4, rdMax: mo.rdMax ?? 16,
    retainAllProtos: mo.retainAllProtos ?? true, strict: mo.strict ?? false,
    generation: w.fake.generation, epoch: mo.epoch ?? 1,
    onEvent: (e) => { w.fake.events.push(e); w.fake.eventIssued.push(w.fake.issued.length); },
  });
  // The fake reads the coordinator's epoch (`counts().epoch`) at every issue and stage; only `apply` moves it, so it is
  // read once after each `apply` rather than counted over the 4,096 slots per job.
  const counts = createCoordinatorCounts();
  let epoch = inner.counts(counts).epoch;
  w.fake.epochNow = () => epoch;
  const c: Coordinator = {
    ...inner,
    apply(a) {
      inner.apply(a);
      epoch = inner.counts(counts).epoch;
    },
  };
  return { w, c };
}

/** The camera at the centre of column (cx, cz). */
const cam = (cx: number, cz: number, yawDeg = 0): StreamCamera => ({ x: cx * 16 + 8, z: cz * 16 + 8, yawDeg });

const flush = () => new Promise<void>((r) => setImmediate(r));

/** A small LCG for a reproducible settle order. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

/** Settles every pending job (and the ones they lead to) in FIFO or LCG order. */
async function settleAll(w: World, order: 'fifo' | number = 'fifo'): Promise<void> {
  const pick = order === 'fifo' ? () => 0 : lcg(order);
  await flush();
  while (w.fake.pending.length > 0) {
    w.settle(pick(w.fake.pending.length));
    await flush();
  }
}

/** One update at `at`, then every job settled. */
async function fill(w: World, c: Coordinator, at: StreamCamera, order: 'fifo' | number = 'fifo'): Promise<void> {
  c.update(at);
  await settleAll(w, order);
}

const perStage = (log: readonly Issued[]): Record<Stage, number> => {
  const n: Record<Stage, number> = { T: 0, D: 0, L: 0, MESH: 0 };
  for (const j of log) n[j.stage]++;
  return n;
};

const read = (c: Coordinator): CoordinatorCounts => c.counts(createCoordinatorCounts());

/** Whether (cx, cz) lies in `stage`'s set around (ccx, ccz) at rd. */
function inSet(stage: Stage, cx: number, cz: number, ccx: number, ccz: number, rd: number): boolean {
  const R = rd + KEEP_VOXELS_EXTRA;
  const dx = cx - ccx;
  const dz = cz - ccz;
  if (Math.abs(dx) > R || Math.abs(dz) > R) return false;
  return (membershipTable(rd)[(dz + R) * (2 * R + 1) + dx + R]! & FLAG[stage]) !== 0;
}

describe('createCoordinator: validation (SP4b spec §3.13, §7.6)', () => {
  test('rd is validated before anything else: rd 3, 17 with rdMax 16, 4.5 and rdMax 27 throw RangeError', () => {
    const touched: string[] = [];
    const jobs: CoordinatorJobs = {
      run: () => { touched.push('run'); return Promise.reject(new Error('run')); },
      cancel: () => { touched.push('cancel'); },
      liveWorkers: () => { touched.push('liveWorkers'); return 4; },
      generation: () => { touched.push('generation'); return 0; },
    };
    const store: StreamStore = {
      versionsInto: () => { touched.push('versionsInto'); },
      holder: () => { touched.push('holder'); return 'free'; },
      freeColumn: () => { touched.push('freeColumn'); },
      freeProto: () => { touched.push('freeProto'); },
    };
    const sink: StreamSink = {
      stage: () => { touched.push('stage'); }, unstage: () => { touched.push('unstage'); return false; }, remove: () => { touched.push('remove'); },
    };
    const throttle = createThrottle({ max: 3 });
    const at = (rd: number, rdMax: number) => () => createCoordinator({
      jobs, store, sink, throttle, rd, rdMax, retainAllProtos: true, strict: true, generation: 0, epoch: 1, onEvent: () => { touched.push('onEvent'); },
    });
    for (const [rd, rdMax] of [[3, 16], [17, 16], [4.5, 16], [12, 27], [Number.NaN, 16], [4, 3.5]] as const) expect(at(rd, rdMax), `rd ${rd}, rdMax ${rdMax}`).toThrow(RangeError);
    expect(touched).toEqual([]);
    expect(at(16, 16)).not.toThrow();
    expect(at(4, 26)).not.toThrow();
    expect(touched).toEqual([]);
  });
});

describe('createCoordinator: the fill (SP4b spec §3.1-§3.3, §3.6, §3.11)', () => {
  test('a fill at RD 4 around (0, 0) issues exactly 213 T, 157 D, 109 L and 69 MESH and stages 69 payloads; at RD 12, 825 / 705 / 593 / 489', async () => {
    for (const [rd, want, order] of [[4, { T: 213, D: 157, L: 109, MESH: 69 }, 'fifo'], [12, { T: 825, D: 705, L: 593, MESH: 489 }, 2026]] as const) {
      const { w, c } = make({ rd });
      expect(c.firstFill()).toBe(false);
      await fill(w, c, cam(0, 0), order);
      expect(w.fake.violations).toEqual([]);
      expect(perStage(w.fake.issued)).toEqual(want);
      expect(w.fake.stages.length).toBe(want.MESH);
      expect(new Set(w.fake.stages.map((s) => colKey(s.cx, s.cz))).size).toBe(want.MESH);
      expect(w.fake.stages.every((s) => s.seq === 0)).toBe(true);
      const n = read(c);
      for (const st of ['T', 'D', 'L', 'MESH'] as const) expect(n[st]).toEqual({ needed: want[st], done: want[st], inFlight: 0, queued: 0 });
      expect([n.dropped, n.failed, n.rd, n.genCap]).toEqual([0, 0, rd, 3]);
      expect(c.firstFill()).toBe(true);
      expect(w.fake.events).toEqual([]);
    }
  });

  test('the first job is the T of the lowest score (the view term ahead of the centre); MESH at the centre is issued before any T at distance 13', async () => {
    // Spec §3.3's score puts the columns just ahead below the centre's 0 (at yaw 0: (±1, −2) score √5 − 6/√5 ≈ −0.447),
    // so SP4a's "first job is T at the centre" no longer holds; every T is issued in (score, colKey) order.
    const { w, c } = make({ rd: 12 });
    await fill(w, c, cam(3, -2), 5);
    expect(w.fake.violations).toEqual([]);
    const log = w.fake.issued;
    const keyOf = (j: Issued) => streamScore(j.cx - 3, j.cz + 2, 0, -1, STAGE_BONUS.T);
    const ts = log.filter((j) => j.stage === 'T');
    expect(ts[0]).toEqual({ stage: 'T', cx: 2, cz: -4 });
    for (let i = 1; i < ts.length; i++) {
      const [a, b] = [ts[i - 1]!, ts[i]!];
      expect(keyOf(b) > keyOf(a) || (keyOf(b) === keyOf(a) && colKey(b.cx, b.cz) > colKey(a.cx, a.cz)), `T ${i}`).toBe(true);
    }
    // Among the four columns at distance 3 on the axes, the one straight ahead (−z at yaw 0) comes first.
    const at3 = [[3, -5], [6, -2], [3, 1], [0, -2]].map(([x, z]) => ts.findIndex((j) => j.cx === x && j.cz === z));
    expect(Math.min(...at3)).toBe(at3[0]);
    const meshCentre = log.findIndex((j) => j.stage === 'MESH' && j.cx === 3 && j.cz === -2);
    const farT = log.findIndex((j) => j.stage === 'T' && Math.hypot(j.cx - 3, j.cz + 2) >= 13);
    expect(meshCentre).toBeGreaterThanOrEqual(0);
    expect(farT).toBeGreaterThan(meshCentre);
  });

  test('the view term: at yaw 90 with columns (4, 0) and (−4, 0) both T-eligible, (4, 0) is issued first; (−3, 0) after (4, 0)', async () => {
    const { w, c } = make({ rd: 8 });
    await fill(w, c, cam(0, 0, 90));
    const t = (x: number) => w.fake.issued.findIndex((j) => j.stage === 'T' && j.cx === x && j.cz === 0);
    expect(t(4)).toBeGreaterThanOrEqual(0);
    expect(t(4)).toBeLessThan(t(-3));
    expect(t(-3)).toBeLessThan(t(-4));
    expect(read(c).yawDeg).toBe(90);
  });

  test('the cross-stage tie-break: an L at d 2 (score 1.0) and a T at d 1 (score 1.0) tie, broken by colKey (§7.6 hand-over)', async () => {
    // Only the 5 × 5 that L at (lx, 0) needs is free to claim; every other record of the T set, the d-1 column (tx, 0)
    // included, is held by a far column. The cap is held at 0 when the last D settles, so the L waits in its heap;
    // then (tx, 0) is freed, a turn rebuilds the heaps, and the cap opens: the next job is the smaller colKey's.
    for (const [lx, tx, first] of [[2, -1, 'T'], [-2, 1, 'L']] as const) {
      let cap = 3;
      const stub: Throttle = { push() {}, cap: () => cap, setMax() {}, max: 3 };
      const { w, c } = make({ rd: 4, throttle: stub });
      const x0 = lx > 0 ? 0 : -4;
      for (const [dx, dz] of stageOffsets(4).T) {
        if (dx >= x0 && dx <= x0 + 4 && dz >= -2 && dz <= 2) continue;
        w.fake.records.set(slotOf(dx, dz), { cx: dx + 64, cz: dz, status: 1, block: 1, light: 0 });
      }
      c.update(cam(0, 0, 180));
      let dSettled = 0;
      await flush();
      while (w.fake.pending.length > 0) {
        if (w.fake.pending[0]!.stage === 'D' && dSettled++ === 8) cap = 0;
        w.settle();
        await flush();
      }
      expect(perStage(w.fake.issued)).toEqual({ T: 25, D: 9, L: 0, MESH: 0 });
      expect(read(c).L.queued).toBe(1);
      w.fake.records.delete(slotOf(tx, 0));
      c.update(cam(0, 0, 225));
      expect(read(c).T.queued).toBe(1);
      expect(w.fake.issued.length).toBe(34);
      cap = 1;
      c.update(cam(0, 0, 225));
      expect(streamScore(lx, 0, 0, 1, STAGE_BONUS.L)).toBe(streamScore(tx, 0, 0, 1, STAGE_BONUS.T));
      expect(w.fake.issued[34]).toEqual(first === 'T' ? { stage: 'T', cx: tx, cz: 0 } : { stage: 'L', cx: lx, cz: 0 });
    }
  });

  test('D is never issued before its 3 × 3 are at Proto, L before Decorated, MESH before Published (an invariant at every issue)', async () => {
    for (const [workers, order] of [[2, 'fifo'], [4, 7], [6, 12345]] as const) {
      const { w, c } = make({ rd: 8, workers });
      await fill(w, c, cam(-20, 9, 135), order);
      expect(w.fake.violations).toEqual([]);
      expect(c.firstFill()).toBe(true);
    }
  });

  test('caps: never more than genCap T + D + L, max(1, N − 1) T, N MESH, N in total', async () => {
    for (const [workers, order] of [[1, 'fifo'], [2, 3], [3, 'fifo'], [5, 99], [6, 'fifo']] as const) {
      const { w, c } = make({ rd: 6, workers });
      await fill(w, c, cam(0, 0), order);
      expect(w.fake.violations, `N ${workers}`).toEqual([]);
      expect(c.firstFill()).toBe(true);
    }
    // A throttle dropped to 2 under N = 6 holds T + D + L at 2 while MESH may take the rest.
    const throttle = createThrottle({ max: 5 });
    for (let i = 0; i < 60 * 3; i++) throttle.push(30, true, 4.167);
    expect(throttle.cap()).toBe(2);
    const { w, c } = make({ rd: 6, workers: 6, throttle });
    let maxGen = 0;
    c.update(cam(0, 0));
    await flush();
    const pick = lcg(11);
    while (w.fake.pending.length > 0) {
      maxGen = Math.max(maxGen, w.fake.pending.filter((p) => p.stage !== 'MESH').length);
      w.settle(pick(w.fake.pending.length));
      await flush();
    }
    expect(w.fake.violations).toEqual([]);
    expect(maxGen).toBe(2);
    expect(read(c).genCap).toBe(2);
  });

  test('re-centring on a crossing: after moving one column east the sets follow and no job outside its set is issued', async () => {
    const { w, c } = make({ rd: 4 });
    await fill(w, c, cam(0, 0));
    const before = w.fake.issued.length;
    await fill(w, c, cam(1, 0));
    expect(w.fake.violations).toEqual([]);
    const after = w.fake.issued.slice(before);
    for (const j of after) expect(inSet(j.stage, j.cx, j.cz, 1, 0, 4), `${j.stage} at (${j.cx}, ${j.cz})`).toBe(true);
    const offs = stageOffsets(4);
    const fresh = (st: Stage) => offs[st].filter(([dx, dz]) => !inSet(st, dx + 1, dz, 0, 0, 4)).length;
    expect(perStage(after)).toEqual({ T: fresh('T'), D: fresh('D'), L: fresh('L'), MESH: fresh('MESH') });
    expect(fresh('MESH')).toBe(9);
    const n = read(c);
    expect([n.T.done, n.D.done, n.L.done, n.MESH.done]).toEqual([213, 157, 109, 69]);
    expect([n.cx, n.cz]).toEqual([1, 0]);
    expect(w.fake.stages.length).toBe(69 + 9);
    expect(c.firstFill()).toBe(true);
  });

  test('a turn below 30° rebuilds nothing; above 30° the forward columns come first', async () => {
    const run = async (turnTo: number) => {
      const { w, c } = make({ rd: 8, workers: 2 });
      c.update(cam(0, 0, 0));
      await flush();
      for (let i = 0; i < 30; i++) { w.settle(); await flush(); }
      const mark = w.fake.issued.length;
      c.update(cam(0, 0, turnTo));
      const yaw = read(c).yawDeg;
      await settleAll(w);
      return { log: w.fake.issued, mark, yaw };
    };
    const still = await run(0);
    const small = await run(20);
    expect(small.yaw).toBe(0);
    expect(small.log).toEqual(still.log);
    const big = await run(200);
    expect(big.yaw).toBe(200);
    // After the rebuild every T follows the new view's (score, colKey) order; before it, the old one's.
    const ordered = (log: readonly Issued[], yaw: number) => {
      const [fx, fz] = [Math.sin((yaw * Math.PI) / 180), -Math.cos((yaw * Math.PI) / 180)];
      const ts = log.filter((j) => j.stage === 'T');
      const key = (j: Issued) => streamScore(j.cx, j.cz, fx, fz, STAGE_BONUS.T);
      return ts.every((b, i) => i === 0 || key(b) > key(ts[i - 1]!) || (key(b) === key(ts[i - 1]!) && colKey(b.cx, b.cz) > colKey(ts[i - 1]!.cx, ts[i - 1]!.cz)));
    };
    expect(ordered(still.log.slice(still.mark), 0)).toBe(true);
    expect(ordered(big.log.slice(big.mark), 200)).toBe(true);
    expect(ordered(big.log.slice(big.mark), 0)).toBe(false);
    // The first T after the turn lies ahead: forward at yaw 200 is (sin 200°, −cos 200°) ≈ (−0.34, 0.94).
    const nextT = big.log.slice(big.mark).find((j) => j.stage === 'T')!;
    expect(nextT.cx * Math.sin((200 * Math.PI) / 180) - nextT.cz * Math.cos((200 * Math.PI) / 180)).toBeGreaterThan(0);
  });
});

describe('createCoordinator: intake (SP4b spec §3.6, D16)', () => {
  test('a MESH whose versions moved is dropped and requeued (dropped 1)', async () => {
    let once = true;
    const { w, c } = make({
      rd: 5,
      tamper: (j, v) => { if (j.stage === 'MESH' && j.cx === 1 && j.cz === 0 && once) { once = false; v[9] = v[9]! + 1; } },
    });
    await fill(w, c, cam(0, 0));
    expect(w.fake.violations).toEqual([]);
    expect(read(c).dropped).toBe(1);
    expect(w.fake.issued.filter((j) => j.stage === 'MESH' && j.cx === 1 && j.cz === 0).length).toBe(2);
    expect(w.fake.stages.filter((s) => s.cx === 1 && s.cz === 0).length).toBe(1);
    expect(c.firstFill()).toBe(true);
  });

  test('an L whose lightVersions moved but blockVersions did not is accepted; one whose blockVersions moved is dropped', async () => {
    const light = make({ rd: 5, tamper: (j, v) => { if (j.stage === 'L') for (let k = 1; k < 18; k += 2) v[k] = v[k]! + 7; } });
    await fill(light.w, light.c, cam(0, 0));
    expect(read(light.c).dropped).toBe(0);
    expect(light.c.firstFill()).toBe(true);
    let once = true;
    const block = make({ rd: 5, tamper: (j, v) => { if (j.stage === 'L' && j.cx === -1 && j.cz === 2 && once) { once = false; v[8] = 3; } } });
    await fill(block.w, block.c, cam(0, 0));
    expect(read(block.c).dropped).toBe(1);
    expect(block.w.fake.issued.filter((j) => j.stage === 'L' && j.cx === -1 && j.cz === 2).length).toBe(2);
    expect(block.c.firstFill()).toBe(true);
  });

  test('a MESH of an old meshSeq is dropped: its column left keepMesh and came back while it ran', async () => {
    const isK = (p: Issued) => p.stage === 'MESH' && p.cx === 4 && p.cz === 0;
    // K's MESH is running, so the crossing's cancellation leaves it to finish.
    const { w, c } = make({ rd: 4, runningOf: (j, i) => isK(j) || i === 0 });
    c.update(cam(0, 0));
    await flush();
    // Settle until K's MESH runs alone among MESH jobs (another MESH in flight could be superseded by the trip too).
    for (;;) {
      const other = w.fake.pending.findIndex((p) => p.stage === 'MESH' && !isK(p));
      if (other < 0 && w.fake.pending.some(isK)) break;
      w.settle(other >= 0 ? other : w.fake.pending.findIndex((p) => !isK(p)));
      await flush();
    }
    // (4, 0) is 6 columns from (10, 0): beyond keepMesh (RD + 1), still inside the window, so the slot keeps it.
    c.update(cam(10, 0));
    c.update(cam(0, 0));
    w.settle(w.fake.pending.findIndex(isK));
    await flush();
    expect(read(c).dropped).toBe(1);
    expect(w.fake.stages.some((s) => s.cx === 4 && s.cz === 0)).toBe(false);
    await settleAll(w);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.stages.filter((s) => s.cx === 4 && s.cz === 0)).toEqual([{ cx: 4, cz: 0, seq: 1 }]);
    expect(read(c).dropped).toBe(1);
  });

  test('a result for a column the slot no longer tracks is dropped (a T whose slot moved on: its record is freed)', async () => {
    const { w, c } = make({ rd: 4 });
    c.update(cam(0, 0));
    await flush();
    const k = w.fake.pending[0]!;
    expect(k.stage).toBe('T');
    // 64 columns east every slot's window column is 64 columns east of its old one; K is still Absent, so its slot follows.
    c.update(cam(64, 0));
    w.settle(0);
    await flush();
    expect(read(c).dropped).toBe(1);
    expect(w.fake.frees).toEqual([[k.cx, k.cz]]);
    expect(w.fake.issued.some((j) => j.stage === 'T' && j.cx === k.cx + 64 && j.cz === k.cz)).toBe(true);
    expect(w.fake.issued.some((j) => j.stage === 'D')).toBe(false);
    expect(w.fake.violations).toEqual([]);
  });

  test('a column is staged at most once per epoch: over a fill, a crossing back and forth and an LCG settle order, sink.stage is called at most once per (column, meshSeq)', async () => {
    const { w, c } = make({ rd: 6, workers: 5 });
    const pick = lcg(4242);
    await fill(w, c, cam(0, 0), 4242);
    const path = [cam(1, 0), cam(2, 1), cam(1, 0), cam(0, 0), cam(-1, 0), cam(0, 0)];
    for (const at of path) {
      c.update(at);
      await flush();
      for (let i = 0; i < 40 && w.fake.pending.length > 0; i++) { w.settle(pick(w.fake.pending.length)); await flush(); }
    }
    await settleAll(w, 77);
    // The fake's sink flags a stage of a column held at the same epoch and not removed since (D16, SP4c §4.4); (2, 1) takes (−6, 0) beyond keepMesh,
    // so a column is staged again only after its mesh unload, under the next meshSeq.
    expect(w.fake.violations).toEqual([]);
    const seen = new Set(w.fake.stages.map((s) => `${s.cx},${s.cz},${s.seq}`));
    expect(seen.size).toBe(w.fake.stages.length);
    expect(w.fake.removes.length).toBeGreaterThan(0);
    // What is revealed at the end: the MESH set around (0, 0), and nothing beyond keepMesh (RD + 1).
    for (const [dx, dz] of stageOffsets(6).MESH) expect(w.fake.revealed.has(colKey(dx, dz)), `(${dx}, ${dz})`).toBe(true);
    const keep = new Set(w.fake.stages.filter((m) => m.cx * m.cx + m.cz * m.cz <= 7.5 * 7.5).map((m) => colKey(m.cx, m.cz)));
    for (const k of w.fake.revealed) expect(keep.has(k)).toBe(true);
    expect(c.firstFill()).toBe(true);
  });

  test('firstFill is false until the last MESH column of the set is staged', async () => {
    const { w, c } = make({ rd: 4 });
    c.update(cam(5, 5));
    await flush();
    const pick = lcg(9);
    while (w.fake.pending.length > 0) {
      expect(c.firstFill()).toBe(w.fake.stages.length === 69);
      w.settle(pick(w.fake.pending.length));
      await flush();
    }
    expect(w.fake.stages.length).toBe(69);
    expect(c.firstFill()).toBe(true);
  });

  test('every settle issues the next job: with fakes that settle synchronously, a fill at RD 4 completes within one update', async () => {
    const { w, c } = make({ rd: 4, sync: true });
    c.update(cam(0, 0));
    await flush();
    expect(perStage(w.fake.issued)).toEqual({ T: 213, D: 157, L: 109, MESH: 69 });
    expect(c.firstFill()).toBe(true);
    expect(w.fake.violations).toEqual([]);
  });
});

describe('createCoordinator: dispose and strict mode (SP4b spec §3.6, D12)', () => {
  test('update after dispose is a no-op; dispose cancels queued jobs', async () => {
    const { w, c } = make({ rd: 4 });
    c.update(cam(0, 0));
    await flush();
    for (let i = 0; i < 120; i++) { w.settle(); await flush(); }
    expect(w.fake.pending.length).toBeGreaterThan(1);
    expect(w.fake.records.size).toBeGreaterThan(0);
    c.dispose();
    expect(w.fake.cancels).toBe(1);
    // The fake's first pending job is running; every other one was queued and is cancelled.
    expect(w.fake.pending.length).toBe(1);
    await flush();
    const issued = w.fake.issued.length;
    c.update(cam(0, 0));
    c.update(cam(3, 3, 90));
    expect(w.fake.issued.length).toBe(issued);
    w.settle();
    await flush();
    expect(w.fake.issued.length).toBe(issued);
    // Every column is freed once nothing reads it: the store holds no record.
    expect([...w.fake.records.values()]).toEqual([]);
    expect(w.fake.events).toEqual([]);
    c.dispose();
    expect(w.fake.cancels).toBe(1);
  });

  test('strict: one INTERNAL, one JobCancelled, one dropped MESH and liveWorkers 2 → 1 each emit fatal (stage and column in the message, the rejection as cause) with no retry and no further issue', async () => {
    const boom = new Error('INTERNAL: boom');
    const cancelled = new JobCancelled();
    const cases: Array<{ readonly name: string; readonly o: MakeOptions; readonly at?: number; readonly message: RegExp; readonly cause: unknown; readonly job?: Issued }> = [
      { name: 'INTERNAL', o: { failOf: (j) => (j.stage === 'D' && j.cx === 1 && j.cz === -1 ? boom : null) }, message: /^D at \(1, -1\) failed: INTERNAL: boom$/, cause: boom, job: { stage: 'D', cx: 1, cz: -1 } },
      { name: 'JobCancelled', o: { failOf: (j) => (j.stage === 'MESH' && j.cx === 0 && j.cz === 0 ? cancelled : null) }, message: /^MESH at \(0, 0\) failed: job cancelled$/, cause: cancelled, job: { stage: 'MESH', cx: 0, cz: 0 } },
      { name: 'dropped', o: { tamper: (j, v) => { if (j.stage === 'MESH' && j.cx === 1 && j.cz === 0) v[9] = v[9]! + 1; } }, message: /^dropped result: MESH at \(1, 0\): recorded versions/, cause: null, job: { stage: 'MESH', cx: 1, cz: 0 } },
      { name: 'liveWorkers', o: { workers: 2 }, at: 40, message: /^a worker failed: 1 of 2 workers live$/, cause: null },
    ];
    for (const k of cases) {
      const { w, c } = make({ rd: 4, strict: true, ...k.o });
      c.update(cam(0, 0));
      await flush();
      let settled = 0;
      while (w.fake.events.length === 0 && w.fake.pending.length > 0) {
        if (k.at !== undefined && settled === k.at) w.fake.live = 1;
        w.settle();
        settled++;
        await flush();
      }
      expect(w.fake.events, k.name).toEqual([{ kind: 'fatal', message: expect.stringMatching(k.message), cause: k.cause }]);
      const issued = w.fake.issued.length;
      await settleAll(w);
      c.update(cam(0, 0));
      await flush();
      expect(w.fake.issued.length, k.name).toBe(issued);
      expect(w.fake.events.length).toBe(1);
      if (k.job !== undefined) {
        const j = k.job;
        expect(w.fake.issued.filter((i) => i.stage === j.stage && i.cx === j.cx && i.cz === j.cz).length, k.name).toBe(1);
      }
      expect(c.firstFill()).toBe(false);
    }
  });

  test('not strict: a JobCancelled requeues; setStrict(true) makes the next rejection fatal', async () => {
    let n = 0;
    const { w, c } = make({ rd: 4, failOf: (j) => (j.stage === 'L' && j.cx === 0 && j.cz === 0 && n++ < 2 ? new JobCancelled() : null) });
    await fill(w, c, cam(0, 0));
    expect(w.fake.events).toEqual([]);
    expect(w.fake.issued.filter((j) => j.stage === 'L' && j.cx === 0 && j.cz === 0).length).toBe(3);
    expect(c.firstFill()).toBe(true);
    const boom = new Error('boom');
    const s = make({ rd: 4, failOf: (j) => (j.stage === 'T' && j.cx === 1 && j.cz === 1 ? boom : null) });
    s.c.setStrict(true);
    await fill(s.w, s.c, cam(0, 0));
    expect(s.w.fake.events).toEqual([{ kind: 'fatal', message: 'T at (1, 1) failed: boom', cause: boom }]);
  });
});

describe('createCoordinator: Review Focus 2-4 (SP4b plan)', () => {
  test('Review Focus 2: a turn from 355° to 5° counts 10° (no rebuild); 350° → 25° counts 35° (a rebuild); 10° → 340° counts 30° (no rebuild)', () => {
    for (const [from, to, rebuilt] of [[355, 5, false], [350, 25, true], [10, 340, false], [5, 355, false], [25, 350, true], [340, 10, false], [0, 31, true], [0, 329, true]] as const) {
      const { c } = make({ rd: 4 });
      c.update(cam(0, 0, from));
      expect(read(c).yawDeg).toBe(from);
      c.update(cam(0, 0, to));
      expect(read(c).yawDeg, `${from} → ${to}`).toBe(rebuilt ? to : from);
    }
  });

  test('Review Focus 3: a fill around column (−31,249, −31,249) at RD 4 issues 213 / 157 / 109 / 69 jobs, and a crossing one column west there classifies every slot as the same crossing around (0, 0)', async () => {
    const run = async (cx: number, cz: number) => {
      const { w, c } = make({ rd: 4 });
      await fill(w, c, cam(cx, cz, 30));
      const filled = perStage(w.fake.issued);
      await fill(w, c, cam(cx - 1, cz, 30));
      expect(w.fake.violations).toEqual([]);
      const n = read(c);
      return {
        filled,
        // The whole log relative to the first centre, and the counts relative to the last.
        log: w.fake.issued.map((j) => [j.stage, j.cx - cx, j.cz - cz]),
        stages: w.fake.stages.map((s) => [s.cx - cx, s.cz - cz, s.seq]),
        counts: { ...n, cx: n.cx - cx, cz: n.cz - cz },
      };
    };
    const far = await run(-31249, -31249);
    const zero = await run(0, 0);
    expect(far.filled).toEqual({ T: 213, D: 157, L: 109, MESH: 69 });
    expect(far.counts.cx).toBe(-1);
    expect(far).toEqual(zero);
  });

  test('Review Focus 4: rotating the yaw by 45° every frame for 200 frames while jobs settle in LCG order never issues a job for a busy column nor the same (stage, column) twice before it settles; the fill completes', async () => {
    const { w, c } = make({ rd: 6, workers: 4 });
    const pick = lcg(31337);
    let yaw = 0;
    let frames = 0;
    while (frames < 200 || !c.firstFill()) {
      c.update(cam(0, 0, yaw));
      yaw = (yaw + 45) % 360;
      for (let i = pick(4); i > 0 && w.fake.pending.length > 0; i--) w.settle(pick(w.fake.pending.length));
      await flush();
      frames++;
      expect(frames).toBeLessThan(5000);
    }
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.stages.length).toBe(stageOffsets(6).MESH.length);
    expect(perStage(w.fake.issued)).toEqual({ T: stageOffsets(6).T.length, D: stageOffsets(6).D.length, L: stageOffsets(6).L.length, MESH: stageOffsets(6).MESH.length });
  });
});

/** Counts the removes, frees and proto frees since the previous call. */
function deltas(w: World) {
  let r = w.fake.removes.length;
  let f = w.fake.frees.length;
  let p = w.fake.protoFrees.length;
  return () => {
    const out = { removes: w.fake.removes.length - r, frees: w.fake.frees.length - f, protoFrees: w.fake.protoFrees.length - p };
    r = w.fake.removes.length;
    f = w.fake.frees.length;
    p = w.fake.protoFrees.length;
    return out;
  };
}

const has = (list: ReadonlyArray<readonly [number, number]>, cx: number, cz: number): boolean => list.some(([x, z]) => x === cx && z === cz);
const issuedOf = (w: World, stage: Stage, cx: number, cz: number): number => w.fake.issued.filter((j) => j.stage === stage && j.cx === cx && j.cz === cz).length;

describe('createCoordinator: pins, unloads and collisions (SP4b spec §3.5, D3)', () => {
  test('the per-frame bounds: 64 mesh removals, 16 column frees, 16 proto frees, 32 failed columns', () => {
    expect([MESH_REMOVALS_PER_FRAME, FREES_PER_FRAME, PROTO_FREES_PER_FRAME, FAILED_FATAL]).toEqual([64, 16, 16, 32]);
  });

  test('hysteresis at RD 4 after a fill: one column east and back removes no mesh and frees nothing; two columns east removes 9 meshes and frees 8 columns in that update', async () => {
    const { w, c } = make({ rd: 4 });
    await fill(w, c, cam(0, 0));
    await fill(w, c, cam(1, 0));
    await fill(w, c, cam(0, 0));
    c.update(cam(0, 0));
    expect(w.fake.removes).toEqual([]);
    expect(w.fake.frees).toEqual([]);
    c.update(cam(2, 0));
    expect(w.fake.removes.length).toBe(9);
    expect(w.fake.frees.length).toBe(8);
    for (const [x, z] of w.fake.removes) expect((x - 2) ** 2 + z * z, `remove (${x}, ${z})`).toBeGreaterThan(5.5 * 5.5);
    for (const [x, z] of w.fake.frees) expect((x - 2) ** 2 + z * z, `free (${x}, ${z})`).toBeGreaterThan(9.5 * 9.5);
    await settleAll(w);
    c.update(cam(2, 0));
    expect([w.fake.removes.length, w.fake.frees.length]).toEqual([9, 8]);
    expect(w.fake.violations).toEqual([]);
    expect(c.firstFill()).toBe(true);
  });

  test('pins block frees: a column outside keepVoxels with an L of its neighbour in flight is freed only in the update after that L settles', async () => {
    const isJ = (j: Issued) => j.stage === 'L' && j.cx === -5 && j.cz === 0;
    const { w, c } = make({ rd: 4, runningOf: (j, i) => isJ(j) || i === 0 });
    c.update(cam(0, 0));
    await flush();
    // Every job but L at J = (−5, 0) settles; that L stays in flight, pinning its 3 × 3.
    for (;;) {
      const i = w.fake.pending.findIndex((p) => !isJ(p));
      if (i < 0) break;
      w.settle(i);
      await flush();
    }
    expect(w.fake.pending.map((p) => [p.stage, p.cx, p.cz])).toEqual([['L', -5, 0]]);
    // From (4, 0), K = (−6, 0) lies 10 columns away, beyond keepVoxels (RD + 5); J itself is 9 away and stays.
    const pinned = [[-6, -1], [-6, 0], [-6, 1]] as const;
    for (let i = 0; i < 3; i++) {
      c.update(cam(4, 0));
      await flush();
      while (w.fake.pending.some((p) => !isJ(p))) { w.settle(w.fake.pending.findIndex((p) => !isJ(p))); await flush(); }
    }
    expect(w.fake.frees.length).toBeGreaterThan(0);
    for (const [x, z] of pinned) expect(has(w.fake.frees, x, z), `(${x}, ${z}) freed under the L`).toBe(false);
    w.settle(w.fake.pending.findIndex(isJ));
    await flush();
    for (const [x, z] of pinned) expect(has(w.fake.frees, x, z)).toBe(false);
    c.update(cam(4, 0));
    for (const [x, z] of pinned) expect(has(w.fake.frees, x, z), `(${x}, ${z}) freed after the L`).toBe(true);
    expect(has(w.fake.frees, -5, 0)).toBe(false);
    expect(w.fake.violations).toEqual([]);
  });

  test('a record collision waits for the far column\'s free: after a fill at RD 4 around (0, 0) and a jump to (64, 0), every new T collides, collisionWaits > 0, the frees take 14 updates (13 × 16 + 5) and the meshes 2 (64 + 5), the first T issued after the jump is the lowest-score one with (64, 0) among the first four, and the T jobs issued after the jump come in nondecreasing score order', async () => {
    const { w, c } = make({ rd: 4 });
    await fill(w, c, cam(0, 0));
    expect(read(c).collisionWaits).toBe(0);
    const mark = w.fake.issued.length;
    const d = deltas(w);
    const frees: number[] = [];
    const removes: number[] = [];
    for (let i = 0; i < 16; i++) {
      c.update(cam(64, 0));
      const n = d();
      frees.push(n.frees);
      removes.push(n.removes);
      await settleAll(w);
    }
    expect(frees).toEqual([...Array<number>(13).fill(16), 5, 0, 0]);
    expect(removes).toEqual([64, 5, ...Array<number>(14).fill(0)]);
    // Every T of the new set waited on a record its old column held (the same torus slots, 64 columns west).
    expect(read(c).collisionWaits).toBe(213);
    const ts = w.fake.issued.slice(mark).filter((j) => j.stage === 'T');
    expect(ts.length).toBe(213);
    const key = (j: Issued) => streamScore(j.cx - 64, j.cz, 0, -1, STAGE_BONUS.T);
    const lowest = [...ts].sort((a, b) => key(a) - key(b) || colKey(a.cx, a.cz) - colKey(b.cx, b.cz))[0]!;
    expect(ts[0]).toEqual(lowest);
    expect(ts.slice(0, 4).some((j) => j.cx === 64 && j.cz === 0)).toBe(true);
    for (let i = 1; i < ts.length; i++) expect(key(ts[i]!), `T ${i}`).toBeGreaterThanOrEqual(key(ts[i - 1]!));
    expect(w.fake.violations).toEqual([]);
    expect(c.firstFill()).toBe(true);
    expect(read(c).dropped).toBe(0);
  });

  test('cancel on leaving range: queued T jobs of columns that left the T set are cancelled through jobs.cancel; an in-flight one settles and is judged at intake (a T of a column outside keepVoxels is freed by the unload rule)', async () => {
    const { w, c } = make({ rd: 4 });
    c.update(cam(0, 0));
    await flush();
    const first = w.fake.pending.map((p) => [p.stage, p.cx, p.cz] as const);
    expect(first.length).toBe(3);
    expect(first.every(([st]) => st === 'T')).toBe(true);
    const [running, ...queued] = first;
    // (12, 0): the three columns near (0, 0) leave the T set and keepVoxels; the slots keep them (inside the window).
    c.update(cam(12, 0));
    expect(w.fake.cancels).toBe(1);
    await flush();
    expect(w.fake.pending.map((p) => [p.stage, p.cx, p.cz])[0]).toEqual(running);
    for (const [, x, z] of queued) expect(w.fake.pending.some((p) => p.cx === x && p.cz === z)).toBe(false);
    w.settle(0);
    await flush();
    expect(has(w.fake.frees, running![1], running![2])).toBe(false);
    c.update(cam(12, 0));
    expect(has(w.fake.frees, running![1], running![2])).toBe(true);
    await settleAll(w);
    for (const [, x, z] of first) expect(issuedOf(w, 'T', x, z), `T at (${x}, ${z})`).toBe(1);
    expect(w.fake.events).toEqual([]);
    expect(read(c).dropped).toBe(0);
    expect(w.fake.violations).toEqual([]);
    expect(c.firstFill()).toBe(true);
  });

  test('setRenderDistance(12) then setRenderDistance(10) before the next update: counts show MESH needed 349 (Review Focus 5)', async () => {
    const { w, c } = make({ rd: 8 });
    await fill(w, c, cam(0, 0));
    const mark = w.fake.issued.length;
    c.setRenderDistance(12);
    c.setRenderDistance(10);
    expect(read(c).MESH.needed).toBe(349);
    expect(read(c).rd).toBe(10);
    await fill(w, c, cam(0, 0));
    expect(read(c).MESH).toEqual({ needed: 349, done: 349, inFlight: 0, queued: 0 });
    const after = w.fake.issued.slice(mark);
    for (const j of after) expect(inSet(j.stage, j.cx, j.cz, 0, 0, 10), `${j.stage} at (${j.cx}, ${j.cz})`).toBe(true);
    expect(perStage(after).MESH).toBe(349 - stageOffsets(8).MESH.length);
    expect(c.firstFill()).toBe(true);
    expect(w.fake.violations).toEqual([]);
  });

  test('setRenderDistance after a full RD 12 fill: to 8 removes 196 meshes over 4 updates (64, 64, 64, 4) and frees 248 columns over 16 updates (15 × 16 + 8); back to 12 needs 489 MESH again; 3 and 17 throw', async () => {
    const { w, c } = make({ rd: 12 });
    await fill(w, c, cam(0, 0));
    expect(() => c.setRenderDistance(3)).toThrow(RangeError);
    expect(() => c.setRenderDistance(17)).toThrow(RangeError);
    expect(() => c.setRenderDistance(8.5)).toThrow(RangeError);
    expect(read(c).rd).toBe(12);
    c.setRenderDistance(8);
    const d = deltas(w);
    const frees: number[] = [];
    const removes: number[] = [];
    for (let i = 0; i < 18; i++) {
      c.update(cam(0, 0));
      const n = d();
      frees.push(n.frees);
      removes.push(n.removes);
      await settleAll(w);
    }
    expect(removes).toEqual([64, 64, 64, 4, ...Array<number>(14).fill(0)]);
    expect(frees).toEqual([...Array<number>(15).fill(16), 8, 0, 0]);
    for (const [x, z] of w.fake.frees) expect(x * x + z * z).toBeGreaterThan(13.5 * 13.5);
    expect(w.fake.issued.length).toBe(825 + 705 + 593 + 489);
    expect(read(c).MESH).toEqual({ needed: stageOffsets(8).MESH.length, done: stageOffsets(8).MESH.length, inFlight: 0, queued: 0 });
    const mark = w.fake.issued.length;
    c.setRenderDistance(12);
    expect(read(c).MESH.needed).toBe(489);
    await fill(w, c, cam(0, 0));
    expect(read(c).MESH).toEqual({ needed: 489, done: 489, inFlight: 0, queued: 0 });
    expect(perStage(w.fake.issued.slice(mark)).MESH).toBe(196);
    expect(perStage(w.fake.issued.slice(mark)).T).toBe(248);
    expect(c.firstFill()).toBe(true);
    expect(w.fake.violations).toEqual([]);
  });
});

describe('createCoordinator: errors after the reveal (SP4b spec §3.6, D12)', () => {
  test('strict first, then D12: a strict coordinator emits fatal on one INTERNAL with no retry; after setStrict(false) one INTERNAL requeues', async () => {
    const boom = new Error('INTERNAL: boom');
    let n = 0;
    const failOf = (j: Issued) => (j.stage === 'D' && j.cx === 0 && j.cz === 0 && n++ === 0 ? boom : null);
    const strict = make({ rd: 4, strict: true, failOf });
    await fill(strict.w, strict.c, cam(0, 0));
    expect(strict.w.fake.events).toEqual([{ kind: 'fatal', message: 'D at (0, 0) failed: INTERNAL: boom', cause: boom }]);
    expect(issuedOf(strict.w, 'D', 0, 0)).toBe(1);
    n = 0;
    const loose = make({ rd: 4, strict: true, failOf });
    loose.c.setStrict(false);
    await fill(loose.w, loose.c, cam(0, 0));
    expect(loose.w.fake.events).toEqual([]);
    expect(issuedOf(loose.w, 'D', 0, 0)).toBe(2);
    expect(read(loose.c).failed).toBe(0);
    expect(loose.c.firstFill()).toBe(true);
  });

  test('retries and the skipped column: one INTERNAL requeues, a second marks it failed and emits one skipped event; its neighbours\' dependent jobs wait; 33 failed columns emit fatal', async () => {
    const boom = new Error('INTERNAL: boom');
    const { w, c } = make({ rd: 4, failOf: (j) => (j.stage === 'D' && j.cx === 1 && j.cz === 1 ? boom : null) });
    await fill(w, c, cam(0, 0));
    expect(issuedOf(w, 'D', 1, 1)).toBe(2);
    expect(w.fake.events).toEqual([{ kind: 'skipped', cx: 1, cz: 1 }]);
    expect(read(c).failed).toBe(1);
    // No L whose 3 × 3 holds (1, 1), no MESH whose 3 × 3 holds one of those: 109 − 9 L and 69 − 25 MESH.
    expect(w.fake.issued.some((j) => j.stage === 'L' && Math.abs(j.cx - 1) <= 1 && Math.abs(j.cz - 1) <= 1)).toBe(false);
    expect(perStage(w.fake.issued)).toEqual({ T: 213, D: 157 + 1, L: 100, MESH: 44 });
    expect(c.firstFill()).toBe(false);
    c.update(cam(0, 0));
    await settleAll(w);
    expect(issuedOf(w, 'D', 1, 1)).toBe(2);
    expect(w.fake.violations).toEqual([]);
    // 33 columns whose T always fails: the first emits skipped, the 33rd fatal; 32 are not fatal.
    for (const k of [32, 33]) {
      const bad = new Set(stageOffsets(4).T.slice(0, k).map(([x, z]) => colKey(x, z)));
      const many = make({ rd: 4, failOf: (j) => (j.stage === 'T' && bad.has(colKey(j.cx, j.cz)) ? boom : null) });
      await fill(many.w, many.c, cam(0, 0));
      const kinds = many.w.fake.events.map((e) => e.kind);
      expect(kinds, `${k} failed`).toEqual(k > FAILED_FATAL ? ['skipped', 'fatal'] : ['skipped']);
      if (k > FAILED_FATAL) expect(many.w.fake.events[1]).toEqual({ kind: 'fatal', message: expect.stringMatching(/^33 columns failed/), cause: boom });
      else expect(read(many.c).failed).toBe(32);
    }
  });

  test('isSkipped names the column its slot tracks while marked failed: true for (1, 1), false for its neighbours and for (65, 1) on the same slot, false again once its voxels unload (final review UI-4)', async () => {
    const { w, c } = make({ rd: 4, failOf: (j) => (j.stage === 'D' && j.cx === 1 && j.cz === 1 ? new Error('INTERNAL: boom') : null) });
    expect(c.isSkipped(1, 1)).toBe(false);
    await fill(w, c, cam(0, 0));
    expect(read(c).failed).toBe(1);
    expect(c.isSkipped(1, 1)).toBe(true);
    expect([c.isSkipped(0, 0), c.isSkipped(1, 0), c.isSkipped(2, 2), c.isSkipped(65, 1), c.isSkipped(1, -63)]).toEqual([false, false, false, false, false]);
    for (let i = 0; i < 20 && !has(w.fake.frees, 1, 1); i++) await fill(w, c, cam(20, 0));
    expect(has(w.fake.frees, 1, 1)).toBe(true);
    expect(c.isSkipped(1, 1)).toBe(false);
  });

  test('a failed column flown beyond keepVoxels and back is regenerated from scratch', async () => {
    let failing = true;
    const { w, c } = make({ rd: 4, failOf: (j) => (failing && j.stage === 'D' && j.cx === 1 && j.cz === 1 ? new Error('INTERNAL: boom') : null) });
    await fill(w, c, cam(0, 0));
    expect(read(c).failed).toBe(1);
    // (20, 0): (1, 1) lies 19 columns away, beyond keepVoxels (RD + 5) and inside the window, so its slot keeps it.
    for (let i = 0; i < 20 && !has(w.fake.frees, 1, 1); i++) await fill(w, c, cam(20, 0));
    expect(has(w.fake.frees, 1, 1)).toBe(true);
    expect(read(c).failed).toBe(0);
    failing = false;
    for (let i = 0; i < 20 && (i === 0 || !c.firstFill()); i++) await fill(w, c, cam(0, 0));
    expect(read(c).cx).toBe(0);
    expect(c.firstFill()).toBe(true);
    expect(issuedOf(w, 'T', 1, 1)).toBe(2);
    expect(issuedOf(w, 'D', 1, 1)).toBe(3);
    expect(w.fake.events).toEqual([{ kind: 'skipped', cx: 1, cz: 1 }]);
    expect(read(c).failed).toBe(0);
    expect(w.fake.violations).toEqual([]);
  });

  test('StoreFull pauses T, counts 1, emits storeFull with lowerRd 10 at RD 12 and leaves the RD unchanged; the next voxel unload resumes T', async () => {
    // X is the T issued last at yaw 0 (the largest score), so the far west columns are generated when it meets StoreFull.
    const tKey = ([x, z]: readonly [number, number]) => streamScore(x, z, 0, -1, STAGE_BONUS.T);
    const [xx, xz] = [...stageOffsets(12).T].sort((a, b) => tKey(b) - tKey(a) || colKey(b[0], b[1]) - colKey(a[0], a[1]))[0]!;
    let once = true;
    const { w, c } = make({ rd: 12, failOf: (j) => (once && j.stage === 'T' && j.cx === xx && j.cz === xz ? (once = false, new StoreFullError('STORE_FULL: blocks full')) : null) });
    await fill(w, c, cam(0, 0));
    expect(w.fake.events).toEqual([{ kind: 'storeFull', lowerRd: 10 }]);
    const n = read(c);
    expect([n.storeFull, n.rd]).toEqual([1, 12]);
    // T jobs already in flight finish; none is issued after the StoreFull reply.
    expect(w.fake.issued.slice(w.fake.eventIssued[0]).some((j) => j.stage === 'T')).toBe(false);
    const tBefore = perStage(w.fake.issued).T;
    expect(read(c).T.done).toBe(824);
    for (let i = 0; i < 3; i++) await fill(w, c, cam(0, 0));
    expect(perStage(w.fake.issued).T).toBe(tBefore);
    expect(issuedOf(w, 'T', xx, xz)).toBe(1);
    expect(w.fake.frees).toEqual([]);
    // Three columns east the far west columns leave keepVoxels: the first free resumes T.
    c.update(cam(3, 0));
    expect(w.fake.frees.length).toBeGreaterThan(0);
    await settleAll(w);
    expect(perStage(w.fake.issued).T).toBeGreaterThan(tBefore);
    expect(issuedOf(w, 'T', xx, xz)).toBe(2);
    for (let i = 0; i < 20 && !c.firstFill(); i++) await fill(w, c, cam(3, 0));
    expect(c.firstFill()).toBe(true);
    expect(w.fake.events.length).toBe(1);
    expect(read(c).storeFull).toBe(1);
    expect(read(c).rd).toBe(12);
    expect(w.fake.violations).toEqual([]);
  });

  test('caps follow liveWorkers: 4 → 3 sets genCap\'s max to 2; 2 → 1 keeps generating with genCap 1 and at most one job in flight; 0 emits fatal; the job rejected with WorkerFailed is requeued with no retry counted', async () => {
    const a = make({ rd: 4, workers: 4 });
    a.c.update(cam(0, 0));
    await flush();
    expect([a.w.throttle.max, read(a.c).genCap]).toEqual([3, 3]);
    a.w.fake.live = 3;
    a.w.settle();
    await flush();
    expect([a.w.throttle.max, read(a.c).genCap]).toEqual([2, 2]);
    await settleAll(a.w);
    expect(a.w.fake.violations).toEqual([]);
    expect(a.c.firstFill()).toBe(true);

    const b = make({ rd: 4, workers: 2 });
    b.c.update(cam(0, 0));
    await flush();
    for (let i = 0; i < 20; i++) { b.w.settle(); await flush(); }
    b.w.fake.live = 1;
    b.w.settle();
    await flush();
    expect(read(b.c).genCap).toBe(1);
    let most = 0;
    while (b.w.fake.pending.length > 0) {
      b.w.settle();
      await flush();
      most = Math.max(most, b.w.fake.pending.length);
    }
    expect(most).toBe(1);
    expect(b.c.firstFill()).toBe(true);
    expect(b.w.fake.violations).toEqual([]);
    expect(b.w.fake.events).toEqual([]);

    const z = make({ rd: 4, workers: 2 });
    z.c.update(cam(0, 0));
    await flush();
    z.w.fake.live = 0;
    z.w.settle();
    await flush();
    expect(z.w.fake.events).toEqual([{ kind: 'fatal', message: 'no live worker is left', cause: null }]);

    // WorkerFailed, then INTERNAL, then success: the WorkerFailed counted no retry, so the INTERNAL still requeues.
    let k = 0;
    const errs = [new WorkerFailed('worker 2 failed'), new Error('INTERNAL: boom')];
    const r = make({ rd: 4, failOf: (j) => (j.stage === 'D' && j.cx === 0 && j.cz === 0 && k < 2 ? errs[k++]! : null) });
    await fill(r.w, r.c, cam(0, 0));
    expect(issuedOf(r.w, 'D', 0, 0)).toBe(3);
    expect(r.w.fake.events).toEqual([]);
    expect(read(r.c).failed).toBe(0);
    expect(r.c.firstFill()).toBe(true);
  });

  test('StoreCorruptError emits fatal (and StoreCorrupt from a free)', async () => {
    const corrupt = new StoreCorruptError('STORE_CORRUPT: the lock owner failed');
    const { w, c } = make({ rd: 4, failOf: (j) => (j.stage === 'L' && j.cx === 0 && j.cz === 0 ? corrupt : null) });
    await fill(w, c, cam(0, 0));
    expect(w.fake.events).toEqual([{ kind: 'fatal', message: 'L at (0, 0) failed: STORE_CORRUPT: the lock owner failed', cause: corrupt }]);
    expect(issuedOf(w, 'L', 0, 0)).toBe(1);
    const dead = new StoreCorrupt('the pool lock is held by thread 2, which failed');
    const f = make({ rd: 4 });
    await fill(f.w, f.c, cam(0, 0));
    f.w.fake.freeThrows = dead;
    f.c.update(cam(30, 0));
    expect(f.w.fake.events).toEqual([{ kind: 'fatal', message: expect.stringMatching(/^unload failed: /), cause: dead }]);
  });

  test('a T rejected with WorkerFailed that leaves its record claimed frees it before the requeue: the T is issued again and the fill completes (rulings R14)', async () => {
    let once = true;
    const { w, c } = make({ rd: 4, claims: true, failOf: (j) => (once && j.stage === 'T' && j.cx === 0 && j.cz === 0 ? (once = false, new WorkerFailed('worker 2 of 4 failed: error event')) : null) });
    await fill(w, c, cam(0, 0));
    expect(once).toBe(false);
    expect(has(w.fake.frees, 0, 0)).toBe(true);
    expect(issuedOf(w, 'T', 0, 0)).toBe(2);
    expect(perStage(w.fake.issued)).toEqual({ T: 214, D: 157, L: 109, MESH: 69 });
    expect(c.firstFill()).toBe(true);
    expect(w.fake.events).toEqual([]);
    const n = read(c);
    expect([n.failed, n.dropped, n.collisionWaits]).toEqual([0, 0, 0]);
    expect(w.fake.violations).toEqual([]);
  });

  test('a T rejected with BAD_MESSAGE (an INTERNAL failure) that leaves its record claimed frees it: the retry is issued and the fill completes (rulings R14)', async () => {
    let once = true;
    const { w, c } = make({ rd: 4, claims: true, failOf: (j) => (once && j.stage === 'T' && j.cx === 1 && j.cz === -1 ? (once = false, new Error('BAD_MESSAGE: versions is not null or an ArrayBuffer of 72 bytes')) : null) });
    await fill(w, c, cam(0, 0));
    expect(once).toBe(false);
    expect(has(w.fake.frees, 1, -1)).toBe(true);
    expect(issuedOf(w, 'T', 1, -1)).toBe(2);
    expect(c.firstFill()).toBe(true);
    expect(w.fake.events).toEqual([]);
    expect([read(c).failed, read(c).collisionWaits]).toEqual([0, 0]);
    expect(w.fake.violations).toEqual([]);
  });

  test('a T rejected with WorkerFailed after its slot moved on to a window column frees its record: the new column\'s T claims the torus record and the fill around the new centre completes (rulings R14)', async () => {
    const isT00 = (j: Issued) => j.stage === 'T' && j.cx === 0 && j.cz === 0;
    let failNow = false;
    const { w, c } = make({ rd: 4, claims: true, runningOf: (j, i) => isT00(j) || i === 0, failOf: (j) => (failNow && isT00(j) ? new WorkerFailed('worker 1 of 4 failed: error event') : null) });
    c.update(cam(0, 0));
    await flush();
    // Every job but T(0, 0) settles; T(0, 0) stays in flight with its record claimed.
    for (;;) {
      const i = w.fake.pending.findIndex((p) => !isT00(p));
      if (i < 0) break;
      w.settle(i);
      await flush();
    }
    expect(w.fake.pending.map((p) => [p.stage, p.cx, p.cz])).toEqual([['T', 0, 0]]);
    expect(w.store.holder(0, 0)).toBe('self');
    // The jump: slot 0 now tracks (64, 0), whose record (0, 0) still claims; then the T's worker dies.
    c.update(cam(64, 0));
    await flush();
    failNow = true;
    w.settle(w.fake.pending.findIndex(isT00));
    await flush();
    expect(has(w.fake.frees, 0, 0)).toBe(true);
    for (let i = 0; i < 20 && !c.firstFill(); i++) await fill(w, c, cam(64, 0));
    expect(issuedOf(w, 'T', 0, 0)).toBe(1);
    expect(issuedOf(w, 'T', 64, 0)).toBe(1);
    expect(read(c).MESH).toEqual({ needed: 69, done: 69, inFlight: 0, queued: 0 });
    expect(c.firstFill()).toBe(true);
    expect(w.fake.events).toEqual([]);
    expect(w.fake.violations).toEqual([]);
  });

  test('a StoreCorrupt from a failed T\'s free (its dead worker held the pool lock) emits fatal (rulings R14)', async () => {
    const dead = new StoreCorrupt('the pool lock is held by thread 2, which failed');
    let once = true;
    const r = make({
      rd: 4, claims: true,
      failOf: (j) => {
        if (!once || j.stage !== 'T' || j.cx !== 0 || j.cz !== 0) return null;
        once = false;
        r.w.fake.freeThrows = dead;
        return new WorkerFailed('worker 2 of 4 failed: error event');
      },
    });
    await fill(r.w, r.c, cam(0, 0));
    expect(r.w.fake.events).toEqual([{ kind: 'fatal', message: expect.stringMatching(/^T at \(0, 0\): intake failed: /), cause: dead }]);
    expect(issuedOf(r.w, 'T', 0, 0)).toBe(1);
  });
});

describe('createCoordinator: proto retention (SP4b spec §3.7, D11)', () => {
  test('proto retention on: a Decorated column outside the proto ring with no D needing it has its proto freed; a D that needs it issues T(protoOnly) first; a status-1 column outside the ring keeps its proto and is decorated when it re-enters the D set', async () => {
    const { w, c } = make({ rd: 6, retainAllProtos: false });
    const d = deltas(w);
    let most = 0;
    const settle = async (at: StreamCamera, n: number) => {
      for (let i = 0; i < n; i++) {
        c.update(at);
        most = Math.max(most, d().protoFrees);
        await settleAll(w);
      }
    };
    await settle(cam(0, 0), 30);
    expect(c.firstFill()).toBe(true);
    // After the fill, the L set's protos go (outside the ring, every D-set neighbour decorated); the ring keeps the rest.
    const L6 = new Set(stageOffsets(6).L.map(([x, z]) => colKey(x, z)));
    expect(new Set(w.fake.protoFrees.map(([x, z]) => colKey(x, z)))).toEqual(L6);
    expect(w.fake.protoFrees.length).toBe(L6.size);
    expect(most).toBe(PROTO_FREES_PER_FRAME);
    // RD 4: (8, 0) is Decorated, outside RD 4's ring (the T set minus the L set) with no D-set neighbour: freed.
    // (9, 0) is at Proto (status 1): it keeps its proto though outside the ring.
    c.setRenderDistance(4);
    await settle(cam(0, 0), 30);
    expect(has(w.fake.protoFrees, 8, 0)).toBe(true);
    expect(has(w.fake.protoFrees, 9, 0)).toBe(false);
    expect(w.fake.records.get(slotOf(9, 0))).toMatchObject({ cx: 9, cz: 0, status: 1, alive: true });
    // RD 7: (9, 0) enters the D set; its 3 × 3 holds (8, −1), (8, 0), (8, 1) Decorated without a proto.
    const mark = w.fake.issued.length;
    c.setRenderDistance(7);
    await settle(cam(0, 0), 30);
    expect(c.firstFill()).toBe(true);
    const at = (st: Stage, x: number, z: number) => w.fake.issued.findIndex((j, i) => i >= mark && j.stage === st && j.cx === x && j.cz === z);
    const dAt = at('D', 9, 0);
    expect(dAt).toBeGreaterThan(0);
    for (const z of [-1, 0, 1]) {
      const t = at('T', 8, z);
      expect(t, `T(protoOnly) at (8, ${z})`).toBeGreaterThan(0);
      expect(w.fake.protoOnly).toContain(t);
      expect(t).toBeLessThan(dAt);
    }
    expect(w.fake.protoOnly.length).toBeGreaterThan(0);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([]);
  });

  test('retainAllProtos frees no proto and runs no T(protoOnly)', async () => {
    const { w, c } = make({ rd: 6 });
    await fill(w, c, cam(0, 0));
    c.setRenderDistance(4);
    for (let i = 0; i < 20; i++) await fill(w, c, cam(0, 0));
    c.setRenderDistance(7);
    for (let i = 0; i < 20; i++) await fill(w, c, cam(0, 0));
    expect(c.firstFill()).toBe(true);
    expect(w.fake.protoFrees).toEqual([]);
    expect(w.fake.protoOnly).toEqual([]);
    expect(w.fake.violations).toEqual([]);
  });
});

/** Whether (cx, cz) carries membership flag `flag` around (ccx, ccz) at rd. */
function hasFlag(flag: number, cx: number, cz: number, ccx: number, ccz: number, rd: number): boolean {
  const R = rd + KEEP_VOXELS_EXTRA;
  const dx = cx - ccx;
  const dz = cz - ccz;
  if (Math.abs(dx) > R || Math.abs(dz) > R) return false;
  return (membershipTable(rd)[(dz + R) * (2 * R + 1) + dx + R]! & flag) !== 0;
}

/**
 * SP4b's done counts for the fake's model (SP4b spec §7.3): the columns of each stage's set around (ccx, ccz) whose
 * record (held by that column) reached the stage after it (T ≥ Proto, D ≥ Decorated, L Published), MESH those the sink
 * holds.
 */
function sp4bDone(w: World, ccx: number, ccz: number, rd: number): Record<Stage, number> {
  const R = rd + KEEP_VOXELS_EXTRA;
  const n: Record<Stage, number> = { T: 0, D: 0, L: 0, MESH: 0 };
  for (let cz = ccz - R; cz <= ccz + R; cz++) {
    for (let cx = ccx - R; cx <= ccx + R; cx++) {
      const r = w.fake.records.get(slotOf(cx, cz));
      const status = r !== undefined && r.cx === cx && r.cz === cz ? r.status : 0;
      if (inSet('T', cx, cz, ccx, ccz, rd) && status >= 1) n.T++;
      if (inSet('D', cx, cz, ccx, ccz, rd) && status >= 2) n.D++;
      if (inSet('L', cx, cz, ccx, ccz, rd) && status >= 3) n.L++;
      if (inSet('MESH', cx, cz, ccx, ccz, rd) && w.fake.revealed.has(colKey(cx, cz))) n.MESH++;
    }
  }
  return n;
}

const doneOf = (k: CoordinatorCounts): Record<Stage, number> => ({ T: k.T.done, D: k.D.done, L: k.L.done, MESH: k.MESH.done });

describe('createCoordinator: the generation gate, the per-column epoch and the sink\'s column (SP4c spec §4.2, §4.4-§4.6)', () => {
  test('the gate: with the fake pool\'s generation moved to g + 1 and not adopted, 50 updates issue no world job (the heaps kept); adopt(g + 1) resumes issuing, and frees, stages and unstages nothing', async () => {
    const { w, c } = make({ rd: 4 });
    c.update(cam(0, 0));
    await flush();
    for (let i = 0; i < 40; i++) { w.settle(); await flush(); }
    // The map configures a draft: the pool's generation moves; the jobs already issued finish (their settles pump).
    w.fake.generation = 1;
    await settleAll(w);
    const n = w.fake.issued.length;
    const held = read(c);
    const queued = (k: CoordinatorCounts): number => k.T.queued + k.D.queued + k.L.queued + k.MESH.queued;
    expect(queued(held)).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) {
      c.update(cam(0, 0));
      await flush();
    }
    expect(w.fake.issued.length).toBe(n);
    expect(queued(read(c))).toBe(queued(held));
    const side = (): number[] => [w.fake.frees.length, w.fake.stages.length, w.fake.unstages.length, w.fake.removes.length];
    const before = side();
    c.adopt(1);
    expect(side()).toEqual(before);
    expect(read(c).epoch).toBe(1);
    // Issuing resumes at the next update, every job under the adopted generation.
    c.update(cam(0, 0));
    expect(w.fake.issued.length).toBeGreaterThan(n);
    await settleAll(w);
    expect(w.fake.issuedGen.slice(n).every((g) => g === 1)).toBe(true);
    expect(w.fake.violations).toEqual([]);
    expect(c.firstFill()).toBe(true);
    expect(w.fake.unstages).toEqual([]);
  });

  test('D7: a D issued at g whose reply resolves (generation g) after the fake pool moved to g + 1 and adopt(g + 1) advances its column to Decorated, and its L is issued at g + 1', async () => {
    const { w, c } = make({ rd: 4 });
    c.update(cam(0, 0));
    await flush();
    const isD = (p: Issued): boolean => p.stage === 'D' && inSet('L', p.cx, p.cz, 0, 0, 4);
    while (!w.fake.pending.some(isD)) { w.settle(); await flush(); }
    const i = w.fake.pending.findIndex(isD);
    const d = w.fake.pending[i]!;
    const n = w.fake.issued.length;
    w.fake.generation = 1;
    const before = read(c).D.done;
    w.settle(i);
    await flush();
    // Recorded as the store stands (its column at Decorated), whatever generation it ran under.
    expect(read(c).D.done).toBe(before + 1);
    expect(read(c).dropped).toBe(0);
    await settleAll(w);
    expect(w.fake.issued.length).toBe(n);
    c.adopt(1);
    await fill(w, c, cam(0, 0));
    expect(w.fake.violations).toEqual([]);
    const at = (st: Stage): number[] => w.fake.issued.flatMap((j, k) => (j.stage === st && j.cx === d.cx && j.cz === d.cz ? [k] : []));
    expect(at('D')).toHaveLength(1);
    expect(at('L')).toHaveLength(1);
    expect(w.fake.issuedGen[at('L')[0]!]).toBe(1);
    expect(read(c).dropped).toBe(0);
    expect(c.firstFill()).toBe(true);
  });

  test('the sink\'s column: over a fill and a crossing of 10 columns, every sink.remove names a column the sink was staged with, and the held set equals the columns staged and not removed since: it holds the MESH set around the final camera and lies within keepMesh (RD + 1)', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    const pick = lcg(4242);
    await fill(w, c, cam(0, 0), 4242);
    for (let x = 1; x <= 10; x++) {
      c.update(cam(x, 0));
      await flush();
      for (let i = 0; i < 30 && w.fake.pending.length > 0; i++) { w.settle(pick(w.fake.pending.length)); await flush(); }
    }
    for (let i = 0; i < 5; i++) await fill(w, c, cam(10, 0), 99);
    expect(w.fake.violations).toEqual([]);
    const held = new Set<number>();
    const strays: number[] = [];
    for (const op of w.fake.sinkOps) {
      if (op > 0) held.add(op - 1);
      else if (!held.delete(-op - 1)) strays.push(-op - 1);
    }
    expect(strays).toEqual([]);
    expect(w.fake.removes.length).toBeGreaterThan(0);
    expect([...held].sort((a, b) => a - b)).toEqual([...w.fake.revealed].sort((a, b) => a - b));
    for (const [dx, dz] of stageOffsets(rd).MESH) expect(held.has(colKey(10 + dx, dz)), `(${10 + dx}, ${dz})`).toBe(true);
    const outside = w.fake.stages.filter((m) => held.has(colKey(m.cx, m.cz)) && !hasFlag(M_KEEP_MESH, m.cx, m.cz, 10, 0, rd));
    expect(outside).toEqual([]);
    expect(c.firstFill()).toBe(true);
  });

  test('counts: through the first fill counts.stale is 0, counts.epoch is the options\' epoch (1) and every stage\'s done equals SP4b\'s for the same fill', async () => {
    const { w, c } = make({ rd: 6 });
    c.update(cam(0, 0));
    await flush();
    const k = createCoordinatorCounts();
    const pick = lcg(31);
    let steps = 0;
    while (w.fake.pending.length > 0) {
      c.counts(k);
      expect([k.stale, k.epoch]).toEqual([0, 1]);
      expect(doneOf(k), `after ${steps} settles`).toEqual(sp4bDone(w, 0, 0, 6));
      w.settle(pick(w.fake.pending.length));
      await flush();
      steps++;
    }
    c.counts(k);
    expect([k.stale, k.epoch]).toEqual([0, 1]);
    expect(doneOf(k)).toEqual({ T: k.T.needed, D: k.D.needed, L: k.L.needed, MESH: k.MESH.needed });
    expect(doneOf(k)).toEqual(sp4bDone(w, 0, 0, 6));
    // Another first epoch (3): the columns are current under it, so the counts are the same.
    const other = make({ rd: 4, epoch: 3 });
    await fill(other.w, other.c, cam(0, 0));
    const k3 = read(other.c);
    expect([k3.stale, k3.epoch]).toEqual([0, 3]);
    expect(doneOf(k3)).toEqual({ T: 213, D: 157, L: 109, MESH: 69 });
    expect(other.w.fake.violations).toEqual([]);
  });
});

/** The map configured a draft and the world applies it (SP4c spec §4.3): the pool's generation moves, then `apply`. */
function applyTo(w: World, c: Coordinator, epoch: number): void {
  w.fake.generation++;
  c.apply({ epoch, generation: w.fake.generation, from: 'T' });
}

/** `updates` × (one update at `at`, then up to `settles` jobs settled in `pick`'s order). */
async function steps(w: World, c: Coordinator, at: StreamCamera, pick: (n: number) => number, updates: number, settles: number): Promise<void> {
  for (let u = 0; u < updates; u++) {
    c.update(at);
    await flush();
    for (let i = 0; i < settles && w.fake.pending.length > 0; i++) { w.settle(pick(w.fake.pending.length)); await flush(); }
  }
}

/** Updates at `at`, each followed by every job settled in `pick`'s order, until an update changes nothing. */
async function settleDown(w: World, c: Coordinator, at: StreamCamera, pick: (n: number) => number): Promise<void> {
  const size = (): number => w.fake.issued.length + w.fake.frees.length + w.fake.removes.length + w.fake.unstages.length;
  for (let u = 0; u < 1000; u++) {
    const before = size();
    c.update(at);
    await flush();
    while (w.fake.pending.length > 0) { w.settle(pick(w.fake.pending.length)); await flush(); }
    if (size() === before) return;
  }
  throw new Error('the world did not settle in 1,000 updates');
}

/** The colKeys of `stage`'s set around (ccx, ccz). */
const setKeys = (stage: Stage, rd: number, ccx: number, ccz: number): number[] => stageOffsets(rd)[stage].map(([dx, dz]) => colKey(ccx + dx, ccz + dz));

/** The columns the sink still holds after replaying `sinkOps`, and the removes that named no held column. */
function replaySink(w: World): { held: Set<number>; strays: number[] } {
  const held = new Set<number>();
  const strays: number[] = [];
  for (const op of w.fake.sinkOps) {
    if (op > 0) held.add(op - 1);
    else if (!held.delete(-op - 1)) strays.push(-op - 1);
  }
  return { held, strays };
}

/** The T key `pushUnload` gives a stale column inside keepVoxels (its own T score from the rebuild at (ccx, ccz), yaw 0). */
const tKey = (cx: number, cz: number, ccx: number, ccz: number, rd: number): number =>
  hasFlag(M_T, cx, cz, ccx, ccz, rd) ? streamScore(cx - ccx, cz - ccz, 0, -1, STAGE_BONUS.T) : Infinity;

/** Whether (cx, cz) sorts after (or with) (px, pz) under `key`, ties by colKey (the heaps' order). */
const notBefore = (key: (x: number, z: number) => number, px: number, pz: number, cx: number, cz: number): boolean =>
  key(cx, cz) > key(px, pz) || (key(cx, cz) === key(px, pz) && colKey(cx, cz) > colKey(px, pz));

describe('createCoordinator: apply, "old meshes kept on Apply" (SP4c spec §4.4, §4.5, §8.5)', () => {
  test('old meshes are kept on Apply (master §6.3): after apply, no MESH-set column is removed from the sink before its new payload is staged, and each stale column\'s next stage happens under the new epoch', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    const mesh = setKeys('MESH', rd, 0, 0);
    for (const k of mesh) expect(w.fake.revealedEpoch.get(k)).toBe(1);
    const ops = w.fake.sinkOps.length;
    const staged = w.fake.stages.length;
    applyTo(w, c, 2);
    const pick = lcg(4242);
    await steps(w, c, cam(0, 0), pick, 40, 8);
    await settleDown(w, c, cam(0, 0), pick);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([]);
    const inMesh = new Set(mesh);
    expect(w.fake.sinkOps.slice(ops).filter((op) => op < 0 && inMesh.has(-op - 1))).toEqual([]);
    const next = new Map<number, number>();
    for (let i = staged; i < w.fake.stages.length; i++) {
      const k = colKey(w.fake.stages[i]!.cx, w.fake.stages[i]!.cz);
      if (!next.has(k)) next.set(k, w.fake.stageEpochs[i]!);
    }
    for (const k of mesh) expect(next.get(k), `the first stage of ${k} after the Apply`).toBe(2);
    for (const k of mesh) expect(w.fake.revealedEpoch.get(k)).toBe(2);
    const n = read(c);
    expect([n.stale, n.epoch, n.MESH.done]).toEqual([0, 2, n.MESH.needed]);
    expect(doneOf(n)).toEqual({ T: n.T.needed, D: n.D.needed, L: n.L.needed, MESH: n.MESH.needed });
  });

  test('stale frees go nearest first (each update\'s frees in non-decreasing T score, as pushUnload keys them), ≤ 16 per update, and only at zero pins', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    applyTo(w, c, 2);
    const pick = lcg(17);
    const key = (x: number, z: number): number => tKey(x, z, 0, 0, rd);
    const perUpdate: number[] = [];
    for (let u = 0; u < 200 && read(c).stale > 0; u++) {
      const f0 = w.fake.frees.length;
      c.update(cam(0, 0));
      const frees = w.fake.frees.slice(f0);
      perUpdate.push(frees.length);
      for (let i = 1; i < frees.length; i++) {
        const [px, pz] = frees[i - 1]!;
        const [x, z] = frees[i]!;
        expect(notBefore(key, px, pz, x, z), `update ${u}: (${x}, ${z}) freed after (${px}, ${pz})`).toBe(true);
      }
      await flush();
      // A few jobs settle per update, so jobs are in flight (pinning their 3 × 3) while the next frees run.
      for (let i = 0; i < 6 && w.fake.pending.length > 0; i++) { w.settle(pick(w.fake.pending.length)); await flush(); }
    }
    expect(perUpdate[0]).toBe(FREES_PER_FRAME);
    expect(Math.max(...perUpdate)).toBeLessThanOrEqual(FREES_PER_FRAME);
    expect(perUpdate.filter((n) => n === FREES_PER_FRAME).length).toBeGreaterThan(5);
    await settleDown(w, c, cam(0, 0), pick);
    // The fake flags a free under a pending job that reads or writes the column (its pins, or busy).
    expect(w.fake.violations).toEqual([]);
    expect(read(c).stale).toBe(0);
  });

  test('a stale column busy at apply is freed after its job settles', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    c.update(cam(0, 0));
    await flush();
    while (!w.fake.pending.some((p) => p.stage === 'D')) { w.settle(); await flush(); }
    const y = w.fake.pending.find((p) => p.stage === 'D')!;
    const isY = (p: Issued): boolean => p.stage === 'D' && p.cx === y.cx && p.cz === y.cz;
    applyTo(w, c, 2);
    const f0 = w.fake.frees.length;
    for (let u = 0; u < 6; u++) {
      c.update(cam(0, 0));
      await flush();
      for (let i = 0; i < 30; i++) {
        const j = w.fake.pending.findIndex((p) => !isY(p));
        if (j < 0) break;
        w.settle(j);
        await flush();
      }
    }
    // The frees passed Y (columns of a larger T key went), but Y, busy, stayed.
    const key = (x: number, z: number): number => tKey(x, z, 0, 0, rd);
    expect(w.fake.frees.slice(f0).some(([x, z]) => notBefore(key, y.cx, y.cz, x, z))).toBe(true);
    expect(has(w.fake.frees.slice(f0), y.cx, y.cz)).toBe(false);
    expect(w.fake.violations).toEqual([]);
    w.settle(w.fake.pending.findIndex(isY));
    await flush();
    const f1 = w.fake.frees.length;
    await settleDown(w, c, cam(0, 0), lcg(5));
    expect(has(w.fake.frees.slice(f1), y.cx, y.cz)).toBe(true);
    expect(w.fake.records.get(slotOf(y.cx, y.cz))).toMatchObject({ cx: y.cx, cz: y.cz, status: 3, epoch: 2 });
    expect(w.fake.violations).toEqual([]);
    const n = read(c);
    expect([n.stale, n.MESH.done]).toEqual([0, n.MESH.needed]);
  });

  test('a column at the applied epoch is never freed (an undo keeps it)', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    applyTo(w, c, 2);
    const pick = lcg(99);
    await steps(w, c, cam(0, 0), pick, 3, 20);
    // The columns still at epoch 1 (never freed under 2) are current again after the undo.
    const kept = [...w.fake.records.values()].filter((r) => r.epoch === 1).map((r) => [r.cx, r.cz] as const);
    expect(kept.length).toBeGreaterThan(100);
    applyTo(w, c, 1);
    const f0 = w.fake.frees.length;
    const mark = w.fake.issued.length;
    await settleDown(w, c, cam(0, 0), pick);
    expect(w.fake.violations).toEqual([]);
    const frees = w.fake.frees.slice(f0);
    expect(frees.length).toBeGreaterThan(0);
    for (const [x, z] of kept) {
      expect(has(frees, x, z), `(${x}, ${z}) freed`).toBe(false);
      expect(w.fake.issued.slice(mark).some((j) => j.cx === x && j.cz === z && j.stage === 'T'), `(${x}, ${z}) regenerated`).toBe(false);
    }
    const n = read(c);
    expect([n.stale, n.epoch]).toEqual([0, 1]);
    expect(doneOf(n)).toEqual({ T: n.T.needed, D: n.D.needed, L: n.L.needed, MESH: n.MESH.needed });
  });

  test('no D, L or MESH is issued while its 3 × 3 is not all at the applied epoch (the fake checks every issue against its records\' epochs)', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    const mark = w.fake.issued.length;
    applyTo(w, c, 2);
    const pick = lcg(3);
    await steps(w, c, cam(0, 0), pick, 10, 12);
    applyTo(w, c, 3);
    await settleDown(w, c, cam(0, 0), pick);
    expect(w.fake.violations).toEqual([]);
    const after = perStage(w.fake.issued.slice(mark));
    expect(after.D).toBeGreaterThan(0);
    expect(after.L).toBeGreaterThan(0);
    expect(after.MESH).toBeGreaterThan(0);
    expect(read(c).stale).toBe(0);
  });

  test('a MESH in flight at apply and settling after it is not staged (dropped, as its seq is superseded)', async () => {
    const { w, c } = make({ rd: 6, workers: 5 });
    c.update(cam(0, 0));
    await flush();
    while (!w.fake.pending.some((p) => p.stage === 'MESH')) { w.settle(); await flush(); }
    const i = w.fake.pending.findIndex((p) => p.stage === 'MESH');
    const m = w.fake.pending[i]!;
    applyTo(w, c, 2);
    const staged = w.fake.stages.length;
    const dropped = read(c).dropped;
    w.settle(i);
    await flush();
    expect(w.fake.stages.slice(staged).some((s) => s.cx === m.cx && s.cz === m.cz)).toBe(false);
    expect(read(c).dropped).toBe(dropped + 1);
    await settleDown(w, c, cam(0, 0), lcg(8));
    expect(w.fake.violations).toEqual([]);
    const at = w.fake.stages.flatMap((s, k) => (s.cx === m.cx && s.cz === m.cz ? [w.fake.stageEpochs[k]] : []));
    expect(at).toEqual([2]);
  });

  test('stale meshes outside the MESH set are removed after apply, ≤ 64 per update', async () => {
    // A fill at RD 12, then RD 11: the meshes between the RD 11 disc and its keepMesh (RD + 1 = the RD 12 disc) stay
    // shown outside the MESH set (SP4b's hysteresis), more than 64 of them.
    const { w, c } = make({ rd: 12 });
    await fill(w, c, cam(0, 0));
    c.setRenderDistance(11);
    await fill(w, c, cam(0, 0));
    expect(w.fake.removes).toEqual([]);
    const mesh = new Set(setKeys('MESH', 11, 0, 0));
    const ring = [...w.fake.revealed].filter((k) => !mesh.has(k));
    expect(ring.length).toBeGreaterThan(MESH_REMOVALS_PER_FRAME);
    expect(w.fake.violations).toEqual([]);
    applyTo(w, c, 2);
    const d = deltas(w);
    c.update(cam(0, 0));
    const first = w.fake.removes.slice(-d().removes);
    c.update(cam(0, 0));
    expect(d().removes).toBe(ring.length - MESH_REMOVALS_PER_FRAME);
    expect(first.length).toBe(MESH_REMOVALS_PER_FRAME);
    for (const [x, z] of w.fake.removes) expect(mesh.has(colKey(x, z)), `(${x}, ${z}) removed`).toBe(false);
    expect(new Set(w.fake.removes.map(([x, z]) => colKey(x, z)))).toEqual(new Set(ring));
    await settleDown(w, c, cam(0, 0), lcg(12));
    expect(w.fake.violations).toEqual([]);
    expect([...w.fake.revealed].every((k) => mesh.has(k))).toBe(true);
    expect(read(c).stale).toBe(0);
  });

  test('adopt frees and stages nothing; an Apply of the epoch already applied frees nothing', async () => {
    for (const how of ['adopt', 'apply'] as const) {
      const { w, c } = make({ rd: 4 });
      await fill(w, c, cam(0, 0));
      const side = (): number[] => [w.fake.issued.length, w.fake.frees.length, w.fake.stages.length, w.fake.unstages.length, w.fake.removes.length];
      const before = side();
      if (how === 'adopt') {
        w.fake.generation++;
        c.adopt(w.fake.generation);
      } else {
        applyTo(w, c, 1);
      }
      for (let i = 0; i < 5; i++) await fill(w, c, cam(0, 0));
      expect(side(), how).toEqual(before);
      const n = read(c);
      expect([n.stale, n.epoch], how).toEqual([0, 1]);
      expect(doneOf(n), how).toEqual({ T: 213, D: 157, L: 109, MESH: 69 });
      expect(w.fake.violations).toEqual([]);
    }
  });

  test('the sink column: apply, let 30 stale columns be freed with their old meshes kept, then move the camera 40 columns (and teleport 640) before they regenerate: every column the fake sink holds is tracked by its slot or was removed, and the removals name the old columns', async () => {
    for (const to of [40, 640]) {
      const rd = 6;
      const { w, c } = make({ rd, workers: 5 });
      await fill(w, c, cam(0, 0), 4242);
      const old = [...w.fake.revealed];
      // Applied under a generation the pool does not hold yet: the frees run (in `update`) and nothing is issued, so the
      // freed columns keep their old meshes and do not regenerate.
      c.apply({ epoch: 2, generation: 1, from: 'T' });
      const f0 = w.fake.frees.length;
      const n = w.fake.issued.length;
      c.update(cam(0, 0));
      c.update(cam(0, 0));
      const freed = w.fake.frees.slice(f0);
      expect(freed.length).toBeGreaterThanOrEqual(30);
      expect(w.fake.issued.length).toBe(n);
      for (const [x, z] of freed) expect(w.fake.revealed.has(colKey(x, z)), `(${x}, ${z}) kept its mesh`).toBe(true);
      expect(w.fake.removes).toEqual([]);
      w.fake.generation = 1;
      // The move's classification removes each kept mesh before its slot follows another column (C1), outside the
      // 64 mesh removals of the frame, so they are all gone after the first update there.
      c.update(cam(to, 0));
      for (const [x, z] of freed) expect(has(w.fake.removes, x, z), `(${x}, ${z}) removed at the move (to ${to})`).toBe(true);
      await settleDown(w, c, cam(to, 0), lcg(4242));
      expect(w.fake.violations, `to ${to}`).toEqual([]);
      expect(w.fake.events).toEqual([]);
      const { held, strays } = replaySink(w);
      expect(strays).toEqual([]);
      expect([...held].sort((a, b) => a - b)).toEqual([...w.fake.revealed].sort((a, b) => a - b));
      // Tracked by its slot: every held column lies in keepMesh around the camera (inside the window, where a slot's
      // window column is the column itself).
      const keep = new Set(w.fake.stages.filter((s) => hasFlag(M_KEEP_MESH, s.cx, s.cz, to, 0, rd)).map((s) => colKey(s.cx, s.cz)));
      for (const k of held) expect(keep.has(k), `${k} held outside keepMesh around (${to}, 0)`).toBe(true);
      const removed = new Set(w.fake.removes.map(([x, z]) => colKey(x, z)));
      for (const [x, z] of freed) expect(removed.has(colKey(x, z)), `(${x}, ${z}) removed`).toBe(true);
      for (const k of old) expect(removed.has(k)).toBe(true);
      for (const k of setKeys('MESH', rd, to, 0)) expect(w.fake.revealedEpoch.get(k)).toBe(2);
    }
  });

  test('a first reveal dropped at apply (unstage true with nothing shown): the sink holds nothing for the column, so no later move removes it, and it is meshed again at the new epoch', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    c.update(cam(0, 0));
    await flush();
    const pick = lcg(23);
    while (w.fake.stages.length < 20) { w.settle(pick(w.fake.pending.length)); await flush(); }
    const held = w.fake.revealed.size;
    w.fake.unstageReturns = () => true;
    applyTo(w, c, 2);
    expect(w.fake.unstages).toHaveLength(held);
    expect(w.fake.revealed.size).toBe(0);
    await settleDown(w, c, cam(40, 0), pick);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([]);
    expect(w.fake.removes).toEqual([]);
    for (const k of setKeys('MESH', rd, 40, 0)) expect(w.fake.revealedEpoch.get(k)).toBe(2);
    const n = read(c);
    expect([n.stale, n.MESH.done]).toEqual([0, n.MESH.needed]);
  });

  test('the mesh epochs (1): right after a teleport and during the first fill counts.stale is 0 (Absent columns are needed, not stale)', async () => {
    const { w, c } = make({ rd: 6, workers: 5 });
    const k = createCoordinatorCounts();
    const pick = lcg(61);
    for (const at of [cam(0, 0), cam(640, 0)]) {
      c.update(at);
      await flush();
      expect(c.counts(k).stale).toBe(0);
      for (let u = 0; u < 60; u++) {
        while (w.fake.pending.length > 0) {
          w.settle(pick(w.fake.pending.length));
          await flush();
          expect(c.counts(k).stale).toBe(0);
        }
        c.update(at);
        await flush();
        expect(c.counts(k).stale).toBe(0);
      }
      expect(c.counts(k).MESH.done).toBe(k.MESH.needed);
    }
    expect(w.fake.violations).toEqual([]);
  });

  test('the mesh epochs (2): apply A → B, X freed with its A mesh shown, undo to A before X\'s B payload is staged: X regenerates as A, is marked meshed without a MESH, and MESH done reaches needed', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    const mark = w.fake.issued.length;
    const staged = w.fake.stages.length;
    applyTo(w, c, 2);
    const f0 = w.fake.frees.length;
    c.update(cam(0, 0));
    const [xx, xz] = w.fake.frees[f0]!;
    const x = colKey(xx, xz);
    expect(w.fake.revealedEpoch.get(x)).toBe(1);
    expect(w.fake.shown.get(x)).toBe(1);
    // Undo to A at once: X's B T may be in flight, its B payload is not staged.
    applyTo(w, c, 1);
    const undo = w.fake.issued.length;
    await settleDown(w, c, cam(0, 0), lcg(4242));
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([]);
    expect(w.fake.records.get(slotOf(xx, xz))).toMatchObject({ cx: xx, cz: xz, status: 3, epoch: 1 });
    expect(w.fake.issued.slice(undo).some((j) => j.stage === 'T' && j.cx === xx && j.cz === xz)).toBe(true);
    expect(w.fake.issued.slice(mark).some((j) => j.stage === 'MESH' && j.cx === xx && j.cz === xz)).toBe(false);
    expect(w.fake.stages.slice(staged).some((s) => s.cx === xx && s.cz === xz)).toBe(false);
    expect(w.fake.removes.some(([a, b]) => a === xx && b === xz)).toBe(false);
    expect(w.fake.revealedEpoch.get(x)).toBe(1);
    const n = read(c);
    expect([n.stale, n.epoch, n.MESH.done]).toEqual([0, 1, n.MESH.needed]);
  });

  test('the mesh epochs (3): X\'s B payload staged, then an undo whose unstage returns true: X still shows A and no MESH is issued for it; with unstage returning false (B already shown), X\'s shown epoch becomes B and it re-meshes as A', async () => {
    for (const drops of [true, false]) {
      const rd = 6;
      const { w, c } = make({ rd, workers: 5 });
      await fill(w, c, cam(0, 0), 4242);
      const staged = w.fake.stages.length;
      applyTo(w, c, 2);
      const f0 = w.fake.frees.length;
      c.update(cam(0, 0));
      // X: the first column freed; run until its B payload is staged.
      const [xx, xz] = w.fake.frees[f0]!;
      const x = colKey(xx, xz);
      const pick = lcg(4242);
      const stagedB = (): boolean => w.fake.stages.slice(staged).some((s) => s.cx === xx && s.cz === xz);
      for (let u = 0; u < 200 && !stagedB(); u++) {
        await flush();
        for (let i = 0; i < 4 && w.fake.pending.length > 0 && !stagedB(); i++) { w.settle(pick(w.fake.pending.length)); await flush(); }
        if (!stagedB()) c.update(cam(0, 0));
      }
      expect(stagedB()).toBe(true);
      expect([w.fake.shown.get(x), w.fake.staged.get(x)]).toEqual([1, 2]);
      w.fake.unstageReturns = (cx, cz) => drops && cx === xx && cz === xz;
      const undo = w.fake.issued.length;
      const s0 = w.fake.stages.length;
      applyTo(w, c, 1);
      expect(has(w.fake.unstages, xx, xz)).toBe(true);
      expect(w.fake.revealedEpoch.get(x), `drops ${drops}`).toBe(drops ? 1 : 2);
      expect(w.fake.shown.get(x)).toBe(drops ? 1 : 2);
      await settleDown(w, c, cam(0, 0), pick);
      expect(w.fake.violations, `drops ${drops}`).toEqual([]);
      expect(w.fake.events).toEqual([]);
      const meshes = w.fake.issued.slice(undo).filter((j) => j.stage === 'MESH' && j.cx === xx && j.cz === xz).length;
      const stagesX = w.fake.stages.flatMap((s, k) => (k >= s0 && s.cx === xx && s.cz === xz ? [w.fake.stageEpochs[k]] : []));
      if (drops) {
        expect(meshes).toBe(0);
        expect(stagesX).toEqual([]);
      } else {
        expect(meshes).toBe(1);
        expect(stagesX).toEqual([1]);
      }
      expect(w.fake.records.get(slotOf(xx, xz))).toMatchObject({ cx: xx, cz: xz, status: 3, epoch: 1 });
      expect(w.fake.revealedEpoch.get(x)).toBe(1);
      const n = read(c);
      expect([n.stale, n.epoch, n.MESH.done]).toEqual([0, 1, n.MESH.needed]);
    }
  });

  test('Review Focus 1: apply A → B, 20 updates, apply C, 20 updates, apply B again, jobs settling in LCG order (seed 4242): every MESH-set column ends shown at B, stage is never called with stagedEpoch ≠ 0, the fake sink never shows two seqs for a column, counts.stale reaches 0, and no column is freed while pinned or busy', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    const pick = lcg(4242);
    applyTo(w, c, 2);
    // After the first Apply some B payloads wait for their reveal at the next one (dropped) and some are shown.
    const coin = lcg(7);
    w.fake.unstageReturns = () => coin(2) === 0;
    await steps(w, c, cam(0, 0), pick, 20, 10);
    expect(read(c).stale).toBeGreaterThan(0);
    applyTo(w, c, 3);
    await steps(w, c, cam(0, 0), pick, 20, 10);
    expect(read(c).stale).toBeGreaterThan(0);
    applyTo(w, c, 2);
    await settleDown(w, c, cam(0, 0), pick);
    // The fake flags a free under a pin or a job, a stage over a pending payload or at an epoch already held, and a D, L
    // or MESH whose 3 × 3 is not at the applied epoch; the coordinator's own stage assertion would be a fatal event.
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([]);
    expect(w.fake.unstages.length).toBeGreaterThan(0);
    // Never two seqs for a column: each (column, seq) staged once, and never over a pending payload (above).
    expect(new Set(w.fake.stages.map((s) => `${s.cx},${s.cz},${s.seq}`)).size).toBe(w.fake.stages.length);
    for (const k of setKeys('MESH', rd, 0, 0)) expect(w.fake.revealedEpoch.get(k), `${k}`).toBe(2);
    const n = read(c);
    expect([n.stale, n.epoch]).toEqual([0, 2]);
    expect(doneOf(n)).toEqual({ T: n.T.needed, D: n.D.needed, L: n.L.needed, MESH: n.MESH.needed });
  });

  test('Review Focus 5: teleport 640 columns east at RD 6, 10 updates later apply epoch 2: no ghost, every old-place column removed, every MESH-set column ends shown at epoch 2, stage never over a pending payload, and the first 16 T after the Apply are nearest-first from the new place', async () => {
    const rd = 6;
    const { w, c } = make({ rd, workers: 5 });
    await fill(w, c, cam(0, 0), 4242);
    const old = [...w.fake.revealed];
    const pick = lcg(4242);
    await steps(w, c, cam(640, 0), pick, 10, 10);
    const mark = w.fake.issued.length;
    applyTo(w, c, 2);
    await settleDown(w, c, cam(640, 0), pick);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([]);
    const { held, strays } = replaySink(w);
    expect(strays).toEqual([]);
    const keep = new Set(w.fake.stages.filter((s) => hasFlag(M_KEEP_MESH, s.cx, s.cz, 640, 0, rd)).map((s) => colKey(s.cx, s.cz)));
    for (const k of held) expect(keep.has(k), `${k} held outside keepMesh around (640, 0)`).toBe(true);
    const removed = new Set(w.fake.removes.map(([x, z]) => colKey(x, z)));
    for (const k of old) expect(removed.has(k)).toBe(true);
    for (const k of setKeys('MESH', rd, 640, 0)) expect(w.fake.revealedEpoch.get(k)).toBe(2);
    const ts = w.fake.issued.slice(mark).filter((j) => j.stage === 'T').slice(0, 16);
    expect(ts).toHaveLength(16);
    const key = (x: number, z: number): number => streamScore(x - 640, z, 0, -1, STAGE_BONUS.T);
    for (let i = 1; i < ts.length; i++) expect(notBefore(key, ts[i - 1]!.cx, ts[i - 1]!.cz, ts[i]!.cx, ts[i]!.cz), `T ${i}`).toBe(true);
    const n = read(c);
    expect([n.stale, n.epoch, n.MESH.done]).toEqual([0, 2, n.MESH.needed]);
  });

  test('a column skipped at T under one draft is retried under the next applied one: apply clears the failed mark and retries of a stage-0 column, so the world settles with nothing stale (final review ENG-2)', async () => {
    let failing = false;
    const boom = new Error('INTERNAL: boom');
    const { w, c } = make({ rd: 4, failOf: (j) => (failing && j.stage === 'T' && j.cx === 1 && j.cz === 1 ? boom : null) });
    await fill(w, c, cam(0, 0));
    const pick = lcg(4242);
    // Draft 2 makes (1, 1)'s T fail twice: the column is skipped, its 3 × 3 never reaches D or MESH under epoch 2.
    failing = true;
    applyTo(w, c, 2);
    await settleDown(w, c, cam(0, 0), pick);
    expect(w.fake.events).toEqual([{ kind: 'skipped', cx: 1, cz: 1 }]);
    expect(c.isSkipped(1, 1)).toBe(true);
    // Stuck until the next Apply: stale, with no job in flight or queued (the overlay's signal that nothing regenerates,
    // final review WLD-3).
    const stuck = read(c);
    expect(stuck.stale).toBeGreaterThan(0);
    expect([stuck.T, stuck.D, stuck.L, stuck.MESH].map((k) => k.inFlight + k.queued)).toEqual([0, 0, 0, 0]);
    const ts = issuedOf(w, 'T', 1, 1);
    // Draft 3 generates (1, 1) fine: the Apply retries it, and the world settles at epoch 3 with nothing stale.
    failing = false;
    applyTo(w, c, 3);
    await settleDown(w, c, cam(0, 0), pick);
    expect(c.isSkipped(1, 1)).toBe(false);
    expect(issuedOf(w, 'T', 1, 1)).toBeGreaterThan(ts);
    const n = read(c);
    expect([n.stale, n.failed, n.epoch]).toEqual([0, 0, 3]);
    expect(doneOf(n)).toEqual({ T: n.T.needed, D: n.D.needed, L: n.L.needed, MESH: n.MESH.needed });
    for (const k of setKeys('MESH', 4, 0, 0)) expect(w.fake.revealedEpoch.get(k)).toBe(3);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.events).toEqual([{ kind: 'skipped', cx: 1, cz: 1 }]);
  });
});

describe('progressFraction and phaseName (SP4a spec §8.3, over the coordinator counts)', () => {
  const p = (done: Partial<Record<Stage, number>>): CoordinatorCounts => {
    const c = createCoordinatorCounts();
    for (const st of ['T', 'D', 'L', 'MESH'] as const) {
      c[st].needed = 10;
      c[st].done = done[st] ?? 0;
    }
    return c;
  };

  test('the fraction is 0.2·T + 0.05·D + 0.25·L + 0.35·MESH + 0.15·uploads, each done/needed', () => {
    expect(progressFraction(p({ T: 10 }), 0, 4)).toBeCloseTo(0.2, 12);
    expect(progressFraction(p({ T: 10, D: 10 }), 0, 4)).toBeCloseTo(0.25, 12);
    expect(progressFraction(p({ T: 10, D: 10, L: 5 }), 0, 4)).toBeCloseTo(0.375, 12);
    expect(progressFraction(p({ T: 10, D: 10, L: 10, MESH: 10 }), 2, 4)).toBeCloseTo(0.925, 12);
    expect(progressFraction(p({ T: 10, D: 10, L: 10, MESH: 10 }), 4, 4)).toBe(1);
    expect(progressFraction(createCoordinatorCounts(), 0, 0)).toBe(0);
  });

  test('the phase is the earliest stage still running: Generating (T, D), Lighting, Meshing, then Preparing the view', () => {
    expect(phaseName(p({ T: 9 }), 0, 0)).toBe('Generating');
    expect(phaseName(p({ T: 10, D: 9, L: 3 }), 0, 0)).toBe('Generating');
    expect(phaseName(p({ T: 10, D: 10, L: 3 }), 0, 0)).toBe('Lighting');
    expect(phaseName(p({ T: 10, D: 10, L: 10, MESH: 9 }), 0, 0)).toBe('Meshing');
    expect(phaseName(p({ T: 10, D: 10, L: 10, MESH: 10 }), 4, 4)).toBe('Preparing the view');
  });

  test('a fill\'s counts rise monotonically to a fraction of 1 with the uploads done', async () => {
    const { w, c } = make({ rd: 6 });
    c.update(cam(0, 0));
    await flush();
    const counts = createCoordinatorCounts();
    let last = progressFraction(c.counts(counts), 0, 1);
    expect(last).toBe(0);
    expect(phaseName(counts, 0, 1)).toBe('Generating');
    while (w.fake.pending.length > 0) {
      w.settle();
      await flush();
      const f = progressFraction(c.counts(counts), 0, 1);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    expect(last).toBeCloseTo(0.85, 12);
    expect(progressFraction(counts, 5, 5)).toBe(1);
    expect(phaseName(counts, 0, 5)).toBe('Preparing the view');
  });
});

describe('worldJobsOf (ruling P30, SP4b spec §3.13)', () => {
  const done = (cx: number, cz: number, versions: Int32Array | null): ColumnDone => ({ cx, cz, ms: 3, versions, generation: 0 });
  /** A reply issued under generation 5 (SP4c spec §4.6: the outcome carries the job's generation, not the pool's now). */
  const done5 = (cx: number, cz: number, versions: Int32Array | null): ColumnDone => ({ cx, cz, ms: 3, versions, generation: 5 });
  const lightVersions = Int32Array.from({ length: 18 }, (_, i) => i + 1);
  const payload = { cx: 4, cz: 5, versions: Int32Array.from({ length: 18 }, (_, i) => 100 + i) } as unknown as ColumnMeshPayload;
  const calls: string[] = [];
  let live = 3;
  let epoch = 0;
  const pool = {
    get epoch() { return epoch; },
    terrain: (cx: number, cz: number, protoOnly?: boolean) => { calls.push(`terrain ${cx} ${cz} ${String(protoOnly)}`); return Promise.resolve(done(cx, cz, null)); },
    decorate: (cx: number, cz: number) => { calls.push(`decorate ${cx} ${cz}`); return Promise.resolve(done(cx, cz, null)); },
    light: (cx: number, cz: number) => { calls.push(`light ${cx} ${cz}`); return Promise.resolve(done(cx, cz, lightVersions)); },
    meshColumn: (cx: number, cz: number) => { calls.push(`meshColumn ${cx} ${cz}`); return Promise.resolve({ payload, generation: 0 }); },
    cancelWorld: (pred: (stage: Stage, cx: number, cz: number) => boolean) => { calls.push(`cancelWorld ${String(pred('T', 0, 0))}`); },
    liveWorkers: () => live,
  } as unknown as WorkerPool;

  test('T, D, L and MESH map to terrain, decorate, light and meshColumn', async () => {
    calls.length = 0;
    const jobs = worldJobsOf(pool);
    expect(await jobs.run('T', 1, -2, false)).toEqual({ versions: null, payload: null, generation: 0 });
    expect(await jobs.run('D', 1, -2, false)).toEqual({ versions: null, payload: null, generation: 0 });
    const l = await jobs.run('L', 1, -2, false);
    expect(l.versions).toBe(lightVersions);
    expect(l.payload).toBeNull();
    const m = await jobs.run('MESH', 4, 5, false);
    expect(m.payload).toBe(payload);
    expect(m.versions).toBe(payload.versions);
    expect(calls).toEqual(['terrain 1 -2 false', 'decorate 1 -2', 'light 1 -2', 'meshColumn 4 5']);
  });

  test('T with protoOnly runs terrain(cx, cz, true) (SP4b spec §3.7)', async () => {
    calls.length = 0;
    expect(await worldJobsOf(pool).run('T', 3, 4, true)).toEqual({ versions: null, payload: null, generation: 0 });
    expect(calls).toEqual(['terrain 3 4 true']);
  });

  test('cancel is cancelWorld and liveWorkers the pool\'s', () => {
    calls.length = 0;
    const jobs = worldJobsOf(pool);
    jobs.cancel(() => true);
    expect(calls).toEqual(['cancelWorld true']);
    expect(jobs.liveWorkers()).toBe(3);
    live = 1;
    expect(jobs.liveWorkers()).toBe(1);
  });

  test('generation() is the pool\'s epoch now, and each outcome carries the generation its reply was issued under (SP4c spec §4.2, §4.6)', async () => {
    const jobs = worldJobsOf(pool);
    expect(jobs.generation()).toBe(0);
    epoch = 6;
    expect(jobs.generation()).toBe(6);
    const old = {
      epoch: 6,
      terrain: (cx: number, cz: number) => Promise.resolve(done5(cx, cz, null)),
      decorate: (cx: number, cz: number) => Promise.resolve(done5(cx, cz, null)),
      light: (cx: number, cz: number) => Promise.resolve(done5(cx, cz, lightVersions)),
      meshColumn: () => Promise.resolve({ payload, generation: 5 }),
    } as unknown as WorkerPool;
    const j = worldJobsOf(old);
    for (const st of ['T', 'D', 'L', 'MESH'] as const) expect((await j.run(st, 1, 2, false)).generation, st).toBe(5);
    epoch = 0;
  });

  test('rejections pass through unchanged', async () => {
    const full = new StoreFullError('blocks full');
    const cancelled = new JobCancelled();
    const failing = {
      terrain: () => Promise.reject(full),
      decorate: () => Promise.reject(cancelled),
      light: () => Promise.reject(full),
      meshColumn: () => Promise.reject(cancelled),
    } as unknown as WorkerPool;
    const jobs = worldJobsOf(failing);
    await expect(jobs.run('T', 0, 0, false)).rejects.toBe(full);
    await expect(jobs.run('D', 0, 0, false)).rejects.toBe(cancelled);
    await expect(jobs.run('L', 0, 0, false)).rejects.toBe(full);
    await expect(jobs.run('MESH', 0, 0, false)).rejects.toBe(cancelled);
  });
});

import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { STAGE_BONUS, streamScore } from '../../src/core/streamScore';
import {
  createCoordinator, createCoordinatorCounts, phaseName, progressFraction, worldJobsOf,
  type Coordinator, type CoordinatorCounts, type CoordinatorJobs, type JobOutcome, type StreamCamera, type StreamEvent,
  type StreamSink, type StreamStore,
} from '../../src/engine/coordinator';
import { KEEP_VOXELS_EXTRA, M_D, M_L, M_MESH, M_T, membershipTable, stageOffsets, type Stage } from '../../src/engine/rings';
import { createThrottle, type Throttle } from '../../src/engine/throttle';
import { JobCancelled, StoreFullError, type ColumnDone, type WorkerPool } from '../../src/engine/workerPool';
import type { ColumnMeshPayload } from '../../src/mesh/column';

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
}

/**
 * The world as the coordinator sees it: a store model of records (one per torus slot: the column holding it and its
 * status, 1 Proto … 3 Published; block and light versions), fake jobs that settle on a manual tick and commit into the
 * model when they resolve, and a sink. Every issue is checked against the prerequisites, the record's holder, the
 * caps (with the throttle's cap at that moment) and the columns already busy.
 */
function fakeWorld(fo: FakeOptions = {}) {
  const fake = {
    live: fo.workers ?? 4,
    records: new Map<number, { cx: number; cz: number; status: number; block: number; light: number }>(),
    pending: [] as Pending[],
    issued: [] as Issued[],
    violations: [] as string[],
    frees: [] as Array<readonly [number, number]>,
    cancels: 0,
    stages: [] as Array<{ readonly cx: number; readonly cz: number; readonly seq: number }>,
    removes: [] as Array<readonly [number, number]>,
    events: [] as StreamEvent[],
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
          const held = r !== undefined && r.cx === cx + dx && r.cz === cz + dz;
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
      const r = fake.records.get(slotOf(cx, cz));
      if (r === undefined || r.cx !== cx || r.cz !== cz) return;
      fake.records.delete(slotOf(cx, cz));
      fake.frees.push([cx, cz]);
    },
    freeProto() {},
  };

  const commit = (stage: Stage, cx: number, cz: number): void => {
    const s = slotOf(cx, cz);
    if (stage === 'T') fake.records.set(s, { cx, cz, status: 1, block: 1, light: 0 });
    else if (stage === 'D') { const r = fake.records.get(s)!; r.status = 2; r.block++; }
    else if (stage === 'L') { const r = fake.records.get(s)!; r.status = 3; r.light++; }
  };

  const check = (stage: Stage, cx: number, cz: number): void => {
    const what = `${stage} at (${cx}, ${cz})`;
    if (fake.pending.some((p) => p.cx === cx && p.cz === cz)) violations(`${what} issued for a busy column`);
    if (stage === 'T') {
      if (store.holder(cx, cz) !== 'free') violations(`${what} issued with its record held (SlotBusy)`);
    } else {
      const need = RANK[stage] - 1;
      if (statusAt(cx, cz) !== need) violations(`${what} issued with its column at ${statusAt(cx, cz)}`);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (statusAt(cx + dx, cz + dz) < need) violations(`${what} before (${cx + dx}, ${cz + dz}) reached ${need}`);
        }
      }
      if (stage === 'MESH' && fake.stages.some((m) => m.cx === cx && m.cz === cz)) violations(`${what} issued for a staged column`);
    }
    const N = fake.live;
    if (inFlight.T + inFlight.D + inFlight.L > throttle.cap()) violations(`${inFlight.T + inFlight.D + inFlight.L} T + D + L in flight above genCap ${throttle.cap()}`);
    if (inFlight.T > Math.max(1, N - 1)) violations(`${inFlight.T} T in flight`);
    if (inFlight.MESH > N) violations(`${inFlight.MESH} MESH in flight`);
    if (total > N) violations(`${total} jobs in flight`);
  };
  const violations = (v: string): void => { fake.violations.push(v); };

  const outcome = (stage: Stage, cx: number, cz: number, versions: Int32Array): JobOutcome => {
    const v = stage === 'L' || stage === 'MESH' ? versions : null;
    const payload = stage === 'MESH' ? ({ cx, cz, versions: v } as unknown as ColumnMeshPayload) : null;
    return { versions: v, payload };
  };

  const jobs: CoordinatorJobs = {
    run(stage, cx, cz, protoOnly) {
      fake.issued.push({ stage, cx, cz });
      if (protoOnly) violations(`${stage} at (${cx}, ${cz}) with protoOnly`);
      inFlight[stage]++;
      total++;
      check(stage, cx, cz);
      const versions = new Int32Array(18);
      store.versionsInto(cx, cz, versions);
      return new Promise<JobOutcome>((resolve, reject) => {
        const done = () => { inFlight[stage]--; total--; };
        const p: Pending = {
          stage, cx, cz, versions,
          resolve: () => {
            done();
            fo.tamper?.({ stage, cx, cz }, versions);
            commit(stage, cx, cz);
            resolve(outcome(stage, cx, cz, versions));
          },
          reject: (e) => { done(); reject(e); },
        };
        if (fo.sync === true) p.resolve();
        else fake.pending.push(p);
      });
    },
    cancel(pred) {
      fake.cancels++;
      // The first pending job is running; the others are queued and leave with JobCancelled.
      const keep: Pending[] = [];
      fake.pending.forEach((p, i) => {
        if (i > 0 && pred(p.stage, p.cx, p.cz)) p.reject(new JobCancelled());
        else keep.push(p);
      });
      fake.pending.splice(0, fake.pending.length, ...keep);
    },
    liveWorkers: () => fake.live,
  };
  const sink: StreamSink = {
    stage(p, seq) { fake.stages.push({ cx: p.cx, cz: p.cz, seq }); },
    remove(cx, cz) { fake.removes.push([cx, cz]); },
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
}

function make(mo: MakeOptions = {}): { w: World; c: Coordinator } {
  const w = fakeWorld(mo);
  const c = createCoordinator({
    jobs: w.jobs, store: w.store, sink: w.sink, throttle: w.throttle, rd: mo.rd ?? 4, rdMax: mo.rdMax ?? 16,
    retainAllProtos: true, strict: mo.strict ?? false, onEvent: (e) => w.fake.events.push(e),
  });
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
    };
    const store: StreamStore = {
      versionsInto: () => { touched.push('versionsInto'); },
      holder: () => { touched.push('holder'); return 'free'; },
      freeColumn: () => { touched.push('freeColumn'); },
      freeProto: () => { touched.push('freeProto'); },
    };
    const sink: StreamSink = { stage: () => { touched.push('stage'); }, remove: () => { touched.push('remove'); } };
    const throttle = createThrottle({ max: 3 });
    const at = (rd: number, rdMax: number) => () => createCoordinator({
      jobs, store, sink, throttle, rd, rdMax, retainAllProtos: true, strict: true, onEvent: () => { touched.push('onEvent'); },
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
    const { w, c } = make({ rd: 4 });
    c.update(cam(0, 0));
    await flush();
    const isK = (p: Issued) => p.stage === 'MESH' && p.cx === 4 && p.cz === 0;
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

  test('no revealed column is ever re-staged: over a fill, a crossing back and forth and an LCG settle order, sink.stage is called at most once per (column, meshSeq)', async () => {
    const { w, c } = make({ rd: 6, workers: 5 });
    const pick = lcg(4242);
    const path = [cam(0, 0), cam(1, 0), cam(2, 1), cam(1, 0), cam(0, 0), cam(-1, 0), cam(0, 0)];
    for (const at of path) {
      c.update(at);
      await flush();
      for (let i = 0; i < 40 && w.fake.pending.length > 0; i++) { w.settle(pick(w.fake.pending.length)); await flush(); }
    }
    await settleAll(w, 77);
    expect(w.fake.violations).toEqual([]);
    const seen = new Set(w.fake.stages.map((s) => `${s.cx},${s.cz},${s.seq}`));
    expect(seen.size).toBe(w.fake.stages.length);
    expect(new Set(w.fake.stages.map((s) => colKey(s.cx, s.cz))).size).toBe(w.fake.stages.length);
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
  const done = (cx: number, cz: number, versions: Int32Array | null): ColumnDone => ({ cx, cz, ms: 3, versions });
  const lightVersions = Int32Array.from({ length: 18 }, (_, i) => i + 1);
  const payload = { cx: 4, cz: 5, versions: Int32Array.from({ length: 18 }, (_, i) => 100 + i) } as unknown as ColumnMeshPayload;
  const calls: string[] = [];
  let live = 3;
  const pool = {
    terrain: (cx: number, cz: number, protoOnly?: boolean) => { calls.push(`terrain ${cx} ${cz} ${String(protoOnly)}`); return Promise.resolve(done(cx, cz, null)); },
    decorate: (cx: number, cz: number) => { calls.push(`decorate ${cx} ${cz}`); return Promise.resolve(done(cx, cz, null)); },
    light: (cx: number, cz: number) => { calls.push(`light ${cx} ${cz}`); return Promise.resolve(done(cx, cz, lightVersions)); },
    meshColumn: (cx: number, cz: number) => { calls.push(`meshColumn ${cx} ${cz}`); return Promise.resolve(payload); },
    cancelWorld: (pred: (stage: Stage, cx: number, cz: number) => boolean) => { calls.push(`cancelWorld ${String(pred('T', 0, 0))}`); },
    liveWorkers: () => live,
  } as unknown as WorkerPool;

  test('T, D, L and MESH map to terrain, decorate, light and meshColumn', async () => {
    calls.length = 0;
    const jobs = worldJobsOf(pool);
    expect(await jobs.run('T', 1, -2, false)).toEqual({ versions: null, payload: null });
    expect(await jobs.run('D', 1, -2, false)).toEqual({ versions: null, payload: null });
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
    expect(await worldJobsOf(pool).run('T', 3, 4, true)).toEqual({ versions: null, payload: null });
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

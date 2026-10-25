/**
 * The real coordinator and pool against `genRegion` through Apply v1 (SP4c spec §8.5, §4.2-§4.6; D5, D7): two Node
 * workers (`buildNodeTaskWorker('apply')`) on one shared store, seed '42', the default profile, RD 4 around seed 42's
 * spawn column (0, 0), as `integration/streaming.test.ts`; plus the world's Apply path as the page wires it at the
 * reveal: the real `WorldSession` (`openMapSession`), the real configure driver over a replaying canvas with no preview
 * wanted (the world before the first M: it adopts the first configure and is fed every session change, as the page's
 * `followSession`, inlined without its `toolMounted()` guard to keep DOM imports out of Node, as `apply.metric.ts`), the
 * real apply control and `createEpochs`, on the real clock. Every proto is kept (the page's setting); strict until the
 * first fill, `setStrict(false)` after it. A frame is the page's: `tick`, one `update`, the counts and the aux policy
 * with the map hidden, the store's drain and one turn of the event loop.
 *
 * The recording sink stages and shows at once, so its `unstage` returns false (the payload is already shown, spec
 * §4.4); a column is staged at most once per applied epoch (`coordinator.counts(out).epoch` at its `stage`: SP4b's
 * "staged twice" check, per epoch), and every payload passes `payloadProblem`.
 *
 * Each check settles the world (the applied epoch, `stale` 0, `firstFill`) and compares the 7 × 7 window centred on the
 * spawn column (inside the RD 4 MESH disc) with `genRegion`'s `litRegionHash` at upTo 'L' on the session's params:
 * the first fill; a terrain Apply (`density.detailAmpHi` 4.0); its undo; an undo in the middle of a regeneration (a
 * second Apply of 4.0, undone after the first ⌈69 / 4⌉ = 18 swaps: the columns re-staged after the undo's Apply are
 * exactly those swapped to 4.0, the others keep their original mesh, D5); a climate Apply (`climate.C`'s wavelength
 * 2400 → 600, which changes the window); a biome-table climate limit (`meadow`'s lower temperature bound −0.2 → 0,
 * which changes it too); D7 on the real store (one D's OK reply held after it committed, a configure adopted with the
 * same genKey, then the reply delivered: the column is Decorated, no D is issued for it again, and its L runs and
 * succeeds); and after unloading everything and draining the limbo, every pool slot is free.
 */
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import type { Params } from '../../src/core/params/schema';
import {
  createCoordinator, createCoordinatorCounts, worldJobsOf, type Coordinator, type CoordinatorJobs, type StreamCamera,
  type StreamEvent, type StreamStore,
} from '../../src/engine/coordinator';
import { appliedDraftOf, type WorldStage } from '../../src/engine/invalidation';
import { stageOffsets, type Stage } from '../../src/engine/rings';
import { createThrottle } from '../../src/engine/throttle';
import { createWorkerPool, type WorkerLike, type WorkerPool } from '../../src/engine/workerPool';
import { payloadProblem } from '../../src/mesh/column';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { createPreviewDriver, createReplayingCanvas, draftOf, type DriverClock, type PreviewDriver } from '../../src/ui/map/previewDriver';
import { createApplyControl, createEpochs, updateAuxPolicy, type ApplyControl } from '../../src/ui/world/applyControl';
import { RECLAIM_THREADS } from '../../src/world/store/reclaim';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { buildNodeTaskWorker } from '../harness/nodeWorker';
import { genRegion, litRegionHash } from '../harness/region';

const MiB = 1 << 20;
const RD = 4;
/** The 7 × 7 window centred on the spawn column (0, 0): its corners (±3, ±3) lie inside the RD 4 MESH disc (18 ≤ 20.25). */
const WIN = { cx0: -3, cz0: -3, w: 7, h: 7 } as const;
/** The camera, held at seed 42's spawn column (`uiSmoke.ts`'s `PARITY_VIEW`). */
const CAM: StreamCamera = { x: 0, z: 0, yawDeg: 45 };
/** The MESH disc around the camera's column. */
const MESH_SET: ReadonlySet<number> = new Set(stageOffsets(RD).MESH.map(([dx, dz]) => colKey(dx, dz)));
/** The swaps after which the mid-regeneration undo is made: a quarter of the RD 4 disc, ⌈69 / 4⌉ (spec §8.5). */
const UNDO_AFTER_SWAPS = Math.ceil(MESH_SET.size / 4);
/** The leaf of the terrain Apply and its value (spec §8.5); 1.5 is the default profile's. */
const AMP = 'density.detailAmpHi';
const AMP_APPLIED = 4.0;
/** One frame's turn of the event loop, in ms. */
const FRAME_MS = 2;
/** A leg that has not settled after this long fails. */
const SETTLE_MS = 60_000;

const workers: Worker[] = [];
let script = '';

/** A reply of a worker that the hold may keep back, with its delivery. */
interface Held {
  readonly cx: number;
  readonly cz: number;
  /** The job's configure generation. */
  readonly epoch: number;
  deliver(): void;
}

/**
 * The D7 hold (spec §4.6, §8.5): while `armed` is set, the first OK `decorate` reply of a column it accepts is kept
 * back (the worker committed the D before replying) until `held.deliver()`; every other message passes in order.
 */
const hold: { armed: ((cx: number, cz: number) => boolean) | null; held: Held | null } = { armed: null, held: null };

/** A worker_threads Worker behind the browser Worker's surface that the pool uses, its replies through the hold. */
function spawnNode(): WorkerLike {
  const w = new Worker(script);
  workers.push(w);
  const like: WorkerLike = {
    postMessage: (msg, transfer) => { w.postMessage(msg, transfer as never); },
    onmessage: null,
    onerror: null,
    terminate: () => { void w.terminate(); },
  };
  w.on('message', (data: unknown) => {
    const m = data as { type?: unknown; job?: unknown; cx?: unknown; cz?: unknown; epoch?: unknown };
    const armed = hold.armed;
    if (armed !== null && hold.held === null && m.type === 'columnDone' && m.job === 'decorate' && armed(m.cx as number, m.cz as number)) {
      hold.armed = null;
      hold.held = { cx: m.cx as number, cz: m.cz as number, epoch: m.epoch as number, deliver: () => like.onmessage?.({ data }) };
      return;
    }
    like.onmessage?.({ data });
  });
  w.on('error', (e: unknown) => like.onerror?.(e));
  return like;
}

/** The driver's clock on real time (the watchdog's timers by id). */
function realClock(): DriverClock & { clearAll(): void } {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  return {
    now: () => performance.now(),
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, ms));
      return id;
    },
    clearTimeout(id) {
      const t = timers.get(id);
      if (t !== undefined) clearTimeout(t);
      timers.delete(id);
    },
    clearAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

/** One world job the coordinator issued, in issue order, and how it settled. */
interface Issued {
  readonly stage: Stage;
  readonly cx: number;
  readonly cz: number;
  /** 'ok' with the outcome's generation, 'rejected', or null while in flight. */
  settled: 'ok' | 'rejected' | null;
  generation: number;
}

/** The world under test, built in `beforeAll` and wired at the reveal by the first case. */
interface World {
  readonly store: VoxelStore;
  readonly pool: WorkerPool;
  readonly coordinator: Coordinator;
  readonly session: ReturnType<typeof openMapSession>;
  readonly clock: ReturnType<typeof realClock>;
  readonly firstReady: Awaited<ReturnType<WorkerPool['configure']>>;
  driver: PreviewDriver | null;
  control: ApplyControl | null;
  offSession: (() => void) | null;
}

let world: World | null = null;
const events: StreamEvent[] = [];
const problems: string[] = [];
const issued: Issued[] = [];
let inFlight = 0;
/** Per live column (colKey), the applied epoch its last payload was staged at. */
const live = new Map<number, number>();
/** Stages of a column the sink already held (swaps), since the last Apply. */
let swapsSinceApply = 0;
/** The columns staged since the last Apply. */
const stagedSinceApply = new Set<number>();
/** The columns the coordinator freed since the last Apply. */
const freedSinceApply = new Set<number>();
/** The coordinator's Applies and adopts, in order, through the apply control. */
const applies: Array<{ readonly epoch: number; readonly generation: number; readonly from: WorldStage }> = [];
const adopts: number[] = [];
/** Called inside each Apply, before the coordinator hears of it. */
let onApply: (() => void) | null = null;
const counts = createCoordinatorCounts();
const stageCounts = createCoordinatorCounts();

const W = (): World => {
  if (world === null) throw new Error('the world was not built');
  return world;
};

const fatal = (): string | null => {
  const e = events[0];
  if (e === undefined) return null;
  return e.kind === 'fatal' ? `fatal: ${e.message}` : e.kind === 'skipped' ? `skipped (${e.cx}, ${e.cz})` : `storeFull (lower to ${e.lowerRd})`;
};

/** One frame (the page's order): the apply control's tick, the update, the counts and the aux policy, the drain. */
async function frame(): Promise<void> {
  const w = W();
  w.control?.tick();
  w.coordinator.update(CAM);
  w.coordinator.counts(counts);
  if (w.control !== null) updateAuxPolicy(w.pool, w.control.generation, false, counts);
  w.store.drain();
  await new Promise((r) => setTimeout(r, FRAME_MS));
}

/** Frames until `done()`, failing on any coordinator event or after `ms`. */
async function until(done: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await frame();
    const f = fatal();
    if (f !== null) throw new Error(`${what}: ${f}`);
    if (done()) return;
    if (Date.now() > end) throw new Error(`${what}: not done after ${ms} ms`);
  }
}

/** The world settled at `epoch`: applied, no stale MESH-set column, every MESH-set column meshed. */
function settledAt(epoch: number): boolean {
  W().coordinator.counts(counts);
  return counts.epoch === epoch && counts.stale === 0 && W().coordinator.firstFill();
}

/** The session's edit, then frames until its Apply came and the world settled at its epoch. */
async function applyEdit(edit: () => void, what: string): Promise<number> {
  const n = applies.length;
  edit();
  await until(() => applies.length === n + 1 && settledAt(applies[n]!.epoch), SETTLE_MS, what);
  expect(applies.length, `${what}: one Apply`).toBe(n + 1);
  return applies[n]!.epoch;
}

function windowHash(): string {
  const { store } = W();
  store.enterRead();
  try {
    return litRegionHash(store, WIN.cx0, WIN.cz0, WIN.w, WIN.h);
  } finally {
    store.exitRead();
  }
}

/** `genRegion`'s lit hash of the window on `params`, by the params' JSON. */
const expectedByParams = new Map<string, string>();
async function expected(params: Params): Promise<string> {
  const key = JSON.stringify(params);
  const hit = expectedByParams.get(key);
  if (hit !== undefined) return hit;
  const ref = await genRegion({ seed: '42', params, ...WIN, upTo: 'L', order: 'spiral', threads: 1 });
  const h = ref.view.litHash();
  expectedByParams.set(key, h);
  return h;
}

/** Every MESH-set column was meshed again since the last Apply (every column was stale: the world was rebuilt). */
function regenerated(what: string): void {
  const missing = [...MESH_SET].filter((k) => !stagedSinceApply.has(k)).map((k) => [colKeyCx(k), colKeyCz(k)]);
  expect(missing, `${what}: MESH-set columns not meshed again`).toEqual([]);
}

/** Nothing went wrong so far: no event, no sink problem, no failed or skipped column. */
function clean(what: string): void {
  W().coordinator.counts(counts);
  expect(events, `${what}: coordinator events`).toEqual([]);
  expect(problems, `${what}: sink problems`).toEqual([]);
  expect([counts.failed, counts.storeFull], `${what}: failed columns, StoreFull errors`).toEqual([0, 0]);
}

beforeAll(async () => {
  script = await buildNodeTaskWorker('apply');
  const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
  const pool = createWorkerPool(2, spawnNode, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  await pool.attachStore(store.handles());
  // The page's session (seed 42, the default profile) and its first configure (spec §4.2).
  const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
  const firstReady = await pool.configure(session.state.seedText, session.state.params);
  const inner = worldJobsOf(pool);
  const jobs: CoordinatorJobs = {
    run(stage, cx, cz, protoOnly) {
      const rec: Issued = { stage, cx, cz, settled: null, generation: -1 };
      issued.push(rec);
      inFlight++;
      const job = inner.run(stage, cx, cz, protoOnly);
      job.then((out) => { rec.settled = 'ok'; rec.generation = out.generation; inFlight--; }, () => { rec.settled = 'rejected'; inFlight--; });
      return job;
    },
    cancel: (pred) => inner.cancel(pred),
    liveWorkers: () => inner.liveWorkers(),
    generation: () => inner.generation(),
  };
  const streamStore: StreamStore = {
    versionsInto: (cx, cz, out) => store.versionsInto(cx, cz, out),
    holder: (cx, cz) => store.holder(cx, cz),
    freeColumn(cx, cz) {
      freedSinceApply.add(colKey(cx, cz));
      store.freeColumn(cx, cz);
    },
    freeProto: (cx, cz) => store.freeProto(cx, cz),
  };
  const coordinator: Coordinator = createCoordinator({
    jobs,
    store: streamStore,
    sink: {
      stage(p, seq) {
        void seq;
        const epoch = coordinator.counts(stageCounts).epoch;
        const k = colKey(p.cx, p.cz);
        const problem = payloadProblem(p);
        if (problem !== null) problems.push(`(${p.cx}, ${p.cz}): ${problem}`);
        const was = live.get(k);
        if (was === epoch) problems.push(`(${p.cx}, ${p.cz}) staged twice at epoch ${epoch}`);
        if (was !== undefined) swapsSinceApply++;
        stagedSinceApply.add(k);
        live.set(k, epoch);
      },
      // Staged payloads are shown at once: nothing is ever pending to drop (spec §4.4: false, already shown).
      unstage: () => false,
      remove(cx, cz) {
        if (!live.delete(colKey(cx, cz))) problems.push(`(${cx}, ${cz}) removed while not live`);
      },
    },
    // Two workers: max(1, N − 1) = 1 (SP4b spec §3.8); nothing feeds it, as on the page.
    throttle: createThrottle({ max: 1 }),
    rd: RD,
    rdMax: RD,
    retainAllProtos: true,
    strict: true,
    generation: pool.epoch,
    epoch: 1,
    onEvent: (e) => { events.push(e); },
  });
  world = { store, pool, coordinator, session, clock: realClock(), firstReady, driver: null, control: null, offSession: null };
}, 120_000);

afterAll(async () => {
  const w = world;
  if (w !== null) {
    w.control?.dispose();
    w.offSession?.();
    w.driver?.dispose();
    w.coordinator.dispose();
    w.clock.clearAll();
    w.pool.terminate();
  }
  await Promise.all(workers.map((x) => x.terminate()));
});

describe('Apply v1 on the real store (SP4c spec §8.5)', () => {
  test('after the first fill, the inner region equals genRegion', async () => {
    const w = W();
    expect(w.firstReady.type).toBe('ready');
    await until(() => w.coordinator.firstFill(), SETTLE_MS, 'the first fill');
    w.coordinator.setStrict(false);
    expect(windowHash()).toBe(await expected(w.session.state.params));
    clean('the first fill');

    // The world's configure owner and apply control from the reveal on (spec §4.2-§4.3), as the page wires them.
    const epochs = createEpochs();
    expect(epochs.of(w.firstReady.genKey), 'the first draft\'s epoch').toBe(1);
    const driver = createPreviewDriver(w.pool, createReplayingCanvas(), w.clock, { spawnPriority: 600 });
    w.driver = driver;
    driver.setPreviewWanted(false);
    driver.adopt({ poolEpoch: w.pool.epoch, sessionEpoch: w.session.state.epoch, seedKey: draftOf(w.session.state).seedKey, ready: w.firstReady });
    // The page's `followSession` before the first M: every session change goes to the driver.
    w.offSession = w.session.subscribe((s, change) => driver.change(draftOf(s), change, w.clock.now()));
    w.control = createApplyControl({
      coordinator: {
        apply(a) {
          applies.push(a);
          onApply?.();
          swapsSinceApply = 0;
          stagedSinceApply.clear();
          freedSinceApply.clear();
          w.coordinator.apply(a);
        },
        adopt(g) {
          adopts.push(g);
          w.coordinator.adopt(g);
        },
      },
      driver,
      session: w.session,
      pool: w.pool,
      clock: w.clock,
      epochs,
      initial: appliedDraftOf(draftOf(w.session.state).seedKey, w.firstReady),
      initialGeneration: w.pool.epoch,
      beforeApply: () => true,
      onApplied: () => {},
    });
  });

  test('a terrain Apply (density.detailAmpHi 4.0) through the real driver and apply control: equal on the new params', async () => {
    const w = W();
    const original = await expected(w.session.state.params);
    const epoch = await applyEdit(() => { expect(w.session.set(AMP, AMP_APPLIED).ok).toBe(true); }, 'the terrain Apply');
    expect([epoch, applies[0]!.from]).toEqual([2, 'T']);
    regenerated('the terrain Apply');
    const hash = windowHash();
    expect(hash).toBe(await expected(w.session.state.params));
    expect(hash, 'the terrain Apply changes the window').not.toBe(original);
    clean('the terrain Apply');
  });

  test('its undo: equal on the original', async () => {
    const w = W();
    const epoch = await applyEdit(() => { expect(w.session.undo()).toBe(true); }, 'the undo');
    expect(epoch).toBe(1);
    regenerated('the undo');
    expect(w.session.state.params.density.detailAmpHi).toBe(1.5);
    expect(windowHash()).toBe(await expected(w.session.state.params));
    clean('the undo');
  });

  test('an undo in the middle of a regeneration: equal on the original, the unswapped columns keep their mesh', async () => {
    const w = W();
    const n = applies.length;
    expect(w.session.set(AMP, AMP_APPLIED).ok).toBe(true);
    await until(() => applies.length === n + 1 && swapsSinceApply >= UNDO_AFTER_SWAPS, SETTLE_MS, 'the second Apply\'s first swaps');
    expect(applies[n]!.epoch, 'the second Apply of 4.0 interns the first one\'s epoch').toBe(2);
    // At the undo's Apply (the world holds from the undo's configure; MESH results in flight may still land at 2): the
    // columns swapped to 2 and those still showing their original mesh.
    let swapped: number[] = [];
    let freed = 0;
    onApply = () => {
      swapped = [...live].filter(([k, e]) => e === 2 && MESH_SET.has(k)).map(([k]) => k).sort((a, b) => a - b);
      freed = [...freedSinceApply].filter((k) => MESH_SET.has(k)).length;
    };
    const epoch = await applyEdit(() => { expect(w.session.undo()).toBe(true); }, 'the mid-regeneration undo');
    onApply = null;
    expect(epoch).toBe(1);
    expect(swapped.length, 'columns swapped to 2 at the undo').toBeGreaterThanOrEqual(UNDO_AFTER_SWAPS);
    expect(swapped.length, 'MESH-set columns still showing their original mesh at the undo').toBeLessThan(MESH_SET.size);
    expect(freed, 'MESH-set columns freed at the undo').toBeGreaterThan(swapped.length);
    // D5: only the columns swapped to 2 are meshed again; every other column keeps its original mesh.
    const restaged = [...stagedSinceApply].sort((a, b) => a - b);
    expect(restaged.map((k) => [colKeyCx(k), colKeyCz(k)])).toEqual(swapped.map((k) => [colKeyCx(k), colKeyCz(k)]));
    expect(windowHash()).toBe(await expected(w.session.state.params));
    clean('the mid-regeneration undo');
  });

  test('a climate Apply (climate.C\'s wavelength 2400 → 600): equal on its params, and the window changed', async () => {
    const w = W();
    expect(w.session.state.params.climate.C.wavelength).toBe(2400);
    const before = windowHash();
    // 600 moves C enough in this window to change its voxels (1200, 800 and 4800 do not: the window lies deep inland
    // under them, where the offset spline and the biome boxes do not tell them apart; final review GOV-2).
    await applyEdit(() => { expect(w.session.set('climate.C', { wavelength: 600 }).ok).toBe(true); }, 'the climate Apply');
    regenerated('the climate Apply');
    const hash = windowHash();
    expect(hash).toBe(await expected(w.session.state.params));
    expect(hash, 'the climate Apply changes the window').not.toBe(before);
    clean('the climate Apply');
  });

  test('a biome-table climate limit (meadow\'s lower temperature bound −0.2 → 0): equal on its params', async () => {
    const w = W();
    const table = w.session.state.params.biomes.table;
    expect(table.meadow.T).toEqual([-0.2, 0.2]);
    const before = windowHash();
    // The window is meadow at T about −0.11 … 0.01: its colder part turns to taiga and plains.
    await applyEdit(() => {
      expect(w.session.set('biomes.table', { ...table, meadow: { ...table.meadow, T: [0, 0.2] } }).ok).toBe(true);
    }, 'the biome-table Apply');
    regenerated('the biome-table Apply');
    const hash = windowHash();
    expect(hash).toBe(await expected(w.session.state.params));
    expect(hash, 'the biome-table Apply changes the window').not.toBe(before);
    clean('the biome-table Apply');
  });

  test('D7: a D\'s OK reply held past an adopted configure is recorded as Decorated, and its L runs and succeeds', async () => {
    const w = W();
    const control = w.control!;
    // The undo of the biome-table edit regenerates the disc; the first D reply of a MESH-set column is held.
    hold.armed = (cx, cz) => MESH_SET.has(colKey(cx, cz));
    const n = applies.length;
    expect(w.session.undo()).toBe(true);
    await until(() => hold.held !== null, SETTLE_MS, 'a D reply held');
    const held = hold.held!;
    expect(applies.length, 'the held D ran under the undo\'s Apply').toBe(n + 1);
    const epoch = applies[n]!.epoch;
    expect(held.epoch).toBe(applies[n]!.generation);

    // A configure with the same genKey (a no-op gesture), adopted while the reply is held.
    const genKey = control.applied.genKey;
    const adoptsBefore = adopts.length;
    const amp = w.session.state.params.density.detailAmpHi;
    w.session.beginGesture();
    expect(w.session.set(AMP, amp + 0.5).ok).toBe(true);
    expect(w.session.set(AMP, amp).ok).toBe(true);
    w.session.endGesture();
    await until(() => adopts.length === adoptsBefore + 1, SETTLE_MS, 'the adopt');
    expect(applies.length, 'the no-op gesture applies nothing').toBe(n + 1);
    expect(control.applied.genKey).toBe(genKey);
    expect(control.generation).toBe(w.pool.epoch);
    expect(w.pool.epoch, 'the pool\'s generation moved past the held D\'s').toBeGreaterThan(held.epoch);
    const heldD = issued.find((j) => j.stage === 'D' && j.cx === held.cx && j.cz === held.cz && j.settled === null);
    expect(heldD, 'the held D is in flight').toBeDefined();

    // The reply is delivered: the D resolves with its own generation, the column is Decorated (no D again), its L runs.
    const mark = issued.length;
    hold.held = null;
    held.deliver();
    await until(() => settledAt(epoch), SETTLE_MS, 'the regeneration after the held D');
    expect([heldD!.settled, heldD!.generation]).toEqual(['ok', held.epoch]);
    const after = issued.slice(mark).filter((j) => j.cx === held.cx && j.cz === held.cz);
    expect(after.filter((j) => j.stage === 'D'), `a D issued again for (${held.cx}, ${held.cz})`).toEqual([]);
    const l = after.filter((j) => j.stage === 'L');
    expect(l.length, `L jobs of (${held.cx}, ${held.cz}) after the delivery`).toBeGreaterThanOrEqual(1);
    expect(l.at(-1)!.settled).toBe('ok');
    expect(w.coordinator.isSkipped(held.cx, held.cz)).toBe(false);
    expect(windowHash()).toBe(await expected(w.session.state.params));
    clean('D7');
  });

  test('after unloading everything and draining the limbo, every pool slot is free', async () => {
    const w = W();
    w.control?.dispose();
    w.offSession?.();
    w.driver?.dispose();
    w.control = null;
    w.offSession = null;
    w.driver = null;
    w.coordinator.dispose();
    const { store } = w;
    const settleEnd = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < settleEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(inFlight, 'world jobs still in flight after dispose').toBe(0);
    const limbo = (): number[] => Array.from({ length: RECLAIM_THREADS }, (_, t) => store.limboCount(t));
    const limboEnd = Date.now() + 5000;
    while (limbo().some((x) => x > 0) && Date.now() < limboEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(limbo()).toEqual(new Array(RECLAIM_THREADS).fill(0));
    expect([store.blockPool.freeCount(), store.bytePool.freeCount()]).toEqual([store.blockPool.slotCount(), store.bytePool.slotCount()]);
    expect(problems).toEqual([]);
    expect(events).toEqual([]);
  });
});

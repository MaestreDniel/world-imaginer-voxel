/**
 * Edits on the real pipeline against `genRegion` with the same entries (SP5a spec §6.3; Review Focus 2 and 5): the
 * real coordinator and pool on two Node workers (`buildNodeTaskWorker('edit')`) and the sim's own handler in a third
 * (`buildNodeTaskWorker('edit-sim', …)`: `createMemorySimHandler` with its 100 ms drain, posting through the wrapper's
 * `post` as `sim.worker.ts` does, SP5b D18, so the sim's message guard, transfers and limbo retries run on a real
 * thread), wrapped as a `SimWorkerLike` for `createSimClient` and attached as thread 15; one shared store, seed '42',
 * the default profile, RD 4 around seed 42's spawn column (0, 0), as `integration/apply.test.ts`. The page's edit
 * wiring: D reads the sim's entries through (`worldJobsOf(pool, sim)`), every edit goes through the edit path
 * (`createEditPath`: its gate, pins and `markEdited`) and the action post that
 * records each accepted one in the block history (`createActionPost`, `createBlockHistory`), and the world's Apply path
 * (the real configure driver with no preview wanted, the apply control and `createEpochs`), on the real clock. Every
 * proto is kept; strict until the first fill, `setStrict(false)` after it. A frame is the page's: the apply control's
 * tick, one `update`, the counts and the aux policy with the map hidden, the store's drain and one turn of the event loop.
 *
 * Each check compares the 7 × 7 window centred on the spawn column (inside the RD 4 MESH disc) with `genRegion`'s
 * `litRegionHash` at upTo 'L' on 1 thread, with the sim's entries as its `diff` (the sim's `diff` replies over the
 * window grown by one ring, D's set); those entries are first checked against the test's own record of each edited
 * voxel's latest value (an entry exactly where that value differs from the proto's). The cases, in order: 50 edits of
 * every kind (stone, glass, ice, torch, wall torch, ladder, waterlogged ladder, water, lava, breaks; a quarter on a
 * column border; the first one's stone broken again by the 46th, which leaves no entry, rulings R27) after the fill;
 * a terrain Apply (`density.detailAmpHi` 4.0), with the same entries; undo of all 50 through the block history, after
 * which the DiffStore is empty and the window equals `genRegion` on the Apply's params with no diff; a saved world's
 * round trip through the sim's worker (SP5b spec §6.3): `load` of an empty world, 20 edits, a `flush`, the handler
 * renewed in the same worker (the wrapper's harness-only `__renew`, `renew: true`, over the same in-worker `MemoryKV`),
 * `attach` and `load` again, which give back the same entries, then one more edit and a `flush` of a history that shares
 * the first one's steps (the client posts it whole after its `load`, rulings R9); and, after one more edit answered
 * while a main-thread read section holds its retired slots in thread 15's limbo (freed by the sim's own retries once the
 * section closes), the sim stopped before the world (rulings R35), then everything unloaded and the limbo drained, every
 * pool slot is free.
 */
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import type { Params } from '../../src/core/params/schema';
import {
  createCoordinator, createCoordinatorCounts, worldJobsOf, type Coordinator, type CoordinatorJobs, type StreamCamera,
  type StreamEvent,
} from '../../src/engine/coordinator';
import { appliedDraftOf } from '../../src/engine/invalidation';
import { createSimClient, type SimClient, type SimWorkerLike } from '../../src/engine/simClient';
import { createThrottle } from '../../src/engine/throttle';
import { createWorkerPool, type WorkerLike, type WorkerPool } from '../../src/engine/workerPool';
import { payloadProblem } from '../../src/mesh/column';
import { todayStateTable, type HistoryRecord, type StateRecord } from '../../src/persist/saves';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { createPreviewDriver, createReplayingCanvas, draftOf, type DriverClock, type PreviewDriver } from '../../src/ui/map/previewDriver';
import { createApplyControl, createEpochs, updateAuxPolicy, type ApplyControl } from '../../src/ui/world/applyControl';
import { createActionPost, createBlockHistory, type BlockHistory } from '../../src/ui/world/blockHistory';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createEditPath, type EditOutcome, type EditPath } from '../../src/ui/world/editPath';
import type { Edit, FlushedMsg } from '../../src/workers/protocol';
import { SIM_DRAIN_MS } from '../../src/workers/simHandler';
import { LAVA_SOURCE, NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, GLASS, ICE, REGISTRY, STONE, TORCH } from '../../src/world/blocks/index';
import type { ColumnDiff } from '../../src/world/store/api';
import { RECLAIM_THREADS, SIM_THREAD } from '../../src/world/store/reclaim';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { buildNodeTaskWorker } from '../harness/nodeWorker';
import { genRegion, litRegionHash } from '../harness/region';
import { testRng } from '../harness/stats';

const MiB = 1 << 20;
const RD = 4;
/** The 7 × 7 window centred on the spawn column (0, 0): its corners (±3, ±3) lie inside the RD 4 MESH disc. */
const WIN = { cx0: -3, cz0: -3, w: 7, h: 7 } as const;
/** D's set of `genRegion` upTo 'L' over the window: the window grown by one ring, where the entries are read. */
const D_SET = { cx0: WIN.cx0 - 1, cz0: WIN.cz0 - 1, w: WIN.w + 2, h: WIN.h + 2 } as const;
/** The camera, held at seed 42's spawn column. */
const CAM: StreamCamera = { x: 0, z: 0, yawDeg: 45 };
/** The leaf of the terrain Apply and its value (spec §6.3); 1.5 is the default profile's. */
const AMP = 'density.detailAmpHi';
const AMP_APPLIED = 4.0;
const EDITS = 50;
/** The edit that breaks the first edit's stone again (rulings R27: the break restores the generated air, no entry). */
const BREAK_AGAIN = 45;
/** One frame's turn of the event loop, in ms. */
const FRAME_MS = 2;
/** A leg that has not settled after this long fails. */
const SETTLE_MS = 60_000;

const val = (state: number, fluid = NO_FLUID): number => ((state << 8) | fluid) >>> 0;
const facings = (type: string): number[] => ['north', 'south', 'east', 'west'].map((f) => REGISTRY.parseStateKey(`${type}[facing=${f}]`));
const WALL_TORCHES = facings('wall_torch');
const LADDERS = facings('ladder');

const threads: Worker[] = [];
let poolScript = '';
let simScript = '';
/** The sim's raw thread, which the round trip's `__renew` goes to. */
let simThread: Worker | null = null;
/** The round trip's `__renew` waiting for its `renewed`. */
let renewWait: ((ok: boolean) => void) | null = null;

/**
 * A worker_threads Worker behind the browser Worker's surface (the pool's `WorkerLike`, the sim's `SimWorkerLike`),
 * with the raw `Worker` as `raw`. A `renewed` (the reply to the harness-only `__renew`) settles the round trip's wait
 * and is not forwarded: the client's guard would refuse its type and fail the sim.
 */
function spawnNode(script: string): WorkerLike & SimWorkerLike & { readonly raw: Worker } {
  const w = new Worker(script);
  threads.push(w);
  const like: WorkerLike & SimWorkerLike & { readonly raw: Worker } = {
    postMessage: (msg, transfer) => { w.postMessage(msg, transfer as never); },
    onmessage: null,
    onerror: null,
    terminate: () => { void w.terminate(); },
    raw: w,
  };
  w.on('message', (data: unknown) => {
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'renewed') {
      const wait = renewWait;
      renewWait = null;
      if (wait === null) problems.push('a `renewed` with no `__renew` waiting');
      else wait((data as { ok?: unknown }).ok === true);
      return;
    }
    like.onmessage?.({ data });
  });
  w.on('error', (e: unknown) => like.onerror?.(e));
  return like;
}

/**
 * Renews the sim's handler in its worker (`__renew`), retrying every `SIM_DRAIN_MS` while its limbo holds entries;
 * the caller has nothing outstanding and runs no frame until the client's `attach` and `load` are posted.
 */
async function renewSim(): Promise<void> {
  const w = simThread;
  if (w === null) throw new Error('no sim thread');
  for (let attempt = 0; attempt < 50; attempt++) {
    const ok = await new Promise<boolean>((resolve) => {
      renewWait = resolve;
      w.postMessage({ type: '__renew' });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, SIM_DRAIN_MS));
  }
  throw new Error('the sim\'s limbo did not drain for the renew');
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

/** The world under test, built in `beforeAll`; its Apply path is wired at the reveal by the first case. */
interface World {
  readonly store: VoxelStore;
  readonly pool: WorkerPool;
  readonly sim: SimClient;
  readonly coordinator: Coordinator;
  readonly editPath: EditPath;
  readonly history: BlockHistory;
  readonly actionPost: (edits: readonly Edit[]) => Promise<EditOutcome>;
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
/** The notices the edit path and the block history showed, in order. */
const notices: string[] = [];
let simFailure: Error | null = null;
let inFlight = 0;
/** The live columns (colKeys) the sink holds. */
const live = new Set<number>();
/** The coordinator's Applies, in order, through the apply control. */
const applies: Array<{ readonly epoch: number; readonly generation: number }> = [];
const counts = createCoordinatorCounts();
/** Each edited voxel's latest accepted value ("x,y,z" → `state << 8 | fluid`), the test's own record of the edits. */
const latest = new Map<string, number>();
/** The sim's entries after the edits, as `x,y,z=value` lines, which the Apply must keep. */
let entriesAfterEdits: string[] = [];

const W = (): World => {
  if (world === null) throw new Error('the world was not built');
  return world;
};

/** `fn` inside a main-thread read section, as the page reads the store. */
function reading<T>(fn: (s: VoxelStore) => T): T {
  const { store } = W();
  store.enterRead();
  try {
    return fn(store);
  } finally {
    store.exitRead();
  }
}

const valueAt = (x: number, y: number, z: number): number => reading((s) => val(s.blockAt(x, y, z), s.fluidAt(x, y, z)));

const fatal = (): string | null => {
  if (simFailure !== null) return `the sim failed: ${simFailure.message}`;
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

/** Frames until `done()`, failing on any coordinator event, the sim's failure, or after `ms`. */
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

/** Frames until `p` settles; its value. */
async function settle<T>(p: Promise<T>, what: string): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await until(() => done, SETTLE_MS, what);
  return p;
}

/** The world settled at `epoch`: applied, no stale MESH-set column, every MESH-set column meshed. */
function settledAt(epoch: number): boolean {
  W().coordinator.counts(counts);
  return counts.epoch === epoch && counts.stale === 0 && W().coordinator.firstFill();
}

const windowHash = (): string => reading((s) => litRegionHash(s, WIN.cx0, WIN.cz0, WIN.w, WIN.h));

/** The sim's entries over D's set, by colKey (through its `diff` replies), and as sorted `x,y,z=value` lines. */
async function simEntries(): Promise<{ readonly diff: Map<number, ColumnDiff>; readonly lines: string[] }> {
  const { sim } = W();
  const asks: Array<Promise<[number, number, ColumnDiff | null]>> = [];
  for (let cz = D_SET.cz0; cz < D_SET.cz0 + D_SET.h; cz++) {
    for (let cx = D_SET.cx0; cx < D_SET.cx0 + D_SET.w; cx++) asks.push(sim.diff(cx, cz).then((d) => [cx, cz, d]));
  }
  const diff = new Map<number, ColumnDiff>();
  const lines: string[] = [];
  for (const [cx, cz, d] of await settle(Promise.all(asks), 'the sim\'s diff replies')) {
    if (d === null) continue;
    diff.set(colKey(cx, cz), d);
    for (let k = 0; k < d.sy.length; k++) {
      const i = d.idx[k]!;
      lines.push(`${16 * cx + (i & 15)},${16 * d.sy[k]! - 64 + (i >> 8)},${16 * cz + ((i >> 4) & 15)}=${d.value[k]!}`);
    }
  }
  return { diff, lines: lines.sort() };
}

/** The entries the record implies: each edited voxel whose latest value differs from its column's proto (D20). */
const recordedEntries = (): string[] => reading((s) => {
  const out: string[] = [];
  for (const [k, v] of latest) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    const p = s.proto(x >> 4, z >> 4);
    if (p === null) throw new Error(`(${x}, ${y}, ${z}): no proto`);
    if (val(p.block(x & 15, y, z & 15), p.fluid(x & 15, y, z & 15)) !== v) out.push(`${k}=${v}`);
  }
  return out.sort();
});

/** `genRegion`'s lit hash of the window on `params` with `diff` (none: `undefined`), on 1 thread. */
async function expected(params: Params, diff: ReadonlyMap<number, ColumnDiff> | undefined): Promise<string> {
  const ref = await genRegion({ seed: '42', params, ...WIN, upTo: 'L', order: 'spiral', threads: 1, diff });
  return ref.view.litHash();
}

/** Nothing went wrong so far: no event, no sink problem, no notice, no failed or skipped column, the sim alive. */
function clean(what: string): void {
  W().coordinator.counts(counts);
  expect(events, `${what}: coordinator events`).toEqual([]);
  expect(problems, `${what}: sink problems`).toEqual([]);
  expect(simFailure, `${what}: the sim's failure`).toBeNull();
  expect([counts.failed, counts.storeFull], `${what}: failed columns, StoreFull errors`).toEqual([0, 0]);
}

beforeAll(async () => {
  [poolScript, simScript] = await Promise.all([
    buildNodeTaskWorker('edit'),
    buildNodeTaskWorker('edit-sim', { entry: 'src/workers/simHandler.ts', factory: 'createMemorySimHandler', retryMs: SIM_DRAIN_MS, renew: true }),
  ]);
  const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
  const pool = createWorkerPool(2, () => spawnNode(poolScript), { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  await pool.attachStore(store.handles());
  // The page's session (seed 42, the default profile) and its first configure (SP4c spec §4.2).
  const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
  const firstReady = await pool.configure(session.state.seedText, session.state.params);
  // The sim on its own thread, thread 15 of the store (spec §2.1); its failure ends the run.
  const sim = createSimClient(() => {
    const s = spawnNode(simScript);
    simThread = s.raw;
    return s;
  }, { onFailure(e) { simFailure = e; } });
  await sim.attach(store.handles());
  // D reads the sim's entries through (spec §2.5), as the page's `worldJobsOf(workers, simClient)`.
  const inner = worldJobsOf(pool, sim);
  const jobs: CoordinatorJobs = {
    run(stage, cx, cz, protoOnly, edit) {
      inFlight++;
      const job = inner.run(stage, cx, cz, protoOnly, edit);
      job.then(() => { inFlight--; }, () => { inFlight--; });
      return job;
    },
    cancel: (pred) => inner.cancel(pred),
    liveWorkers: () => inner.liveWorkers(),
    generation: () => inner.generation(),
  };
  const coordinator: Coordinator = createCoordinator({
    jobs,
    store,
    sink: {
      // An edit restages a shown column at the same epoch (spec §2.6): every payload is checked, none counted twice.
      stage(p) {
        const problem = payloadProblem(p);
        if (problem !== null) problems.push(`(${p.cx}, ${p.cz}): ${problem}`);
        live.add(colKey(p.cx, p.cz));
      },
      // Staged payloads are shown at once: nothing is ever pending to drop (SP4c spec §4.4: false, already shown).
      unstage: () => false,
      remove(cx, cz) {
        if (!live.delete(colKey(cx, cz))) problems.push(`(${cx}, ${cz}) removed while not live`);
      },
    },
    // Two workers: max(1, N − 1) = 1 (SP4b spec §3.8).
    throttle: createThrottle({ max: 1 }),
    rd: RD,
    rdMax: RD,
    retainAllProtos: true,
    strict: true,
    generation: pool.epoch,
    epoch: 1,
    onEvent: (e) => { events.push(e); },
  });
  const show = { show: (text: string) => { notices.push(text); } };
  const editPath = createEditPath({ sim, coordinator, latency: createEditLatency(), now: () => performance.now(), notices: show });
  const history = createBlockHistory({
    post: editPath.post, read: valueAt, pending: editPath.pending, settled: editPath.settled, notices: show,
  });
  const actionPost = createActionPost({ post: editPath.post, record: history.record });
  world = {
    store, pool, sim, coordinator, editPath, history, actionPost, session, clock: realClock(), firstReady,
    driver: null, control: null, offSession: null,
  };
}, 120_000);

afterAll(async () => {
  const w = world;
  if (w !== null) {
    w.sim.dispose();
    w.control?.dispose();
    w.offSession?.();
    w.driver?.dispose();
    w.coordinator.dispose();
    w.clock.clearAll();
    w.pool.terminate();
  }
  await Promise.all(threads.map((x) => x.terminate()));
});

describe('edits on the real store equal genRegion with the same entries (SP5a spec §6.3)', () => {
  test('50 edits of every kind (stone, glass, ice, torch, wall torch, ladder, water, lava, breaks) after the fill: equal to genRegion + entries', async () => {
    const w = W();
    expect(w.firstReady.type).toBe('ready');
    await until(() => w.coordinator.firstFill(), SETTLE_MS, 'the first fill');
    w.coordinator.setStrict(false);
    const filled = windowHash();

    // The world's configure owner and apply control from the reveal on (SP4c spec §4.2-§4.3), as the page wires them.
    const epochs = createEpochs();
    expect(epochs.of(w.firstReady.genKey), 'the first draft\'s epoch').toBe(1);
    const driver = createPreviewDriver(w.pool, createReplayingCanvas(), w.clock, { spawnPriority: 600 });
    w.driver = driver;
    driver.setPreviewWanted(false);
    driver.adopt({ poolEpoch: w.pool.epoch, sessionEpoch: w.session.state.epoch, seedKey: draftOf(w.session.state).seedKey, ready: w.firstReady });
    w.offSession = w.session.subscribe((s, change) => driver.change(draftOf(s), change, w.clock.now()));
    w.control = createApplyControl({
      coordinator: {
        apply(a) {
          applies.push(a);
          w.coordinator.apply(a);
        },
        adopt: (g) => w.coordinator.adopt(g),
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

    // 50 edits near the spawn, one posted per frame while the earlier ones are in flight; every 4th on a column border.
    const KINDS: ReadonlyArray<(n: number) => number> = [
      () => val(STONE), () => val(GLASS), () => val(ICE), () => val(TORCH), (n) => val(WALL_TORCHES[n % 4]!),
      (n) => val(LADDERS[n % 4]!), (n) => val(LADDERS[(n + 1) % 4]!, WATER_SOURCE), () => val(AIR, WATER_SOURCE),
      () => val(AIR, LAVA_SOURCE), () => val(AIR),
    ];
    const next = testRng(0xed17);
    const BORDER = [0, 15];
    const taken = new Set<string>();
    const outcomes: Array<Promise<EditOutcome>> = [];
    const posted: Array<{ readonly x: number; readonly y: number; readonly z: number; readonly value: number }> = [];
    const post = (x: number, y: number, z: number, value: number): void => {
      const e: Edit = { x, y, z, op: 'set', value, expect: valueAt(x, y, z) };
      posted.push({ x, y, z, value });
      outcomes.push(w.actionPost([e]));
    };
    while (posted.length < EDITS) {
      const n = posted.length;
      if (n === BREAK_AGAIN) {
        // The first edit's stone, placed into the air above the surface, broken again once its reply has come.
        const first = posted[0]!;
        expect(await settle(outcomes[0]!, 'the first edit'), 'the first edit').toMatchObject({ ok: true });
        expect(valueAt(first.x, first.y, first.z)).toBe(val(STONE));
        post(first.x, first.y, first.z, val(AIR));
      } else {
        const cx = -2 + (next() % 5);
        const cz = -2 + (next() % 5);
        const lx = n % 4 === 0 ? BORDER[next() % 2]! : next() % 16;
        const lz = n % 8 === 0 ? BORDER[next() % 2]! : next() % 16;
        const x = 16 * cx + lx;
        const z = 16 * cz + lz;
        const value = KINDS[n % KINDS.length]!(n);
        // A place goes into the first air above the surface, a break takes the surface block.
        const s = reading((st) => st.heightAt('worldSurface', x, z))!;
        const y = Math.min(319, value === val(AIR) ? s - 1 : s);
        const key = `${x},${y},${z}`;
        if (taken.has(key)) continue;
        taken.add(key);
        if (n === 0) expect(valueAt(x, y, z), 'the first edit places into air').toBe(val(AIR));
        post(x, y, z, value);
      }
      await frame();
    }
    const results = await settle(Promise.all(outcomes), 'the edits\' replies');
    await until(() => !w.editPath.pending(), SETTLE_MS, 'the edit path settled');
    expect(results.filter((o) => !o.ok), 'refused edits').toEqual([]);
    expect(w.history.size, 'one block-history step per edit').toBe(EDITS);
    for (const p of posted) latest.set(`${p.x},${p.y},${p.z}`, p.value);
    // The break again restored the generated air: the sim kept no entry for it (rulings R27).
    const again = results[BREAK_AGAIN] as Extract<EditOutcome, { ok: true }>;
    expect(again.next[0], 'the break again leaves no entry').toBe(0xFFFFFFFF);
    expect(again.prev[0]).toBe(val(STONE));
    for (const p of posted) expect(valueAt(p.x, p.y, p.z), `(${p.x}, ${p.y}, ${p.z})`).toBe(latest.get(`${p.x},${p.y},${p.z}`));

    const { diff, lines } = await simEntries();
    expect(lines, 'the sim\'s entries are the record\'s').toEqual(recordedEntries());
    // One entry per edited voxel, but the first one's, which the break again restored to the generated air.
    expect(lines.length, 'entries').toBe(EDITS - 2);
    entriesAfterEdits = lines;
    const hash = windowHash();
    expect(hash, 'the edits change the window').not.toBe(filled);
    expect(hash).toBe(await expected(w.session.state.params, diff));
    expect(notices, 'notices').toEqual([]);
    clean('the edits');
  });

  test('a terrain Apply (density.detailAmpHi 4.0): equal to genRegion on the new params + the same entries', async () => {
    const w = W();
    const n = applies.length;
    expect(w.session.set(AMP, AMP_APPLIED).ok).toBe(true);
    await until(() => applies.length === n + 1 && settledAt(applies[n]!.epoch), SETTLE_MS, 'the terrain Apply');
    expect(applies[n]!.epoch).toBe(2);
    expect(w.session.state.params.density.detailAmpHi).toBe(AMP_APPLIED);
    // The entries stay at their coordinates over an Apply (D14).
    const { diff, lines } = await simEntries();
    expect(lines, 'the entries after the Apply').toEqual(entriesAfterEdits);
    const hash = windowHash();
    expect(hash).toBe(await expected(w.session.state.params, diff));
    expect(hash, 'the entries show on the new terrain').not.toBe(await expected(w.session.state.params, undefined));
    expect(notices, 'notices').toEqual([]);
    clean('the terrain Apply');
  });

  test('undo of all 50 through the block history: equal to genRegion on the Apply\'s params with no diff (the DiffStore empty)', async () => {
    const w = W();
    for (let i = 0; i < EDITS; i++) w.history.undo();
    await until(() => w.history.size === 0 && w.history.redoSize === EDITS && !w.editPath.pending(), SETTLE_MS, 'the undos');
    expect(notices, 'one "Undo · blocks" per step, no refusal').toEqual(new Array(EDITS).fill('Undo · blocks'));
    // The DiffStore is empty: no column of D's set holds an entry, and the last reply named none.
    const { lines } = await simEntries();
    expect(lines, 'entries after the undos').toEqual([]);
    for (let cz = D_SET.cz0; cz < D_SET.cz0 + D_SET.h; cz++) {
      for (let cx = D_SET.cx0; cx < D_SET.cx0 + D_SET.w; cx++) expect(w.sim.hasEntries(cx, cz), `(${cx}, ${cz}) has entries`).toBe(false);
    }
    expect(windowHash()).toBe(await expected(w.session.state.params, undefined));
    clean('the undos');
  });

  test('a saved world\'s load, flush and load round trip through the sim\'s Node worker: the same entries back (SP5b spec §6.3)', async () => {
    const w = W();
    const epoch = applies.at(-1)!.epoch;
    const UPDATED = 1_700_000_000_000;
    const noticesBefore = notices.length;
    // The header genKey of the columns the sim writes: the first draft's (16 hex digits).
    const load = { db: 'edit-roundtrip', worldId: 'rt', genKey: w.firstReady.genKey, stateTable: todayStateTable(), rewrite: null } as const;
    const state = (flushSeq: number): StateRecord => ({
      worldId: 'rt', flushSeq, updated: UPDATED, player: null, time: { t: 0.25, speedIndex: 0 }, hotbar: { v: 1, active: 0, slots: [] }, places: [],
    });
    const empty = await settle(w.sim.load({ ...load, flushSeq: 0, updated: 0 }), 'the empty world\'s load');
    expect([...empty.entryCols], 'an empty world').toEqual([]);

    // 20 stones, one in each column of cx -2..2 × cz -2..1, into the first air above the surface (never (8, 8), the
    // last case's voxel), one posted per frame.
    const outcomes: Array<Promise<EditOutcome>> = [];
    const placed: Array<{ readonly x: number; readonly y: number; readonly z: number }> = [];
    for (let i = 0; i < 20; i++) {
      const x = 16 * (-2 + (i % 5)) + ((3 * i + 1) % 16);
      const z = 16 * (-2 + Math.floor(i / 5)) + ((5 * i + 2) % 16);
      const y = Math.min(319, reading((s) => s.heightAt('worldSurface', x, z))!);
      placed.push({ x, y, z });
      outcomes.push(w.editPath.post([{ x, y, z, op: 'set', value: val(STONE), expect: valueAt(x, y, z) }]));
      await frame();
    }
    const results = await settle(Promise.all(outcomes), 'the 20 edits\' replies');
    expect(results.filter((o) => !o.ok), 'refused edits').toEqual([]);
    await until(() => !w.editPath.pending() && inFlight === 0 && settledAt(epoch), SETTLE_MS, 'the 20 edits settled');
    const cols = [...new Set(placed.map((p) => colKey(p.x >> 4, p.z >> 4)))].sort((a, b) => a - b);
    expect(cols.length, 'one column per edit').toBe(20);
    const before = await simEntries();
    expect(before.lines.length, 'one entry per edit').toBe(20);
    expect([...before.diff.keys()].sort((a, b) => a - b)).toEqual(cols);

    // The history the page keeps: one step per edit, its objects kept by the next history (D28's third lever).
    const steps = results.map((o, k) => {
      const r = o as Extract<EditOutcome, { ok: true }>;
      return { edits: [{ ...placed[k]!, before: r.prev[0]!, after: r.next[0]! }] };
    });
    const h1: HistoryRecord = { worldId: 'rt', done: steps, undone: [] };
    const first = await settle(w.sim.flush(state(0), h1), 'the first flush');
    expect(first, 'the first flush').toMatchObject({ type: 'flushed', ok: true, flushSeq: 1 });
    // The earlier cases' columns, edited before this load and undone, are still dirty: the flush deletes their keys too.
    expect((first as Extract<FlushedMsg, { ok: true }>).columns, 'the flushed columns').toBeGreaterThanOrEqual(20);

    // A new handler in the same worker, over the same MemoryKV; no frame runs until its `attach` and `load` are posted,
    // so no `diff` reaches it before the load.
    await renewSim();
    const attached = w.sim.attach(w.store.handles());
    const loaded = w.sim.load({ ...load, flushSeq: 1, updated: UPDATED });
    await settle(attached, 'the attach after the renew');
    const again = await settle(loaded, 'the load after the renew');
    expect([...again.entryCols].sort((a, b) => a - b), 'the loaded columns are the 20 edits\'').toEqual(cols);
    expect([again.entries, again.unknownStates, again.skippedColumns]).toEqual([20, 0, 0]);
    const after = await simEntries();
    expect([...after.diff.keys()].sort((a, b) => a - b)).toEqual(cols);
    for (const k of cols) expect(after.diff.get(k), `column ${k}'s diff`).toEqual(before.diff.get(k));
    expect(after.lines).toEqual(before.lines);
    for (const k of cols) expect(w.sim.hasEntries(colKeyCx(k), colKeyCz(k)), `column ${k} has entries`).toBe(true);

    // The renewed handler edits and flushes: the client posts the history whole after its `load` (rulings R9).
    const x = 16 * 2 + 9;
    const z = 16 * 1 + 9;
    const y = Math.min(319, reading((s) => s.heightAt('worldSurface', x, z))!);
    const out = await settle(w.editPath.post([{ x, y, z, op: 'set', value: val(GLASS), expect: valueAt(x, y, z) }]), 'the edit after the renew');
    expect(out.ok, 'the edit after the renew').toBe(true);
    const r = out as Extract<EditOutcome, { ok: true }>;
    await until(() => !w.editPath.pending() && inFlight === 0 && settledAt(epoch), SETTLE_MS, 'the edit after the renew settled');
    const h2: HistoryRecord = { worldId: 'rt', done: [...steps, { edits: [{ x, y, z, before: r.prev[0]!, after: r.next[0]! }] }], undone: [] };
    const second = await settle(w.sim.flush(state(0), h2), 'the flush after the renew');
    expect(second, 'the flush after the renew').toMatchObject({ type: 'flushed', ok: true, flushSeq: 2, columns: 1 });
    expect(notices.slice(noticesBefore), 'notices').toEqual([]);
    clean('the round trip');
  });

  test('after unloading everything and draining the limbo, every pool slot is free', async () => {
    const w = W();
    const { store } = w;
    // The sim's retries (spec §2.1): a reply while a main-thread read section is open leaves the slots its edit retired
    // in thread 15's limbo; with nothing more posted, its own drain every SIM_DRAIN_MS frees them once the section closes.
    const [x, z] = [8, 8];
    const y = reading((s) => s.heightAt('worldSurface', x, z))!;
    const was = valueAt(x, y, z);
    store.enterRead();
    try {
      const out = await settle(w.editPath.post([{ x, y, z, op: 'set', value: val(STONE), expect: was }]), 'the edit under a read section');
      expect(out.ok, 'the edit under a read section').toBe(true);
      expect(store.limboCount(SIM_THREAD), 'thread 15\'s limbo while the section is open').toBeGreaterThan(0);
    } finally {
      store.exitRead();
    }
    await until(() => store.limboCount(SIM_THREAD) === 0, 5000, 'the sim\'s limbo');
    // The sim stops first, then the world (rulings R35: the coordinator's dispose ignores the sim's pins).
    expect(w.editPath.pending()).toBe(false);
    w.sim.dispose();
    w.control?.dispose();
    w.offSession?.();
    w.driver?.dispose();
    w.control = null;
    w.offSession = null;
    w.driver = null;
    w.coordinator.dispose();
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
    expect(simFailure).toBeNull();
  });
});

import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, JobCancelled, poolSize, WorkerFailed, type WorkerLike } from '../../src/engine/workerPool';
import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../../src/metrics/biomeShares';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { landingSurface } from '../../src/gen/column/spawn';
import { createSurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbe } from '../../src/gen/surface/probe';
import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength } from '../../src/metrics/crossSection';
import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../../src/metrics/splineStats';
import type { KnotPath } from '../../src/core/spline/types';
import { cellOf, SLICE_SAMPLES, type ToWorker } from '../../src/workers/protocol';
import { createSliceJob } from '../../src/workers/sliceJob';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { fillColumnD } from '../../src/workers/worldJobs';
import { fillColumnT } from '../../src/metrics/region';
import { createEpochCells } from '../../src/world/store/epochs';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { fakePayload } from './fixtures/payloads';

/**
 * A fake worker running the real handler asynchronously; `log` records every message it receives and
 * `replies` every reply it sends.
 */
function fakeWorker(log: ToWorker[], tamper = false, replies: unknown[] = []): WorkerLike & { terminated: boolean } {
  const h = createTaskHandler();
  const w: WorkerLike & { terminated: boolean } = {
    onmessage: null,
    terminated: false,
    postMessage(msg) {
      log.push(msg);
      setTimeout(() => {
        const r = h.handle(msg).msg;
        const data = tamper && r.type === 'ready' ? { ...r, stageHashes: { ...r.stageHashes, climate: '0000000000000000' } } : r;
        replies.push(data);
        w.onmessage?.({ data });
      }, 0);
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

/** A worker that never answers: the test fires its events by hand. */
function silentWorker(log: ToWorker[] = []): WorkerLike & { terminated: boolean } {
  const w: WorkerLike & { terminated: boolean } = {
    onmessage: null,
    terminated: false,
    postMessage(msg) { log.push(msg); },
    terminate() { w.terminated = true; },
  };
  return w;
}

/**
 * A worker running the real handler that holds the messages `hold` selects until flush(), which handles
 * them at once (so the handler reads the epoch cells as they are then) and replies asynchronously.
 */
function heldWorker(log: ToWorker[], hold: (m: ToWorker) => boolean, replies: unknown[] = []): WorkerLike & { flush(): void; holding: boolean } {
  const h = createTaskHandler();
  const held: ToWorker[] = [];
  const answer = (msg: ToWorker) => {
    const data = h.handle(msg).msg;
    replies.push(data);
    setTimeout(() => w.onmessage?.({ data }), 0);
  };
  const w: WorkerLike & { flush(): void; holding: boolean } = {
    onmessage: null,
    holding: true,
    postMessage(msg) {
      log.push(msg);
      if (w.holding && hold(msg)) held.push(msg);
      else setTimeout(() => answer(msg), 0);
    },
    flush() { for (const m of held.splice(0)) answer(m); },
    terminate() {},
  };
  return w;
}

const tile = (tx: number) => ({ layer: 'C' as const, level: 256 as const, tx, tz: 0 });
const settle = <T>(p: Promise<T>): Promise<T | Error> => p.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));

describe('worker pool', () => {
  test('size is clamp(cores − 2, 2, 6)', () => {
    expect([poolSize(1), poolSize(4), poolSize(8), poolSize(20)]).toEqual([2, 2, 6, 6]);
  });
  test('configure resolves once every worker is ready with the same hashes', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(3, () => fakeWorker(log));
    const ready = await pool.configure('42', DEFAULTS);
    expect(ready.epoch).toBe(0);
    expect(log.filter((m) => m.type === 'configure').length).toBe(3);
    expect(pool.epoch).toBe(0);
  });
  test('workers that disagree on the stage hashes fail the configure', async () => {
    let n = 0;
    const pool = createWorkerPool(2, () => fakeWorker([], n++ === 1));
    await expect(pool.configure('42', DEFAULTS)).rejects.toThrow(/disagree/);
  });
  test('bad params reject the configure', async () => {
    const pool = createWorkerPool(2, () => fakeWorker([]));
    await expect(pool.configure('42', { climate: {} })).rejects.toThrow(/BAD_PARAMS/);
  });
  test('jobs queued during configure run in priority order, one per worker', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => fakeWorker(log));
    const ready = pool.configure('42', DEFAULTS);
    const done = [pool.tile(tile(5), 5), pool.tile(tile(1), 1), pool.tile(tile(3), 3)];
    await ready;
    const bufs = await Promise.all(done);
    expect(bufs.every((b) => b.rgba.byteLength === 262144 && b.ids === null)).toBe(true);
    expect(log.filter((m) => m.type === 'mapTile').map((m) => (m as { tx: number }).tx)).toEqual([1, 3, 5]);
  });
  test('biome tiles resolve with their ids, other layers with ids null', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    const b = await pool.tile({ layer: 'biome', level: 256, tx: 0, tz: 0 }, 0);
    const c = await pool.tile(tile(0), 0);
    expect([b.rgba.byteLength, b.ids?.byteLength, c.rgba.byteLength, c.ids]).toEqual([262144, 65536, 262144, null]);
  });
  test('a worker error rejects the job instead of hanging', async () => {
    const pool = createWorkerPool(1, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          if (msg.type === 'mapTile') { setTimeout(() => w.onmessage?.({ data: { type: 'error', jobId: msg.jobId, epoch: msg.epoch, code: 'INTERNAL', message: 'boom' } }), 0); return; }
          inner.onmessage = (e) => w.onmessage?.(e);
          inner.postMessage(msg);
        },
        terminate() {},
      };
      return w;
    });
    await pool.configure('42', DEFAULTS);
    await expect(pool.tile(tile(0), 0)).rejects.toThrow(/INTERNAL: boom/);
    expect((await pool.point(1, 2)).z).toBe(2);
  });
  test('a reply that fails its guard rejects the busy job with BAD_MESSAGE: <reason> and frees the worker (SP3d spec §5.1)', async () => {
    const pool = createWorkerPool(1, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          if (msg.type === 'mapTile') { setTimeout(() => w.onmessage?.({ data: { type: 'tile', jobId: msg.jobId, epoch: msg.epoch, rgba: new ArrayBuffer(10) } }), 0); return; }
          inner.onmessage = (e) => w.onmessage?.(e);
          inner.postMessage(msg);
        },
        terminate() {},
      };
      return w;
    });
    await pool.configure('42', DEFAULTS);
    const bad = pool.tile(tile(0), 0);
    const queued = pool.point(1, 2);
    expect(pool.queued).toBe(1);
    await expect(bad).rejects.toThrow('BAD_MESSAGE: tile: rgba is not an ArrayBuffer of 262144 bytes');
    expect((await queued).z).toBe(2);
    expect(pool.probe()).toEqual({ busy: 0, queued: 0, configuring: false, jobs: [] });
  });
  test('cancelTiles rejects matching queued jobs; points still run', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    const first = pool.tile(tile(0), 0);
    const doomed = pool.tile(tile(9), 1);
    pool.cancelTiles((r) => r.tx === 9);
    await expect(doomed).rejects.toBeInstanceOf(JobCancelled);
    await first;
    expect((await pool.point(10, 20)).x).toBe(10);
    expect((await pool.spawn()).fallback).toBe(false);
  });
  test('a new epoch cancels queued and in-flight jobs of the old one', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    const inFlight = pool.tile(tile(0), 0);
    const queued = pool.tile(tile(1), 1);
    const next = pool.configure('7', DEFAULTS);
    await expect(queued).rejects.toBeInstanceOf(JobCancelled);
    await expect(inFlight).rejects.toBeInstanceOf(JobCancelled);
    expect((await next).epoch).toBe(1);
  });
});

describe('worker pool: abort through the epoch cells (SP2b spec §2.2; SP4b spec §2.7)', () => {
  test('the terrain cell holds the pool epoch; configure stores the new epoch before posting and posts the shared buffer', async () => {
    const cell = new Int32Array(new SharedArrayBuffer(16));
    const log: ToWorker[] = [];
    const seen: number[] = [];
    const pool = createWorkerPool(2, () => {
      const w = fakeWorker(log);
      const post = w.postMessage.bind(w);
      w.postMessage = (m, t) => { if (m.type === 'configure') seen.push(Atomics.load(cell, 0)); post(m, t); };
      return w;
    }, { epochCells: cell });
    expect([pool.abortable, Atomics.load(cell, 0)]).toEqual([true, 0]);
    await pool.configure('42', DEFAULTS);
    await pool.configure('7', DEFAULTS);
    expect(seen).toEqual([0, 0, 1, 1]);
    expect(log.filter((m) => m.type === 'configure').every((m) => m.type === 'configure' && m.epochs === cell.buffer)).toBe(true);
  });
  test('without cells the pool is not abortable and posts epochs: null', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    expect(pool.abortable).toBe(false);
    expect(log[0]).toMatchObject({ type: 'configure', epochs: null });
  });
  test('an in-flight tile of a superseded epoch is aborted by the worker and rejects as JobCancelled', async () => {
    const cell = new Int32Array(new SharedArrayBuffer(16));
    const replies: unknown[] = [];
    const pool = createWorkerPool(1, () => fakeWorker([], false, replies), { epochCells: cell });
    await pool.configure('42', DEFAULTS);
    const inFlight = settle(pool.tile({ layer: 'relief', level: 4, tx: 0, tz: 0 }, 0));
    const next = pool.configure('42', DEFAULTS);
    expect(await inFlight).toBeInstanceOf(JobCancelled);
    expect(replies).toContainEqual(expect.objectContaining({ type: 'error', epoch: 0, code: 'ABORTED' }));
    expect((await next).epoch).toBe(1);
    expect((await pool.tile(tile(0), 0)).rgba.byteLength).toBe(262144);
  });
  test('an ABORTED reply resolves as JobCancelled even for a job of the current epoch', async () => {
    const pool = createWorkerPool(1, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          if (msg.type === 'mapTile') { setTimeout(() => w.onmessage?.({ data: { type: 'error', jobId: msg.jobId, epoch: msg.epoch, code: 'ABORTED', message: 'aborted' } }), 0); return; }
          inner.onmessage = (e) => w.onmessage?.(e);
          inner.postMessage(msg);
        },
        terminate() {},
      };
      return w;
    });
    await pool.configure('42', DEFAULTS);
    await expect(pool.tile(tile(0), 0)).rejects.toBeInstanceOf(JobCancelled);
  });
});

/**
 * A worker that answers configure with ready and holds every job until `release`, which answers the held world jobs
 * with `columnDone` (whatever the cells hold: the pool's own settle check is under test).
 */
function holdingWorker(log: ToWorker[] = []): WorkerLike & { release(): void } {
  const held: ToWorker[] = [];
  const send = (data: unknown) => setTimeout(() => w.onmessage?.({ data }), 0);
  const w: WorkerLike & { release(): void } = {
    onmessage: null,
    postMessage(msg) {
      log.push(msg);
      if (msg.type === 'configure') send({ type: 'ready', epoch: msg.epoch, stageHashes: {}, genKey: '0000000000000000' });
      else held.push(msg);
    },
    release() {
      for (const m of held.splice(0)) {
        if (m.type === 'terrain' || m.type === 'decorate' || m.type === 'light') {
          send({ type: 'columnDone', jobId: m.jobId, epoch: m.epoch, job: m.type, cx: m.cx, cz: m.cz, ms: 1, versions: m.type === 'light' ? new ArrayBuffer(72) : null });
        }
      }
    },
    terminate() {},
  };
  return w;
}

describe('worker pool: the per-scope epoch cells (SP4b spec §2.7)', () => {
  const cellsOf = (c: Int32Array) => Array.from({ length: 4 }, (_, i) => Atomics.load(c, i));

  test('epochCells over an ArrayBuffer, or of length other than 4, is refused with TypeError', () => {
    let spawned = 0;
    const spawn = () => { spawned++; return silentWorker(); };
    for (const cells of [new Int32Array(new ArrayBuffer(16)), new Int32Array(new SharedArrayBuffer(12)), new Int32Array(new SharedArrayBuffer(20)), new Int32Array(new SharedArrayBuffer(32), 4, 4)]) {
      expect(() => createWorkerPool(1, spawn, { epochCells: cells }), `${cells.buffer.constructor.name} of ${cells.buffer.byteLength} bytes, length ${cells.length}`).toThrow(TypeError);
    }
    expect(spawned, 'no worker is spawned for refused cells').toBe(0);
    expect(createWorkerPool(1, spawn, { epochCells: createEpochCells(true).cells }).abortable).toBe(true);
  });
  test('configure stores the new generation into all four cells (the store\'s cells start 0, the pool\'s generation −1: after the first configure all four read 0, after the second 1)', async () => {
    const store = createStore({ shared: true, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
    const cells = store.epochs.cells;
    const log: ToWorker[] = [];
    const seen: number[][] = [];
    const pool = createWorkerPool(2, () => {
      const w = holdingWorker(log);
      const post = w.postMessage.bind(w);
      w.postMessage = (m, t) => { if (m.type === 'configure') seen.push(cellsOf(cells)); post(m, t); };
      return w;
    }, { epochCells: cells });
    expect([pool.epoch, cellsOf(cells)], 'the pool writes nothing before its first configure').toEqual([-1, [0, 0, 0, 0]]);
    await pool.configure('42', DEFAULTS);
    expect(cellsOf(cells)).toEqual([0, 0, 0, 0]);
    await pool.configure('7', DEFAULTS);
    expect(cellsOf(cells)).toEqual([1, 1, 1, 1]);
    // Stored before posting, and the cells' buffer is what each configure carries.
    expect(seen).toEqual([[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [1, 1, 1, 1]]);
    expect(log.filter((m) => m.type === 'configure').every((m) => m.type === 'configure' && m.epochs === cells.buffer)).toBe(true);
  });
  test('bumpScope(\'light\') rejects queued L and MESH jobs, keeps queued T and D, and the cells read [g, g, g + 1, g + 1]', async () => {
    const cells = createEpochCells(true).cells;
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => holdingWorker(log), { epochCells: cells });
    await pool.configure('42', DEFAULTS);
    await pool.configure('42', DEFAULTS);
    const g = pool.epoch;
    // The first job takes the only worker; the four behind it queue.
    const running = settle(pool.terrain(9, 9));
    const queued = [settle(pool.terrain(1, 1)), settle(pool.decorate(1, 1)), settle(pool.light(1, 1)), settle(pool.meshColumn(1, 1))];
    expect([pool.probe().busy, pool.queued]).toEqual([1, 4]);
    pool.bumpScope('light');
    expect(cellsOf(cells)).toEqual([g, g, g + 1, g + 1]);
    expect(pool.queued).toBe(2);
    expect(await queued[2]).toBeInstanceOf(JobCancelled);
    expect(await queued[3]).toBeInstanceOf(JobCancelled);
    // The T and D jobs stay queued (unsettled); only the running T was posted, with the terrain cell's value.
    let settled = 0;
    void Promise.all([queued[0], queued[1]]).then(() => { settled++; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([settled, pool.queued]).toEqual([0, 2]);
    expect(log.filter((m) => m.type !== 'configure').map((m) => [m.type, 'scope' in m ? m.scope : null])).toEqual([['terrain', g]]);
    void running;
  });
  test('after bumpScope(\'light\') a new L job succeeds (its scope is the new cell value; its epoch still the configure\'s, so no STALE_EPOCH)', async () => {
    const MiB = 1 << 20;
    const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
    const ctx = ctxFor('42');
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) expect(fillColumnD(store, ctx, cx, cz, () => false)).toBe(true);
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => fakeWorker(log), { epochCells: store.epochs.cells });
    await pool.attachStore(store.handles());
    await pool.configure('42', DEFAULTS);
    pool.bumpScope('light');
    const done = await pool.light(0, 0);
    expect([done.cx, done.cz, done.versions?.length]).toEqual([0, 0, 18]);
    expect(log.at(-1)).toMatchObject({ type: 'light', epoch: 0, scope: 1 });
    expect(store.table.status(store.table.find(0, 0))).toBe(3);
  });
  test('a world job\'s OK reply whose cell moved since issue resolves with its generation (SP4c spec §4.6, D7: the worker committed it)', async () => {
    const cells = createEpochCells(true).cells;
    const workers = [holdingWorker(), holdingWorker()];
    let n = 0;
    const pool = createWorkerPool(2, () => workers[n++]!, { epochCells: cells });
    await pool.configure('42', DEFAULTS);
    const t = settle(pool.terrain(0, 0));
    const l = settle(pool.light(0, 0));
    expect(pool.probe().busy).toBe(2);
    // Another writer moves the light cell; the worker still answers columnDone, so the L committed.
    Atomics.add(cells, 2, 1);
    for (const w of workers) w.release();
    expect(await l).toMatchObject({ cx: 0, cz: 0, generation: 0 });
    expect(await t).toMatchObject({ cx: 0, cz: 0, generation: 0 });
  });
});

type ReplyingWorker = WorkerLike & { answer(pick?: (m: ToWorker) => boolean, code?: string): void };

/**
 * A worker that answers configure with ready at once and holds every job until `answer(pick, code)`, which replies to the
 * held jobs `pick` selects: with `code` 'OK', the OK reply of the job's type (columnDone, meshColumnResult, tile,
 * pointResult) whatever the cells hold; with another code, an error of that code; without one, as a real worker's phase
 * check does: ABORTED when `cells` are given and the job's epoch cell differs from its scope, else the OK reply.
 */
function replyingWorker(log: ToWorker[] = [], cells: Int32Array | null = null): ReplyingWorker {
  const held: ToWorker[] = [];
  const send = (data: unknown) => setTimeout(() => w.onmessage?.({ data }), 0);
  const ok = (m: ToWorker): unknown => {
    const j = m as unknown as { jobId: number; epoch: number; cx: number; cz: number };
    switch (m.type) {
      case 'terrain': case 'decorate': case 'light':
        return { type: 'columnDone', jobId: j.jobId, epoch: j.epoch, job: m.type, cx: j.cx, cz: j.cz, ms: 1, versions: m.type === 'light' ? new ArrayBuffer(72) : null };
      case 'meshColumn': {
        const p = fakePayload(j.cx, j.cz, [{ sy: 4, pass: 0, quads: 2 }]);
        return {
          type: 'meshColumnResult', jobId: j.jobId, epoch: j.epoch, cx: j.cx, cz: j.cz, ms: 1, versions: p.versions.buffer, connectivity: p.connectivity.buffer,
          position: p.position.buffer, data: p.data.buffer, index: p.index.buffer, rows: p.rows.buffer, spheres: p.spheres.buffer,
        };
      }
      case 'mapTile': return { type: 'tile', jobId: j.jobId, epoch: j.epoch, rgba: new ArrayBuffer(262144) };
      case 'point': return { type: 'pointResult', jobId: j.jobId, epoch: j.epoch, fields: {} };
      default: throw new Error(`replyingWorker: no OK reply for ${m.type}`);
    }
  };
  const w: ReplyingWorker = {
    onmessage: null,
    postMessage(msg) {
      log.push(msg);
      if (msg.type === 'configure') send({ type: 'ready', epoch: msg.epoch, stageHashes: {}, genKey: '0000000000000000' });
      else held.push(msg);
    },
    answer(pick = () => true, code) {
      for (let i = 0; i < held.length;) {
        const m = held[i]!;
        if (!pick(m) || m.type === 'configure' || m.type === 'attach' || m.type === 'selftest') { i++; continue; }
        held.splice(i, 1);
        const stopped = cells !== null && Atomics.load(cells, cellOf(m.type)) !== m.scope;
        const c = code ?? (stopped ? 'ABORTED' : 'OK');
        send(c === 'OK' ? ok(m) : { type: 'error', jobId: m.jobId, epoch: m.epoch, code: c, message: c.toLowerCase() });
      }
    },
    terminate() {},
  };
  return w;
}

describe('worker pool: world replies keep their generation; configure moves past every cell (SP4c spec §4.6, §4.9; D7, ENG-4)', () => {
  const cellsOf = (c: Int32Array) => Array.from({ length: 4 }, (_, i) => Atomics.load(c, i));
  /** A pool of `n` replying workers over fresh shared cells, configured `times` times. */
  const poolOf = async (n: number, times = 1) => {
    const cells = createEpochCells(true).cells;
    const log: ToWorker[] = [];
    const workers = Array.from({ length: n }, () => replyingWorker(log, cells));
    let k = 0;
    const pool = createWorkerPool(n, () => workers[k++]!, { epochCells: cells });
    for (let i = 0; i < times; i++) await pool.configure('42', DEFAULTS);
    return { cells, log, workers, pool };
  };

  test('a decorate whose OK reply arrives after a configure resolves with generation g (its issue epoch), not JobCancelled', async () => {
    const { pool, workers } = await poolOf(1, 2);
    const g = pool.epoch;
    const d = settle(pool.decorate(2, 3));
    await pool.configure('42', DEFAULTS);
    expect(pool.epoch).toBeGreaterThan(g);
    // An OK reply whatever the cells hold now: the worker committed the D before the configure arrived.
    workers[0]!.answer(() => true, 'OK');
    expect(await d).toEqual({ cx: 2, cz: 3, ms: 1, versions: null, generation: g });
  });
  test('the same for terrain, light and meshColumn', async () => {
    const { pool, workers } = await poolOf(3, 2);
    const g = pool.epoch;
    const t = settle(pool.terrain(1, 1));
    const l = settle(pool.light(2, 2));
    const m = settle(pool.meshColumn(3, 3));
    expect(pool.probe().busy).toBe(3);
    await pool.configure('42', DEFAULTS);
    for (const w of workers) w.answer(() => true, 'OK');
    expect(await t).toEqual({ cx: 1, cz: 1, ms: 1, versions: null, generation: g });
    const lr = await l;
    expect(lr).toMatchObject({ cx: 2, cz: 2, ms: 1, generation: g });
    expect((lr as { versions: Int32Array }).versions.length).toBe(18);
    const mr = await m;
    expect(mr).not.toBeInstanceOf(Error);
    const done = mr as { payload: { cx: number; cz: number; rows: Int32Array }; generation: number };
    expect(Object.keys(done).sort()).toEqual(['generation', 'payload']);
    expect([done.payload.cx, done.payload.cz, done.generation]).toEqual([3, 3, g]);
    expect(done.payload.rows.length).toBeGreaterThan(0);
  });
  test('an L that replied ABORTED after a configure rejects JobCancelled; a T that replied STALE_EPOCH rejects JobCancelled', async () => {
    const { pool, workers } = await poolOf(2);
    const l = settle(pool.light(0, 0));
    const t = settle(pool.terrain(1, 0));
    expect(pool.probe().busy).toBe(2);
    await pool.configure('42', DEFAULTS);
    workers[0]!.answer(() => true, 'ABORTED');
    workers[1]!.answer(() => true, 'STALE_EPOCH');
    expect(await l).toBeInstanceOf(JobCancelled);
    expect(await t).toBeInstanceOf(JobCancelled);
  });
  test('a mapTile and a point whose OK replies arrive after a configure still reject JobCancelled', async () => {
    const { pool, workers } = await poolOf(2);
    const tl = settle(pool.tile(tile(0), 0));
    const pt = settle(pool.point(1, 2));
    expect(pool.probe().busy).toBe(2);
    await pool.configure('42', DEFAULTS);
    for (const w of workers) w.answer(() => true, 'OK');
    expect(await tl).toBeInstanceOf(JobCancelled);
    expect(await pt).toBeInstanceOf(JobCancelled);
  });
  test('ENG-4: configure (g), bumpScope(\'light\') → cells [g, g, g + 1, g + 1]; the next configure stores g + 2 into all four and pool.epoch is g + 2; an L issued between them (scope g + 1) sees its cell differ from its scope and stops', async () => {
    const { pool, workers, cells, log } = await poolOf(1, 2);
    const g = pool.epoch;
    expect(cellsOf(cells)).toEqual([g, g, g, g]);
    pool.bumpScope('light');
    expect(cellsOf(cells)).toEqual([g, g, g + 1, g + 1]);
    const l = settle(pool.light(0, 0));
    expect(log.at(-1)).toMatchObject({ type: 'light', epoch: g, scope: g + 1 });
    await pool.configure('42', DEFAULTS);
    expect([pool.epoch, cellsOf(cells)]).toEqual([g + 2, [g + 2, g + 2, g + 2, g + 2]]);
    expect(log.at(-1)).toMatchObject({ type: 'configure', epoch: g + 2 });
    // The worker's phase check: the light cell (g + 2) differs from the L's scope (g + 1), so it stops (ABORTED).
    workers[0]!.answer();
    expect(await l).toBeInstanceOf(JobCancelled);
  });
  test('without cells, configure counts epoch + 1 (the standalone map page\'s pool)', async () => {
    const pool = createWorkerPool(1, () => replyingWorker());
    const epochs: number[] = [];
    for (let i = 0; i < 3; i++) epochs.push((await pool.configure('42', DEFAULTS)).epoch);
    pool.bumpScope('light');
    epochs.push((await pool.configure('42', DEFAULTS)).epoch);
    expect([epochs, pool.epoch]).toEqual([[0, 1, 2, 3], 3]);
  });
  test('with cells, the first configure stores 0 and the next 1 (SP4b\'s :215, :333, :565 and :741 keep their epochs)', async () => {
    const { pool, cells } = await poolOf(1, 0);
    expect([pool.epoch, cellsOf(cells)]).toEqual([-1, [0, 0, 0, 0]]);
    expect((await pool.configure('42', DEFAULTS)).epoch).toBe(0);
    expect([pool.epoch, cellsOf(cells)]).toEqual([0, [0, 0, 0, 0]]);
    expect((await pool.configure('42', DEFAULTS)).epoch).toBe(1);
    expect([pool.epoch, cellsOf(cells)]).toEqual([1, [1, 1, 1, 1]]);
  });
  test('`spawn()` queues at −2 before a queued point at −1; `spawn(600)` runs after a stats part at 500', async () => {
    const log: ToWorker[] = [];
    const w = silentWorker(log);
    const pool = createWorkerPool(1, () => w);
    const ready = settle(pool.configure('42', DEFAULTS));
    // Queued behind the configure's barrier, so the pool takes them in priority order once it resolves.
    const jobs = [settle(pool.point(1, 2)), settle(pool.spawn(600)), settle(pool.stats('biomeShares', 4, { len: biomeSharesLength() })), settle(pool.spawn())];
    w.onmessage?.({ data: { type: 'ready', epoch: 0, stageHashes: {}, genKey: '0000000000000000' } });
    await ready;
    // Each job is answered by an error, which frees the worker for the next.
    for (let k = 0; k < 4; k++) {
      const m = log.at(-1) as unknown as { jobId: number; epoch: number };
      w.onmessage?.({ data: { type: 'error', jobId: m.jobId, epoch: m.epoch, code: 'INTERNAL', message: 'x' } });
    }
    await Promise.all(jobs);
    expect(log.filter((m) => m.type !== 'configure').map((m) => m.type)).toEqual(['spawn', 'point', 'stats', 'spawn']);
    // The first spawn posted is `spawn()` (queued last, at −2), the last `spawn(600)`.
    const spawns = log.filter((m) => m.type === 'spawn').map((m) => (m as { jobId: number }).jobId);
    expect(spawns[0]!).toBeGreaterThan(spawns[1]!);
  });
});

describe('worker pool: worker errors (SP2b spec §2.3)', () => {
  test('a job-less error of a superseded epoch is ignored and the next configure resolves (SP2a minor 4)', async () => {
    const pool = createWorkerPool(2, () => fakeWorker([]));
    const first = settle(pool.configure('42', { climate: {} }));
    const second = pool.configure('42', DEFAULTS);
    expect(await first).toBeInstanceOf(JobCancelled);
    expect((await second).epoch).toBe(1);
  });
  test.each(['onerror', 'onmessageerror'] as const)('%s rejects the pending configure; the other workers carry on (SP2a minor 3)', async (event) => {
    const failures: Error[] = [];
    const bad = silentWorker();
    let n = 0;
    const pool = createWorkerPool(2, () => (n++ === 1 ? bad : fakeWorker([])), { onFailure: (e) => failures.push(e) });
    const pending = settle(pool.configure('42', DEFAULTS));
    bad[event]?.({ message: 'failed to load' });
    const r = await pending;
    expect(r).toBeInstanceOf(WorkerFailed);
    expect((r as Error).message).toMatch(event === 'onerror' ? /worker 2 of 2 failed: failed to load/ : /worker 2 of 2 failed: a reply could not be read/);
    expect([failures.length, failures[0] === r, bad.terminated]).toEqual([1, true, true]);
    expect((await pool.configure('7', DEFAULTS)).epoch).toBe(1);
    expect((await pool.tile(tile(0), 0)).rgba.byteLength).toBe(262144);
  });
  test('a worker error rejects that worker\'s in-flight job and nothing else', async () => {
    const workers = [fakeWorker([]), fakeWorker([])];
    let n = 0;
    const pool = createWorkerPool(2, () => workers[n++]!);
    await pool.configure('42', DEFAULTS);
    const onFirst = pool.tile(tile(0), 0);
    const onSecond = settle(pool.tile(tile(1), 1));
    workers[1]!.onerror?.({});
    expect(await onSecond).toBeInstanceOf(WorkerFailed);
    expect((await onFirst).rgba.byteLength).toBe(262144);
    expect((await pool.point(3, 4)).x).toBe(3);
  });
  test('when every worker has failed, queued and new jobs and configures reject instead of hanging', async () => {
    const workers = [silentWorker(), silentWorker()];
    let n = 0;
    const pool = createWorkerPool(2, () => workers[n++]!);
    const configure = settle(pool.configure('42', DEFAULTS));
    const queued = settle(pool.tile(tile(0), 0));
    workers[0]!.onerror?.({});
    workers[1]!.onerror?.({});
    expect(await configure).toBeInstanceOf(WorkerFailed);
    expect(await queued).toBeInstanceOf(WorkerFailed);
    expect(await settle(pool.point(1, 2))).toBeInstanceOf(WorkerFailed);
    expect(await settle(pool.selftest('sp1.params'))).toBeInstanceOf(WorkerFailed);
    expect(await settle(pool.stats('biomeShares', 10, { len: biomeSharesLength() }))).toBeInstanceOf(WorkerFailed);
    expect(await settle(pool.configure('7', DEFAULTS))).toBeInstanceOf(WorkerFailed);
  });
});

describe('worker pool: terminate (SP4b spec §2.8)', () => {
  test('terminate rejects a pending configure and the busy jobs with WorkerFailed(\'terminated\'), the queued ones with JobCancelled; afterwards no worker is live', async () => {
    const workers = [silentWorker(), silentWorker()];
    let n = 0;
    const pool = createWorkerPool(2, () => workers[n++]!);
    const busy = [settle(pool.tile(tile(0), 0)), settle(pool.point(1, 2))];
    const queued = settle(pool.spawn());
    expect(pool.probe()).toMatchObject({ busy: 2, queued: 1 });
    const configure = settle(pool.configure('42', DEFAULTS));
    const queuedAfter = settle(pool.tile(tile(1), 0));
    pool.terminate();
    for (const p of [configure, ...busy]) {
      const e = await p;
      expect(e).toBeInstanceOf(WorkerFailed);
      expect((e as Error).message).toBe('terminated');
    }
    expect(await queued).toBeInstanceOf(JobCancelled);
    expect(await queuedAfter).toBeInstanceOf(JobCancelled);
    expect([workers.every((w) => w.terminated), pool.liveWorkers(), pool.probe().busy]).toEqual([true, 0, 0]);
    expect(await settle(pool.point(0, 0))).toBeInstanceOf(WorkerFailed);
    // The workers' handlers are detached: a late reply settles nothing.
    expect(workers.map((w) => w.onmessage)).toEqual([null, null]);
  });
});

describe('worker pool: stats jobs (SP2b spec §5.4)', () => {
  const statsOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'stats' ? [[m.kind, m.from, m.to]] : []));
  const SHARES = { len: biomeSharesLength() };
  const splineArgs = (node: KnotPath) => ({ len: splineStatsLength(splineStatsNode(DEFAULTS, 'shape.offset', node)!.points.length), leaf: 'shape.offset' as const, node });
  const direct = (fill: (out: Float64Array) => boolean, len: number) => {
    const out = new Float64Array(len);
    expect(fill(out)).toBe(true);
    return out;
  };

  test('a request is split into pool.size slices of [0, n), queued at priority 500: after preview tiles, before fine tiles', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    const ready = pool.configure('42', DEFAULTS);
    const fine = pool.tile(tile(1), 1000);
    const sum = pool.stats('biomeShares', 1001, SHARES);
    const preview = pool.tile(tile(0), 3);
    await ready;
    await Promise.all([fine, sum, preview]);
    // tile 0 has a preview tile's priority (3), tile 1 a fine tile's (1000 + distance).
    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'stats' ? [`stats ${m.from}-${m.to}`] : []))).toEqual(['tile 0', 'stats 0-500', 'stats 500-1001', 'tile 1']);
    expect(log.filter((m) => m.type === 'stats').every((m) => m.type === 'stats' && m.epoch === 0 && m.args.len === SHARES.len)).toBe(true);
  });

  test('slices are contiguous and differ by at most one point; empty slices are not sent; n = 0 posts nothing', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(6, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    await pool.stats('biomeShares', 1003, SHARES);
    expect(statsOf(log)).toEqual([0, 167, 334, 501, 668, 835].map((from, i) => ['biomeShares', from, i === 5 ? 1003 : from + 167]));
    log.length = 0;
    await pool.stats('biomeShares', 4, SHARES);
    expect(statsOf(log)).toEqual([['biomeShares', 0, 1], ['biomeShares', 1, 2], ['biomeShares', 2, 3], ['biomeShares', 3, 4]]);
    log.length = 0;
    const none = await pool.stats('biomeShares', 0, SHARES);
    expect([statsOf(log).length, none.length, none.every((v) => v === 0)]).toEqual([0, SHARES.len, true]);
  });

  test('crossSection runs as one job over [0, n) whatever pool.size (SP2b spec §4.5); its result is the direct profile', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(3, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    const args = { len: crossSectionLength(), ax: 5120, az: 3072, bx: 6656, bz: 3072 };
    const got = await pool.stats('crossSection', CROSS_SECTION_POINTS, args);
    expect(statsOf(log)).toEqual([['crossSection', 0, CROSS_SECTION_POINTS]]);
    expect(Array.from(got)).toEqual(Array.from(direct((o) => crossSectionInto(ctxFor('42'), args, 0, CROSS_SECTION_POINTS, o), args.len)));
    log.length = 0;
    await pool.stats('crossSection', 100, args);
    expect(statsOf(log)).toEqual([['crossSection', 0, 100]]);
  });

  test('a bad n or len rejects with RangeError before anything is queued', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    for (const [n, len] of [[-1, 31], [1.5, 31], [Number.NaN, 31], [10, 0], [10, 2.5]] as const) {
      await expect(pool.stats('biomeShares', n, { len })).rejects.toBeInstanceOf(RangeError);
    }
    expect(statsOf(log)).toEqual([]);
  });

  test('the split sum equals a single-slice run: exactly for counts and root weights, within 1e-10 relative for nested weights', async () => {
    const pool = createWorkerPool(6, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    const ctx = ctxFor('42');
    const shares = await pool.stats('biomeShares', BIOME_SHARES_POINTS, SHARES);
    expect(Array.from(shares)).toEqual(Array.from(direct((o) => biomeSharesInto(ctx, biomeSharePoints(), 0, BIOME_SHARES_POINTS, o), SHARES.len)));
    expect(shares[SHARES.len - 1]).toBe(BIOME_SHARES_POINTS);
    const root = await pool.stats('splineStats', SPLINE_STATS_POINTS, splineArgs([]));
    expect(Array.from(root)).toEqual(Array.from(direct((o) => splineStatsInto(ctx, 'shape.offset', [], splineStatPoints(), 0, SPLINE_STATS_POINTS, o), root.length)));
    for (const node of [[6], [6, 0]]) {
      const got = await pool.stats('splineStats', SPLINE_STATS_POINTS, splineArgs(node));
      const want = direct((o) => splineStatsInto(ctx, 'shape.offset', node, splineStatPoints(), 0, SPLINE_STATS_POINTS, o), got.length);
      expect(got.length).toBe(want.length);
      // The point count and the land point count are counts: exact.
      expect([got[got.length - 2], got[got.length - 1]]).toEqual([want[want.length - 2], want[want.length - 1]]);
      let maxRel = 0;
      for (let k = 0; k < got.length; k++) {
        const scale = Math.max(Math.abs(got[k]!), Math.abs(want[k]!));
        if (scale > 0) maxRel = Math.max(maxRel, Math.abs(got[k]! - want[k]!) / scale);
      }
      expect(maxRel, `node [${node.join(', ')}]`).toBeLessThanOrEqual(1e-10);
    }
  });

  test('a failed slice rejects the request with its error and drops its queued slices; nothing is retried', async () => {
    const log: ToWorker[] = [];
    let n = 0;
    const gate = heldWorker(log, (m) => m.type === 'mapTile');
    const pool = createWorkerPool(2, () => (n++ === 0 ? gate : fakeWorker(log)));
    await pool.configure('42', DEFAULTS);
    const held = pool.tile(tile(0), 0);
    // Worker 1 is busy with the held tile: slice 0 runs on worker 2, slice 1 waits in the queue.
    const req = settle(pool.stats('splineStats', 1000, { ...splineArgs([]), node: [0] }));
    expect(pool.queued).toBe(1);
    const r = await req;
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/^BAD_ARGS: /);
    expect([pool.queued, statsOf(log)]).toEqual([0, [['splineStats', 0, 500]]]);
    gate.flush();
    expect((await held).rgba.byteLength).toBe(262144);
    expect(statsOf(log)).toEqual([['splineStats', 0, 500]]);
  });

  test('a slice reply of the wrong length rejects the request', async () => {
    const pool = createWorkerPool(1, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          if (msg.type === 'stats') { setTimeout(() => w.onmessage?.({ data: { type: 'statsResult', jobId: msg.jobId, epoch: msg.epoch, kind: msg.kind, data: new ArrayBuffer(8) } }), 0); return; }
          inner.onmessage = (e) => w.onmessage?.(e);
          inner.postMessage(msg);
        },
        terminate() {},
      };
      return w;
    });
    await pool.configure('42', DEFAULTS);
    await expect(pool.stats('biomeShares', 10, SHARES)).rejects.toThrow(/8 bytes, expected 248/);
  });

  test('aborting a stats request rejects it with JobCancelled and drops its partial sums; the next request is unaffected', async () => {
    const cell = new Int32Array(new SharedArrayBuffer(16));
    const log: ToWorker[] = [];
    const replies: unknown[] = [];
    let n = 0;
    const slow = heldWorker(log, (m) => m.type === 'stats', replies);
    const pool = createWorkerPool(2, () => (n++ === 0 ? fakeWorker(log, false, replies) : slow), { epochCells: cell });
    await pool.configure('42', DEFAULTS);
    const req = settle(pool.stats('biomeShares', 2000, SHARES));
    // Slice 0 completes on worker 1 (a partial sum); slice 1 is held on worker 2.
    while (!replies.some((r) => (r as { type: string }).type === 'statsResult')) await new Promise((resolve) => setTimeout(resolve, 0));
    const next = pool.configure('42', DEFAULTS);
    slow.flush();
    expect(await req).toBeInstanceOf(JobCancelled);
    expect(replies).toContainEqual(expect.objectContaining({ type: 'error', epoch: 0, code: 'ABORTED' }));
    expect((await next).epoch).toBe(1);
    slow.holding = false;
    const again = await pool.stats('biomeShares', 2000, SHARES);
    expect(Array.from(again)).toEqual(Array.from(direct((o) => biomeSharesInto(ctxFor('42'), biomeSharePoints(), 0, 2000, o), SHARES.len)));
    expect(statsOf(log)).toEqual([['biomeShares', 0, 1000], ['biomeShares', 1000, 2000], ['biomeShares', 0, 1000], ['biomeShares', 1000, 2000]]);
  });

  test('a queued stats request is cancelled by the next configure', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    const first = pool.configure('42', DEFAULTS);
    const req = settle(pool.stats('biomeShares', 100, SHARES));
    const second = pool.configure('7', DEFAULTS);
    expect(await settle(first)).toBeInstanceOf(JobCancelled);
    expect(await req).toBeInstanceOf(JobCancelled);
    expect((await second).epoch).toBe(1);
  });
});

describe('worker pool: probe (SP2b spec §2.8)', () => {
  test('busy workers, the type, epoch and level of each in-flight job, the queue and a pending configure', () => {
    const pool = createWorkerPool(2, () => silentWorker());
    expect(pool.probe()).toEqual({ busy: 0, queued: 0, configuring: false, jobs: [] });
    // One job per worker in queue order (tile 64 to worker 0, tile 256 to worker 1); the spawn and the second tile wait.
    void settle(pool.tile({ layer: 'biome', level: 64, tx: 0, tz: 0 }, 1000));
    void settle(pool.tile({ layer: 'biome', level: 256, tx: 0, tz: 0 }, 0));
    void settle(pool.spawn());
    void settle(pool.tile({ layer: 'biome', level: 64, tx: 1, tz: 0 }, 1001));
    const inFlight = [{ worker: 0, type: 'mapTile', epoch: -1, level: 64 }, { worker: 1, type: 'mapTile', epoch: -1, level: 256 }];
    expect(pool.probe()).toEqual({ busy: 2, queued: 2, configuring: false, jobs: inFlight });
    // A configure empties the queue; the in-flight jobs stay until their workers answer.
    void settle(pool.configure('42', DEFAULTS));
    expect(pool.probe()).toEqual({ busy: 2, queued: 0, configuring: true, jobs: inFlight });
    pool.terminate();
  });
  test('a spawn or point job in flight has level null', () => {
    const pool = createWorkerPool(2, () => silentWorker());
    void settle(pool.spawn());
    void settle(pool.point(1, 2));
    expect(pool.probe().jobs).toEqual([{ worker: 0, type: 'spawn', epoch: -1, level: null }, { worker: 1, type: 'point', epoch: -1, level: null }]);
    pool.terminate();
  });
});

describe('worker pool: slice jobs (SP3a spec §5.1, split across workers: SP3b spec §6)', () => {
  const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
  /** About 170 columns: most samples in a column of their own, some columns shared by neighbouring samples. */
  const LONG = { ax: -3000.5, az: -2100.25, bx: -1000.75, bz: -1500.5 };
  const slicesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'slice' ? [[m.jobId, m.epoch, m.ax, m.az, m.bx, m.bz, m.from, m.to]] : []));
  const rangesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'slice' ? [[m.from, m.to]] : []));
  const same = (a: ArrayBufferView, b: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  const single = (s: typeof COAST) => createSliceJob().run(ctxFor('42'), 0, s, () => false)!;

  test('a slice is split into pool.size contiguous ranges of the 512 samples, as stats splits, at the stats priority (500: after preview tiles, before fine tiles)', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    const ready = pool.configure('42', DEFAULTS);
    const fine = pool.tile(tile(1), 1000);
    const got = pool.slice(COAST);
    const preview = pool.tile(tile(0), 3);
    await ready;
    const [, r] = await Promise.all([fine, got, preview]);
    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? [`slice ${m.from}-${m.to}`] : []))).toEqual(['tile 0', 'slice 0-256', 'slice 256-512', 'tile 1']);
    expect(slicesOf(log).map((s) => s.slice(1))).toEqual([[0, COAST.ax, COAST.az, COAST.bx, COAST.bz, 0, 256], [0, COAST.ax, COAST.az, COAST.bx, COAST.bz, 256, 512]]);
    expect(r.blocks).toBeInstanceOf(Uint16Array);
    expect(r.fluid).toBeInstanceOf(Uint8Array);
    expect([r.blocks.length, r.fluid.length]).toEqual([SLICE_SAMPLES, SLICE_SAMPLES]);
    for (const [size, ranges] of [
      [1, [[0, 512]]],
      [3, [[0, 170], [170, 341], [341, 512]]],
      [6, [[0, 85], [85, 170], [170, 256], [256, 341], [341, 426], [426, 512]]],
    ] as const) {
      const sized: ToWorker[] = [];
      const p = createWorkerPool(size, () => fakeWorker(sized));
      await p.configure('42', DEFAULTS);
      await p.slice(COAST);
      expect(rangesOf(sized), `size ${size}`).toEqual(ranges);
      p.terminate();
    }
  });
  test.each([[1], [2], [3], [6]])('pool.size %i: the merged slice is byte-identical to the single-worker slice', async (size) => {
    const pool = createWorkerPool(size, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    for (const s of [COAST, LONG, { ax: LONG.bx, az: LONG.bz, bx: LONG.ax, bz: LONG.az }]) {
      const want = single(s);
      const r = await pool.slice(s);
      expect(same(r.blocks, want.blocks), `blocks ${JSON.stringify(s)}`).toBe(true);
      expect(same(r.fluid, want.fluid), `fluid ${JSON.stringify(s)}`).toBe(true);
    }
    pool.terminate();
  }, 60_000);
  test('a priority can be given; probe shows each part as a slice of level null', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => fakeWorker(log));
    const ready = pool.configure('42', DEFAULTS);
    const jobs = [pool.slice(COAST, 30), pool.tile(tile(1), 20), pool.tile(tile(0), 3)];
    await ready;
    await Promise.all(jobs);
    expect(log.flatMap((m) => (m.type === 'mapTile' ? [`tile ${m.tx}`] : m.type === 'slice' ? ['slice'] : []))).toEqual(['tile 0', 'tile 1', 'slice']);
    const idle = createWorkerPool(2, () => silentWorker());
    void settle(idle.slice(COAST));
    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'slice', epoch: -1, level: null }, { worker: 1, type: 'slice', epoch: -1, level: null }]);
    idle.terminate();
  });
  test('a bad line rejects with the worker\'s BAD_ARGS', async () => {
    const pool = createWorkerPool(2, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    await expect(pool.slice({ ax: 3, az: 3, bx: 3, bz: 3 })).rejects.toThrow(/^BAD_ARGS: A and B are the same point/);
    await expect(pool.slice({ ax: 0, az: 0, bx: 524288, bz: 0 })).rejects.toThrow(/^BAD_ARGS: B \(524288, 0\) is outside/);
  });
  test('the first failing part rejects the request with its error and drops its queued siblings; nothing is retried', async () => {
    const log: ToWorker[] = [];
    let n = 0;
    const gate = heldWorker(log, (m) => m.type === 'mapTile');
    const pool = createWorkerPool(2, () => (n++ === 0 ? gate : fakeWorker(log)));
    await pool.configure('42', DEFAULTS);
    const held = pool.tile(tile(0), 0);
    // Worker 1 is busy with the held tile: part 0 runs on worker 2, part 1 waits in the queue.
    const req = settle(pool.slice({ ax: 3, az: 3, bx: 3, bz: 3 }));
    expect(pool.queued).toBe(1);
    const r = await req;
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/^BAD_ARGS: A and B are the same point/);
    expect([pool.queued, rangesOf(log)]).toEqual([0, [[0, 256]]]);
    gate.flush();
    expect((await held).rgba.byteLength).toBe(262144);
    expect(rangesOf(log)).toEqual([[0, 256]]);
    // The pool still slices.
    expect((await pool.slice(COAST)).blocks.length).toBe(SLICE_SAMPLES);
  });
  test('a part reply for another range than its request rejects the request', async () => {
    const pool = createWorkerPool(2, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          inner.onmessage = (e) => {
            const d = e.data as { type: string; from?: number; to?: number };
            // Swap the two halves' ranges in the replies (the lengths still fit the range they name).
            if (d.type === 'sliceResult' && d.from === 256) { w.onmessage?.({ data: { ...d, from: 0, to: 256 } }); return; }
            w.onmessage?.(e);
          };
          inner.postMessage(msg);
        },
        terminate() {},
      };
      return w;
    });
    await pool.configure('42', DEFAULTS);
    await expect(pool.slice(COAST)).rejects.toThrow(/^slice part: samples \[0, 256\), expected \[256, 512\)$/);
  });
  test('a configure rejects every queued part with JobCancelled', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    const first = pool.configure('42', DEFAULTS);
    const req = settle(pool.slice(COAST));
    expect(pool.queued).toBe(2);
    const second = pool.configure('7', DEFAULTS);
    expect(await settle(first)).toBeInstanceOf(JobCancelled);
    expect(await req).toBeInstanceOf(JobCancelled);
    expect((await second).epoch).toBe(1);
    expect(rangesOf(log)).toEqual([]);
  });
  test('in-flight parts of a superseded epoch are aborted by the workers (ABORTED) and reject as JobCancelled; the next slice runs', async () => {
    const cell = new Int32Array(new SharedArrayBuffer(16));
    const log: ToWorker[] = [];
    const replies: unknown[] = [];
    const held = [heldWorker(log, (m) => m.type === 'slice', replies), heldWorker(log, (m) => m.type === 'slice', replies)];
    let n = 0;
    const pool = createWorkerPool(2, () => held[n++]!, { epochCells: cell });
    await pool.configure('42', DEFAULTS);
    const req = settle(pool.slice(COAST));
    expect(pool.probe().busy).toBe(2);
    const next = pool.configure('42', DEFAULTS);
    for (const w of held) w.flush();
    expect(await req).toBeInstanceOf(JobCancelled);
    expect(replies.filter((r) => (r as { code?: string }).code === 'ABORTED')).toEqual([expect.objectContaining({ type: 'error', epoch: 0 }), expect.objectContaining({ type: 'error', epoch: 0 })]);
    expect((await next).epoch).toBe(1);
    for (const w of held) w.holding = false;
    const again = await pool.slice(COAST);
    expect(same(again.blocks, single(COAST).blocks)).toBe(true);
  });
  test('a part answered after a configure without epoch cells (a stale epoch) rejects the request as JobCancelled', async () => {
    const log: ToWorker[] = [];
    const held = [heldWorker(log, (m) => m.type === 'slice'), heldWorker(log, (m) => m.type === 'slice')];
    let n = 0;
    const pool = createWorkerPool(2, () => held[n++]!);
    await pool.configure('42', DEFAULTS);
    const req = settle(pool.slice(COAST));
    const next = pool.configure('7', DEFAULTS);
    for (const w of held) w.flush();
    expect(await req).toBeInstanceOf(JobCancelled);
    expect((await next).epoch).toBe(1);
  });
});

describe('worker pool: surfaceProbe jobs (SP3c spec §6)', () => {
  const probesOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'surfaceProbe' ? [[m.jobId, m.epoch, m.x, m.y, m.z]] : []));

  test('one job per probe, at the point priority (−1) by default, resolving with the voxel\'s state and branch path', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    const sc = createSurfaceContext(ctxFor('42'));
    for (const [x, y, z] of [[-1990, -30, -1999], [-1990, 300, -1999], [-1990, -64, -1999], [5, 64, -9]] as const) {
      const want = surfaceProbe(sc, x, y, z);
      expect(await pool.surfaceProbe(x, y, z)).toEqual({ state: want.state, path: [...want.path] });
    }
    expect(probesOf(log).map((m) => m.slice(1))).toEqual([[0, -1990, -30, -1999], [0, -1990, 300, -1999], [0, -1990, -64, -1999], [0, 5, 64, -9]]);
    expect((await pool.surfaceProbe(-1990, -30, -1999)).path).toEqual(['root', 'root.rules[2]', 'root.rules[2].then']);
    pool.terminate();
  });
  test('it runs before preview tiles unless given another priority; probe shows it with level null', async () => {
    const order: string[] = [];
    const pool = createWorkerPool(1, () => {
      const w = fakeWorker([]);
      const post = w.postMessage.bind(w);
      w.postMessage = (m) => { if (m.type !== 'configure') order.push(m.type === 'mapTile' ? `tile ${m.tx}` : m.type); post(m); };
      return w;
    });
    const ready = pool.configure('42', DEFAULTS);
    const jobs = [pool.tile({ layer: 'C', level: 256, tx: 0, tz: 0 }, 0), pool.surfaceProbe(0, 70, 0), pool.tile({ layer: 'C', level: 256, tx: 1, tz: 0 }, 0), pool.surfaceProbe(1, 70, 0, 10)];
    await ready;
    await Promise.all(jobs);
    expect(order).toEqual(['surfaceProbe', 'tile 0', 'tile 1', 'surfaceProbe']);
    const idle = createWorkerPool(2, () => silentWorker());
    void settle(idle.surfaceProbe(0, 70, 0));
    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'surfaceProbe', epoch: -1, level: null }]);
    idle.terminate();
  });
  test('a bad position rejects with the worker\'s BAD_ARGS; a configure rejects a queued probe with JobCancelled', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    await expect(pool.surfaceProbe(0.5, 70, 0)).rejects.toThrow(/^BAD_ARGS: /);
    await expect(pool.surfaceProbe(0, 320, 0)).rejects.toThrow(/^BAD_ARGS: /);
    await expect(pool.surfaceProbe(524288, 70, 0)).rejects.toThrow(/^BAD_ARGS: /);
    const queued = pool.configure('42', DEFAULTS);
    const req = settle(pool.surfaceProbe(0, 70, 0));
    const next = pool.configure('7', DEFAULTS);
    expect(await settle(queued)).toBeInstanceOf(JobCancelled);
    expect(await req).toBeInstanceOf(JobCancelled);
    expect((await next).epoch).toBe(2);
    expect(probesOf(log).map((m) => m[1])).toEqual([0, 0, 0]);
    pool.terminate();
  });
});

describe('worker pool: the decorate message\'s diff (SP5a spec §2.5)', () => {
  test('the decorate message carries `diff` only when given, posted without a transfer list (cloned, not transferred)', async () => {
    const posted: Array<[ToWorker, unknown]> = [];
    let worker: ReturnType<typeof holdingWorker> | null = null;
    const pool = createWorkerPool(1, () => {
      const w = holdingWorker();
      const post = w.postMessage.bind(w);
      w.postMessage = (m, t) => { posted.push([m, t]); post(m, t); };
      worker = w;
      return w;
    });
    await pool.configure('42', DEFAULTS);
    const diff = { sy: new Uint8Array([8]), idx: new Uint16Array([4085]), value: new Uint32Array([1 << 8]) };
    const run = async (job: Promise<unknown>) => {
      worker!.release();
      expect(await job).toMatchObject({ versions: null });
    };
    await run(pool.decorate(1, 2));
    await run(pool.decorate(3, 4, diff));
    const jobs = posted.filter(([m]) => m.type !== 'configure');
    expect(jobs.map(([m]) => [m.type, 'cx' in m ? m.cx : null, 'diff' in m])).toEqual([['decorate', 1, false], ['decorate', 3, true]]);
    expect((jobs[1]![0] as { diff?: unknown }).diff).toBe(diff);
    for (const [, transfer] of jobs) expect(transfer).toBeUndefined();
    pool.terminate();
  });
});

describe('worker pool: landing jobs (SP4c spec §3.2, §6.2; D12)', () => {
  const landingsOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'landing' ? [[m.epoch, m.x, m.z]] : []));

  test('one job per landing, resolving with landingSurface and the column\'s surfaceWaterLevel; probe shows it with level null', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    const ctx = ctxFor('42');
    for (const [x, z] of [[-320, 128], [0, 0], [5, -9]] as const) {
      expect(await pool.landing(x, z)).toEqual({ surface: landingSurface(ctx, x, z), water: columnPoint(ctx, x, z).surfaceWaterLevel });
    }
    expect(landingsOf(log)).toEqual([[0, -320, 128], [0, 0, 0], [0, 5, -9]]);
    pool.terminate();
    const idle = createWorkerPool(2, () => silentWorker());
    void settle(idle.landing(0, 0));
    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'landing', epoch: -1, level: null }]);
    idle.terminate();
  });

  test('landing runs before 20 queued tiles under (\'world\', 1) and before a queued point', () => {
    const log: ToWorker[] = [];
    const w = silentWorker(log);
    const pool = createWorkerPool(1, () => w);
    pool.setAuxPolicy('world', 1);
    const jobs: Array<Promise<unknown>> = [settle(pool.tile(tile(0), 0))];
    for (let i = 1; i <= 20; i++) jobs.push(settle(pool.tile(tile(i), i)));
    jobs.push(settle(pool.point(1, 2)), settle(pool.landing(-320, 128)));
    expect(pool.queued).toBe(22);
    const finish = () => {
      const m = log.at(-1) as unknown as { jobId: number; epoch: number };
      w.onmessage?.({ data: { type: 'error', jobId: m.jobId, epoch: m.epoch, code: 'INTERNAL', message: 'x' } });
    };
    // The running tile ends: the landing (−2) goes first, then the point (−1), then the tiles.
    finish();
    expect(log.at(-1)).toMatchObject({ type: 'landing', x: -320, z: 128 });
    finish();
    expect(log.at(-1)).toMatchObject({ type: 'point' });
    finish();
    expect(log.at(-1)).toMatchObject({ type: 'mapTile', tx: 1 });
    pool.terminate();
    return Promise.all(jobs);
  });

  test('a configure rejects a queued landing with JobCancelled', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    const queued = pool.configure('42', DEFAULTS);
    const req = settle(pool.landing(0, 0));
    const next = pool.configure('7', DEFAULTS);
    expect(await settle(queued)).toBeInstanceOf(JobCancelled);
    expect(await req).toBeInstanceOf(JobCancelled);
    expect((await next).epoch).toBe(2);
    expect(landingsOf(log)).toEqual([]);
    pool.terminate();
  });

  test('a landing at a position outside the window rejects with the worker\'s BAD_ARGS', async () => {
    const pool = createWorkerPool(2, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    await expect(pool.landing(524288, 0)).rejects.toThrow(/^BAD_ARGS: /);
    await expect(pool.landing(0, -524289)).rejects.toThrow(/^BAD_ARGS: /);
    expect((await pool.landing(-524288, 524287)).surface).toBeTypeOf('number');
    pool.terminate();
  });
});

describe('worker pool: the world and aux lanes and the aux policy (SP4c spec §6.1, §6.2; D11)', () => {
  /** A 32-bit LCG in [0, 1), so every run draws the same queues. */
  const lcg = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  type Posted = ToWorker & { readonly jobId: number; readonly epoch: number };
  /**
   * A pool of `n` silent workers (unconfigured: its jobs run at epoch −1). `finish(w)` answers worker w's job with an
   * INTERNAL error, which frees it; `running()` counts the jobs in flight by lane; every job is settled so none is left unhandled.
   */
  const manualPool = (n: number) => {
    const logs: ToWorker[][] = Array.from({ length: n }, () => []);
    const workers = logs.map((l) => silentWorker(l));
    let k = 0;
    const pool = createWorkerPool(n, () => workers[k++]!);
    const finish = (w: number) => {
      const m = logs[w]!.at(-1) as Posted;
      workers[w]!.onmessage?.({ data: { type: 'error', jobId: m.jobId, epoch: m.epoch, code: 'INTERNAL', message: 'x' } });
    };
    const WORLD = new Set(['terrain', 'decorate', 'light', 'meshColumn']);
    const running = () => {
      const jobs = pool.probe().jobs;
      return { world: jobs.filter((j) => WORLD.has(j.type)).length, tiles: jobs.filter((j) => j.type === 'mapTile').length, all: jobs.length };
    };
    /** The worker running a job of `type`, or −1. */
    const workerOf = (type: string) => pool.probe().jobs.find((j) => j.type === type)?.worker ?? -1;
    return { pool, workers, logs, finish, running, workerOf };
  };
  /** World job `i` of a mixed run: terrain, decorate, light and meshColumn in turn, at column (i, 0). */
  const worldJob = (pool: ReturnType<typeof manualPool>['pool'], i: number) => {
    const kind = i % 4;
    return settle<unknown>(kind === 0 ? pool.terrain(i, 0) : kind === 1 ? pool.decorate(i, 0) : kind === 2 ? pool.light(i, 0) : pool.meshColumn(i, 0));
  };

  test('the aux lane yields the same order as today\'s sort on 200 randomised queues of tiles, points, stats and slices', async () => {
    const rnd = lcg(4242);
    for (let round = 0; round < 200; round++) {
      const { pool, logs, finish } = manualPool(1);
      // Today's pump (SP4b): sort the queue by (priority, id) and take the first, on every assignment.
      const queue: Array<{ priority: number; id: number; label: number }> = [];
      let busy = false;
      const want: number[] = [];
      const pump = () => {
        if (busy || queue.length === 0) return;
        queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
        want.push(queue.shift()!.label);
        busy = true;
      };
      const jobs: Array<Promise<unknown>> = [];
      let label = 0;
      const steps = 10 + Math.floor(rnd() * 50);
      for (let s = 0; s < steps || busy; s++) {
        if (s < steps && (rnd() < 0.65 || !busy)) {
          // Each request is one job on a one-worker pool; its label rides in an argument the posted message carries.
          const l = label++;
          const r = rnd();
          let priority: number;
          if (r < 0.5) {
            priority = (rnd() < 0.5 ? 0 : 1000) + Math.floor(rnd() * 8);
            jobs.push(settle(pool.tile(tile(l), priority)));
          } else if (r < 0.7) {
            priority = -1;
            jobs.push(settle(pool.point(l, 0)));
          } else if (r < 0.85) {
            priority = 500;
            jobs.push(settle(pool.stats('biomeShares', l + 1, { len: biomeSharesLength() })));
          } else {
            priority = 500;
            jobs.push(settle(pool.slice({ ax: l, az: 0, bx: l + 10, bz: 0 })));
          }
          queue.push({ priority, id: l, label: l });
          pump();
        } else {
          finish(0);
          busy = false;
          pump();
        }
      }
      await Promise.all(jobs);
      const got = logs[0]!.map((m) => {
        if (m.type === 'mapTile') return m.tx;
        if (m.type === 'point') return m.x;
        if (m.type === 'stats') return m.to - 1;
        if (m.type === 'slice') return m.ax;
        throw new Error(`unexpected ${m.type}`);
      });
      expect(got, `round ${round}`).toEqual(want);
    }
  });

  test('the default policy is (\'world\', size): interactive jobs, then the world FIFO, then the rest by (priority, id)', () => {
    const { pool, logs, finish } = manualPool(1);
    void settle(pool.point(0, 0));
    void settle(pool.tile(tile(1), 0));
    void settle(pool.stats('biomeShares', 3, { len: biomeSharesLength() }));
    void settle(pool.terrain(2, 0));
    void settle(pool.point(3, 0));
    for (let k = 0; k < 4; k++) finish(0);
    expect(logs[0]!.map((m) => m.type)).toEqual(['point', 'point', 'terrain', 'mapTile', 'stats']);
    pool.terminate();
  });

  test('interactive first and uncapped: with (\'world\', 1) and a tile running, a queued point runs on the next free worker and does not count against the cap', () => {
    const { pool, finish, workerOf, running } = manualPool(2);
    pool.setAuxPolicy('world', 1);
    void settle(pool.tile(tile(0), 5));
    void worldJob(pool, 0);
    expect([workerOf('mapTile'), workerOf('terrain')]).toEqual([0, 1]);
    void settle(pool.point(1, 2));
    void settle(pool.tile(tile(1), 5));
    void worldJob(pool, 4);
    expect(pool.queued).toBe(3);
    // The world job ends: the point goes before the queued world job.
    finish(1);
    expect([workerOf('mapTile'), workerOf('point'), running().world]).toEqual([0, 1, 0]);
    // The tile ends: the world job goes first.
    finish(0);
    expect([workerOf('terrain'), workerOf('point'), running().tiles]).toEqual([0, 1, 0]);
    // The world job ends: the point is running, yet the queued tile runs (the point does not count against the cap).
    finish(0);
    expect([workerOf('mapTile'), workerOf('point'), pool.queued]).toEqual([0, 1, 0]);
    pool.terminate();
  });

  test('(\'world\', 1) on 4 workers, the pool ready, 6 tiles enqueued and then 6 world jobs: 1 tile and 3 world jobs run; with the 6 world jobs enqueued first (or all 12 released at once), 4 world jobs and no tile', async () => {
    {
      const { pool, running } = manualPool(4);
      pool.setAuxPolicy('world', 1);
      for (let i = 0; i < 6; i++) void settle(pool.tile(tile(i), i));
      for (let i = 0; i < 6; i++) void worldJob(pool, i);
      expect(running()).toEqual({ world: 3, tiles: 1, all: 4 });
      expect(pool.queued).toBe(8);
      pool.terminate();
    }
    {
      const { pool, running } = manualPool(4);
      pool.setAuxPolicy('world', 1);
      for (let i = 0; i < 6; i++) void worldJob(pool, i);
      for (let i = 0; i < 6; i++) void settle(pool.tile(tile(i), i));
      expect(running()).toEqual({ world: 4, tiles: 0, all: 4 });
      pool.terminate();
    }
    {
      const { pool, workers, running } = manualPool(4);
      pool.setAuxPolicy('world', 1);
      // Queued behind the configure's barrier, released at once when it resolves.
      const ready = pool.configure('42', DEFAULTS);
      for (let i = 0; i < 6; i++) void settle(pool.tile(tile(i), i));
      for (let i = 0; i < 6; i++) void worldJob(pool, i);
      expect(running().all).toBe(0);
      for (const w of workers) w.onmessage?.({ data: { type: 'ready', epoch: 0, stageHashes: {}, genKey: '0000000000000000' } });
      await ready;
      expect(running()).toEqual({ world: 4, tiles: 0, all: 4 });
      pool.terminate();
    }
  });

  test('I2: (\'aux\', 3) on 4 workers with 20 tiles queued and world jobs waiting: one world job is always running', () => {
    const rnd = lcg(4242);
    const { pool, finish, running } = manualPool(4);
    pool.setAuxPolicy('aux', 3);
    for (let i = 0; i < 20; i++) void settle(pool.tile(tile(i), i));
    // The aux lane goes first, under the cap: the fourth worker waits for the world.
    expect(running()).toEqual({ world: 0, tiles: 3, all: 3 });
    for (let i = 0; i < 40; i++) void worldJob(pool, i);
    expect(running()).toEqual({ world: 1, tiles: 3, all: 4 });
    let tilesLeft = 20;
    let worldLeft = 40;
    while (tilesLeft > 0) {
      const w = Math.floor(rnd() * 4);
      const type = pool.probe().jobs.find((j) => j.worker === w)!.type;
      finish(w);
      if (type === 'mapTile') tilesLeft--;
      else worldLeft--;
      const r = running();
      const at = `${tilesLeft} tiles and ${worldLeft} world jobs left`;
      expect(r.world, at).toBeGreaterThanOrEqual(1);
      // While three or more tiles are left, the cap holds them to 3 and the fourth worker runs the world.
      if (tilesLeft >= 3) expect([r.world, r.tiles], at).toEqual([1, 3]);
    }
    pool.terminate();
  });

  test('the world held, (\'aux\', 4): all 4 workers take tiles', () => {
    const { pool, running } = manualPool(4);
    pool.setAuxPolicy('world', 1);
    for (let i = 0; i < 10; i++) void settle(pool.tile(tile(i), i));
    expect(running()).toEqual({ world: 0, tiles: 1, all: 1 });
    // A changed policy pumps at once.
    pool.setAuxPolicy('aux', 4);
    expect(running()).toEqual({ world: 0, tiles: 4, all: 4 });
    pool.terminate();
  });

  test('`setAuxPolicy` with unchanged values does nothing (no pump)', () => {
    const { pool, logs, running } = manualPool(2);
    pool.setAuxPolicy('world', 1);
    for (let i = 0; i < 3; i++) void settle(pool.tile(tile(i), i));
    const posted = () => logs.reduce((s, l) => s + l.length, 0);
    expect([posted(), pool.queued]).toEqual([1, 2]);
    for (let k = 0; k < 5; k++) pool.setAuxPolicy('world', 1);
    expect([posted(), pool.queued, running().tiles]).toEqual([1, 2, 1]);
    // Only a change pumps: one more tile under a cap of 2.
    pool.setAuxPolicy('world', 2);
    expect([posted(), pool.queued, running().tiles]).toEqual([2, 1, 2]);
    expect(() => pool.setAuxPolicy('world', 0)).toThrow(RangeError);
    expect(() => pool.setAuxPolicy('world', 1.5)).toThrow(RangeError);
    expect(() => pool.setAuxPolicy('map' as 'aux', 1)).toThrow(RangeError);
    pool.terminate();
  });

  test('`cancelTiles` and `cancelWorld` filter their lane; `configure` rejects both lanes; a failed slice part drops its group\'s queued parts; a dead worker\'s last failure rejects both lanes', async () => {
    {
      const { pool } = manualPool(1);
      void settle(pool.point(0, 0));
      const t1 = settle(pool.tile(tile(1), 1));
      const t2 = settle(pool.tile(tile(2), 2));
      const T = settle(pool.terrain(3, 0));
      const D = settle(pool.decorate(4, 0));
      expect(pool.queued).toBe(4);
      pool.cancelTiles((r) => r.tx === 1);
      expect(await t1).toBeInstanceOf(JobCancelled);
      pool.cancelWorld((stage) => stage === 'T');
      expect(await T).toBeInstanceOf(JobCancelled);
      expect([pool.queued, pool.probe().queued]).toEqual([2, 2]);
      void settle(pool.configure('42', DEFAULTS));
      expect(await t2).toBeInstanceOf(JobCancelled);
      expect(await D).toBeInstanceOf(JobCancelled);
      expect(pool.queued).toBe(0);
      pool.terminate();
    }
    {
      const { pool, logs, finish, workerOf } = manualPool(2);
      void settle(pool.point(0, 0));
      void settle(pool.point(1, 0));
      const sl = settle(pool.slice({ ax: 0, az: 0, bx: 10, bz: 0 }));
      const later = settle(pool.tile(tile(9), 1000));
      expect(pool.queued).toBe(3);
      // Worker 0 takes the slice's first part (500 before the tile's 1000), which fails: its queued sibling is dropped,
      // and the freed worker takes the tile.
      finish(0);
      expect(logs[0]!.at(-1)).toMatchObject({ type: 'slice', from: 0, to: 256 });
      finish(0);
      expect(await sl).toBeInstanceOf(Error);
      expect([pool.queued, workerOf('mapTile')]).toEqual([0, 0]);
      finish(1);
      expect([pool.probe().busy, logs.flat().filter((m) => m.type === 'slice').length]).toEqual([1, 1]);
      void later;
      pool.terminate();
    }
    {
      const { pool, workers } = manualPool(2);
      void settle(pool.point(0, 0));
      void settle(pool.point(1, 0));
      const tl = settle(pool.tile(tile(0), 0));
      const T = settle(pool.terrain(0, 0));
      workers[0]!.onerror?.({});
      expect(pool.queued).toBe(2);
      workers[1]!.onerror?.({});
      expect(await tl).toBeInstanceOf(WorkerFailed);
      expect(await T).toBeInstanceOf(WorkerFailed);
      expect(pool.queued).toBe(0);
    }
  });

  test('the world FIFO keeps issue order', () => {
    const { pool, logs, finish } = manualPool(1);
    pool.setAuxPolicy('aux', 1);
    void settle(pool.point(0, 0));
    const order = [7, 2, 9, 0, 5, 3, 8, 1];
    order.forEach((cx, i) => {
      void worldJob(pool, cx);
      if (i % 3 === 0) void settle(pool.tile(tile(cx), 1000 - cx));
    });
    // Each finish frees the one worker; ('aux', 1) runs the queued tiles first, then the world jobs in their issue order.
    for (let k = 0; k < order.length + 3; k++) finish(0);
    const world = logs[0]!.filter((m) => m.type === 'terrain' || m.type === 'decorate' || m.type === 'light' || m.type === 'meshColumn');
    expect(world.map((m) => (m as { cx: number }).cx)).toEqual(order);
    expect(logs[0]!.filter((m) => m.type === 'mapTile').length).toBe(3);
    pool.terminate();
  });
});

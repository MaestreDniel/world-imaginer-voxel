import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, JobCancelled, poolSize, WorkerFailed, type WorkerLike } from '../../src/engine/workerPool';
import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../../src/metrics/biomeShares';
import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../../src/metrics/splineStats';
import type { KnotPath } from '../../src/core/spline/types';
import type { ToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

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
 * them at once (so the handler reads the abort cell as it is then) and replies asynchronously.
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

describe('worker pool: abort cell (SP2b spec §2.2)', () => {
  test('the cell holds the pool epoch; configure stores the new epoch before posting and posts the shared buffer', async () => {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const log: ToWorker[] = [];
    const seen: number[] = [];
    const pool = createWorkerPool(2, () => {
      const w = fakeWorker(log);
      const post = w.postMessage.bind(w);
      w.postMessage = (m, t) => { if (m.type === 'configure') seen.push(Atomics.load(cell, 0)); post(m, t); };
      return w;
    }, { abortCell: cell });
    expect([pool.abortable, Atomics.load(cell, 0)]).toEqual([true, -1]);
    await pool.configure('42', DEFAULTS);
    await pool.configure('7', DEFAULTS);
    expect(seen).toEqual([0, 0, 1, 1]);
    expect(log.filter((m) => m.type === 'configure').every((m) => m.type === 'configure' && m.abort === cell.buffer)).toBe(true);
  });
  test('without a cell the pool is not abortable and posts abort: null', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(1, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    expect(pool.abortable).toBe(false);
    expect(log[0]).toMatchObject({ type: 'configure', abort: null });
  });
  test('an in-flight tile of a superseded epoch is aborted by the worker and rejects as JobCancelled', async () => {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const replies: unknown[] = [];
    const pool = createWorkerPool(1, () => fakeWorker([], false, replies), { abortCell: cell });
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
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const log: ToWorker[] = [];
    const replies: unknown[] = [];
    let n = 0;
    const slow = heldWorker(log, (m) => m.type === 'stats', replies);
    const pool = createWorkerPool(2, () => (n++ === 0 ? fakeWorker(log, false, replies) : slow), { abortCell: cell });
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

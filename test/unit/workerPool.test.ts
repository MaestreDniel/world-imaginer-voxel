import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, JobCancelled, poolSize, WorkerFailed, type WorkerLike } from '../../src/engine/workerPool';
import type { ToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';

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
    expect(await settle(pool.configure('7', DEFAULTS))).toBeInstanceOf(WorkerFailed);
  });
});

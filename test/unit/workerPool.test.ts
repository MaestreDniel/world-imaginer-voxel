import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, JobCancelled, poolSize, type WorkerLike } from '../../src/engine/workerPool';
import type { ToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';

/** A fake worker running the real handler asynchronously; `log` records every message it receives. */
function fakeWorker(log: ToWorker[], tamper = false): WorkerLike {
  const h = createTaskHandler();
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) {
      log.push(msg);
      setTimeout(() => {
        const r = h.handle(msg).msg;
        const data = tamper && r.type === 'ready' ? { ...r, stageHashes: { ...r.stageHashes, climate: '0000000000000000' } } : r;
        w.onmessage?.({ data });
      }, 0);
    },
    terminate() {},
  };
  return w;
}

const tile = (tx: number) => ({ layer: 'C' as const, level: 256 as const, tx, tz: 0 });

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
    expect(bufs.every((b) => b.byteLength === 262144)).toBe(true);
    expect(log.filter((m) => m.type === 'mapTile').map((m) => (m as { tx: number }).tx)).toEqual([1, 3, 5]);
  });
  test('a worker error rejects the job instead of hanging', async () => {
    const pool = createWorkerPool(1, () => {
      const inner = fakeWorker([]);
      const w: WorkerLike = {
        onmessage: null,
        postMessage(msg) {
          if (msg.type === 'mapTile') { setTimeout(() => w.onmessage?.({ data: { type: 'error', jobId: msg.jobId, code: 'INTERNAL', message: 'boom' } }), 0); return; }
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

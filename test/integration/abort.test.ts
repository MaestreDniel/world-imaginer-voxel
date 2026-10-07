import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../../src/metrics/biomeShares';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import { ctxFor } from '../harness/gen';

/**
 * Cooperative abort through the SharedArrayBuffer epoch cell, in real worker threads (SP2b spec §2.2, §8, §12).
 * The 50 ms bound is the handler's: from `Atomics.store` here to `handle` returning in the worker, both read on
 * `process.hrtime`, the monotonic clock all threads of the process share. The delivery of the reply to this
 * thread is not part of it: on a loaded runner that alone can take tens of ms, which `stall` stands in for. The
 * two timing tests retry twice (a worker thread can still wait for a CPU); the ABORTED and byte-identity checks
 * hold on every attempt.
 */
let script = '';
const workers: Worker[] = [];

beforeAll(async () => {
  script = await buildNodeTaskWorker('abortHandler', { stamp: true });
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

const start = (): Worker => {
  const w = new Worker(script);
  workers.push(w);
  return w;
};
const sameBytes = (a: unknown, b: unknown) => Buffer.from(a as ArrayBuffer).equals(Buffer.from(b as ArrayBuffer));
const configure = (epoch: number, abort: SharedArrayBuffer | null) => ({ type: 'configure', epoch, seedText: '42', params: DEFAULTS, abort });
/** Milliseconds on the clock the worker's `handledAt` uses (test/harness/nodeWorker.ts). */
const clock = () => Number(process.hrtime.bigint()) / 1e6;
/** Blocks this thread for `ms` without using a CPU, as a loaded runner delays the delivery of the worker's reply here. */
const stall = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** The handler's stop time: from the store to `handle` returning in the worker. */
const stopMs = (m: Record<string, unknown>, storedAt: number) => (m['handledAt'] as number) - storedAt;
const tile = (jobId: number, epoch: number, layer: string, level: number) => ({ type: 'mapTile', jobId, epoch, layer, level, tx: 0, tz: 0 });

test('a level-4 relief tile stops within 50 ms of Atomics.store and replies ABORTED; the next tiles equal a fresh worker\'s', { retry: 2, timeout: 120_000 }, async () => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const w = start();
  Atomics.store(cell, 0, 1);
  expect((await ask(w, configure(1, cell.buffer)))['type']).toBe('ready');
  // The whole tile takes ≈ 450 ms on one thread; an ABORTED reply shows the store landed mid-tile.
  const reply = ask(w, tile(1, 1, 'relief', 4));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const storedAt = clock();
  Atomics.store(cell, 0, 2);
  stall(60);
  const m = await reply;
  expect(m).toMatchObject({ type: 'error', jobId: 1, epoch: 1, code: 'ABORTED' });
  const abortMs = stopMs(m, storedAt);
  expect(abortMs, 'the stamp is after the store on the shared clock').toBeGreaterThan(0);
  expect(abortMs, `the handler returned ${abortMs.toFixed(1)} ms after the store`).toBeLessThan(50);

  // The pool's next configure, then tiles of the new epoch, against a worker that never aborted.
  expect((await ask(w, configure(2, cell.buffer)))['type']).toBe('ready');
  const fresh = start();
  expect((await ask(fresh, configure(1, null)))['type']).toBe('ready');
  let jobId = 2;
  for (const [layer, level] of [['relief', 4], ['relief', 256], ['biome', 256], ['biome', 4]] as const) {
    jobId++;
    const a = await ask(w, tile(jobId, 2, layer, level));
    const b = await ask(fresh, tile(jobId, 1, layer, level));
    expect([layer, level, a['type'], b['type']]).toEqual([layer, level, 'tile', 'tile']);
    expect(sameBytes(a['rgba'], b['rgba']), `${layer} ${level} rgba`).toBe(true);
    if (layer === 'biome') expect(sameBytes(a['ids'], b['ids']), `${layer} ${level} ids`).toBe(true);
  }
});

test('a biomeShares stats slice stops within 50 ms of Atomics.store and replies ABORTED; the next slice equals the direct sums', { retry: 2, timeout: 120_000 }, async () => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const w = start();
  const len = biomeSharesLength();
  const stats = (jobId: number, epoch: number, from: number, to: number) => ({ type: 'stats', jobId, epoch, kind: 'biomeShares', from, to, args: { len } });
  Atomics.store(cell, 0, 1);
  expect((await ask(w, configure(1, cell.buffer)))['type']).toBe('ready');
  // The whole stream takes ≈ 0.7 s on one thread; the handler polls the cell every 256 points.
  const reply = ask(w, stats(1, 1, 0, BIOME_SHARES_POINTS));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const storedAt = clock();
  Atomics.store(cell, 0, 2);
  stall(60);
  const m = await reply;
  expect(m).toMatchObject({ type: 'error', jobId: 1, epoch: 1, code: 'ABORTED' });
  const abortMs = stopMs(m, storedAt);
  expect(abortMs, 'the stamp is after the store on the shared clock').toBeGreaterThan(0);
  expect(abortMs, `the handler returned ${abortMs.toFixed(1)} ms after the store`).toBeLessThan(50);

  expect((await ask(w, configure(2, cell.buffer)))['type']).toBe('ready');
  const next = await ask(w, stats(2, 2, 1000, 3000));
  expect(next).toMatchObject({ type: 'statsResult', jobId: 2, epoch: 2, kind: 'biomeShares' });
  const want = new Float64Array(len);
  biomeSharesInto(ctxFor('42'), biomeSharePoints(), 1000, 3000, want);
  expect(Array.from(new Float64Array(next['data'] as ArrayBuffer))).toEqual(Array.from(want));
});

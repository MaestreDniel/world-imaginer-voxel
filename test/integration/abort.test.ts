import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { buildNodeTaskWorker } from '../harness/nodeWorker';

/** Cooperative abort through the SharedArrayBuffer epoch cell, in real worker threads (SP2b spec §2.2, §8, §12). */
let script = '';
const workers: Worker[] = [];

beforeAll(async () => {
  script = await buildNodeTaskWorker('abortHandler');
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

const start = (): Worker => {
  const w = new Worker(script);
  workers.push(w);
  return w;
};
const ask = (w: Worker, msg: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); });
const sameBytes = (a: unknown, b: unknown) => Buffer.from(a as ArrayBuffer).equals(Buffer.from(b as ArrayBuffer));
const configure = (epoch: number, abort: SharedArrayBuffer | null) => ({ type: 'configure', epoch, seedText: '42', params: DEFAULTS, abort });
const tile = (jobId: number, epoch: number, layer: string, level: number) => ({ type: 'mapTile', jobId, epoch, layer, level, tx: 0, tz: 0 });

test('a level-4 relief tile stops within 50 ms of Atomics.store and replies ABORTED; the next tiles equal a fresh worker\'s', async () => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const w = start();
  Atomics.store(cell, 0, 1);
  expect((await ask(w, configure(1, cell.buffer)))['type']).toBe('ready');
  // The whole tile takes ≈ 450 ms on one thread; an ABORTED reply shows the store landed mid-tile.
  const reply = ask(w, tile(1, 1, 'relief', 4)).then((m) => ({ m, at: performance.now() }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const storedAt = performance.now();
  Atomics.store(cell, 0, 2);
  const { m, at } = await reply;
  expect(m).toMatchObject({ type: 'error', jobId: 1, epoch: 1, code: 'ABORTED' });
  const abortMs = at - storedAt;
  expect(abortMs, `answered ${abortMs.toFixed(1)} ms after the store`).toBeLessThan(50);

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
}, 120_000);

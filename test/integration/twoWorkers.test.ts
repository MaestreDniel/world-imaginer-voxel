import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { buildNodeTaskWorker } from '../harness/nodeWorker';

const workers: Worker[] = [];

beforeAll(async () => {
  const script = await buildNodeTaskWorker('taskHandler');
  for (let i = 0; i < 2; i++) workers.push(new Worker(script));
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

const ask = (w: Worker, msg: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); });

test('two workers produce byte-identical tiles and agree on the stage hashes', async () => {
  const ready = await Promise.all(workers.map((w) => ask(w, { type: 'configure', epoch: 1, seedText: '42', params: DEFAULTS, abort: null })));
  expect(ready[0]!['type']).toBe('ready');
  expect(ready[1]).toEqual(ready[0]);
  let jobId = 0;
  for (const level of [256, 64, 4]) {
    for (const layer of ['biome', 'relief', 'rivers', 'C']) {
      for (const [tx, tz] of [[0, 0], [-1, 1]]) {
        jobId++;
        const msg = { type: 'mapTile', jobId, epoch: 1, layer, level, tx, tz };
        const [a, b] = await Promise.all(workers.map((w) => ask(w, msg)));
        expect(a!['type'], JSON.stringify(a)).toBe('tile');
        expect(Buffer.from(a!['rgba'] as ArrayBuffer).equals(Buffer.from(b!['rgba'] as ArrayBuffer))).toBe(true);
        if (layer === 'biome') expect(Buffer.from(a!['ids'] as ArrayBuffer).equals(Buffer.from(b!['ids'] as ArrayBuffer))).toBe(true);
      }
    }
  }
  expect(jobId).toBe(24);
}, 180_000);

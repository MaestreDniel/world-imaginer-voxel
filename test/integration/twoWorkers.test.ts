import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';

const OUT = fileURLToPath(new URL('../.cache/taskHandler/', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../src/workers/taskHandler.ts', import.meta.url));
const workers: Worker[] = [];

/** Bundles the pure handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2). */
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  await build({
    configFile: false, logLevel: 'silent',
    build: { outDir: OUT, emptyOutDir: true, minify: false, lib: { entry: ENTRY, formats: ['es'], fileName: () => 'taskHandler.mjs' } },
  });
  writeFileSync(`${OUT}node-worker.mjs`, [
    "import { parentPort } from 'node:worker_threads';",
    "import { createTaskHandler } from './taskHandler.mjs';",
    'const h = createTaskHandler();',
    "parentPort.on('message', (m) => { const r = h.handle(m); parentPort.postMessage(r.msg, r.transfer); });",
  ].join('\n'));
  for (let i = 0; i < 2; i++) workers.push(new Worker(`${OUT}node-worker.mjs`));
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

const ask = (w: Worker, msg: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); });

test('two workers produce byte-identical tiles and agree on the stage hashes', async () => {
  const ready = await Promise.all(workers.map((w) => ask(w, { type: 'configure', epoch: 1, seedText: '42', params: DEFAULTS })));
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
      }
    }
  }
  expect(jobId).toBe(24);
}, 180_000);

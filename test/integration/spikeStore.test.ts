/**
 * The spike's shared store (SP4a spec §1.2 item 6, ruling P18): `runStoreSpike` over six real worker threads running
 * the spike's pure handler (`src/workers/spikeStoreHandler.ts`, bundled by `buildNodeTaskWorker`), each wrapped as a
 * `SpikeWorkerLike`. The browser run is the spike page's; this is the same logic under Node.
 */
import { Worker } from 'node:worker_threads';
import { beforeAll, expect, test } from 'vitest';
import { runStoreSpike, type SpikeWorkerLike } from '../../src/engine/spikeStore';
import { buildNodeTaskWorker } from '../harness/nodeWorker';

let script = '';

beforeAll(async () => {
  script = await buildNodeTaskWorker('spikeStore', { entry: 'src/workers/spikeStoreHandler.ts' });
}, 120_000);

/** A worker_threads Worker behind the browser Worker's surface that `runStoreSpike` uses. */
function spawnNode(): SpikeWorkerLike {
  const w = new Worker(script);
  const like: SpikeWorkerLike = {
    postMessage: (msg, transfer) => { w.postMessage(msg, transfer as never); },
    onmessage: null,
    onerror: null,
    terminate: () => { void w.terminate(); },
  };
  w.on('message', (data: unknown) => like.onmessage?.({ data }));
  w.on('error', (e: unknown) => like.onerror?.(e));
  return like;
}

test('six workers write, grow the pools and read each other\'s columns; the page reads them all', async () => {
  const r = await runStoreSpike({ spawn: spawnNode });
  expect(r.errors).toEqual([]);
  expect(r.reservedBlockMiB).toBe(768);
  expect(r.reservedByteMiB).toBe(512);
  // 6 workers' reads of 32 columns each, plus the page's reads of all 192.
  expect(r.crossReadsTotal).toBe(384);
  expect(r.crossReadsOk).toBe(r.crossReadsTotal);
  expect(r.grewTo.blockMiB).toBeGreaterThan(1);
  expect(r.grewTo.byteMiB).toBeGreaterThan(1);
}, 120_000);

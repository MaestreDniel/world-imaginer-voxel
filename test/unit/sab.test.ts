import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';

const WORKER_URL = new URL('./fixtures/sabWorker.mjs', import.meta.url);
const ADDS = 100_000;
const ROUNDS = 50;
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.terminate()));
});

function run(role: 0 | 1, sab: SharedArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { workerData: { sab, role, adds: ADDS, rounds: ROUNDS } });
    workers.push(w);
    w.once('message', (m: { ok: boolean; error?: string }) => (m.ok ? resolve() : reject(new Error(m.error))));
    w.once('error', reject);
  });
}

test('SAB round-trip across 2 worker_threads', { repeats: 5 }, async () => {
  const sab = new SharedArrayBuffer(4 * (3 + 2 * ROUNDS));
  const i32 = new Int32Array(sab);
  await Promise.all([run(0, sab), run(1, sab)]);
  expect(Atomics.load(i32, 0)).toBe(2 * ADDS);
  expect(Atomics.load(i32, 2)).toBe(2 * ROUNDS);
  const log = Array.from(i32.subarray(3, 3 + 2 * ROUNDS));
  expect(log).toEqual(Array.from({ length: 2 * ROUNDS }, (_, k) => k % 2));
});

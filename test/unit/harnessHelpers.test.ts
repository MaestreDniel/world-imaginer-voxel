import { Worker } from 'node:worker_threads';
import { describe, expect, test } from 'vitest';
import { integerEnv } from '../harness/env';
import { ask } from '../harness/nodeWorker';

/**
 * SP3a §10's harness minors, carried by SP3b (spec §7): one shared `ask()` for every worker-thread test (the slab
 * fuzz's copy never settled when its worker exited), and integer environment knobs that refuse what `Number()` would
 * silently turn into a seed (`SLAB_FUZZ_SEED=abc` became seed 0).
 */
describe('ask (test/harness/nodeWorker.ts)', () => {
  const worker = (body: string) => new Worker(`const { parentPort } = require('node:worker_threads');\n${body}`, { eval: true });
  const listeners = (w: Worker) => ['message', 'error', 'exit'].map((e) => w.listenerCount(e));

  test('resolves with the single reply and leaves no listener behind', async () => {
    const w = worker("parentPort.on('message', (m) => parentPort.postMessage({ echo: m }));");
    try {
      expect(await ask(w, 5)).toEqual({ echo: 5 });
      expect(await ask<{ echo: string }>(w, 'x')).toEqual({ echo: 'x' });
      expect(listeners(w)).toEqual([0, 0, 0]);
    } finally {
      await w.terminate();
    }
  });

  test('rejects when the worker exits before replying', async () => {
    const w = worker("parentPort.once('message', () => process.exit(3));");
    await expect(ask(w, 1)).rejects.toThrow(/worker exited \(3\) before replying/);
    expect(listeners(w)).toEqual([0, 0, 0]);
  });

  test('rejects with the worker\'s uncaught error', async () => {
    const w = worker("parentPort.once('message', () => { throw new Error('boom'); });");
    await expect(ask(w, 1)).rejects.toThrow(/boom/);
    await w.terminate();
  });
});

describe('integerEnv (test/harness/env.ts)', () => {
  test('unset is the fallback; an integer is read', () => {
    expect(integerEnv('SEED', 1, {})).toBe(1);
    expect(integerEnv('SEED', 1, { SEED: '42' })).toBe(42);
    expect(integerEnv('SEED', 1, { SEED: '-7' })).toBe(-7);
    expect(integerEnv('SEED', 1, { SEED: '0' })).toBe(0);
  });

  test.each(['abc', '', ' 3', '1.5', '1e3', '0x10', '+4', '9007199254740993', 'NaN'])('%j is refused, naming the variable', (v) => {
    expect(() => integerEnv('SLAB_FUZZ_SEED', 1, { SLAB_FUZZ_SEED: v })).toThrow(/SLAB_FUZZ_SEED must be an integer/);
  });
});

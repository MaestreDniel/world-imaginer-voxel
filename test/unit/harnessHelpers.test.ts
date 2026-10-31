import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, test } from 'vitest';
import { todayStateTable } from '../../src/persist/saves';
import { SIM_DRAIN_MS } from '../../src/workers/simHandler';
import { integerEnv } from '../harness/env';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';

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

describe('buildNodeTaskWorker (test/harness/nodeWorker.ts)', () => {
  const sim = (dir: string, renew: boolean) =>
    buildNodeTaskWorker(dir, { entry: 'src/workers/simHandler.ts', factory: 'createMemorySimHandler', retryMs: SIM_DRAIN_MS, renew });
  const load = (id: number) => ({
    type: 'load', id, db: 'harness-renew', worldId: 'w', flushSeq: 0, genKey: '0123456789abcdef', updated: 1, stateTable: todayStateTable(), rewrite: null,
  });

  test('`renew` adds the `__renew` branch to the wrapper (with `let h` and the drain check); without it the message reaches the handler (BAD_MESSAGE)', async () => {
    const [renewing, plain] = await Promise.all([sim('harnessHelpers-renew', true), sim('harnessHelpers-plain', false)]);
    const text = readFileSync(renewing, 'utf8');
    expect(text).toContain('let h = createMemorySimHandler();');
    expect(text).toContain("m.type === '__renew'");
    expect(text).toContain("if ((h.drain?.() ?? 0) > 0) { parentPort.postMessage({ type: 'renewed', ok: false }); return; }");
    expect(text).toContain("h = createMemorySimHandler(); parentPort.postMessage({ type: 'renewed', ok: true }); return;");
    expect(readFileSync(plain, 'utf8')).not.toContain('__renew');
    expect(readFileSync(plain, 'utf8')).toContain('const h = createMemorySimHandler();');

    // The renewed handler is a new one: its `load` is the first again (a second `load` on one handler is BAD_MESSAGE).
    const w = new Worker(renewing);
    try {
      expect(await ask(w, load(1))).toMatchObject({ type: 'loaded', id: 1 });
      expect(await ask(w, load(2))).toMatchObject({ type: 'error', jobId: 2, code: 'BAD_MESSAGE' });
      expect(await ask(w, { type: '__renew' })).toEqual({ type: 'renewed', ok: true });
      expect(await ask(w, load(3))).toMatchObject({ type: 'loaded', id: 3 });
    } finally {
      await w.terminate();
    }
    const p = new Worker(plain);
    try {
      expect(await ask(p, { type: '__renew' })).toMatchObject({ type: 'error', code: 'BAD_MESSAGE' });
    } finally {
      await p.terminate();
    }
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

import { describe, expect, test } from 'vitest';
import { WorkerFailed } from '../../src/engine/workerPool';
import { runSelftest, type SelftestRow } from '../../src/ui/selftest/selftestPage';

type Answer = { actual: string | null; error: string | null };

describe('selftest run (SP2a minor 9)', () => {
  test('a rejected job counts as a failed key and the run always completes', async () => {
    const answers: Record<string, Answer | Error> = {
      a: { actual: 'h-a', error: null },
      b: new WorkerFailed('worker 1 of 1 failed: boom'),
      c: { actual: 'ffff', error: null },
      d: { actual: null, error: 'unknown golden d' },
    };
    const pool = {
      selftest: (key: string): Promise<Answer> => {
        const a = answers[key]!;
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
      },
    };
    const seen: Array<[string, number]> = [];
    const rows = await runSelftest(pool, ['a', 'b', 'c', 'd'], { a: 'h-a', b: 'h-b', c: 'h-c' }, (row, i) => seen.push([row.key, i]));
    expect(rows).toEqual<SelftestRow[]>([
      { key: 'a', expected: 'h-a', actual: 'h-a', error: null, ok: true },
      { key: 'b', expected: 'h-b', actual: null, error: 'job failed: worker 1 of 1 failed: boom', ok: false },
      { key: 'c', expected: 'h-c', actual: 'ffff', error: null, ok: false },
      { key: 'd', expected: null, actual: null, error: 'unknown golden d', ok: false },
    ]);
    expect(seen).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  });
  test('a pool whose every job rejects still yields one failed row per key', async () => {
    const pool = { selftest: (): Promise<Answer> => Promise.reject(new WorkerFailed('every worker failed')) };
    const rows = await runSelftest(pool, ['x', 'y'], { x: '1', y: '2' }, () => {});
    expect(rows.map((r) => [r.key, r.ok, r.error])).toEqual([['x', false, 'job failed: every worker failed'], ['y', false, 'job failed: every worker failed']]);
  });
});

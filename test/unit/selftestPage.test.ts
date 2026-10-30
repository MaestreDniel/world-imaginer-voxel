import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkerFailed } from '../../src/engine/workerPool';
import type { KV } from '../../src/persist/kv';
import { KV_CONTRACT } from '../../src/persist/kvContract';
import { createMemoryKV } from '../../src/persist/memory';
import { KV_SELFTEST_DB, mountKvSection, runKvSelftest, runSelftest, type SelftestRow } from '../../src/ui/selftest/selftestPage';
import { installDom, type FakeElement } from './fixtures/domShim';

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

describe('the selftest\'s IndexedDB section (SP5b spec §6.4)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A fresh `MemoryKV` per open, its opens and closes logged. */
  function recordingOpen(log: string[], broken: ReadonlySet<number> = new Set()): () => Promise<KV> {
    let n = 0;
    return () => {
      const i = n++;
      log.push(`open ${i}`);
      const kv = createMemoryKV();
      const close = kv.close.bind(kv);
      kv.close = () => {
        log.push(`close ${i}`);
        close();
      };
      // A connection the browser already closed: every write settles `closed`, every read rejects.
      if (broken.has(i)) close();
      return Promise.resolve(kv);
    };
  }

  test('`runKvSelftest` over `createMemoryKV` reports every `KV_CONTRACT` case ok and calls `remove` before and after', async () => {
    const log: string[] = [];
    const rows = await runKvSelftest(recordingOpen(log), () => {
      log.push('remove');
      return Promise.resolve();
    });
    expect(rows).toEqual(KV_CONTRACT.map((c) => ({ name: c.name, ok: true, error: null })));
    // Every case's connection is closed before the database is removed after the run.
    expect(log).toEqual(['remove', ...KV_CONTRACT.flatMap((_, i) => [`open ${i}`, `close ${i}`]), 'remove']);
  });

  test('a failing case is reported with its name and error and the rest still run', async () => {
    const log: string[] = [];
    const rows = await runKvSelftest(recordingOpen(log, new Set([4])), () => Promise.resolve());
    expect(rows.map((r) => r.name)).toEqual(KV_CONTRACT.map((c) => c.name));
    expect(rows.filter((r) => !r.ok).map((r) => r.name)).toEqual([KV_CONTRACT[4]!.name]);
    expect(rows[4]!.error).toMatch(/^write .*: expected \{status: "complete", errorName: null\}, got \{status: "closed", errorName: null\}$/);
    expect(log.filter((l) => l.startsWith('open'))).toHaveLength(KV_CONTRACT.length);
    // The page lists the failure under its summary.
    const { document } = installDom();
    const host = document.createElement('div');
    const open = recordingOpen([], new Set([4]));
    await mountKvSection(host as unknown as HTMLElement, () => open(), () => Promise.resolve());
    expect(host.querySelector('#selftest-kv')!.textContent).toBe(`IndexedDB contract: ${KV_CONTRACT.length - 1}/${KV_CONTRACT.length} passed`);
    expect(host.querySelectorAll('li').map((li: FakeElement) => li.textContent)).toEqual([`✗ ${KV_CONTRACT[4]!.name}  error: ${rows[4]!.error}`]);
  });

  test('the page\'s section opens only `wi10-selftest`', async () => {
    const { document } = installDom();
    const host = document.createElement('div');
    const opened: string[] = [];
    const removed: string[] = [];
    await mountKvSection(
      host as unknown as HTMLElement,
      (name) => {
        opened.push(name);
        return Promise.resolve(createMemoryKV());
      },
      (name) => {
        removed.push(name);
        return Promise.resolve();
      },
    );
    expect(KV_SELFTEST_DB).toBe('wi10-selftest');
    expect(opened).toEqual(KV_CONTRACT.map(() => 'wi10-selftest'));
    expect(removed).toEqual(['wi10-selftest', 'wi10-selftest']);
    expect(host.querySelector('#selftest-kv')!.textContent).toBe(`IndexedDB contract: ${KV_CONTRACT.length}/${KV_CONTRACT.length} passed`);
    expect(host.querySelectorAll('li')).toEqual([]);
  });
});

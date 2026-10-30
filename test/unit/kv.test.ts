import { describe, expect, test } from 'vitest';
import { compareKeys, STORES, worldRange, type Key, type KV, type StoreName } from '../../src/persist/kv';
import { KV_CONTRACT, runKvContract } from '../../src/persist/kvContract';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';

const leftovers = (kv: MemoryKV): Array<[StoreName, Key]> =>
  STORES.flatMap((s) => kv.dump(s).map(([k]): [StoreName, Key] => [s, k]));

describe('the KV contract on MemoryKV (SP5b spec §6.3)', () => {
  test('the cases, in order', () => {
    expect(KV_CONTRACT.map((c) => c.name)).toEqual([
      'put, get, delete',
      '`getAll` of `worldRange(\'a\')` returns a\'s `diffs` keys only, in colKey order (keys 2^32 − 1, 0, 65536 put in that order come back 0, 65536, 2^32 − 1), not b\'s',
      'tuple order: `[\'a\', 4294967295]` < `[\'b\', 0]`; every string key sorts before every tuple key',
      'atomic abort: a batch whose third op puts a function settles `abort` with `errorName` `\'DataCloneError\'`, and its first two puts are not visible',
      'a later put of the same key in one batch wins',
      'structured-clone isolation: mutating the value after `put`, or a value `read` returned, changes nothing stored',
      '`count` by range',
      '`deleteRange(worldRange(\'a\'))` removes a\'s 3 keys and leaves b\'s 2',
    ]);
  });

  for (const c of KV_CONTRACT) {
    test(c.name, async () => {
      const kv = createMemoryKV();
      await c.run(kv);
      expect(leftovers(kv), 'the case leaves nothing behind').toEqual([]);
    });
  }

  test('`runKvContract` reports every case ok on MemoryKV, also with read and write delays', async () => {
    for (const o of [undefined, { readDelayMs: 3, writeDelayMs: 5 }]) {
      const results = await runKvContract(async () => createMemoryKV(o));
      expect(results).toEqual(KV_CONTRACT.map((c) => ({ name: c.name, ok: true, error: null })));
    }
  });

  test('`runKvContract` reports a broken adapter\'s case with its first mismatch, and runs the rest', async () => {
    // getAll answers its keys and values reversed; nothing else is wrong.
    const reversed = (): KV => {
      const kv = createMemoryKV();
      return {
        ...kv,
        read: async (reqs) => (await kv.read(reqs)).map((r, i) => {
          if (reqs[i]!.op !== 'getAll') return r;
          const { keys, values } = r as { keys: Key[]; values: unknown[] };
          return { keys: [...keys].reverse(), values: [...values].reverse() };
        }),
      };
    };
    const results = await runKvContract(async () => reversed());
    expect(results.map((r) => r.name)).toEqual(KV_CONTRACT.map((c) => c.name));
    const failed = results.filter((r) => !r.ok);
    expect(failed.map((r) => r.name)).toEqual([KV_CONTRACT[1]!.name, KV_CONTRACT[2]!.name, KV_CONTRACT[7]!.name]);
    for (const r of failed) expect(r.error).toMatch(/getAll/);
    expect(results.filter((r) => r.ok).every((r) => r.error === null)).toBe(true);
  });

  test('`runKvContract` reports an opener that rejects as each case\'s error', async () => {
    const results = await runKvContract(() => Promise.reject(new Error('no storage')));
    expect(results).toEqual(KV_CONTRACT.map((c) => ({ name: c.name, ok: false, error: 'no storage' })));
  });
});

describe('MemoryKV\'s own behaviour', () => {
  const put = (key: Key, value: unknown) => ({ op: 'put', store: 'worlds', key, value }) as const;

  test('`failAt(1, \'QuotaExceededError\')` → `{status: \'abort\', errorName: \'QuotaExceededError\'}`, nothing applied, the next write applies', async () => {
    const kv = createMemoryKV();
    kv.failAt(1, 'QuotaExceededError');
    expect(await kv.write([put('w1', 1), put('w2', 2), put('w3', 3)])).toEqual({ status: 'abort', errorName: 'QuotaExceededError' });
    expect(kv.dump('worlds')).toEqual([]);
    expect(kv.opCount).toBe(0);
    expect(await kv.write([put('w1', 1), put('w2', 2)])).toEqual({ status: 'complete', errorName: null });
    expect(kv.dump('worlds')).toEqual([['w1', 1], ['w2', 2]]);
    expect(kv.opCount).toBe(2);
  });

  test('`failAt(\'commit\')` aborts at the commit with `AbortError` by default, once', async () => {
    const kv = createMemoryKV();
    kv.failAt('commit');
    expect(await kv.write([put('w1', 1)])).toEqual({ status: 'abort', errorName: 'AbortError' });
    expect(kv.dump('worlds')).toEqual([]);
    expect(await kv.write([put('w1', 1)])).toEqual({ status: 'complete', errorName: null });
    expect(kv.dump('worlds')).toEqual([['w1', 1]]);
  });

  test('`failAt(k)` past the next batch\'s last op is spent on that batch, which completes', async () => {
    const kv = createMemoryKV();
    kv.failAt(2);
    expect(await kv.write([put('w1', 1), put('w2', 2)])).toEqual({ status: 'complete', errorName: null });
    expect(await kv.write([put('w3', 3), put('w4', 4), put('w5', 5)])).toEqual({ status: 'complete', errorName: null });
    expect(kv.dump('worlds').map(([k]) => k)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });

  test('`crashNext()` → the write never settles (a 200 ms race resolves first) and a later `read` sees nothing of it', async () => {
    const kv = createMemoryKV();
    kv.crashNext();
    const crashed = kv.write([put('w1', 1)]).then(() => 'settled');
    const timer = new Promise<string>((resolve) => setTimeout(() => resolve('timer'), 200));
    expect(await Promise.race([crashed, timer])).toBe('timer');
    expect(await kv.read([{ op: 'get', store: 'worlds', key: 'w1' }])).toEqual([undefined]);
    expect(kv.dump('worlds')).toEqual([]);
    expect(await kv.write([put('w2', 2)]), 'the crash is spent on one write').toEqual({ status: 'complete', errorName: null });
    expect(kv.dump('worlds')).toEqual([['w2', 2]]);
  });

  test('`closeNow()` → `closed` and the event once', async () => {
    const kv = createMemoryKV();
    const events: string[] = [];
    kv.onEvent((e) => events.push(e));
    const off = kv.onEvent((e) => events.push(`removed ${e}`));
    off();
    kv.closeNow();
    kv.closeNow();
    expect(events).toEqual(['closed']);
    expect(await kv.write([put('w1', 1)])).toEqual({ status: 'closed', errorName: null });
    expect(kv.dump('worlds')).toEqual([]);
    await expect(kv.read([{ op: 'get', store: 'worlds', key: 'w1' }])).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  test('a write in flight during `closeNow()` settles `abort` (`AbortError`) with nothing applied; `close()` fires no event', async () => {
    const kv = createMemoryKV({ writeDelayMs: 20 });
    const events: string[] = [];
    kv.onEvent((e) => events.push(e));
    const inFlight = kv.write([put('w1', 1)]);
    kv.closeNow();
    expect(await inFlight).toEqual({ status: 'abort', errorName: 'AbortError' });
    expect(kv.dump('worlds')).toEqual([]);
    const other = createMemoryKV();
    other.onEvent((e) => events.push(`other ${e}`));
    other.close();
    expect(await other.write([put('w1', 1)])).toEqual({ status: 'closed', errorName: null });
    expect(events).toEqual(['closed']);
  });

  test('transactions run in order: a read issued after a delayed write sees it, a write after a delayed read does not reach it', async () => {
    const kv = createMemoryKV({ readDelayMs: 15, writeDelayMs: 15 });
    const get = { op: 'get', store: 'worlds', key: 'w1' } as const;
    const w1 = kv.write([put('w1', 1)]);
    const r1 = kv.read([get]);
    const w2 = kv.write([put('w1', 2)]);
    const r2 = kv.read([get]);
    expect(await Promise.all([w1, r1, w2, r2])).toEqual([
      { status: 'complete', errorName: null }, [1], { status: 'complete', errorName: null }, [2],
    ]);
  });

  test('`count` and `getAll` with a null range cover the whole store; `dump` is in key order', async () => {
    const kv = createMemoryKV();
    await kv.write([
      { op: 'put', store: 'diffs', key: ['b', 0], value: 3 },
      { op: 'put', store: 'diffs', key: ['a', 7], value: 2 },
      { op: 'put', store: 'diffs', key: ['a', 1], value: 1 },
    ]);
    expect(await kv.read([{ op: 'count', store: 'diffs', range: null }, { op: 'getAll', store: 'diffs', range: null }])).toEqual([
      3, { keys: [['a', 1], ['a', 7], ['b', 0]], values: [1, 2, 3] },
    ]);
    expect(kv.dump('diffs')).toEqual([[['a', 1], 1], [['a', 7], 2], [['b', 0], 3]]);
    expect(kv.dump('state')).toEqual([]);
  });
});

describe('compareKeys (IndexedDB\'s key order)', () => {
  const sign = (n: number) => Math.sign(n);

  test('colKeys within one world sort numerically: 0 < 65536 < 2^32 − 1', () => {
    expect(sign(compareKeys(['a', 0], ['a', 65536]))).toBe(-1);
    expect(sign(compareKeys(['a', 65536], ['a', 2 ** 32 - 1]))).toBe(-1);
    expect(sign(compareKeys(['a', 2 ** 32 - 1], ['a', 0]))).toBe(1);
    expect(compareKeys(['a', 7], ['a', 7])).toBe(0);
  });

  test('tuple order: [\'a\', 4294967295] < [\'b\', 0]', () => {
    expect(sign(compareKeys(['a', 4294967295], ['b', 0]))).toBe(-1);
    expect(sign(compareKeys(['b', 0], ['a', 4294967295]))).toBe(1);
  });

  test('every string key sorts before every tuple key; strings by code unit', () => {
    expect(sign(compareKeys('zzzz', ['a', 0]))).toBe(-1);
    expect(sign(compareKeys(['', 0], '￿'))).toBe(1);
    expect(sign(compareKeys('a', 'b'))).toBe(-1);
    expect(sign(compareKeys('B', 'a'))).toBe(-1);
    expect(sign(compareKeys('a', 'aa'))).toBe(-1);
    expect(compareKeys('w', 'w')).toBe(0);
  });

  test('worldRange(\'a\') holds a\'s colKeys and none of b\'s or of a longer id', () => {
    const r = worldRange('a');
    const inside = (k: Key) => compareKeys(k, r.lower) >= 0 && compareKeys(k, r.upper) < 0;
    expect(r).toEqual({ lower: ['a', 0], upper: ['a', 2 ** 32] });
    const inA: Key[] = [['a', 0], ['a', 65536], ['a', 2 ** 32 - 1]];
    const outside: Key[] = [['b', 0], ['aa', 0], ['', 0], 'a'];
    expect(inA.every(inside)).toBe(true);
    expect(outside.some(inside)).toBe(false);
  });

  test('STORES are D16\'s five, in order', () => {
    expect(STORES).toEqual(['worlds', 'state', 'history', 'diffs', 'meta']);
  });
});

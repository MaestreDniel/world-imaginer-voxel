/**
 * One tab per world (SP5b spec §3.5, D7, D24): `holdWorld`, the world page's wait for the lock, and `withWorldIfFree`,
 * the menu's write inside it, over Node's own `navigator.locks` (24.21 has one) and over a fake that records requests.
 */
import { describe, expect, test } from 'vitest';
import { createMemoryKV } from '../../src/persist/memory';
import { createSaves, newState, todayStateTable, type WorldRecord } from '../../src/persist/saves';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { LOCK_WAIT_MS, holdWorld, lockName, withWorldIfFree, type LockManagerLike } from '../../src/ui/world/worldLock';

const locks = navigator.locks as unknown as LockManagerLike;
/** A world id no other test in this process locks. */
const fresh = (): string => crypto.randomUUID();
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Resolves once `id`'s lock is free (a release takes effect when the holder's callback promise settles). */
const freed = (id: string): Promise<void> => locks.request(lockName(id), {}, () => undefined);

/** Holds `id`'s lock as another document would, until `ms` from now. */
function heldFor(id: string, ms: number): Promise<void> {
  let granted = (): void => {};
  const g = new Promise<void>((resolve) => { granted = resolve; });
  void locks.request(lockName(id), {}, () => {
    granted();
    return wait(ms);
  });
  return g;
}

/** A lock manager that records each request's options and hands it to Node's. */
function recording() {
  const requests: Array<{ name: string; signal: boolean; ifAvailable: boolean }> = [];
  const fake: LockManagerLike = {
    request(name, o, cb) {
      requests.push({ name, signal: o.signal !== undefined, ifAvailable: o.ifAvailable === true });
      return locks.request(name, o, cb);
    },
  };
  return { fake, requests };
}

describe('the world\'s lock (SP5b spec §3.5, D24)', () => {
  test('`LOCK_WAIT_MS` is 2,000 and the lock is `wi10.world.<id>`', () => {
    expect(LOCK_WAIT_MS).toBe(2000);
    expect(lockName('a-b')).toBe('wi10.world.a-b');
  });

  test('Review Focus 2: `holdWorld` resolves to a holder when the previous holder releases at 1,500 ms, and to null when it releases at 2,500 ms', async () => {
    const reload = fresh();
    const other = fresh();
    await Promise.all([heldFor(reload, 1500), heldFor(other, 2500)]);
    const t0 = performance.now();
    const [a, b] = await Promise.all([
      holdWorld(locks, reload).then((h) => ({ h, ms: performance.now() - t0 })),
      holdWorld(locks, other).then((h) => ({ h, ms: performance.now() - t0 })),
    ]);
    expect(a.h).not.toBeNull();
    expect(a.ms).toBeGreaterThanOrEqual(1400);
    expect(a.ms).toBeLessThan(2000);
    expect(b.h).toBeNull();
    expect(b.ms).toBeGreaterThanOrEqual(1900);
    // The page holds its lock until `release`: the menu finds it held, then free.
    expect(await withWorldIfFree(locks, reload, () => Promise.resolve(1))).toEqual({ held: true });
    a.h!.release();
    a.h!.release();
    await freed(reload);
    expect(await withWorldIfFree(locks, reload, () => Promise.resolve(1))).toEqual({ held: false, value: 1 });
    await wait(600);
  }, 10_000);

  test('the page asks with a signal and no `ifAvailable`; the menu with `ifAvailable` and no signal', async () => {
    const id = fresh();
    const { fake, requests } = recording();
    const h = await holdWorld(fake, id);
    h!.release();
    await withWorldIfFree(fake, id, () => Promise.resolve(null));
    expect(requests).toEqual([
      { name: lockName(id), signal: true, ifAvailable: false },
      { name: lockName(id), signal: false, ifAvailable: true },
    ]);
  });

  test('a request that fails other than by the wait\'s abort rejects (it is not "open in another tab")', async () => {
    const broken: LockManagerLike = { request: () => Promise.reject(new DOMException('no locks here', 'SecurityError')) };
    await expect(holdWorld(broken, fresh())).rejects.toMatchObject({ name: 'SecurityError' });
  });

  test('the menu\'s Rename with the lock held writes nothing and reports held', async () => {
    const id = fresh();
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    expect((await saves.create(record(id), newState(id, STATE_BOUNDS))).status).toBe('complete');
    const before = kv.dump('worlds');
    const page = await holdWorld(locks, id);
    expect(page).not.toBeNull();
    let called = false;
    const r = await withWorldIfFree(locks, id, () => {
      called = true;
      return saves.rename(id, 'Other');
    });
    expect(r).toEqual({ held: true });
    expect(called).toBe(false);
    expect(kv.dump('worlds')).toEqual(before);
    page!.release();
  });

  test('a Rename whose write is in flight when a page requests the lock: the page\'s callback runs only after the write\'s `complete`', async () => {
    const id = fresh();
    const kv = createMemoryKV({ writeDelayMs: 300 });
    const saves = createSaves(kv);
    expect((await saves.create(record(id), newState(id, STATE_BOUNDS))).status).toBe('complete');
    const order: string[] = [];
    const renamed = withWorldIfFree(locks, id, () => saves.rename(id, 'Renamed').then((w) => {
      order.push(`write ${w.status}`);
      return w;
    }));
    await wait(50);
    const page = holdWorld(locks, id).then((h) => {
      order.push('page');
      return h;
    });
    expect(await renamed).toEqual({ held: false, value: { status: 'complete', errorName: null } });
    const h = await page;
    expect(h).not.toBeNull();
    expect(order).toEqual(['write complete', 'page']);
    expect(kv.dump('worlds')).toEqual([[id, { ...record(id), name: 'Renamed' }]]);
    h!.release();
  });

  test('a write that rejects releases the lock and rejects', async () => {
    const id = fresh();
    await expect(withWorldIfFree(locks, id, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withWorldIfFree(locks, id, () => Promise.resolve(2))).toEqual({ held: false, value: 2 });
  });

  test('two different worlds lock independently', async () => {
    const a = fresh();
    const b = fresh();
    const ha = await holdWorld(locks, a);
    const hb = await holdWorld(locks, b);
    expect([ha, hb].map((h) => h !== null)).toEqual([true, true]);
    expect(await withWorldIfFree(locks, a, () => Promise.resolve('a'))).toEqual({ held: true });
    hb!.release();
    await freed(b);
    expect(await withWorldIfFree(locks, b, () => Promise.resolve('b'))).toEqual({ held: false, value: 'b' });
    expect(await withWorldIfFree(locks, a, () => Promise.resolve('a'))).toEqual({ held: true });
    ha!.release();
  });
});

function record(id: string): WorldRecord {
  return {
    id, name: 'My world', seedText: 'hello', seed: [1, 2], profile: 'default', params: {}, schemaVersion: 1,
    paramsHash: '0123456789abcdef', generatorVersion: 5, genKey: '0123456789abcdef', stateTable: todayStateTable(), created: 1_000,
    backupOf: null,
  };
}

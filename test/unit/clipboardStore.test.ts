/**
 * Where the clipboard lives (SP5c spec §4.2, D15, D26): `meta['clipboard']` through a KV, one per browser, or memory.
 * A write keeps the clipboard in memory and puts it once; a failed write keeps the memory copy, which reads back until a
 * later write from this store succeeds (ruling P19); no KV (or a `kv()` that rejects, ruling P12) keeps it in memory with
 * D15's notice once. A read is one `get`, decoded; absent or a rejected read falls back to the memory copy. Two stores
 * over one KV share the clipboard: the last write wins and a read is never a mixture of two writes.
 */
import { describe, expect, test } from 'vitest';
import { CLIPBOARD_KEY, decodeClipboard, encodeClipboard } from '../../src/persist/clipboard';
import { KvError, type KV, type ReadRequest } from '../../src/persist/kv';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import type { Clipboard } from '../../src/ui/world/clipboard';
import {
  createClipboardStore,
  NO_STORAGE_NOTICE,
  NO_STORAGE_NOTICE_MS,
  type ClipboardStore,
} from '../../src/ui/world/clipboardStore';
import { backupFailureReason } from '../../src/ui/world/modifyMode';
import { AIR, REGISTRY, STONE } from '../../src/world/blocks/index';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';

const GLASS = REGISTRY.parseStateKey('glass');

/** A W × H × D clipboard whose cells cycle through stone, air with water, glass and air. */
function box(w: number, h: number, d: number, shift = 0): Clipboard {
  const pool = [STONE << 8, (AIR << 8) | WATER_SOURCE, GLASS << 8, AIR << 8];
  const values = new Uint32Array(w * h * d);
  for (let i = 0; i < values.length; i++) values[i] = pool[(i + shift) % pool.length]! >>> 0;
  return { w, h, d, values };
}

const X = box(3, 2, 4);
const Y = box(5, 1, 2, 1);

const plain = (c: Clipboard | null) => (c === null ? null : { w: c.w, h: c.h, d: c.d, values: Array.from(c.values) });

function noticeLog() {
  const shown: Array<[string, number]> = [];
  return { shown, notices: { show: (text: string, ms: number) => void shown.push([text, ms]) } };
}

function storeOver(kv: () => Promise<KV | null>): { store: ClipboardStore; shown: Array<[string, number]> } {
  const { shown, notices } = noticeLog();
  return { store: createClipboardStore({ kv, notices }), shown };
}

/** The KV with every `read`'s requests recorded. */
function spyReads(kv: KV) {
  const reads: (readonly ReadRequest[])[] = [];
  const spy: KV = { read: (reqs) => (reads.push(reqs), kv.read(reqs)), write: (ops) => kv.write(ops), onEvent: kv.onEvent, close: kv.close };
  return { spy, reads };
}

describe('the clipboard store (SP5c spec §4.2, D15, D26)', () => {
  test('write then read equals the clipboard; one `put` of `meta[\'clipboard\']`, one `get` back', async () => {
    const kv = createMemoryKV();
    const { spy, reads } = spyReads(kv);
    const { store, shown } = storeOver(async () => spy);
    expect(await store.write(X)).toEqual({ ok: true, stored: true });
    expect(kv.opCount).toBe(1);
    expect(kv.dump('meta').map(([k]) => k)).toEqual([CLIPBOARD_KEY]);
    const r = await store.read();
    expect(reads).toEqual([[{ op: 'get', store: 'meta', key: CLIPBOARD_KEY }]]);
    expect({ ...r, clip: plain(r.clip) }).toEqual({ clip: plain(X), unreadable: false, unknown: 0 });
    expect(shown).toEqual([]);
    // A fresh store over the same KV (a reload) reads it too.
    const again = await storeOver(async () => kv).store.read();
    expect(plain(again.clip)).toEqual(plain(X));
  });

  test('nothing written and nothing in memory: the read is null', async () => {
    const { store } = storeOver(async () => createMemoryKV());
    expect(await store.read()).toEqual({ clip: null, unreadable: false, unknown: 0 });
  });

  test('`failAt(0, \'QuotaExceededError\')`: `{ ok: false }` with the reason, the memory copy kept', async () => {
    const kv = createMemoryKV();
    const { store, shown } = storeOver(async () => kv);
    kv.failAt(0, 'QuotaExceededError');
    expect(await store.write(X)).toEqual({ ok: false, reason: backupFailureReason('QuotaExceededError') });
    expect(backupFailureReason('QuotaExceededError')).toBe('storage full');
    expect(kv.dump('meta')).toEqual([]);
    expect(plain((await store.read()).clip)).toEqual(plain(X));
    expect(shown).toEqual([]);
  });

  test('an abort with another error names that error; a closed connection reads "storage was closed"', async () => {
    const kv = createMemoryKV();
    const { store } = storeOver(async () => kv);
    kv.failAt('commit', 'UnknownError');
    expect(await store.write(X)).toEqual({ ok: false, reason: 'UnknownError' });
    kv.close();
    expect(await store.write(Y)).toEqual({ ok: false, reason: 'storage was closed' });
    // Both writes failed: the memory copy, the last write's.
    expect(plain((await store.read()).clip)).toEqual(plain(Y));
  });

  test('after a failed write the read gives the memory copy until a later write from this store succeeds (ruling P19)', async () => {
    const kv = createMemoryKV();
    const a = storeOver(async () => kv).store;
    const b = storeOver(async () => kv).store;
    expect(await a.write(Y)).toEqual({ ok: true, stored: true });
    kv.failAt(0, 'QuotaExceededError');
    expect((await a.write(X)).ok).toBe(false);
    const stored = decodeClipboard(kv.dump('meta')[0]![1]);
    expect(stored.ok && Array.from(stored.values), 'Y still stored').toEqual(Array.from(Y.values));
    expect(plain((await a.read()).clip), 'X, the copy just made, not the stored Y').toEqual(plain(X));
    const z = box(2, 2, 2, 2);
    expect(await a.write(z)).toEqual({ ok: true, stored: true });
    expect(await b.write(Y)).toEqual({ ok: true, stored: true });
    expect(plain((await a.read()).clip), 'storage again: B\'s Y').toEqual(plain(Y));
  });

  test('a read that rejects falls back to the memory copy', async () => {
    const kv = createMemoryKV();
    let failRead = false;
    const flaky: KV = {
      read: (reqs) => (failRead ? Promise.reject(new KvError('UnknownError', 'read failed')) : kv.read(reqs)),
      write: (ops) => kv.write(ops),
      onEvent: kv.onEvent,
      close: kv.close,
    };
    const { store } = storeOver(async () => flaky);
    failRead = true;
    expect(await store.read(), 'no memory copy yet').toEqual({ clip: null, unreadable: false, unknown: 0 });
    expect(await store.write(X)).toEqual({ ok: true, stored: true });
    const r = await store.read();
    expect({ ...r, clip: plain(r.clip) }).toEqual({ clip: plain(X), unreadable: false, unknown: 0 });
  });

  test('an unreadable record reads `unreadable` true', async () => {
    const kv = createMemoryKV();
    const { store } = storeOver(async () => kv);
    expect(await store.write(X)).toEqual({ ok: true, stored: true });
    const bad = { ...encodeClipboard(Y.w, Y.h, Y.d, Y.values), v: 2 };
    await kv.write([{ op: 'put', store: 'meta', key: CLIPBOARD_KEY, value: bad }]);
    expect(await store.read()).toEqual({ clip: null, unreadable: true, unknown: 0 });
  });

  test('a record with 3 unknown-key cells reads `unknown` 3, those cells air', async () => {
    const kv = createMemoryKV();
    const { store } = storeOver(async () => kv);
    const raw = {
      v: 1, w: 2, h: 1, d: 3, keys: [REGISTRY.stateKey(STONE), 'sp99_unknown_block'],
      states: new Uint16Array([0, 1, 1, 0, 1, 0]), fluids: new Uint8Array([0, 0, WATER_SOURCE, 0, 0, 0]),
    };
    await kv.write([{ op: 'put', store: 'meta', key: CLIPBOARD_KEY, value: raw }]);
    const r = await store.read();
    expect({ ...r, clip: plain(r.clip) }).toEqual({
      clip: { w: 2, h: 1, d: 3, values: [STONE << 8, 0, 0, STONE << 8, 0, STONE << 8] },
      unreadable: false,
      unknown: 3,
    });
  });

  test('no KV: `{ ok: true, stored: false }` and the notice once over two writes; the read is the memory copy', async () => {
    const { store, shown } = storeOver(async () => null);
    expect(await store.read()).toEqual({ clip: null, unreadable: false, unknown: 0 });
    expect(await store.write(X)).toEqual({ ok: true, stored: false });
    expect(await store.write(Y)).toEqual({ ok: true, stored: false });
    expect(shown).toEqual([[NO_STORAGE_NOTICE, NO_STORAGE_NOTICE_MS]]);
    expect(NO_STORAGE_NOTICE).toBe('The clipboard is kept only until this page closes: this browser window cannot store data');
    expect(NO_STORAGE_NOTICE_MS).toBe(6_000);
    expect(plain((await store.read()).clip)).toEqual(plain(Y));
  });

  test('`kv()` rejects: write → `{ ok: true, stored: false }` with the notice once over two writes; read → the memory copy (ruling P12)', async () => {
    let calls = 0;
    const { store, shown } = storeOver(() => (calls++, Promise.reject(new KvError('UnknownError', 'cannot open'))));
    expect(await store.write(X)).toEqual({ ok: true, stored: false });
    expect(await store.write(Y)).toEqual({ ok: true, stored: false });
    expect(shown).toEqual([[NO_STORAGE_NOTICE, NO_STORAGE_NOTICE_MS]]);
    const r = await store.read();
    expect({ ...r, clip: plain(r.clip) }).toEqual({ clip: plain(Y), unreadable: false, unknown: 0 });
    expect(calls).toBeGreaterThan(0);
  });

  test('the memory copy is the store\'s own: a caller\'s later change to the written values does not reach it', async () => {
    const { store } = storeOver(async () => null);
    const c = box(2, 2, 2);
    const before = plain(c);
    await store.write(c);
    c.values.fill(0);
    expect(plain((await store.read()).clip)).toEqual(before);
  });

  test('two stores over one `MemoryKV`: B\'s write is read by A\'s next `read()`; a write of Y while A\'s read of X is in flight resolves A\'s read with X or Y whole', async () => {
    const kv: MemoryKV = createMemoryKV({ readDelayMs: 20, writeDelayMs: 20 });
    const a = storeOver(async () => kv).store;
    const b = storeOver(async () => kv).store;
    expect(await a.write(X)).toEqual({ ok: true, stored: true });
    expect(await b.write(Y)).toEqual({ ok: true, stored: true });
    expect(plain((await a.read()).clip), 'B\'s write, read by A').toEqual(plain(Y));
    expect(await a.write(X)).toEqual({ ok: true, stored: true });
    const reading = a.read();
    const writing = b.write(Y);
    const [r, w] = await Promise.all([reading, writing]);
    expect(w).toEqual({ ok: true, stored: true });
    const got = plain(r.clip);
    expect([plain(X), plain(Y)], 'X or Y whole, never a mixture').toContainEqual(got);
    expect(plain((await a.read()).clip), 'the next read: Y').toEqual(plain(Y));
  });
});

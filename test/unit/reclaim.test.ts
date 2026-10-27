/**
 * Deferred reclamation (SP4b spec §2.5, §2.6, §2.8; master §2.3 Reclamation): the reader epochs, the fast path, the
 * limbo list and its drain, a dead thread's epoch, the limbo's growth, and the store id. One thread: another thread's
 * read section is simulated by a second `attachReclaimer` on the same buffer, which writes its own `R[t]`.
 */
import { describe, expect, test } from 'vitest';
import { BYTE_SLOT_BYTES, createPool, type SlabPool } from '../../src/world/store/pool';
import {
  attachReclaimer, createReclaimBuffer, LIMBO_ENTRIES, MAIN_THREAD, RECLAIM_BYTES, RECLAIM_THREADS, R_DEAD, R_EPOCH, R_LIMBO,
  R_READER, R_STORE_ID, SIM_THREAD,
} from '../../src/world/store/reclaim';
import { attachStore, createStore } from '../../src/world/store/store';

const MiB = 1 << 20;

/** A reclaim buffer over two small pools (block and byte), and thread 0's reclaimer on it. */
function setup(shared: boolean, maxBytes = 4 * MiB) {
  const blocks = createPool({ shared, slotBytes: 8192, maxBytes });
  const bytes = createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes });
  const buf = createReclaimBuffer(shared, 7);
  const pools = [blocks, bytes] as const;
  const r = attachReclaimer(buf, MAIN_THREAD, pools, shared);
  const reader = (t: number) => attachReclaimer(buf, t, pools, shared);
  return { buf, ints: new Int32Array(buf), blocks, bytes, r, reader };
}

/** Whether `id` is on the pool's free stack (and its refcount 0). */
const isFree = (p: SlabPool, id: number): boolean => p.refcount(id) === 0 && p.freeStack().includes(id);

describe('the reclaim buffer (SP4b spec §2.5)', () => {
  test('the layout: 192 bytes, G at 1, the store id, readers and limbo counts at 0', () => {
    expect([RECLAIM_BYTES, RECLAIM_THREADS, R_EPOCH, R_DEAD, R_STORE_ID, R_READER, R_LIMBO]).toEqual([192, 16, 0, 1, 2, 16, 32]);
    expect([MAIN_THREAD, SIM_THREAD, LIMBO_ENTRIES]).toEqual([0, 15, 1024]);
    const sh = createReclaimBuffer(true, 3);
    const un = createReclaimBuffer(false, -9);
    expect(sh).toBeInstanceOf(SharedArrayBuffer);
    expect(un).toBeInstanceOf(ArrayBuffer);
    for (const [buf, id] of [[sh, 3], [un, -9]] as const) {
      const ints = new Int32Array(buf);
      expect(buf.byteLength).toBe(192);
      expect([ints[R_EPOCH], ints[R_DEAD], ints[R_STORE_ID]]).toEqual([1, 0, id]);
      for (let t = 0; t < 16; t++) expect([ints[R_READER + t], ints[R_LIMBO + t]]).toEqual([0, 0]);
    }
  });

  test('guards: a zero or non-Int32 store id, a buffer of another size or kind, a thread outside 0 … 15, a foreign pool', () => {
    expect(() => createReclaimBuffer(true, 0)).toThrow(RangeError);
    expect(() => createReclaimBuffer(true, 2 ** 31)).toThrow(RangeError);
    expect(() => createReclaimBuffer(true, 1.5)).toThrow(RangeError);
    const { buf, blocks, bytes, r } = setup(true);
    const pools = [blocks, bytes] as const;
    expect(() => attachReclaimer(new SharedArrayBuffer(188), 0, pools, true)).toThrow(RangeError);
    expect(() => attachReclaimer(new ArrayBuffer(192), 0, pools, true)).toThrow(TypeError);
    expect(() => attachReclaimer(new SharedArrayBuffer(192), 0, pools, true)).toThrow(/store id/);
    for (const t of [-1, 16, 1.5]) expect(() => attachReclaimer(buf, t, pools, true), String(t)).toThrow(RangeError);
    const other = createPool({ shared: true, slotBytes: 8192, maxBytes: MiB });
    expect(() => r.retire(other, other.alloc())).toThrow(RangeError);
  });

  test('enterRead publishes G into R[t]; exitRead stores 0', () => {
    const { ints, blocks, r, reader } = setup(true);
    const t5 = reader(5);
    t5.enterRead();
    expect(ints[R_READER + 5]).toBe(ints[R_EPOCH]);
    r.retire(blocks, blocks.alloc());
    expect(ints[R_READER + 5]).toBe(1);
    expect(ints[R_EPOCH]).toBe(2);
    t5.exitRead();
    expect(ints[R_READER + 5]).toBe(0);
    expect([t5.thread, t5.storeId, r.thread]).toEqual([5, 7, 0]);
  });

  test('the fast path: no reader inside a read section frees at once (the slot is back on the free stack); an unshared store frees at once even with a reader announced', () => {
    for (const shared of [true, false]) {
      const { ints, blocks, bytes, r, reader } = setup(shared);
      const b = blocks.alloc();
      const g = ints[R_EPOCH]!;
      r.retire(blocks, b);
      expect(isFree(blocks, b), `shared ${shared}`).toBe(true);
      expect(ints[R_EPOCH]).toBe(g + 1); // the release took tag g
      expect(r.limboCount(MAIN_THREAD)).toBe(0);
      if (shared) continue;
      // Unshared: a reader announced in R[2] does not hold the release.
      reader(2).enterRead();
      const s = bytes.alloc();
      r.retire(bytes, s);
      expect(isFree(bytes, s)).toBe(true);
      expect(r.limboCount(MAIN_THREAD)).toBe(0);
    }
  });

  test('the limbo path: a slot retired while thread 2 is inside a read section is not freed, counts 1 in [32 + t], and is freed by the drain after thread 2\'s exitRead', () => {
    const { ints, bytes, r, reader } = setup(true);
    const t2 = reader(2);
    t2.enterRead();
    const s = bytes.alloc();
    r.retire(bytes, s);
    expect(bytes.refcount(s)).toBe(1);
    expect(bytes.freeStack().includes(s)).toBe(false);
    expect(ints[R_LIMBO + MAIN_THREAD]).toBe(1);
    expect(r.limboCount(MAIN_THREAD)).toBe(1);
    expect(r.drain()).toBe(1); // thread 2 still reads
    expect(bytes.refcount(s)).toBe(1);
    t2.exitRead();
    expect(r.drain()).toBe(0);
    expect(isFree(bytes, s)).toBe(true);
    expect(ints[R_LIMBO + MAIN_THREAD]).toBe(0);
  });

  test('a release made inside the releasing thread\'s own read section waits for its exitRead, which drains it', () => {
    const { blocks, r } = setup(true);
    r.enterRead();
    const b = blocks.alloc();
    r.retire(blocks, b);
    expect(r.limboCount(MAIN_THREAD)).toBe(1);
    r.exitRead();
    expect(r.limboCount(MAIN_THREAD)).toBe(0);
    expect(isFree(blocks, b)).toBe(true);
  });

  test('a reader that entered after the release does not hold it: retire with tag g, thread 3 enters (R = g + 1), drain frees the slot', () => {
    const { ints, blocks, r, reader } = setup(true);
    const t2 = reader(2);
    t2.enterRead(); // holds the release in limbo while thread 3 enters
    const b = blocks.alloc();
    const g = ints[R_EPOCH]!;
    r.retire(blocks, b);
    const t3 = reader(3);
    t3.enterRead();
    expect(ints[R_READER + 3]).toBe(g + 1);
    expect(r.drain()).toBe(1); // thread 2, which entered before the release, still holds it
    t2.exitRead();
    expect(r.drain()).toBe(0); // thread 3 alone: tag g < g + 1
    expect(isFree(blocks, b)).toBe(true);
    t3.exitRead();
  });

  test('markDead(2) clears R[2] and the drain ignores it: a slot held in limbo by dead thread 2 is freed', () => {
    const { ints, bytes, r, reader } = setup(true);
    reader(2).enterRead();
    const s = bytes.alloc();
    r.retire(bytes, s);
    expect(r.drain()).toBe(1);
    r.markDead(2);
    expect(ints[R_DEAD]! & (1 << 2)).not.toBe(0);
    expect(ints[R_READER + 2]).toBe(0);
    // A dead thread's late store to its epoch is ignored too.
    Atomics.store(ints, R_READER + 2, 1);
    expect(r.drain()).toBe(0);
    expect(isFree(bytes, s)).toBe(true);
    // A release under the dead thread's stale epoch goes to limbo (the fast path reads every R[t]) and drains at once.
    const s2 = bytes.alloc();
    r.retire(bytes, s2);
    expect(r.drain()).toBe(0);
    expect(isFree(bytes, s2)).toBe(true);
  });

  test('a limbo of more than 1024 entries grows and drains completely', () => {
    const { ints, blocks, bytes, r, reader } = setup(true, 16 * MiB);
    const t2 = reader(2);
    t2.enterRead();
    const n = LIMBO_ENTRIES + 476;
    for (let i = 0; i < n; i++) {
      const p = i % 3 === 0 ? blocks : bytes;
      r.retire(p, p.alloc());
    }
    expect(r.limboCount(MAIN_THREAD)).toBe(n);
    expect(ints[R_LIMBO]).toBe(n);
    expect(r.drain()).toBe(n);
    t2.exitRead();
    expect(r.drain()).toBe(0);
    expect(blocks.freeCount()).toBe(blocks.slotCount());
    expect(bytes.freeCount()).toBe(bytes.slotCount());
    // The grown ring wraps (its head is at 1,500 of 2,048) and grows again: 2,051 entries drain too.
    t2.enterRead();
    for (let i = 0; i < 2 * LIMBO_ENTRIES + 3; i++) r.retire(bytes, bytes.alloc());
    t2.exitRead();
    expect(r.drain()).toBe(0);
    expect(bytes.freeCount()).toBe(bytes.slotCount());
  });

  test('createStore stamps distinct non-zero store ids; attachStore(h, 3).thread is 3 and its storeId equals the creator\'s', () => {
    const a = createStore({ shared: true, maxBlockBytes: MiB, maxByteBytes: MiB });
    const b = createStore({ shared: false, maxBlockBytes: MiB, maxByteBytes: MiB });
    expect(a.storeId).not.toBe(0);
    expect(b.storeId).not.toBe(0);
    expect(a.storeId).not.toBe(b.storeId);
    expect(a.thread).toBe(0);
    expect(new Int32Array(a.handles().reclaim)[R_STORE_ID]).toBe(a.storeId);
    expect(a.handles().reclaim.byteLength).toBe(RECLAIM_BYTES);
    const a3 = attachStore(a.handles(), 3);
    expect(a3.thread).toBe(3);
    expect(a3.storeId).toBe(a.storeId);
    expect(attachStore(a.handles()).thread).toBe(0);
    expect(() => attachStore(a.handles(), 16)).toThrow(RangeError);
    // The reclaim buffer follows the store's kind (SP4a spec §2.5).
    expect(() => attachStore({ ...a.handles(), reclaim: new ArrayBuffer(192) })).toThrow(TypeError);
    expect(() => attachStore({ ...b.handles(), reclaim: new SharedArrayBuffer(192) })).toThrow(TypeError);
  });

  test('the store forwards the read API to its thread\'s reclaimer', () => {
    const s = createStore({ shared: true, maxBlockBytes: MiB, maxByteBytes: MiB });
    const ints = new Int32Array(s.handles().reclaim);
    const s4 = attachStore(s.handles(), 4);
    s4.enterRead();
    expect(ints[R_READER + 4]).toBe(ints[R_EPOCH]);
    const w = s.claimColumn(0, 0, 0);
    w.auxB(); // one byte slot
    s.freeColumn(0, 0);
    expect(s.limboCount(0)).toBe(1);
    expect(s4.limboCount(0)).toBe(1);
    expect(s.drain()).toBe(1);
    s4.exitRead();
    expect(s.drain()).toBe(0);
    s4.enterRead();
    s.claimColumn(0, 0, 0).auxB();
    s.freeColumn(0, 0);
    s.markDead(4);
    expect(ints[R_READER + 4]).toBe(0);
    expect(s.drain()).toBe(0);
  });
});

describe('wrap-aware epochs (SP5a spec D24, STORE-3)', () => {
  const MAX = 2 ** 31 - 1;
  const MIN = -(2 ** 31);

  test('G at 2³¹ − 3: reader A enters (2³¹ − 3); four releases take tags 2³¹ − 3 … −2³¹ (wrapping); reader B enters at −2³¹ + 1; drain frees nothing; A exits: drain frees the four releases tagged before B\'s epoch and keeps none older than B', () => {
    const { ints, blocks, r, reader } = setup(true);
    Atomics.store(ints, R_EPOCH, MAX - 2);
    const a = reader(2);
    a.enterRead();
    expect(ints[R_READER + 2]).toBe(MAX - 2);
    const four = [blocks.alloc(), blocks.alloc(), blocks.alloc(), blocks.alloc()];
    const tags: number[] = [];
    for (const s of four) {
      tags.push(ints[R_EPOCH]!);
      r.retire(blocks, s);
    }
    expect(tags).toEqual([MAX - 2, MAX - 1, MAX, MIN]);
    expect(ints[R_EPOCH]).toBe(MIN + 1);
    const b = reader(3);
    b.enterRead();
    expect(ints[R_READER + 3]).toBe(MIN + 1);
    // A fifth release, tagged B's own epoch, which B may hold.
    const fifth = blocks.alloc();
    r.retire(blocks, fifth);
    expect(r.drain()).toBe(5);
    for (const s of [...four, fifth]) expect(blocks.refcount(s)).toBe(1);
    a.exitRead();
    expect(r.drain()).toBe(1);
    for (const s of four) expect(isFree(blocks, s)).toBe(true);
    expect(blocks.refcount(fifth)).toBe(1);
    b.exitRead();
    expect(r.drain()).toBe(0);
    expect(isFree(blocks, fifth)).toBe(true);
  });

  test('two readers either side of the wrap (A at 2³¹ − 1, B at −2³¹ + 2): `m` is A\'s; a release tagged −2³¹ + 1 stays until A exits', () => {
    const { ints, bytes, r, reader } = setup(true);
    Atomics.store(ints, R_EPOCH, MAX);
    const a = reader(2);
    a.enterRead();
    expect(ints[R_READER + 2]).toBe(MAX);
    // Two releases on thread 4's limbo carry G across the wrap, so thread 0's limbo holds the one release alone.
    const t4 = reader(4);
    const early = [bytes.alloc(), bytes.alloc()];
    for (const e of early) t4.retire(bytes, e); // tags 2³¹ − 1, −2³¹
    const s = bytes.alloc();
    expect(ints[R_EPOCH]).toBe(MIN + 1);
    r.retire(bytes, s); // tag −2³¹ + 1
    const b = reader(3);
    b.enterRead();
    expect(ints[R_READER + 3]).toBe(MIN + 2);
    // A numeric minimum would pick B (−2³¹ + 2) and free the release tagged −2³¹ + 1 under A.
    expect(r.drain()).toBe(1);
    expect(t4.drain()).toBe(2);
    expect(bytes.refcount(s)).toBe(1);
    expect(bytes.freeStack().includes(s)).toBe(false);
    a.exitRead();
    expect(r.drain()).toBe(0);
    expect(t4.drain()).toBe(0);
    for (const e of [...early, s]) expect(isFree(bytes, e)).toBe(true);
    b.exitRead();
  });

  test('no live reader: a drain after the wrap frees every entry', () => {
    const { ints, blocks, bytes, r, reader } = setup(true);
    Atomics.store(ints, R_EPOCH, MAX - 1);
    const a = reader(2);
    a.enterRead();
    const slots: Array<[SlabPool, number]> = [];
    for (let i = 0; i < 6; i++) {
      const p = i % 2 === 0 ? blocks : bytes;
      const s = p.alloc();
      slots.push([p, s]);
      r.retire(p, s); // tags 2³¹ − 2 … −2³¹ + 3
    }
    expect(ints[R_EPOCH]).toBe(MIN + 4);
    expect(r.drain()).toBe(6);
    a.exitRead();
    expect(r.drain()).toBe(0);
    for (const [p, s] of slots) expect(isFree(p, s)).toBe(true);
    expect(ints[R_LIMBO + MAIN_THREAD]).toBe(0);
  });

  test('a dead reader is ignored on either side of the wrap', () => {
    // The dead reader is the older one (before the wrap): the live B after it decides alone.
    {
      const { ints, blocks, r, reader } = setup(true);
      Atomics.store(ints, R_EPOCH, MAX - 1);
      reader(2).enterRead(); // A at 2³¹ − 2
      const before = [blocks.alloc(), blocks.alloc()];
      for (const s of before) r.retire(blocks, s); // tags 2³¹ − 2, 2³¹ − 1
      const b = reader(3);
      b.enterRead();
      expect(ints[R_READER + 3]).toBe(MIN);
      const held = blocks.alloc();
      r.retire(blocks, held); // tag −2³¹, B's epoch
      r.markDead(2);
      Atomics.store(ints, R_READER + 2, MAX - 1); // a dead thread's late store is ignored
      expect(r.drain()).toBe(1);
      for (const s of before) expect(isFree(blocks, s)).toBe(true);
      expect(blocks.refcount(held)).toBe(1);
      b.exitRead();
      expect(r.drain()).toBe(0);
      expect(isFree(blocks, held)).toBe(true);
    }
    // The dead reader is the newer one (after the wrap): the live A before it decides alone.
    {
      const { ints, bytes, r, reader } = setup(true);
      Atomics.store(ints, R_EPOCH, MAX - 1);
      const a = reader(2);
      a.enterRead(); // A at 2³¹ − 2
      const slots = [bytes.alloc(), bytes.alloc()];
      for (const s of slots) r.retire(bytes, s); // tags 2³¹ − 2, 2³¹ − 1
      reader(3).enterRead(); // B at −2³¹
      const after = bytes.alloc();
      r.retire(bytes, after); // tag −2³¹
      r.markDead(3);
      Atomics.store(ints, R_READER + 3, MIN); // a dead thread's late store is ignored
      expect(r.drain()).toBe(3); // A holds every release, the one tagged after the wrap too
      expect(bytes.refcount(after)).toBe(1);
      a.exitRead();
      expect(r.drain()).toBe(0);
      for (const s of [...slots, after]) expect(isFree(bytes, s)).toBe(true);
    }
  });

  test('with G stored as 0, `enterRead` announces 1 and G reads 1', () => {
    const { ints, r, reader } = setup(true);
    Atomics.store(ints, R_EPOCH, 0);
    const t5 = reader(5);
    t5.enterRead();
    expect(ints[R_READER + 5]).toBe(1);
    expect(ints[R_EPOCH]).toBe(1);
    t5.exitRead();
    // The main thread's reclaimer, through the same buffer.
    Atomics.store(ints, R_EPOCH, 0);
    r.enterRead();
    expect(ints[R_READER + MAIN_THREAD]).toBe(1);
    expect(ints[R_EPOCH]).toBe(1);
    r.exitRead();
  });
});

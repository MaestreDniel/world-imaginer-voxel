import { describe, expect, test } from 'vitest';
import {
  attachPool, BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES,
  GROW_BYTES, StoreFull, type SlabPool,
} from '../../src/world/store/pool';
import { testRng } from '../harness/stats';

const MiB = 1 << 20;

/** Every slot is either on the free stack (once, refcount 0) or live (refcount > 0): SP3a spec §3.6 "no lost slots". */
function expectConsistent(p: SlabPool): void {
  const stack = Array.from(p.freeStack());
  expect(new Set(stack).size).toBe(stack.length);
  for (const id of stack) expect(p.refcount(id)).toBe(0);
  let live = 0;
  for (let id = 0; id < p.slotCount(); id++) if (p.refcount(id) > 0) live++;
  expect(stack.length + live).toBe(p.slotCount());
  expect(p.freeCount()).toBe(stack.length);
}

test('slot sizes, growth step and default maxima (SP3a spec §3.1)', () => {
  expect(BLOCK_SLOT_BYTES).toBe(8192);
  expect(BYTE_SLOT_BYTES).toBe(4096);
  expect(GROW_BYTES).toBe(MiB);
  expect(DEFAULT_MAX_BLOCK_BYTES).toBe(768 * MiB);
  expect(DEFAULT_MAX_BYTE_BYTES).toBe(512 * MiB);
});

test('bad options are refused', () => {
  expect(() => createPool({ shared: false, slotBytes: 3000, maxBytes: MiB })).toThrow(RangeError);
  expect(() => createPool({ shared: false, slotBytes: 4096, maxBytes: MiB + 4096 })).toThrow(RangeError);
  expect(() => createPool({ shared: false, slotBytes: 4096, maxBytes: 0 })).toThrow(RangeError);
});

describe.each([true, false])('shared %s', (shared) => {
  const blockPool = (maxBytes = 4 * MiB) => createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes });
  const bytePool = (maxBytes = 4 * MiB) => createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes });

  test('backing: one growable buffer per pool, of the requested kind', () => {
    const p = blockPool();
    const h = p.handles();
    for (const buf of [h.data, h.stack, h.refs]) {
      expect(buf instanceof SharedArrayBuffer).toBe(shared);
      if (buf instanceof SharedArrayBuffer) expect(buf.growable).toBe(true);
      else expect(buf.resizable).toBe(true);
    }
    expect(h.data.maxByteLength).toBe(4 * MiB);
    expect(h.stack.maxByteLength).toBe(4 * p.maxSlots);
    expect(h.refs.maxByteLength).toBe(4 * p.maxSlots);
    expect(h.ctl instanceof SharedArrayBuffer).toBe(shared);
    expect(p.maxSlots).toBe(512);
    expect(p.slotBytes).toBe(BLOCK_SLOT_BYTES);
  });

  test('the default maxima reserve address space only', () => {
    const b = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: DEFAULT_MAX_BLOCK_BYTES });
    const y = createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: DEFAULT_MAX_BYTE_BYTES });
    expect(b.maxSlots).toBe(98_304);
    expect(y.maxSlots).toBe(131_072);
    expect(b.handles().data.byteLength).toBe(0);
    expect(b.alloc()).toBe(0);
    expect(b.handles().data.byteLength).toBe(MiB);
    expect(y.alloc()).toBe(0);
  });

  test('a fresh pool is empty; the first alloc grows it by 1 MiB and pops slot 0', () => {
    for (const [p, perStep] of [[blockPool(), 128], [bytePool(), 256]] as const) {
      expect(p.slotCount()).toBe(0);
      expect(p.freeCount()).toBe(0);
      expect(p.alloc()).toBe(0);
      expect(p.refcount(0)).toBe(1);
      expect(p.slotCount()).toBe(perStep);
      expect(p.freeCount()).toBe(perStep - 1);
      expect(p.alloc()).toBe(1);
      expectConsistent(p);
    }
  });

  test('length-tracking views see growth without being rebuilt', () => {
    const p = blockPool();
    const bytes = p.bytes;
    const words = p.words;
    expect(bytes.length).toBe(0);
    p.alloc();
    expect(bytes.length).toBe(MiB);
    expect(words.length).toBe(MiB / 2);
    for (let i = 0; i < 128; i++) p.alloc();
    expect(p.slotCount()).toBe(256);
    expect(bytes.length).toBe(2 * MiB);
    expect(p.handles().stack.byteLength).toBe(4 * 256);
    expect(p.handles().refs.byteLength).toBe(4 * 256);
  });

  test('slot views cover exactly the slot', () => {
    const p = blockPool();
    const a = p.alloc();
    const b = p.alloc();
    const ua = p.u16(a);
    expect(ua.length).toBe(4096);
    expect(p.u8(b).length).toBe(BLOCK_SLOT_BYTES);
    expect(p.u8(b).byteOffset).toBe(b * BLOCK_SLOT_BYTES);
    ua.fill(0xffff);
    expect(p.u16(b).every((v) => v === 0)).toBe(true);
    expect(p.words[a * 4096 + 4095]).toBe(0xffff);
    expect(p.bytes[b * BLOCK_SLOT_BYTES]).toBe(0);
  });

  test('exhausting the stack grows again; ids stay unique', () => {
    const p = blockPool();
    const ids = Array.from({ length: 129 }, () => p.alloc());
    expect(new Set(ids).size).toBe(129);
    expect(ids).toEqual(Array.from({ length: 129 }, (_, i) => i));
    expect(p.slotCount()).toBe(256);
    expectConsistent(p);
  });

  test('free pushes the slot back (LIFO) and never zeroes it', () => {
    const p = bytePool();
    const a = p.alloc();
    p.alloc();
    p.u8(a).fill(7);
    const before = p.freeCount();
    p.free(a);
    expect(p.refcount(a)).toBe(0);
    expect(p.freeCount()).toBe(before + 1);
    expect(p.freeStack().at(-1)).toBe(a);
    expect(p.alloc()).toBe(a);
    expect(p.u8(a).every((v) => v === 7)).toBe(true);
    expect(p.refcount(a)).toBe(1);
  });

  test('retain: a slot retained n times is freed n + 1 times', () => {
    const p = bytePool();
    const a = p.alloc();
    p.retain(a);
    p.retain(a);
    expect(p.refcount(a)).toBe(3);
    const free0 = p.freeCount();
    p.free(a);
    p.free(a);
    expect(p.refcount(a)).toBe(1);
    expect(p.freeCount()).toBe(free0);
    expect(p.freeStack()).not.toContain(a);
    p.free(a);
    expect(p.refcount(a)).toBe(0);
    expect(p.freeCount()).toBe(free0 + 1);
    expectConsistent(p);
  });

  test('free or retain of a free slot, and ids out of range, throw', () => {
    const p = bytePool();
    const a = p.alloc();
    p.free(a);
    expect(() => p.free(a)).toThrow(/refcount/);
    expect(() => p.retain(a)).toThrow(/refcount/);
    expect(p.refcount(a)).toBe(0);
    expect(() => p.free(-1)).toThrow(RangeError);
    expect(() => p.free(p.slotCount())).toThrow(RangeError);
    expect(() => p.retain(1.5)).toThrow(RangeError);
    expect(() => p.u8(p.slotCount())).toThrow(RangeError);
    expectConsistent(p);
  });

  test('StoreFull at the maximum, with the lock released and the pool intact', () => {
    const p = blockPool(MiB);
    const ids = Array.from({ length: 128 }, () => p.alloc());
    expect(() => p.alloc()).toThrow(StoreFull);
    try {
      p.alloc();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreFull);
      expect((e as Error).name).toBe('StoreFull');
    }
    expect(p.slotCount()).toBe(128);
    expect(p.lockWord()).toBe(0);
    p.free(ids[5]!);
    expect(p.alloc()).toBe(ids[5]);
    expect(() => p.alloc()).toThrow(StoreFull);
    expectConsistent(p);
  });

  test('handles and attachPool rebuild the same pool', () => {
    const p = bytePool();
    const q = attachPool(p.handles());
    expect(q.slotBytes).toBe(p.slotBytes);
    expect(q.maxSlots).toBe(p.maxSlots);
    expect(q.shared).toBe(shared);
    const viewBefore = q.bytes;
    const a = p.alloc();
    expect(q.slotCount()).toBe(256);
    expect(viewBefore.length).toBe(MiB);
    expect(q.refcount(a)).toBe(1);
    q.retain(a);
    expect(p.refcount(a)).toBe(2);
    p.u8(a)[3] = 99;
    expect(q.u8(a)[3]).toBe(99);
    const b = q.alloc();
    expect(b).not.toBe(a);
    p.free(a);
    q.free(a);
    expect(p.freeStack().at(-1)).toBe(a);
    expectConsistent(p);
    expectConsistent(q);
  });

  test('random ops keep every slot accounted for', () => {
    const p = blockPool(2 * MiB);
    const rng = testRng(7);
    const refs: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const r = rng() % 10;
      if ((r < 4 && refs.length < 250) || refs.length === 0) refs.push(p.alloc());
      else if (r < 6) {
        const id = refs[rng() % refs.length]!;
        p.retain(id);
        refs.push(id);
      } else {
        const k = rng() % refs.length;
        p.free(refs[k]!);
        refs[k] = refs[refs.length - 1]!;
        refs.pop();
      }
    }
    const counts = new Map<number, number>();
    for (const id of refs) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (let id = 0; id < p.slotCount(); id++) expect(p.refcount(id)).toBe(counts.get(id) ?? 0);
    expectConsistent(p);
    for (const id of refs) p.free(id);
    expect(p.freeCount()).toBe(p.slotCount());
    expect(p.lockWord()).toBe(0);
    expectConsistent(p);
  });
});

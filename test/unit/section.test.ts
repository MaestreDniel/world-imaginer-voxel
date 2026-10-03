import { describe, expect, test } from 'vitest';
import { BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, type SlabPool } from '../../src/world/store/pool';
import {
  byteAt, computeMeta, FINAL_BLOCKS, FINAL_FLUID, FINAL_INTS, FINAL_LIGHT, FINAL_META, isDense, META_CUTOUT,
  META_FLUID, META_NON_AIR, META_OPAQUE, META_TRANSLUCENT, PROTO_BLOCKS, PROTO_FLUID, PROTO_INTS, releaseEntry,
  sectionBytes, sectionWords, SECTION_VOXELS, shareEntry, storeBytes, storeWords, uniformCode, uniformValue, wordAt,
} from '../../src/world/store/section';

const MiB = 1 << 20;
/** A PASS table as the registry builds it (codes of SP3a spec §2.1): air none, 1 opaque, 2 cutout, 3 translucent. */
const PASS = new Uint8Array(4096);
PASS[1] = 1;
PASS[2] = 1;
PASS[5] = 2;
PASS[6] = 3;
PASS[7] = 0; // a non-air state with PASS none counts in nonAir but sets no pass bit

const words = (v: number) => new Uint16Array(SECTION_VOXELS).fill(v);
const bytes = (v: number) => new Uint8Array(SECTION_VOXELS).fill(v);

/** Every refcount and the free-stack size, to compare before and after. */
function snapshot(p: SlabPool): { free: number; refs: number[] } {
  const refs: number[] = [];
  for (let id = 0; id < p.slotCount(); id++) refs.push(p.refcount(id));
  return { free: p.freeCount(), refs };
}

test('descriptor encodings and layout (SP3a spec §3.3)', () => {
  expect(SECTION_VOXELS).toBe(4096);
  expect([FINAL_BLOCKS, FINAL_LIGHT, FINAL_FLUID, FINAL_META, FINAL_INTS]).toEqual([0, 1, 2, 3, 4]);
  expect([PROTO_BLOCKS, PROTO_FLUID, PROTO_INTS]).toEqual([0, 1, 2]);
  // −1 is uniform 0: air, light 0, no fluid.
  expect(uniformCode(0)).toBe(-1);
  expect(uniformCode(2)).toBe(-3);
  expect(uniformCode(4095)).toBe(-4096);
  expect(uniformCode(0x11)).toBe(-18); // a water source byte
  for (const v of [0, 1, 255, 4095, 65535]) expect(uniformValue(uniformCode(v))).toBe(v);
  expect(isDense(-1)).toBe(false);
  expect(isDense(0)).toBe(true);
  expect(isDense(17)).toBe(true);
});

test('meta word bits (SP3a spec §3.3)', () => {
  expect(META_NON_AIR).toBe(0x1fff);
  expect([META_OPAQUE, META_CUTOUT, META_TRANSLUCENT, META_FLUID]).toEqual([1 << 13, 1 << 14, 1 << 15, 1 << 16]);
  expect(computeMeta(words(0), bytes(0), PASS)).toBe(0);
  expect(computeMeta(0, 0, PASS)).toBe(0);
  expect(computeMeta(words(1), bytes(0), PASS)).toBe(4096 | META_OPAQUE);
  expect(computeMeta(1, 0, PASS)).toBe(4096 | META_OPAQUE);
  expect(computeMeta(7, 0, PASS)).toBe(4096);
  // Fluid type in bits 4-5 (water 1, lava 2); level, falling and unsettled alone are not a fluid.
  expect(computeMeta(0, 0x10, PASS)).toBe(META_FLUID);
  expect(computeMeta(0, 0x27, PASS)).toBe(META_FLUID);
  expect(computeMeta(0, 0x4f, PASS)).toBe(0);
  const b = words(0);
  b[0] = 1;
  b[100] = 5;
  b[4095] = 6;
  b[200] = 7;
  const f = bytes(0);
  f[3] = 0x18; // water, falling
  expect(computeMeta(b, f, PASS)).toBe(4 | META_OPAQUE | META_CUTOUT | META_TRANSLUCENT | META_FLUID);
  expect(computeMeta(b, 0, PASS)).toBe(4 | META_OPAQUE | META_CUTOUT | META_TRANSLUCENT);
  expect(computeMeta(b, uniformValue(-1), PASS) & META_NON_AIR).toBe(4);
});

describe.each([true, false])('shared %s', (shared) => {
  const pools = () => ({
    blocks: createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: 4 * MiB }),
    bytes: createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: 4 * MiB }),
  });

  test('uniform blocks take no slot; reading returns the constant', () => {
    const { blocks } = pools();
    const ints = new Int32Array(4).fill(-1);
    storeWords(blocks, ints, 1, words(2));
    expect(ints[1]).toBe(-3);
    expect(blocks.slotCount()).toBe(0);
    expect(sectionWords(blocks, ints[1]!)).toBe(2);
    expect(wordAt(blocks, ints[1]!, 0)).toBe(2);
    expect(wordAt(blocks, ints[1]!, 4095)).toBe(2);
    storeWords(blocks, ints, 1, words(0));
    expect(ints[1]).toBe(-1);
  });

  test('blocks: uniform → dense → uniform (promotion allocates, demotion releases)', () => {
    const { blocks } = pools();
    const ints = new Int32Array(2).fill(-1);
    const src = words(1);
    src[4095] = 2;
    storeWords(blocks, ints, 0, src);
    const id = ints[0]!;
    expect(isDense(id)).toBe(true);
    expect(blocks.refcount(id)).toBe(1);
    src[4095] = 9; // the store copied the array: the caller may reuse its scratch buffer
    const view = sectionWords(blocks, id) as Uint16Array;
    expect(view.length).toBe(4096);
    expect(view[0]).toBe(1);
    expect(view[4095]).toBe(2);
    expect(wordAt(blocks, id, 4095)).toBe(2);
    expect(wordAt(blocks, id, 17)).toBe(1);
    const before = blocks.freeCount();
    storeWords(blocks, ints, 0, words(1));
    expect(ints[0]).toBe(-2);
    expect(blocks.refcount(id)).toBe(0);
    expect(blocks.freeCount()).toBe(before + 1);
  });

  test('a dense rewrite takes a new slot and releases the old one', () => {
    const { blocks } = pools();
    const ints = new Int32Array(1).fill(-1);
    const a = words(0);
    a[0] = 1;
    storeWords(blocks, ints, 0, a);
    const first = ints[0]!;
    const b = words(0);
    b[1] = 1;
    storeWords(blocks, ints, 0, b);
    const second = ints[0]!;
    expect(second).not.toBe(first);
    expect(blocks.refcount(first)).toBe(0);
    expect(blocks.refcount(second)).toBe(1);
    expect(wordAt(blocks, second, 0)).toBe(0);
    expect(wordAt(blocks, second, 1)).toBe(1);
  });

  test('light and fluid bytes: uniform (including -1-byte fluid) and dense, both ways', () => {
    const { bytes: bp } = pools();
    const d = new Int32Array(4).fill(-1);
    // A full water section of an ocean costs no slot (SP3a spec §3.3, §11).
    storeBytes(bp, d, FINAL_FLUID, bytes(0x10));
    expect(d[FINAL_FLUID]).toBe(-1 - 0x10);
    expect(sectionBytes(bp, d[FINAL_FLUID]!)).toBe(0x10);
    expect(byteAt(bp, d[FINAL_FLUID]!, 77)).toBe(0x10);
    storeBytes(bp, d, FINAL_LIGHT, bytes(0xf0));
    expect(d[FINAL_LIGHT]).toBe(-1 - 0xf0);
    expect(bp.slotCount()).toBe(0);
    const mixed = bytes(0x10);
    mixed.fill(0, 2048);
    storeBytes(bp, d, FINAL_FLUID, mixed);
    const id = d[FINAL_FLUID]!;
    expect(isDense(id)).toBe(true);
    expect(byteAt(bp, id, 0)).toBe(0x10);
    expect(byteAt(bp, id, 4095)).toBe(0);
    const v = sectionBytes(bp, id) as Uint8Array;
    expect(v.length).toBe(4096);
    expect(Array.from(v.subarray(2046, 2050))).toEqual([0x10, 0x10, 0, 0]);
    storeBytes(bp, d, FINAL_FLUID, bytes(0));
    expect(d[FINAL_FLUID]).toBe(-1);
    expect(bp.refcount(id)).toBe(0);
  });

  test('channels are independent: dense blocks with uniform fluid and the reverse', () => {
    const { blocks, bytes: bp } = pools();
    const p = new Int32Array(2).fill(-1);
    const b = words(1);
    b[5] = 0;
    storeWords(blocks, p, PROTO_BLOCKS, b);
    storeBytes(bp, p, PROTO_FLUID, bytes(0));
    expect(isDense(p[PROTO_BLOCKS]!)).toBe(true);
    expect(p[PROTO_FLUID]).toBe(-1);
    const f = bytes(0);
    f[5] = 0x10;
    storeWords(blocks, p, PROTO_BLOCKS, words(1));
    storeBytes(bp, p, PROTO_FLUID, f);
    expect(p[PROTO_BLOCKS]).toBe(-2);
    expect(isDense(p[PROTO_FLUID]!)).toBe(true);
    expect(blocks.freeCount()).toBe(blocks.slotCount());
  });

  test('a slot recycled dirty is overwritten whole by the next dense write', () => {
    const { bytes: bp } = pools();
    const d = new Int32Array(1).fill(-1);
    const dirty = bytes(0xaa);
    dirty[0] = 1;
    storeBytes(bp, d, 0, dirty);
    const id = d[0]!;
    storeBytes(bp, d, 0, bytes(0));
    const next = bytes(0);
    next[1] = 3;
    storeBytes(bp, d, 0, next);
    expect(d[0]).toBe(id); // LIFO: the same slot comes back, never zeroed on free
    expect(Array.from(sectionBytes(bp, id) as Uint8Array).every((x, i) => x === (i === 1 ? 3 : 0))).toBe(true);
  });

  test('wrong-length arrays and a pool of the wrong slot size are refused', () => {
    const { blocks, bytes: bp } = pools();
    const d = new Int32Array(1).fill(-1);
    expect(() => storeWords(blocks, d, 0, new Uint16Array(4095))).toThrow(RangeError);
    expect(() => storeBytes(bp, d, 0, new Uint8Array(4097))).toThrow(RangeError);
    expect(() => storeWords(bp, d, 0, words(1))).toThrow(RangeError);
    expect(() => storeBytes(blocks, d, 0, bytes(1))).toThrow(RangeError);
    expect(d[0]).toBe(-1);
  });

  test('sharing: a shared slot holds two references; each set releases once', () => {
    const { blocks, bytes: bp } = pools();
    blocks.alloc(); // grow first, so the snapshot covers every slot the test touches
    bp.alloc();
    const before = { b: snapshot(blocks), y: snapshot(bp) };
    // One column's sy 0: proto at 0-1, final at 2-5 (any int layout works; the record's is §3.2's).
    const r = new Int32Array(6).fill(-1);
    r[5] = 0;
    const b = words(1);
    b[0] = 0;
    const f = bytes(0);
    f[0] = 0x10;
    storeWords(blocks, r, 0, b);
    storeBytes(bp, r, 1, f);
    shareEntry(blocks, r, 0, 2);
    shareEntry(bp, r, 1, 4);
    storeBytes(bp, r, 3, bytes(0xf0));
    expect(r[2]).toBe(r[0]);
    expect(r[4]).toBe(r[1]);
    expect(blocks.refcount(r[0]!)).toBe(2);
    expect(bp.refcount(r[1]!)).toBe(2);
    const blockSlot = r[0]!;
    const fluidSlot = r[1]!;
    // Free the proto set: the final set still holds the slots.
    releaseEntry(blocks, r, 0);
    releaseEntry(bp, r, 1);
    expect([r[0], r[1]]).toEqual([-1, -1]);
    expect(blocks.refcount(blockSlot)).toBe(1);
    expect(bp.refcount(fluidSlot)).toBe(1);
    expect(wordAt(blocks, r[2]!, 1)).toBe(1);
    // Then the final set: everything is back as before the column.
    releaseEntry(blocks, r, 2);
    releaseEntry(bp, r, 3);
    releaseEntry(bp, r, 4);
    expect([r[2], r[3], r[4]]).toEqual([-1, -1, -1]);
    expect(snapshot(blocks)).toEqual(before.b);
    expect(snapshot(bp)).toEqual(before.y);
  });

  test('sharing a uniform entry copies the code and retains nothing; releasing it releases nothing', () => {
    const { blocks } = pools();
    const r = new Int32Array(2).fill(-1);
    storeWords(blocks, r, 0, words(2));
    shareEntry(blocks, r, 0, 1);
    expect(r[1]).toBe(-3);
    releaseEntry(blocks, r, 0);
    releaseEntry(blocks, r, 1);
    expect(blocks.slotCount()).toBe(0);
  });

  test('sharing over a dense entry releases what the target held', () => {
    const { blocks } = pools();
    const r = new Int32Array(2).fill(-1);
    const a = words(0);
    a[0] = 1;
    storeWords(blocks, r, 0, a);
    storeWords(blocks, r, 1, a);
    const old = r[1]!;
    shareEntry(blocks, r, 0, 1);
    expect(blocks.refcount(old)).toBe(0);
    expect(blocks.refcount(r[0]!)).toBe(2);
    shareEntry(blocks, r, 0, 1); // re-sharing the same slot keeps the count
    expect(blocks.refcount(r[0]!)).toBe(2);
  });

  test('a failed dense write (StoreFull) leaves the descriptor and its slot intact', () => {
    const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: MiB });
    const r = new Int32Array(1).fill(-1);
    const a = words(0);
    a[0] = 1;
    storeWords(blocks, r, 0, a);
    const held = r[0]!;
    while (blocks.freeCount() > 0) blocks.alloc();
    const b = words(0);
    b[1] = 1;
    expect(() => storeWords(blocks, r, 0, b)).toThrow(/full/);
    expect(r[0]).toBe(held);
    expect(blocks.refcount(held)).toBe(1);
    expect(wordAt(blocks, held, 0)).toBe(1);
    storeWords(blocks, r, 0, words(0)); // a uniform write needs no slot and releases the held one
    expect(r[0]).toBe(-1);
    expect(blocks.refcount(held)).toBe(0);
  });
});

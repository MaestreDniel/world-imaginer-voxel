import { describe, expect, test } from 'vitest';
import { allocAux, AUX_A_OFFSETS, AUX_B_OFFSETS, AUX_BYTES, auxBView, auxView, HEIGHT_NONE } from '../../src/world/store/aux';
import { BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool } from '../../src/world/store/pool';

const MiB = 1 << 20;

test('aux A and aux B layouts (SP3a spec §3.4, master §2.3)', () => {
  expect(AUX_BYTES).toBe(4096);
  expect(AUX_A_OFFSETS).toEqual({
    worldSurfaceWG: 0, oceanFloorWG: 512, worldSurface: 1024, motionBlocking: 1536, oceanFloor: 2048,
    lightBlocking: 2560, surfaceBiome: 3072, tintTH: 3328,
  });
  // Six Int16[256] heightmaps, Uint8[256] surfaceBiome and Uint8[768] tintTH fill the slot exactly.
  expect(6 * 512 + 256 + 768).toBe(AUX_BYTES);
  expect(AUX_B_OFFSETS).toEqual({ caveBiomeQ: 0, surfaceBiomeQ: 1536 });
  expect(HEIGHT_NONE).toBe(-64);
});

describe.each([true, false])('shared %s', (shared) => {
  const bytePool = () => createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: 4 * MiB });

  test('views: named typed subarrays of the slot at the §3.4 offsets', () => {
    const pool = bytePool();
    pool.alloc();
    const slot = allocAux(pool);
    const a = auxView(pool, slot);
    const base = slot * AUX_BYTES;
    const heightmaps = ['worldSurfaceWG', 'oceanFloorWG', 'worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking'] as const;
    for (const k of heightmaps) {
      expect(a[k]).toBeInstanceOf(Int16Array);
      expect(a[k].length).toBe(256);
      expect(a[k].byteOffset).toBe(base + AUX_A_OFFSETS[k]);
      expect(a[k].buffer).toBe(pool.buffer);
    }
    expect(a.surfaceBiome).toBeInstanceOf(Uint8Array);
    expect(a.surfaceBiome.length).toBe(256);
    expect(a.surfaceBiome.byteOffset).toBe(base + 3072);
    expect(a.tintTH.length).toBe(768);
    expect(a.tintTH.byteOffset).toBe(base + 3328);
    const b = auxBView(pool, slot);
    expect(b.caveBiomeQ.length).toBe(1536);
    expect(b.caveBiomeQ.byteOffset).toBe(base);
    expect(b.surfaceBiomeQ.length).toBe(16);
    expect(b.surfaceBiomeQ.byteOffset).toBe(base + 1536);
  });

  test('Int16 values are little-endian at lz·16 + lx; the last tintTH byte is the last slot byte', () => {
    const pool = bytePool();
    const slot = allocAux(pool);
    const a = auxView(pool, slot);
    const base = slot * AUX_BYTES;
    const i = 3 * 16 + 5; // lx 5, lz 3
    a.oceanFloorWG[i] = -64;
    a.worldSurfaceWG[i] = 0x0102;
    expect(pool.bytes[base + 2 * i]).toBe(0x02);
    expect(pool.bytes[base + 2 * i + 1]).toBe(0x01);
    expect(new DataView(pool.buffer, base + 512 + 2 * i, 2).getInt16(0, true)).toBe(-64);
    a.tintTH[767] = 9;
    expect(pool.bytes[base + 4095]).toBe(9);
  });

  test('allocAux zero-fills the whole slot, a recycled dirty slot included', () => {
    const pool = bytePool();
    const slot = allocAux(pool);
    pool.u8(slot).fill(0xff);
    pool.free(slot);
    expect(pool.u8(slot)[0]).toBe(0xff); // the pool never zeroes on free
    const again = allocAux(pool);
    expect(again).toBe(slot);
    expect(pool.refcount(again)).toBe(1);
    expect(pool.u8(again).every((x) => x === 0)).toBe(true);
    const a = auxView(pool, again);
    expect(a.lightBlocking[255]).toBe(0);
    expect(auxBView(pool, again).surfaceBiomeQ[15]).toBe(0);
  });

  test('aux slots live in the byte pool only', () => {
    const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: 4 * MiB });
    expect(() => allocAux(blocks)).toThrow(RangeError);
    expect(blocks.slotCount()).toBe(0);
    expect(() => auxView(blocks, 0)).toThrow(RangeError);
  });
});

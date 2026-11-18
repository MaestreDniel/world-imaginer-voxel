import { describe, expect, test } from 'vitest';
import {
  allocAux, AUX_A_OFFSETS, AUX_B_OFFSETS, AUX_BYTES, auxBView, auxView, createScratchAux, HEIGHT_NONE,
} from '../../src/world/store/aux';
import { BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool } from '../../src/world/store/pool';
import { createStore } from '../../src/world/store/store';

const MiB = 1 << 20;

test('aux A and aux B layouts (SP3a spec §3.4, master §2.3)', () => {
  expect(AUX_BYTES).toBe(4096);
  expect(AUX_A_OFFSETS).toEqual({
    worldSurfaceWG: 0, oceanFloorWG: 512, worldSurface: 1024, motionBlocking: 1536, oceanFloor: 2048,
    lightBlocking: 2560, surfaceBiome: 3072, tintTH: 3328,
  });
  // Six Int16[256] heightmaps, Uint8[256] surfaceBiome and Uint8[768] tintTH fill the slot exactly.
  expect(6 * 512 + 256 + 768).toBe(AUX_BYTES);
  // seedSections (SP7a §1.7): one Uint32 after surfaceBiomeQ's 16 bytes, 4-byte aligned.
  expect(AUX_B_OFFSETS).toEqual({ caveBiomeQ: 0, surfaceBiomeQ: 1536, seedSections: 1552 });
  expect(AUX_B_OFFSETS.surfaceBiomeQ + 16).toBe(AUX_B_OFFSETS.seedSections);
  expect(AUX_B_OFFSETS.seedSections % 4).toBe(0);
  expect(HEIGHT_NONE).toBe(-64);
});

test("createScratchAux (SP4b spec §2.4): AuxView and AuxBView shapes over two worker-local 4096-byte ArrayBuffers, reading 0", () => {
  const { a, b } = createScratchAux();
  const heightmaps = ['worldSurfaceWG', 'oceanFloorWG', 'worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking'] as const;
  for (const k of heightmaps) {
    expect(a[k]).toBeInstanceOf(Int16Array);
    expect(a[k].length).toBe(256);
    expect(a[k].byteOffset).toBe(AUX_A_OFFSETS[k]);
    expect(a[k].every((v) => v === 0)).toBe(true);
  }
  expect(a.surfaceBiome).toBeInstanceOf(Uint8Array);
  expect([a.surfaceBiome.length, a.surfaceBiome.byteOffset]).toEqual([256, AUX_A_OFFSETS.surfaceBiome]);
  expect(a.tintTH).toBeInstanceOf(Uint8Array);
  expect([a.tintTH.length, a.tintTH.byteOffset]).toEqual([768, AUX_A_OFFSETS.tintTH]);
  expect(b.caveBiomeQ).toBeInstanceOf(Uint8Array);
  expect([b.caveBiomeQ.length, b.caveBiomeQ.byteOffset]).toEqual([1536, AUX_B_OFFSETS.caveBiomeQ]);
  expect(b.surfaceBiomeQ).toBeInstanceOf(Uint8Array);
  expect([b.surfaceBiomeQ.length, b.surfaceBiomeQ.byteOffset]).toEqual([16, AUX_B_OFFSETS.surfaceBiomeQ]);
  expect(b.seedSections).toBeInstanceOf(Uint32Array);
  expect([b.seedSections.length, b.seedSections.byteOffset]).toEqual([1, AUX_B_OFFSETS.seedSections]);
  expect(b.seedSections.buffer).toBe(b.caveBiomeQ.buffer);
  expect([...a.surfaceBiome, ...a.tintTH, ...b.caveBiomeQ, ...b.surfaceBiomeQ, ...b.seedSections].every((v) => v === 0)).toBe(true);
  // Two buffers, worker-local (not shared), one slot's size each.
  const bufA = a.worldSurfaceWG.buffer;
  const bufB = b.caveBiomeQ.buffer;
  expect(bufA).toBeInstanceOf(ArrayBuffer);
  expect(bufB).toBeInstanceOf(ArrayBuffer);
  expect(bufA).not.toBe(bufB);
  expect([bufA.byteLength, bufB.byteLength]).toEqual([AUX_BYTES, AUX_BYTES]);
  for (const k of heightmaps) expect(a[k].buffer).toBe(bufA);
  expect(b.surfaceBiomeQ.buffer).toBe(bufB);
  // Each call gets its own scratch.
  const again = createScratchAux();
  expect(again.a.worldSurfaceWG.buffer).not.toBe(bufA);
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
    // seedSections (SP7a §1.7): a Uint32Array of length 1 at byte 1552, bit sy for a section holding an in-column seed.
    expect(b.seedSections).toBeInstanceOf(Uint32Array);
    expect(b.seedSections.length).toBe(1);
    expect(b.seedSections.byteOffset).toBe(base + 1552);
    expect(b.seedSections.buffer).toBe(pool.buffer);
    b.seedSections[0] = (1 << 23) | 1;
    expect(new DataView(pool.buffer, base + 1552, 4).getUint32(0, true)).toBe((1 << 23) | 1);
    expect([pool.bytes[base + 1551], pool.bytes[base + 1556]]).toEqual([0, 0]);
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
    expect(auxBView(pool, again).seedSections[0]).toBe(0);
  });

  test('seedSections (SP7a §1.7): 0 on a fresh aux B slot; written by T, it survives a reopen at Proto and reads in the proto view', () => {
    const s = createStore({ shared, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
    // A recycled dirty slot first, so the fresh one is a reused slot.
    const dirty = s.bytePool.alloc();
    s.bytePool.u8(dirty).fill(0xff);
    s.bytePool.free(dirty);
    const w = s.claimColumn(2, -3, 0);
    const b = w.auxB();
    expect(b.seedSections[0]).toBe(0);
    const mask = (1 << 0) | (1 << 7) | (1 << 23);
    b.seedSections[0] = mask;
    w.commit(1);
    expect(s.proto(2, -3)!.auxB()!.seedSections[0]).toBe(mask);
    const d = s.reopenColumn(2, -3, 1);
    expect(d.auxB().seedSections[0]).toBe(mask);
    expect(d.auxB().seedSections.byteOffset).toBe(b.seedSections.byteOffset);
  });

  test('aux slots live in the byte pool only', () => {
    const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: 4 * MiB });
    expect(() => allocAux(blocks)).toThrow(RangeError);
    expect(blocks.slotCount()).toBe(0);
    expect(() => auxView(blocks, 0)).toThrow(RangeError);
  });
});

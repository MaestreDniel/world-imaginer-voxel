import { describe, expect, test } from 'vitest';
import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
import type { GenContext } from '../../src/gen/context';
import { fillColumnT, genRegionInProcess, regionHash } from '../../src/metrics/region';
import { torusSlot as torusSlotOf } from '../../src/core/coords';
import { protoAt, REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED, REC_EPOCH, STATUS_PROTO } from '../../src/world/store/columnTable';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, SlotBusy, StoreFull, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;
const ctx = ctxFor('42');
const newStore = (shared = false): VoxelStore => createStore({ shared, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });

/** Free-stack size and slot count of both pools. */
const slots = (s: VoxelStore) => [s.blockPool.freeCount(), s.blockPool.slotCount(), s.bytePool.freeCount(), s.bytePool.slotCount()];

/**
 * The §6.2 byte stream built by hand from the voxel and aux reads (no section views), then hashed in one go:
 * pins the order, the little-endian u16s, the uniform expansion and the aux bytes.
 */
function referenceHash(s: VoxelStore, cx0: number, cz0: number, w: number, h: number): string {
  const per = 24 * (8192 + 4096) + 2 * 4096;
  const out = new Uint8Array(w * h * per);
  let o = 0;
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = s.proto(cx, cz)!;
      for (let sy = 0; sy < 24; sy++) {
        for (let i = 0; i < 4096; i++) {
          const b = v.block(i & 15, -64 + 16 * sy + (i >> 8), (i >> 4) & 15);
          out[o++] = b & 255;
          out[o++] = b >> 8;
        }
        for (let i = 0; i < 4096; i++) out[o++] = v.fluid(i & 15, -64 + 16 * sy + (i >> 8), (i >> 4) & 15);
      }
      const a = v.aux()!;
      const i16 = (arr: Int16Array) => { for (const x of arr) { out[o++] = x & 255; out[o++] = (x >> 8) & 255; } };
      i16(a.worldSurfaceWG); i16(a.oceanFloorWG); i16(a.worldSurface); i16(a.motionBlocking); i16(a.oceanFloor); i16(a.lightBlocking);
      for (const x of a.surfaceBiome) out[o++] = x;
      for (const x of a.tintTH) out[o++] = x;
      // Aux B (SP3b spec §7): caveBiomeQ, surfaceBiomeQ, then zeros to 4096 bytes; all zeros without a slot.
      const b = v.auxB();
      if (b !== null) {
        for (const x of b.caveBiomeQ) out[o++] = x;
        for (const x of b.surfaceBiomeQ) out[o++] = x;
        o += 4096 - 1536 - 16;
      } else o += 4096;
    }
  }
  expect(o).toBe(out.length);
  return hex64(fnv1a64Bytes(out));
}

/** Generates the region's columns in the given order (cx, cz pairs). */
function genInOrder(s: VoxelStore, c: GenContext, cols: ReadonlyArray<readonly [number, number]>): void {
  for (const [cx, cz] of cols) expect(fillColumnT(s, c, cx, cz, NEVER)).toBe(true);
}

const rowMajor = (cx0: number, cz0: number, w: number, h: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let cz = cz0; cz < cz0 + h; cz++) for (let cx = cx0; cx < cx0 + w; cx++) out.push([cx, cz]);
  return out;
};

describe('fillColumnT (§4, §6.1)', () => {
  test('claims with the epoch, commits at status Proto (blockVersion 1)', () => {
    const s = newStore();
    expect(fillColumnT(s, ctx, 5, -7, NEVER, 9)).toBe(true);
    const base = s.table.find(5, -7);
    expect([s.table.status(base), s.table.ints[base + REC_EPOCH], s.table.ints[base + REC_BLOCK_VERSION]]).toEqual([STATUS_PROTO, 9, 1]);
    expect(s.proto(5, -7)).not.toBeNull();
    expect(s.final(5, -7)).toBeNull();
  });

  test('epoch defaults to 0; a held record throws SlotBusy', () => {
    const s = newStore();
    fillColumnT(s, ctx, 0, 0, NEVER);
    expect(s.table.ints[s.table.find(0, 0) + REC_EPOCH]).toBe(0);
    expect(() => fillColumnT(s, ctx, 0, 0, NEVER)).toThrow(SlotBusy);
    expect(() => fillColumnT(s, ctx, 64, 0, NEVER)).toThrow(SlotBusy);
  });

  // Polls 0 … 5 come before the density phase's cell layers 0, 8, …, 40; poll 6 before the surface pass (SP3c §1);
  // polls 7 … 30 before sections 0 … 23.
  test.each([0, 3, 5, 6, 7, 18, 30])('abort at poll %i: false, the record is free and no slot leaks', (k) => {
    const s = newStore();
    // Warm both pools with a whole column, so the snapshot covers the slots the aborted column takes.
    fillColumnT(s, ctx, 2, 2, NEVER);
    s.freeColumn(2, 2);
    const before = slots(s);
    expect(before[0]).toBe(before[1]);
    let polls = 0;
    expect(fillColumnT(s, ctx, 2, 2, () => ++polls > k, 4)).toBe(false);
    expect(slots(s)).toEqual(before);
    expect(s.table.find(2, 2)).toBe(-1);
    expect(s.proto(2, 2)).toBeNull();
    const rec = (2 + 64 * 2) * 160;
    expect(s.table.ints[rec + REC_CLAIMED]).toBe(0);
    // The record can be claimed again.
    expect(fillColumnT(s, ctx, 2, 2, NEVER)).toBe(true);
  });

  test('a stage that throws frees the column and rethrows', () => {
    const s = newStore();
    fillColumnT(s, ctx, 1, 1, NEVER);
    s.freeColumn(1, 1);
    const before = slots(s);
    let polls = 0;
    expect(() => fillColumnT(s, ctx, 1, 1, () => { if (++polls > 5) throw new Error('boom'); return false; })).toThrow('boom');
    expect(slots(s)).toEqual(before);
    expect(s.table.find(1, 1)).toBe(-1);
  });

  test.each([
    ['block', MiB, 16 * MiB],
    ['byte', 16 * MiB, MiB],
  ] as const)('the %s pool full in the middle of a column: StoreFull surfaces, the column is freed, no slot leaks', (_pool, maxBlockBytes, maxByteBytes) => {
    const s = createStore({ shared: false, maxBlockBytes, maxByteBytes });
    // Fill a 64 × 64 window column by column (one column per torus record) until a pool runs out.
    const filled: Array<[number, number]> = [];
    let failed: [number, number] | null = null;
    let error: unknown = null;
    outer: for (let cz = -2000; cz < -1936; cz++) {
      for (let cx = -2000; cx < -1936; cx++) {
        try {
          expect(fillColumnT(s, ctx, cx, cz, NEVER)).toBe(true);
          filled.push([cx, cz]);
        } catch (e) {
          failed = [cx, cz];
          error = e;
          break outer;
        }
      }
    }
    expect(error).toBeInstanceOf(StoreFull);
    expect(filled.length).toBeGreaterThan(0);
    const [fx, fz] = failed!;
    // The failed column is gone and its record free; the committed columns are intact.
    expect([s.table.find(fx, fz), s.proto(fx, fz)]).toEqual([-1, null]);
    expect(s.table.ints[torusSlotOf(fx, fz) * 160 + REC_CLAIMED]).toBe(0);
    // Live slots are exactly the committed columns' dense entries and aux slots: the half-written column left none.
    let blocks = 0;
    let bytes = 0;
    for (const [cx, cz] of filled) {
      const base = s.table.find(cx, cz);
      for (let sy = 0; sy < 24; sy++) {
        if (s.table.ints[protoAt(base, sy) + PROTO_BLOCKS]! >= 0) blocks++;
        if (s.table.ints[protoAt(base, sy) + PROTO_FLUID]! >= 0) bytes++;
      }
      if (s.table.ints[base + REC_AUX_A]! >= 0) bytes++;
      if (s.table.ints[base + REC_AUX_B]! >= 0) bytes++;
    }
    expect([s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()]).toEqual([blocks, bytes]);
    // The store stays usable: once columns are freed, the failed column fills and equals a fresh fill.
    for (const [cx, cz] of filled) s.freeColumn(cx, cz);
    expect([s.blockPool.freeCount(), s.bytePool.freeCount()]).toEqual([s.blockPool.slotCount(), s.bytePool.slotCount()]);
    expect(fillColumnT(s, ctx, fx, fz, NEVER)).toBe(true);
    const fresh = newStore();
    fillColumnT(fresh, ctx, fx, fz, NEVER);
    expect(regionHash(s, fx, fz, 1, 1)).toEqual(regionHash(fresh, fx, fz, 1, 1));
  });
});

describe('genRegionInProcess (§6.1)', () => {
  test('fills every column of the region at status Proto', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, -2, 3, 3, 2);
    for (const [cx, cz] of rowMajor(-2, 3, 3, 2)) expect(s.table.status(s.table.find(cx, cz))).toBe(STATUS_PROTO);
    expect(s.proto(1, 3)).toBeNull();
    expect(s.proto(-2, 5)).toBeNull();
  });

  test.each([[0, 1], [1, 0], [65, 1], [1, 65], [1.5, 1], [-1, 2]])('w = %s, h = %s is refused', (w, h) => {
    expect(() => genRegionInProcess(newStore(), ctx, 0, 0, w, h)).toThrow(RangeError);
  });

  test('64 columns wide fit the torus', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, -32, 0, 64, 1);
    expect(s.proto(31, 0)).not.toBeNull();
  });
});

describe('regionHash (§6.2)', () => {
  // Across a coast: sea, land and uniform water sections (see terrainStage.test.ts).
  const CX0 = -1668, CZ0 = -2001;

  // The deep-sea window holds uniform water sections (fluid −1 − 16) as well as dense and uniform-air ones.
  test.each([
    ['coast', CX0, CZ0, 3, 2], ['deep sea', -2000, -2000, 2, 1],
  ] as const)('%s: equals FNV-1a 64 over the §6.2 byte stream', (_name, cx0, cz0, w, h) => {
    const s = newStore();
    genRegionInProcess(s, ctx, cx0, cz0, w, h);
    expect(hex64(regionHash(s, cx0, cz0, w, h))).toBe(referenceHash(s, cx0, cz0, w, h));
  });

  test('aux B (SP3b spec §7): every byte of the slot counts; an absent slot hashes like a zero-filled one', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, CX0, CZ0, 2, 1);
    const want = regionHash(s, CX0, CZ0, 2, 1);
    const b = s.proto(CX0 + 1, CZ0)!.auxB()!;
    const slot = new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096);
    for (const i of [0, 1535, 1536 + 3, 4095]) {
      slot[i] = slot[i]! ^ 1;
      expect(regionHash(s, CX0, CZ0, 2, 1), `byte ${i}`).not.toEqual(want);
      slot[i] = slot[i]! ^ 1;
    }
    expect(regionHash(s, CX0, CZ0, 2, 1)).toEqual(want);
    // Zero the slot, then detach it from the record (the slot leaks; the store is thrown away): same hash.
    slot.fill(0);
    const zeroed = regionHash(s, CX0, CZ0, 2, 1);
    expect(zeroed).not.toEqual(want);
    s.table.ints[s.table.find(CX0 + 1, CZ0) + REC_AUX_B] = -1;
    expect(s.proto(CX0 + 1, CZ0)!.auxB()).toBeNull();
    expect(regionHash(s, CX0, CZ0, 2, 1)).toEqual(zeroed);
    expect(hex64(zeroed)).toBe(referenceHash(s, CX0, CZ0, 2, 1));
  });

  test('independent of backend, generation order and slot layout', () => {
    const a = newStore(false);
    genRegionInProcess(a, ctx, CX0, CZ0, 3, 3);
    const want = regionHash(a, CX0, CZ0, 3, 3);
    const b = newStore(true);
    genRegionInProcess(b, ctx, CX0, CZ0, 3, 3);
    expect(regionHash(b, CX0, CZ0, 3, 3)).toEqual(want);
    // Reversed order on a store whose pools hold scattered live slots first.
    const c = newStore(false);
    const held = [] as number[];
    for (let i = 0; i < 200; i++) held.push(c.blockPool.alloc(), c.bytePool.alloc());
    for (let i = 0; i < held.length; i += 3) (i % 2 === 0 ? c.blockPool : c.bytePool).free(held[i]!);
    genInOrder(c, ctx, rowMajor(CX0, CZ0, 3, 3).reverse());
    expect(regionHash(c, CX0, CZ0, 3, 3)).toEqual(want);
  });

  test('a sub-window hashes as the same window generated alone', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, CX0, CZ0, 4, 4);
    const alone = newStore();
    genRegionInProcess(alone, ctx, CX0 + 1, CZ0 + 2, 2, 2);
    expect(regionHash(s, CX0 + 1, CZ0 + 2, 2, 2)).toEqual(regionHash(alone, CX0 + 1, CZ0 + 2, 2, 2));
    expect(regionHash(s, CX0, CZ0, 1, 1)).toEqual(regionHash(s, CX0, CZ0, 1, 1));
    expect(regionHash(s, CX0, CZ0, 4, 4)).not.toEqual(regionHash(s, CX0 + 1, CZ0 + 2, 2, 2));
  });

  test('depends on the world: another seed gives another hash', () => {
    const a = newStore();
    genRegionInProcess(a, ctx, 0, 0, 2, 2);
    const b = newStore();
    genRegionInProcess(b, ctxFor('43'), 0, 0, 2, 2);
    expect(regionHash(a, 0, 0, 2, 2)).not.toEqual(regionHash(b, 0, 0, 2, 2));
  });

  test('a column outside the generated region throws; bad sizes are refused', () => {
    const s = newStore();
    genRegionInProcess(s, ctx, 0, 0, 2, 2);
    expect(() => regionHash(s, 0, 0, 3, 2)).toThrow(/column \(2, 0\)/);
    expect(() => regionHash(s, 0, 0, 0, 2)).toThrow(RangeError);
  });
});

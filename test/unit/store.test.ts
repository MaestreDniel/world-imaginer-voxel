import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import { AUX_A_OFFSETS, AUX_B_OFFSETS } from '../../src/world/store/aux';
import {
  finalAt, NO_COLUMN, protoAt, RECORD_COUNT, RECORD_INTS, REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED,
  REC_CX, REC_CZ, REC_EPOCH, REC_LIGHT_VERSION, REC_STATUS, SECTIONS, STATUS_ABSENT,
} from '../../src/world/store/columnTable';
import { EPOCH_CELL } from '../../src/world/store/epochs';
import { DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES, type SlabPool } from '../../src/world/store/pool';
import {
  FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, FINAL_META, META_CUTOUT, META_FLUID, META_OPAQUE, PROTO_BLOCKS, PROTO_FLUID,
} from '../../src/world/store/section';
import {
  attachStore, createStore, DEFAULT_PASS, SlotBusy, StoreFull, type VoxelStore,
} from '../../src/world/store/store';

const MiB = 1 << 20;
const words = (v: number) => new Uint16Array(4096).fill(v);
const bytes = (v: number) => new Uint8Array(4096).fill(v);
/** Voxel index of (lx, ly, lz) in a section (SP3a spec §1). */
const vi = (lx: number, ly: number, lz: number) => (ly << 8) | (lz << 4) | lx;
const WATER = 0x10;

/** Every refcount and the free-stack size of a pool. */
function snap(p: SlabPool): { free: number; count: number; refs: number[] } {
  const refs: number[] = [];
  for (let id = 0; id < p.slotCount(); id++) refs.push(p.refcount(id));
  return { free: p.freeCount(), count: p.slotCount(), refs };
}
const snapStore = (s: VoxelStore) => ({ blocks: snap(s.blockPool), bytes: snap(s.bytePool) });

/** Grows both pools once, so that a test's snapshots cover every slot it touches. */
function warm(s: VoxelStore): void {
  s.blockPool.free(s.blockPool.alloc());
  s.bytePool.free(s.bytePool.alloc());
}

/** A section with stone below ly 8 and air above, plus one bedrock voxel: dense blocks. */
function mixedBlocks(): Uint16Array {
  const b = words(0);
  b.fill(1, 0, 8 << 8);
  b[0] = 2;
  return b;
}

/** Water sources in the bottom half, nothing above: dense fluid. */
function mixedFluid(): Uint8Array {
  const f = bytes(0);
  f.fill(WATER, 0, 8 << 8);
  return f;
}

describe.each([true, false])('shared %s', (shared) => {
  const newStore = (o: { maxBlockBytes?: number; maxByteBytes?: number } = {}) =>
    createStore({ shared, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB, ...o });

  test('defaults and backing (SP3a spec §3.5): two pools, a column table, epoch cells', () => {
    const s = createStore({ shared });
    expect(s.shared).toBe(shared);
    expect(s.blockPool.maxSlots).toBe(DEFAULT_MAX_BLOCK_BYTES / 8192);
    expect(s.bytePool.maxSlots).toBe(DEFAULT_MAX_BYTE_BYTES / 4096);
    expect(s.blockPool.slotBytes).toBe(8192);
    expect(s.bytePool.slotBytes).toBe(4096);
    const h = s.handles();
    expect(h.shared).toBe(shared);
    for (const buf of [h.table, h.epochs, h.blocks.data, h.bytes.data]) expect(buf instanceof SharedArrayBuffer).toBe(shared);
    expect(h.table.byteLength).toBe(RECORD_COUNT * RECORD_INTS * 4);
    expect(Array.from(h.pass)).toEqual(Array.from(DEFAULT_PASS));
  });

  test('every record starts free (SP3a spec §3.2)', () => {
    const s = newStore();
    const ints = s.table.ints;
    for (const rec of [0, 1, 63, 64, 4095]) {
      const base = rec * RECORD_INTS;
      expect(ints[base + REC_CLAIMED]).toBe(0);
      expect(ints[base + REC_STATUS]).toBe(STATUS_ABSENT);
      expect(ints[base + REC_AUX_A]).toBe(-1);
      expect(ints[base + REC_AUX_B]).toBe(-1);
      for (let sy = 0; sy < SECTIONS; sy++) {
        expect(Array.from(ints.subarray(finalAt(base, sy), finalAt(base, sy) + 4))).toEqual([-1, -1, -1, 0]);
        expect(Array.from(ints.subarray(protoAt(base, sy), protoAt(base, sy) + 2))).toEqual([-1, -1]);
      }
    }
    expect(s.proto(0, 0)).toBeNull();
    expect(s.final(0, 0)).toBeNull();
  });

  test('claimColumn: cx, cz, epoch written; status Absent, versions 0, descriptors −1, aux −1', () => {
    const s = newStore();
    const w = s.claimColumn(-3, 70, 9);
    expect([w.cx, w.cz]).toEqual([-3, 70]);
    const base = s.table.find(-3, 70);
    expect(base).toBeGreaterThanOrEqual(0);
    const ints = s.table.ints;
    expect([ints[base + REC_CX], ints[base + REC_CZ], ints[base + REC_STATUS], ints[base + REC_EPOCH]]).toEqual([-3, 70, 0, 9]);
    expect([ints[base + REC_BLOCK_VERSION], ints[base + REC_LIGHT_VERSION], ints[base + REC_CLAIMED]]).toEqual([0, 0, 1]);
    expect([ints[base + REC_AUX_A], ints[base + REC_AUX_B]]).toEqual([-1, -1]);
    // Not committed: no reader sees it yet (proto needs status ≥ Proto, final ≥ Decorated).
    expect(s.proto(-3, 70)).toBeNull();
    expect(s.final(-3, 70)).toBeNull();
  });

  test('commit: blockVersion + 1, then status; proto visible from Proto, final from Decorated', () => {
    const s = newStore();
    const w = s.claimColumn(1, 2, 0);
    const base = s.table.find(1, 2);
    w.commit(1);
    expect(s.table.blockVersion(base)).toBe(1);
    expect(s.table.status(base)).toBe(1);
    expect(s.proto(1, 2)).not.toBeNull();
    expect(s.final(1, 2)).toBeNull();
    w.commit(2);
    expect(s.table.blockVersion(base)).toBe(2);
    expect(s.final(1, 2)).not.toBeNull();
    w.commit(3);
    expect(s.table.status(base)).toBe(3);
    expect(() => w.commit(0 as 1)).toThrow(RangeError);
    expect(() => w.commit(4 as 1)).toThrow(RangeError);
  });

  test('unwritten sections read as air, light 0 and no fluid', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    w.commit(3);
    for (const v of [s.proto(0, 0)!, s.final(0, 0)!]) {
      for (const y of [-64, 0, 63, 319]) {
        expect(v.block(0, y, 0)).toBe(0);
        expect(v.fluid(15, y, 15)).toBe(0);
        expect(v.light(7, y, 3)).toBe(0);
      }
      expect(v.sectionBlocks(0)).toBe(0);
      expect(v.sectionFluid(23)).toBe(0);
      expect(v.aux()).toBeNull();
    }
    expect(s.blockPool.slotCount()).toBe(0);
    expect(s.bytePool.slotCount()).toBe(0);
  });

  test('setProto: per channel uniform or dense; reads by absolute y; copies its inputs', () => {
    const s = newStore();
    const w = s.claimColumn(5, -5, 0);
    const blocks = mixedBlocks();
    const fluid = mixedFluid();
    w.setProto(4, blocks, fluid); // y 0 … 15
    w.setProto(0, words(2), bytes(0)); // y −64 … −49: uniform bedrock, no fluid
    w.setProto(23, words(0), bytes(WATER)); // uniform air with uniform water: no slot
    blocks.fill(7);
    fluid.fill(0);
    w.commit(1);
    const base = s.table.find(5, -5);
    const ints = s.table.ints;
    expect(ints[protoAt(base, 4) + PROTO_BLOCKS]).toBeGreaterThanOrEqual(0);
    expect(ints[protoAt(base, 4) + PROTO_FLUID]).toBeGreaterThanOrEqual(0);
    expect([ints[protoAt(base, 0) + PROTO_BLOCKS], ints[protoAt(base, 0) + PROTO_FLUID]]).toEqual([-3, -1]);
    expect([ints[protoAt(base, 23) + PROTO_BLOCKS], ints[protoAt(base, 23) + PROTO_FLUID]]).toEqual([-1, -1 - WATER]);
    expect(s.blockPool.freeCount()).toBe(s.blockPool.slotCount() - 1);
    expect(s.bytePool.freeCount()).toBe(s.bytePool.slotCount() - 1);
    const v = s.proto(5, -5)!;
    expect([v.cx, v.cz]).toEqual([5, -5]);
    expect(v.block(0, 0, 0)).toBe(2);
    expect(v.block(1, 0, 0)).toBe(1);
    expect(v.block(15, 7, 15)).toBe(1);
    expect(v.block(15, 8, 15)).toBe(0);
    expect(v.fluid(3, 7, 3)).toBe(WATER);
    expect(v.fluid(3, 8, 3)).toBe(0);
    expect(v.block(9, -64, 9)).toBe(2);
    expect(v.block(9, 319, 9)).toBe(0);
    expect(v.fluid(9, 319, 9)).toBe(WATER);
    expect(v.light(9, 0, 9)).toBe(0); // a proto set has no light
    const sb = v.sectionBlocks(4) as Uint16Array;
    expect(sb).toBeInstanceOf(Uint16Array);
    expect(sb.length).toBe(4096);
    expect(sb[vi(0, 0, 0)]).toBe(2);
    expect(sb[vi(0, 9, 0)]).toBe(0);
    expect((v.sectionFluid(4) as Uint8Array)[vi(0, 0, 0)]).toBe(WATER);
    expect(v.sectionBlocks(0)).toBe(2);
    expect(v.sectionFluid(23)).toBe(WATER);
  });

  test('uniform ↔ dense per channel, both ways, releasing what a rewrite replaces', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(0, 0, 0);
    w.setProto(3, mixedBlocks(), bytes(0)); // blocks dense, fluid uniform
    expect(s.blockPool.freeCount()).toBe(before.blocks.free - 1);
    expect(s.bytePool.freeCount()).toBe(before.bytes.free);
    w.setProto(3, words(1), mixedFluid()); // blocks demoted, fluid promoted
    expect(s.blockPool.freeCount()).toBe(before.blocks.free);
    expect(s.bytePool.freeCount()).toBe(before.bytes.free - 1);
    w.setFinal(3, words(1), mixedFluid(), bytes(0)); // light dense, fluid uniform
    expect(s.bytePool.freeCount()).toBe(before.bytes.free - 2);
    w.setFinal(3, mixedBlocks(), bytes(0xf0), mixedFluid()); // blocks promoted, light demoted, fluid promoted
    expect(s.blockPool.freeCount()).toBe(before.blocks.free - 1);
    expect(s.bytePool.freeCount()).toBe(before.bytes.free - 2);
    w.setProto(3, words(0), bytes(0));
    w.setFinal(3, words(0), bytes(0), bytes(0));
    expect(snapStore(s)).toEqual(before);
    w.commit(2);
    const f = s.final(0, 0)!;
    expect(f.light(0, -16, 0)).toBe(0);
    s.freeColumn(0, 0);
    expect(snapStore(s)).toEqual(before);
  });

  test('setFinal: light reads; meta computed from blocks and fluid (SP3a spec §3.3)', () => {
    const s = newStore();
    const w = s.claimColumn(2, 3, 0);
    const light = bytes(0xf0);
    light[vi(4, 5, 6)] = 0x3a;
    w.setFinal(10, mixedBlocks(), light, mixedFluid());
    w.setFinal(11, words(1), bytes(0xf0), bytes(0));
    w.setFinal(12, words(0), bytes(0xf0), bytes(WATER));
    w.commit(2);
    const base = s.table.find(2, 3);
    const meta = (sy: number) => s.table.ints[finalAt(base, sy) + FINAL_META];
    expect(meta(10)).toBe((8 * 256) | META_OPAQUE | META_FLUID);
    expect(meta(11)).toBe(4096 | META_OPAQUE);
    expect(meta(12)).toBe(META_FLUID);
    expect(meta(13)).toBe(0);
    const v = s.final(2, 3)!;
    const y0 = 10 * 16 - 64;
    expect(v.light(4, y0 + 5, 6)).toBe(0x3a);
    expect(v.light(4, y0 + 5, 7)).toBe(0xf0);
    expect(v.block(0, y0, 0)).toBe(2);
    expect(v.fluid(0, y0, 0)).toBe(WATER);
    expect(v.fluid(0, y0 + 16, 0)).toBe(0);
    // The proto set is a separate set: untouched by setFinal.
    expect(s.proto(2, 3)!.block(0, y0, 0)).toBe(0);
  });

  test('meta uses the store\'s PASS table', () => {
    const pass = new Uint8Array(4096);
    pass[1] = 2; // stone as cutout, for the test
    const s = createStore({ shared, maxBlockBytes: MiB, maxByteBytes: MiB, pass });
    expect(Array.from(s.handles().pass.subarray(0, 3))).toEqual([0, 2, 0]);
    const w = s.claimColumn(0, 0, 0);
    w.setFinal(0, words(1), bytes(0), bytes(0));
    expect(s.table.ints[finalAt(s.table.find(0, 0), 0) + FINAL_META]).toBe(4096 | META_CUTOUT);
    expect(DEFAULT_PASS[0]).toBe(0);
    expect(DEFAULT_PASS[1]).toBe(1);
    expect(DEFAULT_PASS[2]).toBe(1);
    expect(() => createStore({ shared, pass: new Uint8Array(10) })).toThrow(RangeError);
  });

  test('shareFinal: final blocks and fluid share the proto slots (refcount 2); light and meta as setFinal', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    w.setProto(6, mixedBlocks(), mixedFluid());
    w.setProto(7, words(1), bytes(0));
    const base = s.table.find(0, 0);
    const ints = s.table.ints;
    const pb = ints[protoAt(base, 6) + PROTO_BLOCKS]!;
    const pf = ints[protoAt(base, 6) + PROTO_FLUID]!;
    const light = bytes(0xff);
    light[1] = 0;
    w.shareFinal(6, light);
    w.shareFinal(7, bytes(0xf0));
    expect(ints[finalAt(base, 6) + FINAL_BLOCKS]).toBe(pb);
    expect(ints[finalAt(base, 6) + FINAL_FLUID]).toBe(pf);
    expect(s.blockPool.refcount(pb)).toBe(2);
    expect(s.bytePool.refcount(pf)).toBe(2);
    expect(ints[finalAt(base, 6) + FINAL_LIGHT]).toBeGreaterThanOrEqual(0);
    expect(ints[finalAt(base, 6) + FINAL_META]).toBe((8 * 256) | META_OPAQUE | META_FLUID);
    expect([ints[finalAt(base, 7) + FINAL_BLOCKS], ints[finalAt(base, 7) + FINAL_LIGHT], ints[finalAt(base, 7) + FINAL_FLUID]])
      .toEqual([-2, -1 - 0xf0, -1]);
    expect(ints[finalAt(base, 7) + FINAL_META]).toBe(4096 | META_OPAQUE);
    w.commit(2);
    const f = s.final(0, 0)!;
    expect(f.light(1, 32, 0)).toBe(0);
    expect(f.light(2, 32, 0)).toBe(0xff);
    expect(f.block(0, 32, 0)).toBe(2);
  });

  test('sharing and release: free the proto set, then the final set; every refcount and the stack come back', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(4, 4, 0);
    w.setProto(6, mixedBlocks(), mixedFluid());
    w.shareFinal(6, mixedFluid());
    w.aux().worldSurfaceWG[0] = 12;
    w.commit(2);
    const base = s.table.find(4, 4);
    const pb = s.table.ints[protoAt(base, 6) + PROTO_BLOCKS]!;
    s.freeProto(4, 4);
    expect(s.blockPool.refcount(pb)).toBe(1);
    expect(s.table.ints[protoAt(base, 6) + PROTO_BLOCKS]).toBe(-1);
    expect(s.table.ints[protoAt(base, 6) + PROTO_FLUID]).toBe(-1);
    // The final set still reads its (formerly shared) slots.
    const f = s.final(4, 4)!;
    expect(f.block(0, 32, 0)).toBe(2);
    expect(f.fluid(0, 32, 0)).toBe(WATER);
    expect(f.aux()!.worldSurfaceWG[0]).toBe(12);
    s.freeColumn(4, 4);
    expect(snapStore(s)).toEqual(before);
    expect(s.final(4, 4)).toBeNull();
    expect(s.table.find(4, 4)).toBe(-1);
  });

  test('sharing and release: freeing the whole column releases each shared slot twice', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(4, 4, 0);
    for (let sy = 0; sy < 6; sy++) {
      w.setProto(sy, mixedBlocks(), mixedFluid());
      if (sy % 2 === 0) w.shareFinal(sy, mixedFluid());
      else w.setFinal(sy, mixedBlocks(), bytes(1), bytes(0));
    }
    w.aux();
    w.auxB();
    w.commit(3);
    expect(s.blockPool.freeCount()).toBe(before.blocks.free - 9);
    s.freeColumn(4, 4);
    expect(snapStore(s)).toEqual(before);
    // freeProto and freeColumn of a free record do nothing.
    s.freeProto(4, 4);
    s.freeColumn(4, 4);
    expect(snapStore(s)).toEqual(before);
  });

  test('freeColumn works on a half-written column (no commit)', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(-1, -1, 3);
    w.setProto(0, mixedBlocks(), mixedFluid());
    w.setProto(1, mixedBlocks(), bytes(0));
    w.aux();
    s.freeColumn(-1, -1);
    expect(snapStore(s)).toEqual(before);
    const base = (63 + 64 * 63) * RECORD_INTS;
    expect(s.table.ints[base + REC_CLAIMED]).toBe(0);
    expect(s.table.ints[base + REC_CX]).toBe(NO_COLUMN);
    expect(s.table.ints[base + REC_AUX_A]).toBe(-1);
    expect(s.table.ints[protoAt(base, 0)]).toBe(-1);
  });

  test('a writer whose column was freed refuses to write', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    s.freeColumn(0, 0);
    expect(() => w.setProto(0, words(1), bytes(0))).toThrow(/no longer holds/);
    expect(() => w.commit(1)).toThrow(/no longer holds/);
    expect(() => w.aux()).toThrow(/no longer holds/);
    s.claimColumn(64, 0, 0); // same record, another column
    expect(() => w.setFinal(0, words(1), bytes(0), bytes(0))).toThrow(/no longer holds/);
    expect(s.blockPool.slotCount()).toBe(0);
  });

  test('bad section indices and channel lengths are refused', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    expect(() => w.setProto(-1, words(0), bytes(0))).toThrow(RangeError);
    expect(() => w.setProto(24, words(0), bytes(0))).toThrow(RangeError);
    expect(() => w.setProto(1.5, words(0), bytes(0))).toThrow(RangeError);
    expect(() => w.setProto(0, new Uint16Array(10), bytes(0))).toThrow(RangeError);
    expect(() => w.shareFinal(0, new Uint8Array(10))).toThrow(RangeError);
    w.commit(2);
    const v = s.final(0, 0)!;
    expect(() => v.block(16, 0, 0)).toThrow(RangeError);
    expect(() => v.block(0, -65, 0)).toThrow(RangeError);
    expect(() => v.block(0, 320, 0)).toThrow(RangeError);
    expect(() => v.light(0, 0, -1)).toThrow(RangeError);
    expect(() => v.sectionBlocks(24)).toThrow(RangeError);
  });

  test('SlotBusy on a held record; freeColumn then claim succeeds with no leaked slot', () => {
    const s = newStore();
    warm(s);
    const before = snapStore(s);
    const w = s.claimColumn(3, 3, 0);
    w.setProto(2, mixedBlocks(), mixedFluid());
    w.commit(1);
    expect(() => s.claimColumn(3, 3, 0)).toThrow(SlotBusy);
    expect(() => s.claimColumn(3 + 64, 3, 0)).toThrow(SlotBusy);
    expect(() => s.claimColumn(3, 3 - 128, 0)).toThrow(SlotBusy);
    let err: unknown;
    try { s.claimColumn(67, 3, 0); } catch (e) { err = e; }
    expect((err as Error).name).toBe('SlotBusy');
    // The failed claims left the holder intact.
    expect(s.proto(3, 3)!.block(0, -32, 0)).toBe(2);
    s.freeColumn(3, 3);
    const w2 = s.claimColumn(67, 3, 1);
    w2.commit(1);
    expect(s.proto(67, 3)!.block(0, -32, 0)).toBe(0);
    s.freeColumn(67, 3);
    expect(snapStore(s)).toEqual(before);
  });

  test('a record holding another column reads as absent; freeing the wrong column does nothing', () => {
    const s = newStore();
    const w = s.claimColumn(10, 20, 0);
    w.setProto(0, mixedBlocks(), bytes(0));
    w.commit(3);
    for (const [cx, cz] of [[74, 20], [10, 84], [-54, -44]] as const) {
      expect(s.proto(cx, cz)).toBeNull();
      expect(s.final(cx, cz)).toBeNull();
      s.freeColumn(cx, cz);
      s.freeProto(cx, cz);
    }
    expect(s.proto(10, 20)!.block(0, -64, 0)).toBe(2);
    expect(s.blockPool.freeCount()).toBe(s.blockPool.slotCount() - 1);
  });

  test('aux A and aux B: offsets, one slot each, allocated on first call and zero-filled even when recycled dirty', () => {
    const s = newStore();
    const w = s.claimColumn(0, 0, 0);
    const a = w.aux();
    expect(w.aux().worldSurfaceWG.byteOffset).toBe(a.worldSurfaceWG.byteOffset); // same slot on later calls
    const base = s.table.find(0, 0);
    const slotA = s.table.ints[base + REC_AUX_A]!;
    expect(slotA).toBeGreaterThanOrEqual(0);
    const at = slotA * 4096;
    for (const [k, off] of Object.entries(AUX_A_OFFSETS)) expect(a[k as keyof typeof a].byteOffset).toBe(at + off);
    expect(a.worldSurfaceWG.length).toBe(256);
    expect(a.tintTH.length).toBe(768);
    expect(s.table.ints[base + REC_AUX_B]).toBe(-1);
    const b = w.auxB();
    const slotB = s.table.ints[base + REC_AUX_B]!;
    expect(slotB).not.toBe(slotA);
    for (const [k, off] of Object.entries(AUX_B_OFFSETS)) expect(b[k as keyof typeof b].byteOffset).toBe(slotB * 4096 + off);
    // Dirty both slots, free the column; the next column gets the same slots back (LIFO) and reads zeros.
    s.bytePool.bytes.fill(0xab, slotA * 4096, slotA * 4096 + 4096);
    s.bytePool.bytes.fill(0xcd, slotB * 4096, slotB * 4096 + 4096);
    s.freeColumn(0, 0);
    const w2 = s.claimColumn(1, 0, 0);
    const a2 = w2.aux();
    const b2 = w2.auxB();
    const base2 = s.table.find(1, 0);
    expect(new Set([s.table.ints[base2 + REC_AUX_A], s.table.ints[base2 + REC_AUX_B]])).toEqual(new Set([slotA, slotB]));
    for (const v of [a2.worldSurfaceWG, a2.oceanFloorWG, a2.lightBlocking, a2.surfaceBiome, a2.tintTH, b2.caveBiomeQ, b2.surfaceBiomeQ]) {
      expect(v.every((x) => x === 0)).toBe(true);
    }
    expect(s.bytePool.u8(slotA).every((x) => x === 0)).toBe(true);
    expect(s.bytePool.u8(slotB).every((x) => x === 0)).toBe(true);
    // ColumnView.aux reads the same bytes.
    a2.oceanFloorWG[255] = -64;
    a2.surfaceBiome[17] = 9;
    w2.commit(1);
    const av = s.proto(1, 0)!.aux()!;
    expect(av.oceanFloorWG[255]).toBe(-64);
    expect(av.surfaceBiome[17]).toBe(9);
  });

  test('StoreFull at the maximum; the descriptor keeps its old value and freeColumn releases everything', () => {
    const s = newStore({ maxBlockBytes: MiB, maxByteBytes: MiB }); // 128 block slots, 256 byte slots
    const cols: [number, number][] = [];
    let thrown: unknown = null;
    outer: for (let c = 0; c < 8; c++) {
      const w = s.claimColumn(c, 0, 0);
      cols.push([c, 0]);
      for (let sy = 0; sy < SECTIONS; sy++) {
        try {
          w.setProto(sy, mixedBlocks(), bytes(0));
        } catch (e) {
          thrown = e;
          expect(s.table.ints[protoAt(s.table.find(c, 0), sy) + PROTO_BLOCKS]).toBe(-1);
          break outer;
        }
      }
    }
    expect(thrown).toBeInstanceOf(StoreFull);
    expect(s.blockPool.slotCount()).toBe(128);
    expect(s.blockPool.freeCount()).toBe(0);
    for (const [cx, cz] of cols) s.freeColumn(cx, cz);
    expect(s.blockPool.freeCount()).toBe(128);
  });

  test('epoch cells live in the store and travel with its handles', () => {
    const s = newStore();
    expect(s.epochs.get(EPOCH_CELL.terrain)).toBe(0);
    s.epochs.set(EPOCH_CELL.light, 7);
    expect(s.epochs.bump(EPOCH_CELL.light)).toBe(8);
    const t = attachStore(s.handles());
    expect(t.epochs.get(EPOCH_CELL.light)).toBe(8);
    t.epochs.bump(EPOCH_CELL.mesh);
    expect(s.epochs.get(EPOCH_CELL.mesh)).toBe(1);
  });

  test('neighborhood: proto/final over the 3 × 3, and versions() in (dz, dx) order, −1 when absent', () => {
    const s = newStore();
    const n = s.neighborhood(10, -10);
    expect([n.cx, n.cz]).toEqual([10, -10]);
    expect(Array.from(n.versions())).toEqual(new Array(18).fill(-1));
    const a = s.claimColumn(9, -11, 0); // (dx, dz) = (−1, −1): entry 0
    a.setProto(0, words(1), bytes(0));
    a.commit(1);
    a.commit(1);
    const b = s.claimColumn(11, -10, 0); // (1, 0): entry 5
    b.commit(2);
    const c = s.claimColumn(10, -9, 0); // (0, 1): entry 7, claimed but never committed: absent
    s.claimColumn(10 + 64, -10, 0); // the centre's record holds another column: absent
    const v = n.versions();
    expect(v).toBeInstanceOf(Int32Array);
    expect(v.length).toBe(18);
    const expected = new Array(18).fill(-1);
    expected[0] = 2;
    expected[1] = 0;
    expected[10] = 1;
    expected[11] = 0;
    expect(Array.from(v)).toEqual(expected);
    expect(n.proto(-1, -1)!.block(0, -64, 0)).toBe(1);
    expect(n.final(-1, -1)).toBeNull();
    expect(n.final(1, 0)).not.toBeNull();
    expect(n.proto(0, 1)).toBeNull();
    expect(n.proto(0, 0)).toBeNull();
    c.commit(1);
    expect(n.versions()[14]).toBe(1);
    expect(() => n.proto(2, 0)).toThrow(RangeError);
    expect(() => n.final(0, -2)).toThrow(RangeError);
  });

  test('attachStore in the same thread: one store, two handles; growth is seen without rebuilding', () => {
    const s = newStore();
    const t = attachStore(s.handles());
    expect(t.shared).toBe(shared);
    const w = s.claimColumn(0, 0, 0);
    for (let sy = 0; sy < SECTIONS; sy++) w.setProto(sy, mixedBlocks(), mixedFluid());
    w.commit(1);
    expect(t.proto(0, 0)!.block(0, 0, 0)).toBe(2);
    expect(s.blockPool.slotCount()).toBe(128);
    // t allocates past what s had grown to (6 × 24 dense sections > 128 slots); s reads the new slots through its
    // length-tracking views.
    for (let cx = 1; cx <= 5; cx++) {
      const w2 = t.claimColumn(cx, 0, 0);
      for (let sy = 0; sy < SECTIONS; sy++) {
        const b = mixedBlocks();
        b[1] = 100 * cx + sy;
        w2.setProto(sy, b, mixedFluid());
      }
      w2.commit(1);
    }
    expect(s.blockPool.slotCount()).toBe(256);
    for (let cx = 1; cx <= 5; cx++) {
      for (let sy = 0; sy < SECTIONS; sy++) expect(s.proto(cx, 0)!.block(1, sy * 16 - 64, 0)).toBe(100 * cx + sy);
    }
    expect(() => t.claimColumn(0, 0, 0)).toThrow(SlotBusy);
    s.freeColumn(1, 0);
    expect(t.proto(1, 0)).toBeNull();
  });
});

describe('attachStore across two threads (shared)', () => {
  const workers: Worker[] = [];
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.terminate()));
  });

  test('a worker attaches, reads the main thread\'s column and writes one the main thread reads', async () => {
    const out = fileURLToPath(new URL('../.cache/storeAttach/', import.meta.url));
    mkdirSync(out, { recursive: true });
    await build({
      configFile: false, logLevel: 'silent',
      build: {
        outDir: out, emptyOutDir: true, minify: false,
        lib: { entry: fileURLToPath(new URL('../../src/world/store/store.ts', import.meta.url)), formats: ['es'], fileName: () => 'store.mjs' },
      },
    });
    const s = createStore({ shared: true, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
    const w = s.claimColumn(2, 2, 5);
    for (let sy = 0; sy < SECTIONS; sy++) {
      const b = mixedBlocks();
      b[1] = sy;
      w.setProto(sy, b, mixedFluid());
    }
    w.aux().worldSurfaceWG[3] = 77;
    w.commit(1);
    const worker = new Worker(new URL('./fixtures/storeWorker.mjs', import.meta.url), {
      workerData: { storeUrl: pathToFileURL(`${out}store.mjs`).href, handles: s.handles() },
    });
    workers.push(worker);
    const reply = await new Promise<{ ok: boolean; error?: string; read?: number[]; slotCount?: number }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(reply.error).toBeUndefined();
    expect(reply.ok).toBe(true);
    // The worker read what this thread wrote: section index at voxel 1, bedrock at voxel 0, water, aux.
    expect(reply.read).toEqual([...Array.from({ length: SECTIONS }, (_, sy) => sy), 2, WATER, 77]);
    // The worker wrote 5 × 24 more dense block sections (it grew the pool past this thread's 128 slots) and
    // bumped an epoch cell.
    expect(reply.slotCount).toBe(256);
    expect(s.blockPool.slotCount()).toBe(256);
    for (const cx of [3, 4, 5, 6, 7]) {
      const v = s.proto(cx, 2)!;
      expect(v).not.toBeNull();
      for (let sy = 0; sy < SECTIONS; sy++) expect(v.block(1, sy * 16 - 64, 0)).toBe(1000 + cx * 100 + sy);
      expect(v.aux()!.oceanFloorWG[255]).toBe(cx);
    }
    expect(s.epochs.get(EPOCH_CELL.terrain)).toBe(1);
    expect(s.table.blockVersion(s.table.find(3, 2))).toBe(1);
    for (let cx = 2; cx <= 7; cx++) s.freeColumn(cx, 2);
    expect(s.blockPool.freeCount()).toBe(s.blockPool.slotCount());
    expect(s.bytePool.freeCount()).toBe(s.bytePool.slotCount());
  }, 60_000);
});

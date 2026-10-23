/**
 * The SP4a store changes (SP4a spec §2.5, D4): `reopenColumn`, `ColumnWriter.setLight` and its light-once refusal,
 * per-channel version bumps at commit, and `attachStore`/`attachPool` asserting the buffer kind (§2.6's item 7).
 */
import { describe, expect, test } from 'vitest';
import { finalAt, REC_AUX_A, REC_AUX_B, RECORD_INTS, SECTIONS } from '../../src/world/store/columnTable';
import { attachPool, type SlabPool } from '../../src/world/store/pool';
import { FINAL_LIGHT } from '../../src/world/store/section';
import { attachStore, createStore, type StoreHandles, type VoxelStore } from '../../src/world/store/store';

const MiB = 1 << 20;
const words = (v: number) => new Uint16Array(4096).fill(v);
const bytes = (v: number) => new Uint8Array(4096).fill(v);
const WATER = 0x10;

/** Stone below ly 8, air above: dense blocks. */
function mixedBlocks(): Uint16Array {
  const b = words(0);
  b.fill(1, 0, 8 << 8);
  return b;
}

/** Water sources in the bottom half: dense fluid. */
function mixedFluid(): Uint8Array {
  const f = bytes(0);
  f.fill(WATER, 0, 8 << 8);
  return f;
}

/** A light channel with a different byte per voxel (dense), seeded by `k`. */
function denseLight(k: number): Uint8Array {
  const l = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) l[i] = (i + k) & 15;
  return l;
}

/** Slots in use (allocated and not on the free stack). */
const used = (p: SlabPool) => p.slotCount() - p.freeCount();

function refcounts(p: SlabPool): number[] {
  const out: number[] = [];
  for (let id = 0; id < p.slotCount(); id++) out.push(p.refcount(id));
  return out;
}

/** T of (cx, cz): 24 proto sections, aux A and aux B written, commit 1. */
function runT(s: VoxelStore, cx: number, cz: number, withAuxB = true): void {
  const w = s.claimColumn(cx, cz, 0);
  for (let sy = 0; sy < SECTIONS; sy++) w.setProto(sy, sy % 2 === 0 ? mixedBlocks() : words(1), sy % 3 === 0 ? mixedFluid() : bytes(0));
  w.aux().worldSurfaceWG.fill(70);
  if (withAuxB) w.auxB().caveBiomeQ.fill(9);
  w.commit(1);
}

/** The D skeleton of (cx, cz): reopen at 1, share the proto into the final set with an all-zero light, commit 2. */
function runD(s: VoxelStore, cx: number, cz: number): void {
  const w = s.reopenColumn(cx, cz, 1);
  for (let sy = 0; sy < SECTIONS; sy++) w.shareFinal(sy, bytes(0));
  w.aux().worldSurface.fill(71);
  w.commit(2);
}

/** The light job of (cx, cz): reopen at 2, 24 × setLight (dense in even sections, uniform 15 in odd), commit 3. */
function runL(s: VoxelStore, cx: number, cz: number): void {
  const w = s.reopenColumn(cx, cz, 2);
  for (let sy = 0; sy < SECTIONS; sy++) w.setLight(sy, sy % 2 === 0 ? denseLight(sy) : bytes(15));
  w.commit(3);
}

describe.each([true, false])('shared %s', (shared) => {
  const newStore = () => createStore({ shared, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
  const versionsOf = (s: VoxelStore, cx: number, cz: number) => {
    const base = s.table.find(cx, cz);
    return [s.table.blockVersion(base), s.table.lightVersion(base), s.table.status(base)];
  };

  test("T's commit: blockVersion 1, lightVersion 0", () => {
    const s = newStore();
    runT(s, 3, -4);
    expect(versionsOf(s, 3, -4)).toEqual([1, 0, 1]);
  });

  test("reopenColumn(1) on a Proto column; D's shareFinal with an all-zero light then commit(2): blockVersion 2, lightVersion 0, status 2", () => {
    const s = newStore();
    runT(s, 3, -4);
    runD(s, 3, -4);
    expect(versionsOf(s, 3, -4)).toEqual([2, 0, 2]);
    const f = s.final(3, -4)!;
    expect(f.block(0, -64, 0)).toBe(1);
    expect(f.fluid(0, -64, 0)).toBe(WATER);
    expect(f.light(0, -64, 0)).toBe(0);
    expect(f.aux()!.worldSurfaceWG[0]).toBe(70);
    expect(f.aux()!.worldSurface[0]).toBe(71);
  });

  test('reopenColumn(2); 24 × setLight then commit(3): lightVersion 1, status 3, `final().light` reads the written bytes', () => {
    const s = newStore();
    runT(s, 3, -4);
    runD(s, 3, -4);
    runL(s, 3, -4);
    expect(versionsOf(s, 3, -4)).toEqual([2, 1, 3]);
    const f = s.final(3, -4)!;
    for (let sy = 0; sy < SECTIONS; sy++) {
      const want = sy % 2 === 0 ? denseLight(sy) : bytes(15);
      for (const i of [0, 1, 17, 255, 4095]) {
        const lx = i & 15;
        const lz = (i >> 4) & 15;
        const y = sy * 16 - 64 + (i >> 8);
        expect(f.light(lx, y, lz)).toBe(want[i]);
      }
    }
    // The blocks and fluid D shared are untouched by L.
    expect(f.block(0, -64, 0)).toBe(1);
    expect(f.fluid(0, -64, 0)).toBe(WATER);
  });

  test('reopenColumn throws on an absent column, on another column\'s record, and on a status other than `from`', () => {
    const s = newStore();
    expect(() => s.reopenColumn(5, 5, 1)).toThrow('reopenColumn: (5, 5) is not at status 1');
    runT(s, 0, 0);
    // (64, 0) shares (0, 0)'s torus record.
    expect(() => s.reopenColumn(64, 0, 1)).toThrow('reopenColumn: (64, 0) is not at status 1');
    expect(() => s.reopenColumn(0, 0, 2)).toThrow('reopenColumn: (0, 0) is not at status 2');
    runD(s, 0, 0);
    expect(() => s.reopenColumn(0, 0, 1)).toThrow('reopenColumn: (0, 0) is not at status 1');
    runL(s, 0, 0);
    expect(() => s.reopenColumn(0, 0, 2)).toThrow('reopenColumn: (0, 0) is not at status 2');
    // Claimed but never committed (status Absent).
    s.claimColumn(1, 0, 0);
    expect(() => s.reopenColumn(1, 0, 1)).toThrow('reopenColumn: (1, 0) is not at status 1');
    expect(() => s.reopenColumn(0, 0, 3 as 1)).toThrow(RangeError);
  });

  test('reopenColumn clears nothing: proto and final entries and aux bytes unchanged', () => {
    const s = newStore();
    runT(s, 2, 7);
    const base = s.table.find(2, 7);
    const record = () => Array.from(s.table.ints.subarray(base, base + RECORD_INTS));
    const auxBytes = () => {
      const a = s.final(2, 7) ?? s.proto(2, 7)!;
      return [Array.from(a.aux()!.worldSurfaceWG), Array.from(a.auxB()!.caveBiomeQ)];
    };
    const pools = () => [refcounts(s.blockPool), refcounts(s.bytePool), used(s.blockPool), used(s.bytePool)];
    for (const from of [1, 2] as const) {
      if (from === 2) runD(s, 2, 7);
      const r0 = record();
      const a0 = auxBytes();
      const p0 = pools();
      const proto0 = s.proto(2, 7)!.sectionBlocks(0);
      const w = s.reopenColumn(2, 7, from);
      expect([w.cx, w.cz]).toEqual([2, 7]);
      expect(record()).toEqual(r0);
      expect(auxBytes()).toEqual(a0);
      expect(pools()).toEqual(p0);
      expect(s.proto(2, 7)!.sectionBlocks(0)).toEqual(proto0);
    }
  });

  test("the reopened writer's aux() returns the record's existing slot (same bytes, no allocation: blockPool and bytePool used counts unchanged)", () => {
    const s = newStore();
    runT(s, -1, 9);
    const base = s.table.find(-1, 9);
    const slotA = s.table.ints[base + REC_AUX_A]!;
    const slotB = s.table.ints[base + REC_AUX_B]!;
    const usedBefore = [used(s.blockPool), used(s.bytePool)];
    const w = s.reopenColumn(-1, 9, 1);
    const a = w.aux();
    const b = w.auxB();
    expect([used(s.blockPool), used(s.bytePool)]).toEqual(usedBefore);
    expect([s.table.ints[base + REC_AUX_A], s.table.ints[base + REC_AUX_B]]).toEqual([slotA, slotB]);
    expect(Array.from(a.worldSurfaceWG)).toEqual(new Array(256).fill(70));
    expect(Array.from(b.caveBiomeQ)).toEqual(new Array(1536).fill(9));
    expect(a.worldSurfaceWG.byteOffset).toBe(s.bytePool.u8(slotA).byteOffset);
    expect(b.caveBiomeQ.byteOffset).toBe(s.bytePool.u8(slotB).byteOffset);
    // A write through the reopened writer lands in the record's slot.
    a.oceanFloor[5] = -12;
    expect(s.proto(-1, 9)!.aux()!.oceanFloor[5]).toBe(-12);
  });

  test('a reopened writer allocates an aux slot only when the record has none (zero-filled)', () => {
    const s = newStore();
    runT(s, 4, 4, false);
    const base = s.table.find(4, 4);
    expect(s.table.ints[base + REC_AUX_B]).toBe(-1);
    const before = used(s.bytePool);
    const w = s.reopenColumn(4, 4, 1);
    const b = w.auxB();
    expect(used(s.bytePool)).toBe(before + 1);
    expect(s.table.ints[base + REC_AUX_B]).toBeGreaterThanOrEqual(0);
    expect(b.caveBiomeQ.every((v) => v === 0)).toBe(true);
    expect(w.auxB()).toBe(b);
    expect(used(s.bytePool)).toBe(before + 1);
  });

  test("setLight over a dense light entry throws 'light already written'; over a uniform entry it frees no slot", () => {
    const s = newStore();
    runT(s, 0, 0);
    // D writes section 5's light dense through setFinal, every other section's through shareFinal (uniform 0).
    const d = s.reopenColumn(0, 0, 1);
    for (let sy = 0; sy < SECTIONS; sy++) {
      if (sy === 5) d.setFinal(sy, mixedBlocks(), denseLight(1), bytes(0));
      else d.shareFinal(sy, bytes(0));
    }
    d.commit(2);
    const base = s.table.find(0, 0);
    const w = s.reopenColumn(0, 0, 2);
    expect(() => w.setLight(5, bytes(15))).toThrow('light already written');
    expect(s.final(0, 0)!.light(0, 16, 0)).toBe(denseLight(1)[0]);

    const refs0 = refcounts(s.bytePool);
    const free0 = s.bytePool.freeCount();
    const count0 = s.bytePool.slotCount();
    w.setLight(0, bytes(15));
    w.setLight(1, bytes(15));
    w.setLight(1, bytes(12)); // still uniform: rewriting a uniform entry is allowed
    expect(refcounts(s.bytePool)).toEqual(refs0);
    expect([s.bytePool.freeCount(), s.bytePool.slotCount()]).toEqual([free0, count0]);
    w.setLight(2, denseLight(3));
    const slot = s.table.ints[finalAt(base, 2) + FINAL_LIGHT]!;
    expect(slot).toBeGreaterThanOrEqual(0);
    // One new slot, and no existing slot lost a reference.
    expect(refcounts(s.bytePool).slice(0, refs0.length).filter((r, id) => r !== refs0[id] && id !== slot)).toEqual([]);
    expect(s.bytePool.slotCount() - s.bytePool.freeCount()).toBe(count0 - free0 + 1);
    expect(() => w.setLight(2, denseLight(4))).toThrow('light already written');
    expect(() => w.setLight(2, bytes(0))).toThrow('light already written');
    expect(s.table.ints[finalAt(base, 2) + FINAL_LIGHT]).toBe(slot);
    expect(() => w.setLight(24, bytes(0))).toThrow(RangeError);
    expect(() => w.setLight(0, new Uint8Array(10))).toThrow(RangeError);
  });

  test('versions() reflects both channels', () => {
    const s = newStore();
    const n = s.neighborhood(10, 10);
    const at = (dx: number, dz: number) => {
      const v = n.versions();
      const k = 2 * (3 * (dz + 1) + (dx + 1));
      return [v[k], v[k + 1]];
    };
    runT(s, 10, 10);
    runT(s, 11, 10);
    expect([at(0, 0), at(1, 0)]).toEqual([[1, 0], [1, 0]]);
    runD(s, 10, 10);
    expect([at(0, 0), at(1, 0)]).toEqual([[2, 0], [1, 0]]);
    runL(s, 10, 10);
    expect([at(0, 0), at(1, 0)]).toEqual([[2, 1], [1, 0]]);
    // A commit at the status the writer opened at is refused (SP4b spec §2.4) and changes no version.
    const idle = s.reopenColumn(11, 10, 1);
    expect(() => idle.commit(1)).toThrow(RangeError);
    expect(at(1, 0)).toEqual([1, 0]);
    // setFinal writes both channels; shareFinal with a non-zero light byte writes light too.
    const d = s.reopenColumn(11, 10, 1);
    d.setFinal(0, mixedBlocks(), bytes(0), bytes(0));
    d.commit(2);
    expect(at(1, 0)).toEqual([2, 1]);
    runT(s, 9, 10);
    const e = s.reopenColumn(9, 10, 1);
    const light = bytes(0);
    light[4095] = 1;
    e.shareFinal(3, light);
    e.commit(2);
    expect(at(-1, 0)).toEqual([2, 1]);
    // The flags reset at every commit: a second commit with no write bumps nothing.
    e.commit(2);
    expect(at(-1, 0)).toEqual([2, 1]);
    expect(at(0, -1)).toEqual([-1, -1]);
  });

  test('a commit at the status the writer was opened at throws RangeError and bumps nothing', () => {
    const s = newStore();
    runT(s, 10, 10);
    const d = s.reopenColumn(10, 10, 1);
    d.setFinal(0, mixedBlocks(), denseLight(1), bytes(0));
    expect(() => d.commit(1)).toThrow(RangeError);
    expect(versionsOf(s, 10, 10)).toEqual([1, 0, 1]);
    // A commit with no write since the writer opened bumps no version (SP4a spec §2.5).
    const idle = s.reopenColumn(10, 10, 1);
    idle.commit(2);
    expect(versionsOf(s, 10, 10)).toEqual([1, 0, 2]);
    const l = s.reopenColumn(10, 10, 2);
    l.setLight(1, denseLight(2));
    expect(() => l.commit(2)).toThrow(RangeError);
    expect(versionsOf(s, 10, 10)).toEqual([1, 0, 2]);
    l.commit(3);
    expect(versionsOf(s, 10, 10)).toEqual([1, 1, 3]);
  });
});

describe('attach asserts the buffer kind (SP4a spec §2.5, §2.6 item 7)', () => {
  const sab = () => new SharedArrayBuffer(8);
  const ab = () => new ArrayBuffer(8);

  test('attachStore over createStore().handles() succeeds, shared and not', () => {
    for (const shared of [true, false]) {
      const s = createStore({ shared, maxBlockBytes: MiB, maxByteBytes: MiB });
      expect(attachStore(s.handles()).shared).toBe(shared);
    }
  });

  test('attachStore with shared true and an ArrayBuffer table throws TypeError; with shared false and a SharedArrayBuffer throws', () => {
    const sh = createStore({ shared: true, maxBlockBytes: MiB, maxByteBytes: MiB }).handles();
    const un = createStore({ shared: false, maxBlockBytes: MiB, maxByteBytes: MiB }).handles();
    const swap = (h: StoreHandles, o: Partial<StoreHandles>): StoreHandles => ({ ...h, ...o });
    expect(() => attachStore(swap(sh, { table: new ArrayBuffer(sh.table.byteLength) }))).toThrow(TypeError);
    expect(() => attachStore(swap(un, { table: new SharedArrayBuffer(un.table.byteLength) }))).toThrow(TypeError);
    expect(() => attachStore(swap(sh, { epochs: new ArrayBuffer(16) }))).toThrow(TypeError);
    expect(() => attachStore(swap(un, { epochs: new SharedArrayBuffer(16) }))).toThrow(TypeError);
    // A pool's buffers, and a pool whose `shared` differs from the store's.
    expect(() => attachStore(swap(sh, { blocks: { ...sh.blocks, ctl: ab() } }))).toThrow(TypeError);
    expect(() => attachStore(swap(un, { bytes: { ...un.bytes, refs: sab() } }))).toThrow(TypeError);
    expect(() => attachStore(swap(sh, { bytes: un.bytes }))).toThrow(TypeError);
    expect(() => attachStore(swap(un, { blocks: sh.blocks }))).toThrow(TypeError);
    // `pass` is exempt from the kind rule (a copy on an ArrayBuffer even in a shared store).
    expect(sh.pass.buffer instanceof SharedArrayBuffer).toBe(false);
  });

  test('attachPool throws TypeError on a buffer of the other kind', () => {
    const sh = createStore({ shared: true, maxBlockBytes: MiB, maxByteBytes: MiB }).handles().blocks;
    const un = createStore({ shared: false, maxBlockBytes: MiB, maxByteBytes: MiB }).handles().bytes;
    expect(attachPool(sh).shared).toBe(true);
    expect(attachPool(un).shared).toBe(false);
    for (const key of ['data', 'ctl', 'stack', 'refs'] as const) {
      expect(() => attachPool({ ...sh, [key]: ab() }), key).toThrow(TypeError);
      expect(() => attachPool({ ...un, [key]: sab() }), key).toThrow(TypeError);
    }
  });
});

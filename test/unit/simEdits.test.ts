/**
 * The sim's edit pipeline (SP5a spec §2.1, §2.2, §2.4, §2.6): `applyEdits` validates a batch whole, then writes each
 * edit copy-on-write through the edit writer, patches the heightmaps, relights the 3 × 3, records the DiffStore and
 * publishes; a `StoreFull` rolls the batch back. The main cases run on a seed-42 region generated to 'L' by the region
 * harness (5 × 5 columns at the spawn, 1 thread, every proto kept, as `retainAllProtos`); the dirty-set and
 * `StoreFull` cases on a canned 5 × 5 store (stone up to y 69, air above), written with the store's writers, lit by
 * `lightRegion` and Published, protos kept.
 */
import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { writeFinalHeightmaps } from '../../src/gen/pipeline/finalHeightmaps';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion } from '../../src/light/initial';
import { createDiffStore, NO_ENTRY, type DiffStore } from '../../src/sim/diffStore';
import { applyEdits, createEditScratch, readDiff, type Edit, type EditResult } from '../../src/sim/edits';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, DIRT, GLASS, ICE, STONE, TORCH } from '../../src/world/blocks/index';
import { protoAt, REC_DIFF_FLAG, SECTIONS } from '../../src/world/store/columnTable';
import { copyLightRegion, lightIndex } from '../../src/world/store/padded';
import { PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { genRegion } from '../harness/region';
import { testFloat, testRng } from '../harness/stats';

const MiB = 1 << 20;
const now = (): number => performance.now();
/** A voxel value as the sim holds it: `state << 8 | fluid`. */
const val = (state: number, fluid = 0): number => (state << 8) | fluid;
const valueAt = (s: VoxelStore, x: number, y: number, z: number): number => val(s.blockAt(x, y, z), s.fluidAt(x, y, z));
const set = (x: number, y: number, z: number, value: number, expectV: number): Edit => ({ x, y, z, op: 'set', value, expect: expectV });
/** Voxel `idx` in its section and the section, of world (x, y, z). */
const sectionOf = (y: number): number => (y + 64) >> 4;
const idxOf = (x: number, y: number, z: number): number => (((y + 64) & 15) << 8) | ((z & 15) << 4) | (x & 15);
const entry = (d: DiffStore, x: number, y: number, z: number): number => d.get(x >> 4, z >> 4, sectionOf(y), idxOf(x, y, z));

/** The block and light versions and the status of each column of the square (cx0, cz0, n). */
function versions(s: VoxelStore, cx0: number, cz0: number, n: number): number[] {
  const out: number[] = [];
  for (let cz = cz0; cz < cz0 + n; cz++) {
    for (let cx = cx0; cx < cx0 + n; cx++) {
      const base = s.table.find(cx, cz);
      out.push(s.table.blockVersion(base), s.table.lightVersion(base), s.table.status(base));
    }
  }
  return out;
}

const blockVersion = (s: VoxelStore, cx: number, cz: number): number => s.table.blockVersion(s.table.find(cx, cz));
const lightVersions = (s: VoxelStore, cx0: number, cz0: number, n: number): number[] => versions(s, cx0, cz0, n).filter((_, i) => i % 3 === 1);

/** The dirty columns of a result, as sorted "cx,cz" strings. */
const cols = (keys: Float64Array): string[] => [...keys].map((k) => `${colKeyCx(k)},${colKeyCz(k)}`).sort();
const names = (...cs: Array<[number, number]>): string[] => cs.map(([cx, cz]) => `${cx},${cz}`).sort();

const lightScratch = createLightScratch();

/** Every column of the 3 × 3 around (cx, cz): its stored light against a fresh `lightRegion` (`mayEmit` true). */
function expectLightFresh(s: VoxelStore, cx: number, cz: number): void {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      copyLightRegion(s.neighborhood(cx + dx, cz + dz), lightScratch.region);
      lightRegion(lightScratch, DEFAULT_LIGHT_TABLES, true);
      const f = s.final(cx + dx, cz + dz)!;
      for (let sy = 0; sy < SECTIONS; sy++) {
        const stored = f.sectionLight(sy);
        const want = typeof stored === 'number' ? new Uint8Array(4096).fill(stored) : stored;
        expect(Buffer.from(centreSection(lightScratch, sy)).equals(Buffer.from(want)), `(${cx + dx}, ${cz + dz}) sy ${sy}`).toBe(true);
      }
    }
  }
}

describe('applyEdits on a seed-42 region (SP5a spec §2.1, §2.2, §2.4)', () => {
  let store: VoxelStore;
  let cx0 = 0;
  let cz0 = 0;
  /** The centre column of the 5 × 5 (its 3 × 3 is Published). */
  let C: [number, number] = [0, 0];
  const diffs = createDiffStore();
  const scratch = createEditScratch();
  const run = (edits: readonly Edit[]): EditResult => applyEdits(store, diffs, scratch, edits, now);
  /** The first air voxel above the surface at block column (x, z). */
  const surface = (x: number, z: number): number => store.heightAt('worldSurface', x, z)!;

  beforeAll(async () => {
    const params = resolveProfile('default');
    const sp = findSpawn(createGenContext(seedFromInput('42'), params));
    C = [sp.x >> 4, sp.z >> 4];
    cx0 = C[0] - 2;
    cz0 = C[1] - 2;
    store = (await genRegion({ seed: '42', params, cx0, cz0, w: 5, h: 5, upTo: 'L', order: 'spiral', threads: 1 })).view.store;
  }, 120_000);

  test('a place: the voxel reads the value, prev NO_ENTRY, the entry set, REC_DIFF_FLAG set, blockVersion + 1, the 3 × 3\'s light equals a fresh lightRegion', () => {
    const x = 16 * C[0] + 6;
    const z = 16 * C[1] + 9;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const bv = blockVersion(store, C[0], C[1]);
    expect(store.diffFlag(C[0], C[1])).toBe(false);
    const r = run([set(x, y, z, val(STONE), before)]);
    expect(r.refused).toBeNull();
    expect(valueAt(store, x, y, z)).toBe(val(STONE));
    expect([...r.prev]).toEqual([NO_ENTRY]);
    expect([...r.next]).toEqual([val(STONE)]);
    expect(entry(diffs, x, y, z)).toBe(val(STONE));
    expect(store.diffFlag(C[0], C[1])).toBe(true);
    expect(Atomics.load(store.table.ints, store.table.find(C[0], C[1]) + REC_DIFF_FLAG)).toBe(1);
    expect(blockVersion(store, C[0], C[1])).toBe(bv + 1);
    expect(store.table.status(store.table.find(C[0], C[1]))).toBe(3);
    expect(cols(r.dirty)).toContain(`${C[0]},${C[1]}`);
    expect(cols(r.entryAdded)).toEqual(names(C));
    expect(cols(r.entryRemoved)).toEqual([]);
    expect(r.relightMs).toBeGreaterThanOrEqual(0);
    expect(r.editMs).toBeGreaterThanOrEqual(r.relightMs);
    expectLightFresh(store, C[0], C[1]);
    // readDiff answers the column's entries in fresh arrays (ruling R9), null for a column without any.
    const d = readDiff(diffs, C[0], C[1])!;
    expect([...d.sy, ...d.idx, ...d.value]).toEqual([sectionOf(y), idxOf(x, y, z), val(STONE)]);
    expect(readDiff(diffs, C[0] + 1, C[1])).toBeNull();
    // Undo it, so the later cases start from the generated terrain.
    run([{ x, y, z, op: 'revert', value: 0, expect: val(STONE) }]);
  });

  test('a `set` to the proto\'s value removes the entry; `revert` writes the proto\'s value and removes it', () => {
    const x = 16 * C[0] + 3;
    const z = 16 * C[1] + 12;
    const y = surface(x, z);
    const generated = valueAt(store, x, y, z);
    const p = store.proto(C[0], C[1])!;
    expect(val(p.block(x & 15, y, z & 15), p.fluid(x & 15, y, z & 15))).toBe(generated);

    run([set(x, y, z, val(GLASS), generated)]);
    expect(entry(diffs, x, y, z)).toBe(val(GLASS));
    // A set equal to the proto's value removes the entry: `next` NO_ENTRY (ruling R27).
    const back = run([set(x, y, z, generated, val(GLASS))]);
    expect(back.refused).toBeNull();
    expect([...back.prev]).toEqual([val(GLASS)]);
    expect([...back.next]).toEqual([NO_ENTRY]);
    expect(entry(diffs, x, y, z)).toBe(NO_ENTRY);
    expect(valueAt(store, x, y, z)).toBe(generated);
    expect(cols(back.entryAdded)).toEqual([]);
    expect(cols(back.entryRemoved)).toEqual(names(C));

    run([set(x, y, z, val(TORCH), generated)]);
    expect(entry(diffs, x, y, z)).toBe(val(TORCH));
    const rev = run([{ x, y, z, op: 'revert', value: val(STONE), expect: val(TORCH) }]);
    expect(rev.refused).toBeNull();
    expect([...rev.prev]).toEqual([val(TORCH)]);
    expect([...rev.next]).toEqual([NO_ENTRY]);
    expect(valueAt(store, x, y, z)).toBe(generated);
    expect(entry(diffs, x, y, z)).toBe(NO_ENTRY);
    expect(diffs.size).toBe(0);
    expectLightFresh(store, C[0], C[1]);
  });

  test('a batch of 3 whose 2nd `expect` is stale: `refused` `\'changed\'` and nothing written (every version and value unchanged)', () => {
    const at = [[2, 2], [7, 4], [13, 11]].map(([lx, lz]) => {
      const x = 16 * C[0] + lx!;
      const z = 16 * C[1] + lz!;
      return { x, y: surface(x, z), z };
    });
    const values = at.map((v) => valueAt(store, v.x, v.y, v.z));
    const vs = versions(store, cx0, cz0, 5);
    const edits = at.map((v, k) => set(v.x, v.y, v.z, val(STONE), k === 1 ? values[k]! ^ 0x100 : values[k]!));
    const r = run(edits);
    expect(r.refused).toBe('changed');
    expect(r.dirty.length).toBe(0);
    expect(at.map((v) => valueAt(store, v.x, v.y, v.z))).toEqual(values);
    expect(versions(store, cx0, cz0, 5)).toEqual(vs);
    expect(diffs.size).toBe(0);
  });

  test('a voxel of a column whose 3 × 3 has a Decorated neighbour: `\'unloaded\'`', () => {
    // (cx0, ·) is Published, its west neighbour (cx0 − 1, ·) only Decorated (the 'L' region's D ring).
    expect(store.table.status(store.table.find(cx0 - 1, C[1]))).toBe(2);
    const x = 16 * cx0 + 5;
    const z = 16 * C[1] + 5;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    // A valid edit of the centre column first: the refusal of the 2nd refuses the batch before any write.
    const ox = 16 * C[0] + 1;
    const oz = 16 * C[1] + 1;
    const oy = surface(ox, oz);
    const other = valueAt(store, ox, oy, oz);
    const vs = versions(store, cx0, cz0, 5);
    const r = run([set(ox, oy, oz, val(STONE), other), set(x, y, z, val(STONE), before)]);
    expect(r.refused).toBe('unloaded');
    expect(valueAt(store, x, y, z)).toBe(before);
    expect(valueAt(store, ox, oy, oz)).toBe(other);
    expect(versions(store, cx0, cz0, 5)).toEqual(vs);
    expect(diffs.size).toBe(0);
  });

  test('the proto\'s slots are unchanged after 100 random edits (their words compared before and after)', () => {
    const snapshot = () => {
      const out: Array<number | number[]> = [];
      for (let cz = cz0; cz < cz0 + 5; cz++) {
        for (let cx = cx0; cx < cx0 + 5; cx++) {
          const base = store.table.find(cx, cz);
          const p = store.proto(cx, cz)!;
          for (let sy = 0; sy < SECTIONS; sy++) {
            out.push(store.table.ints[protoAt(base, sy) + PROTO_BLOCKS]!, store.table.ints[protoAt(base, sy) + PROTO_FLUID]!);
            const b = p.sectionBlocks(sy);
            const f = p.sectionFluid(sy);
            out.push(typeof b === 'number' ? b : [...b], typeof f === 'number' ? f : [...f]);
          }
        }
      }
      return out;
    };
    const before = snapshot();
    const next = testRng(9);
    const rng = () => testFloat(next);
    const palette = [val(STONE), val(AIR), val(GLASS), val(TORCH), val(ICE), val(DIRT), val(AIR, WATER_SOURCE)];
    let applied = 0;
    for (let k = 0; k < 100; k++) {
      // Inside the inner 3 × 3, whose 3 × 3s are Published, around the surface.
      const x = 16 * (C[0] - 1) + Math.floor(rng() * 48);
      const z = 16 * (C[1] - 1) + Math.floor(rng() * 48);
      const y = surface(x, z) - 3 + Math.floor(rng() * 6);
      const r = run([set(x, y, z, palette[Math.floor(rng() * palette.length)]!, valueAt(store, x, y, z))]);
      expect(r.refused, `edit ${k}`).toBeNull();
      applied++;
    }
    expect(applied).toBe(100);
    expect(diffs.size).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
  });

  test('a column whose proto was freed: `\'noProto\'`', () => {
    store.freeProto(C[0], C[1]);
    const x = 16 * C[0] + 8;
    const z = 16 * C[1] + 8;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const vs = versions(store, cx0, cz0, 5);
    const size = diffs.size;
    const r = run([set(x, y, z, val(STONE), before)]);
    expect(r.refused).toBe('noProto');
    expect(valueAt(store, x, y, z)).toBe(before);
    expect(versions(store, cx0, cz0, 5)).toEqual(vs);
    expect(diffs.size).toBe(size);
  });
});

/** Stone at and below y 69, air above. */
const TOP = 69;

/**
 * The canned 5 × 5 store (columns −2 … 2): every column claimed, its proto written and shared into the final set
 * (`shareFinal`) with the light of one `lightRegion` over the same flat world (horizontally uniform, so every column's
 * light is the centre's), the final heightmaps written, then committed Published.
 */
function cannedStore(maxBlockBytes = 16 * MiB): VoxelStore {
  const s = createStore({ shared: false, maxBlockBytes, maxByteBytes: 16 * MiB });
  const r = lightScratch.region;
  r.blocks.fill(AIR);
  r.blocks.fill(STONE, lightIndex(-15, -64, -15), lightIndex(-15, TOP + 1, -15));
  r.fluid.fill(0);
  r.lightBlocking.fill(TOP + 1);
  lightRegion(lightScratch, DEFAULT_LIGHT_TABLES, true);
  const light = Array.from({ length: SECTIONS }, (_, sy) => centreSection(lightScratch, sy).slice());
  const blocks = Array.from({ length: SECTIONS }, (_, sy) => {
    const b = new Uint16Array(4096);
    for (let ly = 0; ly < 16; ly++) b.fill(sy * 16 - 64 + ly <= TOP ? STONE : AIR, ly << 8, (ly + 1) << 8);
    return b;
  });
  const fluid = new Uint8Array(4096);
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const w = s.claimColumn(cx, cz, 0);
      for (let sy = 0; sy < SECTIONS; sy++) {
        w.setProto(sy, blocks[sy]!, fluid);
        w.shareFinal(sy, light[sy]!);
      }
      writeFinalHeightmaps((_lx, y) => (y <= TOP ? STONE : AIR), () => 0, w.aux());
      w.commit(3);
    }
  }
  return s;
}

describe('applyEdits on a canned store: the dirty set and StoreFull (SP5a spec §2.2, §2.6)', () => {
  const scratch = createEditScratch();

  test('a torch at world (15, 70, 15) of column (0, 0): `dirty` is exactly {(0, 0), (1, 0), (0, 1), (1, 1)}', () => {
    const s = cannedStore();
    const r = applyEdits(s, createDiffStore(), scratch, [set(15, 70, 15, val(TORCH), val(AIR))], now);
    expect(r.refused).toBeNull();
    expect(s.lightAt(15, 70, 15) & 15).toBe(14);
    expect(cols(r.dirty)).toEqual(names([0, 0], [1, 0], [0, 1], [1, 1]));
  });

  test('glass at (16, 70, 5), which changes no light: (0, 0) is dirty through the block ring alone (local x 0 of column (1, 0))', () => {
    const s = cannedStore();
    const lv = lightVersions(s, -2, -2, 5);
    const r = applyEdits(s, createDiffStore(), scratch, [set(16, 70, 5, val(GLASS), val(AIR))], now);
    expect(r.refused).toBeNull();
    expect(lightVersions(s, -2, -2, 5)).toEqual(lv);
    expect(cols(r.dirty)).toEqual(names([0, 0], [1, 0]));
  });

  test('bucket water placed into air at (0, 70, 0): (−1, −1), (−1, 0), (0, −1) and (0, 0) are dirty', () => {
    const s = cannedStore();
    const r = applyEdits(s, createDiffStore(), scratch, [set(0, 70, 0, val(AIR, WATER_SOURCE), val(AIR))], now);
    expect(r.refused).toBeNull();
    expect(s.fluidAt(0, 70, 0)).toBe(WATER_SOURCE);
    expect(cols(r.dirty)).toEqual(names([-1, -1], [-1, 0], [0, -1], [0, 0]));
  });

  test('`StoreFull` on the 2nd edit (a store whose `maxBlockBytes` leaves room for one slot): `refused` `\'full\'`; the first edit\'s voxel, light, heightmaps (aux A equal to before) and entry restored; the versions of the touched columns + 1 and `dirty` those columns, every other version unchanged', () => {
    const s = cannedStore(MiB);
    // 25 dense block slots (section 8 of each column) of the pool's 128; hold all but one.
    while (s.blockPool.freeCount() > 1) s.blockPool.alloc();
    expect(s.blockPool.slotCount()).toBe(s.blockPool.maxSlots);
    const d = createDiffStore();
    const auxOf = (cx: number, cz: number) => {
      const a = s.final(cx, cz)!.aux()!;
      return Buffer.from(a.worldSurfaceWG.buffer, a.worldSurfaceWG.byteOffset, 4096);
    };
    const aux = auxOf(0, 0).toString('hex');
    const vs = versions(s, -2, -2, 5);
    const light = s.lightAt(5, 70, 5);
    expect(light).toBe(0xF0);
    const r = applyEdits(s, d, scratch, [set(5, 70, 5, val(STONE), val(AIR)), set(21, 70, 5, val(STONE), val(AIR))], now);
    expect(r.refused).toBe('full');
    // Edit 1 wrote (0, 0)'s blocks and light; edit 2's block write in (1, 0) began. A MESH that read their slots
    // mid-batch is dropped by the bumped versions (§2.1), and the columns are remeshed.
    expect(cols(r.dirty)).toEqual(names([0, 0], [1, 0]));
    expect(valueAt(s, 5, 70, 5)).toBe(val(AIR));
    expect(s.lightAt(5, 70, 5)).toBe(light);
    expect(s.heightAt('worldSurface', 5, 5)).toBe(TOP + 1);
    expect(auxOf(0, 0).toString('hex')).toBe(aux);
    expect(entry(d, 5, 70, 5)).toBe(NO_ENTRY);
    expect(d.size).toBe(0);
    expect(cols(r.entryAdded)).toEqual([]);
    expect(cols(r.entryRemoved)).toEqual([]);
    const want = vs.slice();
    const at = (cx: number, cz: number): number => 3 * (5 * (cz + 2) + (cx + 2));
    want[at(0, 0)]! += 1;
    want[at(0, 0) + 1]! += 1;
    want[at(1, 0)]! += 1;
    expect(versions(s, -2, -2, 5)).toEqual(want);
    // The light of the whole store still equals a fresh lightRegion over the edited 3 × 3.
    expectLightFresh(s, 0, 0);
  });

  test('another throw after the first write (an injected bug in the 2nd edit\'s `replaceLight`) runs the same recovery, then propagates: the voxels, light, heightmaps (aux A) and DiffStore as before the batch, the touched columns\' versions + 1, and a later batch writes (SIM-2)', () => {
    const s = cannedStore();
    const d = createDiffStore();
    const auxOf = (cx: number, cz: number) => {
      const a = s.final(cx, cz)!.aux()!;
      return Buffer.from(a.worldSurfaceWG.buffer, a.worldSurfaceWG.byteOffset, 4096).toString('hex');
    };
    const aux = [auxOf(0, 0), auxOf(1, 0)];
    const vs = versions(s, -2, -2, 5);
    const light = [s.lightAt(5, 70, 5), s.lightAt(21, 70, 5)];
    // The edit writer of (1, 0) is the one the batch reopens (one per record claim): its light write throws.
    const w = s.reopenPublished(1, 0);
    const replaceLight = w.replaceLight;
    w.replaceLight = () => {
      throw new TypeError('injected bug');
    };
    const batch = [set(5, 70, 5, val(STONE), val(AIR)), set(21, 70, 5, val(STONE), val(AIR))];
    try {
      expect(() => applyEdits(s, d, scratch, batch, now)).toThrow('injected bug');
    } finally {
      w.replaceLight = replaceLight;
    }
    expect([valueAt(s, 5, 70, 5), valueAt(s, 21, 70, 5)]).toEqual([val(AIR), val(AIR)]);
    expect([s.lightAt(5, 70, 5), s.lightAt(21, 70, 5)]).toEqual(light);
    expect([s.heightAt('worldSurface', 5, 5), s.heightAt('worldSurface', 21, 5)]).toEqual([TOP + 1, TOP + 1]);
    expect([auxOf(0, 0), auxOf(1, 0)]).toEqual(aux);
    expect(d.size).toBe(0);
    // Edit 1 wrote (0, 0)'s blocks and light, edit 2 (1, 0)'s blocks and began its light: a MESH that read them is dropped.
    const want = vs.slice();
    const at = (cx: number, cz: number): number => 3 * (5 * (cz + 2) + (cx + 2));
    for (const k of [at(0, 0), at(0, 0) + 1, at(1, 0), at(1, 0) + 1]) want[k]! += 1;
    expect(versions(s, -2, -2, 5)).toEqual(want);
    // The 3 × 3 around (0, 0) holds (1, 0) too.
    expectLightFresh(s, 0, 0);
    // The writers hold no kept code: the same batch now writes and publishes.
    const r = applyEdits(s, d, scratch, batch, now);
    expect(r.refused).toBeNull();
    expect([valueAt(s, 5, 70, 5), valueAt(s, 21, 70, 5)]).toEqual([val(STONE), val(STONE)]);
    expectLightFresh(s, 0, 0);
  });
});

describe('applyEdits on a canned store: the entry changes and the dirty-column set (SP5b spec §3.2, §3.3, D20)', () => {
  const scratch = createEditScratch();
  /** The canned store's generated value at y: stone at and below `TOP`, air above. */
  const generated = (y: number): number => val(y <= TOP ? STONE : AIR);
  const sortedKeys = (keys: Iterable<number>): number[] => [...keys].sort((a, b) => a - b);

  test('after 200 random edits (places, breaks, reverts, a refused batch), the union of `entryAdded` minus `entryRemoved` replayed into a set equals `diffs.columns()` after each batch', () => {
    const s = cannedStore();
    const d = createDiffStore();
    const replay = new Set<number>();
    const next = testRng(17);
    const rng = () => testFloat(next);
    const palette = [val(STONE), val(AIR), val(GLASS), val(TORCH), val(DIRT)];
    const tally = { places: 0, breaks: 0, reverts: 0, refused: 0, added: 0, removed: 0 };
    /** A random voxel holding an entry, as world (x, y, z), or null when the store holds none. */
    const someEntry = (): [number, number, number] | null => {
      const keys = [...d.columns()];
      if (keys.length === 0) return null;
      const key = keys[Math.floor(rng() * keys.length)]!;
      const cd = d.columnDiff(colKeyCx(key), colKeyCz(key))!;
      const k = Math.floor(rng() * cd.idx.length);
      const i = cd.idx[k]!;
      return [16 * colKeyCx(key) + (i & 15), 16 * cd.sy[k]! - 64 + (i >> 8), 16 * colKeyCz(key) + ((i >> 4) & 15)];
    };
    let posted = 0;
    for (let b = 0; posted < 200; b++) {
      const n = Math.min(1 + Math.floor(rng() * 3), 200 - posted);
      const batch: Edit[] = [];
      /** The value an earlier edit of the batch leaves at a voxel (the batch's `expect` chain). */
      const left = new Map<string, number>();
      for (let k = 0; k < n; k++) {
        const pick = rng() < 0.3 ? someEntry() : null;
        // Inside the inner 3 × 3 (columns −1 … 1), whose 3 × 3s are Published, around the stone's top.
        const [x, y, z] = pick ?? [-16 + Math.floor(rng() * 48), TOP - 2 + Math.floor(rng() * 5), -16 + Math.floor(rng() * 48)];
        const at = `${x},${y},${z}`;
        const cur = left.get(at) ?? valueAt(s, x, y, z);
        if (pick !== null) {
          batch.push({ x, y, z, op: 'revert', value: 0, expect: cur });
          left.set(at, generated(y));
          tally.reverts++;
        } else {
          const value = palette[Math.floor(rng() * palette.length)]!;
          batch.push(set(x, y, z, value, cur));
          left.set(at, value);
          if (value === val(AIR)) tally.breaks++;
          else tally.places++;
        }
      }
      // One batch, past the middle, with its last `expect` stale: refused `'changed'`, nothing written.
      const refuse = b === 60;
      if (refuse) {
        const e = batch[batch.length - 1]!;
        batch[batch.length - 1] = { ...e, expect: e.expect ^ 0x100 };
      }
      posted += n;
      const r = applyEdits(s, d, scratch, batch, now);
      expect(r.refused, `batch ${b}`).toBe(refuse ? 'changed' : null);
      if (refuse) {
        tally.refused++;
        expect([r.entryAdded.length, r.entryRemoved.length]).toEqual([0, 0]);
      }
      for (const key of r.entryAdded) replay.add(key);
      for (const key of r.entryRemoved) replay.delete(key);
      tally.added += r.entryAdded.length;
      tally.removed += r.entryRemoved.length;
      expect(sortedKeys(replay), `batch ${b}`).toEqual(sortedKeys(d.columns()));
    }
    expect(posted).toBe(200);
    expect(tally.refused).toBe(1);
    // The run exercised each kind of edit, and columns both gained and lost their entries.
    for (const kind of ['places', 'breaks', 'reverts', 'added', 'removed'] as const) expect(tally[kind], kind).toBeGreaterThan(0);
  });

  test('a batch refused `\'full\'` restores its entries and reports neither added nor removed, while its columns stay dirty (restored values marked)', () => {
    const s = cannedStore(MiB);
    while (s.blockPool.freeCount() > 1) s.blockPool.alloc();
    const d = createDiffStore();
    // An entry of (0, 0) from before the batch, its column's dirty mark already taken (as a flush would).
    d.set(0, 0, sectionOf(60), idxOf(3, 60, 3), val(GLASS));
    expect(sortedKeys(d.takeDirty())).toEqual([colKey(0, 0)]);
    const r = applyEdits(s, d, scratch, [set(5, 70, 5, val(STONE), val(AIR)), set(21, 70, 5, val(STONE), val(AIR))], now);
    expect(r.refused).toBe('full');
    expect([r.entryAdded.length, r.entryRemoved.length]).toEqual([0, 0]);
    // The first edit's entry was recorded, then restored; the earlier entry is untouched.
    expect(entry(d, 5, 70, 5)).toBe(NO_ENTRY);
    expect(entry(d, 3, 60, 3)).toBe(val(GLASS));
    expect(sortedKeys(d.columns())).toEqual([colKey(0, 0)]);
    // The recorded and restored column is marked; (1, 0), whose entry was never recorded, is not.
    expect(sortedKeys(d.takeDirty())).toEqual([colKey(0, 0)]);
    expect(sortedKeys(d.takeDirty())).toEqual([]);
  });
});

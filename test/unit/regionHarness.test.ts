import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { seedFromInput } from '../../src/core/seed';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { createMeshScratch, meshColumnPayload, payloadProblem } from '../../src/mesh/column';
import { AIR, DEEPSLATE, DIRT, STONE } from '../../src/world/blocks/index';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { FACE_DOWN, FACE_EAST, FACE_UP } from '../../src/world/blocks/kinds';
import { allocAux } from '../../src/world/store/aux';
import { finalAt, protoAt, REC_AUX_A, REC_AUX_B } from '../../src/world/store/columnTable';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { regionCachePath, srcKey, type RegionCacheHeader } from '../harness/cache';
import { ctxFor, paramsWith } from '../harness/gen';
import { bruteFaces, meshFaceCounts } from '../harness/refs';
import { dt1WorkerDir, genRegion, litRegionHash, regionColumns, regionDiff, regionView, type GenRegionOptions } from '../harness/region';

const MiB = 1 << 20;

const rowMajor = (cx0: number, cz0: number, w: number, h: number): string[] => {
  const out: string[] = [];
  for (let cz = cz0; cz < cz0 + h; cz++) for (let cx = cx0; cx < cx0 + w; cx++) out.push(`${cx},${cz}`);
  return out;
};
const keys = (cols: ReadonlyArray<readonly [number, number]>) => cols.map(([cx, cz]) => `${cx},${cz}`);

describe('regionColumns (§6.1)', () => {
  test('spiral: the centre (cx0 + ⌊w/2⌋, cz0 + ⌊h/2⌋), then square rings clockwise from their north-west corner', () => {
    expect(regionColumns('spiral', 0, 0, 3, 3)).toEqual([[1, 1], [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]);
    expect(regionColumns('spiral', 0, 0, 2, 2)).toEqual([[1, 1], [0, 0], [1, 0], [0, 1]]);
    expect(regionColumns('spiral', 5, -3, 1, 1)).toEqual([[5, -3]]);
    expect(regionColumns('spiral', 0, 0, 4, 1)).toEqual([[2, 0], [3, 0], [1, 0], [0, 0]]);
  });

  test.each([[8, 8], [5, 3], [1, 7], [64, 64], [13, 2]])('spiral %i × %i: every column once, rings never shrink', (w, h) => {
    const cols = regionColumns('spiral', -4, 9, w, h);
    expect([...keys(cols)].sort()).toEqual(rowMajor(-4, 9, w, h).sort());
    const c = [-4 + Math.floor(w / 2), 9 + Math.floor(h / 2)];
    const ring = cols.map(([cx, cz]) => Math.max(Math.abs(cx - c[0]!), Math.abs(cz - c[1]!)));
    for (let i = 1; i < ring.length; i++) expect(ring[i]).toBeGreaterThanOrEqual(ring[i - 1]!);
  });

  test('shuffled: a Fisher-Yates permutation of the row-major list from Xoshiro128(shuffleSeed ?? 1)', () => {
    const a = regionColumns('shuffled', 0, 0, 4, 4);
    expect([...keys(a)].sort()).toEqual(rowMajor(0, 0, 4, 4).sort());
    expect(keys(a)).not.toEqual(rowMajor(0, 0, 4, 4));
    expect(regionColumns('shuffled', 0, 0, 4, 4, 1)).toEqual(a);
    expect(regionColumns('shuffled', 0, 0, 4, 4, 2)).not.toEqual(a);
    expect(regionColumns('shuffled', 0, 0, 4, 4, 2)).toEqual(regionColumns('shuffled', 0, 0, 4, 4, 2));
    // Pinned: a change of the draw (direction, nextInt) shows here, not as an unexplained DT1 difference.
    expect(keys(a)).toEqual(SHUFFLED_4X4_SEED_1);
    // Shifting the region shifts the permutation.
    expect(regionColumns('shuffled', 10, -20, 4, 4)).toEqual(a.map(([cx, cz]) => [cx + 10, cz - 20]));
  });

  test('rejects regions outside 1 … 64 per side and unknown orders', () => {
    expect(() => regionColumns('spiral', 0, 0, 0, 1)).toThrow(RangeError);
    expect(() => regionColumns('spiral', 0, 0, 65, 1)).toThrow(RangeError);
    expect(() => regionColumns('shuffled', 0, 0, 2, 1.5)).toThrow(RangeError);
    expect(() => regionColumns('zigzag' as 'spiral', 0, 0, 2, 2)).toThrow(/order/);
  });
});

const SHUFFLED_4X4_SEED_1 = ['1,1', '2,0', '2,2', '1,2', '1,0', '3,2', '3,1', '2,3', '3,3', '0,0', '0,2', '2,1', '0,3', '3,0', '1,3', '0,1'];

describe('regionView (§6.1)', () => {
  const store = createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
  genRegionInProcess(store, ctxFor('42'), -2, 3, 2, 2);
  const view = regionView(store, -2, 3, 2, 2);

  test('reads proto voxels, biome and the _WG heightmaps at world x, z through the store', () => {
    for (const [x, z] of [[-32, 48], [-1, 79], [-17, 60]] as const) {
      const v = store.proto(x >> 4, z >> 4)!;
      const lx = x & 15;
      const lz = z & 15;
      for (const y of [-64, -10, 40, 62, 63, 64, 100, 319]) {
        expect(view.block(x, y, z)).toBe(v.block(lx, y, lz));
        expect(view.fluid(x, y, z)).toBe(v.fluid(lx, y, lz));
      }
      const a = v.aux()!;
      expect(view.biome(x, z)).toBe(a.surfaceBiome[lz * 16 + lx]);
      expect(view.worldSurfaceWG(x, z)).toBe(a.worldSurfaceWG[lz * 16 + lx]);
      expect(view.oceanFloorWG(x, z)).toBe(a.oceanFloorWG[lz * 16 + lx]);
    }
  });

  test('descriptors(cx, cz): a copy of the 24 proto descriptors (blocks, fluid per section)', () => {
    const d = view.descriptors(-1, 4);
    expect(d.length).toBe(48);
    const base = store.table.find(-1, 4);
    for (let sy = 0; sy < 24; sy++) expect([d[2 * sy], d[2 * sy + 1]]).toEqual([...store.table.ints.subarray(protoAt(base, sy), protoAt(base, sy) + 2)]);
    d[0] = 12345;
    expect(view.descriptors(-1, 4)[0]).not.toBe(12345);
    expect(store.table.ints[base + REC_AUX_A]).toBeGreaterThanOrEqual(0);
  });

  test('hash(): regionHash of the region or of a sub-window, as hex64', () => {
    expect(view.hash()).toBe(hex64(regionHash(store, -2, 3, 2, 2)));
    expect(view.hash(-1, 3, 1, 2)).toBe(hex64(regionHash(store, -1, 3, 1, 2)));
    expect(() => view.hash(-3, 3, 2, 2)).toThrow(RangeError);
    expect(() => view.hash(-2, 3, 3, 1)).toThrow(RangeError);
  });

  test('reads outside the region, or at y outside −64 … 319, throw', () => {
    expect(() => view.block(-33, 0, 48)).toThrow(RangeError);
    expect(() => view.block(0, 0, 48)).toThrow(RangeError);
    expect(() => view.fluid(-32, 0, 80)).toThrow(RangeError);
    expect(() => view.biome(-32, 47)).toThrow(RangeError);
    expect(() => view.block(-32, 320, 48)).toThrow(RangeError);
    expect(() => view.descriptors(0, 3)).toThrow(RangeError);
    expect(() => regionView(store, -2, 3, 3, 2)).toThrow(/no proto set/);
  });
});

describe('regionDiff (§6.1)', () => {
  const twin = () => {
    const s = createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
    genRegionInProcess(s, ctxFor('42'), 0, 0, 2, 2);
    return regionView(s, 0, 0, 2, 2);
  };

  test('null for the same proto data; names the first column and section that differ', () => {
    const a = twin();
    const b = twin();
    expect(regionDiff(a, b)).toBeNull();
    const base = b.store.table.find(1, 1);
    const sy = [...Array(24).keys()].find((k) => b.store.table.ints[protoAt(base, k)]! >= 0)!;
    const words = b.store.blockPool.u16(b.store.table.ints[protoAt(base, sy)]!);
    words[100] = words[100]! ^ 1;
    expect(regionDiff(a, b)).toBe(`column (1, 1) section ${sy}: blocks differ`);
    words[100] = words[100]! ^ 1;
    expect(regionDiff(a, b)).toBeNull();
    const aux = b.store.proto(0, 1)!.aux()!;
    aux.tintTH[5] = 1;
    expect(regionDiff(a, b)).toBe('column (0, 1): aux A differs');
    aux.tintTH[5] = 0;
    expect(regionDiff(a, regionView(b.store, 0, 0, 2, 1))).toBe('the views cover other regions');
  });

  test('aux B: an absent slot equals a zero one; a differing byte is named (SP3b spec §7)', () => {
    const a = twin();
    const b = twin();
    // The T stage writes aux B: detach a's (1, 0) slot (it leaks; the store is thrown away) and give b's (1, 0) a fresh
    // zero-filled slot, as a column whose stage wrote only zero quarts holds.
    a.store.table.ints[a.store.table.find(1, 0) + REC_AUX_B] = -1;
    expect(a.store.proto(1, 0)!.auxB()).toBeNull();
    expect(regionDiff(a, b)).toBe('column (1, 0): aux B differs');
    const base = b.store.table.find(1, 0);
    b.store.table.ints[base + REC_AUX_B] = allocAux(b.store.bytePool);
    expect(b.store.proto(1, 0)!.auxB()).not.toBeNull();
    expect(regionDiff(a, b)).toBeNull();
    b.store.proto(1, 0)!.auxB()!.surfaceBiomeQ[3] = 4;
    expect(regionDiff(a, b)).toBe('column (1, 0): aux B differs');
    expect(regionDiff(b, a)).toBe('column (1, 0): aux B differs');
  });

  test('uniform sections compare by value; a uniform section never equals a dense one with the same values', () => {
    const one = (dense: boolean, state5 = 1) => {
      const s = createStore({ shared: false, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
      const w = s.claimColumn(0, 0, 0);
      for (let sy = 0; sy < 24; sy++) w.setProto(sy, new Uint16Array(4096).fill(sy === 5 ? state5 : 1), new Uint8Array(4096));
      w.commit(1);
      if (dense) {
        // Rewrite section 3's fluid as a dense slot holding all zeros (as a stale layout would).
        const base = s.table.find(0, 0);
        const slot = s.bytePool.alloc();
        s.bytePool.u8(slot).fill(0);
        s.table.ints[protoAt(base, 3) + 1] = slot;
      }
      return regionView(s, 0, 0, 1, 1);
    };
    expect(regionDiff(one(false), one(false))).toBeNull();
    expect(regionDiff(one(false), one(false, 2))).toBe('column (0, 0) section 5: blocks differ');
    expect(regionDiff(one(false), one(true))).toBe('column (0, 0) section 3: fluid differs');
  });
});

test('dt1WorkerDir: one worker directory per metrics tier, none shared with the default (SP3b spec §7)', () => {
  const dirs = (['fast', 'quick', 'full'] as const).map((t) => dt1WorkerDir(t));
  expect(new Set([...dirs, 'regionWorker']).size).toBe(4);
  expect(dt1WorkerDir('quick')).toBe(dt1WorkerDir('quick'));
  for (const d of dirs) expect(d).toMatch(/^[A-Za-z0-9-]+$/);
});

describe('genRegion with 1 thread (§6.1)', () => {
  const base: GenRegionOptions = { seed: '42', params: paramsWith(), cx0: -2, cz0: -2, w: 4, h: 4, upTo: 'T', order: 'spiral', threads: 1 };

  test('spiral and shuffled give the in-process region; a plain ArrayBuffer store; per-column timings', async () => {
    const ref = createStore({ shared: false, maxBlockBytes: 16 * MiB, maxByteBytes: 16 * MiB });
    genRegionInProcess(ref, ctxFor('42'), -2, -2, 4, 4);
    const want = hex64(regionHash(ref, -2, -2, 4, 4));
    for (const order of ['spiral', 'shuffled'] as const) {
      const r = await genRegion({ ...base, order, shuffleSeed: 5 });
      expect(r.view.hash(), order).toBe(want);
      expect(r.cacheHit).toBe(false);
      expect(r.view.store.shared).toBe(false);
      expect(r.columnsPerThread).toEqual([16]);
      expect(r.timings.perColumnMs.length).toBe(16);
      for (const ms of r.timings.perColumnMs) expect(ms).toBeGreaterThan(0);
      expect(r.timings.totalMs).toBeGreaterThan(0);
      for (let cz = -2; cz < 2; cz++) {
        for (let cx = -2; cx < 2; cx++) expect(layout([...r.view.descriptors(cx, cz)])).toEqual(layout(descriptorsOf(ref, cx, cz)));
      }
    }
  });

  test('threads 1, shared true: a SharedArrayBuffer store, the same hash', async () => {
    const plain = await genRegion(base);
    const shared = await genRegion({ ...base, shared: true });
    expect(plain.view.store.shared).toBe(false);
    expect(shared.view.store.shared).toBe(true);
    expect(shared.view.store.handles().table).toBeInstanceOf(SharedArrayBuffer);
    expect(shared.columnsPerThread).toEqual([16]);
    expect(shared.view.hash()).toBe(plain.view.hash());
  });

  test('the profile params reach the stage', async () => {
    const a = await genRegion(base);
    const b = await genRegion({ ...base, params: paramsWith({ climate: { scaleMul: 4 } }) });
    expect(b.view.hash()).not.toBe(a.view.hash());
  });

  test('rejects bad options before generating', async () => {
    await expect(genRegion({ ...base, w: 0 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, h: 65 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, threads: 2 as 1 })).rejects.toThrow(/threads/);
    await expect(genRegion({ ...base, upTo: 'S' as 'T' })).rejects.toThrow(/upTo/);
    await expect(genRegion({ ...base, order: 'zigzag' as 'spiral' })).rejects.toThrow(/order/);
  });
});

/** Descriptors with every dense slot id replaced by 'dense': slot ids depend on the generation order. */
const layout = (d: number[]) => d.map((x) => (x >= 0 ? 'dense' : x));

/** The 24 proto descriptors of a column, read from the record. */
function descriptorsOf(store: ReturnType<typeof createStore>, cx: number, cz: number): number[] {
  const base = store.table.find(cx, cz);
  return [...store.table.ints.subarray(protoAt(base, 0), protoAt(base, 0) + 48)];
}

describe('genRegion up to D, L and MESH (SP4a spec §9.2, ruling P31)', () => {
  const DIR = fileURLToPath(new URL('../.cache/regionHarnessUnit/', import.meta.url));
  const base: GenRegionOptions = { seed: '42', params: paramsWith(), cx0: 5, cz0: -3, w: 1, h: 1, upTo: 'T', order: 'spiral', threads: 1 };
  /** The status of (cx, cz) in `store`, or −1 when no record holds it. */
  const statusOf = (store: VoxelStore, cx: number, cz: number): number => {
    const b = store.table.find(cx, cz);
    return b < 0 ? -1 : store.table.status(b);
  };
  /** The statuses of the square rings 0 … 3 around the 1 × 1 region at (5, −3) (each ring's columns agree). */
  const rings = (store: VoxelStore): number[] => [0, 1, 2, 3].map((r) => {
    const seen = new Set<number>();
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) seen.add(statusOf(store, 5 + dx, -3 + dz));
    expect(seen.size, `ring ${r}`).toBe(1);
    return [...seen][0]!;
  });

  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  test('each stage covers one more ring than the stage after it: T on R+2, D on R+1, L on R for upTo L', async () => {
    expect(rings((await genRegion(base)).view.store)).toEqual([1, -1, -1, -1]);
    expect(rings((await genRegion({ ...base, upTo: 'D' })).view.store)).toEqual([2, 1, -1, -1]);
    const l = await genRegion({ ...base, upTo: 'L', order: 'shuffled' });
    expect(rings(l.view.store)).toEqual([3, 2, 1, -1]);
    // Jobs per thread count every stage: 25 T, 9 D and 1 L.
    expect(l.columnsPerThread).toEqual([35]);
    expect(l.timings.perColumnMs.length).toBe(1);
  });

  test("upTo 'T' with w 64 still generates 64 × h columns", async () => {
    const r = await genRegion({ ...base, cx0: -32, w: 64, h: 1 });
    expect(r.columnsPerThread).toEqual([64]);
    expect(r.timings.perColumnMs.length).toBe(64);
    expect(statusOf(r.view.store, -33, -3)).toBe(-1);
    expect(statusOf(r.view.store, 31, -3)).toBe(1);
  });

  test("upTo 'L' with w 61 throws RangeError (and every outermost set wider than 64)", async () => {
    await expect(genRegion({ ...base, upTo: 'L', w: 61 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, upTo: 'L', h: 61 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, upTo: 'D', w: 63 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, upTo: 'MESH', h: 59 })).rejects.toThrow(RangeError);
    await expect(genRegion({ ...base, upTo: 'T', w: 65 })).rejects.toThrow(RangeError);
  });

  test("upTo MESH meshes the cached L region; mesh() is non-null exactly for the region's columns", async () => {
    rmSync(DIR, { recursive: true, force: true });
    const o: GenRegionOptions = { ...base, cx0: 0, cz0: 0, w: 2, h: 2, upTo: 'MESH', cache: true, cacheDir: DIR };
    const a = await genRegion(o);
    expect(a.cacheHit).toBe(false);
    // The dump is the 'L' region grown by one ring, (cx0 − 1, cz0 − 1, w + 2, h + 2); the meshes are never dumped.
    const grown: RegionCacheHeader = {
      genKey: genKey(seedFromInput('42'), stageHashes(o.params)), srcKey: srcKey(), cx0: -1, cz0: -1, w: 4, h: 4, upTo: 'L',
    };
    expect(readdirSync(DIR)).toEqual([regionCachePath(grown, DIR).slice(DIR.length)]);
    const b = await genRegion(o);
    expect(b.cacheHit).toBe(true);
    expect(b.columnsPerThread).toEqual([0]);
    expect(b.timings.perColumnMs.length).toBe(4);
    for (let cz = -2; cz < 4; cz++) {
      for (let cx = -2; cx < 4; cx++) {
        const inside = cx >= 0 && cx < 2 && cz >= 0 && cz < 2;
        for (const r of [a, b]) expect(r.view.mesh(cx, cz) !== null, `(${cx}, ${cz})`).toBe(inside);
        // The L ring around R is Published, so every column of R meshes with a Published 3 × 3.
        if (cx >= -1 && cx < 3 && cz >= -1 && cz < 3) expect(statusOf(b.view.store, cx, cz)).toBe(3);
        if (!inside) continue;
        const pa = a.view.mesh(cx, cz)!;
        const pb = b.view.mesh(cx, cz)!;
        expect(payloadProblem(pb)).toBeNull();
        expect([pb.cx, pb.cz]).toEqual([cx, cz]);
        expect(pb.rows.length).toBeGreaterThan(0);
        for (const k of ['versions', 'connectivity', 'position', 'data', 'index', 'rows', 'spheres'] as const) {
          expect([...pb[k]], `(${cx}, ${cz}) ${k}`).toEqual([...pa[k]]);
        }
      }
    }
    expect(b.view.litHash()).toBe(a.view.litHash());
  });

  test('the view reads light and aux A through the final set; mesh() is null below MESH', async () => {
    const t = await genRegion(base);
    const l = await genRegion({ ...base, upTo: 'L' });
    const f = l.view.store.final(5, -3)!;
    let lit = 0;
    for (let y = -64; y < 320; y += 3) {
      for (const [lx, lz] of [[0, 0], [7, 11], [15, 15]] as const) {
        const x = 80 + lx;
        const z = -48 + lz;
        expect(l.view.light(x, y, z)).toBe(f.light(lx, y, lz));
        expect(l.view.block(x, y, z)).toBe(t.view.block(x, y, z));
        expect(t.view.light(x, y, z)).toBe(0);
        if (l.view.light(x, y, z) !== 0) lit++;
      }
    }
    expect(lit).toBeGreaterThan(0);
    // D wrote the final heightmaps into aux A.
    expect(l.view.aux(5, -3).motionBlocking).toEqual(f.aux()!.motionBlocking);
    expect(l.view.aux(5, -3).motionBlocking.some((v) => v > -64)).toBe(true);
    expect(() => l.view.aux(6, -3)).toThrow(RangeError);
    expect(l.view.mesh(5, -3)).toBeNull();
    expect(t.view.mesh(5, -3)).toBeNull();
    expect(() => t.view.litHash()).toThrow(/litHash/);
  });

  test('litRegionHash: changing one light byte changes litHash and leaves hash unchanged', async () => {
    const l = await genRegion({ ...base, upTo: 'L' });
    const s = l.view.store;
    const h0 = l.view.hash();
    const lit0 = l.view.litHash();
    expect(lit0).toBe(litRegionHash(s, 5, -3, 1, 1));
    const fb = s.table.find(5, -3);
    const sy = [...Array(24).keys()].find((k: number) => s.table.ints[finalAt(fb, k) + 1]! >= 0)!;
    const slot = s.bytePool.u8(s.table.ints[finalAt(fb, sy) + 1]!);
    slot[123] = slot[123]! ^ 1;
    expect(l.view.litHash()).not.toBe(lit0);
    expect(l.view.hash()).toBe(h0);
    slot[123] = slot[123]! ^ 1;
    expect(l.view.litHash()).toBe(lit0);
    // An aux A byte is hashed too.
    const a = s.final(5, -3)!.aux()!;
    a.tintTH[9] = a.tintTH[9]! ^ 1;
    expect(l.view.litHash()).not.toBe(lit0);
    a.tintTH[9] = a.tintTH[9]! ^ 1;
  });
});

describe('the face references (SP4a spec §9.2, ruling P32)', () => {
  /**
   * A canned 3 × 3 of Published columns around (1, 1): a stone floor at y < 0, a deterministic scatter of stone, dirt and
   * deepslate over y 0 … 40 (crossing the sections 4 … 6 and every column seam), still water in some of its air, a
   * stone pillar to y 319 and a lone voxel at y −64.
   */
  function cannedStore(): VoxelStore {
    const s = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 32 * MiB });
    const blocks = new Uint16Array(4096);
    const fluid = new Uint8Array(4096);
    const light = new Uint8Array(4096);
    const hash = (x: number, y: number, z: number): number => {
      let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
      return (h ^ (h >>> 15)) >>> 0;
    };
    for (let cz = 0; cz < 3; cz++) {
      for (let cx = 0; cx < 3; cx++) {
        const w = s.claimColumn(cx, cz, 0);
        for (let sy = 0; sy < 24; sy++) {
          for (let i = 0; i < 4096; i++) {
            const lx = i & 15;
            const lz = (i >> 4) & 15;
            const y = sy * 16 - 64 + (i >> 8);
            const x = cx * 16 + lx;
            const z = cz * 16 + lz;
            const r = hash(x, y, z) % 100;
            let b = AIR;
            let f = 0;
            if (y < 0) b = y === -64 && (x + z) % 5 === 0 ? AIR : STONE;
            else if (y <= 40) {
              if (r < 25) b = STONE;
              else if (r < 32) b = DIRT;
              else if (r < 36) b = DEEPSLATE;
              else if (r < 50 && y <= 20) f = WATER_SOURCE;
            }
            if (x === 23 && z === 24 && y >= 0) b = STONE;
            if (x === 17 && z === 30 && y === 200) b = DIRT;
            blocks[i] = b;
            fluid[i] = f;
            light[i] = y > 20 ? 0xf0 : (8 + (y & 1)) << 4 | 3;
          }
          w.setFinal(sy, blocks, light, fluid);
        }
        w.commit(3);
      }
    }
    return s;
  }

  test("bruteFaces equals meshFaceCounts' unit faces on a canned 3 × 3 store", () => {
    const s = cannedStore();
    const view = regionView(s, 0, 0, 3, 3);
    const brute = bruteFaces(view, 1, 1);
    for (const o of [{ ao: true, smoothLight: true }, { ao: false, smoothLight: false }]) {
      const p = meshColumnPayload(s.neighborhood(1, 1), createMeshScratch(), o);
      const mesh = meshFaceCounts(p);
      expect(brute.opaque.length).toBeGreaterThan(1000);
      expect(brute.water.length).toBeGreaterThan(100);
      expect(mesh.opaque.length).toBe(brute.opaque.length);
      expect(mesh.water.length).toBe(brute.water.length);
      expect(Buffer.from(mesh.opaque.buffer).equals(Buffer.from(brute.opaque.buffer))).toBe(true);
      expect(Buffer.from(mesh.water.buffer).equals(Buffer.from(brute.water.buffer))).toBe(true);
      // The greedy merge covers several unit faces per quad.
      expect(mesh.quadsOpaque).toBeGreaterThan(0);
      expect(mesh.quadsOpaque).toBeLessThan(mesh.opaque.length);
      expect(mesh.quadsWater).toBeLessThan(mesh.water.length);
    }
    // The keys: sorted and unique, ((y + 64)·256 + lz·16 + lx)·6 + face. The lone voxel at y −64 shows no down face,
    // and the pillar's top at y 319 shows its up face.
    for (const a of [brute.opaque, brute.water]) for (let i = 1; i < a.length; i++) expect(a[i]!).toBeGreaterThan(a[i - 1]!);
    const key = (lx: number, y: number, lz: number, f: number) => ((y + 64) * 256 + lz * 16 + lx) * 6 + f;
    expect(brute.opaque.includes(key(7, 319, 8, FACE_UP))).toBe(true);
    expect(brute.opaque.includes(key(7, 319, 8, FACE_EAST))).toBe(true);
    expect(brute.opaque.some((k) => k < 256 * 6 && k % 6 === FACE_DOWN)).toBe(false);
  });

  test('meshFaceCounts keeps duplicates; bruteFaces throws for a column whose neighbours are outside the view', () => {
    const s = cannedStore();
    const p = meshColumnPayload(s.neighborhood(1, 1), createMeshScratch(), { ao: true, smoothLight: true });
    const twice: typeof p = {
      ...p,
      position: new Uint8Array([...p.position, ...p.position.subarray(0, 16)]),
      data: new Uint32Array([...p.data, ...p.data.subarray(0, 4)]),
    };
    const once = meshFaceCounts(p);
    const both = meshFaceCounts({ ...twice, rows: appendRow(p.rows, p.rows[0]!, p.rows[1]!, p.data.length) });
    expect(both.opaque.length + both.water.length).toBeGreaterThan(once.opaque.length + once.water.length);
    expect(() => bruteFaces(regionView(s, 0, 0, 3, 3), 0, 1)).toThrow(RangeError);
  });
});

/** `rows` plus one row (sy, pass) of one quad at `vertexStart`. */
function appendRow(rows: Int32Array, sy: number, pass: number, vertexStart: number): Int32Array {
  return new Int32Array([...rows, sy, pass, vertexStart, 4, 0, 6]);
}

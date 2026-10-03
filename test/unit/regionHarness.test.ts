import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { protoAt, REC_AUX_A } from '../../src/world/store/columnTable';
import { createStore } from '../../src/world/store/store';
import { ctxFor, paramsWith } from '../harness/gen';
import { genRegion, regionColumns, regionDiff, regionView, type GenRegionOptions } from '../harness/region';

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

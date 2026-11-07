/**
 * The carver path cache and the carve of a column (SP6a spec §2.4-§2.5, D6, D7, D8; Task 26): `createCarverCache`,
 * `carveColumn`, `carvedKind`, `densityTopOf` and the one per-voxel carve test `carveTest` they share (ruling P21).
 * - bit identity across a chunk border: columns (0, 0) and (1, 0) carve exactly what a test-local carve of the
 *   32 × 16 × 384 box computes, walking `carverPath`'s paths in the window's order and calling `carveTest` on each
 *   voxel the density fill left solid (ruling P20), with an ellipsoid that carves on both sides of the border;
 * - the LRU's purity: capacities 1 and 1,024, cold and warm (from another region), give byte-identical solidity and tags;
 * - the shrinks (σ_w, σ_i, σ_u) and the bedrock, on synthetic paths through a synthetic column; the density top under a
 *   floating island over the sea (SP6a spec §2.4: the sea bed's, water v0's base rule);
 * - the window's order: a voxel two sources carve is tagged with the first;
 * - wet′ in `carve.ts` equals the default tree's wet′ subtree through the reference, bit for bit, at 10,000 positions;
 * - `carvedKind` equals `carveColumn`'s tags on every density-solid voxel of 8 columns (ruling P19), column by column;
 * - `carverCacheOf` (Task 27): one cache per GenContext over `carverParamsOf(ctx.params)` with capacity 1,024, a new one
 *   for a new context (a `configure`); `carvedAt` equals the T stage's carve on every density-solid voxel of 8 columns,
 *   an island-over-sea column of floating_islands among them; its density-top memo (ruling R18) answers as a fresh scan
 *   with probes interleaved over two contexts and two columns;
 * - Review Focus 5 (Task 28): a column a worm carves from a source 10 chunks away hashes the same in a region, alone on a
 *   fresh store (`isolatedColumn`), after a teleport filled the 1,024-path LRU, after a configure emptied it and with an
 *   LRU of 1; the two columns either side of the worm's chunk border carve what the global carver reference
 *   `referenceCarve` (`test/harness/refs.ts`, Task 30) carves over the region, and store it, at the voxels next to it.
 */
import { describe, expect, test } from 'vitest';
import { CARVER_CACHE_PATHS, CARVER_WINDOW_R, CAVE_KIND, HEIGHT, ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { carveColumn, carvedAt, carvedKind, carveShrink, carveTest, densityTopColumn, densityTopOf, wetAt } from '../../src/gen/caves/carve';
import { carverCacheOf, createCarverCache, type CarverCache } from '../../src/gen/caves/carverCache';
import { carverParamsOf, carverPath, type CarverKind, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { probe } from '../../src/gen/density/probe';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { createStore } from '../../src/world/store/store';
import { newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { fillDensityColumn } from '../../src/gen/density/bounds';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import type { Expr } from '../../src/gen/density/expr';
import { createDensityReference } from '../../src/gen/density/reference';
import { hex64 } from '../../src/core/hash';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { CARVER_DEFAULTS } from '../harness/carverParams';
import { ctxFor, paramsWith } from '../harness/gen';
import { referenceCarve } from '../harness/refs';
import { genRegion, isolatedColumn, type GenRegionOptions, type RegionResult } from '../harness/region';

const NEVER = (): boolean => false;
const R = CARVER_WINDOW_R;
/** The window's kind order (the innermost loop). */
const KINDS: readonly CarverKind[] = ['worm', 'ravine', 'undergroundWorm'];
const TAG_OF: Readonly<Record<CarverKind, number>> = {
  worm: CAVE_KIND.worm, ravine: CAVE_KIND.ravine, undergroundWorm: CAVE_KIND.undergroundWorm,
};
/** The fill's voxel index: `((y + 64)·16 + lz)·16 + lx`. */
const idx = (lx: number, y: number, lz: number): number => ((y + 64) * 16 + lz) * 16 + lx;

const ctx = ctxFor('42');
const dc = createDensityContext(ctx);

interface Filled {
  readonly cx: number;
  readonly cz: number;
  readonly s: ColumnSample;
  /** The density fill's solidity (never carved: copy it). */
  readonly solid: Uint8Array;
  /** `densityTopOf` per `lz·16 + lx`. */
  readonly top: Int16Array;
}

/** The density tops of a filled column (`densityTopOf` over its solidity). */
function topsOf(solid: Uint8Array, islands: boolean): Int16Array {
  const top = new Int16Array(256);
  for (let p = 0; p < 256; p++) top[p] = densityTopOf((y) => solid[256 * (y + 64) + p] === 1, islands);
  return top;
}

/** Column (cx, cz) of `d` after the T stage's density fill (its own sample: the column cache may reuse its object). */
function filled(d: DensityContext, cx: number, cz: number, islands = false): Filled {
  const s = newColumnSample();
  const cached = d.columns.get(cx, cz);
  s.cx = cached.cx;
  s.cz = cached.cz;
  for (const k of Object.keys(cached.f) as (keyof ColumnSample['f'])[]) s.f[k].set(cached.f[k]);
  s.flags.set(cached.flags);
  s.biome.set(cached.biome);
  const solid = new Uint8Array(98304);
  expect(fillDensityColumn(d.bounds, s, solid, null, null, NEVER)).toBe(true);
  return { cx, cz, s, solid, top: topsOf(solid, islands) };
}

/** `carveColumn` on a copy of the column's fill: the carved solidity and the tags. */
function carved(cache: CarverCache, p: CarverParams, c: Filled): { solid: Uint8Array; tags: Uint8Array } {
  const solid = c.solid.slice();
  const tags = new Uint8Array(98304);
  carveColumn(cache, p, c.s, c.cx, c.cz, solid, c.top, tags);
  return { solid, tags };
}

/** The first index where two byte arrays differ, or −1 (a loop: `toEqual` over 98,304 bytes is slow). */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// ---------------------------------------------------------------- synthetic paths and columns

/** A cache that serves the given paths by source and nothing else. */
function fakeCache(paths: readonly CarverPath[]): CarverCache {
  const m = new Map(paths.map((q) => [`${q.kind} ${q.sx} ${q.sz}`, q] as const));
  return { path: (kind, sx, sz) => m.get(`${kind} ${sx} ${sz}`) ?? null, size: m.size, params: CARVER_DEFAULTS, capacity: Math.max(1, m.size) };
}

/** A vertical stack of spheres of radius r at (x, z), one per y from y0 to y1, floor −1 (none); a ravine's f² all 1. */
function stack(kind: CarverKind, sx: number, sz: number, x: number, z: number, y0: number, y1: number, r: number): CarverPath {
  const count = y1 - y0 + 1;
  const ell = new Float64Array(6 * count);
  for (let k = 0; k < count; k++) ell.set([x, y0 + k, z, r, r, -1], 6 * k);
  const box = Float64Array.of(x - r, y0 - r, z - r, x + r, y1 + r, z + r);
  return { kind, sx, sz, count, ell, box, widthSq: kind === 'ravine' ? new Float64Array(HEIGHT).fill(1) : null };
}

/** Column (0, 0) as a synthetic sample with wetMask `wet` everywhere, solid from y −64 to `top`, density top `top`. */
function synthetic(wet: number, top: number): Filled {
  const s = newColumnSample();
  s.f.wetMask.fill(wet);
  const solid = new Uint8Array(98304);
  solid.fill(1, 0, 256 * (top + 65));
  return { cx: 0, cz: 0, s, solid, top: new Int16Array(256).fill(top) };
}

/** Carved voxels per y (index y + 64) of `carveColumn` with `paths` on `c`. */
function layers(paths: readonly CarverPath[], p: CarverParams, c: Filled): Int32Array {
  const { solid } = carved(fakeCache(paths), p, c);
  const out = new Int32Array(HEIGHT);
  for (let i = 0; i < 98304; i++) if (c.solid[i] === 1 && solid[i] === 0) out[i >> 8]!++;
  return out;
}

const withLimits = (p: CarverParams, limits: Partial<CarverParams['limits']>): CarverParams => ({ ...p, limits: { ...p.limits, ...limits } });

/**
 * The test-local carve of the 32 × 16 × 384 box of two columns side by side along x (ruling P20): the sources of both
 * windows in the window's order (sz, then sx, then the kind), each path's ellipsoids in index order, `carveTest` on
 * every voxel of the box the density fill left solid. `straddling` counts the ellipsoids that carve on both sides of the
 * border between them.
 */
function boxCarve(seed: typeof ctx.seed, p: CarverParams, cols: readonly [Filled, Filled]): { solid: Uint8Array[]; tags: Uint8Array[]; straddling: number } {
  const [a, b] = cols;
  expect([b.cx - a.cx, b.cz - a.cz], 'boxCarve: two columns side by side along x').toEqual([1, 0]);
  const x0 = 16 * a.cx, z0 = 16 * a.cz;
  const solid = cols.map((c) => c.solid.slice());
  const tags = cols.map(() => new Uint8Array(98304));
  let straddling = 0;
  for (let sz = a.cz - R; sz <= a.cz + R; sz++) {
    for (let sx = a.cx - R; sx <= b.cx + R; sx++) {
      for (const kind of KINDS) {
        const path = carverPath(seed, kind, sx, sz, p);
        if (path === null) continue;
        for (let e = 0; e < path.count; e++) {
          const [ex, ey, ez, rh, rv] = path.ell.subarray(6 * e, 6 * e + 5) as unknown as number[];
          if (ex! + rh! < x0 - 1 || ex! - rh! > x0 + 33 || ez! + rh! < z0 - 1 || ez! - rh! > z0 + 17) continue;
          const both = [0, 0];
          for (let y = Math.max(-64, Math.floor(ey! - rv!) - 1); y <= Math.min(319, Math.ceil(ey! + rv!) + 1); y++) {
            for (let z = z0; z < z0 + 16; z++) {
              for (let x = x0; x < x0 + 32; x++) {
                const c = (x - x0) >> 4, v = idx(x & 15, y, z & 15);
                if (cols[c]!.solid[v] !== 1) continue;
                if (carveTest(p, path, e, x, y, z, wetAt(cols[c]!.s, x, z), cols[c]!.top[16 * (z & 15) + (x & 15)]!) !== 1) continue;
                both[c]!++;
                if (solid[c]![v] === 1) {
                  solid[c]![v] = 0;
                  tags[c]![v] = TAG_OF[kind];
                }
              }
            }
          }
          if (both[0]! > 0 && both[1]! > 0) straddling++;
        }
      }
    }
  }
  return { solid, tags, straddling };
}

// ---------------------------------------------------------------- the tests

describe('the carve across a chunk border (SP6a spec §2.4; ruling P20)', () => {
  test('columns (0, 0) and (1, 0) carve exactly the voxels a carve of the 32 × 16 box computes, an ellipsoid on both sides', () => {
    const p = CARVER_DEFAULTS;
    const cols = [filled(dc, 0, 0), filled(dc, 1, 0)] as const;
    const { solid, tags, straddling } = boxCarve(ctx.seed, p, cols);
    expect(straddling, 'no ellipsoid carves on both sides of x = 16').toBeGreaterThan(0);
    const cache = createCarverCache(ctx, p, 1024);
    let carvedVoxels = 0;
    cols.forEach((c, k) => {
      const got = carved(cache, p, c);
      expect(firstDiff(got.solid, solid[k]!), `column (${c.cx}, ${c.cz}) solidity`).toBe(-1);
      expect(firstDiff(got.tags, tags[k]!), `column (${c.cx}, ${c.cz}) tags`).toBe(-1);
      for (let i = 0; i < 98304; i++) if (c.solid[i] === 1 && got.solid[i] === 0) carvedVoxels++;
    });
    expect(carvedVoxels).toBeGreaterThan(0);
  });
});

describe('the path cache (SP6a spec §2.5)', () => {
  test('capacities 1 and 1,024, cold and warm (from another region), give byte-identical solidity and tags on 16 columns', () => {
    const p = CARVER_DEFAULTS;
    const cols: Filled[] = [];
    for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) cols.push(filled(dc, cx, cz));
    const other = [filled(dc, 60, -40), filled(dc, 61, -40)];
    const run = (capacity: number, warm: boolean) => {
      const cache = createCarverCache(ctx, p, capacity);
      if (warm) for (const c of other) carved(cache, p, c);
      const out = cols.map((c) => carved(cache, p, c));
      return { out, size: cache.size };
    };
    const base = run(1024, false);
    let tagged = 0;
    for (const r of base.out) for (const t of r.tags) if (t !== 0) tagged++;
    expect(tagged, 'nothing carved in the 16 columns').toBeGreaterThan(0);
    expect(base.size).toBeGreaterThan(1);
    expect(base.size).toBeLessThanOrEqual(1024);
    for (const [capacity, warm] of [[1, false], [1, true], [1024, true]] as const) {
      const r = run(capacity, warm);
      if (capacity === 1) expect(r.size).toBeLessThanOrEqual(1);
      r.out.forEach((o, k) => {
        expect(firstDiff(o.solid, base.out[k]!.solid), `capacity ${capacity} warm ${warm} column ${k} solidity`).toBe(-1);
        expect(firstDiff(o.tags, base.out[k]!.tags), `capacity ${capacity} warm ${warm} column ${k} tags`).toBe(-1);
      });
    }
  });

  test('a source\'s path is carverPath\'s; a failed roll is null and not cached', () => {
    const cache = createCarverCache(ctx, CARVER_DEFAULTS, 4);
    let nulls = 0, paths = 0;
    for (let sx = 0; sx < 40; sx++) {
      for (const kind of KINDS) {
        const want = carverPath(ctx.seed, kind, sx, -3, CARVER_DEFAULTS);
        const got = cache.path(kind, sx, -3);
        if (want === null) {
          nulls++;
          expect(got).toBeNull();
        } else {
          paths++;
          expect(got!.ell).toEqual(want.ell);
          expect(got!.box).toEqual(want.box);
          expect(cache.path(kind, sx, -3), 'a hit returns the cached path').toBe(got);
        }
        expect(cache.size).toBeLessThanOrEqual(4);
      }
    }
    expect(nulls).toBeGreaterThan(0);
    expect(paths).toBeGreaterThan(4);
  });
});

describe('the shrinks (SP6a spec §2.4, D7, D8)', () => {
  const p = CARVER_DEFAULTS;

  test('σ_w with wet′ = 1: 1 − σ_w is 0 within 16 blocks of the density top and rises linearly to 1 at 40 below it', () => {
    const top = 100;
    for (let d = -4; d <= 60; d++) {
      const sigma = carveShrink(p, 'worm', top - d, 1, top);
      if (d <= 16) expect(1 - sigma, `d ${d}`).toBe(0);
      else if (d >= 40) expect(1 - sigma, `d ${d}`).toBe(1);
      else expect(1 - sigma, `d ${d}`).toBeCloseTo((d - 16) / 24, 12);
      expect(carveShrink(p, 'worm', top - d, 0, top), `dry, d ${d}`).toBe(0);
    }
  });

  test('with wet′ = 1 no voxel within 16 blocks of the density top is carved; the rate rises monotonically down to 40 below it', () => {
    const top = 100;
    const path = [stack('worm', 0, 0, 8, 8, 30, 110, 5)];
    const wet = layers(path, p, synthetic(1, top));
    const dry = layers(path, p, synthetic(0, top));
    for (let y = top - 16; y <= top; y++) expect(wet[y + 64], `y ${y}`).toBe(0);
    for (let y = 40; y <= top - 40; y++) expect(wet[y + 64], `y ${y}: full size from 40 below`).toBe(dry[y + 64]);
    expect(dry[top - 16 + 64]).toBeGreaterThan(0);
    for (let y = top - 40; y < top - 16; y++) expect(wet[y + 64 + 1]!, `y ${y + 1}`).toBeLessThanOrEqual(wet[y + 64]!);
    expect(wet[top - 17 + 64]!).toBeLessThan(wet[top - 40 + 64]!);
    expect(wet[top - 28 + 64]!).toBeGreaterThan(0);
  });

  test('at capTop 180 nothing at y ≥ 172 is carved; below 156 the carve is full size', () => {
    const path = [stack('worm', 0, 0, 8, 8, 100, 250, 5)];
    const capped = layers(path, withLimits(p, { capTop: 180 }), synthetic(0, 300));
    const free = layers(path, p, synthetic(0, 300));
    for (let y = 172; y < 320; y++) expect(capped[y + 64], `y ${y}`).toBe(0);
    for (let y = 110; y < 156; y++) expect(capped[y + 64], `y ${y}`).toBe(free[y + 64]);
    expect(free[200 + 64]).toBeGreaterThan(0);
    expect(capped[160 + 64]!).toBeLessThan(free[160 + 64]!);
  });

  test('an underground worm carves nothing at y ≥ 40 and at full size below 24', () => {
    expect(p.undergroundWorms.maxY).toBe(40);
    const under = layers([stack('undergroundWorm', 0, 0, 8, 8, -40, 80, 5)], p, synthetic(0, 300));
    const worm = layers([stack('worm', 0, 0, 8, 8, -40, 80, 5)], p, synthetic(0, 300));
    for (let y = 40; y < 320; y++) expect(under[y + 64], `y ${y}`).toBe(0);
    for (let y = -30; y < 24; y++) expect(under[y + 64], `y ${y}`).toBe(worm[y + 64]);
    expect(worm[50 + 64]).toBeGreaterThan(0);
    expect(under[30 + 64]!).toBeLessThan(worm[30 + 64]!);
  });

  test('a worm carves only above its floor (dy > floor); a ravine has no floor', () => {
    const sphere = (kind: CarverKind, floor: number): CarverPath => {
      const q = stack(kind, 0, 0, 8, 8, 40, 40, 6);
      q.ell[5] = floor;
      return q;
    };
    const c = synthetic(0, 100);
    for (const floor of [-0.4, 0, 0.5]) {
      const worm = layers([sphere('worm', floor)], p, c);
      const ravine = layers([sphere('ravine', floor)], p, c);
      for (let y = 30; y <= 50; y++) {
        const dy = (y + 0.5 - 40) / 6;
        if (dy > floor) expect(worm[y + 64], `floor ${floor} y ${y}`).toBe(ravine[y + 64]);
        else expect(worm[y + 64], `floor ${floor} y ${y}`).toBe(0);
      }
      expect(ravine[34 + 64], 'the ravine carves below every floor').toBeGreaterThan(0);
    }
  });

  test('nothing is carved at y −64 (the bedrock)', () => {
    const c = synthetic(0, 100);
    const got = layers([stack('worm', 0, 0, 8, 8, -70, -50, 5)], p, c);
    expect(got[0]).toBe(0);
    expect(got[1]).toBeGreaterThan(0);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) expect(carveTest(p, stack('worm', 0, 0, x + 0.5, z + 0.5, -64, -64, 3), 0, x, -64, z, 0, 100)).toBe(0);
  });
});

describe('the density top under a floating island (SP6a spec §2.4)', () => {
  /** An island over the sea in floating_islands, seed 42 (test/unit/floatingIslands.test.ts' SEA_CORE). */
  const SEA_CORE = [19358, -22222] as const;
  const floating = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));

  test('with islands.enabled densityTopOf is the sea bed\'s top, not the island\'s; nothing is carved within 16 blocks of the bed', () => {
    expect(floating.params.islands.enabled).toBe(true);
    const fdc = createDensityContext(floating);
    const c = filled(fdc, SEA_CORE[0], SEA_CORE[1], true);
    const islandTops = topsOf(c.solid, false);
    let islands = 0;
    for (let p = 0; p < 256; p++) {
      const bed = c.top[p]!;
      expect(bed, `position ${p}`).toBeLessThan(ISLAND_RUN_MIN_BOTTOM);
      expect(c.solid[256 * (bed + 64) + p], `position ${p}: the bed is solid`).toBe(1);
      for (let y = bed + 1; y < ISLAND_RUN_MIN_BOTTOM; y++) expect(c.solid[256 * (y + 64) + p], `position ${p} y ${y}`).toBe(0);
      if (islandTops[p]! >= ISLAND_RUN_MIN_BOTTOM) islands++;
      expect(wetAt(c.s, 16 * c.cx + (p & 15), 16 * c.cz + (p >> 4)), `position ${p} is under the sea`).toBe(1);
    }
    expect(islands, 'no island over the column').toBeGreaterThan(0);
    // A stack of spheres through the whole column below the island cap, with the floating_islands limits.
    const pf: CarverParams = withLimits(CARVER_DEFAULTS, floating.params.caves.limits);
    expect(pf.limits.capTop).toBe(180);
    const paths = [stack('worm', c.cx, c.cz, 16 * c.cx + 8, 16 * c.cz + 8, -40, 150, 14)];
    const carve = (top: Int16Array) => {
      const solid = c.solid.slice();
      carveColumn(fakeCache(paths), pf, c.s, c.cx, c.cz, solid, top, null);
      let near = 0, deep = 0;
      for (let i = 256; i < 98304; i++) {
        if (c.solid[i] !== 1 || solid[i] !== 0) continue;
        const d = c.top[i & 255]! - ((i >> 8) - 64);
        if (d <= 16) near++;
        if (d >= 40) deep++;
      }
      return { near, deep };
    };
    const right = carve(c.top);
    expect(right.near).toBe(0);
    expect(right.deep).toBeGreaterThan(0);
    // The island's top instead would open the rock right under the sea bed.
    expect(carve(islandTops).near).toBeGreaterThan(0);
  });

  test('densityTopOf: −65 with no solid voxel above the bedrock; y −64 never counts; the island rule follows a run upward', () => {
    expect(densityTopOf(() => false, false)).toBe(-65);
    expect(densityTopOf(() => false, true)).toBe(-65);
    expect(densityTopOf((y) => y === -64, false)).toBe(-65);
    expect(densityTopOf((y) => y <= 70, false)).toBe(70);
    // A run from 100 to 200 (its bottom below 181) and an island from 210 to 240.
    const ground = (y: number): boolean => (y >= 100 && y <= 200) || (y >= 210 && y <= 240);
    expect(densityTopOf(ground, false)).toBe(240);
    expect(densityTopOf(ground, true)).toBe(200);
    // Only an island run (bottom ≥ 181): no ground.
    expect(densityTopOf((y) => y >= 181 && y <= 230, true)).toBe(-65);
    expect(densityTopOf((y) => y >= 180 && y <= 319, true)).toBe(319);
  });
});

describe('the window\'s order (SP6a spec §3.2 step 4)', () => {
  const p = CARVER_DEFAULTS;
  /** Two sources with the same spheres: every voxel they carve is tagged with `first`'s kind. */
  const cases: ReadonlyArray<readonly [string, CarverPath, CarverPath]> = [
    ['one source: worm before ravine', stack('worm', 0, 0, 8, 8, -10, 10, 4), stack('ravine', 0, 0, 8, 8, -10, 10, 4)],
    ['one source: ravine before underground worm', stack('ravine', 0, 0, 8, 8, -10, 10, 4), stack('undergroundWorm', 0, 0, 8, 8, -10, 10, 4)],
    ['one row: sx −2 before sx 0', stack('undergroundWorm', -2, 0, 8, 8, -10, 10, 4), stack('worm', 0, 0, 8, 8, -10, 10, 4)],
    ['rows: sz −1 before sz 0', stack('ravine', 5, -1, 8, 8, -10, 10, 4), stack('worm', -5, 0, 8, 8, -10, 10, 4)],
  ];
  for (const [name, first, second] of cases) {
    test(`a voxel two sources carve is tagged with the first in the window's order (${name})`, () => {
      const c = synthetic(0, 100);
      for (const paths of [[first, second], [second, first]]) {
        const cache = fakeCache(paths);
        const solid = c.solid.slice();
        const tags = new Uint8Array(98304);
        carveColumn(cache, p, c.s, 0, 0, solid, c.top, tags);
        let n = 0;
        for (let i = 0; i < 98304; i++) {
          if (c.solid[i] === 1 && solid[i] === 0) {
            n++;
            expect(tags[i], `voxel ${i}`).toBe(TAG_OF[first.kind]);
          } else expect(tags[i]).toBe(0);
        }
        expect(n).toBeGreaterThan(0);
        const at = 256 * (0 + 64) + 16 * 8 + 8;
        expect(carvedKind(cache, p, c.s, 8, 0, 8, () => 100)).toBe(tags[at]);
      }
    });
  }
});

test('carveColumn keeps a tag that is already set', () => {
  const c = synthetic(0, 100);
  const solid = c.solid.slice();
  const tags = new Uint8Array(98304).fill(13);
  carveColumn(fakeCache([stack('worm', 0, 0, 8, 8, -10, 10, 4)]), CARVER_DEFAULTS, c.s, 0, 0, solid, c.top, tags);
  expect(solid.some((v, i) => v === 0 && c.solid[i] === 1)).toBe(true);
  expect(tags.every((t) => t === 13)).toBe(true);
});

describe('wet′ (SP6a spec §1.4, D19; ruling R8)', () => {
  test('carve.ts\' wet′ equals the default tree\'s wet′ subtree through the reference, bit for bit, at 10,000 positions', () => {
    const wetNode = ((dc.expr.defs['wetSteep'] as unknown as { b: { a: Expr } }).b.a);
    expect(wetNode).toEqual({ op: 'clamp', lo: 0, hi: 1, x: { op: 'mul', a: { op: 'const', v: 4 }, b: { op: 'col', field: 'wetMask' } } });
    const ref = createDensityReference(dc.expr, dc.noises);
    const rng = new Xoshiro128(0x5ca1ab1e);
    // 100 columns: the first 50 shore columns (wet and dry lattice points) and 50 others of a random walk, 100 positions each.
    const shore: ColumnSample[] = [], others: ColumnSample[] = [];
    while (shore.length < 50 || others.length < 50) {
      const cx = Math.floor(rng.nextFloat() * 2048) - 1024, cz = Math.floor(rng.nextFloat() * 2048) - 1024;
      const f = dc.columns.get(cx, cz).f.wetMask;
      const wet = f.some((v) => v === 1), dry = f.some((v) => v === 0);
      if (wet && dry && shore.length < 50) shore.push(filled(dc, cx, cz).s);
      else if (!(wet && dry) && others.length < 50) others.push(filled(dc, cx, cz).s);
    }
    let zero = 0, one = 0, part = 0, n = 0;
    for (const s of [...shore, ...others]) {
      for (let k = 0; k < 100; k++) {
        const x = 16 * s.cx + Math.floor(rng.nextFloat() * 16), z = 16 * s.cz + Math.floor(rng.nextFloat() * 16);
        const y = -64 + Math.floor(rng.nextFloat() * 384);
        const want = ref.voxel(s, x, y, z, wetNode);
        const got = wetAt(s, x, z);
        if (!Object.is(got, want)) expect(got, `(${x}, ${y}, ${z})`).toBe(want);
        n++;
        if (got === 0) zero++;
        else if (got === 1) one++;
        else part++;
      }
    }
    expect(n).toBe(10000);
    expect(zero).toBeGreaterThan(0);
    expect(one).toBeGreaterThan(0);
    expect(part).toBeGreaterThan(0);
  });
});

describe('carvedKind (SP6a spec §3.4; rulings P19, P22)', () => {
  test('carvedKind equals carveColumn\'s tags on every density-solid voxel of 8 columns; the density top only when wet', () => {
    const p = CARVER_DEFAULTS;
    const cache = createCarverCache(ctx, p, 1024);
    let tagged = 0, dryCalls = 0, wetCalls = 0, wetVoxels = 0, unheldCalls = 0;
    const kinds = new Set<number>();
    // Column by column (P22), so carvedKind's column list is rebuilt once per column. (−20, 0) and (−18, 1) lie on a
    // shore of seed 42 with carvers under wet positions (in (−18, 1) σ_w closes most of what the paths hold).
    for (const [cx, cz] of [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [-20, 0], [-18, 1]] as const) {
      const c = filled(dc, cx, cz);
      const { tags } = carved(cache, p, c);
      const window: CarverPath[] = [];
      for (let sz = cz - R; sz <= cz + R; sz++) {
        for (let sx = cx - R; sx <= cx + R; sx++) {
          for (const kind of KINDS) {
            const q = carverPath(ctx.seed, kind, sx, sz, p);
            if (q !== null) window.push(q);
          }
        }
      }
      /** Some ellipsoid of the window holds the voxel (d < 1, before σ and the floor). */
      const held = (x: number, y: number, z: number): boolean => window.some((q) => {
        for (let e = 0; e < q.count; e++) {
          const [ex, ey, ez, rh, rv] = q.ell.subarray(6 * e, 6 * e + 5) as unknown as number[];
          const w = q.widthSq === null ? 1 : q.widthSq[y + 64]!;
          const dx = (x + 0.5 - ex!) / rh!, dz = (z + 0.5 - ez!) / rh!, dy = (y + 0.5 - ey!) / rv!;
          if (dx * dx * w + dz * dz * w + dy * dy < 1) return true;
        }
        return false;
      });
      for (let i = 0; i < 98304; i++) {
        if (c.solid[i] !== 1) continue;
        const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
        const x = 16 * cx + lx, z = 16 * cz + lz;
        const wet = wetAt(c.s, x, z) > 0;
        if (wet) wetVoxels++;
        const got = carvedKind(cache, p, c.s, x, y, z, () => {
          if (wet) wetCalls++;
          else dryCalls++;
          if (!held(x, y, z)) unheldCalls++;
          return c.top[16 * lz + lx]!;
        });
        if (got !== tags[i]) expect(got, `column (${cx}, ${cz}) voxel (${x}, ${y}, ${z})`).toBe(tags[i]);
        if (got !== 0) {
          tagged++;
          kinds.add(got);
        }
      }
    }
    expect(tagged).toBeGreaterThan(0);
    expect(dryCalls, 'densityTopAt called where wet′ = 0').toBe(0);
    expect(wetCalls, 'densityTopAt never called').toBeGreaterThan(0);
    expect(unheldCalls, 'densityTopAt called for a voxel no ellipsoid holds').toBe(0);
    expect(wetCalls).toBeLessThan(wetVoxels);
    expect([...kinds].every((k) => k === CAVE_KIND.worm || k === CAVE_KIND.ravine || k === CAVE_KIND.undergroundWorm)).toBe(true);
  });
});

describe('carverCacheOf and carvedAt (SP6a spec §2.5, §3.4; Task 27)', () => {
  test('carverCacheOf: one cache per GenContext, over carverParamsOf(ctx.params) with capacity 1,024; a new context (a configure) gets a new, empty one', () => {
    const a = ctxFor('42');
    const cache = carverCacheOf(a);
    expect(carverCacheOf(a)).toBe(cache);
    expect(cache.params).toEqual(carverParamsOf(a.params));
    expect(cache.params).toEqual(CARVER_DEFAULTS);
    expect([cache.capacity, CARVER_CACHE_PATHS]).toEqual([1024, 1024]);
    cache.path('worm', 0, 0);
    for (let sx = -3; sx <= 3; sx++) cache.path('worm', sx, 5);
    expect(cache.size).toBeGreaterThan(0);
    // A configure builds a new GenContext (src/workers/taskHandler.ts): its cache is another, empty object.
    const b = ctxFor('42');
    const fresh = carverCacheOf(b);
    expect(fresh).not.toBe(cache);
    expect(fresh.size).toBe(0);
    // Other carver leaves, another cache over them.
    const c = ctxFor('42', { caves: { worms: { chance: 0.3 } } });
    expect(carverCacheOf(c).params.worms.chance).toBe(0.3);
  });

  test('densityTopColumn is densityTopOf at every position, with and without the island rule; it checks its sizes', () => {
    const c = filled(dc, 0, 0);
    for (const islands of [false, true]) {
      const out = new Int16Array(256);
      densityTopColumn(c.solid, islands, out);
      expect(Array.from(out)).toEqual(Array.from(topsOf(c.solid, islands)));
    }
    expect(() => densityTopColumn(new Uint8Array(4096), false, new Int16Array(256))).toThrow(RangeError);
    expect(() => densityTopColumn(c.solid, false, new Int16Array(255))).toThrow(RangeError);
  });

  test('carvedAt equals the T stage\'s carve on every density-solid voxel of 8 columns, an island-over-sea column of floating_islands included', () => {
    const floating = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    const cols: ReadonlyArray<readonly [typeof ctx, number, number]> = [
      [ctx, 546, 25857], [ctx, 4, -10], [ctx, 5, -9], [ctx, 0, 0], [ctx, 3, 0], [ctx, -20, 0], [ctx, -18, 1],
      // Beside test/unit/floatingIslands.test.ts' SEA_CORE: an island over the sea at all 256 positions (wet′ 1; the density
      // top is the sea bed's), with carvers under the bed.
      [floating, 19357, -22223],
    ];
    const kinds = new Set<number>();
    let carved = 0;
    for (const [c, cx, cz] of cols) {
      const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
      const w = store.claimColumn(cx, cz, 0);
      expect(terrainStage(c, cx, cz, w, NEVER)).toBe(true);
      w.commit(1);
      const view = store.proto(cx, cz)!;
      const d = createDensityContext(c);
      const bad: string[] = [];
      let here = 0;
      // Column by column (P22): every voxel of this column before the next.
      for (let y = -63; y <= 319; y++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const x = 16 * cx + lx, z = 16 * cz + lz;
            if (!(probe(d, x, y, z) > 0)) continue;
            const stored = view.cave(lx, y, lz);
            const got = carvedAt(d, x, y, z);
            if (got !== stored) bad.push(`(${x}, ${y}, ${z}): carvedAt ${got} ≠ stored ${stored}`);
            if (got !== 0) { here++; kinds.add(got); }
          }
        }
      }
      expect([cx, cz, bad.slice(0, 5)]).toEqual([cx, cz, []]);
      if (c === floating) {
        expect(here, 'the island-over-sea column carves').toBeGreaterThan(0);
        // Every position holds an island above y 180 over the sea.
        for (let p = 0; p < 256; p++) {
          expect(view.fluid(p & 15, 60, p >> 4)).not.toBe(0);
          let island = false;
          for (let y = 181; y < 320 && !island; y++) island = view.block(p & 15, y, p >> 4) !== 0;
          expect(island).toBe(true);
        }
      }
      carved += here;
    }
    expect(carved).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual([CAVE_KIND.worm, CAVE_KIND.ravine, CAVE_KIND.undergroundWorm].filter((k) => kinds.has(k)).sort());
    expect(kinds.has(CAVE_KIND.worm) && kinds.has(CAVE_KIND.ravine)).toBe(true);
  });

  test('carvedAt\'s density-top memo (ruling R18): probes interleaved over two contexts and two columns, voxel by voxel, answer as a fresh scan of the density top does', () => {
    // Two worlds whose density tops differ at one position and whose wet roof is as deep as it goes (waterDepth 48,
    // bandSpan 32: σ_w reaches 88 blocks under a wet top), so which top a voxel reads changes its answer: floating_islands
    // at seeds 42 and 1, beside its island-over-sea column (wet′ 1, the density top the sea bed's under the island rule).
    const fi = resolveProfile('floating_islands');
    const deep = { ...fi, caves: { ...fi.caves, limits: { ...fi.caves.limits, waterDepth: 48, bandSpan: 32 } } };
    const s42 = createDensityContext(createGenContext(seedFromInput('42'), deep));
    const s1 = createDensityContext(createGenContext(seedFromInput('1'), deep));
    // Interleaved voxel by voxel: one column through both contexts (seed 42 after seed 1, which would read seed 1's tops
    // if the memo ignored the context), and a column two chunks east (which would read the first column's if the memo
    // ignored the column).
    const streams: ReadonlyArray<readonly [DensityContext, number, number]> = [
      [s1, 19356, -22221], [s42, 19356, -22221], [s42, 19358, -22221],
    ];
    /** carvedAt as Task 27 wrote it: the position's top by a fresh downward scan, no memo. */
    const fresh = (d: DensityContext, x: number, y: number, z: number): number => {
      const cx = x >> 4, cz = z >> 4;
      const s = d.column(cx, cz);
      const cache = carverCacheOf(d.ctx);
      const islands = d.ctx.params.islands.enabled;
      return carvedKind(cache, cache.params, s, x, y, z, () => densityTopOf((yy) => d.compiled.voxelFn(x - 16 * cx, yy, z - 16 * cz) > 0, islands));
    };
    // 37 positions (every 7th) keep it fast: the fresh scan reads up to 383 voxels per answer that needs the top.
    const bad: string[] = [];
    const carvedBy = [0, 0, 0];
    for (let y = -63; y <= 140; y++) {
      for (let q = 0; q < 256; q += 7) {
        streams.forEach(([d, cx, cz], k) => {
          const x = 16 * cx + (q & 15), z = 16 * cz + (q >> 4);
          if (!(probe(d, x, y, z) > 0)) return;
          const got = carvedAt(d, x, y, z);
          const want = fresh(d, x, y, z);
          if (got !== want) bad.push(`stream ${k} (${x}, ${y}, ${z}): carvedAt ${got} ≠ fresh ${want}`);
          if (got !== 0) carvedBy[k]!++;
        });
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(carvedBy[1]! > 0 && carvedBy[2]! > 0, `seed 42 carves in both columns: ${carvedBy}`).toBe(true);
    // Down one column (the memo kept), as the test above probes: the same answers again.
    for (let y = -63; y <= 140; y++) {
      for (let q = 0; q < 256; q += 7) {
        const x = 16 * 19356 + (q & 15), z = 16 * -22221 + (q >> 4);
        if (probe(s42, x, y, z) > 0 && carvedAt(s42, x, y, z) !== fresh(s42, x, y, z)) bad.push(`(${x}, ${y}, ${z})`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('a worm from a source 10 chunks away, the LRU and a configure (Review Focus 5; SP6a spec §2.5, §10.3; Task 28)', () => {
  // At the defaults no worm reaches 10 chunks (seed 42: at most 6 chunks over the 973 worm and underground-worm sources
  // of ±40 chunks). With `worms.length` 160 (its static maximum), `lengthVar` 0 and no yaw drift (`shape.yawStep` 0,
  // `shape.yawDriftMul` 0) a worm runs straight for 160 blocks: seed 42's worm of source (0, −1) carves column (10, −2),
  // 10 chunks away, across its border with (9, −2) (x = 160).
  const PATCH = { caves: { worms: { length: 160, lengthVar: 0, shape: { yawStep: 0, yawDriftMul: 0 } } } };
  const params = paramsWith(PATCH);
  const [SX, SZ] = [0, -1] as const;
  const [CX, CZ] = [10, -2] as const;
  const far = createGenContext(seedFromInput('42'), params);
  const p = carverParamsOf(params);
  /** The 3 × 3 region around (CX, CZ), generated once (the default capacity; and at an LRU of 1). */
  let regions: Promise<{ dflt: RegionResult; one: RegionResult }> | null = null;
  const generated = () => (regions ??= (async () => {
    const o: GenRegionOptions = { seed: '42', params, cx0: CX - 1, cz0: CZ - 1, w: 3, h: 3, upTo: 'T', order: 'spiral', threads: 1 };
    return { dflt: await genRegion(o), one: await genRegion({ ...o, carverCacheCapacity: 1 }) };
  })());
  /** Column (cx, cz) generated alone on a fresh store with the context `g`, its regionHash as hex64. */
  const alone = (g: typeof far, cx: number, cz: number): string => {
    const store = createStore({ shared: false });
    expect(fillColumnT(store, g, cx, cz, NEVER)).toBe(true);
    return hex64(regionHash(store, cx, cz, 1, 1));
  };
  /** `cache` without the worm of source (SX, SZ). */
  const withoutSource = (cache: CarverCache): CarverCache => ({
    ...cache, path: (kind, sx, sz) => (kind === 'worm' && sx === SX && sz === SZ ? null : cache.path(kind, sx, sz)),
  });

  test('the column carved by it: in a region, alone on a fresh store (isolatedColumn), after a teleport filled the 1,024-path LRU and after a configure cleared it, and with an LRU of 1: equal region hashes', async () => {
    expect(carverPath(far.seed, 'worm', SX, SZ, p)).not.toBeNull();
    expect(Math.max(Math.abs(CX - SX), Math.abs(CZ - SZ))).toBe(10);
    // The column's carve depends on that source: without it, other voxels are carved.
    const c = filled(createDensityContext(far), CX, CZ);
    const cache = createCarverCache(far, p, 1024);
    expect(firstDiff(carved(cache, p, c).solid, carved(withoutSource(cache), p, c).solid), 'the source carves nothing in the column').not.toBe(-1);

    const { dflt, one } = await generated();
    const want = dflt.view.hash(CX, CZ, 1, 1);
    const isolated = hex64(await isolatedColumn({ seed: '42', params, cx: CX, cz: CZ }));
    // The teleport: the column generated, then every window source of 2,000 columns 20,000 blocks away asked of the same
    // context's cache in the window's order (what T asks of it; no T generation), then the column again on a fresh store.
    const g = createGenContext(seedFromInput('42'), params);
    const before = alone(g, CX, CZ);
    const lru = carverCacheOf(g);
    const held = lru.path('worm', SX, SZ);
    expect(held).not.toBeNull();
    for (let cz = 1250; cz < 1300; cz++) {
      for (let cx = 1250; cx < 1290; cx++) {
        for (let sz = cz - R; sz <= cz + R; sz++) for (let sx = cx - R; sx <= cx + R; sx++) for (const kind of KINDS) lru.path(kind, sx, sz);
      }
    }
    expect(lru.size).toBe(CARVER_CACHE_PATHS);
    expect(lru.path('worm', SX, SZ), 'the source\'s path left the LRU (rebuilt)').not.toBe(held);
    const back = alone(g, CX, CZ);
    // A configure builds a new GenContext: its cache starts empty.
    const configured = createGenContext(seedFromInput('42'), params);
    expect(carverCacheOf(configured).size).toBe(0);
    const afterConfigure = alone(configured, CX, CZ);
    const isolatedOne = hex64(await isolatedColumn({ seed: '42', params, cx: CX, cz: CZ, carverCacheCapacity: 1 }));
    expect({ isolated, before, back, afterConfigure, isolatedOne, regionOne: one.view.hash(CX, CZ, 1, 1) }).toEqual({
      isolated: want, before: want, back: want, afterConfigure: want, isolatedOne: want, regionOne: want,
    });
    expect(one.carverCacheSizes).toEqual([1]);
    expect(one.view.hash()).toBe(dflt.view.hash());
  });

  test('the two columns either side of the worm\'s chunk border carve and store what the global reference referenceCarve carves (Task 30; ruling P20)', async () => {
    const d = createDensityContext(far);
    const cols = [filled(d, CX - 1, CZ), filled(d, CX, CZ)] as const;
    const cache = createCarverCache(far, p, 1024);
    const { dflt } = await generated();
    // The global reference over the 3 × 3 region around (CX, CZ): every path whose box meets it, no per-column window.
    const ref = referenceCarve(dflt.view, '42', params);
    const W = 16 * dflt.view.w, D = 16 * dflt.view.h;
    const refAt = (x: number, y: number, z: number): number => ref[((y + 64) * D + (z - 16 * dflt.view.cz0)) * W + (x - 16 * dflt.view.cx0)]!;
    let border = 0;
    const fromSource = [0, 0];
    cols.forEach((c, k) => {
      const got = carved(cache, p, c);
      // carveColumn's tags (its carver kinds) are the reference's over the whole column.
      let diff = -1;
      for (let y = -64; y <= 319 && diff < 0; y++) {
        for (let lz = 0; lz < 16 && diff < 0; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            if (got.tags[idx(lx, y, lz)] !== refAt(16 * c.cx + lx, y, 16 * c.cz + lz)) {
              diff = idx(lx, y, lz);
              break;
            }
          }
        }
      }
      expect(diff, `column (${c.cx}, ${c.cz}) tags against referenceCarve`).toBe(-1);
      const without = carved(withoutSource(cache), p, c);
      const view = dflt.view.store.proto(c.cx, c.cz)!;
      // The voxels next to the border x = 16·CX: lx 15 of the west column, lx 0 of the east one.
      const lx = k === 0 ? 15 : 0;
      for (let y = -63; y <= 319; y++) {
        for (let lz = 0; lz < 16; lz++) {
          const v = idx(lx, y, lz);
          if (c.solid[v] !== 1) continue;
          border++;
          // The region's T stage stored the reference's kind (a density-solid voxel's tag is its carver's, or 0).
          const want = refAt(16 * c.cx + lx, y, 16 * c.cz + lz);
          if (view.cave(lx, y, lz) !== want) expect(view.cave(lx, y, lz), `stored tag at (${16 * c.cx + lx}, ${y}, ${16 * c.cz + lz})`).toBe(want);
          if (without.solid[v] !== got.solid[v]) fromSource[k]!++;
        }
      }
    });
    expect(border).toBeGreaterThan(0);
    expect(fromSource.every((n) => n > 0), `the worm carves next to the border on both sides: ${fromSource}`).toBe(true);
  });
});

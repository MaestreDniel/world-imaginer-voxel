/**
 * The SP3e goldens (SP3e spec §6, D14): five keys chained last into `allGoldenKeys`, the frozen preset windows (the
 * search re-run on the approved values still finds them), what the windows show (the floating window holds an island
 * run over water, archipelago's holds sea and land, amplified's review line climbs above y 250), and the observer
 * that records the keys through `expectGolden`.
 */
import { describe, expect, test } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { pointDigest } from '../../src/metrics/pointDigest';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import {
  computeSp3eGolden, presetWindow, sp3eGoldenKeys, sp3eRegionDigest, sp3eWindow, WINDOW_PRESETS, type Sp3ePreset,
} from '../../src/metrics/sp3eGoldens';
import { fluidType } from '../../src/world/blocks/fluid';
import { COLLIDE } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { expectGolden } from '../harness/goldens';
import { presetReviewSite } from '../harness/reviewSlices';

const ctxOf = (p: Sp3ePreset) => createGenContext(seedFromInput('42'), resolveProfile(p));
const newStore = (shared: boolean): VoxelStore => createStore({ shared, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });

/** The preset's frozen 8 × 8 window generated in process on a store (`shared` as the caller asks). */
function windowStore(p: Sp3ePreset, shared: boolean): VoxelStore {
  const w = sp3eWindow(p);
  const store = newStore(shared);
  genRegionInProcess(store, ctxOf(p), w.chunkX, w.chunkZ, 8, 8);
  return store;
}

/** Every column view of the preset's window in `store`. */
function windowViews(p: Sp3ePreset, store: VoxelStore): ColumnView[] {
  const w = sp3eWindow(p);
  const out: ColumnView[] = [];
  for (let cz = w.chunkZ; cz < w.chunkZ + 8; cz++) {
    for (let cx = w.chunkX; cx < w.chunkX + 8; cx++) out.push(store.proto(cx, cz)!);
  }
  return out;
}

test('5 unique SP3e keys, in the spec\'s order, chained last into allGoldenKeys: 59 goldens', () => {
  const keys = sp3eGoldenKeys();
  expect(keys).toEqual([
    'sp3e.region.T.amplified', 'sp3e.region.T.archipelago', 'sp3e.region.T.floating_islands',
    'sp3e.column.point.archipelago', 'sp3e.column.point.floating_islands',
  ]);
  expect(allGoldenKeys().slice(-5)).toEqual(keys);
  expect(allGoldenKeys().slice(-7, -5)).toEqual(['sp3c.registry', 'sp3c.surface.ops']);
  expect(allGoldenKeys()).toHaveLength(59);
  expect(new Set(allGoldenKeys()).size).toBe(59);
});

test('unknown SP3e keys throw, directly and through computeAnyGolden', () => {
  for (const bad of [
    'sp3e.region.T.default', 'sp3e.column.point.amplified', 'sp3e.column.point.default', 'sp3e.region.T.large_biomes',
    'sp3e.region.T', 'sp3e.region.T.toString', 'sp3e.column.point', 'sp3e.region.D.amplified', 'sp3e.nope',
  ]) {
    expect(() => computeSp3eGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

test('computeAnyGolden routes sp3e.* to computeSp3eGolden', () => {
  expect(computeAnyGolden('sp3e.region.T.amplified')).toBe(sp3eRegionDigest('amplified'));
});

describe('the frozen windows (seed 42, the approved values)', () => {
  test('literal: archipelago w(1, −1), amplified w(−5, 0), floating_islands w(−6, −11), with chunk origins and centres', () => {
    expect(sp3eWindow('archipelago')).toEqual({ a: 1, b: -1, chunkX: 4, chunkZ: -12, centreX: 128, centreZ: -128 });
    expect(sp3eWindow('amplified')).toEqual({ a: -5, b: 0, chunkX: -44, chunkZ: -4, centreX: -640, centreZ: 0 });
    expect(sp3eWindow('floating_islands')).toEqual({ a: -6, b: -11, chunkX: -52, chunkZ: -92, centreX: -768, centreZ: -1408 });
  });

  test.each(WINDOW_PRESETS)('%s: the window search re-run equals the committed window', (p) => {
    expect(presetWindow(p)).toEqual(sp3eWindow(p));
  });

  test('another profile has no window', () => {
    for (const bad of ['default', 'large_biomes', 'cave_heavy', 'toString']) {
      expect(() => sp3eWindow(bad as Sp3ePreset)).toThrow(RangeError);
    }
  });
});

describe('what the windows show', () => {
  test('floating_islands: the window holds island runs (bottom ≥ ISLAND_RUN_MIN_BOTTOM) with water below them', () => {
    const store = windowStore('floating_islands', true);
    // The region digest does not depend on the store kind.
    const w = sp3eWindow('floating_islands');
    expect(hex64(regionHash(store, w.chunkX, w.chunkZ, 8, 8))).toBe(sp3eRegionDigest('floating_islands'));
    let islandOverWater = 0;
    for (const v of windowViews('floating_islands', store)) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          let y = 319;
          while (y >= -64 && COLLIDE[v.block(lx, y, lz)] === 0) y--;
          if (y < -64) continue;
          while (y > -64 && COLLIDE[v.block(lx, y - 1, lz)] !== 0) y--;
          // y is the bottom voxel of the position's highest solid run.
          if (y < ISLAND_RUN_MIN_BOTTOM) continue;
          for (let yy = y - 1; yy >= -64; yy--) {
            if (fluidType(v.fluid(lx, yy, lz)) !== 0) { islandOverWater++; break; }
          }
        }
      }
    }
    expect(islandOverWater).toBeGreaterThan(0);
  }, 60_000);

  test('archipelago: the window holds sea and land positions', () => {
    const store = windowStore('archipelago', false);
    let sea = 0;
    let land = 0;
    for (const v of windowViews('archipelago', store)) {
      const a = v.aux()!;
      for (let p = 0; p < 256; p++) {
        if (a.worldSurfaceWG[p]! > a.oceanFloorWG[p]!) sea++;
        else land++;
      }
    }
    expect(sea).toBeGreaterThan(0);
    expect(land).toBeGreaterThan(0);
  }, 60_000);

  test('amplified: the highest land top on its review line (Task 14\'s site at the window centre) is ≥ 250', () => {
    const w = sp3eWindow('amplified');
    const site = presetReviewSite('amplified', { x: w.centreX, z: w.centreZ });
    const ctx = ctxOf('amplified');
    const store = newStore(false);
    const cz = site.z >> 4;
    const lz = site.z & 15;
    let maxLandTop = -Infinity;
    for (let cx = site.cx0; cx < site.cx0 + site.w; cx++) {
      genRegionInProcess(store, ctx, cx, cz, 1, 1);
      const a = store.proto(cx, cz)!.aux()!;
      for (let lx = 0; lx < 16; lx++) {
        const p = lz * 16 + lx;
        if (a.worldSurfaceWG[p] === a.oceanFloorWG[p]) maxLandTop = Math.max(maxLandTop, a.oceanFloorWG[p]! - 1);
      }
      store.freeColumn(cx, cz);
    }
    expect(maxLandTop).toBeGreaterThanOrEqual(250);
  }, 60_000);
});

test('the column-point keys are pointDigest on the preset (moved unchanged from sp2aGoldens.ts)', () => {
  expect(computeSp3eGolden('sp3e.column.point.archipelago')).toBe(pointDigest('archipelago'));
});

describe('SP3e goldens', () => {
  test.each(sp3eGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp3eGolden(key));
  }, 60_000);
});

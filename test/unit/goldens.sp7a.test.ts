/**
 * The SP7a goldens (SP7a spec §15.3, D33), chained last into `allGoldenKeys` after SP6b's. The generator push adds
 * `sp7a.aquifer.points` (Task 14: the aquifer's point functions `fluidAt` and `barrierAt` at 256 fixed 3D points,
 * recomputed here from the module comment), `sp7a.springs` (Task 21: the springs of 16 fixed chunks per kind,
 * recomputed here from the module comment) and `sp7a.region.D.water` (Task 32: the final fluid of the 6 × 6 interior of
 * DT1's first settle window, its literal pinned to `SETTLE_WINDOWS[0]` and its hash recomputed here over the region
 * harness's D). The keys match `test/goldens.json`.
 */
import { describe, expect, test } from 'vitest';
import { fnv1a32, fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { aquiferOf, barrierAt, fluidAt } from '../../src/gen/fluids/aquifer';
import { finalFluidHash, genRegionDInProcess } from '../../src/metrics/region';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import {
  aquiferPoints, aquiferPointsDigest, computeSp7aGolden, ISLAND_CHUNKS, LAVA_CHUNKS, SETTLE_WINDOW_GOLDEN, settleWindowWaterDigest,
  springsDigest, sp7aGoldenKeys, WATER_CHUNKS,
} from '../../src/metrics/sp7aGoldens';
import { createStore } from '../../src/world/store/store';
import { expectGolden } from '../harness/goldens';
import { genRegion } from '../harness/region';
import { SETTLE_WINDOWS } from '../harness/settleWindows';
import { settleWindowAt } from '../harness/windowScans';

test('3 SP7a keys, chained last into allGoldenKeys after SP6b\'s: 68 goldens', () => {
  const keys = ['sp7a.aquifer.points', 'sp7a.springs', 'sp7a.region.D.water'];
  expect(sp7aGoldenKeys()).toEqual(keys);
  expect(allGoldenKeys().slice(-3)).toEqual(keys);
  expect(allGoldenKeys().slice(-6, -3)).toEqual(['sp6b.registry', 'sp6b.caveBiome.points', 'sp6b.region.T.biomes']);
  expect(allGoldenKeys()).toHaveLength(68);
  expect(new Set(allGoldenKeys()).size).toBe(68);
  for (const bad of [
    'sp7a.aquifer', 'sp7a.aquifer.points.x', 'sp7a.springs.x', 'sp7a.region.D', 'sp7a.region.D.water.x', 'sp7a.region.T.water', 'sp7a.nope',
  ]) {
    expect(() => computeSp7aGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp7a.aquifer.points (§15.3, Task 14)', () => {
  /** The 256 points, written from the module comment: x, z = −4096 + nextInt(8193), y = −63 + nextInt(184), in that order. */
  const points = (): Array<[number, number, number]> => {
    const r = new Xoshiro128(fnv1a32('sp7a.aquifer.points'));
    return Array.from({ length: 256 }, () => {
      const x = -4096 + r.nextInt(8193);
      const z = -4096 + r.nextInt(8193);
      const y = -63 + r.nextInt(184);
      return [x, y, z];
    });
  };

  test('256 points drawn from Xoshiro128(fnv1a32(\'sp7a.aquifer.points\')) within ±4,096 blocks, y −63 … 120', () => {
    const p = aquiferPoints();
    expect(p).toEqual(points());
    expect(p).toHaveLength(256);
    for (const [x, y, z] of p) {
      expect(Math.abs(x) <= 4096 && Math.abs(z) <= 4096 && y >= -63 && y <= 120, `(${x}, ${y}, ${z})`).toBe(true);
    }
  });

  test('is the FNV-1a 64 of the fluidAt byte and the barrierAt bit at the 256 points in draw order, two bytes each (seed \'42\', default profile)', () => {
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('default'));
    const aq = aquiferOf(ctx);
    const dc = createDensityContext(ctx);
    const bytes: number[] = [];
    for (const [x, y, z] of points()) bytes.push(fluidAt(aq, dc, x, y, z), barrierAt(aq, dc, x, y, z) ? 1 : 0);
    expect(aquiferPointsDigest()).toBe(hex64(fnv1a64Bytes(Uint8Array.from(bytes))));
    expect(computeSp7aGolden('sp7a.aquifer.points')).toBe(aquiferPointsDigest());
    expect(computeAnyGolden('sp7a.aquifer.points')).toBe(aquiferPointsDigest());
    // The points reach water and dry voxels, tagged and untagged (measured: 102 in air, 11 of them tagged; 21 water, 2 of
    // them tagged). No point is a barrier (barriers lie in tagged air only), so the bits are all 0 at these points; DT2's
    // `probeBulk` and `tagProbe` check `barrierAt` against T on its columns.
    const fluids = bytes.filter((_, i) => i % 2 === 0);
    expect(fluids.some((f) => f !== 0)).toBe(true);
    expect(fluids.some((f) => f === 0)).toBe(true);
  }, 60_000);
});

describe('sp7a.springs (§3, §15.3, Task 21)', () => {
  const LISTS = [['default', 'water', WATER_CHUNKS, 0], ['floating_islands', 'island', ISLAND_CHUNKS, 1], ['default', 'lava', LAVA_CHUNKS, 2]] as const;

  test('16 fixed chunks per kind; each chunk list holds at least one spring of its kind (every chunk does: the scan took chunks holding one)', () => {
    const list = newSpringList();
    for (const [profile, kind, chunks, byte] of LISTS) {
      expect([kind, chunks.length, new Set(chunks.map(([cx, cz]) => `${cx},${cz}`)).size]).toEqual([kind, 16, 16]);
      const ctx = createGenContext(seedFromInput('42'), resolveProfile(profile));
      let ofKind = 0;
      for (const [cx, cz] of chunks) {
        terrainSpringsDebug(ctx, cx, cz, list);
        const n = Array.from(list.kind.subarray(0, list.n)).filter((k) => k === byte).length;
        expect([kind, cx, cz, n > 0]).toEqual([kind, cx, cz, true]);
        ofKind += n;
      }
      expect(ofKind, kind).toBeGreaterThan(0);
    }
  }, 120_000);

  test('is the FNV-1a 64 of each chunk\'s spring count, then per spring its world x, y, z (int32 LE), kind and direction, over the water, island and lava lists in order', () => {
    const bytes: number[] = [];
    const list = newSpringList();
    for (const [profile, , chunks] of LISTS) {
      const ctx = createGenContext(seedFromInput('42'), resolveProfile(profile));
      for (const [cx, cz] of chunks) {
        terrainSpringsDebug(ctx, cx, cz, list);
        bytes.push(list.n);
        for (let k = 0; k < list.n; k++) {
          const j = list.pos[k]!;
          const w = new DataView(new ArrayBuffer(12));
          w.setInt32(0, 16 * cx + (j & 15), true);
          w.setInt32(4, (j >> 8) - 64, true);
          w.setInt32(8, 16 * cz + ((j >> 4) & 15), true);
          bytes.push(...new Uint8Array(w.buffer), list.kind[k]!, list.dir[k]!);
        }
      }
    }
    expect(springsDigest()).toBe(hex64(fnv1a64Bytes(Uint8Array.from(bytes))));
    expect(computeSp7aGolden('sp7a.springs')).toBe(springsDigest());
    expect(computeAnyGolden('sp7a.springs')).toBe(springsDigest());
  }, 120_000);
});

describe('sp7a.region.D.water (§13.4, §15.3, Task 32)', () => {
  test('SETTLE_WINDOW_GOLDEN mirrors SETTLE_WINDOWS[0] (the coast window holding a water spring): candidate S(a, b), its 6 × 6 interior at chunk (6a, 6b)', () => {
    const w = SETTLE_WINDOWS[0]!;
    expect(w.feature).toBe('coast');
    expect(SETTLE_WINDOW_GOLDEN).toEqual({ a: w.a, b: w.b });
    // `settleWindowAt`'s 10 × 10 region keeps two rings around the interior the golden hashes.
    const r = settleWindowAt(w.a, w.b);
    expect([r.cx0 + 2, r.cz0 + 2, r.size - 4]).toEqual([6 * SETTLE_WINDOW_GOLDEN.a, 6 * SETTLE_WINDOW_GOLDEN.b, 6]);
  });

  test('is the FNV-1a 64 of the interior\'s final fluid (cz outer, cx inner; per column its 24 sections\' 4096 fluid bytes, uniform sections expanded), each column decorated from its own 3 × 3 (the region harness\'s D, spiral order)', async () => {
    const [cx0, cz0] = [6 * SETTLE_WINDOW_GOLDEN.a, 6 * SETTLE_WINDOW_GOLDEN.b];
    const { view } = await genRegion({ seed: '42', params: resolveProfile('default'), cx0, cz0, w: 6, h: 6, upTo: 'D', order: 'spiral', threads: 1 });
    const parts: Uint8Array[] = [];
    let settled = 0;
    for (let cz = cz0; cz < cz0 + 6; cz++) {
      for (let cx = cx0; cx < cx0 + 6; cx++) {
        const fin = view.store.final(cx, cz)!;
        const proto = view.store.proto(cx, cz)!;
        for (let sy = 0; sy < 24; sy++) {
          const f = fin.sectionFluid(sy);
          const bytes = typeof f === 'number' ? new Uint8Array(4096).fill(f) : f.slice();
          const p = proto.sectionFluid(sy);
          for (let i = 0; i < 4096; i++) if (bytes[i] !== (typeof p === 'number' ? p : p[i]!)) settled++;
          parts.push(bytes);
        }
      }
    }
    const all = new Uint8Array(parts.length * 4096);
    parts.forEach((p, i) => all.set(p, 4096 * i));
    expect(settleWindowWaterDigest()).toBe(hex64(fnv1a64Bytes(all)));
    expect(computeSp7aGolden('sp7a.region.D.water')).toBe(settleWindowWaterDigest());
    expect(computeAnyGolden('sp7a.region.D.water')).toBe(settleWindowWaterDigest());
    // The hash covers the settle: the interior's final fluid differs from its proto (measured at Task 32: 650 voxels).
    expect(settled).toBeGreaterThan(0);
  }, 120_000);

  test('genRegionDInProcess needs an interior (w and h at least 3); finalFluidHash throws on a column below Decorated', () => {
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('default'));
    expect(() => genRegionDInProcess(createStore({ shared: false }), ctx, 0, 0, 2, 6)).toThrow(/has no interior/);
    expect(() => genRegionDInProcess(createStore({ shared: false }), ctx, 0, 0, 6, 2)).toThrow(/has no interior/);
    const store = createStore({ shared: false });
    genRegionDInProcess(store, ctx, 0, 0, 3, 3);
    expect(finalFluidHash(store, 1, 1, 1, 1)).toEqual(finalFluidHash(store, 1, 1, 1, 1));
    expect(() => finalFluidHash(store, 0, 0, 2, 2)).toThrow(/column \(0, 0\) has no final set/);
  }, 60_000);
});

describe('SP7a goldens', () => {
  test.each(sp7aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp7aGolden(key));
  }, 60_000);
});

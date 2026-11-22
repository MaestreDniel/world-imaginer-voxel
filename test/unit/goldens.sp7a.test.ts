/**
 * The SP7a goldens (SP7a spec §15.3, D33), chained last into `allGoldenKeys` after SP6b's. The generator push adds
 * `sp7a.aquifer.points` (Task 14: the aquifer's point functions `fluidAt` and `barrierAt` at 256 fixed 3D points,
 * recomputed here from the module comment) and `sp7a.springs` (Task 21: the springs of 16 fixed chunks per kind,
 * recomputed here from the module comment); `sp7a.region.D.water` (Task 32) follows. The keys match `test/goldens.json`.
 */
import { describe, expect, test } from 'vitest';
import { fnv1a32, fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { aquiferOf, barrierAt, fluidAt } from '../../src/gen/fluids/aquifer';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import {
  aquiferPoints, aquiferPointsDigest, computeSp7aGolden, ISLAND_CHUNKS, LAVA_CHUNKS, springsDigest, sp7aGoldenKeys, WATER_CHUNKS,
} from '../../src/metrics/sp7aGoldens';
import { expectGolden } from '../harness/goldens';

test('2 SP7a keys, chained last into allGoldenKeys after SP6b\'s: 67 goldens', () => {
  const keys = ['sp7a.aquifer.points', 'sp7a.springs'];
  expect(sp7aGoldenKeys()).toEqual(keys);
  expect(allGoldenKeys().slice(-2)).toEqual(keys);
  expect(allGoldenKeys().slice(-5, -2)).toEqual(['sp6b.registry', 'sp6b.caveBiome.points', 'sp6b.region.T.biomes']);
  expect(allGoldenKeys()).toHaveLength(67);
  expect(new Set(allGoldenKeys()).size).toBe(67);
  for (const bad of ['sp7a.aquifer', 'sp7a.aquifer.points.x', 'sp7a.springs.x', 'sp7a.region.D.water', 'sp7a.nope']) {
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

describe('SP7a goldens', () => {
  test.each(sp7aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp7aGolden(key));
  }, 60_000);
});

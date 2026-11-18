/**
 * The SP7a goldens (SP7a spec §15.3, D33), chained last into `allGoldenKeys` after SP6b's. The generator push adds
 * `sp7a.aquifer.points` (Task 14: the aquifer's point functions `fluidAt` and `barrierAt` at 256 fixed 3D points,
 * recomputed here from the module comment); `sp7a.springs` (Task 21) and `sp7a.region.D.water` (Task 32) follow. The keys
 * match `test/goldens.json`.
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
import { aquiferPoints, aquiferPointsDigest, computeSp7aGolden, sp7aGoldenKeys } from '../../src/metrics/sp7aGoldens';
import { expectGolden } from '../harness/goldens';

test('1 SP7a key, chained last into allGoldenKeys after SP6b\'s: 66 goldens', () => {
  const keys = ['sp7a.aquifer.points'];
  expect(sp7aGoldenKeys()).toEqual(keys);
  expect(allGoldenKeys().slice(-1)).toEqual(keys);
  expect(allGoldenKeys().slice(-4, -1)).toEqual(['sp6b.registry', 'sp6b.caveBiome.points', 'sp6b.region.T.biomes']);
  expect(allGoldenKeys()).toHaveLength(66);
  expect(new Set(allGoldenKeys()).size).toBe(66);
  for (const bad of ['sp7a.aquifer', 'sp7a.aquifer.points.x', 'sp7a.springs', 'sp7a.region.D.water', 'sp7a.nope']) {
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

describe('SP7a goldens', () => {
  test.each(sp7aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp7aGolden(key));
  }, 60_000);
});

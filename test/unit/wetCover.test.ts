/**
 * SP6a Task 9 (spec §1.4, D7, D19), re-written for SP7a D24 (its spec §2, Task 15): the `wetCover` scan. The wet roof's
 * steep part S_w = 128·h_w is added at voxel level with wet′ = clamp(4·wetMask, 0, 1) read at the position (the bilinear
 * `col` readout). Since SP7a the roof is the lake roof: `wetMask` is the finite 0/1 `col` field that is 1 inside a lake
 * mask (`lakeMask` 1 with a finite `lakeLevel`) and 0 elsewhere, the sea and rivers included, so caves open under the sea
 * and rivers. Every lake position (its nearest quart corner, `readLevel`, inside the mask) has wet′ = 1 by construction
 * (the readout at a voxel's quart offsets t ∈ {0, ¼, ½, ¾} is exact and the nearest corner's weight is ≥ ¼); every sea
 * or river position (⌊`surfaceWaterLevel`⌋ at its nearest corner ≥ y −64, D19's untagged rule) whose four readout corners
 * all lie outside a lake mask has wet′ = 0. The test checks both over 100,352 positions of the quick tier's seeds 42 and 1
 * on default and archipelago: in each (seed, profile), the first 98 shore columns (chunk columns whose 25 quart corners
 * hold both a wet and a dry corner) of `samplePoints('sp6a.wetCover', 65536)`, 256 positions each. A miss is a defect,
 * never relaxed.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { COL_FIELD_BOUNDS } from '../../src/core/constants';
import { columnPoint, newPointRecord, sampleCoarse, wetMaskOf } from '../../src/gen/column/columnPoint';
import { latticeIndex, readLevel, SAMPLE_FIELDS } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import type { DensityExpr } from '../../src/gen/density/expr';
import { resolveDensity, validateDensitySource } from '../../src/gen/density/source';
import { samplePoints } from '../../src/metrics/noiseStats';

type Rec = Record<string, unknown>;
const at = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n as Rec)[k], v);

/** wet′ in the default tree: S_w = `defs.steep.a` = mul(128, mul(wet′, clamp(…))) (SP6a §1.4; `defs.steep` = S_w + S_b, SP6b §5.2). */
const WET_PATH = 'defs.steep.a.b.a';
const SHORE_COLUMNS = 98;
const DRAWS = 65536;

describe('wetCover (SP6a spec §1.4; the lake roof, SP7a D24)', () => {
  test('wet′ in the default tree is clamp(4·wetMask, 0, 1), read once by S_w at voxel level', () => {
    expect(at(DEFAULT_DENSITY_TREE, WET_PATH)).toEqual({
      op: 'clamp', lo: 0, hi: 1, x: { op: 'mul', a: { op: 'const', v: 4 }, b: { op: 'col', field: 'wetMask' } },
    });
  });

  test('wetMask is a finite col field, 1 exactly inside a lake mask: 0 at sea and on rivers (SP7a D24)', () => {
    expect(SAMPLE_FIELDS.at(-1)).toBe('wetMask');
    expect(COL_FIELD_BOUNDS.wetMask).toEqual([0, 1]);
    expect([wetMaskOf(1, 63), wetMaskOf(1, -12), wetMaskOf(1, -Infinity), wetMaskOf(0.5, -Infinity), wetMaskOf(0, -Infinity)]).toEqual([1, 1, 0, 0, 0]);
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('default'));
    const pts = samplePoints('sp6a.wetMask', 512);
    let lake = 0;
    let seaOrRiver = 0;
    for (let n = 0; n < 512; n++) {
      const p = columnPoint(ctx, Math.floor(pts.x[n]!), Math.floor(pts.z[n]!));
      const inLake = p.lakeMask === 1 && Number.isFinite(p.lakeLevel);
      expect(p.wetMask).toBe(inLake ? 1 : 0);
      if (inLake) lake++;
      else if (Number.isFinite(p.surfaceWaterLevel)) seaOrRiver++;
      // The coarse point has no lake (SP2a spec §6.1), so its mask is 0.
      expect(sampleCoarse(ctx, p.x, p.z, newPointRecord()).wetMask).toBe(0);
    }
    // About 40 % of the default world lies under the sea or a river, which the lake roof no longer covers.
    expect(seaOrRiver).toBeGreaterThan(50);
    expect(lake).toBeLessThan(seaOrRiver);
  });

  test('every lake position has wet′ = 1; sea and river positions outside lakes have wet′ = 0 (100,352 positions, seeds 42 and 1, default and archipelago)', () => {
    const wetTree = { root: at(DEFAULT_DENSITY_TREE, WET_PATH), defs: {} };
    expect(validateDensitySource(wetTree)).toEqual([]);
    let positions = 0;
    let lakes = 0;
    let open = 0;
    const misses: string[] = [];
    const figures: string[] = [];
    for (const seed of ['42', '1']) {
      for (const profile of ['default', 'archipelago'] as const satisfies readonly ProfileId[]) {
        const ctx = createGenContext(seedFromInput(seed), resolveProfile(profile));
        const dc = createDensityContext(ctx, resolveDensity(wetTree, ctx.params) as DensityExpr);
        const pts = samplePoints('sp6a.wetCover', DRAWS);
        let columns = 0;
        let draws = 0;
        let lakeHere = 0;
        let openHere = 0;
        for (let n = 0; n < DRAWS && columns < SHORE_COLUMNS; n++) {
          draws++;
          const cx = Math.floor(pts.x[n]! / 16), cz = Math.floor(pts.z[n]! / 16);
          const s = dc.column(cx, cz);
          let wetCorners = 0;
          let dryCorners = 0;
          for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
            if (Number.isFinite(s.f.surfaceWaterLevel[latticeIndex(i, j)]!)) wetCorners++; else dryCorners++;
          }
          if (wetCorners === 0 || dryCorners === 0) continue;
          columns++;
          // The lattice (with its halo): the mask is the lake's, bit for bit.
          const inLake = (k: number): boolean => s.f.lakeMask[k] === 1 && Number.isFinite(s.f.lakeLevel[k]!);
          for (let k = 0; k < 49; k++) {
            if (!Object.is(s.f.wetMask[k], inLake(k) ? 1 : 0)) throw new Error(`(${cx}, ${cz}) lattice ${k}: wetMask ${s.f.wetMask[k]}`);
          }
          for (let p = 0; p < 256; p++) {
            positions++;
            const lx = p & 15, lz = p >> 4;
            const x = 16 * cx + lx, z = 16 * cz + lz;
            // y is irrelevant to a `col`-only subtree; 0 is any voxel of the column.
            const v = dc.compiled.voxelFn(lx, 0, lz);
            if (Number.isFinite(readLevel(s, 'lakeLevel', x, z))) {
              // A lake position: its nearest corner lies inside the mask.
              lakes++;
              lakeHere++;
              if (!Object.is(v, 1) && misses.length < 32) misses.push(`${seed}/${profile} lake (${x}, ${z}): wet′ ${v}`);
              continue;
            }
            // D19: untagged air takes water iff y ≤ ⌊surfaceWaterLevel⌋ at the nearest quart corner (−∞ on land).
            if (!(Math.floor(readLevel(s, 'surfaceWaterLevel', x, z)) >= -64)) continue;
            // A sea or river position outside lakes: none of the four corners its readout weighs is in a lake mask.
            const k = latticeIndex(lx >> 2, lz >> 2);
            if (inLake(k) || inLake(k + 1) || inLake(k + 7) || inLake(k + 8)) continue;
            open++;
            openHere++;
            if (!Object.is(v, 0) && misses.length < 32) misses.push(`${seed}/${profile} sea or river (${x}, ${z}): wet′ ${v}`);
          }
        }
        expect([seed, profile, columns]).toEqual([seed, profile, SHORE_COLUMNS]);
        figures.push(`${seed}/${profile}: ${columns} shore columns in ${draws} draws, ${lakeHere} lake and ${openHere} sea or river positions`);
      }
    }
    console.log(`wetCover: ${positions} positions, ${lakes} lake, ${open} sea or river; ${figures.join('; ')}`);
    expect(positions).toBe(4 * SHORE_COLUMNS * 256);
    expect(open).toBeGreaterThan(30000);
    expect(lakes).toBeGreaterThan(1000);
    expect(misses).toEqual([]);
  }, 300_000);
});

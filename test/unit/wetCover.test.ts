/**
 * SP6a Task 9 (spec §1.4, D7, D19): the `wetCover` scan. The wet roof's steep part S_w = 128·h_w is added at voxel level
 * with wet′ = clamp(4·wetMask, 0, 1) read at the position (the bilinear `col` readout), so wet′ must be 1, bit for bit,
 * at every position water v0 fills: every position whose water v0 `waterTop` (read at its nearest quart corner,
 * `columnWaterV0`) is ≥ y −64. `wetMask` is the finite 0/1 `col` field that is 1 where `surfaceWaterLevel` is finite, so
 * the scan holds by construction (the readout at a voxel's quart offsets t ∈ {0, ¼, ½, ¾} is exact and the nearest
 * corner's weight is ≥ ¼); the test checks it over 100,352 positions of the quick tier's seeds 42 and 1 on default and
 * archipelago: in each (seed, profile), the first 98 shore columns (chunk columns whose 25 quart corners hold both a wet
 * and a dry corner) of `samplePoints('sp6a.wetCover', 65536)`, 256 positions each. A miss is a defect, never relaxed.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { COL_FIELD_BOUNDS } from '../../src/core/constants';
import { columnPoint, newPointRecord, sampleCoarse, wetMaskOf } from '../../src/gen/column/columnPoint';
import { latticeIndex, SAMPLE_FIELDS } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import type { DensityExpr } from '../../src/gen/density/expr';
import { resolveDensity, validateDensitySource } from '../../src/gen/density/source';
import { columnWaterV0 } from '../../src/gen/pipeline/terrainStage';
import { samplePoints } from '../../src/metrics/noiseStats';

type Rec = Record<string, unknown>;
const at = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n as Rec)[k], v);

/** wet′ in the default tree: `defs.wetSteep` = mul(128, mul(wet′, clamp(…))) (SP6a §1.4). */
const WET_PATH = 'defs.wetSteep.b.a';
const SHORE_COLUMNS = 98;
const DRAWS = 65536;

describe('wetCover (SP6a spec §1.4)', () => {
  test('wet′ in the default tree is clamp(4·wetMask, 0, 1), read once by S_w at voxel level', () => {
    expect(at(DEFAULT_DENSITY_TREE, WET_PATH)).toEqual({
      op: 'clamp', lo: 0, hi: 1, x: { op: 'mul', a: { op: 'const', v: 4 }, b: { op: 'col', field: 'wetMask' } },
    });
  });

  test('wetMask is a finite col field, 1 exactly where surfaceWaterLevel is finite (SP6a D19, ruling R8)', () => {
    expect(SAMPLE_FIELDS.at(-1)).toBe('wetMask');
    expect(COL_FIELD_BOUNDS.wetMask).toEqual([0, 1]);
    expect([wetMaskOf(63), wetMaskOf(-12.5), wetMaskOf(-Infinity)]).toEqual([1, 1, 0]);
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('default'));
    const pts = samplePoints('sp6a.wetMask', 512);
    let wet = 0;
    for (let n = 0; n < 512; n++) {
      const p = columnPoint(ctx, Math.floor(pts.x[n]!), Math.floor(pts.z[n]!));
      expect([p.wetMask, Number.isFinite(p.surfaceWaterLevel)]).toEqual([Number.isFinite(p.surfaceWaterLevel) ? 1 : 0, p.wetMask === 1]);
      wet += p.wetMask;
      const c = sampleCoarse(ctx, p.x, p.z, newPointRecord());
      expect(c.wetMask).toBe(Number.isFinite(c.surfaceWaterLevel) ? 1 : 0);
    }
    // Both kinds occur (about 40 % of the default world lies under water).
    expect(wet).toBeGreaterThan(50);
    expect(wet).toBeLessThan(462);
  });

  test('every position water v0 fills has wet′ = 1 at the position (100,352 positions, seeds 42 and 1, default and archipelago)', () => {
    const wetTree = { root: at(DEFAULT_DENSITY_TREE, WET_PATH), defs: {} };
    expect(validateDensitySource(wetTree)).toEqual([]);
    const solid = new Uint8Array(98304);
    const top = new Int32Array(256);
    const waterTop = new Int32Array(256);
    let positions = 0;
    let wet = 0;
    const misses: string[] = [];
    const figures: string[] = [];
    for (const seed of ['42', '1']) {
      for (const profile of ['default', 'archipelago'] as const satisfies readonly ProfileId[]) {
        const ctx = createGenContext(seedFromInput(seed), resolveProfile(profile));
        const dc = createDensityContext(ctx, resolveDensity(wetTree, ctx.params) as DensityExpr);
        const pts = samplePoints('sp6a.wetCover', DRAWS);
        let columns = 0;
        let draws = 0;
        let here = 0;
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
          // The lattice (with its halo): the mask is the level's finiteness, bit for bit.
          for (let k = 0; k < 49; k++) {
            if (!Object.is(s.f.wetMask[k], Number.isFinite(s.f.surfaceWaterLevel[k]!) ? 1 : 0)) throw new Error(`(${cx}, ${cz}) lattice ${k}: wetMask ${s.f.wetMask[k]}`);
          }
          columnWaterV0(s, solid, top, waterTop, null, false);
          for (let p = 0; p < 256; p++) {
            positions++;
            if (!(waterTop[p]! >= -64)) continue;
            wet++;
            here++;
            const lx = p & 15, lz = p >> 4;
            // y is irrelevant to a `col`-only subtree; 0 is any voxel of the column.
            const v = dc.compiled.voxelFn(lx, 0, lz);
            if (!Object.is(v, 1) && misses.length < 32) misses.push(`${seed}/${profile} (${16 * cx + lx}, ${16 * cz + lz}): wet′ ${v}`);
          }
        }
        expect([seed, profile, columns]).toEqual([seed, profile, SHORE_COLUMNS]);
        figures.push(`${seed}/${profile}: ${columns} shore columns in ${draws} draws, ${here} wet positions`);
      }
    }
    console.log(`wetCover: ${positions} positions, ${wet} wet; ${figures.join('; ')}`);
    expect(positions).toBe(4 * SHORE_COLUMNS * 256);
    expect(wet).toBeGreaterThan(30000);
    expect(misses).toEqual([]);
  }, 300_000);
});

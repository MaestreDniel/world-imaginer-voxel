import { describe, expect, test } from 'vitest';
import { toUniform } from '../../src/core/noise/cdf';
import { newClimate, pvFold, sampleClimate } from '../../src/gen/column/climate';
import { noiseFor } from '../../src/gen/context';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

const pts = (() => {
  const next = testRng(501);
  return Array.from({ length: 400 }, () => [-524288 + 1048576 * testFloat(next), -524288 + 1048576 * testFloat(next)] as const);
})();

describe('climate', () => {
  const ctx = ctxFor();
  test('every field lies in [−uMax, uMax]; PV is the fold of W', () => {
    for (const [x, z] of pts) {
      const c = sampleClimate(ctx, x, z, newClimate());
      for (const v of [c.C, c.E, c.W, c.T, c.H, c.R]) expect(Math.abs(v)).toBeLessThanOrEqual(ctx.uLimit);
      expect(c.PV).toBe(pvFold(c.W));
      expect(c.R).toBe(toUniform(c.Rz));
    }
    expect(ctx.uLimit).toBe(0.9973002846585164);
  });
  test('PV fold: ridges at |W| = 2/3, valleys at 0 and ±1', () => {
    expect([pvFold(2 / 3), pvFold(-2 / 3), pvFold(0), pvFold(1), pvFold(-1), pvFold(1 / 3)]).toEqual([1, 1, -1, 0, 0, 0]);
  });
  test('scaleMul is an exact zoom: climate(s, x, z) = climate(1, x/s, z/s) bit for bit', () => {
    for (const s of [2, 4, 0.5]) {
      const zoomed = ctxFor('42', { climate: { scaleMul: s } });
      for (const [x, z] of pts.slice(0, 100)) {
        const a = sampleClimate(zoomed, x, z, newClimate());
        const b = sampleClimate(ctx, x / s, z / s, newClimate());
        expect([a.C, a.E, a.W, a.T, a.H, a.R]).toEqual([b.C, b.E, b.W, b.T, b.H, b.R]);
      }
    }
  });
  test('warp order: with zero warps every field is sampled at (x, z); the C warp moves only C', () => {
    const flat = ctxFor('42', { climate: { warp: { shift: { amplitude: 0 }, C: { amplitude: 0 }, R: { amplitude: 0 } } } });
    const onlyC = ctxFor('42', { climate: { warp: { shift: { amplitude: 0 }, R: { amplitude: 0 } } } });
    for (const [x, z] of pts.slice(0, 50)) {
      const a = sampleClimate(flat, x, z, newClimate());
      expect(a.C).toBe(toUniform(noiseFor(flat, 'climate.C').z2(x, z)));
      expect(a.T).toBe(toUniform(noiseFor(flat, 'climate.T').z2(x, z)));
      expect([a.xr, a.zr]).toEqual([x, z]);
      const b = sampleClimate(onlyC, x, z, newClimate());
      expect([b.E, b.W, b.T, b.H, b.R]).toEqual([a.E, a.W, a.T, a.H, a.R]);
    }
  });
  test('deterministic and seed-dependent', () => {
    const a = sampleClimate(ctxFor('42'), 1000, -2000, newClimate());
    expect(sampleClimate(ctxFor('42'), 1000, -2000, newClimate())).toEqual(a);
    expect(sampleClimate(ctxFor('43'), 1000, -2000, newClimate()).C).not.toBe(a.C);
  });
});

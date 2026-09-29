import { describe, expect, test } from 'vitest';
import { evalSpline } from '../../src/core/spline/hermite';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { newShape, sampleShape, splineCoords } from '../../src/gen/column/shape';
import { offset0At, steepAt, steepFrom } from '../../src/gen/column/steep';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

describe('shape', () => {
  const ctx = ctxFor();
  test('offset0, sigma0 and jag0 come from the splines at [C, E, W, PV, T, H]', () => {
    const next = testRng(601);
    const coords = new Float64Array(6);
    for (let i = 0; i < 300; i++) {
      const c = sampleClimate(ctx, -524288 + 1048576 * testFloat(next), -524288 + 1048576 * testFloat(next), newClimate());
      const s = sampleShape(ctx, c, coords, newShape());
      const v = Float64Array.of(c.C, c.E, c.W, c.PV, c.T, c.H);
      expect(s.offset0).toBe(evalSpline(ctx.offset, v));
      expect(s.sigma0).toBe(Math.max(0, evalSpline(ctx.sigma, v)));
      expect(s.jag0).toBe(Math.max(0, evalSpline(ctx.jag, v)));
    }
  });
  test('sigma0 and jag0 are never negative over 1M random coordinate vectors', () => {
    const next = testRng(602);
    const c = newClimate();
    const coords = new Float64Array(6);
    const s = newShape();
    let neg = 0;
    for (let i = 0; i < 1_000_000; i++) {
      c.C = -1 + 2 * testFloat(next); c.E = -1 + 2 * testFloat(next); c.W = -1 + 2 * testFloat(next);
      c.PV = -1 + 2 * testFloat(next); c.T = -1 + 2 * testFloat(next); c.H = -1 + 2 * testFloat(next);
      sampleShape(ctx, c, coords, s);
      if (s.sigma0 < 0 || s.jag0 < 0 || Object.is(s.sigma0, -0) || Object.is(s.jag0, -0)) neg++;
    }
    expect(neg).toBe(0);
  });
  test('splineCoords writes the SP1 slot order', () => {
    const c = { ...newClimate(), C: 1, E: 2, W: 3, PV: 4, T: 5, H: 6 };
    expect(Array.from(splineCoords(c, new Float64Array(6)))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('steep', () => {
  test('steepFrom is the central-difference gradient length at ±4 blocks', () => {
    expect(steepFrom(72, 64, 70, 70)).toBe(1);
    expect(steepFrom(70, 70, 60, 68)).toBe(1);
    expect(steepFrom(76, 70, 70, 78)).toBe(Math.sqrt(0.75 * 0.75 + 1));
    expect(steepFrom(5, 5, 5, 5)).toBe(0);
  });
  test('steepAt samples offset0 at the four quart neighbours', () => {
    const ctx = ctxFor();
    const coords = new Float64Array(6);
    for (const [x, z] of [[0, 0], [1000, -3000], [123.5, 77.25]] as const) {
      expect(steepAt(ctx, x, z, coords)).toBe(steepFrom(offset0At(ctx, x + 4, z, coords), offset0At(ctx, x - 4, z, coords), offset0At(ctx, x, z - 4, coords), offset0At(ctx, x, z + 4, coords)));
    }
  });
});

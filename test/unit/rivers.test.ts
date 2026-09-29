import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { newRiver, riverTerms, sampleRivers, type RiverInput } from '../../src/gen/column/rivers';
import { newShape, sampleShape } from '../../src/gen/column/shape';
import { ctxFor } from '../harness/gen';

const P = DEFAULTS.rivers;
/** Inland (C 0.3, s = 1), flat (E = −1, valley half-width 30), lowland (offset0 80, s_alt = 1), |∇R_z| = 0.01/block. */
const base: RiverInput = { Rz: 0, gradLen: 0.01, u2: 0.5, C: 0.3, E: -1, offset0: 80, sigma0: 4, jag0: 10 };
const at = (dist: number, over: Partial<RiverInput> = {}) => riverTerms({ ...base, Rz: dist * 0.01, ...over }, P, newRiver());

describe('riverTerms (master §3.4)', () => {
  test('distance is |R_z| / |∇R_z| and width is 5 + 9·u2', () => {
    expect(at(12).riverDist).toBeCloseTo(12, 12);
    expect(at(0).width).toBe(9.5);
    expect(riverTerms({ ...base, Rz: 0.5, gradLen: 0 }, P, newRiver()).riverDist).toBe(5000);
  });
  test('channel centre: floor at 63 − (3 + 3·u2), wet, no jag, σ ≤ 0.5', () => {
    const r = at(0);
    expect(r.offset).toBe(63 - 4.5);
    expect([r.wet, r.gorge, r.jag]).toEqual([true, false, 0]);
    expect(r.sigma).toBe(0.5);
  });
  test('channel profile is parabolic inside w/2', () => {
    const r = at(9.5 / 4);
    expect(r.offset).toBeCloseTo(63 - 4.5 * 0.75, 12);
  });
  test('valley: at the channel edge the floor is min(offset0, 64); far away offset0 returns', () => {
    const edge = at(9.5 / 2 + 1e-9);
    expect(edge.offset).toBeCloseTo(64, 6);
    expect(edge.wet).toBe(true);
    const far = at(1000);
    expect(far.offset).toBeCloseTo(80, 9);
    expect([far.wet, far.gorge]).toEqual([false, false]);
    expect(far.sigma).toBeCloseTo(4, 9);
  });
  test('σ and jag are scaled by t inside the valley', () => {
    const r = at(9.5 / 2 + 30);
    const t = 1 - Math.exp(-1);
    expect(r.sigma).toBeCloseTo(4 * t, 7);
    expect(r.jag).toBeCloseTo(10 * t, 7);
  });
  test('the coast fade removes the valley but keeps the channel to the sea', () => {
    const r = at(20, { C: -0.2 });
    expect(r.offset).toBe(80);
    expect(r.riverStrength).toBe(0);
    const mouth = at(0, { C: -0.2, offset0: 60 });
    expect(mouth.offset).toBe(Math.min(60, 63 - 4.5));
    expect(mouth.wet).toBe(true);
  });
  test('high ground turns the channel into a dry gorge gorgeDepth below offset0, and the valley fades', () => {
    const r = at(0, { offset0: 200 });
    expect([r.wet, r.gorge]).toEqual([false, true]);
    expect(r.offset).toBe(200 - 12);
    expect(at(40, { offset0: 200 }).offset).toBe(200);
    const half = at(0, { offset0: 145 });
    expect(half.offset).toBeCloseTo(Math.min(145 + (64 - 145) * 0.5, (145 - 12) + (58.5 - 133) * 0.5), 9);
    expect(half.wet).toBe(false);
    expect(half.riverStrength).toBe(0.5);
  });
});

describe('sampleRivers', () => {
  test('feeds riverTerms from the climate (deterministic; distance matches the ±2-block gradient)', () => {
    const ctx = ctxFor();
    const coords = new Float64Array(6);
    let wet = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i * 97 - 90000;
      const z = i * 53 - 40000;
      const c = sampleClimate(ctx, x, z, newClimate());
      const s = sampleShape(ctx, c, coords, newShape());
      const r = sampleRivers(ctx, c, s, newRiver());
      expect(sampleRivers(ctx, c, s, newRiver())).toEqual(r);
      expect(r.riverDist).toBeGreaterThanOrEqual(0);
      if (r.wet) wet++;
    }
    expect(wet).toBeGreaterThan(0);
    expect(wet).toBeLessThan(400);
  });
});

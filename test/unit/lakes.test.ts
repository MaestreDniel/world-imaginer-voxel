import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { cellEligible, lakeCell, lakeTerms, nearestCell, newLake, sampleLakes, type CellProbe } from '../../src/gen/column/lakes';
import { ctxFor } from '../harness/gen';

const P = DEFAULTS.lakes;

describe('lakeTerms (master §3.5)', () => {
  test('inside the basin: bowl below Lw, σ × 0.3, jag 0, water at Lw', () => {
    const c = lakeTerms(0, 80, 10, 90, 2, 5, P, newLake());
    expect(c).toEqual({ lakeMask: 1, lakeLevel: 80, lakeFloor: 70, offset: 70, sigma: 2 * 0.3, jag: 0 });
    expect(lakeTerms(0.5, 80, 10, 90, 2, 5, P, newLake()).offset).toBe(80 - 10 * 0.75);
    expect(lakeTerms(1, 80, 10, 90, 2, 5, P, newLake()).offset).toBe(80);
    expect(lakeTerms(-0.1, 80, 10, 90, 2, 5, P, newLake()).offset).toBe(70);
    expect(lakeTerms(0.5, 80, 10, 60, 2, 5, P, newLake()).offset).toBe(60);
  });
  test('rim band: raised toward Lw + rimRise + 3·rimSigma by m; containment at the inner edge', () => {
    const inner = lakeTerms(1 + 1e-12, 80, 10, 70, 2, 5, P, newLake());
    expect(inner.lakeMask).toBeCloseTo(1, 9);
    expect(inner.offset).toBeCloseTo(80 + 2 + 1.5, 9);
    expect(inner.sigma).toBeCloseTo(0.5, 9);
    expect(inner.lakeLevel).toBe(-Infinity);
    const mid = lakeTerms(1 + P.rimWidth / 2, 80, 10, 70, 2, 5, P, newLake());
    expect(mid.lakeMask).toBeCloseTo(0.5, 12);
    expect(mid.offset).toBeCloseTo(70 + (83.5 - 70) * 0.5, 9);
    expect(mid.jag).toBeCloseTo(2.5, 12);
    expect(lakeTerms(1.2, 80, 10, 95, 2, 5, P, newLake()).offset).toBe(95);
  });
  test('outside the rim band nothing changes', () => {
    expect(lakeTerms(1 + P.rimWidth, 80, 10, 70, 2, 5, P, newLake())).toEqual({ lakeMask: 0, lakeLevel: -Infinity, lakeFloor: -Infinity, offset: 70, sigma: 2, jag: 5 });
  });
});

describe('cellEligible', () => {
  const ok: CellProbe = { C: 0.3, offset0: 90, riverDist: 500, valleyWidth: 75, wet: false, roll: 0.05 };
  test.each<[string, Partial<CellProbe>, boolean]>([
    ['eligible', {}, true],
    ['roll above p', { roll: 0.2 }, false],
    ['too oceanic', { C: -0.2 }, false],
    ['too low', { offset0: 65 }, false],
    ['too high', { offset0: 201 }, false],
    ['in a river valley', { riverDist: 60 }, false],
    ['wet river', { wet: true }, false],
  ])('%s', (_n, over, expected) => {
    expect(cellEligible({ ...ok, ...over }, P)).toBe(expected);
  });
});

describe('lake cells', () => {
  const ctx = ctxFor();
  test('cells are deterministic and the memo agrees with a fresh context', () => {
    const fresh = ctxFor();
    for (let i = -20; i < 20; i += 3) for (let j = -20; j < 20; j += 3) expect(lakeCell(fresh, i, j)).toEqual(lakeCell(ctx, i, j));
    expect(lakeCell(ctx, 5, 7)).toBe(lakeCell(ctx, 5, 7));
  });
  test('centres stay inside their jitter window; some cells in a 60 × 60 block hold lakes with Lw in range', () => {
    let enabled = 0;
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) {
      const c = lakeCell(ctx, i, j);
      expect(c.cx).toBeGreaterThanOrEqual((i + 0.1) * P.cell);
      expect(c.cx).toBeLessThanOrEqual((i + 0.9) * P.cell);
      if (c.enabled) {
        enabled++;
        expect(Number.isInteger(c.Lw)).toBe(true);
        expect(c.depth).toBeGreaterThanOrEqual(4);
        expect(c.depth).toBeLessThan(14);
      }
    }
    expect(enabled).toBeGreaterThan(10);
    expect(enabled).toBeLessThan(0.12 * 3600);
  });
  test('the nearest cell is the closest of the 3 × 3 neighbourhood', () => {
    const { cell, dist } = nearestCell(ctx, 1000.5, -2000.25);
    expect(dist).toBe(Math.hypot(1000.5 - cell.cx, -2000.25 - cell.cz));
  });
  test('sampleLakes leaves columns of disabled cells untouched', () => {
    let touched = 0;
    for (let k = 0; k < 400; k++) {
      const r = sampleLakes(ctx, k * 811, k * -373, 90, 2, 5, newLake());
      if (r.lakeMask === 0) expect([r.offset, r.sigma, r.jag]).toEqual([90, 2, 5]);
      else touched++;
    }
    expect(touched).toBeLessThan(200);
  });
});

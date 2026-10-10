import { describe, expect, expectTypeOf, test } from 'vitest';
import { COL_FIELD_BOUNDS } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import type { ParamsPatch } from '../../src/core/params/schema';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { compileSpline, evalSpline } from '../../src/core/spline/hermite';
import type { NestedSpline, SplineCoord } from '../../src/core/spline/types';
import { buildColumnSample, newColumnSample, readField, SAMPLE_FIELDS, type SampleField } from '../../src/gen/column/columnStage';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { paramsWith } from '../harness/gen';

/** DT2's columns (test/metrics/region.metric.ts): per profile, uniform over ±1024 chunks (default) or ±4096 (large_biomes). */
const DT2_RANGE = { default: 1024, large_biomes: 4096 } as const;
const COLUMNS = 16;

/** Every field value of `n` columns of `ctx` (the 49 lattice points and `readField` at the 256 positions) outside its bound. */
function violations(ctx: GenContext, columns: readonly (readonly [number, number])[], seen?: Map<SampleField, [number, number]>): string[] {
  const out: string[] = [];
  const s = newColumnSample();
  for (const [cx, cz] of columns) {
    buildColumnSample(ctx, cx, cz, s);
    for (const f of SAMPLE_FIELDS) {
      const [lo, hi] = COL_FIELD_BOUNDS[f];
      const check = (v: number, where: string): void => {
        if (!(v >= lo && v <= hi)) out.push(`${f} = ${v} at column (${cx}, ${cz}) ${where}`);
        const m = seen?.get(f);
        if (seen !== undefined) seen.set(f, m === undefined ? [v, v] : [Math.min(m[0], v), Math.max(m[1], v)]);
      };
      for (let k = 0; k < 49; k++) check(s.f[f][k]!, `lattice ${k}`);
      for (let p = 0; p < 256; p++) check(readField(s, f, 16 * cx + (p & 15), 16 * cz + (p >> 4)), `position ${p}`);
    }
  }
  return out;
}

/** A three-level spline (C → E → PV) whose every knot sits at y = `y` with tangents ±1e5 pushing away from it. */
function worstSpline(y: number, coords: readonly SplineCoord[] = ['C', 'E', 'PV']): NestedSpline {
  const [c, ...rest] = coords;
  const s = y > 0 ? 1 : -1;
  const at = (): number | NestedSpline => (rest.length === 0 ? y : worstSpline(y, rest));
  return { coord: c!, points: [{ x: -2, y: at(), d: s * 1e5 }, { x: 2, y: at(), d: -s * 1e5 }] };
}

describe('COL_FIELD_BOUNDS (SP3d spec §1.9)', () => {
  test('one frozen closed interval per SAMPLE_FIELDS entry, in its order', () => {
    expect(Object.keys(COL_FIELD_BOUNDS)).toEqual([...SAMPLE_FIELDS]);
    expectTypeOf<keyof typeof COL_FIELD_BOUNDS>().toEqualTypeOf<SampleField>();
    expect(Object.isFrozen(COL_FIELD_BOUNDS)).toBe(true);
    for (const f of SAMPLE_FIELDS) {
      const b = COL_FIELD_BOUNDS[f];
      expect(Object.isFrozen(b)).toBe(true);
      expect(b).toHaveLength(2);
      expect(b[0]).toBeLessThanOrEqual(b[1]);
    }
  });

  test('every field is bounded, the four the default tree reads (offset, jag, sigma, E) included, far below 1e100', () => {
    for (const f of SAMPLE_FIELDS) {
      const [lo, hi] = COL_FIELD_BOUNDS[f];
      expect(Number.isFinite(lo) && Number.isFinite(hi), f).toBe(true);
      expect(Math.max(-lo, hi), f).toBeLessThanOrEqual(1e6);
    }
    expect(COL_FIELD_BOUNDS.offset).toEqual([-600_000, 600_000]);
    expect(COL_FIELD_BOUNDS.jag).toEqual([0, 500_000]);
    expect(COL_FIELD_BOUNDS.sigma).toEqual([0, 500_000]);
    expect(COL_FIELD_BOUNDS.E).toEqual([-1, 1]);
  });

  test("sampled values over DT2's columns (seed '42', both profiles) lie inside their bounds", () => {
    const r = new Xoshiro128(fnv1a32('DT2'));
    for (const profile of ['default', 'large_biomes'] as const) {
      const ctx = createGenContext(seedFromInput('42'), resolveProfile(profile));
      const R = DT2_RANGE[profile];
      const columns = Array.from({ length: COLUMNS }, () => [-R + r.nextInt(2 * R), -R + r.nextInt(2 * R)] as const);
      expect(violations(ctx, columns), profile).toEqual([]);
    }
  });

  test("the spline bound: a worst-case three-level spline overshoots its knots by 3 × 1e5, inside offset0's ±5e5", () => {
    for (const y of [320, -64]) {
      const s = compileSpline(worstSpline(y), { coords: ['C', 'E', 'PV'], yMin: -64, yMax: 320 });
      const coords = new Float64Array(6);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) for (let k = 0; k <= 40; k++) {
        coords[0] = -1 + i / 20; coords[1] = -1 + j / 20; coords[3] = -1 + k / 20;
        const v = evalSpline(s, coords);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (y > 0) expect(hi).toBe(320 + 3e5);
      else expect(lo).toBe(-64 - 3e5);
      expect(Math.max(-lo, hi)).toBeLessThanOrEqual(COL_FIELD_BOUNDS.offset0[1]);
      expect(-lo).toBeLessThanOrEqual(-COL_FIELD_BOUNDS.offset0[0]);
    }
  });

  test('worst-case schema-valid shape splines, rivers and lakes: every sampled value stays inside its bound', () => {
    const r = new Xoshiro128(fnv1a32('COL_FIELD_BOUNDS'));
    const columns = Array.from({ length: COLUMNS }, () => [-1024 + r.nextInt(2048), -1024 + r.nextInt(2048)] as const);
    for (const y of [320, -64]) {
      const patch: ParamsPatch = {
        shape: { offset: worstSpline(y), sigma: worstSpline(y > 0 ? 64 : -16), jag: worstSpline(y > 0 ? 128 : -16) },
        lakes: { p: 1, minC: -1, offsetMin: -64, offsetMax: 320, depthMin: 64, depthVar: 64, rimRise: 32, rimSigma: 8, rimWidth: 2 },
        rivers: { depthMin: 32, depthVar: 32, gorgeDepth: 64, valleyFloor: 128, valleyRise: 64 },
      };
      const ctx = createGenContext(seedFromInput('42'), paramsWith(patch));
      const seen = new Map<SampleField, [number, number]>();
      expect(violations(ctx, columns, seen), `knots at ${y}`).toEqual([]);
      // The overshoot is real: offset0 leaves the schema's [−64, 320] by far more than the knots.
      const o = seen.get('offset0')!;
      expect(y > 0 ? o[1] > 1e5 : o[0] < -1e5).toBe(true);
    }
  });
});

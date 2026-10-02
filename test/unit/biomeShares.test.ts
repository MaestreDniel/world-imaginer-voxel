import { describe, expect, test } from 'vitest';
import { BIOME_TABLE_DEFAULT } from '../../src/core/params/biomeDefaults';
import type { ParamsPatch } from '../../src/core/params/schema';
import { newPick, pickBox } from '../../src/gen/biomes/picker';
import { biomeId, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { biomeSharePoints, biomeSharesInto, biomeSharesLength, summarizeBiomeShares } from '../../src/metrics/biomeShares';
import { samplePoints } from '../../src/metrics/noiseStats';
import { ctxFor } from '../harness/gen';

const NB = SURFACE_BIOMES.length;
const TIES = NB;
const OUTSIDE = NB + 1;
const TOTAL = NB + 2;

/** B1's counting loop as it was at SP2a (columnPoint, then pickBox on non-river points). */
function direct(seed: string, patch: ParamsPatch, id: string, n: number): number[] {
  const ctx = ctxFor(seed, patch);
  const pts = samplePoints(id, n);
  const out = new Array<number>(NB + 3).fill(0);
  const p = newPick();
  for (let i = 0; i < n; i++) {
    const c = columnPoint(ctx, pts.x[i]!, pts.z[i]!);
    out[c.biome]!++;
    out[TOTAL]!++;
    if (c.riverWet) continue;
    pickBox(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, c.offset0, p);
    if (p.runnerUp === p.fitness) out[TIES]!++;
    if (p.fitness > 0) out[OUTSIDE]!++;
  }
  return out;
}

const run = (seed: string, patch: ParamsPatch, id: string, n: number, from = 0, to = n, stop?: () => boolean) => {
  const out = new Float64Array(biomeSharesLength());
  const done = biomeSharesInto(ctxFor(seed, patch), samplePoints(id, n), from, to, out, stop);
  return { out, done };
};

/** meadow gets plains' box: every non-river point inside it is a tie resolved by priority. */
const TIED: ParamsPatch = { biomes: { table: { ...BIOME_TABLE_DEFAULT, meadow: { ...BIOME_TABLE_DEFAULT.plains, priority: 9 } } } };

describe('layout', () => {
  test('one count per biome id, then ties, outside and the total', () => {
    expect(NB).toBe(28);
    expect(biomeSharesLength()).toBe(31);
  });
});

describe('biomeSharesInto', () => {
  test('equals the direct computation (default table: rivers and points outside every box occur)', () => {
    const want = direct('7', {}, 'test.biomeShares', 2000);
    const got = run('7', {}, 'test.biomeShares', 2000);
    expect(got.done).toBe(true);
    expect(Array.from(got.out)).toEqual(want);
    expect(want[biomeId('river')]! + want[biomeId('frozen_river')]!).toBeGreaterThan(0);
    expect(want[OUTSIDE]).toBeGreaterThan(0);
    expect(want[TIES]).toBe(0);
    expect(want[TOTAL]).toBe(2000);
  });

  test('equals the direct computation with tied boxes', () => {
    const want = direct('7', TIED, 'test.biomeShares', 2000);
    expect(want[TIES]).toBeGreaterThan(0);
    expect(Array.from(run('7', TIED, 'test.biomeShares', 2000).out)).toEqual(want);
  });

  test('accumulates: slices summed into one array equal a single run', () => {
    const ctx = ctxFor('3');
    const pts = samplePoints('test.biomeShares', 3000);
    const whole = new Float64Array(biomeSharesLength());
    biomeSharesInto(ctx, pts, 0, 3000, whole);
    const parts = new Float64Array(biomeSharesLength());
    for (const [a, b] of [[0, 1000], [1000, 1001], [1001, 1001], [1001, 3000]] as const) expect(biomeSharesInto(ctx, pts, a, b, parts)).toBe(true);
    expect(Array.from(parts)).toEqual(Array.from(whole));
    biomeSharesInto(ctx, pts, 0, 3000, parts);
    expect(Array.from(parts)).toEqual(Array.from(whole, (v) => 2 * v));
  });

  test('stop is checked before every 256 points; a stopped run returns false with a partial sum', () => {
    let calls = 0;
    const never = run('3', {}, 'test.biomeShares', 1000, 0, 1000, () => { calls++; return false; });
    expect(never.done).toBe(true);
    expect(calls).toBe(4);
    expect(Array.from(never.out)).toEqual(Array.from(run('3', {}, 'test.biomeShares', 1000).out));

    calls = 0;
    const third = run('3', {}, 'test.biomeShares', 1000, 0, 1000, () => ++calls === 3);
    expect(third.done).toBe(false);
    expect(third.out[TOTAL]).toBe(512);

    calls = 0;
    const offset = run('3', {}, 'test.biomeShares', 1000, 100, 1000, () => ++calls === 2);
    expect(offset.done).toBe(false);
    expect(offset.out[TOTAL]).toBe(256);

    const at = run('3', {}, 'test.biomeShares', 1000, 0, 1000, () => true);
    expect(at.done).toBe(false);
    expect(Array.from(at.out).every((v) => v === 0)).toBe(true);
  });

  test('a bad range or output length throws', () => {
    const ctx = ctxFor('3');
    const pts = samplePoints('test.biomeShares', 10);
    const out = new Float64Array(biomeSharesLength());
    expect(() => biomeSharesInto(ctx, pts, 5, 4, out)).toThrow(RangeError);
    expect(() => biomeSharesInto(ctx, pts, -1, 4, out)).toThrow(RangeError);
    expect(() => biomeSharesInto(ctx, pts, 0, 11, out)).toThrow(RangeError);
    expect(() => biomeSharesInto(ctx, pts, 0.5, 4, out)).toThrow(RangeError);
    expect(() => biomeSharesInto(ctx, pts, 0, 4, new Float64Array(30))).toThrow(RangeError);
  });
});

describe('summarizeBiomeShares', () => {
  test('shares, ties and outside are fractions of the total; min, rare min, largest land and ocean family as in B1', () => {
    const sum = new Float64Array(biomeSharesLength());
    const set = (name: (typeof SURFACE_BIOMES)[number], v: number) => { sum[biomeId(name)] = v; };
    // Every biome 20, then ocean 340 and a few others: 1000 points.
    for (let i = 0; i < NB; i++) sum[i] = 20;
    set('ocean', 340); set('deep_ocean', 100); set('river', 5); set('volcano', 2); set('badlands', 30); set('plains', 100);
    set('jagged_peaks', 3);
    let total = 0;
    for (let i = 0; i < NB; i++) total += sum[i]!;
    sum[TIES] = 4;
    sum[OUTSIDE] = 7;
    sum[TOTAL] = total;
    const r = summarizeBiomeShares(sum);
    expect(total).toBe(1000);
    expect(r.total).toBe(1000);
    expect(r.shares.length).toBe(NB);
    expect(r.shares[biomeId('ocean')]).toBe(0.34);
    expect(r.ties).toBe(0.004);
    expect(r.outside).toBe(0.007);
    expect(r.minShare).toBe(0.005);
    expect(r.minRareShare).toBe(0.002);
    expect(r.largestLand).toBe(0.1);
    expect(r.oceanFamily).toBe(0.34 + 0.1 + 0.02 + 0.02);
  });

  test('matches B1\'s formulas on a real sum', () => {
    const { out } = run('11', {}, 'test.biomeShares', 4000);
    const r = summarizeBiomeShares(out);
    const total = out[TOTAL]!;
    const shares = Array.from(out.subarray(0, NB), (c) => c / total);
    expect(Array.from(r.shares)).toEqual(shares);
    expect([r.ties, r.outside, r.total]).toEqual([out[TIES]! / total, out[OUTSIDE]! / total, 4000]);
  });

  test('an empty sum gives zeros, not NaN; a wrong length throws', () => {
    const r = summarizeBiomeShares(new Float64Array(biomeSharesLength()));
    expect(Array.from(r.shares).every((v) => v === 0)).toBe(true);
    expect([r.ties, r.outside, r.total, r.minShare, r.minRareShare, r.largestLand, r.oceanFamily]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(() => summarizeBiomeShares(new Float64Array(3))).toThrow(RangeError);
  });
});

test('the preview stream is samplePoints(\'sp2b.biomeShares\', 100000)', () => {
  const p = biomeSharePoints();
  const q = samplePoints('sp2b.biomeShares', 100000);
  expect(p.n).toBe(100000);
  expect(Array.from(p.x.subarray(0, 8))).toEqual(Array.from(q.x.subarray(0, 8)));
  expect(Array.from(p.z.subarray(99992))).toEqual(Array.from(q.z.subarray(99992)));
});

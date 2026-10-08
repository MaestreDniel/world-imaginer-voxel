import { describe, expect, test } from 'vitest';
import { deriveSeed, type Seed64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { noiseFor } from '../../src/gen/context';
import { BAND_OFFSET_NOISE, bandlandsOffset, bandlandsState, bandlandsTable, isBandlandsTable } from '../../src/gen/surface/bands';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { REGISTRY } from '../../src/world/blocks/index';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

/** §3.3's colour list, in its order. */
const COLOURS = [
  'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta',
].map((k) => REGISTRY.parseStateKey(k));

/** §3.3's table, written from the spec: the runs (length, colour index) and the 192 entries. */
function specTable(seed: Seed64): { runs: Array<[number, number]>; table: number[] } {
  const r = new Xoshiro128(deriveSeed(seed, 'surface.bands'));
  const runs: Array<[number, number]> = [];
  const table: number[] = [];
  let i = 0;
  while (i < 192) {
    const len = 1 + r.nextInt(4);
    const colour = r.nextInt(7);
    runs.push([len, colour]);
    for (let k = i; k < Math.min(192, i + len); k++) table[k] = COLOURS[colour]!;
    i += len;
  }
  return { runs, table };
}

describe('the badlands band table (SP3c spec §3.3)', () => {
  test('192 entries drawn as the spec says: runs of 1 … 4 of one of the seven terracottas, len then colour, nothing else drawn', () => {
    const next = testRng(1501);
    const lens = new Set<number>();
    const colours = new Set<number>();
    let repeats = 0, cut = 0;
    for (let k = 0; k < 64; k++) {
      const seed: Seed64 = k === 0 ? [42, 0] : [next(), next()];
      const t = bandlandsTable(seed);
      const want = specTable(seed);
      expect(t).toBeInstanceOf(Uint16Array);
      expect(Array.from(t)).toEqual(want.table);
      expect(isBandlandsTable(t)).toBe(true);
      expect(Array.from(bandlandsTable(seed))).toEqual(Array.from(t));
      for (const [len, colour] of want.runs) {
        lens.add(len);
        colours.add(colour);
      }
      for (let r = 1; r < want.runs.length; r++) if (want.runs[r]![1] === want.runs[r - 1]![1]) repeats++;
      if (want.runs.reduce((n, [len]) => n + len, 0) > 192) cut++;
    }
    expect([...lens].sort()).toEqual([1, 2, 3, 4]);
    expect([...colours].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Repeats are allowed (adjacent runs of one colour), and the last run is cut at 192 on some seeds.
    expect(repeats).toBeGreaterThan(0);
    expect(cut).toBeGreaterThan(0);
    // The world seed decides it.
    expect(Array.from(bandlandsTable([42, 0]))).not.toEqual(Array.from(bandlandsTable([43, 0])));
    expect(isBandlandsTable(new Uint16Array(191))).toBe(false);
  });

  test('the offset: o = round(4·z / clampSigma) ∈ [−4, 4], +0 at zero; ±4 at ±clampSigma', () => {
    for (const cs of [1, 2, 3, 8]) {
      expect(bandlandsOffset(cs, cs)).toBe(4);
      expect(bandlandsOffset(-cs, cs)).toBe(-4);
      expect(Object.is(bandlandsOffset(0, cs), 0)).toBe(true);
      // Math.round's ties (toward +∞): 0.5 → 1, −0.5 → +0, −1.5 → −1.
      expect(bandlandsOffset((0.5 * cs) / 4, cs)).toBe(1);
      expect(Object.is(bandlandsOffset((-0.5 * cs) / 4, cs), 0)).toBe(true);
      expect(bandlandsOffset((-1.5 * cs) / 4, cs)).toBe(-1);
      const next = testRng(1502 + cs);
      for (let i = 0; i < 2000; i++) {
        const z = (2 * testFloat(next) - 1) * cs;
        const o = bandlandsOffset(z, cs);
        expect(o).toBe(Math.round((4 * z) / cs) + 0);
        expect(o >= -4 && o <= 4).toBe(true);
      }
    }
  });

  test('the lookup: table[((y + o) mod 192 + 192) mod 192], wrapping below y 0 and above 191', () => {
    const t = bandlandsTable([42, 0]);
    for (let y = -64; y <= 319; y++) {
      for (let o = -4; o <= 4; o++) expect(bandlandsState(t, y, o)).toBe(t[(((y + o) % 192) + 192) % 192]);
    }
    expect(bandlandsState(t, -1, 0)).toBe(t[191]);
    expect(bandlandsState(t, -64, 0)).toBe(t[128]);
    expect(bandlandsState(t, 0, -4)).toBe(t[188]);
    expect(bandlandsState(t, 191, 1)).toBe(t[0]);
    expect(bandlandsState(t, 319, 4)).toBe(t[131]);
    // The bands repeat every 192 blocks.
    for (let y = -64; y <= 127; y++) expect(bandlandsState(t, y + 192, 2)).toBe(bandlandsState(t, y, 2));
  });

  test('a SurfaceContext holds its seed\'s table (an apart context builds an equal one) and the band offset leaf as a 2D noise', () => {
    const ctx = ctxFor('42');
    const sc = surfaceContextOf(ctx);
    expect(Array.from(sc.bands)).toEqual(specTable(ctx.seed).table);
    expect(surfaceContextOf(ctx).bands).toBe(sc.bands);
    expect(Array.from(createSurfaceContext(ctx).bands)).toEqual(Array.from(sc.bands));
    expect(Array.from(surfaceContextOf(ctxFor('7')).bands)).not.toEqual(Array.from(sc.bands));
    const n = sc.noises(BAND_OFFSET_NOISE)!;
    expect(BAND_OFFSET_NOISE).toBe('surface.noises.bandOffset');
    expect([n.dims, n.remap, n.clampSigma]).toEqual([2, 'none', 3]);
    const ref = noiseFor(ctx, BAND_OFFSET_NOISE);
    const offsets = new Set<number>();
    const next = testRng(1503);
    for (let i = 0; i < 4000; i++) {
      const x = Math.floor((testFloat(next) - 0.5) * 2e6), z = Math.floor((testFloat(next) - 0.5) * 2e6);
      expect(Object.is(n.z2(x, z), ref.z2(x, z))).toBe(true);
      offsets.add(bandlandsOffset(n.z2(x, z), n.clampSigma));
    }
    // A unit-sd noise over clampSigma 3 reaches every offset but rarely the ends (|z| ≥ 2.625).
    expect([...offsets].sort((a, b) => a - b)).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
  });
});

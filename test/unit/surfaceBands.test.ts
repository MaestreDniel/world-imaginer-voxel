import { describe, expect, test } from 'vitest';
import { deriveSeed, type Seed64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { noiseFor } from '../../src/gen/context';
import { seedFromInput } from '../../src/core/seed';
import {
  BAND_OFFSET_NOISE, bandlandsOffset, bandlandsState, bandlandsTable, isBandlandsTable, strataOffset, strataState, strataTable,
} from '../../src/gen/surface/bands';
import type { StrataRule } from '../../src/gen/surface/rules';
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

/** §3.3's abyss default: abyss_stone 50/8, abyss_shale 25/4, cracked_abyss_stone 15/3, abyss_stone_veined 10/1. */
const ABYSS: StrataRule = {
  kind: 'strata',
  layers: [
    { state: 'abyss_stone', weight: 50, maxLen: 8 }, { state: 'abyss_shale', weight: 25, maxLen: 4 },
    { state: 'cracked_abyss_stone', weight: 15, maxLen: 3 }, { state: 'abyss_stone_veined', weight: 10, maxLen: 1 },
  ],
  minLen: 1, maxLen: 6, noise: 'surface.noises.bandOffset', amp: 6,
};

/**
 * §3.3's strata table written from the spec (Spec correction 16): per run one `nextFloat` over the cumulative weights of
 * every layer but the previous run's (every layer for the first run, or with one layer), then the length draw (none when
 * the layer's maxLen is below minLen). The draws as (layer, length) and the 192 entries.
 */
function specStrata(seed: Seed64, k: number, r: StrataRule): { runs: Array<[number, number]>; table: number[] } {
  const rng = new Xoshiro128(deriveSeed(seed, `surface.strata.${k}`));
  const runs: Array<[number, number]> = [];
  const table: number[] = [];
  let prev = -1;
  while (table.length < 192) {
    const pool = r.layers.map((_, j) => j).filter((j) => r.layers.length === 1 || j !== prev);
    const total = pool.reduce((t, j) => t + r.layers[j]!.weight, 0);
    const f = rng.nextFloat() * total;
    let acc = 0, layer = pool[pool.length - 1]!;
    for (const j of pool) {
      acc += r.layers[j]!.weight;
      if (f < acc) { layer = j; break; }
    }
    const lm = r.layers[layer]!.maxLen;
    const len = lm < r.minLen ? lm : r.minLen + rng.nextInt(Math.min(r.maxLen, lm) - r.minLen + 1);
    runs.push([layer, len]);
    for (let i = 0; i < len && table.length < 192; i++) table.push(REGISTRY.parseStateKey(r.layers[layer]!.state));
    prev = layer;
  }
  return { runs, table };
}

/** The maximal runs of equal entries of a table, as [state, length], within the table (no wrap). */
function maximalRuns(t: ArrayLike<number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < t.length; i++) {
    if (i > 0 && t[i] === t[i - 1]) out[out.length - 1]![1]++;
    else out.push([t[i]!, 1]);
  }
  return out;
}

describe('the strata table (SP6b spec §3.3, D19)', () => {
  const states = ABYSS.layers.map((l) => REGISTRY.parseStateKey(l.state));
  const layerOf = (s: number): number => states.indexOf(s);

  test('the abyss layers, seed 42, k 0: 192 entries as the spec draws them, the same twice', () => {
    const seed = seedFromInput('42');
    const t = strataTable(seed, 0, ABYSS);
    expect(t).toBeInstanceOf(Uint16Array);
    expect(t.length).toBe(192);
    expect(Array.from(strataTable(seed, 0, ABYSS))).toEqual(Array.from(t));
    expect(Array.from(t)).toEqual(specStrata(seed, 0, ABYSS).table);
    expect(new Set(t)).toEqual(new Set(states));
  });

  test('each maximal run is one draw: no two consecutive runs of one layer, veins 1 long, runs ≤ min(6, the layer\'s maxLen)', () => {
    for (const s of ['42', '1', '2', '3', '4', '5', '6', '7', '8']) {
      const seed = seedFromInput(s);
      const t = strataTable(seed, 0, ABYSS);
      const want = specStrata(seed, 0, ABYSS);
      const runs = maximalRuns(t);
      // One maximal run per draw (the last one cut at 192), in draw order.
      expect(runs.map(([st]) => layerOf(st))).toEqual(want.runs.map(([l]) => l));
      for (let r = 1; r < want.runs.length; r++) expect(want.runs[r]![0]).not.toBe(want.runs[r - 1]![0]);
      for (const [st, len] of runs) {
        const l = layerOf(st);
        expect(len).toBeLessThanOrEqual(Math.min(ABYSS.maxLen, ABYSS.layers[l]!.maxLen));
        expect(len).toBeGreaterThanOrEqual(1);
        if (ABYSS.layers[l]!.state === 'abyss_stone_veined') expect(len).toBe(1);
      }
    }
  });

  test('pooled over seeds 1 … 8, each layer\'s share of runs is within ±0.08 of the exclusion chain\'s stationary share', () => {
    const count = [0, 0, 0, 0];
    for (let s = 1; s <= 8; s++) for (const [st] of maximalRuns(strataTable(seedFromInput(String(s)), 0, ABYSS))) count[layerOf(st)]!++;
    const w = ABYSS.layers.map((l) => l.weight / 100);
    const norm = w.reduce((a, x) => a + x * (1 - x), 0);
    const stationary = w.map((x) => (x * (1 - x)) / norm);
    expect(stationary.map((x) => Math.round(x * 1000) / 1000)).toEqual([0.382, 0.286, 0.195, 0.137]);
    const total = count.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 4; i++) expect(Math.abs(count[i]! / total - stationary[i]!)).toBeLessThan(0.08);
  });

  test('a one-layer rule fills the table with its layer; k 1 gives another table; the lengths follow minLen and maxLen', () => {
    const seed = seedFromInput('42');
    const one: StrataRule = { ...ABYSS, layers: [{ state: 'abyss_shale', weight: 3, maxLen: 2 }] };
    expect([...new Set(strataTable(seed, 0, one))]).toEqual([REGISTRY.parseStateKey('abyss_shale')]);
    expect(specStrata(seed, 0, one).runs.every(([, len]) => len >= 1 && len <= 2)).toBe(true);
    expect(Array.from(strataTable(seed, 1, ABYSS))).not.toEqual(Array.from(strataTable(seed, 0, ABYSS)));
    expect(Array.from(strataTable(seedFromInput('43'), 0, ABYSS))).not.toEqual(Array.from(strataTable(seed, 0, ABYSS)));
    // A layer whose maxLen is below minLen runs exactly its maxLen (no length draw); fixed lengths draw only the layer.
    const short: StrataRule = { ...ABYSS, minLen: 3, maxLen: 5 };
    for (const [st, len] of maximalRuns(strataTable(seed, 2, short)).slice(0, -1)) {
      const lm = ABYSS.layers[layerOf(st)]!.maxLen;
      if (lm < 3) expect(len).toBe(lm);
      else expect(len >= 3 && len <= Math.min(5, lm)).toBe(true);
    }
    expect(Array.from(strataTable(seed, 2, short))).toEqual(specStrata(seed, 2, short).table);
  });

  test('the offset o = round(amp·z / clampSigma), +0 at zero and at amp 0; the lookup wraps every 192 blocks', () => {
    for (const cs of [1, 2, 3]) {
      expect(strataOffset(cs, 6, cs)).toBe(6);
      expect(strataOffset(-cs, 16, cs)).toBe(-16);
      expect(Object.is(strataOffset(0, 6, cs), 0)).toBe(true);
      expect(Object.is(strataOffset(-cs, 0, cs), 0)).toBe(true);
      const next = testRng(1601 + cs);
      for (let i = 0; i < 1000; i++) {
        const z = (2 * testFloat(next) - 1) * cs, amp = 16 * testFloat(next);
        expect(strataOffset(z, amp, cs)).toBe(Math.round((amp * z) / cs) + 0);
      }
    }
    const t = strataTable(seedFromInput('42'), 0, ABYSS);
    for (let y = -64; y <= 319; y++) {
      for (let o = -16; o <= 16; o += 4) expect(strataState(t, y, o)).toBe(t[(((y + o) % 192) + 192) % 192]);
    }
    for (let y = -64; y <= 127; y++) expect(strataState(t, y + 192, 3)).toBe(strataState(t, y, 3));
  });
});

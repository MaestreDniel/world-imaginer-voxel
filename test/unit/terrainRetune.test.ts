import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { autoTangents } from '../../src/core/spline/tangents';
import type { NestedSpline } from '../../src/core/spline/types';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { fillColumnT } from '../../src/metrics/region';
import { JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
import { AIR } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

/**
 * The SP3b retune (spec §8.4, approved by the user after the T1-T5 measurement): T1's lowland band and T2's overhangs
 * failed on the SP1 defaults, so the lowland offset knots, the C 0.05 sigma node and the overhang noise were retuned.
 * The SP1 fixtures stay frozen (they feed the SP1 goldens); the defaults now differ from them exactly at these knots.
 */

/** Every numeric knot of a nested spline, keyed by its path (`C 0.05 / E 0.2 / PV -1`). */
function knotYs(s: NestedSpline, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.points) {
    const key = `${prefix}${s.coord} ${p.x}`;
    if (typeof p.y === 'number') out[key] = p.y;
    else Object.assign(out, knotYs(p.y, `${key} / `));
  }
  return out;
}

/** The knots whose y differs from `base`'s, as [base y, y]; both splines must have the same knot paths. */
function movedKnots(s: NestedSpline, base: NestedSpline): Record<string, [number, number]> {
  const a = knotYs(base);
  const b = knotYs(s);
  expect(Object.keys(b)).toEqual(Object.keys(a));
  const out: Record<string, [number, number]> = {};
  for (const k of Object.keys(a)) if (a[k] !== b[k]) out[k] = [a[k]!, b[k]!];
  return out;
}

/** Tangents are autoTangents' (recomputed from the knots with every d zeroed). */
function zeroD(s: NestedSpline): NestedSpline {
  return { coord: s.coord, points: s.points.map((p) => ({ x: p.x, y: typeof p.y === 'number' ? p.y : zeroD(p.y), d: 0 })) };
}

describe('SP3b retune of the defaults (spec §8.4)', () => {
  test('shape.offset: only the lowland knots (C ≥ 0.05, E ≥ 0.2) move up; the coast and every E ≤ −0.4 knot stay', () => {
    expect(movedKnots(DEFAULTS.shape.offset, OFFSET)).toEqual({
      'C 0.05 / E 0.2 / PV -1': [65, 72], 'C 0.05 / E 0.2 / PV 0': [72, 84], 'C 0.05 / E 0.2 / PV 1': [80, 98],
      'C 0.05 / E 1': [66, 76],
      'C 0.3 / E 0.2 / PV -1': [66, 78], 'C 0.3 / E 0.2 / PV 0': [76, 92], 'C 0.3 / E 0.2 / PV 1': [88, 108],
      'C 0.3 / E 0.6': [70, 90], 'C 0.3 / E 1': [66, 86],
      'C 0.6 / E 0.2 / PV -1': [68, 86], 'C 0.6 / E 0.2 / PV 0': [82, 104], 'C 0.6 / E 0.2 / PV 1': [96, 124],
      'C 0.6 / E 1': [70, 102],
    });
    expect(canonicalJSON(DEFAULTS.shape.offset)).toBe(canonicalJSON(autoTangents(zeroD(DEFAULTS.shape.offset))));
  });

  test('shape.sigma: only the C 0.05 node moves (E −1 PV 12 … 26, E 0 6, E 1 3); jag stays SP1\'s fixture', () => {
    expect(movedKnots(DEFAULTS.shape.sigma, SIGMA)).toEqual({
      'C 0.05 / E -1 / PV -1': [4, 12], 'C 0.05 / E -1 / PV 1': [16, 26], 'C 0.05 / E 0': [3, 6], 'C 0.05 / E 1': [1.2, 3],
    });
    expect(canonicalJSON(DEFAULTS.shape.sigma)).toBe(canonicalJSON(autoTangents(zeroD(DEFAULTS.shape.sigma))));
    expect(canonicalJSON(DEFAULTS.shape.jag)).toBe(canonicalJSON(JAG));
  });

  test('overhang noise: λ 32, 2 octaves, persistence 0.65, yScale 1; no octave below λy 16 (2 × the 8-block corner step)', () => {
    const o = DEFAULTS.density.noises.overhang;
    expect([o.wavelength, o.octaves, o.persistence, o.yScale, o.lacunarity]).toEqual([32, 2, 0.65, 1, 2]);
    const shortestY = o.wavelength / o.yScale / o.lacunarity ** (o.octaves - 1);
    expect(shortestY).toBe(16);
  });

  /** Land tops and the land positions with ≥ 2 solid→air transitions at y ≥ top − 30 (T2's count) of one column. */
  function columnTops(cx: number, cz: number): { tops: number[]; overhangs: number } {
    const ctx = ctxFor('42');
    const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
    expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
    const v = store.proto(cx, cz)!;
    const aux = v.aux()!;
    const solid = new Uint8Array(98304);
    for (let sy = 0; sy < 24; sy++) {
      const b = v.sectionBlocks(sy);
      if (typeof b === 'number') solid.fill(b === AIR ? 0 : 1, sy << 12, (sy + 1) << 12);
      else for (let i = 0; i < 4096; i++) solid[(sy << 12) + i] = b[i] === AIR ? 0 : 1;
    }
    const tops: number[] = [];
    let overhangs = 0;
    for (let p = 0; p < 256; p++) {
      if (aux.worldSurfaceWG[p] !== aux.oceanFloorWG[p]) continue;
      const top = aux.worldSurfaceWG[p]! - 1;
      tops.push(top);
      let n = 0;
      for (let y = Math.max(-64, top - 30); y <= top; y++) if (solid[((y + 64) << 8) | p] === 1 && (y === 319 || solid[((y + 65) << 8) | p] === 0)) n++;
      if (n >= 2) overhangs++;
    }
    return { tops, overhangs };
  }

  test('a lowland plain on the raised knots tops above T1\'s old band [63, 73) (seed 42, column (−937, −1963))', () => {
    const p = columnPoint(ctxFor('42'), 16 * -937 + 8, 16 * -1963 + 8);
    expect(biomeFamily(p.biome)).toBe('lowland');
    expect(p.C).toBeGreaterThan(0.6);
    expect(p.E).toBeGreaterThan(0.2);
    const { tops } = columnTops(-937, -1963);
    expect(tops.length).toBe(256);
    // Before the retune: tops 70 … 73; after: 100 … 109.
    expect(Math.min(...tops)).toBeGreaterThan(90);
  });

  test('a high-σ highland column has overhangs (seed 42, column (−1015, −786))', () => {
    const p = columnPoint(ctxFor('42'), 16 * -1015 + 8, 16 * -786 + 8);
    expect(biomeFamily(p.biome)).toBe('highland');
    const { tops, overhangs } = columnTops(-1015, -786);
    expect(tops.length).toBe(256);
    // Before the retune: 0 of 256 (σ 10.3, overhang λ 80); after: 170 of 256 (σ 18.9, λ 32).
    expect(overhangs).toBeGreaterThanOrEqual(64);
    expect(p.sigma).toBeGreaterThan(16);
  });
});

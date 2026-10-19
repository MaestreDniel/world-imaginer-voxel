import { describe, expect, test } from 'vitest';
import { ARCHIPELAGO_BIOME_TABLE, BIOME_TABLE_DEFAULT, BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import { ARCHIPELAGO_JAG, ARCHIPELAGO_OFFSET, ARCHIPELAGO_SIGMA, JAG_DEFAULT, OFFSET_DEFAULT, SIGMA_DEFAULT } from '../../src/core/params/shapeDefaults';
import { seedFromInput } from '../../src/core/seed';
import { autoTangents } from '../../src/core/spline/tangents';
import type { NestedSpline } from '../../src/core/spline/types';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { lakeCell } from '../../src/gen/column/lakes';
import { newShape, sampleShape } from '../../src/gen/column/shape';
import { createGenContext } from '../../src/gen/context';
import { validateParamTrees } from '../../src/gen/trees';
import { waterRaster } from '../../src/metrics/columnStats';
import { testFloat, testRng } from '../harness/stats';

/**
 * The archipelago preset (SP3e spec §1.3, D8): the default C-keyed values carried through the C map φ with shift
 * 0.42, written as literals. φ's literals at the default values that occur (spec §1.3's table): the test checks the
 * preset against φ of the defaults, so a knot that drifts from either the spec or the default is caught.
 */
const PHI = new Map<number, number>([
  [-1, -1], [-0.6, -0.39], [-0.4, -0.05], [-0.24, 0.18], [-0.16, 0.26], [-0.1, 0.32], [0.05, 0.47],
  [-0.55, -0.305], [-0.22, 0.2], [-0.04, 0.38], [-0.12, 0.3], [-0.02, 0.4], [1, 1],
]);
const phi = (c: number): number => {
  const v = PHI.get(c);
  if (v === undefined) throw new Error(`no φ literal for ${c}`);
  return v;
};

const ARCHIPELAGO = resolveProfile('archipelago');
const CTX = createGenContext(seedFromInput('42'), ARCHIPELAGO);

/** Every numeric knot of a nested spline, keyed by its path (`C 0.47 / E 0.2 / PV -1`), as terrainRetune.test.ts. */
function knotYs(s: NestedSpline, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.points) {
    const key = `${prefix}${s.coord} ${p.x}`;
    if (typeof p.y === 'number') out[key] = p.y;
    else Object.assign(out, knotYs(p.y, `${key} / `));
  }
  return out;
}

/** Tangents are autoTangents' (recomputed from the knots with every d zeroed). */
function zeroD(s: NestedSpline): NestedSpline {
  return { coord: s.coord, points: s.points.map((p) => ({ x: p.x, y: typeof p.y === 'number' ? p.y : zeroD(p.y), d: 0 })) };
}

/** The default's top-level C knots through φ, without those at C ≥ `dropFrom`; nested values kept as they are. */
function throughPhi(s: NestedSpline, dropFrom = Infinity): Array<[number, string]> {
  return s.points.filter((p) => p.x < dropFrom).map((p) => [phi(p.x), canonicalJSON(typeof p.y === 'number' ? p.y : zeroD(p.y))]);
}
const topLevel = (s: NestedSpline): Array<[number, string]> => s.points.map((p) => [p.x, canonicalJSON(typeof p.y === 'number' ? p.y : zeroD(p.y))]);

describe('SP3e archipelago splines (spec §1.3)', () => {
  test('ARCHIPELAGO_OFFSET: §1.3\'s knots and values; the default\'s through φ without its C 0.3 and 0.6 knots', () => {
    expect(knotYs(ARCHIPELAGO_OFFSET)).toEqual({
      'C -1': 16, 'C -0.39': 26, 'C -0.05': 40, 'C 0.18': 52, 'C 0.26': 60,
      'C 0.32 / E -1': 70, 'C 0.32 / E 0': 64, 'C 0.32 / E 1': 63,
      'C 0.47 / E -1 / PV -1': 72, 'C 0.47 / E -1 / PV 0': 96, 'C 0.47 / E -1 / PV 1': 130,
      'C 0.47 / E -0.4 / PV -1': 68, 'C 0.47 / E -0.4 / PV 0': 82, 'C 0.47 / E -0.4 / PV 1': 100,
      'C 0.47 / E 0.2 / PV -1': 72, 'C 0.47 / E 0.2 / PV 0': 84, 'C 0.47 / E 0.2 / PV 1': 98,
      'C 0.47 / E 1': 76,
    });
    expect(topLevel(ARCHIPELAGO_OFFSET)).toEqual(throughPhi(OFFSET_DEFAULT, 0.3));
    expect(canonicalJSON(ARCHIPELAGO_OFFSET)).toBe(canonicalJSON(autoTangents(zeroD(ARCHIPELAGO_OFFSET))));
  });

  test('ARCHIPELAGO_SIGMA and ARCHIPELAGO_JAG: §1.3\'s knots; the defaults through φ', () => {
    expect(knotYs(ARCHIPELAGO_SIGMA)).toEqual({
      'C -1': 3, 'C 0.26': 3, 'C 0.32': 1.5,
      'C 0.47 / E -1 / PV -1': 12, 'C 0.47 / E -1 / PV 1': 26, 'C 0.47 / E 0': 6, 'C 0.47 / E 1': 3,
    });
    expect(knotYs(ARCHIPELAGO_JAG)).toEqual({
      'C 0.32': 0,
      'C 0.47 / E -1 / PV 0.3': 0, 'C 0.47 / E -1 / PV 0.7': 30, 'C 0.47 / E -1 / PV 1': 55,
      'C 0.47 / E -0.5 / PV 0.3': 0, 'C 0.47 / E -0.5 / PV 0.7': 30, 'C 0.47 / E -0.5 / PV 1': 55,
      'C 0.47 / E -0.4': 0,
    });
    expect(topLevel(ARCHIPELAGO_SIGMA)).toEqual(throughPhi(SIGMA_DEFAULT));
    expect(topLevel(ARCHIPELAGO_JAG)).toEqual(throughPhi(JAG_DEFAULT));
    for (const s of [ARCHIPELAGO_SIGMA, ARCHIPELAGO_JAG]) expect(canonicalJSON(s)).toBe(canonicalJSON(autoTangents(zeroD(s))));
  });
});

describe('SP3e archipelago biome table (spec §1.3)', () => {
  test('the default with exactly the C bounds of §1.3\'s table changed', () => {
    const changed: Record<string, readonly [number, number]> = {};
    for (const b of BOX_BIOMES) {
      const a = ARCHIPELAGO_BIOME_TABLE[b];
      const d = BIOME_TABLE_DEFAULT[b];
      expect({ ...a, C: d.C }, b).toEqual(d);
      expect(a.C, b).toEqual([phi(d.C[0]), phi(d.C[1])]);
      if (a.C[0] !== d.C[0] || a.C[1] !== d.C[1]) changed[b] = a.C;
    }
    const COAST = [0.2, 0.38];
    const INLAND = [0.38, 1];
    expect(changed).toEqual({
      deep_ocean: [-1, -0.305], ocean: [-0.305, 0.32], warm_ocean: [-1, 0.32], frozen_ocean: [-1, 0.32],
      beach: COAST, snowy_beach: COAST, stony_shore: COAST,
      ...Object.fromEntries(BOX_BIOMES.slice(7).map((b) => [b, INLAND])),
    });
    expect(Object.keys(ARCHIPELAGO_BIOME_TABLE)).toEqual([...BOX_BIOMES]);
  });
});

describe('SP3e archipelago overlay (spec §1.1)', () => {
  test('resolves to the default plus exactly C λ 840, the three splines, the coast fade, lakes.minC and the table', () => {
    const p = ARCHIPELAGO;
    expect(p.climate.C.wavelength).toBe(840);
    expect(canonicalJSON({ ...p.climate, C: { ...p.climate.C, wavelength: DEFAULTS.climate.C.wavelength } })).toBe(canonicalJSON(DEFAULTS.climate));
    expect(canonicalJSON(p.shape)).toBe(canonicalJSON({ offset: ARCHIPELAGO_OFFSET, sigma: ARCHIPELAGO_SIGMA, jag: ARCHIPELAGO_JAG }));
    expect([p.rivers.coastFadeLo, p.rivers.coastFadeHi]).toEqual([0.3, 0.4]);
    expect([phi(DEFAULTS.rivers.coastFadeLo), phi(DEFAULTS.rivers.coastFadeHi), phi(DEFAULTS.lakes.minC)]).toEqual([0.3, 0.4, 0.32]);
    expect(canonicalJSON({ ...p.rivers, coastFadeLo: -0.12, coastFadeHi: -0.02 })).toBe(canonicalJSON(DEFAULTS.rivers));
    expect(p.lakes.minC).toBe(0.32);
    expect(canonicalJSON({ ...p.lakes, minC: -0.1 })).toBe(canonicalJSON(DEFAULTS.lakes));
    expect(canonicalJSON(p.biomes.table)).toBe(canonicalJSON(ARCHIPELAGO_BIOME_TABLE));
    expect(canonicalJSON({ ...p.biomes, table: DEFAULTS.biomes.table })).toBe(canonicalJSON(DEFAULTS.biomes));
    for (const g of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
      if (!['climate', 'shape', 'rivers', 'lakes', 'biomes'].includes(g)) expect(p[g], g).toBe(DEFAULTS[g]);
    }
  });

  test('passes both tiers: resolveProfile validates the overlay (tier 1), validateParamTrees is [] (tier 2)', () => {
    expect(validateParamTrees(ARCHIPELAGO)).toEqual([]);
  });
});

describe('SP3e archipelago shore (spec §1.3, seed 42)', () => {
  test('10⁴ points over ±2^19: C_u < 0.2 is ocean, offset0 crosses 63 only at C_u in [0.26, 0.32], C ≥ 0.47 has offset0 ≤ 130', () => {
    const next = testRng(3108);
    const c = newClimate();
    const sh = newShape();
    const coords = new Float64Array(6);
    let below = 0;
    let shoreSea = 0;
    let shoreLand = 0;
    let shoreEmin = 1;
    let shoreEmax = -1;
    let inland = 0;
    let maxInland = -Infinity;
    for (let i = 0; i < 10000; i++) {
      // columnPoint's C and offset0 (climate then shape; rivers and lakes do not move offset0).
      const p = { C: 0, E: 0, offset0: 0 };
      sampleClimate(CTX, -524288 + 1048576 * testFloat(next), -524288 + 1048576 * testFloat(next), c);
      [p.C, p.E, p.offset0] = [c.C, c.E, sampleShape(CTX, c, coords, sh).offset0];
      if (p.C < 0.2) below++;
      if (p.C < 0.26) expect(p.offset0, `C ${p.C}`).toBeLessThan(63);
      else if (p.C >= 0.32) expect(p.offset0, `C ${p.C}`).toBeGreaterThanOrEqual(63);
      else {
        if (p.offset0 < 63) shoreSea++;
        else shoreLand++;
        shoreEmin = Math.min(shoreEmin, p.E);
        shoreEmax = Math.max(shoreEmax, p.E);
      }
      if (p.C >= 0.47) {
        inland++;
        maxInland = Math.max(maxInland, p.offset0);
      }
    }
    // Every case is reached: the C < 0.2 ocean, both sides of 63 inside the shore band across E, and the inland plateau.
    expect(below).toBeGreaterThan(1000);
    expect([shoreSea > 0, shoreLand > 0, shoreEmin < -0.5, shoreEmax > 0.5]).toEqual([true, true, true, true]);
    expect(inland).toBeGreaterThan(1000);
    expect(maxInland).toBeLessThanOrEqual(130);
  });

  test('a 128² waterRaster at step 64 centred on (0, 0) is 55-80 % ocean (offset0 < 63; smoke)', () => {
    const n = 128;
    const w = waterRaster(CTX, -32 * n, -32 * n, n, 64);
    let sea = 0;
    for (let k = 0; k < n * n; k++) if (w.offset0[k]! < 63) sea++;
    const share = sea / (n * n);
    expect(share).toBeGreaterThanOrEqual(0.55);
    expect(share).toBeLessThanOrEqual(0.8);
  });
});

/**
 * Lakes below the sea beside it (SP3e spec §1.3, Review Focus): a lake's level Lw is the ring's lowest offset0 − 1 (master
 * §3.5), so on archipelago's low land a lake near the shore can sit far below the sea 8 blocks away. Water v0 has no
 * flow, so the sea column stands as a wall of water above the lake (or its dry basin) until SP7's settle; the spec
 * states it and these counts pin it. Per enabled lake cell with Lw < 62: the largest 63 − Lw over the basin columns
 * (lakeMask 1, its Lw) on an 8-block grid around the cell centre that have a sea neighbour 8 blocks away (lakeMask 0,
 * surfaceWaterLevel 63). A lake column holds water up to Lw or is dry, so 63 − Lw is the step from the sea to it.
 */
describe('SP3e archipelago lakes beside the sea (spec §1.3, seed 42, cells i, j in [−30, 30))', () => {
  const steps = (params: typeof DEFAULTS) => {
    const ctx = createGenContext(seedFromInput('42'), params);
    let lakes = 0, below = 0, low = 0;
    const found: number[] = [];
    for (let i = -30; i < 30; i++) {
      for (let j = -30; j < 30; j++) {
        const cell = lakeCell(ctx, i, j);
        if (!cell.enabled) continue;
        lakes++;
        if (cell.Lw < 63) below++;
        if (cell.Lw >= 62) continue;
        low++;
        const x0 = Math.round(cell.cx), z0 = Math.round(cell.cz);
        const seen = new Map<string, { m: number; level: number; water: number }>();
        const at = (x: number, z: number) => {
          const k = `${x},${z}`;
          let p = seen.get(k);
          if (p === undefined) {
            const r = columnPoint(ctx, x, z);
            p = { m: r.lakeMask, level: r.lakeLevel, water: r.surfaceWaterLevel };
            seen.set(k, p);
          }
          return p;
        };
        let step = -Infinity;
        for (let dx = -192; dx <= 192; dx += 8) {
          for (let dz = -192; dz <= 192; dz += 8) {
            const p = at(x0 + dx, z0 + dz);
            if (p.m !== 1 || p.level !== cell.Lw) continue;
            for (const [ex, ez] of [[8, 0], [-8, 0], [0, 8], [0, -8]] as const) {
              const q = at(x0 + dx + ex, z0 + dz + ez);
              if (q.m === 0 && q.water === 63) step = Math.max(step, 63 - cell.Lw);
            }
          }
        }
        if (step >= 3) found.push(step);
      }
    }
    return { lakes, below, low, stepped: found.length, max: Math.max(0, ...found) };
  };

  test('archipelago has about 3 × the default\'s share of lakes below the sea, and twice its deepest step beside it', () => {
    const arch = steps(ARCHIPELAGO), base = steps(DEFAULTS);
    expect(arch).toEqual({ lakes: 105, below: 28, low: 25, stepped: 8, max: 40 });
    expect(base).toEqual({ lakes: 164, below: 14, low: 9, stepped: 2, max: 18 });
    expect(arch.below / arch.lakes).toBeGreaterThan(3 * (base.below / base.lakes));
  }, 60_000);
});

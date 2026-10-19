import { afterEach, describe, expect, test, vi } from 'vitest';
import { biomeId } from '../../src/gen/biomes/registry';
import { AIR } from '../../src/world/blocks/index';
import {
  analyseColumn, newScatterScratch, newScattered, t1Values, t2Values, t3Values, t5Values, type ScatterColumn, type Scattered,
} from '../harness/terrainScatter';

/**
 * T1-T5's per-column analysis and part bodies, extracted from terrain.metric.ts (SP3e spec §5.1 "Extractions", §5.5):
 * constructed columns, the record mode's populations and the enforce mode's soft-failure messages. The extraction's
 * proof on real columns is the quick tier's Equal-set diff (T1-T5 unchanged).
 */

const SOLID = AIR + 1;
const PLAINS = biomeId('plains');
const FOREST = biomeId('forest');
const STONY = biomeId('stony_peaks');

/** A column from a per-position solidity rule and its aux A heightmaps (`ws`, `of`) and biomes. */
function column(
  solid: (p: number, y: number) => boolean,
  ws: (p: number) => number,
  of: (p: number) => number,
  biome: (p: number) => number,
): ScatterColumn {
  const sections = Array.from({ length: 24 }, (_, sy) => {
    const b = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) b[i] = solid(i & 255, sy * 16 - 64 + (i >> 8)) ? SOLID : AIR;
    return b;
  });
  const aux = {
    worldSurfaceWG: Int16Array.from({ length: 256 }, (_, p) => ws(p)),
    oceanFloorWG: Int16Array.from({ length: 256 }, (_, p) => of(p)),
    surfaceBiome: Uint8Array.from({ length: 256 }, (_, p) => biome(p)),
  };
  return { sectionBlocks: (sy) => sections[sy]!, aux: () => aux };
}

/**
 * Ground to y 70 everywhere (top 70, WS = OF = 71) except: position 0 is sea (floor 40, WS 64 ≠ OF 41); position 1
 * has an overhang (air at 60-62 under a roof up to 70: transitions at 59 and 70, both ≥ top − 30 = 40); position 34
 * (lx 2, lz 2) has a cave at 30-32 (transitions at 29 and 70: 29 < 40, not an overhang, but two transitions at y ≥ −56); position 3
 * holds a 4-block rock (y 80-83) on a 9-block air gap above its top, which is then 83 (ws 84). Biomes: x < 8 plains,
 * x ≥ 8 forest, row z = 15 stony peaks.
 */
function testColumn(): ScatterColumn {
  const top = (p: number): number => (p === 0 ? 40 : p === 3 ? 83 : 70);
  return column(
    (p, y) => {
      if (y > top(p)) return false;
      if (p === 1 && y >= 60 && y <= 62) return false;
      if (p === 34 && y >= 30 && y <= 32) return false;
      if (p === 3 && y > 70 && y < 80) return false;
      return true;
    },
    (p) => (p === 0 ? 64 : top(p) + 1),
    (p) => top(p) + 1,
    (p) => ((p >> 4) === 15 ? STONY : (p & 15) < 8 ? PLAINS : FOREST),
  );
}

describe('analyseColumn (T1-T5 per column)', () => {
  const s = newScattered();
  const seen: Array<[number, number]> = [];
  analyseColumn(s, testColumn(), 3, -2, (x, z) => { seen.push([x, z]); return 75; }, newScatterScratch());

  test('land = WORLD_SURFACE_WG === OCEAN_FLOOR_WG; the top is WS − 1', () => {
    expect(s.columns).toBe(1);
    expect(s.waterPositions).toBe(1);
    expect(s.land).toBe(255);
    expect(s.hist[70 + 64]).toBe(254);
    expect(s.hist[83 + 64]).toBe(1);
    expect(s.hist[40 + 64]).toBe(0);
  });

  test("T2: ≥ 2 solid→air transitions at y ≥ top − 30 (the cave's lower transition is below it)", () => {
    // Positions 1 (the roof) and 3 (the rock: transitions at 70 and 83 ≥ 53); not 34 (29 < 40).
    expect(s.over).toBe(2);
    expect(s.peakLand).toBe(16);
    expect(s.peakColumns).toBe(1);
    expect(s.peakOver).toBe(0);
  });

  test('floating rocks: a run ≤ 6 high on an air gap ≥ 3', () => {
    expect(s.floatPositions).toBe(1);
    expect(s.floatVoxels).toBe(4);
    expect(s.peakFloatPositions).toBe(0);
  });

  test('T5: land positions with exactly one transition at y ≥ −56, at lx, lz ∈ {2, 6, 10, 14}', () => {
    // 16 positions, all land; position 34 (lx 2, lz 2) holds the cave (two transitions).
    expect(s.t5Land).toBe(16);
    expect(s.t5Multi).toBe(1);
    expect(s.t5).toEqual(Array.from({ length: 15 }, () => 5));
    expect(seen).toHaveLength(15);
    expect(seen).toContainEqual([16 * 3 + 6, 16 * -2 + 14]);
    expect(seen).not.toContainEqual([16 * 3 + 2, 16 * -2 + 2]);
  });

  test('T3: land neighbour pairs inside the column, by biome', () => {
    // 240 pairs per axis; the sea position 0 drops its two pairs.
    expect(s.landPairs).toBe(478);
    // plains | forest at x 7-8 on rows 0-14 (15 pairs): same family (lowland), one border edge.
    const e = PLAINS < FOREST ? (PLAINS << 8) | FOREST : (FOREST << 8) | PLAINS;
    expect(s.borderPairs[e]).toBe(15);
    expect(s.borderSteep[e]).toBe(0);
    // stony peaks (row 15) against plains / forest (row 14): 16 cross-family pairs.
    expect(s.crossFamilyPairs).toBe(16);
    // plains inside: rows 0-14, 7 x-pairs and (rows 0-13) 8 z-pairs per column x < 8, minus position 0's two pairs;
    // steep where position 3 (top 83) meets 2 and 4 (x) and 19 (z).
    expect(s.inside[PLAINS]).toBe(15 * 7 + 14 * 8 - 2);
    expect(s.insideSteep[PLAINS]).toBe(3);
  });

  test('water walls: the sea position has land on both sides above its surface', () => {
    // Water 41-63 (23 voxels); neighbours' WS 72 (positions 1 and 16) → no dry air beside it at those y: walls 0.
    expect(s.water).toBe(23);
    expect(s.walls).toBe(0);
  });
});

/** A Scattered with hand-set accumulators: 10 land tops at 70 and 30 at 100, so p5 = 70, p50 = p95 = 100. */
function filled(): Scattered {
  const s = newScattered();
  s.columns = 1;
  s.land = 40;
  s.hist[70 + 64] = 10;
  s.hist[100 + 64] = 30;
  s.over = 4;
  s.peakLand = 10;
  s.peakOver = 5;
  s.peakColumns = 1;
  s.t5 = [3, 1, 2];
  s.t5Land = 4;
  s.t5Multi = 1;
  const e = (PLAINS << 8) | FOREST;
  s.inside[PLAINS] = 10;
  s.insideSteep[PLAINS] = 1;
  s.inside[FOREST] = 10;
  s.insideSteep[FOREST] = 3;
  s.borderPairs[e] = 5;
  s.borderSteep[e] = 2;
  return s;
}

describe('part bodies', () => {
  test('T1: band, span, shares, quantiles', () => {
    const v = t1Values(filled(), 'enforce', 'default');
    expect(v).toMatchObject({ band: 0.75, span: 30, above120: 0, above200: 0, p5: 70, p50: 100, p95: 100, landPositions: 40, landShare: 40 / 256 });
    expect(Object.keys(v).slice(0, 4)).toEqual(['band', 'span', 'above120', 'above200']);
  });

  test('T2: overhang shares', () => {
    expect(t2Values(filled(), 'record', 'default')).toMatchObject({ overhangs: 0.1, overhangsPeaks: 0.5, peakPositions: 10, peakColumns: 1 });
  });

  test("T3: Σ steep / Σ of the two biomes' inside steep shares, over the lowland pairs", () => {
    const v = t3Values(filled(), 'record', 'default');
    // expected per pair (0.1 + 0.3) / 2 = 0.2 → 5 pairs expect 1 steep, 2 seen.
    expect(v.value).toBeCloseTo(2, 12);
    expect(v['borderPairs']).toBe(5);
    expect(v['familyPairs.lowland']).toBe(5);
  });

  test('T5: nearest-rank quantiles of |surfaceEst3 − top|', () => {
    expect(t5Values(filled(), 'record', 'default')).toMatchObject({ median: 2, p90: 3, p99: 3, max: 3, mean: 2, singleSurface: 3, landPositions: 4, multiSurface: 1 });
  });
});

describe("population modes (SP3e spec §5.5: 'Populations are recorded, never enforced')", () => {
  const messages: string[] = [];
  const spy = (): void => {
    vi.spyOn(expect, 'soft').mockImplementation(((n: number, message?: string) => {
      const assertion = { toBeGreaterThanOrEqual: (min: number) => { if (n < min) messages.push(message ?? ''); } };
      return assertion;
    }) as unknown as typeof expect.soft);
  };
  afterEach(() => { vi.restoreAllMocks(); messages.length = 0; });

  test('record mode: an empty population does not fail and writes <part>.population 0', () => {
    spy();
    const s = newScattered();
    const t1 = t1Values(s, 'record', 'archipelago');
    const t2 = t2Values(s, 'record', 'archipelago');
    const t3 = t3Values(s, 'record', 'archipelago');
    const t5 = t5Values(s, 'record', 'archipelago');
    expect(messages).toEqual([]);
    expect(vi.mocked(expect.soft)).not.toHaveBeenCalled();
    for (const part of ['band', 'span', 'above120', 'above200']) expect(t1[`${part}.population`]).toBe(0);
    expect(t2['overhangs.population']).toBe(0);
    expect(t2['overhangsPeaks.population']).toBe(0);
    expect(t3['value.population']).toBe(0);
    for (const part of ['median', 'p90', 'p99']) {
      expect(t5[`${part}.population`]).toBe(0);
      expect(t5[part]).toBeNaN();
    }
  });

  test('record mode writes the populations the minima would read', () => {
    const s = filled();
    expect(t1Values(s, 'record', 'x')['band.population']).toBe(40);
    expect(t2Values(s, 'record', 'x')).toMatchObject({ 'overhangs.population': 40, 'overhangsPeaks.population': 1 });
    expect(t3Values(s, 'record', 'x')['value.population']).toBe(5);
    expect(t5Values(s, 'record', 'x')['median.population']).toBe(3);
  });

  test("enforce mode keeps today's soft-failure messages and writes no population key", () => {
    spy();
    const s = newScattered();
    const all = { ...t1Values(s, 'enforce', 'default'), ...t2Values(s, 'enforce', 'default'), ...t3Values(s, 'enforce', 'default'), ...t5Values(s, 'enforce', 'large_biomes') };
    expect(messages).toEqual([
      'T2.overhangsPeaks (default) peak columns: insufficient sample (0 < 20)',
      'T3 (default) lowland border pairs: insufficient sample (0 < 2000)',
      'T5 (large_biomes) single-surface positions: insufficient sample (0 < 1000)',
    ]);
    expect(Object.keys(all).filter((k) => k.includes('population'))).toEqual([]);
  });
});

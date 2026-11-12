import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonValue } from '../../src/core/params/json';
import { biomeId } from '../../src/gen/biomes/registry';
import { fillColumnT } from '../../src/metrics/region';
import { AIR } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { CARVERS_OFF } from '../harness/carverParams';
import { ctxFor } from '../harness/gen';
import { cavesMuted } from '../harness/sp5cTrees';
import {
  analyseColumn, metricsProfiles, newScatterScratch, newScattered, preCaveSolidity, presetRecord, SCATTER_PROFILES, scatterColumns,
  solidity, t1Values, t2Values, t3Values, t4Sites, t5Values, transitions, type ScatterColumn, type Scattered,
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

/**
 * A column from a per-position solidity rule and its aux A heightmaps (`ws`, `of`) and biomes; `cave` (default none)
 * the cave tag of each voxel (SP6a spec §3.2: a tagged voxel is air the caves carved out of pre-cave rock).
 */
function column(
  solid: (p: number, y: number) => boolean,
  ws: (p: number) => number,
  of: (p: number) => number,
  biome: (p: number) => number,
  cave: ((p: number, y: number) => number) | null = null,
): ScatterColumn {
  const sections = Array.from({ length: 24 }, (_, sy) => {
    const b = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) b[i] = solid(i & 255, sy * 16 - 64 + (i >> 8)) ? SOLID : AIR;
    return b;
  });
  const caves = Array.from({ length: 24 }, (_, sy) => {
    if (cave === null) return 0;
    const c = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) c[i] = cave(i & 255, sy * 16 - 64 + (i >> 8));
    return c;
  });
  const aux = {
    worldSurfaceWG: Int16Array.from({ length: 256 }, (_, p) => ws(p)),
    oceanFloorWG: Int16Array.from({ length: 256 }, (_, p) => of(p)),
    surfaceBiome: Uint8Array.from({ length: 256 }, (_, p) => biome(p)),
  };
  return { sectionBlocks: (sy) => sections[sy]!, sectionCave: (sy) => caves[sy]!, aux: () => aux };
}

/**
 * Ground to y 70 everywhere (top 70, WS = OF = 71) except: position 0 is sea (floor 40, WS 64 ≠ OF 41); position 1
 * has an overhang (air at 60-62 under a roof up to 70: transitions at 59 and 70, both ≥ top − 30 = 40); position 34
 * (lx 2, lz 2) has a cave at 30-32 (transitions at 29 and 70: 29 < 40, not an overhang, but two transitions at y ≥ −56); position 3
 * holds a 4-block rock (y 80-83) on a 9-block air gap above its top, which is then 83 (ws 84). Biomes: x < 8 plains,
 * x ≥ 8 forest, row z = 15 stony peaks.
 */
function testColumn(cave: ((p: number, y: number) => number) | null = null): ScatterColumn {
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
    cave,
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

  test('T5 (SP6a spec §10.4): |surfaceEst3 − the pre-cave top|, the pre-cave top read over the true top; without it, the true top', () => {
    const t = newScattered();
    const asked: Array<[number, number, number]> = [];
    // A cave opening at (lx 6, lz 14): the pre-cave top is 4 above the true top 70.
    const preTop = (x: number, z: number, top: number): number => {
      asked.push([x, z, top]);
      return x === 16 * 3 + 6 && z === 16 * -2 + 14 ? top + 4 : top;
    };
    analyseColumn(t, testColumn(), 3, -2, () => 75, newScatterScratch(), preTop);
    expect(asked).toHaveLength(15);
    expect(asked).toContainEqual([16 * 3 + 6, 16 * -2 + 14, 70]);
    // Positions in lz-then-lx order; (lx 6, lz 14) is the 13th of 15 (position 34 is not single-surface): |75 − 74|.
    expect(t.t5).toEqual([...Array.from({ length: 12 }, () => 5), 1, 5, 5]);
    expect(t.t5Raised).toBe(1);
    expect(s.t5Raised).toBe(0);
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

describe('T2 reads pre-cave solidity: solid or tagged (SP6a spec §10.4)', () => {
  test('a tagged voxel is pre-cave solid: the overhang made of cave air under position 1\'s roof is no overhang', () => {
    // Position 1's air at 60-62 tagged cheese, and an entrance (tag 5) opening position 2 at 66-70: the pre-cave column is
    // solid to 70 at both, so T2 sees neither; T1 still reads the true top (66 − 1 = 65 at position 2) and T5's
    // single-surface test the true solidity.
    const cave = (p: number, y: number): number => (p === 1 && y >= 60 && y <= 62 ? 1 : p === 2 && y >= 66 && y <= 70 ? 5 : 0);
    const solid = (p: number, y: number): boolean => y <= (p === 0 ? 40 : p === 3 ? 83 : 70) && cave(p, y) === 0 && !(p === 3 && y > 70 && y < 80) && !(p === 34 && y >= 30 && y <= 32);
    const top = (p: number): number => (p === 0 ? 40 : p === 3 ? 83 : p === 2 ? 65 : 70);
    const col = column(solid, (p) => (p === 0 ? 64 : top(p) + 1), (p) => top(p) + 1, (p) => ((p >> 4) === 15 ? STONY : (p & 15) < 8 ? PLAINS : FOREST), cave);
    const pre = preCaveSolidity(col, new Uint8Array(98304));
    expect(pre[((61 + 64) << 8) | 1]).toBe(1);
    expect(pre[((68 + 64) << 8) | 2]).toBe(1);
    expect(pre[((71 + 64) << 8) | 2]).toBe(0);
    expect(pre[((31 + 64) << 8) | 34]).toBe(0);
    const t = newScattered();
    analyseColumn(t, col, 3, -2, () => 75, newScatterScratch());
    // Only position 3's rock (2 transitions at y ≥ 83 − 30) is an overhang; with the true solidity position 1 was one too.
    expect(t.over).toBe(1);
    expect(t.hist[65 + 64]).toBe(1);
    expect(t.floatPositions).toBe(1);
    expect(t.floatVoxels).toBe(4);
  });

  /**
   * Seed '42', chunk column (2, −1): an entrance holes its surface (the review pose of `caves.examples.json`, voxel
   * (38, 84, −16)) and caves lie within 30 blocks under its tops. The same column with the carving family taps muted
   * (`cavesMuted`) and the carvers off (`CARVERS_OFF`) is SP5c's solidity.
   */
  const CX = 2;
  const CZ = -1;
  const tColumn = (patched: boolean): ColumnView => {
    const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
    const ctx = patched ? ctxFor('42', { ...CARVERS_OFF, density: { defs: cavesMuted(DEFAULT_DENSITY_TREE) as JsonValue } }) : ctxFor('42');
    expect(fillColumnT(store, ctx, CX, CZ, () => false)).toBe(true);
    return store.proto(CX, CZ)!;
  };

  test('on a column with caves under its top, the pre-cave solidity and T2\'s counts equal those with the caves muted and the carvers off', () => {
    const carved = tColumn(false);
    const muted = tColumn(true);
    const pre = preCaveSolidity(carved, new Uint8Array(98304));
    const plain = solidity(muted, new Uint8Array(98304));
    const truth = solidity(carved, new Uint8Array(98304));
    let differ = 0;
    // Counted and asserted once, with the first differing voxel in the message (not one assertion per voxel).
    let mismatches = 0;
    let first = -1;
    for (let i = 0; i < 98304; i++) {
      if (pre[i] !== plain[i]) {
        mismatches++;
        if (first < 0) first = i;
      }
      if (truth[i] !== plain[i]) differ++;
    }
    expect(mismatches, first < 0 ? '' : `${mismatches} voxels differ, the first ${first}: pre-cave ${pre[first]}, muted ${plain[first]}`).toBe(0);
    // Not vacuous: the caves carve thousands of the column's voxels, and change the true solidity's transition count
    // within 30 blocks of some land top.
    expect(differ).toBeGreaterThan(1000);
    const aux = carved.aux()!;
    let changed = 0;
    for (let p = 0; p < 256; p++) {
      const ws = aux.worldSurfaceWG[p]!;
      if (ws !== aux.oceanFloorWG[p]!) continue;
      if (transitions(truth, p, ws - 31, ws - 1) !== transitions(plain, p, ws - 31, ws - 1)) changed++;
    }
    expect(changed).toBeGreaterThan(0);
    const a = newScattered();
    const b = newScattered();
    analyseColumn(a, carved, CX, CZ, () => 0, newScatterScratch());
    analyseColumn(b, muted, CX, CZ, () => 0, newScatterScratch());
    expect(a.land).toBe(b.land);
    expect([a.over, a.peakLand, a.peakOver, a.floatPositions, a.floatVoxels, a.peakFloatPositions])
      .toEqual([b.over, b.peakLand, b.peakOver, b.floatPositions, b.floatVoxels, b.peakFloatPositions]);
  });
});

describe('the presets\' full-tier records and Z1 (SP3e spec §5.3, §5.5)', () => {
  test('solidity and transitions are T2\'s: the overhang position has 2 transitions at y ≥ top − 30, the cave one 1', () => {
    const solid = solidity(testColumn(), new Uint8Array(98304));
    expect(solid[((70 + 64) << 8) | 1]).toBe(1);
    expect(solid[((61 + 64) << 8) | 1]).toBe(0);
    expect(transitions(solid, 1, 40, 70)).toBe(2);
    expect(transitions(solid, 34, 40, 70)).toBe(1);
    expect(transitions(solid, 34, -56, 70)).toBe(2);
    expect(transitions(solid, 2, -64, 319)).toBe(1);
  });

  test('presetRecord: <part> → <part>.<preset>, <part>.population → <part>.population.<preset>, extras likewise', () => {
    const t2 = t2Values(filled(), 'record', 'amplified');
    const rec = presetRecord(t2, 'amplified');
    expect(rec['overhangs.amplified']).toBe(t2.overhangs);
    expect(rec['overhangs.population.amplified']).toBe(40);
    expect(rec['overhangsPeaks.population.amplified']).toBe(1);
    expect(rec['floatingRockShare.amplified']).toBe(t2.floatingRockShare);
    expect(Object.keys(rec)).toEqual(Object.keys(t2).map((k) => `${k}.amplified`));
    expect(presetRecord({ value: 1.25, 'value.population': 2048, seconds: 3 }, 'floating_islands')).toEqual({
      'value.floating_islands': 1.25, 'value.population.floating_islands': 2048, 'seconds.floating_islands': 3,
    });
  });

  test('presetRecord keeps an empty population\'s NaN value and its population 0', () => {
    const rec = presetRecord(t5Values(newScattered(), 'record', 'archipelago'), 'archipelago');
    expect(rec['median.archipelago']).toBeNaN();
    expect(rec['p99.population.archipelago']).toBe(0);
    expect(rec['singleSurface.archipelago']).toBe(0);
  });

  test('presetRecord refuses a profile that is not a draft preset', () => {
    expect(() => presetRecord({ band: 0 }, 'default')).toThrow(RangeError);
    expect(() => presetRecord({ band: 0 }, 'toString')).toThrow('presetRecord: toString is not a draft preset');
  });
});

describe('the profile split (SP6b spec §13 L2, L3; ruling P1): a filtered run draws every profile and keeps its own', () => {
  const SEEDS = ['42', '1'];
  const COLUMNS = { default: 4096, large_biomes: 16384 };
  const RANGE = { default: 1024, large_biomes: 4096 };

  test('metricsProfiles: absent is both profiles in draw order; a name or a list is read in draw order; an unknown name throws', () => {
    expect(metricsProfiles(undefined)).toEqual(['default', 'large_biomes']);
    expect(metricsProfiles(undefined)).toEqual(SCATTER_PROFILES);
    expect(metricsProfiles('default')).toEqual(['default']);
    expect(metricsProfiles('large_biomes')).toEqual(['large_biomes']);
    expect(metricsProfiles('large_biomes,default')).toEqual(['default', 'large_biomes']);
    expect(() => metricsProfiles('amplified')).toThrow("METRICS_PROFILES 'amplified': unknown profile 'amplified' (default, large_biomes)");
    expect(() => metricsProfiles('')).toThrow("METRICS_PROFILES '': unknown profile '' (default, large_biomes)");
  });

  test('scatterColumns: the active profile\'s columns per seed equal the unsplit run\'s, whichever profile is filtered out', () => {
    const both = scatterColumns(SCATTER_PROFILES, SEEDS, COLUMNS, RANGE);
    expect(both.default!.map((c) => c.length)).toEqual([4096, 4096]);
    expect(both.large_biomes!.map((c) => c.length)).toEqual([16384, 16384]);
    const large = scatterColumns(['large_biomes'], SEEDS, COLUMNS, RANGE);
    expect(Object.keys(large)).toEqual(['large_biomes']);
    expect(large.large_biomes).toEqual(both.large_biomes);
    const def = scatterColumns(['default'], SEEDS, COLUMNS, RANGE);
    expect(Object.keys(def)).toEqual(['default']);
    expect(def.default).toEqual(both.default);
    // The draws are one sequence: large_biomes' columns are not a fresh generator's (skipping default's draws would move them).
    const fresh = scatterColumns(['large_biomes'], SEEDS, { default: 0, large_biomes: 16384 }, RANGE);
    expect(fresh.large_biomes).not.toEqual(both.large_biomes);
    for (const [cx, cz] of both.large_biomes!.flat()) expect(Math.abs(cx) <= 4096 && Math.abs(cz) <= 4096).toBe(true);
  });

  test('t4Sites: the active profile\'s sites and draws equal the unsplit run\'s; the skipped profile\'s rejection draws are still made', () => {
    const both = t4Sites(SCATTER_PROFILES, ['42'], 4, RANGE);
    expect(both.default!.sites).toHaveLength(4);
    expect(both.large_biomes!.sites).toHaveLength(4);
    expect(both.default!.draws).toBeGreaterThanOrEqual(4);
    const large = t4Sites(['large_biomes'], ['42'], 4, RANGE);
    expect(Object.keys(large)).toEqual(['large_biomes']);
    expect(large.large_biomes).toEqual(both.large_biomes);
    expect(t4Sites(['default'], ['42'], 4, RANGE).default).toEqual(both.default);
    for (const s of both.large_biomes!.sites) expect(s.seed).toBe('42');
  }, 60_000);
});

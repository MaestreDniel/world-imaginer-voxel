import { afterEach, describe, expect, test, vi } from 'vitest';
import { GRASS_BLOCK, REGISTRY, SNOW_BLOCK, STONE } from '../../src/world/blocks/index';
import {
  MIN_SURFACE_POPULATION, s1Values, s2Values, s3Values, surfaceCommonValues,
} from '../harness/surfaceAnalysis';
import { newSurfaceAcc, surfaceBiomeId, type SurfaceAcc } from '../harness/surfaceScatter';
import { ymod16Test } from '../harness/stats';

/**
 * S1-S3's part bodies, extracted from surface.metric.ts (SP3e spec §5.1 "Extractions", §5.5): one population's
 * record on a constructed accumulator, the record mode's populations and the enforce mode's soft-failure messages.
 * The extraction's proof on real columns is the quick tier's Equal-set diff (S1-S3, B2.voxel, B4.voxel unchanged).
 */

const NAME = (s: number): string => REGISTRY.stateKey(s);

/** A constructed accumulator: counts chosen so every part and the extras have a known value. */
function filled(): SurfaceAcc {
  const a = newSurfaceAcc();
  a.columns = 4;
  a.positions = 1024;
  a.landTops = 1200;
  a.wetTops = 24;
  a.topMismatch = 2;
  a.seconds = 1.5;
  a.buried = 3;
  a.grassNoSky = 5;
  a.snowNoSky = 7;
  a.stoneBelow0 = 2000;
  a.deepBelow0 = 1500;
  a.stoneAbove8 = 4000;
  a.deepAbove8 = 40;
  a.bedrockFloor = 1000;
  a.snowLineTops = 1100;
  a.snowLineSnow = 990;
  a.snowLineCliffs = 9;
  // ymod: 16 residues × 6 classes, 20 per cell except a skew in class 0 at residue 3.
  for (let r = 0; r < 16; r++) for (let k = 0; k < 6; k++) a.ymod[6 * r + k] = 20 + (r === 3 && k === 0 ? 30 : 0);
  a.ymodColumns = 16 * 6 * 20 + 30;
  a.topHist[70 + 64] = 600;
  a.topHist[71 + 64] = 300;
  a.topHist[72 + 64] = 300;
  a.sdHist[3] = 1000;
  a.sdHist[20] = 24;
  a.blocks[STONE] = 300;
  a.blocks[GRASS_BLOCK] = 100;
  a.landTopStates[GRASS_BLOCK] = 1100;
  a.landTopStates[SNOW_BLOCK] = 100;
  a.wetTopStates[STONE] = 24;
  return a;
}

describe('S1-S3 part bodies (one population)', () => {
  test('S1: the parts, then the populations (enforce: `<part>.n`), then the extras, then the common keys', () => {
    const v = s1Values(filled(), 'enforce', 'default');
    const t = ymod16Test(filled().ymod);
    expect(v).toMatchObject({ buried: 3, grassNoSky: 5, ymod16: t.p, 'buried.n': 1200, 'grassNoSky.n': 1200, 'ymod16.n': 1950 });
    expect(Object.keys(v).slice(0, 6)).toEqual(['buried', 'grassNoSky', 'ymod16', 'buried.n', 'grassNoSky.n', 'ymod16.n']);
    expect(Object.keys(v).slice(6, 10)).toEqual(['ymod16.chi2', 'ymod16.df', 'ymod16.rows', 'ymod16.classesLeft']);
    expect(Object.keys(v).slice(-5)).toEqual(['landTops', 'wetTops', 'columns', 'seconds', 'topMismatch']);
    expect(v['ymod16.chi2']).toBe(t.chi2);
    expect(v['ymod16.class0']).toBe(16 * 20 + 30);
    expect(v['ymod16.class5plus']).toBe(16 * 20);
    expect(v['landTopYmod16.raw.6']).toBe(600); // y 70 ≡ 6 (mod 16)
    expect(v['surfaceDepth.3']).toBeCloseTo(1000 / 1024, 15);
    expect(v['surfaceDepth.20']).toBeCloseTo(24 / 1024, 15);
    expect('surfaceDepth.19' in v).toBe(false); // > 11 and empty
    expect(v['surfaceDepth.mean']).toBeCloseTo((3 * 1000 + 20 * 24) / 1024, 15);
    expect(v[`blockShare.${NAME(STONE)}`]).toBe(0.75);
    expect(v[`landTopShare.${NAME(SNOW_BLOCK)}`]).toBe(100 / 1200);
    expect(v[`wetTopShare.${NAME(STONE)}`]).toBe(1);
    expect(v[`patchCoverage.taiga.n`]).toBe(0);
    expect(v['patchCoverage.lake.clay']).toBeNaN(); // 0 / 0
    expect(v).toMatchObject({ landTops: 1200, wetTops: 24, columns: 4, seconds: 1.5, topMismatch: 2 });
  });

  test('S2: deepslate shares of the stone-like voxels and the bedrock floor share', () => {
    const v = s2Values(filled(), 'enforce', 'default');
    expect(v).toEqual({
      deepslateBelow0: 0.75, deepslateAbove8: 0.01, bedrockFloor: 1000 / 1024,
      'deepslateBelow0.n': 2000, 'deepslateAbove8.n': 4000,
      stoneBelow0: 500, positions: 1024, columns: 4, seconds: 1.5, topMismatch: 2,
    });
    expect(Object.keys(v).slice(0, 3)).toEqual(['deepslateBelow0', 'deepslateAbove8', 'bedrockFloor']);
  });

  test('S3: the snowline share and the snow below the sky-open run', () => {
    const v = s3Values(filled(), 'enforce', 'default');
    expect(v).toEqual({
      snowAboveLine: 0.9, snowNoSky: 7, 'snowAboveLine.n': 1100, 'snowNoSky.n': 1200,
      snowLineCliffTops: 9, snowLineNotSnow: 110, columns: 4, seconds: 1.5, topMismatch: 2,
    });
  });

  test('surfaceCommonValues: columns, seconds, topMismatch', () => {
    expect(surfaceCommonValues(filled())).toEqual({ columns: 4, seconds: 1.5, topMismatch: 2 });
  });

  test('S1 patch coverage reads the per-biome patch counts', () => {
    const a = filled();
    const taiga = surfaceBiomeId('taiga');
    a.patchTops[taiga] = 50;
    a.patchStates[taiga * REGISTRY.stateCount + STONE] = 5;
    const v = s1Values(a, 'record', 'x');
    expect(v['patchCoverage.taiga.n']).toBe(50);
  });
});

describe("population modes (SP3e spec §5.5: 'Populations are recorded, never enforced')", () => {
  const messages: string[] = [];
  const spy = (): void => {
    vi.spyOn(expect, 'soft').mockImplementation(((x: unknown, message?: string) => ({
      toBeGreaterThanOrEqual: (min: number) => { if ((x as number) < min) messages.push(message ?? ''); },
      toBe: (want: unknown) => { if (x !== want) messages.push(message ?? ''); },
    })) as unknown as typeof expect.soft);
  };
  afterEach(() => { vi.restoreAllMocks(); messages.length = 0; });

  test('record mode: an empty population does not fail and writes <part>.population 0, no <part>.n', () => {
    spy();
    const a = newSurfaceAcc();
    const s1 = s1Values(a, 'record', 'archipelago');
    const s2 = s2Values(a, 'record', 'archipelago');
    const s3 = s3Values(a, 'record', 'archipelago');
    expect(messages).toEqual([]);
    expect(vi.mocked(expect.soft)).not.toHaveBeenCalled();
    const all = { ...s1, ...s2, ...s3 };
    for (const part of ['buried', 'grassNoSky', 'ymod16', 'deepslateBelow0', 'deepslateAbove8', 'bedrockFloor', 'snowAboveLine', 'snowNoSky']) {
      expect(all[`${part}.population`]).toBe(0);
      expect(`${part}.n` in all).toBe(false);
    }
    expect(s1.ymod16).toBeNaN(); // a degenerate table
    expect(s2.deepslateBelow0).toBeNaN();
  });

  test('record mode writes the populations the minima would read (and bedrockFloor, which has none)', () => {
    const a = filled();
    expect(s1Values(a, 'record', 'x')).toMatchObject({ 'buried.population': 1200, 'grassNoSky.population': 1200, 'ymod16.population': 1950 });
    expect(s2Values(a, 'record', 'x')).toMatchObject({ 'deepslateBelow0.population': 2000, 'deepslateAbove8.population': 4000, 'bedrockFloor.population': 1024 });
    expect(s3Values(a, 'record', 'x')).toMatchObject({ 'snowAboveLine.population': 1100, 'snowNoSky.population': 1200 });
  });

  test("enforce mode keeps today's soft-failure messages (minimum 1,000) and the degenerate check", () => {
    spy();
    const a = newSurfaceAcc();
    s1Values(a, 'enforce', 'default');
    s2Values(a, 'enforce', 'large_biomes');
    s3Values(a, 'enforce', 'default');
    expect(MIN_SURFACE_POPULATION).toBe(1000);
    const classes = ymod16Test(a.ymod).classes.join(', ');
    expect(messages).toEqual([
      'buried (default): insufficient sample (0 < 1000)',
      'grassNoSky (default): insufficient sample (0 < 1000)',
      'ymod16 (default): insufficient sample (0 < 1000)',
      `S1.ymod16 (default): degenerate table (classes ${classes})`,
      'deepslateBelow0 (large_biomes): insufficient sample (0 < 1000)',
      'deepslateAbove8 (large_biomes): insufficient sample (0 < 1000)',
      'snowAboveLine (default): insufficient sample (0 < 1000)',
      'snowNoSky (default): insufficient sample (0 < 1000)',
    ]);
  });

  test('enforce mode passes a filled population without a message', () => {
    spy();
    const a = filled();
    s1Values(a, 'enforce', 'default');
    s2Values(a, 'enforce', 'default');
    s3Values(a, 'enforce', 'default');
    expect(messages).toEqual([]);
  });
});

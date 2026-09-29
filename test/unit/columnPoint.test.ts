import { describe, expect, test } from 'vitest';
import { pickBiome } from '../../src/gen/biomes/picker';
import { biomeFamily, biomeName } from '../../src/gen/biomes/registry';
import { newClimate, sampleClimate } from '../../src/gen/column/climate';
import { columnPoint, newPointRecord, samplePoint, waterLevel } from '../../src/gen/column/columnPoint';
import { newLake, sampleLakes } from '../../src/gen/column/lakes';
import { newRiver, sampleRivers } from '../../src/gen/column/rivers';
import { newShape, sampleShape } from '../../src/gen/column/shape';
import { steepAt } from '../../src/gen/column/steep';
import { ctxFor } from '../harness/gen';
import { samplePoints } from '../../src/metrics/noiseStats';
import { testFloat, testRng } from '../harness/stats';

describe('waterLevel (master §3.7)', () => {
  test.each<[string, [number, boolean, number, number], number]>([
    ['lake inside', [70, false, 1, 80], 80],
    ['lake rim is not water', [85, false, 0.5, -Infinity], -Infinity],
    ['river', [60, true, 0, -Infinity], 63],
    ['ocean floor', [40, false, 0, -Infinity], 63],
    ['dry land', [70, false, 0, -Infinity], -Infinity],
    ['exactly sea level is dry', [63, false, 0, -Infinity], -Infinity],
  ])('%s', (_n, args, expected) => {
    expect(waterLevel(...args)).toBe(expected);
  });
});

describe('columnPoint', () => {
  const ctx = ctxFor();
  const next = testRng(1001);
  const pts = Array.from({ length: 300 }, () => [-200000 + 400000 * testFloat(next), -200000 + 400000 * testFloat(next)] as const);
  test('composes the stages in the §2.6 order', () => {
    const coords = new Float64Array(6);
    for (const [x, z] of pts) {
      const p = columnPoint(ctx, x, z);
      const c = sampleClimate(ctx, x, z, newClimate());
      const s = sampleShape(ctx, c, coords, newShape());
      const r = sampleRivers(ctx, c, s, newRiver());
      const l = sampleLakes(ctx, x, z, r.offset, r.sigma, r.jag, newLake());
      expect([p.C, p.E, p.W, p.T, p.H, p.R, p.PV]).toEqual([c.C, c.E, c.W, c.T, c.H, c.R, c.PV]);
      expect([p.offset0, p.sigma0, p.jag0]).toEqual([s.offset0, s.sigma0, s.jag0]);
      expect(p.steep).toBe(steepAt(ctx, x, z, coords));
      expect([p.riverDist, p.riverWet, p.gorge]).toEqual([r.riverDist, r.wet, r.gorge]);
      expect([p.offset, p.sigma, p.jag, p.lakeMask]).toEqual([l.offset, l.sigma, l.jag, l.lakeMask]);
      expect(p.surfaceEst).toBe(p.offset);
      expect(p.islandMask).toBe(0);
      expect(p.biome).toBe(pickBiome(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, r.wet));
    }
  });
  test('river columns are river biomes; oceans sit below sea level', () => {
    let ocean = 0;
    let land = 0;
    for (const [x, z] of pts) {
      const p = columnPoint(ctx, x, z);
      if (p.riverWet) expect(biomeFamily(p.biome)).toBe('river');
      if (biomeName(p.biome) === 'deep_ocean') expect(p.offset).toBeLessThan(63);
      if (p.surfaceWaterLevel === 63 && !p.riverWet) ocean++;
      if (p.surfaceWaterLevel === -Infinity) land++;
    }
    expect(ocean).toBeGreaterThan(50);
    expect(land).toBeGreaterThan(80);
  });
  test('rivers and gorges only where the column would be land without them (offset0 ≥ 63)', () => {
    const rec = newPointRecord();
    const sample = samplePoints('columnPoint.riverOnLand', 20000);
    let wet = 0;
    for (let i = 0; i < sample.n; i++) {
      samplePoint(ctx, sample.x[i]!, sample.z[i]!, false, rec);
      if (rec.riverWet) wet++;
      if (rec.riverWet || rec.gorge || biomeFamily(rec.biome) === 'river') expect(rec.offset0).toBeGreaterThanOrEqual(63);
    }
    expect(wet).toBeGreaterThan(50);
  });
  test('regression: seed 42 at (−38343.6, 44384), open ocean on the R zero set, is not a river', () => {
    // Reported under GENERATOR_VERSION 1 parameters (R wavelength 1400, widths 5/9), where R's zero set crosses here.
    const v1 = ctxFor('42', { climate: { R: { wavelength: 1400 } }, rivers: { widthMin: 5, widthVar: 9 } });
    const p = columnPoint(v1, -38343.6, 44384);
    expect(p.C).toBeLessThan(-0.8);
    expect(p.offset0).toBeLessThan(63);
    expect(p.riverDist).toBeLessThan(2.5);
    expect([p.riverWet, p.gorge]).toEqual([false, false]);
    expect(biomeFamily(p.biome)).toBe('ocean');
    expect(p.surfaceWaterLevel).toBe(63);
    expect(p.offset).toBe(p.offset0);
  });
  test('deterministic plain data; samplePoint without steep matches every other field', () => {
    expect(columnPoint(ctxFor(), 1234.5, -987.25)).toEqual(columnPoint(ctx, 1234.5, -987.25));
    const rec = newPointRecord();
    for (const [x, z] of pts.slice(0, 50)) {
      const full = columnPoint(ctx, x, z);
      samplePoint(ctx, x, z, false, rec);
      expect({ ...rec, steep: full.steep }).toEqual(full);
      expect(Number.isNaN(rec.steep)).toBe(true);
    }
  });
});

describe('random valid parameters keep every field finite (levels may be −∞)', () => {
  test('20 random parameter documents × 40 points', async () => {
    const { randomParams } = await import('../harness/params');
    const { SCHEMA } = await import('../../src/core/params/schema');
    const { createGenContext } = await import('../../src/gen/context');
    const { seedFromInput } = await import('../../src/core/seed');
    const rng = testRng(1004);
    for (let d = 0; d < 20; d++) {
      const ctx = createGenContext(seedFromInput(String(d)), randomParams(SCHEMA, rng));
      for (let i = 0; i < 40; i++) {
        const p = columnPoint(ctx, -300000 + 600000 * testFloat(rng), -300000 + 600000 * testFloat(rng));
        for (const k of ['C', 'E', 'W', 'T', 'H', 'R', 'PV', 'offset0', 'sigma0', 'jag0', 'steep', 'riverDist', 'riverStrength', 'lakeMask', 'offset', 'sigma', 'jag', 'surfaceEst'] as const) {
          expect(Number.isFinite(p[k]), `doc ${d} ${k} = ${p[k]}`).toBe(true);
        }
        for (const k of ['lakeLevel', 'lakeFloor', 'surfaceWaterLevel'] as const) expect(Number.isNaN(p[k])).toBe(false);
      }
    }
  }, 60_000);
});

describe('terrain does not depend on biomes (SP2a replacement for T3 on 2D relief)', () => {
  test('swapping every biome box and the zoom jitter leaves every height and water field unchanged', () => {
    const base = ctxFor('42');
    const t = base.params.biomes.table;
    const shuffled = Object.fromEntries(Object.keys(t).map((k, i, keys) => [k, { ...t[keys[(i + 7) % keys.length]! as keyof typeof t], priority: t[k as keyof typeof t].priority }]));
    const other = ctxFor('42', { biomes: { table: shuffled as typeof t, zoomJitter: 0.2 } });
    const next = testRng(1003);
    let biomeChanged = 0;
    for (let i = 0; i < 500; i++) {
      const x = -100000 + 200000 * testFloat(next);
      const z = -100000 + 200000 * testFloat(next);
      const a = columnPoint(base, x, z);
      const b = columnPoint(other, x, z);
      expect([b.offset, b.sigma, b.jag, b.surfaceEst, b.surfaceWaterLevel, b.steep]).toEqual([a.offset, a.sigma, a.jag, a.surfaceEst, a.surfaceWaterLevel, a.steep]);
      if (a.biome !== b.biome) biomeChanged++;
    }
    expect(biomeChanged).toBeGreaterThan(100);
  });
});

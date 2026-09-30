import { toUniform } from '../../src/core/noise/cdf';
import { noiseFor } from '../../src/gen/context';
import { biomeFamily, biomeId, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { newPick, pickBox } from '../../src/gen/biomes/picker';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn } from '../../src/gen/column/spawn';
import { Moments, samplePoints } from '../../src/metrics/noiseStats';
import { ctxFor } from '../harness/gen';
import { metricTest } from '../harness/metric';

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const RARE = new Set(['jagged_peaks', 'frozen_peaks', 'badlands', 'volcano']);
const TAIGA_OR_WINDSWEPT = new Set([biomeId('windswept_hills'), biomeId('taiga'), biomeId('snowy_taiga')]);
const COAST_BIOMES = new Set([biomeId('beach'), biomeId('snowy_beach'), biomeId('stony_shore')]);

metricTest('B1', ['minShare', 'minRareShare', 'largestLand', 'oceanFamilyMin', 'oceanFamilyMax', 'ties', 'outside'], () => {
  const seeds = pick(2, 4, 8);
  const n = pick(40000, 100000, 250000);
  const counts = new Float64Array(SURFACE_BIOMES.length);
  const p = newPick();
  let ties = 0;
  let outside = 0;
  let total = 0;
  for (let s = 1; s <= seeds; s++) {
    const ctx = ctxFor(String(s));
    const pts = samplePoints(`B1.${s}`, n);
    for (let i = 0; i < n; i++) {
      const c = columnPoint(ctx, pts.x[i]!, pts.z[i]!);
      counts[c.biome]!++;
      total++;
      if (c.riverWet) continue;
      pickBox(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, c.offset0, p);
      if (p.runnerUp === p.fitness) ties++;
      if (p.fitness > 0) outside++;
    }
  }
  let minShare = 1;
  let minRareShare = 1;
  let largestLand = 0;
  let ocean = 0;
  SURFACE_BIOMES.forEach((name, id) => {
    const share = counts[id]! / total;
    if (RARE.has(name)) minRareShare = Math.min(minRareShare, share);
    else minShare = Math.min(minShare, share);
    const fam = biomeFamily(id);
    if (fam === 'ocean') ocean += share;
    else if (fam !== 'river') largestLand = Math.max(largestLand, share);
  });
  return { minShare, minRareShare, largestLand, oceanFamilyMin: ocean, oceanFamilyMax: ocean, ties: ties / total, outside: outside / total };
});

metricTest('B4', ['hotColdSpruceWindswept', 'coastBandBeach'], () => {
  const n = pick(60000, 200000, 500000);
  let spruce = 0;
  let spruceBad = 0;
  let coast = 0;
  let coastBeach = 0;
  for (let s = 1; s <= 2; s++) {
    const ctx = ctxFor(String(s));
    const pts = samplePoints(`B4.${s}`, n);
    for (let i = 0; i < n; i++) {
      const c = columnPoint(ctx, pts.x[i]!, pts.z[i]!);
      if (TAIGA_OR_WINDSWEPT.has(c.biome)) {
        spruce++;
        const hot = c.T > 0.6;
        const coldWindswept = c.biome === biomeId('windswept_hills') && c.T < -0.6;
        if (hot || coldWindswept) spruceBad++;
      }
      if (c.C >= -0.22 && c.C <= -0.1 && c.surfaceWaterLevel === -Infinity) {
        coast++;
        if (COAST_BIOMES.has(c.biome)) coastBeach++;
      }
    }
  }
  return { hotColdSpruceWindswept: spruceBad / spruce, coastBandBeach: coastBeach / coast };
});

metricTest('N4', ['originSdRatio', 'spawnTopShare', 'spawnDistinct', 'spawnOnLand'], () => {
  const seeds = 64;
  const fields = ['C', 'E', 'W', 'T', 'H', 'R'] as const;
  const origin = fields.map(() => new Moments());
  const global = fields.map(() => new Moments());
  const spawnCounts = new Map<number, number>();
  let onLand = 0;
  for (let s = 1; s <= seeds; s++) {
    const ctx = ctxFor(String(s));
    fields.forEach((f, k) => {
      const nz = noiseFor(ctx, `climate.${f}`);
      origin[k]!.add(toUniform(nz.z2(0, 0)));
      for (let i = 0; i < pick(64, 256, 1024); i++) global[k]!.add(toUniform(nz.z2(i * 7919 - 400000, i * -6271 + 300000)));
    });
    const sp = findSpawn(ctx);
    spawnCounts.set(sp.biome, (spawnCounts.get(sp.biome) ?? 0) + 1);
    const p = columnPoint(ctx, sp.x, sp.z);
    if (p.surfaceWaterLevel === -Infinity && !sp.fallback) onLand++;
  }
  const originSdRatio = Math.min(...fields.map((_, k) => origin[k]!.sd / global[k]!.sd));
  return { originSdRatio, spawnTopShare: Math.max(...spawnCounts.values()) / seeds, spawnDistinct: spawnCounts.size, spawnOnLand: onLand / seeds };
});

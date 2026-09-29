import { waterRaster, type WaterRaster } from '../../src/metrics/columnStats';
import { components } from '../harness/flood';
import { ctxFor } from '../harness/gen';
import { metricTest } from '../harness/metric';

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const STEP = 4;
const N = 512;
/** Region origins (blocks): 2048-block squares spread over the colKey window. */
const REGIONS: ReadonlyArray<readonly [number, number]> = [
  [-2048, -2048], [100000, -40000], [-150000, 90000], [220000, 210000], [-300000, -250000], [40000, 380000], [-420000, 10000], [300000, -330000],
];

const rasters = (() => {
  const cache = new Map<string, WaterRaster[]>();
  return (count: number): WaterRaster[] => {
    const key = String(count);
    let r = cache.get(key);
    if (r === undefined) {
      r = [];
      for (let s = 1; s <= 2; s++) for (const [x0, z0] of REGIONS.slice(0, count)) r.push(waterRaster(ctxFor(String(s)), x0, z0, N, STEP));
      cache.set(key, r);
    }
    return r;
  };
})();

const land = (r: WaterRaster, k: number) => r.river[k] === 1 || r.offset[k]! >= 63;
const km2 = (cells: number) => (cells * STEP * STEP) / 1e6;

metricTest('B2', ['medianLength', 'landShareMin', 'landShareMax', 'mouths', 'gorgesPer100km2', 'dryRiverBiome'], () => {
  const lengths: Array<[len: number, cells: number]> = [];
  let riverCells = 0;
  let landCells = 0;
  let long = 0;
  let longMouth = 0;
  let gorge = 0;
  let highLand = 0;
  for (const r of rasters(pick(2, 4, 8))) {
    const n = r.n;
    const wet = new Uint8Array(n * n);
    for (let k = 0; k < n * n; k++) {
      if (r.river[k] === 1) { wet[k] = 1; riverCells++; }
      if (land(r, k)) landCells++;
      if (r.offset0[k]! >= 120 && land(r, k)) highLand++;
      if (r.river[k] === 2 && r.offset[k]! <= r.offset0[k]! - 8) gorge++;
    }
    const c = components(wet, n);
    for (let id = 1; id <= c.count; id++) {
      if (c.size[id]! < 3) continue;
      const dx = (c.bbox[4 * id + 2]! - c.bbox[4 * id]! + 1) * STEP;
      const dz = (c.bbox[4 * id + 3]! - c.bbox[4 * id + 1]! + 1) * STEP;
      const len = Math.hypot(dx, dz);
      lengths.push([len, c.size[id]!]);
      if (len < 300) continue;
      long++;
      let mouth = false;
      for (let k = 0; k < n * n && !mouth; k++) {
        if (c.label[k] !== id) continue;
        const i = k % n;
        const j = (k - i) / n;
        for (let dj = -1; dj <= 1 && !mouth; dj++) for (let di = -1; di <= 1 && !mouth; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const kk = jj * n + ii;
          if (r.river[kk] !== 1 && r.offset[kk]! < 63 && r.lakeInside[kk] === 0) mouth = true;
        }
      }
      if (mouth) longMouth++;
    }
  }
  // Median length weighted by river cells: half of all river water lies in components at least this long.
  lengths.sort((a, b) => a[0] - b[0]);
  const mass = lengths.reduce((s, l) => s + l[1], 0);
  let acc = 0;
  let medianLength = 0;
  for (const [len, cells] of lengths) { acc += cells; if (acc >= mass / 2) { medianLength = len; break; } }
  const share = riverCells / landCells;
  const gorgeColumns = (gorge * STEP * STEP) / 256;
  return {
    medianLength, landShareMin: share, landShareMax: share,
    mouths: long === 0 ? 0 : longMouth / long, gorgesPer100km2: highLand === 0 ? 0 : gorgeColumns / (km2(highLand) / 100), dryRiverBiome: 0,
  };
});

metricTest('B5', ['perKm2Min', 'perKm2Max', 'highShare'], () => {
  let lakes = 0;
  let high = 0;
  let landCells = 0;
  for (const r of rasters(pick(2, 4, 8))) {
    const n = r.n;
    for (let k = 0; k < n * n; k++) if (land(r, k) || r.lakeInside[k] === 1) landCells++;
    const c = components(r.lakeInside, n);
    for (let id = 1; id <= c.count; id++) {
      lakes++;
      for (let k = 0; k < n * n; k++) if (c.label[k] === id) { if (r.lakeLevel[k]! >= 70) high++; break; }
    }
  }
  const per = lakes / km2(landCells);
  return { perKm2Min: per, perKm2Max: per, highShare: lakes === 0 ? 0 : high / lakes };
});

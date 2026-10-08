import { describe, expect, test } from 'vitest';
import { deriveSeed, hash2, type Seed64 } from '../../src/core/hash';
import {
  buildColumnSample, latticeIndex, LEVEL_FIELDS, nearestCornerIndex, newColumnSample, readBiome, readField, readLevel,
  SAMPLE_FIELDS, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { SurfaceNoise, SurfaceNoiseSource } from '../../src/gen/surface/rules';
import {
  depthHash01, depthHashSeed, fillSurfaceBiomes, newSurfaceScan, runAt, scanColumn, SURFACE_DEPTH_NOISE, surfaceDepthOf,
  surfaceDepthMax, surfaceScanSettings, tEff, type SurfaceScanParams, type SurfaceScanSettings,
} from '../../src/gen/surface/scan';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

/** A uniform [0, 1) stream over the harness's u32 test RNG. */
function unit(seed: number): () => number {
  const r = testRng(seed);
  return () => r() / 4294967296;
}

const SEED: Seed64 = [42, 0];
const DEFAULT_PARAMS: SurfaceScanParams = { depthMul: 1, lapse: 0.006, lapseBase: 80 };
const VOXELS = 98304;
/** Index of voxel (p, y) in the stage's column order `256·(y + 64) + p`. */
const at = (p: number, y: number): number => 256 * (y + 64) + p;

function constNoise(v: number, clampSigma = 3, dims: 2 | 3 = 2): SurfaceNoise {
  return { dims, remap: 'none', clampSigma, z2: () => v };
}
function sourceOf(n: SurfaceNoise | undefined): SurfaceNoiseSource {
  return (name) => (name === SURFACE_DEPTH_NOISE ? n : undefined);
}
function settingsWith(n: SurfaceNoise, params: SurfaceScanParams = DEFAULT_PARAMS): SurfaceScanSettings {
  return surfaceScanSettings(SEED, params, sourceOf(n));
}

/** A hand-built column: every field of the sample constant (T −0.2, steep 0.5, no lake) at (cx, cz). */
function flatSample(cx = 0, cz = 0): ColumnSample {
  const s = newColumnSample();
  s.cx = cx;
  s.cz = cz;
  for (const f of SAMPLE_FIELDS) s.f[f].fill(0);
  for (const f of LEVEL_FIELDS) s.f[f].fill(-Infinity);
  s.f.T.fill(-0.2);
  s.f.steep.fill(0.5);
  return s;
}

function fill(a: Uint8Array, p: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) a[at(p, y)] = 1;
}

/** Every run of position p as [yTop, yBottom, waterAbove, waterTop] (waterTop only when waterAbove). */
function runsOf(scan: ReturnType<typeof newSurfaceScan>, p: number): number[][] {
  const out: number[][] = [];
  for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
    const w = scan.runWaterAbove[r]!;
    out.push(w ? [scan.runTop[r]!, scan.runBottom[r]!, 1, scan.runWaterTop[r]!] : [scan.runTop[r]!, scan.runBottom[r]!, 0]);
  }
  return out;
}

describe('surface scan (SP3c spec §3.2)', () => {
  const biomes = new Uint8Array(256);

  test('runs: maximal solid runs top-down, the first is sky-open; y −64 is not scanned', () => {
    const solid = new Uint8Array(VOXELS);
    const water = new Uint8Array(VOXELS);
    // p 0: ground −63 … 40, an overhang 50 … 60; p 1: nothing solid above bedrock; p 2: one voxel at 319 and one at −63;
    // p 3: ground only; bedrock (y −64) is solid in every position and never starts or extends a run.
    for (let p = 0; p < 256; p++) solid[at(p, -64)] = 1;
    fill(solid, 0, -63, 40);
    fill(solid, 0, 50, 60);
    fill(solid, 2, 319, 319);
    fill(solid, 2, -63, -63);
    fill(solid, 3, -63, 70);
    const scan = newSurfaceScan();
    scanColumn(scan, settingsWith(constNoise(0)), flatSample(), solid, water, biomes);
    expect(runsOf(scan, 0)).toEqual([[60, 50, 0], [40, -63, 0]]);
    expect(runsOf(scan, 1)).toEqual([]);
    expect(runsOf(scan, 2)).toEqual([[319, 319, 0], [-63, -63, 0]]);
    expect(runsOf(scan, 3)).toEqual([[70, -63, 0]]);
    expect(scan.runFirst[0]).toBe(0);
    expect(scan.runFirst[256]).toBe(5);
    // runAt: the run holding a solid voxel (floorDepth = runTop − y, ceilDepth = y − runBottom), −1 off the runs.
    const first = scan.runFirst[0]!;
    expect(runAt(scan, 0, 60)).toBe(first);
    expect(runAt(scan, 0, 55)).toBe(first);
    expect(runAt(scan, 0, 50)).toBe(first);
    expect(runAt(scan, 0, 49)).toBe(-1);
    expect(runAt(scan, 0, 41)).toBe(-1);
    expect(runAt(scan, 0, 40)).toBe(first + 1);
    expect(runAt(scan, 0, -63)).toBe(first + 1);
    expect(runAt(scan, 0, -64)).toBe(-1);
    expect(runAt(scan, 0, 61)).toBe(-1);
    expect(runAt(scan, 1, 0)).toBe(-1);
    expect(runAt(scan, 2, 319)).toBe(scan.runFirst[2]);
    expect(runAt(scan, 2, -63)).toBe(scan.runFirst[2]! + 1);
    expect(runAt(scan, 2, 0)).toBe(-1);
  });

  test('runs: 192 alternating runs in every position fit (49,152 per column)', () => {
    const solid = new Uint8Array(VOXELS);
    for (let p = 0; p < 256; p++) for (let y = -63; y <= 319; y += 2) solid[at(p, y)] = 1;
    const scan = newSurfaceScan();
    scanColumn(scan, settingsWith(constNoise(0)), flatSample(), solid, new Uint8Array(VOXELS), biomes);
    expect(scan.runFirst[256]).toBe(49152);
    const r = runsOf(scan, 255);
    expect(r.length).toBe(192);
    expect(r[0]).toEqual([319, 319, 0]);
    expect(r[191]).toEqual([-63, -63, 0]);
  });

  test('water: waterAbove and the top of the contiguous water directly above each run', () => {
    const solid = new Uint8Array(VOXELS);
    const water = new Uint8Array(VOXELS);
    // p 0: sea floor 50, water 51 … 63.
    fill(solid, 0, -63, 50); fill(water, 0, 51, 63);
    // p 1: an air gap at 51, water 52 … 63: no water directly above.
    fill(solid, 1, -63, 50); fill(water, 1, 52, 63);
    // p 2: water 51 … 55, air 56, water 57 … 63: waterTop is 55.
    fill(solid, 2, -63, 50); fill(water, 2, 51, 55); fill(water, 2, 57, 63);
    // p 3: an overhang 70 … 80 with dry air above; the lower run's top 54 under water 55 … 60, air 61 … 69.
    fill(solid, 3, -63, 54); fill(water, 3, 55, 60); fill(solid, 3, 70, 80);
    // p 4: water flags on solid voxels are ignored; water right up to y 319.
    fill(solid, 4, -63, 100); fill(water, 4, 90, 319);
    // p 5: water directly under an overhang's bottom does not count for the overhang (it is below it).
    fill(solid, 5, -63, 20); fill(water, 5, 21, 69); fill(solid, 5, 70, 75);
    const scan = newSurfaceScan();
    scanColumn(scan, settingsWith(constNoise(0)), flatSample(), solid, water, biomes);
    expect(runsOf(scan, 0)).toEqual([[50, -63, 1, 63]]);
    expect(runsOf(scan, 1)).toEqual([[50, -63, 0]]);
    expect(runsOf(scan, 2)).toEqual([[50, -63, 1, 55]]);
    expect(runsOf(scan, 3)).toEqual([[80, 70, 0], [54, -63, 1, 60]]);
    expect(runsOf(scan, 4)).toEqual([[100, -63, 1, 319]]);
    expect(runsOf(scan, 5)).toEqual([[75, 70, 0], [20, -63, 1, 69]]);
  });

  test('a second scan over the same object resets everything', () => {
    const scan = newSurfaceScan();
    const solid = new Uint8Array(VOXELS);
    const water = new Uint8Array(VOXELS);
    for (let p = 0; p < 256; p++) { fill(solid, p, -63, 10); fill(solid, p, 20, 30); fill(water, p, 31, 40); }
    scanColumn(scan, settingsWith(constNoise(3)), flatSample(), solid, water, biomes);
    expect(scan.runFirst[256]).toBe(512);
    const solid2 = new Uint8Array(VOXELS);
    fill(solid2, 7, 0, 5);
    scanColumn(scan, settingsWith(constNoise(-3)), flatSample(1, 2), solid2, new Uint8Array(VOXELS), biomes);
    expect(scan.cx).toBe(1);
    expect(scan.cz).toBe(2);
    expect(scan.runFirst[256]).toBe(1);
    expect(runsOf(scan, 7)).toEqual([[5, 0, 0]]);
    expect(runsOf(scan, 0)).toEqual([]);
    expect(scan.surfaceDepth.every((d) => d === 0)).toBe(true);
  });

  test('per-position readouts: steep and T bilinear (readField), lake at the nearest quart corner, the biome buffer', () => {
    const ctx = ctxFor('42');
    for (const [cx, cz] of [[0, 0], [-3, 7], [1500, -820]] as const) {
      const s = buildColumnSample(ctx, cx, cz, newColumnSample());
      const bio = new Uint8Array(256);
      fillSurfaceBiomes(s, ctx, bio);
      const scan = newSurfaceScan();
      scanColumn(scan, settingsWith(constNoise(0)), s, new Uint8Array(VOXELS), new Uint8Array(VOXELS), bio);
      for (let p = 0; p < 256; p++) {
        const x = 16 * cx + (p & 15);
        const z = 16 * cz + (p >> 4);
        expect(bio[p]).toBe(readBiome(s, ctx, x, z));
        expect(scan.biome[p]).toBe(bio[p]);
        expect(Object.is(scan.steep[p], readField(s, 'steep', x, z))).toBe(true);
        expect(Object.is(scan.T[p], readField(s, 'T', x, z))).toBe(true);
        expect(Object.is(scan.lakeLevel[p], readLevel(s, 'lakeLevel', x, z))).toBe(true);
      }
    }
  });

  test('nearestCornerIndex is readLevel\'s corner (ties to the lower corner), and the scan reads lakeLevel there', () => {
    const s = flatSample(-2, 5);
    for (let k = 0; k < 49; k++) s.f.lakeLevel[k] = k;
    for (let p = 0; p < 256; p++) {
      const x = -32 + (p & 15);
      const z = 80 + (p >> 4);
      const k = nearestCornerIndex(s, x, z);
      expect(readLevel(s, 'lakeLevel', x, z)).toBe(k);
      // lx 0 … 2 → corner 0, 3 … 6 → 1 (6 = 1.5 quarts ties low), 7 … 10 → 2, 11 … 14 → 3, 15 → 4.
      const lx = p & 15;
      const i = lx <= 2 ? 0 : lx <= 6 ? 1 : lx <= 10 ? 2 : lx <= 14 ? 3 : 4;
      const lz = p >> 4;
      const j = lz <= 2 ? 0 : lz <= 6 ? 1 : lz <= 10 ? 2 : lz <= 14 ? 3 : 4;
      expect(k).toBe(latticeIndex(i, j));
    }
    // One finite lake corner (1, 1): exactly the positions it is nearest to see a finite lakeLevel.
    s.f.lakeLevel.fill(-Infinity);
    s.f.lakeLevel[latticeIndex(1, 1)] = 70;
    const scan = newSurfaceScan();
    scanColumn(scan, settingsWith(constNoise(0)), s, new Uint8Array(VOXELS), new Uint8Array(VOXELS), biomes);
    let lake = 0;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15;
      const lz = p >> 4;
      const near = lx >= 3 && lx <= 6 && lz >= 3 && lz <= 6;
      expect(scan.lakeLevel[p]).toBe(near ? 70 : -Infinity);
      if (near) lake++;
    }
    expect(lake).toBe(16);
  });

  test('surfaceDepth = max(0, ⌊3 + 2.75·depthMul·Ns + 0.25·hash01⌋) with hash01 from surface.depthHash', () => {
    expect(depthHashSeed(SEED)).toBe(deriveSeed(SEED, 'surface.depthHash'));
    const hs = depthHashSeed(SEED);
    expect(depthHash01(hs, 5, -9)).toBe(hash2(hs, 5, -9) / 4294967296);
    // A noise that varies with (x, z), so every position gets its own Ns.
    const ns: SurfaceNoise = { dims: 2, remap: 'none', clampSigma: 3, z2: (x, z) => Math.sin(0.37 * x + 0.11 * z) * 2.9 };
    for (const depthMul of [1, 0.35, 2]) {
      const set = settingsWith(ns, { ...DEFAULT_PARAMS, depthMul });
      const scan = newSurfaceScan();
      scanColumn(scan, set, flatSample(-40, 13), new Uint8Array(VOXELS), new Uint8Array(VOXELS), biomes);
      let zeros = 0;
      for (let p = 0; p < 256; p++) {
        const x = -640 + (p & 15);
        const z = 208 + (p >> 4);
        const h = hash2(hs, x, z) / 4294967296;
        const want = Math.max(0, Math.floor(3 + 2.75 * depthMul * ns.z2(x, z) + 0.25 * h));
        expect(scan.surfaceDepth[p]).toBe(want);
        expect(surfaceDepthOf(ns.z2(x, z), h, depthMul)).toBe(want);
        if (want === 0) zeros++;
      }
      if (depthMul >= 1) expect(zeros).toBeGreaterThan(0);
    }
  });

  test('surfaceDepth ∈ [0, SD_MAX], SD_MAX = ⌊3.25 + 2.75·depthMul·clampSigma⌋ (11 at the defaults), both ends reached', () => {
    expect(surfaceDepthMax(1, 3)).toBe(11);
    expect(surfaceDepthMax(0, 3)).toBe(3);
    expect(surfaceDepthMax(2, 3)).toBe(19);
    expect(surfaceDepthMax(1, 8)).toBe(25);
    expect(settingsWith(constNoise(0)).sdMax).toBe(11);
    expect(settingsWith(constNoise(0, 4), { ...DEFAULT_PARAMS, depthMul: 0.5 }).sdMax).toBe(8);
    const scan = newSurfaceScan();
    const empty = new Uint8Array(VOXELS);
    scanColumn(scan, settingsWith(constNoise(3)), flatSample(), empty, empty, biomes);
    expect(Array.from(scan.surfaceDepth).every((d) => d === 11)).toBe(true);
    scanColumn(scan, settingsWith(constNoise(-3)), flatSample(), empty, empty, biomes);
    expect(Array.from(scan.surfaceDepth).every((d) => d === 0)).toBe(true);
    scanColumn(scan, settingsWith(constNoise(2), { ...DEFAULT_PARAMS, depthMul: 0 }), flatSample(), empty, empty, biomes);
    expect(Array.from(scan.surfaceDepth).every((d) => d === 3)).toBe(true);
    // Random Ns in [−c, c], hash01 in [0, 1), depthMul on the schema's grid: never outside [0, SD_MAX].
    const r = unit(3201);
    for (let k = 0; k < 20000; k++) {
      const depthMul = Math.floor(r() * 41) * 0.05;
      const c = 1 + Math.floor(r() * 8);
      const n = (2 * r() - 1) * c;
      const d = surfaceDepthOf(k % 50 === 0 ? c : n, k % 7 === 0 ? 4294967295 / 4294967296 : r(), depthMul);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(surfaceDepthMax(depthMul, c));
    }
  });

  test('T_eff(y) = T − lapse·max(0, y − lapseBase)', () => {
    expect(tEff(-0.2, 80, 0.006, 80)).toBe(-0.2);
    expect(tEff(-0.2, -64, 0.006, 80)).toBe(-0.2);
    expect(tEff(-0.2, 180, 0.006, 80)).toBe(-0.2 - 0.006 * 100);
    expect(tEff(0.5, 81, 0.01, 80)).toBe(0.5 - 0.01);
    expect(tEff(0.5, 319, 0, 80)).toBe(0.5);
  });

  test('settings: the depth noise must be a dims-2 surface.noises.depth; lapse and lapseBase carried', () => {
    expect(SURFACE_DEPTH_NOISE).toBe('surface.noises.depth');
    const set = settingsWith(constNoise(0, 3), { depthMul: 1.5, lapse: 0.01, lapseBase: 70 });
    expect(set.depthMul).toBe(1.5);
    expect(set.lapse).toBe(0.01);
    expect(set.lapseBase).toBe(70);
    expect(set.depthHashSeed).toBe(deriveSeed(SEED, 'surface.depthHash'));
    expect(set.sdMax).toBe(surfaceDepthMax(1.5, 3));
    expect(() => surfaceScanSettings(SEED, DEFAULT_PARAMS, sourceOf(undefined))).toThrow(/surface\.noises\.depth/);
    expect(() => surfaceScanSettings(SEED, DEFAULT_PARAMS, sourceOf(constNoise(0, 3, 3)))).toThrow(/2D/);
  });

  test('wrong array sizes are a RangeError', () => {
    const scan = newSurfaceScan();
    const set = settingsWith(constNoise(0));
    const ok = new Uint8Array(VOXELS);
    expect(() => scanColumn(scan, set, flatSample(), new Uint8Array(100), ok, biomes)).toThrow(RangeError);
    expect(() => scanColumn(scan, set, flatSample(), ok, new Uint8Array(100), biomes)).toThrow(RangeError);
    expect(() => scanColumn(scan, set, flatSample(), ok, ok, new Uint8Array(255))).toThrow(RangeError);
    expect(() => fillSurfaceBiomes(flatSample(), ctxFor('42'), new Uint8Array(10))).toThrow(RangeError);
  });

  test('the scan reads nothing outside its column: equal inputs in two columns give equal runs and depths', () => {
    const solid = new Uint8Array(VOXELS);
    const water = new Uint8Array(VOXELS);
    const r = unit(3202);
    for (let p = 0; p < 256; p++) {
      const top = 20 + Math.floor(r() * 80);
      fill(solid, p, -63, top);
      if (r() < 0.3) fill(water, p, top + 1, 63);
      if (r() < 0.2) fill(solid, p, top + 10, top + 14);
    }
    const a = newSurfaceScan();
    const b = newSurfaceScan();
    scanColumn(a, settingsWith(constNoise(1.25)), flatSample(3, 3), solid, water, biomes);
    scanColumn(b, settingsWith(constNoise(1.25)), flatSample(-9000, 4000), solid, water, biomes);
    expect(Array.from(a.runFirst)).toEqual(Array.from(b.runFirst));
    const n = a.runFirst[256]!;
    expect(Array.from(a.runTop.subarray(0, n))).toEqual(Array.from(b.runTop.subarray(0, n)));
    expect(Array.from(a.runBottom.subarray(0, n))).toEqual(Array.from(b.runBottom.subarray(0, n)));
    expect(Array.from(a.runWaterAbove.subarray(0, n))).toEqual(Array.from(b.runWaterAbove.subarray(0, n)));
  });
});

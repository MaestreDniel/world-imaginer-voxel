import { describe, expect, test } from 'vitest';
import { deriveSeed, hash3, type Seed64 } from '../../src/core/hash';
import { biomeId } from '../../src/gen/biomes/registry';
import { caveBiomeOfPass } from '../../src/gen/biomes/cavePicker';
import {
  biomeHolds, biomeMask, caveBiomeHere, caveBiomeHolds, caveBiomeMask, gradientSeed, lakeHolds, noiseThresholdHolds, skyOpenHolds,
  steepHolds, stoneDepthHolds, temperatureBelowHolds, verticalGradientHolds, waterHolds, yAboveHolds,
} from '../../src/gen/surface/conditions';
import { newSurfaceScan, scanColumn } from '../../src/gen/surface/scan';
import { caveBiomeHandColumn, randomSurfaceColumn, surfaceFuzzSettings, withCaveBiomes } from '../harness/surfaceFuzz';
import { testRng } from '../harness/stats';

const SEED: Seed64 = [42, 0];

describe('condition helpers (SP3c spec §3.1, §3.2)', () => {
  test('biome: the per-block surface biome is in the set (any order, duplicates harmless)', () => {
    const m = biomeMask(['desert', 'beach', 'desert']);
    expect(biomeHolds(m, biomeId('desert'))).toBe(true);
    expect(biomeHolds(m, biomeId('beach'))).toBe(true);
    expect(biomeHolds(m, biomeId('plains'))).toBe(false);
    expect(biomeHolds(m, biomeId('river'))).toBe(false);
    const empty = biomeMask([]);
    for (let b = 0; b < 28; b++) expect(biomeHolds(empty, b)).toBe(false);
    expect(() => biomeMask(['atlantis'])).toThrow(/atlantis/);
  });

  test('stoneDepth: floorDepth (floor) or ceilDepth (ceiling) ≤ offset (+ surfaceDepth when addSurfaceDepth)', () => {
    // floorDepth 3, ceilDepth 9, surfaceDepth 2
    expect(stoneDepthHolds('floor', 3, 9, 3, false, 2)).toBe(true);
    expect(stoneDepthHolds('floor', 3, 9, 2, false, 2)).toBe(false);
    expect(stoneDepthHolds('floor', 3, 9, 1, true, 2)).toBe(true);
    expect(stoneDepthHolds('floor', 3, 9, 0, true, 2)).toBe(false);
    expect(stoneDepthHolds('ceiling', 3, 9, 9, false, 2)).toBe(true);
    expect(stoneDepthHolds('ceiling', 3, 9, 8, false, 2)).toBe(false);
    expect(stoneDepthHolds('ceiling', 3, 9, 7, true, 2)).toBe(true);
    expect(stoneDepthHolds('ceiling', 3, 9, -1, true, 2)).toBe(false);
    expect(stoneDepthHolds('floor', 0, 0, 0, true, 0)).toBe(true);
  });

  test('water: no water above the run, or (runTop ? yTop : y) ≥ waterTop + offset', () => {
    // run top 60, voxel y 55, water up to 63
    expect(waterHolds(false, 0, 55, 60, 0, false)).toBe(true);
    expect(waterHolds(false, 0, 55, 60, 100, true)).toBe(true);
    expect(waterHolds(true, 63, 55, 60, 0, false)).toBe(false);
    expect(waterHolds(true, 63, 55, 60, 0, true)).toBe(false);
    expect(waterHolds(true, 63, 55, 60, -3, true)).toBe(true);
    expect(waterHolds(true, 63, 55, 60, -4, true)).toBe(true);
    expect(waterHolds(true, 63, 55, 60, -2, true)).toBe(false);
    expect(waterHolds(true, 63, 55, 60, -8, false)).toBe(true);
    expect(waterHolds(true, 63, 55, 60, -7, false)).toBe(false);
  });

  test('yAbove: (runTop ? yTop : y) ≥ minY', () => {
    expect(yAboveHolds(70, 90, 80, true)).toBe(true);
    expect(yAboveHolds(70, 90, 80, false)).toBe(false);
    expect(yAboveHolds(80, 79, 80, false)).toBe(true);
    expect(yAboveHolds(80, 79, 80, true)).toBe(false);
  });

  test('verticalGradient: the seed is deriveSeed(seed, surface.gradient.<lo>.<hi>)', () => {
    expect(gradientSeed(SEED, 0, 8)).toBe(deriveSeed(SEED, 'surface.gradient.0.8'));
    expect(gradientSeed(SEED, -64, -59)).toBe(deriveSeed(SEED, 'surface.gradient.-64.-59'));
    expect(gradientSeed(SEED, 0, 8)).not.toBe(gradientSeed(SEED, 0, 9));
    expect(gradientSeed(SEED, 0, 8)).not.toBe(gradientSeed([43, 0], 0, 8));
  });

  test('verticalGradient: always at y ≤ trueAtAndBelow, never at y ≥ falseAtAndAbove, hash3 dither in between', () => {
    const s = gradientSeed(SEED, 0, 8);
    for (let x = -40; x < 40; x += 7) {
      for (let z = -40; z < 40; z += 5) {
        for (const y of [-64, -1, 0]) expect(verticalGradientHolds(s, x, y, z, 0, 8)).toBe(true);
        for (const y of [8, 9, 319]) expect(verticalGradientHolds(s, x, y, z, 0, 8)).toBe(false);
        for (let y = 1; y <= 7; y++) {
          const u = hash3(s, x, y, z) / 4294967296;
          expect(verticalGradientHolds(s, x, y, z, 0, 8)).toBe(u < (8 - y) / 8);
        }
      }
    }
  });

  test('verticalGradient: the probability falls linearly over the dither band', () => {
    const s = gradientSeed(SEED, -64, -59);
    const n = 64 * 64;
    for (let y = -63; y <= -60; y++) {
      let hits = 0;
      for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) if (verticalGradientHolds(s, x, y, z, -64, -59)) hits++;
      expect(Math.abs(hits / n - (-59 - y) / 5)).toBeLessThan(0.03);
    }
  });

  test('steep: steep ≥ min', () => {
    expect(steepHolds(1.2, 1.2)).toBe(true);
    expect(steepHolds(1.19, 1.2)).toBe(false);
    expect(steepHolds(5, 0)).toBe(true);
  });

  test('noiseThreshold: the closed range min ≤ z ≤ max', () => {
    expect(noiseThresholdHolds(0.55, 0.55, 8)).toBe(true);
    expect(noiseThresholdHolds(0.5499, 0.55, 8)).toBe(false);
    expect(noiseThresholdHolds(3, 0.55, 8)).toBe(true);
    expect(noiseThresholdHolds(-0.55, -8, 0 - 0.55)).toBe(true);
    expect(noiseThresholdHolds(-0.54, -8, 0 - 0.55)).toBe(false);
    expect(noiseThresholdHolds(1, 1, 1)).toBe(true);
    expect(noiseThresholdHolds(-3, -8, -3)).toBe(true);
  });

  test('temperatureBelow: T_eff < t (strict)', () => {
    expect(temperatureBelowHolds(-0.61, -0.6)).toBe(true);
    expect(temperatureBelowHolds(-0.6, -0.6)).toBe(false);
    expect(temperatureBelowHolds(0.2, -0.6)).toBe(false);
  });

  test('skyOpen: the run is its position\'s sky-open run (the scan\'s skyRun)', () => {
    expect(skyOpenHolds(true)).toBe(true);
    expect(skyOpenHolds(false)).toBe(false);
  });

  test('lake: the nearest quart corner has a finite lakeLevel', () => {
    expect(lakeHolds(-Infinity)).toBe(false);
    expect(lakeHolds(Infinity)).toBe(false);
    expect(lakeHolds(NaN)).toBe(false);
    expect(lakeHolds(71)).toBe(true);
    expect(lakeHolds(-3.5)).toBe(true);
  });
});

describe('caveBiome (SP6b spec §3.2, D18)', () => {
  const ALL = caveBiomeMask(['plain', 'lush', 'dripstone', 'abyss']);

  test('caveBiomeHolds: the side\'s cave biome is in the set; none (−1) never is', () => {
    const m = caveBiomeMask(['abyss', 'lush']);
    expect([0, 1, 2, 3].map((b) => caveBiomeHolds(m, b))).toEqual([false, true, false, true]);
    expect(caveBiomeHolds(m, -1)).toBe(false);
    expect([-1, 0, 1, 2, 3].map((b) => caveBiomeHolds(ALL, b))).toEqual([false, true, true, true, true]);
    // A reserved id (4-15) is in no list.
    for (let b = 4; b < 16; b++) expect(caveBiomeHolds(ALL, b)).toBe(false);
    expect(() => caveBiomeMask(['moss'])).toThrow(/moss/);
  });

  test('caveBiomeHere: the picker at the voxel (caveBiomeOfPass), −1 without a picker or a pass', () => {
    const col = withCaveBiomes(randomSurfaceColumn(testRng(31)), 31);
    const { inputs, pass } = col.cave;
    const next = testRng(32);
    for (let k = 0; k < 500; k++) {
      const x = 16 * col.sample.cx + (next() % 16), z = 16 * col.sample.cz + (next() % 16), y = -63 + (next() % 383);
      expect(caveBiomeHere(inputs, pass, x, y, z)).toBe(caveBiomeOfPass(inputs, pass, x, y, z));
    }
    expect(caveBiomeHere(null, pass, 16 * col.sample.cx, 0, 16 * col.sample.cz)).toBe(-1);
    expect(caveBiomeHere(inputs, null, 16 * col.sample.cx, 0, 16 * col.sample.cz)).toBe(-1);
  });

  describe('on the hand-built column (caveBiomeHandColumn)', () => {
    const col = caveBiomeHandColumn();
    const scan = scanColumn(newSurfaceScan(), surfaceFuzzSettings(SEED), col.sample, col.solid, col.water, col.biomes, col.tags, col.cave);
    const x = (p: number): number => 16 * col.sample.cx + (p & 15);
    const z = (p: number): number => 16 * col.sample.cz + (p >> 4);
    const here = (p: number, y: number): number => caveBiomeHere(scan.cavePicker, scan.cavePass, x(p), y, z(p));

    test('a moss carpet never lies under a plain cave over lush rock', () => {
      const lush = caveBiomeMask(['lush']);
      const r = scan.runFirst[0]!;
      expect([scan.runTop[r], scan.runBottom[r]]).toEqual([40, -63]);
      // floor reads the cave air above the run's top (plain, `1 | 0 << 4`); here the rock's own biome (lush).
      expect(caveBiomeHolds(lush, scan.runFloorBiome[r]!)).toBe(false);
      expect(caveBiomeHolds(caveBiomeMask(['plain']), scan.runFloorBiome[r]!)).toBe(true);
      expect(caveBiomeHolds(lush, here(0, 40))).toBe(true);
      // Under lush cave air (p 1's ground run) the floor side holds; under untagged air (p 2) no list holds.
      expect(caveBiomeHolds(lush, scan.runFloorBiome[scan.runFirst[1]! + 1]!)).toBe(true);
      expect(caveBiomeHolds(ALL, scan.runFloorBiome[scan.runFirst[2]!]!)).toBe(false);
      // The picker: lush in the rock at y −15 … 74 (depth 0.2 … 0.9 below Y0 100, D 128), plain elsewhere.
      expect([-16, -15, 74, 75].map((y) => here(0, y))).toEqual([0, 1, 1, 0]);
    });

    test('a ceiling rule never fires on a bedrock-resting run', () => {
      for (let p = 0; p < 256; p++) {
        const ground = scan.runFirst[p + 1]! - 1;
        expect(scan.runBottom[ground]).toBe(-63);
        expect(caveBiomeHolds(ALL, scan.runCeilBiome[ground]!)).toBe(false);
      }
      // p 1's overhang (50 … 60) rests on lush cave air: its ceiling side holds.
      const overhang = scan.runFirst[1]!;
      expect([scan.runTop[overhang], scan.runBottom[overhang]]).toEqual([60, 50]);
      expect(caveBiomeHolds(caveBiomeMask(['lush']), scan.runCeilBiome[overhang]!)).toBe(true);
    });
  });
});

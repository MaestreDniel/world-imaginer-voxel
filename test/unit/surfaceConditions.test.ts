import { describe, expect, test } from 'vitest';
import { deriveSeed, hash3, type Seed64 } from '../../src/core/hash';
import { biomeId } from '../../src/gen/biomes/registry';
import {
  biomeHolds, biomeMask, gradientSeed, lakeHolds, noiseThresholdHolds, skyOpenHolds, steepHolds, stoneDepthHolds,
  temperatureBelowHolds, verticalGradientHolds, waterHolds, yAboveHolds,
} from '../../src/gen/surface/conditions';

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

  test('skyOpen: the run is the topmost solid run', () => {
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

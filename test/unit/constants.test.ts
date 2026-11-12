import { expect, test } from 'vitest';
import {
  CARVER_CACHE_PATHS, CARVER_WINDOW_R, CAVE_BIOME, CAVE_BIOME_COLORS, CAVE_BIOME_NAMES, CAVE_FILM_KIND, CAVE_KIND, caveBiomeOf, caveKindOf,
  GENERATOR_VERSION,
} from '../../src/core/constants';
import { CARVER_MAXIMA, carverReachOf, carverWindowROf } from '../harness/carverParams';

test('GENERATOR_VERSION is a non-negative integer', () => {
  expect(Number.isInteger(GENERATOR_VERSION)).toBe(true);
  expect(GENERATOR_VERSION).toBeGreaterThanOrEqual(0);
});

test('CAVE_KIND\'s ten kinds and CAVE_FILM_KIND 15 fit the cave byte\'s low 4 bits (SP6a spec §3.2)', () => {
  expect(CAVE_KIND).toEqual({
    none: 0, cheese: 1, spaghetti3d: 2, spaghetti2d: 3, noodle: 4, entrance: 5, worm: 6, ravine: 7, undergroundWorm: 8, other: 9,
  });
  expect(Object.isFrozen(CAVE_KIND)).toBe(true);
  expect(CAVE_FILM_KIND).toBe(15);
  const all = [...Object.values(CAVE_KIND), CAVE_FILM_KIND];
  expect(new Set(all).size).toBe(11);
  for (const k of all) {
    expect(Number.isInteger(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThan(16);
  }
});

test('the cave byte: the kind in bits 0-3 (caveKindOf), the cave biome in bits 4-7 (caveBiomeOf; SP6b spec §1.1, §2.1)', () => {
  expect(caveKindOf(0x35)).toBe(5);
  expect(caveBiomeOf(0x35)).toBe(3);
  expect([caveKindOf(0), caveBiomeOf(0), caveKindOf(0xff), caveBiomeOf(0xff), caveKindOf(0x0f), caveBiomeOf(0xf0)]).toEqual([0, 0, 15, 15, 15, 15]);
  for (let b = 0; b < 256; b++) expect(caveKindOf(b) | (caveBiomeOf(b) << 4)).toBe(b);
  expect(CAVE_BIOME).toEqual({ plain: 0, lush: 1, dripstone: 2, abyss: 3 });
  expect(Object.isFrozen(CAVE_BIOME)).toBe(true);
  // The names and colours in id order: plain, lush, dripstone, abyss.
  expect(CAVE_BIOME_NAMES).toEqual(['plain', 'lush', 'dripstone', 'abyss']);
  expect(CAVE_BIOME_NAMES.map((n) => CAVE_BIOME[n])).toEqual([0, 1, 2, 3]);
  expect(CAVE_BIOME_COLORS).toEqual(['#6f86a6', '#4dff7a', '#ffb347', '#b05cff']);
  expect([Object.isFrozen(CAVE_BIOME_NAMES), Object.isFrozen(CAVE_BIOME_COLORS)]).toEqual([true, true]);
});

test('CARVER_WINDOW_R is 11, recomputed from the carver leaves\' static maxima (SP6a spec §2.1: 16·R < 16 + L_max + r_max)', () => {
  const { lMax, rMax } = carverReachOf(CARVER_MAXIMA);
  // L_max: worms.length's and ravines.lengthMax' static maximum; r_max: max((1.5 + 3)·2.0 for worms, 1.5 + 8 for ravines).
  expect(lMax).toBe(160);
  expect(rMax).toBe(9.5);
  const reach = 16 + lMax + rMax;
  expect(reach).toBe(185.5);
  expect(carverWindowROf(CARVER_MAXIMA)).toBe(11);
  expect(CARVER_WINDOW_R).toBe(carverWindowROf(CARVER_MAXIMA));
  expect(16 * CARVER_WINDOW_R).toBeLessThan(reach);
  expect(16 * (CARVER_WINDOW_R + 1)).toBeGreaterThan(reach);
});

test('CARVER_CACHE_PATHS is 1024: the carver path cache\'s capacity per worker (SP6a spec §2.5)', () => {
  expect(CARVER_CACHE_PATHS).toBe(1024);
});

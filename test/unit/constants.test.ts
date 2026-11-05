import { expect, test } from 'vitest';
import { CARVER_WINDOW_R, CAVE_FILM_KIND, CAVE_KIND, GENERATOR_VERSION } from '../../src/core/constants';
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

import { expect, test } from 'vitest';
import { CAVE_FILM_KIND, CAVE_KIND, GENERATOR_VERSION } from '../../src/core/constants';

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

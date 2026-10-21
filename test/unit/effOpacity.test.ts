/**
 * The SP4a light rule's block side (SP4a spec §4.1, D8): effective opacity and emission over the fluid byte, and the
 * straight sky fall's predicate, on the real registry and on injected tables (the partial-face cases).
 */
import { describe, expect, test } from 'vitest';
import { AIR, STONE } from '../../src/world/blocks/index';
import { FLUID_LAVA, FLUID_WATER, NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { FACE_DOWN, FACE_UP } from '../../src/world/blocks/kinds';
import { DEFAULT_LIGHT_TABLES, effEmit, effOpacity, fallBlocked, type LightTables } from '../../src/world/blocks/light';

const LAVA = packFluid(FLUID_LAVA, 0);

/** Air (0), stone (1, an opaque full cube) and a bottom slab (2: OPACITY 0, FULL_FACES down only). */
function slabTables(): LightTables {
  const opacity = new Uint8Array(4096);
  const fullFaces = new Uint8Array(4096);
  const emit = new Uint8Array(4096);
  opacity[1] = 15;
  fullFaces[1] = 63;
  fullFaces[2] = 1 << FACE_DOWN;
  return { opacity, fullFaces, emit };
}

describe('effOpacity and effEmit (SP4a spec §4.1)', () => {
  test('air + water is 1, stone 15, air 0', () => {
    expect(effOpacity(AIR, WATER_SOURCE)).toBe(1);
    expect(effOpacity(AIR, packFluid(FLUID_WATER, 3, true))).toBe(1);
    expect(effOpacity(STONE, NO_FLUID)).toBe(15);
    expect(effOpacity(STONE, WATER_SOURCE)).toBe(15);
    expect(effOpacity(AIR, NO_FLUID)).toBe(0);
  });

  test('effEmit of air + lava is 15; air and water emit nothing', () => {
    expect(effEmit(AIR, LAVA)).toBe(15);
    expect(effEmit(AIR, WATER_SOURCE)).toBe(0);
    expect(effEmit(AIR, NO_FLUID)).toBe(0);
  });

  test('injected tables: the emission is the larger of EMIT and lava', () => {
    const t = slabTables();
    t.emit[3] = 14;
    expect(effEmit(3, NO_FLUID, t)).toBe(14);
    expect(effEmit(3, LAVA, t)).toBe(15);
    expect(effOpacity(1, NO_FLUID, t)).toBe(15);
    expect(effOpacity(2, WATER_SOURCE, t)).toBe(1);
  });

  test('the default tables are the registry tables', () => {
    expect(effOpacity(STONE, NO_FLUID, DEFAULT_LIGHT_TABLES)).toBe(15);
    expect(DEFAULT_LIGHT_TABLES.opacity.length).toBe(4096);
  });
});

describe('fallBlocked (SP4a spec §4.1: the straight fall)', () => {
  test('true for water, true for stone, false for air under air', () => {
    expect(fallBlocked(AIR, WATER_SOURCE, AIR)).toBe(true);
    expect(fallBlocked(STONE, NO_FLUID, AIR)).toBe(true);
    expect(fallBlocked(AIR, NO_FLUID, AIR)).toBe(false);
  });

  test('injected table: a bottom slab blocks the voxel below it through stateAbove\'s down bit', () => {
    const t = slabTables();
    expect(fallBlocked(0, NO_FLUID, 2, t)).toBe(true);
    // The slab itself is entered: OPACITY 0 and no up face.
    expect(fallBlocked(2, NO_FLUID, 0, t)).toBe(false);
    expect(fallBlocked(0, NO_FLUID, 0, t)).toBe(false);
  });

  test('injected table: a voxel whose up face is full is not entered', () => {
    const t = slabTables();
    t.fullFaces[3] = 1 << FACE_UP;
    expect(fallBlocked(3, NO_FLUID, 0, t)).toBe(true);
  });
});

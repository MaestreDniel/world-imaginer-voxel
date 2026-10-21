/**
 * The final heightmaps of the D skeleton (SP4a spec §3.2): WORLD_SURFACE, OCEAN_FLOOR, MOTION_BLOCKING and
 * LIGHT_BLOCKING computed top-down on canned columns (the same column at every position).
 */
import { describe, expect, test } from 'vitest';
import { writeFinalHeightmaps } from '../../src/gen/pipeline/finalHeightmaps';
import { NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, SAND, STONE } from '../../src/world/blocks/index';
import type { AuxView } from '../../src/world/store/api';

/** A fresh aux A with every heightmap at a sentinel, so a field the function leaves alone shows. */
function newAux(): AuxView {
  const h = () => new Int16Array(256).fill(12345);
  return {
    worldSurfaceWG: h(), oceanFloorWG: h(), worldSurface: h(), motionBlocking: h(), oceanFloor: h(), lightBlocking: h(),
    surfaceBiome: new Uint8Array(256), tintTH: new Uint8Array(768),
  };
}

/** The four final heightmaps of a column whose every position reads `block(y)` and `fluid(y)`. */
function run(block: (y: number) => number, fluid: (y: number) => number): AuxView {
  const aux = newAux();
  writeFinalHeightmaps((_lx, y) => block(y), (_lx, y) => fluid(y), aux);
  return aux;
}

/** Every position of `a` equals `v`. */
const all = (a: Int16Array, v: number) => expect([...new Set(a)]).toEqual([v]);

describe('writeFinalHeightmaps (SP4a spec §3.2)', () => {
  test('open sea: motionBlocking = water top + 1, oceanFloor = floor + 1, lightBlocking = water top + 1', () => {
    // Bedrock at −64, stone up to the floor at y 40, sand at 41, water sources at 42 … 62, air above.
    const aux = run(
      (y) => (y === -64 ? BEDROCK : y <= 40 ? STONE : y === 41 ? SAND : AIR),
      (y) => (y >= 42 && y <= 62 ? WATER_SOURCE : NO_FLUID),
    );
    all(aux.worldSurface, 63);
    all(aux.motionBlocking, 63);
    all(aux.oceanFloor, 42);
    all(aux.lightBlocking, 63);
    // The proto maps and the other fields are not D's.
    all(aux.worldSurfaceWG, 12345);
    all(aux.oceanFloorWG, 12345);
    expect(aux.tintTH.every((v) => v === 0)).toBe(true);
  });

  test('a floating run over air at y 200-210: all four are 211', () => {
    const aux = run(
      (y) => (y === -64 ? BEDROCK : y <= 50 ? STONE : y >= 200 && y <= 210 ? STONE : AIR),
      (y) => (y > 50 && y <= 62 ? WATER_SOURCE : NO_FLUID),
    );
    for (const a of [aux.worldSurface, aux.oceanFloor, aux.motionBlocking, aux.lightBlocking]) all(a, 211);
  });

  test('an all-air column: all −64', () => {
    const aux = run(() => AIR, () => NO_FLUID);
    for (const a of [aux.worldSurface, aux.oceanFloor, aux.motionBlocking, aux.lightBlocking]) all(a, -64);
  });

  test('bedrock only (y −64): all −63', () => {
    const aux = run((y) => (y === -64 ? BEDROCK : AIR), () => NO_FLUID);
    for (const a of [aux.worldSurface, aux.oceanFloor, aux.motionBlocking, aux.lightBlocking]) all(a, -63);
  });

  test('a block at y 319 counts (the voxel above the world is air): all 320', () => {
    const aux = run((y) => (y === 319 ? STONE : AIR), () => NO_FLUID);
    for (const a of [aux.worldSurface, aux.oceanFloor, aux.motionBlocking, aux.lightBlocking]) all(a, 320);
  });

  test('positions are independent: (lx, lz) indexes lz·16 + lx', () => {
    const aux = newAux();
    // A pillar of stone reaching y lx + 16·lz − 64 at each position.
    writeFinalHeightmaps((lx, y, lz) => (y <= lx + 16 * lz - 64 ? STONE : AIR), () => NO_FLUID, aux);
    for (let p = 0; p < 256; p++) {
      for (const a of [aux.worldSurface, aux.oceanFloor, aux.motionBlocking, aux.lightBlocking]) expect(a[p]).toBe(p - 63);
    }
  });
});

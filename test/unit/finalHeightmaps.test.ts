/**
 * The final heightmaps of the D skeleton (SP4a spec §3.2): WORLD_SURFACE, OCEAN_FLOOR, MOTION_BLOCKING and
 * LIGHT_BLOCKING computed top-down on canned columns (the same column at every position).
 * `patchHeightmaps` (SP5a spec §2.2): one block column rescanned after an edit equals the full scan.
 */
import { describe, expect, test } from 'vitest';
import { patchHeightmaps, writeFinalHeightmaps } from '../../src/gen/pipeline/finalHeightmaps';
import { NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK, GLASS, ICE, SAND, STONE } from '../../src/world/blocks/index';
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

describe('patchHeightmaps (SP5a spec §2.2)', () => {
  test('after each of 300 random voxel edits (place and break stone, glass, water, ice at random heights, edits at y 319 and y −64 included), patchHeightmaps of that block column from the caller\'s fromY leaves aux A equal to a full writeFinalHeightmaps over the same final, and reads no y above 319', () => {
    const at = (lx: number, y: number, lz: number) => (((y + 64) * 16 + lz) << 4) | lx;
    const blocks = new Uint16Array(384 * 256);
    const fluid = new Uint8Array(384 * 256);
    // A canned final: bedrock at −64, stone up to a height that varies by position, water up to y 62 over the low
    // positions, a glass and an ice voxel on some surfaces.
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const top = 40 + ((lx * 7 + lz * 3) % 40);
        for (let y = -64; y <= top; y++) blocks[at(lx, y, lz)] = y === -64 ? BEDROCK : STONE;
        for (let y = top + 1; y <= 62; y++) fluid[at(lx, y, lz)] = WATER_SOURCE;
        if ((lx + lz) % 5 === 0) blocks[at(lx, top + 1, lz)] = (lx & 1) === 0 ? GLASS : ICE;
      }
    }
    let maxRead = -Infinity;
    const blockAt = (lx: number, y: number, lz: number) => {
      maxRead = Math.max(maxRead, y);
      return blocks[at(lx, y, lz)]!;
    };
    const fluidAt = (lx: number, y: number, lz: number) => {
      maxRead = Math.max(maxRead, y);
      return fluid[at(lx, y, lz)]!;
    };
    const aux = newAux();
    writeFinalHeightmaps(blockAt, fluidAt, aux);
    // A seeded LCG, so a failure reproduces.
    let seed = 0x5a5a;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const kinds: Array<[state: number, fluid: number]> = [
      [AIR, NO_FLUID], [STONE, NO_FLUID], [GLASS, NO_FLUID], [AIR, WATER_SOURCE], [ICE, NO_FLUID],
    ];
    for (let k = 0; k < 300; k++) {
      const lx = rand(16);
      const lz = rand(16);
      // Every 20th edit at y 319, every 20th (offset 10) at y −64; half the rest near the surface, half anywhere.
      const p = (lz << 4) | lx;
      const y = k % 20 === 0 ? 319 : k % 20 === 10 ? -64 : k % 2 === 0
        ? Math.max(-64, Math.min(319, aux.worldSurface[p]! - 4 + rand(8)))
        : -64 + rand(384);
      const [state, fl] = kinds[rand(kinds.length)]!;
      const fromY = Math.min(319, Math.max(
        y, aux.worldSurface[p]! - 1, aux.motionBlocking[p]! - 1, aux.oceanFloor[p]! - 1, aux.lightBlocking[p]! - 1,
      ));
      blocks[at(lx, y, lz)] = state;
      fluid[at(lx, y, lz)] = fl;
      maxRead = -Infinity;
      patchHeightmaps(blockAt, fluidAt, aux, lx, lz, fromY);
      expect(maxRead, `edit ${k}: a read above 319`).toBeLessThanOrEqual(319);
      const full = newAux();
      writeFinalHeightmaps(blockAt, fluidAt, full);
      for (const key of ['worldSurface', 'motionBlocking', 'oceanFloor', 'lightBlocking'] as const) {
        expect([...aux[key]], `edit ${k} at (${lx}, ${y}, ${lz}): ${key}`).toEqual([...full[key]]);
      }
      // The fields D does not write stay as they were.
      for (const key of ['worldSurfaceWG', 'oceanFloorWG'] as const) all(aux[key], 12345);
    }
  });

  test('fromY above 319 or below −64 is refused', () => {
    const aux = newAux();
    expect(() => patchHeightmaps(() => AIR, () => NO_FLUID, aux, 0, 0, 320)).toThrow(RangeError);
    expect(() => patchHeightmaps(() => AIR, () => NO_FLUID, aux, 0, 0, -65)).toThrow(RangeError);
  });
});

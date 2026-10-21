/**
 * Section connectivity (SP4a spec §5.7, D10): bit k of `connectivity15` is set when a 6-connected path through the
 * section's non-opaque voxels joins the k-th unordered face pair, pairs in lexicographic order (plan). Sections are
 * hand-built with `fixtures/padded.ts`; the padding never counts.
 */
import { describe, expect, test } from 'vitest';
import { connectivity15, connectivityBit } from '../../src/mesh/connectivity';
import type { MeshTables } from '../../src/mesh/greedy';
import { AIR, STONE } from '../../src/world/blocks/index';
import { PASS_NONE, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import { paddedFrom } from './fixtures/padded';

/** Faces in master order. */
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;
const WEST = 3;
const UP = 4;
const DOWN = 5;

/** A section of stone with air where `open(x, y, z)`; the padding is air (it must not matter). */
const carved = (open: (x: number, y: number, z: number) => boolean) =>
  paddedFrom((x, y, z) => (x < 0 || y < 0 || z < 0 || x > 15 || y > 15 || z > 15 || open(x, y, z) ? AIR : STONE));

describe('connectivity15 (SP4a spec §5.7)', () => {
  test('all air → 0x7FFF; all stone → 0', () => {
    expect(connectivity15(paddedFrom(() => AIR))).toBe(0x7FFF);
    expect(connectivity15(paddedFrom(() => STONE))).toBe(0);
    // The padding does not count: stone inside, air around it, is still 0.
    expect(connectivity15(carved(() => false))).toBe(0);
  });

  test('an x-axis tunnel through stone → only the west-east bit', () => {
    const c = connectivity15(carved((_x, y, z) => y === 8 && z === 8));
    expect(c).toBe(1 << connectivityBit(WEST, EAST));
    expect(connectivityBit(WEST, EAST)).toBe(6);
  });

  test('an L-shaped tunnel north → up → only that pair', () => {
    const c = connectivity15(carved((x, y, z) => x === 8 && ((y === 8 && z <= 8) || (z === 8 && y >= 8))));
    expect(c).toBe(1 << connectivityBit(NORTH, UP));
    expect(connectivityBit(NORTH, UP)).toBe(3);
  });

  test('two separate pockets → no pair', () => {
    // One pocket opens on the north face, the other on the south face, and they do not meet; a third pocket inside
    // touches no face.
    const c = connectivity15(carved((x, y, z) => (x === 3 && y === 3 && z <= 5) || (x === 12 && y === 12 && z >= 10) || (x === 8 && y === 8 && z === 8)));
    expect(c).toBe(0);
  });

  test('pair order pinned: bit 0 = (north, east)', () => {
    const pairs: Array<[number, number]> = [];
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) pairs.push([a, b]);
    pairs.forEach(([a, b], k) => {
      expect(connectivityBit(a, b)).toBe(k);
      expect(connectivityBit(b, a)).toBe(k);
    });
    expect(connectivityBit(NORTH, EAST)).toBe(0);
    expect(connectivityBit(SOUTH, DOWN)).toBe(11);
    expect(connectivityBit(UP, DOWN)).toBe(14);
    // An L in the y 8 plane from the north face to the east face sets bit 0 alone.
    const c = connectivity15(carved((x, y, z) => y === 8 && ((x === 4 && z <= 4) || (z === 4 && x >= 4))));
    expect(c).toBe(1);
  });

  test('a vertical shaft joins up and down; a room touching four faces sets their six pairs', () => {
    expect(connectivity15(carved((x, _y, z) => x === 5 && z === 5))).toBe(1 << connectivityBit(UP, DOWN));
    // A slab of air at y 4 … 6 spanning x and z touches north, east, south and west.
    const room = connectivity15(carved((_x, y) => y >= 4 && y <= 6));
    const want = [[NORTH, EAST], [NORTH, SOUTH], [NORTH, WEST], [EAST, SOUTH], [EAST, WEST], [SOUTH, WEST]]
      .reduce((m, [a, b]) => m | (1 << connectivityBit(a!, b!)), 0);
    expect(room).toBe(want);
  });

  test('injected tables: a PASS opaque state without fullFaces 63 counts as open', () => {
    // State 9 is opaque with one face missing (a slab-like partial state): a wall of it does not seal the section.
    const pass = new Uint8Array(32).fill(PASS_OPAQUE);
    pass[AIR] = PASS_NONE;
    const fullFaces = new Uint8Array(32).fill(63);
    fullFaces[AIR] = 0;
    fullFaces[9] = 63 & ~(1 << UP);
    const t: MeshTables = { pass, fullFaces, tint: new Uint8Array(32) };
    const allNine = paddedFrom(() => 9);
    expect(connectivity15(allNine, t)).toBe(0x7FFF);
    expect(connectivity15(paddedFrom(() => STONE), t)).toBe(0);
  });
});

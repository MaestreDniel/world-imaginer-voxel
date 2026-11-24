import { describe, expect, test } from 'vitest';
import { poseCandidates, type CaveRegion } from '../harness/cull';

/**
 * R3's pose candidates (`test/harness/cull.ts`; SP6b spec §12.4 as SP7a corrects it, rulings R24 item 8): a pose kind
 * takes its eye in dry tagged cave air, and in a fluid-filled cave voxel only when the region holds no dry candidate
 * for that kind.
 */

/** A one-chunk region (pre-cave top 100 everywhere) holding the given candidates: [x, y, z, kind, boundary count]. */
function region(dry: number[][], wet: number[][]): CaveRegion {
  return {
    label: 'fixture', cx0: 0, cz0: 0, size: 1, opaque: new Uint32Array(0), conn: new Uint16Array(0), solid: new Uint8Array(0),
    nonEmpty: new Uint8Array(0), top: new Int16Array(256).fill(100), caveAir: Int32Array.from(dry.flat()),
    caveFluid: Int32Array.from(wet.flat()), opaqueDeep: new Int32Array(0),
  };
}

describe('poseCandidates', () => {
  test('a kind with a dry candidate never takes a wet one; a kind with none falls back to the fluid-filled cave voxels', () => {
    const r = region(
      [[1, 50, 1, 1, 1], [2, 95, 2, 1, 1]],
      [[3, 40, 3, 1, 1], [0, 30, 15, 2, 3], [5, 90, 5, 2, 3]],
    );
    // Face (1 boundary coordinate): the dry voxel 50 below the top; the one at 95 is not underground (≥ 16 deep).
    expect(poseCandidates(r, 1)).toEqual([[1, 50, 1, 1, 1]]);
    // Corner (3): no dry candidate, so the underground wet one (the one at 90 is too shallow).
    expect(poseCandidates(r, 3)).toEqual([[0, 30, 15, 2, 3]]);
    // Edge (2): neither.
    expect(poseCandidates(r, 2)).toEqual([]);
    // Any kind (the cave poses): the dry ones alone while one is underground.
    expect(poseCandidates(r, null)).toEqual([[1, 50, 1, 1, 1]]);
    // A region whose caves are all flooded: every kind reads the wet ones.
    const flooded = region([], [[3, 40, 3, 1, 1], [0, 30, 15, 2, 3]]);
    expect(poseCandidates(flooded, null)).toEqual([[3, 40, 3, 1, 1], [0, 30, 15, 2, 3]]);
    expect(poseCandidates(flooded, 1)).toEqual([[3, 40, 3, 1, 1]]);
  });
});

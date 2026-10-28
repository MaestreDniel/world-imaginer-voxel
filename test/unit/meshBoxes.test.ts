/**
 * The provisional boxes (SP5a spec §1.3, D12): the per-facing boxes of `world/blocks/provisionalBoxes.ts` and
 * `meshBoxes`, which emits each box's six faces into the cutout pass, a face on the voxel's boundary culled against a
 * `SHAPE` cube state or a voxel holding water or lava, AO 1 and the voxel's own light.
 */
import { describe, expect, test } from 'vitest';
import { meshBoxes } from '../../src/mesh/boxes';
import { createMeshBuilder, type MeshBuilder } from '../../src/mesh/builder';
import { DEFAULT_MESH_TABLES, type MeshOptions } from '../../src/mesh/greedy';
import { unpackSolid } from '../../src/mesh/packing';
import { AIR, GLASS, LADDER, REGISTRY, SHAPE, STONE, TORCH, WALL_TORCH } from '../../src/world/blocks/index';
import { LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { SHAPE_BOX } from '../../src/world/blocks/kinds';
import { BOXES, boxOf } from '../../src/world/blocks/provisionalBoxes';
import { padIndex, type PaddedSection } from '../../src/world/store/padded';
import { paddedFrom, quadsOf, type ReadQuad, type VoxelFn } from './fixtures/padded';

const ON: MeshOptions = { ao: true, smoothLight: true };
const NORMAL: ReadonlyArray<readonly [number, number, number]> = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

interface Meshed {
  readonly b: MeshBuilder;
  readonly passes: readonly [ReadQuad[], ReadQuad[], ReadQuad[]];
}

function mesh(p: PaddedSection, o: MeshOptions = ON): Meshed {
  const b = createMeshBuilder();
  meshBoxes(p, o, b);
  return { b, passes: [quadsOf(b.view(0)), quadsOf(b.view(1)), quadsOf(b.view(2))] };
}

const faceOf = (q: ReadQuad): number => unpackSolid(q.words[0]!).face;
const facesOf = (quads: readonly ReadQuad[]): number[] => quads.map(faceOf).sort();

/** A section holding `state` at (8, 8, 8) and `around(x, y, z)` elsewhere, with the fluid bytes of `fluid`; light 0xF0. */
function single(state: number, around: VoxelFn = () => AIR, fluid: VoxelFn = () => 0): PaddedSection {
  return paddedFrom((x, y, z) => (x === 8 && y === 8 && z === 8 ? state : around(x, y, z)), () => 0xF0, fluid);
}

/** The state of `type` facing `facing`. */
const facing = (type: number, f: string): number => REGISTRY.withProp(type, 'facing', f);

/** The bounds of a quad's corners, as [x0, y0, z0, x1, y1, z1] in eighths. */
function bounds(q: ReadQuad): number[] {
  const lo = [0, 1, 2].map((a) => Math.min(...q.corners.map((c) => c[a]!)));
  const hi = [0, 1, 2].map((a) => Math.max(...q.corners.map((c) => c[a]!)));
  return [...lo, ...hi];
}

/** The box of `state` read through `boxOf`, or null. */
function boxOfState(state: number): number[] | null {
  const out = new Uint8Array(6);
  return boxOf(state, out) ? [...out] : null;
}

describe('provisional boxes', () => {
  test('BOXES face north, in eighths: torch x 3-5, y 0-5, z 3-5; wall_torch x 3-5, y 2-7, z 6-8; ladder x 0-8, y 0-8, z 7-8', () => {
    expect(BOXES.torch).toEqual([3, 0, 3, 5, 5, 5]);
    expect(BOXES.wall_torch).toEqual([3, 2, 6, 5, 7, 8]);
    expect(BOXES.ladder).toEqual([0, 0, 7, 8, 8, 8]);
  });

  test('a wall torch facing east and a ladder facing south: the boxes rotated (each facing by rotateState\'s quarter turns)', () => {
    expect(boxOfState(TORCH)).toEqual([3, 0, 3, 5, 5, 5]);
    // Facing is away from the wall: the stick and the plate sit against the wall behind them.
    expect(boxOfState(facing(WALL_TORCH, 'north'))).toEqual([3, 2, 6, 5, 7, 8]);
    expect(boxOfState(facing(WALL_TORCH, 'east'))).toEqual([0, 2, 3, 2, 7, 5]);
    expect(boxOfState(facing(WALL_TORCH, 'south'))).toEqual([3, 2, 0, 5, 7, 2]);
    expect(boxOfState(facing(WALL_TORCH, 'west'))).toEqual([6, 2, 3, 8, 7, 5]);
    expect(boxOfState(facing(LADDER, 'north'))).toEqual([0, 0, 7, 8, 8, 8]);
    expect(boxOfState(facing(LADDER, 'east'))).toEqual([0, 0, 0, 1, 8, 8]);
    expect(boxOfState(facing(LADDER, 'south'))).toEqual([0, 0, 0, 8, 8, 1]);
    expect(boxOfState(facing(LADDER, 'west'))).toEqual([7, 0, 0, 8, 8, 8]);
    // meshBoxes draws the rotated boxes: the quads of an east wall torch and of a south ladder span exactly their box.
    for (const [state, box] of [[facing(WALL_TORCH, 'east'), [0, 2, 3, 2, 7, 5]], [facing(LADDER, 'south'), [0, 0, 0, 8, 8, 1]]] as const) {
      const quads = mesh(single(state)).passes[1];
      expect(facesOf(quads)).toEqual([0, 1, 2, 3, 4, 5]);
      const all = quads.map(bounds);
      const union = [0, 1, 2].map((a) => Math.min(...all.map((b) => b[a]!))).concat([3, 4, 5].map((a) => Math.max(...all.map((b) => b[a]!))));
      expect(union).toEqual(box.map((v) => 64 + v));
    }
  });

  test('every SHAPE box state has a box, and no other state has one (boxOf leaves out alone)', () => {
    for (let s = 0; s < REGISTRY.stateCount; s++) {
      const out = new Uint8Array([9, 9, 9, 9, 9, 9]);
      const has = boxOf(s, out);
      expect(has, REGISTRY.stateKey(s)).toBe(SHAPE[s] === SHAPE_BOX);
      if (has) {
        expect(out[0]! < out[3]! && out[1]! < out[4]! && out[2]! < out[5]! && out[3]! <= 8 && out[4]! <= 8 && out[5]! <= 8, REGISTRY.stateKey(s)).toBe(true);
      } else {
        expect([...out]).toEqual([9, 9, 9, 9, 9, 9]);
      }
    }
  });
});

describe('meshBoxes', () => {
  test('a torch emits 6 quads at x 3-5, y 0-5, z 3-5 eighths', () => {
    // The torch's own light is sky 9, block 14; every neighbour has 0xF0, which the faces must not take.
    const p = single(TORCH);
    p.light[padIndex(8, 8, 8)] = 0x9E;
    const { passes } = mesh(p);
    expect(passes[0]).toEqual([]);
    expect(passes[2]).toEqual([]);
    const quads = passes[1];
    expect(facesOf(quads)).toEqual([0, 1, 2, 3, 4, 5]);
    const box = [64 + 3, 64 + 0, 64 + 3, 64 + 5, 64 + 5, 64 + 5];
    for (const q of quads) {
      const f = faceOf(q);
      const b = bounds(q);
      const axis = [2, 0, 2, 0, 1, 1][f]!;
      const positive = [false, true, true, false, true, false][f]!;
      // The face spans the box on its two in-plane axes and lies on the box's side along its normal.
      for (let a = 0; a < 3; a++) {
        if (a === axis) {
          expect(b[a], `face ${f} plane`).toBe(positive ? box[a + 3] : box[a]);
          expect(b[a + 3], `face ${f} plane`).toBe(b[a]);
        } else {
          expect([b[a], b[a + 3]], `face ${f} axis ${a}`).toEqual([box[a], box[a + 3]]);
        }
      }
      // Counter-clockwise seen from outside: (v1 − v0) × (v2 − v0) points along the outward normal.
      const [v0, v1, v2] = [q.corners[0]!, q.corners[1]!, q.corners[2]!];
      const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]] as const;
      const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]] as const;
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      expect(n.map((c) => Math.sign(c) + 0), `face ${f} winding`).toEqual(NORMAL[f]);
      for (const w of q.words) {
        expect(unpackSolid(w)).toEqual({ layer: TORCH, face: f, ao: 0, sky: 9, block: 14, tint: DEFAULT_MESH_TABLES.tint[TORCH], flags: 0, frame: 0 });
      }
    }
  });

  test('a ladder on glass: its back face culled', () => {
    // A north-facing ladder hangs on the wall south of it (+z); its back face is the south face at z 8.
    const behind = (x: number, y: number, z: number): number => (x === 8 && y === 8 && z === 9 ? GLASS : AIR);
    expect(facesOf(mesh(single(LADDER, behind)).passes[1])).toEqual([0, 1, 3, 4, 5]);
    const onStone = (x: number, y: number, z: number): number => (x === 8 && y === 8 && z === 9 ? STONE : AIR);
    expect(facesOf(mesh(single(LADDER, onStone)).passes[1])).toEqual([0, 1, 3, 4, 5]);
    // In the open, and beside a torch (a box state, not a cube), every face is drawn; the torch's own quads lie at
    // x ≥ 72 + 3 eighths, so the ladder's are those ending at x ≤ 72.
    expect(facesOf(mesh(single(LADDER)).passes[1])).toEqual([0, 1, 2, 3, 4, 5]);
    const beside = (x: number, y: number, z: number): number => (x === 9 && y === 8 && z === 8 ? TORCH : AIR);
    expect(facesOf(mesh(single(LADDER, beside)).passes[1].filter((q) => bounds(q)[3]! <= 72))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('a torch under water: none of its faces culled but the one on the boundary is', () => {
    // Water in every neighbour; only the bottom face (y 0) lies on the voxel's boundary.
    const wet = (x: number, y: number, z: number): number => (x === 8 && y === 8 && z === 8 ? 0 : WATER_SOURCE);
    const quads = mesh(single(TORCH, () => AIR, wet)).passes[1];
    expect(facesOf(quads)).toEqual([0, 1, 2, 3, 4]);
  });

  test('a ladder whose back faces lava: back face culled', () => {
    const lava = (x: number, y: number, z: number): number => (x === 8 && y === 8 && z === 9 ? LAVA_SOURCE : 0);
    expect(facesOf(mesh(single(LADDER, () => AIR, lava)).passes[1])).toEqual([0, 1, 3, 4, 5]);
    // A south-facing ladder (x 0-8, z 0-1) has its south face at z 1, inside the voxel: lava south of it culls nothing.
    expect(facesOf(mesh(single(facing(LADDER, 'south'), () => AIR, lava)).passes[1])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('non-box states emit nothing', () => {
    for (const s of [AIR, STONE, GLASS]) expect(mesh(single(s)).b.view(1).vertices, REGISTRY.stateKey(s)).toBe(0);
  });
});

/**
 * The water mesher and the water depth (SP4a spec §5.5, §5.6; rulings P24, P25; SP7a spec §6.1-§6.2, D26): faces
 * against non-occluders that are not water, full-height positions with each top corner's `cornerDrop` from the 4
 * voxels around it (a still source among stone keeps drop 1), sloped tops one quad per voxel with the fixed split,
 * falls at full height, the column's `depth` in every word and key, the translucent pass only, and `fluidDepths` on a
 * hand-built store.
 */
import { describe, expect, test } from 'vitest';
import { createMeshBuilder, type MeshBuilder } from '../../src/mesh/builder';
import { createMeshScratch, meshColumnPayload, type ColumnMeshPayload } from '../../src/mesh/column';
import { fluidDepths, meshFluid } from '../../src/mesh/fluid';
import { LAVA_LAYER, type MeshTables } from '../../src/mesh/greedy';
import { packFluid as packFluidWord, packSolid, unpackFluid, unpackSolid, type FluidFields } from '../../src/mesh/packing';
import { AIR, GLASS, ICE, LADDER, REGISTRY, STONE, TORCH } from '../../src/world/blocks/index';
import { FLUID_LAVA, FLUID_WATER, LAVA_SOURCE, NO_FLUID, WATER_SOURCE, packFluid } from '../../src/world/blocks/fluid';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, PASS_NONE, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import { SECTIONS } from '../../src/world/store/columnTable';
import { padIndex, type PaddedSection } from '../../src/world/store/padded';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import type { ColumnView, NeighborhoodReader } from '../../src/world/store/api';
import { bruteFaces, meshFaceCounts } from '../harness/refs';
import { regionView } from '../harness/regionView';
import { paddedFrom, quadsOf, type ReadQuad, type VoxelFn } from './fixtures/padded';

/** Per face (north, east, south, west, up, down): the normal axis (0 x, 1 y, 2 z) and its sign (master face order). */
const AXIS = [2, 0, 2, 0, 1, 1] as const;
const SIGN = [-1, 1, 1, -1, 1, -1] as const;
const NORMAL: ReadonlyArray<readonly [number, number, number]> = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

/** Section-local voxel index `y·256 + z·16 + x` (the `depth` array's order). */
const local = (x: number, y: number, z: number): number => (y << 8) | (z << 4) | x;

interface Meshed {
  readonly b: MeshBuilder;
  readonly passes: readonly [ReadQuad[], ReadQuad[], ReadQuad[]];
}

function mesh(p: PaddedSection, depth: Uint8Array, t?: MeshTables): Meshed {
  const b = createMeshBuilder();
  meshFluid(p, depth, b, t);
  return { b, passes: [quadsOf(b.view(0)), quadsOf(b.view(1)), quadsOf(b.view(2))] };
}

const fieldsOf = (w: number): FluidFields => unpackFluid(w);
const faceOf = (q: ReadQuad): number => fieldsOf(q.words[0]!).face;

/** A depth array with `fn(x, y, z)` per section voxel. */
function depthFrom(fn: (x: number, y: number, z: number) => number): Uint8Array {
  const d = new Uint8Array(4096);
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) d[local(x, y, z)] = fn(x, y, z);
  return d;
}

/**
 * The unit faces a quad covers, as `x,y,z,face` keys of the voxel that owns each face; a side quad whose four positions
 * share one y is a side strip (SP7a spec §6.2), covering the unit faces of the voxels whose top that y is.
 */
function unitFaces(q: ReadQuad): string[] {
  const f = faceOf(q);
  const a = AXIS[f];
  const plane = q.corners[0]![a] / 8;
  const lo = [0, 1, 2].map((ax) => Math.min(...q.corners.map((c) => c[ax]!)) / 8);
  const hi = [0, 1, 2].map((ax) => Math.max(...q.corners.map((c) => c[ax]!)) / 8);
  lo[a] = SIGN[f] > 0 ? plane - 1 : plane;
  hi[a] = lo[a]! + 1;
  if (a !== 1 && lo[1] === hi[1]) lo[1] = hi[1]! - 1;
  const out: string[] = [];
  for (let y = lo[1]!; y < hi[1]!; y++) {
    for (let z = lo[2]!; z < hi[2]!; z++) {
      for (let x = lo[0]!; x < hi[0]!; x++) out.push(`${x},${y},${z},${f}`);
    }
  }
  return out;
}

const allUnitFaces = (quads: readonly ReadQuad[]): string[] => quads.flatMap(unitFaces).sort();

/** The brute-force water faces: a water voxel's face against a voxel that is neither water nor stone (SP4a spec §5.6). */
function bruteWaterFaces(p: PaddedSection): string[] {
  const out: string[] = [];
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (p.fluid[padIndex(x, y, z)] !== WATER_SOURCE) continue;
        for (let f = 0; f < 6; f++) {
          const [nx, ny, nz] = NORMAL[f]!;
          const n = padIndex(x + nx, y + ny, z + nz);
          if (p.fluid[n] === WATER_SOURCE || p.blocks[n] === STONE) continue;
          out.push(`${x},${y},${z},${f}`);
        }
      }
    }
  }
  return out.sort();
}

/** True when the vertex sits at the top of its voxel (position y = 8·(ly + 1) for the quad's top row). */
const ys = (q: ReadQuad): number[] => q.corners.map((c) => c[1]);

describe('meshFluid (SP4a spec §5.6)', () => {
  test('an open sea section: one merged top quad per 16 × 16 slice where depth > 15, corners at position y = 8·(ly + 1), cornerDrop 1 on all four', () => {
    // Water up to local y 9 everywhere, the padding included (the sea goes on past the section and below it).
    const water: VoxelFn = (_x, y) => (y <= 9 ? WATER_SOURCE : NO_FLUID);
    const p = paddedFrom(() => AIR, () => 0xF0, water);
    const depth = depthFrom((_x, y) => (y <= 9 ? 15 : 0));
    const { passes } = mesh(p, depth);
    expect(passes[2]).toHaveLength(1);
    const top = passes[2][0]!;
    expect(faceOf(top)).toBe(4);
    expect(ys(top)).toEqual([80, 80, 80, 80]);
    expect(allUnitFaces(passes[2])).toEqual(bruteWaterFaces(p));
    expect(allUnitFaces(passes[2])).toHaveLength(256);
    for (const w of top.words) {
      const f = fieldsOf(w);
      expect([f.cornerDrop, f.depth, f.sky, f.block, f.face, f.layer]).toEqual([1, 15, 15, 0, 4, AIR]);
    }
  });

  test('a shore: sides against air only, none against water or stone', () => {
    // A stone floor at y ≤ 3; water at y 4-5 for x 0-5; at x 6 a stone wall at y 4 and air at y 5; air beyond. The
    // padding continues the water west and along z, so only the east side at y 5 and the top meet air.
    const block: VoxelFn = (x, y) => (y <= 3 || (x === 6 && y === 4) ? STONE : AIR);
    const water: VoxelFn = (x, y) => (x <= 5 && (y === 4 || y === 5) ? WATER_SOURCE : NO_FLUID);
    const p = paddedFrom(block, () => 0xF0, water);
    const depth = depthFrom((x, y) => (x <= 5 && (y === 4 || y === 5) ? 2 : 0));
    const { passes } = mesh(p, depth);
    const faces = allUnitFaces(passes[2]);
    expect(faces).toEqual(bruteWaterFaces(p));
    const sides = faces.filter((k) => Number(k.split(',')[3]) < 4);
    expect(sides).toHaveLength(16);
    for (const k of sides) {
      const [x, y, , f] = k.split(',').map(Number);
      expect([x, y, f]).toEqual([5, 5, 1]);
    }
    // No bottom faces (stone below), and the east side at y 5 is one merged quad along z.
    expect(faces.filter((k) => k.endsWith(',5'))).toHaveLength(0);
    expect(passes[2].filter((q) => faceOf(q) === 1)).toHaveLength(1);
  });

  test('water against glass, ice and the box states: its face stays (SP5a spec §1.3; the cutout and box faces are the ones culled)', () => {
    // One water voxel at (8, 8, 8) and a neighbour of each kind on four sides; air above and below.
    const at = new Map([[padIndex(9, 8, 8), GLASS], [padIndex(7, 8, 8), ICE], [padIndex(8, 8, 9), LADDER], [padIndex(8, 8, 7), TORCH]]);
    const p = paddedFrom((x, y, z) => at.get(padIndex(x, y, z)) ?? AIR, () => 0xF0, (x, y, z) => (x === 8 && y === 8 && z === 8 ? WATER_SOURCE : NO_FLUID));
    const { passes } = mesh(p, depthFrom((x, y, z) => (x === 8 && y === 8 && z === 8 ? 1 : 0)));
    expect(allUnitFaces(passes[2])).toEqual(['8,8,8,0', '8,8,8,1', '8,8,8,2', '8,8,8,3', '8,8,8,4', '8,8,8,5']);
    expect(allUnitFaces(passes[2])).toEqual(bruteWaterFaces(p));
  });

  test('pass 2 only', () => {
    const block: VoxelFn = (x, y) => (y <= 3 || x === 6 ? STONE : AIR);
    const water: VoxelFn = (x, y) => (x <= 5 && y >= 4 && y <= 7 ? WATER_SOURCE : NO_FLUID);
    const p = paddedFrom(block, () => 0xF0, water);
    const { passes } = mesh(p, depthFrom(() => 4));
    expect(passes[0]).toHaveLength(0);
    expect(passes[1]).toHaveLength(0);
    expect(passes[2].length).toBeGreaterThan(0);
  });

  test("a lone source in open air: cornerDrop 3 on its four top corners (SP7a spec §6.1: 8/9 at weight 10 beside three dry voxels)", () => {
    // One source on a stone floor in open air: each top corner averages the source (8/9, weight 10) with three dry
    // voxels (0, weight 1 each): (80/9)/13 ≈ 0.684, drop round(2.85) = 3. Its top quad has drop 3 on all four
    // corners at y = 8·(ly + 1); its side faces drop their two top corners by 3 and keep their bottom corners at 0.
    const p = paddedFrom(
      (_x, y) => (y <= 3 ? STONE : AIR), () => 0xF0, (x, y, z) => (x === 8 && y === 4 && z === 8 ? WATER_SOURCE : NO_FLUID),
    );
    const { passes } = mesh(p, depthFrom((x, y, z) => (x === 8 && y === 4 && z === 8 ? 1 : 0)));
    expect(passes[2]).toHaveLength(5);
    for (const q of passes[2]) {
      const f = faceOf(q);
      q.corners.forEach((c, k) => {
        const drop = fieldsOf(q.words[k]!).cornerDrop;
        if (f === 4) {
          expect(c[1]).toBe(40);
          expect(drop).toBe(3);
        } else {
          expect(f).toBeLessThan(4);
          expect(drop).toBe(c[1] === 40 ? 3 : 0);
          expect([32, 40]).toContain(c[1]);
        }
      });
    }
    // Under water the top corners meet the voxel above: a two-high column's lower sides keep drop 0 (full height).
    const tall = paddedFrom(
      (_x, y) => (y <= 3 ? STONE : AIR), () => 0xF0,
      (x, y, z) => (x === 8 && (y === 4 || y === 5) && z === 8 ? WATER_SOURCE : NO_FLUID),
    );
    const sides = mesh(tall, depthFrom(() => 2)).passes[2].filter((q) => faceOf(q) < 4);
    expect(sides).toHaveLength(8);
    for (const q of sides) {
      const lower = Math.max(...ys(q)) === 40;
      q.corners.forEach((c, k) => expect(fieldsOf(q.words[k]!).cornerDrop).toBe(!lower && c[1] === 48 ? 3 : 0));
    }
  });

  test('meshFluid emits depth[i]: every face of voxel i carries depth[i], and different depths do not merge', () => {
    // A row of eight isolated sources along x at y 4 (one apart), each with its own depth.
    const at = (x: number, y: number, z: number): boolean => y === 4 && z === 8 && x % 2 === 0 && x < 16;
    const p = paddedFrom((_x, y) => (y <= 3 ? STONE : AIR), () => 0xF0, (x, y, z) => (at(x, y, z) ? WATER_SOURCE : NO_FLUID));
    const depth = depthFrom((x, y, z) => (at(x, y, z) ? 1 + x / 2 : 0));
    const { passes } = mesh(p, depth);
    expect(passes[2]).toHaveLength(8 * 5);
    for (const q of passes[2]) {
      const owners = new Set(unitFaces(q).map((k) => k.split(',').slice(0, 3).join(',')));
      expect(owners.size).toBe(1);
      const [x, y, z] = [...owners][0]!.split(',').map(Number) as [number, number, number];
      for (const w of q.words) expect(fieldsOf(w).depth).toBe(depth[local(x, y, z)]);
    }
    // The same surface with two depths: the top merges only within equal depth.
    const sea = paddedFrom(() => AIR, () => 0xF0, (_x, y) => (y <= 2 ? WATER_SOURCE : NO_FLUID));
    const tops = mesh(sea, depthFrom((x, y) => (y <= 2 ? (x < 8 ? 3 : 15) : 0))).passes[2];
    expect(tops).toHaveLength(2);
    expect(tops.map((q) => fieldsOf(q.words[0]!).depth).sort((a, b) => a - b)).toEqual([3, 15]);
  });

  test("water faces carry §5.3's smooth light per vertex; every word unpacks to in-range fields", () => {
    // A flat sea whose air above has sky 15 except one darker voxel (sky 9) above (8, 10, 8): the top quad's
    // vertices around it average it in, so the surface splits; all vertices away from it read 15.
    const light: VoxelFn = (x, y, z) => (x === 8 && y === 10 && z === 8 ? 0x90 : y >= 10 ? 0xF0 : 0xC0);
    const p = paddedFrom(() => AIR, light, (_x, y) => (y <= 9 ? WATER_SOURCE : NO_FLUID));
    const { passes } = mesh(p, depthFrom((_x, y) => (y <= 9 ? 15 : 0)));
    expect(passes[2].length).toBeGreaterThan(1);
    const skies = new Map<string, number>();
    for (const q of passes[2]) {
      q.corners.forEach((c, k) => {
        const f = fieldsOf(q.words[k]!);
        expect(f.layer).toBeLessThan(1024);
        const key = c.join(',');
        if (skies.has(key)) expect(skies.get(key)).toBe(f.sky);
        skies.set(key, f.sky);
      });
    }
    // The corner (8, 10, 8) in 1/8 units (64, 80, 64): the four samples 9, 15, 15, 15 → ⌊(2·54 + 4)/8⌋ = 14.
    expect(skies.get('64,80,64')).toBe(14);
    expect(skies.get('0,80,0')).toBe(15);
  });

  test('injected tables: a partial-face neighbour (PASS opaque, fullFaces without the facing bit) does not occlude water', () => {
    // State 7 is opaque with every face full but east's (bit 1): it occludes the water's west face only when its
    // facing bit (east) is set, so the water to its east draws its west face against it.
    const pass = new Uint8Array(32).fill(PASS_OPAQUE);
    pass[AIR] = PASS_NONE;
    const fullFaces = new Uint8Array(32).fill(63);
    fullFaces[AIR] = 0;
    fullFaces[7] = 63 & ~(1 << 1);
    const t: MeshTables = { pass, fullFaces, tint: new Uint8Array(32) };
    const p = paddedFrom(
      (x, y, z) => (y <= 3 ? STONE : x === 7 && y === 4 && z === 8 ? 7 : AIR), () => 0xF0,
      (x, y, z) => (x === 8 && y === 4 && z === 8 ? WATER_SOURCE : NO_FLUID),
    );
    const faces = allUnitFaces(mesh(p, depthFrom(() => 1), t).passes[2]);
    expect(faces).toContain('8,4,8,3');
  });
});

describe('still lava (SP5a spec §1.3)', () => {
  /** Lava sources at the voxels `at` holds (padded indices), the blocks from `block` (air by default). */
  const lavaAt = (at: ReadonlySet<number>, block: VoxelFn = () => AIR): PaddedSection =>
    paddedFrom(block, () => 0xF0, (x, y, z) => (at.has(padIndex(x, y, z)) ? LAVA_SOURCE : NO_FLUID));
  const one = new Set([padIndex(8, 8, 8)]);
  const lavaDepth = depthFrom((x, y, z) => (x === 8 && y === 8 && z === 8 ? 1 : 0));

  test('a lava source beside air: 6 faces in pass 0 at layer 66, full height; lava beside lava: none', () => {
    expect(LAVA_LAYER).toBe(REGISTRY.stateCount + 1);
    expect(LAVA_LAYER).toBe(66);
    const { passes } = mesh(lavaAt(one), lavaDepth);
    expect(passes[1]).toHaveLength(0);
    expect(passes[2]).toHaveLength(0);
    expect(passes[0]).toHaveLength(6);
    expect(allUnitFaces(passes[0])).toEqual(['8,8,8,0', '8,8,8,1', '8,8,8,2', '8,8,8,3', '8,8,8,4', '8,8,8,5']);
    for (const q of passes[0]) {
      const f = unpackSolid(q.words[0]!).face;
      // Full height: the voxel spans 64 … 72 in 1/8 units on every axis, the top at 8·(ly + 1).
      for (const c of q.corners) for (const v of c) expect([64, 72]).toContain(v);
      if (f === 4) expect(ys(q)).toEqual([72, 72, 72, 72]);
      // The solid word layout: the lava layer, its face, no AO, tint or flags, no frame; the open sky's light.
      for (const w of q.words) expect(unpackSolid(w)).toEqual({ layer: LAVA_LAYER, face: f, ao: 0, sky: 15, block: 0, tint: 0, flags: 0, frame: 0 });
    }
    // Two lava voxels side by side: no faces between them, ten in all.
    const pair = mesh(lavaAt(new Set([padIndex(8, 8, 8), padIndex(9, 8, 8)])), depthFrom(() => 1)).passes[0];
    const faces = allUnitFaces(pair);
    expect(faces).toHaveLength(10);
    expect(faces).not.toContain('8,8,8,1');
    expect(faces).not.toContain('9,8,8,3');
    // A section of lava, its padding included: nothing.
    const sea = paddedFrom(() => AIR, () => 0xF0, () => LAVA_SOURCE);
    expect(mesh(sea, depthFrom(() => 15)).passes.map((p) => p.length)).toEqual([0, 0, 0]);
    // Against stone (an opaque full face) its face is culled, as water's is.
    const floor = mesh(lavaAt(one, (_x, y) => (y <= 7 ? STONE : AIR)), lavaDepth).passes[0];
    expect(allUnitFaces(floor)).not.toContain('8,8,8,5');
    expect(floor).toHaveLength(5);
  });

  test('the lava face against a cutout cube (glass, ice) or a box state stays drawn', () => {
    const at = new Map([[padIndex(9, 8, 8), GLASS], [padIndex(7, 8, 8), ICE], [padIndex(8, 8, 9), LADDER], [padIndex(8, 8, 7), TORCH]]);
    const { passes } = mesh(lavaAt(one, (x, y, z) => at.get(padIndex(x, y, z)) ?? AIR), lavaDepth);
    expect(allUnitFaces(passes[0])).toEqual(['8,8,8,0', '8,8,8,1', '8,8,8,2', '8,8,8,3', '8,8,8,4', '8,8,8,5']);
    expect(passes[2]).toHaveLength(0);
  });

  test('water beside lava: the water face culled, the lava face drawn', () => {
    // Water at (8, 8, 8); lava east of it (9, 8, 8), below it (8, 7, 8) and above it (8, 9, 8); air elsewhere.
    const fluidAt = new Map([
      [padIndex(8, 8, 8), WATER_SOURCE], [padIndex(9, 8, 8), LAVA_SOURCE], [padIndex(8, 7, 8), LAVA_SOURCE], [padIndex(8, 9, 8), LAVA_SOURCE],
    ]);
    const p = paddedFrom(() => AIR, () => 0xF0, (x, y, z) => fluidAt.get(padIndex(x, y, z)) ?? NO_FLUID);
    const { passes } = mesh(p, depthFrom((x, y, z) => (x === 8 && y >= 7 && y <= 9 && z === 8 ? 3 : x === 9 && y === 8 && z === 8 ? 1 : 0)));
    const water = allUnitFaces(passes[2]);
    const lava = allUnitFaces(passes[0]);
    // The planes the two share: the lava's opaque face alone covers each one. On the side, no strip (SP7a spec §6.2):
    // each fluid counts the other as solid, so the water's and the lava source's corners there are both (80/9)/12, drop 2.
    expect(water).not.toContain('8,8,8,1');
    expect(lava).toContain('9,8,8,3');
    expect(water).not.toContain('8,8,8,5');
    expect(lava).toContain('8,7,8,4');
    // The water's surface under the lava sits below it, on no shared plane: both are drawn. Its corners follow §6.1
    // (SP7a): lava is not counted, so the corners on the lava's edge (x 9) average the water with two dry voxels,
    // (80/9)/12 ≈ 0.741, drop 2, and those on x 8 with three, drop 3.
    expect(water).toContain('8,8,8,4');
    const top = passes[2].find((q) => faceOf(q) === 4)!;
    top.corners.forEach((c, k) => expect(fieldsOf(top.words[k]!).cornerDrop).toBe(c[0] === 72 ? 2 : 3));
    expect(lava).toContain('8,9,8,5');
    // Its faces against air stay.
    expect(water).toEqual(['8,8,8,0', '8,8,8,2', '8,8,8,3', '8,8,8,4']);
  });
});

/** The drop of every vertex of the water quads, by its position `x,y,z` in 1/8 units; throws on two drops at one position. */
function dropsByPosition(quads: readonly ReadQuad[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of quads) {
    q.corners.forEach((c, k) => {
      const key = c.join(',');
      const drop = fieldsOf(q.words[k]!).cornerDrop;
      const had = out.get(key);
      if (had !== undefined && had !== drop) throw new Error(`a crack at ${key}: drops ${had} and ${drop}`);
      out.set(key, drop);
    });
  }
  return out;
}

/** The six indices of a quad split along v0-v2 (the builder's default) and along v1-v3 (`flip`). */
const SPLIT_02 = [0, 1, 2, 0, 2, 3];
const SPLIT_13 = [1, 2, 3, 1, 3, 0];

describe('flowing water (SP7a spec §6.1-§6.2, D26)', () => {
  /** A 5 × 5 pool of sources at y 4 (x, z 6 … 10) on a stone floor, the ring around it at y 4 from `ring`. */
  const POOL = (x: number, z: number): boolean => x >= 6 && x <= 10 && z >= 6 && z <= 10;
  const pool = (ring: number): PaddedSection => paddedFrom(
    (x, y, z) => (y <= 3 || (y === 4 && !POOL(x, z) && ring === STONE) ? STONE : AIR), () => 0xF0,
    (x, y, z) => (y === 4 && POOL(x, z) ? WATER_SOURCE : NO_FLUID),
  );
  const poolDepth = depthFrom((x, y, z) => (y === 4 && POOL(x, z) ? 1 : 0));

  test('a 5 × 5 pool of sources against stone: one top quad, every corner drop 1 (as before)', () => {
    const { passes } = mesh(pool(STONE), poolDepth);
    expect(passes[2]).toHaveLength(1);
    const top = passes[2][0]!;
    expect(faceOf(top)).toBe(4);
    expect(ys(top)).toEqual([40, 40, 40, 40]);
    for (const w of top.words) expect(fieldsOf(w).cornerDrop).toBe(1);
    expect(top.index).toEqual(SPLIT_02);
  });

  test('the same pool against air at the same y: edge corners drop 2, outer corners 3, inner corners 1', () => {
    // An edge corner: two sources and two dry voxels, (2·80/9)/22 ≈ 0.808, (1 − 0.808)·9 ≈ 1.73 → 2; an outer corner:
    // one source and three dry voxels, (80/9)/13 ≈ 0.684 → 2.85 → 3; an inner corner: four sources, 8/9 → 1.
    const p = pool(AIR);
    const { passes } = mesh(p, poolDepth);
    expect(allUnitFaces(passes[2])).toEqual(bruteWaterFaces(p));
    const tops = passes[2].filter((q) => faceOf(q) === 4);
    const drops = dropsByPosition(tops);
    // Every rim corner is a vertex; an inner corner is one where a rim voxel's quad meets the inner quad.
    const edgesOf = (X: number, Z: number): number => (X === 6 || X === 11 ? 1 : 0) + (Z === 6 || Z === 11 ? 1 : 0);
    for (let X = 6; X <= 11; X++) {
      for (let Z = 6; Z <= 11; Z++) if (edgesOf(X, Z) > 0) expect(drops.get(`${8 * X},40,${8 * Z}`), `corner (${X}, ${Z})`).toBe([1, 2, 3][edgesOf(X, Z)]);
    }
    for (const [key, drop] of drops) {
      const [x8, y8, z8] = key.split(',').map(Number) as [number, number, number];
      expect(y8).toBe(40);
      expect(drop, `corner ${key}`).toBe([1, 2, 3][edgesOf(x8 / 8, z8 / 8)]);
    }
    expect(drops.get('56,40,56'), 'the inner corner (7, 7)').toBe(1);
    // The inner 3 × 3 is flat (drop 1) and merges into one quad; the 16 rim voxels are sloped, one quad each.
    expect(tops).toHaveLength(17);
    expect(tops.filter((q) => q.words.every((w) => fieldsOf(w).cornerDrop === 1))).toHaveLength(1);
    // The sides against air take the same top corners: per side the middle three merge (2, 2), the ends (3, 2), (2, 3).
    const sides = passes[2].filter((q) => faceOf(q) < 4);
    expect(sides).toHaveLength(12);
    const all = dropsByPosition(passes[2]);
    for (const [key, drop] of drops) expect(all.get(key)).toBe(drop);
  });

  /**
   * A two-wide spill at y 4 on a stone floor, a stone wall at x −1: row z 8 holds a source at x 0 and level x at x 1 … 7,
   * row z 9 level x + 1 at x 0 … 6; air elsewhere at y 4 and above.
   */
  const spillLevel = (x: number, z: number): number => (z === 8 && x >= 0 && x <= 7 ? x : z === 9 && x >= 0 && x <= 6 ? x + 1 : -1);
  const spill = paddedFrom(
    (x, y) => (y <= 3 || (y === 4 && x === -1) ? STONE : AIR), () => 0xF0,
    (x, y, z) => (y === 4 && spillLevel(x, z) >= 0 ? packFluid(FLUID_WATER, spillLevel(x, z)) : NO_FLUID),
  );
  const spillDepth = depthFrom((x, y, z) => (y === 4 && spillLevel(x, z) >= 0 ? 1 : 0));

  test('a level-1 … 7 spill: each top one quad with the corner drops of §6.1, split along the lower-sum diagonal', () => {
    // Per voxel [x, z, drops at (x, z), (x + 1, z), (x + 1, z + 1), (x, z + 1)], from §6.1: h = (8 − level)/9, a height
    // ≥ 0.8 weighing 10, other water 1, a dry voxel 0 with weight 1, stone not counted; drop round((1 − h)·9). E.g.
    // (1, 9) averages the source (weight 10) with levels 1, 2, 1: (80/9 + 7/9 + 6/9 + 7/9)/13 ≈ 0.855 → 1; (2, 9)
    // levels 1, 2, 3, 2: (24/9)/4 ≈ 0.667 → 3; (2, 8) levels 1, 2 with two dry voxels: (13/9)/4 ≈ 0.361 → 5.75 → 6.
    const want: Array<[number, number, [number, number, number, number]]> = [
      [0, 8, [2, 2, 1, 1]], [1, 8, [2, 6, 3, 1]], [2, 8, [6, 6, 4, 3]], [3, 8, [6, 7, 5, 4]], [4, 8, [7, 7, 6, 5]],
      [5, 8, [7, 8, 7, 6]], [6, 8, [8, 8, 8, 7]], [7, 8, [8, 8, 8, 8]],
      [0, 9, [1, 1, 6, 6]], [1, 9, [1, 3, 6, 6]], [2, 9, [3, 4, 7, 6]], [3, 9, [4, 5, 7, 7]], [4, 9, [5, 6, 8, 7]],
      [5, 9, [6, 7, 8, 8]], [6, 9, [7, 8, 8, 8]],
    ];
    // The voxels whose v1-v3 diagonal has the lower summed height (the builder's flip); every other one splits v0-v2.
    const flipped = new Set(['1,8', '1,9', '3,9', '5,9', '6,9']);
    const tops = mesh(spill, spillDepth).passes[2].filter((q) => faceOf(q) === 4);
    expect(tops).toHaveLength(want.length);
    for (const [x, z, [c0, c1, c2, c3]] of want) {
      const owned = tops.filter((q) => q.corners.every((c) => c[0] >= 8 * x && c[0] <= 8 * x + 8 && c[2] >= 8 * z && c[2] <= 8 * z + 8));
      expect(owned, `voxel (${x}, ${z}): one top quad`).toHaveLength(1);
      const q = owned[0]!;
      const at = (X: number, Z: number): number => {
        const k = q.corners.findIndex((c) => c[0] === 8 * X && c[2] === 8 * Z);
        expect(k, `voxel (${x}, ${z}) has a vertex at (${X}, ${Z})`).toBeGreaterThanOrEqual(0);
        expect(q.corners[k]![1]).toBe(40);
        return fieldsOf(q.words[k]!).cornerDrop;
      };
      expect([at(x, z), at(x + 1, z), at(x + 1, z + 1), at(x, z + 1)], `voxel (${x}, ${z})`).toEqual([c0, c1, c2, c3]);
      const h = q.words.map((w) => 9 - fieldsOf(w).cornerDrop);
      expect(q.index, `voxel (${x}, ${z})'s split`).toEqual(h[0]! + h[2]! <= h[1]! + h[3]! ? SPLIT_02 : SPLIT_13);
      expect(q.index, `voxel (${x}, ${z})'s split, pinned`).toEqual(flipped.has(`${x},${z}`) ? SPLIT_13 : SPLIT_02);
    }
  });

  test('a falling column: full-height sides and no top under water; a falling top with nothing above is full height', () => {
    const FALLING = packFluid(FLUID_WATER, 0, true);
    // Falling water at (8, 4 … 10, 8) on a stone floor, air above: the top voxel (nothing above) is full height too.
    const bare = paddedFrom(
      (_x, y) => (y <= 3 ? STONE : AIR), () => 0xF0, (x, y, z) => (x === 8 && z === 8 && y >= 4 && y <= 10 ? FALLING : NO_FLUID),
    );
    const one = mesh(bare, depthFrom((x, y, z) => (x === 8 && z === 8 && y >= 4 && y <= 10 ? 7 : 0))).passes[2];
    // One top quad at y 88 (8·11) with drop 0, and one merged side quad per side spanning y 32 … 88, every drop 0.
    expect(one.map(faceOf).sort()).toEqual([0, 1, 2, 3, 4]);
    for (const q of one) {
      for (const w of q.words) expect(fieldsOf(w).cornerDrop).toBe(0);
      if (faceOf(q) === 4) expect(ys(q)).toEqual([88, 88, 88, 88]);
      else expect([Math.min(...ys(q)), Math.max(...ys(q))]).toEqual([32, 88]);
    }
    // Falling at y 4 … 9 under a source at y 10: no top below the source; the falling sides stay full height (drop 0)
    // and merge into one quad per side (y 32 … 80); the source's top and side top corners drop 3 (alone in the air).
    const fed = paddedFrom(
      (_x, y) => (y <= 3 ? STONE : AIR), () => 0xF0,
      (x, y, z) => (x === 8 && z === 8 ? (y >= 4 && y <= 9 ? FALLING : y === 10 ? WATER_SOURCE : NO_FLUID) : NO_FLUID),
    );
    const quads = mesh(fed, depthFrom((x, y, z) => (x === 8 && z === 8 && y >= 4 && y <= 10 ? 7 : 0))).passes[2];
    const tops = quads.filter((q) => faceOf(q) === 4);
    expect(tops).toHaveLength(1);
    expect(ys(tops[0]!)).toEqual([88, 88, 88, 88]);
    for (const w of tops[0]!.words) expect(fieldsOf(w).cornerDrop).toBe(3);
    const sides = quads.filter((q) => faceOf(q) < 4);
    expect(sides).toHaveLength(8);
    for (const q of sides) {
      const [lo, hi] = [Math.min(...ys(q)), Math.max(...ys(q))];
      if (hi === 80) {
        expect(lo).toBe(32);
        for (const w of q.words) expect(fieldsOf(w).cornerDrop).toBe(0);
      } else {
        expect([lo, hi]).toEqual([80, 88]);
        q.corners.forEach((c, k) => expect(fieldsOf(q.words[k]!).cornerDrop).toBe(c[1] === 88 ? 3 : 0));
      }
    }
  });

  test('two neighbouring voxels share each corner\'s drop exactly (no crack: the shared vertices\' y equal)', () => {
    // Every vertex of every water quad, tops and sides, of the spill and of the pool against air: one drop per position.
    for (const [p, depth] of [[spill, spillDepth], [pool(AIR), poolDepth]] as const) {
      const quads = mesh(p, depth).passes[2];
      expect(() => dropsByPosition(quads)).not.toThrow();
      // Each interior corner of the spill or pool is a vertex of all four voxels' top quads around it.
      const tops = quads.filter((q) => faceOf(q) === 4);
      const seen = new Map<string, number>();
      for (const q of tops) for (const c of q.corners) seen.set(c.join(','), (seen.get(c.join(',')) ?? 0) + 1);
      expect(Math.max(...seen.values())).toBeGreaterThanOrEqual(3);
    }
  });

  test('a still water body\'s quads per face unchanged where every corner is 8/9 (R5\'s still case)', () => {
    // An L-shaped lake of sources at y 4 in a stone basin: x 0 … 9 × z 0 … 3 and x 0 … 3 × z 4 … 9. Every corner sees
    // only sources and stone, so every drop is 1 and the top merges greedily as before: two quads, nothing else.
    const lake = (x: number, z: number): boolean => (x >= 0 && x <= 9 && z >= 0 && z <= 3) || (x >= 0 && x <= 3 && z >= 4 && z <= 9);
    const p = paddedFrom(
      (x, y, z) => (y <= 3 || (y === 4 && !lake(x, z)) ? STONE : AIR), () => 0xF0,
      (x, y, z) => (y === 4 && lake(x, z) ? WATER_SOURCE : NO_FLUID),
    );
    const quads = mesh(p, depthFrom((x, y, z) => (y === 4 && lake(x, z) ? 1 : 0))).passes[2];
    expect(quads).toHaveLength(2);
    for (const q of quads) {
      expect(faceOf(q)).toBe(4);
      expect(q.index).toEqual(SPLIT_02);
      for (const w of q.words) expect(fieldsOf(w).cornerDrop).toBe(1);
    }
    expect(allUnitFaces(quads)).toHaveLength(64);
  });
});

describe('side strips (SP7a spec §6.2)', () => {
  const FALLING = packFluid(FLUID_WATER, 0, true);
  const water = (level: number): number => packFluid(FLUID_WATER, level);
  const lava = (level: number): number => packFluid(FLUID_LAVA, level);
  /** Two voxels at y 4 on a stone floor, (8, 4, 8) holding `a` and (9, 4, 8) holding `b`, air (or `ring`) around them. */
  const pair = (a: number, b: number, ring = AIR): PaddedSection => paddedFrom(
    (x, y, z) => (y <= 3 || (y === 4 && ring === STONE && !(z === 8 && (x === 8 || x === 9))) ? STONE : AIR), () => 0xF0,
    (x, y, z) => (y === 4 && z === 8 ? (x === 8 ? a : x === 9 ? b : NO_FLUID) : NO_FLUID),
  );
  const pairDepth = depthFrom((x, y, z) => (y === 4 && z === 8 && (x === 8 || x === 9) ? 1 : 0));
  /** The water quads of `p` owning the unit face `key` (`x,y,z,face`). */
  const owning = (quads: readonly ReadQuad[], key: string): ReadQuad[] => quads.filter((q) => unitFaces(q).includes(key));
  /** A strip's vertices: all four positions at the owner's top (y 40 here), the drops by position `x,z`. */
  function stripDrops(q: ReadQuad): Map<string, number[]> {
    expect(ys(q), 'every strip position at the voxel\'s top').toEqual([40, 40, 40, 40]);
    const out = new Map<string, number[]>();
    q.corners.forEach((c, k) => {
      const key = `${c[0]! / 8},${c[2]! / 8}`;
      out.set(key, [...(out.get(key) ?? []), fieldsOf(q.words[k]!).cornerDrop].sort((a, b) => a - b));
    });
    return out;
  }

  test('a level-2 voxel beside a level-5 voxel at one y draws no face on the shared side (both read the same two corners); equal levels draw nothing', () => {
    for (const [a, b] of [[2, 5], [3, 3]] as const) {
      const quads = mesh(pair(water(a), water(b)), pairDepth).passes[2];
      const faces = allUnitFaces(quads);
      expect(faces, `levels ${a}, ${b}`).not.toContain('8,4,8,1');
      expect(faces, `levels ${a}, ${b}`).not.toContain('9,4,8,3');
      // Their two tops and their six sides against air, nothing else.
      expect(faces, `levels ${a}, ${b}`).toEqual(['8,4,8,0', '8,4,8,2', '8,4,8,3', '8,4,8,4', '9,4,8,0', '9,4,8,1', '9,4,8,2', '9,4,8,4']);
      expect(() => dropsByPosition(quads)).not.toThrow();
    }
  });

  test('a falling voxel with no water above beside a flowing voxel: a strip from the flowing voxel\'s corner drops up to drop 0', () => {
    // (8, 4, 8) falling with nothing above (a synthetic byte: in the settled world every fall has water above) beside
    // level 3 at (9, 4, 8). The shared corners (9, 8) and (9, 9) average the fall (h 1, weight 10), the level-3 voxel
    // (5/9) and two dry voxels: (10 + 5/9)/13 ≈ 0.812, drop 2.
    const quads = mesh(pair(FALLING, water(3)), pairDepth).passes[2];
    const strips = owning(quads, '8,4,8,1');
    expect(strips).toHaveLength(1);
    const strip = strips[0]!;
    expect(unitFaces(strip)).toEqual(['8,4,8,1']);
    expect(fieldsOf(strip.words[0]!).face).toBe(1);
    // Its bottom vertices sit on the flowing voxel's top corners (the gap closed exactly), its top ones at drop 0.
    const top = owning(quads, '9,4,8,4')[0]!;
    const topDrop = (X: number, Z: number): number => fieldsOf(top.words[top.corners.findIndex((c) => c[0] === 8 * X && c[2] === 8 * Z)]!).cornerDrop;
    expect([topDrop(9, 8), topDrop(9, 9)]).toEqual([2, 2]);
    expect(stripDrops(strip)).toEqual(new Map([['9,8', [0, 2]], ['9,9', [0, 2]]]));
    // The flowing voxel's side toward the fall: none (its neighbour is higher).
    expect(allUnitFaces(quads)).not.toContain('9,4,8,3');
  });

  test('a water source beside flowing lava (level 4, h 4/9) draws a strip from lava\'s corners up to 8/9; beside a lava source (8/9) nothing', () => {
    // A stone channel: only the two voxels are open at y 4, so the water's corners see only itself (8/9, drop 1) and
    // lava's only itself (each fluid counts the other as solid): 4/9 is drop 5.
    const flowing = mesh(pair(WATER_SOURCE, lava(4), STONE), pairDepth);
    const strips = owning(flowing.passes[2], '8,4,8,1');
    expect(strips).toHaveLength(1);
    expect(stripDrops(strips[0]!)).toEqual(new Map([['9,8', [1, 5]], ['9,9', [1, 5]]]));
    expect(allUnitFaces(flowing.passes[2])).toEqual(['8,4,8,1', '8,4,8,4']);
    // Lava draws its side against the water (pass 0), as against any non-lava neighbour.
    expect(allUnitFaces(flowing.passes[0])).toEqual(['9,4,8,3', '9,4,8,4']);
    // A lava source: 8/9 against 8/9, no strip; the water's top alone.
    const still = mesh(pair(WATER_SOURCE, LAVA_SOURCE, STONE), pairDepth);
    expect(allUnitFaces(still.passes[2])).toEqual(['8,4,8,4']);
    expect(allUnitFaces(still.passes[0])).toEqual(['9,4,8,3', '9,4,8,4']);
  });

  test('a fall into a pool: the pool\'s sides toward the falling column draw nothing (the column is full height)', () => {
    // A 5 × 5 pool of sources at y 4 in a stone basin, a falling column at (8, 4 … 10, 8) under a source at (8, 11, 8).
    const POOL = (x: number, z: number): boolean => x >= 6 && x <= 10 && z >= 6 && z <= 10;
    const p = paddedFrom(
      (x, y, z) => (y <= 3 || (y === 4 && !POOL(x, z)) ? STONE : AIR), () => 0xF0,
      (x, y, z) => (x === 8 && z === 8 && y >= 4 && y <= 10 ? FALLING : x === 8 && z === 8 && y === 11 ? WATER_SOURCE
        : y === 4 && POOL(x, z) ? WATER_SOURCE : NO_FLUID),
    );
    const quads = mesh(p, depthFrom((x, y, z) => (x === 8 && z === 8 && y >= 4 && y <= 11 ? 8 : y === 4 && POOL(x, z) ? 1 : 0))).passes[2];
    const faces = allUnitFaces(quads);
    // At y 4 only tops: the pool's sides meet stone or water, and none toward the column; the column's at y 4 none.
    expect(faces.filter((k) => k.split(',')[1] === '4' && Number(k.split(',')[3]) < 4)).toEqual([]);
    // The pool's corners at the column are 1 (it holds water with water above): drop 0 where its tops meet it.
    const drops = dropsByPosition(quads.filter((q) => faceOf(q) === 4 && ys(q)[0] === 40));
    for (const c of ['64,40,64', '72,40,64', '72,40,72', '64,40,72']) expect(drops.get(c), `corner ${c}`).toBe(0);
    // The column's sides above the pool: full height (drop 0), y 5 … 10 merged per side.
    for (const f of [0, 1, 2, 3]) {
      const side = quads.filter((q) => faceOf(q) === f && Math.max(...ys(q)) === 88);
      expect(side, `face ${f}`).toHaveLength(1);
      expect(Math.min(...ys(side[0]!))).toBe(40);
      for (const w of side[0]!.words) expect(fieldsOf(w).cornerDrop).toBe(0);
    }
  });
});

describe("R1's brute force in lockstep with the strips (SP7a spec §6.2, §13.3; ruling P11)", () => {
  /** A face key as `bruteFaces` builds it: ((y + 64)·256 + lz·16 + lx)·6 + face. */
  const key = (lx: number, y: number, lz: number, f: number): number => ((y + 64) * 256 + lz * 16 + lx) * 6 + f;
  const FALLING = packFluid(FLUID_WATER, 0, true);
  const water = (level: number): number => packFluid(FLUID_WATER, level);
  const lava = (level: number): number => packFluid(FLUID_LAVA, level);

  /**
   * A hand-built 3 × 3 of Published columns around (0, 0) on a stone floor (y ≤ 3), with light 0xF0, at y 4 …:
   * - a spill along z 2: a source at x 1, levels 1 … 7 at x 2 … 8;
   * - a fall: falling water at (12, 4 … 8, 12) under a source at (12, 9, 12), landing in levels 1 and 2 around it;
   * - a fall with nothing above at the seam: falling (15, 4, 6) between level 2 at x 14 and level 3 at x 16 (the east
   *   column);
   * - lava steps along z 10: a source at x 3, levels 2, 4, 6 at x 4 … 6, beside a row of water sources along z 11
   *   (x 3 … 7); lava at (7, 5, 11) over the water at (7, 4, 11), and a water source at (3, 5, 10) over the lava source.
   */
  function scene(): VoxelStore {
    const at = new Map<string, number>();
    const put = (x: number, y: number, z: number, f: number): void => void at.set(`${x},${y},${z}`, f);
    put(1, 4, 2, WATER_SOURCE);
    for (let k = 1; k <= 7; k++) put(1 + k, 4, 2, water(k));
    for (let y = 4; y <= 8; y++) put(12, y, 12, FALLING);
    put(12, 9, 12, WATER_SOURCE);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      put(12 + dx, 4, 12 + dz, water(1));
      put(12 + 2 * dx, 4, 12 + 2 * dz, water(2));
    }
    put(15, 4, 6, FALLING);
    put(14, 4, 6, water(2));
    put(16, 4, 6, water(3));
    put(3, 4, 10, LAVA_SOURCE);
    for (let k = 1; k <= 3; k++) put(3 + k, 4, 10, lava(2 * k));
    for (let x = 3; x <= 7; x++) put(x, 4, 11, WATER_SOURCE);
    put(7, 5, 11, LAVA_SOURCE);
    put(3, 5, 10, WATER_SOURCE);
    const s = createStore({ shared: false, maxBlockBytes: 32 << 20, maxByteBytes: 32 << 20 });
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        const w = s.claimColumn(cx, cz, 0);
        for (let sy = 0; sy < SECTIONS; sy++) {
          const blocks = new Uint16Array(4096);
          const fluid = new Uint8Array(4096);
          for (let i = 0; i < 4096; i++) {
            const [x, y, z] = [16 * cx + (i & 15), -64 + 16 * sy + (i >> 8), 16 * cz + ((i >> 4) & 15)];
            blocks[i] = y <= 3 ? STONE : AIR;
            fluid[i] = at.get(`${x},${y},${z}`) ?? NO_FLUID;
          }
          w.setFinal(sy, blocks, new Uint8Array(4096).fill(0xF0), fluid);
        }
        w.commit(3);
      }
    }
    return s;
  }

  /** R1's two counts of one category: mesh keys missing from brute plus repeats, and brute keys missing from the mesh. */
  function diff(mesh: Uint32Array, brute: Uint32Array): { hiddenEmitted: number; visibleMissing: number } {
    const want = new Set(brute);
    const seen = new Set<number>();
    let hiddenEmitted = 0;
    for (const k of mesh) {
      if (!want.has(k) || seen.has(k)) hiddenEmitted++;
      seen.add(k);
    }
    return { hiddenEmitted, visibleMissing: brute.filter((k) => !seen.has(k)).length };
  }

  test('a spill, a fall and lava steps: bruteFaces and meshFaceCounts agree (hiddenEmitted 0, visibleMissing 0 for water and opaque)', () => {
    const s = scene();
    const brute = bruteFaces(regionView(s, -1, -1, 3, 3), 0, 0);
    // The strips are visible faces of the brute force: the seam fall's toward level 3, and water toward lava levels 4
    // and 6 (lava's corners lower); none toward the lava source at x 3, whose corners there (its 8/9 at weight 10) meet
    // water's.
    for (const k of [key(15, 4, 6, FACE_EAST), key(5, 4, 11, FACE_NORTH), key(6, 4, 11, FACE_NORTH)]) expect(brute.water).toContain(k);
    expect(brute.water).not.toContain(key(3, 4, 11, FACE_NORTH));
    // Water's up face under lava shows, its down face over lava does not; lava's faces toward water are opaque.
    expect(brute.water).toContain(key(7, 4, 11, FACE_UP));
    expect(brute.water).not.toContain(key(3, 5, 10, FACE_DOWN));
    for (const k of [key(7, 5, 11, FACE_DOWN), key(3, 4, 10, FACE_UP), key(4, 4, 10, FACE_SOUTH)]) expect(brute.opaque).toContain(k);
    for (const o of [{ ao: true, smoothLight: true }, { ao: false, smoothLight: false }]) {
      const m = meshFaceCounts(meshColumnPayload(s.neighborhood(0, 0), createMeshScratch(), o));
      expect(diff(m.water, brute.water), 'water').toEqual({ hiddenEmitted: 0, visibleMissing: 0 });
      expect(diff(m.opaque, brute.opaque), 'opaque').toEqual({ hiddenEmitted: 0, visibleMissing: 0 });
    }
  });

  test('meshFaceCounts maps a side strip (four positions at one y) to its owner\'s one unit face: a water strip and a degenerate lava strip', () => {
    // Section 4 (y 0 … 15). A lava strip of pass 0 (`LAVA_LAYER`, face north, all drops 0: no height) on the z = 5 plane
    // over x 3 … 4 at position y 24 (owner (3, 2, 5)); a water strip of pass 2 (face east, drops 4 at the bottom) on the
    // x = 8 plane over z 6 … 7 at position y 88 (owner (7, 10, 6)).
    const solid = packSolid({ layer: LAVA_LAYER, face: FACE_NORTH, ao: 0, sky: 15, block: 15, tint: 0, flags: 0, frame: 0 });
    const fluidWord = (drop: number): number => packFluidWord({ layer: 0, face: FACE_EAST, sky: 15, block: 0, depth: 1, tint: 0, cornerDrop: drop });
    const payload: ColumnMeshPayload = {
      cx: 0, cz: 0, versions: new Int32Array(18), connectivity: new Uint16Array(24),
      position: new Uint8Array([24, 24, 40, 0, 32, 24, 40, 0, 32, 24, 40, 0, 24, 24, 40, 0, 64, 88, 48, 0, 64, 88, 48, 0, 64, 88, 56, 0, 64, 88, 56, 0]),
      data: new Uint32Array([solid, solid, solid, solid, fluidWord(4), fluidWord(0), fluidWord(0), fluidWord(4)]),
      index: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3]),
      rows: new Int32Array([4, 0, 0, 4, 0, 6, 4, 2, 4, 4, 6, 6]),
      spheres: new Float32Array(8),
    };
    const m = meshFaceCounts(payload);
    expect([...m.opaque]).toEqual([key(3, 2, 5, FACE_NORTH)]);
    expect([...m.water]).toEqual([key(7, 10, 6, FACE_EAST)]);
    expect([m.quadsOpaque, m.quadsWater]).toEqual([1, 1]);
  });
});

/** A store holding only the centre column (0, 0), Published, its fluid from `fluid(x, y, z)` (y absolute). */
function storeWith(fluid: (x: number, y: number, z: number) => number): NeighborhoodReader {
  const store = createStore({ shared: false, maxBlockBytes: 16 << 20, maxByteBytes: 16 << 20 });
  const w = store.claimColumn(0, 0, 0);
  for (let sy = 0; sy < SECTIONS; sy++) {
    const f = new Uint8Array(4096);
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) f[local(x, y, z)] = fluid(x, -64 + 16 * sy + y, z);
    w.setFinal(sy, new Uint16Array(4096), new Uint8Array(4096), f);
  }
  w.commit(3);
  return store.neighborhood(0, 0);
}

function depthsOf(nb: NeighborhoodReader, sy: number): Uint8Array {
  const out = new Uint8Array(4096).fill(99);
  fluidDepths(nb, sy, out);
  return out;
}

describe('fluidDepths (SP4a spec §5.5; ruling P24)', () => {
  // Section 10 spans y 96 … 111. Column (0, 0): a 10-deep run whose surface is at local y 2 of section 10 (y 98),
  // so 3 voxels in section 10 and 7 in section 9 (y 89 … 98). Column (1, 0): a 20-deep run, y 80 … 99.
  // Column (2, 0): a 1-deep pond at y 100. Everything else holds no fluid.
  const SY = 10;
  const run = (x: number, y: number, z: number): number => {
    if (z !== 0) return NO_FLUID;
    if (x === 0) return y >= 89 && y <= 98 ? WATER_SOURCE : NO_FLUID;
    if (x === 1) return y >= 80 && y <= 99 ? WATER_SOURCE : NO_FLUID;
    if (x === 2) return y === 100 ? WATER_SOURCE : NO_FLUID;
    return NO_FLUID;
  };
  const nb = storeWith(run);
  const yOf = (sy: number, ly: number): number => -64 + 16 * sy + ly;

  test('a 10-deep column whose surface is at local y 2 of sy gives 10 for every voxel, in both sections', () => {
    const top = depthsOf(nb, SY);
    const below = depthsOf(nb, SY - 1);
    for (let ly = 0; ly <= 2; ly++) expect(top[local(0, ly, 0)]).toBe(10);
    for (let ly = 9; ly <= 15; ly++) expect(below[local(0, ly, 0)]).toBe(10);
    expect(yOf(SY, 2)).toBe(98);
    expect(yOf(SY - 1, 9)).toBe(89);
  });

  test('a 20-deep column gives 15', () => {
    const top = depthsOf(nb, SY);
    const below = depthsOf(nb, SY - 1);
    for (let ly = 0; ly <= 3; ly++) expect(top[local(1, ly, 0)]).toBe(15);
    for (let ly = 0; ly <= 15; ly++) expect(below[local(1, ly, 0)]).toBe(15);
  });

  test('a 1-deep pond gives 1', () => {
    expect(depthsOf(nb, SY)[local(2, 4, 0)]).toBe(1);
  });

  test('non-fluid voxels give 0', () => {
    for (const sy of [SY - 1, SY]) {
      const d = depthsOf(nb, sy);
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            if (run(x, yOf(sy, y), z) === NO_FLUID) expect(d[local(x, y, z)]).toBe(0);
          }
        }
      }
    }
  });

  test('below y −64 is non-fluid and a run ends at y 319; uniform water sections are read too', () => {
    // At (0, 0) a 3-deep run on the world's floor (y −64 … −62) and a 2-deep run at its top (y 318, 319); everywhere
    // water from y 64 to 111, so sections 8 … 10 are uniform water (no slot) and their 48-deep run reads 15.
    const nb2 = storeWith((x, y, z) => {
      if (y >= 64 && y < 112) return WATER_SOURCE;
      return x === 0 && z === 0 && (y <= -62 || y >= 318) ? WATER_SOURCE : NO_FLUID;
    });
    expect(nb2.final(0, 0)!.sectionFluid(9)).toBe(WATER_SOURCE);
    expect(depthsOf(nb2, 0)[local(0, 0, 0)]).toBe(3);
    expect(depthsOf(nb2, 0)[local(0, 2, 0)]).toBe(3);
    expect(depthsOf(nb2, 0)[local(0, 3, 0)]).toBe(0);
    expect(depthsOf(nb2, SECTIONS - 1)[local(0, 15, 0)]).toBe(2);
    expect(depthsOf(nb2, SECTIONS - 1)[local(0, 14, 0)]).toBe(2);
    expect(depthsOf(nb2, SECTIONS - 1)[local(0, 13, 0)]).toBe(0);
    for (const sy of [8, 9, 10]) expect(depthsOf(nb2, sy).every((v) => v === 15)).toBe(true);
    expect(depthsOf(nb2, 7)[local(5, 15, 5)]).toBe(0);
    expect(depthsOf(nb2, 11)[local(5, 0, 5)]).toBe(0);
  });

  test('fluidDepths returns false for a dry section and true for one with water', () => {
    // Section 0 holds no fluid (the uniform-dry return); sections SY − 1 and SY hold the runs; section SY + 1 holds
    // none either.
    expect(fluidDepths(nb, 0, new Uint8Array(4096))).toBe(false);
    expect(fluidDepths(nb, SY + 1, new Uint8Array(4096))).toBe(false);
    expect(fluidDepths(nb, SY - 1, new Uint8Array(4096))).toBe(true);
    expect(fluidDepths(nb, SY, new Uint8Array(4096))).toBe(true);
    // A uniform water section.
    const wet = storeWith((_x, y) => (y >= 64 && y < 112 ? WATER_SOURCE : NO_FLUID));
    expect(wet.final(0, 0)!.sectionFluid(9)).toBe(WATER_SOURCE);
    expect(fluidDepths(wet, 9, new Uint8Array(4096))).toBe(true);
    // A dense fluid array without a fluid voxel: every depth is 0, so the section is dry.
    const dense: Partial<ColumnView> = { sectionFluid: () => new Uint8Array(4096) };
    const fake = { cx: 0, cz: 0, final: (dx: number, dz: number) => (dx === 0 && dz === 0 ? dense : null) } as unknown as NeighborhoodReader;
    const out = new Uint8Array(4096).fill(7);
    expect(fluidDepths(fake, 5, out)).toBe(false);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  test('water under or over lava keeps its own depth, lava gets 0, and a lava-only section is still wet', () => {
    // At (3, 0): a 1-deep pond at y 100 with lava on it (y 101). At (4, 0): water at y 100 on a lava pool (y 97 … 99).
    // At (5, 0): a 2-deep water run (y 98, 99) under 3 lava (y 100 … 102). Section 11 (y 112 … 127): lava at (6, 115).
    const lava = storeWith((x, y, z) => {
      if (z !== 0) return NO_FLUID;
      if (x === 3) return y === 100 ? WATER_SOURCE : y === 101 ? LAVA_SOURCE : NO_FLUID;
      if (x === 4) return y === 100 ? WATER_SOURCE : y >= 97 && y <= 99 ? LAVA_SOURCE : NO_FLUID;
      if (x === 5) return y === 98 || y === 99 ? WATER_SOURCE : y >= 100 && y <= 102 ? LAVA_SOURCE : NO_FLUID;
      if (x === 6) return y === 115 ? LAVA_SOURCE : NO_FLUID;
      return NO_FLUID;
    });
    const d = depthsOf(lava, SY);
    expect([d[local(3, 4, 0)], d[local(3, 5, 0)]]).toEqual([1, 0]);
    expect([d[local(4, 1, 0)], d[local(4, 2, 0)], d[local(4, 3, 0)], d[local(4, 4, 0)]]).toEqual([0, 0, 0, 1]);
    expect([d[local(5, 2, 0)], d[local(5, 3, 0)], d[local(5, 4, 0)], d[local(5, 6, 0)]]).toEqual([2, 2, 0, 0]);
    // The lava-only section returns true, so the mesh job still runs meshFluid for its lava; every depth is 0.
    const out = new Uint8Array(4096).fill(7);
    expect(fluidDepths(lava, SY + 1, out)).toBe(true);
    expect(out.every((v) => v === 0)).toBe(true);
    // A uniform lava section likewise.
    const sea = storeWith((_x, y) => (y >= 112 && y < 128 ? LAVA_SOURCE : NO_FLUID));
    expect(sea.final(0, 0)!.sectionFluid(SY + 1)).toBe(LAVA_SOURCE);
    expect(fluidDepths(sea, SY + 1, out.fill(7))).toBe(true);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  test("a section whose own fluid is uniform 0 fills zeros and reads no other section", () => {
    const reads: number[] = [];
    const centre: Partial<ColumnView> = {
      sectionFluid(sy: number) {
        reads.push(sy);
        return NO_FLUID;
      },
    };
    const fake = { cx: 0, cz: 0, final: (dx: number, dz: number) => (dx === 0 && dz === 0 ? centre : null) } as unknown as NeighborhoodReader;
    const out = new Uint8Array(4096).fill(7);
    expect(fluidDepths(fake, 5, out)).toBe(false);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(reads).toEqual([5]);
  });
});

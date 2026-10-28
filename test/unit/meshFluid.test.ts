/**
 * The still-water mesher and the water depth (SP4a spec §5.5, §5.6; rulings P24, P25): faces against non-occluders
 * that are not water, full-height positions with `cornerDrop` 1 on a surface voxel's top corners, the column's
 * `depth` in every word and key, the translucent pass only, and `fluidDepths` on a hand-built store.
 */
import { describe, expect, test } from 'vitest';
import { createMeshBuilder, type MeshBuilder } from '../../src/mesh/builder';
import { fluidDepths, meshFluid } from '../../src/mesh/fluid';
import { LAVA_LAYER, type MeshTables } from '../../src/mesh/greedy';
import { unpackFluid, unpackSolid, type FluidFields } from '../../src/mesh/packing';
import { AIR, GLASS, ICE, LADDER, REGISTRY, STONE, TORCH } from '../../src/world/blocks/index';
import { LAVA_SOURCE, NO_FLUID, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { PASS_NONE, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import { SECTIONS } from '../../src/world/store/columnTable';
import { padIndex, type PaddedSection } from '../../src/world/store/padded';
import { createStore } from '../../src/world/store/store';
import type { ColumnView, NeighborhoodReader } from '../../src/world/store/api';
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

/** The unit faces a quad covers, as `x,y,z,face` keys of the voxel that owns each face. */
function unitFaces(q: ReadQuad): string[] {
  const f = faceOf(q);
  const a = AXIS[f];
  const plane = q.corners[0]![a] / 8;
  const lo = [0, 1, 2].map((ax) => Math.min(...q.corners.map((c) => c[ax]!)) / 8);
  const hi = [0, 1, 2].map((ax) => Math.max(...q.corners.map((c) => c[ax]!)) / 8);
  lo[a] = SIGN[f] > 0 ? plane - 1 : plane;
  hi[a] = lo[a]! + 1;
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

  test("a still source's cornerDrop is 1 on its four top corners", () => {
    // One source on a stone floor in open air: its top quad has drop 1 on all four corners at y = 8·(ly + 1);
    // its side faces drop their two top corners by 1 and keep their bottom corners at 0.
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
          expect(drop).toBe(1);
        } else {
          expect(f).toBeLessThan(4);
          expect(drop).toBe(c[1] === 40 ? 1 : 0);
          expect([32, 40]).toContain(c[1]);
        }
      });
    }
    // Under water the top corners meet the voxel above: a two-high column's lower sides keep drop 0.
    const tall = paddedFrom(
      (_x, y) => (y <= 3 ? STONE : AIR), () => 0xF0,
      (x, y, z) => (x === 8 && (y === 4 || y === 5) && z === 8 ? WATER_SOURCE : NO_FLUID),
    );
    const sides = mesh(tall, depthFrom(() => 2)).passes[2].filter((q) => faceOf(q) < 4);
    expect(sides).toHaveLength(8);
    for (const q of sides) {
      const lower = Math.max(...ys(q)) === 40;
      q.corners.forEach((c, k) => expect(fieldsOf(q.words[k]!).cornerDrop).toBe(!lower && c[1] === 48 ? 1 : 0));
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

  test('a lava source beside air: 6 faces in pass 0 at layer 59, full height; lava beside lava: none', () => {
    expect(LAVA_LAYER).toBe(REGISTRY.stateCount + 1);
    expect(LAVA_LAYER).toBe(59);
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
    // The planes the two share: the lava's full-height opaque face alone covers each one.
    expect(water).not.toContain('8,8,8,1');
    expect(lava).toContain('9,8,8,3');
    expect(water).not.toContain('8,8,8,5');
    expect(lava).toContain('8,7,8,4');
    // The water's surface under the lava sits a ninth below it (cornerDrop 1), on no shared plane: both are drawn.
    expect(water).toContain('8,8,8,4');
    const top = passes[2].find((q) => faceOf(q) === 4)!;
    for (const w of top.words) expect(fieldsOf(w).cornerDrop).toBe(1);
    expect(lava).toContain('8,9,8,5');
    // Its faces against air stay.
    expect(water).toEqual(['8,8,8,0', '8,8,8,2', '8,8,8,3', '8,8,8,4']);
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

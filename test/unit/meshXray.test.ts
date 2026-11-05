/**
 * The X-ray pass (SP6a spec §5.1, D10, D23): `meshXray` against a brute force on hand-built padded sections. A voxel is
 * hollow when its tag's low 4 bits are not 0 and its block is not an opaque full cube; a wall is each face of a hollow
 * voxel whose neighbour shows an opaque full face, kind = the hollow's tag; the film is each up face of an opaque or
 * fluid voxel whose up neighbour is air (no fluid) with sky light 15, kind 15; quads merge greedily on (kind, face)
 * only. The pass is the builder's pass 3; passes 0-2 stay empty. Review Focus 2's placed stone and dug voxel are here
 * on fixtures and in `test/integration/caveSavedWorld.test.ts` on a real saved world.
 */
import { describe, expect, test } from 'vitest';
import { CAVE_FILM_KIND, CAVE_KIND } from '../../src/core/constants';
import { createMeshBuilder, type MeshBuilder } from '../../src/mesh/builder';
import { unpackXray } from '../../src/mesh/packing';
import { meshXray } from '../../src/mesh/xray';
import { AIR, FULL_FACES, GLASS, GRASS_BLOCK, PASS, STONE } from '../../src/world/blocks/index';
import { hasFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { ALL_FACES, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import { createPaddedSection, PAD_VOXELS, padIndex, type PaddedSection } from '../../src/world/store/padded';
import { testRng } from '../harness/stats';
import { paddedFrom, quadsOf, type ReadQuad, type VoxelFn } from './fixtures/padded';

/** Per face (north, east, south, west, up, down): the normal axis (0 x, 1 y, 2 z) and its sign (master face order). */
const AXIS = [2, 0, 2, 0, 1, 1] as const;
const SIGN = [-1, 1, 1, -1, 1, -1] as const;
const NORMAL: ReadonlyArray<readonly [number, number, number]> = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
const OPPOSITE = [2, 3, 0, 1, 5, 4] as const;
const UP = 4;

const { cheese, spaghetti3d, worm } = CAVE_KIND;

/** A padded section with a cave channel: `cave` gives the tag byte per voxel over the whole 18³ (default 0). */
function section(block: VoxelFn, o: { light?: VoxelFn; fluid?: VoxelFn; cave?: VoxelFn } = {}): PaddedSection {
  const p = paddedFrom(block, o.light, o.fluid);
  const cave = o.cave ?? (() => 0);
  for (let y = -1; y < 17; y++) for (let z = -1; z < 17; z++) for (let x = -1; x < 17; x++) p.cave[padIndex(x, y, z)] = cave(x, y, z);
  return p;
}

interface Meshed {
  readonly b: MeshBuilder;
  readonly quads: ReadQuad[];
}

function mesh(p: PaddedSection): Meshed {
  const b = createMeshBuilder();
  meshXray(p, b);
  return { b, quads: quadsOf(b.view(3)) };
}

const faceOf = (q: ReadQuad): number => unpackXray(q.words[0]!).face;
const kindOf = (q: ReadQuad): number => unpackXray(q.words[0]!).kind;

/** The unit faces a quad covers, as `x,y,z,face,kind` keys of the voxel that owns each face. */
function unitFaces(q: ReadQuad): string[] {
  const f = faceOf(q);
  const k = kindOf(q);
  const a = AXIS[f]!;
  const plane = q.corners[0]![a]! / 8;
  const lo = [0, 1, 2].map((ax) => Math.min(...q.corners.map((c) => c[ax]!)) / 8);
  const hi = [0, 1, 2].map((ax) => Math.max(...q.corners.map((c) => c[ax]!)) / 8);
  lo[a] = SIGN[f]! > 0 ? plane - 1 : plane;
  hi[a] = lo[a]! + 1;
  const out: string[] = [];
  for (let y = lo[1]!; y < hi[1]!; y++) {
    for (let z = lo[2]!; z < hi[2]!; z++) {
      for (let x = lo[0]!; x < hi[0]!; x++) out.push(`${x},${y},${z},${f},${k}`);
    }
  }
  return out;
}

const allUnitFaces = (quads: readonly ReadQuad[]): string[] => quads.flatMap(unitFaces).sort();

/** The brute force of spec §5.1, voxel by voxel over the section, under the registry's tables. */
function bruteFaces(p: PaddedSection): string[] {
  const opaqueFull = (s: number): boolean => PASS[s] === PASS_OPAQUE && FULL_FACES[s] === ALL_FACES;
  const out: string[] = [];
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = padIndex(x, y, z);
        const s = p.blocks[i]!;
        const kind = p.cave[i]! & 15;
        if (kind !== 0 && !opaqueFull(s)) {
          for (let f = 0; f < 6; f++) {
            const [dx, dy, dz] = NORMAL[f]!;
            const n = p.blocks[padIndex(x + dx, y + dy, z + dz)]!;
            if (PASS[n] === PASS_OPAQUE && (FULL_FACES[n]! & (1 << OPPOSITE[f]!)) !== 0) out.push(`${x},${y},${z},${f},${kind}`);
          }
        }
        if (opaqueFull(s) || hasFluid(p.fluid[i]!)) {
          const u = padIndex(x, y + 1, z);
          if (p.blocks[u] === AIR && !hasFluid(p.fluid[u]!) && p.light[u]! >> 4 === 15) out.push(`${x},${y},${z},${UP},${CAVE_FILM_KIND}`);
        }
      }
    }
  }
  return out.sort();
}

/** Every quad: four equal words with biome 0 and bits 11-31 clear, the position's fourth byte 0, the split along v0-v2 (no flip). */
function expectWellFormed(m: Meshed): void {
  const bad = m.quads.filter((q) => q.words.some((w) => w !== q.words[0]) || q.words[0]! >>> 7 !== 0
    || q.w.some((w) => w !== 0) || q.index.join() !== '0,1,2,0,2,3');
  expect(bad).toEqual([]);
  for (const pass of [0, 1, 2] as const) expect(m.b.view(pass).vertices).toBe(0);
}

/** `meshXray` equals the brute force and is well formed; returns the mesh. */
function checked(p: PaddedSection): Meshed {
  const m = mesh(p);
  expectWellFormed(m);
  expect(allUnitFaces(m.quads)).toEqual(bruteFaces(p));
  return m;
}

const inBox = (x: number, y: number, z: number, lo: number, hi: number): boolean =>
  x >= lo && x <= hi && y >= lo && y <= hi && z >= lo && z <= hi;
/** No sky anywhere (a buried section), so no film. */
const DARK: VoxelFn = () => 0;

describe('meshXray: walls (SP6a spec §5.1)', () => {
  test('one hollow voxel in stone: six walls, one per face, kind its tag, each a unit quad on the voxel\'s sides', () => {
    const p = section((x, y, z) => (x === 5 && y === 5 && z === 5 ? AIR : STONE), {
      light: DARK, cave: (x, y, z) => (x === 5 && y === 5 && z === 5 ? spaghetti3d : 0),
    });
    const m = checked(p);
    expect(m.quads).toHaveLength(6);
    expect(m.quads.map(faceOf).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const q of m.quads) expect(kindOf(q)).toBe(spaghetti3d);
    expect(allUnitFaces(m.quads)).toEqual([0, 1, 2, 3, 4, 5].map((f) => `5,5,5,${f},${spaghetti3d}`).sort());
    expect(m.b.view(3).vertices).toBe(24);
    expect(m.b.view(3).indices).toBe(36);
  });

  test('a 3 × 3 × 3 cheese void: six merged quads, one per face, each 3 × 3', () => {
    const p = section((x, y, z) => (inBox(x, y, z, 4, 6) ? AIR : STONE), {
      light: DARK, cave: (x, y, z) => (inBox(x, y, z, 4, 6) ? cheese : 0),
    });
    const m = checked(p);
    expect(m.quads).toHaveLength(6);
    expect(m.quads.map(faceOf).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const q of m.quads) {
      expect(kindOf(q)).toBe(cheese);
      expect(unitFaces(q)).toHaveLength(9);
    }
  });

  test('two kinds side by side: no merge across kinds and no face between the two hollows', () => {
    const p = section((x, y, z) => (y === 5 && z === 5 && (x === 5 || x === 6) ? AIR : STONE), {
      light: DARK, cave: (x, y, z) => (y === 5 && z === 5 ? (x === 5 ? cheese : x === 6 ? worm : 0) : 0),
    });
    const m = checked(p);
    expect(m.quads).toHaveLength(10);
    const faces = allUnitFaces(m.quads);
    expect(faces).not.toContain(`5,5,5,1,${cheese}`);
    expect(faces).not.toContain(`6,5,5,3,${worm}`);
    // The coplanar north faces of the two kinds stay two quads.
    expect(m.quads.filter((q) => faceOf(q) === 0).map(kindOf).sort()).toEqual([cheese, worm].sort());
  });

  test('a hollow voxel beside glass (a cutout block) or beside water: no wall there', () => {
    const at = (x: number, y: number, z: number): boolean => x === 5 && y === 5 && z === 5;
    const glass = section((x, y, z) => (at(x, y, z) ? AIR : at(x - 1, y, z) ? GLASS : STONE), {
      light: DARK, cave: (x, y, z) => (at(x, y, z) ? cheese : 0),
    });
    const g = checked(glass);
    expect(g.quads).toHaveLength(5);
    expect(g.quads.map(faceOf)).not.toContain(1);
    const water = section((x, y, z) => (at(x, y, z) || at(x - 1, y, z) ? AIR : STONE), {
      light: DARK, fluid: (x, y, z) => (at(x - 1, y, z) ? WATER_SOURCE : 0), cave: (x, y, z) => (at(x, y, z) ? cheese : 0),
    });
    const w = checked(water);
    expect(w.quads).toHaveLength(5);
    expect(w.quads.map(faceOf)).not.toContain(1);
  });

  test('a placed stone inside a tagged cave gets walls toward it; a dug, untagged voxel gets none (Review Focus 2)', () => {
    // The 3³ cheese void with its centre placed back as stone: the stone keeps T's cheese tag (`replaceBlocks` keeps the
    // section's cave entry), is not hollow itself, and each of its six hollow neighbours shows a wall toward it.
    const placed = section((x, y, z) => (inBox(x, y, z, 4, 6) && !(x === 5 && y === 5 && z === 5) ? AIR : STONE), {
      light: DARK, cave: (x, y, z) => (inBox(x, y, z, 4, 6) ? cheese : 0),
    });
    const m = checked(placed);
    const faces = allUnitFaces(m.quads);
    for (let f = 0; f < 6; f++) {
      const [dx, dy, dz] = NORMAL[f]!;
      expect(faces).toContain(`${5 + dx},${5 + dy},${5 + dz},${OPPOSITE[f]},${cheese}`);
    }
    expect(faces.filter((k) => k.startsWith('5,5,5,'))).toEqual([]);
    expect(faces).toHaveLength(6 * 9 + 6);
    // A dug voxel in rock: air, tag 0 (it was rock, not cave): no wall at all.
    const dug = section((x, y, z) => (x === 5 && y === 5 && z === 5 ? AIR : STONE), { light: DARK });
    expect(checked(dug).quads).toEqual([]);
  });

  test('only the tag\'s low 4 bits make a voxel hollow (bits 4-7 are reserved)', () => {
    const at = (x: number, y: number, z: number): boolean => x === 5 && y === 5 && z === 5;
    const reserved = section((x, y, z) => (at(x, y, z) ? AIR : STONE), { light: DARK, cave: (x, y, z) => (at(x, y, z) ? 0x30 : 0) });
    expect(checked(reserved).quads).toEqual([]);
    const both = section((x, y, z) => (at(x, y, z) ? AIR : STONE), { light: DARK, cave: (x, y, z) => (at(x, y, z) ? 0x30 | worm : 0) });
    const m = checked(both);
    expect(m.quads).toHaveLength(6);
    for (const q of m.quads) expect(kindOf(q)).toBe(worm);
  });

  test('the section\'s border reads the padded neighbours, and border voxels themselves emit nothing', () => {
    // A hollow row along x = 0 … 2 at (y 5, z 5): stone beyond x = −1 shows a west wall; air there shows none.
    const row = (wallAtBorder: boolean): PaddedSection => section(
      (x, y, z) => (y === 5 && z === 5 && x >= (wallAtBorder ? 0 : -1) && x <= 2 ? AIR : STONE),
      { light: DARK, cave: (x, y, z) => (y === 5 && z === 5 && x >= -1 && x <= 2 ? cheese : 0) },
    );
    const walled = allUnitFaces(checked(row(true)).quads);
    expect(walled).toContain(`0,5,5,3,${cheese}`);
    const open = allUnitFaces(checked(row(false)).quads);
    expect(open).not.toContain(`0,5,5,3,${cheese}`);
    // The tagged border voxel (−1, 5, 5) owns no face of the section's mesh.
    expect(open.filter((k) => k.startsWith('-1,'))).toEqual([]);
    // Up and down: a hollow voxel at y 15 under stone at y 16 (the padded section above) has an up wall.
    const top = section((x, y, z) => (x === 3 && z === 3 && y === 15 ? AIR : STONE), {
      light: DARK, cave: (x, y, z) => (x === 3 && z === 3 && y === 15 ? cheese : 0),
    });
    expect(allUnitFaces(checked(top).quads)).toContain(`3,15,3,${UP},${cheese}`);
  });
});

describe('meshXray: the surface film (SP6a spec §5.1, D10)', () => {
  const grassBelow = (h: number): VoxelFn => (_x, y) => (y < h ? GRASS_BLOCK : AIR);

  test('a flat grass surface under sky 15: one merged film quad, kind 15, over the whole section', () => {
    const p = section(grassBelow(5));
    const m = checked(p);
    expect(m.quads).toHaveLength(1);
    expect(faceOf(m.quads[0]!)).toBe(UP);
    expect(kindOf(m.quads[0]!)).toBe(CAVE_FILM_KIND);
    expect(unitFaces(m.quads[0]!)).toHaveLength(256);
    for (const c of m.quads[0]!.corners) expect(c[1]).toBe(40);
  });

  test('under an overhang (sky < 15) the film has a gap; the overhang\'s own top carries film', () => {
    const under = (x: number, z: number): boolean => x >= 4 && x <= 7 && z >= 4 && z <= 7;
    const p = section((x, y, z) => (y < 5 || (y === 8 && under(x, z)) ? GRASS_BLOCK : AIR), {
      light: (x, y, z) => (y >= 5 && y < 8 && under(x, z) ? 0xD0 : 0xF0),
    });
    const m = checked(p);
    const faces = allUnitFaces(m.quads);
    expect(faces.filter((k) => k.endsWith(`,4,${CAVE_FILM_KIND}`) && k.split(',')[1] === '4')).toHaveLength(256 - 16);
    for (let z = 4; z <= 7; z++) for (let x = 4; x <= 7; x++) expect(faces).not.toContain(`${x},4,${z},${UP},${CAVE_FILM_KIND}`);
    expect(faces.filter((k) => k.split(',')[1] === '8')).toHaveLength(16);
  });

  test('a water surface carries film; the water below it and the stone under the water do not', () => {
    const p = section((_x, y) => (y < 3 ? STONE : AIR), { fluid: (_x, y) => (y >= 3 && y < 6 ? WATER_SOURCE : 0) });
    const m = checked(p);
    expect(m.quads).toHaveLength(1);
    const faces = unitFaces(m.quads[0]!);
    expect(faces).toHaveLength(256);
    for (const k of faces) expect(k.split(',')[1]).toBe('5');
  });

  test('the film reads the padded voxel above the section (y 16)', () => {
    const open = section(grassBelow(16));
    expect(checked(open).quads).toHaveLength(1);
    const roofed = section((_x, y) => (y < 16 ? GRASS_BLOCK : STONE));
    expect(checked(roofed).quads).toEqual([]);
  });
});

test('meshXray equals the brute force on 24 random sections (stone, grass, glass, water, air; random tags and sky)', () => {
  const next = testRng(1717);
  const pick = (n: number): number => Math.floor(next() / 2 ** 32 * n);
  const STATES = [AIR, AIR, AIR, STONE, STONE, GRASS_BLOCK, GLASS] as const;
  for (let t = 0; t < 24; t++) {
    // Every index of the 18³ padded view, border included, filled directly.
    const p = createPaddedSection();
    for (let i = 0; i < PAD_VOXELS; i++) {
      const s = STATES[pick(STATES.length)]!;
      p.blocks[i] = s;
      p.fluid[i] = s === AIR && pick(4) === 0 ? WATER_SOURCE : 0;
      p.light[i] = (pick(2) === 0 ? 15 : pick(16)) << 4;
      p.cave[i] = pick(3) === 0 ? 0 : pick(256);
    }
    const m = checked(p);
    expect(m.quads.length).toBeGreaterThan(0);
  }
});

test('meshXray adds to what the builder holds and a reset empties pass 3', () => {
  const p = section((x, y, z) => (x === 5 && y === 5 && z === 5 ? AIR : STONE), {
    light: DARK, cave: (x, y, z) => (x === 5 && y === 5 && z === 5 ? cheese : 0),
  });
  const b = createMeshBuilder();
  meshXray(p, b);
  meshXray(p, b);
  expect(b.view(3).vertices).toBe(48);
  b.reset();
  expect(b.view(3).vertices).toBe(0);
});

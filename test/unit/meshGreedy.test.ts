/**
 * The padded greedy mesher (SP4a spec §5.2-§5.5; master §4.4): face visibility and passes, AO with 09's flip rule,
 * smooth light's integer rounding, the two-key greedy merge, the real padding below and above the world, and the
 * builder's growable buffers. SP5a (spec §1.3): box states are left to `meshBoxes`, and cutout cubes are culled
 * against water and lava and glass against ice. Sections are hand-built with `fixtures/padded.ts`; one test copies
 * them from a store.
 */
import { describe, expect, test } from 'vitest';
import { createMeshBuilder, type MeshBuilder } from '../../src/mesh/builder';
import { meshFluid } from '../../src/mesh/fluid';
import { AO_FACTORS, DEFAULT_MESH_TABLES, flipDiagonal, LOG_END_LAYER, meshSolid, type MeshOptions, type MeshTables } from '../../src/mesh/greedy';
import { unpackFluid, unpackSolid, type SolidFields } from '../../src/mesh/packing';
import { AIR, DIRT, GLASS, GRASS_BLOCK, ICE, LADDER, REGISTRY, SAND, SHAPE, STONE, TORCH, WALL_TORCH } from '../../src/world/blocks/index';
import { LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { PASS_CUTOUT, PASS_OPAQUE, SHAPE_BOX } from '../../src/world/blocks/kinds';
import { SECTIONS } from '../../src/world/store/columnTable';
import { copyPaddedSection, createPaddedSection, padIndex, type PaddedSection } from '../../src/world/store/padded';
import { createStore } from '../../src/world/store/store';
import { paddedFrom, paddedFromMap, quadsOf, type ReadQuad, type VoxelFn } from './fixtures/padded';

const ON: MeshOptions = { ao: true, smoothLight: true };
const FLAT: MeshOptions = { ao: true, smoothLight: false };
const OFF: MeshOptions = { ao: false, smoothLight: false };

/** Per face (north, east, south, west, up, down): the normal axis (0 x, 1 y, 2 z) and its sign (master face order). */
const AXIS = [2, 0, 2, 0, 1, 1] as const;
const SIGN = [-1, 1, 1, -1, 1, -1] as const;
const NORMAL: ReadonlyArray<readonly [number, number, number]> = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

interface Meshed {
  readonly b: MeshBuilder;
  readonly passes: readonly [ReadQuad[], ReadQuad[], ReadQuad[]];
}

function mesh(p: PaddedSection, o: MeshOptions = ON, t?: MeshTables): Meshed {
  const b = createMeshBuilder();
  meshSolid(p, o, b, t);
  return { b, passes: [quadsOf(b.view(0)), quadsOf(b.view(1)), quadsOf(b.view(2))] };
}

const fieldsOf = (w: number): SolidFields => unpackSolid(w);
const faceOf = (q: ReadQuad): number => fieldsOf(q.words[0]!).face;

/** The fields of the vertex of a `face` quad at position `at` (1/8 units); throws unless exactly one matches. */
function vertexAt(quads: readonly ReadQuad[], face: number, at: readonly [number, number, number]): SolidFields {
  const hits: SolidFields[] = [];
  for (const q of quads) {
    if (faceOf(q) !== face) continue;
    q.corners.forEach((c, k) => {
      if (c[0] === at[0] && c[1] === at[1] && c[2] === at[2]) hits.push(fieldsOf(q.words[k]!));
    });
  }
  if (hits.length !== 1) throw new Error(`vertexAt: ${hits.length} vertices of face ${face} at ${at.join(',')}`);
  return hits[0]!;
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

/** The brute-force visible faces of a section of opaque full cubes and air under the registry's tables. */
function bruteFaces(p: PaddedSection): string[] {
  const { pass, fullFaces } = DEFAULT_MESH_TABLES;
  const out: string[] = [];
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (pass[p.blocks[padIndex(x, y, z)]!] !== PASS_OPAQUE) continue;
        for (let f = 0; f < 6; f++) {
          const [nx, ny, nz] = NORMAL[f]!;
          const nb = p.blocks[padIndex(x + nx, y + ny, z + nz)]!;
          const opp = f < 4 ? (f + 2) % 4 : 9 - f;
          if (pass[nb] === PASS_OPAQUE && (fullFaces[nb]! & (1 << opp)) !== 0) continue;
          out.push(`${x},${y},${z},${f}`);
        }
      }
    }
  }
  return out.sort();
}

/**
 * The reference vertex of a unit face (SP4a spec §5.3), computed apart from the mesher: the face of voxel `owner`
 * whose corner lies on side `side[ax]` (−1 or +1) of each in-plane axis. Returns [ao2, sky, block].
 */
function refVertex(p: PaddedSection, o: MeshOptions, owner: readonly number[], f: number, side: readonly number[]): [number, number, number] {
  const { pass, fullFaces } = DEFAULT_MESH_TABLES;
  const a = AXIS[f];
  const [p1, p2] = [0, 1, 2].filter((ax) => ax !== a) as [number, number];
  const F = owner.map((c, ax) => c + NORMAL[f]![ax]!);
  const at = (d1: number, d2: number) => {
    const v = [...F];
    v[p1]! += d1 * side[p1]!;
    v[p2]! += d2 * side[p2]!;
    return padIndex(v[0]!, v[1]!, v[2]!);
  };
  const opaque = (i: number) => (pass[p.blocks[i]!] === PASS_OPAQUE && fullFaces[p.blocks[i]!] === 63 ? 1 : 0);
  const [f0, e1, e2, c] = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
  const [o1, o2, oc] = [opaque(e1), opaque(e2), opaque(c)];
  const ao = !o.ao ? 0 : o1 && o2 ? 3 : o1 + o2 + oc;
  const samples = !o.smoothLight ? [f0] : [f0, ...(o1 ? [] : [e1]), ...(o2 ? [] : [e2]), ...(oc || (o1 && o2) ? [] : [c])];
  const n = samples.length;
  const mean = (shift: number) => Math.floor((2 * samples.reduce((t, i) => t + ((p.light[i]! >> shift) & 15), 0) + n) / (2 * n));
  return [ao, mean(4), mean(0)];
}

/** The light byte with the same level in both nibbles. */
const both = (v: number): number => (v << 4) | v;

describe('meshSolid', () => {
  test('one stone in air: 6 quads, faces 0-5, ao2 0, light from each air neighbour', () => {
    // Every voxel a distinct light byte, so each face's vertices name the air neighbour they read.
    const light: VoxelFn = (x, y, z) => (((x + 2 * y + 3 * z) & 15) << 4) | ((5 * x + y + 7 * z) & 15);
    const at = (x: number, y: number, z: number) => (x === 8 && y === 8 && z === 8 ? STONE : AIR);
    const { passes } = mesh(paddedFrom(at, light), FLAT);
    expect(passes[1]).toHaveLength(0);
    expect(passes[2]).toHaveLength(0);
    const quads = passes[0];
    expect(quads).toHaveLength(6);
    expect(quads.map(faceOf).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const q of quads) {
      const f = faceOf(q);
      const [nx, ny, nz] = NORMAL[f]!;
      const l = light(8 + nx, 8 + ny, 8 + nz);
      for (const w of q.words) {
        const v = fieldsOf(w);
        expect(v).toEqual({ layer: STONE, face: f, ao: 0, sky: l >> 4, block: l & 15, tint: DEFAULT_MESH_TABLES.tint[STONE], flags: 0, frame: 0 });
      }
      // The unit face on its plane, counter-clockwise seen from outside: (v1 − v0) × (v2 − v0) points along the normal.
      expect(unitFaces(q)).toEqual([`8,8,8,${f}`]);
      const [p0, p1, p2] = [q.corners[0]!, q.corners[1]!, q.corners[2]!];
      const e1 = [0, 1, 2].map((i) => p1[i]! - p0[i]!);
      const e2 = [0, 1, 2].map((i) => p2[i]! - p0[i]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      expect(n.map(Math.sign)).toEqual([nx, ny, nz].map(Math.sign));
      expect(q.w).toEqual([0, 0, 0, 0]);
    }
    // With smooth light on, a uniform sky reads 15 on every vertex.
    const smooth = mesh(paddedFrom(at), ON).passes[0];
    for (const q of smooth) for (const w of q.words) expect([fieldsOf(w).sky, fieldsOf(w).block]).toEqual([15, 0]);
  });

  test('a stone against an opaque neighbour has no face there', () => {
    const two = paddedFromMap('@ 8 8 8\nSS', { S: STONE });
    const faces = allUnitFaces(mesh(two).passes[0]);
    expect(faces).toHaveLength(10);
    expect(faces).not.toContain('8,8,8,1');
    expect(faces).not.toContain('9,8,8,3');
    expect(faces).toEqual(bruteFaces(two));
    // A PASS-opaque neighbour without the facing bit (a partial shape) does not occlude; the full stone hides its face.
    const fullFaces = new Uint8Array(DEFAULT_MESH_TABLES.fullFaces);
    fullFaces[DIRT] = 63 & ~(1 << 3);
    const partial = mesh(paddedFromMap('@ 8 8 8\nSD', { S: STONE, D: DIRT }), ON, { ...DEFAULT_MESH_TABLES, fullFaces });
    const pf = allUnitFaces(partial.passes[0]);
    expect(pf).toContain('8,8,8,1');
    expect(pf).not.toContain('9,8,8,3');
  });

  test('a 16 × 16 flat floor with uniform light merges into 1 top quad', () => {
    const floor = paddedFrom((x, y, z) => (y === 0 && x >= 0 && x < 16 && z >= 0 && z < 16 ? STONE : AIR));
    const quads = mesh(floor).passes[0];
    const tops = quads.filter((q) => faceOf(q) === 4);
    expect(tops).toHaveLength(1);
    const xs = tops[0]!.corners.map((c) => c[0]);
    const zs = tops[0]!.corners.map((c) => c[2]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([0, 128, 0, 128]);
    expect(tops[0]!.corners.every((c) => c[1] === 8)).toBe(true);
    // The rest merges too: one bottom quad and one quad per side.
    expect(quads).toHaveLength(6);
    expect(allUnitFaces(quads)).toEqual(bruteFaces(floor));
  });

  test('a floor with one darker voxel does not merge across it (keys differ)', () => {
    const at = (x: number, y: number, z: number) => (y === 0 && x >= 0 && x < 16 && z >= 0 && z < 16 ? STONE : AIR);
    const light: VoxelFn = (x, y, z) => (x === 5 && y === 1 && z === 5 ? 0x80 : 0xF0);
    const tops = (o: MeshOptions) => mesh(paddedFrom(at, light), o).passes[0].filter((q) => faceOf(q) === 4);
    for (const o of [ON, FLAT]) {
      const t = tops(o);
      expect(t.length).toBeGreaterThan(1);
      expect(allUnitFaces(t)).toHaveLength(256);
    }
    // Without smooth light only the face under the dark voxel differs: it is its own 1 × 1 quad with sky 8.
    const dark = tops(FLAT).filter((q) => fieldsOf(q.words[0]!).sky === 8);
    expect(dark).toHaveLength(1);
    expect(unitFaces(dark[0]!)).toEqual(['5,0,5,4']);
    // With smooth light the four vertices around it are darker, so the faces sharing them do not merge with the rest.
    const smooth = tops(ON);
    for (const q of smooth) {
      const skies = new Set(q.words.map((w) => fieldsOf(w).sky));
      if (skies.size > 1) expect(allUnitFaces([q]).length).toBe(1);
    }
  });

  test('AO table: a canned 3 × 3 × 3 per case: (s1 s2 c) = (0 0 0) → 0, (1 0 0) → 1, (1 0 1) → 2, (1 1 0) → 3, (1 1 1) → 3', () => {
    // The stone's top face; its vertex at (x 8, z 8) reads s1 = (8, 9, 7), s2 = (7, 9, 8) and c = (7, 9, 7).
    const cases: Array<[[number, number, number], number]> = [
      [[0, 0, 0], 0], [[1, 0, 0], 1], [[0, 1, 0], 1], [[0, 0, 1], 1], [[1, 0, 1], 2], [[0, 1, 1], 2], [[1, 1, 0], 3], [[1, 1, 1], 3],
    ];
    for (const [[s1, s2, c], ao] of cases) {
      const top = `${c ? 'S' : '.'}${s1 ? 'S' : '.'}.\n${s2 ? 'S' : '.'}..\n...`;
      const p = paddedFromMap(`@ 7 8 7\n...\n.S.\n...\n@ 7 9 7\n${top}`, { S: STONE });
      expect([s1, s2, c, vertexAt(mesh(p).passes[0], 4, [64, 72, 64]).ao]).toEqual([s1, s2, c, ao]);
    }
    expect(AO_FACTORS).toEqual([1, 0.8, 0.6, 0.45]);
  });

  test('diagonal flip: corner ao2 (0, 3, 0, 3) splits along v0-v2 and (3, 0, 3, 0) along v1-v3', () => {
    expect(flipDiagonal(0, 3, 0, 3)).toBe(false);
    expect(flipDiagonal(3, 0, 3, 0)).toBe(true);
    expect(flipDiagonal(0, 0, 0, 0)).toBe(false);
    // 09's rule: AO_FACTORS[v1] + AO_FACTORS[v3] > AO_FACTORS[v0] + AO_FACTORS[v2]; a tie (0.8 + 0.8 = 1 + 0.6) → v0-v2.
    expect(flipDiagonal(0, 1, 2, 1)).toBe(false);
    expect(flipDiagonal(1, 0, 1, 2)).toBe(false);
    expect(flipDiagonal(1, 2, 1, 2)).toBe(false);
    expect(flipDiagonal(2, 1, 2, 1)).toBe(true);
    expect(flipDiagonal(3, 1, 0, 1)).toBe(true);
    // The builder writes (0,1,2)(0,2,3), or (1,2,3)(1,3,0) when flipped.
    const b = createMeshBuilder();
    const corners = [0, 0, 0, 8, 0, 0, 8, 8, 0, 0, 8, 0];
    b.quad(0, corners, [1, 2, 3, 4], false);
    b.quad(0, corners, [1, 2, 3, 4], true);
    expect(Array.from(b.view(0).index)).toEqual([0, 1, 2, 0, 2, 3, 5, 6, 7, 5, 7, 4]);
    // In a mesh: s1 and s2 of the (x 8, z 8) corner opaque give ao2 3 there, 1 at its two neighbours and 0 opposite,
    // so the quad splits along the diagonal joining the two ao2-1 corners.
    const p = paddedFromMap('@ 7 8 7\n...\n.S.\n...\n@ 7 9 7\n.S.\nS..\n...', { S: STONE });
    const q = mesh(p).passes[0].find((x) => faceOf(x) === 4 && x.corners[0]![1] === 72)!;
    const aos = q.words.map((w) => fieldsOf(w).ao);
    expect([...aos].sort()).toEqual([0, 1, 1, 3]);
    const shared = q.index.slice(0, 3).filter((i) => q.index.slice(3).includes(i)).sort();
    expect(shared.map((i) => aos[i])).toEqual([1, 1]);
  });

  test('smooth light: samples F 15, edges 12 and 9, corner 6 give ⌊(2·42 + 4)/8⌋ = 11; with both edges opaque the corner is skipped (n = 1: 15)', () => {
    const levels = new Map<string, number>([['8,9,8', 15], ['8,9,7', 12], ['7,9,8', 9], ['7,9,7', 6]]);
    const light: VoxelFn = (x, y, z) => both(levels.get(`${x},${y},${z}`) ?? 0);
    const lit = (top: string) => vertexAt(
      mesh(paddedFromMap(`@ 7 8 7\n...\n.S.\n...\n@ 7 9 7\n${top}`, { S: STONE }, { light })).passes[0], 4, [64, 72, 64],
    );
    const four = lit('...\n...\n...');
    expect([four.sky, four.block]).toEqual([11, 11]);
    // One edge opaque: F 15, edge 9, corner 6 → ⌊(2·30 + 3)/6⌋ = 10.
    const three = lit('.S.\n...\n...');
    expect([three.sky, three.block]).toEqual([10, 10]);
    const one = lit('.S.\nS..\n...');
    expect([one.sky, one.block]).toEqual([15, 15]);
  });

  test('a column-border seam: the face toward the neighbour column is culled against its opaque voxel and drawn against its air', () => {
    // Stones at x 15; the east neighbour column (padded x 16) holds stone at z 3 and air at z 10.
    const at = (x: number, y: number, z: number) => (y === 3 && (x === 15 || (x === 16 && z === 3)) && (z === 3 || z === 10) ? STONE : AIR);
    const light: VoxelFn = (x) => (x === 16 ? 0x70 : 0xF0);
    const quads = mesh(paddedFrom(at, light), FLAT).passes[0];
    const faces = allUnitFaces(quads);
    expect(faces).not.toContain('15,3,3,1');
    expect(faces).toContain('15,3,10,1');
    const east = quads.filter((q) => faceOf(q) === 1);
    expect(east).toHaveLength(1);
    expect(east[0]!.corners.every((c) => c[0] === 128)).toBe(true);
    expect(fieldsOf(east[0]!.words[0]!).sky).toBe(7);
  });

  test('below the world (y −1 padding) is opaque: no bottom faces at sy 0; above the world is sky 15', () => {
    // A 3 × 3 of Published columns: sy 0 holds stone at local y 0 only, sy 23 stone at local y 15 only, all light 0.
    const store = createStore({ shared: false, maxBlockBytes: 32 << 20, maxByteBytes: 32 << 20 });
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const w = store.claimColumn(dx, dz, 0);
        for (let sy = 0; sy < SECTIONS; sy++) {
          const blocks = new Uint16Array(4096);
          if (sy === 0) blocks.fill(STONE, 0, 256);
          if (sy === SECTIONS - 1) blocks.fill(STONE, 15 * 256, 4096);
          w.setFinal(sy, blocks, new Uint8Array(4096), new Uint8Array(4096));
        }
        w.commit(3);
      }
    }
    const nb = store.neighborhood(0, 0);
    const p = createPaddedSection();
    copyPaddedSection(nb, 0, p);
    const bottom = mesh(p).passes[0];
    expect(bottom.length).toBeGreaterThan(0);
    expect(bottom.filter((q) => faceOf(q) === 5)).toHaveLength(0);
    expect(bottom.filter((q) => faceOf(q) === 4)).toHaveLength(1);
    copyPaddedSection(nb, SECTIONS - 1, p);
    const top = mesh(p).passes[0];
    const tops = top.filter((q) => faceOf(q) === 4);
    expect(tops).toHaveLength(1);
    expect(tops[0]!.corners.every((c) => c[1] === 128)).toBe(true);
    for (const w of tops[0]!.words) expect([fieldsOf(w).sky, fieldsOf(w).block]).toEqual([15, 0]);
    // Its bottom faces read the light-0 air below.
    for (const q of top.filter((x) => faceOf(x) === 5)) for (const w of q.words) expect(fieldsOf(w).sky).toBe(0);
  });

  test("noAo: ao2 0 on every vertex and F's light", () => {
    // A floor with pillars and a varied light field: AO and smooth light would differ across it.
    const at = (x: number, y: number, z: number) =>
      (y === 0 && x >= 0 && x < 16 && z >= 0 && z < 16) || (y >= 1 && y <= 2 && (x * 7 + z * 3) % 11 === 0) ? STONE : AIR;
    const light: VoxelFn = (x, y, z) => ((x * 5 + y * 3 + z) & 15) << 4 | ((x + z * 3) & 15);
    const p = paddedFrom(at, light);
    expect(mesh(p, ON).passes[0].some((q) => q.words.some((w) => fieldsOf(w).ao > 0))).toBe(true);
    const quads = mesh(p, OFF).passes[0];
    expect(allUnitFaces(quads)).toEqual(bruteFaces(p));
    for (const q of quads) {
      const v = q.words.map(fieldsOf);
      for (const x of v) expect(x.ao).toBe(0);
      for (const key of unitFaces(q)) {
        const [x, y, z, f] = key.split(',').map(Number) as [number, number, number, number];
        const [nx, ny, nz] = NORMAL[f]!;
        const l = light(x + nx, y + ny, z + nz);
        for (const u of v) expect([u.sky, u.block]).toEqual([l >> 4, l & 15]);
      }
    }
  });

  test('injected cutout table: leaves against leaves are drawn, cutout pass 1', () => {
    // DIRT becomes cutout leaves, SAND a cutout non-leaves block (glass-like); both full cubes.
    const pass = new Uint8Array(DEFAULT_MESH_TABLES.pass);
    pass[DIRT] = PASS_CUTOUT;
    pass[SAND] = PASS_CUTOUT;
    const leaves = new Uint8Array(pass.length);
    leaves[DIRT] = 1;
    const t: MeshTables = { ...DEFAULT_MESH_TABLES, pass, leaves };
    const two = (map: string) => mesh(paddedFromMap(`@ 8 8 8\n${map}`, { L: DIRT, G: SAND, S: STONE }), ON, t);
    const ll = two('LL');
    expect(ll.passes[0]).toHaveLength(0);
    expect(ll.passes[2]).toHaveLength(0);
    const llFaces = allUnitFaces(ll.passes[1]);
    expect(llFaces).toHaveLength(12);
    expect(llFaces).toContain('8,8,8,1');
    expect(llFaces).toContain('9,8,8,3');
    for (const q of ll.passes[1]) for (const w of q.words) expect(fieldsOf(w).layer).toBe(DIRT);
    // The same non-leaves cutout block hides the faces between; different cutout blocks show them.
    expect(allUnitFaces(two('GG').passes[1])).toHaveLength(10);
    expect(allUnitFaces(two('GL').passes[1])).toHaveLength(12);
    // An opaque stone's face against leaves is drawn (pass 0); the leaves' face against the stone is not.
    const sl = two('SL');
    expect(allUnitFaces(sl.passes[0])).toContain('8,8,8,1');
    expect(allUnitFaces(sl.passes[1])).not.toContain('9,8,8,3');
    expect(allUnitFaces(sl.passes[1])).toHaveLength(5);
  });

  test('a torch state emits nothing from meshSolid (every SHAPE box state is meshBoxes\')', () => {
    const boxes = [TORCH, ...[0, 1, 2, 3].flatMap((q) => [REGISTRY.rotateState(WALL_TORCH, q), REGISTRY.rotateState(LADDER, q)])];
    expect(new Set(boxes).size).toBe(9);
    for (const s of boxes) {
      expect(SHAPE[s], REGISTRY.stateKey(s)).toBe(SHAPE_BOX);
      const m = mesh(paddedFromMap('@ 8 8 8\nB', { B: s }));
      expect(m.passes.map((q) => q.length), REGISTRY.stateKey(s)).toEqual([0, 0, 0]);
    }
  });

  /** Glass or ice at (8, 8, 8) and, east of it at (9, 8, 8), the state `east` holding the fluid byte `fluid`. */
  const pair = (s: number, east: number, fluid = 0): PaddedSection =>
    paddedFrom((x, y, z) => (y === 8 && z === 8 && x === 8 ? s : y === 8 && z === 8 && x === 9 ? east : AIR), () => 0xF0,
      (x, y, z) => (y === 8 && z === 8 && x === 9 ? fluid : 0));

  test('glass beside water: no glass face on that side; the water mesher\'s face there stays (meshFluid)', () => {
    const p = pair(GLASS, AIR, WATER_SOURCE);
    const faces = allUnitFaces(mesh(p).passes[1]);
    expect(faces).toHaveLength(5);
    expect(faces).not.toContain('8,8,8,1');
    // The water voxel's west face toward the glass is drawn by the water mesher, in the translucent pass.
    const b = createMeshBuilder();
    const depth = new Uint8Array(4096);
    depth[(8 << 8) | (8 << 4) | 9] = 1;
    meshFluid(p, depth, b);
    const water = quadsOf(b.view(2));
    expect(water.map((q) => unpackFluid(q.words[0]!).face).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const west = water.find((q) => unpackFluid(q.words[0]!).face === 3)!;
    expect(west.corners.every((c) => c[0] === 72)).toBe(true);
  });

  test('glass beside bucket lava: no glass face on that side', () => {
    const faces = allUnitFaces(mesh(pair(GLASS, AIR, LAVA_SOURCE)).passes[1]);
    expect(faces).toHaveLength(5);
    expect(faces).not.toContain('8,8,8,1');
  });

  test('ice beside lava: the same (and beside water)', () => {
    for (const fluid of [LAVA_SOURCE, WATER_SOURCE]) {
      const quads = mesh(pair(ICE, AIR, fluid)).passes[1];
      const faces = allUnitFaces(quads);
      expect(faces).toHaveLength(5);
      expect(faces).not.toContain('8,8,8,1');
      for (const q of quads) expect(fieldsOf(q.words[0]!).layer).toBe(ICE);
    }
  });

  test('glass beside ice: the ice face drawn, the glass face not', () => {
    const faces = allUnitFaces(mesh(pair(GLASS, ICE)).passes[1]);
    expect(faces).not.toContain('8,8,8,1');
    expect(faces).toContain('9,8,8,3');
    expect(faces).toHaveLength(11);
    // The same pair the other way round: ice west of glass keeps its east face, the glass loses its west one.
    const flipped = allUnitFaces(mesh(pair(ICE, GLASS)).passes[1]);
    expect(flipped).toContain('8,8,8,1');
    expect(flipped).not.toContain('9,8,8,3');
    expect(flipped).toHaveLength(11);
  });

  test('glass beside glass: none', () => {
    const faces = allUnitFaces(mesh(pair(GLASS, GLASS)).passes[1]);
    expect(faces).not.toContain('8,8,8,1');
    expect(faces).not.toContain('9,8,8,3');
    expect(faces).toHaveLength(10);
    // Glass beside a ladder (a box state) keeps its face: the ladder's own boundary face is the one culled (meshBoxes).
    expect(allUnitFaces(mesh(pair(GLASS, LADDER)).passes[1])).toContain('8,8,8,1');
  });

  test('an axis-x log\'s ±x faces carry layer 58, its other faces its state; two logs of different axes never merge', () => {
    expect(LOG_END_LAYER).toBe(REGISTRY.stateCount);
    expect(LOG_END_LAYER).toBe(58);
    // Each axis: the two faces along it (east/west for x, up/down for y, north/south for z) take the log-end layer.
    const ends: Record<string, readonly number[]> = { x: [1, 3], y: [4, 5], z: [0, 2] };
    for (const axis of ['x', 'y', 'z'] as const) {
      const log = REGISTRY.parseStateKey(`oak_log[axis=${axis}]`);
      const quads = mesh(paddedFromMap('@ 8 8 8\nL', { L: log })).passes[0];
      expect(quads, axis).toHaveLength(6);
      for (const q of quads) {
        const f = faceOf(q);
        const want = ends[axis]!.includes(f) ? LOG_END_LAYER : log;
        for (const w of q.words) expect(fieldsOf(w).layer, `axis ${axis} face ${f}`).toBe(want);
      }
    }
    // Two axis-x logs side by side merge their tops into one quad; an axis-x and an axis-z log do not (key A keeps the
    // state), though both tops carry their own state's layer.
    const lx = REGISTRY.parseStateKey('oak_log[axis=x]');
    const lz = REGISTRY.parseStateKey('oak_log[axis=z]');
    const tops = (map: string): ReadQuad[] => mesh(paddedFromMap(`@ 8 8 8\n${map}`, { X: lx, Z: lz })).passes[0].filter((q) => faceOf(q) === 4);
    expect(tops('XX')).toHaveLength(1);
    const mixed = tops('XZ');
    expect(mixed).toHaveLength(2);
    expect(mixed.map((q) => fieldsOf(q.words[0]!).layer).sort((a, b) => a - b)).toEqual([lx, lz].sort((a, b) => a - b));
    // Their north faces: the x log's bark, the z log's end; two quads.
    const north = mesh(paddedFromMap('@ 8 8 8\nXZ', { X: lx, Z: lz })).passes[0].filter((q) => faceOf(q) === 0);
    expect(north).toHaveLength(2);
    expect(north.map((q) => fieldsOf(q.words[0]!).layer).sort((a, b) => a - b)).toEqual([lx, LOG_END_LAYER]);
  });

  test('the mesh pass follows the state, not the emitted layer: a cutout log (injected) puts its end faces in pass 1', () => {
    const lx = REGISTRY.parseStateKey('oak_log[axis=x]');
    const pass = new Uint8Array(DEFAULT_MESH_TABLES.pass);
    pass[lx] = PASS_CUTOUT;
    const m = mesh(paddedFromMap('@ 8 8 8\nL', { L: lx }), ON, { ...DEFAULT_MESH_TABLES, pass });
    expect(m.passes[0]).toHaveLength(0);
    expect(m.passes[1]).toHaveLength(6);
    expect(m.passes[1].filter((q) => fieldsOf(q.words[0]!).layer === LOG_END_LAYER).map(faceOf).sort()).toEqual([1, 3]);
  });

  test('glass\'s words carry bit 30 (frame), stone\'s do not', () => {
    const glass = mesh(paddedFromMap('@ 8 8 8\nG', { G: GLASS })).passes[1];
    expect(glass).toHaveLength(6);
    for (const q of glass) {
      for (const w of q.words) {
        expect(fieldsOf(w).frame).toBe(1);
        expect((w >>> 30) & 1).toBe(1);
        expect(fieldsOf(w).layer).toBe(GLASS);
      }
    }
    for (const s of [STONE, ICE]) {
      const m = mesh(paddedFromMap('@ 8 8 8\nB', { B: s }));
      const quads = [...m.passes[0], ...m.passes[1]];
      expect(quads, REGISTRY.stateKey(s)).toHaveLength(6);
      for (const q of quads) for (const w of q.words) expect((w >>> 30) & 1, REGISTRY.stateKey(s)).toBe(0);
    }
  });

  test('every emitted word unpacks to in-range fields', () => {
    // A seeded random section of stone, dirt, grass and air with random light, its border included.
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const states = [AIR, AIR, STONE, DIRT, GRASS_BLOCK];
    const blocks = new Map<number, number>();
    const lights = new Map<number, number>();
    for (let y = -1; y < 17; y++) {
      for (let z = -1; z < 17; z++) {
        for (let x = -1; x < 17; x++) {
          blocks.set(padIndex(x, y, z), states[Math.floor(rnd() * states.length)]!);
          lights.set(padIndex(x, y, z), Math.floor(rnd() * 256));
        }
      }
    }
    const p = paddedFrom((x, y, z) => blocks.get(padIndex(x, y, z))!, (x, y, z) => lights.get(padIndex(x, y, z))!);
    for (const o of [ON, FLAT, OFF, { ao: false, smoothLight: true }]) {
      const m = mesh(p, o);
      expect(m.passes[1]).toHaveLength(0);
      expect(m.passes[2]).toHaveLength(0);
      const quads = m.passes[0];
      expect(allUnitFaces(quads)).toEqual(bruteFaces(p));
      const v = m.b.view(0);
      expect(v.position.length).toBe(4 * v.vertices);
      expect(v.data.length).toBe(v.vertices);
      expect(v.index.length).toBe(v.indices);
      expect(v.indices).toBe((6 * v.vertices) / 4);
      expect(v.index.every((i) => i < v.vertices)).toBe(true);
      // Collect every out-of-range value, so one assertion reports them all.
      const bad: string[] = [];
      for (const q of quads) {
        for (const c of q.corners) if (!c.every((x) => x % 8 === 0 && x >= 0 && x <= 128)) bad.push(`corner ${c.join(',')}`);
        if (q.w.some((x) => x !== 0)) bad.push(`w ${q.w.join(',')}`);
        for (const w of q.words) {
          const f = fieldsOf(w);
          const ok = [STONE, DIRT, GRASS_BLOCK].includes(f.layer) && f.face < 6 && f.ao < 4 && f.sky < 16 && f.block < 16
            && f.tint === DEFAULT_MESH_TABLES.tint[f.layer] && f.flags === 0 && f.frame === 0 && (o.ao || f.ao === 0);
          if (!ok) bad.push(JSON.stringify(f));
        }
      }
      // Every unit face of every quad has, at each corner, the reference AO and light of the quad's vertex there.
      for (const q of quads) {
        const f = faceOf(q);
        const lo = [0, 1, 2].map((ax) => Math.min(...q.corners.map((c) => c[ax]!)));
        const want = q.words.map((w) => [fieldsOf(w).ao, fieldsOf(w).sky, fieldsOf(w).block].join(','));
        for (const key of unitFaces(q)) {
          const owner = key.split(',').slice(0, 3).map(Number);
          q.corners.forEach((c, k) => {
            const side = c.map((x, ax) => (x === lo[ax] ? -1 : 1));
            const got = refVertex(p, o, owner, f, side).join(',');
            if (got !== want[k]) bad.push(`${key} vertex ${k}: reference ${got}, mesh ${want[k]}`);
          });
        }
      }
      expect(bad).toEqual([]);
    }
  });
});

describe('createMeshBuilder', () => {
  test('grows past its initial capacity and keeps every quad; reset empties every pass', () => {
    const b = createMeshBuilder();
    const n = 5000;
    for (let q = 0; q < n; q++) {
      const x = 8 * (q % 16);
      const y = 8 * ((q >> 4) % 16);
      b.quad(q % 3 === 0 ? 2 : 0, [x, y, 0, x + 8, y, 0, x + 8, y + 8, 0, x, y + 8, 0], [q, q + 1, q + 2, q + 3], q % 2 === 1);
    }
    const v0 = b.view(0);
    const v2 = b.view(2);
    expect(v0.vertices + v2.vertices).toBe(4 * n);
    expect(b.view(1).vertices).toBe(0);
    const quads = quadsOf(v0);
    let k = 0;
    for (let q = 0; q < n; q++) {
      if (q % 3 === 0) continue;
      const r = quads[k++]!;
      expect(r.words).toEqual([q, q + 1, q + 2, q + 3]);
      expect(r.corners[0]).toEqual([8 * (q % 16), 8 * ((q >> 4) % 16), 0]);
      expect(r.index).toEqual(q % 2 === 1 ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3]);
    }
    b.reset();
    for (const pass of [0, 1, 2] as const) expect([b.view(pass).vertices, b.view(pass).indices]).toEqual([0, 0]);
    b.quad(1, [0, 0, 0, 8, 0, 0, 8, 8, 0, 0, 8, 0], [7, 7, 7, 7], false);
    expect(Array.from(b.view(1).index)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});

import { Quaternion, Sphere, Vector3, type BufferAttribute, type Mesh, type Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { RESERVATION } from '../../src/render/regionGrid';
import { createFreeList, firstFit, giveRange, takeFirstFit } from '../../src/render/regionMesh';
import {
  createSectionRenderer, createSectionRendererCounts, regionOf, selectSectionRenderer, type SectionRenderer,
  type SectionRendererCounts,
} from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload, type FakeRow } from './fixtures/payloads';
import {
  fakeGate, indexSum, opaque, pumpAll, regionObjects, sectionRendererContract, UNBOUNDED, visibleIndices,
} from './sectionRendererContract';

sectionRendererContract('mesh');

const ALBEDO = createFlatColorArray();
const system = (variant: MaterialVariant): MaterialSystem => createMaterialSystem({ variant, ao: true, smoothLight: true }, ALBEDO);

/**
 * Region (−1, 2): the four corner columns (local (0, 0), (7, 7), (0, 7), (7, 0)), with sections at sy 0 and 23 and
 * every pass. Each row's first vertex is moved to the section's (0, 0, 0) corner and its last to (128, 128, 128), so the
 * merged positions reach the region's corners (1024, 3072, 1024 at most).
 */
const CORNER_COLUMNS: ReadonlyArray<{ readonly cx: number; readonly cz: number; readonly rows: readonly FakeRow[] }> = [
  { cx: -8, cz: 16, rows: [{ sy: 0, pass: 0, quads: 2 }, { sy: 5, pass: 2, quads: 1 }] },
  { cx: -1, cz: 23, rows: [{ sy: 23, pass: 0, quads: 1 }, { sy: 23, pass: 1, quads: 2 }] },
  { cx: -8, cz: 23, rows: [{ sy: 10, pass: 0, quads: 3 }] },
  { cx: -1, cz: 16, rows: [{ sy: 7, pass: 2, quads: 2 }, { sy: 7, pass: 0, quads: 1 }, { sy: 0, pass: 1, quads: 1 }] },
];

function cornerPayloads(): ColumnMeshPayload[] {
  return CORNER_COLUMNS.map(({ cx, cz, rows }) => {
    const p = fakePayload(cx, cz, rows.map((r) => ({ ...r })));
    for (let o = 0; o < p.rows.length; o += ROW_INTS) {
      const first = p.rows[o + 2]!;
      const last = first + p.rows[o + 3]! - 1;
      p.position.set([0, 0, 0, 0], 4 * first);
      p.position.set([128, 128, 128, 0], 4 * last);
    }
    return p;
  });
}

/** Stages `ps` (seq 1, in this order), uploads them all under an unbounded gate and reveals the root. */
function built(ps: readonly ColumnMeshPayload[], materials = system('mesh')): SectionRenderer {
  const r = createSectionRenderer('mesh', materials);
  for (const p of ps) r.stage(p, 1);
  pumpAll(r);
  r.revealAll();
  return r;
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

const passOf = (m: Mesh): number => m.userData['pass'] as number;
const counts = (r: SectionRenderer): SectionRendererCounts => r.counts(createSectionRendererCounts());

/** The arena of `pass` in region (rx, rz). */
const arenaOf = (r: SectionRenderer, pass: number, rx = 0, rz = 0): Mesh | undefined =>
  regionObjects(r.root).find((m) => passOf(m) === pass && m.userData['rx'] === rx && m.userData['rz'] === rz);

/** The arena's position, data and index attributes. */
const attributesOf = (m: Mesh): [BufferAttribute, BufferAttribute, BufferAttribute] => [
  m.geometry.getAttribute('position') as BufferAttribute,
  m.geometry.getAttribute('data') as BufferAttribute,
  m.geometry.getIndex()!,
];

/** What three's upload of the arena does after `bufferData` / `bufferSubData`: each attribute's `onUploadCallback`. */
function uploaded(m: Mesh): void {
  for (const a of attributesOf(m)) a.onUploadCallback();
}

/** The non-degenerate triangles of the arena's draw range, each as its three (x, y, z, w, data) corners. */
function drawnTriangles(m: Mesh): string[] {
  const [position, data, index] = attributesOf(m);
  const pos = position.array as Uint16Array;
  const end = Math.min(index.array.length, m.geometry.drawRange.start + m.geometry.drawRange.count);
  const out: string[] = [];
  const corner = (v: number): string => [pos[4 * v], pos[4 * v + 1], pos[4 * v + 2], pos[4 * v + 3], data.array[v]].join(',');
  for (let k = m.geometry.drawRange.start; k + 2 < end; k += 3) {
    const [a, b, c] = [index.array[k]!, index.array[k + 1]!, index.array[k + 2]!];
    if (a === b && b === c) continue;
    out.push([a, b, c].map(corner).join(' '));
  }
  return out;
}

/** The arena positions a payload's rows get at vertex `v0` onwards (region-local, w 0), in row order. */
function placed(p: ColumnMeshPayload): number[] {
  const out: number[] = [];
  for (let o = 0; o < p.rows.length; o += ROW_INTS) {
    const [sy, vs, vc] = [p.rows[o]!, p.rows[o + 2]!, p.rows[o + 3]!];
    for (let k = 0; k < vc; k++) {
      const s = 4 * (vs + k);
      out.push(p.position[s]! + 128 * (p.cx & 7), p.position[s + 1]! + 128 * sy, p.position[s + 2]! + 128 * (p.cz & 7), 0);
    }
  }
  return out;
}

/** The payload's indices rebased to the arena: each row's by its first vertex, the column's rows from vertex `v0`. */
function rebased(p: ColumnMeshPayload, v0: number): number[] {
  const out: number[] = [];
  let v = v0;
  for (let o = 0; o < p.rows.length; o += ROW_INTS) {
    const [vc, is, ic] = [p.rows[o + 3]!, p.rows[o + 4]!, p.rows[o + 5]!];
    for (let k = 0; k < ic; k++) out.push(p.index[is + k]! + v);
    v += vc;
  }
  return out;
}

/** `n` opaque rows of `quads` quads (1,024 quads: 4,096 vertices and 6,144 indices; 32 fill the opaque reservation). */
const big = (n: number, quads = 1024): FakeRow[] => Array.from({ length: n }, (_, k) => ({ sy: k % 24, pass: 0, quads }));
const ROW_V = 4096;
const ROW_I = 6144;
const regionKey = (m: Mesh): string => `${m.userData['rx'] as number},${m.userData['rz'] as number}`;

/** The rows of `ps` in `pass`, in payload order then row order, with each row's local column. */
function rowsOf(ps: readonly ColumnMeshPayload[], pass: number): Array<{ p: ColumnMeshPayload; o: number; r: number }> {
  const out: Array<{ p: ColumnMeshPayload; o: number; r: number }> = [];
  for (const p of ps) {
    for (let o = 0, r = 0; o < p.rows.length; o += ROW_INTS, r++) if (p.rows[o + 1] === pass) out.push({ p, o, r });
  }
  return out;
}

/** The section sphere of row `r` in the region's 1/8-block units: the payload's × 8, shifted to the section. */
function sectionSphere(p: ColumnMeshPayload, o: number, r: number): Sphere {
  const lx = p.cx & 7;
  const lz = p.cz & 7;
  const sy = p.rows[o]!;
  const s = 4 * r;
  return new Sphere(
    new Vector3(8 * p.spheres[s]! + 128 * lx, 8 * p.spheres[s + 1]! + 128 * sy, 8 * p.spheres[s + 2]! + 128 * lz),
    8 * p.spheres[s + 3]!,
  );
}

describe('RegionMesh (SP4a spec §6.2, D2; SP4b spec §4.3)', () => {
  test('the arena holds the revealed rows: Uint16 region-local positions at the corners of every section of a region, data unchanged, indices rebased; each pass\'s arrays are its reservation', () => {
    const ps = cornerPayloads();
    const r = built(ps);
    const ms = meshes(r.root);
    expect(ms.map(passOf).sort()).toEqual([0, 1, 2]);
    for (const m of ms) {
      const position = m.geometry.getAttribute('position');
      const data = m.geometry.getAttribute('data');
      const index = m.geometry.getIndex()!;
      expect(position.array).toBeInstanceOf(Uint16Array);
      expect(position.itemSize).toBe(4);
      expect(position.normalized).toBe(false);
      expect(data.array).toBeInstanceOf(Uint32Array);
      expect(data.itemSize).toBe(1);
      expect(index.array).toBeInstanceOf(Uint32Array);
      const [vertices, indices] = RESERVATION[passOf(m)]!;
      expect(position.count).toBe(vertices);
      expect(data.count).toBe(vertices);
      expect(index.array.length).toBe(indices);
      // The drawn triangles, as (x, y, z, w, data) per corner, against the payload rows placed in the region.
      const want: string[] = [];
      for (const { p, o } of rowsOf(ps, passOf(m))) {
        const lx = p.cx & 7;
        const lz = p.cz & 7;
        const sy = p.rows[o]!;
        const [vs, is, ic] = [p.rows[o + 2]!, p.rows[o + 4]!, p.rows[o + 5]!];
        const corner = (k: number): string => {
          const s = 4 * (vs + k);
          return [p.position[s]! + 128 * lx, p.position[s + 1]! + 128 * sy, p.position[s + 2]! + 128 * lz, 0, p.data[vs + k]!].join(',');
        };
        for (let k = 0; k < ic; k += 3) want.push([0, 1, 2].map((j) => corner(p.index[is + k + j]!)).join(' '));
      }
      expect(drawnTriangles(m).sort()).toEqual(want.sort());
    }
    // The corners of the region: the (0, 0, 0) of local column (0, 0) at sy 0, and the far corner of (7, 7) at sy 23.
    const opaque = ms.find((m) => passOf(m) === MESH_PASS_OPAQUE)!;
    let max = [0, 0, 0];
    let hasOrigin = false;
    for (const t of drawnTriangles(opaque)) {
      for (const v of t.split(' ')) {
        const [x, y, z] = v.split(',').map(Number) as [number, number, number];
        max = [Math.max(max[0]!, x), Math.max(max[1]!, y), Math.max(max[2]!, z)];
        if (x === 0 && y === 0 && z === 0) hasOrigin = true;
      }
    }
    expect(max).toEqual([1024, 3072, 1024]);
    expect(hasOrigin).toBe(true);
    r.dispose();
  });

  test('the region sphere contains every section sphere', () => {
    const ps = cornerPayloads();
    const r = built(ps);
    for (const m of meshes(r.root)) {
      const sphere = m.geometry.boundingSphere;
      expect(sphere).not.toBeNull();
      expect(m.geometry.boundingBox).not.toBeNull();
      for (const { p, o, r: row } of rowsOf(ps, passOf(m))) {
        const s = sectionSphere(p, o, row);
        expect(sphere!.center.distanceTo(s.center) + s.radius).toBeLessThanOrEqual(sphere!.radius + 1e-3);
        expect(m.geometry.boundingBox!.containsPoint(s.center)).toBe(true);
      }
    }
    r.dispose();
  });

  test('one mesh per region and pass', () => {
    // Region (−1, 2) holds every pass; region (0, 0) only opaque and water.
    const ps = [
      ...cornerPayloads(),
      fakePayload(1, 1, [{ sy: 4, pass: 0, quads: 2 }, { sy: 5, pass: 2, quads: 1 }]),
      fakePayload(6, 2, [{ sy: 4, pass: 0, quads: 1 }]),
    ];
    const materials = system('mesh');
    const r = built(ps, materials);
    const ms = meshes(r.root);
    for (const m of ms) expect((m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh).toBeFalsy();
    expect(ms.map((m) => `${regionKey(m)}:${passOf(m)}`).sort()).toEqual(['-1,2:0', '-1,2:1', '-1,2:2', '0,0:0', '0,0:2']);
    expect(r.counts(createSectionRendererCounts()).regions).toBe(2);
    // Culled again once three has uploaded the written ranges.
    for (const m of ms) uploaded(m);
    r.pump(fakeGate(32), 0, 0, 0);
    for (const m of ms) {
      expect(m.frustumCulled).toBe(true);
      expect(m.material).toBe(
        passOf(m) === MESH_PASS_OPAQUE ? materials.terrainOpaque : passOf(m) === MESH_PASS_CUTOUT ? materials.terrainCutout : materials.water,
      );
    }
    r.dispose();
  });

  test('a region whose columns have no rows is built with no mesh', () => {
    const r = built([fakePayload(0, 0, [])]);
    expect(r.counts(createSectionRendererCounts()).regions).toBe(1);
    expect(meshes(r.root)).toHaveLength(0);
    r.dispose();
  });

  test('the region matrix is relative to the origin, scale 1/8', () => {
    const ps = cornerPayloads();
    const r = built(ps);
    for (const origin of [[0, 0, 0], [512, -512, -1024], [-1536, 0, 2048]] as const) {
      r.setOrigin(origin[0], origin[1], origin[2]);
      r.root.updateMatrixWorld(true);
      for (const m of meshes(r.root)) {
        const t = new Vector3();
        const s = new Vector3();
        m.matrixWorld.decompose(t, new Quaternion(), s);
        expect(t.toArray()).toEqual([-128 - origin[0], -64 - origin[1], 256 - origin[2]]);
        expect(s.toArray()).toEqual([1 / 8, 1 / 8, 1 / 8]);
      }
    }
    r.dispose();
  });

  test('the materials are the REGION_MESH variant', () => {
    const materials = system('mesh');
    const r = built(cornerPayloads(), materials);
    const ms = meshes(r.root);
    expect(ms).toHaveLength(3);
    for (const m of ms) {
      const shader = (m.material as unknown as { vertexShader: string }).vertexShader;
      expect(shader).toContain('#define REGION_MESH');
      expect(shader).not.toContain('batching');
    }
    expect(() => createSectionRenderer('mesh', system('batch'))).toThrow(/variant/);
    r.dispose();
  });

  test('sortTranslucent orders translucent regions far to near', () => {
    /** Three regions in a row along x from region (rx0, rz0), each with water and opaque rows. */
    const regions = (rx0: number, rz0: number): ColumnMeshPayload[] =>
      [0, 1, 2].map((k) => fakePayload(8 * (rx0 + k) + 3, 8 * rz0 + 3, [{ sy: 4, pass: 0, quads: 1 }, { sy: 5, pass: 2, quads: 1 }]));
    /** The water meshes' rx, from the lowest renderOrder (drawn first) to the highest. */
    const waterOrder = (r: SectionRenderer): number[] =>
      meshes(r.root)
        .filter((m) => passOf(m) === MESH_PASS_TRANSLUCENT)
        .sort((a, b) => a.renderOrder - b.renderOrder)
        .map((m) => m.userData['rx'] as number);
    const opaqueOrders = (r: SectionRenderer): number[] =>
      meshes(r.root).filter((m) => passOf(m) !== MESH_PASS_TRANSLUCENT).map((m) => m.renderOrder);

    // Near the world origin, with the floating origin at 0.
    const near = built(regions(0, 0));
    near.sortTranslucent(-200, 100, 64);
    expect(waterOrder(near)).toEqual([2, 1, 0]);
    near.sortTranslucent(600, 100, 64);
    expect(waterOrder(near)).toEqual([0, 1, 2]);
    // The region centres are at x 64, 192 and 320: from x 200, region 0 is the farthest, then 2, then 1.
    near.sortTranslucent(200, 100, 64);
    expect(waterOrder(near)).toEqual([0, 2, 1]);
    expect(opaqueOrders(near).every((o) => o === 0)).toBe(true);
    near.dispose();

    // Near (499712, −499712) blocks: the camera is given in scene coordinates, relative to the floating origin.
    const far = built(regions(3904, -3904));
    far.setOrigin(499712, 0, -499712);
    far.sortTranslucent(-200, 100, 64);
    expect(waterOrder(far)).toEqual([3906, 3905, 3904]);
    far.sortTranslucent(600, 100, 64);
    expect(waterOrder(far)).toEqual([3904, 3905, 3906]);
    expect(opaqueOrders(far).every((o) => o === 0)).toBe(true);
    far.dispose();
  });

  test('counts(out).structuralMs is finite and ≥ 0', () => {
    const r = built(cornerPayloads());
    const c = r.counts(createSectionRendererCounts());
    expect(c.structuralMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(c.structuralMs)).toBe(true);
    r.dispose();
  });
});

describe('RegionMesh\'s arena (SP4b spec §4.3, D15)', () => {
  const make = (): SectionRenderer => createSectionRenderer('mesh', system('mesh'));
  /** Stages `p` (seq 1) and uploads it under an unbounded gate. */
  const add = (r: SectionRenderer, p: ColumnMeshPayload): ColumnMeshPayload => {
    r.stage(p, 1);
    pumpAll(r);
    return p;
  };

  test('the free list: first fit, coalescing on release (three ranges, free the middle and the first: one range from 0)', () => {
    const f = createFreeList(100);
    expect([takeFirstFit(f, 10), takeFirstFit(f, 20), takeFirstFit(f, 30)]).toEqual([0, 10, 30]);
    expect(f).toEqual({ starts: [60], sizes: [40], free: 40 });
    giveRange(f, 10, 20);
    expect(f).toEqual({ starts: [10, 60], sizes: [20, 40], free: 60 });
    giveRange(f, 0, 10);
    expect(f).toEqual({ starts: [0, 60], sizes: [30, 40], free: 70 });
    // First fit: 25 from the range at 0, 35 from the one at 60; 41 fits nowhere.
    expect(firstFit(f, 41)).toBe(-1);
    expect(takeFirstFit(f, 41)).toBe(-1);
    expect(takeFirstFit(f, 25)).toBe(0);
    expect(takeFirstFit(f, 35)).toBe(60);
    expect(f).toEqual({ starts: [25, 95], sizes: [5, 5], free: 10 });
    // Coalescing on both sides; a range given twice throws.
    giveRange(f, 30, 30);
    expect(f).toEqual({ starts: [25, 95], sizes: [35, 5], free: 40 });
    giveRange(f, 60, 35);
    expect(f).toEqual({ starts: [25], sizes: [75], free: 75 });
    expect(() => giveRange(f, 20, 10)).toThrow(/free/);

    // In an arena: columns A, B, C one after another; B freed, then A; a column of A's and B's size takes vertex 0.
    const r = make();
    add(r, fakePayload(0, 0, [opaque(1, 2)]));
    add(r, fakePayload(1, 0, [opaque(1, 3)]));
    const c = add(r, fakePayload(2, 0, [opaque(1, 1)]));
    const m = arenaOf(r, MESH_PASS_OPAQUE)!;
    const pos = m.geometry.getAttribute('position').array as Uint16Array;
    const index = m.geometry.getIndex()!.array as Uint32Array;
    expect(Array.from(pos.subarray(4 * 20, 4 * 24))).toEqual(placed(c));
    expect(m.geometry.drawRange.count).toBe(36);
    r.remove(1, 0);
    pumpAll(r);
    r.remove(0, 0);
    pumpAll(r);
    // Only C's range is held: the high-water mark is its end.
    expect(m.geometry.drawRange.count).toBe(36);
    const d = add(r, fakePayload(3, 0, [opaque(1, 5)]));
    expect(Array.from(pos.subarray(0, 4 * 20))).toEqual(placed(d));
    expect(Array.from(index.subarray(0, 30))).toEqual(rebased(d, 0));
    expect(Array.from(index.subarray(30, 36))).toEqual(rebased(c, 20));
    expect(visibleIndices(r.root)).toBe(indexSum([c, d]));
    r.dispose();
  });

  test('a column is hidden by zero indices until the reveal frame, then its rebased indices are written', () => {
    const r = make();
    // An earlier column at vertex 0 and index 0, so the new one's range starts at vertex 4 and index 6.
    const earlier = add(r, fakePayload(1, 0, [opaque(0, 1)]));
    const p = fakePayload(0, 0, [opaque(2, 2), opaque(3, 1), opaque(4, 3)]);
    r.stage(p, 1);
    const m = arenaOf(r, MESH_PASS_OPAQUE)!;
    const pos = m.geometry.getAttribute('position').array as Uint16Array;
    const index = m.geometry.getIndex()!.array as Uint32Array;
    expect(r.pump(fakeGate(2), 0, 0, 0)).toBe(2);
    // The column's whole range is taken at its first row: 24 vertices from 4, 36 indices from 6, all zero.
    expect(m.geometry.drawRange.count).toBe(42);
    expect(Array.from(index.subarray(6, 42))).toEqual(new Array<number>(36).fill(0));
    expect(Array.from(pos.subarray(16, 16 + 4 * 12))).toEqual(placed(p).slice(0, 4 * 12));
    expect(visibleIndices(r.root)).toBe(indexSum([earlier]));
    expect(r.isRevealed(0, 0)).toBe(false);
    expect(r.pump(fakeGate(2), 0, 0, 0)).toBe(1);
    expect(r.isRevealed(0, 0)).toBe(true);
    expect(Array.from(pos.subarray(16, 16 + 4 * 24))).toEqual(placed(p));
    expect(Array.from(index.subarray(6, 42))).toEqual(rebased(p, 4));
    expect(visibleIndices(r.root)).toBe(indexSum([earlier, p]));
    // Removal zeroes the range at once.
    r.remove(0, 0);
    expect(Array.from(index.subarray(6, 42))).toEqual(new Array<number>(36).fill(0));
    expect(visibleIndices(r.root)).toBe(indexSum([earlier]));
    r.dispose();
  });

  test('update ranges are exactly the written ranges, with needsUpdate set (attribute version + 1)', () => {
    const r = make();
    add(r, fakePayload(1, 0, [opaque(0, 1)]));
    const m = arenaOf(r, MESH_PASS_OPAQUE)!;
    const [position, data, index] = attributesOf(m);
    uploaded(m);
    const versions = (): number[] => [position.version, data.version, index.version];
    const ranges = (): unknown[] => [position.updateRanges, data.updateRanges, index.updateRanges];
    let before = versions();
    // A column of two rows (8 and 4 vertices) at vertex 4 and index 6: its first row under a one-row gate.
    r.stage(fakePayload(0, 0, [opaque(2, 2), opaque(3, 1)]), 1);
    expect(r.pump(fakeGate(1), 0, 0, 0)).toBe(1);
    expect(ranges()).toEqual([[{ start: 16, count: 32 }], [{ start: 4, count: 8 }], []]);
    expect(versions()).toEqual([before[0]! + 1, before[1]! + 1, before[2]]);
    uploaded(m);
    before = versions();
    // Its second row and the reveal: the vertices of the row, then the column's 18 indices.
    expect(r.pump(fakeGate(1), 0, 0, 0)).toBe(1);
    expect(r.isRevealed(0, 0)).toBe(true);
    expect(ranges()).toEqual([[{ start: 48, count: 16 }], [{ start: 12, count: 4 }], [{ start: 6, count: 18 }]]);
    expect(versions()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 1]);
    uploaded(m);
    before = versions();
    // Removal: the zeroed index range only.
    r.remove(0, 0);
    expect(ranges()).toEqual([[], [], [{ start: 6, count: 18 }]]);
    expect(versions()).toEqual([before[0], before[1], before[2]! + 1]);
    uploaded(m);
    before = versions();
    // The release frees the ranges and writes nothing.
    expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(2);
    expect(ranges()).toEqual([[], [], []]);
    expect(versions()).toEqual(before);
    expect(m.geometry.drawRange.count).toBe(6);
    r.dispose();
  });

  test('compaction at ≥ 40 % free space moves the live columns down in place (same arrays, no reallocation) and uploads the whole attribute', () => {
    const r = make();
    // A, B, C, D of 8, 10, 6 and 8 rows fill the opaque reservation (32 rows of 4,096 vertices = 131,072).
    add(r, fakePayload(0, 0, big(8)));
    const b = add(r, fakePayload(1, 0, big(10)));
    add(r, fakePayload(2, 0, big(6)));
    const d = add(r, fakePayload(3, 0, big(8)));
    r.remove(0, 0);
    r.remove(2, 0);
    pumpAll(r);
    // 14 of 32 rows free (43.75 %), in two ranges of 8 and 6 rows: E's 10 rows fit in neither.
    const m = arenaOf(r, MESH_PASS_OPAQUE)!;
    uploaded(m);
    r.pump(fakeGate(32), 0, 0, 0);
    expect(m.frustumCulled).toBe(true);
    const geometry = m.geometry;
    const arrays = attributesOf(m).map((a) => a.array);
    const before = attributesOf(m).map((a) => a.version);
    const ops = counts(r).structuralOps;
    const e = fakePayload(4, 0, big(10));
    r.stage(e, 1);
    expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(10);
    expect(counts(r)).toMatchObject({ lastStructural: 'compact', lastStructuralBytes: 2_359_296, structuralOps: ops + 1 });
    expect(r.isRevealed(4, 0)).toBe(true);
    // In place: the same geometry and arrays.
    expect(m.geometry).toBe(geometry);
    attributesOf(m).forEach((a, k) => expect(a.array).toBe(arrays[k]));
    // B moved to 0, D to 10 rows, E after them; indices rebased.
    const [position, data, index] = attributesOf(m);
    const pos = position.array as Uint16Array;
    expect(Array.from(pos.subarray(0, 4 * 10 * ROW_V))).toEqual(placed(b));
    expect(Array.from(pos.subarray(4 * 10 * ROW_V, 4 * 18 * ROW_V))).toEqual(placed(d));
    expect(Array.from(pos.subarray(4 * 18 * ROW_V, 4 * 28 * ROW_V))).toEqual(placed(e));
    expect(Array.from(data.array.subarray(0, 10 * ROW_V))).toEqual(Array.from(b.data));
    expect(Array.from(index.array.subarray(0, 10 * ROW_I))).toEqual(rebased(b, 0));
    expect(Array.from(index.array.subarray(10 * ROW_I, 18 * ROW_I))).toEqual(rebased(d, 10 * ROW_V));
    expect(Array.from(index.array.subarray(18 * ROW_I, 28 * ROW_I))).toEqual(rebased(e, 18 * ROW_V));
    expect(m.geometry.drawRange.count).toBe(28 * ROW_I);
    expect(visibleIndices(r.root)).toBe(indexSum([b, d, e]));
    // The whole attribute is uploaded: no update range, the version grew; unculled until three has sent it.
    for (const [k, a] of attributesOf(m).entries()) {
      expect(a.updateRanges).toEqual([]);
      expect(a.version).toBeGreaterThan(before[k]!);
    }
    expect(m.frustumCulled).toBe(false);
    r.pump(fakeGate(32), 0, 0, 0);
    expect(m.frustumCulled).toBe(false);
    uploaded(m);
    r.pump(fakeGate(32), 0, 0, 0);
    expect(m.frustumCulled).toBe(true);
    r.dispose();
  });

  test('growth below 40 % builds a new geometry of 196,608 vertices and 294,912 indices, disposes the old (its dispose event fired), and gpuBytes() equals the new arena\'s 3,538,944 bytes', () => {
    const r = make();
    const a = add(r, fakePayload(0, 0, big(32)));
    const m = arenaOf(r, MESH_PASS_OPAQUE)!;
    const old = m.geometry;
    let disposed = false;
    old.addEventListener('dispose', () => { disposed = true; });
    const ops = counts(r).structuralOps;
    const b = fakePayload(1, 0, big(1));
    r.stage(b, 1);
    expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(1);
    expect(counts(r)).toMatchObject({ lastStructural: 'grow', lastStructuralBytes: 3_538_944, structuralOps: ops + 1 });
    expect(m.geometry).not.toBe(old);
    expect(disposed).toBe(true);
    expect(m.geometry.getAttribute('position').count).toBe(196_608);
    expect(m.geometry.getAttribute('data').count).toBe(196_608);
    expect(m.geometry.getIndex()!.array.length).toBe(294_912);
    expect(r.gpuBytes()).toBe(3_538_944);
    // No geometry left undisposed: the root holds the one arena, and the live columns were copied in.
    const left = regionObjects(r.root);
    expect(left).toHaveLength(1);
    expect(left[0]!.geometry).toBe(m.geometry);
    expect(Array.from(m.geometry.getAttribute('data').array.subarray(0, 32 * ROW_V))).toEqual(Array.from(a.data));
    expect(r.isRevealed(1, 0)).toBe(true);
    expect(visibleIndices(r.root)).toBe(indexSum([a, b]));

    // Fragmented below 40 %: 12 of 32 rows free (37.5 %) in two ranges, a column of 10 rows grows the arena.
    const s = make();
    add(s, fakePayload(0, 0, big(8)));
    add(s, fakePayload(1, 0, big(12)));
    add(s, fakePayload(2, 0, big(4)));
    add(s, fakePayload(3, 0, big(8)));
    s.remove(0, 0);
    s.remove(2, 0);
    pumpAll(s);
    s.stage(fakePayload(4, 0, big(10)), 1);
    s.pump(fakeGate(32), 0, 0, 0);
    expect(counts(s)).toMatchObject({ lastStructural: 'grow', lastStructuralBytes: 3_538_944 });
    expect(s.isRevealed(4, 0)).toBe(true);
    r.dispose();
    s.dispose();
  });

  test('counts().structuralOps and structuralMs grow on each', () => {
    const r = make();
    let last = counts(r);
    expect(last).toMatchObject({ structuralOps: 0, structuralMs: 0 });
    const step = (p: ColumnMeshPayload | null, kind: string | null): void => {
      if (p !== null) r.stage(p, 1);
      r.pump(UNBOUNDED, 0, 0, 0);
      const now = counts(r);
      expect(now.lastStructural).toBe(kind);
      if (kind === null) {
        expect(now.structuralOps).toBe(last.structuralOps);
        expect(now.structuralMs).toBe(last.structuralMs);
      } else {
        expect(now.structuralOps).toBe(last.structuralOps + 1);
        expect(now.structuralMs).toBeGreaterThan(last.structuralMs);
      }
      last = now;
    };
    step(fakePayload(0, 0, big(8)), 'create');
    step(fakePayload(1, 0, big(8)), null);
    step(fakePayload(2, 0, big(8)), null);
    step(fakePayload(3, 0, big(8)), null);
    r.remove(0, 0);
    r.remove(2, 0);
    step(null, null);
    // 16 of 32 rows free in two ranges of 8: 12 rows compact; then 12 more rows (4 free) grow.
    step(fakePayload(4, 0, big(12)), 'compact');
    step(fakePayload(5, 0, big(12)), 'grow');
    expect(r.isRevealed(5, 0)).toBe(true);
    r.dispose();
  });
});

describe('selectSectionRenderer and createSectionRenderer: the mesh kind (SP4a spec §6.2)', () => {
  test('createSectionRenderer(selectSectionRenderer({multiDraw:false}, null), createMaterialSystem({variant:\'mesh\', ao, smoothLight}, albedo)) returns a renderer whose kind is \'mesh\' and no longer throws \'RegionMesh arrives in Task 22\'; with a \'batch\' material system it throws', () => {
    const kind = selectSectionRenderer({ multiDraw: false }, null);
    expect(kind).toBe('mesh');
    let r: SectionRenderer | null = null;
    expect(() => {
      r = createSectionRenderer(kind, createMaterialSystem({ variant: 'mesh', ao: true, smoothLight: true }, ALBEDO));
    }).not.toThrow();
    expect(r!.kind).toBe('mesh');
    expect(() => createSectionRenderer(kind, createMaterialSystem({ variant: 'batch', ao: true, smoothLight: true }, ALBEDO))).toThrow();
    r!.dispose();
  });

  test('regionOf places the corner columns in region (−1, 2)', () => {
    for (const { cx, cz } of CORNER_COLUMNS) expect(regionOf(cx, cz)).toEqual([-1, 2]);
  });
});

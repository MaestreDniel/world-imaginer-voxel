import { Box3, Sphere, type BatchedMesh, type Mesh, type Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { rowBounds, rowsOfPass, type PayloadRow } from '../../src/render/regionGrid';
import { createSectionRenderer, type SectionRenderer } from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload } from './fixtures/payloads';

const ALBEDO = createFlatColorArray();
const never = (): boolean => false;

/** Region (0, 0): rows of every pass, interleaved, so a pass's rows are not contiguous in a payload. */
const payloads = (): ColumnMeshPayload[] => [
  fakePayload(0, 0, [{ sy: 4, pass: 0, quads: 3 }, { sy: 5, pass: 2, quads: 2 }, { sy: 6, pass: 0, quads: 1 }]),
  fakePayload(1, 3, [{ sy: 2, pass: 1, quads: 4 }]),
  fakePayload(7, 7, [{ sy: 23, pass: 2, quads: 1 }, { sy: 0, pass: 0, quads: 5 }, { sy: 9, pass: 1, quads: 2 }]),
];

/** Builds `ps` (one region) in a renderer of `kind`. */
function built(kind: MaterialVariant, ps: readonly ColumnMeshPayload[]): SectionRenderer {
  const r = createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO));
  r.expect(ps.map((p) => [p.cx, p.cz] as const));
  for (const p of ps) r.stage(p);
  r.buildNext(never);
  return r;
}

function objects<T extends Object3D>(root: Object3D, is: (o: Object3D) => boolean): T[] {
  const out: T[] = [];
  root.traverse((o) => {
    if (is(o)) out.push(o as T);
  });
  return out;
}

const bounds = (p: ColumnMeshPayload, r: number, ox: number, oy: number, oz: number): { sphere: Sphere; box: Box3 } => {
  const sphere = new Sphere();
  const box = new Box3();
  rowBounds(p, r, ox, oy, oz, sphere, box);
  return { sphere, box };
};

describe('regionGrid: the shared row gathering and section bounds (SP4b spec §4.1, §7.6)', () => {
  test('rowsOfPass lists a pass\'s rows in payload order, with their row offsets and the vertex and index sums', () => {
    const ps = payloads();
    const out: PayloadRow[] = [];
    expect(rowsOfPass(ps, MESH_PASS_OPAQUE, out)).toEqual({ vertices: 4 * (3 + 1 + 5), indices: 6 * (3 + 1 + 5) });
    expect(out.map(({ p, o, r }) => [p.cx, p.cz, o, r])).toEqual([[0, 0, 0, 0], [0, 0, 2 * ROW_INTS, 2], [7, 7, ROW_INTS, 1]]);
    for (const { p, o } of out) expect(p.rows[o + 1]).toBe(MESH_PASS_OPAQUE);
    expect(out[0]!.p).toBe(ps[0]);
    expect(out[2]!.p).toBe(ps[2]);

    // `out` is cleared first.
    expect(rowsOfPass(ps, MESH_PASS_CUTOUT, out)).toEqual({ vertices: 4 * (4 + 2), indices: 6 * (4 + 2) });
    expect(out.map(({ p, o, r }) => [p.cx, p.cz, o, r])).toEqual([[1, 3, 0, 0], [7, 7, 2 * ROW_INTS, 2]]);
    expect(rowsOfPass(ps, MESH_PASS_TRANSLUCENT, out)).toEqual({ vertices: 4 * (2 + 1), indices: 6 * (2 + 1) });
    expect(out.map(({ p, o, r }) => [p.cx, p.cz, o, r])).toEqual([[0, 0, ROW_INTS, 1], [7, 7, 0, 0]]);

    // A pass with no rows, and no payloads at all.
    expect(rowsOfPass([ps[1]!], MESH_PASS_OPAQUE, out)).toEqual({ vertices: 0, indices: 0 });
    expect(out).toEqual([]);
    expect(rowsOfPass([], MESH_PASS_OPAQUE, out)).toEqual({ vertices: 0, indices: 0 });
    expect(out).toEqual([]);
  });

  test('rowBounds: the sphere × 8 shifted by the offset, its cube clipped to the 128-unit section there', () => {
    // fakeSphere(0, { sy: 4, pass: 0, quads: 3 }) = (4, 6, 8, 12) blocks: (32, 48, 64) radius 96 in 1/8 blocks, its cube
    // (−64, −48, −32) … (128, 144, 160) clipped to (0, 0, 0) … (128, 128, 128).
    const p = payloads()[0]!;
    expect(Array.from(p.spheres.subarray(0, 4))).toEqual([4, 6, 8, 12]);
    const at0 = bounds(p, 0, 0, 0, 0);
    expect(at0.sphere.center.toArray()).toEqual([32, 48, 64]);
    expect(at0.sphere.radius).toBe(96);
    expect([at0.box.min.toArray(), at0.box.max.toArray()]).toEqual([[0, 0, 0], [128, 128, 128]]);

    // Row 1, fakeSphere(1, { sy: 5, pass: 2, quads: 2 }) = (5, 8, 9, 11), at the section (3, 5, 7) of a region.
    const shifted = bounds(p, 1, 3 * 128, 5 * 128, 7 * 128);
    expect(Array.from(p.spheres.subarray(4, 8))).toEqual([5, 8, 9, 11]);
    expect(shifted.sphere.center.toArray()).toEqual([384 + 40, 640 + 64, 896 + 72]);
    expect(shifted.sphere.radius).toBe(88);
    expect([shifted.box.min.toArray(), shifted.box.max.toArray()]).toEqual([[384, 640, 896], [384 + 128, 640 + 128, 896 + 128]]);

    // A small sphere: the cube lies inside the section and is not clipped.
    p.spheres.set([6, 7, 8, 1], 8);
    const small = bounds(p, 2, 128, 0, 0);
    expect([small.box.min.toArray(), small.box.max.toArray()]).toEqual([[128 + 40, 48, 56], [128 + 56, 64, 72]]);
  });

  test('rowBounds: a cube outside its section leaves a degenerate box at the sphere centre', () => {
    const p = payloads()[0]!;
    p.spheres.set([-10, 6, 8, 2], 0);
    const at0 = bounds(p, 0, 0, 0, 0);
    expect(at0.sphere.center.toArray()).toEqual([-80, 48, 64]);
    expect(at0.sphere.radius).toBe(16);
    expect(at0.box.isEmpty()).toBe(false);
    expect([at0.box.min.toArray(), at0.box.max.toArray()]).toEqual([[-80, 48, 64], [-80, 48, 64]]);
    const shifted = bounds(p, 0, 128, 0, 256);
    expect([shifted.box.min.toArray(), shifted.box.max.toArray()]).toEqual([[48, 48, 320], [48, 48, 320]]);
  });

  test('rowBounds at offset 0 equals RegionBatch\'s section sphere and box', () => {
    const ps = payloads();
    ps[2]!.spheres.set([-10, 6, 8, 2], 0); // one degenerate box among them
    const r = built('batch', ps);
    const got = new Sphere();
    const gotBox = new Box3();
    const rows: PayloadRow[] = [];
    let checked = 0;
    for (const mesh of objects<BatchedMesh>(r.root, (o) => (o as BatchedMesh).isBatchedMesh)) {
      rowsOfPass(ps, mesh.userData['pass'] as number, rows);
      // Geometry ids follow the pass's rows in order.
      rows.forEach(({ p, r: row }, id) => {
        const want = bounds(p, row, 0, 0, 0);
        mesh.getBoundingSphereAt(id, got);
        mesh.getBoundingBoxAt(id, gotBox);
        expect(got.equals(want.sphere)).toBe(true);
        expect(gotBox.equals(want.box)).toBe(true);
        checked++;
      });
    }
    expect(checked).toBe(7);
    r.dispose();
  });

  test('rowBounds at the section\'s place in its region equals RegionMesh\'s, per row', () => {
    // One row per region and pass, so the merged geometry's union is that row's bounds; columns in negative regions too.
    const cases = [
      fakePayload(-1, 23, [{ sy: 23, pass: 0, quads: 2 }]),
      fakePayload(-8, -9, [{ sy: 0, pass: 2, quads: 1 }]),
      fakePayload(13, -1, [{ sy: 11, pass: 1, quads: 3 }]),
      fakePayload(2, 5, [{ sy: 3, pass: 0, quads: 1 }]),
    ];
    cases[3]!.spheres.set([30, 6, 8, 2], 0); // degenerate
    for (const p of cases) {
      const r = built('mesh', [p]);
      const meshes = objects<Mesh>(r.root, (o) => (o as Mesh).isMesh);
      expect(meshes).toHaveLength(1);
      const g = meshes[0]!.geometry;
      const want = bounds(p, 0, (p.cx & 7) * 128, p.rows[0]! * 128, (p.cz & 7) * 128);
      expect(g.boundingSphere!.equals(want.sphere)).toBe(true);
      expect(g.boundingBox!.equals(want.box)).toBe(true);
      r.dispose();
    }
  });
});

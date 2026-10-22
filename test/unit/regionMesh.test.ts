import { Quaternion, Sphere, Vector3, type Mesh, type Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { createSectionRenderer, regionOf, selectSectionRenderer, type SectionRenderer } from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload, type FakeRow } from './fixtures/payloads';
import { sectionRendererContract } from './sectionRendererContract';

sectionRendererContract('mesh');

const ALBEDO = createFlatColorArray();
const system = (variant: MaterialVariant): MaterialSystem => createMaterialSystem({ variant, ao: true, smoothLight: true }, ALBEDO);
const never = (): boolean => false;

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

/** Expects, stages (in the same order) and builds `ps`. */
function built(ps: readonly ColumnMeshPayload[], materials = system('mesh')): SectionRenderer {
  const r = createSectionRenderer('mesh', materials);
  r.expect(ps.map((p) => [p.cx, p.cz] as const));
  for (const p of ps) r.stage(p);
  r.buildNext(never);
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

describe('RegionMesh (SP4a spec §6.2, D2)', () => {
  test('the merged buffers equal the concatenated sections: Uint16 region-local positions at the corners of every section of a region, data unchanged, indices rebased, exact sizes', () => {
    const ps = cornerPayloads();
    const r = built(ps);
    const ms = meshes(r.root);
    expect(ms.map(passOf).sort()).toEqual([0, 1, 2]);
    for (const m of ms) {
      const rows = rowsOf(ps, passOf(m));
      const vertexSum = rows.reduce((n, { p, o }) => n + p.rows[o + 3]!, 0);
      const indexSum = rows.reduce((n, { p, o }) => n + p.rows[o + 5]!, 0);
      const position = m.geometry.getAttribute('position');
      const data = m.geometry.getAttribute('data');
      const index = m.geometry.getIndex()!;
      expect(position.array).toBeInstanceOf(Uint16Array);
      expect(position.itemSize).toBe(4);
      expect(position.normalized).toBe(false);
      expect(data.array).toBeInstanceOf(Uint32Array);
      expect(data.itemSize).toBe(1);
      expect(index.array).toBeInstanceOf(Uint32Array);
      // Exact sizes: the arrays hold the sums and nothing more.
      expect(position.array.length).toBe(4 * vertexSum);
      expect(data.array.length).toBe(vertexSum);
      expect(index.array.length).toBe(indexSum);
      const wantPosition = new Uint16Array(4 * vertexSum);
      const wantData = new Uint32Array(vertexSum);
      const wantIndex = new Uint32Array(indexSum);
      let v = 0;
      let i = 0;
      for (const { p, o } of rows) {
        const lx = p.cx & 7;
        const lz = p.cz & 7;
        const sy = p.rows[o]!;
        const [vs, vc, is, ic] = [p.rows[o + 2]!, p.rows[o + 3]!, p.rows[o + 4]!, p.rows[o + 5]!];
        for (let k = 0; k < vc; k++) {
          const s = 4 * (vs + k);
          wantPosition.set([p.position[s]! + 128 * lx, p.position[s + 1]! + 128 * sy, p.position[s + 2]! + 128 * lz, 0], 4 * (v + k));
        }
        wantData.set(p.data.subarray(vs, vs + vc), v);
        for (let k = 0; k < ic; k++) wantIndex[i + k] = p.index[is + k]! + v;
        v += vc;
        i += ic;
      }
      expect(Array.from(position.array)).toEqual(Array.from(wantPosition));
      expect(Array.from(data.array)).toEqual(Array.from(wantData));
      expect(Array.from(index.array)).toEqual(Array.from(wantIndex));
    }
    // The corners of the region: the (0, 0, 0) of local column (0, 0) at sy 0, and the far corner of (7, 7) at sy 23.
    const opaque = ms.find((m) => passOf(m) === MESH_PASS_OPAQUE)!.geometry.getAttribute('position').array as Uint16Array;
    let max = [0, 0, 0];
    let hasOrigin = false;
    for (let k = 0; k < opaque.length; k += 4) {
      max = [Math.max(max[0]!, opaque[k]!), Math.max(max[1]!, opaque[k + 1]!), Math.max(max[2]!, opaque[k + 2]!)];
      if (opaque[k] === 0 && opaque[k + 1] === 0 && opaque[k + 2] === 0) hasOrigin = true;
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
    expect(r.counts().builtRegions).toBe(2);
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
    expect(r.counts().builtRegions).toBe(1);
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

  test('counts().mergeMs accumulates the merge time', () => {
    const r = built(cornerPayloads());
    expect(r.counts().mergeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.counts().mergeMs)).toBe(true);
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

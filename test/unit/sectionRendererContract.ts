import { Matrix4, Quaternion, Vector3, type BatchedMesh, type BufferGeometry, type Mesh, type Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem } from '../../src/render/materials/index';
import { createSectionRenderer, regionOf, type SectionRenderer, type SectionRendererKind } from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload } from './fixtures/payloads';

/**
 * The `SectionRenderer` contract (SP4a spec §6.2, §9.7): staging, hidden until one reveal, origin rebase, counts. It is
 * run against both implementations, RegionBatch (`regionBatch.test.ts`) and RegionMesh (Task 22). The checks read only
 * what three exposes on the renderer's `root`: meshes, and a BatchedMesh's instance matrices.
 */

const ALBEDO = createFlatColorArray();

/** Region A (0, 0) holds four columns around (3.5, 3.5); region B (2, 0) one column, so A is the nearer one. */
const A_COLUMNS = [[3, 3], [4, 4], [3, 4], [4, 3]] as const;
const B_COLUMN = [17, 3] as const;

type Rows = Parameters<typeof fakePayload>[2];
/** Rows per column of region A: opaque everywhere, cutout and water on some (5 sections and 9 rows over the region). */
const A_ROWS: readonly Rows[] = [
  [{ sy: 4, pass: 0, quads: 3 }, { sy: 5, pass: 2, quads: 1 }],
  [{ sy: 4, pass: 0, quads: 2 }],
  [{ sy: 3, pass: 0, quads: 1 }, { sy: 4, pass: 1, quads: 2 }, { sy: 4, pass: 0, quads: 4 }],
  [{ sy: 6, pass: 0, quads: 5 }, { sy: 6, pass: 2, quads: 2 }, { sy: 23, pass: 0, quads: 1 }],
];
/** Region B's column: two rows, so A's and B's section counts differ (9 and 2). */
const B_ROWS: Rows = [{ sy: 0, pass: 0, quads: 6 }, { sy: 7, pass: 2, quads: 3 }];

interface Scene {
  readonly a: ColumnMeshPayload[];
  readonly b: ColumnMeshPayload;
  readonly all: ColumnMeshPayload[];
  readonly columns: Array<readonly [number, number]>;
}

/** The two-region scene, shifted by (dx, dz) columns (a shift by a multiple of 8 keeps the region layout). */
function sceneAt(dx = 0, dz = 0): Scene {
  const a = A_COLUMNS.map(([cx, cz], k) => fakePayload(cx + dx, cz + dz, A_ROWS[k]!));
  const b = fakePayload(B_COLUMN[0] + dx, B_COLUMN[1] + dz, B_ROWS);
  return { a, b, all: [...a, b], columns: [...a, b].map((p) => [p.cx, p.cz] as const) };
}

const rowCount = (ps: readonly ColumnMeshPayload[]): number => ps.reduce((n, p) => n + p.rows.length / ROW_INTS, 0);
const rowSum = (ps: readonly ColumnMeshPayload[], field: 3 | 5): number => {
  let n = 0;
  for (const p of ps) for (let o = 0; o < p.rows.length; o += ROW_INTS) n += p.rows[o + field]!;
  return n;
};

/** Every mesh under `root` (a BatchedMesh counts once). */
function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

/** The placement of every drawn piece under `root`: each BatchedMesh instance's matrix, or each mesh's own matrix. */
function placements(root: Object3D): Array<{ t: Vector3; s: Vector3 }> {
  root.updateMatrixWorld(true);
  const out: Array<{ t: Vector3; s: Vector3 }> = [];
  const instance = new Matrix4();
  const world = new Matrix4();
  const push = (m: Matrix4) => {
    const t = new Vector3();
    const s = new Vector3();
    m.decompose(t, new Quaternion(), s);
    out.push({ t, s });
  };
  for (const mesh of meshes(root)) {
    const batch = mesh as unknown as BatchedMesh;
    if (batch.isBatchedMesh) {
      for (let i = 0; i < batch.instanceCount; i++) push(world.multiplyMatrices(mesh.matrixWorld, batch.getMatrixAt(i, instance)));
    } else {
      push(mesh.matrixWorld.clone());
    }
  }
  return out;
}

const key = (x: number, y: number, z: number): string => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;

/**
 * The origins the placements must sit at, before subtracting the floating origin: one per row at the section origin
 * (cx·16, sy·16 − 64, cz·16) for RegionBatch; one per region and pass at the region origin (rx·128, −64, rz·128) for
 * RegionMesh.
 */
function expectedOrigins(kind: SectionRendererKind, ps: readonly ColumnMeshPayload[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const regionPasses = new Set<string>();
  for (const p of ps) {
    for (let o = 0; o < p.rows.length; o += ROW_INTS) {
      const sy = p.rows[o]!;
      const pass = p.rows[o + 1]!;
      if (kind === 'batch') {
        out.push([p.cx * 16, sy * 16 - 64, p.cz * 16]);
      } else {
        const [rx, rz] = regionOf(p.cx, p.cz);
        const k = `${rx},${rz},${pass}`;
        if (!regionPasses.has(k)) {
          regionPasses.add(k);
          out.push([rx * 128, -64, rz * 128]);
        }
      }
    }
  }
  return out;
}

function expectPlacedAt(r: SectionRenderer, kind: SectionRendererKind, ps: readonly ColumnMeshPayload[], origin: readonly [number, number, number]): void {
  const got = placements(r.root);
  for (const { s } of got) {
    expect(s.x).toBeCloseTo(1 / 8, 9);
    expect(s.y).toBeCloseTo(1 / 8, 9);
    expect(s.z).toBeCloseTo(1 / 8, 9);
  }
  const want = expectedOrigins(kind, ps).map(([x, y, z]) => key(x - origin[0], y - origin[1], z - origin[2])).sort();
  expect(got.map(({ t }) => key(t.x, t.y, t.z)).sort()).toEqual(want);
}

export function sectionRendererContract(kind: SectionRendererKind): void {
  const make = (): SectionRenderer =>
    createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO));
  const never = (): boolean => false;

  describe(`SectionRenderer contract: ${kind} (SP4a spec §6.2)`, () => {
    test('nothing is built before every expected column of a region is staged', () => {
      const s = sceneAt();
      const r = make();
      expect(r.kind).toBe(kind);
      r.expect(s.columns);
      for (const p of s.a.slice(0, 3)) r.stage(p);
      expect(r.buildNext(never)).toBe(0);
      expect(r.counts().builtRegions).toBe(0);
      expect(meshes(r.root)).toHaveLength(0);
      r.stage(s.a[3]!);
      expect(r.buildNext(never)).toBe(rowCount(s.a));
      expect(r.counts().builtRegions).toBe(1);
      // Region B's one column is still missing.
      expect(r.buildNext(never)).toBe(0);
      r.stage(s.b);
      expect(r.buildNext(never)).toBe(rowCount([s.b]));
      expect(r.counts().builtRegions).toBe(2);
      r.dispose();
    });

    test('buildNext respects exhausted() between regions and returns the sections added', () => {
      const s = sceneAt();
      const r = make();
      r.expect(s.columns);
      // Staged B first: the build order is still nearest first, so A (9 sections) comes before B (2).
      for (const p of [s.b, ...s.a]) r.stage(p);
      expect(r.buildNext(() => true)).toBe(0);
      expect(r.counts().builtRegions).toBe(0);
      let calls = 0;
      expect(r.buildNext(() => calls++ > 0)).toBe(rowCount(s.a));
      expect(calls).toBe(2);
      expect(r.counts().builtRegions).toBe(1);
      expect(r.buildNext(never)).toBe(rowCount([s.b]));
      expect(r.buildNext(never)).toBe(0);
      expect(r.counts().builtRegions).toBe(2);
      r.dispose();
    });

    test('the root stays hidden until revealAll, then every built object is visible in the same call', () => {
      const s = sceneAt();
      const r = make();
      r.expect(s.columns);
      for (const p of s.all) r.stage(p);
      expect(r.root.visible).toBe(false);
      r.buildNext(never);
      expect(meshes(r.root).length).toBeGreaterThan(0);
      expect(r.root.visible).toBe(false);
      for (const m of meshes(r.root)) expect(m.visible).toBe(false);
      r.revealAll();
      expect(r.root.visible).toBe(true);
      for (const m of meshes(r.root)) {
        for (let o: Object3D | null = m; o !== null; o = o.parent) expect(o.visible).toBe(true);
      }
      r.dispose();
    });

    test('counts: expected, staged, built, sections, vertices and indices equal the staged payloads\' sums', () => {
      const s = sceneAt();
      const r = make();
      r.expect(s.columns);
      expect(r.counts()).toMatchObject({ expectedColumns: 5, stagedColumns: 0, regions: 2, builtRegions: 0, sections: 0, vertices: 0, indices: 0 });
      for (const p of s.a) r.stage(p);
      expect(r.counts().stagedColumns).toBe(4);
      r.stage(s.b);
      r.buildNext(never);
      const c = r.counts();
      expect(c).toMatchObject({
        expectedColumns: 5,
        stagedColumns: 5,
        regions: 2,
        builtRegions: 2,
        sections: rowCount(s.all),
        vertices: rowSum(s.all, 3),
        indices: rowSum(s.all, 5),
      });
      expect(c.mergeMs).toBeGreaterThanOrEqual(0);
      if (kind === 'batch') expect(c.mergeMs).toBe(0);
      r.dispose();
    });

    test('setOrigin rebases every matrix: translation = section or region origin − origin, scale 1/8', () => {
      // Columns near (499712, −499712) blocks: the rebased translations are small and exact.
      const s = sceneAt(31232, -31232);
      const r = make();
      r.expect(s.columns);
      for (const p of s.all) r.stage(p);
      r.buildNext(never);
      expectPlacedAt(r, kind, s.all, [0, 0, 0]);
      r.setOrigin(499712, 0, -499712);
      expectPlacedAt(r, kind, s.all, [499712, 0, -499712]);
      r.setOrigin(499200, -512, -500224);
      expectPlacedAt(r, kind, s.all, [499200, -512, -500224]);
      r.dispose();
    });

    test('setOrigin before a region is built places it relative to that origin', () => {
      const s = sceneAt(31232, -31232);
      const r = make();
      r.expect(s.columns);
      r.setOrigin(499712, 0, -499712);
      for (const p of s.all) r.stage(p);
      r.buildNext(never);
      expectPlacedAt(r, kind, s.all, [499712, 0, -499712]);
      r.dispose();
    });

    test('stage refuses a column that is not expected, or one staged twice', () => {
      const s = sceneAt();
      const r = make();
      r.expect(s.columns.slice(0, 4));
      expect(() => r.stage(s.b)).toThrow(/not expected/);
      r.stage(s.a[0]!);
      expect(() => r.stage(s.a[0]!)).toThrow(/already staged/);
      expect(r.counts().stagedColumns).toBe(1);
      r.dispose();
    });

    test('dispose frees every geometry', () => {
      const s = sceneAt();
      const r = make();
      r.expect(s.columns);
      for (const p of s.all) r.stage(p);
      r.buildNext(never);
      const geometries = new Set<BufferGeometry>(meshes(r.root).map((m) => m.geometry));
      expect(geometries.size).toBeGreaterThan(0);
      const freed = new Set<BufferGeometry>();
      for (const g of geometries) g.addEventListener('dispose', () => freed.add(g));
      r.dispose();
      expect(freed).toEqual(geometries);
      expect(meshes(r.root)).toHaveLength(0);
    });
  });
}

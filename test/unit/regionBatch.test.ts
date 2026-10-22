import { BatchedMesh, type Box3, type BufferGeometry, type Object3D, type Sphere } from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { createSectionRenderer, regionOf, selectSectionRenderer, type SectionRenderer } from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload, fakeSphere } from './fixtures/payloads';
import { sectionRendererContract } from './sectionRendererContract';

sectionRendererContract('batch');

const ALBEDO = createFlatColorArray();
const system = (variant: MaterialVariant): MaterialSystem => createMaterialSystem({ variant, ao: true, smoothLight: true }, ALBEDO);
const never = (): boolean => false;

/** Region (0, 0): three columns with opaque and water rows (no cutout row). */
const ROWS = [
  [{ sy: 4, pass: 0, quads: 3 }, { sy: 5, pass: 2, quads: 2 }],
  [{ sy: 4, pass: 0, quads: 1 }, { sy: 6, pass: 0, quads: 7 }],
  [{ sy: 2, pass: 2, quads: 4 }, { sy: 2, pass: 0, quads: 1 }, { sy: 9, pass: 0, quads: 2 }],
] as const;
const payloads = (): ColumnMeshPayload[] =>
  ROWS.map((rows, k) => fakePayload(k, 2 * k, rows.map((r) => ({ ...r }))));

function built(ps: readonly ColumnMeshPayload[]): SectionRenderer {
  const r = createSectionRenderer('batch', system('batch'));
  r.expect(ps.map((p) => [p.cx, p.cz] as const));
  for (const p of ps) r.stage(p);
  r.buildNext(never);
  return r;
}

function batches(root: Object3D): BatchedMesh[] {
  const out: BatchedMesh[] = [];
  root.traverse((o) => {
    if ((o as BatchedMesh).isBatchedMesh) out.push(o as BatchedMesh);
  });
  return out;
}

/** The rows of `ps` in pass `pass`, with their payload. */
function rowsOf(ps: readonly ColumnMeshPayload[], pass: number): Array<{ p: ColumnMeshPayload; r: number }> {
  const out: Array<{ p: ColumnMeshPayload; r: number }> = [];
  for (const p of ps) for (let r = 0; r < p.rows.length / ROW_INTS; r++) if (p.rows[r * ROW_INTS + 1] === pass) out.push({ p, r });
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RegionBatch (SP4a spec §6.2)', () => {
  test('position is a Uint8 itemSize-4 attribute and data a Uint32 itemSize-1 attribute', () => {
    const added: BufferGeometry[] = [];
    const add = BatchedMesh.prototype.addGeometry;
    vi.spyOn(BatchedMesh.prototype, 'addGeometry').mockImplementation(function (this: BatchedMesh, g, ...rest) {
      added.push(g);
      return add.call(this, g, ...rest);
    });
    const ps = payloads();
    const r = built(ps);
    expect(added).toHaveLength(rowsOf(ps, 0).length + rowsOf(ps, 2).length);
    for (const g of [...added, ...batches(r.root).map((b) => b.geometry)]) {
      const position = g.getAttribute('position');
      const data = g.getAttribute('data');
      expect(position.array).toBeInstanceOf(Uint8Array);
      expect(position.itemSize).toBe(4);
      expect(position.normalized).toBe(false);
      expect(data.array).toBeInstanceOf(Uint32Array);
      expect(data.itemSize).toBe(1);
    }
    // A section's attributes view the payload's buffers (no copy before addGeometry).
    expect(added[0]!.getAttribute('position').array.buffer).toBe(ps[0]!.position.buffer);
    expect(added[0]!.getAttribute('data').array.buffer).toBe(ps[0]!.data.buffer);
    expect(added[0]!.getIndex()!.array.buffer).toBe(ps[0]!.index.buffer);
    r.dispose();
  });

  test('each geometry\'s boundingSphere equals the payload sphere × 8 and is set before addGeometry', () => {
    const seen: Array<{ sphere: Sphere | null; box: Box3 | null; key: string }> = [];
    const add = BatchedMesh.prototype.addGeometry;
    vi.spyOn(BatchedMesh.prototype, 'addGeometry').mockImplementation(function (this: BatchedMesh, g, ...rest) {
      // The fake payload's data word is the row number; with the vertex count it names the row (unique in ROWS).
      const data = g.getAttribute('data');
      seen.push({ sphere: g.boundingSphere?.clone() ?? null, box: g.boundingBox?.clone() ?? null, key: `${data.getX(0)}:${data.count}` });
      return add.call(this, g, ...rest);
    });
    const ps = payloads();
    const want = new Map<string, readonly [number, number, number, number]>();
    for (const { p, r } of [...rowsOf(ps, 0), ...rowsOf(ps, 2)]) {
      const o = r * ROW_INTS;
      want.set(`${r}:${p.rows[o + 3]}`, fakeSphere(r, { sy: p.rows[o]!, pass: p.rows[o + 1] as 0 | 1 | 2, quads: p.rows[o + 3]! / 4 }));
    }
    const r = built(ps);
    expect(seen.map((s) => s.key).sort()).toEqual([...want.keys()].sort());
    for (const s of seen) {
      const [x, y, z, radius] = want.get(s.key)!;
      expect(s.sphere).not.toBeNull();
      expect(s.sphere!.center.toArray()).toEqual([8 * x, 8 * y, 8 * z]);
      expect(s.sphere!.radius).toBe(8 * radius);
      expect(s.box).not.toBeNull();
      expect(s.box!.containsPoint(s.sphere!.center)).toBe(true);
    }
    r.dispose();
  });

  test('a region\'s BatchedMesh is sized exactly (maxInstanceCount, maxVertexCount, maxIndexCount)', () => {
    const ps = payloads();
    const r = built(ps);
    const bs = batches(r.root);
    expect(bs).toHaveLength(2);
    const byPass = new Map(bs.map((b) => [b.userData['pass'] as number, b]));
    for (const pass of [0, 2]) {
      const b = byPass.get(pass)!;
      const rows = rowsOf(ps, pass);
      const vertices = rows.reduce((n, { p, r: row }) => n + p.rows[row * ROW_INTS + 3]!, 0);
      const indices = rows.reduce((n, { p, r: row }) => n + p.rows[row * ROW_INTS + 5]!, 0);
      expect(b.maxInstanceCount).toBe(rows.length);
      expect(b.instanceCount).toBe(rows.length);
      // maxVertexCount and maxIndexCount: the batch's buffers hold exactly the sums, and nothing is left unused.
      expect(b.geometry.getAttribute('position').count).toBe(vertices);
      expect(b.geometry.getAttribute('data').count).toBe(vertices);
      expect(b.geometry.getIndex()!.count).toBe(indices);
      expect(b.unusedVertexCount).toBe(0);
      expect(b.unusedIndexCount).toBe(0);
    }
    r.dispose();
  });

  test('no BatchedMesh for a pass without geometry', () => {
    const ps = payloads();
    const materials = system('batch');
    const r = createSectionRenderer('batch', materials);
    r.expect(ps.map((p) => [p.cx, p.cz] as const));
    for (const p of ps) r.stage(p);
    r.buildNext(never);
    const bs = batches(r.root);
    expect(bs.map((b) => b.userData['pass']).sort()).toEqual([0, 2]);
    const byPass = new Map(bs.map((b) => [b.userData['pass'] as number, b.material]));
    expect(byPass.get(0)).toBe(materials.terrainOpaque);
    expect(byPass.get(2)).toBe(materials.water);
    expect(bs.some((b) => b.material === materials.terrainCutout)).toBe(false);
    r.dispose();
  });

  test('a region with a cutout row gets its cutout batch with the cutout material', () => {
    const p = fakePayload(1, 1, [{ sy: 3, pass: 1, quads: 2 }]);
    const materials = system('batch');
    const r = createSectionRenderer('batch', materials);
    r.expect([[1, 1]]);
    r.stage(p);
    r.buildNext(never);
    const bs = batches(r.root);
    expect(bs).toHaveLength(1);
    expect(bs[0]!.material).toBe(materials.terrainCutout);
    r.dispose();
  });

  test('a region whose columns have no rows is built with no BatchedMesh', () => {
    const r = createSectionRenderer('batch', system('batch'));
    r.expect([[0, 0]]);
    r.stage(fakePayload(0, 0, []));
    expect(r.buildNext(never)).toBe(0);
    expect(r.counts().builtRegions).toBe(1);
    expect(batches(r.root)).toHaveLength(0);
    r.dispose();
  });

  test('perObjectFrustumCulled and sortObjects are on', () => {
    const r = built(payloads());
    const bs = batches(r.root);
    expect(bs.length).toBeGreaterThan(0);
    for (const b of bs) {
      expect(b.perObjectFrustumCulled).toBe(true);
      expect(b.sortObjects).toBe(true);
      expect(b.frustumCulled).toBe(true);
    }
    r.dispose();
  });

  test('setOrigin refreshes each BatchedMesh\'s object bounds', () => {
    const r = built(payloads());
    const bs = batches(r.root);
    // Stands in for the first render, which caches the object sphere (Frustum.intersectsObject).
    for (const b of bs) b.computeBoundingSphere();
    const before = bs.map((b) => b.boundingSphere!.clone());
    const delta = [512, -512, 1024] as const;
    r.setOrigin(...delta);
    bs.forEach((b, i) => {
      const s = b.boundingSphere!;
      expect(s.center.x).toBeCloseTo(before[i]!.center.x - delta[0], 3);
      expect(s.center.y).toBeCloseTo(before[i]!.center.y - delta[1], 3);
      expect(s.center.z).toBeCloseTo(before[i]!.center.z - delta[2], 3);
      expect(s.radius).toBeCloseTo(before[i]!.radius, 3);
      expect(b.boundingBox).not.toBeNull();
    });
    r.dispose();
  });

  test('the materials come from a batch material system', () => {
    expect(() => createSectionRenderer('batch', system('mesh'))).toThrow(/variant/);
    expect(createSectionRenderer('batch', system('batch')).kind).toBe('batch');
  });
});

describe('selectSectionRenderer and createSectionRenderer (SP4a spec §6.2)', () => {
  test('multiDraw true → batch, false → mesh, and the override wins both ways', () => {
    expect(selectSectionRenderer({ multiDraw: true }, null)).toBe('batch');
    expect(selectSectionRenderer({ multiDraw: false }, null)).toBe('mesh');
    expect(selectSectionRenderer({ multiDraw: true }, 'mesh')).toBe('mesh');
    expect(selectSectionRenderer({ multiDraw: false }, 'batch')).toBe('batch');
  });

  test('a mismatched material variant throws', () => {
    expect(() => createSectionRenderer('mesh', system('batch'))).toThrow(/variant/);
    expect(() => createSectionRenderer('batch', system('mesh'))).toThrow(/variant/);
  });

  test('regionOf is cx >> 3, cz >> 3', () => {
    expect(regionOf(0, 0)).toEqual([0, 0]);
    expect(regionOf(7, 8)).toEqual([0, 1]);
    expect(regionOf(-1, -8)).toEqual([-1, -1]);
    expect(regionOf(-9, 31239)).toEqual([-2, 3904]);
  });
});

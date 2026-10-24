import { BatchedMesh, Matrix4, Quaternion, Vector3, type Box3, type BufferGeometry, type Object3D, type Sphere } from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import {
  createSectionRenderer, createSectionRendererCounts, regionOf, selectSectionRenderer, type SectionRenderer,
  type SectionRendererCounts,
} from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload, fakeSphere, type FakeRow } from './fixtures/payloads';
import { fakeGate, opaque, pumpAll, rowsOf, sectionRendererContract, visibleIndices, water } from './sectionRendererContract';

sectionRendererContract('batch');

const ALBEDO = createFlatColorArray();
const system = (variant: MaterialVariant): MaterialSystem => createMaterialSystem({ variant, ao: true, smoothLight: true }, ALBEDO);
const make = (materials = system('batch')): SectionRenderer => createSectionRenderer('batch', materials);
const counts = (r: SectionRenderer): SectionRendererCounts => r.counts(createSectionRendererCounts());

/** Region (0, 0): three columns with opaque and water rows (no cutout row). */
const ROWS = [
  [{ sy: 4, pass: 0, quads: 3 }, { sy: 5, pass: 2, quads: 2 }],
  [{ sy: 4, pass: 0, quads: 1 }, { sy: 6, pass: 0, quads: 7 }],
  [{ sy: 2, pass: 2, quads: 4 }, { sy: 2, pass: 0, quads: 1 }, { sy: 9, pass: 0, quads: 2 }],
] as const;
const payloads = (): ColumnMeshPayload[] =>
  ROWS.map((rows, k) => fakePayload(k, 2 * k, rows.map((r) => ({ ...r }))));

/** Stages `ps` (seq 1), uploads them all from the camera at (0, 0) and shows them. */
function built(ps: readonly ColumnMeshPayload[], materials = system('batch')): SectionRenderer {
  const r = make(materials);
  for (const p of ps) r.stage(p, 1);
  pumpAll(r);
  return r;
}

function batches(root: Object3D): BatchedMesh[] {
  const out: BatchedMesh[] = [];
  root.traverse((o) => {
    if ((o as BatchedMesh).isBatchedMesh) out.push(o as BatchedMesh);
  });
  return out;
}
const batchOf = (r: SectionRenderer, pass: number, rx = 0, rz = 0): BatchedMesh | undefined =>
  batches(r.root).find((b) => b.userData['pass'] === pass && b.userData['rx'] === rx && b.userData['rz'] === rz);

/** A batch's buffers: position, data and index `byteLength`s. */
const bytesOf = (b: BatchedMesh): number =>
  b.geometry.getAttribute('position').array.byteLength + b.geometry.getAttribute('data').array.byteLength + b.geometry.getIndex()!.array.byteLength;

/** The rows of `ps` in pass `pass`, with their payload. */
function rowsIn(ps: readonly ColumnMeshPayload[], pass: number): Array<{ p: ColumnMeshPayload; r: number }> {
  const out: Array<{ p: ColumnMeshPayload; r: number }> = [];
  for (const p of ps) for (let r = 0; r < p.rows.length / ROW_INTS; r++) if (p.rows[r * ROW_INTS + 1] === pass) out.push({ p, r });
  return out;
}

/** `n` rows of `quads` quads in `pass` (1,024 quads: 4,096 vertices and 6,144 indices). */
const big = (n: number, quads = 1024, pass: 0 | 1 | 2 = 0): FakeRow[] => Array.from({ length: n }, (_, k) => ({ sy: k % 24, pass, quads }));

/** The geometries a test hands to `addGeometry`, without the empty one a new batch is initialised with. */
function spyAdded(): BufferGeometry[] {
  const added: BufferGeometry[] = [];
  const add = BatchedMesh.prototype.addGeometry;
  vi.spyOn(BatchedMesh.prototype, 'addGeometry').mockImplementation(function (this: BatchedMesh, g, ...rest) {
    if (g.getAttribute('position').count > 0) added.push(g);
    return add.call(this, g, ...rest);
  });
  return added;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RegionBatch (SP4b spec §4.2, D14)', () => {
  test('reservations: the first opaque row creates a batch with maxInstanceCount 1,536, 131,072 vertices and a Uint32 index of 196,608; the first translucent row 16,384 vertices and a Uint16 index of 24,576 (gpuBytes 180,224 for that batch); cutout on demand 8,192 / 12,288', () => {
    const materials = system('batch');
    const r = make(materials);
    r.stage(fakePayload(0, 0, [opaque(4)]), 1);
    pumpAll(r);
    expect(batches(r.root)).toHaveLength(1);
    const o = batchOf(r, 0)!;
    expect(o.maxInstanceCount).toBe(1536);
    expect(o.geometry.getAttribute('position').count).toBe(131_072);
    expect(o.geometry.getAttribute('data').count).toBe(131_072);
    expect(o.geometry.getIndex()!.array).toBeInstanceOf(Uint32Array);
    expect(o.geometry.getIndex()!.array.length).toBe(196_608);
    expect(bytesOf(o)).toBe(1_835_008);
    expect(o.material).toBe(materials.terrainOpaque);

    r.stage(fakePayload(1, 0, [water(4)]), 1);
    pumpAll(r);
    const t = batchOf(r, 2)!;
    expect(t.maxInstanceCount).toBe(1536);
    expect(t.geometry.getAttribute('position').count).toBe(16_384);
    expect(t.geometry.getIndex()!.array).toBeInstanceOf(Uint16Array);
    expect(t.geometry.getIndex()!.array.length).toBe(24_576);
    expect(bytesOf(t)).toBe(180_224);
    expect(t.material).toBe(materials.water);
    expect(batchOf(r, 1)).toBeUndefined();

    r.stage(fakePayload(2, 0, [{ sy: 3, pass: 1, quads: 2 }]), 1);
    pumpAll(r);
    const c = batchOf(r, 1)!;
    expect(c.geometry.getAttribute('position').count).toBe(8192);
    expect(c.geometry.getIndex()!.array).toBeInstanceOf(Uint16Array);
    expect(c.geometry.getIndex()!.array.length).toBe(12_288);
    expect(c.material).toBe(materials.terrainCutout);
    expect(r.gpuBytes()).toBe(1_835_008 + 180_224 + bytesOf(c));
    expect(bytesOf(c)).toBe(90_112);
    expect(counts(r).structuralOps).toBe(3);
    r.dispose();
  });

  test('a row that does not fit grows the batch to 196,608 / 294,912 when deleted space is under 40 % and optimizes at or above it, one per pump', () => {
    // Grow: the reservation is full (32 rows of 4,096 vertices = 131,072) and nothing was deleted.
    const g = make();
    g.stage(fakePayload(0, 0, big(32)), 1);
    pumpAll(g);
    const b = batchOf(g, 0)!;
    expect(b.unusedVertexCount).toBe(0);
    expect(b.unusedIndexCount).toBe(0);
    const old = b.geometry;
    let oldDisposed = false;
    old.addEventListener('dispose', () => { oldDisposed = true; });
    g.stage(fakePayload(1, 0, big(1)), 1);
    expect(g.pump(fakeGate(32), 0, 0, 0)).toBe(1);
    expect(counts(g)).toMatchObject({ lastStructural: 'grow', lastStructuralBytes: 2_752_512, structuralOps: 2 });
    expect(b.geometry).not.toBe(old);
    expect(oldDisposed).toBe(true);
    expect(b.geometry.getAttribute('position').count).toBe(196_608);
    expect(b.geometry.getIndex()!.array.length).toBe(294_912);
    expect(g.isRevealed(1, 0)).toBe(true);
    expect(g.gpuBytes()).toBe(2_752_512);
    g.dispose();

    // Just under 40 %: 12 of 32 rows deleted (49,152 vertices, 37.5 %) → grow.
    const u = make();
    u.stage(fakePayload(0, 0, big(12)), 1);
    u.stage(fakePayload(1, 0, big(20)), 1);
    pumpAll(u);
    u.remove(0, 0);
    expect(u.pump(fakeGate(32), 0, 0, 0)).toBe(12);
    u.stage(fakePayload(2, 0, big(1)), 1);
    u.pump(fakeGate(32), 0, 0, 0);
    expect(counts(u).lastStructural).toBe('grow');
    expect(batchOf(u, 0)!.geometry.getAttribute('position').count).toBe(196_608);
    u.dispose();

    // At or above 40 %: 13 of 32 rows deleted (53,248 vertices, 40.6 %) → optimize, in place, at the same size. A
    // column of 14 rows (57,344 vertices) still overflows after it: the growth waits for the next pump.
    const o = make();
    o.stage(fakePayload(0, 0, big(13)), 1);
    o.stage(fakePayload(1, 0, big(19)), 1);
    pumpAll(o);
    o.remove(0, 0);
    expect(o.pump(fakeGate(32), 0, 0, 0)).toBe(13);
    const ob = batchOf(o, 0)!;
    const before = ob.geometry;
    const ops = counts(o).structuralOps;
    o.stage(fakePayload(2, 0, big(14)), 1);
    expect(o.pump(fakeGate(32), 0, 0, 0)).toBe(13);
    expect(counts(o)).toMatchObject({ lastStructural: 'optimize', lastStructuralBytes: 1_835_008, structuralOps: ops + 1 });
    expect(ob.geometry).toBe(before);
    expect(ob.geometry.getAttribute('position').count).toBe(131_072);
    expect(o.isRevealed(2, 0)).toBe(false);
    expect(o.pump(fakeGate(32), 0, 0, 0)).toBe(1);
    expect(counts(o)).toMatchObject({ lastStructural: 'grow', structuralOps: ops + 2 });
    expect(o.isRevealed(2, 0)).toBe(true);
    expect(visibleIndices(o.root)).toBe(33 * 6144);
    o.dispose();
  });

  test('the 1,537th instance waits for setInstanceCount(2,304)', () => {
    const r = make();
    const p = fakePayload(0, 0, big(1537, 1));
    r.stage(p, 1);
    const grow = vi.spyOn(BatchedMesh.prototype, 'setInstanceCount');
    expect(r.pump(fakeGate(10_000), 0, 0, 0)).toBe(1536);
    const b = batchOf(r, 0)!;
    expect(b.instanceCount).toBe(1536);
    expect(grow).not.toHaveBeenCalled();
    expect(r.isRevealed(0, 0)).toBe(false);
    expect(visibleIndices(r.root)).toBe(0);
    expect(r.pump(fakeGate(10_000), 0, 0, 0)).toBe(1);
    expect(grow).toHaveBeenCalledWith(2304);
    expect(b.maxInstanceCount).toBe(2304);
    expect(b.instanceCount).toBe(1537);
    expect(counts(r)).toMatchObject({ lastStructural: 'instances', lastStructuralBytes: 1_835_008 });
    expect(r.isRevealed(0, 0)).toBe(true);
    expect(visibleIndices(r.root)).toBe(1537 * 6);
    r.dispose();
  });

  test('instance-id reuse: delete and re-add, then rebase: every instance matrix is still its section offset × 1/8 (no NaN)', () => {
    const r = make();
    const a = fakePayload(1, 2, [opaque(3), opaque(7), water(2)]);
    const b = fakePayload(5, 6, [opaque(0), opaque(23)]);
    r.stage(a, 1);
    r.stage(b, 1);
    pumpAll(r);
    r.remove(1, 2);
    pumpAll(r);
    const c = fakePayload(2, 7, [opaque(11), opaque(12), opaque(13)]);
    r.stage(c, 1);
    pumpAll(r);
    const o = batchOf(r, 0)!;
    // Ids 0 and 1 (a's) were reused: five ids for the five opaque rows of b and c.
    expect((o as unknown as { _instanceInfo: unknown[] })._instanceInfo).toHaveLength(5);
    r.setOrigin(1024, 512, -2048);
    expect(o.position.toArray()).toEqual([-1024, -576, 2048]);
    const want = (ps: readonly ColumnMeshPayload[], pass: number): string[] =>
      rowsIn(ps, pass).map(({ p, r: row }) => [(p.cx & 7) * 16, p.rows[row * ROW_INTS]! * 16, (p.cz & 7) * 16].join(',')).sort();
    for (const [batch, pass] of [[o, 0], [batchOf(r, 2)!, 2]] as const) {
      const got: string[] = [];
      const m = new Matrix4();
      const t = new Vector3();
      const s = new Vector3();
      const info = (batch as unknown as { _instanceInfo: Array<{ active: boolean }> })._instanceInfo;
      for (let i = 0; i < info.length; i++) {
        if (!info[i]!.active) continue;
        batch.getMatrixAt(i, m);
        expect(m.elements.every(Number.isFinite)).toBe(true);
        m.decompose(t, new Quaternion(), s);
        expect(s.toArray()).toEqual([1 / 8, 1 / 8, 1 / 8]);
        got.push(t.toArray().join(','));
      }
      expect(got.sort()).toEqual(want([b, c], pass));
    }
    r.dispose();
  });

  test('removal releases at most 32 rows per pump', () => {
    const r = make();
    r.stage(fakePayload(3, 3, rowsOf(48, 22)), 1);
    pumpAll(r);
    const deletes = vi.spyOn(BatchedMesh.prototype, 'deleteGeometry');
    r.remove(3, 3);
    expect(deletes).not.toHaveBeenCalled();
    const released: number[] = [];
    for (let i = 0; i < 4; i++) {
      deletes.mockClear();
      released.push(r.pump(fakeGate(32), 0, 0, 0));
      expect(deletes.mock.calls.length).toBe(released[i]);
    }
    expect(released).toEqual([32, 32, 6, 0]);
    expect(batches(r.root)).toHaveLength(0);
    r.dispose();
  });

  test('position is a Uint8 itemSize-4 attribute and data a Uint32 itemSize-1 attribute; a row\'s geometry views the payload', () => {
    const added = spyAdded();
    const ps = payloads();
    const r = built(ps);
    expect(added).toHaveLength(rowsIn(ps, 0).length + rowsIn(ps, 2).length);
    for (const g of [...added, ...batches(r.root).map((b) => b.geometry)]) {
      const position = g.getAttribute('position');
      const data = g.getAttribute('data');
      expect(position.array).toBeInstanceOf(Uint8Array);
      expect(position.itemSize).toBe(4);
      expect(position.normalized).toBe(false);
      expect(data.array).toBeInstanceOf(Uint32Array);
      expect(data.itemSize).toBe(1);
    }
    // A row's attributes view the payload's buffers (no copy before addGeometry).
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
      if (data.count > 0) seen.push({ sphere: g.boundingSphere?.clone() ?? null, box: g.boundingBox?.clone() ?? null, key: `${data.getX(0)}:${data.count}` });
      return add.call(this, g, ...rest);
    });
    const ps = payloads();
    const want = new Map<string, readonly [number, number, number, number]>();
    for (const { p, r } of [...rowsIn(ps, 0), ...rowsIn(ps, 2)]) {
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

  test('no BatchedMesh for a pass without geometry; a cutout row gets the cutout batch', () => {
    const ps = payloads();
    const materials = system('batch');
    const r = built(ps, materials);
    const bs = batches(r.root);
    expect(bs.map((b) => b.userData['pass']).sort()).toEqual([0, 2]);
    expect(batchOf(r, 0)!.material).toBe(materials.terrainOpaque);
    expect(batchOf(r, 2)!.material).toBe(materials.water);
    expect(bs.some((b) => b.material === materials.terrainCutout)).toBe(false);
    r.dispose();
    const c = built([fakePayload(1, 1, [{ sy: 3, pass: 1, quads: 2 }])], materials);
    expect(batches(c.root)).toHaveLength(1);
    expect(batches(c.root)[0]!.material).toBe(materials.terrainCutout);
    c.dispose();
  });

  test('a column with no rows is revealed with no BatchedMesh', () => {
    const r = built([fakePayload(0, 0, [])]);
    expect(counts(r)).toMatchObject({ regions: 1, columnsRevealed: 1, rows: 0 });
    expect(r.isRevealed(0, 0)).toBe(true);
    expect(batches(r.root)).toHaveLength(0);
    r.dispose();
  });

  test('perObjectFrustumCulled and sortObjects are on; the batch\'s bounding sphere and box are the region\'s, set once', () => {
    const r = built(payloads());
    const bs = batches(r.root);
    expect(bs.length).toBeGreaterThan(0);
    for (const b of bs) {
      expect(b.perObjectFrustumCulled).toBe(true);
      expect(b.sortObjects).toBe(true);
      expect(b.boundingSphere!.center.toArray()).toEqual([64, 192, 64]);
      expect(b.boundingSphere!.radius).toBeCloseTo(212.26, 2);
      expect([b.boundingBox!.min.toArray(), b.boundingBox!.max.toArray()]).toEqual([[0, 0, 0], [128, 384, 128]]);
    }
    const spheres = bs.map((b) => b.boundingSphere);
    const sphere = vi.spyOn(BatchedMesh.prototype, 'computeBoundingSphere');
    const box = vi.spyOn(BatchedMesh.prototype, 'computeBoundingBox');
    r.setOrigin(512, -512, 1024);
    r.stage(fakePayload(4, 4, [opaque(1), water(2)]), 1);
    pumpAll(r);
    expect(sphere).not.toHaveBeenCalled();
    expect(box).not.toHaveBeenCalled();
    expect(bs.map((b) => b.boundingSphere)).toEqual(spheres);
    for (const b of bs) expect(b.position.toArray()).toEqual([-512, -64 + 512, -1024]);
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

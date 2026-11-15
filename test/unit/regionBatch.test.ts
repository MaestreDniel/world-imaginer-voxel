import {
  BatchedMesh, Matrix4, PerspectiveCamera, Quaternion, REVISION, Vector3, type Box3, type BufferAttribute, type BufferGeometry,
  type Material, type Object3D, type Sphere,
} from 'three';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MESH_PASS_XRAY, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { torusSlot } from '../../src/render/culling/caveCulling';
import { createMaterialSystem, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import {
  BATCH_GROWTH, cullDrawList, OPTIMIZE_AT, SHRINK_HEADROOM, SHRINK_IDLE_PUMPS, SHRINK_MIN_SLACK, type BatchDrawList,
} from '../../src/render/regionBatch';
import {
  createRevealProbe, createSectionRenderer, createSectionRendererCounts, regionOf, selectSectionRenderer, type SectionRenderer,
  type SectionRendererCounts,
} from '../../src/render/sectionRenderer';
import { GHOST_ORDER, XRAY_ORDER } from '../../src/render/selection';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload, fakeSphere, type FakeRow } from './fixtures/payloads';
import { fakeGate, indexSum, opaque, pumpAll, rowsOf, sectionRendererContract, visibleIndices, water } from './sectionRendererContract';

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
const big = (n: number, quads = 1024, pass: 0 | 1 | 2 | 3 = 0): FakeRow[] => Array.from({ length: n }, (_, k) => ({ sy: k % 24, pass, quads }));

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

  test('a row that does not fit, with no deleted space, grows the batch × 1.25 to 163,840 / 245,760 (the old geometry disposed), one per pump', () => {
    // The reservation is full (32 rows of 4,096 vertices = 131,072) and nothing was deleted.
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
    const vertices = Math.ceil(131_072 * BATCH_GROWTH);
    const indices = Math.ceil(196_608 * BATCH_GROWTH);
    expect([vertices, indices]).toEqual([163_840, 245_760]);
    // 8 bytes per vertex (position and data) and a Uint32 index (over 65,535 vertices).
    const bytes = 8 * vertices + 4 * indices;
    expect(bytes).toBe(2_293_760);
    expect(counts(g)).toMatchObject({ lastStructural: 'grow', lastStructuralBytes: bytes, structuralOps: 2 });
    expect(b.geometry).not.toBe(old);
    expect(oldDisposed).toBe(true);
    expect(b.geometry.getAttribute('position').count).toBe(vertices);
    expect(b.geometry.getIndex()!.array.length).toBe(indices);
    expect(g.isRevealed(1, 0)).toBe(true);
    expect(g.gpuBytes()).toBe(bytes);
    g.dispose();
  });

  test('a row that does not fit optimizes first when the deleted space is ≥ 10 % of the batch or would make the waiting rows fit, else grows (SP6a spec §5.1, Task 48)', () => {
    expect(OPTIMIZE_AT).toBe(0.1);
    /** A full reservation with the first column's `deleted` rows released (the second column keeps the rest). */
    const holed = (deleted: number): SectionRenderer => {
      const r = make();
      r.stage(fakePayload(0, 0, big(deleted)), 1);
      r.stage(fakePayload(1, 0, big(32 - deleted)), 1);
      pumpAll(r);
      expect(batchOf(r, 0)!.unusedVertexCount).toBe(0);
      r.remove(0, 0);
      expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(deleted);
      return r;
    };
    // Compact first: 3 of 32 rows deleted (12,288 vertices, 9.4 %, under the 10 % share), and a column of 3 rows that fits
    // once compacted → optimize, in place, at the same size; the column shows in the same pump.
    expect(3 * 4096).toBeLessThan(OPTIMIZE_AT * 131_072);
    const c = holed(3);
    const cb = batchOf(c, 0)!;
    const geometry = cb.geometry;
    const ops = counts(c).structuralOps;
    c.stage(fakePayload(2, 0, big(3)), 1);
    expect(c.pump(fakeGate(32), 0, 0, 0)).toBe(3);
    expect(counts(c)).toMatchObject({ lastStructural: 'optimize', lastStructuralBytes: 1_835_008, structuralOps: ops + 1 });
    expect(cb.geometry).toBe(geometry);
    expect(cb.geometry.getAttribute('position').count).toBe(131_072);
    expect(c.isRevealed(2, 0)).toBe(true);
    expect(visibleIndices(c.root)).toBe(32 * 6144);
    c.dispose();

    // Under 10 % and too large to fit once compacted: the same 3 deleted rows and a column of 4 → grow (× 1.25), and the
    // column shows in the same pump.
    const u = holed(3);
    u.stage(fakePayload(2, 0, big(4)), 1);
    u.pump(fakeGate(32), 0, 0, 0);
    expect(counts(u).lastStructural).toBe('grow');
    expect(batchOf(u, 0)!.geometry.getAttribute('position').count).toBe(Math.ceil(131_072 * BATCH_GROWTH));
    expect(u.isRevealed(2, 0)).toBe(true);
    u.dispose();

    // At or above 10 %: 4 of 32 rows deleted (16,384 vertices, 12.5 %), a column of 5 rows (20,480 vertices) that does not
    // fit even compacted → optimize, in place; the growth waits for the next pump.
    expect(4 * 4096).toBeGreaterThanOrEqual(OPTIMIZE_AT * 131_072);
    const o = holed(4);
    const ob = batchOf(o, 0)!;
    const before = ob.geometry;
    const ops0 = counts(o).structuralOps;
    o.stage(fakePayload(2, 0, big(5)), 1);
    expect(o.pump(fakeGate(32), 0, 0, 0)).toBe(4);
    expect(counts(o)).toMatchObject({ lastStructural: 'optimize', lastStructuralBytes: 1_835_008, structuralOps: ops0 + 1 });
    expect(ob.geometry).toBe(before);
    expect(o.isRevealed(2, 0)).toBe(false);
    expect(o.pump(fakeGate(32), 0, 0, 0)).toBe(1);
    expect(counts(o)).toMatchObject({ lastStructural: 'grow', structuralOps: ops0 + 2 });
    expect(o.isRevealed(2, 0)).toBe(true);
    expect(visibleIndices(o.root)).toBe(33 * 6144);
    o.dispose();
  });

  test('three\'s upload (each attribute\'s onUploadCallback) leaves no pending update range on a new batch nor on a grown one\'s new attributes; the next pump culls the batch again (spec §4.1)', () => {
    const attributesOf = (b: BatchedMesh): BufferAttribute[] =>
      [b.geometry.getAttribute('position'), b.geometry.getAttribute('data'), b.geometry.getIndex()!] as BufferAttribute[];
    /** What three's upload does after `bufferData` / `bufferSubData`, as `WebGLAttributes` calls it. */
    const upload = (b: BatchedMesh): void => {
      for (const a of attributesOf(b)) a.onUploadCallback();
    };
    const r = make();
    r.stage(fakePayload(0, 0, big(32)), 1);
    pumpAll(r);
    const b = batchOf(r, 0)!;
    expect(b.frustumCulled).toBe(false);
    expect(attributesOf(b).some((a) => a.updateRanges.length > 0)).toBe(true);
    upload(b);
    for (const a of attributesOf(b)) expect(a.updateRanges).toEqual([]);
    r.pump(fakeGate(32), 0, 0, 0);
    expect(b.frustumCulled).toBe(true);

    // A row that does not fit: the growth replaces the geometry; its new attributes carry the hook too.
    const old = b.geometry;
    r.stage(fakePayload(1, 0, big(1)), 1);
    r.pump(fakeGate(32), 0, 0, 0);
    expect(counts(r).lastStructural).toBe('grow');
    expect(b.geometry).not.toBe(old);
    expect(b.frustumCulled).toBe(false);
    expect(attributesOf(b).some((a) => a.updateRanges.length > 0)).toBe(true);
    upload(b);
    for (const a of attributesOf(b)) expect(a.updateRanges).toEqual([]);
    r.pump(fakeGate(32), 0, 0, 0);
    expect(b.frustumCulled).toBe(true);
    r.dispose();
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

  test('removal releases at most 32 rows per pump in a region that keeps a live column; an emptied region is disposed with 0 rows spent and no per-row deleteGeometry (SP4c spec §5.4, D10)', () => {
    const r = make();
    r.stage(fakePayload(3, 3, rowsOf(48, 22)), 1);
    r.stage(fakePayload(4, 4, [opaque(1)]), 1);
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
    expect(batches(r.root).length).toBeGreaterThan(0);

    // The region's last column: the region goes in one step, its rows never released one by one.
    r.stage(fakePayload(5, 5, rowsOf(40, 0)), 2);
    pumpAll(r);
    r.remove(4, 4);
    r.remove(5, 5);
    deletes.mockClear();
    const dispose = vi.spyOn(BatchedMesh.prototype, 'dispose');
    expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(0);
    expect(deletes).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(batches(r.root)).toHaveLength(0);
    expect(counts(r)).toMatchObject({ regions: 0, rows: 0, columnsRemoving: 0 });
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

  test('the X-ray pass (SP6a spec §5.1, §5.2): a pass-3 batch per region with X-ray rows, over `materials.xray`, of 16,384 vertices and a Uint16 index of 24,576; `sortObjects` off on it and on on the others; its `renderOrder` `XRAY_ORDER`, above every water region\'s and below `GHOST_ORDER`', () => {
    const materials = system('batch');
    const r = make(materials);
    r.stage(fakePayload(0, 0, [opaque(4), { sy: 4, pass: 3, quads: 2 }, water(5), { sy: 5, pass: 3, quads: 1 }]), 1);
    r.stage(fakePayload(9, 0, [opaque(2)]), 1);
    pumpAll(r);
    expect(batches(r.root).map((b) => `${b.userData['rx'] as number}:${b.userData['pass'] as number}`).sort()).toEqual(['0:0', '0:2', '0:3', '1:0']);
    const x = batchOf(r, MESH_PASS_XRAY)!;
    expect(x.material).toBe(materials.xray);
    expect(x.maxInstanceCount).toBe(1536);
    expect(x.geometry.getAttribute('position').count).toBe(16_384);
    expect(x.geometry.getIndex()!.array).toBeInstanceOf(Uint16Array);
    expect(x.geometry.getIndex()!.array.length).toBe(24_576);
    expect(bytesOf(x)).toBe(180_224);
    expect(x.perObjectFrustumCulled).toBe(true);
    expect(x.sortObjects).toBe(false);
    expect(x.renderOrder).toBe(XRAY_ORDER);
    for (const b of batches(r.root)) {
      if (b === x) continue;
      expect(b.sortObjects).toBe(true);
      expect(b.renderOrder).toBe(0);
    }
    expect(XRAY_ORDER).toBeGreaterThan(batchOf(r, 2)!.renderOrder);
    expect(XRAY_ORDER).toBeLessThan(GHOST_ORDER);
    // Both pass-3 rows are instances of the pass-3 batch, shown with the column.
    expect(rowsIn([fakePayload(0, 0, [opaque(4), { sy: 4, pass: 3, quads: 2 }, water(5), { sy: 5, pass: 3, quads: 1 }])], MESH_PASS_XRAY)).toHaveLength(2);
    expect(visibleIndices(x)).toBe(18);
    expect(counts(r)).toMatchObject({ rows: 5, columnsRevealed: 2 });
    r.sortTranslucent(0, 0, 0);
    expect(x.renderOrder).toBe(XRAY_ORDER);
    r.dispose();
  });

  test('while the X-ray is off its batches draw nothing (a zero multi-draw count, no per-instance cull or sort) but stay in the scene, and their rows keep uploading; on, three\'s own `onBeforeRender` lists them (SP6a, Task 48 lever 4c)', () => {
    const r = make();
    r.stage(fakePayload(0, 0, [opaque(4), { sy: 4, pass: 3, quads: 2 }, { sy: 5, pass: 3, quads: 1 }]), 1);
    pumpAll(r);
    const x = batchOf(r, MESH_PASS_XRAY)!;
    const o = batchOf(r, 0)!;
    const camera = new PerspectiveCamera(90, 1, 0.1, 10_000);
    camera.position.set(64, 600, 64);
    camera.lookAt(64, 0, 64);
    camera.updateMatrixWorld();
    r.root.updateMatrixWorld(true);
    const drawCount = (b: BatchedMesh): number => (b as unknown as { _multiDrawCount: number })._multiDrawCount;
    /** What three's `renderObject` calls before drawing the batch. */
    const beforeRender = (b: BatchedMesh): void => {
      b.onBeforeRender(null as never, null as never, camera, b.geometry, b.material as Material, null as never);
    };
    const cull = vi.spyOn(BatchedMesh.prototype, 'onBeforeRender');
    // Off (the page's start): the X-ray batch lists nothing and three's per-instance pass never runs for it.
    beforeRender(x);
    expect(drawCount(x)).toBe(0);
    expect(cull).not.toHaveBeenCalled();
    // The terrain's batch is three's as before.
    beforeRender(o);
    expect(cull).toHaveBeenCalledTimes(1);
    expect(drawCount(o)).toBe(1);
    // Still in the scene, visible, culled per region as the others: three keeps uploading its rows.
    expect(x.parent).toBe(r.root);
    expect(x.visible).toBe(true);
    expect(visibleIndices(x)).toBe(18);
    r.stage(fakePayload(1, 0, [{ sy: 6, pass: 3, quads: 4 }]), 1);
    pumpAll(r);
    expect(visibleIndices(x)).toBe(18 + 24);
    // On: three's onBeforeRender lists the three visible X-ray instances.
    r.setXray(true);
    cull.mockClear();
    beforeRender(x);
    expect(cull).toHaveBeenCalledTimes(1);
    expect(drawCount(x)).toBe(3);
    // Off again: nothing.
    r.setXray(false);
    cull.mockClear();
    beforeRender(x);
    expect(drawCount(x)).toBe(0);
    expect(cull).not.toHaveBeenCalled();
    // A region's X-ray batch created while the X-ray is on lists its rows at once.
    r.setXray(true);
    r.stage(fakePayload(9, 0, [{ sy: 2, pass: 3, quads: 1 }]), 1);
    pumpAll(r);
    const x1 = batchOf(r, MESH_PASS_XRAY, 1, 0)!;
    x1.updateMatrixWorld(true);
    camera.position.set(192, 600, 64);
    camera.lookAt(192, 0, 64);
    camera.updateMatrixWorld();
    beforeRender(x1);
    expect(drawCount(x1)).toBe(1);
    r.dispose();
  });

  test('while the X-ray is on the opaque, cutout and translucent batches draw nothing (a zero multi-draw count after `onBeforeRender`, no per-instance cull or sort) and their rows keep uploading; off, three\'s own `onBeforeRender` lists them (SP6b spec §7.4, D24)', () => {
    const r = make();
    r.stage(fakePayload(0, 0, [opaque(4), { sy: 4, pass: 1, quads: 2 }, water(5), { sy: 4, pass: 3, quads: 2 }]), 1);
    pumpAll(r);
    const terrain = [0, 1, 2].map((pass) => batchOf(r, pass)!);
    const x = batchOf(r, MESH_PASS_XRAY)!;
    const camera = new PerspectiveCamera(90, 1, 0.1, 10_000);
    camera.position.set(64, 600, 64);
    camera.lookAt(64, 0, 64);
    camera.updateMatrixWorld();
    r.root.updateMatrixWorld(true);
    const drawCount = (b: BatchedMesh): number => (b as unknown as { _multiDrawCount: number })._multiDrawCount;
    /** What three's `renderObject` calls before drawing the batch. */
    const beforeRender = (b: BatchedMesh): void => {
      b.onBeforeRender(null as never, null as never, camera, b.geometry, b.material as Material, null as never);
    };
    const cull = vi.spyOn(BatchedMesh.prototype, 'onBeforeRender');
    // Off (the page's start): three's own list, one instance per batch.
    for (const b of terrain) beforeRender(b);
    expect(cull).toHaveBeenCalledTimes(3);
    expect(terrain.map(drawCount)).toEqual([1, 1, 1]);
    // On: nothing listed and three's per-instance pass never runs for them; the X-ray batch is three's.
    r.setXray(true);
    cull.mockClear();
    for (const b of terrain) beforeRender(b);
    expect(cull).not.toHaveBeenCalled();
    expect(terrain.map(drawCount)).toEqual([0, 0, 0]);
    beforeRender(x);
    expect(cull).toHaveBeenCalledTimes(1);
    expect(drawCount(x)).toBe(1);
    // Still in the scene and visible: a column staged while it is on uploads and reveals its rows into them.
    for (const b of terrain) expect([b.parent, b.visible]).toEqual([r.root, true]);
    const before = terrain.map((b) => visibleIndices(b));
    r.stage(fakePayload(1, 0, [opaque(6, 3), { sy: 6, pass: 1, quads: 1 }, water(6, 2)]), 1);
    pumpAll(r);
    expect(r.isRevealed(1, 0)).toBe(true);
    expect(terrain.map((b, k) => visibleIndices(b) - before[k]!)).toEqual([18, 6, 12]);
    cull.mockClear();
    for (const b of terrain) beforeRender(b);
    expect(cull).not.toHaveBeenCalled();
    expect(terrain.map(drawCount)).toEqual([0, 0, 0]);
    // Off: three's own list again, the new rows included.
    r.setXray(false);
    cull.mockClear();
    for (const b of terrain) beforeRender(b);
    expect(cull).toHaveBeenCalledTimes(3);
    expect(terrain.map(drawCount)).toEqual([2, 2, 2]);
    // A batch created while the X-ray is on draws nothing at once.
    r.setXray(true);
    r.stage(fakePayload(9, 0, [opaque(2)]), 1);
    pumpAll(r);
    const o1 = batchOf(r, 0, 1, 0)!;
    cull.mockClear();
    beforeRender(o1);
    expect(cull).not.toHaveBeenCalled();
    expect(drawCount(o1)).toBe(0);
    r.dispose();
  });

  test('a column whose pass-3 rows exceed the pass-3 reservation makes columnNeed ask for \'grow\' (or \'optimize\') before its first row, so the pump takes it as its structural operation', () => {
    const r = make();
    // The region's pass-3 batch exists (one small row), then a column with 5 × 4,096 = 20,480 X-ray vertices.
    r.stage(fakePayload(1, 1, [{ sy: 4, pass: 3, quads: 1 }]), 1);
    pumpAll(r);
    expect(batchOf(r, MESH_PASS_XRAY)!.geometry.getAttribute('position').count).toBe(16_384);
    r.stage(fakePayload(0, 0, big(5, 1024, 3)), 1);
    const gate = fakeGate(32);
    r.pump(gate, 0, 0, 0);
    expect(gate.granted).toBe(1);
    expect(['grow', 'optimize']).toContain(counts(r).lastStructural);
    // One growth holds the column: its use plus the column, 4 + 20,480 = 20,484 vertices (× 1.25 alone, 20,480, is 4 short).
    expect(Math.ceil(16_384 * BATCH_GROWTH)).toBe(20_480);
    expect(batchOf(r, MESH_PASS_XRAY)!.geometry.getAttribute('position').count).toBe(4 + 20_480);
    pumpAll(r);
    expect(r.isRevealed(0, 0)).toBe(true);
    r.dispose();
  });

  test('the materials come from a batch material system', () => {
    expect(() => createSectionRenderer('batch', system('mesh'))).toThrow(/variant/);
    expect(createSectionRenderer('batch', system('batch')).kind).toBe('batch');
  });
});

describe('RegionBatch\'s cave-culling draw filter (SP6b spec §8.3)', () => {
  const listOf = (b: BatchedMesh): BatchDrawList => b as unknown as BatchDrawList;
  /** The batch's listed entries: [start, count, instance] for k < `_multiDrawCount`. */
  const entries = (b: BatchedMesh): Array<[number, number, number]> => {
    const l = listOf(b);
    const out: Array<[number, number, number]> = [];
    for (let k = 0; k < l._multiDrawCount; k++) out.push([l._multiDrawStarts[k]!, l._multiDrawCounts[k]!, l._indirectTexture.image.data[k]!]);
    return out;
  };
  const camera = new PerspectiveCamera(90, 1, 0.1, 10_000);
  camera.position.set(64, 600, 64);
  camera.lookAt(64, 0, 64);
  camera.updateMatrixWorld();
  /** What three's `renderObject` calls before drawing the batch. */
  const beforeRender = (b: BatchedMesh): void => {
    b.onBeforeRender(null as never, null as never, camera, b.geometry, b.material as Material, null as never);
  };
  /** three's own list for the batch, without the filter. */
  const threes = (b: BatchedMesh): Array<[number, number, number]> => {
    BatchedMesh.prototype.onBeforeRender.call(b, null as never, null as never, camera, b.geometry, b.material as Material, null as never);
    return entries(b);
  };
  /** Section `torusSlot(cx, cz)·24 + sy`. */
  const sectionAt = (cx: number, cz: number, sy: number): number => torusSlot(cx, cz) * 24 + sy;
  /** The culler showing walk 5, which stamped exactly `drawn`; every other section was last stamped by walk 0. */
  const showOnly = (r: SectionRenderer, drawn: readonly number[]): void => {
    r.culler.walk.stamp.fill(0);
    for (const s of drawn) r.culler.walk.stamp[s] = 5;
    r.culler.shown = 5;
    r.culler.drawAll = false;
  };
  /** The section of a batch's instance, from its matrix (the section's offset in region (0, 0)). */
  const sectionOfInstance = (b: BatchedMesh, instance: number): number => {
    const p = new Vector3().setFromMatrixPosition(b.getMatrixAt(instance, new Matrix4()));
    return sectionAt(p.x / 16, p.z / 16, p.y / 16);
  };
  /**
   * Two columns of region (0, 0): opaque rows in sections 2, 4, 6 and 2, 4, 9, water rows at 4 and 2, a cutout row at 6;
   * `clock` times the filter (none: untimed).
   */
  const twoColumns = (clock: (() => number) | null = null): SectionRenderer => {
    const r = createSectionRenderer('batch', system('batch'), clock);
    r.stage(fakePayload(0, 0, [opaque(2), opaque(4, 2), water(4), opaque(6), { sy: 6, pass: 1, quads: 1 }]), 1);
    r.stage(fakePayload(1, 0, [opaque(2, 3), water(2), opaque(4), opaque(9)]), 1);
    pumpAll(r);
    r.root.updateMatrixWorld(true);
    return r;
  };

  test('on a fake batch the filter keeps exactly the drawn sections\' entries, in order, compacting starts, counts and the indirect ids in place and setting the count', () => {
    // Six entries listing instances 4, 0, 3, 1, 5, 2 (three's order), each instance in its own section.
    const sectionOf = Int32Array.of(30, 31, 32, 33, 34, 35);
    const list: BatchDrawList = {
      _multiDrawStarts: Int32Array.of(400, 0, 300, 100, 500, 200, 77),
      _multiDrawCounts: Int32Array.of(14, 10, 13, 11, 15, 12, 77),
      _multiDrawCount: 6,
      _indirectTexture: { image: { data: Uint32Array.of(4, 0, 3, 1, 5, 2, 77) } },
    };
    const drawn = new Set([30, 33, 35]);
    const seen: number[] = [];
    cullDrawList(list, sectionOf, {
      drawnAt: (s) => {
        seen.push(s);
        return drawn.has(s);
      },
    });
    expect(list._multiDrawCount).toBe(3);
    expect([...list._multiDrawStarts.subarray(0, 3)]).toEqual([0, 300, 500]);
    expect([...list._multiDrawCounts.subarray(0, 3)]).toEqual([10, 13, 15]);
    expect([...list._indirectTexture.image.data.subarray(0, 3)]).toEqual([0, 3, 5]);
    // Each listed entry asked once, in order; nothing past the count read.
    expect(seen).toEqual([34, 30, 33, 31, 35, 32]);
    // Everything drawn: the list as it was; nothing drawn: an empty one.
    const all: BatchDrawList = {
      _multiDrawStarts: Int32Array.of(5, 6), _multiDrawCounts: Int32Array.of(7, 8), _multiDrawCount: 2,
      _indirectTexture: { image: { data: Uint32Array.of(1, 0) } },
    };
    cullDrawList(all, sectionOf, { drawnAt: () => true });
    expect([all._multiDrawCount, [...all._multiDrawStarts], [...all._multiDrawCounts], [...all._indirectTexture.image.data]]).toEqual([2, [5, 6], [7, 8], [1, 0]]);
    cullDrawList(all, sectionOf, { drawnAt: () => false });
    expect(all._multiDrawCount).toBe(0);
  });

  test('three r186\'s private fields: `_multiDrawStarts`, `_multiDrawCounts`, `_multiDrawCount`, `_indirectTexture` exist on a BatchedMesh (as `xrayBeforeRender` relies on them), re-made by setInstanceCount', () => {
    expect(REVISION).toBe('186');
    const b = new BatchedMesh(16, 3, 3);
    const l = listOf(b);
    expect(l._multiDrawStarts).toBeInstanceOf(Int32Array);
    expect(l._multiDrawCounts).toBeInstanceOf(Int32Array);
    expect(typeof l._multiDrawCount).toBe('number');
    expect(l._indirectTexture.image.data).toBeInstanceOf(Uint32Array);
    for (const a of [l._multiDrawStarts, l._multiDrawCounts, l._indirectTexture.image.data]) expect(a.length).toBeGreaterThanOrEqual(16);
    // Re-made on an instance growth: the filter reads them from the batch on every call, never a kept reference.
    const before = [l._multiDrawStarts, l._multiDrawCounts, l._indirectTexture.image.data];
    b.setInstanceCount(64);
    const after = [l._multiDrawStarts, l._multiDrawCounts, l._indirectTexture.image.data];
    after.forEach((a, i) => {
      expect(a).not.toBe(before[i]);
      expect(a.length).toBeGreaterThanOrEqual(64);
    });
    b.dispose();
  });

  test('passes 0-2 list three\'s own entries filtered by the culler, in three\'s order; with `drawAll` set the list is three\'s own; the X-ray batch is never filtered', () => {
    const r = twoColumns();
    const terrain = [0, 1, 2].map((pass) => batchOf(r, pass)!);
    const own = terrain.map(threes);
    expect(own.map((e) => e.length)).toEqual([6, 1, 2]);
    // Before any walk the culler draws everything (`drawAll`): three's own list.
    expect(r.culler.drawAll).toBe(true);
    terrain.forEach((b, k) => {
      beforeRender(b);
      expect(entries(b)).toEqual(own[k]);
    });
    // Sections (0, 4, 0) and (1, 2, 0) drawn: the opaque, cutout and water entries of those sections only, in order.
    const drawn = [sectionAt(0, 0, 4), sectionAt(1, 0, 2)];
    showOnly(r, drawn);
    terrain.forEach((b, k) => {
      beforeRender(b);
      expect(entries(b)).toEqual(own[k]!.filter(([, , i]) => drawn.includes(sectionOfInstance(b, i))));
    });
    expect(terrain.map((b) => entries(b).length)).toEqual([2, 0, 2]);
    // The X-ray batch's list is three's own whatever the culler holds.
    r.setXray(true);
    r.stage(fakePayload(0, 0, [opaque(2), { sy: 4, pass: 3, quads: 1 }, { sy: 6, pass: 3, quads: 2 }]), 2);
    pumpAll(r);
    const x = batchOf(r, MESH_PASS_XRAY)!;
    x.updateMatrixWorld(true);
    const xOwn = threes(x);
    expect(xOwn).toHaveLength(2);
    showOnly(r, []);
    beforeRender(x);
    expect(entries(x)).toEqual(xOwn);
    r.dispose();
  });

  test('X-ray on: the count stays 0 whatever the culler holds', () => {
    const r = twoColumns();
    const terrain = [0, 1, 2].map((pass) => batchOf(r, pass)!);
    r.setXray(true);
    const cull = vi.spyOn(BatchedMesh.prototype, 'onBeforeRender');
    for (const state of ['drawAll', 'some', 'none'] as const) {
      if (state === 'drawAll') r.culler.drawAll = true;
      else showOnly(r, state === 'some' ? [sectionAt(0, 0, 2), sectionAt(1, 0, 4)] : []);
      for (const b of terrain) beforeRender(b);
      expect(terrain.map((b) => listOf(b)._multiDrawCount), state).toEqual([0, 0, 0]);
    }
    // No per-instance pass and no compaction ran (D24).
    expect(cull).not.toHaveBeenCalled();
    r.dispose();
  });

  test('the frame\'s culled sections (`culledSections`): the entries the filter dropped since the frame\'s `sortTranslucent`, over passes 0-2; the filter\'s main-thread ms on the section renderer\'s clock (`cullFilterMs`, 0 untimed); the X-ray on drops and times nothing (SP6b spec §8.5; rulings P41, P55, P58)', () => {
    // A clock 0.25 ms on at each read: each filter call reads it twice.
    let now = 0;
    const r = twoColumns(() => (now += 0.25));
    const terrain = [0, 1, 2].map((pass) => batchOf(r, pass)!);
    const frame = (): void => {
      r.sortTranslucent(0, 0, 0);
      for (const b of terrain) beforeRender(b);
    };
    // Nothing drawn yet.
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([0, 0]);
    // `drawAll`: three's own 6 + 1 + 2 entries kept, nothing dropped; the three filter calls timed.
    frame();
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([0, 0.75]);
    // Sections (0, 4, 0) and (1, 2, 0) drawn: 2 + 0 + 2 entries kept, 5 dropped, the frame's own (not a running total).
    showOnly(r, [sectionAt(0, 0, 4), sectionAt(1, 0, 2)]);
    frame();
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([5, 0.75]);
    frame();
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([5, 0.75]);
    // The next frame's `sortTranslucent` starts its count: read before the batches are drawn, 0.
    r.sortTranslucent(0, 0, 0);
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([0, 0]);
    // Two batches drawn this frame (three culled the cutout one): their drops only, the opaque batch's 4 and the water's 0.
    beforeRender(terrain[0]!);
    beforeRender(terrain[2]!);
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([4, 0.5]);
    // X-ray on: the terrain batches draw nothing and filter nothing.
    r.setXray(true);
    frame();
    expect([r.culledSections(), r.cullFilterMs()]).toEqual([0, 0]);
    r.setXray(false);
    frame();
    expect(r.culledSections()).toBe(5);
    r.dispose();
    // Untimed (no clock): the count still, 0 ms.
    const u = twoColumns();
    showOnly(u, [sectionAt(0, 0, 4), sectionAt(1, 0, 2)]);
    u.sortTranslucent(0, 0, 0);
    for (const pass of [0, 1, 2]) beforeRender(batchOf(u, pass)!);
    expect([u.culledSections(), u.cullFilterMs()]).toEqual([5, 0]);
    u.dispose();
  });

  test('10,000 frames of the filter with its count and its clock grow the heap by less than 256 KB (no allocation per frame; ruling P55)', () => {
    // Pre-boxed timestamps (a tagged array, never doubles): the clock itself allocates nothing.
    const times: unknown[] = new Array(200_000);
    times[0] = {};
    for (let i = 0; i < times.length; i++) times[i] = 0.5 + i / 64;
    let k = 0;
    const r = twoColumns(() => (times as number[])[k++ % times.length]!);
    const terrain = [0, 1, 2].map((pass) => batchOf(r, pass)!);
    showOnly(r, [sectionAt(0, 0, 4), sectionAt(1, 0, 2)]);
    // three's own list, recorded once per batch and replayed into its arrays: three builds it with a sort and a render
    // list that allocate (as the zero-allocation fixture does), so the filter is measured on its own.
    const own = BatchedMesh.prototype.onBeforeRender;
    const recorded = new Map<BatchedMesh, { starts: Int32Array; counts: Int32Array; ids: Uint32Array; n: number }>();
    for (const b of terrain) {
      own.call(b, null as never, null as never, camera, b.geometry, b.material as Material, null as never);
      const l = listOf(b);
      recorded.set(b, { starts: l._multiDrawStarts.slice(), counts: l._multiDrawCounts.slice(), ids: l._indirectTexture.image.data.slice(), n: l._multiDrawCount });
    }
    BatchedMesh.prototype.onBeforeRender = function (this: BatchedMesh) {
      const rec = recorded.get(this)!;
      const l = listOf(this);
      l._multiDrawStarts.set(rec.starts);
      l._multiDrawCounts.set(rec.counts);
      l._indirectTexture.image.data.set(rec.ids);
      l._multiDrawCount = rec.n;
    };
    const frame = (): void => {
      r.sortTranslucent(0.5, 100.5, 0.5);
      for (let i = 0; i < terrain.length; i++) beforeRender(terrain[i]!);
    };
    try {
      for (let i = 0; i < 20_000; i++) frame();
      expect(r.culledSections()).toBe(5);
      expect(r.cullFilterMs()).toBeGreaterThan(0);
      v8.setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
      const heapUsed = (): number => {
        let b = 0;
        for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) b += s.space_used_size;
        return b;
      };
      const readings: number[] = [];
      for (let t = 0; t < 3; t++) {
        gc();
        gc();
        const before = heapUsed();
        const profiler = new v8.GCProfiler();
        profiler.start();
        for (let i = 0; i < 10_000; i++) frame();
        const after = heapUsed();
        const gcs = profiler.stop()?.statistics.length ?? 0;
        if (gcs > 0) continue;
        readings.push(after - before);
        if (after - before < 256 * 1024) break;
      }
      expect(readings.length, 'every attempt saw a GC').toBeGreaterThan(0);
      expect(readings[readings.length - 1]!, `heap growth over 10,000 frames (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
    } finally {
      BatchedMesh.prototype.onBeforeRender = own;
      r.dispose();
    }
  });

  test('the reveal state (`setVisibleAt`) is untouched by the filter, so R7\'s probe reads the same; an instance id past the first table (after `setInstanceCount`) is filtered by its own section', () => {
    const r = twoColumns();
    const terrain = [0, 1, 2].map((pass) => batchOf(r, pass)!);
    const visibility = (): boolean[][] => terrain.map((b) => {
      const info = (b as unknown as { _instanceInfo: Array<{ active: boolean }> })._instanceInfo;
      return info.map((_, i) => info[i]!.active && b.getVisibleAt(i));
    });
    const shown = visibility();
    const probe = r.probe(createRevealProbe());
    const setVisible = vi.spyOn(BatchedMesh.prototype, 'setVisibleAt');
    showOnly(r, [sectionAt(1, 0, 9)]);
    for (const b of terrain) beforeRender(b);
    expect(terrain.map((b) => listOf(b)._multiDrawCount)).toEqual([1, 0, 0]);
    expect(setVisible).not.toHaveBeenCalled();
    expect(visibility()).toEqual(shown);
    expect(r.probe(createRevealProbe())).toEqual(probe);
    expect(counts(r).columnsRevealed).toBe(2);
    r.dispose();

    // 1,537 opaque rows in one column: the 1,537th instance (id 1,536) waits for the growth of the instance table, and
    // the section table grows with it.
    const g = make();
    g.stage(fakePayload(0, 0, big(1537, 1)), 1);
    pumpAll(g);
    const b = batchOf(g, 0)!;
    expect(b.maxInstanceCount).toBe(2304);
    g.root.updateMatrixWorld(true);
    expect(threes(b)).toHaveLength(1537);
    // Row k sits at sy k % 24 and is instance k: keeping section 0 keeps instances 0, 24, …, 1,536.
    showOnly(g, [sectionAt(0, 0, 0)]);
    beforeRender(b);
    expect(entries(b).map(([, , i]) => i).sort((a, c) => a - c)).toEqual(Array.from({ length: 65 }, (_, k) => 24 * k));
    g.dispose();
  });
});

describe('RegionBatch\'s swap (SP4c spec §5.2, D9)', () => {
  /** The batch's active visible instances, each with its geometry id. */
  const shownInstances = (b: BatchedMesh): Array<[instance: number, geometry: number]> => {
    const info = (b as unknown as { _instanceInfo: Array<{ active: boolean }> })._instanceInfo;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < info.length; i++) if (info[i]!.active && b.getVisibleAt(i)) out.push([i, b.getGeometryIdAt(i)]);
    return out;
  };

  test('an optimize() during a swap keeps prev\'s rows visible and their ids valid', () => {
    // 13 of 32 rows deleted (40.6 %, over the 10 % share): the replacement's 14 rows of 4,096 vertices do not fit, so the
    // batch is optimised (13 rows then fit) and grown in the next pump for the last one, both while the shown 19 rows are
    // prev.
    const r = make();
    r.stage(fakePayload(0, 0, big(13)), 1);
    r.stage(fakePayload(1, 0, big(19)), 1);
    pumpAll(r);
    r.remove(0, 0);
    expect(r.pump(fakeGate(32), 1, 0, 0)).toBe(13);
    const b = batchOf(r, 0)!;
    const before = shownInstances(b);
    expect(before).toHaveLength(19);
    const optimize = vi.spyOn(BatchedMesh.prototype, 'optimize');
    r.stage(fakePayload(1, 0, big(14)), 2);
    expect(r.pump(fakeGate(32), 1, 0, 0)).toBe(13);
    expect(optimize).toHaveBeenCalledTimes(1);
    expect(counts(r).lastStructural).toBe('optimize');
    expect(r.isRevealed(1, 0)).toBe(true);
    // prev's rows: the same instances, visible, over the same geometry ids, whose ranges optimize() moved consistently.
    expect(shownInstances(b)).toEqual(before);
    expect(visibleIndices(r.root)).toBe(19 * 6144);
    const index = b.geometry.getIndex()!.array;
    for (const [, id] of before) {
      const range = b.getGeometryRangeAt(id)!;
      expect(range.indexCount).toBe(6144);
      expect(range.vertexCount).toBe(4096);
      let inside = 0;
      for (let k = range.indexStart; k < range.indexStart + range.indexCount; k++) {
        if (index[k]! >= range.vertexStart && index[k]! < range.vertexStart + range.vertexCount) inside++;
      }
      expect(inside).toBe(6144);
    }
    // The last row waits for the growth; then the swap, and prev's rows are released by those very ids.
    expect(r.pump(fakeGate(32), 1, 0, 0)).toBe(1);
    expect(counts(r).lastStructural).toBe('grow');
    expect(visibleIndices(r.root)).toBe(14 * 6144);
    pumpAll(r, 1, 0);
    expect(counts(r)).toMatchObject({ columnsRemoving: 0, rows: 14 });
    expect(shownInstances(b)).toHaveLength(14);
    expect(visibleIndices(r.root)).toBe(14 * 6144);
    r.dispose();
  });

  test('the swap sets visibility in one pass (no frame shows neither)', () => {
    const r = make();
    const old = fakePayload(3, 3, rowsOf(8, 3));
    r.stage(old, 1);
    pumpAll(r, 3, 3);
    const visibility = vi.spyOn(BatchedMesh.prototype, 'setVisibleAt');
    const next = fakePayload(3, 3, rowsOf(10, 2, 2));
    r.stage(next, 2);
    const shownPerPump: number[] = [];
    const callsPerPump: Array<Array<[number, boolean]>> = [];
    for (let i = 0; i < 6; i++) {
      visibility.mockClear();
      r.pump(fakeGate(4), 3, 3, 0);
      callsPerPump.push(visibility.mock.calls.map(([instance, on]) => [instance, on]));
      shownPerPump.push(visibleIndices(r.root));
    }
    // 12 rows at four a pump: hidden uploads in pumps 0-2, the swap in pump 2; never a pump that shows neither payload.
    expect(shownPerPump).toEqual([indexSum([old]), indexSum([old]), indexSum([next]), indexSum([next]), indexSum([next]), indexSum([next])]);
    const shows = callsPerPump.map((calls) => calls.filter(([, on]) => on).length);
    expect(shows).toEqual([0, 0, 12, 0, 0, 0]);
    // In the swap's pump, after the last upload's hidden writes: prev's 11 rows hidden and the 12 new ones shown, one
    // pass with no other call between them.
    const swapCalls = callsPerPump[2]!;
    expect(swapCalls).toHaveLength(4 + 11 + 12);
    const tail = swapCalls.slice(4);
    expect(tail.filter(([, on]) => !on)).toHaveLength(11);
    expect(tail.filter(([, on]) => on)).toHaveLength(12);
    r.dispose();
  });
});

describe('RegionBatch\'s idle shrink (SP6a spec §5.1, Task 48)', () => {
  /** Three's render for every batch: it uploads the pending ranges (`WebGLAttributes` clears them, then calls the hook). */
  const uploadAll = (r: SectionRenderer): void => {
    for (const b of batches(r.root)) {
      for (const a of [b.geometry.getAttribute('position'), b.geometry.getAttribute('data'), b.geometry.getIndex()!] as BufferAttribute[]) {
        a.clearUpdateRanges();
        a.onUploadCallback();
      }
    }
  };
  /** `n` rendered frames, each an upload then a pump under `gate()`; the structural operation each pump reports. */
  const idle = (r: SectionRenderer, n: number, gate = () => fakeGate(32)): Array<string | null> => {
    const kinds: Array<string | null> = [];
    for (let i = 0; i < n; i++) {
      uploadAll(r);
      r.pump(gate(), 0, 0, 0);
      kinds.push(counts(r).lastStructural);
    }
    return kinds;
  };
  const none = (kinds: ReadonlyArray<string | null>): boolean => kinds.every((k) => k === null);
  /**
   * Region (0, 0): 10 rows, then 30 rows of 4,096 vertices, which grow the batch once to 163,840 vertices; the 10 rows
   * released, leaving 122,880 vertices (25 % of the batch is slack, the released rows a hole at its start). The release's
   * pump is the batch's last write.
   */
  const grownThenHoled = (): SectionRenderer => {
    const r = make();
    r.stage(fakePayload(0, 0, big(10)), 1);
    r.stage(fakePayload(1, 0, big(30)), 1);
    pumpAll(r);
    expect(batchOf(r, 0)!.geometry.getAttribute('position').count).toBe(Math.ceil(131_072 * BATCH_GROWTH));
    uploadAll(r);
    r.remove(0, 0);
    expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(10);
    return r;
  };
  const shownInstances = (b: BatchedMesh): Array<[instance: number, geometry: number]> => {
    const info = (b as unknown as { _instanceInfo: Array<{ active: boolean }> })._instanceInfo;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < info.length; i++) if (info[i]!.active && b.getVisibleAt(i)) out.push([i, b.getGeometryIdAt(i)]);
    return out;
  };

  test('a batch above its reservation with ≥ 20 % slack, idle for 240 pumps, is compacted and shrunk to its use × 1.1 as the pump\'s one structural operation; its rows keep showing over the same ids, and it shrinks once', () => {
    expect([SHRINK_IDLE_PUMPS, SHRINK_MIN_SLACK, SHRINK_HEADROOM]).toEqual([240, 0.2, 1.1]);
    const r = grownThenHoled();
    const b = batchOf(r, 0)!;
    const shown = shownInstances(b);
    expect(shown).toHaveLength(30);
    const ops = counts(r).structuralOps;
    expect(none(idle(r, SHRINK_IDLE_PUMPS - 1))).toBe(true);
    expect(idle(r, 1)).toEqual(['shrink']);
    const vertices = Math.ceil(30 * 4096 * SHRINK_HEADROOM);
    const indices = Math.ceil(30 * 6144 * SHRINK_HEADROOM);
    // 184,320 × 1.1 is 202,752.00000000003 in doubles: the ceiling is one index above.
    expect([vertices, indices]).toEqual([135_168, 202_753]);
    expect(counts(r)).toMatchObject({ structuralOps: ops + 1, lastStructuralBytes: 8 * vertices + 4 * indices });
    expect(r.gpuBytes()).toBe(8 * vertices + 4 * indices);
    expect(b.geometry.getAttribute('position').count).toBe(vertices);
    expect(b.geometry.getIndex()!.array.length).toBe(indices);
    // Compacted first: the hole is gone, the rows start at 0.
    expect(b.unusedVertexCount).toBe(vertices - 30 * 4096);
    expect(b.unusedIndexCount).toBe(indices - 30 * 6144);
    expect(shownInstances(b)).toEqual(shown);
    expect(visibleIndices(r.root)).toBe(30 * 6144);
    expect(r.isRevealed(1, 0)).toBe(true);
    const index = b.geometry.getIndex()!.array;
    for (const [, id] of shown) {
      const range = b.getGeometryRangeAt(id)!;
      let inside = 0;
      for (let k = range.indexStart; k < range.indexStart + range.indexCount; k++) {
        if (index[k]! >= range.vertexStart && index[k]! < range.vertexStart + range.vertexCount) inside++;
      }
      expect(inside).toBe(6144);
    }
    // The new buffers are uploaded whole: the batch is drawn unculled until three has uploaded them.
    expect(b.frustumCulled).toBe(false);
    // 9 % slack now: no second shrink.
    expect(none(idle(r, 3 * SHRINK_IDLE_PUMPS))).toBe(true);
    expect(b.frustumCulled).toBe(true);
    r.dispose();
  });

  test('no shrink at or under the reservation or under 20 % slack; a write restarts the idle count', () => {
    // At the reservation (10 + 10 rows, 10 released: half the batch is slack, but 131,072 is the floor).
    const a = make();
    a.stage(fakePayload(0, 0, big(10)), 1);
    a.stage(fakePayload(1, 0, big(10)), 1);
    pumpAll(a);
    a.remove(0, 0);
    a.pump(fakeGate(32), 0, 0, 0);
    expect(none(idle(a, 2 * SHRINK_IDLE_PUMPS))).toBe(true);
    expect(batchOf(a, 0)!.geometry.getAttribute('position').count).toBe(131_072);
    a.dispose();

    // Grown, with 17.5 % slack (33 rows, 135,168 vertices, in 163,840).
    const s = make();
    s.stage(fakePayload(0, 0, big(32)), 1);
    pumpAll(s);
    s.stage(fakePayload(1, 0, big(1)), 1);
    pumpAll(s);
    expect(1 - (33 * 4096) / Math.ceil(131_072 * BATCH_GROWTH)).toBeLessThan(SHRINK_MIN_SLACK);
    expect(none(idle(s, 2 * SHRINK_IDLE_PUMPS))).toBe(true);
    expect(batchOf(s, 0)!.geometry.getAttribute('position').count).toBe(163_840);
    s.dispose();

    // A row uploaded into the idle batch 200 pumps on: the shrink comes 240 pumps after that write.
    const w = grownThenHoled();
    expect(none(idle(w, 200))).toBe(true);
    w.stage(fakePayload(2, 0, [opaque(0)]), 1);
    uploadAll(w);
    expect(w.pump(fakeGate(32), 0, 0, 0)).toBe(1);
    expect(none(idle(w, SHRINK_IDLE_PUMPS - 1))).toBe(true);
    expect(idle(w, 1)).toEqual(['shrink']);
    w.dispose();
  });

  test('a staged column\'s structural operation takes the slot first, and a pump with no structural grant shrinks nothing', () => {
    const r = grownThenHoled();
    expect(none(idle(r, SHRINK_IDLE_PUMPS - 1))).toBe(true);
    expect(idle(r, 1, () => fakeGate(32, 0))).toEqual([null]);
    // A new region's column needs 'create': it takes the frame's operation; the shrink follows in the next pump.
    r.stage(fakePayload(16, 0, [opaque(0)]), 1);
    expect(idle(r, 1)).toEqual(['create']);
    expect(r.isRevealed(16, 0)).toBe(true);
    expect(idle(r, 1)).toEqual(['shrink']);
    expect(batchOf(r, 0)!.geometry.getAttribute('position').count).toBe(Math.ceil(30 * 4096 * SHRINK_HEADROOM));
    r.dispose();
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

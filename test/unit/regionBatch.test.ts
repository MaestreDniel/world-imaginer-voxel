import {
  BatchedMesh, Matrix4, Quaternion, Vector3, type Box3, type BufferAttribute, type BufferGeometry, type Object3D, type Sphere,
} from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MESH_PASS_XRAY, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { BATCH_GROWTH, OPTIMIZE_AT, SHRINK_HEADROOM, SHRINK_IDLE_PUMPS, SHRINK_MIN_SLACK } from '../../src/render/regionBatch';
import {
  createSectionRenderer, createSectionRendererCounts, regionOf, selectSectionRenderer, type SectionRenderer,
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
    // One growth × 1.25 holds the column: 20,480 vertices.
    expect(batchOf(r, MESH_PASS_XRAY)!.geometry.getAttribute('position').count).toBe(Math.ceil(16_384 * BATCH_GROWTH));
    pumpAll(r);
    expect(r.isRevealed(0, 0)).toBe(true);
    r.dispose();
  });

  test('the materials come from a batch material system', () => {
    expect(() => createSectionRenderer('batch', system('mesh'))).toThrow(/variant/);
    expect(createSectionRenderer('batch', system('batch')).kind).toBe('batch');
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

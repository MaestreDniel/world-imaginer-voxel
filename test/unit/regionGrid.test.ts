import { readFileSync } from 'node:fs';
import { Box3, Group, Sphere, type BatchedMesh, type Material, type Mesh, type Object3D } from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, MESH_PASS_XRAY, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem, type MaterialVariant } from '../../src/render/materials/index';
import { BATCH_GROWTH } from '../../src/render/regionBatch';
import {
  createStreamingRenderer, EMPTIED_PER_PUMP, GROWTH, RELEASE_SHARE, RESERVATION, rowBounds, rowsOfPass, type PayloadRow,
  type RegionBackend, type StagedColumn,
} from '../../src/render/regionGrid';
import {
  createRevealProbe, createSectionRenderer, createSectionRendererCounts, type SectionRenderer,
} from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload } from './fixtures/payloads';
import { fakeGate, pumpAll, regionObjects, visibleIndices } from './sectionRendererContract';

const ALBEDO = createFlatColorArray();

/** Region (0, 0): rows of every pass, interleaved, so a pass's rows are not contiguous in a payload. */
const payloads = (): ColumnMeshPayload[] => [
  fakePayload(0, 0, [{ sy: 4, pass: 0, quads: 3 }, { sy: 5, pass: 2, quads: 2 }, { sy: 6, pass: 0, quads: 1 }]),
  fakePayload(1, 3, [{ sy: 2, pass: 1, quads: 4 }]),
  fakePayload(7, 7, [{ sy: 23, pass: 2, quads: 1 }, { sy: 0, pass: 0, quads: 5 }, { sy: 9, pass: 1, quads: 2 }]),
];

/**
 * Stages `ps` (one region) in a renderer of `kind` and uploads them all from the camera at (0, 0), yaw 0: for these
 * payloads, nearest-first is payload order.
 */
function built(kind: MaterialVariant, ps: readonly ColumnMeshPayload[]): SectionRenderer {
  const r = createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO));
  for (const p of ps) r.stage(p, 1);
  pumpAll(r);
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

/**
 * A recording `RegionBackend`: every call logged by the record's seq, the drawn rows kept as a set of `seq:row`; no
 * structural operation is ever needed.
 */
function recordingBackend(): { backend: RegionBackend<null>; log: string[]; visible: Set<string> } {
  const log: string[] = [];
  const visible = new Set<string>();
  const show = (c: StagedColumn<null>, on: boolean): void => {
    for (let r = c.released; r < c.uploaded; r++) {
      if (c.ids[2 * r]! < 0) continue;
      if (on) visible.add(`${c.seq}:${r}`);
      else visible.delete(`${c.seq}:${r}`);
    }
  };
  const backend: RegionBackend<null> = {
    newRegion: () => null,
    columnNeed: () => null,
    rowNeed: () => null,
    structural: () => 0,
    upload(c, r) {
      c.ids[2 * r] = r;
      log.push(`upload ${c.seq}:${r}`);
    },
    reveal(c) {
      show(c, true);
      log.push(`reveal ${c.seq}`);
    },
    hide(c) {
      show(c, false);
      log.push(`hide ${c.seq}`);
    },
    swap(prev, next) {
      expect(prev.prev).toBeNull();
      show(prev, false);
      show(next, true);
      log.push(`swap ${prev.seq}→${next.seq}`);
    },
    release(c, r) {
      c.ids[2 * r] = -1;
      log.push(`release ${c.seq}:${r}`);
    },
    rowVisible: (c, r) => visible.has(`${c.seq}:${r}`),
    settle() {},
    disposeRegion: (g) => { log.push(`dispose ${g.rx},${g.rz}`); },
    hasPass: () => false,
    standIn() {
      throw new Error('no stand-in');
    },
    setOrigin() {},
    sortTranslucent() {},
    gpuBytes: () => 0,
  };
  return { backend, log, visible };
}

describe('regionGrid: the staging\'s swap over the backend (SP4c spec §5.1, D9)', () => {
  const ROWS2 = [{ sy: 1, pass: 0 as const, quads: 1 }, { sy: 2, pass: 0 as const, quads: 1 }];
  const ROWS3 = [...ROWS2, { sy: 3, pass: 2 as const, quads: 1 }];

  test('stage on a revealed column keeps the shown record as the replacement\'s prev; the pump that uploads its last row calls swap(prev, next) once, never hide or reveal; prev\'s rows are then released', () => {
    const { backend, log, visible } = recordingBackend();
    const r = createStreamingRenderer('batch', new Group(), backend);
    r.stage(fakePayload(1, 1, ROWS2), 1);
    pumpAll(r);
    expect(log).toEqual(['upload 1:0', 'upload 1:1', 'reveal 1']);
    log.length = 0;
    const revealed: string[] = [];
    r.onColumnRevealed = (cx, cz) => revealed.push(`${cx},${cz}`);
    r.stage(fakePayload(1, 1, ROWS3), 2);
    expect(log).toEqual([]);
    expect(r.counts(createSectionRendererCounts())).toMatchObject({ columnsStaged: 1, columnsRevealed: 1, columnsRemoving: 0 });
    r.pump(fakeGate(2), 1, 1, 0);
    expect(log).toEqual(['upload 2:0', 'upload 2:1']);
    expect([...visible].sort()).toEqual(['1:0', '1:1']);
    r.pump(fakeGate(2), 1, 1, 0);
    expect(log.slice(2)).toEqual(['upload 2:2', 'swap 1→2']);
    expect([...visible].sort()).toEqual(['2:0', '2:1', '2:2']);
    expect(revealed).toEqual(['1,1']);
    expect(r.counts(createSectionRendererCounts())).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 1 });
    r.pump(fakeGate(2), 1, 1, 0);
    expect(log.slice(4)).toEqual(['release 1:0', 'release 1:1']);
    expect(r.counts(createSectionRendererCounts())).toMatchObject({ columnsRemoving: 0, rows: 3 });
    expect(r.probe(createRevealProbe())).toEqual({ columns: 1, partial: 0, mixed: 0 });
    expect(revealed).toEqual(['1,1']);
  });

  test('unstage hides and releases the pending record, calls neither swap nor reveal, and prev is the live record again; a later stage swaps from it', () => {
    const { backend, log, visible } = recordingBackend();
    const r = createStreamingRenderer('batch', new Group(), backend);
    r.stage(fakePayload(1, 1, ROWS2), 1);
    pumpAll(r);
    r.stage(fakePayload(1, 1, ROWS3), 2);
    r.pump(fakeGate(1), 1, 1, 0);
    log.length = 0;
    expect(r.unstage(1, 1)).toBe(true);
    expect(log).toEqual(['hide 2']);
    expect(r.unstage(1, 1)).toBe(false);
    pumpAll(r);
    expect(log).toEqual(['hide 2', 'release 2:0']);
    expect([...visible].sort()).toEqual(['1:0', '1:1']);
    expect(r.counts(createSectionRendererCounts())).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 0, rows: 2 });
    log.length = 0;
    r.stage(fakePayload(1, 1, [{ sy: 9, pass: 0, quads: 2 }]), 3);
    pumpAll(r);
    expect(log).toEqual(['upload 3:0', 'swap 1→3', 'release 1:0', 'release 1:1']);
  });

  test('a replacement with no non-empty row calls swap(prev, next) in the stage call; remove during a swap hides both', () => {
    const { backend, log } = recordingBackend();
    const r = createStreamingRenderer('batch', new Group(), backend);
    const revealed: string[] = [];
    r.onColumnRevealed = (cx, cz) => revealed.push(`${cx},${cz}`);
    r.stage(fakePayload(1, 1, ROWS2), 1);
    pumpAll(r);
    log.length = 0;
    r.stage(fakePayload(1, 1, []), 2);
    expect(log).toEqual(['swap 1→2']);
    expect(revealed).toEqual(['1,1', '1,1']);
    pumpAll(r);
    expect(log).toEqual(['swap 1→2', 'release 1:0', 'release 1:1']);

    r.stage(fakePayload(1, 1, ROWS3), 3);
    r.pump(fakeGate(1), 1, 1, 0);
    log.length = 0;
    r.remove(1, 1);
    expect(log).toEqual(['hide 2', 'hide 3']);
    expect(r.isRevealed(1, 1)).toBe(false);
    pumpAll(r);
    // The region emptied: disposed with the pending rows purged, never released one by one (SP4c spec §5.4).
    expect(log).toEqual(['hide 2', 'hide 3', 'dispose 0,0']);
  });
});

describe('regionGrid: the pump\'s order (SP4c spec §5.4, D10)', () => {
  test('EMPTIED_PER_PUMP is 8 and RELEASE_SHARE 16 (half the 32-row cap)', () => {
    expect(EMPTIED_PER_PUMP).toBe(8);
    expect(RELEASE_SHARE).toBe(16);
  });

  test('R7\'s Apply metric bounds a pump\'s releases by RELEASE_SHARE itself, imported, not a copy of its value (final review REN-1)', () => {
    const src = readFileSync(new URL('../metrics/apply.metric.ts', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.startsWith('import ') && l.includes('/src/render/regionGrid'));
    expect(line).toMatch(/\{ RELEASE_SHARE \}/);
    expect(src).toContain('.toBeLessThanOrEqual(RELEASE_SHARE)');
    expect(src).not.toMatch(/RELEASE_ROWS_MAX/);
  });

  test('after a far jump that removes 489 shown columns of 14 rows, the first new column\'s rows upload in the first pump that has them', () => {
    const { backend, log } = recordingBackend();
    // No release ever touches a disposed region.
    const disposed = new Set<unknown>();
    const watched: RegionBackend<null> = {
      ...backend,
      disposeRegion(g) {
        disposed.add(g);
        backend.disposeRegion(g);
      },
      release(c, row) {
        expect(disposed.has(c.region), `release ${c.seq}:${row} of (${c.cx}, ${c.cz}) after its region was disposed`).toBe(false);
        backend.release(c, row);
      },
    };
    const r = createStreamingRenderer('batch', new Group(), watched);
    const rows14 = Array.from({ length: 14 }, (_, sy) => ({ sy, pass: 0 as const, quads: 1 }));
    // The 489 columns nearest (0, 0): RD 12's disc.
    const disc: Array<[number, number]> = [];
    for (let x = -13; x <= 13; x++) for (let z = -13; z <= 13; z++) disc.push([x, z]);
    disc.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || a[0] - b[0] || a[1] - b[1]);
    disc.length = 489;
    for (const [x, z] of disc) r.stage(fakePayload(x, z, rows14), 1);
    pumpAll(r);
    expect(r.counts(createSectionRendererCounts())).toMatchObject({ columnsRevealed: 489, rows: 489 * 14 });
    for (const [x, z] of disc) r.remove(x, z);
    log.length = 0;
    // The new place, 640 columns east.
    r.stage(fakePayload(640, 0, rows14), 2);
    const gate = fakeGate(32);
    expect(r.pump(gate, 640, 0, 90)).toBeLessThanOrEqual(32);
    expect(r.isRevealed(640, 0)).toBe(true);
    expect(log.filter((l) => l.startsWith('upload 2:'))).toHaveLength(14);
    expect(log.filter((l) => l.startsWith('release ')).length).toBeLessThanOrEqual(RELEASE_SHARE);
    expect(log.filter((l) => l.startsWith('dispose ')).length).toBe(EMPTIED_PER_PUMP);
    // The old place goes in the following pumps: its 15 regions (x and z in −2 … 1, but for (−2, −2), whose nearest
    // column (−9, −9) lies outside the disc) disposed.
    pumpAll(r, 640, 0, 90);
    expect(r.counts(createSectionRendererCounts())).toMatchObject({ columnsRemoving: 0, rows: 14, regions: 1 });
    expect(disposed.size).toBe(15);
  });
});

describe('regionGrid: the X-ray pass in the staging, the swap and the stand-ins (SP6a spec §5.1, §5.2, §5.4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('the pass-3 reservation is 16,384 vertices and 24,576 indices, the other passes\' unchanged', () => {
    expect(RESERVATION[MESH_PASS_XRAY]).toEqual([16_384, 24_576]);
    expect([RESERVATION[MESH_PASS_OPAQUE], RESERVATION[MESH_PASS_CUTOUT], RESERVATION[MESH_PASS_TRANSLUCENT]])
      .toEqual([[131_072, 196_608], [8192, 12_288], [16_384, 24_576]]);
  });

  test('over the recording backend, a replacement with rows in passes 0-3 swaps them all in one swap call, in the pump that uploads its last row', () => {
    const { backend, log, visible } = recordingBackend();
    const r = createStreamingRenderer('batch', new Group(), backend);
    const four = (sy: number) => [0, 1, 2, 3].map((pass) => ({ sy, pass: pass as 0 | 1 | 2 | 3, quads: 1 }));
    r.stage(fakePayload(1, 1, four(4)), 1);
    pumpAll(r);
    log.length = 0;
    r.stage(fakePayload(1, 1, four(5)), 2);
    r.pump(fakeGate(3), 1, 1, 0);
    expect(log).toEqual(['upload 2:0', 'upload 2:1', 'upload 2:2']);
    expect([...visible].sort()).toEqual(['1:0', '1:1', '1:2', '1:3']);
    r.pump(fakeGate(3), 1, 1, 0);
    expect(log.slice(3)).toEqual(['upload 2:3', 'swap 1→2']);
    expect([...visible].sort()).toEqual(['2:0', '2:1', '2:2', '2:3']);
  });

  /** The indices three would draw per pass under `root` (`visibleIndices` per region object). */
  const byPass = (root: Object3D): number[] => {
    const out = [0, 0, 0, 0];
    for (const m of regionObjects(root)) out[m.userData['pass'] as number]! += visibleIndices(m);
    return out;
  };

  for (const kind of ['batch', 'mesh'] as const) {
    test(`${kind}: a revealed column staged again with rows in passes 0-3: until its last row uploads prev's four passes show and the new ones are hidden; the pump that uploads the last swaps all four passes in one call; a replacement with no pass-3 row hides prev's pass-3 rows in that swap; setXray(true) and setXrayBand(−40, −9) between the two pumps change uniforms only (no stage, unstage or remove; the staged count unchanged) (Review Focus 1)`, () => {
      const materials = createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO);
      const r = createSectionRenderer(kind, materials);
      const counts = () => r.counts(createSectionRendererCounts());
      const OLD = [{ sy: 4, pass: 0 as const, quads: 2 }, { sy: 4, pass: 1 as const, quads: 1 }, { sy: 4, pass: 2 as const, quads: 1 }, { sy: 4, pass: 3 as const, quads: 3 }];
      const NEXT = [{ sy: 5, pass: 0 as const, quads: 1 }, { sy: 5, pass: 1 as const, quads: 2 }, { sy: 5, pass: 2 as const, quads: 2 }, { sy: 5, pass: 3 as const, quads: 1 }];
      r.stage(fakePayload(1, 1, OLD), 1);
      pumpAll(r, 1, 1);
      expect(byPass(r.root)).toEqual([12, 6, 6, 18]);
      // Every pass's object exists now; the replacement needs no structural operation.
      r.stage(fakePayload(1, 1, NEXT), 2);
      r.pump(fakeGate(3), 1, 1, 0);
      expect(counts()).toMatchObject({ columnsStaged: 1, columnsComplete: 0, columnsRevealed: 1, rows: 4 + 3 });
      expect(byPass(r.root), 'prev\'s four passes show, the new rows are hidden').toEqual([12, 6, 6, 18]);
      expect(r.isRevealed(1, 1)).toBe(true);

      const stage = vi.spyOn(r, 'stage');
      const unstage = vi.spyOn(r, 'unstage');
      const remove = vi.spyOn(r, 'remove');
      const staged = counts().columnsStaged;
      const xrayOn = (materials.xray.uniforms['xrayOn'] as { value: number });
      materials.setXray(true, -64, 319, 336);
      materials.setXray(true, -40, -9, 336);
      expect(xrayOn.value).toBe(1);
      expect([materials.xray.uniforms['xrayYMin']!.value, materials.xray.uniforms['xrayYMax']!.value]).toEqual([-40, -9]);
      expect([stage, unstage, remove].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
      expect(counts().columnsStaged).toBe(staged);
      expect(byPass(r.root)).toEqual([12, 6, 6, 18]);

      r.pump(fakeGate(3), 1, 1, 0);
      expect(byPass(r.root), 'the swap: all four passes of the new payload, none of prev').toEqual([6, 12, 12, 6]);
      expect(counts()).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 1 });
      expect([stage, unstage, remove].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
      materials.setXray(false, -64, 319, 336);
      vi.restoreAllMocks();
      pumpAll(r, 1, 1);
      expect(counts()).toMatchObject({ columnsRemoving: 0, rows: 4 });

      // A replacement with no pass-3 row: its swap hides the shown pass-3 rows with the rest.
      r.stage(fakePayload(1, 1, [{ sy: 6, pass: 0, quads: 1 }]), 3);
      r.pump(fakeGate(1), 1, 1, 0);
      expect(byPass(r.root)).toEqual([6, 0, 0, 0]);
      pumpAll(r, 1, 1);
      expect(counts()).toMatchObject({ columnsRemoving: 0, rows: 1 });
      expect(byPass(r.root)).toEqual([6, 0, 0, 0]);
      r.dispose();
    });

    test(`${kind}: addStandIns adds a pass-3 stand-in over the X-ray material when no region object of pass 3 exists, so the material compiles behind the loading screen; none once one exists`, () => {
      const materials = createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO);
      const r = createSectionRenderer(kind, materials);
      const name = (m: Mesh): string => (m.material as Material).name;
      // Passes 0-2 built: the X-ray's stand-in is the only one.
      r.stage(fakePayload(0, 0, [{ sy: 4, pass: 0, quads: 1 }, { sy: 4, pass: 1, quads: 1 }, { sy: 4, pass: 2, quads: 1 }]), 1);
      pumpAll(r);
      const built = regionObjects(r.root);
      let drop = r.addStandIns();
      const added = regionObjects(r.root).filter((m) => !built.includes(m));
      expect(added.map(name)).toEqual(['xray']);
      expect(added[0]!.material).toBe(materials.xray);
      expect(added[0]!.visible).toBe(false);
      drop();
      expect(regionObjects(r.root)).toEqual(built);
      // A pass-3 row built: no stand-in at all.
      r.stage(fakePayload(1, 0, [{ sy: 4, pass: 3, quads: 1 }]), 1);
      pumpAll(r);
      const all = regionObjects(r.root);
      drop = r.addStandIns();
      expect(regionObjects(r.root)).toEqual(all);
      drop();
      r.dispose();
    });
  }
});

/**
 * Task 36's per-region use over the RD 12 disc (D25's second checkpoint; seed '42', the default profile, at d28bc67),
 * copied verbatim from its measuring script's JSON (ruling P34): per region, each pass's vertex and index sums.
 */
interface RegionUse {
  readonly growth: number;
  readonly summary: Record<string, { readonly all: { readonly max: number; readonly growthEvents: number; readonly regionsOverReservation: number } }>;
  readonly growthEventsTotal: number;
  readonly regions: ReadonlyArray<{ readonly rx: number; readonly rz: number; readonly columns: number; readonly vertices: readonly number[]; readonly indices: readonly number[] }>;
}
const REGION_USE = new URL('../fixtures/sp6a-region-use.json', import.meta.url);
const PASS_NAMES = ['opaque', 'cutout', 'translucent', 'xray'] as const;
const ALL_PASSES = [MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT, MESH_PASS_XRAY] as const;

/**
 * The × `growth` steps a region's object of `pass` takes from its reservation to hold `vertices` and `indices` (vertices
 * and indices grow together, `Math.ceil` as both backends), with no deleted or free space to reclaim: Task 36's growth
 * event. RegionMesh grows × `GROWTH` (1.5), RegionBatch × `BATCH_GROWTH` (1.25, SP6a Task 48) or to the waiting rows'
 * fit when that is more (Task 48d), so for RegionBatch the count is an upper bound: each of its growths is at least
 * × 1.25, and one column's rows take one growth.
 */
function growthSteps(pass: number, vertices: number, indices: number, growth: number): number {
  let [v, i] = RESERVATION[pass]!;
  let steps = 0;
  while (vertices > v || indices > i) {
    v = Math.ceil(v * growth);
    i = Math.ceil(i * growth);
    steps++;
  }
  return steps;
}
const growthOf = (kind: 'batch' | 'mesh'): number => (kind === 'batch' ? BATCH_GROWTH : GROWTH);

describe('regionGrid: the staging reservations kept, growth on demand over the caves disc (SP6a spec §5.1, R22)', () => {
  test('the four reservations keep their values (opaque 131,072 / 196,608, cutout 8,192 / 12,288, translucent and X-ray 16,384 / 24,576); RegionMesh grows × 1.5, RegionBatch × 1.25 (SP6a Task 48)', () => {
    expect(ALL_PASSES.map((p) => RESERVATION[p])).toEqual([
      [131_072, 196_608], [8192, 12_288], [16_384, 24_576], [16_384, 24_576],
    ]);
    for (const p of ALL_PASSES) expect(RESERVATION[p]![1]).toBe(1.5 * RESERVATION[p]![0]!);
    expect(GROWTH).toBe(1.5);
    expect(BATCH_GROWTH).toBe(1.25);
  });

  test('over Task 36\'s region use (test/fixtures/sp6a-region-use.json), the growth events per pass are, × 1.5 (RegionMesh and the fixture\'s own count), opaque 27, cutout 0, translucent 0, X-ray 69: 96 in all; × 1.25 (RegionBatch\'s bound, SP6a Task 48) 48, 0, 0, 121: 169; recorded (R22: growth on demand, not 0)', () => {
    const use = JSON.parse(readFileSync(REGION_USE, 'utf8')) as RegionUse;
    expect(use.growth).toBe(GROWTH);
    expect(use.regions).toHaveLength(15);
    expect(use.regions.filter((r) => r.columns === 64)).toHaveLength(4);
    const eventsAt = (growth: number): number[] =>
      ALL_PASSES.map((p) => use.regions.reduce((n, r) => n + growthSteps(p, r.vertices[p]!, r.indices[p]!, growth), 0));
    const events = eventsAt(GROWTH);
    const over = ALL_PASSES.map((p) => use.regions.filter((r) => growthSteps(p, r.vertices[p]!, r.indices[p]!, GROWTH) > 0).length);
    const max = ALL_PASSES.map((p) => Math.max(...use.regions.map((r) => r.vertices[p]!)));
    expect(events).toEqual([27, 0, 0, 69]);
    expect(events.reduce((a, b) => a + b, 0)).toBe(96);
    expect(over).toEqual([12, 0, 0, 12]);
    expect(max).toEqual([518_388, 0, 0, 253_220]);
    // The measuring script's own summary agrees with the count here.
    expect(PASS_NAMES.map((n) => use.summary[n]!.all.growthEvents)).toEqual(events);
    expect(PASS_NAMES.map((n) => use.summary[n]!.all.regionsOverReservation)).toEqual(over);
    expect(PASS_NAMES.map((n) => use.summary[n]!.all.max)).toEqual(max);
    expect(use.growthEventsTotal).toBe(96);
    // The largest region of each pass (518,388 opaque and 253,220 X-ray vertices) takes 4 and 7 growths × 1.5.
    expect(growthSteps(MESH_PASS_OPAQUE, 518_388, 777_582, GROWTH)).toBe(4);
    expect(growthSteps(MESH_PASS_XRAY, 253_220, 379_830, GROWTH)).toBe(7);
    // RegionBatch's smaller steps: at most this many (a growth sized to the waiting rows counts once), in the same regions.
    const batchEvents = eventsAt(BATCH_GROWTH);
    expect(batchEvents).toEqual([48, 0, 0, 121]);
    expect(batchEvents.reduce((a, b) => a + b, 0)).toBe(169);
    expect(ALL_PASSES.map((p) => use.regions.filter((r) => growthSteps(p, r.vertices[p]!, r.indices[p]!, BATCH_GROWTH) > 0).length)).toEqual(over);
    expect(growthSteps(MESH_PASS_OPAQUE, 518_388, 777_582, BATCH_GROWTH)).toBe(7);
    expect(growthSteps(MESH_PASS_XRAY, 253_220, 379_830, BATCH_GROWTH)).toBe(13);
  });

  for (const kind of ['batch', 'mesh'] as const) {
    test(`${kind}: the growth count above is the backend's: the disc's smallest growing X-ray region (−1, 1), 75,124 vertices in one column, grows its pass-3 object ${kind === 'batch' ? 'once, to the column (× 1.25 alone: 7 times)' : '4 times (× 1.5)'} from 16,384 vertices`, () => {
      const use = JSON.parse(readFileSync(REGION_USE, 'utf8')) as RegionUse;
      const region = use.regions.find((r) => r.rx === -1 && r.rz === 1)!;
      const vertices = region.vertices[MESH_PASS_XRAY]!;
      expect(vertices).toBe(75_124);
      const steps = growthSteps(MESH_PASS_XRAY, vertices, region.indices[MESH_PASS_XRAY]!, growthOf(kind));
      expect(steps).toBe(kind === 'batch' ? 7 : 4);
      const quads = vertices / 4;
      const rows = Array.from({ length: Math.ceil(quads / 1024) }, (_, k) => ({
        sy: k % 24, pass: MESH_PASS_XRAY as 3, quads: Math.min(1024, quads - 1024 * k),
      }));
      const r = createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO));
      const ops: string[] = [];
      r.stage(fakePayload(0, 0, rows), 1);
      while (r.counts(createSectionRendererCounts()).columnsRevealed === 0) {
        r.pump(fakeGate(64), 0, 0, 0);
        const last = r.counts(createSectionRendererCounts()).lastStructural;
        if (last !== null) ops.push(last);
      }
      // RegionBatch sizes the growth to the waiting column (Task 48d): one 'grow' to its 75,124 vertices, within the bound.
      expect(ops).toEqual(['create', ...Array<string>(kind === 'batch' ? 1 : steps).fill('grow')]);
      if (kind === 'batch') {
        const xray = regionObjects(r.root).find((m) => m.userData['pass'] === MESH_PASS_XRAY)!;
        expect(xray.geometry.getAttribute('position').count).toBe(vertices);
      }
      r.dispose();
    });
  }
});

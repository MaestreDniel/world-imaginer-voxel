import { Matrix4, type BatchedMesh, type BufferAttribute, type Material, type Mesh, type Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { createUploadBudget } from '../../src/engine/uploadBudget';
import { ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { createMaterialSystem } from '../../src/render/materials/index';
import {
  createRevealProbe, createSectionRenderer, createSectionRendererCounts, regionOf, type RevealProbe, type SectionRenderer,
  type SectionRendererCounts, type SectionRendererKind, type UploadGate,
} from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { fakePayload, type FakeRow } from './fixtures/payloads';

/**
 * The streaming `SectionRenderer` contract (SP4b spec §4.1, §3.9): nearest-first uploads under the gate's row cap and
 * structural slot, a column shown only in the call that uploads its last row, removal, re-staging, the held reveal,
 * the origin rebase, counts and `gpuBytes`, and the probe. It is run against both implementations, RegionBatch
 * (`regionBatch.test.ts`) and RegionMesh (`regionMesh.test.ts`). What a test sees drawn it reads from three's objects
 * under `root` (`visibleIndices`), independently of the renderer's own state.
 */

const ALBEDO = createFlatColorArray();

/** A frame's gate: at most `rows` rows and `structurals` structural operations, the latter only before any row. */
export interface FakeGate extends UploadGate {
  readonly spent: number;
  readonly granted: number;
}

/** A fake gate with `createUploadBudget`'s rules and no clock (`rows = Infinity` grants every structural call). */
export function fakeGate(rows: number, structurals = 1): FakeGate {
  let spent = 0;
  let granted = 0;
  return {
    exhausted: () => spent >= rows,
    spend(n) { spent += n; },
    structural() {
      if (rows !== Number.POSITIVE_INFINITY && (granted >= structurals || spent > 0)) return false;
      granted++;
      return true;
    },
    get spent() { return spent; },
    get granted() { return granted; },
  };
}

/** No row cap, no structural cap. */
export const UNBOUNDED: UploadGate = { exhausted: () => false, spend() {}, structural: () => true };

/** Pumps under `UNBOUNDED` until a pump spends nothing (that last pump restores culling where it can). */
export function pumpAll(r: SectionRenderer, cx = 0, cz = 0, yawDeg = 0): void {
  for (let i = 0; i < 1000 && r.pump(UNBOUNDED, cx, cz, yawDeg) > 0; i++);
}

/** One row of `quads` quads at section sy: opaque, or water (translucent). */
export const opaque = (sy: number, quads = 1): FakeRow => ({ sy, pass: 0, quads });
export const water = (sy: number, quads = 1): FakeRow => ({ sy, pass: 2, quads });

/** `nOpaque` opaque rows at sy 0, 1, …, then `nWater` translucent rows at sy 0, 1, … (one per section and pass). */
export function rowsOf(nOpaque: number, nWater: number, quads = 1): FakeRow[] {
  const out: FakeRow[] = [];
  for (let s = 0; s < nOpaque; s++) out.push(opaque(s % 24, quads));
  for (let s = 0; s < nWater; s++) out.push(water(s % 24, quads));
  return out;
}

const rowsIn = (p: ColumnMeshPayload): number => p.rows.length / ROW_INTS;
export const indexSum = (ps: readonly ColumnMeshPayload[]): number => {
  let n = 0;
  for (const p of ps) for (let o = 0; o < p.rows.length; o += ROW_INTS) n += p.rows[o + 5]!;
  return n;
};
export const vertexSum = (ps: readonly ColumnMeshPayload[]): number => {
  let n = 0;
  for (const p of ps) for (let o = 0; o < p.rows.length; o += ROW_INTS) n += p.rows[o + 3]!;
  return n;
};

/** Every region object under `root` (a BatchedMesh counts once). */
export function regionObjects(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

const isBatch = (m: Mesh): boolean => (m as unknown as BatchedMesh).isBatchedMesh === true;
const shown = (o: Object3D): boolean => {
  for (let x: Object3D | null = o; x !== null; x = x.parent) if (!x.visible) return false;
  return true;
};

/**
 * The indices three would draw under `root`: on a BatchedMesh, the index counts of its active visible instances; on a
 * Mesh, three times the non-degenerate triangles of its draw range (a hidden range holds equal indices).
 */
export function visibleIndices(root: Object3D): number {
  let n = 0;
  for (const m of regionObjects(root)) {
    if (!shown(m)) continue;
    if (isBatch(m)) {
      const b = m as unknown as BatchedMesh;
      const info = (b as unknown as { _instanceInfo: Array<{ active: boolean }> })._instanceInfo;
      for (let i = 0; i < info.length; i++) {
        if (!info[i]!.active || !b.getVisibleAt(i)) continue;
        n += b.getGeometryRangeAt(b.getGeometryIdAt(i))!.indexCount;
      }
    } else {
      const index = m.geometry.getIndex()!.array;
      const end = Math.min(index.length, m.geometry.drawRange.start + m.geometry.drawRange.count);
      for (let k = m.geometry.drawRange.start; k + 2 < end; k += 3) {
        if (index[k] !== index[k + 1] || index[k + 1] !== index[k + 2]) n += 3;
      }
    }
  }
  return n;
}

/** The objects of region (rx, rz). */
export const regionAt = (r: SectionRenderer, rx: number, rz: number): Mesh[] =>
  regionObjects(r.root).filter((m) => m.userData['rx'] === rx && m.userData['rz'] === rz);

/** A small seeded LCG in [0, 1) (Numerical Recipes' constants). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function sectionRendererContract(kind: SectionRendererKind): void {
  const make = (): SectionRenderer =>
    createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: true, smoothLight: true }, ALBEDO));
  const probe = (r: SectionRenderer): RevealProbe => r.probe(createRevealProbe());
  const counts = (r: SectionRenderer): SectionRendererCounts => r.counts(createSectionRendererCounts());

  describe(`SectionRenderer streaming contract: ${kind} (SP4b spec §4.1, §3.9)`, () => {
    test('upload order is nearest-first from the camera with distinct distances: staged (5, 0), (1, 0), (3, 0) at yaw 0 upload in the order (1, 0), (3, 0), (5, 0)', () => {
      const r = make();
      expect(r.kind).toBe(kind);
      [5, 1, 3].forEach((cx, i) => r.stage(fakePayload(cx, 0, [opaque(4), opaque(5)]), i + 1));
      const order: number[] = [];
      r.onColumnRevealed = (cx) => order.push(cx);
      for (let i = 0; i < 3; i++) {
        // Two rows a pump: one column each.
        expect(r.pump(fakeGate(2), 0, 0, 0)).toBe(2);
        expect(order).toHaveLength(i + 1);
      }
      expect(order).toEqual([1, 3, 5]);
      for (const cx of [1, 3, 5]) expect(r.isRevealed(cx, 0)).toBe(true);
      r.dispose();
    });

    test('the row cap: 32 rows of a 40-row column in the first pump and 8 in the second; nothing of it shows after the first, all 40 rows after the second, in one call', () => {
      const r = make();
      // An earlier column with rows in both passes: the region's opaque and translucent objects exist.
      const earlier = fakePayload(2, 2, [opaque(3), water(4)]);
      r.stage(earlier, 1);
      pumpAll(r);
      expect(r.isRevealed(2, 2)).toBe(true);
      const before = counts(r).structuralOps;
      const big = fakePayload(3, 3, rowsOf(24, 16));
      expect(rowsIn(big)).toBe(40);
      r.stage(big, 1);
      const revealed: Array<[number, number]> = [];
      r.onColumnRevealed = (cx, cz) => revealed.push([cx, cz]);
      expect(r.pump(fakeGate(32), 3, 3, 0)).toBe(32);
      expect(r.isRevealed(3, 3)).toBe(false);
      expect(visibleIndices(r.root)).toBe(indexSum([earlier]));
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      expect(revealed).toEqual([]);
      expect(r.pump(fakeGate(32), 3, 3, 0)).toBe(8);
      expect(r.isRevealed(3, 3)).toBe(true);
      expect(revealed).toEqual([[3, 3]]);
      expect(visibleIndices(r.root)).toBe(indexSum([earlier, big]));
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      expect(counts(r).structuralOps).toBe(before);
      r.dispose();
    });

    test('structural before releases: with 40 rows pending release and a staged column in a new region, one pump under a 32-row gate creates the region\'s object and releases 32 rows; the column\'s rows upload in the following pumps and it is revealed', () => {
      const r = make();
      r.stage(fakePayload(1, 1, rowsOf(24, 16)), 1);
      pumpAll(r);
      r.remove(1, 1);
      expect(counts(r).columnsRemoving).toBe(1);
      const fresh = fakePayload(17, 1, [opaque(4), opaque(5)]);
      r.stage(fresh, 1);
      expect(regionAt(r, 2, 0)).toHaveLength(0);
      const gate = fakeGate(32);
      expect(r.pump(gate, 17, 1, 0)).toBe(32);
      expect(gate.granted).toBe(1);
      expect(regionAt(r, 2, 0)).toHaveLength(1);
      expect(counts(r)).toMatchObject({ lastStructural: 'create', columnsRemoving: 1, rows: 8 });
      expect(r.isRevealed(17, 1)).toBe(false);
      // The 8 releases and the column's 2 rows.
      expect(r.pump(fakeGate(32), 17, 1, 0)).toBe(10);
      expect(r.isRevealed(17, 1)).toBe(true);
      expect(counts(r)).toMatchObject({ columnsRemoving: 0, rows: 2, regions: 1 });
      expect(visibleIndices(r.root)).toBe(indexSum([fresh]));
      r.dispose();
    });

    test('under holdReveals(true) with a 32-row gate and a column spanning two pumps, probe partial is 0 on every pump until revealAll', () => {
      const r = make();
      r.holdReveals(true);
      const ps = [fakePayload(0, 0, rowsOf(24, 16)), fakePayload(1, 0, rowsOf(20, 0))];
      for (const p of ps) r.stage(p, 1);
      for (let i = 0; i < 4; i++) {
        r.pump(fakeGate(32), 0, 0, 0);
        expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
        expect(visibleIndices(r.root)).toBe(0);
      }
      expect(counts(r)).toMatchObject({ columnsStaged: 2, columnsComplete: 2 });
      r.revealAll();
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      expect(visibleIndices(r.root)).toBe(indexSum(ps));
      r.dispose();
    });

    test('lastStructural: a pump that creates a region reports \'create\' with the reservation\'s bytes (1,835,008 for batch, 2,359,296 for mesh), and the next pump reports null and 0', () => {
      const r = make();
      r.stage(fakePayload(0, 0, [opaque(4)]), 1);
      r.pump(fakeGate(32), 0, 0, 0);
      expect(counts(r)).toMatchObject({ lastStructural: 'create', lastStructuralBytes: kind === 'batch' ? 1_835_008 : 2_359_296, structuralOps: 1 });
      r.pump(fakeGate(32), 0, 0, 0);
      expect(counts(r)).toMatchObject({ lastStructural: null, lastStructuralBytes: 0, structuralOps: 1 });
      r.dispose();
    });

    test('one structural operation per frame while flying: two new regions in one pump create one; the second waits for the next pump; under an Infinity-row gate both are created in one pump', () => {
      let t = 0;
      const now = (): number => t;
      // The engine's budget satisfies the gate structurally.
      const flying: UploadGate & { start(): void } = createUploadBudget(2, 32, now);
      const r = make();
      r.stage(fakePayload(0, 0, [opaque(4)]), 1);
      r.stage(fakePayload(17, 0, [opaque(4)]), 1);
      flying.start();
      r.pump(flying, 0, 0, 0);
      expect(counts(r).structuralOps).toBe(1);
      expect(r.isRevealed(0, 0)).toBe(true);
      expect(r.isRevealed(17, 0)).toBe(false);
      expect(regionAt(r, 2, 0)).toHaveLength(0);
      t += 16;
      flying.start();
      r.pump(flying, 0, 0, 0);
      expect(counts(r).structuralOps).toBe(2);
      expect(r.isRevealed(17, 0)).toBe(true);

      const loading: UploadGate & { start(): void } = createUploadBudget(12, Number.POSITIVE_INFINITY, now);
      const s = make();
      s.stage(fakePayload(0, 0, [opaque(4)]), 1);
      s.stage(fakePayload(17, 0, [opaque(4), water(4)]), 1);
      loading.start();
      s.pump(loading, 0, 0, 0);
      expect(counts(s).structuralOps).toBe(3);
      expect(s.isRevealed(0, 0) && s.isRevealed(17, 0)).toBe(true);
      r.dispose();
      s.dispose();
    });

    test('removal: hidden at once (probe partial 0 in that frame), rows released under the gate, an emptied region disposed', () => {
      const r = make();
      const keep = fakePayload(9, 0, [opaque(2)]);
      const gone = fakePayload(1, 1, rowsOf(24, 16));
      r.stage(keep, 1);
      r.stage(gone, 1);
      pumpAll(r);
      expect(visibleIndices(r.root)).toBe(indexSum([keep, gone]));
      expect(counts(r)).toMatchObject({ regions: 2, rows: 41 });
      r.remove(1, 1);
      // Hidden at once, before any pump.
      expect(r.isRevealed(1, 1)).toBe(false);
      expect(visibleIndices(r.root)).toBe(indexSum([keep]));
      expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRemoving: 1, rows: 41, regions: 2 });
      expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(32);
      expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      expect(counts(r)).toMatchObject({ columnsRemoving: 1, rows: 9, regions: 2 });
      expect(regionAt(r, 0, 0).length).toBeGreaterThan(0);
      expect(r.pump(fakeGate(32), 0, 0, 0)).toBe(8);
      expect(counts(r)).toMatchObject({ columnsRemoving: 0, rows: 1, regions: 1, vertices: vertexSum([keep]), indices: indexSum([keep]) });
      // Region (0, 0) emptied: its objects are disposed and gone from the root.
      expect(regionAt(r, 0, 0)).toHaveLength(0);
      expect(regionAt(r, 1, 0).length).toBeGreaterThan(0);
      expect(visibleIndices(r.root)).toBe(indexSum([keep]));
      // Removing a column that is not staged changes nothing.
      r.remove(40, 40);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRemoving: 0 });
      r.dispose();
    });

    test('re-staging an unrevealed column replaces it', () => {
      const r = make();
      // One pass, so the first pump's one structural operation (the batch) lets all 32 rows through.
      r.stage(fakePayload(2, 2, rowsOf(40, 0)), 1);
      expect(r.pump(fakeGate(32), 2, 2, 0)).toBe(32);
      const second = fakePayload(2, 2, [opaque(7, 3), water(8, 2)]);
      r.stage(second, 2);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 0, columnsRevealed: 0, columnsRemoving: 1 });
      expect(r.isRevealed(2, 2)).toBe(false);
      expect(visibleIndices(r.root)).toBe(0);
      pumpAll(r, 2, 2);
      expect(r.isRevealed(2, 2)).toBe(true);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRevealed: 1, columnsRemoving: 0, rows: 2 });
      expect(visibleIndices(r.root)).toBe(indexSum([second]));
      expect(probe(r)).toEqual({ columns: 1, partial: 0, mixed: 0 });
      r.dispose();
    });

    test('a column removed and re-staged at another seq shows exactly its new rows once revealed; probe mixed 0', () => {
      const r = make();
      r.stage(fakePayload(4, 4, rowsOf(24, 16)), 1);
      pumpAll(r, 4, 4);
      r.remove(4, 4);
      const next = fakePayload(4, 4, [opaque(2, 5), opaque(3, 1)]);
      r.stage(next, 2);
      for (let i = 0; i < 4; i++) {
        r.pump(fakeGate(16), 4, 4, 0);
        expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      }
      expect(r.isRevealed(4, 4)).toBe(true);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRemoving: 0, rows: 2 });
      expect(visibleIndices(r.root)).toBe(indexSum([next]));
      r.dispose();
    });

    test('an object with rows written in a pump has frustumCulled false until three uploads it (each attribute\'s onUploadCallback leaves no pending update range), and true again at the next pump', () => {
      const r = make();
      r.stage(fakePayload(0, 0, [opaque(3), water(3)]), 1);
      r.stage(fakePayload(17, 0, [opaque(3)]), 1);
      pumpAll(r);
      const written = regionObjects(r.root);
      expect(written).toHaveLength(3);
      for (const m of written) expect(m.frustumCulled).toBe(false);
      // Nothing uploaded them yet: still unculled after another pump.
      r.pump(fakeGate(32), 0, 0, 0);
      for (const m of written) expect(m.frustumCulled).toBe(false);
      // three's upload of each attribute (its first one, a whole-array bufferData, which keeps the ranges in r186)
      // ends in the attribute's onUploadCallback: the renderer's hook leaves no pending range (spec §4.1).
      for (const m of written) {
        const g = m.geometry;
        const attributes = [...Object.values(g.attributes), g.getIndex()!] as BufferAttribute[];
        expect(attributes.some((a) => a.updateRanges.length > 0)).toBe(true);
        for (const a of attributes) a.onUploadCallback();
        for (const a of attributes) expect(a.updateRanges).toEqual([]);
      }
      r.pump(fakeGate(32), 0, 0, 0);
      for (const m of written) expect(m.frustumCulled).toBe(true);
      // A row written into region (2, 0): only its object is unculled again.
      r.stage(fakePayload(18, 0, [opaque(5)]), 1);
      r.pump(fakeGate(32), 0, 0, 0);
      for (const m of written) expect(m.frustumCulled).toBe(m.userData['rx'] !== 2);
      r.dispose();
    });

    test('holdReveals: complete columns stay hidden in the hidden root; revealAll shows the root in one call', () => {
      const r = make();
      r.holdReveals(true);
      expect(r.root.visible).toBe(false);
      const ps = [fakePayload(0, 0, [opaque(4), water(5)]), fakePayload(9, 1, [opaque(1)])];
      for (const p of ps) r.stage(p, 1);
      pumpAll(r);
      expect(counts(r)).toMatchObject({ columnsStaged: 2, columnsComplete: 2 });
      expect(r.root.visible).toBe(false);
      expect(r.isRevealed(0, 0)).toBe(false);
      expect(visibleIndices(r.root)).toBe(0);
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      r.revealAll();
      expect(r.root.visible).toBe(true);
      expect(r.isRevealed(0, 0) && r.isRevealed(9, 1)).toBe(true);
      expect(visibleIndices(r.root)).toBe(indexSum(ps));
      r.holdReveals(false);
      expect(r.root.visible).toBe(true);
      r.dispose();
    });

    test('the probe is 0 (partial and mixed) on every frame of a seeded random stage/remove/pump sequence of 400 frames', () => {
      const r = make();
      const rand = lcg(42);
      // Twelve columns over five regions; each staging gets a fresh payload of 1-30 rows.
      const pool: Array<[number, number]> = [[0, 0], [1, 2], [7, 7], [3, 5], [8, 0], [9, 3], [15, 7], [12, 4], [-1, 0], [-5, 2], [-8, 7], [-3, -3]];
      const live = new Map<string, ColumnMeshPayload>();
      let seq = 0;
      let revealedSeen = 0;
      for (let frame = 0; frame < 400; frame++) {
        const ops = Math.floor(rand() * 4);
        for (let k = 0; k < ops; k++) {
          const [cx, cz] = pool[Math.floor(rand() * pool.length)]!;
          const key = `${cx},${cz}`;
          if (rand() < 0.6) {
            if (r.isRevealed(cx, cz)) continue;
            const n = 1 + Math.floor(rand() * 30);
            const rows: FakeRow[] = [];
            for (let i = 0; i < n; i++) rows.push({ sy: i % 24, pass: i % 5 === 4 ? 2 : i % 7 === 6 ? 1 : 0, quads: 1 + Math.floor(rand() * 3) });
            const p = fakePayload(cx, cz, rows);
            r.stage(p, ++seq);
            live.set(key, p);
          } else {
            r.remove(cx, cz);
            live.delete(key);
          }
        }
        const [ccx, ccz] = pool[Math.floor(rand() * pool.length)]!;
        r.pump(fakeGate(1 + Math.floor(rand() * 40)), ccx, ccz, rand() * 360);
        const pr = probe(r);
        expect(pr.partial, `frame ${frame}`).toBe(0);
        expect(pr.mixed, `frame ${frame}`).toBe(0);
        const shownNow = [...live.values()].filter((p) => r.isRevealed(p.cx, p.cz));
        revealedSeen += shownNow.length;
        expect(visibleIndices(r.root), `frame ${frame}`).toBe(indexSum(shownNow));
      }
      // The sequence did reveal columns (it is not vacuous).
      expect(revealedSeen).toBeGreaterThan(400);
      r.dispose();
    });

    test('origin rebase: with a revealed column in region (1, 0) and the origin at (0, 0, 0), setOrigin(512, 0, 0) moves that region\'s objects to (−384, −64, 0), leaves every row\'s instance matrix (batch) or vertex range (mesh) unchanged, and the probe stays 0', () => {
      const r = make();
      r.stage(fakePayload(10, 3, [opaque(4, 2), water(6), opaque(9)]), 1);
      pumpAll(r, 10, 3);
      const objects = regionAt(r, 1, 0);
      expect(objects.length).toBeGreaterThan(0);
      const snapshot = (): string[] => objects.map((m) => {
        if (isBatch(m)) {
          const b = m as unknown as BatchedMesh;
          const out: string[] = [];
          const mat = new Matrix4();
          for (let i = 0; i < b.instanceCount; i++) out.push(b.getMatrixAt(i, mat).elements.join(','));
          return out.join(';');
        }
        return Array.from(m.geometry.getAttribute('position').array as Uint16Array).join(',');
      });
      const before = snapshot();
      for (const m of objects) expect(m.position.toArray()).toEqual([128, -64, 0]);
      r.setOrigin(512, 0, 0);
      for (const m of objects) expect(m.position.toArray()).toEqual([-384, -64, 0]);
      expect(snapshot()).toEqual(before);
      expect(probe(r)).toEqual({ columns: 1, partial: 0, mixed: 0 });
      // A region created after the rebase is placed relative to the origin too.
      r.stage(fakePayload(-1, -1, [opaque(0)]), 1);
      pumpAll(r);
      for (const m of regionAt(r, -1, -1)) expect(m.position.toArray()).toEqual([-640, -64, -128]);
      r.dispose();
    });

    test('counts and gpuBytes: a region with one opaque row — batch 1,835,008 bytes, mesh 2,359,296', () => {
      const r = make();
      expect(r.gpuBytes()).toBe(0);
      const p = fakePayload(3, 3, [opaque(4, 5)]);
      r.stage(p, 1);
      pumpAll(r, 3, 3);
      expect(r.gpuBytes()).toBe(kind === 'batch' ? 1_835_008 : 2_359_296);
      expect(counts(r)).toMatchObject({
        columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 0, regions: 1, rows: 1,
        vertices: vertexSum([p]), indices: indexSum([p]), structuralOps: 1,
      });
      r.dispose();
      expect(r.gpuBytes()).toBe(0);
    });

    test('Review Focus 3: column (−31,249, −31,249) is in region (−3,907, −3,907); with the origin at (−499,712, 0, −499,712) its object position is (−384, −64, −384)', () => {
      expect(regionOf(-31249, -31249)).toEqual([-3907, -3907]);
      const r = make();
      r.setOrigin(-499712, 0, -499712);
      r.stage(fakePayload(-31249, -31249, [opaque(4), water(5)]), 1);
      pumpAll(r, -31249, -31249);
      const objects = regionAt(r, -3907, -3907);
      expect(objects.length).toBeGreaterThan(0);
      for (const m of objects) expect(m.position.toArray()).toEqual([-384, -64, -384]);
      expect(r.isRevealed(-31249, -31249)).toBe(true);
      r.dispose();
    });

    test('counts(out) and probe(out) write into the caller\'s object; structuralMs is finite and ≥ 0', () => {
      const r = make();
      const c = createSectionRendererCounts();
      const pr = createRevealProbe();
      expect(r.counts(c)).toBe(c);
      expect(r.probe(pr)).toBe(pr);
      r.stage(fakePayload(0, 0, [opaque(1)]), 1);
      pumpAll(r);
      r.counts(c);
      expect(Number.isFinite(c.structuralMs) && c.structuralMs >= 0).toBe(true);
      expect(c.columnsRevealed).toBe(1);
      r.dispose();
    });

    test('dispose frees every geometry and empties the root', () => {
      const r = make();
      r.stage(fakePayload(0, 0, [opaque(1), water(2)]), 1);
      r.stage(fakePayload(20, 0, [opaque(1)]), 1);
      pumpAll(r);
      const geometries = new Set(regionObjects(r.root).map((m) => m.geometry));
      expect(geometries.size).toBeGreaterThan(0);
      const freed = new Set<unknown>();
      for (const g of geometries) g.addEventListener('dispose', () => freed.add(g));
      r.dispose();
      expect(freed).toEqual(geometries);
      expect(regionObjects(r.root)).toHaveLength(0);
      expect(counts(r)).toMatchObject({ columnsStaged: 0, regions: 0, rows: 0 });
    });

    test('addStandIns: one hidden one-triangle object of the renderer\'s own kind per pass with no region object, over that pass\'s material; the call it returns removes and frees them; counts, gpuBytes and the probe unchanged (rulings R11)', () => {
      const r = make();
      const materialName = (m: Mesh): string => (m.material as Material).name;
      // An empty world: a stand-in for each of the three passes.
      const before = { counts: counts(r), bytes: r.gpuBytes(), probe: probe(r) };
      const drop = r.addStandIns();
      const standIns = regionObjects(r.root);
      expect(standIns.map(materialName).sort()).toEqual(['terrainCutout', 'terrainOpaque', 'waterFast']);
      for (const m of standIns) {
        expect(isBatch(m), 'the renderer\'s own object kind').toBe(kind === 'batch');
        expect(m.visible).toBe(false);
        expect(m.parent).toBe(r.root);
        const indices = isBatch(m) ? (m as unknown as BatchedMesh).getGeometryRangeAt(0)!.indexCount : m.geometry.getIndex()!.count;
        expect(indices, 'one triangle').toBe(3);
      }
      expect({ counts: counts(r), bytes: r.gpuBytes(), probe: probe(r) }).toEqual(before);
      const freed = new Set<unknown>();
      for (const m of standIns) m.geometry.addEventListener('dispose', () => freed.add(m.geometry));
      drop();
      expect(regionObjects(r.root)).toHaveLength(0);
      expect(freed).toEqual(new Set(standIns.map((m) => m.geometry)));
      // A second call is a no-op.
      drop();

      // An opaque and a water row built: a stand-in for the cutout pass only, beside the built objects.
      r.stage(fakePayload(0, 0, [opaque(1), water(2)]), 1);
      pumpAll(r);
      const built = regionObjects(r.root);
      const drop2 = r.addStandIns();
      const added = regionObjects(r.root).filter((m) => !built.includes(m));
      expect(added.map(materialName)).toEqual(['terrainCutout']);
      expect(isBatch(added[0]!)).toBe(kind === 'batch');
      expect(added[0]!.visible).toBe(false);
      drop2();
      expect(regionObjects(r.root)).toEqual(built);
      expect(r.isRevealed(0, 0)).toBe(true);
      r.dispose();
    });
  });

  describe(`SectionRenderer swap contract: ${kind} (SP4c spec §5.1, §5.5, D9)`, () => {
    /** A renderer showing `old` at column (2, 2), every row uploaded and revealed. */
    const showing = (old: ColumnMeshPayload): SectionRenderer => {
      const r = make();
      r.stage(old, 1);
      pumpAll(r, 2, 2);
      expect(r.isRevealed(2, 2)).toBe(true);
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      return r;
    };

    test('a staged replacement keeps every old row visible until its last row is uploaded, then the old are hidden and the new shown in one pump', () => {
      const old = fakePayload(2, 2, rowsOf(6, 2));
      const r = showing(old);
      const next = fakePayload(2, 2, rowsOf(20, 4, 2));
      expect(rowsIn(next)).toBe(24);
      const swaps: number[] = [];
      let pumps = 0;
      r.onColumnRevealed = () => swaps.push(pumps);
      r.stage(next, 2);
      // Staging changes nothing drawn: the old payload is shown and counted, the replacement pending.
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 0, columnsRevealed: 1, columnsRemoving: 0, rows: 8 });
      // The probe counts the swap's `prev` as a record of its own: the replacement and `prev`.
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      const spent: number[] = [];
      for (; pumps < 5; pumps++) {
        spent.push(r.pump(fakeGate(5), 2, 2, 0));
        // The visible index sum is the old payload's on every pump before the swap, the new's from that pump on.
        expect(visibleIndices(r.root), `pump ${pumps}`).toBe(indexSum([pumps < 4 ? old : next]));
        // Two records throughout: `prev` beside the replacement, then (from the swap) `prev` releasing.
        expect(probe(r), `pump ${pumps}`).toEqual({ columns: 2, partial: 0, mixed: 0 });
        expect(counts(r).columnsRevealed).toBe(1);
      }
      expect(spent).toEqual([5, 5, 5, 5, 4]);
      expect(swaps).toEqual([4]);
      // The old rows are then released under the gate, like a removal's.
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 1, rows: 32 });
      pumpAll(r, 2, 2);
      expect(counts(r)).toMatchObject({ columnsRemoving: 0, rows: 24, vertices: vertexSum([next]), indices: indexSum([next]) });
      expect(visibleIndices(r.root)).toBe(indexSum([next]));
      expect(probe(r)).toEqual({ columns: 1, partial: 0, mixed: 0 });
      r.dispose();
    });

    test('a second stage during a swap replaces the pending payload and keeps the old shown', () => {
      const old = fakePayload(2, 2, rowsOf(5, 1));
      const r = showing(old);
      r.stage(fakePayload(2, 2, rowsOf(10, 0)), 2);
      expect(r.pump(fakeGate(4), 2, 2, 0)).toBe(4);
      const third = fakePayload(2, 2, [opaque(3, 2), water(9), opaque(11, 4)]);
      r.stage(third, 3);
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      expect(r.isRevealed(2, 2)).toBe(true);
      // The first replacement's four uploaded rows are queued for release; the old payload is not.
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 0, columnsRevealed: 1, columnsRemoving: 1, rows: 10 });
      expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      for (let i = 0; i < 4; i++) {
        r.pump(fakeGate(2), 2, 2, 0);
        expect(probe(r), `pump ${i}`).toMatchObject({ partial: 0, mixed: 0 });
        expect([indexSum([old]), indexSum([third])]).toContain(visibleIndices(r.root));
      }
      pumpAll(r, 2, 2);
      expect(visibleIndices(r.root)).toBe(indexSum([third]));
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRevealed: 1, columnsRemoving: 0, rows: 3 });
      expect(probe(r)).toEqual({ columns: 1, partial: 0, mixed: 0 });
      r.dispose();
    });

    test('unstage during a swap keeps the old shown, releases the pending rows and returns true; unstage of a revealed column with nothing pending returns false and changes nothing; unstage of an unknown column returns false', () => {
      const old = fakePayload(2, 2, rowsOf(5, 1));
      const r = showing(old);
      const revealedCalls: Array<[number, number]> = [];
      r.onColumnRevealed = (cx, cz) => revealedCalls.push([cx, cz]);
      r.stage(fakePayload(2, 2, rowsOf(10, 0)), 2);
      expect(r.pump(fakeGate(4), 2, 2, 0)).toBe(4);
      expect(r.unstage(2, 2)).toBe(true);
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      expect(r.isRevealed(2, 2)).toBe(true);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 1, rows: 10 });
      expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      pumpAll(r, 2, 2);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 0, rows: 6 });
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      expect(probe(r)).toEqual({ columns: 1, partial: 0, mixed: 0 });

      // Nothing pending on a revealed column: false, and nothing changes.
      const before = { counts: counts(r), probe: probe(r), visible: visibleIndices(r.root), bytes: r.gpuBytes() };
      expect(r.unstage(2, 2)).toBe(false);
      expect({ counts: counts(r), probe: probe(r), visible: visibleIndices(r.root), bytes: r.gpuBytes() }).toEqual(before);
      // An unknown column: false.
      expect(r.unstage(40, 40)).toBe(false);
      expect(counts(r)).toEqual(before.counts);

      // A staged column that shows nothing yet is dropped whole: true, and the column is gone.
      r.stage(fakePayload(9, 9, rowsOf(6, 0)), 1);
      r.pump(fakeGate(3), 2, 2, 0);
      expect(r.unstage(9, 9)).toBe(true);
      expect(r.isRevealed(9, 9)).toBe(false);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRevealed: 1 });
      pumpAll(r, 2, 2);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRemoving: 0, rows: 6, regions: 1 });
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      expect(revealedCalls).toEqual([]);
      r.dispose();
    });

    test('unstage of an unrevealed first payload returns true and leaves the column unknown: remove is then a no-op and a later stage is a first stage', () => {
      const old = fakePayload(2, 2, rowsOf(5, 1));
      const r = showing(old);
      const revealedCalls: Array<[number, number]> = [];
      r.onColumnRevealed = (cx, cz) => revealedCalls.push([cx, cz]);
      // Column (9, 9) shows nothing: its first payload is staged, part uploaded (3 of 6 rows) or not at all (0).
      for (const uploaded of [3, 0]) {
        const what = `${uploaded} rows uploaded`;
        r.stage(fakePayload(9, 9, rowsOf(6, 0)), 1);
        if (uploaded > 0) expect(r.pump(fakeGate(uploaded), 2, 2, 0)).toBe(uploaded);
        expect(r.unstage(9, 9), what).toBe(true);
        expect(r.isRevealed(9, 9), what).toBe(false);
        // Nothing of it is a record any more: its uploaded rows are only queued for release.
        expect(counts(r), what).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: uploaded > 0 ? 1 : 0 });
        expect(probe(r), what).toEqual({ columns: uploaded > 0 ? 2 : 1, partial: 0, mixed: 0 });
        // remove of the unknown column is a no-op, and a second unstage returns false.
        const before = { counts: counts(r), probe: probe(r), visible: visibleIndices(r.root), bytes: r.gpuBytes() };
        r.remove(9, 9);
        expect(r.unstage(9, 9), what).toBe(false);
        expect({ counts: counts(r), probe: probe(r), visible: visibleIndices(r.root), bytes: r.gpuBytes() }, what).toEqual(before);
        pumpAll(r, 2, 2);
        expect(counts(r), what).toMatchObject({ columnsStaged: 1, columnsRemoving: 0, rows: 6, regions: 1 });
        expect(probe(r), what).toEqual({ columns: 1, partial: 0, mixed: 0 });
      }
      // A later stage is a first stage, not a swap: the column shows nothing until its last row is uploaded.
      const later = fakePayload(9, 9, rowsOf(4, 0, 2));
      r.stage(later, 2);
      expect(r.isRevealed(9, 9)).toBe(false);
      expect(counts(r)).toMatchObject({ columnsStaged: 2, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 0 });
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      expect(r.pump(fakeGate(3), 2, 2, 0)).toBe(3);
      expect(r.isRevealed(9, 9)).toBe(false);
      expect(visibleIndices(r.root)).toBe(indexSum([old]));
      pumpAll(r, 2, 2);
      expect(r.isRevealed(9, 9)).toBe(true);
      expect(revealedCalls).toEqual([[9, 9]]);
      expect(visibleIndices(r.root)).toBe(indexSum([old, later]));
      expect(counts(r)).toMatchObject({ columnsStaged: 2, columnsComplete: 2, columnsRevealed: 2, columnsRemoving: 0, rows: 10, regions: 2 });
      expect(probe(r)).toEqual({ columns: 2, partial: 0, mixed: 0 });
      r.dispose();
    });

    test('remove during a swap hides both', () => {
      const old = fakePayload(2, 2, rowsOf(5, 1));
      const r = showing(old);
      r.stage(fakePayload(2, 2, rowsOf(10, 0)), 2);
      expect(r.pump(fakeGate(4), 2, 2, 0)).toBe(4);
      r.remove(2, 2);
      expect(r.isRevealed(2, 2)).toBe(false);
      expect(visibleIndices(r.root)).toBe(0);
      expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      expect(counts(r)).toMatchObject({ columnsStaged: 0, columnsComplete: 0, columnsRevealed: 0, columnsRemoving: 2, rows: 10 });
      pumpAll(r, 2, 2);
      expect(counts(r)).toMatchObject({ columnsRemoving: 0, rows: 0, regions: 0 });
      expect(regionObjects(r.root)).toHaveLength(0);
      r.dispose();
    });

    test('an empty replacement hides the old at once', () => {
      const old = fakePayload(2, 2, rowsOf(5, 1));
      const r = showing(old);
      const revealedCalls: Array<[number, number]> = [];
      r.onColumnRevealed = (cx, cz) => revealedCalls.push([cx, cz]);
      r.stage(fakePayload(2, 2, []), 2);
      // In the stage call: the old rows hidden, the (all-air) column shown.
      expect(visibleIndices(r.root)).toBe(0);
      expect(r.isRevealed(2, 2)).toBe(true);
      expect(revealedCalls).toEqual([[2, 2]]);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 1, rows: 6 });
      expect(probe(r)).toMatchObject({ partial: 0, mixed: 0 });
      pumpAll(r, 2, 2);
      expect(counts(r)).toMatchObject({ columnsStaged: 1, columnsRemoving: 0, rows: 0 });

      // During a swap: the pending payload and the old one go at once.
      const s = showing(old);
      s.stage(fakePayload(2, 2, rowsOf(10, 0)), 2);
      s.pump(fakeGate(4), 2, 2, 0);
      const calls: Array<[number, number]> = [];
      s.onColumnRevealed = (cx, cz) => calls.push([cx, cz]);
      s.stage(fakePayload(2, 2, []), 3);
      expect(visibleIndices(s.root)).toBe(0);
      expect(s.isRevealed(2, 2)).toBe(true);
      expect(calls).toEqual([[2, 2]]);
      expect(counts(s)).toMatchObject({ columnsStaged: 1, columnsComplete: 1, columnsRevealed: 1, columnsRemoving: 2, rows: 10 });
      pumpAll(s, 2, 2);
      expect(counts(s)).toMatchObject({ columnsRemoving: 0, rows: 0 });
      expect(calls).toEqual([[2, 2]]);
      r.dispose();
      s.dispose();
    });

    test('on a swap that needs no growth, gpuBytes() returns to the old level after the swap\'s releases; a swap that grew its region is compared with the post-growth size', () => {
      const old = fakePayload(2, 2, rowsOf(10, 3, 3));
      const r = showing(old);
      const level = r.gpuBytes();
      expect(level).toBeGreaterThan(0);
      r.stage(fakePayload(2, 2, rowsOf(12, 2, 2)), 2);
      for (let i = 0; i < 6; i++) r.pump(fakeGate(4), 2, 2, 0);
      pumpAll(r, 2, 2);
      expect(counts(r)).toMatchObject({ columnsRemoving: 0, rows: 14, lastStructural: null });
      expect(r.gpuBytes()).toBe(level);
      r.dispose();

      // 20 rows of 4,096 vertices shown, 20 more as the replacement: 160,000-odd vertices do not fit the 131,072 of the
      // reservation, so the region grows (× 1.5, never undone).
      const big = (n: number): FakeRow[] => Array.from({ length: n }, (_, k) => ({ sy: k % 24, pass: 0, quads: 1024 }));
      const g = showing(fakePayload(2, 2, big(20)));
      const reserved = g.gpuBytes();
      expect(reserved).toBe(kind === 'batch' ? 1_835_008 : 2_359_296);
      g.stage(fakePayload(2, 2, big(20)), 2);
      g.pump(UNBOUNDED, 2, 2, 0);
      expect(counts(g).lastStructural).toBe('grow');
      const grown = g.gpuBytes();
      expect(grown).toBe(kind === 'batch' ? 2_752_512 : 3_538_944);
      expect(g.isRevealed(2, 2)).toBe(true);
      pumpAll(g, 2, 2);
      expect(counts(g)).toMatchObject({ columnsRemoving: 0, rows: 20 });
      expect(g.gpuBytes()).toBe(grown);
      g.dispose();
    });

    test('probe\'s partial and mixed are 0 on every pump of a 1,000-step LCG sequence (seed 4242) of stage / re-stage / unstage / remove / pump over revealed columns', () => {
      const r = make();
      const rand = lcg(4242);
      const pool: Array<[number, number]> = [[0, 0], [1, 2], [7, 7], [3, 5], [8, 0], [9, 3], [15, 7], [12, 4], [-1, 0], [-5, 2], [-8, 7], [-3, -3]];
      /** Per column what three should draw (`shown`) and the payload waiting to replace it (`pending`). */
      const model = new Map<string, { shown: ColumnMeshPayload | null; pending: ColumnMeshPayload | null }>();
      for (const [cx, cz] of pool) model.set(`${cx},${cz}`, { shown: null, pending: null });
      const payload = (cx: number, cz: number): ColumnMeshPayload => {
        const n = rand() < 0.08 ? 0 : 1 + Math.floor(rand() * 30);
        const rows: FakeRow[] = [];
        for (let i = 0; i < n; i++) rows.push({ sy: i % 24, pass: i % 5 === 4 ? 2 : i % 7 === 6 ? 1 : 0, quads: 1 + Math.floor(rand() * 3) });
        return fakePayload(cx, cz, rows);
      };
      let swaps = 0;
      let firstReveals = 0;
      r.onColumnRevealed = (cx, cz) => {
        const m = model.get(`${cx},${cz}`)!;
        expect(m.pending, `revealed (${cx}, ${cz}) with nothing pending`).not.toBeNull();
        if (m.shown !== null) swaps++;
        else firstReveals++;
        m.shown = m.pending;
        m.pending = null;
      };
      let seq = 0;
      const stage = (cx: number, cz: number): void => {
        const p = payload(cx, cz);
        model.get(`${cx},${cz}`)!.pending = p;
        r.stage(p, ++seq);
      };
      // Every column revealed first.
      for (const [cx, cz] of pool) stage(cx, cz);
      pumpAll(r);
      const check = (step: number): void => {
        const pr = probe(r);
        expect(pr.partial, `step ${step}`).toBe(0);
        expect(pr.mixed, `step ${step}`).toBe(0);
        let want = 0;
        for (const [key, m] of model) {
          const [cx, cz] = key.split(',').map(Number) as [number, number];
          expect(r.isRevealed(cx, cz), `step ${step} (${key})`).toBe(m.shown !== null);
          if (m.shown !== null) want += indexSum([m.shown]);
        }
        expect(visibleIndices(r.root), `step ${step}`).toBe(want);
      };
      check(-1);
      let pumps = 0;
      let dropped = 0;
      for (let step = 0; step < 1000; step++) {
        const [cx, cz] = pool[Math.floor(rand() * pool.length)]!;
        const m = model.get(`${cx},${cz}`)!;
        const op = rand();
        if (op < 0.3) {
          // A stage: a swap on a shown column, a re-stage on one with a payload pending.
          stage(cx, cz);
        } else if (op < 0.45) {
          const want = m.pending !== null;
          expect(r.unstage(cx, cz), `step ${step} unstage (${cx}, ${cz})`).toBe(want);
          if (want) dropped++;
          m.pending = null;
        } else if (op < 0.55) {
          r.remove(cx, cz);
          m.shown = null;
          m.pending = null;
        } else {
          const [ccx, ccz] = pool[Math.floor(rand() * pool.length)]!;
          r.pump(fakeGate(1 + Math.floor(rand() * 40)), ccx, ccz, rand() * 360);
          pumps++;
        }
        check(step);
      }
      // The sequence swapped, re-revealed and dropped columns (it is not vacuous).
      // (432 pumps, 160 swaps, 84 first reveals and 16 dropped payloads with seed 4242.)
      expect(pumps).toBeGreaterThan(300);
      expect(swaps).toBeGreaterThan(100);
      expect(firstReveals).toBeGreaterThan(pool.length);
      expect(dropped).toBeGreaterThan(10);
      pumpAll(r);
      check(1000);
      r.dispose();
    });

    test('isRevealed stays true for a column through its swap', () => {
      const r = showing(fakePayload(2, 2, rowsOf(5, 1)));
      r.stage(fakePayload(2, 2, rowsOf(9, 3)), 2);
      expect(r.isRevealed(2, 2)).toBe(true);
      for (let i = 0; i < 8; i++) {
        r.pump(fakeGate(3), 2, 2, 0);
        expect(r.isRevealed(2, 2), `pump ${i}`).toBe(true);
      }
      expect(counts(r)).toMatchObject({ rows: 12, columnsRemoving: 0 });
      r.dispose();
    });

    test('a swap calls onColumnRevealed once, in the pump that swaps it; an empty replacement once; unstage never', () => {
      const r = showing(fakePayload(2, 2, rowsOf(5, 1)));
      const calls: string[] = [];
      let at = 'stage';
      r.onColumnRevealed = (cx, cz) => calls.push(`${at} ${cx},${cz}`);
      r.stage(fakePayload(2, 2, rowsOf(6, 0)), 2);
      for (let i = 0; i < 4; i++) {
        at = `pump ${i}`;
        r.pump(fakeGate(4), 2, 2, 0);
      }
      // Six rows at four a pump: swapped in the second pump, and nothing after.
      expect(calls).toEqual(['pump 1 2,2']);
      at = 'unstage';
      r.stage(fakePayload(2, 2, rowsOf(6, 0)), 3);
      r.pump(fakeGate(4), 2, 2, 0);
      expect(r.unstage(2, 2)).toBe(true);
      pumpAll(r, 2, 2);
      at = 'empty';
      r.stage(fakePayload(2, 2, []), 4);
      at = 'after';
      pumpAll(r, 2, 2);
      expect(calls).toEqual(['pump 1 2,2', 'empty 2,2']);
      r.dispose();
    });
  });
}

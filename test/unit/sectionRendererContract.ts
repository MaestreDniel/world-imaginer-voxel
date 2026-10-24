import { Matrix4, type BatchedMesh, type BufferAttribute, type Mesh, type Object3D } from 'three';
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

    test('re-staging an unrevealed column replaces it; staging a revealed column throws', () => {
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
      expect(() => r.stage(fakePayload(2, 2, [opaque(1)]), 3)).toThrow(/revealed/);
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
  });
}

import { Box3, Vector3, type Group, type Mesh, type Sphere } from 'three';
import { STAGE_BONUS, streamScore } from '../core/streamScore';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS, type ColumnMeshPayload } from '../mesh/column';
import type {
  RevealProbe, SectionRenderer, SectionRendererCounts, SectionRendererKind, StructuralKind, UploadGate,
} from './sectionRenderer';

/**
 * The region grid and the column staging both section renderers share (SP4a spec §6.2, master §4.5; SP4b spec §4.1,
 * §3.9): a region is 8 × 8 columns aligned to `cx >> 3`, `cz >> 3`. `createStreamingRenderer` keeps the staged
 * columns (per column the payload, its seq, the rows uploaded, revealed or not, removal pending; per region its live
 * columns), the ready queue (each upload takes the staged column with the smallest MESH `streamScore` from the pump's
 * camera column and yaw: a linear scan, no allocation) and the pump's order; RegionBatch and RegionMesh supply a
 * `RegionBackend` that owns three's objects. Both also share the row gathering (`rowsOfPass`) and the section bounds
 * (`rowBounds`) (SP4b spec §7.6). A shown column staged again swaps (SP4c spec §5.1, D9): its record keeps the shown
 * one as `prev` until the replacement's last row is uploaded.
 */

/** The region of column (cx, cz): `[cx >> 3, cz >> 3]`. */
export function regionOf(cx: number, cz: number): [number, number] {
  return [cx >> 3, cz >> 3];
}

/** The region origin in blocks: `(rx·128, −64, rz·128)`. */
export function regionOrigin(rx: number, rz: number): [number, number, number] {
  return [rx * 128, -64, rz * 128];
}

/** Geometry units per block: positions are in 1/8 blocks (SP4a spec §5.5). */
export const UNITS = 8;
/** A section's (and a column's) extent in geometry units. */
export const SECTION_UNITS = 16 * UNITS;

/**
 * Per pass: the vertex and index reservation of a region's object, RegionBatch's batch and RegionMesh's arena alike
 * (SP4b spec §4.2, §4.3; Medium; the opaque one ≈ 1.8 MB on RegionBatch, 2.4 MB on RegionMesh).
 */
export const RESERVATION: Readonly<Record<number, readonly [vertices: number, indices: number]>> = {
  [MESH_PASS_OPAQUE]: [131_072, 196_608],
  [MESH_PASS_CUTOUT]: [8192, 12_288],
  [MESH_PASS_TRANSLUCENT]: [16_384, 24_576],
};
/** Every growth of a region's object is × 1.5 (SP4b spec §4.2, §4.3). */
export const GROWTH = 1.5;

/** One row of a column payload: the payload, the row's offset in `p.rows` and its number (its sphere is at `4·r`). */
export interface PayloadRow {
  readonly p: ColumnMeshPayload;
  readonly o: number;
  readonly r: number;
}

/**
 * The rows of `pass` in `payloads`, in payload order then row order, into `out` (cleared first), with their vertex and
 * index sums (SP4b spec §4.1: the row gathering both renderers shared).
 */
export function rowsOfPass(
  payloads: readonly ColumnMeshPayload[],
  pass: number,
  out: PayloadRow[],
): { vertices: number; indices: number } {
  out.length = 0;
  let vertices = 0;
  let indices = 0;
  for (const p of payloads) {
    for (let r = 0, o = 0; o < p.rows.length; r++, o += ROW_INTS) {
      if (p.rows[o + 1] !== pass) continue;
      out.push({ p, o, r });
      vertices += p.rows[o + 3]!;
      indices += p.rows[o + 5]!;
    }
  }
  return { vertices, indices };
}

const scratchSize = new Vector3();
const scratchSection = new Box3();

/**
 * The bounds of payload row `r` placed at `(ox, oy, oz)` (1/8 blocks; 0 for RegionBatch's section-local geometry, the
 * section's place in its region for RegionMesh's) (SP4b spec §4.1): `sphere` is the payload's sphere × 8 shifted by the
 * offset, `box` its cube clipped to the 128-unit section there (every position of the section lies in it), or a
 * degenerate box at the sphere's centre when the two do not meet.
 */
export function rowBounds(
  p: ColumnMeshPayload,
  r: number,
  ox: number,
  oy: number,
  oz: number,
  sphere: Sphere,
  box: Box3,
): void {
  const q = 4 * r;
  sphere.center.set(p.spheres[q]! * UNITS + ox, p.spheres[q + 1]! * UNITS + oy, p.spheres[q + 2]! * UNITS + oz);
  sphere.radius = p.spheres[q + 3]! * UNITS;
  box.setFromCenterAndSize(sphere.center, scratchSize.setScalar(2 * sphere.radius));
  scratchSection.min.set(ox, oy, oz);
  scratchSection.max.set(ox + SECTION_UNITS, oy + SECTION_UNITS, oz + SECTION_UNITS);
  box.intersect(scratchSection);
  if (box.isEmpty()) box.setFromCenterAndSize(sphere.center, scratchSize.setScalar(0));
}

/**
 * A column key for |cx|, |cz| < 2^20 (the world is ±31,250 columns): exact in a double. The same for region
 * coordinates.
 */
const columnKey = (cx: number, cz: number): number => (cx + 1_048_576) * 2_097_152 + (cz + 1_048_576);

/** Whether payload row `r` holds no index (nothing to draw: it takes no upload and counts nowhere). */
export const rowIsEmpty = (p: ColumnMeshPayload, r: number): boolean => p.rows[r * ROW_INTS + 5] === 0;

/** A staged column: one `stage` call, live until removed or replaced, then held until its rows are released. */
export interface StagedColumn<R> {
  readonly cx: number;
  readonly cz: number;
  readonly key: number;
  readonly region: StagingRegion<R>;
  readonly p: ColumnMeshPayload;
  readonly seq: number;
  /** The payload's rows, and those holding indices (the probe's "all of its rows"). */
  readonly rows: number;
  readonly nonEmpty: number;
  /** Rows handled so far, in payload order (empty rows included; the rows `[released, uploaded)` are held). */
  uploaded: number;
  released: number;
  /** Shown in its objects (inside the hidden root while reveals are held). */
  revealed: boolean;
  /**
   * During a swap (SP4c spec §5.1): the shown record this one replaces, revealed, visible and holding its rows in the
   * region's objects (so a growth, an optimisation or a compaction moves it) until this record's last row is uploaded;
   * out of every list, reachable only from here. Null otherwise, and always null on a revealed record.
   */
  prev: StagedColumn<R> | null;
  /** Two renderer handles per row (RegionBatch: geometry and instance ids; RegionMesh: its index range), −1 for none. */
  readonly ids: Int32Array;
  /** The staging's bookkeeping: the score of the current pump, its slots in the lists, the pump that refused it. */
  score: number;
  liveAt: number;
  pendingAt: number;
  blockedAt: number;
}

export interface StagingRegion<R> {
  readonly rx: number;
  readonly rz: number;
  readonly key: number;
  /** The region's live columns, in staging order. */
  readonly columns: Array<StagedColumn<R>>;
  /** Removed or replaced columns of the region whose rows are not all released. */
  holding: number;
  /** The renderer's state for the region (its objects). */
  readonly data: R;
}

/** What a section renderer supplies to the shared staging: three's side of each step. */
export interface RegionBackend<R> {
  /** A region's state at its first staged column; objects come later, through structural operations. */
  newRegion(rx: number, rz: number): R;
  /** The structural operation the column's remaining rows need first, taken together, or null. */
  columnNeed(c: StagedColumn<R>): StructuralKind | null;
  /** The structural operation row r (the column's next) needs before it can upload, or null. */
  rowNeed(c: StagedColumn<R>, r: number): StructuralKind | null;
  /** Performs the operation the last `columnNeed` or `rowNeed` call returned for `c`; returns its object's bytes after. */
  structural(c: StagedColumn<R>, kind: StructuralKind): number;
  /** Writes row r hidden. */
  upload(c: StagedColumn<R>, r: number): void;
  /** Shows every held row of `c`, in one call. */
  reveal(c: StagedColumn<R>): void;
  /** Hides every held row of `c` at once (`c` is already out of its region's live columns). */
  hide(c: StagedColumn<R>): void;
  /**
   * The swap (SP4c spec §5.1): hides every held row of `prev` and shows every held row of `next`, in one call (`next`
   * holds every row of its payload; with no non-empty row it shows nothing). `prev` then goes to the release queue.
   */
  swap(prev: StagedColumn<R>, next: StagedColumn<R>): void;
  /** Releases held row r. */
  release(c: StagedColumn<R>, r: number): void;
  /** Whether held row r is drawn: read from three's objects (its instance or index range, its object and the root). */
  rowVisible(c: StagedColumn<R>, r: number): boolean;
  /** The pump's first step: culling restored on the objects whose attributes hold no pending update range. */
  settle(): void;
  /** Frees the region's objects (no live column, no held row). */
  disposeRegion(g: StagingRegion<R>): void;
  /** Whether a region object of `pass` exists. */
  hasPass(pass: number): boolean;
  /** A hidden one-triangle object of the backend's own kind over `pass`'s material, and how to free it (rulings R11). */
  standIn(pass: number): { readonly object: Mesh; dispose(): void };
  setOrigin(x: number, y: number, z: number): void;
  sortTranslucent(camX: number, camY: number, camZ: number): void;
  gpuBytes(): number;
}

const DEG = Math.PI / 180;
/** Structural operations one row may take in one pump before the backend is judged stuck (a bug, never a budget). */
const MAX_OPS_PER_ROW = 8;

/**
 * The streaming section renderer over the backend `b` (SP4b spec §4.1, §3.9). `pump`'s order **(plan)**:
 * (1) `settle`; (2) when the nearest staged column needs a structural operation, ask `gate.structural()` before any
 * release and perform it on a grant (the gate grants only while no row was spent, so asked after the releases it
 * would starve region creation behind a removal backlog); (3) release removed rows, each counted against the row cap,
 * and dispose the regions left empty; (4) upload staged rows nearest-first, a row that needs a refused (or second)
 * structural operation waiting while farther columns go on; (5) reveal each column whose last row was uploaded, all
 * its rows in one call, or swap it with its `prev` in one call (`onColumnRevealed` either way). With nothing staged or
 * removed a pump allocates nothing (D25).
 *
 * The swap (SP4c spec §5.1, D9): `stage` on a revealed column makes the shown record the new record's `prev`; the
 * column stays revealed (the counts' `revealed` does not change) and `prev`'s rows stay drawn until step (5) swaps;
 * `prev` then joins the release queue as a removal's rows do. A replacement with no non-empty row swaps in the `stage`
 * call. `unstage` retires a pending record and makes its `prev`, if any, the live record again; `remove` retires both.
 */
export function createStreamingRenderer<R>(
  kind: SectionRendererKind,
  root: Group,
  b: RegionBackend<R>,
): SectionRenderer {
  let structuralMs = 0;
  const live = new Map<number, StagedColumn<R>>();
  const liveList: Array<StagedColumn<R>> = [];
  const pending: Array<StagedColumn<R>> = [];
  const removing: Array<StagedColumn<R>> = [];
  let removingHead = 0;
  const regions = new Map<number, StagingRegion<R>>();
  const emptied: Array<StagingRegion<R>> = [];
  const completed: Array<StagedColumn<R>> = [];
  let complete = 0;
  let revealed = 0;
  let rows = 0;
  let vertices = 0;
  let indices = 0;
  let structuralOps = 0;
  let lastStructural: StructuralKind | null = null;
  let lastStructuralBytes = 0;
  let stamp = 0;

  const regionFor = (cx: number, cz: number): StagingRegion<R> => {
    const rx = cx >> 3;
    const rz = cz >> 3;
    const key = columnKey(rx, rz);
    let g = regions.get(key);
    if (g === undefined) {
      g = { rx, rz, key, columns: [], holding: 0, data: b.newRegion(rx, rz) };
      regions.set(key, g);
    }
    return g;
  };

  const maybeEmptied = (g: StagingRegion<R>): void => {
    if (g.columns.length === 0 && g.holding === 0) emptied.push(g);
  };

  const dropPending = (c: StagedColumn<R>): void => {
    const last = pending.pop()!;
    if (last !== c) {
      pending[c.pendingAt] = last;
      last.pendingAt = c.pendingAt;
    }
    c.pendingAt = -1;
  };

  /** Takes a live column out of the live set (the counts follow). */
  const detach = (c: StagedColumn<R>): void => {
    live.delete(c.key);
    const last = liveList.pop()!;
    if (last !== c) {
      liveList[c.liveAt] = last;
      last.liveAt = c.liveAt;
    }
    c.liveAt = -1;
    if (c.pendingAt >= 0) dropPending(c);
    else complete--;
    if (c.revealed || c.prev !== null) revealed--;
    const cols = c.region.columns;
    cols.splice(cols.indexOf(c), 1);
  };

  /** Puts a record in the live set (the counts follow), into the pending list when `waits` (else it is complete). */
  const attach = (c: StagedColumn<R>, waits: boolean): void => {
    live.set(c.key, c);
    c.liveAt = liveList.length;
    liveList.push(c);
    c.region.columns.push(c);
    if (waits) {
      c.pendingAt = pending.length;
      pending.push(c);
    } else {
      complete++;
    }
    if (c.revealed || c.prev !== null) revealed++;
  };

  /** A record out of the live set, already hidden: its held rows queued for release. */
  const queueRelease = (c: StagedColumn<R>): void => {
    c.revealed = false;
    if (c.released < c.uploaded) {
      removing.push(c);
      c.region.holding++;
    } else {
      maybeEmptied(c.region);
    }
  };

  /** A detached column: hidden at once, its held rows queued for release. */
  const retire = (c: StagedColumn<R>): void => {
    b.hide(c);
    queueRelease(c);
  };

  /** The swap of a live record whose every row is uploaded: `prev` hidden and `c` shown in one call, `prev` released. */
  const swapIn = (c: StagedColumn<R>): void => {
    const prev = c.prev!;
    c.prev = null;
    b.swap(prev, c);
    c.revealed = true;
    queueRelease(prev);
  };

  const nearest = (): StagedColumn<R> | null => {
    let best: StagedColumn<R> | null = null;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]!;
      if (c.blockedAt === stamp) continue;
      if (best === null || c.score < best.score || (c.score === best.score && c.key < best.key)) best = c;
    }
    return best;
  };

  const perform = (c: StagedColumn<R>, k: StructuralKind): void => {
    const t0 = performance.now();
    lastStructuralBytes = b.structural(c, k);
    structuralMs += performance.now() - t0;
    structuralOps++;
    lastStructural = k;
  };

  const countRow = (c: StagedColumn<R>, r: number, sign: 1 | -1): void => {
    const o = r * ROW_INTS;
    rows += sign;
    vertices += sign * c.p.rows[o + 3]!;
    indices += sign * c.p.rows[o + 5]!;
  };

  /** The held rows of `c` that three draws. */
  const visibleRows = (c: StagedColumn<R>): number => {
    let n = 0;
    for (let r = c.released; r < c.uploaded; r++) if (!rowIsEmpty(c.p, r) && b.rowVisible(c, r)) n++;
    return n;
  };

  const self: SectionRenderer = {
    kind,
    root,
    onColumnRevealed: null,
    stage(p, seq) {
      const key = columnKey(p.cx, p.cz);
      const old = live.get(key);
      // A revealed column swaps: the shown record becomes `prev`. During a swap the pending record is replaced and its
      // `prev` kept; an unrevealed column's record is replaced (SP4c spec §5.1).
      let prev: StagedColumn<R> | null = null;
      if (old !== undefined) {
        prev = old.revealed ? old : old.prev;
        detach(old);
        old.prev = null;
        if (prev !== old) retire(old);
      }
      const region = regionFor(p.cx, p.cz);
      const n = p.rows.length / ROW_INTS;
      let nonEmpty = 0;
      for (let r = 0; r < n; r++) if (!rowIsEmpty(p, r)) nonEmpty++;
      // A replacement with no non-empty row has nothing to upload: it swaps in this call (an all-air column).
      const now = prev !== null && nonEmpty === 0;
      const c: StagedColumn<R> = {
        cx: p.cx, cz: p.cz, key, region, p, seq, rows: n, nonEmpty, uploaded: now ? n : 0, released: 0, revealed: false,
        prev, ids: new Int32Array(2 * n).fill(-1), score: 0, liveAt: -1, pendingAt: -1, blockedAt: -1,
      };
      attach(c, !now);
      if (now) {
        swapIn(c);
        const hook = self.onColumnRevealed;
        if (hook !== null) hook(c.cx, c.cz);
      }
    },
    unstage(cx, cz) {
      const c = live.get(columnKey(cx, cz));
      if (c === undefined || c.revealed) return false;
      const prev = c.prev;
      detach(c);
      c.prev = null;
      retire(c);
      // What the column shows stays: `prev` is its record again.
      if (prev !== null) attach(prev, false);
      return true;
    },
    remove(cx, cz) {
      const c = live.get(columnKey(cx, cz));
      if (c === undefined) return;
      const prev = c.prev;
      detach(c);
      c.prev = null;
      if (prev !== null) retire(prev);
      retire(c);
    },
    pump(gate: UploadGate, cx, cz, yawDeg) {
      stamp++;
      lastStructural = null;
      lastStructuralBytes = 0;
      // (1) Culling back on the objects three has uploaded.
      b.settle();
      const yaw = yawDeg * DEG;
      const fx = Math.sin(yaw);
      const fz = -Math.cos(yaw);
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i]!;
        c.score = streamScore(c.cx - cx, c.cz - cz, fx, fz, STAGE_BONUS.MESH);
      }
      let spent = 0;
      // (2) The nearest column's structural operation, before any row is spent.
      const first = nearest();
      if (first !== null) {
        const k = b.columnNeed(first);
        if (k !== null && gate.structural()) perform(first, k);
      }
      // (3) Releases, oldest removal first, each row against the cap.
      release: while (removingHead < removing.length) {
        const c = removing[removingHead]!;
        while (c.released < c.uploaded) {
          const r = c.released;
          if (!rowIsEmpty(c.p, r)) {
            if (gate.exhausted()) break release;
            b.release(c, r);
            countRow(c, r, -1);
            gate.spend(1);
            spent++;
          }
          c.released++;
        }
        removingHead++;
        c.region.holding--;
        maybeEmptied(c.region);
      }
      if (removingHead === removing.length) {
        removing.length = 0;
        removingHead = 0;
      } else if (removingHead >= 64) {
        removing.splice(0, removingHead);
        removingHead = 0;
      }
      for (let i = 0; i < emptied.length; i++) {
        const g = emptied[i]!;
        if (g.columns.length === 0 && g.holding === 0 && regions.get(g.key) === g) {
          regions.delete(g.key);
          b.disposeRegion(g);
        }
      }
      emptied.length = 0;
      // (4) Uploads, nearest column first; a column refused a structural operation waits for a later pump.
      completed.length = 0;
      while (!gate.exhausted()) {
        const c = nearest();
        if (c === null) break;
        let ops = 0;
        while (c.uploaded < c.rows) {
          const r = c.uploaded;
          if (!rowIsEmpty(c.p, r)) {
            if (gate.exhausted()) break;
            const k = b.rowNeed(c, r);
            if (k !== null) {
              if (!gate.structural()) {
                c.blockedAt = stamp;
                break;
              }
              if (++ops > MAX_OPS_PER_ROW) throw new Error(`row ${r} of column (${c.cx}, ${c.cz}) still needs '${k}' after ${MAX_OPS_PER_ROW} structural operations`);
              perform(c, k);
              continue;
            }
            b.upload(c, r);
            countRow(c, r, 1);
            gate.spend(1);
            spent++;
            ops = 0;
          }
          c.uploaded++;
        }
        if (c.uploaded === c.rows) {
          dropPending(c);
          complete++;
          completed.push(c);
        } else if (c.blockedAt !== stamp) {
          break;
        }
      }
      // (5) The reveals: each completed column's rows in one call; a replacement swaps with its `prev` in one call (the
      // column was already counted revealed).
      for (let i = 0; i < completed.length; i++) {
        const c = completed[i]!;
        if (c.prev !== null) {
          swapIn(c);
        } else {
          c.revealed = true;
          revealed++;
          b.reveal(c);
        }
      }
      const hook = self.onColumnRevealed;
      if (hook !== null) for (let i = 0; i < completed.length; i++) hook(completed[i]!.cx, completed[i]!.cz);
      completed.length = 0;
      return spent;
    },
    holdReveals(hold) {
      if (hold) root.visible = false;
    },
    revealAll() {
      root.visible = true;
    },
    addStandIns() {
      const made: Array<{ readonly object: Mesh; dispose(): void }> = [];
      for (const pass of [MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT]) {
        if (b.hasPass(pass)) continue;
        const s = b.standIn(pass);
        root.add(s.object);
        made.push(s);
      }
      return () => {
        for (const s of made) {
          root.remove(s.object);
          s.dispose();
        }
        made.length = 0;
      };
    },
    isRevealed(cx, cz) {
      const c = live.get(columnKey(cx, cz));
      return root.visible && c !== undefined && (c.revealed || c.prev !== null);
    },
    setOrigin(x, y, z) {
      b.setOrigin(x, y, z);
    },
    sortTranslucent(camX, camY, camZ) {
      b.sortTranslucent(camX, camY, camZ);
    },
    counts(out: SectionRendererCounts) {
      out.columnsStaged = liveList.length;
      out.columnsComplete = complete;
      out.columnsRevealed = revealed;
      out.columnsRemoving = removing.length - removingHead;
      out.regions = regions.size;
      out.rows = rows;
      out.vertices = vertices;
      out.indices = indices;
      out.structuralOps = structuralOps;
      out.structuralMs = structuralMs;
      out.lastStructural = lastStructural;
      out.lastStructuralBytes = lastStructuralBytes;
      return out;
    },
    gpuBytes() {
      return b.gpuBytes();
    },
    probe(out: RevealProbe) {
      out.columns = liveList.length + removing.length - removingHead;
      out.partial = 0;
      out.mixed = 0;
      for (let i = 0; i < liveList.length; i++) {
        const c = liveList[i]!;
        const v = visibleRows(c);
        if (v > 0 && v < c.nonEmpty) out.partial++;
        const prev = c.prev;
        if (prev === null) continue;
        // A swap's `prev` is a shown record of its own, and the column mixes seqs when both draw rows.
        out.columns++;
        const w = visibleRows(prev);
        if (w > 0 && w < prev.nonEmpty) out.partial++;
        if (v > 0 && w > 0) out.mixed++;
      }
      for (let i = removingHead; i < removing.length; i++) {
        const c = removing[i]!;
        const v = visibleRows(c);
        if (v > 0 && v < c.nonEmpty) out.partial++;
        const now = v > 0 ? live.get(c.key) : undefined;
        if (now !== undefined && visibleRows(now) + (now.prev === null ? 0 : visibleRows(now.prev)) > 0) out.mixed++;
      }
      return out;
    },
    dispose() {
      for (const g of regions.values()) b.disposeRegion(g);
      regions.clear();
      live.clear();
      liveList.length = 0;
      pending.length = 0;
      removing.length = 0;
      removingHead = 0;
      emptied.length = 0;
      complete = revealed = rows = vertices = indices = 0;
    },
  };
  return self;
}

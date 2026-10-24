import type { Group } from 'three';
import type { ColumnMeshPayload } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import { createRegionBatch } from './regionBatch';
import { createRegionMesh } from './regionMesh';

export { regionOf } from './regionGrid';

/**
 * The section renderers (SP4a spec §6.2; SP4b spec §4.1): the interface the page talks to, and the choice between
 * RegionBatch (one `BatchedMesh` per region and pass, wherever `WEBGL_multi_draw` exists) and RegionMesh (one buffer
 * per region and pass, `regionMesh.ts`). Both share the payload, the materials' GLSL and the column staging
 * (`regionGrid.ts`): columns enter and leave for as long as the page runs, their rows are uploaded nearest-first under
 * the frame's `UploadGate`, and a column is shown in the call that uploads its last row, all its rows at once.
 *
 * Geometry is in 1/8-block units. Each region's object carries the region origin `(rx·128, −64, rz·128)` minus the
 * floating origin, so a rebase moves regions, not instances (SP4b spec §4.2): on RegionBatch each row's instance matrix
 * is `T(the section's offset in its region) · S(1/8)`, on RegionMesh the positions are region-local.
 */

export type SectionRendererKind = 'batch' | 'mesh';

/**
 * The frame's upload budget as the section renderer sees it (SP4b spec §3.9): declared here because render may not
 * import engine; engine's `UploadBudget` satisfies it structurally. `structural()` asks for the frame's structural
 * operation: granted once a frame and only while no row was spent in it; on every call under the loading budget.
 */
export interface UploadGate {
  exhausted(): boolean;
  spend(rows: number): void;
  structural(): boolean;
}

/**
 * A structural operation (SP4b spec §3.9, D13): a region's object created or grown in vertices and indices, its
 * instance table grown or its buffers optimised (RegionBatch), its arena compacted (RegionMesh).
 */
export type StructuralKind = 'create' | 'grow' | 'instances' | 'optimize' | 'compact';

/**
 * R7's probe (SP4b spec §8.1), read from three's objects: `columns` the column records the staging lists (staged, and
 * removed with rows still held), `partial` those showing some but not all of their non-empty rows, `mixed` the
 * columns showing rows of two seqs.
 */
export interface RevealProbe {
  columns: number;
  partial: number;
  mixed: number;
}

export interface SectionRendererCounts {
  /** Columns staged and not removed (complete and revealed ones included). */
  columnsStaged: number;
  /** Staged columns whose every row is uploaded. */
  columnsComplete: number;
  /** Staged columns shown in their objects (inside the hidden root while reveals are held). */
  columnsRevealed: number;
  /** Removed or replaced columns whose rows are not all released yet. */
  columnsRemoving: number;
  /** Regions holding a staged column or rows to release. */
  regions: number;
  /** Rows held by the region objects (one per section and pass), with their vertices and indices. */
  rows: number;
  vertices: number;
  indices: number;
  /** Structural operations since the renderer was created, and their main-thread ms. */
  structuralOps: number;
  structuralMs: number;
  /**
   * The structural operation the last `pump` performed (the last one, under the loading budget) and its object's
   * bytes after it; reset at the start of each pump (the bench's structural frames, SP4b spec §8.3).
   */
  lastStructural: StructuralKind | null;
  lastStructuralBytes: number;
}

export function createSectionRendererCounts(): SectionRendererCounts {
  return {
    columnsStaged: 0, columnsComplete: 0, columnsRevealed: 0, columnsRemoving: 0, regions: 0, rows: 0, vertices: 0,
    indices: 0, structuralOps: 0, structuralMs: 0, lastStructural: null, lastStructuralBytes: 0,
  };
}

export function createRevealProbe(): RevealProbe {
  return { columns: 0, partial: 0, mixed: 0 };
}

export interface SectionRenderer {
  readonly kind: SectionRendererKind;
  /** Holds every region object; hidden by `holdReveals(true)` until `revealAll` (the first entry, SP4b spec §3.11). */
  readonly root: Group;
  /**
   * Queues a column's payload with the coordinator's `meshSeq`: an unrevealed staged column is replaced (its uploaded
   * rows are released under the gate); a revealed one throws (SP4b D16: the swap is SP4c's).
   */
  stage(p: ColumnMeshPayload, seq: number): void;
  /** Hides the column at once; `pump` releases its rows under the gate. A column that is not staged is ignored. */
  remove(cx: number, cz: number): void;
  /**
   * The frame's uploads (SP4b spec §3.9): restores culling on the objects with no pending update range, performs the
   * nearest column's structural operation before any release when the gate grants it, releases removed rows, uploads
   * staged rows nearest-first from column (cx, cz) and the yaw (`streamScore`'s MESH score), and reveals every column
   * whose last row it uploaded. Returns the rows spent (released and uploaded).
   */
  pump(gate: UploadGate, cx: number, cz: number, yawDeg: number): number;
  /** `true` hides the root: complete columns are revealed inside it, and `revealAll` shows it. */
  holdReveals(hold: boolean): void;
  /** Shows the root, in this one call. */
  revealAll(): void;
  /** Whether column (cx, cz) shows: revealed, with the root visible (the fog's filled radius, SP4b spec §5). */
  isRevealed(cx: number, cz: number): boolean;
  /**
   * Adds to `root` a hidden stand-in for each pass no region object draws yet: one triangle over the pass's material, on
   * this renderer's own object kind (a `BatchedMesh` or a region mesh), so the load's compile links every pass's program
   * even when the spawn has no geometry of that pass (`compileScene`, rulings R11; a program first linked mid-flight
   * stalls that frame). The call it returns removes and frees them; a second call does nothing. They are no region:
   * counts, `gpuBytes` and the probe never see them.
   */
  addStandIns(): () => void;
  /** Sets the floating origin (blocks): moves each region's object, O(regions). */
  setOrigin(x: number, y: number, z: number): void;
  /**
   * Orders translucent geometry back to front from the camera at (camX, camY, camZ), given in the frame of
   * `camera.position`, that is relative to the current floating origin (ruling P17). A no-op on RegionBatch, where
   * `BatchedMesh` sorts its instances itself; RegionMesh orders its regions by centre.
   */
  sortTranslucent(camX: number, camY: number, camZ: number): void;
  counts(out: SectionRendererCounts): SectionRendererCounts;
  /** The allocated geometry bytes: every live region object's attribute and index arrays (SP4b spec §8.4). */
  gpuBytes(): number;
  probe(out: RevealProbe): RevealProbe;
  /** Called in the call that reveals a column (SP11's fill mask); no listener in SP4b. */
  onColumnRevealed: ((cx: number, cz: number) => void) | null;
  /** Frees every geometry and object and empties `root`; the materials stay the system's. */
  dispose(): void;
}

/** RegionBatch where `WEBGL_multi_draw` exists, RegionMesh where it is missing; `override` (`?renderer`) wins. */
export function selectSectionRenderer(report: { readonly multiDraw: boolean }, override: SectionRendererKind | null): SectionRendererKind {
  return override ?? (report.multiDraw ? 'batch' : 'mesh');
}

/** The section renderer of `kind`; `materials` must be the system of the same variant. */
export function createSectionRenderer(kind: SectionRendererKind, materials: MaterialSystem): SectionRenderer {
  if (materials.variant !== kind) {
    throw new Error(`a '${kind}' section renderer needs the '${kind}' material variant, got '${materials.variant}'`);
  }
  return kind === 'mesh' ? createRegionMesh(materials) : createRegionBatch(materials);
}

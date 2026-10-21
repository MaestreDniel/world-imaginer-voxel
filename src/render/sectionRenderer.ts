import type { Group } from 'three';
import type { ColumnMeshPayload } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import { createRegionBatch } from './regionBatch';

export { regionOf } from './regionGrid';

/**
 * The section renderers (SP4a spec §6.2): the interface the page talks to, and the choice between RegionBatch (one
 * `BatchedMesh` per region and pass, wherever `WEBGL_multi_draw` exists) and RegionMesh (merged buffers per region
 * and pass, Task 22). Both share the payload, the materials' GLSL and the region grid (`regionGrid.ts`).
 *
 * Geometry is in 1/8-block units: every instance or mesh matrix is `T(origin − floatingOrigin) · S(1/8)`, the origin
 * being the section's `(cx·16, sy·16 − 64, cz·16)` on RegionBatch and the region's on RegionMesh.
 */

export type SectionRendererKind = 'batch' | 'mesh';

export interface SectionRendererCounts {
  readonly expectedColumns: number;
  /** Columns staged so far (built regions' columns included). */
  readonly stagedColumns: number;
  /** Regions that hold an expected column. */
  readonly regions: number;
  readonly builtRegions: number;
  /** Sections built: one per payload row, that is per section and pass. */
  readonly sections: number;
  /** Vertices and indices built (the payload rows' sums over the built regions). */
  readonly vertices: number;
  readonly indices: number;
  /** RegionMesh's merge time; 0 for RegionBatch. */
  readonly mergeMs: number;
}

export interface SectionRenderer {
  readonly kind: SectionRendererKind;
  /** Holds every built object; hidden until `revealAll` (master §4.2's atomic reveal, spec §8.4). */
  readonly root: Group;
  /** Adds columns to the expected set: a region is built once all its expected columns are staged. */
  expect(columns: ReadonlyArray<readonly [number, number]>): void;
  /** Stages one column's payload; throws for a column that is not expected or is already staged. */
  stage(p: ColumnMeshPayload): void;
  /**
   * Builds, nearest region first, every region whose expected columns are all staged; checks `exhausted()` before each
   * region (the upload budget, spec §6.2) and returns the number of sections added.
   */
  buildNext(exhausted: () => boolean): number;
  /** Shows the root and every built object, in this one call. */
  revealAll(): void;
  /** Sets the floating origin (blocks) and rebases every matrix to it. */
  setOrigin(x: number, y: number, z: number): void;
  /**
   * Orders translucent geometry back to front from the camera at (camX, camY, camZ), given in the frame of
   * `camera.position`, that is relative to the current floating origin (ruling P17). A no-op on RegionBatch, where
   * `BatchedMesh` sorts its instances itself; RegionMesh (Task 22) orders its regions.
   */
  sortTranslucent(camX: number, camY: number, camZ: number): void;
  counts(): SectionRendererCounts;
  /** Frees every geometry and batch and empties `root`; the materials stay the system's. */
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
  if (kind === 'mesh') throw new Error('RegionMesh arrives in Task 22');
  return createRegionBatch(materials);
}

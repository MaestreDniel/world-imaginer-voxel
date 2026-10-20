/**
 * The column mesh payload (SP4a spec §5.8, D12): one `meshColumn` result, the 24 sections of a column in shared
 * buffers with one row per non-empty (section, pass). The renderer wraps subarrays per row; each row is master §2.5's
 * `SectionMesh`. This module holds the type and its structural check; the assembly is `meshColumnPayload` (Task 15).
 */

/** The three passes of a row (SP4a spec §5.2). */
export const MESH_PASS_OPAQUE = 0;
export const MESH_PASS_CUTOUT = 1;
export const MESH_PASS_TRANSLUCENT = 2;

/** Int32s per row of `ColumnMeshPayload.rows`: sy, pass, vertexStart, vertexCount, indexStart, indexCount. */
export const ROW_INTS = 6;

const SECTIONS = 24;
const VERSION_COUNT = 18;

export interface ColumnMeshPayload {
  readonly cx: number;
  readonly cz: number;
  /** The 3 × 3 neighbourhood's block and light versions, read before the copy (18). */
  readonly versions: Int32Array;
  /** `connectivity15` per section, sy 0-23 (SP4a spec §5.7) (24). */
  readonly connectivity: Uint16Array;
  /** Uint8 × 4 per vertex: x·8, y·8, z·8, 0, section-local in 1/8-block units. */
  readonly position: Uint8Array;
  /** One `PACK_LAYOUT` word per vertex. */
  readonly data: Uint32Array;
  /** Six per quad, relative to the row's first vertex. */
  readonly index: Uint32Array;
  /** `ROW_INTS` per row: sy, pass, vertexStart, vertexCount, indexStart, indexCount. */
  readonly rows: Int32Array;
  /** Four per row: the bounding sphere x, y, z, r in section-local blocks. */
  readonly spheres: Float32Array;
}

/** Null when the payload's buffers are consistent, otherwise the first problem found. */
export function payloadProblem(p: ColumnMeshPayload): string | null {
  if (p.versions.length !== VERSION_COUNT) return `versions has ${p.versions.length} values, expected ${VERSION_COUNT}`;
  if (p.connectivity.length !== SECTIONS) return `connectivity has ${p.connectivity.length} values, expected ${SECTIONS}`;
  if (p.rows.length % ROW_INTS !== 0) return `rows has ${p.rows.length} values, not a multiple of ${ROW_INTS}`;
  const rowCount = p.rows.length / ROW_INTS;
  if (p.spheres.length !== 4 * rowCount) return `spheres has ${p.spheres.length} values, expected 4 × ${rowCount} rows`;
  const vertices = Math.min(p.data.length, Math.floor(p.position.length / 4));
  for (let r = 0; r < rowCount; r++) {
    const o = r * ROW_INTS;
    const sy = p.rows[o]!;
    const pass = p.rows[o + 1]!;
    const vertexStart = p.rows[o + 2]!;
    const vertexCount = p.rows[o + 3]!;
    const indexStart = p.rows[o + 4]!;
    const indexCount = p.rows[o + 5]!;
    if (sy < 0 || sy >= SECTIONS) return `row ${r}: sy ${sy} is outside 0…${SECTIONS - 1}`;
    if (pass < MESH_PASS_OPAQUE || pass > MESH_PASS_TRANSLUCENT) return `row ${r}: pass ${pass} is outside 0…2`;
    if (vertexStart < 0 || vertexCount < 0 || vertexStart + vertexCount > vertices) {
      return `row ${r}: vertex range ${vertexStart}+${vertexCount} is past the ${vertices} vertices (data ${p.data.length}, position ${p.position.length} / 4)`;
    }
    if (indexStart < 0 || indexCount < 0 || indexStart + indexCount > p.index.length) {
      return `row ${r}: index range ${indexStart}+${indexCount} is past index.length ${p.index.length}`;
    }
    for (let i = indexStart; i < indexStart + indexCount; i++) {
      if (p.index[i]! >= vertexCount) return `row ${r}: index ${p.index[i]} at ${i} is not below the row's vertexCount ${vertexCount}`;
    }
  }
  return null;
}

/**
 * The column mesh payload (SP4a spec §5.8, D12): one `meshColumn` result, the 24 sections of a column in shared
 * buffers with one row per non-empty (section, pass). The renderer wraps subarrays per row; each row is master §2.5's
 * `SectionMesh`. This module holds the type, its structural check and the assembly, `meshColumnPayload`: per section
 * the trivial-section rule (§5.1), else the padded copy, `meshSolid`, `fluidDepths` and `meshFluid` (ruling P24) and
 * `connectivity15` (§5.7).
 */
import { AIR, BEDROCK, FULL_FACES, PASS } from '../world/blocks/index';
import { hasFluid } from '../world/blocks/fluid';
import { ALL_FACES, PASS_OPAQUE } from '../world/blocks/kinds';
import type { ColumnView, NeighborhoodReader } from '../world/store/api';
import { copyPaddedSection, createPaddedSection, type PaddedSection } from '../world/store/padded';
import { createMeshBuilder, type MeshBuilder, type MeshPass, type MeshView } from './builder';
import { connectivity15 } from './connectivity';
import { fluidDepths, meshFluid } from './fluid';
import { meshSolid, type MeshOptions } from './greedy';

const AIR_STATE = AIR;
const BEDROCK_STATE = BEDROCK;
const PASS_OF = PASS;
const FULL_FACES_OF = FULL_FACES;
const OPAQUE = PASS_OPAQUE;
const FULL = ALL_FACES;
const isFluid = hasFluid;
const COPY_PADDED = copyPaddedSection;
const MESH_SOLID = meshSolid;
const MESH_FLUID = meshFluid;
const FLUID_DEPTHS = fluidDepths;
const CONNECTIVITY = connectivity15;
const NEW_PADDED = createPaddedSection;
const NEW_BUILDER = createMeshBuilder;

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

/** `connectivity15` of an all-air section (every pair) and of an all-opaque one (none) (SP4a spec §5.7). */
const ALL_PAIRS = 0x7FFF;
const NO_PAIRS = 0;
/** At most one row per section and pass. */
const MAX_ROWS = 3 * SECTIONS;
/** Vertices the column buffers hold before their first growth (a column's median is ≈ 1,500 quads, 6,000 vertices). */
const INITIAL_VERTICES = 8192;

/**
 * The column's output so far, reused across columns: grown by doubling, never shrunk. The payload copies exact
 * slices of it (ruling P27), so nothing of it is ever handed out.
 */
export interface ColumnBuffers {
  position: Uint8Array;
  data: Uint32Array;
  index: Uint32Array;
  /** `ROW_INTS` per row, at most one row per section and pass. */
  readonly rows: Int32Array;
  /** Four per row. */
  readonly spheres: Float32Array;
  vertices: number;
  indices: number;
  rowCount: number;
}

/**
 * The mesh job's worker-local scratch (allocated once per worker, reused for every column): the padded view, the
 * builder, `fluidDepths`' output (ruling P24) and the column buffers.
 */
export interface MeshScratch {
  readonly padded: PaddedSection;
  readonly builder: MeshBuilder;
  /** The water depth of the section being meshed: 4096, section-local `y·256 + z·16 + x` (`fluidDepths`). */
  readonly depth: Uint8Array;
  readonly column: ColumnBuffers;
}

export function createMeshScratch(): MeshScratch {
  return {
    padded: NEW_PADDED(),
    builder: NEW_BUILDER(),
    depth: new Uint8Array(4096),
    column: {
      position: new Uint8Array(4 * INITIAL_VERTICES),
      data: new Uint32Array(INITIAL_VERTICES),
      index: new Uint32Array(INITIAL_VERTICES * 3 / 2),
      rows: new Int32Array(ROW_INTS * MAX_ROWS),
      spheres: new Float32Array(4 * MAX_ROWS),
      vertices: 0,
      indices: 0,
      rowCount: 0,
    },
  };
}

/** The trivial class of one section's descriptors: 1 uniform air without fluid, 2 a uniform opaque full cube, else 0. */
function classOf(blocks: Uint16Array | number, fluid: Uint8Array | number): 0 | 1 | 2 {
  if (typeof blocks !== 'number') return 0;
  if (blocks === AIR_STATE) return typeof fluid === 'number' && !isFluid(fluid) ? 1 : 0;
  // A fluid byte inside an opaque full cube draws nothing: every face of it is occluded.
  return PASS_OF[blocks] === OPAQUE && FULL_FACES_OF[blocks] === FULL ? 2 : 0;
}

/** The class below the world (`BEDROCK`) and above it (air without fluid), as `copyPaddedSection` reads them. */
const BELOW_CLASS = classOf(BEDROCK_STATE, 0);
const ABOVE_CLASS = classOf(AIR_STATE, 0);

function classAt(v: ColumnView, sy: number): 0 | 1 | 2 {
  if (sy < 0) return BELOW_CLASS;
  if (sy >= SECTIONS) return ABOVE_CLASS;
  return classOf(v.sectionBlocks(sy), v.sectionFluid(sy));
}

function finalOf(nb: NeighborhoodReader, dx: number, dz: number): ColumnView {
  const v = nb.final(dx, dz);
  if (v === null) throw new Error(`isTrivial: column (${nb.cx + dx}, ${nb.cz + dz}) has no final set`);
  return v;
}

/**
 * The trivial-section rule (SP4a spec §5.1; plan): 1 when section `sy` of the centre column is uniform air without
 * fluid and so are its six face neighbours (below the world counts as `BEDROCK`, above it as air), 2 when it and its six
 * neighbours are uniform opaque full cubes (PASS opaque, `FULL_FACES` 63; the states may differ), else 0. A trivial
 * section meshes to nothing, and its connectivity is 0x7FFF (1) or 0 (2). Reads the descriptors only, with no copy;
 * throws when a column it needs has no final set.
 */
export function isTrivial(nb: NeighborhoodReader, sy: number): 0 | 1 | 2 {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`isTrivial: section ${sy} outside 0 … ${SECTIONS - 1}`);
  const c = finalOf(nb, 0, 0);
  const k = classAt(c, sy);
  if (k === 0 || classAt(c, sy - 1) !== k || classAt(c, sy + 1) !== k) return 0;
  if (classAt(finalOf(nb, 0, -1), sy) !== k || classAt(finalOf(nb, 1, 0), sy) !== k) return 0;
  if (classAt(finalOf(nb, 0, 1), sy) !== k || classAt(finalOf(nb, -1, 0), sy) !== k) return 0;
  return k;
}

/** Shared views for rounding a radius up to the next float32. */
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** The smallest float32 ≥ r (r ≥ 0, finite), so a stored radius never shrinks below the exact one. */
function f32Up(r: number): number {
  F32[0] = r;
  if (F32[0]! < r) U32[0] = U32[0]! + 1;
  return F32[0]!;
}

/** Room for `vertices` more vertices and `indices` more indices, doubling the column buffers as needed. */
function reserve(c: ColumnBuffers, vertices: number, indices: number): void {
  if (c.vertices + vertices > c.data.length) {
    let n = c.data.length;
    while (c.vertices + vertices > n) n *= 2;
    const position = new Uint8Array(4 * n);
    const data = new Uint32Array(n);
    position.set(c.position.subarray(0, 4 * c.vertices));
    data.set(c.data.subarray(0, c.vertices));
    c.position = position;
    c.data = data;
  }
  if (c.indices + indices > c.index.length) {
    let n = c.index.length;
    while (c.indices + indices > n) n *= 2;
    const index = new Uint32Array(n);
    index.set(c.index.subarray(0, c.indices));
    c.index = index;
  }
}

/**
 * Appends one pass of a section as a row: its vertices and indices (already relative to the pass's first vertex) and
 * its bounding sphere in section-local blocks, centred on the vertices' AABB with the half diagonal as radius.
 */
function appendRow(c: ColumnBuffers, sy: number, pass: MeshPass, v: MeshView): void {
  reserve(c, v.vertices, v.indices);
  c.position.set(v.position, 4 * c.vertices);
  c.data.set(v.data, c.vertices);
  c.index.set(v.index, c.indices);
  let x0 = 255, y0 = 255, z0 = 255, x1 = 0, y1 = 0, z1 = 0;
  const pos = v.position;
  for (let o = 0; o < pos.length; o += 4) {
    const x = pos[o]!;
    const y = pos[o + 1]!;
    const z = pos[o + 2]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const r = c.rowCount;
  const o = r * ROW_INTS;
  c.rows[o] = sy;
  c.rows[o + 1] = pass;
  c.rows[o + 2] = c.vertices;
  c.rows[o + 3] = v.vertices;
  c.rows[o + 4] = c.indices;
  c.rows[o + 5] = v.indices;
  // Positions are in 1/8 blocks: the centre (lo + hi) / 16 is exact in float32, the radius rounds up.
  c.spheres[4 * r] = (x0 + x1) / 16;
  c.spheres[4 * r + 1] = (y0 + y1) / 16;
  c.spheres[4 * r + 2] = (z0 + z1) / 16;
  c.spheres[4 * r + 3] = f32Up(Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) / 16);
  c.vertices += v.vertices;
  c.indices += v.indices;
  c.rowCount = r + 1;
}

const PASSES: readonly MeshPass[] = [0, 1, 2];

/**
 * The mesh payload of the centre column of `nb` (SP4a spec §5.8), whose 3 × 3 holds final sets (the job checks they are
 * Published). `versions` is read first, before any copy. Per section: a trivial one (`isTrivial`) gets connectivity
 * 0x7FFF or 0 and no rows; any other is copied into the padded view and meshed (`meshSolid`, then `fluidDepths` and
 * `meshFluid`), with `connectivity15` and one row per non-empty pass, in (sy, pass) order. The column has one position,
 * one data and one index buffer, indices relative to each row's `vertexStart`. Every array of the payload is a fresh,
 * exact, unshared copy (ruling P27): `s` is reused by the next call, and the job transfers each buffer.
 */
export function meshColumnPayload(nb: NeighborhoodReader, s: MeshScratch, o: MeshOptions): ColumnMeshPayload {
  const versions = nb.versions();
  const connectivity = new Uint16Array(SECTIONS);
  const c = s.column;
  c.vertices = 0;
  c.indices = 0;
  c.rowCount = 0;
  for (let sy = 0; sy < SECTIONS; sy++) {
    const t = isTrivial(nb, sy);
    if (t !== 0) {
      connectivity[sy] = t === 1 ? ALL_PAIRS : NO_PAIRS;
      continue;
    }
    COPY_PADDED(nb, sy, s.padded);
    s.builder.reset();
    MESH_SOLID(s.padded, o, s.builder);
    FLUID_DEPTHS(nb, sy, s.depth);
    MESH_FLUID(s.padded, s.depth, s.builder);
    connectivity[sy] = CONNECTIVITY(s.padded);
    for (const pass of PASSES) {
      const v = s.builder.view(pass);
      if (v.indices > 0) appendRow(c, sy, pass, v);
    }
  }
  return {
    cx: nb.cx,
    cz: nb.cz,
    versions,
    connectivity,
    position: c.position.slice(0, 4 * c.vertices),
    data: c.data.slice(0, c.vertices),
    index: c.index.slice(0, c.indices),
    rows: c.rows.slice(0, ROW_INTS * c.rowCount),
    spheres: c.spheres.slice(0, 4 * c.rowCount),
  };
}

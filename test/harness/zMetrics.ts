import { HEIGHT, MIN_Y } from '../../src/core/constants';
import { components, type Components, type Connectivity } from './flood';

/**
 * Pure helpers of the Z1-Z3 diagnostics (SP3e spec §5.3), unit-tested on constructed inputs (`zMetrics.test.ts`).
 *
 * Columns: a position's vertical column is an array indexed `y − MIN_Y` (y −64 … 319, `HEIGHT` = 384 entries),
 * non-zero = solid (any block but air); `positionColumn` reads one out of the chunk solidity layout
 * `((y + 64) << 8) | p` that the T metrics use. A run is a maximal vertical solid run, `bottom` and `top` its lowest
 * and highest solid voxels (world y, inclusive). An island run is a run whose bottom voxel is at y ≥ `minBottom` (Z3
 * passes `ISLAND_RUN_MIN_BOTTOM`, 181: a run reaching below it — the ground, a peak, an overhang lip — is not an
 * island).
 *
 * Rasters: Z2 labels the land cells (offset0 ≥ 63) of a `waterRaster` with 4-connectivity; an island is a component
 * whose area n_cells · step² is ≥ 10⁶ block² (1 km²). The raster is the measured extent, so a component touching its
 * border counts by its clipped area (the cells inside the raster).
 */

/** One maximal vertical solid run (world y, inclusive). */
export interface Run {
  readonly bottom: number;
  readonly top: number;
}

/** Block² per km². */
const KM2 = 1e6;

/** The solid runs of a column (index y − MIN_Y, non-zero = solid), bottom to top. */
export function solidRuns(column: ArrayLike<number>): Run[] {
  const runs: Run[] = [];
  let bottom = -1;
  for (let i = 0; i <= column.length; i++) {
    const solid = i < column.length && column[i] !== 0;
    if (solid && bottom < 0) bottom = i;
    else if (!solid && bottom >= 0) {
      runs.push({ bottom: bottom + MIN_Y, top: i - 1 + MIN_Y });
      bottom = -1;
    }
  }
  return runs;
}

/** The island runs of a column: its solid runs whose bottom voxel is at y ≥ `minBottom`, bottom to top. */
export function islandRuns(column: ArrayLike<number>, minBottom: number): Run[] {
  return solidRuns(column).filter((r) => r.bottom >= minBottom);
}

/** The ground run of a column: its highest solid run whose bottom voxel is at y < `minBottom` (null if none). */
export function groundRun(column: ArrayLike<number>, minBottom: number): Run | null {
  let ground: Run | null = null;
  for (const r of solidRuns(column)) if (r.bottom < minBottom) ground = r;
  return ground;
}

/** Position p's column (index y − MIN_Y) out of a chunk solidity array indexed `((y + 64) << 8) | p`. */
export function positionColumn(solid: ArrayLike<number>, p: number, out: Uint8Array = new Uint8Array(HEIGHT)): Uint8Array {
  for (let i = 0; i < HEIGHT; i++) out[i] = solid[(i << 8) | p] === 0 ? 0 : 1;
  return out;
}

/** Components of a land mask plus, per label, whether it touches the raster border (1) or not (0). */
export interface LandComponents extends Components {
  readonly border: Uint8Array;
}

/** Labels the land cells (non-zero) of a row-major n × n mask with the given connectivity (Z2: 4). */
export function landComponents(mask: Uint8Array, n: number, connectivity: Connectivity): LandComponents {
  const c = components(mask, n, connectivity);
  const border = new Uint8Array(c.count + 1);
  for (let id = 1; id <= c.count; id++) {
    const b = 4 * id;
    if (c.bbox[b] === 0 || c.bbox[b + 1] === 0 || c.bbox[b + 2] === n - 1 || c.bbox[b + 3] === n - 1) border[id] = 1;
  }
  return { ...c, border };
}

/** Area in km² of component `id` at `step` blocks per cell (its clipped area if it touches the border). */
export function componentKm2(c: Components, id: number, step: number): number {
  return (c.size[id]! * step * step) / KM2;
}

/** Islands: components whose (clipped) area is ≥ 1 km² (n_cells · step² ≥ 10⁶ block²). */
export function islandCount(c: Components, step: number): number {
  let count = 0;
  for (let id = 1; id <= c.count; id++) if (c.size[id]! * step * step >= KM2) count++;
  return count;
}

/** Islands (≥ 1 km², border-touching ones by clipped area) per 100 km² of an n × n raster at `step` blocks per cell. */
export function islandsPer100km2(c: Components, n: number, step: number): number {
  const rasterKm2 = (n * step * n * step) / KM2;
  return islandCount(c, step) / (rasterKm2 / 100);
}

/** Z2's size classes in km², in order: [0, 1), [1, 5), [5, 25), [25, 100), [100, ∞). */
export const SIZE_CLASSES = ['lt1', '1to5', '5to25', '25to100', 'ge100'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];
const SIZE_CLASS_EDGES_KM2 = [1, 5, 25, 100] as const;

/** Components per size class (every component, clipped areas at the border). */
export function sizeClasses(c: Components, step: number): Record<SizeClass, number> {
  const out: Record<SizeClass, number> = { lt1: 0, '1to5': 0, '5to25': 0, '25to100': 0, ge100: 0 };
  for (let id = 1; id <= c.count; id++) {
    const km2 = componentKm2(c, id, step);
    let k = 0;
    while (k < SIZE_CLASS_EDGES_KM2.length && km2 >= SIZE_CLASS_EDGES_KM2[k]!) k++;
    out[SIZE_CLASSES[k]!]++;
  }
  return out;
}

/** What `columnStates` reads of a generated column: its 24 proto block sections (a `ColumnView` is one). */
export interface BlockSections {
  sectionBlocks(sy: number): Uint16Array | number;
}

/**
 * A generated column's block states in the chunk layout `((y + 64) << 8) | p` (uniform sections expanded), written into
 * `out` and returned. Air is state 0, so `positionColumn(states, p)` reads a position's solidity out of it (Z3 reads
 * the states of island tops and ground tops from the same array).
 */
export function columnStates(view: BlockSections, out: Uint16Array = new Uint16Array(HEIGHT << 8)): Uint16Array {
  for (let sy = 0; sy < HEIGHT >> 4; sy++) {
    const b = view.sectionBlocks(sy);
    const base = sy << 12;
    if (typeof b === 'number') out.fill(b, base, base + 4096);
    else out.set(b, base);
  }
  return out;
}

/**
 * Whether the islands surface branch's predicate (SP3e spec §4.1: `yAbove{minY: minBottom, runTop: true}` then
 * `stoneDepth{ceiling, ceilingOffset}`, which hold iff runTop ≥ minBottom and y − runBottom ≤ ceilingOffset) holds at
 * the top voxel of `run`, i.e. the branch gives that run its grass top when the run is sky-open. Z3's
 * `branchFalsePositives` applies it to a position's sky-open run (its highest) whose bottom is < minBottom (a peak or an
 * overhang lip capped with grass) or at islandMask 0. Decided from solidity alone, so it holds with either rules tree.
 */
export function branchHoldsAtTop(run: Run, minBottom: number, ceilingOffset: number): boolean {
  return run.top >= minBottom && run.top - run.bottom <= ceilingOffset;
}

/** Nearest-rank quantile of an ascending array (q ∈ (0, 1]); NaN for an empty one. */
export function nearestRank(sorted: ArrayLike<number>, q: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

/**
 * Z1's top histogram: counts of the values in [lo, hi] per `bin`-block bin [b, b + bin) (the last bin is cut at hi),
 * keyed `<prefix><b>`, b = lo, lo + bin, …, in that order (every bin present, zeros included).
 */
export function binCounts(values: ArrayLike<number>, lo: number, hi: number, bin: number, prefix: string): Record<string, number> {
  if (!(bin > 0) || !(hi >= lo)) throw new RangeError(`binCounts: bins of ${bin} over [${lo}, ${hi}]`);
  const out: Record<string, number> = {};
  for (let b = lo; b <= hi; b += bin) out[`${prefix}${b}`] = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < lo || v > hi) continue;
    const key = `${prefix}${lo + Math.floor((v - lo) / bin) * bin}`;
    out[key]!++;
  }
  return out;
}

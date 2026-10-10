/**
 * The slice viewer's sample geometry and horizontal-plane samples (SP3d spec §4.2, §4.4, D16). The field evaluation
 * that uses them arrives with the slice job (§5.1).
 *
 * Geometry: a plane has n × n samples (n ∈ SLICE_NS), indexed (sample column, sample) — the pool splits by sample
 * columns. Vertical: sample column i is the line's point i, (xᵢ, zᵢ) = `segmentPointAt(segment, i, n)` of
 * `metrics/crossSection.ts`, which gen cannot import: the caller (the worker, the UI) injects it as `pointAt(i)` and
 * checks the segment with `segmentProblem`; sample r is the voxel (⌊xᵢ⌋, y_r, ⌊zᵢ⌋) with the row centre
 * y_r = 319 − ⌊(2r + 1) · 384 / (2n)⌋. Horizontal: sample column j is the row z_j, sample i the voxel (x_i, y, z_j),
 * x_i = cx − E/2 + ⌊(2i + 1) · E / (2n)⌋ (z_j alike), the square [cx − E/2, cx + E/2] × [cz − E/2, cz + E/2] inside
 * the world window [−2^19, 2^19] (every sample then lies in the half-open window).
 *
 * Horizontal samples read corner samples (`buildCornerSample`, `gen/column/columnStage.ts`): only the four quart corners
 * a voxel reads, never a ColumnCache entry; with steep only when the evaluated expression reads `col steep` (through
 * refs); memoised per part by lattice coordinate (`createCornerSampler`). A field whose corner reads are not
 * bit-identical to a full ColumnSample's is listed in CORNER_FALLBACK_FIELDS (none: pinned by a test at 4,096 random
 * voxels), and an expression that reads one takes full samples instead.
 *
 * Follows the gen determinism rules; every lookup keyed by tree content is own-property only.
 */
import { HEIGHT, MIN_Y, SLICE_EXTENTS, SLICE_NS } from '../../core/constants';
import { MAX_Y, WINDOW_HALF } from '../../core/coords';
import { newPointRecord, samplePoint, type ColumnPoint, type PointRecord } from '../column/columnPoint';
import { buildCornerSample, newColumnSample, type ColumnSample, type SampleField } from '../column/columnStage';
import type { GenContext } from '../context';
import { EXPR_CHILD_KEYS, type DensityExpr, type Expr } from '../density/expr';

const HEIGHT_ = HEIGHT;
const MIN_Y_ = MIN_Y;
const MAX_Y_ = MAX_Y;
const W = WINDOW_HALF;
const NS = SLICE_NS;
const EXTENTS = SLICE_EXTENTS;
const SAMPLE_POINT = samplePoint;
const NEW_POINT = newPointRecord;
const CORNER_SAMPLE = buildCornerSample;
const NEW_SAMPLE = newColumnSample;
const CHILD_KEYS = EXPR_CHILD_KEYS;

/** A line point (xᵢ, zᵢ) in blocks. */
export type SlicePoint = readonly [x: number, z: number];

/** A vertical plane along A → B: `pointAt(i)` = `segmentPointAt(segment, i, n)` for a segment without a problem. */
export interface VerticalSliceGeometry {
  readonly plane: 'vertical';
  readonly n: number;
  readonly pointAt: (i: number) => SlicePoint;
}
/** A horizontal XZ plane at y, centred on (cx, cz), of side `extent` blocks. */
export interface HorizontalSliceGeometry {
  readonly plane: 'horizontal';
  readonly n: number;
  readonly cx: number;
  readonly cz: number;
  readonly y: number;
  readonly extent: number;
}
export type SliceGeometry = VerticalSliceGeometry | HorizontalSliceGeometry;

const nProblem = (n: number): string | null => ((NS as readonly number[]).includes(n) ? null : `n ${n} is not a slice size (${NS.join(', ')})`);
const extentProblem = (e: number): string | null => ((EXTENTS as readonly number[]).includes(e) ? null : `extent ${e} is not a slice extent (${EXTENTS.join(', ')})`);

function checkN(n: number): void {
  const p = nProblem(n);
  if (p !== null) throw new RangeError(p);
}
function checkIndex(v: number, n: number, what: string): void {
  if (!Number.isInteger(v) || v < 0 || v >= n) throw new RangeError(`${what} ${v} is outside [0, ${n})`);
}

/** Row r's y on a vertical plane of n rows: 319 − ⌊(2r + 1) · 384 / (2n)⌋ (318 … −63 at n = 128, 313 … −59 at 32). */
export function sliceRowY(r: number, n: number): number {
  checkN(n);
  checkIndex(r, n, 'row');
  return MAX_Y_ - Math.floor(((2 * r + 1) * HEIGHT_) / (2 * n));
}

/** Coordinate i of a horizontal plane's axis centred on c of side `extent`: c − E/2 + ⌊(2i + 1) · E / (2n)⌋, an integer. */
export function horizontalCoord(c: number, extent: number, i: number, n: number): number {
  const e = extentProblem(extent);
  if (e !== null) throw new RangeError(e);
  checkN(n);
  checkIndex(i, n, 'sample');
  if (!Number.isInteger(c)) throw new RangeError(`centre ${c} is not an integer`);
  return c - extent / 2 + Math.floor(((2 * i + 1) * extent) / (2 * n));
}

/**
 * Why a horizontal square has no slice, or null: an integer centre, an extent of SLICE_EXTENTS, and the square inside
 * the world window: cx − E/2 ≥ −2^19 and cx + E/2 ≤ 2^19, and the same for z. The worker refuses with this text; the UI
 * clamps the centre first.
 */
export function squareProblem(cx: number, cz: number, extent: number): string | null {
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) return `the centre (${cx}, ${cz}) is not a pair of integers`;
  const e = extentProblem(extent);
  if (e !== null) return e;
  const h = extent / 2;
  if (cx - h < -W || cx + h > W || cz - h < -W || cz + h > W) {
    return `the square x [${cx - h}, ${cx + h}] × z [${cz - h}, ${cz + h}] leaves the world window [${-W}, ${W}]`;
  }
  return null;
}

/**
 * Why a plane has no slice, or null: n ∈ SLICE_NS; horizontal: y an integer in [−64, 319] and `squareProblem`.
 * A vertical plane's segment is the caller's to check (`segmentProblem`), since its points are injected.
 */
export function sliceGeometryProblem(g: SliceGeometry): string | null {
  const n = nProblem(g.n);
  if (n !== null) return n;
  if (g.plane === 'vertical') return null;
  if (!Number.isInteger(g.y) || g.y < MIN_Y_ || g.y > MAX_Y_) return `y ${g.y} is not an integer in [${MIN_Y_}, ${MAX_Y_}]`;
  return squareProblem(g.cx, g.cz, g.extent);
}

/**
 * The voxel [x, y, z] of sample `k` of sample column `c` (both in [0, n)): vertical (⌊x_c⌋, y_k, ⌊z_c⌋), horizontal
 * (x_k, y, z_c). Throws a RangeError for indices outside [0, n), a bad n or extent, or a vertical point whose voxel
 * lies outside the half-open world window.
 */
export function sliceSampleVoxel(g: SliceGeometry, c: number, k: number): [number, number, number] {
  checkN(g.n);
  checkIndex(c, g.n, 'sample column');
  checkIndex(k, g.n, 'sample');
  if (g.plane === 'horizontal') return [horizontalCoord(g.cx, g.extent, k, g.n), g.y, horizontalCoord(g.cz, g.extent, c, g.n)];
  const [px, pz] = g.pointAt(c);
  const x = Math.floor(px);
  const z = Math.floor(pz);
  if (!(x >= -W && x < W && z >= -W && z < W)) throw new RangeError(`point (${px}, ${pz}) is outside the world window [${-W}, ${W})`);
  return [x, sliceRowY(k, g.n), z];
}

/**
 * The ColumnSample fields whose corner-sample reads are not bit-identical to a full ColumnSample's (§4.4): none. A
 * test compares every field at 4,096 random voxels and pins this list; an expression reading one of them is sampled
 * with full ColumnSamples on horizontal planes.
 */
export const CORNER_FALLBACK_FIELDS: readonly SampleField[] = Object.freeze([]);
const FALLBACK: ReadonlySet<SampleField> = new Set(CORNER_FALLBACK_FIELDS);

/**
 * The `col` fields an expression reads: the nodes reachable from the root through every child slot and through refs
 * (each def entered once; a def unreachable from the root is not read). Iterative; refs resolved by own property; a
 * ref to a missing def reads nothing.
 */
export function colFieldsRead(expr: DensityExpr): ReadonlySet<SampleField> {
  const out = new Set<SampleField>();
  const entered = new Set<string>();
  const seen = new Set<Expr>();
  const stack: Expr[] = [expr.root];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (seen.has(e)) continue;
    seen.add(e);
    if (e.op === 'col') out.add(e.field);
    else if (e.op === 'ref') {
      if (!entered.has(e.name) && Object.hasOwn(expr.defs, e.name)) {
        entered.add(e.name);
        stack.push(expr.defs[e.name]!);
      }
    } else {
      const rec = e as unknown as Readonly<Record<string, Expr>>;
      const keys = CHILD_KEYS[e.op];
      for (let i = keys.length - 1; i >= 0; i--) stack.push(rec[keys[i]!]!);
    }
  }
  return out;
}

/** Whether the expression reads `col steep` (through refs): its corner samples need steep (§4.4). */
export function readsSteep(expr: DensityExpr): boolean {
  return colFieldsRead(expr).has('steep');
}

/** How a horizontal plane samples an expression's columns: corner samples (with steep or not) or full ColumnSamples. */
export type HorizontalSampling = 'corner' | 'cornerSteep' | 'full';

/** The corner-vs-full rule (§4.4): full samples when the expression reads a CORNER_FALLBACK_FIELDS field. */
export function horizontalSampling(expr: DensityExpr): HorizontalSampling {
  const fields = colFieldsRead(expr);
  for (const f of fields) if (FALLBACK.has(f)) return 'full';
  return fields.has('steep') ? 'cornerSteep' : 'corner';
}

/** A per-part source of corner samples with its point memo. */
export interface CornerSampler {
  /** The corner sample of the voxel column at integer (x, z); the returned object is reused by the next call. */
  sample(x: number, z: number): ColumnSample;
  /** Distinct quart points computed so far. */
  readonly points: number;
}

/** Quart coordinates lie in [−2^17, 2^17]: offset and packed into one numeric key below 2^38. */
const Q_OFFSET = 131072;
const Q_SPAN = 524288;

/**
 * Corner samples for one part (§4.4): each quart point (world x, z multiples of 4) is computed once, by `samplePoint`
 * with or without steep, and kept in a Map by lattice coordinate, so neighbouring samples share it. The values are
 * those `buildCornerSample` computes without the memo, bit for bit.
 */
export function createCornerSampler(ctx: GenContext, withSteep: boolean): CornerSampler {
  const memo = new Map<number, PointRecord>();
  const out = NEW_SAMPLE();
  const pointAt = (x: number, z: number): ColumnPoint => {
    const key = (x / 4 + Q_OFFSET) * Q_SPAN + (z / 4 + Q_OFFSET);
    let p = memo.get(key);
    if (p === undefined) {
      p = SAMPLE_POINT(ctx, x, z, withSteep, NEW_POINT());
      memo.set(key, p);
    }
    return p;
  };
  return {
    sample: (x, z) => CORNER_SAMPLE(ctx, x, z, withSteep, out, pointAt),
    get points() { return memo.size; },
  };
}

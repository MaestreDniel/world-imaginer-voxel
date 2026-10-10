/**
 * The slice viewer's sample geometry, horizontal-plane samples and field evaluation (SP3d spec §3.4, §4, §5.1-§5.3,
 * D16, D17, D20). The worker's slice job only parses, calls `evaluateFieldSlice` / `probeField` and replies.
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
 * Fields (§4.1): `density` (the resolved tree's root) and `node` (§3.4's evaluated expression of a density node,
 * `resolveDensityNode`) by the reference evaluator, on both planes; `blocks` (the T stage's state and fluid, read from
 * an injected T-column source, since gen cannot reach the worker's store) and `rule` (1 when the voxel's rule path
 * passes through the selected rule, or the selected condition holds there; 0 otherwise; `SLICE_RULE_NA` on voxels the
 * rules never evaluate) on vertical planes only. A part covers the sample columns [from, to) and holds each sample
 * column's n samples in row order (index (c − from)·n + k), so parts concatenate into the whole. `stop()` is polled
 * once per sample. `probeField` evaluates one voxel exactly as a slice sample (full ColumnSamples, which the corner
 * samples equal bit for bit), polling `stop()` before acquiring its column and before evaluating. The DensityReferences
 * are memoised per GenContext: one for `density`, and an LRU of 8 node paths for `node`.
 *
 * `evaluatedExpression` and `sliceCostOf` give the work bound's column cost (§5.2) from params alone, for the UI and
 * the worker alike; they live here rather than in `cost.ts`, which `gen/density/source.ts` imports (tier 2's costs)
 * while they need source.ts's resolvers.
 *
 * Follows the gen determinism rules; every lookup keyed by tree content is own-property only.
 */
import {
  COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, HEIGHT, MIN_Y, SLICE_EXTENTS, SLICE_NS, SLICE_RULE_NA,
} from '../../core/constants';
import { inWindow, MAX_Y, WINDOW_HALF } from '../../core/coords';
import type { Params } from '../../core/params/schema';
import type { ColumnView } from '../../world/store/api';
import { newPointRecord, samplePoint, type ColumnPoint, type PointRecord } from '../column/columnPoint';
import { buildCornerSample, newColumnSample, type ColumnSample, type SampleField } from '../column/columnStage';
import type { GenContext } from '../context';
import { EXPR_CHILD_KEYS, type DensityExpr, type Expr } from '../density/expr';
import { createDensityReference, type DensityReference } from '../density/reference';
import { resolveDensity, resolveDensityNode } from '../density/source';
import { surfaceContextOf, type SurfaceContext, type SurfaceProbeColumn } from '../surface/context';
import { surfaceProbeColumn } from '../surface/probe';
import type { RuleNodeRef } from '../surface/reference';
import { ruleNodeCount, tColumnCost, workCost } from './cost';

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
const IN_WINDOW = inWindow;
const COLUMN_COST = COLUMN_SAMPLE_COST;
const CORNER_COST = CORNER_SAMPLE_COST;
const STEEP_COST = CORNER_STEEP_COST;
const RULE_NA = SLICE_RULE_NA;
const REFERENCE = createDensityReference;
const RESOLVE = resolveDensity;
const RESOLVE_NODE = resolveDensityNode;
const SURFACE_CONTEXT = surfaceContextOf;
const PROBE_COLUMN = surfaceProbeColumn;
const WORK_COST = workCost;
const T_COLUMN_COST = tColumnCost;
const RULE_NODES = ruleNodeCount;

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

// ---------------------------------------------------------------------------------------------------------------------
// Field evaluation (§4.1, §5.1, §5.3)

/** A slice field (§4.1): `node` is the `selected` field on a density node, `rule` on a rule or condition. */
export type SliceField = 'density' | 'node' | 'blocks' | 'rule';
/** The fields `probeField` answers (§5.3). */
export type ProbeField = 'density' | 'node' | 'rule';

/** One part of a slice: the plane, the field, the node path inside its leaf ('' for density and blocks), [from, to). */
export interface FieldSliceRequest {
  readonly geometry: SliceGeometry;
  readonly field: SliceField;
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/**
 * The T stage's output for the `blocks` field: the proto view of column (cx, cz) generated for the context, or null
 * when `stop()` fired. The view must stay valid until the next call (the evaluation reads one column at a time).
 */
export type TColumnSource = (cx: number, cz: number, stop: () => boolean) => ColumnView | null;

/**
 * A part's values, each sample column's n samples in row order at (c − from)·n + k: Float64 values for `density` and
 * `node`; u16 block states plus u8 fluid for `blocks`; u8 for `rule` (0, 1 or `SLICE_RULE_NA`).
 */
export type FieldSliceValues =
  | { readonly field: 'density' | 'node'; readonly values: Float64Array<ArrayBuffer>; readonly fluid: null }
  | { readonly field: 'blocks'; readonly values: Uint16Array<ArrayBuffer>; readonly fluid: Uint8Array<ArrayBuffer> }
  | { readonly field: 'rule'; readonly values: Uint8Array<ArrayBuffer>; readonly fluid: null };

/** A DensityReference with the way a horizontal plane samples its expression. */
interface RefEntry {
  readonly ref: DensityReference;
  readonly sampling: HorizontalSampling;
}

const DENSITY_REFS = new WeakMap<GenContext, RefEntry>();
const NODE_REFS = new WeakMap<GenContext, Map<string, RefEntry>>();
/** Node paths whose DensityReference a context keeps (§5.1). */
const NODE_LRU = 8;

const entryOf = (expr: DensityExpr, ctx: GenContext): RefEntry => ({
  ref: REFERENCE(expr, SURFACE_CONTEXT(ctx).density.noises),
  sampling: horizontalSampling(expr),
});

function densityEntry(ctx: GenContext): RefEntry {
  let e = DENSITY_REFS.get(ctx);
  if (e === undefined) {
    e = entryOf(SURFACE_CONTEXT(ctx).density.expr, ctx);
    DENSITY_REFS.set(ctx, e);
  }
  return e;
}

function nodeEntry(ctx: GenContext, path: string): RefEntry {
  let lru = NODE_REFS.get(ctx);
  if (lru === undefined) {
    lru = new Map<string, RefEntry>();
    NODE_REFS.set(ctx, lru);
  }
  let e = lru.get(path);
  if (e !== undefined) {
    lru.delete(path);
  } else {
    e = entryOf(RESOLVE_NODE(ctx.params.density.defs, path, ctx.params), ctx);
    if (lru.size >= NODE_LRU) lru.delete(lru.keys().next().value!);
  }
  lru.set(path, e);
  return e;
}

/**
 * The DensityReference of the `density` field (§5.3): the reference evaluator of the stage's own resolved tree,
 * `surfaceContextOf(ctx).density.expr`, built once per GenContext (a WeakMap keyed by the context).
 */
export function densityReferenceOf(ctx: GenContext): DensityReference {
  return densityEntry(ctx).ref;
}

/**
 * The DensityReference of the `node` field at the density node `path` (§3.4, §5.1): the reference evaluator of
 * `resolveDensityNode(ctx.params.density.defs, path, ctx.params)`, memoised per (GenContext, path) in an LRU of 8 paths.
 * A path that names no node throws resolveDensityNode's RangeError.
 */
export function nodeReferenceOf(ctx: GenContext, path: string): DensityReference {
  return nodeEntry(ctx, path).ref;
}

/**
 * Why `field` at `path` has no slice or probe on `plane` in `ctx`, or null (the worker's BAD_ARGS, §5.1): `blocks` and
 * `rule` exist on vertical planes only; `density` and `blocks` take the path ''; `node` a path naming a node of the
 * source tree `density.defs` (own properties only); `rule` the id of a rule or condition of `surface.rules`.
 */
export function fieldSliceProblem(ctx: GenContext, field: SliceField, path: string, plane: SliceGeometry['plane']): string | null {
  if ((field === 'blocks' || field === 'rule') && plane !== 'vertical') return `field ${field} has no ${plane} slice`;
  switch (field) {
    case 'density': case 'blocks':
      return path === '' ? null : `field ${field} takes no node path (got ${JSON.stringify(path)})`;
    case 'node':
      try {
        nodeEntry(ctx, path);
        return null;
      } catch (e) {
        if (e instanceof RangeError) return `path ${JSON.stringify(path)} names no node of density.defs`;
        throw e;
      }
    case 'rule':
      return SURFACE_CONTEXT(ctx).reference.nodeAt(path) === undefined ? `path ${JSON.stringify(path)} names no rule or condition of surface.rules` : null;
    default:
      return `unknown field ${JSON.stringify(field)}`;
  }
}

function requireProblemFree(problem: string | null, what: string): void {
  if (problem !== null) throw new RangeError(`${what}: ${problem}`);
}

/** The `rule` field at the voxel (p, y) of a probe column: SLICE_RULE_NA off the solid voxels, else 0 or 1. */
function ruleValue(sc: SurfaceContext, node: RuleNodeRef, id: string, c: SurfaceProbeColumn, p: number, y: number): number {
  if (y < MIN_Y_ + 1 || c.solid[((y - MIN_Y_) << 8) | p] === 0) return RULE_NA;
  if (node.kind === 'condition') return sc.reference.conditionHolds(id, c.scan, sc.settings, p, y) ? 1 : 0;
  return sc.reference.evaluate(c.scan, sc.settings, p, y).path.includes(id) ? 1 : 0;
}

/**
 * The samples [from, to) of `req` in `ctx` (§5.1), or null when `stop()` fired (polled once per sample). Throws a
 * RangeError for a geometry with a problem (`sliceGeometryProblem`), a range that is not integers with
 * 0 ≤ from < to ≤ n, a `fieldSliceProblem`, a vertical point outside the window, or `blocks` without `tColumns`.
 * Vertical `density`/`node` samples read the ColumnCache's ColumnSample of each chunk column; horizontal ones corner
 * samples memoised over this part (or full samples, `horizontalSampling`); `rule` the SurfaceContext's probe column, whose
 * build polls `stop()` too (`surfaceProbeColumn`'s density fill).
 */
export function evaluateFieldSlice(ctx: GenContext, req: FieldSliceRequest, stop: () => boolean, tColumns?: TColumnSource): FieldSliceValues | null {
  const g = req.geometry;
  const { field, path, from, to } = req;
  requireProblemFree(sliceGeometryProblem(g), 'fieldSlice');
  const n = g.n;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to || to > n) throw new RangeError(`fieldSlice: range [${from}, ${to}) is not inside [0, ${n})`);
  requireProblemFree(fieldSliceProblem(ctx, field, path, g.plane), 'fieldSlice');
  if (field === 'blocks' && tColumns === undefined) throw new RangeError('fieldSlice: the blocks field needs a T-column source');
  const size = n * (to - from);
  // Vertical rows' y and horizontal columns' x, once per part.
  const ys = new Int32Array(n);
  const xs = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    if (g.plane === 'vertical') ys[k] = sliceRowY(k, n);
    else xs[k] = horizontalCoord(g.cx, g.extent, k, n);
  }
  const sc = SURFACE_CONTEXT(ctx);

  if (field === 'density' || field === 'node') {
    const { ref, sampling } = field === 'density' ? densityEntry(ctx) : nodeEntry(ctx, path);
    const values = new Float64Array(size);
    const columns = sc.density.columns;
    if (g.plane === 'vertical') {
      for (let c = from; c < to; c++) {
        const [x, , z] = sliceSampleVoxel(g, c, 0);
        const s = columns.get(x >> 4, z >> 4);
        const base = (c - from) * n;
        for (let k = 0; k < n; k++) {
          if (stop()) return null;
          values[base + k] = ref.voxel(s, x, ys[k]!, z);
        }
      }
    } else {
      const sampler = sampling === 'full' ? null : createCornerSampler(ctx, sampling === 'cornerSteep');
      const y = g.y;
      for (let c = from; c < to; c++) {
        const z = horizontalCoord(g.cz, g.extent, c, n);
        const base = (c - from) * n;
        for (let k = 0; k < n; k++) {
          if (stop()) return null;
          const x = xs[k]!;
          const s = sampler === null ? columns.get(x >> 4, z >> 4) : sampler.sample(x, z);
          values[base + k] = ref.voxel(s, x, y, z);
        }
      }
    }
    return { field, values, fluid: null };
  }

  if (field === 'blocks') {
    const values = new Uint16Array(size);
    const fluid = new Uint8Array(size);
    let view: ColumnView | null = null;
    for (let c = from; c < to; c++) {
      const [x, , z] = sliceSampleVoxel(g, c, 0);
      const cx = x >> 4, cz = z >> 4;
      const base = (c - from) * n;
      for (let k = 0; k < n; k++) {
        if (stop()) return null;
        if (view === null || view.cx !== cx || view.cz !== cz) {
          view = tColumns!(cx, cz, stop);
          if (view === null) return null;
        }
        values[base + k] = view.block(x & 15, ys[k]!, z & 15);
        fluid[base + k] = view.fluid(x & 15, ys[k]!, z & 15);
      }
    }
    return { field, values, fluid };
  }

  const node = sc.reference.nodeAt(path)!;
  const values = new Uint8Array(size);
  for (let c = from; c < to; c++) {
    const [x, , z] = sliceSampleVoxel(g, c, 0);
    const cx = x >> 4, cz = z >> 4;
    const p = ((z & 15) << 4) | (x & 15);
    const base = (c - from) * n;
    for (let k = 0; k < n; k++) {
      if (stop()) return null;
      // The probe column's density fill polls stop() too: a column of a heavy valid tree takes about 0.1 s to build.
      const col = PROBE_COLUMN(sc, cx, cz, stop);
      if (col === null) return null;
      values[base + k] = ruleValue(sc, node, path, col, p, ys[k]!);
    }
  }
  return { field: 'rule', values, fluid: null };
}

/**
 * The value of `field` at `path` at world voxel (x, y, z) (§5.3, the hover's `fieldProbe`): exactly the slice's
 * sample there (density and node: the reference on the ColumnCache's ColumnSample; rule: 0, 1 or `SLICE_RULE_NA`), or
 * null when `stop()` fired; polled before acquiring the column and before evaluating. Non-finite values are returned
 * as they are. Throws a RangeError for non-integer coordinates, (x, z) outside the window, y outside −64 … 319, or a
 * `fieldSliceProblem` (as on a vertical plane).
 */
export function probeField(ctx: GenContext, field: ProbeField, path: string, x: number, y: number, z: number, stop: () => boolean): number | null {
  if (!Number.isInteger(x) || !Number.isInteger(z) || !IN_WINDOW(x, z)) throw new RangeError(`fieldProbe: (x, z) = (${x}, ${z}) is not an integer position in the world window`);
  if (!Number.isInteger(y) || y < MIN_Y_ || y > MAX_Y_) throw new RangeError(`fieldProbe: y ${y} is not an integer in [${MIN_Y_}, ${MAX_Y_}]`);
  if (field !== 'density' && field !== 'node' && field !== 'rule') throw new RangeError(`fieldProbe: unknown field ${JSON.stringify(field)}`);
  requireProblemFree(fieldSliceProblem(ctx, field, path, 'vertical'), 'fieldProbe');
  const sc = SURFACE_CONTEXT(ctx);
  const cx = x >> 4, cz = z >> 4;
  if (stop()) return null;
  if (field === 'rule') {
    const c = PROBE_COLUMN(sc, cx, cz, stop);
    if (c === null || stop()) return null;
    return ruleValue(sc, sc.reference.nodeAt(path)!, path, c, ((z & 15) << 4) | (x & 15), y);
  }
  const { ref } = field === 'density' ? densityEntry(ctx) : nodeEntry(ctx, path);
  const s = sc.density.columns.get(cx, cz);
  if (stop()) return null;
  return ref.voxel(s, x, y, z);
}

// ---------------------------------------------------------------------------------------------------------------------
// The work bound's column cost (§5.2)

/** Every cost sum and product saturates here (2^31). */
const COST_SATURATE = 2147483648;
const satCost = (v: number): number => (v < COST_SATURATE ? v : COST_SATURATE);

/**
 * The evaluated expression of a density field (§5.2): `density` the resolved tree (`resolveDensity`), `node` §3.4's
 * expression of the node at `path` (`resolveDensityNode`, wrapped in `interpolated` when it has an interpolated
 * ancestor). Throws as the resolvers do (a path naming no node: RangeError).
 */
export function evaluatedExpression(params: Params, field: 'density' | 'node', path: string): DensityExpr {
  return field === 'density' ? RESOLVE(params.density.defs, params) : RESOLVE_NODE(params.density.defs, path, params);
}

/**
 * The work-bound cost of one sample column of a slice (§5.2): n × (c + perSample) + perColumn, saturating at 2^31.
 * `density` / `node`: c = the evaluated expression's work cost (`workCost`); vertical perColumn `COLUMN_SAMPLE_COST`;
 * horizontal perSample `CORNER_SAMPLE_COST`, `CORNER_STEEP_COST` when the expression reads `col steep`, or
 * `COLUMN_SAMPLE_COST` when it takes full samples. `blocks`: perColumn one T column (`tColumnCost`); `rule`: the same
 * plus n × the rule tree's node count. The UI passes it to the pool and the worker recomputes it from its configured
 * params. Throws a RangeError for n ∉ SLICE_NS or `blocks` / `rule` on a horizontal plane, and as
 * `evaluatedExpression` for a bad node path.
 */
export function sliceCostOf(params: Params, field: SliceField, path: string, plane: SliceGeometry['plane'], n: number): number {
  checkN(n);
  if (plane !== 'vertical' && plane !== 'horizontal') throw new RangeError(`sliceCostOf: unknown plane ${JSON.stringify(plane)}`);
  switch (field) {
    case 'density': case 'node': {
      const e = evaluatedExpression(params, field, path);
      const c = WORK_COST(e, params);
      if (plane === 'vertical') return satCost(satCost(n * c) + COLUMN_COST);
      const mode = horizontalSampling(e);
      const per = mode === 'full' ? COLUMN_COST : mode === 'cornerSteep' ? STEEP_COST : CORNER_COST;
      return satCost(n * (c + per));
    }
    case 'blocks': case 'rule': {
      if (plane !== 'vertical') throw new RangeError(`sliceCostOf: field ${field} has no ${plane} slice`);
      const t = T_COLUMN_COST(params);
      return field === 'blocks' ? t : satCost(t + n * RULE_NODES(params.surface.rules));
    }
    default:
      throw new RangeError(`sliceCostOf: unknown field ${JSON.stringify(field)}`);
  }
}

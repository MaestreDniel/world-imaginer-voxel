/**
 * Spline statistics (SP2b spec §4.3, §5.4): the coordinate histogram and the per-segment land and world
 * shares of one node of a shape spline, over a fixed point stream. Shared by the pool's `splineStats`
 * stats job and the tests; follows the core determinism rules (arch-tested).
 *
 * Each point i has the weight w_i = pathWeight down to the node (1 at the root). For a node with n knots,
 * a sum is a Float64Array of splineStatsLength(n) raw values:
 * - [0, 64): Σ w per bin of the node's coordinate, 64 equal bins over [−1, 1] (the end bins take what
 *   lies beyond);
 * - then for each region r = 0 … n, Σ w over its land points and Σ w over all its points: r = 0 is the
 *   left hold (q < x_0), r = k + 1 the segment [x_k, x_{k+1}), r = n the right hold (q ≥ x_{n−1});
 * - then the total weight Σ w, the point count N and the land point count N_land (unweighted).
 * Land means offset0 ≥ SEA_LEVEL. Sums of disjoint point ranges add element-wise.
 */
import { SEA_LEVEL } from '../core/constants';
import type { Params } from '../core/params/schema';
import { evalSpline } from '../core/spline/hermite';
import { SPLINE_SLOT, SPLINE_MAX_POINTS, type KnotPath, type NestedSpline } from '../core/spline/types';
import { pathWeight } from '../core/spline/weights';
import type { GenContext } from '../gen/context';
import { newClimate, sampleClimate } from '../gen/column/climate';
import { splineCoords } from '../gen/column/shape';
import { samplePoints, type Points } from './noiseStats';

const SEA = SEA_LEVEL;
const EVAL = evalSpline;
const SLOT = SPLINE_SLOT;
const MAX_KNOTS = SPLINE_MAX_POINTS;
const WEIGHT = pathWeight;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const COORDS_OF = splineCoords;
const SAMPLE_POINTS = samplePoints;

/** Histogram bins over [−1, 1]. */
const BINS = 64;
/** Points between two calls of `stop` (spec §2.2). */
const STOP_EVERY = 256;

/** The spline leaves the editor opens (the schema's spline leaves, in schema order; a unit test pins them). */
export type SplineLeaf = 'shape.offset' | 'shape.sigma' | 'shape.jag';
export const SPLINE_LEAVES: readonly SplineLeaf[] = ['shape.offset', 'shape.sigma', 'shape.jag'];

const C_ = NEW_CLIMATE();
const COORDS = new Float64Array(6);

/** The leaf's spline in `params`. */
export function splineOfLeaf(params: Params, leaf: SplineLeaf): NestedSpline {
  return leaf === 'shape.offset' ? params.shape.offset : leaf === 'shape.sigma' ? params.shape.sigma : params.shape.jag;
}

/**
 * The node at `nodePath` ([] = the root, [k, …] = the child spline in knot k's y) of the leaf's spline in
 * `params`, or null when `leaf` is not a spline leaf or `nodePath` is not an array of knot indices that
 * each hold a nested spline. The stats handler replies BAD_ARGS on null (spec §5.4).
 */
export function splineStatsNode(params: Params, leaf: unknown, nodePath: unknown): NestedSpline | null {
  if (leaf !== 'shape.offset' && leaf !== 'shape.sigma' && leaf !== 'shape.jag') return null;
  if (!Array.isArray(nodePath)) return null;
  let node = splineOfLeaf(params, leaf);
  for (const k of nodePath as readonly unknown[]) {
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k >= node.points.length) return null;
    const y = node.points[k]!.y;
    if (typeof y === 'number') return null;
    node = y;
  }
  return node;
}

/** Length of a spline-stats sum for a node with `knotCount` knots (1-32): 64 bins, 2 per region, 3 totals. */
export function splineStatsLength(knotCount: number): number {
  if (!(Number.isInteger(knotCount) && knotCount >= 1 && knotCount <= MAX_KNOTS)) {
    throw new RangeError(`spline stats: knot count ${knotCount} outside 1..${MAX_KNOTS}`);
  }
  return BINS + 2 * (knotCount + 1) + 3;
}

/** Points in the editor's stream: the `n` of the pool's splineStats request. */
export const SPLINE_STATS_POINTS = 60000;

/** The editor's fixed point stream (spec §4.3). */
export function splineStatPoints(): Points {
  return SAMPLE_POINTS('sp2b.splineStats', SPLINE_STATS_POINTS);
}

/**
 * Adds the statistics of points [from, to) of `pts` to `out` for the node at `nodePath` of the leaf's
 * spline in ctx.params. Each point samples the climate and evaluates offset0 (for land) and the weight;
 * the lakes, rivers and steep stages are not needed. Calls `stop` before every 256 points and returns
 * false as soon as it returns true, leaving a partial sum in `out`; returns true when the range is done.
 * Throws RangeError on a bad leaf, node, output length or range.
 */
export function splineStatsInto(ctx: GenContext, leaf: SplineLeaf, nodePath: KnotPath, pts: Points, from: number, to: number, out: Float64Array, stop?: () => boolean): boolean {
  const node = splineStatsNode(ctx.params, leaf, nodePath);
  if (node === null) throw new RangeError(`spline stats: no node [${nodePath.join(', ')}] in ${String(leaf)}`);
  const n = node.points.length;
  const len = splineStatsLength(n);
  if (out.length !== len) throw new RangeError(`spline stats: output length ${out.length}, expected ${len}`);
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= pts.n)) {
    throw new RangeError(`spline stats: bad point range [${from}, ${to}) of ${pts.n}`);
  }
  const spline = splineOfLeaf(ctx.params, leaf);
  const root = nodePath.length === 0;
  const slot = SLOT[node.coord];
  const xs = new Float64Array(n);
  for (let k = 0; k < n; k++) xs[k] = node.points[k]!.x;
  const total = len - 3;
  for (let i = from; i < to; i++) {
    if (stop !== undefined && (i - from) % STOP_EVERY === 0 && stop()) return false;
    COORDS_OF(CLIMATE(ctx, pts.x[i]!, pts.z[i]!, C_), COORDS);
    const land = EVAL(ctx.offset, COORDS) >= SEA;
    const w = root ? 1 : WEIGHT(spline, nodePath, COORDS);
    const q = COORDS[slot]!;
    let b = Math.floor((q + 1) * (BINS / 2));
    if (b < 0) b = 0;
    else if (b >= BINS) b = BINS - 1;
    out[b]! += w;
    let r = 0;
    while (r < n && q >= xs[r]!) r++;
    const at = BINS + 2 * r;
    if (land) out[at]! += w;
    out[at + 1]! += w;
    out[total]! += w;
    out[total + 1]!++;
    if (land) out[total + 2]!++;
  }
  return true;
}

/** One region of a node: its x interval and its share of land and of the world (spec §4.3). */
export interface SplineRegionShare {
  /** [lo, hi): the left hold is (−∞, x_0), a segment [x_k, x_{k+1}), the right hold [x_{n−1}, ∞). */
  readonly lo: number;
  readonly hi: number;
  /** Σ w over the region's land points / N_land: "covers 7.3 % of land". */
  readonly land: number;
  /** Σ w over the region's points / N: "4.1 % of the world". */
  readonly world: number;
}

export interface SplineStatsSummary {
  /** 64 bins over [−1, 1] of the node's coordinate, each as a share of the total weight (sum 1). */
  readonly histogram: Float64Array;
  /** n + 1 regions: the left hold, the n − 1 segments, the right hold. */
  readonly regions: readonly SplineRegionShare[];
  readonly points: number;
  readonly landPoints: number;
  /** Σ w / N (the sum of the world shares; 1 at the root). */
  readonly meanWeight: number;
  /** Σ w over land points / N_land (the sum of the land shares; 1 at the root). */
  readonly meanLandWeight: number;
}

/** Shares of a sum for a node whose knots are at `knotXs`; an empty sum gives zeros. */
export function summarizeSplineStats(sum: Float64Array, knotXs: ArrayLike<number>): SplineStatsSummary {
  const n = knotXs.length;
  const len = splineStatsLength(n);
  if (sum.length !== len) throw new RangeError(`spline stats: sum length ${sum.length}, expected ${len} for ${n} knots`);
  const tw = sum[len - 3]!;
  const points = sum[len - 2]!;
  const landPoints = sum[len - 1]!;
  const histogram = new Float64Array(BINS);
  if (tw > 0) for (let b = 0; b < BINS; b++) histogram[b] = sum[b]! / tw;
  const regions: SplineRegionShare[] = [];
  let landWeight = 0;
  for (let r = 0; r <= n; r++) {
    const lw = sum[BINS + 2 * r]!;
    landWeight += lw;
    regions.push({
      lo: r === 0 ? -Infinity : knotXs[r - 1]!,
      hi: r === n ? Infinity : knotXs[r]!,
      land: landPoints > 0 ? lw / landPoints : 0,
      world: points > 0 ? sum[BINS + 2 * r + 1]! / points : 0,
    });
  }
  return {
    histogram, regions, points, landPoints,
    meanWeight: points > 0 ? tw / points : 0,
    meanLandWeight: landPoints > 0 ? landWeight / landPoints : 0,
  };
}

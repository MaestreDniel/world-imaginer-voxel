/**
 * The fieldSlice and fieldProbe jobs' message handling (SP3d spec §5.1, §5.3): the arguments' checks (the handler's
 * BAD_ARGS), the vertical plane's points (`segmentPointAt` and `segmentProblem` of `metrics/crossSection.ts`, which gen
 * cannot import), the work bound's part check (`fieldSlicePartProblem` on `sliceCostOf`, recomputed from the configured
 * params: the client's column cost is not trusted), the call into gen's evaluation (`gen/inspect/fieldSlice.ts`) and the
 * reply. The `blocks` field reads its T columns from the handler's slice job (its store and LRU, `sliceJob.ts`).
 */
import { MAX_Y } from '../core/coords';
import { COLUMN_SAMPLE_COST, MIN_Y } from '../core/constants';
import type { GenContext } from '../gen/context';
import {
  evaluatedExpression, evaluateFieldSlice, fieldSliceProblem, probeField, sliceCostOf, sliceGeometryProblem, type SliceGeometry, type TColumnSource,
} from '../gen/inspect/fieldSlice';
import { workCost } from '../gen/inspect/cost';
import { segmentPointAt, segmentProblem } from '../metrics/crossSection';
import { fieldSlicePartProblem, surfaceProbeProblem, type FieldProbeMsg, type FieldProbeResultMsg, type FieldSliceMsg, type FieldSliceResultMsg } from './protocol';
import type { SliceJob } from './sliceJob';

const POINT_AT = segmentPointAt;
const SEGMENT_PROBLEM = segmentProblem;
const GEOMETRY_PROBLEM = sliceGeometryProblem;
const FIELD_PROBLEM = fieldSliceProblem;
const EVALUATE = evaluateFieldSlice;
const PROBE = probeField;
const SLICE_COST = sliceCostOf;
const EXPRESSION = evaluatedExpression;
const WORK_COST = workCost;
const PART_PROBLEM = fieldSlicePartProblem;
const VOXEL_PROBLEM = surfaceProbeProblem;
const SAMPLE_COST = COLUMN_SAMPLE_COST;

/** A job's reply and the buffers it transfers, its BAD_ARGS text, or null when `stop()` fired (ABORTED). */
export type FieldJobReply<T> = { readonly msg: T; readonly transfer: readonly ArrayBuffer[] } | { readonly badArgs: string } | null;

/** The T columns of the `blocks` field: the slice job's proto views, claimed with `epoch`. */
export const sliceJobColumns = (slices: SliceJob, ctx: GenContext, epoch: number): TColumnSource => (cx, cz, stop) => slices.column(ctx, epoch, cx, cz, stop);

/**
 * The plane of a fieldSlice message, or why it has none: n ∈ SLICE_NS, then the segment (`segmentProblem`) or the square
 * (integer centre, extent, inside the window), then y an integer in −64 … 319 (required on both planes, unused by the
 * vertical one).
 */
export function fieldSliceGeometry(m: FieldSliceMsg): SliceGeometry | string {
  const g: SliceGeometry = m.plane === 'vertical'
    ? { plane: 'vertical', n: m.n, pointAt: (i) => POINT_AT(m, i, m.n) }
    : { plane: 'horizontal', n: m.n, cx: m.cx, cz: m.cz, y: m.y, extent: m.extent };
  const problem = GEOMETRY_PROBLEM(g)
    ?? (m.plane === 'vertical' ? SEGMENT_PROBLEM(m) : null)
    ?? (Number.isInteger(m.y) && m.y >= MIN_Y && m.y <= MAX_Y ? null : `y ${m.y} is not an integer in [${MIN_Y}, ${MAX_Y}]`);
  return problem ?? g;
}

/**
 * Every BAD_ARGS case of a fieldSlice message in `ctx` (spec §5.1), or its geometry: the plane, the range [from, to)
 * (integers, 0 ≤ from < to ≤ n), the field on its plane and the path in the configured source trees, then the part bound.
 */
export function fieldSliceArgs(ctx: GenContext, m: FieldSliceMsg): SliceGeometry | string {
  const g = fieldSliceGeometry(m);
  if (typeof g === 'string') return g;
  const { from, to, n } = m;
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= n)) return `samples [${from}, ${to}) are not integers with 0 ≤ from < to ≤ ${n}`;
  return FIELD_PROBLEM(ctx, m.field, m.path, m.plane) ?? PART_PROBLEM(to - from, SLICE_COST(ctx.params, m.field, m.path, m.plane, n), m.field) ?? g;
}

/** Runs a fieldSlice job in `ctx`: its reply (values, and fluid for blocks, transferred), its BAD_ARGS, or null when stopped. */
export function runFieldSlice(ctx: GenContext, m: FieldSliceMsg, stop: () => boolean, tColumns: TColumnSource): FieldJobReply<FieldSliceResultMsg> {
  const g = fieldSliceArgs(ctx, m);
  if (typeof g === 'string') return { badArgs: g };
  const r = EVALUATE(ctx, { geometry: g, field: m.field, path: m.path, from: m.from, to: m.to }, stop, m.field === 'blocks' ? tColumns : undefined);
  if (r === null) return null;
  const values = r.values.buffer;
  const fluid = r.fluid === null ? null : r.fluid.buffer;
  const msg: FieldSliceResultMsg = { type: 'fieldSliceResult', jobId: m.jobId, epoch: m.epoch, n: m.n, field: m.field, from: m.from, to: m.to, values, fluid };
  return { msg, transfer: fluid === null ? [values] : [values, fluid] };
}

/**
 * Every BAD_ARGS case of a fieldProbe message in `ctx` (spec §5.3), or null: the position (integers, in the window, y in
 * −64 … 319), the path, and for density and node the bound: one sample's work cost with its ColumnSample (§5.2) within
 * PART_BUDGET (a rule probe, one T column bounded by tier 2, is never refused, as rule slices).
 */
export function fieldProbeArgsProblem(ctx: GenContext, m: FieldProbeMsg): string | null {
  const problem = VOXEL_PROBLEM(m.x, m.y, m.z) ?? FIELD_PROBLEM(ctx, m.field, m.path, 'vertical');
  if (problem !== null || m.field === 'rule') return problem;
  return PART_PROBLEM(1, WORK_COST(EXPRESSION(ctx.params, m.field, m.path), ctx.params) + SAMPLE_COST, m.field);
}

/** Runs a fieldProbe job in `ctx`: the value (any number), its BAD_ARGS, or null when stopped. */
export function runFieldProbe(ctx: GenContext, m: FieldProbeMsg, stop: () => boolean): FieldJobReply<FieldProbeResultMsg> {
  const problem = fieldProbeArgsProblem(ctx, m);
  if (problem !== null) return { badArgs: problem };
  const value = PROBE(ctx, m.field, m.path, m.x, m.y, m.z, stop);
  return value === null ? null : { msg: { type: 'fieldProbeResult', jobId: m.jobId, epoch: m.epoch, value }, transfer: [] };
}

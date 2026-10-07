/**
 * The pure message handler of a task worker (SP2a spec §5.1): owns one GenContext per configured epoch
 * and answers each validated message. No DOM and no worker globals, so Node tests drive it directly.
 * Tile, spawn, stats and slice jobs stop as soon as the pool's abort cell leaves their epoch and reply ABORTED
 * (SP2b spec §2.2); point and selftest jobs always run to the end. Stats jobs (§5.4) run the metrics
 * functions over a range of their kind's fixed point stream, or of the points along a crossSection's line
 * (§4.5), and reply with the raw sums. Slice jobs (SP3a spec §5.1) read the voxels of a range of the samples under
 * a line (SP3b spec §6) from the handler's slice job (`sliceJob.ts`: a worker-local store and LRU kept for the
 * handler's lifetime, emptied by every configure) and stop like stats jobs.
 */
import { hex64 } from '../core/hash';
import { checkParams } from '../core/params/kit';
import { SCHEMA, type Params } from '../core/params/schema';
import { seedFromInput } from '../core/seed';
import { genKey, stageHashes } from '../core/stage/hash';
import { createGenContext, type GenContext } from '../gen/context';
import { columnPoint } from '../gen/column/columnPoint';
import { findSpawnAbortable } from '../gen/column/spawn';
import { paintTileAbortable } from '../gen/map/tile';
import { biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../metrics/biomeShares';
import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength, segmentProblem } from '../metrics/crossSection';
import type { Points } from '../metrics/noiseStats';
import { computeAnyGolden } from '../metrics/sp2aGoldens';
import { splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../metrics/splineStats';
import { parseToWorker, sliceRangeProblem, type ErrorCode, type FromWorker, type StatsMsg } from './protocol';
import { createSliceJob, type SliceJob } from './sliceJob';

const HEX = hex64;
const CHECK = checkParams;
const SCHEMA_ = SCHEMA;
const SEED = seedFromInput;
const GEN_KEY = genKey;
const HASHES = stageHashes;
const CREATE = createGenContext;
const POINT = columnPoint;
const PAINT = paintTileAbortable;
const SPAWN = findSpawnAbortable;
const GOLDEN = computeAnyGolden;
const PARSE = parseToWorker;
const SHARE_POINTS = biomeSharePoints;
const SHARES_INTO = biomeSharesInto;
const SHARES_LEN = biomeSharesLength;
const SPLINE_POINTS = splineStatPoints;
const SPLINE_INTO = splineStatsInto;
const SPLINE_LEN = splineStatsLength;
const SPLINE_NODE = splineStatsNode;
const SECTION_POINTS = CROSS_SECTION_POINTS;
const SECTION_INTO = crossSectionInto;
const SECTION_LEN = crossSectionLength;
const SEGMENT_PROBLEM = segmentProblem;
const RANGE_PROBLEM = sliceRangeProblem;
const CREATE_SLICE_JOB = createSliceJob;

export interface Reply {
  readonly msg: FromWorker;
  readonly transfer: readonly ArrayBuffer[];
}

export interface TaskHandler {
  handle(raw: unknown): Reply;
}

const err = (jobId: number | null, epoch: number | null, code: ErrorCode, message: string): Reply => ({ msg: { type: 'error', jobId, epoch, code, message }, transfer: [] });
const NEVER = (): boolean => false;
/** An integer field of a raw message, or null (for the replies to malformed messages). */
const intField = (raw: unknown, key: 'jobId' | 'epoch'): number | null => {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};

/** The stats kinds' fixed point streams, built on first use and shared by every handler of the thread. */
let splinePoints: Points | null = null;
let sharePoints: Points | null = null;

/** A zeroed sum of `len` values, or the BAD_ARGS message when args.len or the point range (of `n` points) does not fit. */
const sumFor = (m: StatsMsg, len: number, n: number): Float64Array<ArrayBuffer> | string =>
  m.args.len !== len ? `args.len ${m.args.len}, expected ${len}`
    : m.to > n ? `points [${m.from}, ${m.to}) outside the stream of ${n}`
      : new Float64Array(len);

/**
 * A stats job's sum; null when `stop` fired; a string (the BAD_ARGS message) when the node, the line,
 * args.len or the point range does not fit the configured params.
 */
function runStats(ctx: GenContext, m: StatsMsg, stop: () => boolean): Float64Array<ArrayBuffer> | string | null {
  if (m.kind === 'splineStats') {
    const { leaf, node: path } = m.args;
    const node = SPLINE_NODE(ctx.params, leaf, path);
    if (node === null) return `no node [${path.join(', ')}] in ${leaf}`;
    const pts = splinePoints ??= SPLINE_POINTS();
    const out = sumFor(m, SPLINE_LEN(node.points.length), pts.n);
    if (typeof out === 'string') return out;
    return SPLINE_INTO(ctx, leaf, path, pts, m.from, m.to, out, stop) ? out : null;
  }
  if (m.kind === 'crossSection') {
    const line = { ax: m.args.ax, az: m.args.az, bx: m.args.bx, bz: m.args.bz };
    const problem = SEGMENT_PROBLEM(line);
    if (problem !== null) return problem;
    const out = sumFor(m, SECTION_LEN(), SECTION_POINTS);
    if (typeof out === 'string') return out;
    return SECTION_INTO(ctx, line, m.from, m.to, out, stop) ? out : null;
  }
  const pts = sharePoints ??= SHARE_POINTS();
  const out = sumFor(m, SHARES_LEN(), pts.n);
  if (typeof out === 'string') return out;
  return SHARES_INTO(ctx, pts, m.from, m.to, out, stop) ? out : null;
}

/** `slices` is the worker's slice job (a test seam; one per handler by default). */
export function createTaskHandler(slices: SliceJob = CREATE_SLICE_JOB()): TaskHandler {
  let epoch = -1;
  let ctx: GenContext | null = null;
  let cell: Int32Array | null = null;
  /** A job of `jobEpoch` stops once the cell holds another epoch; without a cell it never stops. */
  const stopFor = (jobEpoch: number): (() => boolean) => {
    const c = cell;
    return c === null ? NEVER : () => Atomics.load(c, 0) !== jobEpoch;
  };
  return {
    handle(raw) {
      const m = PARSE(raw);
      const jobId = intField(raw, 'jobId');
      const msgEpoch = intField(raw, 'epoch');
      if (m === null) return err(jobId, msgEpoch, 'BAD_MESSAGE', 'malformed message');
      try {
        if (m.type === 'configure') {
          const r = CHECK(SCHEMA_, m.params);
          if (!r.ok) return err(null, m.epoch, 'BAD_PARAMS', r.issues.slice(0, 5).map((i) => `${i.path}: ${i.code}`).join('; '));
          const params: Params = r.value;
          const seed = SEED(m.seedText);
          ctx = CREATE(seed, params);
          epoch = m.epoch;
          slices.reset();
          cell = m.abort === null ? null : new Int32Array(m.abort);
          const h = HASHES(params);
          const hex: Record<string, string> = {};
          for (const [k, v] of Object.entries(h)) hex[k] = HEX(v);
          return { msg: { type: 'ready', epoch, stageHashes: hex, genKey: HEX(GEN_KEY(seed, h)) }, transfer: [] };
        }
        if (m.type === 'selftest') {
          try {
            return { msg: { type: 'selftestResult', jobId: m.jobId, key: m.key, actual: GOLDEN(m.key), error: null }, transfer: [] };
          } catch (e) {
            return { msg: { type: 'selftestResult', jobId: m.jobId, key: m.key, actual: null, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
          }
        }
        if (ctx === null) return err(m.jobId, m.epoch, 'NOT_CONFIGURED', 'no configure yet');
        if (m.epoch !== epoch) return err(m.jobId, m.epoch, 'STALE_EPOCH', `job epoch ${m.epoch}, worker epoch ${epoch}`);
        const aborted = (): Reply => err(m.jobId, m.epoch, 'ABORTED', `epoch ${m.epoch} was superseded`);
        if (m.type === 'mapTile') {
          const rgba = new ArrayBuffer(256 * 256 * 4);
          const ids = m.layer === 'biome' ? new ArrayBuffer(256 * 256) : null;
          const done = PAINT(ctx, m.layer, m.level, m.tx, m.tz, new Uint8ClampedArray(rgba), stopFor(m.epoch), ids === null ? undefined : new Uint8Array(ids));
          if (done === null) return aborted();
          return ids === null
            ? { msg: { type: 'tile', jobId: m.jobId, epoch, rgba }, transfer: [rgba] }
            : { msg: { type: 'tile', jobId: m.jobId, epoch, rgba, ids }, transfer: [rgba, ids] };
        }
        if (m.type === 'spawn') {
          const spawn = SPAWN(ctx, stopFor(m.epoch));
          return spawn === null ? aborted() : { msg: { type: 'spawnResult', jobId: m.jobId, epoch, spawn }, transfer: [] };
        }
        if (m.type === 'stats') {
          const sum = runStats(ctx, m, stopFor(m.epoch));
          if (sum === null) return aborted();
          if (typeof sum === 'string') return err(m.jobId, m.epoch, 'BAD_ARGS', sum);
          return { msg: { type: 'statsResult', jobId: m.jobId, epoch, kind: m.kind, data: sum.buffer }, transfer: [sum.buffer] };
        }
        if (m.type === 'slice') {
          const segment = { ax: m.ax, az: m.az, bx: m.bx, bz: m.bz };
          const problem = SEGMENT_PROBLEM(segment) ?? RANGE_PROBLEM(m.from, m.to);
          if (problem !== null) return err(m.jobId, m.epoch, 'BAD_ARGS', problem);
          const r = slices.run(ctx, m.epoch, segment, stopFor(m.epoch), m.from, m.to);
          if (r === null) return aborted();
          const msg: FromWorker = { type: 'sliceResult', jobId: m.jobId, epoch, from: m.from, to: m.to, blocks: r.blocks.buffer, fluid: r.fluid.buffer };
          return { msg, transfer: [r.blocks.buffer, r.fluid.buffer] };
        }
        return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
      } catch (e) {
        return err(jobId, msgEpoch, 'INTERNAL', e instanceof Error ? e.message : String(e));
      }
    },
  };
}

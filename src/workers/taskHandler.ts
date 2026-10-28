/**
 * The pure message handler of a task worker (SP2a spec §5.1): owns one GenContext per configured epoch
 * and answers each validated message. No DOM and no worker globals, so Node tests drive it directly.
 * Tile, spawn, stats and slice jobs stop as soon as their epoch cell moves from their scope and reply ABORTED (SP2b spec
 * §2.2; SP4b spec §2.7: the pool's single abort cell became four per-scope cells, and each job reads its phase's, `cellOf`);
 * point and selftest jobs always run to the end. Stats jobs (§5.4) run the metrics
 * functions over a range of their kind's fixed point stream, or of the points along a crossSection's line
 * (§4.5), and reply with the raw sums. Slice jobs (SP3a spec §5.1) read the voxels of a range of the samples under
 * a line (SP3b spec §6) from the handler's slice job (`sliceJob.ts`: a worker-local store and LRU kept for the
 * handler's lifetime, emptied by every configure) and stop like stats jobs. A surfaceProbe job (SP3c spec §6) answers
 * `surfaceProbe` on the configured context's SurfaceContext (memoised per GenContext, with its one-column cache); it polls
 * its epoch cell once, before its column build (SP3d spec §5.3). Configure runs tier 2 of the trees after `checkParams`
 * (SP3d spec §1.8): a params document whose trees `validateParamTrees` refuses gets BAD_PARAMS with its first 5 issues,
 * so an invalid tree never reaches a job's lazy compile (the session never sends one; this guards against bugs).
 * fieldSlice and fieldProbe jobs (SP3d spec §5.1, §5.3) are `fieldSliceJob.ts`'s: BAD_ARGS for their arguments and the
 * work bound, ABORTED when their cell moves from their scope (polled once per sample), and `blocks` reads the slice job's
 * columns. Every message type has its own branch of an exhaustive switch.
 * SP4a (spec §2.3, ruling P29): `attach` attaches the page's shared store once (a second attach is BAD_MESSAGE), and the
 * four world jobs run `worldJobs.ts`'s reply wrappers on it with `stopFor(type, scope)`: NOT_ATTACHED before the attach,
 * ABORTED on a stop, STORE_FULL for `StoreFull`, INTERNAL for any other throw. The light and mesh scratch are allocated
 * once per handler, on the first job that needs them; the mesh uses the Medium preset's `ao` and `smoothLight`.
 * SP4b (spec §2.5, §2.6, §2.8, §3.7): `attach` carries the worker's reclaim thread and attaches the store as that thread;
 * a second attach with the same store id (the reclaim buffer's [2]) and thread is answered `attached` again, anything else
 * stays BAD_MESSAGE. Every world job runs inside a read section (`enterRead` … `exitRead`), so a slot it may read is never
 * reused under it; its own releases (L's `resetLight`, a stopped T's frees) wait in this thread's limbo, which `drain`
 * frees and the worker shell drains after each reply (`drainAfterReply`). A `StoreCorrupt` replies STORE_CORRUPT (fatal),
 * not INTERNAL (retried). `terrain` with `protoOnly` is `T(protoOnly)`.
 * SP4c (spec §3.2, D12): a `landing` job answers `landingSurface` and the column's `surfaceWaterLevel` at (x, z): BAD_ARGS
 * outside the world window; it runs to the end, as a point (a few milliseconds: the 2D estimate and about 10 probes).
 * SP5a (spec §2.5, D21): a `decorate` carrying `diff` (checked by `parseToWorker`) passes it to `decorateReply`, which
 * overlays the column's edit entries on its final set.
 */
import { hex64 } from '../core/hash';
import { MEDIUM } from '../core/params/graphicsPresets';
import { checkParams } from '../core/params/kit';
import { SCHEMA, type Params } from '../core/params/schema';
import { seedFromInput } from '../core/seed';
import { genKey, stageHashes } from '../core/stage/hash';
import { createGenContext, type GenContext } from '../gen/context';
import { columnPoint } from '../gen/column/columnPoint';
import { findSpawnAbortable, landingSurface } from '../gen/column/spawn';
import { paintTileAbortable } from '../gen/map/tile';
import { surfaceContextOf } from '../gen/surface/context';
import { surfaceProbe } from '../gen/surface/probe';
import { validateParamTrees } from '../gen/trees';
import { createLightScratch, type LightScratch } from '../light/initial';
import { biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../metrics/biomeShares';
import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength, segmentProblem } from '../metrics/crossSection';
import type { Points } from '../metrics/noiseStats';
import { computeAnyGolden } from '../metrics/sp2aGoldens';
import { splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode } from '../metrics/splineStats';
import { createMeshScratch, type MeshScratch } from '../mesh/column';
import type { MeshOptions } from '../mesh/greedy';
import { R_STORE_ID } from '../world/store/reclaim';
import { attachStore, StoreCorrupt, StoreFull, type VoxelStore } from '../world/store/store';
import { runFieldProbe, runFieldSlice, sliceJobColumns, type FieldJobReply } from './fieldSliceJob';
import { cellOf, landingProblem, parseToWorker, sliceRangeProblem, surfaceProbeProblem, type ErrorCode, type FromWorker, type ScopedJobType, type StatsMsg } from './protocol';
import { createSliceJob, type SliceJob } from './sliceJob';
import { decorateReply, lightReply, meshColumnReply, terrainReply, type WorldJobReply } from './worldJobs';

const HEX = hex64;
const CHECK = checkParams;
const TREES = validateParamTrees;
const SCHEMA_ = SCHEMA;
const SEED = seedFromInput;
const GEN_KEY = genKey;
const HASHES = stageHashes;
const CREATE = createGenContext;
const POINT = columnPoint;
const PAINT = paintTileAbortable;
const SPAWN = findSpawnAbortable;
const LANDING = landingSurface;
const LANDING_PROBLEM = landingProblem;
const GOLDEN = computeAnyGolden;
const PARSE = parseToWorker;
const CELL_OF = cellOf;
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
const SURFACE_CONTEXT = surfaceContextOf;
const SURFACE_PROBE = surfaceProbe;
const PROBE_PROBLEM = surfaceProbeProblem;
const FIELD_SLICE = runFieldSlice;
const FIELD_PROBE = runFieldProbe;
const SLICE_COLUMNS = sliceJobColumns;
const ATTACH_STORE = attachStore;
const STORE_FULL = StoreFull;
const STORE_CORRUPT = StoreCorrupt;
const LIGHT_SCRATCH = createLightScratch;
const MESH_SCRATCH = createMeshScratch;
const TERRAIN_REPLY = terrainReply;
const DECORATE_REPLY = decorateReply;
const LIGHT_REPLY = lightReply;
const MESH_COLUMN_REPLY = meshColumnReply;
/** The mesh options of the 3D page (SP4a spec §6.10: the Medium preset). */
const MESH_OPTIONS: MeshOptions = { ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight };

export interface Reply {
  readonly msg: FromWorker;
  readonly transfer: readonly ArrayBuffer[];
}

export interface TaskHandler {
  handle(raw: unknown): Reply;
  /** Frees this worker's limbo entries no live reader can hold (`store.drain()`, SP4b spec §2.5); the entries left, 0 without a store. */
  drain(): number;
}

/** A worker whose limbo is not empty after a drain retries every this many ms (SP4b spec §2.5). */
export const LIMBO_RETRY_MS = 16;
/** The handlers with a retry timer pending, so a reply during the retries starts no second chain. */
const retrying = new WeakSet<object>();

/**
 * The worker shell's drain after each reply (SP4b spec §2.5): drains at once, then, while entries are left, again every
 * `LIMBO_RETRY_MS` through `setTimer`, so an idle worker never keeps slots counted as used. At most one retry timer is
 * pending per handler. `task.worker.ts` calls it after each post; the Node harness's `node-worker.mjs` mirrors it in
 * plain JS (`test/harness/nodeWorker.ts`).
 */
export function drainAfterReply(h: Pick<TaskHandler, 'drain'>, setTimer: (f: () => void, ms: number) => unknown): void {
  if (h.drain() === 0 || retrying.has(h)) return;
  retrying.add(h);
  const retry = (): void => {
    if (h.drain() > 0) setTimer(retry, LIMBO_RETRY_MS);
    else retrying.delete(h);
  };
  setTimer(retry, LIMBO_RETRY_MS);
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
  /** The four per-scope epoch cells of the last configure (SP4b spec §2.7), or null: jobs never stop. */
  let cells: Int32Array | null = null;
  /** The attached shared store (SP4a spec §2.3), and the world jobs' worker-local scratch, allocated on first use. */
  let store: VoxelStore | null = null;
  let lightScratch: LightScratch | null = null;
  let meshScratch: MeshScratch | null = null;
  /** A job of `type` issued at `scope` stops once its phase's cell holds another value; without cells it never stops. */
  const stopFor = (type: ScopedJobType, scope: number): (() => boolean) => {
    const c = cells;
    if (c === null) return NEVER;
    const i = CELL_OF(type);
    return () => Atomics.load(c, i) !== scope;
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
          const issues = r.ok ? TREES(r.value) : r.issues;
          if (!r.ok || issues.length > 0) return err(null, m.epoch, 'BAD_PARAMS', issues.slice(0, 5).map((i) => `${i.path}: ${i.code}`).join('; '));
          const params: Params = r.value;
          const seed = SEED(m.seedText);
          ctx = CREATE(seed, params);
          epoch = m.epoch;
          slices.reset();
          cells = m.epochs === null ? null : new Int32Array(m.epochs);
          const h = HASHES(params);
          const hex: Record<string, string> = {};
          for (const [k, v] of Object.entries(h)) hex[k] = HEX(v);
          return { msg: { type: 'ready', epoch, stageHashes: hex, genKey: HEX(GEN_KEY(seed, h)) }, transfer: [] };
        }
        if (m.type === 'attach') {
          if (store !== null) {
            // Idempotent per worker (SP4b spec §2.8): a posted SharedArrayBuffer arrives as a new object, so the store id decides.
            const same = Atomics.load(new Int32Array(m.handles.reclaim), R_STORE_ID) === store.storeId && m.thread === store.thread;
            return same ? { msg: { type: 'attached' }, transfer: [] } : err(null, null, 'BAD_MESSAGE', 'the store is already attached');
          }
          store = ATTACH_STORE(m.handles, m.thread);
          return { msg: { type: 'attached' }, transfer: [] };
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
        const aborted = (): Reply => err(m.jobId, m.epoch, 'ABORTED', `scope ${m.scope} of epoch ${m.epoch} was superseded`);
        /** A fieldSlice or fieldProbe job's outcome as a reply. */
        const fieldReply = (r: FieldJobReply<FromWorker>): Reply => (r === null ? aborted() : 'badArgs' in r ? err(m.jobId, m.epoch, 'BAD_ARGS', r.badArgs) : r);
        /**
         * A world job on the attached store, inside a read section (SP4b spec §2.5): NOT_ATTACHED without one, ABORTED on
         * a stop, STORE_FULL for `StoreFull` (a `StoreCorrupt` goes to the outer catch, STORE_CORRUPT).
         */
        const worldReply = (run: (s: VoxelStore) => WorldJobReply<FromWorker> | null): Reply => {
          const s = store;
          if (s === null) return err(m.jobId, m.epoch, 'NOT_ATTACHED', 'no attach yet');
          s.enterRead();
          try {
            return run(s) ?? aborted();
          } catch (e) {
            if (e instanceof STORE_FULL) return err(m.jobId, m.epoch, 'STORE_FULL', e.message);
            throw e;
          } finally {
            s.exitRead();
          }
        };
        switch (m.type) {
          case 'mapTile': {
            const rgba = new ArrayBuffer(256 * 256 * 4);
            const ids = m.layer === 'biome' ? new ArrayBuffer(256 * 256) : null;
            const done = PAINT(ctx, m.layer, m.level, m.tx, m.tz, new Uint8ClampedArray(rgba), stopFor(m.type, m.scope), ids === null ? undefined : new Uint8Array(ids));
            if (done === null) return aborted();
            return ids === null
              ? { msg: { type: 'tile', jobId: m.jobId, epoch, rgba }, transfer: [rgba] }
              : { msg: { type: 'tile', jobId: m.jobId, epoch, rgba, ids }, transfer: [rgba, ids] };
          }
          case 'spawn': {
            const spawn = SPAWN(ctx, stopFor(m.type, m.scope));
            return spawn === null ? aborted() : { msg: { type: 'spawnResult', jobId: m.jobId, epoch, spawn }, transfer: [] };
          }
          case 'stats': {
            const sum = runStats(ctx, m, stopFor(m.type, m.scope));
            if (sum === null) return aborted();
            if (typeof sum === 'string') return err(m.jobId, m.epoch, 'BAD_ARGS', sum);
            return { msg: { type: 'statsResult', jobId: m.jobId, epoch, kind: m.kind, data: sum.buffer }, transfer: [sum.buffer] };
          }
          case 'slice': {
            const segment = { ax: m.ax, az: m.az, bx: m.bx, bz: m.bz };
            const problem = SEGMENT_PROBLEM(segment) ?? RANGE_PROBLEM(m.from, m.to);
            if (problem !== null) return err(m.jobId, m.epoch, 'BAD_ARGS', problem);
            const r = slices.run(ctx, m.epoch, segment, stopFor(m.type, m.scope), m.from, m.to);
            if (r === null) return aborted();
            const msg: FromWorker = { type: 'sliceResult', jobId: m.jobId, epoch, from: m.from, to: m.to, blocks: r.blocks.buffer, fluid: r.fluid.buffer };
            return { msg, transfer: [r.blocks.buffer, r.fluid.buffer] };
          }
          case 'surfaceProbe': {
            const problem = PROBE_PROBLEM(m.x, m.y, m.z);
            if (problem !== null) return err(m.jobId, m.epoch, 'BAD_ARGS', problem);
            // SP3d spec §5.3: polled before the column build (one T column, bounded by tier 2's column cost).
            if (stopFor(m.type, m.scope)()) return aborted();
            const r = SURFACE_PROBE(SURFACE_CONTEXT(ctx), m.x, m.y, m.z);
            return { msg: { type: 'surfaceProbeResult', jobId: m.jobId, epoch, state: r.state, path: [...r.path] }, transfer: [] };
          }
          case 'point':
            return { msg: { type: 'pointResult', jobId: m.jobId, epoch, fields: POINT(ctx, m.x, m.z) }, transfer: [] };
          case 'landing': {
            const problem = LANDING_PROBLEM(m.x, m.z);
            if (problem !== null) return err(m.jobId, m.epoch, 'BAD_ARGS', problem);
            const surface = LANDING(ctx, m.x, m.z);
            return { msg: { type: 'landingResult', jobId: m.jobId, epoch, surface, water: POINT(ctx, m.x, m.z).surfaceWaterLevel }, transfer: [] };
          }
          case 'fieldSlice':
            return fieldReply(FIELD_SLICE(ctx, m, stopFor(m.type, m.scope), SLICE_COLUMNS(slices, ctx, m.epoch)));
          case 'fieldProbe':
            return fieldReply(FIELD_PROBE(ctx, m, stopFor(m.type, m.scope)));
          case 'terrain': {
            const c = ctx;
            return worldReply((s) => TERRAIN_REPLY(s, c, m, stopFor(m.type, m.scope)));
          }
          case 'decorate': {
            const c = ctx;
            return worldReply((s) => DECORATE_REPLY(s, c, m, stopFor(m.type, m.scope)));
          }
          case 'light':
            return worldReply((s) => LIGHT_REPLY(s, m, lightScratch ??= LIGHT_SCRATCH(), stopFor(m.type, m.scope)));
          case 'meshColumn':
            return worldReply((s) => MESH_COLUMN_REPLY(s, m, meshScratch ??= MESH_SCRATCH(), MESH_OPTIONS, stopFor(m.type, m.scope)));
          default: {
            const never: never = m;
            return err(jobId, msgEpoch, 'BAD_MESSAGE', `no handler for ${(never as { type: string }).type}`);
          }
        }
      } catch (e) {
        // SP4b spec §2.6: a pool lock held by a failed thread is fatal, never retried.
        return err(jobId, msgEpoch, e instanceof STORE_CORRUPT ? 'STORE_CORRUPT' : 'INTERNAL', e instanceof Error ? e.message : String(e));
      }
    },
    drain: () => (store === null ? 0 : store.drain()),
  };
}

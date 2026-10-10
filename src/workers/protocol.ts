/**
 * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
 * The main thread sends configure / mapTile / point / spawn / stats / slice / surfaceProbe / selftest; the worker answers
 * ready / tile / pointResult / spawnResult / statsResult / sliceResult / surfaceProbeResult / selftestResult / error. selftest needs no configure.
 * Configure carries the pool's abort cell (SP2b spec §2.2), errors carry the epoch of the message they
 * answer (§2.3), biome tiles carry the biome id of every pixel (§5.3), and a stats job returns the raw
 * sums of one kind over a range of the kind's fixed point stream (§5.4) or, for crossSection, of the points
 * along its line (§4.5). A slice job (SP3a spec §5.1) returns the voxels of the vertical slice under a line, for a
 * range [from, to) of its 512 samples (SP3b spec §6: the pool splits a slice across its workers). A surfaceProbe job (SP3c
 * spec §6) returns one voxel's final state and its surface-rule branch path, for the Voxels mode's hover.
 * SP3d (spec §5): a fieldSlice job evaluates a range [from, to) of the sample columns of an n × n slice (density, a
 * density node, blocks or a rule mask, on a vertical or horizontal plane) and a fieldProbe job one voxel of the same
 * fields; the work bound's costs and budgets (core/constants.ts, re-exported here) and `planFieldSlice`, the one
 * implementation of the split and refusal math, serve the workers, the pool and the UI alike. A reply whose envelope
 * (type, jobId) reads but whose body fails its guard parses as `{bad, jobId, reason}`, so the pool can reject that job.
 */
import { MAP_LEVELS, MAP_TILE_PX, PART_BUDGET, SLICE_NS, type MapLevel } from '../core/constants';
import type { StageId } from '../core/ids';
import type { KnotPath } from '../core/spline/types';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import type { ProbeField, SliceField } from '../gen/inspect/fieldSlice';
import { isLayerId, type LayerId } from '../gen/map/layers';
import type { SplineLeaf } from '../metrics/splineStats';

export { COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, DRAFT_BUDGET, PART_BUDGET, REQUEST_BUDGET, SLICE_RULE_NA } from '../core/constants';

const LEVELS: readonly number[] = MAP_LEVELS;
const NS: readonly number[] = SLICE_NS;

/** `abort` is the pool's epoch cell (an Int32 in a 4-byte SharedArrayBuffer), or null without cross-origin isolation. */
export interface ConfigureMsg { readonly type: 'configure'; readonly epoch: number; readonly seedText: string; readonly params: unknown; readonly abort: SharedArrayBuffer | null }
export interface MapTileMsg { readonly type: 'mapTile'; readonly jobId: number; readonly epoch: number; readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }
export interface PointMsg { readonly type: 'point'; readonly jobId: number; readonly epoch: number; readonly x: number; readonly z: number }
export interface SpawnMsg { readonly type: 'spawn'; readonly jobId: number; readonly epoch: number }
export interface SelftestMsg { readonly type: 'selftest'; readonly jobId: number; readonly key: string }
/**
 * A stats job over points [from, to) of its kind's fixed stream. `args.len` is the Float64 length of the
 * kind's sum, which the kind's module in src/metrics exports (splineStatsLength, biomeSharesLength); the
 * worker replies BAD_ARGS when it does not match the configured params.
 */
interface StatsBase { readonly type: 'stats'; readonly jobId: number; readonly epoch: number; readonly from: number; readonly to: number }
/** The histogram and region shares of the node at `node` of a shape spline (spec §4.3). */
export interface SplineStatsMsg extends StatsBase { readonly kind: 'splineStats'; readonly args: { readonly len: number; readonly leaf: SplineLeaf; readonly node: KnotPath } }
/** Surface-biome counts, ties, outside and total (spec §5.5). */
export interface BiomeSharesMsg extends StatsBase { readonly kind: 'biomeShares'; readonly args: { readonly len: number } }
/** The profile along the line A = (ax, az) → B = (bx, bz) at its 512 points (spec §4.5). */
export interface CrossSectionMsg extends StatsBase {
  readonly kind: 'crossSection';
  readonly args: { readonly len: number; readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number };
}
export type StatsMsg = SplineStatsMsg | BiomeSharesMsg | CrossSectionMsg;
export type StatsKind = StatsMsg['kind'];
export type StatsArgs<K extends StatsKind> = Extract<StatsMsg, { readonly kind: K }>['args'];
/**
 * Samples [from, to) of the vertical slice under the line A = (ax, az) → B = (bx, bz) (SP3a spec §5.1; the range: SP3b
 * spec §6). The ends and the range are only checked to be numbers here; an end outside the half-open world window,
 * A = B, or a range that is not integers with 0 ≤ from < to ≤ 512 is the handler's BAD_ARGS.
 */
export interface SliceMsg {
  readonly type: 'slice'; readonly jobId: number; readonly epoch: number;
  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
  readonly from: number; readonly to: number;
}
/**
 * The final state and the surface-rule branch path of voxel (x, y, z) (SP3c spec §6). The position is only checked to be
 * numbers here; non-integers, a position outside the half-open world window or a y outside −64 … 319 is the handler's
 * BAD_ARGS (`surfaceProbeProblem`).
 */
export interface SurfaceProbeMsg { readonly type: 'surfaceProbe'; readonly jobId: number; readonly epoch: number; readonly x: number; readonly y: number; readonly z: number }
/** What a fieldSlice job evaluates (SP3d spec §5.1): `path` is the node path inside its leaf ('' for density and blocks). */
interface FieldSliceArgs { readonly y: number; readonly n: number; readonly field: SliceField; readonly path: string }
/** A vertical plane along A = (ax, az) → B = (bx, bz); `y` is carried but unused. */
export interface VerticalFieldSlice extends FieldSliceArgs { readonly plane: 'vertical'; readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }
/** A horizontal XZ plane at `y`, centred on (cx, cz), of side `extent`. */
export interface HorizontalFieldSlice extends FieldSliceArgs { readonly plane: 'horizontal'; readonly cx: number; readonly cz: number; readonly extent: number }
/** A whole n × n field slice: the pool's `fieldSlice` request. */
export type FieldSliceSpec = VerticalFieldSlice | HorizontalFieldSlice;
/**
 * Sample columns [from, to) of a field slice (SP3d spec §5.1). Only the shape is checked here (types, the plane's keys
 * present and the other plane's absent, a known field, a path of at most FIELD_PATH_MAX characters); n, the segment or
 * the square, y, the field on its plane, the path, the range and the work bound are the handler's BAD_ARGS.
 */
export type FieldSliceMsg = FieldSliceSpec & { readonly type: 'fieldSlice'; readonly jobId: number; readonly epoch: number; readonly from: number; readonly to: number };
/** The value of a field at voxel (x, y, z) (SP3d spec §5.3); the position, the path and the bound are the handler's BAD_ARGS. */
export interface FieldProbeSpec { readonly field: ProbeField; readonly path: string; readonly x: number; readonly y: number; readonly z: number }
export type FieldProbeMsg = FieldProbeSpec & { readonly type: 'fieldProbe'; readonly jobId: number; readonly epoch: number };
export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SliceMsg | SurfaceProbeMsg | SelftestMsg | FieldSliceMsg | FieldProbeMsg;

export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
/** `ids` (256·256 biome ids, one per pixel) comes with layer 'biome' only. */
export interface TileMsg { readonly type: 'tile'; readonly jobId: number; readonly epoch: number; readonly rgba: ArrayBuffer; readonly ids?: ArrayBuffer }
export interface PointResultMsg { readonly type: 'pointResult'; readonly jobId: number; readonly epoch: number; readonly fields: ColumnPoint }
/** ABORTED: the abort cell left the job's epoch (the pool reads it as JobCancelled). BAD_ARGS: a stats job's arguments do not fit the configured params. */
export type ErrorCode = 'BAD_MESSAGE' | 'BAD_PARAMS' | 'NOT_CONFIGURED' | 'STALE_EPOCH' | 'INTERNAL' | 'ABORTED' | 'BAD_ARGS';
/** `epoch` is the epoch of the message answered (a configure's or a job's), null when it had none. */
export interface ErrorMsg { readonly type: 'error'; readonly jobId: number | null; readonly epoch: number | null; readonly code: ErrorCode; readonly message: string }
export interface SpawnResultMsg { readonly type: 'spawnResult'; readonly jobId: number; readonly epoch: number; readonly spawn: Spawn }
/** `data` holds a Float64Array of the job's raw, unnormalised sums (transferred). */
export interface StatsResultMsg { readonly type: 'statsResult'; readonly jobId: number; readonly epoch: number; readonly kind: StatsKind; readonly data: ArrayBuffer }
/**
 * The voxels of samples [from, to) of a slice (transferred): `blocks` holds (to − from)·SLICE_ROWS u16 block states and
 * `fluid` as many fluid bytes, sample (i, y) at `slicePartIndex(i, y, from, to)` (SP3b spec §6).
 */
export interface SliceResultMsg {
  readonly type: 'sliceResult'; readonly jobId: number; readonly epoch: number;
  readonly from: number; readonly to: number; readonly blocks: ArrayBuffer; readonly fluid: ArrayBuffer;
}
/** One recomputed golden: the digest, or the error that stopped it. */
export interface SelftestResultMsg { readonly type: 'selftestResult'; readonly jobId: number; readonly key: string; readonly actual: string | null; readonly error: string | null }
/**
 * A voxel's final state id and its surface-rule branch path: the rule ids from `root` to the yielding leaf, [] for air,
 * water, y −64 and a stone no rule yields (SP3c spec §3.6).
 */
export interface SurfaceProbeResultMsg { readonly type: 'surfaceProbeResult'; readonly jobId: number; readonly epoch: number; readonly state: number; readonly path: readonly string[] }
/**
 * Sample columns [from, to) of a field slice of n (transferred), each sample column's n samples in row order at
 * (c − from)·n + k: Float64 values for density and node, u16 states plus u8 `fluid` for blocks, u8 for rule (0, 1 or
 * SLICE_RULE_NA); `fluid` is null but for blocks (byte lengths: `fieldSliceBytes`).
 */
export interface FieldSliceResultMsg {
  readonly type: 'fieldSliceResult'; readonly jobId: number; readonly epoch: number;
  readonly n: number; readonly field: SliceField; readonly from: number; readonly to: number;
  readonly values: ArrayBuffer; readonly fluid: ArrayBuffer | null;
}
/** A fieldProbe's value: any number (NaN and ±∞ are shown as such); 0, 1 or SLICE_RULE_NA for rule. */
export interface FieldProbeResultMsg { readonly type: 'fieldProbeResult'; readonly jobId: number; readonly epoch: number; readonly value: number }
export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SliceResultMsg | SurfaceProbeResultMsg | SelftestResultMsg | FieldSliceResultMsg | FieldProbeResultMsg | ErrorMsg;
/** A job's reply whose envelope (type, jobId) reads but whose body fails its guard (SP3d spec §5.1): the pool rejects job `jobId` with BAD_MESSAGE. */
export interface BadReply { readonly bad: true; readonly jobId: number; readonly reason: string }

/** Samples along a slice's line, A and B included (the cross-section's 512 points, SP2b spec §4.5). */
export const SLICE_POINTS = 512;
/** Rows of a slice: y 319 down to −64. */
export const SLICE_ROWS = 384;
/** Entries of a slice's blocks and fluid arrays: 512 × 384. */
export const SLICE_SAMPLES = SLICE_POINTS * SLICE_ROWS;
/** Index of sample (i, y) in a slice: row 0 is y 319, the order the Voxels mode draws in. */
export const sliceIndex = (i: number, y: number): number => (319 - y) * SLICE_POINTS + i;
/**
 * Index of sample (i, y), i ∈ [from, to), in a part of a slice (SP3b spec §6): the part holds samples [from, to) only,
 * row 0 at y 319. With from 0 and to 512 it is `sliceIndex`.
 */
export const slicePartIndex = (i: number, y: number, from: number, to: number): number => (319 - y) * (to - from) + (i - from);
/** Why [from, to) is not a range of a slice's samples (integers with 0 ≤ from < to ≤ 512), or null when it is. */
export const sliceRangeProblem = (from: number, to: number): string | null =>
  Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= SLICE_POINTS
    ? null
    : `points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ ${SLICE_POINTS}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isAbortCell = (v: unknown): boolean => v === null || (typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer && v.byteLength === 4);
/**
 * Every stats kind (a record, so a new kind cannot be left out) and how the pool runs a request of it (spec
 * §5.4): 'split' into pool.size slices whose sums it adds, or 'single', one job over the whole range.
 */
export const STATS_KINDS: Readonly<Record<StatsKind, 'split' | 'single'>> = Object.freeze({ splineStats: 'split', biomeShares: 'split', crossSection: 'single' });
const isStatsKind = (v: unknown): v is StatsKind => typeof v === 'string' && Object.hasOwn(STATS_KINDS, v);
const SEGMENT_KEYS = ['ax', 'az', 'bx', 'bz'] as const;
const SLICE_KEYS = [...SEGMENT_KEYS, 'from', 'to'] as const;
const VOXEL_KEYS = ['x', 'y', 'z'] as const;
/** The longest node path a fieldSlice or fieldProbe message may carry. */
export const FIELD_PATH_MAX = 512;
const SLICE_FIELDS: readonly string[] = ['density', 'node', 'blocks', 'rule'];
const PROBE_FIELDS: readonly string[] = ['density', 'node', 'rule'];
const PLANE_KEYS = { vertical: ['ax', 'az', 'bx', 'bz'], horizontal: ['cx', 'cz', 'extent'] } as const;
const FIELD_SLICE_KEYS = ['y', 'n', 'from', 'to'] as const;
const isPath = (v: unknown): v is string => typeof v === 'string' && v.length <= FIELD_PATH_MAX;
const fieldSliceOk = (m: Record<string, unknown>): boolean => {
  const plane = m['plane'];
  if (plane !== 'vertical' && plane !== 'horizontal') return false;
  const other = plane === 'vertical' ? PLANE_KEYS.horizontal : PLANE_KEYS.vertical;
  return isInt(m['jobId']) && isInt(m['epoch']) && typeof m['field'] === 'string' && SLICE_FIELDS.includes(m['field']) && isPath(m['path'])
    && [...PLANE_KEYS[plane], ...FIELD_SLICE_KEYS].every((k) => typeof m[k] === 'number') && other.every((k) => !Object.hasOwn(m, k));
};
const fieldProbeOk = (m: Record<string, unknown>): boolean =>
  isInt(m['jobId']) && isInt(m['epoch']) && typeof m['field'] === 'string' && PROBE_FIELDS.includes(m['field']) && isPath(m['path']) && VOXEL_KEYS.every((k) => typeof m[k] === 'number');

/** The byte lengths of a fieldSlice reply's `values` and `fluid` (0: null) for `columns` sample columns of n samples. */
export function fieldSliceBytes(n: number, field: SliceField, columns: number): { readonly values: number; readonly fluid: number } {
  const samples = n * columns;
  switch (field) {
    case 'density': case 'node': return { values: 8 * samples, fluid: 0 };
    case 'blocks': return { values: 2 * samples, fluid: samples };
    default: return { values: samples, fluid: 0 };
  }
}

/** Whether a field's slices can be refused by the work bound (density, node); blocks and rule never are (spec §5.2). */
export const isRefusableField = (field: SliceField): boolean => field === 'density' || field === 'node';

/** Sample columns a part may hold: max(1, ⌊PART_BUDGET / columnCost⌋). */
const partColumns = (columnCost: number): number => Math.max(1, Math.floor(PART_BUDGET / columnCost));

/** A slice's split: k sample columns at most per part and the parts' ranges, or its refusal with the largest column cost accepted. */
export type FieldSlicePlan =
  | { readonly refused: false; readonly k: number; readonly ranges: ReadonlyArray<readonly [number, number]> }
  | { readonly refused: true; readonly limit: number };

/**
 * The split and refusal math of a field slice (SP3d spec §5.2), the only implementation (the pool, the UI's notices and the
 * bench call it): a part holds at most k = max(1, ⌊PART_BUDGET / columnCost⌋) sample columns, and the parts are
 * min(n, max(poolSize, ⌈n / k⌉)) equal contiguous ranges of [0, n), as `slice` and `stats` split. With a `budget` (density
 * and node) the slice is refused when columnCost exceeds limit = min(PART_BUDGET, ⌊budget / n⌋), that is when one sample
 * column exceeds PART_BUDGET or n × columnCost exceeds the budget; `budget` null (blocks and rule) is never refused.
 * Depends only on its arguments. RangeError for n or poolSize not a positive integer, a columnCost not finite and
 * positive, or a budget not finite and positive.
 */
export function planFieldSlice(n: number, columnCost: number, poolSize: number, budget: number | null): FieldSlicePlan {
  if (!(Number.isSafeInteger(n) && n >= 1)) throw new RangeError(`planFieldSlice: n ${n} is not a positive integer`);
  if (!(Number.isFinite(columnCost) && columnCost > 0)) throw new RangeError(`planFieldSlice: column cost ${columnCost} is not finite and positive`);
  if (!(Number.isSafeInteger(poolSize) && poolSize >= 1)) throw new RangeError(`planFieldSlice: pool size ${poolSize} is not a positive integer`);
  if (budget !== null && !(Number.isFinite(budget) && budget > 0)) throw new RangeError(`planFieldSlice: budget ${budget} is not finite and positive`);
  if (budget !== null) {
    const limit = Math.min(PART_BUDGET, Math.floor(budget / n));
    if (columnCost > limit) return { refused: true, limit };
  }
  const k = partColumns(columnCost);
  const parts = Math.min(n, Math.max(poolSize, Math.ceil(n / k)));
  const ranges: Array<readonly [number, number]> = [];
  for (let i = 0; i < parts; i++) ranges.push([Math.floor((i * n) / parts), Math.floor(((i + 1) * n) / parts)]);
  return { refused: false, k, ranges };
}

/**
 * The worker's bound check of a part of `columns` sample columns of `columnCost` (SP3d spec §5.2), or null: a density or
 * node part above PART_BUDGET in all (one sample column above it included), a blocks or rule part of more than k
 * sample columns (`planFieldSlice`'s k, so its parts always pass). A fieldProbe is a part of one column of one sample.
 */
export function fieldSlicePartProblem(columns: number, columnCost: number, field: SliceField): string | null {
  const k = partColumns(columnCost);
  if (isRefusableField(field)) return columnCost > PART_BUDGET || columns > k ? `too heavy: ${columns} × ${columnCost} work units exceed the part budget ${PART_BUDGET}` : null;
  return columns > k ? `too heavy: ${columns} sample columns of cost ${columnCost}, at most ${k} per part` : null;
}
/**
 * The shape of a stats job: a point range 0 ≤ from ≤ to and args with a positive integer len; splineStats
 * args also name a leaf (a string) and a node (an array of integers), crossSection args the ends of the line
 * (numbers). Whether the leaf, the node, the line, len and `to` fit the configured params is the handler's
 * check (BAD_ARGS).
 */
const statsOk = (m: Record<string, unknown>): boolean => {
  const from = m['from'];
  const to = m['to'];
  const args = m['args'];
  if (!isInt(m['jobId']) || !isInt(m['epoch']) || !isStatsKind(m['kind'])) return false;
  if (!isInt(from) || !isInt(to) || from < 0 || to < from) return false;
  if (!isObj(args) || !isInt(args['len']) || args['len'] < 1) return false;
  if (m['kind'] === 'crossSection') return SEGMENT_KEYS.every((k) => typeof args[k] === 'number');
  if (m['kind'] !== 'splineStats') return true;
  const node = args['node'];
  return typeof args['leaf'] === 'string' && Array.isArray(node) && node.every(isInt);
};

/** Half-width of the colKey window: x and z lie in the half-open [−2^19, 2^19) (SP2b spec §6.3). */
const WINDOW = 524288;
/** Whether block position (x, z) lies in the world window [−2^19, 2^19); false for NaN. */
export const pointInWindow = (x: number, z: number): boolean => x >= -WINDOW && x < WINDOW && z >= -WINDOW && z < WINDOW;
/**
 * Why (x, y, z) is not a voxel a surfaceProbe can read (integers, (x, z) in the half-open world window, y in −64 … 319),
 * or null when it is.
 */
export const surfaceProbeProblem = (x: number, y: number, z: number): string | null =>
  !(Number.isInteger(x) && Number.isInteger(z) && pointInWindow(x, z)) ? `(x, z) = (${x}, ${z}) is not an integer position in the world window`
    : !(Number.isInteger(y) && y >= -64 && y <= 319) ? `y ${y} is not an integer in −64 … 319`
      : null;
/**
 * Whether tile column (or row) `t` of `level` lies in the world window: its blocks [t·s, (t+1)·s) with
 * s = 256 · level. Every level's s divides 2^19, so a tile starting inside the window ends inside it.
 */
export const tileInWindow = (t: number, level: number): boolean => {
  const start = t * MAP_TILE_PX * level;
  return start >= -WINDOW && start < WINDOW;
};
const tileOk = (t: unknown, level: number): boolean => isInt(t) && tileInWindow(t, level);

/** Validates a message sent to a worker; null when malformed. */
export function parseToWorker(m: unknown): ToWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'configure':
      return isInt(m['epoch']) && typeof m['seedText'] === 'string' && m['seedText'].trim() !== '' && 'params' in m && isAbortCell(m['abort']) ? (m as unknown as ConfigureMsg) : null;
    case 'mapTile': {
      const level = m['level'];
      if (!isInt(m['jobId']) || !isInt(m['epoch']) || !isLayerId(m['layer'])) return null;
      if (!isInt(level) || !LEVELS.includes(level) || !tileOk(m['tx'], level) || !tileOk(m['tz'], level)) return null;
      return m as unknown as MapTileMsg;
    }
    case 'point':
      return isInt(m['jobId']) && isInt(m['epoch']) && isFiniteNum(m['x']) && isFiniteNum(m['z']) && pointInWindow(m['x'], m['z']) ? (m as unknown as PointMsg) : null;
    case 'spawn':
      return isInt(m['jobId']) && isInt(m['epoch']) ? (m as unknown as SpawnMsg) : null;
    case 'stats':
      return statsOk(m) ? (m as unknown as StatsMsg) : null;
    case 'slice':
      return isInt(m['jobId']) && isInt(m['epoch']) && SLICE_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SliceMsg) : null;
    case 'surfaceProbe':
      return isInt(m['jobId']) && isInt(m['epoch']) && VOXEL_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SurfaceProbeMsg) : null;
    case 'selftest':
      return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
    case 'fieldSlice':
      return fieldSliceOk(m) ? (m as unknown as FieldSliceMsg) : null;
    case 'fieldProbe':
      return fieldProbeOk(m) ? (m as unknown as FieldProbeMsg) : null;
    default:
      return null;
  }
}

/** Why a job reply's body (jobId aside) fails its guard, or null. */
type ReplyCheck = (m: Record<string, unknown>) => string | null;
const epochProblem = (m: Record<string, unknown>): string | null => (isInt(m['epoch']) ? null : 'epoch is not an integer');
const all = (...checks: ReadonlyArray<string | null>): string | null => checks.find((c) => c !== null) ?? null;

const tileCheck: ReplyCheck = (m) => {
  const ids = m['ids'];
  return all(epochProblem(m),
    m['rgba'] instanceof ArrayBuffer && m['rgba'].byteLength === 256 * 256 * 4 ? null : 'rgba is not an ArrayBuffer of 262144 bytes',
    ids === undefined || (ids instanceof ArrayBuffer && ids.byteLength === 256 * 256) ? null : 'ids is not an ArrayBuffer of 65536 bytes');
};
const statsCheck: ReplyCheck = (m) => {
  // The pool checks the length against the request's args.len (the protocol does not import metrics).
  const data = m['data'];
  return all(epochProblem(m), isStatsKind(m['kind']) ? null : `kind ${String(m['kind'])} is not a stats kind`,
    data instanceof ArrayBuffer && data.byteLength > 0 && data.byteLength % 8 === 0 ? null : 'data is not an ArrayBuffer of whole Float64 values');
};
const sliceCheck: ReplyCheck = (m) => {
  const from = m['from'];
  const to = m['to'];
  if (typeof from !== 'number' || typeof to !== 'number' || sliceRangeProblem(from, to) !== null) return `range [${String(from)}, ${String(to)}) is not a slice range`;
  const n = (to - from) * SLICE_ROWS;
  return all(epochProblem(m),
    m['blocks'] instanceof ArrayBuffer && m['blocks'].byteLength === 2 * n ? null : `blocks is not an ArrayBuffer of ${2 * n} bytes`,
    m['fluid'] instanceof ArrayBuffer && m['fluid'].byteLength === n ? null : `fluid is not an ArrayBuffer of ${n} bytes`);
};
const surfaceProbeCheck: ReplyCheck = (m) => {
  const path = m['path'];
  const state = m['state'];
  return all(epochProblem(m), isInt(state) && state >= 0 ? null : 'state is not a non-negative integer',
    Array.isArray(path) && path.every((id) => typeof id === 'string') ? null : 'path is not an array of strings');
};
const bufferProblem = (name: string, v: unknown, bytes: number): string | null =>
  bytes === 0 ? (v === null ? null : `${name} is not null`)
    : !(v instanceof ArrayBuffer) ? `${name} is not an ArrayBuffer`
      : v.byteLength !== bytes ? `${name} of ${v.byteLength} bytes, expected ${bytes}` : null;
const fieldSliceCheck: ReplyCheck = (m) => {
  const { n, field, from, to } = m;
  if (typeof n !== 'number' || !NS.includes(n)) return `n ${String(n)} is not a slice size (${NS.join(', ')})`;
  if (typeof field !== 'string' || !SLICE_FIELDS.includes(field)) return `field ${String(field)} is not a slice field`;
  if (!isInt(from) || !isInt(to) || from < 0 || from >= to || to > n) return `samples [${String(from)}, ${String(to)}) are not integers with 0 ≤ from < to ≤ ${n}`;
  const b = fieldSliceBytes(n, field as SliceField, to - from);
  return all(epochProblem(m), bufferProblem('values', m['values'], b.values), bufferProblem('fluid', m['fluid'], b.fluid));
};
/** Each job reply's body check; a reply type absent here (ready) has no job. */
const REPLY_CHECKS: Readonly<Record<string, ReplyCheck>> = Object.freeze({
  tile: tileCheck,
  pointResult: (m) => all(epochProblem(m), isObj(m['fields']) ? null : 'fields is not an object'),
  selftestResult: (m) => (typeof m['key'] === 'string' && (m['actual'] === null || typeof m['actual'] === 'string') && (m['error'] === null || typeof m['error'] === 'string')
    ? null : 'key, actual or error is not a string (or null)'),
  spawnResult: (m) => all(epochProblem(m), isObj(m['spawn']) ? null : 'spawn is not an object'),
  statsResult: statsCheck,
  sliceResult: sliceCheck,
  surfaceProbeResult: surfaceProbeCheck,
  fieldSliceResult: fieldSliceCheck,
  fieldProbeResult: (m) => all(epochProblem(m), typeof m['value'] === 'number' ? null : 'value is not a number'),
  error: (m) => (m['epoch'] === null || isInt(m['epoch'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? null : 'epoch, code or message is malformed',
});

/**
 * Validates a worker reply: the reply; `{bad, jobId, reason}` when its envelope (a job reply type and an integer jobId)
 * reads but its body fails the guard (SP3d spec §5.1); null otherwise (not an object, an unknown type, no readable jobId,
 * a malformed ready).
 */
export function parseFromWorker(m: unknown): FromWorker | BadReply | null {
  if (!isObj(m)) return null;
  const type = m['type'];
  if (type === 'ready') return isInt(m['epoch']) && isObj(m['stageHashes']) && typeof m['genKey'] === 'string' ? (m as unknown as ReadyMsg) : null;
  if (typeof type !== 'string' || !Object.hasOwn(REPLY_CHECKS, type)) return null;
  const jobId = m['jobId'];
  if (type === 'error' && jobId === null) return REPLY_CHECKS[type]!(m) === null ? (m as unknown as ErrorMsg) : null;
  if (!isInt(jobId)) return null;
  const reason = REPLY_CHECKS[type]!(m);
  return reason === null ? (m as unknown as FromWorker) : { bad: true, jobId, reason: `${type}: ${reason}` };
}

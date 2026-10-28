/**
 * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
 * The main thread sends configure / mapTile / point / spawn / stats / slice / surfaceProbe / selftest; the worker answers
 * ready / tile / pointResult / spawnResult / statsResult / sliceResult / surfaceProbeResult / selftestResult / error. selftest needs no configure.
 * Configure carries the pool's four per-scope epoch cells (SP4b spec §2.7; SP2b spec §2.2's abort cell before it), errors
 * carry the epoch of the message they answer (SP2b spec §2.3), biome tiles carry the biome id of every pixel (§5.3), and a
 * stats job returns the raw sums of one kind over a range of the kind's fixed point stream (§5.4) or, for crossSection, of
 * the points along its line (§4.5). A slice job (SP3a spec §5.1) returns the voxels of the vertical slice under a line, for a
 * range [from, to) of its 512 samples (SP3b spec §6: the pool splits a slice across its workers). A surfaceProbe job (SP3c
 * spec §6) returns one voxel's final state and its surface-rule branch path, for the Voxels mode's hover.
 * SP3d (spec §5): a fieldSlice job evaluates a range [from, to) of the sample columns of an n × n slice (density, a
 * density node, blocks or a rule mask, on a vertical or horizontal plane) and a fieldProbe job one voxel of the same
 * fields; the work bound's costs and budgets (core/constants.ts, re-exported here) and `planFieldSlice`, the one
 * implementation of the split and refusal math, serve the workers, the pool and the UI alike. A reply whose envelope
 * (type, jobId) reads but whose body fails its guard parses as `{bad, jobId, reason}`, so the pool can reject that job.
 * SP4a (spec §2.3): `attach` hands a worker the page's shared store once (answered `attached`, which has no job), and the
 * four world jobs `terrain`, `decorate`, `light` and `meshColumn` of one column answer `columnDone` or `meshColumnResult`;
 * the attach guard checks every buffer is a `SharedArrayBuffer` of the documented size (ruling P23), and the mesh reply's
 * table is checked against its buffers (`payloadProblem`).
 * SP4b (spec §2.7): every job but `selftest` carries two values, `epoch` (its configure generation: STALE_EPOCH when it is not
 * the worker's) and `scope` (the value of its phase's epoch cell at issue, `cellOf`: the worker stops it once the cell moves).
 * SP4b (spec §2.5, §2.6, §2.8, §3.7): `attach` carries the worker's reclaim `thread` (1 … 15) and is idempotent for the same
 * store id and thread; `terrain` may carry `protoOnly` (`T(protoOnly)`); STORE_CORRUPT is a world job's `StoreCorrupt`, and an
 * error's code must be an `ErrorCode`.
 * SP4c (spec §3.2, D12): a `landing` job reads the terrain cell and answers `landingResult`, the teleport's surface
 * (`landingSurface`) and the column's `surfaceWaterLevel` (−∞ allowed) at an integer block position (x, z); a position
 * outside the world window is the handler's BAD_ARGS.
 * SP5a (spec §2.1, D17): the sim worker's messages, apart from the pool's: `ToSim` (an `attach` as thread 15, a batch of
 * `edits`, a `diff` request with an `id`) and `FromSim` (`attached`, `edited`, `diff`, `error`), checked by `parseToSim`
 * and `parseFromSim`; the edit types come from `sim/edits.ts`, re-exported for the main thread's layers. A `decorate` may
 * carry `diff`, the column's edit entries for D's overlay (§2.5), checked by `parseToWorker`.
 */
import { MAP_LEVELS, MAP_TILE_PX, PART_BUDGET, SLICE_NS, type MapLevel } from '../core/constants';
import type { StageId } from '../core/ids';
import type { KnotPath } from '../core/spline/types';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import type { ProbeField, SliceField } from '../gen/inspect/fieldSlice';
import { isLayerId, type LayerId } from '../gen/map/layers';
import type { SplineLeaf } from '../metrics/splineStats';
import type { Edit, EditRefusal } from '../sim/edits';
import { payloadProblem, type ColumnMeshPayload } from '../mesh/column';
import { REGISTRY } from '../world/blocks/index';
import type { ColumnDiff, ColumnView } from '../world/store/api';
import { COLUMN_TABLE_BYTES } from '../world/store/columnTable';
import { EPOCH_CELL, EPOCH_CELL_COUNT } from '../world/store/epochs';
import { BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, GROW_BYTES, type PoolHandles } from '../world/store/pool';
import { RECLAIM_BYTES, RECLAIM_THREADS, SIM_THREAD } from '../world/store/reclaim';
import { STATE_TABLE_SIZE, type StoreHandles } from '../world/store/store';

export { COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, DRAFT_BUDGET, PART_BUDGET, REQUEST_BUDGET, SLICE_RULE_NA } from '../core/constants';

const LEVELS: readonly number[] = MAP_LEVELS;
const NS: readonly number[] = SLICE_NS;

/**
 * `epochs` is the pool's four per-scope epoch cells (SP4b spec §2.7: four Int32 in a 16-byte SharedArrayBuffer, terrain,
 * decorate, light and mesh; the store's `epochs` on the world page), or null without cross-origin isolation.
 */
export interface ConfigureMsg { readonly type: 'configure'; readonly epoch: number; readonly seedText: string; readonly params: unknown; readonly epochs: SharedArrayBuffer | null }
/**
 * What every job but `selftest` carries (SP4b spec §2.7): `epoch`, its configure generation, and `scope`, the value of its
 * phase's epoch cell (`cellOf`) when the pool issued it.
 */
interface Scoped { readonly jobId: number; readonly epoch: number; readonly scope: number }
export interface MapTileMsg extends Scoped { readonly type: 'mapTile'; readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }
export interface PointMsg extends Scoped { readonly type: 'point'; readonly x: number; readonly z: number }
export interface SpawnMsg extends Scoped { readonly type: 'spawn' }
export interface SelftestMsg { readonly type: 'selftest'; readonly jobId: number; readonly key: string }
/**
 * A stats job over points [from, to) of its kind's fixed stream. `args.len` is the Float64 length of the
 * kind's sum, which the kind's module in src/metrics exports (splineStatsLength, biomeSharesLength); the
 * worker replies BAD_ARGS when it does not match the configured params.
 */
interface StatsBase extends Scoped { readonly type: 'stats'; readonly from: number; readonly to: number }
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
export interface SliceMsg extends Scoped {
  readonly type: 'slice';
  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
  readonly from: number; readonly to: number;
}
/**
 * The final state and the surface-rule branch path of voxel (x, y, z) (SP3c spec §6). The position is only checked to be
 * numbers here; non-integers, a position outside the half-open world window or a y outside −64 … 319 is the handler's
 * BAD_ARGS (`surfaceProbeProblem`).
 */
export interface SurfaceProbeMsg extends Scoped { readonly type: 'surfaceProbe'; readonly x: number; readonly y: number; readonly z: number }
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
export type FieldSliceMsg = FieldSliceSpec & Scoped & { readonly type: 'fieldSlice'; readonly from: number; readonly to: number };
/** The value of a field at voxel (x, y, z) (SP3d spec §5.3); the position, the path and the bound are the handler's BAD_ARGS. */
export interface FieldProbeSpec { readonly field: ProbeField; readonly path: string; readonly x: number; readonly y: number; readonly z: number }
export type FieldProbeMsg = FieldProbeSpec & Scoped & { readonly type: 'fieldProbe' };
/**
 * The page's shared store, sent once per worker before its configure (SP4a spec §2.3); answered `attached`, or a job-less
 * BAD_MESSAGE (handles the guard refuses, or a worker already attached to another store or as another thread). `thread`
 * (1 … 15) is the worker's index in the store's reclaim buffer and its pool lock word (SP4b spec §2.5, §2.6): the pool's
 * worker w attaches as w + 1. An attach repeating the worker's store id and thread is answered `attached` again (SP4b
 * spec §2.8), so a retried `attachStore` succeeds.
 */
export interface AttachMsg { readonly type: 'attach'; readonly handles: StoreHandles; readonly thread: number }
/** The four world jobs (SP4a spec §2.3): T, the D skeleton, the exact light and the column mesh. */
export type WorldJobType = 'terrain' | 'decorate' | 'light' | 'meshColumn';
/**
 * A world job on column (cx, cz) of the attached store; cx and cz are integers whose blocks lie in the world window.
 * `protoOnly` (terrain only, a boolean when present; SP4b spec §3.7): `T(protoOnly)`, which regenerates the freed proto of
 * a Decorated or Published column through `reopenProto`. `diff` (decorate only; SP5a spec §2.5): the column's edit
 * entries, which D overlays; equal lengths, `sy` < 24, `idx` < 4096 and every value's state (`value >>> 8`) a registry
 * state. The pool posts it without a transfer list, so it is cloned (a few KB).
 */
export interface WorldJobMsg extends Scoped {
  readonly type: WorldJobType; readonly cx: number; readonly cz: number; readonly protoOnly?: boolean; readonly diff?: ColumnDiff;
}
/**
 * The teleport's landing at block (x, z) (SP4c spec §3.2, D12): integers here (the guard refuses anything else; the
 * caller asks at the clicked block ⌊x⌋, ⌊z⌋); a position outside the half-open world window is the handler's BAD_ARGS.
 */
export type LandingMsg = Scoped & { readonly type: 'landing'; readonly x: number; readonly z: number };
export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SliceMsg | SurfaceProbeMsg | SelftestMsg | FieldSliceMsg | FieldProbeMsg
  | AttachMsg | WorldJobMsg | LandingMsg;
/** Every job type that carries an `epoch` and a `scope` (SP4b spec §2.7): all but configure, attach and selftest. */
export type ScopedJobType = Exclude<ToWorker['type'], 'configure' | 'attach' | 'selftest'>;
/** Each scoped job type's epoch cell (a record, so a new job type cannot be left out). */
const CELL_OF: Readonly<Record<ScopedJobType, 0 | 1 | 2 | 3>> = Object.freeze({
  mapTile: EPOCH_CELL.terrain, point: EPOCH_CELL.terrain, spawn: EPOCH_CELL.terrain, stats: EPOCH_CELL.terrain, slice: EPOCH_CELL.terrain,
  surfaceProbe: EPOCH_CELL.terrain, fieldSlice: EPOCH_CELL.terrain, fieldProbe: EPOCH_CELL.terrain, terrain: EPOCH_CELL.terrain,
  decorate: EPOCH_CELL.decorate, light: EPOCH_CELL.light, meshColumn: EPOCH_CELL.mesh, landing: EPOCH_CELL.terrain,
});
/**
 * The epoch cell a job of `type` reads (SP4b spec §2.7): decorate 1, light 2, meshColumn 3, every other scoped type 0
 * (terrain, spawn, map tiles, stats, slices, field slices, probes, points and landing).
 */
export const cellOf = (type: ScopedJobType): 0 | 1 | 2 | 3 => CELL_OF[type];

export interface ReadyMsg { readonly type: 'ready'; readonly epoch: number; readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }
/** `ids` (256·256 biome ids, one per pixel) comes with layer 'biome' only. */
export interface TileMsg { readonly type: 'tile'; readonly jobId: number; readonly epoch: number; readonly rgba: ArrayBuffer; readonly ids?: ArrayBuffer }
export interface PointResultMsg { readonly type: 'pointResult'; readonly jobId: number; readonly epoch: number; readonly fields: ColumnPoint }
/**
 * ABORTED: the job's epoch cell moved from its scope (the pool reads it as JobCancelled). BAD_ARGS: a stats job's arguments do
 * not fit the configured params. NOT_ATTACHED: a world job before `attach`. STORE_FULL: a world job's store pool is at its
 * maximum (`StoreFull`; the pool rejects with `StoreFullError`). STORE_CORRUPT: a world job met `StoreCorrupt` (a pool lock
 * held by a failed thread, SP4b spec §2.6; the pool rejects with `StoreCorruptError`, which is fatal).
 */
export type ErrorCode = 'BAD_MESSAGE' | 'BAD_PARAMS' | 'NOT_CONFIGURED' | 'STALE_EPOCH' | 'INTERNAL' | 'ABORTED' | 'BAD_ARGS' | 'NOT_ATTACHED' | 'STORE_FULL'
  | 'STORE_CORRUPT';
/** Every `ErrorCode` (a record, so a new code cannot be left out of the reply guard). */
const ERROR_CODES: Readonly<Record<ErrorCode, true>> = Object.freeze({
  BAD_MESSAGE: true, BAD_PARAMS: true, NOT_CONFIGURED: true, STALE_EPOCH: true, INTERNAL: true, ABORTED: true, BAD_ARGS: true,
  NOT_ATTACHED: true, STORE_FULL: true, STORE_CORRUPT: true,
});
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
/** The answer to an `attach` (no jobId, no epoch; ruling P28). */
export interface AttachedMsg { readonly type: 'attached' }
/**
 * A T, D or L job done (SP4a spec §2.3): its column and the job's time in ms. `versions` is the light job's 3 × 3
 * versions read before it (an Int32Array(18), 72 bytes, transferred), null for terrain and decorate.
 */
export interface ColumnDoneMsg {
  readonly type: 'columnDone'; readonly jobId: number; readonly epoch: number;
  readonly job: 'terrain' | 'decorate' | 'light'; readonly cx: number; readonly cz: number; readonly ms: number;
  readonly versions: ArrayBuffer | null;
}
/**
 * A column's mesh payload (SP4a spec §5.8), each of its seven arrays as its own transferred buffer: versions Int32 × 18,
 * connectivity Uint16 × 24, position Uint8 × 4 per vertex, data Uint32 per vertex, index Uint32, rows Int32 × `ROW_INTS`
 * per row, spheres Float32 × 4 per row. `payloadOfMeshResult` rebuilds the payload.
 */
export interface MeshColumnResultMsg {
  readonly type: 'meshColumnResult'; readonly jobId: number; readonly epoch: number; readonly cx: number; readonly cz: number; readonly ms: number;
  readonly versions: ArrayBuffer; readonly connectivity: ArrayBuffer; readonly position: ArrayBuffer; readonly data: ArrayBuffer;
  readonly index: ArrayBuffer; readonly rows: ArrayBuffer; readonly spheres: ArrayBuffer;
}
/**
 * A landing's answer (SP4c spec §3.2): `surface`, `landingSurface` at the job's (x, z) (an integer); `water`, the column's
 * `surfaceWaterLevel` (63 over ocean and river, the lake's level, −∞ elsewhere).
 */
export interface LandingResultMsg { readonly type: 'landingResult'; readonly jobId: number; readonly epoch: number; readonly surface: number; readonly water: number }
export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SliceResultMsg | SurfaceProbeResultMsg | SelftestResultMsg | FieldSliceResultMsg | FieldProbeResultMsg | ErrorMsg
  | AttachedMsg | ColumnDoneMsg | MeshColumnResultMsg | LandingResultMsg;
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
/** Null, or the four per-scope epoch cells' buffer: a SharedArrayBuffer of 16 bytes (SP4b spec §2.7). */
const isEpochCells = (v: unknown): boolean => v === null || (typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer && v.byteLength === 4 * EPOCH_CELL_COUNT);
/** A job's integer jobId, epoch and scope (SP4b spec §2.7). */
const scopedOk = (m: Record<string, unknown>): boolean => isInt(m['jobId']) && isInt(m['epoch']) && isInt(m['scope']);
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
  return scopedOk(m) && typeof m['field'] === 'string' && SLICE_FIELDS.includes(m['field']) && isPath(m['path'])
    && [...PLANE_KEYS[plane], ...FIELD_SLICE_KEYS].every((k) => typeof m[k] === 'number') && other.every((k) => !Object.hasOwn(m, k));
};
const fieldProbeOk = (m: Record<string, unknown>): boolean =>
  scopedOk(m) && typeof m['field'] === 'string' && PROBE_FIELDS.includes(m['field']) && isPath(m['path']) && VOXEL_KEYS.every((k) => typeof m[k] === 'number');

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
  if (!scopedOk(m) || !isStatsKind(m['kind'])) return false;
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
/** Why (x, z) is not a position a landing can read (integers in the half-open world window), or null when it is. */
export const landingProblem = (x: number, z: number): string | null =>
  Number.isInteger(x) && Number.isInteger(z) && pointInWindow(x, z) ? null : `(x, z) = (${x}, ${z}) is not an integer position in the world window`;
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

/** Whether column (cx, cz) is a pair of integers whose blocks lie in the world window (cx, cz ∈ [−2^15, 2^15)). */
const isColumn = (cx: unknown, cz: unknown): boolean => isInt(cx) && isInt(cz) && pointInWindow(16 * cx, 16 * cz);
const isShared = (v: unknown): v is SharedArrayBuffer => typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer;
/**
 * A shared pool's handles of the documented sizes (ruling P23; `pool.ts`): `ctl` 16 bytes; `data`, `stack` and `refs`
 * growable, `data`'s maximum a positive multiple of `GROW_BYTES` and of `slotBytes`, `stack` and `refs` 4 bytes per slot of
 * it. Current lengths are never checked (another thread may grow the pool).
 */
const sharedPoolOk = (p: unknown, slotBytes: number): boolean => {
  if (!isObj(p) || p['shared'] !== true || p['slotBytes'] !== slotBytes) return false;
  const { data, ctl, stack, refs } = p as unknown as PoolHandles;
  if (!isShared(data) || !isShared(ctl) || !isShared(stack) || !isShared(refs)) return false;
  if (ctl.byteLength !== 16 || !data.growable || !stack.growable || !refs.growable) return false;
  const max = data.maxByteLength;
  if (!(max > 0 && max % GROW_BYTES === 0 && max % slotBytes === 0)) return false;
  const stackBytes = 4 * (max / slotBytes);
  return stack.maxByteLength === stackBytes && refs.maxByteLength === stackBytes;
};
/**
 * The attach guard (SP4a spec §2.3, ruling P23): a shared store whose nine state buffers (table, epochs, the reclaim
 * buffer of SP4b spec §2.5, and each pool's data, ctl, stack and refs) are `SharedArrayBuffer`s of the documented sizes,
 * and a 4096-entry `pass` table (a private copy on an ArrayBuffer, exempt from the kind rule).
 */
const storeHandlesOk = (h: unknown): boolean =>
  isObj(h) && h['shared'] === true
  && isShared(h['table']) && h['table'].byteLength === COLUMN_TABLE_BYTES
  && isShared(h['epochs']) && h['epochs'].byteLength === 4 * EPOCH_CELL_COUNT
  && isShared(h['reclaim']) && h['reclaim'].byteLength === RECLAIM_BYTES
  && sharedPoolOk(h['blocks'], BLOCK_SLOT_BYTES) && sharedPoolOk(h['bytes'], BYTE_SLOT_BYTES)
  && h['pass'] instanceof Uint8Array && h['pass'].length === STATE_TABLE_SIZE;

/** A worker's reclaim thread (SP4b spec §2.5): 1 … 15 (0 is the main thread). */
const isWorkerThread = (t: unknown): boolean => isInt(t) && t >= 1 && t < RECLAIM_THREADS;
/** `protoOnly` absent, or a boolean on a terrain job (SP4b spec §3.7). */
const protoOnlyOk = (m: Record<string, unknown>): boolean =>
  m['protoOnly'] === undefined || (m['type'] === 'terrain' && typeof m['protoOnly'] === 'boolean');
/** Every value's state (`value >>> 8`) below the registry's `stateCount`. */
const diffStatesOk = (value: Uint32Array): boolean => {
  const n = REGISTRY.stateCount;
  for (let k = 0; k < value.length; k++) if (value[k]! >>> 8 >= n) return false;
  return true;
};
/**
 * `diff` absent, or on a decorate job (SP5a spec §2.5): a `Uint8Array` `sy`, `Uint16Array` `idx` and `Uint32Array`
 * `value` of one length, each `sy` < 24, `idx` < 4096 and state a registry state.
 */
const diffOk = (m: Record<string, unknown>): boolean => {
  const d = m['diff'];
  if (d === undefined) return true;
  if (m['type'] !== 'decorate' || !isObj(d)) return false;
  const { sy, idx, value } = d;
  return sy instanceof Uint8Array && idx instanceof Uint16Array && value instanceof Uint32Array
    && idx.length === sy.length && value.length === sy.length && diffEntriesOk(sy, idx) && diffStatesOk(value);
};

/** Validates a message sent to a worker; null when malformed. */
export function parseToWorker(m: unknown): ToWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'configure':
      return isInt(m['epoch']) && typeof m['seedText'] === 'string' && m['seedText'].trim() !== '' && 'params' in m && isEpochCells(m['epochs']) ? (m as unknown as ConfigureMsg) : null;
    case 'mapTile': {
      const level = m['level'];
      if (!scopedOk(m) || !isLayerId(m['layer'])) return null;
      if (!isInt(level) || !LEVELS.includes(level) || !tileOk(m['tx'], level) || !tileOk(m['tz'], level)) return null;
      return m as unknown as MapTileMsg;
    }
    case 'point':
      return scopedOk(m) && isFiniteNum(m['x']) && isFiniteNum(m['z']) && pointInWindow(m['x'], m['z']) ? (m as unknown as PointMsg) : null;
    case 'spawn':
      return scopedOk(m) ? (m as unknown as SpawnMsg) : null;
    case 'stats':
      return statsOk(m) ? (m as unknown as StatsMsg) : null;
    case 'slice':
      return scopedOk(m) && SLICE_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SliceMsg) : null;
    case 'surfaceProbe':
      return scopedOk(m) && VOXEL_KEYS.every((k) => typeof m[k] === 'number') ? (m as unknown as SurfaceProbeMsg) : null;
    case 'selftest':
      return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
    case 'fieldSlice':
      return fieldSliceOk(m) ? (m as unknown as FieldSliceMsg) : null;
    case 'fieldProbe':
      return fieldProbeOk(m) ? (m as unknown as FieldProbeMsg) : null;
    case 'attach':
      return storeHandlesOk(m['handles']) && isWorkerThread(m['thread']) ? (m as unknown as AttachMsg) : null;
    case 'terrain': case 'decorate': case 'light': case 'meshColumn':
      return scopedOk(m) && isColumn(m['cx'], m['cz']) && protoOnlyOk(m) && diffOk(m) ? (m as unknown as WorldJobMsg) : null;
    case 'landing':
      return scopedOk(m) && isInt(m['x']) && isInt(m['z']) ? (m as unknown as LandingMsg) : null;
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
const COLUMN_DONE_JOBS: readonly string[] = ['terrain', 'decorate', 'light'];
/** Bytes of a light job's or a mesh payload's 3 × 3 versions (Int32 × 18) and of a payload's connectivity (Uint16 × 24). */
const VERSIONS_BYTES = 72;
const CONNECTIVITY_BYTES = 48;
/** Bytes per row of a payload's table (Int32 × `ROW_INTS`) and of its spheres (Float32 × 4). */
const ROW_BYTES = 24;
const SPHERE_BYTES = 16;
/** The column and the time a world reply carries. */
const columnProblem = (m: Record<string, unknown>): string | null =>
  all(epochProblem(m), isColumn(m['cx'], m['cz']) ? null : `cx, cz (${String(m['cx'])}, ${String(m['cz'])}) is not a column of the world window`,
    isFiniteNum(m['ms']) && m['ms'] >= 0 ? null : 'ms is not a finite non-negative number');
const columnDoneCheck: ReplyCheck = (m) => {
  const job = m['job'];
  if (typeof job !== 'string' || !COLUMN_DONE_JOBS.includes(job)) return `job ${String(job)} is not terrain, decorate or light`;
  return all(columnProblem(m), bufferProblem('versions', m['versions'], job === 'light' ? VERSIONS_BYTES : 0));
};
/** Why `v` is not an ArrayBuffer of a whole number of `unit`-byte items, or null. */
const unitsProblem = (name: string, v: unknown, unit: number): string | null =>
  v instanceof ArrayBuffer && v.byteLength % unit === 0 ? null : `${name} is not an ArrayBuffer of a multiple of ${unit} bytes`;
/** Why `v` is not an ArrayBuffer of exactly `bytes` bytes (0 included), or null. */
const exactProblem = (name: string, v: unknown, bytes: number): string | null =>
  v instanceof ArrayBuffer && v.byteLength === bytes ? null : `${name} is not an ArrayBuffer of ${bytes} bytes`;
const meshColumnCheck: ReplyCheck = (m) => {
  const shape = all(columnProblem(m),
    exactProblem('versions', m['versions'], VERSIONS_BYTES), exactProblem('connectivity', m['connectivity'], CONNECTIVITY_BYTES),
    unitsProblem('position', m['position'], 4), unitsProblem('data', m['data'], 4), unitsProblem('index', m['index'], 4),
    unitsProblem('rows', m['rows'], ROW_BYTES));
  if (shape !== null) return shape;
  const r = m as unknown as MeshColumnResultMsg;
  // One Uint8 × 4 position and one Uint32 data word per vertex; one sphere per row.
  return all(r.position.byteLength === r.data.byteLength ? null : `position (${r.position.byteLength} bytes) and data (${r.data.byteLength} bytes) hold different vertex counts`,
    exactProblem('spheres', r.spheres, SPHERE_BYTES * (r.rows.byteLength / ROW_BYTES)))
    ?? payloadProblem(payloadOfMeshResult(r));
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
  columnDone: columnDoneCheck,
  meshColumnResult: meshColumnCheck,
  landingResult: (m) => {
    const water = m['water'];
    return all(epochProblem(m), isInt(m['surface']) ? null : 'surface is not an integer',
      water === -Infinity || isFiniteNum(water) ? null : 'water is not a finite number or −∞');
  },
  error: (m) => (m['epoch'] === null || isInt(m['epoch'])) && typeof m['code'] === 'string' && Object.hasOwn(ERROR_CODES, m['code']) && typeof m['message'] === 'string'
    ? null : 'epoch, code or message is malformed',
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
  if (type === 'attached') return m as unknown as AttachedMsg;
  if (typeof type !== 'string' || !Object.hasOwn(REPLY_CHECKS, type)) return null;
  const jobId = m['jobId'];
  if (type === 'error' && jobId === null) return REPLY_CHECKS[type]!(m) === null ? (m as unknown as ErrorMsg) : null;
  if (!isInt(jobId)) return null;
  const reason = REPLY_CHECKS[type]!(m);
  return reason === null ? (m as unknown as FromWorker) : { bad: true, jobId, reason: `${type}: ${reason}` };
}

/**
 * The column payload of a `meshColumnResult` (SP4a spec §5.8): whole-buffer typed views over its seven transferred
 * buffers (ruling P27). The byte lengths must already be whole items (the reply guard checks them first).
 */
export function payloadOfMeshResult(m: MeshColumnResultMsg): ColumnMeshPayload {
  return {
    cx: m.cx, cz: m.cz,
    versions: new Int32Array(m.versions), connectivity: new Uint16Array(m.connectivity), position: new Uint8Array(m.position),
    data: new Uint32Array(m.data), index: new Uint32Array(m.index), rows: new Int32Array(m.rows), spheres: new Float32Array(m.spheres),
  };
}

// ---------------------------------------------------------------- the sim worker (SP5a spec §2.1, D17)

export type { Edit, EditRefusal } from '../sim/edits';

/**
 * A batch of voxel edits (§2.1), all or nothing: each at an integer (x, z) of the world window and y −64 … 319, `op`
 * 'set' or 'revert', `value` and `expect` u32 (`state << 8 | fluid`). `id` matches the `edited` reply to it.
 */
export interface EditsMsg { readonly type: 'edits'; readonly id: number; readonly edits: readonly Edit[] }
/** A request for column (cx, cz)'s DiffStore entries (§2.5); `id` matches the `diff` reply to it. */
export interface DiffRequestMsg { readonly type: 'diff'; readonly id: number; readonly cx: number; readonly cz: number }
/** What the main thread sends the sim: its store once, as thread 15 (an `AttachMsg` with `thread` 15 only), then edits and diff requests. */
export type ToSim = AttachMsg | EditsMsg | DiffRequestMsg;
/**
 * A batch's outcome (§2.1; `sim/edits.ts`'s `EditResult`): `prev[k]` and `next[k]` edit k's entry before and after it
 * (0xFFFFFFFF for none), `dirty` the colKeys to remesh (§2.6), `entryCols` the colKeys holding entries; each array
 * transferred.
 */
export interface EditedMsg {
  readonly type: 'edited'; readonly id: number; readonly prev: Uint32Array; readonly next: Uint32Array; readonly dirty: Float64Array;
  readonly entryCols: Float64Array; readonly refused: EditRefusal | null; readonly relightMs: number; readonly editMs: number;
}
/**
 * Column (cx, cz)'s entries in canonical order (§2.4, §2.5): section `sy` (0 … 23), voxel `idx` (0 … 4095) and its
 * value, transferred; zero-length arrays when the column holds none (ruling R9).
 */
export interface DiffMsg {
  readonly type: 'diff'; readonly id: number; readonly cx: number; readonly cz: number;
  readonly sy: Uint8Array; readonly idx: Uint16Array; readonly value: Uint32Array;
}
/** What the sim answers; an `error`'s `jobId` is the id of the message it answers (null when unreadable), its `epoch` null. */
export type FromSim = AttachedMsg | EditedMsg | DiffMsg | ErrorMsg;

/** Every `EditRefusal` (a record, so a new refusal cannot be left out of the reply guard). */
const EDIT_REFUSALS: Readonly<Record<EditRefusal, true>> = Object.freeze({ unloaded: true, changed: true, noProto: true, full: true });
const isU32 = (v: unknown): v is number => isInt(v) && v >= 0 && v <= 0xFFFFFFFF;
/** One edit of a batch: integer coordinates inside the world, a known op, u32 value and expect. */
const editOk = (e: unknown): boolean =>
  isObj(e) && isInt(e['x']) && isInt(e['z']) && pointInWindow(e['x'], e['z']) && isInt(e['y']) && e['y'] >= -64 && e['y'] <= 319
  && (e['op'] === 'set' || e['op'] === 'revert') && isU32(e['value']) && isU32(e['expect']);

/** Validates a message sent to the sim; null when malformed. */
export function parseToSim(m: unknown): ToSim | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'attach':
      return storeHandlesOk(m['handles']) && m['thread'] === SIM_THREAD ? (m as unknown as AttachMsg) : null;
    case 'edits': {
      const edits = m['edits'];
      return isInt(m['id']) && Array.isArray(edits) && edits.every(editOk) ? (m as unknown as EditsMsg) : null;
    }
    case 'diff':
      return isInt(m['id']) && isColumn(m['cx'], m['cz']) ? (m as unknown as DiffRequestMsg) : null;
    default:
      return null;
  }
}

/** Every `sy` below 24 and every `idx` below 4096. */
const diffEntriesOk = (sy: Uint8Array, idx: Uint16Array): boolean => {
  for (let k = 0; k < sy.length; k++) if (sy[k]! >= 24 || idx[k]! >= 4096) return false;
  return true;
};

/** Validates a reply of the sim; null when malformed (the page treats it as the sim's failure, §2.1). */
export function parseFromSim(m: unknown): FromSim | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'attached':
      return m as unknown as AttachedMsg;
    case 'edited': {
      const { prev, next, refused } = m;
      return isInt(m['id']) && prev instanceof Uint32Array && next instanceof Uint32Array && next.length === prev.length
        && m['dirty'] instanceof Float64Array && m['entryCols'] instanceof Float64Array
        && (refused === null || (typeof refused === 'string' && Object.hasOwn(EDIT_REFUSALS, refused)))
        && isFiniteNum(m['relightMs']) && isFiniteNum(m['editMs'])
        ? (m as unknown as EditedMsg) : null;
    }
    case 'diff': {
      const { sy, idx, value } = m;
      return isInt(m['id']) && isColumn(m['cx'], m['cz']) && sy instanceof Uint8Array && idx instanceof Uint16Array
        && value instanceof Uint32Array && idx.length === sy.length && value.length === sy.length && diffEntriesOk(sy, idx)
        ? (m as unknown as DiffMsg) : null;
    }
    case 'error':
      return (m['jobId'] === null || isInt(m['jobId'])) && REPLY_CHECKS['error']!(m) === null ? (m as unknown as ErrorMsg) : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the spike's shared store (SP4a spec §1.2 item 6)

/**
 * The store spike's messages (SP4a spec §1.1, §1.2 item 6; ruling P18), outside `ToWorker`: the page posts its store's
 * handles with `spikeWrite`; worker `index` attaches, claims columns (index, 0 … columnsPerWorker − 1), writes 24 dense
 * proto sections into each with `spikeSectionFill` and commits them. After every worker has answered, `spikeCrossRead`
 * asks it to check the columns (cx, 0 … columnsPerWorker − 1) another worker wrote.
 */
export interface SpikeWriteMsg { readonly type: 'spikeWrite'; readonly handles: StoreHandles; readonly index: number; readonly columnsPerWorker: number }
export interface SpikeCrossReadMsg { readonly type: 'spikeCrossRead'; readonly cx: number; readonly columnsPerWorker: number }
export type SpikeStoreToWorker = SpikeWriteMsg | SpikeCrossReadMsg;
/** `blockMiB` and `byteMiB` are the pools' byte lengths this worker sees after its writes. */
export interface SpikeWrittenMsg { readonly type: 'spikeWritten'; readonly index: number; readonly blockMiB: number; readonly byteMiB: number; readonly errors: readonly string[] }
export interface SpikeCrossCheckedMsg { readonly type: 'spikeCrossChecked'; readonly ok: number; readonly total: number; readonly errors: readonly string[] }
export type SpikeStoreFromWorker = SpikeWrittenMsg | SpikeCrossCheckedMsg;

/** A worker's columns lie on one torus row: at most 64 (`TORUS`, world/store/columnTable.ts). */
const SPIKE_COLUMNS_MAX = 64;

const isCount = (v: unknown): v is number => isInt(v) && v >= 1 && v <= SPIKE_COLUMNS_MAX;
const isStrings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((e) => typeof e === 'string');
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** The shape of `VoxelStore.handles()`; whether the buffers attach is `attachStore`'s check. */
const isStoreHandles = (v: unknown): v is StoreHandles =>
  isObj(v) && typeof v['shared'] === 'boolean' && isObj(v['blocks']) && isObj(v['bytes']) && typeof v['table'] === 'object' && v['table'] !== null
  && typeof v['epochs'] === 'object' && v['epochs'] !== null && typeof v['reclaim'] === 'object' && v['reclaim'] !== null
  && v['pass'] instanceof Uint8Array;

/** A store spike message to the worker, or null. */
export function parseSpikeStoreToWorker(m: unknown): SpikeStoreToWorker | null {
  if (!isObj(m)) return null;
  if (m['type'] === 'spikeWrite') {
    return isStoreHandles(m['handles']) && isInt(m['index']) && m['index'] >= 0 && isCount(m['columnsPerWorker']) ? (m as unknown as SpikeWriteMsg) : null;
  }
  if (m['type'] === 'spikeCrossRead') return isInt(m['cx']) && isCount(m['columnsPerWorker']) ? (m as unknown as SpikeCrossReadMsg) : null;
  return null;
}

/** A store spike reply, or null. */
export function parseSpikeStoreFromWorker(m: unknown): SpikeStoreFromWorker | null {
  if (!isObj(m) || !isStrings(m['errors'])) return null;
  if (m['type'] === 'spikeWritten') {
    return isInt(m['index']) && isSize(m['blockMiB']) && isSize(m['byteMiB']) ? (m as unknown as SpikeWrittenMsg) : null;
  }
  if (m['type'] === 'spikeCrossChecked') {
    const { ok, total } = m;
    return isInt(ok) && isInt(total) && ok >= 0 && ok <= total ? (m as unknown as SpikeCrossCheckedMsg) : null;
  }
  return null;
}

/**
 * The store spike's fill of section `sy` of column (cx, cz), shared by the writing worker, the reading worker and the
 * page: 4096 block states and 4096 fluid bytes that vary with the voxel (dense, never uniform) and with the column.
 */
export function spikeSectionFill(cx: number, cz: number, sy: number, blocks: Uint16Array, fluid: Uint8Array): void {
  for (let i = 0; i < 4096; i++) {
    blocks[i] = (i * 7 + cx * 131 + cz * 31 + sy * 17) & 4095;
    fluid[i] = (i + cx * 3 + cz * 5 + sy) & 255;
  }
}

/** Null when the proto set of (cx, cz) holds `spikeSectionFill`'s values in all 24 sections, otherwise the first problem. */
export function spikeColumnProblem(view: ColumnView | null, cx: number, cz: number): string | null {
  if (view === null) return `column (${cx}, ${cz}) is absent`;
  const blocks = new Uint16Array(4096);
  const fluid = new Uint8Array(4096);
  for (let sy = 0; sy < 24; sy++) {
    spikeSectionFill(cx, cz, sy, blocks, fluid);
    const b = view.sectionBlocks(sy);
    const f = view.sectionFluid(sy);
    if (typeof b === 'number' || typeof f === 'number') return `column (${cx}, ${cz}) section ${sy} is uniform`;
    for (let i = 0; i < 4096; i++) {
      if (b[i] !== blocks[i] || f[i] !== fluid[i]) return `column (${cx}, ${cz}) section ${sy} voxel ${i} differs`;
    }
  }
  return null;
}

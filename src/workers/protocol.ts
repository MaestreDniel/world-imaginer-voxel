/**
 * Task-pool protocol (SP2a spec §5.1): plain messages, validated at both ends by hand-written guards.
 * The main thread sends configure / mapTile / point / spawn / stats / slice / selftest; the worker answers ready /
 * tile / pointResult / spawnResult / statsResult / sliceResult / selftestResult / error. selftest needs no configure.
 * Configure carries the pool's abort cell (SP2b spec §2.2), errors carry the epoch of the message they
 * answer (§2.3), biome tiles carry the biome id of every pixel (§5.3), and a stats job returns the raw
 * sums of one kind over a range of the kind's fixed point stream (§5.4) or, for crossSection, of the points
 * along its line (§4.5). A slice job (SP3a spec §5.1) returns the voxels of the vertical slice under a line, for a
 * range [from, to) of its 512 samples (SP3b spec §6: the pool splits a slice across its workers).
 */
import { MAP_LEVELS, MAP_TILE_PX, type MapLevel } from '../core/constants';
import type { StageId } from '../core/ids';
import type { KnotPath } from '../core/spline/types';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import { isLayerId, type LayerId } from '../gen/map/layers';
import type { SplineLeaf } from '../metrics/splineStats';

const LEVELS: readonly number[] = MAP_LEVELS;

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
export type ToWorker = ConfigureMsg | MapTileMsg | PointMsg | SpawnMsg | StatsMsg | SliceMsg | SelftestMsg;

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
export type FromWorker = ReadyMsg | TileMsg | PointResultMsg | SpawnResultMsg | StatsResultMsg | SliceResultMsg | SelftestResultMsg | ErrorMsg;

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
    case 'selftest':
      return isInt(m['jobId']) && typeof m['key'] === 'string' ? (m as unknown as SelftestMsg) : null;
    default:
      return null;
  }
}

/** Validates a worker reply; null when malformed. */
export function parseFromWorker(m: unknown): FromWorker | null {
  if (!isObj(m)) return null;
  switch (m['type']) {
    case 'ready': return isInt(m['epoch']) && isObj(m['stageHashes']) && typeof m['genKey'] === 'string' ? (m as unknown as ReadyMsg) : null;
    case 'tile': {
      const ids = m['ids'];
      const idsOk = ids === undefined || (ids instanceof ArrayBuffer && ids.byteLength === 256 * 256);
      return isInt(m['jobId']) && isInt(m['epoch']) && m['rgba'] instanceof ArrayBuffer && m['rgba'].byteLength === 256 * 256 * 4 && idsOk ? (m as unknown as TileMsg) : null;
    }
    case 'pointResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['fields']) ? (m as unknown as PointResultMsg) : null;
    case 'selftestResult': return isInt(m['jobId']) && typeof m['key'] === 'string' && (m['actual'] === null || typeof m['actual'] === 'string') && (m['error'] === null || typeof m['error'] === 'string') ? (m as unknown as SelftestResultMsg) : null;
    case 'spawnResult': return isInt(m['jobId']) && isInt(m['epoch']) && isObj(m['spawn']) ? (m as unknown as SpawnResultMsg) : null;
    case 'statsResult': {
      // The pool checks the length against the request's args.len (the protocol does not import metrics).
      const data = m['data'];
      return isInt(m['jobId']) && isInt(m['epoch']) && isStatsKind(m['kind']) && data instanceof ArrayBuffer && data.byteLength > 0 && data.byteLength % 8 === 0 ? (m as unknown as StatsResultMsg) : null;
    }
    case 'sliceResult': {
      const blocks = m['blocks'];
      const fluid = m['fluid'];
      const from = m['from'];
      const to = m['to'];
      if (typeof from !== 'number' || typeof to !== 'number' || sliceRangeProblem(from, to) !== null) return null;
      const n = (to - from) * SLICE_ROWS;
      const ok = blocks instanceof ArrayBuffer && blocks.byteLength === 2 * n && fluid instanceof ArrayBuffer && fluid.byteLength === n;
      return isInt(m['jobId']) && isInt(m['epoch']) && ok ? (m as unknown as SliceResultMsg) : null;
    }
    case 'error': return (m['jobId'] === null || isInt(m['jobId'])) && (m['epoch'] === null || isInt(m['epoch'])) && typeof m['code'] === 'string' && typeof m['message'] === 'string' ? (m as unknown as ErrorMsg) : null;
    default: return null;
  }
}

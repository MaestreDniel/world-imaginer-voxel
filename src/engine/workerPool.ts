/**
 * Task pool (master §4.1, SP2a spec §5.2): N workers, one configure per epoch (all must agree on the
 * stage hashes), a priority queue of jobs (two lanes since SP4c) with at most one in flight per worker, cancellation, and
 * stale-epoch results dropped. The worker factory is injectable so the logic is testable without a browser.
 * SP2b §2.2-2.3: an optional abort cell (one pool-wide Int32 in a SharedArrayBuffer) holds the pool's epoch,
 * so a worker stops a superseded tile, spawn or stats job within a row or 256 points; job-less errors of
 * other epochs are ignored; a worker that raises an error event is removed and its pending work rejected
 * with WorkerFailed. SP2b §5.4: a stats request runs as `size` slices whose raw sums are added element-wise
 * (a crossSection request as one job, §4.5).
 * SP2b §2.8: `probe()` reports what the workers run, for the latency hook.
 * SP3a §5.1, SP3b §6: a slice request (the voxels under a line) is split into `size` contiguous ranges of its 512
 * samples, as a stats request is; the parts are merged row by row.
 * SP3c §6: a surfaceProbe request (one voxel's final state and surface-rule branch path) is a single job, as a point.
 * SP3d §5: a fieldSlice request is split by `planFieldSlice` (or refused before any job), its parts merged by index into
 * one n × n buffer, each part's reply checked against its request; its handle's `cancel()` drops the queued parts and
 * discards the running ones (they are not interrupted, P1). A fieldProbe request is a single job. A reply that fails its
 * guard rejects its job with BAD_MESSAGE and frees the worker.
 * SP4a §2.3: `attachStore` hands every worker the page's shared store and waits for each `attached`, behind its own
 * barrier (ruling P28); the four world jobs (`terrain`, `decorate`, `light`, `meshColumn`) are single jobs at priority 0
 * (the coordinator orders them), each reply checked against its request's job and column. STORE_FULL rejects with
 * `StoreFullError`.
 * SP4b §2.7: the abort cell became the four per-scope epoch cells (terrain, decorate, light, mesh; the store's `epochs` on
 * the world page). Every job but selftest carries its configure generation (`epoch`) and its phase's cell value at issue
 * (`scope`); a reply settles as JobCancelled when the generation moved, when its cell moved, or on ABORTED. `configure`
 * stores the new generation into all four cells; `bumpScope(from)` (SP4c's Apply) moves the cells from a phase onward.
 * SP4b §2.6, §2.8, §3.7: worker w attaches as reclaim thread w + 1, and a retried `attachStore` succeeds (the attach is
 * idempotent per worker, and each worker's replies count for the attach they answer); `onWorkerDead(thread)` tells the page
 * which thread failed (it marks it dead in the store); STORE_CORRUPT rejects with `StoreCorruptError`; `cancelWorld` drops
 * queued world jobs; `liveWorkers()`; `terminate()` tells `onWorkerDead` each live worker's thread, then settles its barriers
 * and busy jobs with `WorkerFailed('terminated')`; `terrain(cx, cz, true)` is `T(protoOnly)`.
 * SP4c §4.6, §4.9 (D7, D8, ENG-4): a world job whose worker replied OK resolves with its `generation` (its issue epoch)
 * whatever the pool's generation or its cells are now (the worker committed it); ABORTED and STALE_EPOCH reject with
 * JobCancelled; every other job type keeps the rule above. From the second configure on, `configure` moves the generation
 * past every cell (`max(epoch + 1, max(cells) + 1)`), so it differs from every value a job was issued with. `spawn` takes
 * a priority (default −2).
 * SP4c §6.1, §6.2 (D11): two lanes replace the queue sorted on every assignment: the world lane, a FIFO of `terrain`,
 * `decorate`, `light` and `meshColumn` jobs in issue order, and the aux lane, a heap (`jobHeap.ts`) of every other job by
 * (priority, id). `setAuxPolicy(first, cap)` says which lane a free worker serves first and how many non-interactive aux
 * jobs may run; interactive jobs (priority < 0: points, probes, landing, the standalone spawn) always go first, uncapped.
 * SP4c §3.2 (D12): `landing(x, z)`, the teleport's surface and water at a block, is one aux job at −2.
 * SP5a §2.6 (D22): `meshColumn(cx, cz, {edit: true})`, an edit's remesh, is a world job on the aux lane at
 * EDIT_MESH_PRIORITY, so a free worker takes it first and `auxCap` never counts it; `cancelWorld` searches both lanes.
 */
import type { MapLevel } from '../core/constants';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import type { FieldSliceValues } from '../gen/inspect/fieldSlice';
import type { LayerId } from '../gen/map/layers';
import type { Segment } from '../metrics/crossSection';
import type { ColumnMeshPayload } from '../mesh/column';
import {
  cellOf, isRefusableField, parseFromWorker, payloadOfMeshResult, planFieldSlice, SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, STATS_KINDS,
  type FieldProbeSpec, type FieldSliceMsg, type FieldSliceSpec, type FromWorker, type ReadyMsg, type StatsArgs, type StatsKind, type StatsMsg, type ToWorker,
  type WorldJobType,
} from '../workers/protocol';
import type { ColumnDiff } from '../world/store/api';
import { EPOCH_CELL, EPOCH_CELL_COUNT } from '../world/store/epochs';
import type { StoreHandles } from '../world/store/store';
import { createJobHeap } from './jobHeap';
import type { Stage } from './rings';

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  /** The worker failed to load or threw outside the handler. */
  onerror?: ((event: unknown) => void) | null;
  /** A reply of the worker could not be deserialised. */
  onmessageerror?: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface TileRequest { readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }
/** A painted tile: RGBA bytes, and for layer 'biome' the biome id of every pixel (SP2b spec §5.3). */
export interface TileResult { readonly rgba: ArrayBuffer; readonly ids: ArrayBuffer | null }

/**
 * The voxels of the vertical slice under a line (SP3a spec §5.1): SLICE_SAMPLES (512 × 384) block states and fluid
 * bytes, sample (i, y) at `sliceIndex(i, y)` of `workers/protocol.ts` (row 0 is y 319).
 */
export interface SliceResult {
  readonly blocks: Uint16Array<ArrayBuffer>;
  readonly fluid: Uint8Array<ArrayBuffer>;
}

/** A voxel's final state id and its surface-rule branch path (rule ids from `root` to the yielding leaf; [] for none). */
export interface SurfaceProbeResult {
  readonly state: number;
  readonly path: readonly string[];
}

export class JobCancelled extends Error {
  constructor() { super('job cancelled'); }
}

/**
 * A density or node slice refused by the work bound before any job (SP3d spec §5.2): its column cost is above `limit`,
 * the largest column cost `planFieldSlice` accepts for its n and budget.
 */
export class SliceTooHeavy extends Error {
  readonly columnCost: number;
  readonly limit: number;
  constructor(columnCost: number, limit: number) {
    super(`too heavy: column cost ${columnCost}, limit ${limit}`);
    this.name = 'SliceTooHeavy';
    this.columnCost = columnCost;
    this.limit = limit;
  }
}

/** How a field slice runs (SP3d spec §4.5, §5.2): its priority, its column cost (`sliceCostOf`) and its budget (DRAFT_BUDGET or REQUEST_BUDGET). */
export interface FieldSliceOptions {
  readonly priority: number;
  readonly columnCost: number;
  readonly budget: number;
}
/** A merged field slice: n × n samples, sample k of sample column c at c·n + k. */
export type FieldSliceResult = FieldSliceValues & { readonly n: number };
/** A running field slice: its result, and `cancel()`, which rejects it with JobCancelled (a no-op once it settled). */
export interface FieldSliceHandle {
  readonly promise: Promise<FieldSliceResult>;
  cancel(): void;
}

/** A worker raised an error or messageerror event: its in-flight job and a pending configure reject with this. */
export class WorkerFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerFailed';
  }
}

/** A world job's store pool was at its maximum (the worker's STORE_FULL, `StoreFull`; SP4a spec §2.2: suggests a lower RD). */
export class StoreFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreFullError';
  }
}

/**
 * A world job met a pool lock held by a failed thread (the worker's STORE_CORRUPT, `StoreCorrupt`; SP4b spec §2.6): the
 * store can no longer be trusted, so the page shows the failure panel.
 */
export class StoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCorruptError';
  }
}

/**
 * A T, D or L job done (SP4a spec §2.3, ruling P30): its column, the worker's time in ms and, for light, the 3 × 3
 * versions it read before the job (18 values); null for terrain and decorate. `generation` is the pool's epoch when the
 * job was issued (SP4c spec §4.6, D7): an OK reply resolves even after a configure, and the coordinator judges it by it.
 */
export interface ColumnDone {
  readonly cx: number;
  readonly cz: number;
  readonly ms: number;
  readonly versions: Int32Array | null;
  readonly generation: number;
}

/** A MESH_COLUMN job done (SP4c spec §4.6, D7): the column payload and the pool's epoch when the job was issued. */
export interface MeshColumnDone {
  readonly payload: ColumnMeshPayload;
  readonly generation: number;
}

/** The type of a queued job (a configure or an attach is not a job). */
export type JobType = Exclude<ToWorker['type'], 'configure' | 'attach'>;

/** A job a worker is running (SP2b spec §2.8). */
export interface InFlightJob {
  readonly worker: number;
  readonly type: JobType;
  readonly epoch: number;
  /** The tile level of a mapTile job, else null. */
  readonly level: MapLevel | null;
}

/** What the pool runs now: busy workers and their jobs (by worker), queued jobs and whether a configure waits for its barrier. */
export interface PoolProbe {
  readonly busy: number;
  readonly queued: number;
  readonly configuring: boolean;
  readonly jobs: readonly InFlightJob[];
}

/**
 * Which lane a free worker serves first once no interactive job waits (SP4c spec §6.2): 'world' (the 3D visible and the
 * world issuing) or 'aux' (the map covering the 3D, the world held, or the standalone `?map`).
 */
export type AuxFirst = 'world' | 'aux';

/** A pipeline phase whose epoch cell `bumpScope` moves, with every later one (SP4b spec §2.7). */
export type ScopePhase = keyof typeof EPOCH_CELL;

export interface PoolOptions {
  /**
   * The four per-scope epoch cells (SP4b spec §2.7): an Int32Array of length 4 over a 16-byte SharedArrayBuffer (the store's
   * `epochs.cells` on the world page; a TypeError otherwise). The pool writes them only in `configure` and `bumpScope`.
   * Null or absent: jobs are not abortable.
   */
  readonly epochCells?: Int32Array | null;
  /** Called once per failed worker, after its work was rejected. */
  readonly onFailure?: (e: WorkerFailed) => void;
  /**
   * Called once per failed worker with the reclaim thread it was attached as (worker w is thread w + 1), before its work
   * is rejected (SP4b spec §2.6), and by `terminate()` for every worker it silences (rulings R15): the world page passes
   * `(t) => store.markDead(t)`.
   */
  readonly onWorkerDead?: (thread: number) => void;
}

export interface WorkerPool {
  readonly size: number;
  readonly epoch: number;
  /** Whether superseded jobs stop early (the pool has epoch cells). */
  readonly abortable: boolean;
  /**
   * Starts a new epoch on every worker; resolves with the (identical) ready message. The new generation is stored into
   * all four epoch cells before the configure is posted, and every queued job rejects with JobCancelled. The first
   * configure's generation is 0; each later one is `max(epoch + 1, max(cells) + 1)` (SP4c spec §4.9, ENG-4), so after a
   * `bumpScope` the new value differs from every value a job was issued with (without cells, `epoch + 1`). SP4c's Apply is
   * one configure.
   */
  configure(seedText: string, params: unknown): Promise<ReadyMsg>;
  /**
   * Adds 1 to the epoch cells from `from` onward (terrain, decorate, light, mesh; SP4b spec §2.7) and rejects the queued
   * jobs of those phases with JobCancelled; their in-flight jobs stop (ABORTED). Without cells it only rejects the queued
   * jobs. Nothing calls it in SP4c (Apply is one `configure`, SP4c spec §4.9); it is kept, unit-tested, for SP8b's
   * decorate-scope Apply, which orders `configure` before `bumpScope('decorate')`.
   */
  bumpScope(from: ScopePhase): void;
  /**
   * The scope a job of `phase` issued now would carry: its epoch cell's value (the generation without cells; SP4b spec
   * §2.7). D's read-through captures it with `epoch` before its wait (SIM-4). Throws RangeError for another phase.
   */
  scopeOf(phase: ScopePhase): number;
  /**
   * The aux policy (SP4c spec §6.2, D11), two scalars the page sets every frame: a free worker takes, in order, an aux job
   * of priority < 0 (points, probes, landing, the standalone spawn; uncapped and not counted); then, with `first`
   * 'world', the world FIFO's next job, else an aux job while fewer than `cap` non-interactive aux jobs run; with 'aux',
   * an aux job while under `cap`, else the world FIFO's next job. The default is `('world', size)`. A changed policy pumps
   * at once; unchanged values do nothing (and allocate nothing). Throws RangeError for another `first` or a `cap` that is
   * not an integer ≥ 1.
   */
  setAuxPolicy(first: AuxFirst, cap: number): void;
  /**
   * Hands every live worker the page's shared store (SP4a spec §2.3), before the world jobs; worker w attaches as reclaim
   * thread w + 1 (SP4b spec §2.5). Resolves when each live worker has answered `attached`. Jobs wait behind it as behind a
   * configure. Rejects with the first job-less error a worker sends meanwhile (`${code}: ${message}`), with WorkerFailed
   * when a worker fails or the pool is terminated, and when another attach is pending. A retry after a failed attach
   * succeeds (SP4b spec §2.8): a worker already attached to the same store and thread answers `attached` again, and a
   * worker's late answer to the failed attach does not count for the retry.
   */
  attachStore(h: StoreHandles): Promise<void>;
  /**
   * The world jobs of column (cx, cz) on the attached store (SP4a spec §2.3), each one job at priority 0: T, D and L resolve
   * `ColumnDone`, MESH_COLUMN `MeshColumnDone` (the column payload over the transferred buffers), each with its
   * `generation`, the pool's epoch at issue. An OK reply resolves whatever the pool's generation or its cells are now
   * (SP4c spec §4.6, D7: the worker committed it). They reject with JobCancelled (a configure while queued, ABORTED,
   * STALE_EPOCH, `cancelWorld`, or another error reply after the generation or the job's cell moved), StoreFullError
   * (STORE_FULL), StoreCorruptError (STORE_CORRUPT), WorkerFailed, or the worker's other error (NOT_ATTACHED,
   * NOT_CONFIGURED, INTERNAL: a prerequisite missing, BAD_MESSAGE). `terrain` with `protoOnly` is `T(protoOnly)` (SP4b
   * spec §3.7): it regenerates the freed proto of a Decorated or Published column.
   */
  terrain(cx: number, cz: number, protoOnly?: boolean): Promise<ColumnDone>;
  /** D; with `diff` (SP5a spec §2.5), the column's edit entries, which the message carries (cloned, never transferred). */
  decorate(cx: number, cz: number, diff?: ColumnDiff): Promise<ColumnDone>;
  light(cx: number, cz: number): Promise<ColumnDone>;
  /**
   * MESH; with `edit` true (SP5a spec §2.6, D22), an edit's remesh: queued on the aux lane at EDIT_MESH_PRIORITY instead of
   * the world FIFO, so a free worker takes it before every other job, uncapped by `auxCap`. Its reply settles as any
   * world job's.
   */
  meshColumn(cx: number, cz: number, o?: { readonly edit: boolean }): Promise<MeshColumnDone>;
  /** Lower priority runs first. */
  tile(req: TileRequest, priority: number): Promise<TileResult>;
  point(x: number, z: number, priority?: number): Promise<ColumnPoint>;
  /** The spawn search at `priority` (default −2: before points; the world's post-settle search runs at 600, SP4c spec §4.7). */
  spawn(priority?: number): Promise<Spawn>;
  /**
   * The teleport's landing at block (x, z) (SP4c spec §3.2, D12): one aux job at priority −2 (interactive: first,
   * uncapped), resolving with `landingSurface` and the column's `surfaceWaterLevel` (−∞ off the water). x and z are
   * integers (the caller asks at the clicked block); rejects with the worker's BAD_ARGS for a position outside the world
   * window, BAD_MESSAGE for non-integers, and JobCancelled when a configure supersedes it.
   */
  landing(x: number, z: number): Promise<{ readonly surface: number; readonly water: number }>;
  /**
   * The raw sums of a stats kind over points [0, n) of its fixed stream (spec §5.4): `size` slices (one for a
   * 'single' kind of STATS_KINDS: crossSection), sent as ordinary jobs at `priority` (default 500: after
   * preview tiles, before fine tiles), whose Float64 sums of length args.len are added element-wise in slice
   * order. The first slice that fails rejects the request with its error (JobCancelled when a configure
   * superseded it) and drops its queued slices; nothing is retried. Rejects with RangeError when n is not a
   * non-negative integer or args.len not a positive one.
   */
  stats<K extends StatsKind>(kind: K, n: number, args: StatsArgs<K>, priority?: number): Promise<Float64Array<ArrayBuffer>>;
  /**
   * The slice under `segment` (SP3a spec §5.1), split as `stats` splits (SP3b spec §6): `size` jobs, one per
   * contiguous range [from, to) of the 512 samples, at `priority` (default 500, the stats priority). Each part holds
   * its range only, at `(319 − y)·(to − from) + (i − from)`, and is merged row by row into `(319 − y)·512 + i`; the
   * result is byte-identical to a single job over the whole line. The first part that fails rejects the request with
   * its error and drops its queued parts: a configure (or a reply of a superseded epoch, or ABORTED) rejects it with
   * JobCancelled, and a line with an end outside the half-open world window or of zero length with the worker's
   * BAD_ARGS.
   */
  slice(segment: Segment, priority?: number): Promise<SliceResult>;
  /**
   * The final state and the surface-rule branch path of voxel (x, y, z) (SP3c spec §6): one job at `priority` (default
   * −1, the point priority: before preview tiles). Rejects with the worker's BAD_ARGS for non-integers, a position
   * outside the half-open world window or a y outside −64 … 319, and with JobCancelled when a configure supersedes it.
   */
  surfaceProbe(x: number, y: number, z: number, priority?: number): Promise<SurfaceProbeResult>;
  /**
   * A field slice (SP3d spec §5.1, §5.2): split by `planFieldSlice(n, columnCost, size, budget)` (budget null for blocks and
   * rule, which are never refused) into contiguous ranges of sample columns, sent as one group at `priority`, merged by
   * index. A refused request rejects with SliceTooHeavy before any job; a bad request with the worker's BAD_ARGS (the
   * worker recomputes the column cost and refuses a part above its bound); a configure, or `cancel()`, with JobCancelled.
   * `cancel()` drops the queued parts; parts already running finish and their results are discarded. A part whose reply
   * names another n, field or range than its request rejects the request.
   */
  fieldSlice(req: FieldSliceSpec, opts: FieldSliceOptions): FieldSliceHandle;
  /**
   * The value of a field at voxel (x, y, z) (SP3d spec §5.3): one job at `priority` (default −1, the point priority). Any
   * number (NaN and ±∞ included); rejects with the worker's BAD_ARGS (position, path, the bound) or JobCancelled.
   */
  fieldProbe(req: FieldProbeSpec, priority?: number): Promise<number>;
  /** Recomputes one golden in a worker (no configure needed). */
  selftest(key: string): Promise<{ actual: string | null; error: string | null }>;
  /** Rejects queued tile jobs matching `pred` with JobCancelled (they are in the aux lane, rebuilt in O(n)). */
  cancelTiles(pred: (req: TileRequest) => boolean): void;
  /**
   * Rejects the queued world jobs matching `pred` with JobCancelled (SP4b spec §2.8, D8): `terrain` is stage T, `decorate`
   * D, `light` L, `meshColumn` MESH (the world lane in issue order, then the edit MESHes of the aux lane, SP5a spec §2.6).
   * In-flight jobs run to the end.
   */
  cancelWorld(pred: (stage: Stage, cx: number, cz: number) => boolean): void;
  /** The workers that have not failed (SP4b spec §2.8; the coordinator's caps follow it); 0 once terminated. */
  liveWorkers(): number;
  /** The jobs queued in both lanes. */
  readonly queued: number;
  /** The in-flight jobs and the queue, read at once (the latency hook's pool probe, SP2b spec §2.8). */
  probe(): PoolProbe;
  terminate(): void;
}

interface Job {
  readonly id: number;
  readonly epoch: number;
  /** The epoch cell the job reads (`cellOf`), null for selftest (no scope). */
  readonly cell: 0 | 1 | 2 | 3 | null;
  /** The cell's value at issue (the generation without cells), null for selftest. */
  readonly scope: number | null;
  readonly priority: number;
  readonly msg: ToWorker;
  readonly tile: TileRequest | null;
  /** The stats or slice request the job is a part of (0: none). */
  readonly group: number;
  readonly resolve: (v: FromWorker) => void;
  readonly reject: (e: Error) => void;
}

/** Each world job type's stage (`engine/rings.ts`'s names; SP4b spec §2.8's `cancelWorld`). */
const STAGE_OF: Readonly<Partial<Record<string, Stage>>> = Object.freeze({ terrain: 'T', decorate: 'D', light: 'L', meshColumn: 'MESH' });

/** The aux-lane priority of an edit MESH (SP5a spec §2.6, D22): below every other job's, so a free worker takes it first. */
export const EDIT_MESH_PRIORITY = -1000;

/** Pool size: clamp(hardwareConcurrency − 2, 2, 6). */
export const poolSize = (cores: number): number => Math.max(2, Math.min(6, cores - 2));

/** The text of an error event: its message when it has one (a failed module load has none). */
const eventText = (event: unknown): string => {
  const m = typeof event === 'object' && event !== null ? (event as { message?: unknown }).message : undefined;
  return typeof m === 'string' && m !== '' ? m : 'error event without a message';
};

/** The pool's epoch cells, checked: length 4 over a whole 16-byte SharedArrayBuffer (its buffer is posted to the workers). */
function checkedCells(cells: Int32Array | null | undefined): Int32Array | null {
  if (cells === undefined || cells === null) return null;
  const b = cells.buffer;
  if (!(typeof SharedArrayBuffer === 'function' && b instanceof SharedArrayBuffer) || cells.length !== EPOCH_CELL_COUNT || b.byteLength !== 4 * EPOCH_CELL_COUNT) {
    throw new TypeError(`createWorkerPool: epochCells must be ${EPOCH_CELL_COUNT} Int32 over a ${4 * EPOCH_CELL_COUNT}-byte SharedArrayBuffer, got ${cells.length} over a ${b.byteLength}-byte ${b.constructor.name}`);
  }
  return cells;
}

export function createWorkerPool(size: number, spawn: () => WorkerLike, opts: PoolOptions = {}): WorkerPool {
  // Checked before any worker is spawned.
  const cells = checkedCells(opts.epochCells);
  const workers = Array.from({ length: size }, spawn);
  const busy: Array<Job | null> = workers.map(() => null);
  const alive: boolean[] = workers.map(() => true);
  let live = size;
  /** The world lane (SP4c spec §6.1): T, D, L and MESH jobs in issue order (the coordinator caps how many wait). */
  let worldLane: Job[] = [];
  /** The aux lane: every other job, by (priority, id). */
  const auxLane = createJobHeap<Job>();
  /** The aux policy (SP4c spec §6.2); the default keeps the world first and the aux lane uncapped. */
  let auxFirst: AuxFirst = 'world';
  let auxCap = size;
  let epoch = -1;
  let nextId = 1;
  let nextGroup = 1;
  let pendingReady: { need: number; got: ReadyMsg[]; resolve: (r: ReadyMsg) => void; reject: (e: Error) => void } | null = null;
  /** The attach barrier (ruling P28), separate from the configure's: the workers whose answer it still waits for. */
  let pendingAttach: { waiting: boolean[]; left: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  /**
   * The attach messages each worker has not answered yet (SP4b spec §2.8). A worker answers its messages in order, so an
   * answer that leaves this above 0 is a late answer to an earlier, failed attach and does not count for the pending one.
   */
  const attachOwed: number[] = workers.map(() => 0);
  /** Whether worker w's attach answer (`attached`, or a job-less error without an epoch) is the pending attach's. */
  const attachAnswer = (w: number): boolean => {
    if (attachOwed[w]! > 0) attachOwed[w]!--;
    return attachOwed[w] === 0 && pendingAttach !== null && pendingAttach.waiting[w] === true;
  };
  /** Whether a job's epoch cell moved since its issue (SP4b spec §2.7). */
  const moved = (job: Job): boolean => cells !== null && job.cell !== null && Atomics.load(cells, job.cell) !== job.scope;

  /** Whether a job is a world job (the world lane's, or an edit MESH on the aux lane, SP5a spec §2.6). */
  const isWorld = (job: Job): boolean => STAGE_OF[job.msg.type] !== undefined;
  /** The non-interactive aux jobs running (priority ≥ 0; what the cap counts). */
  const auxRunning = (): number => {
    let n = 0;
    for (let w = 0; w < size; w++) {
      const j = busy[w];
      if (j !== undefined && j !== null && j.priority >= 0 && !isWorld(j)) n++;
    }
    return n;
  };
  /** The next job a free worker takes under the aux policy (SP4c spec §6.2), removed from its lane; null for none. */
  const nextJob = (): Job | null => {
    const top = auxLane.peek();
    if (top !== undefined && top.priority < 0) return auxLane.pop()!;
    const auxOk = top !== undefined && auxRunning() < auxCap;
    if (auxFirst === 'aux' && auxOk) return auxLane.pop()!;
    if (worldLane.length > 0) return worldLane.shift()!;
    if (auxOk) return auxLane.pop()!;
    return null;
  };
  const pump = () => {
    if (pendingReady !== null || pendingAttach !== null) return;
    for (let w = 0; w < size; w++) {
      if (!alive[w] || busy[w] !== null) continue;
      // The choice does not depend on the worker: when nothing fits this one, nothing fits the others.
      const job = nextJob();
      if (job === null) return;
      busy[w] = job;
      workers[w]!.postMessage(job.msg);
    }
  };
  /** Empties both lanes; returns their jobs (the world lane's first). */
  const takeAll = (): Job[] => {
    const all = worldLane.concat(auxLane.clear());
    worldLane = [];
    return all;
  };

  /** Stops listening to worker w and terminates it. */
  const silence = (w: number) => {
    const worker = workers[w]!;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };

  /**
   * Removes worker w: tells `onWorkerDead` its thread (w + 1), then rejects its in-flight job and a pending configure or
   * attach, and every queued job once no worker is left.
   */
  const fail = (w: number, what: string) => {
    if (!alive[w]) return;
    alive[w] = false;
    live--;
    silence(w);
    opts.onWorkerDead?.(w + 1);
    const e = new WorkerFailed(`worker ${w + 1} of ${size} failed: ${what}`);
    const job = busy[w];
    busy[w] = null;
    job?.reject(e);
    if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(e); }
    if (pendingAttach !== null) { const pa = pendingAttach; pendingAttach = null; pa.reject(e); }
    if (live === 0) for (const j of takeAll()) j.reject(e);
    opts.onFailure?.(e);
    pump();
  };

  workers.forEach((worker, w) => {
    worker.onerror = (event) => fail(w, eventText(event));
    worker.onmessageerror = () => fail(w, 'a reply could not be read');
    worker.onmessage = (event) => {
      if (!alive[w]) return;
      const msg = parseFromWorker(event.data);
      if (msg === null) return;
      if ('bad' in msg) {
        // SP3d spec §5.1: a reply failing its guard settles its job (BAD_MESSAGE) and frees the worker.
        const job = busy[w];
        busy[w] = null;
        if (job !== null && msg.jobId === job.id) job.reject(new Error(`BAD_MESSAGE: ${msg.reason}`));
        pump();
        return;
      }
      if (msg.type === 'ready') {
        const pr = pendingReady;
        if (pr === null || msg.epoch !== epoch) return;
        pr.got.push(msg);
        if (pr.got.length < pr.need) return;
        pendingReady = null;
        const a = JSON.stringify(pr.got[0]!.stageHashes);
        if (pr.got.some((r) => JSON.stringify(r.stageHashes) !== a || r.genKey !== pr.got[0]!.genKey)) pr.reject(new Error('workers disagree on the stage hashes'));
        else pr.resolve(pr.got[0]!);
        pump();
        return;
      }
      if (msg.type === 'attached') {
        // An attached reply with no attach pending, or answering an earlier attach, is ignored (ruling P28; SP4b spec §2.8).
        if (!attachAnswer(w)) return;
        const pa = pendingAttach!;
        pa.waiting[w] = false;
        if (--pa.left > 0) return;
        pendingAttach = null;
        pa.resolve();
        pump();
        return;
      }
      if (msg.type === 'error' && msg.jobId === null) {
        // A late error of a superseded configure must not reject the current one (SP2a minor 4).
        if (pendingReady !== null && msg.epoch === epoch) { const pr = pendingReady; pendingReady = null; pr.reject(new Error(`${msg.code}: ${msg.message}`)); }
        // An attach's error has no epoch (ruling P28): the attach failed, and the jobs it holds back are released.
        else if (msg.epoch === null && attachAnswer(w)) { const pa = pendingAttach!; pendingAttach = null; pa.reject(new Error(`${msg.code}: ${msg.message}`)); pump(); }
        return;
      }
      const job = busy[w];
      busy[w] = null;
      if (job !== null && msg.jobId === job.id) {
        // SP4c §4.6 (D7): a world job's OK reply resolves whatever the generation or its cell is now (the worker committed
        // it; the coordinator judges it by its generation); its ABORTED or STALE_EPOCH reply committed nothing.
        const world = isWorld(job);
        if (world && msg.type !== 'error') job.resolve(msg);
        else if (msg.type === 'error' && (msg.code === 'ABORTED' || (world && msg.code === 'STALE_EPOCH'))) job.reject(new JobCancelled());
        else if (job.epoch !== epoch || moved(job)) job.reject(new JobCancelled());
        else if (msg.type === 'error' && msg.code === 'STORE_FULL') job.reject(new StoreFullError(`${msg.code}: ${msg.message}`));
        else if (msg.type === 'error' && msg.code === 'STORE_CORRUPT') job.reject(new StoreCorruptError(`${msg.code}: ${msg.message}`));
        else if (msg.type === 'error') job.reject(new Error(`${msg.code}: ${msg.message}`));
        else job.resolve(msg);
      }
      pump();
    };
  });

  /** Removes the queued parts of a stats or slice request whose first part failed (their promises are ignored). */
  const dropGroup = (group: number) => {
    // Groups (stats, slices, field slices) are aux jobs.
    for (const j of auxLane.removeWhere((j) => j.group === group)) j.reject(new JobCancelled());
  };

  /**
   * Queues a job of `type`: `build` gets its id and its scope, the value of its epoch cell now (the generation without
   * cells; SP4b spec §2.7). A selftest has no cell and no scope (its build ignores the scope). A world job goes to the
   * world lane unless `toAux` (an edit MESH, SP5a spec §2.6).
   */
  const enqueue = (
    priority: number, type: JobType, build: (id: number, scope: number) => ToWorker, tile: TileRequest | null, group = 0, toAux = false,
  ): Promise<FromWorker> =>
    new Promise((resolve, reject) => {
      if (live === 0) { reject(new WorkerFailed('every worker failed')); return; }
      const id = nextId++;
      const cell = type === 'selftest' ? null : cellOf(type);
      const scope = cell === null ? null : cells === null ? epoch : Atomics.load(cells, cell);
      // A failed slice rejects first (the request fails with its error), then drops its queued siblings
      // before the pool pumps the next job.
      const fail = group === 0 ? reject : (e: Error) => { reject(e); dropGroup(group); };
      const job: Job = { id, epoch, cell, scope, priority, msg: build(id, scope ?? epoch), tile, group, resolve, reject: fail };
      if (isWorld(job) && !toAux) worldLane.push(job);
      else auxLane.push(job, priority, id);
      pump();
    });

  /** A T, D or L job of (cx, cz) at priority 0; its reply must name the same job and column. */
  const columnJob = async (type: 'terrain' | 'decorate' | 'light', cx: number, cz: number, protoOnly = false, diff?: ColumnDiff): Promise<ColumnDone> => {
    const generation = epoch;
    const r = await worldJob(type, cx, cz, protoOnly, diff);
    if (r.type !== 'columnDone') throw new Error(`unexpected reply ${r.type}`);
    if (r.job !== type || r.cx !== cx || r.cz !== cz) throw new Error(`world job reply: ${r.job} of column (${r.cx}, ${r.cz}), expected ${type} (${cx}, ${cz})`);
    return { cx, cz, ms: r.ms, versions: r.versions === null ? null : new Int32Array(r.versions), generation };
  };
  /**
   * A world job of (cx, cz) at priority 0, issued under the pool's epoch now (its generation); `protoOnly` (terrain only)
   * goes into the message only when true, `diff` (decorate only, SP5a) only when given. Jobs are posted without a
   * transfer list, so the diff is cloned. `edit` (meshColumn only, SP5a spec §2.6) queues it on the aux lane at
   * EDIT_MESH_PRIORITY.
   */
  const worldJob = (type: WorldJobType, cx: number, cz: number, protoOnly = false, diff?: ColumnDiff, edit = false): Promise<FromWorker> => {
    const e = epoch;
    return enqueue(edit ? EDIT_MESH_PRIORITY : 0, type, (jobId, scope) => (protoOnly ? { type, jobId, epoch: e, scope, cx, cz, protoOnly }
      : diff !== undefined ? { type, jobId, epoch: e, scope, cx, cz, diff } : { type, jobId, epoch: e, scope, cx, cz }), null, 0, edit);
  };

  return {
    size,
    abortable: cells !== null,
    get epoch() { return epoch; },
    get queued() { return worldLane.length + auxLane.size; },
    configure(seedText, params) {
      // ENG-4 (SP4c spec §4.9): from the second configure on, past every cell, so the new value differs from every scope a
      // job was issued with (a `bumpScope` may have moved a cell to epoch + 1). The first stays 0: the cells' initial 0 was
      // issued to no job.
      let next = epoch + 1;
      if (cells !== null && epoch >= 0) for (let c = 0; c < EPOCH_CELL_COUNT; c++) next = Math.max(next, Atomics.load(cells, c) + 1);
      epoch = next;
      // Stored before posting, into all four cells: every in-flight job of an older epoch stops (a tile within a row).
      if (cells !== null) for (let c = 0; c < EPOCH_CELL_COUNT; c++) Atomics.store(cells, c, epoch);
      for (const j of takeAll()) j.reject(new JobCancelled());
      if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(new JobCancelled()); }
      if (live === 0) return Promise.reject(new WorkerFailed('every worker failed'));
      return new Promise((resolve, reject) => {
        pendingReady = { need: live, got: [], resolve, reject };
        const msg: ToWorker = { type: 'configure', epoch, seedText, params, epochs: cells === null ? null : (cells.buffer as SharedArrayBuffer) };
        workers.forEach((w, i) => { if (alive[i]) w.postMessage(msg); });
      });
    },
    bumpScope(from) {
      if (!Object.hasOwn(EPOCH_CELL, from)) throw new RangeError(`bumpScope: no phase ${String(from)}`);
      const first = EPOCH_CELL[from];
      if (cells !== null) for (let c = first; c < EPOCH_CELL_COUNT; c++) Atomics.add(cells, c, 1);
      const later = (j: Job) => j.cell !== null && j.cell >= first;
      const dropped = worldLane.filter(later);
      if (dropped.length > 0) worldLane = worldLane.filter((j) => !later(j));
      for (const j of dropped.concat(auxLane.removeWhere(later))) j.reject(new JobCancelled());
    },
    scopeOf(phase) {
      if (!Object.hasOwn(EPOCH_CELL, phase)) throw new RangeError(`scopeOf: no phase ${String(phase)}`);
      return cells === null ? epoch : Atomics.load(cells, EPOCH_CELL[phase]);
    },
    setAuxPolicy(first, cap) {
      if (first === auxFirst && cap === auxCap) return;
      if (first !== 'world' && first !== 'aux') throw new RangeError(`setAuxPolicy: first must be 'world' or 'aux', got ${String(first)}`);
      if (!(Number.isSafeInteger(cap) && cap >= 1)) throw new RangeError(`setAuxPolicy: cap ${cap} is not an integer ≥ 1`);
      auxFirst = first;
      auxCap = cap;
      pump();
    },
    attachStore(h) {
      if (pendingAttach !== null) return Promise.reject(new Error('attachStore: an attach is pending'));
      if (live === 0) return Promise.reject(new WorkerFailed('every worker failed'));
      return new Promise<void>((resolve, reject) => {
        pendingAttach = { waiting: alive.slice(), left: live, resolve, reject };
        workers.forEach((w, i) => {
          if (!alive[i]) return;
          attachOwed[i]!++;
          w.postMessage({ type: 'attach', handles: h, thread: i + 1 });
        });
      });
    },
    terrain: (cx, cz, protoOnly = false) => columnJob('terrain', cx, cz, protoOnly),
    decorate: (cx, cz, diff) => columnJob('decorate', cx, cz, false, diff),
    light: (cx, cz) => columnJob('light', cx, cz),
    async meshColumn(cx, cz, o) {
      const generation = epoch;
      const r = await worldJob('meshColumn', cx, cz, false, undefined, o?.edit === true);
      if (r.type !== 'meshColumnResult') throw new Error(`unexpected reply ${r.type}`);
      if (r.cx !== cx || r.cz !== cz) throw new Error(`world job reply: meshColumn of column (${r.cx}, ${r.cz}), expected meshColumn (${cx}, ${cz})`);
      return { payload: payloadOfMeshResult(r), generation };
    },
    async tile(req, priority) {
      const e = epoch;
      const r = await enqueue(priority, 'mapTile', (jobId, scope) => ({ type: 'mapTile', jobId, epoch: e, scope, ...req }), req);
      if (r.type !== 'tile') throw new Error(`unexpected reply ${r.type}`);
      return { rgba: r.rgba, ids: r.ids ?? null };
    },
    async point(x, z, priority = -1) {
      const e = epoch;
      const r = await enqueue(priority, 'point', (jobId, scope) => ({ type: 'point', jobId, epoch: e, scope, x, z }), null);
      if (r.type !== 'pointResult') throw new Error(`unexpected reply ${r.type}`);
      return r.fields;
    },
    async spawn(priority = -2) {
      const e = epoch;
      const r = await enqueue(priority, 'spawn', (jobId, scope) => ({ type: 'spawn', jobId, epoch: e, scope }), null);
      if (r.type !== 'spawnResult') throw new Error(`unexpected reply ${r.type}`);
      return r.spawn;
    },
    async landing(x, z) {
      const e = epoch;
      const r = await enqueue(-2, 'landing', (jobId, scope) => ({ type: 'landing', jobId, epoch: e, scope, x, z }), null);
      if (r.type !== 'landingResult') throw new Error(`unexpected reply ${r.type}`);
      return { surface: r.surface, water: r.water };
    },
    async stats(kind, n, args, priority = 500) {
      if (!(Number.isSafeInteger(n) && n >= 0)) throw new RangeError(`stats: n = ${n} is not a non-negative integer`);
      const len = args.len;
      if (!(Number.isSafeInteger(len) && len >= 1)) throw new RangeError(`stats: args.len = ${len} is not a positive integer`);
      const e = epoch;
      const group = nextGroup++;
      const slices: Array<Promise<FromWorker>> = [];
      const parts = STATS_KINDS[kind] === 'split' ? size : 1;
      for (let i = 0; i < parts; i++) {
        const from = Math.floor((i * n) / parts);
        const to = Math.floor(((i + 1) * n) / parts);
        if (from === to) continue;
        slices.push(enqueue(priority, 'stats', (jobId, scope) => ({ type: 'stats', jobId, epoch: e, scope, kind, from, to, args }) as StatsMsg, null, group));
      }
      const sum = new Float64Array(len);
      for (const r of await Promise.all(slices)) {
        if (r.type !== 'statsResult') throw new Error(`unexpected reply ${r.type}`);
        if (r.data.byteLength !== 8 * len) throw new Error(`stats slice: ${r.data.byteLength} bytes, expected ${8 * len}`);
        const part = new Float64Array(r.data);
        for (let k = 0; k < len; k++) sum[k]! += part[k]!;
      }
      return sum;
    },
    async slice(segment, priority = 500) {
      const e = epoch;
      const { ax, az, bx, bz } = segment;
      const group = nextGroup++;
      const ranges: Array<readonly [number, number]> = [];
      const parts: Array<Promise<FromWorker>> = [];
      for (let k = 0; k < size; k++) {
        const from = Math.floor((k * SLICE_POINTS) / size);
        const to = Math.floor(((k + 1) * SLICE_POINTS) / size);
        if (from === to) continue;
        ranges.push([from, to]);
        parts.push(enqueue(priority, 'slice', (jobId, scope) => ({ type: 'slice', jobId, epoch: e, scope, ax, az, bx, bz, from, to }), null, group));
      }
      const replies = await Promise.all(parts);
      const blocks = new Uint16Array(SLICE_SAMPLES);
      const fluid = new Uint8Array(SLICE_SAMPLES);
      replies.forEach((r, k) => {
        if (r.type !== 'sliceResult') throw new Error(`unexpected reply ${r.type}`);
        const [from, to] = ranges[k]!;
        if (r.from !== from || r.to !== to) throw new Error(`slice part: samples [${r.from}, ${r.to}), expected [${from}, ${to})`);
        const w = to - from;
        const b = new Uint16Array(r.blocks);
        const f = new Uint8Array(r.fluid);
        // Part row (319 − y) goes to the same row of the full slice, at column `from`.
        for (let row = 0; row < SLICE_ROWS; row++) {
          blocks.set(b.subarray(row * w, row * w + w), row * SLICE_POINTS + from);
          fluid.set(f.subarray(row * w, row * w + w), row * SLICE_POINTS + from);
        }
      });
      return { blocks, fluid };
    },
    async surfaceProbe(x, y, z, priority = -1) {
      const e = epoch;
      const r = await enqueue(priority, 'surfaceProbe', (jobId, scope) => ({ type: 'surfaceProbe', jobId, epoch: e, scope, x, y, z }), null);
      if (r.type !== 'surfaceProbeResult') throw new Error(`unexpected reply ${r.type}`);
      return { state: r.state, path: r.path };
    },
    fieldSlice(req, opts) {
      const e = epoch;
      const group = nextGroup++;
      const { n, field } = req;
      let cancel = (): void => undefined;
      const promise = new Promise<FieldSliceResult>((resolve, reject) => {
        const plan = planFieldSlice(n, opts.columnCost, size, isRefusableField(field) ? opts.budget : null);
        if (plan.refused) { reject(new SliceTooHeavy(opts.columnCost, plan.limit)); return; }
        let done = false;
        const fail = (err: Error) => {
          if (done) return;
          done = true;
          dropGroup(group);
          reject(err);
        };
        cancel = () => fail(new JobCancelled());
        const out: FieldSliceResult = field === 'density' || field === 'node'
          ? { n, field, values: new Float64Array(n * n), fluid: null }
          : field === 'blocks' ? { n, field, values: new Uint16Array(n * n), fluid: new Uint8Array(n * n) } : { n, field, values: new Uint8Array(n * n), fluid: null };
        const base = req.plane === 'vertical'
          ? { plane: req.plane, ax: req.ax, az: req.az, bx: req.bx, bz: req.bz }
          : { plane: req.plane, cx: req.cx, cz: req.cz, extent: req.extent };
        let left = plan.ranges.length;
        for (const [from, to] of plan.ranges) {
          const build = (jobId: number, scope: number) => ({ type: 'fieldSlice', jobId, epoch: e, scope, ...base, y: req.y, n, field, path: req.path, from, to }) as FieldSliceMsg;
          enqueue(opts.priority, 'fieldSlice', build, null, group).then((r) => {
            if (done) return;
            if (r.type !== 'fieldSliceResult') throw new Error(`unexpected reply ${r.type}`);
            if (r.n !== n || r.field !== field || r.from !== from || r.to !== to) {
              throw new Error(`fieldSlice part: n ${r.n}, field ${r.field}, samples [${r.from}, ${r.to}); expected n ${n}, field ${field}, samples [${from}, ${to})`);
            }
            // Sample column c's n samples sit at (c − from)·n + k in the part and at c·n + k in the whole.
            if (out.field === 'blocks') {
              out.values.set(new Uint16Array(r.values), from * n);
              out.fluid.set(new Uint8Array(r.fluid!), from * n);
            } else if (out.field === 'rule') out.values.set(new Uint8Array(r.values), from * n);
            else out.values.set(new Float64Array(r.values), from * n);
            if (--left === 0) { done = true; resolve(out); }
          }).catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
        }
      });
      return { promise, cancel: () => cancel() };
    },
    async fieldProbe(req, priority = -1) {
      const e = epoch;
      const { field, path, x, y, z } = req;
      const r = await enqueue(priority, 'fieldProbe', (jobId, scope) => ({ type: 'fieldProbe', jobId, epoch: e, scope, field, path, x, y, z }), null);
      if (r.type !== 'fieldProbeResult') throw new Error(`unexpected reply ${r.type}`);
      return r.value;
    },
    async selftest(key) {
      const r = await enqueue(0, 'selftest', (jobId) => ({ type: 'selftest', jobId, key }), null);
      if (r.type !== 'selftestResult') throw new Error(`unexpected reply ${r.type}`);
      return { actual: r.actual, error: r.error };
    },
    cancelTiles(pred) {
      for (const j of auxLane.removeWhere((j) => j.tile !== null && pred(j.tile))) j.reject(new JobCancelled());
    },
    cancelWorld(pred) {
      const matches = (j: Job): boolean => {
        const m = j.msg as { readonly cx: number; readonly cz: number };
        return pred(STAGE_OF[j.msg.type]!, m.cx, m.cz);
      };
      const dropped: Job[] = [];
      worldLane = worldLane.filter((j) => {
        if (!matches(j)) return true;
        dropped.push(j);
        return false;
      });
      // The aux lane's world-type jobs are the edit MESHes (SP5a spec §2.6).
      for (const j of dropped.concat(auxLane.removeWhere((j) => isWorld(j) && matches(j)))) j.reject(new JobCancelled());
    },
    liveWorkers: () => live,
    probe() {
      const jobs: InFlightJob[] = [];
      busy.forEach((j, worker) => {
        if (j !== null && j.msg.type !== 'configure' && j.msg.type !== 'attach') jobs.push({ worker, type: j.msg.type, epoch: j.epoch, level: j.tile === null ? null : j.tile.level });
      });
      return { busy: jobs.length, queued: worldLane.length + auxLane.size, configuring: pendingReady !== null, jobs };
    },
    terminate() {
      // SP4b spec §2.8: the barriers and the busy jobs settle (WorkerFailed('terminated')), then the queue as before.
      // Each silenced worker is marked dead first, as `fail` does (§2.6; rulings R15, ENG-2): a lock a terminated worker
      // held then throws StoreCorrupt in a settle's free instead of spinning the main thread for ever.
      const e = new WorkerFailed('terminated');
      workers.forEach((_, w) => {
        if (alive[w]) { alive[w] = false; silence(w); opts.onWorkerDead?.(w + 1); }
      });
      live = 0;
      if (pendingAttach !== null) { const pa = pendingAttach; pendingAttach = null; pa.reject(e); }
      if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(e); }
      busy.forEach((job, w) => { busy[w] = null; job?.reject(e); });
      for (const j of takeAll()) j.reject(new JobCancelled());
    },
  };
}

/**
 * Browser pool of module workers running task.worker.ts (size defaults to clamp(cores − 2, 2, 6)). `epochCells` defaults
 * to a pool-owned 16-byte buffer under cross-origin isolation (where a SharedArrayBuffer posted to a worker is shared),
 * null otherwise; the world page passes its store's `epochs.cells` (SP4b spec §2.7). `onWorkerDead` is passed to the pool
 * (the world page marks the failed thread dead in its store, SP4b spec §2.6).
 */
export function createBrowserPool(
  size = poolSize(navigator.hardwareConcurrency || 4),
  opts: { readonly onFailure?: (e: WorkerFailed) => void; readonly onWorkerDead?: (thread: number) => void; readonly epochCells?: Int32Array | null } = {},
): WorkerPool {
  const isolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  const epochCells = opts.epochCells !== undefined ? opts.epochCells : isolated ? new Int32Array(new SharedArrayBuffer(4 * EPOCH_CELL_COUNT)) : null;
  return createWorkerPool(size, () =>
    new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  { epochCells, onFailure: opts.onFailure, onWorkerDead: opts.onWorkerDead });
}

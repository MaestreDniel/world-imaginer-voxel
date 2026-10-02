/**
 * Task pool (master §4.1, SP2a spec §5.2): N workers, one configure per epoch (all must agree on the
 * stage hashes), a priority queue of jobs with at most one in flight per worker, cancellation, and
 * stale-epoch results dropped. The worker factory is injectable so the logic is testable without a browser.
 * SP2b §2.2-2.3: an optional abort cell (one pool-wide Int32 in a SharedArrayBuffer) holds the pool's epoch,
 * so a worker stops a superseded tile or spawn job within a row; job-less errors of other epochs are
 * ignored; a worker that raises an error event is removed and its pending work rejected with WorkerFailed.
 */
import type { MapLevel } from '../core/constants';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import type { LayerId } from '../gen/map/layers';
import { parseFromWorker, type FromWorker, type ReadyMsg, type ToWorker } from '../workers/protocol';

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

export class JobCancelled extends Error {
  constructor() { super('job cancelled'); }
}

/** A worker raised an error or messageerror event: its in-flight job and a pending configure reject with this. */
export class WorkerFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerFailed';
  }
}

export interface PoolOptions {
  /** The epoch cell (SP2b spec §2.2); null or absent: jobs are not abortable. */
  readonly abortCell?: Int32Array<SharedArrayBuffer> | null;
  /** Called once per failed worker, after its work was rejected. */
  readonly onFailure?: (e: WorkerFailed) => void;
}

export interface WorkerPool {
  readonly size: number;
  readonly epoch: number;
  /** Whether superseded tile and spawn jobs stop early (the pool has an abort cell). */
  readonly abortable: boolean;
  /** Starts a new epoch on every worker; resolves with the (identical) ready message. */
  configure(seedText: string, params: unknown): Promise<ReadyMsg>;
  /** Lower priority runs first. */
  tile(req: TileRequest, priority: number): Promise<TileResult>;
  point(x: number, z: number, priority?: number): Promise<ColumnPoint>;
  spawn(): Promise<Spawn>;
  /** Recomputes one golden in a worker (no configure needed). */
  selftest(key: string): Promise<{ actual: string | null; error: string | null }>;
  /** Rejects queued tile jobs matching `pred` with JobCancelled. */
  cancelTiles(pred: (req: TileRequest) => boolean): void;
  readonly queued: number;
  terminate(): void;
}

interface Job {
  readonly id: number;
  readonly epoch: number;
  readonly priority: number;
  readonly msg: ToWorker;
  readonly tile: TileRequest | null;
  readonly resolve: (v: FromWorker) => void;
  readonly reject: (e: Error) => void;
}

/** Pool size: clamp(hardwareConcurrency − 2, 2, 6). */
export const poolSize = (cores: number): number => Math.max(2, Math.min(6, cores - 2));

/** The text of an error event: its message when it has one (a failed module load has none). */
const eventText = (event: unknown): string => {
  const m = typeof event === 'object' && event !== null ? (event as { message?: unknown }).message : undefined;
  return typeof m === 'string' && m !== '' ? m : 'error event without a message';
};

export function createWorkerPool(size: number, spawn: () => WorkerLike, opts: PoolOptions = {}): WorkerPool {
  const workers = Array.from({ length: size }, spawn);
  const busy: Array<Job | null> = workers.map(() => null);
  const alive: boolean[] = workers.map(() => true);
  const cell = opts.abortCell ?? null;
  let live = size;
  let queue: Job[] = [];
  let epoch = -1;
  let nextId = 1;
  let pendingReady: { need: number; got: ReadyMsg[]; resolve: (r: ReadyMsg) => void; reject: (e: Error) => void } | null = null;
  if (cell !== null) Atomics.store(cell, 0, epoch);

  const pump = () => {
    if (pendingReady !== null) return;
    for (let w = 0; w < size && queue.length > 0; w++) {
      if (!alive[w] || busy[w] !== null) continue;
      queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      const job = queue.shift()!;
      busy[w] = job;
      workers[w]!.postMessage(job.msg);
    }
  };

  /** Removes worker w: rejects its in-flight job and a pending configure, and every queued job once no worker is left. */
  const fail = (w: number, what: string) => {
    if (!alive[w]) return;
    alive[w] = false;
    live--;
    const worker = workers[w]!;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    const e = new WorkerFailed(`worker ${w + 1} of ${size} failed: ${what}`);
    const job = busy[w];
    busy[w] = null;
    job?.reject(e);
    if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(e); }
    if (live === 0) { for (const j of queue) j.reject(e); queue = []; }
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
      if (msg.type === 'error' && msg.jobId === null) {
        // A late error of a superseded configure must not reject the current one (SP2a minor 4).
        if (pendingReady !== null && msg.epoch === epoch) { const pr = pendingReady; pendingReady = null; pr.reject(new Error(`${msg.code}: ${msg.message}`)); }
        return;
      }
      const job = busy[w];
      busy[w] = null;
      if (job !== null && msg.jobId === job.id) {
        if (job.epoch !== epoch || (msg.type === 'error' && msg.code === 'ABORTED')) job.reject(new JobCancelled());
        else if (msg.type === 'error') job.reject(new Error(`${msg.code}: ${msg.message}`));
        else job.resolve(msg);
      }
      pump();
    };
  });

  const enqueue = (priority: number, build: (id: number) => ToWorker, tile: TileRequest | null): Promise<FromWorker> =>
    new Promise((resolve, reject) => {
      if (live === 0) { reject(new WorkerFailed('every worker failed')); return; }
      const id = nextId++;
      queue.push({ id, epoch, priority, msg: build(id), tile, resolve, reject });
      pump();
    });

  return {
    size,
    abortable: cell !== null,
    get epoch() { return epoch; },
    get queued() { return queue.length; },
    configure(seedText, params) {
      epoch++;
      // Stored before posting: every in-flight tile or spawn of an older epoch stops within a row.
      if (cell !== null) Atomics.store(cell, 0, epoch);
      for (const j of queue) j.reject(new JobCancelled());
      queue = [];
      if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(new JobCancelled()); }
      if (live === 0) return Promise.reject(new WorkerFailed('every worker failed'));
      return new Promise((resolve, reject) => {
        pendingReady = { need: live, got: [], resolve, reject };
        const msg: ToWorker = { type: 'configure', epoch, seedText, params, abort: cell === null ? null : cell.buffer };
        workers.forEach((w, i) => { if (alive[i]) w.postMessage(msg); });
      });
    },
    async tile(req, priority) {
      const e = epoch;
      const r = await enqueue(priority, (jobId) => ({ type: 'mapTile', jobId, epoch: e, ...req }), req);
      if (r.type !== 'tile') throw new Error(`unexpected reply ${r.type}`);
      return { rgba: r.rgba, ids: r.ids ?? null };
    },
    async point(x, z, priority = -1) {
      const e = epoch;
      const r = await enqueue(priority, (jobId) => ({ type: 'point', jobId, epoch: e, x, z }), null);
      if (r.type !== 'pointResult') throw new Error(`unexpected reply ${r.type}`);
      return r.fields;
    },
    async spawn() {
      const e = epoch;
      const r = await enqueue(-2, (jobId) => ({ type: 'spawn', jobId, epoch: e }), null);
      if (r.type !== 'spawnResult') throw new Error(`unexpected reply ${r.type}`);
      return r.spawn;
    },
    async selftest(key) {
      const r = await enqueue(0, (jobId) => ({ type: 'selftest', jobId, key }), null);
      if (r.type !== 'selftestResult') throw new Error(`unexpected reply ${r.type}`);
      return { actual: r.actual, error: r.error };
    },
    cancelTiles(pred) {
      queue = queue.filter((j) => {
        if (j.tile !== null && pred(j.tile)) { j.reject(new JobCancelled()); return false; }
        return true;
      });
    },
    terminate() {
      for (const w of workers) w.terminate();
      for (const j of queue) j.reject(new JobCancelled());
      queue = [];
    },
  };
}

/**
 * Browser pool of module workers running task.worker.ts (size defaults to clamp(cores − 2, 2, 6)). The abort
 * cell exists only under cross-origin isolation, where a SharedArrayBuffer posted to a worker is shared.
 */
export function createBrowserPool(size = poolSize(navigator.hardwareConcurrency || 4), opts: { readonly onFailure?: (e: WorkerFailed) => void } = {}): WorkerPool {
  const isolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  return createWorkerPool(size, () =>
    new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  { abortCell: isolated ? new Int32Array(new SharedArrayBuffer(4)) : null, onFailure: opts.onFailure });
}

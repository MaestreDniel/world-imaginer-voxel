/**
 * Task pool (master §4.1, SP2a spec §5.2): N workers, one configure per epoch (all must agree on the
 * stage hashes), a priority queue of jobs with at most one in flight per worker, cancellation, and
 * stale-epoch results dropped. The worker factory is injectable so the logic is testable without a browser.
 */
import type { MapLevel } from '../core/constants';
import type { ColumnPoint } from '../gen/column/columnPoint';
import type { Spawn } from '../gen/column/spawn';
import type { LayerId } from '../gen/map/layers';
import { parseFromWorker, type FromWorker, type ReadyMsg, type ToWorker } from '../workers/protocol';

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  terminate(): void;
}

export interface TileRequest { readonly layer: LayerId; readonly level: MapLevel; readonly tx: number; readonly tz: number }

export class JobCancelled extends Error {
  constructor() { super('job cancelled'); }
}

export interface WorkerPool {
  readonly size: number;
  readonly epoch: number;
  /** Starts a new epoch on every worker; resolves with the (identical) ready message. */
  configure(seedText: string, params: unknown): Promise<ReadyMsg>;
  /** Lower priority runs first. */
  tile(req: TileRequest, priority: number): Promise<ArrayBuffer>;
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

export function createWorkerPool(size: number, spawn: () => WorkerLike): WorkerPool {
  const workers = Array.from({ length: size }, spawn);
  const busy: Array<Job | null> = workers.map(() => null);
  let queue: Job[] = [];
  let epoch = -1;
  let nextId = 1;
  let pendingReady: { need: number; got: ReadyMsg[]; resolve: (r: ReadyMsg) => void; reject: (e: Error) => void } | null = null;

  const pump = () => {
    if (pendingReady !== null) return;
    for (let w = 0; w < size && queue.length > 0; w++) {
      if (busy[w] !== null) continue;
      queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      const job = queue.shift()!;
      busy[w] = job;
      workers[w]!.postMessage(job.msg);
    }
  };

  workers.forEach((worker, w) => {
    worker.onmessage = (event) => {
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
        if (pendingReady !== null) { const pr = pendingReady; pendingReady = null; pr.reject(new Error(`${msg.code}: ${msg.message}`)); }
        return;
      }
      const job = busy[w];
      busy[w] = null;
      if (job !== null && msg.jobId === job.id) {
        if (job.epoch !== epoch) job.reject(new JobCancelled());
        else if (msg.type === 'error') job.reject(new Error(`${msg.code}: ${msg.message}`));
        else job.resolve(msg);
      }
      pump();
    };
  });

  const enqueue = (priority: number, build: (id: number) => ToWorker, tile: TileRequest | null): Promise<FromWorker> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      queue.push({ id, epoch, priority, msg: build(id), tile, resolve, reject });
      pump();
    });

  return {
    size,
    get epoch() { return epoch; },
    get queued() { return queue.length; },
    configure(seedText, params) {
      epoch++;
      for (const j of queue) j.reject(new JobCancelled());
      queue = [];
      if (pendingReady !== null) pendingReady.reject(new JobCancelled());
      return new Promise((resolve, reject) => {
        pendingReady = { need: size, got: [], resolve, reject };
        for (const w of workers) w.postMessage({ type: 'configure', epoch, seedText, params });
      });
    },
    async tile(req, priority) {
      const e = epoch;
      const r = await enqueue(priority, (jobId) => ({ type: 'mapTile', jobId, epoch: e, ...req }), req);
      if (r.type !== 'tile') throw new Error(`unexpected reply ${r.type}`);
      return r.rgba;
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

/** Browser pool of module workers running task.worker.ts (size defaults to clamp(cores − 2, 2, 6)). */
export function createBrowserPool(size = poolSize(navigator.hardwareConcurrency || 4)): WorkerPool {
  return createWorkerPool(size, () =>
    new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
}

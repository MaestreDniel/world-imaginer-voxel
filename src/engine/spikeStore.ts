/**
 * The spike's shared store (SP4a spec §1.1, §1.2 item 6, ruling P18): the page creates a store with `shared: true`
 * and the default maxima (768 MiB blocks, 512 MiB bytes), posts its handles to six module workers that each claim,
 * fill and commit 32 columns (forcing pool growth), then has each worker read another worker's columns and reads every
 * column itself. Every failure, a reply that never comes included, is a string in `errors`; it never hangs.
 */
import { createStore, type VoxelStore } from '../world/store/store';
import { parseSpikeStoreFromWorker, spikeColumnProblem, type SpikeStoreFromWorker, type SpikeStoreToWorker } from '../workers/protocol';

export interface StoreSpikeResult {
  /** The accepted reservations (the pools' maximum sizes), 0 when `createStore` refused them. */
  readonly reservedBlockMiB: number;
  readonly reservedByteMiB: number;
  /** The page's pool sizes after the workers' writes. */
  readonly grewTo: { readonly blockMiB: number; readonly byteMiB: number };
  /** Columns whose fill read back exactly, out of the columns read: the workers' cross reads plus the page's reads. */
  readonly crossReadsOk: number;
  readonly crossReadsTotal: number;
  readonly errors: string[];
}

/** The surface of a browser `Worker` the spike uses (a Node `worker_threads` wrapper in the integration test). */
export interface SpikeWorkerLike {
  postMessage(msg: SpikeStoreToWorker, transfer?: Transferable[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror?: ((e: unknown) => void) | null;
  terminate(): void;
}

const MIB = 1 << 20;
/** How long one worker may take to answer one request before it counts as an error. */
const REPLY_TIMEOUT_MS = 60_000;

const text = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The browser's module worker. Its MessageEvent carries `data`, all `SpikeWorkerLike.onmessage` reads. */
const spawnModuleWorker = (): SpikeWorkerLike =>
  new Worker(new URL('../workers/spikeStore.worker.ts', import.meta.url), { type: 'module' }) as unknown as SpikeWorkerLike;

/** Posts `msg` to `w` and waits for its reply of type `expect`: the reply, or an error string (timeout, onerror, bad reply). */
function request<T extends SpikeStoreFromWorker['type']>(
  w: SpikeWorkerLike, i: number, msg: SpikeStoreToWorker, expect: T,
): Promise<Extract<SpikeStoreFromWorker, { type: T }> | string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Extract<SpikeStoreFromWorker, { type: T }> | string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.onmessage = null;
      w.onerror = null;
      resolve(r);
    };
    const timer = setTimeout(() => finish(`worker ${i}: no ${expect} reply within ${REPLY_TIMEOUT_MS / 1000} s`), REPLY_TIMEOUT_MS);
    w.onmessage = (e) => {
      const m = parseSpikeStoreFromWorker(e.data);
      finish(m !== null && m.type === expect ? (m as Extract<SpikeStoreFromWorker, { type: T }>) : `worker ${i}: unexpected reply ${JSON.stringify(e.data)}`);
    };
    w.onerror = (e) => finish(`worker ${i}: ${e instanceof Event ? `error event ${(e as ErrorEvent).message ?? ''}` : text(e)}`);
    try {
      w.postMessage(msg);
    } catch (e) {
      finish(`worker ${i}: postMessage: ${text(e)}`);
    }
  });
}

export async function runStoreSpike(o: {
  readonly workers?: number;
  readonly columnsPerWorker?: number;
  readonly spawn?: () => SpikeWorkerLike;
} = {}): Promise<StoreSpikeResult> {
  const count = o.workers ?? 6;
  const columns = o.columnsPerWorker ?? 32;
  const spawn = o.spawn ?? spawnModuleWorker;
  const errors: string[] = [];
  let store: VoxelStore;
  try {
    store = createStore({ shared: true });
  } catch (e) {
    return { reservedBlockMiB: 0, reservedByteMiB: 0, grewTo: { blockMiB: 0, byteMiB: 0 }, crossReadsOk: 0, crossReadsTotal: 0, errors: [`createStore: ${text(e)}`] };
  }
  const reservedBlockMiB = store.blockPool.maxSlots * store.blockPool.slotBytes / MIB;
  const reservedByteMiB = store.bytePool.maxSlots * store.bytePool.slotBytes / MIB;
  const workers: SpikeWorkerLike[] = [];
  let ok = 0;
  let total = 0;
  try {
    for (let i = 0; i < count; i++) {
      try {
        workers.push(spawn());
      } catch (e) {
        errors.push(`worker ${i}: spawn: ${text(e)}`);
      }
    }
    if (workers.length === count) {
      // Every worker writes its columns; awaiting all the replies is the barrier before any cross read.
      const handles = store.handles();
      const written = await Promise.all(workers.map((w, i) =>
        request(w, i, { type: 'spikeWrite', handles, index: i, columnsPerWorker: columns }, 'spikeWritten')));
      for (const r of written) {
        if (typeof r === 'string') errors.push(r);
        else errors.push(...r.errors);
      }
      const checked = await Promise.all(workers.map((w, i) =>
        request(w, i, { type: 'spikeCrossRead', cx: (i + 1) % count, columnsPerWorker: columns }, 'spikeCrossChecked')));
      checked.forEach((r) => {
        if (typeof r === 'string') {
          errors.push(r);
          total += columns;
        } else {
          ok += r.ok;
          total += r.total;
          errors.push(...r.errors);
        }
      });
    }
  } finally {
    for (const w of workers) w.terminate();
  }
  // The page reads every column through its own length-tracking views.
  for (let cx = 0; cx < count; cx++) {
    for (let cz = 0; cz < columns; cz++) {
      total++;
      try {
        const problem = spikeColumnProblem(store.proto(cx, cz), cx, cz);
        if (problem === null) ok++;
        else errors.push(`page: ${problem}`);
      } catch (e) {
        errors.push(`page: column (${cx}, ${cz}): ${text(e)}`);
      }
    }
  }
  return {
    reservedBlockMiB,
    reservedByteMiB,
    grewTo: { blockMiB: store.blockPool.buffer.byteLength / MIB, byteMiB: store.bytePool.buffer.byteLength / MIB },
    crossReadsOk: ok,
    crossReadsTotal: total,
    errors,
  };
}

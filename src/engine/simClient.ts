/**
 * The main thread's side of the sim worker (SP5a spec §2.1, §2.5, D17). Only `engine/` spawns workers, so this module
 * spawns `sim.worker.ts` (`createBrowserSim`) and the page calls it. It attaches the store as thread 15, posts `edits`
 * batches and `diff` requests with ids and matches each reply to its request (the sim answers in order), and keeps the
 * set of columns holding entries (`hasEntries`, the read-through's test, §2.5) from each `edited` reply's changes,
 * `entryAdded` and `entryRemoved` (SP5b D20). A saved world's `load` (SP5b spec §3.3, §3.4 step 3) resolves once its
 * `loaded` reply's `entryCols` became the whole entry set, so the read-through sees every saved edit from the first D.
 * `flush` (SP5b spec §3.2) posts the state and history and resolves with the sim's `flushed`, committed or not (a KV
 * failure is a result, not the sim's); a history that keeps steps of the last one posted goes as its change against it
 * (`historyChange`, D28's third lever), which the sim resolves to the same record. `record` posts the world's changed
 * record, which has no reply. `backup` (SP5b spec §3.6) posts the copy request with the whole history (it moves no
 * change base) and resolves with `backedUp`, ok or not; `hasAnyEntries` tells the backup rule whether the world has any
 * placed or removed block.
 *
 * **The sim's failure** (§2.1): an `error` event, an `error` reply of any code, or a reply the guard refuses
 * (`parseFromSim`, or one that does not answer a pending request of its kind, its batch's length or its column). In
 * this order: `failed` turns true, the entry set empties, the worker is terminated (so no batch already queued in its
 * port writes after its pins are released; the sim's handler also refuses every batch after an `error` reply),
 * `onFailure` runs once and synchronously (the page marks thread 15 dead, releases every sim pin and shows the
 * notice), then every pending `edits`, `load`, `flush` and `backup` rejects with `SimFailed` and every pending `diff`
 * resolves null, so a rejected post finds its pins already released. Later `edits`, `load`s, `flush`es and `backup`s
 * reject and later `diff`s resolve null at once, and a later `record` is dropped, with nothing posted (autosave counts a
 * rejected flush as not saved; the sim's own failure notice shows). `dispose` terminates the worker and settles its
 * requests the same way, without `onFailure`. The page opens a world whose `load` failed without editing (SP5b spec §3.3).
 */
import { colKey } from '../core/coords';
import type { HistoryRecord, StateRecord, WorldRecord } from '../persist/saves';
import {
  historyChange, parseFromSim, type BackedUpMsg, type BackupMsg, type DiffMsg, type Edit, type EditedMsg, type FlushedMsg, type LoadedMsg, type LoadMsg, type ToSim,
} from '../workers/protocol';
import type { ColumnDiff } from '../world/store/api';
import { SIM_THREAD } from '../world/store/reclaim';
import type { StoreHandles } from '../world/store/store';

/** The surface of a browser `Worker` the client uses (a Node `worker_threads` wrapper or a fake in tests), as `WorkerLike`. */
export interface SimWorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

/** The sim failed (or the client was disposed): a pending or later `edits` rejects with this. */
export class SimFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimFailed';
  }
}

export interface SimClient {
  /** Attaches the page's shared store as thread 15; resolves on `attached`. */
  attach(h: StoreHandles): Promise<void>;
  /**
   * Loads a saved world's diffs into the sim (SP5b spec §3.3); resolves with `loaded` once the entry set is its
   * `entryCols`, rejects `SimFailed` on the sim's failure (a KV failure included).
   */
  load(m: Omit<LoadMsg, 'type' | 'id'>): Promise<LoadedMsg>;
  /** Posts a batch; resolves with the sim's `edited` reply (a refusal included), rejects `SimFailed` on the sim's failure. */
  edits(e: readonly Edit[]): Promise<EditedMsg>;
  /** Column (cx, cz)'s entries, or null when it holds none or the sim failed (§2.5). */
  diff(cx: number, cz: number): Promise<ColumnDiff | null>;
  /**
   * Saves the open world (SP5b spec §3.2): resolves with `flushed`, ok or not; rejects `SimFailed` on the sim's failure
   * or the client's dispose, and at once on a closed client.
   */
  flush(state: StateRecord, history: HistoryRecord | null): Promise<FlushedMsg>;
  /** Sends the world's changed record for the next flush (no reply); nothing on a closed client. */
  record(world: WorldRecord): void;
  /**
   * Writes the pending flush and the backup copy (SP5b spec §3.6): resolves with `backedUp`, ok or not; rejects
   * `SimFailed` as `flush` does.
   */
  backup(m: Omit<BackupMsg, 'type' | 'id'>): Promise<BackedUpMsg>;
  /** Whether the column holds entries, as the `loaded` set and the `edited` replies' changes tell (false once the sim failed). */
  hasEntries(cx: number, cz: number): boolean;
  /** Whether any column holds entries: the entry set is not empty (false once the sim failed). */
  hasAnyEntries(): boolean;
  readonly failed: boolean;
  dispose(): void;
}

type Pending =
  | { readonly kind: 'load'; resolve(m: LoadedMsg): void; reject(e: Error): void }
  | { readonly kind: 'edits'; readonly n: number; resolve(m: EditedMsg): void; reject(e: Error): void }
  | { readonly kind: 'flush'; resolve(m: FlushedMsg): void; reject(e: Error): void }
  | { readonly kind: 'backup'; resolve(m: BackedUpMsg): void; reject(e: Error): void }
  | { readonly kind: 'diff'; readonly cx: number; readonly cz: number; resolve(d: ColumnDiff | null): void };
/** The request kind each id-carrying reply answers. */
const REQUEST_OF: Readonly<Record<'loaded' | 'edited' | 'diff' | 'flushed' | 'backedUp', Pending['kind']>> = {
  loaded: 'load', edited: 'edits', diff: 'diff', flushed: 'flush', backedUp: 'backup',
};
interface AttachWait { resolve(): void; reject(e: Error): void }

const text = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : String(e));

export function createSimClient(spawn: () => SimWorkerLike, o: { onFailure(e: Error): void }): SimClient {
  const worker = spawn();
  const pending = new Map<number, Pending>();
  /** The attaches not answered yet, oldest first (`attached` carries no id). */
  const attaches: AttachWait[] = [];
  const entries = new Set<number>();
  let nextId = 1;
  /** The history the last `flush` that carried one posted: the next one posts its change against it (D28's third lever). */
  let historyBase: HistoryRecord | null = null;
  let failed = false;
  /** Failed or disposed: requests settle at once and replies are ignored. */
  let closed = false;

  /** Settles every request still waiting: an attach, a load, a batch, a flush or a backup rejects with `e`, a diff resolves null. */
  const settleAll = (e: SimFailed): void => {
    const waits = [...pending.values()];
    pending.clear();
    const atts = attaches.splice(0);
    for (const a of atts) a.reject(e);
    for (const p of waits) {
      if (p.kind === 'diff') p.resolve(null);
      else p.reject(e);
    }
  };

  const fail = (why: string): void => {
    if (closed) return;
    closed = true;
    failed = true;
    entries.clear();
    const e = new SimFailed(`the sim failed: ${why}`);
    try {
      worker.terminate();
      o.onFailure(e);
    } finally {
      settleAll(e);
    }
  };

  const onReply = (data: unknown): void => {
    if (closed) return;
    const m = parseFromSim(data);
    if (m === null) return fail('a reply its guard refuses');
    if (m.type === 'error') return fail(`${m.code}: ${m.message}`);
    if (m.type === 'attached') {
      const a = attaches.shift();
      if (a === undefined) return fail('an `attached` with no attach pending');
      a.resolve();
      return;
    }
    const p = pending.get(m.id);
    if (p === undefined || p.kind !== REQUEST_OF[m.type]) return fail(`an \`${m.type}\` reply to no pending request ${m.id} of its kind`);
    if (p.kind === 'load') {
      const r = m as LoadedMsg;
      pending.delete(m.id);
      // The DiffStore's columns after the load: the whole set (D20).
      entries.clear();
      for (const k of r.entryCols) entries.add(k);
      p.resolve(r);
      return;
    }
    if (p.kind === 'flush') {
      pending.delete(m.id);
      p.resolve(m as FlushedMsg);
      return;
    }
    if (p.kind === 'backup') {
      pending.delete(m.id);
      p.resolve(m as BackedUpMsg);
      return;
    }
    if (p.kind === 'edits') {
      const r = m as EditedMsg;
      if (r.prev.length !== p.n) return fail(`an \`edited\` reply of ${r.prev.length} edits to a batch of ${p.n}`);
      pending.delete(m.id);
      for (const k of r.entryAdded) entries.add(k);
      for (const k of r.entryRemoved) entries.delete(k);
      p.resolve(r);
      return;
    }
    const d = m as DiffMsg;
    if (d.cx !== p.cx || d.cz !== p.cz) return fail(`a \`diff\` reply for (${d.cx}, ${d.cz}) to a request for (${p.cx}, ${p.cz})`);
    pending.delete(m.id);
    p.resolve(d.sy.length === 0 ? null : { sy: d.sy, idx: d.idx, value: d.value });
  };

  worker.onmessage = (e) => onReply(e.data);
  worker.onerror = (e) => fail(`an error event (${text(e)})`);

  const post = (m: ToSim): void => worker.postMessage(m);

  return {
    attach(h) {
      if (closed) return Promise.reject(new SimFailed('the sim failed or was disposed'));
      return new Promise<void>((resolve, reject) => {
        post({ type: 'attach', handles: h, thread: SIM_THREAD });
        attaches.push({ resolve, reject });
      });
    },
    load(m) {
      if (closed) return Promise.reject(new SimFailed('the sim failed or was disposed'));
      const id = nextId++;
      return new Promise<LoadedMsg>((resolve, reject) => {
        post({ type: 'load', id, ...m });
        pending.set(id, { kind: 'load', resolve, reject });
      });
    },
    edits(e) {
      if (closed) return Promise.reject(new SimFailed('the sim failed or was disposed'));
      const id = nextId++;
      return new Promise<EditedMsg>((resolve, reject) => {
        post({ type: 'edits', id, edits: e });
        pending.set(id, { kind: 'edits', n: e.length, resolve, reject });
      });
    },
    diff(cx, cz) {
      if (closed) return Promise.resolve(null);
      const id = nextId++;
      return new Promise<ColumnDiff | null>((resolve) => {
        post({ type: 'diff', id, cx, cz });
        pending.set(id, { kind: 'diff', cx, cz, resolve });
      });
    },
    flush(state, history) {
      if (closed) return Promise.reject(new SimFailed('the sim failed or was disposed'));
      const id = nextId++;
      const posted = history === null ? null : historyChange(historyBase, history);
      if (history !== null) historyBase = history;
      return new Promise<FlushedMsg>((resolve, reject) => {
        post({ type: 'flush', id, state, history: posted });
        pending.set(id, { kind: 'flush', resolve, reject });
      });
    },
    record(world) {
      if (!closed) post({ type: 'record', world });
    },
    backup(m) {
      if (closed) return Promise.reject(new SimFailed('the sim failed or was disposed'));
      const id = nextId++;
      return new Promise<BackedUpMsg>((resolve, reject) => {
        post({ type: 'backup', id, ...m });
        pending.set(id, { kind: 'backup', resolve, reject });
      });
    },
    hasEntries: (cx, cz) => entries.has(colKey(cx, cz)),
    hasAnyEntries: () => entries.size > 0,
    get failed() {
      return failed;
    },
    dispose() {
      if (closed) {
        worker.terminate();
        return;
      }
      closed = true;
      entries.clear();
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      settleAll(new SimFailed('the sim was disposed'));
    },
  };
}

/** The browser's sim: a module worker running `sim.worker.ts`, whose MessageEvent carries `data`. */
export function createBrowserSim(o: { onFailure(e: Error): void }): SimClient {
  return createSimClient(() => new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' }) as unknown as SimWorkerLike, o);
}

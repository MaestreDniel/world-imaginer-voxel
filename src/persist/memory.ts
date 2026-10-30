/**
 * MemoryKV: the KV in memory, for tests (SP5b spec §6, D27; master §1's "MemoryKV for tests"), with IndexedDB's
 * transaction behaviour and fault injection. Values are `structuredClone`d on put (when `write` is called, as
 * IndexedDB's `put` clones) and on read; a batch is staged and applied only at its end, so an abort applies nothing.
 * Transactions run in the order they were issued: a read waits for the writes issued before it, a write for every
 * transaction issued before it; each settles after its delay (none: on a microtask).
 * - `failAt(k, errorName = 'AbortError')`: the next batch aborts at its op k (0-based) or at `'commit'`, applying
 *   nothing; the fault is spent on that batch, which completes when it has no op k.
 * - `crashNext()`: the next write never settles and is never applied (the tab died before `oncomplete`); later
 *   transactions do not wait for it.
 * - `closeNow()`: the browser closed the connection (site data cleared): a write in flight settles `abort`
 *   (`AbortError`), later writes `closed`, reads reject (`InvalidStateError`); the `closed` event fires once.
 * - A `DataCloneError` from `structuredClone` aborts the batch with that name, as IndexedDB's adapter does (Task 6).
 * - `opCount`: the ops of every committed batch.
 */
import { compareKeys, KvError, STORES, type Key, type KeyRange, type KV, type KvEvent, type ReadRequest, type StoreName, type WriteOp, type WriteResult } from './kv';

export interface MemoryKV extends KV {
  failAt(k: number | 'commit', errorName?: string): void;
  crashNext(): void;
  closeNow(): void;
  /** The store's entries in key order, cloned. */
  dump(store: StoreName): Array<[Key, unknown]>;
  readonly opCount: number;
}

/** A store's entries by their key's JSON (unique for a string or a `[string, number]` key). */
type Store = Map<string, { key: Key; value: unknown }>;

type Staged =
  | { op: 'put'; store: StoreName; key: Key; value: unknown }
  | { op: 'delete'; store: StoreName; key: Key }
  | { op: 'deleteRange'; store: StoreName; range: KeyRange };

const COMPLETE: WriteResult = { status: 'complete', errorName: null };

const inRange = (k: Key, r: KeyRange | null): boolean => r === null || (compareKeys(k, r.lower) >= 0 && compareKeys(k, r.upper) < 0);
const copyKey = (k: Key): Key => (typeof k === 'string' ? k : [k[0], k[1]]);
const settleAfter = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export function createMemoryKV(o?: { readDelayMs?: number; writeDelayMs?: number }): MemoryKV {
  const readDelayMs = o?.readDelayMs ?? 0;
  const writeDelayMs = o?.writeDelayMs ?? 0;
  const stores = new Map<StoreName, Store>(STORES.map((s) => [s, new Map()]));
  const listeners = new Set<(e: KvEvent) => void>();
  let fault: { at: number | 'commit'; errorName: string } | null = null;
  let crash = false;
  let closed = false;
  let killed = false;
  let opCount = 0;
  /** Every issued transaction's end, and the issued writes' end (a crashed write ends at once for both). */
  let lastAny: Promise<void> = Promise.resolve();
  let lastWrite: Promise<void> = Promise.resolve();

  const sorted = (store: StoreName, range: KeyRange | null) =>
    [...stores.get(store)!.values()].filter((e) => inRange(e.key, range)).sort((a, b) => compareKeys(a.key, b.key));

  function answer(r: ReadRequest): unknown {
    if (r.op === 'get') {
      const e = stores.get(r.store)!.get(JSON.stringify(r.key));
      return e === undefined ? undefined : structuredClone(e.value);
    }
    const entries = sorted(r.store, r.range);
    if (r.op === 'count') return entries.length;
    return { keys: entries.map((e) => copyKey(e.key)), values: entries.map((e) => structuredClone(e.value)) };
  }

  function apply(batch: readonly Staged[]): void {
    for (const s of batch) {
      const store = stores.get(s.store)!;
      if (s.op === 'put') store.set(JSON.stringify(s.key), { key: copyKey(s.key), value: s.value });
      else if (s.op === 'delete') store.delete(JSON.stringify(s.key));
      else for (const [id, e] of store) if (inRange(e.key, s.range)) store.delete(id);
    }
    opCount += batch.length;
  }

  /** Stages the batch as `write` is called: the clones, and the fault or clone error that aborts it. */
  function stage(ops: readonly WriteOp[]): { batch: Staged[]; errorName: string | null } {
    const f = fault;
    fault = null;
    const batch: Staged[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (f !== null && f.at === i) return { batch: [], errorName: f.errorName };
      const op = ops[i]!;
      if (op.op === 'put') {
        try {
          batch.push({ op: 'put', store: op.store, key: copyKey(op.key), value: structuredClone(op.value) });
        } catch (e) {
          const name = (e as { name?: unknown } | null)?.name;
          return { batch: [], errorName: typeof name === 'string' ? name : 'DataCloneError' };
        }
      } else if (op.op === 'delete') batch.push({ op: 'delete', store: op.store, key: copyKey(op.key) });
      else batch.push({ op: 'deleteRange', store: op.store, range: { lower: copyKey(op.range.lower), upper: copyKey(op.range.upper) } });
    }
    if (f !== null && f.at === 'commit') return { batch: [], errorName: f.errorName };
    return { batch, errorName: null };
  }

  return {
    read(reqs) {
      if (closed) return Promise.reject(new KvError('InvalidStateError', 'MemoryKV: the connection is closed'));
      const run = lastWrite.then(async () => {
        if (closed) throw new KvError('InvalidStateError', 'MemoryKV: the connection is closed');
        const out = reqs.map(answer);
        await settleAfter(readDelayMs);
        return out;
      });
      lastAny = Promise.all([lastAny, run.then(() => undefined, () => undefined)]).then(() => undefined);
      return run;
    },
    write(ops) {
      if (closed) return Promise.resolve({ status: 'closed', errorName: null });
      const { batch, errorName } = stage(ops);
      if (crash) {
        crash = false;
        return new Promise<WriteResult>(() => {});
      }
      const run = lastAny.then(async (): Promise<WriteResult> => {
        await settleAfter(writeDelayMs);
        if (killed) return { status: 'abort', errorName: 'AbortError' };
        if (errorName !== null) return { status: 'abort', errorName };
        apply(batch);
        return COMPLETE;
      });
      const done = run.then(() => undefined);
      lastAny = done;
      lastWrite = done;
      return run;
    },
    onEvent(f) {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    close() {
      closed = true;
    },
    failAt(k, errorName = 'AbortError') {
      fault = { at: k, errorName };
    },
    crashNext() {
      crash = true;
    },
    closeNow() {
      if (killed) return;
      closed = true;
      killed = true;
      for (const f of [...listeners]) f('closed');
    },
    dump(store) {
      return sorted(store, null).map((e): [Key, unknown] => [copyKey(e.key), structuredClone(e.value)]);
    },
    get opCount() {
      return opCount;
    },
  };
}

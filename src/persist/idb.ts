/**
 * IdbKV: the KV over IndexedDB (SP5b spec §2.1, D16, D17; master §1's IStorage adapter), the only `indexedDB` user
 * (`test/arch/rules/banned.ts`). It runs in the sim worker and, for the worlds menu, on the main thread: one connection
 * per thread. Version 1's upgrade creates D16's five stores with out-of-line keys. `read` is one readonly transaction
 * (`get`, `getAll` + `getAllKeys` zipped, `count`); `write` is one readwrite transaction over the batch. Both span every
 * store, so transactions run in the order they were issued, as `MemoryKV`'s do. Durability is the browser's default.
 * - A synchronous throw while a batch is issued (`DataCloneError` from `put`'s clone, `DataError` from a bad key; neither
 *   aborts the transaction by itself) aborts it and settles `abort` with that exception's name; any other abort settles
 *   `abort` with the transaction's error's name (`QuotaExceededError`; `AbortError` when the browser closes the
 *   connection under it).
 * - The connection is closed by the browser (its `close` event: site data cleared; emits `closed`), by itself on
 *   `versionchange` (emits `versionchange`) or by `close()`; then every `write` settles `closed` and every `read`
 *   rejects (`InvalidStateError`). `write` never rejects.
 * - `blocked` during the open (another connection holds an older version) is reported through `onBlocked`, since no
 *   `onEvent` listener exists before the promise resolves.
 */
import { KvError, STORES, type Key, type KeyRange, type KV, type KvEvent, type ReadRequest, type WriteOp, type WriteResult } from './kv';

/** `wi10`'s version (D16); SP8c's `packs` and SP10's `presets` bump it. */
const VERSION = 1;

const COMPLETE: WriteResult = { status: 'complete', errorName: null };
const CLOSED: WriteResult = { status: 'closed', errorName: null };

/** A `[worldId, colKey]` key is an IndexedDB array key; the cast drops only `readonly`. */
const idbKey = (k: Key): IDBValidKey => k as unknown as IDBValidKey;
const idbRange = (r: KeyRange): IDBKeyRange => IDBKeyRange.bound(idbKey(r.lower), idbKey(r.upper), false, true);

function nameOf(e: unknown, fallback: string): string {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : fallback;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Issues one read request; its answer lands in `out[i]` on success. */
function issueRead(tx: IDBTransaction, r: ReadRequest, out: unknown[], i: number): void {
  const store = tx.objectStore(r.store);
  if (r.op === 'get') {
    const req = store.get(idbKey(r.key));
    req.onsuccess = () => { out[i] = req.result; };
    return;
  }
  const range = r.range === null ? undefined : idbRange(r.range);
  if (r.op === 'count') {
    const req = store.count(range);
    req.onsuccess = () => { out[i] = req.result; };
    return;
  }
  const keys = store.getAllKeys(range);
  const values = store.getAll(range);
  values.onsuccess = () => { out[i] = { keys: keys.result, values: values.result }; };
}

function issueWrite(tx: IDBTransaction, op: WriteOp): void {
  const store = tx.objectStore(op.store);
  if (op.op === 'put') store.put(op.value, idbKey(op.key));
  else if (op.op === 'delete') store.delete(idbKey(op.key));
  else store.delete(idbRange(op.range));
}

function wrap(db: IDBDatabase): KV {
  const listeners = new Set<(e: KvEvent) => void>();
  let closed = false;
  const emit = (e: KvEvent): void => {
    for (const f of [...listeners]) f(e);
  };
  db.onclose = () => {
    closed = true;
    emit('closed');
  };
  db.onversionchange = () => {
    closed = true;
    db.close();
    emit('versionchange');
  };
  const stores = [...STORES];

  return {
    read(reqs) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new KvError('InvalidStateError', 'IdbKV: the connection is closed'));
          return;
        }
        let tx: IDBTransaction;
        try {
          tx = db.transaction(stores, 'readonly');
        } catch (e) {
          reject(new KvError(nameOf(e, 'InvalidStateError'), `IdbKV: ${messageOf(e)}`));
          return;
        }
        const out: unknown[] = new Array<unknown>(reqs.length);
        let thrown: unknown = null;
        tx.oncomplete = () => resolve(out);
        tx.onabort = () => {
          const e = thrown ?? tx.error;
          reject(new KvError(nameOf(e, 'AbortError'), `IdbKV: the read aborted${e === null ? '' : `: ${messageOf(e)}`}`));
        };
        try {
          for (let i = 0; i < reqs.length; i++) issueRead(tx, reqs[i]!, out, i);
        } catch (e) {
          thrown = e;
          tx.abort();
        }
      });
    },
    write(ops) {
      return new Promise<WriteResult>((resolve) => {
        if (closed) {
          resolve(CLOSED);
          return;
        }
        let tx: IDBTransaction;
        try {
          tx = db.transaction(stores, 'readwrite');
        } catch (e) {
          // `InvalidStateError`: the connection closed before its `close` event reached this thread.
          resolve(nameOf(e, 'InvalidStateError') === 'InvalidStateError' ? CLOSED : { status: 'abort', errorName: nameOf(e, 'UnknownError') });
          return;
        }
        let thrown: string | null = null;
        tx.oncomplete = () => resolve(COMPLETE);
        tx.onabort = () => resolve({ status: 'abort', errorName: thrown ?? tx.error?.name ?? null });
        try {
          for (const op of ops) issueWrite(tx, op);
        } catch (e) {
          thrown = nameOf(e, 'UnknownError');
          tx.abort();
        }
      });
    },
    onEvent(f) {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    close() {
      closed = true;
      db.close();
    },
  };
}

/** Whether the global `indexedDB` is there, checked without opening anything (a getter that throws counts as absent). */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Opens `name` at version 1 (the global `indexedDB` unless `factory` is given); rejects with a `KvError` when it cannot. */
export function openIdbKV(name: string, factory?: IDBFactory, onBlocked?: () => void): Promise<KV> {
  return new Promise((resolve, reject) => {
    if (factory === undefined && typeof indexedDB === 'undefined') throw new KvError('NotSupportedError', 'IndexedDB is not available');
    const req = (factory ?? indexedDB).open(name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onblocked = () => onBlocked?.();
    req.onsuccess = () => resolve(wrap(req.result));
    req.onerror = () => reject(new KvError(req.error?.name ?? 'UnknownError', `IndexedDB ${name} could not be opened: ${req.error?.message ?? 'no error'}`));
  });
}

/** Deletes `name`; every connection to it is closed first, or the deletion waits on them (`blocked`). */
export function deleteIdb(name: string, factory?: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    if (factory === undefined && typeof indexedDB === 'undefined') throw new KvError('NotSupportedError', 'IndexedDB is not available');
    const req = (factory ?? indexedDB).deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new KvError(req.error?.name ?? 'UnknownError', `IndexedDB ${name} could not be deleted: ${req.error?.message ?? 'no error'}`));
  });
}

/**
 * The KV interface (SP5b spec §2.1, D16, D27; master §1's IStorage adapter): IndexedDB `wi10`'s five stores, their keys
 * and key ranges, and the two transactions `persist/` uses. `read` runs several `get`, `getAll` and `count` requests in
 * one readonly transaction; `write` applies one batch of puts and deletes in one readwrite transaction, so atomicity is
 * the adapter's and `saves.ts` never sees a request. There is no cursor. `IdbKV` (`idb.ts`) and `MemoryKV`
 * (`memory.ts`) implement it, and `kvContract.ts` is the suite both pass.
 */

/** `packs` and `presets` are SP8c's and SP10's, added by a version bump (D16). */
export type StoreName = 'worlds' | 'state' | 'history' | 'diffs' | 'meta';
/** D16's stores, in that order. */
export const STORES: readonly StoreName[] = ['worlds', 'state', 'history', 'diffs', 'meta'];

/** `worlds`, `state` and `history` by world id; `diffs` by `[worldId, colKey]`; `meta` by a string. */
export type Key = string | readonly [string, number];

/** Lower inclusive, upper exclusive. */
export interface KeyRange {
  readonly lower: Key;
  readonly upper: Key;
}

/** One world's `diffs` keys: a colKey is below 2^32 (`core/coords.ts`), so `[worldId, 0] … [worldId, 2^32)`. */
export function worldRange(worldId: string): KeyRange {
  return { lower: [worldId, 0], upper: [worldId, 2 ** 32] };
}

type KeyPart = number | string | readonly KeyPart[];

/** IndexedDB's type order: a number, then a string, then an array. */
const rank = (k: KeyPart): number => (typeof k === 'number' ? 0 : typeof k === 'string' ? 1 : 2);

function compareParts(a: KeyPart, b: KeyPart): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' || typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const bs = b as readonly KeyPart[];
  const n = Math.min(a.length, bs.length);
  for (let i = 0; i < n; i++) {
    const c = compareParts(a[i]!, bs[i]!);
    if (c !== 0) return c;
  }
  return a.length < bs.length ? -1 : a.length > bs.length ? 1 : 0;
}

/**
 * −1, 0 or 1 in IndexedDB's key order: a number < a string < an array; strings by UTF-16 code unit; arrays element by
 * element, a shorter prefix first.
 */
export function compareKeys(a: Key, b: Key): number {
  return compareParts(a, b);
}

/** A read request; its answer, in request order, is the value (`undefined` when absent), `{keys, values}` in key order, or the count. */
export type ReadRequest =
  | { op: 'get'; store: StoreName; key: Key }
  | { op: 'getAll'; store: StoreName; range: KeyRange | null }
  | { op: 'count'; store: StoreName; range: KeyRange | null };

export type WriteOp =
  | { op: 'put'; store: StoreName; key: Key; value: unknown }
  | { op: 'delete'; store: StoreName; key: Key }
  | { op: 'deleteRange'; store: StoreName; range: KeyRange };

/** `closed` is a connection the browser closed (site data cleared) or the owner closed; `errorName` carries `QuotaExceededError`. */
export interface WriteResult {
  readonly status: 'complete' | 'abort' | 'closed';
  readonly errorName: string | null;
}

export type KvEvent = 'versionchange' | 'blocked' | 'closed';

export interface KV {
  /** One readonly transaction; rejects with a `KvError` named as the transaction's error. */
  read(reqs: readonly ReadRequest[]): Promise<unknown[]>;
  /** One readwrite transaction over the whole batch; never rejects. */
  write(ops: readonly WriteOp[]): Promise<WriteResult>;
  /** Listens for the connection's events; returns the unsubscribe. */
  onEvent(f: (e: KvEvent) => void): () => void;
  /** Ends the connection: later writes settle `closed`. */
  close(): void;
}

/** A failed `read`: `name` is the transaction's error's (`InvalidStateError` on a closed connection, for example). */
export class KvError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

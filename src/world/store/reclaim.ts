/**
 * Deferred reclamation (SP4b spec §2.5, D4; master §2.3 Reclamation): a slot a thread releases is freed only once no
 * reader that could hold it is still inside a read section.
 *
 * The buffer (`StoreHandles.reclaim`, `RECLAIM_BYTES`, a `SharedArrayBuffer` when the store is shared), Int32:
 * - [0] the global epoch G, starting at 1; every release takes `tag = Atomics.add(G, 1)` (the old G), wrapping at 2³¹;
 * - [1] the dead-owner mask, bit t for a failed thread t (SP4b spec §2.6);
 * - [2] the store id, a non-zero Int32 stamped at creation (SP4b spec §2.8: the worker's idempotent attach compares it);
 * - [16 + t] thread t's reader epoch, 0 while it is outside a read section; [32 + t] the entries in thread t's limbo.
 * Threads: the main thread 0, the pool's workers 1 … N in attach order, SP5a's sim worker 15.
 *
 * A reader announces `e = load(G)` in R[t] and re-checks G until it is stable, so a reader that loaded G before a
 * release and published after the releaser's scan retries with a G that postdates the release; a G of 0 (which reads as
 * idle) is moved to 1 first, so a reader never announces 0. A release is freed at once when the store is unshared or
 * every R[t] reads 0 (the fast path, which keeps single-threaded stores and every free made outside a read section
 * immediate); otherwise (pool, slot, tag) goes on the calling thread's limbo, a thread-local ring grown only on
 * overflow. A drain frees every limbo entry tagged before the oldest live reader's epoch `m`: a reader that announced
 * `e` may hold a slot released with tag ≥ `e`, never one released before it announced. Epochs and tags wrap (SP5a spec
 * D24, STORE-3), so they are compared relative to G: `m` is the live R[t] with the largest `(G − e) | 0`, and an entry
 * is freed while `((tag − m) | 0) < 0`; with no live reader every entry is freed. Every access to the buffer is an
 * Atomics one (sequentially consistent).
 */
import { assertBufferKind, R_DEAD, type SlabPool } from './pool';

export const RECLAIM_BYTES = 192;
export const RECLAIM_THREADS = 16;
/** Int32 indices in the reclaim buffer. */
export const R_EPOCH = 0;
/** The dead-owner mask, declared by `pool.ts`, whose lock reads it (SP4b spec §2.6). */
export { R_DEAD };
export const R_STORE_ID = 2;
export const R_READER = 16;
export const R_LIMBO = 32;
export const MAIN_THREAD = 0;
export const SIM_THREAD = 15;
/** Entries of a limbo ring before its first growth (each entry 3 Int32: pool index, slot, tag). */
export const LIMBO_ENTRIES = 1024;

/** A slot release: frees `slot` of `pool` now or once no reader can hold it. */
export type Retire = (pool: SlabPool, slot: number) => void;

/** The immediate release (`section.ts`'s default, for callers without a store: its own unit tests). */
export const FREE_NOW: Retire = (p, s) => p.free(s);

export interface Reclaimer {
  readonly thread: number;
  readonly storeId: number;
  /** Enters a read section (SP4b spec §2.5); nested calls only count, the outermost publishes the epoch. */
  enterRead(): void;
  /** Leaves the read section (the outermost call stores 0, then drains). */
  exitRead(): void;
  retire: Retire;
  /** Frees the limbo entries no live reader can hold; returns the entries left. */
  drain(): number;
  /** The entries in thread `thread`'s limbo ([32 + thread]). */
  limboCount(thread: number): number;
  /** Marks thread `thread` failed: sets its bit in the mask, then clears its reader epoch (SP4b spec §2.6). */
  markDead(thread: number): void;
}

function checkThread(thread: number): void {
  if (!Number.isInteger(thread) || thread < 0 || thread >= RECLAIM_THREADS) {
    throw new RangeError(`reclaim: thread ${thread} outside 0 … ${RECLAIM_THREADS - 1}`);
  }
}

/** A new reclaim buffer: G at 1, `storeId` (a non-zero Int32) stamped, every reader idle, every limbo empty. */
export function createReclaimBuffer(shared: boolean, storeId: number): SharedArrayBuffer | ArrayBuffer {
  if (!Number.isInteger(storeId) || storeId === 0 || (storeId | 0) !== storeId) {
    throw new RangeError(`reclaim: store id ${storeId} is not a non-zero Int32`);
  }
  const buf = shared ? new SharedArrayBuffer(RECLAIM_BYTES) : new ArrayBuffer(RECLAIM_BYTES);
  const ints = new Int32Array(buf);
  Atomics.store(ints, R_EPOCH, 1);
  Atomics.store(ints, R_STORE_ID, storeId);
  return buf;
}

/**
 * Thread `thread`'s reclaimer over `buf` (one per thread and store; its limbo is local to it). `pools` are the store's
 * block and byte pools, in that order, the only pools `retire` accepts. Throws `TypeError` when `buf` is not of the
 * kind `shared` names, `RangeError` for another size, a thread outside 0 … 15 or a buffer with no store id.
 */
export function attachReclaimer(
  buf: SharedArrayBuffer | ArrayBuffer, thread: number, pools: readonly [SlabPool, SlabPool], shared: boolean,
): Reclaimer {
  assertBufferKind(buf, shared, 'reclaim');
  if (buf.byteLength !== RECLAIM_BYTES) throw new RangeError(`reclaim: buffer of ${buf.byteLength} bytes, expected ${RECLAIM_BYTES}`);
  checkThread(thread);
  const r = new Int32Array(buf);
  const storeId = Atomics.load(r, R_STORE_ID);
  if (storeId === 0) throw new RangeError('reclaim: the buffer has no store id');
  const reader = R_READER + thread;
  const counted = R_LIMBO + thread;

  /** The limbo ring: `count` entries from `head`, 3 Int32 each (pool index, slot, tag), in release order. */
  let ring = new Int32Array(3 * LIMBO_ENTRIES);
  let head = 0;
  let count = 0;
  let depth = 0;

  function poolIndex(pool: SlabPool): number {
    if (pool === pools[0]) return 0;
    if (pool === pools[1]) return 1;
    throw new RangeError('reclaim: a pool that is not one of this store\'s');
  }

  /** Doubles the ring, unrolled from `head` (the cold path). */
  function grow(): void {
    const cap = ring.length / 3;
    const next = new Int32Array(2 * ring.length);
    for (let i = 0; i < count; i++) {
      const from = 3 * ((head + i) % cap);
      next[3 * i] = ring[from]!;
      next[3 * i + 1] = ring[from + 1]!;
      next[3 * i + 2] = ring[from + 2]!;
    }
    ring = next;
    head = 0;
  }

  /** True when no thread announces a reader epoch. */
  function noReader(): boolean {
    for (let t = 0; t < RECLAIM_THREADS; t++) if (Atomics.load(r, R_READER + t) !== 0) return false;
    return true;
  }

  /** G, moved from 0 to 1 first: R[t] = 0 marks an idle reader, so a reader never announces 0. */
  function loadEpoch(): number {
    let g: number;
    while ((g = Atomics.load(r, R_EPOCH)) === 0) Atomics.compareExchange(r, R_EPOCH, 0, 1);
    return g;
  }

  function drain(): number {
    if (count === 0) return 0;
    const dead = Atomics.load(r, R_DEAD);
    const g = Atomics.load(r, R_EPOCH);
    // The oldest live reader relative to G (wrap-aware): the largest (G − e) | 0.
    let live = false;
    let m = 0;
    let oldest = 0;
    for (let t = 0; t < RECLAIM_THREADS; t++) {
      if ((dead & (1 << t)) !== 0) continue;
      const e = Atomics.load(r, R_READER + t);
      if (e === 0) continue;
      const age = (g - e) | 0;
      if (!live || age > oldest) {
        live = true;
        m = e;
        oldest = age;
      }
    }
    // Tags grow in release order (modulo 2³²), so the freeable entries are a prefix of the ring.
    const cap = ring.length / 3;
    let freed = 0;
    while (count > 0) {
      const at = 3 * head;
      if (live && ((ring[at + 2]! - m) | 0) >= 0) break;
      pools[ring[at]!]!.free(ring[at + 1]!);
      head = (head + 1) % cap;
      count--;
      freed++;
    }
    if (freed > 0) Atomics.sub(r, counted, freed);
    return count;
  }

  return {
    thread,
    storeId,
    enterRead() {
      if (depth++ > 0) return;
      let e: number;
      do {
        e = loadEpoch();
        Atomics.store(r, reader, e);
      } while (loadEpoch() !== e);
    },
    exitRead() {
      if (depth === 0) throw new Error(`reclaim: thread ${thread} is not inside a read section`);
      if (--depth > 0) return;
      Atomics.store(r, reader, 0);
      drain();
    },
    retire(pool, slot) {
      const p = poolIndex(pool);
      const tag = Atomics.add(r, R_EPOCH, 1);
      if (!shared || noReader()) {
        pool.free(slot);
        return;
      }
      if (count === ring.length / 3) grow();
      const at = 3 * ((head + count) % (ring.length / 3));
      ring[at] = p;
      ring[at + 1] = slot;
      ring[at + 2] = tag;
      count++;
      Atomics.add(r, counted, 1);
    },
    drain,
    limboCount(t) {
      checkThread(t);
      return Atomics.load(r, R_LIMBO + t);
    },
    markDead(t) {
      checkThread(t);
      Atomics.or(r, R_DEAD, 1 << t);
      Atomics.store(r, R_READER + t, 0);
    },
  };
}

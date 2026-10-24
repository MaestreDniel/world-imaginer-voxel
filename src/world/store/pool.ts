/**
 * A slab pool over one growable buffer (SP3a spec §3.1): fixed-size slots, a lock-guarded Int32 free stack and
 * Int32 refcounts. The same code runs over a growable `SharedArrayBuffer` (`shared: true`, usable from several
 * threads through `handles()` / `attachPool`) and over a resizable `ArrayBuffer` (one thread). Atomics work on both.
 *
 * Buffers per pool:
 * - `data`: the slots, `slotBytes` each; slot id = the slot's index;
 * - `ctl`: Int32[4], fixed: the lock word (0 free, else its owner's thread index + 1), the stack top, the slot count;
 * - `stack`: the free stack, Int32 per slot; `refs`: the refcounts, Int32 per slot.
 * `data`, `stack` and `refs` start empty and grow together by `GROW_BYTES` of slots, under the lock, inside the
 * `alloc` that finds the stack empty (whichever thread that is). Every view is length-tracking, so growth made by
 * another thread is seen without rebuilding anything.
 *
 * The lock owner (SP4b spec §2.6, D6): a pool attached with an `owner` locks with `thread + 1` and, while it spins,
 * checks the word's owner against the dead-owner mask, so a worker terminated inside the lock is a `StoreCorrupt`
 * instead of a spin that never ends.
 */

/** Block pool slots: a u16 state per voxel of a 16³ section. */
export const BLOCK_SLOT_BYTES = 8192;
/** Byte pool slots: one byte per voxel (light, fluid) or an aux slot. */
export const BYTE_SLOT_BYTES = 4096;
/** A pool grows by 1 MiB of slots (128 block slots, 256 byte slots). */
export const GROW_BYTES = 1 << 20;
/** Default maxima: reserved address space, not committed memory. */
export const DEFAULT_MAX_BLOCK_BYTES = 768 * GROW_BYTES;
export const DEFAULT_MAX_BYTE_BYTES = 512 * GROW_BYTES;

const LOCK = 0;
const TOP = 1;
const COUNT = 2;
const CTL_INTS = 4;
const MAX_SPIN = 1024;
/** Once the backoff saturates, a spinning `lock()` re-reads the owner every this many spins (SP4b spec §2.6). */
export const LOCK_RECHECK_SPINS = 4096;
/**
 * The dead-owner mask's Int32 index in the reclaim buffer (bit t: thread t failed; SP4b spec §2.6); `reclaim.ts`
 * re-exports it with the buffer's other indices.
 */
export const R_DEAD = 1;

/** An alloc found the free stack empty and the pool at its maximum size. */
export class StoreFull extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreFull';
  }
}

/** A thread spinning on a pool lock found its owner dead (SP4b spec §2.6): the store can no longer be trusted. */
export class StoreCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCorrupt';
  }
}

/**
 * The thread a pool locks as (SP4b spec §2.6): `thread` 0 … 15, and `dead` the reclaim buffer's Int32 view, whose
 * `dead[R_DEAD]` is the dead-owner mask.
 */
export interface PoolOwner {
  readonly thread: number;
  readonly dead: Int32Array;
}

export interface PoolOptions {
  readonly shared: boolean;
  /** A power of two dividing `GROW_BYTES`. */
  readonly slotBytes: number;
  /** A positive multiple of `GROW_BYTES`. */
  readonly maxBytes: number;
}

type Growable = SharedArrayBuffer | ArrayBuffer;

/** The buffers of a pool; `attachPool` rebuilds the pool from them (in another thread when `shared`). */
export interface PoolHandles {
  readonly shared: boolean;
  readonly slotBytes: number;
  readonly data: Growable;
  readonly ctl: Growable;
  readonly stack: Growable;
  readonly refs: Growable;
}

export interface SlabPool {
  readonly shared: boolean;
  readonly slotBytes: number;
  readonly maxSlots: number;
  /** The slot buffer. */
  readonly buffer: Growable;
  /** Length-tracking views over every slot; slot `id` starts at byte `id·slotBytes`. */
  readonly bytes: Uint8Array;
  readonly words: Uint16Array;
  /** Pops a slot with refcount 1, growing the pool when the free stack is empty. Throws `StoreFull` at the maximum. */
  alloc(): number;
  /** Adds a reference to a live slot. */
  retain(id: number): void;
  /** Drops a reference; the last one pushes the slot back. The slot is never zeroed. */
  free(id: number): void;
  refcount(id: number): number;
  slotCount(): number;
  freeCount(): number;
  /** A copy of the free stack, bottom first (taken under the lock). */
  freeStack(): Int32Array;
  /** The raw lock word (0 when free, else its owner's thread index + 1; SP4b spec §2.6); for tests. */
  lockWord(): number;
  /** Runs `fn` holding the pool lock under this pool's owner, then releases it (the test seam of SP4b spec §2.6). */
  withLock<T>(fn: () => T): T;
  /** Fixed-length views over one slot. */
  u8(id: number): Uint8Array;
  u16(id: number): Uint16Array;
  handles(): PoolHandles;
}

function growable(shared: boolean, maxByteLength: number): Growable {
  return shared ? new SharedArrayBuffer(0, { maxByteLength }) : new ArrayBuffer(0, { maxByteLength });
}

function growTo(buf: Growable, byteLength: number): void {
  if (buf instanceof SharedArrayBuffer) buf.grow(byteLength);
  else buf.resize(byteLength);
}

export function createPool(opts: PoolOptions): SlabPool {
  const { shared, slotBytes, maxBytes } = opts;
  if (!Number.isInteger(slotBytes) || slotBytes < 2 || (slotBytes & (slotBytes - 1)) !== 0 || slotBytes > GROW_BYTES) {
    throw new RangeError(`pool: slotBytes ${slotBytes} is not a power of two in [2, ${GROW_BYTES}]`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes % GROW_BYTES !== 0) {
    throw new RangeError(`pool: maxBytes ${maxBytes} is not a positive multiple of ${GROW_BYTES}`);
  }
  const maxSlots = maxBytes / slotBytes;
  return attachPool({
    shared,
    slotBytes,
    data: growable(shared, maxBytes),
    ctl: shared ? new SharedArrayBuffer(4 * CTL_INTS) : new ArrayBuffer(4 * CTL_INTS),
    stack: growable(shared, 4 * maxSlots),
    refs: growable(shared, 4 * maxSlots),
  });
}

/**
 * Throws `TypeError` unless `buf` is a `SharedArrayBuffer` when `shared`, or an `ArrayBuffer` otherwise (SP4a spec
 * §2.5, SP3a §10's item 7): a store whose buffers are of the wrong kind would silently stop being shared.
 */
export function assertBufferKind(buf: unknown, shared: boolean, what: string): void {
  const ok = shared ? buf instanceof SharedArrayBuffer : buf instanceof ArrayBuffer;
  if (!ok) {
    const kind = buf instanceof SharedArrayBuffer ? 'a SharedArrayBuffer' : buf instanceof ArrayBuffer ? 'an ArrayBuffer' : typeof buf;
    throw new TypeError(`${what}: ${kind}, expected ${shared ? 'a SharedArrayBuffer (shared)' : 'an ArrayBuffer (not shared)'}`);
  }
}

/**
 * The pool over existing handles; throws `TypeError` when a buffer is not of the kind `shared` names. With `owner`
 * (a shared store's thread, SP4b spec §2.6) the lock word is `owner.thread + 1` and a lock held by a thread marked dead
 * throws `StoreCorrupt`; without it (`createPool`, single-threaded stores) the word is 1 and no dead check runs.
 */
export function attachPool(h: PoolHandles, owner?: PoolOwner): SlabPool {
  for (const key of ['data', 'ctl', 'stack', 'refs'] as const) assertBufferKind(h[key], h.shared, `pool: ${key}`);
  const { shared, slotBytes, data, stack: stackBuf, refs: refsBuf } = h;
  const maxSlots = data.maxByteLength / slotBytes;
  const slotsPerGrow = GROW_BYTES / slotBytes;
  const ctl = new Int32Array(h.ctl);
  const stack = new Int32Array(stackBuf);
  const refs = new Int32Array(refsBuf);
  const bytes = new Uint8Array(data);
  const words = new Uint16Array(data);
  const word = owner === undefined ? 1 : owner.thread + 1;
  const dead = owner?.dead;

  /**
   * Compare-exchange spin of 0 → `word`; the backoff re-reads the word (no `Atomics.wait`: the main thread may not
   * block). Once it saturates, every `LOCK_RECHECK_SPINS` spins it checks the holder against the dead-owner mask.
   */
  function lock(): void {
    let spins = 1;
    let sinceCheck = 0;
    while (Atomics.compareExchange(ctl, LOCK, 0, word) !== 0) {
      for (let i = 0; i < spins && Atomics.load(ctl, LOCK) !== 0; i++);
      if (spins < MAX_SPIN) spins <<= 1;
      else if (dead !== undefined && (sinceCheck += MAX_SPIN) >= LOCK_RECHECK_SPINS) {
        sinceCheck = 0;
        const k = Atomics.load(ctl, LOCK) - 1;
        if (k >= 0 && k < 32 && (Atomics.load(dead, R_DEAD) & (1 << k)) !== 0) {
          throw new StoreCorrupt(`pool lock held by failed thread ${k}`);
        }
      }
    }
  }

  function unlock(): void {
    Atomics.store(ctl, LOCK, 0);
  }

  function checkId(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= Atomics.load(ctl, COUNT)) {
      throw new RangeError(`pool: slot ${id} out of range`);
    }
  }

  /** Under the lock, with an empty stack: add up to GROW_BYTES of slots and push them, lowest id on top. */
  function grow(): void {
    const count = Atomics.load(ctl, COUNT);
    const n = Math.min(slotsPerGrow, maxSlots - count);
    if (n <= 0) throw new StoreFull(`pool of ${slotBytes}-byte slots is full (${count} slots)`);
    const total = count + n;
    growTo(data, total * slotBytes);
    growTo(stackBuf, 4 * total);
    growTo(refsBuf, 4 * total);
    for (let i = 0; i < n; i++) stack[i] = total - 1 - i;
    Atomics.store(ctl, TOP, n);
    Atomics.store(ctl, COUNT, total);
  }

  return {
    shared,
    slotBytes,
    maxSlots,
    buffer: data,
    bytes,
    words,
    alloc() {
      lock();
      try {
        if (Atomics.load(ctl, TOP) === 0) grow();
        const top = Atomics.load(ctl, TOP) - 1;
        const id = stack[top]!;
        Atomics.store(ctl, TOP, top);
        Atomics.store(refs, id, 1);
        return id;
      } finally {
        unlock();
      }
    },
    retain(id) {
      checkId(id);
      const old = Atomics.add(refs, id, 1);
      if (old <= 0) {
        Atomics.sub(refs, id, 1);
        throw new Error(`pool: retain of slot ${id} with refcount ${old}`);
      }
    },
    free(id) {
      checkId(id);
      const old = Atomics.sub(refs, id, 1);
      if (old <= 0) {
        Atomics.add(refs, id, 1);
        throw new Error(`pool: free of slot ${id} with refcount ${old}`);
      }
      if (old > 1) return;
      lock();
      try {
        const top = Atomics.load(ctl, TOP);
        stack[top] = id;
        Atomics.store(ctl, TOP, top + 1);
      } finally {
        unlock();
      }
    },
    refcount(id) {
      checkId(id);
      return Atomics.load(refs, id);
    },
    slotCount: () => Atomics.load(ctl, COUNT),
    freeCount: () => Atomics.load(ctl, TOP),
    freeStack() {
      lock();
      try {
        return stack.slice(0, Atomics.load(ctl, TOP));
      } finally {
        unlock();
      }
    },
    lockWord: () => Atomics.load(ctl, LOCK),
    withLock(fn) {
      lock();
      try {
        return fn();
      } finally {
        unlock();
      }
    },
    u8(id) {
      checkId(id);
      return new Uint8Array(data, id * slotBytes, slotBytes);
    },
    u16(id) {
      checkId(id);
      return new Uint16Array(data, id * slotBytes, slotBytes >> 1);
    },
    handles: () => h,
  };
}

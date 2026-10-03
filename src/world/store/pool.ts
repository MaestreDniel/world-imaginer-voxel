/**
 * A slab pool over one growable buffer (SP3a spec §3.1): fixed-size slots, a lock-guarded Int32 free stack and
 * Int32 refcounts. The same code runs over a growable `SharedArrayBuffer` (`shared: true`, usable from several
 * threads through `handles()` / `attachPool`) and over a resizable `ArrayBuffer` (one thread). Atomics work on both.
 *
 * Buffers per pool:
 * - `data`: the slots, `slotBytes` each; slot id = the slot's index;
 * - `ctl`: Int32[4], fixed: the lock word, the stack top, the slot count;
 * - `stack`: the free stack, Int32 per slot; `refs`: the refcounts, Int32 per slot.
 * `data`, `stack` and `refs` start empty and grow together by `GROW_BYTES` of slots, under the lock, inside the
 * `alloc` that finds the stack empty (whichever thread that is). Every view is length-tracking, so growth made by
 * another thread is seen without rebuilding anything.
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

/** An alloc found the free stack empty and the pool at its maximum size. */
export class StoreFull extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreFull';
  }
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
  /** The lock word (0 when free); for tests. */
  lockWord(): number;
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

export function attachPool(h: PoolHandles): SlabPool {
  const { shared, slotBytes, data, stack: stackBuf, refs: refsBuf } = h;
  const maxSlots = data.maxByteLength / slotBytes;
  const slotsPerGrow = GROW_BYTES / slotBytes;
  const ctl = new Int32Array(h.ctl);
  const stack = new Int32Array(stackBuf);
  const refs = new Int32Array(refsBuf);
  const bytes = new Uint8Array(data);
  const words = new Uint16Array(data);

  /** Compare-exchange spin; the backoff re-reads the word (no `Atomics.wait`: the main thread may not block). */
  function lock(): void {
    let spins = 1;
    while (Atomics.compareExchange(ctl, LOCK, 0, 1) !== 0) {
      for (let i = 0; i < spins && Atomics.load(ctl, LOCK) !== 0; i++);
      if (spins < MAX_SPIN) spins <<= 1;
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

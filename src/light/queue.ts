/**
 * The light job's queue (SP4a spec §4.2 step 3): a FIFO ring of Int32 voxel indices over a power-of-two capacity,
 * allocated once per worker and reused by every BFS. `push` throws on overflow instead of growing, so a run that
 * would exceed the capacity fails loudly.
 */

export interface LightQueue {
  /** Appends `i` at the tail; throws `light queue overflow` when the ring is full. */
  push(i: number): void;
  /** Removes and returns the head; throws `light queue empty` when there is none. */
  pop(): number;
  readonly length: number;
  /** Empties the queue (the ring is kept). */
  clear(): void;
}

/** A ring of `capacity` (a positive power of two) Int32 entries. */
export function createLightQueue(capacity: number): LightQueue {
  if (!Number.isInteger(capacity) || capacity < 1 || (capacity & (capacity - 1)) !== 0) {
    throw new RangeError(`createLightQueue: capacity ${capacity} is not a positive power of two`);
  }
  const ring = new Int32Array(capacity);
  const mask = capacity - 1;
  let head = 0;
  let size = 0;
  return {
    push(i) {
      if (size === capacity) throw new Error(`light queue overflow (capacity ${capacity})`);
      ring[(head + size) & mask] = i;
      size++;
    },
    pop() {
      if (size === 0) throw new Error('light queue empty');
      const i = ring[head]!;
      head = (head + 1) & mask;
      size--;
      return i;
    },
    get length() {
      return size;
    },
    clear() {
      head = 0;
      size = 0;
    },
  };
}

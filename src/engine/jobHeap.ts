/**
 * The pool's aux lane (SP4c spec §6.1, D11): a binary min-heap of items ordered by (priority, id). The heap is an
 * `Int32Array` of slot indices over preallocated `Float64Array` priority and id keys (and a slot array of items), so a
 * push or a pop moves integers, not objects; a full heap grows ×2. `removeWhere` and `clear` return the removed items in
 * (priority, id) order; `removeWhere` rebuilds the rest in O(n).
 */

export interface JobHeap<T> {
  readonly size: number;
  /** Adds `item` under the key (priority, id); a lower key pops first. */
  push(item: T, priority: number, id: number): void;
  /** The item with the lowest key, or undefined when empty. */
  peek(): T | undefined;
  /** Removes and returns the item with the lowest key, or undefined when empty. */
  pop(): T | undefined;
  /** Removes every item `drop` selects; returns them in (priority, id) order. */
  removeWhere(drop: (item: T) => boolean): T[];
  /** Empties the heap; returns its items in (priority, id) order. */
  clear(): T[];
}

export function createJobHeap<T>(capacity = 64): JobHeap<T> {
  if (!(Number.isSafeInteger(capacity) && capacity >= 1)) throw new RangeError(`createJobHeap: capacity ${capacity} is not a positive integer`);
  let cap = capacity;
  /** heap[0 … size) are slot indices in heap order. */
  let heap = new Int32Array(cap);
  let prio = new Float64Array(cap);
  let ids = new Float64Array(cap);
  let items: Array<T | undefined> = new Array<T | undefined>(cap).fill(undefined);
  /** free[0 … freeCount) are the unused slots. */
  let free = new Int32Array(cap);
  let freeCount = cap;
  for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;
  let size = 0;

  /** Whether slot a's key is below slot b's. */
  const less = (a: number, b: number): boolean => prio[a]! < prio[b]! || (prio[a] === prio[b] && ids[a]! < ids[b]!);

  const siftUp = (at: number): void => {
    const s = heap[at]!;
    let i = at;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent]!;
      if (!less(s, p)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = s;
  };

  const siftDown = (at: number): void => {
    const s = heap[at]!;
    let i = at;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && less(heap[r]!, heap[l]!) ? r : l;
      if (!less(heap[c]!, s)) break;
      heap[i] = heap[c]!;
      i = c;
    }
    heap[i] = s;
  };

  const grow = (): void => {
    const next = cap * 2;
    const h = new Int32Array(next); h.set(heap); heap = h;
    const p = new Float64Array(next); p.set(prio); prio = p;
    const d = new Float64Array(next); d.set(ids); ids = d;
    items = items.concat(new Array<T | undefined>(next - cap).fill(undefined));
    // Every old slot is in use (the heap was full): the new ones are free.
    const f = new Int32Array(next);
    for (let i = 0; i < next - cap; i++) f[i] = next - 1 - i;
    free = f;
    freeCount = next - cap;
    cap = next;
  };

  /** Frees slot s and returns its item. */
  const release = (s: number): T => {
    const item = items[s] as T;
    items[s] = undefined;
    free[freeCount++] = s;
    return item;
  };

  /** The given slots' items in (priority, id) order, their slots freed. */
  const releaseSorted = (slots: number[]): T[] => slots.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0)).map(release);

  return {
    get size() { return size; },
    push(item, priority, id) {
      if (size === cap) grow();
      const s = free[--freeCount]!;
      items[s] = item;
      prio[s] = priority;
      ids[s] = id;
      heap[size] = s;
      siftUp(size++);
    },
    peek() {
      return size === 0 ? undefined : items[heap[0]!];
    },
    pop() {
      if (size === 0) return undefined;
      const s = heap[0]!;
      if (--size > 0) {
        heap[0] = heap[size]!;
        siftDown(0);
      }
      return release(s);
    },
    removeWhere(drop) {
      // Every item is judged before the heap changes, so a `drop` that throws leaves it whole.
      const dropped: number[] = [];
      for (let i = 0; i < size; i++) if (drop(items[heap[i]!] as T)) dropped.push(heap[i]!);
      if (dropped.length === 0) return [];
      const gone = new Set(dropped);
      let kept = 0;
      for (let i = 0; i < size; i++) if (!gone.has(heap[i]!)) heap[kept++] = heap[i]!;
      size = kept;
      // Floyd's heap construction over the kept slots: O(n).
      for (let i = (size >> 1) - 1; i >= 0; i--) siftDown(i);
      return releaseSorted(dropped);
    },
    clear() {
      const all = Array.from(heap.subarray(0, size));
      size = 0;
      return releaseSorted(all);
    },
  };
}

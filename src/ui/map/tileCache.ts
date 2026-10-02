/**
 * LRU of rendered tiles keyed by (layer, level, tx, tz, layer hash). The capacity follows the view
 * (SP2b spec §2.5: `capacity.ts`); master §5.6's 256 entries is its floor.
 */
export interface TileCache<T> {
  /** The value under `key`, made the most recently used. */
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
  readonly capacity: number;
  /** Lowering the capacity evicts the least recently used entries at once. */
  setCapacity(n: number): void;
  clear(): void;
}

export const tileKey = (layer: string, level: number, tx: number, tz: number, hash: string): string => `${layer}|${level}|${tx}|${tz}|${hash}`;

/** `onEvict` runs for every value that leaves the cache: evicted, replaced under its key by another value, or cleared. */
export function createTileCache<T>(capacity = 256, onEvict: (value: T, key: string) => void = () => {}): TileCache<T> {
  const map = new Map<string, T>();
  let cap = capacity;
  const trim = () => {
    while (map.size > cap) {
      const oldest = map.keys().next().value!;
      const v = map.get(oldest)!;
      map.delete(oldest);
      onEvict(v, oldest);
    }
  };
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    set(key, value) {
      const old = map.get(key);
      if (old !== undefined) { map.delete(key); if (old !== value) onEvict(old, key); }
      map.set(key, value);
      trim();
    },
    get size() { return map.size; },
    get capacity() { return cap; },
    setCapacity(n) {
      if (!(Number.isSafeInteger(n) && n >= 1)) throw new RangeError(`tile cache capacity ${n} is not a positive integer`);
      cap = n;
      trim();
    },
    clear() { for (const [k, v] of map) onEvict(v, k); map.clear(); },
  };
}

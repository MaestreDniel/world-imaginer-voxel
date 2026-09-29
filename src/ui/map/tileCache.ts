/** LRU of rendered tiles keyed by (layer, level, tx, tz, layer hash) (master §5.6: 256 entries). */
export interface TileCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
  clear(): void;
}

export const tileKey = (layer: string, level: number, tx: number, tz: number, hash: string): string => `${layer}|${level}|${tx}|${tz}|${hash}`;

export function createTileCache<T>(capacity = 256, onEvict: (value: T) => void = () => {}): TileCache<T> {
  const map = new Map<string, T>();
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    set(key, value) {
      const old = map.get(key);
      if (old !== undefined) { map.delete(key); if (old !== value) onEvict(old); }
      map.set(key, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value!;
        const v = map.get(oldest)!;
        map.delete(oldest);
        onEvict(v);
      }
    },
    get size() { return map.size; },
    clear() { for (const v of map.values()) onEvict(v); map.clear(); },
  };
}

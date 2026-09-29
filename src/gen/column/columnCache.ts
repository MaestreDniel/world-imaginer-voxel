/** Worker-local LRU of ColumnSamples (master §2.4: 1024 entries), keyed by colKey (master §2.1); one per GenContext. */
import type { GenContext } from '../context';
import { buildColumnSample, newColumnSample, type ColumnSample } from './columnStage';

const BUILD = buildColumnSample;
const NEW = newColumnSample;

export interface ColumnCache {
  get(cx: number, cz: number): ColumnSample;
  readonly size: number;
}

export function createColumnCache(ctx: GenContext, capacity = 1024): ColumnCache {
  const map = new Map<number, ColumnSample>();
  return {
    get(cx, cz) {
      const key = (cx + 32768) * 65536 + (cz + 32768);
      const hit = map.get(key);
      if (hit !== undefined) {
        map.delete(key);
        map.set(key, hit);
        return hit;
      }
      let s: ColumnSample;
      if (map.size >= capacity) {
        const oldest = map.keys().next().value!;
        s = map.get(oldest)!;
        map.delete(oldest);
      } else {
        s = NEW();
      }
      BUILD(ctx, cx, cz, s);
      map.set(key, s);
      return s;
    },
    get size() { return map.size; },
  };
}

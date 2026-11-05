/**
 * The carver path cache (SP6a spec §2.5): a worker-local LRU of `CarverPath`s keyed by (kind, sx, sz), over one world
 * seed and one set of carver leaves. A path is a pure function of its source (`carverPath`), so a miss recomputes the
 * same path and the cache never changes output, whatever its capacity or what it held before (`DT1.carverCache`).
 * - The key is one number: `(kindIndex·2^21 + (sx + 2^20))·2^21 + (sz + 2^20)` (worm 0, ravine 1, underground worm 2),
 *   exact below 2^53 for |sx|, |sz| < 2^20 chunks (16.7 M blocks, past every reachable chunk).
 * - LRU by a `Map`'s insertion order: a hit deletes and re-sets its entry (no allocation), a miss past the capacity
 *   drops the oldest entry. A failed roll (null) is not cached: it costs one hash and one draw, about 50 ns.
 * `carverCacheOf(ctx)` is the T stage's and the probes' cache: one per GenContext, built on first use from
 * `carverParamsOf(ctx.params)` with the capacity `CARVER_CACHE_PATHS` (`core/constants.ts`) and memoised in a WeakMap
 * (as `surfaceContextOf`), so a `configure`, which builds a new GenContext, drops it with the old context. Follows the
 * gen determinism rules.
 */
import { CARVER_CACHE_PATHS } from '../../core/constants';
import type { GenContext } from '../context';
import { carverParamsOf, carverPath, type CarverKind, type CarverParams, type CarverPath } from './carvers';

const CARVER_PATH = carverPath;
const PARAMS_OF = carverParamsOf;
const CAPACITY = CARVER_CACHE_PATHS;
const IS_INT = Number.isInteger;
/** 2^20: the offset that makes sx and sz non-negative in the key. */
const OFFSET = 1048576;
/** 2^21: each field's span in the key. */
const SPAN = 2097152;

/** The carver path cache of one world seed and one set of carver leaves. */
export interface CarverCache {
  /** Source (kind, sx, sz)'s path, `carverPath`'s (the same object while it stays cached); null when its roll fails. */
  path(kind: CarverKind, sx: number, sz: number): CarverPath | null;
  /** The paths held (≤ the capacity). */
  readonly size: number;
  /** The carver leaves its paths are built from. */
  readonly params: CarverParams;
  /** The most paths it holds. */
  readonly capacity: number;
}

/** A path cache over `ctx`'s seed and the carver leaves `p`, holding at most `capacity` (an integer ≥ 1) paths. */
export function createCarverCache(ctx: GenContext, p: CarverParams, capacity: number): CarverCache {
  if (!IS_INT(capacity) || capacity < 1) throw new RangeError(`createCarverCache: capacity ${capacity} is not an integer ≥ 1`);
  const seed = ctx.seed;
  const map = new Map<number, CarverPath>();
  return {
    path(kind, sx, sz) {
      const kindIndex = kind === 'worm' ? 0 : kind === 'ravine' ? 1 : 2;
      const key = (kindIndex * SPAN + (sx + OFFSET)) * SPAN + (sz + OFFSET);
      const hit = map.get(key);
      if (hit !== undefined) {
        map.delete(key);
        map.set(key, hit);
        return hit;
      }
      const path = CARVER_PATH(seed, kind, sx, sz, p);
      if (path === null) return null;
      if (map.size >= capacity) map.delete(map.keys().next().value!);
      map.set(key, path);
      return path;
    },
    get size() { return map.size; },
    params: p,
    capacity,
  };
}

const CACHES = new WeakMap<GenContext, CarverCache>();

/**
 * The carver path cache of `ctx` (spec §2.5): built on first use from `carverParamsOf(ctx.params)` with the capacity
 * `CARVER_CACHE_PATHS`, then the same object for that context; a new context (a `configure`) gets a new, empty one.
 */
export function carverCacheOf(ctx: GenContext): CarverCache {
  let c = CACHES.get(ctx);
  if (c === undefined) {
    c = createCarverCache(ctx, PARAMS_OF(ctx.params), CAPACITY);
    CACHES.set(ctx, c);
  }
  return c;
}

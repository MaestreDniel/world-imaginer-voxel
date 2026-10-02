/**
 * Fallback tiles (SP2b spec §2.5) and the per-draw accounting of the map canvas (§2.6, §2.8). Pure: the
 * canvas passes the visible positions, the current source's keys and a cache lookup, and draws what `frame`
 * returns, in that order.
 *
 * A position is (layer, level, tx, tz). Its fallback is the key last drawn there. Where the current source
 * has no cached tile, the fallback is drawn while it is still cached. The current source is always the
 * newest, so a fallback changes only when a current tile is drawn at its position; a source change, a tile
 * that has not landed or a superseded source's late tile leave it. No count of sources bounds it. A fallback
 * whose tile left the cache is forgotten (`evicted`, or the next lookup that misses).
 */
import type { MapLevel } from '../../core/constants';

export interface TilePos { readonly tx: number; readonly tz: number }

/** The visible positions of one level, nearest to the view centre first. */
export interface LevelTiles { readonly level: MapLevel; readonly tiles: readonly TilePos[] }

export interface TileDraw<T> {
  readonly level: MapLevel;
  readonly tx: number;
  readonly tz: number;
  readonly key: string;
  readonly tile: T;
  /** Drawn because the current source has no cached tile here. */
  readonly fallback: boolean;
}

export interface Frame<T> {
  /** Fallbacks coarse to fine, then the current source's tiles coarse to fine: a current preview covers a fallback fine tile. */
  readonly draws: readonly TileDraw<T>[];
  /** The length of the longest prefix of the preview positions (`levels[0]`, nearest first) showing the current source's tiles. */
  readonly nearestCurrent: number;
  /** After the first image, a preview position that showed a tile in the previous draw of this layer shows none (§2.8). */
  readonly blank: boolean;
}

/** The current source's key of a position, or null while the source does not match the pool's epoch. */
export type CurrentKey = (level: MapLevel, tx: number, tz: number) => string | null;

export interface Fallbacks {
  /**
   * One draw of `layer`. `levels[0]` is the preview level (256) and the levels run coarse to fine. `get` is
   * the cache lookup; it is called for every tile drawn, so drawing refreshes a tile's LRU entry.
   */
  frame<T>(layer: string, levels: readonly LevelTiles[], current: CurrentKey, get: (key: string) => T | undefined): Frame<T>;
  /** The tile under `key` left the cache: the position whose fallback it was has none until a tile is drawn there. */
  evicted(key: string): void;
  /** The fallback key of a position, or null. */
  keyAt(layer: string, level: MapLevel, tx: number, tz: number): string | null;
  /** Positions with a fallback key, over every layer. */
  readonly size: number;
  /** Blank draws since the first image: a draw in which every visible preview position showed a tile. */
  readonly blankDraws: number;
}

const positionId = (layer: string, level: number, tx: number, tz: number): string => `${layer}|${level}|${tx}|${tz}`;

export function createFallbacks(): Fallbacks {
  /** Position → the key last drawn there, and back (a key belongs to one position). */
  const keyAtPosition = new Map<string, string>();
  const positionOfKey = new Map<string, string>();
  /** Per layer: the preview positions ('tx,tz') that showed a tile in that layer's previous draw. */
  const shownBefore = new Map<string, ReadonlySet<string>>();
  let firstImage = false;
  let blankDraws = 0;

  const forget = (position: string) => {
    const key = keyAtPosition.get(position);
    if (key === undefined) return;
    keyAtPosition.delete(position);
    positionOfKey.delete(key);
  };
  const remember = (position: string, key: string) => {
    const old = keyAtPosition.get(position);
    if (old === key) return;
    if (old !== undefined) positionOfKey.delete(old);
    keyAtPosition.set(position, key);
    positionOfKey.set(key, position);
  };

  return {
    frame<T>(layer: string, levels: readonly LevelTiles[], current: CurrentKey, get: (key: string) => T | undefined): Frame<T> {
      const fallbackDraws: TileDraw<T>[] = [];
      const currentDraws: TileDraw<T>[] = [];
      const shown = new Set<string>();
      let nearestCurrent = 0;
      let prefix = true;
      levels.forEach(({ level, tiles }, li) => {
        for (const { tx, tz } of tiles) {
          const position = positionId(layer, level, tx, tz);
          const key = current(level, tx, tz);
          const tile = key === null ? undefined : get(key);
          let isCurrent = false;
          let drawn = false;
          if (key !== null && tile !== undefined) {
            currentDraws.push({ level, tx, tz, key, tile, fallback: false });
            remember(position, key);
            isCurrent = true;
            drawn = true;
          } else {
            const old = keyAtPosition.get(position);
            const oldTile = old === undefined ? undefined : get(old);
            if (old !== undefined && oldTile !== undefined) {
              fallbackDraws.push({ level, tx, tz, key: old, tile: oldTile, fallback: true });
              drawn = true;
            } else if (old !== undefined) {
              forget(position);
            }
          }
          if (li !== 0) continue;
          if (prefix && isCurrent) nearestCurrent++;
          else prefix = false;
          if (drawn) shown.add(`${tx},${tz}`);
        }
      });
      const preview = levels[0]?.tiles ?? [];
      const before = shownBefore.get(layer);
      let blank = false;
      if (firstImage && before !== undefined) {
        for (const { tx, tz } of preview) {
          const id = `${tx},${tz}`;
          if (before.has(id) && !shown.has(id)) { blank = true; break; }
        }
      }
      if (blank) blankDraws++;
      shownBefore.set(layer, shown);
      if (!firstImage && preview.length > 0 && shown.size === preview.length) firstImage = true;
      return { draws: [...fallbackDraws, ...currentDraws], nearestCurrent, blank };
    },
    evicted(key) {
      const position = positionOfKey.get(key);
      if (position !== undefined && keyAtPosition.get(position) === key) forget(position);
    },
    keyAt(layer, level, tx, tz) {
      return keyAtPosition.get(positionId(layer, level, tx, tz)) ?? null;
    },
    get size() { return keyAtPosition.size; },
    get blankDraws() { return blankDraws; },
  };
}

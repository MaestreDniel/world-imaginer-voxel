/**
 * Tile cache capacity (SP2b spec §2.5, SP2a minor 10): max(256, 3 × (visible target-level tiles + visible
 * preview tiles)), so the current tiles, a fallback per visible position and the tiles in flight all fit.
 * The count is the full plan's (the view's level counted once when it is the preview level). The canvas
 * recomputes it on resize and on every view change, since zooming changes the count as much as resizing.
 */
import type { MapView } from './mapState';
import { planTiles } from './viewMath';

/** The SP2a capacity (master §5.6), now the floor. */
export const TILE_CACHE_MIN = 256;
const PER_VISIBLE_TILE = 3;

export function tileCacheCapacity(v: MapView, w: number, h: number): number {
  return Math.max(TILE_CACHE_MIN, PER_VISIBLE_TILE * planTiles(v, w, h).length);
}

/**
 * Cache keys of map tiles (SP2a spec §6.1). A key exists only while the pool runs the epoch the source
 * was set for, so tiles rendered for a new world never land under the previous world's keys. A layer's
 * key holds the seed words, the layer's own stage hash and the map stage *version*; the map stage hash
 * chains every upstream stage and would invalidate every layer on any edit.
 */
import type { MapLevel } from '../../core/constants';
import { STAGES } from '../../core/stage/registry';
import { layerStage, type LayerId } from '../../gen/map/layers';
import { tileKey } from './tileCache';

const MAP_VERSION = STAGES.find((s) => s.id === 'map')!.version;

export interface TileSource {
  /** The pool finished configuring `epoch` with these seed words and stage hashes (hex). */
  set(epoch: number, seedKey: string, hashes: Readonly<Record<string, string>>): void;
  /**
   * The pool epoch of the source, or null before the first set. There is no clear (SP2b spec §2.5): while
   * a reconfigure runs, keyFor gives no key and the canvas draws fallback tiles.
   */
  readonly epoch: number | null;
  /** The cache key of a tile, or null when no source matches the pool's current epoch. */
  keyFor(layer: LayerId, level: MapLevel, tx: number, tz: number, poolEpoch: number): string | null;
}

export function createTileSource(): TileSource {
  let epoch = -1;
  let seedKey = '';
  let hashes: Readonly<Record<string, string>> | null = null;
  return {
    set(e, s, h) { epoch = e; seedKey = s; hashes = h; },
    get epoch() { return hashes === null ? null : epoch; },
    keyFor(layer, level, tx, tz, poolEpoch) {
      if (hashes === null || poolEpoch !== epoch) return null;
      return tileKey(layer, level, tx, tz, `${seedKey}:${hashes[layerStage(layer)] ?? ''}:map${MAP_VERSION}`);
    },
  };
}

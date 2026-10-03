/**
 * The real block definitions (SP3a spec §2.2), in id order. Append-only: ids follow this order and are locked by
 * `test/stateIds.lock.json` (§2.3), so a new type goes at the end, and a type with lock entries never changes its
 * properties or default. SP3b appends the terrain palette.
 *
 * Texture ids are 0 until SP8a; `SOUND` none is air's only (never played).
 */
import type { BlockDef } from './registry';

export const BLOCK_DEFS: readonly BlockDef[] = Object.freeze([
  {
    name: 'air',
    opacity: 0, pass: 'none', shape: 'none', fullFaces: 0, emit: 0, carvable: false, replaceable: true,
    collide: 'none', fluidMode: 'displace', tint: 'none', sound: 'none', faceTex: 0,
  },
  {
    name: 'stone',
    opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: true, replaceable: false,
    collide: 'cube', fluidMode: 'block', tint: 'none', sound: 'stone', faceTex: 0,
  },
  {
    name: 'bedrock',
    opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: false, replaceable: false,
    collide: 'cube', fluidMode: 'block', tint: 'none', sound: 'stone', faceTex: 0,
  },
]);

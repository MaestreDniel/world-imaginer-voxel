/**
 * The real block definitions (SP3a spec §2.2), in id order. Append-only: ids follow this order and are locked by
 * `test/stateIds.lock.json` (§2.3), so a new type goes at the end, and a type with lock entries never changes its
 * properties or default. SP3c appends the terrain palette (SP3c spec §2.1): 22 types without properties, state ids
 * 3 … 24, all opaque full cubes, carvable except `packed_ice`.
 *
 * Texture ids are 0 until SP8a; `SOUND` none is air's only (never played).
 */
import type { Sound, Tint } from './kinds';
import type { BlockDef } from './registry';

/**
 * A terrain palette type (SP3c spec §2.1): no properties; `OPACITY` 15, `PASS` opaque, `SHAPE` cube, `FULL_FACES` 63,
 * `EMIT` 0, `REPLACEABLE` false, `COLLIDE` cube, `FLUID_MODE` block, `FACE_TEX` 0; `CARVABLE` true unless overridden.
 */
const terrain = (name: string, sound: Sound, tint: Tint, over: { readonly carvable?: boolean } = {}): BlockDef => ({
  name,
  opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: over.carvable ?? true, replaceable: false,
  collide: 'cube', fluidMode: 'block', tint, sound, faceTex: 0,
});

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
  // SP3c terrain palette (SP3c spec §2.1), state ids 3 … 24.
  terrain('grass_block', 'grass', 'grass'),
  terrain('dirt', 'dirt', 'none'),
  terrain('coarse_dirt', 'dirt', 'none'),
  terrain('podzol', 'dirt', 'none'),
  terrain('mud', 'dirt', 'none'),
  terrain('sand', 'sand', 'none'),
  terrain('red_sand', 'sand', 'none'),
  terrain('sandstone', 'stone', 'none'),
  terrain('red_sandstone', 'stone', 'none'),
  terrain('gravel', 'gravel', 'none'),
  terrain('clay', 'dirt', 'none'),
  terrain('calcite', 'stone', 'none'),
  terrain('snow_block', 'snow', 'none'),
  terrain('packed_ice', 'glass', 'none', { carvable: false }),
  terrain('deepslate', 'stone', 'none'),
  terrain('terracotta', 'stone', 'none'),
  terrain('white_terracotta', 'stone', 'none'),
  terrain('orange_terracotta', 'stone', 'none'),
  terrain('yellow_terracotta', 'stone', 'none'),
  terrain('brown_terracotta', 'stone', 'none'),
  terrain('red_terracotta', 'stone', 'none'),
  terrain('light_gray_terracotta', 'stone', 'none'),
]);

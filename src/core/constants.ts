/** Bumped whenever generated output changes; goldens and saves are bound to it (§6.2). */
export const GENERATOR_VERSION = 5;

/** World geometry (master §2.1): lowest block y, world height and sea level. */
export const MIN_Y = -64;
export const HEIGHT = 384;
export const SEA_LEVEL = 63;

/** Map tiles (SP2a spec §6.1): tile size in pixels and levels in blocks per pixel; 256 is the preview level. */
export const MAP_TILE_PX = 256;
export const MAP_LEVELS = [256, 64, 16, 4] as const;
export type MapLevel = (typeof MAP_LEVELS)[number];

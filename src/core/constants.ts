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

/**
 * Tier-1 bounds of a `json` leaf value (SP3d spec §1.7, `core/params/json.ts`): container depth (the value's top
 * container is 1), values counted at every visit, items per array, UTF-16 units per string, characters of the
 * canonical text (128 KiB), issues listed before one TOO_MANY_ISSUES, and the length of an object key
 * (`^[A-Za-z][A-Za-z0-9_]{0,31}$`). Shared by the tier-2 validators and the inspector.
 */
export const TREE_LIMITS = Object.freeze({
  depth: 48,
  values: 65_536,
  arrayItems: 1_024,
  stringUnits: 256,
  textUnits: 131_072,
  issues: 50,
  keyLength: 32,
});

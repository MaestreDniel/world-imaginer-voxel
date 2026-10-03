/**
 * Property kinds, enum codes and the face order of the block registry (SP3a spec §2.1, §2.2). Frozen from SP3a: a
 * code is the 0-based index of its value in the lists below, and no list ever changes (new kinds or tables append).
 */

/** The property kinds, in kind order. */
export const PROPERTY_KINDS = Object.freeze(['axis', 'facing4', 'facing6', 'half', 'open', 'hinge', 'slabType'] as const);
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/**
 * Each kind's values in kind order; a value's code is its index. Horizontal facings run clockwise seen from +y
 * (north = −z, east = +x, south = +z, west = −x), so a clockwise quarter turn adds 1 mod 4.
 */
export const KIND_VALUES: Readonly<Record<PropertyKind, readonly string[]>> = Object.freeze({
  axis: Object.freeze(['x', 'y', 'z']),
  facing4: Object.freeze(['north', 'east', 'south', 'west']),
  facing6: Object.freeze(['north', 'east', 'south', 'west', 'up', 'down']),
  half: Object.freeze(['bottom', 'top']),
  open: Object.freeze(['false', 'true']),
  hinge: Object.freeze(['left', 'right']),
  slabType: Object.freeze(['bottom', 'top', 'double']),
});

/** Faces: face i is the facing6 value i; `FULL_FACES` bit i is face i; `FACE_TEX[state·6 + i]` is face i's texture. */
export const FACE_NAMES = KIND_VALUES.facing6;
export const FACE_NORTH = 0;
export const FACE_EAST = 1;
export const FACE_SOUTH = 2;
export const FACE_WEST = 3;
export const FACE_UP = 4;
export const FACE_DOWN = 5;
export const FACE_COUNT = 6;
/** `FULL_FACES` of a full cube. */
export const ALL_FACES = 63;

/** Render pass (`PASS`). */
export const PASS_VALUES = Object.freeze(['none', 'opaque', 'cutout', 'translucent'] as const);
export type Pass = (typeof PASS_VALUES)[number];
export const PASS_NONE = 0;
export const PASS_OPAQUE = 1;
export const PASS_CUTOUT = 2;
export const PASS_TRANSLUCENT = 3;

/** Model shape (`SHAPE`); `none` is air's (SP3a spec §11 amends the master). */
export const SHAPE_VALUES = Object.freeze(['none', 'cube', 'cross', 'fluid', 'pointed', 'box'] as const);
export type Shape = (typeof SHAPE_VALUES)[number];
export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_FLUID = 3;
export const SHAPE_POINTED = 4;
export const SHAPE_BOX = 5;

/** Collision (`COLLIDE`). */
export const COLLIDE_VALUES = Object.freeze(['none', 'cube', 'boxes'] as const);
export type Collide = (typeof COLLIDE_VALUES)[number];
export const COLLIDE_NONE = 0;
export const COLLIDE_CUBE = 1;
export const COLLIDE_BOXES = 2;

/** How the block meets a fluid (`FLUID_MODE`). */
export const FLUID_MODE_VALUES = Object.freeze(['block', 'hold', 'displace'] as const);
export type FluidMode = (typeof FLUID_MODE_VALUES)[number];
export const FLUID_MODE_BLOCK = 0;
export const FLUID_MODE_HOLD = 1;
export const FLUID_MODE_DISPLACE = 2;

/** Colour tint (`TINT`). */
export const TINT_VALUES = Object.freeze(['none', 'grass', 'foliage', 'water', 'fixed'] as const);
export type Tint = (typeof TINT_VALUES)[number];
export const TINT_NONE = 0;
export const TINT_GRASS = 1;
export const TINT_FOLIAGE = 2;
export const TINT_WATER = 3;
export const TINT_FIXED = 4;

/** Step and break sound (`SOUND`); `none` is air's and never played (SP3a spec §11 amends the master). */
export const SOUND_VALUES = Object.freeze(['none', 'stone', 'dirt', 'grass', 'sand', 'gravel', 'wood', 'snow', 'glass', 'leaves', 'metal', 'abyss'] as const);
export type Sound = (typeof SOUND_VALUES)[number];
export const SOUND_NONE = 0;
export const SOUND_STONE = 1;
export const SOUND_DIRT = 2;
export const SOUND_GRASS = 3;
export const SOUND_SAND = 4;
export const SOUND_GRAVEL = 5;
export const SOUND_WOOD = 6;
export const SOUND_SNOW = 7;
export const SOUND_GLASS = 8;
export const SOUND_LEAVES = 9;
export const SOUND_METAL = 10;
export const SOUND_ABYSS = 11;

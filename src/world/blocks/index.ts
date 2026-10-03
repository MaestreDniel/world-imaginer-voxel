/**
 * The block registry of the game (SP3a spec §2.2): `REGISTRY = buildRegistry(BLOCK_DEFS)`, its per-state tables as
 * plain exports (hot code aliases them: `const OPAQ = OPACITY;`) and the state ids of the SP3a types. The tables are
 * never written after the build.
 */
import { BLOCK_DEFS } from './defs';
import { buildRegistry, type BlockRegistry } from './registry';

const build = buildRegistry;
const DEFS = BLOCK_DEFS;

export const REGISTRY: BlockRegistry = build(DEFS);

export const TYPE_NAMES = REGISTRY.TYPE_NAMES;
export const DEFAULT_STATE = REGISTRY.DEFAULT_STATE;
export const STATE_TYPE = REGISTRY.STATE_TYPE;
export const OPACITY = REGISTRY.OPACITY;
export const PASS = REGISTRY.PASS;
export const SHAPE = REGISTRY.SHAPE;
export const FULL_FACES = REGISTRY.FULL_FACES;
export const EMIT = REGISTRY.EMIT;
export const CARVABLE = REGISTRY.CARVABLE;
export const REPLACEABLE = REGISTRY.REPLACEABLE;
export const COLLIDE = REGISTRY.COLLIDE;
export const FLUID_MODE = REGISTRY.FLUID_MODE;
export const TINT = REGISTRY.TINT;
export const SOUND = REGISTRY.SOUND;
export const FACE_TEX = REGISTRY.FACE_TEX;

/** State ids (each type's only state); air is 0, which uniform-air descriptors and the meta word rely on. */
export const AIR: number = REGISTRY.parseStateKey('air');
export const STONE: number = REGISTRY.parseStateKey('stone');
export const BEDROCK: number = REGISTRY.parseStateKey('bedrock');

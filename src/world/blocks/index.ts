/**
 * The block registry of the game (SP3a spec §2.2): `REGISTRY = buildRegistry(BLOCK_DEFS)`, its per-state tables as
 * plain exports (hot code aliases them: `const OPAQ = OPACITY;`) and the state ids of the SP3a, SP3c and SP5a types.
 * The tables are never written after the build.
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

/** State ids of the SP3c terrain palette (SP3c spec §2.1), 3 … 24, in `BLOCK_DEFS` order. */
export const GRASS_BLOCK: number = REGISTRY.parseStateKey('grass_block');
export const DIRT: number = REGISTRY.parseStateKey('dirt');
export const COARSE_DIRT: number = REGISTRY.parseStateKey('coarse_dirt');
export const PODZOL: number = REGISTRY.parseStateKey('podzol');
export const MUD: number = REGISTRY.parseStateKey('mud');
export const SAND: number = REGISTRY.parseStateKey('sand');
export const RED_SAND: number = REGISTRY.parseStateKey('red_sand');
export const SANDSTONE: number = REGISTRY.parseStateKey('sandstone');
export const RED_SANDSTONE: number = REGISTRY.parseStateKey('red_sandstone');
export const GRAVEL: number = REGISTRY.parseStateKey('gravel');
export const CLAY: number = REGISTRY.parseStateKey('clay');
export const CALCITE: number = REGISTRY.parseStateKey('calcite');
export const SNOW_BLOCK: number = REGISTRY.parseStateKey('snow_block');
export const PACKED_ICE: number = REGISTRY.parseStateKey('packed_ice');
export const DEEPSLATE: number = REGISTRY.parseStateKey('deepslate');
export const TERRACOTTA: number = REGISTRY.parseStateKey('terracotta');
export const WHITE_TERRACOTTA: number = REGISTRY.parseStateKey('white_terracotta');
export const ORANGE_TERRACOTTA: number = REGISTRY.parseStateKey('orange_terracotta');
export const YELLOW_TERRACOTTA: number = REGISTRY.parseStateKey('yellow_terracotta');
export const BROWN_TERRACOTTA: number = REGISTRY.parseStateKey('brown_terracotta');
export const RED_TERRACOTTA: number = REGISTRY.parseStateKey('red_terracotta');
export const LIGHT_GRAY_TERRACOTTA: number = REGISTRY.parseStateKey('light_gray_terracotta');

/**
 * Default state ids of SP5a's appended types (SP5a spec §1.1), 25 … 57 in `BLOCK_DEFS` order: `oak_log` is axis y
 * (its other axes at 27 and 28), `wall_torch` and `ladder` face north (east, south and west follow).
 */
export const OAK_PLANKS: number = REGISTRY.parseStateKey('oak_planks');
export const OAK_LOG: number = REGISTRY.parseStateKey('oak_log[axis=y]');
export const COBBLESTONE: number = REGISTRY.parseStateKey('cobblestone');
export const BRICKS: number = REGISTRY.parseStateKey('bricks');
export const GLASS: number = REGISTRY.parseStateKey('glass');
export const TORCH: number = REGISTRY.parseStateKey('torch');
export const WALL_TORCH: number = REGISTRY.parseStateKey('wall_torch[facing=north]');
export const LADDER: number = REGISTRY.parseStateKey('ladder[facing=north]');
export const ICE: number = REGISTRY.parseStateKey('ice');
export const WHITE_WOOL: number = REGISTRY.parseStateKey('white_wool');
export const ORANGE_WOOL: number = REGISTRY.parseStateKey('orange_wool');
export const MAGENTA_WOOL: number = REGISTRY.parseStateKey('magenta_wool');
export const LIGHT_BLUE_WOOL: number = REGISTRY.parseStateKey('light_blue_wool');
export const YELLOW_WOOL: number = REGISTRY.parseStateKey('yellow_wool');
export const LIME_WOOL: number = REGISTRY.parseStateKey('lime_wool');
export const PINK_WOOL: number = REGISTRY.parseStateKey('pink_wool');
export const GRAY_WOOL: number = REGISTRY.parseStateKey('gray_wool');
export const LIGHT_GRAY_WOOL: number = REGISTRY.parseStateKey('light_gray_wool');
export const CYAN_WOOL: number = REGISTRY.parseStateKey('cyan_wool');
export const PURPLE_WOOL: number = REGISTRY.parseStateKey('purple_wool');
export const BLUE_WOOL: number = REGISTRY.parseStateKey('blue_wool');
export const BROWN_WOOL: number = REGISTRY.parseStateKey('brown_wool');
export const GREEN_WOOL: number = REGISTRY.parseStateKey('green_wool');
export const RED_WOOL: number = REGISTRY.parseStateKey('red_wool');
export const BLACK_WOOL: number = REGISTRY.parseStateKey('black_wool');

/**
 * Per-type block tags (SP5a spec §1.1; master §2.2): `PLACEABLE`, `CATEGORY`, `SLIPPERY`, `CLIMBABLE` and the display
 * name, indexed by type id (not by state). The tables are built once from the type names and never written after;
 * they are no registry table, so the SP3a registry digest (`metrics/sp3aGoldens.ts`), which hashes a fixed table
 * list, does not change.
 */
import { REGISTRY } from './index';

/** The palette category (`CATEGORY`); a code is the value's index. */
export const CATEGORY_VALUES = Object.freeze(['none', 'building', 'wool', 'terrain'] as const);
export type Category = (typeof CATEGORY_VALUES)[number];
export const CATEGORY_NONE = 0;
export const CATEGORY_BUILDING = 1;
export const CATEGORY_WOOL = 2;
export const CATEGORY_TERRAIN = 3;
/** The palette's groups, in display order (`none` is never shown). */
export const CATEGORY_ORDER: readonly ['building', 'wool', 'terrain'] = Object.freeze(['building', 'wool', 'terrain'] as const);

const REG = REGISTRY;
const NAMES = REG.TYPE_NAMES;
const TYPE_COUNT = REG.typeCount;

/** Types the player cannot pick from the palette or the hotbar: air, and the wall torch (a torch placed on a side). */
const NOT_PLACEABLE: ReadonlySet<string> = new Set(['air', 'wall_torch']);
const BUILDING: ReadonlySet<string> = new Set(['oak_planks', 'oak_log', 'cobblestone', 'bricks', 'glass', 'torch', 'ladder']);
const WOOL_SUFFIX = '_wool';
const SLIPPERY_NAMES: ReadonlySet<string> = new Set(['ice', 'packed_ice']);
const CLIMBABLE_NAMES: ReadonlySet<string> = new Set(['ladder']);

/** 1 when the type can be placed (every type but air and wall_torch). */
export const PLACEABLE = new Uint8Array(TYPE_COUNT);
/**
 * The type's `CATEGORY_VALUES` code: building (the 7 building types), wool (the 16 wools), none (air, wall_torch),
 * terrain (every other type: stone, bedrock, ice and the SP3c palette; a type appended later lands here unless named).
 */
export const CATEGORY = new Uint8Array(TYPE_COUNT);
/** 1 when walking on it slips 0.98 (ice, packed_ice). */
export const SLIPPERY = new Uint8Array(TYPE_COUNT);
/** 1 when the body climbs it (ladder). */
export const CLIMBABLE = new Uint8Array(TYPE_COUNT);
const DISPLAY_NAMES: string[] = [];

for (let t = 0; t < TYPE_COUNT; t++) {
  const name = NAMES[t]!;
  const placeable = !NOT_PLACEABLE.has(name);
  PLACEABLE[t] = placeable ? 1 : 0;
  CATEGORY[t] = !placeable ? CATEGORY_NONE : BUILDING.has(name) ? CATEGORY_BUILDING : name.endsWith(WOOL_SUFFIX) ? CATEGORY_WOOL : CATEGORY_TERRAIN;
  SLIPPERY[t] = SLIPPERY_NAMES.has(name) ? 1 : 0;
  CLIMBABLE[t] = CLIMBABLE_NAMES.has(name) ? 1 : 0;
  const spaced = name.replace(/_/g, ' ');
  DISPLAY_NAMES.push(spaced.charAt(0).toUpperCase() + spaced.slice(1));
}

/** The type name with `_` as a space and its first letter upper case: "Oak planks", "Light blue wool". */
export function displayName(typeId: number): string {
  const name = Number.isInteger(typeId) ? DISPLAY_NAMES[typeId] : undefined;
  if (name === undefined) throw new RangeError(`displayName: no block type ${typeId}`);
  return name;
}

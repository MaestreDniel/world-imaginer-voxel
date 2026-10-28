/**
 * The interaction rules (SP5a spec §4.2, D7): what a click does to the voxel the raycast (`raycast.ts`) aimed at, pure
 * over the hit and the store's reads inside the frame's second read section. Each rule returns the one `Edit` it makes,
 * its `expect` the voxel's value read now (§4.1), or null when it is refused; a refused action does nothing.
 * - **Break:** the hit voxel becomes air; a `hold` state leaves its fluid byte (a waterlogged ladder leaves water),
 *   anything else 0. Bedrock breaks.
 * - **Place** (a block slot): the voxel across the hit face, which must be air (with or without fluid) in y −64 … 319,
 *   in an editable column, and whose new state's collision box does not intersect the body (strictly: touching is
 *   not intersecting). Fluid: `block` clears it, `hold` keeps it, `displace` is refused in a fluid. State: `oak_log`'s
 *   axis is the hit face's; a torch on a top face is `torch`, on a side face `wall_torch` facing the face's normal, on
 *   a bottom face refused; a ladder on a side face faces the normal, on a top or bottom face the horizontal direction
 *   nearest the opposite of the look; every other type its default state (with its pinned props). No support checks.
 * - **Buckets** (a fluid slot): a still source (`WATER_SOURCE`, `LAVA_SOURCE`) into the voxel across the hit face when
 *   it is air (any fluid replaced); water also into the hit voxel itself when its state is `hold` (a ladder takes the
 *   water and stays); lava is refused there, and anything else is refused. **Empty bucket:** the first voxel with fluid
 *   on the ray (the raycast's `'fluid'` mode) loses it.
 * - **Pick:** the hit state's type name, `wall_torch` as `torch`.
 */
import { HEIGHT, MIN_Y } from '../core/constants';
import { hasFluid, LAVA_SOURCE, NO_FLUID, WATER_SOURCE } from '../world/blocks/fluid';
import { AIR, COLLIDE, FLUID_MODE, REGISTRY, STATE_TYPE } from '../world/blocks/index';
import {
  COLLIDE_NONE, FACE_DOWN, FACE_EAST, FACE_NAMES, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST, FLUID_MODE_BLOCK,
  FLUID_MODE_HOLD, KIND_VALUES,
} from '../world/blocks/kinds';
import type { VoxelStore } from '../world/store/store';
import type { Edit } from '../workers/protocol';
import type { RayHit } from './raycast';

/** A hotbar slot (SP5a spec §4.3, master §4.12): a block type by name (`pinned` is `{}` in SP5a), a fluid, or a tool. */
export type Slot =
  | { readonly type: string; readonly pinned: Readonly<Record<string, string>> }
  | { readonly fluid: 'water' | 'lava' }
  | { readonly tool: 'emptyBucket' };

/** The player's body as an axis-aligned box in world blocks. */
export interface BodyBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** The body: 0.6 wide, 1.8 tall, the eye 1.62 above the feet, so the top is 0.18 above the eye (SP5a spec §3.2, §4.2). */
const HALF_WIDTH = 0.3;
const EYE_ABOVE_FEET = 1.62;
const TOP_ABOVE_EYE = 0.18;
const TOP_Y = MIN_Y + HEIGHT - 1;

/** The store's reads the rules make (the frame's `aim` reader). */
type Read = Pick<VoxelStore, 'blockAt' | 'fluidAt'>;

const TORCH_TYPE = REGISTRY.typeId('torch');
const WALL_TORCH_TYPE = REGISTRY.typeId('wall_torch');
const LADDER_TYPE = REGISTRY.typeId('ladder');
const OAK_LOG_TYPE = REGISTRY.typeId('oak_log');
const FACING4 = KIND_VALUES.facing4;

/**
 * Writes the body of an eye at (eyeX, eyeY, eyeZ) into `out` (returned): 0.6 × 1.8 with its top 0.18 above the eye,
 * the same box walking and flying (ruling R23; while walking the page passes the current tick's eye).
 */
export function bodyOf(_mode: 'walk' | 'fly', eyeX: number, eyeY: number, eyeZ: number, out: BodyBox): BodyBox {
  out.minX = eyeX - HALF_WIDTH;
  out.maxX = eyeX + HALF_WIDTH;
  out.minY = eyeY - EYE_ABOVE_FEET;
  out.maxY = eyeY + TOP_ABOVE_EYE;
  out.minZ = eyeZ - HALF_WIDTH;
  out.maxZ = eyeZ + HALF_WIDTH;
  return out;
}

/** The voxel's value (`state << 8 | fluid`), or −1 in a column that is not Published. */
function valueAt(read: Read, x: number, y: number, z: number): number {
  const s = read.blockAt(x, y, z);
  return s < 0 ? -1 : ((s << 8) | read.fluidAt(x, y, z)) >>> 0;
}

function setEdit(x: number, y: number, z: number, state: number, fluid: number, expect: number): Edit {
  return { x, y, z, op: 'set', value: ((state << 8) | fluid) >>> 0, expect };
}

/** The hit voxel becomes air; a `hold` state leaves its fluid (spec §4.2). Null with no hit. */
export function breakAt(hit: RayHit, read: Read): Edit | null {
  if (!hit.hit) return null;
  const { x, y, z } = hit;
  const expect = valueAt(read, x, y, z);
  if (expect < 0) return null;
  const state = expect >>> 8;
  if (state === AIR) return null;
  return setEdit(x, y, z, AIR, FLUID_MODE[state] === FLUID_MODE_HOLD ? expect & 255 : NO_FLUID, expect);
}

/** The voxel across the hit face: the face's normal added to the hit voxel. */
function across(hit: RayHit): [number, number, number] {
  const f = hit.face;
  return [
    hit.x + (f === FACE_EAST ? 1 : f === FACE_WEST ? -1 : 0),
    hit.y + (f === FACE_UP ? 1 : f === FACE_DOWN ? -1 : 0),
    hit.z + (f === FACE_SOUTH ? 1 : f === FACE_NORTH ? -1 : 0),
  ];
}

/** The horizontal facing nearest the opposite of the look (yaw 0 north, 90 east). */
function facingAgainst(lookYawDeg: number): string {
  const opposite = (((lookYawDeg + 180) % 360) + 360) % 360;
  return FACING4[Math.round(opposite / 90) % 4]!;
}

/** The state a block slot places against the hit face (spec §4.2), or −1 when the face refuses it. */
function placedState(slot: { readonly type: string; readonly pinned: Readonly<Record<string, string>> }, face: number,
  lookYawDeg: number): number {
  const type = REGISTRY.typeId(slot.type);
  const side = face !== FACE_UP && face !== FACE_DOWN;
  // A torch (a slot holds `torch`, pick turns `wall_torch` into it) stands on a top face and hangs on a side face.
  if (type === TORCH_TYPE || type === WALL_TORCH_TYPE) {
    if (face === FACE_DOWN) return -1;
    if (side) return REGISTRY.stateOf(WALL_TORCH_TYPE, { ...slot.pinned, facing: FACE_NAMES[face]! });
    return REGISTRY.stateOf(TORCH_TYPE, slot.pinned);
  }
  if (type === LADDER_TYPE) {
    return REGISTRY.stateOf(LADDER_TYPE, { ...slot.pinned, facing: side ? FACE_NAMES[face]! : facingAgainst(lookYawDeg) });
  }
  if (type === OAK_LOG_TYPE) {
    const axis = face === FACE_EAST || face === FACE_WEST ? 'x' : side ? 'z' : 'y';
    return REGISTRY.stateOf(OAK_LOG_TYPE, { ...slot.pinned, axis });
  }
  return REGISTRY.stateOf(type, slot.pinned);
}

/** True when the cell (x, y, z) and the body overlap with positive volume (a shared face is not an overlap). */
function cellIntersects(x: number, y: number, z: number, b: BodyBox): boolean {
  return b.minX < x + 1 && b.maxX > x && b.minY < y + 1 && b.maxY > y && b.minZ < z + 1 && b.maxZ > z;
}

/**
 * What the active slot does against the hit (spec §4.2): a block placed across the hit face, or a bucket's source.
 * The empty bucket is `emptyBucketAt`'s (it aims with the raycast's `'fluid'` mode), so its slot gives null here.
 * `editable(cx, cz)` is the column gate (the page: `editState === 0`).
 */
export function placeAt(hit: RayHit, slot: Slot, lookYawDeg: number, body: BodyBox, read: Read,
  editable: (cx: number, cz: number) => boolean): Edit | null {
  if (!hit.hit || 'tool' in slot) return null;
  if ('fluid' in slot) {
    // Water into a `hold` state waterlogs the hit voxel itself; lava is refused there.
    if (FLUID_MODE[hit.state] === FLUID_MODE_HOLD) {
      if (slot.fluid !== 'water') return null;
      return target(hit.x, hit.y, hit.z, read, editable, (s) => (FLUID_MODE[s] === FLUID_MODE_HOLD ? s : -1), WATER_SOURCE);
    }
    const [x, y, z] = across(hit);
    return target(x, y, z, read, editable, (s) => (s === AIR ? AIR : -1), slot.fluid === 'water' ? WATER_SOURCE : LAVA_SOURCE);
  }
  const state = placedState(slot, hit.face, lookYawDeg);
  if (state < 0) return null;
  const [x, y, z] = across(hit);
  if (COLLIDE[state] !== COLLIDE_NONE && cellIntersects(x, y, z, body)) return null;
  const mode = FLUID_MODE[state];
  return target(x, y, z, read, editable, (s) => (s === AIR ? state : -1),
    (f) => (mode === FLUID_MODE_BLOCK ? NO_FLUID : mode === FLUID_MODE_HOLD ? f : hasFluid(f) ? -1 : NO_FLUID));
}

/**
 * The edit of voxel (x, y, z) inside the world's rows and an editable column: `state(s)` maps its current state to the
 * new one, `fluid` is the new fluid byte (or a map of the current one); either gives −1 to refuse.
 */
function target(x: number, y: number, z: number, read: Read, editable: (cx: number, cz: number) => boolean,
  state: (s: number) => number, fluid: number | ((f: number) => number)): Edit | null {
  if (y < MIN_Y || y > TOP_Y || !editable(x >> 4, z >> 4)) return null;
  const expect = valueAt(read, x, y, z);
  if (expect < 0) return null;
  const s = state(expect >>> 8);
  if (s < 0) return null;
  const f = typeof fluid === 'number' ? fluid : fluid(expect & 255);
  if (f < 0) return null;
  return setEdit(x, y, z, s, f, expect);
}

/** The empty bucket (spec §4.2): the voxel the raycast's `'fluid'` mode hit loses its fluid. Null with no hit. */
export function emptyBucketAt(fluidHit: RayHit, read: Read): Edit | null {
  if (!fluidHit.hit) return null;
  const { x, y, z } = fluidHit;
  const expect = valueAt(read, x, y, z);
  if (expect < 0 || !hasFluid(expect & 255)) return null;
  return setEdit(x, y, z, expect >>> 8, NO_FLUID, expect);
}

/** The hit state's type name (`wall_torch` → `torch`), or null with no hit (spec §4.2; fluids cannot be picked). */
export function pickAt(hit: RayHit): string | null {
  if (!hit.hit || hit.state === AIR) return null;
  const type = STATE_TYPE[hit.state]!;
  return REGISTRY.typeName(type === WALL_TORCH_TYPE ? TORCH_TYPE : type);
}

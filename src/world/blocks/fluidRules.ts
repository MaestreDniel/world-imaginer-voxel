/**
 * The fluid rules shared by the gen-time settle, its global reference, A2 and SP7b's sim, and the fluid surface and
 * corner heights shared by the mesher, the eye test and the walk (SP7a spec §4.1, §6.1, §6.2, D22). Every function is
 * pure and allocation-free (the nearest-drop search runs on module scratch).
 *
 * Levels: water 0 (source) … 7, +1 per block sideways; lava 0, 2, 4, 6, +2 per block (`core/constants.ts`' `FLUID_*`).
 * The settle orders a voxel's candidate values source < falling < flowing 1 … last < dry and keeps the least; its value
 * encoding is `FLUID_VALUE_SOURCE` 0, `FLUID_VALUE_FALLING` 1, flowing level k as 1 + k, and `FLUID_VALUE_DRY` 9 above
 * every fluid value. A voxel holding the other type's proto fluid is `block` for a type's rules (the two fixed points
 * never mix); a water front enters abyss air as any other (D4 as amended, rulings R23: no abyss stop).
 */
import {
  CORNER_DRY, CORNER_FULL, CORNER_SOLID, FLUID_CAP_LAVA, FLUID_CAP_WATER, FLUID_LAST_LEVEL_LAVA, FLUID_LAST_LEVEL_WATER,
  FLUID_SEARCH_LAVA, FLUID_SEARCH_WATER, FLUID_STEP_LAVA, FLUID_STEP_WATER,
} from '../../core/constants';
import { FLUID_LAVA, FLUID_NONE, FLUID_WATER, fluidFalling, fluidLevel, fluidType } from './fluid';
import { AIR, FLUID_MODE } from './index';
import { FLUID_MODE_BLOCK } from './kinds';

// Imported values are read through top-level aliases (hot modules: vitest turns an import binding into a getter).
const DRY = CORNER_DRY;
const FULL = CORNER_FULL;
const SOLID = CORNER_SOLID;
const CAP_WATER = FLUID_CAP_WATER;
const CAP_LAVA = FLUID_CAP_LAVA;
const LAST_WATER = FLUID_LAST_LEVEL_WATER;
const LAST_LAVA = FLUID_LAST_LEVEL_LAVA;
const SEARCH_WATER = FLUID_SEARCH_WATER;
const SEARCH_LAVA = FLUID_SEARCH_LAVA;
const STEP_WATER = FLUID_STEP_WATER;
const STEP_LAVA = FLUID_STEP_LAVA;
const LAVA = FLUID_LAVA;
const NONE = FLUID_NONE;
const WATER = FLUID_WATER;
const isFalling = fluidFalling;
const levelOf = fluidLevel;
const typeOf = fluidType;
const AIR_STATE = AIR;
const MODES = FLUID_MODE;
const MODE_BLOCK = FLUID_MODE_BLOCK;

/** The settle's value of a source (the least). */
export const FLUID_VALUE_SOURCE = 0;
/** The settle's value of a falling voxel (above a source, below every flowing level 1 + k). */
export const FLUID_VALUE_FALLING = 1;
/** Above every fluid value (water's last 1 + 7, lava's 1 + 6): a voxel no feeder reached. */
export const FLUID_VALUE_DRY = 9;

/** The horizontal sides in `FACES` order (N −z, E +x, S +z, W −x); mask bit i is side i. */
const SIDE_DX = [0, 1, 0, -1] as const;
const SIDE_DZ = [-1, 0, 1, 0] as const;

/** Fluid passes a state when it is AIR or its `FLUID_MODE` is `hold` or `displace` (D22: `block` stops fluid). */
export function isPassable(state: number, modes: ArrayLike<number> = MODES): boolean {
  return state === AIR_STATE || modes[state] !== MODE_BLOCK;
}

/** The horizontal distance cap of a front (water 12, lava 14). */
export function capOf(type: number): number { return type === LAVA ? CAP_LAVA : CAP_WATER; }
/** The nearest-drop search reach (water 4, lava 2). */
export function searchOf(type: number): number { return type === LAVA ? SEARCH_LAVA : SEARCH_WATER; }
/** The level step per block sideways (water 1, lava 2). */
export function stepOf(type: number): number { return type === LAVA ? STEP_LAVA : STEP_WATER; }
/** The last level a spread reaches (water 7, lava 6). */
export function lastLevelOf(type: number): number { return type === LAVA ? LAST_LAVA : LAST_WATER; }

/** The level one block sideways from `level`, or −1 past the last level (water 7 → −1; lava 0 → 2 → 4 → 6 → −1). */
export function nextLevel(type: number, level: number): number {
  const next = level + stepOf(type);
  return next > lastLevelOf(type) ? -1 : next;
}

/**
 * A fluid voxel's surface height (SP7a spec §6.1): 1 when the same fluid is directly above (`sameAbove`) or the byte is
 * falling; else (8 − level)/9 (a source 8/9; lava's levels 0, 2, 4, 6 give 8/9, 6/9, 4/9, 2/9).
 */
export function surfaceHeight(byte: number, sameAbove: boolean): number {
  return sameAbove || isFalling(byte) ? 1 : (8 - levelOf(byte)) / 9;
}

/**
 * A top corner's height from the up to 4 voxels around it (SP7a spec §6.1, Minecraft's average, **MC (memory)**): each
 * a fluid height or a code (`CORNER_DRY`, `CORNER_SOLID`, `CORNER_FULL`). 1 if any is `CORNER_FULL`; else the weighted
 * mean, a height ≥ 0.8 weighing 10, any other fluid height 1, `CORNER_DRY` height 0 with weight 1, `CORNER_SOLID` not
 * counted (all solid: 0). A function of its 4 voxels only, so neighbouring quads share their corners exactly.
 */
export function cornerHeight(h0: number, h1: number, h2: number, h3: number): number {
  if (h0 === FULL || h1 === FULL || h2 === FULL || h3 === FULL) return 1;
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < 4; i++) {
    const h = i === 0 ? h0 : i === 1 ? h1 : i === 2 ? h2 : h3;
    if (h === SOLID) continue;
    if (h === DRY) weight += 1;
    else if (h >= 0.8) { sum += 10 * h; weight += 10; }
    else { sum += h; weight += 1; }
  }
  return weight === 0 ? 0 : sum / weight;
}

/** A corner's drop below the voxel's top in ninths (SP7a spec §6.1): round((1 − h)·9), clamped to 0 … 8. */
export function cornerDrop(h: number): number {
  const d = Math.round((1 - h) * 9);
  return d < 0 ? 0 : d > 8 ? 8 : d;
}

/**
 * A sloped top's split (SP7a spec §6.2, a fixed rule from the corner values, so neighbours agree): true when the
 * diagonal v0-v2 joins the two corners with the lower summed height, ties to v0-v2.
 */
export function splitV0V2(h0: number, h1: number, h2: number, h3: number): boolean {
  return h0 + h2 <= h1 + h3;
}

/** Whether fluid passes a voxel; `passable` reads false outside the caller's window. */
export interface PassableReader { passable(x: number, y: number, z: number): boolean }

/**
 * The proto reads every rule decides on, blocks (`passable`) and the proto fluid byte, plus the cave biome nibble (bits
 * 4-7 of the `cave` byte, `caveBiomeOf`) at world voxels, which no rule reads since the abyss stop was withdrawn (rulings
 * R23).
 */
export interface FluidRuleReader extends PassableReader {
  protoFluid(x: number, y: number, z: number): number;
  nibble(x: number, y: number, z: number): number;
}

/**
 * Whether a type's fluid passes a voxel: passable, and (with `other` a fluid type) not holding `other`'s proto fluid,
 * which is `block` for the type's rules. `other` NONE reads `passable` alone (a plain `PassableReader`).
 */
function openFor(r: PassableReader, other: number, x: number, y: number, z: number): boolean {
  if (!r.passable(x, y, z)) return false;
  return other === NONE || typeOf((r as FluidRuleReader).protoFluid(x, y, z)) !== other;
}

/** A proto byte holding a source of `type` (level 0, not falling). */
function isSourceOf(byte: number, type: number): boolean {
  return typeOf(byte) === type && levelOf(byte) === 0 && !isFalling(byte);
}

// The breadth-first search's scratch: cells of the (2R + 1)² square around the voxel, R the larger search reach (every
// cell within the reach's Manhattan distance lies in it). `bfsDist` is −1 for an unvisited cell and reset after each
// search from the queue, which lists every visited cell.
const BFS_R = Math.max(SEARCH_WATER, SEARCH_LAVA);
const BFS_SIDE = 2 * BFS_R + 1;
const bfsDist = new Int8Array(BFS_SIDE * BFS_SIDE).fill(-1);
const bfsMask = new Uint8Array(BFS_SIDE * BFS_SIDE);
const bfsQueue = new Int32Array(BFS_SIDE * BFS_SIDE);

/**
 * Whether the nearest-drop search may enter a voxel (SP7a spec §4.1; rulings R21): open for the type, and (with `other`
 * a fluid type, so `r` reads the proto) not holding a proto source of `type`, which the search neither walks through nor
 * takes as a first side (Minecraft's slope search, **MC (memory)**). Flowing and falling proto bytes are walked through.
 */
function searchable(r: PassableReader, type: number, other: number, x: number, y: number, z: number): boolean {
  if (!r.passable(x, y, z)) return false;
  if (other === NONE) return true;
  const byte = (r as FluidRuleReader).protoFluid(x, y, z);
  return typeOf(byte) !== other && !isSourceOf(byte, type);
}

/** `nearestDropDirs` over the voxels `searchable(r, type, other, …)`, the drop test `openFor(r, other, …)` below each. */
function dropDirs(type: number, r: PassableReader, other: number, x: number, y: number, z: number): number {
  const reach = searchOf(type);
  const center = BFS_R * BFS_SIDE + BFS_R;
  bfsDist[center] = 0;
  bfsMask[center] = 0;
  bfsQueue[0] = center;
  let tail = 1;
  for (let f = 0; f < 4; f++) {
    const dx = SIDE_DX[f]!;
    const dz = SIDE_DZ[f]!;
    if (!searchable(r, type, other, x + dx, y, z + dz)) continue;
    const c = center + dz * BFS_SIDE + dx;
    bfsDist[c] = 1;
    bfsMask[c] = 1 << f;
    bfsQueue[tail++] = c;
  }
  let result = 0;
  let head = 1;
  for (let d = 1; head < tail; d++) {
    const layerEnd = tail;
    // A drop on layer d: a searched voxel whose voxel below is open for the type (the type's own proto fluid there
    // included); its mask holds the sides it is reached from at d.
    for (let i = head; i < layerEnd; i++) {
      const c = bfsQueue[i]!;
      const cx = x + (c % BFS_SIDE) - BFS_R;
      const cz = z + ((c / BFS_SIDE) | 0) - BFS_R;
      if (openFor(r, other, cx, y - 1, cz)) result |= bfsMask[c]!;
    }
    if (result !== 0 || d === reach) break;
    for (let i = head; i < layerEnd; i++) {
      const c = bfsQueue[i]!;
      const cx = x + (c % BFS_SIDE) - BFS_R;
      const cz = z + ((c / BFS_SIDE) | 0) - BFS_R;
      for (let f = 0; f < 4; f++) {
        const dx = SIDE_DX[f]!;
        const dz = SIDE_DZ[f]!;
        const n = c + dz * BFS_SIDE + dx;
        const nd = bfsDist[n]!;
        if (nd === -1) {
          if (!searchable(r, type, other, cx + dx, y, cz + dz)) continue;
          bfsDist[n] = d + 1;
          bfsMask[n] = bfsMask[c]!;
          bfsQueue[tail++] = n;
        } else if (nd === d + 1) {
          bfsMask[n] = bfsMask[n]! | bfsMask[c]!;
        }
      }
    }
    head = layerEnd;
  }
  for (let i = 0; i < tail; i++) bfsDist[bfsQueue[i]!] = -1;
  return result;
}

/**
 * The open sides toward the nearest drop over blocks alone (SP7a spec §4.1): the 4-bit mask (N, E, S, W in `FACES`
 * order) of the passable sides at minimal breadth-first distance, over passable voxels at y (never through the voxel
 * itself), to a drop (a passable voxel with a passable voxel below), within `searchOf(type)` (a side is at distance 1);
 * 0 when none is in reach (the caller then takes every open side). A `PassableReader` holds no proto fluid, so there is
 * no source to skip; a caller that must agree with the settle reads the proto through `nearestDropDirsFor`.
 */
export function nearestDropDirs(type: number, r: PassableReader, x: number, y: number, z: number): number {
  return dropDirs(type, r, NONE, x, y, z);
}

/**
 * The sides `ruleOffers`' spread takes toward the nearest drop, over the proto (SP7a spec §4.1, D22; rulings R21): as
 * `nearestDropDirs`, but a voxel holding the other type's proto fluid is `block`, and a voxel holding a proto source of
 * `type` is neither a first side nor walked through; a drop is a searched voxel whose voxel below is open for the type
 * (its own proto fluid there counts). 0 when none is in reach. The settle, the reference, A2, C7.waterWall's
 * `spreadSides` and SP7b's sim all read this search, never a copy of it.
 */
export function nearestDropDirsFor(type: number, r: FluidRuleReader, x: number, y: number, z: number): number {
  return dropDirs(type, r, type === WATER ? LAVA : WATER, x, y, z);
}

/** Writes one offer tuple at tuple index n. */
function put(out: Int32Array, n: number, dx: number, dy: number, dz: number, value: number, dist: number): void {
  const o = n * 5;
  out[o] = dx;
  out[o + 1] = dy;
  out[o + 2] = dz;
  out[o + 3] = value;
  out[o + 4] = dist;
}

/**
 * One application of §4.1's rules at a voxel u holding (`value`, `dist`) of `type` (SP7a spec §4.1, D22): writes u's
 * offers into `out` as 5-int tuples (dx, dy, dz, value, dist), at most 9 (the fall, four spreads, four new sources;
 * rulings P2: `out` holds 45 ints), and returns their count, plus 16 when u sits at the cap with a passable spread
 * target (u's `unsettled`). Every fluid read is the proto's (`r.protoFluid`); a voxel holding the other type's proto
 * fluid is `block`; abyss air is no exception (rulings R23).
 * - **Fall:** the voxel below, when passable and not a proto source of `type`: (falling, dist).
 * - **Spread:** when u is a source, or its voxel below is not passable or holds `type` in the proto: level k (0 for a
 *   source or falling u, its level otherwise) spreads `nextLevel(type, k)` at dist + 1 to the sides in
 *   `nearestDropDirsFor` (its search skips the type's own proto sources; every open side when 0); at the cap nothing
 *   spreads, and u is flagged when a target exists.
 * - **New sources** (water, when u is a proto water source): each passable proto-dry side with ≥ 2 horizontal proto
 *   water sources beside it (u among them) and a solid voxel or a proto water source below: (source, dist + 1).
 * The settle, its reference and A2 call this, never a copy of the rules; SP7b's sim applies it to a scheduled voxel.
 */
export function ruleOffers(type: number, r: FluidRuleReader, x: number, y: number, z: number, value: number, dist: number, out: Int32Array): number {
  const water = type === WATER;
  const other = water ? LAVA : WATER;
  let n = 0;
  let flags = 0;
  const belowOpen = openFor(r, other, x, y - 1, z);
  const belowProto = r.protoFluid(x, y - 1, z);
  const belowHolds = typeOf(belowProto) === type;
  if (belowOpen && !(belowHolds && isSourceOf(belowProto, type))) {
    put(out, n++, 0, -1, 0, FLUID_VALUE_FALLING, dist);
  }
  if (value === FLUID_VALUE_SOURCE || !belowOpen || belowHolds) {
    const next = nextLevel(type, value <= FLUID_VALUE_FALLING ? 0 : value - 1);
    if (next >= 0) {
      const dirs = dropDirs(type, r, other, x, y, z);
      let targets = 0;
      for (let f = 0; f < 4; f++) {
        const sx = x + SIDE_DX[f]!;
        const sz = z + SIDE_DZ[f]!;
        if (dirs === 0 ? !openFor(r, other, sx, y, sz) : (dirs & (1 << f)) === 0) continue;
        targets |= 1 << f;
      }
      if (targets !== 0) {
        if (dist >= capOf(type)) flags = 16;
        else for (let f = 0; f < 4; f++) if ((targets & (1 << f)) !== 0) put(out, n++, SIDE_DX[f]!, 0, SIDE_DZ[f]!, 1 + next, dist + 1);
      }
    }
  }
  if (water && isSourceOf(r.protoFluid(x, y, z), WATER)) {
    for (let f = 0; f < 4; f++) {
      const tx = x + SIDE_DX[f]!;
      const tz = z + SIDE_DZ[f]!;
      if (!openFor(r, other, tx, y, tz) || typeOf(r.protoFluid(tx, y, tz)) !== NONE) continue;
      if (openFor(r, other, tx, y - 1, tz) && !isSourceOf(r.protoFluid(tx, y - 1, tz), WATER)) continue;
      let sources = 0;
      for (let g = 0; g < 4; g++) if (isSourceOf(r.protoFluid(tx + SIDE_DX[g]!, y, tz + SIDE_DZ[g]!), WATER)) sources++;
      if (sources >= 2) put(out, n++, SIDE_DX[f]!, 0, SIDE_DZ[f]!, FLUID_VALUE_SOURCE, dist + 1);
    }
  }
  return n + flags;
}

/**
 * The final heightmaps of a column (SP4a spec §3.2, master §2.3): written by the D stage into aux A over the final
 * blocks and fluid. A value is the absolute y of the highest qualifying voxel plus one, −64 (MIN_Y) when none
 * qualifies, found by one top-down scan per position:
 * - `WORLD_SURFACE`: state ≠ air or fluid type ≠ 0;
 * - `OCEAN_FLOOR`: `COLLIDE[state]` ≠ none (the fluid byte is ignored);
 * - `MOTION_BLOCKING`: `COLLIDE[state]` ≠ none or fluid type ≠ 0;
 * - `LIGHT_BLOCKING`: the highest voxel the straight sky fall does not enter (`fallBlocked`, SP4a spec §4.1's
 *   predicate N; the voxel above y 319 is air).
 * The `_WG` maps, `surfaceBiome` and `tintTH` are left alone. `patchHeightmaps` rescans one block column after an
 * edit (SP5a spec §2.2) with the same scan. Follows the gen determinism rules.
 */
import { MIN_Y } from '../../core/constants';
import { fluidType } from '../../world/blocks/fluid';
import { AIR, COLLIDE } from '../../world/blocks/index';
import { COLLIDE_NONE } from '../../world/blocks/kinds';
import { fallBlocked } from '../../world/blocks/light';
import type { AuxView as AuxViewT } from '../../world/store/api';

const Y0 = MIN_Y;
const AIR_ = AIR;
const COLL = COLLIDE;
const NO_COLLIDE = COLLIDE_NONE;
const typeOf = fluidType;
const FALL_BLOCKED = fallBlocked;

/** Highest y of the world (MIN_Y + 384 − 1). */
const TOP_Y = Y0 + 383;

/**
 * Scans block column (lx, lz) from `top` down to −64 until all four maps are found, and stores them. `above` is the
 * state of the voxel above `top` (predicate N reads it; air above y 319).
 */
function scanColumn(
  blockAt: (lx: number, y: number, lz: number) => number,
  fluidAt: (lx: number, y: number, lz: number) => number,
  aux: AuxViewT,
  lx: number,
  lz: number,
  top: number,
  above: number,
): void {
  const none = Y0;
  let ws = none;
  let of = none;
  let mb = none;
  let lb = none;
  for (let y = top; y >= Y0 && (ws === none || of === none || mb === none || lb === none); y--) {
    const s = blockAt(lx, y, lz);
    const f = fluidAt(lx, y, lz);
    const wet = typeOf(f) !== 0;
    const collides = COLL[s] !== NO_COLLIDE;
    if (ws === none && (s !== AIR_ || wet)) ws = y + 1;
    if (of === none && collides) of = y + 1;
    if (mb === none && (collides || wet)) mb = y + 1;
    if (lb === none && FALL_BLOCKED(s, f, above)) lb = y + 1;
    above = s;
  }
  const p = (lz << 4) | lx;
  aux.worldSurface[p] = ws;
  aux.oceanFloor[p] = of;
  aux.motionBlocking[p] = mb;
  aux.lightBlocking[p] = lb;
}

/**
 * Writes `worldSurface`, `oceanFloor`, `motionBlocking` and `lightBlocking` of `aux` at every column index
 * `lz·16 + lx`, scanning y 319 down to −64 through `blockAt` and `fluidAt` (local x, absolute y, local z) until all
 * four are found.
 */
export function writeFinalHeightmaps(
  blockAt: (lx: number, y: number, lz: number) => number,
  fluidAt: (lx: number, y: number, lz: number) => number,
  aux: AuxViewT,
): void {
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) scanColumn(blockAt, fluidAt, aux, lx, lz, TOP_Y, AIR_);
  }
}

/**
 * Rescans the four maps of block column (lx, lz) after an edit (SP5a spec §2.2), top down from `fromY` with the
 * predicates above, in place in `aux` (element-wise Int16 stores: the one in-place write on the edit path, spec §5).
 * `fromY` (−64 … 319, else `RangeError`) is the caller's min(319, max(edited y, each old map − 1)): no voxel above it
 * qualifies before or after the edit, so the scan from it finds the full scan's values. Predicate N's first `above`
 * is the voxel at `fromY + 1`, or air when `fromY` is 319; no y above 319 is read.
 */
export function patchHeightmaps(
  blockAt: (lx: number, y: number, lz: number) => number,
  fluidAt: (lx: number, y: number, lz: number) => number,
  aux: AuxViewT,
  lx: number,
  lz: number,
  fromY: number,
): void {
  if ((fromY | 0) !== fromY || fromY < Y0 || fromY > TOP_Y) throw new RangeError(`patchHeightmaps: fromY ${fromY} outside ${Y0} … ${TOP_Y}`);
  if ((lx & 15) !== lx || (lz & 15) !== lz) throw new RangeError(`patchHeightmaps: block column (${lx}, ${lz}) outside the column`);
  scanColumn(blockAt, fluidAt, aux, lx, lz, fromY, fromY === TOP_Y ? AIR_ : blockAt(lx, fromY + 1, lz));
}

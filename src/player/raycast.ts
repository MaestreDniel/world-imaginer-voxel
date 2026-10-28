/**
 * The block raycast (SP5a spec §3.5, D8): an Amanatides-Woo DDA from the eye along the look (`lookVectorInto`), up to
 * `REACH_WALK` blocks walking or `REACH_FLY` flying, over the store's view-free reads (`blockAt`, `fluidAt`), inside
 * the frame's second read section. Two modes:
 * - `'block'` (break, place, pick) passes through air and fluids and hits any other state: a `SHAPE` box state where
 *   the ray meets its provisional box (`world/blocks/provisionalBoxes.ts`, §1.3; a ray past the box goes on), any
 *   other state where the ray enters its cell.
 * - `'fluid'` (the empty bucket, §4.2) stops at the first voxel with fluid before any block (a waterlogged ladder
 *   included, the whole cell) and misses at the first other non-air state, a box state where the ray meets its box.
 *
 * In both modes a −1 read (an unpublished column) ends the ray with no hit, and so does a cell below the world's floor
 * (y −64): the store reads `BEDROCK` there (its padded border), which is no voxel an edit can reach. A hit reports
 * the voxel, the face the ray entered by (`FACE_*`: a ray moving +x enters by the west face), the point and the state.
 * An eye inside a hit (a full cell or a box holding the eye) hits at the eye, by the face the look's main axis enters
 * (the face looking back along it). Allocates nothing: the result goes into the caller's one reused `RayHit`.
 */
import { MIN_Y } from '../core/constants';
import { hasFluid } from '../world/blocks/fluid';
import { AIR, SHAPE } from '../world/blocks/index';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST, SHAPE_BOX } from '../world/blocks/kinds';
import { boxOf } from '../world/blocks/provisionalBoxes';
import type { VoxelStore } from '../world/store/store';

/** Blocks of reach walking and flying (SP5a spec §3.5). */
export const REACH_WALK = 6;
export const REACH_FLY = 10;

/** The raycast's result, one object the caller reuses. Only `hit` is meaningful after a miss. */
export interface RayHit {
  hit: boolean;
  /** The hit voxel. */
  x: number;
  y: number;
  z: number;
  /** `FACE_*` of the hit face. */
  face: number;
  /** The hit point. */
  px: number;
  py: number;
  pz: number;
  /** The hit voxel's state. */
  state: number;
}

/** A `RayHit` to reuse; the point's fields start as doubles, so writing a hit point never changes the object's shape. */
export function createRayHit(): RayHit {
  return { hit: false, x: 0, y: 0, z: 0, face: FACE_UP, px: 0.5, py: 0.5, pz: 0.5, state: AIR };
}

const AIR_ = AIR;
const SHAPE_ = SHAPE;
const BOX_ = SHAPE_BOX;
const BOX_OF = boxOf;
const HAS_FLUID = hasFluid;
const FLOOR = MIN_Y;
/** The box of the current box state, in eighths (`boxOf`'s output). */
const box = new Uint8Array(6);
/** The face `boxEntry` found, beside its returned distance. */
let boxFace = 0;

/**
 * Where the ray o + t·d meets the box (x0 … x1, y0 … y1, z0 … z1, world blocks): t ≥ 0, or −1 when it misses it. A
 * box holding o gives 0 and `startFace`; otherwise `boxFace` is the face the ray enters by.
 */
function boxEntry(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, startFace: number,
): number {
  let near = -Infinity;
  let far = Infinity;
  let face = startFace;
  if (dx === 0) {
    if (ox < x0 || ox > x1) return -1;
  } else {
    const a = ((dx > 0 ? x0 : x1) - ox) / dx;
    const b = ((dx > 0 ? x1 : x0) - ox) / dx;
    if (a > near) { near = a; face = dx > 0 ? FACE_WEST : FACE_EAST; }
    if (b < far) far = b;
  }
  if (dy === 0) {
    if (oy < y0 || oy > y1) return -1;
  } else {
    const a = ((dy > 0 ? y0 : y1) - oy) / dy;
    const b = ((dy > 0 ? y1 : y0) - oy) / dy;
    if (a > near) { near = a; face = dy > 0 ? FACE_DOWN : FACE_UP; }
    if (b < far) far = b;
  }
  if (dz === 0) {
    if (oz < z0 || oz > z1) return -1;
  } else {
    const a = ((dz > 0 ? z0 : z1) - oz) / dz;
    const b = ((dz > 0 ? z1 : z0) - oz) / dz;
    if (a > near) { near = a; face = dz > 0 ? FACE_NORTH : FACE_SOUTH; }
    if (b < far) far = b;
  }
  if (near > far || far < 0) return -1;
  if (near <= 0) {
    boxFace = startFace;
    return 0;
  }
  boxFace = face;
  return near;
}

function setHit(out: RayHit, x: number, y: number, z: number, face: number, t: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, state: number): RayHit {
  out.hit = true;
  out.x = x;
  out.y = y;
  out.z = z;
  out.face = face;
  out.px = ox + dx * t;
  out.py = oy + dy * t;
  out.pz = oz + dz * t;
  out.state = state;
  return out;
}

/**
 * Casts the ray from (ox, oy, oz) along the unit vector (dx, dy, dz) up to `reach` blocks and writes the result into
 * `out` (returned). `read` is a Published-only reader: `blockAt` −1 for a column that is not Published.
 */
export function castRay(
  read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  reach: number, mode: 'block' | 'fluid', out: RayHit,
): RayHit {
  out.hit = false;
  const fluidMode = mode === 'fluid';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  // The face the look's main axis enters by: the start cell's face, and an eye inside a box's.
  const startFace = ax >= ay && ax >= az ? (dx > 0 ? FACE_WEST : FACE_EAST)
    : ay >= az ? (dy > 0 ? FACE_DOWN : FACE_UP)
    : (dz > 0 ? FACE_NORTH : FACE_SOUTH);
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const ddx = sx !== 0 ? 1 / ax : Infinity;
  const ddy = sy !== 0 ? 1 / ay : Infinity;
  const ddz = sz !== 0 ? 1 / az : Infinity;
  // The distance along the ray to the next x, y and z boundary.
  let tx = sx > 0 ? (x + 1 - ox) * ddx : sx < 0 ? (ox - x) * ddx : Infinity;
  let ty = sy > 0 ? (y + 1 - oy) * ddy : sy < 0 ? (oy - y) * ddy : Infinity;
  let tz = sz > 0 ? (z + 1 - oz) * ddz : sz < 0 ? (oz - z) * ddz : Infinity;
  // Where the ray enters the current cell, and by which face.
  let t = 0;
  let face = startFace;
  while (t <= reach) {
    // Below the world's floor the store's padded bedrock is no voxel: an edit there is out of the world.
    if (y < FLOOR) return out;
    const s = read.blockAt(x, y, z);
    if (s < 0) return out;
    if (fluidMode && HAS_FLUID(read.fluidAt(x, y, z))) return setHit(out, x, y, z, face, t, ox, oy, oz, dx, dy, dz, s);
    if (s !== AIR_) {
      if (SHAPE_[s] === BOX_ && BOX_OF(s, box)) {
        const tb = boxEntry(ox, oy, oz, dx, dy, dz,
          x + box[0]! / 8, y + box[1]! / 8, z + box[2]! / 8, x + box[3]! / 8, y + box[4]! / 8, z + box[5]! / 8, startFace);
        if (tb >= 0 && tb <= reach) {
          return fluidMode ? out : setHit(out, x, y, z, boxFace, tb, ox, oy, oz, dx, dy, dz, s);
        }
      } else {
        return fluidMode ? out : setHit(out, x, y, z, face, t, ox, oy, oz, dx, dy, dz, s);
      }
    }
    if (tx < ty && tx < tz) {
      x += sx;
      t = tx;
      tx += ddx;
      face = sx > 0 ? FACE_WEST : FACE_EAST;
    } else if (ty < tz) {
      y += sy;
      t = ty;
      ty += ddy;
      face = sy > 0 ? FACE_DOWN : FACE_UP;
    } else {
      z += sz;
      t = tz;
      tz += ddz;
      face = sz > 0 ? FACE_NORTH : FACE_SOUTH;
    }
  }
  return out;
}

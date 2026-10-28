/**
 * The walk's swept AABB (SP5a spec §3.2, "Collision"): a `BODY_W` × `BODY_H` box standing on the feet (x, z its centre,
 * y its bottom), moved per axis (y, then x, then z) in substeps of at most `SUBSTEP` blocks, so no move per tick
 * tunnels through a 1-block wall. `COLLIDE` cube and boxes collide (boxes as a cube until SP8a, master §2.2); `none`,
 * fluids and an unpublished column's voxels (a −1 read: master §4.17, an unloaded column does not count as solid)
 * never.
 *
 * A substep tests only the voxels the box newly overlaps (at most 2 × 3 × 2) and stops `EPS` short of the face it
 * meets, so the box never rests overlapping a voxel. A voxel collides over [by, by + top) in all three axes, `top`
 * being the reader's `collideTop` (1 without it): it blocks x and z only where the body's bottom is below by + top, and
 * it stops a fall at by + top. Every SP5a block that collides is a full cube; only the unit test's synthetic 0.5 ledge
 * has another top until SP8a's slabs and stairs.
 *
 * Step-up (`STEP_UP`): a horizontal move blocked while on the ground is retried from the start raised by up to 0.6 (as
 * far as the space above allows), then lowered by that rise less the move's own dy (0.6 + |dy| when falling), onto what
 * it finds; the retry is kept only when it went further horizontally. Allocates nothing: the position runs in one
 * module-level array and the result goes into the caller's reused object.
 */
import { COLLIDE } from '../world/blocks/index';
import { COLLIDE_NONE } from '../world/blocks/kinds';

/** The body's width (x and z) and height, blocks (master §4.17). */
export const BODY_W = 0.6;
export const BODY_H = 1.8;
/** The highest step a blocked horizontal move climbs on the ground, blocks. */
export const STEP_UP = 0.6;
/** The longest substep, blocks. */
export const SUBSTEP = 0.35;

/**
 * The view-free voxel reads the walk needs (`VoxelStore` satisfies it): `blockAt` −1 and `fluidAt` 0 where the column
 * is not Published. `collideTop`, when present, gives the top of a colliding state's collision box within its voxel,
 * in (0, 1]; absent, every colliding state is a full cube.
 */
export interface VoxelReader {
  blockAt(bx: number, by: number, bz: number): number;
  fluidAt(bx: number, by: number, bz: number): number;
  publishedAt(bx: number, bz: number): boolean;
  collideTop?(state: number): number;
}

/** `moveBody`'s result, one object the caller reuses. */
export interface MoveOut {
  /** The feet after the move. */
  x: number;
  y: number;
  z: number;
  /** Whether the move was cut short on each axis. */
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  /** Whether a downward move ended on a colliding voxel. */
  onGround: boolean;
}

const COLL = COLLIDE;
const NONE = COLLIDE_NONE;
const HALF = BODY_W / 2;
const H = BODY_H;
const STEP = SUBSTEP;
const UP = STEP_UP;
/** How far short of a face a clipped move stops. */
const EPS = 1e-7;
/** The feet being moved (x, y, z). */
const pos = new Float64Array(3);
/** The highest collision top a falling substep met. */
const best = new Float64Array(1);
/**
 * The length of the sweep to run: the sweeps read it here rather than as an argument, since a length computed in
 * `moveBody` (the step-up's settle) would be boxed into a heap number when passed.
 */
const span = new Float64Array(1);

/** Whether state `s` collides: −1 (an unpublished column) does not. */
function collides(s: number): boolean {
  return s >= 0 && COLL[s] !== NONE;
}

/** The top of a colliding state's collision box within its voxel: the reader's `collideTop`, or 1. */
function topOf(r: VoxelReader, s: number): number {
  return r.collideTop !== undefined ? r.collideTop(s) : 1;
}

/** Whether voxel (bx, by, bz) collides: `COLLIDE` cube or boxes (as a cube until SP8a); −1 (unpublished) does not. */
export function solidAt(r: VoxelReader, bx: number, by: number, bz: number): boolean {
  return collides(r.blockAt(bx, by, bz));
}

/**
 * Moves `pos` by `span[0]` along y, in ⌈|d| / SUBSTEP⌉ equal substeps whose ends are taken from the start (no drift);
 * true when a voxel cut the move short.
 */
function sweepY(r: VoxelReader): boolean {
  const d = span[0]!;
  const from = pos[1]!;
  const n = Math.ceil(Math.abs(d) / STEP);
  for (let i = 1; i <= n; i++) {
    const y = pos[1]!;
    const step = (i === n ? from + d : from + (d * i) / n) - y;
    const x = pos[0]!;
    const z = pos[2]!;
    const x0 = Math.floor(x - HALF);
    const x1 = Math.ceil(x + HALF) - 1;
    const z0 = Math.floor(z - HALF);
    const z1 = Math.ceil(z + HALF) - 1;
    if (step < 0) {
      // The feet go down: the highest collision top in (y + step, y]. A higher layer's tops are all above a lower's.
      let found = false;
      for (let by = Math.ceil(y) - 1, lo = Math.floor(y + step); by >= lo && !found; by--) {
        for (let bx = x0; bx <= x1; bx++) {
          for (let bz = z0; bz <= z1; bz++) {
            const s = r.blockAt(bx, by, bz);
            if (!collides(s)) continue;
            const t = by + topOf(r, s);
            if (t <= y && t > y + step && (!found || t > best[0]!)) {
              best[0] = t;
              found = true;
            }
          }
        }
      }
      if (found) {
        const ny = best[0]! + EPS;
        pos[1] = ny < y ? ny : y;
        return true;
      }
    } else {
      // The head goes up: the lowest underside in [y + H, y + H + step).
      const head = y + H;
      for (let by = Math.ceil(head), hi = Math.ceil(head + step) - 1; by <= hi; by++) {
        for (let bx = x0; bx <= x1; bx++) {
          for (let bz = z0; bz <= z1; bz++) {
            if (!collides(r.blockAt(bx, by, bz))) continue;
            const ny = by - EPS - H;
            pos[1] = ny > y ? ny : y;
            return true;
          }
        }
      }
    }
    pos[1] = y + step;
  }
  return false;
}

/**
 * Moves `pos` by `span[0]` along x (`a` 0) or z (`a` 2), in substeps as `sweepY`'s; true when a voxel cut the move
 * short.
 */
function sweepH(r: VoxelReader, a: 0 | 2): boolean {
  const d = span[0]!;
  const b = 2 - a;
  const from = pos[a]!;
  const n = Math.ceil(Math.abs(d) / STEP);
  for (let i = 1; i <= n; i++) {
    const c = pos[a]!;
    const step = (i === n ? from + d : from + (d * i) / n) - c;
    const o = pos[b]!;
    const y = pos[1]!;
    const o0 = Math.floor(o - HALF);
    const o1 = Math.ceil(o + HALF) - 1;
    const y0 = Math.floor(y);
    const y1 = Math.ceil(y + H) - 1;
    // The one layer of voxels the leading side newly overlaps (a substep is shorter than a block).
    const side = step > 0 ? c + HALF : c - HALF;
    const v0 = step > 0 ? Math.ceil(side) : Math.floor(side + step);
    const v1 = step > 0 ? Math.ceil(side + step) - 1 : Math.floor(side) - 1;
    for (let v = v0; v <= v1; v++) {
      for (let by = y0; by <= y1; by++) {
        for (let ob = o0; ob <= o1; ob++) {
          const s = a === 0 ? r.blockAt(v, by, ob) : r.blockAt(ob, by, v);
          if (!collides(s) || by + topOf(r, s) <= y) continue;
          if (step > 0) {
            const nc = v - EPS - HALF;
            pos[a] = nc > c ? nc : c;
          } else {
            const nc = v + 1 + EPS + HALF;
            pos[a] = nc < c ? nc : c;
          }
          return true;
        }
      }
    }
    pos[a] = c + step;
  }
  return false;
}

/**
 * Moves the body standing on `p` (the feet) by (dx, dy, dz) blocks: y, then x, then z, in substeps of at most
 * `SUBSTEP`; then, when `onGround` and a horizontal move was cut short, the step-up retry (see the module comment).
 * Writes the feet, the axes cut short and whether it ended on the ground into `out`; allocates nothing.
 */
export function moveBody(
  r: VoxelReader, p: { x: number; y: number; z: number }, dx: number, dy: number, dz: number, onGround: boolean,
  out: MoveOut,
): void {
  pos[0] = p.x;
  pos[1] = p.y;
  pos[2] = p.z;
  span[0] = dy;
  const hitY = sweepY(r);
  span[0] = dx;
  const hitX = sweepH(r, 0);
  span[0] = dz;
  const hitZ = sweepH(r, 2);
  out.x = pos[0]!;
  out.y = pos[1]!;
  out.z = pos[2]!;
  out.hitX = hitX;
  out.hitY = hitY;
  out.hitZ = hitZ;
  out.onGround = hitY && dy < 0;
  if (!onGround || !(hitX || hitZ)) return;
  pos[0] = p.x;
  pos[1] = p.y;
  pos[2] = p.z;
  span[0] = UP;
  sweepY(r);
  const settle = dy - (pos[1]! - p.y);
  span[0] = dx;
  const sx = sweepH(r, 0);
  span[0] = dz;
  const sz = sweepH(r, 2);
  span[0] = settle;
  const sy = sweepY(r);
  const ox = out.x - p.x;
  const oz = out.z - p.z;
  const nx = pos[0]! - p.x;
  const nz = pos[2]! - p.z;
  if (nx * nx + nz * nz <= ox * ox + oz * oz) return;
  out.x = pos[0]!;
  out.y = pos[1]!;
  out.z = pos[2]!;
  out.hitX = sx;
  out.hitY = sy;
  out.hitZ = sz;
  out.onGround = sy && settle < 0;
}

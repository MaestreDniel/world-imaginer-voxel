/**
 * The walk controller (SP5a spec §3.2, D2-D5, D25; master §4.17): a fixed tick of `TICK_S` (20 Hz) with Minecraft's
 * per-tick constants over the swept AABB (`physics.ts`), velocities in blocks per tick. `walkStep` runs the ticks a
 * frame owes (at most `MAX_TICKS`) and draws the eye between the previous and the current tick's feet, `EYE` above
 * them, so the camera is smooth at any refresh rate.
 *
 * One tick, from the state at its start:
 * - the horizontal row: in water or lava (the body overlaps a voxel holding it) v += 0.02 · wish; on the ground
 *   v += a · wish, a = `WALK_ACCEL` / f³ (× `SPRINT_MUL` sprinting), f = slip · 0.91 with slip 0.98 when the block under
 *   the body's centre at feet − 0.5 is `SLIPPERY`, else 0.6; in the air v += 0.02 (0.026 sprinting) · wish;
 * - the vertical input: in a fluid Space +0.04 and Shift −0.04; out of one, Space on the ground jumps (vy = 0.42); on a
 *   ladder (the body overlaps a `CLIMBABLE` voxel), after the fluid row, vy is clamped to ±0.1175, Space sets +0.1175
 *   and Shift 0;
 * - the move, y then x then z, with step-up on the ground; an axis cut short loses its velocity;
 * - drag and gravity: water ·0.8 on all axes then vy −0.005; lava ·0.5 then vy −0.02; otherwise v ·= f (0.91 in the
 *   air) and vy = (vy − 0.08) · 0.98 (terminal −3.92); in a fluid, a horizontal move cut short with the body free 0.6
 *   higher hops (vy = 0.3);
 * - unloaded: when a column under the body's footprint is not Published, vy is 0 and nothing moves vertically; the
 *   horizontal move goes on, the column's voxels (−1) never collide, and `onGround` keeps its value (no vertical sweep
 *   runs to update it), so a body walking off the loaded disc keeps the ground row (its block under the centre reads
 *   −1, not `SLIPPERY`) and one in the air keeps the air row;
 * - a walking teleport's snap (SP5a spec §3.4, D15), before all of the above: while `snapPending`, the body hovers by
 *   the unloaded rule until the column under its centre is Published (`heightAt` not null); on that tick both feet go to
 *   its `heightAt('motionBlocking')` (already y + 1 of the highest voxel, fluid included), `snapY` records it and
 *   `snapPending` clears.
 *
 * Allocates nothing: the reads are view-free (`VoxelReader`), the wish's forward vector goes into one module-level array
 * and the move's result into one reused object.
 */
import { lookVectorInto } from './fly';
import type { Action } from './keymap';
import { BODY_H, BODY_W, moveBody, type MoveOut, type VoxelReader } from './physics';
import { COLLIDE, STATE_TYPE } from '../world/blocks/index';
import { COLLIDE_NONE } from '../world/blocks/kinds';
import { CLIMBABLE, SLIPPERY } from '../world/blocks/tags';
import { FLUID_LAVA, FLUID_WATER } from '../world/blocks/fluid';

/** The tick, seconds (20 Hz), and the most ticks one frame runs (`MAX_STEP_S` 0.25 bounds the frame). */
export const TICK_S = 0.05;
export const MAX_TICKS = 5;
/** The eye above the feet, blocks. */
export const EYE = 1.62;

/** Ground slipperiness: every block but the `SLIPPERY` ones (ice, packed ice). */
export const SLIP = 0.6;
export const SLIP_ICE = 0.98;
/** The horizontal drag in the air, and the factor by which slip makes the ground's. */
export const AIR_DRAG = 0.91;
/** The ground acceleration's numerator: a = `WALK_ACCEL` / f³, 0.1 per tick on ordinary ground (f = 0.546). */
export const WALK_ACCEL = 0.1 * 0.16277136;
export const SPRINT_MUL = 1.3;
export const AIR_ACCEL = 0.02;
export const AIR_ACCEL_SPRINT = 0.026;
export const JUMP_VY = 0.42;
/** Out of fluid: vy = (vy − `GRAVITY`) · `VDRAG`. */
export const GRAVITY = 0.08;
export const VDRAG = 0.98;
/** In water: v ·= `WATER_DRAG`, then vy −= `WATER_GRAVITY` (the user's Point 5: today's Minecraft). */
export const WATER_DRAG = 0.8;
export const WATER_GRAVITY = 0.005;
export const LAVA_DRAG = 0.5;
export const LAVA_GRAVITY = 0.02;
/** Space and Shift in a fluid, per tick. */
export const SWIM_ACCEL = 0.04;
/** The horizontal acceleration in a fluid, per tick of wish. */
export const FLUID_MOVE = 0.02;
/** The hop out of a fluid against a bank. */
export const BANK_HOP_VY = 0.3;
/** The ladder's vertical clamp and climbing speed (2.35 blocks/s). */
export const LADDER_V = 0.1175;

/** The feet (x, z the body's centre, y its bottom) at the previous and the current tick, the velocity and the clock. */
export interface WalkState {
  px: number; py: number; pz: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  /** Seconds owed to the next tick, in [0, `TICK_S`). */
  acc: number;
  /** A walking teleport's snap waits for the column to be Published (SP5a spec §3.4). */
  snapPending: boolean;
  /** The feet y the last snap set (`heightAt('motionBlocking')`); NaN before any snap. `setFeet` leaves it. */
  snapY: number;
}

/**
 * The walk's reads: the view-free voxel reads and the store's heightmap (`VoxelStore.heightAt`, null where the column is
 * not Published), which the teleport's snap reads.
 */
export interface WalkReader extends VoxelReader {
  heightAt(kind: 'motionBlocking', bx: number, bz: number): number | null;
}

export function createWalkState(): WalkState {
  return {
    px: 0, py: 0, pz: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: false, acc: 0, snapPending: false, snapY: Number.NaN,
  };
}

/**
 * Sets both the previous and the current feet (no interpolation across F or a teleport), zeroes the velocity and the
 * accumulator, and clears `onGround` (the next tick's sweep finds the ground again) and `snapPending` (F after a flight
 * does not inherit an older teleport's snap).
 */
export function setFeet(w: WalkState, x: number, y: number, z: number): void {
  w.px = w.x = x;
  w.py = w.y = y;
  w.pz = w.z = z;
  w.vx = 0;
  w.vy = 0;
  w.vz = 0;
  w.acc = 0;
  w.onGround = false;
  w.snapPending = false;
}

/**
 * A walking teleport's arrival (SP5a spec §3.4, D15): both feet at (x, y, z) as `setFeet` sets them, and `snapPending`,
 * so the first tick over a Published column sets the feet on its ground.
 */
export function arriveFeet(w: WalkState, x: number, y: number, z: number): void {
  setFeet(w, x, y, z);
  w.snapPending = true;
}

const TYPE = STATE_TYPE;
const COLL = COLLIDE;
const NONE = COLLIDE_NONE;
const CLIMB = CLIMBABLE;
const SLIPS = SLIPPERY;
const WATER = FLUID_WATER;
const LAVA = FLUID_LAVA;
const HALF = BODY_W / 2;
const H = BODY_H;
/** How much higher the bank hop looks for room. */
const HOP_ROOM = 0.6;

const out: MoveOut = { x: 0, y: 0, z: 0, hitX: false, hitY: false, hitZ: false, onGround: false };
/** The yaw's horizontal forward vector (x, y, z), pitch 0. */
const fwd = new Float64Array(3);

/** Whether the body standing at (x, y, z) overlaps no colliding voxel (a voxel collides over [by, by + top)). */
function bodyFree(r: VoxelReader, x: number, y: number, z: number): boolean {
  const x1 = Math.ceil(x + HALF) - 1;
  const y1 = Math.ceil(y + H) - 1;
  const z1 = Math.ceil(z + HALF) - 1;
  for (let bx = Math.floor(x - HALF); bx <= x1; bx++) {
    for (let by = Math.floor(y); by <= y1; by++) {
      for (let bz = Math.floor(z - HALF); bz <= z1; bz++) {
        const s = r.blockAt(bx, by, bz);
        if (s < 0 || COLL[s] === NONE) continue;
        if (by + (r.collideTop !== undefined ? r.collideTop(s) : 1) > y) return false;
      }
    }
  }
  return true;
}

/**
 * One 20 Hz tick (see the module comment). `wishX`, `wishZ` is the horizontal wish (length at most 1), `jump` Space,
 * `down` Shift, `sprint` Ctrl.
 */
export function walkTick(
  w: WalkState, r: WalkReader, wishX: number, wishZ: number, jump: boolean, down: boolean, sprint: boolean,
): void {
  if (w.snapPending) {
    const top = r.heightAt('motionBlocking', Math.floor(w.x), Math.floor(w.z));
    if (top !== null) {
      w.py = w.y = top;
      w.vy = 0;
      w.snapY = top;
      w.snapPending = false;
    }
  }
  const x = w.x;
  const y = w.y;
  const z = w.z;
  w.px = x;
  w.py = y;
  w.pz = z;
  const x0 = Math.floor(x - HALF);
  const x1 = Math.ceil(x + HALF) - 1;
  const z0 = Math.floor(z - HALF);
  const z1 = Math.ceil(z + HALF) - 1;
  const y1 = Math.ceil(y + H) - 1;
  let loaded = true;
  let water = false;
  let lava = false;
  let ladder = false;
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) {
      if (!r.publishedAt(bx, bz)) {
        loaded = false;
        continue;
      }
      for (let by = Math.floor(y); by <= y1; by++) {
        const t = (r.fluidAt(bx, by, bz) >> 4) & 3;
        if (t === WATER) water = true;
        else if (t === LAVA) lava = true;
        const s = r.blockAt(bx, by, bz);
        if (s >= 0 && CLIMB[TYPE[s]!] === 1) ladder = true;
      }
    }
  }
  const fluid = water || lava;

  let vx = w.vx;
  let vy = w.vy;
  let vz = w.vz;
  let drag: number;
  if (fluid) {
    vx += FLUID_MOVE * wishX;
    vz += FLUID_MOVE * wishZ;
    drag = water ? WATER_DRAG : LAVA_DRAG;
    if (jump) vy += SWIM_ACCEL;
    if (down) vy -= SWIM_ACCEL;
  } else if (w.onGround) {
    const s = r.blockAt(Math.floor(x), Math.floor(y - 0.5), Math.floor(z));
    drag = (s >= 0 && SLIPS[TYPE[s]!] === 1 ? SLIP_ICE : SLIP) * AIR_DRAG;
    const a = (WALK_ACCEL / (drag * drag * drag)) * (sprint ? SPRINT_MUL : 1);
    vx += a * wishX;
    vz += a * wishZ;
    if (jump) vy = JUMP_VY;
  } else {
    const a = sprint ? AIR_ACCEL_SPRINT : AIR_ACCEL;
    vx += a * wishX;
    vz += a * wishZ;
    drag = AIR_DRAG;
  }
  if (ladder) {
    if (jump) vy = LADDER_V;
    else if (down) vy = 0;
    else if (vy < -LADDER_V) vy = -LADDER_V;
    else if (vy > LADDER_V) vy = LADDER_V;
  }

  moveBody(r, w, vx, loaded ? vy : 0, vz, w.onGround, out);
  const blocked = out.hitX || out.hitZ;
  const hopX = out.x + vx;
  const hopZ = out.z + vz;
  w.x = out.x;
  w.y = out.y;
  w.z = out.z;
  if (out.hitX) vx = 0;
  if (out.hitZ) vz = 0;
  if (loaded) {
    w.onGround = out.onGround;
    if (out.hitY) vy = 0;
  }

  if (fluid) {
    vx *= drag;
    vy *= drag;
    vz *= drag;
    vy -= water ? WATER_GRAVITY : LAVA_GRAVITY;
    if (blocked && bodyFree(r, hopX, out.y + HOP_ROOM, hopZ)) vy = BANK_HOP_VY;
  } else {
    vx *= drag;
    vz *= drag;
    vy = (vy - GRAVITY) * VDRAG;
  }
  w.vx = vx;
  w.vy = loaded ? vy : 0;
  w.vz = vz;
}

/**
 * Advances the walk by `dtS` seconds: runs the ticks owed (at most `MAX_TICKS`; the rest is dropped) with the wish
 * from W A S D along the yaw's horizontal projection (normalised), Space, Shift and Ctrl, then writes the drawn eye (the
 * previous and the current feet interpolated by `acc / TICK_S`, plus `EYE`) into `eye`.
 */
export function walkStep(
  w: WalkState, r: WalkReader, held: ReadonlySet<Action>, yawDeg: number, dtS: number,
  eye: { x: number; y: number; z: number },
): void {
  if (dtS > 0) w.acc += dtS;
  if (w.acc >= TICK_S) {
    lookVectorInto(fwd, yawDeg, 0);
    const fx = fwd[0]!;
    const fz = fwd[2]!;
    const f = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
    const s = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    // Right is forward turned 90° clockwise seen from +y: (−fz, fx).
    let wx = f * fx - s * fz;
    let wz = f * fz + s * fx;
    const len2 = wx * wx + wz * wz;
    if (len2 > 1) {
      const len = Math.sqrt(len2);
      wx /= len;
      wz /= len;
    }
    const jump = held.has('up');
    const down = held.has('down');
    const sprint = held.has('sprint');
    for (let n = 0; n < MAX_TICKS && w.acc >= TICK_S; n++) {
      walkTick(w, r, wx, wz, jump, down, sprint);
      w.acc -= TICK_S;
    }
    if (w.acc >= TICK_S) w.acc %= TICK_S;
  }
  const t = w.acc / TICK_S;
  eye.x = w.px + (w.x - w.px) * t;
  eye.y = w.py + (w.y - w.py) * t + EYE;
  eye.z = w.pz + (w.z - w.pz) * t;
}

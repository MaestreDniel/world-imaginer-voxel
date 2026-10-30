import type { Action } from './keymap';
import { EYE, setFeet, type WalkState } from './walk';

/**
 * The fly controller (SP4a spec §7.1-§7.2; SP4b spec §6.1, D19: horizontal flight; master §4.17). No collisions:
 * creative-style flight, as in Minecraft's creative mode. Forward and back move along `forwardXZ(yaw)`, the horizontal
 * projection of the look direction, strafing along `forwardXZ(yaw + 90)`, up and down along world y; the pitch never
 * tilts the motion. Only the horizontal pair is normalised (W with D never exceeds the speed) and the vertical axis
 * applies on its own at the speed (W with Space keeps the full horizontal speed while climbing). The world streams
 * around the camera, so there is no horizontal limit (SP4b spec §6.2, D20); y stays within −64 … 400. The velocity
 * approaches the input's target with time constant TAU, integrated exactly over each step, so the motion is the same
 * at any frame rate.
 *
 * Conventions (ruling P42): yaw and pitch are in degrees; yaw 0 faces −z (north), yaw 90 faces +x (east), yaw grows
 * clockwise seen from +y and stays in [0, 360); pitch is positive upward, within ±PITCH_LIMIT.
 */

/**
 * The camera, flying or walking (SP5a spec §3.1, D1): `y` is the eye in both modes; walking, the walk step writes the
 * drawn eye into `x`, `y` and `z`. `mode` is `'fly'` at the reveal. An unsaved world opens in flight after every load
 * (its mode is not remembered); a saved world restores its mode, F's path once after the reveal (SP5b spec §3.4 step 5).
 */
export interface FlyState {
  x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number; speed: number;
  mode: 'fly' | 'walk';
}

/** Where the camera may fly: y −64 … 400, with no horizontal limit (SP4b spec §6.1). */
export interface FlyBounds { yMin: -64; yMax: 400 }

/** Blocks per second (master §4.17). */
export const SPEED_DEFAULT = 12;
export const SPEED_MIN = 1;
export const SPEED_MAX = 96;
/** One speed step multiplies or divides by this. */
export const SPEED_STEP = 1.25;
/** The sprint factor while sprint is held (R, or a double-tapped W). */
export const SPRINT = 4;
/** The velocity's time constant, seconds. */
export const TAU = 0.1;

const PITCH_LIMIT = 89.9;
const DEG = Math.PI / 180;

/** Wraps degrees into [0, 360); `+ 0` turns −0 into +0. */
function wrapYaw(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return (r >= 360 ? r - 360 : r) + 0;
}

/** The horizontal unit vector a yaw faces, `[dx, dz]` = `[sin yaw, −cos yaw]`. */
export function forwardXZ(yawDeg: number): [number, number] {
  return [Math.sin(yawDeg * DEG), -Math.cos(yawDeg * DEG)];
}

/** The unit look vector `[cos p·sin y, sin p, −cos p·cos y]`. */
export function lookVector(yawDeg: number, pitchDeg: number): [number, number, number] {
  const cp = Math.cos(pitchDeg * DEG);
  return [cp * Math.sin(yawDeg * DEG), Math.sin(pitchDeg * DEG), -cp * Math.cos(yawDeg * DEG)];
}

/**
 * `lookVector` written into `out` (x, y, z) with no tuple: the frame's DDA and the walk step reuse one array (SP5a spec
 * §3.5: zero allocation).
 */
export function lookVectorInto(out: Float64Array, yawDeg: number, pitchDeg: number): void {
  const cp = Math.cos(pitchDeg * DEG);
  out[0] = cp * Math.sin(yawDeg * DEG);
  out[1] = Math.sin(pitchDeg * DEG);
  out[2] = -cp * Math.cos(yawDeg * DEG);
}

/** Turns a camera to the state's view; structural so that player/ needs no three (it is render's). */
export function applyCameraRotation(
  camera: { rotation: { set(x: number, y: number, z: number, order: 'YXZ'): unknown } },
  s: Pick<FlyState, 'yaw' | 'pitch'>,
): void {
  camera.rotation.set(s.pitch * DEG, -s.yaw * DEG, 0, 'YXZ');
}

const axis = (held: ReadonlySet<Action>, plus: Action, minus: Action): number => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);

/** Advances the state by `dtS` seconds under the held actions, then applies the vertical bounds. */
export function stepFly(s: FlyState, held: ReadonlySet<Action>, dtS: number, bounds: FlyBounds): void {
  if (!(dtS > 0)) return;
  const f = axis(held, 'forward', 'back');
  const r = axis(held, 'right', 'left');
  const u = axis(held, 'up', 'down');
  // `forwardXZ(yaw)` and `forwardXZ(yaw + 90)` without their arrays: the frame step calls this every tick, at rest
  // too, and allocates nothing (SP4b spec §3.10).
  const fx = Math.sin(s.yaw * DEG);
  const fz = -Math.cos(s.yaw * DEG);
  const rx = Math.sin((s.yaw + 90) * DEG);
  const rz = -Math.cos((s.yaw + 90) * DEG);
  let dx = f * fx + r * rx;
  let dz = f * fz + r * rz;
  // A horizontal diagonal never flies faster than the speed; the vertical axis is independent (SP4b spec §6.1).
  // `Math.hypot` only when the pair can be longer than 1 (a builtin call boxes its arguments).
  if (dx * dx + dz * dz > 1) {
    const len = Math.hypot(dx, dz);
    dx /= len;
    dz /= len;
  }
  const speed = s.speed * (held.has('sprint') ? SPRINT : 1);
  const tx = dx * speed;
  const ty = u * speed;
  const tz = dz * speed;

  // Exact over the step for a constant target: v(t) = T + (v0 − T)·e^(−t/τ), so x gains T·dt + (v0 − T)·τ·(1 − e^(−dt/τ)).
  const decay = Math.exp(-dtS / TAU);
  const lag = TAU * (1 - decay);
  s.x += tx * dtS + (s.vx - tx) * lag;
  s.y += ty * dtS + (s.vy - ty) * lag;
  s.z += tz * dtS + (s.vz - tz) * lag;
  s.vx = tx + (s.vx - tx) * decay;
  s.vy = ty + (s.vy - ty) * decay;
  s.vz = tz + (s.vz - tz) * decay;

  if (s.y <= bounds.yMin) {
    s.y = bounds.yMin;
    if (s.vy < 0) s.vy = 0;
  } else if (s.y >= bounds.yMax) {
    s.y = bounds.yMax;
    if (s.vy > 0) s.vy = 0;
  }
}

/** Mouse look: `dx`, `dy` in pixels (movementX/Y), `sensitivity` in degrees per pixel; mouse up looks up. */
export function look(s: FlyState, dx: number, dy: number, sensitivity: number): void {
  s.yaw = wrapYaw(s.yaw + dx * sensitivity);
  s.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, s.pitch - dy * sensitivity));
}

/**
 * F (SP5a spec §3.1, D1). Fly → walk: both the previous and the current feet at the eye − `EYE` (no interpolation
 * across the switch) with the walk's velocity zeroed (`setFeet`); the walk's next tick runs the unstuck scan.
 * Walk → fly: the drawn eye kept. Either way the flight's velocity is zeroed.
 */
export function toggleMode(fly: FlyState, w: WalkState): void {
  if (fly.mode === 'fly') {
    setFeet(w, fly.x, fly.y - EYE, fly.z);
    fly.mode = 'walk';
  } else {
    fly.mode = 'fly';
  }
  fly.vx = 0;
  fly.vy = 0;
  fly.vz = 0;
}

/** One speed step: ×SPEED_STEP up or ÷SPEED_STEP down, clamped to [SPEED_MIN, SPEED_MAX] (spec §7.2). */
export function stepSpeed(s: FlyState, dir: 1 | -1): void {
  const next = dir === 1 ? s.speed * SPEED_STEP : s.speed / SPEED_STEP;
  s.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, next));
}

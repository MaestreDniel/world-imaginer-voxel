import type { Action } from './keymap';

/**
 * The spectator controller (SP4a spec §7.1-§7.2 and §7.5, D18, D20; master §4.17). No collisions: forward and back
 * move along the full look vector (MC's spectator), strafing along the horizontal right vector, up and down along
 * world y. The velocity approaches the input's target with time constant TAU, integrated exactly over each step, so
 * the motion is the same at any frame rate.
 *
 * Conventions (ruling P42): yaw and pitch are in degrees; yaw 0 faces −z (north), yaw 90 faces +x (east), yaw grows
 * clockwise seen from +y and stays in [0, 360); pitch is positive upward, within ±PITCH_LIMIT.
 */

export interface FlyState { x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number; speed: number }

/** Where the camera may fly while SP4a's world is loaded once (spec §7.5): a disc around the load centre, y −64 … 400. */
export interface FlyBounds { centreX: number; centreZ: number; radius: number /* (rd − 3)·16 */; yMin: -64; yMax: 400 }

/** Blocks per second (master §4.17). */
export const SPEED_DEFAULT = 12;
export const SPEED_MIN = 1;
export const SPEED_MAX = 96;
/** One speed step multiplies or divides by this. */
export const SPEED_STEP = 1.25;
/** The sprint factor while Ctrl is held. */
export const SPRINT = 4;
/** The velocity's time constant, seconds. */
export const TAU = 0.1;

const PITCH_LIMIT = 89.9;
const DEG = Math.PI / 180;
/** atEdge's tolerance, blocks: the clamp puts the camera on the radius up to rounding. */
const EDGE_EPS = 1e-6;

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

/** Turns a camera to the state's view; structural so that player/ needs no three (it is render's). */
export function applyCameraRotation(
  camera: { rotation: { set(x: number, y: number, z: number, order: 'YXZ'): unknown } },
  s: Pick<FlyState, 'yaw' | 'pitch'>,
): void {
  camera.rotation.set(s.pitch * DEG, -s.yaw * DEG, 0, 'YXZ');
}

const axis = (held: ReadonlySet<Action>, plus: Action, minus: Action): number => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);

/** Advances the state by `dtS` seconds under the held actions, then applies the bounds. */
export function stepFly(s: FlyState, held: ReadonlySet<Action>, dtS: number, bounds: FlyBounds): void {
  if (!(dtS > 0)) return;
  const f = axis(held, 'forward', 'back');
  const r = axis(held, 'right', 'left');
  const u = axis(held, 'up', 'down');
  const [lx, ly, lz] = lookVector(s.yaw, s.pitch);
  const [rx, rz] = forwardXZ(s.yaw + 90);
  let dx = f * lx + r * rx;
  let dy = f * ly + u;
  let dz = f * lz + r * rz;
  // A diagonal never flies faster than the speed.
  const len = Math.hypot(dx, dy, dz);
  if (len > 1) {
    dx /= len;
    dy /= len;
    dz /= len;
  }
  const speed = s.speed * (held.has('sprint') ? SPRINT : 1);
  const tx = dx * speed;
  const ty = dy * speed;
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

  // The world edge (spec §7.5): at or past the radius, drop the outward horizontal velocity and pull back onto it.
  const ox = s.x - bounds.centreX;
  const oz = s.z - bounds.centreZ;
  const d = Math.hypot(ox, oz);
  if (d > 0 && d >= bounds.radius) {
    const nx = ox / d;
    const nz = oz / d;
    const out = s.vx * nx + s.vz * nz;
    if (out > 0) {
      s.vx -= out * nx;
      s.vz -= out * nz;
    }
    if (d > bounds.radius) {
      s.x = bounds.centreX + nx * bounds.radius;
      s.z = bounds.centreZ + nz * bounds.radius;
    }
  }
  if (s.y <= bounds.yMin) {
    s.y = bounds.yMin;
    if (s.vy < 0) s.vy = 0;
  } else if (s.y >= bounds.yMax) {
    s.y = bounds.yMax;
    if (s.vy > 0) s.vy = 0;
  }
}

/** True when the camera is held at the edge of the loaded world (the notice of spec §7.5). */
export function atEdge(s: FlyState, b: FlyBounds): boolean {
  return Math.hypot(s.x - b.centreX, s.z - b.centreZ) >= b.radius - EDGE_EPS;
}

/** Mouse look: `dx`, `dy` in pixels (movementX/Y), `sensitivity` in degrees per pixel; mouse up looks up. */
export function look(s: FlyState, dx: number, dy: number, sensitivity: number): void {
  s.yaw = wrapYaw(s.yaw + dx * sensitivity);
  s.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, s.pitch - dy * sensitivity));
}

/** One speed step: ×SPEED_STEP up or ÷SPEED_STEP down, clamped to [SPEED_MIN, SPEED_MAX] (spec §7.2). */
export function stepSpeed(s: FlyState, dir: 1 | -1): void {
  const next = dir === 1 ? s.speed * SPEED_STEP : s.speed / SPEED_STEP;
  s.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, next));
}

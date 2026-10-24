import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  SPEED_DEFAULT, SPEED_MAX, SPEED_MIN, SPEED_STEP, SPRINT, TAU,
  applyCameraRotation, forwardXZ, look, lookVector, stepFly, stepSpeed,
  type FlyBounds, type FlyState,
} from '../../src/player/fly';
import type { Action } from '../../src/player/keymap';

const state = (o: Partial<FlyState> = {}): FlyState => ({
  x: 0, y: 100, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT, ...o,
});
/** Only the vertical range: SP4b streams the world, so there is no horizontal limit (SP4b spec §6.1). */
const BOUNDS: FlyBounds = { yMin: -64, yMax: 400 };
const held = (...a: Action[]): ReadonlySet<Action> => new Set(a);

/** Runs `seconds` of input at `fps` and returns the state. */
function fly(s: FlyState, keys: ReadonlySet<Action>, fps: number, seconds: number, b: FlyBounds = BOUNDS): FlyState {
  const n = Math.round(fps * seconds);
  for (let k = 0; k < n; k++) stepFly(s, keys, 1 / fps, b);
  return s;
}
const travelled = (s: FlyState, x0 = 0, y0 = 100, z0 = 0) => Math.hypot(s.x - x0, s.y - y0, s.z - z0);
const horizontal = (s: FlyState, x0 = 0, z0 = 0) => Math.hypot(s.x - x0, s.z - z0);

describe('fly controller (SP4a spec §7.1; SP4b spec §6.1: horizontal flight)', () => {
  test('the constants are the spec\'s', () => {
    expect([SPEED_DEFAULT, SPEED_MIN, SPEED_MAX, SPEED_STEP, SPRINT, TAU]).toEqual([12, 1, 96, 1.25, 4, 0.1]);
  });

  test('the same distance at 30 and 144 fps over 2 s of W', () => {
    const a = travelled(fly(state(), held('forward'), 30, 2));
    const b = travelled(fly(state(), held('forward'), 144, 2));
    expect(Math.abs(a - b) / b).toBeLessThan(0.01);
    // 12 blocks/s with a 0.1 s lag: about 12 · (2 − 0.1).
    expect(b).toBeCloseTo(12 * 1.9, 0);
  });

  test('sprint ×4', () => {
    const plain = fly(state(), held('forward'), 60, 3);
    const sprint = fly(state(), held('forward', 'sprint'), 60, 3);
    expect(Math.hypot(plain.vx, plain.vy, plain.vz)).toBeCloseTo(12, 3);
    expect(Math.hypot(sprint.vx, sprint.vy, sprint.vz)).toBeCloseTo(48, 3);
    expect(travelled(sprint) / travelled(plain)).toBeCloseTo(4, 6);
  });

  test('speed steps ×1.25 clamped to [1, 96]', () => {
    const s = state();
    stepSpeed(s, 1);
    expect(s.speed).toBeCloseTo(15, 9);
    stepSpeed(s, -1);
    expect(s.speed).toBeCloseTo(12, 9);
    for (let k = 0; k < 40; k++) stepSpeed(s, 1);
    expect(s.speed).toBe(96);
    for (let k = 0; k < 40; k++) stepSpeed(s, -1);
    expect(s.speed).toBe(1);
  });

  test('pitch clamped to ±89.9°', () => {
    const s = state();
    look(s, 0, -10000, 0.1);
    expect(s.pitch).toBe(89.9);
    look(s, 0, 10000, 0.1);
    expect(s.pitch).toBe(-89.9);
    // Mouse up (negative dy) looks up; mouse right turns clockwise; yaw stays in [0, 360).
    const t = state();
    look(t, 30, -20, 0.5);
    expect([t.yaw, t.pitch]).toEqual([15, 10]);
    look(t, -60, 0, 0.5);
    expect(t.yaw).toBe(345);
    look(t, 30, 0, 0.5);
    expect(t.yaw).toBe(0);
  });

  test('W at pitch −45° keeps its height', () => {
    const s = fly(state({ pitch: -45 }), held('forward'), 60, 2);
    expect(s.y).toBe(100);
    expect(s.vy).toBe(0);
    expect(Math.abs(s.x)).toBeLessThan(1e-9);
    // The full speed goes north: the pitch never tilts the motion.
    expect(-s.z).toBeCloseTo(travelled(fly(state(), held('forward'), 60, 2)), 9);
    const up = fly(state({ pitch: 80 }), held('back'), 60, 1);
    expect(up.y).toBe(100);
    expect(up.z).toBeGreaterThan(0);
  });

  test('strafe is level', () => {
    for (const pitch of [-60, 0, 75]) {
      const s = fly(state({ pitch }), held('right'), 60, 2);
      expect(s.y, `pitch ${pitch}`).toBe(100);
      expect(s.x, `pitch ${pitch}`).toBeCloseTo(12 * 1.9, 0);
      expect(Math.abs(s.z), `pitch ${pitch}`).toBeLessThan(1e-9);
    }
  });

  test('W with D never exceeds the speed (|v_xz| ≤ 12 after 2 s)', () => {
    const s = state({ yaw: 30, pitch: -20 });
    for (let k = 0; k < 120; k++) {
      stepFly(s, held('forward', 'right'), 1 / 60, BOUNDS);
      expect(Math.hypot(s.vx, s.vz)).toBeLessThanOrEqual(12 + 1e-9);
    }
    expect(Math.hypot(s.vx, s.vz)).toBeCloseTo(12, 3);
    // Diagonal: forward (sin 30°, −cos 30°) plus right (cos 30°, sin 30°), normalised.
    const [fx, fz] = forwardXZ(30 + 45);
    expect(s.vx / 12).toBeCloseTo(fx, 3);
    expect(s.vz / 12).toBeCloseTo(fz, 3);
    expect(s.y).toBe(100);
  });

  test('W with Space keeps the full horizontal speed while climbing (the horizontal distance after 2 s equals W alone\'s)', () => {
    const w = fly(state(), held('forward'), 60, 2);
    const ws = fly(state(), held('forward', 'up'), 60, 2);
    const space = fly(state(), held('up'), 60, 2);
    expect(horizontal(ws)).toBeCloseTo(horizontal(w), 9);
    expect(ws.y - 100).toBeCloseTo(space.y - 100, 9);
    expect(ws.y - 100).toBeCloseTo(12 * 1.9, 0);
    expect(Math.hypot(ws.vx, ws.vz)).toBeCloseTo(12, 3);
    expect(ws.vy).toBeCloseTo(12, 3);
  });

  test('yaw convention: 0 faces −z, 90 faces +x (ruling P42)', () => {
    const f0 = forwardXZ(0);
    const f90 = forwardXZ(90);
    expect(f0[0]).toBeCloseTo(0, 12);
    expect(f0[1]).toBeCloseTo(-1, 12);
    expect(f90[0]).toBeCloseTo(1, 12);
    expect(f90[1]).toBeCloseTo(0, 12);
    const e = fly(state({ yaw: 90 }), held('forward'), 60, 1);
    expect(e.x).toBeGreaterThan(0);
    expect(Math.abs(e.vz)).toBeLessThan(1e-9);
    expect(Math.abs(e.z)).toBeLessThan(1e-9);
    const n = fly(state(), held('forward'), 60, 1);
    expect(n.z).toBeLessThan(0);
    const d = fly(state(), held('right'), 60, 1);
    expect(d.x).toBeGreaterThan(0);
    expect(Math.abs(d.z)).toBeLessThan(1e-9);
    const up = fly(state({ pitch: 60 }), held('up'), 60, 1);
    expect(up.y).toBeGreaterThan(100);
    expect(Math.hypot(up.x, up.z)).toBeLessThan(1e-9);
  });

  test('applyCameraRotation points a three camera along lookVector', () => {
    for (const [yaw, pitch] of [[135, -10], [90, 0], [0, 0], [300, 45]] as const) {
      const cam = new PerspectiveCamera();
      applyCameraRotation(cam, state({ yaw, pitch }));
      cam.updateMatrixWorld(true);
      const dir = cam.getWorldDirection(new Vector3());
      const v = lookVector(yaw, pitch);
      expect(dir.x, `${yaw},${pitch}`).toBeCloseTo(v[0], 9);
      expect(dir.y, `${yaw},${pitch}`).toBeCloseTo(v[1], 9);
      expect(dir.z, `${yaw},${pitch}`).toBeCloseTo(v[2], 9);
    }
  });

  test('no horizontal limit: at x 500,000 and z −500,000, W moves on', () => {
    const n = fly(state({ x: 500_000, z: -500_000 }), held('forward'), 60, 2);
    expect(n.x).toBe(500_000);
    expect(n.z).toBeCloseTo(-500_000 - 12 * 1.9, 0);
    expect(n.vz).toBeCloseTo(-12, 3);
    const e = fly(state({ x: 500_000, z: -500_000, yaw: 90 }), held('forward', 'sprint'), 60, 10);
    expect(e.x).toBeCloseTo(500_000 + 48 * 9.9, 0);
    expect(e.vx).toBeCloseTo(48, 3);
    const w = fly(state({ x: -500_000, z: 500_000, yaw: 270 }), held('forward'), 60, 2);
    expect(w.x).toBeCloseTo(-500_000 - 12 * 1.9, 0);
  });

  test('y clamped to −64 … 400', () => {
    const low = fly(state({ y: -60 }), held('down'), 60, 5);
    expect(low.y).toBe(-64);
    expect(low.vy).toBe(0);
    const high = fly(state({ y: 395 }), held('up', 'sprint'), 60, 5);
    expect(high.y).toBe(400);
    expect(high.vy).toBe(0);
  });

  test('no input brings the velocity to rest', () => {
    const s = fly(state(), held('forward'), 60, 1);
    fly(s, held(), 60, 2);
    expect(Math.hypot(s.vx, s.vy, s.vz)).toBeLessThan(1e-6);
  });
});

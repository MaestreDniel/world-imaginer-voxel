import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  SPEED_DEFAULT, SPEED_MAX, SPEED_MIN, SPEED_STEP, SPRINT, TAU,
  applyCameraRotation, atEdge, forwardXZ, look, lookVector, stepFly, stepSpeed,
  type FlyBounds, type FlyState,
} from '../../src/player/fly';
import type { Action } from '../../src/player/keymap';

const state = (o: Partial<FlyState> = {}): FlyState => ({
  x: 0, y: 100, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT, ...o,
});
/** RD 12: radius (12 − 3)·16 = 144. */
const BOUNDS: FlyBounds = { centreX: 0, centreZ: 0, radius: (12 - 3) * 16, yMin: -64, yMax: 400 };
const held = (...a: Action[]): ReadonlySet<Action> => new Set(a);

/** Runs `seconds` of input at `fps` and returns the state. */
function fly(s: FlyState, keys: ReadonlySet<Action>, fps: number, seconds: number, b: FlyBounds = BOUNDS): FlyState {
  const n = Math.round(fps * seconds);
  for (let k = 0; k < n; k++) stepFly(s, keys, 1 / fps, b);
  return s;
}
const travelled = (s: FlyState, x0 = 0, y0 = 100, z0 = 0) => Math.hypot(s.x - x0, s.y - y0, s.z - z0);

describe('spectator fly controller (SP4a spec §7.1, D18)', () => {
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

  test('W at pitch −45° descends (spectator: full look vector)', () => {
    const s = fly(state({ pitch: -45 }), held('forward'), 60, 2);
    expect(s.y).toBeLessThan(100);
    expect(100 - s.y).toBeCloseTo(-s.z, 6);
    expect(Math.abs(s.x)).toBeLessThan(1e-9);
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

  test('the edge clamp at (rd − 3)·16 removes only the outward component; atEdge true there', () => {
    // At the east edge, flying north-east: the east (outward) part goes, the north part stays.
    const s = state({ x: 143.9, yaw: 45, vx: 12 * Math.SQRT1_2, vz: -12 * Math.SQRT1_2 });
    expect(atEdge(s, BOUNDS)).toBe(false);
    for (let k = 0; k < 6; k++) stepFly(s, held('forward'), 1 / 60, BOUNDS);
    expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(144 + 1e-9);
    expect(atEdge(s, BOUNDS)).toBe(true);
    const nx = s.x / Math.hypot(s.x, s.z);
    const nz = s.z / Math.hypot(s.x, s.z);
    expect(s.vx * nx + s.vz * nz).toBeLessThanOrEqual(1e-9);
    // The tangential part survives: the camera slides along the edge.
    expect(Math.abs(s.vx * -nz + s.vz * nx)).toBeGreaterThan(5);
    const z0 = s.z;
    fly(s, held('forward'), 60, 1);
    expect(s.z).toBeLessThan(z0 - 3);
    expect(Math.hypot(s.x, s.z)).toBeCloseTo(144, 6);

    // Flying straight out stops at the radius; flying back in is free.
    const out = fly(state({ yaw: 90 }), held('forward'), 60, 30);
    expect(out.x).toBeCloseTo(144, 9);
    expect(out.vx).toBeCloseTo(0, 9);
    expect(atEdge(out, BOUNDS)).toBe(true);
    fly(out, held('back'), 60, 1);
    expect(out.x).toBeLessThan(140);
    expect(atEdge(out, BOUNDS)).toBe(false);

    // The bounds are around the load centre, not the origin.
    const off: FlyBounds = { ...BOUNDS, centreX: 1000, centreZ: -2000, radius: 16 };
    const o = fly(state({ x: 1000, z: -2000 }), held('forward'), 60, 10, off);
    expect(o.z).toBeCloseTo(-2016, 9);
    expect(atEdge(o, off)).toBe(true);
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

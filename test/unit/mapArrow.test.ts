import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { MapView } from '../../src/ui/map/mapState';
import { ARROW_MIN_MS, arrowDue, arrowGeometry, arrowMoved, arrowRedrawWanted } from '../../src/ui/map/viewMath';

const W = 800;
const H = 600;
const VIEW: MapView = { x: 1000, z: -2000, bpp: 4, layer: 'biome' };

/** The arrow at the view centre (400, 300) for `yaw`: tip, then the two base corners. */
function arrow(yaw: number): number[] {
  const out = new Float64Array(6);
  expect(arrowGeometry(VIEW.x, VIEW.z, yaw, VIEW, W, H, out)).toBe(true);
  return [...out];
}

describe('the player arrow (SP4c spec §1.5, D19)', () => {
  test('yaw 0 points up the screen, 90 right, 180 down, 270 left', () => {
    const tips: ReadonlyArray<readonly [number, number, number]> = [[0, 400, 293], [90, 407, 300], [180, 400, 307], [270, 393, 300]];
    for (const [yaw, tx, ty] of tips) {
      const [x, y] = arrow(yaw);
      expect(x).toBeCloseTo(tx, 9);
      expect(y).toBeCloseTo(ty, 9);
    }
  });

  test('the tip is 14 px from the base\'s midpoint and the base 10 px wide', () => {
    for (const yaw of [0, 33, 90, 147.5, 180, 270, 359]) {
      const [tx, ty, ax, ay, bx, by] = arrow(yaw) as [number, number, number, number, number, number];
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      expect(Math.hypot(tx - mx, ty - my)).toBeCloseTo(14, 9);
      expect(Math.hypot(ax - bx, ay - by)).toBeCloseTo(10, 9);
      // Isosceles: the tip is as far from both base corners, and the base is perpendicular to the axis.
      expect(Math.hypot(tx - ax, ty - ay)).toBeCloseTo(Math.hypot(tx - bx, ty - by), 9);
      expect((tx - mx) * (ax - bx) + (ty - my) * (ay - by)).toBeCloseTo(0, 9);
      // Centred on the player: the axis's midpoint is the player's screen position.
      expect((tx + mx) / 2).toBeCloseTo(400, 9);
      expect((ty + my) / 2).toBeCloseTo(300, 9);
    }
  });

  test('the arrow follows the player across the view: 40 blocks east and 80 north at 4 blocks/px is 10 px right, 20 px up', () => {
    const out = new Float64Array(6);
    expect(arrowGeometry(VIEW.x + 40, VIEW.z - 80, 0, VIEW, W, H, out)).toBe(true);
    expect(out[0]).toBeCloseTo(410, 9);
    expect(out[1]).toBeCloseTo(273, 9);
  });

  test('a centre outside the view: false', () => {
    const out = new Float64Array(6);
    expect(arrowGeometry(VIEW.x + 401 * 4, VIEW.z, 0, VIEW, W, H, out)).toBe(false);
    expect(arrowGeometry(VIEW.x - 401 * 4, VIEW.z, 0, VIEW, W, H, out)).toBe(false);
    expect(arrowGeometry(VIEW.x, VIEW.z + 301 * 4, 0, VIEW, W, H, out)).toBe(false);
    expect(arrowGeometry(VIEW.x, VIEW.z - 301 * 4, 0, VIEW, W, H, out)).toBe(false);
    expect(arrowGeometry(VIEW.x + 399 * 4, VIEW.z - 299 * 4, 0, VIEW, W, H, out)).toBe(true);
  });

  test('`arrowMoved` at 4 blocks/px: 3.6 blocks and 1.9° → false; 4 blocks or 2° → true', () => {
    expect(arrowMoved(10, 20, 30, 13.6, 20, 31.9, 4)).toBe(false);
    expect(arrowMoved(10, 20, 30, 10, 23.6, 28.1, 4)).toBe(false);
    expect(arrowMoved(10, 20, 30, 14, 20, 30, 4)).toBe(true);
    expect(arrowMoved(10, 20, 30, 10, 16, 30, 4)).toBe(true);
    expect(arrowMoved(10, 20, 30, 10, 20, 32, 4)).toBe(true);
    expect(arrowMoved(10, 20, 30, 10, 20, 28, 4)).toBe(true);
    // The turn wraps at 0/360: 359° → 1° is 2°, 359° → 0.9° is 1.9°.
    expect(arrowMoved(0, 0, 359, 0, 0, 1, 4)).toBe(true);
    expect(arrowMoved(0, 0, 359, 0, 0, 0.9, 4)).toBe(false);
    expect(arrowMoved(0, 0, 0, 0, 0, 0, 4)).toBe(false);
  });

  test('`arrowDue(1000, 1020)` false, `(1000, 1033)` true', () => {
    expect(ARROW_MIN_MS).toBe(33);
    expect(arrowDue(1000, 1020)).toBe(false);
    expect(arrowDue(1000, 1032.9)).toBe(false);
    expect(arrowDue(1000, 1033)).toBe(true);
    expect(arrowDue(-Infinity, 0)).toBe(true);
  });
});

describe('the arrow\'s redraw decision (SP4c spec §1.5; final review MAP-3)', () => {
  /** A clock that counts its reads: the decision reads it only when the arrow moved or turned. */
  const clock = (t: number) => {
    const c = { reads: 0, now: () => { c.reads++; return t; } };
    return c;
  };

  test('the first call draws; then only a move of ≥ 1 px or a turn of ≥ 2°, ≥ 33 ms after the last draw', () => {
    // Never drawn: wanted, whatever the clock.
    const first = clock(0);
    expect(arrowRedrawWanted(false, 0, 0, 0, 0, 0, 0, 4, -Infinity, first.now)).toBe(true);
    expect(first.reads).toBe(0);
    // Drawn at (10, 20, 30) at 1,000 ms, 4 blocks/px.
    const still = clock(5000);
    expect(arrowRedrawWanted(true, 10, 20, 30, 13.6, 20, 31.9, 4, 1000, still.now)).toBe(false);
    expect(still.reads).toBe(0);
    const soon = clock(1020);
    expect(arrowRedrawWanted(true, 10, 20, 30, 14, 20, 30, 4, 1000, soon.now)).toBe(false);
    expect(soon.reads).toBe(1);
    expect(arrowRedrawWanted(true, 10, 20, 30, 14, 20, 30, 4, 1000, clock(1033).now)).toBe(true);
    expect(arrowRedrawWanted(true, 10, 20, 30, 10, 20, 32, 4, 1000, clock(1033).now)).toBe(true);
    expect(arrowRedrawWanted(true, 10, 20, 30, 10, 20, 32, 4, 1000, clock(1032.9).now)).toBe(false);
  });

  test('the real canvas and the frame step\'s zero-allocation fake both run it', () => {
    const view = readFileSync(new URL('../../src/ui/map/mapView.ts', import.meta.url), 'utf8');
    const setPlayer = view.slice(view.indexOf('    setPlayer(x, z, yawDeg) {'), view.indexOf('    setHidden(on) {'));
    expect(setPlayer).toContain('if (arrowRedrawWanted(arrowDrawn, drawnX, drawnZ, drawnYaw, x, z, yawDeg, view.bpp, drawnAt, now)) schedule();');
    expect(setPlayer).not.toContain('arrowMoved(');
    const fake = readFileSync(new URL('./zeroAlloc.test.ts', import.meta.url), 'utf8');
    expect(fake).toContain('if (arrowRedrawWanted(arrowDrawn, drawnX, drawnZ, drawnYaw, x, z, yawDeg, view.bpp, drawnAt, arrow.now)) draw(x, z, yawDeg);');
  });
});

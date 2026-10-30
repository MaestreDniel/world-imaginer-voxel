import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { MapView } from '../../src/ui/map/mapState';
import { ARROW_MIN_MS, arrowDue, arrowGeometry, arrowMoved, arrowRedrawWanted, drawPlaceDots, PLACE_DOT_PX } from '../../src/ui/map/viewMath';
import { PLACE_COLOURS } from '../../src/ui/world/places';

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

describe('the place dots (SP5b spec §3.7, D13)', () => {
  /** A 2D context that records each path call with the style in force when it ran. */
  function recorder() {
    const calls: Array<readonly (string | number)[]> = [];
    const ctx = {
      fillStyle: '' as string | CanvasGradient | CanvasPattern,
      strokeStyle: '' as string | CanvasGradient | CanvasPattern,
      lineWidth: 1,
      beginPath() { calls.push(['beginPath']); },
      arc(x: number, y: number, r: number, a0: number, a1: number) { calls.push(['arc', x, y, r, a0, a1]); },
      fill() { calls.push(['fill', String(ctx.fillStyle)]); },
      stroke() { calls.push(['stroke', String(ctx.strokeStyle), ctx.lineWidth]); },
    };
    return { ctx, calls };
  }

  test('`drawPlaceDots` draws one filled arc in `PLACE_COLOURS[c]` and one white stroke per place in view, and skips a place off the view', () => {
    const { ctx, calls } = recorder();
    const list = [
      // At the view's centre (400, 300), blue.
      { x: VIEW.x, z: VIEW.z, colour: 4 },
      // Off the view: 2,000 px east.
      { x: VIEW.x + 8000, z: VIEW.z, colour: 1 },
      // 40 blocks east and 80 north at 4 blocks/px: 10 px right, 20 px up; red.
      { x: VIEW.x + 40, z: VIEW.z - 80, colour: 0 },
      // Just off the bottom edge, its rim outside too.
      { x: VIEW.x, z: VIEW.z + (300 + PLACE_DOT_PX + 2) * 4, colour: 6 },
    ];
    drawPlaceDots(ctx, VIEW, W, H, list, PLACE_COLOURS);
    expect(PLACE_DOT_PX).toBe(5);
    expect(calls).toEqual([
      ['beginPath'], ['arc', 400, 300, PLACE_DOT_PX, 0, 2 * Math.PI], ['fill', PLACE_COLOURS[4]], ['stroke', '#ffffff', 2],
      ['beginPath'], ['arc', 410, 280, PLACE_DOT_PX, 0, 2 * Math.PI], ['fill', PLACE_COLOURS[0]], ['stroke', '#ffffff', 2],
    ]);
    // The line width is put back for the overlays drawn after it.
    expect(ctx.lineWidth).toBe(1);
    // No places: nothing drawn.
    const empty = recorder();
    drawPlaceDots(empty.ctx, VIEW, W, H, [], PLACE_COLOURS);
    expect(empty.calls).toEqual([]);
  });

  test('the canvas draws the dots in its overlays, under the arrow, and redraws them only when scheduled', () => {
    const view = readFileSync(new URL('../../src/ui/map/mapView.ts', import.meta.url), 'utf8');
    const overlays = view.slice(view.indexOf('  const drawOverlays = () => {'), view.indexOf('  const drawArrow = () => {'));
    expect(overlays).toContain('drawPlaceDots(ctx2d, view, w, h, places, placeColours);');
    const draw = view.slice(view.indexOf('  const draw = () => {'));
    expect(draw.indexOf('drawOverlays();')).toBeLessThan(draw.indexOf('drawArrow();'));
    expect(view).toContain('setPlaces(list, colours) { places = list; placeColours = colours; schedule(); },');
  });
});

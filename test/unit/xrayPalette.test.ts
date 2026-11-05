import { describe, expect, test } from 'vitest';
import { CAVE_FILM_KIND, CAVE_KIND } from '../../src/core/constants';
import { XRAY_COLORS, XRAY_LABELS } from '../../src/render/xrayPalette';

/** The kinds the X-ray draws: the nine cave kinds (1-9) and the surface film (15). */
const SHOWN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 15] as const;

describe('the X-ray palette (SP6a spec §5.2, D10)', () => {
  test('16 sRGB hex colours, one per kind; the nine kinds and the film distinct', () => {
    expect(XRAY_COLORS).toHaveLength(16);
    for (const c of XRAY_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(SHOWN.map((k) => XRAY_COLORS[k])).size).toBe(SHOWN.length);
    expect(Object.isFrozen(XRAY_COLORS)).toBe(true);
  });

  test('D10\'s colours by kind: cheese amber … other density air grey, the film grey', () => {
    expect(XRAY_COLORS[CAVE_KIND.cheese]).toBe('#ffb000');
    expect(XRAY_COLORS[CAVE_KIND.spaghetti3d]).toBe('#00e5ff');
    expect(XRAY_COLORS[CAVE_KIND.spaghetti2d]).toBe('#3d7bff');
    expect(XRAY_COLORS[CAVE_KIND.noodle]).toBe('#ff3df0');
    expect(XRAY_COLORS[CAVE_KIND.entrance]).toBe('#3ddc5a');
    expect(XRAY_COLORS[CAVE_KIND.worm]).toBe('#ff7a1a');
    expect(XRAY_COLORS[CAVE_KIND.ravine]).toBe('#ff3030');
    expect(XRAY_COLORS[CAVE_KIND.undergroundWorm]).toBe('#ffe83d');
    expect(XRAY_COLORS[CAVE_KIND.other]).toBe('#9aa0a6');
    expect(XRAY_COLORS[CAVE_FILM_KIND]).toBe('#c8c8c8');
  });

  test('the legend\'s labels: XRAY_LABELS[1] "Cheese" … [15] "Surface"; the unused kinds empty', () => {
    expect(XRAY_LABELS).toHaveLength(16);
    expect(Object.isFrozen(XRAY_LABELS)).toBe(true);
    expect(SHOWN.map((k) => XRAY_LABELS[k])).toEqual([
      'Cheese', 'Spaghetti 3D', 'Spaghetti 2D', 'Noodle', 'Entrance', 'Worm', 'Ravine', 'Underground worm',
      'Other density air', 'Surface',
    ]);
    for (const k of [0, 10, 11, 12, 13, 14]) expect(XRAY_LABELS[k], `kind ${k}`).toBe('');
  });
});

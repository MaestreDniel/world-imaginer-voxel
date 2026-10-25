import { describe, expect, test } from 'vitest';
import { mapClickAction, type MapClick, type MapClickAction, type SlicePlane } from '../../src/ui/map/clickAction';
import type { DrawerTabId } from '../../src/ui/map/layout';

const PIN: MapClickAction = { kind: 'pin' };
const SECTION: MapClickAction = { kind: 'openSection' };
const CENTRE: MapClickAction = { kind: 'centre' };
const CUT_OPENS: MapClickAction = { kind: 'cut', openSection: true };
const CUT_KEEPS: MapClickAction = { kind: 'cut', openSection: false };
const TELEPORT: MapClickAction = { kind: 'teleport' };

describe('mapClickAction (SP3d spec §3.7): the routing of a map click', () => {
  // Every (drawerTab, plane, nearLine, cutArmed); drawerTab null = the drawer is closed. Density is "shown" only
  // while the drawer is open on its tab.
  const cases: ReadonlyArray<readonly [DrawerTabId | null, SlicePlane, boolean, boolean, MapClickAction]> = [
    // The drawer closed, or open on Spline or Cross-section: today's routing, whatever the Density plane.
    [null, 'vertical', false, false, PIN], [null, 'vertical', true, false, SECTION],
    [null, 'vertical', false, true, CUT_OPENS], [null, 'vertical', true, true, CUT_OPENS],
    [null, 'horizontal', false, false, PIN], [null, 'horizontal', true, false, SECTION],
    [null, 'horizontal', false, true, CUT_OPENS], [null, 'horizontal', true, true, CUT_OPENS],
    ['spline', 'vertical', false, false, PIN], ['spline', 'vertical', true, false, SECTION],
    ['spline', 'vertical', false, true, CUT_OPENS], ['spline', 'vertical', true, true, CUT_OPENS],
    ['spline', 'horizontal', false, false, PIN], ['spline', 'horizontal', true, false, SECTION],
    ['spline', 'horizontal', false, true, CUT_OPENS], ['spline', 'horizontal', true, true, CUT_OPENS],
    ['section', 'vertical', false, false, PIN], ['section', 'vertical', true, false, SECTION],
    ['section', 'vertical', false, true, CUT_OPENS], ['section', 'vertical', true, true, CUT_OPENS],
    ['section', 'horizontal', false, false, PIN], ['section', 'horizontal', true, false, SECTION],
    ['section', 'horizontal', false, true, CUT_OPENS], ['section', 'horizontal', true, true, CUT_OPENS],
    // Density shown: a finished cut line keeps Density shown; a click near the line does not open Cross-section;
    // on the horizontal plane a plain click sets the plane's centre instead of the pin.
    ['density', 'vertical', false, false, PIN], ['density', 'vertical', true, false, PIN],
    ['density', 'vertical', false, true, CUT_KEEPS], ['density', 'vertical', true, true, CUT_KEEPS],
    ['density', 'horizontal', false, false, CENTRE], ['density', 'horizontal', true, false, CENTRE],
    ['density', 'horizontal', false, true, CUT_KEEPS], ['density', 'horizontal', true, true, CUT_KEEPS],
  ];

  test('the table covers every combination once', () => {
    const keys = new Set(cases.map(([d, p, n, c]) => `${String(d)} ${p} ${n} ${c}`));
    expect(keys.size).toBe(cases.length);
    expect(cases).toHaveLength(4 * 2 * 2 * 2);
  });

  test.each(cases)('drawer %s, plane %s, near the line %s, cut armed %s', (drawerTab, plane, nearLine, cutArmed, want) => {
    const click: MapClick = { drawerTab, plane, nearLine, cutArmed, host: 'page', shift: false };
    expect(mapClickAction(click)).toEqual(want);
  });

  test('page: today\'s routing, with and without Shift (SP4c spec §3.1)', () => {
    for (const [drawerTab, plane, nearLine, cutArmed, want] of cases) {
      for (const shift of [false, true]) expect(mapClickAction({ drawerTab, plane, nearLine, cutArmed, host: 'page', shift })).toEqual(want);
    }
  });
});

describe('mapClickAction in the world (SP4c spec §3.1, D14; Point 3)', () => {
  const tabs: ReadonlyArray<DrawerTabId | null> = [null, 'spline', 'section', 'density'];
  const planes: readonly SlicePlane[] = ['vertical', 'horizontal'];
  const world = (drawerTab: DrawerTabId | null, plane: SlicePlane, nearLine: boolean, cutArmed: boolean, shift: boolean): MapClick =>
    ({ drawerTab, plane, nearLine, cutArmed, host: 'world', shift });

  test('world, plain: teleport (Density shown or not, near the line or not)', () => {
    for (const tab of tabs) for (const plane of planes) for (const near of [false, true]) {
      expect(mapClickAction(world(tab, plane, near, false, false))).toEqual(TELEPORT);
    }
  });

  test('world, armed cut, plain or Shift: cut', () => {
    for (const tab of tabs) for (const plane of planes) for (const near of [false, true]) for (const shift of [false, true]) {
      expect(mapClickAction(world(tab, plane, near, true, shift))).toEqual(tab === 'density' ? CUT_KEEPS : CUT_OPENS);
    }
  });

  test('world, Shift on the Density tab\'s horizontal plane: centre; Shift on Density\'s vertical plane near the line: pin; Shift, Density tab not shown, near the line: openSection; Shift elsewhere: pin', () => {
    for (const near of [false, true]) expect(mapClickAction(world('density', 'horizontal', near, false, true))).toEqual(CENTRE);
    expect(mapClickAction(world('density', 'vertical', true, false, true))).toEqual(PIN);
    expect(mapClickAction(world('density', 'vertical', false, false, true))).toEqual(PIN);
    for (const tab of [null, 'spline', 'section'] as const) for (const plane of planes) {
      expect(mapClickAction(world(tab, plane, true, false, true))).toEqual(SECTION);
      expect(mapClickAction(world(tab, plane, false, false, true))).toEqual(PIN);
    }
  });
});

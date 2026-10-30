import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  clampDrawerHeight, clampPanelWidth, DEFAULT_LAYOUT, drawerTabOnScreen, DRAWER_TAB_IDS, DRAWER_TAB_LABELS, LAYOUT_KEY, layoutTabs, loadLayout, parseLayout, saveLayout, serializeLayout, TAB_IDS, TAB_LABELS, tabKeyTarget, tabOnScreen, withSection,
  type Layout, type LayoutStorage,
} from '../../src/ui/map/layout';

/** An in-memory Storage; `failGet` / `failSet` make the accessors throw like a blocked or full localStorage. */
class FakeStorage implements LayoutStorage {
  readonly items = new Map<string, string>();
  failGet = false;
  failSet = false;
  getItem(key: string): string | null {
    if (this.failGet) throw new Error('SecurityError');
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('QuotaExceededError');
    this.items.set(key, value);
  }
}

describe('layout state (SP2b spec §3.1)', () => {
  test('the defaults: the World tab, no open section, a 340 px panel and a 300 px drawer', () => {
    expect(DEFAULT_LAYOUT).toEqual({ panelWidth: 340, drawerHeight: 300, tab: 'world', openSections: [] });
    expect(TAB_IDS).toEqual(['world', 'parameters', 'biomes', 'presets']);
    expect(LAYOUT_KEY).toBe('wi10.layout.v1');
  });

  test('the drawer tabs in key order: Spline, Cross-section, then Density appended last (SP3d spec §3.1)', () => {
    expect(DRAWER_TAB_IDS).toEqual(['spline', 'section', 'density']);
    expect(Object.isFrozen(DRAWER_TAB_IDS)).toBe(true);
    expect(DRAWER_TAB_IDS.map((id) => DRAWER_TAB_LABELS[id])).toEqual(['Spline', 'Cross-section', 'Density']);
    // The uiSmoke tabs step: ArrowLeft on Cross-section shows Spline, ArrowRight shows Cross-section again.
    const at = DRAWER_TAB_IDS.indexOf('section');
    const k = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    expect(DRAWER_TAB_IDS[tabKeyTarget(k('ArrowLeft'), at, DRAWER_TAB_IDS.length)!]).toBe('spline');
    expect(DRAWER_TAB_IDS[tabKeyTarget(k('ArrowRight'), 0, DRAWER_TAB_IDS.length)!]).toBe('section');
    expect(DRAWER_TAB_IDS[tabKeyTarget(k('ArrowRight'), at, DRAWER_TAB_IDS.length)!]).toBe('density');
  });

  test('serializeLayout and parseLayout round-trip', () => {
    const l: Layout = { panelWidth: 412, drawerHeight: 222, tab: 'biomes', openSections: ['climate', 'climate.warp', 'lakes'] };
    expect(parseLayout(serializeLayout(l))).toEqual(l);
    expect(parseLayout(serializeLayout(DEFAULT_LAYOUT))).toEqual(DEFAULT_LAYOUT);
  });

  test.each<[string, string | null]>([
    ['a missing value', null], ['an empty string', ''], ['text that is not JSON', '{'], ['null', 'null'], ['an array', '[340]'], ['a number', '340'],
  ])('%s gives the defaults', (_name, text) => {
    expect(parseLayout(text)).toEqual(DEFAULT_LAYOUT);
  });

  test('an invalid field gives that field\'s default and keeps the valid ones', () => {
    expect(parseLayout(JSON.stringify({ panelWidth: 'wide', drawerHeight: 250, tab: 'presets', openSections: ['shape'] })))
      .toEqual({ ...DEFAULT_LAYOUT, drawerHeight: 250, tab: 'presets', openSections: ['shape'] });
    expect(parseLayout(JSON.stringify({ panelWidth: 300, drawerHeight: null, tab: 'caves', openSections: ['shape', 3] })))
      .toEqual({ ...DEFAULT_LAYOUT, panelWidth: 300 });
    expect(parseLayout(JSON.stringify({ tab: 'parameters', extra: true }))).toEqual({ ...DEFAULT_LAYOUT, tab: 'parameters' });
    expect(parseLayout('{"panelWidth": 1e999, "drawerHeight": -1e999}')).toEqual(DEFAULT_LAYOUT);
  });

  test('sizes are rounded and clamped: the panel to 280-520 px, the drawer to at least 160 px', () => {
    expect(parseLayout(JSON.stringify({ panelWidth: 100, drawerHeight: 20 }))).toMatchObject({ panelWidth: 280, drawerHeight: 160 });
    expect(parseLayout(JSON.stringify({ panelWidth: 9000, drawerHeight: 5000.6 }))).toMatchObject({ panelWidth: 520, drawerHeight: 5001 });
    expect(clampPanelWidth(279.6)).toBe(280);
    expect(clampPanelWidth(333.4)).toBe(333);
    expect(clampPanelWidth(Number.NaN)).toBe(340);
    expect(clampPanelWidth(Infinity)).toBe(340);
  });

  test('the drawer height is at most 60 % of the viewport, and never below 160 px', () => {
    expect(clampDrawerHeight(100, 1000)).toBe(160);
    expect(clampDrawerHeight(300.4, 1000)).toBe(300);
    expect(clampDrawerHeight(900, 1000)).toBe(600);
    expect(clampDrawerHeight(900, 999)).toBe(599);
    expect(clampDrawerHeight(300, 200)).toBe(160);
    expect(clampDrawerHeight(Number.NaN, 400)).toBe(240);
  });

  test('open sections keep their first occurrence once; withSection opens and closes one', () => {
    expect(parseLayout(JSON.stringify({ openSections: ['lakes', 'climate', 'lakes'] })).openSections).toEqual(['lakes', 'climate']);
    const a = withSection(DEFAULT_LAYOUT, 'climate', true);
    expect(a.openSections).toEqual(['climate']);
    expect(withSection(a, 'climate', true).openSections).toEqual(['climate']);
    expect(withSection(withSection(a, 'shape', true), 'climate', false).openSections).toEqual(['shape']);
    expect(withSection(DEFAULT_LAYOUT, 'shape', false).openSections).toEqual([]);
    expect(DEFAULT_LAYOUT.openSections).toEqual([]);
  });

  test('loadLayout reads the key; no storage or a throwing getItem gives the defaults', () => {
    const s = new FakeStorage();
    expect(loadLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(loadLayout(s)).toEqual(DEFAULT_LAYOUT);
    s.items.set(LAYOUT_KEY, JSON.stringify({ panelWidth: 480, tab: 'biomes' }));
    expect(loadLayout(s)).toEqual({ ...DEFAULT_LAYOUT, panelWidth: 480, tab: 'biomes' });
    s.failGet = true;
    expect(loadLayout(s)).toEqual(DEFAULT_LAYOUT);
  });

  test('saveLayout writes serializeLayout under the key; no storage or a throwing setItem returns false', () => {
    const s = new FakeStorage();
    const l: Layout = { ...DEFAULT_LAYOUT, tab: 'presets', openSections: ['rivers'] };
    expect(saveLayout(s, l)).toBe(true);
    expect(s.items.get(LAYOUT_KEY)).toBe(serializeLayout(l));
    expect(loadLayout(s)).toEqual(l);
    s.failSet = true;
    expect(saveLayout(s, DEFAULT_LAYOUT)).toBe(false);
    expect(loadLayout(s)).toEqual(l);
    expect(saveLayout(null, l)).toBe(false);
  });
});

describe('the Places tab, only in a saved world\'s map (SP5b spec §3.7, D13)', () => {
  test('`TAB_IDS` keeps the four (`?map`); a world layout with places shows five; `parseLayout` of a stored `\'places\'` on `?map` gives the World tab', () => {
    expect(TAB_IDS).toEqual(['world', 'parameters', 'biomes', 'presets']);
    expect(layoutTabs(false)).toEqual(TAB_IDS);
    // A saved world's map: Places is the fifth tab, after Presets.
    expect(layoutTabs(true)).toEqual(['world', 'parameters', 'biomes', 'presets', 'places']);
    expect(layoutTabs(true).map((id) => TAB_LABELS[id])).toEqual(['World', 'Parameters', 'Biomes', 'Presets', 'Places']);
    expect(Object.isFrozen(layoutTabs(true))).toBe(true);
    // The layout key is shared by `?map` and every world's map: a stored Places opens the World tab where it is not shown
    // (`?map`, an unsaved world), and Places where it is.
    const stored = JSON.stringify({ panelWidth: 400, tab: 'places' });
    expect(parseLayout(stored, layoutTabs(false))).toEqual({ ...DEFAULT_LAYOUT, panelWidth: 400, tab: 'world' });
    expect(parseLayout(stored)).toEqual({ ...DEFAULT_LAYOUT, panelWidth: 400, tab: 'world' });
    expect(parseLayout(stored, layoutTabs(true))).toEqual({ ...DEFAULT_LAYOUT, panelWidth: 400, tab: 'places' });
    expect(parseLayout(JSON.stringify({ tab: 'presets' }), layoutTabs(true)).tab).toBe('presets');
    const s = new FakeStorage();
    s.items.set(LAYOUT_KEY, stored);
    expect(loadLayout(s).tab).toBe('world');
    expect(loadLayout(s, layoutTabs(true)).tab).toBe('places');
    // The tool builds its layout with the tabs its map shows.
    const src = readFileSync(new URL('../../src/ui/map/mapTool.ts', import.meta.url), 'utf8');
    expect(src).toContain('const mapPlaces = deps.places ?? null;\n  const layout = createLayout(host, deps.storage, { tabs: layoutTabs(mapPlaces !== null) });');
  });
});

describe('tab keys (SP2b spec §3.1): the tab bars are reachable from the keyboard', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  test('ArrowRight and ArrowLeft move to the next and previous tab and wrap; Home and End go to the first and last', () => {
    expect(tabKeyTarget(k('ArrowRight'), 0, 4)).toBe(1);
    expect(tabKeyTarget(k('ArrowRight'), 3, 4)).toBe(0);
    expect(tabKeyTarget(k('ArrowLeft'), 2, 4)).toBe(1);
    expect(tabKeyTarget(k('ArrowLeft'), 0, 4)).toBe(3);
    expect(tabKeyTarget(k('Home'), 2, 4)).toBe(0);
    expect(tabKeyTarget(k('End'), 1, 4)).toBe(3);
    // The two-tab drawer bar.
    expect(tabKeyTarget(k('ArrowRight'), 1, 2)).toBe(0);
    expect(tabKeyTarget(k('ArrowLeft'), 1, 2)).toBe(0);
  });

  test('other keys, modified keys and a focus outside the bar are left to the page and the browser', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'p', 'Escape']) expect(tabKeyTarget(k(key), 1, 4), key).toBeNull();
    expect(tabKeyTarget(k('ArrowRight', { altKey: true }), 1, 4)).toBeNull();
    expect(tabKeyTarget(k('ArrowRight', { ctrlKey: true }), 1, 4)).toBeNull();
    expect(tabKeyTarget(k('ArrowLeft', { metaKey: true }), 1, 4)).toBeNull();
    expect(tabKeyTarget(k('End', { shiftKey: true }), 1, 4)).toBeNull();
    expect(tabKeyTarget(k('ArrowRight'), -1, 4)).toBeNull();
  });
});

describe('a hidden map requests nothing (SP2b spec §5.5; final review MAP-2)', () => {
  test('a tab or drawer tab is on screen only while the map is shown, its panel or drawer open and it selected', () => {
    const panel = { panelVisible: true, tab: 'biomes' as const };
    expect(tabOnScreen(true, panel, 'biomes')).toBe(true);
    expect(tabOnScreen(false, panel, 'biomes')).toBe(false);
    expect(tabOnScreen(true, { ...panel, panelVisible: false }, 'biomes')).toBe(false);
    expect(tabOnScreen(true, panel, 'world')).toBe(false);
    for (const id of DRAWER_TAB_IDS) {
      const drawer = { drawerOpen: true, drawerTab: id };
      expect(drawerTabOnScreen(true, drawer, id)).toBe(true);
      expect(drawerTabOnScreen(false, drawer, id)).toBe(false);
      expect(drawerTabOnScreen(true, { ...drawer, drawerOpen: false }, id)).toBe(false);
      expect(drawerTabOnScreen(true, drawer, DRAWER_TAB_IDS.find((t) => t !== id)!)).toBe(false);
    }
  });

  // The real tool mounts only in the browser smoke (SP4c spec §9): its wiring is pinned on the source.
  test('the map tool gates the shares, the spline drawer, the cross-section and Density on whether it is shown', () => {
    const src = readFileSync(new URL('../../src/ui/map/mapTool.ts', import.meta.url), 'utf8');
    expect(src).toContain("const densityShown = (): boolean => drawerTabOnScreen(shown, layout, 'density');");
    expect(src).toContain("visible: () => drawerTabOnScreen(shown, layout, 'spline'),");
    expect(src).toContain("visible: () => drawerTabOnScreen(shown, layout, 'section'),");
    expect(src).toContain("tabVisible: () => tabOnScreen(shown, layout, 'biomes'),");
    // The standalone page never hides the tool: shown from the mount, so ?map behaves as before.
    expect(src).toContain('let shown = true;');
    const show = src.slice(src.indexOf('    show(centre) {'), src.indexOf('    hide() {'));
    const hide = src.slice(src.indexOf('    hide() {'), src.indexOf('    setPlayer:'));
    // Shown again, every view on screen catches up once (as when it comes on screen); hidden, the slice viewer stops.
    expect(show).toContain('if (!shown) {');
    expect(show).toContain('shown = true;');
    expect(show).toContain('caughtUp();');
    expect(hide).toContain('shown = false;');
    expect(hide).toContain('slices.setShown(false);');
    const caughtUp = src.slice(src.indexOf('const caughtUp = (): void => {'));
    for (const call of ['splines.open(splines.leaf)', 'section.shown();', 'densityChanged();', 'shares.shown();']) expect(caughtUp.slice(0, caughtUp.indexOf('\n  };'))).toContain(call);
  });
});

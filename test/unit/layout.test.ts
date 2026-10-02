import { describe, expect, test } from 'vitest';
import {
  clampDrawerHeight, clampPanelWidth, DEFAULT_LAYOUT, LAYOUT_KEY, loadLayout, parseLayout, saveLayout, serializeLayout, TAB_IDS, withSection,
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

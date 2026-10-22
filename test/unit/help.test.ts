import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../src/engine/capabilityRules';
import { bindingLabel, DEFAULT_KEYMAP } from '../../src/player/keymap';
import { mountHelp } from '../../src/ui/help';
import { SETTINGS_DEFAULTS, type WorldSettings } from '../../src/ui/settings';
import { installDom } from './fixtures/domShim';

const MIB = 1 << 20;
const REPORT: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
  growableSab: true, reservation: { blockBytes: 768 * MIB, byteBytes: 512 * MIB },
  webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
  renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
};

describe('mountHelp (SP4a spec §7.4, D31)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mount(over: { settings?: WorldSettings; report?: CapabilityReport } = {}) {
    const report = over.report ?? REPORT;
    const o = {
      map: DEFAULT_KEYMAP,
      settings: over.settings ?? SETTINGS_DEFAULTS,
      onSettings: vi.fn<(s: WorldSettings) => void>(),
      report,
      evaluation: evaluateWorldCapabilities(report),
      mapHereHref: vi.fn(() => '/?map#v1.abc'),
      onFullscreen: vi.fn(),
      onClose: vi.fn(),
    };
    const help = mountHelp(dom.body as unknown as HTMLElement, o);
    return { help, o };
  }

  const change = (id: string, value: string, type = 'change') => {
    const input = dom.el(id);
    input.value = value;
    input.dispatchEvent(new Event(type));
  };

  test('every key-map action appears in Keys with its binding labels', () => {
    mount();
    const rows = dom.el('help-keys').querySelectorAll('tr');
    for (const entry of DEFAULT_KEYMAP) {
      const row = rows.find((r) => r.dataset.action === entry.action);
      expect(row, entry.action).toBeDefined();
      expect(row!.textContent).toContain(entry.label);
      for (const b of entry.bindings) expect(row!.textContent, entry.action).toContain(bindingLabel(b));
    }
    expect(rows.length).toBe(DEFAULT_KEYMAP.length);
    // Grouped: one heading per group, in the map's order.
    expect(dom.el('help-keys').querySelectorAll('h4').map((h) => h.textContent)).toEqual(['Move', 'Speed', 'World', 'View']);
  });

  test('#capability-json holds the report JSON', () => {
    mount();
    const json = dom.el('capability-json');
    expect(json.textContent).toBe(JSON.stringify(REPORT));
    expect(json.hidden).toBe(true);
    expect(dom.el('help-system').textContent).toContain('Copy as JSON');
  });

  test('changing RD calls onSettings with the new rd', () => {
    const { o } = mount();
    change('setting-rd', '8');
    expect(o.onSettings).toHaveBeenCalledTimes(1);
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: 8 });
    change('setting-rd', '');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: null });
  });

  test('the RD choices run from 4 to the reservation\'s cap, after "Default"; the saved rd is selected', () => {
    mount({ settings: { ...SETTINGS_DEFAULTS, rd: 6 }, report: { ...REPORT, reservation: { blockBytes: 384 * MIB, byteBytes: 256 * MIB } } });
    const select = dom.el('setting-rd');
    expect(select.options.map((op) => op.value)).toEqual(['', '4', '5', '6', '7', '8']);
    expect(select.options[0]!.textContent).toBe('Default (8)');
    expect(select.value).toBe('6');
  });

  test('the FPS cap, FOV, sensitivity and brightness each call onSettings with the whole new settings', () => {
    const { o } = mount();
    change('setting-fps-cap', '60');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, fpsCap: 60 });
    change('setting-fov', '90', 'input');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, fpsCap: 60, fov: 90 });
    change('setting-sensitivity', '2.5', 'input');
    change('setting-brightness', '0.8', 'input');
    expect(o.onSettings).toHaveBeenLastCalledWith({ rd: null, fpsCap: 60, fov: 90, sensitivity: 2.5, brightness: 0.8 });
    expect(dom.el('help-settings').textContent).toContain('90°');
  });

  test('open shows it with a fresh "Open the map here" link; close hides it and calls onClose once', () => {
    const { help, o } = mount();
    const overlay = dom.el('world-help');
    expect(overlay.hidden).toBe(true);
    expect(help.isOpen).toBe(false);
    help.open();
    expect(overlay.hidden).toBe(false);
    expect(help.isOpen).toBe(true);
    expect(o.mapHereHref).toHaveBeenCalledTimes(1);
    expect(dom.el('help-map-here').href).toBe('/?map#v1.abc');
    dom.el('help-close').click();
    expect(overlay.hidden).toBe(true);
    expect(help.isOpen).toBe(false);
    expect(o.onClose).toHaveBeenCalledTimes(1);
    help.close();
    expect(o.onClose).toHaveBeenCalledTimes(1);
  });

  test('"Fullscreen" calls onFullscreen', () => {
    const { o } = mount();
    dom.el('help-fullscreen').click();
    expect(o.onFullscreen).toHaveBeenCalledTimes(1);
  });

  test('text from the report reaches the page as text', () => {
    mount({ report: { ...REPORT, renderer: '<img src=x onerror=alert(1)>' } });
    expect(dom.el('help-system').textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

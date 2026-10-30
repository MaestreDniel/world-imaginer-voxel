import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultRenderDistance, RD_MAX, reservationRdCap } from '../../src/engine/renderDistance';
import type { CapabilityReport } from '../../src/engine/capabilityRules';
import { SETTINGS_DEFAULTS, SETTINGS_KEY, loadSettings, saveSettings, type WorldSettings } from '../../src/ui/settings';
import { GREYED_NOTE, GREYED_ROWS, mountSettingsPanel } from '../../src/ui/settingsPanel';
import { installDom, type FakeElement } from './fixtures/domShim';

const MIB = 1 << 20;
const REPORT: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
  growableSab: true, reservation: { blockBytes: 768 * MIB, byteBytes: 512 * MIB },
  webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
  renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
};

describe('mountSettingsPanel (SP5b spec §1.4, D9; the rows moved from the help, SP4a spec §7.4)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** The screen as the world mounts it: rdMax and "Default (n)" from the report, unless given. */
  function mount(over: { settings?: WorldSettings; report?: CapabilityReport; rdMax?: number | null; defaultRd?: number | null } = {}) {
    const report = over.report ?? REPORT;
    const o = {
      settings: over.settings ?? SETTINGS_DEFAULTS,
      onSettings: vi.fn<(s: WorldSettings) => void>(),
      // The page's rdMax (SP4b spec §5): min(16, the reservation's cap).
      rdMax: over.rdMax === undefined ? Math.min(RD_MAX, reservationRdCap(report.reservation)) : over.rdMax,
      defaultRd: over.defaultRd === undefined ? defaultRenderDistance(report) : over.defaultRd,
      onClose: vi.fn(),
    };
    const panel = mountSettingsPanel(dom.body as unknown as HTMLElement, o);
    return { panel, o };
  }

  const change = (id: string, value: string, type = 'change') => {
    const input = dom.el(id);
    input.value = value;
    input.dispatchEvent(new Event(type));
  };
  const esc = () => {
    const e = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape', key: 'Escape' });
    dom.document.dispatchEvent(e);
    return e;
  };

  test('two tabs, Graphics shown first: RD, FPS cap, FOV and brightness under Graphics; sensitivity and hold to repeat under Controls', () => {
    mount();
    expect(dom.el('settings-tab-graphics').textContent).toBe('Graphics');
    expect(dom.el('settings-tab-controls').textContent).toBe('Controls');
    const graphics = dom.el('settings-graphics');
    const controls = dom.el('settings-controls');
    expect([graphics.hidden, controls.hidden]).toEqual([false, true]);
    for (const id of ['setting-rd', 'setting-fps-cap', 'setting-fov', 'setting-brightness']) expect(graphics.querySelector(`#${id}`), id).not.toBeNull();
    for (const id of ['setting-sensitivity', 'setting-hold-repeat']) expect(controls.querySelector(`#${id}`), id).not.toBeNull();
    dom.el('settings-tab-controls').click();
    expect([graphics.hidden, controls.hidden]).toEqual([true, false]);
    dom.el('settings-tab-graphics').click();
    expect([graphics.hidden, controls.hidden]).toEqual([false, true]);
  });

  test('changing RD calls onSettings with the new rd', () => {
    const { o } = mount();
    change('setting-rd', '8');
    expect(o.onSettings).toHaveBeenCalledTimes(1);
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: 8 });
    change('setting-rd', '');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: null });
  });

  test('the RD choices run from 4 to the reservation\'s cap, after "Default (n)"; the saved rd is selected', () => {
    const small = { ...REPORT, reservation: { blockBytes: 384 * MIB, byteBytes: 256 * MIB } };
    mount({ settings: { ...SETTINGS_DEFAULTS, rd: 6 }, report: small });
    const select = dom.el('setting-rd');
    expect(select.options.map((op) => op.value)).toEqual(['', '4', '5', '6', '7', '8']);
    expect(select.options[0]!.textContent).toBe('Default (8)');
    expect(select.value).toBe('6');
  });

  test('the RD label is "Render distance" (no "(reloads)": it applies live, SP4b spec §5)', () => {
    mount();
    const labels = dom.el('settings-graphics').querySelectorAll('span').map((sp) => sp.textContent);
    expect(labels).toContain('Render distance');
    expect(dom.el('settings-graphics').textContent).not.toContain('reloads');
  });

  test('the select\'s maximum is rdMax', () => {
    mount({ rdMax: 10 });
    expect(dom.el('setting-rd').options.map((op) => op.value)).toEqual(['', '4', '5', '6', '7', '8', '9', '10']);
    dom.body.replaceChildren();
    mount();
    expect(dom.el('setting-rd').options.at(-1)!.value).toBe('16');
  });

  test('from the start screen the RD\'s first option is `Default` and the last 16', () => {
    const { o } = mount({ rdMax: null, defaultRd: null, settings: { ...SETTINGS_DEFAULTS, rd: 14 } });
    const select = dom.el('setting-rd');
    expect(select.options[0]!.textContent).toBe('Default');
    expect(select.options[0]!.value).toBe('');
    expect(select.options.at(-1)!.value).toBe('16');
    expect(select.options.map((op) => op.value)).toEqual(['', ...Array.from({ length: 13 }, (_, i) => String(4 + i))]);
    expect(select.value).toBe('14');
    change('setting-rd', '16');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: 16 });
  });

  test('setRd(10) updates #setting-rd without calling onSettings', () => {
    const { panel, o } = mount({ settings: { ...SETTINGS_DEFAULTS, rd: 12 } });
    expect(dom.el('setting-rd').value).toBe('12');
    panel.setRd(10);
    expect(dom.el('setting-rd').value).toBe('10');
    expect(o.onSettings).not.toHaveBeenCalled();
    // The screen's copy moved with it: a later FOV change sends rd 10, not the stale 12.
    change('setting-fov', '90', 'input');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: 10, fov: 90 });
    panel.setRd(null);
    expect(dom.el('setting-rd').value).toBe('');
    expect(o.onSettings).toHaveBeenCalledTimes(1);
  });

  test('the FPS cap, FOV, sensitivity and brightness each call onSettings with the whole new settings', () => {
    const { o } = mount();
    change('setting-fps-cap', '60');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, fpsCap: 60 });
    change('setting-fov', '90', 'input');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, fpsCap: 60, fov: 90 });
    change('setting-sensitivity', '2.5', 'input');
    change('setting-brightness', '0.8', 'input');
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, rd: null, fpsCap: 60, fov: 90, sensitivity: 2.5, brightness: 0.8 });
    expect(dom.el('settings-graphics').textContent).toContain('90°');
    expect(dom.el('settings-controls').textContent).toContain('×2.5');
    // The ranges (SP4a spec §7.4: field of view 50-100°).
    const range = (id: string) => [dom.el(id).getAttribute('min'), dom.el(id).getAttribute('max'), dom.el(id).getAttribute('step')];
    expect(range('setting-fov')).toEqual(['50', '100', '1']);
    expect(range('setting-sensitivity')).toEqual(['0.1', '5', '0.1']);
    expect(range('setting-brightness')).toEqual(['0', '1', '0.05']);
    expect(dom.el('setting-fps-cap').options.map((op) => op.value)).toEqual(['0', '30', '60', '120', '144']);
  });

  test('"Hold mouse button to repeat": a checkbox, off by default; the checkbox round-trips through `wi.world.settings` (SP5a spec §4.1, D6)', () => {
    const items = new Map<string, string>();
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); } };
    const { o } = mount({ settings: loadSettings(storage) });
    // The page saves every change it is sent (`applySettings` → `saveSettings`).
    o.onSettings.mockImplementation((s) => saveSettings(storage, s));
    const box = dom.el('setting-hold-repeat') as FakeElement & { checked: boolean };
    expect([box.tagName, box.type, box.checked]).toEqual(['INPUT', 'checkbox', false]);
    const labels = dom.el('settings-controls').querySelectorAll('span').map((sp) => sp.textContent);
    expect(labels).toContain('Hold mouse button to repeat');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(o.onSettings).toHaveBeenLastCalledWith({ ...SETTINGS_DEFAULTS, holdRepeat: true });
    expect(JSON.parse(items.get(SETTINGS_KEY)!)).toMatchObject({ holdRepeat: true });
    // A new page reads it back checked; unchecking it saves false.
    dom.body.replaceChildren();
    const again = mount({ settings: loadSettings(storage) });
    again.o.onSettings.mockImplementation((s) => saveSettings(storage, s));
    const box2 = dom.el('setting-hold-repeat') as FakeElement & { checked: boolean };
    expect(box2.checked).toBe(true);
    box2.checked = false;
    box2.dispatchEvent(new Event('change'));
    expect(loadSettings(storage)).toEqual(SETTINGS_DEFAULTS);
  });

  test('the greyed rows are disabled and change nothing', () => {
    const { o } = mount();
    const greyed = dom.el('settings-greyed');
    // Below the Graphics rows.
    const graphics = dom.el('settings-graphics');
    expect(greyed.parentElement).toBe(graphics);
    expect(graphics.children.at(-1)).toBe(greyed);
    expect(greyed.querySelectorAll('span').map((sp) => sp.textContent)).toEqual(['Fog distance', 'Clouds', 'Shadows', 'Quality preset']);
    expect(GREYED_ROWS).toEqual(['Fog distance', 'Clouds', 'Shadows', 'Quality preset']);
    expect(greyed.textContent).toContain(GREYED_NOTE);
    expect(GREYED_NOTE).toBe('Coming in SP11');
    const controls = [...greyed.querySelectorAll('input'), ...greyed.querySelectorAll('select')];
    expect(controls).toHaveLength(4);
    const quality = greyed.querySelectorAll('select')[0]!;
    expect(quality.options.map((op) => op.textContent)).toEqual(['Low', 'Medium', 'High', 'Ultra']);
    for (const c of controls) {
      expect(c.disabled, c.tagName).toBe(true);
      // No id: no setting behind them.
      expect(c.id, c.tagName).toBe('');
      c.value = '1';
      c.dispatchEvent(new Event('change'));
      c.dispatchEvent(new Event('input'));
    }
    expect(o.onSettings).not.toHaveBeenCalled();
  });

  test('open shows it; close hides it and calls onClose once', () => {
    const { panel, o } = mount();
    const overlay = dom.el('settings-panel');
    expect(overlay.hidden).toBe(true);
    expect(panel.isOpen).toBe(false);
    panel.open();
    expect(overlay.hidden).toBe(false);
    expect(panel.isOpen).toBe(true);
    dom.el('settings-close').click();
    expect(overlay.hidden).toBe(true);
    expect(panel.isOpen).toBe(false);
    expect(o.onClose).toHaveBeenCalledTimes(1);
    panel.close();
    expect(o.onClose).toHaveBeenCalledTimes(1);
  });

  test('Esc closes and is consumed', () => {
    const { panel, o } = mount();
    // Closed, the screen leaves Esc alone: the map's drawer, or the browser, gets it.
    expect(esc().defaultPrevented).toBe(false);
    expect(o.onClose).not.toHaveBeenCalled();
    panel.open();
    const other = Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyQ', key: 'q' });
    dom.document.dispatchEvent(other);
    expect(panel.isOpen).toBe(true);
    expect(other.defaultPrevented).toBe(false);
    // `installShortcuts` (on window, after the document) ignores a default-prevented key.
    expect(esc().defaultPrevented).toBe(true);
    expect(panel.isOpen).toBe(false);
    expect(dom.el('settings-panel').hidden).toBe(true);
    expect(o.onClose).toHaveBeenCalledTimes(1);
    // The listener goes with the screen: a later Esc is not consumed and does not call onClose again.
    expect(esc().defaultPrevented).toBe(false);
    expect(o.onClose).toHaveBeenCalledTimes(1);
  });

  test('dispose removes the screen and its Esc listener without calling onClose', () => {
    const { panel, o } = mount();
    panel.open();
    panel.dispose();
    expect(dom.body.querySelector('#settings-panel')).toBeNull();
    expect(esc().defaultPrevented).toBe(false);
    expect(o.onClose).not.toHaveBeenCalled();
    expect(panel.isOpen).toBe(false);
  });
});

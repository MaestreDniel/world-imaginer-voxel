import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../src/engine/capabilityRules';
import { RD_MAX, reservationRdCap } from '../../src/engine/renderDistance';
import { bindingLabel, DEFAULT_KEYMAP } from '../../src/player/keymap';
import { mountHelp } from '../../src/ui/help';
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

  function mount(over: { report?: CapabilityReport; rdMax?: number } = {}) {
    const report = over.report ?? REPORT;
    const o = {
      map: DEFAULT_KEYMAP,
      report,
      // The page's rdMax (SP4b spec §5): min(16, the reservation's cap).
      rdMax: over.rdMax ?? Math.min(RD_MAX, reservationRdCap(report.reservation)),
      evaluation: evaluateWorldCapabilities(report),
      openMap: vi.fn(),
      openSettings: vi.fn(),
      worldsMenu: vi.fn(),
      onFullscreen: vi.fn(),
      onClose: vi.fn(),
    };
    const help = mountHelp(dom.body as unknown as HTMLElement, o);
    return { help, o };
  }

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
    // SP5b's B in World and G in View (SP5b spec §3.7); H is the help.
    const cells = (action: string) => rows.find((r) => r.dataset.action === action)!.querySelectorAll('td').map((td) => td.textContent);
    expect(cells('savePlace')).toEqual(['Save this place', 'B']);
    expect(cells('settings')).toEqual(['Settings', 'G']);
    expect(cells('help')).toEqual(['Help', 'H / F1']);
    // Grouped: one heading per group, in the map's order.
    expect(dom.el('help-keys').querySelectorAll('h4').map((h) => h.textContent)).toEqual(['Move', 'Speed', 'World', 'View', 'Build']);
  });

  test('a Build table lists F, E, 1-9 and the wheel; the Speed rows name Ctrl+wheel (SP5a spec §4.1, D9)', () => {
    mount();
    const section = dom.el('help-keys');
    const headings = section.querySelectorAll('h4');
    const tables = section.querySelectorAll('table');
    const build = tables[headings.findIndex((h) => h.textContent === 'Build')]!;
    const cells = build.querySelectorAll('tr').map((r) => [r.dataset.action, r.querySelectorAll('td')[1]!.textContent]);
    expect(cells).toEqual([
      ['toggleWalk', 'F'], ['palette', 'E'],
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [`slot${i}`, String(i)]),
      ['slotNext', 'Wheel down'], ['slotPrev', 'Wheel up'],
    ]);
    const rows = section.querySelectorAll('tr');
    expect(rows.find((r) => r.dataset.action === 'speedUp')!.querySelectorAll('td')[1]!.textContent).toBe('Ctrl+Wheel up / + / =');
    expect(rows.find((r) => r.dataset.action === 'speedDown')!.querySelectorAll('td')[1]!.textContent).toBe('Ctrl+Wheel down / -');
  });

  test('the help names undo and redo by who has the controls, which no key-map entry carries (SP4c spec §2.4; SP5a spec §4.5)', () => {
    mount();
    expect(dom.el('help-keys').textContent).toContain('Ctrl+Z undo · Ctrl+Y redo: blocks while you play, the map\'s settings while the map has the controls (Ctrl+Shift+Z also descends while flying; Ctrl+Y does not)');
    // The M row comes from the key map, in the View group.
    const rows = dom.el('help-keys').querySelectorAll('tr');
    expect(rows.find((r) => r.dataset.action === 'map')!.textContent).toBe('Map: teleport and live editingM');
  });

  test('the help says to let go of Ctrl before a digit, after the undo line (SP5a spec §4.6, D9)', () => {
    mount();
    const note = dom.el('help-ctrl-digit');
    expect(note.textContent).toBe('Let go of Ctrl before a digit: Ctrl+1 … Ctrl+8 switch the browser\'s tabs');
    const section = dom.el('help-keys');
    expect(section.children.at(-1)).toBe(note);
    expect(section.children.at(-2)).toBe(dom.el('help-undo'));
  });

  test('the Keys rows describe horizontal flight (SP4b spec §6.1)', () => {
    mount();
    const rows = dom.el('help-keys').querySelectorAll('tr');
    const label = (action: string) => rows.find((r) => r.dataset.action === action)!.querySelector('td')!.textContent;
    expect(label('forward')).toBe('Forward (at your height)');
    expect(label('back')).toBe('Back (at your height)');
    expect(label('up')).toBe('Rise');
    expect(label('down')).toBe('Descend');
    expect(rows.some((r) => r.dataset.action === 'loadHere')).toBe(false);
  });

  test('#capability-json holds the report JSON', () => {
    mount();
    const json = dom.el('capability-json');
    expect(json.textContent).toBe(JSON.stringify(REPORT));
    expect(json.hidden).toBe(true);
    expect(dom.el('help-system').textContent).toContain('Copy as JSON');
  });

  test('the System table shows the growable-SAB probe and the reservation in MiB (final review C-M7)', () => {
    mount();
    const rows = dom.el('help-system').querySelectorAll('tr').map((r) => r.querySelectorAll('td').map((c) => c.textContent));
    expect(rows).toContainEqual(['Growable SharedArrayBuffer', 'true']);
    expect(rows).toContainEqual(['Store reservation (blocks/bytes)', '768/512 MiB']);
    dom.body.replaceChildren();
    mount({ report: { ...REPORT, growableSab: false, reservation: null } });
    const none = dom.el('help-system').querySelectorAll('tr').map((r) => r.querySelectorAll('td').map((c) => c.textContent));
    expect(none).toContainEqual(['Growable SharedArrayBuffer', 'false']);
    expect(none).toContainEqual(['Store reservation (blocks/bytes)', '—']);
  });

  test('the System section shows "Render distance maximum <rdMax>"', () => {
    mount({ rdMax: 10 });
    const rows = dom.el('help-system').querySelectorAll('tr').map((r) => r.querySelectorAll('td').map((c) => c.textContent));
    expect(rows).toContainEqual(['Render distance maximum', '10']);
    expect(dom.el('help-rd-max').textContent).toBe('Render distance maximum10');
    dom.body.replaceChildren();
    mount();
    const full = dom.el('help-system').querySelectorAll('tr').map((r) => r.querySelectorAll('td').map((c) => c.textContent));
    expect(full).toContainEqual(['Render distance maximum', '16']);
  });

  test('open shows it; close hides it and calls onClose once', () => {
    const { help, o } = mount();
    const overlay = dom.el('world-help');
    expect(overlay.hidden).toBe(true);
    expect(help.isOpen).toBe(false);
    help.open();
    expect(overlay.hidden).toBe(false);
    expect(help.isOpen).toBe(true);
    dom.el('help-close').click();
    expect(overlay.hidden).toBe(true);
    expect(help.isOpen).toBe(false);
    expect(o.onClose).toHaveBeenCalledTimes(1);
    help.close();
    expect(o.onClose).toHaveBeenCalledTimes(1);
    expect(o.openMap).not.toHaveBeenCalled();
    expect(o.openSettings).not.toHaveBeenCalled();
    expect(o.worldsMenu).not.toHaveBeenCalled();
  });

  test('no Settings section; the buttons read `Map (M)`, `Settings (G)`, `Worlds menu`, `Fullscreen` (SP5b spec §1.4, D9, D31)', () => {
    const order: string[] = [];
    const { help, o } = mount();
    // The settings moved to the Settings screen (settingsPanel.ts): no section, no setting row, no "Settings" heading.
    expect(dom.body.querySelector('#help-settings')).toBeNull();
    expect(dom.el('world-help').querySelectorAll('h3').map((h) => h.textContent)).toEqual(['Keys', 'System']);
    for (const id of ['setting-rd', 'setting-fps-cap', 'setting-fov', 'setting-brightness', 'setting-sensitivity', 'setting-hold-repeat']) {
      expect(dom.body.querySelector(`#${id}`), id).toBeNull();
    }
    const links = dom.el('world-help').querySelector('nav')!.querySelectorAll('button');
    expect(links.map((b) => b.textContent)).toEqual(['Map (M)', 'Settings (G)', 'Worlds menu', 'Fullscreen']);
    expect(links.map((b) => b.id)).toEqual(['help-map', 'help-open-settings', 'help-worlds-menu', 'help-fullscreen']);
    expect(links.map((b) => b.type)).toEqual(['button', 'button', 'button', 'button']);
    // "Settings (G)" closes the help first, then the page opens the screen.
    o.openSettings.mockImplementation(() => { order.push(`openSettings (help open: ${help.isOpen})`); });
    o.onClose.mockImplementation(() => { order.push('onClose'); });
    help.open();
    dom.el('help-open-settings').click();
    expect(order).toEqual(['onClose', 'openSettings (help open: false)']);
    expect(o.openSettings).toHaveBeenCalledTimes(1);
    // "Worlds menu" hands the leave to the page (which saves, then navigates).
    dom.el('help-worlds-menu').click();
    expect(o.worldsMenu).toHaveBeenCalledTimes(1);
    expect(o.openMap).not.toHaveBeenCalled();
  });

  test('the button reads `Map (M)`, calls `openMap` and closes the help; no `?map` link is left (SP4c spec §1.6, D20)', () => {
    const order: string[] = [];
    const { help, o } = mount();
    o.openMap.mockImplementation(() => { order.push(`openMap (help open: ${help.isOpen})`); });
    o.onClose.mockImplementation(() => { order.push('onClose'); });
    help.open();
    const map = dom.el('help-map');
    expect(map.tagName).toBe('BUTTON');
    expect(map.type).toBe('button');
    expect(map.textContent).toBe('Map (M)');
    map.click();
    // The help closes first, then the overlay opens: nothing navigates.
    expect(order).toEqual(['onClose', 'openMap (help open: false)']);
    expect(help.isOpen).toBe(false);
    expect(dom.el('world-help').hidden).toBe(true);
    expect(o.openMap).toHaveBeenCalledTimes(1);
    expect(() => dom.el('help-map-here')).toThrow();
    const links = dom.el('world-help').querySelectorAll('a');
    expect(links.filter((a) => String(a.href ?? '').includes('?map'))).toEqual([]);
    expect(dom.el('world-help').textContent).not.toContain('Open the map here');
  });

  test('Esc closes the help while it is open (final review C-M3); Esc while closed does nothing', () => {
    const { help, o } = mount();
    const esc = () => {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape', key: 'Escape' });
      dom.document.dispatchEvent(e);
      return e;
    };
    esc();
    expect(o.onClose).not.toHaveBeenCalled();
    help.open();
    const other = Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyQ', key: 'q' });
    dom.document.dispatchEvent(other);
    expect(help.isOpen).toBe(true);
    esc();
    expect(help.isOpen).toBe(false);
    expect(dom.el('world-help').hidden).toBe(true);
    expect(o.onClose).toHaveBeenCalledTimes(1);
    // The listener goes with the overlay: a later Esc does not call onClose again.
    esc();
    expect(o.onClose).toHaveBeenCalledTimes(1);
  });

  test('the Esc that closes the help is consumed, so the map\'s window shortcut does not also close its drawer (final review WLD-1)', () => {
    const { help } = mount();
    const esc = () => {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape', key: 'Escape' });
      dom.document.dispatchEvent(e);
      return e;
    };
    // Closed, the help leaves Esc alone: the map's drawer, or the browser, gets it.
    expect(esc().defaultPrevented).toBe(false);
    help.open();
    // `installShortcuts` (on window, after the document) ignores a default-prevented key.
    expect(esc().defaultPrevented).toBe(true);
    expect(help.isOpen).toBe(false);
    expect(esc().defaultPrevented).toBe(false);
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

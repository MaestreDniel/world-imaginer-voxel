/**
 * The help overlay (SP4a spec §7.4, D31): **Keys** generated from the key map, **Settings** (the small block SP5's
 * settings panel replaces), **System** (the capability report with "Copy as JSON" and the hidden `#capability-json`,
 * moved here from the SP0 page, D21), and the links "Open the map here" and "Fullscreen". All text goes through
 * `textContent`. The page opens it on H or F1 and releases the pointer; H, F1 or Esc closes it, and clicking the canvas
 * re-locks.
 */
import type { CapabilityReport, Evaluation } from '../engine/capabilityRules';
import { defaultRenderDistance, RD_MIN, reservationRdCap } from '../engine/renderDistance';
import { bindingLabel, type KeyEntry } from '../player/keymap';
import { renderCapabilityReport } from './capabilityReport';
import { el } from './common/dom';
import { FPS_CAPS, normalizeSettings, SETTING_RANGES, type WorldSettings } from './settings';

export interface HelpOptions {
  readonly map: readonly KeyEntry[];
  readonly settings: WorldSettings;
  /**
   * Called with the whole new settings after each change. An rd change is the page's cue to save and reload (the
   * render distance only applies to a new load); the others apply live.
   */
  onSettings(s: WorldSettings): void;
  readonly report: CapabilityReport;
  readonly evaluation: Evaluation;
  /** The `?map` URL centred on the camera, read each time the overlay opens. */
  mapHereHref: () => string;
  /**
   * When given, a click on "Open the map here" is prevented and its URL passed here: the page's reloader, which disarms
   * the Ctrl+W guard first (SP4a ruling P50). Without it the link navigates by itself.
   */
  navigate?(href: string): void;
  onFullscreen(): void;
  /** Called once each time the overlay closes. */
  onClose(): void;
}

export interface Help {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

const GROUP_TITLES: Readonly<Record<KeyEntry['group'], string>> = { move: 'Move', speed: 'Speed', world: 'World', view: 'View' };

/** One table per group, in the map's order; each row names the action and every binding (spec §7.3). */
function keysSection(map: readonly KeyEntry[]): HTMLElement {
  const section = el('section', 'help-keys');
  section.id = 'help-keys';
  section.append(el('h3', '', 'Keys'));
  const groups = [...new Set(map.map((e) => e.group))];
  for (const g of groups) {
    const table = el('table', 'help-key-table');
    for (const entry of map.filter((e) => e.group === g)) {
      const row = el('tr');
      row.dataset.action = entry.action;
      row.append(el('td', 'help-key-label', entry.label), el('td', 'help-key-bindings', entry.bindings.map(bindingLabel).join(' / ')));
      table.append(row);
    }
    section.append(el('h4', '', GROUP_TITLES[g]), table);
  }
  return section;
}

/** The RD choices: "Default (n)", then RD_MIN … the reservation's cap; a saved rd above the cap shows as the cap. */
function rdSelect(report: CapabilityReport, rd: number | null): HTMLSelectElement {
  const select = el('select');
  select.id = 'setting-rd';
  const def = el('option', '', `Default (${defaultRenderDistance(report)})`);
  def.value = '';
  select.append(def);
  const cap = reservationRdCap(report.reservation);
  for (let n = RD_MIN; n <= cap; n++) {
    const opt = el('option', '', String(n));
    opt.value = String(n);
    select.append(opt);
  }
  select.value = rd === null ? '' : String(Math.min(rd, cap));
  return select;
}

function fpsSelect(cap: WorldSettings['fpsCap']): HTMLSelectElement {
  const select = el('select');
  select.id = 'setting-fps-cap';
  for (const c of FPS_CAPS) {
    const opt = el('option', '', c === 0 ? 'Off (the display\'s rate)' : `${c} fps`);
    opt.value = String(c);
    select.append(opt);
  }
  select.value = String(cap);
  return select;
}

function rangeInput(id: string, key: keyof typeof SETTING_RANGES, value: number): HTMLInputElement {
  const input = el('input');
  input.id = id;
  input.type = 'range';
  const r = SETTING_RANGES[key];
  input.setAttribute('min', String(r.min));
  input.setAttribute('max', String(r.max));
  input.setAttribute('step', String(r.step));
  input.value = String(value);
  return input;
}

const showValue: Readonly<Record<keyof typeof SETTING_RANGES, (v: number) => string>> = {
  fov: (v) => `${v}°`,
  sensitivity: (v) => `×${v.toFixed(1)}`,
  brightness: (v) => `${Math.round(v * 100)} %`,
};

export function mountHelp(host: HTMLElement, o: HelpOptions): Help {
  let settings = normalizeSettings(o.settings);
  let isOpen = false;
  const change = (patch: Partial<WorldSettings>): void => {
    settings = normalizeSettings({ ...settings, ...patch });
    o.onSettings({ ...settings });
  };

  const overlay = el('div', 'world-help');
  overlay.id = 'world-help';
  overlay.hidden = true;
  const closeButton = el('button', 'help-close', 'Close');
  closeButton.id = 'help-close';
  closeButton.type = 'button';
  closeButton.addEventListener('click', () => close());

  // Settings.
  const settingsSection = el('section', 'help-settings');
  settingsSection.id = 'help-settings';
  const rd = rdSelect(o.report, settings.rd);
  rd.addEventListener('change', () => change({ rd: rd.value === '' ? null : Number(rd.value) }));
  const fps = fpsSelect(settings.fpsCap);
  fps.addEventListener('change', () => change({ fpsCap: Number(fps.value) as WorldSettings['fpsCap'] }));
  settingsSection.append(
    el('h3', '', 'Settings'),
    settingRow('Render distance (reloads)', rd),
    settingRow('FPS cap', fps),
  );
  const ranges: [string, keyof typeof SETTING_RANGES, string][] = [
    ['setting-fov', 'fov', 'Field of view'],
    ['setting-sensitivity', 'sensitivity', 'Mouse sensitivity'],
    ['setting-brightness', 'brightness', 'Brightness'],
  ];
  for (const [id, key, label] of ranges) {
    const input = rangeInput(id, key, settings[key]);
    const shown = el('span', 'help-setting-value', showValue[key](settings[key]));
    input.addEventListener('input', () => {
      change({ [key]: Number(input.value) });
      shown.textContent = showValue[key](settings[key]);
    });
    settingsSection.append(settingRow(label, input, shown));
  }

  // System.
  const system = el('section', 'help-system');
  system.id = 'help-system';
  const report = el('div');
  renderCapabilityReport(report, o.report, o.evaluation);
  system.append(el('h3', '', 'System'), report);

  // Links.
  const mapHere = el('a', 'help-link', 'Open the map here');
  mapHere.id = 'help-map-here';
  mapHere.addEventListener('click', (e) => {
    if (o.navigate === undefined) return;
    e.preventDefault();
    o.navigate(o.mapHereHref());
  });
  const fullscreen = el('button', 'help-link', 'Fullscreen');
  fullscreen.id = 'help-fullscreen';
  fullscreen.type = 'button';
  fullscreen.addEventListener('click', () => o.onFullscreen());
  const links = el('nav', 'help-links');
  links.append(mapHere, fullscreen);

  const head = el('header', 'help-head');
  head.append(el('h2', '', 'Help'), closeButton);
  overlay.append(head, keysSection(o.map), settingsSection, system, links);
  host.append(overlay);

  // Esc closes the open overlay, as a person expects of a panel (final review C-M3). The pointer is already free while
  // the help is open, so the browser's own Esc (releasing the pointer) has nothing to do.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' || e.key === 'Escape') close();
  };

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    overlay.hidden = true;
    document.removeEventListener('keydown', onKeyDown);
    o.onClose();
  }

  return {
    open() {
      mapHere.href = o.mapHereHref();
      if (!isOpen) document.addEventListener('keydown', onKeyDown);
      isOpen = true;
      overlay.hidden = false;
    },
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

function settingRow(label: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const row = el('label', 'help-setting');
  row.append(el('span', 'help-setting-label', label), control);
  if (value !== undefined) row.append(value);
  return row;
}

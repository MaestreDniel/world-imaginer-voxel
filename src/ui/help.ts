/**
 * The help overlay (SP4a spec §7.4, D31): **Keys** generated from the key map, **Settings** (the small block SP5's
 * settings panel replaces; the render distance applies live since SP4b, spec §5), **System** (the capability report
 * with "Copy as JSON" and the hidden `#capability-json`, moved here from the SP0 page, D21, then the render distance's
 * maximum), and the buttons "Map (M)" (SP4c spec §1.6, D20: it closes the help and opens the map overlay; SP4a's link
 * to `?map`, which navigated away from the world, is gone) and "Fullscreen". All text goes through `textContent`. The
 * page opens it on H or F1 and releases the pointer; H, F1 or Esc closes it, and clicking the canvas re-locks.
 */
import type { CapabilityReport, Evaluation } from '../engine/capabilityRules';
import { defaultRenderDistance, RD_MIN } from '../engine/renderDistance';
import { bindingLabel, type KeyEntry } from '../player/keymap';
import { renderCapabilityReport } from './capabilityReport';
import { el } from './common/dom';
import { FPS_CAPS, normalizeSettings, SETTING_RANGES, type WorldSettings } from './settings';

export interface HelpOptions {
  readonly map: readonly KeyEntry[];
  readonly settings: WorldSettings;
  /**
   * Called with the whole new settings after each change; every one applies live. An rd change is the page's cue to
   * apply the render distance live and save it (SP4b spec §5); `setRd` never calls it.
   */
  onSettings(s: WorldSettings): void;
  readonly report: CapabilityReport;
  /**
   * The largest render distance the page offers, min(16, the accepted reservation's cap) (SP4b spec §5): the RD
   * select's last choice, and the System section's "Render distance maximum" row.
   */
  readonly rdMax: number;
  readonly evaluation: Evaluation;
  /** "Map (M)" (SP4c spec §1.6, D20): called after the help closes; the page opens the map overlay. */
  openMap(): void;
  onFullscreen(): void;
  /** Called once each time the overlay closes. */
  onClose(): void;
}

export interface Help {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /**
   * Shows `rd` (null: "Default") in `#setting-rd` and the help's copy of the settings, without calling `onSettings`: a
   * render distance applied elsewhere (a notice's "Lower to RD n") is what a later FOV or brightness change sends back
   * (SP4b spec §5: nothing changes the saved RD except the user).
   */
  setRd(rd: number | null): void;
}

const GROUP_TITLES: Readonly<Record<KeyEntry['group'], string>> = { move: 'Move', speed: 'Speed', world: 'World', view: 'View' };

/**
 * Undo and redo belong to the session, not the key map (SP4c spec §2.4), so the generated table does not name them.
 * Ctrl+Shift+Z also holds Shift (descend) while flying; Ctrl+Y does not.
 */
export const UNDO_REDO_LINE = 'Ctrl+Z undo · Ctrl+Y redo (Ctrl+Shift+Z also descends while flying; Ctrl+Y does not)';

/**
 * One table per group, in the map's order; each row names the action and every binding (spec §7.3); then the undo and
 * redo line.
 */
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
  const undo = el('p', 'help-undo', UNDO_REDO_LINE);
  undo.id = 'help-undo';
  section.append(undo);
  return section;
}

/** The RD choices: "Default (n)", then RD_MIN … rdMax (SP4b spec §5). */
function rdSelect(report: CapabilityReport, rdMax: number): HTMLSelectElement {
  const select = el('select');
  select.id = 'setting-rd';
  const def = el('option', '', `Default (${defaultRenderDistance(report)})`);
  def.value = '';
  select.append(def);
  for (let n = RD_MIN; n <= rdMax; n++) {
    const opt = el('option', '', String(n));
    opt.value = String(n);
    select.append(opt);
  }
  return select;
}

/** Selects `rd` in the RD select ('' for null, "Default"); a saved rd above `rdMax` shows as `rdMax`. */
function showRd(select: HTMLSelectElement, rd: number | null, rdMax: number): void {
  select.value = rd === null ? '' : String(Math.min(rd, rdMax));
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
  const rd = rdSelect(o.report, o.rdMax);
  showRd(rd, settings.rd, o.rdMax);
  rd.addEventListener('change', () => change({ rd: rd.value === '' ? null : Number(rd.value) }));
  const fps = fpsSelect(settings.fpsCap);
  fps.addEventListener('change', () => change({ fpsCap: Number(fps.value) as WorldSettings['fpsCap'] }));
  settingsSection.append(
    el('h3', '', 'Settings'),
    settingRow('Render distance', rd),
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
  // The capability table is shared with the error screen and keyed by the report; the page's own figures follow it.
  const rdMax = el('table', 'cap-table');
  rdMax.id = 'help-rd-max';
  const rdMaxRow = el('tr');
  rdMaxRow.append(el('td', '', 'Render distance maximum'), el('td', '', String(o.rdMax)));
  rdMax.append(rdMaxRow);
  system.append(el('h3', '', 'System'), report, rdMax);

  // Links: the map in the world (nothing navigates) and fullscreen.
  const map = el('button', 'help-link', 'Map (M)');
  map.id = 'help-map';
  map.type = 'button';
  map.addEventListener('click', () => {
    close();
    o.openMap();
  });
  const fullscreen = el('button', 'help-link', 'Fullscreen');
  fullscreen.id = 'help-fullscreen';
  fullscreen.type = 'button';
  fullscreen.addEventListener('click', () => o.onFullscreen());
  const links = el('nav', 'help-links');
  links.append(map, fullscreen);

  const head = el('header', 'help-head');
  head.append(el('h2', '', 'Help'), closeButton);
  overlay.append(head, keysSection(o.map), settingsSection, system, links);
  host.append(overlay);

  // Esc closes the open overlay, as a person expects of a panel (final review C-M3). The pointer is already free while
  // the help is open, so the browser's own Esc (releasing the pointer) has nothing to do. The Esc is consumed: in mode
  // B the map owns the controls while the help is open, and its window shortcut, which skips a default-prevented key,
  // would otherwise also close its drawer or cut tool with the same press (final review WLD-1).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape' && e.key !== 'Escape') return;
    e.preventDefault();
    close();
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
      if (!isOpen) document.addEventListener('keydown', onKeyDown);
      isOpen = true;
      overlay.hidden = false;
    },
    close,
    get isOpen() {
      return isOpen;
    },
    setRd(value) {
      settings = normalizeSettings({ ...settings, rd: value });
      showRd(rd, settings.rd, o.rdMax);
    },
  };
}

function settingRow(label: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const row = el('label', 'help-setting');
  row.append(el('span', 'help-setting-label', label), control);
  if (value !== undefined) row.append(value);
  return row;
}

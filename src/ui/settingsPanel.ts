/**
 * The Settings screen (SP5b spec §1.4, D9), over the start screen (its Settings) or over the world (G, and the help's
 * "Settings (G)"); it replaces the help's settings block (SP4a spec §7.4, D31). Two tabs: **Graphics**, the render
 * distance (applied live since SP4b, spec §5), the FPS cap, the field of view and the brightness, then the rows SP11
 * fills, greyed (disabled elements with no setting behind them); **Controls**, the mouse sensitivity and "Hold mouse
 * button to repeat" (SP5a spec §4.1). The rows keep the help's ids (`#setting-rd`, `#setting-fps-cap`, `#setting-fov`,
 * `#setting-brightness`, `#setting-sensitivity`, `#setting-hold-repeat`). Every change applies at once: `onSettings`
 * gets the whole new settings, which its owner keeps in this browser (`wi.world.settings`, `settings.ts`). The render
 * distance's choices are "Default (n)" and 4 … `rdMax` in the world; from the start screen, where no capability probe
 * runs, "Default" with no number and 4 … 16. Esc closes it and is consumed. All text goes through `textContent`.
 */
import { RD_MAX, RD_MIN } from '../engine/renderDistance';
import { el } from './common/dom';
import { FPS_CAPS, normalizeSettings, SETTING_RANGES, type WorldSettings } from './settings';

export interface SettingsPanelOptions {
  readonly settings: WorldSettings;
  /**
   * Called with the whole new settings after each change; every one applies live. An rd change is the page's cue to
   * apply the render distance live and save it (SP4b spec §5); `setRd` never calls it.
   */
  onSettings(s: WorldSettings): void;
  /**
   * The RD select's last choice: in the world min(16, the accepted reservation's cap) (SP4b spec §5); null from the
   * start screen (16).
   */
  readonly rdMax: number | null;
  /** The number "Default" names (`defaultRenderDistance`): the world's; null from the start screen ("Default"). */
  readonly defaultRd: number | null;
  /** Called once each time the screen closes. */
  onClose(): void;
}

export interface SettingsPanel {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /**
   * Shows `rd` (null: "Default") in `#setting-rd` and the screen's copy of the settings, without calling
   * `onSettings`: a render distance applied elsewhere (a notice's "Lower to RD n") is what a later FOV or brightness
   * change sends back (SP4b spec §5: nothing changes the saved RD except the user).
   */
  setRd(rd: number | null): void;
  /** Removes the screen and its Esc listener; `onClose` is not called. */
  dispose(): void;
}

/** The rows SP11 fills (SP5b spec D9; master §4.16), shown disabled with no setting behind them. */
export const GREYED_ROWS: readonly string[] = ['Fog distance', 'Clouds', 'Shadows', 'Quality preset'];
/** The greyed rows' note. */
export const GREYED_NOTE = 'Coming in SP11';
const QUALITY_PRESETS = ['Low', 'Medium', 'High', 'Ultra'] as const;

/** The RD choices: "Default (n)" (or "Default"), then RD_MIN … rdMax (SP4b spec §5). */
function rdSelect(defaultRd: number | null, rdMax: number): HTMLSelectElement {
  const select = el('select');
  select.id = 'setting-rd';
  const def = el('option', '', defaultRd === null ? 'Default' : `Default (${defaultRd})`);
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

function settingRow(label: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const row = el('label', 'help-setting');
  row.append(el('span', 'help-setting-label', label), control);
  if (value !== undefined) row.append(value);
  return row;
}

/** The greyed rows: a disabled slider, two disabled checkboxes and a disabled Low…Ultra select, none listened to. */
function greyedRows(): HTMLElement {
  const section = el('div', 'settings-greyed');
  section.id = 'settings-greyed';
  const [fog, clouds, shadows, quality] = GREYED_ROWS;
  const fogInput = el('input');
  fogInput.type = 'range';
  const cloudsBox = el('input');
  cloudsBox.type = 'checkbox';
  const shadowsBox = el('input');
  shadowsBox.type = 'checkbox';
  const preset = el('select');
  for (const p of QUALITY_PRESETS) preset.append(el('option', '', p));
  for (const c of [fogInput, cloudsBox, shadowsBox, preset]) {
    c.disabled = true;
    c.setAttribute('aria-disabled', 'true');
  }
  section.append(
    settingRow(fog!, fogInput),
    settingRow(clouds!, cloudsBox),
    settingRow(shadows!, shadowsBox),
    settingRow(quality!, preset),
    el('p', 'settings-greyed-note', GREYED_NOTE),
  );
  section.style.opacity = '0.5';
  return section;
}

export function mountSettingsPanel(host: HTMLElement, o: SettingsPanelOptions): SettingsPanel {
  let settings = normalizeSettings(o.settings);
  let isOpen = false;
  const rdMax = o.rdMax ?? RD_MAX;
  const change = (patch: Partial<WorldSettings>): void => {
    settings = normalizeSettings({ ...settings, ...patch });
    o.onSettings({ ...settings });
  };

  const overlay = el('div', 'world-help settings-panel');
  overlay.id = 'settings-panel';
  overlay.hidden = true;
  const closeButton = el('button', 'help-close', 'Close');
  closeButton.id = 'settings-close';
  closeButton.type = 'button';
  closeButton.addEventListener('click', () => close());

  // Graphics.
  const graphics = el('section', 'help-settings');
  graphics.id = 'settings-graphics';
  const rd = rdSelect(o.defaultRd, rdMax);
  showRd(rd, settings.rd, rdMax);
  rd.addEventListener('change', () => change({ rd: rd.value === '' ? null : Number(rd.value) }));
  const fps = fpsSelect(settings.fpsCap);
  fps.addEventListener('change', () => change({ fpsCap: Number(fps.value) as WorldSettings['fpsCap'] }));
  graphics.append(settingRow('Render distance', rd), settingRow('FPS cap', fps));

  // Controls.
  const controls = el('section', 'help-settings');
  controls.id = 'settings-controls';
  controls.hidden = true;

  const ranges: [HTMLElement, string, keyof typeof SETTING_RANGES, string][] = [
    [graphics, 'setting-fov', 'fov', 'Field of view'],
    [graphics, 'setting-brightness', 'brightness', 'Brightness'],
    [controls, 'setting-sensitivity', 'sensitivity', 'Mouse sensitivity'],
  ];
  for (const [section, id, key, label] of ranges) {
    const input = rangeInput(id, key, settings[key]);
    const shown = el('span', 'help-setting-value', showValue[key](settings[key]));
    input.addEventListener('input', () => {
      change({ [key]: Number(input.value) });
      shown.textContent = showValue[key](settings[key]);
    });
    section.append(settingRow(label, input, shown));
  }
  graphics.append(greyedRows());
  // Hold to repeat (SP5a spec §4.1, D6): off by default, remembered with the other settings.
  const holdRepeat = el('input');
  holdRepeat.id = 'setting-hold-repeat';
  holdRepeat.type = 'checkbox';
  holdRepeat.checked = settings.holdRepeat;
  holdRepeat.addEventListener('change', () => change({ holdRepeat: holdRepeat.checked }));
  controls.append(settingRow('Hold mouse button to repeat', holdRepeat));

  // The tabs: one section shown at a time, Graphics first.
  const tab = (id: string, text: string, section: HTMLElement): HTMLButtonElement => {
    const b = el('button', 'help-link', text);
    b.id = id;
    b.type = 'button';
    b.addEventListener('click', () => select(section));
    return b;
  };
  const graphicsTab = tab('settings-tab-graphics', 'Graphics', graphics);
  const controlsTab = tab('settings-tab-controls', 'Controls', controls);
  const select = (section: HTMLElement): void => {
    graphics.hidden = section !== graphics;
    controls.hidden = section !== controls;
    graphicsTab.setAttribute('aria-selected', String(section === graphics));
    controlsTab.setAttribute('aria-selected', String(section === controls));
  };
  select(graphics);
  const tabs = el('nav', 'help-links');
  tabs.setAttribute('role', 'tablist');
  tabs.append(graphicsTab, controlsTab);

  const head = el('header', 'help-head');
  head.append(el('h2', '', 'Settings'), closeButton);
  overlay.append(head, tabs, graphics, controls);
  host.append(overlay);

  // Esc closes the screen, and is consumed, as the help's (final review C-M3, WLD-1): in mode B the map owns the
  // controls while the screen is open, and its window shortcut, which skips a default-prevented key, would otherwise
  // also close its drawer or cut tool with the same press.
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
      showRd(rd, settings.rd, rdMax);
    },
    dispose() {
      if (isOpen) document.removeEventListener('keydown', onKeyDown);
      isOpen = false;
      overlay.remove();
    },
  };
}

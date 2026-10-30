/**
 * The help overlay (SP4a spec §7.4, D31): **Keys** generated from the key map, **System** (the capability report with
 * "Copy as JSON" and the hidden `#capability-json`, moved here from the SP0 page, D21, then the render distance's
 * maximum), and the buttons "Map (M)" (SP4c spec §1.6, D20: it closes the help and opens the map overlay; SP4a's link
 * to `?map`, which navigated away from the world, is gone), "Settings (G)" (it closes the help and opens the Settings
 * screen, `settingsPanel.ts`, which took the help's settings block in SP5b, spec §1.4, D9), "Worlds menu" (SP5b spec
 * D31: the page saves, then opens `/`) and "Fullscreen". All text goes through `textContent`. The page opens it on H or
 * F1 and releases the pointer; H, F1 or Esc closes it, and clicking the canvas re-locks.
 */
import type { CapabilityReport, Evaluation } from '../engine/capabilityRules';
import { bindingLabel, type KeyEntry } from '../player/keymap';
import { renderCapabilityReport } from './capabilityReport';
import { el } from './common/dom';

export interface HelpOptions {
  readonly map: readonly KeyEntry[];
  readonly report: CapabilityReport;
  /**
   * The largest render distance the page offers, min(16, the accepted reservation's cap) (SP4b spec §5): the System
   * section's "Render distance maximum" row.
   */
  readonly rdMax: number;
  readonly evaluation: Evaluation;
  /** "Map (M)" (SP4c spec §1.6, D20): called after the help closes; the page opens the map overlay. */
  openMap(): void;
  /** "Settings (G)" (SP5b spec §1.4, D9): called after the help closes; the page opens the Settings screen. */
  openSettings(): void;
  /** "Worlds menu" (SP5b spec D31): the page saves a saved world (at most 1 s), then navigates to `/`. */
  worldsMenu(): void;
  onFullscreen(): void;
  /** Called once each time the overlay closes. */
  onClose(): void;
}

export interface Help {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

const GROUP_TITLES: Readonly<Record<KeyEntry['group'], string>> = {
  move: 'Move', speed: 'Speed', world: 'World', view: 'View', build: 'Build',
};

/**
 * Undo and redo are not in the key map (SP4c spec §2.4), so the generated table does not name them; they act on the
 * blocks while the world owns the controls and on the map's settings while the map does (SP5a spec §4.5). Ctrl+Shift+Z
 * also holds Shift (descend) while flying; Ctrl+Y does not.
 */
export const UNDO_REDO_LINE = 'Ctrl+Z undo · Ctrl+Y redo: blocks while you play, the map\'s settings while the map has the controls (Ctrl+Shift+Z also descends while flying; Ctrl+Y does not)';

/**
 * Ctrl+1 … Ctrl+8 switch the browser's tabs, which a page cannot stop (SP5a spec D9, §4.6): the digits pick a hotbar
 * slot only without Ctrl, which a player may still hold for Ctrl+wheel or the undo keys (Ctrl was sprint until Task 45b).
 */
export const CTRL_DIGIT_NOTE = 'Let go of Ctrl before a digit: Ctrl+1 … Ctrl+8 switch the browser\'s tabs';

/**
 * One table per group, in the map's order; each row names the action and every binding (spec §7.3); then the undo and
 * redo line and the note on Ctrl before a digit.
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
  const ctrlDigit = el('p', 'help-ctrl-digit', CTRL_DIGIT_NOTE);
  ctrlDigit.id = 'help-ctrl-digit';
  section.append(undo, ctrlDigit);
  return section;
}

export function mountHelp(host: HTMLElement, o: HelpOptions): Help {
  let isOpen = false;

  const overlay = el('div', 'world-help');
  overlay.id = 'world-help';
  overlay.hidden = true;
  const closeButton = el('button', 'help-close', 'Close');
  closeButton.id = 'help-close';
  closeButton.type = 'button';
  closeButton.addEventListener('click', () => close());

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

  // Links: the map and the Settings screen in the world (nothing navigates), the worlds menu and fullscreen.
  const link = (id: string, text: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'help-link', text);
    b.id = id;
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const links = el('nav', 'help-links');
  links.append(
    link('help-map', 'Map (M)', () => {
      close();
      o.openMap();
    }),
    link('help-open-settings', 'Settings (G)', () => {
      close();
      o.openSettings();
    }),
    link('help-worlds-menu', 'Worlds menu', () => o.worldsMenu()),
    link('help-fullscreen', 'Fullscreen', () => o.onFullscreen()),
  );

  const head = el('header', 'help-head');
  head.append(el('h2', '', 'Help'), closeButton);
  overlay.append(head, keysSection(o.map), system, links);
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
  };
}

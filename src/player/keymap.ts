import type { SubProjectId } from '../core/ids';

/**
 * The key map as data (SP4a spec §7.3, D19). Actions are bound to physical keys (`KeyboardEvent.code`), so W A S D stay
 * where they are on any layout (the user's Spanish one included), except `+`, `=` and `-`, matched by
 * `KeyboardEvent.key` because a Spanish keyboard types them unshifted at other positions. The input layer resolves
 * events through this list and never names a key elsewhere; the help, the tips and the HUD's hints are generated from
 * it. SP10's remapping panel would merge a second list over it, and every later SP that adds keys extends it
 * (master §10 SP4).
 */

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'up' | 'down' | 'sprint' | 'speedUp' | 'speedDown'
  | 'timeSpeed' | 'help' | 'hud' | 'releasePointer' | 'map'
  | 'toggleWalk' | 'palette'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slot6' | 'slot7' | 'slot8' | 'slot9' | 'slotNext' | 'slotPrev';

/** A wheel binding names its Ctrl modifier: Ctrl+wheel and the plain wheel are two bindings (SP5a spec §4.1, D9). */
export type Binding =
  | { kind: 'code'; code: string }
  | { kind: 'key'; key: string }
  | { kind: 'wheel'; dir: 'up' | 'down'; ctrl: boolean };

export interface KeyEntry {
  readonly action: Action;
  readonly bindings: readonly Binding[];
  readonly label: string;
  readonly group: 'move' | 'speed' | 'world' | 'view' | 'build';
  readonly since: SubProjectId;
}

const code = (c: string): Binding => ({ kind: 'code', code: c });
const key = (k: string): Binding => ({ kind: 'key', key: k });
const wheel = (dir: 'up' | 'down', ctrl: boolean): Binding => ({ kind: 'wheel', dir, ctrl });

/**
 * SP4a's actions, as spec §7.3 lists them, with SP4b's flight labels (SP4b spec §6.1) and without R, which loaded the
 * world around the camera until SP4b streamed it (SP4b spec §6.2, D20: R is unbound); then SP4c's M, the map over the
 * world (SP4c spec §2.4, D15), the one action that acts whoever owns the controls; then SP5a's build group (SP5a spec
 * §4.1, D9): F, E, the digits by code (a shifted or AZERTY digit still selects its slot) and the plain wheel, which
 * took the wheel from the flying speed, now on Ctrl+wheel. While walking the page ignores `+`/`-` and resolves Ctrl+wheel
 * as the plain wheel (input.ts `wheelCtrlAsSlot`).
 */
export const DEFAULT_KEYMAP: readonly KeyEntry[] = [
  { action: 'forward', bindings: [code('KeyW')], label: 'Forward (at your height)', group: 'move', since: 'SP4a' },
  { action: 'left', bindings: [code('KeyA')], label: 'Left', group: 'move', since: 'SP4a' },
  { action: 'back', bindings: [code('KeyS')], label: 'Back (at your height)', group: 'move', since: 'SP4a' },
  { action: 'right', bindings: [code('KeyD')], label: 'Right', group: 'move', since: 'SP4a' },
  { action: 'up', bindings: [code('Space')], label: 'Rise', group: 'move', since: 'SP4a' },
  { action: 'down', bindings: [code('ShiftLeft'), code('ShiftRight')], label: 'Descend', group: 'move', since: 'SP4a' },
  { action: 'sprint', bindings: [code('ControlLeft'), code('ControlRight')], label: 'Sprint (×4 while held)', group: 'move', since: 'SP4a' },
  { action: 'speedUp', bindings: [wheel('up', true), key('+'), key('=')], label: 'Fly faster', group: 'speed', since: 'SP4a' },
  { action: 'speedDown', bindings: [wheel('down', true), key('-')], label: 'Fly slower', group: 'speed', since: 'SP4a' },
  { action: 'timeSpeed', bindings: [code('KeyT')], label: 'Time speed (×1, ×10, ×60, paused)', group: 'world', since: 'SP4a' },
  { action: 'help', bindings: [code('KeyH'), code('F1')], label: 'Help and settings', group: 'view', since: 'SP4a' },
  { action: 'hud', bindings: [code('F3')], label: 'Show or hide the counts', group: 'view', since: 'SP4a' },
  { action: 'releasePointer', bindings: [code('Escape')], label: 'Release the pointer', group: 'view', since: 'SP4a' },
  { action: 'map', bindings: [code('KeyM')], label: 'Map: teleport and live editing', group: 'view', since: 'SP4c' },
  { action: 'toggleWalk', bindings: [code('KeyF')], label: 'Walk or fly', group: 'build', since: 'SP5a' },
  { action: 'palette', bindings: [code('KeyE')], label: 'Block palette', group: 'build', since: 'SP5a' },
  { action: 'slot1', bindings: [code('Digit1')], label: 'Hotbar slot 1', group: 'build', since: 'SP5a' },
  { action: 'slot2', bindings: [code('Digit2')], label: 'Hotbar slot 2', group: 'build', since: 'SP5a' },
  { action: 'slot3', bindings: [code('Digit3')], label: 'Hotbar slot 3', group: 'build', since: 'SP5a' },
  { action: 'slot4', bindings: [code('Digit4')], label: 'Hotbar slot 4', group: 'build', since: 'SP5a' },
  { action: 'slot5', bindings: [code('Digit5')], label: 'Hotbar slot 5', group: 'build', since: 'SP5a' },
  { action: 'slot6', bindings: [code('Digit6')], label: 'Hotbar slot 6', group: 'build', since: 'SP5a' },
  { action: 'slot7', bindings: [code('Digit7')], label: 'Hotbar slot 7', group: 'build', since: 'SP5a' },
  { action: 'slot8', bindings: [code('Digit8')], label: 'Hotbar slot 8', group: 'build', since: 'SP5a' },
  { action: 'slot9', bindings: [code('Digit9')], label: 'Hotbar slot 9', group: 'build', since: 'SP5a' },
  { action: 'slotNext', bindings: [wheel('down', false)], label: 'Next hotbar slot', group: 'build', since: 'SP5a' },
  { action: 'slotPrev', bindings: [wheel('up', false)], label: 'Previous hotbar slot', group: 'build', since: 'SP5a' },
];

/**
 * Actions that are listed (the help and the tips name them) but never resolved: the browser owns Esc, which releases
 * the pointer lock on its own (spec §7.1, §7.3 "Esc, listed only").
 */
export const LISTED_ONLY: ReadonlySet<Action> = new Set<Action>(['releasePointer']);

/**
 * The action a key event triggers, or null. Code bindings are matched first, over the whole map, so a physical
 * binding always wins over a `key:` binding of another action whatever the layout types there.
 */
export function resolveKey(e: { code: string; key: string }, map: readonly KeyEntry[] = DEFAULT_KEYMAP): Action | null {
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action)) continue;
    for (const b of entry.bindings) if (b.kind === 'code' && b.code === e.code) return entry.action;
  }
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action)) continue;
    for (const b of entry.bindings) if (b.kind === 'key' && b.key === e.key) return entry.action;
  }
  return null;
}

/**
 * The action of a wheel step by its sign (negative: up, away from the user) and its Ctrl modifier, or null for 0. The
 * modifier must match: Ctrl+wheel is `speedUp`/`speedDown`, the plain wheel `slotPrev`/`slotNext` (SP5a spec §4.1).
 * The input layer turns raw `deltaY`s into steps first (input.ts `createWheelSteps`: one step per notch or per 100 px
 * of a touchpad swipe).
 */
export function resolveWheel(deltaY: number, ctrl: boolean, map: readonly KeyEntry[] = DEFAULT_KEYMAP): Action | null {
  if (!(deltaY < 0 || deltaY > 0)) return null; // 0, and NaN from a broken event
  const dir = deltaY < 0 ? 'up' : 'down';
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action)) continue;
    for (const b of entry.bindings) if (b.kind === 'wheel' && b.dir === dir && b.ctrl === ctrl) return entry.action;
  }
  return null;
}

/** People's names for the codes that are not a letter, a digit or a function key. */
const CODE_LABELS: Readonly<Record<string, string>> = {
  Space: 'Space',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/**
 * A binding's label for the help, the tips and the HUD's hints (`KeyW` → "W", `ShiftLeft` → "Left Shift", Ctrl+wheel
 * up → "Ctrl+Wheel up").
 */
export function bindingLabel(b: Binding): string {
  if (b.kind === 'wheel') return `${b.ctrl ? 'Ctrl+' : ''}${b.dir === 'up' ? 'Wheel up' : 'Wheel down'}`;
  if (b.kind === 'key') return b.key;
  const named = CODE_LABELS[b.code];
  if (named !== undefined) return named;
  const m = /^(?:Key|Digit)(.)$/.exec(b.code);
  return m ? m[1]! : b.code;
}

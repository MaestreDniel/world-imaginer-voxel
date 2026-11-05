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
  | 'savePlace' | 'settings'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slot6' | 'slot7' | 'slot8' | 'slot9' | 'slotNext' | 'slotPrev'
  | 'selectTool' | 'copy' | 'cut' | 'paste' | 'move' | 'turn' | 'turnBack' | 'raise' | 'lower'
  | 'xray' | 'xrayDown' | 'xrayUp' | 'xrayAll' | 'nightVision';

/**
 * A wheel binding names its Ctrl modifier: Ctrl+wheel and the plain wheel are two bindings (SP5a spec §4.1, D9). A code
 * binding's `ctrl` (SP5c spec §1.1, D4): absent, it matches with or without Ctrl (moving with Ctrl held); `true`, only
 * with Ctrl or Cmd held and Alt not held (AltGr sets both Ctrl and Alt, as `shortcutFor` refuses it,
 * `ui/common/keys.ts`); `false`, only without Ctrl or Cmd.
 */
export type Binding =
  | { kind: 'code'; code: string; ctrl?: boolean }
  | { kind: 'key'; key: string }
  | { kind: 'wheel'; dir: 'up' | 'down'; ctrl: boolean };

export interface KeyEntry {
  readonly action: Action;
  readonly bindings: readonly Binding[];
  readonly label: string;
  readonly group: 'move' | 'speed' | 'world' | 'view' | 'build' | 'select';
  readonly since: SubProjectId;
}

const code = (c: string, ctrl?: boolean): Binding => (ctrl === undefined ? { kind: 'code', code: c } : { kind: 'code', code: c, ctrl });
const key = (k: string): Binding => ({ kind: 'key', key: k });
const wheel = (dir: 'up' | 'down', ctrl: boolean): Binding => ({ kind: 'wheel', dir, ctrl });

/**
 * SP4a's actions, as spec §7.3 lists them, with SP4b's flight labels (SP4b spec §6.1) and without R, which loaded the
 * world around the camera until SP4b streamed it (SP4b spec §6.2, D20: R is unbound until SP5a's sprint); then SP4c's M,
 * the map over the world (SP4c spec §2.4, D15), the one action that acts whoever owns the controls; then SP5a's build
 * group (SP5a spec §4.1, D9): F, E, the digits by code (a shifted or AZERTY digit still selects its slot) and the plain
 * wheel, which took the wheel from the flying speed, now on Ctrl+wheel. While walking the page ignores `+`/`-` and
 * resolves Ctrl+wheel as the plain wheel (input.ts `wheelCtrlAsSlot`). Sprint is R since Task 45b (Ctrl+W closes the
 * tab, the user's finding at SP5a's production check); its double-tapped W is the input's (input.ts, `sprintTap.ts`).
 * SP5b adds B, which saves a place in a saved world, and G, the Settings screen, which takes the settings out of the
 * help (SP5b spec §1.4, §3.7). SP5c adds the selection tool's group (SP5c spec §1.1, D4): Q and N without Ctrl, Ctrl+C,
 * Ctrl+X and Ctrl+V (`ctrl: true`, matched first), and the four keys that act only while placing a paste or a move (the
 * placing context, `placingContext`): there the plain wheel turns the paste instead of stepping the hotbar slot
 * (`slotNext`, `slotPrev`), and ↑ and ↓ raise and lower it. SP6a adds five view keys (SP6a spec §7.1, D10, D11, D15):
 * X, the X-ray; PageDown and PageUp, its depth band; Home, every depth; L, night vision. All five are `ctrl: false`, so
 * Ctrl+X stays the cut and the browser keeps Ctrl+PageDown, Ctrl+PageUp (the tabs), Ctrl+Home and Ctrl+L (the address
 * bar): a binding without `ctrl` would match them and have their default prevented.
 */
export const DEFAULT_KEYMAP: readonly KeyEntry[] = [
  { action: 'forward', bindings: [code('KeyW')], label: 'Forward (at your height)', group: 'move', since: 'SP4a' },
  { action: 'left', bindings: [code('KeyA')], label: 'Left', group: 'move', since: 'SP4a' },
  { action: 'back', bindings: [code('KeyS')], label: 'Back (at your height)', group: 'move', since: 'SP4a' },
  { action: 'right', bindings: [code('KeyD')], label: 'Right', group: 'move', since: 'SP4a' },
  { action: 'up', bindings: [code('Space')], label: 'Rise', group: 'move', since: 'SP4a' },
  { action: 'down', bindings: [code('ShiftLeft'), code('ShiftRight')], label: 'Descend', group: 'move', since: 'SP4a' },
  { action: 'sprint', bindings: [code('KeyR')], label: 'Sprint (hold R, or double-tap W)', group: 'move', since: 'SP4a' },
  { action: 'speedUp', bindings: [wheel('up', true), key('+'), key('=')], label: 'Fly faster', group: 'speed', since: 'SP4a' },
  { action: 'speedDown', bindings: [wheel('down', true), key('-')], label: 'Fly slower', group: 'speed', since: 'SP4a' },
  { action: 'timeSpeed', bindings: [code('KeyT')], label: 'Time speed (×1, ×10, ×60, paused)', group: 'world', since: 'SP4a' },
  { action: 'savePlace', bindings: [code('KeyB')], label: 'Save this place', group: 'world', since: 'SP5b' },
  { action: 'help', bindings: [code('KeyH'), code('F1')], label: 'Help', group: 'view', since: 'SP4a' },
  { action: 'settings', bindings: [code('KeyG')], label: 'Settings', group: 'view', since: 'SP5b' },
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
  { action: 'selectTool', bindings: [code('KeyQ', false)], label: 'Selection tool on or off', group: 'select', since: 'SP5c' },
  { action: 'copy', bindings: [code('KeyC', true)], label: 'Copy the selection', group: 'select', since: 'SP5c' },
  { action: 'cut', bindings: [code('KeyX', true)], label: 'Cut the selection', group: 'select', since: 'SP5c' },
  { action: 'paste', bindings: [code('KeyV', true)], label: 'Paste', group: 'select', since: 'SP5c' },
  { action: 'move', bindings: [code('KeyN', false)], label: 'Move the selection', group: 'select', since: 'SP5c' },
  { action: 'turn', bindings: [wheel('down', false)], label: 'Turn the paste 90° clockwise', group: 'select', since: 'SP5c' },
  { action: 'turnBack', bindings: [wheel('up', false)], label: 'Turn the paste back 90°', group: 'select', since: 'SP5c' },
  { action: 'raise', bindings: [code('ArrowUp', false)], label: 'Raise the paste', group: 'select', since: 'SP5c' },
  { action: 'lower', bindings: [code('ArrowDown', false)], label: 'Lower the paste', group: 'select', since: 'SP5c' },
  { action: 'xray', bindings: [code('KeyX', false)], label: 'X-ray on or off', group: 'view', since: 'SP6a' },
  { action: 'xrayDown', bindings: [code('PageDown', false)], label: 'Move the X-ray band down', group: 'view', since: 'SP6a' },
  { action: 'xrayUp', bindings: [code('PageUp', false)], label: 'Move the X-ray band up', group: 'view', since: 'SP6a' },
  { action: 'xrayAll', bindings: [code('Home', false)], label: 'Show every depth in the X-ray', group: 'view', since: 'SP6a' },
  { action: 'nightVision', bindings: [code('KeyL', false)], label: 'Night vision on or off', group: 'view', since: 'SP6a' },
];

/**
 * Actions that are listed (the help and the tips name them) but never resolved: the browser owns Esc, which releases
 * the pointer lock on its own (spec §7.1, §7.3 "Esc, listed only").
 */
export const LISTED_ONLY: ReadonlySet<Action> = new Set<Action>(['releasePointer']);

/** The actions that act only while a paste or a move is being placed (SP5c spec §1.1, the placing context). */
export const PLACING_ACTIONS: ReadonlySet<Action> = new Set<Action>(['turn', 'turnBack', 'raise', 'lower']);

/** While placing, the plain wheel turns the paste: the hotbar's wheel actions are the ones it replaces. */
const SLOT_WHEEL: ReadonlySet<Action> = new Set<Action>(['slotNext', 'slotPrev']);

const whilePlacing = (a: Action): boolean => !SLOT_WHEEL.has(a);
const notPlacing = (a: Action): boolean => !PLACING_ACTIONS.has(a);

/**
 * The placing context (SP5c spec §1.1): while placing, `turn`, `turnBack`, `raise` and `lower` are active and `slotNext`
 * and `slotPrev` are not; otherwise the reverse. Every other action is active in both. The two predicates are made once,
 * so resolving a key or a wheel step allocates nothing.
 */
export function placingContext(placing: boolean): (a: Action) => boolean {
  return placing ? whilePlacing : notPlacing;
}

/** Whether a code binding matches the event's code and modifiers (`Binding`'s `ctrl`; Cmd counts as Ctrl). */
function codeMatches(b: { code: string; ctrl?: boolean }, e: { code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (b.code !== e.code) return false;
  if (b.ctrl === undefined) return true;
  const ctrl = e.ctrlKey === true || e.metaKey === true;
  return b.ctrl ? ctrl && e.altKey !== true : !ctrl;
}

/**
 * The action a key event triggers, or null. Code bindings are matched first, over the whole map, so a physical
 * binding always wins over a `key:` binding of another action whatever the layout types there; among them the
 * `ctrl: true` ones come first (SP5c spec §1.1), so Ctrl+C is a copy even where another action held C without a
 * modifier. An entry whose action `active` refuses is skipped (the placing context), and the search goes on.
 */
export function resolveKey(
  e: { code: string; key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  map: readonly KeyEntry[] = DEFAULT_KEYMAP,
  active?: (a: Action) => boolean,
): Action | null {
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action) || (active !== undefined && !active(entry.action))) continue;
    for (const b of entry.bindings) if (b.kind === 'code' && b.ctrl === true && codeMatches(b, e)) return entry.action;
  }
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action) || (active !== undefined && !active(entry.action))) continue;
    for (const b of entry.bindings) if (b.kind === 'code' && b.ctrl !== true && codeMatches(b, e)) return entry.action;
  }
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action) || (active !== undefined && !active(entry.action))) continue;
    for (const b of entry.bindings) if (b.kind === 'key' && b.key === e.key) return entry.action;
  }
  return null;
}

/**
 * The action of a wheel step by its sign (negative: up, away from the user) and its Ctrl modifier, or null for 0. The
 * modifier must match: Ctrl+wheel is `speedUp`/`speedDown`, the plain wheel `slotPrev`/`slotNext` (SP5a spec §4.1), or
 * `turnBack`/`turn` while placing (`active`, the placing context; SP5c spec §1.1). The input layer turns raw `deltaY`s
 * into steps first (input.ts `createWheelSteps`: one step per notch or per 100 px of a touchpad swipe).
 */
export function resolveWheel(
  deltaY: number,
  ctrl: boolean,
  map: readonly KeyEntry[] = DEFAULT_KEYMAP,
  active?: (a: Action) => boolean,
): Action | null {
  if (!(deltaY < 0 || deltaY > 0)) return null; // 0, and NaN from a broken event
  const dir = deltaY < 0 ? 'up' : 'down';
  for (const entry of map) {
    if (LISTED_ONLY.has(entry.action) || (active !== undefined && !active(entry.action))) continue;
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
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
};

/**
 * A binding's label for the help, the tips and the HUD's hints (`KeyW` → "W", `ShiftLeft` → "Left Shift", Ctrl+wheel
 * up → "Ctrl+Wheel up", a `ctrl: true` `KeyC` → "Ctrl+C").
 */
export function bindingLabel(b: Binding): string {
  if (b.kind === 'wheel') return `${b.ctrl ? 'Ctrl+' : ''}${b.dir === 'up' ? 'Wheel up' : 'Wheel down'}`;
  if (b.kind === 'key') return b.key;
  const prefix = b.ctrl === true ? 'Ctrl+' : '';
  const named = CODE_LABELS[b.code];
  if (named !== undefined) return prefix + named;
  const m = /^(?:Key|Digit)(.)$/.exec(b.code);
  return prefix + (m ? m[1]! : b.code);
}

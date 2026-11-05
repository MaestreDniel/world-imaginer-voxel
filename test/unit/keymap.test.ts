import { describe, expect, test } from 'vitest';
import {
  DEFAULT_KEYMAP, LISTED_ONLY, PLACING_ACTIONS, bindingLabel, placingContext, resolveKey, resolveWheel, type Action, type Binding,
  type KeyEntry,
} from '../../src/player/keymap';

/** SP5a's build group (SP5a spec §4.1): F, E, 1-9 and the plain wheel. */
const BUILD: readonly Action[] = [
  'toggleWalk', 'palette', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9', 'slotNext', 'slotPrev',
];

/** SP5b's B and G (SP5b spec §3.7): save a place, the Settings screen. */
const SP5B: readonly Action[] = ['savePlace', 'settings'];

/** SP5c's selection tool (SP5c spec §1.1, D4): Q, Ctrl+C, Ctrl+X, Ctrl+V, N, and while placing the wheel, ↑ and ↓. */
const SELECT: readonly Action[] = ['selectTool', 'copy', 'cut', 'paste', 'move', 'turn', 'turnBack', 'raise', 'lower'];

/** SP6a's view keys (SP6a spec §7.1, D10, D11, D15): X, PageDown, PageUp, Home and L, each without Ctrl. */
const SP6A: readonly Action[] = ['xray', 'xrayDown', 'xrayUp', 'xrayAll', 'nightVision'];

/**
 * Every action of SP4a spec §7.3 but R's loadHere (removed by SP4b spec §6.2), SP4c's M (SP4c spec §2.4), SP5a's build group
 * (SP5a spec §4.1), SP5b's B and G (SP5b spec §3.7), SP5c's selection tool (SP5c spec §1.1) and SP6a's view keys (SP6a
 * spec §7.1), spelled out so that a missing map entry fails here.
 */
const ACTIONS: readonly Action[] = [
  'forward', 'back', 'left', 'right', 'up', 'down', 'sprint', 'speedUp', 'speedDown',
  'timeSpeed', 'help', 'hud', 'releasePointer', 'map', ...BUILD, ...SP5B, ...SELECT, ...SP6A,
];

/** A code binding's Ctrl: absent (with or without), `+ctrl` (only with Ctrl or Cmd), `-ctrl` (only without). */
const bindingKey = (b: Binding): string =>
  (b.kind === 'code'
    ? `code:${b.code}${b.ctrl === undefined ? '' : b.ctrl ? '+ctrl' : '-ctrl'}`
    : b.kind === 'key' ? `key:${b.key}` : `wheel:${b.dir}${b.ctrl ? '+ctrl' : ''}`);

/** Whether one event can match both bindings: a code binding with no `ctrl` matches with Ctrl held or not. */
const overlaps = (a: Binding, b: Binding): boolean => {
  if (a.kind === 'code' && b.kind === 'code') return a.code === b.code && (a.ctrl === undefined || b.ctrl === undefined || a.ctrl === b.ctrl);
  if (a.kind === 'key' && b.kind === 'key') return a.key === b.key;
  if (a.kind === 'wheel' && b.kind === 'wheel') return a.dir === b.dir && a.ctrl === b.ctrl;
  return false;
};

describe('the key map as data (SP4a spec §7.3, D19)', () => {
  test('every Action is bound or listed', () => {
    for (const a of ACTIONS) {
      const entries = DEFAULT_KEYMAP.filter((e) => e.action === a);
      expect(entries, a).toHaveLength(1);
      expect(entries[0]!.bindings.length, `${a} has no binding`).toBeGreaterThan(0);
      expect(entries[0]!.label, a).not.toBe('');
    }
    expect(DEFAULT_KEYMAP).toHaveLength(ACTIONS.length);
    expect(DEFAULT_KEYMAP).toHaveLength(43);
    // Esc is listed (the help names it) but the browser owns it: the input layer never resolves it.
    expect([...LISTED_ONLY]).toEqual(['releasePointer']);
    expect(resolveKey({ code: 'Escape', key: 'Escape' })).toBeNull();
    // Every entry is SP4a's except SP4c's map (SP4c spec §2.4), SP5a's build group (SP5a spec §4.1), SP5b's B and G
    // (SP5b spec §3.7), SP5c's selection tool (SP5c spec §1.1) and SP6a's view keys (SP6a spec §7.1).
    const since = (a: Action) =>
      (a === 'map' ? 'SP4c' : BUILD.includes(a) ? 'SP5a' : SP5B.includes(a) ? 'SP5b' : SELECT.includes(a) ? 'SP5c'
        : SP6A.includes(a) ? 'SP6a' : 'SP4a');
    for (const e of DEFAULT_KEYMAP) expect(e.since, e.action).toBe(since(e.action));
    for (const e of DEFAULT_KEYMAP) expect(e.group === 'build', e.action).toBe(BUILD.includes(e.action));
    for (const e of DEFAULT_KEYMAP) expect(e.group === 'select', e.action).toBe(SELECT.includes(e.action));
    // The selection tool appended after slotPrev, then SP6a's view keys after lower, each in its spec's order.
    expect(DEFAULT_KEYMAP.slice(-14, -5).map((e) => e.action)).toEqual(SELECT);
    expect(DEFAULT_KEYMAP.slice(-5).map((e) => e.action)).toEqual(SP6A);
    for (const a of SP6A) expect(DEFAULT_KEYMAP.find((e) => e.action === a)!.group, a).toBe('view');
  });

  test('M opens the map: KeyM resolves to map, in the view group (SP4c spec §2.4, D15)', () => {
    expect(DEFAULT_KEYMAP.find((e) => e.action === 'map')).toEqual({
      action: 'map', bindings: [{ kind: 'code', code: 'KeyM' }], label: 'Map: teleport and live editing', group: 'view', since: 'SP4c',
    });
    expect(resolveKey({ code: 'KeyM', key: 'm' })).toBe('map');
    // The physical key: a layout typing something else at KeyM still opens the map.
    expect(resolveKey({ code: 'KeyM', key: ',' })).toBe('map');
  });

  test('a binding shared by two actions is between actions whose contexts exclude each other: only the plain wheel\'s slotNext/turn and slotPrev/turnBack (SP5c spec §1.1)', () => {
    const shared: Array<[Action, Action]> = [];
    for (let i = 0; i < DEFAULT_KEYMAP.length; i++) {
      for (let j = i + 1; j < DEFAULT_KEYMAP.length; j++) {
        const a = DEFAULT_KEYMAP[i]!;
        const b = DEFAULT_KEYMAP[j]!;
        if (!a.bindings.some((x) => b.bindings.some((y) => overlaps(x, y)))) continue;
        shared.push([a.action, b.action]);
        for (const placing of [false, true]) {
          const active = placingContext(placing);
          expect(active(a.action) && active(b.action), `${a.action} and ${b.action} both active with placing ${placing}`).toBe(false);
        }
      }
    }
    expect(shared).toEqual([['slotNext', 'turn'], ['slotPrev', 'turnBack']]);
  });

  test('the selection tool\'s nine entries are SP5c spec §1.1\'s, in its group (D4)', () => {
    const select = DEFAULT_KEYMAP.filter((e) => e.group === 'select');
    const row = (action: Action, bindings: Binding[], label: string): KeyEntry => ({ action, bindings, label, group: 'select', since: 'SP5c' });
    expect(select).toEqual([
      row('selectTool', [{ kind: 'code', code: 'KeyQ', ctrl: false }], 'Selection tool on or off'),
      row('copy', [{ kind: 'code', code: 'KeyC', ctrl: true }], 'Copy the selection'),
      row('cut', [{ kind: 'code', code: 'KeyX', ctrl: true }], 'Cut the selection'),
      row('paste', [{ kind: 'code', code: 'KeyV', ctrl: true }], 'Paste'),
      row('move', [{ kind: 'code', code: 'KeyN', ctrl: false }], 'Move the selection'),
      row('turn', [{ kind: 'wheel', dir: 'down', ctrl: false }], 'Turn the paste 90° clockwise'),
      row('turnBack', [{ kind: 'wheel', dir: 'up', ctrl: false }], 'Turn the paste back 90°'),
      row('raise', [{ kind: 'code', code: 'ArrowUp', ctrl: false }], 'Raise the paste'),
      row('lower', [{ kind: 'code', code: 'ArrowDown', ctrl: false }], 'Lower the paste'),
    ]);
    expect([...PLACING_ACTIONS].sort()).toEqual(['lower', 'raise', 'turn', 'turnBack']);
  });

  test('Ctrl+C resolves copy, plain C nothing; Ctrl+Alt+C nothing; Cmd+C copy; Ctrl+Q and Ctrl+N nothing; plain Q selectTool, plain N move; plain W still resolves forward with Ctrl', () => {
    expect(resolveKey({ code: 'KeyC', key: 'c', ctrlKey: true })).toBe('copy');
    expect(resolveKey({ code: 'KeyC', key: 'c' })).toBeNull();
    // AltGr sets both Ctrl and Alt (the user's Spanish layout): never a copy or a paste.
    expect(resolveKey({ code: 'KeyC', key: 'c', ctrlKey: true, altKey: true })).toBeNull();
    expect(resolveKey({ code: 'KeyV', key: 'v', ctrlKey: true, altKey: true })).toBeNull();
    expect(resolveKey({ code: 'KeyC', key: 'c', metaKey: true })).toBe('copy');
    expect(resolveKey({ code: 'KeyX', key: 'x', ctrlKey: true })).toBe('cut');
    expect(resolveKey({ code: 'KeyV', key: 'v', ctrlKey: true })).toBe('paste');
    // Plain X is the X-ray since SP6a (SP6a spec §7.1); Ctrl+X stays the cut above.
    expect(resolveKey({ code: 'KeyX', key: 'x' })).toBe('xray');
    expect(resolveKey({ code: 'KeyV', key: 'v' })).toBeNull();
    expect(resolveKey({ code: 'KeyQ', key: 'q', ctrlKey: true })).toBeNull();
    expect(resolveKey({ code: 'KeyN', key: 'n', ctrlKey: true })).toBeNull();
    expect(resolveKey({ code: 'KeyN', key: 'n', metaKey: true })).toBeNull();
    expect(resolveKey({ code: 'KeyQ', key: 'q' })).toBe('selectTool');
    expect(resolveKey({ code: 'KeyN', key: 'n' })).toBe('move');
    // The physical key: a layout typing something else at KeyQ (AZERTY's a) still toggles the tool.
    expect(resolveKey({ code: 'KeyQ', key: 'a' })).toBe('selectTool');
    expect(resolveKey({ code: 'KeyW', key: 'w', ctrlKey: true })).toBe('forward');
    expect(resolveKey({ code: 'KeyW', key: 'w', metaKey: true })).toBe('forward');
  });

  test('SP6a\'s five view entries are spec §7.1\'s, each without Ctrl (D10, D11, D15)', () => {
    const view = DEFAULT_KEYMAP.filter((e) => SP6A.includes(e.action));
    const row = (action: Action, c: string, label: string): KeyEntry => ({
      action, bindings: [{ kind: 'code', code: c, ctrl: false }], label, group: 'view', since: 'SP6a',
    });
    expect(view).toEqual([
      row('xray', 'KeyX', 'X-ray on or off'),
      row('xrayDown', 'PageDown', 'Move the X-ray band down'),
      row('xrayUp', 'PageUp', 'Move the X-ray band up'),
      row('xrayAll', 'Home', 'Show every depth in the X-ray'),
      row('nightVision', 'KeyL', 'Night vision on or off'),
    ]);
    // None is a placing action: they act in both contexts.
    for (const a of SP6A) expect(PLACING_ACTIONS.has(a), a).toBe(false);
  });

  test('no SP6a binding shares a code with another context-free binding: X without Ctrl and cut\'s Ctrl+X never overlap', () => {
    for (const e of DEFAULT_KEYMAP.filter((x) => SP6A.includes(x.action))) {
      for (const other of DEFAULT_KEYMAP) {
        if (other === e) continue;
        for (const b of e.bindings) {
          for (const o of other.bindings) expect(overlaps(b, o), `${e.action} and ${other.action}`).toBe(false);
        }
      }
    }
    expect(overlaps({ kind: 'code', code: 'KeyX', ctrl: false }, { kind: 'code', code: 'KeyX', ctrl: true })).toBe(false);
  });

  test('Ctrl+X still resolves cut and plain X xray; plain PageDown, PageUp, Home and L resolve their actions; with Ctrl or Cmd they resolve nothing (the browser\'s tabs, top and address bar)', () => {
    for (const placing of [false, true]) {
      const active = placingContext(placing);
      expect(resolveKey({ code: 'KeyX', key: 'x', ctrlKey: true }, DEFAULT_KEYMAP, active)).toBe('cut');
      expect(resolveKey({ code: 'KeyX', key: 'x' }, DEFAULT_KEYMAP, active)).toBe('xray');
      expect(resolveKey({ code: 'PageDown', key: 'PageDown' }, DEFAULT_KEYMAP, active)).toBe('xrayDown');
      expect(resolveKey({ code: 'PageUp', key: 'PageUp' }, DEFAULT_KEYMAP, active)).toBe('xrayUp');
      expect(resolveKey({ code: 'Home', key: 'Home' }, DEFAULT_KEYMAP, active)).toBe('xrayAll');
      expect(resolveKey({ code: 'KeyL', key: 'l' }, DEFAULT_KEYMAP, active)).toBe('nightVision');
    }
    expect(resolveKey({ code: 'KeyX', key: 'x', metaKey: true })).toBe('cut');
    for (const [c, k] of [['PageDown', 'PageDown'], ['PageUp', 'PageUp'], ['Home', 'Home'], ['KeyL', 'l']] as const) {
      expect(resolveKey({ code: c, key: k, ctrlKey: true }), `Ctrl+${c}`).toBeNull();
      expect(resolveKey({ code: c, key: k, metaKey: true }), `Cmd+${c}`).toBeNull();
    }
    // The physical key: a layout typing something else at KeyL still toggles night vision.
    expect(resolveKey({ code: 'KeyL', key: 'ñ' })).toBe('nightVision');
  });

  test('a ctrl: true code binding is matched before the other code bindings, and `active` skips an entry for the next match', () => {
    const map: readonly KeyEntry[] = [
      { action: 'forward', bindings: [{ kind: 'code', code: 'KeyC' }], label: 'Forward', group: 'move', since: 'SP4a' },
      { action: 'copy', bindings: [{ kind: 'code', code: 'KeyC', ctrl: true }], label: 'Copy', group: 'select', since: 'SP5c' },
      { action: 'palette', bindings: [{ kind: 'key', key: 'c' }], label: 'Palette', group: 'build', since: 'SP5a' },
    ];
    expect(resolveKey({ code: 'KeyC', key: 'c', ctrlKey: true }, map)).toBe('copy');
    expect(resolveKey({ code: 'KeyC', key: 'c' }, map)).toBe('forward');
    expect(resolveKey({ code: 'KeyC', key: 'c', ctrlKey: true }, map, (a) => a !== 'copy')).toBe('forward');
    expect(resolveKey({ code: 'KeyC', key: 'c' }, map, (a) => a !== 'forward')).toBe('palette');
    expect(resolveKey({ code: 'KeyC', key: 'c' }, map, () => false)).toBeNull();
  });

  test('with the placing context off the plain wheel resolves slotNext/slotPrev and ↑, ↓ nothing; on, turn/turnBack and raise/lower (SP5c spec §1.1)', () => {
    const off = placingContext(false);
    const on = placingContext(true);
    expect(resolveWheel(1, false, DEFAULT_KEYMAP, off)).toBe('slotNext');
    expect(resolveWheel(-1, false, DEFAULT_KEYMAP, off)).toBe('slotPrev');
    expect(resolveKey({ code: 'ArrowUp', key: 'ArrowUp' }, DEFAULT_KEYMAP, off)).toBeNull();
    expect(resolveKey({ code: 'ArrowDown', key: 'ArrowDown' }, DEFAULT_KEYMAP, off)).toBeNull();
    expect(resolveWheel(1, false, DEFAULT_KEYMAP, on)).toBe('turn');
    expect(resolveWheel(-1, false, DEFAULT_KEYMAP, on)).toBe('turnBack');
    expect(resolveKey({ code: 'ArrowUp', key: 'ArrowUp' }, DEFAULT_KEYMAP, on)).toBe('raise');
    expect(resolveKey({ code: 'ArrowDown', key: 'ArrowDown' }, DEFAULT_KEYMAP, on)).toBe('lower');
    // ↑ with Ctrl is nothing even while placing; Ctrl+wheel stays the flying speed either way.
    expect(resolveKey({ code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true }, DEFAULT_KEYMAP, on)).toBeNull();
    expect(resolveWheel(1, true, DEFAULT_KEYMAP, on)).toBe('speedDown');
    expect(resolveWheel(-1, true, DEFAULT_KEYMAP, off)).toBe('speedUp');
    // Every other action is active in both contexts.
    for (const e of DEFAULT_KEYMAP) {
      const placingOnly = PLACING_ACTIONS.has(e.action);
      const slotWheel = e.action === 'slotNext' || e.action === 'slotPrev';
      expect(on(e.action), e.action).toBe(!slotWheel);
      expect(off(e.action), e.action).toBe(!placingOnly);
    }
    // Without a context (the default), every entry is active: the wheel's first match is the slot's.
    expect(resolveWheel(1, false)).toBe('slotNext');
  });

  test('the bindings are spec §7.3\'s', () => {
    const of = (a: Action) => DEFAULT_KEYMAP.find((e) => e.action === a)!.bindings.map(bindingKey);
    expect(of('forward')).toEqual(['code:KeyW']);
    expect(of('left')).toEqual(['code:KeyA']);
    expect(of('back')).toEqual(['code:KeyS']);
    expect(of('right')).toEqual(['code:KeyD']);
    expect(of('up')).toEqual(['code:Space']);
    expect(of('down')).toEqual(['code:ShiftLeft', 'code:ShiftRight']);
    // R since Task 45b (Ctrl+W closes the tab, the user's finding at SP5a's production check); the double-tapped W is
    // the input's (input.ts, sprintTap.ts), not a binding.
    expect(of('sprint')).toEqual(['code:KeyR']);
    expect(of('speedUp')).toEqual(['wheel:up+ctrl', 'key:+', 'key:=']);
    expect(of('speedDown')).toEqual(['wheel:down+ctrl', 'key:-']);
    expect(of('timeSpeed')).toEqual(['code:KeyT']);
    expect(of('help')).toEqual(['code:KeyH', 'code:F1']);
    expect(of('hud')).toEqual(['code:F3']);
    expect(of('releasePointer')).toEqual(['code:Escape']);
    expect(of('map')).toEqual(['code:KeyM']);
  });

  test('B saves a place (group world) and G opens the Settings (group view), both SP5b\'s; H is the help (SP5b spec §3.7)', () => {
    const of = (a: Action) => DEFAULT_KEYMAP.find((e) => e.action === a)!;
    expect(of('savePlace')).toEqual({ action: 'savePlace', bindings: [{ kind: 'code', code: 'KeyB' }], label: 'Save this place', group: 'world', since: 'SP5b' });
    expect(of('settings')).toEqual({ action: 'settings', bindings: [{ kind: 'code', code: 'KeyG' }], label: 'Settings', group: 'view', since: 'SP5b' });
    expect(of('help').label).toBe('Help');
    expect(of('savePlace').bindings.map(bindingKey)).toEqual(['code:KeyB']);
    expect(of('settings').bindings.map(bindingKey)).toEqual(['code:KeyG']);
    expect(resolveKey({ code: 'KeyB', key: 'b' })).toBe('savePlace');
    expect(resolveKey({ code: 'KeyG', key: 'g' })).toBe('settings');
  });

  test('the build group\'s bindings are SP5a spec §4.1\'s: F, E, Digit1-Digit9 by code, the plain wheel', () => {
    const of = (a: Action) => DEFAULT_KEYMAP.find((e) => e.action === a)!.bindings.map(bindingKey);
    expect(of('toggleWalk')).toEqual(['code:KeyF']);
    expect(of('palette')).toEqual(['code:KeyE']);
    for (let i = 1; i <= 9; i++) expect(of(`slot${i}` as Action)).toEqual([`code:Digit${i}`]);
    expect(of('slotNext')).toEqual(['wheel:down']);
    expect(of('slotPrev')).toEqual(['wheel:up']);
    expect(resolveKey({ code: 'KeyE', key: 'e' })).toBe('palette');
    expect(resolveKey({ code: 'Digit9', key: '9' })).toBe('slot9');
  });

  test('Digit1 with key \'!\' (shifted) resolves slot1: the digits are bound by code', () => {
    expect(resolveKey({ code: 'Digit1', key: '!' })).toBe('slot1');
    // A layout typing a digit only with Shift (AZERTY: & at Digit1) still selects the slot.
    expect(resolveKey({ code: 'Digit1', key: '&' })).toBe('slot1');
  });

  test('no loadHere (SP4b spec §6.2, D20); KeyR is sprint since Task 45b, Ctrl nothing', () => {
    expect(DEFAULT_KEYMAP.map((e) => e.action as string)).not.toContain('loadHere');
    expect(DEFAULT_KEYMAP.flatMap((e) => e.bindings.map(bindingKey)).filter((k) => k === 'code:KeyR')).toHaveLength(1);
    expect(resolveKey({ code: 'KeyR', key: 'r' })).toBe('sprint');
    expect(resolveKey({ code: 'ControlLeft', key: 'Control' })).toBeNull();
    expect(resolveKey({ code: 'ControlRight', key: 'Control' })).toBeNull();
  });

  test('the sprint entry names R and the double tap, still SP4a\'s (Task 45b)', () => {
    expect(DEFAULT_KEYMAP.find((e) => e.action === 'sprint')).toEqual({
      action: 'sprint', bindings: [{ kind: 'code', code: 'KeyR' }], label: 'Sprint (hold R, or double-tap W)', group: 'move', since: 'SP4a',
    });
  });

  test('resolveKey matches the physical key: KeyW with key z is forward (layout-independent)', () => {
    expect(resolveKey({ code: 'KeyW', key: 'z' })).toBe('forward');
    expect(resolveKey({ code: 'KeyD', key: 'd' })).toBe('right');
    expect(resolveKey({ code: 'KeyR', key: 'p' })).toBe('sprint');
    expect(resolveKey({ code: 'F1', key: 'F1' })).toBe('help');
    expect(resolveKey({ code: 'KeyF', key: 'f' })).toBe('toggleWalk');
    expect(resolveKey({ code: 'KeyG', key: 'g' })).toBe('settings');
    expect(resolveKey({ code: 'KeyJ', key: 'j' })).toBeNull();
  });

  test('on a Spanish layout, + at BracketRight is speedUp and - at Slash is speedDown', () => {
    expect(resolveKey({ code: 'BracketRight', key: '+' })).toBe('speedUp');
    expect(resolveKey({ code: 'Slash', key: '-' })).toBe('speedDown');
    // US layout: = unshifted, + shifted, - at Minus.
    expect(resolveKey({ code: 'Equal', key: '=' })).toBe('speedUp');
    expect(resolveKey({ code: 'Equal', key: '+' })).toBe('speedUp');
    expect(resolveKey({ code: 'Minus', key: '-' })).toBe('speedDown');
  });

  test('a code binding wins over a key binding of another action', () => {
    // A layout whose W key typed '-' still flies forward.
    expect(resolveKey({ code: 'KeyW', key: '-' })).toBe('forward');
  });

  test('resolveWheel matches the modifier: Ctrl+wheel up (negative deltaY) is speedUp, down is speedDown, 0 is nothing', () => {
    expect(resolveWheel(-100, true)).toBe('speedUp');
    expect(resolveWheel(3, true)).toBe('speedDown');
    expect(resolveWheel(0, false)).toBeNull();
    expect(resolveWheel(0, true)).toBeNull();
    expect(resolveWheel(Number.NaN, false)).toBeNull();
  });

  test('Ctrl+wheel up → speedUp, plain wheel up → slotPrev, down → slotNext (SP5a spec §4.1, D9)', () => {
    expect(resolveWheel(-1, true)).toBe('speedUp');
    expect(resolveWheel(-1, false)).toBe('slotPrev');
    expect(resolveWheel(1, false)).toBe('slotNext');
    expect(resolveWheel(1, true)).toBe('speedDown');
  });

  test('a custom map replaces the default', () => {
    const map = [{ action: 'forward', bindings: [{ kind: 'code', code: 'ArrowUp' }], label: 'Forward', group: 'move', since: 'SP4a' }] as const;
    expect(resolveKey({ code: 'ArrowUp', key: 'ArrowUp' }, map)).toBe('forward');
    expect(resolveKey({ code: 'KeyW', key: 'w' }, map)).toBeNull();
    expect(resolveWheel(-1, false, map)).toBeNull();
  });

  test('bindingLabel names each binding for people', () => {
    expect(bindingLabel({ kind: 'code', code: 'KeyW' })).toBe('W');
    expect(bindingLabel({ kind: 'code', code: 'Space' })).toBe('Space');
    expect(bindingLabel({ kind: 'code', code: 'ShiftLeft' })).toBe('Left Shift');
    expect(bindingLabel({ kind: 'code', code: 'ControlRight' })).toBe('Right Ctrl');
    expect(bindingLabel({ kind: 'code', code: 'F3' })).toBe('F3');
    expect(bindingLabel({ kind: 'code', code: 'Escape' })).toBe('Esc');
    expect(bindingLabel({ kind: 'key', key: '+' })).toBe('+');
    expect(bindingLabel({ kind: 'wheel', dir: 'up', ctrl: false })).toBe('Wheel up');
    expect(bindingLabel({ kind: 'wheel', dir: 'down', ctrl: false })).toBe('Wheel down');
    expect(bindingLabel({ kind: 'wheel', dir: 'up', ctrl: true })).toBe('Ctrl+Wheel up');
    expect(bindingLabel({ kind: 'wheel', dir: 'down', ctrl: true })).toBe('Ctrl+Wheel down');
    expect(bindingLabel({ kind: 'code', code: 'Digit1' })).toBe('1');
    // SP5c spec §1.1: a ctrl: true code binding names Ctrl; a ctrl: false one is the key alone.
    expect(bindingLabel({ kind: 'code', code: 'KeyC', ctrl: true })).toBe('Ctrl+C');
    expect(bindingLabel({ kind: 'code', code: 'KeyQ', ctrl: false })).toBe('Q');
    expect(bindingLabel({ kind: 'code', code: 'ArrowUp', ctrl: false })).toBe('↑');
    // SP6a spec §7.1: the X-ray band's keys by their people's names.
    expect(bindingLabel({ kind: 'code', code: 'PageUp', ctrl: false })).toBe('Page Up');
    expect(bindingLabel({ kind: 'code', code: 'PageDown', ctrl: false })).toBe('Page Down');
    expect(bindingLabel({ kind: 'code', code: 'Home', ctrl: false })).toBe('Home');
    expect(bindingLabel({ kind: 'code', code: 'KeyX', ctrl: false })).toBe('X');
    expect(bindingLabel({ kind: 'code', code: 'KeyL', ctrl: false })).toBe('L');
    for (const e of DEFAULT_KEYMAP) for (const b of e.bindings) expect(bindingLabel(b), bindingKey(b)).not.toBe('');
  });
});

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_KEYMAP, LISTED_ONLY, bindingLabel, resolveKey, resolveWheel, type Action, type Binding,
} from '../../src/player/keymap';

/** SP5a's build group (SP5a spec §4.1): F, E, 1-9 and the plain wheel. */
const BUILD: readonly Action[] = [
  'toggleWalk', 'palette', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9', 'slotNext', 'slotPrev',
];

/**
 * Every action of SP4a spec §7.3 but R (removed by SP4b spec §6.2), SP4c's M (SP4c spec §2.4) and SP5a's build group
 * (SP5a spec §4.1), spelled out so that a missing map entry fails here.
 */
const ACTIONS: readonly Action[] = [
  'forward', 'back', 'left', 'right', 'up', 'down', 'sprint', 'speedUp', 'speedDown',
  'timeSpeed', 'help', 'hud', 'releasePointer', 'map', ...BUILD,
];

const bindingKey = (b: Binding): string =>
  (b.kind === 'code' ? `code:${b.code}` : b.kind === 'key' ? `key:${b.key}` : `wheel:${b.dir}${b.ctrl ? '+ctrl' : ''}`);

describe('the key map as data (SP4a spec §7.3, D19)', () => {
  test('every Action is bound or listed', () => {
    for (const a of ACTIONS) {
      const entries = DEFAULT_KEYMAP.filter((e) => e.action === a);
      expect(entries, a).toHaveLength(1);
      expect(entries[0]!.bindings.length, `${a} has no binding`).toBeGreaterThan(0);
      expect(entries[0]!.label, a).not.toBe('');
    }
    expect(DEFAULT_KEYMAP).toHaveLength(ACTIONS.length);
    expect(DEFAULT_KEYMAP).toHaveLength(27);
    // Esc is listed (the help names it) but the browser owns it: the input layer never resolves it.
    expect([...LISTED_ONLY]).toEqual(['releasePointer']);
    expect(resolveKey({ code: 'Escape', key: 'Escape' })).toBeNull();
    // Every entry is SP4a's except SP4c's map (SP4c spec §2.4) and SP5a's build group (SP5a spec §4.1).
    for (const e of DEFAULT_KEYMAP) expect(e.since, e.action).toBe(e.action === 'map' ? 'SP4c' : BUILD.includes(e.action) ? 'SP5a' : 'SP4a');
    for (const e of DEFAULT_KEYMAP) expect(e.group === 'build', e.action).toBe(BUILD.includes(e.action));
  });

  test('M opens the map: KeyM resolves to map, in the view group (SP4c spec §2.4, D15)', () => {
    expect(DEFAULT_KEYMAP.find((e) => e.action === 'map')).toEqual({
      action: 'map', bindings: [{ kind: 'code', code: 'KeyM' }], label: 'Map: teleport and live editing', group: 'view', since: 'SP4c',
    });
    expect(resolveKey({ code: 'KeyM', key: 'm' })).toBe('map');
    // The physical key: a layout typing something else at KeyM still opens the map.
    expect(resolveKey({ code: 'KeyM', key: ',' })).toBe('map');
  });

  test('no binding is shared by two actions', () => {
    const seen = new Map<string, Action>();
    for (const e of DEFAULT_KEYMAP) {
      for (const b of e.bindings) {
        const k = bindingKey(b);
        expect(seen.get(k), `${k} bound to ${seen.get(k)} and ${e.action}`).toBeUndefined();
        seen.set(k, e.action);
      }
    }
  });

  test('the bindings are spec §7.3\'s', () => {
    const of = (a: Action) => DEFAULT_KEYMAP.find((e) => e.action === a)!.bindings.map(bindingKey);
    expect(of('forward')).toEqual(['code:KeyW']);
    expect(of('left')).toEqual(['code:KeyA']);
    expect(of('back')).toEqual(['code:KeyS']);
    expect(of('right')).toEqual(['code:KeyD']);
    expect(of('up')).toEqual(['code:Space']);
    expect(of('down')).toEqual(['code:ShiftLeft', 'code:ShiftRight']);
    expect(of('sprint')).toEqual(['code:ControlLeft', 'code:ControlRight']);
    expect(of('speedUp')).toEqual(['wheel:up+ctrl', 'key:+', 'key:=']);
    expect(of('speedDown')).toEqual(['wheel:down+ctrl', 'key:-']);
    expect(of('timeSpeed')).toEqual(['code:KeyT']);
    expect(of('help')).toEqual(['code:KeyH', 'code:F1']);
    expect(of('hud')).toEqual(['code:F3']);
    expect(of('releasePointer')).toEqual(['code:Escape']);
    expect(of('map')).toEqual(['code:KeyM']);
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

  test('no loadHere, nothing bound to KeyR (SP4b spec §6.2, D20)', () => {
    expect(DEFAULT_KEYMAP.map((e) => e.action as string)).not.toContain('loadHere');
    expect(DEFAULT_KEYMAP.flatMap((e) => e.bindings.map(bindingKey))).not.toContain('code:KeyR');
    expect(resolveKey({ code: 'KeyR', key: 'r' })).toBeNull();
  });

  test('resolveKey matches the physical key: KeyW with key z is forward (layout-independent)', () => {
    expect(resolveKey({ code: 'KeyW', key: 'z' })).toBe('forward');
    expect(resolveKey({ code: 'KeyD', key: 'd' })).toBe('right');
    expect(resolveKey({ code: 'ControlLeft', key: 'Control' })).toBe('sprint');
    expect(resolveKey({ code: 'F1', key: 'F1' })).toBe('help');
    expect(resolveKey({ code: 'KeyF', key: 'f' })).toBe('toggleWalk');
    expect(resolveKey({ code: 'KeyG', key: 'g' })).toBeNull();
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
    for (const e of DEFAULT_KEYMAP) for (const b of e.bindings) expect(bindingLabel(b), bindingKey(b)).not.toBe('');
  });
});

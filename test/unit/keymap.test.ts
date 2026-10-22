import { describe, expect, test } from 'vitest';
import {
  DEFAULT_KEYMAP, LISTED_ONLY, bindingLabel, resolveKey, resolveWheel, type Action, type Binding,
} from '../../src/player/keymap';

/** Every SP4a action of spec §7.3, spelled out so that a missing map entry fails here. */
const ACTIONS: readonly Action[] = [
  'forward', 'back', 'left', 'right', 'up', 'down', 'sprint', 'speedUp', 'speedDown',
  'timeSpeed', 'help', 'hud', 'loadHere', 'releasePointer',
];

const bindingKey = (b: Binding): string => (b.kind === 'code' ? `code:${b.code}` : b.kind === 'key' ? `key:${b.key}` : `wheel:${b.dir}`);

describe('the key map as data (SP4a spec §7.3, D19)', () => {
  test('every Action is bound or listed', () => {
    for (const a of ACTIONS) {
      const entries = DEFAULT_KEYMAP.filter((e) => e.action === a);
      expect(entries, a).toHaveLength(1);
      expect(entries[0]!.bindings.length, `${a} has no binding`).toBeGreaterThan(0);
      expect(entries[0]!.label, a).not.toBe('');
    }
    expect(DEFAULT_KEYMAP).toHaveLength(ACTIONS.length);
    // Esc is listed (the help names it) but the browser owns it: the input layer never resolves it.
    expect([...LISTED_ONLY]).toEqual(['releasePointer']);
    expect(resolveKey({ code: 'Escape', key: 'Escape' })).toBeNull();
    expect(DEFAULT_KEYMAP.every((e) => e.since === 'SP4a')).toBe(true);
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
    expect(of('speedUp')).toEqual(['wheel:up', 'key:+', 'key:=']);
    expect(of('speedDown')).toEqual(['wheel:down', 'key:-']);
    expect(of('timeSpeed')).toEqual(['code:KeyT']);
    expect(of('help')).toEqual(['code:KeyH', 'code:F1']);
    expect(of('hud')).toEqual(['code:F3']);
    expect(of('loadHere')).toEqual(['code:KeyR']);
    expect(of('releasePointer')).toEqual(['code:Escape']);
  });

  test('resolveKey matches the physical key: KeyW with key z is forward (layout-independent)', () => {
    expect(resolveKey({ code: 'KeyW', key: 'z' })).toBe('forward');
    expect(resolveKey({ code: 'KeyD', key: 'd' })).toBe('right');
    expect(resolveKey({ code: 'ControlLeft', key: 'Control' })).toBe('sprint');
    expect(resolveKey({ code: 'F1', key: 'F1' })).toBe('help');
    expect(resolveKey({ code: 'KeyF', key: 'f' })).toBeNull();
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

  test('resolveWheel: up (negative deltaY) is speedUp, down is speedDown, 0 is nothing', () => {
    expect(resolveWheel(-100)).toBe('speedUp');
    expect(resolveWheel(3)).toBe('speedDown');
    expect(resolveWheel(0)).toBeNull();
  });

  test('a custom map replaces the default', () => {
    const map = [{ action: 'forward', bindings: [{ kind: 'code', code: 'ArrowUp' }], label: 'Forward', group: 'move', since: 'SP4a' }] as const;
    expect(resolveKey({ code: 'ArrowUp', key: 'ArrowUp' }, map)).toBe('forward');
    expect(resolveKey({ code: 'KeyW', key: 'w' }, map)).toBeNull();
    expect(resolveWheel(-1, map)).toBeNull();
  });

  test('bindingLabel names each binding for people', () => {
    expect(bindingLabel({ kind: 'code', code: 'KeyW' })).toBe('W');
    expect(bindingLabel({ kind: 'code', code: 'Space' })).toBe('Space');
    expect(bindingLabel({ kind: 'code', code: 'ShiftLeft' })).toBe('Left Shift');
    expect(bindingLabel({ kind: 'code', code: 'ControlRight' })).toBe('Right Ctrl');
    expect(bindingLabel({ kind: 'code', code: 'F3' })).toBe('F3');
    expect(bindingLabel({ kind: 'code', code: 'Escape' })).toBe('Esc');
    expect(bindingLabel({ kind: 'key', key: '+' })).toBe('+');
    expect(bindingLabel({ kind: 'wheel', dir: 'up' })).toBe('Wheel up');
    expect(bindingLabel({ kind: 'wheel', dir: 'down' })).toBe('Wheel down');
    for (const e of DEFAULT_KEYMAP) for (const b of e.bindings) expect(bindingLabel(b), bindingKey(b)).not.toBe('');
  });
});

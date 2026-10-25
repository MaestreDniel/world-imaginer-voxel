import { describe, expect, test, vi } from 'vitest';
import { attachInput, createWheelSteps, isTextEntry } from '../../src/player/input';
import type { Action } from '../../src/player/keymap';

/** Fake target, document and window (ruling P41): plain EventTargets with the members input.ts reads. */
function setup(textFocus = false, activeAtStart = true) {
  const target = Object.assign(new EventTarget(), { requestPointerLock: vi.fn(() => Promise.resolve()) });
  const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown });
  const win = new EventTarget();
  const addSpy = vi.spyOn(target, 'addEventListener');
  const actions: Action[] = [];
  const looks: Array<[number, number]> = [];
  let text = textFocus;
  let active = activeAtStart;
  const input = attachInput(target as unknown as HTMLElement, {
    onAction: (a) => actions.push(a),
    onLook: (dx, dy) => looks.push([dx, dy]),
    isTextFocus: () => text,
    active: () => active,
    doc: doc as unknown as Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>,
    win: win as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
  });
  return {
    target, doc, win, addSpy, actions, looks, input,
    setText: (v: boolean) => { text = v; },
    setActive: (v: boolean) => { active = v; },
  };
}

const key = (type: 'keydown' | 'keyup', code: string, k: string, mods: { ctrlKey?: boolean; repeat?: boolean } = {}) =>
  Object.assign(new Event(type, { cancelable: true }), { code, key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...mods });
const wheel = (deltaY: number, ctrlKey = false, deltaMode = 0) => Object.assign(new Event('wheel', { cancelable: true }), { deltaY, deltaX: 0, deltaMode, ctrlKey });
const mouse = (dx: number, dy: number) => Object.assign(new Event('mousemove'), { movementX: dx, movementY: dy });

describe('input (SP4a spec §7.1, master §4.17)', () => {
  test('keydown of a bound action while the world has focus calls preventDefault, Ctrl held included (Ctrl+D, Ctrl+S, Ctrl+A)', () => {
    const { doc, input, actions } = setup();
    const ctrl = key('keydown', 'ControlLeft', 'Control', { ctrlKey: true });
    doc.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    const cases: Array<[string, string, Action]> = [['KeyD', 'd', 'right'], ['KeyS', 's', 'back'], ['KeyA', 'a', 'left']];
    for (const [code, k, a] of cases) {
      const e = key('keydown', code, k, { ctrlKey: true });
      doc.dispatchEvent(e);
      expect(e.defaultPrevented, `Ctrl+${k}`).toBe(true);
      expect(input.held.has(a), a).toBe(true);
    }
    expect(input.held.has('sprint')).toBe(true);
    // Non-movement actions fire once per press, also prevented (H, F1 open the help: spec §7.4).
    const f1 = key('keydown', 'F1', 'F1');
    doc.dispatchEvent(f1);
    expect(f1.defaultPrevented).toBe(true);
    doc.dispatchEvent(key('keydown', 'KeyT', 't'));
    doc.dispatchEvent(key('keydown', 'KeyT', 't', { repeat: true }));
    expect(actions).toEqual(['help', 'timeSpeed']);
    // Releasing one key leaves the others held.
    doc.dispatchEvent(key('keyup', 'KeyD', 'd'));
    expect([...input.held].sort()).toEqual(['back', 'left', 'sprint']);
    input.dispose();
  });

  test('wheel with Ctrl held changes the speed and calls preventDefault (listener registered with passive: false)', () => {
    const { target, addSpy, actions, input } = setup();
    const call = addSpy.mock.calls.find((c) => c[0] === 'wheel');
    expect(call, 'no wheel listener on the target').toBeDefined();
    expect(call![2]).toMatchObject({ passive: false });
    const up = wheel(-100, true);
    target.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    const down = wheel(100, true);
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const plain = wheel(-100);
    target.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(actions).toEqual(['speedUp', 'speedDown', 'speedUp']);
    input.dispose();
  });

  test('+ and - (key bindings) change the speed', () => {
    const { doc, actions, input } = setup();
    const plus = key('keydown', 'BracketRight', '+');
    doc.dispatchEvent(plus);
    doc.dispatchEvent(key('keydown', 'Slash', '-'));
    expect(plus.defaultPrevented).toBe(true);
    expect(actions).toEqual(['speedUp', 'speedDown']);
    expect(input.held.size).toBe(0);
    input.dispose();
  });

  test('keys cleared on blur and on pointer unlock', () => {
    const { target, doc, win, input } = setup();
    doc.dispatchEvent(key('keydown', 'KeyW', 'w'));
    doc.dispatchEvent(key('keydown', 'ShiftLeft', 'Shift'));
    expect([...input.held].sort()).toEqual(['down', 'forward']);
    win.dispatchEvent(new Event('blur'));
    expect(input.held.size).toBe(0);

    doc.pointerLockElement = target;
    doc.dispatchEvent(new Event('pointerlockchange'));
    doc.dispatchEvent(key('keydown', 'KeyW', 'w'));
    doc.dispatchEvent(new Event('pointerlockchange'));
    // Still locked to the target: nothing cleared.
    expect([...input.held]).toEqual(['forward']);
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(input.held.size).toBe(0);
    // A keyup after the clear is harmless.
    doc.dispatchEvent(key('keyup', 'KeyW', 'w'));
    expect(input.held.size).toBe(0);
    input.dispose();
  });

  test('ignored while a text input has focus', () => {
    const { target, doc, actions, input, setText } = setup(true);
    const w = key('keydown', 'KeyW', 'w');
    const h = key('keydown', 'KeyH', 'h');
    doc.dispatchEvent(w);
    doc.dispatchEvent(h);
    target.dispatchEvent(wheel(-100));
    expect(w.defaultPrevented).toBe(false);
    expect(h.defaultPrevented).toBe(false);
    expect(input.held.size).toBe(0);
    expect(actions).toEqual([]);
    setText(false);
    doc.dispatchEvent(key('keydown', 'KeyW', 'w'));
    expect(input.held.has('forward')).toBe(true);
    // A key released while typing still releases (no stuck movement).
    setText(true);
    doc.dispatchEvent(key('keyup', 'KeyW', 'w'));
    expect(input.held.size).toBe(0);
    input.dispose();
  });

  test('isTextEntry: only text-entry controls count as text focus (spec §7.1; final review C-I2)', () => {
    const input = (type: string) => ({ tagName: 'INPUT', type });
    for (const t of ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'TEXT']) expect(isTextEntry(input(t)), `input ${t}`).toBe(true);
    for (const t of ['range', 'checkbox', 'radio', 'button', 'color', 'submit']) expect(isTextEntry(input(t)), `input ${t}`).toBe(false);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    for (const tag of ['SELECT', 'BUTTON', 'BODY', 'CANVAS']) expect(isTextEntry({ tagName: tag }), tag).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  test('with a range input or a select focused, H toggles the help and F1 is prevented', () => {
    for (const focused of [{ tagName: 'INPUT', type: 'range' }, { tagName: 'SELECT', type: 'select-one' }]) {
      const target = Object.assign(new EventTarget(), { requestPointerLock: vi.fn() });
      const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown });
      const actions: Action[] = [];
      const input = attachInput(target as unknown as HTMLElement, {
        onAction: (a) => actions.push(a),
        onLook: () => {},
        isTextFocus: () => isTextEntry(focused),
        active: () => true,
        doc: doc as unknown as Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>,
        win: new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
      });
      const h = key('keydown', 'KeyH', 'h');
      const f1 = key('keydown', 'F1', 'F1');
      doc.dispatchEvent(h);
      doc.dispatchEvent(f1);
      expect(h.defaultPrevented, focused.tagName).toBe(true);
      expect(f1.defaultPrevented, focused.tagName).toBe(true);
      expect(actions, focused.tagName).toEqual(['help', 'help']);
      input.dispose();
    }
  });

  test('the wheel steps once per 100 px of deltaY: one mouse notch is one step, twenty 5 px touchpad events are one', () => {
    const { target, actions, input } = setup();
    // One notch of a mouse wheel (Chrome: 100-120 px) is one step.
    target.dispatchEvent(wheel(-100));
    target.dispatchEvent(wheel(120));
    expect(actions).toEqual(['speedUp', 'speedDown']);
    actions.length = 0;
    // A touchpad swipe: twenty events of 5 px are one step, not twenty; every event is still prevented.
    const events = Array.from({ length: 20 }, () => wheel(5));
    for (const e of events) target.dispatchEvent(e);
    expect(actions).toEqual(['speedDown']);
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    input.dispose();
  });

  test('createWheelSteps: normalises deltaMode, keeps no remainder past a step and resets on a direction change', () => {
    const steps = createWheelSteps();
    // Pixels: 99 px is no step, the 100th is one; the remainder is dropped after a step.
    expect(steps.push(99, 0)).toBe(0);
    expect(steps.push(1, 0)).toBe(1);
    expect(steps.push(60, 0)).toBe(0);
    // A direction change starts over: the 60 px down do not cancel the way up.
    expect(steps.push(-60, 0)).toBe(0);
    expect(steps.push(-40, 0)).toBe(-1);
    // A large pixel delta is several steps.
    expect(steps.push(-250, 0)).toBe(-2);
    // Lines (16 px; Firefox's mouse notch is 3 lines) and pages are discrete notches: at least one step each, and a
    // page notch is one step, not a screen's height of steps.
    expect(steps.push(3, 1)).toBe(1);
    expect(steps.push(-1, 1)).toBe(-1);
    expect(steps.push(-13, 1)).toBe(-2);
    expect(steps.push(1, 2)).toBe(1);
    // 0 and NaN step nothing.
    expect(steps.push(0, 0)).toBe(0);
    expect(steps.push(Number.NaN, 0)).toBe(0);
  });

  test('an unbound key is not prevented', () => {
    const { doc, actions, input } = setup();
    for (const [code, k, ctrl] of [['KeyF', 'f', true], ['KeyF', 'f', false], ['KeyQ', 'q', false], ['Tab', 'Tab', false]] as const) {
      const e = key('keydown', code, k, { ctrlKey: ctrl });
      doc.dispatchEvent(e);
      expect(e.defaultPrevented, `${ctrl ? 'Ctrl+' : ''}${k}`).toBe(false);
    }
    // Esc is listed only: the browser releases the pointer.
    const esc = key('keydown', 'Escape', 'Escape');
    doc.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    expect(actions).toEqual([]);
    expect(input.held.size).toBe(0);
    input.dispose();
  });

  test('a click requests pointer lock; mouse movement looks only while locked to the target', () => {
    const { target, doc, looks, input } = setup();
    target.dispatchEvent(new Event('click'));
    expect(target.requestPointerLock).toHaveBeenCalledTimes(1);
    target.dispatchEvent(mouse(5, -3));
    expect(looks).toEqual([]);
    doc.pointerLockElement = target;
    target.dispatchEvent(mouse(5, -3));
    expect(looks).toEqual([[5, -3]]);
    input.dispose();
  });

  test('a rejected pointer-lock request is swallowed', async () => {
    const { target, input } = setup();
    target.requestPointerLock.mockImplementationOnce(() => Promise.reject(new Error('SecurityError')));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    target.dispatchEvent(new Event('click'));
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    input.dispose();
  });

  describe('the controls owner (SP4c spec §2.3, §2.4, D15)', () => {
    test('inactive: W, A, S, D, Space, Shift, Ctrl, T, H, F1, F3, + and − do nothing and are not default-prevented (Space presses a focused map button, − types)', () => {
      const { doc, actions, input } = setup(false, false);
      const keys: Array<[string, string]> = [
        ['KeyW', 'w'], ['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd'], ['Space', ' '], ['ShiftLeft', 'Shift'], ['ShiftRight', 'Shift'],
        ['ControlLeft', 'Control'], ['ControlRight', 'Control'], ['KeyT', 't'], ['KeyH', 'h'], ['F1', 'F1'], ['F3', 'F3'],
        ['BracketRight', '+'], ['Equal', '='], ['Slash', '-'], ['Minus', '-'],
      ];
      for (const [code, k] of keys) {
        const e = key('keydown', code, k);
        doc.dispatchEvent(e);
        expect(e.defaultPrevented, code).toBe(false);
      }
      expect(actions).toEqual([]);
      expect(input.held.size).toBe(0);
      input.dispose();
    });

    test('inactive: M still fires onAction(\'map\'), prevented; active too; a repeat does not fire again', () => {
      const { doc, actions, input, setActive } = setup(false, false);
      const m = key('keydown', 'KeyM', 'm');
      doc.dispatchEvent(m);
      expect(m.defaultPrevented).toBe(true);
      expect(actions).toEqual(['map']);
      doc.dispatchEvent(key('keydown', 'KeyM', 'm', { repeat: true }));
      expect(actions).toEqual(['map']);
      setActive(true);
      const m2 = key('keydown', 'KeyM', 'm');
      doc.dispatchEvent(m2);
      expect(m2.defaultPrevented).toBe(true);
      expect(actions).toEqual(['map', 'map']);
      input.dispose();
    });

    test('M in a text field does nothing, active or not', () => {
      for (const active of [true, false]) {
        const { doc, actions, input } = setup(true, active);
        const m = key('keydown', 'KeyM', 'm');
        doc.dispatchEvent(m);
        expect(m.defaultPrevented, `active ${active}`).toBe(false);
        expect(actions, `active ${active}`).toEqual([]);
        input.dispose();
      }
    });

    test('the wheel while inactive changes no speed (still prevented: the world never scrolls)', () => {
      const { target, actions, input, setActive } = setup(false, false);
      const events = [wheel(-100), wheel(120), wheel(-100, true), ...Array.from({ length: 30 }, () => wheel(5))];
      for (const e of events) target.dispatchEvent(e);
      expect(actions).toEqual([]);
      expect(events.every((e) => e.defaultPrevented)).toBe(true);
      // Nothing carried over from the inactive scroll: the first active notch is one step.
      setActive(true);
      target.dispatchEvent(wheel(-100));
      expect(actions).toEqual(['speedUp']);
      input.dispose();
    });

    test('active again: the world\'s keys act once more; a key released while inactive still releases', () => {
      const { doc, actions, input, setActive } = setup();
      doc.dispatchEvent(key('keydown', 'KeyW', 'w'));
      expect(input.held.has('forward')).toBe(true);
      setActive(false);
      doc.dispatchEvent(key('keyup', 'KeyW', 'w'));
      expect(input.held.size).toBe(0);
      setActive(true);
      const t = key('keydown', 'KeyT', 't');
      doc.dispatchEvent(t);
      expect(t.defaultPrevented).toBe(true);
      expect(actions).toEqual(['timeSpeed']);
      input.dispose();
    });

    test('clear() empties held', () => {
      const { doc, input } = setup();
      doc.dispatchEvent(key('keydown', 'KeyW', 'w'));
      doc.dispatchEvent(key('keydown', 'ShiftLeft', 'Shift'));
      expect([...input.held].sort()).toEqual(['down', 'forward']);
      input.clear();
      expect(input.held.size).toBe(0);
      // The keys it dropped stay dropped: their keyup is harmless, and a later press holds again.
      doc.dispatchEvent(key('keyup', 'KeyW', 'w'));
      expect(input.held.size).toBe(0);
      doc.dispatchEvent(key('keydown', 'KeyD', 'd'));
      expect([...input.held]).toEqual(['right']);
      input.dispose();
    });
  });

  test('dispose removes every listener', () => {
    const { target, doc, win, actions, looks, input } = setup();
    doc.dispatchEvent(key('keydown', 'KeyW', 'w'));
    input.dispose();
    doc.pointerLockElement = target;
    const s = key('keydown', 'KeyS', 's');
    doc.dispatchEvent(s);
    doc.dispatchEvent(key('keydown', 'KeyH', 'h'));
    expect(s.defaultPrevented).toBe(false);
    expect([...input.held]).toEqual(['forward']);
    const w = wheel(-100);
    target.dispatchEvent(w);
    target.dispatchEvent(mouse(1, 1));
    target.dispatchEvent(new Event('click'));
    expect(actions).toEqual([]);
    expect(looks).toEqual([]);
    expect(w.defaultPrevented).toBe(false);
    expect(target.requestPointerLock).not.toHaveBeenCalled();
    // Neither blur nor a keyup reaches it after dispose: held stays as it was.
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(key('keyup', 'KeyW', 'w'));
    expect([...input.held]).toEqual(['forward']);
  });
});

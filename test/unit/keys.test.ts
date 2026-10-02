import { afterEach, describe, expect, test, vi } from 'vitest';
import { installShortcuts, isTextEntry, shortcutFor, type KeyStroke, type KeyTarget, type ShortcutAction } from '../../src/ui/common/keys';

const stroke = (key: string, mods: Partial<Omit<KeyStroke, 'key'>> = {}): KeyStroke => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
const input = (type: string): KeyTarget => ({ tagName: 'INPUT', type });
const BODY: KeyTarget = { tagName: 'BODY' };
const SELECT: KeyTarget = { tagName: 'SELECT', type: 'select-one' };
const TEXTAREA: KeyTarget = { tagName: 'TEXTAREA', type: 'textarea' };
const EDITABLE: KeyTarget = { tagName: 'DIV', isContentEditable: true };
const TEXT_ENTRY: readonly KeyTarget[] = [TEXTAREA, EDITABLE, ...['text', 'search', 'number', 'url', 'email', 'password', 'tel'].map(input)];
const NOT_TEXT_ENTRY: readonly KeyTarget[] = [
  ...['range', 'checkbox', 'radio', 'button', 'submit', 'file', 'color', 'date'].map(input),
  SELECT, { tagName: 'BUTTON', type: 'button' }, BODY, { tagName: 'svg' }, { tagName: 'DIV', isContentEditable: false },
];
const ctrlZ = stroke('z', { ctrlKey: true });
const ctrlShiftZ = stroke('Z', { ctrlKey: true, shiftKey: true });
const ctrlY = stroke('y', { ctrlKey: true });

describe('isTextEntry (SP2b spec §3.5)', () => {
  test('a textarea, a contentEditable element and the text-like inputs are text entry', () => {
    for (const t of TEXT_ENTRY) expect(isTextEntry(t), JSON.stringify(t)).toBe(true);
  });
  test('an input without a type is a text input (the DOM default); tag and type case do not matter', () => {
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntry({ tagName: 'input', type: 'NUMBER' })).toBe(true);
    expect(isTextEntry({ tagName: 'textarea' })).toBe(true);
  });
  test('range, checkbox, radio, button, file, colour and date inputs, select, buttons, the body, SVG and null are not', () => {
    for (const t of NOT_TEXT_ENTRY) expect(isTextEntry(t), JSON.stringify(t)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('shortcutFor', () => {
  test('Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo; Caps Lock does not matter', () => {
    expect(shortcutFor(ctrlZ, BODY)).toBe('undo');
    expect(shortcutFor(stroke('z', { metaKey: true }), BODY)).toBe('undo');
    expect(shortcutFor(stroke('Z', { ctrlKey: true }), BODY)).toBe('undo');
    expect(shortcutFor(ctrlShiftZ, BODY)).toBe('redo');
    expect(shortcutFor(stroke('z', { metaKey: true, shiftKey: true }), BODY)).toBe('redo');
    expect(shortcutFor(ctrlY, BODY)).toBe('redo');
    expect(shortcutFor(ctrlZ, null)).toBe('undo');
  });
  test('a focused range or select does not block undo: dragging a slider and then pressing Ctrl+Z undoes the drag', () => {
    for (const t of NOT_TEXT_ENTRY) {
      expect(shortcutFor(ctrlZ, t), JSON.stringify(t)).toBe('undo');
      expect(shortcutFor(ctrlShiftZ, t), JSON.stringify(t)).toBe('redo');
      expect(shortcutFor(ctrlY, t), JSON.stringify(t)).toBe('redo');
    }
  });
  test('in a text or number input, a textarea or a contentEditable element, undo and redo are left to the browser', () => {
    for (const t of TEXT_ENTRY) {
      expect(shortcutFor(ctrlZ, t), JSON.stringify(t)).toBeNull();
      expect(shortcutFor(ctrlShiftZ, t), JSON.stringify(t)).toBeNull();
      expect(shortcutFor(ctrlY, t), JSON.stringify(t)).toBeNull();
    }
  });
  test('Alt (and AltGr, which sets Ctrl too), Cmd+Y, Ctrl+Shift+Y and a plain Z are not shortcuts', () => {
    expect(shortcutFor(stroke('z', { ctrlKey: true, altKey: true }), BODY)).toBeNull();
    expect(shortcutFor(stroke('y', { metaKey: true }), BODY)).toBeNull();
    expect(shortcutFor(stroke('Y', { ctrlKey: true, shiftKey: true }), BODY)).toBeNull();
    expect(shortcutFor(stroke('z'), BODY)).toBeNull();
  });
  test('P toggles the side panel, except in text entry, in a select (type-ahead) and with Ctrl, Cmd or Alt', () => {
    expect(shortcutFor(stroke('p'), BODY)).toBe('togglePanel');
    expect(shortcutFor(stroke('P', { shiftKey: true }), BODY)).toBe('togglePanel');
    expect(shortcutFor(stroke('p'), input('range'))).toBe('togglePanel');
    expect(shortcutFor(stroke('p'), input('checkbox'))).toBe('togglePanel');
    expect(shortcutFor(stroke('p'), SELECT)).toBeNull();
    for (const t of TEXT_ENTRY) expect(shortcutFor(stroke('p'), t), JSON.stringify(t)).toBeNull();
    expect(shortcutFor(stroke('p', { ctrlKey: true }), BODY)).toBeNull();
    expect(shortcutFor(stroke('p', { metaKey: true }), BODY)).toBeNull();
    expect(shortcutFor(stroke('p', { altKey: true }), BODY)).toBeNull();
  });
  test('Escape closes the drawer unless a text-entry control has focus (it restores its draft value there)', () => {
    expect(shortcutFor(stroke('Escape'), BODY)).toBe('closeDrawer');
    expect(shortcutFor(stroke('Escape'), input('range'))).toBe('closeDrawer');
    expect(shortcutFor(stroke('Escape'), SELECT)).toBe('closeDrawer');
    for (const t of TEXT_ENTRY) expect(shortcutFor(stroke('Escape'), t), JSON.stringify(t)).toBeNull();
    expect(shortcutFor(stroke('Escape', { ctrlKey: true }), BODY)).toBeNull();
  });
  test('other keys are not shortcuts', () => {
    for (const k of ['a', 'Enter', ' ', 'Delete', 'y', 'Shift', 'Control']) expect(shortcutFor(stroke(k), BODY), k).toBeNull();
  });
});

describe('installShortcuts', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const keydown = (key: string | undefined, mods: Record<string, boolean> = {}) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  test('a shortcut key runs its action and prevents the default; other keys pass; the returned function removes the listener', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const got: ShortcutAction[] = [];
    const dispose = installShortcuts((a) => got.push(a));
    const z = keydown('z', { ctrlKey: true });
    const a = keydown('a');
    win.dispatchEvent(z);
    win.dispatchEvent(a);
    expect(got).toEqual(['undo']);
    expect([z.defaultPrevented, a.defaultPrevented]).toEqual([true, false]);
    dispose();
    win.dispatchEvent(keydown('z', { ctrlKey: true }));
    expect(got).toEqual(['undo']);
  });

  test('a key a control already handled (default prevented), an IME composition and a key-less event are ignored', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const got: ShortcutAction[] = [];
    const dispose = installShortcuts((a) => got.push(a));
    const handled = keydown('Escape');
    handled.preventDefault();
    win.dispatchEvent(handled);
    win.dispatchEvent(keydown('z', { ctrlKey: true, isComposing: true }));
    const autofill = keydown(undefined, { ctrlKey: true });
    expect(() => win.dispatchEvent(autofill)).not.toThrow();
    expect(got).toEqual([]);
    expect(autofill.defaultPrevented).toBe(false);
    dispose();
  });

  test('the event target decides: Ctrl+Z dispatched at a text input is left to the browser', () => {
    const field = Object.assign(new EventTarget(), { tagName: 'INPUT', type: 'text' });
    vi.stubGlobal('window', field);
    const got: ShortcutAction[] = [];
    const dispose = installShortcuts((a) => got.push(a));
    const z = keydown('z', { ctrlKey: true });
    field.dispatchEvent(z);
    expect(got).toEqual([]);
    expect(z.defaultPrevented).toBe(false);
    dispose();
  });
});

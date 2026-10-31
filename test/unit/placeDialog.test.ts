import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mountPlaceDialog } from '../../src/ui/world/placeDialog';
import { PLACE_COLOURS } from '../../src/ui/world/places';
import { installDom, type FakeElement } from './fixtures/domShim';

describe('mountPlaceDialog: B\'s "Save place" (SP5b spec §3.7, D12)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const mount = () => {
    const requestLock = vi.fn();
    const onClose = vi.fn();
    const dialog = mountPlaceDialog(dom.body as unknown as HTMLElement, { requestLock, onClose });
    return { dialog, requestLock, onClose };
  };
  const key = (code: string, k: string) => {
    const e = Object.assign(new Event('keydown', { cancelable: true }), { code, key: k, repeat: false });
    dom.document.dispatchEvent(e);
    return e;
  };
  const swatches = (): FakeElement[] => dom.el('place-dialog').querySelectorAll('button').filter((b) => b.classList.contains('place-swatch'));
  const pressed = (): number[] => swatches().flatMap((b, i) => (b.getAttribute('aria-pressed') === 'true' ? [i] : []));

  test('Enter saves the typed name and the chosen colour; Esc closes without saving and is consumed; the name field is selected; red is preselected', () => {
    const { dialog, requestLock, onClose } = mount();
    expect(dom.el('place-dialog').hidden).toBe(true);
    expect(dialog.isOpen).toBe(false);
    const canvas = dom.document.createElement('canvas');
    dom.document.setPointerLock(canvas);
    const save = vi.fn<(name: string, colour: number) => void>();
    dialog.open('Place 4 (312, 88, -1541)', save);
    // Opening releases the lock and shows "Save place" with the proposal, selected so typing replaces it.
    expect(dialog.isOpen).toBe(true);
    expect(dom.el('place-dialog').hidden).toBe(false);
    expect(dom.document.pointerLockElement).toBe(null);
    expect(dom.el('place-dialog').textContent).toContain('Save place');
    const name = dom.el('place-name');
    expect(name.value).toBe('Place 4 (312, 88, -1541)');
    expect(dom.document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 'Place 4 (312, 88, -1541)'.length]);
    // Eight swatches in D12's colours, red pressed.
    expect(swatches().map((b) => b.style.background)).toEqual([...PLACE_COLOURS]);
    expect(pressed()).toEqual([0]);
    // A click on blue chooses it; Enter saves the typed name with it, closes and takes the mouse back.
    swatches()[4]!.click();
    expect(pressed()).toEqual([4]);
    name.value = 'Base camp';
    const enter = key('Enter', 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(save.mock.calls).toEqual([['Base camp', 4]]);
    expect(dialog.isOpen).toBe(false);
    expect(dom.el('place-dialog').hidden).toBe(true);
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closed, Enter and Esc are left alone.
    expect(key('Enter', 'Enter').defaultPrevented).toBe(false);
    expect(key('Escape', 'Escape').defaultPrevented).toBe(false);

    // Opened again: red is preselected again; Esc closes without saving and is consumed (the map's shortcut skips it).
    const again = vi.fn<(name: string, colour: number) => void>();
    dialog.open('Place 5 (0, 70, 0)', again);
    expect(pressed()).toEqual([0]);
    expect(dom.el('place-name').value).toBe('Place 5 (0, 70, 0)');
    const esc = key('Escape', 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(again).not.toHaveBeenCalled();
    expect(dialog.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(requestLock).toHaveBeenCalledTimes(2);
    // The hidden name field gives the focus back, so the world's keys work again.
    expect(dom.document.activeElement).toBe(dom.body);
  });

  test('Enter with Cancel or a swatch focused is left to that button (nothing saved by the dialog); Enter or Esc during IME composition is left to the composition (PAGE-4)', () => {
    const { dialog } = mount();
    const save = vi.fn<(name: string, colour: number) => void>();
    dialog.open('Place 1 (0, 70, 0)', save);
    // A keyboard user tabs to Cancel and presses Enter: the button's own activation runs, not Save.
    dom.el('place-cancel').focus();
    expect(key('Enter', 'Enter').defaultPrevented).toBe(false);
    expect([save.mock.calls.length, dialog.isOpen]).toEqual([0, true]);
    swatches()[3]!.focus();
    expect(key('Enter', 'Enter').defaultPrevented).toBe(false);
    expect([save.mock.calls.length, dialog.isOpen]).toEqual([0, true]);
    // A CJK user commits a composed name with Enter (Chrome and Firefox: code 'Enter', key 'Process', isComposing).
    dom.el('place-name').focus();
    dom.el('place-name').value = '基地';
    for (const [code, k] of [['Enter', 'Process'], ['Escape', 'Escape']] as const) {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { code, key: k, repeat: false, isComposing: true });
      dom.document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect([save.mock.calls.length, dialog.isOpen]).toEqual([0, true]);
    // Enter with the Save button or the name field focused saves.
    dom.el('place-save').focus();
    expect(key('Enter', 'Enter').defaultPrevented).toBe(true);
    expect(save.mock.calls).toEqual([['基地', 0]]);
  });

  test('Save and Cancel are buttons: Save keeps the name and colour, Cancel saves nothing; both take the mouse back', () => {
    const { dialog, requestLock } = mount();
    const save = vi.fn<(name: string, colour: number) => void>();
    dialog.open('Place 1 (0, 70, 0)', save);
    swatches()[7]!.click();
    dom.el('place-save').click();
    expect(save.mock.calls).toEqual([['Place 1 (0, 70, 0)', 7]]);
    expect(dialog.isOpen).toBe(false);
    const cancelled = vi.fn<(name: string, colour: number) => void>();
    dialog.open('Place 2 (0, 70, 0)', cancelled);
    dom.el('place-cancel').click();
    expect(cancelled).not.toHaveBeenCalled();
    expect(dialog.isOpen).toBe(false);
    expect(requestLock).toHaveBeenCalledTimes(2);
  });

  test('`close()` closes without saving or requesting the lock; `dispose()` removes the overlay and its key listener', () => {
    const { dialog, requestLock, onClose } = mount();
    const save = vi.fn<(name: string, colour: number) => void>();
    dialog.open('Place 1 (0, 70, 0)', save);
    dialog.close();
    expect(dialog.isOpen).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(requestLock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    dialog.open('Place 1 (0, 70, 0)', save);
    dialog.dispose();
    expect(dom.body.querySelectorAll('div').some((d) => d.id === 'place-dialog')).toBe(false);
    expect(key('Enter', 'Enter').defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

/**
 * B's "Save place" dialog (SP5b spec §3.7, D12): a name field, proposed and selected so typing replaces it, and D12's
 * eight colour swatches, red chosen at each opening; Save and Cancel. It follows the palette's modal pattern
 * (`palette.ts`): opening releases the pointer lock; while it is open, Esc closes it and is consumed (the map's window
 * shortcut skips a default-prevented key); Enter is Save. Save, Enter, Cancel and Esc request the lock back (a refused
 * request leaves the pointer free; a click on the canvas takes it); `close()` does not (a failure closes it under its
 * panel). The overlay covers the world as the palette's does (its classes), so no click reaches the canvas. Text only
 * through `textContent`; no browser dialog.
 */
import { el } from '../common/dom';
import { PLACE_COLOURS } from './places';

export interface PlaceDialog {
  /** Shows the dialog with `proposed` as the name; Save or Enter calls `save` with the typed name and the colour's index. */
  open(proposed: string, save: (name: string, colour: number) => void): void;
  /** Closes without saving and without requesting the lock. */
  close(): void;
  readonly isOpen: boolean;
  /** Removes the overlay and its key listener; `onClose` is not called. */
  dispose(): void;
}

/** The swatches' names, for people who do not see the colour (also the map's Places tab's, SP5b spec §3.7). */
export const COLOUR_NAMES: Readonly<Record<(typeof PLACE_COLOURS)[number], string>> = {
  '#e5534b': 'Red', '#e0a030': 'Orange', '#e8d44d': 'Yellow', '#57ab5a': 'Green',
  '#4aa3df': 'Blue', '#986ee2': 'Purple', '#e275ad': 'Pink', '#dddddd': 'Light grey',
};

export function mountPlaceDialog(host: HTMLElement, o: { requestLock(): void; onClose(): void }): PlaceDialog {
  let isOpen = false;
  let colour = 0;
  let save: ((name: string, colour: number) => void) | null = null;
  const overlay = el('div', 'world-palette place-dialog');
  overlay.id = 'place-dialog';
  overlay.hidden = true;
  const panel = el('div', 'palette-panel place-panel');
  const name = el('input', 'place-name');
  name.id = 'place-name';
  name.type = 'text';
  name.setAttribute('aria-label', 'Place name');
  const swatchRow = el('div', 'palette-grid place-swatches');
  const swatches = PLACE_COLOURS.map((c, i) => {
    const b = el('button', 'palette-swatch place-swatch');
    b.type = 'button';
    b.dataset.colour = String(i);
    b.style.background = c;
    b.setAttribute('aria-label', COLOUR_NAMES[c]);
    b.addEventListener('click', () => choose(i));
    return b;
  });
  swatchRow.append(...swatches);
  const saveButton = el('button', 'place-save', 'Save');
  saveButton.id = 'place-save';
  saveButton.type = 'button';
  const cancelButton = el('button', 'place-cancel', 'Cancel');
  cancelButton.id = 'place-cancel';
  cancelButton.type = 'button';
  const buttons = el('div', 'place-buttons');
  buttons.append(saveButton, cancelButton);
  panel.append(el('h3', '', 'Save place'), name, swatchRow, buttons);
  overlay.append(panel);
  host.append(overlay);

  /** The chosen swatch is pressed, with a white rim. */
  function choose(i: number): void {
    colour = i;
    swatches.forEach((b, j) => {
      b.setAttribute('aria-pressed', String(j === i));
      b.style.borderColor = j === i ? '#fff' : '';
    });
  }

  /** Closes; with `keep`, the typed name and the colour are saved first; the lock is requested back. */
  const finish = (keep: boolean): void => {
    if (!isOpen) return;
    const f = save;
    const typed = name.value;
    close();
    if (keep) f?.(typed, colour);
    o.requestLock();
  };
  saveButton.addEventListener('click', () => finish(true));
  cancelButton.addEventListener('click', () => finish(false));

  const onKeyDown = (e: KeyboardEvent): void => {
    // A key that commits or cancels an IME composition belongs to the composition (PAGE-4).
    if (e.isComposing) return;
    if (e.code === 'Escape' || e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter') {
      // Enter on a focused Cancel is Cancel's own click (PAGE-4); elsewhere, a focused swatch included, it is Save (D12, N1).
      if (document.activeElement === cancelButton) return;
      e.preventDefault();
      finish(true);
    }
  };

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    save = null;
    overlay.hidden = true;
    // A focused name field, hidden, would still take the world's keys (`isTextEntry`).
    if (document.activeElement === name) name.blur();
    document.removeEventListener('keydown', onKeyDown);
    o.onClose();
  }

  return {
    get isOpen() {
      return isOpen;
    },
    open(proposed, onSave) {
      if (isOpen) return;
      isOpen = true;
      save = onSave;
      name.value = proposed;
      choose(0);
      overlay.hidden = false;
      document.exitPointerLock();
      document.addEventListener('keydown', onKeyDown);
      name.focus();
      name.select();
    },
    close,
    dispose() {
      isOpen = false;
      save = null;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    },
  };
}

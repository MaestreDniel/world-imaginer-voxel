import { DEFAULT_KEYMAP, resolveKey, resolveWheel, type Action, type KeyEntry } from './keymap';

/**
 * Keyboard, wheel and mouse input for the world (SP4a spec §7.1-§7.3, master §4.17). Events resolve to actions through
 * the key map only. Movement and sprint are held while their keys are down; every other action fires once per press.
 * A bound key's default is prevented with Ctrl held too, so sprint-strafing never opens the browser's dialogs
 * (Ctrl+D, Ctrl+S, Ctrl+A), while unbound keys and Ctrl combinations pass (Review Focus 1, ruling P40). The wheel
 * listener is not passive, so Ctrl+wheel changes the speed instead of zooming the page.
 *
 * input.ts touches only the target, doc and win it is given; it reads no globals (ruling P41): keys and
 * `pointerlockchange` arrive on the document, `blur` on the window, clicks, mouse movement and the wheel on the target.
 */

/** The actions held while their keys are down; the others fire `onAction`. */
const HELD: ReadonlySet<Action> = new Set<Action>(['forward', 'back', 'left', 'right', 'up', 'down', 'sprint']);

export function attachInput(
  target: HTMLElement,
  o: {
    onAction(a: Action): void;
    onLook(dx: number, dy: number): void;
    isTextFocus(): boolean;
    map?: readonly KeyEntry[];
    doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>;
    win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  },
): { held: ReadonlySet<Action>; dispose(): void } {
  const map = o.map ?? DEFAULT_KEYMAP;
  const held = new Set<Action>();
  // Physical keys down → their held action, so releasing Left Shift keeps 'down' while Right Shift is still down.
  const down = new Map<string, Action>();

  const refresh = (): void => {
    held.clear();
    for (const a of down.values()) held.add(a);
  };
  const clear = (): void => {
    down.clear();
    held.clear();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (o.isTextFocus()) return;
    const a = resolveKey(e, map);
    if (a === null) return;
    e.preventDefault();
    if (HELD.has(a)) {
      down.set(e.code, a);
      refresh();
    } else if (!e.repeat) {
      o.onAction(a);
    }
  };
  // A release always counts, even while typing, so no movement sticks.
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!down.delete(e.code)) return;
    refresh();
  };
  const onLockChange = (): void => {
    if (o.doc.pointerLockElement !== target) clear();
  };
  const onBlur = (): void => clear();
  const onClick = (): void => {
    try {
      // Chromium returns a promise that rejects when the lock is refused (e.g. right after Esc); others return nothing.
      const r: unknown = target.requestPointerLock();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // A refused lock leaves the pointer free; the next click retries.
    }
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (o.doc.pointerLockElement !== target) return;
    o.onLook(e.movementX, e.movementY);
  };
  const onWheel = (e: WheelEvent): void => {
    // The world never scrolls, and Ctrl+wheel must change the speed, not zoom the page.
    e.preventDefault();
    if (o.isTextFocus()) return;
    const a = resolveWheel(e.deltaY, map);
    if (a !== null) o.onAction(a);
  };

  const wheelOpts: AddEventListenerOptions = { passive: false };
  o.doc.addEventListener('keydown', onKeyDown);
  o.doc.addEventListener('keyup', onKeyUp);
  o.doc.addEventListener('pointerlockchange', onLockChange);
  o.win.addEventListener('blur', onBlur);
  target.addEventListener('click', onClick);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('wheel', onWheel, wheelOpts);

  return {
    held,
    dispose() {
      o.doc.removeEventListener('keydown', onKeyDown);
      o.doc.removeEventListener('keyup', onKeyUp);
      o.doc.removeEventListener('pointerlockchange', onLockChange);
      o.win.removeEventListener('blur', onBlur);
      target.removeEventListener('click', onClick);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('wheel', onWheel, wheelOpts);
    },
  };
}

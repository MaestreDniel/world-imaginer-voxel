import { DEFAULT_KEYMAP, resolveKey, resolveWheel, type Action, type KeyEntry } from './keymap';
import { createSprintTap } from './sprintTap';

/**
 * Keyboard, wheel and mouse input for the world (SP4a spec §7.1-§7.3, master §4.17). Events resolve to actions through
 * the key map only. Movement and sprint are held while their keys are down; every other action fires once per press.
 * Sprint is R held or a double-tapped W (Task 45b: Ctrl was sprint until then, and Ctrl+W closes the tab): a W keydown
 * within 0.35 s of the previous one latches sprint until W's keyup (`sprintTap.ts`), and `clear()` ends the latch with
 * the held keys. A bound key's default is prevented with Ctrl held too, so moving with Ctrl down never opens the
 * browser's dialogs (Ctrl+D, Ctrl+S, Ctrl+A), while unbound keys and Ctrl combinations pass (Review Focus 1, ruling
 * P40); the exception is Ctrl+R and Cmd+R (Shift too), which reload as in any page and are not sprint (ruling R61: an
 * edited world asks first through the page's beforeunload prompt). The wheel listener is not passive, so Ctrl+wheel changes the speed instead of zooming the page; the plain wheel
 * changes the hotbar slot (SP5a spec §4.1, D9), and Ctrl+wheel does too while `wheelCtrlAsSlot()` (walking).
 *
 * Mouse buttons (SP5a spec §4.1, D6): the first click on the canvas only takes the pointer lock; while the lock is held
 * and the world is active, `mousedown`/`mouseup` of LMB, MMB and RMB (0, 1, 2) reach `onButton` (MMB's down is
 * prevented, so no autoscroll), which only queues the edit for the frame step. The right-click menu and `auxclick`
 * never act on the canvas.
 *
 * input.ts touches only the target, doc and win it is given; it reads no globals (ruling P41): keys and
 * `pointerlockchange` arrive on the document, `blur` on the window, clicks, mouse movement and the wheel on the target.
 *
 * `active` is whether the world owns the controls (SP4c spec §2.3, D15: owner === 'world'). It is checked for every
 * action but `map`: while it is false a world key is neither acted on nor default-prevented (Space presses a focused map
 * button, `-` types), and the wheel changes no speed (it is still prevented: the world never scrolls). M acts either
 * way. The page calls `clear()` on every change of owner, so no key stays held across the hand-over.
 */

/** The actions held while their keys are down; the others fire `onAction`. */
const HELD: ReadonlySet<Action> = new Set<Action>(['forward', 'back', 'left', 'right', 'up', 'down', 'sprint']);

/** Ctrl+R or Cmd+R (Shift too): the browser's reload, never prevented nor resolved as sprint (ruling R61). */
const isReload = (e: KeyboardEvent): boolean => e.code === 'KeyR' && (e.ctrlKey || e.metaKey);

/** The `<input>` types a person types text into; a range, checkbox, radio, button or colour input is not one. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/**
 * Whether `el` is a text-entry control, where keys are ignored (spec §7.1 "while focus is in a text input"): a text-like
 * `<input>`, a `<textarea>` or contenteditable content. A focused range slider or `<select>` is not one, so H and F1
 * still close the help after a setting is touched (final review C-I2).
 */
export function isTextEntry(el: { readonly tagName: string; readonly type?: string; readonly isContentEditable?: boolean } | null): boolean {
  if (el === null) return false;
  if (el.isContentEditable === true) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el.type ?? '').toLowerCase());
}

/** The wheel distance of one speed step (spec §7.2, "one step per notch"): a mouse notch is 100-120 px in Chrome. */
const WHEEL_STEP_PX = 100;
/** A line of a line-mode wheel event (Firefox's mouse notch is 3 lines). */
const WHEEL_LINE_PX = 16;

/**
 * Turns wheel deltas into signed speed steps (negative: up, away from the user). Pixel deltas accumulate and step once
 * per 100 px, so a touchpad swipe of many small events steps a few times instead of once per event; the remainder is
 * dropped after a step, so a 120 px notch is one step, and a direction change starts over. Line and page events are
 * discrete notches: lines count 16 px, and each event steps at least once; a page event is one step.
 */
export function createWheelSteps(): { push(deltaY: number, deltaMode: number): number } {
  let acc = 0;
  return {
    push(deltaY, deltaMode) {
      if (!(deltaY < 0 || deltaY > 0)) return 0; // 0, and NaN from a broken event
      const sign = deltaY < 0 ? -1 : 1;
      let px: number;
      if (deltaMode === 0) px = deltaY;
      else if (deltaMode === 1) px = sign * Math.max(Math.abs(deltaY) * WHEEL_LINE_PX, WHEEL_STEP_PX);
      else px = sign * WHEEL_STEP_PX;
      if (acc !== 0 && Math.sign(acc) !== sign) acc = 0;
      acc += px;
      const n = Math.trunc(Math.abs(acc) / WHEEL_STEP_PX);
      if (n === 0) return 0;
      acc = 0;
      return sign * n;
    },
  };
}

export function attachInput(
  target: HTMLElement,
  o: {
    onAction(a: Action): void;
    onLook(dx: number, dy: number): void;
    /** LMB (0), MMB (1) or RMB (2) down or up on the canvas while it holds the lock and `active()` (SP5a spec §4.1). */
    onButton?(b: 0 | 1 | 2, down: boolean): void;
    /** While true the wheel resolves as if Ctrl were up, so Ctrl+wheel steps the slot (walking, SP5a spec D9). */
    wheelCtrlAsSlot?(): boolean;
    isTextFocus(): boolean;
    /** Whether the world owns the controls (SP4c spec §2.3); checked for every action but `map`. */
    active(): boolean;
    map?: readonly KeyEntry[];
    doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>;
    win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  },
): { held: ReadonlySet<Action>; clear(): void; dispose(): void } {
  const map = o.map ?? DEFAULT_KEYMAP;
  const held = new Set<Action>();
  // Physical keys down → their held action, so releasing Left Shift keeps 'down' while Right Shift is still down.
  const down = new Map<string, Action>();
  // The double-tapped forward key's sprint, added to `held` while forward is held.
  const tap = createSprintTap();

  const refresh = (): void => {
    held.clear();
    for (const a of down.values()) held.add(a);
    if (!held.has('forward')) tap.release();
    else if (tap.latched) held.add('sprint');
  };
  const clear = (): void => {
    down.clear();
    held.clear();
    tap.clear();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (o.isTextFocus() || isReload(e)) return;
    const a = resolveKey(e, map);
    if (a === null) return;
    if (a !== 'map' && !o.active()) return;
    e.preventDefault();
    if (HELD.has(a)) {
      if (a === 'forward') tap.press(e.timeStamp / 1000, e.repeat);
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
  const locked = (): boolean => o.doc.pointerLockElement === target;
  // Only while unlocked: a click while locked is an edit button's (onButton), so the first click never edits.
  const onClick = (): void => {
    if (locked()) return;
    try {
      // Chromium returns a promise that rejects when the lock is refused (e.g. right after Esc); others return nothing.
      const r: unknown = target.requestPointerLock();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // A refused lock leaves the pointer free; the next click retries.
    }
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!locked()) return;
    o.onLook(e.movementX, e.movementY);
  };
  const onMouseButton = (e: MouseEvent, isDown: boolean): void => {
    if (!locked() || !o.active()) return;
    const b = e.button;
    if (b !== 0 && b !== 1 && b !== 2) return; // the back and forward buttons are not the world's
    if (b === 1 && isDown) e.preventDefault(); // no autoscroll
    o.onButton?.(b, isDown);
  };
  const onMouseDown = (e: MouseEvent): void => onMouseButton(e, true);
  const onMouseUp = (e: MouseEvent): void => onMouseButton(e, false);
  const preventDefault = (e: Event): void => e.preventDefault();
  const wheelSteps = createWheelSteps();
  const onWheel = (e: WheelEvent): void => {
    // The world never scrolls, and Ctrl+wheel must change the speed, not zoom the page.
    e.preventDefault();
    if (o.isTextFocus() || !o.active()) return;
    const n = wheelSteps.push(e.deltaY, e.deltaMode);
    const a = resolveWheel(n, e.ctrlKey && o.wheelCtrlAsSlot?.() !== true, map);
    if (a === null) return;
    for (let i = Math.abs(n); i > 0; i--) o.onAction(a);
  };

  const wheelOpts: AddEventListenerOptions = { passive: false };
  o.doc.addEventListener('keydown', onKeyDown);
  o.doc.addEventListener('keyup', onKeyUp);
  o.doc.addEventListener('pointerlockchange', onLockChange);
  o.win.addEventListener('blur', onBlur);
  target.addEventListener('click', onClick);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mouseup', onMouseUp);
  target.addEventListener('contextmenu', preventDefault);
  target.addEventListener('auxclick', preventDefault);
  target.addEventListener('wheel', onWheel, wheelOpts);

  return {
    held,
    clear,
    dispose() {
      o.doc.removeEventListener('keydown', onKeyDown);
      o.doc.removeEventListener('keyup', onKeyUp);
      o.doc.removeEventListener('pointerlockchange', onLockChange);
      o.win.removeEventListener('blur', onBlur);
      target.removeEventListener('click', onClick);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('contextmenu', preventDefault);
      target.removeEventListener('auxclick', preventDefault);
      target.removeEventListener('wheel', onWheel, wheelOpts);
    },
  };
}

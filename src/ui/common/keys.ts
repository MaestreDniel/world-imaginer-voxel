/**
 * Global keyboard shortcuts of the editor (SP2b spec §3.5): P shows or hides the side panel, Ctrl/Cmd+Z undoes,
 * Ctrl/Cmd+Shift+Z and Ctrl+Y redo, Escape closes the drawer. The decision is a pure function of the key and the
 * focused element, so it is unit-tested without a DOM.
 */

/** The focused element as the shortcut rules see it (an Element satisfies it). */
export interface KeyTarget {
  readonly tagName: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
}

export type ShortcutAction = 'undo' | 'redo' | 'togglePanel' | 'closeDrawer';

/** The fields of a KeyboardEvent the rules read. */
export interface KeyStroke {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Input types that edit text, where the browser's own text undo applies (a missing type is 'text' in the DOM). */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'number', 'url', 'email', 'password', 'tel']);

/** A textarea, a contentEditable element, or an input of a text-editing type. */
export function isTextEntry(t: KeyTarget | null): boolean {
  if (t === null) return false;
  if (t.isContentEditable === true) return true;
  const tag = t.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && TEXT_INPUT_TYPES.has((t.type ?? 'text').toLowerCase());
}

/**
 * The action for a key press, or null to leave it to the page and the browser. Undo, redo and Escape are left to
 * text-entry controls; P also to a select (type-ahead). Alt (and AltGr, which also sets Ctrl) never matches.
 */
export function shortcutFor(e: KeyStroke, target: KeyTarget | null): ShortcutAction | null {
  if (e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const text = isTextEntry(target);
  if (e.ctrlKey || e.metaKey) {
    if (text) return null;
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey) return 'redo';
    return null;
  }
  if (key === 'p') return text || target?.tagName.toUpperCase() === 'SELECT' ? null : 'togglePanel';
  if (key === 'Escape') return text ? null : 'closeDrawer';
  return null;
}

/**
 * How long after the pointer lock is lost an Escape keydown is still ignored (SP4c spec §2.4): the press that releases
 * the lock in mode B may also arrive as a keydown, before or after `pointerlockchange`, and must not close the drawer.
 */
export const ESC_AFTER_UNLOCK_MS = 150;

/**
 * Whether an Escape keydown at `nowMs` may act (close the drawer or the cut tool): never while the pointer is locked,
 * nor within `ESC_AFTER_UNLOCK_MS` of the lock being lost at `unlockedAtMs` (-Infinity when it never was).
 */
export function escapeAllowed(nowMs: number, locked: boolean, unlockedAtMs: number): boolean {
  return !locked && nowMs - unlockedAtMs >= ESC_AFTER_UNLOCK_MS;
}

function keyTargetOf(t: EventTarget | null): KeyTarget | null {
  return t !== null && 'tagName' in t && typeof t.tagName === 'string' ? (t as KeyTarget) : null;
}

/**
 * Listens for keydown on window and runs `on` for each shortcut `enabled` accepts, preventing the key's default; a
 * disabled action is neither run nor prevented, so another listener (or the browser) still gets it (SP4c spec §2.4:
 * the standalone ?map installs undo and redo in its shell and P and Escape in the map tool). Keys a control already
 * handled (default prevented), IME compositions and key-less events (Chrome's autofill) are ignored. Returns a
 * function that removes the listener.
 */
export function installShortcuts(on: (a: ShortcutAction) => void, enabled: (a: ShortcutAction) => boolean = () => true): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing || typeof e.key !== 'string') return;
    const action = shortcutFor(e, keyTargetOf(e.target));
    if (action === null || !enabled(action)) return;
    e.preventDefault();
    on(action);
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

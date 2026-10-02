/**
 * Inline notices (SP2b spec §1.5): short messages with optional action buttons (for example "Undo") and an inline
 * confirmation (for example Switch/Cancel before a profile switch, §3.1). The UI never opens a browser dialog.
 */
import './notice.css';
import { el } from './dom';

export type NoticeKind = 'info' | 'warn' | 'error';

export interface NoticeAction {
  readonly label: string;
  run(): void;
}

export interface NoticeOptions {
  readonly kind?: NoticeKind;
  readonly actions?: readonly NoticeAction[];
  /** Removes the notice after this many ms; without it the notice stays until dismissed or cleared. */
  readonly timeoutMs?: number;
}

export interface Notices {
  /** Adds a notice; one with the same text is replaced. An action button runs its action and removes the notice. */
  show(text: string, opts?: NoticeOptions): void;
  /** Removes every notice; a pending confirmation resolves false. */
  clear(): void;
  /**
   * Shows `text` with the buttons `confirmLabel` and Cancel and resolves true on the first, false on Cancel,
   * on `clear()` and when a newer confirmation replaces it (one is pending at most).
   */
  confirm(text: string, confirmLabel: string): Promise<boolean>;
}

interface Button {
  readonly label: string;
  readonly className: string;
  readonly run: () => void;
}

export function createNotices(host: HTMLElement): Notices {
  host.classList.add('notices');
  /** Each shown row and what removing it does (clear its timer, settle its confirmation). */
  const rows = new Map<HTMLElement, { readonly text: string; readonly onRemove: () => void }>();
  let pendingConfirm: HTMLElement | null = null;

  function remove(row: HTMLElement): void {
    const entry = rows.get(row);
    if (entry === undefined) return;
    rows.delete(row);
    row.remove();
    entry.onRemove();
  }

  function add(text: string, kind: NoticeKind, buttons: readonly Button[], dismissible: boolean, timeoutMs: number | undefined, onRemove: () => void): HTMLElement {
    for (const [other, entry] of [...rows]) if (entry.text === text) remove(other);
    const row = el('div', `notice notice-${kind}`);
    row.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    row.append(el('span', 'notice-text', text));
    for (const b of buttons) {
      const button = el('button', b.className, b.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        try { b.run(); } finally { remove(row); }
      });
      row.append(button);
    }
    if (dismissible) {
      const close = el('button', 'notice-close', '×');
      close.type = 'button';
      close.title = 'Dismiss';
      close.setAttribute('aria-label', 'Dismiss');
      close.addEventListener('click', () => remove(row));
      row.append(close);
    }
    const timer = timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs) ? setTimeout(() => remove(row), timeoutMs) : null;
    rows.set(row, { text, onRemove: () => { if (timer !== null) clearTimeout(timer); onRemove(); } });
    host.append(row);
    return row;
  }

  return {
    show(text, opts = {}) {
      const buttons = (opts.actions ?? []).map((a): Button => ({ label: a.label, className: 'notice-action', run: () => a.run() }));
      add(text, opts.kind ?? 'info', buttons, true, opts.timeoutMs, () => {});
    },
    clear() {
      for (const row of [...rows.keys()]) remove(row);
    },
    confirm(text, confirmLabel) {
      if (pendingConfirm !== null) remove(pendingConfirm);
      return new Promise<boolean>((resolve) => {
        const row = add(text, 'warn', [
          { label: confirmLabel, className: 'notice-action notice-confirm', run: () => resolve(true) },
          { label: 'Cancel', className: 'notice-action', run: () => resolve(false) },
        ], false, undefined, () => {
          if (pendingConfirm === row) pendingConfirm = null;
          resolve(false);
        });
        pendingConfirm = row;
      });
    },
  };
}

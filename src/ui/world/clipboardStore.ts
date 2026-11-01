/**
 * Where the selection tool's clipboard lives (SP5c spec §4.2, D15, D26): `wi10`'s `meta['clipboard']`, one per browser,
 * written by the main thread through the page's own KV (a saved world's `saved.kv`; in an unsaved world `wi10` opened
 * at the first copy or paste; in the bench, `wi10-bench`), with a memory copy beside it.
 * - `write` (a copy or a cut) keeps the clipboard in memory, then makes one `KV.write` of `clipboardOps` (`ClipboardV1`,
 *   `persist/clipboard.ts`). A complete write is stored; an aborted or closed one is `{ ok: false }` with SP5b's storage
 *   wording, and the cut that asked posts nothing (D6, D26). With no KV (no storage, or a `kv()` that rejects, ruling
 *   P12) the clipboard lasts until the page closes, with D15's notice at the first such write only.
 * - `read` (Ctrl+V, and nothing else) is one `get`, decoded: so a copy made in another tab is pasted here. An absent
 *   record or a rejected read falls back to the memory copy (null when none); a record that fails a check is
 *   `unreadable`, and `unknown` counts the cells whose state key no longer parses (they read as air). After a write of
 *   this store's that was not stored, `read` gives the memory copy without reading, until a later write of this store
 *   is stored (ruling P19), so a Ctrl+V after a failed Ctrl+C pastes what was just copied.
 * Two tabs share the record: the last write wins, and a read is one transaction, so it sees one write whole.
 */
import { CLIPBOARD_KEY, clipboardOps, decodeClipboard, encodeClipboard } from '../../persist/clipboard';
import type { KV } from '../../persist/kv';
import type { Clipboard } from './clipboard';
import { backupFailureReason } from './modifyMode';

/** A write's outcome: stored, or kept in memory only (no storage); or refused with the storage's reason. */
export type ClipboardWrite = { readonly ok: true; readonly stored: boolean } | { readonly ok: false; readonly reason: string };

/** A read: the clipboard (null when none), whether the stored record could not be read, and its cells of unknown types. */
export interface ClipboardRead {
  readonly clip: Clipboard | null;
  readonly unreadable: boolean;
  readonly unknown: number;
}

export interface ClipboardStore {
  write(c: Clipboard): Promise<ClipboardWrite>;
  read(): Promise<ClipboardRead>;
}

/** D15's notice in a browser window that cannot store data, at the first copy or cut only. */
export const NO_STORAGE_NOTICE = 'The clipboard is kept only until this page closes: this browser window cannot store data';
export const NO_STORAGE_NOTICE_MS = 6_000;
/** A write on a connection that is closed (site data cleared, or the page closed it). */
const CLOSED_REASON = 'storage was closed';

const copyOf = (c: Clipboard): Clipboard => ({ w: c.w, h: c.h, d: c.d, values: c.values.slice() });

export function createClipboardStore(o: {
  kv(): Promise<KV | null>;
  notices: { show(text: string, ms: number): void };
}): ClipboardStore {
  let memory: Clipboard | null = null;
  /** The last write of this store was not stored: `read` gives `memory` until a later write is (ruling P19). */
  let memoryOnly = false;
  let noticeShown = false;

  /** The KV, or null when there is none or opening it failed (ruling P12). */
  async function kvOrNull(): Promise<KV | null> {
    try {
      return await o.kv();
    } catch {
      return null;
    }
  }

  const fromMemory = (): ClipboardRead => ({ clip: memory === null ? null : copyOf(memory), unreadable: false, unknown: 0 });

  return {
    async write(c) {
      memory = copyOf(c);
      memoryOnly = true;
      const kv = await kvOrNull();
      if (kv === null) {
        if (!noticeShown) {
          noticeShown = true;
          o.notices.show(NO_STORAGE_NOTICE, NO_STORAGE_NOTICE_MS);
        }
        return { ok: true, stored: false };
      }
      const r = await kv.write(clipboardOps(encodeClipboard(c.w, c.h, c.d, c.values)));
      if (r.status === 'complete') {
        memoryOnly = false;
        return { ok: true, stored: true };
      }
      if (r.status === 'closed') return { ok: false, reason: CLOSED_REASON };
      return { ok: false, reason: backupFailureReason(r.errorName ?? 'AbortError') };
    },
    async read() {
      if (memoryOnly) return fromMemory();
      const kv = await kvOrNull();
      if (kv === null) return fromMemory();
      let raw: unknown;
      try {
        [raw] = await kv.read([{ op: 'get', store: 'meta', key: CLIPBOARD_KEY }]);
      } catch {
        return fromMemory();
      }
      if (raw === undefined) return fromMemory();
      const d = decodeClipboard(raw);
      if (!d.ok) return { clip: null, unreadable: true, unknown: 0 };
      return { clip: { w: d.w, h: d.h, d: d.d, values: d.values }, unreadable: false, unknown: d.unknown };
    },
  };
}

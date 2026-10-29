/**
 * The sim worker's message handler (SP5a spec §2.1, D17), as `taskHandler.ts` is the pool worker's: no DOM and no worker
 * globals, so Node tests drive it directly and `sim.worker.ts` wires it to the worker's port. It owns the session's
 * DiffStore (§2.4) and the edit scratch, and answers each message in the order it comes:
 * - `attach`: attaches the page's shared store as thread 15 (`SIM_THREAD`), once; a repeat with the same store id and
 *   thread is answered `attached` again, anything else is BAD_MESSAGE (as the pool's workers, SP4b spec §2.8);
 * - `edits`: `applyEdits` over the attached store (NOT_ATTACHED before the attach), clocked by `performance.now`,
 *   answered `edited` with its arrays transferred; a refusal (`StoreFull` included, as `'full'`) is a result, not an error;
 * - `diff`: the DiffStore's entries of the column (`readDiff`), transferred; zero-length arrays when it holds none.
 * A message the guard refuses is BAD_MESSAGE, with nothing written. Any throw out of the pipeline is an `error` reply
 * carrying the message's id: STORE_CORRUPT for `StoreCorrupt` (a pool lock held by a failed thread), INTERNAL otherwise;
 * the page treats either as the sim's failure (§2.1). Any `error` reply latches the handler: the page has then released
 * every sim pin and marked thread 15 dead, so each later `edits` (one already queued before the page terminated the
 * worker) is answered INTERNAL with nothing written; `attach` and `diff` answer as before, since neither writes the
 * store. `applyEdits` runs inside its own read section, and the writes it retires wait in this thread's limbo, which
 * `drain` frees; the shell drains after each message and every `SIM_DRAIN_MS` while entries are left.
 */
import { createDiffStore } from '../sim/diffStore';
import { applyEdits, createEditScratch, readDiff, type EditScratch } from '../sim/edits';
import { R_STORE_ID, SIM_THREAD } from '../world/store/reclaim';
import { attachStore, StoreCorrupt, type VoxelStore } from '../world/store/store';
import { parseToSim, type ErrorCode, type FromSim } from './protocol';

/** The sim's limbo retry interval while entries are left (§2.1: it has no reply loop like the pool's). */
export const SIM_DRAIN_MS = 100;

export interface SimReply {
  readonly msg: FromSim;
  readonly transfer: ArrayBuffer[];
}

export interface SimHandler {
  handle(m: unknown): SimReply;
  /** Frees this thread's limbo entries no live reader can hold (`store.drain()`); the entries left, 0 without a store. */
  drain(): number;
}

const err = (jobId: number | null, code: ErrorCode, message: string): SimReply => ({ msg: { type: 'error', jobId, epoch: null, code, message }, transfer: [] });
/** The message's integer id, or null (for the replies to malformed messages). */
const idOf = (raw: unknown): number | null => {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : undefined;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};
const now = (): number => performance.now();

export function createSimHandler(): SimHandler {
  let store: VoxelStore | null = null;
  const diffs = createDiffStore();
  /** The relight rings and the 3 × 3 cache (≈ 9 MB), allocated on the first batch. */
  let scratch: EditScratch | null = null;
  /** The first `error` reply's code and message, once one was sent: later batches write nothing. */
  let failed: string | null = null;
  const reply = (raw: unknown): SimReply => {
    const m = parseToSim(raw);
    const id = idOf(raw);
    if (m === null) return err(id, 'BAD_MESSAGE', 'malformed message');
    try {
      switch (m.type) {
        case 'attach': {
          if (store !== null) {
            // A posted SharedArrayBuffer arrives as a new object, so the store id decides (SP4b spec §2.8).
            const same = Atomics.load(new Int32Array(m.handles.reclaim), R_STORE_ID) === store.storeId;
            return same ? { msg: { type: 'attached' }, transfer: [] } : err(null, 'BAD_MESSAGE', 'the store is already attached');
          }
          store = attachStore(m.handles, SIM_THREAD);
          return { msg: { type: 'attached' }, transfer: [] };
        }
        case 'edits': {
          if (failed !== null) return err(m.id, 'INTERNAL', `the sim failed earlier (${failed}): nothing written`);
          if (store === null) return err(m.id, 'NOT_ATTACHED', 'no attach yet');
          const r = applyEdits(store, diffs, scratch ??= createEditScratch(), m.edits, now);
          const msg: FromSim = {
            type: 'edited', id: m.id, prev: r.prev, next: r.next, dirty: r.dirty, entryCols: r.entryCols, refused: r.refused,
            relightMs: r.relightMs, editMs: r.editMs,
          };
          return { msg, transfer: [r.prev.buffer, r.next.buffer, r.dirty.buffer, r.entryCols.buffer] as ArrayBuffer[] };
        }
        case 'diff': {
          const d = readDiff(diffs, m.cx, m.cz);
          if (d === null) {
            return { msg: { type: 'diff', id: m.id, cx: m.cx, cz: m.cz, sy: new Uint8Array(0), idx: new Uint16Array(0), value: new Uint32Array(0) }, transfer: [] };
          }
          return { msg: { type: 'diff', id: m.id, cx: m.cx, cz: m.cz, sy: d.sy, idx: d.idx, value: d.value }, transfer: [d.sy.buffer, d.idx.buffer, d.value.buffer] as ArrayBuffer[] };
        }
        default: {
          const never: never = m;
          return err(id, 'BAD_MESSAGE', `no handler for ${(never as { type: string }).type}`);
        }
      }
    } catch (e) {
      // SP4b spec §2.6: a pool lock held by a failed thread is fatal, never retried.
      return err(id, e instanceof StoreCorrupt ? 'STORE_CORRUPT' : 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  };
  return {
    handle(raw) {
      const r = reply(raw);
      if (r.msg.type === 'error' && failed === null) failed = `${r.msg.code}: ${r.msg.message}`;
      return r;
    },
    drain: () => (store === null ? 0 : store.drain()),
  };
}

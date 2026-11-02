/**
 * The world's edit path (SP5a spec §2.1, §2.6, §2.7, D13): every edit of the page (a click, a block undo, the bench's
 * L10 script, the smoke's hook) goes through `post`.
 *
 * - **The gate:** a batch is refused at once, with nothing posted, when any edited column's 3 × 3 is not open
 *   (`editState` 1: `unloaded`, else 2: `regenerating`), when the path is disabled or the sim failed (`failed`).
 * - **The post:** the post time is recorded, each distinct edited column's 3 × 3 pinned once (`simPin`), and the batch
 *   sent to the sim. In the reply's task: each pin released (`simUnpin`), the reply's dirty columns remeshed
 *   (`markEdited`, a refusal's too: a `full` rollback moved its columns' versions, §2.2), and an accepted batch of at
 *   most two edits (SP5c D23) has its latency sample opened (`latency.posted`, its edited column the first edit's: every
 *   SP5a action is one voxel, and a door's two halves are timed by the first; from the click's time when the page
 *   passes one, §4.6, else from the post). A refusal resolves `{ ok: false, why }`; `full` shows "Could not
 *   edit: memory full" for 4 s.
 * - **Bulk batches** (SP5c spec §3.4, D23): a batch of `BULK_MIN_EDITS` or more (a cut, paste or move, or the undo or
 *   redo of a large step) opens no latency sample, so the HUD's "edit p95" and G2 stay single-edit figures; while its
 *   reply is pending past `WORKING_NOTICE_MS` it shows "Working on n blocks…" (no timeout), hidden at its reply, refused,
 *   accepted or `SimFailed`. `bulkPending()` tells the autosave a bulk batch is posted and not answered (§2.8).
 * - **The sim's failure:** the client runs the page's failure handler first (`onSimFailure`: thread 15 dead, the path
 *   disabled, every pin released by `simUnpinAll`), then rejects each pending batch with `SimFailed`, which resolves
 *   `failed` here without a `simUnpin`.
 *
 * An accepted batch resolves `{ ok: true, prev, next }`: each edit's DiffStore entry before and after it (`NO_ENTRY`
 * for none), which the block history records (§4.5). An empty batch resolves `{ ok: true }` with empty `prev` and
 * `next` and posts nothing. `settled` lets the block history hold a Ctrl+Z or Ctrl+Y until every pending reply has
 * been recorded (§4.5).
 */
import { colKey, colKeyCx, colKeyCz } from '../../core/coords';
import type { Coordinator } from '../../engine/coordinator';
import { SimFailed, type SimClient } from '../../engine/simClient';
import { PACKED_MIN_EDITS, type Edit } from '../../workers/protocol';
import type { EditLatency } from './editLatency';

export type EditOutcome =
  | { readonly ok: true; readonly prev: Uint32Array; readonly next: Uint32Array }
  | { readonly ok: false; readonly why: 'unloaded' | 'regenerating' | 'changed' | 'noProto' | 'full' | 'failed' };

export interface EditPath {
  /**
   * Posts a batch through the gate; resolves with the sim's outcome or the refusal (never rejects on the sim's failure).
   * `tClick` (on `now`'s clock), a click's time, starts the accepted batch's latency sample (spec §4.6 "from the
   * click"); without it the sample starts at the post (G2's, §6.2).
   */
  post(edits: readonly Edit[], tClick?: number): Promise<EditOutcome>;
  /** Whether a posted batch is still waiting for its reply. */
  pending(): boolean;
  /** Whether a bulk batch (`BULK_MIN_EDITS` or more edits) is posted and not answered (SP5c spec §3.4, D23). */
  bulkPending(): boolean;
  /**
   * Resolves once no batch is pending and after the continuations each pending post's promise had when `settled` was
   * called (the page's `record`) have run; at once (in a promise job) when nothing is pending.
   */
  settled(): Promise<void>;
  /** Closes the path: every later `post` resolves `failed` with nothing posted. */
  disable(): void;
  /** False once disabled or once the sim failed. */
  readonly enabled: boolean;
}

/** The notice of a `full` refusal (§2.2) and how long it shows. */
export const EDIT_FULL_NOTICE = 'Could not edit: memory full';
const EDIT_FULL_MS = 4000;

/**
 * A batch of more edits than a door's two halves (the largest click, master §4.12) is bulk (SP5c spec §3.4, D23); the sim
 * client posts each such batch packed (`PACKED_MIN_EDITS`, D28's lever 1).
 */
export const BULK_MIN_EDITS = PACKED_MIN_EDITS;
/** How long a bulk batch's reply may take before "Working on n blocks…" shows (D23). */
export const WORKING_NOTICE_MS = 250;

/** A count as the notices write it: "12,345". */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The notice of a bulk batch whose reply is pending past `WORKING_NOTICE_MS` (D23). */
export function workingNotice(n: number): string {
  return `Working on ${formatCount(n)} blocks…`;
}

const FAILED: EditOutcome = Object.freeze({ ok: false, why: 'failed' });
const UNLOADED: EditOutcome = Object.freeze({ ok: false, why: 'unloaded' });
const REGENERATING: EditOutcome = Object.freeze({ ok: false, why: 'regenerating' });

export function createEditPath(o: {
  sim: Pick<SimClient, 'edits' | 'failed'>;
  coordinator: Pick<Coordinator, 'editState' | 'simPin' | 'simUnpin' | 'markEdited'>;
  latency: EditLatency;
  now(): number;
  /** `ms` 0 shows the notice with no timeout (the working notice, taken down through `hide`). */
  notices: { show(text: string, ms: number): void; hide(text: string): void };
  /** The working notice's timer; `globalThis`'s `setTimeout` and `clearTimeout` when absent. */
  timers?: { set(f: () => void, ms: number): number; clear(id: number): void };
}): EditPath {
  // Under Node (the harnesses, the metrics) `setTimeout` returns a `Timeout`, which `clearTimeout` takes back as it was.
  const timers = o.timers ?? {
    set: (f: () => void, ms: number) => globalThis.setTimeout(f, ms) as unknown as number,
    clear: (id: number) => { globalThis.clearTimeout(id); },
  };
  let disabled = false;
  let inFlight = 0;
  let bulkInFlight = 0;
  /** The promises `post` returned that have not settled yet. */
  const live = new Set<Promise<EditOutcome>>();
  const closed = (): boolean => disabled || o.sim.failed;
  // Waited after the continuations already on each pending promise (registered before this, so they run first), and
  // again while a post made meanwhile is pending.
  const settled = (): Promise<void> => Promise.allSettled([...live]).then(() => (inFlight > 0 ? settled() : undefined));

  return {
    post(edits, tClick) {
      if (closed()) return Promise.resolve(FAILED);
      if (edits.length === 0) return Promise.resolve({ ok: true, prev: new Uint32Array(0), next: new Uint32Array(0) });
      // The distinct edited columns, the first edit's first; any closed 3 × 3 refuses the batch.
      const cols: number[] = [];
      let regenerating = false;
      for (const e of edits) {
        const cx = e.x >> 4;
        const cz = e.z >> 4;
        const k = colKey(cx, cz);
        if (cols.includes(k)) continue;
        cols.push(k);
        const s = o.coordinator.editState(cx, cz);
        if (s === 1) return Promise.resolve(UNLOADED);
        if (s === 2) regenerating = true;
      }
      if (regenerating) return Promise.resolve(REGENERATING);
      const tPost = o.now();
      for (const k of cols) o.coordinator.simPin(colKeyCx(k), colKeyCz(k));
      inFlight++;
      const bulk = edits.length >= BULK_MIN_EDITS;
      // A bulk batch's working notice: shown once if the reply has not come `WORKING_NOTICE_MS` after the post.
      const text = bulk ? workingNotice(edits.length) : '';
      let shown = false;
      let timer = 0;
      if (bulk) {
        bulkInFlight++;
        timer = timers.set(() => {
          shown = true;
          o.notices.show(text, 0);
        }, WORKING_NOTICE_MS);
      }
      /** The bulk batch answered (accepted, refused or `SimFailed`): its timer cleared, its notice hidden. */
      const answered = (): void => {
        if (!bulk) return;
        bulkInFlight--;
        timers.clear(timer);
        if (shown) o.notices.hide(text);
      };
      const p = o.sim.edits(edits).then((reply): EditOutcome => {
        inFlight--;
        answered();
        for (const k of cols) o.coordinator.simUnpin(colKeyCx(k), colKeyCz(k));
        o.coordinator.markEdited(reply.dirty);
        if (reply.refused === null) {
          if (!bulk) o.latency.posted(tPost, o.now(), cols[0]!, reply.dirty, reply.relightMs, reply.editMs, tClick ?? tPost);
          return { ok: true, prev: reply.prev, next: reply.next };
        }
        if (reply.refused === 'full') o.notices.show(EDIT_FULL_NOTICE, EDIT_FULL_MS);
        return { ok: false, why: reply.refused };
      }, (e: unknown): EditOutcome => {
        inFlight--;
        answered();
        // The failure handler already released every pin (`simUnpinAll`), before this rejection.
        if (e instanceof SimFailed) return FAILED;
        throw e;
      });
      live.add(p);
      const done = (): void => { live.delete(p); };
      void p.then(done, done);
      return p;
    },
    pending: () => inFlight > 0,
    bulkPending: () => bulkInFlight > 0,
    settled,
    disable() {
      disabled = true;
    },
    get enabled() {
      return !closed();
    },
  };
}

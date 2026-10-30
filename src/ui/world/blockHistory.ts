/**
 * The block history (SP5a spec §4.5, D13): the last `BLOCK_HISTORY_STEPS` actions of the session, each one step, and a
 * redo side that a new step clears. The page records a step after each accepted action post (`createActionPost`: a
 * click, a bucket, a hold-repeat, the smoke's hook), with each voxel's DiffStore entry before and after it from the
 * reply's `prev` and `next` (`NO_ENTRY` for none; rulings R27: the entry after, not the posted value, since a set equal
 * to the generated value leaves none).
 *
 * - **Undo** posts the step's before-entries (`set` with the value, `revert` for `NO_ENTRY`), redo its after-entries,
 *   through the edit path's gate (§2.1); each `expect` is the other side's entry, or, when that side has no entry, the
 *   voxel's value read now (`read`: it then holds its generated value, which an Apply may have changed). An undo posts
 *   its edits in reverse order, so a voxel edited twice in one step gets each `expect` right.
 * - **A press while a post is pending** (a click's, or the history's own previous one) is held until the edit path has
 *   settled (every pending reply recorded), so it always acts on the step the user last saw land; held presses run in
 *   order, each after the previous reply.
 * - **Accepted:** the step moves to the other side and "Undo · blocks" or "Redo · blocks" shows for 1.5 s. **Refused
 *   as `changed`** (SP5b D32; the step's blocks were changed since, by another edit or by an edit saved without its
 *   step before a reload): the step is dropped (by identity) and "Can't undo there: the blocks changed" ("Can't redo
 *   there: …") shows for 4 s, so the next press reaches the older steps. **Otherwise refused:** the step stays;
 *   `unloaded` and `regenerating` show "Can't undo there: not loaded" / "… regenerating" ("Can't redo there: …") for
 *   4 s; `noProto`, `full` and `failed` show nothing of their own (the edit path already shows `full`'s notice, and the
 *   sim's failure its own).
 * - **Kept across reloads** (SP5b spec §3.4 step 6, D6): `snapshot` gives both sides for the autosave's `history`
 *   record, `restore` puts a saved world's back at the open (each side its newest `BLOCK_HISTORY_STEPS`), and
 *   `version` moves with every change of either side, so the autosave posts the history only when it changed.
 */
import { NO_ENTRY } from '../../sim/diffStore';
import type { Edit } from '../../workers/protocol';
import type { EditOutcome } from './editPath';

/** The steps the history keeps (spec §4.5). */
export const BLOCK_HISTORY_STEPS = 100;
/** How long "Undo · blocks" / "Redo · blocks" shows (D13). */
const DONE_NOTICE_MS = 1500;
/** How long a refusal's "Can't undo there: …" shows (D13). */
const REFUSED_NOTICE_MS = 4000;

/** One action's edits, each voxel's DiffStore entry before and after it (`NO_ENTRY` for none). */
export interface BlockStep {
  readonly edits: readonly { readonly x: number; readonly y: number; readonly z: number; readonly before: number; readonly after: number }[];
}

export interface BlockHistory {
  /** Adds a step on top (the oldest dropped past `BLOCK_HISTORY_STEPS`) and clears the redo side. */
  record(step: BlockStep): void;
  /** Ctrl+Z while the world owns the controls. */
  undo(): void;
  /** Ctrl+Y or Ctrl+Shift+Z while the world owns the controls. */
  redo(): void;
  /** The steps that can be undone. */
  readonly size: number;
  /** The steps that can be redone. */
  readonly redoSize: number;
  /** Both sides, oldest first, as copies (a later step does not reach them). */
  snapshot(): { done: BlockStep[]; undone: BlockStep[] };
  /** Replaces both sides with `done` and `undone` (oldest first), each cut to its newest `BLOCK_HISTORY_STEPS`. */
  restore(done: readonly BlockStep[], undone: readonly BlockStep[]): void;
  /** Moved by `record`, an accepted undo or redo, a dropped step and `restore`. */
  readonly version: number;
}

type Press = 'undo' | 'redo';

export function createBlockHistory(o: {
  post(edits: readonly Edit[]): Promise<EditOutcome>;
  /** The voxel's value now (`state << 8 | fluid`), read inside a read section. */
  read(x: number, y: number, z: number): number;
  /** The edit path's: whether a post is waiting for its reply, and the wait for every pending reply to be recorded. */
  pending(): boolean;
  settled(): Promise<void>;
  notices: { show(text: string, ms: number): void };
}): BlockHistory {
  const done: BlockStep[] = [];
  const undone: BlockStep[] = [];
  const held: Press[] = [];
  let running = false;
  let version = 0;

  const push = (side: BlockStep[], step: BlockStep): void => {
    side.push(step);
    if (side.length > BLOCK_HISTORY_STEPS) side.shift();
  };

  /** The batch that takes `step`'s voxels to its before-entries (undo) or its after-entries (redo). */
  const editsOf = (step: BlockStep, press: Press): Edit[] => {
    const out: Edit[] = [];
    const n = step.edits.length;
    for (let i = 0; i < n; i++) {
      const e = step.edits[press === 'undo' ? n - 1 - i : i]!;
      const to = press === 'undo' ? e.before : e.after;
      const from = press === 'undo' ? e.after : e.before;
      const expect = from === NO_ENTRY ? o.read(e.x, e.y, e.z) : from;
      out.push(to === NO_ENTRY
        ? { x: e.x, y: e.y, z: e.z, op: 'revert', value: 0, expect }
        : { x: e.x, y: e.y, z: e.z, op: 'set', value: to, expect });
    }
    return out;
  };

  const run = async (press: Press): Promise<void> => {
    const from = press === 'undo' ? done : undone;
    const step = from[from.length - 1];
    if (step === undefined) return;
    const out = await o.post(editsOf(step, press));
    // By identity: a step recorded (or restored) while this post was pending may sit above it now.
    const take = (): void => {
      const i = from.lastIndexOf(step);
      if (i >= 0) from.splice(i, 1);
      version++;
    };
    if (out.ok) {
      take();
      push(press === 'undo' ? undone : done, step);
      o.notices.show(press === 'undo' ? 'Undo · blocks' : 'Redo · blocks', DONE_NOTICE_MS);
    } else if (out.why === 'changed') {
      take();
      o.notices.show(`Can't ${press} there: the blocks changed`, REFUSED_NOTICE_MS);
    } else if (out.why === 'unloaded' || out.why === 'regenerating') {
      o.notices.show(`Can't ${press} there: ${out.why === 'unloaded' ? 'not loaded' : 'regenerating'}`, REFUSED_NOTICE_MS);
    }
  };

  /** Runs the held presses in order, each once nothing is pending; the first at once when nothing is. */
  const drain = async (): Promise<void> => {
    running = true;
    try {
      while (held.length > 0) {
        if (o.pending()) {
          await o.settled();
          continue;
        }
        await run(held.shift()!);
      }
    } finally {
      running = false;
    }
  };

  const press = (p: Press): void => {
    held.push(p);
    if (!running) void drain();
  };

  return {
    record(step) {
      push(done, step);
      undone.length = 0;
      version++;
    },
    undo: () => press('undo'),
    redo: () => press('redo'),
    get size() {
      return done.length;
    },
    get redoSize() {
      return undone.length;
    },
    snapshot: () => ({ done: done.slice(), undone: undone.slice() }),
    restore(d, u) {
      done.splice(0, done.length, ...d.slice(Math.max(0, d.length - BLOCK_HISTORY_STEPS)));
      undone.splice(0, undone.length, ...u.slice(Math.max(0, u.length - BLOCK_HISTORY_STEPS)));
      version++;
    },
    get version() {
      return version;
    },
  };
}

/**
 * The page's post for an action (a click, a bucket, a hold-repeat, the smoke's hook; spec §4.5): `post`, and on an
 * accepted non-empty batch one step recorded, per edit k `before` = the reply's `prev[k]` and `after` its `next[k]`, in
 * the reply's own continuation (so the edit path's `settled` waits for it). A refused batch records nothing.
 */
export function createActionPost(o: {
  post(edits: readonly Edit[], tClick?: number): Promise<EditOutcome>;
  record(step: BlockStep): void;
}): (edits: readonly Edit[], tClick?: number) => Promise<EditOutcome> {
  return (edits, tClick) => o.post(edits, tClick).then((out) => {
    if (out.ok && edits.length > 0) {
      o.record({ edits: edits.map((e, k) => ({ x: e.x, y: e.y, z: e.z, before: out.prev[k]!, after: out.next[k]! })) });
    }
    return out;
  });
}

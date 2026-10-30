/**
 * The saved world's autosave (SP5b spec §3.2, D5, D18): when the page posts `flush` to the sim, and the state it posts.
 *
 * - **Triggers:** a 2,000 ms timer, independent of frames (the frame pauses under overlays); `visibilitychange` to
 *   hidden, `pagehide` and `beforeunload`; `flushNow` (a failure after the reveal, the bench, the test hook); and
 *   `beforeLeave` before every navigation the page starts, which posts and waits for `flushed` at most 1,000 ms.
 * - **Changed** since the last committed flush: an edit reply (`editsSince()` above the count that flush captured), the
 *   state (its canonical JSON without `updated` and `flushSeq`), the history's version, a `markChanged()` (a pending
 *   `record`, a place) or a failed flush. A post captures the four; its `flushed` ok commits only what it captured, so
 *   what arrives while it is in flight still counts for the next tick. A failed flush keeps "changed", so every later
 *   tick and trigger posts again.
 * - The timer's tick posts only when something changed; it first waits for the edit path to settle (`settled()`), at
 *   most 1,000 ms, then builds the state and the history in the same task, so a flushed edit's step is in the same
 *   flush. The hide and close triggers post at once when something changed; `flushNow` and `beforeLeave` always post.
 *   The history is posted only when its version differs from the last committed one, else null.
 * - `pause(true)` stops the timer's posts (the bench's L1-L10 and L11's "off" parts), never `flushNow`'s. A `closed`
 *   result (the browser closed the connection, D14) stops the timer and the hide and close triggers; a `flush` that
 *   rejects `SimFailed` (the sim is gone) counts as not saved, reaches no notice, and stops every post.
 *
 * The state is built at a post, never per frame (SP4b D25: the frame step allocates nothing at rest).
 */
import { canonicalJSON } from '../../core/params/canonical';
import { SimFailed } from '../../engine/simClient';
import { normalizeState, type HistoryRecord, type HotbarRecord, type Place, type StateRecord } from '../../persist/saves';
import type { FlyState } from '../../player/fly';
import type { FlushedMsg } from '../../workers/protocol';
import { STATE_BOUNDS } from './stateBounds';

/** The timer's period (D5). */
export const AUTOSAVE_MS = 2000;
/** How long the timer's tick waits for the edit path to settle before it builds the state anyway. */
export const SETTLE_WAIT_MS = 1000;
/** How long a navigation waits for its flush's `flushed` (`beforeLeave`'s default). */
export const LEAVE_WAIT_MS = 1000;

/**
 * The `state` record of the page's pose, clock, hotbar and places, through the §2.1 normaliser with `STATE_BOUNDS`, so
 * −0 and non-finite numbers never reach Export (a bad pose saves no player: the spawn). `flushSeq` is the sim's. The
 * hotbar is the record the hotbar stores (`{ v: 1, active, slots }`): anything else saves the default hotbar.
 */
export function snapshotState(o: {
  worldId: string;
  fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'mode' | 'speed'>;
  time: { t: number; speedIndex: number };
  hotbar: HotbarRecord;
  places: readonly Place[];
  updated: number;
}): StateRecord {
  const { x, y, z, yaw, pitch, mode, speed } = o.fly;
  const raw = {
    worldId: o.worldId, flushSeq: 0, updated: o.updated, player: { x, y, z, yaw, pitch, mode, speed },
    time: { t: o.time.t, speedIndex: o.time.speedIndex }, hotbar: o.hotbar, places: o.places,
  };
  return normalizeState(raw, o.worldId, STATE_BOUNDS).state;
}

export interface AutosaveDeps {
  clock: {
    now(): number;
    setInterval(f: () => void, ms: number): number;
    clearInterval(id: number): void;
    setTimeout(f: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
  /** The page's events; `on` returns the unsubscribe. */
  events: { on(type: 'visibilitychange' | 'pagehide' | 'beforeunload', f: () => void): () => void; hidden(): boolean };
  /** The sim client's `flush`: resolves with `flushed`, ok or not; rejects `SimFailed` when the sim is gone. */
  flush(state: StateRecord, history: HistoryRecord | null): Promise<FlushedMsg>;
  /** The state (`snapshotState`), the block history's record and its version (moved by every recorded step, undo, redo). */
  build(): { state: StateRecord; history: HistoryRecord; historyVersion: number };
  /** The edit path's wait for every pending reply to be recorded. */
  settled(): Promise<void>;
  /** The edit replies counted since the page opened (a running count, never reset: the autosave keeps its baseline). */
  editsSince(): number;
  /** Every `flushed` (the storage notices, Task 29); never called for a `SimFailed`. */
  onResult(r: FlushedMsg): void;
}

export interface Autosave {
  /** The timer's tick: when nothing pauses it and something changed, waits for `settled()` (≤ 1,000 ms) and posts. */
  tick(): Promise<void>;
  /** Posts now; resolves with `flushed`, or null when the sim is gone (or the autosave disposed). */
  flushNow(): Promise<FlushedMsg | null>;
  /** Posts now; resolves at `flushed` or after `ms` (`LEAVE_WAIT_MS`), whichever comes first. */
  beforeLeave(ms?: number): Promise<void>;
  /** Counts a change the state does not show (a pending `record`, a place) for the next post. */
  markChanged(): void;
  /** Stops (true) or resumes (false) the timer's posts. */
  pause(on: boolean): void;
  /** Stops the timer and the triggers; nothing posts after it. */
  dispose(): void;
}

/** What a post captured, and so what its committed `flushed` commits. */
interface Capture {
  readonly seq: number;
  readonly edits: number;
  readonly marks: number;
  readonly historyVersion: number;
  readonly stateKey: string;
}

type Built = ReturnType<AutosaveDeps['build']>;

/** The state's canonical JSON without what every build changes (`updated`) or the sim sets (`flushSeq`). */
const stateKeyOf = (s: StateRecord): string => canonicalJSON({ ...s, updated: 0, flushSeq: 0 });

export function createAutosave(o: AutosaveDeps): Autosave {
  let marks = 0;
  let paused = false;
  /** Set by a `closed` result: the timer and the triggers post no more. */
  let stopped = false;
  /** Set when the sim is gone or at `dispose`: nothing posts. */
  let gone = false;
  let seq = 0;
  /** The newest failed post's `seq`: "changed" while it is newer than the committed capture. */
  let failedSeq = 0;
  let ticking: Promise<void> | null = null;

  const opened = o.build();
  /** What the last committed flush captured; at the open, the world as opened. */
  let committed: Capture = { seq: 0, edits: o.editsSince(), marks: 0, historyVersion: opened.historyVersion, stateKey: stateKeyOf(opened.state) };

  const timer = o.clock.setInterval(() => { void tick(); }, AUTOSAVE_MS);
  let timerOn = true;
  const stopTimer = (): void => {
    if (timerOn) o.clock.clearInterval(timer);
    timerOn = false;
  };

  const changed = (b: Built): boolean =>
    failedSeq > committed.seq || o.editsSince() !== committed.edits || marks !== committed.marks
    || b.historyVersion !== committed.historyVersion || stateKeyOf(b.state) !== committed.stateKey;

  const post = (b: Built = o.build()): Promise<FlushedMsg | null> => {
    const cap: Capture = { seq: ++seq, edits: o.editsSince(), marks, historyVersion: b.historyVersion, stateKey: stateKeyOf(b.state) };
    const history = b.historyVersion !== committed.historyVersion ? b.history : null;
    return o.flush(b.state, history).then((r) => {
      if (r.ok) {
        if (cap.seq > committed.seq) committed = cap;
      } else {
        failedSeq = Math.max(failedSeq, cap.seq);
        if (r.status === 'closed') {
          stopped = true;
          stopTimer();
        }
      }
      o.onResult(r);
      return r;
    }, (e: unknown) => {
      if (!(e instanceof SimFailed)) throw e;
      gone = true;
      stopTimer();
      return null;
    });
  };

  /** Posts at once when something changed (the hide and close triggers). */
  const postIfChanged = (): void => {
    if (gone || stopped) return;
    const b = o.build();
    if (changed(b)) void post(b);
  };

  /** Resolves when `settled()` does or after `SETTLE_WAIT_MS`, whichever comes first. */
  const settledOrWait = (): Promise<void> => new Promise<void>((resolve) => {
    const id = o.clock.setTimeout(resolve, SETTLE_WAIT_MS);
    const done = (): void => {
      o.clock.clearTimeout(id);
      resolve();
    };
    o.settled().then(done, done);
  });

  const tick = (): Promise<void> => {
    if (paused || gone || stopped) return Promise.resolve();
    ticking ??= settledOrWait().then(() => {
      ticking = null;
      if (paused || gone || stopped) return;
      const b = o.build();
      if (changed(b)) void post(b);
    });
    return ticking;
  };

  const offs = [
    o.events.on('visibilitychange', () => { if (o.events.hidden()) postIfChanged(); }),
    o.events.on('pagehide', postIfChanged),
    o.events.on('beforeunload', postIfChanged),
  ];

  return {
    tick,
    flushNow: () => (gone ? Promise.resolve(null) : post()),
    beforeLeave(ms = LEAVE_WAIT_MS) {
      if (gone) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const id = o.clock.setTimeout(resolve, ms);
        void post().finally(() => {
          o.clock.clearTimeout(id);
          resolve();
        });
      });
    },
    markChanged() { marks++; },
    pause(on) { paused = on; },
    dispose() {
      gone = true;
      stopTimer();
      for (const off of offs) off();
    },
  };
}

/**
 * The autosave (SP5b spec §3.2, D5, D18): its triggers (the 2,000 ms timer, the hide and close events, `flushNow`,
 * `beforeLeave`), what counts as changed since the last committed flush, the history posted only when its version
 * moved, and the state snapshot through the §2.1 normaliser; the state's parts and their versions, built only for a
 * post, and the page's history writes, each step under one id and posted until a committed flush stored it (SP5c
 * spec §5, D28's lever 3). On a fake clock whose timers run in
 * time order, fake page events and a fake `flush` whose replies the test settles by hand.
 */
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { SimFailed } from '../../src/engine/simClient';
import { wholeWrite, type HistoryIds, type HistoryWrite, type HotbarRecord, type Place, type StateRecord } from '../../src/persist/saves';
import type { FlyState } from '../../src/player/fly';
import {
  AUTOSAVE_MS, BULK_SETTLE_WAIT_MS, createAutosave, createStateParts, LEAVE_WAIT_MS, SETTLE_WAIT_MS, snapshotState, type Autosave,
} from '../../src/ui/world/autosave';
import type { BlockStep } from '../../src/ui/world/blockHistory';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { createPageAutosave } from '../../src/ui/world/worldPage';
import type { FlushedMsg } from '../../src/workers/protocol';

/** Lets every pending promise continuation run. */
const drain = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** A fake clock with timeouts and intervals, run in time order by `runTo`, draining the promises after each. */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const add = (fn: () => void, ms: number, every: number | null): number => {
    const id = nextId++;
    timers.set(id, { at: t + ms, fn, every });
    return id;
  };
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number): number => add(fn, ms, null),
    clearTimeout(id: number): void { timers.delete(id); },
    setInterval: (fn: () => void, ms: number): number => add(fn, ms, ms),
    clearInterval(id: number): void { timers.delete(id); },
    /** The intervals still armed. */
    intervals: (): number => [...timers.values()].filter((e) => e.every !== null).length,
    /** Moves the time to `to`, running every timer due on the way. */
    async runTo(to: number): Promise<void> {
      await drain();
      for (;;) {
        let best: [number, { at: number; fn: () => void; every: number | null }] | null = null;
        for (const e of timers) if (e[1].at <= to && (best === null || e[1].at < best[1].at)) best = e;
        if (best === null) break;
        const [id, e] = best;
        t = e.at;
        if (e.every === null) timers.delete(id);
        else e.at += e.every;
        e.fn();
        await drain();
      }
      t = to;
    },
  };
}

interface Post {
  readonly at: number;
  readonly state: StateRecord;
  readonly history: HistoryWrite | null;
  resolve(r: FlushedMsg): void;
  reject(e: Error): void;
}

const HOTBAR: HotbarRecord = STATE_BOUNDS.normalizeHotbar(null);

/** No places (the parts compare the places by identity). */
const NO_PLACES: readonly Place[] = [];

/** A saved world's page as the autosave sees it: a pose, an edit count, a block history and its version. */
function rig() {
  const clock = fakeClock();
  const handlers = new Map<string, Set<() => void>>();
  const posts: Post[] = [];
  const results: FlushedMsg[] = [];
  const page = {
    hidden: false,
    edits: 0,
    historyVersion: 0,
    steps: 0,
    x: 10.5,
    /** What `settled()` returns; resolved by default. */
    settled: (): Promise<void> => Promise.resolve(),
    /** What `bulkPending()` returns: whether a bulk batch is posted and not answered (SP5c spec §2.8). */
    bulk: false,
  };
  const history = (): HistoryWrite => wholeWrite({
    worldId: 'w1',
    done: Array.from({ length: page.steps }, (_, i) => ({ edits: [{ x: i, y: 64, z: 0, before: 0xFFFFFFFF, after: 1 << 8 }] })),
    undone: [],
  });
  const parts = createStateParts({
    worldId: 'w1',
    fly: { get x() { return page.x; }, y: 80, z: -3, yaw: 90, pitch: 10, mode: 'fly', speed: 12 },
    t: () => 0.25, speedIndex: () => 0, hotbar: () => HOTBAR, places: () => NO_PLACES, now: () => 1_000_000 + clock.now(),
  });
  /** The state records and the history records the autosave asked for. */
  const built = { states: 0, histories: 0 };
  const autosave: Autosave = createAutosave({
    clock,
    events: {
      on(type, f) {
        const set = handlers.get(type) ?? new Set();
        handlers.set(type, set);
        set.add(f);
        return () => set.delete(f);
      },
      hidden: () => page.hidden,
    },
    flush: (state, h) => new Promise<FlushedMsg>((resolve, reject) => {
      posts.push({ at: clock.now(), state, history: h, resolve, reject });
    }),
    state: {
      version: () => parts.version(),
      record() {
        built.states++;
        return parts.record();
      },
    },
    historyVersion: () => page.historyVersion,
    history() {
      built.histories++;
      return history();
    },
    settled: () => page.settled(),
    bulkPending: () => page.bulk,
    editsSince: () => page.edits,
    onResult: (r) => results.push(r),
  });
  let flushSeq = 0;
  return {
    clock, posts, results, page, autosave, built,
    /** Fires a page event. */
    fire(type: 'visibilitychange' | 'pagehide' | 'beforeunload'): void {
      for (const f of handlers.get(type) ?? []) f();
    },
    /** Settles post `i` as committed. */
    ok(i: number): void {
      posts[i]!.resolve({ type: 'flushed', id: i, ok: true, flushSeq: ++flushSeq, columns: 0, bytes: 0, syncMs: 0, commitMs: 0 });
    },
    /** Settles post `i` as a failed write (a full disk unless `status` says the connection was closed). */
    fail(i: number, status: 'abort' | 'closed' = 'abort'): void {
      posts[i]!.resolve({ type: 'flushed', id: i, ok: false, status, errorName: status === 'abort' ? 'QuotaExceededError' : null });
    },
  };
}

describe('autosave (SP5b spec §3.2)', () => {
  test('the waits are the spec\'s', () => {
    expect([AUTOSAVE_MS, SETTLE_WAIT_MS, LEAVE_WAIT_MS]).toEqual([2000, 1000, 1000]);
  });

  test('nothing changed → the 2,000 ms tick posts nothing', async () => {
    const r = rig();
    await r.clock.runTo(6000);
    expect(r.posts).toHaveLength(0);
    r.autosave.dispose();
  });

  test('an unchanged tick builds nothing', async () => {
    const r = rig();
    await r.clock.runTo(6000);
    expect([r.posts.length, r.built.states, r.built.histories]).toEqual([0, 0, 0]);
    // An edit reply alone: the tick builds the state (its parts unmoved: the last record, `updated` now), no history.
    r.page.edits = 1;
    await r.clock.runTo(8000);
    expect([r.posts.length, r.built.states, r.built.histories]).toEqual([1, 1, 0]);
    expect(r.posts[0]!.state.updated).toBe(1_008_000);
    expect(r.posts[0]!.history).toBeNull();
    r.ok(0);
    await r.clock.runTo(12000);
    expect([r.posts.length, r.built.states, r.built.histories]).toEqual([1, 1, 0]);
    r.autosave.dispose();
  });

  test('an edit reply → the next tick posts once', async () => {
    const r = rig();
    await r.clock.runTo(1000);
    r.page.edits = 1;
    await r.clock.runTo(2000);
    expect(r.posts.map((p) => p.at)).toEqual([2000]);
    r.ok(0);
    await r.clock.runTo(8000);
    expect(r.posts).toHaveLength(1);
    expect(r.results.map((m) => m.ok)).toEqual([true]);
    r.autosave.dispose();
  });

  test('the tick waits for `settled()`: a settle at 300 ms posts at 300 ms with the step\'s history; a settle that never comes posts at 1,000 ms', async () => {
    const r = rig();
    // An edit is out at the tick; its reply and its step arrive 300 ms later.
    r.page.settled = () => new Promise<void>((resolve) => {
      r.clock.setTimeout(() => {
        r.page.edits = 1;
        r.page.steps = 1;
        r.page.historyVersion = 1;
        resolve();
      }, 300);
    });
    await r.clock.runTo(2000);
    expect(r.posts).toHaveLength(0);
    await r.clock.runTo(2300);
    expect(r.posts.map((p) => p.at)).toEqual([2300]);
    expect(r.posts[0]!.history?.done).toHaveLength(1);
    r.ok(0);

    // A settle that never comes: the tick posts what it has at 1,000 ms.
    r.page.settled = () => new Promise<void>(() => {});
    r.page.x = 11.5;
    await r.clock.runTo(4000);
    expect(r.posts).toHaveLength(1);
    await r.clock.runTo(4999);
    expect(r.posts).toHaveLength(1);
    await r.clock.runTo(5000);
    expect(r.posts.map((p) => p.at)).toEqual([2300, 5000]);
    expect(r.posts[1]!.state.player?.x).toBe(11.5);
    r.autosave.dispose();
  });

  test('hidden, `pagehide` and `beforeunload` post at once, without waiting', async () => {
    const r = rig();
    r.page.settled = () => new Promise<void>(() => {});
    await r.clock.runTo(500);
    r.page.x = 11;
    r.fire('visibilitychange'); // still visible: nothing
    expect(r.posts).toHaveLength(0);
    r.page.hidden = true;
    r.fire('visibilitychange');
    expect(r.posts.map((p) => p.at)).toEqual([500]);
    r.ok(0);
    await r.clock.runTo(600);
    r.page.x = 12;
    r.fire('pagehide');
    expect(r.posts.map((p) => p.at)).toEqual([500, 600]);
    r.ok(1);
    await r.clock.runTo(700);
    r.page.edits = 1;
    r.fire('beforeunload');
    expect(r.posts.map((p) => p.at)).toEqual([500, 600, 700]);
    expect(r.posts.map((p) => p.state.player?.x)).toEqual([11, 12, 12]);
    r.autosave.dispose();
  });

  test('a failed flush: the next tick posts with nothing new, and so does `pagehide`', async () => {
    const r = rig();
    r.page.edits = 1;
    await r.clock.runTo(2000);
    expect(r.posts).toHaveLength(1);
    r.fail(0);
    await r.clock.runTo(4000);
    expect(r.posts.map((p) => p.at)).toEqual([2000, 4000]);
    r.fail(1);
    await r.clock.runTo(4100);
    r.fire('pagehide');
    expect(r.posts.map((p) => p.at)).toEqual([2000, 4000, 4100]);
    expect(r.results.map((m) => m.ok)).toEqual([false, false]);
    // Committed at last: nothing more to post.
    r.ok(2);
    await r.clock.runTo(8000);
    expect(r.posts).toHaveLength(3);
    r.autosave.dispose();
  });

  test('the history is posted only when its version changed since the last committed flush', async () => {
    const r = rig();
    r.page.edits = 1;
    r.page.steps = 1;
    r.page.historyVersion = 1;
    await r.clock.runTo(2000);
    expect(r.posts[0]!.history?.done).toHaveLength(1);
    r.ok(0);
    r.page.x = 11; // the pose alone moved
    await r.clock.runTo(4000);
    expect(r.posts[1]!.history).toBeNull();
    r.ok(1);
    r.page.steps = 2;
    r.page.historyVersion = 2;
    await r.clock.runTo(6000);
    expect(r.posts[2]!.history?.done).toHaveLength(2);
    r.fail(2);
    // Not committed: the next tick posts it again.
    await r.clock.runTo(8000);
    expect(r.posts[3]!.history?.done).toHaveLength(2);
    r.ok(3);
    r.page.x = 12;
    await r.clock.runTo(10000);
    expect(r.posts[4]!.history).toBeNull();
    r.autosave.dispose();
  });

  test('`beforeLeave(1000)` resolves at `flushed` (200 ms) with it, or at 1,000 ms with null when none comes', async () => {
    const r = rig();
    await r.clock.runTo(100);
    let leftAt = -1;
    let result: unknown;
    void r.autosave.beforeLeave(1000).then((m) => { leftAt = r.clock.now(); result = m; });
    expect(r.posts.map((p) => p.at)).toEqual([100]);
    r.clock.setTimeout(() => r.ok(0), 200);
    await r.clock.runTo(1500);
    expect(leftAt).toBe(300);
    expect(result).toMatchObject({ type: 'flushed', ok: true });

    let leftAgain = -1;
    void r.autosave.beforeLeave(1000).then((m) => { leftAgain = r.clock.now(); result = m; });
    expect(r.posts.map((p) => p.at)).toEqual([100, 1500]);
    await r.clock.runTo(2499);
    expect(leftAgain).toBe(-1);
    await r.clock.runTo(3000);
    expect(leftAgain).toBe(2500);
    expect(result).toBeNull();

    // A flush that comes back not saved: its `flushed`, which the page's leave asks about (final review MENU-1).
    void r.autosave.beforeLeave(1000).then((m) => { result = m; });
    r.clock.setTimeout(() => r.fail(2), 100);
    await r.clock.runTo(3500);
    expect(result).toMatchObject({ type: 'flushed', ok: false });
    r.autosave.dispose();
  });

  test('paused: the tick posts nothing, `flushNow` posts', async () => {
    const r = rig();
    r.autosave.pause(true);
    r.page.edits = 1;
    await r.clock.runTo(4000);
    await r.autosave.tick();
    expect(r.posts).toHaveLength(0);
    const now = r.autosave.flushNow();
    expect(r.posts.map((p) => p.at)).toEqual([4000]);
    r.ok(0);
    expect((await now)?.ok).toBe(true);
    r.autosave.pause(false);
    r.page.edits = 2;
    await r.clock.runTo(6000);
    expect(r.posts.map((p) => p.at)).toEqual([4000, 6000]);
    r.autosave.dispose();
  });

  test('`markChanged()` between a flush\'s post and its `flushed` → the next tick posts', async () => {
    const r = rig();
    r.page.edits = 1;
    await r.clock.runTo(2000);
    expect(r.posts).toHaveLength(1);
    await r.clock.runTo(2100);
    r.autosave.markChanged();
    await r.clock.runTo(2200);
    r.ok(0);
    await r.clock.runTo(4000);
    expect(r.posts.map((p) => p.at)).toEqual([2000, 4000]);
    r.ok(1);
    await r.clock.runTo(8000);
    expect(r.posts).toHaveLength(2);
    r.autosave.dispose();
  });

  test('an edit reply between a flush\'s post and its `flushed` → the next tick posts', async () => {
    const r = rig();
    r.page.edits = 1;
    await r.clock.runTo(2000);
    expect(r.posts).toHaveLength(1);
    await r.clock.runTo(2100);
    r.page.edits = 2;
    await r.clock.runTo(2200);
    r.ok(0);
    await r.clock.runTo(4000);
    expect(r.posts.map((p) => p.at)).toEqual([2000, 4000]);
    r.ok(1);
    await r.clock.runTo(8000);
    expect(r.posts).toHaveLength(2);
    r.autosave.dispose();
  });

  test('a `flush` rejecting `SimFailed` → `flushNow` resolves null, no storage notice, the timer stops', async () => {
    const r = rig();
    const now = r.autosave.flushNow();
    r.posts[0]!.reject(new SimFailed('the sim failed: test'));
    expect(await now).toBeNull();
    expect(r.results).toHaveLength(0);
    expect(r.clock.intervals()).toBe(0);
    r.page.edits = 1;
    await r.clock.runTo(10000);
    r.fire('pagehide');
    expect(await r.autosave.flushNow()).toBeNull();
    expect(r.posts).toHaveLength(1);
    r.autosave.dispose();
  });

  test('a `closed` result stops the timer and the hide triggers; `flushNow` still posts', async () => {
    const r = rig();
    r.page.edits = 1;
    await r.clock.runTo(2000);
    r.fail(0, 'closed');
    await r.clock.runTo(2001);
    expect(r.results.map((m) => (m.ok ? 'ok' : m.status))).toEqual(['closed']);
    expect(r.clock.intervals()).toBe(0);
    r.page.edits = 2;
    await r.clock.runTo(10000);
    r.fire('pagehide');
    expect(r.posts).toHaveLength(1);
    void r.autosave.flushNow();
    expect(r.posts).toHaveLength(2);
    r.autosave.dispose();
  });

  test('`dispose` stops the timer and unsubscribes the events', async () => {
    const r = rig();
    r.autosave.dispose();
    expect(r.clock.intervals()).toBe(0);
    r.page.edits = 1;
    await r.clock.runTo(10000);
    r.fire('pagehide');
    expect(r.posts).toHaveLength(0);
  });
});

describe('the autosave\'s and the leave\'s wait for a bulk batch (SP5c spec §2.8, D23)', () => {
  /**
   * A bulk batch posted at 0 whose reply comes at `at` ms (never when null): `bulkPending()` true until then, and
   * `settled()` resolving at the reply with the batch's edit counted and its step recorded (the history's version moved).
   */
  const bulkAt = (r: ReturnType<typeof rig>, at: number | null): void => {
    r.page.bulk = true;
    const reply = at === null ? new Promise<void>(() => {}) : new Promise<void>((resolve) => {
      r.clock.setTimeout(() => {
        r.page.bulk = false;
        r.page.edits++;
        r.page.steps++;
        r.page.historyVersion++;
        resolve();
      }, at - r.clock.now());
    });
    r.page.settled = () => reply;
  };

  test('the bulk wait is the spec\'s', () => {
    expect(BULK_SETTLE_WAIT_MS).toBe(5000);
  });

  test('with a bulk batch pending whose reply comes at 1,500 ms, the tick posts at 1,500 ms, after the reply, with the history holding the step', async () => {
    const r = rig();
    bulkAt(r, 1500);
    void r.autosave.tick();
    await r.clock.runTo(1000);
    expect(r.posts).toHaveLength(0);
    await r.clock.runTo(1499);
    expect(r.posts).toHaveLength(0);
    await r.clock.runTo(1500);
    expect(r.posts.map((p) => p.at)).toEqual([1500]);
    expect(r.posts[0]!.history?.done).toHaveLength(1);
    r.ok(0);
    await r.clock.runTo(6000);
    expect(r.posts).toHaveLength(1);
    r.autosave.dispose();
  });

  test('a bulk reply that never comes: the tick posts at 5,000 ms', async () => {
    const r = rig();
    bulkAt(r, null);
    r.page.x = 11.5;
    void r.autosave.tick();
    await r.clock.runTo(4999);
    expect(r.posts).toHaveLength(0);
    await r.clock.runTo(5000);
    expect(r.posts.map((p) => p.at)).toEqual([5000]);
    expect(r.posts[0]!.state.player?.x).toBe(11.5);
    expect(r.posts[0]!.history).toBeNull();
    r.autosave.dispose();
  });

  test('with no bulk batch pending the tick still waits at most 1,000 ms', async () => {
    const r = rig();
    r.page.settled = () => new Promise<void>(() => {});
    r.page.x = 11.5;
    void r.autosave.tick();
    await r.clock.runTo(999);
    expect(r.posts).toHaveLength(0);
    await r.clock.runTo(1000);
    expect(r.posts.map((p) => p.at)).toEqual([1000]);
    r.autosave.dispose();
  });

  test('`beforeLeave` with a bulk post replied at 1,500 ms posts its flush after the reply (the flush\'s history holds the step) and resolves at `flushed`, or 1,000 ms after its post with null', async () => {
    const r = rig();
    // The timer's own ticks stay out of it: only the leave posts.
    r.autosave.pause(true);
    bulkAt(r, 1500);
    let leftAt = -1;
    let result: unknown;
    void r.autosave.beforeLeave(LEAVE_WAIT_MS).then((m) => { leftAt = r.clock.now(); result = m; });
    await r.clock.runTo(1499);
    expect(r.posts).toHaveLength(0);
    await r.clock.runTo(1500);
    expect(r.posts.map((p) => p.at)).toEqual([1500]);
    expect(r.posts[0]!.history?.done).toHaveLength(1);
    r.clock.setTimeout(() => r.ok(0), 200);
    await r.clock.runTo(3000);
    expect(leftAt).toBe(1700);
    expect(result).toMatchObject({ type: 'flushed', ok: true });

    // A second bulk batch, replied 1,500 ms after the leave starts; its flush is never answered: null 1,000 ms after the post.
    bulkAt(r, 4500);
    let leftAgain = -1;
    void r.autosave.beforeLeave(LEAVE_WAIT_MS).then((m) => { leftAgain = r.clock.now(); result = m; });
    await r.clock.runTo(4499);
    expect(r.posts).toHaveLength(1);
    await r.clock.runTo(4500);
    expect(r.posts.map((p) => p.at)).toEqual([1500, 4500]);
    expect(r.posts[1]!.history?.done).toHaveLength(2);
    await r.clock.runTo(5499);
    expect(leftAgain).toBe(-1);
    await r.clock.runTo(6000);
    expect(leftAgain).toBe(5500);
    expect(result).toBeNull();
    r.autosave.dispose();
  });

  test('with no bulk batch pending `beforeLeave` posts at once, as today', async () => {
    const r = rig();
    // An edit still out (not bulk): its settle never comes, and the leave does not wait for it.
    r.page.settled = () => new Promise<void>(() => {});
    await r.clock.runTo(100);
    let leftAt = -1;
    void r.autosave.beforeLeave(LEAVE_WAIT_MS).then(() => { leftAt = r.clock.now(); });
    expect(r.posts.map((p) => p.at)).toEqual([100]);
    await r.clock.runTo(1099);
    expect(leftAt).toBe(-1);
    await r.clock.runTo(1100);
    expect(leftAt).toBe(1100);
    r.autosave.dispose();
  });
});

describe('snapshotState (SP5b spec §2.1)', () => {
  const base = {
    worldId: 'w1', fly: { x: 10.5, y: 80, z: -3, yaw: 90, pitch: 10, mode: 'walk' as const, speed: 12 },
    time: { t: 0.25, speedIndex: 2 }, hotbar: HOTBAR, places: [], updated: 1_700_000_000_000,
  };

  test('`snapshotState` maps `pitch: -0` to 0 and passes `canonicalJSON`; a `NaN` x gives `player: null`', () => {
    const s = snapshotState({ ...base, fly: { ...base.fly, pitch: -0 } });
    expect(Object.is(s.player?.pitch, 0)).toBe(true);
    expect(() => canonicalJSON(s)).not.toThrow();
    expect(s).toEqual({
      worldId: 'w1', flushSeq: 0, updated: 1_700_000_000_000,
      player: { x: 10.5, y: 80, z: -3, yaw: 90, pitch: 0, mode: 'walk', speed: 12 },
      time: { t: 0.25, speedIndex: 2 }, hotbar: HOTBAR, places: [],
    });
    const nan = snapshotState({ ...base, fly: { ...base.fly, x: Number.NaN } });
    expect(nan.player).toBeNull();
    expect(() => canonicalJSON(nan)).not.toThrow();
  });

  test('a hotbar with `active` 4 and slot 0 `\'bricks\'` survives `snapshotState` unchanged', () => {
    const hotbar = STATE_BOUNDS.normalizeHotbar({ v: 1, active: 4, slots: [{ type: 'bricks' }] });
    expect(hotbar.active).toBe(4);
    expect(hotbar.slots[0]).toEqual({ type: 'bricks', pinned: {} });
    const s = snapshotState({ ...base, hotbar });
    expect(s.hotbar).toEqual(hotbar);
    expect(canonicalJSON(s.hotbar)).toBe(canonicalJSON(hotbar));
  });
});

describe('createStateParts (SP5b spec §3.2, D28\'s third lever)', () => {
  /** Mutable sources and the parts over them. */
  const over = () => {
    const s = {
      fly: { x: 10.5, y: 80, z: -3, yaw: 90, pitch: 10, mode: 'walk' as FlyState['mode'], speed: 12 },
      t: 0.25, speedIndex: 2, hotbar: HOTBAR, places: NO_PLACES, now: 1_700_000_000_000,
    };
    const parts = createStateParts({
      worldId: 'w1', fly: s.fly, t: () => s.t, speedIndex: () => s.speedIndex, hotbar: () => s.hotbar, places: () => s.places, now: () => s.now,
    });
    const snapshot = (): StateRecord => snapshotState({
      worldId: 'w1', fly: s.fly, time: { t: s.t, speedIndex: s.speedIndex }, hotbar: s.hotbar, places: s.places, updated: s.now,
    });
    return { s, parts, snapshot };
  };

  test('the version moves with each part (the pose\'s seven fields, the time\'s two, the hotbar and the places by identity), and with nothing else', () => {
    const { s, parts } = over();
    let v = parts.version();
    const moves = (change: () => void): void => {
      change();
      const next = parts.version();
      expect(next).toBeGreaterThan(v);
      expect(parts.version()).toBe(next);
      v = next;
    };
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'speed'] as const) moves(() => { s.fly[k] += 1; });
    moves(() => { s.fly.mode = 'fly'; });
    moves(() => { s.t = 0.5; });
    moves(() => { s.speedIndex = 3; });
    moves(() => { s.hotbar = STATE_BOUNDS.normalizeHotbar(null); });
    moves(() => { s.places = [{ id: 'p', name: 'Home', colour: 0, x: 1, y: 70, z: 2, yaw: 0, pitch: 0 }]; });
    moves(() => { s.fly.x = Number.NaN; });
    // A NaN that stays NaN, and the wall clock, move nothing.
    s.now += 2000;
    expect(parts.version()).toBe(v);
  });

  test('`record()` is `snapshotState` of the sources, rebuilt only when the version moved; else the last record with `updated` now', () => {
    const { s, parts, snapshot } = over();
    s.fly.pitch = -0;
    const a = parts.record();
    expect(a).toEqual(snapshot());
    expect(Object.is(a.player?.pitch, 0)).toBe(true);
    s.now += 2000;
    const b = parts.record();
    expect(b).toEqual(snapshot());
    expect(canonicalJSON(b)).toBe(canonicalJSON(snapshot()));
    expect([b.player, b.time, b.hotbar, b.places]).toEqual([a.player, a.time, a.hotbar, a.places]);
    expect(b.player).toBe(a.player);
    expect(b.updated).toBe(a.updated + 2000);
    s.t = 0.5;
    const c = parts.record();
    expect(c).toEqual(snapshot());
    expect(c.player).not.toBe(b.player);
    expect(c.time.t).toBe(0.5);
  });
});

describe('the page\'s autosave (`createPageAutosave`): the history step by step (SP5c spec §5, D28\'s lever 3)', () => {
  const step = (x: number, n = 1): BlockStep => ({ edits: Array.from({ length: n }, (_, i) => ({ x, y: 64 + i, z: 0, before: 0xFFFFFFFF, after: 1 << 8 })) });
  const ok = (id: number): FlushedMsg => ({ type: 'flushed', id, ok: true, flushSeq: id, columns: 0, bytes: 0, syncMs: 0, commitMs: 0 });
  const failed = (id: number): FlushedMsg => ({ type: 'flushed', id, ok: false, status: 'abort', errorName: 'QuotaExceededError' });
  /** A page autosave over a block history the test moves by hand; `replies` answers each flush in turn (ok by default). */
  const pageRig = (o: { historyIds?: HistoryIds | null; replies?: Array<(id: number) => FlushedMsg> } = {}) => {
    const sides = { done: [] as BlockStep[], undone: [] as BlockStep[] };
    let version = 0;
    const posted: Array<HistoryWrite | null> = [];
    const a = createPageAutosave({
      worldId: 'w1', fly: { x: 1, y: 80, z: 2, yaw: 0, pitch: 0, mode: 'fly', speed: 12 }, frame: { t: 0.25 }, speedIndex: () => 0,
      storedTime: null, hotbar: () => HOTBAR,
      blockHistory: { snapshot: () => ({ done: sides.done.slice(), undone: sides.undone.slice() }), get version() { return version; } },
      historyIds: o.historyIds,
      sim: {
        flush(_state, h) {
          posted.push(h);
          return Promise.resolve((o.replies?.[posted.length - 1] ?? ok)(posted.length));
        },
      },
      settled: () => Promise.resolve(), editsSince: () => 0, now: () => 1_700_000_000_000, clock: fakeClock(),
      events: { on: () => () => {}, hidden: () => false }, onResult() {},
    });
    return { a, sides, posted, moved: () => { version++; } };
  };

  test('a flush carries only the steps no committed flush stored: a new step once, an undo and a redo as ids only', async () => {
    const r = pageRig();
    const s1 = step(1, 3);
    const s2 = step(2);
    r.sides.done.push(s1, s2);
    r.moved();
    await r.a.flushNow();
    const s3 = step(3);
    r.sides.done.push(s3);
    r.moved();
    await r.a.flushNow();
    // Undo s3, then redo it: it moves between the sides and keeps its id.
    r.sides.undone.push(r.sides.done.pop()!);
    r.moved();
    await r.a.flushNow();
    r.sides.done.push(r.sides.undone.pop()!);
    r.moved();
    await r.a.flushNow();
    const [h1, h2, h3, h4] = r.posted as [HistoryWrite, HistoryWrite, HistoryWrite, HistoryWrite];
    expect(h1).toEqual({ worldId: 'w1', done: [0, 1], undone: [], steps: [{ id: 0, edits: s1.edits }, { id: 1, edits: s2.edits }] });
    expect(h2).toEqual({ worldId: 'w1', done: [0, 1, 2], undone: [], steps: [{ id: 2, edits: s3.edits }] });
    expect(h3).toEqual({ worldId: 'w1', done: [0, 1], undone: [2], steps: [] });
    expect(h4).toEqual({ worldId: 'w1', done: [0, 1, 2], undone: [], steps: [] });
    r.a.dispose();
  });

  test('a flush that did not commit leaves its steps unstored: the next one carries them again', async () => {
    const r = pageRig({ replies: [failed] });
    const s1 = step(1);
    r.sides.done.push(s1);
    r.moved();
    expect(await r.a.flushNow()).toMatchObject({ ok: false });
    expect(await r.a.flushNow()).toMatchObject({ ok: true });
    expect(r.posted.map((h) => h?.steps.map((s) => s.id))).toEqual([[0], [0]]);
    r.a.dispose();
  });

  test('seeded with the open\'s ids, the first flush after the open posts no stored step, only the new one; `build` carries every step (the backup)', async () => {
    const restored = [step(1, 32), step(2, 32)];
    const historyIds: HistoryIds = { of: new Map([[restored[0]!, 7], [restored[1]!, 9]]), stored: new Set([7, 9]), next: 10 };
    const r = pageRig({ historyIds });
    r.sides.done.push(...restored);
    const s3 = step(3);
    r.sides.done.push(s3);
    r.moved();
    await r.a.flushNow();
    expect(r.posted[0]).toEqual({ worldId: 'w1', done: [7, 9, 10], undone: [], steps: [{ id: 10, edits: s3.edits }] });
    const built = r.a.build().history;
    expect(built.done).toEqual([7, 9, 10]);
    expect(built.steps.map((s) => s.id)).toEqual([7, 9, 10]);
    expect(built.steps[0]!.edits).toEqual(restored[0]!.edits);
    r.a.dispose();
  });
});

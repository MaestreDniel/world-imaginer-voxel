/**
 * The autosave (SP5b spec §3.2, D5, D18): its triggers (the 2,000 ms timer, the hide and close events, `flushNow`,
 * `beforeLeave`), what counts as changed since the last committed flush, the history posted only when its version
 * moved, and the state snapshot through the §2.1 normaliser. On a fake clock whose timers run in time order, fake page
 * events and a fake `flush` whose replies the test settles by hand.
 */
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { SimFailed } from '../../src/engine/simClient';
import type { HistoryRecord, HotbarRecord, StateRecord } from '../../src/persist/saves';
import { AUTOSAVE_MS, createAutosave, LEAVE_WAIT_MS, SETTLE_WAIT_MS, snapshotState, type Autosave } from '../../src/ui/world/autosave';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
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
  readonly history: HistoryRecord | null;
  resolve(r: FlushedMsg): void;
  reject(e: Error): void;
}

const HOTBAR: HotbarRecord = STATE_BOUNDS.normalizeHotbar(null);

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
  };
  const history = (): HistoryRecord => ({
    worldId: 'w1',
    done: Array.from({ length: page.steps }, (_, i) => ({ edits: [{ x: i, y: 64, z: 0, before: 0xFFFFFFFF, after: 1 << 8 }] })),
    undone: [],
  });
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
    build: () => ({
      state: snapshotState({
        worldId: 'w1', fly: { x: page.x, y: 80, z: -3, yaw: 90, pitch: 10, mode: 'fly', speed: 12 },
        time: { t: 0.25, speedIndex: 0 }, hotbar: HOTBAR, places: [], updated: 1_000_000 + clock.now(),
      }),
      history: history(),
      historyVersion: page.historyVersion,
    }),
    settled: () => page.settled(),
    editsSince: () => page.edits,
    onResult: (r) => results.push(r),
  });
  let flushSeq = 0;
  return {
    clock, posts, results, page, autosave,
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

  test('`beforeLeave(1000)` resolves at `flushed` (200 ms), or at 1,000 ms when none comes', async () => {
    const r = rig();
    await r.clock.runTo(100);
    let leftAt = -1;
    void r.autosave.beforeLeave(1000).then(() => { leftAt = r.clock.now(); });
    expect(r.posts.map((p) => p.at)).toEqual([100]);
    r.clock.setTimeout(() => r.ok(0), 200);
    await r.clock.runTo(1500);
    expect(leftAt).toBe(300);

    let leftAgain = -1;
    void r.autosave.beforeLeave(1000).then(() => { leftAgain = r.clock.now(); });
    expect(r.posts.map((p) => p.at)).toEqual([100, 1500]);
    await r.clock.runTo(2499);
    expect(leftAgain).toBe(-1);
    await r.clock.runTo(3000);
    expect(leftAgain).toBe(2500);
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

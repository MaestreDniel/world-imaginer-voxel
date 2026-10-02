import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { JobCancelled, type WorkerPool } from '../../src/engine/workerPool';
import type { Spawn } from '../../src/gen/column/spawn';
import {
  createPreviewDriver, type DriverCanvas, type DriverClock, type DriverDraft, type DriverPool, type DriverStatus, type PreviewDriver,
} from '../../src/ui/map/previewDriver';

const PARAMS: Params = resolveProfile('default');
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Timers fire in time order (ties in creation order); each one's promise continuations settle before the next. */
class FakeClock implements DriverClock {
  t = 0;
  private seq = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let id = -1;
      let at = Infinity;
      for (const [k, v] of this.timers) if (v.at <= end && v.at < at) { id = k; at = v.at; }
      if (id < 0) break;
      const fn = this.timers.get(id)!.fn;
      this.timers.delete(id);
      this.t = at;
      fn();
      await flush();
    }
    this.t = end;
  }
}

interface FakeConfigure {
  readonly epoch: number;
  readonly seedText: string;
  state: 'pending' | 'resolved' | 'rejected';
  resolve(): void;
  reject(e: Error): void;
}

const spawnOf = (epoch: number): Spawn => ({ x: epoch, z: 0, y: 64, biome: 1, fallback: false });

/**
 * Pool epochs start at −1 and skip by 3, so they never equal the session epochs the tests use (0, 1, 2, …).
 * Like the real pool, a new configure rejects the pending one with JobCancelled.
 */
class FakePool implements DriverPool {
  readonly size: number;
  readonly configures: FakeConfigure[] = [];
  /** The pool epoch of every spawn request. */
  readonly spawns: number[] = [];
  onConfigure: ((c: FakeConfigure) => void) | null = null;
  private next = -1;
  constructor(size: number) { this.size = size; }
  configure(seedText: string, _params: Params): Promise<{ readonly epoch: number; readonly stageHashes: Readonly<Record<string, string>> }> {
    for (const c of this.configures) c.reject(new JobCancelled());
    const epoch = this.next;
    this.next += 3;
    return new Promise((resolve, reject) => {
      const c: FakeConfigure = {
        epoch, seedText, state: 'pending',
        resolve: () => { if (c.state === 'pending') { c.state = 'resolved'; resolve({ epoch, stageHashes: { climate: `h${epoch}` } }); } },
        reject: (e) => { if (c.state === 'pending') { c.state = 'rejected'; reject(e); } },
      };
      this.configures.push(c);
      this.onConfigure?.(c);
    });
  }
  spawn(): Promise<Spawn> {
    const epoch = this.configures.at(-1)!.epoch;
    this.spawns.push(epoch);
    return Promise.resolve(spawnOf(epoch));
  }
  /** Resolves the newest configure (if pending) and lets the driver react. */
  async ready(): Promise<void> {
    this.configures.at(-1)?.resolve();
    await flush();
  }
}

class FakeCanvas implements DriverCanvas {
  readonly sources: Array<{ readonly epoch: number; readonly seedKey: string }> = [];
  readonly interactiveCalls: boolean[] = [];
  readonly spawns: Array<Spawn | null> = [];
  interactive = false;
  onSource: ((epoch: number) => void) | null = null;
  get source(): number {
    const s = this.sources.at(-1);
    if (s === undefined) throw new Error('no source yet');
    return s.epoch;
  }
  setSource(epoch: number, seedKey: string): void { this.sources.push({ epoch, seedKey }); this.onSource?.(epoch); }
  setInteractive(on: boolean): void { this.interactiveCalls.push(on); this.interactive = on; }
  setSpawn(s: Spawn | null): void { this.spawns.push(s); }
}

interface Rig {
  readonly clock: FakeClock;
  readonly pool: FakePool;
  readonly canvas: FakeCanvas;
  readonly driver: PreviewDriver;
  readonly settled: number[];
  readonly statuses: DriverStatus[];
}

const rig = (size = 6): Rig => {
  const clock = new FakeClock();
  const pool = new FakePool(size);
  const canvas = new FakeCanvas();
  const driver = createPreviewDriver(pool, canvas, clock);
  const settled: number[] = [];
  driver.onSettled((e) => settled.push(e));
  const statuses: DriverStatus[] = [];
  driver.onStatus((s) => statuses.push(s));
  return { clock, pool, canvas, driver, settled, statuses };
};

/** Configure resolves 2 ms after it is posted; the canvas draws the current source's preview `previewMs` later. */
const autoRig = (previewMs: number, visible = 4): Rig & { readonly landed: Array<{ readonly epoch: number; readonly at: number }> } => {
  const r = rig();
  const landed: Array<{ epoch: number; at: number }> = [];
  r.pool.onConfigure = (c) => { r.clock.setTimeout(() => c.resolve(), 2); };
  r.canvas.onSource = (epoch) => {
    r.clock.setTimeout(() => {
      if (r.canvas.source !== epoch) return;
      landed.push({ epoch, at: r.clock.now() });
      r.driver.previewProgress(epoch, visible, visible);
    }, previewMs);
  };
  return { ...r, landed };
};

/** The draft of session epoch e; its seed text carries e, so the pool's log shows which draft it got. */
const draft = (e: number): DriverDraft => ({ sessionEpoch: e, seedText: `s${e}`, seedKey: `${e}.0`, params: PARAMS });
const URGENT = { urgent: true, gesture: false, kind: 'set' } as const;
const BEGIN = { urgent: false, gesture: true, kind: 'gestureBegin' } as const;
const DRAG = { urgent: false, gesture: true, kind: 'set' } as const;
const END = { urgent: true, gesture: false, kind: 'gestureEnd' } as const;

const edit = (r: Rig, e: number, ch: { readonly urgent: boolean; readonly gesture: boolean; readonly kind: string }) =>
  r.driver.change(draft(e), ch, r.clock.now());
/** The canvas reports every visible preview position drawn for its current source. */
const land = (r: Rig, visible = 4) => r.driver.previewProgress(r.canvas.source, visible, visible);
const configured = (r: Rig) => r.pool.configures.map((c) => c.seedText);

describe('preview driver (SP2b spec §2.6, §2.7)', () => {
  test('the canvas gets pool epochs, never session epochs; progress of another epoch is ignored', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    expect(configured(r)).toEqual(['s0']);
    await r.pool.ready();
    expect(r.canvas.sources).toEqual([{ epoch: -1, seedKey: '0.0' }]);
    r.driver.previewProgress(0, 4, 4);
    expect(r.driver.status.pending).toBe(true);
    land(r);
    expect(r.driver.status).toMatchObject({ pending: false, settled: true, poolEpoch: -1 });
    edit(r, 1, URGENT);
    await r.pool.ready();
    expect(r.canvas.sources.map((s) => s.epoch)).toEqual([-1, 2]);
    expect(r.driver.status.poolEpoch).toBe(2);
  });

  test('no preview is discarded by a gesture draft: drafts wait in one latest-wins slot, with no timer', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    land(r);
    edit(r, 0, BEGIN);
    edit(r, 1, DRAG);
    expect(configured(r)).toEqual(['s0', 's1']);
    await r.pool.ready();
    edit(r, 2, DRAG);
    edit(r, 3, DRAG);
    edit(r, 4, DRAG);
    await r.clock.advance(500);
    expect(configured(r)).toEqual(['s0', 's1']);
    land(r);
    expect(configured(r)).toEqual(['s0', 's1', 's4']);
    expect(r.pool.configures.slice(0, 2).map((c) => c.state)).toEqual(['resolved', 'resolved']);
  });

  test('urgent edits abort only cycles that a gesture started; a superseded configure is silent', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    land(r);
    edit(r, 0, BEGIN);
    edit(r, 1, DRAG);
    edit(r, 2, DRAG);
    edit(r, 2, END);
    expect(configured(r)).toEqual(['s0', 's1', 's2']);
    await flush();
    expect(r.pool.configures[1]!.state).toBe('rejected');
    expect(r.driver.status.error).toBeNull();
    edit(r, 3, URGENT);
    edit(r, 4, URGENT);
    expect(configured(r)).toEqual(['s0', 's1', 's2']);
    await r.pool.ready();
    land(r);
    expect(configured(r)).toEqual(['s0', 's1', 's2', 's4']);
    expect(r.driver.status.error).toBeNull();
  });

  test('key-repeat undo (urgent edits every 30 ms) is never starved: every cycle lands', async () => {
    const r = autoRig(90);
    for (let e = 0; e < 20; e++) {
      edit(r, e, { urgent: true, gesture: false, kind: 'undo' });
      await r.clock.advance(30);
    }
    await r.clock.advance(300);
    const drawn = new Set(r.landed.map((l) => l.epoch));
    expect(r.pool.configures.length).toBeGreaterThan(4);
    expect(r.pool.configures.every((c) => drawn.has(c.epoch))).toBe(true);
    expect(configured(r).at(-1)).toBe('s19');
    expect(r.driver.status.settled).toBe(true);
  });

  test('a same-epoch gestureEnd switches to the full plan without reconfiguring', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    land(r);
    edit(r, 0, BEGIN);
    edit(r, 1, DRAG);
    await r.pool.ready();
    expect(r.canvas.interactive).toBe(true);
    edit(r, 1, END);
    expect(configured(r)).toEqual(['s0', 's1']);
    expect(r.canvas.interactive).toBe(false);
    expect(r.driver.status.settled).toBe(false);
    land(r);
    expect(r.driver.status.settled).toBe(true);
    expect(r.pool.spawns).toEqual([-1, 2]);
    edit(r, 1, { urgent: true, gesture: false, kind: 'seed' });
    expect(configured(r)).toEqual(['s0', 's1']);
    expect(r.pool.spawns).toEqual([-1, 2]);
  });

  test('interactive exactly while a gesture is active or the slot holds a draft', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    expect(r.canvas.interactive).toBe(false);
    edit(r, 1, URGENT);
    expect(r.canvas.interactive).toBe(true);
    await r.pool.ready();
    land(r);
    expect(r.canvas.interactive).toBe(false);
    edit(r, 1, BEGIN);
    expect(r.canvas.interactive).toBe(true);
    await r.pool.ready();
    land(r);
    expect(r.canvas.interactive).toBe(true);
    edit(r, 2, DRAG);
    expect(r.canvas.interactive).toBe(true);
    edit(r, 2, END);
    expect(r.canvas.interactive).toBe(false);
    expect(r.canvas.interactiveCalls).toEqual([true, false, true, false]);
  });

  test('the spawn is requested once per settled pool epoch, and the marker stays until the new one arrives', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    expect(r.pool.spawns).toEqual([]);
    land(r);
    await flush();
    expect(r.pool.spawns).toEqual([-1]);
    expect(r.settled).toEqual([-1]);
    expect(r.canvas.spawns).toEqual([spawnOf(-1)]);
    edit(r, 0, BEGIN);
    edit(r, 0, END);
    land(r);
    expect(r.driver.status.settled).toBe(true);
    expect(r.pool.spawns).toEqual([-1]);
    expect(r.settled).toEqual([-1]);
    edit(r, 0, BEGIN);
    edit(r, 1, DRAG);
    await r.pool.ready();
    land(r);
    expect(r.driver.status.settled).toBe(false);
    expect(r.pool.spawns).toEqual([-1]);
    edit(r, 1, END);
    await flush();
    expect(r.pool.spawns).toEqual([-1, 2]);
    expect(r.settled).toEqual([-1, 2]);
    expect(r.canvas.spawns).toEqual([spawnOf(-1), spawnOf(2)]);
  });

  test('zoomed out: a gesture cycle lands with the pool.size nearest previews, an urgent one needs all', async () => {
    const r = rig(6);
    edit(r, 0, URGENT);
    await r.pool.ready();
    r.driver.previewProgress(r.canvas.source, 6, 9);
    expect(r.driver.status.pending).toBe(true);
    r.driver.previewProgress(r.canvas.source, 9, 9);
    expect(r.driver.status.pending).toBe(false);
    edit(r, 0, BEGIN);
    edit(r, 1, DRAG);
    await r.pool.ready();
    edit(r, 2, DRAG);
    r.driver.previewProgress(r.canvas.source, 5, 9);
    expect(configured(r)).toEqual(['s0', 's1']);
    r.driver.previewProgress(r.canvas.source, 6, 9);
    expect(configured(r)).toEqual(['s0', 's1', 's2']);
    await r.pool.ready();
    r.driver.previewProgress(r.canvas.source, 3, 4);
    expect(r.driver.status.pending).toBe(true);
    r.driver.previewProgress(r.canvas.source, 4, 4);
    expect(r.driver.status.pending).toBe(false);
  });

  test('watchdog: a cycle that has not landed after 1000 ms counts as landed and the slot starts', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    edit(r, 0, BEGIN);
    edit(r, 1, DRAG);
    await r.clock.advance(999);
    expect(configured(r)).toEqual(['s0']);
    await r.clock.advance(1);
    expect(configured(r)).toEqual(['s0', 's1']);
    expect(r.driver.status.lastLatencyMs).toBeNull();
  });

  test('watchdog: max(1000 ms, 3 × EWMA of landed cycle times), EWMA weight 1/4; watchdog landings do not feed it', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    await r.clock.advance(600);
    land(r);
    edit(r, 1, URGENT);
    await r.pool.ready();
    await r.clock.advance(1200);
    land(r);
    edit(r, 2, URGENT);
    await r.pool.ready();
    edit(r, 3, URGENT);
    await r.clock.advance(2249);
    expect(configured(r)).toEqual(['s0', 's1', 's2']);
    await r.clock.advance(1);
    expect(configured(r)).toEqual(['s0', 's1', 's2', 's3']);
    edit(r, 4, URGENT);
    await r.clock.advance(2249);
    expect(configured(r)).toEqual(['s0', 's1', 's2', 's3']);
    await r.clock.advance(1);
    expect(configured(r)).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test('a cycle the watchdog landed still gets its source when its configure resolves late, then settles', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.clock.advance(1000);
    expect(r.driver.status).toMatchObject({ pending: false, settled: false, poolEpoch: null });
    await r.pool.ready();
    expect(r.canvas.sources.map((s) => s.epoch)).toEqual([-1]);
    expect(r.driver.status).toMatchObject({ pending: false, settled: true, poolEpoch: -1 });
    expect(r.pool.spawns).toEqual([-1]);
  });

  test('a configure error sets status.error, ends the cycle and lets the slot run; JobCancelled is silent', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    edit(r, 1, URGENT);
    r.pool.configures[0]!.reject(new Error('workers disagree on the stage hashes'));
    await flush();
    expect(r.driver.status.error).toBe('workers disagree on the stage hashes');
    expect(configured(r)).toEqual(['s0', 's1']);
    await r.pool.ready();
    expect(r.driver.status.error).toBeNull();
    land(r);
    expect(r.driver.status.settled).toBe(true);
    edit(r, 2, URGENT);
    r.pool.configures[2]!.reject(new JobCancelled());
    await flush();
    expect(r.driver.status).toMatchObject({ error: null, pending: false, settled: false });
    edit(r, 2, URGENT);
    expect(configured(r)).toEqual(['s0', 's1', 's2', 's2']);
  });

  test('status: pending, settled, pool epoch and the input → preview latency; listeners hear changes only', async () => {
    const r = rig();
    r.clock.t = 100;
    r.driver.change(draft(0), URGENT, 95);
    expect(r.driver.status).toEqual({ lastLatencyMs: null, pending: true, settled: false, poolEpoch: null, error: null });
    await r.pool.ready();
    expect(r.driver.status.poolEpoch).toBe(-1);
    await r.clock.advance(120);
    land(r);
    land(r);
    expect(r.driver.status).toEqual({ lastLatencyMs: 125, pending: false, settled: true, poolEpoch: -1, error: null });
    expect(r.statuses).toHaveLength(3);
    expect(r.statuses.at(-1)).toBe(r.driver.status);
    const heard: number[] = [];
    const off = r.driver.onSettled((e) => heard.push(e));
    off();
    edit(r, 1, URGENT);
    await r.pool.ready();
    land(r);
    expect(heard).toEqual([]);
    expect(r.settled).toEqual([-1, 2]);
  });

  test('view changes never reconfigure: a pan only changes what the running cycle waits for', async () => {
    const r = rig();
    edit(r, 0, URGENT);
    await r.pool.ready();
    r.driver.previewProgress(r.canvas.source, 4, 6);
    expect(r.driver.status.pending).toBe(true);
    r.driver.previewProgress(r.canvas.source, 6, 6);
    expect(r.driver.status.pending).toBe(false);
    r.driver.previewProgress(r.canvas.source, 0, 9);
    r.driver.previewProgress(r.canvas.source, 9, 9);
    expect(configured(r)).toEqual(['s0']);
    expect(r.pool.spawns).toEqual([-1]);
    expect(r.settled).toEqual([-1]);
  });

  test('a 60 Hz drag lands one preview per cycle, at least one every 500 ms, then the release shows the last draft', async () => {
    const r = autoRig(90);
    let overlaps = 0;
    const post = r.pool.onConfigure;
    r.pool.onConfigure = (c) => {
      const prev = r.pool.configures.at(-2);
      if (prev !== undefined && !r.landed.some((l) => l.epoch === prev.epoch)) overlaps++;
      post?.(c);
    };
    let e = 0;
    edit(r, e, URGENT);
    await r.clock.advance(200);
    edit(r, e, BEGIN);
    const t0 = r.clock.now();
    for (let i = 0; i < 180; i++) {
      e++;
      edit(r, e, DRAG);
      await r.clock.advance(1000 / 60);
    }
    const during = r.landed.filter((l) => l.at > t0).map((l) => l.at);
    const gaps = during.slice(1).map((t, i) => t - during[i]!);
    expect(overlaps).toBe(0);
    expect(during.length).toBeGreaterThanOrEqual(30);
    expect(Math.max(during[0]! - t0, ...gaps)).toBeLessThanOrEqual(500);
    edit(r, e, END);
    await r.clock.advance(200);
    expect(configured(r).at(-1)).toBe('s180');
    expect(r.driver.status.settled).toBe(true);
    expect(r.canvas.interactive).toBe(false);
    expect(r.pool.spawns.at(-1)).toBe(r.pool.configures.at(-1)!.epoch);
  });

  test('random sequences: at most one configure per step, gesture drafts never reconfigure a busy driver, the last draft wins', async () => {
    for (let run = 0; run < 20; run++) {
      const r = rig(4);
      let seed = 12345 + run;
      const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
      let e = 0;
      let inGesture = false;
      edit(r, e, URGENT);
      for (let step = 0; step < 300; step++) {
        const before = r.pool.configures.length;
        const busy = r.driver.status.pending;
        const k = rnd(8);
        if (k === 0) { inGesture = !inGesture; edit(r, e, inGesture ? BEGIN : END); }
        else if (k === 1 && inGesture) {
          e++;
          edit(r, e, DRAG);
          if (busy) expect(r.pool.configures.length).toBe(before);
        } else if (k === 2 && !inGesture) { e++; edit(r, e, URGENT); }
        else if (k === 3) await r.pool.ready();
        else if (k === 4 && r.canvas.sources.length > 0) land(r);
        else if (k === 5) await r.clock.advance(rnd(400));
        else if (k === 6 && rnd(4) === 0) { r.pool.configures.at(-1)!.reject(new Error('boom')); await flush(); }
        else if (k === 7 && r.canvas.sources.length > 0) r.driver.previewProgress(r.canvas.source, rnd(5), 4);
        expect(r.pool.configures.length - before).toBeLessThanOrEqual(1);
        if (inGesture) expect(r.canvas.interactive).toBe(true);
        if (!r.driver.status.pending) expect(r.canvas.interactive).toBe(inGesture);
        if (r.driver.status.settled) expect([r.canvas.interactive, r.driver.status.pending]).toEqual([false, false]);
      }
      e++;
      edit(r, e, inGesture ? DRAG : URGENT);
      if (inGesture) edit(r, e, END);
      for (let i = 0; i < 10 && !r.driver.status.settled; i++) {
        await r.pool.ready();
        land(r);
      }
      expect(r.driver.status.settled).toBe(true);
      expect(configured(r).at(-1)).toBe(`s${e}`);
      expect(new Set(r.pool.spawns).size).toBe(r.pool.spawns.length);
    }
  });

  test('the worker pool is a DriverPool (the page passes it as is)', () => {
    const asDriverPool = (p: WorkerPool): DriverPool => p;
    expect(typeof asDriverPool).toBe('function');
  });
});

/**
 * The apply control (SP4c spec §4.3, D4; §4.7, §4.8; Review Focus 2) and the aux policy (§6.2; Review Focus 3), on a fake
 * clock with a real `WorldSession` from `openMapSession`. Most cases drive a fake driver that emits `Configured` and a
 * fake coordinator that records its calls; the undo and redo bursts run the real configure driver (no preview wanted,
 * as in the world before the first M) over a fake pool whose configures resolve 20 ms after they start. Every
 * `Configured` carries the real stage hashes and genKey of its draft, in hex as the workers report them.
 */
import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { createCoordinatorCounts, type CoordinatorCounts } from '../../src/engine/coordinator';
import { appliedDraftOf, type WorldStage } from '../../src/engine/invalidation';
import type { SessionState, WorldSession } from '../../src/engine/session';
import type { AuxFirst } from '../../src/engine/workerPool';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { createPreviewDriver, draftOf, type Configured, type DriverStatus } from '../../src/ui/map/previewDriver';
import {
  APPLY_QUIET_MS, auxCap, auxFirst, coversWorld, createApplyControl, createEpochs, updateAuxPolicy,
} from '../../src/ui/world/applyControl';

const AMP = 'density.detailAmpHi';

/** The ready reply the workers send for a session state: hex stage hashes and genKey (`taskHandler.ts`). */
function readyOf(s: SessionState): Configured['ready'] {
  const h = stageHashes(s.params);
  const hex: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) hex[k] = hex64(v!);
  return { stageHashes: hex, genKey: hex64(genKey(s.seed, h)) };
}

type Call = { readonly kind: 'apply'; readonly epoch: number; readonly generation: number; readonly from: WorldStage; readonly at: number }
  | { readonly kind: 'adopt'; readonly generation: number; readonly at: number };

/** A fake clock with timers, run in time order by `advance`. */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id: number): void { timers.delete(id); },
    /** Moves the time to `to`, running every timer due on the way. */
    runTo(to: number): void {
      for (;;) {
        let best: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= to && (best === null || e[1].at < best[1].at)) best = e;
        if (best === null) break;
        timers.delete(best[0]);
        t = best[1].at;
        best[1].fn();
      }
      t = to;
    },
    set(to: number): void { t = to; },
  };
}

interface Rig {
  readonly session: WorldSession;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly pool: { epoch: number };
  readonly status: { queued: boolean };
  readonly calls: Call[];
  readonly applied: Array<WorldStage | null>;
  readonly before: Array<WorldStage | null>;
  readonly epochs: { of(k: string): number };
  readonly control: ReturnType<typeof createApplyControl>;
  /** Reports a resolved configure of the session's current draft (or `s`) at the pool's epoch. */
  emit(o?: { readonly s?: SessionState; readonly poolEpoch?: number; readonly gesture?: boolean }): Configured;
  /** Issues a configure: the pool's epoch moves on. */
  configure(): number;
  /** Ticks at every ms from the clock's time + 1 to `to`. */
  ticksTo(to: number): void;
}

/** The control over a fake driver and coordinator; the first draft (seed 42, default) is applied at generation 0. */
function rig(o: { initialGeneration?: number } = {}): Rig {
  const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
  const clock = fakeClock();
  const pool = { epoch: o.initialGeneration ?? 0 };
  const status = { queued: false };
  const fns = new Set<(c: Configured) => void>();
  const calls: Call[] = [];
  const applied: Array<WorldStage | null> = [];
  const before: Array<WorldStage | null> = [];
  const epochs = createEpochs();
  const first = readyOf(session.state);
  // The page interns the first draft's genKey for the coordinator's first epoch.
  expect(epochs.of(first.genKey)).toBe(1);
  const control = createApplyControl({
    coordinator: {
      apply: (a) => { calls.push({ kind: 'apply', ...a, at: clock.now() }); },
      adopt: (g) => { calls.push({ kind: 'adopt', generation: g, at: clock.now() }); },
    },
    driver: {
      onConfigured: (fn) => {
        fns.add(fn);
        return () => { fns.delete(fn); };
      },
      get status() { return status as unknown as DriverStatus; },
    },
    session,
    pool,
    clock,
    epochs,
    initial: appliedDraftOf(draftOf(session.state).seedKey, first),
    initialGeneration: pool.epoch,
    beforeApply: (from) => {
      before.push(from);
      return true;
    },
    onApplied: ({ from }) => { applied.push(from); },
  });
  return {
    session, clock, pool, status, calls, applied, before, epochs, control,
    emit(e = {}) {
      const s = e.s ?? session.state;
      const c: Configured = {
        poolEpoch: e.poolEpoch ?? pool.epoch, sessionEpoch: s.epoch, seedKey: draftOf(s).seedKey, ready: readyOf(s),
        gesture: e.gesture ?? false, urgent: !(e.gesture ?? false),
      };
      for (const fn of [...fns]) fn(c);
      return c;
    },
    configure: () => ++pool.epoch,
    ticksTo(to) {
      for (let t = clock.now() + 1; t <= to; t++) {
        clock.set(t);
        control.tick();
      }
    },
  };
}

describe('createEpochs (SP4c spec §4.4)', () => {
  test('interns from 1 in first-seen order; a genKey seen again keeps its number', () => {
    const e = createEpochs();
    expect([e.of('aa'), e.of('bb'), e.of('aa'), e.of('cc'), e.of('bb')]).toEqual([1, 2, 1, 3, 2]);
  });
});

describe('createApplyControl (SP4c spec §4.3, D4)', () => {
  test('a gesture\'s drafts are never applied (density.detailAmpHi 2.0, 3.0, 4.0 inside one gesture); the draft configured after the release is applied 150 ms after the release', () => {
    const r = rig();
    r.session.beginGesture();
    r.session.set(AMP, 2.0);
    r.configure();
    r.ticksTo(20);
    r.emit({ gesture: true });
    r.ticksTo(300);
    r.session.set(AMP, 3.0);
    r.configure();
    r.ticksTo(320);
    r.emit({ gesture: true });
    r.ticksTo(600);
    r.session.set(AMP, 4.0);
    r.ticksTo(1000);
    expect(r.calls).toEqual([]);
    r.session.endGesture();
    const release = r.clock.now();
    r.configure();
    r.ticksTo(release + 30);
    r.emit({ gesture: true });
    r.ticksTo(release + APPLY_QUIET_MS - 1);
    expect(r.calls).toEqual([]);
    r.ticksTo(release + APPLY_QUIET_MS);
    expect(r.calls).toEqual([{ kind: 'apply', epoch: 2, generation: 3, from: 'T', at: release + 150 }]);
    expect(r.control.applied.genKey).toBe(readyOf(r.session.state).genKey);
  });

  test('at 149 ms nothing, at 150 ms the apply', () => {
    const r = rig();
    r.session.set(AMP, 2.0);
    r.configure();
    r.ticksTo(20);
    r.emit();
    r.ticksTo(149);
    expect(r.calls).toEqual([]);
    r.ticksTo(150);
    expect(r.calls).toEqual([{ kind: 'apply', epoch: 2, generation: 1, from: 'T', at: 150 }]);
  });

  test('a Configured whose poolEpoch is not pool.epoch (a newer configure issued) is never applied', () => {
    const r = rig();
    r.session.set(AMP, 2.0);
    r.configure();
    r.ticksTo(20);
    r.emit();
    // A newer configure (of the same session draft, so only the pool's epoch differs) was issued and never reported.
    r.configure();
    r.ticksTo(2000);
    expect(r.calls).toEqual([]);
    expect(r.applied).toEqual([]);
  });

  test('a queued newer draft waits; its own Configured applies once quiet', () => {
    const r = rig();
    r.session.set(AMP, 2.0);
    const a = r.session.state;
    r.configure();
    r.ticksTo(10);
    r.session.set(AMP, 3.0);
    // B waits in the driver's slot while A's configure resolves.
    r.status.queued = true;
    r.ticksTo(20);
    expect(r.emit({ s: a }).poolEpoch).toBe(1);
    r.ticksTo(400);
    expect(r.calls).toEqual([]);
    // B's cycle starts: the slot empties and the pool configures it.
    r.status.queued = false;
    r.configure();
    r.ticksTo(420);
    r.emit();
    r.ticksTo(421);
    expect(r.calls).toEqual([{ kind: 'apply', epoch: 2, generation: 2, from: 'T', at: 421 }]);
    expect(r.control.applied.genKey).toBe(readyOf(r.session.state).genKey);
  });

  test('while the driver\'s slot holds a draft, even a Configured of the session\'s epoch waits', () => {
    const r = rig();
    r.session.set(AMP, 2.0);
    r.configure();
    r.status.queued = true;
    r.emit();
    r.ticksTo(400);
    expect(r.calls).toEqual([]);
    r.status.queued = false;
    r.ticksTo(401);
    expect(r.calls).toEqual([{ kind: 'apply', epoch: 2, generation: 1, from: 'T', at: 401 }]);
  });

  test('a Configured of another session epoch than the session\'s is never applied', () => {
    const r = rig();
    r.session.set(AMP, 2.0);
    const old = r.session.state;
    r.session.set(AMP, 3.0);
    r.configure();
    r.ticksTo(20);
    r.emit({ s: old });
    r.ticksTo(2000);
    expect(r.calls).toEqual([]);
  });

  test('an equal genKey adopts (adopt(poolEpoch), no apply)', () => {
    const r = rig();
    r.session.set(AMP, 2.0);
    r.ticksTo(10);
    r.session.set(AMP, 1.5);
    r.configure();
    r.ticksTo(30);
    r.emit();
    r.ticksTo(400);
    expect(r.calls).toEqual([{ kind: 'adopt', generation: 1, at: 160 }]);
    expect(r.applied).toEqual([null]);
    expect(r.control.generation).toBe(1);
  });

  test('a new genKey applies with epoch from createEpochs (A → 1, B → 2, back to A → 1)', () => {
    const r = rig();
    r.session.set(AMP, 3.0);
    r.configure();
    r.emit();
    r.ticksTo(200);
    r.session.set(AMP, 1.5);
    r.configure();
    r.emit();
    r.ticksTo(400);
    expect(r.calls.map((c) => (c.kind === 'apply' ? [c.epoch, c.generation, c.from] : c.kind))).toEqual([[2, 1, 'T'], [1, 2, 'T']]);
  });

  test('beforeApply sees from; onApplied fires once per Apply or adopt with its from', () => {
    const r = rig();
    r.session.set(AMP, 3.0);
    r.configure();
    r.emit();
    r.ticksTo(200);
    // A typed value equal to the applied one: a new session epoch, the same world.
    r.session.set(AMP, 2.0);
    r.ticksTo(210);
    r.session.set(AMP, 3.0);
    r.configure();
    r.emit();
    r.ticksTo(500);
    expect(r.before).toEqual(['T', null]);
    expect(r.applied).toEqual(['T', null]);
    expect(r.calls.map((c) => c.kind)).toEqual(['apply', 'adopt']);
  });

  test('after an Apply, 100 more ticks call neither apply, adopt nor onApplied', () => {
    const r = rig();
    r.session.set(AMP, 3.0);
    r.configure();
    r.emit();
    r.ticksTo(150);
    expect(r.calls).toHaveLength(1);
    expect(r.applied).toHaveLength(1);
    r.ticksTo(250);
    expect(r.calls).toHaveLength(1);
    expect(r.applied).toHaveLength(1);
    expect(r.before).toHaveLength(1);
  });

  test('generation is initialGeneration until the first Apply, then that Configured\'s poolEpoch', () => {
    const r = rig({ initialGeneration: 5 });
    expect(r.control.generation).toBe(5);
    r.session.set(AMP, 3.0);
    r.configure();
    r.configure();
    r.emit();
    r.ticksTo(149);
    expect(r.control.generation).toBe(5);
    r.ticksTo(150);
    expect(r.control.generation).toBe(7);
  });

  test('a seed change and a profile change through the real session each apply with from \'T\' and a new epoch, like any setting (decision 9, spec §4.7)', () => {
    const r = rig();
    r.session.setSeedText('43');
    r.configure();
    r.emit();
    r.ticksTo(200);
    const s = r.session.setProfile('large_biomes');
    expect(s.ok).toBe(true);
    r.configure();
    r.emit();
    r.ticksTo(400);
    expect(r.calls).toEqual([
      { kind: 'apply', epoch: 2, generation: 1, from: 'T', at: 150 },
      { kind: 'apply', epoch: 3, generation: 2, from: 'T', at: 350 },
    ]);
  });

  test('dispose unsubscribes: later configures and ticks do nothing', () => {
    const r = rig();
    const before = r.session.listenerCount();
    r.control.dispose();
    expect(r.session.listenerCount()).toBe(before - 1);
    r.session.set(AMP, 3.0);
    r.configure();
    r.emit();
    r.ticksTo(400);
    expect(r.calls).toEqual([]);
  });
});

/**
 * The undo and redo bursts (Review Focus 2) through the real configure driver: no preview wanted, every session change
 * fed to `driver.change` (the page's subscribe), each configure resolving 20 ms after it starts.
 */
function burstRig() {
  const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
  const clock = fakeClock();
  let epoch = 0;
  const configures: number[] = [];
  const pool = {
    size: 4,
    get epoch() { return epoch; },
    configure(seedText: string, params: SessionState['params']) {
      const e = ++epoch;
      configures.push(clock.now());
      const s = openMapSession({ ...DEFAULT_MAP_STATE, seed: seedText }, () => [1, 2]).state;
      const h = stageHashes(params);
      const hex: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) hex[k] = hex64(v!);
      const ready = { epoch: e, stageHashes: hex, genKey: hex64(genKey(s.seed, h)) };
      return new Promise<typeof ready>((resolve) => { clock.setTimeout(() => resolve(ready), 20); });
    },
    spawn: () => new Promise<never>(() => {}),
  };
  const driver = createPreviewDriver(pool, { setSource() {}, setInteractive() {}, setSpawn() {} }, clock);
  driver.setPreviewWanted(false);
  const first = readyOf(session.state);
  driver.adopt({ poolEpoch: 0, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready: first });
  session.subscribe((s, ch) => driver.change(draftOf(s), ch, clock.now()));
  const calls: Call[] = [];
  const epochs = createEpochs();
  epochs.of(first.genKey);
  const control = createApplyControl({
    coordinator: {
      apply: (a) => { calls.push({ kind: 'apply', ...a, at: clock.now() }); },
      adopt: (g) => { calls.push({ kind: 'adopt', generation: g, at: clock.now() }); },
    },
    driver, session, pool, clock, epochs,
    initial: appliedDraftOf(draftOf(session.state).seedKey, first),
    initialGeneration: 0,
    beforeApply: () => true,
    onApplied: () => {},
  });
  /** One frame per ms up to `to`: the due timers, the promise callbacks, then the control's tick. */
  const runTo = async (to: number): Promise<void> => {
    for (let t = clock.now() + 1; t <= to; t++) {
      clock.runTo(t);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      control.tick();
    }
  };
  return { session, clock, pool, configures, calls, epochs, control, runTo };
}

describe('undo and redo bursts (SP4c spec §4.8; Review Focus 2)', () => {
  test('12 undos 33 ms apart (each configure resolving 20 ms after it starts): exactly one coordinator.apply, with the last undo\'s genKey, ≥ 150 ms after the last change', async () => {
    const r = burstRig();
    // Twelve history steps, applied: the world shows the twelfth.
    for (let i = 1; i <= 12; i++) r.session.set(AMP, 1.5 + 0.25 * i);
    await r.runTo(1000);
    expect(r.calls.map((c) => c.kind)).toEqual(['apply']);
    expect(r.control.applied.genKey).toBe(readyOf(r.session.state).genKey);
    r.calls.length = 0;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      await r.runTo(1000 + 33 * i);
      expect(r.session.undo()).toBe(true);
      last = r.clock.now();
    }
    await r.runTo(last + 1000);
    expect(r.session.state.params.density.detailAmpHi).toBe(1.5);
    expect(r.calls).toHaveLength(1);
    const c = r.calls[0]!;
    expect(c.kind).toBe('apply');
    expect(c.at - last).toBeGreaterThanOrEqual(APPLY_QUIET_MS);
    const want = readyOf(r.session.state).genKey;
    expect(r.control.applied.genKey).toBe(want);
    expect(c.kind === 'apply' && c.epoch).toBe(r.epochs.of(want));
    // The last undo's configure is the one applied.
    expect(c.generation).toBe(r.pool.epoch);
    expect(r.control.generation).toBe(r.pool.epoch);
  });

  test('an alternating Z, Y, Z, Y burst ending on the applied draft: no apply, one adopt with the last configure\'s generation', async () => {
    const r = burstRig();
    r.session.set(AMP, 2.0);
    r.session.set(AMP, 3.0);
    await r.runTo(1000);
    expect(r.calls.map((c) => c.kind)).toEqual(['apply']);
    const applied = r.control.applied.genKey;
    r.calls.length = 0;
    const issued = r.configures.length;
    let last = 0;
    for (let i = 0; i < 4; i++) {
      await r.runTo(1000 + 33 * i);
      expect(i % 2 === 0 ? r.session.undo() : r.session.redo()).toBe(true);
      last = r.clock.now();
    }
    await r.runTo(last + 1000);
    expect(r.session.state.params.density.detailAmpHi).toBe(3.0);
    expect(r.configures.length).toBeGreaterThan(issued);
    expect(r.calls).toEqual([{ kind: 'adopt', generation: r.pool.epoch, at: expect.any(Number) as number }]);
    expect(r.calls[0]!.at - last).toBeGreaterThanOrEqual(APPLY_QUIET_MS);
    expect(r.control.applied.genKey).toBe(applied);
    expect(r.control.generation).toBe(r.pool.epoch);
  });
});

describe('the aux policy (SP4c spec §6.2, D11)', () => {
  test('the aux policy table, n = 4: held → (aux, 4); covers → (aux, 3); visible with T pending → (world, 1); visible without → (world, 4); n = 1 covers → (aux, 1)', () => {
    const at = (held: boolean, covers: boolean, tPending: boolean, n: number): [AuxFirst, number] =>
      [auxFirst(held, covers), auxCap(held, covers, tPending, n)];
    expect(at(true, false, true, 4)).toEqual(['aux', 4]);
    expect(at(true, true, true, 4)).toEqual(['aux', 4]);
    expect(at(false, true, true, 4)).toEqual(['aux', 3]);
    expect(at(false, false, true, 4)).toEqual(['world', 1]);
    expect(at(false, false, false, 4)).toEqual(['world', 4]);
    expect(at(false, true, false, 1)).toEqual(['aux', 1]);
  });

  /** A pool recording every `setAuxPolicy` call. */
  const policyPool = (epoch: number) => {
    const set: Array<[AuxFirst, number]> = [];
    let live = 4;
    return {
      set,
      kill() { live--; },
      pool: { epoch, size: 4, liveWorkers: () => live, setAuxPolicy: (f: AuxFirst, c: number) => { set.push([f, c]); } },
    };
  };
  const pendingT = (): CoordinatorCounts => {
    const c = createCoordinatorCounts();
    c.T.needed = 349;
    c.T.done = 12;
    return c;
  };

  test('updateAuxPolicy: held is the pool\'s epoch against the applied generation; T pending from the counts', () => {
    const p = policyPool(7);
    const counts = pendingT();
    updateAuxPolicy(p.pool, 6, false, counts);
    updateAuxPolicy(p.pool, 7, false, counts);
    counts.T.done = 349;
    updateAuxPolicy(p.pool, 7, false, counts);
    expect(p.set).toEqual([['aux', 4], ['world', 1], ['world', 4]]);
  });

  test('n is the live workers, not the pool\'s size: a pool of 4 with one worker dead covers → (aux, 2), held → (aux, 3), visible without T pending → (world, 3); one live worker covers → (aux, 1)', () => {
    const p = policyPool(5);
    const counts = pendingT();
    p.kill();
    updateAuxPolicy(p.pool, 5, true, counts);
    updateAuxPolicy(p.pool, 4, true, counts);
    counts.T.done = counts.T.needed;
    updateAuxPolicy(p.pool, 5, false, counts);
    p.kill();
    p.kill();
    updateAuxPolicy(p.pool, 5, true, counts);
    expect(p.set).toEqual([['aux', 2], ['aux', 3], ['world', 3], ['aux', 1]]);
  });

  test('the A shown → B shown → B locked → A shown → hidden sequence (user cap 0, 4 workers, T pending, world not held) through updateAuxPolicy gives setAuxPolicy (aux, 3), (world, 1), (world, 1), (aux, 3), (world, 1)', () => {
    const p = policyPool(3);
    const counts = pendingT();
    // The overlay's mode and shown state at each step; the pointer lock changes the owner, not the policy.
    const steps: Array<{ mode: 'full' | 'split'; shown: boolean }> = [
      { mode: 'full', shown: true },
      { mode: 'split', shown: true },
      { mode: 'split', shown: true },
      { mode: 'full', shown: true },
      { mode: 'full', shown: false },
    ];
    for (const s of steps) updateAuxPolicy(p.pool, 3, coversWorld(s), counts);
    expect(p.set).toEqual([['aux', 3], ['world', 1], ['world', 1], ['aux', 3], ['world', 1]]);
    // Before the first M there is no overlay: the 3D is visible.
    expect(coversWorld(null)).toBe(false);
  });
});

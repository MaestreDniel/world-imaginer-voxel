/**
 * Preview driver (SP2b spec §2.6): turns session changes into configure cycles, one at a time. A cycle
 * configures the pool with a draft, sets the canvas source and waits until the canvas reports the cycle's
 * level-256 preview drawn. Drafts that arrive meanwhile wait in one latest-wins slot; urgent edits abort
 * only cycles that a gesture started. The canvas plans preview tiles only while a gesture is active or
 * the slot holds a draft. Once settled, the driver requests the spawn and emits onSettled, once per pool
 * epoch. Pure: the pool, the canvas and the clock are injected, and pan or zoom never reach it (§2.7).
 *
 * In the world (SP4c spec §4.2) the same driver is the configure owner: it adopts the page's first configure, reports
 * every resolved configure (`onConfigured`, which the apply control reads), lands a cycle as soon as its configure
 * resolves while no map shows its preview (`setPreviewWanted(false)`), and pushes into a replaying canvas sink, so a
 * map mounted later gets the last source, interactivity and spawn (`createReplayingCanvas`). The world's spawn runs at
 * priority 600 (§6.3), the standalone page's at −2.
 */
import type { Params } from '../../core/params/schema';
import type { SessionState } from '../../engine/session';
import { JobCancelled } from '../../engine/workerPool';
import type { Spawn } from '../../gen/column/spawn';

export interface DriverDraft { readonly sessionEpoch: number; readonly seedText: string; readonly seedKey: string; readonly params: Params }

/** The draft a session state hands the driver (the standalone shell, the map tool, the world page and its apply control). */
export const draftOf = (s: SessionState): DriverDraft => ({ sessionEpoch: s.epoch, seedText: s.seedText, seedKey: `${s.seed[0]}.${s.seed[1]}`, params: s.params });

export interface DriverPool {
  readonly size: number;
  configure(seedText: string, params: Params): Promise<{ readonly epoch: number; readonly stageHashes: Readonly<Record<string, string>>; readonly genKey: string }>;
  spawn(priority?: number): Promise<Spawn>;
}

export interface DriverCanvas {
  setSource(poolEpoch: number, seedKey: string, hashes: Readonly<Record<string, string>>): void;
  setInteractive(on: boolean): void;
  setSpawn(s: Spawn | null): void;
}

export interface DriverClock { now(): number; setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void }

export interface DriverStatus {
  /** Input time to the landing of the last cycle whose preview was drawn (watchdog landings do not count). */
  readonly lastLatencyMs: number | null;
  /** A cycle is in flight or the slot holds a draft. */
  readonly pending: boolean;
  /** The slot holds a draft (a newer one than the running cycle's waits; SP4c spec §4.2). */
  readonly queued: boolean;
  readonly settled: boolean;
  /** The pool epoch of the canvas source (the last configure that resolved). */
  readonly poolEpoch: number | null;
  /**
   * The session epoch of the draft that configure holds (SP3d spec §4.5), null before the first one resolves: a
   * view that requests jobs per (poolEpoch, sessionEpoch) runs them on that draft, which may be older than the
   * session's while a newer draft is being configured or waits in the slot.
   */
  readonly sessionEpoch: number | null;
  readonly error: string | null;
}

/** A resolved configure and the change that started its cycle (SP4c spec §4.2). */
export interface Configured {
  readonly poolEpoch: number;
  readonly sessionEpoch: number;
  readonly seedKey: string;
  readonly ready: { readonly stageHashes: Readonly<Record<string, string>>; readonly genKey: string };
  readonly gesture: boolean;
  readonly urgent: boolean;
}

export interface PreviewDriver {
  /** A session change (after the session applied it). inputAt = the input event's timeStamp or clock.now(). */
  change(draft: DriverDraft, change: { readonly urgent: boolean; readonly gesture: boolean; readonly kind: string }, inputAt: number): void;
  /** Canvas progress: `nearestDrawn` = length of the longest distance-ordered prefix of visible level-256 positions showing tiles of `poolEpoch`; `visible` = their count. */
  previewProgress(poolEpoch: number, nearestDrawn: number, visible: number): void;
  onSettled(fn: (poolEpoch: number) => void): () => void;
  onStatus(fn: (s: DriverStatus) => void): () => void;
  readonly status: DriverStatus;
  /**
   * Takes over a configure the page issued itself (the world's first one): a landed cycle with that source, whose
   * `canvas.setSource` is called; it settles (the spawn is requested), and the next `change` of the same session epoch
   * does nothing.
   */
  adopt(a: { readonly poolEpoch: number; readonly sessionEpoch: number; readonly seedKey: string; readonly ready: Configured['ready'] }): void;
  /**
   * Off while no map shows the preview: a cycle lands as soon as its configure resolves (no `lastLatencyMs` sample), and
   * a cycle already resolved and waiting for its preview lands at once. The watchdog stays. On by default.
   */
  setPreviewWanted(on: boolean): void;
  /** Called once per resolved configure; a configure superseded before it resolved is not reported. */
  onConfigured(fn: (c: Configured) => void): () => void;
  /** Clears the watchdog and the listeners; configures and spawns that resolve later, and every later call, do nothing. */
  dispose(): void;
}

/** The watchdog: max(WATCHDOG_MIN_MS, WATCHDOG_FACTOR × EWMA of landed cycle times); a new sample weighs EWMA_ALPHA. */
const WATCHDOG_MIN_MS = 1000;
const WATCHDOG_FACTOR = 3;
const EWMA_ALPHA = 0.25;

interface Cycle {
  readonly sessionEpoch: number;
  readonly seedKey: string;
  /** Started by a non-urgent edit: an urgent edit may abort it, and the zoomed-out rule applies to it. */
  readonly byGesture: boolean;
  /** The `gesture` flag of the change that started it (reported by `onConfigured`). */
  readonly gesture: boolean;
  readonly inputAt: number;
  readonly startedAt: number;
  poolEpoch: number | null;
  state: 'running' | 'landed' | 'failed';
  timer: number | null;
}

interface Slot { readonly draft: DriverDraft; readonly urgent: boolean; readonly gesture: boolean; readonly inputAt: number }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The standalone page's spawn priority (the pool's default, ahead of the map's tiles). */
const SPAWN_PRIORITY_DEFAULT = -2;

export function createPreviewDriver(pool: DriverPool, canvas: DriverCanvas, clock: DriverClock, opts?: { readonly spawnPriority?: number }): PreviewDriver {
  const spawnPriority = opts?.spawnPriority ?? SPAWN_PRIORITY_DEFAULT;
  /** The newest cycle; older ones were superseded by its configure and their results are ignored. */
  let latest: Cycle | null = null;
  let slot: Slot | null = null;
  let gesture = false;
  let previewWanted = true;
  let disposed = false;
  let interactive = false;
  let settled = false;
  let sourceEpoch: number | null = null;
  let sourceSession: number | null = null;
  let spawnedFor: number | null = null;
  let ewma: number | null = null;
  let lastLatencyMs: number | null = null;
  let error: string | null = null;
  let status: DriverStatus = { lastLatencyMs, pending: false, queued: false, settled, poolEpoch: sourceEpoch, sessionEpoch: sourceSession, error };
  const settledFns = new Set<(poolEpoch: number) => void>();
  const statusFns = new Set<(s: DriverStatus) => void>();
  const configuredFns = new Set<(c: Configured) => void>();

  const emitStatus = () => {
    const queued = slot !== null;
    const pending = (latest !== null && latest.state === 'running') || queued;
    const s = status;
    if (s.lastLatencyMs === lastLatencyMs && s.pending === pending && s.queued === queued && s.settled === settled
      && s.poolEpoch === sourceEpoch && s.sessionEpoch === sourceSession && s.error === error) return;
    status = { lastLatencyMs, pending, queued, settled, poolEpoch: sourceEpoch, sessionEpoch: sourceSession, error };
    for (const fn of [...statusFns]) fn(status);
  };

  const requestSpawn = (poolEpoch: number) => {
    pool.spawn(spawnPriority).then((s) => { if (!disposed && spawnedFor === poolEpoch) canvas.setSpawn(s); }, (e: unknown) => {
      if (disposed || e instanceof JobCancelled || spawnedFor !== poolEpoch) return;
      error = `spawn: ${messageOf(e)}`;
      emitStatus();
    });
  };

  /** After every transition: the plan (interactive or full), settling, then the status. */
  const refresh = () => {
    const want = gesture || slot !== null;
    if (want !== interactive) { interactive = want; canvas.setInteractive(want); }
    const shown = latest !== null && latest.state === 'landed' ? latest.poolEpoch : null;
    settled = !interactive && shown !== null;
    if (!interactive && shown !== null && shown !== spawnedFor) {
      spawnedFor = shown;
      requestSpawn(shown);
      for (const fn of [...settledFns]) fn(shown);
    }
    emitStatus();
  };

  /**
   * Ends the running cycle `c`: landed by its preview, by the watchdog or by its configure while the preview is not
   * wanted (neither of the last two is a sample), or failed. The slot's draft starts next.
   */
  const end = (c: Cycle, how: 'preview' | 'watchdog' | 'configured' | 'failed') => {
    const wasRunning = c.state === 'running';
    c.state = how === 'failed' ? 'failed' : 'landed';
    if (c.timer !== null) { clock.clearTimeout(c.timer); c.timer = null; }
    if (how === 'preview') {
      const now = clock.now();
      const took = now - c.startedAt;
      ewma = ewma === null ? took : ewma + EWMA_ALPHA * (took - ewma);
      lastLatencyMs = now - c.inputAt;
    }
    if (wasRunning && slot !== null) {
      const s = slot;
      slot = null;
      start(s.draft, s.urgent, s.gesture, s.inputAt);
    }
    refresh();
  };

  const start = (draft: DriverDraft, urgent: boolean, gestureFlag: boolean, inputAt: number) => {
    if (latest !== null && latest.timer !== null) { clock.clearTimeout(latest.timer); latest.timer = null; }
    const c: Cycle = {
      sessionEpoch: draft.sessionEpoch, seedKey: draft.seedKey, byGesture: !urgent, gesture: gestureFlag, inputAt, startedAt: clock.now(),
      poolEpoch: null, state: 'running', timer: null,
    };
    latest = c;
    const wait = Math.max(WATCHDOG_MIN_MS, ewma === null ? 0 : WATCHDOG_FACTOR * ewma);
    c.timer = clock.setTimeout(() => { c.timer = null; if (latest === c && c.state === 'running') end(c, 'watchdog'); }, wait);
    pool.configure(draft.seedText, draft.params).then((ready) => {
      if (disposed || latest !== c) return;
      c.poolEpoch = ready.epoch;
      sourceEpoch = ready.epoch;
      sourceSession = c.sessionEpoch;
      error = null;
      canvas.setSource(ready.epoch, c.seedKey, ready.stageHashes);
      if (!previewWanted && c.state === 'running') end(c, 'configured');
      else refresh();
      const done: Configured = {
        poolEpoch: ready.epoch, sessionEpoch: c.sessionEpoch, seedKey: c.seedKey,
        ready: { stageHashes: ready.stageHashes, genKey: ready.genKey }, gesture: c.gesture, urgent: !c.byGesture,
      };
      for (const fn of [...configuredFns]) fn(done);
    }, (e: unknown) => {
      if (disposed || latest !== c) return;
      if (!(e instanceof JobCancelled)) error = messageOf(e);
      end(c, 'failed');
    });
  };

  return {
    change(draft, ch, inputAt) {
      if (disposed) return;
      gesture = ch.gesture;
      const e = draft.sessionEpoch;
      const c = latest;
      const running = c !== null && c.state === 'running';
      const shown = c !== null && c.state !== 'failed' ? c.sessionEpoch : null;
      if (e === shown) slot = null;
      else if (!ch.urgent && slot !== null && slot.draft.sessionEpoch === e) { /* the slot already holds this draft */ }
      else if (!running) start(draft, ch.urgent, ch.gesture, inputAt);
      else if (ch.urgent && c.byGesture) { slot = null; start(draft, true, ch.gesture, inputAt); }
      else slot = { draft, urgent: ch.urgent, gesture: ch.gesture, inputAt };
      refresh();
    },
    previewProgress(poolEpoch, nearestDrawn, visible) {
      if (disposed) return;
      const c = latest;
      if (c === null || c.state !== 'running' || c.poolEpoch !== poolEpoch) return;
      const need = c.byGesture ? Math.min(visible, pool.size) : visible;
      if (nearestDrawn >= need) end(c, 'preview');
    },
    onSettled(fn) {
      settledFns.add(fn);
      return () => { settledFns.delete(fn); };
    },
    onStatus(fn) {
      statusFns.add(fn);
      return () => { statusFns.delete(fn); };
    },
    get status() { return status; },
    adopt(a) {
      if (disposed) return;
      if (latest !== null && latest.timer !== null) { clock.clearTimeout(latest.timer); latest.timer = null; }
      const now = clock.now();
      latest = {
        sessionEpoch: a.sessionEpoch, seedKey: a.seedKey, byGesture: false, gesture: false, inputAt: now, startedAt: now,
        poolEpoch: a.poolEpoch, state: 'landed', timer: null,
      };
      sourceEpoch = a.poolEpoch;
      sourceSession = a.sessionEpoch;
      error = null;
      canvas.setSource(a.poolEpoch, a.seedKey, a.ready.stageHashes);
      // A draft that waited in the slot of a cycle the adopt replaced starts now (nothing else would start it).
      const s = slot;
      slot = null;
      if (s !== null && s.draft.sessionEpoch !== a.sessionEpoch) start(s.draft, s.urgent, s.gesture, s.inputAt);
      refresh();
    },
    setPreviewWanted(on) {
      if (disposed || on === previewWanted) return;
      previewWanted = on;
      const c = latest;
      if (!on && c !== null && c.state === 'running' && c.poolEpoch !== null) end(c, 'configured');
    },
    onConfigured(fn) {
      configuredFns.add(fn);
      return () => { configuredFns.delete(fn); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (latest !== null && latest.timer !== null) { clock.clearTimeout(latest.timer); latest.timer = null; }
      slot = null;
      settledFns.clear();
      statusFns.clear();
      configuredFns.clear();
    },
  };
}

/**
 * The driver's canvas in the world (SP4c spec §4.2): a forwarding sink that keeps the last source, interactivity and
 * spawn and replays them, in that order, into a canvas attached later (the map tool attaches at mount and detaches at
 * dispose); while none is attached it only keeps them.
 */
export function createReplayingCanvas(): DriverCanvas & { attach(c: DriverCanvas): void; detach(): void } {
  let target: DriverCanvas | null = null;
  let source: { readonly epoch: number; readonly seedKey: string; readonly hashes: Readonly<Record<string, string>> } | null = null;
  let interactive = false;
  let spawn: Spawn | null = null;
  return {
    setSource(epoch, seedKey, hashes) {
      source = { epoch, seedKey, hashes };
      target?.setSource(epoch, seedKey, hashes);
    },
    setInteractive(on) {
      interactive = on;
      target?.setInteractive(on);
    },
    setSpawn(s) {
      spawn = s;
      target?.setSpawn(s);
    },
    attach(c) {
      target = c;
      if (source !== null) c.setSource(source.epoch, source.seedKey, source.hashes);
      c.setInteractive(interactive);
      c.setSpawn(spawn);
    },
    detach() { target = null; },
  };
}

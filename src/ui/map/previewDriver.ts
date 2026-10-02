/**
 * Preview driver (SP2b spec §2.6): turns session changes into configure cycles, one at a time. A cycle
 * configures the pool with a draft, sets the canvas source and waits until the canvas reports the cycle's
 * level-256 preview drawn. Drafts that arrive meanwhile wait in one latest-wins slot; urgent edits abort
 * only cycles that a gesture started. The canvas plans preview tiles only while a gesture is active or
 * the slot holds a draft. Once settled, the driver requests the spawn and emits onSettled, once per pool
 * epoch. Pure: the pool, the canvas and the clock are injected, and pan or zoom never reach it (§2.7).
 */
import type { Params } from '../../core/params/schema';
import { JobCancelled } from '../../engine/workerPool';
import type { Spawn } from '../../gen/column/spawn';

export interface DriverDraft { readonly sessionEpoch: number; readonly seedText: string; readonly seedKey: string; readonly params: Params }

export interface DriverPool {
  readonly size: number;
  configure(seedText: string, params: Params): Promise<{ readonly epoch: number; readonly stageHashes: Readonly<Record<string, string>> }>;
  spawn(): Promise<Spawn>;
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
  readonly settled: boolean;
  /** The pool epoch of the canvas source (the last configure that resolved). */
  readonly poolEpoch: number | null;
  readonly error: string | null;
}

export interface PreviewDriver {
  /** A session change (after the session applied it). inputAt = the input event's timeStamp or clock.now(). */
  change(draft: DriverDraft, change: { readonly urgent: boolean; readonly gesture: boolean; readonly kind: string }, inputAt: number): void;
  /** Canvas progress: `nearestDrawn` = length of the longest distance-ordered prefix of visible level-256 positions showing tiles of `poolEpoch`; `visible` = their count. */
  previewProgress(poolEpoch: number, nearestDrawn: number, visible: number): void;
  onSettled(fn: (poolEpoch: number) => void): () => void;
  onStatus(fn: (s: DriverStatus) => void): () => void;
  readonly status: DriverStatus;
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
  readonly inputAt: number;
  readonly startedAt: number;
  poolEpoch: number | null;
  state: 'running' | 'landed' | 'failed';
  timer: number | null;
}

interface Slot { readonly draft: DriverDraft; readonly urgent: boolean; readonly inputAt: number }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createPreviewDriver(pool: DriverPool, canvas: DriverCanvas, clock: DriverClock): PreviewDriver {
  /** The newest cycle; older ones were superseded by its configure and their results are ignored. */
  let latest: Cycle | null = null;
  let slot: Slot | null = null;
  let gesture = false;
  let interactive = false;
  let settled = false;
  let sourceEpoch: number | null = null;
  let spawnedFor: number | null = null;
  let ewma: number | null = null;
  let lastLatencyMs: number | null = null;
  let error: string | null = null;
  let status: DriverStatus = { lastLatencyMs, pending: false, settled, poolEpoch: sourceEpoch, error };
  const settledFns = new Set<(poolEpoch: number) => void>();
  const statusFns = new Set<(s: DriverStatus) => void>();

  const emitStatus = () => {
    const pending = (latest !== null && latest.state === 'running') || slot !== null;
    const s = status;
    if (s.lastLatencyMs === lastLatencyMs && s.pending === pending && s.settled === settled && s.poolEpoch === sourceEpoch && s.error === error) return;
    status = { lastLatencyMs, pending, settled, poolEpoch: sourceEpoch, error };
    for (const fn of [...statusFns]) fn(status);
  };

  const requestSpawn = (poolEpoch: number) => {
    pool.spawn().then((s) => { if (spawnedFor === poolEpoch) canvas.setSpawn(s); }, (e: unknown) => {
      if (e instanceof JobCancelled || spawnedFor !== poolEpoch) return;
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

  /** Ends the running cycle `c`: landed by its preview or by the watchdog, or failed. The slot's draft starts next. */
  const end = (c: Cycle, how: 'preview' | 'watchdog' | 'failed') => {
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
      start(s.draft, !s.urgent, s.inputAt);
    }
    refresh();
  };

  const start = (draft: DriverDraft, byGesture: boolean, inputAt: number) => {
    if (latest !== null && latest.timer !== null) { clock.clearTimeout(latest.timer); latest.timer = null; }
    const c: Cycle = {
      sessionEpoch: draft.sessionEpoch, seedKey: draft.seedKey, byGesture, inputAt, startedAt: clock.now(),
      poolEpoch: null, state: 'running', timer: null,
    };
    latest = c;
    const wait = Math.max(WATCHDOG_MIN_MS, ewma === null ? 0 : WATCHDOG_FACTOR * ewma);
    c.timer = clock.setTimeout(() => { c.timer = null; if (latest === c && c.state === 'running') end(c, 'watchdog'); }, wait);
    pool.configure(draft.seedText, draft.params).then((ready) => {
      if (latest !== c) return;
      c.poolEpoch = ready.epoch;
      sourceEpoch = ready.epoch;
      error = null;
      canvas.setSource(ready.epoch, c.seedKey, ready.stageHashes);
      refresh();
    }, (e: unknown) => {
      if (latest !== c) return;
      if (!(e instanceof JobCancelled)) error = messageOf(e);
      end(c, 'failed');
    });
  };

  return {
    change(draft, ch, inputAt) {
      gesture = ch.gesture;
      const e = draft.sessionEpoch;
      const c = latest;
      const running = c !== null && c.state === 'running';
      const shown = c !== null && c.state !== 'failed' ? c.sessionEpoch : null;
      if (e === shown) slot = null;
      else if (!ch.urgent && slot !== null && slot.draft.sessionEpoch === e) { /* the slot already holds this draft */ }
      else if (!running) start(draft, !ch.urgent, inputAt);
      else if (ch.urgent && c.byGesture) { slot = null; start(draft, false, inputAt); }
      else slot = { draft, urgent: ch.urgent, inputAt };
      refresh();
    },
    previewProgress(poolEpoch, nearestDrawn, visible) {
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
  };
}

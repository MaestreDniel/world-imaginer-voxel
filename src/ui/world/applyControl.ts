/**
 * When a draft is applied to the world (SP4c spec §4.3, D4), on the model of SP4b's live render distance: one control,
 * the change kept as state and acted on at the next frame, latest wins.
 *
 * - The control keeps the latest `Configured` the configure driver reports (`onConfigured`) and records the session's
 *   last change time itself (`subscribe`, every change including a gesture's boundaries).
 * - Once per frame (`tick`, the frame step's `beforeUpdate`) it applies the kept `Configured` when all hold: its
 *   `poolEpoch` is the pool's `epoch` (no newer configure was issued), `driver.status.queued` is false (no newer draft
 *   waits in the driver's slot), the session is not inside a gesture, its `sessionEpoch` is the session's epoch, and
 *   `quietMs` (150) passed since the session's last change.
 * - Applying: `from = regenFrom(applied, next)`; `beforeApply(from)` (true in SP4c: SP5's fork dialog suspends
 *   auto-apply there, master §2.7 (b)); `from === null` → `coordinator.adopt(poolEpoch)` (the same world: nothing
 *   rebuilds), else `coordinator.apply({ epoch: epochs.of(genKey), generation: poolEpoch, from })`; then `applied` and
 *   `generation` move to it, `onApplied({ from })` runs (Watch live, the URL, the undo notice) and the kept `Configured`
 *   is dropped, so later ticks do nothing until the next one is reported.
 * - A burst keeps the last: a drag's drafts wait for the gesture's end; urgent changes in quick succession (Ctrl+Z
 *   held) are collapsed by the driver's slot and the quiet window; any Apply supersedes an earlier one at once.
 *
 * `tick` at rest is a few scalar compares (SP4b D25, spec §4.10): the applied draft of a `Configured` is built when it is
 * reported, never in the frame.
 *
 * The aux policy (spec §6.2, D11) lives here too, since it reads the control's `generation`: the page's frame step calls
 * `updateAuxPolicy` after the coordinator's counts on every tick.
 */
import type { Coordinator, CoordinatorCounts } from '../../engine/coordinator';
import { appliedDraftOf, regenFrom, type AppliedDraft, type WorldStage } from '../../engine/invalidation';
import type { WorldSession } from '../../engine/session';
import type { AuxFirst, WorkerPool } from '../../engine/workerPool';
import type { Configured, PreviewDriver } from '../map/previewDriver';

/** The quiet window after the session's last change before a draft is applied (spec §4.3, D4), ms. */
export const APPLY_QUIET_MS = 150;

/**
 * The per-column epoch's interning (spec §4.4): a session-wide map from a genKey's hex to a small integer, from 1 (the
 * first entry's draft), one entry per distinct world applied.
 */
export function createEpochs(): { of(genKeyHex: string): number } {
  const ids = new Map<string, number>();
  return {
    of(k) {
      let e = ids.get(k);
      if (e === undefined) {
        e = ids.size + 1;
        ids.set(k, e);
      }
      return e;
    },
  };
}

export interface ApplyControlOptions {
  readonly coordinator: Pick<Coordinator, 'apply' | 'adopt'>;
  readonly driver: Pick<PreviewDriver, 'onConfigured' | 'status'>;
  readonly session: Pick<WorldSession, 'state' | 'inGesture' | 'subscribe'>;
  readonly pool: Pick<WorkerPool, 'epoch'>;
  readonly clock: { now(): number };
  readonly epochs: { of(k: string): number };
  /** The world's first draft: `appliedDraftOf(draftOf(session.state).seedKey, firstReady)`. */
  readonly initial: AppliedDraft;
  /** The first configure's pool epoch (`workers.epoch` at the reveal). */
  readonly initialGeneration: number;
  /** Default `APPLY_QUIET_MS`. */
  readonly quietMs?: number;
  /** Called before each Apply or adopt with its `from`; false holds it (SP5's fork dialog). SP4c: always true. */
  beforeApply(from: WorldStage | null): boolean;
  /** Called once per Apply or adopt, after the coordinator heard of it. */
  onApplied(a: { readonly from: WorldStage | null }): void;
}

export interface ApplyControl {
  /** Once per frame, before `coordinator.update`. */
  tick(): void;
  /** The draft the world shows (or is regenerating toward). */
  readonly applied: AppliedDraft;
  /** The pool epoch of the applied draft: `initialGeneration` until the first Apply or adopt. */
  readonly generation: number;
  /** Unsubscribes from the driver and the session; later ticks do nothing. */
  dispose(): void;
}

export function createApplyControl(o: ApplyControlOptions): ApplyControl {
  const quietMs = o.quietMs ?? APPLY_QUIET_MS;
  const { coordinator, driver, session, pool, clock } = o;
  let applied = o.initial;
  let generation = o.initialGeneration;
  /** The latest reported configure and its applied draft (built here, never in `tick`). */
  let next: Configured | null = null;
  let nextDraft: AppliedDraft | null = null;
  let lastChange = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const offConfigured = driver.onConfigured((c) => {
    next = c;
    nextDraft = appliedDraftOf(c.seedKey, c.ready);
  });
  const offSession = session.subscribe(() => { lastChange = clock.now(); });

  return {
    tick() {
      const c = next;
      const draft = nextDraft;
      if (disposed || c === null || draft === null) return;
      if (c.poolEpoch !== pool.epoch || driver.status.queued || session.inGesture) return;
      if (c.sessionEpoch !== session.state.epoch || clock.now() - lastChange < quietMs) return;
      const from = regenFrom(applied, draft);
      if (!o.beforeApply(from)) return;
      if (from === null) coordinator.adopt(c.poolEpoch);
      else coordinator.apply({ epoch: o.epochs.of(draft.genKey), generation: c.poolEpoch, from });
      applied = draft;
      generation = c.poolEpoch;
      next = null;
      nextDraft = null;
      o.onApplied({ from });
    },
    get applied() { return applied; },
    get generation() { return generation; },
    dispose() {
      if (disposed) return;
      disposed = true;
      next = null;
      nextDraft = null;
      offConfigured();
      offSession();
    },
  };
}

/**
 * Which lane a free worker serves first (spec §6.2): the world held (the pool holds a draft the world has not applied)
 * or the map covering the 3D → the aux lane; else the world.
 */
export function auxFirst(held: boolean, covers: boolean): AuxFirst {
  return held || covers ? 'aux' : 'world';
}

/**
 * The cap on non-interactive aux jobs (spec §6.2): held → n (the world issues nothing, so the map takes every worker);
 * covers → n − 1, at least 1 (one worker left to the world); else 1 while a current-epoch T is pending, n otherwise
 * (master §4.3's MAP ≤ 1 while any T is pending within RD).
 */
export function auxCap(held: boolean, covers: boolean, tPending: boolean, n: number): number {
  if (held) return n;
  if (covers) return Math.max(1, n - 1);
  return tPending ? 1 : n;
}

/**
 * The page's frame-step `afterCounts` (spec §6.2): `pool.setAuxPolicy(first, cap)` with `held = pool.epoch !==
 * generation` (the apply control's), `covers` (the overlay full and shown), T pending from the counts and n the pool's
 * live workers (`liveWorkers()`, as the coordinator's caps: after a non-fatal worker death, n − 1 still leaves one live
 * worker to the world, D11). Scalars only; the pool ignores unchanged values.
 */
export function updateAuxPolicy(
  pool: Pick<WorkerPool, 'epoch' | 'liveWorkers' | 'setAuxPolicy'>,
  generation: number,
  covers: boolean,
  counts: CoordinatorCounts,
): void {
  const held = pool.epoch !== generation;
  const tPending = counts.T.done < counts.T.needed;
  pool.setAuxPolicy(auxFirst(held, covers), auxCap(held, covers, tPending, pool.liveWorkers()));
}

/**
 * Whether the map covers the 3D (spec §6.2): the overlay full screen and shown. Before the first M there is no overlay,
 * and the 3D is visible.
 */
export function coversWorld(overlay: { readonly mode: 'full' | 'split'; readonly shown: boolean } | null): boolean {
  return overlay !== null && overlay.mode === 'full' && overlay.shown;
}

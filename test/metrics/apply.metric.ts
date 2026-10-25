import { expect } from 'vitest';
import { colKey } from '../../src/core/coords';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { STAGE_BONUS, streamScore } from '../../src/core/streamScore';
import {
  createCoordinator, createCoordinatorCounts, worldJobsOf, type Coordinator, type CoordinatorJobs, type StreamCamera,
  type StreamEvent, type StreamStore,
} from '../../src/engine/coordinator';
import { appliedDraftOf } from '../../src/engine/invalidation';
import type { Stage } from '../../src/engine/rings';
import { createThrottle } from '../../src/engine/throttle';
import { createUploadBudget } from '../../src/engine/uploadBudget';
import { createWorkerPool } from '../../src/engine/workerPool';
import { createMaterialSystem } from '../../src/render/materials/index';
import { RELEASE_SHARE } from '../../src/render/regionGrid';
import {
  createRevealProbe, createSectionRenderer, createSectionRendererCounts, type SectionRendererKind, type UploadGate,
} from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { createPreviewDriver, createReplayingCanvas, draftOf } from '../../src/ui/map/previewDriver';
import { createApplyControl, createEpochs, updateAuxPolicy } from '../../src/ui/world/applyControl';
import { RECLAIM_THREADS } from '../../src/world/store/reclaim';
import { createStore } from '../../src/world/store/store';
import { inProcessWorker } from '../harness/inProcessPool';
import { currentTier, metricTest } from '../harness/metric';

/**
 * R7's Apply part (SP4c spec §8.1-§8.2, D21; master §6.4): scripted terrain edits, an undo, a no-op edit and a teleport
 * in Node over the real streaming path and the real Apply path, read by SP4b's probe of three's objects.
 *
 * - **The run**, once per section renderer (`createSectionRenderer('batch' | 'mesh', …)` with three and no
 *   `WebGLRenderer`), as SP4b's `stream.metric.ts`: a shared store, `createWorkerPool(2, inProcessWorker)` over the real
 *   task handler, the real coordinator with a throttle that is never fed, every proto kept, strict until the first fill's
 *   reveal; plus the real `WorldSession` (`openMapSession`, seed 42, the default profile), the real configure driver
 *   over a replaying canvas with no preview wanted (the world before the first M: it adopts the first configure and is
 *   fed every session change, as the page's `followSession`), the real apply control and `createEpochs`, all on one fake
 *   clock: 16 ms per frame, plus 0.05 ms per row the renderer spends (uploaded or released) behind the page's upload
 *   budgets (the loading screen's 12 ms with no row cap for the first entry, then `MEDIUM`'s). The driver's timers run
 *   on that clock at the start of each frame.
 * - **A frame** is the page's: the fake clock's 16 ms (and the timers due), `apply.tick`, `update`, one turn of the event
 *   loop (the in-process workers reply on `setTimeout(0)`), the counts and the aux policy with the map hidden
 *   (`updateAuxPolicy`, the page's `afterCounts`), one `pump` from the last rebuild's centre and yaw, the store's
 *   `drain()` and one probe. The camera stays at yaw 0.
 * - **The script**, RD 6 on the quick and full tiers: E0 the first entry at the spawn (reveals held) until `firstFill`
 *   with every staged column uploaded, its reveal, 20 idle frames; E1 one gesture setting `density.detailAmpHi` to 2.0,
 *   3.0 and 4.0 at the start of three consecutive frames, then its end, until the Apply came and every MESH-set column
 *   shows the applied epoch (the counts' `stale` 0, `firstFill`, every staged column uploaded); E2 an undo, until the
 *   world is back at epoch 1 by the same test; E3 one gesture setting the leaf to 2.0, then to 1.5 (the applied value),
 *   its end, then 60 frames; E4 a teleport 640 columns east (10,240 blocks; a multiple of the torus, so every new T
 *   waits on the record of an old column) until the disc refills. **The fast tier** runs E0, E1 and E4 only, at RD 4
 *   (spec §9: `metrics-fast` does not grow).
 * - **Parts** (gated, max 0, over E1-E4, summed over both renderers): `applyPartialColumnFrames`, the frames whose
 *   probe saw a shown column with some but not all of a payload's non-empty rows visible (`partial`), and
 *   `mixedEpochFrames`, the frames whose probe saw a column showing rows of two seqs (`mixed`).
 * - **Asserted in each run:** every world job issued while the pool's generation (`jobs.generation()`) is one the world
 *   applied or adopted (the first configure's, or an Apply's or adopt's; the drafts' own generations are not named,
 *   since the driver's latest-wins slot decides which of them are configured at all); `staleReveals` 0 (no payload
 *   staged before an Apply is revealed after it: `onColumnRevealed` against the Apply count at its `stage`); E1 and E2
 *   each apply once, at epochs 2 and 1, and E3 adopts once and frees and stages nothing; the first 16 T jobs after the
 *   teleport are nearest-first in the (score, colKey) order from the new camera (SP4b's rule); no fatal, skipped or
 *   StoreFull event and no failed column; the release rows of every pump that began with an upload waiting ≤ 16
 *   (`RELEASE_SHARE`, imported, SP4c spec §5.4; no pump of this script begins with an upload waiting and releases
 *   queued, so `releaseRowsPerPumpMax` reads 0 on every tier and D10's share is pinned by `regionGrid.test.ts` and the
 *   contract suite, final review REN-1/GOV-4); and at the end, after disposing the coordinator and every job settled, every
 *   thread's limbo drains (bounded, 5 s) and every pool slot is free.
 * - **Recorded:** `framesE0` … `framesE4`, `swaps` (reveals of a payload staged over a shown column), `frees` (the
 *   coordinator's column frees over E1-E4), `applyFirstSwapFrames` (the E1 Apply's frame to the first swap within 2
 *   columns of the camera), `applyFullFrames` (the E1 Apply's frame to the settled world), the same two for the E2
 *   undo (`undoFirstSwapFrames`, `undoFullFrames`; quick and full), `teleportFirstRevealFrames` (the teleport to the
 *   first reveal within the new disc), `structuralOps`, `rowsPerPumpMax` (after the reveal), `releaseRowsPerPumpMax`
 *   (pumps that began with an upload waiting), `releasedRows` (every row released after the reveal), `dropped` (results the coordinator dropped at intake, as SP4b's: the
 *   MESH results of an older epoch and the teleport's in-flight ones), `applies`, `adopts` and `staleReveals`. Counts are
 *   summed over both renderers; frame latencies and per-pump maxima are the larger of the two.
 */
const MiB = 1 << 20;
const TIER = currentTier();
const FAST = TIER === 'fast';
/** The render distance (spec §8.1). */
const RD = FAST ? 4 : 6;
/** The fake clock: one row the renderer spends, one frame (ms, spec §8.1). */
const ROW_MS = 0.05;
const FRAME_MS = 16;
/** The loading screen's upload budget (ms; `worldPage.ts`'s `LOAD_UPLOAD_MS`). */
const LOAD_UPLOAD_MS = 12;
/** The leaf the edits move (terrain scope) and its values (spec §8.1); 1.5 is the default profile's. */
const AMP = 'density.detailAmpHi';
const E1_VALUES: readonly number[] = [2.0, 3.0, 4.0];
const APPLIED_AMP = 1.5;
/** Idle frames after the reveal, frames after E3's gesture, the teleport in columns (10,240 blocks). */
const IDLE_FRAMES = 20;
const NOOP_FRAMES = 60;
const TELEPORT_COLUMNS = 640;
/** A leg that has not settled after this many frames is a stall: the run fails. */
const SETTLE_FRAMES_MAX = 20_000;
/** The T jobs after the teleport whose order is asserted (SP4b's rule, §3.5: 16 frees per frame). */
const FIRST_T_AFTER_TELEPORT = 16;
/** "Near the player" for the first swap (spec §8.1): within this many columns of the camera's, on both axes. */
const NEAR_COLUMNS = 2;

/** One job the coordinator issued, in issue order. */
interface Issued {
  readonly stage: Stage;
  readonly cx: number;
  readonly cz: number;
  readonly protoOnly: boolean;
}

/** One renderer's run. */
interface Run {
  frames: number[];
  applyPartialColumnFrames: number;
  mixedEpochFrames: number;
  swaps: number;
  frees: number;
  applyFirstSwapFrames: number;
  applyFullFrames: number;
  undoFirstSwapFrames: number;
  undoFullFrames: number;
  teleportFirstRevealFrames: number;
  structuralOps: number;
  rowsPerPumpMax: number;
  releaseRowsPerPumpMax: number;
  releasedRows: number;
  dropped: number;
  applies: number;
  adopts: number;
  staleReveals: number;
}

/** A fake clock with timers (the driver's watchdog), run in time order up to the clock's time by `runDue`. */
function fakeClock() {
  const t = Float64Array.of(0);
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => t[0]!,
    advance(ms: number): void { t[0] = t[0]! + ms; },
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: t[0]! + ms, fn });
      return id;
    },
    clearTimeout(id: number): void { timers.delete(id); },
    runDue(): void {
      for (;;) {
        let best: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= t[0]! && (best === null || e[1].at < best[1].at)) best = e;
        if (best === null) return;
        timers.delete(best[0]);
        best[1].fn();
      }
    },
  };
}

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function edit(kind: SectionRendererKind): Promise<Run> {
  const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
  const pool = createWorkerPool(2, inProcessWorker, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  const sections = createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight }, createFlatColorArray()));
  const disposers: Array<() => void> = [];
  try {
    await pool.attachStore(store.handles());
    // The page's session (seed 42, the default profile) and its first configure (SP4c spec §4.2).
    const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
    expect(session.state.params.density.detailAmpHi, 'the default profile\'s detail amplitude').toBe(APPLIED_AMP);
    const firstReady = await pool.configure(session.state.seedText, session.state.params);
    expect(firstReady.type).toBe('ready');
    const spawn = await pool.spawn();

    const run: Run = {
      frames: [0, 0, 0, 0, 0], applyPartialColumnFrames: 0, mixedEpochFrames: 0, swaps: 0, frees: 0,
      applyFirstSwapFrames: -1, applyFullFrames: -1, undoFirstSwapFrames: -1, undoFullFrames: -1, teleportFirstRevealFrames: -1,
      structuralOps: 0, rowsPerPumpMax: 0, releaseRowsPerPumpMax: 0, releasedRows: 0, dropped: 0, applies: 0, adopts: 0, staleReveals: 0,
    };
    const clock = fakeClock();
    const issued: Issued[] = [];
    const events: StreamEvent[] = [];
    /** The generations the world applied or adopted (the first configure's included). */
    const generations = new Set<number>([pool.epoch]);
    const badGenerations: number[] = [];
    let inFlight = 0;
    const inner = worldJobsOf(pool);
    const jobs: CoordinatorJobs = {
      run(stage, cx, cz, protoOnly) {
        const g = inner.generation();
        if (!generations.has(g)) badGenerations.push(g);
        issued.push({ stage, cx, cz, protoOnly });
        inFlight++;
        const job = inner.run(stage, cx, cz, protoOnly);
        job.then(() => { inFlight--; }, () => { inFlight--; });
        return job;
      },
      cancel: (pred) => inner.cancel(pred),
      liveWorkers: () => inner.liveWorkers(),
      generation: () => inner.generation(),
    };
    let leg = 0;
    let measuring = false;
    const streamStore: StreamStore = {
      versionsInto: (cx, cz, out) => store.versionsInto(cx, cz, out),
      holder: (cx, cz) => store.holder(cx, cz),
      freeColumn(cx, cz) {
        if (measuring) run.frees++;
        store.freeColumn(cx, cz);
      },
      freeProto: (cx, cz) => store.freeProto(cx, cz),
    };
    /** Per column, the Apply count when its last payload was staged, and whether it was staged over a shown one. */
    const staged = new Map<number, { readonly applies: number; readonly swap: boolean }>();
    let stagesInLeg = 0;
    const coordinator = createCoordinator({
      jobs,
      store: streamStore,
      sink: {
        stage(p, seq) {
          stagesInLeg++;
          // Recorded before the call: a replacement with no non-empty row is revealed inside it.
          staged.set(colKey(p.cx, p.cz), { applies: run.applies, swap: sections.isRevealed(p.cx, p.cz) });
          sections.stage(p, seq);
        },
        unstage: (cx, cz) => sections.unstage(cx, cz),
        remove: (cx, cz) => sections.remove(cx, cz),
      },
      throttle: createThrottle({ max: Math.max(1, pool.size - 1) }),
      rd: RD,
      rdMax: RD,
      retainAllProtos: true,
      strict: true,
      generation: pool.epoch,
      epoch: 1,
      onEvent: (e) => { events.push(e); },
    });
    disposers.push(() => coordinator.dispose());
    const epochs = createEpochs();
    expect(epochs.of(firstReady.genKey), 'the first draft\'s epoch').toBe(1);

    // The camera's column; the reveal hooks read it.
    let cx = Math.floor(spawn.x / 16);
    let cz = Math.floor(spawn.z / 16);
    /** The frame of the last Apply (or the teleport), and the first near swap (or reveal) since, in frames after it. */
    let markFrame = -1;
    let firstNear = -1;
    let teleported = false;
    let frameIndex = 0;
    sections.onColumnRevealed = (x, z) => {
      const s = staged.get(colKey(x, z));
      if (s !== undefined && s.applies < run.applies) run.staleReveals++;
      if (!measuring) return;
      if (s?.swap === true) run.swaps++;
      if (firstNear < 0 && markFrame >= 0) {
        const near = teleported ? Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= RD : s?.swap === true && Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= NEAR_COLUMNS;
        if (near) firstNear = frameIndex - markFrame;
      }
    };
    sections.holdReveals(true);

    // The fake clock's rows: the budget reads the clock, and every row the renderer spends advances it by ROW_MS. The
    // rows a pump releases are told from its uploads by the renderer's row count, read at the `exhausted()` that precedes
    // every spent row (`regionGrid.ts`'s pump: releases count −1, uploads +1, each followed by one `spend(1)`).
    let budget = createUploadBudget(LOAD_UPLOAD_MS, Number.POSITIVE_INFINITY, clock.now);
    const rowCounts = createSectionRendererCounts();
    let rowsMark = 0;
    let releasedThisPump = 0;
    const gate: UploadGate = {
      exhausted() {
        rowsMark = sections.counts(rowCounts).rows;
        return budget.exhausted();
      },
      spend(n) {
        if (sections.counts(rowCounts).rows < rowsMark) releasedThisPump += n;
        clock.advance(ROW_MS * n);
        budget.spend(n);
      },
      structural: () => budget.structural(),
    };
    const counts = createCoordinatorCounts();
    const uploads = createSectionRendererCounts();
    const probe = createRevealProbe();
    let flying = false;

    const failure = (): string | null => {
      const e = events.find((x) => x.kind !== 'storeFull' && x.kind !== 'skipped') ?? events[0];
      if (e === undefined) return null;
      return e.kind === 'fatal' ? `fatal: ${e.message}` : e.kind === 'skipped' ? `skipped (${e.cx}, ${e.cz})` : `storeFull (lower to ${e.lowerRd})`;
    };
    const pump = (): void => {
      sections.counts(uploads);
      const waiting = uploads.columnsStaged > uploads.columnsComplete;
      releasedThisPump = 0;
      budget.start();
      const rows = sections.pump(gate, counts.cx, counts.cz, counts.yawDeg);
      if (flying) {
        if (rows > run.rowsPerPumpMax) run.rowsPerPumpMax = rows;
        run.releasedRows += releasedThisPump;
        if (waiting && releasedThisPump > run.releaseRowsPerPumpMax) run.releaseRowsPerPumpMax = releasedThisPump;
      }
      if (waiting) expect(releasedThisPump, `${kind}: rows released by a pump while an upload waits`).toBeLessThanOrEqual(RELEASE_SHARE);
    };
    const filled = (): boolean => coordinator.firstFill() && sections.counts(uploads).columnsComplete === uploads.columnsStaged;
    const cam = (): StreamCamera => ({ x: cx * 16 + 8, z: cz * 16 + 8, yawDeg: 0 });

    // The first entry at the spawn, reveals held (SP4b spec §3.11), as SP4b's: no apply control yet.
    let tick = (): void => {};
    let generation = (): number => pool.epoch;
    /** One frame (spec §8.1). */
    const frame = async (): Promise<void> => {
      clock.advance(FRAME_MS);
      clock.runDue();
      tick();
      coordinator.update(cam());
      await turn();
      const f = failure();
      if (f !== null) throw new Error(`${kind}: ${f}`);
      coordinator.counts(counts);
      updateAuxPolicy(pool, generation(), false, counts);
      pump();
      store.drain();
      sections.probe(probe);
      run.frames[leg] = run.frames[leg]! + 1;
      frameIndex++;
      if (measuring) {
        if (probe.partial > 0) run.applyPartialColumnFrames++;
        if (probe.mixed > 0) run.mixedEpochFrames++;
      }
    };
    /** Frames until `done` holds after one, at most SETTLE_FRAMES_MAX. */
    const until = async (done: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < SETTLE_FRAMES_MAX; i++) {
        await frame();
        if (done()) return;
      }
      throw new Error(`${kind}: ${what}: not settled after ${SETTLE_FRAMES_MAX} frames`);
    };
    /** Every MESH-set column shows the applied epoch `epoch`: no stale column, every MESH column meshed and uploaded. */
    const settledAt = (epoch: number): boolean => {
      coordinator.counts(counts);
      return counts.epoch === epoch && counts.stale === 0 && filled();
    };

    // E0: the first entry, its reveal, 20 idle frames.
    await until(filled, 'the first entry');
    flying = true;
    budget = createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, clock.now);
    pump();
    sections.revealAll();
    sections.holdReveals(false);
    coordinator.setStrict(false);

    // The world's configure owner and apply control from the reveal on (SP4c spec §4.2-§4.3), as the page wires them.
    const relay = createReplayingCanvas();
    const driver = createPreviewDriver(pool, relay, clock, { spawnPriority: 600 });
    disposers.push(() => driver.dispose());
    driver.setPreviewWanted(false);
    driver.adopt({ poolEpoch: pool.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready: firstReady });
    // The page's `followSession` before the first M: every session change goes to the driver.
    disposers.push(session.subscribe((s, change) => driver.change(draftOf(s), change, clock.now())));
    /** The epoch and generation of each Apply, in order. */
    const applied: Array<{ readonly epoch: number; readonly generation: number }> = [];
    const watched: Pick<Coordinator, 'apply' | 'adopt'> = {
      apply(a) {
        generations.add(a.generation);
        run.applies++;
        applied.push({ epoch: a.epoch, generation: a.generation });
        markFrame = frameIndex;
        firstNear = -1;
        coordinator.apply(a);
      },
      adopt(g) {
        generations.add(g);
        run.adopts++;
        coordinator.adopt(g);
      },
    };
    const control = createApplyControl({
      coordinator: watched,
      driver,
      session,
      pool,
      clock,
      epochs,
      initial: appliedDraftOf(draftOf(session.state).seedKey, firstReady),
      initialGeneration: pool.epoch,
      beforeApply: () => true,
      onApplied: () => {},
    });
    disposers.push(() => control.dispose());
    tick = () => control.tick();
    generation = () => control.generation;
    for (let i = 0; i < IDLE_FRAMES; i++) await frame();

    // E1: one gesture over three frames, its end, until the Apply and every MESH-set column at its epoch.
    leg = 1;
    measuring = true;
    session.beginGesture();
    for (const v of E1_VALUES) {
      expect(session.set(AMP, v).ok, `${AMP} = ${v}`).toBe(true);
      await frame();
    }
    session.endGesture();
    await until(() => run.applies === 1 && settledAt(applied[0]!.epoch), 'E1');
    expect(applied.map((a) => a.epoch), `${kind}: E1's Apply`).toEqual([2]);
    run.applyFirstSwapFrames = firstNear;
    run.applyFullFrames = frameIndex - markFrame;

    if (!FAST) {
      // E2: an undo, until the world is back at the first epoch.
      leg = 2;
      expect(session.undo()).toBe(true);
      await until(() => run.applies === 2 && settledAt(1), 'E2');
      expect(applied.map((a) => a.epoch), `${kind}: E2's Apply`).toEqual([2, 1]);
      run.undoFirstSwapFrames = firstNear;
      run.undoFullFrames = frameIndex - markFrame;

      // E3: a no-op gesture (2.0, then the applied 1.5), its end, 60 frames: adopted, nothing freed or staged.
      leg = 3;
      const freesBefore = run.frees;
      const adoptsBefore = run.adopts;
      stagesInLeg = 0;
      session.beginGesture();
      expect(session.set(AMP, 2.0).ok).toBe(true);
      await frame();
      expect(session.set(AMP, APPLIED_AMP).ok).toBe(true);
      await frame();
      session.endGesture();
      for (let i = 0; i < NOOP_FRAMES; i++) await frame();
      expect([run.applies, run.adopts - adoptsBefore], `${kind}: E3's Applies and adopts`).toEqual([2, 1]);
      expect([run.frees - freesBefore, stagesInLeg], `${kind}: E3's frees and stages`).toEqual([0, 0]);
      expect(settledAt(1), `${kind}: E3 leaves the world settled at epoch 1`).toBe(true);
    }

    // E4: the teleport, until the disc refills; the T jobs issued from the teleport's update on.
    leg = 4;
    const mark = issued.length;
    cx += TELEPORT_COLUMNS;
    teleported = true;
    markFrame = frameIndex;
    firstNear = -1;
    await until(filled, 'the teleport');
    run.teleportFirstRevealFrames = firstNear;
    const ts = issued.slice(mark).filter((j) => j.stage === 'T' && !j.protoOnly);
    const key = (j: Issued): number => streamScore(j.cx - cx, j.cz - cz, 0, -1, STAGE_BONUS.T);
    const order = (a: Issued, b: Issued): number => key(a) - key(b) || colKey(a.cx, a.cz) - colKey(b.cx, b.cz);
    const first = ts.slice(0, FIRST_T_AFTER_TELEPORT);
    expect(first.length, `${kind}: T jobs after the teleport`).toBe(FIRST_T_AFTER_TELEPORT);
    expect(first, `${kind}: the first T jobs after the teleport, nearest-first`).toEqual([...first].sort(order));
    coordinator.counts(counts);

    measuring = false;
    run.dropped = counts.dropped;
    run.structuralOps = sections.counts(uploads).structuralOps;
    expect(badGenerations, `${kind}: world jobs issued at a generation the world neither applied nor adopted`).toEqual([]);
    expect(run.staleReveals, `${kind}: payloads staged before an Apply and revealed after it`).toBe(0);
    expect([counts.failed, counts.storeFull, events.length], `${kind}: failed columns, StoreFull errors, events`).toEqual([0, 0, 0]);

    // Unload everything: every job settles, every thread's limbo drains, and every pool slot is free.
    control.dispose();
    driver.dispose();
    coordinator.dispose();
    disposers.length = 0;
    const settleEnd = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < settleEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(inFlight, `${kind}: world jobs still in flight after dispose`).toBe(0);
    const limbo = (): number[] => Array.from({ length: RECLAIM_THREADS }, (_, t) => store.limboCount(t));
    const limboEnd = Date.now() + 5000;
    while (limbo().some((n) => n > 0) && Date.now() < limboEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(limbo(), `${kind}: limbo after dispose`).toEqual(new Array(RECLAIM_THREADS).fill(0));
    expect([store.blockPool.freeCount(), store.bytePool.freeCount()], `${kind}: free pool slots`).toEqual([store.blockPool.slotCount(), store.bytePool.slotCount()]);
    return run;
  } finally {
    for (const d of disposers.reverse()) d();
    pool.terminate();
    sections.dispose();
  }
}

metricTest('R7', ['applyPartialColumnFrames', 'mixedEpochFrames'], async () => {
  const runs = [await edit('batch'), await edit('mesh')];
  const sum = (f: (r: Run) => number): number => runs.reduce((s, r) => s + f(r), 0);
  const max = (f: (r: Run) => number): number => Math.max(...runs.map(f));
  const legs: Record<string, number> = {};
  for (let i = 0; i < 5; i++) if (!FAST || i === 0 || i === 1 || i === 4) legs[`framesE${i}`] = sum((r) => r.frames[i]!);
  return {
    applyPartialColumnFrames: sum((r) => r.applyPartialColumnFrames),
    mixedEpochFrames: sum((r) => r.mixedEpochFrames),
    ...legs,
    swaps: sum((r) => r.swaps),
    frees: sum((r) => r.frees),
    applyFirstSwapFrames: max((r) => r.applyFirstSwapFrames),
    applyFullFrames: max((r) => r.applyFullFrames),
    ...(FAST ? {} : { undoFirstSwapFrames: max((r) => r.undoFirstSwapFrames), undoFullFrames: max((r) => r.undoFullFrames) }),
    teleportFirstRevealFrames: max((r) => r.teleportFirstRevealFrames),
    structuralOps: sum((r) => r.structuralOps),
    rowsPerPumpMax: max((r) => r.rowsPerPumpMax),
    releaseRowsPerPumpMax: max((r) => r.releaseRowsPerPumpMax),
    releasedRows: sum((r) => r.releasedRows),
    dropped: sum((r) => r.dropped),
    applies: sum((r) => r.applies),
    adopts: sum((r) => r.adopts),
    staleReveals: sum((r) => r.staleReveals),
  };
}, 600_000, { outName: 'R7.apply' });

import { expect } from 'vitest';
import { colKey } from '../../src/core/coords';
import { DEFAULTS } from '../../src/core/params/defaults';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { STAGE_BONUS, streamScore } from '../../src/core/streamScore';
import {
  createCoordinator, createCoordinatorCounts, worldJobsOf, type CoordinatorJobs, type StreamCamera, type StreamEvent,
} from '../../src/engine/coordinator';
import type { Stage } from '../../src/engine/rings';
import { createThrottle } from '../../src/engine/throttle';
import { createUploadBudget } from '../../src/engine/uploadBudget';
import { createWorkerPool } from '../../src/engine/workerPool';
import { createMaterialSystem } from '../../src/render/materials/index';
import {
  createRevealProbe, createSectionRenderer, createSectionRendererCounts, type SectionRendererKind, type UploadGate,
} from '../../src/render/sectionRenderer';
import { createFlatColorArray } from '../../src/render/textureArray';
import { createStore } from '../../src/world/store/store';
import { inProcessWorker } from '../harness/inProcessPool';
import { currentTier, metricTest } from '../harness/metric';

/**
 * R7, the atomic reveal while streaming (SP4b spec §8.1-§8.2, D24; master §6.4): a scripted flight in Node over the
 * real streaming path, read by a probe of three's objects that is independent of the renderer's own state.
 *
 * - **The run**, once per section renderer (`createSectionRenderer('batch' | 'mesh', …)` with three and no
 *   `WebGLRenderer`, as the contract suite): a shared store, `createWorkerPool(2, inProcessWorker)` over the real task
 *   handler (`test/harness/inProcessPool.ts`), seed '42' with the default profile, the real coordinator with a throttle
 *   that is never fed (Node has no frame time, so `genCap` stays at its maximum, max(1, N − 1) = 1), every proto kept
 *   (`retainAllProtos`, the page's setting), strict until the first fill's reveal; a fake clock that advances 0.05 ms
 *   per row the renderer spends (uploaded or released) behind the page's upload budgets: the loading screen's
 *   (12 ms, no row cap) for the first entry, as the page (§3.11), then the flying one (`createUploadBudget(2, 32, now)`,
 *   `MEDIUM.uploadBudgetMs` and `uploadSections`).
 * - **A frame** is one `update`, one turn of the event loop (the in-process workers reply on `setTimeout(0)`, so each
 *   worker answers about one job a frame and the coordinator's intake runs inside that turn), one `pump` from the last
 *   rebuild's centre and yaw, the store's reclamation drain (the page's step 5, §7.2) and one probe.
 * - **The script** (RD 6 on the quick and full tiers, RD 4 on the fast tier): the first entry at seed 42's spawn
 *   (reveals held) until every MESH column is meshed and uploaded, and its reveal; 60 frames east at one column per two
 *   frames; a 90° turn (to north); 60 frames north at one column per frame (faster than the pool fills: holes and late
 *   reveals); a jump of 64 columns west (record collisions: a new T waits where the retained column 64 columns east
 *   still holds its torus record, about 10 per run, since the north leg outran the pool and left most of those records
 *   free; final review GOV-2) until the disc refills; quick and full: RD 6 → 4 for 20 frames, then 6 until refilled;
 *   fast: RD 4 → 5 until refilled, then 4 for 20 frames. "Refilled" is the first entry's test: every MESH column meshed, every staged column
 *   uploaded.
 * - **The probe** (`SectionRenderer.probe`): for each column the staging lists, its rows' visibility read from three's
 *   objects (RegionBatch: `getVisibleAt` of the instances; RegionMesh: non-degenerate indices, the mesh visible), the
 *   columns showing some but not all of their non-empty rows (`partial`) and those showing rows of two seqs (`mixed`).
 *
 * Values, summed over both renderers: `partialColumnFrames` (gated, max 0: the frames whose probe saw a partial
 * column); recorded: `frames`, `revealed` and `removed` (columns revealed by the renderer, removed by the coordinator),
 * `structuralOps`, `dropped` (results the coordinator dropped at intake; expected 0 apart from the in-flight results of
 * columns that left the window on the jump, rulings R2, so recorded and not asserted) and `droppedOnJump` (those of the
 * jump leg), `collisionWaits` (over the run; the jump leg's own, counted from a snapshot taken before the jump, are
 * asserted > 0 in each run, so the jump leg cannot silently stop testing collisions while an earlier leg keeps the
 * run's count above 0, final review GOV-3),
 * `jumpTOutOfOrder` (the T jobs after the jump issued after one that orders behind them), `mixedColumnFrames` (0 in
 * SP4b: a revealed column is never re-staged; SP4c's Apply part gates the epoch mix, §12.1), `rowsPerPumpMax` and
 * `rowsPerPumpMean` (over the pumps after the reveal, under the flying budget). Each run also asserts that the first 16
 * T jobs after the jump are issued nearest-first, in the (score, colKey) order of §3.3 from the camera's column and yaw
 * (rulings R1; the unload frees records in the score order of the T they unblock, §3.5), that no fatal, skipped or
 * StoreFull event came, and that no column failed.
 */
const MiB = 1 << 20;
const TIER = currentTier();
/** The flight's render distance, and the RD of the live change (spec §8.1). */
const RD = TIER === 'fast' ? 4 : 6;
const RD_CHANGE = TIER === 'fast' ? 5 : 4;
/** The largest RD the run sets (the coordinator's cap). */
const RD_MAX = Math.max(RD, RD_CHANGE);
/** The fake clock's cost of one row (ms, spec §8.1). */
const ROW_MS = 0.05;
/** The loading screen's upload budget (ms; `worldPage.ts`'s `LOAD_UPLOAD_MS`, spec §3.9). */
const LOAD_UPLOAD_MS = 12;
/** The legs (spec §8.1): frames east and north, the jump in columns, frames at the lowered (or restored) RD. */
const EAST_FRAMES = 60;
const NORTH_FRAMES = 60;
const JUMP_COLUMNS = 64;
const RD_HOLD_FRAMES = 20;
/** A "until refilled" leg that has not refilled after this many frames is a stall: the run fails. */
const FILL_FRAMES_MAX = 20_000;
/** The T jobs after the jump whose order is asserted (one second of the unload's frees, §3.5: 16 per frame). */
const FIRST_T_AFTER_JUMP = 16;

/** One job the coordinator issued, in issue order. */
interface Issued {
  readonly stage: Stage;
  readonly cx: number;
  readonly cz: number;
  readonly protoOnly: boolean;
}

/** One renderer's run. */
interface Run {
  frames: number;
  partialColumnFrames: number;
  mixedColumnFrames: number;
  revealed: number;
  removed: number;
  structuralOps: number;
  dropped: number;
  droppedOnJump: number;
  collisionWaits: number;
  jumpTOutOfOrder: number;
  rowsPerPumpMax: number;
  rowsSum: number;
  pumps: number;
}

/** The coordinator's jobs, recorded at issue. */
function recorded(inner: CoordinatorJobs, log: Issued[]): CoordinatorJobs {
  return {
    run(stage, cx, cz, protoOnly) {
      log.push({ stage, cx, cz, protoOnly });
      return inner.run(stage, cx, cz, protoOnly);
    },
    cancel: (pred) => inner.cancel(pred),
    liveWorkers: () => inner.liveWorkers(),
    generation: () => inner.generation(),
  };
}

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function fly(kind: SectionRendererKind): Promise<Run> {
  const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
  const pool = createWorkerPool(2, inProcessWorker, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  const sections = createSectionRenderer(kind, createMaterialSystem({ variant: kind, ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight }, createFlatColorArray()));
  try {
    await pool.attachStore(store.handles());
    expect((await pool.configure('42', DEFAULTS)).type).toBe('ready');
    const spawn = await pool.spawn();

    const run: Run = {
      frames: 0, partialColumnFrames: 0, mixedColumnFrames: 0, revealed: 0, removed: 0, structuralOps: 0, dropped: 0,
      droppedOnJump: 0, collisionWaits: 0, jumpTOutOfOrder: 0, rowsPerPumpMax: 0, rowsSum: 0, pumps: 0,
    };
    const issued: Issued[] = [];
    const events: StreamEvent[] = [];
    const coordinator = createCoordinator({
      jobs: recorded(worldJobsOf(pool), issued),
      store,
      sink: {
        stage: (p, seq) => sections.stage(p, seq),
        // As on the page (SP4c spec §4.4, §5.1); nothing applies here, so the coordinator never calls it.
        unstage: (cx, cz) => sections.unstage(cx, cz),
        remove(cx, cz) {
          run.removed++;
          sections.remove(cx, cz);
        },
      },
      throttle: createThrottle({ max: Math.max(1, pool.size - 1) }),
      rd: RD,
      rdMax: RD_MAX,
      retainAllProtos: true,
      strict: true,
      generation: pool.epoch,
      epoch: 1,
      onEvent: (e) => { events.push(e); },
    });
    sections.onColumnRevealed = () => { run.revealed++; };
    sections.holdReveals(true);

    // The fake clock: the budget reads it, and every row the renderer spends advances it by ROW_MS.
    const clock = Float64Array.of(0);
    const now = (): number => clock[0]!;
    let budget = createUploadBudget(LOAD_UPLOAD_MS, Number.POSITIVE_INFINITY, now);
    const gate: UploadGate = {
      exhausted: () => budget.exhausted(),
      spend(n) {
        clock[0] = clock[0]! + ROW_MS * n;
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
      budget.start();
      const rows = sections.pump(gate, counts.cx, counts.cz, counts.yawDeg);
      if (flying) {
        run.pumps++;
        run.rowsSum += rows;
        if (rows > run.rowsPerPumpMax) run.rowsPerPumpMax = rows;
      }
    };
    /** One frame (spec §8.1): update, one turn of the event loop, pump, the drain, the probe. */
    const frame = async (cam: StreamCamera): Promise<void> => {
      coordinator.update(cam);
      await turn();
      const f = failure();
      if (f !== null) throw new Error(`${kind}: ${f}`);
      coordinator.counts(counts);
      pump();
      store.drain();
      sections.probe(probe);
      run.frames++;
      if (probe.partial > 0) run.partialColumnFrames++;
      if (probe.mixed > 0) run.mixedColumnFrames++;
    };
    const filled = (): boolean => coordinator.firstFill() && sections.counts(uploads).columnsComplete === uploads.columnsStaged;
    const until = async (cam: StreamCamera, what: string): Promise<void> => {
      for (let i = 0; i < FILL_FRAMES_MAX; i++) {
        await frame(cam);
        if (filled()) return;
      }
      throw new Error(`${kind}: ${what}: not refilled after ${FILL_FRAMES_MAX} frames`);
    };
    const cam = (cx: number, cz: number, yawDeg: number): StreamCamera => ({ x: cx * 16 + 8, z: cz * 16 + 8, yawDeg });

    // The first entry at the spawn, reveals held (spec §3.11), then its reveal frame.
    let cx = Math.floor(spawn.x / 16);
    let cz = Math.floor(spawn.z / 16);
    await until(cam(cx, cz, 0), 'the first entry');
    flying = true;
    budget = createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, now);
    pump();
    sections.revealAll();
    sections.holdReveals(false);
    coordinator.setStrict(false);

    // East at one column per two frames (yaw 90: forward +x).
    for (let i = 1; i <= EAST_FRAMES; i++) await frame(cam(cx + (i >> 1), cz, 90));
    cx += EAST_FRAMES >> 1;
    // A 90° turn to the north (yaw 0: forward −z), then north at one column per frame.
    await frame(cam(cx, cz, 0));
    for (let i = 1; i <= NORTH_FRAMES; i++) await frame(cam(cx, cz - i, 0));
    cz -= NORTH_FRAMES;

    // The jump west, until the disc refills; the T jobs issued from the jump's update on.
    const mark = issued.length;
    coordinator.counts(counts);
    const droppedBefore = counts.dropped;
    const collisionsBefore = counts.collisionWaits;
    cx -= JUMP_COLUMNS;
    await until(cam(cx, cz, 0), 'the jump');
    const ts = issued.slice(mark).filter((j) => j.stage === 'T' && !j.protoOnly);
    const key = (j: Issued): number => streamScore(j.cx - cx, j.cz - cz, 0, -1, STAGE_BONUS.T);
    const order = (a: Issued, b: Issued): number => key(a) - key(b) || colKey(a.cx, a.cz) - colKey(b.cx, b.cz);
    const first = ts.slice(0, FIRST_T_AFTER_JUMP);
    for (let i = 1; i < ts.length; i++) if (order(ts[i - 1]!, ts[i]!) > 0) run.jumpTOutOfOrder++;
    expect(first.length, `${kind}: T jobs after the jump`).toBe(FIRST_T_AFTER_JUMP);
    expect(first, `${kind}: the first T jobs after the jump, nearest-first`).toEqual([...first].sort(order));

    coordinator.counts(counts);
    run.droppedOnJump = counts.dropped - droppedBefore;
    // The jump leg's own collisions (not the run's cumulative count, which an earlier leg could keep above 0).
    expect(counts.collisionWaits - collisionsBefore, `${kind}: T jobs after the jump that waited on a record collision`).toBeGreaterThan(0);
    // The live RD change (spec §8.1, §5).
    if (RD_CHANGE < RD) {
      coordinator.setRenderDistance(RD_CHANGE);
      for (let i = 0; i < RD_HOLD_FRAMES; i++) await frame(cam(cx, cz, 0));
      coordinator.setRenderDistance(RD);
      await until(cam(cx, cz, 0), `RD ${RD_CHANGE} → ${RD}`);
    } else {
      coordinator.setRenderDistance(RD_CHANGE);
      await until(cam(cx, cz, 0), `RD ${RD} → ${RD_CHANGE}`);
      coordinator.setRenderDistance(RD);
      for (let i = 0; i < RD_HOLD_FRAMES; i++) await frame(cam(cx, cz, 0));
    }

    coordinator.counts(counts);
    run.dropped = counts.dropped;
    run.collisionWaits = counts.collisionWaits;
    run.structuralOps = sections.counts(uploads).structuralOps;
    expect([counts.failed, counts.storeFull, events.length], `${kind}: failed columns, StoreFull errors, events`).toEqual([0, 0, 0]);
    coordinator.dispose();
    return run;
  } finally {
    pool.terminate();
    sections.dispose();
  }
}

metricTest('R7', ['partialColumnFrames'], async () => {
  const runs = [await fly('batch'), await fly('mesh')];
  const sum = (k: keyof Run): number => runs.reduce((s, r) => s + r[k], 0);
  const pumps = sum('pumps');
  return {
    partialColumnFrames: sum('partialColumnFrames'),
    frames: sum('frames'),
    revealed: sum('revealed'),
    removed: sum('removed'),
    structuralOps: sum('structuralOps'),
    dropped: sum('dropped'),
    droppedOnJump: sum('droppedOnJump'),
    collisionWaits: sum('collisionWaits'),
    jumpTOutOfOrder: sum('jumpTOutOfOrder'),
    mixedColumnFrames: sum('mixedColumnFrames'),
    rowsPerPumpMax: Math.max(...runs.map((r) => r.rowsPerPumpMax)),
    rowsPerPumpMean: pumps > 0 ? sum('rowsSum') / pumps : 0,
  };
});

/**
 * Zero allocation at rest (SP4b spec §3.10, D25, §8.5): without movement or arriving results, the coordinator's
 * `update` and the page's frame step allocate nothing; nor do the frame's parts on their own (the clock with the FPS
 * limiter and the slow-frame notice, the fly step, the upload budget, the GPU estimate the bench reads every frame).
 * Each is warmed up, then measured over N more.
 *
 * SP4c's per-tick additions are inside the same rule (SP4c spec §4.10): the frame step runs, as the world page wires it,
 * the controls-owner check, the apply control's `tick` (at rest: its one adopt made, nothing configured since),
 * `setAuxPolicy` on a real pool with unchanged values, and on rendered frames the map overlay's `tick`, measured with the
 * map hidden and shown in split mode, where the arrow follows the camera through the tool's `setPlayer` (a fake
 * `MapCanvas` over the real `arrowRedrawWanted`). The coordinator's `apply` has its own test. Those hooks are also measured
 * each on its own under the 26 B bound: the frame step's budget has room for a small object per tick.
 *
 * This measures allocation, not retention (the plan's spec correction to §8.5): `terrainHeap.test.ts` runs `gc()`
 * twice before every reading, which collects the short-lived per-call objects D25 bans. Here, after a double `gc()`,
 * the N calls run in `CHUNKS` chunks; before each a minor gc empties the young generation, the heap is read, a
 * `v8.GCProfiler` is started, the chunk's calls run, and the heap is read again with no gc in between. A chunk counts
 * only when the profiler recorded no GC (a scavenge would hide what the calls allocated) and is run again otherwise, up
 * to 3 tries; if every try saw a GC the test fails, since a scavenge during a chunk at rest already means far more
 * allocation than the bound. The chunks' growths are summed over the N calls. Up to 3 attempts, the next one taken when
 * an attempt read over the bound: an allocation in the code repeats on every attempt, while a function TurboFan has not
 * yet installed (it compiles on a background thread, slower under load) reads high once and then settles, the earlier
 * attempts having warmed it up further. The heap is summed without V8's JIT spaces (`code_*`, `trusted_*`: what the
 * compiler installs there depends on its background threads, `terrainHeap.test.ts`); `new_space`, where short-lived
 * objects land, is counted.
 *
 * The bound, 256 KB over N = 10,000 calls, is under 26 B per call: one object per call fails it (measured on Node 24:
 * a double boxed as a HeapNumber 16 B, a closure's context 40 B, a 3-element array more). The whole frame step has a
 * boxing budget instead (`FRAME_STEP_ALLOC_MAX`, rulings R7). No wall-clock bound, so the tests tolerate a loaded
 * machine; 120 s timeouts. The coordinator is filled once and its frame step warmed up once, shared by the `update` and
 * the frame-step tests (rulings R7: the file stays under 25 s under the full suite's load).
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { PerspectiveCamera } from 'three';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { colKey } from '../../src/core/coords';
import { hex64 } from '../../src/core/hash';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { OPENING_T, TIME_SPEEDS } from '../../src/daynight/dayNight';
import {
  createCoordinator, createCoordinatorCounts, type Coordinator, type CoordinatorCounts, type CoordinatorJobs,
  type StreamStore,
} from '../../src/engine/coordinator';
import { appliedDraftOf } from '../../src/engine/invalidation';
import type { Stage } from '../../src/engine/rings';
import type { SessionState } from '../../src/engine/session';
import { createThrottle } from '../../src/engine/throttle';
import { createUploadBudget } from '../../src/engine/uploadBudget';
import { createWorkerPool, type WorkerLike } from '../../src/engine/workerPool';
import type { ColumnMeshPayload } from '../../src/mesh/column';
import { SPEED_DEFAULT, stepFly, type FlyState } from '../../src/player/fly';
import { createHotbar } from '../../src/player/hotbar';
import type { Action } from '../../src/player/keymap';
import { createWalkState } from '../../src/player/walk';
import { firstOrigin } from '../../src/render/floatingOrigin';
import { createFpsLimiter } from '../../src/render/fpsLimiter';
import { createMaterialSystem } from '../../src/render/materials/index';
import { gpuEstimateOf, type GpuEstimate } from '../../src/render/renderer';
import { createSectionRenderer, createSectionRendererCounts } from '../../src/render/sectionRenderer';
import { createSky } from '../../src/render/sky';
import { createFlatColorArray } from '../../src/render/textureArray';
import { createFrameStats } from '../../src/ui/frameStats';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import type { MapTool, MapToolDeps } from '../../src/ui/map/mapTool';
import type { MapCanvas } from '../../src/ui/map/mapView';
import { createReplayingCanvas, draftOf, type Configured, type DriverStatus, type PreviewDriver } from '../../src/ui/map/previewDriver';
import { coversWorld, createApplyControl, createEpochs, updateAuxPolicy } from '../../src/ui/world/applyControl';
import { mountBuildHud } from '../../src/ui/world/buildHud';
import { createFogEase } from '../../src/ui/world/fogEase';
import { createFrameClock, createFrameNotice } from '../../src/ui/world/frameNotice';
import { createFrameStep, type FrameStepDeps } from '../../src/ui/world/frameStep';
import { createHoldRepeat } from '../../src/ui/world/holdRepeat';
import { createMapOverlay, type MapOverlay } from '../../src/ui/world/mapOverlay';
import { createStore } from '../../src/world/store/store';
import { installDom } from './fixtures/domShim';

/**
 * The map tool's chunk, faked (the real tool mounts only in the browser smoke, SP4c spec §1.2, §9): its `setPlayer`
 * forwards to a fake `MapCanvas` whose `setPlayer` is the real one's body (`mapView.ts`): the real `arrowRedrawWanted`
 * decides, the arrow drawn at once where the real canvas schedules a rAF draw. Its clock is the frame's timestamp
 * (`arrow.now`): Node's `performance.now()` allocates on each call (the upload budget's note below).
 */
const arrow = vi.hoisted(() => ({ now: (): number => 0, setPlayer: 0, draws: 0, mounts: 0 }));
vi.mock('../../src/ui/map/mapTool', async () => {
  const { arrowRedrawWanted } = await import('../../src/ui/map/viewMath');
  return {
    createMapTool(_host: HTMLElement, deps: MapToolDeps): MapTool {
      arrow.mounts++;
      let view = deps.initialView;
      let drawnX = 0;
      let drawnZ = 0;
      let drawnYaw = 0;
      let drawnAt = Number.NEGATIVE_INFINITY;
      let arrowDrawn = false;
      const draw = (x: number, z: number, yawDeg: number): void => {
        arrow.draws++;
        arrowDrawn = true;
        drawnX = x;
        drawnZ = z;
        drawnYaw = yawDeg;
        drawnAt = arrow.now();
      };
      const canvas: Pick<MapCanvas, 'setPlayer'> = {
        setPlayer(x, z, yawDeg) {
          arrow.setPlayer++;
          if (arrowRedrawWanted(arrowDrawn, drawnX, drawnZ, drawnYaw, x, z, yawDeg, view.bpp, drawnAt, arrow.now)) draw(x, z, yawDeg);
        },
      };
      return {
        show(c) { if (c !== undefined) view = { ...view, x: c.x, z: c.z }; },
        hide() {},
        // As the real tool (`mapTool.ts`).
        setPlayer: (x, z, yawDeg) => canvas.setPlayer(x, z, yawDeg),
        get view() { return view; },
        notices: {} as MapTool['notices'],
        setView(v) { view = v; },
        dispose() {},
      };
    },
  };
});

v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as (o?: { type: 'major' | 'minor' }) => void;
/** V8's spaces for compiled code and its metadata: not counted (`terrainHeap.test.ts`). */
const JIT_SPACE = /^(code|trusted|shared_trusted)_/;

/** The heap's used bytes without the JIT spaces, read as it is (no gc here). */
function heapUsed(): number {
  let n = 0;
  for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) n += s.space_used_size;
  return n;
}

/** The growth bound over N calls: under 26 B per call (SP4b spec §8.5). */
const ZERO_ALLOC_MAX = 256 * 1024;
const N = 10_000;
/**
 * The whole frame step's bound: a boxing budget of 256 B per tick (rulings R7, SP4b spec §8.5, D25). The frame's fresh
 * doubles cross calls TurboFan does not inline, and V8 boxes each as a 16 B HeapNumber: the median interval, the
 * snapped frame time and the interval passed to `throttle.push`, the clock's `dt` and the limiter's median, the fly
 * step's `dtS`, `pump`'s fractional yaw, `origin.update`'s position, `fogStep`'s `dt`, and inside `setFrameUniforms` the
 * time and the day/dusk factors passed to the sky, the sun and the lightmap. About 10 per tick: 158 B per tick measured
 * on Node 24 once the code settles; the budget is 1.6 times that. These are V8's calling convention, not objects our
 * code creates: those fail the 26 B bounds of the parts below (the clock, the fly step, the budget, the GPU estimate,
 * `update`), and any one added per tick on top of the boxing (16-40 B and more) shows here as a rise of the reading.
 */
const FRAME_STEP_ALLOC_MAX = 256 * N;
/**
 * Calls before a cheap part's measurement. 10·N, not N: measured on Node 24 (V8 13.6), the throttle's `push` and the
 * limiter's `tick` are still in Maglev with a TurboFan job compiling concurrently after 10,000 calls, and a job finalised
 * inside the window counts its on-heap allocations (37-48 B per call over the next 10,000); after 100,000 they settle.
 * Those parts cost microseconds per 1,000 calls.
 */
const WARM_UP = 10 * N;
/**
 * The frame step's warm-up, run once for the shared fixture: N ticks. A frame step at rest costs tens of microseconds
 * (the coordinator's `update` and `counts` most of it), so 10·N ticks would cost seconds, and tens of seconds under the
 * full suite's load (rulings R7). After N ticks the first attempt reads about 193 B per tick, after 2·N the 158 B of
 * the settled code; warming the cheap parts on their own first changes nothing measurable.
 */
const FRAME_WARM_UP = N;
const ATTEMPTS = 3;
/** `apply` + `update` pairs measured (and warmed up) in the Apply test: each is a pass over the 4,096 slots and a rebuild. */
const APPLY_N = 1_000;
/**
 * The measured calls run in chunks of N / CHUNKS, each read on its own: under the full suite's load V8 shrinks the
 * young generation to 1 MB of usable space (its allocation rate per second is low), so the frame step's 1.6-1.9 MB over
 * N ticks forced a scavenge in every attempt; a chunk of 1,000 ticks allocates under 260 KB.
 */
const CHUNKS = 10;
const TIMEOUT_MS = 120_000;

/**
 * Timestamps as rAF hands them: numbers already boxed (a holey array of tagged values), so the harness passes each
 * without allocating; a timestamp computed per call would be boxed by the harness itself.
 */
function boxedTimes(stepMs: number, warmUp = WARM_UP): readonly number[] {
  // Each attempt's chunks may each be tried `ATTEMPTS` times.
  const t: unknown[] = new Array(warmUp + ATTEMPTS * ATTEMPTS * N);
  t[0] = {}; // a non-number first: the array stays in tagged (not double) elements
  for (let i = 0; i < t.length; i++) t[i] = (i + 1) * stepMs;
  return t as number[];
}

interface Growth {
  /** The last attempt's growth over N calls; NaN when one of its chunks saw a GC on every try. */
  readonly bytes: number;
  /** Each attempt's growth (NaN as above). */
  readonly readings: readonly number[];
  /** The GCs each attempt's chunks saw (each such chunk was run again). */
  readonly gcs: readonly number[];
  /** The calls made, warm-up included. */
  readonly calls: number;
}

/**
 * The growth over `n` calls with no GC in between: a reading, the profiler started, the calls, a reading, the profiler
 * stopped. Taken again, up to `ATTEMPTS` tries, while the profiler saw a GC; NaN when every try saw one.
 */
function chunkGrowth(call: () => void, n: number): { bytes: number; gcs: number; calls: number } {
  let gcs = 0;
  for (let t = 1; t <= ATTEMPTS; t++) {
    // Only the young generation needs emptying here (a scavenge, a few milliseconds).
    gc({ type: 'minor' });
    const before = heapUsed();
    const profiler = new v8.GCProfiler();
    profiler.start();
    for (let i = 0; i < n; i++) call();
    const after = heapUsed();
    const seen = profiler.stop()?.statistics.length ?? 0;
    if (seen === 0) return { bytes: after - before, gcs, calls: t * n };
    gcs += seen;
  }
  return { bytes: Number.NaN, gcs, calls: ATTEMPTS * n };
}

/**
 * Warms `call` up with `warmUp` calls, then measures the heap growth over `n` (N by default) more with no GC inside a
 * reading: after a double `gc()`, the calls run as `CHUNKS` chunks, each read on its own (`chunkGrowth`), and the
 * growths are summed. An attempt that read `max` or more is followed by another, up to `ATTEMPTS`.
 */
function allocationOver(call: () => void, warmUp: number, max: number, n = N): Growth {
  for (let i = 0; i < warmUp; i++) call();
  let calls = warmUp;
  const readings: number[] = [];
  const gcs: number[] = [];
  let bytes = Number.NaN;
  for (let a = 0; a < ATTEMPTS; a++) {
    gc();
    gc();
    bytes = 0;
    let seen = 0;
    for (let c = 0; c < CHUNKS; c++) {
      const g = chunkGrowth(call, n / CHUNKS);
      bytes += g.bytes;
      seen += g.gcs;
      calls += g.calls;
    }
    readings.push(bytes);
    gcs.push(seen);
    if (bytes < max) break;
  }
  return { bytes, readings, gcs, calls };
}

function expectAtRest(g: Growth, max = ZERO_ALLOC_MAX): void {
  expect(g.bytes, `a chunk saw a GC on every try (GCs per attempt: ${g.gcs.join(', ')})`).not.toBeNaN();
  expect(g.bytes, `heap growth ${g.bytes} bytes over ${N} calls (attempts: ${g.readings.join(', ')})`).toBeLessThan(max);
}

/**
 * A store model and jobs that settle at once (the replies arrive in the next microtask): T commits a record at Proto,
 * D at Decorated (block version + 1), L at Published (light version + 1), MESH stages a payload; L and MESH carry the
 * versions they read at their start, as the workers do. Every proto stays alive (`retainAllProtos`).
 */
function fakeWorld() {
  const slotOf = (cx: number, cz: number): number => (cx & 63) + 64 * (cz & 63);
  const records = new Map<number, { cx: number; cz: number; status: number; block: number; light: number }>();
  const held = (cx: number, cz: number) => {
    const r = records.get(slotOf(cx, cz));
    return r !== undefined && r.cx === cx && r.cz === cz ? r : undefined;
  };
  let staged = 0;
  const store: StreamStore = {
    versionsInto(cx, cz, out) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = 2 * (3 * (dz + 1) + (dx + 1));
          const r = held(cx + dx, cz + dz);
          out[k] = r?.block ?? -1;
          out[k + 1] = r?.light ?? -1;
        }
      }
    },
    holder(cx, cz) {
      const r = records.get(slotOf(cx, cz));
      return r === undefined ? 'free' : r.cx === cx && r.cz === cz ? 'self' : 'other';
    },
    freeColumn(cx, cz) {
      if (held(cx, cz) !== undefined) records.delete(slotOf(cx, cz));
    },
    freeProto() {},
  };
  const jobs: CoordinatorJobs = {
    run(stage: Stage, cx, cz) {
      const versions = new Int32Array(18);
      store.versionsInto(cx, cz, versions);
      if (stage === 'T') records.set(slotOf(cx, cz), { cx, cz, status: 1, block: 1, light: 0 });
      else if (stage === 'D') { const r = held(cx, cz)!; r.status = 2; r.block++; }
      else if (stage === 'L') { const r = held(cx, cz)!; r.status = 3; r.light++; }
      const payload = stage === 'MESH' ? ({ cx, cz, versions } as unknown as ColumnMeshPayload) : null;
      return Promise.resolve({ versions: stage === 'L' || stage === 'MESH' ? versions : null, payload, generation: 0 });
    },
    cancel() {},
    liveWorkers: () => 4,
    generation: () => 0,
  };
  return { store, jobs, sink: { stage() { staged++; }, unstage: () => false, remove() {} }, staged: () => staged };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** The camera at rest: fractional values, as at run time (whole numbers would be Smis, never boxed). */
const restingFly = (): FlyState => ({ x: 8.5, y: 100.5, z: 8.5, yaw: 37.5, pitch: -10.5, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT, mode: 'fly' });

/** A coordinator at RD 12 (the page's default) filled around the camera, with every set done and nothing in flight. */
async function filledCoordinator(cam: { x: number; z: number; yawDeg: number }): Promise<Coordinator> {
  const w = fakeWorld();
  const c = createCoordinator({
    jobs: w.jobs, store: w.store, sink: w.sink, throttle: createThrottle({ max: 3 }), rd: 12, rdMax: 16,
    retainAllProtos: true, strict: true, generation: 0, epoch: 1, onEvent: (e) => { throw new Error(`unexpected event ${e.kind}`); },
  });
  for (let i = 0; i < 100 && !c.firstFill(); i++) {
    c.update(cam);
    await flush();
  }
  c.update(cam);
  await flush();
  const counts = c.counts(createCoordinatorCounts());
  expect(c.firstFill()).toBe(true);
  for (const s of ['T', 'D', 'L', 'MESH'] as const) {
    expect(counts[s], s).toEqual({ needed: counts[s].needed, done: counts[s].needed, inFlight: 0, queued: 0 });
  }
  expect(w.staged()).toBe(counts.MESH.needed);
  expect([counts.dropped, counts.failed]).toEqual([0, 0]);
  return c;
}

/** The ready reply the workers send for a session state: hex stage hashes and genKey (`taskHandler.ts`). */
function readyOf(s: SessionState): Configured['ready'] {
  const h = stageHashes(s.params);
  const hex: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) hex[k] = hex64(v!);
  return { stageHashes: hex, genKey: hex64(genKey(s.seed, h)) };
}

/** A worker that takes every message and never answers: the frame step touches only the pool's aux policy. */
const idleWorker = (): WorkerLike => ({ postMessage() {}, onmessage: null, terminate() {} });

/** The frame step's warm-up once the map is shown in split mode (the arrow's path, the tool's `setPlayer`, is new). */
const SHOWN_WARM_UP = N;

interface AtRest {
  readonly fly: FlyState;
  readonly coordinator: Coordinator;
  /** The frame step's counts object (written every tick). */
  readonly counts: CoordinatorCounts;
  /** One frame step, at the next 144 Hz timestamp. */
  tick(): void;
  readonly state: { readonly t: number; readonly eyeSky: number };
  /** Ticks run, rendered frames, lightmap rebuilds. */
  stats(): { ticks: number; rendered: number; lightmapBuilds: number };
  readonly t0: number;
  readonly sections: ReturnType<typeof createSectionRenderer>;
  /** The page's map overlay (SP4c spec §1.3), hidden until `showSplit`. */
  readonly overlay: MapOverlay;
  /** Opens the overlay in split mode, lets it mount the (fake) tool, takes the pointer lock and warms the frame up again. */
  showSplit(): Promise<void>;
  /** The `from` of each Apply or adopt the apply control made (`onApplied`). */
  readonly applied: ReadonlyArray<string | null>;
  /** The aux policy's inputs at rest: the pool's epoch, the control's generation, the pool's size. */
  policy(): { poolEpoch: number; generation: number; size: number };
  /**
   * SP4c's per-tick hooks alone, without the rest of the frame step, one call each: the owner check, the apply control's
   * tick, the aux policy over the frame step's counts and the overlay's tick.
   */
  readonly hooks: Readonly<Record<'ownerCheck' | 'applyTick' | 'auxPolicy' | 'overlayTick', () => void>>;
  /** The `hooks.ownerCheck` calls that found the world owning the controls. */
  owned(): number;
}

/**
 * The page's frame at rest, built and warmed up once for the file (rulings R7): a real coordinator filled at RD 12, the
 * real `createFrameStep` over it with `pump` on a real RegionBatch with nothing staged, a real batch `MaterialSystem`
 * (`setFrameUniforms`, the time at ×60), the floating origin and the camera, a real store with the camera's column
 * Published (the eye light is a real `lightAt` read), the FPS limiter at 144 on 144 Hz ticks, the slow-frame notice,
 * frame stats, the fog easing, the throttle and the upload budget. `frame` is `WorldRenderer.frame` minus
 * `renderer.render` (no GL context in Node): the translucent sort and the frame uniforms. Warmed up with
 * `FRAME_WARM_UP` ticks, which also warms the coordinator's `update` and `counts`.
 */
async function buildAtRest(): Promise<AtRest> {
  const fly = restingFly();
  const coordinator = await filledCoordinator({ x: fly.x, z: fly.z, yawDeg: fly.yaw });
  const counts = createCoordinatorCounts();

  const albedo = createFlatColorArray();
  const materials = createMaterialSystem({ variant: 'batch', ao: true, smoothLight: true }, albedo);
  const sections = createSectionRenderer('batch', materials);
  const origin = firstOrigin({ x: fly.x, z: fly.z });
  sections.setOrigin(origin.x, origin.y, origin.z);
  const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 336);
  const world: FrameStepDeps['world'] = {
    origin,
    camera,
    sections,
    frame(state) {
      sections.sortTranslucent(camera.position.x, camera.position.y, camera.position.z);
      materials.setFrameUniforms(state);
    },
  };

  // A real store with the camera's column Published, so the eye's light is a real read (spec §2.4).
  const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
  const w = store.claimColumn(0, 0, 0);
  w.setFinal(10, new Uint16Array(4096), new Uint8Array(4096).fill(0xc0), new Uint8Array(4096));
  w.commit(3);

  const speed60 = TIME_SPEEDS.indexOf(60);
  expect(speed60).toBeGreaterThanOrEqual(0);
  const fog = createFogEase(12);
  const frames = createFrameStats();
  const state = { t: OPENING_T, brightness: 0.5, eyeSky: 15, rd: 12, fogBand: MEDIUM.fogBand };
  const none: ReadonlySet<Action> = new Set();
  // A 144 Hz display under a cap of 144: the limiter's median runs on every tick and every tick renders. Enough
  // timestamps for the warm-ups and each frame-step test's attempts.
  const times = boxedTimes(1000 / 144, FRAME_WARM_UP + SHOWN_WARM_UP + ATTEMPTS * ATTEMPTS * N);
  let ticks = 0;
  // The budget's clock is the tick's timestamp: Node's `performance.now()` allocates on each call (88 B measured),
  // the browser's does not concern this code.
  let clockNow = times[0]!;
  arrow.now = () => clockNow;
  let rendered = 0;
  let lightmapBuilds = 0;
  const lightmap = materials.lightmap.texture;
  let lastVersion = lightmap.version;
  const limiter = createFpsLimiter(144);

  // SP4c's frame additions (spec §4.10), as the world page wires them. A real pool for the aux policy, configured once
  // (generation 0, the coordinator's; its idle workers never answer, and the frame step touches only `setAuxPolicy`).
  const pool = createWorkerPool(4, idleWorker);
  const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
  void pool.configure(session.state.seedText, session.state.params);
  // The real apply control over a fake driver that reports one configure of the applied draft: the first tick adopts it
  // (nothing rebuilds), so every measured tick runs at rest with nothing configured since the last Apply.
  const ready = readyOf(session.state);
  let report: ((c: Configured) => void) | null = null;
  const driver = {
    onConfigured(fn: (c: Configured) => void) {
      report = fn;
      return () => { report = null; };
    },
    status: { queued: false } as DriverStatus,
    change() {},
    setPreviewWanted() {},
  };
  const epochs = createEpochs();
  epochs.of(ready.genKey);
  const applied: Array<string | null> = [];
  const applyControl = createApplyControl({
    coordinator,
    driver,
    session,
    pool,
    clock: { now: () => clockNow },
    epochs,
    initial: appliedDraftOf(draftOf(session.state).seedKey, ready),
    initialGeneration: pool.epoch,
    beforeApply: () => true,
    onApplied: ({ from }) => { applied.push(from); },
  });
  report!({ poolEpoch: pool.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready, gesture: false, urgent: true });

  // The map overlay on the DOM shim over the fake tool's chunk; a 1,920 px window offers split mode (SP4c spec §2.2).
  const dom = installDom();
  const app = dom.document.createElement('div');
  const worldHost = dom.document.createElement('div');
  const canvas = dom.document.createElement('canvas');
  worldHost.append(canvas);
  app.append(worldHost);
  dom.body.append(app);
  const overlay = createMapOverlay({
    app: app as unknown as HTMLElement,
    worldHost: worldHost as unknown as HTMLElement,
    canvas: canvas as unknown as HTMLCanvasElement,
    session,
    pool,
    driver: driver as unknown as PreviewDriver,
    relay: createReplayingCanvas(),
    storage: null,
    settings: { mapMode: 'split', watchLive: true },
    save() {},
    world: { resize() {}, frame: (s) => world.frame(s) },
    frameState: () => state,
    limiter,
    userCap: () => 144,
    fly,
    input: { clear() {} },
    doc: dom.document as unknown as Document,
    // No preload timer runs: the first open imports the chunk.
    win: { innerWidth: 1920, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {} } as unknown as Window,
    now: () => clockNow,
    onTeleport: () => Promise.resolve(false),
    viewChanged() {},
    notices: { route() {}, show() {}, hide() {} },
  });

  // SP4c's per-tick hooks, as the page's: the owner check (§2.3), the apply control before the update (§4.3), the aux
  // policy from the counts (§6.2), and on rendered frames the overlay's tick, which moves the arrow while shown (§1.5).
  const paused = (): boolean => overlay.owner === 'map';
  const beforeUpdate = (): void => applyControl.tick();
  const afterCounts = (c: CoordinatorCounts): void => updateAuxPolicy(pool, applyControl.generation, coversWorld(overlay), c);
  let owned = 0;

  const step = createFrameStep({
    fly,
    // Flying: the walk state is only held (rulings R22).
    walk: createWalkState(),
    held: () => none,
    paused,
    stopped: () => false,
    clock: createFrameClock(limiter, createFrameNotice(() => {}, 12), 0),
    coordinator,
    counts,
    throttle: createThrottle({ max: 3 }),
    budget: createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, () => clockNow),
    sections,
    world,
    store,
    // The page's aim is not part of SP4c's frame at rest (SP5a's DDA and outline are pinned in their own tests).
    aim: () => {},
    state,
    timeSpeed: () => TIME_SPEEDS[speed60]!,
    fogStep: (dtMs) => fog.step(dtMs, 12),
    beforeUpdate,
    afterCounts,
    onRendered: (dtMs) => {
      frames.push(dtMs);
      overlay.tick(counts);
      rendered++;
      if (lightmap.version !== lastVersion) {
        lastVersion = lightmap.version;
        lightmapBuilds++;
      }
    },
  });
  const t0 = state.t;
  const tick = (): void => {
    clockNow = times[ticks++]!;
    step.tick(clockNow);
  };
  for (let i = 0; i < FRAME_WARM_UP; i++) tick();
  return {
    fly, coordinator, counts, tick, state, t0, sections, overlay, applied,
    stats: () => ({ ticks, rendered, lightmapBuilds }),
    policy: () => ({ poolEpoch: pool.epoch, generation: applyControl.generation, size: pool.size }),
    hooks: {
      ownerCheck: () => { if (!paused()) owned++; },
      applyTick: beforeUpdate,
      auxPolicy: () => afterCounts(counts),
      overlayTick: () => overlay.tick(counts),
    },
    owned: () => owned,
    async showSplit() {
      // The (mocked) chunk is loaded first, as the overlay's preload does 2 s after the reveal; the open's own import then
      // resolves from the module cache and mounts the tool within a few macrotasks.
      await import('../../src/ui/map/mapTool');
      overlay.open();
      const until = Date.now() + 10_000;
      while (overlay.tool === null && Date.now() < until) await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
      // The user clicks the 3D half: the canvas takes the pointer lock and the world owns the controls (§2.3).
      dom.document.setPointerLock(canvas);
      for (let i = 0; i < SHOWN_WARM_UP; i++) tick();
    },
  };
}

afterAll(() => { vi.unstubAllGlobals(); });

let atRestOnce: Promise<AtRest> | undefined;
/** The shared fixture, built on first use (either test may run alone). */
const atRest = (): Promise<AtRest> => (atRestOnce ??= buildAtRest());

/**
 * SP4c's parts were at rest: the apply control made its one adopt (the same world, nothing rebuilt) and nothing since;
 * the world is not held, the map does not cover it and no T is pending, so every tick's `setAuxPolicy` was the pool's
 * default `('world', size)`, unchanged (SP4c spec §6.2); nothing is stale.
 */
function expectSp4cAtRest(f: AtRest): void {
  expect(f.applied).toEqual([null]);
  const p = f.policy();
  expect([p.poolEpoch, p.generation]).toEqual([0, 0]);
  expect(coversWorld(f.overlay)).toBe(false);
  expect(f.counts.T.done).toBe(f.counts.T.needed);
  expect(f.counts.stale).toBe(0);
}

describe('zero allocation at rest (SP4b spec §3.10, D25)', () => {
  test('the GC profiler reports a scavenge (the measurement can see one)', () => {
    gc();
    const profiler = new v8.GCProfiler();
    profiler.start();
    let keep: unknown = null;
    // 64 MB of short-lived arrays: more than any young generation, so at least one scavenge runs.
    for (let i = 0; i < 1 << 20; i++) keep = new Array(8).fill(i);
    const stats = profiler.stop()?.statistics ?? [];
    expect(keep).toHaveLength(8);
    expect(stats.length).toBeGreaterThan(0);
    // And the measurement counts what a loop allocates: one 3-element array per call is far over the bound, on
    // every attempt.
    let sink: unknown = null;
    let i = 0;
    const g = allocationOver(() => { sink = [i, i, i++]; }, N, ZERO_ALLOC_MAX);
    expect(sink).toHaveLength(3);
    expect(g.gcs).toHaveLength(ATTEMPTS);
    expect(g.readings.every((b) => b > ZERO_ALLOC_MAX), `${g.readings.join(', ')}`).toBe(true);
  }, TIMEOUT_MS);

  test(`${N} coordinator.update calls at rest after a fill (fake jobs, no movement, no arriving results) grow the heap by less than 256 KB`, async () => {
    const { fly, coordinator: c } = await atRest();
    const cam = { x: fly.x, z: fly.z, yawDeg: fly.yaw };
    const counts = createCoordinatorCounts();
    // `update` and `counts` are warm from the fixture's frame steps; this warms the test's own call.
    const g = allocationOver(() => {
      c.update(cam);
      c.counts(counts);
    }, N / 10, ZERO_ALLOC_MAX);
    expect(counts.T.inFlight + counts.D.inFlight + counts.L.inFlight + counts.MESH.inFlight).toBe(0);
    expect(counts.T.done).toBe(counts.T.needed);
    expectAtRest(g);
  }, TIMEOUT_MS);

  test(`${N} coordinator.update calls at rest with an empty edit ring, after two edit remeshes (SP5a spec §2.6, D22), grow the heap by less than 256 KB`, async () => {
    // A coordinator of its own (the shared one stays at rest for the frame step), filled as `filledCoordinator` does.
    const fly = restingFly();
    const cam = { x: fly.x, z: fly.z, yawDeg: fly.yaw };
    const w = fakeWorld();
    const edited: string[] = [];
    const c = createCoordinator({
      jobs: w.jobs, store: w.store, sink: w.sink, throttle: createThrottle({ max: 3 }), rd: 12, rdMax: 16,
      retainAllProtos: true, strict: false, generation: 0, epoch: 1, onEvent: (e) => { throw new Error(`unexpected event ${e.kind}`); },
      onEditStaged: (cx, cz) => { edited.push(`${cx},${cz}`); },
    });
    for (let i = 0; i < 100 && !c.firstFill(); i++) {
      c.update(cam);
      await flush();
    }
    const counts = createCoordinatorCounts();
    const staged = w.staged();
    expect(staged).toBe(c.counts(counts).MESH.needed);
    // Two edits' remeshes, issued at once and settled: the ring drains empty.
    c.markEdited(Float64Array.of(colKey(0, 0), colKey(1, 0)));
    await flush();
    expect(w.staged()).toBe(staged + 2);
    expect(edited).toEqual(['0,0', '1,0']);
    const g = allocationOver(() => {
      c.update(cam);
      c.counts(counts);
    }, N / 10, ZERO_ALLOC_MAX);
    expect(counts.T.inFlight + counts.D.inFlight + counts.L.inFlight + counts.MESH.inFlight).toBe(0);
    expect([counts.dropped, counts.editDropped]).toEqual([0, 0]);
    expect(w.staged()).toBe(staged + 2);
    expectAtRest(g);
  }, TIMEOUT_MS);

  test(`${APPLY_N} × (coordinator.apply alternating epochs 2 and 3 under a held generation, then one update) after a fill grow the heap by less than 256 KB (SP4c spec §4.10)`, async () => {
    // A coordinator of its own (the shared one stays at rest for the frame step). The fake pool's generation is 0 and
    // each Apply is under generation 1, so the world holds: no job is issued and no promise made, while every Apply
    // resolves the pending payloads, marks the stale columns and rebuilds the heaps, and every update frees 16 of them
    // (their old meshes kept) and hides the stale meshes outside the MESH set.
    const fly = restingFly();
    const cam = { x: fly.x, z: fly.z, yawDeg: fly.yaw };
    const c = await filledCoordinator(cam);
    const counts = createCoordinatorCounts();
    // The arguments are made once: the call under test is `apply`, not the caller's literal.
    const to2 = { epoch: 2, generation: 1, from: 'T' } as const;
    const to3 = { epoch: 3, generation: 1, from: 'T' } as const;
    let odd = false;
    const g = allocationOver(() => {
      c.apply(odd ? to3 : to2);
      odd = !odd;
      c.update(cam);
    }, APPLY_N, ZERO_ALLOC_MAX, APPLY_N);
    c.counts(counts);
    expect(counts.T.inFlight + counts.D.inFlight + counts.L.inFlight + counts.MESH.inFlight).toBe(0);
    expect(counts.epoch === 2 || counts.epoch === 3).toBe(true);
    expect(counts.stale).toBeGreaterThan(0);
    expectAtRest(g);
  }, TIMEOUT_MS);

  test(`${N} frame steps at rest with SP4c's additions, the map hidden (a real coordinator at rest, pump with nothing staged on a real RegionBatch, setFrameUniforms with the time at ×60, the FPS limiter and frame timing; the apply control's tick, setAuxPolicy on a real pool with unchanged values, the owner check, the overlay's tick) grow the heap by less than the boxing budget of 256 B per tick (SP4c spec §4.10)`, async () => {
    const f = await atRest();
    expect(f.overlay.shown).toBe(false);
    const g = allocationOver(f.tick, 0, FRAME_STEP_ALLOC_MAX);
    expectAtRest(g, FRAME_STEP_ALLOC_MAX);
    expectSp4cAtRest(f);
    expect([f.overlay.shown, f.overlay.owner, arrow.mounts, arrow.setPlayer]).toEqual([false, 'world', 0, 0]);
    // The frame really ran at rest: every tick rendered, the time ran (×60: a day per 20 s, so the lightmap rebuilt),
    // the eye read the Published column's sky light, nothing was staged or uploaded and nothing moved.
    const { ticks, rendered, lightmapBuilds } = f.stats();
    expect(ticks).toBeGreaterThanOrEqual(FRAME_WARM_UP + g.calls);
    expect(rendered).toBe(ticks);
    expect(f.state.t).not.toBe(f.t0);
    expect(lightmapBuilds).toBeGreaterThan(10);
    expect(f.state.eyeSky).toBe(0xc);
    expect(f.sections.counts(createSectionRendererCounts()).columnsStaged).toBe(0);
    expect([f.fly.x, f.fly.y, f.fly.z]).toEqual([8.5, 100.5, 8.5]);
    expect(f.counts.T.done).toBe(f.counts.T.needed);
  }, TIMEOUT_MS);

  test(`${N} frame steps at rest with SP4c's additions, the map shown in split mode (the arrow updated every rendered frame at a fixed camera, through the tool's setPlayer and the real arrowRedrawWanted) grow the heap by less than the boxing budget of 256 B per tick (SP4c spec §4.10)`, async () => {
    const f = await atRest();
    await f.showSplit();
    // Split shown with the pointer lock: the world owns, the 3D is visible, the cap is the user's (SP4c spec §2.3, §2.6).
    expect([f.overlay.shown, f.overlay.mode, f.overlay.owner, arrow.mounts]).toEqual([true, 'split', 'world', 1]);
    const before = f.stats();
    const setPlayerBefore = arrow.setPlayer;
    const g = allocationOver(f.tick, 0, FRAME_STEP_ALLOC_MAX);
    expectAtRest(g, FRAME_STEP_ALLOC_MAX);
    expectSp4cAtRest(f);
    const after = f.stats();
    // Every tick rendered and moved the arrow through the tool; the arrow was drawn once, at the opening, and never again
    // at a fixed camera.
    expect(after.rendered - before.rendered).toBe(g.calls);
    expect(arrow.setPlayer - setPlayerBefore).toBe(g.calls);
    expect(arrow.draws).toBe(1);
    expect([f.fly.x, f.fly.y, f.fly.z]).toEqual([8.5, 100.5, 8.5]);
    expect(f.sections.counts(createSectionRendererCounts()).columnsStaged).toBe(0);
    expect(f.counts.T.done).toBe(f.counts.T.needed);
  }, TIMEOUT_MS);

  test(`${N} × each of SP4c's per-tick hooks alone at rest, the map shown in split mode (the owner check, the apply control's tick, setAuxPolicy with unchanged values, the overlay's tick moving the arrow) grow the heap by less than 256 KB`, async () => {
    // The frame step's budget leaves about 90 B per tick over the boxing it measures, so one small object added per tick
    // by these hooks could hide under it; on their own they get the 26 B bound of the frame's other parts, each measured
    // on its own as those parts are. Not one closure calling all four: TurboFan inlines such a closure's callees up to a
    // cumulative bytecode budget (920 on Node 24), and the four hooks' trees do not fit. Which callee stays out of line
    // depends on the feedback and the optimized code the earlier tests left (and, under load, on the concurrent
    // compiler's timing); with the overlay's tick and the apply control's tick inlined first, the fake canvas's call to
    // `arrowRedrawWanted` stayed out of line and boxed the camera's mutable `x` and `z` (2 × 16 B HeapNumbers per call:
    // 345,480 B over N, the same on every attempt, whenever the file ran whole). That boxing is the harness closure's
    // calling convention, which the page does not have (it calls each hook from its own frame-step site, measured under
    // the boxing budget above), not an object the hooks create; one hook per closure fits the budget.
    const f = await atRest();
    if (!f.overlay.shown) await f.showSplit();
    const setPlayerBefore = arrow.setPlayer;
    let calls = 0;
    for (const [name, hook] of Object.entries(f.hooks)) {
      const g = allocationOver(hook, WARM_UP, ZERO_ALLOC_MAX);
      expect(g.bytes, `${name}: a chunk saw a GC on every try (GCs per attempt: ${g.gcs.join(', ')})`).not.toBeNaN();
      expect(g.bytes, `${name}: heap growth ${g.bytes} bytes over ${N} calls (attempts: ${g.readings.join(', ')})`)
        .toBeLessThan(ZERO_ALLOC_MAX);
      if (name === 'ownerCheck') expect(f.owned()).toBe(g.calls);
      if (name === 'overlayTick') calls = g.calls;
    }
    expectSp4cAtRest(f);
    expect([f.overlay.shown, f.overlay.mode, f.overlay.owner]).toEqual([true, 'split', 'world']);
    expect(arrow.setPlayer - setPlayerBefore).toBe(calls);
    expect(arrow.draws).toBe(1);
  }, TIMEOUT_MS);

  test(`${N} frame-clock ticks (a cap of 144 on a 144 Hz display, the slow-frame notice past its 300 frames) grow the heap by less than 256 KB`, () => {
    const times = boxedTimes(1000 / 144);
    let suggested = 0;
    const clock = createFrameClock(createFpsLimiter(144), createFrameNotice(() => { suggested++; }, 12), 0);
    // It reads about 16 B per tick: the `dt` the clock returns, boxed across the call (rulings R7).
    let k = 0;
    let rendered = 0;
    const g = allocationOver(() => {
      if (clock.tick(times[k++]!) !== null) rendered++;
    }, WARM_UP, ZERO_ALLOC_MAX);
    expectAtRest(g);
    expect(rendered).toBe(g.calls);
    expect(suggested).toBe(0);
  }, TIMEOUT_MS);

  test(`${N} fly steps at rest (nothing held) grow the heap by less than 256 KB`, () => {
    const fly = restingFly();
    const none: ReadonlySet<Action> = new Set();
    const bounds = { yMin: -64, yMax: 400 } as const;
    const dts = boxedTimes(0);
    for (let i = 0; i < dts.length; i++) (dts as number[])[i] = 1 / 144;
    let k = 0;
    const g = allocationOver(() => { stepFly(fly, none, dts[k++]!, bounds); }, WARM_UP, ZERO_ALLOC_MAX);
    expectAtRest(g);
    expect([fly.x, fly.y, fly.z, fly.vx, fly.vy, fly.vz]).toEqual([8.5, 100.5, 8.5, 0, 0, 0]);
  }, TIMEOUT_MS);

  test(`${N} build-HUD refreshes at rest (the pointer lock held, the hotbar unchanged; the page calls one per rendered frame) grow the heap by less than 256 KB (SP5a spec §4.3, rulings R20)`, () => {
    // Mounted on a DOM shim of its own; the shared fixture's document is put back after, for the map overlay's elements.
    const before: unknown = Reflect.get(globalThis, 'document');
    const dom = installDom();
    const hotbar = createHotbar(null);
    const host = dom.document.createElement('div');
    const hud = mountBuildHud(host as unknown as HTMLElement, { hotbar, hud: true, locked: () => true });
    if (before !== undefined) vi.stubGlobal('document', before);
    let changes = 0;
    hotbar.subscribe(() => { changes++; });
    const g = allocationOver(() => { hud.refresh(); }, WARM_UP, ZERO_ALLOC_MAX);
    expectAtRest(g);
    // The first refresh showed the crosshair; every later one found nothing to change.
    expect(host.querySelector('#world-crosshair')!.hidden).toBe(false);
    expect([changes, hotbar.active]).toEqual([0, 0]);
    hud.dispose();
  }, TIMEOUT_MS);

  test(`${N} hold-repeat ticks, idle and with LMB held while its reply is pending, grow the heap by less than 256 KB (SP5a spec §4.1, D6, rulings R20)`, () => {
    // The page's aim ticks it on every rendered frame; at rest nothing is held, and a held button waits for its reply.
    // The boxed frame times are passed as they are (their unit does not matter here: every repeat is due).
    const times = boxedTimes(1000 / 144);
    let queued = 0;
    const idle = createHoldRepeat({ enabled: () => true, pending: () => false, queue: () => { queued++; } });
    let k = 0;
    expectAtRest(allocationOver(() => { idle.tick(times[k++]!); }, WARM_UP, ZERO_ALLOC_MAX));
    const held = createHoldRepeat({ enabled: () => true, pending: () => true, queue: () => { queued++; } });
    held.down(0, 0);
    k = 0;
    expectAtRest(allocationOver(() => { held.tick(times[k++]!); }, WARM_UP, ZERO_ALLOC_MAX));
    // Only the press's own queue: the held button never repeated while its reply was pending.
    expect(queued).toBe(1);
  }, TIMEOUT_MS);

  test(`${N} blockAt, fluidAt and publishedAt calls (SP5a's walk-step reads, D25) grow the heap by less than 256 KB`, () => {
    // One Published column of dense sections at (2, −1), beside the absent (1, −1); the reads cycle through its
    // voxels, the heights outside −64 … 319 and the absent column.
    const s = createStore({ shared: true, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
    const w = s.claimColumn(2, -1, 0);
    const blocks = new Uint16Array(4096);
    const fluid = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      blocks[i] = i % 3;
      fluid[i] = i % 5 === 0 ? 0x10 : 0;
    }
    for (let sy = 0; sy < 24; sy++) w.setFinal(sy, blocks, new Uint8Array(4096), fluid);
    w.commit(3);
    let k = 0;
    let sum = 0;
    s.enterRead();
    const g = allocationOver(() => {
      const i = k++;
      const x = 32 + (i & 15) - (i & 64 ? 16 : 0);
      const y = (i % 400) - 72;
      const z = -16 + ((i >> 4) & 15);
      sum += s.blockAt(x, y, z) + s.fluidAt(x, y, z) + (s.publishedAt(x, z) ? 1 : 0);
    }, WARM_UP, ZERO_ALLOC_MAX);
    s.exitRead();
    expectAtRest(g);
    expect(sum).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  test(`${N} upload-budget frames (start, exhausted, structural) grow the heap by less than 256 KB`, () => {
    const times = boxedTimes(1000 / 144);
    let clockNow = times[0]!;
    const budget = createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, () => clockNow);
    let k = 0;
    let granted = 0;
    const g = allocationOver(() => {
      clockNow = times[k++]!;
      budget.start();
      if (!budget.exhausted() && budget.structural()) granted++;
    }, WARM_UP, ZERO_ALLOC_MAX);
    expectAtRest(g);
    expect(granted).toBe(g.calls);
  }, TIMEOUT_MS);

  test(`${N} GPU estimates over the renderer's parts (the bench reads one per frame) grow the heap by less than 256 KB`, () => {
    const albedo = createFlatColorArray();
    const materials = createMaterialSystem({ variant: 'batch', ao: true, smoothLight: true }, albedo);
    const sections = createSectionRenderer('batch', materials);
    const sky = createSky(materials);
    const parts = { sections, sky: sky.geometry, textureArray: albedo, lightmap: materials.lightmap.texture, canvas: { width: 1920, height: 1080 } };
    const out: GpuEstimate = { sectionsBytes: 0, skyBytes: 0, textureBytes: 0, lightmapBytes: 0, drawingBufferBytes: 0 };
    const g = allocationOver(() => { gpuEstimateOf(parts, out); }, WARM_UP, ZERO_ALLOC_MAX);
    expectAtRest(g);
    expect(out.drawingBufferBytes).toBe(1920 * 1080 * 8);
    expect(out.skyBytes).toBeGreaterThan(0);
    sky.geometry.dispose();
    sections.dispose();
    materials.dispose();
    albedo.dispose();
  }, TIMEOUT_MS);
});

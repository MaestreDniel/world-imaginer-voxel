/**
 * The 3D world page (SP4a spec §8.4, D21-D23, D32; rulings P8, P30, P36, P41, P42, P46-P49): from the loading screen to
 * the reveal, then the frame loop.
 *
 * 1. The `#` hash is decoded first: a decode error shows the failure panel with only the map link, and nothing is
 *    probed, allocated or loaded (P47). The loading screen shows at once.
 * 2. Probe and `evaluateWorldCapabilities` (§8.5): a blocking cause replaces the page with the error screen (the causes,
 *    the capability table and a `?map` link).
 * 3. The session (`openMapSession`, which wires tier 2 of the trees; a tier-2 notice shows as a warning and the load
 *    goes on), the settings, and the one render distance (`resolveRenderDistance`, P36). The store
 *    (`createStore({shared: true})` with the accepted reservation), the pool (`?workers` or clamp(cores − 2, 2, 6)),
 *    `attachStore`, then `configure` with the session's seed text and params.
 * 4. The centre is `?at`, else the pool's `spawn`. The world renderer (the section renderer the probe selects,
 *    `?renderer` overriding it; its first floating origin the snapped centre, SP4b spec §3.4) holds its reveals
 *    (`holdReveals(true)`). The first entry runs on the streaming coordinator (SP4b spec §3.11, D21), strict (any
 *    error stops the load, D12) and keeping every proto (D11): a rAF loop calls its `update` with the camera held at
 *    the centre, its sink stages each payload into the section renderer, and the loop pumps the uploads under a 12 ms
 *    budget with no row or structural cap and feeds the loading screen's progress from the coordinator's counts and
 *    the columns uploaded.
 * 5. When every column is meshed (`firstFill`) and every staged column uploaded: `compile()`, the camera placed with
 *    `firstView` from the store's `MOTION_BLOCKING` (`heightAt`), three frames rendered behind the opaque overlay
 *    (`warmUp`: every region drawn unculled, so the sections' buffers reach the GPU while still hidden), then
 *    `revealAll()` and the reveal frame, the overlay faded out over 300 ms, and "Click to fly" until the pointer locks.
 *    Nothing of the world is visible before that frame.
 *
 * At the reveal the coordinator leaves strict mode (D12) and the same coordinator streams. The frame loop is the
 * frame step (`frameStep.ts`, SP4b spec §7.2): every rAF the throttle (fed the raw delta before the FPS limiter), the
 * fly controller (horizontal flight with no horizontal limit, §6.1) and `coordinator.update`; on rendered frames the
 * uploads under the 2 ms / 32-row budget, the floating origin, the store's reclamation drain, the eye's sky light, the
 * clock (T cycles the time speed) and the render. The HUD (F3, the streaming counts of §7.3) and the help (H, F1).
 * Load errors (the coordinator's `fatal` event, whose message and cause the panel reads, a `StoreFullError` cause
 * keeping the store-full text; `WorkerFailed`; the watchdog) show the failure panel, with a link to the next lower RD
 * when rd > 4 (P49). `WorldPage.loadStats` holds the load's figures for the flight JSON (§9.5); with `opts.flight`
 * (the `?flight=sp4a` route, `flight.ts`) the flight drives the camera and the clock after the reveal, and nothing
 * calls `update` (SP4a's static route). With `opts.bench` (the `?bench=medium` route, `bench.ts`, SP4b spec §8.3) the
 * page's own streaming frame runs with no input, HUD, help or notices: after 120 idle frames (the display interval)
 * the driver sets the camera's pose and the RD before each frame step, each rendered frame is recorded into its
 * preallocated record, and a failure after the reveal ends the script with the error. For its live legs (SP4c spec
 * §8.4) the bench builds the world page's live pieces without a map: the preview driver over an unattached replaying
 * canvas with the preview not wanted, fed every session change; the apply control (its `onApplied` marks the Apply
 * frame); the teleport over the bench's pool; the reveals since each mark, read through `sections.onColumnRevealed`.
 * For its edit leg L10 (SP5a spec §6.2) it builds its own edit path over the sim, with the same latency fed by the same
 * hook, and hands the driver the latency's samples and the coordinator's `editDropped` at the end.
 *
 * Errors after the reveal (SP4b spec §3.6, §7.4, D12) degrade: a skipped column shows a dismissible notice with "Copy
 * details", StoreFull a notice offering "Lower to RD n" (applied live on a click, never on its own); a fatal event (no
 * live worker, `StoreCorrupt`, more than 32 failed columns), the pool's last worker failing and an exception escaping
 * the frame step stop the loop and show the notices' failure panel with "Copy details" and a Reload link.
 *
 * The render distance is live (SP4b spec §5, D18): an integer in [4, rdMax], rdMax = min(16, the reservation's cap);
 * the help's select, the slow-frame notice's and StoreFull's "Lower to RD n" all go through `createRdControl`, which
 * sets it on the coordinator (the next `update` re-classifies) and the renderer (the far plane), moves the fog's target
 * and saves the setting; "Default (n)" applies the resolved default. The fog eases outward after a raise
 * (`fogEase.ts`), following the filled radius scanned every 30 rendered frames, and moves in at once after a lower.
 *
 * After the reveal (spec §7.1, §7.5, §8.2, §8.5; rulings P49, P50): the Ctrl+W guard (`beforeunload`) is armed; every
 * navigation the page starts (the context-loss Reload, the failure panel's Reload) goes through one reloader, which
 * disarms the guard and navigates at most once; the help's button "Map (M)" opens the map overlay and navigates nowhere
 * (SP4c spec §1.6, D20); a slow first 300 frames suggest the next lower RD in a dismissible notice whose button applies
 * it live; `webglcontextlost` stops the frame loop and offers a Reload around the camera (`hereUrl`, with the live
 * session's hash). SP4a's edge clamp, its notice and R are gone (SP4b spec §6.2, D20).
 *
 * The world's URL (SP4c spec §1.6, D20; `createWorldUrl`): after every Apply and every view change of the map it is
 * `pathname + search + '#' + ` the live session's hash (the map's view, or the camera's at 4 blocks/px before the first
 * M), through the debounced URL writer (a hash over 64 KiB dropped with the notice); each teleport's arrival rewrites
 * the search's `at`, `y`, `yaw` and `pitch`, flight never does; there is no `hashchange` listener in the world.
 *
 * The map in the world (SP4c spec §1.3, §2.3, §2.4, §4.2): at the reveal the streaming route creates the preview driver
 * (which adopts the first configure, wants no preview until the first M, and is fed every session change by the page
 * until the map tool is mounted, ruling R1) and the map overlay (`mapOverlay.ts`); M toggles it, the flight pauses and
 * the world's keys stop while the map owns the controls, the frame's `onRendered` moves the map's arrow, undo and redo
 * are installed for the page's lifetime (routed by owner since SP5a: `installUndoKeys`), and a fatal error or a context
 * loss disposes the overlay before the failure panel or the notice. The flight route creates neither; the bench creates the driver without the overlay.
 *
 * Live editing (SP4c spec §4.3, §6.2): the coordinator's first epoch is the first draft's genKey interned
 * (`createEpochs`); the apply control (`applyControl.ts`) ticks before every `coordinator.update` and applies the
 * session's last resolved draft once it is quiet (or adopts it when the world is unchanged), its `onApplied` driving
 * Watch live and the 1.5 s "Undo"/"Redo" notice with the map hidden (`createUndoNotice`); the HUD shows "stale n /
 * needed" while the world regenerates; while the map covers the 3D the transient notices (StoreFull, the URL oversize,
 * "Could not teleport") go to the tool's notice row (`WorldNotices.route`, D27); after every `counts` the pool's aux
 * policy is set from the world's hold, the overlay covering the 3D and the pending T; a configure failure after the reveal is fatal (`onDriverStatus`).
 *
 * Editing (SP5a spec §2.1, §2.5, §6.2): after the pool, every route but the flight's spawns the sim worker
 * (`createBrowserSim`) and attaches it as thread 15; D reads its entries through (`worldJobsOf(workers, sim)`). The
 * streaming route and the bench post every edit through the edit path (`editPath.ts`: the gate, the sim pins,
 * `markEdited`), timed (`editLatency.ts`: staged through the coordinator's `onEditStaged`, revealed through
 * `sections.onColumnRevealed`); on the sim's failure the streaming route runs `onSimFailure` (thread 15 dead, editing
 * off, every sim pin released, the notice) and the bench releases the same and ends its script with the error. The
 * teardown and the failure releases dispose the sim. The streaming route's actions (the clicks, the smoke's hook) post
 * through `createActionPost`, which records each accepted one in the block history (`blockHistory.ts`, §4.5), and
 * Ctrl+Z / Ctrl+Y undo and redo blocks while the world owns the controls, the map's settings while the map does.
 */
import { MEDIUM } from '../../core/params/graphicsPresets';
import { OPENING_T, TIME_SPEEDS } from '../../daynight/dayNight';
import { probeCapabilities } from '../../engine/capabilities';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../engine/capabilityRules';
import {
  createCoordinator, createCoordinatorCounts, phaseName, progressFraction, worldJobsOf, type Coordinator, type StreamEvent,
} from '../../engine/coordinator';
import { appliedDraftOf, type WorldStage } from '../../engine/invalidation';
import { RD_MAX, reservationRdCap, resolveRenderDistance } from '../../engine/renderDistance';
import type { Stage } from '../../engine/rings';
import type { WorldSession } from '../../engine/session';
import { SimFailed, createBrowserSim, type SimClient } from '../../engine/simClient';
import { createThrottle } from '../../engine/throttle';
import { createUploadBudget } from '../../engine/uploadBudget';
import { StoreFullError, WorkerFailed, createBrowserPool, poolSize, type WorkerPool } from '../../engine/workerPool';
import { SPEED_DEFAULT, applyCameraRotation, look, lookVectorInto, stepSpeed, type FlyState } from '../../player/fly';
import { attachInput, isTextEntry } from '../../player/input';
import { createHotbar, type Hotbar } from '../../player/hotbar';
import { bodyOf, breakAt, emptyBucketAt, pickAt, placeAt, type BodyBox } from '../../player/interaction';
import { DEFAULT_KEYMAP, type Action } from '../../player/keymap';
import { REACH_FLY, castRay, createRayHit, type RayHit } from '../../player/raycast';
import { createFpsLimiter, type FpsLimiter } from '../../render/fpsLimiter';
import type { FrameState } from '../../render/frameState';
import { createWorldRenderer, type GpuEstimate, type WorldRenderer } from '../../render/renderer';
import { createSectionRendererCounts, selectSectionRenderer, type SectionRendererKind } from '../../render/sectionRenderer';
import { outlineBounds } from '../../render/selection';
import type { Edit } from '../../workers/protocol';
import { SIM_THREAD } from '../../world/store/reclaim';
import { createStore, type VoxelStore } from '../../world/store/store';
import { renderErrorScreen } from '../capabilityReport';
import { el } from '../common/dom';
import { installShortcuts } from '../common/keys';
import type { NoticeOptions, Notices } from '../common/notice';
import { createUrlWriter, oversizeNotice } from '../common/urlWriter';
import { createFrameStats } from '../frameStats';
import { mountHelp, type Help } from '../help';
import { mountPalette, type Palette } from '../palette';
import { mountWorldHud } from '../hud';
import { mountLoadingScreen } from '../loading/loadingScreen';
import { tips } from '../loading/tips';
import { decodeMapState, openMapSession } from '../map/mapState';
import { createPreviewDriver, createReplayingCanvas, draftOf, isSpawnError, type DriverStatus, type PreviewDriver } from '../map/previewDriver';
import { cryptoSeed } from '../seedBox';
import { SETTINGS_DEFAULTS, loadSettings, saveSettings, type WorldSettings } from '../settings';
import {
  BENCH_IDLE_FRAMES, BENCH_REFILL, BENCH_TIME_SPEED, benchInterval, createBenchRecorder, createLiveReveals, jsHeapMB, type BenchDriver,
  type BenchPose,
} from './bench';
import { firstView } from './firstView';
import type { FlightContext } from './flight';
import { createFogEase, createFogStep, filledRadius } from './fogEase';
import { createFrameClock, createFrameNotice, lowerRd } from './frameNotice';
import { coversWorld, createApplyControl, createEpochs, updateAuxPolicy } from './applyControl';
import { createEditLatency } from './editLatency';
import { mountBuildHud } from './buildHud';
import { createActionPost, createBlockHistory, type BlockHistory } from './blockHistory';
import { createEditPath, type EditOutcome } from './editPath';
import { createFrameStep, eyeSkyLight } from './frameStep';
import { createMapOverlay, followSession, frameCapFor, worldMapView, type ControlsOwner, type MapOverlay } from './mapOverlay';
import { createReloader, createWorldUrl, installLeaveGuard, navigateTo, type Reloader } from './reload';
import { Y_MAX, Y_MIN, type WorldQuery } from './query';
import { createTeleport, type Teleport, type TeleportLanding } from './teleport';

/** The capture and test options (ruling P48). */
export interface WorldPageOptions {
  /** The HUD; default true. */
  readonly hud?: boolean;
  /**
   * The overlay; default true. False: no "Click to fly", and at the reveal the loading screen is removed at once
   * instead of fading out (before the reveal it still shows the progress and failures).
   */
  readonly overlay?: boolean;
  /** Fixes and pauses the clock at this hour (t = (((h − 6)/24) % 1 + 1) % 1); null or absent: 08:00 at ×1. */
  readonly timeHours?: number | null;
  /** The camera's height above `MOTION_BLOCKING` when the query gives no y; default 2. */
  readonly eyeAbove?: number;
  /** Called with n = 1, 2, … for each frame rendered after the reveal frame. */
  readonly onFrame?: (n: number) => void;
  /** The world renderer's factory (a test's fake); default `createWorldRenderer`. */
  readonly createRenderer?: typeof createWorldRenderer;
  /**
   * The flight route's hook (SP4a spec §9.5): with it the stored settings are not read (the defaults apply), and at the
   * reveal the page removes the loading screen and hands the frame loop to `flight` instead of starting its own (no
   * input, HUD, help, notices or leave guard).
   */
  readonly flight?: (ctx: FlightContext) => void;
  /**
   * The bench route's driver (SP4b spec §8.3, `bench.ts`): with it the stored settings are not read, and after the
   * reveal the page runs its own streaming frame with no input, HUD, help, notices or leave guard, the clock from 08:00
   * at ×60; after `BENCH_IDLE_FRAMES` idle frames it calls `pose` before each frame step, applies the RD it returns
   * when it changes, records every rendered frame into `record`, and calls `done` when `pose` returns null.
   */
  readonly bench?: BenchDriver;
  /**
   * The smoke's test hook (SP4c spec §8.6), given by `main.ts` under `?wiTest=1` only: the streaming route counts the
   * map's tile requests on the pool it hands the overlay, records each teleport's landing, and attaches its parts.
   */
  readonly wiTest?: WiTestInstall;
}

declare global {
  interface Window {
    /**
     * The page's progress for the browser tools (SP4a spec §9.6; ruling P48), set on every mount: `revealed` turns true
     * in the reveal frame, and `frames` is the n of the frames rendered after it (as `onFrame` receives it).
     */
    __wiWorld?: { revealed: boolean; frames: number };
  }
}

/** The load's figures for the flight JSON (SP4a spec §8.4, §9.5). */
export interface LoadStats {
  /** ms from `mountWorldPage` to the reveal frame; null before it. */
  revealMs: number | null;
  /** ms from the coordinator's start until each stage's last column finished (read once per frame); null while it runs. */
  stageMs: Record<Stage, number | null>;
  /** The section renderer's structural ms at the reveal (`counts(out).structuralMs`: RegionMesh's merges in SP4a). */
  mergeMs: number;
  /** Main-thread long tasks from the mount to the reveal; null without `PerformanceObserver('longtask')` (Firefox). */
  longTasks: { count: number; maxMs: number } | null;
  /** The largest frame delta (ms) over the first 120 frames after the reveal; null until 120 frames. */
  first120MaxMs: number | null;
}

export interface WorldPage {
  /** 'revealed' once the world shows; 'failed' when the failure panel or the error screen shows instead. */
  readonly state: 'loading' | 'revealed' | 'failed';
  readonly loadStats: Readonly<LoadStats>;
  dispose(): void;
}

/** The loading screen's per-frame upload budget, with no row or structural cap (SP4b spec §3.9; SP4a spec §6.2). */
const LOAD_UPLOAD_MS = 12;
/** The overlay's fade at the reveal (spec §8.4). */
const FADE_MS = 300;
/** Frames rendered behind the opaque overlay before the reveal (spec §8.4). */
const WARM_UP_FRAMES = 3;
/** Frames after the reveal whose largest delta is recorded (spec §8.4). */
const FIRST_FRAMES = 120;
/** Mouse look at sensitivity ×1, in degrees per pixel of movement; the setting multiplies it (spec §7.1, §7.4). */
const LOOK_DEG_PER_PIXEL = 0.15;
const STAGES: readonly Stage[] = ['T', 'D', 'L', 'MESH'];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** `localStorage`, or null when reading it throws (private mode, blocked site data; ruling P36). */
function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The failure panel's one-line cause for a load error: `e` is the error, or the cause of the coordinator's `fatal` event
 * with that event's `message` (SP4b spec §3.6).
 */
function causeOf(e: unknown, message: string | null = null): string {
  if (e instanceof StoreFullError) return 'The world store is full: a lower render distance needs less of it.';
  if (e instanceof WorkerFailed) return `A worker failed: ${e.message}`;
  if (message !== null) return `Streaming stopped: ${message}`;
  return `The world could not load: ${errorText(e)}`;
}

/**
 * The eye's sky light 0-15 (spec §6.6) inside one read section of the store (SP4b spec §2.4, §2.5), before the reveal:
 * 15 above y 319 and over a column that is not Published (streaming has no disc: a column outside the loaded set reads
 * as open sky), 0 below −64. After the reveal the frame step reads it through the same `eyeSkyLight`, keeping its last
 * value instead of 15 over a column not Published (SP4c spec §3.4).
 */
function skyLightAt(store: VoxelStore, x: number, y: number, z: number): number {
  store.enterRead();
  try {
    return eyeSkyLight(store, x, y, z, 15);
  } finally {
    store.exitRead();
  }
}

/**
 * `MOTION_BLOCKING` at block (x, z) through `store.heightAt` (no view, SP4b spec §2.4); +∞ for a column that is not
 * Published (never the lowest).
 */
function motionBlockingAt(store: VoxelStore, x: number, z: number): number {
  return store.heightAt('motionBlocking', Math.floor(x), Math.floor(z)) ?? Number.POSITIVE_INFINITY;
}

/** Block (x, y, z)'s value (`state << 8 | fluid`, SP5a spec §2.1) read inside a read section; 0 when its column is not Published. */
function voxelValue(store: VoxelStore, x: number, y: number, z: number): number {
  store.enterRead();
  try {
    const b = store.blockAt(x, y, z);
    return b < 0 ? 0 : ((b << 8) | store.fluidAt(x, y, z)) >>> 0;
  } finally {
    store.exitRead();
  }
}

/** The state at block (x, y, z) read inside a read section (`VoxelStore.blockAt`). */
function blockRead(store: VoxelStore, x: number, y: number, z: number): number {
  store.enterRead();
  try {
    return store.blockAt(x, y, z);
  } finally {
    store.exitRead();
  }
}

/** Whether block (x, z) holds water at its top: `MOTION_BLOCKING` (which counts fluid) above `OCEAN_FLOOR` (which does not). */
function hasWaterAt(store: VoxelStore, x: number, z: number): boolean {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const top = store.heightAt('motionBlocking', bx, bz);
  const floor = store.heightAt('oceanFloor', bx, bz);
  return top !== null && floor !== null && top > floor;
}

/** The store's SharedArrayBuffers (column table, epochs, the reclaim buffer and both pools' buffers) in MiB. */
function storeSabMiB(store: VoxelStore): number {
  const h = store.handles();
  const pools = [h.blocks, h.bytes].flatMap((p) => [p.data, p.ctl, p.stack, p.refs]);
  return [h.table, h.epochs, h.reclaim, ...pools].reduce((sum, b) => sum + b.byteLength, 0) / (1 << 20);
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * What the failure panel frees (spec §8.5): the long-task observer, the sim worker (SP5a spec §2.1), the pool and the
 * renderer with its WebGL context, so a load that failed (StoreFull on a weak machine) holds no workers or GPU memory
 * behind the panel (final review B-M4). Each step guarded (`runTeardown`): a release that throws skips none of the later
 * ones (final review UI-6).
 */
export function releaseOnFailure(o: {
  readonly longTasks: { disconnect(): void } | null;
  readonly sim?: { dispose(): void } | null;
  readonly pool: { terminate(): void } | null;
  readonly renderer: { dispose(): void } | null;
}, onError: (e: unknown) => void): void {
  runTeardown([() => o.longTasks?.disconnect(), () => o.sim?.dispose(), () => o.pool?.terminate(), () => o.renderer?.dispose()], onError);
}

/**
 * A failure before the reveal (SP4a spec §8.3): the loading screen's failure panel first, then what `releaseOnFailure`
 * frees, the panel guarded as each release, then `settle`. A release that throws (a renderer whose context is gone)
 * can neither hide the panel nor leave `mountWorldPage` unresolved, as `stopAfterFailure` after the reveal (final
 * review UI-6).
 */
export function failBeforeReveal(o: {
  show(): void;
  readonly release: Parameters<typeof releaseOnFailure>[0];
  settle(): void;
  onError(e: unknown): void;
}): void {
  runTeardown([o.show, () => releaseOnFailure(o.release, o.onError)], o.onError);
  o.settle();
}

/**
 * Calls `step` once per frame (scheduled through `request`) until it returns true, then resolves. A throw from `step`
 * rejects with it and requests no further frame: an error while building is a load error that must reach the failure
 * panel (SP4a spec §8.3), not die uncaught in a rAF callback and surface 30 s later as the watchdog's "stall".
 */
export function everyFrameUntil(request: (cb: () => void) => void, step: () => boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      let done: boolean;
      try {
        done = step();
      } catch (e) {
        reject(e);
        return;
      }
      if (done) resolve();
      else request(tick);
    };
    request(tick);
  });
}

/**
 * The RD a reload after the reveal carries (the failure panel's and the context loss's, SP4b spec §7.4): without a
 * query rd none, so the setting applies (it holds every live change); a query's rd is replaced by the RD in force, so a
 * live change made since the load survives, and an RD the loading screen's "lower RD" link set is not lost for the
 * setting's or the default's (final review UI-3).
 */
export function reloadRd(queryRd: number | null, liveRd: number): number | null {
  return queryRd === null ? null : liveRd;
}

/**
 * Runs every teardown step in order, each guarded (SP4b ruling R5): a step that throws (the coordinator's dispose
 * sweep meeting a `StoreCorrupt`, a renderer whose context is gone) is reported through `onError`, and the later steps
 * (the loading screen, the renderer, the pool, the root) still run.
 */
export function runTeardown(steps: ReadonlyArray<() => void>, onError: (e: unknown) => void): void {
  for (const step of steps) {
    try {
      step();
    } catch (e) {
      onError(e);
    }
  }
}

/**
 * A failure after the reveal (SP4b spec §7.4): stops the frame loop, closes the map overlay and disposes its tool (SP4c
 * spec §1.3, D27: the map never works on a released pool), shows the failure panel, then runs the release steps (the
 * HUD's timer, the teleport (ruling R5), the coordinator, the pool, the renderer), the overlay, the panel and each
 * release guarded as the teardown's (`runTeardown`): a release that throws (a `StoreCorrupt` in the coordinator's
 * sweep, a renderer whose context is gone, a tool's dispose) can neither hide the panel nor skip a later release (Task
 * 21 review M2).
 */
export function stopAfterFailure(o: {
  stop(): void;
  /** Disposes the map overlay before the panel shows (the streaming route; the bench has none). */
  closeMap?(): void;
  show(): void;
  readonly release: ReadonlyArray<() => void>;
  onError(e: unknown): void;
}): void {
  o.stop();
  runTeardown([() => o.closeMap?.(), o.show, ...o.release], o.onError);
}

/**
 * The page's notices over the world (spec §8.5; Review Focus 5; SP4b spec §3.6, §7.4); SP4a's edge notice is gone
 * (SP4b spec §6.2).
 */
export interface WorldNotices {
  /**
   * The dismissible "Frames are slow at RD <rd>" (spec §8.5) with a "Lower to RD <lower>" button calling `apply`, which
   * lowers the render distance live (SP4b spec §5) and closes the notice; never applied on its own. A later call
   * replaces it.
   */
  slow(rd: number, lower: number, apply: () => void): void;
  /** "The graphics context was lost" with a Reload link to `href` through the reloader; shown once. */
  contextLost(href: string): void;
  /**
   * "Some terrain could not be generated" (a column skipped after a failed retry, SP4b spec §3.6), dismissible, with
   * "Copy details" copying `details`; shown once per page.
   */
  skipped(details: string): void;
  /**
   * The world store is full (SP4b spec §3.6, §5): a dismissible notice with a "Lower to RD n" button calling `apply`
   * (the render distance lowered live, the notice closed), without the button when `lower` is null (RD 4); never
   * applied on its own. A later call replaces it.
   */
  storeFull(lower: number | null, apply: () => void): void;
  /**
   * The failure panel after the reveal (SP4b spec §7.4): the cause, "Copy details" copying `details`, and a Reload link
   * to `reloadHref` through the reloader; shown once.
   */
  failed(cause: string, details: string, reloadHref: string): void;
  /**
   * A notice shaped as `Notices.show` (`common/notice.ts`), so the page's `oversizeNotice(worldNotices)` works (SP4c
   * spec §1.6): one per text (showing the same text again replaces it), `world-notice-error` for kind 'error', each
   * action a button that runs it and removes the notice, a "Dismiss" button, and `timeoutMs` removing it. Nothing after
   * `dispose`.
   */
  show(text: string, o?: NoticeOptions): void;
  /** Removes the notice `show` put up with `text`, if any (a notice that stays until its condition ends). */
  hide(text: string): void;
  /**
   * While the map covers the 3D (SP4c spec §2.1, D27): with `target` non-null, `show` and `storeFull` go to `target`
   * (the tool's notice row) instead of `.world-notices`; `null` sends them back. A notice that stays until its
   * condition ends or the user dismisses it (StoreFull, a `show` with no `timeoutMs`: the URL oversize, the Watch-live
   * notice) moves on every change of route, taken down where it was and shown in the new place, so it is never left
   * under the opaque overlay nor in the hidden tool's row, and shows once (final review WLD-2); a timed notice ends
   * where it was shown. `hide` removes the text here and in the last target routed to. The slow-frame, skipped,
   * failure and context-loss notices never route (the overlay is disposed before the last two).
   */
  route(target: Notices | null): void;
  /** Removes the notices and clears their timers. */
  dispose(): void;
}

/** A link whose click is prevented and reloads `href()` through the reloader instead (ruling P50). */
function reloadLink(reloader: Reloader, id: string, text: string, href: () => string): HTMLAnchorElement {
  const a = el('a', 'world-notice-link', text);
  a.id = id;
  a.href = href();
  a.addEventListener('click', (e) => {
    e.preventDefault();
    reloader.reload(href());
  });
  return a;
}

/** A "Copy details" button copying `text()`; it reads "Copied", or "Copy failed" without a clipboard. */
function copyButton(id: string, text: () => string): HTMLButtonElement {
  const copy = el('button', 'world-notice-dismiss', 'Copy details');
  copy.id = id;
  copy.type = 'button';
  copy.addEventListener('click', () => {
    const failed = (): void => { copy.textContent = 'Copy failed'; };
    try {
      const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
      if (clipboard === undefined) failed();
      else clipboard.writeText(text()).then(() => { copy.textContent = 'Copied'; }, failed);
    } catch {
      failed();
    }
  });
  return copy;
}

/**
 * A "Lower to RD <lower>" button: a click removes `panel` (and calls `then`), then calls `apply`, which lowers the render
 * distance live (SP4b spec §5).
 */
function lowerButton(id: string, lower: number, panel: HTMLElement, then: () => void, apply: () => void): HTMLButtonElement {
  const button = el('button', 'world-notice-dismiss', `Lower to RD ${lower}`);
  button.id = id;
  button.type = 'button';
  button.addEventListener('click', () => {
    panel.remove();
    then();
    apply();
  });
  return button;
}

/** A "Dismiss" button removing `panel` (and calling `then`). */
function dismissButton(id: string, panel: HTMLElement, then: () => void = () => {}): HTMLButtonElement {
  const dismiss = el('button', 'world-notice-dismiss', 'Dismiss');
  dismiss.id = id;
  dismiss.type = 'button';
  dismiss.title = 'Dismiss this notice';
  dismiss.addEventListener('click', () => {
    panel.remove();
    then();
  });
  return dismiss;
}

/** StoreFull's text (SP4b spec §3.6), in `.world-notices` or, routed, in the tool's notice row. */
const STORE_FULL_TEXT = 'The world store is full: new terrain is paused.';

/** Mounts the notices' container in `host`; each notice is built when first shown. */
export function createWorldNotices(host: HTMLElement, reloader: Reloader): WorldNotices {
  const box = el('div', 'world-notices');
  box.id = 'world-notices';
  host.append(box);
  /** Where `show`, `hide` and `storeFull` go while the map covers the 3D (D27), and the last one routed to. */
  let target: Notices | null = null;
  let lastTarget: Notices | null = null;
  let slow: HTMLElement | null = null;
  let full: HTMLElement | null = null;
  let lost = false;
  let skippedShown = false;
  let failedShown = false;
  let disposed = false;
  /** `show`'s notices by text, with their timeout. */
  const byText = new Map<string, { readonly panel: HTMLElement; readonly timer: ReturnType<typeof setTimeout> | null }>();
  /**
   * The notices up that stay until their condition ends or the user dismisses them, by text, with what shows them
   * again: each moves on a change of route (final review WLD-2). StoreFull's entry is `STORE_FULL_TEXT`.
   */
  const standing = new Map<string, NoticeOptions>();
  /** StoreFull's arguments while it stands, for its panel in `.world-notices`. */
  let fullArgs: { readonly lower: number | null; readonly apply: () => void } | null = null;
  /** Removes `text`'s notice; with `panel`, only when it is still that one (a replaced notice's late timer or click). */
  const hide = (text: string, panel: HTMLElement | null = null): void => {
    const entry = byText.get(text);
    if (entry === undefined || (panel !== null && entry.panel !== panel)) return;
    byText.delete(text);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.panel.remove();
  };
  /** The user dismissed a standing notice (here or in the tool's row): it moves no more. */
  const dismissed = (text: string): void => {
    standing.delete(text);
    if (text === STORE_FULL_TEXT) fullArgs = null;
  };
  /** Shows `text` in `.world-notices` (`show`'s panel). */
  const showHere = (text: string, opts: NoticeOptions): void => {
    hide(text);
    const stays = opts.timeoutMs === undefined;
    const panel = el('div', opts.kind === 'error' ? 'world-notice world-notice-error' : 'world-notice', `${text} `);
    for (const action of opts.actions ?? []) {
      const b = el('button', 'world-notice-dismiss', action.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        try { action.run(); } finally {
          hide(text, panel);
          if (stays) dismissed(text);
        }
      });
      panel.append(b, ' ');
    }
    const dismiss = el('button', 'world-notice-dismiss', 'Dismiss');
    dismiss.type = 'button';
    dismiss.title = 'Dismiss this notice';
    dismiss.addEventListener('click', () => {
      hide(text, panel);
      if (stays) dismissed(text);
    });
    panel.append(dismiss);
    const timer = stays ? null : setTimeout(() => hide(text, panel), opts.timeoutMs);
    byText.set(text, { panel, timer });
    box.append(panel);
  };
  /** StoreFull's panel in `.world-notices`, with its ids and its "Lower to RD n". */
  const fullHere = (lower: number | null, apply: () => void): void => {
    full?.remove();
    const panel = el('div', 'world-notice', `${STORE_FULL_TEXT} `);
    panel.id = 'world-store-full';
    const forget = (): void => {
      if (full !== panel) return;
      full = null;
      dismissed(STORE_FULL_TEXT);
    };
    if (lower !== null) panel.append(lowerButton('world-store-full-lower', lower, panel, forget, apply), ' ');
    panel.append(dismissButton('world-store-full-dismiss', panel, forget));
    full = panel;
    box.append(panel);
  };
  /** Shows the standing `text` where the route points now; a dismissal in the tool's row ends its standing. */
  const put = (text: string, opts: NoticeOptions): void => {
    if (target !== null) target.show(text, { ...opts, onDismiss: () => dismissed(text) });
    else if (text === STORE_FULL_TEXT && fullArgs !== null) fullHere(fullArgs.lower, fullArgs.apply);
    else showHere(text, opts);
  };
  /** Takes the standing `text` down from `from` (null: `.world-notices`). */
  const takeDown = (text: string, from: Notices | null): void => {
    if (from !== null) from.hide(text);
    else if (text === STORE_FULL_TEXT) {
      full?.remove();
      full = null;
    } else hide(text);
  };
  return {
    show(text, opts = {}) {
      if (disposed) return;
      if (opts.timeoutMs === undefined) standing.set(text, opts);
      else standing.delete(text);
      if (target !== null) {
        if (opts.timeoutMs === undefined) put(text, opts);
        else target.show(text, opts);
        return;
      }
      showHere(text, opts);
    },
    hide(text) {
      standing.delete(text);
      hide(text);
      lastTarget?.hide(text);
    },
    route(next) {
      if (next === target) return;
      const from = target;
      target = next;
      if (next !== null) lastTarget = next;
      if (disposed) return;
      for (const [text, opts] of standing) {
        takeDown(text, from);
        put(text, opts);
      }
    },
    slow(rd, lower, apply) {
      slow?.remove();
      const panel = el('div', 'world-notice', `Frames are slow at RD ${rd}. `);
      panel.id = 'world-slow-notice';
      const forget = (): void => { if (slow === panel) slow = null; };
      panel.append(
        lowerButton('world-slow-lower', lower, panel, forget, apply), ' ',
        dismissButton('world-slow-dismiss', panel, forget),
      );
      slow = panel;
      box.append(panel);
    },
    skipped(details) {
      if (skippedShown) return;
      skippedShown = true;
      const panel = el('div', 'world-notice', 'Some terrain could not be generated. ');
      panel.id = 'world-skipped-notice';
      panel.append(copyButton('world-skipped-copy', () => details), ' ', dismissButton('world-skipped-dismiss', panel));
      box.append(panel);
    },
    storeFull(lower, apply) {
      const actions = lower === null ? [] : [{ label: `Lower to RD ${lower}`, run: apply }];
      standing.set(STORE_FULL_TEXT, { kind: 'warn', actions });
      fullArgs = { lower, apply };
      if (target !== null) put(STORE_FULL_TEXT, { kind: 'warn', actions });
      else fullHere(lower, apply);
    },
    failed(cause, details, reloadHref) {
      if (failedShown) return;
      failedShown = true;
      const panel = el('div', 'world-notice world-notice-error', 'The world stopped. ');
      panel.id = 'world-failed';
      const text = el('span', 'world-notice-cause', cause);
      text.id = 'world-failed-cause';
      panel.append(text, ' ', copyButton('world-failed-copy', () => details), ' ', reloadLink(reloader, 'world-failed-reload', 'Reload', () => reloadHref));
      box.append(panel);
    },
    contextLost(href) {
      if (lost) return;
      lost = true;
      const panel = el('div', 'world-notice world-notice-error', 'The graphics context was lost. ');
      panel.id = 'world-context-lost';
      panel.append(reloadLink(reloader, 'world-context-reload', 'Reload', () => href));
      box.append(panel);
    },
    dispose() {
      disposed = true;
      standing.clear();
      fullArgs = null;
      for (const text of [...byText.keys()]) hide(text);
      box.remove();
    },
  };
}

/** How long the "Undo" or "Redo" notice stays at the bottom of the 3D (SP4c spec §2.4, D15). */
export const UNDO_NOTICE_MS = 1500;

/**
 * The undo notice (SP4c spec §2.4, §4.3; D15, D26), hung on the apply control: it remembers the kind of the session's
 * last change (`'undo'`, `'redo'` or other), and `applied(from)` (the page's `onApplied`) shows "Undo" or "Redo" for
 * `UNDO_NOTICE_MS` when that kind is an undo or a redo and the map is hidden; an undo that rebuilds nothing (`from`
 * null) shows it too. Each change shows it at most once: an Apply consumes the kind. `dispose` unsubscribes.
 */
export function createUndoNotice(o: {
  subscribe: WorldSession['subscribe'];
  mapShown(): boolean;
  show(text: string, ms: number): void;
}): { applied(from: WorldStage | null): void; dispose(): void } {
  let last: 'Undo' | 'Redo' | null = null;
  const unsubscribe = o.subscribe((_s, change) => {
    last = change.kind === 'undo' ? 'Undo' : change.kind === 'redo' ? 'Redo' : null;
  });
  return {
    applied() {
      const text = last;
      last = null;
      if (text !== null && !o.mapShown()) o.show(text, UNDO_NOTICE_MS);
    },
    dispose: unsubscribe,
  };
}

/**
 * Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z) by who has the controls (SP5a spec §4.5, D13; SP4c spec §2.4): while the world
 * owns them (`owner`, the overlay's `ownerOf`) the block history, while the map does the session's params; through
 * `installShortcuts`, so never in text entry and each handled key's default prevented. Returns the remover.
 */
export function installUndoKeys(o: {
  owner(): ControlsOwner;
  blocks: Pick<BlockHistory, 'undo' | 'redo'>;
  session: Pick<WorldSession, 'undo' | 'redo'>;
}): () => void {
  return installShortcuts((a) => {
    const world = o.owner() === 'world';
    if (a === 'undo') {
      if (world) o.blocks.undo();
      else o.session.undo();
    } else if (a === 'redo') {
      if (world) o.blocks.redo();
      else o.session.redo();
    }
  }, (a) => a === 'undo' || a === 'redo');
}

/**
 * The page's `webglcontextlost` handler (Review Focus 5): through `WorldRenderer.onContextLost`, it stops the frame
 * loop once, closes the map overlay and disposes its tool (SP4c spec §1.3, D27; a throw reported through `onError`),
 * and shows "The graphics context was lost" with a Reload link around the camera (`hereHref`, read at the loss).
 * Without it the page would freeze on its last frame with no explanation.
 */
export function handleContextLoss(
  wr: Pick<WorldRenderer, 'onContextLost'>,
  o: { stop(): void; closeMap(): void; readonly notices: WorldNotices; hereHref(): string; onError(e: unknown): void },
): void {
  let lost = false;
  wr.onContextLost(() => {
    if (lost) return;
    lost = true;
    o.stop();
    runTeardown([o.closeMap, () => o.notices.contextLost(o.hereHref())], o.onError);
  });
}

/**
 * The page's `driver.onStatus` after the reveal (SP4c spec §4.3): the session validates every draft (tier 2 included)
 * before the driver sees it, so a refused configure is a bug and fatal: an `error` calls `fail` (the failure panel with
 * "Copy details"), with the error as the cause's detail. A status without one does nothing, and so does a spawn error
 * (rulings R3: the map's spawn-marker query holds nothing of the world; it stays on the map's marker).
 */
export function onDriverStatus(s: DriverStatus, fail: (cause: string, e: unknown) => void): void {
  if (s.error === null || isSpawnError(s.error)) return;
  fail(`Live editing stopped: ${s.error}`, new Error(s.error));
}

/**
 * Flushes the world's URL writer on `pagehide` (Task 20b, as `?map` does: `mapPage.ts`), so an F5 or a navigation within
 * the 200 ms debounce of an Apply or a view change still keeps it. Returns the remover the page's teardown runs.
 */
export function flushOnPageHide(
  win: { addEventListener(type: 'pagehide', fn: () => void): void; removeEventListener(type: 'pagehide', fn: () => void): void },
  writer: { flush(): void },
): () => void {
  const onPageHide = (): void => writer.flush();
  win.addEventListener('pagehide', onPageHide);
  return () => win.removeEventListener('pagehide', onPageHide);
}

/**
 * The browser smoke's test hook (SP4c spec §8.6): `window.__wiTest`, installed by `main.ts` before the world page mounts
 * and only under `?wiTest=1` (absent otherwise). The smoke reads the leak baseline and check through it (the session's
 * listeners, the pending timers, the map's tile requests), closes the overlay and disposes the tool, forces a fatal
 * error, and reads the controls owner, the stale count and the last teleport's landing; it edits a block through the
 * page's edit path and reads one back (SP5a spec §6.4).
 */
export interface WiTest {
  /** The session's listeners (`WorldSession.listenerCount`). */
  listenerCount(): number;
  /** The pending `setTimeout` and `setInterval` timers, through the counting wrappers `installWiTest` put on the window. */
  timers(): number;
  /** The `tile` calls on the pool the map overlay was given, since the hook was installed. */
  tileRequests(): number;
  /** Closes the map overlay (`MapOverlay.close`). */
  closeOverlay(): void;
  /** Disposes the mounted map tool, not the overlay (whose own listeners are part of the baseline); no API remounts it. */
  disposeTool(): void;
  /** A fatal error after the reveal, through the page's `fail` (the failure panel). */
  forceFatal(): void;
  /** The controls owner, 'world' or 'map' (SP4c spec §2.3). */
  owner(): string;
  /** The coordinator's stale count (`CoordinatorCounts.stale`, SP4c spec §4.5). */
  stale(): number;
  /**
   * The last teleport's landing as `onArrive` received it, `water` null for −∞ (which CDP's `returnByValue` cannot
   * carry); null before one.
   */
  lastLanding(): { readonly surface: number; readonly water: number | null; readonly y: number } | null;
  /**
   * Sets block (x, y, z) to `state` with fluid byte `fluid` through the page's edit path (SP5a spec §6.4), its `expect`
   * the voxel's value now: 'ok', or the refusal (`EditOutcome`'s `why`); an accepted edit is a block-history step.
   */
  edit(x: number, y: number, z: number, state: number, fluid: number): Promise<string>;
  /** The state at block (x, y, z), read inside a read section (`VoxelStore.blockAt`: −1 when its column is not Published). */
  blockAt(x: number, y: number, z: number): number;
}

/** The parts of the hook the world page supplies once its streaming route runs. */
export type WiTestPage = Pick<WiTest, 'listenerCount' | 'closeOverlay' | 'disposeTool' | 'forceFatal' | 'owner' | 'stale' | 'edit' | 'blockAt'>;

/** The hook's installation, which `main.ts` hands the page (`WorldPageOptions.wiTest`). */
export interface WiTestInstall {
  readonly hook: WiTest;
  /** The page's parts; until then they throw. */
  attach(page: WiTestPage): void;
  /** `pool` with its `tile` calls counted into `tileRequests`. */
  countTiles<P extends { tile(...args: never[]): unknown }>(pool: P): P;
  /** Records a teleport's landing for `lastLanding`. */
  landed(landing: TeleportLanding): void;
}

/** A window's four timer functions, replaced in place by `countPendingTimers`. */
export interface TimerHost {
  setTimeout: Window['setTimeout'];
  clearTimeout: Window['clearTimeout'];
  setInterval: Window['setInterval'];
  clearInterval: Window['clearInterval'];
}

/**
 * Wraps `win`'s timer functions so that the timers pending at any moment can be counted: a timeout until it fires or is
 * cleared, an interval until it is cleared. The ids are the real ones. Returns the counter.
 */
export function countPendingTimers(win: TimerHost): () => number {
  const pending = new Set<number>();
  const setT = win.setTimeout.bind(win);
  const clearT = win.clearTimeout.bind(win);
  const setI = win.setInterval.bind(win);
  const clearI = win.clearInterval.bind(win);
  win.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]): number => {
    if (typeof handler !== 'function') return setT(handler, ms, ...args);
    const fn = handler as (...a: unknown[]) => void;
    const id = setT((...a: unknown[]) => {
      pending.delete(id);
      fn(...a);
    }, ms, ...args);
    pending.add(id);
    return id;
  }) as Window['setTimeout'];
  win.clearTimeout = ((id?: number): void => {
    if (id !== undefined) pending.delete(id);
    clearT(id);
  }) as Window['clearTimeout'];
  win.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]): number => {
    const id = setI(handler, ms, ...args);
    pending.add(id);
    return id;
  }) as Window['setInterval'];
  win.clearInterval = ((id?: number): void => {
    if (id !== undefined) pending.delete(id);
    clearI(id);
  }) as Window['clearInterval'];
  return () => pending.size;
}

/** `pool` with its `tile` calls counted through `onTile`; every other member (getters included) read from `pool`. */
export function countTileCalls<P extends { tile(...args: never[]): unknown }>(pool: P, onTile: () => void): P {
  const tile = (...args: never[]): unknown => {
    onTile();
    return pool.tile(...args);
  };
  return new Proxy(pool, {
    get: (target, key) => (key === 'tile' ? tile : Reflect.get(target, key, target)),
  });
}

/**
 * The hook's `edit` (SP5a spec §6.4): sets block (x, y, z) to `state` with fluid byte `fluid` through the page's action
 * post (`createActionPost`, so an accepted edit is a block-history step like a click), its `expect` the voxel's value
 * now (`read`); 'ok', or the refusal's `why`.
 */
export function createHookEdit(
  post: (edits: readonly Edit[]) => Promise<EditOutcome>,
  read: (x: number, y: number, z: number) => number,
): WiTest['edit'] {
  return async (x, y, z, state, fluid) => {
    const r = await post([{ x, y, z, op: 'set', value: ((state << 8) | fluid) >>> 0, expect: read(x, y, z) }]);
    return r.ok ? 'ok' : r.why;
  };
}

/**
 * Installs the smoke's test hook on `win` (`win.__wiTest`), the timer counters first; `main.ts` calls it under
 * `?wiTest=1` only.
 */
export function installWiTest(win: TimerHost & { __wiTest?: WiTest }): WiTestInstall {
  const timers = countPendingTimers(win);
  let page: WiTestPage | null = null;
  let tiles = 0;
  let landing: { readonly surface: number; readonly water: number | null; readonly y: number } | null = null;
  const attached = (): WiTestPage => {
    if (page === null) throw new Error('__wiTest: the world page is not attached yet (it attaches after the reveal)');
    return page;
  };
  const hook: WiTest = {
    listenerCount: () => attached().listenerCount(),
    timers,
    tileRequests: () => tiles,
    closeOverlay: () => attached().closeOverlay(),
    disposeTool: () => attached().disposeTool(),
    forceFatal: () => attached().forceFatal(),
    owner: () => attached().owner(),
    stale: () => attached().stale(),
    lastLanding: () => landing,
    edit: (x, y, z, state, fluid) => attached().edit(x, y, z, state, fluid),
    blockAt: (x, y, z) => attached().blockAt(x, y, z),
  };
  win.__wiTest = hook;
  return {
    hook,
    attach(p) { page = p; },
    countTiles: (pool) => countTileCalls(pool, () => { tiles++; }),
    landed(l) { landing = { surface: l.surface, water: Number.isFinite(l.water) ? l.water : null, y: l.y }; },
  };
}

/** The notice of the sim's failure (SP5a spec §2.1); it stays until dismissed. */
export const EDIT_FAILED_NOTICE = 'Editing stopped: the edit worker failed; this session\'s edits are lost';

/**
 * The sim's failure (SP5a spec §2.1), which the route calls from the sim client's `onFailure`, before the client rejects
 * the pending batches: thread 15 marked dead (its reader epoch no longer holds releases in limbo), the edit path
 * disabled, every sim pin released (`simUnpinAll`, so a pending post's rejection needs no `simUnpin`) and the notice
 * shown with no timeout. The world keeps streaming.
 */
export function onSimFailure(o: {
  store: Pick<VoxelStore, 'markDead'>;
  coordinator: Pick<Coordinator, 'simUnpinAll'>;
  editPath: { disable(): void };
  notices: Pick<WorldNotices, 'show'>;
}): void {
  o.store.markDead(SIM_THREAD);
  o.editPath.disable();
  o.coordinator.simUnpinAll();
  o.notices.show(EDIT_FAILED_NOTICE, { kind: 'error' });
}

/**
 * The page's handling of the coordinator's events after the reveal (SP4b spec §3.6, §7.4, D12): `fatal` (no live
 * worker, `StoreCorrupt`, more than 32 failed columns) calls `fail` with the panel's cause (its message in it) and the
 * event's cause; `skipped` shows the dismissible "Some terrain could not be generated" once, its details naming the
 * column; `storeFull` shows the notice whose "Lower to RD n" calls `lower(n)` (never applied on its own).
 */
export function handleStreamEvent(
  e: StreamEvent,
  o: { readonly notices: WorldNotices; fail(cause: string, e: unknown): void; lower(rd: number): void },
): void {
  switch (e.kind) {
    case 'fatal':
      o.fail(causeOf(e.cause, e.message), e.cause);
      break;
    case 'skipped':
      o.notices.skipped(`Column (${e.cx}, ${e.cz}) failed twice and is skipped until it unloads; a column that comes back into range is retried.`);
      break;
    case 'storeFull': {
      const lower = e.lowerRd;
      o.notices.storeFull(lower, () => { if (lower !== null) o.lower(lower); });
      break;
    }
  }
}

/**
 * The live render distance (SP4b spec §5, D18): `apply(rd)` sets it on the coordinator (the next `update`
 * re-classifies, collects the unloads and rebuilds) and the world renderer (`camera.far`), moves the fog's target
 * (eased outward after a raise, in at once after a lower), saves the setting and shows it in the help. `null` is
 * "Default": saved as null, `defaultRd` applied. Every change goes through it: the help's select, the slow-frame
 * notice's and StoreFull's "Lower to RD n". The help's copy is updated each time (`setRd`), so a notice's lower RD is
 * what a later FOV or brightness change sends back through `onSettings`, never the stale one.
 */
export function createRdControl(o: {
  readonly coordinator: Pick<Coordinator, 'setRenderDistance'>;
  readonly world: Pick<WorldRenderer, 'setRenderDistance' | 'camera'>;
  readonly fog: { setTarget(rd: number): void };
  readonly help: Pick<Help, 'setRd'>;
  save(rd: number | null): void;
  readonly defaultRd: number;
}): { apply(rd: number | null): void } {
  return {
    apply(rd) {
      const r = rd ?? o.defaultRd;
      o.coordinator.setRenderDistance(r);
      o.world.setRenderDistance(r);
      o.fog.setTarget(r);
      o.save(rd);
      o.help.setRd(rd);
    },
  };
}

/**
 * The RD the help's `#setting-rd` shows on load (rulings R8): the RD in force, which is the URL's (`loadRd`, clamped)
 * on a `?rd=` load and the saved setting otherwise (null: "Default"). It never shows a saved RD that is not in force.
 */
export function rdShownOnLoad(queryRd: number | null, loadRd: number, savedRd: number | null): number | null {
  return queryRd === null ? savedRd : loadRd;
}

/**
 * A change from the help (SP4b spec §5; rulings R8). The help's settings carry the RD it shows, the RD in force
 * (`shownRd`), not the saved one: the rd applies live only when it differs from `shownRd` (the RD control then saves
 * it), so the RD in force is a no-op and the saved value is not; every other change is saved with the saved rd kept.
 * The map's mode and Watch live are kept from `saved` too (SP4c spec §2.5): the help has no control for them, and its
 * copy is the one it saw at mount, which would undo a later mode switch.
 */
export function helpChange(
  saved: WorldSettings, next: WorldSettings, shownRd: number | null,
): { readonly settings: WorldSettings; readonly applyRd: boolean } {
  return {
    settings: { ...next, rd: saved.rd, mapMode: saved.mapMode, watchLive: saved.watchLive },
    applyRd: next.rd !== shownRd,
  };
}

/**
 * M (SP4c spec §2.4): toggles the map overlay; before the overlay exists it does nothing. Opening it closes the help
 * first, as the help's "Map (M)" does (§1.6), so the opaque overlay of mode A never covers an open help that the next
 * Esc would close together with the map's drawer (final review WLD-1). Closing the map leaves the help as it is.
 */
export function mapKey(help: Pick<Help, 'isOpen' | 'close'>, map: Pick<MapOverlay, 'shown' | 'toggle'> | null): void {
  if (map === null) return;
  if (!map.shown && help.isOpen) help.close();
  map.toggle();
}

/**
 * M and H with the palette open (SP5a spec §4.4, D10): the palette closes first, without requesting the lock, then the
 * key does what it does with the palette closed (`then`), so the palette never stays open under the map or the help.
 */
export function paletteFirst(palette: Pick<Palette, 'isOpen' | 'close'>, then: () => void): void {
  if (palette.isOpen) palette.close();
  then();
}

/**
 * The slow-frame notice's suggestion (SP4a spec §8.5; SP4b spec §5): at render distance `rd`, offers the next lower one
 * (`lowerRd`) in the dismissible notice, whose button applies it live through `control`; nothing at RD 4.
 */
export function offerLowerRd(notices: Pick<WorldNotices, 'slow'>, rd: number, control: { apply(rd: number | null): void }): void {
  const lower = lowerRd(rd);
  if (lower === null) return;
  notices.slow(rd, lower, () => control.apply(lower));
}

/** The most mouse buttons queued between two rendered frames; a press past them is dropped. */
const CLICK_QUEUE_CAP = 16;

/**
 * The mouse buttons pressed since the last rendered frame (SP5a spec §4.1, D6): `onButton` only queues, and the page's
 * aim runs the queue in the frame's second read section against the target aimed then, so a click never reads the store
 * outside a read section. LMB breaks (`breakAt`); RMB places the hotbar's active slot (`placeAt`: a block or a bucket's
 * source, against the flying body and the look's yaw), or with the empty bucket drains the first fluid on a `'fluid'`
 * ray from the eye (`emptyBucketAt`); each edit posted through the edit path. MMB picks the aimed type into the hotbar
 * (`pickAt` → `hotbar.pick`). A refused or missed click does nothing.
 */
export interface ClickQueue {
  push(b: 0 | 1 | 2): void;
  /** Runs every queued button against `hit` and empties the queue. Allocates nothing while it is empty. */
  run(hit: RayHit, read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>): void;
  /** Empties the queue unrun (a paused frame: the help, the palette, map mode B). */
  clear(): void;
}

export function createClickQueue(o: {
  post(edit: Edit): void;
  /** RMB places its active slot; MMB picks into it. */
  readonly hotbar: Pick<Hotbar, 'slots' | 'active' | 'pick'>;
  /** The eye and the look: the body a place must not enter, a ladder's facing, the empty bucket's ray. */
  readonly fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch'>;
  /** A place's column gate (the page: `editState === 0`). */
  editable(cx: number, cz: number): boolean;
}): ClickQueue {
  const { fly } = o;
  const buttons = new Uint8Array(CLICK_QUEUE_CAP);
  let n = 0;
  const body: BodyBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  const fluidHit = createRayHit();
  const dir = new Float64Array(3);
  const place = (hit: RayHit, read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>): Edit | null => {
    const slot = o.hotbar.slots[o.hotbar.active]!;
    if (!('tool' in slot)) return placeAt(hit, slot, fly.yaw, bodyOf('fly', fly.x, fly.y, fly.z, body), read, o.editable);
    lookVectorInto(dir, fly.yaw, fly.pitch);
    castRay(read, fly.x, fly.y, fly.z, dir[0]!, dir[1]!, dir[2]!, REACH_FLY, 'fluid', fluidHit);
    return emptyBucketAt(fluidHit, read);
  };
  return {
    push(b) {
      if (n < CLICK_QUEUE_CAP) buttons[n++] = b;
    },
    run(hit, read) {
      for (let i = 0; i < n; i++) {
        const b = buttons[i];
        if (b === 1) {
          const type = pickAt(hit);
          if (type !== null) o.hotbar.pick(type);
          continue;
        }
        const edit = b === 0 ? breakAt(hit, read) : place(hit, read);
        if (edit !== null) o.post(edit);
      }
      n = 0;
    },
    clear() {
      n = 0;
    },
  };
}

/** The page's aim: the frame's DDA hit, and the step the frame step runs inside its second read section. */
export interface Aim {
  /** The last rendered frame's hit (`hit` false: no target). */
  readonly hit: RayHit;
  /**
   * The last hit's outline box relative to the floating origin (x0, y0, z0, x1, y1, z1), computed on every hit whether
   * the outline shows or not, so the bench's `mainP95Ms` measures the update without drawing it.
   */
  readonly box: Float64Array;
  aim(read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>, paused: boolean): void;
}

/**
 * The page's aim (SP5a spec §3.5, D8), which the frame step runs on every rendered tick inside its second read section:
 * the DDA from the eye along the look (`lookVectorInto`; reach `REACH_FLY` until the walk mode), then the outline around
 * the hit (`outlineBounds`: the cell, or a box state's box), relative to the floating origin, computed on every hit;
 * then the outline set to that box, or hidden: while paused, while the pointer is free, with no target, and without the
 * HUD (captures, panoramas, the bench). The queued clicks (`clicks`) run between the two against the hit, a miss
 * included (it empties the queue); a paused frame drops them unrun. Allocates nothing.
 */
export function createAim(o: {
  readonly fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch'>;
  readonly world: Pick<WorldRenderer, 'origin' | 'setOutline' | 'hideOutline'>;
  /** True while the canvas holds the pointer lock. */
  locked(): boolean;
  /** The page's HUD option (`WorldPageOptions.hud`). */
  readonly hud: boolean;
  /** The queued mouse buttons (the streaming route's; the bench has none). */
  readonly clicks?: Pick<ClickQueue, 'run' | 'clear'>;
}): Aim {
  const { fly, world } = o;
  const hit = createRayHit();
  const dir = new Float64Array(3);
  const box = new Float64Array(6);
  return {
    hit,
    box,
    aim(read, paused) {
      lookVectorInto(dir, fly.yaw, fly.pitch);
      castRay(read, fly.x, fly.y, fly.z, dir[0]!, dir[1]!, dir[2]!, REACH_FLY, 'block', hit);
      if (paused) o.clicks?.clear();
      else o.clicks?.run(hit, read);
      if (!hit.hit) {
        world.hideOutline();
        return;
      }
      outlineBounds(hit.state, hit.x, hit.y, hit.z, box);
      const origin = world.origin;
      box[0] = box[0]! - origin.x;
      box[1] = box[1]! - origin.y;
      box[2] = box[2]! - origin.z;
      box[3] = box[3]! - origin.x;
      box[4] = box[4]! - origin.y;
      box[5] = box[5]! - origin.z;
      if (paused || !o.hud || !o.locked()) world.hideOutline();
      else world.setOutline(box[0], box[1], box[2], box[3], box[4], box[5]);
    },
  };
}

/**
 * The keys Keyboard Lock captures in fullscreen: W, T and N, so that Ctrl+W, Ctrl+T and Ctrl+N reach the page. Esc is
 * not locked, so a short Esc still frees the mouse and leaves fullscreen (spec §7.1; final review C-M13).
 */
const LOCKED_KEYS: readonly string[] = ['KeyW', 'KeyT', 'KeyN'];

/** Chromium's Keyboard Lock, which is not in the DOM typings. */
export interface KeyboardLockNavigator {
  readonly keyboard?: { lock?(keyCodes?: readonly string[]): Promise<void> };
}

/**
 * The help's "Fullscreen" (spec §7.1): requests fullscreen, then, where Chromium's Keyboard Lock exists
 * (`navigator.keyboard.lock()`), captures Ctrl+W so that it reaches the page; Firefox keeps the `beforeunload` prompt.
 * A refusal is ignored.
 */
export async function enterFullscreen(
  doc: { readonly documentElement: { requestFullscreen(): Promise<void> } },
  nav: KeyboardLockNavigator,
): Promise<void> {
  try {
    await doc.documentElement.requestFullscreen();
    await nav.keyboard?.lock?.(LOCKED_KEYS);
  } catch {
    // Fullscreen refused (no user gesture, an iframe) or the lock refused: the guard still asks before closing.
  }
}

/**
 * Mounts the world page in `root` (replacing what it holds) and resolves once it settles: revealed, or failed with the
 * failure panel or the error screen showing. It never rejects for a load error; the page shows it.
 */
export function mountWorldPage(root: HTMLElement, q: WorldQuery, hash: string, opts: WorldPageOptions = {}): Promise<WorldPage> {
  const t0 = performance.now();
  const hud = opts.hud ?? true;
  const overlay = opts.overlay ?? true;
  const eyeAbove = opts.eyeAbove ?? 2;
  const makeRenderer = opts.createRenderer ?? createWorldRenderer;
  const hashText = hash.replace(/^#/, '');
  const hashPart = hashText === '' ? '' : `#${hashText}`;
  const mapHref = hashText === '' ? '?map' : `?map#${hashText}`;

  // The tools' hook (ruling P48): uiSmoke's `world` step waits for `revealed`, `world-mesh` for `frames >= 3`.
  const progressHook = { revealed: false, frames: 0 };
  window.__wiWorld = progressHook;

  const stats: LoadStats = { revealMs: null, stageMs: { T: null, D: null, L: null, MESH: null }, mergeMs: 0, longTasks: null, first120MaxMs: null };
  let state: WorldPage['state'] = 'loading';
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });

  // What the failure details and the lower-RD link name, filled in as the load learns them.
  let report: CapabilityReport | null = null;
  let rd: number | null = null;
  let centre: { x: number; z: number } | null = q.at;
  let pool: WorkerPool | null = null;
  let sim: SimClient | null = null;
  let wr: WorldRenderer | null = null;
  let seedText: string | null = null;
  let profile: string | null = null;

  // Torn down by dispose.
  let raf = 0;
  let longTasks: PerformanceObserver | null = null;
  const teardown: Array<() => void> = [];

  root.replaceChildren();
  const host = el('div', 'world-host');
  host.id = 'world-host';
  root.append(host);

  const loading = mountLoadingScreen(root, {
    tips: tips(DEFAULT_KEYMAP),
    now: () => performance.now(),
    doc: document,
    // The watchdog judges the load only; after the reveal its panel is gone.
    onWatchdog: () => { if (state === 'loading') fail('No progress for 30 s: the load stalled.', null); },
    loadManifest: () => fetch('/panoramas/manifest.json').then((r) => (r.ok ? r.json() : null)),
    rand: Math.random,
  });
  loading.progress(0, 'Generating');

  const lowerRdHref = (): string | null => {
    const lower = rd === null ? null : lowerRd(rd);
    return lower === null ? null : `/?rd=${lower}${centre === null ? '' : `&at=${centre.x},${centre.z}`}${hashPart}`;
  };

  /** The panel's details: a fatal event's message (when given), then the error's or the event cause's stack. */
  const details = (e: unknown, message: string | null = null): string => [
    message,
    e === null ? null : `${message === null ? '' : 'cause: '}${e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e)}`,
    `seed ${seedText ?? '?'} · profile ${profile ?? '?'} · rd ${rd ?? '?'} · centre ${centre === null ? '?' : `${centre.x}, ${centre.z}`}`,
    `workers ${pool?.size ?? '?'} · renderer ${report?.renderer ?? '?'} · multiDraw ${report?.multiDraw ?? '?'}`,
    `url ${location.href}`,
    `user agent ${navigator.userAgent}`,
  ].filter((l) => l !== null).join('\n');

  /**
   * After the reveal (SP4b spec §7.4): stops the frame loop and the coordinator and shows the world notices' failure
   * panel (the loading screen's is gone by then); set by the streaming branch once its notices exist.
   */
  let failAfterReveal: ((cause: string, shown: string) => void) | null = null;

  function fail(cause: string, e: unknown, message: string | null = null): void {
    if (state === 'failed') return;
    const revealed = state === 'revealed';
    // The flight route has no notices: after its reveal an error has nowhere to show (SP4a's rule).
    if (revealed && failAfterReveal === null) return;
    state = 'failed';
    // The details read the pool's size, so the panel is filled first; dispose() then finds no renderer to free twice.
    const shown = details(e, message);
    if (revealed) {
      failAfterReveal!(cause, shown);
      return;
    }
    const renderer = wr;
    wr = null;
    failBeforeReveal({
      show: () => loading.fail(cause, shown, { map: mapHref, lowerRd: lowerRdHref() }),
      release: { longTasks, sim, pool, renderer },
      settle,
      onError: (err) => console.error('The world page\'s release after a failure:', err),
    });
  }

  function dispose(): void {
    if (state === 'loading') state = 'failed';
    // A failure during the teardown (a job settling as the pool stops) has nowhere to show.
    failAfterReveal = null;
    cancelAnimationFrame(raf);
    // Each step guarded (SP4b ruling R5): a StoreCorrupt from the coordinator's dispose sweep must not leave the
    // workers running or the page mounted.
    runTeardown([
      () => longTasks?.disconnect(),
      ...teardown.splice(0).reverse(),
      () => loading.dispose(),
      () => wr?.dispose(),
      () => pool?.terminate(),
      () => root.replaceChildren(),
    ], (e) => console.error('The world page\'s teardown:', e));
    wr = null;
    settle();
  }

  const page: WorldPage = {
    get state() {
      return state;
    },
    loadStats: stats,
    dispose,
  };

  async function run(): Promise<void> {
    // 1. The world from the hash (P47): a decode error loads nothing.
    const decoded = decodeMapState(hash);
    if (decoded.error !== null) {
      fail(decoded.error, null);
      return;
    }

    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true) {
      const lt = { count: 0, maxMs: 0 };
      stats.longTasks = lt;
      longTasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          lt.count++;
          lt.maxMs = Math.max(lt.maxMs, entry.duration);
        }
      });
      longTasks.observe({ type: 'longtask' });
    }

    // 2. Capabilities (§8.5).
    const caps = await probeCapabilities();
    report = caps;
    const evaluation = evaluateWorldCapabilities(caps);
    if (!evaluation.ok || caps.reservation === null) {
      state = 'failed';
      longTasks?.disconnect();
      loading.dispose();
      renderErrorScreen(root, caps, evaluation, mapHref);
      settle();
      return;
    }

    // 3. Session, settings, render distance, store and pool.
    const session = openMapSession(decoded.state, cryptoSeed);
    seedText = session.state.seedText;
    profile = session.state.profile;
    if (session.initNotice !== null) loading.warn(session.initNotice);
    const storage = storageOrNull();
    // The flight and bench routes measure with the defaults, never a user's stored cap or FOV (spec §9.5; SP4b spec §8.3).
    let settings: WorldSettings = opts.flight === undefined && opts.bench === undefined ? loadSettings(storage) : { ...SETTINGS_DEFAULTS };
    const loadRd = resolveRenderDistance(caps, q.rd, settings.rd);
    rd = loadRd;
    // The largest RD the store's fixed maxima allow (SP4b spec §5): the coordinator's and the help's cap.
    const rdMax = Math.min(RD_MAX, reservationRdCap(caps.reservation));
    const store = createStore({ shared: true, maxBlockBytes: caps.reservation.blockBytes, maxByteBytes: caps.reservation.byteBytes });
    // The pool's per-scope epoch cells are the store's (SP4b spec §2.7); a failed worker's thread is marked dead in the
    // store, so its reader epoch no longer holds releases in limbo and its pool lock reads as StoreCorrupt (§2.6).
    // Before the reveal any failed worker stops the load; after it only the last one does (SP4b spec §3.6, D12: the
    // coordinator's caps follow the live workers).
    const workers = createBrowserPool(q.workers ?? poolSize(navigator.hardwareConcurrency || 4), {
      onFailure: (e) => {
        if (state === 'loading' || pool?.liveWorkers() === 0) fail(causeOf(e), e);
      },
      onWorkerDead: (t) => store.markDead(t),
      epochCells: store.epochs.cells,
    });
    pool = workers;
    await workers.attachStore(store.handles());
    // The sim worker (SP5a spec §2.1, D17), thread 15 of the store, on every route but the flight's (which edits
    // nothing; its D has no read-through). Its failure handler is the route's: until the streaming route's notices and
    // edit path exist, thread 15 is marked dead (and, once the coordinator exists, every sim pin released). A sim that
    // fails while attaching leaves editing off and the load going on (the world keeps streaming, §2.1).
    let simFailure = (): void => store.markDead(SIM_THREAD);
    const simClient = opts.flight === undefined ? createBrowserSim({ onFailure: () => simFailure() }) : null;
    sim = simClient;
    if (simClient !== null) teardown.push(() => simClient.dispose());
    const simAttached = simClient?.attach(store.handles()).catch((e: unknown) => {
      if (!(e instanceof SimFailed)) throw e;
    });
    // G2's edit latency (§6.2): staged through the coordinator's `onEditStaged`, revealed through the route's hook.
    const latency = simClient === null ? null : createEditLatency();
    // The first configure's ReadyMsg is kept: the preview driver adopts it at the reveal (SP4c spec §4.2).
    const firstReady = await workers.configure(session.state.seedText, session.state.params);
    await simAttached;
    if (state !== 'loading') return;

    // 4. The centre, the renderer and the load.
    let at: { x: number; z: number };
    if (centre !== null) at = centre;
    else {
      const spawn = await workers.spawn();
      at = { x: spawn.x, z: spawn.z };
    }
    centre = at;
    if (state !== 'loading') return;
    const kind: SectionRendererKind = selectSectionRenderer(caps, q.renderer);
    const world = makeRenderer(host, {
      kind,
      fov: settings.fov,
      rd: loadRd,
      pixelRatioCap: MEDIUM.pixelRatioCap,
      ao: MEDIUM.ao,
      smoothLight: MEDIUM.smoothLight,
      brightness: settings.brightness,
      // The first floating origin is the snapped spawn (SP4b spec §3.4), set before anything is staged.
      originAt: at,
    });
    wr = world;
    // A context lost before the reveal is a load failure; after it, the page's handler takes over (Review Focus 5).
    world.onContextLost(() => { if (state === 'loading') fail('The graphics context was lost.', null); });
    const sections = world.sections;
    // The first entry: complete columns wait inside the hidden root for the one reveal (SP4b spec §3.11).
    sections.holdReveals(true);

    const loadStart = performance.now();
    let onStreamEvent: ((e: StreamEvent) => void) | null = null;
    // The first entry on the streaming coordinator (SP4b spec §3.11, D21): strict, so any error stops the load as in
    // SP4a (D12); every proto kept (D11); the camera held at the centre. The throttle is created here and kept for the
    // streaming frame; nothing feeds it before the reveal, so it stays at its maximum.
    const throttle = createThrottle({ max: Math.max(1, workers.size - 1) });
    // The per-column epoch's interning (SP4c spec §4.4), session-wide: the first entry's draft is epoch 1.
    const epochs = createEpochs();
    const coordinator = createCoordinator({
      // D reads the sim's entries through (SP5a spec §2.5); null on the flight route.
      jobs: worldJobsOf(workers, simClient),
      store,
      sink: {
        stage: (p, seq) => sections.stage(p, seq),
        // The coordinator's Apply drops a pending payload of another epoch here (SP4c spec §4.4, §5.1).
        unstage: (cx, cz) => sections.unstage(cx, cz),
        remove: (cx, cz) => sections.remove(cx, cz),
      },
      throttle,
      rd: loadRd,
      rdMax,
      retainAllProtos: true,
      strict: true,
      // The page's first configure (SP4c spec §4.2, §4.4): the pool's generation now, its genKey's epoch (1).
      generation: workers.epoch,
      epoch: epochs.of(firstReady.genKey),
      // Strict until the reveal: only `fatal` comes, and it stops the load; after it the streaming branch handles them.
      onEvent: (e) => {
        if (onStreamEvent !== null) onStreamEvent(e);
        else if (e.kind === 'fatal') fail(causeOf(e.cause, e.message), e.cause, e.message);
      },
      // An edit's payload staged (SP5a spec §4.6, §6.2): the first reveal of the column after it shows the edit.
      onEditStaged: (cx, cz) => latency?.staged(cx, cz, performance.now()),
    });
    teardown.push(() => coordinator.dispose());
    simFailure = () => {
      store.markDead(SIM_THREAD);
      coordinator.simUnpinAll();
    };
    const counts = createCoordinatorCounts();
    const loadCamera = { x: at.x, z: at.z, yawDeg: 0 };
    coordinator.update(loadCamera);

    const budget = createUploadBudget(LOAD_UPLOAD_MS, Infinity, () => performance.now());
    const uploads = createSectionRendererCounts();
    try {
      await everyFrameUntil((cb) => { raf = requestAnimationFrame(cb); }, () => {
        if (state !== 'loading') return true;
        coordinator.update(loadCamera);
        coordinator.counts(counts);
        for (const s of STAGES) if (stats.stageMs[s] === null && counts[s].done === counts[s].needed) stats.stageMs[s] = performance.now() - loadStart;
        budget.start();
        sections.pump(budget, counts.cx, counts.cz, counts.yawDeg);
        sections.counts(uploads);
        loading.progress(progressFraction(counts, uploads.columnsComplete, counts.MESH.needed), phaseName(counts, uploads.columnsComplete, counts.MESH.needed));
        return coordinator.firstFill() && uploads.columnsComplete === uploads.columnsStaged;
      });
    } catch (e) {
      // An upload error (a BatchedMesh call that throws, a merge error) is a load error (spec §8.3).
      fail(`The view could not be built: ${errorText(e)}`, e);
      return;
    }
    if (state !== 'loading') return;

    // 5. Compile, place the camera, warm up behind the overlay, reveal.
    await world.compile();
    if (state !== 'loading') return;
    const view = firstView((x, z) => motionBlockingAt(store, x, z), at.x, at.z, { y: q.y, yaw: q.yaw, pitch: q.pitch }, eyeAbove);
    const fly: FlyState = { x: at.x, y: clamp(view.y, Y_MIN, Y_MAX), z: at.z, yaw: view.yaw, pitch: view.pitch, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT };
    // Wraps the yaw into [0, 360) and clamps the pitch; a query's valid degrees pass unchanged (ruling P42).
    look(fly, 0, 0, 0);
    const fixedT = opts.timeHours === undefined || opts.timeHours === null ? null : ((((opts.timeHours - 6) / 24) % 1) + 1) % 1;
    let t = fixedT ?? OPENING_T;
    let speedIndex = 0;
    const timeSpeed = (): number => (fixedT === null ? TIME_SPEEDS[speedIndex]! : 0);

    const placeCamera = (): void => {
      if (world.origin.update(fly.x, fly.y, fly.z)) sections.setOrigin(world.origin.x, world.origin.y, world.origin.z);
      world.camera.position.set(fly.x - world.origin.x, fly.y - world.origin.y, fly.z - world.origin.z);
      applyCameraRotation(world.camera, fly);
    };
    // One FrameState for every frame, rewritten in place (SP4b spec §3.10); the frame step writes it after the reveal.
    const frame = { t, brightness: settings.brightness, eyeSky: 15, rd: loadRd, fogBand: MEDIUM.fogBand };
    const frameState = (): FrameState => {
      frame.t = t;
      frame.brightness = settings.brightness;
      frame.eyeSky = skyLightAt(store, fly.x, fly.y, fly.z);
      return frame;
    };

    for (let i = 0; i < WARM_UP_FRAMES; i++) {
      await nextFrame();
      if (state !== 'loading') return;
      placeCamera();
      world.warmUp(frameState());
    }
    const revealTs = await nextFrame();
    if (state !== 'loading') return;
    // The reveal frame: every section at once (master §4.2's atomic reveal). The warm-up uploaded every region's
    // written ranges, so this pump (nothing left to upload) turns their frustum culling back on (SP4b spec §3.9).
    budget.start();
    sections.pump(budget, counts.cx, counts.cz, counts.yawDeg);
    sections.revealAll();
    sections.holdReveals(false);
    // From here errors degrade instead of stopping the world (D12).
    coordinator.setStrict(false);
    placeCamera();
    world.frame(frameState());
    state = 'revealed';
    progressHook.revealed = true;
    stats.revealMs = performance.now() - t0;
    stats.mergeMs = sections.counts(uploads).structuralMs;
    if (longTasks !== null) {
      const lt = stats.longTasks!;
      for (const entry of longTasks.takeRecords()) {
        lt.count++;
        lt.maxMs = Math.max(lt.maxMs, entry.duration);
      }
      longTasks.disconnect();
      longTasks = null;
    }

    // The flight route (spec §9.5): the flight drives the camera and the clock; the page's own loop never starts.
    if (opts.flight !== undefined) {
      loading.dispose();
      let lost = false;
      world.onContextLost(() => { lost = true; });
      let flown = 0;
      opts.flight({
        host,
        world,
        centre: at,
        rd: loadRd,
        workers: workers.size,
        kind,
        report: caps,
        seed: session.state.seedText,
        profile: session.state.profile,
        loadStats: stats,
        revealTs,
        motionBlockingAt: (x, z) => motionBlockingAt(store, x, z),
        hasWater: (x, z) => hasWaterAt(store, x, z),
        render(pose, tt) {
          fly.x = pose.x;
          fly.y = pose.y;
          fly.z = pose.z;
          fly.yaw = pose.yaw;
          fly.pitch = pose.pitch;
          t = tt;
          placeCamera();
          world.frame(frameState());
          flown++;
          progressHook.frames = flown;
          opts.onFrame?.(flown);
        },
        sabMB: () => storeSabMiB(store),
        lost: () => lost,
      });
      settle();
      return;
    }

    const isRevealed = (cx: number, cz: number): boolean => sections.isRevealed(cx, cz);
    // The fog's scan counts a column skipped after two failures as filled (final review UI-4).
    const columns = { isRevealed, isSkipped: (cx: number, cz: number): boolean => coordinator.isSkipped(cx, cz) };

    // The bench route (SP4b spec §8.3): the page's own streaming frame with the pose set by the script.
    if (opts.bench !== undefined) {
      const bench = opts.bench;
      loading.dispose();
      settle();
      let stopped = false;
      const stop = (): void => {
        stopped = true;
        cancelAnimationFrame(raf);
      };
      // The live legs' teleport and preview driver (SP4c spec §8.4), created below.
      let benchTeleport: Teleport | null = null;
      let benchDriver: PreviewDriver | null = null;
      // A failure after the reveal ends the script with the error, so measureChrome stops at once; the teleport (before
      // the pool: a landing in flight settles silently, ruling R5), the driver, the coordinator, the workers and the
      // renderer are released as on the streaming route.
      failAfterReveal = (cause, shown) => {
        const renderer = wr;
        wr = null;
        stopAfterFailure({
          stop,
          show: () => bench.fail(`${cause}\n${shown}`),
          release: [
            () => benchTeleport?.dispose(),
            () => benchDriver?.dispose(),
            () => coordinator.dispose(),
            () => simClient?.dispose(),
            () => pool?.terminate(),
            () => renderer?.dispose(),
          ],
          onError: (e) => console.error('The bench\'s failure:', e),
        });
      };
      // Skipped columns and StoreFull are counted in the totals; only a fatal event stops the script.
      onStreamEvent = (e) => {
        if (e.kind === 'fatal') fail(causeOf(e.cause, e.message), e.cause, e.message);
      };
      world.onContextLost(() => fail('The graphics context was lost.', null));
      try {
        // L5's refill is measured at the script's top RD, the cap when the reservation clamps it; the live legs run at it.
        const refillRd = Math.min(BENCH_REFILL.rd, rdMax);
        // The live legs' pieces (SP4c spec §8.4), the world page's without a map: the configure owner over a replaying
        // canvas nothing attaches to, wanting no preview and fed every session change (no tool is ever mounted, ruling
        // R1); a configure failure is fatal (§4.3).
        const reveals = createLiveReveals(bench.record);
        // L10's edit path (SP5a spec §6.2): the streaming route's, with no notice to show; the latency's reveals come
        // through the same hook as the live legs' (`onColumnRevealed` holds one).
        const editLatency = latency!;
        const benchEdits = createEditPath({
          sim: simClient!,
          coordinator,
          latency: editLatency,
          now: () => performance.now(),
          notices: { show() {} },
        });
        // The sim's failure: thread 15 dead, the path disabled, every sim pin released, and the script ends with it.
        simFailure = () => {
          store.markDead(SIM_THREAD);
          benchEdits.disable();
          coordinator.simUnpinAll();
          fail('The edit worker failed.', null);
        };
        if (simClient!.failed) simFailure();
        sections.onColumnRevealed = (cx, cz) => {
          reveals.revealed(cx, cz);
          editLatency.revealed(cx, cz, performance.now());
        };
        teardown.push(() => { sections.onColumnRevealed = null; });
        const liveDriver = createPreviewDriver(workers, createReplayingCanvas(), {
          now: () => performance.now(),
          setTimeout: (fn, ms) => window.setTimeout(fn, ms),
          clearTimeout: (id) => window.clearTimeout(id),
        }, { spawnPriority: 600 });
        benchDriver = liveDriver;
        teardown.push(() => liveDriver.dispose());
        liveDriver.setPreviewWanted(false);
        liveDriver.adopt({ poolEpoch: workers.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready: firstReady });
        teardown.push(liveDriver.onStatus((s) => onDriverStatus(s, (cause, e) => fail(cause, e))));
        teardown.push(followSession({ session, driver: liveDriver, toolMounted: () => false, now: () => performance.now() }));
        // The apply control (§4.3): its `onApplied` marks the Apply frame, from which L7's and L8's times run.
        const applyControl = createApplyControl({
          coordinator,
          driver: liveDriver,
          session,
          pool: workers,
          clock: { now: () => performance.now() },
          epochs,
          initial: appliedDraftOf(draftOf(session.state).seedKey, firstReady),
          initialGeneration: workers.epoch,
          beforeApply: () => true,
          onApplied: () => reveals.mark(),
        });
        teardown.push(() => applyControl.dispose());
        // The teleport (§3) over the bench's pool; until it arrives the camera is still at the old place, so no reveal
        // counts for L9 (a landing that fails leaves L9 to its cap). A failed landing's cause rejects the hook's
        // promise, so the JSON says why L9 timed out (`live.teleportError`, final review WLD-5).
        let landing = false;
        let landingFailure: { readonly cause: unknown } | null = null;
        const teleporter = createTeleport({
          pool: workers,
          fly,
          state: frame,
          onArrive: () => { landing = false; },
          onFail: (cause) => { landingFailure = { cause }; },
        });
        benchTeleport = teleporter;
        teardown.push(() => teleporter.dispose());
        // The script's RD steps never exceed the reservation's cap (Task 26b); the review shots' camera reads the ground's
        // height under the frozen pose (rulings R9); the live legs edit, undo and teleport through the pieces above.
        bench.bind({
          rdMax,
          heightAt: (x, z) => store.heightAt('motionBlocking', x, z),
          live: {
            set(path, v) {
              reveals.reset();
              const r = session.set(path, v);
              if (!r.ok) throw new Error(`the bench's edit ${path} = ${v} was refused: ${r.issues.map((i) => i.message).join('; ')}`);
            },
            undo() {
              reveals.reset();
              if (!session.undo()) throw new Error('the bench\'s undo found nothing to undo');
            },
            teleport(x, z) {
              // The click is L9's mark (D24: "within 0.5 s of the click").
              reveals.mark();
              landing = true;
              landingFailure = null;
              return teleporter.go(x, z).then((ok) => {
                if (!ok && landingFailure !== null) throw landingFailure.cause;
                return ok;
              });
            },
            settled: () => reveals.filled,
          },
          edit: {
            post: (edits) => benchEdits.post(edits),
            editState: (cx, cz) => coordinator.editState(cx, cz),
          },
        });
        // The live RD as the help would set it, never saved (SP4b spec §5).
        const fog = createFogEase(loadRd);
        const fogStep = createFogStep(fog, fly, columns, loadRd);
        let liveRd = loadRd;
        const rdControl = createRdControl({
          coordinator,
          world,
          fog: {
            setTarget(r) {
              liveRd = r;
              rd = r;
              fog.setTarget(r);
              fogStep.rescan();
            },
          },
          help: { setRd() {} },
          save: () => {},
          defaultRd: loadRd,
        });

        // 1. The display interval: the median of the idle rAF deltas, the first from the reveal frame (spec §8.3).
        const idle = new Float64Array(BENCH_IDLE_FRAMES);
        let prev = revealTs;
        for (let i = 0; i < idle.length; i++) {
          const now = await new Promise<number>((resolve) => { raf = requestAnimationFrame(resolve); });
          if (stopped || state !== 'revealed') return;
          idle[i] = now - prev;
          prev = now;
        }
        // Through the page's finite fallback (rulings R5 (a)): a NaN interval would snap every frame time to NaN.
        const interval = benchInterval(idle);

        // 2. The streaming frame, timed in its coordinator and pump; one record row per rendered frame.
        // [coordinator ms, upload ms, rows, the callback's start, the raw delta, the script time (s), its start]
        const timing = Float64Array.of(0, 0, 0, 0, 0, 0, Number.NaN);
        const T_COORD = 0;
        const T_UPLOAD = 1;
        const T_ROWS = 2;
        const T_START = 3;
        const T_RAW = 4;
        const T_SCRIPT = 5;
        const T_ORIGIN = 6;
        const timedCoordinator: Pick<Coordinator, 'update' | 'counts'> = {
          update(cam) {
            const t0 = performance.now();
            coordinator.update(cam);
            timing[T_COORD] += performance.now() - t0;
          },
          counts: (out) => coordinator.counts(out),
        };
        const timedSections = {
          pump(gate: Parameters<typeof sections.pump>[0], cx: number, cz: number, yawDeg: number): number {
            const t0 = performance.now();
            const rows = sections.pump(gate, cx, cz, yawDeg);
            timing[T_UPLOAD] += performance.now() - t0;
            timing[T_ROWS] += rows;
            return rows;
          },
        };
        const recorder = createBenchRecorder(bench.record, { sections, world, heapMB: jsHeapMB, sabMB: () => storeSabMiB(store) }, interval);
        const noKeys: ReadonlySet<Action> = new Set();
        let n = 0;
        let firstMax = 0;
        let refillMs: number | null = null;
        fly.vx = fly.vy = fly.vz = 0;
        const clock = createFrameClock(createFpsLimiter(settings.fpsCap), { push() {} }, prev);
        // The bench's aim runs the DDA and the outline update (the box around the hit, relative to the floating origin)
        // from the scripted pose although its step is always paused, so L10's main-thread time (`mainP95Ms`) includes
        // them (SP5a spec §6.2). The bench mounts without the HUD, so the outline is computed but never drawn: the review
        // shots and the draw counts are unchanged. No pointer lock is taken.
        const benchAim = createAim({ fly, world, locked: () => true, hud });
        const step = createFrameStep({
          fly,
          held: () => noKeys,
          // The script sets the pose: the fly step never runs.
          paused: () => true,
          stopped: () => stopped,
          clock,
          coordinator: timedCoordinator,
          counts,
          throttle,
          budget: createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, () => performance.now()),
          sections: timedSections,
          world,
          store,
          aim: (read) => benchAim.aim(read, false),
          state: frame,
          timeSpeed: () => BENCH_TIME_SPEED,
          fogStep: (dtMs) => fogStep.step(dtMs),
          // The apply control before the coordinator's update; the aux policy from its counts, no map covering the 3D
          // (SP4c spec §4.3, §6.2, §8.4).
          beforeUpdate: () => applyControl.tick(),
          afterCounts: (c) => updateAuxPolicy(workers, applyControl.generation, false, c),
          onRendered: (dtMs) => {
            // The live legs' reveals since their mark around the camera's column, before the recorder takes the row.
            if (landing) reveals.clear();
            else reveals.count(Math.floor(fly.x) >> 4, Math.floor(fly.z) >> 4, refillRd);
            recorder.frame(timing[T_RAW]!, performance.now() - timing[T_START]!, timing[T_COORD]!, timing[T_UPLOAD]!, timing[T_ROWS]!, counts.genCap);
            timing[T_COORD] = 0;
            timing[T_UPLOAD] = 0;
            timing[T_ROWS] = 0;
            // L5's refill (spec §8.3): the first frame whose RD 12 disc around the camera's column is revealed.
            const tS = timing[T_SCRIPT]!;
            if (refillMs === null && tS >= BENCH_REFILL.fromS && tS < BENCH_REFILL.toS
              && filledRadius(Math.floor(fly.x) >> 4, Math.floor(fly.z) >> 4, refillRd, isRevealed) === refillRd) {
              refillMs = (tS - BENCH_REFILL.fromS) * 1000;
            }
            if (n < FIRST_FRAMES) {
              firstMax = Math.max(firstMax, dtMs);
              if (n + 1 === FIRST_FRAMES) stats.first120MaxMs = firstMax;
            }
            n++;
            progressHook.frames = n;
            opts.onFrame?.(n);
          },
        });
        const finish = (): void => {
          coordinator.counts(counts);
          bench.done({
            seed: session.state.seedText,
            profile: session.state.profile,
            rd: loadRd,
            rdClampedTo: bench.rdClampedTo,
            workers: workers.size,
            sectionRenderer: kind,
            userAgent: navigator.userAgent,
            renderer: caps.renderer,
            vendor: caps.vendor,
            multiDraw: caps.multiDraw,
            timerQuery: caps.timerQuery,
            screen: { width: screen.width, height: screen.height },
            dpr: devicePixelRatio,
            pixelRatio: world.renderer.getPixelRatio(),
            displayIntervalMs: interval,
            load: { revealMs: stats.revealMs, stageMs: { ...stats.stageMs }, longTasks: stats.longTasks, first120RenderedMaxMs: stats.first120MaxMs },
            totals: { dropped: counts.dropped, failed: counts.failed, storeFull: counts.storeFull, editDropped: counts.editDropped },
            refillMs,
            canvas: { width: world.renderer.domElement.width, height: world.renderer.domElement.height },
            edit: { ...editLatency.samples(), count: editLatency.count },
          });
        };
        const pose: BenchPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
        const loop = (now: number): void => {
          if (stopped) return;
          try {
            timing[T_START] = performance.now();
            if (Number.isNaN(timing[T_ORIGIN]!)) timing[T_ORIGIN] = now;
            timing[T_SCRIPT] = (now - timing[T_ORIGIN]!) / 1000;
            pose.x = fly.x;
            pose.y = fly.y;
            pose.z = fly.z;
            pose.yaw = fly.yaw;
            pose.pitch = fly.pitch;
            // The fog's RD of the last rendered frame (a shot waits for it, plan).
            const want = bench.pose(timing[T_SCRIPT]!, pose, frame.rd);
            if (want === null) {
              stop();
              finish();
              return;
            }
            fly.x = pose.x;
            fly.y = pose.y;
            fly.z = pose.z;
            fly.yaw = pose.yaw;
            fly.pitch = pose.pitch;
            if (want !== liveRd) rdControl.apply(want);
            raf = requestAnimationFrame(loop);
            timing[T_RAW] = Math.max(0, now - clock.lastTick());
            step.tick(now);
          } catch (e) {
            fail(`The frame loop stopped: ${errorText(e)}`, e);
          }
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        fail(`The bench stopped: ${errorText(e)}`, e);
      }
      return;
    }

    // Every navigation the page starts disarms the Ctrl+W guard first and happens once (spec §7.1; ruling P50).
    const disarm = installLeaveGuard(window);
    teardown.push(disarm);
    const reloader = createReloader((url) => navigateTo(url, location), disarm);
    const notices = createWorldNotices(host, reloader);
    teardown.push(() => notices.dispose());
    // The edit path (SP5a spec §2.1, §2.6, §2.7): every edit of the page goes through it, and the sim's failure
    // disables it. The streaming route always has the sim (only the flight's has none, and it returned above).
    const editLatency = latency!;
    const editPath = createEditPath({
      sim: simClient!,
      coordinator,
      latency: editLatency,
      now: () => performance.now(),
      notices: { show: (text, ms) => notices.show(text, { kind: 'warn', timeoutMs: ms }) },
    });
    simFailure = () => onSimFailure({ store, coordinator, editPath, notices });
    // The block history (SP5a spec §4.5, D13): every action posts through `actionPost`, which records an accepted one;
    // a side with no entry takes the voxel's value read now as its `expect`.
    const blockHistory = createBlockHistory({
      post: editPath.post,
      read: (x, y, z) => voxelValue(store, x, y, z),
      pending: editPath.pending,
      settled: editPath.settled,
      notices: { show: (text, ms) => notices.show(text, { timeoutMs: ms }) },
    });
    const actionPost = createActionPost({ post: editPath.post, record: blockHistory.record });
    // A sim that failed during the load shows its notice now that the notices exist.
    if (simClient!.failed) simFailure();
    // The edit latency's reveals (§6.2); the bench's own hook feeds them on its route (L10).
    sections.onColumnRevealed = (cx, cz) => editLatency.revealed(cx, cz, performance.now());
    teardown.push(() => { sections.onColumnRevealed = null; });
    // The map overlay and the preview driver (SP4c spec §1.3, §4.2), created below; a failure or a context loss
    // disposes the overlay (and its tool) before the panel or the notice shows (D27).
    let mapRef: MapOverlay | null = null;
    let driver: PreviewDriver | null = null;
    // The teleport, created below; a failure after the reveal disposes it before the pool is terminated (ruling R5).
    let teleport: Teleport | null = null;
    // The world's URL (SP4c spec §1.6, D20): after every Apply and every view change of the map, the path, the search
    // and the live session's hash, debounced 200 ms, a hash over 64 KiB dropped with the notice; a teleport's arrival
    // rewrites the search's place. Disposed (a pending write flushed) before the notices. No `hashchange` listener.
    const urlWriter = createUrlWriter((u) => history.replaceState(null, '', u), 200, 1000, oversizeNotice(notices));
    teardown.push(() => urlWriter.dispose());
    teardown.push(flushOnPageHide(window, urlWriter));
    const worldUrl = createWorldUrl({
      session,
      view: () => worldMapView(mapRef?.tool ?? null, fly),
      camera: fly,
      writer: urlWriter,
      loc: location,
    });
    // The Reloads read the camera, the live session and the map's view now, never the hash the page was loaded with.
    const here = (rdOf: number | null): string => worldUrl.here(rdOf);
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // The live render distance (SP4b spec §5): the RD in force, the fog's easing toward it and the filled radius it
    // follows. `rdControl` is created once the help it updates is mounted, before any frame or event can reach it.
    let liveRd = loadRd;
    const fog = createFogEase(loadRd);
    const fogStep = createFogStep(fog, fly, columns, loadRd);
    let rdControl!: { apply(rd: number | null): void };
    // A failure after the reveal (SP4b spec §7.4): the loop and the coordinator stop, the workers and the renderer are
    // released, and the notices' panel offers "Copy details" and a Reload around the camera.
    let stopHud = (): void => {};
    failAfterReveal = (cause, shown) => {
      const renderer = wr;
      wr = null;
      stopAfterFailure({
        stop,
        closeMap: () => mapRef?.dispose(),
        show: () => notices.failed(cause, shown, here(reloadRd(q.rd, liveRd))),
        // The HUD's timer would read the disposed renderer and coordinator; then what releaseOnFailure frees, each
        // step on its own.
        release: [
          () => stopHud(),
          // Before the pool: a landing in flight then settles silently, so no "Could not teleport" shows beside the
          // panel (ruling R5; pool.terminate rejects it with WorkerFailed).
          () => teleport?.dispose(),
          () => driver?.dispose(),
          () => coordinator.dispose(),
          () => longTasks?.disconnect(),
          () => simClient?.dispose(),
          () => pool?.terminate(),
          () => renderer?.dispose(),
        ],
        onError: (e) => console.error('The world page\'s failure:', e),
      });
    };
    // The coordinator's events after the reveal (D12). StoreFull's "Lower to RD n" applies live (SP4b spec §5).
    onStreamEvent = (e) => handleStreamEvent(e, {
      notices,
      fail: (cause, err) => fail(cause, err),
      lower: (lower) => rdControl.apply(lower),
    });
    handleContextLoss(world, {
      stop,
      closeMap: () => mapRef?.dispose(),
      onError: (e) => console.error('The world page\'s context loss:', e),
      notices,
      // Without a query rd the setting applies (it holds every live change); a query's rd is replaced by the RD in
      // force, so a live change made since the load survives the reload.
      hereHref: () => here(reloadRd(q.rd, liveRd)),
    });
    // The notice judges the first 300 frames after the reveal and suggests the RD below the one in force when it
    // fires (the user may have changed it live since the load).
    const slowFrames = createFrameNotice(() => offerLowerRd(notices, liveRd, rdControl), () => liveRd);

    const canvas = world.renderer.domElement;
    // The configure owner from the reveal on (SP4c spec §4.2): it adopts the page's first configure, wants no preview
    // until the first M shows the map, and pushes into a replaying sink the map tool attaches to. The world's spawn
    // request runs at priority 600 (§6.3).
    const relay = createReplayingCanvas();
    const previewDriver = createPreviewDriver(workers, relay, {
      now: () => performance.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    }, { spawnPriority: 600 });
    driver = previewDriver;
    teardown.push(() => previewDriver.dispose());
    previewDriver.setPreviewWanted(false);
    previewDriver.adopt({ poolEpoch: workers.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready: firstReady });
    // A configure failure after the reveal is fatal (SP4c spec §4.3).
    teardown.push(previewDriver.onStatus((s) => onDriverStatus(s, (cause, e) => fail(cause, e))));
    // Ruling R1: the page feeds the driver every session change until the first M mounts the tool, whose own subscribe
    // is then the only caller.
    teardown.push(followSession({ session, driver: previewDriver, toolMounted: () => mapRef !== null && mapRef.tool !== null, now: () => performance.now() }));
    // When a draft is applied (SP4c spec §4.3, D4): once per frame, before the coordinator's update. Its `generation`
    // gates the aux policy (§6.2); `onApplied` drives Watch live (§2.1), the URL (§1.6) and the undo notice (§2.4).
    // The undo notice: "Undo" or "Redo" for 1.5 s at the bottom of the 3D when the map is hidden (D15, D26).
    const undoNotice = createUndoNotice({
      subscribe: (l) => session.subscribe(l),
      mapShown: () => mapRef?.shown ?? false,
      show: (text, ms) => notices.show(text, { timeoutMs: ms }),
    });
    teardown.push(() => undoNotice.dispose());
    const applyControl = createApplyControl({
      coordinator,
      driver: previewDriver,
      session,
      pool: workers,
      clock: { now: () => performance.now() },
      epochs,
      initial: appliedDraftOf(draftOf(session.state).seedKey, firstReady),
      initialGeneration: workers.epoch,
      // SP4c always proceeds; SP5b's world-modification mode suspends auto-apply here (master §2.7 (b)).
      beforeApply: () => true,
      onApplied: ({ from }) => {
        worldUrl.applied();
        mapRef?.applied(from);
        // After Watch live: an undo it just hid the map for shows its notice too (SP4c spec §2.4).
        undoNotice.applied(from);
      },
    });
    teardown.push(() => applyControl.dispose());
    if (overlay) {
      void loading.fadeOut(FADE_MS);
      const hint = el('div', 'world-click-hint', 'Click to fly');
      hint.id = 'world-click-hint';
      host.append(hint);
      const onLock = (): void => {
        if (document.pointerLockElement !== canvas) return;
        hint.remove();
        document.removeEventListener('pointerlockchange', onLock);
      };
      document.addEventListener('pointerlockchange', onLock);
      teardown.push(() => {
        document.removeEventListener('pointerlockchange', onLock);
        hint.remove();
      });
    } else {
      loading.dispose();
    }

    // The frame loop's parts: the limiter, the stats, the HUD, the help and the input.
    const limiter: FpsLimiter = createFpsLimiter(settings.fpsCap);
    const frames = createFrameStats();
    // The HUD reads every count from its owner (SP4b spec §7.3), on its own timer outside the frame (§3.10).
    const gpu: GpuEstimate = { sectionsBytes: 0, skyBytes: 0, textureBytes: 0, lightmapBytes: 0, drawingBufferBytes: 0 };
    const huds = hud
      ? mountWorldHud(host, () => {
        const c = coordinator.counts(counts);
        const up = sections.counts(uploads);
        const info = world.info();
        const g = world.gpuEstimate(gpu);
        return {
          frame: frames.summary(),
          stages: { T: { ...c.T }, D: { ...c.D }, L: { ...c.L }, MESH: { ...c.MESH } },
          // "stale n / needed" while the world regenerates after an Apply (SP4c spec §4.5, D26).
          stale: c.stale,
          needed: c.MESH.needed,
          sections: up.rows,
          revealed: up.columnsRevealed,
          genCap: c.genCap,
          dropped: c.dropped,
          failed: c.failed,
          drawCalls: info.calls,
          triangles: info.triangles,
          position: { x: fly.x, y: fly.y, z: fly.z },
          speed: fly.speed,
          time: frame.t,
          timeSpeed: timeSpeed(),
          rdTarget: c.rd,
          rdFog: frame.rd,
          workers: workers.size,
          liveWorkers: workers.liveWorkers(),
          regions: up.regions,
          gpuMB: (g.sectionsBytes + g.skyBytes + g.textureBytes + g.lightmapBytes + g.drawingBufferBytes) / (1 << 20),
          sectionRenderer: kind,
          renderer: caps.renderer,
        };
      })
      : null;
    if (huds !== null) {
      teardown.push(() => huds.dispose());
      stopHud = () => huds.dispose();
    }
    // The hotbar, remembered in this browser (SP5a spec §4.3), and its HUD: the crosshair, the bar and the slot's name.
    const hotbar = createHotbar(storage);
    const buildHud = mountBuildHud(host, { hotbar, hud, locked: () => document.pointerLockElement === canvas });
    teardown.push(() => buildHud.dispose());

    // Every setting applies live (SP4b spec §5); an rd change goes through the RD control, which saves it. The help
    // shows the RD in force, the URL's on a `?rd=` load, not the saved one (rulings R8).
    let shownRd = rdShownOnLoad(q.rd, loadRd, settings.rd);
    const applySettings = (s: WorldSettings): void => {
      const change = helpChange(settings, s, shownRd);
      // While mode A covers the 3D the cap stays at most 60 (SP4c spec §2.6).
      if (s.fpsCap !== settings.fpsCap) limiter.setCap(frameCapFor(mapRef?.mode ?? 'full', mapRef?.shown ?? false, s.fpsCap));
      if (s.fov !== settings.fov) {
        world.camera.fov = s.fov;
        world.camera.updateProjectionMatrix();
      }
      settings = change.settings;
      frame.brightness = s.brightness;
      saveSettings(storage, settings);
      if (change.applyRd) rdControl.apply(s.rd);
    };
    const help: Help = mountHelp(host, {
      map: DEFAULT_KEYMAP,
      settings: { ...settings, rd: shownRd },
      onSettings: applySettings,
      report: caps,
      evaluation,
      rdMax,
      // "Map (M)" closes the help and opens the overlay (SP4c spec §1.6, D20); nothing navigates.
      openMap: () => mapRef?.open(),
      onFullscreen: () => {
        // Keyboard Lock is Chromium's and not in the DOM typings.
        void enterFullscreen(document, navigator as Navigator & KeyboardLockNavigator);
      },
      onClose: () => {},
    });
    // Closing removes the help's Esc listener from the document.
    teardown.push(() => help.close());
    // The creative palette (SP5a spec §4.4, D10): E opens it; its own E requests the lock back, a click around its panel too.
    const palette: Palette = mountPalette(host, {
      hotbar,
      requestLock: () => {
        try {
          // Chromium returns a promise that rejects when the lock is refused; others return nothing.
          const r: unknown = canvas.requestPointerLock();
          if (r instanceof Promise) r.catch(() => {});
        } catch {
          // A refused lock leaves the pointer free; a click on the canvas takes it.
        }
      },
      onClose: () => {},
    });
    teardown.push(() => palette.dispose());
    rdControl = createRdControl({
      coordinator,
      world,
      fog: {
        setTarget(r) {
          liveRd = r;
          rd = r;
          fog.setTarget(r);
          // A raise scans the filled radius on the next rendered frame.
          fogStep.rescan();
        },
      },
      help: {
        setRd(r) {
          shownRd = r;
          help.setRd(r);
        },
      },
      save: (r) => {
        settings = { ...settings, rd: r };
        saveSettings(storage, settings);
      },
      defaultRd: resolveRenderDistance(caps, null, null),
    });

    const onAction = (a: Action): void => {
      switch (a) {
        case 'speedUp': stepSpeed(fly, 1); break;
        case 'speedDown': stepSpeed(fly, -1); break;
        case 'timeSpeed': if (fixedT === null) speedIndex = (speedIndex + 1) % TIME_SPEEDS.length; break;
        case 'hud': huds?.toggle(); break;
        // H and M close the palette first (SP5a spec §4.4).
        case 'help':
          paletteFirst(palette, () => {
            if (help.isOpen) help.close();
            else {
              document.exitPointerLock();
              help.open();
            }
          });
          break;
        // M opens or closes the map overlay (SP4c spec §2.4); it acts whoever owns the controls.
        case 'map': paletteFirst(palette, () => mapKey(help, mapRef)); break;
        // E opens the palette, never over the help; while it is open its own E listener closes it (SP5a spec §4.4).
        case 'palette':
          if (!palette.isOpen) {
            if (help.isOpen) help.close();
            palette.open();
          }
          break;
        // 1-9 and the plain wheel change the slot (SP5a spec §4.1, D9).
        case 'slot1': case 'slot2': case 'slot3': case 'slot4': case 'slot5': case 'slot6': case 'slot7': case 'slot8':
        case 'slot9':
          hotbar.select(Number(a.slice(4)) - 1);
          break;
        case 'slotNext': hotbar.step(1); break;
        case 'slotPrev': hotbar.step(-1); break;
        default: break; // movement and sprint are held; Esc (releasePointer) is the browser's
      }
    };
    // A mouse button only queues its action; the frame's aim runs it (SP5a spec §4.1). A refusal does nothing; an
    // accepted click is one block-history step (§4.5).
    const clicks = createClickQueue({
      post: (edit) => { void actionPost([edit]); },
      hotbar,
      fly,
      editable: (cx, cz) => coordinator.editState(cx, cz) === 0,
    });
    const input = attachInput(canvas, {
      onAction,
      onLook: (dx, dy) => look(fly, dx, dy, settings.sensitivity * LOOK_DEG_PER_PIXEL),
      onButton: (b, down) => { if (down) clicks.push(b); },
      // Only text-entry controls (spec §7.1): a focused slider or select leaves H and F1 working (final review C-I2).
      isTextFocus: () => isTextEntry(document.activeElement as HTMLElement | null),
      // The world's keys act only while the world owns the controls (SP4c spec §2.3): never while the map owns.
      active: () => mapRef === null || mapRef.owner === 'world',
      doc: document,
      win: window,
    });
    teardown.push(() => input.dispose());

    // The teleport (SP4c spec §3.2-§3.4): the landing on the shared pool, the camera moved in place, the eye light
    // reset to 15; the fog does not react (Point 1). The next tick's `coordinator.update` does the crossing.
    const teleporter = createTeleport({
      pool: workers,
      fly,
      state: frame,
      // F5 after a teleport returns to where the user jumped (SP4c spec §1.6, D20); flight never rewrites the search.
      onArrive: (_x, _z, landing) => {
        worldUrl.arrived(fly);
        opts.wiTest?.landed(landing);
      },
      // "Could not teleport" (D26): in `.world-notices`, or in the tool's row while the map covers the 3D (D27).
      onFail: () => notices.show('Could not teleport', { kind: 'warn', timeoutMs: 4000 }),
    });
    // A landing still pending at teardown settles silently: no write to the disposed page's camera, no notice.
    teleport = teleporter;
    teardown.push(() => teleporter.dispose());
    // The map overlay (SP4c spec §1.3): M before the reveal does nothing, since nothing exists to receive it.
    const mapOverlay = createMapOverlay({
      app: root,
      worldHost: host,
      canvas,
      session,
      // The smoke's hook counts the map's tile requests on it (?wiTest=1 only).
      pool: opts.wiTest?.countTiles(workers) ?? workers,
      driver: previewDriver,
      relay,
      storage,
      settings,
      save: (m) => {
        settings = { ...settings, mapMode: m.mapMode, watchLive: m.watchLive };
        saveSettings(storage, settings);
      },
      // Mode B resizes the 3D at the switch and draws one frame (SP4c spec §2.2); mode A caps it at 60 (§2.6).
      world,
      // The frame step's live state, already current: never the warm-up helper `frameState()`, which would rewind
      // `t` to the opening time and write the raw sky light over D13's eye light at every layout change.
      frameState: () => frame,
      limiter,
      userCap: () => settings.fpsCap,
      fly,
      input,
      doc: document,
      win: window,
      now: () => performance.now(),
      // A plain click teleports (SP4c spec §3); the overlay closes the map on arrival in full screen.
      onTeleport: (x, z) => teleporter.go(x, z),
      // Every view change of the tool writes the world's URL (SP4c spec §1.6).
      viewChanged: () => worldUrl.viewChanged(),
      // The transient notices go to the tool's row while mode A covers the 3D; the Watch-live notice (D26, D27).
      notices,
    });
    mapRef = mapOverlay;
    // The smoke's test hook (SP4c spec §8.6; ?wiTest=1 only): the leak check's session listeners, the overlay closed and
    // its tool disposed, a forced fatal, the owner and the stale count.
    opts.wiTest?.attach({
      listenerCount: () => session.listenerCount(),
      closeOverlay: () => mapOverlay.close(),
      disposeTool: () => mapOverlay.tool?.dispose(),
      forceFatal: () => fail('A failure forced by the test hook.', new Error('forced by the smoke (?wiTest=1)')),
      owner: () => mapOverlay.owner,
      stale: () => coordinator.counts(counts).stale,
      edit: createHookEdit(actionPost, (x, y, z) => voxelValue(store, x, y, z)),
      blockAt: (x, y, z) => blockRead(store, x, y, z),
    });
    // Disposed before the input, the driver and the page's subscribe: a gesture still open ends through the tool.
    teardown.push(() => mapOverlay.dispose());
    // Undo and redo (SP4c spec §2.4; SP5a spec §4.5): live for the page's lifetime, map shown or hidden, never in text
    // entry; blocks while the world owns the controls, the session's params while the map does.
    teardown.push(installUndoKeys({ owner: () => mapOverlay.owner, blocks: blockHistory, session }));

    // The streaming frame (SP4b spec §7.2): the slow-frame notice and the throttle get every raw rAF delta before the
    // limiter, so an FPS cap of 30 is read as neither slow frames nor a reason to throttle generation.
    const clock = createFrameClock(limiter, slowFrames, revealTs);
    let n = 0;
    let firstMax = 0;
    // The DDA, the queued clicks and the outline (SP5a spec §3.5, §4.1).
    const pageAim = createAim({ fly, world, locked: () => document.pointerLockElement === canvas, hud, clicks });
    const step = createFrameStep({
      fly,
      held: () => input.held,
      // The flight pauses while the help or the palette is open or the map owns the controls (SP4c spec §2.3; SP5a §4.4).
      paused: () => help.isOpen || palette.isOpen || mapOverlay.owner === 'map',
      stopped: () => stopped,
      clock,
      coordinator,
      counts,
      throttle,
      budget: createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, () => performance.now()),
      sections,
      world,
      store,
      aim: (read, paused) => pageAim.aim(read, paused),
      state: frame,
      timeSpeed,
      // The fog eases outward after a raise, following the filled radius (SP4b spec §5): scanned around the camera's
      // column every 30 rendered frames while the fog is below its target, never once it has arrived.
      fogStep: (dtMs) => fogStep.step(dtMs),
      // The apply control before the coordinator's update; the aux policy from its counts (SP4c spec §4.3, §6.2).
      beforeUpdate: () => applyControl.tick(),
      afterCounts: (c) => updateAuxPolicy(workers, applyControl.generation, coversWorld(mapRef), c),
      onRendered: (dtMs) => {
        frames.push(dtMs);
        // The map's arrow follows the camera while it is shown (SP4c spec §1.5).
        mapOverlay.tick(counts);
        // The crosshair follows the pointer lock (SP5a spec §4.3); nothing changes at rest.
        buildHud.refresh();
        // The first 120 rendered frames' largest delta (SP4b spec §7.1; the flight JSON's key unchanged).
        if (n < FIRST_FRAMES) {
          firstMax = Math.max(firstMax, dtMs);
          if (n + 1 === FIRST_FRAMES) stats.first120MaxMs = firstMax;
        }
        n++;
        progressHook.frames = n;
        opts.onFrame?.(n);
      },
    });
    const loop = (now: number): void => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      try {
        // The tick may show the slow-frame notice, so it runs inside the guard.
        step.tick(now);
      } catch (e) {
        // An exception escaping the frame shows the failure panel and stops the loop (SP4b spec §7.4).
        fail(`The frame loop stopped: ${errorText(e)}`, e);
      }
    };
    raf = requestAnimationFrame(loop);
    settle();
  }

  run().catch((e: unknown) => {
    if (state === 'loading') {
      fail(causeOf(e), e);
      return;
    }
    // After the reveal (or a shown failure) there is no panel to show it on: report it and settle.
    console.error(e);
    settle();
  });
  return settled.then(() => page);
}

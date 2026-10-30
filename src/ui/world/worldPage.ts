/**
 * The 3D world page (SP4a spec §8.4, D21-D23, D32; rulings P8, P30, P36, P41, P42, P46-P49): from the loading screen to
 * the reveal, then the frame loop.
 *
 * 1. The `#` hash is decoded first: a decode error shows the failure panel with only the map link, and nothing is
 *    probed, allocated or loaded (P47). The loading screen shows at once. With `?world=<id>` (SP5b spec §3.4) the
 *    saved world's records are read instead (`openSavedWorld`) and its session built from them; a world that cannot
 *    open (held by another tab, or unreadable) goes back to the worlds menu with the notice (`refuseOpen`:
 *    `/?notice=locked` or `/?notice=unreadable`, its reason through `sessionStorage`), except an enter bench's load,
 *    which shows "This world could not be opened: <reason>" on the failure panel, so the bench records the error. Its
 *    `load` is posted right after the sim's attach and awaited with it, before the coordinator's first `update`. The
 *    enter bench's loads (`?enterBench=1`, SP5b spec §6.2) open `?db=` in place of `SAVES_DB` and record
 *    `window.__wiEnterResult` at the reveal: `revealMs` and, for a saved world, the connection's open, the `load`'s
 *    round trip and the sim's decode (`EnterTimes`). An unsaved world opened from a link shows SP5b's Point 2 notice
 *    (`unsavedNoticeOf`; an in-place mount from the menu, `opts.unsavedNotice`, its own).
 * 2. Probe and `evaluateWorldCapabilities` (§8.5): a blocking cause replaces the page with the error screen (the causes,
 *    the capability table and a `?map` link).
 * 3. The session (`openMapSession`, which wires tier 2 of the trees; a tier-2 notice shows as a warning and the load
 *    goes on), the settings, and the one render distance (`resolveRenderDistance`, P36). The store
 *    (`createStore({shared: true})` with the accepted reservation), the pool (`?workers` or clamp(cores − 2, 2, 6)),
 *    `attachStore`, then `configure` with the session's seed text and params.
 * 4. The centre is `?at` (in a saved world its saved x, z, `?at` ignored: `restoredStart`), else the pool's `spawn`.
 *    The world renderer (the section renderer the probe selects, `?renderer` overriding it; its first floating origin
 *    the snapped centre, SP4b spec §3.4) holds its reveals (`holdReveals(true)`). The first entry runs on the streaming
 *    coordinator (SP4b spec §3.11, D21), strict (any error stops the load, D12) and keeping every proto (D11): a rAF
 *    loop calls its `update` with the camera held at the centre, its sink stages each payload into the section
 *    renderer, and the loop pumps the uploads under a 12 ms budget with no row or structural cap and feeds the loading
 *    screen's progress from the coordinator's counts and the columns uploaded.
 * 5. When every column is meshed (`firstFill`) and every staged column uploaded: `compile()`, the camera placed with
 *    `firstView` from the store's `MOTION_BLOCKING` (`heightAt`; a saved world's y, yaw and pitch, flying speed and
 *    time restored, its walk after the reveal: SP5b spec §3.4 step 5), three frames rendered behind the opaque overlay
 *    (`warmUp`: every region drawn unculled, so the sections' buffers reach the GPU while still hidden), then
 *    `revealAll()` and the reveal frame, the overlay faded out over 300 ms, and "Click to fly" until the pointer locks.
 *    Nothing of the world is visible before that frame.
 *
 * At the reveal the coordinator leaves strict mode (D12) and the same coordinator streams. The frame loop is the
 * frame step (`frameStep.ts`, SP4b spec §7.2): every rAF the throttle (fed the raw delta before the FPS limiter), the
 * fly controller (horizontal flight with no horizontal limit, §6.1) and `coordinator.update`; on rendered frames the
 * uploads under the 2 ms / 32-row budget, the floating origin, the store's reclamation drain, the eye's sky light, the
 * clock (T cycles the time speed) and the render. The HUD (F3, the streaming counts of §7.3), the help (H, F1) and the
 * Settings screen (G, `settingsPanel.ts`, SP5b spec §1.4, D9).
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
 * hook, and hands the driver the latency's samples and the coordinator's `editDropped` at the end. For its save leg L11
 * (SP5b spec §6.2) the bench runs in a saved world of its own in `BENCH_DB` (`openBenchSave`: deleted, then the world
 * created, its `load` posted with the attach), with a block history, the action post L11's edits take and the page's
 * autosave, paused until the driver's "on" parts (`createBenchSave`); at the script's end or a failure every connection
 * is closed and the database deleted (`closeBenchSave`).
 *
 * Errors after the reveal (SP4b spec §3.6, §7.4, D12) degrade: a skipped column shows a dismissible notice with "Copy
 * details", StoreFull a notice offering "Lower to RD n" (applied live on a click, never on its own); a fatal event (no
 * live worker, `StoreCorrupt`, more than 32 failed columns), the pool's last worker failing and an exception escaping
 * the frame step stop the loop and show the notices' failure panel with "Copy details" and a Reload link.
 *
 * The render distance is live (SP4b spec §5, D18): an integer in [4, rdMax], rdMax = min(16, the reservation's cap);
 * the Settings screen's select, the slow-frame notice's and StoreFull's "Lower to RD n" all go through
 * `createRdControl`, which sets it on the coordinator (the next `update` re-classifies) and the renderer (the far
 * plane), moves the fog's target and saves the setting; "Default (n)" applies the resolved default. The fog eases outward after a raise
 * (`fogEase.ts`), following the filled radius scanned every 30 rendered frames, and moves in at once after a lower.
 *
 * After the reveal (spec §7.1, §7.5, §8.2, §8.5; rulings P49, P50): the Ctrl+W guard (`beforeunload`) is armed; every
 * navigation the page starts (the context-loss Reload, the failure panel's Reload, the help's "Worlds menu", SP5b spec
 * D31) goes through one reloader, which disarms the guard and navigates at most once; the help's buttons "Map (M)" and
 * "Settings (G)" open the map overlay and the Settings screen and navigate nowhere (SP4c spec §1.6, D20; SP5b spec
 * §1.4); a slow first 300 frames suggest the next lower RD in a dismissible notice whose button applies
 * it live; `webglcontextlost` stops the frame loop and offers a Reload around the camera (`hereUrl`, with the live
 * session's hash). SP4a's edge clamp, its notice and R are gone (SP4b spec §6.2, D20).
 *
 * The world's URL (SP4c spec §1.6, D20; `createWorldUrl`): after every Apply and every view change of the map it is
 * `pathname + search + '#' + ` the live session's hash (the map's view, or the camera's at 4 blocks/px before the first
 * M), through the debounced URL writer (a hash over 64 KiB dropped with the notice); each teleport's arrival rewrites
 * the search's `at`, `y`, `yaw` and `pitch`, flight never does; there is no `hashchange` listener in the world.
 *
 * A saved world (SP5b spec §3.2, §3.4 step 7, D4, D14): no URL writer, so the address stays `/?world=<id>`, and every
 * Reload (the failure panel's, the lost context's, the loading failure's lower RD) is `savedWorldUrl`. The autosave
 * (`createPageAutosave`) is armed at the reveal; every navigation the page starts waits for its `beforeLeave` (at most
 * 1,000 ms), and a failure after the reveal saves once more (`lastFlush`, unless the sim is what failed) before the
 * panel shows and the sim is released. The sim's failure notice is `SAVED_EDIT_FAILED_NOTICE`. Storage problems while it
 * plays (§3.8, D14; `watchStorage`): every `flushed` and the page's connection's events show D14's notices, the world
 * playable and its dirty set in the sim; `blocked` while the connection opens is a warning on the loading screen. One
 * tab per world (§3.5, D7, D24; `worldLock.ts`): the world's lock is taken before its records are read and before the
 * sim exists (held elsewhere past 2 s: back to the worlds menu with `LOCKED_NOTICE`), and released on `pagehide` after
 * the autosave's last save is posted, or at the teardown; a page restored from the back/forward cache reloads.
 *
 * The map in the world (SP4c spec §1.3, §2.3, §2.4, §4.2): at the reveal the streaming route creates the preview driver
 * (which adopts the first configure, wants no preview until the first M, and is fed every session change by the page
 * until the map tool is mounted, ruling R1) and the map overlay (`mapOverlay.ts`); M toggles it, the flight pauses and
 * the world's keys stop while the map owns the controls, the frame's `onRendered` moves the map's arrow, undo and redo
 * are installed for the page's lifetime (routed by owner since SP5a: `installUndoKeys`), and a fatal error or a context
 * loss disposes the overlay before the failure panel or the notice. The flight route creates neither; the bench creates the driver without the overlay.
 * In a saved world the overlay's header holds the world-modification switch (`modifyMode.ts`, SP5b spec §3.6, D10, D25):
 * the session is not writable from the open (`openSavedWorld`) until "Modify terrain" is switched on; an unsaved world
 * edits live with no switch. The apply control's `beforeApply` is the mode's: the first terrain change of each mode
 * session in a world with edits waits for its backup copy (§3.6, D11, D26), and each Apply or adopt's record
 * (`appliedRecord`) becomes the kept record and goes to the sim for the next flush.
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
 * Ctrl+Z / Ctrl+Y undo and redo blocks while the world owns the controls, the map's settings while the map does. A
 * mouse button goes through the hold repeat (`holdRepeat.ts`, §4.1, D6): a press queues once, and with the setting on
 * a held LMB or RMB is queued again by the frame's aim, until its release, the lock's release, a paused frame (the
 * palette, the map, the help, the Settings screen) or F.
 *
 * Keys with a panel open (SP5b spec §1.4; SP4a spec :731's hand-over): while the Settings screen, the help, the palette
 * or B's dialog is open, a focused control in it (a select, a slider, a checkbox, a button) keeps its own keys and the
 * world handles none of them (`worldIgnoresKeys`); otherwise H, G, M, B and E go through `paletteFirst`.
 */
import { GENERATOR_VERSION } from '../../core/constants';
import { hex64, type Seed64 } from '../../core/hash';
import { MEDIUM } from '../../core/params/graphicsPresets';
import { SCHEMA_VERSION, type JsonObject } from '../../core/params/migrate';
import type { Params } from '../../core/params/schema';
import { genKey, paramsHash, stageHashes } from '../../core/stage/hash';
import { OPENING_T, TIME_SPEEDS } from '../../daynight/dayNight';
import { probeCapabilities } from '../../engine/capabilities';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../engine/capabilityRules';
import {
  createCoordinator, createCoordinatorCounts, phaseName, progressFraction, worldJobsOf, type Coordinator, type StreamEvent,
} from '../../engine/coordinator';
import { appliedDraftOf, type WorldStage } from '../../engine/invalidation';
import { RD_MAX, defaultRenderDistance, reservationRdCap, resolveRenderDistance } from '../../engine/renderDistance';
import type { Stage } from '../../engine/rings';
import type { SessionState, WorldSession } from '../../engine/session';
import { SimFailed, createBrowserSim, type SimClient } from '../../engine/simClient';
import { createThrottle } from '../../engine/throttle';
import { createUploadBudget } from '../../engine/uploadBudget';
import { StoreFullError, WorkerFailed, createBrowserPool, poolSize, type WorkerPool } from '../../engine/workerPool';
import { deleteIdb, openIdbKV } from '../../persist/idb';
import type { KV } from '../../persist/kv';
import {
  MAX_PLACES, createSaves, loadParams, newState, normalizeHistory, normalizeState, parseWorldRecord, remapOf, tableRelation, todayStateTable, type HistoryRecord,
  type HotbarRecord, type Place, type Saves, type StateBounds, type StateRecord, type WorldRecord,
} from '../../persist/saves';
import { SPEED_DEFAULT, applyCameraRotation, look, lookVectorInto, stepSpeed, toggleMode, type FlyState } from '../../player/fly';
import { attachInput, isTextEntry } from '../../player/input';
import { HOTBAR_KEY, createHotbar, slotName, type Hotbar } from '../../player/hotbar';
import { bodyOf, breakAt, emptyBucketAt, pickAt, placeAt, type BodyBox } from '../../player/interaction';
import { DEFAULT_KEYMAP, type Action } from '../../player/keymap';
import { REACH_FLY, REACH_WALK, castRay, castRayFrom, createRayHit, type RayHit } from '../../player/raycast';
import { EYE, arriveFeet, createWalkState, setFeet, type WalkState } from '../../player/walk';
import { createFpsLimiter, type FpsLimiter } from '../../render/fpsLimiter';
import type { FrameState } from '../../render/frameState';
import { NEAR_FLY, NEAR_WALK, createWorldRenderer, type GpuEstimate, type WorldRenderer } from '../../render/renderer';
import { createSectionRendererCounts, selectSectionRenderer, type SectionRendererKind } from '../../render/sectionRenderer';
import { outlineBounds } from '../../render/selection';
import type { Edit, FlushedMsg, LoadedMsg, LoadMsg } from '../../workers/protocol';
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
import { decodeMapState, openMapSession, openSavedSession, type MapState } from '../map/mapState';
import { createPreviewDriver, createReplayingCanvas, draftOf, isSpawnError, type DriverStatus, type PreviewDriver } from '../map/previewDriver';
import { cryptoSeed } from '../seedBox';
import { SETTINGS_DEFAULTS, loadSettings, saveSettings, type WorldSettings } from '../settings';
import { mountSettingsPanel, type SettingsPanel } from '../settingsPanel';
import {
  BENCH_DB, BENCH_IDLE_FRAMES, BENCH_REFILL, BENCH_TIME_SPEED, benchInterval, createBenchRecorder, createLiveReveals, jsHeapMB, type BenchDriver,
  type BenchFlush, type BenchPose, type BenchWorld, type EnterResult,
} from './bench';
import { firstView } from './firstView';
import type { FlightContext } from './flight';
import { createFogEase, createFogStep, filledRadius } from './fogEase';
import { createFrameClock, createFrameNotice, lowerRd } from './frameNotice';
import { coversWorld, createApplyControl, createEpochs, updateAuxPolicy } from './applyControl';
import { LEAVE_WAIT_MS, createAutosave, createStateParts, type Autosave, type AutosaveDeps } from './autosave';
import { createEditLatency } from './editLatency';
import { mountBuildHud } from './buildHud';
import { createActionPost, createBlockHistory, type BlockHistory, type BlockStep } from './blockHistory';
import { createEditPath, type EditOutcome, type EditPath } from './editPath';
import { createFrameStep, eyeSkyLight } from './frameStep';
import { createHoldRepeat, type HoldRepeat } from './holdRepeat';
import { createMapOverlay, followSession, frameCapFor, worldMapView, type ControlsOwner, type MapOverlay } from './mapOverlay';
import { createModifyMode, createModifySwitch, type ModifyMode } from './modifyMode';
import { mountPlaceDialog, type PlaceDialog } from './placeDialog';
import {
  PLACE_COLOURS, PLACE_SAVED_MS, PLACE_SAVED_NOTICE, PLACES_FULL_MS, PLACES_FULL_NOTICE, createPlaces, proposedPlaceName, type Places,
} from './places';
import { createReloader, createWorldUrl, installLeaveGuard, navigateTo, savedWorldUrl, type Reloader, type WorldUrl } from './reload';
import { Y_MAX, Y_MIN, type WorldQuery } from './query';
import { STATE_BOUNDS } from './stateBounds';
import {
  TELEPORT_FAILED_MS, TELEPORT_FAILED_NOTICE, createTeleport, landAt, walkFeetY, type PointLanding, type Teleport, type TeleportLanding,
} from './teleport';
import { holdWorld, type LockManagerLike, type WorldHold } from './worldLock';
import {
  BLOCKED_NOTICE, NO_STORAGE, RELOAD_NOTICE, invalidParamsReason, refusalText, refusalUrl, sessionStorageOrNull, type OpenRefusal, type StorageLike,
} from '../worldsMenu';

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
  /**
   * An unsaved world mounted in place by the worlds menu (SP5b spec D14, `enterUnsaved`): the notice it shows in place
   * of Point 2's `UNSAVED_NOTICE` (an in-place mount has no `?at`, `?rd` or `?workers`); null shows none.
   */
  readonly unsavedNotice?: string | null;
}

/** SP5b's Point 2: an unsaved world opened from a link (`?at`, `?rd`, `?workers`), shown until dismissed. */
export const UNSAVED_NOTICE = 'This world is not saved: it was opened from a link. Use New world on the start screen to keep one.';

/**
 * The unsaved world's notice (SP5b spec Point 2, §1.1), or null: none in a saved world, the flight and the benches
 * (`opts.flight`, `opts.bench`, an `?enterBench=1` load: the enter bench's unsaved leg differs from its saved one only
 * in persistence, §6.2) or a `?shot=1` capture; else `opts.unsavedNotice` when given, else `UNSAVED_NOTICE`.
 */
export function unsavedNoticeOf(q: Pick<WorldQuery, 'world' | 'enterBench' | 'shot'>, opts: Pick<WorldPageOptions, 'flight' | 'bench' | 'unsavedNotice'>): string | null {
  if (q.world !== null || q.enterBench || q.shot || opts.flight !== undefined || opts.bench !== undefined) return null;
  return opts.unsavedNotice === undefined ? UNSAVED_NOTICE : opts.unsavedNotice;
}

/**
 * The page's refusal of a saved world (SP5b spec §3.4 steps 1-2): back to the worlds menu with its notice
 * (`leave(refusalUrl(…))`, an `unreadable` reason kept in `storage`), or, for an enter bench's load, the failure panel's
 * text (`fail`), which the bench publishes as its `{ error }`.
 */
export function refuseOpen(refusal: OpenRefusal, o: { readonly enterBench: boolean; readonly storage: StorageLike | null; leave(url: string): void; fail(text: string): void }): void {
  if (o.enterBench) o.fail(refusalText(refusal));
  else o.leave(refusalUrl(refusal, o.storage));
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

/** The raw light byte at block (x, y, z) read inside a read section (`VoxelStore.lightAt`). */
function lightRead(store: VoxelStore, x: number, y: number, z: number): number {
  store.enterRead();
  try {
    return store.lightAt(x, y, z);
  } finally {
    store.exitRead();
  }
}

/** `heightAt('motionBlocking')` at block column (⌊x⌋, ⌊z⌋) read inside a read section. */
function heightRead(store: VoxelStore, x: number, z: number): number | null {
  store.enterRead();
  try {
    return store.heightAt('motionBlocking', Math.floor(x), Math.floor(z));
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
 * Pushes the coordinator's dispose onto the page's teardown, which runs reversed, with the sim's stop after it: the sim
 * is stopped first (no batch posted, no reply applied), since the coordinator's dispose sweep ignores the sim's pins
 * (SP5a spec §2.1) and would free a record an edit in flight still writes. The stop then marks thread 15 dead, even when
 * the dispose throws: a worker terminated inside a pool lock leaves it held, and the sweep's `pool.free` meets it as a
 * `StoreCorrupt` (which the coordinator's dispose swallows) instead of a spin that never ends (SP4b spec §2.6). Two
 * steps, each guarded by `runTeardown`; the sim's own step, pushed when it was created, disposes it again (a no-op) and
 * still stops it on a load torn down before the coordinator exists.
 */
export function pushCoordinatorTeardown(
  teardown: Array<() => void>,
  coordinator: { dispose(): void },
  sim: { dispose(): void } | null,
  store: Pick<VoxelStore, 'markDead'>,
): void {
  teardown.push(() => coordinator.dispose());
  if (sim !== null) {
    teardown.push(() => {
      try {
        sim.dispose();
      } finally {
        store.markDead(SIM_THREAD);
      }
    });
  }
}

/**
 * A failure after the reveal (SP4b spec §7.4): stops the frame loop, closes the map overlay and disposes its tool (SP4c
 * spec §1.3, D27: the map never works on a released pool), shows the failure panel, then runs the release steps (the
 * HUD's timer, the teleport (ruling R5), the coordinator, the pool, the renderer), the overlay, the panel and each
 * release guarded as the teardown's (`runTeardown`): a release that throws (a `StoreCorrupt` in the coordinator's
 * sweep, a renderer whose context is gone, a tool's dispose) can neither hide the panel nor skip a later release (Task
 * 21 review M2). In a saved world `save` (`lastFlush`, SP5b spec §3.2, D14) runs after the overlays close, and the panel
 * and the releases wait for it (it settles within 1,000 ms); without it everything runs at once.
 */
export function stopAfterFailure(o: {
  stop(): void;
  /** Disposes the map overlay before the panel shows (the streaming route; the bench has none). */
  closeMap?(): void;
  /** A saved world's last flush, awaited before the panel and the releases (it never holds them past its bound). */
  save?(): Promise<void>;
  show(): void;
  readonly release: ReadonlyArray<() => void>;
  onError(e: unknown): void;
}): void {
  o.stop();
  const save = o.save;
  if (save === undefined) {
    runTeardown([() => o.closeMap?.(), o.show, ...o.release], o.onError);
    return;
  }
  runTeardown([() => o.closeMap?.()], o.onError);
  const rest = (): void => runTeardown([o.show, ...o.release], o.onError);
  new Promise<void>((resolve) => { resolve(save()); }).then(rest, (e: unknown) => {
    o.onError(e);
    rest();
  });
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
 * The overlays a failure or a context loss closes before the panel or the notice shows (SP4c spec §1.3, D27; final
 * review UI-2): the palette, closed without requesting the lock (its overlay, z-index 3, covers the notices, z-index 2),
 * then B's place dialog, the same way and on the palette's layer (SP5b spec §3.7), then the Settings screen, on the
 * help's layer (SP5b spec §1.4), then the map overlay, disposed with its tool. A palette whose close throws still lets
 * the dialog, the Settings screen and the map close; the throw then reaches the caller's `onError`.
 */
export function closeOverlays(
  palette: Pick<Palette, 'isOpen' | 'close'> | null,
  map: Pick<MapOverlay, 'dispose'> | null,
  placeDialog: Pick<PlaceDialog, 'isOpen' | 'close'> | null = null,
  settingsPanel: Pick<SettingsPanel, 'isOpen' | 'close'> | null = null,
): void {
  try {
    try {
      if (palette?.isOpen) palette.close();
    } finally {
      try {
        if (placeDialog?.isOpen) placeDialog.close();
      } finally {
        if (settingsPanel?.isOpen) settingsPanel.close();
      }
    }
  } finally {
    map?.dispose();
  }
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

/** A saved world's lock on its page (`installWorldLock`). */
export interface WorldLockOnPage {
  /** Registers a last save run on `pagehide` before the release (the autosave's trigger); returns its remover. */
  onPageHide(f: () => void): () => void;
  /**
   * Registers a stop run once the lock is released at a `pagehide`, after the release (the autosave's dispose), so a page
   * restored from the back/forward cache posts nothing more; returns its remover.
   */
  onRelease(f: () => void): () => void;
  /** The page's teardown: removes both listeners and releases the lock. */
  dispose(): void;
}

/**
 * A saved world's lock while its page is open (SP5b spec §3.5, D24): on the first `pagehide` every save `onPageHide`
 * registered is posted first (each guarded: one that throws is reported and the release still runs), then the lock is
 * released, so the next holder (this tab's reload, another tab) is granted it only after the last save was posted, and
 * then every stop `onRelease` registered runs. A tab without the lock never writes: a later `pagehide` (the reload of a
 * page restored from the back/forward cache) runs nothing. A `pageshow` with `persisted` (the page restored, its lock
 * released at the `pagehide`) reloads it.
 */
export function installWorldLock(
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  lock: WorldHold,
  reload: () => void,
): WorldLockOnPage {
  const saves = new Set<() => void>();
  const stops = new Set<() => void>();
  let held = true;
  const each = (fs: Set<() => void>, what: string): void => {
    for (const f of fs) {
      try {
        f();
      } catch (e) {
        console.error(what, e);
      }
    }
  };
  const onPageHide = (): void => {
    if (!held) return;
    held = false;
    each(saves, 'The world\'s last save on pagehide:');
    saves.clear();
    lock.release();
    each(stops, 'The world\'s stop after its release:');
    stops.clear();
  };
  const onPageShow = (e: Event): void => {
    if ((e as PageTransitionEvent).persisted) reload();
  };
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  const register = (fs: Set<() => void>, f: () => void): () => void => {
    if (!held) return () => {};
    const g = (): void => f();
    fs.add(g);
    return () => { fs.delete(g); };
  };
  return {
    onPageHide: (f) => register(saves, f),
    onRelease: (f) => register(stops, f),
    dispose() {
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      held = false;
      saves.clear();
      stops.clear();
      lock.release();
    },
  };
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
  /** Flying or walking (`FlyState.mode`, SP5a spec §3.1). */
  mode(): 'fly' | 'walk';
  /**
   * The last rendered frame's aim (SP5a spec §3.5): the DDA's hit, whether or not the pointer is locked (`hit` false: no
   * target), its voxel and `FACE_*`; `outline` whether the outline object is visible (only while locked, unpaused, with
   * the HUD).
   */
  aim(): { hit: boolean; x: number; y: number; z: number; face: number; outline: boolean };
  /** The hotbar (SP5a spec §4.3): the active slot and each slot's name as the HUD and the palette show it (`slotName`). */
  hotbar(): { active: number; slots: string[] };
  /** The block history's steps (SP5a spec §4.5): those that can be undone and those that can be redone. */
  blockHistory(): { size: number; redo: number };
  /** The raw light byte at block (x, y, z) (sky << 4 | block), read inside a read section; −1 when its column is not Published. */
  lightAt(x: number, y: number, z: number): number;
  /**
   * The walk's current feet (x, z the body's centre, y its bottom), `onGround`, `snapPending` and `snapY` (the feet y the
   * last snap set, null before any snap, which CDP's `returnByValue` cannot carry as NaN); null while flying.
   */
  feet(): { x: number; y: number; z: number; onGround: boolean; snapPending: boolean; snapY: number | null } | null;
  /** `heightAt('motionBlocking')` at block column (⌊x⌋, ⌊z⌋), read inside a read section; null when it is not Published. */
  heightAt(x: number, z: number): number | null;
}

/** The parts of the hook the world page supplies once its streaming route runs. */
export type WiTestPage = Pick<WiTest,
  'listenerCount' | 'closeOverlay' | 'disposeTool' | 'forceFatal' | 'owner' | 'stale' | 'edit' | 'blockAt' | 'mode' | 'aim' | 'hotbar' | 'blockHistory'
  | 'lightAt' | 'feet' | 'heightAt'>;

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
    mode: () => attached().mode(),
    aim: () => attached().aim(),
    hotbar: () => attached().hotbar(),
    blockHistory: () => attached().blockHistory(),
    lightAt: (x, y, z) => attached().lightAt(x, y, z),
    feet: () => attached().feet(),
    heightAt: (x, z) => attached().heightAt(x, z),
  };
  win.__wiTest = hook;
  return {
    hook,
    attach(p) { page = p; },
    countTiles: (pool) => countTileCalls(pool, () => { tiles++; }),
    landed(l) { landing = { surface: l.surface, water: Number.isFinite(l.water) ? l.water : null, y: l.y }; },
  };
}

/** The notice of the sim's failure (SP5a spec §2.1); it stays until dismissed. An unsaved world's (SP5b D29). */
export const EDIT_FAILED_NOTICE = 'Editing stopped: the edit worker failed; this session\'s edits are lost';
/** The sim's failure notice in a saved world (SP5b spec D14): what the last committed flush saved is kept. */
export const SAVED_EDIT_FAILED_NOTICE = 'Editing stopped: the edit worker failed; changes after the last save (at most 2 s) are lost';

/**
 * The sim's failure (SP5a spec §2.1), which the route calls from the sim client's `onFailure`, before the client rejects
 * the pending batches: thread 15 marked dead (its reader epoch no longer holds releases in limbo), the edit path
 * disabled, every sim pin released (`simUnpinAll`, so a pending post's rejection needs no `simUnpin`) and the notice
 * shown with no timeout, `SAVED_EDIT_FAILED_NOTICE` in a saved world (SP5b spec D14). The world keeps streaming.
 */
export function onSimFailure(o: {
  store: Pick<VoxelStore, 'markDead'>;
  coordinator: Pick<Coordinator, 'simUnpinAll'>;
  editPath: { disable(): void };
  notices: Pick<WorldNotices, 'show'>;
  /** A saved world's (default false: SP5a's notice). */
  saved?: boolean;
}): void {
  o.store.markDead(SIM_THREAD);
  o.editPath.disable();
  o.coordinator.simUnpinAll();
  o.notices.show(o.saved === true ? SAVED_EDIT_FAILED_NOTICE : EDIT_FAILED_NOTICE, { kind: 'error' });
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
 * (eased outward after a raise, in at once after a lower), saves the setting and shows it in the Settings screen (SP5b
 * spec §1.4). `null` is "Default": saved as null, `defaultRd` applied. Every change goes through it: the Settings
 * screen's select, the slow-frame notice's and StoreFull's "Lower to RD n". The screen's copy is updated each time
 * (`setRd`, without a change event), so a notice's lower RD is what a later FOV or brightness change sends back through
 * `onSettings`, never the stale one.
 */
export function createRdControl(o: {
  readonly coordinator: Pick<Coordinator, 'setRenderDistance'>;
  readonly world: Pick<WorldRenderer, 'setRenderDistance' | 'camera'>;
  readonly fog: { setTarget(rd: number): void };
  readonly panel: Pick<SettingsPanel, 'setRd'>;
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
      o.panel.setRd(rd);
    },
  };
}

/**
 * The RD the Settings screen's `#setting-rd` shows on load (rulings R8): the RD in force, which is the URL's (`loadRd`,
 * clamped) on a `?rd=` load and the saved setting otherwise (null: "Default"). It never shows a saved RD that is not
 * in force.
 */
export function rdShownOnLoad(queryRd: number | null, loadRd: number, savedRd: number | null): number | null {
  return queryRd === null ? savedRd : loadRd;
}

/**
 * A change from the Settings screen (SP4b spec §5; rulings R8; SP5b spec §1.4). The screen's settings carry the RD it
 * shows, the RD in force (`shownRd`), not the saved one: the rd applies live only when it differs from `shownRd` (the
 * RD control then saves it), so the RD in force is a no-op and the saved value is not; every other change is saved with
 * the saved rd kept. The map's mode and Watch live are kept from `saved` too (SP4c spec §2.5): the screen has no
 * control for them, and its copy is the one it saw at mount, which would undo a later mode switch.
 */
export function settingsChange(
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
 * Esc would close together with the map's drawer (final review WLD-1). Closing the map leaves the help as it is. The
 * page passes the help and the Settings screen as one (`panels`), so the same holds for the screen (SP5b spec §1.4).
 */
export function mapKey(help: Pick<Help, 'isOpen' | 'close'>, map: Pick<MapOverlay, 'shown' | 'toggle'> | null): void {
  if (map === null) return;
  if (!map.shown && help.isOpen) help.close();
  map.toggle();
}

/**
 * M and H with the palette open (SP5a spec §4.4, D10), and G and B since SP5b (spec §1.4, §3.7): the palette closes
 * first, without requesting the lock, then the key does what it does with the palette closed (`then`), so the palette
 * never stays open under the map, the help, the Settings screen or B's dialog.
 */
export function paletteFirst(palette: Pick<Palette, 'isOpen' | 'close'>, then: () => void): void {
  if (palette.isOpen) palette.close();
  then();
}

/**
 * G (SP5b spec §1.4, D9), through `paletteFirst` as M and H: with the Settings screen open it closes it; else, unless
 * B's dialog is open, it closes the help (one panel at a time, as M's `mapKey`), releases the pointer and opens the
 * screen, which pauses the world (the frame step's `paused`).
 */
export function settingsKey(o: {
  readonly palette: Pick<Palette, 'isOpen' | 'close'>;
  readonly help: Pick<Help, 'isOpen' | 'close'>;
  readonly dialog: Pick<PlaceDialog, 'isOpen'>;
  readonly panel: Pick<SettingsPanel, 'isOpen' | 'open' | 'close'>;
  releasePointer(): void;
}): void {
  paletteFirst(o.palette, () => {
    if (o.panel.isOpen) {
      o.panel.close();
      return;
    }
    if (o.dialog.isOpen) return;
    if (o.help.isOpen) o.help.close();
    o.releasePointer();
    o.panel.open();
  });
}

/** The controls that keep their own keys inside an open panel: a select, any `<input>`, a button, a text area. */
const PANEL_CONTROL_TAGS: ReadonlySet<string> = new Set(['SELECT', 'INPUT', 'BUTTON', 'TEXTAREA']);

/** The focused element `worldIgnoresKeys` reads (`isTextEntry`'s). */
type FocusTarget = { readonly tagName: string; readonly type?: string; readonly isContentEditable?: boolean };

/** A panel the world's keys defer to (`worldIgnoresKeys`): whether it is open, and its root element (null: none). */
export interface KeyPanel<N> {
  readonly panel: { readonly isOpen: boolean };
  readonly root: { contains(other: N | null): boolean } | null;
}

/**
 * The world's `isTextFocus` (SP5b spec §1.4; closes SP4a spec :731's `isTextEntry` hand-over): the world ignores a key
 * in a text-entry control (`isTextEntry`), and in any focused control inside a panel that is open now (the Settings
 * screen, the help, the palette or B's dialog), so a select, a slider, a checkbox or a button keeps its own keys (the
 * arrows move a slider, Space presses a button) and the world handles none of them. A control left focused in a panel
 * that has closed, hidden, is no open panel's (review I1): with the focus elsewhere the keys still reach the world, so
 * H, G, M, B and E act through `paletteFirst`.
 */
export function worldIgnoresKeys<N extends FocusTarget>(
  focused: N | null,
  panels: readonly KeyPanel<N>[],
): boolean {
  if (isTextEntry(focused)) return true;
  if (focused === null || !PANEL_CONTROL_TAGS.has(focused.tagName.toUpperCase())) return false;
  for (const { panel, root } of panels) if (panel.isOpen && root !== null && root.contains(focused)) return true;
  return false;
}

/**
 * B (SP5b spec §3.7, D12), through `paletteFirst` as M and H: in a saved world (`places` non-null; an unsaved world
 * stays SP5a's, D29), with neither the help, the Settings screen nor the dialog open, the dialog opens with the
 * camera's exact pose as the place and its position rounded down in the proposed name; its Save keeps the place and
 * shows "Place saved" (1.5 s). With `MAX_PLACES` places, "A world holds at most 256 places" (4 s) and no dialog.
 */
export function savePlaceKey(o: {
  readonly palette: Pick<Palette, 'isOpen' | 'close'>;
  readonly help: Pick<Help, 'isOpen'>;
  readonly settings: Pick<SettingsPanel, 'isOpen'>;
  readonly dialog: Pick<PlaceDialog, 'isOpen' | 'open'>;
  readonly places: Pick<Places, 'list' | 'add'> | null;
  readonly camera: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch'>;
  readonly notices: { show(text: string, ms: number): void };
}): void {
  paletteFirst(o.palette, () => {
    const { places } = o;
    if (places === null || o.help.isOpen || o.settings.isOpen || o.dialog.isOpen) return;
    if (places.list.length >= MAX_PLACES) {
      o.notices.show(PLACES_FULL_NOTICE, PLACES_FULL_MS);
      return;
    }
    const { x, y, z, yaw, pitch } = o.camera;
    o.dialog.open(proposedPlaceName(places.list.length, x, y, z), (name, colour) => {
      if (places.add({ name, colour, x, y, z, yaw, pitch }) !== 'full') o.notices.show(PLACE_SAVED_NOTICE, PLACE_SAVED_MS);
    });
  });
}

/**
 * "+ Add at the pin" (SP5b spec §3.7, D13): B's dialog for the pin's column, standing on its ground (the walking
 * teleport's feet, max(surface, water) + 1, from the pool's `landing` at the pin's block, `landAt`), the eye `EYE` above
 * them, at the block's centre, looking where the camera looks; its Save keeps the place and shows "Place saved" (1.5 s).
 * Resolves true once the dialog opened. With `MAX_PLACES` places, "A world holds at most 256 places" (4 s), no landing
 * and no dialog; with the dialog already open, nothing. A landing that fails (as the teleport's `onFail`) opens no
 * dialog and shows "Could not teleport".
 */
export async function addPlaceAt(o: {
  readonly pool: Pick<WorkerPool, 'landing'>;
  readonly dialog: Pick<PlaceDialog, 'isOpen' | 'open'>;
  readonly places: Pick<Places, 'list' | 'add'>;
  readonly camera: Pick<FlyState, 'yaw' | 'pitch'>;
  readonly notices: Pick<WorldNotices, 'show'>;
}, x: number, z: number): Promise<boolean> {
  const { places, dialog, notices } = o;
  if (dialog.isOpen) return false;
  if (places.list.length >= MAX_PLACES) {
    notices.show(PLACES_FULL_NOTICE, { timeoutMs: PLACES_FULL_MS });
    return false;
  }
  let at: PointLanding;
  try {
    at = await landAt(o.pool, x, z);
  } catch {
    notices.show(TELEPORT_FAILED_NOTICE, { kind: 'warn', timeoutMs: TELEPORT_FAILED_MS });
    return false;
  }
  // B, or a second click, may have opened the dialog while the landing was asked.
  if (dialog.isOpen) return false;
  const y = walkFeetY(at.surface, at.water) + EYE;
  const { yaw, pitch } = o.camera;
  dialog.open(proposedPlaceName(places.list.length, at.x, y, at.z), (name, colour) => {
    const kept = places.add({ name, colour, x: at.x, y, z: at.z, yaw, pitch });
    if (kept !== 'full') notices.show(PLACE_SAVED_NOTICE, { timeoutMs: PLACE_SAVED_MS });
  });
  return true;
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
 * The mouse buttons pressed since the last rendered frame (SP5a spec §4.1, D6): `onButton` only queues (through the
 * hold repeat, `holdRepeat.ts`, which also queues a held button's repeats), and the page's aim runs the queue in the
 * frame's second read section against the target aimed then, so a click never reads the store outside a read section.
 * LMB breaks (`breakAt`); RMB places the hotbar's active slot (`placeAt`: a block or a bucket's source, against the
 * body and the look's yaw: flying the eye's, walking the walk state's current tick, rulings R23), or with the empty
 * bucket drains the first fluid on a `'fluid'` ray from the eye within the mode's reach (`emptyBucketAt`); each edit
 * posted through the edit path. MMB picks the aimed type into the hotbar (`pickAt` → `hotbar.pick`). A refused or
 * missed click does nothing.
 */
export interface ClickQueue {
  /**
   * Queues a press at `t` (the edit path's clock), which its post carries so the HUD's edit latency runs from the click
   * (§4.6; final review UI-3); without `t` the post's own time starts it.
   */
  push(b: 0 | 1 | 2, t?: number): void;
  /** Runs every queued button against `hit` and empties the queue. Allocates nothing while it is empty. */
  run(hit: RayHit, read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>): void;
  /** Empties the queue unrun (a paused frame: the help, the palette, map mode B). */
  clear(): void;
}

export function createClickQueue(o: {
  post(edit: Edit, tClick: number | undefined): void;
  /** RMB places its active slot; MMB picks into it. */
  readonly hotbar: Pick<Hotbar, 'slots' | 'active' | 'pick'>;
  /** The eye, the look and the mode: the body a place must not enter, a ladder's facing, the empty bucket's ray. */
  readonly fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'mode'>;
  /** Walking, the body is the walk state's current feet (not the eye drawn between two ticks). */
  readonly walk: Pick<WalkState, 'x' | 'y' | 'z'>;
  /** A place's column gate (the page: `editState === 0`). */
  editable(cx: number, cz: number): boolean;
}): ClickQueue {
  const { fly, walk } = o;
  const buttons = new Uint8Array(CLICK_QUEUE_CAP);
  /** Each queued press's time, NaN for none. */
  const times = new Float64Array(CLICK_QUEUE_CAP);
  let n = 0;
  const body: BodyBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  const fluidHit = createRayHit();
  const dir = new Float64Array(3);
  const place = (hit: RayHit, read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>): Edit | null => {
    const slot = o.hotbar.slots[o.hotbar.active]!;
    if (!('tool' in slot)) {
      const b = fly.mode === 'walk'
        ? bodyOf('walk', walk.x, walk.y + EYE, walk.z, body)
        : bodyOf('fly', fly.x, fly.y, fly.z, body);
      return placeAt(hit, slot, fly.yaw, b, read, o.editable);
    }
    lookVectorInto(dir, fly.yaw, fly.pitch);
    castRay(read, fly.x, fly.y, fly.z, dir[0]!, dir[1]!, dir[2]!, fly.mode === 'walk' ? REACH_WALK : REACH_FLY, 'fluid', fluidHit);
    return emptyBucketAt(fluidHit, read);
  };
  return {
    push(b, t) {
      if (n === CLICK_QUEUE_CAP) return;
      times[n] = t ?? Number.NaN;
      buttons[n++] = b;
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
        if (edit === null) continue;
        const t = times[i]!;
        o.post(edit, Number.isNaN(t) ? undefined : t);
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
  /** Whether the last `aim` showed the outline (`setOutline`) rather than hiding it. */
  readonly outlined: boolean;
  aim(read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>, paused: boolean): void;
}

/**
 * The page's aim (SP5a spec §3.5, D8), which the frame step runs on every rendered tick inside its second read section:
 * the DDA from the eye along the look (`lookVectorInto`, `castRayFrom`; reach `REACH_WALK` walking, `REACH_FLY`
 * flying), then the outline around the hit (`outlineBounds`: the cell, or a box state's box), relative to the floating
 * origin, computed on every hit; then the outline set to that box, or hidden: while paused, while the pointer is free,
 * with no target, and without the HUD (captures, panoramas, the bench). The queued clicks (`clicks`) run between the
 * two against the hit, a miss included (it empties the queue); a paused frame drops them unrun. Before they run the
 * held button's repeat (`repeat`, §4.1, D6) is ticked at the frame's time, so a repeat is aimed by this frame's DDA; a
 * paused frame (the palette, the map owning the controls, the help) stops it instead. Allocates nothing.
 */
export function createAim(o: {
  readonly fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'mode'>;
  readonly world: Pick<WorldRenderer, 'origin' | 'setOutline' | 'hideOutline'>;
  /** True while the canvas holds the pointer lock. */
  locked(): boolean;
  /** The page's HUD option (`WorldPageOptions.hud`). */
  readonly hud: boolean;
  /** The queued mouse buttons (the streaming route's; the bench has none). */
  readonly clicks?: Pick<ClickQueue, 'run' | 'clear'>;
  /** The held button's repeat and the frame clock it runs on, in seconds (the streaming route's; the bench has none). */
  readonly repeat?: { readonly hold: Pick<HoldRepeat, 'tick' | 'stop'>; now(): number };
}): Aim {
  const { fly, world } = o;
  const hit = createRayHit();
  // The eye and the look, the DDA's ray (`castRayFrom`: no double boxed at the call); `dir` views its last three.
  const ray = new Float64Array(6);
  const dir = ray.subarray(3);
  const box = new Float64Array(6);
  let outlined = false;
  return {
    hit,
    box,
    get outlined() {
      return outlined;
    },
    aim(read, paused) {
      ray[0] = fly.x;
      ray[1] = fly.y;
      ray[2] = fly.z;
      lookVectorInto(dir, fly.yaw, fly.pitch);
      castRayFrom(read, ray, fly.mode === 'walk' ? REACH_WALK : REACH_FLY, 'block', hit);
      if (paused) {
        o.repeat?.hold.stop();
        o.clicks?.clear();
      } else {
        o.repeat?.hold.tick(o.repeat.now());
        o.clicks?.run(hit, read);
      }
      if (!hit.hit) {
        world.hideOutline();
        outlined = false;
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
      outlined = !paused && o.hud && o.locked();
      if (!outlined) world.hideOutline();
      else world.setOutline(box[0], box[1], box[2], box[3], box[4], box[5]);
    },
  };
}

/**
 * F (SP5a spec §3.1, D1): switches flight and walking (`toggleMode`), sets the camera's near plane for the new mode
 * (`NEAR_WALK` walking, `NEAR_FLY` flying) and ends a held button's repeat (§4.1).
 */
export function switchMode(o: {
  readonly fly: FlyState;
  readonly walk: WalkState;
  readonly world: Pick<WorldRenderer, 'setNear'>;
  readonly repeat: Pick<HoldRepeat, 'stop'>;
}): void {
  toggleMode(o.fly, o.walk);
  o.world.setNear(o.fly.mode === 'walk' ? NEAR_WALK : NEAR_FLY);
  o.repeat.stop();
}

/** The clock's position t of hour `hours` (0 … 24): `clockHours`'s inverse, 0 at 06:00 (`?time=`, a capture's fixed hour). */
export function timeOfHours(hours: number): number {
  return ((((hours - 6) / 24) % 1) + 1) % 1;
}

/**
 * The bench's `setTime` (SP5a spec §6.5, a review scene): the frame state's clock at `hours` and the bench's day speed
 * 0, so the frame step keeps it there.
 */
export function benchSetTime(state: { t: number }, clock: { speed: number }, hours: number): void {
  state.t = timeOfHours(hours);
  clock.speed = 0;
}

/** The bench's hold repeat for `switchMode`: none (the bench takes no input). */
const NO_REPEAT: Pick<HoldRepeat, 'stop'> = { stop() {} };

/** The bench's `walk` (SP5a spec §6.5, a review scene): F's path (`switchMode`) when the mode is not the one asked. */
export function benchWalk(o: Parameters<typeof switchMode>[0], on: boolean): void {
  if ((o.fly.mode === 'walk') !== on) switchMode(o);
}

/** `+` and `-` (and Ctrl+wheel in flight) step the flight speed; walking they do nothing (SP5a spec §3.3). */
export function speedKey(fly: FlyState, dir: 1 | -1): void {
  if (fly.mode === 'fly') stepSpeed(fly, dir);
}

/**
 * The lock's release ends a held button's repeat (SP5a spec §4.1, D6): a `pointerlockchange` that leaves the canvas
 * without the lock calls `stop`, since the button's `mouseup` no longer reaches the world (`attachInput` passes buttons
 * only while locked), so a press held across an Esc never repeats after the next click takes the lock. Returns the
 * remover.
 */
export function installRepeatStop(o: {
  readonly doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>;
  readonly canvas: unknown;
  readonly repeat: Pick<HoldRepeat, 'stop'>;
}): () => void {
  const onLockChange = (): void => {
    if (o.doc.pointerLockElement !== o.canvas) o.repeat.stop();
  };
  o.doc.addEventListener('pointerlockchange', onLockChange);
  return () => o.doc.removeEventListener('pointerlockchange', onLockChange);
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

/** The IndexedDB database of the saved worlds (SP5b spec §2.1, D16). */
export const SAVES_DB = 'wi10';
/** D14: a saved world whose `state` record is not a record opens at the spawn with its defaults. */
export const STATE_RESET_NOTICE = 'This world\'s position, time, hotbar and places could not be read and were reset';
/** D14: a saved world whose `history` record is there but not a record opens with no undo or redo steps. */
export const HISTORY_RESET_NOTICE = 'This world\'s undo history could not be read';
/**
 * Ruling P6: the page's connection to `SAVES_DB` could not be opened (blocked site data, no `indexedDB`); the menu's
 * `NO_STORAGE` (D14, ruling P37).
 */
const STORAGE_UNAVAILABLE = NO_STORAGE;

/** D14: a flush refused for quota; it stays until a later flush succeeds. */
export const QUOTA_NOTICE = 'Not saving: the browser\'s storage is full. Free space, or export your worlds from Load world.';
/** D14: the browser closed the storage (site data cleared): a flush answered `closed`, or the page's connection's `closed`. */
export const CLOSED_NOTICE = 'Not saving: this browser\'s storage was closed. Reload to continue.';

/**
 * D14's notices while a saved world plays (SP5b spec §2.1, §3.8): a `flushed` refused with `QuotaExceededError` shows
 * `QUOTA_NOTICE` once per run of failed flushes, hidden by the next one that succeeds; `closed` shows `CLOSED_NOTICE`
 * (the autosave then stops posting); any other abort shows nothing (the autosave retries at every tick). The page's
 * connection's `versionchange` shows `RELOAD_NOTICE`, `blocked` `BLOCKED_NOTICE` and `closed` `CLOSED_NOTICE`. The world
 * stays playable and the dirty set stays in the sim's memory. `dispose` stops listening to `kv`.
 */
export function watchStorage(notices: Pick<Notices, 'show' | 'hide'>, kv: Pick<KV, 'onEvent'>): { flushed(r: FlushedMsg): void; dispose(): void } {
  let full = false;
  const off = kv.onEvent((e) => {
    if (e === 'versionchange') notices.show(RELOAD_NOTICE, { kind: 'error' });
    else if (e === 'blocked') notices.show(BLOCKED_NOTICE, { kind: 'warn' });
    else notices.show(CLOSED_NOTICE, { kind: 'error' });
  });
  return {
    flushed(r) {
      if (r.ok) {
        if (full) notices.hide(QUOTA_NOTICE);
        full = false;
      } else if (r.status === 'closed') {
        notices.show(CLOSED_NOTICE, { kind: 'error' });
      } else if (r.errorName === 'QuotaExceededError' && !full) {
        full = true;
        notices.show(QUOTA_NOTICE, { kind: 'error' });
      }
    },
    dispose: off,
  };
}

/** A saved world's records as the page opens them (SP5b spec §3.4 step 2), or why it cannot open. */
export type SavedWorldRead =
  | { ok: true; world: WorldRecord; params: Params; state: StateRecord; history: HistoryRecord; notices: string[] }
  | { ok: false; reason: string };

/**
 * Reads world `id`'s `worlds`, `state` and `history` records in one read (SP5b spec §3.4 step 2, D14): a read that
 * fails, a missing `worlds` record, one `parseWorldRecord` refuses, or params `loadParams` refuses → `{ok: false,
 * reason}`. A `state` that is not a record → `newState`'s defaults with `STATE_RESET_NOTICE`; an absent `history` (a new
 * world's: Create writes none) → none and no notice; a present one that is not a record → none with
 * `HISTORY_RESET_NOTICE`. Both go through the normaliser with `bounds`, the history's values remapped through
 * `remapOf(world.stateTable)` when the stored table is neither today's nor a prefix of it (D22).
 */
export async function readSavedWorld(saves: Saves, id: string, bounds: StateBounds): Promise<SavedWorldRead> {
  let raw: { world: unknown; state: unknown; history: unknown };
  try {
    raw = await saves.readOpen(id);
  } catch (e) {
    return { ok: false, reason: `its records could not be read (${errorText(e)})` };
  }
  if (raw.world === undefined) return { ok: false, reason: 'no saved world has this id' };
  const parsed = parseWorldRecord(raw.world);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const world = parsed.world;
  const params = loadParams(world);
  if (!params.ok) return { ok: false, reason: invalidParamsReason(params.issues) };
  const notices: string[] = [];
  const state = normalizeState(raw.state, id, bounds);
  if (state.reset) notices.push(STATE_RESET_NOTICE);
  const to = tableRelation(world.stateTable) === 'other' ? remapOf(world.stateTable).to : null;
  const history = normalizeHistory(raw.history, id, to);
  if (history.reset) notices.push(HISTORY_RESET_NOTICE);
  return { ok: true, world, params: params.value, state: state.state, history: history.history, notices };
}

/** What the page posts as `load` (the message without its `type` and `id`). */
export type SavedLoad = Omit<LoadMsg, 'type' | 'id'>;

/**
 * The `load` a saved world's open posts and the record the page keeps (SP5b spec §2.3, §3.4 step 3, §3.6; D22): the
 * stored `stateTable` (the sim reads the stored ids through it), the world's genKey and the state's `flushSeq` and
 * `updated`. When the stored table is not today's, `rewrite` carries the record with today's table, and `history` (read
 * remapped) when the table is not a prefix of today's, which the sim writes before answering `loaded`; the page then
 * keeps that record, so a later `record` or backup never writes the old table back over today's ids.
 */
export function openRequest(db: string, world: WorldRecord, state: StateRecord, history: HistoryRecord): { load: SavedLoad; kept: WorldRecord } {
  const relation = tableRelation(world.stateTable);
  const kept = relation === 'equal' ? world : { ...world, stateTable: todayStateTable() };
  const rewrite = relation === 'equal' ? null : { world: kept, history: relation === 'other' ? history : null };
  return {
    load: { db, worldId: world.id, flushSeq: state.flushSeq, genKey: world.genKey, updated: state.updated, stateTable: world.stateTable, rewrite },
    kept,
  };
}

/** D8's notice at the open of a world from an older generator (SP5b spec §3.4 step 4), shown `OLDER_GENERATOR_NOTICE_MS`. */
export const OLDER_GENERATOR_NOTICE = 'This world was made with an earlier generator version; it opens with today\'s terrain and your blocks stay at their coordinates.';
export const OLDER_GENERATOR_NOTICE_MS = 8000;

/**
 * The record an older generator's open sends (SP5b spec §3.4 step 4, D8): null when `readyGenKey` (the first configure's
 * `ReadyMsg.genKey`, today's for the session's seed and params) equals the kept record's genKey; else the kept record
 * with today's genKey, `GENERATOR_VERSION` and the `paramsHash` of its params as `loadParams` reads them (the session's;
 * an opened world's params always load, and a refusal keeps the stored hash).
 */
export function olderGeneratorRecord(kept: WorldRecord, readyGenKey: string): WorldRecord | null {
  if (readyGenKey === kept.genKey) return null;
  const params = loadParams(kept);
  return { ...kept, genKey: readyGenKey, generatorVersion: GENERATOR_VERSION, paramsHash: params.ok ? hex64(paramsHash(params.value)) : kept.paramsHash };
}

/**
 * The record the page keeps after an Apply or adopt (SP5b spec §3.6; ruling P39): `kept` with the applied session's seed,
 * preset and params, their `paramsHash`, the applied draft's genKey (`readyGenKey`, its `ReadyMsg.genKey`) and today's
 * schema and generator version (the session's params are today's schema); its id, name, `created`, `stateTable` and
 * `backupOf` kept. The page sends it with `record`, and a later backup copies it.
 */
export function appliedRecord(kept: WorldRecord, s: SessionState, readyGenKey: string): WorldRecord {
  return {
    ...kept, seedText: s.seedText, seed: [s.seed[0], s.seed[1]], profile: s.profile, params: s.params as unknown as JsonObject,
    schemaVersion: SCHEMA_VERSION, paramsHash: hex64(paramsHash(s.params)), generatorVersion: GENERATOR_VERSION, genKey: readyGenKey,
  };
}

/**
 * A saved world's generator check once its diffs are loaded (SP5b spec §3.4 step 4, D8, D21): a stored genKey that is
 * not today's sends `olderGeneratorRecord`'s record to the sim, which writes it with the next flush, and the page keeps
 * that record from then on (§3.6), so a later `record` or backup copies today's genKey. Entries apply under any
 * generator: no copy, no dialog. `older` is what the reveal shows and saves (`revealOlderGenerator`).
 */
export function openOlderGenerator(o: { readonly kept: WorldRecord; readonly readyGenKey: string; readonly sim: Pick<SimClient, 'record'> }): { readonly older: boolean; readonly kept: WorldRecord } {
  const sent = olderGeneratorRecord(o.kept, o.readyGenKey);
  if (sent === null) return { older: false, kept: o.kept };
  o.sim.record(sent);
  return { older: true, kept: sent };
}

/**
 * At the reveal, an older generator's open (SP5b spec §3.4 step 4, D8; ruling P27): D8's notice for 8 s, and the
 * `record` it sent counted as a change, so the autosave's first tick posts the flush that writes it. Nothing otherwise.
 */
export function revealOlderGenerator(g: { readonly older: boolean }, o: { readonly notices: Pick<Notices, 'show'>; readonly autosave: Pick<Autosave, 'markChanged'> }): void {
  if (!g.older) return;
  o.notices.show(OLDER_GENERATOR_NOTICE, { kind: 'info', timeoutMs: OLDER_GENERATOR_NOTICE_MS });
  o.autosave.markChanged();
}

/** A saved world opened on the main thread: its connection, session, normalised records, notices, `load` and kept record. */
export interface SavedOpen {
  readonly kv: KV;
  readonly session: WorldSession;
  readonly state: StateRecord;
  readonly history: HistoryRecord;
  /** D14's notices for a `state` or `history` that could not be read. */
  readonly notices: readonly string[];
  readonly load: SavedLoad;
  /** The record later `record` messages and the backup are built from (§3.6). */
  readonly kept: WorldRecord;
  /** The world's lock (§3.5), held until the page releases it on `pagehide` or at its teardown. */
  readonly lock: WorldHold;
}

/** `navigator.locks`, or null where the Web Locks API is missing (an insecure context: no tab could hold a world). */
function navigatorLocks(): LockManagerLike | null {
  return (navigator as { locks?: LockManagerLike }).locks ?? null;
}

/**
 * The main thread's part of opening world `id` (SP5b spec §3.4 steps 1-3; rulings P5, P6, P22): first the world's lock
 * (`holdWorld`, D24: held by another tab past `LOCK_WAIT_MS` → the `locked` refusal, nothing read; no Web Locks at all →
 * `unreadable`, "Saving is not available in this browser window", as no tab could save), then the page's connection
 * (`open`; one that rejects or throws is that same reason), `readSavedWorld`, then the session from the record
 * (`openSavedSession`). A refusal after the lock (`readSavedWorld`'s, or the session's `initNotice`: tier 2 refused the
 * saved params and the session opened `default` with `{}`) is `unreadable` with that reason; it writes nothing, closes
 * the connection, releases the lock and carries no `load`, so no `record` with another world's genKey can follow and
 * the sim is never loaded without the lock. The page hands a refusal to `refuseOpen`. An opened world's session is not
 * writable: the world-modification mode is off whenever a world opens (§3.6, D10, D25).
 */
export async function openSavedWorld(o: {
  readonly locks: LockManagerLike | null;
  open(): Promise<KV>;
  readonly db: string;
  readonly id: string;
  readonly bounds: StateBounds;
  random(): Seed64;
}): Promise<{ ok: true; opened: SavedOpen } | { ok: false; refusal: OpenRefusal }> {
  const refuse = (reason: string) => ({ ok: false as const, refusal: { notice: 'unreadable' as const, reason } });
  if (o.locks === null) return refuse(STORAGE_UNAVAILABLE);
  const lock = await holdWorld(o.locks, o.id);
  if (lock === null) return { ok: false, refusal: { notice: 'locked' } };
  let kv: KV;
  try {
    kv = await o.open();
  } catch {
    lock.release();
    return refuse(STORAGE_UNAVAILABLE);
  }
  const read = await readSavedWorld(createSaves(kv), o.id, o.bounds);
  if (!read.ok) {
    kv.close();
    lock.release();
    return refuse(read.reason);
  }
  const session = openSavedSession(read.params, read.world, o.random);
  if (session.initNotice !== null) {
    kv.close();
    lock.release();
    return refuse(session.initNotice);
  }
  // The modification mode is off at every open (§3.6): no terrain change until the user switches it on.
  session.setWritable(false);
  const { load, kept } = openRequest(o.db, read.world, read.state, read.history);
  return { ok: true, opened: { kv, session, state: read.state, history: read.history, notices: read.notices, load, kept, lock } };
}

/**
 * A saved world's open as the enter bench records it (SP5b spec §6.2), ms: the page's connection to the database, the
 * `load`'s round trip (post → `loaded`) and the sim's decode, remap and `setColumn` inside it (`loaded.decodeMs`); each
 * null until measured, and all three null for an unsaved world.
 */
export interface EnterTimes {
  idbOpenMs: number | null;
  loadMs: number | null;
  decodeMs: number | null;
}

/** `window.__wiEnterResult` (SP5b spec §6.2): the page's `revealMs` (as the bench's) beside a saved open's times. */
export function enterResult(revealMs: number | null, t: Readonly<EnterTimes>): EnterResult {
  return { revealMs, idbOpenMs: t.idbOpenMs, loadMs: t.loadMs, decodeMs: t.decodeMs };
}

/** Where and how a saved world opens (SP5b spec §3.4 step 5): the page's start, from the world's `state` record. */
export interface RestoredStart {
  /** The load's centre, or null for the pool's spawn search. */
  centre: { x: number; z: number } | null;
  /** `firstView`'s query slot: the saved eye y, yaw and pitch, or nulls for its own choices. */
  view: { y: number | null; yaw: number | null; pitch: number | null };
  /** The FlyState's speed. */
  speed: number;
  /** The clock's t and day speed index. */
  t: number;
  speedIndex: number;
  /** True when the player was left walking: `switchMode` once after the reveal (`restoreMode`). */
  walk: boolean;
  /** False while a `?shot=1&time=` capture fixes the clock: the stored time is kept, not overwritten. */
  saveClock: boolean;
}

/**
 * A saved world's start (SP5b spec §3.4 step 5, D4): with `state.player`, its x, z the centre (no spawn search), its y,
 * yaw and pitch `firstView`'s query slot, its speed and mode; with `player: null` (a new world's first Play), the
 * spawn search, `firstView`'s own choices, `SPEED_DEFAULT` and flight. The clock is `state.time` unless `fixedT` (a
 * `?shot=1&time=` capture's) is not null, which wins and leaves the stored time unsaved. `q`'s `at`, `y`, `yaw` and
 * `pitch` are ignored beside `?world`: the saved pose wins.
 */
export function restoredStart(state: StateRecord, q: WorldQuery, fixedT: number | null): RestoredStart {
  const p = state.player;
  return {
    centre: p === null ? null : { x: p.x, z: p.z },
    view: p === null ? { y: null, yaw: null, pitch: null } : { y: p.y, yaw: p.yaw, pitch: p.pitch },
    speed: p === null ? SPEED_DEFAULT : p.speed,
    t: fixedT ?? state.time.t,
    speedIndex: state.time.speedIndex,
    walk: p !== null && p.mode === 'walk',
    saveClock: fixedT === null,
  };
}

/** After a saved world's reveal (SP5b spec §3.4 step 5): a player left walking walks again, through F's `switchMode`. */
export function restoreMode(start: Pick<RestoredStart, 'walk'>, switchMode: () => void): void {
  if (start.walk) switchMode();
}

/**
 * A saved world's URL rules (SP5b spec §3.4 step 7, D4), in place of `createWorldUrl`: no URL writer is created, so the
 * address stays `/?world=<id>` (an Apply, a view change and a teleport's arrival write nothing), and `here`, which the
 * failure panel's and the lost context's Reloads read, is `savedWorldUrl(id, rd)`.
 */
export function savedWorldUrlRules(id: string): WorldUrl {
  return { applied() {}, viewChanged() {}, arrived() {}, here: (rd) => savedWorldUrl(id, rd) };
}

/**
 * The loading failure's link to the next lower RD (P49), or null at RD 4 or before the RD is known: in a saved world
 * (`world`, its id) `savedWorldUrl(world, lower)` (SP5b spec §3.2; nothing to save before the reveal), else
 * `/?rd=<lower>[&at=<x>,<z>]<hash>`.
 */
export function lowerRdHref(rd: number | null, centre: { x: number; z: number } | null, hashPart: string, world: string | null): string | null {
  const lower = rd === null ? null : lowerRd(rd);
  if (lower === null) return null;
  if (world !== null) return savedWorldUrl(world, lower);
  return `/?rd=${lower}${centre === null ? '' : `&at=${centre.x},${centre.z}`}${hashPart}`;
}

/**
 * The reloader's `navigate` (SP5b spec §3.2, D31): in a saved world every navigation the page starts first waits for
 * `beforeLeave(LEAVE_WAIT_MS)` of the autosave `autosave()` returns, so the URL is set after that flush's `flushed` or
 * after 1,000 ms, whichever comes first; with none (an unsaved world) it navigates at once.
 */
export function leaveAfterSave(autosave: () => Pick<Autosave, 'beforeLeave'> | null, navigate: (url: string) => void): (url: string) => void {
  return (url) => {
    const a = autosave();
    if (a === null) navigate(url);
    else void a.beforeLeave(LEAVE_WAIT_MS).then(() => navigate(url));
  };
}

/**
 * A saved world's last flush after a failure (SP5b spec §3.2, D14; `stopAfterFailure`'s `save`): `flushNow()`, waited
 * for until its `flushed` or `LEAVE_WAIT_MS`, whichever comes first. When the sim is what failed nothing is posted.
 */
export function lastFlush(
  autosave: Pick<Autosave, 'flushNow'>,
  sim: { readonly failed: boolean },
  clock: { setTimeout(f: () => void, ms: number): number; clearTimeout(id: number): void },
): Promise<void> {
  if (sim.failed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const id = clock.setTimeout(resolve, LEAVE_WAIT_MS);
    const done = (): void => {
      clock.clearTimeout(id);
      resolve();
    };
    autosave.flushNow().then(done, done);
  });
}

/**
 * The edit path's `post`, counting its accepted replies (an `ok` outcome that edited something), the count autosave's
 * `editsSince` reads (SP5b spec §3.2). It returns the path's own promise, so the block history's `record`, chained on
 * it, runs where it did.
 */
export function countAccepted(post: EditPath['post']): { post: EditPath['post']; count(): number } {
  let n = 0;
  const counted = (out: EditOutcome): void => {
    if (out.ok && out.next.length > 0) n++;
  };
  return {
    post(edits, tClick) {
      const p = post(edits, tClick);
      void p.then(counted, () => {});
      return p;
    },
    count: () => n,
  };
}

/** A world with no places: the bench's (SP5b spec §6.2). */
const NO_PLACES: readonly Place[] = [];

/**
 * A saved world's hotbar storage (SP5b spec §3.4 step 6, D4): the slice of `Storage` that `createHotbar` reads and
 * writes, over the world's hotbar record instead of `localStorage` (an unsaved world keeps SP5a's, D29).
 * `getItem(HOTBAR_KEY)` is `get()`'s record as JSON; `setItem(HOTBAR_KEY, json)` hands `set` the parsed record, which
 * the autosave's next build saves in the `state` record. Any other key is not the world's: null, and nothing kept.
 */
export function hotbarStorage(get: () => HotbarRecord, set: (h: HotbarRecord) => void): Pick<Storage, 'getItem' | 'setItem'> {
  return {
    getItem: (key) => (key === HOTBAR_KEY ? JSON.stringify(get()) : null),
    setItem(key, value) {
      if (key === HOTBAR_KEY) set(JSON.parse(value) as HotbarRecord);
    },
  };
}

/** A block-history step as the `history` record holds it. */
const stepRecord = (step: BlockStep): HistoryRecord['done'][number] => ({ edits: [...step.edits] });

/** The page's autosave, and the state and whole history it would post now: the backup's (SP5b spec §3.6, D26). */
export interface PageAutosave extends Autosave {
  /** The state record (the state parts' `record()`, `updated` now) and the block history as a whole record. */
  build(): { readonly state: StateRecord; readonly history: HistoryRecord };
}

/**
 * A saved world's autosave as the page creates it after the reveal (SP5b spec §3.2, D5): `flush` the sim client's;
 * the state's parts (`createStateParts`) over the pose (`fly`), the clock (`frame.t`, which the frame step writes, and
 * the day speed's index; `storedTime` unchanged while a `?shot=1&time=` capture fixes the clock, which is then not
 * saved), the world's hotbar record (`hotbarStorage`'s), the places (`Places.list`, a new list at every change, compared
 * by identity; none when not given) and the wall clock (`now`); the block history's
 * version and its sides as a record (§3.4 step 6), one record object per step for as long as the step lives, so the
 * sim client posts only what changed since the last history (D28's third lever); `settled` the edit path's;
 * `editsSince` the accepted replies (`countAccepted`); `onResult` every `flushed`; `onBuild`, when given, as each
 * post's work starts (the bench's clock of a flush's main-thread work, SP5b spec §6.2). `build` gives the backup the
 * same state parts' record and history the next post would carry.
 */
export function createPageAutosave(o: {
  readonly worldId: string;
  readonly fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'mode' | 'speed'>;
  readonly frame: { readonly t: number };
  speedIndex(): number;
  /** The stored time while a capture fixes the clock (`RestoredStart.saveClock` false); null when the clock is saved. */
  readonly storedTime: { readonly t: number; readonly speedIndex: number } | null;
  /** The world's hotbar record, `{ v: 1, active, slots }` (the `get` of the hotbar's `hotbarStorage`). */
  hotbar(): HotbarRecord;
  /** The world's places (SP5b spec §3.7); the bench has none. */
  places?(): readonly Place[];
  readonly blockHistory: Pick<BlockHistory, 'snapshot' | 'version'>;
  readonly sim: Pick<SimClient, 'flush'>;
  settled(): Promise<void>;
  editsSince(): number;
  /** The wall clock (`Date.now()`), the state's `updated`. */
  now(): number;
  readonly clock: AutosaveDeps['clock'];
  readonly events: AutosaveDeps['events'];
  onResult(r: FlushedMsg): void;
  onBuild?(): void;
}): PageAutosave {
  const records = new WeakMap<BlockStep, HistoryRecord['done'][number]>();
  const recordOf = (step: BlockStep): HistoryRecord['done'][number] => {
    let r = records.get(step);
    if (r === undefined) records.set(step, (r = stepRecord(step)));
    return r;
  };
  const { storedTime } = o;
  const state = createStateParts({
    worldId: o.worldId,
    fly: o.fly,
    t: () => (storedTime !== null ? storedTime.t : o.frame.t),
    speedIndex: () => (storedTime !== null ? storedTime.speedIndex : o.speedIndex()),
    hotbar: () => o.hotbar(),
    places: () => o.places?.() ?? NO_PLACES,
    now: () => o.now(),
  });
  const history = (): HistoryRecord => {
    const steps = o.blockHistory.snapshot();
    return { worldId: o.worldId, done: steps.done.map(recordOf), undone: steps.undone.map(recordOf) };
  };
  const autosave = createAutosave({
    clock: o.clock,
    events: o.events,
    flush: (st, h) => o.sim.flush(st, h),
    state,
    historyVersion: () => o.blockHistory.version,
    history,
    settled: () => o.settled(),
    editsSince: () => o.editsSince(),
    onResult: (r) => o.onResult(r),
    onBuild: o.onBuild,
  });
  return { ...autosave, build: () => ({ state: state.record(), history: history() }) };
}

/** The benches' database (SP5b spec §6.2; `bench.ts`): the bench route's saved world lives there, never in `SAVES_DB`. */
export { BENCH_DB };

/**
 * A `worlds` record of the session's seed and parameters (§2.1), as a new world's: today's schema, generator, genKey
 * and state table, `created` the given wall-clock time, no backup.
 */
export function newWorldRecord(id: string, name: string, s: Pick<SessionState, 'seedText' | 'seed' | 'profile' | 'params'>, created: number): WorldRecord {
  return {
    id, name, seedText: s.seedText, seed: [s.seed[0], s.seed[1]], profile: s.profile, params: s.params as unknown as JsonObject,
    schemaVersion: SCHEMA_VERSION, paramsHash: hex64(paramsHash(s.params)), generatorVersion: GENERATOR_VERSION,
    genKey: hex64(genKey(s.seed, stageHashes(s.params))), stateTable: todayStateTable(), created, backupOf: null,
  };
}

/**
 * The bench route's saved world at its start (SP5b spec §6.2): `BENCH_DB` deleted (no connection to it is open yet),
 * opened, and a world of the route's seed and parameters created in it (`worlds` and `state`, one write, as the menu's
 * Create); the page keeps the connection, and its `load` is an empty world's. A write that does not complete throws.
 */
export async function openBenchSave(o: {
  open(db: string): Promise<KV>;
  deleteDb(db: string): Promise<void>;
  readonly id: string;
  readonly session: Pick<SessionState, 'seedText' | 'seed' | 'profile' | 'params'>;
  /** The wall clock (`Date.now()`), the record's `created`. */
  readonly now: number;
}): Promise<{ kv: KV; world: WorldRecord; load: SavedLoad }> {
  await o.deleteDb(BENCH_DB);
  const kv = await o.open(BENCH_DB);
  const world = newWorldRecord(o.id, 'Bench', o.session, o.now);
  const state = newState(o.id, STATE_BOUNDS);
  const w = await createSaves(kv).create(world, state);
  if (w.status !== 'complete') {
    kv.close();
    throw new Error(`the bench's world could not be created in ${BENCH_DB}: ${w.status} (${w.errorName ?? 'no error name'})`);
  }
  return { kv, world, load: openRequest(BENCH_DB, world, state, { worldId: o.id, done: [], undone: [] }).load };
}

/**
 * The bench route's saved world at its end (SP5b spec §6.2): every connection to `BENCH_DB` closed, then the database
 * deleted: the sim's by disposing its client (the worker terminated, its connection with it; IdbKV's self-close on
 * `versionchange` is the backstop), then the page's (`kv.close()`), then `deleteDb`.
 */
export function closeBenchSave(o: { readonly sim: Pick<SimClient, 'dispose'> | null; readonly kv: Pick<KV, 'close'>; deleteDb(db: string): Promise<void> }): Promise<void> {
  o.sim?.dispose();
  o.kv.close();
  return o.deleteDb(BENCH_DB);
}

/** The bench's autosave listens to no page event: the bench's tab stays in front, and only its parts decide (§6.2). */
const NO_PAGE_EVENTS: AutosaveDeps['events'] = { on: () => () => {}, hidden: () => false };

/**
 * L11's saving as the bench route composes it (SP5b spec §6.2; ruling P11): a block history over the bench's edit path
 * and the action post that records into it (the post L11's edits take; L1-L10 keep the path's own post, so their cells
 * stay comparable), and the page's autosave (`createPageAutosave`) over the bench's world, created paused, its build the
 * pose, the clock, the default hotbar, no places and the history; every flush it posts is logged through `flushed` on
 * `now`'s clock, its `mainMs` from the build's start to the post's return. `hooks` are the driver's `BenchWorld.save`.
 */
export function createBenchSave(o: {
  readonly worldId: string;
  readonly fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'mode' | 'speed'>;
  readonly frame: { readonly t: number };
  readonly edits: Pick<EditPath, 'post' | 'pending' | 'settled'>;
  read(x: number, y: number, z: number): number;
  readonly sim: Pick<SimClient, 'flush'>;
  readonly clock: AutosaveDeps['clock'];
  /** The page's clock, ms (`performance.now()`): the flushes' and the edits' times. */
  now(): number;
  /** The wall clock (`Date.now()`), the state's `updated`. */
  wallNow(): number;
  filled(): boolean;
  samples(): number;
  flushed(f: BenchFlush): void;
}): { readonly autosave: Autosave; readonly blockHistory: BlockHistory; readonly hooks: NonNullable<BenchWorld['save']> } {
  const accepted = countAccepted(o.edits.post);
  const blockHistory = createBlockHistory({
    post: accepted.post,
    read: (x, y, z) => o.read(x, y, z),
    pending: o.edits.pending,
    settled: o.edits.settled,
    notices: { show() {} },
  });
  const actionPost = createActionPost({ post: accepted.post, record: blockHistory.record });
  const hotbar = STATE_BOUNDS.normalizeHotbar(null);
  const buildStart = new Float64Array(1);
  const autosave = createPageAutosave({
    worldId: o.worldId,
    fly: o.fly,
    frame: o.frame,
    speedIndex: () => 0,
    storedTime: null,
    hotbar: () => hotbar,
    blockHistory,
    sim: {
      flush(state, history) {
        const p = o.sim.flush(state, history);
        const tPost = o.now();
        const mainMs = tPost - buildStart[0]!;
        p.then((r) => o.flushed({
          tPost, tDone: o.now(), ok: r.ok, syncMs: r.ok ? r.syncMs : Number.NaN, commitMs: r.ok ? r.commitMs : Number.NaN, mainMs,
        }), () => {});
        return p;
      },
    },
    settled: o.edits.settled,
    editsSince: accepted.count,
    now: () => o.wallNow(),
    clock: o.clock,
    events: NO_PAGE_EVENTS,
    onResult: () => {},
    onBuild: () => { buildStart[0] = o.now(); },
  });
  autosave.pause(true);
  return {
    autosave,
    blockHistory,
    hooks: {
      post: (edits) => actionPost(edits),
      pause: (on) => autosave.pause(on),
      flushNow: () => autosave.flushNow(),
      filled: () => o.filled(),
      now: () => o.now(),
      samples: () => o.samples(),
    },
  };
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
      // In a saved world the lower RD reopens it (SP5b spec §3.2).
      show: () => loading.fail(cause, shown, { map: mapHref, lowerRd: lowerRdHref(rd, centre, hashPart, q.world) }),
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
    // 1. The world: a saved world's lock, then its records (SP5b spec §3.4 steps 1-2), else the hash (P47). A refusal
    // (the lock held by another tab included) or a decode error loads nothing (ruling P5): the sim is created only after.
    let saved: SavedOpen | null = null;
    // A saved world's lock on this page (§3.5): released on `pagehide` after the autosave's last save, or at the teardown.
    let worldLock: WorldLockOnPage | null = null;
    let decoded: MapState | null = null;
    // A `?shot=1&time=` capture's fixed clock (ruling P48), in a saved world too, where the clock is then not saved.
    const fixedT = opts.timeHours === undefined || opts.timeHours === null ? null : timeOfHours(opts.timeHours);
    // A saved world's pose, mode, flying speed and time (SP5b spec §3.4 step 5, D4); null for an unsaved world.
    let restored: RestoredStart | null = null;
    // The enter bench's times (SP5b spec §6.2), recorded for every load and published only under `?enterBench=1`.
    const enterTimes: EnterTimes = { idbOpenMs: null, loadMs: null, decodeMs: null };
    if (q.world !== null) {
      // The enter bench's saved world lives in its own database (`q.db`, only with `enterBench=1`).
      const db = q.db ?? SAVES_DB;
      const open = async (): Promise<KV> => {
        const t = performance.now();
        const kv = await openIdbKV(db, undefined, () => loading.warn(BLOCKED_NOTICE));
        enterTimes.idbOpenMs = performance.now() - t;
        return kv;
      };
      const r = await openSavedWorld({ open, db, id: q.world, bounds: STATE_BOUNDS, random: cryptoSeed, locks: navigatorLocks() });
      if (state !== 'loading') {
        if (r.ok) {
          r.opened.kv.close();
          r.opened.lock.release();
        }
        return;
      }
      // Held by another tab or unreadable: back to the worlds menu with the notice (§3.4 steps 1-2; D7, D14).
      if (!r.ok) {
        refuseOpen(r.refusal, {
          enterBench: q.enterBench,
          storage: sessionStorageOrNull(),
          leave: (url) => {
            state = 'failed';
            settle();
            location.replace(url);
          },
          fail: (text) => fail(text, null),
        });
        return;
      }
      saved = r.opened;
      // Pushed first, so the reversed teardown releases the lock last, after the sim and the connection are gone.
      const lock = installWorldLock(window, saved.lock, () => location.reload());
      worldLock = lock;
      teardown.push(() => lock.dispose());
      const kv = saved.kv;
      teardown.push(() => kv.close());
      // The saved pose replaces `?at` (D4): its x, z the centre, or the spawn search for a new world's first Play.
      restored = restoredStart(saved.state, q, fixedT);
      centre = restored.centre;
    } else {
      const d = decodeMapState(hash);
      if (d.error !== null) {
        fail(d.error, null);
        return;
      }
      decoded = d.state;
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
    const session = saved !== null ? saved.session : openMapSession(decoded!, cryptoSeed);
    seedText = session.state.seedText;
    profile = session.state.profile;
    if (session.initNotice !== null) loading.warn(session.initNotice);
    const storage = storageOrNull();
    // The flight and bench routes measure with the defaults, never a user's stored cap or FOV (spec §9.5; SP4b spec §8.3).
    let settings: WorldSettings = opts.flight === undefined && opts.bench === undefined ? loadSettings(storage) : { ...SETTINGS_DEFAULTS };
    const loadRd = resolveRenderDistance(caps, q.rd, settings.rd);
    rd = loadRd;
    // The largest RD the store's fixed maxima allow (SP4b spec §5): the coordinator's and the Settings screen's cap,
    // and the help's System row.
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
    // The bench's saved world (SP5b spec §6.2): `BENCH_DB` deleted and the route's world created in it before the sim
    // attaches, so its `load` (an empty world) goes with the attach, as a saved world's; the page keeps its connection
    // until the script's end.
    let benchSave: { readonly kv: KV; readonly world: WorldRecord; readonly load: SavedLoad } | null = null;
    if (opts.bench !== undefined && simClient !== null) {
      benchSave = await openBenchSave({ open: (db) => openIdbKV(db), deleteDb: deleteIdb, id: crypto.randomUUID(), session: session.state, now: Date.now() });
      const kv = benchSave.kv;
      teardown.push(() => kv.close());
      if (state !== 'loading') return;
    }
    const attaching = simClient?.attach(store.handles());
    // A saved world's `load` round trip and the sim's decode in it, for the enter bench (SP5b spec §6.2).
    const timedLoad = (client: SimClient, m: SavedLoad): Promise<LoadedMsg> => {
      const posted = performance.now();
      return client.load(m).then((loaded) => {
        enterTimes.loadMs = performance.now() - posted;
        enterTimes.decodeMs = loaded.decodeMs;
        return loaded;
      });
    };
    // A saved world's diffs (SP5b spec §3.4 step 3), and the bench's: `load` is posted right after the attach and
    // awaited with it, so the read-through sees every saved edit from the first D; a sim that fails meanwhile leaves the
    // world without editing.
    const savedLoad = simClient === null ? null
      : saved !== null ? timedLoad(simClient, saved.load)
        : benchSave !== null ? simClient.load(benchSave.load) : null;
    // D14's notices and the load's counts, shown once the world's notices exist.
    const savedNotices: string[] = saved === null ? [] : [...saved.notices];
    const simAttached = attaching === undefined ? undefined : Promise.all([attaching, savedLoad]).then(([, loaded]) => {
      if (loaded === null) return;
      if (loaded.skippedColumns > 0) savedNotices.push(`${loaded.skippedColumns} columns of this world could not be read`);
      if (loaded.unknownStates > 0) savedNotices.push(`${loaded.unknownStates} blocks of unknown types became air`);
    }, (e: unknown) => {
      if (!(e instanceof SimFailed)) throw e;
    });
    // G2's edit latency (§6.2): staged through the coordinator's `onEditStaged`, revealed through the route's hook.
    const latency = simClient === null ? null : createEditLatency();
    // The first configure's ReadyMsg is kept: the preview driver adopts it at the reveal (SP4c spec §4.2).
    const firstReady = await workers.configure(session.state.seedText, session.state.params);
    await simAttached;
    if (state !== 'loading') return;
    // A saved world from an older generator (SP5b spec §3.4 step 4, D8): its record with today's genKey goes to the sim
    // now that its diffs are loaded (the sim refuses a `record` before `loaded`; a failed sim's client sends nothing), and
    // `generator.kept` is the record the page keeps from here (§3.6); the notice and the change wait for the reveal.
    const generator = saved === null ? null : openOlderGenerator({ kept: saved.kept, readyGenKey: firstReady.genKey, sim: simClient! });

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
    pushCoordinatorTeardown(teardown, coordinator, simClient, store);
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
    // A saved world's pose enters the query slot in place of `?y`, `?yaw` and `?pitch` (SP5b spec §3.4 step 5, D4).
    const given = restored === null ? { y: q.y, yaw: q.yaw, pitch: q.pitch } : restored.view;
    const view = firstView((x, z) => motionBlockingAt(store, x, z), at.x, at.z, given, eyeAbove);
    // An unsaved world opens in flight (SP5a spec D1; F switches); a saved one at its flying speed, walking again after
    // the reveal when it was left walking (`restoreMode`, SP5b spec §3.4 step 5).
    const fly: FlyState = { x: at.x, y: clamp(view.y, Y_MIN, Y_MAX), z: at.z, yaw: view.yaw, pitch: view.pitch, vx: 0, vy: 0, vz: 0, speed: restored?.speed ?? SPEED_DEFAULT, mode: 'fly' };
    const walk = createWalkState();
    // Wraps the yaw into [0, 360) and clamps the pitch; a query's valid degrees pass unchanged (ruling P42).
    look(fly, 0, 0, 0);
    let t = restored === null ? fixedT ?? OPENING_T : restored.t;
    let speedIndex = restored === null ? 0 : restored.speedIndex;
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
    if (q.enterBench) window.__wiEnterResult = enterResult(stats.revealMs, enterTimes);
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
      // The live legs' teleport and preview driver (SP4c spec §8.4), and L11's autosave (SP5b spec §6.2), created below.
      let benchTeleport: Teleport | null = null;
      let benchDriver: PreviewDriver | null = null;
      let benchAutosave: Autosave | null = null;
      // The bench's saved world (opened above): at the end, or at a failure, every connection is closed and
      // `BENCH_DB` deleted (`closeBenchSave`: the sim's dispose, the page's close, the deletion).
      const benchKv = benchSave!.kv;
      const closeBench = (): void => {
        closeBenchSave({ sim: simClient, kv: benchKv, deleteDb: deleteIdb }).catch((e: unknown) => console.error(`The bench could not delete ${BENCH_DB}:`, e));
      };
      // A failure after the reveal ends the script with the error, so measureChrome stops at once; the teleport (before
      // the pool: a landing in flight settles silently, ruling R5), the driver, the coordinator, the workers and the
      // renderer are released as on the streaming route, the autosave before the sim, whose dispose closes the bench's
      // saved world.
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
            () => benchAutosave?.dispose(),
            closeBench,
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
        // L11's saving (SP5b spec §6.2; ruling P11): the block history and the action post L11's edits take, and the
        // autosave over the bench's saved world, paused until L11b; the driver gets every flush it posts.
        const benchSaving = createBenchSave({
          worldId: benchSave!.world.id,
          fly,
          frame,
          edits: benchEdits,
          read: (x, y, z) => voxelValue(store, x, y, z),
          sim: simClient!,
          clock: {
            now: () => performance.now(),
            setInterval: (f, ms) => window.setInterval(f, ms),
            clearInterval: (id) => window.clearInterval(id),
            setTimeout: (f, ms) => window.setTimeout(f, ms),
            clearTimeout: (id) => window.clearTimeout(id),
          },
          now: () => performance.now(),
          wallNow: () => Date.now(),
          filled: () => filledRadius(Math.floor(fly.x) >> 4, Math.floor(fly.z) >> 4, refillRd, isRevealed) === refillRd,
          samples: () => editLatency.count,
          flushed: (f) => bench.flushed(f),
        });
        benchAutosave = benchSaving.autosave;
        teardown.push(() => benchSaving.autosave.dispose());
        // The bench's day speed, which a review scene sets to 0 with its fixed hour (SP5a spec §6.5).
        const benchClock = { speed: BENCH_TIME_SPEED };
        // The script's RD steps never exceed the reservation's cap (Task 26b); the review shots' camera reads the ground's
        // height under the frozen pose (rulings R9); the live legs edit, undo and teleport through the pieces above; the
        // review scenes build through the edit path, fix the clock and walk through F's path (no hold repeat here).
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
            read: (x, y, z) => voxelValue(store, x, y, z),
          },
          save: benchSaving.hooks,
          setTime: (hours) => benchSetTime(frame, benchClock, hours),
          walk: (on) => benchWalk({ fly, walk, world, repeat: NO_REPEAT }, on),
        });
        // The live RD as the Settings screen would set it, never saved (SP4b spec §5).
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
          panel: { setRd() {} },
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
          walk,
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
          timeSpeed: () => benchClock.speed,
          fogStep: (dtMs) => fogStep.step(dtMs),
          // The apply control before the coordinator's update; the aux policy from its counts, no map covering the 3D
          // (SP4c spec §4.3, §6.2, §8.4).
          beforeUpdate: () => applyControl.tick(),
          afterCounts: (c) => updateAuxPolicy(workers, applyControl.generation, false, c),
          // The frame's input, walk step and aim on the bench's clock, into the row the recorder takes next (`playerMs`:
          // L10's `mainP95Ms`, SP5a spec §6.2).
          timing: {
            now: () => performance.now(),
            record: (ms) => {
              if (bench.record.n < bench.record.capacity) bench.record.playerMs[bench.record.n] = ms;
            },
          },
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
              // The script ended: nothing saves any more, and the bench's saved world is closed and deleted.
              benchSaving.autosave.dispose();
              closeBench();
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

    // Every navigation the page starts disarms the Ctrl+W guard first and happens once (spec §7.1; ruling P50); in a
    // saved world it saves first (`leaveAfterSave`: the URL is set after `flushed` or 1,000 ms, SP5b spec §3.2).
    const disarm = installLeaveGuard(window);
    teardown.push(disarm);
    // A saved world's autosave (SP5b spec §3.2, D5), created below once the pose, the hotbar and the edit path exist.
    let autosave: PageAutosave | null = null;
    const reloader = createReloader(leaveAfterSave(() => autosave, (url) => navigateTo(url, location)), disarm);
    const notices = createWorldNotices(host, reloader);
    teardown.push(() => notices.dispose());
    // A saved world's D14 notices and its load's counts (SP5b spec §3.4 steps 2-3), until dismissed.
    for (const text of savedNotices) notices.show(text, { kind: 'warn' });
    // An unsaved world's notice (SP5b's Point 2, or the menu's in-place one), until dismissed.
    const unsaved = unsavedNoticeOf(q, opts);
    if (unsaved !== null) notices.show(unsaved, { kind: 'warn' });
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
    simFailure = () => onSimFailure({ store, coordinator, editPath, notices, saved: saved !== null });
    // The edit path's accepted replies, counted for the autosave (SP5b spec §3.2); every post below goes through it.
    const accepted = countAccepted(editPath.post);
    // The block history (SP5a spec §4.5, D13): every action posts through `actionPost`, which records an accepted one;
    // a side with no entry takes the voxel's value read now as its `expect`.
    const blockHistory = createBlockHistory({
      post: accepted.post,
      read: (x, y, z) => voxelValue(store, x, y, z),
      pending: editPath.pending,
      settled: editPath.settled,
      notices: { show: (text, ms) => notices.show(text, { timeoutMs: ms }) },
    });
    // A saved world's steps as saved, remapped to today's ids (SP5b spec §3.4 step 6, D6).
    if (saved !== null) blockHistory.restore(saved.history.done, saved.history.undone);
    const actionPost = createActionPost({ post: accepted.post, record: blockHistory.record });
    // A sim that failed during the load shows its notice now that the notices exist.
    if (simClient!.failed) simFailure();
    // The edit latency's reveals (§6.2); the bench's own hook feeds them on its route (L10).
    sections.onColumnRevealed = (cx, cz) => editLatency.revealed(cx, cz, performance.now());
    teardown.push(() => { sections.onColumnRevealed = null; });
    // The map overlay and the preview driver (SP4c spec §1.3, §4.2), created below; a failure or a context loss
    // disposes the overlay (and its tool) before the panel or the notice shows (D27), and closes the palette, B's
    // place dialog and the Settings screen, mounted below, which would cover them (final review UI-2; SP5b spec §3.7,
    // §1.4).
    let mapRef: MapOverlay | null = null;
    let paletteRef: Palette | null = null;
    let placeDialogRef: PlaceDialog | null = null;
    let settingsRef: SettingsPanel | null = null;
    let driver: PreviewDriver | null = null;
    // The teleport, created below; a failure after the reveal disposes it before the pool is terminated (ruling R5).
    let teleport: Teleport | null = null;
    // The world's URL (SP4c spec §1.6, D20): after every Apply and every view change of the map, the path, the search
    // and the live session's hash, debounced 200 ms, a hash over 64 KiB dropped with the notice; a teleport's arrival
    // rewrites the search's place. Disposed (a pending write flushed) before the notices. No `hashchange` listener. In a
    // saved world no writer is created: the address stays `/?world=<id>` (SP5b spec §3.4 step 7, D4).
    let worldUrl: WorldUrl;
    if (q.world === null) {
      const urlWriter = createUrlWriter((u) => history.replaceState(null, '', u), 200, 1000, oversizeNotice(notices));
      teardown.push(() => urlWriter.dispose());
      teardown.push(flushOnPageHide(window, urlWriter));
      worldUrl = createWorldUrl({
        session,
        view: () => worldMapView(mapRef?.tool ?? null, fly),
        camera: fly,
        writer: urlWriter,
        loc: location,
      });
    } else {
      worldUrl = savedWorldUrlRules(q.world);
    }
    // The Reloads read the camera, the live session and the map's view now, never the hash the page was loaded with; in
    // a saved world they reopen `/?world=<id>[&rd=<rd>]` (`savedWorldUrl`).
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
    // released, and the notices' panel offers "Copy details" and a Reload around the camera. A saved world saves once
    // more first, unless the sim is what failed, and the panel and the releases wait for it (SP5b spec §3.2, D14).
    let stopHud = (): void => {};
    failAfterReveal = (cause, shown) => {
      const renderer = wr;
      wr = null;
      const saving = autosave;
      stopAfterFailure({
        stop,
        closeMap: () => closeOverlays(paletteRef, mapRef, placeDialogRef, settingsRef),
        save: saving === null ? undefined : () => lastFlush(saving, simClient!, window),
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
          // After its last flush, before the sim: nothing posts again (the panel's Reload leaves at once).
          () => saving?.dispose(),
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
      closeMap: () => closeOverlays(paletteRef, mapRef, placeDialogRef, settingsRef),
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
    // A saved world's kept record and applied snapshot (SP5b spec §3.6): the open's (the older-generator open's record,
    // Task 23), then each Apply's or adopt's; the backup copies the record, and a failed copy loads the snapshot back.
    let kept = generator?.kept ?? null;
    let appliedSnapshot = session.snapshot;
    // The world-modification mode, created with the overlay below; its `beforeApply` holds a terrain change for its copy.
    let modifyRef: ModifyMode | null = null;
    const applyControl = createApplyControl({
      coordinator,
      driver: previewDriver,
      session,
      pool: workers,
      clock: { now: () => performance.now() },
      epochs,
      initial: appliedDraftOf(draftOf(session.state).seedKey, firstReady),
      initialGeneration: workers.epoch,
      // An unsaved world always proceeds; a saved world's mode holds a terrain change while its backup copy is written
      // (SP5b spec §3.6, D26).
      beforeApply: (from) => modifyRef === null || modifyRef.beforeApply(from),
      onApplied: ({ from }) => {
        // A saved world's record follows the applied draft, written by the next flush (SP5b spec §3.6, §3.2).
        if (kept !== null) {
          kept = appliedRecord(kept, session.state, applyControl.applied.genKey);
          appliedSnapshot = session.snapshot;
          simClient!.record(kept);
          autosave?.markChanged();
        }
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
          mode: fly.mode,
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
          // G2's live reading once there is an edit (SP5a spec §4.6): click to the frame the new mesh is shown.
          edit: editLatency.count > 0 ? { p95: editLatency.visibleP95(), count: editLatency.count } : null,
        };
      })
      : null;
    if (huds !== null) {
      teardown.push(() => huds.dispose());
      stopHud = () => huds.dispose();
    }
    // The hotbar (SP5a spec §4.3) and its HUD: the crosshair, the bar and the slot's name. A saved world's is its `state`
    // record's, which the autosave saves (SP5b spec §3.4 step 6); an unsaved world's is remembered in this browser (D29).
    let worldHotbar: HotbarRecord = saved !== null ? saved.state.hotbar : STATE_BOUNDS.normalizeHotbar(null);
    const hotbar = createHotbar(saved !== null ? hotbarStorage(() => worldHotbar, (h) => { worldHotbar = h; }) : storage);
    const buildHud = mountBuildHud(host, { hotbar, hud, locked: () => document.pointerLockElement === canvas });
    teardown.push(() => buildHud.dispose());

    // Every setting applies live (SP4b spec §5); an rd change goes through the RD control, which saves it. The Settings
    // screen shows the RD in force, the URL's on a `?rd=` load, not the saved one (rulings R8).
    let shownRd = rdShownOnLoad(q.rd, loadRd, settings.rd);
    const applySettings = (s: WorldSettings): void => {
      const change = settingsChange(settings, s, shownRd);
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
    // The Settings screen (SP5b spec §1.4, D9): G or the help's "Settings (G)" opens it; it pauses the world.
    const settingsPanel: SettingsPanel = mountSettingsPanel(host, {
      settings: { ...settings, rd: shownRd },
      onSettings: applySettings,
      rdMax,
      defaultRd: defaultRenderDistance(caps),
      onClose: () => {},
    });
    settingsRef = settingsPanel;
    teardown.push(() => settingsPanel.dispose());
    const help: Help = mountHelp(host, {
      map: DEFAULT_KEYMAP,
      report: caps,
      evaluation,
      rdMax,
      // "Map (M)" closes the help and opens the overlay (SP4c spec §1.6, D20); nothing navigates.
      openMap: () => mapRef?.open(),
      // "Settings (G)" closes the help and opens the Settings screen (SP5b spec §1.4).
      openSettings: () => settingsPanel.open(),
      // "Worlds menu" (SP5b spec D31): a saved world saves first (`beforeLeave`, at most 1 s), then `/` opens.
      worldsMenu: () => reloader.reload('/'),
      onFullscreen: () => {
        // Keyboard Lock is Chromium's and not in the DOM typings.
        void enterFullscreen(document, navigator as Navigator & KeyboardLockNavigator);
      },
      onClose: () => {},
    });
    // Closing removes the help's Esc listener from the document.
    teardown.push(() => help.close());
    const requestLock = (): void => {
      try {
        // Chromium returns a promise that rejects when the lock is refused; others return nothing.
        const r: unknown = canvas.requestPointerLock();
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        // A refused lock leaves the pointer free; a click on the canvas takes it.
      }
    };
    // The creative palette (SP5a spec §4.4, D10): E opens it; its own E requests the lock back, a click around its panel too.
    const palette: Palette = mountPalette(host, { hotbar, requestLock, onClose: () => {} });
    paletteRef = palette;
    teardown.push(() => palette.dispose());
    // Saved places (SP5b spec §3.7, D12): a saved world's, from its `state` record, kept by the autosave (below); B's
    // dialog, whose Save and Esc request the lock back. An unsaved world has none (D29).
    const places = saved !== null ? createPlaces(saved.state.places, () => crypto.randomUUID()) : null;
    const placeDialog = mountPlaceDialog(host, { requestLock, onClose: () => {} });
    placeDialogRef = placeDialog;
    teardown.push(() => placeDialog.dispose());
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
      panel: {
        setRd(r) {
          shownRd = r;
          settingsPanel.setRd(r);
        },
      },
      save: (r) => {
        settings = { ...settings, rd: r };
        saveSettings(storage, settings);
      },
      defaultRd: resolveRenderDistance(caps, null, null),
    });

    // The help and the Settings screen as one panel for M (`mapKey`): the map never opens over either.
    const panels = {
      get isOpen(): boolean {
        return help.isOpen || settingsPanel.isOpen;
      },
      close(): void {
        help.close();
        settingsPanel.close();
      },
    };
    const onAction = (a: Action): void => {
      switch (a) {
        // Walking, + and - do nothing (SP5a spec §3.3).
        case 'speedUp': speedKey(fly, 1); break;
        case 'speedDown': speedKey(fly, -1); break;
        case 'timeSpeed': if (fixedT === null) speedIndex = (speedIndex + 1) % TIME_SPEEDS.length; break;
        case 'hud': huds?.toggle(); break;
        // H and M close the palette first (SP5a spec §4.4); the help and the Settings screen are never open together.
        case 'help':
          paletteFirst(palette, () => {
            if (help.isOpen) help.close();
            else {
              settingsPanel.close();
              document.exitPointerLock();
              help.open();
            }
          });
          break;
        // M opens or closes the map overlay (SP4c spec §2.4); it acts whoever owns the controls.
        case 'map': paletteFirst(palette, () => mapKey(panels, mapRef)); break;
        // B saves a place, through the palette's close; never over the help, the Settings screen or its own dialog
        // (SP5b spec §3.7, D12).
        case 'savePlace':
          savePlaceKey({
            palette, help, settings: settingsPanel, dialog: placeDialog, places, camera: fly,
            notices: { show: (text, ms) => notices.show(text, { timeoutMs: ms }) },
          });
          break;
        // G opens or closes the Settings screen, through the palette's close (SP5b spec §1.4, D9).
        case 'settings':
          settingsKey({ palette, help, dialog: placeDialog, panel: settingsPanel, releasePointer: () => document.exitPointerLock() });
          break;
        // E opens the palette, never over the help or the Settings screen; while it is open its own E listener closes
        // it (SP5a spec §4.4).
        case 'palette':
          if (!palette.isOpen) {
            if (help.isOpen) help.close();
            settingsPanel.close();
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
        // F switches flight and walking and the near plane; a mode switch ends a held button's repeat (SP5a spec §3.1,
        // §4.1).
        case 'toggleWalk': switchMode({ fly, walk, world, repeat: holdRepeat }); break;
        default: break; // movement and sprint are held; Esc (releasePointer) is the browser's
      }
    };
    // A mouse button only queues its action; the frame's aim runs it (SP5a spec §4.1). A refusal does nothing; an
    // accepted click is one block-history step (§4.5).
    const clicks = createClickQueue({
      post: (edit, t) => { void actionPost([edit], t); },
      hotbar,
      fly,
      walk,
      editable: (cx, cz) => coordinator.editState(cx, cz) === 0,
    });
    // Hold to repeat (SP5a spec §4.1, D6): a press queues once; with the setting on, a held LMB or RMB is queued again
    // by the frame's aim once its rate has passed and the previous edit's reply has arrived. Its clock is the one the
    // frame's rAF timestamps run on, in seconds.
    const nowS = (): number => performance.now() / 1000;
    const holdRepeat = createHoldRepeat({
      enabled: () => settings.holdRepeat,
      pending: editPath.pending,
      queue: (b) => clicks.push(b, performance.now()),
    });
    teardown.push(installRepeatStop({ doc: document, canvas, repeat: holdRepeat }));
    // A saved world left walking walks again (SP5b spec §3.4 step 5, D4): F's path once, the feet at the saved eye −
    // `EYE` with no snap, before the first frame step.
    if (restored !== null) restoreMode(restored, () => switchMode({ fly, walk, world, repeat: holdRepeat }));
    // The panels whose focused controls keep their own keys (`worldIgnoresKeys`), by their roots' ids in the host.
    const keyPanels: readonly KeyPanel<HTMLElement>[] = [
      { panel: help, root: host.querySelector('#world-help') },
      { panel: settingsPanel, root: host.querySelector('#settings-panel') },
      { panel: palette, root: host.querySelector('#world-palette') },
      { panel: placeDialog, root: host.querySelector('#place-dialog') },
    ];
    const input = attachInput(canvas, {
      onAction,
      onLook: (dx, dy) => look(fly, dx, dy, settings.sensitivity * LOOK_DEG_PER_PIXEL),
      onButton: (b, down) => {
        if (down) holdRepeat.down(b, nowS());
        else holdRepeat.up(b, nowS());
      },
      // Walking, Ctrl+wheel steps the slot as the plain wheel does (SP5a spec §4.1, D9), so it never zooms the page and
      // never means two things while walking (kept when sprint left Ctrl for R and a double-tapped W, Task 45b).
      wheelCtrlAsSlot: () => fly.mode === 'walk',
      // Text-entry controls (spec §7.1), and any focused control inside an open panel (SP5b spec §1.4): a slider or a
      // select left focused in a closed panel leaves H, G, M and F1 working (final review C-I2, Task 28 review I1).
      isTextFocus: () => worldIgnoresKeys(document.activeElement as HTMLElement | null, keyPanels),
      // The world's keys act only while the world owns the controls (SP4c spec §2.3): never while the map owns.
      active: () => mapRef === null || mapRef.owner === 'world',
      doc: document,
      win: window,
    });
    teardown.push(() => input.dispose());

    // The teleport (SP4c spec §3.2-§3.4): the landing on the shared pool, the camera moved in place, the eye light
    // reset to 15; the fog does not react (Point 1). The next tick's `coordinator.update` does the crossing. Walking,
    // the feet arrive above the ground and the walk tick snaps them onto it once the column is Published (SP5a §3.4).
    const teleporter = createTeleport({
      pool: workers,
      fly,
      state: frame,
      // A saved place sets both feet with no snap (SP5b spec §3.7, D13): the snap would lift them onto a roof.
      walk: {
        active: () => fly.mode === 'walk',
        arrive: (x, feetY, z) => arriveFeet(walk, x, feetY, z),
        setFeet: (x, feetY, z) => setFeet(walk, x, feetY, z),
      },
      // F5 after a teleport returns to where the user jumped (SP4c spec §1.6, D20); flight never rewrites the search.
      onArrive: (_x, _z, landing) => {
        worldUrl.arrived(fly);
        opts.wiTest?.landed(landing);
      },
      // "Could not teleport" (D26): in `.world-notices`, or in the tool's row while the map covers the 3D (D27).
      onFail: () => notices.show(TELEPORT_FAILED_NOTICE, { kind: 'warn', timeoutMs: TELEPORT_FAILED_MS }),
    });
    // A landing still pending at teardown settles silently: no write to the disposed page's camera, no notice.
    teleport = teleporter;
    teardown.push(() => teleporter.dispose());
    // The world-modification mode (SP5b spec §3.6, D10, D25): a saved world's map changes its terrain only while "Modify
    // terrain" is on, off at every open; an unsaved world has no switch and edits live. The mode reaches the tool once
    // the overlay mounts it (`tool` is read only after the overlay exists).
    // Its backup (§3.6, D11, D26): the kept record, the autosave's state and history, a new id, every world's name.
    const modifySwitch = saved !== null ? createModifySwitch() : null;
    const savedKv = saved?.kv ?? null;
    const modifyMode = modifySwitch === null || savedKv === null ? null : createModifyMode({
      session,
      tool: () => mapOverlay.tool,
      checkbox: modifySwitch.checkbox,
      backup: {
        sim: simClient!,
        kept: () => kept!,
        applied: () => appliedSnapshot,
        // The autosave exists from the reveal, before the first frame ticks the apply control.
        build: () => autosave!.build(),
        newId: () => crypto.randomUUID(),
        names: () => createSaves(savedKv).list().then((rows) => rows.flatMap((r) => (r.broken ? [] : [r.world.name]))),
        notices,
      },
    });
    modifyRef = modifyMode;
    if (modifyMode !== null) teardown.push(() => modifyMode.dispose());
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
      modify: modifySwitch === null || modifyMode === null ? null : { element: modifySwitch.element, on: () => modifyMode.on },
      // A saved world's places on its map (SP5b spec §3.7, D13): the dots and the Places tab, whose ↗ is the place teleport
      // and whose "+ Add at the pin" opens B's dialog on the pin's ground. An unsaved world has none.
      places: places === null ? null : {
        places,
        colours: PLACE_COLOURS,
        toPlace: (p) => teleporter.toPlace(p),
        addAt: (x, z) => addPlaceAt({
          pool: workers, dialog: placeDialog, places, camera: fly, notices,
        }, x, z),
      },
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
      // The build and walk steps' reads (SP5a spec §6.4); the aim is created below, before the first frame.
      mode: () => fly.mode,
      aim: () => {
        const h = pageAim.hit;
        return { hit: h.hit, x: h.x, y: h.y, z: h.z, face: h.face, outline: pageAim.outlined };
      },
      hotbar: () => ({ active: hotbar.active, slots: hotbar.slots.map(slotName) }),
      blockHistory: () => ({ size: blockHistory.size, redo: blockHistory.redoSize }),
      lightAt: (x, y, z) => lightRead(store, x, y, z),
      feet: () => (fly.mode === 'walk'
        ? { x: walk.x, y: walk.y, z: walk.z, onGround: walk.onGround, snapPending: walk.snapPending, snapY: Number.isNaN(walk.snapY) ? null : walk.snapY }
        : null),
      heightAt: (x, z) => heightRead(store, x, z),
    });
    // Disposed before the input, the driver and the page's subscribe: a gesture still open ends through the tool.
    teardown.push(() => mapOverlay.dispose());
    // Undo and redo (SP4c spec §2.4; SP5a spec §4.5): live for the page's lifetime, map shown or hidden, never in text
    // entry; blocks while the world owns the controls, the session's params while the map does.
    teardown.push(installUndoKeys({ owner: () => mapOverlay.owner, blocks: blockHistory, session }));
    // A saved world's autosave (SP5b spec §3.2, D5), armed at the reveal with the world as opened (its mode restored
    // above): the 2,000 ms timer, the hide and close triggers, and the navigations' and the failure's last flush. It has
    // no per-frame hook (SP4b D25).
    if (saved !== null) {
      const opened = saved;
      const worldPlaces = places!;
      // D14's storage notices (SP5b spec §3.8): every `flushed`, and the page's connection's events.
      const storageNotices = watchStorage(notices, saved.kv);
      teardown.push(() => storageNotices.dispose());
      const a = createPageAutosave({
        worldId: opened.state.worldId,
        fly,
        frame,
        speedIndex: () => speedIndex,
        storedTime: restored !== null && !restored.saveClock ? opened.state.time : null,
        hotbar: () => worldHotbar,
        blockHistory,
        sim: simClient!,
        places: () => worldPlaces.list,
        settled: editPath.settled,
        editsSince: accepted.count,
        now: () => Date.now(),
        clock: {
          now: () => performance.now(),
          setInterval: (f, ms) => window.setInterval(f, ms),
          clearInterval: (id) => window.clearInterval(id),
          setTimeout: (f, ms) => window.setTimeout(f, ms),
          clearTimeout: (id) => window.clearTimeout(id),
        },
        events: {
          on(type, f) {
            // The last save on `pagehide` runs before the world's lock is released (§3.5).
            if (type === 'pagehide') return worldLock!.onPageHide(f);
            const target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = type === 'visibilitychange' ? document : window;
            target.addEventListener(type, f);
            return () => target.removeEventListener(type, f);
          },
          hidden: () => document.visibilityState === 'hidden',
        },
        // Every `flushed`: D14's storage notices (SP5b spec §3.8).
        onResult: (r) => storageNotices.flushed(r),
      });
      autosave = a;
      teardown.push(() => a.dispose());
      // Stopped once the lock is released at a `pagehide`: a page restored from the back/forward cache never writes (§3.5).
      teardown.push(worldLock!.onRelease(() => a.dispose()));
      // An older generator's open: D8's notice, and its `record` saved by the first tick (ruling P27).
      revealOlderGenerator(generator!, { notices, autosave: a });
      // A place added, edited or removed is saved by the next tick (its list is new at each change, rulings R9).
      teardown.push(worldPlaces.subscribe(() => a.markChanged()));
    }

    // The streaming frame (SP4b spec §7.2): the slow-frame notice and the throttle get every raw rAF delta before the
    // limiter, so an FPS cap of 30 is read as neither slow frames nor a reason to throttle generation.
    const clock = createFrameClock(limiter, slowFrames, revealTs);
    let n = 0;
    let firstMax = 0;
    // The DDA, the held button's repeat, the queued clicks and the outline (SP5a spec §3.5, §4.1).
    const pageAim = createAim({
      fly, world, locked: () => document.pointerLockElement === canvas, hud, clicks, repeat: { hold: holdRepeat, now: nowS },
    });
    const step = createFrameStep({
      fly,
      walk,
      held: () => input.held,
      // The flight pauses while the help, the palette, B's dialog or the Settings screen is open or the map owns the
      // controls (SP4c spec §2.3; SP5a §4.4; SP5b §3.7, §1.4).
      paused: () => help.isOpen || palette.isOpen || placeDialog.isOpen || settingsPanel.isOpen || mapOverlay.owner === 'map',
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

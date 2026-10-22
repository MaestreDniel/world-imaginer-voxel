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
 *    `?renderer` overriding it) expects the mesh disc; `coordinator.load` stages each payload into it, and a rAF loop
 *    builds regions within a 12 ms upload budget and feeds the loading screen's progress.
 * 5. When every column is meshed and every region built: `compile()`, the camera placed with `firstView` from the
 *    store's `MOTION_BLOCKING`, three frames rendered behind the opaque overlay (`warmUp`: the sections' buffers reach
 *    the GPU while still hidden), then `revealAll()` and the reveal frame, the overlay faded out over 300 ms, and
 *    "Click to fly" until the pointer locks. Nothing of the world is visible before that frame.
 *
 * The frame loop: the FPS limiter, the fly controller within the loaded disc (§7.5), the floating origin, the clock
 * (T cycles the time speed), `FrameState` (its `eyeSky` read from the page's attached store), the HUD (F3) and the help
 * (H, F1). Load errors (`LoadError`, `StoreFullError`, `WorkerFailed`, the watchdog) show the failure panel, with a link
 * to the next lower RD when rd > 4 (P49). `WorldPage.loadStats` holds the load's figures for the flight JSON (§9.5).
 */
import { colKey } from '../../core/coords';
import { MEDIUM } from '../../core/params/graphicsPresets';
import { OPENING_T, TIME_SPEEDS, advanceTime } from '../../daynight/dayNight';
import { probeCapabilities } from '../../engine/capabilities';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../engine/capabilityRules';
import { LoadError, createCoordinator, phaseName, progressFraction, worldJobsOf, type LoadProgress } from '../../engine/coordinator';
import { RD_MIN, resolveRenderDistance } from '../../engine/renderDistance';
import { stageOffsets, type Stage } from '../../engine/rings';
import { createUploadBudget } from '../../engine/uploadBudget';
import { StoreFullError, WorkerFailed, createBrowserPool, poolSize, type WorkerPool } from '../../engine/workerPool';
import { SPEED_DEFAULT, applyCameraRotation, look, stepFly, stepSpeed, type FlyBounds, type FlyState } from '../../player/fly';
import { attachInput } from '../../player/input';
import { DEFAULT_KEYMAP, type Action } from '../../player/keymap';
import { createFpsLimiter, type FpsLimiter } from '../../render/fpsLimiter';
import type { FrameState } from '../../render/frameState';
import { createWorldRenderer, type WorldRenderer } from '../../render/renderer';
import { selectSectionRenderer, type SectionRendererKind } from '../../render/sectionRenderer';
import { createStore, type VoxelStore } from '../../world/store/store';
import { renderErrorScreen } from '../capabilityReport';
import { el } from '../common/dom';
import { createFrameStats } from '../frameStats';
import { mountHelp, type Help } from '../help';
import { mountWorldHud } from '../hud';
import { mountLoadingScreen } from '../loading/loadingScreen';
import { tips } from '../loading/tips';
import { decodeMapState, encodeMapState, openMapSession } from '../map/mapState';
import { cryptoSeed } from '../seedBox';
import { loadSettings, saveSettings, type WorldSettings } from '../settings';
import { firstView } from './firstView';
import { Y_MAX, Y_MIN, type WorldQuery } from './query';

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
}

/** The load's figures for the flight JSON (SP4a spec §8.4, §9.5). */
export interface LoadStats {
  /** ms from `mountWorldPage` to the reveal frame; null before it. */
  revealMs: number | null;
  /** ms from `coordinator.load` until each stage's last column finished; null while it runs. */
  stageMs: Record<Stage, number | null>;
  /** RegionMesh's merge ms (0 on RegionBatch), read at the reveal. */
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

/** The loading screen's per-frame upload budget (SP4a spec §6.2). */
const LOAD_UPLOAD_MS = 12;
/** The overlay's fade at the reveal (spec §8.4). */
const FADE_MS = 300;
/** Frames rendered behind the opaque overlay before the reveal (spec §8.4). */
const WARM_UP_FRAMES = 3;
/** Frames after the reveal whose largest delta is recorded (spec §8.4). */
const FIRST_FRAMES = 120;
/** Mouse look at sensitivity ×1, in degrees per pixel of movement; the setting multiplies it (spec §7.1, §7.4). */
const LOOK_DEG_PER_PIXEL = 0.15;
/** The longest step the fly controller takes in one frame, s: a tab back from the background does not jump. */
const MAX_STEP_S = 0.25;
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

/** The failure panel's one-line cause for a load error. */
function causeOf(e: unknown): string {
  const inner = e instanceof LoadError ? e.cause : e;
  if (inner instanceof StoreFullError) return 'The world store is full: a lower render distance needs less of it.';
  if (inner instanceof WorkerFailed) return `A worker failed: ${inner.message}`;
  if (e instanceof LoadError) return `A column job failed: ${e.message}`;
  return `The world could not load: ${errorText(e)}`;
}

/** The voxel's sky light 0-15 from the store's final set (spec §6.6): 15 above y 319 or outside the loaded disc. */
function skyLightAt(store: VoxelStore, disc: ReadonlySet<number>, x: number, y: number, z: number): number {
  const by = Math.floor(y);
  if (by > 319) return 15;
  if (by < -64) return 0;
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const cx = bx >> 4;
  const cz = bz >> 4;
  if (!disc.has(colKey(cx, cz))) return 15;
  const col = store.final(cx, cz);
  return col === null ? 15 : col.light(bx & 15, by, bz & 15) >> 4;
}

/** `MOTION_BLOCKING` at block (x, z) from the store's final set; +∞ for a column without one (never the lowest). */
function motionBlockingAt(store: VoxelStore, x: number, z: number): number {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const aux = store.final(bx >> 4, bz >> 4)?.aux() ?? null;
  return aux === null ? Number.POSITIVE_INFINITY : aux.motionBlocking[((bz & 15) << 4) | (bx & 15)]!;
}

/** The URL that reloads the world around the camera: `/?at=x,z&y=..&yaw=..&pitch=..#hash` (no rd: the setting applies). */
function aroundUrl(f: FlyState, hashPart: string): string {
  return `/?at=${Math.round(f.x)},${Math.round(f.z)}&y=${Math.round(f.y)}&yaw=${f.yaw.toFixed(1)}&pitch=${f.pitch.toFixed(1)}${hashPart}`;
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

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

  const stats: LoadStats = { revealMs: null, stageMs: { T: null, D: null, L: null, MESH: null }, mergeMs: 0, longTasks: null, first120MaxMs: null };
  let state: WorldPage['state'] = 'loading';
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });

  // What the failure details and the lower-RD link name, filled in as the load learns them.
  let report: CapabilityReport | null = null;
  let rd: number | null = null;
  let centre: { x: number; z: number } | null = q.at;
  let pool: WorkerPool | null = null;
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
    onWatchdog: () => fail('No progress for 30 s: the load stalled.', null),
    loadManifest: () => fetch('/panoramas/manifest.json').then((r) => (r.ok ? r.json() : null)),
    rand: Math.random,
  });
  loading.progress(0, 'Generating');

  const lowerRdHref = (): string | null =>
    rd !== null && rd > RD_MIN
      ? `/?rd=${Math.max(RD_MIN, rd - 2)}${centre === null ? '' : `&at=${centre.x},${centre.z}`}${hashPart}`
      : null;

  const details = (e: unknown): string => [
    e === null ? null : e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e),
    e instanceof LoadError && e.cause instanceof Error ? `cause: ${e.cause.stack ?? e.cause.message}` : null,
    `seed ${seedText ?? '?'} · profile ${profile ?? '?'} · rd ${rd ?? '?'} · centre ${centre === null ? '?' : `${centre.x}, ${centre.z}`}`,
    `workers ${pool?.size ?? '?'} · renderer ${report?.renderer ?? '?'} · multiDraw ${report?.multiDraw ?? '?'}`,
    `url ${location.href}`,
    `user agent ${navigator.userAgent}`,
  ].filter((l) => l !== null).join('\n');

  function fail(cause: string, e: unknown): void {
    if (state !== 'loading') return;
    state = 'failed';
    longTasks?.disconnect();
    pool?.terminate();
    loading.fail(cause, details(e), { map: mapHref, lowerRd: lowerRdHref() });
    settle();
  }

  function dispose(): void {
    if (state === 'loading') state = 'failed';
    cancelAnimationFrame(raf);
    longTasks?.disconnect();
    for (const fn of teardown.splice(0).reverse()) fn();
    loading.dispose();
    wr?.dispose();
    pool?.terminate();
    root.replaceChildren();
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
    let settings: WorldSettings = loadSettings(storage);
    const loadRd = resolveRenderDistance(caps, q.rd, settings.rd);
    rd = loadRd;
    const store = createStore({ shared: true, maxBlockBytes: caps.reservation.blockBytes, maxByteBytes: caps.reservation.byteBytes });
    const workers = createBrowserPool(q.workers ?? poolSize(navigator.hardwareConcurrency || 4), {
      onFailure: (e) => fail(causeOf(e), e),
    });
    pool = workers;
    await workers.attachStore(store.handles());
    await workers.configure(session.state.seedText, session.state.params);
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
    });
    wr = world;
    const sections = world.sections;
    // The load centre sets the first floating origin (spec §6.8), before anything is staged.
    if (world.origin.update(at.x, 0, at.z)) sections.setOrigin(world.origin.x, world.origin.y, world.origin.z);
    const cx0 = at.x >> 4;
    const cz0 = at.z >> 4;
    const meshDisc = stageOffsets(loadRd).MESH.map(([dx, dz]) => [cx0 + dx, cz0 + dz] as const);
    const disc = new Set(meshDisc.map(([cx, cz]) => colKey(cx, cz)));
    sections.expect(meshDisc);

    let progress: LoadProgress | null = null;
    let meshed = false;
    const loadStart = performance.now();
    const coordinator = createCoordinator({
      workers: workers.size,
      jobs: worldJobsOf(workers),
      versionsAt: (cx, cz) => store.neighborhood(cx, cz).versions(),
      onMesh: (p) => sections.stage(p),
      onProgress: (p) => {
        progress = p;
        for (const s of STAGES) if (stats.stageMs[s] === null && p.done[s] === p.needed[s]) stats.stageMs[s] = performance.now() - loadStart;
      },
    });
    coordinator.load(cx0, cz0, loadRd).then(() => { meshed = true; }, (e: unknown) => fail(causeOf(e), e));

    const budget = createUploadBudget(LOAD_UPLOAD_MS, () => performance.now());
    try {
      await everyFrameUntil((cb) => { raf = requestAnimationFrame(cb); }, () => {
        if (state !== 'loading') return true;
        budget.start();
        sections.buildNext(() => budget.exhausted());
        const c = sections.counts();
        if (progress !== null) loading.progress(progressFraction(progress, c.builtRegions, c.regions), phaseName(progress, c.builtRegions, c.regions));
        return meshed && c.builtRegions === c.regions;
      });
    } catch (e) {
      // A build error (a BatchedMesh `addGeometry` that does not fit, a merge error) is a load error (spec §8.3).
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
    // The disc's centre: the load centre of the edge fade and of the fly bounds (spec §6.6, §7.5).
    const discX = cx0 * 16 + 8;
    const discZ = cz0 * 16 + 8;
    const bounds: FlyBounds = { centreX: discX, centreZ: discZ, radius: (loadRd - 3) * 16, yMin: -64, yMax: 400 };
    const fixedT = opts.timeHours === undefined || opts.timeHours === null ? null : ((((opts.timeHours - 6) / 24) % 1) + 1) % 1;
    let t = fixedT ?? OPENING_T;
    let speedIndex = 0;
    const timeSpeed = (): number => (fixedT === null ? TIME_SPEEDS[speedIndex]! : 0);

    const placeCamera = (): void => {
      if (world.origin.update(fly.x, fly.y, fly.z)) sections.setOrigin(world.origin.x, world.origin.y, world.origin.z);
      world.camera.position.set(fly.x - world.origin.x, fly.y - world.origin.y, fly.z - world.origin.z);
      applyCameraRotation(world.camera, fly);
    };
    const frameState = (): FrameState => ({
      t,
      brightness: settings.brightness,
      eyeSky: skyLightAt(store, disc, fly.x, fly.y, fly.z),
      rd: loadRd,
      fogBand: MEDIUM.fogBand,
      edgeCentre: [discX - world.origin.x, discZ - world.origin.z],
    });

    for (let i = 0; i < WARM_UP_FRAMES; i++) {
      await nextFrame();
      if (state !== 'loading') return;
      placeCamera();
      world.warmUp(frameState());
    }
    const revealTs = await nextFrame();
    if (state !== 'loading') return;
    // The reveal frame: every section at once (master §4.2's atomic reveal).
    sections.revealAll();
    placeCamera();
    world.frame(frameState());
    state = 'revealed';
    stats.revealMs = performance.now() - t0;
    stats.mergeMs = sections.counts().mergeMs;
    if (longTasks !== null) {
      const lt = stats.longTasks!;
      for (const entry of longTasks.takeRecords()) {
        lt.count++;
        lt.maxMs = Math.max(lt.maxMs, entry.duration);
      }
      longTasks.disconnect();
      longTasks = null;
    }

    const canvas = world.renderer.domElement;
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
    const huds = hud
      ? mountWorldHud(host, () => {
        const done = progress?.done;
        const info = world.info();
        return {
          frame: frames.summary(),
          columns: { t: done?.T ?? 0, d: done?.D ?? 0, l: done?.L ?? 0, meshed: done?.MESH ?? 0 },
          sections: sections.counts().sections,
          drawCalls: info.calls,
          triangles: info.triangles,
          position: { x: fly.x, y: fly.y, z: fly.z },
          speed: fly.speed,
          time: t,
          timeSpeed: timeSpeed(),
          rd: loadRd,
          workers: workers.size,
          sectionRenderer: kind,
          renderer: caps.renderer,
        };
      })
      : null;
    if (huds !== null) teardown.push(() => huds.dispose());

    const applySettings = (s: WorldSettings): void => {
      const rdChanged = s.rd !== settings.rd;
      if (s.fpsCap !== settings.fpsCap) limiter.setCap(s.fpsCap);
      if (s.fov !== settings.fov) {
        world.camera.fov = s.fov;
        world.camera.updateProjectionMatrix();
      }
      settings = s;
      saveSettings(storage, s);
      // The render distance applies to a new load only: reload around the camera, without ?rd so the setting applies.
      if (rdChanged) location.assign(aroundUrl(fly, hashPart));
    };
    const help: Help = mountHelp(host, {
      map: DEFAULT_KEYMAP,
      settings,
      onSettings: applySettings,
      report: caps,
      evaluation,
      mapHereHref: () => `?map#${encodeMapState({
        v: 1,
        seed: session.state.seedText,
        profile: session.state.profile,
        patch: session.state.patch,
        view: { ...decoded.state.view, x: Math.round(fly.x), z: Math.round(fly.z) },
      })}`,
      onFullscreen: () => {
        document.documentElement.requestFullscreen().catch(() => {});
      },
      onClose: () => {},
    });

    const onAction = (a: Action): void => {
      switch (a) {
        case 'speedUp': stepSpeed(fly, 1); break;
        case 'speedDown': stepSpeed(fly, -1); break;
        case 'timeSpeed': if (fixedT === null) speedIndex = (speedIndex + 1) % TIME_SPEEDS.length; break;
        case 'hud': huds?.toggle(); break;
        case 'help':
          if (help.isOpen) help.close();
          else {
            document.exitPointerLock();
            help.open();
          }
          break;
        default: break; // movement and sprint are held; R (loadHere) reloads at the edge (spec §7.5)
      }
    };
    const input = attachInput(canvas, {
      onAction,
      onLook: (dx, dy) => look(fly, dx, dy, settings.sensitivity * LOOK_DEG_PER_PIXEL),
      isTextFocus: () => {
        const a = document.activeElement;
        return a !== null && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
      },
      doc: document,
      win: window,
    });
    teardown.push(() => input.dispose());

    let last = revealTs;
    let n = 0;
    let firstMax = 0;
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      if (!limiter.tick(now)) return;
      try {
        const dtMs = Math.max(0, now - last);
        last = now;
        frames.push(dtMs);
        if (n < FIRST_FRAMES) {
          firstMax = Math.max(firstMax, dtMs);
          if (n + 1 === FIRST_FRAMES) stats.first120MaxMs = firstMax;
        }
        if (!help.isOpen) stepFly(fly, input.held, Math.min(dtMs / 1000, MAX_STEP_S), bounds);
        t = advanceTime(t, dtMs, timeSpeed());
        placeCamera();
        world.frame(frameState());
        n++;
        opts.onFrame?.(n);
      } catch (e) {
        // After the reveal there is no failure panel: stop the loop and report the error once, not on every frame.
        cancelAnimationFrame(raf);
        console.error('The frame loop stopped:', e);
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

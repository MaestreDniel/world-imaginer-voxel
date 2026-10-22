/**
 * The flight route `?flight=sp4a` (SP4a spec §9.5, D24; rulings P9, P42): seed 42, the default profile, RD 12 and the
 * default pool (`?workers` overriding it), the section renderer the probe selects (`?renderer` overriding it). The world
 * page loads and reveals as usual, with no HUD and no overlay; then its flight hook hands the frame loop to `runFlight`:
 * 1. 120 idle frames (nothing rendered) give the display interval, the median rAF delta;
 * 2. a 60 s flight along `catmullRom` through `flightWaypoints`, the day running from 06:00 through one full cycle, the
 *    camera's pitch damped toward the horizon (`cameraPitch`);
 *    per frame: the rAF delta, the main-thread ms (callback start to `render()`'s return), draw calls, triangles, and
 *    the GPU ms where the timer query exists;
 * 3. `summarizeFlight` builds the JSON, the page sets `window.__wiFlight.result` (read over CDP by measureChrome) and
 *    shows a "Download JSON" button (the Firefox cells, by hand).
 * The stored settings are not read on this route (the world page uses the defaults: no FPS cap, FOV 70), so a user's
 * own cap or FOV never changes a measured cell.
 */
import type { CapabilityReport } from '../../engine/capabilityRules';
import { medianInterval, percentile, snapFrameTime } from '../../render/frameTiming';
import type { WorldRenderer } from '../../render/renderer';
import type { SectionRendererKind } from '../../render/sectionRenderer';
import { el } from '../common/dom';
import { DEFAULT_MAP_STATE, encodeMapState } from '../map/mapState';
import { Y_MAX, Y_MIN, parseWorldQuery, type WorldQuery } from './query';
import { mountWorldPage, type LoadStats } from './worldPage';

/** The route's world (spec §9.5). */
export const FLIGHT_SEED = '42';
export const FLIGHT_PROFILE = 'default';
export const FLIGHT_RD = 12;
/** The flight's length, and the day's: one full cycle in 60 s (spec §9.5). */
export const FLIGHT_MS = 60_000;
/** The idle frames that measure the display interval (spec §9.5). */
export const IDLE_FRAMES = 120;
/** The low leg's height over water, blocks above `MOTION_BLOCKING` (spec §9.5). */
export const LOW_LEG = 20;
/**
 * The other waypoints' heights above `MOTION_BLOCKING`, in loop order: within 20-80, never the low leg's 20, and rising
 * and falling by at most 15 blocks from one waypoint to the next, so the legs climb gently.
 */
const ABOVE: readonly number[] = [40, 50, 60, 70, 80, 65, 50, 35];
/** The camera's pitch on a level leg: the opening view's −10° (spec §8.4). */
const LEVEL_PITCH = -10;
/** How far the tangent's pitch moves the camera's, either way, before it is halved. */
const PITCH_SWING = 20;
/** The waypoints' distances from the spawn as fractions of (rd − 4)·16, alternating outer and inner. */
const OUTER = 0.85;
const INNER = 0.55;
/** The step of the water search over the flight disc, blocks. */
const WATER_STEP = 4;
/** The camera stays at least this far above `MOTION_BLOCKING` between waypoints, blocks. */
const CLEARANCE = 4;
/** Spec §9.5's long frame: over 33 ms. */
const LONG_FRAME_MS = 33;
/** How many long frames the JSON lists one by one. */
const LONG_FRAMES_LISTED = 16;

const DEG = 180 / Math.PI;
const MIB = 1 << 20;

export interface Waypoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FlightPose extends Waypoint {
  /** Degrees, ruling P42: yaw 0 faces −z, 90 faces +x, in [0, 360); pitch positive upward. */
  readonly yaw: number;
  readonly pitch: number;
}

/**
 * The flight's eight waypoints (spec §9.5): a deterministic loop around the spawn at yaw 0°, 45° … 315° (ruling P42's
 * `forwardXZ`), alternately at 0.85 and 0.55 of (rd − 4)·16 blocks, each `ABOVE[k]` blocks (30-80) above
 * `MOTION_BLOCKING` there. When the disc of radius 0.85·(rd − 4)·16 has water (searched on a 4-block grid in row
 * order), the water sample nearest to a waypoint replaces that waypoint, 20 blocks above `MOTION_BLOCKING` (the water's
 * surface): the one low leg over water.
 */
export function flightWaypoints(
  spawn: { readonly x: number; readonly z: number },
  rd: number,
  motionBlockingAt: (x: number, z: number) => number,
  hasWater: (x: number, z: number) => boolean,
): Waypoint[] {
  const radius = (rd - 4) * 16;
  const xz: Array<{ x: number; z: number }> = [];
  for (let k = 0; k < 8; k++) {
    const yaw = (45 * k) / DEG;
    const r = radius * (k % 2 === 0 ? OUTER : INNER);
    xz.push({ x: Math.round(spawn.x + r * Math.sin(yaw)), z: Math.round(spawn.z - r * Math.cos(yaw)) });
  }
  const out: Waypoint[] = xz.map((p, k) => ({ x: p.x, y: motionBlockingAt(p.x, p.z) + ABOVE[k]!, z: p.z }));

  // The water sample nearest to a waypoint, the first in row order on a tie.
  const reach = radius * OUTER;
  const steps = Math.floor(reach / WATER_STEP);
  let best: { k: number; x: number; z: number; d: number } | null = null;
  for (let j = -steps; j <= steps; j++) {
    for (let i = -steps; i <= steps; i++) {
      const dx = i * WATER_STEP;
      const dz = j * WATER_STEP;
      if (dx * dx + dz * dz > reach * reach) continue;
      const x = Math.round(spawn.x) + dx;
      const z = Math.round(spawn.z) + dz;
      if (!hasWater(x, z)) continue;
      for (let k = 0; k < 8; k++) {
        const d = Math.hypot(x - xz[k]!.x, z - xz[k]!.z);
        if (best === null || d < best.d) best = { k, x, z, d };
      }
    }
  }
  if (best !== null) out[best.k] = { x: best.x, y: motionBlockingAt(best.x, best.z) + LOW_LEG, z: best.z };
  return out;
}

/** The yaw of a tangent, degrees in [0, 360) (ruling P42: atan2(dx, −dz)). */
function yawOf(dx: number, dz: number): number {
  const a = Math.atan2(dx, -dz) * DEG;
  const w = ((a % 360) + 360) % 360;
  return w >= 360 ? 0 : w + 0;
}

/**
 * The closed uniform Catmull-Rom spline through `pts` at u ∈ [0, 1) (wrapped), passing through `pts[i]` at u = i/n;
 * the yaw and the pitch follow the tangent (ruling P42): yaw atan2(dx, −dz), pitch atan2(dy, hypot(dx, dz)), degrees.
 */
export function catmullRom(pts: readonly Waypoint[], u: number): FlightPose {
  const n = pts.length;
  const w = u - Math.floor(u);
  const s = w * n;
  const i = Math.min(n - 1, Math.floor(s));
  const f = s - i;
  const p0 = pts[(i - 1 + n) % n]!;
  const p1 = pts[i]!;
  const p2 = pts[(i + 1) % n]!;
  const p3 = pts[(i + 2) % n]!;
  const f2 = f * f;
  const f3 = f2 * f;
  const at = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (-a + 3 * b - 3 * c + d) * f3);
  const slope = (a: number, b: number, c: number, d: number): number =>
    0.5 * ((c - a) + 2 * (2 * a - 5 * b + 4 * c - d) * f + 3 * (-a + 3 * b - 3 * c + d) * f2);
  const dx = slope(p0.x, p1.x, p2.x, p3.x);
  const dy = slope(p0.y, p1.y, p2.y, p3.y);
  const dz = slope(p0.z, p1.z, p2.z, p3.z);
  return {
    x: at(p0.x, p1.x, p2.x, p3.x),
    y: at(p0.y, p1.y, p2.y, p3.y),
    z: at(p0.z, p1.z, p2.z, p3.z),
    yaw: yawOf(dx, dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG + 0,
  };
}

/**
 * The camera's pitch for a tangent's pitch (degrees): half the tangent's, limited to ±20° first, below the opening
 * view's −10°, so within [−20°, 0°]. The view follows the climbs and dives without ever looking above the horizon: a
 * camera that looked along a 30° climb would see only sky, and frames of sky would not measure the world.
 */
export function cameraPitch(tangentPitch: number): number {
  return LEVEL_PITCH + Math.min(PITCH_SWING, Math.max(-PITCH_SWING, tangentPitch)) / 2;
}

/** The load's figures (the world page's `LoadStats`, spec §8.4). */
export type FlightLoad = Readonly<LoadStats>;

/** What `summarizeFlight` needs beyond the frame and main-thread times. */
export interface FlightExtra {
  readonly seed: string;
  readonly profile: string;
  readonly rd: number;
  readonly workers: number;
  readonly sectionRenderer: SectionRendererKind;
  readonly userAgent: string;
  /** As reported (masked on Firefox, spec §9.5). */
  readonly renderer: string | null;
  readonly vendor: string | null;
  readonly multiDraw: boolean;
  readonly timerQuery: boolean;
  readonly screen: { readonly width: number; readonly height: number };
  readonly dpr: number;
  /** The drawing buffer's pixel ratio, min(dpr, `pixelRatioCap`). */
  readonly pixelRatio: number;
  readonly load: FlightLoad;
  /** GPU ms per frame from `WorldRenderer.gpuTimer()`; null without the timer query (Firefox). */
  readonly gpuMs: Float64Array | null;
  /** Per flight frame, as `frames`. */
  readonly drawCalls: Float64Array;
  readonly triangles: Float64Array;
  /** `performance.memory.usedJSHeapSize` in MiB where exposed (Chrome), else null. */
  readonly heapMB: number | null;
  /** The store's SharedArrayBuffers in MiB. */
  readonly sabMB: number;
  readonly durationMs: number;
  readonly waypoints: readonly Waypoint[];
  /** Each waypoint's height above `MOTION_BLOCKING` (20 marks the low leg over water). */
  readonly waypointsAbove: readonly number[];
}

/** The flight's JSON (spec §9.5). The key names are the ones measureChrome's summary line reads (ruling P9). */
export interface FlightResult {
  readonly route: 'flight=sp4a';
  readonly seed: string;
  readonly profile: string;
  readonly rd: number;
  readonly workers: number;
  readonly sectionRenderer: SectionRendererKind;
  readonly userAgent: string;
  readonly renderer: string | null;
  readonly vendor: string | null;
  readonly multiDraw: boolean;
  readonly timerQuery: boolean;
  readonly screen: { readonly width: number; readonly height: number };
  readonly dpr: number;
  readonly pixelRatio: number;
  /** The median of the idle rAF deltas: the interval the frame times snap to. */
  readonly displayIntervalMs: number;
  readonly load: FlightLoad;
  /** Snapped frame times (spec §9.5): count, nearest-rank p50 / p95 / p99, max, and the count over 33 ms. */
  readonly frames: { readonly count: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number; readonly over33: number };
  /** Main-thread ms per frame, from the rAF callback's start to `render()`'s return. */
  readonly main: { readonly p50: number; readonly p95: number; readonly max: number };
  /** GPU ms (p50, p95 and the number of samples), or null without the timer query or without a sample. */
  readonly gpuMs: { readonly p50: number; readonly p95: number; readonly samples: number } | null;
  readonly drawCalls: { readonly max: number; readonly mean: number };
  readonly triangles: { readonly max: number };
  readonly heapMB: number | null;
  readonly sabMB: number;
  /**
   * The first long frames (snapped > 33 ms): the frame index, its raw delta, its own main ms and the previous frame's
   * (a delta is the gap that ends at its rAF, which the previous frame's work fills; G2 review M1).
   */
  readonly longFrames: ReadonlyArray<{ readonly frame: number; readonly deltaMs: number; readonly mainMs: number; readonly prevMainMs: number | null }>;
  readonly durationMs: number;
  readonly waypoints: readonly Waypoint[];
  readonly waypointsAbove: readonly number[];
}

/** A failed route: the page could not load or fly (measureChrome writes it as it is and stops polling). */
export interface FlightError {
  readonly route: 'flight=sp4a';
  readonly error: string;
}

function maxOf(values: ArrayLike<number>): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) m = Math.max(m, values[i]!);
  return values.length === 0 ? Number.NaN : m;
}

/**
 * The flight's JSON from its raw rAF deltas `frames` (one per flight frame), main-thread ms `mainMs` (the same frames),
 * the display interval and `extra` (spec §9.5). Frame figures are taken over the snapped times (`snapFrameTime`).
 */
export function summarizeFlight(frames: Float64Array, mainMs: Float64Array, interval: number, extra: FlightExtra): FlightResult {
  const snapped = frames.map((d) => snapFrameTime(d, interval));
  let over33 = 0;
  const longFrames: Array<FlightResult['longFrames'][number]> = [];
  snapped.forEach((ms, i) => {
    if (ms <= LONG_FRAME_MS) return;
    over33++;
    if (longFrames.length < LONG_FRAMES_LISTED) {
      longFrames.push({ frame: i, deltaMs: frames[i]!, mainMs: mainMs[i]!, prevMainMs: i > 0 ? mainMs[i - 1]! : null });
    }
  });
  let calls = 0;
  for (let i = 0; i < extra.drawCalls.length; i++) calls += extra.drawCalls[i]!;
  const gpu = extra.gpuMs === null || extra.gpuMs.length === 0
    ? null
    : { p50: percentile(extra.gpuMs, 50), p95: percentile(extra.gpuMs, 95), samples: extra.gpuMs.length };
  return {
    route: 'flight=sp4a',
    seed: extra.seed,
    profile: extra.profile,
    rd: extra.rd,
    workers: extra.workers,
    sectionRenderer: extra.sectionRenderer,
    userAgent: extra.userAgent,
    renderer: extra.renderer,
    vendor: extra.vendor,
    multiDraw: extra.multiDraw,
    timerQuery: extra.timerQuery,
    screen: { width: extra.screen.width, height: extra.screen.height },
    dpr: extra.dpr,
    pixelRatio: extra.pixelRatio,
    displayIntervalMs: interval,
    load: extra.load,
    frames: {
      count: frames.length,
      p50: percentile(snapped, 50),
      p95: percentile(snapped, 95),
      p99: percentile(snapped, 99),
      max: maxOf(snapped),
      over33,
    },
    main: { p50: percentile(mainMs, 50), p95: percentile(mainMs, 95), max: maxOf(mainMs) },
    gpuMs: gpu,
    drawCalls: { max: maxOf(extra.drawCalls), mean: extra.drawCalls.length === 0 ? Number.NaN : calls / extra.drawCalls.length },
    triangles: { max: maxOf(extra.triangles) },
    heapMB: extra.heapMB,
    sabMB: extra.sabMB,
    longFrames,
    durationMs: extra.durationMs,
    waypoints: extra.waypoints,
    waypointsAbove: extra.waypointsAbove,
  };
}

// ---------------------------------------------------------------- the route

/** What the world page hands the flight after the reveal (its flight hook, `WorldPageOptions.flight`). */
export interface FlightContext {
  readonly host: HTMLElement;
  readonly world: Pick<WorldRenderer, 'info' | 'gpuTimer' | 'renderer'>;
  /** The load centre (the spawn on this route). */
  readonly centre: { readonly x: number; readonly z: number };
  readonly rd: number;
  readonly workers: number;
  readonly kind: SectionRendererKind;
  readonly report: CapabilityReport;
  readonly seed: string;
  readonly profile: string;
  readonly loadStats: Readonly<LoadStats>;
  /** The reveal frame's rAF timestamp. */
  readonly revealTs: number;
  /** `MOTION_BLOCKING` at block (x, z) from the store's final set; +∞ outside the loaded columns. */
  motionBlockingAt(x: number, z: number): number;
  /** Whether the column at block (x, z) holds water at its top (`MOTION_BLOCKING` above `OCEAN_FLOOR`). */
  hasWater(x: number, z: number): boolean;
  /** Places the camera at `pose`, sets the clock to t and renders one frame (the page's `FrameState`). */
  render(pose: FlightPose, t: number): void;
  /** The store's SharedArrayBuffers in MiB. */
  sabMB(): number;
  /** True once the WebGL context was lost. */
  lost(): boolean;
}

declare global {
  interface Window {
    /** The flight's JSON once the route has run, or `{ error }` (read by measureChrome.ts over CDP). */
    __wiFlight?: { result: FlightResult | FlightError };
  }
}

/** Calls `onFrame(now)` in consecutive rAF callbacks until it returns true; rejects with the first throw. */
function framesUntil(onFrame: (now: number) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const tick = (now: number): void => {
      let done: boolean;
      try {
        done = onFrame(now);
      } catch (e) {
        reject(e);
        return;
      }
      if (done) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** A growable list of numbers, kept as a Float64Array. */
function series(capacity = 1 << 14): { push(v: number): void; values(): Float64Array } {
  let a = new Float64Array(capacity);
  let n = 0;
  return {
    push(v) {
      if (n === a.length) {
        const b = new Float64Array(2 * a.length);
        b.set(a);
        a = b;
      }
      a[n++] = v;
    },
    values: () => a.slice(0, n),
  };
}

/** `performance.memory.usedJSHeapSize` in MiB (Chrome only), else null. */
function heapMB(): number | null {
  const memory = (performance as Performance & { readonly memory?: { readonly usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / MIB : null;
}

/** The status line and, at the end, the "Download JSON" button, over the world. */
function flightPanel(host: HTMLElement): { say(s: string): void; publish(result: FlightResult | FlightError): void } {
  const panel = el('div', 'flight-panel');
  panel.id = 'flight-panel';
  panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:3;display:flex;gap:8px;align-items:center;padding:4px 8px;'
    + 'background:rgba(15,22,41,.85);border-radius:4px;font:13px/1.4 system-ui,sans-serif;color:#e0e0e0';
  const status = el('span', '', 'Flight: measuring the display interval…');
  panel.append(status);
  host.append(panel);
  return {
    say: (s) => { status.textContent = `Flight: ${s}`; },
    publish: (result) => publishFlight(result, panel),
  };
}

/** Sets `window.__wiFlight.result` and appends the "Download JSON" button to `panel` (spec §9.5). */
function publishFlight(result: FlightResult | FlightError, panel: HTMLElement): void {
  window.__wiFlight = { result };
  const download = el('button', '', 'Download JSON');
  download.id = 'flight-download';
  download.type = 'button';
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    // The user names the GPU when sending it (spec §9.5).
    a.download = `flight-${/firefox/i.test(navigator.userAgent) ? 'firefox' : /chrome/i.test(navigator.userAgent) ? 'chrome' : 'browser'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  panel.append(download);
}

/**
 * The flight (spec §9.5): the idle frames, then 60 s along the spline with the day from 06:00 through one cycle, then
 * the JSON published. The camera faces along the tangent (its yaw) with `cameraPitch`, and keeps `CLEARANCE` blocks
 * above `MOTION_BLOCKING` where the spline dips between two waypoints, so the measured frames look at the world.
 */
export async function runFlight(ctx: FlightContext): Promise<FlightResult | FlightError> {
  const panel = flightPanel(ctx.host);
  let result: FlightResult | FlightError;
  try {
    // 1. The display interval: the median of 120 idle rAF deltas, the first from the reveal frame.
    const idle: number[] = [];
    let prev = ctx.revealTs;
    await framesUntil((now) => {
      idle.push(now - prev);
      prev = now;
      return idle.length >= IDLE_FRAMES;
    });
    const interval = medianInterval(idle);

    // 2. The flight.
    const waypoints = flightWaypoints(ctx.centre, ctx.rd, (x, z) => ctx.motionBlockingAt(x, z), (x, z) => ctx.hasWater(x, z));
    panel.say(`flying for ${FLIGHT_MS / 1000} s (keep this tab in front)…`);
    const frames = series();
    const main = series();
    const calls = series();
    const triangles = series();
    const timer = ctx.world.gpuTimer();
    const gpu = timer === null ? null : series(1 << 12);
    timer?.poll();
    let start = Number.NaN;
    await framesUntil((now) => {
      const t0 = performance.now();
      if (ctx.lost()) throw new Error('the WebGL context was lost during the flight');
      if (Number.isNaN(start)) start = now;
      const u = (now - start) / FLIGHT_MS;
      if (u >= 1) return true;
      const p = catmullRom(waypoints, u);
      const g = ctx.motionBlockingAt(p.x, p.z);
      const y = Math.min(Y_MAX, Math.max(Y_MIN, Number.isFinite(g) ? Math.max(p.y, g + CLEARANCE) : p.y));
      ctx.render({ x: p.x, y, z: p.z, yaw: p.yaw, pitch: cameraPitch(p.pitch) }, u);
      main.push(performance.now() - t0);
      frames.push(now - prev);
      prev = now;
      const info = ctx.world.info();
      calls.push(info.calls);
      triangles.push(info.triangles);
      if (gpu !== null) {
        const ms = timer!.poll();
        if (ms !== null) gpu.push(ms);
      }
      return false;
    });

    // 3. The JSON.
    const r = ctx.report;
    result = summarizeFlight(frames.values(), main.values(), interval, {
      seed: ctx.seed,
      profile: ctx.profile,
      rd: ctx.rd,
      workers: ctx.workers,
      sectionRenderer: ctx.kind,
      userAgent: navigator.userAgent,
      renderer: r.renderer,
      vendor: r.vendor,
      multiDraw: r.multiDraw,
      timerQuery: r.timerQuery,
      screen: { width: screen.width, height: screen.height },
      dpr: devicePixelRatio,
      pixelRatio: ctx.world.renderer.getPixelRatio(),
      load: { ...ctx.loadStats, first120MaxMs: ctx.loadStats.first120MaxMs ?? maxOf(idle) },
      gpuMs: gpu === null ? null : gpu.values(),
      drawCalls: calls.values(),
      triangles: triangles.values(),
      heapMB: heapMB(),
      sabMB: ctx.sabMB(),
      durationMs: FLIGHT_MS,
      waypoints,
      waypointsAbove: waypoints.map((w) => w.y - ctx.motionBlockingAt(w.x, w.z)),
    });
    panel.say(`done: frame p95 ${result.frames.p95} ms, draw calls max ${result.drawCalls.max}, main p95 ${result.main.p95} ms`);
  } catch (e) {
    result = { route: 'flight=sp4a', error: e instanceof Error ? e.stack ?? e.message : String(e) };
    panel.say(`failed: ${result.error}`);
  }
  panel.publish(result);
  return result;
}

/** The route's query: the given `workers` and `renderer`, RD 12, no position (the spawn), no capture mode. */
export function flightQuery(query: URLSearchParams): WorldQuery {
  const q = parseWorldQuery(query);
  return { at: null, y: null, yaw: null, pitch: null, rd: FLIGHT_RD, workers: q.workers, renderer: q.renderer, shot: false, time: null };
}

/** The route's `#` hash: seed 42, the default profile, no patch. */
export function flightHash(): string {
  return `#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: FLIGHT_SEED, profile: FLIGHT_PROFILE, patch: {} })}`;
}

/**
 * Mounts `?flight=sp4a` in `root`: the world page with the flight hook. A load that fails shows the page's failure panel
 * and publishes `{ route, error }`, so measureChrome stops at once instead of polling for 15 minutes.
 */
export async function mountFlightRoute(root: HTMLElement, query: URLSearchParams): Promise<void> {
  let flown = false;
  const page = await mountWorldPage(root, flightQuery(query), flightHash(), {
    hud: false,
    overlay: false,
    flight: (ctx) => {
      flown = true;
      void runFlight(ctx);
    },
  });
  if (!flown) {
    const panel = el('div');
    panel.style.cssText = 'position:fixed;right:8px;top:8px;z-index:10';
    document.body.append(panel);
    publishFlight({ route: 'flight=sp4a', error: `the world did not load (page ${page.state})` }, panel);
  }
}

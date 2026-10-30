/**
 * The agents' Chrome cells of the GPU measurements (SP4a spec §1.2, §9.5; SP4b spec §8.3, §8.4, §8.7; SP4c spec §8.4,
 * §8.7; SP5b spec §6.2; not in CI): drives the spike page (`?spike=batch`), the flight route (`?flight=sp4a`), the
 * streaming bench (`?bench=medium`, with SP4c's live legs, SP5a's edit leg and SP5b's save leg) or the enter bench
 * (`?bench=enter`, `runEnter`) in our own headful Chrome on a hardware GPU, reads the page's JSON over CDP and writes it
 * into `docs/superpowers/specs/assets/sp5b/` (every route since SP5b; SP4a's-SP5a's files stay in `assets/sp4a/`,
 * `assets/sp4b/`, `assets/sp4c/` and `assets/sp5a/`). With `--shot` the bench freezes at a review shot's moment and the
 * tool saves a 1920 × 1080 PNG there instead (§8.7, amended while planning: the shots need the GPU). A page cannot write
 * files, which is why this tool exists; the Firefox cells are the user's, by hand (the enter bench's `&auto=1` form).
 *
 * Run it with `npm run measure:chrome -- --route spike|flight|bench|enter [--gpu iris|rtx] [--workers 4]
 * [--renderer batch|mesh] [--shot <name>] [--skip-build] [--probe-only]`. In order:
 * 1. it refuses without DISPLAY or WAYLAND_DISPLAY: headful only, since headless rAF is not tied to the display;
 * 2. it refuses when the 1-minute load average is above MEASURE_LOAD_MAX, printing `uptime` (a quiet machine);
 * 3. it reads the PRIME profile (`prime-select query`, never with an argument) and passes the GPU choice to Chrome as
 *    environment (`launchEnv`, ruling P6): nothing spawns prime-run; the RTX also gets ANGLE's Vulkan backend
 *    (`chromeArgs`, ruling P60); the flight and the bench run on a cold driver shader cache (`shaderCacheOf`, rulings
 *    R11), recorded as the JSON's `shaderCache`;
 * 4. it builds (unless --skip-build), starts its own `vite preview` on a free port (never 5183) and its own headful
 *    Chrome, fullscreen at 1920 × 1080 @ 1, with a fresh temporary profile and no SwiftShader flag;
 * 5. it probes the WebGL renderer and refuses unless it names the expected GPU (`gpuMatches`); it makes sure the window is
 *    fullscreen on the panel eDP-1 at (0, 0) (`placeWindow`, ruling P59) and refuses otherwise (`windowProblem`), then
 *    refuses unless the viewport is exactly 1920 × 1080 @ 1 (ruling P7); --probe-only stops here with exit 0;
 * 6. it records the page's console errors (ruling P8), navigates, and polls the route's result every second (15 min);
 *    every CDP call is bounded, and the poll fails fast when Chrome exits or the tab crashes (`pollResult`, `watchPage`);
 *    the enter route instead loads its setup page, six (a)/(b) pairs and its end page, each a fresh page load polled
 *    for its own result (`runEnter`), and summarises them (`enterSummary`);
 * 7. it adds who measured, the load averages, the Chrome version, the window (warning when it left eDP-1), the viewport
 *    and the console errors, writes the JSON pretty-printed and prints its path and summary (ruling P9); for a shot it
 *    polls `__wiBench.shotReady` instead, refuses unless the canvas's `data-renderer` is the `--renderer`, and writes
 *    `Page.captureScreenshot`'s PNG; both then warn on the same end-of-run checks (`endOfRunWarnings`: the load after,
 *    the window, the viewport, the console; final review GOV-8);
 * 8. it stops only its own Chrome and preview, then removes the profile.
 *
 * Tools run under plain Node (type stripping), so this file imports no `src/` module.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, freePort, ignoredLog, npmBuild, ROOT, running, sleep, startChrome, startPreview, stopStarted, type Cdp, type ChromeHandle } from './cdp.ts';

/** The tool refuses to start above this 1-minute load average (SP4a spec §9.5: a quiet machine). */
export const MEASURE_LOAD_MAX = 2;

/** The measured window (SP4a spec §1.2 item 2, §9.5). */
const SCREEN = { width: 1920, height: 1080, dpr: 1 } as const;
const POLL_MS = 1000;
const RESULT_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * The longest any one CDP call may take. A send on a closed socket never settles (Node's WebSocket.send returns
 * silently once CLOSED) and a crashed tab never answers Runtime.evaluate, so an unbounded await would hang the tool.
 */
const CDP_CALL_TIMEOUT_MS = 30_000;
/** How long the fullscreen window may take to reach its size before the viewport check refuses. */
const VIEWPORT_SETTLE_MS = 5000;
/** How many times `placeWindow` runs its normal → (0, 0) 1920 × 1080 → fullscreen sequence before the tool refuses. */
export const PLACE_ATTEMPTS = 3;
/** The window's reads while it settles (at start-up, and after each sequence): every WINDOW_POLL_MS, WINDOW_READS times. */
const WINDOW_POLL_MS = 250;
const WINDOW_READS = 8;
/** The pause between two steps of the sequence, so the window manager applies each one before the next. */
const WINDOW_STEP_MS = 300;
/**
 * Where every route writes (SP5b spec §6.2: SP5b's assets; SP4a's-SP5a's files stay in `assets/sp4a/`, `assets/sp4b/`,
 * `assets/sp4c/` and `assets/sp5a/`).
 */
export const ASSETS = 'docs/superpowers/specs/assets/sp5b';

/**
 * The bench's review shots (SP4b spec §8.7; SP4c spec §8.7's `apply-before`, `apply-mid`, `apply-after`, `teleport`;
 * SP5a spec §6.5's review scenes `build-day`, `build-night`, `walk-water`, `glass-water`), mirrored from
 * `src/ui/world/bench.ts`'s `BENCH_SHOTS` (a test pins them).
 */
export const SHOTS = [
  'fly96', 'fly384', 'rd12', 'rd8', 'rd12back', 'first', 'apply-before', 'apply-mid', 'apply-after', 'teleport',
  'build-day', 'build-night', 'walk-water', 'glass-water',
] as const;
export type Shot = (typeof SHOTS)[number];

export interface MeasureArgs {
  readonly route: 'spike' | 'flight' | 'bench' | 'enter';
  readonly gpu: 'iris' | 'rtx';
  readonly workers: 4 | null;
  readonly skipBuild: boolean;
  readonly renderer: 'batch' | 'mesh' | null;
  readonly probeOnly: boolean;
  /** A review shot of the bench (SP4b spec §8.7), or null for the JSON. */
  readonly shot: Shot | null;
}

/**
 * The command line. `--route` is required; `--gpu` defaults to the gate machine's Iris Xe (spec §9.5 writes it as
 * optional). `--workers` takes only 4 and only on the flight and bench routes, the cells with a `-w4` file name.
 * `--shot` belongs to the bench and needs `--renderer`, whose name the shot's file carries. The enter route measures
 * the probe's renderer, as `G1.enter` reads it, so it takes no `--renderer`.
 */
export function parseMeasureArgs(argv: readonly string[]): MeasureArgs {
  let route: MeasureArgs['route'] | null = null;
  let gpu: MeasureArgs['gpu'] = 'iris';
  let workers: MeasureArgs['workers'] = null;
  let skipBuild = false;
  let renderer: MeasureArgs['renderer'] = null;
  let probeOnly = false;
  let shot: MeasureArgs['shot'] = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--route') {
      const v = value();
      if (v !== 'spike' && v !== 'flight' && v !== 'bench' && v !== 'enter') throw new Error(`--route must be spike, flight, bench or enter, not ${v}`);
      route = v;
    } else if (a === '--gpu') {
      const v = value();
      if (v !== 'iris' && v !== 'rtx') throw new Error(`--gpu must be iris or rtx, not ${v}`);
      gpu = v;
    } else if (a === '--workers') {
      const v = value();
      if (v !== '4') throw new Error(`--workers takes only 4, not ${v}`);
      workers = 4;
    } else if (a === '--renderer') {
      const v = value();
      if (v !== 'batch' && v !== 'mesh') throw new Error(`--renderer must be batch or mesh, not ${v}`);
      renderer = v;
    } else if (a === '--shot') {
      const v = value();
      const known = SHOTS.find((s) => s === v);
      if (known === undefined) throw new Error(`--shot must be one of ${SHOTS.join(', ')}, not ${v}`);
      shot = known;
    } else if (a === '--skip-build') skipBuild = true;
    else if (a === '--probe-only') probeOnly = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (route === null) throw new Error('--route spike|flight|bench|enter is required');
  if (workers !== null && (route === 'spike' || route === 'enter')) throw new Error('--workers 4 applies to --route flight or bench only');
  if (shot !== null && route !== 'bench') throw new Error('--shot applies to --route bench only');
  if (shot !== null && renderer === null) throw new Error('--shot needs --renderer batch|mesh (the shot\'s file names the renderer)');
  if (renderer !== null && route === 'enter') throw new Error('--renderer does not apply to --route enter (the cell is the probe\'s renderer)');
  return { route, gpu, workers, skipBuild, renderer, probeOnly, shot };
}

/**
 * The output's file name (SP4a spec §1.2, §9.5; SP4b spec §8.3, §8.7; SP5b spec §6.2): `spike-chrome-<gpu>.json`,
 * `flight-<gpu>-chrome.json`, `bench-<gpu>-chrome.json`, `enter-<gpu>-chrome.json`, `-w4` for a 4-worker run. A forced
 * `--renderer` adds `-<renderer>`, so it never overwrites the cell the probe's renderer selected (G1 reads
 * `flight-iris-chrome.json` and `bench-iris-chrome.json`). A shot is `review-<shot>-<renderer>.png`.
 */
export function outputName(a: MeasureArgs): string {
  if (a.shot !== null) return `review-${a.shot}-${a.renderer ?? 'auto'}.png`;
  const base = a.route === 'spike' ? `spike-chrome-${a.gpu}` : `${a.route}-${a.gpu}-chrome`;
  return `${base}${a.workers === null ? '' : `-w${a.workers}`}${a.renderer === null ? '' : `-${a.renderer}`}.json`;
}

const ROUTE_QUERY: Readonly<Record<MeasureArgs['route'], string>> = { spike: 'spike=batch', flight: 'flight=sp4a', bench: 'bench=medium', enter: 'bench=enter' };

/**
 * The page path: `/?spike=batch`, `/?flight=sp4a`, `/?bench=medium` or `/?bench=enter` (the enter bench's setup page),
 * then `&workers=4`, `&renderer=` and `&shot=` when given.
 */
export function routePath(a: MeasureArgs): string {
  const q = [ROUTE_QUERY[a.route]];
  if (a.workers !== null) q.push(`workers=${a.workers}`);
  if (a.renderer !== null) q.push(`renderer=${a.renderer}`);
  if (a.shot !== null) q.push(`shot=${a.shot}`);
  return `/?${q.join('&')}`;
}

/** Does the WebGL renderer string name the expected GPU (Iris, or an NVIDIA RTX)? A software renderer never does. */
export function gpuMatches(gpu: 'iris' | 'rtx', renderer: string): boolean {
  if (/swiftshader|llvmpipe|softpipe/i.test(renderer)) return false;
  return gpu === 'iris' ? /\bIris\b/i.test(renderer) : /\bNVIDIA\b/i.test(renderer) && /\bRTX\b/i.test(renderer);
}

/** prime-run's variables: render this process on the NVIDIA GPU under PRIME render offload. */
const NV_OFFLOAD = { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' } as const;

/** Whether our Chrome's driver may use its on-disk shader cache ('warm') or starts with none ('cold'). */
export type ShaderCache = 'cold' | 'warm';

/**
 * The driver shader cache of a run (rulings R11): cold for the flight and the bench, its shots included, so a run
 * measures what a user meets on a first visit (a program first linked mid-flight stalls that frame); warm for SP4a's
 * spike, as it was measured.
 */
export function shaderCacheOf(a: MeasureArgs): ShaderCache {
  return a.route === 'spike' ? 'warm' : 'cold';
}

/**
 * The environment Chrome gets for the GPU (ruling P6, the spec's "under prime-run" without prime-run installed): none
 * for the Iris Xe; none for the RTX under the 'nvidia' profile (everything renders there); otherwise the offload
 * variables. Whether Chrome really landed on the GPU is checked afterwards by `gpuMatches`, the only gate. On a cold
 * shader cache (rulings R11) the driver's on-disk cache is off for our process only: Mesa's `MESA_SHADER_CACHE_DISABLE`
 * on the Iris Xe, NVIDIA's `__GL_SHADER_DISK_CACHE=0` (its GL and Vulkan both honour it) on the RTX; no user cache is
 * touched. Chrome's own program cache lives in the fresh profile, so it starts empty anyway.
 */
export function launchEnv(gpu: 'iris' | 'rtx', primeProfile: string | null, shaderCache: ShaderCache): Record<string, string> {
  const env: Record<string, string> = gpu === 'rtx' && primeProfile !== 'nvidia' ? { ...NV_OFFLOAD } : {};
  if (shaderCache === 'cold') {
    if (gpu === 'iris') env['MESA_SHADER_CACHE_DISABLE'] = 'true';
    else env['__GL_SHADER_DISK_CACHE'] = '0';
  }
  return env;
}

/**
 * ANGLE's Vulkan backend for the RTX (ruling P60). With the offload variables, ANGLE's default OpenGL backend on X11
 * fails `eglInitialize` ("Invalid visual ID requested") and Chrome has no WebGL2; ANGLE Vulkan renders on the RTX with
 * hardware compositing. `--use-angle=vulkan` alone gives no context: it needs the VulkanFromANGLE feature too. Chrome
 * keeps only the last `--enable-features`, so this list holds the only one.
 */
const RTX_ANGLE_VULKAN = ['--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE'] as const;

/**
 * The headful window's flags, added after startChrome's own (ruling P4; the `--user-data-dir` repeat is harmless and
 * keeps this list complete on its own). The environment carries the GPU choice (ruling P6); the RTX alone also gets
 * ANGLE's Vulkan backend (ruling P60), while the Iris Xe keeps ANGLE's default OpenGL backend.
 */
export function chromeArgs(a: MeasureArgs, profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--window-position=0,0',
    `--window-size=${SCREEN.width},${SCREEN.height}`,
    '--start-fullscreen',
    `--force-device-scale-factor=${SCREEN.dpr}`,
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--password-store=basic',
    ...(a.gpu === 'rtx' ? RTX_ANGLE_VULKAN : []),
  ];
}

/** Null for exactly 1920 × 1080 at dpr 1 (ruling P7), otherwise what is wrong. */
export function viewportProblem(v: { innerWidth: number; innerHeight: number; devicePixelRatio: number }): string | null {
  if (v.innerWidth === SCREEN.width && v.innerHeight === SCREEN.height && v.devicePixelRatio === SCREEN.dpr) return null;
  return `the viewport is ${v.innerWidth}x${v.innerHeight}@${v.devicePixelRatio}, not ${SCREEN.width}x${SCREEN.height}@${SCREEN.dpr}`;
}

/** `Browser.getWindowForTarget`'s bounds, also `Browser.setWindowBounds`'s argument (every field optional in CDP). */
export interface WindowBounds {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
  readonly windowState?: string;
}

/**
 * Null only for a fullscreen window at (0, 0), which is the panel eDP-1 (the primary output at +0+0; HDMI-1-0 sits at
 * +1920+0): the cells are measured there (ruling P59). Otherwise the bounds and the state. The viewport check alone
 * (ruling P7) cannot tell the panels apart: a window fullscreen on HDMI-1-0 is 1920 × 1080 @ 1 too, at 143.6 Hz.
 */
export function windowProblem(b: WindowBounds): string | null {
  if (b.left === 0 && b.top === 0 && b.windowState === 'fullscreen') return null;
  return `the window is ${b.windowState ?? 'unknown'} at ${b.left ?? '?'},${b.top ?? '?'} (${b.width ?? '?'}x${b.height ?? '?'}), not fullscreen at 0,0 on eDP-1`;
}

/**
 * Null when exactly one canvas names `expected` in `data-renderer` (the world renderer sets it, SP4b spec §8.6),
 * otherwise what is wrong: a shot's file names its `--renderer`, so the tool checks which section renderer drew it
 * rather than trusting the URL (final review GOV-8).
 */
export function drawnByProblem(expected: 'batch' | 'mesh', drawn: readonly string[]): string | null {
  if (drawn.length === 1 && drawn[0] === expected) return null;
  if (drawn.length === 0) return `no canvas has a data-renderer, so the shot cannot show it was drawn by ${expected}`;
  if (drawn.length > 1) return `${drawn.length} canvases have a data-renderer (${drawn.join(', ')}), not one`;
  return `the canvas's data-renderer is ${drawn[0]}, not ${expected}`;
}

/**
 * The end-of-run checks, the JSON cells' and the shots' alike (final review GOV-8): the load average after the run
 * above MEASURE_LOAD_MAX, the window no longer fullscreen on eDP-1, the viewport no longer 1920 × 1080 @ 1, and the
 * console's errors. Each is a warning: the output is written, and the warning says to rerun it.
 */
export function endOfRunWarnings(
  o: { readonly loadAvg1After: number; readonly window: WindowBounds; readonly viewport: Viewport; readonly consoleErrors: readonly string[] },
  what: 'cell' | 'shot',
): string[] {
  const out: string[] = [];
  if (o.loadAvg1After > MEASURE_LOAD_MAX) out.push(`the load average rose to ${o.loadAvg1After.toFixed(2)} during the run; rerun this ${what} on a quiet machine`);
  const movedAway = windowProblem(o.window);
  if (movedAway !== null) out.push(`at the end of the run ${movedAway}; rerun this ${what}`);
  const resized = viewportProblem(o.viewport);
  if (resized !== null) out.push(`at the end of the run ${resized}; rerun this ${what}`);
  if (o.consoleErrors.length > 0) out.push(`${o.consoleErrors.length} console error(s):\n${o.consoleErrors.join('\n')}`);
  return out;
}

/** The window as `placeWindow` sees it: CDP's Browser domain in the tool, a fake in the tests. */
export interface WindowControl {
  read(): Promise<WindowBounds>;
  set(bounds: WindowBounds): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Reads the window until `windowProblem` clears or WINDOW_READS more reads have passed; returns the last bounds. */
async function settledWindow(w: WindowControl, b: WindowBounds): Promise<WindowBounds> {
  for (let i = 0; i < WINDOW_READS && windowProblem(b) !== null; i++) {
    await w.sleep(WINDOW_POLL_MS);
    b = await w.read();
  }
  return b;
}

/**
 * Makes sure the window is fullscreen on eDP-1 (ruling P59). `--window-position=0,0` and `--start-fullscreen` are
 * hints the window manager may ignore: it has left the window maximized (inner height 958), opened it on HDMI-1-0
 * (maximized, 993; or fullscreen, which the viewport check accepts). A window already placed is left alone, since the
 * sequence itself can leave a placed window normal. Otherwise: normal, then (0, 0) at 1920 × 1080, then fullscreen,
 * re-read until settled, at most `attempts` times. Returns the last bounds and how many sequences ran; the caller
 * refuses on `windowProblem`.
 */
export async function placeWindow(w: WindowControl, attempts = PLACE_ATTEMPTS): Promise<{ bounds: WindowBounds; attempts: number }> {
  let b = await settledWindow(w, await w.read());
  let i = 0;
  for (; i < attempts && windowProblem(b) !== null; i++) {
    await w.set({ windowState: 'normal' });
    await w.sleep(WINDOW_STEP_MS);
    await w.set({ left: 0, top: 0, width: SCREEN.width, height: SCREEN.height });
    await w.sleep(WINDOW_STEP_MS);
    await w.set({ windowState: 'fullscreen' });
    b = await settledWindow(w, await w.read());
  }
  return { bounds: b, attempts: i };
}

/** A number at `path` in an unknown JSON value, or undefined. */
function numberAt(v: unknown, path: readonly string[]): number | undefined {
  let cur = v;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined;
}

/** The flight's one-line summary (ruling P9), read defensively: `n/a` where a field is missing. */
export function flightLine(r: unknown): string {
  const ms = (p: readonly string[]) => { const n = numberAt(r, p); return n === undefined ? 'n/a' : `${n} ms`; };
  const calls = numberAt(r, ['drawCalls', 'max']);
  return `frame p95 ${ms(['frames', 'p95'])}, draw calls max ${calls ?? 'n/a'}, main p95 ${ms(['main', 'p95'])}`;
}

/** The bench's one-line summary over its streaming legs (`stream`), read defensively: `n/a` where a field is missing. */
export function benchLine(r: unknown): string {
  const n = (p: readonly string[]) => numberAt(r, ['stream', ...p]) ?? 'n/a';
  const ms = (p: readonly string[]) => { const v = numberAt(r, ['stream', ...p]); return v === undefined ? 'n/a' : `${v} ms`; };
  return `stream frame p95 ${ms(['frames', 'p95'])}, over 33 ms ${n(['frames', 'over33'])}, draw calls max ${n(['drawCalls', 'max'])}, `
    + `main p95 ${ms(['main', 'p95'])}, GPU MB ${n(['gpuMB'])}, partial column frames ${n(['partialColumnFrames'])}`;
}

// ---------------------------------------------------------------- the enter route (SP5b spec §6.2, D28)

/**
 * The enter bench's figures and paths, mirrored from `src/ui/world/bench.ts` (`BENCH_DB`, `BENCH_RD`, `ENTER_PAIRS`,
 * `enterPaths`, `summarizeEnter`): tools cannot import `src/`, so `enterSummary` is a pinned mirror (ruling P19, after
 * `uiSmoke.ts`'s precedent), and `bench.test.ts` feeds both the same pairs and expects equal JSON and equal paths.
 */
const ENTER_DB = 'wi10-bench';
const ENTER_RD = 12;
/** The alternations, each a fresh page load of (a) and then (b); the first pair (the cold cache) is discarded. */
export const ENTER_PAIRS = 6;
/** The enter bench's end page: `wi10-bench` deleted. */
export const ENTER_END_PATH = '/?bench=enter&phase=end';
/** How long one page of the enter route (the setup, a world load, the end) may take to publish its result. */
const ENTER_PAGE_TIMEOUT_MS = 5 * 60 * 1000;

/** The setup page's `window.__wiEnter`: the saved world and the pose its state holds. */
export interface EnterSetup {
  readonly worldId: string;
  readonly pose: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly pitch: number };
}

/** A world load's `window.__wiEnterResult`, ms (the last three null on an unsaved load). */
export interface EnterResult {
  readonly revealMs: number | null;
  readonly idbOpenMs: number | null;
  readonly loadMs: number | null;
  readonly decodeMs: number | null;
}

/** One alternation: (a) the unsaved load, then (b) the saved one. */
export interface EnterPair {
  readonly unsaved: EnterResult;
  readonly saved: EnterResult;
}

/** The enter cell's JSON before the tool's own fields (`enter-<gpu>-chrome.json`). */
export interface EnterSummary {
  readonly route: 'bench=enter';
  readonly pairs: EnterPair[];
  readonly kept: number;
  readonly enterRatio: number | null;
  readonly medianUnsavedMs: number | null;
  readonly medianSavedMs: number | null;
  readonly idbOpenMs: number | null;
  readonly loadMs: number | null;
  readonly decodeMs: number | null;
  readonly newWorldRevealMs: number | null;
  readonly shaderCache: string;
  readonly gpu: string;
  readonly renderer: string | null;
}

/** (a) the same world opened unsaved at the saved pose and (b) the saved world in `wi10-bench`, both at RD 12 (§6.2). */
export function enterPaths(s: EnterSetup): { unsaved: string; saved: string } {
  const p = s.pose;
  return {
    unsaved: `/?at=${p.x},${p.z}&y=${p.y}&yaw=${p.yaw}&pitch=${p.pitch}&rd=${ENTER_RD}&enterBench=1`,
    saved: `/?world=${encodeURIComponent(s.worldId)}&rd=${ENTER_RD}&enterBench=1&db=${ENTER_DB}`,
  };
}

/** The median of `values`, or null for none (an even count: the mean of the middle two). */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

const finiteOf = (values: readonly (number | null)[]): number[] => values.filter((v): v is number => v !== null && Number.isFinite(v));

/**
 * The enter cell (§6.2): the medians over the pairs after the first (the cold cache), `enterRatio` = median (b) /
 * median (a) (`G1.enter`), and the kept (b) loads' medians of `idbOpenMs`, `loadMs` and `decodeMs` (recorded).
 */
export function enterSummary(
  pairs: readonly EnterPair[],
  o: { readonly gpu: string; readonly renderer: string | null; readonly shaderCache: string; readonly newWorldRevealMs: number | null },
): EnterSummary {
  const kept = pairs.slice(1);
  const medianUnsavedMs = medianOf(finiteOf(kept.map((p) => p.unsaved.revealMs)));
  const medianSavedMs = medianOf(finiteOf(kept.map((p) => p.saved.revealMs)));
  return {
    route: 'bench=enter',
    pairs: pairs.map((p) => ({ unsaved: { ...p.unsaved }, saved: { ...p.saved } })),
    kept: kept.length,
    enterRatio: medianUnsavedMs === null || medianSavedMs === null || medianUnsavedMs <= 0 ? null : medianSavedMs / medianUnsavedMs,
    medianUnsavedMs,
    medianSavedMs,
    idbOpenMs: medianOf(finiteOf(kept.map((p) => p.saved.idbOpenMs))),
    loadMs: medianOf(finiteOf(kept.map((p) => p.saved.loadMs))),
    decodeMs: medianOf(finiteOf(kept.map((p) => p.saved.decodeMs))),
    newWorldRevealMs: o.newWorldRevealMs,
    shaderCache: o.shaderCache,
    gpu: o.gpu,
    renderer: o.renderer,
  };
}

/** The enter cell's one-line summary (ruling P9). */
export function enterLine(r: EnterSummary): string {
  const ms = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(1)} ms`);
  return `enterRatio ${r.enterRatio === null ? 'n/a' : r.enterRatio.toFixed(3)}, median (a) ${ms(r.medianUnsavedMs)}, median (b) ${ms(r.medianSavedMs)}, `
    + `(b) idbOpen ${ms(r.idbOpenMs)}, load ${ms(r.loadMs)}, decode ${ms(r.decodeMs)}`;
}

// ---------------------------------------------------------------- the page side

/** The unmasked WebGL renderer string of a fresh webgl2 context (spec §9.5's GPU check). */
const PROBE_RENDERER = `(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl === null) return 'no webgl2 context';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL));
})()`;
const READ_VIEWPORT = '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio })';
const RESULT_GLOBAL: Readonly<Record<Exclude<MeasureArgs['route'], 'enter'>, string>> = { spike: '__wiSpike', flight: '__wiFlight', bench: '__wiBench' };
const readResult = (a: MeasureArgs & { route: Exclude<MeasureArgs['route'], 'enter'> }) => `(() => {
  const r = window.${RESULT_GLOBAL[a.route]}?.result;
  return r === undefined || r === null ? null : JSON.stringify(r);
})()`;
/** A shot's state: 'ready' once `__wiBench.shotReady`, the route's `{ error }` as JSON, or null while it runs. */
const READ_SHOT = `(() => {
  const b = window.__wiBench;
  if (b === undefined) return null;
  if (b.result !== null && b.result !== undefined && 'error' in b.result) return JSON.stringify({ error: b.result.error });
  return b.shotReady === true ? 'ready' : null;
})()`;

/** A page global as JSON, or null while the page has not set it. */
const READ_GLOBAL = (name: string) => `(() => {
  const r = window.${name};
  return r === undefined || r === null ? null : JSON.stringify(r);
})()`;

/** The world canvas's `data-renderer` values (one canvas expected), as the UI smoke reads them. */
const DRAWN_BY = `[...document.querySelectorAll('canvas[data-renderer]')].map((c) => c.dataset.renderer)`;

type Viewport = { innerWidth: number; innerHeight: number; devicePixelRatio: number };

/** `p`, or a rejection naming `what` after `ms`; the timer is cleared either way, so it never holds the process. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** One CDP call, bounded by CDP_CALL_TIMEOUT_MS (cdp.ts's bodies stay as moved, ruling P4: the bound lives here). */
const call = (cdp: Cdp, method: string, params: Record<string, unknown> = {}) => withTimeout(cdp.send(method, params), CDP_CALL_TIMEOUT_MS, method);

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await call(cdp, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
  if (ex !== undefined) throw new Error(`page error: ${ex.exception?.description ?? ex.text ?? 'unknown'}`);
  return (r['result'] as { value?: unknown }).value as T;
}

/** The viewport once the fullscreen window has reached 1920 × 1080 @ 1, or its last value after VIEWPORT_SETTLE_MS. */
async function settledViewport(cdp: Cdp): Promise<Viewport> {
  const t0 = Date.now();
  for (;;) {
    const v = await evaluate<Viewport>(cdp, READ_VIEWPORT);
    if (viewportProblem(v) === null || Date.now() - t0 >= VIEWPORT_SETTLE_MS) return v;
    await sleep(250);
  }
}

/** The page's window through the browser target's Browser domain (`getWindowForTarget`, `setWindowBounds`). */
function windowControl(browser: Cdp, targetId: string): WindowControl {
  const get = () => call(browser, 'Browser.getWindowForTarget', { targetId });
  return {
    read: async () => (await get())['bounds'] as WindowBounds,
    set: async (bounds) => { await call(browser, 'Browser.setWindowBounds', { windowId: (await get())['windowId'] as number, bounds: { ...bounds } }); },
    sleep,
  };
}

// ---------------------------------------------------------------- the poll

/** Whether the measured page can still answer, and a promise that rejects the moment it cannot. */
export interface PageWatch {
  /** Rejects with the reason once Chrome exits, the tab crashes or DevTools detaches; never resolves. */
  readonly lost: Promise<never>;
  /** Why the page can no longer answer, or null while it can. */
  dead(): string | null;
}

/**
 * Watches our Chrome and its page target: the process's exit, `Inspector.targetCrashed` (an out-of-memory tab, for
 * example) and `Inspector.detached` (the target closed). The caller enables the Inspector domain.
 */
export function watchPage(cdp: Pick<Cdp, 'on'>, proc: ChildProcess): PageWatch {
  let why: string | null = null;
  let reject: (e: Error) => void = () => undefined;
  const lost = new Promise<never>((_, r) => { reject = r; });
  lost.catch(() => undefined); // observed through dead() as well; never an unhandled rejection
  const mark = (reason: string) => {
    if (why !== null) return;
    why = reason;
    reject(new Error(reason));
  };
  cdp.on('Inspector.targetCrashed', () => mark('the page crashed (Inspector.targetCrashed)'));
  cdp.on('Inspector.detached', (e) => mark(`DevTools detached from the page (${String(e['reason'] ?? 'unknown')})`));
  proc.once('exit', (code: number | null, signal: string | null) => mark(`Chrome exited (${code ?? signal}) during the run`));
  return {
    lost,
    dead: () => why ?? (running(proc) ? null : `Chrome exited (${proc.exitCode ?? proc.signalCode}) during the run`),
  };
}

export interface ResultPoll {
  /** One read of the route's result: its JSON text, or null while the page has none yet. */
  read(): Promise<string | null>;
  /** Why the page can no longer answer (`PageWatch.dead`), or null. */
  dead(): string | null;
  readonly pollMs: number;
  /** The bound on each read. */
  readonly callTimeoutMs: number;
  /** The overall bound (brief step 7: 15 min). */
  readonly timeoutMs: number;
}

const durationText = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms} ms`);

/**
 * Polls `read` every `pollMs` until it returns a result. Each read is bounded, so the overall timeout is always
 * reached; a dead page fails at once; a read error (a page exception, a timeout) is kept and named in the timeout.
 */
export async function pollResult(o: ResultPoll): Promise<string> {
  const t0 = Date.now();
  let lastError: string | null = null;
  for (;;) {
    const why = o.dead();
    if (why !== null) throw new Error(`no result: ${why}${lastError === null ? '' : `; last read error: ${lastError}`}`);
    if (Date.now() - t0 > o.timeoutMs) {
      throw new Error(`no result within ${durationText(o.timeoutMs)}${lastError === null ? '' : `; last read error: ${lastError}`}`);
    }
    await sleep(o.pollMs);
    try {
      const text = await withTimeout(o.read(), o.callTimeoutMs, 'Runtime.evaluate');
      if (text !== null) return text;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
}

/**
 * The enter route's pages (SP5b spec §6.2), each a fresh page load polled for its own global: the setup page
 * (`__wiEnter`: the saved world and its pose), six alternations of (a) and (b) (`__wiEnterResult`), then the end page
 * (`wi10-bench` deleted). The new world from the start screen is Task 20's leg: until the worlds menu exists it is
 * skipped, `newWorldRevealMs` null. A page's `{ error }` stops the run.
 */
async function runEnter(o: { readonly cdp: Cdp; readonly base: string; readonly setupPath: string; readonly watch: PageWatch }): Promise<{ pairs: EnterPair[]; newWorldRevealMs: number | null }> {
  const page = async <T>(path: string, global: '__wiEnter' | '__wiEnterResult'): Promise<T> => {
    // The previous document's value never answers for the next one.
    await evaluate(o.cdp, `delete window.${global}; true`);
    const url = new URL(path, o.base).href;
    console.log(`navigating to ${url}`);
    await call(o.cdp, 'Page.navigate', { url });
    const text = await pollResult({
      read: () => Promise.race([evaluate<string | null>(o.cdp, READ_GLOBAL(global)), o.watch.lost]),
      dead: o.watch.dead,
      pollMs: POLL_MS,
      callTimeoutMs: CDP_CALL_TIMEOUT_MS,
      timeoutMs: ENTER_PAGE_TIMEOUT_MS,
    });
    const v = JSON.parse(text) as Record<string, unknown>;
    if ('error' in v) throw new Error(`${path}: ${String(v['error'])}`);
    return v as T;
  };
  const setup = await page<EnterSetup>(o.setupPath, '__wiEnter');
  console.log(`saved world ${setup.worldId} at ${setup.pose.x}, ${setup.pose.y}, ${setup.pose.z} (yaw ${setup.pose.yaw}, pitch ${setup.pose.pitch})`);
  const paths = enterPaths(setup);
  const pairs: EnterPair[] = [];
  for (let i = 0; i < ENTER_PAIRS; i++) {
    const unsaved = await page<EnterResult>(paths.unsaved, '__wiEnterResult');
    const saved = await page<EnterResult>(paths.saved, '__wiEnterResult');
    pairs.push({ unsaved, saved });
    console.log(`pair ${i + 1}/${ENTER_PAIRS}: (a) ${unsaved.revealMs} ms, (b) ${saved.revealMs} ms${i === 0 ? ' (discarded: the cold cache)' : ''}`);
  }
  console.log('the new world from the start screen: skipped until the worlds menu exists (Task 20); newWorldRevealMs null');
  await page<{ ended: true }>(ENTER_END_PATH, '__wiEnter');
  return { pairs, newWorldRevealMs: null };
}

// ---------------------------------------------------------------- the machine

/** `prime-select query`, trimmed, or null when the command is missing or fails. Never run with an argument. */
function primeProfile(): string | null {
  try {
    const out = execFileSync('prime-select', ['query'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

function uptimeText(): string {
  try {
    return execFileSync('uptime', [], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return `load average ${loadavg().map((n) => n.toFixed(2)).join(', ')}`;
  }
}

// ---------------------------------------------------------------- main

async function main(argv: readonly string[]): Promise<number> {
  const a = parseMeasureArgs(argv);
  if ((process.env['DISPLAY'] ?? '') === '' && (process.env['WAYLAND_DISPLAY'] ?? '') === '') {
    console.error('refused: no DISPLAY or WAYLAND_DISPLAY; the cells run headful, since headless rAF is not tied to the display');
    return 2;
  }
  const loadAvg1Before = loadavg()[0]!;
  if (loadAvg1Before > MEASURE_LOAD_MAX) {
    console.error(`refused: the 1-minute load average ${loadAvg1Before.toFixed(2)} is above ${MEASURE_LOAD_MAX}; keep the machine quiet\n${uptimeText()}`);
    return 2;
  }
  const prime = primeProfile();
  const shaderCache = shaderCacheOf(a);
  const env = launchEnv(a.gpu, prime, shaderCache);

  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  let browserCdp: Cdp | null = null;
  let profile: string | null = null;
  const consoleErrors: string[] = [];
  const cleanup = async () => {
    cdp?.close();
    browserCdp?.close();
    if (chrome !== null && running(chrome.proc)) {
      try {
        const browser = await connect(chrome.wsUrl);
        await Promise.race([browser.send('Browser.close'), sleep(3000)]).catch(() => undefined);
        browser.close();
      } catch { /* the stop below still ends it */ }
      if (running(chrome.proc)) await Promise.race([new Promise<void>((r) => chrome!.proc.once('exit', () => r())), sleep(5000)]);
    }
    await stopStarted();
    if (profile !== null) rmSync(profile, { recursive: true, force: true });
  };
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (!a.skipBuild) await npmBuild();
    const server = await startPreview(await freePort());
    console.log(`vite preview (pid ${server.proc.pid}) on ${server.url}`);
    profile = mkdtempSync(join(tmpdir(), 'wi10-measure-chrome-'));
    chrome = await startChrome({ headless: false, profileDir: profile, args: chromeArgs(a, profile), env });
    const envText = Object.keys(env).length === 0 ? 'no extra environment' : Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`headful Chrome (pid ${chrome.proc.pid}) with DevTools on port ${chrome.port}, profile ${profile}, PRIME ${prime ?? 'unknown'}, ${shaderCache} shader cache, ${envText}`);
    const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json() as { Browser?: string };
    const chromeVersion = version.Browser ?? 'unknown';
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as Array<{ type: string; id: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.type === 'page');
    if (target === undefined) throw new Error('Chrome has no page target');
    cdp = await connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', (e) => {
      const d = e['exceptionDetails'] as { text?: string; exception?: { description?: string } };
      consoleErrors.push(`exception: ${d.exception?.description ?? d.text ?? ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', (e) => {
      if (e['type'] !== 'error') return;
      consoleErrors.push(`console.error: ${(e['args'] as Array<{ value?: unknown; description?: string }>).map((x) => String(x.value ?? x.description)).join(' ')}`);
    });
    cdp.on('Log.entryAdded', (e) => {
      const entry = e['entry'] as { level: string; text: string; url?: string };
      if (entry.level !== 'error' || ignoredLog(entry.text, entry.url)) return;
      consoleErrors.push(`log: ${entry.text}${entry.url === undefined ? '' : ` (${entry.url})`}`);
    });
    const watch = watchPage(cdp, chrome.proc);
    await call(cdp, 'Runtime.enable');
    await call(cdp, 'Log.enable');
    await call(cdp, 'Inspector.enable');

    const renderer = await evaluate<string>(cdp, PROBE_RENDERER);
    console.log(`renderer: ${renderer}`);
    if (!gpuMatches(a.gpu, renderer)) {
      console.error(`refused: the renderer does not name the ${a.gpu === 'iris' ? 'Iris Xe' : 'NVIDIA RTX'}; PRIME profile: ${prime ?? 'unknown'}`);
      if (a.gpu === 'iris' && prime === 'nvidia') {
        console.error('the Iris Xe needs the PRIME profile on-demand (sudo prime-select on-demand, then log out and in); the user switches it');
      }
      return 1;
    }
    browserCdp = await connect(chrome.wsUrl);
    const win = windowControl(browserCdp, target.id);
    const { bounds: placed, attempts } = await placeWindow(win);
    const how = attempts === 0 ? 'as opened' : `after ${attempts} placement attempt${attempts === 1 ? '' : 's'}`;
    console.log(`window: ${placed.windowState ?? 'unknown'} at ${placed.left ?? '?'},${placed.top ?? '?'} ${placed.width ?? '?'}x${placed.height ?? '?'}, ${how}`);
    const misplaced = windowProblem(placed);
    if (misplaced !== null) {
      console.error(`refused: ${misplaced}, ${how}`);
      return 1;
    }
    const vp = await settledViewport(cdp);
    console.log(`viewport: ${vp.innerWidth}x${vp.innerHeight}@${vp.devicePixelRatio}`);
    const problem = viewportProblem(vp);
    if (problem !== null) {
      console.error(`refused: ${problem}`);
      return 1;
    }
    if (a.probeOnly) return 0;

    if (a.route === 'enter') {
      // A world page's leave guard asks only after a user gesture, which CDP never gives; any dialog is accepted anyway.
      const pageCdp = cdp;
      pageCdp.on('Page.javascriptDialogOpening', () => { void call(pageCdp, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined); });
      await call(cdp, 'Page.enable');
      const run = await runEnter({ cdp, base: server.url, setupPath: routePath(a), watch }).catch((e: unknown) => {
        throw new Error(`${e instanceof Error ? e.message : String(e)}${consoleErrors.length === 0 ? '' : `; console errors:\n${consoleErrors.join('\n')}`}`);
      });
      const loadAvg1After = loadavg()[0]!;
      const viewport = await evaluate<Viewport>(cdp, READ_VIEWPORT);
      const windowBounds = await win.read();
      const result = {
        ...enterSummary(run.pairs, { gpu: a.gpu, renderer, shaderCache, newWorldRevealMs: run.newWorldRevealMs }),
        measuredBy: 'measureChrome', loadAvg1Before, loadAvg1After, chromeVersion, window: windowBounds, viewport, consoleErrors: [...consoleErrors],
      };
      const file = join(ROOT, ASSETS, outputName(a));
      mkdirSync(join(ROOT, ASSETS), { recursive: true });
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`wrote ${file}`);
      console.log(enterLine(result));
      for (const w of endOfRunWarnings({ loadAvg1After, window: windowBounds, viewport, consoleErrors }, 'cell')) console.warn(`WARNING: ${w}`);
      return 0;
    }
    const route = a.route;
    const url = new URL(routePath(a), server.url).href;
    console.log(`navigating to ${url}`);
    await call(cdp, 'Page.navigate', { url });
    const page = cdp;
    const file = join(ROOT, ASSETS, outputName(a));
    if (a.shot !== null) {
      // The review shot (SP4b spec §8.7): the bench froze at the shot's moment and stopped its loop, so the canvas holds it.
      const state = await pollResult({
        read: () => Promise.race([evaluate<string | null>(page, READ_SHOT), watch.lost]),
        dead: watch.dead,
        pollMs: POLL_MS,
        callTimeoutMs: CDP_CALL_TIMEOUT_MS,
        timeoutMs: RESULT_TIMEOUT_MS,
      });
      if (state !== 'ready') throw new Error(`the bench failed before the shot: ${state}`);
      // The renderer that drew, not only the one the URL asked for (parseMeasureArgs makes --renderer non-null here).
      const wrongRenderer = drawnByProblem(a.renderer!, await evaluate<string[]>(cdp, DRAWN_BY));
      if (wrongRenderer !== null) {
        console.error(`refused: ${wrongRenderer}; no shot written`);
        return 1;
      }
      const shot = await call(cdp, 'Page.captureScreenshot', { format: 'png' });
      mkdirSync(join(ROOT, ASSETS), { recursive: true });
      writeFileSync(file, Buffer.from(String(shot['data']), 'base64'));
      console.log(`wrote ${file}`);
      const warnings = endOfRunWarnings({
        loadAvg1After: loadavg()[0]!, window: await win.read(), viewport: await evaluate<Viewport>(cdp, READ_VIEWPORT), consoleErrors,
      }, 'shot');
      for (const w of warnings) console.warn(`WARNING: ${w}`);
      return 0;
    }
    const text = await pollResult({
      read: () => Promise.race([evaluate<string | null>(page, readResult({ ...a, route })), watch.lost]),
      dead: watch.dead,
      pollMs: POLL_MS,
      callTimeoutMs: CDP_CALL_TIMEOUT_MS,
      timeoutMs: RESULT_TIMEOUT_MS,
    }).catch((e: unknown) => {
      throw new Error(`${e instanceof Error ? e.message : String(e)}${consoleErrors.length === 0 ? '' : `; console errors:\n${consoleErrors.join('\n')}`}`);
    });
    const loadAvg1After = loadavg()[0]!;
    const viewport = await evaluate<Viewport>(cdp, READ_VIEWPORT);
    const windowBounds = await win.read();
    const result: Record<string, unknown> = {
      ...(JSON.parse(text) as Record<string, unknown>),
      measuredBy: 'measureChrome', loadAvg1Before, loadAvg1After, chromeVersion, shaderCache, window: windowBounds, viewport,
      consoleErrors: [...consoleErrors],
    };
    mkdirSync(join(ROOT, ASSETS), { recursive: true });
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${file}`);
    if (a.route === 'spike') console.log(`verdict: ${JSON.stringify(result['verdict'] ?? null)}`);
    else if (a.route === 'bench') console.log(benchLine(result));
    else console.log(flightLine(result));
    for (const w of endOfRunWarnings({ loadAvg1After, window: windowBounds, viewport, consoleErrors }, 'cell')) console.warn(`WARNING: ${w}`);
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}

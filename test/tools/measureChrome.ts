/**
 * The agents' Chrome cells of SP4a's GPU measurements (SP4a spec §1.2, §9.5; not in CI): drives the spike page
 * (`?spike=batch`) or the flight route (`?flight=sp4a`) in our own headful Chrome on a hardware GPU, reads the page's
 * JSON over CDP and writes it into `docs/superpowers/specs/assets/sp4a/`. A page cannot write files, which is why this
 * tool exists; the Firefox cells are the user's, by hand.
 *
 * Run it with `npm run measure:chrome -- --route spike|flight [--gpu iris|rtx] [--workers 4] [--renderer batch|mesh]
 * [--skip-build] [--probe-only]`. In order:
 * 1. it refuses without DISPLAY or WAYLAND_DISPLAY: headful only, since headless rAF is not tied to the display;
 * 2. it refuses when the 1-minute load average is above MEASURE_LOAD_MAX, printing `uptime` (a quiet machine);
 * 3. it reads the PRIME profile (`prime-select query`, never with an argument) and passes the GPU choice to Chrome as
 *    environment (`launchEnv`, ruling P6): nothing spawns prime-run;
 * 4. it builds (unless --skip-build), starts its own `vite preview` on a free port (never 5183) and its own headful
 *    Chrome, fullscreen at 1920 × 1080 @ 1, with a fresh temporary profile and no SwiftShader flag;
 * 5. it probes the WebGL renderer and refuses unless it names the expected GPU (`gpuMatches`), then refuses unless the
 *    viewport is exactly 1920 × 1080 @ 1 (ruling P7); --probe-only stops here with exit 0;
 * 6. it records the page's console errors (ruling P8), navigates, and polls the route's result every second (15 min);
 * 7. it adds who measured, the load averages, the Chrome version, the viewport and the console errors, writes the
 *    JSON pretty-printed and prints its path and summary (ruling P9);
 * 8. it stops only its own Chrome and preview, then removes the profile.
 *
 * Tools run under plain Node (type stripping), so this file imports no `src/` module.
 */
import { execFileSync } from 'node:child_process';
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
/** How long the fullscreen window may take to reach its size before the viewport check refuses. */
const VIEWPORT_SETTLE_MS = 5000;
const ASSETS = 'docs/superpowers/specs/assets/sp4a';

export interface MeasureArgs {
  readonly route: 'spike' | 'flight';
  readonly gpu: 'iris' | 'rtx';
  readonly workers: 4 | null;
  readonly skipBuild: boolean;
  readonly renderer: 'batch' | 'mesh' | null;
  readonly probeOnly: boolean;
}

/**
 * The command line. `--route` is required; `--gpu` defaults to the gate machine's Iris Xe (spec §9.5 writes it as
 * optional). `--workers` takes only 4 and only on the flight route, the one cell with a `-w4` file name.
 */
export function parseMeasureArgs(argv: readonly string[]): MeasureArgs {
  let route: MeasureArgs['route'] | null = null;
  let gpu: MeasureArgs['gpu'] = 'iris';
  let workers: MeasureArgs['workers'] = null;
  let skipBuild = false;
  let renderer: MeasureArgs['renderer'] = null;
  let probeOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--route') {
      const v = value();
      if (v !== 'spike' && v !== 'flight') throw new Error(`--route must be spike or flight, not ${v}`);
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
    } else if (a === '--skip-build') skipBuild = true;
    else if (a === '--probe-only') probeOnly = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (route === null) throw new Error('--route spike|flight is required');
  if (workers !== null && route !== 'flight') throw new Error('--workers 4 applies to --route flight only');
  return { route, gpu, workers, skipBuild, renderer, probeOnly };
}

/**
 * The JSON's file name (spec §1.2, §9.5): `spike-chrome-<gpu>.json`, `flight-<gpu>-chrome.json`, `-w4` for the 4-worker
 * flight. A forced `--renderer` adds `-<renderer>`, so it never overwrites the cell the probe's renderer selected
 * (G1 reads `flight-iris-chrome.json`).
 */
export function outputName(a: MeasureArgs): string {
  const base = a.route === 'spike' ? `spike-chrome-${a.gpu}` : `flight-${a.gpu}-chrome`;
  return `${base}${a.workers === null ? '' : `-w${a.workers}`}${a.renderer === null ? '' : `-${a.renderer}`}.json`;
}

/** The page path: `/?spike=batch` or `/?flight=sp4a`, then `&workers=4` and `&renderer=` when given. */
export function routePath(a: MeasureArgs): string {
  const q = [a.route === 'spike' ? 'spike=batch' : 'flight=sp4a'];
  if (a.workers !== null) q.push(`workers=${a.workers}`);
  if (a.renderer !== null) q.push(`renderer=${a.renderer}`);
  return `/?${q.join('&')}`;
}

/** Does the WebGL renderer string name the expected GPU (Iris, or an NVIDIA RTX)? A software renderer never does. */
export function gpuMatches(gpu: 'iris' | 'rtx', renderer: string): boolean {
  if (/swiftshader|llvmpipe|softpipe/i.test(renderer)) return false;
  return gpu === 'iris' ? /\bIris\b/i.test(renderer) : /\bNVIDIA\b/i.test(renderer) && /\bRTX\b/i.test(renderer);
}

/** prime-run's variables: render this process on the NVIDIA GPU under PRIME render offload. */
const NV_OFFLOAD = { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' } as const;

/**
 * The environment Chrome gets for the GPU (ruling P6, the spec's "under prime-run" without prime-run installed): none
 * for the Iris Xe; none for the RTX under the 'nvidia' profile (everything renders there); otherwise the offload
 * variables. Whether Chrome really landed on the GPU is checked afterwards by `gpuMatches`, the only gate.
 */
export function launchEnv(gpu: 'iris' | 'rtx', primeProfile: string | null): Record<string, string> {
  return gpu === 'rtx' && primeProfile !== 'nvidia' ? { ...NV_OFFLOAD } : {};
}

/**
 * The headful window's flags, added after startChrome's own (ruling P4; the `--user-data-dir` repeat is harmless and
 * keeps this list complete on its own). No flag depends on the GPU: the environment carries that choice (ruling P6).
 */
export function chromeArgs(a: MeasureArgs, profileDir: string): string[] {
  void a;
  return [
    `--user-data-dir=${profileDir}`,
    '--window-position=0,0',
    `--window-size=${SCREEN.width},${SCREEN.height}`,
    '--start-fullscreen',
    `--force-device-scale-factor=${SCREEN.dpr}`,
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--password-store=basic',
  ];
}

/** Null for exactly 1920 × 1080 at dpr 1 (ruling P7), otherwise what is wrong. */
export function viewportProblem(v: { innerWidth: number; innerHeight: number; devicePixelRatio: number }): string | null {
  if (v.innerWidth === SCREEN.width && v.innerHeight === SCREEN.height && v.devicePixelRatio === SCREEN.dpr) return null;
  return `the viewport is ${v.innerWidth}x${v.innerHeight}@${v.devicePixelRatio}, not ${SCREEN.width}x${SCREEN.height}@${SCREEN.dpr}`;
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

// ---------------------------------------------------------------- the page side

/** The unmasked WebGL renderer string of a fresh webgl2 context (spec §9.5's GPU check). */
const PROBE_RENDERER = `(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl === null) return 'no webgl2 context';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL));
})()`;
const READ_VIEWPORT = '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio })';
const readResult = (a: MeasureArgs) => `(() => {
  const r = window.${a.route === 'spike' ? '__wiSpike' : '__wiFlight'}?.result;
  return r === undefined || r === null ? null : JSON.stringify(r);
})()`;

type Viewport = { innerWidth: number; innerHeight: number; devicePixelRatio: number };

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  const env = launchEnv(a.gpu, prime);

  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  let profile: string | null = null;
  const consoleErrors: string[] = [];
  const cleanup = async () => {
    cdp?.close();
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
    console.log(`headful Chrome (pid ${chrome.proc.pid}) with DevTools on port ${chrome.port}, profile ${profile}, PRIME ${prime ?? 'unknown'}, ${envText}`);
    const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json() as { Browser?: string };
    const chromeVersion = version.Browser ?? 'unknown';
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
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
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const renderer = await evaluate<string>(cdp, PROBE_RENDERER);
    console.log(`renderer: ${renderer}`);
    if (!gpuMatches(a.gpu, renderer)) {
      console.error(`refused: the renderer does not name the ${a.gpu === 'iris' ? 'Iris Xe' : 'NVIDIA RTX'}; PRIME profile: ${prime ?? 'unknown'}`);
      if (a.gpu === 'iris' && prime === 'nvidia') {
        console.error('the Iris Xe needs the PRIME profile on-demand (sudo prime-select on-demand, then log out and in); the user switches it');
      }
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

    const url = new URL(routePath(a), server.url).href;
    console.log(`navigating to ${url}`);
    await cdp.send('Page.navigate', { url });
    const t0 = Date.now();
    let text: string | null = null;
    while (text === null) {
      if (Date.now() - t0 > RESULT_TIMEOUT_MS) {
        throw new Error(`no result within ${RESULT_TIMEOUT_MS / 60000} min${consoleErrors.length === 0 ? '' : `; console errors:\n${consoleErrors.join('\n')}`}`);
      }
      await sleep(POLL_MS);
      text = await evaluate<string | null>(cdp, readResult(a)).catch(() => null);
    }
    const loadAvg1After = loadavg()[0]!;
    const viewport = await evaluate<Viewport>(cdp, READ_VIEWPORT);
    const result: Record<string, unknown> = {
      ...(JSON.parse(text) as Record<string, unknown>),
      measuredBy: 'measureChrome', loadAvg1Before, loadAvg1After, chromeVersion, viewport, consoleErrors: [...consoleErrors],
    };
    const file = join(ROOT, ASSETS, outputName(a));
    mkdirSync(join(ROOT, ASSETS), { recursive: true });
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${file}`);
    if (a.route === 'spike') console.log(`verdict: ${JSON.stringify(result['verdict'] ?? null)}`);
    else console.log(flightLine(result));
    if (loadAvg1After > MEASURE_LOAD_MAX) console.warn(`WARNING: the load average rose to ${loadAvg1After.toFixed(2)} during the run; rerun this cell on a quiet machine`);
    if (consoleErrors.length > 0) console.warn(`WARNING: ${consoleErrors.length} console error(s):\n${consoleErrors.join('\n')}`);
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

/**
 * The loading screen's panoramas (SP4a spec §8.3, D22; rulings P4, P54; not in CI): opens SP4a's own renderer at six
 * viewpoints in our own headless Chrome and writes `public/panoramas/<id>.webp` and `public/panoramas/manifest.json`,
 * which the loading and start screens read (`src/ui/loading/panoramas.ts`). Rerun it when the look changes.
 *
 * Run it with `npm run assets:panoramas [-- --gpu] [-- --skip-build]`. In order:
 * 1. it builds (unless --skip-build), starts its own `vite preview` on a free port (never 5183) and its own headless
 *    Chrome with a fresh temporary profile, rendering through SwiftShader (deterministic) or, with --gpu, the system GPU;
 * 2. it prints the probed WebGL renderer and refuses when there is no WebGL2 context;
 * 3. for each `PANORAMAS` entry it opens `/?pano=<id>` at 1920 × 1080 @ 1 and waits for `window.__wiPano.ready` (the
 *    route sets it three frames after the reveal, `src/ui/world/panoramaRoute.ts`); a page error or a load failure
 *    stops the run;
 * 4. it captures the page as WebP at quality 80, lowering it in steps of 5 until the file fits MAX_BYTES;
 * 5. it writes the images and the manifest (`manifestEntry`: the commit's short SHA and the renderer);
 * 6. it stops only its own Chrome and preview, then removes the profile.
 *
 * Tools run under plain Node (type stripping), so this file imports no `src/` module: the table is mirrored by the
 * route's, and test/unit/panoramas.test.ts checks both against their sources.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, freePort, ignoredLog, npmBuild, ROOT, running, sleep, startChrome, startPreview, stopStarted, type Cdp, type ChromeHandle } from './cdp.ts';

/** One viewpoint (spec §8.3): x and z in blocks (ruling P54), the yaw in degrees (ruling P42), the hour 8 or 17. */
export interface PanoramaSpec {
  readonly id: string;
  readonly seed: string;
  readonly profile: string;
  readonly x: number;
  readonly z: number;
  readonly yawDeg: number;
  readonly time: 8 | 17;
}

/**
 * The six viewpoints (spec §8.3; ruling P54), each seen from 32 blocks above `MOTION_BLOCKING` at pitch −10°:
 * - seed 42, default profile, at the coast, mountain and badlands review sites (`REVIEW_SITES`,
 *   test/harness/reviewSlices.ts): x = 16·cx0 + 8·w (the middle of the slice), z = the site's z;
 * - seed 42 at the archipelago, amplified and floating_islands golden windows' centres (`sp3eWindow`,
 *   src/metrics/sp3eGoldens.ts), in blocks as they are.
 * The yaws were picked from captures at 0°, 45° … 315° of each site (the most terrain in view, the sun behind or beside
 * the camera at its hour); the hours alternate 08:00 and 17:00.
 */
export const PANORAMAS: readonly PanoramaSpec[] = [
  { id: 'coast', seed: '42', profile: 'default', x: -26624, z: -31992, yawDeg: 135, time: 17 },
  { id: 'mountain', seed: '42', profile: 'default', x: -1152, z: 8, yawDeg: 225, time: 8 },
  { id: 'badlands', seed: '42', profile: 'default', x: -1248, z: 2056, yawDeg: 315, time: 17 },
  { id: 'archipelago', seed: '42', profile: 'archipelago', x: 128, z: -128, yawDeg: 90, time: 17 },
  { id: 'amplified', seed: '42', profile: 'amplified', x: -640, z: 0, yawDeg: 270, time: 8 },
  { id: 'floating_islands', seed: '42', profile: 'floating_islands', x: -768, z: -1408, yawDeg: 90, time: 17 },
];

/** Each image's size limit (spec D22). */
export const MAX_BYTES = 400 * 1024;
/** The WebP quality the capture starts at, and the step it lowers by until the image fits MAX_BYTES (spec §8.3). */
export const QUALITY = 80;
export const QUALITY_STEP = 5;
/** The captured viewport (spec D22). */
const SCREEN = { width: 1920, height: 1080, dpr: 1 } as const;
/** The route's pitch (spec §8.3), mirrored from panoramaRoute.ts for the manifest. */
const PITCH = -10;
const OUT_DIR = 'public/panoramas';
const POLL_MS = 500;
/** One panorama's load (generation, light and meshing of RD 12, then SwiftShader's frames) must finish within this. */
const READY_TIMEOUT_MS = 10 * 60 * 1000;
/** The longest any one CDP call may take (a crashed tab never answers). */
const CDP_CALL_TIMEOUT_MS = 60_000;

/** SwiftShader through ANGLE, deterministic on any machine (spec §8.3). */
export const SWIFTSHADER_ARGS: readonly string[] = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
/** The system GPU (--gpu): headless Chrome's GPU process with the blocklist ignored. */
export const GPU_ARGS: readonly string[] = ['--enable-gpu', '--ignore-gpu-blocklist'];

export interface PanoArgs {
  readonly gpu: boolean;
  readonly skipBuild: boolean;
}

export function parsePanoArgs(argv: readonly string[]): PanoArgs {
  let gpu = false;
  let skipBuild = false;
  for (const a of argv) {
    if (a === '--gpu') gpu = true;
    else if (a === '--skip-build') skipBuild = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return { gpu, skipBuild };
}

/** The image's file name under public/panoramas/. */
export function panoFile(id: string): string {
  return `${id}.webp`;
}

/** The qualities tried in order: 80, 75, … 5. */
export function qualitySteps(): number[] {
  const out: number[] = [];
  for (let q = QUALITY; q > 0; q -= QUALITY_STEP) out.push(q);
  return out;
}

/** One manifest entry, the shape `parseManifest` reads (src/ui/loading/panoramas.ts, spec §8.3). */
export interface PanoramaEntry {
  readonly id: string;
  readonly file: string;
  readonly seed: string;
  readonly profile: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly time: number;
  readonly commit: string;
  readonly renderer: string;
}

export function manifestEntry(p: PanoramaSpec, commit: string, renderer: string): PanoramaEntry {
  return { id: p.id, file: panoFile(p.id), seed: p.seed, profile: p.profile, x: p.x, z: p.z, yaw: p.yawDeg, pitch: PITCH, time: p.time, commit, renderer };
}

/**
 * Chrome's notice that it blocked a `?pano` page's `beforeunload` prompt when the tool navigated to the next one: the
 * world page arms its Ctrl+W guard after the reveal (spec §7.1), and the headless page never had a user gesture. It is
 * the guard working, not a page error (uiSmoke's `leaveGuardLog` for its own pages).
 */
export function panoLeaveGuardLog(text: string, url: string | undefined): boolean {
  if (!text.startsWith("Blocked attempt to show a 'beforeunload' confirmation panel") || url === undefined) return false;
  try {
    const u = new URL(url);
    return u.pathname === '/' && u.searchParams.has('pano');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the page side

/** The unmasked WebGL renderer string of a fresh webgl2 context, or 'no webgl2 context'. */
const PROBE_RENDERER = `(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl === null) return 'no webgl2 context';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL));
})()`;
const READ_PANO = '(() => { const p = window.__wiPano; return p === undefined ? null : JSON.stringify(p); })()';

/** `p`, or a rejection naming `what` after `ms`; the timer is cleared either way. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const call = (cdp: Cdp, method: string, params: Record<string, unknown> = {}) => withTimeout(cdp.send(method, params), CDP_CALL_TIMEOUT_MS, method);

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await call(cdp, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r['exceptionDetails'] as { text?: string } | undefined;
  if (ex !== undefined) throw new Error(`page evaluation failed: ${ex.text ?? 'unknown'}`);
  return (r['result'] as { value: T }).value;
}

/** The short SHA of HEAD (spec §8.3's manifest `commit`). */
function shortSha(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Waits for `window.__wiPano.ready`; a reported error, a page error or the timeout throws. */
async function waitReady(cdp: Cdp, id: string, pageErrors: readonly string[]): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (pageErrors.length > 0) throw new Error(`?pano=${id}: page errors:\n${pageErrors.join('\n')}`);
    const text = await evaluate<string | null>(cdp, READ_PANO);
    if (text !== null) {
      const s = JSON.parse(text) as { ready: boolean; error?: string };
      if (s.error !== undefined) throw new Error(`?pano=${id}: ${s.error}`);
      if (s.ready) return;
    }
    if (Date.now() - t0 > READY_TIMEOUT_MS) throw new Error(`?pano=${id}: not ready within ${READY_TIMEOUT_MS / 1000} s`);
    await sleep(POLL_MS);
  }
}

/** The page as WebP at the first quality of `qualitySteps()` that fits MAX_BYTES. */
async function capture(cdp: Cdp): Promise<{ bytes: Buffer; quality: number }> {
  for (const quality of qualitySteps()) {
    const r = await call(cdp, 'Page.captureScreenshot', { format: 'webp', quality });
    const bytes = Buffer.from(r['data'] as string, 'base64');
    if (bytes.length <= MAX_BYTES) return { bytes, quality };
    console.log(`  quality ${quality}: ${bytes.length} bytes > ${MAX_BYTES}`);
  }
  throw new Error(`no quality down to ${QUALITY_STEP} fits ${MAX_BYTES} bytes`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const a = parsePanoArgs(argv);
  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  let profile: string | null = null;
  const pageErrors: string[] = [];
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
    profile = mkdtempSync(join(tmpdir(), 'wi10-panoramas-'));
    chrome = await startChrome({
      headless: true, profileDir: profile, args: [...(a.gpu ? GPU_ARGS : SWIFTSHADER_ARGS), `--window-size=${SCREEN.width},${SCREEN.height}`], env: {},
    });
    console.log(`headless Chrome (pid ${chrome.proc.pid}) with DevTools on port ${chrome.port}, profile ${profile}, ${a.gpu ? 'the system GPU' : 'SwiftShader'}`);
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.type === 'page');
    if (target === undefined) throw new Error('Chrome has no page target');
    cdp = await connect(target.webSocketDebuggerUrl);
    const page = cdp;
    page.on('Runtime.exceptionThrown', (e) => {
      const d = e['exceptionDetails'] as { text?: string; exception?: { description?: string } };
      pageErrors.push(`exception: ${d.exception?.description ?? d.text ?? ''}`);
    });
    page.on('Runtime.consoleAPICalled', (e) => {
      if (e['type'] !== 'error') return;
      pageErrors.push(`console.error: ${(e['args'] as Array<{ value?: unknown; description?: string }>).map((x) => String(x.value ?? x.description)).join(' ')}`);
    });
    page.on('Log.entryAdded', (e) => {
      const entry = e['entry'] as { level: string; text: string; url?: string };
      if (entry.level !== 'error' || ignoredLog(entry.text, entry.url) || panoLeaveGuardLog(entry.text, entry.url)) return;
      pageErrors.push(`log: ${entry.text}${entry.url === undefined ? '' : ` (${entry.url})`}`);
    });
    // Leaving a revealed page meets its Ctrl+W guard: accept the prompt if Chrome shows one.
    page.on('Page.javascriptDialogOpening', (e) => {
      if (e['type'] === 'beforeunload') void page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    });
    await call(page, 'Runtime.enable');
    await call(page, 'Page.enable');
    await call(page, 'Log.enable');
    await call(page, 'Emulation.setDeviceMetricsOverride', { width: SCREEN.width, height: SCREEN.height, deviceScaleFactor: SCREEN.dpr, mobile: false });

    const renderer = await evaluate<string>(page, PROBE_RENDERER);
    console.log(`renderer: ${renderer}`);
    if (renderer === 'no webgl2 context') {
      console.error(`refused: no WebGL2 context${a.gpu ? '' : ' (is SwiftShader available in this Chrome?)'}`);
      return 1;
    }
    const commit = shortSha();
    const outDir = join(ROOT, OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    const entries: PanoramaEntry[] = [];
    for (const p of PANORAMAS) {
      const url = new URL(`/?pano=${encodeURIComponent(p.id)}`, server.url).href;
      const t0 = Date.now();
      console.log(`${p.id}: ${url}`);
      await call(page, 'Page.navigate', { url });
      await waitReady(page, p.id, pageErrors);
      const { bytes, quality } = await capture(page);
      const file = join(outDir, panoFile(p.id));
      writeFileSync(file, bytes);
      console.log(`  ${OUT_DIR}/${panoFile(p.id)}: ${bytes.length} bytes at quality ${quality}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      entries.push(manifestEntry(p, commit, renderer));
    }
    const manifest = join(outDir, 'manifest.json');
    writeFileSync(manifest, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`wrote ${manifest} (${entries.length} entries, commit ${commit})`);
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

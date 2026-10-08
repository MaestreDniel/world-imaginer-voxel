/**
 * The SP2b §8 UI smoke test (not in CI): drives the ?map editor in headless Chrome through the DevTools protocol
 * with real pointer and key input, and checks each editor end to end through the page's DOM and its URL state.
 * Run it with `node test/tools/uiSmoke.ts [options]`: Node 24 strips the types, CDP runs over the global
 * WebSocket, and nothing is added to the dependencies.
 *
 * Processes, as in mapLatency.ts: `npm run build`; its own `vite preview --host 127.0.0.1 --port <P> --strictPort`
 * on a free port P found by binding port 0 (never 5183), ready only when that child prints its URL; its own
 * headless Chrome with a temporary profile (in the OS temp directory or --profile-dir; Chrome's singleton socket
 * stays in $TMPDIR, whose path must be short) and DevTools port 0. At the end it stops only what it started and
 * removes the profile (downloads included).
 *
 * The page is 1400 × 900 CSS px at DPR 1. The steps, in order, each with its checks:
 * - selftest: `?selftest=1` matches every golden in a real module worker;
 * - load: `?map` at seed 42, the default profile and view (0, 0, 64 blocks/px) settles its first preview;
 * - number: `rivers.gorgeDepth` typed in the Parameters tab;
 * - knot: a knot of `shape.offset` dragged in the spline drawer (one undo step; the statistics refresh);
 * - slider: the biome-size slider dragged from 5 to 8 (one undo step);
 * - box: the desert T interval typed in the Biomes tab (the share chart refreshes);
 * - profile: a switch to large_biomes with the modified draft: the inline confirmation, Switch, then the
 *   notice's Undo;
 * - presets: export to a real download, the JSON patch box applies {}, then the file is imported;
 * - undo/redo: Ctrl+Z through the whole history, then Ctrl+Shift+Z and Ctrl+Y back;
 * - reload: the draft, the controls and the stored layout come back;
 * - cut line: a two-click line on the map and its profile in the drawer's Cross-section tab;
 * - voxels: the tab's Voxels mode (SP3a spec §5.2): a fresh, non-empty slice, its legend (every registry state, water and
 *   the sea line: SP3c spec §6), the hover readout, back to Profile;
 * - tabs: ArrowRight, ArrowLeft, Home and End move the selection and the focus on both tab bars;
 * - rule: the Voxels mode on the mountain line (SP3c spec §6): the pointer on the top solid voxel of a sample (found in
 *   the slice image, not at a fixed height) shows the readout at once, then its surface rule id ` · rule root.…`;
 * - console: no exception, console error or failed load, except the known favicon.ico 404.
 * With --shots DIR it then writes the spec §12 screenshots into DIR, at seed 42 from a newly loaded page (the
 * repository keeps them re-saved as 256-colour palette PNGs, as SP1 and SP2a did), and last the Voxels mode on the
 * mountain line (SP3b spec §7: `cross-section-voxels-mountain.png`; the line text is checked, and the slice summary
 * must show a ground top above y 200 and no water) with the pointer on the rule step's top voxel and its readout
 * showing the surface rule id (SP3c spec §6, §9: "a Voxels-mode screenshot with a hover rule id").
 * Options: --skip-build, --profile-dir DIR, --shots DIR. The exit code is 0 only when every check passes.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VIEWPORT = { width: 1400, height: 900 } as const;
const DEV_PORT = 5183;
const CHROME = '/usr/bin/google-chrome';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** BIOME_SIZE_SCALE[7]: biome-size position 8 (src/ui/map/biomeSize.ts; a unit test keeps them equal). */
export const SIZE_8 = 2.29739670999407;
const SETTLE_MS = 30000;

// ---------------------------------------------------------------- pure parts (unit-tested)

export interface MapUrlView { readonly x: number; readonly z: number; readonly bpp: number; readonly layer: string }
export interface MapUrlState { readonly v: 1; readonly seed: string; readonly profile: string; readonly patch: unknown; readonly view: MapUrlView }

/** JSON with object keys sorted at every level (the page's canonical JSON for the values the smoke test uses). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** The URL fragment the page writes for `s` (without the '#'). */
export function mapHash(s: MapUrlState): string {
  return Buffer.from(canonicalJson(s), 'utf8').toString('base64url');
}

/** The state in a `?map` URL fragment (with or without the '#'), or null when it is not one. */
export function readMapHash(hash: string): MapUrlState | null {
  try {
    const j = JSON.parse(Buffer.from(hash.replace(/^#/, ''), 'base64url').toString('utf8')) as Partial<MapUrlState> | null;
    return j !== null && typeof j === 'object' && j.v === 1 && typeof j.seed === 'string' && typeof j.profile === 'string' && typeof j.view === 'object' ? j as MapUrlState : null;
  } catch {
    return null;
  }
}

/**
 * The number of goldens in test/goldens.json: every key of the build, which `?selftest=1` recomputes (SP3a spec §6.4;
 * this tool runs under plain Node and cannot import `src/` to count `allGoldenKeys()`).
 */
export function goldenCount(goldensJson: string): number {
  const entries = (JSON.parse(goldensJson) as { entries?: unknown }).entries;
  if (entries === null || typeof entries !== 'object') throw new Error('goldens.json has no entries object');
  return Object.keys(entries).length;
}

/** True when the selftest page's summary reports all `count` goldens matching. */
export function selftestAllMatch(summary: string, count: number): boolean {
  const m = /^✓ all (\d+) goldens match/.exec(summary);
  return m !== null && Number(m[1]) === count;
}

/** A surface-rule id (SP3c spec §3.1): `root`, then `.rules[k]` and `.then` steps. */
const RULE_ID = String.raw`root(?:\.rules\[\d+\]|\.then)*`;
const VOXEL_READOUT = String.raw`\(-?\d+, -?\d+, -?\d+\) · (?:[a-z][a-z0-9_]*(?:\[[a-z0-9_=,]+\])?|unknown state \d+) · (?:no fluid|[a-z0-9 ]+, level [0-7](?: \(source\))?(?:, falling)?) · point \d+, \d+\.\d blocks from A`;

/**
 * The Voxels mode's hover readout: `(x, y, z) · block · fluid · point i, D blocks from A` (SP3a spec §5.2), with the
 * optional hover rule suffix ` · rule …` (the probe runs), ` · rule none` or ` · rule <rule id>` (SP3c spec §6).
 */
export function voxelReadoutOk(text: string): boolean {
  return new RegExp(`^${VOXEL_READOUT}(?: · rule (?:…|none|${RULE_ID}))?$`).test(text);
}

/** The rule id a Voxels readout ends with (` · rule root…`), or null while it waits, for none, or without one. */
export function voxelRuleId(text: string): string | null {
  const m = new RegExp(`^${VOXEL_READOUT} · rule (${RULE_ID})$`).exec(text);
  return m === null ? null : m[1]!;
}

/**
 * The Voxels legend's labels the page must show (SP3c spec §6): every state of the state-id lock (`test/stateIds.lock.json`,
 * the canonical keys) in state-id order, then the water and the sea-level keys. Throws when the lock's ids are not 0 … n − 1.
 */
export function voxelLegendLabels(stateIdsLockJson: string): string[] {
  const lock = JSON.parse(stateIdsLockJson) as Record<string, number>;
  const keys = Object.keys(lock).sort((a, b) => lock[a]! - lock[b]!);
  if (!keys.every((k, i) => lock[k] === i)) throw new Error('the state-id lock\'s state ids are not 0 … n − 1');
  return [...keys, 'water, darker with depth', 'sea level 63'];
}

/** Air's colour in the Voxels slice image (`VOXEL_COLORS.sky`; a unit test keeps them equal). */
export const SKY_RGB = [168, 204, 255] as const;

/**
 * The row (0 at y 319) of the top solid voxel of one sample column of the slice image, given as its 384 RGBA pixels top
 * down (`getImageData(i, 0, 1, 384).data`): the first pixel that is not air's colour (on a dry line, the column's ground
 * top), or null when the column is all air.
 */
export function groundTopRow(column: ArrayLike<number>): number | null {
  if (column.length !== 4 * 384) throw new Error(`a sample column of the slice image is 384 RGBA pixels, not ${column.length} bytes`);
  for (let row = 0; row < 384; row++) {
    const k = 4 * row;
    if (column[k] !== SKY_RGB[0] || column[k + 1] !== SKY_RGB[1] || column[k + 2] !== SKY_RGB[2]) return row;
  }
  return null;
}

/** The sample the rule step and the mountain screenshot hover: 40 % of the line's 512 samples. */
export const RULE_SAMPLE = 205;

/**
 * The page point (CSS px) at the centre of the cell (sample i, image row `row`, 0 at y 319) of the 512 × 384 Voxels
 * slice image drawn in `box` (the `.cs-voxels` canvas's box).
 */
export function sliceCellPoint(box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, i: number, row: number): [number, number] {
  if (!Number.isInteger(i) || i < 0 || i > 511 || !Number.isInteger(row) || row < 0 || row > 383) throw new RangeError(`sliceCellPoint: cell (${i}, ${row}) outside the 512 × 384 slice`);
  return [box.x + ((i + 0.5) * box.width) / 512, box.y + ((row + 0.5) * box.height) / 384];
}

/** The Voxels mode's summary of a non-empty slice: `ground top y LO to HI · …water…`. */
export function voxelSummaryOk(text: string): boolean {
  return /^ground top y -?\d+ to -?\d+ · (?:no water|water on \d+\.\d % of the line, up to \d+ deep)$/.test(text);
}

/**
 * The Voxels mode's summary of the mountain line (SP3b spec §7, §11): the format of `voxelSummaryOk`, a ground top
 * above y 200 (the review mountain's `topMax` > 200, as `reviewSlices.test` requires) and no water.
 */
export function mountainSummaryOk(text: string): boolean {
  const m = /^ground top y (-?\d+) to (-?\d+) · no water$/.exec(text);
  return m !== null && voxelSummaryOk(text) && Number(m[2]) > 200;
}

/** A cut line's ends, as the cross-section's line text writes them. */
export interface Segment { readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number }

/** The segment of the cross-section's line text `A (ax, az) → B (bx, bz) · N blocks`, or null. */
export function parseSegment(text: string): Segment | null {
  const m = /^A \((-?\d+), (-?\d+)\) → B \((-?\d+), (-?\d+)\) · [\d ]+ blocks$/.exec(text);
  return m === null ? null : { ax: Number(m[1]), az: Number(m[2]), bx: Number(m[3]), bz: Number(m[4]) };
}

/**
 * The mountain line of the Voxels-mode screenshot (SP3b spec §7 uiSmoke, §11): the review slices' mountain site
 * (`test/harness/reviewSlices.ts`, a highland row with σ > 8 found by a scan; a unit test keeps them equal), from
 * A (−1664, 8) to B (−640, 8), clicked at ± 256 CSS px around the centre of a view at 2 blocks/px.
 */
export const MOUNTAIN_LINE = {
  view: { x: -1152, z: 8, bpp: 2, layer: 'relief' },
  a: [-1664, 8],
  b: [-640, 8],
} as const satisfies { readonly view: MapUrlView; readonly a: readonly [number, number]; readonly b: readonly [number, number] };

/** A page log entry the smoke test does not count: the favicon.ico 404 (index.html declares no icon). */
export function ignoredLog(text: string, url: string | undefined): boolean {
  return url !== undefined && /\/favicon\.ico(\?|$)/.test(url) && text.includes('404');
}

/** What is wrong with a downloaded preset file, compared with the draft it was exported from. */
export function presetProblems(text: string, expected: { readonly name: string; readonly profile: string; readonly patch: unknown }): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return [`not JSON: ${e instanceof Error ? e.message : String(e)}`];
  }
  const out: string[] = [];
  if (doc['format'] !== 'wi10-preset') out.push(`format ${JSON.stringify(doc['format'])}`);
  if (doc['name'] !== expected.name) out.push(`name ${JSON.stringify(doc['name'])}`);
  if (doc['profile'] !== expected.profile) out.push(`profile ${JSON.stringify(doc['profile'])}`);
  if (typeof doc['schemaVersion'] !== 'number') out.push(`schemaVersion ${JSON.stringify(doc['schemaVersion'])}`);
  if (!sameJson(doc['params'], expected.patch)) out.push('params differ from the draft\'s patch');
  return out;
}

export interface SmokeArgs {
  readonly build: boolean;
  /** The parent of the temporary Chrome profile (default: the OS temp directory). */
  readonly profileDir: string | null;
  /** Where the spec §12 screenshots go; null: none. */
  readonly shots: string | null;
}

export function parseArgs(argv: readonly string[]): SmokeArgs {
  let build = true;
  let profileDir: string | null = null;
  let shots: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--skip-build') build = false;
    else if (a === '--profile-dir') profileDir = value();
    else if (a === '--shots') shots = value();
    else throw new Error(`unknown argument ${a}`);
  }
  return { build, profileDir, shots };
}

// ---------------------------------------------------------------- the page side (sent as source text)

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface SmokePage {
  /** The URL state, decoded from location.hash. */
  state(): MapUrlState | null;
  status(): string;
  /** The preview has landed and nothing is pending ("last edit → preview N ms"). */
  settled(): boolean;
  /** The World tab's session status. */
  world(): string;
  notices(): string[];
  /** The element's box in CSS px after scrolling it to the middle of its scroll container. */
  box(selector: string): Box | null;
  /** Resolves with the wait in ms once `pred` holds on an animation frame; rejects after `ms`. */
  until(pred: () => boolean, ms: number, what: string): Promise<number>;
}

/**
 * The page helpers, installed as `globalThis.__wiSmoke` on every new document from this function's source: it may
 * use nothing outside its body.
 */
function pageHelpers(): SmokePage {
  const q = (sel: string): HTMLElement | null => (sel.startsWith('#') ? document.getElementById(sel.slice(1)) : document.querySelector<HTMLElement>(sel));
  return {
    state() {
      const h = location.hash.slice(1);
      if (h === '') return null;
      try {
        const bin = atob(h.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as MapUrlState;
      } catch {
        return null;
      }
    },
    status: () => q('.map-status')?.textContent ?? '',
    settled() {
      const s = q('.map-status')?.textContent ?? '';
      return /preview \d+ ms/.test(s) && !s.includes('pending') && !s.includes('error');
    },
    world: () => document.querySelector('#map-tabpanel-world .map-readout')?.textContent ?? '',
    notices: () => [...document.querySelectorAll('.map-notices .notice-text')].map((n) => n.textContent ?? ''),
    box(sel) {
      const e = q(sel);
      if (e === null) return null;
      e.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    until(pred, ms, what) {
      return new Promise((resolve, reject) => {
        const t0 = performance.now();
        const step = () => {
          let ok = false;
          try { ok = pred(); } catch { ok = false; }
          if (ok) resolve(performance.now() - t0);
          else if (performance.now() - t0 > ms) reject(new Error(`no ${what} within ${ms} ms`));
          else requestAnimationFrame(step);
        };
        step();
      });
    },
  };
}

// ---------------------------------------------------------------- processes and CDP

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every child this runner started, so the cleanup stops exactly those. */
const started: ChildProcess[] = [];

function start(cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  const c = spawn(cmd, args, opts);
  c.on('error', (e) => console.error(`${cmd}: ${e.message}`));
  started.push(c);
  return c;
}

const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;

async function stop(c: ChildProcess): Promise<void> {
  if (!running(c)) return;
  const exited = new Promise<void>((r) => c.once('exit', () => r()));
  c.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return;
  c.kill('SIGKILL');
  await exited;
}

async function npmBuild(): Promise<void> {
  const c = start('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  const code = await new Promise<number | null>((r) => c.once('exit', (n) => r(n)));
  if (code !== 0) throw new Error(`npm run build exited with ${code}`);
}

/** A free TCP port on 127.0.0.1 (bind port 0, read it, release it), never the dev server's 5183. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address();
        const p = typeof a === 'object' && a !== null ? a.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port !== 0 && port !== DEV_PORT) return port;
  }
}

/** Our own `vite preview` on `port`: ready when it prints its URL; an exit first (for example a taken port) fails. */
async function startPreview(port: number): Promise<{ readonly child: ChildProcess; readonly url: string }> {
  const url = `http://127.0.0.1:${port}/`;
  const child = start(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vite preview did not print ${url} within 30 s:\n${out}`)), 30000);
    const seen = () => {
      if (out.replace(/\x1b\[[0-9;]*m/g, '').includes(url)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); seen(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`vite preview exited (${code ?? signal}) before it was ready:\n${out}`));
    });
  });
  return { child, url };
}

/** Our own headless Chrome; it binds a free DevTools port and writes it into the profile's DevToolsActivePort. */
async function startChrome(profile: string): Promise<{ readonly child: ChildProcess; readonly port: number; readonly browserWs: string }> {
  const child = start(CHROME, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
  ], { stdio: 'ignore' });
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (!running(child)) throw new Error('Chrome exited during start-up');
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split('\n');
      if (port !== undefined && port !== '' && path !== undefined && path !== '') return { child, port: Number(port), browserWs: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  throw new Error('Chrome did not open its DevTools port within 15 s');
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(method: string, fn: (params: Record<string, unknown>) => void): void;
  close(): void;
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Array<(p: Record<string, unknown>) => void>>();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result ?? {});
    } else if (m.method !== undefined) for (const fn of listeners.get(m.method) ?? []) fn(m.params ?? {});
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    on(method, fn) { listeners.set(method, [...(listeners.get(method) ?? []), fn]); },
    close() { ws.close(); },
  };
}

// ---------------------------------------------------------------- driving the page

/** One page under test: evaluation, waits and real pointer and key input. */
class Page {
  /** Mouse button state for the moves of a drag. */
  private buttons = 0;
  readonly cdp: Cdp;
  readonly base: string;
  constructor(cdp: Cdp, base: string) {
    this.cdp = cdp;
    this.base = base;
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const ex = r['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
    if (ex !== undefined) throw new Error(`page: ${ex.exception?.description ?? ex.text ?? 'evaluation failed'}`);
    return (r['result'] as { value?: unknown }).value as T;
  }

  /** Waits until the page expression `pred` holds (checked once per animation frame). */
  until(pred: string, what: string, ms = SETTLE_MS): Promise<number> {
    return this.eval<number>(`__wiSmoke.until(() => (${pred}), ${ms}, ${JSON.stringify(what)})`);
  }

  /** Loads `url` as a new document (through about:blank, so that a `?map` hash never becomes a hashchange). */
  async goto(url: string, ready: string): Promise<void> {
    await this.cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await this.cdp.send('Page.navigate', { url });
    for (let i = 0; i < 300; i++) {
      if (await this.eval<boolean>(`typeof __wiSmoke === 'object' && document.readyState === 'complete' && (${ready})`).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`${url} was not ready after 30 s`);
  }

  async reload(ready: string): Promise<void> {
    await this.cdp.send('Page.reload', {});
    await sleep(300);
    for (let i = 0; i < 300; i++) {
      if (await this.eval<boolean>(`typeof __wiSmoke === 'object' && document.readyState === 'complete' && (${ready})`).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error('the page was not ready 30 s after the reload');
  }

  state(): Promise<MapUrlState | null> { return this.eval('__wiSmoke.state()'); }
  hash(): Promise<string> { return this.eval('location.hash'); }

  /**
   * After an edit: the URL leaves `before`, then the preview settles and the URL stays the same for 300 ms (the
   * page writes it 200 ms after the last change, so a drag can write intermediate states first).
   */
  async changed(before: string, what: string): Promise<MapUrlState> {
    await this.until(`location.hash !== ${JSON.stringify(before)}`, `URL change after ${what}`, 5000);
    for (let i = 0; i < 20; i++) {
      await this.until('__wiSmoke.settled()', `settled preview after ${what}`);
      const h = await this.hash();
      await sleep(300);
      if ((await this.hash()) === h && (await this.eval<boolean>('__wiSmoke.settled()'))) {
        const s = await this.state();
        if (s === null) throw new Error(`no URL state after ${what}`);
        return s;
      }
    }
    throw new Error(`the URL kept changing after ${what}`);
  }

  async center(selector: string): Promise<{ readonly x: number; readonly y: number; readonly box: Box }> {
    const box = await this.eval<Box | null>(`__wiSmoke.box(${JSON.stringify(selector)})`);
    if (box === null) throw new Error(`no element ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  }

  mouse(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number): Promise<Record<string, unknown>> {
    if (type === 'mousePressed') this.buttons = 1;
    if (type === 'mouseReleased') this.buttons = 0;
    return this.cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' && this.buttons === 0 ? 'none' : 'left', buttons: this.buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }

  async click(selector: string): Promise<void> {
    const c = await this.center(selector);
    await this.clickAt(c.x, c.y);
  }

  /** A drag from (x0, y0) by `steps` moves of (dx, dy), one per animation frame, without the release. */
  async dragBy(x0: number, y0: number, dx: number, dy: number, steps: number): Promise<{ readonly x: number; readonly y: number }> {
    await this.mouse('mouseMoved', x0, y0);
    await this.mouse('mousePressed', x0, y0);
    let x = x0;
    let y = y0;
    for (let i = 0; i < steps; i++) {
      x += dx;
      y += dy;
      await this.mouse('mouseMoved', x, y);
      await sleep(16);
    }
    return { x, y };
  }

  async key(key: string, code: string, keyCode: number, modifiers = 0, text?: string): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(text === undefined ? {} : { text, unmodifiedText: text }) });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  enter(): Promise<void> { return this.key('Enter', 'Enter', 13, 0, '\r'); }
  undoKey(): Promise<void> { return this.key('z', 'KeyZ', 90, 2); }
  redoKey(): Promise<void> { return this.key('z', 'KeyZ', 90, 2 | 8); }
  redoKeyY(): Promise<void> { return this.key('y', 'KeyY', 89, 2); }

  /** Clicks a text field, selects its text and types `text` over it (no commit). */
  async typeInto(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.eval(`(() => { const e = ${selector.startsWith('#') ? `document.getElementById(${JSON.stringify(selector.slice(1))})` : `document.querySelector(${JSON.stringify(selector)})`}; e.select(); return true; })()`);
    await this.cdp.send('Input.insertText', { text });
  }

  /** Moves focus out of every field, so that Ctrl+Z reaches the page's shortcuts (§3.5). */
  blur(): Promise<boolean> { return this.eval('(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)'); }

  async shot(path: string): Promise<void> {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(String(r['data']), 'base64'));
  }
}

// ---------------------------------------------------------------- the smoke steps

const START: MapUrlState = { v: 1, seed: '42', profile: 'default', patch: {}, view: { x: 0, z: 0, bpp: 64, layer: 'biome' } };
const MAP_READY = `document.querySelector('.map-status') !== null && __wiSmoke.settled()`;

interface Check { readonly step: string; readonly ok: boolean; readonly what: string }

class Smoke {
  readonly checks: Check[] = [];
  private stepName = '';
  readonly page: Page;
  readonly downloads: string;
  constructor(page: Page, downloads: string) {
    this.page = page;
    this.downloads = downloads;
  }

  step(name: string): void {
    this.stepName = name;
    console.log(`\n${name}`);
  }

  check(ok: boolean, what: string, detail?: unknown): void {
    this.checks.push({ step: this.stepName, ok, what });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}${ok || detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

const patchOf = (s: MapUrlState): Record<string, unknown> => s.patch as Record<string, unknown>;
const without = (patch: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(patch).filter(([k]) => k !== key));

async function runSmoke(t: Smoke): Promise<void> {
  const p = t.page;

  t.step('selftest: ?selftest=1');
  await p.goto(`${p.base}?selftest=1`, `document.querySelector('h2 + div') !== null`);
  await p.until(`/^[✓✗]/.test(document.querySelector('h2 + div').textContent)`, 'selftest summary', 180000);
  const summary = await p.eval<string>(`document.querySelector('h2 + div').textContent`);
  const goldens = goldenCount(readFileSync(join(ROOT, 'test/goldens.json'), 'utf8'));
  t.check(selftestAllMatch(summary, goldens), `selftest: ${summary} (test/goldens.json holds ${goldens})`, summary);

  t.step('load: ?map at seed 42, default profile, view (0, 0, 64 blocks/px)');
  await p.goto(`${p.base}?map#${mapHash(START)}`, MAP_READY);
  const loaded = await p.state();
  t.check(await p.eval<boolean>('crossOriginIsolated'), 'the page is cross-origin isolated');
  t.check(loaded !== null && sameJson(loaded, START), 'the URL holds the state it was opened with', loaded);
  const world0 = await p.eval<string>('__wiSmoke.world()');
  t.check(world0.includes('seed 42') && world0.includes('profile default\n'), 'the World tab shows seed 42, the default profile and no modified parameter', world0);
  t.check(/^last edit → preview \d+ ms$/.test(await p.eval<string>('__wiSmoke.status()')), `the first preview landed (${await p.eval<string>('__wiSmoke.status()')})`);
  const history: MapUrlState[] = [loaded ?? START];

  t.step('number: rivers.gorgeDepth typed in the Parameters tab');
  await p.click('#map-tab-parameters');
  await p.click('.pp-section[data-path="rivers"] > .pp-section-head > .pp-toggle');
  let before = await p.hash();
  await p.typeInto('#pp-rivers.gorgeDepth', '40');
  await p.enter();
  const s1 = await p.changed(before, 'the gorgeDepth edit');
  t.check(sameJson(s1.patch, { rivers: { gorgeDepth: 40 } }), 'the patch is {rivers: {gorgeDepth: 40}}', s1.patch);
  t.check(await p.eval<boolean>(`document.querySelector('.pp-control[data-path="rivers.gorgeDepth"] .pp-dot').classList.contains('on')`), 'the control shows its modified dot');
  t.check(await p.eval<string>(`document.querySelector('.pp-section[data-path="rivers"] .pp-count').textContent`) === '1 modified', 'the Rivers section counts 1 modified');
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('profile default, 1 modified'), 'the World tab counts 1 modified parameter');
  history.push(s1);

  t.step('knot: a shape.offset knot dragged in the spline drawer');
  await p.click('.pp-section[data-path="shape"] > .pp-section-head > .pp-toggle');
  await p.click('.pp-control[data-path="shape.offset"] .pp-edit');
  t.check(await p.eval<boolean>(`!document.querySelector('.map-drawer').hidden && document.getElementById('map-drawer-tab-spline').getAttribute('aria-selected') === 'true'`), 'Edit opens the drawer on the Spline tab');
  await p.until(`document.querySelector('.sd-stats').dataset.state === 'fresh'`, 'fresh spline statistics');
  t.check(true, `statistics: ${await p.eval<string>(`document.querySelector('.sd-stats').textContent`)}`);
  const knots = await p.eval<Array<{ k: number; nested: boolean; x: number; y: number }>>(`[...document.querySelectorAll('.sd-plot circle.sd-knot')].map((c) => { const r = c.getBoundingClientRect(); return { k: Number(c.dataset.k), nested: c.classList.contains('sd-nested'), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const knot = knots.find((k) => !k.nested) ?? knots[Math.floor(knots.length / 2)]!;
  before = await p.hash();
  const end = await p.dragBy(knot.x, knot.y, 0, -3, 12);
  t.check(await p.eval<boolean>(`document.querySelector('.sd-stats').dataset.state === 'stale'`), `the statistics are stale during the drag of knot ${knot.k}${knot.nested ? ' (nested: x only)' : ''}`);
  await p.mouse('mouseReleased', end.x, end.y);
  const s2 = await p.changed(before, 'the knot drag');
  t.check(patchOf(s2)['shape'] !== undefined && sameJson(without(patchOf(s2), 'shape'), s1.patch), 'the patch gains shape.offset and keeps gorgeDepth', s2.patch);
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('2 modified'), 'the World tab counts 2 modified parameters');
  await p.until(`document.querySelector('.sd-stats').dataset.state === 'fresh'`, 'fresh statistics after the drag');
  t.check(true, 'the statistics are fresh again once the preview settles');
  before = await p.hash();
  await p.undoKey();
  const s2u = await p.changed(before, 'Ctrl+Z after the drag');
  t.check(sameJson(s2u, s1), 'one Ctrl+Z undoes the whole drag', s2u.patch);
  before = await p.hash();
  await p.redoKey();
  const s2r = await p.changed(before, 'Ctrl+Shift+Z');
  t.check(sameJson(s2r, s2), 'Ctrl+Shift+Z redoes it');
  history.push(s2);

  t.step('slider: the biome-size slider dragged from 5 to 8');
  t.check(await p.eval<string>(`document.querySelector('.map-size').value`) === '5', 'the slider starts at 5');
  const sl = await p.center('.map-size');
  before = await p.hash();
  // Press at the thumb of 5, then move right one frame at a time until the slider shows 8.
  const x5 = sl.box.x + 8 + (4 / 9) * (sl.box.width - 16);
  await p.mouse('mouseMoved', x5, sl.y);
  await p.mouse('mousePressed', x5, sl.y);
  let x = x5;
  for (let i = 0; i < 200 && (await p.eval<string>(`document.querySelector('.map-size').value`)) !== '8'; i++) {
    x += 1;
    await p.mouse('mouseMoved', x, sl.y);
    await sleep(16);
  }
  const during = await p.eval<string>('__wiSmoke.status()');
  await p.mouse('mouseReleased', x, sl.y);
  const s3 = await p.changed(before, 'the slider drag');
  t.check(patchOf(s3)['climate'] !== undefined && sameJson(patchOf(s3)['climate'], { scaleMul: SIZE_8 }), `the patch gains climate.scaleMul ${SIZE_8} (status during the drag: ${during})`, s3.patch);
  t.check(await p.eval<string>(`document.querySelector('.map-size').value + '|' + document.querySelector('.map-approx').textContent`) === '8|', 'the slider shows 8 without "≈"');
  before = await p.hash();
  await p.click('.map-toolbar button[title^="Undo"]');
  const s3u = await p.changed(before, 'the toolbar Undo');
  t.check(sameJson(s3u, s2), 'the toolbar Undo takes back the whole drag', s3u.patch);
  before = await p.hash();
  await p.click('.map-toolbar button[title^="Redo"]');
  const s3r = await p.changed(before, 'the toolbar Redo');
  t.check(sameJson(s3r, s3), 'the toolbar Redo puts it back');
  history.push(s3);

  t.step('box: the desert T interval typed in the Biomes tab');
  await p.click('#map-tab-biomes');
  const was = await p.eval<string>(`document.getElementById('bt-desert-T').value`);
  const [lo, hi] = was.split(',').map((v) => Number(v.trim())) as [number, number];
  const mid = Math.round(((lo + hi) / 2) * 100) / 100;
  before = await p.hash();
  await p.typeInto('#bt-desert-T', `${lo}, ${mid}`);
  await p.enter();
  const s4 = await p.changed(before, 'the box edit');
  const table = (patchOf(s4)['biomes'] as { table?: Record<string, { T?: unknown }> } | undefined)?.table;
  t.check(sameJson(table?.['desert']?.T, [lo, mid]), `desert T ${was} → ${lo}, ${mid} in the patch (the whole table, the leaf is atomic)`, table?.['desert']);
  t.check(await p.eval<boolean>(`document.querySelector('.bt-row[data-biome="desert"] .bt-dot').classList.contains('on')`), 'the desert row shows its modified dot');
  await p.until(`document.querySelector('.bs').dataset.state === 'fresh'`, 'fresh biome shares');
  t.check(true, `the share chart is fresh: ${await p.eval<string>(`document.querySelector('.bs-totals').textContent`)}`);
  history.push(s4);

  t.step('profile: switch to large_biomes with 4 modified parameters, then Undo');
  await p.eval(`document.querySelector('.map-toolbar select[title="Profile"]').focus()`);
  await p.key('ArrowDown', 'ArrowDown', 40);
  await p.until(`__wiSmoke.notices().some((n) => n.startsWith('Switching to'))`, 'the inline confirmation', 5000);
  const confirmText = (await p.eval<string[]>('__wiSmoke.notices()')).find((n) => n.startsWith('Switching to'));
  t.check(confirmText === 'Switching to large_biomes clears 4 modified parameters', `the confirmation: ${confirmText}`, confirmText);
  t.check(await p.eval<string>(`document.querySelector('.map-toolbar select[title="Profile"]').value`) === 'default' && sameJson(await p.state(), s4), 'the select and the draft stay on default until Switch');
  before = await p.hash();
  await p.click('.map-notices .notice-confirm');
  const s5 = await p.changed(before, 'Switch');
  t.check(s5.profile === 'large_biomes' && sameJson(s5.patch, {}), 'Switch loads large_biomes with an empty patch', s5);
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('profile large_biomes\n'), 'the World tab shows large_biomes, nothing modified');
  t.check(await p.eval<boolean>(`[...document.querySelectorAll('.map-notices .notice')].some((n) => n.querySelector('.notice-text').textContent === 'profile switched' && n.querySelector('.notice-action')?.textContent === 'Undo')`), 'the notice "profile switched" offers Undo');
  before = await p.hash();
  await p.eval(`[...document.querySelectorAll('.map-notices .notice')].find((n) => n.querySelector('.notice-text').textContent === 'profile switched').querySelector('.notice-action').scrollIntoView(); true`);
  await p.click('.map-notices .notice-action');
  const s5u = await p.changed(before, 'the notice\'s Undo');
  t.check(sameJson(s5u, s4), 'Undo restores default with the 4 modified parameters', s5u);

  t.step('presets: export, apply {} in the patch box, import the exported file');
  await p.click('#map-tab-presets');
  await p.typeInto('#pt-name', 'smoke test');
  t.check(await p.eval<string>(`document.getElementById('pt-name-hint').textContent`) === 'saves smoke test.wi10-preset.json', 'the name hint names the file');
  await p.click('#pt-export');
  const file = join(t.downloads, 'smoke test.wi10-preset.json');
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
  t.check(existsSync(file), `the download arrives: ${file}`);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const problems = presetProblems(text, { name: 'smoke test', profile: 'default', patch: s4.patch });
  t.check(problems.length === 0, 'the file is a wi10-preset with the draft\'s profile and patch', problems);
  t.check(await p.eval<string>(`document.getElementById('pt-export-msg').textContent`) === 'exported smoke test.wi10-preset.json', 'the tab says the file was exported');
  before = await p.hash();
  await p.typeInto('#pt-patch', '{}');
  await p.click('#pt-apply');
  const s6 = await p.changed(before, 'Apply patch {}');
  t.check(s6.profile === 'default' && sameJson(s6.patch, {}), 'Apply replaces the whole patch with {}', s6.patch);
  history.push(s6);
  before = await p.hash();
  const doc = await p.cdp.send('DOM.getDocument', { depth: 0 });
  const node = await p.cdp.send('DOM.querySelector', { nodeId: (doc['root'] as { nodeId: number }).nodeId, selector: '#pt-file' });
  await p.cdp.send('DOM.setFileInputFiles', { nodeId: node['nodeId'], files: [file] });
  const s7 = await p.changed(before, 'the import');
  t.check(sameJson(s7, s4), 'the import loads the exported draft', s7.patch);
  t.check(await p.eval<string>(`document.getElementById('pt-import-msg').textContent`) === 'imported smoke test.wi10-preset.json', 'the tab says the file was imported');
  t.check((await p.eval<string[]>('__wiSmoke.notices()')).includes('loaded preset smoke test'), 'the notice "loaded preset smoke test"');
  history.push(s7);

  t.step(`undo/redo: Ctrl+Z through the ${history.length - 1} steps, then Ctrl+Shift+Z and Ctrl+Y back`);
  await p.blur();
  for (let i = history.length - 2; i >= 0; i--) {
    before = await p.hash();
    await p.undoKey();
    const s = await p.changed(before, `Ctrl+Z to step ${i}`);
    t.check(sameJson(s, history[i]), `Ctrl+Z → step ${i}: ${canonicalJson(s.patch).length} bytes of patch`, s.patch);
  }
  t.check(await p.eval<boolean>(`document.querySelector('.map-toolbar button[title^="Undo"]').disabled`), 'Undo is disabled at the first step');
  for (let i = 1; i < history.length; i++) {
    before = await p.hash();
    if (i % 2 === 1) await p.redoKey();
    else await p.redoKeyY();
    const s = await p.changed(before, `redo to step ${i}`);
    t.check(sameJson(s, history[i]), `${i % 2 === 1 ? 'Ctrl+Shift+Z' : 'Ctrl+Y'} → step ${i}`, s.patch);
  }
  t.check(await p.eval<boolean>(`document.querySelector('.map-toolbar button[title^="Redo"]').disabled`), 'Redo is disabled at the last step');

  t.step('reload: the draft, the controls and the layout come back');
  const final = await p.state();
  const typed = await p.eval<string>(`document.getElementById('bt-desert-T').value`);
  await p.reload(MAP_READY);
  t.check(sameJson(await p.state(), final), 'the URL state survives the reload');
  t.check((await p.eval<string>('__wiSmoke.world()')).includes('profile default, 4 modified'), 'the World tab counts 4 modified parameters');
  t.check(await p.eval<string>(`document.getElementById('pp-rivers.gorgeDepth').value`) === '40', 'the gorgeDepth field shows 40');
  t.check(await p.eval<string>(`document.querySelector('.map-size').value`) === '8', 'the slider shows 8');
  t.check(await p.eval<string>(`document.getElementById('bt-desert-T').value`) === typed, `the desert T field shows ${typed}`);
  t.check(await p.eval<boolean>(`document.getElementById('map-tab-presets').getAttribute('aria-selected') === 'true' && !document.getElementById('pp-section-rivers').hidden && !document.getElementById('pp-section-shape').hidden`), 'the Presets tab and the open sections are restored from the stored layout');

  t.step('cut line: two clicks on the map, then the Cross-section tab');
  await p.click('.map-cut');
  t.check(await p.eval<string>(`document.querySelector('.map-cut').textContent`) === 'Cut line: click A', 'Cut line arms the tool');
  const cv = await p.center('.map-canvas');
  await p.clickAt(cv.x - 200, cv.y);
  await p.clickAt(cv.x + 200, cv.y);
  t.check(await p.eval<boolean>(`!document.querySelector('.map-drawer').hidden && document.getElementById('map-drawer-tab-section').getAttribute('aria-selected') === 'true'`), 'the second click opens the drawer on the Cross-section tab');
  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh cross-section');
  const line = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  t.check(/^A \(-?\d+, -?\d+\) → B \(-?\d+, -?\d+\) · [\d ]+ blocks$/.test(line), `the line: ${line}`, line);
  t.check(true, `the profile: ${await p.eval<string>(`document.querySelector('.cs-summary').textContent`)}`);

  t.step('voxels: the Cross-section tab\'s Voxels mode');
  await p.click('.cs-mode[data-mode="voxels"]');
  t.check(await p.eval<boolean>(`document.querySelector('.cs-mode[data-mode="voxels"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.cs').dataset.mode === 'voxels'`), 'the toggle selects Voxels');
  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice');
  const sliceSum = await p.eval<string>(`document.querySelector('.cs-summary').textContent`);
  t.check(voxelSummaryOk(sliceSum), `the slice: ${sliceSum}`, sliceSum);
  const colours = await p.eval<number>(`(() => { const c = document.querySelector('.cs-voxels'); if (c.hidden || c.width !== 512 || c.height !== 384) return -1; const d = c.getContext('2d').getImageData(0, 0, 512, 384).data; const s = new Set(); for (let k = 0; k < d.length; k += 4) s.add(d[k] * 65536 + d[k + 1] * 256 + d[k + 2]); return s.size; })()`);
  t.check(colours >= 3, `the 512 × 384 slice shows ${colours} colours (air, stone and bedrock at least)`, colours);
  const legendWant = voxelLegendLabels(readFileSync(join(ROOT, 'test/stateIds.lock.json'), 'utf8'));
  const legendGot = await p.eval<string[]>(`(() => { const l = document.querySelector('.cs-voxel-legend'); return l === null || l.hidden ? [] : [...l.querySelectorAll('.cs-key')].map((k) => k.textContent); })()`);
  t.check(sameJson(legendGot, legendWant), `the legend keys the ${legendWant.length - 2} registry states, water and the sea line (SP3c spec §6)`, legendGot);
  const covered = await p.eval<string[]>(`[...document.querySelectorAll('.cs-plot rect, .cs-plot path')].filter((e) => getComputedStyle(e).fill !== 'none').map((e) => e.getAttribute('class'))`);
  t.check(covered.length === 0, 'nothing in the SVG over the slice is filled', covered);
  const vox = await p.center('.cs-voxels');
  await p.mouse('mouseMoved', vox.x, vox.box.y + vox.box.height * 0.8);
  const voxRead = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
  t.check(voxelReadoutOk(voxRead), `hover: ${voxRead}`, voxRead);
  await p.mouse('mouseMoved', vox.x, vox.box.y - 200);
  await p.click('.cs-mode[data-mode="profile"]');
  await p.until(`document.querySelector('.cs').dataset.mode === 'profile' && document.querySelector('.cs').dataset.state === 'fresh'`, 'the profile again');
  t.check(await p.eval<boolean>(`document.querySelector('.cs-voxels').hidden && document.querySelector('.cs-plot .cs-offset') !== null`), 'Profile shows the profile again (kept for the same draft)');

  t.step('tabs: the arrow keys, Home and End on both tab bars');
  const shown = (bar: string) => p.eval<string>(`(() => { const s = document.querySelector('${bar} [aria-selected="true"]'); return s === document.activeElement && s.tabIndex === 0 && !document.getElementById(s.getAttribute('aria-controls')).hidden ? s.id : 'focus ' + document.activeElement?.id + ', selected ' + s?.id; })()`);
  await p.eval<boolean>(`(document.getElementById('map-tab-presets').focus(), true)`);
  for (const [name, key, code, keyCode, want] of [
    ['ArrowRight', 'ArrowRight', 'ArrowRight', 39, 'map-tab-world'], ['ArrowRight', 'ArrowRight', 'ArrowRight', 39, 'map-tab-parameters'],
    ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 37, 'map-tab-world'], ['End', 'End', 'End', 35, 'map-tab-presets'], ['Home', 'Home', 'Home', 36, 'map-tab-world'],
  ] as const) {
    await p.key(key, code, keyCode);
    const got = await shown('.map-tabs');
    t.check(got === want, `${name} on the side panel's tabs selects and focuses ${want}`, got);
  }
  await p.eval<boolean>(`(document.getElementById('map-drawer-tab-section').focus(), true)`);
  await p.key('ArrowLeft', 'ArrowLeft', 37);
  const toSpline = await shown('.map-drawer-tabs');
  t.check(toSpline === 'map-drawer-tab-spline', 'ArrowLeft on the drawer\'s Cross-section tab shows Spline', toSpline);
  await p.key('ArrowRight', 'ArrowRight', 39);
  const toSection = await shown('.map-drawer-tabs');
  t.check(toSection === 'map-drawer-tab-section', 'ArrowRight shows Cross-section again', toSection);

  t.step('rule: the hover rule id of a land top on the mountain line (SP3c spec §6)');
  const { text: lineText, summary: mountain } = await openMountainVoxels(p);
  t.check(mountainSummaryOk(mountain), `the mountain line ${lineText}: ${mountain}`, mountain);
  const hover = await hoverTopRule(p);
  t.check(hover !== null, `sample ${RULE_SAMPLE} has a ground top (row ${hover?.row ?? '-'}, y ${hover === null ? '-' : 319 - hover.row})`);
  if (hover !== null) {
    t.check(hover.firstOk, `hover on the top voxel: ${hover.first}`, hover.first);
    t.check(hover.ruledOk, `the rule of the land top: ${hover.ruled}`, hover.ruled);
  }
}

/**
 * On the open Voxels slice: the pointer on the top solid voxel of sample RULE_SAMPLE, read from the slice image (not a
 * fixed height); the readout at once (`first`: SP3a's format, that voxel's y, not air) and, after waiting for
 * ` · rule root…`, with its rule id (`ruled`: a top voxel's rule is in the sky-open branch, `root.rules[1].then.…`).
 * Null when the sample column is all air.
 */
async function hoverTopRule(p: Page): Promise<{ readonly row: number; readonly first: string; readonly firstOk: boolean; readonly ruled: string; readonly ruledOk: boolean } | null> {
  const column = await p.eval<number[]>(`Array.from(document.querySelector('.cs-voxels').getContext('2d').getImageData(${RULE_SAMPLE}, 0, 1, 384).data)`);
  const row = groundTopRow(column);
  if (row === null) return null;
  await p.mouse('mouseMoved', ...sliceCellPoint((await p.center('.cs-voxels')).box, RULE_SAMPLE, row));
  const first = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
  const top = new RegExp(`^\\(-?\\d+, ${319 - row}, -?\\d+\\) · (?!air )`);
  await p.until(`/ · rule root\\S*$/.test(document.querySelector('.cs-readout').textContent)`, 'the hover rule id', 10000);
  const ruled = await p.eval<string>(`document.querySelector('.cs-readout').textContent`);
  const id = voxelRuleId(ruled);
  return {
    row, first, firstOk: voxelReadoutOk(first) && top.test(first),
    ruled, ruledOk: voxelReadoutOk(ruled) && top.test(ruled) && id !== null && id.startsWith('root.rules[1].then.'),
  };
}

/**
 * Opens the Voxels mode on the mountain line (SP3b spec §7, §11): a new page at MOUNTAIN_LINE's view, the cut line
 * clicked at its ends, Voxels selected, a fresh slice. Throws when the line drawn is not the mountain line; returns the
 * line text and the slice summary.
 */
async function openMountainVoxels(p: Page): Promise<{ readonly text: string; readonly summary: string }> {
  const { view: mv, a, b } = MOUNTAIN_LINE;
  await p.goto(`${p.base}?map#${mapHash({ ...START, view: mv })}`, MAP_READY);
  await p.click('#map-tab-world');
  await p.click('.map-cut');
  const mc = await p.center('.map-canvas');
  const at = (x: number, z: number): [number, number] => [mc.x + (x - mv.x) / mv.bpp, mc.y + (z - mv.z) / mv.bpp];
  await p.clickAt(...at(a[0], a[1]));
  await p.clickAt(...at(b[0], b[1]));
  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh cross-section of the mountain line');
  const text = await p.eval<string>(`document.querySelector('.cs-line').textContent`);
  const seg = parseSegment(text);
  if (seg === null || Math.max(Math.abs(seg.ax - a[0]), Math.abs(seg.az - a[1]), Math.abs(seg.bx - b[0]), Math.abs(seg.bz - b[1])) > 1) {
    throw new Error(`the mountain line is ${text}, expected A (${a[0]}, ${a[1]}) → B (${b[0]}, ${b[1]})`);
  }
  await p.click('.cs-mode[data-mode="voxels"]');
  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice of the mountain line');
  return { text, summary: await p.eval<string>(`document.querySelector('.cs-summary').textContent`) };
}

// ---------------------------------------------------------------- screenshots (spec §12)

async function runShots(p: Page, dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const save = async (name: string) => {
    const f = join(dir, name);
    await p.shot(f);
    out.push(f);
    console.log(`  wrote ${f}`);
  };
  console.log('\nscreenshots');
  await p.goto(`${p.base}?map#${mapHash(START)}`, MAP_READY);

  // The panel: the Rivers section with widthMin 12 (modified dot and reset, section count, a noise sub-block).
  await p.click('#map-tab-parameters');
  if (await p.eval<boolean>(`document.getElementById('pp-section-rivers').hidden`)) await p.click('.pp-section[data-path="rivers"] > .pp-section-head > .pp-toggle');
  let before = await p.hash();
  await p.typeInto('#pp-rivers.widthMin', '12');
  await p.enter();
  await p.changed(before, 'the widthMin edit');
  await p.eval(`document.querySelector('.pp-section[data-path="rivers"]').scrollIntoView({ block: 'start' }); true`);
  await sleep(1500);
  await save('panel.png');
  await p.blur();
  before = await p.hash();
  await p.undoKey();
  await p.changed(before, 'Ctrl+Z');

  // The drawer with its overlays: shape.offset at the root, a knot selected.
  if (await p.eval<boolean>(`document.getElementById('pp-section-shape').hidden`)) await p.click('.pp-section[data-path="shape"] > .pp-section-head > .pp-toggle');
  await p.click('.pp-control[data-path="shape.offset"] .pp-edit');
  await p.until(`document.querySelector('.sd-stats').dataset.state === 'fresh'`, 'fresh spline statistics');
  const knots = await p.eval<Array<{ nested: boolean; x: number; y: number }>>(`[...document.querySelectorAll('.sd-plot circle.sd-knot')].map((c) => { const r = c.getBoundingClientRect(); return { nested: c.classList.contains('sd-nested'), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const knot = knots.find((k) => !k.nested) ?? knots[Math.floor(knots.length / 2)]!;
  await p.clickAt(knot.x, knot.y);
  await sleep(1500);
  await save('drawer-overlays.png');

  // The map during a drag: the selected knot held 30 px up while the previews land.
  const end = await p.dragBy(knot.x, knot.y, 0, -3, 10);
  await sleep(1200);
  await save('map-drag.png');
  await p.mouse('mouseReleased', end.x, end.y);
  await p.until('__wiSmoke.settled()', 'settled preview after the drag');
  before = await p.hash();
  await p.blur();
  await p.undoKey();
  await p.changed(before, 'Ctrl+Z');
  await p.key('Escape', 'Escape', 27);

  // The share chart, fresh, at the top of the Biomes tab.
  await p.click('#map-tab-biomes');
  await p.until(`document.querySelector('.bs').dataset.state === 'fresh'`, 'fresh biome shares');
  await p.eval(`document.querySelector('.bs').scrollIntoView({ block: 'start' }); true`);
  await sleep(500);
  await save('shares.png');

  // The biome table with a highlighted row: the chart folded, the pointer on the plains row.
  await p.click('.bs-head');
  const row = await p.center('.bt-row[data-biome="plains"]');
  await p.mouse('mouseMoved', row.x, row.y);
  await sleep(1500);
  await save('biome-table-highlight.png');
  await p.mouse('mouseMoved', row.x - 600, row.y);

  // The presets tab with a name typed.
  await p.click('#map-tab-presets');
  await p.typeInto('#pt-name', 'smoke test');
  await sleep(300);
  await save('presets.png');

  // The cross-section: the line of the Task 23 check across a coast with rivers, gorges and a lake (4 blocks/px).
  await p.goto(`${p.base}?map#${mapHash({ ...START, view: { x: 5888, z: 3072, bpp: 4, layer: 'biome' } })}`, MAP_READY);
  await p.click('#map-tab-world');
  await p.click('.map-cut');
  const cv = await p.center('.map-canvas');
  const cx = Math.round(cv.box.x + Math.round(cv.box.width / 2));
  await p.clickAt(cx - 192, Math.round(cv.box.y + Math.round(cv.box.height / 2)));
  await p.clickAt(cx + 192, Math.round(cv.box.y + Math.round(cv.box.height / 2)));
  await p.until(`document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh cross-section');
  const frame = await p.center('.cs-plot .cs-frame');
  await p.mouse('mouseMoved', frame.box.x + (frame.box.width * 470) / 511, frame.y);
  await sleep(1500);
  await save('cross-section.png');

  // The same line in the Voxels mode (SP3a spec §5.2), the pointer under the sea near B.
  await p.click('.cs-mode[data-mode="voxels"]');
  await p.until(`document.querySelector('.cs').dataset.mode === 'voxels' && document.querySelector('.cs').dataset.state === 'fresh'`, 'a fresh voxel slice');
  const vox = await p.center('.cs-voxels');
  await p.mouse('mouseMoved', vox.box.x + vox.box.width * 0.1, vox.box.y + (vox.box.height * (319 - 50)) / 384);
  await sleep(1000);
  await save('cross-section-voxels.png');

  // The Voxels mode on the mountain line (SP3b spec §7, §11): the real T's peaks, the pointer on the top voxel of the
  // rule step's sample and the readout with its surface rule id (SP3c spec §6, §9).
  const { text, summary } = await openMountainVoxels(p);
  if (!mountainSummaryOk(summary)) throw new Error(`the mountain slice: ${summary} (expected a ground top above y 200 and no water)`);
  console.log(`  mountain line: ${text}; ${summary}`);
  const hover = await hoverTopRule(p);
  if (hover === null || !hover.ruledOk) throw new Error(`the mountain screenshot's hover: ${hover?.ruled ?? `sample ${RULE_SAMPLE} is all air`}`);
  console.log(`  hover: ${hover.ruled}`);
  await sleep(1000);
  await save('cross-section-voxels-mountain.png');
  return out;
}

// ---------------------------------------------------------------- main

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  let chrome: { readonly child: ChildProcess; readonly port: number; readonly browserWs: string } | null = null;
  let cdp: Cdp | null = null;
  let profile: string | null = null;
  const pageErrors: string[] = [];
  const ignored: string[] = [];
  const cleanup = async () => {
    cdp?.close();
    if (chrome !== null && running(chrome.child)) {
      try {
        const browser = await connect(chrome.browserWs);
        await Promise.race([browser.send('Browser.close'), sleep(3000)]).catch(() => undefined);
        browser.close();
      } catch { /* the stop below still ends it */ }
      if (running(chrome.child)) await Promise.race([new Promise<void>((r) => chrome!.child.once('exit', () => r())), sleep(5000)]);
    }
    for (const c of started) await stop(c);
    if (profile !== null) rmSync(profile, { recursive: true, force: true });
  };
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (args.build) await npmBuild();
    const port = await freePort();
    const server = await startPreview(port);
    console.log(`vite preview (pid ${server.child.pid}) on ${server.url}`);
    profile = mkdtempSync(join(resolve(args.profileDir ?? tmpdir()), 'wi10-smoke-chrome-'));
    const downloads = join(profile, 'downloads');
    mkdirSync(downloads);
    chrome = await startChrome(profile);
    console.log(`headless Chrome (pid ${chrome.child.pid}) with DevTools on port ${chrome.port}, profile ${profile}`);
    const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json() as { Browser?: string };
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.type === 'page');
    if (target === undefined) throw new Error('Chrome has no page target');
    cdp = await connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', (e) => {
      const d = e['exceptionDetails'] as { text?: string; exception?: { description?: string } };
      pageErrors.push(`exception: ${d.exception?.description ?? d.text ?? ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', (e) => {
      if (e['type'] !== 'error' && e['type'] !== 'assert') return;
      pageErrors.push(`console.${String(e['type'])}: ${(e['args'] as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description)).join(' ')}`);
    });
    cdp.on('Log.entryAdded', (e) => {
      const entry = e['entry'] as { level: string; text: string; url?: string };
      if (entry.level !== 'error') return;
      const line = `log: ${entry.text}${entry.url === undefined ? '' : ` (${entry.url})`}`;
      if (ignoredLog(entry.text, entry.url)) ignored.push(line);
      else pageErrors.push(line);
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__wiSmoke = (${pageHelpers.toString()})();` });
    console.log(`${version.Browser ?? 'Chrome'}, ${VIEWPORT.width} × ${VIEWPORT.height} CSS px at DPR 1`);

    const page = new Page(cdp, server.url);
    const smoke = new Smoke(page, downloads);
    try {
      await runSmoke(smoke);
    } catch (e) {
      smoke.check(false, `the step stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
    smoke.step('console: no page errors (the favicon.ico 404 aside)');
    for (const l of ignored) console.log(`  ignored ${l}`);
    smoke.check(pageErrors.length === 0, `${pageErrors.length} page error(s)`, pageErrors);
    if (args.shots !== null) await runShots(page, args.shots);
    if (args.shots !== null && pageErrors.length > 0) smoke.check(false, 'page errors during the screenshots', pageErrors);
    const failed = smoke.checks.filter((c) => !c.ok);
    console.log(`\nsmoke: ${smoke.checks.length - failed.length}/${smoke.checks.length} checks pass${failed.length === 0 ? '' : `; failed: ${failed.map((c) => `${c.step} — ${c.what}`).join('; ')}`}`);
    return failed.length === 0 ? 0 : 1;
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

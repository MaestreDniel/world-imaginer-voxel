/**
 * The SP2b §2.8 latency runner (not in CI): edit → preview latency of the ?map editor on the reference
 * machine (D16). Run it with `node test/tools/mapLatency.ts [options]`: Node 24 strips the types, CDP runs
 * over the global WebSocket, and nothing is added to the dependencies.
 *
 * It runs `npm run build`, serves dist with its own `vite preview --host 127.0.0.1 --port <P> --strictPort`
 * (P: a free port found by binding port 0, never 5183) and treats the server as ready only when that child
 * prints its URL. It launches its own headless Chrome with a temporary profile (in the OS temp directory or
 * --profile-dir; Chrome's own singleton socket stays in $TMPDIR, whose path must be short) and its own
 * DevTools port, loads `?map&perf=edit` once per page load with the layer in the URL state, asserts
 * `crossOriginIsolated`, `pool.abortable` and the pinned 1100 × 825 canvas at DPR 1 (4 preview and 24
 * level-64 tiles), and never switches layers or moves the view. At the end it stops only what it started.
 *
 * Every edit goes through `globalThis.__wiPerf` (src/ui/map/perfHook.ts). The gated edit is `shape.offset`
 * knot [6, 0, 1] with y = 97 + k/64 for the k-th edit of a page load, so no value repeats and no tile comes
 * from the cache. Per page load:
 * - A, idle: the pool empty and the driver settled, then 2 s of rest; 20 edits.
 * - B, busy: 120 ms after each A edit's preview, `setWhenBusy` once a level-64 job is in flight; 20 edits.
 * - C, sustained: after a rest, 30 edits, each 100 ms after the previous preview.
 * - D, drag: after a rest, `beginGesture()`, 3 s of `set` calls at 30 Hz (then at 60 Hz), then
 *   `endGesture()`, the release; 5 drags per rate.
 * Gated (pass): biome and relief, 3 page loads each: max ≤ 300 ms in A, B, C and for every release in D;
 * in D a preview lands at least every 500 ms (counted from the first edit to the release); no blank draw.
 * Reported, not gated (1 page load each): the offset layer under the same edit, and biome-size slider steps
 * (`climate.scaleMul` table values, one position at a time) on the biome and relief layers. Each slider step
 * of A, B and C follows its own unmeasured knot edit (a "setup") and moves to the next position cyclically
 * (…, 9, 10, 1, 2, …), so that no world repeats although the table has 10 values; each slider drag follows one
 * setup and then sweeps the positions one step at a time, turning at 1 and 10, as a hand does (repeats inside
 * a drag hit the tile cache, as they would for a hand).
 *
 * Output: docs/superpowers/specs/assets/sp2b/latency-<layer>.json (p50, p95 and max per condition, the
 * latencies, the breakdown phases and the pass verdict). Options: --layers biome,relief (gated layers),
 * --loads 3, --no-reported, --skip-build, --quick (3 pairs, 5 chained edits, 1 drag per rate; writes nothing
 * unless --out is given), --out DIR, --profile-dir DIR. The exit code is 0 only when every gated run passes and no page error
 * was seen.
 */
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PerfApi, PerfInfo, PerfRecord } from '../../src/ui/map/perfHook';

/** The map layers (src/gen/map/layers.ts LAYERS; a unit test keeps them equal). */
export const MAP_LAYERS: readonly string[] = ['biome', 'relief', 'rivers', 'lakes', 'C', 'E', 'PV', 'W', 'T', 'H', 'R', 'offset', 'sigma', 'jag'];
export const LIMIT_MS = 300;
export const GAP_LIMIT_MS = 500;
const DEV_PORT = 5183;
const CHROME = '/usr/bin/google-chrome';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_OUT = join(ROOT, 'docs/superpowers/specs/assets/sp2b');
const REST_MS = 2000;
const BUSY_DELAY_MS = 120;
const CHAIN_GAP_MS = 100;
const DRAG_SECONDS = 3;
const DRAG_RATES = [30, 60] as const;

// ---------------------------------------------------------------- pure parts (unit-tested)

/** The y of the k-th knot edit of a page load: new for every edit, exact under q15, between the knot's neighbours. */
export function knotY(k: number): number {
  return 97 + k / 64;
}

/** The URL fragment of the perf state for `layer`: base64url of the canonical JSON the page writes. */
export function perfHash(layer: string): string {
  const json = `{"patch":{},"profile":"default","seed":"42","v":1,"view":{"bpp":64,"layer":${JSON.stringify(layer)},"x":0,"z":0}}`;
  return Buffer.from(json, 'utf8').toString('base64url');
}

export interface Summary { readonly n: number; readonly p50: number | null; readonly p95: number | null; readonly max: number | null }

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Nearest-rank p50 and p95 and the max, rounded to 0.1 ms. */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
  return { n: s.length, p50: round1(rank(50)), p95: round1(rank(95)), max: round1(s[s.length - 1]!) };
}

/** The longest stretch without a landing: from the drag's first edit, between landings, and to the release. */
export function maxGap(begin: number, landings: readonly number[], end: number): number {
  let prev = begin;
  let gap = 0;
  for (const t of [...landings, end]) {
    gap = Math.max(gap, t - prev);
    prev = t;
  }
  return gap;
}

/**
 * n biome-size positions after `start` for separate steps: the next position, wrapping from 10 to 1. A position
 * never equals the one two steps before, so a step after a setup never returns to the setup's world.
 */
export function scaleCycle(start: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => ((start + i) % 10) + 1);
}

/** n biome-size positions after `start` for a drag: one step at a time, turning at 1 and 10. */
export function scaleSteps(start: number, n: number): number[] {
  const out: number[] = [];
  let v = start;
  let dir = start >= 10 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    if (v + dir > 10 || v + dir < 1) dir = -dir;
    v += dir;
    out.push(v);
  }
  return out;
}

export interface Phases { readonly posted: Summary; readonly barrier: Summary; readonly preview: Summary; readonly draw: Summary }

export interface ConditionResult extends Summary {
  /** null for a row that is reported, not gated. */
  readonly pass: boolean | null;
  readonly blankDraws: number;
  readonly latencies: readonly number[];
  /** input → configure posted, → all ready, → preview jobs done, → drawn. */
  readonly phases: Phases;
}

const latencyOf = (r: PerfRecord): number => {
  if (r.latencyMs === null) throw new Error(`record ${r.id} did not land`);
  return r.latencyMs;
};
const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

export function conditionResult(records: readonly PerfRecord[], blankDraws: number, gated: boolean): ConditionResult {
  const lat = records.map(latencyOf);
  const phase = (f: (r: PerfRecord) => number | null): Summary => summarize(records.map(f).filter((v): v is number => v !== null));
  return {
    ...summarize(lat),
    pass: gated ? lat.length > 0 && Math.max(...lat) <= LIMIT_MS && blankDraws === 0 : null,
    blankDraws,
    latencies: lat.map(round1),
    phases: {
      posted: phase((r) => diff(r.configurePostedAt, r.inputAt)),
      barrier: phase((r) => diff(r.readyAt, r.configurePostedAt)),
      preview: phase((r) => diff(r.previewDoneAt, r.readyAt)),
      draw: phase((r) => diff(r.drawnAt, r.previewDoneAt)),
    },
  };
}

export interface DragSample { readonly begin: number; readonly end: number; readonly landings: readonly number[]; readonly release: PerfRecord }

export interface DragResult {
  readonly n: number;
  readonly releases: Summary;
  readonly releaseLatencies: readonly number[];
  /** Per drag: the longest stretch without a landing. */
  readonly maxGapMs: readonly number[];
  /** Per drag: previews landed during the drag. */
  readonly landings: readonly number[];
  readonly blankDraws: number;
  readonly pass: boolean | null;
}

export function dragResult(drags: readonly DragSample[], blankDraws: number, gated: boolean): DragResult {
  const rel = drags.map((d) => latencyOf(d.release));
  const gaps = drags.map((d) => maxGap(d.begin, d.landings, d.end));
  return {
    n: drags.length,
    releases: summarize(rel),
    releaseLatencies: rel.map(round1),
    maxGapMs: gaps.map(round1),
    landings: drags.map((d) => d.landings.length),
    blankDraws,
    pass: gated ? drags.length > 0 && Math.max(...rel) <= LIMIT_MS && Math.max(...gaps) <= GAP_LIMIT_MS && blankDraws === 0 : null,
  };
}

export interface RunnerArgs {
  readonly layers: readonly string[];
  readonly loads: number;
  readonly reported: boolean;
  readonly build: boolean;
  readonly quick: boolean;
  readonly out: string | null;
  /** The parent of the temporary Chrome profile (default: the OS temp directory). */
  readonly profileDir: string | null;
}

export function parseArgs(argv: readonly string[]): RunnerArgs {
  let layers: string[] = ['biome', 'relief'];
  let loads = 3;
  let reported = true;
  let build = true;
  let quick = false;
  let out: string | null = null;
  let profileDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--layers') {
      layers = value().split(',');
      for (const l of layers) if (!MAP_LAYERS.includes(l)) throw new Error(`unknown layer ${l}`);
    } else if (a === '--loads') {
      loads = Number(value());
      if (!Number.isInteger(loads) || loads < 1) throw new Error('--loads needs a positive integer');
    } else if (a === '--no-reported') reported = false;
    else if (a === '--skip-build') build = false;
    else if (a === '--quick') quick = true;
    else if (a === '--out') out = value();
    else if (a === '--profile-dir') profileDir = value();
    else throw new Error(`unknown argument ${a}`);
  }
  return { layers, loads, reported, build, quick, out, profileDir };
}

// ---------------------------------------------------------------- the page side (sent as source text)

type PageEdit = { readonly kind: 'knot'; readonly y: number } | { readonly kind: 'scale'; readonly position: number };
interface PairStep { readonly setup: PageEdit | null; readonly a: PageEdit; readonly b: PageEdit; readonly restMs: number; readonly busyDelayMs: number }
interface PairResult { readonly a: PerfRecord; readonly b: PerfRecord; readonly blankA: number; readonly blankB: number }
interface ChainStep { readonly restMs: number; readonly gapMs: number; readonly steps: ReadonlyArray<{ readonly setup: PageEdit | null; readonly edit: PageEdit }> }
interface ChainResult { readonly records: PerfRecord[]; readonly blank: number }
interface DragStep { readonly setup: PageEdit | null; readonly restMs: number; readonly hz: number; readonly edits: readonly PageEdit[] }
interface DragOut extends DragSample { readonly blank: number }
interface PageSteps {
  pair(s: PairStep): Promise<PairResult>;
  chain(s: ChainStep): Promise<ChainResult>;
  drag(s: DragStep): Promise<DragOut>;
}

/**
 * The page-side steps, installed as `globalThis.__wiRun` from this function's source: it may use nothing
 * outside its body. Timing runs in the page, so CDP round trips never enter a measurement.
 */
function pageSteps(): PageSteps {
  const perf = (globalThis as unknown as { __wiPerf: PerfApi }).__wiPerf;
  const LAND_MS = 20000;
  const IDLE_MS = 60000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const arg = (e: PageEdit): [string, unknown] => e.kind === 'knot'
    ? ['shape.offset', perf.withKnotY('shape.offset', [6, 0, 1], e.y)]
    : ['climate.scaleMul', perf.biomeSizeScale[e.position - 1]];
  const edit = (e: PageEdit): Promise<PerfRecord> => {
    const [path, value] = arg(e);
    return perf.waitLanded(perf.set(path, value), LAND_MS);
  };
  const rest = async (ms: number) => {
    await perf.waitIdle(IDLE_MS);
    await sleep(ms);
    if (!perf.idle()) throw new Error('the pool woke up during the rest');
  };
  const whenBusy = async (e: PageEdit): Promise<PerfRecord> => {
    const [path, value] = arg(e);
    const until = performance.now() + LAND_MS;
    for (;;) {
      const id = perf.setWhenBusy(path, value);
      if (id !== false) return perf.waitLanded(id, LAND_MS);
      if (performance.now() > until) throw new Error('no level-64 job came in flight');
      await frame();
    }
  };
  return {
    async pair(s) {
      const b0 = perf.blankDraws();
      if (s.setup !== null) await edit(s.setup);
      await rest(s.restMs);
      const a = await edit(s.a);
      const b1 = perf.blankDraws();
      await sleep(s.busyDelayMs);
      const b = await whenBusy(s.b);
      return { a, b, blankA: b1 - b0, blankB: perf.blankDraws() - b1 };
    },
    async chain(s) {
      await rest(s.restMs);
      const b0 = perf.blankDraws();
      const records: PerfRecord[] = [];
      for (const st of s.steps) {
        if (st.setup !== null) {
          await edit(st.setup);
          await sleep(s.gapMs);
        }
        records.push(await edit(st.edit));
        await sleep(s.gapMs);
      }
      return { records, blank: perf.blankDraws() - b0 };
    },
    async drag(s) {
      if (s.setup !== null) await edit(s.setup);
      await rest(s.restMs);
      const b0 = perf.blankDraws();
      const period = 1000 / s.hz;
      const begin = perf.beginGesture();
      for (let i = 0; i < s.edits.length; i++) {
        const wait = begin + i * period - performance.now();
        if (wait > 0) await sleep(wait);
        const [path, value] = arg(s.edits[i]!);
        perf.set(path, value);
      }
      const wait = begin + s.edits.length * period - performance.now();
      if (wait > 0) await sleep(wait);
      const release = await perf.waitLanded(perf.endGesture(), LAND_MS);
      const end = release.inputAt;
      const landings = perf.landings().filter((l) => l.at > begin && l.at <= end).map((l) => l.at);
      return { begin, end, landings, release, blank: perf.blankDraws() - b0 };
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
    '--window-size=1600,1000', 'about:blank',
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

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
  if (ex !== undefined) throw new Error(`page: ${ex.exception?.description ?? ex.text ?? 'evaluation failed'}`);
  return (r['result'] as { value?: unknown }).value as T;
}

const step = <T>(cdp: Cdp, name: keyof PageSteps, arg: unknown): Promise<T> => evaluate<T>(cdp, `globalThis.__wiRun.${name}(${JSON.stringify(arg)})`);

// ---------------------------------------------------------------- runs

type EditKind = 'knot' | 'scale';
interface RunSpec { readonly layer: string; readonly edit: EditKind; readonly loads: number; readonly gated: boolean }
interface Counts { readonly pairs: number; readonly chain: number; readonly drags: number }

interface LoadOut {
  readonly info: PerfInfo;
  readonly A: PerfRecord[];
  readonly B: PerfRecord[];
  readonly C: PerfRecord[];
  readonly D: Record<string, DragSample[]>;
  readonly blank: { A: number; B: number; C: number; D: Record<string, number> };
  readonly blankTotal: number;
}

export interface RunResult {
  readonly layer: string;
  readonly edit: string;
  readonly gated: boolean;
  readonly loads: number;
  readonly conditions: Readonly<Record<string, ConditionResult | DragResult>>;
  /** B: level-64 jobs in flight when setWhenBusy called set (min, max). */
  readonly busyFineJobs: readonly [number, number];
  readonly blankDraws: number;
  readonly pass: boolean | null;
}

const EDIT_TEXT: Readonly<Record<EditKind, string>> = {
  knot: 'shape.offset knot [6, 0, 1], y = 97 + k/64 for the k-th edit of a page load',
  scale: 'climate.scaleMul biome-size table steps (one position at a time), each A/B/C step after its own knot setup',
};

async function navigate(cdp: Cdp, url: string): Promise<void> {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 300; i++) {
    if (await evaluate<boolean>(cdp, `typeof globalThis.__wiPerf === 'object'`)) return;
    await sleep(100);
  }
  throw new Error(`no __wiPerf on ${url} after 30 s`);
}

async function runLoad(cdp: Cdp, base: string, spec: RunSpec, counts: Counts): Promise<LoadOut> {
  await navigate(cdp, `${base}?map&perf=edit#${perfHash(spec.layer)}`);
  await evaluate(cdp, '__wiPerf.waitIdle(60000)');
  const info = await evaluate<PerfInfo>(cdp, '__wiPerf.info()');
  const problems = [
    info.crossOriginIsolated ? '' : 'crossOriginIsolated is false',
    info.abortable ? '' : 'pool.abortable is false',
    info.devicePixelRatio === 1 ? '' : `devicePixelRatio ${info.devicePixelRatio}`,
    info.canvas.width === 1100 && info.canvas.height === 825 && info.css.width === 1100 && info.css.height === 825 ? '' : `canvas ${JSON.stringify(info.canvas)}, css ${JSON.stringify(info.css)}`,
    info.previewTiles === 4 && info.targetTiles === 24 ? '' : `${info.previewTiles} preview and ${info.targetTiles} target tiles`,
    info.seedText === '42' && info.profile === 'default' && info.view.layer === spec.layer && info.view.x === 0 && info.view.z === 0 && info.view.bpp === 64 ? '' : `state ${JSON.stringify([info.seedText, info.profile, info.view])}`,
    (await evaluate<number>(cdp, '__wiPerf.landings().length')) > 0 ? '' : 'the first preview never landed',
  ].filter((p) => p !== '');
  if (problems.length > 0) throw new Error(`perf page not as specified: ${problems.join('; ')}`);
  await evaluate(cdp, `globalThis.__wiRun = (${pageSteps.toString()})(); true`);

  let k = 0;
  const knot = (): PageEdit => ({ kind: 'knot', y: knotY(k++) });
  /** The draft's biome-size position (the default profile's scaleMul 1 is position 5). */
  let position = 5;
  const measured = (): PageEdit => {
    if (spec.edit === 'knot') return knot();
    position = scaleCycle(position, 1)[0]!;
    return { kind: 'scale', position };
  };
  const sweep = (n: number): PageEdit[] => {
    if (spec.edit === 'knot') return Array.from({ length: n }, knot);
    const ps = scaleSteps(position, n);
    position = ps[ps.length - 1]!;
    return ps.map((p) => ({ kind: 'scale', position: p }));
  };
  const setup = (): PageEdit | null => (spec.edit === 'knot' ? null : knot());

  const out: LoadOut = { info, A: [], B: [], C: [], D: {}, blank: { A: 0, B: 0, C: 0, D: {} }, blankTotal: 0 };
  for (let i = 0; i < counts.pairs; i++) {
    const r = await step<PairResult>(cdp, 'pair', { setup: setup(), a: measured(), b: measured(), restMs: REST_MS, busyDelayMs: BUSY_DELAY_MS });
    out.A.push(r.a);
    out.B.push(r.b);
    out.blank.A += r.blankA;
    out.blank.B += r.blankB;
    process.stdout.write(`    pair ${i + 1}/${counts.pairs}: A ${r.a.latencyMs?.toFixed(1)} ms, B ${r.b.latencyMs?.toFixed(1)} ms\n`);
  }
  const steps = Array.from({ length: counts.chain }, () => ({ setup: setup(), edit: measured() }));
  const c = await step<ChainResult>(cdp, 'chain', { restMs: REST_MS, gapMs: CHAIN_GAP_MS, steps });
  out.C.push(...c.records);
  out.blank.C += c.blank;
  process.stdout.write(`    chain: ${c.records.map((r) => r.latencyMs?.toFixed(0)).join(' ')} ms\n`);
  for (const hz of DRAG_RATES) {
    const key = `D${hz}`;
    out.D[key] = [];
    out.blank.D[key] = 0;
    for (let i = 0; i < counts.drags; i++) {
      const s = setup();
      const edits = sweep(DRAG_SECONDS * hz);
      const d = await step<DragOut>(cdp, 'drag', { setup: s, restMs: REST_MS, hz, edits });
      out.D[key]!.push(d);
      out.blank.D[key]! += d.blank;
      process.stdout.write(`    drag ${hz} Hz ${i + 1}/${counts.drags}: release ${d.release.latencyMs?.toFixed(1)} ms, ${d.landings.length} landings, max gap ${maxGap(d.begin, d.landings, d.end).toFixed(0)} ms\n`);
    }
  }
  return { ...out, blankTotal: await evaluate<number>(cdp, '__wiPerf.blankDraws()') };
}

function runResult(spec: RunSpec, loads: readonly LoadOut[]): RunResult {
  const all = <T>(f: (l: LoadOut) => readonly T[]): T[] => loads.flatMap(f);
  const sum = (f: (l: LoadOut) => number): number => loads.reduce((s, l) => s + f(l), 0);
  const conditions: Record<string, ConditionResult | DragResult> = {
    A: conditionResult(all((l) => l.A), sum((l) => l.blank.A), spec.gated),
    B: conditionResult(all((l) => l.B), sum((l) => l.blank.B), spec.gated),
    C: conditionResult(all((l) => l.C), sum((l) => l.blank.C), spec.gated),
  };
  for (const hz of DRAG_RATES) {
    const key = `D${hz}`;
    conditions[key] = dragResult(all((l) => l.D[key] ?? []), sum((l) => l.blank.D[key] ?? 0), spec.gated);
  }
  const fine = all((l) => l.B).map((r) => r.probe?.jobs.filter((j) => j.level === 64).length ?? 0);
  const blankDraws = sum((l) => l.blankTotal);
  const passes = Object.values(conditions).map((c) => c.pass);
  return {
    layer: spec.layer, edit: EDIT_TEXT[spec.edit], gated: spec.gated, loads: loads.length, conditions,
    busyFineJobs: [fine.length === 0 ? 0 : Math.min(...fine), fine.length === 0 ? 0 : Math.max(...fine)],
    blankDraws,
    pass: spec.gated ? passes.every((p) => p === true) && blankDraws === 0 : null,
  };
}

function printRun(r: RunResult): void {
  console.log(`\n${r.layer} · ${r.gated ? 'gated' : 'reported'} · ${r.edit} · ${r.loads} page load(s) · blank draws ${r.blankDraws}${r.pass === null ? '' : r.pass ? ' · PASS' : ' · FAIL'}`);
  for (const [name, c] of Object.entries(r.conditions)) {
    const s = 'releases' in c ? c.releases : c;
    const extra = 'releases' in c ? `  max gap ${Math.max(...c.maxGapMs)} ms, landings/drag ${Math.min(...c.landings)}-${Math.max(...c.landings)}` : '';
    console.log(`  ${name.padEnd(4)} n ${String(s.n).padStart(3)}  p50 ${String(s.p50).padStart(6)}  p95 ${String(s.p95).padStart(6)}  max ${String(s.max).padStart(6)} ms${extra}${c.pass === null ? '' : c.pass ? '  pass' : '  FAIL'}`);
  }
}

const primitive = (v: unknown): boolean => v === null || typeof v !== 'object';
const flat = (v: unknown): boolean => primitive(v) || (Array.isArray(v) && v.every(primitive));

/** JSON indented by 2 spaces, with arrays of primitives and objects whose values are such arrays or primitives on one line. */
export function compactJson(v: unknown, indent = ''): string {
  if (primitive(v)) return JSON.stringify(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.every(primitive)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    return `[\n${v.map((x) => inner + compactJson(x, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.every(([, x]) => flat(x))) return `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${compactJson(x)}`).join(', ')}}`;
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${compactJson(x, inner)}`).join(',\n')}\n${indent}}`;
}

const gitDescribe = (): string => {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const counts: Counts = args.quick ? { pairs: 3, chain: 5, drags: 1 } : { pairs: 20, chain: 30, drags: 5 };
  const out = args.out ?? (args.quick ? null : DEFAULT_OUT);
  const specs: RunSpec[] = args.layers.map((layer) => ({ layer, edit: 'knot', loads: args.loads, gated: true }));
  if (args.reported) specs.push({ layer: 'offset', edit: 'knot', loads: 1, gated: false }, { layer: 'biome', edit: 'scale', loads: 1, gated: false }, { layer: 'relief', edit: 'scale', loads: 1, gated: false });

  let chrome: { readonly child: ChildProcess; readonly port: number; readonly browserWs: string } | null = null;
  let preview: ChildProcess | null = null;
  let page: Cdp | null = null;
  let profile: string | null = null;
  const pageErrors: string[] = [];
  const cleanup = async () => {
    page?.close();
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
    preview = server.child;
    console.log(`vite preview (pid ${preview.pid}) on ${server.url}`);
    profile = mkdtempSync(join(args.profileDir ?? tmpdir(), 'wi10-latency-chrome-'));
    chrome = await startChrome(profile);
    console.log(`headless Chrome (pid ${chrome.child.pid}) with DevTools on port ${chrome.port}, profile ${profile}`);
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.type === 'page');
    if (target === undefined) throw new Error('Chrome has no page target');
    page = await connect(target.webSocketDebuggerUrl);
    const p = page;
    p.on('Runtime.exceptionThrown', (e) => {
      const d = e['exceptionDetails'] as { text?: string; exception?: { description?: string } };
      pageErrors.push(`exception: ${d.exception?.description ?? d.text ?? ''}`);
    });
    p.on('Runtime.consoleAPICalled', (e) => {
      if (e['type'] !== 'error') return;
      pageErrors.push(`console.error: ${(e['args'] as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description)).join(' ')}`);
    });
    await p.send('Runtime.enable');
    await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json() as { Browser?: string };

    const results: RunResult[] = [];
    let info: PerfInfo | null = null;
    for (const spec of specs) {
      const loads: LoadOut[] = [];
      for (let i = 0; i < spec.loads; i++) {
        console.log(`${spec.layer} · ${spec.edit} · page load ${i + 1}/${spec.loads}`);
        const l = await runLoad(p, server.url, spec, counts);
        info = l.info;
        loads.push(l);
      }
      const r = runResult(spec, loads);
      results.push(r);
      printRun(r);
    }
    if (pageErrors.length > 0) console.log(`\npage errors:\n${pageErrors.join('\n')}`);
    if (out !== null && info !== null) {
      mkdirSync(out, { recursive: true });
      for (const layer of [...new Set(results.map((r) => r.layer))]) {
        const doc = {
          spec: 'SP2b §2.8 (test/tools/mapLatency.ts)', date: new Date().toISOString().slice(0, 10), source: gitDescribe(),
          machine: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} threads)`, node: process.version, browser: version.Browser ?? 'unknown',
          page: { ...info, view: { ...info.view, layer } },
          limits: { maxMs: LIMIT_MS, dragGapMs: GAP_LIMIT_MS }, pageErrors,
          runs: results.filter((r) => r.layer === layer),
        };
        const file = join(out, `latency-${layer}.json`);
        writeFileSync(file, `${compactJson(doc)}\n`);
        console.log(`wrote ${file}`);
      }
    }
    const failed = results.filter((r) => r.pass === false).map((r) => r.layer);
    console.log(failed.length === 0 && pageErrors.length === 0 ? '\nall gated runs pass' : `\nfailed: ${[...failed, ...(pageErrors.length > 0 ? ['page errors'] : [])].join(', ')}`);
    return failed.length === 0 && pageErrors.length === 0 ? 0 : 1;
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

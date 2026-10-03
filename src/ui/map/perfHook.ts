/**
 * The latency hook (SP2b spec §2.8). `?map&perf=edit` loads it through a dynamic import, so the editor's
 * chunk does not carry it. It pins the map canvas to 1100 × 825 CSS px and opens seed 42 with the default
 * profile, no patch, view (0, 0, 64 bpp) and the layer of the URL state: 4 preview tiles and 24 level-64
 * tiles, as in the baseline. It exposes `globalThis.__wiPerf` to test/tools/mapLatency.ts: edits through
 * the session exactly as the editors make them (urgency follows spec §1.3), latency records with their
 * breakdown (input → configure posted → all ready → preview jobs done → drawn), the canvas's blank-draw
 * counter and the pool probe. The latency log and the instrumented pool are pure and unit-tested; the
 * rest is the page wiring, checked by the runner.
 *
 * A record lands at the end of the first draw in which every visible level-256 position shows a tile of
 * the source of its draft or of a newer draft (the canvas reports progress after every draw whose source
 * is the pool's epoch). A record whose draft is already on screen when the call returns lands at once
 * with latency 0 (a release whose last draft has landed).
 */
import type { MapLevel } from '../../core/constants';
import { withKnotY } from '../../core/spline/hermite';
import type { KnotPath } from '../../core/spline/types';
import type { SessionResult, WorldSession } from '../../engine/session';
import type { PoolProbe, WorkerPool } from '../../engine/workerPool';
import { levelFor } from '../../gen/map/tile';
import { splineOfLeaf } from '../../metrics/splineStats';
import { isSplineLeaf } from '../splineEditor/model';
import { BIOME_SIZE_SCALE } from './biomeSize';
import type { MapCanvas } from './mapView';
import type { MapState, MapView } from './mapState';
import type { PreviewDriver } from './previewDriver';
import { visibleTiles } from './viewMath';

export const PERF_CANVAS_WIDTH = 1100;
export const PERF_CANVAS_HEIGHT = 825;

/** The state a perf page opens with: seed 42, the default profile, no patch, view (0, 0, 64 bpp) and the URL's layer. */
export function perfMapState(decoded: MapState): MapState {
  return { v: 1, seed: '42', profile: 'default', patch: {}, view: { x: 0, z: 0, bpp: 64, layer: decoded.view.layer } };
}

/** One hook call that edits the draft. */
export interface PerfEdit {
  readonly kind: 'set' | 'endGesture';
  /** The parameter path of a set, else null. */
  readonly path: string | null;
  /** performance.now() at the hook call (spec §2.8 inputAt). */
  readonly inputAt: number;
  /** The session epoch after the call. */
  readonly sessionEpoch: number;
  readonly urgent: boolean;
  /** The pool probe a setWhenBusy read before its set, else null. */
  readonly probe: PoolProbe | null;
}

/** A latency record: the edit, then its breakdown once a draw shows its draft or a newer one. */
export interface PerfRecord extends PerfEdit {
  readonly id: number;
  /** The pool epoch of the source whose draw landed the record. */
  readonly poolEpoch: number | null;
  /** When that source's configure was posted to every worker. */
  readonly configurePostedAt: number | null;
  /** When every worker had answered that configure (the ready barrier). */
  readonly readyAt: number | null;
  /** When the last level-256 tile job of that source returned; null when every preview tile came from the cache. */
  readonly previewDoneAt: number | null;
  /** The end of the draw that landed the record. */
  readonly drawnAt: number | null;
  /** drawnAt − inputAt. */
  readonly latencyMs: number | null;
  /** The draft was already on screen when the call returned. */
  readonly alreadyShown: boolean;
}

/** The first draw showing a source at every visible level-256 position. */
export interface PerfLanding { readonly poolEpoch: number; readonly sessionEpoch: number; readonly at: number }

export interface LatencyLog {
  /** A session state: the configures carry its params object, which identifies the draft. */
  draft(params: object, sessionEpoch: number): void;
  configurePosted(poolEpoch: number, params: object, at: number): void;
  configureReady(poolEpoch: number, at: number): void;
  /** A superseded or failed configure: it can land nothing. */
  configureFailed(poolEpoch: number): void;
  /** A tile job of `poolEpoch` returned; level-256 jobs time the preview. */
  tileDone(poolEpoch: number, level: MapLevel, at: number): void;
  /** The canvas's progress after a draw: `nearestDrawn` of `visible` level-256 positions show the source `poolEpoch`. */
  drawn(poolEpoch: number, nearestDrawn: number, visible: number, at: number): void;
  edit(e: PerfEdit): PerfRecord;
  record(id: number): PerfRecord | null;
  /** Records with an id from `fromId` (default 1) on, in call order. */
  records(fromId?: number): PerfRecord[];
  landings(): PerfLanding[];
  /** Resolves when the record lands (at once when it has); rejects for an unknown id. */
  whenLanded(id: number): Promise<PerfRecord>;
}

interface Configure { readonly postedAt: number; params: object | null; sessionEpoch: number | null; readyAt: number | null }
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function createLatencyLog(): LatencyLog {
  const epochOf = new WeakMap<object, number>();
  const configures = new Map<number, Configure>();
  /** Per pool epoch: when its last level-256 tile job returned. */
  const previewDone = new Map<number, number>();
  const records: Array<Mutable<PerfRecord>> = [];
  const pending = new Set<Mutable<PerfRecord>>();
  const landings: PerfLanding[] = [];
  const waiters = new Map<number, Array<(r: PerfRecord) => void>>();

  const view = (r: Mutable<PerfRecord>): PerfRecord => ({ ...r, latencyMs: r.drawnAt === null ? null : r.drawnAt - r.inputAt });
  /** The session epoch of a configure's draft; the page posts a configure before the hook hears of its draft. */
  const sessionEpochOf = (c: Configure): number | null => {
    if (c.sessionEpoch === null && c.params !== null) {
      const e = epochOf.get(c.params);
      if (e !== undefined) {
        c.sessionEpoch = e;
        c.params = null;
      }
    }
    return c.sessionEpoch;
  };
  const land = (r: Mutable<PerfRecord>) => {
    pending.delete(r);
    const ws = waiters.get(r.id);
    if (ws === undefined) return;
    waiters.delete(r.id);
    for (const w of ws) w(view(r));
  };

  return {
    draft(params, sessionEpoch) { epochOf.set(params, sessionEpoch); },
    configurePosted(poolEpoch, params, at) { configures.set(poolEpoch, { postedAt: at, params, sessionEpoch: null, readyAt: null }); },
    configureReady(poolEpoch, at) {
      const c = configures.get(poolEpoch);
      if (c === undefined) return;
      c.readyAt = at;
      sessionEpochOf(c);
    },
    configureFailed(poolEpoch) {
      configures.delete(poolEpoch);
      previewDone.delete(poolEpoch);
    },
    tileDone(poolEpoch, level, at) {
      if (level !== 256) return;
      const was = previewDone.get(poolEpoch);
      if (was === undefined || at > was) previewDone.set(poolEpoch, at);
    },
    drawn(poolEpoch, nearestDrawn, visible, at) {
      if (visible === 0 || nearestDrawn < visible) return;
      const last = landings[landings.length - 1];
      if (last !== undefined && poolEpoch <= last.poolEpoch) return;
      const c = configures.get(poolEpoch);
      if (c === undefined || c.readyAt === null) return;
      const s = sessionEpochOf(c);
      if (s === null) return;
      landings.push({ poolEpoch, sessionEpoch: s, at });
      const done = previewDone.get(poolEpoch) ?? null;
      for (const r of [...pending]) {
        if (r.sessionEpoch > s) continue;
        r.poolEpoch = poolEpoch;
        r.configurePostedAt = c.postedAt;
        r.readyAt = c.readyAt;
        r.previewDoneAt = done;
        r.drawnAt = at;
        land(r);
      }
      // Older sources can no longer land anything.
      for (const k of [...configures.keys()]) if (k <= poolEpoch) configures.delete(k);
      for (const k of [...previewDone.keys()]) if (k <= poolEpoch) previewDone.delete(k);
    },
    edit(e) {
      const r: Mutable<PerfRecord> = {
        id: records.length + 1, ...e,
        poolEpoch: null, configurePostedAt: null, readyAt: null, previewDoneAt: null, drawnAt: null, latencyMs: null, alreadyShown: false,
      };
      records.push(r);
      const last = landings[landings.length - 1];
      if (last !== undefined && e.sessionEpoch <= last.sessionEpoch) {
        r.poolEpoch = last.poolEpoch;
        r.drawnAt = e.inputAt;
        r.alreadyShown = true;
      } else pending.add(r);
      return view(r);
    },
    record(id) {
      const r = records[id - 1];
      return r === undefined ? null : view(r);
    },
    records(fromId = 1) { return records.slice(Math.max(0, fromId - 1)).map(view); },
    landings() { return landings.slice(); },
    whenLanded(id) {
      const r = records[id - 1];
      if (r === undefined) return Promise.reject(new Error(`no record ${id}`));
      if (r.drawnAt !== null) return Promise.resolve(view(r));
      return new Promise((resolve) => {
        const ws = waiters.get(id) ?? [];
        ws.push(resolve);
        waiters.set(id, ws);
      });
    },
  };
}

/** The pool as the page uses it, with every configure and tile job timed into `log`. */
export function instrumentPool(pool: WorkerPool, log: LatencyLog, now: () => number): WorkerPool {
  return {
    get size() { return pool.size; },
    get epoch() { return pool.epoch; },
    get abortable() { return pool.abortable; },
    get queued() { return pool.queued; },
    configure(seedText, params) {
      const p = pool.configure(seedText, params);
      const e = pool.epoch;
      if (typeof params === 'object' && params !== null) log.configurePosted(e, params, now());
      p.then(() => log.configureReady(e, now()), () => log.configureFailed(e));
      return p;
    },
    tile(req, priority) {
      const e = pool.epoch;
      const p = pool.tile(req, priority);
      p.then(() => log.tileDone(e, req.level, now()), () => undefined);
      return p;
    },
    point: (x, z, priority) => pool.point(x, z, priority),
    spawn: () => pool.spawn(),
    stats: (kind, n, args, priority) => pool.stats(kind, n, args, priority),
    slice: (segment, priority) => pool.slice(segment, priority),
    selftest: (key) => pool.selftest(key),
    cancelTiles: (pred) => pool.cancelTiles(pred),
    probe: () => pool.probe(),
    terminate: () => pool.terminate(),
  };
}

/** Sizes the map host so the canvas is 1100 × 825 CSS px whatever the panel and drawer sizes. */
export function pinMapHost(host: HTMLElement): void {
  host.style.width = `${PERF_CANVAS_WIDTH}px`;
  host.style.height = `${PERF_CANVAS_HEIGHT}px`;
  host.style.justifySelf = 'start';
  host.style.alignSelf = 'start';
}

export interface PerfInfo {
  readonly crossOriginIsolated: boolean;
  readonly abortable: boolean;
  readonly poolSize: number;
  readonly hardwareConcurrency: number;
  readonly devicePixelRatio: number;
  readonly userAgent: string;
  /** The canvas in pixels and its host in CSS px. */
  readonly canvas: { readonly width: number; readonly height: number };
  readonly css: { readonly width: number; readonly height: number };
  readonly seedText: string;
  readonly profile: string;
  readonly view: MapView;
  /** Visible level-256 tiles and tiles of the view's level. */
  readonly previewTiles: number;
  readonly targetTiles: number;
}

/** `globalThis.__wiPerf`. */
export interface PerfApi {
  info(): PerfInfo;
  /** session.set as the editors call it; returns the record id. Throws when the session refuses the value. */
  set(path: string, value: unknown): number;
  /** session.beginGesture(); returns its input time. */
  beginGesture(): number;
  /** session.endGesture() (the release); returns the record id. */
  endGesture(): number;
  /** Reads the pool probe and, in the same task, calls set when a tile job of the view's level (64) is in flight; else false. */
  setWhenBusy(path: string, value: unknown): number | false;
  /** The draft's spline at a spline leaf `path` with the knot at `knot` set to y. */
  withKnotY(path: string, knot: KnotPath, y: number): unknown;
  /** The biome-size slider's climate.scaleMul values, position 1 first (spec §6.4). */
  readonly biomeSizeScale: readonly number[];
  probe(): PoolProbe;
  /** No job in flight or queued, no configure pending, and the driver settled. */
  idle(): boolean;
  waitIdle(timeoutMs: number): Promise<void>;
  waitLanded(id: number, timeoutMs: number): Promise<PerfRecord>;
  records(fromId?: number): PerfRecord[];
  landings(): PerfLanding[];
  blankDraws(): number;
  now(): number;
}

/** What the hook needs from the mounted page. */
export interface PerfPage {
  readonly session: WorldSession;
  readonly canvas: MapCanvas;
  readonly driver: PreviewDriver;
  readonly host: HTMLElement;
  view(): MapView;
  /** Runs a session call as an editor's input event does, with `at` as its input time. */
  editAt<T>(at: number, fn: () => T): T;
}

/** The page's side of the hook, in the order the page calls it. */
export interface PerfHook {
  initialState(decoded: MapState): MapState;
  /** Pins the map host before the canvas is created. */
  pin(host: HTMLElement): void;
  /** The pool the page uses. */
  instrument(pool: WorkerPool): WorkerPool;
  /** The canvas's progress after a draw; the page calls it before the driver's previewProgress. */
  drawn(poolEpoch: number, nearestDrawn: number, visible: number): void;
  /** Installs `globalThis.__wiPerf` once the page is mounted. */
  attach(page: PerfPage): void;
}

const IDLE_POLL_MS = 20;

export function createPerfHook(): PerfHook {
  const log = createLatencyLog();
  const now = () => performance.now();
  let pool: WorkerPool | null = null;
  return {
    initialState: perfMapState,
    pin: pinMapHost,
    instrument(p) {
      pool = instrumentPool(p, log, now);
      return pool;
    },
    drawn(poolEpoch, nearestDrawn, visible) { log.drawn(poolEpoch, nearestDrawn, visible, now()); },
    attach(page) {
      const p = pool;
      if (p === null) throw new Error('perf hook: the page must use the instrumented pool');
      const { session, canvas, driver, editAt } = page;
      log.draft(session.state.params, session.state.epoch);
      session.subscribe((s) => log.draft(s.params, s.epoch));

      const set = (path: string, value: unknown, probe: PoolProbe | null): number => {
        const at = now();
        const r: SessionResult = editAt(at, () => session.set(path, value));
        if (!r.ok) throw new Error(`perf: ${path} refused: ${r.issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
        return log.edit({ kind: 'set', path, inputAt: at, sessionEpoch: session.state.epoch, urgent: !session.inGesture, probe }).id;
      };
      const idle = (): boolean => {
        const q = p.probe();
        const st = driver.status;
        return q.busy === 0 && q.queued === 0 && !q.configuring && st.settled && !st.pending;
      };
      const element = (): HTMLCanvasElement | null => page.host.querySelector('canvas');

      const api: PerfApi = {
        info() {
          const v = page.view();
          const c = element();
          const w = c?.width ?? 0;
          const h = c?.height ?? 0;
          return {
            crossOriginIsolated: globalThis.crossOriginIsolated === true, abortable: p.abortable, poolSize: p.size,
            hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio: globalThis.devicePixelRatio, userAgent: navigator.userAgent,
            canvas: { width: w, height: h }, css: { width: page.host.clientWidth, height: page.host.clientHeight },
            seedText: session.state.seedText, profile: session.state.profile, view: v,
            previewTiles: visibleTiles(v, w, h, 256).length, targetTiles: visibleTiles(v, w, h, levelFor(v.bpp)).length,
          };
        },
        set: (path, value) => set(path, value, null),
        beginGesture() {
          const at = now();
          editAt(at, () => session.beginGesture());
          return at;
        },
        endGesture() {
          const at = now();
          editAt(at, () => session.endGesture());
          return log.edit({ kind: 'endGesture', path: null, inputAt: at, sessionEpoch: session.state.epoch, urgent: true, probe: null }).id;
        },
        setWhenBusy(path, value) {
          const q = p.probe();
          const fine = levelFor(page.view().bpp);
          return q.jobs.some((j) => j.level === fine) ? set(path, value, q) : false;
        },
        withKnotY(path, knot, y) {
          if (!isSplineLeaf(path)) throw new Error(`perf: ${path} is not a spline leaf`);
          return withKnotY(splineOfLeaf(session.state.params, path), knot, y);
        },
        biomeSizeScale: BIOME_SIZE_SCALE,
        probe: () => p.probe(),
        idle,
        waitIdle(timeoutMs) {
          const until = now() + timeoutMs;
          return new Promise((resolve, reject) => {
            const poll = () => {
              if (idle()) resolve();
              else if (now() > until) reject(new Error(`perf: not idle after ${timeoutMs} ms`));
              else setTimeout(poll, IDLE_POLL_MS);
            };
            poll();
          });
        },
        waitLanded(id, timeoutMs) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`perf: record ${id} did not land within ${timeoutMs} ms`)), timeoutMs);
            log.whenLanded(id).then((r) => { clearTimeout(timer); resolve(r); }, (e: unknown) => { clearTimeout(timer); reject(e); });
          });
        },
        records: (fromId) => log.records(fromId),
        landings: () => log.landings(),
        blankDraws: () => canvas.blankDraws,
        now,
      };
      (globalThis as unknown as { __wiPerf?: PerfApi }).__wiPerf = api;
    },
  };
}

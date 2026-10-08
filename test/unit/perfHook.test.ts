import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createWorkerPool, type WorkerLike } from '../../src/engine/workerPool';
import { DEFAULT_MAP_STATE } from '../../src/ui/map/mapState';
import { createLatencyLog, instrumentPool, PERF_CANVAS_HEIGHT, PERF_CANVAS_WIDTH, perfMapState, type PerfEdit } from '../../src/ui/map/perfHook';
import { visibleTiles } from '../../src/ui/map/viewMath';
import { createTaskHandler } from '../../src/workers/taskHandler';

/** Distinct params objects: the log tells drafts apart by identity, as the page's configures carry them. */
const P = Array.from({ length: 4 }, () => ({}));
const set = (inputAt: number, sessionEpoch: number, urgent = true): PerfEdit => ({ kind: 'set', path: 'shape.offset', inputAt, sessionEpoch, urgent, probe: null });

describe('perf page state (SP2b spec §2.8)', () => {
  test('seed 42, the default profile, no patch and view (0, 0, 64 bpp); only the layer comes from the URL', () => {
    const decoded = { ...DEFAULT_MAP_STATE, seed: '7', profile: 'large_biomes' as const, patch: { climate: { scaleMul: 2 } }, view: { x: 5, z: -6, bpp: 4, layer: 'relief' as const } };
    expect(perfMapState(decoded)).toEqual({ v: 1, seed: '42', profile: 'default', patch: {}, view: { x: 0, z: 0, bpp: 64, layer: 'relief' } });
  });
  test('the pinned 1100 × 825 canvas shows 4 preview tiles and 24 level-64 tiles, as in the baseline', () => {
    const view = perfMapState(DEFAULT_MAP_STATE).view;
    expect([PERF_CANVAS_WIDTH, PERF_CANVAS_HEIGHT]).toEqual([1100, 825]);
    expect(visibleTiles(view, PERF_CANVAS_WIDTH, PERF_CANVAS_HEIGHT, 256).length).toBe(4);
    expect(visibleTiles(view, PERF_CANVAS_WIDTH, PERF_CANVAS_HEIGHT, 64).length).toBe(24);
  });
});

describe('latency log (SP2b spec §2.8)', () => {
  test('an edit lands at the first draw that shows its source at every visible preview position, with its configure\'s breakdown', () => {
    const log = createLatencyLog();
    log.draft(P[0]!, 0);
    log.configurePosted(0, P[0]!, 1);
    log.configureReady(0, 3);
    log.drawn(0, 4, 4, 5);
    // The page posts the configure inside session.set, before the hook's own listener sees the new draft.
    log.configurePosted(1, P[1]!, 10.5);
    log.draft(P[1]!, 1);
    const r = log.edit(set(10, 1));
    expect([r.id, r.drawnAt, r.latencyMs]).toEqual([1, null, null]);
    log.configureReady(1, 12);
    log.tileDone(1, 256, 50);
    log.tileDone(1, 64, 85);
    log.drawn(1, 2, 4, 70);
    expect(log.record(r.id)?.drawnAt).toBeNull();
    log.tileDone(1, 256, 80);
    log.drawn(1, 4, 4, 90);
    log.tileDone(1, 256, 95);
    log.drawn(1, 4, 4, 107);
    expect(log.record(r.id)).toEqual({
      id: 1, kind: 'set', path: 'shape.offset', inputAt: 10, sessionEpoch: 1, urgent: true, probe: null,
      poolEpoch: 1, configurePostedAt: 10.5, readyAt: 12, previewDoneAt: 80, drawnAt: 90, latencyMs: 80, alreadyShown: false,
    });
    expect(log.landings()).toEqual([{ poolEpoch: 0, sessionEpoch: 0, at: 5 }, { poolEpoch: 1, sessionEpoch: 1, at: 90 }]);
  });

  test('a newer source lands older edits; a superseded configure and the progress of an older source land nothing', () => {
    const log = createLatencyLog();
    log.configurePosted(0, P[0]!, 0);
    log.draft(P[0]!, 0);
    const a = log.edit(set(1, 0, false));
    log.configurePosted(1, P[1]!, 2);
    log.draft(P[1]!, 1);
    const b = log.edit(set(3, 1, false));
    log.configureFailed(0);
    log.configureReady(1, 6);
    log.drawn(1, 4, 4, 40);
    log.drawn(0, 4, 4, 41);
    expect([log.record(a.id)?.poolEpoch, log.record(a.id)?.drawnAt, log.record(a.id)?.configurePostedAt, log.record(b.id)?.latencyMs]).toEqual([1, 40, 2, 37]);
    expect(log.landings()).toEqual([{ poolEpoch: 1, sessionEpoch: 1, at: 40 }]);
  });

  test('an edit waits for a later draft\'s configure when its own source never lands', () => {
    const log = createLatencyLog();
    log.configurePosted(0, P[0]!, 0);
    log.draft(P[0]!, 0);
    log.configureReady(0, 1);
    log.drawn(0, 4, 4, 2);
    log.draft(P[1]!, 1);
    const r = log.edit(set(10, 1, false));
    log.draft(P[2]!, 2);
    // The cycle of draft 1 was never started (latest wins): draft 2's source lands it.
    log.configurePosted(1, P[2]!, 20);
    log.configureReady(1, 22);
    log.drawn(1, 3, 4, 30);
    expect(log.record(r.id)?.drawnAt).toBeNull();
    log.drawn(1, 4, 4, 31);
    expect(log.record(r.id)).toMatchObject({ poolEpoch: 1, configurePostedAt: 20, readyAt: 22, previewDoneAt: null, drawnAt: 31, latencyMs: 21 });
  });

  test('an edit whose draft is already on screen lands at once with latency 0 (a gestureEnd after the last draft landed)', () => {
    const log = createLatencyLog();
    log.configurePosted(0, P[0]!, 0);
    log.draft(P[0]!, 0);
    log.configureReady(0, 1);
    log.drawn(0, 4, 4, 2);
    const r = log.edit({ kind: 'endGesture', path: null, inputAt: 9, sessionEpoch: 0, urgent: true, probe: null });
    expect(r).toMatchObject({ poolEpoch: 0, configurePostedAt: null, readyAt: null, previewDoneAt: null, drawnAt: 9, latencyMs: 0, alreadyShown: true });
  });

  test('no visible preview position, or an unready configure, lands nothing', () => {
    const log = createLatencyLog();
    log.configurePosted(0, P[0]!, 0);
    log.draft(P[0]!, 0);
    const r = log.edit(set(0, 0));
    log.drawn(0, 0, 0, 5);
    log.drawn(0, 4, 4, 6);
    expect([log.record(r.id)?.drawnAt, log.landings()]).toEqual([null, []]);
    log.configureReady(0, 7);
    log.drawn(0, 0, 0, 8);
    log.drawn(0, 4, 4, 9);
    expect(log.record(r.id)?.drawnAt).toBe(9);
  });

  test('whenLanded resolves at the landing draw, or at once for a landed record; records(from) lists from an id', async () => {
    const log = createLatencyLog();
    log.configurePosted(0, P[0]!, 0);
    log.draft(P[0]!, 0);
    const first = log.edit(set(0, 0));
    const second = log.edit(set(1, 0));
    const waiting = log.whenLanded(second.id);
    log.configureReady(0, 2);
    log.drawn(0, 4, 4, 3);
    expect((await waiting).drawnAt).toBe(3);
    expect((await log.whenLanded(first.id)).drawnAt).toBe(3);
    await expect(log.whenLanded(99)).rejects.toThrow(/no record 99/);
    expect(log.records(2).map((r) => r.id)).toEqual([2]);
    expect(log.records().map((r) => r.id)).toEqual([1, 2]);
  });
});

/** A worker running the real handler asynchronously. */
function handlerWorker(): WorkerLike {
  const h = createTaskHandler();
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) { setTimeout(() => w.onmessage?.({ data: h.handle(msg).msg }), 0); },
    terminate() {},
  };
  return w;
}

describe('instrumented pool (SP2b spec §2.8)', () => {
  test('logs configure posted and ready and the preview jobs done, and otherwise behaves as the pool', async () => {
    const raw = createWorkerPool(2, handlerWorker);
    const log = createLatencyLog();
    let t = 0;
    const pool = instrumentPool(raw, log, () => ++t);
    log.draft(DEFAULTS, 0);
    const r = log.edit(set(0.5, 0));
    const ready = await pool.configure('42', DEFAULTS);
    expect([ready.epoch, pool.epoch, pool.size, pool.abortable, pool.queued]).toEqual([0, raw.epoch, 2, false, 0]);
    const tiles = [pool.tile({ layer: 'C', level: 256, tx: 0, tz: 0 }, 0), pool.tile({ layer: 'C', level: 64, tx: 0, tz: 0 }, 1000)];
    expect(pool.probe()).toEqual(raw.probe());
    expect(pool.probe().jobs.map((j) => j.level)).toEqual([256, 64]);
    await Promise.all(tiles);
    log.drawn(0, 1, 1, 100);
    expect(log.record(r.id)).toMatchObject({ poolEpoch: 0, configurePostedAt: 1, readyAt: 2, previewDoneAt: 3, drawnAt: 100, latencyMs: 99.5 });
    expect((await pool.point(1, 2)).z).toBe(2);
    // Slice jobs (SP3a spec §5.1) pass through untimed.
    expect((await pool.slice({ ax: 0, az: 0, bx: 40, bz: 3 })).blocks.length).toBe(512 * 384);
    // So do surfaceProbe jobs (SP3c spec §6).
    expect(await pool.surfaceProbe(0, -64, 0)).toEqual({ state: 2, path: [] });
    expect((await pool.surfaceProbe(0, -30, 0)).path).toEqual(['root', 'root.rules[2]', 'root.rules[2].then']);
    pool.terminate();
  });
});

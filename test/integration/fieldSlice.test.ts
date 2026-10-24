import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createWorkerPool, type WorkerLike } from '../../src/engine/workerPool';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { evaluateFieldSlice, sliceCostOf, type FieldSliceValues, type SliceField, type SliceGeometry, type TColumnSource } from '../../src/gen/inspect/fieldSlice';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { DRAFT_BUDGET, PART_BUDGET, planFieldSlice, type FieldSliceSpec } from '../../src/workers/protocol';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import { paramsWith } from '../harness/gen';
import { partWorstParams } from '../harness/sliceTrees';
import { heavyDetailPatch } from '../unit/fixtures/editedTrees';

/**
 * The fieldSlice job in real worker threads (SP3d spec §5.2, §10 "Workers"):
 * - the pool's split over N `worker_threads` running `src/workers/taskHandler.ts` merges into exactly the single
 *   evaluation (every field and plane; pool sizes 1, 2, 3 and 6), the values and fluid arriving as transferred buffers;
 * - a configure (a new epoch in the epoch cells) stops an in-flight part within 50 ms, with the default tree and with
 *   `slice.partWorst`'s tree at the part bound (`test/harness/sliceTrees.ts`), and a `rule` part on a heavy valid tree
 *   (`heavyDetailPatch`) whose probe column takes about 0.1 s to fill, as `abort.test.ts` times tiles: from
 *   `Atomics.store` here to `handle` returning in the worker (`handledAt`, on the clock every thread shares). The
 *   evaluation polls the cell once per sample and the probe column's density fill every 8 corner rows, so the bound is
 *   one sample's time or one eighth of a column fill; the timing tests retry twice.
 */
const MOUNTAIN: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const COAST: Segment = { ax: -27136, az: -31992, bx: -26113, bz: -31992 };
const NEVER = (): boolean => false;

let plain = '';
let stamped = '';
const threads: Worker[] = [];

beforeAll(async () => {
  plain = await buildNodeTaskWorker('fieldSliceThreads');
  stamped = await buildNodeTaskWorker('fieldSliceAbort', { stamp: true });
}, 120_000);

afterAll(async () => {
  await Promise.all(threads.map((t) => t.terminate()));
});

const start = (script: string): Worker => {
  const t = new Worker(script);
  threads.push(t);
  return t;
};

/** A worker thread behind the pool's WorkerLike interface. */
function threadWorker(): WorkerLike {
  const t = start(plain);
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg, transfer) { t.postMessage(msg, (transfer ?? []) as never); },
    terminate() { void t.terminate(); },
  };
  t.on('message', (data: unknown) => w.onmessage?.({ data }));
  t.on('error', (e) => w.onerror?.(e));
  return w;
}

const bytes = (v: ArrayBufferView): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const freshCtx = (params: Params): GenContext => createGenContext(seedFromInput('42'), params);

function storeColumns(ctx: GenContext): TColumnSource {
  const store = createStore({ shared: false, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
  return (cx, cz, stop) => (store.proto(cx, cz) === null && !fillColumnT(store, ctx, cx, cz, stop) ? null : store.proto(cx, cz));
}

const vReq = (s: Segment, field: SliceField, path = '', n = 32): FieldSliceSpec => ({ plane: 'vertical', ...s, y: 63, n, field, path });
const hReq = (field: SliceField, path = '', n = 32): FieldSliceSpec => ({ plane: 'horizontal', cx: -1152, cz: 8, y: 100, extent: 8192, n, field, path });
const geometryOf = (r: FieldSliceSpec): SliceGeometry => (r.plane === 'vertical'
  ? { plane: 'vertical', n: r.n, pointAt: (i) => segmentPointAt(r, i, r.n) }
  : { plane: 'horizontal', n: r.n, cx: r.cx, cz: r.cz, y: r.y, extent: r.extent });

/** The samples [from, to) evaluated in this thread on a fresh context. */
function inProcess(params: Params, r: FieldSliceSpec, from = 0, to = r.n): FieldSliceValues {
  const ctx = freshCtx(params);
  return evaluateFieldSlice(ctx, { geometry: geometryOf(r), field: r.field, path: r.path, from, to }, NEVER, r.field === 'blocks' ? storeColumns(ctx) : undefined)!;
}

const REQUESTS: Array<[string, FieldSliceSpec]> = [
  ['vertical density', vReq(MOUNTAIN, 'density')],
  ['vertical node', vReq(MOUNTAIN, 'node', 'root.a.a.x.x')],
  ['horizontal density', hReq('density')],
  ['horizontal node', hReq('node', 'root.a.b')],
  ['vertical blocks', vReq(COAST, 'blocks')],
  ['vertical rule', vReq(COAST, 'rule', 'root.rules[1].then')],
];

describe('fieldSlice in real worker threads (SP3d spec §5.2, §10)', () => {
  const wants = new Map(REQUESTS.map(([name, r]) => [name, inProcess(DEFAULTS, r)]));

  test.each([[1], [2], [3], [6]])('pool of %i threads: every field and plane merges bit-identical to the single evaluation, split by planFieldSlice', async (size) => {
    const pool = createWorkerPool(size, threadWorker);
    await pool.configure('42', DEFAULTS);
    for (const [name, req] of REQUESTS) {
      const refusable = req.field === 'density' || req.field === 'node';
      // The real column cost, then (density and node) a client cost PART_BUDGET / 4 that forces parts of 4 sample columns.
      for (const columnCost of refusable ? [sliceCostOf(DEFAULTS, req.field, req.path, req.plane, req.n), PART_BUDGET / 4] : [sliceCostOf(DEFAULTS, req.field, req.path, req.plane, req.n)]) {
        const budget = columnCost === PART_BUDGET / 4 ? 2 ** 40 : DRAFT_BUDGET;
        const plan = planFieldSlice(req.n, columnCost, size, refusable ? budget : null);
        if (plan.refused) throw new Error(`${name}: refused`);
        const r = await pool.fieldSlice(req, { priority: 500, columnCost, budget }).promise;
        const want = wants.get(name)!;
        expect([r.n, r.field, plan.ranges.length >= Math.min(size, req.n)], name).toEqual([32, req.field, true]);
        expect(bytes(r.values).equals(bytes(want.values)), `${name} values, ${plan.ranges.length} parts`).toBe(true);
        expect(r.fluid === null ? null : bytes(r.fluid).equals(bytes(want.fluid!)), `${name} fluid`).toBe(want.fluid === null ? null : true);
      }
    }
    pool.terminate();
  }, 180_000);
});

/** Milliseconds on the clock the worker's `handledAt` uses (test/harness/nodeWorker.ts). */
const clock = () => Number(process.hrtime.bigint()) / 1e6;
/** Blocks this thread for `ms` without using a CPU, as a loaded runner delays the delivery of the worker's reply here. */
const stall = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const configure = (epoch: number, params: Params, epochs: SharedArrayBuffer | null) => ({ type: 'configure', epoch, seedText: '42', params, epochs });

describe('a configure stops an in-flight fieldSlice part within 50 ms (SP3d spec §4.5, §10)', () => {
  // A part as large as the work bound allows: the default tree's 128² vertical part of k = 79 sample columns
  // (8,342,400 units), and partWorst's one 32-sample column (8,387,616 units, one sample ≈ 2 ms).
  const CASES: Array<[string, Params, FieldSliceSpec, number]> = [
    ['the default tree, a 128² vertical part of 79 sample columns', DEFAULTS, vReq(MOUNTAIN, 'density', '', 128), 79],
    ['partWorst\'s tree at the part bound, one 32-sample column', partWorstParams(), vReq(MOUNTAIN, 'density', '', 32), 1],
  ];

  test.each(CASES)('%s: ABORTED within 50 ms of Atomics.store; the next epoch\'s part equals the in-process evaluation', { retry: 2, timeout: 120_000 }, async (_name, params, req, to) => {
    expect(sliceCostOf(params, 'density', '', 'vertical', req.n) * to).toBeLessThanOrEqual(PART_BUDGET);
    expect(sliceCostOf(params, 'density', '', 'vertical', req.n) * to).toBeGreaterThan(PART_BUDGET * 0.99);
    const cell = new Int32Array(new SharedArrayBuffer(16));
    const w = start(stamped);
    Atomics.store(cell, 0, 1);
    expect((await ask(w, configure(1, params, cell.buffer)))['type']).toBe('ready');
    const part = (jobId: number, epoch: number) => ({ type: 'fieldSlice', jobId, epoch, scope: epoch, ...req, from: 0, to });
    // The part takes ≈ 65-90 ms on one thread (the calibration's p50s); the store lands within its first samples.
    const reply = ask(w, part(1, 1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const storedAt = clock();
    Atomics.store(cell, 0, 2);
    stall(60);
    const m = await reply;
    expect(m).toMatchObject({ type: 'error', jobId: 1, epoch: 1, code: 'ABORTED' });
    const stopMs = (m['handledAt'] as number) - storedAt;
    expect(stopMs, 'the stamp is after the store on the shared clock').toBeGreaterThan(0);
    expect(stopMs, `the handler returned ${stopMs.toFixed(1)} ms after the store`).toBeLessThan(50);

    expect((await ask(w, configure(2, params, cell.buffer)))['type']).toBe('ready');
    const next = await ask(w, part(2, 2));
    expect(next).toMatchObject({ type: 'fieldSliceResult', jobId: 2, epoch: 2, n: req.n, field: 'density', from: 0, to });
    expect(Buffer.from(next['values'] as ArrayBuffer).equals(bytes(inProcess(params, req, 0, to).values))).toBe(true);
  });

  test('a heavy valid tree (heavyDetailPatch), a vertical rule part of one sample column: ABORTED within 50 ms of Atomics.store while its probe column fills', { retry: 2, timeout: 120_000 }, async () => {
    const params = paramsWith(heavyDetailPatch(32));
    const req = vReq(MOUNTAIN, 'rule', 'root.rules[1].then', 32);
    // A rule column costs one T column: k = 1, so a part is one sample column whose probe column takes about 0.1 s.
    const plan = planFieldSlice(32, sliceCostOf(params, 'rule', req.path, 'vertical', 32), 1, null);
    if (plan.refused) throw new Error('a rule slice is never refused');
    expect(plan.k).toBe(1);
    const cell = new Int32Array(new SharedArrayBuffer(16));
    const w = start(stamped);
    Atomics.store(cell, 0, 1);
    expect((await ask(w, configure(1, params, cell.buffer)))['type']).toBe('ready');
    const part = (jobId: number, epoch: number) => ({ type: 'fieldSlice', jobId, epoch, scope: epoch, ...req, from: 0, to: 1 });
    const reply = ask(w, part(1, 1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const storedAt = clock();
    Atomics.store(cell, 0, 2);
    stall(60);
    const m = await reply;
    expect(m).toMatchObject({ type: 'error', jobId: 1, epoch: 1, code: 'ABORTED' });
    const stopMs = (m['handledAt'] as number) - storedAt;
    expect(stopMs, 'the stamp is after the store on the shared clock').toBeGreaterThan(0);
    expect(stopMs, `the handler returned ${stopMs.toFixed(1)} ms after the store`).toBeLessThan(50);

    expect((await ask(w, configure(2, params, cell.buffer)))['type']).toBe('ready');
    const next = await ask(w, part(2, 2));
    expect(next).toMatchObject({ type: 'fieldSliceResult', jobId: 2, epoch: 2, n: 32, field: 'rule', from: 0, to: 1 });
    expect(Buffer.from(next['values'] as ArrayBuffer).equals(bytes(inProcess(params, req, 0, 1).values))).toBe(true);
  });
});

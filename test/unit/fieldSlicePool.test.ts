import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { GenContext } from '../../src/gen/context';
import { evaluateFieldSlice, probeField, sliceCostOf, type FieldSliceValues, type SliceField, type SliceGeometry, type TColumnSource } from '../../src/gen/inspect/fieldSlice';
import { createWorkerPool, JobCancelled, SliceTooHeavy, type WorkerLike, type WorkerPool } from '../../src/engine/workerPool';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { DRAFT_BUDGET, PART_BUDGET, planFieldSlice, REQUEST_BUDGET, type FieldSliceSpec, type ToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

const NEVER = (): boolean => false;
const MOUNTAIN: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const COAST: Segment = { ax: -27136, az: -31992, bx: -26113, bz: -31992 };

/** A worker running the real handler asynchronously; `edit` may rewrite its replies. */
function fakeWorker(log: ToWorker[], edit: (reply: Record<string, unknown>) => unknown = (r) => r): WorkerLike {
  const h = createTaskHandler();
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) {
      log.push(msg);
      setTimeout(() => w.onmessage?.({ data: edit(h.handle(msg).msg as unknown as Record<string, unknown>) }), 0);
    },
    terminate() {},
  };
  return w;
}
/** A worker running the real handler that holds its fieldSlice messages until flush(). */
function heldWorker(log: ToWorker[], replies: unknown[]): WorkerLike & { flush(): void } {
  const h = createTaskHandler();
  const held: ToWorker[] = [];
  const answer = (msg: ToWorker) => {
    const data = h.handle(msg).msg;
    replies.push(data);
    setTimeout(() => w.onmessage?.({ data }), 0);
  };
  const w: WorkerLike & { flush(): void } = {
    onmessage: null,
    postMessage(msg) {
      log.push(msg);
      if (msg.type === 'fieldSlice') held.push(msg);
      else setTimeout(() => answer(msg), 0);
    },
    flush() { for (const m of held.splice(0)) answer(m); },
    terminate() {},
  };
  return w;
}
const settle = <T>(p: Promise<T>): Promise<T | Error> => p.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
const partsOf = (log: readonly ToWorker[]) => log.flatMap((m) => (m.type === 'fieldSlice' ? [[m.from, m.to]] : []));
const bytes = (v: ArrayBufferView): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

function storeColumns(ctx: GenContext): TColumnSource {
  const store = createStore({ shared: false, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
  return (cx, cz, stop) => (store.proto(cx, cz) === null && !fillColumnT(store, ctx, cx, cz, stop) ? null : store.proto(cx, cz));
}

const vReq = (s: Segment, field: SliceField, path = '', n = 32): FieldSliceSpec => ({ plane: 'vertical', ...s, y: 63, n, field, path });
const hReq = (field: SliceField, path = '', n = 32): FieldSliceSpec => ({ plane: 'horizontal', cx: -1152, cz: 8, y: 100, extent: 2048, n, field, path });
const geometryOf = (r: FieldSliceSpec): SliceGeometry => (r.plane === 'vertical'
  ? { plane: 'vertical', n: r.n, pointAt: (i) => segmentPointAt(r, i, r.n) }
  : { plane: 'horizontal', n: r.n, cx: r.cx, cz: r.cz, y: r.y, extent: r.extent });
const costOf = (r: FieldSliceSpec) => sliceCostOf(DEFAULTS, r.field, r.path, r.plane, r.n);

/** The whole slice evaluated in one piece in-process (the single-worker reference). */
const single = (r: FieldSliceSpec): FieldSliceValues => {
  const ctx = ctxFor('42');
  return evaluateFieldSlice(ctx, { geometry: geometryOf(r), field: r.field, path: r.path, from: 0, to: r.n }, NEVER, r.field === 'blocks' ? storeColumns(ctx) : undefined)!;
};

const REQUESTS: Array<[string, FieldSliceSpec]> = [
  ['vertical density', vReq(MOUNTAIN, 'density')],
  ['vertical node', vReq(MOUNTAIN, 'node', 'root.a.a.x.x')],
  ['horizontal density', hReq('density')],
  ['horizontal node', hReq('node', 'root.a.b')],
  ['vertical blocks', vReq(COAST, 'blocks')],
  ['vertical rule', vReq(COAST, 'rule', 'root.rules[1].then')],
];

describe('pool.fieldSlice: split, merge and refusals (SP3d spec §5.1, §5.2)', () => {
  const wants = new Map(REQUESTS.map(([name, r]) => [name, single(r)]));

  test.each([[1], [2], [3], [6]])('pool.size %i: the merged slice of every field and plane is bit-identical to the single evaluation, split by planFieldSlice', async (size) => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(size, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    for (const [name, req] of REQUESTS) {
      // The real column cost within the draft budget, then a client cost PART_BUDGET / 4 (over a budget that admits it)
      // that forces parts of 4 sample columns.
      for (const [columnCost, budget] of [[costOf(req), DRAFT_BUDGET], [req.field === 'density' || req.field === 'node' ? PART_BUDGET / 4 : null, 2 ** 40]] as const) {
        if (columnCost === null) continue;
        log.length = 0;
        const r = await pool.fieldSlice(req, { priority: 500, columnCost, budget }).promise;
        const want = wants.get(name)!;
        expect([r.n, r.field], name).toEqual([32, req.field]);
        expect(bytes(r.values).equals(bytes(want.values)), `${name} values, cost ${columnCost}`).toBe(true);
        expect(r.fluid === null ? null : bytes(r.fluid).equals(bytes(want.fluid!)), `${name} fluid`).toBe(want.fluid === null ? null : true);
        const plan = planFieldSlice(32, columnCost, size, req.field === 'blocks' || req.field === 'rule' ? null : budget);
        if (plan.refused) throw new Error('refused');
        expect(partsOf(log), name).toEqual(plan.ranges);
      }
    }
    pool.terminate();
  }, 120_000);
  test('a 128² vertical density slice at the defaults runs as 6 parts of at most k = 79 sample columns on 6 workers', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(6, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    const req = vReq(MOUNTAIN, 'density', '', 128);
    const r = await pool.fieldSlice(req, { priority: 500, columnCost: costOf(req), budget: REQUEST_BUDGET }).promise;
    expect(partsOf(log)).toEqual([[0, 21], [21, 42], [42, 64], [64, 85], [85, 106], [106, 128]]);
    expect(bytes(r.values).equals(bytes(single(req).values))).toBe(true);
    pool.terminate();
  }, 60_000);
  test('the parts are one group at the given priority: a draft at 2 runs after preview tiles at distance 0 and 1, before 3', async () => {
    const order: string[] = [];
    const pool = createWorkerPool(1, () => {
      const w = fakeWorker([]);
      const post = w.postMessage.bind(w);
      w.postMessage = (m) => { if (m.type !== 'configure') order.push(m.type === 'mapTile' ? `tile ${m.tx}` : `${m.type} ${m.type === 'fieldSlice' ? m.from : ''}`); post(m); };
      return w;
    });
    const ready = pool.configure('42', DEFAULTS);
    const req = vReq(MOUNTAIN, 'density');
    const jobs = [pool.tile({ layer: 'C', level: 256, tx: 3, tz: 0 }, 3), pool.fieldSlice(req, { priority: 2, columnCost: PART_BUDGET / 16, budget: DRAFT_BUDGET }).promise,
      pool.tile({ layer: 'C', level: 256, tx: 0, tz: 0 }, 0), pool.tile({ layer: 'C', level: 256, tx: 1, tz: 0 }, 1)];
    await ready;
    await Promise.all(jobs);
    expect(order).toEqual(['tile 0', 'tile 1', 'fieldSlice 0', 'fieldSlice 16', 'tile 3']);
    pool.terminate();
  });
  test('a density or node request above its budget is refused before any job (SliceTooHeavy with the cost and the limit); blocks and rule never are', async () => {
    const log: ToWorker[] = [];
    const pool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    for (const [req, budget] of [[vReq(MOUNTAIN, 'density', '', 128), REQUEST_BUDGET], [hReq('node', 'root.a.b'), DRAFT_BUDGET]] as const) {
      const limit = Math.floor(budget / req.n);
      const e = await settle(pool.fieldSlice(req, { priority: 500, columnCost: limit + 1, budget }).promise);
      expect(e).toBeInstanceOf(SliceTooHeavy);
      expect([(e as SliceTooHeavy).columnCost, (e as SliceTooHeavy).limit, (e as Error).message]).toEqual([limit + 1, limit, `too heavy: column cost ${limit + 1}, limit ${limit}`]);
    }
    expect([log.filter((m) => m.type === 'fieldSlice'), pool.queued]).toEqual([[], 0]);
    const r = await pool.fieldSlice(vReq(COAST, 'rule', 'root.rules[2]'), { priority: 500, columnCost: 2 ** 31, budget: 1 }).promise;
    expect(r.values.length).toBe(32 * 32);
    expect(partsOf(log).length).toBe(32);
    await expect(pool.fieldSlice(vReq(MOUNTAIN, 'density'), { priority: 500, columnCost: 0, budget: DRAFT_BUDGET }).promise).rejects.toThrow(RangeError);
    pool.terminate();
  });
  test('the worker\'s bound check refuses a client column cost below its own (BAD_ARGS, too heavy), and a bad request rejects with its BAD_ARGS', async () => {
    const pool = createWorkerPool(1, () => fakeWorker([]));
    await pool.configure('42', DEFAULTS);
    await expect(pool.fieldSlice(vReq(MOUNTAIN, 'density', '', 128), { priority: 500, columnCost: 1, budget: REQUEST_BUDGET }).promise).rejects.toThrow(/^BAD_ARGS: too heavy: 128 × 105600/);
    await expect(pool.fieldSlice(vReq(MOUNTAIN, 'node', 'root.nope'), { priority: 500, columnCost: 1, budget: DRAFT_BUDGET }).promise).rejects.toThrow(/^BAD_ARGS: path "root.nope" names no node/);
    await expect(pool.fieldSlice(hReq('blocks'), { priority: 500, columnCost: 1, budget: DRAFT_BUDGET }).promise).rejects.toThrow(/^BAD_ARGS: field blocks has no horizontal slice/);
    pool.terminate();
  });
  test('cancel() drops the queued parts (JobCancelled); running parts finish and their results are discarded (P1); the pool goes on', async () => {
    const log: ToWorker[] = [];
    const replies: unknown[] = [];
    const held = [heldWorker(log, replies), heldWorker(log, replies)];
    let k = 0;
    const pool = createWorkerPool(2, () => held[k++]!);
    await pool.configure('42', DEFAULTS);
    const req = vReq(MOUNTAIN, 'density');
    // k = 8: four parts, two running and two queued.
    const h = pool.fieldSlice(req, { priority: 500, columnCost: PART_BUDGET / 8, budget: 2 ** 40 });
    const got = settle(h.promise);
    expect([pool.probe().busy, pool.queued, partsOf(log)]).toEqual([2, 2, [[0, 8], [8, 16]]]);
    h.cancel();
    expect(await got).toBeInstanceOf(JobCancelled);
    expect([pool.probe().busy, pool.queued]).toEqual([2, 0]);
    for (const w of held) w.flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(replies.map((r) => (r as { type: string }).type).filter((t) => t !== 'ready')).toEqual(['fieldSliceResult', 'fieldSliceResult']);
    expect([pool.probe().busy, partsOf(log).length]).toEqual([0, 2]);
    h.cancel();
    const next = pool.fieldSlice(req, { priority: 500, columnCost: costOf(req), budget: DRAFT_BUDGET });
    await new Promise((r) => setTimeout(r, 0));
    for (const w of held) w.flush();
    expect(bytes((await next.promise).values).equals(bytes(single(req).values))).toBe(true);
    pool.terminate();
  });
  test('each part reply is checked against its request (n, field, range); a reply failing its guard rejects with BAD_MESSAGE and frees the worker', async () => {
    const req = vReq(MOUNTAIN, 'density');
    const tamper = (edit: (r: Record<string, unknown>) => unknown) => createWorkerPool(1, () => fakeWorker([], (r) => (r['type'] === 'fieldSliceResult' ? edit(r) : r)));
    const opts = { priority: 500, columnCost: PART_BUDGET / 16, budget: DRAFT_BUDGET };
    const relabelled = tamper((r) => ({ ...r, field: 'node' }));
    await relabelled.configure('42', DEFAULTS);
    await expect(relabelled.fieldSlice(req, opts).promise).rejects.toThrow(/^fieldSlice part: n 32, field node, samples \[0, 16\); expected n 32, field density, samples \[0, 16\)$/);
    const shifted = tamper((r) => ({ ...r, from: (r['from'] as number) + 16, to: (r['to'] as number) + 16 }));
    await shifted.configure('42', DEFAULTS);
    await expect(shifted.fieldSlice(req, opts).promise).rejects.toThrow(/^fieldSlice part: n 32, field density, samples \[16, 32\)/);
    const log: ToWorker[] = [];
    const truncated = createWorkerPool(1, () => fakeWorker(log, (r) => (r['type'] === 'fieldSliceResult' ? { ...r, values: (r['values'] as ArrayBuffer).slice(8) } : r)));
    await truncated.configure('42', DEFAULTS);
    await expect(truncated.fieldSlice(req, opts).promise).rejects.toThrow('BAD_MESSAGE: fieldSliceResult: values of 4088 bytes, expected 4096');
    // The second part was dropped with the group; the freed worker answers the next job.
    expect(partsOf(log)).toEqual([[0, 16]]);
    expect((await truncated.point(1, 2)).z).toBe(2);
    for (const p of [relabelled, shifted, truncated]) p.terminate();
  });
});

describe('pool.fieldProbe (SP3d spec §5.3)', () => {
  test('one job at the point priority (−1) by default, resolving with probeField; BAD_ARGS rejects; non-finite values are returned', async () => {
    const log: ToWorker[] = [];
    const pool: WorkerPool = createWorkerPool(2, () => fakeWorker(log));
    await pool.configure('42', DEFAULTS);
    const ctx = ctxFor('42');
    for (const [field, path, x, y, z] of [['density', '', -1200, 90, 8], ['node', 'root.a.a.x.x', -1200, 90, 8], ['rule', 'root.rules[2]', -1200, -40, 8], ['rule', 'root', -1200, 300, 8]] as const) {
      expect(await pool.fieldProbe({ field, path, x, y, z })).toBe(probeField(ctx, field, path, x, y, z, NEVER));
    }
    expect(log.filter((m) => m.type === 'fieldProbe').map((m) => (m as { field: string }).field)).toEqual(['density', 'node', 'rule', 'rule']);
    await expect(pool.fieldProbe({ field: 'density', path: '', x: 0.5, y: 70, z: 0 })).rejects.toThrow(/^BAD_ARGS: /);
    const order: string[] = [];
    const one = createWorkerPool(1, () => {
      const w = fakeWorker([], (r) => (r['type'] === 'fieldProbeResult' ? { ...r, value: [Number.NaN, Infinity, -Infinity][order.filter((o) => o === 'fieldProbe').length - 1] } : r));
      const post = w.postMessage.bind(w);
      w.postMessage = (m) => { if (m.type !== 'configure') order.push(m.type === 'mapTile' ? 'tile' : m.type); post(m); };
      return w;
    });
    const ready = one.configure('42', DEFAULTS);
    const tile = one.tile({ layer: 'C', level: 256, tx: 0, tz: 0 }, 0);
    const probes = [one.fieldProbe({ field: 'density', path: '', x: 0, y: 70, z: 0 }), one.fieldProbe({ field: 'density', path: '', x: 1, y: 70, z: 0 }, 5), one.fieldProbe({ field: 'node', path: 'root.a', x: 2, y: 70, z: 0 }, 6)];
    await ready;
    await tile;
    expect((await Promise.all(probes)).map(String)).toEqual(['NaN', 'Infinity', '-Infinity']);
    expect(order).toEqual(['fieldProbe', 'tile', 'fieldProbe', 'fieldProbe']);
    const idle = createWorkerPool(1, () => ({ onmessage: null, postMessage() {}, terminate() {} }));
    void settle(idle.fieldProbe({ field: 'density', path: '', x: 0, y: 70, z: 0 }));
    void settle(idle.fieldSlice(vReq(MOUNTAIN, 'density'), { priority: 500, columnCost: 1, budget: DRAFT_BUDGET }).promise);
    expect(idle.probe().jobs).toEqual([{ worker: 0, type: 'fieldProbe', epoch: -1, level: null }]);
    for (const p of [pool, one, idle]) p.terminate();
  });
});

/**
 * The world jobs' protocol (SP4a spec §2.3, §9.7 "guards for every new message and reply"; rulings P23, P28, P29):
 * the `attach` guard (shared buffers of the documented sizes), the four job messages, the `attached`, `columnDone` and
 * `meshColumnResult` replies with their byte-length checks and `payloadProblem`, and the task handler's world branches
 * (attach once, NOT_ATTACHED, STORE_FULL).
 * SP4b (spec §2.4-§2.8, §8.5): `attach` carries the worker's `thread` and is idempotent for the same store id and
 * thread; `terrain` may carry `protoOnly`; the ABORTED table over the four world jobs, each on its own epoch cell; every
 * world job inside a read section, its releases in the worker's limbo until a drain; STORE_CORRUPT; L's and D's retries
 * after a partial write; `T(protoOnly)`; `drainAfterReply`.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createLightScratch } from '../../src/light/initial';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { ROW_INTS } from '../../src/mesh/column';
import { cellOf, parseFromWorker, parseToWorker, type FromWorker } from '../../src/workers/protocol';
import { createTaskHandler, drainAfterReply, LIMBO_RETRY_MS, type TaskHandler } from '../../src/workers/taskHandler';
import { fillColumnD, fillColumnL, fillProtoOnly } from '../../src/workers/worldJobs';
import { STATUS_DECORATED, STATUS_PROTO, STATUS_PUBLISHED } from '../../src/world/store/columnTable';
import type { SlabPool } from '../../src/world/store/pool';
import { R_STORE_ID } from '../../src/world/store/reclaim';
import { createStore, type StoreHandles, type VoxelStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { fakePayload } from './fixtures/payloads';

const MiB = 1 << 20;
const shared = (): StoreHandles => createStore({ shared: true, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB }).handles();
/** An attach message; the pool's first worker is thread 1 (SP4b spec §2.5). */
const attach = (handles: unknown, thread: unknown = 1) => ({ type: 'attach', handles, thread });
const JOBS = ['terrain', 'decorate', 'light', 'meshColumn'] as const;
const job = (type: string, cx: unknown, cz: unknown = 0) => ({ type, jobId: 1, epoch: 0, scope: 0, cx, cz });

/** A reply the pool accepts, and one it does not (null, or `{bad, jobId, reason}`). */
const valid = (m: unknown): boolean => {
  const r = parseFromWorker(m);
  return r !== null && !('bad' in r);
};
const reason = (m: unknown): string | null => {
  const r = parseFromWorker(m);
  return r !== null && 'bad' in r ? r.reason : null;
};

const columnDone = (job: string, versions: ArrayBuffer | null) => ({ type: 'columnDone', jobId: 3, epoch: 0, job, cx: 2, cz: -1, ms: 1.5, versions });

/** A meshColumnResult carrying `fakePayload`'s buffers (each its own, as the worker transfers them). */
function meshResult(rows = [{ sy: 4, pass: 0 as const, quads: 3 }, { sy: 5, pass: 2 as const, quads: 1 }]) {
  const p = fakePayload(2, -1, rows);
  return {
    type: 'meshColumnResult', jobId: 4, epoch: 0, cx: 2, cz: -1, ms: 3,
    versions: p.versions.buffer, connectivity: p.connectivity.buffer, position: p.position.buffer, data: p.data.buffer,
    index: p.index.buffer, rows: p.rows.buffer, spheres: p.spheres.buffer,
  } as Record<string, unknown>;
}

describe('parseToWorker: attach (ruling P23)', () => {
  test('a shared store\'s handles pass, its pass table on an ArrayBuffer included', () => {
    const h = shared();
    expect(h.pass.buffer).toBeInstanceOf(ArrayBuffer);
    expect(parseToWorker(attach(h))).toEqual(attach(h));
  });
  test('an ArrayBuffer anywhere, or a non-shared store, is refused', () => {
    const h = shared();
    expect(parseToWorker(attach(createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB }).handles()))).toBeNull();
    expect(parseToWorker(attach({ ...h, table: new ArrayBuffer(h.table.byteLength) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, epochs: new ArrayBuffer(16) }))).toBeNull();
    for (const key of ['data', 'ctl', 'stack', 'refs'] as const) {
      expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, [key]: new ArrayBuffer(16) } })), key).toBeNull();
      expect(parseToWorker(attach({ ...h, bytes: { ...h.bytes, [key]: new ArrayBuffer(16) } })), key).toBeNull();
    }
    expect(parseToWorker(attach({ ...h, shared: false }))).toBeNull();
    expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, shared: false } }))).toBeNull();
  });
  test('the documented sizes: table, epochs, ctl, growable pools, slot sizes and the pass table', () => {
    const h = shared();
    const grow = (max: number) => new SharedArrayBuffer(0, { maxByteLength: max });
    expect(parseToWorker(attach({ ...h, table: new SharedArrayBuffer(h.table.byteLength - 4) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, epochs: new SharedArrayBuffer(12) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, ctl: new SharedArrayBuffer(12) } }))).toBeNull();
    // A fixed-length data buffer, a maximum off the 1 MiB grain, stack and refs not 4 bytes per slot.
    expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, data: new SharedArrayBuffer(4 * MiB) } }))).toBeNull();
    expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, data: grow(4 * MiB + 8192) } }))).toBeNull();
    expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, stack: grow(4 * 256) } }))).toBeNull();
    expect(parseToWorker(attach({ ...h, bytes: { ...h.bytes, refs: grow(4 * 512) } }))).toBeNull();
    // The two pools' slot sizes swapped.
    expect(parseToWorker(attach({ ...h, blocks: { ...h.blocks, slotBytes: 4096 } }))).toBeNull();
    expect(parseToWorker(attach({ ...h, pass: new Uint8Array(4095) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, pass: new Uint16Array(4096) }))).toBeNull();
    expect(parseToWorker(attach(null))).toBeNull();
    expect(parseToWorker({ type: 'attach' })).toBeNull();
  });
  test('the reclaim buffer (SP4b spec §2.5): a 192-byte SharedArrayBuffer, else refused', () => {
    const h = shared();
    expect(h.reclaim).toBeInstanceOf(SharedArrayBuffer);
    expect(h.reclaim.byteLength).toBe(192);
    const { reclaim: _, ...without } = h;
    expect(parseToWorker(attach(without))).toBeNull();
    expect(parseToWorker(attach({ ...h, reclaim: new ArrayBuffer(192) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, reclaim: new SharedArrayBuffer(188) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, reclaim: new SharedArrayBuffer(196) }))).toBeNull();
    expect(parseToWorker(attach({ ...h, reclaim: null }))).toBeNull();
  });
});

describe('parseToWorker: the world jobs', () => {
  test.each(JOBS)('%s with integer cx and cz passes', (type) => {
    expect(parseToWorker(job(type, 3, -7))).toEqual(job(type, 3, -7));
  });
  test.each(JOBS)('%s with a non-integer cx or cz, or one outside the world window, is refused', (type) => {
    for (const [cx, cz] of [[0.5, 0], [0, -1.5], ['1', 0], [Number.NaN, 0], [0, Infinity], [32768, 0], [0, -32769]]) {
      expect(parseToWorker(job(type, cx, cz)), `${String(cx)}, ${String(cz)}`).toBeNull();
    }
    expect(parseToWorker(job(type, 32767, -32768))).not.toBeNull();
    expect(parseToWorker({ ...job(type, 0), jobId: 1.5 })).toBeNull();
    expect(parseToWorker({ ...job(type, 0), epoch: null })).toBeNull();
    expect(parseToWorker({ ...job(type, 0), scope: 1.5 })).toBeNull();
  });
});

describe('parseFromWorker: the world replies', () => {
  test('attached passes before the jobId check (ruling P28)', () => {
    expect(parseFromWorker({ type: 'attached' })).toEqual({ type: 'attached' });
  });
  test('columnDone: versions of 72 bytes for light, null otherwise', () => {
    expect(valid(columnDone('light', new ArrayBuffer(72)))).toBe(true);
    expect(valid(columnDone('terrain', null))).toBe(true);
    expect(valid(columnDone('decorate', null))).toBe(true);
    expect(reason(columnDone('light', new ArrayBuffer(68)))).toMatch(/^columnDone: versions/);
    expect(reason(columnDone('light', null))).toMatch(/versions/);
    expect(reason(columnDone('terrain', new ArrayBuffer(72)))).toMatch(/versions/);
    expect(reason(columnDone('meshColumn', null))).toMatch(/job/);
    expect(reason({ ...columnDone('terrain', null), cx: 0.5 })).toMatch(/cx/);
    expect(reason({ ...columnDone('terrain', null), ms: -1 })).toMatch(/ms/);
    expect(reason({ ...columnDone('terrain', null), epoch: 'x' })).toMatch(/epoch/);
  });
  test('meshColumnResult: a valid payload passes, an empty one too', () => {
    expect(valid(meshResult())).toBe(true);
    expect(valid(meshResult([]))).toBe(true);
  });
  test('meshColumnResult: rows of 20 bytes are refused', () => {
    expect(reason({ ...meshResult(), rows: new ArrayBuffer(20) })).toMatch(/^meshColumnResult: rows/);
  });
  test('meshColumnResult: an index past its row is refused (payloadProblem over the rebuilt views)', () => {
    const m = meshResult();
    const index = new Uint32Array(m['index'] as ArrayBuffer);
    const rows = new Int32Array(m['rows'] as ArrayBuffer);
    // Row 1 (one quad: 4 vertices) starts at index rows[ROW_INTS + 4]; its first index points at vertex 4.
    index[rows[ROW_INTS + 4]!] = 4;
    expect(reason(m)).toMatch(/^meshColumnResult: row 1: index 4/);
  });
  test('meshColumnResult: the byte lengths of every buffer', () => {
    const m = meshResult();
    expect(reason({ ...m, versions: new ArrayBuffer(68) })).toMatch(/versions/);
    expect(reason({ ...m, connectivity: new ArrayBuffer(46) })).toMatch(/connectivity/);
    expect(reason({ ...m, spheres: new ArrayBuffer(16) })).toMatch(/spheres/);
    expect(reason({ ...m, position: new ArrayBuffer(6) })).toMatch(/position/);
    expect(reason({ ...m, data: new ArrayBuffer((m['data'] as ArrayBuffer).byteLength + 4) })).toMatch(/data/);
    expect(reason({ ...m, index: new ArrayBuffer(10) })).toMatch(/index/);
    expect(reason({ ...m, rows: new SharedArrayBuffer(48) })).toMatch(/rows/);
    expect(reason({ ...m, cz: 1.5 })).toMatch(/cz/);
  });
  test('an error may carry the new codes', () => {
    for (const code of ['NOT_ATTACHED', 'STORE_FULL', 'STORE_CORRUPT']) expect(valid({ type: 'error', jobId: 2, epoch: 0, code, message: 'm' })).toBe(true);
  });
  test('an error with a code outside ErrorCode is refused (SP4b spec §2.6: the guard knows STORE_CORRUPT)', () => {
    expect(reason({ type: 'error', jobId: 2, epoch: 0, code: 'STORE_BROKEN', message: 'm' })).toMatch(/^error: /);
    expect(parseFromWorker({ type: 'error', jobId: null, epoch: null, code: 'STORE_BROKEN', message: 'm' })).toBeNull();
  });
});

describe('parseToWorker: SP4b\'s widened attach and terrain (SP4b spec §2.5, §3.7)', () => {
  test('attach is refused with `thread` 0, 16 or 1.5, or missing', () => {
    const h = shared();
    for (const thread of [1, 2, 15]) expect(parseToWorker(attach(h, thread)), String(thread)).toEqual(attach(h, thread));
    for (const thread of [0, 16, 1.5, -1, '1', null, Number.NaN]) expect(parseToWorker(attach(h, thread)), String(thread)).toBeNull();
    expect(parseToWorker({ type: 'attach', handles: h })).toBeNull();
  });
  test('`protoOnly` is refused unless boolean, and on decorate, light and meshColumn', () => {
    for (const protoOnly of [true, false]) expect(parseToWorker({ ...job('terrain', 1, 2), protoOnly })).toEqual({ ...job('terrain', 1, 2), protoOnly });
    for (const protoOnly of [1, 0, 'true', null]) expect(parseToWorker({ ...job('terrain', 1, 2), protoOnly }), String(protoOnly)).toBeNull();
    for (const type of ['decorate', 'light', 'meshColumn']) {
      for (const protoOnly of [true, false]) expect(parseToWorker({ ...job(type, 1, 2), protoOnly }), `${type} ${String(protoOnly)}`).toBeNull();
    }
  });
});

const configure = { type: 'configure', epoch: 0, seedText: '42', params: DEFAULTS, epochs: null };
const pick = (r: { msg: FromWorker }) => (r.msg.type === 'error' ? [r.msg.code, r.msg.jobId, r.msg.epoch] : [r.msg.type]);

describe('the task handler\'s world branches (SP4a spec §2.3, ruling P29)', () => {
  test('attach replies attached once; a second attach of another store is BAD_MESSAGE; a malformed one too', () => {
    const h = createTaskHandler();
    expect(pick(h.handle(attach({ ...shared(), table: new ArrayBuffer(4) })))).toEqual(['BAD_MESSAGE', null, null]);
    expect(h.handle(attach(shared()))).toEqual({ msg: { type: 'attached' }, transfer: [] });
    expect(pick(h.handle(attach(shared())))).toEqual(['BAD_MESSAGE', null, null]);
  });
  test('a world job before configure is NOT_CONFIGURED, before attach NOT_ATTACHED', () => {
    const h = createTaskHandler();
    expect(pick(h.handle(job('terrain', 0)))).toEqual(['NOT_CONFIGURED', 1, 0]);
    expect(h.handle(configure).msg.type).toBe('ready');
    for (const type of JOBS) expect(pick(h.handle(job(type, 0)))).toEqual(['NOT_ATTACHED', 1, 0]);
  });
  test('terrain replies columnDone; a stopped job ABORTED; a job out of order INTERNAL', () => {
    const h = createTaskHandler();
    const cells = new Int32Array(new SharedArrayBuffer(16));
    h.handle(attach(shared()));
    expect(h.handle({ ...configure, epochs: cells.buffer }).msg.type).toBe('ready');
    const r = h.handle(job('terrain', 5, 6));
    expect(r.msg).toMatchObject({ type: 'columnDone', jobId: 1, epoch: 0, job: 'terrain', cx: 5, cz: 6, versions: null });
    expect(r.transfer).toEqual([]);
    if (r.msg.type === 'columnDone') expect(r.msg.ms).toBeGreaterThanOrEqual(0);
    // D needs the 3 × 3 at Proto: (5, 6)'s neighbours are absent.
    expect(pick(h.handle(job('decorate', 5, 6)))).toEqual(['INTERNAL', 1, 0]);
    // The terrain cell moves: a job of the old scope stops, at the same configure epoch (no STALE_EPOCH)...
    Atomics.store(cells, 0, 1);
    expect(pick(h.handle(job('terrain', 7, 6)))).toEqual(['ABORTED', 1, 0]);
    // ...the other cells do not stop it, and a job carrying the moved cell's value runs.
    Atomics.store(cells, 2, 9);
    expect(h.handle({ ...job('terrain', 9, 6), scope: 1 }).msg).toMatchObject({ type: 'columnDone', jobId: 1, epoch: 0, job: 'terrain', cx: 9, cz: 6 });
  });
  test('StoreFull maps to STORE_FULL', () => {
    const h = createTaskHandler();
    h.handle(attach(createStore({ shared: true, maxBlockBytes: MiB, maxByteBytes: MiB }).handles()));
    h.handle(configure);
    const codes: string[] = [];
    for (let cx = 0; cx < 64 && !codes.includes('STORE_FULL'); cx++) {
      const m = h.handle(job('terrain', cx, 0)).msg;
      codes.push(m.type === 'error' ? m.code : m.type);
    }
    expect(codes.at(-1)).toBe('STORE_FULL');
    expect(codes.slice(0, -1).every((c) => c === 'columnDone')).toBe(true);
  });
});

// ---------------------------------------------------------------- SP4b: the world jobs on the shared store

const NEVER = () => false;
const CTX = ctxFor('42');
const big = (): VoxelStore => createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
/** The columns of the rectangle [x0, x1] × [z0, z1], cz outer. */
const rect = (x0: number, x1: number, z0: number, z1: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) out.push([cx, cz]);
  return out;
};
/** Fills `s` in this thread (the main thread's store): T on `t`, then D on `d`, then L on `l`. */
function fill(s: VoxelStore, t: Array<[number, number]>, d: Array<[number, number]> = [], l: Array<[number, number]> = []): void {
  for (const [cx, cz] of t) expect(fillColumnT(s, CTX, cx, cz, NEVER)).toBe(true);
  for (const [cx, cz] of d) expect(fillColumnD(s, CTX, cx, cz, NEVER)).toBe(true);
  const scratch = createLightScratch();
  for (const [cx, cz] of l) expect(fillColumnL(s, cx, cz, scratch, NEVER)).not.toBeNull();
}
/** A handler attached to `s`'s handles as thread `thread` and configured (seed 42) with `cells`. */
function handlerOn(s: VoxelStore, cells: Int32Array | null = null, thread = 1): TaskHandler {
  const h = createTaskHandler();
  expect(h.handle(attach(s.handles(), thread)).msg).toEqual({ type: 'attached' });
  expect(h.handle({ ...configure, epochs: cells === null ? null : cells.buffer }).msg.type).toBe('ready');
  return h;
}
const statusOf = (s: VoxelStore, cx: number, cz: number): number => s.table.status(s.table.find(cx, cz));
const used = (p: SlabPool): number => p.slotCount() - p.freeCount();
/** Every byte of the column's aux A and aux B as its final view reads them (the record's own slots). */
function auxBytes(s: VoxelStore, cx: number, cz: number): number[][] {
  const v = s.final(cx, cz)!;
  const a = v.aux()!;
  const b = v.auxB()!;
  return [a.worldSurfaceWG, a.oceanFloorWG, a.worldSurface, a.motionBlocking, a.oceanFloor, a.lightBlocking, a.surfaceBiome, a.tintTH,
    b.caveBiomeQ, b.surfaceBiomeQ].map((x) => Array.from(x));
}
/**
 * `s` whose `reopenColumn` writers throw `injected` at the call of `method` that follows `n` counted calls (`counted`
 * selects the calls that count; all by default). `fired()` tells whether the throw happened.
 */
function failingAfter(
  s: VoxelStore, method: 'setLight' | 'shareFinal', n: number, counted: (sy: number) => boolean = () => true,
): VoxelStore & { fired(): boolean } {
  let calls = 0;
  let fired = false;
  return {
    ...s,
    reopenColumn(cx, cz, from) {
      const w = s.reopenColumn(cx, cz, from);
      const inner = w[method] as (sy: number, light: Uint8Array) => void;
      return {
        ...w,
        [method]: (sy: number, light: Uint8Array) => {
          if (calls === n) { fired = true; throw new Error('injected'); }
          inner(sy, light);
          if (counted(sy)) calls++;
        },
      };
    },
    fired: () => fired,
  };
}

describe('the ABORTED table (SP4b spec §2.7, §8.5): each world job stops on its own epoch cell only', () => {
  const doneType = { terrain: 'columnDone', decorate: 'columnDone', light: 'columnDone', meshColumn: 'meshColumnResult' } as const;
  /** Three target columns, each prepared at the stage its job needs (the mesh job writes nothing, so one serves). */
  const prepare = (type: (typeof JOBS)[number], s: VoxelStore): Array<[number, number]> => {
    const row: Array<[number, number]> = [[0, 0], [4, 0], [8, 0]];
    if (type === 'decorate') fill(s, rect(-1, 9, -1, 1));
    if (type === 'light') fill(s, rect(-2, 10, -2, 2), rect(-1, 9, -1, 1));
    if (type === 'meshColumn') { fill(s, rect(-3, 3, -3, 3), rect(-2, 2, -2, 2), rect(-1, 1, -1, 1)); return [[0, 0], [0, 0], [0, 0]]; }
    return row;
  };
  test.each(JOBS)('%s: its own cell moved gives ABORTED (the column unchanged); each other cell moved does not', (type) => {
    const s = big();
    const targets = prepare(type, s);
    const cells = new Int32Array(new SharedArrayBuffer(16));
    const h = handlerOn(s, cells);
    const own = cellOf(type);
    const [cx0, cz0] = targets[0]!;
    const status0 = s.table.find(cx0, cz0) < 0 ? -1 : statusOf(s, cx0, cz0);
    Atomics.store(cells, own, 1);
    expect(pick(h.handle(job(type, cx0, cz0)))).toEqual(['ABORTED', 1, 0]);
    expect(s.table.find(cx0, cz0) < 0 ? -1 : statusOf(s, cx0, cz0)).toBe(status0);
    Atomics.store(cells, own, 0);
    let k = 0;
    for (let c = 0; c < 4; c++) {
      if (c === own) continue;
      const [cx, cz] = targets[k++]!;
      Atomics.store(cells, c, 1);
      expect(h.handle(job(type, cx, cz)).msg, `cell ${c} moved`).toMatchObject({ type: doneType[type], cx, cz });
      Atomics.store(cells, c, 0);
    }
  });
});

describe('the task handler on the shared store (SP4b spec §2.4-§2.8)', () => {
  test('attach twice with the same store and thread replies attached; with another store\'s handles or another thread BAD_MESSAGE', () => {
    const s = createStore({ shared: true, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
    const h = createTaskHandler();
    expect(h.handle(attach(s.handles(), 3)).msg).toEqual({ type: 'attached' });
    // A posted SharedArrayBuffer arrives as a new object over the same memory: the store id decides, not identity.
    const copy = structuredClone(s.handles());
    expect(copy.reclaim).not.toBe(s.handles().reclaim);
    expect(Atomics.load(new Int32Array(copy.reclaim), R_STORE_ID)).toBe(s.storeId);
    expect(h.handle(attach(copy, 3)).msg).toEqual({ type: 'attached' });
    for (const [handles, thread] of [[shared(), 3], [s.handles(), 4]] as const) {
      const r = h.handle(attach(handles, thread));
      expect(pick(r)).toEqual(['BAD_MESSAGE', null, null]);
      expect(r.msg.type === 'error' && r.msg.message).toBe('the store is already attached');
    }
  });

  test('a StoreCorrupt inside a world job replies STORE_CORRUPT', () => {
    const s = createStore({ shared: true, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
    const h = handlerOn(s);
    // Thread 2 died holding the block pool's lock (its word is thread + 1).
    new Int32Array(s.handles().blocks.ctl)[0] = 3;
    s.markDead(2);
    const r = h.handle(job('terrain', 0, 0));
    expect(pick(r)).toEqual(['STORE_CORRUPT', 1, 0]);
    expect(r.msg.type === 'error' && r.msg.message).toBe('pool lock held by failed thread 2');
  });

  test('L after a partial setLight retries cleanly: inject a throw after 5 setLight, retry the job, it replies columnDone and lightVersion moved by 1', () => {
    const s = big();
    fill(s, rect(-2, 2, -2, 2), rect(-1, 1, -1, 1));
    const base = s.table.find(0, 0);
    const v0 = s.table.lightVersion(base);
    // (0, 0)'s light is dense in sections 9-11 only (seed 42), so the 5 counted setLight are those from section 7 on:
    // the partial write leaves dense light entries, which a retry without resetLight would refuse.
    const bad = failingAfter(s, 'setLight', 5, (sy) => sy >= 7);
    expect(() => fillColumnL(bad, 0, 0, createLightScratch(), NEVER)).toThrow('injected');
    expect(bad.fired()).toBe(true);
    expect([statusOf(s, 0, 0), s.table.lightVersion(base)]).toEqual([STATUS_DECORATED, v0]);
    expect(typeof s.final(0, 0)!.sectionLight(9)).not.toBe('number');
    const h = handlerOn(s);
    expect(h.handle(job('light', 0, 0)).msg).toMatchObject({ type: 'columnDone', job: 'light', cx: 0, cz: 0 });
    expect([statusOf(s, 0, 0), s.table.lightVersion(base)]).toEqual([STATUS_PUBLISHED, v0 + 1]);
    // The retry's light equals a clean run's.
    const clean = big();
    fill(clean, rect(-2, 2, -2, 2), rect(-1, 1, -1, 1), [[0, 0]]);
    for (let sy = 0; sy < 24; sy++) expect(s.final(0, 0)!.sectionLight(sy), `sy ${sy}`).toEqual(clean.final(0, 0)!.sectionLight(sy));
  });

  test('D\'s partial shares on a throw are tolerated: inject a throw between shares, the retry commits at Decorated and the pools\' refcounts are balanced', () => {
    const s = big();
    const clean = big();
    const cols = rect(-1, 1, -1, 1);
    fill(s, cols);
    fill(clean, cols, [[0, 0]]);
    const bad = failingAfter(s, 'shareFinal', 5);
    expect(() => fillColumnD(bad, CTX, 0, 0, NEVER)).toThrow('injected');
    expect(bad.fired()).toBe(true);
    expect(statusOf(s, 0, 0)).toBe(STATUS_PROTO);
    const h = handlerOn(s);
    expect(h.handle(job('decorate', 0, 0)).msg).toMatchObject({ type: 'columnDone', job: 'decorate', cx: 0, cz: 0 });
    expect(statusOf(s, 0, 0)).toBe(STATUS_DECORATED);
    // Balanced: the slots in use and their total references equal a clean D's, and freeing every column frees every slot.
    const refs = (p: SlabPool) => { let n = 0; for (let id = 0; id < p.slotCount(); id++) n += p.refcount(id); return n; };
    expect([used(s.blockPool), used(s.bytePool), refs(s.blockPool), refs(s.bytePool)])
      .toEqual([used(clean.blockPool), used(clean.bytePool), refs(clean.blockPool), refs(clean.bytePool)]);
    for (const [cx, cz] of cols) s.freeColumn(cx, cz);
    expect([used(s.blockPool), used(s.bytePool), refs(s.blockPool), refs(s.bytePool)]).toEqual([0, 0, 0, 0]);
  });

  test('terrain protoOnly on a status-2 column with a freed proto replies columnDone, sets the bit, leaves versions, status and the aux bytes unchanged, and the proto\'s region hash equals the original\'s', () => {
    const s = big();
    fill(s, rect(-1, 1, -1, 1), [[0, 0]]);
    const base = s.table.find(0, 0);
    const record = () => [s.table.blockVersion(base), s.table.lightVersion(base), s.table.status(base)];
    const r0 = record();
    const aux0 = auxBytes(s, 0, 0);
    const hash0 = regionHash(s, 0, 0, 1, 1);
    s.freeProto(0, 0);
    expect(s.proto(0, 0)).toBeNull();
    const h = handlerOn(s);
    expect(h.handle({ ...job('terrain', 0, 0), protoOnly: true }).msg).toMatchObject({ type: 'columnDone', job: 'terrain', cx: 0, cz: 0, versions: null });
    expect(s.proto(0, 0)).not.toBeNull();
    expect(record()).toEqual(r0);
    expect(r0[2]).toBe(STATUS_DECORATED);
    expect(auxBytes(s, 0, 0)).toEqual(aux0);
    expect(regionHash(s, 0, 0, 1, 1)).toEqual(hash0);
  });

  test('fillProtoOnly: a stop or a throw after a written section releases the written proto entries and leaves the bit clear', () => {
    const s = big();
    fill(s, rect(-1, 1, -1, 1), [[0, 0]]);
    s.freeProto(0, 0);
    const u0 = [used(s.blockPool), used(s.bytePool)];
    // Stops (or throws) once T has written a dense proto section.
    const wrote = () => used(s.blockPool) > u0[0]!;
    expect(fillProtoOnly(s, CTX, 0, 0, wrote)).toBe(false);
    expect([s.proto(0, 0), used(s.blockPool), used(s.bytePool)]).toEqual([null, ...u0]);
    expect(() => fillProtoOnly(s, CTX, 0, 0, () => { if (wrote()) throw new Error('boom'); return false; })).toThrow('boom');
    expect([s.proto(0, 0), used(s.blockPool), used(s.bytePool)]).toEqual([null, ...u0]);
    expect(fillProtoOnly(s, CTX, 0, 0, NEVER)).toBe(true);
    expect(s.proto(0, 0)).not.toBeNull();
  });

  test('a world job\'s slots released by its own L resetLight sit in the worker\'s limbo while another thread reads, and drain() empties it after', () => {
    const s = big();
    fill(s, rect(-2, 2, -2, 2), rect(-1, 1, -1, 1));
    // A partial L leaves (0, 0)'s dense light entries (sections 9-11) at Decorated.
    expect(() => fillColumnL(failingAfter(s, 'setLight', 12), 0, 0, createLightScratch(), NEVER)).toThrow('injected');
    const h = handlerOn(s);
    expect(h.drain()).toBe(0);
    s.enterRead();
    const before = used(s.bytePool);
    expect(h.handle(job('light', 0, 0)).msg).toMatchObject({ type: 'columnDone', job: 'light' });
    // The job's resetLight released the three dense light slots into thread 1's limbo (still counted as used, beside the
    // three its setLight wrote); the main thread still reads.
    expect([s.limboCount(1), s.limboCount(0), used(s.bytePool)]).toEqual([3, 0, before + 3]);
    expect(h.drain()).toBe(3);
    s.exitRead();
    expect(h.drain()).toBe(0);
    expect([s.limboCount(1), used(s.bytePool)]).toEqual([0, before]);
  });

  test('a handler with no store drains nothing', () => {
    expect(createTaskHandler().drain()).toBe(0);
  });
});

describe('drainAfterReply (SP4b spec §2.5: a worker drains after each reply and retries every 16 ms)', () => {
  test('drainAfterReply drains once after the reply, re-drains every 16 ms while it returns > 0, and stops once a drain returns 0', () => {
    expect(LIMBO_RETRY_MS).toBe(16);
    const left: number[] = [];
    let drains = 0;
    const h = { drain: () => { drains++; return left.shift() ?? 0; } };
    const timers: Array<{ f: () => void; ms: number }> = [];
    const setTimer = (f: () => void, ms: number) => { timers.push({ f, ms }); };
    const fire = () => timers.shift()!.f();
    left.push(3, 2, 1, 0);
    drainAfterReply(h, setTimer);
    expect([drains, timers.map((t) => t.ms)]).toEqual([1, [16]]);
    // Another reply while a retry is pending drains at once and schedules no second timer.
    drainAfterReply(h, setTimer);
    expect([drains, timers.length]).toEqual([2, 1]);
    fire();
    expect([drains, timers.map((t) => t.ms)]).toEqual([3, [16]]);
    fire();
    expect([drains, timers.length]).toEqual([4, 0]);
    // Empty: one drain, no timer; a later reply with entries left starts a new retry.
    drainAfterReply(h, setTimer);
    expect([drains, timers.length]).toEqual([5, 0]);
    left.push(1, 0);
    drainAfterReply(h, setTimer);
    expect([drains, timers.length]).toEqual([6, 1]);
    fire();
    expect([drains, timers.length]).toEqual([7, 0]);
  });
});

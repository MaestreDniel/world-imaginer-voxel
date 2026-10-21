/**
 * The world jobs' protocol (SP4a spec §2.3, §9.7 "guards for every new message and reply"; rulings P23, P28, P29):
 * the `attach` guard (shared buffers of the documented sizes), the four job messages, the `attached`, `columnDone` and
 * `meshColumnResult` replies with their byte-length checks and `payloadProblem`, and the task handler's world branches
 * (attach once, NOT_ATTACHED, STORE_FULL).
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { ROW_INTS } from '../../src/mesh/column';
import { parseFromWorker, parseToWorker, type FromWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { createStore, type StoreHandles } from '../../src/world/store/store';
import { fakePayload } from './fixtures/payloads';

const MiB = 1 << 20;
const shared = (): StoreHandles => createStore({ shared: true, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB }).handles();
const attach = (handles: unknown) => ({ type: 'attach', handles });
const JOBS = ['terrain', 'decorate', 'light', 'meshColumn'] as const;
const job = (type: string, cx: unknown, cz: unknown = 0) => ({ type, jobId: 1, epoch: 0, cx, cz });

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
    for (const code of ['NOT_ATTACHED', 'STORE_FULL']) expect(valid({ type: 'error', jobId: 2, epoch: 0, code, message: 'm' })).toBe(true);
  });
});

describe('the task handler\'s world branches (SP4a spec §2.3, ruling P29)', () => {
  const configure = { type: 'configure', epoch: 0, seedText: '42', params: DEFAULTS, abort: null };
  const pick = (r: { msg: FromWorker }) => (r.msg.type === 'error' ? [r.msg.code, r.msg.jobId, r.msg.epoch] : [r.msg.type]);

  test('attach replies attached once; a second attach is BAD_MESSAGE; a malformed one too', () => {
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
    const cell = new Int32Array(new SharedArrayBuffer(4));
    h.handle(attach(shared()));
    expect(h.handle({ ...configure, abort: cell.buffer }).msg.type).toBe('ready');
    const r = h.handle(job('terrain', 5, 6));
    expect(r.msg).toMatchObject({ type: 'columnDone', jobId: 1, epoch: 0, job: 'terrain', cx: 5, cz: 6, versions: null });
    expect(r.transfer).toEqual([]);
    if (r.msg.type === 'columnDone') expect(r.msg.ms).toBeGreaterThanOrEqual(0);
    // D needs the 3 × 3 at Proto: (5, 6)'s neighbours are absent.
    expect(pick(h.handle(job('decorate', 5, 6)))).toEqual(['INTERNAL', 1, 0]);
    Atomics.store(cell, 0, 1);
    expect(pick(h.handle(job('terrain', 7, 6)))).toEqual(['ABORTED', 1, 0]);
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

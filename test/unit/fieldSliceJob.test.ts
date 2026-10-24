import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { GenContext } from '../../src/gen/context';
import { evaluateFieldSlice, probeField, sliceSampleVoxel, type SliceField, type SliceGeometry, type TColumnSource } from '../../src/gen/inspect/fieldSlice';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { PART_BUDGET, type FromWorker } from '../../src/workers/protocol';
import { createSliceJob } from '../../src/workers/sliceJob';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

const NEVER = (): boolean => false;
const MiB = 1 << 20;
const MOUNTAIN: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
/** The coast line of the fieldSlice tests: sea, beach and land at seed '42'. */
const COAST: Segment = { ax: -27136, az: -31992, bx: -26113, bz: -31992 };

const configure = (epoch: number, epochs: SharedArrayBuffer | null = null) => ({ type: 'configure', epoch, seedText: '42', params: DEFAULTS, epochs });
const vMsg = (s: Segment, field: SliceField, path: string, from: number, to: number, n = 32, extra: Record<string, unknown> = {}) =>
  ({ type: 'fieldSlice', jobId: 9, epoch: 3, scope: 3, plane: 'vertical', ...s, y: 63, n, field, path, from, to, ...extra });
const hMsg = (field: SliceField, path: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'fieldSlice', jobId: 9, epoch: 3, scope: 3, plane: 'horizontal', cx: -1152, cz: 8, y: 100, extent: 2048, n: 32, field, path, from, to, ...extra });
const pMsg = (field: string, path: string, x: number, y: number, z: number) => ({ type: 'fieldProbe', jobId: 5, epoch: 3, scope: 3, field, path, x, y, z });

const vGeom = (s: Segment, n = 32): SliceGeometry => ({ plane: 'vertical', n, pointAt: (i) => segmentPointAt(s, i, n) });
const hGeom: SliceGeometry = { plane: 'horizontal', n: 32, cx: -1152, cz: 8, y: 100, extent: 2048 };

function storeColumns(ctx: GenContext): TColumnSource {
  const store = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  return (cx, cz, stop) => (store.proto(cx, cz) === null && !fillColumnT(store, ctx, cx, cz, stop) ? null : store.proto(cx, cz));
}
const bytes = (b: ArrayBufferLike | ArrayBufferView): Buffer => (ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b));
const errOf = (m: FromWorker) => (m.type === 'error' ? [m.code, m.jobId, m.epoch, m.message] : [m.type]);

describe('the fieldSlice job (SP3d spec §5.1)', () => {
  const ctx = ctxFor('42');

  test.each([
    ['vertical density', vMsg(MOUNTAIN, 'density', '', 0, 32), vGeom(MOUNTAIN)],
    ['vertical node under the terrain tap', vMsg(MOUNTAIN, 'node', 'root.a.a.x.x', 5, 17), vGeom(MOUNTAIN)],
    ['horizontal density', hMsg('density', '', 0, 32), hGeom],
    ['horizontal node', hMsg('node', 'root.a.b', 11, 32), hGeom],
  ] as const)('%s replies with gen\'s evaluation of its range, the values transferred, at the job\'s epoch', (_name, msg, g) => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const r = h.handle(msg);
    expect(r.msg).toMatchObject({ type: 'fieldSliceResult', jobId: 9, epoch: 3, n: 32, field: msg.field, from: msg.from, to: msg.to, fluid: null });
    if (r.msg.type !== 'fieldSliceResult') return;
    expect(r.transfer).toEqual([r.msg.values]);
    const want = evaluateFieldSlice(ctx, { geometry: g, field: msg.field, path: msg.path, from: msg.from, to: msg.to }, NEVER)!;
    expect(bytes(r.msg.values).equals(bytes(want.values))).toBe(true);
  });
  test('blocks (states and fluid, both transferred) and rule masks, one sample column per part, equal gen\'s evaluation; blocks use the handler\'s slice store', () => {
    const job = createSliceJob();
    const h = createTaskHandler(job);
    h.handle(configure(3));
    const g = vGeom(COAST);
    const blocks = evaluateFieldSlice(ctx, { geometry: g, field: 'blocks', path: '', from: 0, to: 32 }, NEVER, storeColumns(ctx))!;
    const rule = evaluateFieldSlice(ctx, { geometry: g, field: 'rule', path: 'root.rules[1].then', from: 0, to: 32 }, NEVER)!;
    for (let c = 0; c < 32; c++) {
      const b = h.handle(vMsg(COAST, 'blocks', '', c, c + 1));
      if (b.msg.type !== 'fieldSliceResult' || b.msg.fluid === null) throw new Error(JSON.stringify(b.msg));
      expect(b.transfer).toEqual([b.msg.values, b.msg.fluid]);
      expect(bytes(b.msg.values).equals(bytes(blocks.values.subarray(c * 32, c * 32 + 32))), `blocks ${c}`).toBe(true);
      expect(bytes(b.msg.fluid).equals(bytes(blocks.fluid!.subarray(c * 32, c * 32 + 32))), `fluid ${c}`).toBe(true);
      const r = h.handle(vMsg(COAST, 'rule', 'root.rules[1].then', c, c + 1));
      if (r.msg.type !== 'fieldSliceResult') throw new Error(JSON.stringify(r.msg));
      expect(bytes(r.msg.values).equals(bytes(rule.values.subarray(c * 32, c * 32 + 32))), `rule ${c}`).toBe(true);
    }
    expect(new Set(rule.values).size).toBe(3);
    expect(job.resident().length).toBeGreaterThan(20);
    h.handle(configure(4));
    expect(job.resident()).toEqual([]);
  }, 60_000);
  test('BAD_ARGS: n, the segment, the square, y on both planes, extent, the field on its plane, the path, the range and the part bound', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const bad = (m: unknown, message: string | RegExp) => {
      const r = errOf(h.handle(m).msg);
      expect(r.slice(0, 3), JSON.stringify(m)).toEqual(['BAD_ARGS', 9, 3]);
      if (typeof message === 'string') expect(r[3]).toBe(message);
      else expect(r[3]).toMatch(message);
    };
    bad(vMsg(MOUNTAIN, 'density', '', 0, 8, 64), 'n 64 is not a slice size (32, 128)');
    bad(hMsg('density', '', 0, 8, { n: 16 }), 'n 16 is not a slice size (32, 128)');
    bad(vMsg({ ax: -40, az: 9, bx: -40, bz: 9 }, 'density', '', 0, 8), 'A and B are the same point (-40, 9)');
    bad(vMsg({ ax: 0, az: 0, bx: 524288, bz: 0 }, 'density', '', 0, 8), /^B \(524288, 0\) is outside the world window/);
    bad(vMsg(MOUNTAIN, 'density', '', 0, 8, 32, { y: 320 }), 'y 320 is not an integer in [-64, 319]');
    bad(vMsg(MOUNTAIN, 'density', '', 0, 8, 32, { y: 1.5 }), 'y 1.5 is not an integer in [-64, 319]');
    bad(hMsg('density', '', 0, 8, { y: -65 }), 'y -65 is not an integer in [-64, 319]');
    bad(hMsg('density', '', 0, 8, { cx: 0.5 }), 'the centre (0.5, 8) is not a pair of integers');
    bad(hMsg('density', '', 0, 8, { extent: 300 }), 'extent 300 is not a slice extent (256, 512, 1024, 2048, 4096, 8192)');
    bad(hMsg('density', '', 0, 8, { cx: 524288 - 1000 }), /^the square x \[522264, 524312\] × z \[-1016, 1032\] leaves the world window/);
    bad(hMsg('blocks', '', 0, 1), 'field blocks has no horizontal slice');
    bad(hMsg('rule', 'root', 0, 1), 'field rule has no horizontal slice');
    bad(vMsg(MOUNTAIN, 'density', 'root', 0, 8), 'field density takes no node path (got "root")');
    bad(vMsg(MOUNTAIN, 'node', 'root.zz', 0, 8), 'path "root.zz" names no node of density.defs');
    bad(vMsg(MOUNTAIN, 'node', 'constructor', 0, 8), 'path "constructor" names no node of density.defs');
    bad(vMsg(MOUNTAIN, 'rule', 'root.rules[99]', 0, 1), 'path "root.rules[99]" names no rule or condition of surface.rules');
    for (const [from, to] of [[5, 5], [0, 33], [1.5, 3], [-1, 2], [Number.NaN, 2]]) bad(vMsg(MOUNTAIN, 'density', '', from!, to!), `samples [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 32`);
    bad(vMsg(MOUNTAIN, 'density', '', 0, 128, 128), `too heavy: 128 × 105600 work units exceed the part budget ${PART_BUDGET}`);
    bad(vMsg(MOUNTAIN, 'blocks', '', 0, 2), 'too heavy: 2 sample columns of cost 5006893, at most 1 per part');
    expect(h.handle(vMsg(MOUNTAIN, 'density', '', 0, 79, 128)).msg.type).toBe('fieldSliceResult');
  });
  test('before configure NOT_CONFIGURED, at another epoch STALE_EPOCH; with epoch cells a fieldSlice whose epoch the cell has left replies ABORTED', () => {
    const sab = new SharedArrayBuffer(16);
    const cell = new Int32Array(sab);
    const h = createTaskHandler();
    expect(errOf(h.handle(vMsg(MOUNTAIN, 'density', '', 0, 8)).msg).slice(0, 3)).toEqual(['NOT_CONFIGURED', 9, 3]);
    Atomics.store(cell, 0, 3);
    h.handle(configure(3, sab));
    expect(errOf(h.handle({ ...vMsg(MOUNTAIN, 'density', '', 0, 8), epoch: 2 }).msg).slice(0, 3)).toEqual(['STALE_EPOCH', 9, 2]);
    Atomics.store(cell, 0, 4);
    for (const m of [vMsg(MOUNTAIN, 'density', '', 0, 8), hMsg('node', 'root.a.b', 0, 8), vMsg(COAST, 'blocks', '', 3, 4), vMsg(COAST, 'rule', 'root.rules[2]', 3, 4)]) {
      const r = h.handle(m);
      expect(errOf(r.msg).slice(0, 3), m.field).toEqual(['ABORTED', 9, 3]);
      expect(r.transfer).toEqual([]);
    }
    Atomics.store(cell, 0, 3);
    expect(h.handle(vMsg(MOUNTAIN, 'density', '', 0, 8)).msg.type).toBe('fieldSliceResult');
  });
});

describe('the fieldProbe job (SP3d spec §5.3)', () => {
  const ctx = ctxFor('42');

  test('replies with probeField: the slice\'s sample for density, node and rule (0, 1 or 255)', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const g = vGeom(COAST);
    const slice = evaluateFieldSlice(ctx, { geometry: g, field: 'rule', path: 'root.rules[2]', from: 0, to: 32 }, NEVER)!;
    const seen = new Set<number>();
    for (const [c, k] of [[0, 0], [3, 20], [9, 31], [17, 12], [30, 25], [31, 31], [12, 16]] as const) {
      const [x, y, z] = sliceSampleVoxel(g, c, k);
      for (const [field, path] of [['density', ''], ['node', 'root.a.a.x.x'], ['rule', 'root.rules[2]'], ['rule', 'root.rules[1].if']] as const) {
        const r = h.handle(pMsg(field, path, x, y, z));
        expect(r.msg, `${field} (${x}, ${y}, ${z})`).toEqual({ type: 'fieldProbeResult', jobId: 5, epoch: 3, value: probeField(ctx, field, path, x, y, z, NEVER) });
        expect(r.transfer).toEqual([]);
      }
      const v = (h.handle(pMsg('rule', 'root.rules[2]', x, y, z)).msg as { value: number }).value;
      expect(v).toBe(slice.values[c * 32 + k]);
      seen.add(v);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 255]);
  });
  test('BAD_ARGS for a position that is not integers in the window, y outside −64 … 319 or a bad path; ABORTED once the cell left its epoch', () => {
    const sab = new SharedArrayBuffer(16);
    const cell = new Int32Array(sab);
    Atomics.store(cell, 0, 3);
    const h = createTaskHandler();
    h.handle(configure(3, sab));
    for (const m of [pMsg('density', '', 0.5, 70, 0), pMsg('density', '', 524288, 70, 0), pMsg('node', 'root.a', 0, 320, 0), pMsg('density', '', 0, Number.NaN, 0),
      pMsg('density', 'root', 0, 70, 0), pMsg('node', 'root.q', 0, 70, 0), pMsg('rule', 'root.rules[9]', 0, 70, 0)]) {
      expect(errOf(h.handle(m).msg).slice(0, 3), JSON.stringify(m)).toEqual(['BAD_ARGS', 5, 3]);
    }
    expect(errOf(h.handle(pMsg('node', 'root.q', 0, 70, 0)).msg)[3]).toBe('path "root.q" names no node of density.defs');
    Atomics.store(cell, 0, 4);
    for (const field of ['density', 'node', 'rule']) {
      expect(errOf(h.handle(pMsg(field, field === 'node' ? 'root.a' : field === 'rule' ? 'root' : '', 0, 70, 0)).msg).slice(0, 3)).toEqual(['ABORTED', 5, 3]);
    }
    // SP3d spec §5.3: the surfaceProbe handler now polls stop() before its column build (it ran to the end before).
    expect(errOf(h.handle({ type: 'surfaceProbe', jobId: 6, epoch: 3, scope: 3, x: 0, y: 70, z: 0 }).msg).slice(0, 3)).toEqual(['ABORTED', 6, 3]);
    expect(h.handle({ type: 'point', jobId: 7, epoch: 3, scope: 3, x: 0, z: 0 }).msg.type).toBe('pointResult');
  });
});

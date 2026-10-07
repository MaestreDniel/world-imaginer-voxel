import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { flattenKnot } from '../../src/core/spline/edit';
import type { KnotPath } from '../../src/core/spline/types';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn } from '../../src/gen/column/spawn';
import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../../src/metrics/biomeShares';
import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength } from '../../src/metrics/crossSection';
import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode, type SplineLeaf } from '../../src/metrics/splineStats';
import { paintTile, paintTileAbortable } from '../../src/gen/map/tile';
import { leafOpts } from '../../src/ui/splineEditor/model';
import { parseFromWorker, parseToWorker, pointInWindow, SLICE_ROWS, SLICE_SAMPLES, sliceIndex, slicePartIndex, tileInWindow } from '../../src/workers/protocol';
import { createSliceJob } from '../../src/workers/sliceJob';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

const tileMsg = { type: 'mapTile', jobId: 1, epoch: 3, layer: 'biome', level: 64, tx: 2, tz: -1 };
const configure = (epoch: number, abort: SharedArrayBuffer | null = null, params: unknown = DEFAULTS, seedText = '42') => ({ type: 'configure', epoch, seedText, params, abort });
const stats = (jobId: number, epoch: number, kind: string, from: number, to: number, args: unknown) => ({ type: 'stats', jobId, epoch, kind, from, to, args });
/** A crossSection job's args: the sum's length and the segment's ends. */
const line = (ax: number, az: number, bx: number, bz: number, len = 4096) => ({ len, ax, az, bx, bz });
/** The length of a splineStats sum for the node at `node` of the leaf's default spline. */
const splineLen = (leaf: SplineLeaf, node: KnotPath) => splineStatsLength(splineStatsNode(DEFAULTS, leaf, node)!.points.length);
/** Byte equality through Buffer (vitest's deep equality is slow on 262 144-byte arrays). */
const sameBytes = (a: ArrayBufferLike, b: ArrayBufferLike | ArrayBufferView) =>
  Buffer.from(a).equals(ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b));

describe('parseToWorker', () => {
  test('valid messages pass', () => {
    expect(parseToWorker(configure(0))).not.toBeNull();
    expect(parseToWorker(configure(0, new SharedArrayBuffer(4)))).not.toBeNull();
    expect(parseToWorker(tileMsg)).not.toBeNull();
    expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, x: 1.5, z: -7 })).not.toBeNull();
    expect(parseToWorker({ type: 'spawn', jobId: 4, epoch: 3 })).not.toBeNull();
    expect(parseToWorker({ type: 'selftest', jobId: 5, key: 'sp1.params' })).not.toBeNull();
    expect(parseToWorker(stats(6, 3, 'splineStats', 0, 100, { len: 87, leaf: 'shape.offset', node: [6, 0] }))).not.toBeNull();
    expect(parseToWorker(stats(7, 3, 'biomeShares', 5, 5, { len: 31 }))).not.toBeNull();
    expect(parseToWorker(stats(8, 3, 'crossSection', 0, 512, line(5120, 3072, 6656, 3072)))).not.toBeNull();
    expect(parseToWorker({ type: 'slice', jobId: 9, epoch: 3, ax: 5120, az: 3072, bx: 6656, bz: 3072, from: 0, to: 512 })).not.toBeNull();
  });
  test('crossSection ends are only checked to be numbers: outside the window, NaN or A = B parse, and the handler answers BAD_ARGS', () => {
    for (const args of [line(524288, 0, 0, 0), line(Number.NaN, 0, 1, 1), line(0, Infinity, 1, 1), line(7, 7, 7, 7)]) {
      expect(parseToWorker(stats(8, 3, 'crossSection', 0, 512, args))).not.toBeNull();
    }
  });
  test.each<[string, unknown]>([
    ['not an object', 5],
    ['unknown type', { type: 'nope' }],
    ['empty seed text', configure(0, null, {}, '  ')],
    ['configure without abort', { type: 'configure', epoch: 0, seedText: '42', params: {} }],
    ['abort that is not shared', { ...configure(0), abort: new ArrayBuffer(4) }],
    ['abort of the wrong size', configure(0, new SharedArrayBuffer(8))],
    ['bad layer', { ...tileMsg, layer: 'caves' }],
    ['bad level', { ...tileMsg, level: 32 }],
    ['non-integer tile', { ...tileMsg, tx: 0.5 }],
    ['tile outside the window', { ...tileMsg, tx: 40 }],
    ['preview tile just past the window (SP2a minor 1)', { ...tileMsg, level: 256, tx: 8 }],
    ['point outside the window', { type: 'point', jobId: 2, epoch: 3, x: 1e7, z: 0 }],
    ['point on the window edge x = 2^19 (SP2a minor 1)', { type: 'point', jobId: 2, epoch: 3, x: 524288, z: 0 }],
    ['point on the window edge z = 2^19', { type: 'point', jobId: 2, epoch: 3, x: 0, z: 524288 }],
    ['non-finite point', { type: 'point', jobId: 2, epoch: 3, x: Number.NaN, z: 0 }],
    ['stats of an unknown kind', stats(6, 3, 'nope', 0, 10, { len: 31 })],
    ['stats with from > to', stats(6, 3, 'biomeShares', 10, 9, { len: 31 })],
    ['stats with a negative from', stats(6, 3, 'biomeShares', -1, 9, { len: 31 })],
    ['stats with a non-integer to', stats(6, 3, 'biomeShares', 0, 9.5, { len: 31 })],
    ['stats without args', { type: 'stats', jobId: 6, epoch: 3, kind: 'biomeShares', from: 0, to: 9 }],
    ['stats with args.len 0', stats(6, 3, 'biomeShares', 0, 9, { len: 0 })],
    ['stats with a non-integer args.len', stats(6, 3, 'biomeShares', 0, 9, { len: 31.5 })],
    ['splineStats whose leaf is not a string', stats(6, 3, 'splineStats', 0, 9, { len: 87, leaf: 7, node: [] })],
    ['splineStats whose node is not an array', stats(6, 3, 'splineStats', 0, 9, { len: 87, leaf: 'shape.offset', node: '6' })],
    ['splineStats whose node holds a non-integer', stats(6, 3, 'splineStats', 0, 9, { len: 87, leaf: 'shape.offset', node: [0.5] })],
    ['crossSection whose end is not a number', stats(6, 3, 'crossSection', 0, 512, { len: 4096, ax: '0', az: 0, bx: 1, bz: 1 })],
    ['crossSection without bz', stats(6, 3, 'crossSection', 0, 512, { len: 4096, ax: 0, az: 0, bx: 1 })],
  ])('%s is rejected', (_n, m) => {
    expect(parseToWorker(m)).toBeNull();
  });
  test('the world window is half-open [−2^19, 2^19) for points and tiles (SP2b spec §6.3)', () => {
    expect([pointInWindow(-524288, -524288), pointInWindow(524287.5, 524287.99), pointInWindow(0, 0)]).toEqual([true, true, true]);
    expect([pointInWindow(524288, 0), pointInWindow(0, 524288), pointInWindow(-524288.5, 0), pointInWindow(Number.NaN, 0)]).toEqual([false, false, false, false]);
    for (const level of [256, 64, 16, 4] as const) {
      const n = 524288 / (256 * level);
      expect([level, tileInWindow(-n, level), tileInWindow(n - 1, level), tileInWindow(n, level), tileInWindow(-n - 1, level)]).toEqual([level, true, true, false, false]);
    }
    expect(parseToWorker({ ...tileMsg, level: 256, tx: -8, tz: 7 })).not.toBeNull();
    expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, x: -524288, z: 524287.5 })).not.toBeNull();
  });
});

describe('parseFromWorker', () => {
  test('tile buffers must be 256·256·4 bytes; ids, when present, 256·256 bytes', () => {
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144) })).not.toBeNull();
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(10) })).toBeNull();
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144), ids: new ArrayBuffer(65536) })).not.toBeNull();
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144), ids: new ArrayBuffer(10) })).toBeNull();
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144), ids: null })).toBeNull();
  });
  test('errors carry an epoch (an integer or null)', () => {
    expect(parseFromWorker({ type: 'error', jobId: null, epoch: null, code: 'BAD_MESSAGE', message: 'x' })).not.toBeNull();
    expect(parseFromWorker({ type: 'error', jobId: 4, epoch: 3, code: 'ABORTED', message: 'x' })).not.toBeNull();
    expect(parseFromWorker({ type: 'error', jobId: null, code: 'BAD_MESSAGE', message: 'x' })).toBeNull();
    expect(parseFromWorker({ type: 'error', jobId: null, epoch: 1.5, code: 'BAD_MESSAGE', message: 'x' })).toBeNull();
  });
  test('stats results carry a whole, non-zero number of Float64 values in an ArrayBuffer', () => {
    const result = (kind: string, data: unknown) => ({ type: 'statsResult', jobId: 6, epoch: 3, kind, data });
    expect(parseFromWorker(result('biomeShares', new ArrayBuffer(8 * 31)))).not.toBeNull();
    expect(parseFromWorker(result('splineStats', new ArrayBuffer(8)))).not.toBeNull();
    expect(parseFromWorker(result('crossSection', new ArrayBuffer(8 * 4096)))).not.toBeNull();
    expect(parseFromWorker(result('biomeShares', new ArrayBuffer(12)))).toBeNull();
    expect(parseFromWorker(result('biomeShares', new ArrayBuffer(0)))).toBeNull();
    expect(parseFromWorker(result('biomeShares', new Float64Array(31)))).toBeNull();
    expect(parseFromWorker(result('nope', new ArrayBuffer(8)))).toBeNull();
    expect(parseFromWorker({ ...result('biomeShares', new ArrayBuffer(8)), jobId: null })).toBeNull();
  });
});

describe('task handler', () => {
  test('configure → ready with the stage hashes; tiles and points match the direct functions', () => {
    const h = createTaskHandler();
    const ready = h.handle(configure(3)).msg;
    expect(ready.type).toBe('ready');
    if (ready.type !== 'ready') return;
    expect(Object.keys(ready.stageHashes)).toContain('biome2d');
    expect(ready.genKey).toMatch(/^[0-9a-f]{16}$/);
    const tile = h.handle(tileMsg);
    expect(tile.msg.type).toBe('tile');
    if (tile.msg.type !== 'tile') return;
    expect(tile.msg.ids).toBeInstanceOf(ArrayBuffer);
    expect(tile.transfer).toEqual([tile.msg.rgba, tile.msg.ids]);
    const ids = new Uint8Array(65536);
    const rgba = paintTileAbortable(ctxFor('42'), 'biome', 64, 2, -1, new Uint8ClampedArray(262144), () => false, ids)!;
    expect(sameBytes(tile.msg.rgba, rgba)).toBe(true);
    expect(sameBytes(tile.msg.ids!, ids)).toBe(true);
    const pt = h.handle({ type: 'point', jobId: 9, epoch: 3, x: 100.5, z: -20 }).msg;
    expect(pt).toEqual({ type: 'pointResult', jobId: 9, epoch: 3, fields: columnPoint(ctxFor('42'), 100.5, -20) });
    expect(h.handle({ type: 'spawn', jobId: 10, epoch: 3 }).msg).toEqual({ type: 'spawnResult', jobId: 10, epoch: 3, spawn: findSpawn(ctxFor('42')) });
  });
  test('only biome tiles carry ids', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const r = h.handle({ ...tileMsg, layer: 'relief', level: 256 });
    expect(r.msg.type).toBe('tile');
    if (r.msg.type !== 'tile') return;
    expect('ids' in r.msg).toBe(false);
    expect(r.transfer).toEqual([r.msg.rgba]);
    expect(sameBytes(r.msg.rgba, paintTile(ctxFor('42'), 'relief', 256, 2, -1, new Uint8ClampedArray(262144)))).toBe(true);
  });
  test.each<[string, unknown[], string]>([
    ['malformed', [{ type: 'mapTile', jobId: 4 }], 'BAD_MESSAGE'],
    ['before configure', [tileMsg], 'NOT_CONFIGURED'],
    ['stale epoch', [configure(5, null, DEFAULTS, '1'), tileMsg], 'STALE_EPOCH'],
    ['invalid params', [configure(5, null, { climate: {} }, '1')], 'BAD_PARAMS'],
  ])('%s → %s', (_n, msgs, code) => {
    const h = createTaskHandler();
    let last = h.handle(msgs[0]).msg;
    for (const m of msgs.slice(1)) last = h.handle(m).msg;
    expect(last.type).toBe('error');
    if (last.type === 'error') expect(last.code).toBe(code);
  });
  test('errors carry the epoch of their message, or null (SP2a minor 4)', () => {
    const h = createTaskHandler();
    const pick = (raw: unknown) => {
      const m = h.handle(raw).msg;
      return m.type === 'error' ? [m.code, m.jobId, m.epoch] : [m.type];
    };
    expect(pick(configure(5, null, { climate: {} }))).toEqual(['BAD_PARAMS', null, 5]);
    expect(pick(configure(7, null, DEFAULTS, ' '))).toEqual(['BAD_MESSAGE', null, 7]);
    expect(pick({ type: 'configure', epoch: 1.5 })).toEqual(['BAD_MESSAGE', null, null]);
    expect(pick(5)).toEqual(['BAD_MESSAGE', null, null]);
    expect(pick({ ...tileMsg, tx: 99 })).toEqual(['BAD_MESSAGE', 1, 3]);
    expect(pick(tileMsg)).toEqual(['NOT_CONFIGURED', 1, 3]);
    expect(pick(configure(5))).toEqual(['ready']);
    expect(pick(tileMsg)).toEqual(['STALE_EPOCH', 1, 3]);
  });
  test('with an abort cell, tile and spawn jobs whose epoch the cell has left reply ABORTED; points and selftests never abort', () => {
    const sab = new SharedArrayBuffer(4);
    const cell = new Int32Array(sab);
    const h = createTaskHandler();
    Atomics.store(cell, 0, 3);
    expect(h.handle(configure(3, sab)).msg.type).toBe('ready');
    Atomics.store(cell, 0, 4);
    const tile = h.handle(tileMsg);
    expect(tile.msg).toMatchObject({ type: 'error', jobId: 1, epoch: 3, code: 'ABORTED' });
    expect(tile.transfer).toEqual([]);
    expect(h.handle({ type: 'spawn', jobId: 2, epoch: 3 }).msg).toMatchObject({ type: 'error', jobId: 2, epoch: 3, code: 'ABORTED' });
    expect(h.handle({ type: 'point', jobId: 3, epoch: 3, x: 1, z: 2 }).msg.type).toBe('pointResult');
    expect(h.handle({ type: 'selftest', jobId: 4, key: 'sp1.params' }).msg.type).toBe('selftestResult');
    Atomics.store(cell, 0, 3);
    expect(h.handle({ ...tileMsg, level: 256 }).msg.type).toBe('tile');
    expect(h.handle({ type: 'spawn', jobId: 5, epoch: 3 }).msg.type).toBe('spawnResult');
  });
  test('stats jobs reply with the raw sums of the metrics functions over their point range, transferred (SP2b spec §5.4)', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const ctx = ctxFor('42');
    const cases: Array<[unknown, Float64Array]> = [];
    for (const node of [[], [6], [6, 0]] as const) {
      const len = splineLen('shape.offset', node);
      const out = new Float64Array(len);
      expect(splineStatsInto(ctx, 'shape.offset', node, splineStatPoints(), 1000, 4000, out)).toBe(true);
      cases.push([stats(20 + node.length, 3, 'splineStats', 1000, 4000, { len, leaf: 'shape.offset', node }), out]);
    }
    const shares = new Float64Array(biomeSharesLength());
    expect(biomeSharesInto(ctx, biomeSharePoints(), BIOME_SHARES_POINTS - 1500, BIOME_SHARES_POINTS, shares)).toBe(true);
    cases.push([stats(30, 3, 'biomeShares', BIOME_SHARES_POINTS - 1500, BIOME_SHARES_POINTS, { len: biomeSharesLength() }), shares]);
    for (const [from, to] of [[0, CROSS_SECTION_POINTS], [100, 300]] as const) {
      const section = new Float64Array(crossSectionLength());
      expect(crossSectionInto(ctx, { ax: 5120, az: 3072, bx: 6656, bz: 3072 }, from, to, section)).toBe(true);
      cases.push([stats(40 + from, 3, 'crossSection', from, to, line(5120, 3072, 6656, 3072)), section]);
    }
    for (const [msg, want] of cases) {
      const r = h.handle(msg);
      const { jobId, kind } = msg as { jobId: number; kind: string };
      expect(r.msg).toMatchObject({ type: 'statsResult', jobId, epoch: 3, kind });
      if (r.msg.type !== 'statsResult') return;
      expect(r.transfer).toEqual([r.msg.data]);
      expect(Array.from(new Float64Array(r.msg.data))).toEqual(Array.from(want));
    }
  });
  test('the streams are the metrics streams: splineStats has 60 000 points, biomeShares 100 000, crossSection 512 along its line', () => {
    expect([SPLINE_STATS_POINTS, splineStatPoints().n, BIOME_SHARES_POINTS, biomeSharePoints().n, CROSS_SECTION_POINTS]).toEqual([60000, 60000, 100000, 100000, 512]);
  });
  test('stats arguments that do not fit the configured params reply BAD_ARGS with the job\'s epoch', () => {
    const flat = flattenKnot(DEFAULTS.shape.offset, [6], new Float64Array(6), leafOpts('shape.offset'));
    if (!flat.ok) throw new Error('flatten failed');
    const h = createTaskHandler();
    h.handle(configure(3, null, { ...DEFAULTS, shape: { ...DEFAULTS.shape, offset: flat.value } }));
    const root = splineLen('shape.offset', []);
    const code = (m: unknown) => {
      const r = h.handle(m).msg;
      return r.type === 'error' ? [r.code, r.jobId, r.epoch] : [r.type];
    };
    // Node [6] exists in the default offset, not in the configured (flattened) one.
    expect(code(stats(1, 3, 'splineStats', 0, 10, { len: splineLen('shape.offset', [6]), leaf: 'shape.offset', node: [6] }))).toEqual(['BAD_ARGS', 1, 3]);
    expect(code(stats(2, 3, 'splineStats', 0, 10, { len: root, leaf: 'shape.offset', node: [0] }))).toEqual(['BAD_ARGS', 2, 3]);
    expect(code(stats(3, 3, 'splineStats', 0, 10, { len: root, leaf: 'shape.offset', node: [99] }))).toEqual(['BAD_ARGS', 3, 3]);
    expect(code(stats(4, 3, 'splineStats', 0, 10, { len: root, leaf: 'shape.nope', node: [] }))).toEqual(['BAD_ARGS', 4, 3]);
    expect(code(stats(5, 3, 'splineStats', 0, 10, { len: root + 2, leaf: 'shape.offset', node: [] }))).toEqual(['BAD_ARGS', 5, 3]);
    expect(code(stats(6, 3, 'splineStats', 0, SPLINE_STATS_POINTS + 1, { len: root, leaf: 'shape.offset', node: [] }))).toEqual(['BAD_ARGS', 6, 3]);
    expect(code(stats(7, 3, 'biomeShares', 0, 10, { len: biomeSharesLength() - 1 }))).toEqual(['BAD_ARGS', 7, 3]);
    expect(code(stats(8, 3, 'biomeShares', BIOME_SHARES_POINTS, BIOME_SHARES_POINTS + 1, { len: biomeSharesLength() }))).toEqual(['BAD_ARGS', 8, 3]);
    expect(code(stats(9, 3, 'splineStats', 0, 10, { len: root, leaf: 'shape.offset', node: [] }))).toEqual(['statsResult']);
    expect(code(stats(10, 3, 'splineStats', 0, 10, { len: splineLen('shape.jag', [1]), leaf: 'shape.jag', node: [1] }))).toEqual(['statsResult']);
  });
  test('a crossSection whose line leaves the half-open world window or has no length replies BAD_ARGS (SP2b spec §4.5)', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const reply = (args: unknown, from = 0, to = 512) => {
      const r = h.handle(stats(1, 3, 'crossSection', from, to, args)).msg;
      return r.type === 'error' ? [r.code, r.jobId, r.epoch, r.message] : [r.type];
    };
    const outside = (end: string, x: string, z: string) => ['BAD_ARGS', 1, 3, `${end} (${x}, ${z}) is outside the world window [-524288, 524288)`];
    expect(reply(line(524288, 0, 0, 0))).toEqual(outside('A', '524288', '0'));
    expect(reply(line(0, -524289, 0, 0))).toEqual(outside('A', '0', '-524289'));
    expect(reply(line(0, 0, 100, 524288))).toEqual(outside('B', '100', '524288'));
    expect(reply(line(Number.NaN, 0, 100, 0))).toEqual(outside('A', 'NaN', '0'));
    expect(reply(line(0, 0, -Infinity, 0))).toEqual(outside('B', '-Infinity', '0'));
    expect(reply(line(-40, 9, -40, 9))).toEqual(['BAD_ARGS', 1, 3, 'A and B are the same point (-40, 9)']);
    expect(reply(line(0, 0, 100, 0, 4095))).toEqual(['BAD_ARGS', 1, 3, 'args.len 4095, expected 4096']);
    expect(reply(line(0, 0, 100, 0), 0, 513)).toEqual(['BAD_ARGS', 1, 3, 'points [0, 513) outside the stream of 512']);
    // The window's own corners are inside: −2^19 is in it, 2^19 − 1 too.
    expect(reply(line(-524288, -524288, 524287, 524287))).toEqual(['statsResult']);
  });
  test('with an abort cell, a stats job whose epoch the cell has left replies ABORTED', () => {
    const sab = new SharedArrayBuffer(4);
    const cell = new Int32Array(sab);
    const h = createTaskHandler();
    Atomics.store(cell, 0, 3);
    h.handle(configure(3, sab));
    Atomics.store(cell, 0, 4);
    const r = h.handle(stats(1, 3, 'biomeShares', 0, 1000, { len: biomeSharesLength() }));
    expect(r.msg).toMatchObject({ type: 'error', jobId: 1, epoch: 3, code: 'ABORTED' });
    expect(r.transfer).toEqual([]);
    expect(h.handle(stats(2, 3, 'splineStats', 0, 1000, { len: splineLen('shape.offset', []), leaf: 'shape.offset', node: [] })).msg).toMatchObject({ code: 'ABORTED' });
    expect(h.handle(stats(4, 3, 'crossSection', 0, 512, line(5120, 3072, 6656, 3072))).msg).toMatchObject({ type: 'error', jobId: 4, epoch: 3, code: 'ABORTED' });
    Atomics.store(cell, 0, 3);
    expect(h.handle(stats(3, 3, 'biomeShares', 0, 1000, { len: biomeSharesLength() })).msg.type).toBe('statsResult');
  });
  test('selftest needs no configure and reports digests or errors per key', () => {
    const h = createTaskHandler();
    expect(h.handle({ type: 'selftest', jobId: 1, key: 'sp1.params' }).msg).toEqual({ type: 'selftestResult', jobId: 1, key: 'sp1.params', actual: computeAnyGolden('sp1.params'), error: null });
    expect(h.handle({ type: 'selftest', jobId: 2, key: 'sp9.nope' }).msg).toEqual({ type: 'selftestResult', jobId: 2, key: 'sp9.nope', actual: null, error: 'unknown golden sp9.nope' });
  });
  test('an error keeps the jobId of the failing job', () => {
    const h = createTaskHandler();
    const r = h.handle(tileMsg).msg;
    expect(r.type === 'error' && r.jobId).toBe(1);
  });
});

describe('slice messages and the slice job (SP3a spec §5.1)', () => {
  const slice = (jobId: number, epoch: number, ax: unknown, az: unknown, bx: unknown, bz: unknown, from: unknown = 0, to: unknown = 512) => ({ type: 'slice', jobId, epoch, ax, az, bx, bz, from, to });
  const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
  const coast = (jobId: number, epoch: number, from = 0, to = 512) => slice(jobId, epoch, COAST.ax, COAST.az, COAST.bx, COAST.bz, from, to);
  const live = (s: { blockPool: { slotCount(): number; freeCount(): number }; bytePool: { slotCount(): number; freeCount(): number } }) =>
    [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];

  test('parseToWorker: integer jobId and epoch, numeric ends and range (the window, A ≠ B and the range are the handler\'s BAD_ARGS)', () => {
    expect(parseToWorker(coast(1, 0))).not.toBeNull();
    for (const m of [slice(1, 0, 524288, 0, 0, 0), slice(1, 0, Number.NaN, 0, 1, 1), slice(1, 0, 7, 7, 7, 7), slice(1, 0, 0, 0, 1, 1, 1.5, 600), slice(1, 0, 0, 0, 1, 1, Number.NaN, -1)]) expect(parseToWorker(m)).not.toBeNull();
    for (const m of [slice(1.5, 0, 0, 0, 1, 1), slice(1, null as unknown as number, 0, 0, 1, 1), slice(1, 0, '0', 0, 1, 1), slice(1, 0, 0, 0, 1, undefined), { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1, from: 0, to: 512 }]) {
      expect(parseToWorker(m)).toBeNull();
    }
    // SP3b spec §6: the message carries from and to.
    for (const m of [slice(1, 0, 0, 0, 1, 1, '0', 512), slice(1, 0, 0, 0, 1, 1, 0, null), { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1, bz: 1 }, { type: 'slice', jobId: 1, epoch: 0, ax: 0, az: 0, bx: 1, bz: 1, from: 0 }]) {
      expect(parseToWorker(m)).toBeNull();
    }
  });
  test('parseFromWorker: sliceResult carries its range [from, to) and (to − from)·384 u16 block states and fluid bytes in ArrayBuffers', () => {
    const result = (blocks: unknown, fluid: unknown, jobId: unknown = 4, from: unknown = 0, to: unknown = 512) => ({ type: 'sliceResult', jobId, epoch: 2, from, to, blocks, fluid });
    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).not.toBeNull();
    expect(parseFromWorker(result(new ArrayBuffer(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBeNull();
    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(2 * SLICE_SAMPLES)))).toBeNull();
    expect(parseFromWorker(result(new Uint16Array(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBeNull();
    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new Uint8Array(SLICE_SAMPLES)))).toBeNull();
    expect(parseFromWorker(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES), null))).toBeNull();
    const part = (from: unknown, to: unknown, w: number) => ({ type: 'sliceResult', jobId: 4, epoch: 2, from, to, blocks: new ArrayBuffer(2 * SLICE_ROWS * w), fluid: new ArrayBuffer(SLICE_ROWS * w) });
    for (const [from, to] of [[170, 341], [0, 1], [511, 512], [0, 512]] as const) expect(parseFromWorker(part(from, to, to - from))).not.toBeNull();
    for (const [from, to, w] of [[170, 341, 170], [170, 341, 512], [0, 513, 513], [-1, 1, 2], [5, 5, 0], [1.5, 3, 1.5], ['0', 1, 1], [0, undefined, 512], [undefined, 512, 512]] as const) {
      expect(parseFromWorker(part(from, to, w)), `[${from}, ${to}) with ${w} samples`).toBeNull();
    }
  });
  test('a slice replies with the slice job\'s blocks and fluid, both transferred, at the job\'s epoch', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const r = h.handle(coast(7, 3));
    expect(r.msg).toMatchObject({ type: 'sliceResult', jobId: 7, epoch: 3, from: 0, to: 512 });
    if (r.msg.type !== 'sliceResult') return;
    expect(r.transfer).toEqual([r.msg.blocks, r.msg.fluid]);
    const want = createSliceJob().run(ctxFor('42'), 3, COAST, () => false)!;
    expect(sameBytes(r.msg.blocks, want.blocks)).toBe(true);
    expect(sameBytes(r.msg.fluid, want.fluid)).toBe(true);
  });
  test('a slice of the range [from, to) replies with that part only, indexed (319 − y)·(to − from) + (i − from) (SP3b spec §6)', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const full = createSliceJob().run(ctxFor('42'), 3, COAST, () => false)!;
    for (const [from, to] of [[0, 170], [170, 341], [341, 512], [255, 256]] as const) {
      const r = h.handle(coast(8, 3, from, to));
      expect(r.msg).toMatchObject({ type: 'sliceResult', jobId: 8, epoch: 3, from, to });
      if (r.msg.type !== 'sliceResult') return;
      expect(r.transfer).toEqual([r.msg.blocks, r.msg.fluid]);
      const w = to - from;
      expect([r.msg.blocks.byteLength, r.msg.fluid.byteLength]).toEqual([2 * SLICE_ROWS * w, SLICE_ROWS * w]);
      const blocks = new Uint16Array(r.msg.blocks);
      const fluid = new Uint8Array(r.msg.fluid);
      for (const y of [319, 120, 63, 62, 0, -63, -64]) {
        for (let i = from; i < to; i++) {
          expect(blocks[slicePartIndex(i, y, from, to)]).toBe(full.blocks[sliceIndex(i, y)]);
          expect(fluid[slicePartIndex(i, y, from, to)]).toBe(full.fluid[sliceIndex(i, y)]);
        }
      }
    }
  });
  test('a range that is not integers with 0 ≤ from < to ≤ 512 is BAD_ARGS (SP3b spec §6)', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const bad = (from: number, to: number) => ['BAD_ARGS', 1, 3, `points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 512`];
    for (const [from, to] of [[-1, 512], [0, 513], [5, 5], [6, 5], [1.5, 10], [0, 10.5], [Number.NaN, 10], [0, Number.POSITIVE_INFINITY], [-0.5, 0.5]] as const) {
      const r = h.handle(coast(1, 3, from, to)).msg;
      expect(r.type === 'error' ? [r.code, r.jobId, r.epoch, r.message] : [r.type]).toEqual(bad(from, to));
    }
    expect(h.handle(coast(2, 3, 511, 512)).msg.type).toBe('sliceResult');
  });
  test('a slice before configure, of a stale epoch or whose line leaves the half-open window or has no length is refused', () => {
    const h = createTaskHandler();
    const reply = (m: unknown) => {
      const r = h.handle(m).msg;
      return r.type === 'error' ? [r.code, r.jobId, r.epoch, r.message] : [r.type];
    };
    expect(reply(coast(1, 3)).slice(0, 3)).toEqual(['NOT_CONFIGURED', 1, 3]);
    h.handle(configure(3));
    expect(reply(coast(2, 2)).slice(0, 3)).toEqual(['STALE_EPOCH', 2, 2]);
    const outside = (end: string, x: string, z: string) => ['BAD_ARGS', 1, 3, `${end} (${x}, ${z}) is outside the world window [-524288, 524288)`];
    expect(reply(slice(1, 3, 524288, 0, 0, 0))).toEqual(outside('A', '524288', '0'));
    expect(reply(slice(1, 3, 0, -524289, 0, 0))).toEqual(outside('A', '0', '-524289'));
    expect(reply(slice(1, 3, 0, 0, 100, 524288))).toEqual(outside('B', '100', '524288'));
    expect(reply(slice(1, 3, Number.NaN, 0, 100, 0))).toEqual(outside('A', 'NaN', '0'));
    expect(reply(slice(1, 3, 0, 0, -Infinity, 0))).toEqual(outside('B', '-Infinity', '0'));
    expect(reply(slice(1, 3, -40, 9, -40, 9))).toEqual(['BAD_ARGS', 1, 3, 'A and B are the same point (-40, 9)']);
    // The window's own corners are inside.
    expect(reply(slice(1, 3, -524288, -524288, 524287, 524287))).toEqual(['sliceResult']);
  });
  test('with an abort cell, a slice whose epoch the cell has left replies ABORTED and keeps no half-written column', () => {
    const sab = new SharedArrayBuffer(4);
    const cell = new Int32Array(sab);
    const job = createSliceJob();
    const h = createTaskHandler(job);
    Atomics.store(cell, 0, 3);
    h.handle(configure(3, sab));
    Atomics.store(cell, 0, 4);
    const r = h.handle(coast(1, 3));
    expect(r.msg).toMatchObject({ type: 'error', jobId: 1, epoch: 3, code: 'ABORTED' });
    expect(r.transfer).toEqual([]);
    expect([job.misses, job.resident()]).toEqual([0, []]);
    Atomics.store(cell, 0, 3);
    expect(h.handle(coast(2, 3)).msg.type).toBe('sliceResult');
  });
  test('the worker keeps one slice store for its lifetime; a configure frees every resident column and empties the LRU', () => {
    const job = createSliceJob();
    const h = createTaskHandler(job);
    h.handle(configure(3));
    expect(job.store).toBeNull();
    const first = h.handle(coast(1, 3)).msg;
    const store = job.store!;
    expect(job.resident().length).toBeGreaterThan(0);
    expect(live(store).every((n) => n > 0)).toBe(true);
    expect(h.handle(configure(4, null, DEFAULTS, '7')).msg.type).toBe('ready');
    expect([job.resident(), live(store)]).toEqual([[], [0, 0]]);
    // A failed configure keeps the configured epoch, its context and its columns.
    const other = h.handle(coast(2, 4)).msg;
    const resident = job.resident();
    expect(h.handle(configure(5, null, { climate: {} })).msg).toMatchObject({ code: 'BAD_PARAMS' });
    expect(job.resident()).toEqual(resident);
    expect(h.handle(configure(6)).msg.type).toBe('ready');
    const again = h.handle(coast(3, 6)).msg;
    expect(job.store).toBe(store);
    if (first.type !== 'sliceResult' || other.type !== 'sliceResult' || again.type !== 'sliceResult') throw new Error('no slice');
    expect(sameBytes(again.blocks, first.blocks)).toBe(true);
    expect(sameBytes(other.blocks, first.blocks)).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { DEFAULTS } from '../../src/core/params/defaults';
import { flattenKnot } from '../../src/core/spline/edit';
import type { KnotPath } from '../../src/core/spline/types';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, landingSurface, ringOffsets } from '../../src/gen/column/spawn';
import { BIOME_SHARES_POINTS, biomeSharePoints, biomeSharesInto, biomeSharesLength } from '../../src/metrics/biomeShares';
import { CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength, segmentPointAt } from '../../src/metrics/crossSection';
import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { SPLINE_STATS_POINTS, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode, type SplineLeaf } from '../../src/metrics/splineStats';
import { paintTile, paintTileAbortable } from '../../src/gen/map/tile';
import { createSurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbe } from '../../src/gen/surface/probe';
import { AIR, BEDROCK, DEEPSLATE, REGISTRY, SNOW_BLOCK } from '../../src/world/blocks/index';
import { leafOpts } from '../../src/ui/splineEditor/model';
import { cellOf, parseFromSim, parseFromWorker, parseSpikeStoreFromWorker, parseSpikeStoreToWorker, parseToSim, parseToWorker, pointInWindow, SLICE_ROWS, SLICE_SAMPLES, sliceIndex, slicePartIndex, tileInWindow, type FromWorker, type ScopedJobType } from '../../src/workers/protocol';
import { createSliceJob } from '../../src/workers/sliceJob';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const tileMsg = { type: 'mapTile', jobId: 1, epoch: 3, scope: 3, layer: 'biome', level: 64, tx: 2, tz: -1 };
const configure = (epoch: number, epochs: SharedArrayBuffer | null = null, params: unknown = DEFAULTS, seedText = '42') => ({ type: 'configure', epoch, seedText, params, epochs });
const stats = (jobId: number, epoch: number, kind: string, from: number, to: number, args: unknown) => ({ type: 'stats', jobId, epoch, scope: epoch, kind, from, to, args });
/** A crossSection job's args: the sum's length and the segment's ends. */
const line = (ax: number, az: number, bx: number, bz: number, len = 4096) => ({ len, ax, az, bx, bz });
/** The length of a splineStats sum for the node at `node` of the leaf's default spline. */
const splineLen = (leaf: SplineLeaf, node: KnotPath) => splineStatsLength(splineStatsNode(DEFAULTS, leaf, node)!.points.length);
/** Byte equality through Buffer (vitest's deep equality is slow on 262 144-byte arrays). */
const sameBytes = (a: ArrayBufferLike, b: ArrayBufferLike | ArrayBufferView) =>
  Buffer.from(a).equals(ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b));
/** A reply the pool accepts, and one it does not (null, or SP3d's `{bad, jobId, reason}` when its jobId is readable). */
const valid = (m: unknown): boolean => {
  const r = parseFromWorker(m);
  return r !== null && !('bad' in r);
};
const invalid = (m: unknown): boolean => !valid(m);

describe('parseToWorker', () => {
  test('valid messages pass', () => {
    expect(parseToWorker(configure(0))).not.toBeNull();
    expect(parseToWorker(configure(0, new SharedArrayBuffer(16)))).not.toBeNull();
    expect(parseToWorker(tileMsg)).not.toBeNull();
    expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, scope: 3, x: 1.5, z: -7 })).not.toBeNull();
    expect(parseToWorker({ type: 'spawn', jobId: 4, epoch: 3, scope: 3 })).not.toBeNull();
    expect(parseToWorker({ type: 'selftest', jobId: 5, key: 'sp1.params' })).not.toBeNull();
    expect(parseToWorker(stats(6, 3, 'splineStats', 0, 100, { len: 87, leaf: 'shape.offset', node: [6, 0] }))).not.toBeNull();
    expect(parseToWorker(stats(7, 3, 'biomeShares', 5, 5, { len: 31 }))).not.toBeNull();
    expect(parseToWorker(stats(8, 3, 'crossSection', 0, 512, line(5120, 3072, 6656, 3072)))).not.toBeNull();
    expect(parseToWorker({ type: 'slice', jobId: 9, epoch: 3, scope: 3, ax: 5120, az: 3072, bx: 6656, bz: 3072, from: 0, to: 512 })).not.toBeNull();
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
    ['configure without epochs', { type: 'configure', epoch: 0, seedText: '42', params: {} }],
    ['epochs that are not shared', { ...configure(0), epochs: new ArrayBuffer(16) }],
    ['epochs of the wrong size', configure(0, new SharedArrayBuffer(8))],
    ['bad layer', { ...tileMsg, layer: 'caves' }],
    ['bad level', { ...tileMsg, level: 32 }],
    ['non-integer tile', { ...tileMsg, tx: 0.5 }],
    ['tile outside the window', { ...tileMsg, tx: 40 }],
    ['preview tile just past the window (SP2a minor 1)', { ...tileMsg, level: 256, tx: 8 }],
    ['point outside the window', { type: 'point', jobId: 2, epoch: 3, scope: 3, x: 1e7, z: 0 }],
    ['point on the window edge x = 2^19 (SP2a minor 1)', { type: 'point', jobId: 2, epoch: 3, scope: 3, x: 524288, z: 0 }],
    ['point on the window edge z = 2^19', { type: 'point', jobId: 2, epoch: 3, scope: 3, x: 0, z: 524288 }],
    ['non-finite point', { type: 'point', jobId: 2, epoch: 3, scope: 3, x: Number.NaN, z: 0 }],
    ['stats of an unknown kind', stats(6, 3, 'nope', 0, 10, { len: 31 })],
    ['stats with from > to', stats(6, 3, 'biomeShares', 10, 9, { len: 31 })],
    ['stats with a negative from', stats(6, 3, 'biomeShares', -1, 9, { len: 31 })],
    ['stats with a non-integer to', stats(6, 3, 'biomeShares', 0, 9.5, { len: 31 })],
    ['stats without args', { type: 'stats', jobId: 6, epoch: 3, scope: 3, kind: 'biomeShares', from: 0, to: 9 }],
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
    expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, scope: 3, x: -524288, z: 524287.5 })).not.toBeNull();
  });
});

describe('the per-scope epoch cells and every job\'s scope (SP4b spec §2.7)', () => {
  /** One valid message of each of the thirteen scoped job types, at epoch 3 and scope 5, and the cell it reads. */
  const SCOPED: ReadonlyArray<[ScopedJobType, Record<string, unknown>, number]> = [
    ['mapTile', { ...tileMsg, scope: 5 }, 0],
    ['point', { type: 'point', jobId: 2, epoch: 3, scope: 5, x: 1.5, z: -7 }, 0],
    ['spawn', { type: 'spawn', jobId: 4, epoch: 3, scope: 5 }, 0],
    ['stats', { ...stats(6, 3, 'biomeShares', 0, 10, { len: 31 }), scope: 5 }, 0],
    ['slice', { type: 'slice', jobId: 9, epoch: 3, scope: 5, ax: 5120, az: 3072, bx: 6656, bz: 3072, from: 0, to: 512 }, 0],
    ['surfaceProbe', { type: 'surfaceProbe', jobId: 10, epoch: 3, scope: 5, x: 0, y: 70, z: 0 }, 0],
    ['fieldSlice', { type: 'fieldSlice', jobId: 11, epoch: 3, scope: 5, plane: 'vertical', ax: -1664, az: 8, bx: -640, bz: 8, y: 63, n: 128, field: 'density', path: '', from: 0, to: 64 }, 0],
    ['fieldProbe', { type: 'fieldProbe', jobId: 12, epoch: 3, scope: 5, field: 'rule', path: 'root.rules[2]', x: 5, y: 63, z: -9 }, 0],
    ['terrain', { type: 'terrain', jobId: 13, epoch: 3, scope: 5, cx: 2, cz: -1 }, 0],
    ['decorate', { type: 'decorate', jobId: 14, epoch: 3, scope: 5, cx: 2, cz: -1 }, 1],
    ['light', { type: 'light', jobId: 15, epoch: 3, scope: 5, cx: 2, cz: -1 }, 2],
    ['meshColumn', { type: 'meshColumn', jobId: 16, epoch: 3, scope: 5, cx: 2, cz: -1 }, 3],
    ['landing', { type: 'landing', jobId: 17, epoch: 3, scope: 5, x: -320, z: 128 }, 0],
  ];

  test('configure accepts epochs null or a 16-byte SharedArrayBuffer and refuses 4 bytes or an ArrayBuffer', () => {
    expect(parseToWorker(configure(0, null))).not.toBeNull();
    expect(parseToWorker(configure(0, new SharedArrayBuffer(16)))).not.toBeNull();
    expect(parseToWorker(configure(0, new SharedArrayBuffer(4)))).toBeNull();
    expect(parseToWorker({ ...configure(0), epochs: new ArrayBuffer(16) })).toBeNull();
    expect(parseToWorker({ type: 'configure', epoch: 0, seedText: '42', params: DEFAULTS })).toBeNull();
    expect(parseToWorker({ type: 'configure', epoch: 0, seedText: '42', params: DEFAULTS, abort: null })).toBeNull();
  });
  test.each(SCOPED)('%s parses with an integer scope and is refused without one', (type, m) => {
    expect(parseToWorker(m)).toMatchObject({ type, epoch: 3, scope: 5 });
    const { scope: _, ...unscoped } = m;
    for (const bad of [unscoped, { ...m, scope: 1.5 }, { ...m, scope: '5' }, { ...m, scope: null }, { ...m, scope: Number.NaN }]) {
      expect(parseToWorker(bad), `${type} with scope ${String(bad['scope'])}`).toBeNull();
    }
  });
  test('selftest carries neither epoch nor scope', () => {
    expect(parseToWorker({ type: 'selftest', jobId: 5, key: 'sp1.params' })).not.toBeNull();
  });
  test('cellOf: decorate 1, light 2, meshColumn 3, every other scoped type 0 (terrain, spawn, tiles, stats, slices, field slices, probes, points, landing)', () => {
    expect(SCOPED.map(([type]) => [type, cellOf(type)])).toEqual(SCOPED.map(([type, , cell]) => [type, cell]));
    expect(SCOPED).toHaveLength(13);
  });
});

describe('parseFromWorker', () => {
  test('tile buffers must be 256·256·4 bytes; ids, when present, 256·256 bytes', () => {
    expect(valid({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144) })).toBe(true);
    expect(invalid({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(10) })).toBe(true);
    expect(valid({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144), ids: new ArrayBuffer(65536) })).toBe(true);
    expect(invalid({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144), ids: new ArrayBuffer(10) })).toBe(true);
    expect(invalid({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144), ids: null })).toBe(true);
  });
  test('errors carry an epoch (an integer or null)', () => {
    expect(valid({ type: 'error', jobId: null, epoch: null, code: 'BAD_MESSAGE', message: 'x' })).toBe(true);
    expect(valid({ type: 'error', jobId: 4, epoch: 3, code: 'ABORTED', message: 'x' })).toBe(true);
    expect(invalid({ type: 'error', jobId: null, code: 'BAD_MESSAGE', message: 'x' })).toBe(true);
    expect(invalid({ type: 'error', jobId: null, epoch: 1.5, code: 'BAD_MESSAGE', message: 'x' })).toBe(true);
  });
  test('stats results carry a whole, non-zero number of Float64 values in an ArrayBuffer', () => {
    const result = (kind: string, data: unknown) => ({ type: 'statsResult', jobId: 6, epoch: 3, kind, data });
    expect(valid(result('biomeShares', new ArrayBuffer(8 * 31)))).toBe(true);
    expect(valid(result('splineStats', new ArrayBuffer(8)))).toBe(true);
    expect(valid(result('crossSection', new ArrayBuffer(8 * 4096)))).toBe(true);
    expect(invalid(result('biomeShares', new ArrayBuffer(12)))).toBe(true);
    expect(invalid(result('biomeShares', new ArrayBuffer(0)))).toBe(true);
    expect(invalid(result('biomeShares', new Float64Array(31)))).toBe(true);
    expect(invalid(result('nope', new ArrayBuffer(8)))).toBe(true);
    expect(invalid({ ...result('biomeShares', new ArrayBuffer(8)), jobId: null })).toBe(true);
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
    const pt = h.handle({ type: 'point', jobId: 9, epoch: 3, scope: 3, x: 100.5, z: -20 }).msg;
    expect(pt).toEqual({ type: 'pointResult', jobId: 9, epoch: 3, fields: columnPoint(ctxFor('42'), 100.5, -20) });
    expect(h.handle({ type: 'spawn', jobId: 10, epoch: 3, scope: 3 }).msg).toEqual({ type: 'spawnResult', jobId: 10, epoch: 3, spawn: findSpawn(ctxFor('42')) });
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
  test('configure runs tier 2 of the trees after checkParams: BAD_PARAMS with the first 5 issues, the configured epoch kept (SP3d spec §1.8)', () => {
    const h = createTaskHandler();
    const withDefs = (defs: unknown) => ({ ...DEFAULTS, density: { ...DEFAULTS.density, defs } });
    const one = { root: { op: 'add', a: { op: 'y' }, b: { op: 'bogus' } }, defs: {} };
    const seven = { root: { op: 'y' }, defs: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`d${i}`, { op: `bogus${i}` }])) };
    expect(h.handle(configure(4)).msg.type).toBe('ready');
    expect(h.handle(configure(5, null, withDefs(one))).msg).toEqual({ type: 'error', jobId: null, epoch: 5, code: 'BAD_PARAMS', message: 'density.defs.root.b: UNKNOWN_OP' });
    const many = h.handle(configure(6, null, withDefs(seven))).msg;
    expect(many).toMatchObject({ type: 'error', code: 'BAD_PARAMS', epoch: 6 });
    if (many.type === 'error') expect(many.message.split('; ')).toEqual([1, 2, 3, 4, 5].map((i) => `density.defs.defs.d${i}: UNKNOWN_OP`));
    // A rules issue carries its leaf path too; the context of epoch 4 still answers.
    const rules = { kind: 'sequence', rules: [{ kind: 'block', state: 'no_such_block' }] };
    const r = h.handle(configure(7, null, { ...DEFAULTS, surface: { ...DEFAULTS.surface, rules } })).msg;
    expect(r).toEqual({ type: 'error', jobId: null, epoch: 7, code: 'BAD_PARAMS', message: 'surface.rules.root.rules[0].state: UNKNOWN_BLOCK' });
    expect(h.handle({ type: 'point', jobId: 9, epoch: 4, scope: 4, x: 1.5, z: -7 }).msg.type).toBe('pointResult');
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
  test('with epoch cells, tile and spawn jobs whose epoch the cell has left reply ABORTED; points and selftests never abort', () => {
    const sab = new SharedArrayBuffer(16);
    const cell = new Int32Array(sab);
    const h = createTaskHandler();
    Atomics.store(cell, 0, 3);
    expect(h.handle(configure(3, sab)).msg.type).toBe('ready');
    Atomics.store(cell, 0, 4);
    const tile = h.handle(tileMsg);
    expect(tile.msg).toMatchObject({ type: 'error', jobId: 1, epoch: 3, code: 'ABORTED' });
    expect(tile.transfer).toEqual([]);
    expect(h.handle({ type: 'spawn', jobId: 2, epoch: 3, scope: 3 }).msg).toMatchObject({ type: 'error', jobId: 2, epoch: 3, code: 'ABORTED' });
    expect(h.handle({ type: 'point', jobId: 3, epoch: 3, scope: 3, x: 1, z: 2 }).msg.type).toBe('pointResult');
    expect(h.handle({ type: 'selftest', jobId: 4, key: 'sp1.params' }).msg.type).toBe('selftestResult');
    Atomics.store(cell, 0, 3);
    expect(h.handle({ ...tileMsg, level: 256 }).msg.type).toBe('tile');
    expect(h.handle({ type: 'spawn', jobId: 5, epoch: 3, scope: 3 }).msg.type).toBe('spawnResult');
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
  test('with epoch cells, a stats job whose epoch the cell has left replies ABORTED', () => {
    const sab = new SharedArrayBuffer(16);
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
  const slice = (jobId: number, epoch: number, ax: unknown, az: unknown, bx: unknown, bz: unknown, from: unknown = 0, to: unknown = 512) => ({ type: 'slice', jobId, epoch, scope: epoch, ax, az, bx, bz, from, to });
  const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };
  const coast = (jobId: number, epoch: number, from = 0, to = 512) => slice(jobId, epoch, COAST.ax, COAST.az, COAST.bx, COAST.bz, from, to);
  const live = (s: { blockPool: { slotCount(): number; freeCount(): number }; bytePool: { slotCount(): number; freeCount(): number } }) =>
    [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];

  test('parseToWorker: integer jobId and epoch, numeric ends and range (the window, A ≠ B and the range are the handler\'s BAD_ARGS)', () => {
    expect(parseToWorker(coast(1, 0))).not.toBeNull();
    for (const m of [slice(1, 0, 524288, 0, 0, 0), slice(1, 0, Number.NaN, 0, 1, 1), slice(1, 0, 7, 7, 7, 7), slice(1, 0, 0, 0, 1, 1, 1.5, 600), slice(1, 0, 0, 0, 1, 1, Number.NaN, -1)]) expect(parseToWorker(m)).not.toBeNull();
    for (const m of [slice(1.5, 0, 0, 0, 1, 1), slice(1, null as unknown as number, 0, 0, 1, 1), slice(1, 0, '0', 0, 1, 1), slice(1, 0, 0, 0, 1, undefined), { type: 'slice', jobId: 1, epoch: 0, scope: 0, ax: 0, az: 0, bx: 1, from: 0, to: 512 }]) {
      expect(parseToWorker(m)).toBeNull();
    }
    // SP3b spec §6: the message carries from and to.
    for (const m of [slice(1, 0, 0, 0, 1, 1, '0', 512), slice(1, 0, 0, 0, 1, 1, 0, null), { type: 'slice', jobId: 1, epoch: 0, scope: 0, ax: 0, az: 0, bx: 1, bz: 1 }, { type: 'slice', jobId: 1, epoch: 0, scope: 0, ax: 0, az: 0, bx: 1, bz: 1, from: 0 }]) {
      expect(parseToWorker(m)).toBeNull();
    }
  });
  test('parseFromWorker: sliceResult carries its range [from, to) and (to − from)·384 u16 block states and fluid bytes in ArrayBuffers', () => {
    const result = (blocks: unknown, fluid: unknown, jobId: unknown = 4, from: unknown = 0, to: unknown = 512) => ({ type: 'sliceResult', jobId, epoch: 2, from, to, blocks, fluid });
    expect(valid(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBe(true);
    expect(invalid(result(new ArrayBuffer(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBe(true);
    expect(invalid(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(2 * SLICE_SAMPLES)))).toBe(true);
    expect(invalid(result(new Uint16Array(SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES)))).toBe(true);
    expect(invalid(result(new ArrayBuffer(2 * SLICE_SAMPLES), new Uint8Array(SLICE_SAMPLES)))).toBe(true);
    expect(invalid(result(new ArrayBuffer(2 * SLICE_SAMPLES), new ArrayBuffer(SLICE_SAMPLES), null))).toBe(true);
    const part = (from: unknown, to: unknown, w: number) => ({ type: 'sliceResult', jobId: 4, epoch: 2, from, to, blocks: new ArrayBuffer(2 * SLICE_ROWS * w), fluid: new ArrayBuffer(SLICE_ROWS * w) });
    for (const [from, to] of [[170, 341], [0, 1], [511, 512], [0, 512]] as const) expect(valid(part(from, to, to - from))).toBe(true);
    for (const [from, to, w] of [[170, 341, 170], [170, 341, 512], [0, 513, 513], [-1, 1, 2], [5, 5, 0], [1.5, 3, 1.5], ['0', 1, 1], [0, undefined, 512], [undefined, 512, 512]] as const) {
      expect(invalid(part(from, to, w)), `[${from}, ${to}) with ${w} samples`).toBe(true);
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
  test('with epoch cells, a slice whose epoch the cell has left replies ABORTED and keeps no half-written column', () => {
    const sab = new SharedArrayBuffer(16);
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

describe('surfaceProbe messages and the handler (SP3c spec §6)', () => {
  const probe = (jobId: unknown, epoch: unknown, x: unknown, y: unknown, z: unknown) => ({ type: 'surfaceProbe', jobId, epoch, scope: epoch, x, y, z });
  const result = (path: unknown, state: unknown = 3, jobId: unknown = 4) => ({ type: 'surfaceProbeResult', jobId, epoch: 2, state, path });
  /** A surfaceProbe reply's state and path (throws on any other reply). */
  const probed = (m: FromWorker): { readonly state: number; readonly path: readonly string[] } => {
    if (m.type !== 'surfaceProbeResult') throw new Error(`not a surfaceProbeResult: ${JSON.stringify(m)}`);
    return m;
  };
  /** The slice job's coast line of the slice tests, whose samples the probe must read alike. */
  const COAST = { ax: -2030.5, az: -2007.25, bx: -1950.75, bz: -1990.5 };

  test('parseToWorker: integer jobId and epoch, numeric x, y, z (integers, the window and the y range are the handler\'s BAD_ARGS)', () => {
    for (const m of [probe(1, 0, 5, 70, -9), probe(1, 0, 1.5, 70, 0), probe(1, 0, 524288, 0, 0), probe(1, 0, 0, -65, 0), probe(1, 0, Number.NaN, 0, 0), probe(1, 0, 0, 320.5, Infinity)]) {
      expect(parseToWorker(m)).not.toBeNull();
    }
    for (const m of [probe(1.5, 0, 0, 0, 0), probe(1, null, 0, 0, 0), probe(1, 0, '0', 0, 0), probe(1, 0, 0, undefined, 0), { type: 'surfaceProbe', jobId: 1, epoch: 0, scope: 0, x: 0, y: 0 }]) {
      expect(parseToWorker(m)).toBeNull();
    }
  });

  test('parseFromWorker: surfaceProbeResult carries a state id (a non-negative integer) and a path of rule ids (strings)', () => {
    for (const m of [result([]), result(['root', 'root.rules[2]', 'root.rules[2].then'], 17), result(['root'], 0, 0)]) expect(valid(m)).toBe(true);
    for (const m of [result(null), result('root'), result([1]), result(['root', null]), result([], -1), result([], 1.5), result([], '3'), result([], 3, 1.5), { type: 'surfaceProbeResult', jobId: 4, epoch: 2, state: 3 }, { ...result([]), epoch: null }]) {
      expect(invalid(m)).toBe(true);
    }
  });

  test('a surfaceProbe replies with surfaceProbe on the configured context: the state and the branch path of the voxel (SP3c spec §3.6)', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const sc = createSurfaceContext(ctxFor('42'));
    // A land column of the slice tests' coast line, from above its top to the bedrock.
    const x = -1990;
    const z = -1999;
    let top: number | null = null;
    for (let y = 319; y >= -64; y--) {
      const r = h.handle(probe(10 + y, 3, x, y, z));
      const want = surfaceProbe(sc, x, y, z);
      expect(r.msg, `y ${y}`).toEqual({ type: 'surfaceProbeResult', jobId: 10 + y, epoch: 3, state: want.state, path: [...want.path] });
      expect(r.transfer).toEqual([]);
      if (top === null && want.state !== AIR) top = y;
    }
    expect(top).not.toBeNull();
    const at = (y: number) => probed(h.handle(probe(1, 3, x, y, z)).msg);
    // The top voxel always has a rule of the sky-open branch; air above it and y −64 have none.
    expect(at(top!).path.at(-1)).toMatch(/^root\.rules\[1\]\.then\./);
    expect(at(top! + 1)).toMatchObject({ state: AIR, path: [] });
    expect(at(-64)).toMatchObject({ state: BEDROCK, path: [] });
    expect(at(-30)).toMatchObject({ state: DEEPSLATE, path: ['root', 'root.rules[2]', 'root.rules[2].then'] });
  });

  test('the probe reads the voxel the slice shows: its state is the slice\'s block at (⌊xᵢ⌋, y, ⌊zᵢ⌋) for every y', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const s = h.handle({ type: 'slice', jobId: 1, epoch: 3, scope: 3, ...COAST, from: 0, to: 512 }).msg;
    if (s.type !== 'sliceResult') throw new Error(`no slice: ${s.type}`);
    const blocks = new Uint16Array(s.blocks);
    const states = new Set<number>();
    for (const i of [0, 137, 300, 511]) {
      const [px, pz] = segmentPointAt(COAST, i);
      for (let y = -64; y <= 319; y++) {
        const r = h.handle(probe(2, 3, Math.floor(px), y, Math.floor(pz))).msg;
        if (r.type !== 'surfaceProbeResult') throw new Error(`no probe result: ${JSON.stringify(r)}`);
        expect(r.state, `i ${i}, y ${y}`).toBe(blocks[sliceIndex(i, y)]);
        states.add(r.state);
      }
    }
    expect(states.size).toBeGreaterThan(4);
  });

  test('a position that is not integers in the world window, or a y outside −64 … 319, is BAD_ARGS with the job\'s epoch', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const reply = (m: unknown) => {
      const r = h.handle(m).msg;
      return r.type === 'error' ? [r.code, r.jobId, r.epoch] : [r.type];
    };
    for (const [x, y, z] of [[1.5, 70, 0], [0, 70.25, 0], [0, 70, -0.5], [524288, 70, 0], [0, 70, -524289], [Number.NaN, 70, 0], [0, -65, 0], [0, 320, 0], [0, Infinity, 0]] as const) {
      expect(reply(probe(5, 3, x, y, z)), `${x}, ${y}, ${z}`).toEqual(['BAD_ARGS', 5, 3]);
    }
    for (const [x, y, z] of [[-524288, -64, -524288], [524287, 319, 524287]] as const) expect(reply(probe(5, 3, x, y, z))).toEqual(['surfaceProbeResult']);
  });

  test('before configure NOT_CONFIGURED, at another epoch STALE_EPOCH; with epoch cells it polls before its column build (SP3d spec §5.3)', () => {
    const sab = new SharedArrayBuffer(16);
    const cell = new Int32Array(sab);
    const h = createTaskHandler();
    const reply = (m: unknown) => {
      const r = h.handle(m).msg;
      return r.type === 'error' ? [r.code, r.jobId, r.epoch] : [r.type];
    };
    expect(reply(probe(1, 3, 0, 70, 0))).toEqual(['NOT_CONFIGURED', 1, 3]);
    Atomics.store(cell, 0, 3);
    expect(reply(configure(3, sab))).toEqual(['ready']);
    expect(reply(probe(2, 2, 0, 70, 0))).toEqual(['STALE_EPOCH', 2, 2]);
    Atomics.store(cell, 0, 4);
    expect(reply(probe(3, 3, 0, 70, 0))).toEqual(['ABORTED', 3, 3]);
    Atomics.store(cell, 0, 3);
    expect(reply(probe(4, 3, 0, 70, 0))).toEqual(['surfaceProbeResult']);
  });

  test('a configure with other params answers with their tree: the snowline moves a snowed top to its palette block', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    // The snowy_taiga column of the surface-pass tests: every top is snow_block at the defaults.
    const x = -530 * 16 + 5;
    const z = -1008 * 16 + 9;
    let top = 319;
    while (probed(h.handle(probe(1, 3, x, top, z)).msg).state === AIR) top--;
    const snowed = probed(h.handle(probe(1, 3, x, top, z)).msg);
    expect(snowed.state).toBe(SNOW_BLOCK);
    expect(snowed.path.at(-1)).toBe('root.rules[1].then.rules[2].then.then');
    h.handle(configure(4, null, { ...DEFAULTS, surface: { ...DEFAULTS.surface, snowline: -1, lapse: 0 } }));
    const warm = probed(h.handle(probe(2, 4, x, top, z)).msg);
    expect(warm.state).not.toBe(SNOW_BLOCK);
    expect(warm.path.at(-1)).toMatch(/^root\.rules\[1\]\.then\.rules\[3\]\.then\./);
  });
});

describe('landing messages and the handler (SP4c spec §3.2, D12)', () => {
  const landing = (jobId: unknown, epoch: unknown, x: unknown, z: unknown) => ({ type: 'landing', jobId, epoch, scope: epoch, x, z });
  const result = (surface: unknown, water: unknown, jobId: unknown = 4) => ({ type: 'landingResult', jobId, epoch: 2, surface, water });
  /** A handler's reply: the error's code, jobId and epoch, or the landing's surface and water. */
  const reply = (h: ReturnType<typeof createTaskHandler>, m: unknown) => {
    const r = h.handle(m).msg;
    if (r.type === 'error') return [r.code, r.jobId, r.epoch];
    if (r.type !== 'landingResult') throw new Error(`not a landingResult: ${JSON.stringify(r)}`);
    return [r.type, r.jobId, r.epoch, r.surface, r.water];
  };

  test('the guards accept a landing message and a result with `water` −∞; they refuse a non-integer `x`, a missing `z` and a result without `surface`', () => {
    for (const m of [landing(1, 0, -320, 128), landing(1, 0, 524288, 0), landing(1, 0, -524289, 7)]) expect(parseToWorker(m)).toMatchObject({ type: 'landing' });
    const { z: _, ...noZ } = landing(1, 0, 0, 0);
    for (const m of [landing(1, 0, 0.5, 0), landing(1, 0, 0, -7.25), landing(1, 0, Number.NaN, 0), landing(1, 0, Infinity, 0), landing(1, 0, '3', 0), noZ, landing(1.5, 0, 0, 0)]) {
      expect(parseToWorker(m), JSON.stringify(m)).toBeNull();
    }
    for (const m of [result(169, -Infinity), result(64, 63), result(-64, 62.5), result(319, 63, 0)]) expect(valid(m), JSON.stringify(m)).toBe(true);
    const { surface: _s, ...noSurface } = result(64, 63);
    for (const m of [noSurface, result(64.5, 63), result('64', 63), result(64, Number.NaN), result(64, Infinity), result(64, null), { ...result(64, 63), epoch: null }]) {
      expect(invalid(m), JSON.stringify(m)).toBe(true);
    }
  });

  test('a landing replies with landingSurface and the column\'s surfaceWaterLevel at the job\'s epoch, over land and over the sea', () => {
    const h = createTaskHandler();
    h.handle(configure(3));
    const ctx = ctxFor('42');
    // The first lattice column over water (63 over ocean and river, the lake's level elsewhere).
    let wet: readonly [number, number] | null = null;
    for (let r = 0; r <= 32 && wet === null; r++) {
      for (const [dx, dz] of ringOffsets(r)) if (columnPoint(ctx, dx * 64, dz * 64).surfaceWaterLevel !== -Infinity) { wet = [dx * 64, dz * 64]; break; }
    }
    expect(wet).not.toBeNull();
    for (const [x, z] of [[-320, 128], [0, 0], wet!, [-524288, 524287]] as const) {
      expect(reply(h, landing(5, 3, x, z)), `${x}, ${z}`).toEqual(['landingResult', 5, 3, landingSurface(ctx, x, z), columnPoint(ctx, x, z).surfaceWaterLevel]);
    }
    expect(reply(h, landing(6, 3, wet![0], wet![1]))[4]).toBeGreaterThan(-Infinity);
  });

  test('a position outside the world window is BAD_ARGS with the job\'s epoch; before configure NOT_CONFIGURED, at another epoch STALE_EPOCH', () => {
    const h = createTaskHandler();
    expect(reply(h, landing(1, 3, 0, 0))).toEqual(['NOT_CONFIGURED', 1, 3]);
    h.handle(configure(3));
    for (const [x, z] of [[524288, 0], [0, -524289]] as const) expect(reply(h, landing(5, 3, x, z)), `${x}, ${z}`).toEqual(['BAD_ARGS', 5, 3]);
    expect(reply(h, landing(2, 2, 0, 0))).toEqual(['STALE_EPOCH', 2, 2]);
  });
});

describe('the store spike\'s messages (SP4a spec §1.2 item 6, ruling P18)', () => {
  const handles = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 }).handles();
  test('valid messages to the worker pass', () => {
    expect(parseSpikeStoreToWorker({ type: 'spikeWrite', handles, index: 0, columnsPerWorker: 32 })).not.toBeNull();
    expect(parseSpikeStoreToWorker({ type: 'spikeWrite', handles, index: 5, columnsPerWorker: 1 })).not.toBeNull();
    expect(parseSpikeStoreToWorker({ type: 'spikeCrossRead', cx: 3, columnsPerWorker: 32 })).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['not an object', 7],
    ['a ToWorker message', { type: 'spawn', jobId: 1, epoch: 0, scope: 0 }],
    ['write without handles', { type: 'spikeWrite', index: 0, columnsPerWorker: 32 }],
    ['handles not a store\'s', { type: 'spikeWrite', handles: { shared: true }, index: 0, columnsPerWorker: 32 }],
    ['handles without the reclaim buffer', { type: 'spikeWrite', handles: { ...handles, reclaim: undefined }, index: 0, columnsPerWorker: 32 }],
    ['a negative index', { type: 'spikeWrite', handles, index: -1, columnsPerWorker: 32 }],
    ['a fractional index', { type: 'spikeWrite', handles, index: 0.5, columnsPerWorker: 32 }],
    ['zero columns', { type: 'spikeWrite', handles, index: 0, columnsPerWorker: 0 }],
    ['more columns than the torus', { type: 'spikeWrite', handles, index: 0, columnsPerWorker: 65 }],
    ['a cross read without cx', { type: 'spikeCrossRead', columnsPerWorker: 32 }],
    ['a cross read with a fractional cx', { type: 'spikeCrossRead', cx: 1.5, columnsPerWorker: 32 }],
  ])('a bad message to the worker is null: %s', (_, m) => {
    expect(parseSpikeStoreToWorker(m)).toBeNull();
  });
  test('valid replies pass', () => {
    expect(parseSpikeStoreFromWorker({ type: 'spikeWritten', index: 2, blockMiB: 12, byteMiB: 13, errors: [] })).not.toBeNull();
    expect(parseSpikeStoreFromWorker({ type: 'spikeCrossChecked', ok: 32, total: 32, errors: ['x'] })).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['not an object', null],
    ['unknown type', { type: 'spikeNope' }],
    ['written without errors', { type: 'spikeWritten', index: 2, blockMiB: 12, byteMiB: 13 }],
    ['written with a non-string error', { type: 'spikeWritten', index: 2, blockMiB: 12, byteMiB: 13, errors: [1] }],
    ['written with a NaN size', { type: 'spikeWritten', index: 2, blockMiB: Number.NaN, byteMiB: 13, errors: [] }],
    ['checked with a fractional ok', { type: 'spikeCrossChecked', ok: 1.5, total: 32, errors: [] }],
    ['checked with ok above total', { type: 'spikeCrossChecked', ok: 33, total: 32, errors: [] }],
  ])('a bad reply is null: %s', (_, m) => {
    expect(parseSpikeStoreFromWorker(m)).toBeNull();
  });
});

describe('the decorate message\'s diff (SP5a spec §2.5)', () => {
  const job = (type: string, o: Record<string, unknown> = {}) => ({ type, jobId: 3, epoch: 2, scope: 2, cx: 1, cz: -2, ...o });
  const diff = (o: Record<string, unknown> = {}) => ({
    sy: new Uint8Array([0, 8, 23]), idx: new Uint16Array([0, 4085, 4095]), value: new Uint32Array([1 << 8, (2 << 8) | 16, (REGISTRY.stateCount - 1) << 8]), ...o,
  });

  test('a decorate with a diff, an empty diff or none is accepted', () => {
    const d = diff();
    expect(parseToWorker(job('decorate', { diff: d }))).toEqual(job('decorate', { diff: d }));
    expect(parseToWorker(job('decorate', { diff: diff({ sy: new Uint8Array(0), idx: new Uint16Array(0), value: new Uint32Array(0) }) }))).not.toBeNull();
    expect(parseToWorker(job('decorate'))).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['a diff on light', job('light', { diff: diff() })],
    ['a diff on terrain', job('terrain', { diff: diff() })],
    ['a diff on meshColumn', job('meshColumn', { diff: diff() })],
    ['a diff that is not an object', job('decorate', { diff: 7 })],
    ['a null diff', job('decorate', { diff: null })],
    ['mismatched lengths (idx)', job('decorate', { diff: diff({ idx: new Uint16Array(2) }) })],
    ['mismatched lengths (value)', job('decorate', { diff: diff({ value: new Uint32Array(4) }) })],
    ['sy 24', job('decorate', { diff: diff({ sy: new Uint8Array([0, 8, 24]) }) })],
    ['idx 4096', job('decorate', { diff: diff({ idx: new Uint16Array([0, 4085, 4096]) }) })],
    ['idx not a Uint16Array', job('decorate', { diff: diff({ idx: new Uint32Array([0, 4085, 4095]) }) })],
    ['a state past the registry', job('decorate', { diff: diff({ value: new Uint32Array([1 << 8, 2 << 8, REGISTRY.stateCount << 8]) }) })],
    ['sy not a Uint8Array', job('decorate', { diff: diff({ sy: [0, 8, 23] }) })],
    ['value not a Uint32Array', job('decorate', { diff: diff({ value: new Int32Array(3) }) })],
  ])('refused: %s', (_n, m) => {
    expect(parseToWorker(m)).toBeNull();
  });
});

describe('the sim worker\'s messages (SP5a spec §2.1)', () => {
  const handles = createStore({ shared: true, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 }).handles();
  const edit = (o: Record<string, unknown> = {}) => ({ x: 5, y: 70, z: -3, op: 'set', value: 1 << 8, expect: 0, ...o });
  const edits = (...es: unknown[]) => ({ type: 'edits', id: 4, edits: es });
  const edited = (o: Record<string, unknown> = {}) => ({
    type: 'edited', id: 4, prev: new Uint32Array(2), next: new Uint32Array(2), dirty: new Float64Array([colKey(0, -1)]),
    entryCols: new Float64Array([colKey(0, -1)]), refused: null, relightMs: 0.4, editMs: 1.2, ...o,
  });
  const diff = (o: Record<string, unknown> = {}) => ({
    type: 'diff', id: 5, cx: 0, cz: -1, sy: new Uint8Array([8]), idx: new Uint16Array([4085]), value: new Uint32Array([1 << 8]), ...o,
  });

  test('each message to the sim is accepted', () => {
    expect(parseToSim({ type: 'attach', handles, thread: 15 })).not.toBeNull();
    expect(parseToSim(edits(edit(), edit({ op: 'revert', value: 0, expect: 1 << 8 })))).not.toBeNull();
    expect(parseToSim(edits(edit({ x: -524288, y: -64, z: 524287, value: 0xFFFFFFFF, expect: 0xFFFFFFFF })))).not.toBeNull();
    expect(parseToSim(edits(edit({ y: 319 })))).not.toBeNull();
    expect(parseToSim({ type: 'diff', id: 6, cx: -3, cz: 4 })).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['not an object', 3],
    ['an unknown type', { type: 'nope', id: 1 }],
    ['a task worker\'s job', { type: 'spawn', jobId: 1, epoch: 0, scope: 0 }],
    ['an attach as thread 14', { type: 'attach', handles, thread: 14 }],
    ['an attach as thread 1', { type: 'attach', handles, thread: 1 }],
    ['an attach without handles', { type: 'attach', thread: 15 }],
    ['edits with a non-integer id', { ...edits(edit()), id: 0.5 }],
    ['edits that are not an array', { type: 'edits', id: 4, edits: edit() }],
    ['an edit that is not an object', edits(7)],
    ['a non-integer x', edits(edit({ x: 1.5 }))],
    ['a non-integer y', edits(edit({ y: 70.5 }))],
    ['a non-integer z', edits(edit({ z: Number.NaN }))],
    ['y below −64', edits(edit({ y: -65 }))],
    ['y above 319', edits(edit({ y: 320 }))],
    ['x outside the world window', edits(edit({ x: 524288 }))],
    ['an unknown op', edits(edit({ op: 'fill' }))],
    ['a value above 2³² − 1', edits(edit({ value: 2 ** 32 }))],
    ['a negative value', edits(edit({ value: -1 }))],
    ['a non-integer value', edits(edit({ value: 256.5 }))],
    ['an expect above 2³² − 1', edits(edit({ expect: 2 ** 32 }))],
    ['a diff request with a non-integer cx', { type: 'diff', id: 6, cx: 0.5, cz: 4 }],
    ['a diff request outside the world window', { type: 'diff', id: 6, cx: 32768, cz: 4 }],
    ['a diff request without an id', { type: 'diff', cx: 0, cz: 4 }],
  ])('a message to the sim is refused: %s', (_n, m) => {
    expect(parseToSim(m)).toBeNull();
  });

  test('each reply of the sim is accepted', () => {
    expect(parseFromSim({ type: 'attached' })).not.toBeNull();
    expect(parseFromSim(edited())).not.toBeNull();
    expect(parseFromSim(edited({ refused: 'changed', dirty: new Float64Array(0) }))).not.toBeNull();
    for (const refused of ['unloaded', 'noProto', 'full']) expect(parseFromSim(edited({ refused })), refused).not.toBeNull();
    expect(parseFromSim(diff())).not.toBeNull();
    expect(parseFromSim(diff({ sy: new Uint8Array(0), idx: new Uint16Array(0), value: new Uint32Array(0) }))).not.toBeNull();
    expect(parseFromSim({ type: 'error', jobId: 4, epoch: null, code: 'INTERNAL', message: 'x' })).not.toBeNull();
    expect(parseFromSim({ type: 'error', jobId: null, epoch: null, code: 'BAD_MESSAGE', message: 'x' })).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['not an object', null],
    ['an unknown type', { type: 'nope', id: 4 }],
    ['a task worker\'s reply', { type: 'columnDone', jobId: 1, epoch: 0, job: 'terrain', cx: 0, cz: 0, ms: 1, versions: null }],
    ['edited with a non-integer id', edited({ id: 'a' })],
    ['edited whose prev is not a Uint32Array', edited({ prev: [0, 0] })],
    ['edited whose next is not a Uint32Array', edited({ next: new Int32Array(2) })],
    ['edited whose next is not prev\'s length', edited({ next: new Uint32Array(3) })],
    ['edited whose dirty is not a Float64Array', edited({ dirty: new Uint32Array(1) })],
    ['edited whose entryCols is not a Float64Array', edited({ entryCols: [colKey(0, -1)] })],
    ['edited with an unknown refusal', edited({ refused: 'busy' })],
    ['edited with a NaN relightMs', edited({ relightMs: Number.NaN })],
    ['edited without editMs', edited({ editMs: undefined })],
    ['a diff whose arrays differ in length', diff({ idx: new Uint16Array(2) })],
    ['a diff whose sy is not a Uint8Array', diff({ sy: new Uint16Array([8]) })],
    ['a diff whose value is not a Uint32Array', diff({ value: [256] })],
    ['a diff whose section is past 23', diff({ sy: new Uint8Array([24]) })],
    ['a diff whose voxel is past 4095', diff({ idx: new Uint16Array([4096]) })],
    ['a diff with a non-integer cx', diff({ cx: 0.5 })],
    ['an error with an unknown code', { type: 'error', jobId: 4, epoch: null, code: 'NOPE', message: 'x' }],
    ['an error with a non-integer jobId', { type: 'error', jobId: 0.5, epoch: null, code: 'INTERNAL', message: 'x' }],
  ])('a reply of the sim is refused: %s', (_n, m) => {
    expect(parseFromSim(m)).toBeNull();
  });
});

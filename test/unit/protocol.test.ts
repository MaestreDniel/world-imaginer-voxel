import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn } from '../../src/gen/column/spawn';
import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { paintTile, paintTileAbortable } from '../../src/gen/map/tile';
import { parseFromWorker, parseToWorker, pointInWindow, tileInWindow } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

const tileMsg = { type: 'mapTile', jobId: 1, epoch: 3, layer: 'biome', level: 64, tx: 2, tz: -1 };
const configure = (epoch: number, abort: SharedArrayBuffer | null = null, params: unknown = DEFAULTS, seedText = '42') => ({ type: 'configure', epoch, seedText, params, abort });
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

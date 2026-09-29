import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn } from '../../src/gen/column/spawn';
import { computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { paintTile } from '../../src/gen/map/tile';
import { parseFromWorker, parseToWorker } from '../../src/workers/protocol';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { ctxFor } from '../harness/gen';

const tileMsg = { type: 'mapTile', jobId: 1, epoch: 3, layer: 'biome', level: 64, tx: 2, tz: -1 };

describe('parseToWorker', () => {
  test('valid messages pass', () => {
    expect(parseToWorker({ type: 'configure', epoch: 0, seedText: '42', params: {} })).not.toBeNull();
    expect(parseToWorker(tileMsg)).not.toBeNull();
    expect(parseToWorker({ type: 'point', jobId: 2, epoch: 3, x: 1.5, z: -7 })).not.toBeNull();
    expect(parseToWorker({ type: 'spawn', jobId: 4, epoch: 3 })).not.toBeNull();
    expect(parseToWorker({ type: 'selftest', jobId: 5, key: 'sp1.params' })).not.toBeNull();
  });
  test.each<[string, unknown]>([
    ['not an object', 5],
    ['unknown type', { type: 'nope' }],
    ['empty seed text', { type: 'configure', epoch: 0, seedText: '  ', params: {} }],
    ['bad layer', { ...tileMsg, layer: 'caves' }],
    ['bad level', { ...tileMsg, level: 32 }],
    ['non-integer tile', { ...tileMsg, tx: 0.5 }],
    ['tile outside the window', { ...tileMsg, tx: 40 }],
    ['point outside the window', { type: 'point', jobId: 2, epoch: 3, x: 1e7, z: 0 }],
    ['non-finite point', { type: 'point', jobId: 2, epoch: 3, x: Number.NaN, z: 0 }],
  ])('%s is rejected', (_n, m) => {
    expect(parseToWorker(m)).toBeNull();
  });
});

describe('parseFromWorker', () => {
  test('tile buffers must be 256·256·4 bytes', () => {
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(262144) })).not.toBeNull();
    expect(parseFromWorker({ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(10) })).toBeNull();
    expect(parseFromWorker({ type: 'error', jobId: null, code: 'BAD_MESSAGE', message: 'x' })).not.toBeNull();
  });
});

describe('task handler', () => {
  test('configure → ready with the stage hashes; tiles and points match the direct functions', () => {
    const h = createTaskHandler();
    const ready = h.handle({ type: 'configure', epoch: 3, seedText: '42', params: DEFAULTS }).msg;
    expect(ready.type).toBe('ready');
    if (ready.type !== 'ready') return;
    expect(Object.keys(ready.stageHashes)).toContain('biome2d');
    expect(ready.genKey).toMatch(/^[0-9a-f]{16}$/);
    const tile = h.handle(tileMsg);
    expect(tile.msg.type).toBe('tile');
    if (tile.msg.type !== 'tile') return;
    expect(tile.transfer).toEqual([tile.msg.rgba]);
    expect(new Uint8ClampedArray(tile.msg.rgba)).toEqual(paintTile(ctxFor('42'), 'biome', 64, 2, -1, new Uint8ClampedArray(262144)));
    const pt = h.handle({ type: 'point', jobId: 9, epoch: 3, x: 100.5, z: -20 }).msg;
    expect(pt).toEqual({ type: 'pointResult', jobId: 9, epoch: 3, fields: columnPoint(ctxFor('42'), 100.5, -20) });
    expect(h.handle({ type: 'spawn', jobId: 10, epoch: 3 }).msg).toEqual({ type: 'spawnResult', jobId: 10, epoch: 3, spawn: findSpawn(ctxFor('42')) });
  });
  test.each<[string, unknown[], string]>([
    ['malformed', [{ type: 'mapTile', jobId: 4 }], 'BAD_MESSAGE'],
    ['before configure', [tileMsg], 'NOT_CONFIGURED'],
    ['stale epoch', [{ type: 'configure', epoch: 5, seedText: '1', params: DEFAULTS }, tileMsg], 'STALE_EPOCH'],
    ['invalid params', [{ type: 'configure', epoch: 5, seedText: '1', params: { climate: {} } }], 'BAD_PARAMS'],
  ])('%s → %s', (_n, msgs, code) => {
    const h = createTaskHandler();
    let last = h.handle(msgs[0]).msg;
    for (const m of msgs.slice(1)) last = h.handle(m).msg;
    expect(last.type).toBe('error');
    if (last.type === 'error') expect(last.code).toBe(code);
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

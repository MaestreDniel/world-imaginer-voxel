/**
 * The page's sim client (SP5a spec §2.1, §2.5, D17) over a fake `SimWorkerLike`: it attaches the sim as thread 15,
 * posts `edits` and `diff` requests with ids and matches their replies, keeps the entry set from each reply's
 * `entryAdded`/`entryRemoved` (SP5b D20), and on the sim's failure (an `error` event, an `error` reply of any code, or
 * a reply its guard refuses) sets `failed`, empties the entry set, calls `onFailure` once and synchronously, then
 * rejects every pending `edits` with `SimFailed` and resolves every pending and later `diff` with null.
 */
import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { worldJobsOf, type ReadThrough } from '../../src/engine/coordinator';
import { createSimClient, SimFailed, type SimClient, type SimWorkerLike } from '../../src/engine/simClient';
import type { ColumnDone, WorkerPool } from '../../src/engine/workerPool';
import type { HistoryRecord, StateRecord, WorldRecord } from '../../src/persist/saves';
import type { Edit } from '../../src/workers/protocol';
import type { ColumnDiff } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';

interface FakeSim extends SimWorkerLike {
  readonly posted: Array<Record<string, unknown>>;
  terminated: boolean;
  /** Delivers `data` as the sim's message. */
  reply(data: unknown): void;
}

function fakeSim(): FakeSim {
  const w: FakeSim = {
    posted: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      w.posted.push(m as Record<string, unknown>);
    },
    terminate() {
      w.terminated = true;
    },
    reply(data) {
      w.onmessage!({ data });
    },
  };
  return w;
}

const STONE_AT: Edit = { x: 3, y: 70, z: -20, op: 'set', value: 1 << 8, expect: 0 };
const lastId = (w: FakeSim): number => w.posted.at(-1)!['id'] as number;
const keysOf = (cs: Array<[number, number]>): Float64Array => new Float64Array(cs.map(([cx, cz]) => colKey(cx, cz)));
const editedReply = (id: number, added: Array<[number, number]>, removed: Array<[number, number]> = [], n = 1) => ({
  type: 'edited', id, prev: new Uint32Array(n).fill(0xFFFFFFFF), next: new Uint32Array(n).fill(1 << 8),
  dirty: new Float64Array([colKey(0, -2)]), entryAdded: keysOf(added), entryRemoved: keysOf(removed),
  refused: null, relightMs: 0.5, editMs: 1,
});
const diffReply = (id: number, cx: number, cz: number, n: number) => ({
  type: 'diff', id, cx, cz, sy: new Uint8Array(n).fill(8), idx: new Uint16Array(n).map((_, k) => k), value: new Uint32Array(n).fill(1 << 8),
});
/** Settles every promise callback queued so far. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the sim client (SP5a spec §2.1, §2.5)', () => {
  test('attach posts the store\'s handles as thread 15 and resolves on `attached`', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    const handles = createStore({ shared: true, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 }).handles();
    const attached = sim.attach(handles);
    expect(w.posted).toEqual([{ type: 'attach', handles, thread: 15 }]);
    w.reply({ type: 'attached' });
    await expect(attached).resolves.toBeUndefined();
    expect(sim.failed).toBe(false);
  });

  test('the entry set follows `entryAdded`/`entryRemoved`', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    expect(sim.hasEntries(0, -2)).toBe(false);
    const a = sim.edits([STONE_AT]);
    expect(w.posted.at(-1)).toEqual({ type: 'edits', id: lastId(w), edits: [STONE_AT] });
    w.reply(editedReply(lastId(w), [[0, -2], [5, 7]]));
    const ra = await a;
    expect([ra.type, ra.refused, [...ra.prev], [...ra.next]]).toEqual(['edited', null, [0xFFFFFFFF], [1 << 8]]);
    expect([sim.hasEntries(0, -2), sim.hasEntries(5, 7), sim.hasEntries(1, -2)]).toEqual([true, true, false]);
    // Each reply's changes apply to the set: its added columns join it, its removed ones leave it, the rest stay.
    const b = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [[1, -2]], [[0, -2]]));
    await b;
    expect([sim.hasEntries(0, -2), sim.hasEntries(5, 7), sim.hasEntries(1, -2)]).toEqual([false, true, true]);
    // A refused batch reports no change, and the set stays as it was.
    const c = sim.edits([STONE_AT]);
    w.reply({ ...editedReply(lastId(w), []), refused: 'changed' });
    expect((await c).refused).toBe('changed');
    expect([sim.hasEntries(0, -2), sim.hasEntries(5, 7), sim.hasEntries(1, -2)]).toEqual([false, true, true]);
    const e = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [], [[1, -2]]));
    await e;
    expect([sim.hasEntries(0, -2), sim.hasEntries(5, 7), sim.hasEntries(1, -2)]).toEqual([false, true, false]);
    // A diff request: the column's entries, or null for a zero-length reply (ruling R9).
    const d = sim.diff(5, 7);
    expect(w.posted.at(-1)).toEqual({ type: 'diff', id: lastId(w), cx: 5, cz: 7 });
    w.reply(diffReply(lastId(w), 5, 7, 2));
    const got = await d;
    expect([[...got!.sy], [...got!.idx], [...got!.value]]).toEqual([[8, 8], [0, 1], [1 << 8, 1 << 8]]);
    const none = sim.diff(1, 1);
    w.reply(diffReply(lastId(w), 1, 1, 0));
    expect(await none).toBeNull();
    // Requests are told apart by id: two in flight are answered in order, each to its own.
    const p = sim.diff(5, 7);
    const q = sim.edits([STONE_AT, STONE_AT]);
    const [ip, iq] = w.posted.slice(-2).map((m) => m['id'] as number);
    expect(ip).not.toBe(iq);
    w.reply(diffReply(ip!, 5, 7, 1));
    w.reply(editedReply(iq!, [], [], 2));
    expect((await p)!.sy.length).toBe(1);
    expect((await q).prev.length).toBe(2);
    expect(sim.failed).toBe(false);
  });

  const loadArgs = { db: 'wi10', worldId: 'w1', flushSeq: 2, genKey: '0123456789abcdef', updated: 1_700_000_000_000, stateTable: ['air'], rewrite: null } as const;
  const loadedReply = (id: number, cols: Array<[number, number]>) => ({
    type: 'loaded', id, entryCols: keysOf(cols), entries: 3 * cols.length, unknownStates: 1, skippedColumns: 0, decodeMs: 0.5,
  });

  test('`load` resolves after `hasEntries` holds the loaded set (SP5b spec §3.3, §3.4 step 3)', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    // An edit answered before the load: the loaded set (the DiffStore's columns after the load) replaces the set.
    const first = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [[9, 9]]));
    await first;
    const seen: boolean[][] = [];
    const p = sim.load(loadArgs).then((m) => {
      seen.push([sim.hasEntries(0, -2), sim.hasEntries(5, 7), sim.hasEntries(9, 9)]);
      return m;
    });
    expect(w.posted.at(-1)).toEqual({ type: 'load', id: lastId(w), ...loadArgs });
    expect(sim.hasEntries(0, -2)).toBe(false);
    w.reply(loadedReply(lastId(w), [[0, -2], [5, 7]]));
    const m = await p;
    expect(seen).toEqual([[true, true, false]]);
    expect([m.type, m.entries, m.unknownStates, m.skippedColumns]).toEqual(['loaded', 6, 1, 0]);
    expect(sim.failed).toBe(false);
  });

  test('a pending `load` rejects `SimFailed` when the sim fails, and a `load` on a disposed client rejects at once', async () => {
    const w = fakeSim();
    let failures = 0;
    const sim = createSimClient(() => w, { onFailure: () => { failures++; } });
    const p = sim.load(loadArgs);
    w.reply({ type: 'error', jobId: lastId(w), epoch: null, code: 'INTERNAL', message: 'the KV could not be opened' });
    await expect(p).rejects.toBeInstanceOf(SimFailed);
    expect(failures).toBe(1);
    await expect(sim.load(loadArgs)).rejects.toBeInstanceOf(SimFailed);
    const w2 = fakeSim();
    const disposed = createSimClient(() => w2, { onFailure: () => { failures++; } });
    const pending = disposed.load(loadArgs);
    disposed.dispose();
    await expect(pending).rejects.toBeInstanceOf(SimFailed);
    const posted = w2.posted.length;
    await expect(disposed.load(loadArgs)).rejects.toBeInstanceOf(SimFailed);
    expect(w2.posted.length).toBe(posted);
    expect(failures).toBe(1);
  });

  const state: StateRecord = { worldId: 'w1', flushSeq: 2, updated: 1_700_000_000_000, player: null, time: { t: 0.25, speedIndex: 0 }, hotbar: { v: 1, active: 0, slots: [] }, places: [] };
  const history: HistoryRecord = { worldId: 'w1', done: [], undone: [] };
  const world = { id: 'w1', genKey: 'fedcba9876543210' } as WorldRecord;
  const flushedReply = (id: number, ok: boolean) => (ok
    ? { type: 'flushed', id, ok, flushSeq: 3, columns: 2, bytes: 80, syncMs: 0.2, commitMs: 3 }
    : { type: 'flushed', id, ok, status: 'abort', errorName: 'QuotaExceededError' });

  test('`flush` posts the state and history and resolves with its `flushed`, ok or not; `record` posts and waits for no reply (SP5b spec §3.2, §3.3)', async () => {
    const w = fakeSim();
    let failures = 0;
    const sim = createSimClient(() => w, { onFailure: () => { failures++; } });
    const p = sim.flush(state, history);
    expect(w.posted.at(-1)).toEqual({ type: 'flush', id: lastId(w), state, history });
    w.reply(flushedReply(lastId(w), true));
    expect(await p).toEqual(flushedReply(lastId(w), true));
    const q = sim.flush(state, null);
    expect(w.posted.at(-1)).toEqual({ type: 'flush', id: lastId(w), state, history: null });
    w.reply(flushedReply(lastId(w), false));
    expect(await q).toEqual(flushedReply(lastId(w), false));
    sim.record(world);
    expect(w.posted.at(-1)).toEqual({ type: 'record', world });
    expect([sim.failed, failures]).toEqual([false, 0]);
    // A `flushed` reply to a pending `edits` is the sim's failure, as any reply to no request of its kind.
    const e = sim.edits([STONE_AT]);
    w.reply(flushedReply(lastId(w), true));
    await expect(e).rejects.toBeInstanceOf(SimFailed);
    expect([sim.failed, failures]).toEqual([true, 1]);
  });

  test('a flush\'s history that shares steps with the last one posted posts as its change; a null history keeps that base (D28\'s third lever)', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    const step = (x: number): HistoryRecord['done'][number] => ({ edits: [{ x, y: 70, z: 0, before: 0xFFFFFFFF, after: 1 << 8 }] });
    const [a, b, c, d] = [step(1), step(2), step(3), step(4)];
    const h1: HistoryRecord = { worldId: 'w1', done: [a, b, c], undone: [] };
    void sim.flush(state, h1);
    expect(w.posted.at(-1)).toEqual({ type: 'flush', id: lastId(w), state, history: h1 });
    w.reply(flushedReply(lastId(w), true));
    void sim.flush(state, null);
    expect(w.posted.at(-1)!['history']).toBeNull();
    w.reply(flushedReply(lastId(w), true));
    void sim.flush(state, { worldId: 'w1', done: [b, c, d], undone: [] });
    expect(w.posted.at(-1)!['history']).toEqual({ worldId: 'w1', done: { from: 1, keep: 2, add: [d] }, undone: { from: 0, keep: 0, add: [] } });
    w.reply(flushedReply(lastId(w), false));
    await flush();
    expect(sim.failed).toBe(false);
  });

  test('a pending `flush` rejects `SimFailed` when the sim fails; a `flush` on a disposed client rejects at once', async () => {
    const w = fakeSim();
    let failures = 0;
    const sim = createSimClient(() => w, { onFailure: () => { failures++; } });
    const p = sim.flush(state, history);
    w.reply({ type: 'error', jobId: null, epoch: null, code: 'INTERNAL', message: 'x' });
    await expect(p).rejects.toBeInstanceOf(SimFailed);
    expect(failures).toBe(1);
    const posted = w.posted.length;
    await expect(sim.flush(state, null)).rejects.toBeInstanceOf(SimFailed);
    sim.record(world);
    expect(w.posted.length).toBe(posted);
    const w2 = fakeSim();
    const disposed = createSimClient(() => w2, { onFailure: () => { failures++; } });
    const pending = disposed.flush(state, null);
    disposed.dispose();
    await expect(pending).rejects.toBeInstanceOf(SimFailed);
    const posted2 = w2.posted.length;
    await expect(disposed.flush(state, history)).rejects.toBeInstanceOf(SimFailed);
    disposed.record(world);
    expect(w2.posted.length).toBe(posted2);
    expect(failures).toBe(1);
  });

  const backupArgs = { newWorld: { ...world, id: 'w2', backupOf: 'w1' } as WorldRecord, newId: 'w2', state, history };

  test('`backup` posts the copy request and resolves with its `backedUp`, ok or not (SP5b spec §3.3, §3.6)', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    const p = sim.backup(backupArgs);
    expect(w.posted.at(-1)).toEqual({ type: 'backup', id: lastId(w), ...backupArgs });
    w.reply({ type: 'backedUp', id: lastId(w), ok: true, error: null });
    expect(await p).toEqual({ type: 'backedUp', id: lastId(w), ok: true, error: null });
    const q = sim.backup(backupArgs);
    w.reply({ type: 'backedUp', id: lastId(w), ok: false, error: 'QuotaExceededError' });
    expect(await q).toEqual({ type: 'backedUp', id: lastId(w), ok: false, error: 'QuotaExceededError' });
    expect(sim.failed).toBe(false);
  });

  test('a pending `backup` rejects `SimFailed` when the sim fails', async () => {
    const w = fakeSim();
    let failures = 0;
    const sim = createSimClient(() => w, { onFailure: () => { failures++; } });
    const p = sim.backup(backupArgs);
    w.reply({ type: 'error', jobId: lastId(w), epoch: null, code: 'INTERNAL', message: 'x' });
    await expect(p).rejects.toBeInstanceOf(SimFailed);
    expect(failures).toBe(1);
    const posted = w.posted.length;
    await expect(sim.backup(backupArgs)).rejects.toBeInstanceOf(SimFailed);
    expect(w.posted.length).toBe(posted);
    // A `backedUp` reply to a pending `flush` is the sim's failure, as any reply to no request of its kind.
    const w2 = fakeSim();
    const other = createSimClient(() => w2, { onFailure: () => { failures++; } });
    const f = other.flush(state, null);
    w2.reply({ type: 'backedUp', id: lastId(w2), ok: true, error: null });
    await expect(f).rejects.toBeInstanceOf(SimFailed);
    expect(failures).toBe(2);
  });

  test('`hasAnyEntries()` is false on an empty set, true after a `loaded` or an `entryAdded`, false again after the last `entryRemoved`', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    expect(sim.hasAnyEntries()).toBe(false);
    const l = sim.load(loadArgs);
    w.reply(loadedReply(lastId(w), [[0, -2]]));
    await l;
    expect(sim.hasAnyEntries()).toBe(true);
    const a = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [], [[0, -2]]));
    await a;
    expect(sim.hasAnyEntries()).toBe(false);
    const b = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [[5, 7]]));
    await b;
    expect(sim.hasAnyEntries()).toBe(true);
    const c = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [], [[5, 7]]));
    await c;
    expect(sim.hasAnyEntries()).toBe(false);
  });

  test('a `loaded` reply to a pending `edits` fails the sim, and so does an `edited` reply to a pending `load`', async () => {
    const w = fakeSim();
    let failures = 0;
    const sim = createSimClient(() => w, { onFailure: () => { failures++; } });
    const e = sim.edits([STONE_AT]);
    w.reply(loadedReply(lastId(w), [[0, -2]]));
    await expect(e).rejects.toBeInstanceOf(SimFailed);
    expect([sim.failed, failures, sim.hasEntries(0, -2)]).toEqual([true, 1, false]);
    const w2 = fakeSim();
    const sim2 = createSimClient(() => w2, { onFailure: () => { failures++; } });
    const l = sim2.load(loadArgs);
    w2.reply(editedReply(lastId(w2), [[0, -2]]));
    await expect(l).rejects.toBeInstanceOf(SimFailed);
    expect([sim2.failed, failures]).toEqual([true, 2]);
  });

  const triggers: Array<[string, (w: FakeSim) => void]> = [
    ['an `error` event', (w) => w.onerror!(new Error('the worker threw'))],
    ['an `error` reply', (w) => w.reply({ type: 'error', jobId: null, epoch: null, code: 'STORE_CORRUPT', message: 'pool lock held by failed thread 2' })],
    ['an `error` reply of another code', (w) => w.reply({ type: 'error', jobId: 1, epoch: null, code: 'BAD_MESSAGE', message: 'malformed message' })],
    ['a reply the guard refuses', (w) => w.reply({ type: 'edited', id: 1, prev: [0] })],
    ['a reply to no pending request', (w) => w.reply(editedReply(999, []))],
    ['a reply whose prev is not the batch\'s length', (w) => w.reply(editedReply(lastIdOf(w, 'edits'), [], [], 3))],
    ['a diff reply for another column', (w) => w.reply(diffReply(lastIdOf(w, 'diff'), 9, 9, 1))],
  ];
  const lastIdOf = (w: FakeSim, type: string): number => w.posted.filter((m) => m['type'] === type).at(-1)!['id'] as number;

  test.each(triggers)('after %s: pending `edits` reject `SimFailed`, pending and later `diff` resolve null, `hasEntries` false, `onFailure` called once, before the first rejection runs', async (_n, trigger) => {
    const w = fakeSim();
    const log: string[] = [];
    let sim: SimClient | null = null;
    const failures: Error[] = [];
    sim = createSimClient(() => w, {
      onFailure(e) {
        failures.push(e);
        // Already failed, with the entry set emptied, when the page's handler runs.
        log.push(`onFailure failed=${String(sim!.failed)} entries=${String(sim!.hasEntries(4, 4))}`);
      },
    });
    const first = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [[4, 4]]));
    await first;
    expect(sim.hasEntries(4, 4)).toBe(true);
    const e1 = sim.edits([STONE_AT]).then(() => log.push('e1 resolved'), (e: unknown) => log.push(`e1 ${(e as Error).name}`));
    const d1 = sim.diff(4, 4).then((d) => log.push(`d1 ${String(d)}`));
    const e2 = sim.edits([STONE_AT]).then(() => log.push('e2 resolved'), (e: unknown) => log.push(`e2 ${(e as Error).name}`));
    const posted = w.posted.length;
    trigger(w);
    // Synchronously: failed, no entries, onFailure called once; no rejection has run yet.
    expect(sim.failed).toBe(true);
    expect(sim.hasEntries(4, 4)).toBe(false);
    expect(log).toEqual(['onFailure failed=true entries=false']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SimFailed);
    await Promise.all([e1, d1, e2]);
    expect(log).toEqual(['onFailure failed=true entries=false', 'e1 SimFailed', 'd1 null', 'e2 SimFailed']);
    // Later requests settle at once, with nothing posted; a later event or reply calls nothing again.
    await expect(sim.diff(4, 4)).resolves.toBeNull();
    await expect(sim.edits([STONE_AT])).rejects.toBeInstanceOf(SimFailed);
    expect(w.posted.length).toBe(posted);
    w.onerror?.(new Error('again'));
    w.onmessage?.({ data: { type: 'error', jobId: null, epoch: null, code: 'INTERNAL', message: 'again' } });
    await flush();
    expect(failures).toHaveLength(1);
    expect(sim.failed).toBe(true);
  });

  test.each(triggers)('after %s the worker is terminated, before `onFailure` releases its pins (it writes nothing more)', (_n, trigger) => {
    const w = fakeSim();
    const log: string[] = [];
    const sim = createSimClient(() => w, { onFailure: () => log.push(`onFailure terminated=${String(w.terminated)}`) });
    void sim.edits([STONE_AT]).catch(() => {});
    void sim.diff(4, 4);
    expect(w.terminated).toBe(false);
    trigger(w);
    expect(w.terminated).toBe(true);
    expect(log).toEqual(['onFailure terminated=true']);
  });

  test('a throwing `onFailure` still settles every pending request', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('page bug'); } });
    const e = sim.edits([STONE_AT]);
    const d = sim.diff(0, 0);
    expect(() => w.onerror!(new Error('boom'))).toThrow('page bug');
    await expect(e).rejects.toBeInstanceOf(SimFailed);
    await expect(d).resolves.toBeNull();
  });

  test('dispose terminates the worker and settles its requests without `onFailure`', async () => {
    const w = fakeSim();
    let failures = 0;
    const sim = createSimClient(() => w, { onFailure: () => { failures++; } });
    const e = sim.edits([STONE_AT]);
    const d = sim.diff(0, 0);
    sim.dispose();
    expect(w.terminated).toBe(true);
    await expect(e).rejects.toBeInstanceOf(SimFailed);
    await expect(d).resolves.toBeNull();
    await expect(sim.diff(0, 0)).resolves.toBeNull();
    expect(failures).toBe(0);
  });

  test('the client is D\'s read-through: over a sim that never answers a diff, each D on a column with entries waits; the sim\'s failure resolves every wait null and each D runs with no overlay (SP5a spec §2.1, §2.5)', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => {} });
    const rt: ReadThrough = sim;
    const decorates: Array<readonly [number, number, ColumnDiff | undefined]> = [];
    const done = (cx: number, cz: number): ColumnDone => ({ cx, cz, ms: 1, versions: null, generation: 0 });
    const pool = {
      epoch: 0,
      scopeOf: () => 0,
      decorate: (cx: number, cz: number, diff?: ColumnDiff) => { decorates.push([cx, cz, diff]); return Promise.resolve(done(cx, cz)); },
    } as unknown as WorkerPool;
    const jobs = worldJobsOf(pool, rt);
    const first = sim.edits([STONE_AT]);
    w.reply(editedReply(lastId(w), [[0, -2], [5, 7]]));
    await first;
    const held = [jobs.run('D', 0, -2, false, false), jobs.run('D', 5, 7, false, false)];
    const free = jobs.run('D', 1, 1, false, false);
    await flush();
    // The two columns with entries asked for their diff, which never comes; the other ran at once.
    expect(w.posted.filter((m) => m['type'] === 'diff').map((m) => [m['cx'], m['cz']])).toEqual([[0, -2], [5, 7]]);
    expect(decorates).toEqual([[1, 1, undefined]]);
    await free;
    w.onerror!(new Error('the sim died'));
    for (const d of held) await expect(d).resolves.toEqual({ versions: null, payload: null, generation: 0 });
    expect(decorates).toEqual([[1, 1, undefined], [0, -2, undefined], [5, 7, undefined]]);
    // Later Ds ask nothing: the entry set is empty.
    const posted = w.posted.length;
    await jobs.run('D', 0, -2, false, false);
    expect(w.posted.length).toBe(posted);
    expect(decorates.at(-1)).toEqual([0, -2, undefined]);
  });
});

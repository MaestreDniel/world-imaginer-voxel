/**
 * The page's sim client (SP5a spec §2.1, §2.5, D17) over a fake `SimWorkerLike`: it attaches the sim as thread 15,
 * posts `edits` and `diff` requests with ids and matches their replies, keeps the entry set from each reply's
 * `entryCols`, and on the sim's failure (an `error` event, an `error` reply of any code, or a reply its guard refuses)
 * sets `failed`, empties the entry set, calls `onFailure` once and synchronously, then rejects every pending `edits`
 * with `SimFailed` and resolves every pending and later `diff` with null.
 */
import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { worldJobsOf, type ReadThrough } from '../../src/engine/coordinator';
import { createSimClient, SimFailed, type SimClient, type SimWorkerLike } from '../../src/engine/simClient';
import type { ColumnDone, WorkerPool } from '../../src/engine/workerPool';
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
const editedReply = (id: number, entryCols: Array<[number, number]>, n = 1) => ({
  type: 'edited', id, prev: new Uint32Array(n).fill(0xFFFFFFFF), next: new Uint32Array(n).fill(1 << 8),
  dirty: new Float64Array([colKey(0, -2)]), entryCols: new Float64Array(entryCols.map(([cx, cz]) => colKey(cx, cz))),
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

  test('the entry set follows `entryCols`', async () => {
    const w = fakeSim();
    const sim = createSimClient(() => w, { onFailure: () => { throw new Error('no failure expected'); } });
    expect(sim.hasEntries(0, -2)).toBe(false);
    const a = sim.edits([STONE_AT]);
    expect(w.posted.at(-1)).toEqual({ type: 'edits', id: lastId(w), edits: [STONE_AT] });
    w.reply(editedReply(lastId(w), [[0, -2], [5, 7]]));
    const ra = await a;
    expect([ra.type, ra.refused, [...ra.prev], [...ra.next]]).toEqual(['edited', null, [0xFFFFFFFF], [1 << 8]]);
    expect([sim.hasEntries(0, -2), sim.hasEntries(5, 7), sim.hasEntries(1, -2)]).toEqual([true, true, false]);
    // Each reply's entryCols replaces the set, a refused one's too.
    const b = sim.edits([STONE_AT]);
    w.reply({ ...editedReply(lastId(w), [[5, 7]]), refused: 'changed' });
    expect((await b).refused).toBe('changed');
    expect([sim.hasEntries(0, -2), sim.hasEntries(5, 7)]).toEqual([false, true]);
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
    w.reply(editedReply(iq!, [[5, 7]], 2));
    expect((await p)!.sy.length).toBe(1);
    expect((await q).prev.length).toBe(2);
    expect(sim.failed).toBe(false);
  });

  const triggers: Array<[string, (w: FakeSim) => void]> = [
    ['an `error` event', (w) => w.onerror!(new Error('the worker threw'))],
    ['an `error` reply', (w) => w.reply({ type: 'error', jobId: null, epoch: null, code: 'STORE_CORRUPT', message: 'pool lock held by failed thread 2' })],
    ['an `error` reply of another code', (w) => w.reply({ type: 'error', jobId: 1, epoch: null, code: 'BAD_MESSAGE', message: 'malformed message' })],
    ['a reply the guard refuses', (w) => w.reply({ type: 'edited', id: 1, prev: [0] })],
    ['a reply to no pending request', (w) => w.reply(editedReply(999, []))],
    ['a reply whose prev is not the batch\'s length', (w) => w.reply(editedReply(lastIdOf(w, 'edits'), [], 3))],
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

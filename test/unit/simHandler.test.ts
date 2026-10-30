/**
 * The sim worker's message handler (SP5a spec §2.1): attached to a shared store as thread 15, it runs `applyEdits`
 * for an `edits` message and reads the DiffStore for a `diff` request, in the order the messages come, and answers
 * with transferable arrays. A message the guard refuses is BAD_MESSAGE with nothing written; a throw out of the edit
 * pipeline is an `error` reply carrying the message's id (STORE_CORRUPT for `StoreCorrupt`, else INTERNAL). The store
 * is a seed-42 region generated to 'L' by the region harness on a shared store (5 × 5 columns at the spawn, 1 thread,
 * every proto kept, as `retainAllProtos`); the handler attaches to its handles as the page's sim does.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { colKey } from '../../src/core/coords';
import { hex64, type Hash64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { decodeColumnDiff, encodeColumnDiff } from '../../src/persist/diffCodec';
import type { KV, WriteOp } from '../../src/persist/kv';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import { flushOps, todayStateTable, type HistoryRecord, type StateRecord, type WorldRecord } from '../../src/persist/saves';
import { createDiffStore, NO_ENTRY } from '../../src/sim/diffStore';
import { applyEdits } from '../../src/sim/edits';
import { DIRT, GLASS, STONE } from '../../src/world/blocks/index';
import type { DiffMsg, EditedMsg, ErrorMsg, FlushedMsg, FromSim, LoadedMsg } from '../../src/workers/protocol';
import { createMemorySimHandler, createSimHandler, flushSyncPart, SIM_DRAIN_MS, type SimHandler, type SimReply } from '../../src/workers/simHandler';
import { R_READER, SIM_THREAD } from '../../src/world/store/reclaim';
import type { ColumnDiff } from '../../src/world/store/api';
import type { VoxelStore } from '../../src/world/store/store';
import { genRegion } from '../harness/region';

// The edit pipeline itself, wrapped so one case can inject a bug into it (every other call runs the real one).
vi.mock('../../src/sim/edits', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/sim/edits')>();
  return { ...real, applyEdits: vi.fn(real.applyEdits) };
});

/** A voxel value as the sim holds it: `state << 8 | fluid`. */
const val = (state: number, fluid = 0): number => (state << 8) | fluid;
const valueAt = (s: VoxelStore, x: number, y: number, z: number): number => val(s.blockAt(x, y, z), s.fluidAt(x, y, z));
const sectionOf = (y: number): number => (y + 64) >> 4;
const idxOf = (x: number, y: number, z: number): number => (((y + 64) & 15) << 8) | ((z & 15) << 4) | (x & 15);
const blockVersion = (s: VoxelStore, cx: number, cz: number): number => s.table.blockVersion(s.table.find(cx, cz));
/** Handles `m` and returns its one reply, posted at once (`attach`, `edits` and `diff` with no `load` pending). */
const call = (h: SimHandler, m: unknown): SimReply => {
  const out: SimReply[] = [];
  h.handle(m, (r) => out.push(r));
  expect(out, `one reply posted at once to ${JSON.stringify(m)?.slice(0, 80)}`).toHaveLength(1);
  return out[0]!;
};

// ---------------------------------------------------------------- a saved world in a MemoryKV (SP5b spec §2.1-§2.3)

/** Two header genKeys: the world's (`load`'s) and an older one some columns were written under. */
const GEN: Hash64 = [0x01234567, 0x89abcdef];
const GEN_OLD: Hash64 = [0x0badf00d, 0x00c0ffee];
const UPDATED = 1_700_000_000_000;
/** A column's entries in canonical order (by `sy`, then `idx`). */
const diffOf = (entries: ReadonlyArray<readonly [sy: number, idx: number, value: number]>): ColumnDiff => {
  const e = [...entries].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { sy: Uint8Array.from(e.map((x) => x[0])), idx: Uint16Array.from(e.map((x) => x[1])), value: Uint32Array.from(e.map((x) => x[2])) };
};
const entriesOf = (d: { sy: Uint8Array; idx: Uint16Array; value: Uint32Array }): number[][] => [...d.sy].map((sy, k) => [sy, d.idx[k]!, d.value[k]!]);
const stateOf = (worldId: string): StateRecord => ({
  worldId, flushSeq: 4, updated: UPDATED, player: null, time: { t: 0.25, speedIndex: 0 }, hotbar: { v: 1, active: 0, slots: [] }, places: [],
});
const recordOf = (id: string): WorldRecord => ({
  id, name: 'My world', seedText: '42', seed: [42, 0], profile: 'default', params: {}, schemaVersion: 1, paramsHash: '0'.repeat(16),
  generatorVersion: 5, genKey: hex64(GEN), stateTable: todayStateTable(), created: 1, backupOf: null,
});
const historyOf = (worldId: string): HistoryRecord => ({ worldId, done: [{ edits: [{ x: 1, y: 70, z: 2, before: NO_ENTRY, after: val(STONE) }] }], undone: [] });
/** Writes `cols` (encoded under `genKey`) and the world's state through the sim's own flush batch. */
async function seed(kv: KV, worldId: string, cols: ReadonlyArray<readonly [cx: number, cz: number, d: ColumnDiff]>, genKey: Hash64 = GEN): Promise<void> {
  const w = await kv.write(flushOps(worldId, cols.map(([cx, cz, d]) => ({ key: colKey(cx, cz), bytes: encodeColumnDiff(d, genKey) })), stateOf(worldId), null, null));
  expect(w.status).toBe('complete');
}
/** A column's bytes that `decodeColumnDiff` refuses (version 9). */
async function seedCorrupt(kv: KV, worldId: string, cx: number, cz: number): Promise<void> {
  expect((await kv.write([{ op: 'put', store: 'diffs', key: [worldId, colKey(cx, cz)], value: Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) }])).status).toBe('complete');
}
const loadMsg = (id: number, worldId: string, o: Record<string, unknown> = {}) => ({
  type: 'load', id, db: 'wi10-test', worldId, flushSeq: 4, genKey: hex64(GEN), updated: UPDATED, stateTable: todayStateTable(), rewrite: null, ...o,
});
/** A handler over `kv` and the replies it posts, in order; `until(n)` waits for the n-th. */
function over(kv: KV | (() => Promise<KV>), h?: SimHandler) {
  const handler = h ?? createSimHandler({ openKV: typeof kv === 'function' ? kv : async () => kv });
  const got: SimReply[] = [];
  return {
    handler,
    got,
    send: (m: unknown, onPost?: (r: SimReply) => void): void => handler.handle(m, (r) => { onPost?.(r); got.push(r); }),
    until: (n: number) => vi.waitFor(() => expect(got).toHaveLength(n), { timeout: 2000 }),
  };
}
const loadedOf = (r: SimReply): LoadedMsg => {
  expect(r.msg.type, JSON.stringify(r.msg)).toBe('loaded');
  return r.msg as LoadedMsg;
};
const sortedKeys = (a: Iterable<number>): number[] => [...a].sort((x, y) => x - y);
/** Today's table reversed, plus a key that no longer parses: stored id i is today's N − 1 − i, and N is unknown. */
const permuted = (): string[] => [...todayStateTable()].reverse().concat(['nope[x=1]']);
const storedId = (s: number): number => todayStateTable().length - 1 - s;

describe('the sim handler on a shared seed-42 region (SP5a spec §2.1)', () => {
  let store: VoxelStore;
  /** The centre column of the 5 × 5 (its 3 × 3 is Published). */
  let C: [number, number] = [0, 0];
  const handler = createMemorySimHandler();
  let id = 100;
  const set = (x: number, y: number, z: number, value: number, expectV: number) => ({ x, y, z, op: 'set', value, expect: expectV });
  const revert = (x: number, y: number, z: number, expectV: number) => ({ x, y, z, op: 'revert', value: 0, expect: expectV });
  const post = (edits: unknown[]) => call(handler, { type: 'edits', id: ++id, edits });
  const edited = (r: { msg: FromSim }): EditedMsg => {
    expect(r.msg.type, JSON.stringify(r.msg)).toBe('edited');
    return r.msg as EditedMsg;
  };
  const surface = (x: number, z: number): number => store.heightAt('worldSurface', x, z)!;
  /** Another handler attached to the same store as thread 15 (the page's sim after a reload), for the cases that latch it. */
  const attachedHandler = (h: SimHandler = createMemorySimHandler()) => {
    expect(call(h, { type: 'attach', handles: store.handles(), thread: 15 }).msg).toEqual({ type: 'attached' });
    return h;
  };

  beforeAll(async () => {
    const params = resolveProfile('default');
    const sp = findSpawn(createGenContext(seedFromInput('42'), params));
    C = [sp.x >> 4, sp.z >> 4];
    store = (await genRegion({ seed: '42', params, cx0: C[0] - 2, cz0: C[1] - 2, w: 5, h: 5, upTo: 'L', order: 'spiral', threads: 1, shared: true })).view.store;
    expect(store.shared).toBe(true);
    expect(call(handler, { type: 'attach', handles: store.handles(), thread: 15 }).msg).toEqual({ type: 'attached' });
  }, 120_000);

  test('SIM_DRAIN_MS is 100 (§2.1)', () => {
    expect(SIM_DRAIN_MS).toBe(100);
  });

  test('edits → `edited` with the result of `applyEdits`', () => {
    const x = 16 * C[0] + 6;
    const z = 16 * C[1] + 9;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const bv = blockVersion(store, C[0], C[1]);
    const r = post([set(x, y, z, val(STONE), before)]);
    const m = edited(r);
    expect(m.id).toBe(id);
    expect(m.refused).toBeNull();
    expect([...m.prev]).toEqual([NO_ENTRY]);
    expect([...m.next]).toEqual([val(STONE)]);
    expect([...m.dirty]).toContain(colKey(C[0], C[1]));
    expect([...m.entryAdded]).toEqual([colKey(C[0], C[1])]);
    expect([...m.entryRemoved]).toEqual([]);
    expect(m.relightMs).toBeGreaterThanOrEqual(0);
    expect(m.editMs).toBeGreaterThanOrEqual(m.relightMs);
    // Written through the sim's own attachment: the main thread reads the voxel and the bumped version.
    expect(valueAt(store, x, y, z)).toBe(val(STONE));
    expect(blockVersion(store, C[0], C[1])).toBe(bv + 1);
    // Every array of the result is transferred whole.
    expect(r.transfer).toEqual([m.prev.buffer, m.next.buffer, m.dirty.buffer, m.entryAdded.buffer, m.entryRemoved.buffer]);
    for (const a of [m.prev, m.next, m.dirty, m.entryAdded, m.entryRemoved]) expect(a.byteLength).toBe(a.buffer.byteLength);
    // A refusal comes back as a result too: the same voxel, expected at its old value, is `changed`.
    const refused = edited(post([set(x, y, z, val(DIRT), before)]));
    expect(refused.refused).toBe('changed');
    expect([...refused.prev]).toEqual([val(STONE)]);
    expect([refused.entryAdded.length, refused.entryRemoved.length]).toEqual([0, 0]);
    expect(valueAt(store, x, y, z)).toBe(val(STONE));
    // Undo it, so the later cases start from the generated terrain: the column's last entry goes.
    const undone = edited(post([revert(x, y, z, val(STONE))]));
    expect(undone.refused).toBeNull();
    expect([[...undone.entryAdded], [...undone.entryRemoved]]).toEqual([[], [colKey(C[0], C[1])]]);
    expect(valueAt(store, x, y, z)).toBe(before);
  });

  test('`diff` after two edits of a column → its canonical entries, transferred', () => {
    const x0 = 16 * C[0] + 11;
    const z0 = 16 * C[1] + 2;
    const y0 = surface(x0, z0);
    const x1 = 16 * C[0] + 3;
    const z1 = 16 * C[1] + 14;
    const y1 = surface(x1, z1) + 1;
    // The higher voxel first, so the canonical order (by section, then voxel) is not the order of the edits.
    const [hi, lo] = y1 > y0 ? [[x1, y1, z1], [x0, y0, z0]] : [[x0, y0, z0], [x1, y1, z1]];
    const vHi = valueAt(store, hi[0]!, hi[1]!, hi[2]!);
    const vLo = valueAt(store, lo[0]!, lo[1]!, lo[2]!);
    expect(edited(post([set(hi[0]!, hi[1]!, hi[2]!, val(GLASS), vHi)])).refused).toBeNull();
    expect(edited(post([set(lo[0]!, lo[1]!, lo[2]!, val(STONE), vLo)])).refused).toBeNull();
    const r = call(handler, { type: 'diff', id: 7, cx: C[0], cz: C[1] });
    expect(r.msg.type).toBe('diff');
    const d = r.msg as DiffMsg;
    expect([d.id, d.cx, d.cz]).toEqual([7, C[0], C[1]]);
    const want = [
      [sectionOf(hi[1]!), idxOf(hi[0]!, hi[1]!, hi[2]!), val(GLASS)],
      [sectionOf(lo[1]!), idxOf(lo[0]!, lo[1]!, lo[2]!), val(STONE)],
    ].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    expect([...d.sy]).toEqual(want.map((e) => e[0]));
    expect([...d.idx]).toEqual(want.map((e) => e[1]));
    expect([...d.value]).toEqual(want.map((e) => e[2]));
    expect(d.sy).toBeInstanceOf(Uint8Array);
    expect(d.idx).toBeInstanceOf(Uint16Array);
    expect(d.value).toBeInstanceOf(Uint32Array);
    expect(r.transfer).toEqual([d.sy.buffer, d.idx.buffer, d.value.buffer]);
    for (const a of [d.sy, d.idx, d.value]) expect(a.byteLength).toBe(a.buffer.byteLength);
    // A column with no entries answers zero-length arrays (ruling R9).
    const none = call(handler, { type: 'diff', id: 8, cx: C[0] + 1, cz: C[1] }).msg as DiffMsg;
    expect([none.type, none.id, none.sy.length, none.idx.length, none.value.length]).toEqual(['diff', 8, 0, 0, 0]);
    expect(edited(post([revert(hi[0]!, hi[1]!, hi[2]!, val(GLASS)), revert(lo[0]!, lo[1]!, lo[2]!, val(STONE))])).refused).toBeNull();
    expect((call(handler, { type: 'diff', id: 9, cx: C[0], cz: C[1] }).msg as DiffMsg).sy.length).toBe(0);
  });

  test('messages are handled in order: an `edits` then a `diff` of the same column returns the new entry', () => {
    const [cx, cz] = [C[0] + 1, C[1] - 1];
    const x = 16 * cx + 7;
    const z = 16 * cz + 8;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const replies = [
      call(handler, { type: 'edits', id: 20, edits: [set(x, y, z, val(GLASS), before)] }),
      call(handler, { type: 'diff', id: 21, cx, cz }),
      call(handler, { type: 'edits', id: 22, edits: [set(x, y, z, val(DIRT), val(GLASS))] }),
      call(handler, { type: 'diff', id: 23, cx, cz }),
    ].map((r) => r.msg);
    expect(replies.map((m) => [m.type, (m as { id: number }).id])).toEqual([['edited', 20], ['diff', 21], ['edited', 22], ['diff', 23]]);
    expect([...(replies[1] as DiffMsg).value]).toEqual([val(GLASS)]);
    expect([...(replies[3] as DiffMsg).value]).toEqual([val(DIRT)]);
    expect(edited(post([revert(x, y, z, val(DIRT))])).refused).toBeNull();
  });

  test('an `edits` posted during the load runs after it, in order (SP5b D18)', async () => {
    const [cx, cz] = [C[0] - 1, C[1] + 1];
    const x = 16 * cx + 4;
    const z = 16 * cz + 13;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    // The saved world holds an entry at the voxel (not the store's value: nothing loaded reaches the store) and one more.
    const kv = createMemoryKV({ readDelayMs: 50 });
    await seed(kv, 'w-edit', [[cx, cz, diffOf([[sectionOf(y), idxOf(x, y, z), val(DIRT)], [0, 0, val(STONE)]])]]);
    const o = over(kv, attachedHandler(createSimHandler({ openKV: async () => kv })));
    o.send(loadMsg(60, 'w-edit'));
    o.send({ type: 'edits', id: 61, edits: [set(x, y, z, val(GLASS), before)] });
    o.send({ type: 'diff', id: 62, cx, cz });
    expect(o.got).toEqual([]);
    await o.until(3);
    expect(o.got.map((r) => [r.msg.type, (r.msg as { id: number }).id])).toEqual([['loaded', 60], ['edited', 61], ['diff', 62]]);
    // The edit saw the loaded entry, and its column already held entries.
    const e = edited(o.got[1]!);
    expect([e.refused, [...e.prev], [...e.next], [...e.entryAdded]]).toEqual([null, [val(DIRT)], [val(GLASS)], []]);
    expect(entriesOf(o.got[2]!.msg as DiffMsg)).toEqual([[0, 0, val(STONE)], [sectionOf(y), idxOf(x, y, z), val(GLASS)]]);
    // Undone, so the later cases start from the generated terrain.
    expect(edited(call(o.handler, { type: 'edits', id: 63, edits: [revert(x, y, z, val(GLASS))] })).refused).toBeNull();
    expect(valueAt(store, x, y, z)).toBe(before);
  });

  test('a malformed message → `BAD_MESSAGE` and nothing written', () => {
    const x = 16 * C[0] + 5;
    const z = 16 * C[1] + 5;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const versions = [blockVersion(store, C[0], C[1]), store.table.lightVersion(store.table.find(C[0], C[1]))];
    // A handler of its own: an error reply latches it (SIM-1).
    const h = attachedHandler();
    const bad = (m: unknown): ErrorMsg => {
      const r = call(h, m);
      expect(r.msg.type).toBe('error');
      expect(r.transfer).toEqual([]);
      return r.msg as ErrorMsg;
    };
    // The batch's first edit is fine, its second not: the guard refuses the whole message, with its id.
    const m = bad({ type: 'edits', id: 30, edits: [set(x, y, z, val(STONE), before), set(x, y + 1.5, z, val(STONE), 0)] });
    expect([m.code, m.jobId, m.epoch]).toEqual(['BAD_MESSAGE', 30, null]);
    expect([bad({ type: 'edits', id: 31, edits: [set(x, y, z, 2 ** 32, before)] }).code, bad({ type: 'diff', id: 32, cx: 0.5, cz: 0 }).code]).toEqual(['BAD_MESSAGE', 'BAD_MESSAGE']);
    // An id the guard cannot read answers jobId null.
    expect([bad(5).jobId, bad({ type: 'edits', id: 'x', edits: [] }).jobId]).toEqual([null, null]);
    // A second attach to another thread is refused too.
    expect(bad({ type: 'attach', handles: store.handles(), thread: 14 }).code).toBe('BAD_MESSAGE');
    expect(valueAt(store, x, y, z)).toBe(before);
    expect([blockVersion(store, C[0], C[1]), store.table.lightVersion(store.table.find(C[0], C[1]))]).toEqual(versions);
    expect((call(h, { type: 'diff', id: 33, cx: C[0], cz: C[1] }).msg as DiffMsg).sy.length).toBe(0);
  });

  test('a repeated attach to the same store as 15 is answered `attached` again', () => {
    expect(call(handler, { type: 'attach', handles: store.handles(), thread: 15 }).msg).toEqual({ type: 'attached' });
  });

  test('after an error reply (an INTERNAL, a BAD_MESSAGE) a later `edits` batch writes nothing: an INTERNAL `error` with its id, `applyEdits` not called; a `diff` still answers (SIM-1)', () => {
    const x = 16 * C[0] + 12;
    const z = 16 * C[1] + 7;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const versions = [blockVersion(store, C[0], C[1]), store.table.lightVersion(store.table.find(C[0], C[1]))];
    const internal = attachedHandler();
    vi.mocked(applyEdits).mockImplementationOnce(() => {
      throw new TypeError('injected bug');
    });
    expect((call(internal, { type: 'edits', id: 50, edits: [set(x, y, z, val(STONE), before)] }).msg as ErrorMsg).code).toBe('INTERNAL');
    const malformed = attachedHandler();
    expect((call(malformed, { type: 'edits', id: 51, edits: [set(x, y + 0.5, z, val(STONE), before)] }).msg as ErrorMsg).code).toBe('BAD_MESSAGE');
    const calls = vi.mocked(applyEdits).mock.calls.length;
    for (const [h, id] of [[internal, 52], [malformed, 53]] as const) {
      const r = call(h, { type: 'edits', id, edits: [set(x, y, z, val(STONE), before)] });
      const m = r.msg as ErrorMsg;
      expect([m.type, m.jobId, m.epoch, m.code]).toEqual(['error', id, null, 'INTERNAL']);
      expect(m.message).toContain('nothing written');
      expect(r.transfer).toEqual([]);
      expect((call(h, { type: 'diff', id: id + 10, cx: C[0], cz: C[1] }).msg as DiffMsg).type).toBe('diff');
    }
    expect(vi.mocked(applyEdits).mock.calls.length).toBe(calls);
    expect(valueAt(store, x, y, z)).toBe(before);
    expect([blockVersion(store, C[0], C[1]), store.table.lightVersion(store.table.find(C[0], C[1]))]).toEqual(versions);
  });

  describe('`flush` and `record` (SP5b spec §3.2, §3.3, D18, D21)', () => {
    let fid = 200;
    /** A saved world loaded into a handler of its own, attached to the region's store, over `kv`. */
    const opened = async (kv: MemoryKV, worldId: string, o: Record<string, unknown> = {}) => {
      const s = over(kv, attachedHandler(createSimHandler({ openKV: async () => kv })));
      s.send(loadMsg(1, worldId, o));
      await s.until(1);
      loadedOf(s.got[0]!);
      return s;
    };
    /** A `flush` of `worldId`'s state (its `flushSeq` the sim's to set), `st` over it. */
    const flushOf = (id: number, worldId: string, history: HistoryRecord | null = null, st: Partial<StateRecord> = {}) =>
      ({ type: 'flush', id, state: { ...stateOf(worldId), flushSeq: 0, ...st }, history });
    const okOf = (r: SimReply): Extract<FlushedMsg, { ok: true }> => {
      expect(r.msg, JSON.stringify(r.msg)).toMatchObject({ type: 'flushed', ok: true });
      return r.msg as Extract<FlushedMsg, { ok: true }>;
    };
    /** A voxel above the surface of column (C + dx, C + dz), at (lx, lz) in it; `before` its value now. */
    const spot = (dx: number, dz: number, lx: number, lz: number) => {
      const [cx, cz] = [C[0] + dx, C[1] + dz];
      const x = 16 * cx + lx;
      const z = 16 * cz + lz;
      const y = surface(x, z) + 1;
      return { x, y, z, cx, cz, key: colKey(cx, cz), before: valueAt(store, x, y, z) };
    };
    type Spot = ReturnType<typeof spot>;
    const place = (h: SimHandler, s: Spot): void => {
      expect(s.before).not.toBe(val(GLASS));
      expect(edited(call(h, { type: 'edits', id: ++fid, edits: [set(s.x, s.y, s.z, val(GLASS), s.before)] })).refused).toBeNull();
    };
    /** Reverts `s`, so the later cases start from the generated terrain. */
    const undo = (h: SimHandler, s: Spot): void => {
      expect(edited(call(h, { type: 'edits', id: ++fid, edits: [revert(s.x, s.y, s.z, val(GLASS))] })).refused).toBeNull();
      expect(valueAt(store, s.x, s.y, s.z)).toBe(s.before);
    };
    /** The world's stored columns, decoded, by colKey. */
    const diffsOf = (kv: MemoryKV, worldId: string) => new Map((kv.dump('diffs') as Array<[readonly [string, number], Uint8Array]>)
      .filter(([k]) => k[0] === worldId).map(([k, b]) => [k[1], decodeColumnDiff(b, todayStateTable().length)]));
    const stateIn = async (kv: KV, worldId: string): Promise<StateRecord> => (await kv.read([{ op: 'get', store: 'state', key: worldId }]))[0] as StateRecord;
    const diffAt = (h: SimHandler, s: Spot): number[][] => entriesOf(call(h, { type: 'diff', id: ++fid, cx: s.cx, cz: s.cz }).msg as DiffMsg);
    const opsOf = (ops: readonly WriteOp[]) => ops.map((op) => [op.op, op.store, op.op === 'deleteRange' ? null : op.key]);

    test('a flush writes the dirty columns, the state with `flushSeq` 1 and the history in one write; a second with nothing dirty writes the state only with `flushSeq` 2', async () => {
      const kv = createMemoryKV();
      const s = await opened(kv, 'wf1', { flushSeq: 0 });
      const a = spot(0, 0, 1, 1);
      const b = spot(1, 0, 2, 13);
      place(s.handler, a);
      place(s.handler, b);
      const write = vi.spyOn(kv, 'write');
      const H = historyOf('wf1');
      s.send(flushOf(10, 'wf1', H));
      await s.until(2);
      expect(write).toHaveBeenCalledTimes(1);
      const ops = write.mock.calls[0]![0];
      expect(opsOf(ops)).toEqual([['put', 'diffs', ['wf1', a.key]], ['put', 'diffs', ['wf1', b.key]], ['put', 'state', 'wf1'], ['put', 'history', 'wf1']]);
      const bytes = ops.slice(0, 2).reduce((n, op) => n + ((op as { value: Uint8Array }).value.byteLength), 0);
      const f = okOf(s.got[1]!);
      expect([f.id, f.flushSeq, f.columns, f.bytes]).toEqual([10, 1, 2, bytes]);
      // Committed: each column decodes to the DiffStore's entries, the state carries `flushSeq` 1, the history is as posted.
      const d = diffsOf(kv, 'wf1');
      expect(sortedKeys(d.keys())).toEqual(sortedKeys([a.key, b.key]));
      for (const p of [a, b]) expect(entriesOf(d.get(p.key)!.diff)).toEqual(diffAt(s.handler, p));
      expect(await stateIn(kv, 'wf1')).toEqual({ ...stateOf('wf1'), flushSeq: 1 });
      expect(kv.dump('history')).toEqual([['wf1', H]]);
      // Nothing dirty: the state only.
      s.send(flushOf(11, 'wf1'));
      await s.until(3);
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1]![0]).toEqual([{ op: 'put', store: 'state', key: 'wf1', value: { ...stateOf('wf1'), flushSeq: 2 } }]);
      const f2 = okOf(s.got[2]!);
      expect([f2.id, f2.flushSeq, f2.columns, f2.bytes]).toEqual([11, 2, 0, 0]);
      undo(s.handler, b);
      undo(s.handler, a);
    });

    test('a column reverted to its generated value deletes its key', async () => {
      const kv = createMemoryKV();
      const s = await opened(kv, 'wf2', { flushSeq: 0 });
      const a = spot(-1, 0, 14, 3);
      place(s.handler, a);
      s.send(flushOf(10, 'wf2'));
      await s.until(2);
      okOf(s.got[1]!);
      expect([...diffsOf(kv, 'wf2').keys()]).toEqual([a.key]);
      undo(s.handler, a);
      const write = vi.spyOn(kv, 'write');
      s.send(flushOf(11, 'wf2'));
      await s.until(3);
      expect(okOf(s.got[2]!).columns).toBe(1);
      expect(opsOf(write.mock.calls[0]![0])).toEqual([['delete', 'diffs', ['wf2', a.key]], ['put', 'state', 'wf2']]);
      expect(diffsOf(kv, 'wf2').size).toBe(0);
    });

    test('an abort (`failAt(3)`) merges the columns back: the next flush commits the union with `flushSeq` + 1, and a history and a `record` of the aborted batch are in it', async () => {
      const kv = createMemoryKV();
      await seed(kv, 'wf3', []);
      const s = await opened(kv, 'wf3');
      const a = spot(0, 1, 8, 8);
      const b = spot(1, 1, 13, 12);
      const c = spot(0, -1, 3, 6);
      place(s.handler, a);
      place(s.handler, b);
      const R: WorldRecord = { ...recordOf('wf3'), name: 'Renamed' };
      s.send({ type: 'record', world: R });
      // A `record` has no reply.
      expect(s.got).toHaveLength(1);
      const H1 = historyOf('wf3');
      const dumps = () => (['worlds', 'state', 'history', 'diffs'] as const).map((st) => kv.dump(st));
      const before = dumps();
      // The batch: a, b, the state, the history (op 3), the record.
      kv.failAt(3);
      s.send(flushOf(10, 'wf3', H1));
      await s.until(2);
      expect(s.got[1]!.msg).toEqual({ type: 'flushed', id: 10, ok: false, status: 'abort', errorName: 'AbortError' });
      expect(dumps()).toEqual(before);
      place(s.handler, c);
      const write = vi.spyOn(kv, 'write');
      s.send(flushOf(11, 'wf3'));
      await s.until(3);
      const f = okOf(s.got[2]!);
      expect([f.flushSeq, f.columns]).toEqual([5, 3]);
      expect(opsOf(write.mock.calls[0]![0])).toEqual([
        ['put', 'diffs', ['wf3', a.key]], ['put', 'diffs', ['wf3', b.key]], ['put', 'diffs', ['wf3', c.key]],
        ['put', 'state', 'wf3'], ['put', 'history', 'wf3'], ['put', 'worlds', 'wf3'],
      ]);
      expect(sortedKeys(diffsOf(kv, 'wf3').keys())).toEqual(sortedKeys([a.key, b.key, c.key]));
      expect((await stateIn(kv, 'wf3')).flushSeq).toBe(5);
      expect(kv.dump('history')).toEqual([['wf3', H1]]);
      expect(kv.dump('worlds')).toEqual([['wf3', R]]);
      for (const p of [c, b, a]) undo(s.handler, p);
    });

    test('two flushes posted while one is in flight: the first queued is replaced by the second, the queued history kept when the second has none; both queued ids get the merged write\'s outcome (ruling P4)', async () => {
      const kv = createMemoryKV({ writeDelayMs: 30 });
      const s = await opened(kv, 'wf4', { flushSeq: 0 });
      const a = spot(-1, -1, 2, 2);
      const b = spot(1, -1, 10, 5);
      place(s.handler, a);
      const write = vi.spyOn(kv, 'write');
      const H1 = historyOf('wf4');
      const H2: HistoryRecord = { ...historyOf('wf4'), undone: [{ edits: [] }] };
      s.send(flushOf(10, 'wf4', H1));
      place(s.handler, b);
      s.send(flushOf(11, 'wf4', H2, { time: { t: 0.5, speedIndex: 1 } }));
      s.send(flushOf(12, 'wf4', null, { time: { t: 0.75, speedIndex: 2 } }));
      // One flush in flight: the queued one runs only when it settles.
      expect(write).toHaveBeenCalledTimes(1);
      await s.until(4);
      expect(write).toHaveBeenCalledTimes(2);
      expect(opsOf(write.mock.calls[0]![0])).toEqual([['put', 'diffs', ['wf4', a.key]], ['put', 'state', 'wf4'], ['put', 'history', 'wf4']]);
      const second = write.mock.calls[1]![0];
      expect(opsOf(second)).toEqual([['put', 'diffs', ['wf4', b.key]], ['put', 'state', 'wf4'], ['put', 'history', 'wf4']]);
      // The newest state, and the replaced flush's history.
      expect(second[1]).toEqual({ op: 'put', store: 'state', key: 'wf4', value: { ...stateOf('wf4'), flushSeq: 2, time: { t: 0.75, speedIndex: 2 } } });
      expect(second[2]).toEqual({ op: 'put', store: 'history', key: 'wf4', value: H2 });
      const [f1, f2, f3] = s.got.slice(1).map(okOf);
      expect([f1!.id, f1!.flushSeq, f1!.columns]).toEqual([10, 1, 1]);
      expect([f2!.id, f2!.flushSeq, f2!.columns]).toEqual([11, 2, 1]);
      expect({ ...f3!, id: 11 }).toEqual(f2);
      expect(f3!.id).toBe(12);
      undo(s.handler, b);
      undo(s.handler, a);
    });

    test('Review Focus 1: edits A posted, `flush` posted, edits B posted before A\'s reply; the flush\'s write `crashNext()`ed: a fresh handler\'s `load` on the same KV gives exactly the previous committed flush\'s columns, and `kv.read([{ op: \'get\', store: \'state\', key: worldId }])` gives its `flushSeq`; with the write completing instead, A\'s column is in it and B\'s column is dirty again and in the next flush with `flushSeq` + 1', async () => {
      const kv = createMemoryKV();
      const s = await opened(kv, 'wr1', { flushSeq: 0 });
      const p = spot(-1, 1, 5, 9);
      // B in A's column, at another voxel: the column is taken by the flush, then marked again.
      const a = spot(0, 0, 13, 2);
      const b = spot(0, 0, 2, 7);
      // The previous committed flush: column P.
      place(s.handler, p);
      s.send(flushOf(10, 'wr1'));
      await s.until(2);
      expect(okOf(s.got[1]!).flushSeq).toBe(1);
      const committed = kv.dump('diffs');
      // A, the flush whose write never settles (the tab died before `oncomplete`), B.
      place(s.handler, a);
      kv.crashNext();
      s.send(flushOf(11, 'wr1', historyOf('wr1')));
      place(s.handler, b);
      // The reopen: a fresh handler's `load` on the same KV.
      const [st] = await kv.read([{ op: 'get', store: 'state', key: 'wr1' }]);
      expect((st as StateRecord).flushSeq).toBe(1);
      const fresh = over(kv);
      fresh.send(loadMsg(1, 'wr1', { flushSeq: (st as StateRecord).flushSeq }));
      await fresh.until(1);
      expect(sortedKeys(loadedOf(fresh.got[0]!).entryCols)).toEqual([p.key]);
      expect(diffAt(fresh.handler, p)).toEqual(diffAt(s.handler, p));
      expect(diffAt(fresh.handler, a)).toEqual([]);
      expect(kv.dump('diffs')).toEqual(committed);
      expect(kv.dump('history')).toEqual([]);
      // The crashed flush is never answered.
      expect(s.got).toHaveLength(2);
      for (const q of [b, a, p]) undo(s.handler, q);

      // The write completing instead.
      const kv2 = createMemoryKV({ writeDelayMs: 20 });
      const s2 = await opened(kv2, 'wr2', { flushSeq: 0 });
      place(s2.handler, a);
      s2.send(flushOf(20, 'wr2'));
      // Between the flush's encode and its settle.
      place(s2.handler, b);
      await s2.until(2);
      expect([okOf(s2.got[1]!).flushSeq, okOf(s2.got[1]!).columns]).toEqual([1, 1]);
      // A's column holds A's entry only: B came after the encode.
      expect(entriesOf(diffsOf(kv2, 'wr2').get(a.key)!.diff)).toEqual([[sectionOf(a.y), idxOf(a.x, a.y, a.z), val(GLASS)]]);
      const write = vi.spyOn(kv2, 'write');
      s2.send(flushOf(21, 'wr2'));
      await s2.until(3);
      expect([okOf(s2.got[2]!).flushSeq, okOf(s2.got[2]!).columns]).toEqual([2, 1]);
      expect(opsOf(write.mock.calls[0]![0])).toEqual([['put', 'diffs', ['wr2', a.key]], ['put', 'state', 'wr2']]);
      const both = diffAt(s2.handler, a);
      expect(both).toHaveLength(2);
      expect(entriesOf(diffsOf(kv2, 'wr2').get(a.key)!.diff)).toEqual(both);
      undo(s2.handler, b);
      undo(s2.handler, a);
    });

    test('a column flushed before any `record` carries `load`\'s genKey in its header; after a `record` with another genKey, the next flushed column carries that one', async () => {
      const kv = createMemoryKV();
      const s = await opened(kv, 'wg', { flushSeq: 0 });
      const a = spot(1, 0, 6, 6);
      const a2 = spot(1, 0, 9, 11);
      place(s.handler, a);
      s.send(flushOf(10, 'wg'));
      await s.until(2);
      okOf(s.got[1]!);
      expect(diffsOf(kv, 'wg').get(a.key)!.genKey).toEqual(GEN);
      const R: WorldRecord = { ...recordOf('wg'), genKey: hex64(GEN_OLD) };
      s.send({ type: 'record', world: R });
      place(s.handler, a2);
      s.send(flushOf(11, 'wg'));
      await s.until(3);
      okOf(s.got[2]!);
      expect(diffsOf(kv, 'wg').get(a.key)!.genKey).toEqual(GEN_OLD);
      expect(kv.dump('worlds')).toEqual([['wg', R]]);
      undo(s.handler, a2);
      undo(s.handler, a);
    });

    test('after an `error` reply nothing is flushed', async () => {
      const kv = createMemoryKV();
      const s = await opened(kv, 'we', { flushSeq: 0 });
      // A malformed batch latches the handler.
      expect((call(s.handler, { type: 'edits', id: 30, edits: [set(0, 70.5, 0, val(STONE), 0)] }).msg as ErrorMsg).code).toBe('BAD_MESSAGE');
      const write = vi.spyOn(kv, 'write');
      const e = call(s.handler, flushOf(31, 'we')).msg as ErrorMsg;
      expect([e.type, e.jobId, e.code]).toEqual(['error', 31, 'INTERNAL']);
      expect(e.message).toContain('nothing written');
      const posted: SimReply[] = [];
      s.handler.handle({ type: 'record', world: recordOf('we') }, (r) => posted.push(r));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(posted).toEqual([]);
      expect(write).not.toHaveBeenCalled();
      expect(kv.dump('state')).toEqual([]);
      // A handler with no world loaded refuses a flush, with its id.
      const none = call(createMemorySimHandler(), flushOf(32, 'we')).msg as ErrorMsg;
      expect([none.type, none.jobId, none.code]).toEqual(['error', 32, 'BAD_MESSAGE']);
    });

    test('`syncMs` and `commitMs` are finite and ≥ 0', async () => {
      const kv = createMemoryKV({ writeDelayMs: 15 });
      const s = await opened(kv, 'wt', { flushSeq: 0 });
      const a = spot(0, 1, 11, 14);
      place(s.handler, a);
      s.send(flushOf(10, 'wt'));
      await s.until(2);
      const f = okOf(s.got[1]!);
      for (const ms of [f.syncMs, f.commitMs]) expect(Number.isFinite(ms) && ms >= 0, `${ms}`).toBe(true);
      undo(s.handler, a);
    });
  });

  test('a throw inside `applyEdits` other than `StoreFull` (an injected bug, a `StoreCorrupt`) → an `error` reply with that `jobId` and `INTERNAL`/`STORE_CORRUPT`', () => {
    const x = 16 * C[0] + 9;
    const z = 16 * C[1] + 4;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    // An injected bug: any other throw is INTERNAL.
    vi.mocked(applyEdits).mockImplementationOnce(() => {
      throw new TypeError('injected bug');
    });
    const internal = call(handler, { type: 'edits', id: 40, edits: [set(x, y, z, val(STONE), before)] }).msg as ErrorMsg;
    expect([internal.type, internal.jobId, internal.epoch, internal.code, internal.message]).toEqual(['error', 40, null, 'INTERNAL', 'injected bug']);
    // A real StoreCorrupt (SP4b spec §2.6): thread 2 died holding the block pool's lock, so the sim's copy-on-write
    // allocation finds a dead owner (on a handler of its own: the INTERNAL reply latched this one). The store is left
    // corrupt: this case runs last.
    new Int32Array(store.handles().blocks.ctl)[0] = 3;
    store.markDead(2);
    const corrupt = call(attachedHandler(), { type: 'edits', id: 41, edits: [set(x, y, z, val(STONE), before)] }).msg as ErrorMsg;
    expect([corrupt.type, corrupt.jobId, corrupt.epoch, corrupt.code]).toEqual(['error', 41, null, 'STORE_CORRUPT']);
    expect(corrupt.message).toContain('failed thread 2');
    // Nothing was written, and the handler left its read section: thread 15 announces no epoch.
    expect(valueAt(store, x, y, z)).toBe(before);
    expect(Atomics.load(new Int32Array(store.handles().reclaim), R_READER + SIM_THREAD)).toBe(0);
  });
});

describe('the sim handler before an attach', () => {
  test('`edits` before the attach is NOT_ATTACHED with its id; a `diff` reads the (empty) DiffStore', () => {
    const h = createMemorySimHandler();
    const m = call(h, { type: 'edits', id: 3, edits: [{ x: 0, y: 70, z: 0, op: 'set', value: val(STONE), expect: 0 }] }).msg as ErrorMsg;
    expect([m.type, m.jobId, m.code]).toEqual(['error', 3, 'NOT_ATTACHED']);
    const d = call(h, { type: 'diff', id: 4, cx: 0, cz: 0 }).msg as DiffMsg;
    expect([d.type, d.id, d.sy.length]).toEqual(['diff', 4, 0]);
    expect(h.drain()).toBe(0);
  });
});

describe('`load` (SP5b spec §2.3, §3.3, D18, D19, D22)', () => {
  const A = diffOf([[4, 10, val(STONE)], [4, 11, val(DIRT, 5)], [20, 4095, val(GLASS)]]);
  const B = diffOf([[0, 0, val(DIRT)]]);
  /** One dense section (fmt 1). */
  const D = diffOf(Array.from({ length: 2600 }, (_, k) => [3, k, val(STONE)] as const));

  test('`load` fills the DiffStore and answers the set, the entry count and 0 skipped', async () => {
    const kv = createMemoryKV();
    await seed(kv, 'w1', [[0, 0, A], [-7, 12, B], [300, -40, D]]);
    // Other worlds' columns, on both sides of w1's key range, stay out.
    await seed(kv, 'w0', [[1, 1, B]]);
    await seed(kv, 'w2', [[0, 0, B], [2, 2, A]]);
    const o = over(kv);
    o.send(loadMsg(1, 'w1'));
    await o.until(1);
    const m = loadedOf(o.got[0]!);
    expect(sortedKeys(m.entryCols)).toEqual(sortedKeys([colKey(0, 0), colKey(-7, 12), colKey(300, -40)]));
    expect([m.id, m.entries, m.unknownStates, m.skippedColumns]).toEqual([1, 3 + 1 + 2600, 0, 0]);
    expect(Number.isFinite(m.decodeMs) && m.decodeMs >= 0, `decodeMs ${m.decodeMs}`).toBe(true);
    expect(o.got[0]!.transfer).toEqual([m.entryCols.buffer]);
    for (const [cx, cz, d] of [[0, 0, A], [-7, 12, B], [300, -40, D], [1, 1, null], [2, 2, null]] as const) {
      const r = call(o.handler, { type: 'diff', id: 9, cx, cz }).msg as DiffMsg;
      expect(entriesOf(r), `(${cx}, ${cz})`).toEqual(d === null ? [] : entriesOf(d));
    }
    // A second `load` is refused, at once.
    const again = call(o.handler, loadMsg(2, 'w2')).msg as ErrorMsg;
    expect([again.type, again.jobId, again.code]).toEqual(['error', 2, 'BAD_MESSAGE']);
  });

  test('a corrupt record is skipped and counted, the others load', async () => {
    const kv = createMemoryKV();
    await seed(kv, 'w1', [[0, 0, A], [5, -5, B]]);
    await seedCorrupt(kv, 'w1', 1, 1);
    const o = over(kv);
    o.send(loadMsg(1, 'w1'));
    await o.until(1);
    const m = loadedOf(o.got[0]!);
    expect([m.entries, m.unknownStates, m.skippedColumns]).toEqual([4, 0, 1]);
    expect(sortedKeys(m.entryCols)).toEqual(sortedKeys([colKey(0, 0), colKey(5, -5)]));
    expect(entriesOf(call(o.handler, { type: 'diff', id: 3, cx: 1, cz: 1 }).msg as DiffMsg)).toEqual([]);
    expect(entriesOf(call(o.handler, { type: 'diff', id: 4, cx: 5, cz: -5 }).msg as DiffMsg)).toEqual(entriesOf(B));
    // Without a rewrite nothing is written: the corrupt record stays.
    expect(kv.dump('diffs')).toHaveLength(3);
  });

  test('a `diff` posted right after `load` waits and returns the loaded entries (with a 50 ms read delay)', async () => {
    const kv = createMemoryKV({ readDelayMs: 50 });
    await seed(kv, 'w1', [[0, 0, A]]);
    const o = over(kv);
    const t0 = performance.now();
    o.send(loadMsg(1, 'w1'));
    o.send({ type: 'diff', id: 2, cx: 0, cz: 0 });
    expect(o.got).toEqual([]);
    await o.until(2);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(o.got.map((r) => r.msg.type)).toEqual(['loaded', 'diff']);
    expect(entriesOf(o.got[1]!.msg as DiffMsg)).toEqual(entriesOf(A));
  });

  test('a permuted stored table: the entries load under today\'s ids, `unknownStates` counts the unknown key\'s voxels', async () => {
    const N = todayStateTable().length;
    const kv = createMemoryKV();
    // Stored ids: STONE and DIRT through the reversed table, and three voxels of the unknown key (id N), one with fluid.
    const stored = diffOf([[4, 10, val(storedId(STONE))], [4, 11, val(storedId(DIRT), 5)], [5, 0, val(N)], [5, 1, val(N, 3)], [5, 2, val(N)]]);
    await seed(kv, 'w1', [[0, 0, stored], [5, -5, diffOf([[0, 0, val(storedId(GLASS))]])]]);
    const before = kv.dump('diffs');
    const o = over(kv);
    o.send(loadMsg(1, 'w1', { stateTable: permuted() }));
    await o.until(1);
    const m = loadedOf(o.got[0]!);
    expect([m.entries, m.unknownStates, m.skippedColumns]).toEqual([6, 3, 0]);
    // Unknown → air (state 0, fluid 0); a known state keeps its fluid byte.
    expect(entriesOf(call(o.handler, { type: 'diff', id: 2, cx: 0, cz: 0 }).msg as DiffMsg))
      .toEqual([[4, 10, val(STONE)], [4, 11, val(DIRT, 5)], [5, 0, 0], [5, 1, 0], [5, 2, 0]]);
    expect(entriesOf(call(o.handler, { type: 'diff', id: 3, cx: 5, cz: -5 }).msg as DiffMsg)).toEqual([[0, 0, val(GLASS)]]);
    // No `rewrite`: nothing written.
    expect(kv.dump('diffs')).toEqual(before);
  });

  test('`rewrite` with a prefix table writes `worlds` only; with a non-prefix one writes every column re-encoded and the history, in one write, before `loaded`', async () => {
    const today = todayStateTable();
    // A prefix: today's table less its last state (ids are append-only).
    expect(Math.max(STONE, DIRT, GLASS)).toBeLessThan(today.length - 1);
    const kv = createMemoryKV();
    await seed(kv, 'w1', [[0, 0, A], [5, -5, B]], GEN_OLD);
    const diffsBefore = kv.dump('diffs');
    const write = vi.spyOn(kv, 'write');
    const atReply: Record<string, unknown> = {};
    const snapshot = (k: MemoryKV) => () => {
      for (const s of ['worlds', 'diffs', 'history'] as const) atReply[s] = k.dump(s);
    };
    const prefix = over(kv);
    prefix.send(loadMsg(1, 'w1', { stateTable: today.slice(0, -1), rewrite: { world: recordOf('w1'), history: historyOf('w1') } }), snapshot(kv));
    await prefix.until(1);
    expect(loadedOf(prefix.got[0]!).entries).toBe(4);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toEqual([{ op: 'put', store: 'worlds', key: 'w1', value: recordOf('w1') }]);
    expect(atReply).toEqual({ worlds: [['w1', recordOf('w1')]], diffs: diffsBefore, history: [] });

    // A non-prefix table: every column under today's ids, each keeping its header genKey, and the history, in one write.
    const N = today.length;
    const kv2 = createMemoryKV();
    const s0 = diffOf([[4, 10, val(storedId(STONE))], [5, 0, val(N)]]);
    const s1 = diffOf([[0, 0, val(storedId(DIRT), 5)]]);
    await seed(kv2, 'w1', [[0, 0, s0], [5, -5, s1]], GEN_OLD);
    const write2 = vi.spyOn(kv2, 'write');
    const other = over(kv2);
    other.send(loadMsg(1, 'w1', { stateTable: permuted(), rewrite: { world: recordOf('w1'), history: historyOf('w1') } }), snapshot(kv2));
    await other.until(1);
    expect(loadedOf(other.got[0]!).unknownStates).toBe(1);
    expect(write2).toHaveBeenCalledTimes(1);
    const ops = write2.mock.calls[0]![0];
    expect(ops.map((op) => [op.op, op.store])).toEqual([['put', 'worlds'], ['put', 'diffs'], ['put', 'diffs'], ['put', 'history']]);
    expect(atReply['worlds']).toEqual([['w1', recordOf('w1')]]);
    expect(atReply['history']).toEqual([['w1', historyOf('w1')]]);
    const diffsAt = atReply['diffs'] as Array<[readonly [string, number], Uint8Array]>;
    expect(diffsAt.map(([k]) => k)).toEqual([['w1', colKey(0, 0)], ['w1', colKey(5, -5)]]);
    const decoded = diffsAt.map(([, b]) => decodeColumnDiff(b, N));
    expect(decoded.map((d) => entriesOf(d.diff))).toEqual([[[4, 10, val(STONE)], [5, 0, 0]], [[0, 0, val(DIRT, 5)]]]);
    expect(decoded.map((d) => d.genKey)).toEqual([GEN_OLD, GEN_OLD]);
  });

  test('a permuted table with one undecodable column: after `load`, that key is gone and the others are re-encoded', async () => {
    const N = todayStateTable().length;
    const kv = createMemoryKV();
    await seed(kv, 'w1', [[0, 0, diffOf([[4, 10, val(storedId(STONE))]])], [5, -5, diffOf([[0, 0, val(storedId(GLASS))]])]]);
    await seedCorrupt(kv, 'w1', 1, 1);
    const o = over(kv);
    o.send(loadMsg(1, 'w1', { stateTable: permuted(), rewrite: { world: recordOf('w1'), history: null } }));
    await o.until(1);
    expect(loadedOf(o.got[0]!).skippedColumns).toBe(1);
    const diffs = kv.dump('diffs') as Array<[readonly [string, number], Uint8Array]>;
    expect(diffs.map(([k]) => k)).toEqual([['w1', colKey(0, 0)], ['w1', colKey(5, -5)]]);
    expect(diffs.map(([, b]) => entriesOf(decodeColumnDiff(b, N).diff))).toEqual([[[4, 10, val(STONE)]], [[0, 0, val(GLASS)]]]);
    // A null history writes none.
    expect(kv.dump('history')).toEqual([]);
  });

  test('a permuted-table rewrite whose write is failAt(0)-aborted answers error, and every key in the KV is as it was (ruling P3)', async () => {
    const kv = createMemoryKV();
    await seed(kv, 'w1', [[0, 0, diffOf([[4, 10, val(storedId(STONE))]])]]);
    const dumps = () => (['worlds', 'state', 'history', 'diffs', 'meta'] as const).map((s) => kv.dump(s));
    const before = dumps();
    kv.failAt(0);
    const o = over(kv);
    o.send(loadMsg(1, 'w1', { stateTable: permuted(), rewrite: { world: recordOf('w1'), history: historyOf('w1') } }));
    await o.until(1);
    const e = o.got[0]!.msg as ErrorMsg;
    expect([e.type, e.jobId, e.code]).toEqual(['error', 1, 'INTERNAL']);
    expect(e.message).toContain('abort');
    expect(e.message).toContain('AbortError');
    expect(dumps()).toEqual(before);
    // Nothing reached the DiffStore either.
    expect(entriesOf(call(o.handler, { type: 'diff', id: 2, cx: 0, cz: 0 }).msg as DiffMsg)).toEqual([]);
  });

  test('a KV open failure → an `error` reply', async () => {
    const o = over(() => Promise.reject(new Error('IndexedDB is not available')));
    o.send(loadMsg(1, 'w1'));
    o.send({ type: 'diff', id: 2, cx: 0, cz: 0 });
    await o.until(2);
    const e = o.got[0]!.msg as ErrorMsg;
    expect([e.type, e.jobId, e.code, e.message]).toEqual(['error', 1, 'INTERNAL', 'IndexedDB is not available']);
    expect(o.got[1]!.msg.type).toBe('diff');
    // A read failure too: a closed connection's read rejects.
    const kv = createMemoryKV();
    kv.closeNow();
    const r = over(kv);
    r.send(loadMsg(3, 'w1'));
    await r.until(1);
    expect([(r.got[0]!.msg as ErrorMsg).jobId, (r.got[0]!.msg as ErrorMsg).code]).toEqual([3, 'INTERNAL']);
  });
});

describe('`flushSyncPart` (SP5b spec §6.2: the `persist.flush` bench row times the sim\'s own synchronous part)', () => {
  test('`flushSyncPart` of 64 marked keys returns their ops, the keys as `taken` and the batch\'s bytes; the dirty set is empty after it', () => {
    const diffs = createDiffStore();
    /** One full dense section (fmt 1) at sy 2. */
    const dense: ColumnDiff = { sy: new Uint8Array(4096).fill(2), idx: Uint16Array.from({ length: 4096 }, (_, k) => k), value: new Uint32Array(4096).fill(val(STONE)) };
    const keys: number[] = [];
    const cols: Array<{ key: number; bytes: Uint8Array | null }> = [];
    let bytes = 0;
    for (let i = 0; i < 64; i++) {
      const cx = (i & 7) - 4;
      const cz = (i >> 3) - 4;
      const key = colKey(cx, cz);
      keys.push(key);
      // Every eighth column holds no entry (its key is deleted); the others a few entries, one a dense section.
      if (i % 8 === 7) {
        cols.push({ key, bytes: null });
        continue;
      }
      const d = i === 0 ? dense : diffOf([[i % 24, i, val(STONE)], [(i + 5) % 24, 4095 - i, val(DIRT, 3)]]);
      diffs.setColumn(cx, cz, d);
      const b = encodeColumnDiff(d, GEN);
      bytes += b.byteLength;
      cols.push({ key, bytes: b });
    }
    // `setColumn` marks nothing: the 64 keys are marked as edits would mark them.
    expect(diffs.takeDirty()).toHaveLength(0);
    diffs.markDirty(keys);
    const state = { ...stateOf('wp'), flushSeq: 5 };
    const history = historyOf('wp');
    const world = recordOf('wp');
    const r = flushSyncPart(diffs, 'wp', GEN, state, history, world);
    expect(r.ops).toEqual(flushOps('wp', cols, state, history, world));
    expect([...r.taken]).toEqual(keys);
    expect(r.bytes).toBe(bytes);
    expect(r.ops).toHaveLength(64 + 3);
    expect(diffs.takeDirty()).toHaveLength(0);
    // Nothing marked: a batch of the state alone.
    const empty = flushSyncPart(diffs, 'wp', GEN, state, null, null);
    expect([empty.ops, [...empty.taken], empty.bytes]).toEqual([[{ op: 'put', store: 'state', key: 'wp', value: state }], [], 0]);
  });
});

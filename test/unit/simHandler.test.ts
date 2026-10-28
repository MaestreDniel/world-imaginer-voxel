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
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { NO_ENTRY } from '../../src/sim/diffStore';
import { applyEdits } from '../../src/sim/edits';
import { DIRT, GLASS, STONE } from '../../src/world/blocks/index';
import type { DiffMsg, EditedMsg, ErrorMsg, FromSim } from '../../src/workers/protocol';
import { createSimHandler, SIM_DRAIN_MS } from '../../src/workers/simHandler';
import { R_READER, SIM_THREAD } from '../../src/world/store/reclaim';
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

describe('the sim handler on a shared seed-42 region (SP5a spec §2.1)', () => {
  let store: VoxelStore;
  /** The centre column of the 5 × 5 (its 3 × 3 is Published). */
  let C: [number, number] = [0, 0];
  const handler = createSimHandler();
  let id = 100;
  const set = (x: number, y: number, z: number, value: number, expectV: number) => ({ x, y, z, op: 'set', value, expect: expectV });
  const revert = (x: number, y: number, z: number, expectV: number) => ({ x, y, z, op: 'revert', value: 0, expect: expectV });
  const post = (edits: unknown[]) => handler.handle({ type: 'edits', id: ++id, edits });
  const edited = (r: { msg: FromSim }): EditedMsg => {
    expect(r.msg.type, JSON.stringify(r.msg)).toBe('edited');
    return r.msg as EditedMsg;
  };
  const surface = (x: number, z: number): number => store.heightAt('worldSurface', x, z)!;

  beforeAll(async () => {
    const params = resolveProfile('default');
    const sp = findSpawn(createGenContext(seedFromInput('42'), params));
    C = [sp.x >> 4, sp.z >> 4];
    store = (await genRegion({ seed: '42', params, cx0: C[0] - 2, cz0: C[1] - 2, w: 5, h: 5, upTo: 'L', order: 'spiral', threads: 1, shared: true })).view.store;
    expect(store.shared).toBe(true);
    expect(handler.handle({ type: 'attach', handles: store.handles(), thread: 15 }).msg).toEqual({ type: 'attached' });
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
    expect([...m.entryCols]).toEqual([colKey(C[0], C[1])]);
    expect(m.relightMs).toBeGreaterThanOrEqual(0);
    expect(m.editMs).toBeGreaterThanOrEqual(m.relightMs);
    // Written through the sim's own attachment: the main thread reads the voxel and the bumped version.
    expect(valueAt(store, x, y, z)).toBe(val(STONE));
    expect(blockVersion(store, C[0], C[1])).toBe(bv + 1);
    // Every array of the result is transferred whole.
    expect(r.transfer).toEqual([m.prev.buffer, m.next.buffer, m.dirty.buffer, m.entryCols.buffer]);
    for (const a of [m.prev, m.next, m.dirty, m.entryCols]) expect(a.byteLength).toBe(a.buffer.byteLength);
    // A refusal comes back as a result too: the same voxel, expected at its old value, is `changed`.
    const refused = edited(post([set(x, y, z, val(DIRT), before)]));
    expect(refused.refused).toBe('changed');
    expect([...refused.prev]).toEqual([val(STONE)]);
    expect(valueAt(store, x, y, z)).toBe(val(STONE));
    // Undo it, so the later cases start from the generated terrain.
    expect(edited(post([revert(x, y, z, val(STONE))])).refused).toBeNull();
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
    const r = handler.handle({ type: 'diff', id: 7, cx: C[0], cz: C[1] });
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
    const none = handler.handle({ type: 'diff', id: 8, cx: C[0] + 1, cz: C[1] }).msg as DiffMsg;
    expect([none.type, none.id, none.sy.length, none.idx.length, none.value.length]).toEqual(['diff', 8, 0, 0, 0]);
    expect(edited(post([revert(hi[0]!, hi[1]!, hi[2]!, val(GLASS)), revert(lo[0]!, lo[1]!, lo[2]!, val(STONE))])).refused).toBeNull();
    expect((handler.handle({ type: 'diff', id: 9, cx: C[0], cz: C[1] }).msg as DiffMsg).sy.length).toBe(0);
  });

  test('messages are handled in order: an `edits` then a `diff` of the same column returns the new entry', () => {
    const [cx, cz] = [C[0] + 1, C[1] - 1];
    const x = 16 * cx + 7;
    const z = 16 * cz + 8;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const replies = [
      handler.handle({ type: 'edits', id: 20, edits: [set(x, y, z, val(GLASS), before)] }),
      handler.handle({ type: 'diff', id: 21, cx, cz }),
      handler.handle({ type: 'edits', id: 22, edits: [set(x, y, z, val(DIRT), val(GLASS))] }),
      handler.handle({ type: 'diff', id: 23, cx, cz }),
    ].map((r) => r.msg);
    expect(replies.map((m) => [m.type, (m as { id: number }).id])).toEqual([['edited', 20], ['diff', 21], ['edited', 22], ['diff', 23]]);
    expect([...(replies[1] as DiffMsg).value]).toEqual([val(GLASS)]);
    expect([...(replies[3] as DiffMsg).value]).toEqual([val(DIRT)]);
    expect(edited(post([revert(x, y, z, val(DIRT))])).refused).toBeNull();
  });

  test('a malformed message → `BAD_MESSAGE` and nothing written', () => {
    const x = 16 * C[0] + 5;
    const z = 16 * C[1] + 5;
    const y = surface(x, z);
    const before = valueAt(store, x, y, z);
    const versions = [blockVersion(store, C[0], C[1]), store.table.lightVersion(store.table.find(C[0], C[1]))];
    const bad = (m: unknown): ErrorMsg => {
      const r = handler.handle(m);
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
    expect((handler.handle({ type: 'diff', id: 33, cx: C[0], cz: C[1] }).msg as DiffMsg).sy.length).toBe(0);
  });

  test('a repeated attach to the same store as 15 is answered `attached` again', () => {
    expect(handler.handle({ type: 'attach', handles: store.handles(), thread: 15 }).msg).toEqual({ type: 'attached' });
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
    const internal = handler.handle({ type: 'edits', id: 40, edits: [set(x, y, z, val(STONE), before)] }).msg as ErrorMsg;
    expect([internal.type, internal.jobId, internal.epoch, internal.code, internal.message]).toEqual(['error', 40, null, 'INTERNAL', 'injected bug']);
    // A real StoreCorrupt (SP4b spec §2.6): thread 2 died holding the block pool's lock, so the sim's copy-on-write
    // allocation finds a dead owner. The store is left corrupt: this case runs last.
    new Int32Array(store.handles().blocks.ctl)[0] = 3;
    store.markDead(2);
    const corrupt = handler.handle({ type: 'edits', id: 41, edits: [set(x, y, z, val(STONE), before)] }).msg as ErrorMsg;
    expect([corrupt.type, corrupt.jobId, corrupt.epoch, corrupt.code]).toEqual(['error', 41, null, 'STORE_CORRUPT']);
    expect(corrupt.message).toContain('failed thread 2');
    // Nothing was written, and the handler left its read section: thread 15 announces no epoch.
    expect(valueAt(store, x, y, z)).toBe(before);
    expect(Atomics.load(new Int32Array(store.handles().reclaim), R_READER + SIM_THREAD)).toBe(0);
  });
});

describe('the sim handler before an attach', () => {
  test('`edits` before the attach is NOT_ATTACHED with its id; a `diff` reads the (empty) DiffStore', () => {
    const h = createSimHandler();
    const m = h.handle({ type: 'edits', id: 3, edits: [{ x: 0, y: 70, z: 0, op: 'set', value: val(STONE), expect: 0 }] }).msg as ErrorMsg;
    expect([m.type, m.jobId, m.code]).toEqual(['error', 3, 'NOT_ATTACHED']);
    const d = h.handle({ type: 'diff', id: 4, cx: 0, cz: 0 }).msg as DiffMsg;
    expect([d.type, d.id, d.sy.length]).toEqual(['diff', 4, 0]);
    expect(h.drain()).toBe(0);
  });
});

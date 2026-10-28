/**
 * The edit writer (SP5a spec §2.2, D18): `reopenPublished` opens a Published column whose final blocks and fluid
 * share the proto's slots (`shareFinal`); `replaceBlocks` and `replaceLight` are copy-on-write and keep the replaced
 * codes until `publish` (which retires them and bumps the versions without a status change) or `rollback` (which
 * re-points the entries with no allocation). The previous codes are held by the writer (the plan's rulings, R6).
 */
import { describe, expect, test, vi } from 'vitest';
import { finalAt, protoAt, SECTIONS, WriterStale } from '../../src/world/store/columnTable';
import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, FINAL_META, PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { attachStore, createStore, type VoxelStore } from '../../src/world/store/store';

const MiB = 1 << 20;
const CX = 3;
const CZ = -2;
const words = (v: number) => new Uint16Array(4096).fill(v);
const bytes = (v: number) => new Uint8Array(4096).fill(v);
const WATER = 0x10;

/** Stone below ly 8, air above: dense blocks. */
function mixedBlocks(): Uint16Array {
  const b = words(0);
  b.fill(1, 0, 8 << 8);
  return b;
}

/** Water sources in the bottom half: dense fluid. */
function mixedFluid(): Uint8Array {
  const f = bytes(0);
  f.fill(WATER, 0, 8 << 8);
  return f;
}

/** A light channel with a different byte per voxel (dense), seeded by `k`. */
function denseLight(k: number): Uint8Array {
  const l = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) l[i] = (i + k) & 15;
  return l;
}

/**
 * A Published (cx, cz): T writes dense blocks and fluid in even sections (uniform stone and no fluid in odd ones), D
 * shares them into the final set (`shareFinal`, all-zero light) and writes aux A, L writes dense light in even sections
 * and uniform 15 in odd ones.
 */
function publish(s: VoxelStore, cx = CX, cz = CZ): void {
  const t = s.claimColumn(cx, cz, 0);
  for (let sy = 0; sy < SECTIONS; sy++) {
    t.setProto(sy, sy % 2 === 0 ? mixedBlocks() : words(1), sy % 2 === 0 ? mixedFluid() : bytes(0));
  }
  t.commit(1);
  const d = s.reopenColumn(cx, cz, 1);
  for (let sy = 0; sy < SECTIONS; sy++) d.shareFinal(sy, bytes(0));
  d.aux().worldSurface.fill(70);
  d.commit(2);
  const l = s.reopenColumn(cx, cz, 2);
  for (let sy = 0; sy < SECTIONS; sy++) l.setLight(sy, sy % 2 === 0 ? denseLight(sy) : bytes(15));
  l.commit(3);
}

/** New dense blocks: state 2 everywhere but voxel 0, state 1; and new dense fluid: none but voxel 1, water. */
function editedBlocks(): Uint16Array {
  const b = words(2);
  b[0] = 1;
  return b;
}
function editedFluid(): Uint8Array {
  const f = bytes(0);
  f[1] = WATER;
  return f;
}

describe('the edit writer (SP5a spec §2.2, D18)', () => {
  const newStore = () => createStore({ shared: true, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
  /** The record's entries and versions, read through the table. */
  const record = (s: VoxelStore) => {
    const base = s.table.find(CX, CZ);
    const ints = s.table.ints;
    return {
      base,
      ints,
      protoBlocks: (sy: number) => ints[protoAt(base, sy) + PROTO_BLOCKS]!,
      protoFluid: (sy: number) => ints[protoAt(base, sy) + PROTO_FLUID]!,
      finalBlocks: (sy: number) => ints[finalAt(base, sy) + FINAL_BLOCKS]!,
      finalFluid: (sy: number) => ints[finalAt(base, sy) + FINAL_FLUID]!,
      finalLight: (sy: number) => ints[finalAt(base, sy) + FINAL_LIGHT]!,
      meta: (sy: number) => ints[finalAt(base, sy) + FINAL_META]!,
      versions: () => [s.table.blockVersion(base), s.table.lightVersion(base), s.table.status(base)],
    };
  };

  test('replaceBlocks leaves the proto\'s section unchanged: its slot\'s words are equal before and after, and the proto entry\'s code is the same; the slot\'s refcount is 2 before (shared by the final), stays 2 while another reader holds the release in limbo, and is 1 after that reader exits and the drain runs (1 at once with no reader); the final reads the new values from a different slot', () => {
    const s = newStore();
    publish(s);
    const r = record(s);
    for (const sy of [0, 2]) {
      expect(r.finalBlocks(sy)).toBe(r.protoBlocks(sy));
      expect(r.finalFluid(sy)).toBe(r.protoFluid(sy));
    }
    const p = r.protoBlocks(0);
    const pf = r.protoFluid(0);
    const protoWords = s.blockPool.u16(p).slice();
    const protoBytes = s.bytePool.u8(pf).slice();
    expect([s.blockPool.refcount(p), s.bytePool.refcount(pf)]).toEqual([2, 2]);

    // Another thread's read section holds the release in limbo.
    const reader = attachStore(s.handles(), 1);
    reader.enterRead();
    const w = s.reopenPublished(CX, CZ);
    w.replaceBlocks(0, editedBlocks(), editedFluid());
    expect([r.protoBlocks(0), r.protoFluid(0)]).toEqual([p, pf]);
    expect(s.blockPool.u16(p)).toEqual(protoWords);
    expect(s.bytePool.u8(pf)).toEqual(protoBytes);
    // The final entries moved to new slots; the writer holds the previous ones until publish.
    expect(r.finalBlocks(0)).toBeGreaterThanOrEqual(0);
    expect(r.finalBlocks(0)).not.toBe(p);
    expect(r.finalFluid(0)).toBeGreaterThanOrEqual(0);
    expect(r.finalFluid(0)).not.toBe(pf);
    const final = s.final(CX, CZ)!;
    expect([final.block(0, -64, 0), final.block(1, -64, 0), final.block(15, -64 + 15, 15)]).toEqual([1, 2, 2]);
    expect([final.fluid(0, -64, 0), final.fluid(1, -64, 0), final.fluid(2, -64, 0)]).toEqual([0, WATER, 0]);
    const proto = s.proto(CX, CZ)!;
    expect([proto.block(0, -64, 0), proto.block(0, -64 + 15, 0), proto.fluid(1, -64, 0)]).toEqual([1, 0, WATER]);
    w.publish();
    expect([s.blockPool.refcount(p), s.bytePool.refcount(pf)]).toEqual([2, 2]);
    expect(s.limboCount(0)).toBe(2);
    reader.exitRead();
    expect(s.drain()).toBe(0);
    expect([s.blockPool.refcount(p), s.bytePool.refcount(pf)]).toEqual([1, 1]);

    // With no reader the release frees at once.
    const p2 = r.protoBlocks(2);
    const pf2 = r.protoFluid(2);
    w.replaceBlocks(2, editedBlocks(), editedFluid());
    expect([s.blockPool.refcount(p2), s.bytePool.refcount(pf2)]).toEqual([2, 2]);
    w.publish();
    expect([s.blockPool.refcount(p2), s.bytePool.refcount(pf2)]).toEqual([1, 1]);
    expect(s.limboCount(0)).toBe(0);
    expect([r.protoBlocks(2), r.protoFluid(2)]).toEqual([p2, pf2]);
  });

  test('replaceBlocks then publish bumps blockVersion by 1 and lightVersion by 0, and the status stays 3', () => {
    const s = newStore();
    publish(s);
    const r = record(s);
    const [bv, lv] = r.versions();
    const w = s.reopenPublished(CX, CZ);
    w.replaceBlocks(0, editedBlocks(), editedFluid());
    w.replaceBlocks(1, words(0), bytes(0));
    // Nothing is bumped before publish.
    expect(r.versions()).toEqual([bv, lv, 3]);
    w.publish();
    expect(r.versions()).toEqual([bv! + 1, lv, 3]);
    // The meta words follow the new sections: section 1 is all air with no fluid now.
    expect(r.meta(1)).toBe(0);
    expect(r.meta(0) & 0x1fff).toBe(4096);
  });

  test('replaceLight over a dense light entry succeeds, the old slot goes through retire (in limbo under a reader), publish bumps lightVersion only', () => {
    const s = newStore();
    publish(s);
    const r = record(s);
    const old = r.finalLight(0);
    expect(old).toBeGreaterThanOrEqual(0);
    expect(s.bytePool.refcount(old)).toBe(1);
    const [bv, lv] = r.versions();
    const reader = attachStore(s.handles(), 1);
    reader.enterRead();
    const w = s.reopenPublished(CX, CZ);
    w.replaceLight(0, denseLight(5));
    expect(r.finalLight(0)).not.toBe(old);
    expect(s.final(CX, CZ)!.light(0, -64, 0)).toBe(5);
    expect(s.limboCount(0)).toBe(0);
    w.publish();
    expect(r.versions()).toEqual([bv, lv! + 1, 3]);
    expect(s.limboCount(0)).toBe(1);
    expect(s.bytePool.refcount(old)).toBe(1);
    reader.exitRead();
    expect(s.drain()).toBe(0);
    expect(s.bytePool.refcount(old)).toBe(0);
  });

  test('a publish with nothing written bumps nothing', () => {
    const s = newStore();
    publish(s);
    const r = record(s);
    const before = r.versions();
    const w = s.reopenPublished(CX, CZ);
    w.publish();
    w.setDiffFlag();
    w.publish();
    expect(r.versions()).toEqual(before);
  });

  test('rollback after replaceBlocks and replaceLight re-points both entries to their previous codes with no pool.alloc call (a counting pool), retires the new slots, and a later publish bumps nothing', () => {
    const s = newStore();
    publish(s);
    const r = record(s);
    const before = r.versions();
    const entries = () => [r.finalBlocks(0), r.finalFluid(0), r.finalLight(0), r.finalBlocks(1), r.finalLight(1), r.meta(0), r.meta(1)];
    const was = entries();
    const used = () => [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];
    const inUse = used();
    const reader = attachStore(s.handles(), 1);
    reader.enterRead();
    const w = s.reopenPublished(CX, CZ);
    w.replaceBlocks(0, editedBlocks(), editedFluid());
    // A second replace of the same section: the writer's own intermediate slots are retired at once.
    w.replaceBlocks(0, mixedBlocks().reverse(), editedFluid().reverse());
    w.replaceBlocks(1, editedBlocks(), bytes(0));
    w.replaceLight(0, denseLight(7));
    w.replaceLight(1, denseLight(9));
    const fresh = [r.finalBlocks(0), r.finalFluid(0), r.finalLight(0), r.finalBlocks(1), r.finalLight(1)];
    expect(fresh.every((c) => c >= 0)).toBe(true);
    const blockAlloc = vi.spyOn(s.blockPool, 'alloc');
    const byteAlloc = vi.spyOn(s.bytePool, 'alloc');
    w.rollback();
    expect(blockAlloc).not.toHaveBeenCalled();
    expect(byteAlloc).not.toHaveBeenCalled();
    expect(entries()).toEqual(was);
    expect(s.final(CX, CZ)!.block(0, -64 + 15, 0)).toBe(0);
    expect(s.final(CX, CZ)!.light(0, -64, 0)).toBe(0);
    // The new slots go through retire: in limbo under the reader, then freed.
    reader.exitRead();
    expect(s.drain()).toBe(0);
    for (const c of fresh.slice(0, 1).concat(fresh.slice(3, 4))) expect(s.blockPool.refcount(c)).toBe(0);
    for (const c of [fresh[1]!, fresh[2]!, fresh[4]!]) expect(s.bytePool.refcount(c)).toBe(0);
    expect(used()).toEqual(inUse);
    w.publish();
    expect(r.versions()).toEqual(before);
    expect(entries()).toEqual(was);
  });

  test('reopenPublished returns the thread\'s one writer of the record: two opens of a column in a batch, each replacing section 0, roll back in open order or in reverse to the previous entry (code, refcount, voxel), and publish on both bumps blockVersion once', () => {
    for (const order of ['open', 'reverse'] as const) {
      const s = newStore();
      publish(s);
      const r = record(s);
      const k0 = r.finalBlocks(0);
      const kf = r.finalFluid(0);
      const meta = r.meta(0);
      expect([s.blockPool.refcount(k0), s.bytePool.refcount(kf)]).toEqual([2, 2]);
      expect(s.final(CX, CZ)!.block(0, -64 + 15, 0)).toBe(0);
      const a = s.reopenPublished(CX, CZ);
      a.replaceBlocks(0, words(5), bytes(0));
      const b = s.reopenPublished(CX, CZ);
      expect(b).toBe(a);
      b.replaceBlocks(0, words(6), bytes(0));
      expect(s.final(CX, CZ)!.block(0, -64 + 15, 0)).toBe(6);
      for (const w of order === 'open' ? [a, b] : [b, a]) w.rollback();
      expect([r.finalBlocks(0), r.finalFluid(0), r.meta(0)]).toEqual([k0, kf, meta]);
      expect([s.blockPool.refcount(k0), s.bytePool.refcount(kf)]).toEqual([2, 2]);
      expect(s.final(CX, CZ)!.block(0, -64 + 15, 0)).toBe(0);
    }
    const s = newStore();
    publish(s);
    const r = record(s);
    const before = r.versions();
    const a = s.reopenPublished(CX, CZ);
    a.replaceBlocks(0, words(5), bytes(0));
    const b = s.reopenPublished(CX, CZ);
    b.replaceBlocks(0, words(6), bytes(0));
    a.publish();
    b.publish();
    expect(r.versions()).toEqual([before[0]! + 1, before[1], 3]);
    expect(s.final(CX, CZ)!.block(0, -64 + 15, 0)).toBe(6);
    // A freed and re-published record gets a new writer.
    s.freeColumn(CX, CZ);
    publish(s);
    expect(s.reopenPublished(CX, CZ)).not.toBe(a);
  });

  test('after a publish, the retained previous codes are released (the old slot\'s refcount back to its value without the writer)', () => {
    const s = newStore();
    publish(s);
    const r = record(s);
    const blocks = r.finalBlocks(0);
    const light = r.finalLight(0);
    // Shared by the proto and the final; the light by the final alone.
    expect([s.blockPool.refcount(blocks), s.bytePool.refcount(light)]).toEqual([2, 1]);
    const w = s.reopenPublished(CX, CZ);
    w.replaceBlocks(0, editedBlocks(), editedFluid());
    w.replaceLight(0, denseLight(3));
    // The writer holds the reference the final entries gave up.
    expect([s.blockPool.refcount(blocks), s.bytePool.refcount(light)]).toEqual([2, 1]);
    w.publish();
    expect([s.blockPool.refcount(blocks), s.bytePool.refcount(light)]).toEqual([1, 0]);
  });

  test('reopenPublished on a Decorated column throws; on a freed and re-claimed record every call throws WriterStale', () => {
    const s = newStore();
    const t = s.claimColumn(0, 0, 0);
    t.setProto(0, mixedBlocks(), mixedFluid());
    t.commit(1);
    const d = s.reopenColumn(0, 0, 1);
    d.shareFinal(0, bytes(0));
    d.commit(2);
    expect(() => s.reopenPublished(0, 0)).toThrow('reopenPublished: (0, 0) is not Published');
    expect(() => s.reopenPublished(5, 5)).toThrow('reopenPublished: (5, 5) is not Published');
    publish(s);
    const w = s.reopenPublished(CX, CZ);
    s.freeColumn(CX, CZ);
    publish(s);
    for (const call of [
      () => w.replaceBlocks(0, editedBlocks(), editedFluid()),
      () => w.replaceLight(0, denseLight(1)),
      () => w.setDiffFlag(),
      () => w.aux(),
      () => w.publish(),
      () => w.rollback(),
    ]) expect(call).toThrow(WriterStale);
  });

  test('setDiffFlag makes diffFlag true', () => {
    const s = newStore();
    publish(s);
    expect(s.diffFlag(CX, CZ)).toBe(false);
    const w = s.reopenPublished(CX, CZ);
    expect(w.aux().worldSurface[0]).toBe(70);
    w.setDiffFlag();
    expect(s.diffFlag(CX, CZ)).toBe(true);
    expect(s.table.status(s.table.find(CX, CZ))).toBe(3);
  });
});

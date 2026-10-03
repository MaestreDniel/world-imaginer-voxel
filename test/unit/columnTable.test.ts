import { describe, expect, test } from 'vitest';
import {
  attachColumnTable, COLUMN_TABLE_BYTES, createColumnTable, finalAt, NO_COLUMN, protoAt, RECORD_COUNT, RECORD_INTS, recordBase,
  REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED, REC_CX, REC_CZ, REC_DIFF_FLAG, REC_EPOCH, REC_FINAL,
  REC_LIGHT_VERSION, REC_PROTO, REC_PROTO_FLAGS, REC_STATUS, REC_UNSETTLED, SECTIONS, SlotBusy, STATUS_ABSENT,
  STATUS_DECORATED, STATUS_PROTO, STATUS_PUBLISHED, TORUS, type ColumnTable,
} from '../../src/world/store/columnTable';

/** Every record free, as `createStore` leaves it (SP3a spec §3.2). */
function expectFree(t: ColumnTable, base: number): void {
  const r = t.ints;
  expect(r[base + REC_CLAIMED]).toBe(0);
  expect([r[base + REC_CX], r[base + REC_CZ]]).toEqual([NO_COLUMN, NO_COLUMN]);
  expect(r[base + REC_STATUS]).toBe(STATUS_ABSENT);
  expect(r[base + REC_AUX_A]).toBe(-1);
  expect(r[base + REC_AUX_B]).toBe(-1);
  for (let sy = 0; sy < SECTIONS; sy++) {
    const f = finalAt(base, sy);
    expect([r[f], r[f + 1], r[f + 2], r[f + 3]]).toEqual([-1, -1, -1, 0]);
    const p = protoAt(base, sy);
    expect([r[p], r[p + 1]]).toEqual([-1, -1]);
  }
}

test('record layout (SP3a spec §3.2, master §2.3)', () => {
  expect(TORUS).toBe(64);
  expect(RECORD_INTS).toBe(160);
  expect(RECORD_COUNT).toBe(4096);
  expect(COLUMN_TABLE_BYTES).toBe(64 * 64 * 160 * 4);
  expect(SECTIONS).toBe(24);
  expect([REC_CX, REC_CZ, REC_STATUS, REC_EPOCH]).toEqual([0, 1, 2, 3]);
  expect([REC_BLOCK_VERSION, REC_LIGHT_VERSION, REC_PROTO_FLAGS]).toEqual([4, 5, 6]);
  expect([REC_AUX_A, REC_AUX_B, REC_UNSETTLED, REC_DIFF_FLAG, REC_CLAIMED]).toEqual([7, 8, 9, 10, 11]);
  expect([REC_FINAL, REC_PROTO]).toEqual([16, 112]);
  expect([STATUS_ABSENT, STATUS_PROTO, STATUS_DECORATED, STATUS_PUBLISHED]).toEqual([0, 1, 2, 3]);
  // 24 final descriptors of 4 ints fill 16-111, 24 proto descriptors of 2 ints fill 112-159.
  expect(finalAt(0, 0)).toBe(16);
  expect(finalAt(0, 23) + 4).toBe(112);
  expect(protoAt(0, 0)).toBe(112);
  expect(protoAt(0, 23) + 2).toBe(160);
  expect(finalAt(RECORD_INTS, 1)).toBe(RECORD_INTS + 20);
  expect(protoAt(RECORD_INTS, 1)).toBe(RECORD_INTS + 114);
});

test('record = torus slot (cx & 63) + 64·(cz & 63), negative coordinates included', () => {
  expect(recordBase(0, 0)).toBe(0);
  expect(recordBase(1, 0)).toBe(RECORD_INTS);
  expect(recordBase(0, 1)).toBe(64 * RECORD_INTS);
  expect(recordBase(-1, -1)).toBe((63 + 64 * 63) * RECORD_INTS);
  expect(recordBase(64, -64)).toBe(0);
  expect(recordBase(-32768, 32767)).toBe((0 + 64 * 63) * RECORD_INTS);
  const seen = new Set<number>();
  for (let cz = -32; cz < 32; cz++) for (let cx = 100; cx < 164; cx++) seen.add(recordBase(cx, cz));
  expect(seen.size).toBe(RECORD_COUNT);
});

describe.each([true, false])('shared %s', (shared) => {
  test('the buffer is fixed, of the requested kind, and every record starts free', () => {
    const t = createColumnTable(shared);
    expect(t.buffer instanceof SharedArrayBuffer).toBe(shared);
    expect(t.buffer.byteLength).toBe(COLUMN_TABLE_BYTES);
    if (t.buffer instanceof SharedArrayBuffer) expect(t.buffer.growable).toBe(false);
    else expect(t.buffer.resizable).toBe(false);
    for (let rec = 0; rec < RECORD_COUNT; rec++) expectFree(t, rec * RECORD_INTS);
    expect(t.find(0, 0)).toBe(-1);
  });

  test('claim writes cx, cz and epoch, leaves the rest initial; find sees only the holder', () => {
    const t = createColumnTable(shared);
    const base = t.claim(-3, 70, 9);
    expect(base).toBe(recordBase(-3, 70));
    expect(t.ints[base + REC_CLAIMED]).toBe(1);
    expect(t.ints[base + REC_CX]).toBe(-3);
    expect(t.ints[base + REC_CZ]).toBe(70);
    expect(t.epoch(base)).toBe(9);
    expect(t.status(base)).toBe(STATUS_ABSENT);
    expect(t.blockVersion(base)).toBe(0);
    expect(t.lightVersion(base)).toBe(0);
    expect(t.find(-3, 70)).toBe(base);
    // Same record, another column: absent (spec §3.2 "a read of a column whose record holds another column").
    expect(t.find(-3 + 64, 70)).toBe(-1);
    expect(t.find(-3, 70 - 64)).toBe(-1);
    expect(t.find(-2, 70)).toBe(-1);
  });

  test('claiming a held record throws SlotBusy, for another column and for the same one', () => {
    const t = createColumnTable(shared);
    const base = t.claim(5, 5, 1);
    for (const [cx, cz] of [[5, 5], [69, 5], [5, -59]] as const) {
      let err: unknown;
      try {
        t.claim(cx, cz, 2);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SlotBusy);
      expect((err as Error).name).toBe('SlotBusy');
    }
    // The failed claims changed nothing.
    expect(t.ints[base + REC_CX]).toBe(5);
    expect(t.epoch(base)).toBe(1);
    expect(t.find(5, 5)).toBe(base);
  });

  test('unclaim frees the record; a later claim of another column on it succeeds and starts initial', () => {
    const t = createColumnTable(shared);
    const base = t.claim(0, 0, 4);
    t.setStatus(base, STATUS_PROTO);
    t.bumpBlockVersion(base);
    t.bumpLightVersion(base);
    t.ints[base + REC_PROTO_FLAGS] = 7;
    t.ints[base + REC_UNSETTLED] = 3;
    t.ints[base + REC_DIFF_FLAG] = 1;
    t.setStatus(base, STATUS_ABSENT);
    t.clear(base);
    t.unclaim(base);
    expectFree(t, base);
    expect(t.find(0, 0)).toBe(-1);
    expect(t.claim(64, 64, 5)).toBe(base);
    expect(t.find(64, 64)).toBe(base);
    expect(t.status(base)).toBe(STATUS_ABSENT);
    expect(t.blockVersion(base)).toBe(0);
    expect(t.lightVersion(base)).toBe(0);
    expect(t.ints[base + REC_PROTO_FLAGS]).toBe(0);
    expect(t.ints[base + REC_UNSETTLED]).toBe(0);
    expect(t.ints[base + REC_DIFF_FLAG]).toBe(0);
  });

  test('claim resets a record left dirty by a holder (versions, descriptors, aux ids)', () => {
    const t = createColumnTable(shared);
    const base = t.claim(1, 2, 0);
    t.ints[finalAt(base, 3) + 3] = 99;
    t.ints[protoAt(base, 3)] = 12;
    t.ints[base + REC_AUX_A] = 4;
    t.bumpBlockVersion(base);
    t.unclaim(base);
    t.claim(1, 2, 1);
    t.unclaim(base);
    expectFree(t, base);
    expect(t.blockVersion(base)).toBe(0);
  });

  test('status, epoch and versions', () => {
    const t = createColumnTable(shared);
    const base = t.claim(-1, -1, 3);
    expect(t.bumpBlockVersion(base)).toBe(1);
    expect(t.bumpBlockVersion(base)).toBe(2);
    expect(t.bumpLightVersion(base)).toBe(1);
    expect(t.blockVersion(base)).toBe(2);
    expect(t.lightVersion(base)).toBe(1);
    t.setStatus(base, STATUS_PUBLISHED);
    expect(t.status(base)).toBe(STATUS_PUBLISHED);
    expect(t.status(recordBase(0, 0))).toBe(STATUS_ABSENT);
  });

  test('attachColumnTable over the same buffer sees the same records', () => {
    const t = createColumnTable(shared);
    const u = attachColumnTable(t.buffer);
    const base = t.claim(10, -10, 6);
    expect(u.find(10, -10)).toBe(base);
    expect(u.epoch(base)).toBe(6);
    expect(() => u.claim(74, -10, 0)).toThrow(SlotBusy);
    u.unclaim(base);
    expect(t.find(10, -10)).toBe(-1);
  });
});

test('a record being claimed never matches a lookup of its previous column', () => {
  const t = createColumnTable(false);
  const base = t.claim(5, 5, 0);
  t.unclaim(base);
  // Another column takes the record: between the compare-exchange and the cx/cz writes, cx/cz are NO_COLUMN.
  Atomics.store(t.ints, base + REC_CLAIMED, 1);
  expect(t.find(5, 5)).toBe(-1);
  expect(NO_COLUMN).toBeGreaterThan(1 << 20);
});

test('attachColumnTable refuses a buffer of another size', () => {
  expect(() => attachColumnTable(new ArrayBuffer(16))).toThrow(RangeError);
});

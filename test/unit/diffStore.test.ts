import { describe, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { createDiffStore, NO_ENTRY } from '../../src/sim/diffStore';

/** A value as the DiffStore holds it: `state << 8 | fluid`. */
const val = (state: number, fluid = 0): number => (state << 8) | fluid;

describe('DiffStore (SP5a spec §2.4, D20; master §2.7)', () => {
  test('set, get, remove round-trip', () => {
    const d = createDiffStore();
    expect(d.get(0, 0, 8, 100)).toBe(NO_ENTRY);
    d.set(0, 0, 8, 100, val(7));
    d.set(0, 0, 8, 101, val(0, 8));
    d.set(-3, 5, 23, 4095, val(57, 1));
    expect(d.get(0, 0, 8, 100)).toBe(val(7));
    expect(d.get(0, 0, 8, 101)).toBe(val(0, 8));
    expect(d.get(-3, 5, 23, 4095)).toBe(val(57, 1));
    // The same section index in another column, or another section of the same column, has no entry.
    expect(d.get(1, 0, 8, 100)).toBe(NO_ENTRY);
    expect(d.get(0, 0, 9, 100)).toBe(NO_ENTRY);
    expect(d.size).toBe(3);
    // A set over an entry replaces its value.
    d.set(0, 0, 8, 100, val(12));
    expect(d.get(0, 0, 8, 100)).toBe(val(12));
    expect(d.size).toBe(3);
    d.remove(0, 0, 8, 100);
    expect(d.get(0, 0, 8, 100)).toBe(NO_ENTRY);
    expect(d.get(0, 0, 8, 101)).toBe(val(0, 8));
    expect(d.size).toBe(2);
    // Removing an absent entry is a no-op.
    d.remove(0, 0, 8, 100);
    d.remove(9, 9, 0, 0);
    expect(d.size).toBe(2);
    expect(d.has(0, 0)).toBe(true);
    expect(d.has(-3, 5)).toBe(true);
    expect(d.has(9, 9)).toBe(false);
  });

  test('`columnDiff` is canonical whatever the insertion order, and null for a column without entries', () => {
    const entries: Array<[sy: number, idx: number, value: number]> = [
      [12, 4000, val(3)], [0, 5, val(1)], [12, 7, val(2, 8)], [23, 0, val(40)], [0, 4095, val(9)], [5, 300, val(0, 1)],
    ];
    const want = {
      sy: [0, 0, 5, 12, 12, 23],
      idx: [5, 4095, 300, 7, 4000, 0],
      value: [val(1), val(9), val(0, 1), val(2, 8), val(3), val(40)],
    };
    const orders = [entries, [...entries].reverse(), [entries[3]!, entries[1]!, entries[5]!, entries[0]!, entries[4]!, entries[2]!]];
    for (const order of orders) {
      const d = createDiffStore();
      for (const [sy, idx, value] of order) d.set(4, -2, sy, idx, value);
      const cd = d.columnDiff(4, -2)!;
      expect(cd.sy).toBeInstanceOf(Uint8Array);
      expect(cd.idx).toBeInstanceOf(Uint16Array);
      expect(cd.value).toBeInstanceOf(Uint32Array);
      expect(Array.from(cd.sy)).toEqual(want.sy);
      expect(Array.from(cd.idx)).toEqual(want.idx);
      expect(Array.from(cd.value)).toEqual(want.value);
      // Fresh arrays that own their whole buffers (transferable, rulings R9), never shared between calls.
      const again = d.columnDiff(4, -2)!;
      for (const a of [cd.sy, cd.idx, cd.value]) expect(a.byteOffset === 0 && a.byteLength === a.buffer.byteLength).toBe(true);
      expect(again.sy).not.toBe(cd.sy);
      expect(again.sy.buffer).not.toBe(cd.sy.buffer);
      expect(again.idx.buffer).not.toBe(cd.idx.buffer);
      expect(again.value.buffer).not.toBe(cd.value.buffer);
      expect(d.columnDiff(4, -1)).toBeNull();
      expect(d.columnDiff(0, 0)).toBeNull();
    }
  });

  test('removing a column\'s last entry removes the column (`has` false, `columns()` without it, `size` 0)', () => {
    const d = createDiffStore();
    d.set(2, 3, 10, 50, val(5));
    d.set(2, 3, 11, 60, val(6));
    expect(d.has(2, 3)).toBe(true);
    expect([...d.columns()]).toEqual([colKey(2, 3)]);
    expect(d.size).toBe(2);
    d.remove(2, 3, 10, 50);
    // The column keeps its other section.
    expect(d.has(2, 3)).toBe(true);
    expect(Array.from(d.columnDiff(2, 3)!.sy)).toEqual([11]);
    d.remove(2, 3, 11, 60);
    expect(d.has(2, 3)).toBe(false);
    expect([...d.columns()]).toEqual([]);
    expect(d.size).toBe(0);
    expect(d.columnDiff(2, 3)).toBeNull();
    // An emptied section leaves nothing behind either: a later entry starts the column afresh.
    d.set(2, 3, 11, 61, val(4));
    expect(Array.from(d.columnDiff(2, 3)!.sy)).toEqual([11]);
    expect(Array.from(d.columnDiff(2, 3)!.idx)).toEqual([61]);
  });

  test('the store never drops entries on its own (1,000 sets over 30 columns: all retrievable)', () => {
    const d = createDiffStore();
    const at = (i: number): [cx: number, cz: number, sy: number, idx: number, value: number] => {
      const c = i % 30;
      return [(c % 6) - 3, Math.floor(c / 6) - 2, (i * 7) % 24, (i * 131) % 4096, val(1 + (i % 57), i % 16)];
    };
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const [cx, cz, sy, idx, value] = at(i);
      d.set(cx, cz, sy, idx, value);
      keys.add(`${cx},${cz},${sy},${idx}`);
    }
    expect(keys.size).toBe(1000);
    expect(d.size).toBe(1000);
    expect([...d.columns()].length).toBe(30);
    for (let i = 0; i < 1000; i++) {
      const [cx, cz, sy, idx, value] = at(i);
      expect(d.get(cx, cz, sy, idx)).toBe(value);
    }
    let total = 0;
    for (const key of d.columns()) total += d.columnDiff(colKeyCx(key), colKeyCz(key))!.value.length;
    expect(total).toBe(1000);
  });
});

import { describe, expect, test } from 'vitest';
import { chiSquareP, YMOD16_CLASSES, ymod16Test } from '../harness/stats';

/** A 16 × 6 table (row y mod 16, class 0 … 5+) from sparse [row, class, count] cells. */
function table(cells: ReadonlyArray<readonly [number, number, number]>): Float64Array {
  const t = new Float64Array(16 * YMOD16_CLASSES);
  for (const [r, k, n] of cells) t[YMOD16_CLASSES * r + k] = n;
  return t;
}

describe('chiSquareP', () => {
  test('matches the χ² table', () => {
    expect(chiSquareP(3.841458820694124, 1)).toBeCloseTo(0.05, 10);
    expect(chiSquareP(5.991464547107979, 2)).toBeCloseTo(0.05, 10);
    expect(chiSquareP(18.307038053275146, 10)).toBeCloseTo(0.05, 10);
    expect(chiSquareP(124.34211340400407, 100)).toBeCloseTo(0.05, 8);
    expect(chiSquareP(10.827566170662733, 1)).toBeCloseTo(0.001, 10);
    // df 2: p = exp(−χ²/2) exactly.
    expect(chiSquareP(100, 2) / Math.exp(-50)).toBeCloseTo(1, 10);
    expect(chiSquareP(0, 4)).toBe(1);
  });
});

describe('ymod16Test (SP3c spec §5.2 S1.ymod16)', () => {
  test('a hand-computed 2 × 2 table: empty rows dropped, empty classes merged toward 2', () => {
    // Rows 0 and 1; classes 2 and 3. E = 125, 75 in both rows; χ² = 2·(25²/125 + 25²/75) = 26.6̄.
    const r = ymod16Test(table([[0, 2, 100], [0, 3, 100], [1, 2, 150], [1, 3, 50]]));
    expect(r.classes).toEqual([2, 3]);
    expect(r.rows).toBe(2);
    expect(r.df).toBe(1);
    expect(r.n).toBe(400);
    expect(r.chi2).toBeCloseTo(80 / 3, 10);
    expect(r.p).toBeCloseTo(chiSquareP(80 / 3, 1), 15);
    expect(r.degenerate).toBe(false);
  });

  test('independent rows give χ² 0 and p 1', () => {
    const cells: Array<[number, number, number]> = [];
    for (let row = 0; row < 16; row++) for (let k = 0; k < 6; k++) cells.push([row, k, (row + 1) * (k + 1) * 10]);
    const r = ymod16Test(table(cells));
    expect(r.classes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.df).toBe(15 * 5);
    expect(r.chi2).toBeCloseTo(0, 9);
    expect(r.p).toBeCloseTo(1, 9);
  });

  test('merging repeats in the order 0, 1, 5+, 4, 3; merged classes keep the target name', () => {
    // 0 (10) → 1 (20) → 2; 5+ (30) → 4 (60) → 3 (160).
    const r = ymod16Test(table([[0, 0, 5], [1, 0, 5], [0, 1, 5], [1, 1, 5], [0, 2, 100], [1, 2, 100],
      [0, 3, 50], [1, 3, 50], [0, 4, 15], [1, 4, 15], [0, 5, 15], [1, 5, 15]]));
    expect(r.classes).toEqual([2, 3]);
    expect(r.n).toBe(380);
    // Class 0 ≥ 80 stays, class 1 < 80 merges into 2; 5+ ≥ 80 stays while 4 (< 80) merges into 3.
    const s = ymod16Test(table([[0, 0, 80], [1, 1, 79], [0, 2, 100], [1, 3, 80], [0, 4, 79], [1, 5, 80]]));
    expect(s.classes).toEqual([0, 2, 3, 5]);
    expect(s.df).toBe(3);
  });

  test('class 2 never merges; a single class left is a degenerate table', () => {
    const r = ymod16Test(table([[0, 2, 10], [1, 2, 10], [2, 1, 30]]));
    expect(r.classes).toEqual([2]);
    expect(r.degenerate).toBe(true);
    expect(Number.isNaN(r.p)).toBe(true);
  });
});

describe('ymod16Test: class 2 below 80 positions (it never merges)', () => {
  /** Rows 0 … 15 with `cells(row)` = [class, count] pairs. */
  const rows = (cells: (row: number) => ReadonlyArray<readonly [number, number]>) => {
    const out: Array<[number, number, number]> = [];
    for (let r = 0; r < 16; r++) for (const [k, n] of cells(r)) out.push([r, k, n]);
    return table(out);
  };

  test('an empty class 2 is not divided by: it absorbs its nearest remaining neighbour, so p and χ² stay finite', () => {
    // Class 2 has no position; classes 0, 3, 4 and 5+ have ≥ 80 each (stone tops and deep soil, a low depthMul's table).
    const t = rows((r) => [[0, 10 + (r % 3)], [3, 8], [4, 12 + (r % 2)], [5, 20]]);
    const r = ymod16Test(t);
    expect(r.degenerate).toBe(false);
    expect(Number.isFinite(r.chi2)).toBe(true);
    expect(Number.isFinite(r.p)).toBe(true);
    // Class 0 (the nearest remaining class below 2) is absorbed into 2 and keeps 2's name.
    expect(r.classes).toEqual([2, 3, 4, 5]);
    expect(r.df).toBe((16 - 1) * (r.classes.length - 1));
    // The same table with class 0 relabelled 2 gives the same test.
    const same = ymod16Test(rows((r) => [[2, 10 + (r % 3)], [3, 8], [4, 12 + (r % 2)], [5, 20]]));
    expect([r.chi2, r.p, r.df, r.n]).toEqual([same.chi2, same.p, same.df, same.n]);
    // Nothing remaining below 2: the nearest remaining class above (3) is absorbed.
    const above = ymod16Test(rows((r) => [[3, 8], [4, 12 + (r % 2)], [5, 20]]));
    expect(above.classes).toEqual([2, 4, 5]);
    expect(Number.isFinite(above.p)).toBe(true);
    expect(above.df).toBe(15 * 2);
  });

  test('a tiny class 2 (1-5 positions) also absorbs a neighbour: no column with tiny expected counts gives a spurious p', () => {
    // Class 2's 5 positions all sit in row 0: as their own column they gave χ² 71.3 over df 45, p 0.0075 (a false banding).
    const t = rows((r) => [[1, 30], [2, r === 0 ? 5 : 0], [3, 30], [4, 30]]);
    const r = ymod16Test(t);
    expect(r.classes).toEqual([2, 3, 4]);
    expect(r.df).toBe(15 * 2);
    expect(r.p).toBeGreaterThan(0.5);
    // Absorbing stops once class 2 has 80: class 1 (480) is enough, class 3 stays.
    expect(r.n).toBe(5 + 3 * 480);
  });

  test('class 2 below 80 with nothing left to absorb is a degenerate table', () => {
    const r = ymod16Test(rows((r) => (r < 2 ? [[2, 3]] : [])));
    expect(r.classes).toEqual([2]);
    expect(r.degenerate).toBe(true);
  });
});

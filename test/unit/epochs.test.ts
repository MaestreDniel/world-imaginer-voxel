import { describe, expect, test } from 'vitest';
import { attachEpochCells, createEpochCells, EPOCH_CELL, EPOCH_CELL_COUNT } from '../../src/world/store/epochs';

test('one cell per pipeline phase (SP3a spec §3.4)', () => {
  expect(EPOCH_CELL).toEqual({ terrain: 0, decorate: 1, light: 2, mesh: 3 });
  expect(EPOCH_CELL_COUNT).toBe(4);
});

describe.each([true, false])('shared %s', (shared) => {
  test('the buffer is of the requested kind and every cell starts at 0', () => {
    const e = createEpochCells(shared);
    expect(e.buffer instanceof SharedArrayBuffer).toBe(shared);
    expect(e.buffer.byteLength).toBe(4 * EPOCH_CELL_COUNT);
    for (let c = 0; c < EPOCH_CELL_COUNT; c++) expect(e.get(c)).toBe(0);
  });

  test('set, get and bump per scope; scopes are independent', () => {
    const e = createEpochCells(shared);
    e.set(EPOCH_CELL.light, 7);
    expect(e.get(EPOCH_CELL.light)).toBe(7);
    expect(e.bump(EPOCH_CELL.light)).toBe(8);
    expect(e.bump(EPOCH_CELL.mesh)).toBe(1);
    expect(e.get(EPOCH_CELL.terrain)).toBe(0);
    expect(e.get(EPOCH_CELL.decorate)).toBe(0);
    expect(e.get(EPOCH_CELL.mesh)).toBe(1);
    expect(e.get(EPOCH_CELL.light)).toBe(8);
  });

  test('an unknown cell is refused', () => {
    const e = createEpochCells(shared);
    expect(() => e.get(4)).toThrow(RangeError);
    expect(() => e.set(-1, 0)).toThrow(RangeError);
    expect(() => e.bump(1.5)).toThrow(RangeError);
  });

  test('attachEpochCells over the same buffer sees the same cells', () => {
    const e = createEpochCells(shared);
    const f = attachEpochCells(e.buffer);
    e.set(EPOCH_CELL.decorate, 3);
    expect(f.get(EPOCH_CELL.decorate)).toBe(3);
    f.bump(EPOCH_CELL.terrain);
    expect(e.get(EPOCH_CELL.terrain)).toBe(1);
  });
});

test('attachEpochCells refuses a buffer of another size', () => {
  expect(() => attachEpochCells(new ArrayBuffer(8))).toThrow(RangeError);
});

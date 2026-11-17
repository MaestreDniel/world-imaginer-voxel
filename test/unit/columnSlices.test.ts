/**
 * The column slices of the scattered metrics (SP6b spec §13 Stage 2 item 1; the user's ruling U15): `METRICS_SLICE`'s
 * forms, the draws a slice keeps, and the records a slice run writes and the merge run reads (exact numbers, every
 * Float64Array, the run's constants checked). The slices' sums on real columns are pinned beside the threaded scatters
 * (`terrainScatter.test.ts`, `surfaceScatter.test.ts`).
 */
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { columnSlice, readSlices, sliceOf, writeSlice } from '../harness/columnSlices';

describe('METRICS_SLICE (columnSlice)', () => {
  test('absent is the whole run; k/n a slice; merge/n the merge run', () => {
    expect(columnSlice(undefined)).toBeNull();
    expect(columnSlice('0/2')).toEqual({ kind: 'slice', k: 0, n: 2 });
    expect(columnSlice('1/2')).toEqual({ kind: 'slice', k: 1, n: 2 });
    expect(columnSlice('2/3')).toEqual({ kind: 'slice', k: 2, n: 3 });
    expect(columnSlice('merge/2')).toEqual({ kind: 'merge', n: 2 });
  });

  test.each(['', '2/2', '0/1', 'merge/1', 'merge', '1', 'a/2', '-1/2', '0/2 ', '0.5/2', '0/2/3'])('%j throws', (raw) => {
    expect(() => columnSlice(raw)).toThrow(`METRICS_SLICE '${raw}' (k/n with 0 ≤ k < n and n ≥ 2, or merge/n)`);
  });
});

describe('sliceOf: slice k keeps draws k, k + n, k + 2n, … of the unchanged list', () => {
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  test('two slices', () => {
    expect(sliceOf(list, { k: 0, n: 2 })).toEqual(['a', 'c', 'e', 'g']);
    expect(sliceOf(list, { k: 1, n: 2 })).toEqual(['b', 'd', 'f']);
  });

  test('the n slices partition the list: every draw in exactly one slice', () => {
    for (const n of [2, 3, 4, 8]) {
      const all = Array.from({ length: n }, (_, k) => sliceOf(list, { k, n })).flat();
      expect(all.sort(), `n = ${n}`).toEqual(list);
    }
  });
});

describe('writeSlice and readSlices: the records a slice run writes and the merge run reads', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const meta = { tier: 'quick', profiles: ['large_biomes'], seeds: ['42'], columns: { large_biomes: 32768 } };
  /** Numbers JSON alone would not carry (non-integers, ±Infinity, NaN, −0 aside), Float64Arrays nested in records and lists. */
  const data = (k: number): unknown => ({
    count: 1000 + k,
    sd: Math.PI * (k + 1) / 3,
    minFloor: k === 0 ? Infinity : -63,
    low: -Infinity,
    hist: Float64Array.from([0, 1.5, 2 ** 53 - 1, k]),
    t5: [3, 1, 2.25],
    perSeed: [{ inside: new Float64Array([k, 0, 7]) }],
    gap: NaN,
  });

  test('a record comes back as written: every number exact, every Float64Array a Float64Array; in slice order', () => {
    dir = mkdtempSync(join(tmpdir(), 'columnSlices-'));
    const files = [1, 0].map((k) => writeSlice('terrain-quick-large_biomes', { k, n: 2 }, meta, data(k), dir));
    expect(files.map((f) => f.slice(dir.length + 1))).toEqual(['terrain-quick-large_biomes.1of2.json', 'terrain-quick-large_biomes.0of2.json']);
    const back = readSlices('terrain-quick-large_biomes', 2, meta, dir);
    expect(back).toEqual([data(0), data(1)]);
    const first = back[0] as { hist: unknown; perSeed: Array<{ inside: unknown }>; sd: number; minFloor: number; gap: number };
    expect(first.hist).toBeInstanceOf(Float64Array);
    expect(first.perSeed[0]!.inside).toBeInstanceOf(Float64Array);
    expect(first.sd).toBe(Math.PI / 3);
    expect(first.minFloor).toBe(Infinity);
    expect(first.gap).toBeNaN();
  });

  test('a missing slice, a record of another run (its constants) and a record under another slice\'s name are refused', () => {
    dir = mkdtempSync(join(tmpdir(), 'columnSlices-'));
    writeSlice('surface-quick-large_biomes', { k: 0, n: 2 }, meta, data(0), dir);
    expect(() => readSlices('surface-quick-large_biomes', 2, meta, dir))
      .toThrow(/readSlices surface-quick-large_biomes: no record of slice 1\/2 \(.*surface-quick-large_biomes\.1of2\.json\)/);
    writeSlice('surface-quick-large_biomes', { k: 1, n: 2 }, { ...meta, seeds: ['42', '1'] }, data(1), dir);
    expect(() => readSlices('surface-quick-large_biomes', 2, meta, dir))
      .toThrow('readSlices surface-quick-large_biomes: slice 1/2 was written by another run');
    writeSlice('surface-quick-large_biomes', { k: 0, n: 2 }, meta, data(1), dir);
    renameSync(join(dir, 'surface-quick-large_biomes.0of2.json'), join(dir, 'surface-quick-large_biomes.1of2.json'));
    writeSlice('surface-quick-large_biomes', { k: 0, n: 2 }, meta, data(0), dir);
    expect(() => readSlices('surface-quick-large_biomes', 2, meta, dir))
      .toThrow('readSlices surface-quick-large_biomes: the record of slice 1/2 says it is slice 0/2');
  });
});

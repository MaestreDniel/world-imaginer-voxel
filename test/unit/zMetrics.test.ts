import { describe, expect, test } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { waterRaster } from '../../src/metrics/columnStats';
import { components } from '../harness/flood';
import { ctxFor } from '../harness/gen';
import {
  componentKm2, groundRun, islandCount, islandRuns, islandsPer100km2, landComponents, positionColumn, sizeClasses, solidRuns,
} from '../harness/zMetrics';

/** Z3's island-run threshold (Task 17 passes `ISLAND_RUN_MIN_BOTTOM`, 181). */
const MIN_BOTTOM = 181;

/** A 384-entry column (index y + 64) solid on each inclusive [y0, y1] range. */
function column(...ranges: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const c = new Uint8Array(384);
  for (const [y0, y1] of ranges) for (let y = y0; y <= y1; y++) c[y + 64] = 1;
  return c;
}

/** A row-major n × n mask from rows of '1' (set) and anything else (clear). */
function mask(rows: readonly string[]): { m: Uint8Array; n: number } {
  const n = rows.length;
  const m = new Uint8Array(n * n);
  rows.forEach((r, j) => [...r].forEach((ch, i) => { m[j * n + i] = ch === '1' ? 1 : 0; }));
  return { m, n };
}

describe('island runs', () => {
  test('solid runs bottom to top, the world top closes a run', () => {
    expect(solidRuns(column([-64, 40], [100, 100], [300, 319]))).toEqual([
      { bottom: -64, top: 40 }, { bottom: 100, top: 100 }, { bottom: 300, top: 319 },
    ]);
    expect(solidRuns(new Uint8Array(384))).toEqual([]);
  });

  test('ground and sea air below an island: one island run, the ground is not one', () => {
    const c = column([-64, 40], [200, 230]);
    expect(islandRuns(c, MIN_BOTTOM)).toEqual([{ bottom: 200, top: 230 }]);
    expect(groundRun(c, MIN_BOTTOM)).toEqual({ bottom: -64, top: 40 });
  });

  test('a stacked island: two island runs, bottom to top', () => {
    const c = column([-64, 70], [195, 210], [240, 262]);
    expect(islandRuns(c, MIN_BOTTOM)).toEqual([{ bottom: 195, top: 210 }, { bottom: 240, top: 262 }]);
    expect(groundRun(c, MIN_BOTTOM)).toEqual({ bottom: -64, top: 70 });
  });

  test('an overhang lip reaching above 181 from below is not an island run', () => {
    const lip = column([-64, 150], [170, 200]);
    expect(islandRuns(lip, MIN_BOTTOM)).toEqual([]);
    expect(groundRun(lip, MIN_BOTTOM)).toEqual({ bottom: 170, top: 200 });
  });

  test('the threshold is inclusive: bottom 181 is an island, 180 is not', () => {
    expect(islandRuns(column([-64, 0], [181, 190]), MIN_BOTTOM)).toEqual([{ bottom: 181, top: 190 }]);
    expect(islandRuns(column([-64, 0], [180, 190]), MIN_BOTTOM)).toEqual([]);
    expect(groundRun(column([181, 190]), MIN_BOTTOM)).toBeNull();
  });

  test('positionColumn reads a position out of the chunk solidity layout ((y + 64) << 8) | p', () => {
    const solid = new Uint8Array(384 * 256);
    const p = (5 << 4) | 9;
    for (const y of [-64, 0, 200, 319]) solid[((y + 64) << 8) | p] = 1;
    solid[((10 + 64) << 8) | (p + 1)] = 1;
    const c = positionColumn(solid, p);
    expect(solidRuns(c)).toEqual([
      { bottom: -64, top: -64 }, { bottom: 0, top: 0 }, { bottom: 200, top: 200 }, { bottom: 319, top: 319 },
    ]);
    const reused = new Uint8Array(384).fill(1);
    expect(positionColumn(solid, p + 1, reused)).toBe(reused);
    expect(solidRuns(reused)).toEqual([{ bottom: 10, top: 10 }]);
  });
});

describe('components connectivity', () => {
  test('a diagonal one-cell strait: 2 components at 4, 1 at 8', () => {
    const { m, n } = mask(['11..', '11..', '..11', '..11']);
    expect(components(m, n, 4).count).toBe(2);
    expect(components(m, n, 8).count).toBe(1);
    expect(components(m, n).count).toBe(1);
    const c4 = landComponents(m, n, 4);
    expect(Array.from(c4.size).slice(1)).toEqual([4, 4]);
    expect(Array.from(c4.bbox.slice(4, 12))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  test('4-connectivity on the fixture of flood.test.ts (no corner-only contact: same components)', () => {
    const { m, n } = mask(['1100.', '0.0..', '...11', '1...1', '.....']);
    expect(components(m, n).count).toBe(3);
    const c = components(m, n, 4);
    expect(c.count).toBe(3);
    expect(Array.from(c.size).slice(1)).toEqual([2, 3, 1]);
  });

  test('a ring and a hook touching at a corner: 2 components at 4, 1 at 8', () => {
    const { m, n } = mask(['111..', '1.1..', '111.1', '...11', '....1']);
    const c = components(m, n, 4);
    expect(c.count).toBe(2);
    expect(Array.from(c.size).slice(1)).toEqual([8, 4]);
    expect(components(m, n, 8).count).toBe(1);
  });

  test('another connectivity throws', () => {
    expect(() => components(new Uint8Array(4), 2, 6 as 4)).toThrow('components: connectivity 6 is not 4 or 8');
  });

  // B2's river and B5's lake masks as water.metric.ts builds them (seed '1', origin (−2048, −2048), 128² at step 8):
  // the default and an explicit 8 equal the labelling pinned before the connectivity argument existed.
  test('the default is 8 and unchanged on B2/B5 raster masks', () => {
    const n = 128;
    const r = waterRaster(ctxFor('1'), -2048, -2048, n, 8);
    const wet = new Uint8Array(n * n);
    for (let k = 0; k < n * n; k++) if (r.river[k] === 1) wet[k] = 1;
    const pins = [[wet, 61, 391, 87, 2706060502, 2369692826], [r.lakeInside, 1, 181, 181, 1090730656, 1529077440]] as const;
    for (const [m, count, cells, largest, labelHash, bboxHash] of pins) {
      const d = components(m, n);
      expect(components(m, n, 8)).toEqual(d);
      const sizes = Array.from(d.size).slice(1);
      expect([d.count, sizes.reduce((a, b) => a + b, 0), Math.max(...sizes)]).toEqual([count, cells, largest]);
      expect(fnv1a32(Array.from(d.label).join(','))).toBe(labelHash);
      expect(fnv1a32(Array.from(d.bbox).join(','))).toBe(bboxHash);
    }
  });
});

describe('islands per 100 km² and size classes', () => {
  test('border flags from the bounding boxes', () => {
    const { m, n } = mask(['1....', '.....', '..1..', '.....', '...11']);
    const c = landComponents(m, n, 4);
    expect(c.count).toBe(3);
    expect(Array.from(c.border).slice(1)).toEqual([1, 0, 1]);
  });

  test('a border-clipped island counts when its clipped area qualifies', () => {
    // At step 64, 1 km² = 244.140625 cells: a 15 × 17 = 255-cell island clipped by the west border (1.044 km²)
    // counts; a 15 × 16 = 240-cell one inside (0.983 km²) does not.
    const n = 40;
    const m = new Uint8Array(n * n);
    for (let j = 0; j < 17; j++) for (let i = 0; i < 15; i++) m[(j + 2) * n + i] = 1;
    for (let j = 0; j < 16; j++) for (let i = 0; i < 15; i++) m[(j + 22) * n + (i + 20)] = 1;
    const c = landComponents(m, n, 4);
    expect(c.count).toBe(2);
    expect(Array.from(c.border).slice(1)).toEqual([1, 0]);
    expect(componentKm2(c, 1, 64)).toBeCloseTo(1.04448, 5);
    expect(componentKm2(c, 2, 64)).toBeCloseTo(0.98304, 5);
    expect(islandCount(c, 64)).toBe(1);
    // 40² cells at step 64 = 6.5536 km²: one island per 0.065536 · 100 km².
    expect(islandsPer100km2(c, n, 64)).toBeCloseTo(100 / 6.5536, 9);
    // A whole raster of land touching every border is one island by its clipped area.
    const all = landComponents(new Uint8Array(n * n).fill(1), n, 4);
    expect(Array.from(all.border).slice(1)).toEqual([1]);
    expect(islandCount(all, 64)).toBe(1);
  });

  test('exactly 1 km² qualifies (n_cells · step² ≥ 10⁶)', () => {
    // At step 50 a 20 × 20 = 400-cell island is exactly 10⁶ block²; 399 cells are not.
    const n = 30;
    const m = new Uint8Array(n * n);
    for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) m[(j + 5) * n + i + 5] = 1;
    expect(islandCount(landComponents(m, n, 4), 50)).toBe(1);
    m[5 * n + 5] = 0;
    expect(islandCount(landComponents(m, n, 4), 50)).toBe(0);
  });

  test('size classes on constructed areas, each edge in the upper class', () => {
    // Strips of 1, 4, 5, 24, 25, 99, 100 and 150 cells on every other row: at step 1000 a cell is 1 km², at step 500
    // 0.25 km² (areas 0.25, 1, 1.25, 6, 6.25, 24.75, 25, 37.5).
    const cells = [1, 4, 5, 24, 25, 99, 100, 150];
    const n = 300;
    const m = new Uint8Array(n * n);
    cells.forEach((a, row) => { for (let i = 0; i < a; i++) m[2 * row * n + i] = 1; });
    const c = landComponents(m, n, 4);
    expect(sizeClasses(c, 1000)).toEqual({ lt1: 0, '1to5': 2, '5to25': 2, '25to100': 2, ge100: 2 });
    expect(sizeClasses(c, 500)).toEqual({ lt1: 1, '1to5': 2, '5to25': 3, '25to100': 2, ge100: 0 });
    expect(Object.keys(sizeClasses(c, 1))).toEqual(['lt1', '1to5', '5to25', '25to100', 'ge100']);
  });
});

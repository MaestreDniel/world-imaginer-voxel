import { describe, expect, test } from 'vitest';
import { BOX_BIOMES, type BoxBiome } from '../../src/core/params/biomeDefaults';
import { DEFAULTS } from '../../src/core/params/defaults';
import { q15 } from '../../src/core/params/canonical';
import { applyPatch, BOX_AXES, type BoxTable, type Interval, type Issue } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { JobCancelled, type WorkerPool } from '../../src/engine/workerPool';
import { biomeFamily, biomeId, SURFACE_BIOMES, type SurfaceBiome } from '../../src/gen/biomes/registry';
import { LAYERS } from '../../src/gen/map/layers';
import { BIOME_SHARES_POINTS, biomeSharesLength, summarizeBiomeShares, type BiomeShareSummary } from '../../src/metrics/biomeShares';
import {
  barFraction, barValue, BIOME_TABLE_PATH, countText, createShareRequests, dragAxisEnd, HIGHLIGHT_NOTICE, hitBarEnd, intervalText, modifiedRows, resetRow,
  rowChanges, rowHover, rowIssueText, setAxis, setAxisText, setPriority, setPriorityText, setWSign, SHARE_LIMITS, shareChart, shareScale,
  sharesStatus, shareText, sharesView, shareWarnings, swatchColor, TABLE_FAMILIES, tableRows, type ShareWarning, type TableEdit,
} from '../../src/ui/biomeTable/model';
import type { StatsArgs, StatsKind } from '../../src/workers/protocol';
import { testRng } from '../harness/stats';
import { THRESHOLDS } from '../thresholds';

/** Deep-frozen: an edit that mutated its input would throw. */
const T = DEFAULTS.biomes.table;
const GAP = 1 / 1024;
const names = (rows: readonly { readonly name: string }[]) => rows.map((r) => r.name);
/** The page writes the table whole with session.set('biomes.table', table), which validates it like this. */
const valid = (t: BoxTable<BoxBiome>) => applyPatch(SCHEMA, DEFAULTS, { biomes: { table: t } }).ok;
const text = (r: TableEdit) => (r.ok ? 'ok' : `${r.issue.code} @ ${r.issue.path}: ${r.issue.message}`);
const table = (r: TableEdit): BoxTable<BoxBiome> => {
  if (!r.ok) throw new Error(text(r));
  return r.table;
};

describe('biome table rows', () => {
  test('one row per box biome with its id, family and row, in priority order', () => {
    expect(BIOME_TABLE_PATH).toBe('biomes.table');
    const rows = tableRows(T, 'priority', null);
    expect(names(rows)).toEqual([...BOX_BIOMES]);
    for (const r of rows) {
      expect(r.biome).toBe(biomeId(r.name));
      expect(r.family).toBe(biomeFamily(r.biome));
      expect(r.row).toBe(T[r.name]);
    }
  });
  test('sorts by name', () => {
    expect(names(tableRows(T, 'name', null))).toEqual([...BOX_BIOMES].sort());
  });
  test('sorts by family in table order, then by priority', () => {
    expect(TABLE_FAMILIES).toEqual(['ocean', 'coast', 'lowland', 'highland']);
    expect(tableRows(T, 'family', null).map((r) => r.family)).toEqual([
      ...Array<string>(4).fill('ocean'), ...Array<string>(3).fill('coast'), ...Array<string>(12).fill('lowland'), ...Array<string>(7).fill('highland'),
    ]);
    const t = table(setPriority(T, 'deep_ocean', 500));
    expect(names(tableRows(t, 'family', null)).slice(0, 5)).toEqual(['ocean', 'warm_ocean', 'frozen_ocean', 'deep_ocean', 'beach']);
    expect(names(tableRows(t, 'priority', null)).at(-1)).toBe('deep_ocean');
  });
  test('filters by family', () => {
    expect(names(tableRows(T, 'priority', 'highland'))).toEqual(['badlands', 'windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano']);
    expect(names(tableRows(T, 'name', 'coast'))).toEqual(['beach', 'snowy_beach', 'stony_shore']);
    expect(tableRows(T, 'priority', 'river')).toEqual([]);
  });
});

describe('interval edits', () => {
  test('setAxis writes a typed interval, normalised, and keeps the other rows', () => {
    const t = table(setAxis(T, 'plains', 'C', 0.1 + 0.2, 0.9));
    expect(t.plains.C).toEqual([0.3, 0.9]);
    expect(t.plains.E).toBe(T.plains.E);
    expect(t.meadow).toBe(T.meadow);
    expect(T.plains.C).toEqual([-0.04, 1]);
    expect(valid(t)).toBe(true);
  });
  test('setAxis with the current interval returns the same table', () => {
    expect(table(setAxis(T, 'plains', 'C', -0.04, 1))).toBe(T);
  });
  test.each<[string, number, number, string]>([
    ['lo above hi', 0.5, 0.1, 'BAD_INTERVAL @ biomes.table.plains.C: lo 0.5 must be below hi 0.1'],
    ['lo equal to hi', 0.2, 0.2, 'BAD_INTERVAL @ biomes.table.plains.C: lo 0.2 must be below hi 0.2'],
    ['lo equal to hi after q15', 0.3, 0.1 + 0.2, 'BAD_INTERVAL @ biomes.table.plains.C: lo 0.3 must be below hi 0.3'],
    ['lo below -1', -2, 0, 'OUT_OF_RANGE @ biomes.table.plains.C[0]: -2 outside [-1, 1]'],
    ['hi not finite', 0, Number.NaN, 'NOT_FINITE @ biomes.table.plains.C[1]: expected a finite number, got NaN'],
  ])('setAxis refuses %s on the edited cell', (_name, lo, hi, expected) => {
    expect(text(setAxis(T, 'plains', 'C', lo, hi))).toBe(expected);
  });
  test('dragAxisEnd clamps lo to [-1, hi - 2^-10] and hi to [lo + 2^-10, 1]', () => {
    expect(dragAxisEnd(T, 'plains', 'C', 'lo', 0.5).plains.C).toEqual([0.5, 1]);
    expect(dragAxisEnd(T, 'plains', 'C', 'lo', 3).plains.C).toEqual([1 - GAP, 1]);
    expect(dragAxisEnd(T, 'plains', 'C', 'lo', -3).plains.C).toEqual([-1, 1]);
    expect(dragAxisEnd(T, 'plains', 'C', 'hi', -0.5).plains.C).toEqual([-0.04, -0.0390234375]);
    expect(dragAxisEnd(T, 'plains', 'C', 'hi', 0.25).plains.C).toEqual([-0.04, 0.25]);
    expect(dragAxisEnd(T, 'plains', 'PV', 'hi', Number.POSITIVE_INFINITY).plains.PV).toEqual([-1, 1]);
    expect(dragAxisEnd(T, 'plains', 'C', 'lo', 0.1 + 0.2).plains.C).toEqual([0.3, 1]);
    const t = dragAxisEnd(T, 'plains', 'C', 'lo', 0.5);
    expect(t.plains.E).toBe(T.plains.E);
    expect(t.meadow).toBe(T.meadow);
    expect(T.plains.C).toEqual([-0.04, 1]);
  });
  test('dragAxisEnd returns the same table when nothing changes or the value is NaN', () => {
    expect(dragAxisEnd(T, 'plains', 'C', 'lo', -0.04)).toBe(T);
    expect(dragAxisEnd(T, 'plains', 'C', 'hi', 5)).toBe(T);
    expect(dragAxisEnd(T, 'plains', 'C', 'lo', Number.NaN)).toBe(T);
  });
  test('random bar drags never produce an invalid table', () => {
    const next = testRng(11);
    const u = () => next() / 4294967296;
    let t = T;
    let invalid = 0;
    for (let i = 0; i < 2000; i++) {
      const name = BOX_BIOMES[next() % BOX_BIOMES.length]!;
      const axis = BOX_AXES[next() % BOX_AXES.length]!;
      const k = next() % 8;
      const value = k === 0 ? Number.POSITIVE_INFINITY : k === 1 ? Number.NEGATIVE_INFINITY
        : k === 2 ? t[name][axis][next() % 2]! + (u() - 0.5) * 0.004 : u() * 6 - 3;
      t = dragAxisEnd(t, name, axis, next() % 2 === 0 ? 'lo' : 'hi', value);
      if (!valid(t)) invalid++;
    }
    expect(invalid).toBe(0);
    expect(t).not.toEqual(T);
  });
});

describe('sign and priority edits', () => {
  test('setWSign sets the filter and returns the same table when unchanged', () => {
    const t = setWSign(T, 'forest', 1);
    expect(t.forest.wSign).toBe(1);
    expect(T.forest.wSign).toBe(-1);
    expect(valid(t)).toBe(true);
    expect(setWSign(T, 'forest', -1)).toBe(T);
    expect(setWSign(T, 'plains', -0 as 0)).toBe(T);
    expect(Object.is(setWSign(T, 'forest', -0 as 0).forest.wSign, 0)).toBe(true);
  });
  test('setPriority writes a free priority and returns the same table when unchanged', () => {
    const t = table(setPriority(T, 'plains', 500));
    expect(t.plains.priority).toBe(500);
    expect(valid(t)).toBe(true);
    expect(table(setPriority(T, 'plains', 8))).toBe(T);
  });
  test.each<[BoxBiome, number, string]>([
    ['plains', 1, 'DUPLICATE_PRIORITY @ biomes.table.plains.priority: priority 1 is also used by deep_ocean'],
    ['deep_ocean', 26, 'DUPLICATE_PRIORITY @ biomes.table.deep_ocean.priority: priority 26 is also used by volcano'],
    ['plains', 8.5, 'NOT_INTEGER @ biomes.table.plains.priority: expected an integer, got 8.5'],
    ['plains', 0, 'OUT_OF_RANGE @ biomes.table.plains.priority: 0 outside [1, 1000]'],
    ['plains', 1001, 'OUT_OF_RANGE @ biomes.table.plains.priority: 1001 outside [1, 1000]'],
    ['plains', Number.NaN, 'NOT_FINITE @ biomes.table.plains.priority: expected a finite number, got NaN'],
  ])('setPriority(%s, %s) is refused on the edited row', (name, priority, expected) => {
    expect(text(setPriority(T, name, priority))).toBe(expected);
  });
  test('a duplicate is reported on the edited row, where the validator blames the later row', () => {
    const raw = { ...T, deep_ocean: { ...T.deep_ocean, priority: 26 } };
    const v = applyPatch(SCHEMA, DEFAULTS, { biomes: { table: raw } });
    expect(v.ok ? [] : v.issues.map((i) => `${i.path}: ${i.message}`)).toEqual(['biomes.table.volcano.priority: priority 26 is also used by deep_ocean']);
    expect(text(setPriority(T, 'deep_ocean', 26))).toBe('DUPLICATE_PRIORITY @ biomes.table.deep_ocean.priority: priority 26 is also used by volcano');
  });
  test('two priorities swap through a free value', () => {
    let t = table(setPriority(T, 'plains', 100));
    t = table(setPriority(t, 'meadow', 8));
    t = table(setPriority(t, 'plains', 9));
    expect(valid(t)).toBe(true);
    expect(names(tableRows(t, 'priority', 'lowland')).slice(0, 2)).toEqual(['meadow', 'plains']);
  });
});

describe('row reset', () => {
  test('resetRow restores the profile row and keeps the other rows', () => {
    let t = dragAxisEnd(T, 'plains', 'C', 'lo', 0.5);
    t = setWSign(t, 'plains', 1);
    t = dragAxisEnd(t, 'meadow', 'H', 'hi', 0);
    const back = table(resetRow(t, T, 'plains'));
    expect(back.plains).toBe(T.plains);
    expect(back.meadow.H).toEqual([-1, 0]);
    expect(valid(back)).toBe(true);
    expect(table(resetRow(T, T, 'plains'))).toBe(T);
  });
  test('resetRow is refused when another row now holds the profile priority', () => {
    let t = table(setPriority(T, 'plains', 100));
    t = table(setPriority(t, 'meadow', 8));
    expect(text(resetRow(t, T, 'plains'))).toBe('DUPLICATE_PRIORITY @ biomes.table.plains.priority: priority 8 is also used by meadow');
  });
});

describe('typed cells, bars, row issues and the map highlight (Task 19)', () => {
  const refused = (r: TableEdit): Issue => {
    if (r.ok) throw new Error('expected a refusal');
    return r.issue;
  };
  test('intervalText reads back as the same interval in every cell of the default table', () => {
    expect(intervalText([-0.04, 1])).toBe('-0.04, 1');
    expect(intervalText([-0.0390234375, 0.25])).toBe('-0.0390234375, 0.25');
    for (const name of BOX_BIOMES) {
      for (const axis of BOX_AXES) expect(table(setAxisText(T, name, axis, intervalText(T[name][axis])))).toBe(T);
    }
  });
  test.each([['0.3, 0.9'], ['[0.3, 0.9]'], ['0.3;0.9'], ['  0.3   0.9 '], ['[ 0.3 ,0.9 ]'], ['0.30, .9']])(
    'setAxisText reads %j as [0.3, 0.9] and keeps the other rows',
    (s) => {
      const t = table(setAxisText(T, 'plains', 'C', s));
      expect(t.plains.C).toEqual([0.3, 0.9]);
      expect(t.plains.E).toBe(T.plains.E);
      expect(t.meadow).toBe(T.meadow);
      expect(valid(t)).toBe(true);
    },
  );
  test('setAxisText normalises like setAxis', () => {
    expect(table(setAxisText(T, 'plains', 'C', `${0.1 + 0.2}, 0.9`)).plains.C).toEqual([0.3, 0.9]);
  });
  test.each<[string, string]>([
    ['', 'BAD_INTERVAL @ biomes.table.plains.C: expected "lo, hi", got ""'],
    ['0.5', 'BAD_INTERVAL @ biomes.table.plains.C: expected "lo, hi", got "0.5"'],
    [' 0, 0.5, 1 ', 'BAD_INTERVAL @ biomes.table.plains.C: expected "lo, hi", got "0, 0.5, 1"'],
    ['abc, 1', 'NOT_NUMBER @ biomes.table.plains.C[0]: expected a number, got "abc"'],
    ['0,', 'NOT_NUMBER @ biomes.table.plains.C[1]: expected a number, got ""'],
    ['0, 1e999', 'NOT_FINITE @ biomes.table.plains.C[1]: expected a finite number, got Infinity'],
    ['0.5, 0.1', 'BAD_INTERVAL @ biomes.table.plains.C: lo 0.5 must be below hi 0.1'],
    ['-2, 0', 'OUT_OF_RANGE @ biomes.table.plains.C[0]: -2 outside [-1, 1]'],
  ])('setAxisText refuses %j on the edited cell', (s, expected) => {
    expect(text(setAxisText(T, 'plains', 'C', s))).toBe(expected);
  });
  test.each<[string, string]>([
    ['100', 'ok'],
    [' 1e3 ', 'ok'],
    [' 9 ', 'DUPLICATE_PRIORITY @ biomes.table.plains.priority: priority 9 is also used by meadow'],
    ['abc', 'NOT_NUMBER @ biomes.table.plains.priority: expected a number, got "abc"'],
    ['', 'NOT_NUMBER @ biomes.table.plains.priority: expected a number, got ""'],
    ['8.5', 'NOT_INTEGER @ biomes.table.plains.priority: expected an integer, got 8.5'],
    ['0', 'OUT_OF_RANGE @ biomes.table.plains.priority: 0 outside [1, 1000]'],
  ])('setPriorityText(%j) on plains: %s', (s, expected) => {
    expect(text(setPriorityText(T, 'plains', s))).toBe(expected);
  });
  test('setPriorityText writes the number and returns the same table for the row\'s own priority', () => {
    expect(table(setPriorityText(T, 'plains', '100')).plains.priority).toBe(100);
    expect(table(setPriorityText(T, 'plains', ' 1e3')).plains.priority).toBe(1000);
    expect(table(setPriorityText(T, 'plains', '8'))).toBe(T);
  });
  test('rowChanges names the cells that differ from the profile row, modifiedRows the rows', () => {
    expect(rowChanges(T.plains, T.plains)).toEqual([]);
    let t = dragAxisEnd(T, 'plains', 'C', 'lo', 0.5);
    t = dragAxisEnd(t, 'plains', 'H', 'hi', 0.5);
    t = setWSign(t, 'plains', 1);
    t = table(setPriority(t, 'meadow', 100));
    expect(rowChanges(t.plains, T.plains)).toEqual(['C', 'H', 'wSign']);
    expect(rowChanges(t.meadow, T.meadow)).toEqual(['priority']);
    expect(modifiedRows(t, T)).toEqual(['plains', 'meadow']);
    expect(modifiedRows(T, T)).toEqual([]);
    t = table(setAxisText(t, 'plains', 'C', '-0.04, 1'));
    expect(rowChanges(t.plains, T.plains)).toEqual(['H', 'wSign']);
  });
  test('bars span [-1, 1]; a pointer gives a value on the 0.01 grid, not clamped (dragAxisEnd clamps)', () => {
    expect([barFraction(-1), barFraction(-0.5), barFraction(0), barFraction(1)]).toEqual([0, 0.25, 0.5, 1]);
    expect(barValue(0, 200)).toBe(-1);
    expect(barValue(200, 200)).toBe(1);
    expect(barValue(127, 200)).toBe(0.27);
    expect(barValue(127.4, 200)).toBe(0.27);
    expect(barValue(-20, 200)).toBe(-1.2);
    expect(barValue(230, 200)).toBe(1.3);
    expect(Object.is(barValue(99.9, 200), 0)).toBe(true);
    expect(barValue(50, 0)).toBeNaN();
    for (let px = 0; px <= 317; px++) {
      const v = barValue(px, 317);
      expect(q15(v)).toBe(v);
      expect(Math.round(v * 100) / 100).toBe(v);
    }
    expect(dragAxisEnd(T, 'plains', 'T', 'hi', barValue(127, 200)).plains.T).toEqual([-0.2, 0.27]);
    expect(dragAxisEnd(T, 'plains', 'T', 'hi', barValue(-20, 200)).plains.T).toEqual([-0.2, -0.2 + GAP]);
  });
  test('hitBarEnd grabs the nearer end within the slack (ties to hi) and nothing elsewhere', () => {
    const iv: Interval = [-0.5, 1]; // on 200 px: lo at 50, hi at 200
    expect(hitBarEnd(iv, 52, 200, 6)).toBe('lo');
    expect(hitBarEnd(iv, 45, 200, 6)).toBe('lo');
    expect(hitBarEnd(iv, 44, 200, 6)).toBe('lo');
    expect(hitBarEnd(iv, 43, 200, 6)).toBeNull();
    expect(hitBarEnd(iv, 120, 200, 6)).toBeNull();
    expect(hitBarEnd(iv, 195, 200, 6)).toBe('hi');
    expect(hitBarEnd(iv, 205, 200, 6)).toBe('hi');
    const thin: Interval = [0.5, 0.5078125]; // lo at 150, hi at 150.78125
    expect(hitBarEnd(thin, 145, 200, 6)).toBe('lo');
    expect(hitBarEnd(thin, 150.3, 200, 6)).toBe('lo');
    expect(hitBarEnd(thin, 150.390625, 200, 6)).toBe('hi');
    expect(hitBarEnd(thin, 150.5, 200, 6)).toBe('hi');
    expect(hitBarEnd(thin, 156, 200, 6)).toBe('hi');
    expect(hitBarEnd(iv, 0, 0, 6)).toBeNull();
    expect(hitBarEnd(iv, 0, Number.NaN, 6)).toBeNull();
  });
  test('rowIssueText gives the path relative to the row; a refused row reset says so', () => {
    expect(rowIssueText('plains', refused(setAxisText(T, 'plains', 'C', '0.5, 0.1')))).toBe('C: lo 0.5 must be below hi 0.1');
    expect(rowIssueText('plains', refused(setAxisText(T, 'plains', 'E', 'x, 1')))).toBe('E[0]: expected a number, got "x"');
    expect(rowIssueText('plains', refused(setPriorityText(T, 'plains', '9')))).toBe('priority: priority 9 is also used by meadow');
    let t = table(setPriority(T, 'plains', 100));
    t = table(setPriority(t, 'meadow', 8));
    expect(rowIssueText('plains', refused(resetRow(t, T, 'plains')), true)).toBe('cannot reset: priority 8 is also used by meadow');
    expect(rowIssueText('plains', { path: 'biomes.table', code: 'NOT_OBJECT', message: 'expected a table object, got null' })).toBe('biomes.table: expected a table object, got null');
  });
  test('rowHover: the row biome on the biome layer; elsewhere the notice when the pointer enters the rows, not row to row', () => {
    expect(HIGHLIGHT_NOTICE).toBe('switch to the biome layer to highlight');
    const plains = biomeId('plains');
    const meadow = biomeId('meadow');
    expect(rowHover('biome', plains, null)).toEqual({ highlight: plains, notice: false });
    expect(rowHover('biome', meadow, plains)).toEqual({ highlight: meadow, notice: false });
    expect(rowHover('biome', 0, null)).toEqual({ highlight: 0, notice: false });
    for (const layer of LAYERS) {
      if (layer !== 'biome') {
        expect(rowHover(layer, plains, null)).toEqual({ highlight: null, notice: true });
        expect(rowHover(layer, meadow, plains)).toEqual({ highlight: null, notice: false });
        expect(rowHover(layer, plains, plains)).toEqual({ highlight: null, notice: false });
      }
      expect(rowHover(layer, null, plains)).toEqual({ highlight: null, notice: false });
      expect(rowHover(layer, null, null)).toEqual({ highlight: null, notice: false });
    }
  });
  test('swatchColor is the map colour of the row biome', () => {
    expect(swatchColor(biomeId('plains'))).toBe('#8db360');
    expect(swatchColor(biomeId('deep_ocean'))).toBe('#0f2f6a');
    for (const r of tableRows(T, 'priority', null)) expect(swatchColor(r.biome)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('biome share preview (Task 22, spec §5.5)', () => {
  /** Counts of seed 42's default world over the §5.5 stream (100 000 points, measured with biomeSharesInto; 181 outside, no ties). */
  const SEED42: Readonly<Record<SurfaceBiome, number>> = {
    ocean: 14751, deep_ocean: 16080, warm_ocean: 9066, frozen_ocean: 4485, beach: 1925, snowy_beach: 471, stony_shore: 1434,
    river: 1463, frozen_river: 388, plains: 1895, meadow: 2139, forest: 1320, birch_forest: 1286, dark_forest: 2384, taiga: 6693,
    snowy_taiga: 2789, snowy_plains: 4099, desert: 4210, savanna: 3999, swamp: 589, jungle: 2445, badlands: 2687,
    windswept_hills: 5079, snowy_slopes: 4995, stony_peaks: 1340, jagged_peaks: 650, frozen_peaks: 692, volcano: 646,
  };
  const NB = SURFACE_BIOMES.length;
  /** The raw sum of a result: per-biome counts, then ties, outside and the total (the counts' sum). */
  const rawSum = (counts: Readonly<Record<SurfaceBiome, number>>, ties = 0, outside = 0): Float64Array<ArrayBuffer> => {
    const sum = new Float64Array(biomeSharesLength());
    SURFACE_BIOMES.forEach((name, id) => {
      sum[id] = counts[name];
      sum[NB + 2]! += counts[name];
    });
    sum[NB] = ties;
    sum[NB + 1] = outside;
    return sum;
  };
  const summary = (counts: Readonly<Record<SurfaceBiome, number>>, ties = 0, outside = 0): BiomeShareSummary =>
    summarizeBiomeShares(rawSum(counts, ties, outside));
  /** SEED42 with some counts replaced; the total stays 100 000, as in a real result. */
  const edited = (set: Partial<Record<SurfaceBiome, number>>): Record<SurfaceBiome, number> => {
    const c = { ...SEED42, ...set };
    expect(SURFACE_BIOMES.reduce((a, n) => a + c[n], 0)).toBe(100000);
    return c;
  };
  const kinds = (ws: readonly ShareWarning[]) => ws.map((w) => w.kind);

  test('the warning limits are B1\'s thresholds', () => {
    const b1 = THRESHOLDS.B1!;
    expect(SHARE_LIMITS).toEqual({
      unreachable: b1['minRareShare']!.min, dominant: b1['largestLand']!.max, oceanMin: b1['oceanFamilyMin']!.min,
      oceanMax: b1['oceanFamilyMax']!.max, ties: b1['ties']!.max, outside: b1['outside']!.max,
    });
    expect(SHARE_LIMITS).toEqual({ unreachable: 0.001, dominant: 0.16, oceanMin: 0.25, oceanMax: 0.45, ties: 0, outside: 0.02 });
  });
  test('shareText: two decimals from 1 %, three below, 0 % for none; countText groups thousands', () => {
    expect([0.44382, 0.0421, 0.01, 0.161, 1].map(shareText)).toEqual(['44.38 %', '4.21 %', '1.00 %', '16.10 %', '100.00 %']);
    expect([0.00388, 0.00099, 0.00001].map(shareText)).toEqual(['0.388 %', '0.099 %', '0.001 %']);
    expect(shareText(0)).toBe('0 %');
    expect([0, 999, 1000, 100000, 1234567].map(countText)).toEqual(['0', '999', '1 000', '100 000', '1 234 567']);
  });
  test('the default world at seed 42 gives no warning', () => {
    const s = summary(SEED42, 0, 181);
    expect(s.total).toBe(BIOME_SHARES_POINTS);
    expect(shareWarnings(s)).toEqual([]);
  });
  test('unreachable: a biome under 0.1 % of the points (rivers included); exactly 0.1 % is not', () => {
    expect(shareWarnings(summary(edited({ volcano: 100, taiga: 6693 + 546 })))).toEqual([]);
    expect(shareWarnings(summary(edited({ volcano: 99, taiga: 6693 + 547 })))).toEqual([
      { kind: 'unreachable', biome: biomeId('volcano'), text: 'volcano 0.099 %: unreachable (below 0.1 %)' },
    ]);
    expect(shareWarnings(summary(edited({ frozen_river: 0, taiga: 6693 + 388 })))).toEqual([
      { kind: 'unreachable', biome: biomeId('frozen_river'), text: 'frozen_river 0 %: unreachable (below 0.1 %)' },
    ]);
  });
  test('dominant: a land biome (coast, lowland or highland) above 16 %; exactly 16 %, oceans and rivers are not', () => {
    expect(shareWarnings(summary(edited({ plains: 16000, deep_ocean: 16080 - 14105 })))).toEqual([]);
    expect(shareWarnings(summary(edited({ plains: 16100, deep_ocean: 16080 - 14205 })))).toEqual([
      { kind: 'dominant', biome: biomeId('plains'), text: 'plains 16.10 %: dominant (above 16 % for a land biome)' },
    ]);
    expect(shareWarnings(summary(edited({ beach: 16100, deep_ocean: 16080 - 14175 })))).toEqual([
      { kind: 'dominant', biome: biomeId('beach'), text: 'beach 16.10 %: dominant (above 16 % for a land biome)' },
    ]);
    expect(shareWarnings(summary(edited({ river: 17000, deep_ocean: 16080 - 15537 })))).toEqual([]);
    expect(summary(SEED42).shares[biomeId('deep_ocean')]).toBeGreaterThan(0.16);
  });
  test('ocean family outside 25-45 %', () => {
    expect(shareWarnings(summary(edited({ ocean: 14751 + 617, taiga: 6693 - 617 })))).toEqual([]);
    expect(shareWarnings(summary(edited({ ocean: 14751 + 1118, taiga: 6693 - 1118 })))).toEqual([
      { kind: 'ocean', biome: null, text: 'ocean family 45.50 %: outside 25-45 %' },
    ]);
    const low = edited({ ocean: 10849, deep_ocean: 100, taiga: 6693 + 6000, desert: 4210 + 6000, savanna: 3999 + 6000, plains: 1895 + 1882 });
    expect(shareWarnings(summary(low))).toEqual([{ kind: 'ocean', biome: null, text: 'ocean family 24.50 %: outside 25-45 %' }]);
  });
  test('ties: any tied point; outside every box: above 2 %', () => {
    expect(shareWarnings(summary(SEED42, 12))).toEqual([
      { kind: 'ties', biome: null, text: 'ties 0.012 % (12 points): two boxes fit equally and the priority decides' },
    ]);
    expect(shareWarnings(summary(SEED42, 0, 2000))).toEqual([]);
    expect(shareWarnings(summary(SEED42, 0, 2500))).toEqual([{ kind: 'outside', biome: null, text: 'outside every box 2.50 %: above 2 %' }]);
  });
  test('warnings come in the spec\'s order: unreachable and dominant biomes in registry order, ocean family, ties, outside', () => {
    const c = edited({ frozen_river: 0, volcano: 50, plains: 16100, deep_ocean: 100, ocean: 10000, taiga: 6693 + 2759, desert: 4210 + 4751 });
    const ws = shareWarnings(summary(c, 3, 2100));
    expect(kinds(ws)).toEqual(['unreachable', 'unreachable', 'dominant', 'ocean', 'ties', 'outside']);
    expect(ws.map((w) => w.text)).toEqual([
      'frozen_river 0 %: unreachable (below 0.1 %)',
      'volcano 0.050 %: unreachable (below 0.1 %)',
      'plains 16.10 %: dominant (above 16 % for a land biome)',
      'ocean family 23.65 %: outside 25-45 %',
      'ties 0.003 % (3 points): two boxes fit equally and the priority decides',
      'outside every box 2.10 %: above 2 %',
    ]);
  });
  test('an empty result (no points) has no warnings', () => {
    expect(shareWarnings(summarizeBiomeShares(new Float64Array(biomeSharesLength())))).toEqual([]);
  });
  test('shareScale: the largest share rounded up to 5 %, at least 20 %', () => {
    expect([0, 0.1608, 0.2, 0.2001, 0.3, 0.55, 0.551, 1].map(shareScale)).toEqual([0.2, 0.2, 0.2, 0.25, 0.3, 0.55, 0.6, 1]);
  });
  test('shareChart: one bar per surface biome in registry order, scaled, with its warning and the 16 % mark on land rows', () => {
    const s = summary(SEED42, 0, 181);
    const chart = shareChart(s);
    expect(chart.scale).toBe(0.2);
    expect(chart.dominantAt).toBeCloseTo(0.8, 12);
    expect(chart.bars.map((b) => b.name)).toEqual(SURFACE_BIOMES);
    chart.bars.forEach((b, id) => {
      expect(b.biome).toBe(id);
      expect(b.family).toBe(biomeFamily(id));
      expect(b.land).toBe(b.family !== 'ocean' && b.family !== 'river');
      expect(b.share).toBe(s.shares[id]);
      expect(b.fraction).toBeCloseTo(s.shares[id]! / 0.2, 12);
      expect(b.text).toBe(shareText(s.shares[id]!));
      expect(b.warning).toBeNull();
    });
    expect(chart.bars[biomeId('deep_ocean')]!.text).toBe('16.08 %');
    expect(chart.warnings).toEqual([]);
    expect(chart.totals).toBe('ocean family 44.38 % · ties 0 % · outside every box 0.181 % · 100 000 points');

    const c = edited({ frozen_river: 0, volcano: 50, plains: 16100, deep_ocean: 100, ocean: 10000, taiga: 6693 + 2759, desert: 4210 + 4751 });
    const warned = shareChart(summary(c, 3, 2100));
    expect(warned.warnings).toEqual(shareWarnings(summary(c, 3, 2100)));
    expect(warned.bars.filter((b) => b.warning !== null).map((b) => [b.name, b.warning])).toEqual([
      ['frozen_river', 'unreachable'], ['plains', 'dominant'], ['volcano', 'unreachable'],
    ]);
    // Plains as many points as every other biome together: half the points, so the scale is 50 %.
    const big = shareChart(summary({ ...SEED42, plains: 100000 - 1895 }));
    expect(big.scale).toBe(0.5);
    expect(big.dominantAt).toBeCloseTo(0.32, 12);
    expect(big.bars[biomeId('plains')]!.fraction).toBe(1);
  });
  test('sharesView and sharesStatus: none before a result, fresh on its draft, stale from the next change or during a gesture', () => {
    expect(sharesView(null, 3, false)).toBe('none');
    expect(sharesView(null, 3, true)).toBe('none');
    expect(sharesView(3, 3, false)).toBe('fresh');
    expect(sharesView(3, 3, true)).toBe('stale');
    expect(sharesView(2, 3, false)).toBe('stale');
    expect(sharesStatus('none', false)).toBe('shares follow when the preview settles');
    expect(sharesStatus('none', true)).toBe('computing…');
    expect(sharesStatus('fresh', false)).toBe('');
    expect(sharesStatus('stale', false)).toBe('stale: updates when the preview settles');
    expect(sharesStatus('stale', true)).toBe('stale: computing…');
  });

  interface StatsCall {
    readonly kind: StatsKind;
    readonly n: number;
    readonly args: unknown;
    readonly priority: number | undefined;
    resolve(v: Float64Array<ArrayBuffer>): void;
    reject(e: unknown): void;
  }
  /** createShareRequests over a fake session (epoch 3), a pool whose stats calls the test settles, and a visibility switch. */
  const requests = () => {
    const calls: StatsCall[] = [];
    const session = { state: { epoch: 3 }, inGesture: false };
    const failures: string[] = [];
    let visible = true;
    let changes = 0;
    const pool: Pick<WorkerPool, 'stats'> = {
      stats: <K extends StatsKind>(kind: K, n: number, args: StatsArgs<K>, priority?: number) =>
        new Promise<Float64Array<ArrayBuffer>>((resolve, reject) => { calls.push({ kind, n, args, priority, resolve, reject }); }),
    };
    const r = createShareRequests({
      session, pool, visible: () => visible, changed: () => { changes++; }, failed: (m) => { failures.push(m); },
    });
    return { r, calls, session, failures, show: (v: boolean) => { visible = v; }, changes: () => changes };
  };
  const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

  test('requests biomeShares over the whole stream once per session epoch, only when settled, on screen and outside a gesture', async () => {
    const h = requests();
    h.r.request(false);
    h.show(false);
    h.r.request(true);
    h.show(true);
    h.session.inGesture = true;
    h.r.request(true);
    expect(h.calls).toHaveLength(0);
    expect(h.changes()).toBe(0);
    h.session.inGesture = false;
    h.r.request(true);
    expect(h.calls.map((c) => [c.kind, c.n, c.args, c.priority])).toEqual([['biomeShares', BIOME_SHARES_POINTS, { len: biomeSharesLength() }, undefined]]);
    expect(h.r.pending).toBe(3);
    expect(h.r.shown).toBeNull();
    expect(h.changes()).toBe(1);
    h.r.request(true);
    expect(h.calls).toHaveLength(1);
    h.calls[0]!.resolve(rawSum(SEED42, 0, 181));
    await flush();
    expect(h.r.pending).toBeNull();
    expect(h.r.shown?.epoch).toBe(3);
    expect(h.r.shown?.summary).toEqual(summary(SEED42, 0, 181));
    expect(h.changes()).toBe(2);
    h.r.request(true);
    expect(h.calls).toHaveLength(1);
    h.session.state = { epoch: 4 };
    h.r.request(true);
    expect(h.calls).toHaveLength(2);
    expect(h.r.pending).toBe(4);
    expect(h.r.shown?.epoch).toBe(3);
  });
  test('only the latest request\'s result is shown', async () => {
    const h = requests();
    h.r.request(true);
    h.session.state = { epoch: 5 };
    h.r.request(true);
    h.calls[0]!.resolve(rawSum(SEED42));
    await flush();
    expect(h.r.shown).toBeNull();
    expect(h.r.pending).toBe(5);
    h.calls[1]!.resolve(rawSum(SEED42, 7));
    await flush();
    expect(h.r.shown?.epoch).toBe(5);
    expect(h.r.shown?.summary.ties).toBe(7 / 100000);
    expect(h.r.pending).toBeNull();
  });
  test('JobCancelled keeps the last result (stale) silently; the next settle requests again', async () => {
    const h = requests();
    h.r.request(true);
    h.calls[0]!.resolve(rawSum(SEED42));
    await flush();
    const shown = h.r.shown;
    h.session.state = { epoch: 4 };
    h.r.request(true);
    h.calls[1]!.reject(new JobCancelled());
    await flush();
    expect(h.r.shown).toBe(shown);
    expect(h.r.pending).toBeNull();
    expect(h.failures).toEqual([]);
    expect(sharesView(h.r.shown!.epoch, h.session.state.epoch, false)).toBe('stale');
    h.r.request(true);
    expect(h.calls).toHaveLength(3);
  });
  test('any other error keeps the last result (stale) and reports the failure', async () => {
    const h = requests();
    h.r.request(true);
    h.calls[0]!.resolve(rawSum(SEED42));
    await flush();
    const shown = h.r.shown;
    h.session.state = { epoch: 4 };
    h.r.request(true);
    h.calls[1]!.reject(new Error('BAD_ARGS: args.len 30, expected 31'));
    await flush();
    expect(h.r.shown).toBe(shown);
    expect(h.r.pending).toBeNull();
    expect(h.failures).toEqual(['BAD_ARGS: args.len 30, expected 31']);
    h.session.state = { epoch: 5 };
    h.r.request(true);
    h.calls[2]!.reject('worker gone');
    await flush();
    expect(h.failures).toEqual(['BAD_ARGS: args.len 30, expected 31', 'worker gone']);
  });
});

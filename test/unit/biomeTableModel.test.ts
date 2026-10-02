import { describe, expect, test } from 'vitest';
import { BOX_BIOMES, type BoxBiome } from '../../src/core/params/biomeDefaults';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, BOX_AXES, type BoxTable } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { biomeFamily, biomeId } from '../../src/gen/biomes/registry';
import {
  BIOME_TABLE_PATH, dragAxisEnd, resetRow, setAxis, setPriority, setWSign, TABLE_FAMILIES, tableRows, type TableEdit,
} from '../../src/ui/biomeTable/model';
import { testRng } from '../harness/stats';

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

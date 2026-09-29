import { describe, expect, test } from 'vitest';
import { applyPatch, boxTable, buildSchema, group, renderReference, type BoxRow } from '../../src/core/params/kit';

const row = (C: [number, number], priority: number, wSign: -1 | 0 | 1 = 0): BoxRow => ({ C, E: [-1, 1], PV: [-1, 1], T: [-1, 1], H: [-1, 1], wSign, priority });
const DEF = { a: row([-1, 0], 1), b: row([0, 1], 2, 1) };
const S = buildSchema(group('T', 't', {
  t: boxTable(DEF, { label: 'Boxes', doc: 'Test boxes.', scope: 'terrain', stage: 'biome2d', rows: ['a', 'b'] }),
}));
const codes = (patch: unknown) => {
  const r = applyPatch(S, S.defaults, patch);
  return r.ok ? [] : r.issues.map((i) => `${i.code} @ ${i.path}`);
};

describe('boxTable leaf', () => {
  test('defaults validate, freeze and keep every row', () => {
    expect(S.defaults.t).toEqual(DEF);
    expect(Object.isFrozen(S.defaults.t.a.C)).toBe(true);
    expect(S.leaves[0]!.meta.kind).toBe('boxTable');
    expect(S.leaves[0]!.meta.options).toEqual(['a', 'b']);
  });
  test('a patch replaces the whole table', () => {
    const r = applyPatch(S, S.defaults, { t: { a: row([-1, 0.5], 3), b: row([0.5, 1], 4, -1) } });
    expect(r.ok && r.value.t.a.C).toEqual([-1, 0.5]);
    expect(codes({ t: { a: row([-1, 0], 1) } })).toEqual(['MISSING_KEY @ t.b']);
  });
  test.each<[string, unknown, string[]]>([
    ['not an object', [], ['NOT_OBJECT @ t']],
    ['unknown row', { ...DEF, c: row([0, 1], 9) }, ['UNKNOWN_KEY @ t.c']],
    ['unknown field', { ...DEF, a: { ...row([-1, 0], 1), X: [0, 1] } }, ['UNKNOWN_KEY @ t.a.X']],
    ['missing field', { ...DEF, a: { C: [-1, 0], E: [-1, 1], PV: [-1, 1], T: [-1, 1], wSign: 0, priority: 1 } }, ['MISSING_KEY @ t.a.H']],
    ['interval not a pair', { ...DEF, a: { ...row([-1, 0], 1), E: [0] } }, ['BAD_INTERVAL @ t.a.E']],
    ['interval reversed', { ...DEF, a: row([0.5, 0.1], 1) }, ['BAD_INTERVAL @ t.a.C']],
    ['interval outside [-1, 1]', { ...DEF, a: row([-2, 0], 1) }, ['OUT_OF_RANGE @ t.a.C[0]']],
    ['bad wSign', { ...DEF, a: { ...row([-1, 0], 1), wSign: 2 } }, ['BAD_ENUM @ t.a.wSign']],
    ['non-integer priority', { ...DEF, a: row([-1, 0], 1.5) }, ['NOT_INTEGER @ t.a.priority']],
    ['duplicate priority', { ...DEF, b: row([0, 1], 1) }, ['DUPLICATE_PRIORITY @ t.b.priority']],
  ])('%s', (_name, value, expected) => {
    expect(codes({ t: value })).toEqual(expected);
  });
  test('the README shows a row count instead of the whole table', () => {
    expect(renderReference(S).split('\n')[2]).toBe('| `t` | boxTable | 2 rows | a / b |  | terrain | Boxes: Test boxes. |');
  });
});

test('randomValue produces valid tables', async () => {
  const { randomParams } = await import('../harness/params');
  const { testRng } = await import('../harness/stats');
  const next = testRng(7);
  for (let i = 0; i < 50; i++) expect(Object.keys(randomParams(S, next).t)).toEqual(['a', 'b']);
});

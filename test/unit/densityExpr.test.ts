import { describe, expect, test } from 'vitest';
import {
  assertValidExpr, EXPR_CHILD_KEYS, EXPR_OPS, exprChildren, exprHash, ExprValidationError, validateExpr,
  type DensityExpr, type DensityNoiseInfo, type Expr,
} from '../../src/gen/density/expr';

const NOISES = new Map<string, DensityNoiseInfo>([
  ['jag', { dims: 2, remap: 'none', clampSigma: 3 }],
  ['overhang', { dims: 3, remap: 'none', clampSigma: 3 }],
  ['flat', { dims: 2, remap: 'uniform', clampSigma: 3 }],
]);
const LOOKUP = (id: string): DensityNoiseInfo | undefined => NOISES.get(id);
const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const doc = (root: unknown, defs: Record<string, unknown> = {}): unknown => ({ root, defs });
const issues = (value: unknown): string[] => validateExpr(value, LOOKUP).map((i) => `${i.path}: ${i.code}`);

/** Uses every op once (and `ref` into a def). */
const EVERY_OP: DensityExpr = {
  root: {
    op: 'max',
    a: {
      op: 'add',
      a: { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: { op: 'ref', name: 'shape' } } },
      b: { op: 'mul', a: { op: 'noise', id: 'overhang' }, b: { op: 'clamp', x: { op: 'col', field: 'E' }, lo: 0, hi: 1 } },
    },
    b: {
      op: 'rangeChoice', x: { op: 'noise2', id: 'jag' }, lo: -1, hi: 1,
      inside: { op: 'min', a: { op: 'abs', x: C(-2) }, b: { op: 'square', x: C(3) } },
      outside: { op: 'neg', x: C(1e6) },
    },
  },
  defs: {
    shape: { op: 'add', a: { op: 'col', field: 'offset' }, b: { op: 'slide', x: { op: 'neg', x: Y }, knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] } },
  },
};

describe('Expr structure', () => {
  test('EXPR_OPS lists the 17 ops of SP3b spec §1.1 and EXPR_CHILD_KEYS their child slots in evaluation order', () => {
    expect([...EXPR_OPS].sort()).toEqual(['abs', 'add', 'clamp', 'col', 'const', 'interpolated', 'max', 'min', 'mul', 'neg',
      'noise', 'noise2', 'rangeChoice', 'ref', 'slide', 'square', 'tap', 'y']);
    expect(EXPR_CHILD_KEYS.add).toEqual(['a', 'b']);
    expect(EXPR_CHILD_KEYS.rangeChoice).toEqual(['x', 'inside', 'outside']);
    expect(EXPR_CHILD_KEYS.slide).toEqual(['x']);
    for (const op of ['const', 'y', 'col', 'noise2', 'noise', 'ref'] as const) expect(EXPR_CHILD_KEYS[op]).toEqual([]);
  });

  test('exprChildren returns the children in evaluation order', () => {
    const a = C(1), b = C(2), x = C(0);
    expect(exprChildren({ op: 'min', a, b })).toEqual([a, b]);
    const rc: Expr = { op: 'rangeChoice', x, lo: 0, hi: 1, inside: a, outside: b };
    const kids = exprChildren(rc);
    expect(kids[0]).toBe(x);
    expect(kids[1]).toBe(a);
    expect(kids[2]).toBe(b);
    expect(exprChildren({ op: 'ref', name: 'q' })).toEqual([]);
  });
});

describe('validateExpr (SP3b spec §1.1)', () => {
  test('an expression that uses every op validates', () => {
    expect(validateExpr(EVERY_OP, LOOKUP)).toEqual([]);
    expect(() => assertValidExpr(EVERY_OP, LOOKUP)).not.toThrow();
  });

  test('the top level is {root, defs}', () => {
    expect(issues(null)).toEqual([': NOT_OBJECT']);
    expect(issues({ root: C(1) })).toEqual(['defs: NOT_OBJECT']);
    expect(issues({ root: C(1), defs: [] })).toEqual(['defs: NOT_OBJECT']);
    expect(issues({ root: C(1), defs: {}, extra: 1 })).toEqual(['extra: UNKNOWN_KEY']);
    expect(issues({ defs: {} })).toEqual(['root: NOT_OBJECT']);
  });

  test('unknown ops and keys are reported at their real node paths', () => {
    const bad = { op: 'add', a: C(1), b: { op: 'max', a: C(0), b: { op: 'neg', x: { op: 'sin', x: Y } } } };
    expect(issues(doc(bad))).toEqual(['root.b.b.x: UNKNOWN_OP']);
    expect(issues(doc(C(1), { terrain: { op: 'neg', x: { op: 'const', v: 1, w: 2 } } }))).toEqual(['defs.terrain.x.w: UNKNOWN_KEY']);
    expect(issues(doc({ op: 'add', a: C(1) }))).toEqual(['root.b: NOT_OBJECT']);
    expect(issues(doc({ op: 'neg', x: 3 }))).toEqual(['root.x: NOT_OBJECT']);
  });

  test('non-finite or non-numeric constants are rejected', () => {
    expect(issues(doc(C(NaN)))).toEqual(['root.v: NOT_FINITE']);
    expect(issues(doc(C(Infinity)))).toEqual(['root.v: NOT_FINITE']);
    expect(issues(doc({ op: 'const', v: '1' }))).toEqual(['root.v: NOT_FINITE']);
    expect(issues(doc({ op: 'clamp', x: Y, lo: NaN, hi: 1 }))).toEqual(['root.lo: NOT_FINITE']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 0, hi: Infinity, inside: C(1), outside: C(0) }))).toEqual(['root.hi: NOT_FINITE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [1, NaN]] }))).toEqual(['root.knots[1]: NOT_FINITE']);
    expect(validateExpr(doc(C(-0)), LOOKUP)).toEqual([]);
  });

  test('col reads only the continuous ColumnSample fields', () => {
    expect(issues(doc({ op: 'col', field: 'offset' }))).toEqual([]);
    expect(issues(doc({ op: 'col', field: 'offsetX' }))).toEqual(['root.field: BAD_FIELD']);
    expect(issues(doc({ op: 'col', field: 'surfaceWaterLevel' }))).toEqual(['root.field: BAD_FIELD']);
    expect(issues(doc({ op: 'col', field: 'toString' }))).toEqual(['root.field: BAD_FIELD']);
  });

  test('noise ids must be known density noises of the right dimension with remap none', () => {
    expect(issues(doc({ op: 'noise2', id: 'jag' }))).toEqual([]);
    expect(issues(doc({ op: 'noise', id: 'overhang' }))).toEqual([]);
    expect(issues(doc({ op: 'noise', id: 'nope' }))).toEqual(['root.id: UNKNOWN_NOISE']);
    expect(issues(doc({ op: 'noise', id: 3 }))).toEqual(['root.id: UNKNOWN_NOISE']);
    expect(issues(doc({ op: 'noise', id: 'jag' }))).toEqual(['root.id: NOISE_DIMS']);
    expect(issues(doc({ op: 'noise2', id: 'overhang' }))).toEqual(['root.id: NOISE_DIMS']);
    expect(issues(doc({ op: 'noise2', id: 'flat' }))).toEqual(['root.id: NOISE_REMAP']);
  });

  test('ref names must exist and must not form a cycle', () => {
    expect(issues(doc({ op: 'ref', name: 'missing' }))).toEqual(['root.name: UNKNOWN_REF']);
    expect(issues(doc({ op: 'ref', name: 'toString' }))).toEqual(['root.name: UNKNOWN_REF']);
    expect(issues(doc({ op: 'ref', name: 'a' }, { a: { op: 'neg', x: { op: 'ref', name: 'a' } } }))).toEqual(['defs.a.x: REF_CYCLE']);
    expect(issues(doc({ op: 'ref', name: 'a' }, { a: { op: 'ref', name: 'b' }, b: { op: 'abs', x: { op: 'ref', name: 'a' } } })))
      .toEqual(['defs.b.x: REF_CYCLE']);
    expect(issues(doc({ op: 'add', a: { op: 'ref', name: 'a' }, b: { op: 'ref', name: 'a' } }, { a: C(1) }))).toEqual([]);
    const cyc = validateExpr(doc(C(0), { a: { op: 'ref', name: 'b' }, b: { op: 'ref', name: 'a' } }), LOOKUP);
    expect(cyc.map((i) => i.message)).toEqual(['ref cycle defs.a → defs.b → defs.a']);
  });

  test('an interpolated inside another is rejected, also through a ref', () => {
    const inner = { op: 'interpolated', x: Y };
    expect(issues(doc({ op: 'interpolated', x: { op: 'neg', x: inner } }))).toEqual(['root.x.x: NESTED_INTERPOLATED']);
    expect(issues(doc({ op: 'interpolated', x: { op: 'ref', name: 'd' } }, { d: { op: 'abs', x: inner } }))).toEqual(['defs.d.x: NESTED_INTERPOLATED']);
    // The same def used inside and outside an interpolated is reported once.
    const both = doc({ op: 'add', a: { op: 'ref', name: 'd' }, b: { op: 'interpolated', x: { op: 'ref', name: 'd' } } }, { d: inner });
    expect(issues(both)).toEqual(['defs.d: NESTED_INTERPOLATED']);
    // Siblings are fine.
    expect(issues(doc({ op: 'add', a: inner, b: inner }))).toEqual([]);
  });

  test('clamp needs lo ≤ hi, rangeChoice lo < hi, slide ≥ 2 strictly increasing knots', () => {
    expect(issues(doc({ op: 'clamp', x: Y, lo: 1, hi: 1 }))).toEqual([]);
    expect(issues(doc({ op: 'clamp', x: Y, lo: 2, hi: 1 }))).toEqual(['root: CLAMP_ORDER']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 1, hi: 1, inside: C(1), outside: C(0) }))).toEqual(['root: RANGE_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1]] }))).toEqual(['root.knots: KNOTS_SHAPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: 'x' }))).toEqual(['root.knots: KNOTS_SHAPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1], [1, 2, 3]] }))).toEqual(['root.knots[1]: KNOTS_SHAPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1], [0, 2]] }))).toEqual(['root.knots[1]: KNOTS_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 1], [-1, 2]] }))).toEqual(['root.knots[1]: KNOTS_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0.25, 1], [0.5, 2]] }))).toEqual([]);
  });

  test('tap names are non-empty strings and unique', () => {
    expect(issues(doc({ op: 'tap', name: '', x: Y }))).toEqual(['root.name: BAD_NAME']);
    expect(issues(doc({ op: 'add', a: { op: 'tap', name: 't', x: Y }, b: { op: 'tap', name: 't', x: C(0) } }))).toEqual(['root.b.name: DUPLICATE_TAP']);
    // A tap inside a def referenced twice is one tap.
    expect(issues(doc({ op: 'add', a: { op: 'ref', name: 'd' }, b: { op: 'ref', name: 'd' } }, { d: { op: 'tap', name: 't', x: Y } }))).toEqual([]);
  });

  test('issues are collected in pre-order, root before defs; assertValidExpr throws them', () => {
    const value = doc({ op: 'add', a: C(NaN), b: { op: 'col', field: 'Q' } }, { d: { op: 'nope' } });
    expect(issues(value)).toEqual(['root.a.v: NOT_FINITE', 'root.b.field: BAD_FIELD', 'defs.d: UNKNOWN_OP']);
    let err: unknown;
    try { assertValidExpr(value, LOOKUP); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ExprValidationError);
    expect((err as ExprValidationError).issues.length).toBe(3);
    expect((err as Error).message).toContain('root.a.v: NOT_FINITE');
  });
});

describe('exprHash (structural)', () => {
  test('equal structure gives an equal 16-hex hash regardless of object identity and key order', () => {
    const a: Expr = { op: 'clamp', x: { op: 'add', a: Y, b: C(1) }, lo: 0, hi: 2 };
    const b = JSON.parse('{"hi":2,"lo":0,"x":{"b":{"v":1,"op":"const"},"a":{"op":"y"},"op":"add"},"op":"clamp"}') as Expr;
    expect(exprHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(exprHash(b)).toBe(exprHash(a));
  });

  test('every field distinguishes, including −0, operand order and names', () => {
    const k = (v: number): [number, number] => [v, v];
    const variants: Expr[] = [
      C(0), C(-0), C(1), C(1e-300), Y,
      { op: 'col', field: 'offset' }, { op: 'col', field: 'E' },
      { op: 'noise2', id: 'jag' }, { op: 'noise', id: 'jag' }, { op: 'noise', id: 'overhang' },
      { op: 'add', a: Y, b: C(1) }, { op: 'add', a: C(1), b: Y }, { op: 'mul', a: Y, b: C(1) },
      { op: 'min', a: Y, b: C(1) }, { op: 'max', a: Y, b: C(1) },
      { op: 'neg', x: Y }, { op: 'abs', x: Y }, { op: 'square', x: Y }, { op: 'interpolated', x: Y },
      { op: 'clamp', x: Y, lo: 0, hi: 1 }, { op: 'clamp', x: Y, lo: 0, hi: 2 }, { op: 'clamp', x: Y, lo: -0, hi: 1 },
      { op: 'slide', x: Y, knots: [k(0), [1, 1]] }, { op: 'slide', x: Y, knots: [k(0), [1, 2]] }, { op: 'slide', x: Y, knots: [k(0), [1, 1], [2, 1]] },
      { op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: C(1), outside: C(0) },
      { op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: C(0), outside: C(1) },
      { op: 'rangeChoice', x: Y, lo: 0, hi: 2, inside: C(1), outside: C(0) },
      { op: 'tap', name: 'a', x: Y }, { op: 'tap', name: 'b', x: Y },
      { op: 'ref', name: 'a' }, { op: 'ref', name: 'b' },
    ];
    const hashes = new Set(variants.map((v) => exprHash(v)));
    expect(hashes.size).toBe(variants.length);
  });

  test('the memo records every sub-tree and gives the same result', () => {
    const memo = new WeakMap<Expr, string>();
    const h = exprHash(EVERY_OP.root, memo);
    expect(h).toBe(exprHash(EVERY_OP.root));
    const root = EVERY_OP.root as Expr & { a: Expr };
    expect(memo.get(root)).toBe(h);
    expect(memo.get(root.a)).toBe(exprHash(root.a));
  });
});

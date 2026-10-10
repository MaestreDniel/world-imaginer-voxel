import { describe, expect, expectTypeOf, test } from 'vitest';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { checkJson, type TreeIssueCode } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import { EXPR_CHILD_KEYS, EXPR_OPS, validateExpr, type DensitySourceCode, type ExprErrorCode, type ExprIssue } from '../../src/gen/density/expr';
import {
  ALLOWED_REF_TARGETS, densitySourceValidations, SOURCE_CHILD_KEYS, SOURCE_OPS, validateDensitySource,
  type DensitySource, type SourceExpr, type SourceOp,
} from '../../src/gen/density/source';

const C = (v: unknown): unknown => ({ op: 'const', v });
const Y = { op: 'y' };
const P = (path: unknown): unknown => ({ op: 'param', path });
const R = (param: string, neg?: boolean): unknown => (neg === undefined ? { param } : { param, neg });
const doc = (root: unknown, defs: Record<string, unknown> = {}): unknown => ({ root, defs });
const issues = (value: unknown): string[] => validateDensitySource(value).map((i) => `${i.path}: ${i.code}`);
const one = (value: unknown): ExprIssue => {
  const out = validateDensitySource(value);
  expect(out.length).toBe(1);
  return out[0]!;
};

const LO = 'density.detailAmpLo'; // number [0, 8]
const HI = 'density.detailAmpHi'; // number [0, 8]
const CS = 'density.noises.jag.clampSigma'; // number [1, 8]
const SNOW = 'surface.snowline'; // number [−1, 1]
const CLIFF_Y = 'surface.cliffMinY'; // int [−64, 319]

describe('the source model (SP3d spec §1.3, §1.4)', () => {
  test('ALLOWED_REF_TARGETS: the number and int leaves under density. and surface., and every density/surface noise clampSigma', () => {
    expect(ALLOWED_REF_TARGETS).toBeInstanceOf(Map);
    expect([...ALLOWED_REF_TARGETS.keys()]).toEqual([
      'density.noises.jag.clampSigma', 'density.noises.overhang.clampSigma', 'density.noises.detail.clampSigma',
      'density.detailAmpLo', 'density.detailAmpHi',
      'surface.noises.depth.clampSigma', 'surface.noises.patch.clampSigma', 'surface.noises.bandOffset.clampSigma',
      'surface.depthMul', 'surface.snowline', 'surface.lapse', 'surface.lapseBase', 'surface.cliffSteep', 'surface.cliffMinY',
      'surface.patchThreshold',
    ]);
    expect(ALLOWED_REF_TARGETS.get(CS)).toEqual({ kind: 'number', lo: 1, hi: 8 });
    expect(ALLOWED_REF_TARGETS.get(LO)).toEqual({ kind: 'number', lo: 0, hi: 8 });
    expect(ALLOWED_REF_TARGETS.get(SNOW)).toEqual({ kind: 'number', lo: -1, hi: 1 });
    expect(ALLOWED_REF_TARGETS.get('surface.lapseBase')).toEqual({ kind: 'int', lo: -64, hi: 319 });
    expect(ALLOWED_REF_TARGETS.get(CLIFF_Y)).toEqual({ kind: 'int', lo: -64, hi: 319 });
    expect(ALLOWED_REF_TARGETS.get('surface.depthMul')).toEqual({ kind: 'number', lo: 0, hi: 2 });
    for (const t of ALLOWED_REF_TARGETS.values()) {
      expect(Number.isFinite(t.lo) && Number.isFinite(t.hi) && t.lo <= t.hi).toBe(true);
      expect(Object.isFrozen(t)).toBe(true);
    }
    for (const name of ['constructor', 'toString', '__proto__', 'density', 'density.noises.jag', 'climate.tempScale']) {
      expect(ALLOWED_REF_TARGETS.has(name)).toBe(false);
    }
  });

  test('SOURCE_OPS and SOURCE_CHILD_KEYS: the Expr ops plus recip [x] and param []; own-property safe', () => {
    expect(SOURCE_OPS).toEqual([...EXPR_OPS, 'recip', 'param']);
    for (const op of EXPR_OPS) expect(SOURCE_CHILD_KEYS[op]).toEqual(EXPR_CHILD_KEYS[op]);
    expect(SOURCE_CHILD_KEYS.recip).toEqual(['x']);
    expect(SOURCE_CHILD_KEYS.param).toEqual([]);
    expect(Object.keys(SOURCE_CHILD_KEYS).sort()).toEqual([...SOURCE_OPS].sort());
    expect(Object.isFrozen(SOURCE_CHILD_KEYS)).toBe(true);
    // Tree content is never looked up through the prototype chain.
    expect((SOURCE_CHILD_KEYS as Record<string, unknown>)['constructor']).toBeUndefined();
    expect((SOURCE_CHILD_KEYS as Record<string, unknown>)['toString']).toBeUndefined();
    expectTypeOf<SourceOp>().toEqualTypeOf<(typeof EXPR_OPS)[number] | 'recip' | 'param'>();
  });

  test('the default density tree is a valid source and types as DensitySource', () => {
    expect(validateDensitySource(DEFAULT_DENSITY_TREE)).toEqual([]);
    const d = DEFAULT_DENSITY_TREE as unknown as DensitySource;
    expectTypeOf(d.root).toEqualTypeOf<SourceExpr>();
    expect(d.root.op).toBe('max');
  });

  test('source codes are TreeIssueCodes', () => {
    expectTypeOf<ExprErrorCode>().toExtend<TreeIssueCode>();
    expectTypeOf<DensitySourceCode>().toExtend<TreeIssueCode>();
    expectTypeOf<DensitySourceCode>().toEqualTypeOf<
      'UNKNOWN_PARAM' | 'RECIP_OPERAND' | 'RECIP_ZERO' | 'LITERAL_RANGE' | 'SLIDE_SLOPE' | 'TOO_MANY_NODES' | 'TOO_MANY_DEFS'
      | 'EXPANDED_TOO_DEEP' | 'TOO_COSTLY' | 'VALUE_RANGE' | 'COLUMN_COST' | 'TOO_MANY_ISSUES'>();
    expectTypeOf<ExprIssue['code']>().toEqualTypeOf<ExprErrorCode | DensitySourceCode>();
  });
});

describe('validateDensitySource: parameter refs (SP3d spec §1.3)', () => {
  test('a param node names a target; anything else is UNKNOWN_PARAM at its path field', () => {
    for (const path of [LO, HI, CS, SNOW, CLIFF_Y, 'surface.lapse']) expect(issues(doc(P(path)))).toEqual([]);
    for (const path of ['density.nope', 'density.noises.jag', 'density.noises.jag.octaves', 'climate.tempScale', 'constructor', 'toString', '__proto__', '', 3, undefined]) {
      expect(issues(doc({ op: 'add', a: Y, b: P(path) }))).toEqual(['root.b.path: UNKNOWN_PARAM']);
    }
    expect(issues(doc({ op: 'param', path: LO, v: 1 }))).toEqual(['root.v: UNKNOWN_KEY']);
  });

  test('refs in every numeric scalar field: clamp and rangeChoice bounds, slide knots, tap.mute (int targets too)', () => {
    expect(issues(doc({ op: 'clamp', x: Y, lo: R(SNOW, true), hi: R(CS) }))).toEqual([]);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: R(LO, true), hi: R(CS), inside: C(1), outside: C(0) }))).toEqual([]);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[R(CLIFF_Y, true), R(LO)], [320, R(HI, true)], [400, 0]] }))).toEqual([]);
    expect(issues(doc({ op: 'tap', name: 't', x: Y, mute: R(CLIFF_Y) }))).toEqual([]);
    expect(issues(doc({ op: 'tap', name: 't', x: Y, mute: -1e6 }))).toEqual([]);
  });

  test('a ref to a missing target is UNKNOWN_PARAM and a malformed ref BAD_FIELD, at the field path (never .param)', () => {
    expect(issues(doc({ op: 'clamp', x: Y, lo: R('density.nope'), hi: 1 }))).toEqual(['root.lo: UNKNOWN_PARAM']);
    expect(issues(doc({ op: 'clamp', x: Y, lo: 0, hi: R('constructor') }))).toEqual(['root.hi: UNKNOWN_PARAM']);
    expect(issues(doc({ op: 'tap', name: 't', x: Y, mute: R('toString', true) }))).toEqual(['root.mute: UNKNOWN_PARAM']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [1, R('surface.nope')]] }))).toEqual(['root.knots[1][1]: UNKNOWN_PARAM']);
    for (const bad of [{ param: LO, neg: false }, { param: LO, neg: 1 }, { param: LO, x: 1 }, { param: 3 }, {}, { neg: true }]) {
      expect(issues(doc({ op: 'rangeChoice', x: Y, lo: bad, hi: 9, inside: C(1), outside: C(0) }))).toEqual(['root.lo: BAD_FIELD']);
    }
    // Not a number and not a ref.
    expect(issues(doc({ op: 'clamp', x: Y, lo: '0', hi: 1 }))).toEqual(['root.lo: NOT_FINITE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [true, 1]] }))).toEqual(['root.knots[1][0]: NOT_FINITE']);
    expect(issues(doc({ op: 'tap', name: 't', x: Y, mute: [0] }))).toEqual(['root.mute: NOT_FINITE']);
    // const.v stays a literal: its ref form is the param node.
    expect(issues(doc({ op: 'const', v: R(LO) }))).toEqual(['root.v: NOT_FINITE']);
  });

  test('order checks hold over the static ranges (a negated ref spans [0 − max, 0 − min])', () => {
    expect(issues(doc({ op: 'clamp', x: Y, lo: R(LO), hi: 8 }))).toEqual([]);
    expect(issues(doc({ op: 'clamp', x: Y, lo: R(LO), hi: 7.5 }))).toEqual(['root: CLAMP_ORDER']);
    expect(issues(doc({ op: 'clamp', x: Y, lo: R(LO, true), hi: 0 }))).toEqual([]);
    expect(issues(doc({ op: 'clamp', x: Y, lo: R(LO, true), hi: R(SNOW) }))).toEqual(['root: CLAMP_ORDER']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 0, hi: R(LO), inside: C(1), outside: C(0) }))).toEqual(['root: RANGE_ORDER']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 0, hi: R(CS), inside: C(1), outside: C(0) }))).toEqual([]);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [R(LO), 1]] }))).toEqual(['root.knots[1]: KNOTS_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[R(LO), 0], [8, 1]] }))).toEqual(['root.knots[1]: KNOTS_ORDER']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[R(LO), 0], [8.5, 1]] }))).toEqual([]);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[R(CS, true), 0], [R(LO), 1]] }))).toEqual([]);
  });

  test('two refs to the same leaf are independent: refused, and the message says so', () => {
    const clamp = one(doc({ op: 'clamp', x: Y, lo: R(LO), hi: R(LO) }));
    expect([clamp.path, clamp.code]).toEqual(['root', 'CLAMP_ORDER']);
    expect(clamp.message).toMatch(/static range/);
    expect(clamp.message).toMatch(/independent/);
    expect(clamp.message).toMatch(/same parameter/);
    const knots = one(doc({ op: 'slide', x: Y, knots: [[R(CS), 0], [R(CS), 1]] }));
    expect([knots.path, knots.code]).toEqual(['root.knots[1]', 'KNOTS_ORDER']);
    expect(knots.message).toMatch(/same parameter/);
    // A literal-only order issue keeps the plain message.
    expect(one(doc({ op: 'clamp', x: Y, lo: 2, hi: 1 })).message).toBe('clamp needs lo ≤ hi');
  });
});

describe('validateDensitySource: recip, names, literals and slopes (SP3d spec §1.4, §1.7 step 1)', () => {
  test('recip takes a const or a param operand (RECIP_OPERAND at the operand)', () => {
    expect(issues(doc({ op: 'recip', x: C(3) }))).toEqual([]);
    expect(issues(doc({ op: 'recip', x: C(-0.25) }))).toEqual([]);
    expect(issues(doc({ op: 'recip', x: P(CS) }))).toEqual([]);
    expect(issues(doc({ op: 'mul', a: Y, b: { op: 'recip', x: Y } }))).toEqual(['root.b.x: RECIP_OPERAND']);
    expect(issues(doc({ op: 'recip', x: { op: 'neg', x: C(2) } }))).toEqual(['root.x: RECIP_OPERAND']);
    expect(issues(doc({ op: 'recip', x: { op: 'recip', x: C(2) } }))).toEqual(['root.x: RECIP_OPERAND']);
    // A broken operand reports its own issue only.
    expect(issues(doc({ op: 'recip', x: { op: 'sin' } }))).toEqual(['root.x: UNKNOWN_OP']);
    expect(issues(doc({ op: 'recip', x: P('density.nope') }))).toEqual(['root.x.path: UNKNOWN_PARAM']);
    expect(issues(doc({ op: 'recip' }))).toEqual(['root.x: NOT_OBJECT']);
  });

  test('a const operand must be non-zero with a finite reciprocal; a param operand\'s range must exclude 0 (RECIP_ZERO)', () => {
    expect(issues(doc({ op: 'recip', x: C(0) }))).toEqual(['root.x: RECIP_ZERO']);
    expect(issues(doc({ op: 'recip', x: C(1e-320) }))).toEqual(['root.x: RECIP_ZERO']);
    expect(issues(doc({ op: 'recip', x: P(LO) }))).toEqual(['root.x: RECIP_ZERO']);
    expect(issues(doc({ op: 'recip', x: P(SNOW) }))).toEqual(['root.x: RECIP_ZERO']);
    expect(issues(doc({ op: 'recip', x: P('surface.depthMul') }))).toEqual(['root.x: RECIP_ZERO']);
    expect(one(doc({ op: 'recip', x: P(LO) })).message).toContain('[0, 8]');
  });

  test('tap names match the key pattern (BAD_NAME); Object.prototype names stay valid', () => {
    for (const name of ['', 'a.b', '_t', '1t', 'a-b', 'x'.repeat(33), 3]) expect(issues(doc({ op: 'tap', name, x: Y }))).toEqual(['root.name: BAD_NAME']);
    for (const name of ['t', 'T_1', 'constructor', 'toString', 'x'.repeat(32)]) expect(issues(doc({ op: 'tap', name, x: Y }))).toEqual([]);
    expect(issues(doc({ op: 'add', a: { op: 'tap', name: 'valueOf', x: Y }, b: { op: 'tap', name: 'valueOf', x: C(0) } }))).toEqual(['root.b.name: DUPLICATE_TAP']);
  });

  test('literals are within ±1e9 (LITERAL_RANGE): const.v, clamp and rangeChoice bounds, knot coordinates, mute', () => {
    expect(issues(doc(C(1e9)))).toEqual([]);
    expect(issues(doc(C(-1e9)))).toEqual([]);
    expect(issues(doc(C(1e9 + 1)))).toEqual(['root.v: LITERAL_RANGE']);
    expect(issues(doc(C(-2e9)))).toEqual(['root.v: LITERAL_RANGE']);
    expect(issues(doc({ op: 'clamp', x: Y, lo: -1e10, hi: 1e10 }))).toEqual(['root.lo: LITERAL_RANGE', 'root.hi: LITERAL_RANGE']);
    expect(issues(doc({ op: 'rangeChoice', x: Y, lo: 0, hi: 5e9, inside: C(1), outside: C(0) }))).toEqual(['root.hi: LITERAL_RANGE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[-2e9, 0], [0, 3e9]] }))).toEqual(['root.knots[0][0]: LITERAL_RANGE', 'root.knots[1][1]: LITERAL_RANGE']);
    expect(issues(doc({ op: 'tap', name: 't', x: Y, mute: -1e10 }))).toEqual(['root.mute: LITERAL_RANGE']);
  });

  test('every slide segment has a finite difference and slope over its ranges (SLIDE_SLOPE at the segment\'s upper knot)', () => {
    // The measured NaN knots of map-density.md §2 (valid as a code-built tree).
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, -1e308], [1, 1e308]] })))
      .toEqual(['root.knots[0][1]: LITERAL_RANGE', 'root.knots[1][1]: LITERAL_RANGE', 'root.knots[1]: SLIDE_SLOPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [5e-324, 1], [10, 1]] }))).toEqual(['root.knots[1]: SLIDE_SLOPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [5e-324, 0], [10, 1]] }))).toEqual([]);
    // Ranges: the same segment with a ref value is refused, because some value of the ref makes the slope infinite.
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, 0], [5e-324, R(LO)], [10, 1]] }))).toEqual(['root.knots[1]: SLIDE_SLOPE']);
    expect(issues(doc({ op: 'slide', x: Y, knots: [[0, R(LO, true)], [1e-300, R(HI)]] }))).toEqual([]);
    expect(one(doc({ op: 'slide', x: Y, knots: [[0, 0], [5e-324, 1]] })).message).toMatch(/finite/);
    // Code-built trees keep SP3b's rules.
    expect(validateExpr(doc({ op: 'slide', x: Y, knots: [[0, -1e308], [1, 1e308]] }), () => undefined)).toEqual([]);
  });

  test('source ops are unknown to the code-built validator, and tap.mute an unknown key there', () => {
    const noises = () => undefined;
    expect(validateExpr(doc(P(LO)), noises).map((i) => `${i.path}: ${i.code}`)).toEqual(['root: UNKNOWN_OP']);
    expect(validateExpr(doc({ op: 'recip', x: C(2) }), noises).map((i) => `${i.path}: ${i.code}`)).toEqual(['root: UNKNOWN_OP']);
    expect(validateExpr(doc({ op: 'tap', name: 't', x: Y, mute: 0 }), noises).map((i) => `${i.path}: ${i.code}`)).toEqual(['root.mute: UNKNOWN_KEY']);
    expect(validateExpr(doc({ op: 'tap', name: 'a.b', x: Y }), noises)).toEqual([]);
  });

  test('the noises are the schema\'s density noises at their static dims (remap none)', () => {
    expect(issues(doc({ op: 'add', a: { op: 'noise2', id: 'jag' }, b: { op: 'noise', id: 'detail' } }))).toEqual([]);
    expect(issues(doc({ op: 'noise', id: 'jag' }))).toEqual(['root.id: NOISE_DIMS']);
    expect(issues(doc({ op: 'noise2', id: 'fz2a' }))).toEqual(['root.id: UNKNOWN_NOISE']);
    expect(issues(doc({ op: 'noise2', id: 'depth' }))).toEqual(['root.id: UNKNOWN_NOISE']);
    expect(issues(doc({ op: 'noise2', id: 'constructor' }))).toEqual(['root.id: UNKNOWN_NOISE']);
  });

  test('the walk goes through recip and param, refs and mutes (mutes ignored), with the SP3b checks', () => {
    const tree = doc({
      op: 'add',
      a: { op: 'tap', name: 'm', mute: 0, x: { op: 'interpolated', x: { op: 'interpolated', x: { op: 'recip', x: C(2) } } } },
      b: { op: 'ref', name: 'd' },
    }, { d: { op: 'mul', a: { op: 'recip', x: P(CS) }, b: { op: 'ref', name: 'missing' } } });
    // Structural issues first; the nesting walk runs only on a structurally valid tree (SP3b's order).
    expect(issues(tree)).toEqual(['defs.d.b.name: UNKNOWN_REF']);
    const nested = doc({ op: 'tap', name: 'm', mute: 0, x: { op: 'interpolated', x: { op: 'neg', x: { op: 'interpolated', x: { op: 'recip', x: P(CS) } } } } });
    expect(issues(nested)).toEqual(['root.x.x.x: NESTED_INTERPOLATED']);
    expect(issues(doc({ op: 'ref', name: 'a' }, { a: { op: 'recip', x: C(1) }, b: { op: 'neg', x: { op: 'ref', name: 'b' } } }))).toEqual(['defs.b.x: REF_CYCLE']);
  });
});

describe('validateDensitySource: issue cap and memo (SP3d spec §1.6, §1.7)', () => {
  test('at most 50 issues, then TOO_MANY_ISSUES at the value ("N more")', () => {
    let root: unknown = C(2e9);
    for (let i = 1; i < 60; i++) root = { op: 'add', a: C(2e9), b: root };
    const out = validateDensitySource(doc(root));
    expect(out.length).toBe(51);
    expect(out.slice(0, 50).every((i) => i.code === 'LITERAL_RANGE')).toBe(true);
    expect(out[50]).toEqual({ path: '', code: 'TOO_MANY_ISSUES', message: '10 more' });
    expect(validateDensitySource(doc(C(1))).length).toBe(0);
  });

  test('a frozen source is validated once (WeakMap memo with a validation counter); an unfrozen one every call', () => {
    const issuesOut: Issue[] = [];
    const clone = checkJson({ root: { op: 'clamp', x: { op: 'y' }, lo: { param: LO }, hi: 1 }, defs: {} }, 'density.defs', issuesOut, 'density');
    expect(issuesOut).toEqual([]);
    expect(Object.isFrozen(clone)).toBe(true);
    const n0 = densitySourceValidations();
    const first = validateDensitySource(clone);
    expect(first.map((i) => `${i.path}: ${i.code}`)).toEqual(['root: CLAMP_ORDER']);
    expect(densitySourceValidations()).toBe(n0 + 1);
    expect(validateDensitySource(clone)).toBe(first);
    expect(densitySourceValidations()).toBe(n0 + 1);
    // The memoised result cannot be changed by a caller.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    // An unfrozen source is validated on every call.
    const loose = { root: { op: 'const', v: 1 }, defs: {} };
    validateDensitySource(loose);
    validateDensitySource(loose);
    expect(densitySourceValidations()).toBe(n0 + 3);
    // The default tree (tier 1's registered clone) hits after its first validation.
    validateDensitySource(DEFAULT_DENSITY_TREE);
    const n1 = densitySourceValidations();
    expect(validateDensitySource(DEFAULT_DENSITY_TREE)).toEqual([]);
    expect(densitySourceValidations()).toBe(n1);
  });

  test('never throws on hostile values', () => {
    const hostile: unknown[] = [null, 3, 'x', [], { root: null, defs: null }, { root: { op: 'recip', x: null }, defs: {} },
      { root: { op: 'param' }, defs: {} }, { root: { op: 'slide', x: Y, knots: [[{ param: LO }], null, [1, {}]] }, defs: {} },
      { root: { op: 'tap', name: 't', x: Y, mute: { param: null } }, defs: { constructor: { op: 'ref', name: 'toString' } } }];
    for (const h of hostile) expect(() => validateDensitySource(h)).not.toThrow();
  });
});

describe('validateDensitySource: whole-tree bounds (SP3d spec §1.7 steps 2-5)', () => {
  const ref = (name: string): unknown => ({ op: 'ref', name });
  /** k nested `neg`s over `x`; `negPath(p, k)` is the path of the node under them. */
  const negs = (k: number, x: unknown): unknown => {
    let out = x;
    for (let i = 0; i < k; i++) out = { op: 'neg', x: out };
    return out;
  };
  const negPath = (p: string, k: number): string => p + '.x'.repeat(k);
  /** A full binary `add` tree of `levels` levels over const leaves: 2^levels − 1 nodes. */
  const full = (levels: number): unknown => (levels === 1 ? C(1) : { op: 'add', a: full(levels - 1), b: full(levels - 1) });
  /** A balanced sum of the given terms. */
  const sum = (terms: unknown[]): unknown => (terms.length === 1 ? terms[0] : {
    op: 'add', a: sum(terms.slice(0, terms.length >> 1)), b: sum(terms.slice(terms.length >> 1)),
  });
  /** dᵢ = add(ref dᵢ₋₁, ref dᵢ₋₁) over d0 = y: structural cost 2^(i+1) − 1, expanded depth 2i + 1. */
  const doubling = (n: number): Record<string, unknown> => {
    const defs: Record<string, unknown> = { d0: Y };
    for (let i = 1; i < n; i++) defs[`d${i}`] = { op: 'add', a: ref(`d${i - 1}`), b: ref(`d${i - 1}`) };
    return defs;
  };

  test('at most 4,096 nodes over the root and every def (TOO_MANY_NODES at the value) and 64 defs (TOO_MANY_DEFS at defs)', () => {
    expect(issues(doc({ op: 'neg', x: full(12) }))).toEqual([]);
    expect(issues(doc({ op: 'add', a: full(12), b: Y }))).toEqual([': TOO_MANY_NODES']);
    expect(one(doc({ op: 'add', a: full(12), b: Y })).message).toBe('4097 nodes (at most 4096)');
    expect(issues(doc(ref('a'), { a: full(12) }))).toEqual([]);
    expect(issues(doc(ref('a'), { a: full(12), b: Y }))).toEqual([': TOO_MANY_NODES']);
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 64; i++) defs[`e${i}`] = Y;
    expect(issues(doc(Y, defs))).toEqual([]);
    expect(issues(doc(Y, { ...defs, e64: Y }))).toEqual(['defs: TOO_MANY_DEFS']);
    expect(one(doc(Y, { ...defs, e64: Y })).message).toBe('65 defs (at most 64)');
    // The counts come first, so the 50-issue cap never hides them.
    expect(issues(doc({ op: 'bogus' }, { ...defs, e64: Y }))).toEqual(['defs: TOO_MANY_DEFS', 'root: UNKNOWN_OP']);
  });

  test('the 60-def doubling chain is refused at defs.d<k> for k ≥ 16, unreachable or under a mute (TOO_COSTLY)', () => {
    const tooCostly = Array.from({ length: 44 }, (_, k) => `defs.d${k + 16}: TOO_COSTLY`);
    expect(issues(doc(C(0), doubling(60)))).toEqual(tooCostly);
    expect(issues(doc({ op: 'tap', name: 't', mute: 0, x: ref('d59') }, doubling(60)))).toEqual(['root: TOO_COSTLY', ...tooCostly]);
    const d16 = validateDensitySource(doc(C(0), doubling(17)));
    expect(d16).toEqual([{ path: 'defs.d16', code: 'TOO_COSTLY', message: 'defs.d16 has structural cost 131071 (at most 65536)' }]);
    // 65,536 is accepted, 65,537 is not (an unreachable def costs like any other root).
    expect(issues(doc(Y, { ...doubling(16), e: { op: 'neg', x: ref('d15') } }))).toEqual([]);
    expect(issues(doc(Y, { ...doubling(16), e: negs(2, ref('d15')) }))).toEqual(['defs.e: TOO_COSTLY']);
    // interpolated costs 1 + 8 × its child.
    expect(issues(doc(Y, { ...doubling(13), e: { op: 'interpolated', x: ref('d12') } }))).toEqual([]);
    expect(issues(doc(Y, { ...doubling(14), e: { op: 'interpolated', x: ref('d13') } }))).toEqual(['defs.e: TOO_COSTLY']);
  });

  test('the expanded depth counts through refs, at most 128 for every root (EXPANDED_TOO_DEEP at its deepest node)', () => {
    // a: 41 levels; b: 40 + the ref + 41 = 82; the root's chain of k negs then the ref reaches k + 1 + 82.
    const defs = { a: negs(40, Y), b: negs(40, ref('a')) };
    expect(issues(doc(negs(45, ref('b')), defs))).toEqual([]);
    const deep = validateDensitySource(doc(negs(46, ref('b')), defs));
    expect(deep).toEqual([{ path: negPath('root', 46), code: 'EXPANDED_TOO_DEEP', message: 'root reaches depth 129 through refs (at most 128)' }]);
    // An unreachable def and a muted subtree are bounded alike (mutes ignored).
    expect(issues(doc(Y, { ...defs, c: negs(46, ref('b')) }))).toEqual([`${negPath('defs.c', 46)}: EXPANDED_TOO_DEEP`]);
    expect(issues(doc({ op: 'tap', name: 't', mute: 0, x: negs(45, ref('b')) }, defs))).toEqual([`${negPath('root', 46)}: EXPANDED_TOO_DEEP`]);
    // Every root that exceeds is named at a node of its own.
    expect(issues(doc(ref('c'), { ...defs, c: negs(46, ref('b')) })))
      .toEqual([`root: EXPANDED_TOO_DEEP`, `${negPath('defs.c', 46)}: EXPANDED_TOO_DEEP`]);
    // The 60-def doubling chain stays within the depth (d59: 119).
    expect(issues(doc(C(0), doubling(60))).every((s) => s.endsWith('TOO_COSTLY'))).toBe(true);
  });

  test('the column cost (mutes applied, refs expanded, noises at their maximum) is at most DENSITY_COLUMN_COST_MAX', () => {
    // 75 `noise detail` refs: (75 × 128 + 74) × 98,304 = 950,992,896 ≤ 954,106,688; 76: 963,674,112.
    const noiseDef = { n: { op: 'noise', id: 'detail' } };
    const terms = (k: number): unknown[] => Array.from({ length: k }, () => ref('n'));
    expect(issues(doc(sum(terms(75)), noiseDef))).toEqual([]);
    expect(validateDensitySource(doc(sum(terms(76)), noiseDef)))
      .toEqual([{ path: '', code: 'COLUMN_COST', message: 'column cost 963674112 (at most 954106688, 64 × the default tree\'s)' }]);
    // A muted tap costs its mute; an interpolated subtree 1,225 per node.
    expect(issues(doc({ op: 'tap', name: 't', mute: 0, x: sum(terms(76)) }, noiseDef))).toEqual([]);
    expect(issues(doc({ op: 'interpolated', x: sum(terms(76)) }, noiseDef))).toEqual([]);
    // An unreachable def does not count (the column evaluates the root).
    expect(issues(doc(Y, { ...noiseDef, big: sum(terms(76)) }))).toEqual([]);
  });

  test('steps 4-5 wait for the earlier steps: a cycle or an over-count skips them, any issue skips step 5', () => {
    const noiseDef = { n: { op: 'noise', id: 'detail' } };
    const big = sum(Array.from({ length: 76 }, () => ref('n')));
    // Step 1 issue + a column-cost excess: only the step-1 issue.
    expect(issues(doc({ op: 'add', a: big, b: { op: 'noise2', id: 'nope' } }, noiseDef))).toEqual(['root.b.id: UNKNOWN_NOISE']);
    // Step 4 issue + a nested interpolated: no nesting issue yet.
    const nested = { op: 'interpolated', x: { op: 'interpolated', x: Y } };
    expect(issues(doc({ op: 'add', a: nested, b: ref('d16') }, doubling(17))))
      .toEqual(['root: TOO_COSTLY', 'defs.d16: TOO_COSTLY']);
    expect(issues(doc(nested))).toEqual(['root.x: NESTED_INTERPOLATED']);
    // A step-1 issue does not hide step 4.
    expect(issues(doc({ op: 'add', a: C(2e9), b: ref('d16') }, doubling(17))))
      .toEqual(['root.a.v: LITERAL_RANGE', 'root: TOO_COSTLY', 'defs.d16: TOO_COSTLY']);
    // A ref cycle skips step 4 (no topological order).
    expect(issues(doc(C(0), { ...doubling(17), z: negs(2, ref('z')) }))).toEqual([`${negPath('defs.z', 2)}: REF_CYCLE`]);
  });

  test('a 20,000-def chain never overflows: the two counts (and a cycle) only', () => {
    const chain: Record<string, unknown> = { d0: Y };
    for (let i = 1; i < 20000; i++) chain[`d${i}`] = ref(`d${i - 1}`);
    expect(issues(doc(ref('d19999'), chain))).toEqual([': TOO_MANY_NODES', 'defs: TOO_MANY_DEFS']);
    expect(issues(doc(C(0), { ...chain, d0: ref('d19999') }))).toEqual([': TOO_MANY_NODES', 'defs: TOO_MANY_DEFS', 'defs.d1: REF_CYCLE']);
  });

  test('the default tree and the U2 / uiSmoke variants pass (terrain muted; islands −10)', () => {
    const copy = (): { root: Record<string, Record<string, Record<string, unknown>>> } => JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE));
    const muted = copy();
    expect(muted.root['a']!['a']!['name']).toBe('terrain');
    muted.root['a']!['a']!['mute'] = 0;
    const islands = copy();
    expect(islands.root['b']!['name']).toBe('islands');
    (islands.root['b']!['x'] as Record<string, unknown>)['v'] = -10;
    for (const t of [DEFAULT_DENSITY_TREE, muted, islands]) expect(validateDensitySource(t)).toEqual([]);
  });
});

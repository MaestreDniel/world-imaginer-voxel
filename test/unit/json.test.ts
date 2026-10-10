import { describe, expect, expectTypeOf, test } from 'vitest';
import { TREE_LIMITS } from '../../src/core/constants';
import { CanonicalError, canonicalCacheHits, canonicalJSON } from '../../src/core/params/canonical';
import { checkJson, countTreeNodes, TREE_KEY_RE, type JsonFormat, type JsonIssueCode, type TreeIssueCode } from '../../src/core/params/json';
import type { Issue, IssueCode } from '../../src/core/params/kit';
import type { ExprErrorCode } from '../../src/gen/density/expr';
import type { RuleErrorCode } from '../../src/gen/surface/rules';

/** Runs tier 1 and lists `path CODE` pairs. */
const run = (v: unknown, format: JsonFormat = 'density', path = format === 'density' ? 'density.defs' : 'surface.rules') => {
  const out: Issue[] = [];
  const value = checkJson(v, path, out, format);
  return { value, issues: out.map((i) => `${i.path} ${i.code}`), raw: out };
};
const ok = (v: unknown, format: JsonFormat = 'density') => {
  const r = run(v, format);
  expect(r.issues).toEqual([]);
  return r.value;
};
/** A value nested `n` containers deep: `[[…[0]…]]` or `{a: {a: … 0}}`, built without recursion. */
const nested = (n: number, kind: 'array' | 'object'): unknown => {
  let v: unknown = 0;
  for (let i = 0; i < n; i++) v = kind === 'array' ? [v] : { a: v };
  return v;
};
const isDeepFrozen = (v: unknown): boolean => {
  const stack = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x !== 'object' || x === null) continue;
    if (!Object.isFrozen(x)) return false;
    for (const k of Object.keys(x)) stack.push((x as Record<string, unknown>)[k]);
  }
  return true;
};

describe('TREE_LIMITS', () => {
  test('the tier-1 bounds of SP3d spec §1.7, in core/constants.ts', () => {
    expect(TREE_LIMITS).toEqual({ depth: 48, values: 65_536, arrayItems: 1_024, stringUnits: 256, textUnits: 131_072, issues: 50, keyLength: 32 });
    expect(Object.isFrozen(TREE_LIMITS)).toBe(true);
  });
  test('the key pattern is ^[A-Za-z][A-Za-z0-9_]{0,31}$', () => {
    expect(TREE_KEY_RE.source).toBe('^[A-Za-z][A-Za-z0-9_]{0,31}$');
    for (const k of ['a', 'Z9', 'terrain', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'a_b', 'x'.repeat(32)]) expect(TREE_KEY_RE.test(k)).toBe(true);
    for (const k of ['', '_a', '1a', 'a.b', 'a-b', '__proto__', 'a b', 'é', 'x'.repeat(33)]) expect(TREE_KEY_RE.test(k)).toBe(false);
  });
});

describe('checkJson: every tier-1 rule at its exact path (D1)', () => {
  test('a valid value passes and is cloned', () => {
    const v = { root: { op: 'add', a: { op: 'const', v: 1.5 }, b: { op: 'y' } }, defs: { constructor: { op: 'const', v: -2 } }, flag: true, s: 'x' };
    const c = ok(v);
    expect(c).toEqual(v);
    expect(c).not.toBe(v);
    expect(Object.isFrozen(v)).toBe(false);
  });

  test('NOT_JSON: null, undefined, functions, symbols, bigints, non-plain objects, holes, accessors', () => {
    expect(run(undefined).issues).toEqual(['density.defs NOT_JSON']);
    expect(run(null).issues).toEqual(['density.defs NOT_JSON']);
    expect(run(undefined, 'surfaceRules').issues).toEqual(['surface.rules.root NOT_JSON']);
    expect(run({ root: { a: null } }).issues).toEqual(['density.defs.root.a NOT_JSON']);
    expect(run({ root: { a: undefined } }).issues).toEqual(['density.defs.root.a NOT_JSON']);
    expect(run({ f: () => 1, s: Symbol('s'), b: 1n }).issues).toEqual(['density.defs.b NOT_JSON', 'density.defs.f NOT_JSON', 'density.defs.s NOT_JSON']);
    expect(run({ d: new Date(0), m: new Map(), r: /x/, k: new (class K {})() }).issues)
      .toEqual(['density.defs.d NOT_JSON', 'density.defs.k NOT_JSON', 'density.defs.m NOT_JSON', 'density.defs.r NOT_JSON']);
    // eslint-disable-next-line no-sparse-arrays
    expect(run({ root: { knots: [[0, 1], , [2, 3]] } }).issues).toEqual(['density.defs.root.knots[1] NOT_JSON']);
    let reads = 0;
    const getter = Object.defineProperty({}, 'g', { enumerable: true, get: () => { reads++; return 1; } });
    expect(run({ x: getter }).issues).toEqual(['density.defs.x.g NOT_JSON']);
    expect(reads).toBe(0);
    // A null-prototype object is plain.
    expect(ok(Object.assign(Object.create(null) as object, { a: 1 }))).toEqual({ a: 1 });
  });

  test('NOT_FINITE and NEGATIVE_ZERO (never normalised)', () => {
    expect(run({ a: NaN, b: Infinity, c: -Infinity, d: JSON.parse('1e999') as number }).issues)
      .toEqual(['density.defs.a NOT_FINITE', 'density.defs.b NOT_FINITE', 'density.defs.c NOT_FINITE', 'density.defs.d NOT_FINITE']);
    expect(run({ root: { op: 'const', v: -0 } }).issues).toEqual(['density.defs.root.v NEGATIVE_ZERO']);
    expect(run(JSON.parse('{"root": {"knots": [[0, -0]]}}')).issues).toEqual(['density.defs.root.knots[0][1] NEGATIVE_ZERO']);
    expect(run(-0).issues).toEqual(['density.defs NEGATIVE_ZERO']);
    expect(run({ kind: 'block', t: -0 }, 'surfaceRules').issues).toEqual(['surface.rules.root.t NEGATIVE_ZERO']);
    expect(ok({ a: 0, b: -1e308, c: 5e-324 })).toEqual({ a: 0, b: -1e308, c: 5e-324 });
  });

  test('BAD_KEY: empty, dotted, __proto__, leading digit or underscore, too long; quoted and truncated to 40', () => {
    const v = JSON.parse('{"defs": {"": 1, "a.b": 2, "__proto__": {"polluted": 1}, "1a": 3, "_a": 4, "ok": 5}}') as unknown;
    expect(run(v).issues).toEqual([
      'density.defs.defs."" BAD_KEY', 'density.defs.defs."1a" BAD_KEY', 'density.defs.defs."__proto__" BAD_KEY',
      'density.defs.defs."_a" BAD_KEY', 'density.defs.defs."a.b" BAD_KEY',
    ]);
    const long = 'k'.repeat(100);
    const r = run({ [long]: 1, [`a\nb\u0000`]: 2 });
    expect(r.issues).toEqual([`density.defs.${JSON.stringify('a\nb\u0000')} BAD_KEY`, `density.defs."${'k'.repeat(39)} BAD_KEY`]);
    expect(r.raw[1]!.path.length).toBe('density.defs.'.length + 40);
    expect(run({ ['x'.repeat(33)]: 1 }).issues).toEqual([`density.defs."${'x'.repeat(33)}" BAD_KEY`]);
    expect(ok({ ['x'.repeat(32)]: 1 })).toEqual({ ['x'.repeat(32)]: 1 });
    // A key in an array item's object, and at the top of a rules value.
    expect(run({ rules: [{ 'b-c': 1 }] }, 'surfaceRules').issues).toEqual(['surface.rules.root.rules[0]."b-c" BAD_KEY']);
    // A surrogate pair is never split by the truncation.
    const pairs = run({ [`${'p'.repeat(38)}\u{1F600}x`]: 1 });
    expect(pairs.raw[0]!.path).toBe(`density.defs."${'p'.repeat(38)}`);
  });

  test('keys are checked before they are written: __proto__ never reaches a prototype', () => {
    const v = JSON.parse('{"__proto__": {"polluted": 1}, "a": {"__proto__": {"polluted": 2}}}') as unknown;
    const r = run(v);
    expect(r.issues).toEqual(['density.defs."__proto__" BAD_KEY', 'density.defs.a."__proto__" BAD_KEY']);
    expect(r.value).toBeUndefined();
    expect((({}) as Record<string, unknown>)['polluted']).toBeUndefined();
    // Object.prototype member names are valid keys and become own data properties of a plain clone.
    const c = ok({ constructor: 1, toString: { op: 'y' }, valueOf: [1] }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.hasOwn(c, 'constructor') && Object.hasOwn(c, 'toString') && Object.hasOwn(c, 'valueOf')).toBe(true);
    expect(c['constructor']).toBe(1);
  });

  test('JSON_TOO_DEEP: container depth ≤ 48, the top container being 1; the deep container is not entered', () => {
    expect(ok(nested(48, 'array'))).toEqual(nested(48, 'array'));
    expect(ok(nested(48, 'object'))).toEqual(nested(48, 'object'));
    expect(run(nested(49, 'array')).issues).toEqual([`density.defs${'[0]'.repeat(48)} JSON_TOO_DEEP`]);
    expect(run(nested(49, 'object')).issues).toEqual([`density.defs${'.a'.repeat(48)} JSON_TOO_DEEP`]);
    expect(run(nested(49, 'object'), 'surfaceRules').issues).toEqual([`surface.rules.root${'.a'.repeat(48)} JSON_TOO_DEEP`]);
  });

  test('ARRAY_TOO_LONG and STRING_TOO_LONG at the offending value', () => {
    expect(ok({ a: new Array<number>(1024).fill(1) })).toBeDefined();
    expect(run({ a: new Array<number>(1025).fill(1) }).issues).toEqual(['density.defs.a ARRAY_TOO_LONG']);
    expect(ok({ s: 'é'.repeat(256) })).toBeDefined();
    expect(run({ s: 'x'.repeat(257), t: ['y'.repeat(300)] }).issues).toEqual(['density.defs.s STRING_TOO_LONG', 'density.defs.t[0] STRING_TOO_LONG']);
  });

  test('JSON_TOO_MANY_VALUES: 65,536 values pass, 65,537 stop the walk with that single issue', () => {
    // 1 top array + 64 arrays + 63 × 1,023 + x numbers.
    const build = (x: number) => [...Array.from({ length: 63 }, () => new Array<number>(1023).fill(1)), new Array<number>(x).fill(1)];
    const c = ok(build(1022));
    expect(canonicalJSON(c).length).toBe(131_071);
    expect(run(build(1023)).issues).toEqual(['density.defs JSON_TOO_MANY_VALUES']);
    // The single issue replaces the issues collected before the bound (here a NOT_FINITE, whose text counts 0).
    const r = run([NaN, ...build(1023)]);
    expect(r.issues).toEqual(['density.defs JSON_TOO_MANY_VALUES']);
    expect(r.raw[0]!.message).toBe('more than 65536 values');
    expect(run(build(1023), 'surfaceRules').issues).toEqual(['surface.rules.root JSON_TOO_MANY_VALUES']);
  });

  test('JSON_TOO_LARGE: the canonical text ≤ 128 KiB, by a running estimate that stops the walk', () => {
    // 512 strings: 2 + 511 + Σ (L + 2) characters.
    const exact = [...new Array<string>(511).fill('s'.repeat(253)), 's'.repeat(252)];
    const c = ok(exact);
    expect(canonicalJSON(c).length).toBe(131_072);
    const r = run([...new Array<string>(512).fill('s'.repeat(253))]);
    expect(r.issues).toEqual(['density.defs JSON_TOO_LARGE']);
    expect(r.raw[0]!.message).toBe('canonical text longer than 131072 characters');
    // Keys count: {"k":…} adds the quoted key and the colon.
    const keyed = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, 'v'.repeat(250)]));
    expect(run(keyed).issues).toEqual(['density.defs JSON_TOO_LARGE']);
  });

  test('the issue list stops at 50 and ends with one TOO_MANY_ISSUES at the leaf path ("N more")', () => {
    const v = Array.from({ length: 60 }, () => new Array<number>(1000).fill(Infinity));
    const r = run(v);
    expect(r.issues).toHaveLength(51);
    expect(r.issues.slice(0, 2)).toEqual(['density.defs[0][0] NOT_FINITE', 'density.defs[0][1] NOT_FINITE']);
    expect(r.issues[49]).toBe('density.defs[0][49] NOT_FINITE');
    expect(r.raw[50]).toEqual({ path: 'density.defs', code: 'TOO_MANY_ISSUES', message: '59950 more' });
    const rules = run({ rules: new Array<number>(51).fill(NaN) }, 'surfaceRules');
    expect(rules.issues.at(-1)).toBe('surface.rules TOO_MANY_ISSUES');
    expect(rules.raw.at(-1)!.message).toBe('1 more');
    expect(run({ rules: new Array<number>(50).fill(NaN) }, 'surfaceRules').issues).toHaveLength(50);
  });

  test('issues are appended to `out` after the issues already there', () => {
    const out: Issue[] = [{ path: 'x', code: 'NOT_NUMBER', message: 'm' }];
    expect(checkJson({ a: null }, 'p', out, 'density')).toBeUndefined();
    expect(out.map((i) => `${i.path} ${i.code}`)).toEqual(['x NOT_NUMBER', 'p.a NOT_JSON']);
  });

  test('an empty leaf path gives node paths alone', () => {
    const out: Issue[] = [];
    checkJson({ root: { a: null }, s: [NaN] }, '', out, 'density');
    checkJson(null, '', out, 'density');
    checkJson({ b: null }, '', out, 'surfaceRules');
    expect(out.map((i) => `${i.path} ${i.code}`)).toEqual(['root.a NOT_JSON', 's[0] NOT_FINITE', ' NOT_JSON', 'root.b NOT_JSON']);
  });
});

describe('checkJson: the budgeted walk (no recursion, no overflow, one issue)', () => {
  test('16,383 arrays of 1,024 numbers: the text estimate (commas included) stops it first', () => {
    const inner = () => new Array<number>(1024).fill(1);
    const v = Array.from({ length: 16 }, (_, i) => Array.from({ length: i === 15 ? 1023 : 1024 }, inner));
    expect(v.flat()).toHaveLength(16_383);
    const t0 = performance.now();
    expect(run(v).issues).toEqual(['density.defs JSON_TOO_LARGE']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test('shared sub-objects are counted at every visit', () => {
    const leaf = new Array<number>(1000).fill(NaN);
    expect(run(new Array<unknown>(100).fill(leaf)).issues).toEqual(['density.defs JSON_TOO_MANY_VALUES']);
    let d: unknown = 1;
    for (let i = 0; i < 40; i++) d = [d, d];
    expect(run(d).issues).toEqual(['density.defs JSON_TOO_LARGE']);
    // A shared object that fits is cloned twice (the clone is a tree).
    const s = { op: 'y' };
    const c = ok({ a: s, b: s }) as Record<string, unknown>;
    expect(c['a']).toEqual(s);
    expect(c['a']).not.toBe(c['b']);
  });

  test('cyclic in-memory objects stop at the depth bound or the count bound', () => {
    const a: Record<string, unknown> = {};
    a['x'] = a;
    expect(run(a).issues).toEqual([`density.defs${'.x'.repeat(48)} JSON_TOO_DEEP`]);
    const b: unknown[] = [];
    b.push(b, b);
    expect(run(b).issues).toEqual(['density.defs JSON_TOO_MANY_VALUES']);
  });

  test('a 100,000-deep value gives one JSON_TOO_DEEP', () => {
    expect(run(nested(100_000, 'array')).issues).toEqual([`density.defs${'[0]'.repeat(48)} JSON_TOO_DEEP`]);
    expect(run(nested(100_000, 'object')).issues).toEqual([`density.defs${'.a'.repeat(48)} JSON_TOO_DEEP`]);
    expect(run(JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)).issues).toEqual([`density.defs${'[0]'.repeat(48)} JSON_TOO_DEEP`]);
  });

  test('250,000 NOT_FINITE values: the count bound stops the walk first (one issue, never 250,000)', () => {
    const v = Array.from({ length: 250 }, () => new Array<number>(1000).fill(Infinity));
    expect(run(v).issues).toEqual(['density.defs JSON_TOO_MANY_VALUES']);
  });
});

describe('checkJson: the identity-preserving frozen clone (§1.7, §1.12)', () => {
  test('object keys in sorted order at every depth, arrays in order', () => {
    const c = ok({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 }, B: 0 }) as Record<string, any>;
    expect(Object.keys(c)).toEqual(['B', 'a', 'b']);
    expect(Object.keys(c['a'])).toEqual(['c', 'd']);
    expect(Object.keys(c['a'].d[0])).toEqual(['y', 'z']);
    expect(JSON.stringify(c)).toBe(canonicalJSON(c));
  });

  test('the clone is deep-frozen, and the input is left as it was', () => {
    const v = { root: { op: 'add', a: { op: 'const', v: 1 }, b: { op: 'y' } }, k: [[1, 2], [3]] };
    const c = ok(v) as Record<string, any>;
    expect(isDeepFrozen(c)).toBe(true);
    expect(() => { c['root'].a.v = 2; }).toThrow(TypeError);
    expect(Object.isFrozen(v) || Object.isFrozen(v.root)).toBe(false);
  });

  test('a registered value is returned as itself, unchecked, for either format and path', () => {
    const c = ok({ root: { op: 'y' } });
    for (const [format, path] of [['density', 'density.defs'], ['surfaceRules', 'x.y'], ['density', '']] as const) {
      const out: Issue[] = [];
      expect(checkJson(c, path, out, format)).toBe(c);
      expect(out).toEqual([]);
    }
    // A frozen value tier 1 did not produce is still checked and cloned.
    const frozen = Object.freeze({ a: Object.freeze({ b: 1 }) });
    const c2 = ok(frozen);
    expect(c2).toEqual(frozen);
    expect(c2).not.toBe(frozen);
    // Primitives pass through (tier 2 rejects them).
    expect(ok(5)).toBe(5);
    expect(ok('s')).toBe('s');
  });
});

describe('canonicalJSON text cache (§1.12)', () => {
  test('a registered value prints from the cache, alone or nested, with the uncached text', () => {
    const v = { root: { op: 'mul', a: { op: 'const', v: 0.1 }, b: { op: 'noise', noise: 'density.noises.jag' } }, defs: {} };
    const c = ok(v);
    const copy = JSON.parse(JSON.stringify(c)) as unknown;
    const h0 = canonicalCacheHits();
    const text = canonicalJSON(c);
    expect(canonicalCacheHits()).toBe(h0 + 1);
    expect(text).toBe(canonicalJSON(copy));
    expect(canonicalCacheHits()).toBe(h0 + 1);
    expect(canonicalJSON({ patch: { density: { defs: c } } })).toBe(canonicalJSON({ patch: { density: { defs: copy } } }));
    expect(canonicalCacheHits()).toBe(h0 + 2);
  });

  test('the cache keeps the 64-level guard: a deep registered value nested too deep still throws the same error', () => {
    const c = ok(nested(48, 'array'));
    let wrapped: unknown = c;
    let wrappedCopy: unknown = nested(48, 'array');
    for (let i = 0; i < 16; i++) { wrapped = [wrapped]; wrappedCopy = [wrappedCopy]; }
    expect(canonicalJSON(wrapped)).toBe(canonicalJSON(wrappedCopy));
    wrapped = [wrapped];
    wrappedCopy = [wrappedCopy];
    let err: unknown;
    try { canonicalJSON(wrappedCopy); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CanonicalError);
    expect(() => canonicalJSON(wrapped)).toThrow((err as Error).message);
  });

  test('unregistered values are not cached', () => {
    const v = { a: { b: 1 } };
    const h0 = canonicalCacheHits();
    canonicalJSON(v);
    canonicalJSON(v);
    expect(canonicalCacheHits()).toBe(h0);
  });
});

describe('countTreeNodes', () => {
  test('counts the objects that carry the format’s discriminator (op / kind)', () => {
    expect(countTreeNodes({ root: { op: 'add', a: { op: 'const', v: 1 }, b: { op: 'ref', name: 't' } }, defs: { t: { op: 'y' } } }, 'density')).toBe(4);
    expect(countTreeNodes({ kind: 'sequence', rules: [{ kind: 'condition', if: { kind: 'not', if: { kind: 'skyOpen' } }, then: { kind: 'block', state: 'stone' } }] }, 'surfaceRules')).toBe(5);
    expect(countTreeNodes({ root: { op: 'slide', knots: [[0, 1]], x: { op: 'y' } } }, 'density')).toBe(2);
    expect(countTreeNodes(5, 'density')).toBe(0);
  });
});

describe('issue codes', () => {
  test('tier-1 codes, and every gen tree code is a TreeIssueCode; both are IssueCodes', () => {
    expectTypeOf<JsonIssueCode>().toEqualTypeOf<
      'NOT_JSON' | 'NOT_FINITE' | 'NEGATIVE_ZERO' | 'BAD_KEY' | 'JSON_TOO_DEEP' | 'JSON_TOO_MANY_VALUES' | 'ARRAY_TOO_LONG'
      | 'STRING_TOO_LONG' | 'JSON_TOO_LARGE' | 'TOO_MANY_ISSUES'>();
    expectTypeOf<ExprErrorCode>().toExtend<TreeIssueCode>();
    expectTypeOf<RuleErrorCode>().toExtend<TreeIssueCode>();
    expectTypeOf<'UNKNOWN_PARAM' | 'PARAM_KIND' | 'RECIP_OPERAND' | 'RECIP_ZERO' | 'LITERAL_RANGE' | 'SLIDE_SLOPE' | 'TOO_MANY_DEFS'
      | 'EXPANDED_TOO_DEEP' | 'TOO_COSTLY' | 'VALUE_RANGE' | 'COLUMN_COST' | 'TOO_MANY_BIOMES' | 'NOT_SOLID' | 'TOO_MANY_ISSUES'>().toExtend<TreeIssueCode>();
    expectTypeOf<JsonIssueCode | TreeIssueCode>().toExtend<IssueCode>();
    const code: IssueCode = 'JSON_TOO_DEEP';
    expect(code).toBe('JSON_TOO_DEEP');
  });

  test('rejected keys count against the value budget: a shared object with bad keys stops the walk fast', () => {
    const bad: Record<string, unknown> = {};
    for (let i = 0; i < 4000; i++) bad[`1_${i}`] = 0;
    const row = Array.from({ length: 1024 }, () => bad);
    const root = Array.from({ length: 32 }, () => row);
    const t0 = performance.now();
    const r = run(root);
    expect(r.issues).toEqual(['density.defs JSON_TOO_MANY_VALUES']);
    const huge = run([{ ['1' + 'x'.repeat(100_000)]: 0 }]);
    expect(huge.issues).toEqual(['density.defs[0]."1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx BAD_KEY']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

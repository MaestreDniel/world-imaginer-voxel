/**
 * The inspector's JSON printer and parser (SP3d spec §3.5, D18): `printTree` writes `op`/`kind` first, the scalar fields
 * in table order, the children in evaluation order, `defs` keys sorted, a node without child nodes and a number array on
 * one line, and a −0 as `-0`; `parseTree` is an iterative parser that returns the value, the text range of every node
 * path and syntax errors with line and column, refuses duplicate keys and keeps a `"__proto__"` key for tier 1 to refuse.
 */
import { describe, expect, test } from 'vitest';
import { checkJson, type JsonFormat } from '../../src/core/params/json';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import type { Issue } from '../../src/core/params/kit';
import { CONDITION_KINDS, FIELDS, RULE_KINDS } from '../../src/gen/surface/rules';
import { lineColumn, nodeAt, parseTree, pathRange, printTree, type TreeRanges } from '../../src/ui/inspector/jsonText';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { testRng } from '../harness/stats';
import { randomSurfaceRules } from '../harness/surfaceFuzz';

/** Deep equality with `Object.is` on every primitive (so −0 ≠ +0) and equal own key sets (order ignored). */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Every value of `v` by its node path in the format's syntax (test-local oracle: `''`/`root` top, `.key`, `[i]`). */
function valuesByPath(v: unknown, format: JsonFormat): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (x: unknown, path: string): void => {
    out.set(path, x);
    if (Array.isArray(x)) x.forEach((c, i) => walk(c, `${path}[${i}]`));
    else if (typeof x === 'object' && x !== null) for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k], path === '' ? k : `${path}.${k}`);
  };
  walk(v, format === 'surfaceRules' ? 'root' : '');
  return out;
}

/** The node paths of `v` in pre-order (objects carrying the format's tag as a string), keys in printing order not needed. */
function nodePaths(v: unknown, format: JsonFormat): Set<string> {
  const tag = format === 'density' ? 'op' : 'kind';
  const out = new Set<string>();
  for (const [p, x] of valuesByPath(v, format)) {
    if (typeof x === 'object' && x !== null && !Array.isArray(x) && typeof (x as Record<string, unknown>)[tag] === 'string') out.add(p);
  }
  return out;
}

/** print ∘ parse is the identity, both ways, and the ranges of printed and parsed text agree and cover their values. */
function roundTrip(value: unknown, format: JsonFormat): void {
  const printed = printTree(value, format);
  const parsed = parseTree(printed.text, format);
  if (!parsed.ok) throw new Error(`printed text does not parse: ${parsed.error.message} at ${parsed.error.line}:${parsed.error.column}`);
  expect(same(parsed.value, value)).toBe(true);
  expect(printTree(parsed.value, format).text).toBe(printed.text);
  expect([...parsed.ranges.byPath]).toEqual([...printed.ranges.byPath]);
  expect(parsed.ranges.nodes).toEqual(printed.ranges.nodes);
  coverage(printed.text, printed.ranges, value, format);
}

/** Every value has a range, and the range's text parses to that value. */
function coverage(text: string, ranges: TreeRanges, value: unknown, format: JsonFormat): void {
  const values = valuesByPath(value, format);
  expect(new Set(ranges.byPath.keys())).toEqual(new Set(values.keys()));
  for (const [p, r] of ranges.byPath) {
    expect(r.start).toBeLessThan(r.end);
    expect(same(JSON.parse(text.slice(r.start, r.end)), values.get(p))).toBe(true);
  }
  expect(new Set(ranges.nodes)).toEqual(nodePaths(value, format));
  const starts = ranges.nodes.map((p) => ranges.byPath.get(p)!.start);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
}

describe('printTree', () => {
  test('the default density tree: op first, scalars, children in evaluation order, leaf nodes and knots on one line', () => {
    const { text } = printTree(DEFAULT_DENSITY_TREE, 'density');
    const lines = text.split('\n');
    expect(lines.slice(0, 5)).toEqual(['{', '  "root": {', '    "op": "max",', '    "a": {', '      "op": "add",']);
    expect(lines.at(-2)).toBe('  "defs": {}');
    expect(lines.at(-1)).toBe('}');
    expect(text).toContain('"knots": [[-64, 0], [-40, 1], [240, 1], [320, 0]]');
    expect(text).toMatch(/"op": "recip",\n\s*"x": \{ "op": "param", "path": "density.noises.jag.clampSigma" \}/);
    expect(text).toContain('"a": { "op": "col", "field": "offset" }');
    expect(text).toContain('"x": { "op": "const", "v": -1000000 }');
    // tap: name before its child; clamp: lo, hi before x; slide: knots before x.
    expect(text).toMatch(/"op": "tap",\n\s*"name": "islands",\n\s*"x": /);
    expect(text).toMatch(/"op": "clamp",\n\s*"lo": 0,\n\s*"hi": 1,\n\s*"x": \{/);
    expect(text).toMatch(/"op": "slide",\n\s*"knots": \[\[-64, 0\], .*\],\n\s*"x": \{ "op": "noise", "id": "overhang" \}/);
    expect(text.endsWith('\n')).toBe(false);
  });

  test('defs keys are sorted, refs and mutes print in place, a −0 prints as -0', () => {
    const tree = {
      defs: { zeta: { op: 'y' }, alpha: { op: 'const', v: -0 }, Mid: { op: 'neg', x: { op: 'ref', name: 'alpha' } } },
      root: { x: { op: 'ref', name: 'zeta' }, mute: { neg: true, param: 'density.detailAmpLo' }, name: 't', op: 'tap' },
    };
    const { text } = printTree(tree, 'density');
    expect(text).toBe([
      '{',
      '  "root": {',
      '    "op": "tap",',
      '    "name": "t",',
      '    "mute": { "param": "density.detailAmpLo", "neg": true },',
      '    "x": { "op": "ref", "name": "zeta" }',
      '  },',
      '  "defs": {',
      '    "Mid": {',
      '      "op": "neg",',
      '      "x": { "op": "ref", "name": "alpha" }',
      '    },',
      '    "alpha": { "op": "const", "v": -0 },',
      '    "zeta": { "op": "y" }',
      '  }',
      '}',
    ].join('\n'));
  });

  test('rules: kind first, the fields in FIELDS order, conditions before then, a node without children on one line', () => {
    const { text } = printTree(DEFAULT_SURFACE_RULES, 'surfaceRules');
    expect(text.startsWith('{\n  "kind": "sequence",\n  "rules": [\n    {\n')).toBe(true);
    expect(text).toContain('{ "kind": "block", "state": "stone" }');
    expect(text).toMatch(/"kind": "condition",\n\s*"if": \{ "kind": "verticalGradient", "trueAtAndBelow": 0, "falseAtAndAbove": 8 \},\n\s*"then": /);
    expect(text).toContain('{ "kind": "noiseThreshold", "noise": "surface.noises.patch", "min": { "param": "surface.patchThreshold" }, "max": 8 }');
    const one = printTree({ kind: 'condition', then: { state: 'sand', kind: 'block' }, if: { kind: 'biome', biomes: ['desert', 'beach'] } }, 'surfaceRules').text;
    expect(one).toBe('{\n  "kind": "condition",\n  "if": { "kind": "biome", "biomes": ["desert", "beach"] },\n  "then": { "kind": "block", "state": "sand" }\n}');
    expect(printTree({ kind: 'sequence', rules: [] }, 'surfaceRules').text).toBe('{ "kind": "sequence", "rules": [] }');
  });

  test('unknown keys print after the known ones, sorted; a value that is not JSON throws', () => {
    expect(printTree({ root: { zz: 1, op: 'y', aa: [true, 'x'] }, defs: {}, extra: 2 }, 'density').text)
      .toBe('{\n  "root": { "op": "y", "aa": [true, "x"], "zz": 1 },\n  "defs": {},\n  "extra": 2\n}');
    expect(() => printTree({ root: { op: 'const', v: Number.NaN }, defs: {} }, 'density')).toThrow(RangeError);
    expect(() => printTree({ root: null, defs: {} }, 'density')).toThrow(RangeError);
  });

  test('FIELDS is exported frozen with every rule and condition kind, names only', () => {
    expect(Object.keys(FIELDS)).toEqual([...RULE_KINDS, ...CONDITION_KINDS]);
    expect(Object.isFrozen(FIELDS)).toBe(true);
    for (const k of Object.keys(FIELDS)) {
      const f = FIELDS[k as keyof typeof FIELDS];
      expect(Object.isFrozen(f)).toBe(true);
      for (const name of f) expect(typeof name).toBe('string');
    }
    expect(FIELDS.stoneDepth).toEqual(['side', 'offset', 'addSurfaceDepth']);
  });
});

describe('print ∘ parse', () => {
  test('is the identity on both default trees, with equal ranges that cover their text', () => {
    roundTrip(DEFAULT_DENSITY_TREE, 'density');
    roundTrip(DEFAULT_SURFACE_RULES, 'surfaceRules');
  });

  test('is the identity on 200 fuzz trees (100 density, −0 included; 100 rule trees of the three styles)', () => {
    const next = testRng(2020);
    let negZero = 0;
    for (let k = 0; k < 100; k++) {
      const tree = randomDensityExpr(next, { noises: SCHEMA_DENSITY_NOISES });
      if (printTree(tree, 'density').text.includes('-0,') || /-0 \}/.test(printTree(tree, 'density').text)) negZero++;
      roundTrip(tree, 'density');
    }
    expect(negZero).toBeGreaterThan(0);
    for (let k = 0; k < 100; k++) roundTrip(randomSurfaceRules(next, { style: (['free', 'fastPath', 'nearMiss'] as const)[k % 3]! }), 'surfaceRules');
  });

  test('a −0 is printed and parsed back as −0, and tier 1 refuses it at its path', () => {
    const tree = { root: { op: 'clamp', x: { op: 'const', v: -0 }, lo: -0, hi: 1 }, defs: {} };
    const { text } = printTree(tree, 'density');
    expect(text).toContain('"lo": -0');
    expect(text).toContain('{ "op": "const", "v": -0 }');
    const r = parseTree(text, 'density');
    if (!r.ok) throw new Error(r.error.message);
    const root = (r.value as { root: { lo: number; x: { v: number } } }).root;
    expect(Object.is(root.lo, -0)).toBe(true);
    expect(Object.is(root.x.v, -0)).toBe(true);
    const out: Issue[] = [];
    expect(checkJson(r.value, '', out, 'density')).toBeUndefined();
    expect(out.map((i) => `${i.path} ${i.code}`)).toEqual(['root.lo NEGATIVE_ZERO', 'root.x.v NEGATIVE_ZERO']);
  });
});

describe('parseTree', () => {
  test('ranges of typed text: any whitespace and key order, rule paths start with root', () => {
    const text = '{"rules":[ {"state":"stone","kind":"block"} ,\n{"kind":"condition","then":{"kind":"bandlands"},"if":{"kind":"not","if":{"kind":"skyOpen"}}}],"kind":"sequence"}';
    const r = parseTree(text, 'surfaceRules');
    if (!r.ok) throw new Error(r.error.message);
    coverage(text, r.ranges, r.value, 'surfaceRules');
    expect(r.ranges.nodes).toEqual(['root', 'root.rules[0]', 'root.rules[1]', 'root.rules[1].then', 'root.rules[1].if', 'root.rules[1].if.if']);
    expect(text.slice(r.ranges.byPath.get('root.rules[1].if')!.start, r.ranges.byPath.get('root.rules[1].if')!.end)).toBe('{"kind":"not","if":{"kind":"skyOpen"}}');
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
  });

  test('syntax errors carry their offset, line and column (1-based)', () => {
    const err = (text: string) => {
      const r = parseTree(text, 'density');
      if (r.ok) throw new Error('parsed');
      return `${r.error.line}:${r.error.column} ${r.error.message}`;
    };
    expect(err('{\n  "root": { "op": "y" },\n  "defs": {\n}')).toBe('4:2 unexpected end of text');
    expect(err('{ "root": [1, 2,] }')).toBe("1:17 expected a value, got ']'");
    expect(err('{ "root": { "op": "y" } "defs": {} }')).toBe("1:25 expected ',' or '}', got '\"'");
    expect(err('[1 2]')).toBe("1:4 expected ',' or ']', got '2'");
    expect(err('{ root: 1 }')).toBe("1:3 expected a string key, got 'r'");
    expect(err('{ "root" 1 }')).toBe("1:10 expected ':', got '1'");
    expect(err('{\n\t"a": "x\ny" }')).toBe('2:9 control character in a string');
    expect(err('{ "a": "abc }')).toBe('1:8 unterminated string');
    expect(err('{ "a": "\\q" }')).toBe('1:9 bad escape \\q');
    expect(err('{ "a": "\\u12G4" }')).toBe('1:9 bad escape \\u12G4');
    expect(err('{ "a": 01 }')).toBe("1:9 expected ',' or '}', got '1'");
    expect(err('{ "a": -x }')).toBe('1:8 bad number');
    expect(err('{ "a": tru }')).toBe("1:8 expected a value, got 't'");
    expect(err('{} {}')).toBe("1:4 unexpected text after the value, got '{'");
    expect(err('')).toBe('1:1 unexpected end of text');
    expect(err('  \n ')).toBe('2:2 unexpected end of text');
  });

  test('numbers, escapes and literals parse as JSON.parse does; 1e999 is Infinity for tier 1 to refuse', () => {
    const text = '{"a":[0,-0,1.5e3,-2E-2,1e999,true,false,null],"s":"q\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00"}';
    const r = parseTree(text, 'density');
    if (!r.ok) throw new Error(r.error.message);
    expect(same(r.value, JSON.parse(text))).toBe(true);
    const out: Issue[] = [];
    checkJson(r.value, '', out, 'density');
    expect(out.map((i) => `${i.path} ${i.code}`)).toEqual(['a[1] NEGATIVE_ZERO', 'a[4] NOT_FINITE', 'a[7] NOT_JSON']);
  });

  test('a duplicate key is a syntax error at its position', () => {
    const r = parseTree('{\n  "root": { "op": "y" },\n  "root": { "op": "y" }\n}', 'density');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ offset: 29, line: 3, column: 3, message: 'duplicate key "root"' });
  });

  test('"__proto__" survives parsing as an own key of a plain object, and tier 1 refuses it at the path its range has', () => {
    const text = '{ "root": { "op": "ref", "name": "a" }, "defs": { "__proto__": { "op": "y" }, "a": { "op": "y" } } }';
    const r = parseTree(text, 'density');
    if (!r.ok) throw new Error(r.error.message);
    const defs = (r.value as { defs: object }).defs;
    expect(Object.keys(defs)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(defs)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(defs, '__proto__')?.value).toEqual({ op: 'y' });
    const out: Issue[] = [];
    expect(checkJson(r.value, '', out, 'density')).toBeUndefined();
    expect(out.map((i) => `${i.path} ${i.code}`)).toEqual(['defs."__proto__" BAD_KEY']);
    const range = r.ranges.byPath.get('defs."__proto__"')!;
    expect(text.slice(range.start, range.end)).toBe('{ "op": "y" }');
    expect(r.ranges.nodes).toEqual(['root', 'defs."__proto__"', 'defs.a']);
  });

  test('a 100,000-deep array parses without a stack overflow (ranges to depth 48) and tier 1 refuses it', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    const r = parseTree(deep, 'density');
    if (!r.ok) throw new Error(r.error.message);
    expect(r.ranges.byPath.size).toBe(49);
    expect(r.ranges.byPath.get('')).toEqual({ start: 0, end: 200_000 });
    expect(r.ranges.byPath.get('[0]'.repeat(48))).toEqual({ start: 48, end: 200_000 - 48 });
    const out: Issue[] = [];
    expect(checkJson(r.value, '', out, 'density')).toBeUndefined();
    expect(out.map((i) => `${i.path} ${i.code}`)).toEqual([`${'[0]'.repeat(48)} JSON_TOO_DEEP`]);
    const open = parseTree('['.repeat(100_000), 'density');
    expect(open.ok ? null : `${open.error.offset} ${open.error.message}`).toBe('100000 unexpected end of text');
  });
});

describe('ranges', () => {
  test('nodeAt is the innermost node whose range holds the offset; pathRange falls back to the longest named prefix', () => {
    const { text, ranges } = printTree(DEFAULT_DENSITY_TREE, 'density');
    const islands = text.indexOf('{ "op": "const", "v": -1000000 }');
    expect(nodeAt(ranges, islands)).toBe('root.b.x');
    expect(nodeAt(ranges, islands + 10)).toBe('root.b.x');
    expect(nodeAt(ranges, text.indexOf('"name": "islands"'))).toBe('root.b');
    expect(nodeAt(ranges, 0)).toBeNull();
    expect(nodeAt(ranges, text.length)).toBeNull();
    expect(pathRange(ranges, 'root.b.x.v')).toEqual(ranges.byPath.get('root.b.x.v'));
    expect(pathRange(ranges, 'root.b.x.nope')).toEqual(ranges.byPath.get('root.b.x'));
    expect(pathRange(ranges, 'defs.gone.x')).toEqual(ranges.byPath.get('defs'));
    expect(pathRange(ranges, 'nowhere')).toEqual(ranges.byPath.get(''));
    const rules = printTree(DEFAULT_SURFACE_RULES, 'surfaceRules').ranges;
    expect(pathRange(rules, 'root.rules[2].if.falseAtAndAbove')).toEqual(rules.byPath.get('root.rules[2].if.falseAtAndAbove'));
    expect(pathRange(rules, 'root.rules[99]')).toEqual(rules.byPath.get('root.rules'));
  });

  test('lineColumn counts lines and columns from 1', () => {
    expect(lineColumn('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn('ab\ncd', 2)).toEqual({ line: 1, column: 3 });
    expect(lineColumn('ab\ncd', 3)).toEqual({ line: 2, column: 1 });
    expect(lineColumn('ab\ncd', 5)).toEqual({ line: 2, column: 3 });
  });
});

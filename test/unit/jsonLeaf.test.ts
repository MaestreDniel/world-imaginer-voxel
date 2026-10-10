import { describe, expect, test } from 'vitest';
import { checkJson } from '../../src/core/params/json';
import {
  applyPatch, buildSchema, checkLeaf, checkParams, diffParams, group, int, jsonLeaf, num, renderReference, type Issue,
} from '../../src/core/params/kit';
import { randomParams, randomPatch, randomValue } from '../harness/params';
import { currentShape } from '../harness/schemaShape';

const T = { scope: 'terrain', stage: 'terrain' } as const;
const TREE = { root: { op: 'add', a: { op: 'const', v: 1 }, b: { op: 'y' } }, defs: {} };
const RULES = { kind: 'sequence', rules: [{ kind: 'block', state: 'stone' }] };
const children = (withJson: boolean) => ({
  a: group('A', 'group a', {
    n: num(0.5, { label: 'n', doc: 'a number', min: 0, max: 1, ...T }),
    ...(withJson ? { t: jsonLeaf(TREE, 'density', { label: 'tree', doc: 'a density tree', ...T }) } : {}),
    k: int(3, { label: 'k', doc: 'an int', min: 1, max: 8, ...T }),
  }),
  ...(withJson ? { r: jsonLeaf(RULES, 'surfaceRules', { label: 'rules', doc: 'a rule tree', ...T }) } : {}),
  m: num(2, { label: 'm', doc: 'another number', min: 0, max: 4, ...T }),
});
const S = buildSchema(group('J', 'json test schema', children(true)));
const PLAIN = buildSchema(group('J', 'json test schema', children(false)));
const leafOf = (path: string) => S.leaves.find((l) => l.path === path)!.leaf;
const brief = (issues: readonly Issue[]) => issues.map((i) => `${i.path} ${i.code}`);
/** A counting xorshift stream. */
const counted = (seed: number) => {
  let s = seed >>> 0 || 1;
  const next = () => {
    next.draws++;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s;
  };
  next.draws = 0;
  return next;
};

describe('the json leaf kind (SP3d spec §1.1, D1)', () => {
  test('jsonLeaf builds an atomic leaf with its format; ParamMeta carries the format only on json leaves', () => {
    const l = jsonLeaf(TREE, 'density', { label: 'tree', doc: 'd', ...T });
    expect(l).toEqual({ tag: 'leaf', kind: 'json', merge: 'atomic', format: 'density', def: TREE, meta: { label: 'tree', doc: 'd', ...T } });
    expect(S.leaves.map((x) => x.path)).toEqual(['a.n', 'a.t', 'a.k', 'r', 'm']);
    expect(S.leaves[1]!.meta).toEqual({ path: 'a.t', label: 'tree', doc: 'a density tree', kind: 'json', format: 'density', scope: 'terrain', stage: 'terrain' });
    expect(S.leaves[3]!.meta.format).toBe('surfaceRules');
    expect(Object.hasOwn(S.leaves[0]!.meta, 'format')).toBe(false);
  });

  test('the schema default is tier 1’s registered frozen clone', () => {
    const d = S.defaults as unknown as { a: { t: unknown }; r: unknown };
    expect(d.a.t).toEqual(TREE);
    expect(d.a.t).not.toBe(TREE);
    expect(Object.isFrozen(d.a.t)).toBe(true);
    const out: Issue[] = [];
    expect(checkJson(d.a.t, 'a.t', out, 'density')).toBe(d.a.t);
    expect(checkJson(d.r, 'r', out, 'surfaceRules')).toBe(d.r);
    expect(out).toEqual([]);
  });

  test('checkLeaf: tier 1 at the leaf path, undefined is NOT_JSON, never a throw', () => {
    const out: Issue[] = [];
    expect(checkLeaf(leafOf('a.t'), undefined, 'a.t', out)).toBeUndefined();
    expect(checkLeaf(leafOf('r'), undefined, 'r', out)).toBeUndefined();
    expect(checkLeaf(leafOf('a.t'), { root: { op: 'const', v: -0 }, defs: { 'a.b': 1 } }, 'a.t', out)).toBeUndefined();
    expect(checkLeaf(leafOf('r'), { kind: 'block', state: null }, 'r', out)).toBeUndefined();
    expect(brief(out)).toEqual(['a.t NOT_JSON', 'r.root NOT_JSON', 'a.t.defs."a.b" BAD_KEY', 'a.t.root.v NEGATIVE_ZERO', 'r.root.state NOT_JSON']);
  });

  test('checkParams and applyPatch clone a new tree once and keep a registered one by identity', () => {
    const d = S.defaults as unknown as { a: { t: unknown } };
    const doc = JSON.parse(JSON.stringify(S.defaults)) as { a: { t: unknown } };
    const r = checkParams(S, doc);
    expect(r.ok && (r.value as unknown as { a: { t: unknown } }).a.t).toEqual(TREE);
    const bad = checkParams(S, { ...doc, a: { ...doc.a, t: { root: [NaN] } } });
    expect(bad.ok ? [] : brief(bad.issues)).toEqual(['a.t.root[0] NOT_FINITE']);

    const edited = { root: { op: 'const', v: 2 }, defs: {} };
    const p1 = applyPatch(S, S.defaults, { a: { t: edited } });
    if (!p1.ok) throw new Error('patch refused');
    const t1 = (p1.value as unknown as { a: { t: unknown } }).a.t;
    expect(t1).toEqual(edited);
    expect(t1).not.toBe(edited);
    expect(Object.isFrozen(t1)).toBe(true);
    // Re-applying the patch that holds the clone (what commitPatch does on every edit) keeps the object.
    const p2 = applyPatch(S, S.defaults, { a: { t: t1, n: 0.25 } });
    expect(p2.ok && (p2.value as unknown as { a: { t: unknown } }).a.t).toBe(t1);
    const p3 = applyPatch(S, S.defaults, { a: { t: d.a.t } });
    expect(p3.ok && p3.value).toBe(S.defaults);
  });

  test('diffParams: a leaf that is the same object is unchanged without being printed; an edited tree is the patch by reference', () => {
    // canonicalJSON would throw on NaN: the identity short-circuit never prints it.
    const odd = { a: { ...S.defaults.a, t: { root: NaN } } };
    const base = { ...S.defaults, ...odd } as typeof S.defaults;
    expect(diffParams(S, base, base)).toEqual({});
    const edited = applyPatch(S, S.defaults, { r: { kind: 'block', state: 'dirt' } });
    if (!edited.ok) throw new Error('patch refused');
    const patch = diffParams(S, S.defaults, edited.value) as { r?: unknown };
    expect(Object.keys(patch)).toEqual(['r']);
    expect(patch.r).toBe((edited.value as unknown as { r: unknown }).r);
  });

  test('renderReference writes "<format> tree, <n> nodes" and an empty range', () => {
    const rows = renderReference(S).split('\n');
    expect(rows[3]).toBe('| `a.t` | json | density tree, 3 nodes |  |  | terrain | tree: a density tree |');
    expect(rows[5]).toBe('| `r` | json | surfaceRules tree, 2 nodes |  |  | terrain | rules: a rule tree |');
  });

  test('the shape lock records json:<format>', () => {
    expect(currentShape(S)).toEqual({ 'a.n': 'number', 'a.t': 'json:density', 'a.k': 'int', r: 'json:surfaceRules', m: 'number' });
  });
});

describe('the random-params harness skips json leaves with no draw (§1.1)', () => {
  test('randomValue returns the leaf default and draws nothing', () => {
    const next = counted(7);
    expect(randomValue(leafOf('a.t'), next)).toBe(leafOf('a.t').def);
    expect(randomValue(leafOf('r'), next)).toBe(leafOf('r').def);
    expect(next.draws).toBe(0);
  });

  test('randomPatch and randomParams draw the other leaves exactly as without the json leaves', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const a = counted(seed);
      const b = counted(seed);
      const withJson = randomPatch(S, a);
      const without = randomPatch(PLAIN, b);
      expect(withJson).toEqual(without);
      expect(a.draws).toBe(b.draws);
      const pa = counted(seed);
      const pb = counted(seed);
      const full = randomParams(S, pa) as unknown as Record<string, Record<string, unknown>>;
      const plain = randomParams(PLAIN, pb) as unknown as Record<string, Record<string, unknown>>;
      expect(pa.draws).toBe(pb.draws);
      expect(full['a']!['t']).toEqual(TREE);
      expect([full['a']!['n'], full['a']!['k'], full['m']]).toEqual([plain['a']!['n'], plain['a']!['k'], plain['m']]);
    }
  });
});

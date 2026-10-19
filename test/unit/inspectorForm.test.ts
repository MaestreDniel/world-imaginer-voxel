/**
 * The Density tab's node form (SP3d spec §3.3, §1.5, D7; §6 `inspectorForm.test.ts`): every operation on hand-built
 * trees — replace op / kind with children kept by position in `SOURCE_CHILD_KEYS` order and the per-kind defaults, the
 * disabled options, wrap, delete (unwrap, `const 0`, a sequence child with the renumbering the selection follows, a
 * referenced def refused with `UNKNOWN_REF`), add def and add rule, rename def with its refs, knots sorted on commit —,
 * the mute toggle's neutral value per parent, ref ↔ literal on every numeric field (density scalar fields included) and
 * `neg`, int fields listing only int targets, the fields shown per node, the commit through a real session, and the
 * two lints.
 */
import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { JsonValue } from '../../src/core/params/json';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { WorldSession } from '../../src/engine/session';
import { createGenContext } from '../../src/gen/context';
import { ALLOWED_REF_TARGETS, SOURCE_CHILD_KEYS, SOURCE_OPS } from '../../src/gen/density/source';
import { probeField } from '../../src/gen/inspect/fieldSlice';
import { CONDITION_KINDS, RULE_KINDS } from '../../src/gen/surface/rules';
import { validateParamTrees } from '../../src/gen/trees';
import type { EditorSession, TreeLeaf } from '../../src/ui/inspector/editorModel';
import {
  addDef, addRule, BLOCK_STATE_OPTIONS, commitFormEdit, deleteNode, densityCostLint, formActions, formFields, LINT_NO_FAST_PATH,
  muteValue, opOptions, refOptions, renameDef, replaceOp, selectionAfterCommit, setField, setKnots, setNumber, setTypedNumber,
  toggleMute, treeLints, wrapNode, type FormEdit,
} from '../../src/ui/inspector/form';
import { parseFieldText } from '../../src/ui/paramPanel/model';
import type { Selection } from '../../src/ui/inspector/model';

const random = (): Seed64 => [5, 11];
const session = (): WorldSession => new WorldSession(random, { validateParams: validateParamTrees });

const withDensity = (tree: unknown, base: Params = DEFAULTS): Params =>
  ({ ...base, density: { ...base.density, defs: tree as JsonValue } });
const withRules = (tree: unknown, base: Params = DEFAULTS): Params =>
  ({ ...base, surface: { ...base.surface, rules: tree as JsonValue } });
const D = (path: string): Selection => ({ leaf: 'density.defs', path });
const R = (path: string): Selection => ({ leaf: 'surface.rules', path });

/** The candidate value of a successful edit (as plain JSON). */
function valueOf(e: FormEdit): unknown {
  if (!e.ok) throw new Error(`refused: ${JSON.stringify(e.issues)}`);
  return JSON.parse(JSON.stringify(e.value));
}
function selectOf(e: FormEdit): Selection {
  if (!e.ok) throw new Error('refused');
  return e.select;
}

const Y = { op: 'y' };
const C = (v: number) => ({ op: 'const', v });
const P = (path: string) => ({ op: 'param', path });
const tree = (root: unknown, defs: Record<string, unknown> = {}) => ({ root, defs });
const block = (state: string) => ({ kind: 'block', state });
const seq = (...rules: unknown[]) => ({ kind: 'sequence', rules });
const iff = (c: unknown, then: unknown) => ({ kind: 'condition', if: c, then });

describe('replace op (density): children by position in SOURCE_CHILD_KEYS order, per-kind defaults', () => {
  const p = withDensity(tree({ op: 'add', a: Y, b: C(2) }, { b: C(1), a: C(3) }));
  test('every source op takes the old children in evaluation order; missing slots const 0, recip const 1', () => {
    for (const op of SOURCE_OPS.filter((o) => o !== 'recip')) {
      const out = (valueOf(replaceOp(p, D('root'), op)) as { root: Record<string, unknown> }).root;
      const slots = SOURCE_CHILD_KEYS[op];
      const expected = slots.map((_, i) => (i === 0 ? Y : i === 1 ? C(2) : C(0)));
      expect([op, slots.map((k) => out[k])]).toEqual([op, expected]);
    }
    const neg = withDensity(tree({ op: 'neg', x: Y }));
    expect((valueOf(replaceOp(neg, D('root'), 'add')) as { root: unknown }).root).toEqual({ op: 'add', a: Y, b: C(0) });
    expect((valueOf(replaceOp(withDensity(tree(C(3))), D('root'), 'recip')) as { root: unknown }).root).toEqual({ op: 'recip', x: C(1) });
    expect((valueOf(replaceOp(withDensity(tree({ op: 'neg', x: P('density.detailAmpHi') })), D('root'), 'recip')) as { root: unknown }).root)
      .toEqual({ op: 'recip', x: P('density.detailAmpHi') });
  });
  test('the scalars take the op defaults; clamp ↔ rangeChoice keep lo and hi', () => {
    const root = (op: string, q = p) => (valueOf(replaceOp(q, D('root'), op)) as { root: Record<string, unknown> }).root;
    expect(root('const')).toEqual(C(0));
    expect(root('clamp')).toEqual({ op: 'clamp', x: Y, lo: 0, hi: 1 });
    expect(root('rangeChoice')).toEqual({ op: 'rangeChoice', x: Y, inside: C(2), outside: C(0), lo: 0, hi: 1 });
    expect(root('slide')).toEqual({ op: 'slide', x: Y, knots: [[-64, 0], [320, 1]] });
    expect(root('noise')).toEqual({ op: 'noise', id: 'overhang' });
    expect(root('noise2')).toEqual({ op: 'noise2', id: 'jag' });
    expect(root('col')).toEqual({ op: 'col', field: 'offset' });
    expect(root('tap')).toEqual({ op: 'tap', name: 'tap1', x: Y });
    expect(root('ref')).toEqual({ op: 'ref', name: 'a' });
    expect(root('param')).toEqual(P([...ALLOWED_REF_TARGETS.keys()][0]!));
    expect(root('param')).toEqual(P('density.noises.jag.clampSigma'));
    const clamp = withDensity(tree({ op: 'clamp', x: Y, lo: { param: 'density.detailAmpLo', neg: true }, hi: 3 }));
    expect(root('rangeChoice', clamp)).toEqual({ op: 'rangeChoice', x: Y, inside: C(0), outside: C(0), lo: { param: 'density.detailAmpLo', neg: true }, hi: 3 });
    const tapped = withDensity(tree({ op: 'tap', name: 'tap1', x: { op: 'neg', x: Y } }, { d: { op: 'tap', name: 'tap2', x: Y } }));
    expect((valueOf(replaceOp(tapped, D('root.x'), 'tap')) as { root: { x: unknown } }).root.x).toEqual({ op: 'tap', name: 'tap3', x: Y });
  });
  test('the current op is a no-op; the selection stays on the node', () => {
    const e = replaceOp(p, D('root'), 'add');
    expect(valueOf(e)).toEqual(JSON.parse(JSON.stringify(p.density.defs)));
    expect(selectOf(replaceOp(p, D('root.a'), 'neg'))).toEqual(D('root.a'));
  });
});

describe('disabled options', () => {
  test('ref while defs is empty; recip over a child that is not a const or param', () => {
    const opts = (q: Params, path: string) => Object.fromEntries(opOptions(q, D(path)).map((o) => [o.op, o.disabled]));
    const def = opts(DEFAULTS, 'root');
    expect(Object.keys(def)).toEqual([...SOURCE_OPS]);
    expect([def['ref'], def['recip']]).toEqual([true, true]);
    expect(Object.entries(def).filter(([, d]) => d).map(([o]) => o)).toEqual(['ref', 'recip']);
    expect(opts(DEFAULTS, 'root.b.x')['recip']).toBe(false);
    expect(opts(withDensity(tree({ op: 'neg', x: P('density.detailAmpLo') })), 'root')['recip']).toBe(false);
    expect(opts(withDensity(tree(Y, { d: C(1) })), 'root')['ref']).toBe(false);
    expect(opOptions(DEFAULTS, D('root.a')).find((o) => o.current)?.op).toBe('add');
    expect(() => replaceOp(DEFAULTS, D('root'), 'ref')).toThrow(RangeError);
    expect(() => replaceOp(DEFAULTS, D('root'), 'recip')).toThrow(RangeError);
  });
  test('rules: every rule kind for a rule, every condition kind for a condition', () => {
    expect(opOptions(DEFAULTS, R('root')).map((o) => o.op)).toEqual([...RULE_KINDS]);
    expect(opOptions(DEFAULTS, R('root.rules[2].if')).map((o) => o.op)).toEqual([...CONDITION_KINDS]);
    expect(opOptions(DEFAULTS, R('root.rules[2].if')).find((o) => o.current)?.op).toBe('verticalGradient');
    expect(opOptions(DEFAULTS, R('root')).some((o) => o.disabled)).toBe(false);
  });
});

describe('replace kind (rules)', () => {
  const p = withRules(seq(iff({ kind: 'skyOpen' }, block('stone')), block('dirt')));
  const at = (q: Params, path: string, kind: string) => valueOf(replaceOp(q, R(path), kind));
  test('sequence ↔ condition keeps the child; leaves take their defaults', () => {
    expect(at(p, 'root', 'condition')).toEqual(iff({ kind: 'skyOpen' }, iff({ kind: 'skyOpen' }, block('stone'))));
    expect(at(withRules(seq()), 'root', 'condition')).toEqual(iff({ kind: 'skyOpen' }, seq()));
    expect(at(p, 'root.rules[0]', 'sequence')).toEqual(seq(seq(block('stone')), block('dirt')));
    expect(at(p, 'root.rules[1]', 'condition')).toEqual(seq(iff({ kind: 'skyOpen' }, block('stone')), iff({ kind: 'skyOpen' }, seq())));
    expect(at(p, 'root.rules[1]', 'sequence')).toEqual(seq(iff({ kind: 'skyOpen' }, block('stone')), seq()));
    expect(at(p, 'root.rules[1]', 'bandlands')).toEqual(seq(iff({ kind: 'skyOpen' }, block('stone')), { kind: 'bandlands' }));
    expect(at(withRules(seq({ kind: 'bandlands' })), 'root.rules[0]', 'block')).toEqual(seq(block('stone')));
  });
  test('condition defaults, and `not` wraps the old condition', () => {
    const cond = (kind: string) => (at(p, 'root.rules[0].if', kind) as { rules: { if: unknown }[] }).rules[0]!.if;
    expect(CONDITION_KINDS.map((k) => cond(k))).toEqual([
      { kind: 'biome', biomes: ['plains'] },
      { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false },
      { kind: 'water', offset: 0, runTop: false },
      { kind: 'yAbove', minY: 63, runTop: false },
      { kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 },
      { kind: 'steep', min: 1 },
      { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 0, max: 8 },
      { kind: 'temperatureBelow', t: 0 },
      { kind: 'skyOpen' },
      { kind: 'lake' },
      { kind: 'not', if: { kind: 'skyOpen' } },
    ]);
  });
});

describe('wrap, delete, add', () => {
  test('wrap: density in a tap with a fresh name (taps of defs counted); a rule in a one-child sequence', () => {
    expect((valueOf(wrapNode(DEFAULTS, D('root.b.x'))) as { root: { b: { x: unknown } } }).root.b.x)
      .toEqual({ op: 'tap', name: 'tap1', x: C(-1e6) });
    const q = withDensity(tree({ op: 'tap', name: 'tap1', x: Y }, { d: { op: 'tap', name: 'tap2', x: C(0) } }));
    expect((valueOf(wrapNode(q, D('root.x'))) as { root: { x: unknown } }).root.x).toEqual({ op: 'tap', name: 'tap3', x: Y });
    expect(selectOf(wrapNode(q, D('root.x')))).toEqual(D('root.x'));
    expect(valueOf(wrapNode(withRules(block('stone')), R('root')))).toEqual(seq(block('stone')));
    expect(formActions(DEFAULTS, R('root.rules[2].if')).wrap).toBe(false);
    expect(() => wrapNode(DEFAULTS, R('root.rules[2].if'))).toThrow(RangeError);
  });
  test('delete (density): one-child nodes unwrap, others become const 0, a def is removed', () => {
    for (const op of ['neg', 'abs', 'square', 'interpolated', 'recip']) {
      const x = op === 'recip' ? C(2) : Y;
      expect([op, (valueOf(deleteNode(withDensity(tree({ op, x })), D('root'))) as { root: unknown }).root]).toEqual([op, x]);
    }
    const one = [
      { op: 'clamp', x: Y, lo: 0, hi: 1 }, { op: 'slide', x: Y, knots: [[0, 0], [1, 1]] }, { op: 'tap', name: 't', x: Y, mute: 0 },
    ];
    for (const n of one) expect((valueOf(deleteNode(withDensity(tree(n)), D('root'))) as { root: unknown }).root).toEqual(Y);
    expect((valueOf(deleteNode(DEFAULTS, D('root.a'))) as { root: { a: unknown } }).root.a).toEqual(C(0));
    expect((valueOf(deleteNode(withDensity(tree({ op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: Y, outside: Y })), D('root'))) as { root: unknown }).root).toEqual(C(0));
    const q = withDensity(tree(Y, { a: C(1), b: C(2) }));
    const e = deleteNode(q, D('defs.a'));
    expect(valueOf(e)).toEqual(tree(Y, { b: C(2) }));
    expect(selectOf(e)).toEqual(D('root'));
  });
  test('delete of a referenced def is refused with UNKNOWN_REF at the refs, and nothing is sent', () => {
    const q = withDensity(tree({ op: 'add', a: { op: 'ref', name: 'a' }, b: Y }, { a: C(1), b: { op: 'ref', name: 'a' } }));
    let sets = 0;
    const s: EditorSession = { state: { params: q }, set() { sets++; throw new Error('sent'); }, reset() { throw new Error('no'); } };
    const r = commitFormEdit(s, deleteNode(q, D('defs.a')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => `${i.path}: ${i.code}`)).toEqual(['root.a.name: UNKNOWN_REF', 'defs.b.name: UNKNOWN_REF']);
    expect(sets).toBe(0);
  });
  test('delete (rules): a sequence child is removed and the selection follows; root and then become empty; not unwraps', () => {
    const p = withRules(seq(block('stone'), block('dirt'), iff({ kind: 'not', if: { kind: 'lake' } }, block('sand'))));
    const mid = deleteNode(p, R('root.rules[1]'));
    expect(valueOf(mid)).toEqual(seq(block('stone'), iff({ kind: 'not', if: { kind: 'lake' } }, block('sand'))));
    expect(selectOf(mid)).toEqual(R('root.rules[1]'));
    const last = deleteNode(p, R('root.rules[2]'));
    expect(valueOf(last)).toEqual(seq(block('stone'), block('dirt')));
    expect(selectOf(last)).toEqual(R('root'));
    expect(valueOf(deleteNode(p, R('root')))).toEqual(seq());
    expect((valueOf(deleteNode(p, R('root.rules[2].then'))) as { rules: unknown[] }).rules[2]).toEqual(iff({ kind: 'not', if: { kind: 'lake' } }, seq()));
    expect((valueOf(deleteNode(p, R('root.rules[2].if'))) as { rules: unknown[] }).rules[2]).toEqual(iff({ kind: 'lake' }, block('sand')));
    expect(formActions(p, R('root.rules[2].if.if')).delete).toBe(false);
    expect(() => deleteNode(p, R('root.rules[2].if.if'))).toThrow(RangeError);
  });
  test('add def (def<k> = const 0, selected) and add rule (block stone appended to a sequence, selected)', () => {
    const e = addDef(DEFAULTS);
    expect((valueOf(e) as { defs: unknown }).defs).toEqual({ def1: C(0) });
    expect(selectOf(e)).toEqual(D('defs.def1'));
    expect((valueOf(addDef(withDensity(tree(Y, { def1: C(1), def3: C(3) })))) as { defs: Record<string, unknown> }).defs['def2']).toEqual(C(0));
    const r = addRule(withRules(seq(block('dirt'))), R('root'));
    expect(valueOf(r)).toEqual(seq(block('dirt'), block('stone')));
    expect(selectOf(r)).toEqual(R('root.rules[1]'));
    expect(formActions(DEFAULTS, R('root.rules[0]')).addRule).toBe(false);
    expect(() => addRule(withRules(block('dirt')), R('root'))).toThrow(RangeError);
  });
});

describe('rename def', () => {
  const q = withDensity(tree(
    { op: 'add', a: { op: 'ref', name: 'base' }, b: { op: 'tap', name: 't', x: { op: 'ref', name: 'base' }, mute: 0 } },
    { base: Y, other: { op: 'neg', x: { op: 'ref', name: 'base' } } },
  ));
  test('renames the def and every ref to it (muted subtrees and other defs too), selected', () => {
    const e = renameDef(q, 'base', 'lift');
    expect(valueOf(e)).toEqual(tree(
      { op: 'add', a: { op: 'ref', name: 'lift' }, b: { op: 'tap', name: 't', x: { op: 'ref', name: 'lift' }, mute: 0 } },
      { lift: Y, other: { op: 'neg', x: { op: 'ref', name: 'lift' } } },
    ));
    expect(selectOf(e)).toEqual(D('defs.lift'));
    expect(formActions(q, D('defs.base')).renameDef).toBe(true);
    expect(formActions(q, D('root')).renameDef).toBe(false);
  });
  test('an existing name is refused; a bad name is refused by tier 1 at commit', () => {
    const e = renameDef(q, 'base', 'other');
    expect(e.ok ? [] : e.issues.map((i) => `${i.path}: ${i.code}`)).toEqual(['defs.other: DEF_EXISTS']);
    const w = session();
    const r = commitFormEdit(w, renameDef(withDensity(tree(Y, { a: C(1) }), w.state.params), 'a', '__proto__'));
    expect(r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.code}`)).toEqual(['defs."__proto__": BAD_KEY']);
  });
});

describe('slide knots are sorted by y on every commit', () => {
  const q = withDensity(tree({ op: 'slide', x: Y, knots: [[-64, 0], [0, 0.5], [320, 1]] }));
  test('the table commit and a cell edit re-sort; a ref sorts by its current value', () => {
    const knots = (e: FormEdit) => (valueOf(e) as { root: { knots: unknown } }).root.knots;
    expect(knots(setKnots(q, D('root'), [[320, 1], [-64, 0], [100, 2]]))).toEqual([[-64, 0], [100, 2], [320, 1]]);
    expect(knots(setNumber(q, D('root'), 'knots[0][0]', { kind: 'literal', value: 200 }))).toEqual([[0, 0.5], [200, 0], [320, 1]]);
    expect(knots(setNumber(q, D('root'), 'knots[1][0]', { kind: 'param', path: 'surface.cliffMinY' })))
      .toEqual([[-64, 0], [{ param: 'surface.cliffMinY' }, 0.5], [320, 1]]);
    expect(knots(setKnots(q, D('root'), [[{ param: 'surface.cliffMinY' }, 1], [50, 0]]))).toEqual([[50, 0], [{ param: 'surface.cliffMinY' }, 1]]);
  });
});

describe('the mute toggle (§1.5, D7)', () => {
  const tap = { op: 'tap', name: 't', x: Y };
  test('the neutral value of the tap’s parent: add 0, mul 1, max −1e6, min 1e6, else 0', () => {
    const under = (op: string) => muteValue(withDensity(tree({ op, a: tap, b: Y })), D('root.a'));
    expect(['add', 'mul', 'max', 'min'].map(under)).toEqual([0, 1, -1e6, 1e6]);
    expect(muteValue(withDensity(tree({ op: 'neg', x: tap })), D('root.x'))).toBe(0);
    expect(muteValue(withDensity(tree({ op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: tap, outside: Y })), D('root.inside'))).toBe(0);
    expect(muteValue(withDensity(tree({ op: 'max', a: Y, b: Y }, { d: tap })), D('defs.d'))).toBe(0);
    expect(muteValue(withDensity(tree(tap)), D('root'))).toBe(0);
    expect([muteValue(DEFAULTS, D('root.a.a')), muteValue(DEFAULTS, D('root.b'))]).toEqual([0, -1e6]);
  });
  test('toggling writes the value, toggling again removes it; only taps', () => {
    const on = toggleMute(DEFAULTS, D('root.b'));
    const b = (valueOf(on) as { root: { b: unknown } }).root.b;
    expect(b).toEqual({ op: 'tap', name: 'islands', x: C(-1e6), mute: -1e6 });
    const muted = withDensity((on as { value: unknown }).value);
    expect((valueOf(toggleMute(muted, D('root.b'))) as { root: { b: unknown } }).root.b).toEqual({ op: 'tap', name: 'islands', x: C(-1e6) });
    expect([formActions(DEFAULTS, D('root.b')).mute, formActions(DEFAULTS, D('root.a')).mute]).toEqual([true, false]);
    expect(() => toggleMute(DEFAULTS, D('root.a'))).toThrow(RangeError);
  });
});

describe('ref ↔ literal on every numeric field, and neg', () => {
  const lo = DEFAULTS.density.detailAmpLo;
  test('const.v ↔ a param node (no negate); a param node back to const(<current value>)', () => {
    const e = setNumber(DEFAULTS, D('root.b.x'), 'v', { kind: 'param', path: 'density.detailAmpLo' });
    expect((valueOf(e) as { root: { b: { x: unknown } } }).root.b.x).toEqual(P('density.detailAmpLo'));
    const p = withDensity((e as { value: unknown }).value);
    expect((valueOf(setNumber(p, D('root.b.x'), 'v', { kind: 'literal' })) as { root: { b: { x: unknown } } }).root.b.x).toEqual(C(lo));
    expect((valueOf(setNumber(p, D('root.b.x'), 'v', { kind: 'param', path: 'surface.snowline' })) as { root: { b: { x: unknown } } }).root.b.x)
      .toEqual(P('surface.snowline'));
    expect((valueOf(setNumber(DEFAULTS, D('root.b.x'), 'v', { kind: 'literal', value: -10 })) as { root: { b: { x: unknown } } }).root.b.x).toEqual(C(-10));
    expect(() => setNumber(DEFAULTS, D('root.b.x'), 'v', { kind: 'param', path: 'density.detailAmpLo', neg: true })).toThrow(RangeError);
    expect(formFields(DEFAULTS, D('root.b.x'))).toEqual([{ type: 'number', key: 'v', value: -1e6, current: -1e6, int: false, negatable: false }]);
  });
  test('density scalar fields: clamp and rangeChoice bounds, knot coordinates, mute', () => {
    const cases: [unknown, string, (n: Record<string, unknown>) => unknown][] = [
      [{ op: 'clamp', x: Y, lo: 0, hi: 1 }, 'lo', (n) => n['lo']],
      [{ op: 'clamp', x: Y, lo: 0, hi: 1 }, 'hi', (n) => n['hi']],
      [{ op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: Y, outside: Y }, 'lo', (n) => n['lo']],
      [{ op: 'rangeChoice', x: Y, lo: 0, hi: 1, inside: Y, outside: Y }, 'hi', (n) => n['hi']],
      [{ op: 'slide', x: Y, knots: [[-64, 0], [320, 1]] }, 'knots[0][1]', (n) => (n['knots'] as unknown[][])[0]![1]],
      [{ op: 'slide', x: Y, knots: [[-64, 0], [320, 1]] }, 'knots[1][1]', (n) => (n['knots'] as unknown[][])[1]![1]],
      [{ op: 'tap', name: 't', x: Y, mute: 0 }, 'mute', (n) => n['mute']],
    ];
    for (const [node, key, read] of cases) {
      const p0 = withDensity(tree(node));
      const root = (e: FormEdit) => (valueOf(e) as { root: Record<string, unknown> }).root;
      const ref = setNumber(p0, D('root'), key, { kind: 'param', path: 'density.detailAmpLo' });
      expect([key, read(root(ref))]).toEqual([key, { param: 'density.detailAmpLo' }]);
      const neg = setNumber(p0, D('root'), key, { kind: 'param', path: 'density.detailAmpLo', neg: true });
      expect([key, read(root(neg))]).toEqual([key, { param: 'density.detailAmpLo', neg: true }]);
      const back = setNumber(withDensity((neg as { value: unknown }).value), D('root'), key, { kind: 'literal' });
      expect([key, read(root(back))]).toEqual([key, 0 - lo]);
      expect([key, read(root(setNumber(p0, D('root'), key, { kind: 'literal', value: 0.25 })))]).toEqual([key, 0.25]);
    }
    expect(() => setNumber(DEFAULTS, D('root.a'), 'lo', { kind: 'literal', value: 1 })).toThrow(RangeError);
  });
  test('the rules’ nine numeric fields, with int fields listing only int targets', () => {
    const conds: [unknown, string, boolean][] = [
      [{ kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false }, 'offset', true],
      [{ kind: 'water', offset: 0, runTop: false }, 'offset', true],
      [{ kind: 'yAbove', minY: 63, runTop: false }, 'minY', true],
      [{ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 }, 'trueAtAndBelow', true],
      [{ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 }, 'falseAtAndAbove', true],
      [{ kind: 'steep', min: 1 }, 'min', false],
      [{ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 0, max: 8 }, 'min', false],
      [{ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 0, max: 8 }, 'max', false],
      [{ kind: 'temperatureBelow', t: 0 }, 't', false],
    ];
    const target = (int: boolean) => (int ? 'surface.cliffMinY' : 'surface.snowline');
    for (const [c, key, int] of conds) {
      const p0 = withRules(iff(c, block('stone')));
      const field = formFields(p0, R('root.if')).find((f) => f.key === key);
      expect([key, field?.type, field?.type === 'number' && field.int, field?.type === 'number' && field.negatable]).toEqual([key, 'number', int, true]);
      const ref = setNumber(p0, R('root.if'), key, { kind: 'param', path: target(int), neg: true });
      const at = (e: FormEdit) => (valueOf(e) as { if: Record<string, unknown> }).if[key];
      expect([key, at(ref)]).toEqual([key, { param: target(int), neg: true }]);
      const back = setNumber(withRules((ref as { value: unknown }).value), R('root.if'), key, { kind: 'literal' });
      expect([key, at(back)]).toEqual([key, 0 - (int ? DEFAULTS.surface.cliffMinY : DEFAULTS.surface.snowline)]);
    }
    expect(refOptions(DEFAULTS, true).map((o) => o.path)).toEqual(['surface.lapseBase', 'surface.cliffMinY']);
    expect(refOptions(DEFAULTS, false).map((o) => o.path)).toEqual([...ALLOWED_REF_TARGETS.keys()]);
    // SP3e adds density.noises.islands.clampSigma after the three SP3b noises (SP3e spec §2.1).
    expect(refOptions(DEFAULTS, false)[3]).toEqual({ path: 'density.noises.islands.clampSigma', label: 'density.noises.islands.clampSigma = 3', value: 3, int: false });
    expect(refOptions(DEFAULTS, false)[4]).toEqual({ path: 'density.detailAmpLo', label: `density.detailAmpLo = ${String(lo)}`, value: lo, int: false });
  });
  test('a non-int target in an int field is refused at commit (PARAM_KIND)', () => {
    const w = session();
    const p0 = withRules(iff({ kind: 'yAbove', minY: 63, runTop: false }, block('stone')), w.state.params);
    const r = commitFormEdit(w, setNumber(p0, R('root.if'), 'minY', { kind: 'param', path: 'surface.snowline' }));
    expect(r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.code}`)).toEqual(['root.if.minY: PARAM_KIND']);
  });
});

describe('the fields of a node', () => {
  test('density: def name, tap name and mute, selects of noises, sample fields and defs', () => {
    expect(formFields(DEFAULTS, D('root.b'))).toEqual([{ type: 'name', key: 'name', value: 'islands' }]);
    const keys = (q: Params, path: string) => formFields(q, D(path)).map((f) => `${f.type}:${f.key}`);
    const q = withDensity(tree({ op: 'add', a: { op: 'noise', id: 'overhang' }, b: { op: 'ref', name: 'd' } }, { d: { op: 'col', field: 'E' } }));
    expect(keys(q, 'defs.d')).toEqual(['name:defName', 'select:field']);
    expect(formFields(q, D('root.a'))).toEqual([{ type: 'select', key: 'id', value: 'overhang', options: ['overhang', 'detail', 'islands'] }]);
    expect(formFields(q, D('root.b'))).toEqual([{ type: 'select', key: 'name', value: 'd', options: ['d'] }]);
    expect(keys(withDensity((toggleMute(DEFAULTS, D('root.b')) as { value: unknown }).value), 'root.b')).toEqual(['name:name', 'number:mute']);
    expect(keys(DEFAULTS, 'root.a')).toEqual([]);
  });
  test('rules: FIELDS without children; block states collide; set a select, a boolean, a biome list', () => {
    expect(BLOCK_STATE_OPTIONS).toContain('stone');
    expect(BLOCK_STATE_OPTIONS).not.toContain('air');
    const p0 = withRules(iff({ kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false }, block('dirt')));
    expect(formFields(p0, R('root.if')).map((f) => `${f.type}:${f.key}`)).toEqual(['select:side', 'number:offset', 'boolean:addSurfaceDepth']);
    expect(formFields(p0, R('root'))).toEqual([]);
    expect(formFields(p0, R('root.then'))).toEqual([{ type: 'select', key: 'state', value: 'dirt', options: BLOCK_STATE_OPTIONS }]);
    expect((valueOf(setField(p0, R('root.then'), 'state', 'sand')) as { then: unknown }).then).toEqual(block('sand'));
    expect((valueOf(setField(p0, R('root.if'), 'addSurfaceDepth', true)) as { if: Record<string, unknown> }).if['addSurfaceDepth']).toBe(true);
    const b = withRules(iff({ kind: 'biome', biomes: ['plains'] }, block('dirt')));
    expect((valueOf(setField(b, R('root.if'), 'biomes', ['desert', 'beach'])) as { if: unknown }).if).toEqual({ kind: 'biome', biomes: ['desert', 'beach'] });
    expect(() => setField(p0, R('root.if'), 'offset', 'x')).toThrow(RangeError);
    expect((valueOf(setField(DEFAULTS, D('root.b'), 'name', 'isles')) as { root: { b: { name: string } } }).root.b.name).toBe('isles');
  });
});

describe('commit through the session', () => {
  test('one session.set of the leaf: one undo step, the selection followed', () => {
    const w = session();
    const r = commitFormEdit(w, toggleMute(w.state.params, D('root.a.a')));
    expect(r).toEqual({ ok: true, select: D('root.a.a') });
    expect((w.state.params.density.defs as { root: { a: { a: { mute?: number } } } }).root.a.a.mute).toBe(0);
    expect(w.modifiedCount('')).toBe(1);
    expect(w.canUndo).toBe(true);
    w.undo();
    expect((w.state.params.density.defs as { root: { a: { a: { mute?: number } } } }).root.a.a.mute).toBeUndefined();
  });
  test('a tier-2-invalid candidate is never sent; a session refusal lists its issues', () => {
    const w = session();
    const before = w.state.params.density.defs;
    const r = commitFormEdit(w, setNumber(w.state.params, D('root.b.x'), 'v', { kind: 'literal', value: 2e9 }));
    expect(r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.code}`)).toEqual(['root.b.x.v: LITERAL_RANGE']);
    expect(w.state.params.density.defs).toBe(before);
    const refusing: EditorSession = {
      state: w.state,
      set: () => ({ ok: false, issues: [{ path: 'density.defs.root', code: 'UNKNOWN_OP', message: 'no' }, { path: 'density.defs', code: 'COLUMN_COST', message: 'no' }] }),
      reset: () => { throw new Error('no'); },
    };
    const leaf: TreeLeaf = 'density.defs';
    const r2 = commitFormEdit(refusing, toggleMute(w.state.params, { leaf, path: 'root.b' }));
    expect(r2.ok ? [] : r2.issues.map((i) => `${i.path}: ${i.code}`)).toEqual(['root: UNKNOWN_OP', ': COLUMN_COST']);
  });
});

describe('the Density tab\'s commits (§3.2, §3.3: as the parameter panel\'s valueField)', () => {
  test('typed literal text commits like valueField: the panel\'s parse, NOT_NUMBER naming the text, a typed −0 as 0', () => {
    const outcome = (text: string, sel: Selection = D('root.b.x'), key = 'v'): string => {
      const w = session();
      const r = commitFormEdit(w, setTypedNumber(w.state.params, sel, key, text));
      if (!r.ok) return r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('; ');
      const node = JSON.parse(JSON.stringify(w.state.params.density.defs)).root.b.x as Record<string, unknown>;
      return `ok ${Object.is(node[key], -0) ? '-0' : String(node[key])}`;
    };
    expect(outcome('0,5')).toBe('root.b.x.v: NOT_NUMBER — expected a number, got "0,5"');
    expect(outcome('1,5')).toBe('root.b.x.v: NOT_NUMBER — expected a number, got "1,5"');
    expect(outcome('')).toBe('root.b.x.v: NOT_NUMBER — expected a number, got ""');
    expect(outcome('   ')).toBe('root.b.x.v: NOT_NUMBER — expected a number, got ""');
    expect(outcome(' 7 ')).toBe('ok 7');
    expect(outcome('-0')).toBe('ok 0');
    expect(outcome('0x10')).toBe('ok 16');
    expect(outcome('-.5e1')).toBe('ok -5');
    expect(outcome('1e999')).toBe('root.b.x.v: NOT_FINITE — expected a finite number, got Infinity');
    expect(outcome('NaN')).toBe('root.b.x.v: NOT_FINITE — expected a finite number, got NaN');
    // The same reading as the panel's field: a number for the same texts, the trimmed text otherwise.
    for (const text of ['0,5', '', ' 7 ', '-0', '0x10', '1e999', 'abc']) {
      const v = parseFieldText(text);
      const e = setTypedNumber(DEFAULTS, D('root.b.x'), 'v', text);
      expect(e.ok, text).toBe(typeof v === 'number');
    }
    // A clamp bound and a knot cell take the same reading.
    const clamp = withDensity({ root: { op: 'clamp', x: { op: 'y' }, lo: 0, hi: 1 }, defs: {} });
    expect((valueOf(setTypedNumber(clamp, D('root'), 'hi', ' 2.5 ')) as { root: { hi: number } }).root.hi).toBe(2.5);
    const refused = setTypedNumber(clamp, D('root'), 'lo', '0,25');
    expect(refused.ok ? [] : refused.issues).toEqual([{ path: 'root.lo', code: 'NOT_NUMBER', message: 'expected a number, got "0,25"' }]);
    const slide = withDensity({ root: { op: 'slide', x: { op: 'y' }, knots: [[-64, 0], [320, 1]] }, defs: {} });
    expect((valueOf(setTypedNumber(slide, D('root'), 'knots[1][1]', '-0')) as { root: { knots: number[][] } }).root.knots[1]![1]).toBe(0);
  });

  test('a row mute keeps the current selection; the form mute keeps the tap', () => {
    const w = session();
    const before = w.state.params;
    const r = commitFormEdit(w, toggleMute(before, D('root.a.a')));
    if (!r.ok) throw new Error('refused');
    // The form's own mute acts on the selected tap and keeps it; the row's checkbox keeps whatever was selected.
    expect(selectionAfterCommit('form', D('root.a.a'), r.select)).toEqual(D('root.a.a'));
    expect(selectionAfterCommit('row', D('root'), r.select)).toEqual(D('root'));
    expect(selectionAfterCommit('row', D('root.b.x'), r.select)).toEqual(D('root.b.x'));
    expect(selectionAfterCommit('row', R('root.rules[1]'), r.select)).toEqual(R('root.rules[1]'));
    // Why it matters: the selected root shows the muted world, while a selected muted tap shows its unmuted subtree.
    const ctx0 = createGenContext(seedFromInput('42'), before);
    const ctx1 = createGenContext(seedFromInput('42'), w.state.params);
    const at = (ctx: typeof ctx0, path: string) => probeField(ctx, 'node', path, 5, 70, -9, () => false);
    expect(at(ctx1, 'root')).not.toBe(at(ctx0, 'root'));
    expect(at(ctx1, 'root.a.a')).toBe(at(ctx0, 'root.a.a'));
  });
});

describe('the two lints (§3.3)', () => {
  const noises = (k: number): unknown => {
    let e: unknown = { op: 'noise', id: 'overhang' };
    for (let i = 1; i < k; i++) e = { op: 'add', a: e, b: { op: 'noise', id: 'overhang' } };
    return { op: 'interpolated', x: e };
  };
  test('defaults: none', () => {
    expect(treeLints(DEFAULTS)).toEqual([]);
  });
  test('no fast path when a leaf is neither depth-bounded nor Y-only', () => {
    expect(treeLints(withRules(seq(iff({ kind: 'biome', biomes: ['plains'] }, block('stone')))))).toEqual([LINT_NO_FAST_PATH]);
    expect(treeLints(withRules(seq(block('stone'))))).toEqual([]);
  });
  test('density cost above 4 × the default root’s work cost (569 at the defaults)', () => {
    // interpolated(add of k overhang noises): 1 + 8 × (16k + k − 1).
    expect(treeLints(withDensity(tree(noises(16))))).toEqual([]);
    expect(treeLints(withDensity(tree(noises(20))))).toEqual([densityCostLint(2713 / 569)]);
    expect(densityCostLint(2713 / 569)).toBe('density cost ≈ 4.8 × the default');
  });
});

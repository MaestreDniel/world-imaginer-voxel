import { describe, expect, expectTypeOf, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { RuleValidationError, type RuleValidationIssue } from '../../src/gen/surface/rules';
import { freezeRules, resolveRules, rulesSourceValidations, type RulesSourceIssue } from '../../src/gen/surface/source';
import { surfaceOpsRules } from '../../src/metrics/sp3cGoldens';
import { ctxFor, paramsWith } from '../harness/gen';
import { legacyDefaultSurfaceRules } from '../harness/legacyTrees';

type Node = Record<string, unknown>;
const block = (state: string): Node => ({ kind: 'block', state });
const seq = (...rules: unknown[]): Node => ({ kind: 'sequence', rules });
const when = (c: Node, then: unknown): Node => ({ kind: 'condition', if: c, then });

/** Params whose ref targets have values distinct from their defaults (all on the q15 grid). */
const P = paramsWith({
  density: { detailAmpLo: 0.25, noises: { jag: { clampSigma: 4 } } },
  surface: { patchThreshold: 0.75, snowline: -0.25, cliffSteep: 2.5, cliffMinY: 120, lapseBase: 100, noises: { patch: { clampSigma: 5 } } },
});

/** Each of the nine numeric fields as a ref (literal elsewhere), in one tree; every order check holds over the ranges. */
const SOURCE = (): Node => seq(
  when({ kind: 'stoneDepth', side: 'floor', offset: { param: 'surface.cliffMinY', neg: true }, addSurfaceDepth: true }, block('stone')),
  when({ kind: 'water', offset: { param: 'surface.lapseBase' }, runTop: false }, block('dirt')),
  when({ kind: 'yAbove', minY: { param: 'surface.cliffMinY' }, runTop: true }, block('stone')),
  when({ kind: 'verticalGradient', trueAtAndBelow: { param: 'surface.cliffMinY', neg: true }, falseAtAndAbove: 384 }, block('deepslate')),
  when({ kind: 'steep', min: { param: 'surface.cliffSteep' } }, block('gravel')),
  when({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: { param: 'surface.noises.patch.clampSigma', neg: true }, max: { param: 'surface.patchThreshold' } }, block('clay')),
  when({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: { param: 'density.noises.jag.clampSigma', neg: true }, max: 8 }, block('mud')),
  when({ kind: 'temperatureBelow', t: { param: 'surface.snowline' } }, block('snow_block')),
  when({ kind: 'biome', biomes: ['desert', 'beach'] }, block('sand')),
  when({ kind: 'verticalGradient', trueAtAndBelow: -384, falseAtAndAbove: { param: 'surface.lapseBase' } }, block('deepslate')),
  when({ kind: 'temperatureBelow', t: { param: 'density.detailAmpLo', neg: true } }, block('snow_block')),
  block('stone'),
);

/** SOURCE with every ref replaced by its value in P, as written by hand. */
const EXPECTED = (): Node => seq(
  when({ kind: 'stoneDepth', side: 'floor', offset: -120, addSurfaceDepth: true }, block('stone')),
  when({ kind: 'water', offset: 100, runTop: false }, block('dirt')),
  when({ kind: 'yAbove', minY: 120, runTop: true }, block('stone')),
  when({ kind: 'verticalGradient', trueAtAndBelow: -120, falseAtAndAbove: 384 }, block('deepslate')),
  when({ kind: 'steep', min: 2.5 }, block('gravel')),
  when({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -5, max: 0.75 }, block('clay')),
  when({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -4, max: 8 }, block('mud')),
  when({ kind: 'temperatureBelow', t: -0.25 }, block('snow_block')),
  when({ kind: 'biome', biomes: ['desert', 'beach'] }, block('sand')),
  when({ kind: 'verticalGradient', trueAtAndBelow: -384, falseAtAndAbove: 100 }, block('deepslate')),
  when({ kind: 'temperatureBelow', t: -0.25 }, block('snow_block')),
  block('stone'),
);

/** Every object and array of `v` (shared ones once). */
function containers(v: unknown): object[] {
  const out: object[] = [];
  const seen = new Set<object>();
  const walk = (x: unknown): void => {
    if (typeof x !== 'object' || x === null || seen.has(x)) return;
    seen.add(x);
    out.push(x);
    for (const c of Object.values(x)) walk(c);
  };
  walk(v);
  return out;
}

/** Every number of `v`, in DFS order. */
function numbers(v: unknown): number[] {
  if (typeof v === 'number') return [v];
  if (typeof v !== 'object' || v === null) return [];
  return Object.values(v).flatMap(numbers);
}

describe('resolveRules (SP3d spec §1.6): refs → numbers, nothing else changes', () => {
  test('every ref in the nine numeric fields becomes its target\'s value in params (0 − v for neg); literals and the rest are kept', () => {
    expect(P.surface.cliffMinY).toBe(120);
    expect(P.density.noises.jag.clampSigma).toBe(4);
    expect(P.surface.noises.patch.clampSigma).toBe(5);
    const tree = resolveRules(SOURCE(), P);
    expect(canonicalJSON(tree)).toBe(canonicalJSON(EXPECTED()));
  });

  test('the values follow params (the same source at the defaults)', () => {
    const d = paramsWith();
    const t = resolveRules(SOURCE(), d) as unknown as { rules: Array<{ if: Node }> };
    expect(t.rules[2]!.if['minY']).toBe(d.surface.cliffMinY);
    expect(t.rules[4]!.if['min']).toBe(d.surface.cliffSteep);
    expect(t.rules[5]!.if['min']).toBe(0 - d.surface.noises.patch.clampSigma);
    expect(t.rules[5]!.if['max']).toBe(d.surface.patchThreshold);
    expect(t.rules[6]!.if['min']).toBe(0 - d.density.noises.jag.clampSigma);
    expect(t.rules[7]!.if['t']).toBe(d.surface.snowline);
  });

  test('a negated ref of a target at 0 resolves to +0, never −0 (so the tree canonicalises)', () => {
    const p = paramsWith({ surface: { patchThreshold: 0 }, density: { detailAmpLo: 0 } });
    const src = seq(when({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -8, max: { param: 'surface.patchThreshold', neg: true } }, block('mud')),
      when({ kind: 'steep', min: { param: 'density.detailAmpLo', neg: true } }, block('stone')));
    const t = resolveRules(src, p);
    const zeros = numbers(t).filter((v) => v === 0);
    expect(zeros.length).toBe(2);
    for (const z of zeros) expect(Object.is(z, 0)).toBe(true);
    expect(() => canonicalJSON(t)).not.toThrow();
  });

  test('a fresh tree, deep-frozen at every depth; the source is neither changed nor frozen', () => {
    const src = SOURCE();
    const before = canonicalJSON(src);
    const t = resolveRules(src, P);
    expect(t).not.toBe(src);
    for (const c of containers(t)) expect(Object.isFrozen(c)).toBe(true);
    expect(canonicalJSON(src)).toBe(before);
    expect(Object.isFrozen(src)).toBe(false);
    expect(() => { (t as unknown as { rules: unknown[] }).rules.push(block('stone')); }).toThrow(TypeError);
    expect(() => { ((t as unknown as { rules: Array<{ if: Node }> }).rules[4]!.if)['min'] = 9; }).toThrow(TypeError);
  });

  test('the default source: the legacy tree at the defaults, from tier 2\'s memo (validated at most once, never again)', () => {
    const d = paramsWith();
    resolveRules(DEFAULT_SURFACE_RULES, d);
    const n = rulesSourceValidations();
    const a = resolveRules(DEFAULT_SURFACE_RULES, d), b = resolveRules(DEFAULT_SURFACE_RULES, P);
    surfaceContextOf(ctxFor('42'));
    surfaceContextOf(ctxFor('42', { surface: { snowline: 0.5 } }));
    expect(rulesSourceValidations()).toBe(n);
    expect(a).not.toBe(b);
    expect(canonicalJSON(a)).toBe(canonicalJSON(legacyDefaultSurfaceRules(d.surface)));
    expect(canonicalJSON(b)).toBe(canonicalJSON(legacyDefaultSurfaceRules(P.surface)));
    // An unfrozen source is validated on every call.
    const src = SOURCE();
    resolveRules(src, P);
    const m = rulesSourceValidations();
    resolveRules(src, P);
    expect(rulesSourceValidations()).toBe(m + 1);
  });

  test('an invalid source throws a RuleValidationError carrying tier 2\'s issues at their source paths', () => {
    const cases: ReadonlyArray<readonly [unknown, readonly string[]]> = [
      [block('air'), ['root.state NOT_SOLID']],
      [when({ kind: 'steep', min: { param: 'surface.nope' } }, block('stone')), ['root.if.min UNKNOWN_PARAM']],
      [when({ kind: 'yAbove', minY: { param: 'surface.cliffSteep' }, runTop: true }, block('stone')), ['root.if.minY PARAM_KIND']],
      [when({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: { param: 'surface.patchThreshold' }, max: { param: 'surface.patchThreshold' } }, block('mud')), ['root.if RANGE_ORDER']],
      [when({ kind: 'steep', min: { param: 'surface.cliffSteep', neg: false } }, block('stone')), ['root.if.min BAD_FIELD']],
    ];
    for (const [src, want] of cases) {
      let err: unknown;
      try { resolveRules(src, P); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(RuleValidationError);
      expect((err as RuleValidationError).issues.map((i) => `${i.path} ${i.code}`)).toEqual(want);
    }
  });

  test('a RuleValidationError carries tier 2\'s issue type', () => {
    expectTypeOf<RulesSourceIssue>().toExtend<RuleValidationIssue>();
    expectTypeOf<RuleValidationError['issues'][number]>().toEqualTypeOf<RuleValidationIssue>();
  });
});

describe('freezing (SP3d spec §1.6, D10): one frozen tree per SurfaceContext', () => {
  test('the default context: sc.rules, compiled.rules and reference.rules are one tree, frozen at every depth; mutating it throws', () => {
    const sc = createSurfaceContext(ctxFor('42'));
    expect(sc.compiled.rules).toBe(sc.rules);
    expect(sc.reference.rules).toBe(sc.rules);
    for (const c of containers(sc.rules)) expect(Object.isFrozen(c)).toBe(true);
    const r = sc.rules as unknown as { rules: Array<{ then: { rules: Array<{ if: Node }> } }> };
    expect(() => { r.rules[1]!.then.rules[1]!.if['min'] = 0; }).toThrow(TypeError);
    expect(() => { r.rules.pop(); }).toThrow(TypeError);
  });

  test('an explicit tree is frozen in place (identity kept, values untouched), also when part of it was frozen already', () => {
    const tree = legacyDefaultSurfaceRules(paramsWith().surface) as unknown as { rules: Array<Node & { if: Node; then: Node }> };
    // A partly frozen tree: rule [2] frozen at its top only, its condition and block not.
    Object.freeze(tree.rules[2]!);
    expect(Object.isFrozen(tree.rules[2]!.if)).toBe(false);
    const before = canonicalJSON(tree);
    const sc = createSurfaceContext(ctxFor('42'), tree);
    expect(sc.rules).toBe(tree);
    expect(sc.compiled.rules).toBe(tree);
    expect(sc.reference.rules).toBe(tree);
    expect(canonicalJSON(tree)).toBe(before);
    for (const c of containers(tree)) expect(Object.isFrozen(c)).toBe(true);
    expect(() => { tree.rules[2]!.if['falseAtAndAbove'] = 12; }).toThrow(TypeError);
    expect(() => { tree.rules[0]!.then['state'] = 'stone'; }).toThrow(TypeError);
  });

  test('the sp3c.surface.ops golden source is frozen in place and compiles as before', () => {
    const tree = surfaceOpsRules();
    const before = canonicalJSON(tree);
    const sc = createSurfaceContext(ctxFor('42'), tree);
    expect(sc.rules).toBe(tree);
    expect(canonicalJSON(sc.rules)).toBe(before);
    for (const c of containers(tree)) expect(Object.isFrozen(c)).toBe(true);
  });

  test('freezeRules: shared and cyclic objects visited once; other values left alone; returns its argument', () => {
    const shared: Node = { kind: 'lake' };
    const t: Node = seq(when(shared, block('clay')), when(shared, block('mud')));
    expect(freezeRules(t)).toBe(t);
    for (const c of containers(t)) expect(Object.isFrozen(c)).toBe(true);
    const cyc: Node = { a: [] as unknown[] };
    (cyc['a'] as unknown[]).push(cyc);
    expect(freezeRules(cyc)).toBe(cyc);
    expect(Object.isFrozen(cyc) && Object.isFrozen(cyc['a'])).toBe(true);
    const bytes = new Uint8Array(4);
    const holder: Node = { bytes };
    freezeRules(holder);
    expect(Object.isFrozen(holder)).toBe(true);
    expect(Object.isFrozen(bytes)).toBe(false);
    expect(freezeRules(3)).toBe(3);
    expect(freezeRules(null)).toBe(null);
  });
});

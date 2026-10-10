import { describe, expect, expectTypeOf, test } from 'vitest';
import { RULES_COLUMN_COST_MAX } from '../../src/core/constants';
import { DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { checkJson, type TreeIssueCode } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import { rulesColumnCost } from '../../src/gen/inspect/cost';
import {
  rulesSourceValidations, validateRulesSource, type RuleParamRef, type RulesSourceCode, type RulesSourceIssue,
} from '../../src/gen/surface/source';
import { validateRules, type RuleErrorCode, type RuleRefCode, type RuleSourceMode } from '../../src/gen/surface/rules';
import { surfaceOpsRules } from '../../src/metrics/sp3cGoldens';
import { COLLIDE, REGISTRY } from '../../src/world/blocks/index';
import { COLLIDE_NONE } from '../../src/world/blocks/kinds';

type Node = Record<string, unknown>;
const block = (state: string): Node => ({ kind: 'block', state });
const seq = (...rules: unknown[]): Node => ({ kind: 'sequence', rules });
const when = (c: Node, then: unknown): Node => ({ kind: 'condition', if: c, then });
const ref = (param: string, neg = false): Node => (neg ? { param, neg: true } : { param });
const lines = (issues: readonly RulesSourceIssue[]): string[] => issues.map((i) => `${i.path}: ${i.code}`);
const check = (tree: unknown): string[] => lines(validateRulesSource(tree));
/** A tree of one condition rule over `c` (a block under it), so the condition's path is `root.if`. */
const under = (c: Node): Node => when(c, block('stone'));

/** The nine numeric fields (§1.3), each in a minimal valid condition, `int` for the int fields. */
const FIELDS: ReadonlyArray<{ readonly kind: string; readonly field: string; readonly int: boolean; readonly node: (v: unknown) => Node }> = [
  { kind: 'stoneDepth', field: 'offset', int: true, node: (v) => ({ kind: 'stoneDepth', side: 'floor', offset: v, addSurfaceDepth: true }) },
  { kind: 'water', field: 'offset', int: true, node: (v) => ({ kind: 'water', offset: v, runTop: false }) },
  { kind: 'yAbove', field: 'minY', int: true, node: (v) => ({ kind: 'yAbove', minY: v, runTop: true }) },
  { kind: 'verticalGradient', field: 'trueAtAndBelow', int: true, node: (v) => ({ kind: 'verticalGradient', trueAtAndBelow: v, falseAtAndAbove: 384 }) },
  { kind: 'verticalGradient', field: 'falseAtAndAbove', int: true, node: (v) => ({ kind: 'verticalGradient', trueAtAndBelow: -384, falseAtAndAbove: v }) },
  { kind: 'steep', field: 'min', int: false, node: (v) => ({ kind: 'steep', min: v }) },
  { kind: 'noiseThreshold', field: 'min', int: false, node: (v) => ({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: v, max: 1e9 }) },
  { kind: 'noiseThreshold', field: 'max', int: false, node: (v) => ({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -1e9, max: v }) },
  { kind: 'temperatureBelow', field: 't', int: false, node: (v) => ({ kind: 'temperatureBelow', t: v }) },
];

describe('validateRulesSource: the default tree and the ref form (SP3d spec §1.3, §1.7)', () => {
  test('the default source passes tier 2, and its 15 refs are where §2.2 puts them', () => {
    expect(validateRulesSource(DEFAULT_SURFACE_RULES)).toEqual([]);
  });

  test('every numeric field takes a ref and a negated ref; int fields take int targets only', () => {
    for (const f of FIELDS) {
      const at = `root.if.${f.field}`;
      // An int target in any field; its negation [−319, 64] is inside [−384, 384].
      expect(check(under(f.node(ref('surface.cliffMinY')))), `${f.kind}.${f.field}`).toEqual([]);
      expect(check(under(f.node(ref('surface.lapseBase', true)))), `${f.kind}.${f.field}`).toEqual([]);
      // A number target, and a noise's clampSigma: number fields only.
      for (const target of ['surface.snowline', 'density.detailAmpHi', 'density.noises.jag.clampSigma', 'surface.noises.depth.clampSigma']) {
        expect(check(under(f.node(ref(target)))), `${f.kind}.${f.field} ← ${target}`).toEqual(f.int ? [`${at}: PARAM_KIND`] : []);
        expect(check(under(f.node(ref(target, true)))), `${f.kind}.${f.field} ← −${target}`).toEqual(f.int ? [`${at}: PARAM_KIND`] : []);
      }
      expect(validateRulesSource(under(f.node(ref('surface.snowline'))))[0]?.message ?? '').toMatch(f.int ? /integer field/ : /^$/);
    }
  });

  test('a malformed ref is BAD_FIELD, a path that is not a target UNKNOWN_PARAM, both at the field (never .param)', () => {
    const bad: unknown[] = [
      {}, { neg: true }, { param: 3 }, { param: 'surface.snowline', neg: false }, { param: 'surface.snowline', neg: 1 },
      { param: 'surface.snowline', scale: -1 }, { param: ['surface.snowline'] },
    ];
    const unknown = [
      'climate.scaleMul', 'surface.noises.patch', 'surface.noises.patch.octaves', 'surface.depthMul.x', 'surface', '',
      'constructor', 'toString', '__proto__', 'hasOwnProperty', 'density.noises.jag.clampSigma.x', 'SURFACE.snowline',
    ];
    for (const f of FIELDS) {
      const at = `root.if.${f.field}`;
      for (const v of bad) expect(check(under(f.node(v))), `${f.kind}.${f.field} = ${JSON.stringify(v)}`).toEqual([`${at}: BAD_FIELD`]);
      for (const p of unknown) expect(check(under(f.node(ref(p)))), `${f.kind}.${f.field} → ${p}`).toEqual([`${at}: UNKNOWN_PARAM`]);
    }
    // Arrays, strings and booleans in a numeric field keep validateRules' codes.
    expect(check(under({ kind: 'steep', min: [1] }))).toEqual(['root.if.min: NOT_FINITE']);
    expect(check(under({ kind: 'yAbove', minY: '80', runTop: true }))).toEqual(['root.if.minY: NOT_INTEGER']);
  });

  test('refs only in the nine numeric fields: other fields keep their codes', () => {
    const r = ref('surface.cliffMinY');
    expect(check(under({ kind: 'stoneDepth', side: r, offset: 0, addSurfaceDepth: true }))).toEqual(['root.if.side: BAD_SIDE']);
    expect(check(under({ kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: r }))).toEqual(['root.if.addSurfaceDepth: NOT_BOOLEAN']);
    expect(check(under({ kind: 'biome', biomes: r }))).toEqual(['root.if.biomes: NOT_ARRAY']);
    expect(check(under({ kind: 'noiseThreshold', noise: r, min: 0, max: 1 }))).toEqual(['root.if.noise: UNKNOWN_NOISE']);
    expect(check({ kind: 'block', state: r })).toEqual(['root.state: UNKNOWN_BLOCK']);
  });

  test('order checks over static ranges: largest min vs smallest max, two refs to one leaf independent', () => {
    const nt = (min: unknown, max: unknown): Node => under({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min, max });
    const pt = ref('surface.patchThreshold'); // [0, 3]
    const ptn = ref('surface.patchThreshold', true); // [−3, 0]
    expect(check(nt(pt, 8))).toEqual([]);
    expect(check(nt(pt, 3))).toEqual([]);
    expect(check(nt(pt, 2.99))).toEqual(['root.if: RANGE_ORDER']);
    expect(check(nt(-8, ptn))).toEqual([]);
    expect(check(nt(-3, ptn))).toEqual([]);
    expect(check(nt(-2.99, ptn))).toEqual(['root.if: RANGE_ORDER']);
    expect(check(nt(ptn, pt))).toEqual([]);
    // min = max = t is true for every t, but two refs are judged independently (conservative; the message says so).
    expect(check(nt(pt, pt))).toEqual(['root.if: RANGE_ORDER']);
    expect(validateRulesSource(nt(pt, pt))[0]!.message).toMatch(/independently, even two to the same parameter/);
    expect(validateRulesSource(nt(2, 1))[0]!.message).toBe('noiseThreshold needs min ≤ max');
    const vg = (lo: unknown, hi: unknown): Node => under({ kind: 'verticalGradient', trueAtAndBelow: lo, falseAtAndAbove: hi });
    const cm = ref('surface.cliffMinY'); // [−64, 319]
    expect(check(vg(cm, 320))).toEqual([]);
    expect(check(vg(cm, 319))).toEqual(['root.if: GRADIENT_ORDER']);
    expect(check(vg(-65, cm))).toEqual([]);
    expect(check(vg(-64, cm))).toEqual(['root.if: GRADIENT_ORDER']);
    expect(check(vg(ref('surface.cliffMinY', true), 65))).toEqual([]); // [−319, 64]
    expect(check(vg(ref('surface.cliffMinY', true), 64))).toEqual(['root.if: GRADIENT_ORDER']);
    expect(check(vg(cm, cm))).toEqual(['root.if: GRADIENT_ORDER']);
    expect(check(vg(cm, ref('surface.lapseBase')))).toEqual(['root.if: GRADIENT_ORDER']);
    // An invalid side is not order-checked.
    expect(check(vg(ref('surface.snowline'), 0))).toEqual(['root.if.trueAtAndBelow: PARAM_KIND']);
  });

  test('an int field\'s ref range must lie in [−384, 384] (OUT_OF_RANGE at the field), checked on a wide int target', () => {
    const mode: RuleSourceMode = { target: (p) => (p === 'wide' ? { lo: -500, hi: 0, int: true } : p === 'ok' ? { lo: -384, hi: 384, int: true } : undefined) };
    const issues = (tree: unknown): string[] => validateRules(tree, () => undefined, mode).map((i) => `${i.path}: ${i.code}`);
    expect(issues(under({ kind: 'water', offset: ref('wide'), runTop: true }))).toEqual(['root.if.offset: OUT_OF_RANGE']);
    expect(issues(under({ kind: 'water', offset: ref('wide', true), runTop: true }))).toEqual(['root.if.offset: OUT_OF_RANGE']);
    expect(issues(under({ kind: 'water', offset: ref('ok'), runTop: true }))).toEqual([]);
    expect(issues(under({ kind: 'water', offset: ref('ok', true), runTop: true }))).toEqual([]);
  });

  test('literals: number fields within ±1e9 (LITERAL_RANGE), int fields keep [−384, 384]; source mode only', () => {
    for (const f of FIELDS) {
      const at = `root.if.${f.field}`;
      if (f.int) {
        expect(check(under(f.node(385))), at).toEqual([`${at}: OUT_OF_RANGE`]);
        expect(check(under(f.node(2e9))), at).toEqual([`${at}: OUT_OF_RANGE`]);
        continue;
      }
      expect(check(under(f.node(1e9))), at).toEqual([]);
      expect(check(under(f.node(-1e9))), at).toEqual([]);
      expect(check(under(f.node(1e9 + 1))), at).toEqual([`${at}: LITERAL_RANGE`]);
      expect(check(under(f.node(-1.5e300))), at).toEqual([`${at}: LITERAL_RANGE`]);
      expect(check(under(f.node(-0))), at).toEqual([`${at}: NEGATIVE_ZERO`]);
      expect(check(under(f.node(Infinity))), at).toEqual([`${at}: NOT_FINITE`]);
      // validateRules without the source mode (code-built trees) accepts large literals, and keeps refusing refs as numbers.
      expect(validateRules(under(f.node(f.field === 'min' ? -2e9 : 2e9)), () => ({ dims: 2, remap: 'none', clampSigma: 3 }))).toEqual([]);
      expect(validateRules(under(f.node(ref('surface.snowline'))), () => ({ dims: 2, remap: 'none', clampSigma: 3 })).map((i) => i.code)).toEqual(['NOT_FINITE']);
    }
    expect(validateRules(under({ kind: 'water', offset: ref('surface.cliffMinY'), runTop: true }), () => undefined).map((i) => i.code)).toEqual(['NOT_INTEGER']);
  });

  test('a biome list holds at most 64 entries (TOO_MANY_BIOMES at .biomes, entries not checked); source mode only', () => {
    const biomes = (n: number, name = 'plains'): Node => under({ kind: 'biome', biomes: Array.from({ length: n }, () => name) });
    expect(check(biomes(64))).toEqual([]);
    expect(check(biomes(65))).toEqual(['root.if.biomes: TOO_MANY_BIOMES']);
    expect(check(biomes(1024, 'nowhere'))).toEqual(['root.if.biomes: TOO_MANY_BIOMES']);
    expect(check(biomes(2, 'nowhere'))).toEqual(['root.if.biomes[0]: UNKNOWN_BIOME', 'root.if.biomes[1]: UNKNOWN_BIOME']);
    expect(check(seq(block('stone'), when({ kind: 'not', if: { kind: 'biome', biomes: Array(65).fill('desert') } }, block('sand')))))
      .toEqual(['root.rules[1].if.if.biomes: TOO_MANY_BIOMES']);
    expect(validateRules(biomes(200), () => undefined)).toEqual([]);
  });

  test('a block state that does not collide is NOT_SOLID (validateRulesSource only); every other registered state passes', () => {
    expect(check(block('air'))).toEqual(['root.state: NOT_SOLID']);
    expect(validateRulesSource(block('air'))[0]!.message).toMatch(/air does not collide/);
    expect(check(seq(block('stone'), when({ kind: 'skyOpen' }, block('air'))))).toEqual(['root.rules[1].then.state: NOT_SOLID']);
    expect(validateRules(block('air'), () => undefined)).toEqual([]);
    let solid = 0;
    for (let id = 0; id < REGISTRY.stateCount; id++) {
      const key = REGISTRY.stateKey(id);
      const want = COLLIDE[id] === COLLIDE_NONE ? ['root.state: NOT_SOLID'] : [];
      expect(check(block(key)), key).toEqual(want);
      if (want.length === 0) solid++;
    }
    expect(solid).toBe(REGISTRY.stateCount - 1);
  });

  test('the sp3c.surface.ops fixture\'s block states all collide (its tree passes tier 2)', () => {
    const states: string[] = [];
    const stack: unknown[] = [surfaceOpsRules()];
    while (stack.length > 0) {
      const x = stack.pop();
      if (typeof x !== 'object' || x === null) continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const n = x as Node;
      if (n['kind'] === 'block') states.push(n['state'] as string);
      stack.push(...Object.values(n));
    }
    expect(states.length).toBeGreaterThan(10);
    for (const s of states) expect(COLLIDE[REGISTRY.parseStateKey(s)], s).not.toBe(COLLIDE_NONE);
    expect(validateRulesSource(surfaceOpsRules())).toEqual([]);
  });
});

describe('validateRulesSource: column cost, the issue cap and the memo (SP3d spec §1.7, §1.8)', () => {
  /** A tree without a fast path (its first leaf is under a biome condition, no floor stoneDepth) of exactly n nodes. */
  function noFastPath(n: number): Node {
    const rest = n - 4; // root sequence, the condition, its biome, its block
    const parts: Node[] = [when({ kind: 'biome', biomes: ['plains'] }, block('grass_block'))];
    for (let left = rest; left > 0;) {
      const k = Math.min(left - 1, 900);
      parts.push(seq(...Array.from({ length: k }, () => block('stone'))));
      left -= k + 1;
    }
    return seq(...parts);
  }

  test('COLUMN_COST at the leaf path above RULES_COLUMN_COST_MAX (98,304 per node without a fast path), not at it', () => {
    const most = Math.floor(RULES_COLUMN_COST_MAX / 98304);
    expect(most).toBe(1412);
    const ok = noFastPath(most), over = noFastPath(most + 1);
    expect(rulesColumnCost(ok)).toBe(most * 98304);
    expect(rulesColumnCost(over)).toBe((most + 1) * 98304);
    expect(rulesColumnCost(over)).toBeGreaterThan(RULES_COLUMN_COST_MAX);
    expect(validateRules(over, () => undefined)).toEqual([]);
    expect(check(ok)).toEqual([]);
    expect(validateRulesSource(over)).toEqual([{
      path: '', code: 'COLUMN_COST', message: `column cost ${(most + 1) * 98304} is above ${RULES_COLUMN_COST_MAX} (64 × the default tree's)`,
    }]);
    // The cost is judged only on an otherwise valid tree.
    const broken = noFastPath(most + 1);
    const parts = broken['rules'] as Node[];
    parts.push(block('air'));
    expect(check(broken)).toEqual([`root.rules[${parts.length - 1}].state: NOT_SOLID`]);
    // The same node count with a fast path costs 256 × (1 + depth bound) per node and passes.
    const fast = seq(...Array.from({ length: 1500 }, () => block('stone')));
    expect(check(fast)).toEqual([]);
  });

  test('at most 50 issues, then TOO_MANY_ISSUES "<n> more" at the leaf path', () => {
    const tree = seq(...Array.from({ length: 60 }, (_, k) => block(`nowhere${k}`)));
    const issues = validateRulesSource(tree);
    expect(issues.length).toBe(51);
    expect(issues[0]).toMatchObject({ path: 'root.rules[0].state', code: 'UNKNOWN_BLOCK' });
    expect(issues[49]).toMatchObject({ path: 'root.rules[49].state', code: 'UNKNOWN_BLOCK' });
    expect(issues[50]).toEqual({ path: '', code: 'TOO_MANY_ISSUES', message: '10 more' });
    expect(validateRulesSource(seq(...Array.from({ length: 50 }, () => block('x')))).length).toBe(50);
  });

  test('never throws on hostile input; issue lists are frozen', () => {
    const cyclic: Node = { kind: 'sequence', rules: [] };
    (cyclic['rules'] as unknown[]).push(cyclic);
    for (const v of [undefined, null, 3, 'root', [], {}, { kind: 'sequence', rules: [null] }, cyclic, { kind: 'condition' }]) {
      const issues = validateRulesSource(v);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.length).toBeLessThanOrEqual(51);
      expect(Object.isFrozen(issues)).toBe(true);
      for (const i of issues) expect(Object.isFrozen(i)).toBe(true);
    }
  });

  test('memoised by identity for deep-frozen trees (a tier-1 clone is validated once); other trees on every call', () => {
    const out: Issue[] = [];
    const tree = { kind: 'sequence', rules: [when({ kind: 'steep', min: ref('surface.cliffSteep') }, block('stone')), block('dirt')] };
    const frozen = checkJson(tree, 'surface.rules', out, 'surfaceRules')!;
    expect(out).toEqual([]);
    const n0 = rulesSourceValidations();
    const a = validateRulesSource(frozen);
    expect(rulesSourceValidations()).toBe(n0 + 1);
    const b = validateRulesSource(frozen);
    expect(rulesSourceValidations()).toBe(n0 + 1);
    expect(b).toBe(a);
    expect(a).toEqual([]);
    // An invalid frozen tree: its issues are memoised too.
    const bad = checkJson(block('air'), 'surface.rules', out, 'surfaceRules')!;
    const i1 = validateRulesSource(bad);
    expect(validateRulesSource(bad)).toBe(i1);
    expect(lines(i1)).toEqual(['root.state: NOT_SOLID']);
    expect(rulesSourceValidations()).toBe(n0 + 2);
    // Unfrozen, and frozen only at the top: validated every call (a child could change between calls).
    validateRulesSource(tree);
    validateRulesSource(tree);
    expect(rulesSourceValidations()).toBe(n0 + 4);
    const top = Object.freeze({ ...tree });
    validateRulesSource(top);
    validateRulesSource(top);
    expect(rulesSourceValidations()).toBe(n0 + 6);
    (top.rules[1] as Node)['state'] = 'air';
    expect(lines(validateRulesSource(top))).toEqual(['root.rules[1].state: NOT_SOLID']);
    // The default tree (tier 1's registered clone) is memoised.
    validateRulesSource(DEFAULT_SURFACE_RULES);
    const n1 = rulesSourceValidations();
    validateRulesSource(DEFAULT_SURFACE_RULES);
    expect(rulesSourceValidations()).toBe(n1);
  });
});

describe('issue codes (SP3d spec §1.1)', () => {
  test('RuleErrorCode, the source codes and validateRulesSource\'s codes are TreeIssueCodes', () => {
    expectTypeOf<RuleErrorCode>().toExtend<TreeIssueCode>();
    expectTypeOf<RuleRefCode>().toEqualTypeOf<'BAD_FIELD' | 'UNKNOWN_PARAM' | 'PARAM_KIND' | 'LITERAL_RANGE' | 'TOO_MANY_BIOMES' | 'NOT_SOLID'>();
    expectTypeOf<RulesSourceCode>().toEqualTypeOf<RuleErrorCode | RuleRefCode | 'COLUMN_COST' | 'TOO_MANY_ISSUES'>();
    expectTypeOf<RulesSourceCode>().toExtend<TreeIssueCode>();
    expectTypeOf<{ param: 'surface.snowline'; neg: true }>().toExtend<RuleParamRef>();
    const code: TreeIssueCode = validateRulesSource(block('air'))[0]!.code;
    expect(code).toBe('NOT_SOLID');
  });
});

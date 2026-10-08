import { describe, expect, test } from 'vitest';
import {
  conditionThenId, CONDITION_KINDS, requireValidRules, ROOT_RULE_ID, RULE_KINDS, ruleLeaves, RuleValidationError, sequenceChildId,
  validateRules, type Condition, type Rule, type SurfaceNoiseInfo,
} from '../../src/gen/surface/rules';

const NOISES = new Map<string, SurfaceNoiseInfo>([
  ['surface.noises.patch', { dims: 2, remap: 'none', clampSigma: 3 }],
  ['surface.noises.depth', { dims: 2, remap: 'none', clampSigma: 3 }],
  ['surface.noises.vol', { dims: 3, remap: 'none', clampSigma: 3 }],
  ['surface.noises.flat', { dims: 2, remap: 'uniform', clampSigma: 3 }],
  ['density.noises.jag', { dims: 2, remap: 'none', clampSigma: 3 }],
]);
const LOOKUP = (name: string): SurfaceNoiseInfo | undefined => NOISES.get(name);
const issues = (value: unknown): string[] => validateRules(value, LOOKUP).map((i) => `${i.path}: ${i.code}`);

const block = (state: string): Rule => ({ kind: 'block', state });
const seq = (...rules: Rule[]): Rule => ({ kind: 'sequence', rules });
const cond = (c: Condition, then: Rule): Rule => ({ kind: 'condition', if: c, then });
const SKY: Condition = { kind: 'skyOpen' };

/** One literal of every condition kind of SP3c spec §3.1 (block keys of the SP3a registry only: the palette is Task 2's). */
const EVERY_CONDITION: readonly Condition[] = [
  { kind: 'biome', biomes: ['desert', 'beach'] },
  { kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: true },
  { kind: 'water', offset: -10, runTop: true },
  { kind: 'yAbove', minY: 80, runTop: true },
  { kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 },
  { kind: 'steep', min: 1.2 },
  { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 0.55, max: 8 },
  { kind: 'temperatureBelow', t: -0.6 },
  { kind: 'skyOpen' },
  { kind: 'lake' },
  { kind: 'not', if: { kind: 'stoneDepth', side: 'ceiling', offset: 3, addSurfaceDepth: false } },
];
const EVERY_KIND: Rule = seq(...EVERY_CONDITION.map((c, k) => cond(c, block(k % 2 === 0 ? 'stone' : 'bedrock'))), block('stone'));

/** n condition rules nested through `then`, ending in a block: the block (and the last `if`) sit at depth n + 1. */
function chain(n: number): Rule {
  let r: Rule = block('stone');
  for (let i = 0; i < n; i++) r = cond(SKY, r);
  return r;
}

describe('rule model (SP3c spec §3.1)', () => {
  test('RULE_KINDS and CONDITION_KINDS list the kinds of the two tables (bandlands is added by the bandlands task)', () => {
    expect([...RULE_KINDS]).toEqual(['sequence', 'condition', 'block']);
    expect([...CONDITION_KINDS]).toEqual([
      'biome', 'stoneDepth', 'water', 'yAbove', 'verticalGradient', 'steep', 'noiseThreshold', 'temperatureBelow', 'skyOpen', 'lake', 'not',
    ]);
  });

  test('rule ids: root, <id>.rules[k] for a sequence child, <id>.then for a condition', () => {
    expect(ROOT_RULE_ID).toBe('root');
    expect(sequenceChildId('root', 1)).toBe('root.rules[1]');
    expect(conditionThenId('root.rules[1]')).toBe('root.rules[1].then');
    expect(sequenceChildId(conditionThenId(sequenceChildId('root', 1)), 3)).toBe('root.rules[1].then.rules[3]');
  });

  test('ruleLeaves lists every block leaf in tree order with its id and the ifs of its condition ancestors', () => {
    const notWater: Condition = { kind: 'not', if: { kind: 'water', offset: 0, runTop: false } };
    const tree = seq(
      cond({ kind: 'verticalGradient', trueAtAndBelow: -64, falseAtAndAbove: -59 }, block('bedrock')),
      cond(SKY, seq(cond(notWater, cond({ kind: 'lake' }, block('stone'))), block('air'))),
      block('stone'),
    );
    const leaves = ruleLeaves(tree);
    expect(leaves.map((l) => l.id)).toEqual([
      'root.rules[0].then', 'root.rules[1].then.rules[0].then.then', 'root.rules[1].then.rules[1]', 'root.rules[2]',
    ]);
    expect(leaves.map((l) => l.rule.state)).toEqual(['bedrock', 'stone', 'air', 'stone']);
    expect(leaves[0]!.conditions.map((c) => c.kind)).toEqual(['verticalGradient']);
    expect(leaves[1]!.conditions).toEqual([SKY, notWater, { kind: 'lake' }]);
    expect(leaves[2]!.conditions).toEqual([SKY]);
    expect(leaves[3]!.conditions).toEqual([]);
    expect(ruleLeaves(block('stone'))).toEqual([{ id: 'root', rule: block('stone'), conditions: [] }]);
  });
});

describe('validateRules (SP3c spec §3.1)', () => {
  test('a tree using every rule and condition kind is valid, and the JSON round trip too', () => {
    expect(issues(EVERY_KIND)).toEqual([]);
    expect(issues(JSON.parse(JSON.stringify(EVERY_KIND)))).toEqual([]);
    expect(requireValidRules(EVERY_KIND, LOOKUP)).toBe(EVERY_KIND);
    expect(issues(block('air'))).toEqual([]);
    expect(issues(seq())).toEqual([]);
    expect(issues(cond({ kind: 'biome', biomes: [] }, block('stone')))).toEqual([]);
  });

  test('unknown kinds, a rule kind where a condition goes and the reverse, non-objects', () => {
    expect(issues({ kind: 'bandlands' })).toEqual(['root: UNKNOWN_KIND']);
    expect(issues({ kind: 'mystery' })).toEqual(['root: UNKNOWN_KIND']);
    expect(issues({ state: 'stone' })).toEqual(['root: UNKNOWN_KIND']);
    expect(issues(SKY)).toEqual(['root: UNKNOWN_KIND']);
    expect(issues(seq(cond(block('stone') as unknown as Condition, block('stone'))))).toEqual(['root.rules[0].if: UNKNOWN_KIND']);
    expect(issues(seq(block('stone'), 'stone' as unknown as Rule, null as unknown as Rule))).toEqual([
      'root.rules[1]: NOT_OBJECT', 'root.rules[2]: NOT_OBJECT',
    ]);
    expect(issues([block('stone')])).toEqual(['root: NOT_OBJECT']);
    expect(issues({ kind: 'sequence', rules: block('stone') })).toEqual(['root.rules: NOT_ARRAY']);
  });

  test('unknown and missing fields (every field is written, nothing else; secondaryDepthRange is unknown)', () => {
    expect(issues({ kind: 'block', state: 'stone', weight: 1 })).toEqual(['root.weight: UNKNOWN_FIELD']);
    expect(issues({ kind: 'block' })).toEqual(['root.state: MISSING_FIELD']);
    expect(issues({ kind: 'condition', then: block('stone') })).toEqual(['root.if: MISSING_FIELD']);
    expect(issues({ kind: 'condition', if: SKY })).toEqual(['root.then: MISSING_FIELD']);
    expect(issues({ kind: 'sequence' })).toEqual(['root.rules: MISSING_FIELD']);
    expect(issues(cond({ kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false, secondaryDepthRange: 2 } as unknown as Condition, block('stone'))))
      .toEqual(['root.if.secondaryDepthRange: UNKNOWN_FIELD']);
    expect(issues(cond({ kind: 'water', offset: 0 } as unknown as Condition, block('stone')))).toEqual(['root.if.runTop: MISSING_FIELD']);
    expect(issues(cond({ kind: 'skyOpen', value: true } as unknown as Condition, block('stone')))).toEqual(['root.if.value: UNKNOWN_FIELD']);
    expect(issues(cond({ kind: 'not' } as unknown as Condition, block('stone')))).toEqual(['root.if.if: MISSING_FIELD']);
  });

  test('block keys must parse with parseStateKey; biomes must be surface biomes', () => {
    expect(issues(block('not_a_block'))).toEqual(['root.state: UNKNOWN_BLOCK']);
    expect(issues(block('Stone'))).toEqual(['root.state: UNKNOWN_BLOCK']);
    expect(issues({ kind: 'block', state: 1 })).toEqual(['root.state: UNKNOWN_BLOCK']);
    expect(issues(cond({ kind: 'biome', biomes: ['desert', 'atlantis', 7] } as unknown as Condition, block('stone'))))
      .toEqual(['root.if.biomes[1]: UNKNOWN_BIOME', 'root.if.biomes[2]: UNKNOWN_BIOME']);
    expect(issues(cond({ kind: 'biome', biomes: 'desert' } as unknown as Condition, block('stone')))).toEqual(['root.if.biomes: NOT_ARRAY']);
  });

  test('noiseThreshold.noise must be a dims-2 surface.noises.* leaf (remap none)', () => {
    const nt = (noise: unknown): Rule => cond({ kind: 'noiseThreshold', noise, min: 0, max: 1 } as Condition, block('stone'));
    expect(issues(nt('surface.noises.depth'))).toEqual([]);
    expect(issues(nt('surface.noises.missing'))).toEqual(['root.if.noise: UNKNOWN_NOISE']);
    expect(issues(nt('density.noises.jag'))).toEqual(['root.if.noise: UNKNOWN_NOISE']);
    expect(issues(nt(3))).toEqual(['root.if.noise: UNKNOWN_NOISE']);
    expect(issues(nt('surface.noises.vol'))).toEqual(['root.if.noise: NOISE_DIMS']);
    expect(issues(nt('surface.noises.flat'))).toEqual(['root.if.noise: NOISE_REMAP']);
  });

  test('integer fields in [−384, 384], finite numbers, booleans and side', () => {
    const c = (x: object): Rule => cond(x as Condition, block('stone'));
    expect(issues(c({ kind: 'yAbove', minY: 384, runTop: false }))).toEqual([]);
    expect(issues(c({ kind: 'yAbove', minY: -384, runTop: false }))).toEqual([]);
    expect(issues(c({ kind: 'yAbove', minY: 385, runTop: false }))).toEqual(['root.if.minY: OUT_OF_RANGE']);
    expect(issues(c({ kind: 'water', offset: -385, runTop: false }))).toEqual(['root.if.offset: OUT_OF_RANGE']);
    expect(issues(c({ kind: 'water', offset: 1.5, runTop: false }))).toEqual(['root.if.offset: NOT_INTEGER']);
    expect(issues(c({ kind: 'stoneDepth', side: 'floor', offset: '2', addSurfaceDepth: false }))).toEqual(['root.if.offset: NOT_INTEGER']);
    expect(issues(c({ kind: 'verticalGradient', trueAtAndBelow: Infinity, falseAtAndAbove: 8 }))).toEqual(['root.if.trueAtAndBelow: NOT_FINITE']);
    expect(issues(c({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 400 }))).toEqual(['root.if.falseAtAndAbove: OUT_OF_RANGE']);
    expect(issues(c({ kind: 'steep', min: NaN }))).toEqual(['root.if.min: NOT_FINITE']);
    expect(issues(c({ kind: 'steep', min: '1' }))).toEqual(['root.if.min: NOT_FINITE']);
    expect(issues(c({ kind: 'temperatureBelow', t: -Infinity }))).toEqual(['root.if.t: NOT_FINITE']);
    expect(issues(c({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 0, max: Infinity }))).toEqual(['root.if.max: NOT_FINITE']);
    expect(issues(c({ kind: 'water', offset: 0, runTop: 1 }))).toEqual(['root.if.runTop: NOT_BOOLEAN']);
    expect(issues(c({ kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: 'yes' }))).toEqual(['root.if.addSurfaceDepth: NOT_BOOLEAN']);
    expect(issues(c({ kind: 'stoneDepth', side: 'roof', offset: 0, addSurfaceDepth: false }))).toEqual(['root.if.side: BAD_SIDE']);
  });

  test('order checks: noiseThreshold min > max, verticalGradient trueAtAndBelow ≥ falseAtAndAbove', () => {
    const c = (x: object): Rule => cond(x as Condition, block('stone'));
    expect(issues(c({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 1, max: 1 }))).toEqual([]);
    expect(issues(c({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 1.5, max: 1 }))).toEqual(['root.if: RANGE_ORDER']);
    expect(issues(c({ kind: 'verticalGradient', trueAtAndBelow: 7, falseAtAndAbove: 8 }))).toEqual([]);
    expect(issues(c({ kind: 'verticalGradient', trueAtAndBelow: 8, falseAtAndAbove: 8 }))).toEqual(['root.if: GRADIENT_ORDER']);
    expect(issues(c({ kind: 'verticalGradient', trueAtAndBelow: 9, falseAtAndAbove: 8 }))).toEqual(['root.if: GRADIENT_ORDER']);
  });

  test('−0 is rejected with its node path wherever a number goes', () => {
    const c = (x: object): Rule => cond(x as Condition, block('stone'));
    expect(issues(c({ kind: 'water', offset: -0, runTop: false }))).toEqual(['root.if.offset: NEGATIVE_ZERO']);
    expect(issues(c({ kind: 'yAbove', minY: -0, runTop: true }))).toEqual(['root.if.minY: NEGATIVE_ZERO']);
    expect(issues(c({ kind: 'stoneDepth', side: 'ceiling', offset: -0, addSurfaceDepth: true }))).toEqual(['root.if.offset: NEGATIVE_ZERO']);
    expect(issues(c({ kind: 'verticalGradient', trueAtAndBelow: -0, falseAtAndAbove: 8 }))).toEqual(['root.if.trueAtAndBelow: NEGATIVE_ZERO']);
    expect(issues(c({ kind: 'steep', min: -0 }))).toEqual(['root.if.min: NEGATIVE_ZERO']);
    expect(issues(c({ kind: 'temperatureBelow', t: -0 }))).toEqual(['root.if.t: NEGATIVE_ZERO']);
    expect(issues(seq(block('stone'), c({ kind: 'not', if: { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -8, max: -0 } }))))
      .toEqual(['root.rules[1].if.if.max: NEGATIVE_ZERO']);
    expect(issues(c({ kind: 'temperatureBelow', t: 0 - 0 }))).toEqual([]);
  });

  test('node paths follow the rule ids, with .if / .if.if for conditions; issues come in pre-order', () => {
    const tree = seq(
      cond({ kind: 'not', if: { kind: 'steep', min: NaN } }, block('nope')),
      cond(SKY, seq(block('stone'), cond({ kind: 'lake', x: 1 } as unknown as Condition, block('bedrock')))),
    );
    expect(issues(tree)).toEqual(['root.rules[0].if.if.min: NOT_FINITE', 'root.rules[0].then.state: UNKNOWN_BLOCK', 'root.rules[1].then.rules[1].if.x: UNKNOWN_FIELD']);
    const [first] = validateRules(tree, LOOKUP);
    expect(first!.message).toMatch(/steep\.min/);
  });

  test('nesting depth above 32 is rejected (root at depth 1; rules and conditions count)', () => {
    expect(issues(chain(31))).toEqual([]);
    const deep = issues(chain(32));
    const thens = `root${'.then'.repeat(31)}`;
    expect(deep).toEqual([`${thens}.if: TOO_DEEP`, `${thens}.then: TOO_DEEP`]);
    let notChain: Condition = SKY;
    for (let i = 0; i < 30; i++) notChain = { kind: 'not', if: notChain };
    expect(issues(cond(notChain, block('stone')))).toEqual([]);
    expect(issues(cond({ kind: 'not', if: notChain }, block('stone')))).toEqual([`root.if${'.if'.repeat(31)}: TOO_DEEP`]);
  });

  test('more than 4096 nodes is rejected once, at the root', () => {
    expect(issues(seq(...Array.from({ length: 4095 }, () => block('stone'))))).toEqual([]);
    expect(issues(seq(...Array.from({ length: 4096 }, () => block('stone'))))).toEqual(['root: TOO_MANY_NODES']);
    expect(issues(seq(...Array.from({ length: 3000 }, () => cond(SKY, block('stone')))))).toEqual(['root: TOO_MANY_NODES']);
  });

  test('requireValidRules throws a RuleValidationError listing the issues', () => {
    expect(() => requireValidRules(block('nope'), LOOKUP)).toThrow(RuleValidationError);
    try {
      requireValidRules(seq(block('nope'), { kind: 'x' } as unknown as Rule), LOOKUP);
    } catch (e) {
      expect((e as RuleValidationError).issues.map((i) => i.code)).toEqual(['UNKNOWN_BLOCK', 'UNKNOWN_KIND']);
      expect((e as Error).message).toContain('root.rules[0].state: UNKNOWN_BLOCK');
    }
  });
});

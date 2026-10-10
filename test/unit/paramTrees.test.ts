/**
 * The two `json` leaves of SP3d (spec §1.2, §1.7, §1.8, D3): `validateParamTrees` and its leaf-prefixed paths, the
 * defaults invariant (every profile, the U2 variants and the uiSmoke trees pass both tiers), the contexts reading the
 * leaves, and a depth-48 tree through every canonical wrapper.
 */
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { applyPatch, renderReference, type Issue } from '../../src/core/params/kit';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { PROFILE_IDS, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../../src/core/params/schema';
import { paramsHash, stageHashes } from '../../src/core/stage/hash';
import { STAGES } from '../../src/core/stage/registry';
import { draftKeyOf } from '../../src/engine/session';
import { createDensityContext } from '../../src/gen/density/context';
import { ExprValidationError } from '../../src/gen/density/expr';
import { densitySourceValidations } from '../../src/gen/density/source';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { RuleValidationError } from '../../src/gen/surface/rules';
import { rulesSourceValidations } from '../../src/gen/surface/source';
import { validateParamTrees } from '../../src/gen/trees';
import { perturbations } from '../../src/metrics/liveness';
import { decodeLabState, DEFAULT_LAB_STATE, encodeLabState } from '../../src/ui/lab/labState';
import { decodeMapState, DEFAULT_MAP_STATE, encodeMapState } from '../../src/ui/map/mapState';
import { ctxFor, paramsWith } from '../harness/gen';
import {
  deepDensity, deepRules, densityTree, editedDensity, editedRules, findKind, gradientTop, islandsAt, jsonDepth, rulesTree, terrainMuted,
} from './fixtures/editedTrees';

const brief = (issues: readonly Issue[]) => issues.map((i) => `${i.path} ${i.code}`);
const trees = (density: unknown = DEFAULT_DENSITY_TREE, rules: unknown = DEFAULT_SURFACE_RULES): Params =>
  paramsWith({ density: { defs: density }, surface: { rules } } as ParamsPatch);
const leafInfo = (path: string) => SCHEMA.leaves.find((l) => l.path === path)!;

describe('the two leaves (SP3d spec §1.2)', () => {
  test('defaults are the registered default trees, kept by identity through applyPatch, checkParams and resolveProfile', () => {
    expect(DEFAULTS.density.defs).toBe(DEFAULT_DENSITY_TREE);
    expect(DEFAULTS.surface.rules).toBe(DEFAULT_SURFACE_RULES);
    expect(paramsWith({ climate: { scaleMul: 2 } }).density.defs).toBe(DEFAULT_DENSITY_TREE);
    for (const id of PROFILE_IDS) expect(resolveProfile(id).surface.rules, id).toBe(DEFAULT_SURFACE_RULES);
  });

  test('the README rows: `<format> tree, <n> nodes`, no range; scope terrain', () => {
    const rows = renderReference(SCHEMA).split('\n');
    expect(rows.find((r) => r.startsWith('| `density.defs` |'))).toMatch(/^\| `density\.defs` \| json \| density tree, 60 nodes \|  \|  \| terrain \| Density expression: /);
    expect(rows.find((r) => r.startsWith('| `surface.rules` |'))).toMatch(/^\| `surface\.rules` \| json \| surfaceRules tree, 163 nodes \|  \|  \| terrain \| Surface rules: /);
  });

  test('an edited tree is tier 1\'s frozen clone: a patch with the same registered value keeps it', () => {
    const p = trees(islandsAt(-10));
    const tree = p.density.defs;
    expect(Object.isFrozen(tree)).toBe(true);
    expect(tree).not.toBe(DEFAULT_DENSITY_TREE);
    const again = applyPatch(SCHEMA, p, { climate: { scaleMul: 2 } });
    expect(again.ok && again.value.density.defs).toBe(tree);
  });
});

describe('validateParamTrees (spec §1.8, D3)', () => {
  test('the defaults have no issue, and a document whose trees are unchanged validates from the memos', () => {
    expect(validateParamTrees(DEFAULTS)).toEqual([]);
    const p = trees(islandsAt(-10), gradientTop(12));
    expect(validateParamTrees(p)).toEqual([]);
    const counts = [densitySourceValidations(), rulesSourceValidations()];
    expect(validateParamTrees(p)).toEqual([]);
    expect(validateParamTrees(paramsWith({ climate: { scaleMul: 3 } }))).toEqual([]);
    expect([densitySourceValidations(), rulesSourceValidations()]).toEqual(counts);
  });

  test('density issues carry `density.defs.` and the node path', () => {
    const t = densityTree();
    t['root'].b.x = { op: 'bogus' };
    t['defs'] = { lift: { op: 'ref', name: 'nowhere' } };
    expect(brief(validateParamTrees(trees(t)))).toEqual(['density.defs.root.b.x UNKNOWN_OP', 'density.defs.defs.lift.name UNKNOWN_REF']);
  });

  test('rule issues carry `surface.rules.` and the rule id with its field, never `.param`', () => {
    const t = rulesTree();
    findKind(t, 'steep').min = { param: 'surface.nope' };
    findKind(t, 'block').state = 'air';
    expect(brief(validateParamTrees(trees(DEFAULT_DENSITY_TREE, t)))).toEqual([
      'surface.rules.root.rules[0].then.state NOT_SOLID',
      'surface.rules.root.rules[1].then.rules[1].if.min UNKNOWN_PARAM',
    ]);
  });

  test('both leaves at once: density first, then the rules', () => {
    const d = densityTree();
    d['root'].b.x = { op: 'bogus' };
    const r = rulesTree();
    findKind(r, 'block').state = 'air';
    expect(validateParamTrees(trees(d, r)).map((i) => i.path.split('.')[0])).toEqual(['density', 'surface']);
  });

  test('an issue at the value itself carries the leaf path alone (an empty node path)', () => {
    // 76 references to one detail noise: the column cost (76 × 128 + 75) × 98,304 is above the maximum (Task 6).
    const refs = (n: number): unknown => (n === 1 ? { op: 'ref', name: 'n' } : { op: 'add', a: refs(n >> 1), b: refs(n - (n >> 1)) });
    const density = { root: refs(76), defs: { n: { op: 'noise', id: 'detail' } } };
    expect(brief(validateParamTrees(trees(density)))).toEqual(['density.defs COLUMN_COST']);
    // 1,414 rule and condition nodes without a fast path (a steep condition is neither Y-only nor floor-bounded).
    const entry = { kind: 'condition', if: { kind: 'steep', min: 1 }, then: { kind: 'block', state: 'stone' } };
    const rules = { kind: 'sequence', rules: Array.from({ length: 471 }, () => entry) };
    expect(brief(validateParamTrees(trees(DEFAULT_DENSITY_TREE, rules)))).toEqual(['surface.rules COLUMN_COST']);
  });
});

describe('the default trees pass both tiers (spec §1.8 invariant)', () => {
  test('every profile', () => {
    for (const id of PROFILE_IDS) expect(validateParamTrees(resolveProfile(id)), id).toEqual([]);
  });

  test('the U2 variants of both leaves (spec §7) and the uiSmoke trees (spec §6: islands −10, terrain muted)', () => {
    const variants = [
      ...perturbations(leafInfo('density.defs'), DEFAULT_DENSITY_TREE).map((v) => trees(v)),
      ...perturbations(leafInfo('surface.rules'), DEFAULT_SURFACE_RULES).map((v) => trees(DEFAULT_DENSITY_TREE, v)),
      trees(islandsAt(-10)), trees(terrainMuted(0)), trees(islandsAt(-10), gradientTop(12)),
    ];
    expect(variants).toHaveLength(5);
    for (const p of variants) expect(validateParamTrees(p)).toEqual([]);
    expect(canonicalJSON(variants[0]!.density.defs)).toBe(canonicalJSON(terrainMuted(0)));
    expect(canonicalJSON(variants[1]!.surface.rules)).toBe(canonicalJSON(gradientTop(12)));
  });

  test('the edited trees of the round trips (spec §1.11)', () => {
    expect(validateParamTrees(trees(editedDensity(), editedRules()))).toEqual([]);
  });
});

describe('the contexts read the leaves (spec §1.6)', () => {
  test('density: resolveDensity(params.density.defs, params)', () => {
    expect((createDensityContext(ctxFor('42')).expr.root as unknown as { b: { x: { v: number } } }).b.x.v).toBe(-1000000);
    const dc = createDensityContext(ctxFor('42', { density: { defs: islandsAt(-10) } } as ParamsPatch));
    expect(dc.expr.root).toMatchObject({ op: 'max', b: { op: 'tap', name: 'islands', x: { op: 'const', v: -10 } } });
    expect(Object.isFrozen(dc.expr.root)).toBe(true);
    // The muted terrain tap's child is the mute value (§1.5).
    const muted = createDensityContext(ctxFor('42', { density: { defs: terrainMuted(0) } } as ParamsPatch));
    expect(muted.expr.root).toMatchObject({ a: { a: { op: 'tap', name: 'terrain', x: { op: 'const', v: 0 } } } });
  });

  test('surface: resolveRules(params.surface.rules, params), refs read from the same params', () => {
    const sc = surfaceContextOf(ctxFor('42', { surface: { rules: gradientTop(12), cliffSteep: 2 } } as ParamsPatch));
    expect((sc.rules as unknown as { rules: { if: unknown }[] }).rules[2]!.if).toMatchObject({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 12 });
    expect(findKind(sc.rules, 'steep')).toMatchObject({ min: 2 });
  });

  test('a tier-1-valid tree that fails tier 2 throws at context creation, with its source paths', () => {
    const cycle = { root: { op: 'ref', name: 'a' }, defs: { a: { op: 'ref', name: 'b' }, b: { op: 'ref', name: 'a' } } };
    const ctx = ctxFor('42', { density: { defs: cycle } } as ParamsPatch);
    expect(() => createDensityContext(ctx)).toThrow(ExprValidationError);
    try { createDensityContext(ctx); } catch (e) { expect((e as ExprValidationError).issues.map((i) => i.code)).toContain('REF_CYCLE'); }
    const air = rulesTree();
    findKind(air, 'block').state = 'air';
    const sctx = ctxFor('42', { surface: { rules: air } } as ParamsPatch);
    expect(() => createSurfaceContext(sctx)).toThrow(RuleValidationError);
  });
});

describe('a depth-48 tree through every canonical wrapper (spec §1.7)', () => {
  const density = deepDensity(48);
  const rules = deepRules(48);
  const patch = { density: { defs: density }, surface: { rules } } as ParamsPatch;

  test('the trees are at container depth 48 and pass tier 1; one level more is JSON_TOO_DEEP', () => {
    expect([jsonDepth(density), jsonDepth(rules), jsonDepth(deepDensity(49)), jsonDepth(deepRules(49))]).toEqual([48, 48, 49, 49]);
    expect(applyPatch(SCHEMA, DEFAULTS, patch).ok).toBe(true);
    const over = applyPatch(SCHEMA, DEFAULTS, { density: { defs: deepDensity(49) }, surface: { rules: deepRules(49) } } as ParamsPatch);
    expect(!over.ok && over.issues.map((i) => i.code)).toEqual(['JSON_TOO_DEEP', 'JSON_TOO_DEEP']);
  });

  test('encodeMapState, exportPreset, encodeLabState (B patch), draftKeyOf, stageHashes and paramsHash', () => {
    const params = paramsWith(patch);
    const map = decodeMapState(`#${encodeMapState({ ...DEFAULT_MAP_STATE, patch })}`);
    expect(map.error).toBeNull();
    expect(canonicalJSON(map.state.patch)).toBe(canonicalJSON(patch));
    const preset = importPreset(JSON.parse(JSON.stringify(exportPreset('Deep', 'default', params))) as unknown);
    expect(preset.ok && canonicalJSON(preset.value.params)).toBe(canonicalJSON(params));
    const lab = decodeLabState(`#${encodeLabState({ ...DEFAULT_LAB_STATE, b: { patch } })}`);
    expect(lab.error).toBeNull();
    expect(canonicalJSON(lab.state.b?.patch)).toBe(canonicalJSON(patch));
    expect(draftKeyOf({ seedText: '42', profile: 'default', patch })).toMatch(/^[0-9a-f]{16}$/);
    expect(stageHashes(params, STAGES).terrain).not.toBe(stageHashes(DEFAULTS, STAGES).terrain);
    expect(paramsHash(params)).not.toEqual(paramsHash(DEFAULTS));
  });
});

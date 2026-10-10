/**
 * The two trees of the `session.commitMaxTree` bench row (SP3d spec §1.12, §9; `test/harness/capTrees.ts`): each passes
 * both tiers with its canonical text at the 128 KiB cap (within its padding unit), and a page session opened with both
 * holds them, so the bench row measures a slider commit with two capped trees.
 */
import { describe, expect, test } from 'vitest';
import { TREE_LIMITS } from '../../src/core/constants';
import type { Seed64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { checkJson } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import { rulesColumnCost } from '../../src/gen/inspect/cost';
import { validateParamTrees } from '../../src/gen/trees';
import { DEFAULT_MAP_STATE, openMapSession, type MapState } from '../../src/ui/map/mapState';
import { capDensityTree, capSurfaceRules, densityNodeCount } from '../harness/capTrees';
import { paramsWith } from '../harness/gen';

const CAP = TREE_LIMITS.textUnits;
const density = capDensityTree();
const rules = capSurfaceRules();

describe('the capped trees of session.commitMaxTree', () => {
  test.each([
    ['density.defs', density, 'density', 40],
    ['surface.rules', rules, 'surfaceRules', 160],
  ] as const)('%s: tier 1 accepts it, its canonical text is within %#\'s padding unit of 131,072 characters', (leaf, tree, format, slack) => {
    const issues: Issue[] = [];
    const clone = checkJson(tree as never, leaf, issues, format);
    expect(issues).toEqual([]);
    const length = canonicalJSON(clone as never).length;
    expect(length).toBeLessThanOrEqual(CAP);
    expect(length).toBeGreaterThan(CAP - slack);
  });

  test('both pass tier 2 together; the density tree stays within 4,096 nodes and the rules keep their fast path', () => {
    const p = paramsWith({ density: { defs: density }, surface: { rules } } as never);
    expect(validateParamTrees(p)).toEqual([]);
    expect(densityNodeCount(density)).toBeLessThanOrEqual(4096);
    expect(densityNodeCount(density)).toBeGreaterThan(3500);
    // With a fast path a rule node costs 256 × (1 + 51) voxels per column (the default's depth bound), not 98,304.
    expect(rulesColumnCost(rules) % (256 * 52)).toBe(0);
  });

  test('a page session opened with both trees holds them, and a slider commit keeps both by identity', () => {
    const random = (): Seed64 => [3, 9];
    const w = openMapSession({ ...DEFAULT_MAP_STATE, patch: { density: { defs: density }, surface: { rules } } as MapState['patch'] }, random);
    const { defs } = w.state.params.density;
    const tree = w.state.params.surface.rules;
    expect([canonicalJSON(defs).length, canonicalJSON(tree).length]).toEqual([
      canonicalJSON(density as never).length, canonicalJSON(rules as never).length,
    ]);
    expect(w.set('climate.scaleMul', 2).ok).toBe(true);
    expect(w.state.params.density.defs).toBe(defs);
    expect(w.state.params.surface.rules).toBe(tree);
  });
});

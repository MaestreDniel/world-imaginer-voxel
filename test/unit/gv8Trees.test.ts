/**
 * The built-in trees at `GENERATOR_VERSION` 8 (SP6b D29, spec §14.4): the three density trees (default, amplified,
 * floating_islands) and the two surface trees (default, floating_islands) as they stood at aed4e07 (SP6b's push base;
 * the trees of 1ac9e7b), before SP6b's floor and rule 4, kept as canonical JSON in `test/fixtures/gv8-density-trees.json`
 * and `test/fixtures/gv8-surface-trees.json`. The code keeps only their hashes (`MIGRATIONS[3]`'s `GV8_DENSITY_HASHES`
 * and `GV8_SURFACE_HASHES`, schema version 5); this test pins the same five literals, so a fixture edit, or a migration
 * literal that drifts, fails here. `test/fixtures/sp6a-density-trees.json` and `test/unit/sp6aTrees.test.ts` are SP6a's.
 *
 * `WRITE_GV8_TREES=1` (a one-off, run once at aed4e07's trees) writes both fixtures from today's
 * `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE`, `FLOATING_DENSITY_TREE`, `DEFAULT_SURFACE_RULES` and
 * `FLOATING_SURFACE_RULES` and prints the hashes.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE, FLOATING_SURFACE_RULES } from '../../src/core/params/presetTrees';
import { fnv1a64, hex64 } from '../../src/core/hash';
import { validateDensitySource } from '../../src/gen/density/source';
import { validateRulesSource } from '../../src/gen/surface/source';
import { gv8DensityTrees, gv8SurfaceTrees, type Gv8DensityKind, type Gv8SurfaceKind } from '../harness/gv8Trees';

const DENSITY_FIXTURE = new URL('../fixtures/gv8-density-trees.json', import.meta.url);
const SURFACE_FIXTURE = new URL('../fixtures/gv8-surface-trees.json', import.meta.url);

/** `hex64(fnv1a64(canonicalJSON(tree)))` of each GV8 density tree (the literals `MIGRATIONS[3]` repeats). */
const GV8_DENSITY_HASHES: Readonly<Record<Gv8DensityKind, string>> = {
  default: 'c5416a3f42427b9c',
  amplified: 'f58b85b4aa09314e',
  floating_islands: '132038069924a1c8',
};

/** `hex64(fnv1a64(canonicalJSON(tree)))` of each GV8 surface tree (the literals `MIGRATIONS[3]` repeats). */
const GV8_SURFACE_HASHES: Readonly<Record<Gv8SurfaceKind, string>> = {
  default: '12b40aeca522f544',
  floating_islands: '86856ea3ad435d0b',
};

const DENSITY_KINDS: readonly Gv8DensityKind[] = ['default', 'amplified', 'floating_islands'];
const SURFACE_KINDS: readonly Gv8SurfaceKind[] = ['default', 'floating_islands'];
const hashOf = (tree: unknown): string => hex64(fnv1a64(canonicalJSON(tree)));

/** The fixture's text: one canonical tree per kind, in `kinds`' order. */
const fixtureText = <K extends string>(kinds: readonly K[], trees: Record<K, unknown>): string =>
  `{\n${kinds.map((k) => `  ${JSON.stringify(k)}: ${canonicalJSON(trees[k])}`).join(',\n')}\n}\n`;

describe('the GV8 built-in trees fixtures (SP6b D29, spec §14.4)', () => {
  if (process.env['WRITE_GV8_TREES'] === '1') {
    test('writes both fixtures from the built-in trees', () => {
      const density: Record<Gv8DensityKind, unknown> = { default: DEFAULT_DENSITY_TREE, amplified: AMPLIFIED_DENSITY_TREE, floating_islands: FLOATING_DENSITY_TREE };
      const surface: Record<Gv8SurfaceKind, unknown> = { default: DEFAULT_SURFACE_RULES, floating_islands: FLOATING_SURFACE_RULES };
      writeFileSync(DENSITY_FIXTURE, fixtureText(DENSITY_KINDS, density));
      writeFileSync(SURFACE_FIXTURE, fixtureText(SURFACE_KINDS, surface));
      for (const k of DENSITY_KINDS) console.log(`density ${k}: ${hashOf(density[k])}`);
      for (const k of SURFACE_KINDS) console.log(`surface ${k}: ${hashOf(surface[k])}`);
    });
    return;
  }

  test('hold exactly the three density kinds and the two surface kinds', () => {
    expect(Object.keys(gv8DensityTrees()).sort()).toEqual([...DENSITY_KINDS].sort());
    expect(Object.keys(gv8SurfaceTrees()).sort()).toEqual([...SURFACE_KINDS].sort());
  });

  test.each(DENSITY_KINDS)('the %s density tree hashes to its literal', (k) => {
    expect(hashOf(gv8DensityTrees()[k])).toBe(GV8_DENSITY_HASHES[k]);
  });

  test.each(SURFACE_KINDS)('the %s surface tree hashes to its literal', (k) => {
    expect(hashOf(gv8SurfaceTrees()[k])).toBe(GV8_SURFACE_HASHES[k]);
  });

  test.each(DENSITY_KINDS)('the %s density tree passes tier 2', (k) => {
    expect(validateDensitySource(gv8DensityTrees()[k])).toEqual([]);
  });

  test.each(SURFACE_KINDS)('the %s surface tree passes tier 2', (k) => {
    expect(validateRulesSource(gv8SurfaceTrees()[k])).toEqual([]);
  });

  test('five distinct hashes, none an SP6a or SP5c tree\'s (the GV8 trees are their own)', () => {
    const all = [...Object.values(GV8_DENSITY_HASHES), ...Object.values(GV8_SURFACE_HASHES)];
    expect(new Set(all).size).toBe(5);
    for (const old of ['8cf2fa9f77894514', 'e9aa9c6d389bfe7a', '0b64462b64d8c360', '601ec40ff887ce6b', '21a5b1125d506c73', 'ee32a0fee794e90b']) expect(all).not.toContain(old);
  });
});

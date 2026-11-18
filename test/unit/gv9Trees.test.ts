/**
 * The built-in surface trees at `GENERATOR_VERSION` 9 (SP7a D34, spec §15.4): `DEFAULT_SURFACE_RULES` and
 * floating_islands' as they stood at 78c48e4 (SP7a's push base), before rule 4's under-water branches, kept as canonical
 * JSON in `test/fixtures/gv9-surface-trees.json`. The code keeps only their hashes (`MIGRATIONS[4]`'s
 * `GV9_SURFACE_HASHES`, schema version 6); this test pins the same two literals, so a fixture edit, or a migration
 * literal that drifts, fails here. The GV8 fixtures and `test/unit/gv8Trees.test.ts` are SP6b's.
 *
 * `WRITE_GV9_TREES=1` (a one-off, run once at 78c48e4's trees) writes the fixture from today's `DEFAULT_SURFACE_RULES`
 * and `FLOATING_SURFACE_RULES` and prints the hashes.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { FLOATING_SURFACE_RULES } from '../../src/core/params/presetTrees';
import { fnv1a64, hex64 } from '../../src/core/hash';
import { validateRulesSource } from '../../src/gen/surface/source';
import { gv9SurfaceTrees, type Gv9SurfaceKind } from '../harness/gv9Trees';

const SURFACE_FIXTURE = new URL('../fixtures/gv9-surface-trees.json', import.meta.url);

/** `hex64(fnv1a64(canonicalJSON(tree)))` of each GV9 surface tree (the literals `MIGRATIONS[4]` repeats). */
const GV9_SURFACE_HASHES: Readonly<Record<Gv9SurfaceKind, string>> = {
  default: '1f4054f83dc79614',
  floating_islands: '740973420dda53df',
};

const SURFACE_KINDS: readonly Gv9SurfaceKind[] = ['default', 'floating_islands'];
const hashOf = (tree: unknown): string => hex64(fnv1a64(canonicalJSON(tree)));

/** The fixture's text: one canonical tree per kind, in `SURFACE_KINDS`' order. */
const fixtureText = (trees: Record<Gv9SurfaceKind, unknown>): string =>
  `{\n${SURFACE_KINDS.map((k) => `  ${JSON.stringify(k)}: ${canonicalJSON(trees[k])}`).join(',\n')}\n}\n`;

describe('the GV9 built-in surface trees fixture (SP7a D34, spec §15.4)', () => {
  if (process.env['WRITE_GV9_TREES'] === '1') {
    test('writes the fixture from the built-in surface trees', () => {
      const surface: Record<Gv9SurfaceKind, unknown> = { default: DEFAULT_SURFACE_RULES, floating_islands: FLOATING_SURFACE_RULES };
      writeFileSync(SURFACE_FIXTURE, fixtureText(surface));
      for (const k of SURFACE_KINDS) console.log(`surface ${k}: ${hashOf(surface[k])}`);
    });
    return;
  }

  test('holds exactly the two surface kinds', () => {
    expect(Object.keys(gv9SurfaceTrees()).sort()).toEqual([...SURFACE_KINDS].sort());
  });

  test.each(SURFACE_KINDS)('the %s surface tree hashes to its literal', (k) => {
    expect(hashOf(gv9SurfaceTrees()[k])).toBe(GV9_SURFACE_HASHES[k]);
  });

  test.each(SURFACE_KINDS)('the %s surface tree passes tier 2', (k) => {
    expect(validateRulesSource(gv9SurfaceTrees()[k])).toEqual([]);
  });

  test('two distinct hashes, neither a GV8 surface tree\'s (the GV9 trees are their own)', () => {
    const all = Object.values(GV9_SURFACE_HASHES);
    expect(new Set(all).size).toBe(2);
    for (const old of ['12b40aeca522f544', '86856ea3ad435d0b']) expect(all).not.toContain(old);
  });
});

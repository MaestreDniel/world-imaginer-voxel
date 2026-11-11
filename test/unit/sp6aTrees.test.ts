/**
 * The three SP6a built-in density trees (default, amplified, floating_islands) as they stood before the user's check
 * gave the noodle toggle its threshold leaf (ruling R31; the trees at dc60e67, unchanged since 0689c4f), kept as
 * canonical JSON in `test/fixtures/sp6a-density-trees.json`. The code keeps only their hashes (`MIGRATIONS[2]`'s
 * `SP6A_TREE_HASHES`, schema version 4); this test pins the same three literals, so a fixture edit, or a migration
 * literal that drifts, fails here.
 *
 * `WRITE_SP6A_TREES=1` (a one-off, run once at dc60e67's trees) writes the fixture from today's
 * `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE` and `FLOATING_DENSITY_TREE` and prints the hashes.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { fnv1a64, hex64 } from '../../src/core/hash';
import { validateDensitySource } from '../../src/gen/density/source';
import { sp6aTrees, type Sp6aKind } from '../harness/sp6aTrees';

const FIXTURE = new URL('../fixtures/sp6a-density-trees.json', import.meta.url);

/** `hex64(fnv1a64(canonicalJSON(tree)))` of each SP6a tree (the literals `MIGRATIONS[2]` repeats). */
const SP6A_HASHES: Readonly<Record<Sp6aKind, string>> = {
  default: '8cf2fa9f77894514',
  amplified: 'e9aa9c6d389bfe7a',
  floating_islands: '0b64462b64d8c360',
};

const KINDS: readonly Sp6aKind[] = ['default', 'amplified', 'floating_islands'];
const hashOf = (tree: unknown): string => hex64(fnv1a64(canonicalJSON(tree)));

describe('the SP6a density trees fixture (the user\'s check, R31)', () => {
  if (process.env['WRITE_SP6A_TREES'] === '1') {
    test('writes the fixture from the built-in trees', () => {
      const trees: Record<Sp6aKind, unknown> = { default: DEFAULT_DENSITY_TREE, amplified: AMPLIFIED_DENSITY_TREE, floating_islands: FLOATING_DENSITY_TREE };
      const body = KINDS.map((k) => `  ${JSON.stringify(k)}: ${canonicalJSON(trees[k])}`).join(',\n');
      writeFileSync(FIXTURE, `{\n${body}\n}\n`);
      for (const k of KINDS) console.log(`${k}: ${hashOf(trees[k])}`);
    });
    return;
  }

  test('holds exactly the three kinds', () => {
    expect(Object.keys(sp6aTrees()).sort()).toEqual([...KINDS].sort());
  });

  test.each(KINDS)('%s hashes to its literal', (k) => {
    expect(hashOf(sp6aTrees()[k])).toBe(SP6A_HASHES[k]);
  });

  test.each(KINDS)('%s passes tier 2', (k) => {
    expect(validateDensitySource(sp6aTrees()[k])).toEqual([]);
  });

  test.each(KINDS)('%s reads no caves.noodles.threshold (the leaf came after it)', (k) => {
    expect(canonicalJSON(sp6aTrees()[k])).not.toContain('caves.noodles.threshold');
  });
});

/**
 * The three SP5c built-in density trees (default, amplified, floating_islands) as they stood before SP6a's tree change
 * (`c64b4a9`), kept as canonical JSON in `test/fixtures/sp5c-density-trees.json` (SP6a Task 4). The code keeps only
 * their hashes (`MIGRATIONS[1]`'s `SP5C_TREE_HASHES`, D36); this test pins the same three literals, so a fixture edit,
 * or a migration literal that drifts, fails here.
 *
 * `WRITE_SP5C_TREES=1` (a one-off, run once at c64b4a9's trees) writes the fixture from today's
 * `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE` and `FLOATING_DENSITY_TREE` and prints the hashes.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { fnv1a64, hex64 } from '../../src/core/hash';
import { validateDensitySource } from '../../src/gen/density/source';
import { sp5cTrees, type Sp5cKind } from '../harness/sp5cTrees';

const FIXTURE = new URL('../fixtures/sp5c-density-trees.json', import.meta.url);

/** `hex64(fnv1a64(canonicalJSON(tree)))` of each SP5c tree (the literals `MIGRATIONS[1]` repeats). */
const SP5C_HASHES: Readonly<Record<Sp5cKind, string>> = {
  default: '601ec40ff887ce6b',
  amplified: '21a5b1125d506c73',
  floating_islands: 'ee32a0fee794e90b',
};

type Kind = Sp5cKind;
const KINDS: readonly Kind[] = ['default', 'amplified', 'floating_islands'];
const hashOf = (tree: unknown): string => hex64(fnv1a64(canonicalJSON(tree)));

describe('the SP5c density trees fixture (SP6a D36)', () => {
  if (process.env['WRITE_SP5C_TREES'] === '1') {
    test('writes the fixture from the built-in trees', () => {
      const trees: Record<Kind, unknown> = { default: DEFAULT_DENSITY_TREE, amplified: AMPLIFIED_DENSITY_TREE, floating_islands: FLOATING_DENSITY_TREE };
      const body = KINDS.map((k) => `  ${JSON.stringify(k)}: ${canonicalJSON(trees[k])}`).join(',\n');
      writeFileSync(FIXTURE, `{\n${body}\n}\n`);
      for (const k of KINDS) console.log(`${k}: ${hashOf(trees[k])}`);
    });
    return;
  }

  test('holds exactly the three kinds', () => {
    expect(Object.keys(sp5cTrees()).sort()).toEqual([...KINDS].sort());
  });

  test.each(KINDS)('%s hashes to its literal', (k) => {
    expect(hashOf(sp5cTrees()[k])).toBe(SP5C_HASHES[k]);
  });

  test.each(KINDS)('%s passes tier 2', (k) => {
    expect(validateDensitySource(sp5cTrees()[k])).toEqual([]);
  });
});

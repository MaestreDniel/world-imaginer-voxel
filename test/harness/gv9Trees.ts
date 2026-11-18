/**
 * The built-in surface trees at `GENERATOR_VERSION` 9 (`test/fixtures/gv9-surface-trees.json`), written by
 * `test/unit/gv9Trees.test.ts` from the code at 78c48e4 (SP7a's push base), before rule 4's under-water branches change
 * them (SP7a D34, spec §15.4). `MIGRATIONS[4]` keeps only their hashes. The density trees are not kept: D24 leaves them
 * untouched.
 */
import { readFileSync } from 'node:fs';

export type Gv9SurfaceKind = 'default' | 'floating_islands';

const SURFACE = new URL('../fixtures/gv9-surface-trees.json', import.meta.url);

/** The surface fixture's two trees (fresh, unfrozen copies on every call). */
export function gv9SurfaceTrees(): Record<Gv9SurfaceKind, unknown> {
  return JSON.parse(readFileSync(SURFACE, 'utf8')) as Record<Gv9SurfaceKind, unknown>;
}

/**
 * The built-in trees at `GENERATOR_VERSION` 8 (`test/fixtures/gv8-density-trees.json`, `gv8-surface-trees.json`),
 * written by `test/unit/gv8Trees.test.ts` from the code at aed4e07 (SP6b's push base, its trees those of 1ac9e7b),
 * before SP6b's floor and rule 4 change them (SP6b D29, spec §14.4). `MIGRATIONS[3]` keeps only their hashes.
 */
import { readFileSync } from 'node:fs';

export type Gv8DensityKind = 'default' | 'amplified' | 'floating_islands';
export type Gv8SurfaceKind = 'default' | 'floating_islands';

const DENSITY = new URL('../fixtures/gv8-density-trees.json', import.meta.url);
const SURFACE = new URL('../fixtures/gv8-surface-trees.json', import.meta.url);

/** The density fixture's three trees (fresh, unfrozen copies on every call). */
export function gv8DensityTrees(): Record<Gv8DensityKind, unknown> {
  return JSON.parse(readFileSync(DENSITY, 'utf8')) as Record<Gv8DensityKind, unknown>;
}

/** The surface fixture's two trees (fresh, unfrozen copies on every call). */
export function gv8SurfaceTrees(): Record<Gv8SurfaceKind, unknown> {
  return JSON.parse(readFileSync(SURFACE, 'utf8')) as Record<Gv8SurfaceKind, unknown>;
}

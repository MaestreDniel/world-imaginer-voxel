/**
 * The SP6a built-in density trees (`test/fixtures/sp6a-density-trees.json`), written by `test/unit/sp6aTrees.test.ts`
 * from the code at dc60e67 (the trees of SP6a's exit, unchanged since 0689c4f), before the user's check gave the noodle
 * toggle its threshold (ruling R31). `MIGRATIONS[2]` keeps only their hashes.
 */
import { readFileSync } from 'node:fs';

export type Sp6aKind = 'default' | 'amplified' | 'floating_islands';

const FIXTURE = new URL('../fixtures/sp6a-density-trees.json', import.meta.url);

/** The fixture's three trees (fresh, unfrozen copies on every call). */
export function sp6aTrees(): Record<Sp6aKind, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<Sp6aKind, unknown>;
}

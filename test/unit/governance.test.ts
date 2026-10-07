import { describe, expect, test } from 'vitest';
import { checkGovernance, parseGeneratorVersion, type GovernanceInput } from '../harness/governance';

const base: GovernanceInput = {
  baseGoldens: { generatorVersion: 1, entries: { a: '1', b: '2' } },
  headGoldens: { generatorVersion: 1, entries: { a: '1', b: '2' } },
  baseVersion: 1,
  headVersion: 1,
  changedFiles: [],
  baseStateIds: { air: 0, stone: 1 },
  headStateIds: { air: 0, stone: 1 },
};

describe('checkGovernance', () => {
  test('unchanged goldens and lock pass; new golden keys need no bump', () => {
    expect(checkGovernance(base)).toEqual([]);
    expect(checkGovernance({ ...base, headGoldens: { generatorVersion: 1, entries: { a: '1', b: '2', c: '3' } } })).toEqual([]);
  });

  test('a changed or removed golden without a version bump fails (hand edits included)', () => {
    const edited = { ...base, headGoldens: { generatorVersion: 1, entries: { a: 'x' } } };
    expect(checkGovernance(edited)).toEqual(['goldens changed or removed without a GENERATOR_VERSION bump: a, b']);
    expect(checkGovernance({ ...edited, headVersion: 2 })).toEqual([]);
  });

  test('a lock change needs a spec change in the same range', () => {
    const lockOnly = { ...base, changedFiles: ['test/thresholds.lock.json', 'test/thresholds.ts'] };
    expect(checkGovernance(lockOnly)).toEqual(['test/thresholds.lock.json changed without a change under docs/superpowers/specs/']);
    expect(checkGovernance({ ...lockOnly, changedFiles: [...lockOnly.changedFiles, 'docs/superpowers/specs/2026-10-01-sp1-x-design.md'] })).toEqual([]);
  });

  test('test/stateIds.lock.json is append-only against the base (SP3b spec §7): appended states pass', () => {
    expect(checkGovernance({ ...base, headStateIds: { air: 0, stone: 1, water: 2 } })).toEqual([]);
    expect(checkGovernance({ ...base, baseStateIds: null })).toEqual([]);
    expect(checkGovernance({ ...base, baseStateIds: null, headStateIds: null })).toEqual([]);
  });

  test('a removed or renumbered locked state, an id below the locked ones, or a deleted lock fails', () => {
    const lock = (head: Record<string, number> | null) => checkGovernance({ ...base, baseStateIds: { air: 0, stone: 1, dirt: 3 }, headStateIds: head });
    expect(lock({ air: 0, stone: 2, dirt: 3 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: stone id 1 → 2']);
    expect(lock({ air: 0, dirt: 3 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: stone (id 1) removed']);
    expect(lock({ air: 0, stone: 1, dirt: 3, sand: 2 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: sand (id 2) is not after the locked ids (≤ 3)']);
    expect(lock({ air: 0, stone: 1, dirt: 3, sand: 4 })).toEqual([]);
    expect(lock(null)).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: the lock was deleted']);
    // A hand edit of both the registry and the lock passes the local lock test; only this check sees it.
    expect(lock({ air: 0, stone: 3, dirt: 1 })).toEqual(['test/stateIds.lock.json is append-only against GOVERNANCE_BASE: stone id 1 → 3, dirt id 3 → 1']);
  });

  test('no goldens at the base ref means nothing to protect yet', () => {
    expect(checkGovernance({ ...base, baseGoldens: null, baseVersion: null })).toEqual([]);
  });
});

test('parseGeneratorVersion reads the constant', () => {
  expect(parseGeneratorVersion('export const GENERATOR_VERSION = 12;')).toBe(12);
  expect(parseGeneratorVersion('nothing')).toBeNull();
});

test('parseGeneratorVersion reads the constant with an explicit type annotation', () => {
  expect(parseGeneratorVersion('export const GENERATOR_VERSION: number = 1;')).toBe(1);
});

import { describe, expect, test } from 'vitest';
import { checkGovernance, parseGeneratorVersion, type GovernanceInput } from '../harness/governance';

const base: GovernanceInput = {
  baseGoldens: { generatorVersion: 1, entries: { a: '1', b: '2' } },
  headGoldens: { generatorVersion: 1, entries: { a: '1', b: '2' } },
  baseVersion: 1,
  headVersion: 1,
  changedFiles: [],
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

  test('no goldens at the base ref means nothing to protect yet', () => {
    expect(checkGovernance({ ...base, baseGoldens: null, baseVersion: null })).toEqual([]);
  });
});

test('parseGeneratorVersion reads the constant', () => {
  expect(parseGeneratorVersion('export const GENERATOR_VERSION = 12;')).toBe(12);
  expect(parseGeneratorVersion('nothing')).toBeNull();
});

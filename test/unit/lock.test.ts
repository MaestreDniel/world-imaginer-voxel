import { describe, expect, test } from 'vitest';
import { canonicalJson, diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState } from '../harness/lock';

const base: GovernanceState = {
  thresholds: { T1: { band: { max: 0.25, activeFrom: 'SP3a' }, span: { min: 60, activeFrom: 'SP3a' } } },
  startedSps: ['SP0', 'SP1', 'SP2a', 'SP2b', 'SP3a'],
};

describe('canonical JSON and lock', () => {
  test('keys are sorted and undefined fields dropped', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}]},"b":1}');
  });

  test('a lock verifies and detects tampering', () => {
    const lock = makeLock(base);
    expect(verifyLock(lock)).toBe(true);
    expect(verifyLock({ ...lock, sha256: '0'.repeat(64) })).toBe(false);
  });
});

describe('diffGovernance', () => {
  const edit = (f: (s: GovernanceState) => void): GovernanceState => {
    const s = structuredClone(base) as GovernanceState;
    f(s);
    return s;
  };

  test('no change → empty diff', () => {
    expect(diffGovernance(base, structuredClone(base) as GovernanceState)).toEqual([]);
  });

  test('raising a max loosens, lowering it tightens', () => {
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.max = 0.3; }))).toEqual([
      { path: 'T1.band', detail: 'max 0.25→0.3', kind: 'LOOSEN' },
    ]);
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.max = 0.2; }))[0]!.kind).toBe('TIGHTEN');
  });

  test('lowering a min loosens; a later activeFrom loosens', () => {
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.span!.min = 50; }))[0]).toEqual(
      { path: 'T1.span', detail: 'min 60→50', kind: 'LOOSEN' },
    );
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.span!.activeFrom = 'SP6'; }))[0]).toEqual(
      { path: 'T1.span', detail: 'activeFrom SP3a→SP6', kind: 'LOOSEN' },
    );
  });

  test('restricting a part to fewer tiers loosens; widening its tiers tightens; the lock records them', () => {
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.tiers = ['full']; }))).toEqual([
      { path: 'T1.band', detail: 'tiers all→[full]', kind: 'LOOSEN' },
    ]);
    const fullOnly = edit((s) => { s.thresholds.T1!.band!.tiers = ['full']; });
    expect(diffGovernance(fullOnly, edit((s) => { s.thresholds.T1!.band!.tiers = ['quick', 'full']; }))).toEqual([
      { path: 'T1.band', detail: 'tiers [full]→[quick, full]', kind: 'TIGHTEN' },
    ]);
    expect(diffGovernance(fullOnly, base)).toEqual([{ path: 'T1.band', detail: 'tiers [full]→all', kind: 'TIGHTEN' }]);
    expect(diffGovernance(fullOnly, edit((s) => { s.thresholds.T1!.band!.tiers = ['quick']; }))[0]!.kind).toBe('LOOSEN');
    expect(diffGovernance(base, edit((s) => { s.thresholds.T1!.band!.tiers = ['fast', 'quick', 'full']; }))).toEqual([]);
    expect(makeLock(fullOnly).sha256).not.toBe(makeLock(base).sha256);
  });

  test('removing an active part loosens; adding a part tightens', () => {
    expect(diffGovernance(base, edit((s) => { delete s.thresholds.T1!.span; }))[0]).toEqual(
      { path: 'T1.span', detail: 'removed', kind: 'LOOSEN' },
    );
    expect(diffGovernance(base, edit((s) => { s.thresholds.C1 = { default: { min: 0.05, activeFrom: 'SP6' } }; }))[0]).toEqual(
      { path: 'C1.default', detail: 'added', kind: 'TIGHTEN' },
    );
  });

  test('removing a started SP loosens; adding one tightens', () => {
    expect(diffGovernance(base, edit((s) => { s.startedSps = ['SP0', 'SP1', 'SP2a', 'SP2b']; }))).toEqual([
      { path: 'startedSps', detail: 'removed SP3a', kind: 'LOOSEN' },
    ]);
    expect(diffGovernance(base, edit((s) => { s.startedSps = [...s.startedSps, 'SP4']; }))).toEqual([
      { path: 'startedSps', detail: 'added SP4', kind: 'TIGHTEN' },
    ]);
  });

  test('formatChanges prints one tagged line per change', () => {
    expect(formatChanges([{ path: 'T1.band', detail: 'max 0.25→0.3', kind: 'LOOSEN' }])).toBe('LOOSEN  T1.band  max 0.25→0.3');
  });
});

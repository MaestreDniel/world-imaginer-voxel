import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState, type LockFile } from '../harness/lock';
import { coverageErrors, findMetricCalls } from '../harness/metric';
import { STARTED_SPS } from '../harness/sp';
import { THRESHOLDS } from '../thresholds';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../thresholds.lock.json', import.meta.url));

test('thresholds lock matches THRESHOLDS and STARTED_SPS', () => {
  const live = makeLock({ thresholds: THRESHOLDS, startedSps: STARTED_SPS });
  const stored = existsSync(LOCK_PATH) ? (JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as LockFile) : null;
  const changes = stored ? diffGovernance(stored.canonical as GovernanceState, live.canonical as GovernanceState) : [];
  const report = formatChanges(changes);
  if (process.env.ACCEPT_THRESHOLDS === '1') {
    writeFileSync(LOCK_PATH, `${JSON.stringify(live, null, 2)}\n`);
    console.log(report.length > 0 ? report : 'no threshold changes; lock rewritten');
    return;
  }
  expect(stored, 'test/thresholds.lock.json missing: run npm run test:accept-thresholds').not.toBeNull();
  expect(verifyLock(stored!), 'lock sha256 does not match its canonical content').toBe(true);
  expect(stored!.canonical, `governance state changed:\n${report}\nrun npm run test:accept-thresholds and amend the spec`).toEqual(live.canonical);
});

test('every active threshold part is covered by exactly one metricTest', () => {
  expect(coverageErrors(findMetricCalls(ROOT))).toEqual([]);
});

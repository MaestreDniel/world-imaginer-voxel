import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { diffGovernance, formatChanges, makeLock, verifyLock, type GovernanceState, type LockFile } from '../harness/lock';
import { coverageErrors, findMetricCalls } from '../harness/metric';
import { STARTED_SPS } from '../harness/sp';
import { THRESHOLDS, type ThresholdTable } from '../thresholds';

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

test('findMetricCalls reads ids with a lowercase suffix (T1lowland) and multi-line part lists', () => {
  const root = mkdtempSync(join(tmpdir(), 'wi-metric-calls-'));
  try {
    mkdirSync(join(root, 'test', 'metrics'), { recursive: true });
    writeFileSync(join(root, 'test', 'metrics', 'x.metric.ts'), "metricTest('T1lowland', ['value'], () => ({ value: 0 }));\nmetricTest('B2', [\n  'a',\n  'b',\n], () => ({}));\n");
    expect(findMetricCalls(root).map((c) => `${c.id}:${c.parts.join('|')}`)).toEqual(['T1lowland:value', 'B2:a|b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findMetricCalls reads each call\'s .out name (default: the id); two calls for one id writing one .out file are refused', () => {
  // SP3c spec §5.2: `outName` keeps the 2D record (.out/B4.json) beside the voxel one; without it the second call's
  // record silently replaces the first.
  const rows: ThresholdTable = { B4: { a: { min: 0, activeFrom: 'SP2a' }, b: { min: 0, activeFrom: 'SP3c' } } };
  const root = mkdtempSync(join(tmpdir(), 'wi-metric-calls-'));
  const write = (text: string) => writeFileSync(join(root, 'test', 'metrics', 'x.metric.ts'), text);
  try {
    mkdirSync(join(root, 'test', 'metrics'), { recursive: true });
    write("metricTest('B4', ['a'], () => ({ a: 0 }));\nmetricTest('B4', ['b'], async () => {\n  return { b: 0 };\n}, 600_000);\n");
    expect(findMetricCalls(root).map((c) => `${c.id}:${c.parts.join('|')}:${c.outName}`)).toEqual(['B4:a:B4', 'B4:b:B4']);
    expect(coverageErrors(findMetricCalls(root), rows, ['SP2a', 'SP3c'])).toEqual(['B4: 2 metricTest calls write .out/B4.json']);
    write("metricTest('B4', ['a'], () => ({ a: 0 }));\nmetricTest('B4', ['b'], async () => {\n  return { b: 0 };\n}, 600_000, { outName: 'B4.voxel' });\n");
    expect(findMetricCalls(root).map((c) => `${c.id}:${c.parts.join('|')}:${c.outName}`)).toEqual(['B4:a:B4', 'B4:b:B4.voxel']);
    expect(coverageErrors(findMetricCalls(root), rows, ['SP2a', 'SP3c'])).toEqual([]);
    // An out name the scan cannot read (not a string literal) is refused too: the collision check would be blind.
    write("const NAME = 'B4.voxel';\nmetricTest('B4', ['a'], () => ({ a: 0 }));\nmetricTest('B4', ['b'], () => ({ b: 0 }), 600_000, { outName: NAME });\n");
    expect(coverageErrors(findMetricCalls(root), rows, ['SP2a', 'SP3c'])).toEqual(['test/metrics/x.metric.ts: B4 has an outName that is not a string literal']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { GoldensFile } from '../harness/goldens';
import { checkGovernance, parseGeneratorVersion } from '../harness/governance';
import { readStateLock, STATE_LOCK_PATH, type StateIdLock } from '../harness/stateLock';
import { ROOT } from './scan';

const BASE = process.env.GOVERNANCE_BASE ?? '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const showAtBase = (path: string): string | null => {
  try { return git('show', `${BASE}:${path}`); } catch { return null; }
};

test.skipIf(BASE === '' || /^0+$/.test(BASE))('goldens, threshold lock and state-id lock changes follow governance (CI, against GOVERNANCE_BASE)', () => {
  const baseGoldensText = showAtBase('test/goldens.json');
  const baseConstants = showAtBase('src/core/constants.ts');
  const baseStateIdsText = showAtBase('test/stateIds.lock.json');
  const headVersion = parseGeneratorVersion(readFileSync(join(ROOT, 'src/core/constants.ts'), 'utf8'));
  if (headVersion === null) throw new Error('cannot parse GENERATOR_VERSION from src/core/constants.ts');
  const errors = checkGovernance({
    baseGoldens: baseGoldensText ? (JSON.parse(baseGoldensText) as GoldensFile) : null,
    headGoldens: JSON.parse(readFileSync(join(ROOT, 'test/goldens.json'), 'utf8')) as GoldensFile,
    baseVersion: baseConstants ? parseGeneratorVersion(baseConstants) : null,
    headVersion,
    changedFiles: git('diff', '--name-only', BASE, 'HEAD').split('\n').filter((f) => f.length > 0),
    baseStateIds: baseStateIdsText ? (JSON.parse(baseStateIdsText) as StateIdLock) : null,
    headStateIds: readStateLock(STATE_LOCK_PATH),
  });
  expect(errors).toEqual([]);
});

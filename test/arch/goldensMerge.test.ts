import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { GENERATOR_VERSION } from '../../src/core/constants';
import { GOLDENS_PATH, mergeObservations, OBSERVATIONS_DIR, readObservations, type GoldensFile } from '../harness/goldens';

test.skipIf(process.env.MERGE_GOLDENS !== '1')('merge recorded golden observations', () => {
  const base = JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldensFile;
  const result = mergeObservations(base, readObservations(OBSERVATIONS_DIR), GENERATOR_VERSION);
  expect(result.ok ? [] : result.errors).toEqual([]);
  if (result.ok) writeFileSync(GOLDENS_PATH, `${JSON.stringify(result.next, null, 2)}\n`);
});

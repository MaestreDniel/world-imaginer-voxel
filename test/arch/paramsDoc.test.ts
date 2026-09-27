import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { renderReference } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { README_PATH, readmeBlock, replaceReadmeBlock } from '../harness/schemaShape';

test('README parameter reference is fresh', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const table = renderReference(SCHEMA);
  if (process.env.WRITE_PARAMS_DOC === '1') {
    writeFileSync(README_PATH, replaceReadmeBlock(readme, table));
    return;
  }
  expect(readmeBlock(readme), 'README params block is stale: run npm run docs:params').toBe(table);
});

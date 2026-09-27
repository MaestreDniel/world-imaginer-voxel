import { existsSync, readFileSync } from 'node:fs';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { renderReference } from '../../src/core/params/kit';
import { migrate, MIGRATIONS, SCHEMA_VERSION, type JsonObject } from '../../src/core/params/migrate';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { PROFILE_IDS, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { checkRegistry, STAGES } from '../../src/core/stage/registry';
import { metricTest } from '../harness/metric';
import { randomParams } from '../harness/params';
import { currentShape, README_PATH, readmeBlock, readShapeLock, shapeViolations } from '../harness/schemaShape';
import { testRng } from '../harness/stats';

metricTest('U4', ['registryIssues', 'migrationFailures', 'shapeLockViolations', 'readmeStale'], () => {
  const registryIssues = checkRegistry(SCHEMA, STAGES).length;

  let migrationFailures = 0;
  if (MIGRATIONS.length !== SCHEMA_VERSION - 1) migrationFailures++;
  const id = migrate(DEFAULTS as unknown as JsonObject, SCHEMA_VERSION);
  if (!id.ok || id.value !== (DEFAULTS as unknown)) migrationFailures++;
  for (let v = 1; v < SCHEMA_VERSION; v++) {
    const doc = new URL(`../fixtures/preset-v${v}.json`, import.meta.url);
    const expected = new URL(`../fixtures/expected-v${v}.json`, import.meta.url);
    if (!existsSync(doc) || !existsSync(expected)) { migrationFailures++; continue; }
    const r = importPreset(JSON.parse(readFileSync(doc, 'utf8')) as unknown);
    if (!r.ok || canonicalJSON(r.value.params) !== canonicalJSON(JSON.parse(readFileSync(expected, 'utf8')))) migrationFailures++;
  }
  const next = testRng(401);
  const drafts = [...PROFILE_IDS.map((p) => [p, resolveProfile(p)] as const), ...Array.from({ length: 100 }, (_, i) => [PROFILE_IDS[i % PROFILE_IDS.length]!, randomParams(SCHEMA, next)] as const)];
  for (const [profile, draft] of drafts) {
    const r = importPreset(JSON.parse(JSON.stringify(exportPreset('U4 draft', profile, draft))) as unknown);
    if (!r.ok || canonicalJSON(r.value.params) !== canonicalJSON(draft)) migrationFailures++;
  }

  const shapeLockViolations = shapeViolations(readShapeLock(), currentShape(SCHEMA), SCHEMA_VERSION).length;
  const readmeStale = readmeBlock(readFileSync(README_PATH, 'utf8')) === renderReference(SCHEMA) ? 0 : 1;
  return { registryIssues, migrationFailures, shapeLockViolations, readmeStale };
});

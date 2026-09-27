import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core/params/migrate';
import { SCHEMA } from '../../src/core/params/schema';
import { acceptShape, currentShape, readShapeLock, SHAPE_LOCK_PATH, shapeViolations } from '../harness/schemaShape';

test('schema shape matches test/schema-shape.lock.json', () => {
  const lock = readShapeLock();
  const current = currentShape(SCHEMA);
  if (process.env.ACCEPT_SCHEMA === '1') {
    const r = acceptShape(lock, current, SCHEMA_VERSION);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) writeFileSync(SHAPE_LOCK_PATH, `${JSON.stringify(r.next, null, 2)}\n`);
    return;
  }
  expect(shapeViolations(lock, current, SCHEMA_VERSION)).toEqual([]);
});

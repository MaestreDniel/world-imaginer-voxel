import { describe, expect, test } from 'vitest';
import { acceptShape, readmeBlock, replaceReadmeBlock, shapeViolations } from '../harness/schemaShape';

const lock = { schemaVersion: 1, leaves: { 'a.x': 'number', 'a.n': 'noise' } };

describe('shapeViolations', () => {
  test('equal shape passes', () => {
    expect(shapeViolations(lock, { 'a.x': 'number', 'a.n': 'noise' }, 1)).toEqual([]);
  });
  test('missing lock', () => {
    expect(shapeViolations(null, {}, 1)).toEqual(['test/schema-shape.lock.json is missing: run npm run test:accept-schema']);
  });
  test('removed, renamed or re-kinded leaves need a version bump', () => {
    expect(shapeViolations(lock, { 'a.y': 'number', 'a.n': 'spline' }, 1)).toEqual([
      'a.x removed or renamed: bump SCHEMA_VERSION and add a migration',
      'a.n changed kind noise → spline: bump SCHEMA_VERSION and add a migration',
      'leaves added (a.y): run npm run test:accept-schema',
    ]);
  });
  test('added leaves or a newer version only need an accept', () => {
    expect(shapeViolations(lock, { 'a.x': 'number', 'a.n': 'noise', 'b.z': 'bool' }, 1)).toEqual(['leaves added (b.z): run npm run test:accept-schema']);
    expect(shapeViolations(lock, { 'a.x': 'number' }, 2)).toEqual(['SCHEMA_VERSION 2 is ahead of the lock (1): run npm run test:accept-schema']);
  });
});

describe('acceptShape', () => {
  test('refuses removals without a version bump', () => {
    expect(acceptShape(lock, { 'a.n': 'noise' }, 1)).toEqual({ ok: false, errors: ['a.x removed or renamed: bump SCHEMA_VERSION and add a migration'] });
  });
  test('accepts additions and bumped versions', () => {
    expect(acceptShape(lock, { 'a.x': 'number', 'a.n': 'noise', 'b.z': 'bool' }, 1)).toEqual({ ok: true, next: { schemaVersion: 1, leaves: { 'a.n': 'noise', 'a.x': 'number', 'b.z': 'bool' } } });
    expect(acceptShape(lock, { 'a.y': 'number' }, 2)).toEqual({ ok: true, next: { schemaVersion: 2, leaves: { 'a.y': 'number' } } });
    expect(acceptShape(null, { 'a.y': 'number' }, 1).ok).toBe(true);
  });
});

test('README block helpers', () => {
  const readme = 'intro\n<!-- params:begin -->\nold\n<!-- params:end -->\nend\n';
  expect(readmeBlock(readme)).toBe('old');
  expect(replaceReadmeBlock(readme, 'new\ntable')).toBe('intro\n<!-- params:begin -->\nnew\ntable\n<!-- params:end -->\nend\n');
  expect(readmeBlock('no markers')).toBeNull();
});

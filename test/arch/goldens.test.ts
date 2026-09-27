import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createGoldenStore, mergeObservations, readObservations, type GoldensFile } from '../harness/goldens';

function tempGoldens(file: GoldensFile): { path: string; obs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'goldens-'));
  const path = join(dir, 'goldens.json');
  writeFileSync(path, JSON.stringify(file));
  return { path, obs: join(dir, 'obs') };
}

describe('check mode', () => {
  const file: GoldensFile = { generatorVersion: 3, entries: { 'region/a': 'aaa' } };

  test('a matching entry passes', () => {
    const t = tempGoldens(file);
    createGoldenStore({ path: t.path, generatorVersion: 3, mode: 'check', observationsDir: t.obs }).check('region/a', 'aaa');
  });

  test('missing entry, mismatch and a stale generatorVersion fail with hints', () => {
    const t = tempGoldens(file);
    const store = createGoldenStore({ path: t.path, generatorVersion: 3, mode: 'check', observationsDir: t.obs });
    expect(() => store.check('region/b', 'bbb')).toThrow(/missing golden region\/b.*npm run test:goldens/);
    expect(() => store.check('region/a', 'zzz')).toThrow(/golden region\/a changed: aaa → zzz/);
    const stale = createGoldenStore({ path: t.path, generatorVersion: 4, mode: 'check', observationsDir: t.obs });
    expect(() => stale.check('region/a', 'aaa')).toThrow(/goldens\.json is for GENERATOR_VERSION 3, code is 4/);
  });

  test('record mode writes observations instead of failing', () => {
    const t = tempGoldens(file);
    const store = createGoldenStore({ path: t.path, generatorVersion: 3, mode: 'record', observationsDir: t.obs });
    store.check('region/b', 'bbb');
    store.check('region/a', 'zzz');
    expect(readObservations(t.obs)).toEqual([
      { key: 'region/a', hash: 'zzz' },
      { key: 'region/b', hash: 'bbb' },
    ]);
  });
});

describe('mergeObservations', () => {
  const base: GoldensFile = { generatorVersion: 3, entries: { a: '1', b: '2' } };

  test('new keys are added without a bump; unobserved keys are kept', () => {
    expect(mergeObservations(base, [{ key: 'c', hash: '3' }], 3)).toEqual({
      ok: true, next: { generatorVersion: 3, entries: { a: '1', b: '2', c: '3' } },
    });
  });

  test('changed entries need a GENERATOR_VERSION bump and are all listed', () => {
    expect(mergeObservations(base, [{ key: 'a', hash: 'x' }, { key: 'b', hash: 'y' }], 3)).toEqual({
      ok: false, errors: ['changed without a GENERATOR_VERSION bump: a, b'],
    });
    expect(mergeObservations(base, [{ key: 'a', hash: 'x' }, { key: 'b', hash: 'y' }], 4)).toEqual({
      ok: true, next: { generatorVersion: 4, entries: { a: 'x', b: 'y' } },
    });
  });

  test('two different hashes for one key are nondeterminism', () => {
    expect(mergeObservations(base, [{ key: 'c', hash: '3' }, { key: 'c', hash: '4' }], 3)).toEqual({
      ok: false, errors: ['nondeterministic golden c: 3 vs 4'],
    });
  });

  test('a code version older than the file is rejected', () => {
    expect(mergeObservations(base, [], 2)).toEqual({ ok: false, errors: ['code GENERATOR_VERSION 2 is older than goldens.json (3)'] });
  });
});

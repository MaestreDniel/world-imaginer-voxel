/**
 * The CI shard tables (SP4b spec §1.1, D1): `shardArgs` selects a named shard's files or excludes every named file for
 * the catch-all, and `coverageProblems` holds every rule a table's `check` enforces, on synthetic file lists (no
 * `vitest list`). The unit table is the spec's ten heavy files plus `rest`; the metrics-quick table keeps its shards.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SHARDS as METRIC_SHARDS } from '../../.github/scripts/metricShards.mjs';
import { coverageProblems, shardArgs } from '../../.github/scripts/shardLib.mjs';
import { SHARDS } from '../../.github/scripts/unitShards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const HEAVY = ['sliceJob', 'floatingRules', 'workerPool', 'treeMutator', 'reviewSlices', 'columnStage', 'tile', 'fieldSlice',
  'splineFixtures', 'surfaceProbe'].map((n) => `test/unit/${n}.test.ts`);

describe('shardArgs (SP4b spec §1.1)', () => {
  test('the unit table: heavy is its ten files, rest excludes each of them', () => {
    expect(Object.keys(SHARDS)).toEqual(['heavy', 'rest']);
    expect(shardArgs(SHARDS, 'heavy')).toEqual(HEAVY);
    const rest = shardArgs(SHARDS, 'rest');
    expect(rest).toHaveLength(20);
    expect(rest).toEqual(HEAVY.flatMap((f) => ['--exclude', f]));
    for (const f of HEAVY) expect(existsSync(`${ROOT}${f}`), `${f} does not exist`).toBe(true);
  });

  test('an unknown shard names the table\'s shards', () => {
    expect(() => shardArgs(SHARDS, 'nope')).toThrow('unknown shard nope; shards: heavy, rest');
  });

  test('the metrics-quick table keeps its shards and files', () => {
    expect(Object.keys(METRIC_SHARDS)).toEqual(['terrain', 'surface', 'render', 'rest']);
    expect(METRIC_SHARDS).toEqual({
      terrain: ['test/metrics/terrain.metric.ts'],
      surface: ['test/metrics/surface.metric.ts'],
      render: ['test/metrics/render.metric.ts', 'test/metrics/light.metric.ts', 'test/metrics/g1.metric.ts', 'test/metrics/stream.metric.ts'],
      rest: null,
    });
  });
});

describe('coverageProblems (SP4b spec §1.1: every rule of check)', () => {
  const a = 'd/a.test.ts';
  const b = 'd/b.test.ts';
  const c = 'd/c.test.ts';
  const clean = {
    project: 'p',
    shards: { one: [a], rest: null },
    all: [a, b, c],
    onDisk: [a, b, c],
    listed: { one: [a], rest: [b, c] },
  };

  test('a clean table has no problems', () => {
    expect(coverageProblems(clean)).toEqual([]);
    // The listing's order does not matter.
    expect(coverageProblems({ ...clean, all: [c, a, b], listed: { one: [a], rest: [c, b] } })).toEqual([]);
  });

  test('two catch-alls', () => {
    const p = coverageProblems({ ...clean, shards: { one: null, rest: null }, listed: { one: [a], rest: [b, c] } });
    expect(p).toContain('there must be exactly one catch-all shard');
  });

  test('a named file outside the project', () => {
    const p = coverageProblems({ ...clean, shards: { one: [a, 'd/x.test.ts'], rest: null } });
    expect(p).toContain('named file d/x.test.ts is not in p');
  });

  test('a file in two shards', () => {
    expect(coverageProblems({ ...clean, listed: { one: [a], rest: [a, b, c] } })).toEqual(['d/a.test.ts is in shards one and rest']);
  });

  test('a dropped file', () => {
    expect(coverageProblems({ ...clean, listed: { one: [a], rest: [b] } })).toEqual(['no shard runs d/c.test.ts']);
  });

  test('a file outside the project', () => {
    expect(coverageProblems({ ...clean, listed: { one: [a], rest: [b, c, 'e/z.test.ts'] } }))
      .toEqual(['shards list files outside p: e/z.test.ts']);
  });

  test('an on-disk file the project does not list', () => {
    expect(coverageProblems({ ...clean, onDisk: [a, b, c, 'd/new.test.ts'] })).toEqual(['p does not list d/new.test.ts']);
  });

  test('a named shard listing other files than its own, and an empty shard', () => {
    expect(coverageProblems({ ...clean, listed: { one: [a, b], rest: [c] } }))
      .toEqual(['shard one lists d/a.test.ts, d/b.test.ts, not its named files d/a.test.ts']);
    expect(coverageProblems({ ...clean, shards: { one: [a, b, c], rest: null }, listed: { one: [a, b, c], rest: [] } }))
      .toEqual(['shard rest has no files']);
  });
});

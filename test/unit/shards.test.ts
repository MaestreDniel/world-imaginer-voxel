/**
 * The CI shard tables (SP4b spec §1.1, D1): `shardArgs` selects a named shard's files or excludes every named file for
 * the catch-all, and `coverageProblems` holds every rule a table's `check` enforces, on synthetic file lists (no
 * `vitest list`). The unit table is the spec's ten heavy files, plus the five slowest of `rest` in CI run 41132868697
 * (final review GOV-8), SP6a's slow cave files (Task 8's `caveContinuity`, Task 11's `caveTags`, Task 17's `meshXray`, Task 24's `carverPaths`),
 * SP6b Task 15's `surfaceFuzz`, and `rest`; the metrics-quick table names
 * its shards by (file, env) (SP6b spec §13 L1-L4): T1-T5 and S1-S3 by profile (`METRICS_PROFILES`), the caves by group
 * (`METRICS_CAVE_GROUPS`), `apply.metric.ts` in `terrain-default`; the metrics-fast table (SP4b spec §9's lever, taken
 * after SP4c's merge run) is `terrain`, `surface` and SP6a's `caves` alone plus `rest`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SHARDS as FAST_SHARDS } from '../../.github/scripts/fastShards.mjs';
import { SHARDS as METRIC_SHARDS } from '../../.github/scripts/metricShards.mjs';
import { coverageProblems, shardArgs, shardEnv } from '../../.github/scripts/shardLib.mjs';
import { SHARDS } from '../../.github/scripts/unitShards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const HEAVY = ['sliceJob', 'floatingRules', 'workerPool', 'treeMutator', 'reviewSlices', 'columnStage', 'tile', 'fieldSlice',
  'splineFixtures', 'surfaceProbe', 'relight', 'zeroAlloc', 'terrainStage', 'terrainHeap', 'modifyMode', 'caveContinuity',
  'caveTags', 'meshXray', 'carverPaths', 'surfaceFuzz'].map((n) => `test/unit/${n}.test.ts`);

describe('shardArgs (SP4b spec §1.1)', () => {
  test('the unit table: heavy is its twenty files, rest excludes each of them', () => {
    expect(Object.keys(SHARDS)).toEqual(['heavy', 'rest']);
    expect(shardArgs(SHARDS, 'heavy')).toEqual(HEAVY);
    const rest = shardArgs(SHARDS, 'rest');
    expect(rest).toHaveLength(40);
    expect(rest).toEqual(HEAVY.flatMap((f) => ['--exclude', f]));
    for (const f of HEAVY) expect(existsSync(`${ROOT}${f}`), `${f} does not exist`).toBe(true);
  });

  test('an unknown shard names the table\'s shards', () => {
    expect(() => shardArgs(SHARDS, 'nope')).toThrow('unknown shard nope; shards: heavy, rest');
  });

  test('the metrics-quick table by (file, env) (SP6b spec §13 L1-L4): T1-T5 and S1-S3 by profile, the caves by group, apply in terrain-default', () => {
    expect(Object.keys(METRIC_SHARDS)).toEqual([
      'terrain-default', 'terrain-large', 'surface-default', 'surface-large', 'render', 'edit', 'persist', 'clipboard', 'caves', 'caves-presets', 'rest',
    ]);
    expect(METRIC_SHARDS).toEqual({
      'terrain-default': { files: ['test/metrics/terrain.metric.ts', 'test/metrics/apply.metric.ts'], env: { METRICS_PROFILES: 'default' } },
      'terrain-large': { files: ['test/metrics/terrain.metric.ts'], env: { METRICS_PROFILES: 'large_biomes' } },
      'surface-default': { files: ['test/metrics/surface.metric.ts'], env: { METRICS_PROFILES: 'default' } },
      'surface-large': { files: ['test/metrics/surface.metric.ts'], env: { METRICS_PROFILES: 'large_biomes' } },
      render: ['test/metrics/render.metric.ts', 'test/metrics/light.metric.ts', 'test/metrics/g1.metric.ts', 'test/metrics/stream.metric.ts'],
      edit: ['test/metrics/edit.metric.ts'],
      persist: ['test/metrics/persist.metric.ts'],
      clipboard: ['test/metrics/clipboard.metric.ts'],
      caves: { files: ['test/metrics/caves.metric.ts'], env: { METRICS_CAVE_GROUPS: 'default' } },
      'caves-presets': { files: ['test/metrics/caves.metric.ts'], env: { METRICS_CAVE_GROUPS: 'presets' } },
      rest: null,
    });
    // An env shard selects its files and sets its env; a plain shard sets none.
    expect(shardArgs(METRIC_SHARDS, 'terrain-default')).toEqual(['test/metrics/terrain.metric.ts', 'test/metrics/apply.metric.ts']);
    expect(shardArgs(METRIC_SHARDS, 'caves-presets')).toEqual(['test/metrics/caves.metric.ts']);
    expect(shardEnv(METRIC_SHARDS, 'surface-large')).toEqual({ METRICS_PROFILES: 'large_biomes' });
    expect(shardEnv(METRIC_SHARDS, 'render')).toEqual({});
    expect(shardEnv(METRIC_SHARDS, 'rest')).toEqual({});
    // apply.metric.ts runs once, in terrain-default (L1).
    const shardsOf = (f: string): string[] => Object.entries(METRIC_SHARDS)
      .filter(([, s]) => s !== null && (Array.isArray(s) ? s : s.files).includes(f)).map(([n]) => n);
    expect(shardsOf('test/metrics/apply.metric.ts')).toEqual(['terrain-default']);
    expect(shardsOf('test/metrics/terrain.metric.ts')).toEqual(['terrain-default', 'terrain-large']);
    // The catch-all excludes each named file once.
    const rest = shardArgs(METRIC_SHARDS, 'rest');
    expect(rest.filter((a) => a === 'test/metrics/terrain.metric.ts')).toHaveLength(1);
    expect(rest.filter((a) => a === 'test/metrics/caves.metric.ts')).toHaveLength(1);
    expect(rest).toHaveLength(2 * 11);
  });

  test('node .github/scripts/metricShards.mjs check passes (vitest list: every metrics-quick file in its shards exactly as the table says)', () => {
    const r = spawnSync(process.execPath, ['.github/scripts/metricShards.mjs', 'check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^terrain-default: test\/metrics\/apply\.metric\.ts test\/metrics\/terrain\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^caves-presets: test\/metrics\/caves\.metric\.ts$/m);
    expect(r.stdout).toMatch(/shards cover the \d+ metrics-quick files exactly once/);
  }, 120_000);

  test('the metrics-fast table: terrain, surface and caves (SP6a spec §11) each alone, rest excludes the three', () => {
    expect(FAST_SHARDS).toEqual({
      terrain: ['test/metrics/terrain.metric.ts'],
      surface: ['test/metrics/surface.metric.ts'],
      caves: ['test/metrics/caves.metric.ts'],
      rest: null,
    });
    expect(shardArgs(FAST_SHARDS, 'rest')).toEqual([
      '--exclude', 'test/metrics/terrain.metric.ts', '--exclude', 'test/metrics/surface.metric.ts', '--exclude', 'test/metrics/caves.metric.ts',
    ]);
    expect(existsSync(`${ROOT}test/metrics/caves.metric.ts`)).toBe(true);
  });

  test('the metrics-fast table against the .metric.ts files on disk: one catch-all, each named file on disk and in one shard, rest gets the others (a listing simulated from the table, not vitest list)', () => {
    const onDisk = readdirSync(`${ROOT}test/metrics`).filter((f) => f.endsWith('.metric.ts')).map((f) => `test/metrics/${f}`).sort();
    const named = Object.values(FAST_SHARDS).filter((f) => f !== null).flat();
    const listed = Object.fromEntries(Object.entries(FAST_SHARDS).map(([name, files]) =>
      [name, files ?? onDisk.filter((f) => !named.includes(f))]));
    expect(coverageProblems({ project: 'metrics-fast', shards: FAST_SHARDS, all: onDisk, onDisk, listed })).toEqual([]);
    expect(listed.rest!.length).toBe(onDisk.length - 3);
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

  test('a file in several shards whose envs partition it (the same variables, distinct values) is accepted (SP6b spec §13)', () => {
    const t = 'test/metrics/terrain.metric.ts';
    const ap = 'test/metrics/apply.metric.ts';
    const shards = {
      'terrain-default': { files: [t, ap], env: { METRICS_PROFILES: 'default' } },
      'terrain-large': { files: [t], env: { METRICS_PROFILES: 'large_biomes' } },
      rest: null,
    };
    const all = [t, ap, c];
    const listed = { 'terrain-default': [ap, t], 'terrain-large': [t], rest: [c] };
    expect(coverageProblems({ project: 'p', shards, all, onDisk: all, listed })).toEqual([]);
    // Two shards with one env value, or one with an env beside one without, run the file twice: refused.
    const same = { ...shards, 'terrain-large': { files: [t], env: { METRICS_PROFILES: 'default' } } };
    expect(coverageProblems({ project: 'p', shards: same, all, onDisk: all, listed }))
      .toEqual([`${t} is in shards terrain-default and terrain-large`]);
    const bare = { ...shards, 'terrain-large': [t] };
    expect(coverageProblems({ project: 'p', shards: bare, all, onDisk: all, listed }))
      .toEqual([`${t} is in shards terrain-default and terrain-large`]);
    // Envs over different variables do not partition the file either.
    const other = { ...shards, 'terrain-large': { files: [t], env: { METRICS_CAVE_GROUPS: 'presets' } } };
    expect(coverageProblems({ project: 'p', shards: other, all, onDisk: all, listed }))
      .toEqual([`${t} is in shards terrain-default and terrain-large`]);
    // An env shard still lists exactly its named files.
    expect(coverageProblems({ project: 'p', shards, all, onDisk: all, listed: { ...listed, 'terrain-large': [t, ap] } }))
      .toEqual([`shard terrain-large lists ${ap}, ${t}, not its named files ${t}`]);
  });

  test('a named shard listing other files than its own, and an empty shard', () => {
    expect(coverageProblems({ ...clean, listed: { one: [a, b], rest: [c] } }))
      .toEqual(['shard one lists d/a.test.ts, d/b.test.ts, not its named files d/a.test.ts']);
    expect(coverageProblems({ ...clean, shards: { one: [a, b, c], rest: null }, listed: { one: [a, b, c], rest: [] } }))
      .toEqual(['shard rest has no files']);
  });
});

/**
 * The CI shard tables (SP4b spec §1.1, D1): `shardArgs` selects a named shard's files or excludes every named file for
 * the catch-all, and `coverageProblems` holds every rule a table's `check` enforces, on synthetic file lists (no
 * `vitest list`). The unit table was the spec's ten heavy files, plus the five slowest of `rest` in CI run 41132868697
 * (final review GOV-8), SP6a's slow cave files (Task 8's `caveContinuity`, Task 11's `caveTags`, Task 17's `meshXray`, Task 24's `carverPaths`),
 * SP6b Task 15's `surfaceFuzz`, SP6b Task 31's `cavesMetric` (controller ruling R5), and `rest`; SP6b Task 58 (the user's
 * ruling U14) splits heavy into `heavy-a` and `heavy-b` and adds `liveness` (`liveness.test.ts` split by leaf group into
 * four files, with Stage 2 item 2's densityFast, carve, densityDefaults and floatingIslands). The metrics-quick table
 * names its shards by (file, env) (SP6b spec §13 L1-L4): T1-T5 and S1-S3 by profile (`METRICS_PROFILES`), the caves by
 * group (`METRICS_CAVE_GROUPS`; Task 27's `caves-biomes` after `caves-presets`), `apply.metric.ts` with the default
 * profile; Task 58 folds the default profile's terrain and surface into `terrain-surface-default` and `edit` with
 * `clipboard`, and gives `region.metric.ts` a shard. The metrics-fast table (SP4b spec §9's lever, taken after SP4c's
 * merge run) is `terrain-caves` (SP6a's `caves` folded into `terrain` by Task 58), `surface` and Task 58's `persist`,
 * plus `rest`. With `check`, 20 parallel test jobs (SP6b spec §13).
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

const unitFiles = (...names: string[]): string[] => names.map((n) => `test/unit/${n}.test.ts`);
const HEAVY_A = unitFiles('surfaceFuzz', 'floatingRules', 'fieldSlice', 'relight', 'zeroAlloc', 'reviewSlices', 'tile', 'caveContinuity',
  'caveTags', 'splineFixtures', 'meshXray');
const HEAVY_B = unitFiles('cavesMetric', 'sliceJob', 'workerPool', 'treeMutator', 'terrainHeap', 'terrainStage', 'carverPaths',
  'surfaceProbe', 'columnStage', 'modifyMode');
const LIVENESS = unitFiles('liveness', 'livenessBands', 'livenessSp6b', 'livenessCaveBiomes', 'densityFast', 'carve',
  'densityDefaults', 'floatingIslands');

describe('shardArgs (SP4b spec §1.1)', () => {
  test('the unit table (SP6b Task 58, ruling U14): heavy-a, heavy-b and liveness are their files, rest excludes each of them', () => {
    expect(Object.keys(SHARDS)).toEqual(['heavy-a', 'heavy-b', 'liveness', 'rest']);
    expect(shardArgs(SHARDS, 'heavy-a')).toEqual(HEAVY_A);
    expect(shardArgs(SHARDS, 'heavy-b')).toEqual(HEAVY_B);
    expect(shardArgs(SHARDS, 'liveness')).toEqual(LIVENESS);
    // The 21 heavy files of SP6b Task 31 are heavy-a's and heavy-b's.
    expect([...HEAVY_A, ...HEAVY_B]).toHaveLength(21);
    const named = [...HEAVY_A, ...HEAVY_B, ...LIVENESS];
    expect(new Set(named).size).toBe(29);
    const rest = shardArgs(SHARDS, 'rest');
    expect(rest).toHaveLength(2 * 29);
    expect(rest).toEqual(named.flatMap((f) => ['--exclude', f]));
    for (const f of named) expect(existsSync(`${ROOT}${f}`), `${f} does not exist`).toBe(true);
  });

  test('an unknown shard names the table\'s shards', () => {
    expect(() => shardArgs(SHARDS, 'nope')).toThrow('unknown shard nope; shards: heavy-a, heavy-b, liveness, rest');
  });

  test('the metrics-quick table by (file, env) (SP6b spec §13 L1-L4): T1-T5 and S1-S3 by profile, the caves by group (caves-biomes after caves-presets, Task 27), apply with the default profile; Task 58\'s folds and region shard', () => {
    expect(Object.keys(METRIC_SHARDS)).toEqual([
      'terrain-surface-default', 'terrain-large', 'surface-large', 'render', 'edit-clipboard', 'persist', 'caves', 'caves-presets',
      'caves-biomes', 'region', 'rest',
    ]);
    expect(METRIC_SHARDS).toEqual({
      'terrain-surface-default': {
        files: ['test/metrics/terrain.metric.ts', 'test/metrics/apply.metric.ts', 'test/metrics/surface.metric.ts'], env: { METRICS_PROFILES: 'default' },
      },
      'terrain-large': { files: ['test/metrics/terrain.metric.ts'], env: { METRICS_PROFILES: 'large_biomes' } },
      'surface-large': { files: ['test/metrics/surface.metric.ts'], env: { METRICS_PROFILES: 'large_biomes' } },
      render: ['test/metrics/render.metric.ts', 'test/metrics/light.metric.ts', 'test/metrics/g1.metric.ts', 'test/metrics/stream.metric.ts'],
      'edit-clipboard': ['test/metrics/edit.metric.ts', 'test/metrics/clipboard.metric.ts'],
      persist: ['test/metrics/persist.metric.ts'],
      caves: { files: ['test/metrics/caves.metric.ts'], env: { METRICS_CAVE_GROUPS: 'default' } },
      'caves-presets': { files: ['test/metrics/caves.metric.ts'], env: { METRICS_CAVE_GROUPS: 'presets' } },
      'caves-biomes': { files: ['test/metrics/caves.metric.ts'], env: { METRICS_CAVE_GROUPS: 'biomes' } },
      region: ['test/metrics/region.metric.ts'],
      rest: null,
    });
    // An env shard selects its files and sets its env; a plain shard sets none.
    expect(shardArgs(METRIC_SHARDS, 'terrain-surface-default'))
      .toEqual(['test/metrics/terrain.metric.ts', 'test/metrics/apply.metric.ts', 'test/metrics/surface.metric.ts']);
    expect(shardEnv(METRIC_SHARDS, 'terrain-surface-default')).toEqual({ METRICS_PROFILES: 'default' });
    expect(shardArgs(METRIC_SHARDS, 'caves-presets')).toEqual(['test/metrics/caves.metric.ts']);
    expect(shardArgs(METRIC_SHARDS, 'caves-biomes')).toEqual(['test/metrics/caves.metric.ts']);
    expect(shardEnv(METRIC_SHARDS, 'caves-biomes')).toEqual({ METRICS_CAVE_GROUPS: 'biomes' });
    expect(shardEnv(METRIC_SHARDS, 'surface-large')).toEqual({ METRICS_PROFILES: 'large_biomes' });
    expect(shardEnv(METRIC_SHARDS, 'render')).toEqual({});
    expect(shardEnv(METRIC_SHARDS, 'region')).toEqual({});
    expect(shardEnv(METRIC_SHARDS, 'rest')).toEqual({});
    // apply.metric.ts runs once, with the default profile (L1).
    const shardsOf = (f: string): string[] => Object.entries(METRIC_SHARDS)
      .filter(([, s]) => s !== null && (Array.isArray(s) ? s : s.files).includes(f)).map(([n]) => n);
    expect(shardsOf('test/metrics/apply.metric.ts')).toEqual(['terrain-surface-default']);
    expect(shardsOf('test/metrics/terrain.metric.ts')).toEqual(['terrain-surface-default', 'terrain-large']);
    expect(shardsOf('test/metrics/surface.metric.ts')).toEqual(['terrain-surface-default', 'surface-large']);
    expect(shardsOf('test/metrics/caves.metric.ts')).toEqual(['caves', 'caves-presets', 'caves-biomes']);
    // 11 shards: with the unit table's 4, metrics-fast's 4 and `check`, the 20 parallel test jobs (SP6b spec §13; the
    // Free plan's 20 concurrent jobs).
    expect(Object.keys(METRIC_SHARDS).length + Object.keys(SHARDS).length + Object.keys(FAST_SHARDS).length + 1).toBe(20);
    // The catch-all excludes each named file once.
    const rest = shardArgs(METRIC_SHARDS, 'rest');
    expect(rest.filter((a) => a === 'test/metrics/terrain.metric.ts')).toHaveLength(1);
    expect(rest.filter((a) => a === 'test/metrics/caves.metric.ts')).toHaveLength(1);
    expect(rest).toHaveLength(2 * 12);
  });

  test('node .github/scripts/metricShards.mjs check passes (vitest list: every metrics-quick file in its shards exactly as the table says)', () => {
    const r = spawnSync(process.execPath, ['.github/scripts/metricShards.mjs', 'check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^terrain-surface-default: test\/metrics\/apply\.metric\.ts test\/metrics\/surface\.metric\.ts test\/metrics\/terrain\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^edit-clipboard: test\/metrics\/clipboard\.metric\.ts test\/metrics\/edit\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^region: test\/metrics\/region\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^caves-presets: test\/metrics\/caves\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^caves-biomes: test\/metrics\/caves\.metric\.ts$/m);
    expect(r.stdout).toMatch(/shards cover the \d+ metrics-quick files exactly once/);
  }, 120_000);

  test('the metrics-fast table (SP6b Task 58, ruling U14): terrain with caves, surface and persist, rest excludes the four', () => {
    expect(FAST_SHARDS).toEqual({
      'terrain-caves': ['test/metrics/terrain.metric.ts', 'test/metrics/caves.metric.ts'],
      surface: ['test/metrics/surface.metric.ts'],
      persist: ['test/metrics/persist.metric.ts'],
      rest: null,
    });
    expect(shardArgs(FAST_SHARDS, 'rest')).toEqual([
      '--exclude', 'test/metrics/terrain.metric.ts', '--exclude', 'test/metrics/caves.metric.ts', '--exclude', 'test/metrics/surface.metric.ts',
      '--exclude', 'test/metrics/persist.metric.ts',
    ]);
    expect(existsSync(`${ROOT}test/metrics/caves.metric.ts`)).toBe(true);
    expect(existsSync(`${ROOT}test/metrics/persist.metric.ts`)).toBe(true);
  });

  test('the metrics-fast table against the .metric.ts files on disk: one catch-all, each named file on disk and in one shard, rest gets the others (a listing simulated from the table, not vitest list)', () => {
    const onDisk = readdirSync(`${ROOT}test/metrics`).filter((f) => f.endsWith('.metric.ts')).map((f) => `test/metrics/${f}`).sort();
    const named = Object.values(FAST_SHARDS).filter((f) => f !== null).flat();
    const listed = Object.fromEntries(Object.entries(FAST_SHARDS).map(([name, files]) =>
      [name, files ?? onDisk.filter((f) => !named.includes(f))]));
    expect(coverageProblems({ project: 'metrics-fast', shards: FAST_SHARDS, all: onDisk, onDisk, listed })).toEqual([]);
    expect(listed.rest!.length).toBe(onDisk.length - 4);
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

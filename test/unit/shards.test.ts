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
 * `clipboard`, and gives `region.metric.ts` a shard; the user's ruling U15 slices the large profile's terrain and surface
 * by column (`METRICS_SLICE`, Stage 2 item 1: two slice shards each and the merge, `MERGE`, which `metrics-merge` runs)
 * and folds `edit-clipboard` into the preset caves group and `persist` into the biomes group. The metrics-fast table (SP4b spec §9's lever, taken after SP4c's
 * merge run) is `terrain-caves` (SP6a's `caves` folded into `terrain` by Task 58), `surface` and Task 58's `persist`,
 * plus `rest`. With `check`, 20 parallel test jobs (SP6b spec §13). SP7a Task 55's lever (0) (spec §14; rulings R27 item 2)
 * moves `waterfalls.metric.ts` off `render`: its sample in two halves riding the large profile's terrain slices
 * (`terrain-large-waterfalls-slice-k`), summed by the merge.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SHARDS as FAST_SHARDS } from '../../.github/scripts/fastShards.mjs';
import { MERGE as METRIC_MERGE, SHARDS as METRIC_SHARDS } from '../../.github/scripts/metricShards.mjs';
import { coverageProblems, shardArgs, shardEnv, sliceProblems } from '../../.github/scripts/shardLib.mjs';
import { SHARDS } from '../../.github/scripts/unitShards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const unitFiles = (...names: string[]): string[] => names.map((n) => `test/unit/${n}.test.ts`);
// SP7a Task 55a: terrainScatter, water, springs, aquifer and simEdits (the slowest of rest) join heavy-a.
const HEAVY_A = unitFiles('surfaceFuzz', 'floatingRules', 'fieldSlice', 'relight', 'zeroAlloc', 'reviewSlices', 'tile', 'caveContinuity',
  'caveTags', 'splineFixtures', 'meshXray', 'terrainScatter', 'water', 'springs', 'aquifer', 'simEdits');
const HEAVY_B = unitFiles('cavesMetric', 'sliceJob', 'workerPool', 'treeMutator', 'terrainHeap', 'terrainStage', 'carverPaths',
  'surfaceProbe', 'columnStage', 'modifyMode');
// SP7a Task 13: livenessSp7a (the aquifer leaves) joins the liveness files; Task 55a moves densityFast and carve to rest.
const LIVENESS = unitFiles('liveness', 'livenessBands', 'livenessSp6b', 'livenessCaveBiomes', 'livenessSp7a', 'densityDefaults',
  'floatingIslands');

describe('shardArgs (SP4b spec §1.1)', () => {
  test('the unit table (SP6b Task 58, ruling U14): heavy-a, heavy-b and liveness are their files, rest excludes each of them', () => {
    expect(Object.keys(SHARDS)).toEqual(['heavy-a', 'heavy-b', 'liveness', 'rest']);
    expect(shardArgs(SHARDS, 'heavy-a')).toEqual(HEAVY_A);
    expect(shardArgs(SHARDS, 'heavy-b')).toEqual(HEAVY_B);
    expect(shardArgs(SHARDS, 'liveness')).toEqual(LIVENESS);
    // The 21 heavy files of SP6b Task 31 and SP7a Task 55a's five are heavy-a's and heavy-b's.
    expect([...HEAVY_A, ...HEAVY_B]).toHaveLength(26);
    const named = [...HEAVY_A, ...HEAVY_B, ...LIVENESS];
    expect(new Set(named).size).toBe(33);
    for (const f of unitFiles('densityFast', 'carve')) expect(named).not.toContain(f);
    const rest = shardArgs(SHARDS, 'rest');
    expect(rest).toHaveLength(2 * 33);
    expect(rest).toEqual(named.flatMap((f) => ['--exclude', f]));
    for (const f of named) expect(existsSync(`${ROOT}${f}`), `${f} does not exist`).toBe(true);
  });

  test('an unknown shard names the table\'s shards', () => {
    expect(() => shardArgs(SHARDS, 'nope')).toThrow('unknown shard nope; shards: heavy-a, heavy-b, liveness, rest');
  });

  test('the metrics-quick table by (file, env) (SP6b spec §13 L1-L4): T1-T5 and S1-S3 by profile, the caves by group (caves-biomes after caves-presets, Task 27), apply with the default profile; Task 58\'s folds, region shard and the large profile\'s column slices (ruling U15)', () => {
    const T = 'test/metrics/terrain.metric.ts';
    const S = 'test/metrics/surface.metric.ts';
    const C = 'test/metrics/caves.metric.ts';
    expect(Object.keys(METRIC_SHARDS)).toEqual([
      'terrain-surface-default', 'terrain-large-waterfalls-slice-0', 'terrain-large-waterfalls-slice-1', 'surface-large-slice-0',
      'surface-large-slice-1', 'render',
      'caves', 'caves-presets-edit-clipboard', 'caves-biomes-persist', 'region', 'rest',
    ]);
    const W = 'test/metrics/waterfalls.metric.ts';
    const large = (slice: string): Record<string, string> => ({ METRICS_PROFILES: 'large_biomes', METRICS_SLICE: slice });
    expect(METRIC_SHARDS).toEqual({
      'terrain-surface-default': { files: [T, 'test/metrics/apply.metric.ts', S], env: { METRICS_PROFILES: 'default' } },
      // SP7a Task 55's lever (0) (spec §14; rulings R27 item 2): A5.waterfalls' sample in two halves riding the large
      // profile's terrain slices, off `render`.
      'terrain-large-waterfalls-slice-0': { files: [T, W], env: large('0/2') },
      'terrain-large-waterfalls-slice-1': { files: [T, W], env: large('1/2') },
      'surface-large-slice-0': { files: [S], env: large('0/2') },
      'surface-large-slice-1': { files: [S], env: large('1/2') },
      render: ['test/metrics/render.metric.ts', 'test/metrics/light.metric.ts', 'test/metrics/g1.metric.ts', 'test/metrics/stream.metric.ts'],
      caves: { files: [C], env: { METRICS_CAVE_GROUPS: 'default' } },
      'caves-presets-edit-clipboard': {
        files: [C, 'test/metrics/edit.metric.ts', 'test/metrics/clipboard.metric.ts'], env: { METRICS_CAVE_GROUPS: 'presets' },
      },
      'caves-biomes-persist': { files: [C, 'test/metrics/persist.metric.ts'], env: { METRICS_CAVE_GROUPS: 'biomes' } },
      region: ['test/metrics/region.metric.ts'],
      rest: null,
    });
    // The merge (the `metrics-merge` job): the three sliced files with the slices' profile, reading the two slices.
    expect(METRIC_MERGE).toEqual({ files: [T, S, W], env: large('merge/2') });
    expect(sliceProblems(METRIC_SHARDS, METRIC_MERGE)).toEqual([]);
    // An env shard selects its files and sets its env; a plain shard sets none.
    expect(shardArgs(METRIC_SHARDS, 'terrain-surface-default')).toEqual([T, 'test/metrics/apply.metric.ts', S]);
    expect(shardEnv(METRIC_SHARDS, 'terrain-surface-default')).toEqual({ METRICS_PROFILES: 'default' });
    expect(shardArgs(METRIC_SHARDS, 'surface-large-slice-1')).toEqual([S]);
    expect(shardEnv(METRIC_SHARDS, 'surface-large-slice-1')).toEqual(large('1/2'));
    expect(shardArgs(METRIC_SHARDS, 'caves-presets-edit-clipboard')).toEqual([C, 'test/metrics/edit.metric.ts', 'test/metrics/clipboard.metric.ts']);
    expect(shardEnv(METRIC_SHARDS, 'caves-biomes-persist')).toEqual({ METRICS_CAVE_GROUPS: 'biomes' });
    expect(shardEnv(METRIC_SHARDS, 'render')).toEqual({});
    expect(shardEnv(METRIC_SHARDS, 'region')).toEqual({});
    expect(shardEnv(METRIC_SHARDS, 'rest')).toEqual({});
    // apply.metric.ts runs once, with the default profile (L1); edit, clipboard and persist once each.
    const shardsOf = (f: string): string[] => Object.entries(METRIC_SHARDS)
      .filter(([, s]) => s !== null && (Array.isArray(s) ? s : s.files).includes(f)).map(([n]) => n);
    expect(shardsOf('test/metrics/apply.metric.ts')).toEqual(['terrain-surface-default']);
    expect(shardsOf(T)).toEqual(['terrain-surface-default', 'terrain-large-waterfalls-slice-0', 'terrain-large-waterfalls-slice-1']);
    expect(shardsOf(W)).toEqual(['terrain-large-waterfalls-slice-0', 'terrain-large-waterfalls-slice-1']);
    expect(shardsOf(S)).toEqual(['terrain-surface-default', 'surface-large-slice-0', 'surface-large-slice-1']);
    expect(shardsOf(C)).toEqual(['caves', 'caves-presets-edit-clipboard', 'caves-biomes-persist']);
    for (const f of ['edit', 'clipboard', 'persist']) expect(shardsOf(`test/metrics/${f}.metric.ts`)).toHaveLength(1);
    // 11 shards: with the unit table's 4, metrics-fast's 4 and `check`, the 20 parallel test jobs (SP6b spec §13; the
    // Free plan's 20 concurrent jobs); `metrics-merge` runs after metrics-quick and is not counted.
    expect(Object.keys(METRIC_SHARDS).length + Object.keys(SHARDS).length + Object.keys(FAST_SHARDS).length + 1).toBe(20);
    // The catch-all excludes each named file once.
    const rest = shardArgs(METRIC_SHARDS, 'rest');
    expect(rest.filter((a) => a === T)).toHaveLength(1);
    expect(rest.filter((a) => a === C)).toHaveLength(1);
    expect(rest).toHaveLength(2 * 13);
  });

  test('B5\'s lake windows ride caves-biomes-persist (SP7a Task 55b, spec §14\'s lever (2); rulings P53): their test sits in caves.metric.ts\'s biomes-group block, not in region.metric.ts', () => {
    const title = 'B5 lakeAirAdjacent on T and B5.lakeSpill after settle over the lake windows';
    const region = readFileSync(`${ROOT}test/metrics/region.metric.ts`, 'utf8');
    const caves = readFileSync(`${ROOT}test/metrics/caves.metric.ts`, 'utf8');
    expect(region).not.toContain(title);
    expect(caves.split(title)).toHaveLength(2);
    const block = caves.lastIndexOf('\nif (BIOMES_GROUP) {\n', caves.indexOf(title));
    expect(block, 'the B5 test inside an if (BIOMES_GROUP) block').toBeGreaterThan(0);
    expect(caves.slice(block, caves.indexOf(title)).match(/^}/m), 'no top-level block closes between').toBeNull();
    // The biomes group's job runs caves.metric.ts with METRICS_CAVE_GROUPS=biomes, and region.metric.ts is its own shard.
    expect(shardEnv(METRIC_SHARDS, 'caves-biomes-persist')).toEqual({ METRICS_CAVE_GROUPS: 'biomes' });
    expect(shardArgs(METRIC_SHARDS, 'caves-biomes-persist')).toContain('test/metrics/caves.metric.ts');
  });

  test('node .github/scripts/metricShards.mjs check passes (vitest list: every metrics-quick file in its shards exactly as the table says)', () => {
    const r = spawnSync(process.execPath, ['.github/scripts/metricShards.mjs', 'check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^terrain-surface-default: test\/metrics\/apply\.metric\.ts test\/metrics\/surface\.metric\.ts test\/metrics\/terrain\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^terrain-large-waterfalls-slice-1: test\/metrics\/terrain\.metric\.ts test\/metrics\/waterfalls\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^render: test\/metrics\/g1\.metric\.ts test\/metrics\/light\.metric\.ts test\/metrics\/render\.metric\.ts test\/metrics\/stream\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^surface-large-slice-0: test\/metrics\/surface\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^region: test\/metrics\/region\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^caves-presets-edit-clipboard: test\/metrics\/caves\.metric\.ts test\/metrics\/clipboard\.metric\.ts test\/metrics\/edit\.metric\.ts$/m);
    expect(r.stdout).toMatch(/^caves-biomes-persist: test\/metrics\/caves\.metric\.ts test\/metrics\/persist\.metric\.ts$/m);
    expect(r.stdout).toMatch(/shards cover the \d+ metrics-quick files exactly once/);
    expect(r.stdout).toMatch(/^merge: test\/metrics\/terrain\.metric\.ts test\/metrics\/surface\.metric\.ts test\/metrics\/waterfalls\.metric\.ts \(METRICS_PROFILES=large_biomes METRICS_SLICE=merge\/2\), its slices sound$/m);
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

  test('a file in several shards whose envs partition it (a variable both set, with distinct values) is accepted (SP6b spec §13)', () => {
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
    // Column slices (ruling U15): a variable more on one side still partitions when a shared one differs, and two slices
    // of one profile differ in METRICS_SLICE; two slices with one value do not.
    const sliced = {
      'terrain-default': shards['terrain-default'],
      'terrain-large-slice-0': { files: [t], env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: '0/2' } },
      'terrain-large-slice-1': { files: [t], env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: '1/2' } },
      rest: null,
    };
    const slicedListed = { 'terrain-default': [ap, t], 'terrain-large-slice-0': [t], 'terrain-large-slice-1': [t], rest: [c] };
    expect(coverageProblems({ project: 'p', shards: sliced, all, onDisk: all, listed: slicedListed })).toEqual([]);
    const twice = { ...sliced, 'terrain-large-slice-1': sliced['terrain-large-slice-0'] };
    expect(coverageProblems({ project: 'p', shards: twice, all, onDisk: all, listed: slicedListed }))
      .toEqual([`${t} is in shards terrain-large-slice-0 and terrain-large-slice-1`]);
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

describe('sliceProblems (SP6b spec §13 Stage 2 item 1; ruling U15: every rule of check on the column slices and their merge)', () => {
  const t = 'test/metrics/terrain.metric.ts';
  const u = 'test/metrics/surface.metric.ts';
  const env = (slice: string): Record<string, string> => ({ METRICS_PROFILES: 'large_biomes', METRICS_SLICE: slice });
  const shards = {
    'terrain-default': { files: [t, u], env: { METRICS_PROFILES: 'default' } },
    'terrain-large-slice-0': { files: [t], env: env('0/2') },
    'terrain-large-slice-1': { files: [t], env: env('1/2') },
    'surface-large-slice-0': { files: [u], env: env('0/2') },
    'surface-large-slice-1': { files: [u], env: env('1/2') },
    rest: null,
  };
  const merge = { files: [t, u], env: env('merge/2') };

  test('a sound table: slices 0 and 1 of each merged file, the merge\'s env the slices\' with merge/2; no slices and no merge', () => {
    expect(sliceProblems(shards, merge)).toEqual([]);
    expect(sliceProblems({ one: ['d/a.test.ts'], rest: null }, undefined)).toEqual([]);
  });

  test('a missing or doubled slice, a slice the merge does not read, a slice of another count', () => {
    const { 'surface-large-slice-1': _gone, ...missing } = shards;
    void _gone;
    expect(sliceProblems(missing, merge)).toEqual([`the merge's ${u} has slices [0], not 0 … 1`]);
    expect(sliceProblems({ ...shards, 'surface-large-slice-1': { files: [u], env: env('0/2') } }, merge))
      .toEqual([`the merge's ${u} has slices [0, 0], not 0 … 1`]);
    expect(sliceProblems(shards, { ...merge, files: [t] }))
      .toEqual([`slice shard surface-large-slice-0's ${u} is not the merge's`, `slice shard surface-large-slice-1's ${u} is not the merge's`]);
    expect(sliceProblems({ ...shards, 'terrain-large-slice-1': { files: [t], env: env('1/3') } }, merge))
      .toEqual(['slice shard terrain-large-slice-1 is one of 3, the merge reads 2']);
  });

  test('envs: a slice\'s other variables are the merge\'s; the merge sets merge/n; a slice sets k/n', () => {
    expect(sliceProblems({ ...shards, 'terrain-large-slice-1': { files: [t], env: { METRICS_PROFILES: 'default', METRICS_SLICE: '1/2' } } }, merge))
      .toEqual(['slice shard terrain-large-slice-1\'s env differs from the merge\'s beyond METRICS_SLICE']);
    expect(sliceProblems(shards, { ...merge, env: env('2') })).toEqual(['the merge\'s METRICS_SLICE \'2\' is not merge/n']);
    expect(sliceProblems({ ...shards, 'terrain-large-slice-1': { files: [t], env: env('2/2') } }, merge))
      .toEqual(['shard terrain-large-slice-1: METRICS_SLICE \'2/2\' is not a slice k/n', `the merge's ${t} has slices [0], not 0 … 1`]);
  });

  test('names: a slice shard holds -slice- (ci.yml hands its record to the merge job), no other shard does; slices need a merge', () => {
    const { 'terrain-large-slice-0': s0, ...others } = shards;
    expect(sliceProblems({ ...others, 'terrain-large-0': s0 }, merge)).toEqual(['slice shard terrain-large-0: its name must hold \'-slice-\'']);
    expect(sliceProblems({ ...shards, 'odd-slice-0': ['d/a.test.ts'] }, merge)).toEqual(['shard odd-slice-0 is named as a slice but sets no METRICS_SLICE']);
    expect(sliceProblems(shards, undefined))
      .toEqual(['slice shards terrain-large-slice-0, terrain-large-slice-1, surface-large-slice-0, surface-large-slice-1 but no merge']);
  });
});

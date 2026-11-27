#!/usr/bin/env node
// The metrics-quick shards of CI: named heavy files in their own shards (a file split by an env in several, SP6b spec
// §13), and the catch-all shard `rest`, which excludes every named file, so a metric file added later runs in `rest`
// without touching this script. The shard names are CI's matrix (`matrix`), so a shard added here always runs.
// Rebalance by the job summaries' durations. The commands live in `shardLib.mjs`, which the unit table
// (`unitShards.mjs`) shares. The column slices' merge (`MERGE`) runs in the `metrics-merge` job, after this matrix.
//
//   node .github/scripts/metricShards.mjs matrix            the shard names as a JSON array
//   node .github/scripts/metricShards.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/metricShards.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
//   node .github/scripts/metricShards.mjs merge REPORT      runs the column slices' merge (`metrics-merge`)
import { cli, shardTool } from './shardLib.mjs';

const DIR = 'test/metrics';

/**
 * Shard name → its files, or its files and the env its run sets (SP6b spec §13: a shard is named by (file, env));
 * `rest` is the catch-all. Measured 2026-10-20 (cold region cache, alone on 4 CPUs of an i7-12700H): terrain 167 s
 * (T1), surface 167 s (S1), noise 108 s, the other seven files 80 s together; noise in `rest`. SP6b's split (§13
 * L1-L4) measured 2026-11-12 on the laptop (each shard alone through `run`, the caves on a warm region cache; CI's
 * cold times are SP6b Task 5's): see each.
 */
export const SHARDS = {
  // SP6b spec §13 L1, L2: T1-T5 by profile (`METRICS_PROFILES`; terrain.metric.ts draws every profile's columns and
  // keeps its own, ruling P1), R7's Apply part (`apply.metric.ts`, SP4c spec §8.1) with the default profile's 8,192
  // columns and T4 regions; large_biomes' 32,768 columns alone. 75 s. SP6b spec §13 L3: S1-S3, B4 and B2 by profile, as
  // T1-T5 (`islandBranchOnGround` with the default profile). 57 s. SP6b Task 58 (the user's ruling U14; spec §13 Stage 2
  // item 3's folds): the default profile's terrain, apply and surface in one shard (one env; the jobs `terrain-default`
  // and `surface-default` ran 1:47-2:54 and 1:18-2:01 at the exit, vitest 148 s and 101 s in run 44041739227 #4), so
  // the job count stays at 20.
  'terrain-surface-default': {
    files: [`${DIR}/terrain.metric.ts`, `${DIR}/apply.metric.ts`, `${DIR}/surface.metric.ts`], env: { METRICS_PROFILES: 'default' },
  },
  // large_biomes' 32,768 columns alone: 216 s (terrain), 209 s (surface). SP6b Task 58 (the user's ruling U15; spec §13
  // Stage 2 item 1): after U14 `terrain-large` and `surface-large` set the wall (4:22-5:56 and 3:30-6:06 in run
  // 44054778989, vitest 247-334 s and 254-347 s), so each runs as two column slices (`METRICS_SLICE`,
  // test/harness/columnSlices.ts: slice k draws every column and T4 site as the whole run and keeps draws k, k + 2, …),
  // whose records `MERGE` below sums and gates. SP7a Task 55's lever (0) (spec §14; rulings R27 item 2): `A5.waterfalls`'
  // steep-land sample (`waterfalls.metric.ts`, 138-320 s in `render`, the long pole at 6:32-7:35, run 45754217502 on; the
  // SP7a spec's Exit evidence, CI at the exit) leaves `render` and is read in two halves, its lattice row slices k, k + 2,
  // … (`METRICS_SLICE`, which it reads like these files; it ignores `METRICS_PROFILES`, reading the default profile), riding
  // the two terrain slices, the metrics-quick jobs with the most slack (1:42-3:19, vitest 89-93 s in run 45942682469); the
  // merge sums the halves' counts (`mergeSampleAccs`, equal to the whole scan's whatever the slicing) and gates them, so
  // the sample is whole (rulings R23) and the job count stays 20.
  'terrain-large-waterfalls-slice-0': {
    files: [`${DIR}/terrain.metric.ts`, `${DIR}/waterfalls.metric.ts`], env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: '0/2' },
  },
  'terrain-large-waterfalls-slice-1': {
    files: [`${DIR}/terrain.metric.ts`, `${DIR}/waterfalls.metric.ts`], env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: '1/2' },
  },
  'surface-large-slice-0': { files: [`${DIR}/surface.metric.ts`], env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: '0/2' } },
  'surface-large-slice-1': { files: [`${DIR}/surface.metric.ts`], env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: '1/2' } },
  // SP4a spec §10 (D28): the renderer's and the light's metric files (R1, R2, R4, R5; L1, L2, DT1.light, S1.light),
  // with their cold region caches, and G1's static cells (a JSON read; ruling P53). SP4b spec §8.1, §9: R7's streaming
  // flight (`stream.metric.ts`: planned 20-30 s; measured 38 s in CI's first sharded run, run 40077412950, and about
  // 12 s alone on the laptop; final review GOV-1). SP7a Task 31 (spec §13.1, §14; rulings R20): `A5.waterfalls`' steep-land
  // sample (`waterfalls.metric.ts`, quick and full only, about 3.6 CPU-min read in 4 worker threads) joined this shard,
  // then the one with the most slack (2:04 in run 45144707470); SP7a Task 55's lever (0) moved it to the terrain slices
  // (above).
  render: [`${DIR}/render.metric.ts`, `${DIR}/light.metric.ts`, `${DIR}/g1.metric.ts`, `${DIR}/stream.metric.ts`],
  // SP6a spec §10.1, §11 (D26): the caves' metrics (`caves.metric.ts`), in shards of their own (SP6a Task 30: 106 s
  // alone, cold region cache, before C1-C9). SP6b spec §13 L4: by group (`METRICS_CAVE_GROUPS`): the six default-group
  // regions (C1-C6, the default group's C7-C9 and their `carverReference`). 171 s.
  caves: { files: [`${DIR}/caves.metric.ts`], env: { METRICS_CAVE_GROUPS: 'default' } },
  // SP5a spec §6.1, §7: L3 and E5's session part (`edit.metric.ts`), planned for `render`; its prototype measured 53 s
  // on quick (59 s before E5 dropped to RD 4 there) against the plan's 50 s, so it runs in a shard of its own (the
  // spec's named lever). SP5c spec §10.1, §11 (D27): L3, E3 and E5's paste parts (`clipboard.metric.ts`, planned 30-55 s
  // on quick: its own 10 × 10 region on every tier, the leave and the buried-house cases), which `rest` (the long pole)
  // could not take, ran in a shard of its own (prototype: 41 s on quick, 35 s on fast). SP6b Task 58 (the user's ruling
  // U14; spec §13 Stage 2 item 3's fold): the two in one shard (the jobs `edit` and `clipboard` ran 1:46-2:16 and
  // 1:20-2:08 at the exit, vitest 113 s and 66 s in run 44041739227 #4), so the job count stays at 20.
  // SP5b spec §6.1, §7: E1-E7 and E5's flush part (`persist.metric.ts`), planned for `edit` at 25-40 s on quick; its
  // prototype measured 57 s on quick (E1's 10,000 columns about 10 s, about 20 world opens at RD 4), which would take
  // `edit` past the 145 s long pole, so it runs in a shard of its own (the spec's named lever, ruling P45).
  // SP6b Task 58 (the user's ruling U15; spec §13): the four column slices add two jobs, so two folds keep the job count
  // at 20: `edit-clipboard` (1:26-1:54 after U14, vitest 67-93 s, one thread per file) with the preset group (1:15-1:53,
  // vitest 88-90 s, four region workers) and `persist` (2:24-2:59, vitest 117-146 s, one thread) with the biomes group
  // below (1:06-2:17, vitest 87-110 s). Their env is the caves group's, which edit, clipboard and persist do not read.
  // The three preset regions (their C7-C9 groups and `carverReference`, `islandCapAir`) and the pure parts
  // (`reachOverflow`, `endTaper`). 56 s.
  'caves-presets-edit-clipboard': {
    files: [`${DIR}/caves.metric.ts`, `${DIR}/edit.metric.ts`, `${DIR}/clipboard.metric.ts`], env: { METRICS_CAVE_GROUPS: 'presets' },
  },
  // SP6b spec §12.2-§12.3, §13 (Task 27): the biomes group, the 19th job: `cave_heavy`'s two regions (C1.caveHeavy, C2
  // and C9 recorded on it) and the biome region (B3's border parts with each biome | plain pair's 2,000-face minimum,
  // the T window's re-check, the review poses); the spec's estimate 3:10-4:00 cold with Tasks 28 and 39's additions.
  // With `persist` since U15 (above). SP7a Task 55b (spec §14's lever (2); rulings P53): B5's lake windows (28-38 s in
  // `region`'s job, runs 45951397852 #1-#3) moved from `region.metric.ts` into `caves.metric.ts`'s biomes-group block,
  // so they run here.
  'caves-biomes-persist': { files: [`${DIR}/caves.metric.ts`, `${DIR}/persist.metric.ts`], env: { METRICS_CAVE_GROUPS: 'biomes' } },
  // SP6b Task 58 (the user's ruling U14): DT1 and the region parts (`region.metric.ts`) out of `rest`, which ran
  // 5:08-6:08 at the exit (vitest 325 s in run 44041739227 #4: region 274 s, noise 218 s, params 129 s). Without B5's
  // lake windows since SP7a Task 55b (above).
  region: [`${DIR}/region.metric.ts`],
  rest: null,
};

/**
 * The column slices' merge (SP6b spec §13 Stage 2 item 1; the user's ruling U15), run by the `metrics-merge` job after
 * metrics-quick: the sliced files with the slices' profile and `METRICS_SLICE=merge/2`, which read the slices' records
 * (CI's artifacts), sum them and run every T1-T5, B3 and S1-S3, B4, B2 test of the whole large_biomes run, and
 * `A5.waterfalls` on its whole sample (SP7a Task 55's lever (0)), on the sums, generating nothing (`check` holds it to the
 * slices, `sliceProblems`).
 */
export const MERGE = {
  files: [`${DIR}/terrain.metric.ts`, `${DIR}/surface.metric.ts`, `${DIR}/waterfalls.metric.ts`],
  env: { METRICS_PROFILES: 'large_biomes', METRICS_SLICE: 'merge/2' },
};

cli(import.meta.url, shardTool({ project: 'metrics-quick', dir: DIR, suffix: '.metric.ts', shards: SHARDS, merge: MERGE }), 'metricShards.mjs');

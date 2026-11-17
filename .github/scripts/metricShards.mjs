#!/usr/bin/env node
// The metrics-quick shards of CI: named heavy files in their own shards (a file split by an env in several, SP6b spec
// §13), and the catch-all shard `rest`, which excludes every named file, so a metric file added later runs in `rest`
// without touching this script. The shard names are CI's matrix (`matrix`), so a shard added here always runs.
// Rebalance by the job summaries' durations. The commands live in `shardLib.mjs`, which the unit table
// (`unitShards.mjs`) shares.
//
//   node .github/scripts/metricShards.mjs matrix            the shard names as a JSON array
//   node .github/scripts/metricShards.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/metricShards.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
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
  // 216 s.
  'terrain-large': { files: [`${DIR}/terrain.metric.ts`], env: { METRICS_PROFILES: 'large_biomes' } },
  // 209 s.
  'surface-large': { files: [`${DIR}/surface.metric.ts`], env: { METRICS_PROFILES: 'large_biomes' } },
  // SP4a spec §10 (D28): the renderer's and the light's metric files (R1, R2, R4, R5; L1, L2, DT1.light, S1.light),
  // with their cold region caches, and G1's static cells (a JSON read; ruling P53). SP4b spec §8.1, §9: R7's streaming
  // flight (`stream.metric.ts`: planned 20-30 s; measured 38 s in CI's first sharded run, run 40077412950, and about
  // 12 s alone on the laptop; final review GOV-1).
  render: [`${DIR}/render.metric.ts`, `${DIR}/light.metric.ts`, `${DIR}/g1.metric.ts`, `${DIR}/stream.metric.ts`],
  // SP5a spec §6.1, §7: L3 and E5's session part (`edit.metric.ts`), planned for `render`; its prototype measured 53 s
  // on quick (59 s before E5 dropped to RD 4 there) against the plan's 50 s, so it runs in a shard of its own (the
  // spec's named lever). SP5c spec §10.1, §11 (D27): L3, E3 and E5's paste parts (`clipboard.metric.ts`, planned 30-55 s
  // on quick: its own 10 × 10 region on every tier, the leave and the buried-house cases), which `rest` (the long pole)
  // could not take, ran in a shard of its own (prototype: 41 s on quick, 35 s on fast). SP6b Task 58 (the user's ruling
  // U14; spec §13 Stage 2 item 3's fold): the two in one shard (the jobs `edit` and `clipboard` ran 1:46-2:16 and
  // 1:20-2:08 at the exit, vitest 113 s and 66 s in run 44041739227 #4), so the job count stays at 20.
  'edit-clipboard': [`${DIR}/edit.metric.ts`, `${DIR}/clipboard.metric.ts`],
  // SP5b spec §6.1, §7: E1-E7 and E5's flush part (`persist.metric.ts`), planned for `edit` at 25-40 s on quick; its
  // prototype measured 57 s on quick (E1's 10,000 columns about 10 s, about 20 world opens at RD 4), which would take
  // `edit` past the 145 s long pole, so it runs in a shard of its own (the spec's named lever, ruling P45).
  persist: [`${DIR}/persist.metric.ts`],
  // SP6a spec §10.1, §11 (D26): the caves' metrics (`caves.metric.ts`), in shards of their own (SP6a Task 30: 106 s
  // alone, cold region cache, before C1-C9). SP6b spec §13 L4: by group (`METRICS_CAVE_GROUPS`): the six default-group
  // regions (C1-C6, the default group's C7-C9 and their `carverReference`). 171 s.
  caves: { files: [`${DIR}/caves.metric.ts`], env: { METRICS_CAVE_GROUPS: 'default' } },
  // The three preset regions (their C7-C9 groups and `carverReference`, `islandCapAir`) and the pure parts
  // (`reachOverflow`, `endTaper`). 56 s.
  'caves-presets': { files: [`${DIR}/caves.metric.ts`], env: { METRICS_CAVE_GROUPS: 'presets' } },
  // SP6b spec §12.2-§12.3, §13 (Task 27): the biomes group, the 19th job: `cave_heavy`'s two regions (C1.caveHeavy, C2
  // and C9 recorded on it) and the biome region (B3's border parts with each biome | plain pair's 2,000-face minimum,
  // the T window's re-check, the review poses); the spec's estimate 3:10-4:00 cold with Tasks 28 and 39's additions.
  'caves-biomes': { files: [`${DIR}/caves.metric.ts`], env: { METRICS_CAVE_GROUPS: 'biomes' } },
  // SP6b Task 58 (the user's ruling U14): DT1 and the region parts (`region.metric.ts`) out of `rest`, which ran
  // 5:08-6:08 at the exit (vitest 325 s in run 44041739227 #4: region 274 s, noise 218 s, params 129 s).
  region: [`${DIR}/region.metric.ts`],
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'metrics-quick', dir: DIR, suffix: '.metric.ts', shards: SHARDS }), 'metricShards.mjs');

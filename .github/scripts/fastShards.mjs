#!/usr/bin/env node
// The metrics-fast shards of CI (SP4b spec §9's lever, taken after SP4c's merge run 40387481112 at 3 min 37 s wall):
// the slowest files in shards of their own, and the catch-all shard `rest`, which excludes them, so a metric
// file added later runs in `rest` without touching this script. The shard names are CI's matrix (`matrix`), so a shard
// added here always runs. Rebalance by the job summaries' durations. The commands live in `shardLib.mjs`, which the
// metrics-quick table (`metricShards.mjs`) and the unit table (`unitShards.mjs`) share.
//
//   node .github/scripts/fastShards.mjs matrix            the shard names as a JSON array
//   node .github/scripts/fastShards.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/fastShards.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
import { cli, shardTool } from './shardLib.mjs';

const DIR = 'test/metrics';

/**
 * Shard name → its files; `rest` is the catch-all. Measured in run 40387481112's single metrics-fast job (a slow
 * runner; vitest 187 s, the job 3 min 19 s): terrain 155 s, surface 145 s, the other thirteen files 233 s summed
 * (noise 45 s, stream 39 s, water 27 s, biomes 26 s, apply 26 s, relief 21 s, presets 17 s, the rest under 12 s each).
 */
export const SHARDS = {
  // SP6a spec §11 (D26): the caves' metrics (`caves.metric.ts`), planned at 20-40 s on fast, in a shard of its own (Task
  // 30: 24 s alone, a cold region cache for one of its two regions). SP6b Task 58 (the user's ruling U14; spec §13
  // Stage 2 item 3's fold): with `terrain` (run 44041739227 #4: vitest 127 s in `terrain`'s job, 66 s in `caves`'), so the
  // job count stays at 20; the shard keeps its region cache for the caves' dumps (terrain's T4 regions run with `cache: false`).
  'terrain-caves': [`${DIR}/terrain.metric.ts`, `${DIR}/caves.metric.ts`],
  surface: [`${DIR}/surface.metric.ts`],
  // SP6b Task 58 (ruling U14; spec §13 Stage 2 item 3): E1-E7 and E5's flush part (`persist.metric.ts`) in a shard of
  // its own, out of `rest`, which ran 5:04-6:15 at the exit (vitest 350 s: persist 235 s, clipboard 144 s, params 124 s).
  persist: [`${DIR}/persist.metric.ts`],
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'metrics-fast', dir: DIR, suffix: '.metric.ts', shards: SHARDS }), 'fastShards.mjs');

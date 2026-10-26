#!/usr/bin/env node
// The metrics-fast shards of CI (SP4b spec §9's lever, taken after SP4c's merge run 40387481112 at 3 min 37 s wall):
// the two slowest files each in a shard of its own, and the catch-all shard `rest`, which excludes them, so a metric
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
  terrain: [`${DIR}/terrain.metric.ts`],
  surface: [`${DIR}/surface.metric.ts`],
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'metrics-fast', dir: DIR, suffix: '.metric.ts', shards: SHARDS }), 'fastShards.mjs');

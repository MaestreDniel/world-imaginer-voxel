#!/usr/bin/env node
// The metrics-quick shards of CI: named heavy files in their own shards, and the catch-all shard `rest`, which
// excludes every named file, so a metric file added later runs in `rest` without touching this script. The shard
// names are CI's matrix (`matrix`), so a shard added here always runs. Rebalance by the job summaries' durations.
// The commands live in `shardLib.mjs`, which the unit table (`unitShards.mjs`) shares.
//
//   node .github/scripts/metricShards.mjs matrix            the shard names as a JSON array
//   node .github/scripts/metricShards.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/metricShards.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
import { cli, shardTool } from './shardLib.mjs';

const DIR = 'test/metrics';

/**
 * Shard name → its files; `rest` is the catch-all. Measured 2026-10-20 (cold region cache, alone on 4 CPUs of an
 * i7-12700H): terrain 167 s (T1), surface 167 s (S1), noise 108 s, the other seven files 80 s together; noise in `rest`.
 */
export const SHARDS = {
  terrain: [`${DIR}/terrain.metric.ts`],
  surface: [`${DIR}/surface.metric.ts`],
  // SP4a spec §10 (D28): the renderer's and the light's metric files (R1, R2, R4, R5; L1, L2, DT1.light, S1.light),
  // with their cold region caches, and G1's static cells (a JSON read; ruling P53). SP4b spec §8.1, §9: R7's streaming
  // flight (`stream.metric.ts`: planned 20-30 s; measured 38 s in CI's first sharded run, run 40077412950, and about
  // 12 s alone on the laptop; final review GOV-1).
  render: [`${DIR}/render.metric.ts`, `${DIR}/light.metric.ts`, `${DIR}/g1.metric.ts`, `${DIR}/stream.metric.ts`],
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'metrics-quick', dir: DIR, suffix: '.metric.ts', shards: SHARDS }), 'metricShards.mjs');

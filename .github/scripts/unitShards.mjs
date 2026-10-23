#!/usr/bin/env node
// The unit shards of CI (SP4b spec §1.1, D1): the heavy files in `heavy`, and the catch-all shard `rest`, which
// excludes them, so a unit file added later runs in `rest` without touching this script. The shard names are CI's
// matrix (`matrix`), so a shard added here always runs. The commands live in `shardLib.mjs`.
//
//   node .github/scripts/unitShards.mjs matrix            the shard names as a JSON array
//   node .github/scripts/unitShards.mjs check             fails unless the shards list the project's files once each
//   node .github/scripts/unitShards.mjs run NAME REPORT   runs shard NAME, writing a vitest JSON report to REPORT
import { cli, shardTool } from './shardLib.mjs';

const DIR = 'test/unit';

/**
 * Shard name → its files; `rest` is the catch-all. Measured in CI run 39950653330: the ten 202 s of the 412 s summed,
 * rest (209 files) 210 s; rebalance by the job summaries (`slowest.mjs`).
 */
export const SHARDS = {
  heavy: ['sliceJob', 'floatingRules', 'workerPool', 'treeMutator', 'reviewSlices', 'columnStage', 'tile', 'fieldSlice',
    'splineFixtures', 'surfaceProbe'].map((n) => `${DIR}/${n}.test.ts`),
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'unit', dir: DIR, suffix: '.test.ts', shards: SHARDS }), 'unitShards.mjs');

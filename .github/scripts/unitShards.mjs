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
 * rest (209 files) 210 s; rebalance by the job summaries (`slowest.mjs`). CI run 41132868697 (SP5b): `unit (rest)` 164 s
 * (vitest 149 s; its 265 files 355 s summed), `unit (heavy)` 67 s (54 s; 146 s summed), so the five slowest of rest
 * moved to heavy (relight 59.6 s, zeroAlloc 21.1, terrainStage 11.1, terrainHeap 10.9, modifyMode 10.1; 113 s summed),
 * about 240 and 260 s summed, both jobs near 110-120 s (final review GOV-8).
 */
export const SHARDS = {
  heavy: ['sliceJob', 'floatingRules', 'workerPool', 'treeMutator', 'reviewSlices', 'columnStage', 'tile', 'fieldSlice',
    'splineFixtures', 'surfaceProbe', 'relight', 'zeroAlloc', 'terrainStage', 'terrainHeap', 'modifyMode'].map((n) => `${DIR}/${n}.test.ts`),
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'unit', dir: DIR, suffix: '.test.ts', shards: SHARDS }), 'unitShards.mjs');

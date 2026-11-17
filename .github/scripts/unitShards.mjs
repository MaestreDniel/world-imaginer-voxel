#!/usr/bin/env node
// The unit shards of CI (SP4b spec §1.1, D1): the heavy files in named shards (`heavy-a`, `heavy-b` and `liveness`
// since SP6b Task 58), and the catch-all shard `rest`, which excludes them, so a unit file added later runs in `rest`
// without touching this script. The shard names are CI's matrix (`matrix`), so a shard added here always runs. The
// commands live in `shardLib.mjs`.
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
 * about 240 and 260 s summed, both jobs near 110-120 s (final review GOV-8). SP6a (its spec §11): each new slow cave file
 * joins heavy with the task that creates it (`caveContinuity`, Task 8; `caveTags`, Task 11; `meshXray`, Task 17;
 * `carverPaths`, Task 24). SP6b Task 15: `surfaceFuzz` (its two fast-path fuzzes, about 50 s alone). SP6b Task 31
 * (controller ruling R5): `cavesMetric` (61-105 s in Task 5's warm re-runs, Task 27's biome scan about 37 s alone), with
 * `unit (rest)` at 5:39-5:44 there.
 *
 * SP6b Task 58 (the user's ruling U14; spec §13): at the exit `unit (heavy)` ran 7:17-7:34 (vitest 434-440 s; its 21
 * files 1,188 s summed in run 44041739227 #4) and `unit (rest)` 8:13-8:17 (vitest 435-482 s, of which `liveness.test.ts`
 * 416-461 s; its 293 files 1,108 s summed). `liveness.test.ts` is split by leaf group into four files, and the two
 * shards become four of about 590 s summed each: heavy in two, the four big files two by two (`heavy-a`: surfaceFuzz
 * 225 s and floatingRules 99 s; `heavy-b`: cavesMetric 200 s and sliceJob 130 s), the others balanced by their times;
 * `liveness`: the four liveness files (the cave-biome leaves' 186-205 s the longest) with the spec's Stage 2 item 2 list
 * (densityFast 39 s, carve 21 s, densityDefaults 19 s, floatingIslands 18 s); `rest` the other 285 files (about 595 s).
 */
const named = (...names) => names.map((n) => `${DIR}/${n}.test.ts`);
export const SHARDS = {
  'heavy-a': named('surfaceFuzz', 'floatingRules', 'fieldSlice', 'relight', 'zeroAlloc', 'reviewSlices', 'tile', 'caveContinuity',
    'caveTags', 'splineFixtures', 'meshXray'),
  'heavy-b': named('cavesMetric', 'sliceJob', 'workerPool', 'treeMutator', 'terrainHeap', 'terrainStage', 'carverPaths',
    'surfaceProbe', 'columnStage', 'modifyMode'),
  liveness: named('liveness', 'livenessBands', 'livenessSp6b', 'livenessCaveBiomes', 'densityFast', 'carve', 'densityDefaults',
    'floatingIslands'),
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'unit', dir: DIR, suffix: '.test.ts', shards: SHARDS }), 'unitShards.mjs');

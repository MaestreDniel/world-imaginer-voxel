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
 * SP7a Task 13 (its spec §13.7, §14; the plan's Spec correction 5): `livenessSp7a` (the aquifer leaves' verdicts and
 * witnesses) joins `liveness` with the other liveness files.
 *
 * SP7a Task 55a (spec §14's lever (1)): rebalanced by the file times of eight runs (45760011056 #1-#2, 45875154988,
 * 45915825910, 45927748952 #1-#2, 45940815116, 45942682469; each file's median). The shards summed heavy-a 369 s,
 * heavy-b 571 s, liveness 668 s and rest 757 s (its slowest terrainScatter 57 s, water 50 s, springs 44 s, aquifer 30 s
 * and simEdits 29 s, the SP7a files the plan names into the heavy shards); the job is about its longest file
 * (livenessSp7a 232 s, cavesMetric 211 s, surfaceFuzz 153 s) or its sum over about 2.6. Those five join `heavy-a`
 * (579 s); densityFast (36 s) and carve (22 s) leave `liveness` (610 s) for `rest` (605 s); `heavy-b` stays (571 s).
 */
const named = (...names) => names.map((n) => `${DIR}/${n}.test.ts`);
export const SHARDS = {
  'heavy-a': named('surfaceFuzz', 'floatingRules', 'fieldSlice', 'relight', 'zeroAlloc', 'reviewSlices', 'tile', 'caveContinuity',
    'caveTags', 'splineFixtures', 'meshXray', 'terrainScatter', 'water', 'springs', 'aquifer', 'simEdits'),
  'heavy-b': named('cavesMetric', 'sliceJob', 'workerPool', 'treeMutator', 'terrainHeap', 'terrainStage', 'carverPaths',
    'surfaceProbe', 'columnStage', 'modifyMode'),
  liveness: named('liveness', 'livenessBands', 'livenessSp6b', 'livenessCaveBiomes', 'livenessSp7a', 'densityDefaults',
    'floatingIslands'),
  rest: null,
};

cli(import.meta.url, shardTool({ project: 'unit', dir: DIR, suffix: '.test.ts', shards: SHARDS }), 'unitShards.mjs');

import { Worker } from 'node:worker_threads';
import { expect } from 'vitest';
import type { Params } from '../../src/core/params/schema';
import { REGISTRY } from '../../src/world/blocks/index';
import { ask, buildNodeTaskWorker } from './nodeWorker';
import { YMOD16_CLASSES, ymod16Test } from './stats';
import { mergeSurfaceAcc, SURFACE_STATES, surfaceBiomeId, TOP_PATCHES, type SurfaceAcc } from './surfaceScatter';
import type { SurfaceScatterMsg, SurfaceScatterReply } from './surfaceScatterWorker';
import { requireSample, type PopulationMode } from './terrainScatter';

/**
 * S1-S3's threaded analysis and part bodies (SP3e spec §5.1 "Extractions", D18), moved out of
 * `test/metrics/surface.metric.ts` and parameterised: the worker dir, seed, params and columns are arguments of
 * `analyseColumnsThreaded`, and the part bodies take one population's `SurfaceAcc` and a population `mode`
 * (`PopulationMode` of `terrainScatter.ts`). surface.metric.ts calls them in `'enforce'` mode with its own constants
 * (its outputs are unchanged, spec §5.7); the presets' full-tier records call them in `'record'` mode (§5.5).
 * Definitions: surface.metric.ts' header (SP3c spec §5.1-§5.2); the per-column analysis is `surfaceScatter.ts`'.
 */

/** SP3c spec §5.1: every population-dependent part needs 1,000 per population (enforce mode). */
export const MIN_SURFACE_POPULATION = 1000;

const STATES = SURFACE_STATES;
const NAMES: readonly string[] = Array.from({ length: STATES }, (_, s) => REGISTRY.stateKey(s));
const B = surfaceBiomeId;

const share = (n: number, d: number): number => (d === 0 ? NaN : n / d);

const scatterScripts = new Map<string, Promise<string>>();
const askWorker = (w: Worker, msg: SurfaceScatterMsg): Promise<SurfaceScatterReply> => ask<SurfaceScatterReply>(w, msg);
const fail = (what: string, r: SurfaceScatterReply): Error => new Error(`${what}: ${r.type === 'error' ? r.message : r.type}`);

/**
 * Generates and analyses scattered (possibly repeated) columns on 4 surface scatter workers
 * (`surfaceScatterWorker.ts`, bundled once per `workerDir` under test/.cache/: the dir must be unique per metric file
 * and tier), each with its own small store (one column at a time: claimed, analysed, freed), handing out the next
 * column to whichever worker is free, and adds the workers' counts into `acc` (`mergeSurfaceAcc`, an exact sum: the
 * result does not depend on the order).
 */
export async function analyseColumnsThreaded(
  workerDir: string,
  seed: string,
  params: Params,
  cols: ReadonlyArray<readonly [number, number]>,
  acc: SurfaceAcc,
): Promise<void> {
  let built = scatterScripts.get(workerDir);
  if (built === undefined) {
    built = buildNodeTaskWorker(workerDir, { entry: 'test/harness/surfaceScatterWorker.ts' });
    scatterScripts.set(workerDir, built);
  }
  const script = await built;
  const workers = Array.from({ length: 4 }, () => new Worker(script));
  try {
    const ready = await Promise.all(workers.map((w) => askWorker(w, { type: 'attach', seedText: seed, params })));
    for (const r of ready) if (r.type !== 'ready') throw fail('surface scatter worker', r);
    let next = 0;
    const drain = async (t: number): Promise<void> => {
      while (next < cols.length) {
        const [cx, cz] = cols[next++]!;
        const r = await askWorker(workers[t]!, { type: 'column', cx, cz });
        if (r.type !== 'done') throw fail(`surface scatter worker ${t}, column (${cx}, ${cz})`, r);
      }
      const r = await askWorker(workers[t]!, { type: 'take' });
      if (r.type !== 'acc') throw fail(`surface scatter worker ${t}`, r);
      mergeSurfaceAcc(acc, r.acc);
    };
    await Promise.all(workers.map((_, t) => drain(t)));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

/**
 * Each part's population: enforce mode writes it as `<part>.n` (today's key) when the part has a minimum and checks
 * the minimum (soft "insufficient sample", message `<part> (<label>): …`); record mode writes it as
 * `<part>.population` for every part and checks nothing.
 */
function populations(rec: Record<string, number>, mode: PopulationMode, label: string, pops: ReadonlyArray<readonly [part: string, n: number, enforced: boolean]>): void {
  for (const [part, n, enforced] of pops) {
    if (mode === 'record') rec[`${part}.population`] = n;
    else if (enforced) {
      rec[`${part}.n`] = n;
      requireSample(`${part} (${label})`, n, MIN_SURFACE_POPULATION);
    }
  }
}

/** The keys every surface record ends with: columns, the pass's wall time (a timing key) and top mismatches. */
export const surfaceCommonValues = (a: SurfaceAcc): Record<string, number> =>
  ({ columns: a.columns, seconds: a.seconds, topMismatch: a.topMismatch });

/**
 * S1 of one population: the parts `buried`, `grassNoSky`, `ymod16` (the χ² p-value), their populations (land tops,
 * land tops, ymod16 positions), then the extras (ymod16's table, the land-top y mod 16 histogram, the surfaceDepth
 * histogram, patch coverage, per-block shares, land and wet tops) and the common keys. Enforce mode also fails softly
 * on a degenerate ymod16 table (`S1.ymod16 (<label>): degenerate table …`); record mode skips it.
 */
export function s1Values(a: SurfaceAcc, mode: PopulationMode, label: string): Record<string, number> {
  const t = ymod16Test(a.ymod);
  const rec: Record<string, number> = { buried: a.buried, grassNoSky: a.grassNoSky, ymod16: t.p };
  populations(rec, mode, label, [['buried', a.landTops, true], ['grassNoSky', a.landTops, true], ['ymod16', a.ymodColumns, true]]);
  if (mode === 'enforce') expect.soft(t.degenerate, `S1.ymod16 (${label}): degenerate table (classes ${t.classes.join(', ')})`).toBe(false);
  rec['ymod16.chi2'] = t.chi2;
  rec['ymod16.df'] = t.df;
  rec['ymod16.rows'] = t.rows;
  rec['ymod16.classesLeft'] = t.classes.length;
  for (let k = 0; k < YMOD16_CLASSES; k++) {
    let n = 0;
    for (let r = 0; r < 16; r++) n += a.ymod[6 * r + k]!;
    rec[`ymod16.class${k === 5 ? '5plus' : k}`] = n;
  }
  // landTopYmod16: the land-top y mod 16 histogram, raw and against E_r = Σ_{y≡r} (h(y − 1) + h(y + 1)) / 2.
  const h = a.topHist;
  const O = new Float64Array(16);
  const E = new Float64Array(16);
  for (let yi = 0; yi < 384; yi++) {
    const r16 = (yi - 64) & 15;
    O[r16]! += h[yi]!;
    E[r16]! += ((yi > 0 ? h[yi - 1]! : 0) + (yi < 383 ? h[yi + 1]! : 0)) / 2;
  }
  let chi2 = 0;
  for (let r16 = 0; r16 < 16; r16++) {
    rec[`landTopYmod16.raw.${r16}`] = O[r16]!;
    rec[`landTopYmod16.ratio.${r16}`] = share(O[r16]!, E[r16]!);
    if (E[r16]! > 0) chi2 += (O[r16]! - E[r16]!) ** 2 / E[r16]!;
  }
  rec['landTopYmod16.chi2'] = chi2;
  // surfaceDepth histogram over every position.
  let sdSum = 0;
  for (let d = 0; d < 64; d++) {
    if (a.sdHist[d]! > 0 || d <= 11) rec[`surfaceDepth.${d}`] = share(a.sdHist[d]!, a.positions);
    sdSum += d * a.sdHist[d]!;
  }
  rec['surfaceDepth.mean'] = share(sdSum, a.positions);
  // patchCoverage per (biome, patch block), over eligible land tops of the biome.
  for (const [bn, block] of TOP_PATCHES) {
    const b = B(bn);
    rec[`patchCoverage.${bn}.${NAMES[block]}`] = share(a.patchStates[b * STATES + block]!, a.patchTops[b]!);
    rec[`patchCoverage.${bn}.n`] = a.patchTops[b]!;
  }
  rec['patchCoverage.riverSwamp.clay'] = share(a.clayWet, a.clayWetTops);
  rec['patchCoverage.riverSwamp.n'] = a.clayWetTops;
  rec['patchCoverage.lake.clay'] = share(a.lakeClay, a.lakeWetTops);
  rec['patchCoverage.lake.n'] = a.lakeWetTops;
  // Per-block shares: of every solid voxel, of the land tops and of the wet tops.
  let solid = 0;
  for (let s = 1; s < STATES; s++) solid += a.blocks[s]!;
  for (let s = 1; s < STATES; s++) {
    rec[`blockShare.${NAMES[s]}`] = share(a.blocks[s]!, solid);
    rec[`landTopShare.${NAMES[s]}`] = share(a.landTopStates[s]!, a.landTops);
    rec[`wetTopShare.${NAMES[s]}`] = share(a.wetTopStates[s]!, a.wetTops);
  }
  rec.landTops = a.landTops;
  rec.wetTops = a.wetTops;
  return Object.assign(rec, surfaceCommonValues(a));
}

/**
 * S2 of one population: the parts `deepslateBelow0`, `deepslateAbove8` (populations: the stone-like voxels below 0
 * and above 8) and `bedrockFloor` (population: the positions; no minimum), then the extras and the common keys.
 */
export function s2Values(a: SurfaceAcc, mode: PopulationMode, label: string): Record<string, number> {
  const rec: Record<string, number> = {
    deepslateBelow0: share(a.deepBelow0, a.stoneBelow0),
    deepslateAbove8: share(a.deepAbove8, a.stoneAbove8),
    bedrockFloor: share(a.bedrockFloor, a.positions),
  };
  populations(rec, mode, label, [['deepslateBelow0', a.stoneBelow0, true], ['deepslateAbove8', a.stoneAbove8, true], ['bedrockFloor', a.positions, false]]);
  rec.stoneBelow0 = a.stoneBelow0 - a.deepBelow0;
  rec.positions = a.positions;
  return Object.assign(rec, surfaceCommonValues(a));
}

/**
 * S3 of one population: the parts `snowAboveLine` (population: the non-cliff land tops below the snowline) and
 * `snowNoSky` (population: the land tops), then the extras and the common keys.
 */
export function s3Values(a: SurfaceAcc, mode: PopulationMode, label: string): Record<string, number> {
  const rec: Record<string, number> = { snowAboveLine: share(a.snowLineSnow, a.snowLineTops), snowNoSky: a.snowNoSky };
  populations(rec, mode, label, [['snowAboveLine', a.snowLineTops, true], ['snowNoSky', a.landTops, true]]);
  rec.snowLineCliffTops = a.snowLineCliffs;
  rec.snowLineNotSnow = a.snowLineTops - a.snowLineSnow;
  return Object.assign(rec, surfaceCommonValues(a));
}

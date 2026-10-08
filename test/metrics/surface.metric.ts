import { Worker } from 'node:worker_threads';
import { expect } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { REGISTRY } from '../../src/world/blocks/index';
import { metricTest } from '../harness/metric';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import { YMOD16_CLASSES, ymod16Test } from '../harness/stats';
import { mergeSurfaceAcc, newSurfaceAcc, SURFACE_STATES, surfaceBiomeId, TOP_PATCHES, type SurfaceAcc } from '../harness/surfaceScatter';
import type { SurfaceScatterMsg, SurfaceScatterReply } from '../harness/surfaceScatterWorker';

/**
 * S1, S2, S3, the B4 voxel parts and the B2 river check on the surfaced voxels (SP3c spec §5.1, §5.2), with the
 * ungated diagnostics of §5.2.
 *
 * Sampling (§5.1): the scattered columns of T1-T5 (`terrain.metric.ts`): per profile (default, large_biomes) and tier
 * seed ('42'; full '42', '1', '2', '3'), `COLUMNS` columns drawn by one `Xoshiro128(fnv1a32('T1-T5'))` in the same
 * order (profile, then seed, then column) uniformly over ±1024 chunks (default) or ±4096 (large_biomes), generated with
 * `fillColumnT` AND analysed on 4 region workers (`test/harness/surfaceScatterWorker.ts`, the analysis in
 * `test/harness/surfaceScatter.ts`); this thread only merges the workers' count records (`mergeSurfaceAcc`, an exact
 * sum: every accumulator is order-independent; `ymod16`'s position choice depends only on the seed and (cx, cz)).
 * Vitest isolates metric files, so this file draws and generates the columns again rather than sharing
 * terrain.metric.ts's pass.
 *
 * Readouts (§5.2): each column's ColumnSample is rebuilt in the worker (`buildColumnSample`, as the stage builds it)
 * and its voxels re-scanned with the stage's SurfaceContext settings (`scanColumn` over the stored solidity, the stored
 * water and aux A's `surfaceBiome`), so T, steep, T_eff, the cliff predicate (`steepHolds` ∧ `yAboveHolds{runTop}` at
 * the top), the biome, `lake` and the nearest quart corner are the rules' own; C, offset0 and offset are bilinear
 * `readField` readouts. A land top is the top of a position with no water above it (`WORLD_SURFACE_WG ==
 * OCEAN_FLOOR_WG`), y = `OCEAN_FLOOR_WG − 1`; a position is wet otherwise. A voxel is in the sky-open run when it lies
 * at or above the bottom of its position's first (topmost) run.
 *
 * Parts (worst of the two profiles; counts are summed; every per-profile value and population is recorded beside it
 * as `<part>.<profile>` and `<part>.n.<profile>`; a population below 1,000 fails "insufficient sample", §5.1):
 * - S1 `buried` grass_block, snow_block or red_sand voxels with a solid voxel directly above (y 319 has air above);
 *   `grassNoSky` grass_block voxels below the sky-open run; `ymod16` the χ² independence p-value of the land top's
 *   y mod 16 against its soil depth class over one position per column (§5.2, pooled per profile, the smaller p);
 * - S2 `deepslateBelow0` deepslate / (stone + deepslate) voxels at y < 0; `deepslateAbove8` the same at y > 8;
 *   `bedrockFloor` the share of positions with bedrock at y −64;
 * - S3 `snowAboveLine` the share of land tops with T_eff(y_top) < snowline that are not cliffs whose top is snow_block;
 *   `snowNoSky` snow_block voxels below the sky-open run;
 * - B4 (`B4.voxel.json`) `snowInDesert` desert land tops that are snow_block; `coastBandBeachVoxel` the share of
 *   coast-band land tops (C ∈ [−0.22, −0.04], offset0 ≥ 63) whose top is sand, red_sand, gravel or stone, or snow_block
 *   at a snowy_beach position; `landTopsBelowSea` the share of land-family positions (lowland, highland, coast; not at
 *   a corner with a finite lakeLevel, lakeMask > 0 or river-wet) whose floor is below 63 with water above;
 * - B2 (`B2.voxel.json`) `riverChannelWater` the share of positions whose nearest corner is river-wet and whose
 *   bilinear offset < 63 that have water above their top (with the same share over offset < 62 and < 61, and the dry
 *   positions' tops, as diagnostics).
 * Diagnostics (ungated): `landTopYmod16` (raw and against the neighbour-average expectation, with its χ²),
 * `dryPitsBelowSea`, `lakeRimIslets` (land tops with an ocean-family biome at a corner with 0 < lakeMask < 1, as a
 * share of all positions), `oceanBiomeLandTops` (every land top with an ocean-family biome, as a share of all positions:
 * mostly sea-class density islands, the rim islets are a small part of it), `shorelineFringe` (near-shore positions, Chebyshev distance ≤ 2 inside the column from a
 * position of the other wet/dry state, without the islets: the share with an ocean-family biome on a land top or a
 * land-family biome under water; `shorelineFringeSea` the same without lake, lakeMask and river-wet corners; the top
 * blocks of the islets and of both fringe kinds, to judge how they look), the
 * surfaceDepth histogram, `patchCoverage` per (biome, patch block), and per-block voxel and top shares.
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const PROFILES = ['default', 'large_biomes'] as const;
type Profile = (typeof PROFILES)[number];
const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const RANGE: Readonly<Record<Profile, number>> = { default: 1024, large_biomes: 4096 };
/** T1-T5's columns per (profile, seed) (§5.1). */
const COLUMNS: Readonly<Record<Profile, number>> = pick(
  { default: 4096, large_biomes: 16384 },
  { default: 8192, large_biomes: 32768 },
  { default: 4096, large_biomes: 16384 },
);
const SCATTER_WORKER_DIR = `surfaceScatterWorker-${TIER}`;

/** §5.1: every population-dependent part needs 1,000 per profile. */
const MIN_POPULATION = 1000;

const STATES = SURFACE_STATES;
const NAMES: readonly string[] = Array.from({ length: STATES }, (_, s) => REGISTRY.stateKey(s));
const B = surfaceBiomeId;

/** Fails the running metric test (soft) when a population is below its minimum. */
function requireSample(what: string, n: number, min = MIN_POPULATION): void {
  expect.soft(n, `${what}: insufficient sample (${n} < ${min})`).toBeGreaterThanOrEqual(min);
}

type Acc = SurfaceAcc;

let scatterScript: Promise<string> | null = null;
const askWorker = (w: Worker, msg: SurfaceScatterMsg): Promise<SurfaceScatterReply> => ask<SurfaceScatterReply>(w, msg);
const fail = (what: string, r: SurfaceScatterReply): Error => new Error(`${what}: ${r.type === 'error' ? r.message : r.type}`);

/**
 * Generates and analyses scattered (possibly repeated) columns on 4 surface scatter workers, each with its own small
 * store (one column at a time: claimed, analysed, freed), handing out the next column to whichever worker is free, and
 * adds the workers' counts into `acc`.
 */
async function analyseColumnsThreaded(
  seed: string,
  params: Params,
  cols: ReadonlyArray<readonly [number, number]>,
  acc: Acc,
): Promise<void> {
  scatterScript ??= buildNodeTaskWorker(SCATTER_WORKER_DIR, { entry: 'test/harness/surfaceScatterWorker.ts' });
  const script = await scatterScript;
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

let scatteredMemo: Promise<Record<Profile, Acc>> | null = null;

/** The one pass over the scattered columns, memoised. */
function scattered(): Promise<Record<Profile, Acc>> {
  scatteredMemo ??= scatter();
  return scatteredMemo;
}

async function scatter(): Promise<Record<Profile, Acc>> {
  const r = new Xoshiro128(fnv1a32('T1-T5'));
  const out = {} as Record<Profile, Acc>;
  for (const profile of PROFILES) {
    const t0 = performance.now();
    const a = newSurfaceAcc();
    const R = RANGE[profile];
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const cols: Array<[number, number]> = [];
      for (let n = 0; n < COLUMNS[profile]; n++) cols.push([-R + r.nextInt(2 * R), -R + r.nextInt(2 * R)]);
      await analyseColumnsThreaded(seed, params, cols, a);
    }
    a.seconds = Math.round(performance.now() - t0) / 1000;
    out[profile] = a;
  }
  return out;
}

/** Writes `<key>.<profile>` for every profile and returns the worst (max or min) under `key`. */
function perProfile(rec: Record<string, number>, key: string, values: Record<Profile, number>, worst: 'max' | 'min' | 'sum'): void {
  for (const p of PROFILES) rec[`${key}.${p}`] = values[p];
  const v = PROFILES.map((p) => values[p]);
  rec[key] = worst === 'max' ? Math.max(...v) : worst === 'min' ? Math.min(...v) : v.reduce((s, x) => s + x, 0);
}

const byProfile = (f: (p: Profile) => number): Record<Profile, number> =>
  Object.fromEntries(PROFILES.map((p) => [p, f(p)])) as Record<Profile, number>;

const share = (n: number, d: number): number => (d === 0 ? NaN : n / d);

/** Records a population beside its part and requires the minimum. */
function population(rec: Record<string, number>, part: string, n: Record<Profile, number>): void {
  for (const p of PROFILES) {
    rec[`${part}.n.${p}`] = n[p];
    requireSample(`${part} (${p})`, n[p]);
  }
}

function common(rec: Record<string, number>, sc: Record<Profile, Acc>): void {
  for (const p of PROFILES) {
    rec[`columns.${p}`] = sc[p].columns;
    rec[`seconds.${p}`] = sc[p].seconds;
    rec[`topMismatch.${p}`] = sc[p].topMismatch;
  }
}

metricTest('S1', ['buried', 'grassNoSky', 'ymod16'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'buried', byProfile((p) => sc[p].buried), 'sum');
  perProfile(rec, 'grassNoSky', byProfile((p) => sc[p].grassNoSky), 'sum');
  population(rec, 'buried', byProfile((p) => sc[p].landTops));
  population(rec, 'grassNoSky', byProfile((p) => sc[p].landTops));
  const y = byProfile((p) => ymod16Test(sc[p].ymod).p);
  perProfile(rec, 'ymod16', y, 'min');
  population(rec, 'ymod16', byProfile((p) => sc[p].ymodColumns));
  for (const p of PROFILES) {
    const a = sc[p];
    const t = ymod16Test(a.ymod);
    expect.soft(t.degenerate, `S1.ymod16 (${p}): degenerate table (classes ${t.classes.join(', ')})`).toBe(false);
    rec[`ymod16.chi2.${p}`] = t.chi2;
    rec[`ymod16.df.${p}`] = t.df;
    rec[`ymod16.rows.${p}`] = t.rows;
    rec[`ymod16.classesLeft.${p}`] = t.classes.length;
    for (let k = 0; k < YMOD16_CLASSES; k++) {
      let n = 0;
      for (let r = 0; r < 16; r++) n += a.ymod[6 * r + k]!;
      rec[`ymod16.class${k === 5 ? '5plus' : k}.${p}`] = n;
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
      rec[`landTopYmod16.raw.${r16}.${p}`] = O[r16]!;
      rec[`landTopYmod16.ratio.${r16}.${p}`] = share(O[r16]!, E[r16]!);
      if (E[r16]! > 0) chi2 += (O[r16]! - E[r16]!) ** 2 / E[r16]!;
    }
    rec[`landTopYmod16.chi2.${p}`] = chi2;
    // surfaceDepth histogram over every position.
    let sdSum = 0;
    for (let d = 0; d < 64; d++) {
      if (a.sdHist[d]! > 0 || d <= 11) rec[`surfaceDepth.${d}.${p}`] = share(a.sdHist[d]!, a.positions);
      sdSum += d * a.sdHist[d]!;
    }
    rec[`surfaceDepth.mean.${p}`] = share(sdSum, a.positions);
    // patchCoverage per (biome, patch block), over eligible land tops of the biome.
    for (const [bn, block] of TOP_PATCHES) {
      const b = B(bn);
      rec[`patchCoverage.${bn}.${NAMES[block]}.${p}`] = share(a.patchStates[b * STATES + block]!, a.patchTops[b]!);
      rec[`patchCoverage.${bn}.n.${p}`] = a.patchTops[b]!;
    }
    rec[`patchCoverage.riverSwamp.clay.${p}`] = share(a.clayWet, a.clayWetTops);
    rec[`patchCoverage.riverSwamp.n.${p}`] = a.clayWetTops;
    rec[`patchCoverage.lake.clay.${p}`] = share(a.lakeClay, a.lakeWetTops);
    rec[`patchCoverage.lake.n.${p}`] = a.lakeWetTops;
    // Per-block shares: of every solid voxel, of the land tops and of the wet tops.
    let solid = 0;
    for (let s = 1; s < STATES; s++) solid += a.blocks[s]!;
    for (let s = 1; s < STATES; s++) {
      rec[`blockShare.${NAMES[s]}.${p}`] = share(a.blocks[s]!, solid);
      rec[`landTopShare.${NAMES[s]}.${p}`] = share(a.landTopStates[s]!, a.landTops);
      rec[`wetTopShare.${NAMES[s]}.${p}`] = share(a.wetTopStates[s]!, a.wetTops);
    }
    rec[`landTops.${p}`] = a.landTops;
    rec[`wetTops.${p}`] = a.wetTops;
  }
  common(rec, sc);
  return rec;
});

metricTest('S2', ['deepslateBelow0', 'deepslateAbove8', 'bedrockFloor'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'deepslateBelow0', byProfile((p) => share(sc[p].deepBelow0, sc[p].stoneBelow0)), 'min');
  perProfile(rec, 'deepslateAbove8', byProfile((p) => share(sc[p].deepAbove8, sc[p].stoneAbove8)), 'max');
  perProfile(rec, 'bedrockFloor', byProfile((p) => share(sc[p].bedrockFloor, sc[p].positions)), 'min');
  population(rec, 'deepslateBelow0', byProfile((p) => sc[p].stoneBelow0));
  population(rec, 'deepslateAbove8', byProfile((p) => sc[p].stoneAbove8));
  for (const p of PROFILES) {
    rec[`stoneBelow0.${p}`] = sc[p].stoneBelow0 - sc[p].deepBelow0;
    rec[`positions.${p}`] = sc[p].positions;
  }
  common(rec, sc);
  return rec;
});

metricTest('S3', ['snowAboveLine', 'snowNoSky'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'snowAboveLine', byProfile((p) => share(sc[p].snowLineSnow, sc[p].snowLineTops)), 'min');
  perProfile(rec, 'snowNoSky', byProfile((p) => sc[p].snowNoSky), 'sum');
  population(rec, 'snowAboveLine', byProfile((p) => sc[p].snowLineTops));
  population(rec, 'snowNoSky', byProfile((p) => sc[p].landTops));
  for (const p of PROFILES) {
    rec[`snowLineCliffTops.${p}`] = sc[p].snowLineCliffs;
    rec[`snowLineNotSnow.${p}`] = sc[p].snowLineTops - sc[p].snowLineSnow;
  }
  common(rec, sc);
  return rec;
});

metricTest('B4', ['snowInDesert', 'coastBandBeachVoxel', 'landTopsBelowSea'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'snowInDesert', byProfile((p) => sc[p].desertSnow), 'sum');
  perProfile(rec, 'coastBandBeachVoxel', byProfile((p) => share(sc[p].coastOk, sc[p].coastTops)), 'min');
  perProfile(rec, 'landTopsBelowSea', byProfile((p) => share(sc[p].landBiomeWetBelow, sc[p].landBiome)), 'max');
  population(rec, 'snowInDesert', byProfile((p) => sc[p].desertTops));
  population(rec, 'coastBandBeachVoxel', byProfile((p) => sc[p].coastTops));
  population(rec, 'landTopsBelowSea', byProfile((p) => sc[p].landBiome));
  for (const p of PROFILES) {
    const a = sc[p];
    rec[`dryPitsBelowSea.${p}`] = share(a.landBiomeDryBelow, a.landBiome);
    rec[`landTopsBelowSeaCount.${p}`] = a.landBiomeWetBelow;
    rec[`lakeRimIslets.${p}`] = share(a.islets, a.positions);
    rec[`lakeRimIsletCount.${p}`] = a.islets;
    rec[`oceanBiomeLandTops.${p}`] = share(a.oceanOnLand, a.positions);
    rec[`oceanBiomeLandTopCount.${p}`] = a.oceanOnLand;
    rec[`shorelineFringe.${p}`] = share(a.fringeOceanOnLand + a.fringeLandUnderWater, a.fringe);
    rec[`shorelineFringe.n.${p}`] = a.fringe;
    rec[`shorelineFringe.oceanOnLand.${p}`] = share(a.fringeOceanOnLand, a.fringe);
    rec[`shorelineFringe.landUnderWater.${p}`] = share(a.fringeLandUnderWater, a.fringe);
    rec[`shorelineFringeSea.${p}`] = share(a.fringeSeaBad, a.fringeSea);
    rec[`shorelineFringeSea.n.${p}`] = a.fringeSea;
    rec[`coastBand.coastBiomeShare.${p}`] = share(a.coastBeachBiome, a.coastTops);
    for (let s = 1; s < STATES; s++) if (a.coastTopStates[s]! > 0) rec[`coastBand.top.${NAMES[s]}.${p}`] = share(a.coastTopStates[s]!, a.coastTops);
    rec[`desertTops.${p}`] = a.desertTops;
    for (let s = 1; s < STATES; s++) {
      if (a.isletTopStates[s]! > 0) rec[`lakeRimIslets.top.${NAMES[s]}.${p}`] = share(a.isletTopStates[s]!, a.islets);
      if (a.fringeOceanOnLandTop[s]! > 0) rec[`shorelineFringe.oceanOnLandTop.${NAMES[s]}.${p}`] = share(a.fringeOceanOnLandTop[s]!, a.fringeOceanOnLand);
      if (a.fringeLandUnderWaterTop[s]! > 0) rec[`shorelineFringe.landUnderWaterTop.${NAMES[s]}.${p}`] = share(a.fringeLandUnderWaterTop[s]!, a.fringeLandUnderWater);
    }
  }
  common(rec, sc);
  return rec;
}, 600_000, { outName: 'B4.voxel' });

metricTest('B2', ['riverChannelWater'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'riverChannelWater', byProfile((p) => share(sc[p].riverWet, sc[p].river)), 'min');
  population(rec, 'riverChannelWater', byProfile((p) => sc[p].river));
  for (const p of PROFILES) {
    const a = sc[p];
    const dry = a.river - a.riverWet;
    rec[`riverDry.${p}`] = dry;
    rec[`riverDry.topBelow63.${p}`] = a.riverDry[0]!;
    rec[`riverDry.top63to64.${p}`] = a.riverDry[1]!;
    rec[`riverDry.top65to67.${p}`] = a.riverDry[2]!;
    rec[`riverDry.top68up.${p}`] = a.riverDry[3]!;
    rec[`riverChannel.riverBiomeShare.${p}`] = share(a.riverRiverBiome, a.river);
    rec[`riverDry.riverBiome.${p}`] = a.riverDryRiverBiome;
    rec[`riverChannelWater.offsetBelow62.${p}`] = share(a.riverWet62, a.river62);
    rec[`riverChannelWater.offsetBelow62.n.${p}`] = a.river62;
    rec[`riverChannelWater.offsetBelow61.${p}`] = share(a.riverWet61, a.river61);
    rec[`riverChannelWater.offsetBelow61.n.${p}`] = a.river61;
  }
  common(rec, sc);
  return rec;
}, 600_000, { outName: 'B2.voxel' });

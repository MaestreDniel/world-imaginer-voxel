import { expect } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { PROFILE_IDS, resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { biomeSharesInto, biomeSharesLength, summarizeBiomeShares } from '../../src/metrics/biomeShares';
import { samplePoints } from '../../src/metrics/noiseStats';
import { AIR } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { dt2Column, newDt2Acc, type Dt2Extension, type Dt2Stratum } from '../harness/dt2';
import { topDownHeightmaps } from '../harness/heightmaps';
import { metricTest } from '../harness/metric';

/**
 * The draft presets' metrics (SP3e spec §5), on every tier, over archipelago, amplified and floating_islands resolved
 * with `resolveProfile`, in `PROFILE_IDS` order. Its own streams, so no existing stream draws differently; nothing here
 * enters `terrain.metric.ts`' or `surface.metric.ts`' per-profile worst-of.
 * - `DT2.presets` (§5.2, gated, max 0): per preset, seed '42', `Xoshiro128(fnv1a32('DT2.presets.<preset>'))`, chunk
 *   columns uniform in ±1024 chunks (fast 8, quick 32, full 128 per preset): the first half drawn as DT2 draws its
 *   columns, the second half feature columns from the same stream, kept when `columnPoint` at the centre block
 *   (16cx + 8, 16cz + 8) has offset0 ≥ 180 (amplified), offset0 within 63 ± 4 (archipelago) or islandMask ≥ 0.5
 *   (floating_islands; its first feature column also offset0 < 63: an island over the sea), at most 4096 draws per
 *   search. Each column runs DT2's checks through `dt2Column` (16 voxels and their cell corners, the 8 skin voxels),
 *   amplified's feature columns with 2 extra voxels in y 296 … 319 (the moved slide and ceiling).
 *   `presetProbeBulk`, `presetCompiledReference`, `presetSurfaceProbeBulk`, `presetSurfaceReference`: DT2's four parts
 *   on these columns; `presetNonFinite`: checked voxels and cell corners whose compiled or reference density is not
 *   finite; `presetHeightmaps`: positions whose aux A `worldSurfaceWG` or `oceanFloorWG` differs from the top-down scan
 *   of the column's blocks and fluid (`test/harness/heightmaps.ts`); `presetNoFeatureColumn`: searches that ended
 *   without a column. Extras per preset: columns, feature draws, voxels per stratum, corner values and, on
 *   floating_islands, the island voxels checked (solid, in a run whose bottom voxel is ≥ ISLAND_RUN_MIN_BOTTOM).
 * - `B1.presets` (§5.4, gated): archipelago's B1, computed as the default B1 call (`biomes.metric.ts`: the
 *   `B1.<s>` point streams, seeds 1 … k, fast 40k × 2, quick 100k × 4, full 250k × 8) on the archipelago ctx;
 *   `presetInputsDiffer` counts the presets among amplified and floating_islands whose B1 inputs (climate, shape,
 *   rivers, lakes, biomes) are not canonically the defaults' (at 0 their B1 is the default's, gated by `B1`).
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

type DraftPreset = Extract<ProfileId, 'archipelago' | 'amplified' | 'floating_islands'>;
const isDraft = (p: ProfileId): p is DraftPreset => p === 'archipelago' || p === 'amplified' || p === 'floating_islands';
/** The three drafts in PROFILE_IDS order (archipelago, amplified, floating_islands). */
const PRESETS: readonly DraftPreset[] = PROFILE_IDS.filter(isDraft);

const SEED = '42';
const ctxOf = (preset: ProfileId, seed: string): GenContext => createGenContext(seedFromInput(seed), resolveProfile(preset));

const DT2_PRESET_COLUMNS = pick(8, 32, 128);
/** The default's DT2_RANGE: chunk columns uniform in ±1024 chunks. */
const DT2_PRESET_RANGE = 1024;
const FEATURE_DRAWS = 4096;
const AMPLIFIED_EXTRA = { count: 2, yLo: 296, yHi: 319 } as const;
const STRATA: readonly Dt2Stratum[] = ['uniform', 'bulk', 'top', 'extra'];

/** Whether chunk column (cx, cz) is a feature column of `preset` (`first`: its first feature column). */
function isFeatureColumn(ctx: GenContext, preset: DraftPreset, cx: number, cz: number, first: boolean): boolean {
  const c = columnPoint(ctx, 16 * cx + 8, 16 * cz + 8);
  switch (preset) {
    case 'amplified': return c.offset0 >= 180;
    case 'archipelago': return Math.abs(c.offset0 - 63) <= 4;
    case 'floating_islands': return c.islandMask >= 0.5 && (!first || c.offset0 < 63);
  }
}

metricTest('DT2', [
  'presetProbeBulk', 'presetCompiledReference', 'presetSurfaceProbeBulk', 'presetSurfaceReference', 'presetNonFinite',
  'presetHeightmaps', 'presetNoFeatureColumn',
], () => {
  const t0 = performance.now();
  const acc = newDt2Acc();
  const problems = acc.problems;
  let nonFinite = 0;
  let heightmaps = 0;
  let noFeature = 0;
  const extras: Record<string, number> = {};
  for (const preset of PRESETS) {
    const ctx = ctxOf(preset, SEED);
    const r = new Xoshiro128(fnv1a32(`DT2.presets.${preset}`));
    acc.label = `preset ${preset}, seed '${SEED}'`;
    const strata = new Map<Dt2Stratum, number>(STRATA.map((s) => [s, 0]));
    let islandVoxels = 0;
    let corners = 0;
    let columns = 0;
    let featureDraws = 0;
    const ext = (extra?: Dt2Extension['extra']): Dt2Extension => ({
      extra,
      voxel: (v) => {
        strata.set(v.stratum, strata.get(v.stratum)! + 1);
        if (!Number.isFinite(v.value) || !Number.isFinite(v.reference)) {
          nonFinite++;
          problems.push(`${acc.label}: (${v.x}, ${v.y}, ${v.z}) non-finite density: compiled ${v.value}, reference ${v.reference}`);
        }
        if (v.block !== AIR && v.runBottom !== null && v.runBottom >= ISLAND_RUN_MIN_BOTTOM) islandVoxels++;
      },
      corner: (cv, rc) => {
        corners++;
        if (!Number.isFinite(cv) || !Number.isFinite(rc)) {
          nonFinite++;
          problems.push(`${acc.label}: non-finite corner value: compiled ${cv}, reference ${rc}`);
        }
      },
      column: (view: ColumnView) => {
        const aux = view.aux()!;
        for (let p = 0; p < 256; p++) {
          const [ws, of] = topDownHeightmaps(view, p & 15, p >> 4);
          if (aux.worldSurfaceWG[p] !== ws || aux.oceanFloorWG[p] !== of) {
            heightmaps++;
            problems.push(`${acc.label}, column (${view.cx}, ${view.cz}), p ${p}: heightmaps ${aux.worldSurfaceWG[p]}/${aux.oceanFloorWG[p]} ≠ top-down ${ws}/${of}`);
          }
        }
      },
    });
    const half = DT2_PRESET_COLUMNS >> 1;
    for (let n = 0; n < half; n++) {
      const cx = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
      const cz = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
      dt2Column(ctx, cx, cz, r, acc, ext());
      columns++;
    }
    for (let k = 0; k < DT2_PRESET_COLUMNS - half; k++) {
      let found: [number, number] | null = null;
      for (let d = 0; d < FEATURE_DRAWS && found === null; d++) {
        const cx = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
        const cz = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
        featureDraws++;
        if (isFeatureColumn(ctx, preset, cx, cz, k === 0)) found = [cx, cz];
      }
      if (found === null) {
        noFeature++;
        problems.push(`${acc.label}: feature column ${k}: none in ${FEATURE_DRAWS} draws`);
        continue;
      }
      dt2Column(ctx, found[0], found[1], r, acc, ext(preset === 'amplified' ? AMPLIFIED_EXTRA : undefined));
      columns++;
    }
    extras[`columns.${preset}`] = columns;
    extras[`featureDraws.${preset}`] = featureDraws;
    for (const s of STRATA) extras[`voxels.${s}.${preset}`] = strata.get(s)!;
    extras[`cornerValues.${preset}`] = corners;
    if (preset === 'floating_islands') extras[`islandVoxels.${preset}`] = islandVoxels;
  }
  expect.soft(problems.slice(0, 20), `DT2.presets mismatches (tier ${TIER}), first 20 of ${problems.length}`).toEqual([]);
  return {
    presetProbeBulk: acc.probeBulk, presetCompiledReference: acc.compiledReference, presetSurfaceProbeBulk: acc.surfaceProbeBulk,
    presetSurfaceReference: acc.surfaceReference, presetNonFinite: nonFinite, presetHeightmaps: heightmaps,
    presetNoFeatureColumn: noFeature,
    voxels: acc.voxels, maskedVoxels: acc.maskedVoxels, cornerValues: acc.corners, columns: acc.columns,
    surfaceVoxels: acc.surfaceVoxels, surfaceExtraVoxels: acc.surfaceExtraVoxels, surfaceExtraSkipped: acc.surfaceExtraSkipped,
    ...extras,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
}, 600_000, { outName: 'DT2.presets' });

/** The parameter groups B1 reads (climate, offset0, the river flag, the lake gates, the biome table). */
const B1_INPUTS = ['climate', 'shape', 'rivers', 'lakes', 'biomes'] as const;

metricTest('B1', [
  'oceanFamilyArchipelago', 'minShareArchipelago', 'minRareShareArchipelago', 'largestLandArchipelago', 'tiesArchipelago',
  'outsideArchipelago', 'presetInputsDiffer',
], () => {
  const t0 = performance.now();
  const seeds = pick(2, 4, 8);
  const n = pick(40000, 100000, 250000);
  const sum = new Float64Array(biomeSharesLength());
  for (let s = 1; s <= seeds; s++) biomeSharesInto(ctxOf('archipelago', String(s)), samplePoints(`B1.${s}`, n), 0, n, sum);
  const r = summarizeBiomeShares(sum);
  const differ: Record<string, number> = {};
  for (const preset of PRESETS) {
    if (preset === 'archipelago') continue;
    const params = resolveProfile(preset);
    differ[`inputsDiffer.${preset}`] = B1_INPUTS.some((g) => canonicalJSON(params[g]) !== canonicalJSON(DEFAULTS[g])) ? 1 : 0;
  }
  const shares: Record<string, number> = {};
  SURFACE_BIOMES.forEach((name, id) => { shares[`share.${name}`] = r.shares[id]!; });
  return {
    oceanFamilyArchipelago: r.oceanFamily, minShareArchipelago: r.minShare, minRareShareArchipelago: r.minRareShare,
    largestLandArchipelago: r.largestLand, tiesArchipelago: r.ties, outsideArchipelago: r.outside,
    presetInputsDiffer: Object.values(differ).reduce((a, b) => a + b, 0),
    points: r.total, ...differ, ...shares,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
}, 600_000, { outName: 'B1.presets' });

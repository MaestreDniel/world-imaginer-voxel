import { expect } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA, type Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { newSurfaceScan, runAt, type SurfaceScan } from '../../src/gen/surface/scan';
import { validateParamTrees } from '../../src/gen/trees';
import { expectGolden } from '../harness/goldens';
import { metricTest } from '../harness/metric';
import { integerEnv } from '../harness/env';
import { dt2Column, dt2Setup, newDt2Acc } from '../harness/dt2';
import { dt1WorkerDir, genRegion, type GenRegionOptions, type RegionResult } from '../harness/region';
import { mutateTree } from '../harness/treeMutator';

/**
 * DT1 on the T stage (SP3a spec §6.3; the real T since SP3b), threshold exact (0 mismatches), on every tier:
 * 1. Invariance: per profile (default, large_biomes) and tier seed, five runs of the tier's region give equal region
 *    hashes: spiral / 1 thread / cold, shuffled / 4 threads / cold, a second spiral / 1 thread / cold, and two
 *    `cache: true` runs (shuffled / 4 threads, then spiral / 1 thread), the second of which must be a cache hit.
 * 2. Golden: in the seed '42' cold spiral run of each profile, the hash of the 8 × 8 window at (−4, −4) is
 *    `sp3a.region.T.<profile>` (in `npm run test:goldens` it is recorded as an observation instead, so it must agree
 *    with the unit test's `genRegionInProcess` value).
 * `DT1_SHUFFLE_SEED` (default 1) seeds the shuffled order; it is printed with every mismatch.
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const PROFILES = ['default', 'large_biomes'] as const;
/** Fast: the 8 × 8 golden region itself; quick and full: 32 × 32 around it. */
const REGION = pick({ cx0: -4, cz0: -4, w: 8, h: 8 }, { cx0: -16, cz0: -16, w: 32, h: 32 }, { cx0: -16, cz0: -16, w: 32, h: 32 });
/** The spec allows the full tier to drop to two seeds if four are too slow (measured in the plan's dry run). */
const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const SHUFFLE_SEED = integerEnv('DT1_SHUFFLE_SEED', 1);
const GOLDEN_WINDOW = [-4, -4, 8, 8] as const;

interface Run {
  readonly label: string;
  readonly order: GenRegionOptions['order'];
  readonly threads: GenRegionOptions['threads'];
  readonly cache: boolean;
}

const RUNS: readonly Run[] = [
  { label: 'spiral/1/cold', order: 'spiral', threads: 1, cache: false },
  { label: 'shuffled/4/cold', order: 'shuffled', threads: 4, cache: false },
  { label: 'spiral/1/cold again', order: 'spiral', threads: 1, cache: false },
  { label: 'shuffled/4/cache', order: 'shuffled', threads: 4, cache: true },
  { label: 'spiral/1/cache (must hit)', order: 'spiral', threads: 1, cache: true },
];

metricTest('DT1', ['mismatches'], async () => {
  const problems: string[] = [];
  let invariance = 0;
  let golden = 0;
  let firstCacheHits = 0;
  let genMs = 0;
  for (const profile of PROFILES) {
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const at = `profile ${profile}, seed '${seed}', shuffleSeed ${SHUFFLE_SEED}`;
      let ref = '';
      for (const [i, run] of RUNS.entries()) {
        const r: RegionResult = await genRegion({
          seed, params, ...REGION, upTo: 'T', order: run.order, threads: run.threads, cache: run.cache,
          shuffleSeed: SHUFFLE_SEED, workerDir: dt1WorkerDir(TIER),
        });
        genMs += r.timings.totalMs;
        const hash = r.view.hash();
        if (i === 0) {
          ref = hash;
          if (seed === '42') {
            try {
              expectGolden(`sp3a.region.T.${profile}`, r.view.hash(...GOLDEN_WINDOW));
            } catch (e) {
              golden++;
              problems.push(`${at}: golden window (−4, −4) 8 × 8: ${(e as Error).message}`);
            }
          }
        } else if (hash !== ref) {
          invariance++;
          problems.push(`${at}: ${run.label} hash ${hash} ≠ ${RUNS[0]!.label} ${ref}`);
        }
        if (i === 3 && r.cacheHit) firstCacheHits++;
        if (i === 4 && !r.cacheHit) {
          invariance++;
          problems.push(`${at}: ${run.label} was not a cache hit`);
        }
      }
    }
  }
  expect.soft(problems, `DT1 mismatches (tier ${TIER}, DT1_SHUFFLE_SEED=${SHUFFLE_SEED})`).toEqual([]);
  return {
    mismatches: invariance + golden, invarianceMismatches: invariance, goldenMismatches: golden,
    firstCacheHits, regions: PROFILES.length * SEEDS.length * RUNS.length, genSeconds: Math.round(genMs) / 1000,
  };
});

/**
 * DT2 (SP3b spec §8.2), threshold exact (0 / 0), on every tier: random voxels in generated columns.
 * - Columns: per profile (default, large_biomes) and DT1's tier seeds, drawn uniformly over ±1024 chunks (default) or
 *   ±4096 (large_biomes, §8.1's ±16384 / ±65536 blocks) by `Xoshiro128(fnv1a32('DT2'))`; each is generated with
 *   `fillColumnT` on a fresh column of an `ArrayBuffer` store and run through `terrainDensityDebug`.
 * - Voxels: 16 per column, y −63 … 319, in three strata: 6 uniform over the column; 5 uniform over the voxels the bulk
 *   evaluated (mask 1; uniform over the column when there are none); 5 near the top, at a uniform position and
 *   `OCEAN_FLOOR_WG − 1 + d`, d uniform in −4 … 4 (where a wrong early-out would show). Fast 512, quick 8,192, full
 *   32,768 voxels.
 * - `probeBulk`: voxels whose probe solidity (final > 0, a DensityContext compiled apart from the stage's) differs from
 *   the block's (SP3c §5.2: solid ⇔ block ≠ air, palette blocks and dithered bedrock included; air, with or without
 *   water, is not solid; y −64 is never drawn), plus voxels with mask 1 whose probe value is not `Object.is` the
 *   bulk's.
 * - `compiledReference`: values where the compiled closures and the reference interpreter differ (`Object.is`): the
 *   probe at each voxel, and the 8 corner values of its cell for every `interpolated` node.
 * - `surfaceProbeBulk` (SP3c §5.2): voxels where `surfaceProbe`'s state (a SurfaceContext built apart: its own
 *   DensityContext and column rebuild, the reference walk, never the fast path) differs from the stored block (the
 *   stage's compiled tree, fast path included).
 * - `surfaceReference` (SP3c §5.2): solid voxels where the stage's compiled tree (`surfaceContextOf(ctx).compiled`,
 *   full evaluation) and the reference evaluator of the SurfaceContext built apart give different states, both on the
 *   stage's scan context of the column (`terrainSurfaceDebug`): at each DT2 voxel, plus 8 per column drawn from their
 *   own stream `Xoshiro128(hash2(fnv1a32('DT2.surface'), cx, cz))` (a position, then a depth 0 … maxSurfaceDepth below
 *   the top of its sky-open run; a draw that lands on a non-solid voxel is skipped), so DT2's columns and its 16
 *   voxels per column are drawn exactly as in SP3b.
 * - `editedDensityReference` and `editedSurfaceReference` (SP3d spec §7, D15): per profile and seed, edited trees of
 *   the profile's `density.defs` / `surface.rules` (1 … 3 structure-preserving `treeMutator` mutations, drawn from their
 *   own stream `Xoshiro128(fnv1a32('DT2.edited'))`, kept only when both tiers accept the edited params and its canonical
 *   text differs from the profile's tree; at most 64 draws per tree, else the part counts 1 with "no valid edited
 *   tree"), each in a GenContext of its own params, at DT2's first columns of that profile and seed (fast 2 trees × 8
 *   columns, quick 8 × 32, full 16 × 64): density — at the column's 16 DT2 voxels and their cell corners, the compiled
 *   probe (a DensityContext on the resolved leaf) ≠ the reference, or any non-finite value; rules — at the DT2 voxels
 *   that are solid plus 8 per column within maxSurfaceDepth of the sky-open top (drawn from the edited stream), the
 *   stage's compiled tree (full evaluation) ≠ the reference evaluator of a SurfaceContext built apart, on the stage's
 *   scan of the column (`terrainSurfaceDebug`). The existing parts draw exactly as before.
 * The per-column checks of the first four parts are `dt2Column` (`test/harness/dt2.ts`, SP3e spec §5.1, D18): this file
 * keeps the profiles, the shared `DT2` stream, `DT2_RANGE` and the edited parts and calls it per column.
 */
const DT2_COLUMNS = pick(16, 256, 256);
const DT2_RANGE: Readonly<Record<(typeof PROFILES)[number], number>> = { default: 1024, large_biomes: 4096 };
const EDITED_TREES = pick(2, 8, 16);
const EDITED_COLUMNS = pick(8, 32, 64);
const EDITED_DRAWS = 64;

/** A DT2 column the edited parts revisit: its chunk and its 16 DT2 voxel indices (`((y + 64) << 8) | p`). */
interface EditedColumn { readonly cx: number; readonly cz: number; readonly voxels: readonly number[] }

interface EditedCounts {
  densityReference: number; surfaceReference: number; densityTrees: number; surfaceTrees: number; draws: number;
  densityVoxels: number; densityCorners: number; densityNonFinite: number; surfaceVoxels: number; surfaceExtraVoxels: number;
}

/**
 * An edited tree of `leaf` (the profile's tree mutated, both tiers accepting the edited params, canonically different
 * from the profile's), or null after EDITED_DRAWS draws.
 */
function editedParams(params: Params, leaf: 'density' | 'surface', next: () => number, counts: EditedCounts): Params | null {
  const base = leaf === 'density' ? params.density.defs : params.surface.rules;
  const text = canonicalJSON(base);
  for (let d = 0; d < EDITED_DRAWS; d++) {
    counts.draws++;
    const m = mutateTree(next, base, leaf === 'density' ? 'density' : 'surfaceRules', { cls: 'preserving', count: 1 + (next() % 3) });
    const r = applyPatch(SCHEMA, params, leaf === 'density' ? { density: { defs: m.value } } : { surface: { rules: m.value } });
    if (!r.ok || validateParamTrees(r.value).length > 0) continue;
    if (canonicalJSON(leaf === 'density' ? r.value.density.defs : r.value.surface.rules) !== text) return r.value;
  }
  return null;
}

/** The edited parts for one profile and seed (see the DT2 comment). */
function editedParts(
  at: string, seed: string, params: Params, columns: readonly EditedColumn[], maxSurfaceDepth: number, rE: Xoshiro128,
  scan: SurfaceScan, counts: EditedCounts, problems: string[],
): void {
  const next = () => rE.nextU32();
  for (let t = 0; t < EDITED_TREES; t++) {
    const pd = editedParams(params, 'density', next, counts);
    if (pd === null) {
      counts.densityReference++;
      problems.push(`${at}: editedDensityReference: no valid edited tree in ${EDITED_DRAWS} draws`);
    } else {
      counts.densityTrees++;
      const ctx: GenContext = createGenContext(seedFromInput(seed), pd);
      const dc = createDensityContext(ctx);
      const ref = createDensityReference(dc.expr, dc.noises);
      const c = dc.compiled;
      const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
      for (const col of columns) {
        const s = dc.column(col.cx, col.cz);
        for (const i of col.voxels) {
          const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
          const x = 16 * col.cx + lx, z = 16 * col.cz + lz;
          const value = probe(dc, x, y, z);
          const rv = ref.voxel(s, x, y, z);
          counts.densityVoxels++;
          if (!Number.isFinite(value) || !Number.isFinite(rv)) counts.densityNonFinite++;
          if (!Object.is(value, rv) || !Number.isFinite(value)) {
            counts.densityReference++;
            problems.push(`${at}, edited density tree ${t}: (${x}, ${y}, ${z}) compiled ${value} ≠ reference ${rv}`);
          }
          const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
          c.cellCorners(ci, ck, cj);
          for (const { inner, slot } of interp) {
            for (let d = 0; d < 8; d++) {
              const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
              const cv = c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!;
              const rc = ref.corner(s, inner, ii, kk, jj);
              counts.densityCorners++;
              if (!Number.isFinite(cv) || !Number.isFinite(rc)) counts.densityNonFinite++;
              if (!Object.is(cv, rc) || !Number.isFinite(cv)) {
                counts.densityReference++;
                problems.push(`${at}, edited density tree ${t}: corner (${ii}, ${kk}, ${jj}) of (${col.cx}, ${col.cz}) compiled ${cv} ≠ reference ${rc}`);
              }
            }
          }
        }
      }
    }
    const ps = editedParams(params, 'surface', next, counts);
    if (ps === null) {
      counts.surfaceReference++;
      problems.push(`${at}: editedSurfaceReference: no valid edited tree in ${EDITED_DRAWS} draws`);
      continue;
    }
    counts.surfaceTrees++;
    const ctx: GenContext = createGenContext(seedFromInput(seed), ps);
    const compiled = surfaceContextOf(ctx).compiled;
    const sc = createSurfaceContext(ctx);
    for (const col of columns) {
      terrainSurfaceDebug(ctx, col.cx, col.cz, scan);
      const check = (p: number, y: number, what: string): boolean => {
        if (y < -63 || runAt(scan, p, y) < 0) return false;
        counts.surfaceVoxels++;
        const cs = compiled.state(scan, p, y);
        const rs = sc.reference.state(scan, sc.settings, p, y);
        if (cs !== rs) {
          counts.surfaceReference++;
          problems.push(`${at}, edited rule tree ${t}: ${what} (${16 * col.cx + (p & 15)}, ${y}, ${16 * col.cz + (p >> 4)}) compiled state ${cs} ≠ reference ${rs}`);
        }
        return true;
      };
      for (const i of col.voxels) check(i & 255, (i >> 8) - 64, 'DT2 voxel');
      for (let k = 0; k < 8; k++) {
        const p = rE.nextInt(256);
        const d = rE.nextInt(maxSurfaceDepth + 1);
        const first = scan.runFirst[p]!;
        if (first < scan.runFirst[p + 1]! && check(p, scan.runTop[first]! - d, `skin voxel depth ${d}`)) counts.surfaceExtraVoxels++;
      }
    }
  }
}

metricTest('DT2', ['probeBulk', 'compiledReference', 'surfaceProbeBulk', 'surfaceReference', 'editedDensityReference', 'editedSurfaceReference'], () => {
  const t0 = performance.now();
  const r = new Xoshiro128(fnv1a32('DT2'));
  const scan = newSurfaceScan();
  const rE = new Xoshiro128(fnv1a32('DT2.edited'));
  const edited: EditedCounts = {
    densityReference: 0, surfaceReference: 0, densityTrees: 0, surfaceTrees: 0, draws: 0,
    densityVoxels: 0, densityCorners: 0, densityNonFinite: 0, surfaceVoxels: 0, surfaceExtraVoxels: 0,
  };
  const acc = newDt2Acc();
  const problems = acc.problems;
  for (const profile of PROFILES) {
    for (const seed of SEEDS) {
      const params = resolveProfile(profile);
      const ctx = createGenContext(seedFromInput(seed), params);
      const editedColumns: EditedColumn[] = [];
      acc.label = `profile ${profile}, seed '${seed}'`;
      const { maxSurfaceDepth } = dt2Setup(ctx, acc.label);
      const R = DT2_RANGE[profile];
      for (let n = 0; n < DT2_COLUMNS; n++) {
        const cx = -R + r.nextInt(2 * R);
        const cz = -R + r.nextInt(2 * R);
        const voxels = dt2Column(ctx, cx, cz, r, acc);
        if (n < EDITED_COLUMNS) editedColumns.push({ cx, cz, voxels });
      }
      editedParts(acc.label, seed, params, editedColumns, maxSurfaceDepth, rE, scan, edited, problems);
    }
  }
  expect.soft(problems.slice(0, 20), `DT2 mismatches (tier ${TIER}), first 20 of ${problems.length}`).toEqual([]);
  return {
    probeBulk: acc.probeBulk, compiledReference: acc.compiledReference, surfaceProbeBulk: acc.surfaceProbeBulk,
    surfaceReference: acc.surfaceReference, voxels: acc.voxels, maskedVoxels: acc.maskedVoxels, cornerValues: acc.corners,
    columns: acc.columns, surfaceVoxels: acc.surfaceVoxels, surfaceExtraVoxels: acc.surfaceExtraVoxels,
    surfaceExtraSkipped: acc.surfaceExtraSkipped,
    editedDensityReference: edited.densityReference, editedSurfaceReference: edited.surfaceReference,
    editedDensityTrees: edited.densityTrees, editedSurfaceTrees: edited.surfaceTrees, editedDraws: edited.draws,
    editedDensityVoxels: edited.densityVoxels, editedDensityCorners: edited.densityCorners, editedDensityNonFinite: edited.densityNonFinite,
    editedSurfaceVoxels: edited.surfaceVoxels, editedSurfaceExtraVoxels: edited.surfaceExtraVoxels,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
});

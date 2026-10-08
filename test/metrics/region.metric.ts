import { expect } from 'vitest';
import { fnv1a32, hash2 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { terrainDensityDebug, terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { surfaceProbe } from '../../src/gen/surface/probe';
import { newSurfaceScan, runAt } from '../../src/gen/surface/scan';
import { fillColumnT } from '../../src/metrics/region';
import { AIR } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { expectGolden } from '../harness/goldens';
import { metricTest } from '../harness/metric';
import { integerEnv } from '../harness/env';
import { dt1WorkerDir, genRegion, type GenRegionOptions, type RegionResult } from '../harness/region';

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
 */
const DT2_COLUMNS = pick(16, 256, 256);
const DT2_VOXELS_PER_COLUMN = 16;
const DT2_RANGE: Readonly<Record<(typeof PROFILES)[number], number>> = { default: 1024, large_biomes: 4096 };

metricTest('DT2', ['probeBulk', 'compiledReference', 'surfaceProbeBulk', 'surfaceReference'], () => {
  const t0 = performance.now();
  const problems: string[] = [];
  const r = new Xoshiro128(fnv1a32('DT2'));
  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  const out = new Float64Array(98304);
  const mask = new Uint8Array(98304);
  const masked = new Int32Array(98304);
  const scan = newSurfaceScan();
  const surfaceSeed = fnv1a32('DT2.surface');
  let probeBulk = 0, compiledReference = 0, voxels = 0, maskedVoxels = 0, corners = 0, columns = 0;
  let surfaceProbeBulk = 0, surfaceReference = 0, surfaceVoxels = 0, surfaceExtraVoxels = 0, surfaceExtraSkipped = 0;
  for (const profile of PROFILES) {
    for (const seed of SEEDS) {
      const ctx = createGenContext(seedFromInput(seed), resolveProfile(profile));
      const dc = createDensityContext(ctx);
      const ref = createDensityReference(dc.expr, dc.noises);
      const c = dc.compiled;
      const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
      // The stage's compiled tree, and a SurfaceContext built apart for the probe and the reference evaluator.
      const compiled = surfaceContextOf(ctx).compiled;
      const sc = createSurfaceContext(ctx);
      if (compiled.fastPath === null) throw new Error(`DT2: profile ${profile}, seed '${seed}': the default tree has no fast path`);
      const maxSurfaceDepth = compiled.fastPath.maxSurfaceDepth;
      const R = DT2_RANGE[profile];
      for (let n = 0; n < DT2_COLUMNS; n++) {
        const cx = -R + r.nextInt(2 * R);
        const cz = -R + r.nextInt(2 * R);
        const at = `profile ${profile}, seed '${seed}', column (${cx}, ${cz})`;
        expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
        const view = store.proto(cx, cz)!;
        terrainDensityDebug(ctx, cx, cz, out, mask);
        let m = 0;
        for (let i = 256; i < 98304; i++) if (mask[i] === 1) masked[m++] = i;
        const s = dc.column(cx, cz);
        terrainSurfaceDebug(ctx, cx, cz, scan);
        columns++;
        /** surfaceReference at column index p, height y: counted when solid on the stage's scan. */
        const checkSurface = (p: number, y: number, what: string): boolean => {
          if (runAt(scan, p, y) < 0) return false;
          surfaceVoxels++;
          const cs = compiled.state(scan, p, y);
          const rs = sc.reference.state(scan, sc.settings, p, y);
          if (cs !== rs) {
            surfaceReference++;
            problems.push(`${at}: ${what} (${16 * cx + (p & 15)}, ${y}, ${16 * cz + (p >> 4)}) compiled state ${cs} ≠ reference ${rs}`);
          }
          return true;
        };
        for (let v = 0; v < DT2_VOXELS_PER_COLUMN; v++) {
          let i: number;
          if (v >= 11) {
            const p = r.nextInt(256);
            const y = Math.min(319, Math.max(-63, view.aux()!.oceanFloorWG[p]! - 1 + r.nextInt(9) - 4));
            i = ((y + 64) << 8) | p;
          } else {
            i = v >= 6 && m > 0 ? masked[r.nextInt(m)]! : 256 + r.nextInt(98304 - 256);
          }
          const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
          const x = 16 * cx + lx, z = 16 * cz + lz;
          const value = probe(dc, x, y, z);
          const block = view.block(lx, y, lz);
          voxels++;
          if ((value > 0) !== (block !== AIR)) {
            probeBulk++;
            problems.push(`${at}: (${x}, ${y}, ${z}) probe ${value}, block ${block}`);
          }
          const surfaceState = surfaceProbe(sc, x, y, z).state;
          if (surfaceState !== block) {
            surfaceProbeBulk++;
            problems.push(`${at}: (${x}, ${y}, ${z}) surfaceProbe state ${surfaceState} ≠ block ${block}`);
          }
          checkSurface(i & 255, y, 'DT2 voxel');
          if (mask[i] === 1) {
            maskedVoxels++;
            if (!Object.is(value, out[i])) {
              probeBulk++;
              problems.push(`${at}: (${x}, ${y}, ${z}) probe ${value} ≠ bulk ${out[i]}`);
            }
          }
          const rv = ref.voxel(s, x, y, z);
          if (!Object.is(value, rv)) {
            compiledReference++;
            problems.push(`${at}: (${x}, ${y}, ${z}) compiled ${value} ≠ reference ${rv}`);
          }
          const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
          c.cellCorners(ci, ck, cj);
          for (const { inner, slot } of interp) {
            for (let d = 0; d < 8; d++) {
              const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
              const cv = c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!;
              const rc = ref.corner(s, inner, ii, kk, jj);
              corners++;
              if (!Object.is(cv, rc)) {
                compiledReference++;
                problems.push(`${at}: corner (${ii}, ${kk}, ${jj}) compiled ${cv} ≠ reference ${rc}`);
              }
            }
          }
        }
        const rSurface = new Xoshiro128(hash2(surfaceSeed, cx, cz));
        for (let k = 0; k < 8; k++) {
          const p = rSurface.nextInt(256);
          const d = rSurface.nextInt(maxSurfaceDepth + 1);
          const first = scan.runFirst[p]!;
          if (first < scan.runFirst[p + 1]! && checkSurface(p, scan.runTop[first]! - d, `skin voxel depth ${d}`)) surfaceExtraVoxels++;
          else surfaceExtraSkipped++;
        }
        store.freeColumn(cx, cz);
      }
    }
  }
  expect.soft(problems.slice(0, 20), `DT2 mismatches (tier ${TIER}), first 20 of ${problems.length}`).toEqual([]);
  return {
    probeBulk, compiledReference, surfaceProbeBulk, surfaceReference, voxels, maskedVoxels, cornerValues: corners, columns,
    surfaceVoxels, surfaceExtraVoxels, surfaceExtraSkipped,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
});

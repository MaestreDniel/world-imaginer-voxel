import { expect } from 'vitest';
import { fnv1a32, hex64 } from '../../src/core/hash';
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
import { caveTagAt } from '../../src/gen/caves/tags';
import { carverCacheOf } from '../../src/gen/caves/carverCache';
import { CARVER_CACHE_PATHS, CARVER_WINDOW_R } from '../../src/core/constants';
import { fillColumnT, genRegionInProcess, regionHash } from '../../src/metrics/region';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import type { JsonValue } from '../../src/core/params/json';
import { terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { newSurfaceScan, runAt, type SurfaceScan } from '../../src/gen/surface/scan';
import { validateParamTrees } from '../../src/gen/trees';
import { expectGolden } from '../harness/goldens';
import { metricTest } from '../harness/metric';
import { integerEnv } from '../harness/env';
import { DT2_VOXELS_PER_COLUMN, dt2Column, dt2Setup, newDt2Acc } from '../harness/dt2';
import { dt1WorkerDir, genRegion, isolatedColumn, type GenRegionOptions, type RegionResult } from '../harness/region';
import { mutateTree } from '../harness/treeMutator';

/**
 * DT1 on the T stage (SP3a spec §6.3; the real T since SP3b), threshold exact (0 mismatches), on every tier:
 * 1. Invariance: per profile (default, large_biomes) and tier seed, five runs of the tier's region give equal region
 *    hashes: spiral / 1 thread / cold, shuffled / 4 threads / cold, a second spiral / 1 thread / cold, and two
 *    `cache: true` runs (shuffled / 4 threads, then spiral / 1 thread), the second of which must be a cache hit.
 * 2. Golden: in the seed '42' cold spiral run of each profile, the hash of the 8 × 8 window at (−4, −4) is
 *    `sp3a.region.T.<profile>` (in `npm run test:goldens` it is recorded as an observation instead, so it must agree
 *    with the unit test's `genRegionInProcess` value).
 * 3. `carverCache` (SP6a spec §10.3, §2.5): per profile and seed, the hash of the 8 × 8 golden window generated as a
 *    region of its own (every tier: T is per column, so it equals that window of the tier's region, and a 32 × 32 run
 *    on 1 thread would add about 20 s per run to the quick tier) with a carver path cache of 1 path
 *    (shuffled / 4 threads, `carverCacheCapacity: 1`; a worker that held more than 1 path also counts), of 1,024
 *    (spiral / 1 thread, `carverCacheCapacity: 1024`) and warm from another region (1 thread in process: one context's
 *    cache asked for every window source of the 48 × 48 columns 1,250 chunks east of the region's corner, column by
 *    column in the window's order, as T asks it, which leaves it full, `CARVER_CACHE_PATHS` paths, else a mismatch;
 *    then the window generated with that context), each against the window of the cold spiral run: mismatches.
 * 4. `isolated` (SP6a spec §10.3): per profile and seed, `ISOLATED` columns of the region drawn by
 *    `Xoshiro128(fnv1a32('DT1.isolated'))`, each generated alone on a fresh store (`isolatedColumn`), against the same
 *    column's window of the cold spiral run: mismatches.
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
/** DT1.carverCache's region on every tier: the golden window. */
const CARVER_REGION = { cx0: GOLDEN_WINDOW[0], cz0: GOLDEN_WINDOW[1], w: GOLDEN_WINDOW[2], h: GOLDEN_WINDOW[3] } as const;
/** DT1.isolated's columns per profile and seed. */
const ISOLATED = pick(4, 8, 16);
/**
 * DT1.carverCache's warm-up region: 48 × 48 columns (about 1,200 paths at the defaults, more than the cache holds) at the
 * tier's region's corner moved this many chunks east (20,000 blocks).
 */
const WARM_SHIFT = 1250;
const WARM_SIDE = 48;

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

/**
 * DT1.carverCache's warm run: a context whose carver cache was asked for every window source of the `WARM_SIDE`²
 * columns `WARM_SHIFT` chunks east of `CARVER_REGION`'s corner (column by column, the window's order: what T asks of
 * it), then `CARVER_REGION` generated in process with it; its hash, and the paths the cache held before it.
 */
function warmRegionHash(seed: string, params: Params): { hash: string; warmSize: number } {
  const ctx = createGenContext(seedFromInput(seed), params);
  const cache = carverCacheOf(ctx);
  const R = CARVER_WINDOW_R;
  const kinds = ['worm', 'ravine', 'undergroundWorm'] as const;
  const { cx0, cz0, w, h } = CARVER_REGION;
  for (let cz = cz0; cz < cz0 + WARM_SIDE; cz++) {
    for (let cx = cx0 + WARM_SHIFT; cx < cx0 + WARM_SHIFT + WARM_SIDE; cx++) {
      for (let sz = cz - R; sz <= cz + R; sz++) for (let sx = cx - R; sx <= cx + R; sx++) for (const k of kinds) cache.path(k, sx, sz);
    }
  }
  const warmSize = cache.size;
  const store = createStore({ shared: false });
  genRegionInProcess(store, ctx, cx0, cz0, w, h);
  return { hash: hex64(regionHash(store, cx0, cz0, w, h)), warmSize };
}

metricTest('DT1', ['mismatches', 'carverCache', 'isolated'], async () => {
  const problems: string[] = [];
  let invariance = 0;
  let golden = 0;
  let firstCacheHits = 0;
  let genMs = 0;
  let carverCache = 0;
  let carverCacheRuns = 0;
  let isolated = 0;
  let isolatedColumns = 0;
  let isolatedMs = 0;
  for (const profile of PROFILES) {
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const at = `profile ${profile}, seed '${seed}', shuffleSeed ${SHUFFLE_SEED}`;
      let ref = '';
      let refView: RegionResult['view'] | null = null;
      for (const [i, run] of RUNS.entries()) {
        const r: RegionResult = await genRegion({
          seed, params, ...REGION, upTo: 'T', order: run.order, threads: run.threads, cache: run.cache,
          shuffleSeed: SHUFFLE_SEED, workerDir: dt1WorkerDir(TIER),
        });
        genMs += r.timings.totalMs;
        const hash = r.view.hash();
        if (i === 0) {
          ref = hash;
          refView = r.view;
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
      // 3. DT1.carverCache: an LRU of 1 and of 1,024, and warm from another region, against the cold default.
      const window = refView!.hash(...GOLDEN_WINDOW);
      for (const [label, capacity, order, threads] of [['LRU 1, shuffled/4', 1, 'shuffled', 4], ['LRU 1024, spiral/1', 1024, 'spiral', 1]] as const) {
        const r = await genRegion({
          seed, params, ...CARVER_REGION, upTo: 'T', order, threads, carverCacheCapacity: capacity, shuffleSeed: SHUFFLE_SEED,
          workerDir: dt1WorkerDir(TIER),
        });
        genMs += r.timings.totalMs;
        carverCacheRuns++;
        const most = Math.max(...r.carverCacheSizes);
        if (r.view.hash() !== window || most > capacity) {
          carverCache++;
          problems.push(`${at}: carverCache ${label}: hash ${r.view.hash()} vs ${window}, the most paths a thread held ${most}`);
        }
      }
      const w0 = performance.now();
      const warm = warmRegionHash(seed, params);
      genMs += performance.now() - w0;
      carverCacheRuns++;
      if (warm.hash !== window || warm.warmSize !== CARVER_CACHE_PATHS) {
        carverCache++;
        problems.push(`${at}: carverCache warm: hash ${warm.hash} vs ${window}, ${warm.warmSize} paths held before the window`);
      }
      // 4. DT1.isolated: columns of the region generated alone on a fresh store.
      const rng = new Xoshiro128(fnv1a32('DT1.isolated'));
      for (let n = 0; n < ISOLATED; n++) {
        const cx = REGION.cx0 + rng.nextInt(REGION.w);
        const cz = REGION.cz0 + rng.nextInt(REGION.h);
        const t0 = performance.now();
        const got = hex64(await isolatedColumn({ seed, params, cx, cz }));
        isolatedMs += performance.now() - t0;
        isolatedColumns++;
        const want = refView!.hash(cx, cz, 1, 1);
        if (got !== want) {
          isolated++;
          problems.push(`${at}: isolated column (${cx}, ${cz}): ${got} vs the region's ${want}`);
        }
      }
    }
  }
  expect.soft(problems, `DT1 mismatches (tier ${TIER}, DT1_SHUFFLE_SEED=${SHUFFLE_SEED})`).toEqual([]);
  return {
    mismatches: invariance + golden, invarianceMismatches: invariance, goldenMismatches: golden,
    firstCacheHits, regions: PROFILES.length * SEEDS.length * RUNS.length, genSeconds: Math.round(genMs) / 1000,
    carverCache, carverCacheRuns, isolated, isolatedColumns, isolatedSeconds: Math.round(isolatedMs) / 1000,
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
 * - `tagProbe` (SP6a spec §10.3, D22; Task 12): voxels whose stored proto tag (the `cave` channel T wrote) differs
 *   from `caveTagAt` (a DensityContext built apart), on every checked voxel of the default tree's DT2 columns (the 16,
 *   plus DT2_STRADDLE voxels of the straddle stratum, cells whose cave interval straddles 0, drawn from their own
 *   stream `Xoshiro128(hash2(fnv1a32('DT2.straddle'), cx, cz))`, so the other parts' draws are unchanged; the stratum's
 *   voxels run every part's checks), and on edited trees (§3.2's fallback): the first EDITED_TAG_COLUMNS of the edited
 *   columns, generated by T in a GenContext of the edited params, at their 16 voxels and their straddle voxels, for
 *   each `treeMutator` density tree above and for one fixed tree, the profile's with the `cheese` and `pillars` taps
 *   muted to −1e6 as `treeMutator` mutes a tap (a single muted family leaves `keep`'s interval straddling 0, so only
 *   the pair decides cells air before their corners where the pre-cave density is positive: the tag's corner branch).
 *   That tree counts 1 more when no checked voxel lies in such a cell (`mutedEarlyAirVoxels` 0: the branch untested).
 * The per-column checks of the first four parts and the default tree's `tagProbe` are `dt2Column` (`test/harness/dt2.ts`,
 * SP3e spec §5.1, D18): this file keeps the profiles, the shared `DT2` stream, `DT2_RANGE` and the edited parts and calls
 * it per column.
 */
const DT2_COLUMNS = pick(16, 256, 256);
const DT2_RANGE: Readonly<Record<(typeof PROFILES)[number], number>> = { default: 1024, large_biomes: 4096 };
const EDITED_TREES = pick(2, 8, 16);
const EDITED_COLUMNS = pick(8, 32, 64);
const EDITED_DRAWS = 64;
/** SP6a (Task 12): the straddle stratum's voxels per DT2 column, and the edited columns `tagProbe` generates per tree. */
const DT2_STRADDLE = 4;
const EDITED_TAG_COLUMNS = pick(4, 8, 16);

/**
 * A DT2 column the edited parts revisit: its chunk, its 16 DT2 voxel indices (`((y + 64) << 8) | p`) and its straddle
 * stratum's (`tagProbe` only).
 */
interface EditedColumn { readonly cx: number; readonly cz: number; readonly voxels: readonly number[]; readonly straddle: readonly number[] }

interface EditedCounts {
  densityReference: number; surfaceReference: number; densityTrees: number; surfaceTrees: number; draws: number;
  densityVoxels: number; densityCorners: number; densityNonFinite: number; surfaceVoxels: number; surfaceExtraVoxels: number;
  tagProbe: number; tagTrees: number; tagVoxels: number; tagNonZero: number; mutedEarlyAirVoxels: number;
}

/** The store the edited trees' `tagProbe` generates its columns in (one at a time, freed after its checks). */
let tagStore: VoxelStore | null = null;
const TAG_IV = new Float64Array(2);

/**
 * `tagProbe` on an edited tree (see the DT2 comment): the first EDITED_TAG_COLUMNS of `columns` generated by T in
 * `ctx`, the stored tag against `caveTagAt` on a DensityContext of `ctx` built apart at each of their voxels. Returns
 * the checked voxels with a stored tag ≠ 0 in a cell the root's interval decides air before its corners.
 */
function editedTagProbe(at: string, ctx: GenContext, columns: readonly EditedColumn[], counts: EditedCounts, problems: string[]): number {
  tagStore ??= createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  const dc = createDensityContext(ctx);
  let earlyAir = 0;
  counts.tagTrees++;
  for (const col of columns.slice(0, EDITED_TAG_COLUMNS)) {
    if (!fillColumnT(tagStore, ctx, col.cx, col.cz, () => false)) throw new Error(`DT2: ${at}: fillColumnT did not complete`);
    const view = tagStore.proto(col.cx, col.cz)!;
    for (const i of [...col.voxels, ...col.straddle]) {
      const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
      const x = 16 * col.cx + lx, z = 16 * col.cz + lz;
      const tag = view.cave(lx, y, lz);
      const want = caveTagAt(dc, x, y, z);
      counts.tagVoxels++;
      if (tag !== 0) {
        counts.tagNonZero++;
        dc.bounds.beginColumn();
        dc.bounds.cellInterval(lx >> 2, (y + 64) >> 3, lz >> 2, TAG_IV, 0);
        if (TAG_IV[1]! < 0) earlyAir++;
      }
      if (tag !== want) {
        counts.tagProbe++;
        problems.push(`${at}: (${x}, ${y}, ${z}) stored tag ${tag} ≠ caveTagAt ${want}`);
      }
    }
    tagStore.freeColumn(col.cx, col.cz);
  }
  return earlyAir;
}

/** `defs` with every tap named in `names` muted to `mute` (a copy). */
function muteTaps(defs: JsonValue, names: readonly string[], mute: number): JsonValue {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    if (o['op'] === 'tap' && names.includes(o['name'] as string)) o['mute'] = mute;
    return o;
  };
  return walk(defs) as JsonValue;
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
      editedTagProbe(`${at}, edited density tree ${t}`, ctx, columns, counts, problems);
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

/** `tagProbe` on the profile's tree with `cheese` and `pillars` muted to −1e6 (see the DT2 comment). */
function mutedTagProbe(at: string, seed: string, params: Params, columns: readonly EditedColumn[], counts: EditedCounts, problems: string[]): void {
  const r = applyPatch(SCHEMA, params, { density: { defs: muteTaps(params.density.defs as JsonValue, ['cheese', 'pillars'], -1e6) } });
  const label = `${at}, cheese and pillars muted`;
  if (!r.ok || validateParamTrees(r.value).length > 0) {
    counts.tagProbe++;
    problems.push(`${label}: the muted tree is refused`);
    return;
  }
  const early = editedTagProbe(label, createGenContext(seedFromInput(seed), r.value), columns, counts, problems);
  counts.mutedEarlyAirVoxels += early;
  if (early === 0) {
    counts.tagProbe++;
    problems.push(`${label}: no checked voxel is tagged in a cell decided air before its corners (the corner branch untested)`);
  }
}

metricTest('DT2', ['probeBulk', 'compiledReference', 'surfaceProbeBulk', 'surfaceReference', 'editedDensityReference', 'editedSurfaceReference', 'tagProbe'], () => {
  const t0 = performance.now();
  const r = new Xoshiro128(fnv1a32('DT2'));
  const scan = newSurfaceScan();
  const rE = new Xoshiro128(fnv1a32('DT2.edited'));
  const edited: EditedCounts = {
    densityReference: 0, surfaceReference: 0, densityTrees: 0, surfaceTrees: 0, draws: 0,
    densityVoxels: 0, densityCorners: 0, densityNonFinite: 0, surfaceVoxels: 0, surfaceExtraVoxels: 0,
    tagProbe: 0, tagTrees: 0, tagVoxels: 0, tagNonZero: 0, mutedEarlyAirVoxels: 0,
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
        const voxels = dt2Column(ctx, cx, cz, r, acc, { straddle: DT2_STRADDLE });
        if (n < EDITED_COLUMNS) editedColumns.push({ cx, cz, voxels: voxels.slice(0, DT2_VOXELS_PER_COLUMN), straddle: voxels.slice(DT2_VOXELS_PER_COLUMN) });
      }
      editedParts(acc.label, seed, params, editedColumns, maxSurfaceDepth, rE, scan, edited, problems);
      mutedTagProbe(acc.label, seed, params, editedColumns, edited, problems);
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
    tagProbe: acc.tagProbe + edited.tagProbe, tagVoxels: acc.tagVoxels, tagNonZero: acc.tagNonZero, straddleVoxels: acc.straddleVoxels,
    editedTagTrees: edited.tagTrees, editedTagVoxels: edited.tagVoxels, editedTagNonZero: edited.tagNonZero,
    mutedEarlyAirVoxels: edited.mutedEarlyAirVoxels,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CARVER_WINDOW_R, CAVE_BIOME_NAMES } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { carverPath, type CarverKind, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { buildColumnSample, newColumnSample, readLevel } from '../../src/gen/column/columnStage';
import { lakeCell, type LakeCell } from '../../src/gen/column/lakes';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext, type GenContext } from '../../src/gen/context';
import {
  abyssRockStraight, aperiodicRatios, BIOME_EXAMPLE_IDS, poolAbyssRockCounts, poolBorderCounts, borderSampleProblems, bandDetail, borderPlaneRatio, BORDER_PAIR_NAMES, C1_C6_PARTS, caveBorderParts, c1c6Parts, C7_C9_PARTS, c7c9Groups, c7c9Parts, caveBottomGroups, caveBottomParts, emptyBandCounts,
  emptyLayerCounts, emptyWallResidues, EXAMPLE_IDS, floorFaceResidues, GRID_H, GRID_Y0, SP6B_EXAMPLE_IDS, verticalStepDetail, worstToBound,
  type C1C6Part, type C7C9Part, type CaveBottomParts, type CaveC7C9Counts, type CavePose, type CaveRegionCounts,
} from '../harness/caveMetrics';
import type { CaveRegionResult } from '../harness/caveRegionWorker';
import { CARVER_DEFAULTS, CARVER_MAXIMA } from '../harness/carverParams';
import { BIOME_REGION, biomeTiles, caveGroupOf, caveSites, firstBiomeTile, measureCaveRegions, type CaveGroup, type Site } from '../harness/caveSites';
import { caveZoneGrid, caveZoneParts, ZONE_CELLS, ZONE_DEPTHS, ZONE_LAGS, ZONE_ORIGIN, ZONE_STEP, type ZoneParts } from '../harness/caveZones';
import { r3PathCounts, r3Paths, r3PoseCounts, r3Poses, r3Region, R3_POSE_COUNTS, type CaveRegion, type R3PathCounts, type R3PoseCounts } from '../harness/cull';
import { metricTest } from '../harness/metric';
import { dt1WorkerDir, genRegion } from '../harness/region';
import { referenceSettle } from '../harness/refs';
import { a2Parts, A5_EXAMPLE_IDS, a5Parts, lakeAirAdjacentCount, lakeSpillCount, WATER_EXAMPLE_IDS, waterParts, type A5Pose } from '../harness/water';
import { THRESHOLDS } from '../thresholds';

/**
 * The caves' metrics (SP6a spec §10.1, D26), over harness regions up to 'T' with the tag read from the store
 * (`RegionView.tag`). The regions per tier, and the preset regions' scan, are `test/harness/caveSites.ts`' (its
 * header).
 *
 * By group (SP6b spec §13 L4; `METRICS_CAVE_GROUPS`, read once: `default`, `presets` or `biomes`, one per CI job; absent,
 * every group in this one process, ruling P2; an unknown name throws). Each part keeps one literal `metricTest` call; a
 * call is registered when a group it reads runs:
 * - the default group (the default and large_biomes regions): C1-C6, and the default-only parts of C7-C9
 *   (`C7.default`: borderPlaneRatio, switchWall; C8; `C9.default`: entrancesMax, thinRoof), with the review poses;
 * - the presets group (the three preset regions): the pure parts and `islandCapAir` (`C7.construction`);
 * - both: `carverReference` (max 0 per region, so the sum over the jobs is the unsplit value), and the per-group parts
 *   of C7-C9 (`C7.tuning`: verticalStep, flatWallShare, waterWall, SP7a's settled population on the regions' interiors;
 *   `C9`: nearestEntrance, holedSurface) and C7's
 *   bottom parts (`C7.bottomPlane`, `C7.bedrockExposed`, `C7.bottom`; SP6b spec §12.3), each the worst of the groups the job measures
 *   (`c7c9Parts`, `caveBottomParts`; ruling P2), so the worst over the jobs is the unsplit value; these read the default
 *   and preset regions only;
 * - the biomes group (SP6b spec §12.2-§12.3, §13; the `caves-biomes` job, Task 27: `cave_heavy`'s regions on quick and
 *   full, and the biome region): none of the C1-C9 calls above (spec §10 and §12.3 name the default and preset groups);
 *   `C1.caveHeavy` (`caveHeavyMin`, `caveHeavyMax`: both `cave_heavy`'s void share, recorded until SP12) with C2 and C9
 *   on `cave_heavy` in `.out/caves.caveHeavy.json`; the biome region's T window re-checked (ruling P33); its review
 *   poses and `cave_heavy`'s spawn in `.out/caveBiomes.examples.json`;
 * - every group: B3's border parts (SP6b spec §12.2; Task 26), per job: each job's own record,
 *   `.out/B3.borders.<group>.json`; gated (`B3.borders`, Task 30) in the groups `B3_BORDERS_GATED` names, each job its
 *   own regions; in `biomes` each biome | plain pair needs 2,000 border faces (an insufficient sample fails, Task 27);
 * - the default and biomes groups: `B3.abyssRockStraight` (§12.2; Task 28), per job over the default regions and the
 *   biome region, `.out/B3.abyssRock.<group>.json`; gated (`B3.abyssRock`, Task 30) in the groups
 *   `B3_ABYSS_ROCK_GATED` names;
 * - the biomes group (Task 28): B3's regular-grid check (§12.2, pure, `test/harness/caveZones.ts`) in
 *   `.out/B3.zoneGrid.json`, its zone part gated (`B3.zones`: `zonePeriodicDip`, Task 30, ruling U4), and
 *   `cave_heavy`'s per-biome cave-air shares over its regions (§12.1) in `.out/B3.caveHeavy.json`;
 * - the biomes group (Task 39): R3 (SP6b spec §12.4, D22), cave culling's walk against the raycast reference over the
 *   job's regions (`cave_heavy`'s on quick and full, and the biome region), read again from their cached dumps
 *   (`r3Region`, `test/harness/cull.ts`): `R3.wronglyCulled` over `r3Poses`' poses, `R3.popIn` over `r3Paths`' five
 *   paths on the biome region, `R3.culledUnderground` pooled over the underground poses (gated from D25's culling
 *   checkpoint, Task 40), with the per-pose record in `.out/R3.poses.json`;
 * - every group (SP7a spec §13.1-§13.2, D30; Task 22): each region read after the global settle reference over its T
 *   (`caveRegionWorker.ts`' `settleRegion`), the A parts on its interior (`test/harness/water.ts`): A1, A3 and A4 per job
 *   in `.out/A.<group>.json` (recorded until the tuning), `A3.aquiferLavaAbove10` gated from this commit (0 by
 *   construction), `C7.waterWallAny` (SP6a's waterWall count) per job in `.out/C7.waterWallAny.<group>.json`, and
 *   SP7a's review poses at seed '42' in `.out/sp7a.examples.<group>.json` (rulings P22: one record per job, Task 24 adds
 *   its poses to it); A2 by origin (sky-open, aquifer, spring) with the water/lava contacts apart per job in
 *   `.out/A2.<group>.json` (Task 23, recorded until the tuning; the contacts also leave `C7.waterWall`'s population);
 *   A5, the springs and their falls (Task 24; SP7a Spec correction 11: each part per job over the job's own regions of
 *   its role), per job in `.out/A5.<group>.json` (recorded until the tuning), `A5.abyssWater` gated from that commit (0
 *   by construction), and A5's review poses added to the job's `.out/sp7a.examples.<group>.json` (the nearest
 *   `islandFall`, `lavaFall`, `lavaPool` and `spillSlope`, and every `waterfall` and `truncated` candidate by distance);
 *   at the tuning (Task 31) A1's `dryShare`, A2's two parts, A3's `lavaBelow54`, `lavaSupported`, `lavaSkyRegions`
 *   (`.out/A3.tuning.json`) and A4's `aquiferBodies` gated per job, the worst of its groups, and `A5.springsTruncated`
 *   (`.out/A5.springs.json`) and `A5.islandFalls` in the groups their literals name (`A5.waterfalls` reads its own
 *   steep-land sample, `test/metrics/waterfalls.metric.ts`); from the user's round-2 decisions (rulings R24, Task 31c)
 *   `A5.lavaFalls` (`.out/A5.lavaFalls.json`) and `A5.borderRatio` (`.out/A5.borderRatio.json`) likewise, and
 *   `C7.waterWall` recorded, not gated (its row `activeFrom` 'SP7b': SP7b owns its definition and bound), its fronts
 *   listed for the user's in-world review in the job's `.out/sp7a.examples.<group>.json` (`wallFronts`, §13.9, Task 47).
 * - the biomes group (SP7a Task 55b, §14's lever (2); rulings P53): B5's lake windows, moved from `region.metric.ts`
 *   (they read none of the group's regions; `.out/B5.lake.json`, at the end of this file).
 *
 * C7's construction parts (D26: hold by construction, gated from this commit, max 0):
 * - `carverReference`: over every region of the run's groups (the preset regions included), the voxels of the region
 *   whose carver kind in the store (the tag when it is a carver's, 6-8, else 0) differs from `referenceCarve`'s, the
 *   global reference that carves every path whose box meets the region with no per-column window. The reference has no border
 *   (it reads only the region's own columns), so every voxel of the region is interior and counted;
 * - `reachOverflow`: pure, no terrain. 100,000 source chunks per kind, drawn by `Xoshiro128(fnv1a32('C7.sources'))` in
 *   [−65,536, 65,536)², each source's path (the chance leaves at 1: the roll is a source's first draw, so a path does
 *   not depend on its chance, which only decides whether the source has one) at the defaults, at the static maxima
 *   (`CARVER_MAXIMA`) and at the straightest paths (the maxima with no turning and no branch, which reach the window's
 *   outermost ring, so a smaller R fails; Task 25's unit case): the paths whose voxel reach (`box`, already each
 *   ellipsoid's centre widened by its own rh and rv) leaves the chunks within `CARVER_WINDOW_R` of the source chunk, or
 *   that hold a value that is not finite in `ell`, `box` or `widthSq` (ruling P17);
 * - `endTaper`: pure. The same 100,000 sources per kind at the defaults (chances at 1): the path ends whose last
 *   ellipsoid's rh or rv is larger than that of any of the up to 4 ellipsoids before it on its segment, or than the
 *   path's median over its step ellipsoids. A path's segments are read from `ell`'s layout (`carvers.ts` rule 6): a
 *   room is the first ellipsoid, at the first step's centre; a branching worm's trunk ends at its fork, and two
 *   branches of equal length follow, each starting at the fork's centre. The start room and the branch points (the
 *   trunk's end when it branches, each branch's start) are not ends (Spec correction 17); a layout that reads otherwise
 *   counts as a failing end;
 * - `islandCapAir`: the tagged (cave) voxels at y ≥ 176 in the floating_islands regions (quick and full; on fast,
 *   which has no such region, NaN, which its tiers accept).
 * Recorded beside the parts: the regions measured, the carver-tagged voxels they hold, the paths and ends checked, and
 * the floating_islands region's island voxels (non-air at y ≥ 181, so the cap has islands to protect).
 *
 * C1-C6 (D26: tuning parts, gated from Task 38 at their bounds, `test/thresholds.ts`): the tests 'C1' … 'C6' below,
 * over the default regions only (the default and large_biomes profiles), with the instruments of
 * `test/harness/caveMetrics.ts`.
 *
 * C7's tuning parts, C8 and C9 (D26: gated from Task 38): the 'C7' tests `C7.tuning` and `C7.default`, 'C8', and the
 * 'C9' tests `C9` and `C9.default`, over every region of the run's groups (the default group: default and
 * large_biomes; and each preset's), with the definitions as built in `caveMetrics.ts`; with the default group their
 * measurement also writes `.out/caves.examples.json`, the review poses at seed '42' (§10.1, §10.10, D16).
 * `C8.largeShare` is recorded, not gated (ruling R21). Each region is measured once for every test, C7's construction
 * counts included (`measureRegions`: one grid, one set of components; SP6b spec §13 L6: per region in 4 worker threads,
 * `test/harness/caveRegionWorker.ts`, with `regionCounts` against `referenceCarve` there, ruling P6), and this thread
 * pools each group of parts once (`carvers`, `c1c6`, `c7c9`: the first test to ask takes it).
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

/** The run's group (`METRICS_CAVE_GROUPS`; null: every group, ruling P2), read once. */
const GROUP = caveGroupOf(process.env.METRICS_CAVE_GROUPS);
/** Whether the run measures the default group (C1-C6, the default-only parts and the poses). */
const DEFAULT_GROUP = GROUP === null || GROUP === 'default';
/** Whether the run measures the presets group (the pure parts and `islandCapAir`). */
const PRESETS_GROUP = GROUP === null || GROUP === 'presets';
/** Whether the run measures the default or the presets group (the C1-C9 calls; the biomes group registers none). */
const C1_C9_GROUPS = GROUP !== 'biomes';
/** Whether the run measures the biomes group (`C1.caveHeavy`, C2 and C9 on `cave_heavy`, the biome region). */
const BIOMES_GROUP = GROUP === null || GROUP === 'biomes';

let sitesMemo: Site[] | null = null;
/** Every region of the run's groups: the default regions, then the preset regions, then the biomes group's. */
const sites = (): Site[] => (sitesMemo ??= caveSites(TIER, GROUP));

// ---------------------------------------------------------------- the pure parts

const KINDS: readonly CarverKind[] = ['worm', 'ravine', 'undergroundWorm'];
const SOURCES = 100_000;
const SOURCE_SPAN = 65_536;
const WORLD_SEED = seedFromInput('42');

/** `SOURCES` source chunks in [−65,536, 65,536)², the same for every kind and case. */
function sourceChunks(): Int32Array {
  const rng = new Xoshiro128(fnv1a32('C7.sources'));
  const out = new Int32Array(2 * SOURCES);
  for (let i = 0; i < out.length; i++) out[i] = rng.nextInt(2 * SOURCE_SPAN) - SOURCE_SPAN;
  return out;
}

/** `p` with the three chances at 1: every source has its path. */
function always(p: CarverParams): CarverParams {
  return {
    ...p,
    worms: { ...p.worms, chance: 1 },
    undergroundWorms: { ...p.undergroundWorms, chance: 1 },
    ravines: { ...p.ravines, chance: 1 },
  };
}

/** The maxima with no turning and no branch: each path runs straight and level (Task 25's straightest case). */
const STRAIGHT: CarverParams = {
  ...CARVER_MAXIMA,
  worms: {
    ...CARVER_MAXIMA.worms, branchChance: 0, lengthVar: 0,
    shape: { ...CARVER_MAXIMA.worms.shape, pitchKeep: 0, yawStep: 0, pitchStep: 0 },
  },
  ravines: { ...CARVER_MAXIMA.ravines, vRotation: 0 },
};

const finite = (a: Float64Array | null): boolean => {
  if (a === null) return true;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
};

/** Paths whose box leaves the chunks within R of the source chunk, or with a value that is not finite. */
function reachOverflow(src: Int32Array): { overflow: number; paths: number; deepest: number; examples: string[] } {
  const R = CARVER_WINDOW_R;
  let overflow = 0;
  let paths = 0;
  let deepest = 0;
  const examples: string[] = [];
  for (const [name, p] of [['defaults', CARVER_DEFAULTS], ['maxima', CARVER_MAXIMA], ['straightest', STRAIGHT]] as const) {
    const q = always(p);
    for (const kind of KINDS) {
      for (let i = 0; i < SOURCES; i++) {
        const sx = src[2 * i]!;
        const sz = src[2 * i + 1]!;
        const path = carverPath(WORLD_SEED, kind, sx, sz, q);
        if (path === null) continue;
        paths++;
        const b = path.box;
        const inside = b[0]! >= 16 * (sx - R) && b[3]! <= 16 * (sx + R + 1) && b[2]! >= 16 * (sz - R) && b[5]! <= 16 * (sz + R + 1);
        if (!inside || !finite(path.ell) || !finite(path.box) || !finite(path.widthSq)) {
          overflow++;
          if (examples.length < 10) examples.push(`${name} ${kind} (${sx}, ${sz}) box ${Array.from(b).join(', ')}`);
          continue;
        }
        deepest = Math.max(deepest, 16 * sx + 16 - b[0]!, b[3]! - 16 * sx, 16 * sz + 16 - b[2]!, b[5]! - 16 * sz);
      }
    }
  }
  return { overflow, paths, deepest, examples };
}

/** Whether ellipsoids i and j of `path` share their centre. */
function sameCentre(path: CarverPath, i: number, j: number): boolean {
  const e = path.ell;
  return e[6 * i] === e[6 * j] && e[6 * i + 1] === e[6 * j + 1] && e[6 * i + 2] === e[6 * j + 2];
}

/**
 * A path's segments as [from, to) ellipsoid ranges, the room excluded: the trunk alone, or the trunk then its two
 * branches; null when `ell` does not read as `carvers.ts`' layout.
 */
function segmentsOf(path: CarverPath): Array<[number, number]> | null {
  const n = path.count;
  // A room is the first ellipsoid at the first step's centre (consecutive steps move one block, so never share one).
  const r = path.kind !== 'ravine' && n >= 2 && sameCentre(path, 0, 1) ? 1 : 0;
  let fork = -1;
  for (let j = r; j + 1 < n; j++) {
    if (sameCentre(path, j, j + 1)) {
      fork = j;
      break;
    }
  }
  if (fork < 0) return [[r, n]];
  const rest = n - (fork + 1);
  if (path.kind === 'ravine' || rest % 2 !== 0) return null;
  const b = rest / 2;
  if (!sameCentre(path, fork, fork + 1 + b)) return null;
  return [[r, fork + 1], [fork + 1, fork + 1 + b], [fork + 1 + b, n]];
}

function median(values: Float64Array): number {
  const s = values.slice().sort();
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Path ends that are not tapered (§10.1's `endTaper`; the start room and the branch points excluded). */
function endTaper(src: Int32Array): { bad: number; ends: number; rooms: number; branched: number; examples: string[] } {
  const q = always(CARVER_DEFAULTS);
  let bad = 0;
  let ends = 0;
  let rooms = 0;
  let branched = 0;
  const examples: string[] = [];
  for (const kind of KINDS) {
    for (let i = 0; i < SOURCES; i++) {
      const sx = src[2 * i]!;
      const sz = src[2 * i + 1]!;
      const path = carverPath(WORLD_SEED, kind, sx, sz, q)!;
      const segs = segmentsOf(path);
      if (segs === null) {
        bad++;
        if (examples.length < 10) examples.push(`${kind} (${sx}, ${sz}): ell does not read as a trunk and two branches`);
        continue;
      }
      if (segs[0]![0] === 1) rooms++;
      if (segs.length === 3) branched++;
      const first = segs[0]![0];
      for (const col of [3, 4]) {
        const steps = new Float64Array(path.count - first);
        for (let k = first; k < path.count; k++) steps[k - first] = path.ell[6 * k + col]!;
        const med = median(steps);
        /** The end `end` against the up to 4 ellipsoids of [from, to) next to it inward (`dir`) and the median. */
        const check = (end: number, from: number, to: number, dir: 1 | -1): void => {
          ends++;
          const v = path.ell[6 * end + col]!;
          let tapered = v <= med;
          for (let k = 1; k <= 4 && tapered; k++) {
            const j = end + dir * k;
            if (j >= from && j < to && v > path.ell[6 * j + col]!) tapered = false;
          }
          if (!tapered) {
            bad++;
            if (examples.length < 10) examples.push(`${kind} (${sx}, ${sz}) end ${end} col ${col}`);
          }
        };
        const [t0, t1] = segs[0]!;
        check(t0, t0, t1, 1);
        if (segs.length === 1) check(t1 - 1, t0, t1, -1);
        for (const [b0, b1] of segs.slice(1)) check(b1 - 1, b0, b1, -1);
      }
    }
  }
  return { bad, ends, rooms, branched, examples };
}

// ---------------------------------------------------------------- the region parts

/** The region parts of C7's construction over the run's regions: `carverReference`'s counts and the island cap's. */
interface CarverCounts { readonly regions: number; readonly mismatches: number; readonly carved: number; readonly capAir: number; readonly islandVoxels: number }

async function measureCarvers(): Promise<CarverCounts> {
  let mismatches = 0;
  let carved = 0;
  let capAir = Number.NaN;
  let islandVoxels = Number.NaN;
  const all = await c1c9Regions();
  for (const { site: s, carver } of all) {
    const c = carver!;
    const island = s.profile === 'floating_islands';
    expect(c.examples, `C7.carverReference at ${s.label}`).toEqual([]);
    // Each region holds carved voxels, so the comparison is not vacuous.
    expect(c.carved, `carver-tagged voxels at ${s.label}`).toBeGreaterThan(0);
    mismatches += c.mismatches;
    carved += c.carved;
    if (island) {
      // Summed over the floating_islands regions (one per preset seed).
      capAir = (Number.isNaN(capAir) ? 0 : capAir) + c.capAir;
      islandVoxels = (Number.isNaN(islandVoxels) ? 0 : islandVoxels) + c.islandVoxels;
      expect(c.islandVoxels, `the floating_islands region at ${s.label} holds no island voxels`).toBeGreaterThan(0);
    }
  }
  return { regions: all.length, mismatches, carved, capAir, islandVoxels };
}

let carverRun: Promise<CarverCounts> | null = null;
/** The region parts of C7's construction, measured once (the first test to ask). */
const carvers = (): Promise<CarverCounts> => (carverRun ??= measureCarvers());

// `carverReference` over the run's default and preset regions (max 0 per region, so the jobs' sum is the unsplit value).
// The first test: it measures every region (its timeout covers them).
if (C1_C9_GROUPS) {
  metricTest('C7', ['carverReference'], async () => {
    const c = await carvers();
    return { carverReference: c.mismatches, regions: c.regions, carverVoxels: c.carved };
  }, 900_000);
}

// The pure parts and the island cap, with the presets group (or every group).
if (PRESETS_GROUP) {
  metricTest('C7', ['reachOverflow', 'endTaper', 'islandCapAir'], async () => {
    const src = sourceChunks();
    const reach = reachOverflow(src);
    expect(reach.examples, 'C7.reachOverflow').toEqual([]);
    // Every source of the three cases has its path (the chances at 1): 3 cases × 3 kinds × 100,000.
    expect(reach.paths).toBe(9 * SOURCES);
    // The straightest paths reach into the window's outermost ring of chunks, so a window of R − 1 would fail.
    expect(reach.deepest).toBeGreaterThan(16 * CARVER_WINDOW_R);
    const taper = endTaper(src);
    expect(taper.examples, 'C7.endTaper').toEqual([]);
    // The defaults' room and branch chances (0.25 each) put rooms and branches among the worms' 200,000 paths.
    expect(taper.rooms).toBeGreaterThan(20_000);
    expect(taper.branched).toBeGreaterThan(20_000);
    const c = await carvers();
    return {
      reachOverflow: reach.overflow, endTaper: taper.bad, islandCapAir: c.capAir,
      reachPaths: reach.paths, reachDeepest: reach.deepest, taperEnds: taper.ends, taperRooms: taper.rooms,
      taperBranched: taper.branched, islandVoxels: c.islandVoxels,
    };
  }, 600_000, { outName: 'C7.construction' });
}

// ---------------------------------------------------------------- C1-C9, the tuning parts (D26)

const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));

/** C7.switchWall's chunk stride: the T of every 2nd chunk's columns in x and z on fast, every 4th on quick and full. */
const SWITCH_STRIDE = pick(2, 4, 4);

/**
 * One region's measurements (`caveRegionWorker.ts`' `CaveRegionResult`): C1-C6 (the default group only), C7-C9, at
 * seed '42' default the review poses, and C7's construction counts.
 */
interface Measured extends CaveRegionResult {
  readonly site: Site;
}

/** The group of C7-C9's "default and presets": 'default' for the default and large_biomes profiles, else the preset. */
const groupOf = (s: Site): string => (s.profile === 'default' || s.profile === 'large_biomes' ? 'default' : s.profile);

/**
 * Every region of the run's groups measured once (SP6b spec §13 L6): per region in 4 worker threads
 * (`measureCaveRegions`, `test/harness/caveSites.ts`), each reading the store this thread filled from the region's
 * cached dump (or generated and dumped); this thread pools (`measureCarvers`, `measureC1C6`, `measureC7C9`).
 */
async function measureRegions(): Promise<Measured[]> {
  const all = sites();
  const results = await measureCaveRegions(all, {
    stride: SWITCH_STRIDE, regionWorkerDir: `cavesRegionWorker-${TIER}`, workerDir: `cavesMeasureWorker-${TIER}`,
  });
  return all.map((site, k) => ({ site, ...results[k]! }));
}

let measuredRun: Promise<Measured[]> | null = null;
/** The run's regions, measured once (the first test to ask). */
const measuredRegions = (): Promise<Measured[]> => (measuredRun ??= measureRegions());
/** The run's default and preset regions (C1-C9's; the biomes group's are B3's and its own parts'). */
const c1c9Regions = async (): Promise<Measured[]> => (await measuredRegions()).filter((m) => m.site.group !== 'biomes');

/** JSON with every non-finite number written as its string ("NaN"). */
const json = (v: unknown): string => `${JSON.stringify(v, (_, x: unknown) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x), 2)}\n`;

/**
 * The parts allowed NaN on fast (ruling P32: an empty or undefined population is NaN, never ±Infinity): none. Fast's
 * two 16 × 16 default regions at seed '42' give every part a population (Task 31's run). Quick and full assert every
 * part finite; fast asserts each finite or listed here, and the record names the NaN parts (`nanParts`).
 */
const NAN_ON_FAST: readonly string[] = [];

/**
 * C1-C6 (SP6a spec §10.1, D26: tuning parts, gated from Task 38): measured over the tier's default regions (default and
 * large_biomes; C1 per profile) by `test/harness/caveMetrics.ts`, whose header states each definition as built, and
 * written to `.out/caves.C1-C6.json`: the parts, the value per profile, the bands' and the floor faces' residues per
 * profile, C5.thinnest's components per value, and per region its counts' summary. Every part is finite (fast: or listed in `NAN_ON_FAST`).
 */
async function measureC1C6(): Promise<Record<C1C6Part, number>> {
  const measured: Array<{ site: Site; counts: CaveRegionCounts; ms: number }> = (await measuredRegions())
    .filter((m) => m.site.group === 'default')
    .map((m) => ({ site: m.site, counts: m.c16!, ms: m.ms.shared + m.ms.c16 }));
  const parts = c1c6Parts(measured.map((m) => ({ profile: m.site.profile, counts: m.counts })));
  const profiles = [...new Set(measured.map((m) => m.site.profile))];
  const perProfile = Object.fromEntries(profiles.map((p) => [p, c1c6Parts(measured.filter((m) => m.site.profile === p).map((m) => ({ profile: p, counts: m.counts })))]));
  const nan = C1_C6_PARTS.filter((p) => Number.isNaN(parts[p]));
  // Per profile, the bands' carve rates and residue ratios behind C4.bands and C6.latticeBias, and the floor faces'
  // residues behind C6.floorFaceLattice.
  const bandSums = new Map(profiles.map((p) => {
    const sum = emptyBandCounts();
    for (const m of measured) {
      if (m.site.profile !== p) continue;
      for (const k of Object.keys(sum) as Array<keyof typeof sum>) for (let i = 0; i < sum[k].length; i++) sum[k][i]! += m.counts.bands[k][i]!;
    }
    return [p, sum];
  }));
  const bands = Object.fromEntries([...bandSums].map(([p, sum]) => [p, bandDetail(sum)]));
  const floorFaces = Object.fromEntries([...bandSums].map(([p, sum]) => [p, floorFaceResidues(sum)]));
  const regions = measured.map(({ site, counts: c, ms }) => ({
    label: site.label, profile: site.profile, ms,
    ...c1c6Parts([{ profile: site.profile, counts: c }]),
    tagged: c.kinds.reduce((a, k) => a + k, 0), components: c.components, skyComponentsAll: c.skyComponents,
    tiles: c.pillars.tiles, tilesWithPillar: c.pillars.withPillar, ravineSources: c.ravines.sources,
    ravineSkySources: c.ravines.skySources, ravineVoxels: c.ravines.voxels, landPositions: c.land.land,
    thinnestComponents: c.thinnest.all.length, notNoodleComponents: c.thinnest.notNoodle.length, cheeseComponents: c.thinnest.cheese.length,
    spaghetti3dComponents: c.thinnest.spaghetti3d.length,
  }));
  // C5.thinnest's population: how many components ≥ 64 voxels read each thinnest axis, pooled over the regions (all of
  // them, recorded; those not mostly noodle, which the part reads, ruling R32; mostly cheese; mostly spaghetti 3D).
  const histOf = (pick: (t: CaveRegionCounts['thinnest']) => number[]): Record<string, number> => {
    const hist: Record<string, number> = {};
    for (const m of measured) for (const v of pick(m.counts.thinnest)) hist[String(v)] = (hist[String(v)] ?? 0) + 1;
    return hist;
  };
  const thinnest = { all: histOf((t) => t.all), notNoodle: histOf((t) => t.notNoodle), cheese: histOf((t) => t.cheese), spaghetti3d: histOf((t) => t.spaghetti3d) };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'caves.C1-C6.json'), json({
    id: 'C1-C6', tier: process.env.METRICS_TIER ?? null, values: parts, nanParts: nan, perProfile, bands, floorFaces, thinnest, regions,
  }));
  for (const p of C1_C6_PARTS) {
    const v = parts[p];
    if (TIER === 'fast' && Number.isNaN(v)) expect(NAN_ON_FAST, `${p} is NaN on fast`).toContain(p);
    else expect(Number.isFinite(v), `${p} = ${v} is not finite`).toBe(true);
  }
  return parts;
}

let c16Run: Promise<Record<C1C6Part, number>> | null = null;
/** C1-C6's parts, measured once (the first test to ask). */
const c1c6 = (): Promise<Record<C1C6Part, number>> => (c16Run ??= measureC1C6());

/**
 * The C7-C9 parts allowed NaN on fast (ruling P32): C8.aperiodicity, C8.sizeSpread and C8.largeShare read only 32 × 32
 * regions (fast's are 16 × 16: largeShare is undefined there, and the other two are kept to the spec's region size so
 * that their values do not move with the tier's region; Task 38 gates the three on quick and full).
 */
const C79_NAN_ON_FAST: readonly string[] = ['C8.aperiodicity', 'C8.sizeSpread', 'C8.largeShare'];

/**
 * C7's and C9's per-group parts (each the worst of the groups measured, `c7c9Parts`), in every group's job (C7.waterWall
 * recorded there, not gated: its row is SP7b's, rulings R24 item 1).
 */
const PER_GROUP_C7: readonly string[] = ['verticalStep', 'flatWallShare', 'waterWall'];
const PER_GROUP_C9: readonly string[] = ['nearestEntrance', 'holedSurface'];
/** The C7-C9 parts this run gates: every one with the default group, else the per-group parts alone. */
const C79_GATED: readonly C7C9Part[] = C7_C9_PARTS.filter((p) => DEFAULT_GROUP
  || PER_GROUP_C7.map((k) => `C7.${k}`).includes(p) || PER_GROUP_C9.map((k) => `C9.${k}`).includes(p));

/**
 * C7's tuning parts, C8 and C9 (SP6a spec §10.1, D26: gated from Task 38): measured over every region of the run's
 * groups by `caveC7C9Counts` (definitions as built in `test/harness/caveMetrics.ts`) and written to
 * `.out/caves.C7-C9.json` (the parts, the per-group values of the "default and presets" parts, each part's detail, and
 * per region its counts' summary). With the default group, the review poses at seed '42' (§10.1, §10.10, D16) go to
 * `.out/caves.examples.json`: per pose, the first of the tier's seed '42' default regions (in `defaultSites`' order)
 * holding one; SP6b's (`SP6B_EXAMPLE_IDS`: `bottomCavern`, SP6b spec §12.3; rulings P17, P59) beside `poses` as
 * top-level fields, chosen alike. Every part the run gates (`C79_GATED`) is finite (fast: or listed in
 * `C79_NAN_ON_FAST`), and with the default group every pose found.
 */
async function measureC7C9(): Promise<Record<C7C9Part, number>> {
  const measured = await c1c9Regions();
  const regions = measured.map((m) => ({ group: groupOf(m.site), full: m.site.size === 32, counts: m.c79 }));
  const parts = c7c9Parts(regions);
  const nan = C7_C9_PARTS.filter((p) => Number.isNaN(parts[p]));
  const def = measured.filter((m) => groupOf(m.site) === 'default').map((m) => m.c79);
  const full = measured.filter((m) => groupOf(m.site) === 'default' && m.site.size === 32).map((m) => m.c79);
  const residues = emptyWallResidues();
  for (const r of def) for (let k = 0; k < 32; k++) { residues.faces[k]! += r.residues.faces[k]!; residues.slots[k]! += r.residues.slots[k]!; }
  const sw = def.map((r) => r.switchWall).filter((v) => v !== null);
  const groups = [...new Set(regions.map((r) => r.group))];
  const ofGroup = (g: string): CaveC7C9Counts[] => regions.filter((r) => r.group === g).map((r) => r.counts);
  // Per group: where its vertical step lies, and its flat walls per orientation and the layers holding most flat
  // floors and ceilings (and the share of them on the density cells' corner layers, y ≡ 0 mod 8).
  const perGroup = Object.fromEntries(groups.map((g) => {
    const rs = ofGroup(g);
    const layers = emptyLayerCounts();
    for (const r of rs) for (let k = 0; k < GRID_H; k++) { layers.voxels[k]! += r.layers.voxels[k]!; layers.tagged[k]! += r.layers.tagged[k]!; }
    const facesBy = [0, 0, 0, 0, 0, 0];
    const flatBy = [0, 0, 0, 0, 0, 0];
    const flatY = new Float64Array(GRID_H);
    for (const r of rs) {
      for (let o = 0; o < 6; o++) { facesBy[o]! += r.flat.facesBy[o]!; flatBy[o]! += r.flat.flatBy[o]!; }
      for (let k = 0; k < GRID_H; k++) flatY[k]! += r.flat.flatFloorsByY[k]! + r.flat.flatCeilingsByY[k]!;
    }
    let horizontal = 0;
    let corner = 0;
    for (let k = 0; k < GRID_H; k++) {
      horizontal += flatY[k]!;
      if ((k + GRID_Y0) % 8 === 0) corner += flatY[k]!;
    }
    const topLayers = Array.from(flatY, (v, k) => [k + GRID_Y0, v] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return [g, {
      verticalStep: verticalStepDetail(layers),
      flatWalls: { facesBy, flatBy, horizontalFlatOnCornerLayers: horizontal === 0 ? Number.NaN : corner / horizontal, topLayers },
    }];
  }));
  const detail = {
    perGroup,
    borderPlaneRatio: { ...borderPlaneRatio(residues), wallsPerResidue: Array.from(residues.faces) },
    switchWall: {
      faces: sw.reduce((a, v) => a + v.faces, 0), shellFaces: sw.reduce((a, v) => a + v.shellFaces, 0),
      voxels: sw.reduce((a, v) => a + v.voxels, 0), shellVoxels: sw.reduce((a, v) => a + v.shellVoxels, 0), stride: SWITCH_STRIDE,
    },
    aperiodicity: full.length === 0 ? [] : aperiodicRatios(full.flatMap((r) => r.lags)),
    typeMixPairs: def.reduce((a, r) => a + r.mix.length, 0),
    sizeSpreadComponents: full.reduce((a, r) => a + r.volumes.length, 0),
    largeShareRegions: full.map((r) => r.largest),
    entranceSamples: measured.reduce((a, m) => a + m.c79.distances.length, 0),
    entranceSamplesWithoutOpening: measured.reduce((a, m) => a + m.c79.distances.filter(Number.isNaN).length, 0),
  };
  const perRegion = measured.map((m) => ({
    label: m.site.label, group: groupOf(m.site), ms: m.ms,
    ...c7c9Parts([{ group: 'default', full: m.site.size === 32, counts: m.c79 }]),
    walls: m.c79.flat.faces, flatWalls: m.c79.flat.flat, waterWall: m.c79.waterWall, waterWallKm2: m.c79.waterWallKm2,
    waterWallAny: m.c79.waterWallAny, deepSky: m.c79.deepSky, entrances: m.c79.entrances,
    openings: m.c79.openings, land: m.c79.surface.land, holed: m.c79.surface.holed, thinRoof: m.c79.surface.thinRoof,
    entranceSamples: m.c79.distances.length, largestComponent: m.c79.largest,
  }));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'caves.C7-C9.json'), json({
    id: 'C7-C9', tier: process.env.METRICS_TIER ?? null, values: parts, nanParts: nan, groups: c7c9Groups(regions), detail,
    regions: perRegion,
  }));
  for (const p of C79_GATED) {
    const v = parts[p];
    if (TIER === 'fast' && Number.isNaN(v)) expect(C79_NAN_ON_FAST, `${p} is NaN on fast`).toContain(p);
    else expect(Number.isFinite(v), `${p} = ${v} is not finite`).toBe(true);
  }
  if (DEFAULT_GROUP) {
    // The review poses: per id the first seed '42' default region holding one.
    const poses: Record<string, (CavePose & { region: string }) | null> = {};
    for (const id of EXAMPLE_IDS) {
      const m = measured.find((r) => r.examples !== null && r.examples[id] !== null);
      poses[id] = m === undefined ? null : { ...m.examples![id]!, region: m.site.label };
    }
    const sp6b: Record<string, (CavePose & { region: string }) | null> = {};
    for (const id of SP6B_EXAMPLE_IDS) {
      const m = measured.find((r) => r.sp6bExamples !== null && r.sp6bExamples[id] !== null);
      sp6b[id] = m === undefined ? null : { ...m.sp6bExamples![id]!, region: m.site.label };
    }
    writeFileSync(join(OUT_DIR, 'caves.examples.json'), json({
      id: 'caves.examples', tier: process.env.METRICS_TIER ?? null, seed: '42', profile: 'default', poses, ...sp6b,
    }));
    for (const id of EXAMPLE_IDS) expect(poses[id], `the ${id} pose`).not.toBeNull();
    for (const id of SP6B_EXAMPLE_IDS) expect(sp6b[id], `the ${id} pose`).not.toBeNull();
  }
  return parts;
}

let c79Run: Promise<Record<C7C9Part, number>> | null = null;
/** C7's tuning parts, C8 and C9, measured once (the first test to ask). */
const c7c9 = (): Promise<Record<C7C9Part, number>> => (c79Run ??= measureC7C9());

/** The parts of metric `id` among `parts` ('C3.pillars' → 'pillars'), or only `names` of them. */
function partsOf(parts: Readonly<Record<string, number>>, id: string, names?: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parts)) {
    if (k.startsWith(`${id}.`) && (names === undefined || names.includes(k.slice(id.length + 1)))) out[k.slice(id.length + 1)] = v;
  }
  return out;
}

// The rows (SP6a spec §10.1, Task 38, ruling R21): each id's parts at their bounds in `test/thresholds.ts`. The first
// test of each group measures it (its timeout covers the regions); the others read the same values.
if (DEFAULT_GROUP) {
  metricTest('C1', ['voidShareMin', 'voidShareMax'], async () => partsOf(await c1c6(), 'C1'), 900_000);
  metricTest('C2', ['skyComponents', 'skyShare'], async () => partsOf(await c1c6(), 'C2'));
  metricTest('C3', ['cheeseShare', 'spaghettiShare', 'noodleShare', 'carverShare', 'entranceShare', 'pillars', 'ravines', 'ravinesSky', 'maxShare'],
    async () => partsOf(await c1c6(), 'C3'));
  metricTest('C4', ['bands', 'floorPeak'], async () => partsOf(await c1c6(), 'C4'));
  // C5.largest is gated on quick and full (ruling R21 (e): fast's 16 × 16 regions read it high by their size).
  metricTest('C5', ['largest', 'landCarved', 'thinnest', 'thinnestByKind'], async () => partsOf(await c1c6(), 'C5'));
  metricTest('C6', ['latticeBias'], async () => partsOf(await c1c6(), 'C6'));
}
// The per-group parts (SP6b spec §13 L4), with the default and the presets group: each job gates the worst of its own
// groups.
if (C1_C9_GROUPS) {
  metricTest('C7', ['verticalStep', 'flatWallShare', 'waterWall'], async () => partsOf(await c7c9(), 'C7', PER_GROUP_C7), 900_000,
    { outName: 'C7.tuning' });
  metricTest('C9', ['nearestEntrance', 'holedSurface'], async () => partsOf(await c7c9(), 'C9', PER_GROUP_C9));
}
/**
 * C7's bottom parts (SP6b spec §12.3, D6, D26; Tasks 20-21), over every region of the run's groups, per group (the
 * default group, each preset) and the worst group's (ruling P2; each job gates its own regions), as built in
 * `test/harness/caveMetrics.ts`:
 * - `C7.bottomPlane`, the flat floor faces on the bedrock plane (cave voxel at y −63) over all flat faces, gated from
 *   SP6b at max 0.01 (§5.2's floor holds it by construction: no cave air below `caves.floor.y` + 5);
 * - `C7.bedrockExposed`, the cave-air voxels face-adjacent to a bedrock voxel, gated from SP6b at max 0 (Task 21: it read
 *   0 on every group after the floor), with every region's bedrock count > 0 asserted (ruling R16);
 * - `C7.bottomFloorSpread` (min 6), gated from SP6b's tuning (Task 30), and `C7.bottomFlatRatio` (its proposed 1.5
 *   missed on fast and full; ruling U5, the user's: a regression guard at max 2.05, the full worst 1.78 × 1.15, gated on
 *   quick and full, recorded on fast, whose two 16 × 16 regions read it high by their size; re-judged in SP12), with
 *   `C7.bottomFloorPeak` recorded beside them.
 * All per group, with the flat-floor histogram y −64 … −32, the cave air per 16-block band from y −64 and each region's
 * counts, in `.out/caves.bottom.json`.
 */
async function measureBottom(): Promise<CaveBottomParts> {
  const measured = await c1c9Regions();
  const regions = measured.map((m) => ({ group: groupOf(m.site), bottom: m.bottom }));
  const parts = caveBottomParts(regions);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'caves.bottom.json'), json({
    id: 'caves.bottom', tier: process.env.METRICS_TIER ?? null, values: parts, groups: caveBottomGroups(regions),
    // Per region, its counts read as a group of one.
    regions: measured.map((m) => ({
      label: m.site.label, group: groupOf(m.site), ms: m.ms.bottom, ...caveBottomGroups([{ group: 'region', bottom: m.bottom }]).region,
    })),
  }));
  // The grid's bedrock is read in every region (y −64), so bedrockExposed 0 is not a class table that lost bedrock.
  for (const m of measured) expect(m.bottom.bedrock, `bedrock voxels at ${m.site.label}`).toBeGreaterThan(0);
  expect(Number.isFinite(parts.bottomPlane), `C7.bottomPlane = ${parts.bottomPlane} is not finite`).toBe(true);
  expect(Number.isFinite(parts.bedrockExposed), `C7.bedrockExposed = ${parts.bedrockExposed} is not finite`).toBe(true);
  return parts;
}

let bottomRun: Promise<CaveBottomParts> | null = null;
/** C7's bottom parts, measured once (the first test to ask). */
const bottom = (): Promise<CaveBottomParts> => (bottomRun ??= measureBottom());

// C7's bottom parts in the default and the presets group's jobs (each the worst of its own groups): bottomPlane and
// bedrockExposed, then the tuning's bottomFlatRatio and bottomFloorSpread (Task 30) with the recorded bottomFloorPeak.
if (C1_C9_GROUPS) {
  metricTest('C7', ['bottomPlane'], async () => ({ bottomPlane: (await bottom()).bottomPlane }), 900_000, { outName: 'C7.bottomPlane' });
  metricTest('C7', ['bedrockExposed'], async () => ({ bedrockExposed: (await bottom()).bedrockExposed }), 900_000,
    { outName: 'C7.bedrockExposed' });
  metricTest('C7', ['bottomFlatRatio', 'bottomFloorSpread'], async () => {
    const p = await bottom();
    return { bottomFlatRatio: p.bottomFlatRatio, bottomFloorSpread: p.bottomFloorSpread, bottomFloorPeak: p.bottomFloorPeak };
  }, 900_000, { outName: 'C7.bottom' });
}

/** The scale of `metricTest`'s timeouts (`METRICS_TIMEOUT_SCALE`, SP6b spec §12.9), for the plain record test below. */
const TIMEOUT_SCALE = Number(process.env.METRICS_TIMEOUT_SCALE ?? '1');

/** The job (`METRICS_CAVE_GROUPS`) a region belongs to: its group. */
const jobOf = (s: Site): CaveGroup => s.group;

/** The run's groups (`METRICS_CAVE_GROUPS`; every group with none, ruling P2). */
const RUN_GROUPS: readonly CaveGroup[] = GROUP === null ? ['default', 'presets', 'biomes'] : [GROUP];
/**
 * The groups whose jobs gate B3's border parts and `B3.abyssRockStraight` (SP6b spec §12.2, rulings P29, P38; Task 30):
 * a literal per group, decided from Task 30 Step 1's dry run, never from a run's own counts (a short sample must not
 * turn into a pass). The border parts: `biomes` always (its biome | plain pairs need 2,000 border faces each, so a short
 * sample fails); `default` and `presets` because each read at least 2,000 border faces on every tier it has regions on
 * (default 122,960 on fast, 1,203,848 on quick, 1,281,162 on full; presets 825,389 on quick, 2,349,531 on full, fast
 * holding no preset region). `B3.abyssRockStraight`: `biomes` (the biome region) always; not `default`,
 * whose regions show no abyss rock on a wall (0 boundary edges on every tier, below the 2,000 its rule asks), so its job
 * records the part (`.out/B3.abyssRock.default.json`) instead of gating a NaN; never `presets` (§12.2).
 */
const B3_BORDERS_GATED: Readonly<Record<CaveGroup, boolean>> = { default: true, presets: true, biomes: true };
const B3_ABYSS_ROCK_GATED: Readonly<Record<CaveGroup, boolean>> = { default: false, presets: false, biomes: true };
/** `B3.borderLattice`'s two-sided bound, against which the worst job is picked (`worstToBound`). */
const BORDER_LATTICE = THRESHOLDS.B3!.borderLattice!;

/**
 * B3's border parts' record (SP6b spec §12.2, D26; Task 26; gated by `B3.borders` below, Task 30), as built in
 * `test/harness/caveMetrics.ts` (`caveBorderCounts`, `caveBorderParts`): per job over the regions
 * it holds (with every group in this one process, per group, so each record is the one its job writes alone; ruling
 * P2), overall and per biome pair: `borderLattice` (with each axis' ratio), `straightBorder`, `flatBorder`, the border
 * faces (per axis), and the painted skin's mix within 2 blocks of a border; with each region's overall values, in
 * `.out/B3.borders.<group>.json`, for every job (a job whose group `B3_BORDERS_GATED` leaves out is recorded only). The
 * overall border faces are the pairs' sum (each face has one pair).
 */
test('B3: border parts per job and biome pair (recorded)', async () => {
  const measured = await measuredRegions();
  const jobs = [...new Set(measured.map((m) => jobOf(m.site)))];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of jobs) {
    const rs = measured.filter((m) => jobOf(m.site) === job);
    const parts = caveBorderParts(rs.map((m) => m.borders));
    writeFileSync(join(OUT_DIR, `B3.borders.${job}.json`), json({
      id: 'B3.borders', tier: process.env.METRICS_TIER ?? null, group: job, ...parts,
      regions: rs.map((m) => {
        const o = caveBorderParts([m.borders]).overall;
        return {
          label: m.site.label, ms: m.ms.borders, borderFaces: o.borderFaces, borderLattice: o.borderLattice, lattice: o.lattice,
          straightBorder: o.straightBorder, flatBorder: o.flatBorder,
        };
      }),
    }));
    const pairFaces = BORDER_PAIR_NAMES.reduce((a, name) => a + parts.pairs[name]!.borderFaces, 0);
    expect(parts.overall.borderFaces, `B3 ${job}: the overall border faces are the pairs' sum`).toBe(pairFaces);
  }
  expect(jobs.length).toBeGreaterThan(0);
}, 900_000 * TIMEOUT_SCALE);

/**
 * B3's border parts gated (SP6b spec §12.2, D26; Task 30) in the jobs of the groups `B3_BORDERS_GATED` names: each job's
 * overall value over its own regions (the record above), the part the worst job's (`borderLattice` the value farthest
 * outside or nearest to its bound 0.9-1.1, by min/v and v/max (`worstToBound`), `straightBorder` and `flatBorder` the
 * largest; ruling P2), with each job's values and border faces beside it.
 * The biomes job's three biome | plain pairs need 2,000 border faces each, else the part fails as an insufficient
 * sample (§12.2; Task 27); its other pairs, and every job's pairs, are recorded only.
 */
if (RUN_GROUPS.some((g) => B3_BORDERS_GATED[g])) {
  metricTest('B3', ['borderLattice', 'straightBorder', 'flatBorder'], async () => {
    const measured = await measuredRegions();
    const jobs = RUN_GROUPS.filter((g) => B3_BORDERS_GATED[g] && measured.some((m) => jobOf(m.site) === g));
    expect(jobs.length, 'B3.borders: no gated job measured').toBeGreaterThan(0);
    const rec: Record<string, number> = {};
    const overall = jobs.map((job) => {
      const parts = caveBorderParts(measured.filter((m) => jobOf(m.site) === job).map((m) => m.borders));
      if (job === 'biomes') expect(borderSampleProblems(parts), `B3 ${job}`).toEqual([]);
      const o = parts.overall;
      rec[`borderLattice.${job}`] = o.borderLattice;
      rec[`straightBorder.${job}`] = o.straightBorder;
      rec[`flatBorder.${job}`] = o.flatBorder;
      rec[`borderFaces.${job}`] = o.borderFaces;
      return o;
    });
    return {
      borderLattice: worstToBound(overall.map((o) => o.borderLattice), BORDER_LATTICE.min!, BORDER_LATTICE.max!),
      straightBorder: Math.max(...overall.map((o) => o.straightBorder)),
      flatBorder: Math.max(...overall.map((o) => o.flatBorder)),
      ...rec,
    };
  }, 900_000, { outName: 'B3.borders' });
}

/**
 * `B3.abyssRockStraight`'s record (SP6b spec §12.2, ruling P30; Task 28; gated by `B3.abyssRock` below, Task 30), as built in
 * `caveMetrics.ts` (`abyssRockCounts`: the abyss rock's boundary edges between vertically adjacent exposed wall voxels,
 * one abyss rock and one other rock, on a wall plane both face, and the share of them in straight runs ≥ 8 along x or z
 * at one y): per job over the regions it measures for it, the default group's regions (`caves`) and the biome region
 * (`caves-biomes`; not `cave_heavy`'s, not the presets', §12.2), pooled, with each region's values and the abyss walls
 * (the population: a job whose regions show no abyss rock on a wall reads NaN), in `.out/B3.abyssRock.<group>.json`.
 * The biome region holds abyss cave air by construction (ruling P33), so its job's abyss walls are asserted > 0.
 */
if (DEFAULT_GROUP || BIOMES_GROUP) {
  test('B3: abyssRockStraight per job (recorded)', async () => {
    const measured = (await measuredRegions()).filter((m) => m.abyssRock !== null);
    const jobs = [...new Set(measured.map((m) => jobOf(m.site)))];
    mkdirSync(OUT_DIR, { recursive: true });
    for (const job of jobs) {
      const rs = measured.filter((m) => jobOf(m.site) === job);
      const c = poolAbyssRockCounts(rs.map((m) => m.abyssRock!));
      writeFileSync(join(OUT_DIR, `B3.abyssRock.${job}.json`), json({
        id: 'B3.abyssRock', tier: process.env.METRICS_TIER ?? null, group: job, abyssRockStraight: abyssRockStraight(c), ...c,
        regions: rs.map((m) => ({ label: m.site.label, ms: m.ms.abyssRock, abyssRockStraight: abyssRockStraight(m.abyssRock!), ...m.abyssRock! })),
      }));
      if (job === 'biomes') expect(c.abyssWalls, `B3 ${job}: abyss rock on the biome region's walls`).toBeGreaterThan(0);
    }
    expect(jobs.length).toBeGreaterThan(0);
  }, 900_000 * TIMEOUT_SCALE);
}

/**
 * `B3.abyssRockStraight` gated (SP6b spec §12.2, rulings P29, P30; Task 30) in the jobs of the groups
 * `B3_ABYSS_ROCK_GATED` names: each job's value over its regions' pooled counts (the record above), the part the
 * largest, with each job's value, boundary edges and abyss walls beside it (a job with no abyss rock on a wall reads NaN,
 * which fails).
 */
if (RUN_GROUPS.some((g) => B3_ABYSS_ROCK_GATED[g])) {
  metricTest('B3', ['abyssRockStraight'], async () => {
    const measured = (await measuredRegions()).filter((m) => m.abyssRock !== null);
    const jobs = RUN_GROUPS.filter((g) => B3_ABYSS_ROCK_GATED[g] && measured.some((m) => jobOf(m.site) === g));
    expect(jobs.length, 'B3.abyssRock: no gated job measured').toBeGreaterThan(0);
    const rec: Record<string, number> = {};
    const values = jobs.map((job) => {
      const c = poolAbyssRockCounts(measured.filter((m) => jobOf(m.site) === job).map((m) => m.abyssRock!));
      const v = abyssRockStraight(c);
      rec[`abyssRockStraight.${job}`] = v;
      rec[`edges.${job}`] = c.edges;
      rec[`abyssWalls.${job}`] = c.abyssWalls;
      return v;
    });
    return { abyssRockStraight: Math.max(...values), ...rec };
  }, 900_000, { outName: 'B3.abyssRock' });
}

// ---------------------------------------------------------------- A1, A3, A4 after the settle reference (SP7a §13.1)

/**
 * A1, A3 and A4's record (SP7a spec §13.1, D30; Task 22; gated at their bounds at the tuning, Task 31), as built in
 * `test/harness/water.ts` (`waterRegionCounts`, `waterParts`): per job over its regions' interiors after the global
 * settle reference, A1's `dryShare` (with `dryShareT`, on T alone over the same population), A3's `lavaBelow54` (the
 * share of tagged voxels at y < the profile's `aquifer.lavaLevel` holding lava, with `lavaBelow54Population`; rulings R21, R23),
 * `aquiferLavaAbove10`, `lavaSupported`, `lavaSkyRegions`, A4's `aquiferBodies`, and recorded with them `skyOpenDeep`,
 * the margin barriers and the pits below sea after settle and in T; with each region's values and its settle and A ms,
 * in `.out/A.<group>.json`.
 */
test('A1, A3, A4 per job after the settle reference (recorded)', async () => {
  const measured = await measuredRegions();
  const jobs = [...new Set(measured.map((m) => jobOf(m.site)))];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of jobs) {
    const rs = measured.filter((m) => jobOf(m.site) === job && m.water !== null);
    writeFileSync(join(OUT_DIR, `A.${job}.json`), json({
      id: 'A', tier: process.env.METRICS_TIER ?? null, group: job, values: waterParts(rs.map((m) => m.water!)),
      regions: rs.map((m) => ({ label: m.site.label, ms: { settle: m.ms.settle, water: m.ms.water }, ...waterParts([m.water!]), counts: m.water })),
    }));
    expect(rs.length, `A: the ${job} job's regions`).toBeGreaterThan(0);
  }
}, 900_000 * TIMEOUT_SCALE);

/**
 * A2's record (SP7a spec §13.1, D30; Task 23; gated at its bounds at the tuning, Task 31), as built in
 * `test/harness/water.ts` (`a2RegionCounts`, `a2Parts`): per job over its regions' interiors after the global settle
 * reference, `unsupported` (the fluid voxels one application of §4.1's rules would change, counting the unsettled) and
 * `unsettled` (bit 6 outside the water/lava contacts), each over all fluid voxels, with the counts, shares and rates
 * per km² pooled and by origin (sky-open, aquifer, spring: `refs.ts`' `referenceSettleOrigins`) and `A2.contacts` apart;
 * with each region's values, in `.out/A2.<group>.json`.
 */
test('A2 by origin per job after the settle reference (recorded)', async () => {
  const measured = await measuredRegions();
  const jobs = [...new Set(measured.map((m) => jobOf(m.site)))];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of jobs) {
    const rs = measured.filter((m) => jobOf(m.site) === job && m.a2 !== null);
    writeFileSync(join(OUT_DIR, `A2.${job}.json`), json({
      id: 'A2', tier: process.env.METRICS_TIER ?? null, group: job, values: a2Parts(rs.map((m) => m.a2!)),
      regions: rs.map((m) => ({ label: m.site.label, ...a2Parts([m.a2!]), counts: m.a2 })),
    }));
    expect(rs.length, `A2: the ${job} job's regions`).toBeGreaterThan(0);
    expect(rs.every((m) => m.a2!.fluid.skyOpen + m.a2!.fluid.aquifer + m.a2!.fluid.spring > 0), `A2: the ${job} job's regions hold fluid`).toBe(true);
  }
}, 900_000 * TIMEOUT_SCALE);

/**
 * A5's record (SP7a spec §13.1, D30; Task 24; `springsTruncated` and `islandFalls` gated below from the tuning, Task 31,
 * `lavaFalls` and `borderRatio` from the user's bounds, Task 31c, `abyssWater` from Task 24), as built in
 * `test/harness/water.ts` (`springFacts`, `a5RegionCounts`, `a5Parts`): per job over its regions' interiors after the
 * global settle reference (Spec correction 11: a job reads only its own regions), `waterfalls` (the default group's
 * regions), `lavaFalls` (the biome region and the regions with ≥ 50,000 abyss cave-air voxels), `islandFalls` (the
 * regions whose profile has islands), `borderRatio` (every region), `abyssWater`, `springsTruncated` (the default group's regions
 * and the presets group's amplified region), recorded with them the pooled Clark-Evans ratio of the visible falls,
 * `waterIntoAbyss`, `abyssWaterFace`, `adjacentSprings`, the falls' heights and the sums behind the parts; with each
 * region's values, in `.out/A5.<group>.json`.
 */
test('A5 per job after the settle reference (recorded)', async () => {
  const measured = await measuredRegions();
  const jobs = [...new Set(measured.map((m) => jobOf(m.site)))];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of jobs) {
    const rs = measured.filter((m) => jobOf(m.site) === job && m.a5 !== null);
    writeFileSync(join(OUT_DIR, `A5.${job}.json`), json({
      id: 'A5', tier: process.env.METRICS_TIER ?? null, group: job, values: a5Parts(rs.map((m) => m.a5!)),
      regions: rs.map((m) => ({ label: m.site.label, ...a5Parts([m.a5!]), counts: m.a5 })),
    }));
    expect(rs.length, `A5: the ${job} job's regions`).toBeGreaterThan(0);
  }
}, 900_000 * TIMEOUT_SCALE);

// `A5.abyssWater` (SP7a spec §13.1): the aquifer's water voxels of the abyss nibble (those whose proto byte holds water;
// the settle's there, rulings R23, are `waterIntoAbyss`) over every region of the run's groups, 0 by construction (the
// aquifer tests the voxel's own nibble, §1.6), gated from this commit.
metricTest('A5', ['abyssWater'], async () => {
  const rs = (await measuredRegions()).filter((m) => m.a5 !== null).map((m) => m.a5!);
  expect(rs.length).toBeGreaterThan(0);
  return { abyssWater: a5Parts(rs).abyssWater, regions: rs.length };
}, 900_000);

// `A3.aquiferLavaAbove10` (SP7a spec §13.1; rulings P19): the tagged proto lava above y −10 over every region of the
// run's groups, 0 by construction (springs are untagged, untagged air takes only water), gated from this commit.
metricTest('A3', ['aquiferLavaAbove10'], async () => {
  const rs = (await measuredRegions()).filter((m) => m.water !== null).map((m) => m.water!);
  expect(rs.length).toBeGreaterThan(0);
  return { aquiferLavaAbove10: waterParts(rs).aquiferLavaAbove10, regions: rs.length };
}, 900_000);

// ---------------------------------------------------------------- A1-A5 at their bounds (SP7a §13.1; Task 31)

/**
 * The run's groups that measured a region, each with its regions' `pick` (the regions whose `pick` is null left out),
 * in `RUN_GROUPS`' order (a group with no such region, the presets group on fast, is left out).
 */
async function regionsByGroup<T>(pick: (m: Measured) => T | null): Promise<Array<readonly [CaveGroup, T[]]>> {
  const measured = await measuredRegions();
  return RUN_GROUPS.map((g) => [g, measured.filter((m) => jobOf(m.site) === g).map(pick).filter((v): v is T => v !== null)] as const)
    .filter(([, rs]) => rs.length > 0);
}

/**
 * A per-group part (SP7a spec §13.1: per group, the worst; each job gates its own regions, Spec correction 11): each
 * group's value, recorded in `rec` as `<part>.<group>`, and the worst of them, the least for a minimum bound, the
 * largest for a maximum, the farthest from 1 by ratio for a band around 1 (`borderRatio`); NaN with no group or a NaN
 * group (a gated NaN fails, `metric.ts`).
 */
function worstOfGroups(part: string, values: ReadonlyArray<readonly [CaveGroup, number]>, worst: 'min' | 'max' | 'ratio', rec: Record<string, number>): number {
  for (const [g, v] of values) rec[`${part}.${g}`] = v;
  if (values.length === 0) return Number.NaN;
  const vs = values.map(([, v]) => v);
  if (vs.some(Number.isNaN)) return Number.NaN;
  if (worst === 'ratio') return vs.reduce((a, v) => (Math.abs(Math.log(v)) > Math.abs(Math.log(a)) ? v : a));
  return worst === 'min' ? Math.min(...vs) : Math.max(...vs);
}

/**
 * The groups whose jobs gate `A5.springsTruncated` and `A5.islandFalls` (SP7a spec §13.1, Spec correction 11; Task 31):
 * a literal per group, decided from Task 31 Step 1's dry run, never from a run's own counts (a short sample must not
 * turn into a pass). `springsTruncated` (the default group's regions and the presets group's amplified region): the
 * presets group only, whose amplified region holds water springs on quick (6) and full; the default group's regions
 * hold no spring on any tier (0 over 2, 6 and 12 regions on fast, quick and full), and the biomes group's regions are not
 * the part's. `islandFalls` (the floating_islands region): the presets group, its only group. Both rows are gated on
 * quick and full (fast measures no preset region).
 */
const SPRINGS_TRUNCATED_GATED: Readonly<Record<CaveGroup, boolean>> = { default: false, presets: true, biomes: false };
const ISLAND_FALLS_GATED: Readonly<Record<CaveGroup, boolean>> = { default: false, presets: true, biomes: false };
/**
 * The groups whose jobs gate `A5.lavaFalls` and `A5.borderRatio` (the user's round-2 decisions, rulings R24 items 4-5;
 * Task 31c), literals decided from Task 31's dry run as above. `lavaFalls` (the biome region and the regions with
 * ≥ 50,000 abyss cave-air voxels): the groups that hold that sample, presets (the amplified regions) and biomes (the
 * biome region), on every tier that measures them. `borderRatio`: only a group holding ≥ `BORDER_RATIO_MIN_SPRINGS`
 * springs (a sample-size rule; the bound unchanged), which on the dry run is the presets group on full (78 springs;
 * presets on quick 25, biomes 4, default none), so its row is gated on full only; a gated group that holds fewer springs
 * fails (the literal is then re-decided, never a short sample turned into a pass).
 */
const LAVA_FALLS_GATED: Readonly<Record<CaveGroup, boolean>> = { default: false, presets: true, biomes: true };
const BORDER_RATIO_GATED: Readonly<Record<CaveGroup, boolean>> = { default: false, presets: true, biomes: false };
const BORDER_RATIO_MIN_SPRINGS = 50;

// A1 (master :1528; SP7a spec §13.1): `dryShare` after settle per group, the worst (≥ 40 %), with each group's value and
// on T alone (`dryShareT.<group>`, recorded).
metricTest('A1', ['dryShare'], async () => {
  const rec: Record<string, number> = {};
  const gs = await regionsByGroup((m) => m.water);
  const dryShare = worstOfGroups('dryShare', gs.map(([g, rs]) => [g, waterParts(rs).dryShare] as const), 'min', rec);
  for (const [g, rs] of gs) rec[`dryShareT.${g}`] = waterParts(rs).dryShareT;
  return { dryShare, ...rec };
}, 900_000);

// A2 (master :1529; SP7a spec §13.1): `unsupported` and `unsettled` after settle over all fluid voxels per group, the
// worst (≤ 0.1 % each), with each group's value and fluid voxels; the record by origin stays `.out/A2.<group>.json`.
metricTest('A2', ['unsupported', 'unsettled'], async () => {
  const rec: Record<string, number> = {};
  const gs = (await regionsByGroup((m) => m.a2)).map(([g, rs]) => [g, a2Parts(rs)] as const);
  for (const [g, p] of gs) rec[`fluid.${g}`] = p.all.fluid;
  return {
    unsupported: worstOfGroups('unsupported', gs.map(([g, p]) => [g, p.unsupported] as const), 'max', rec),
    unsettled: worstOfGroups('unsettled', gs.map(([g, p]) => [g, p.unsettled] as const), 'max', rec),
    ...rec,
  };
}, 900_000);

// A3 (master :1530; SP7a spec §13.1): `lavaBelow54` (the tagged voxels at y < `aquifer.lavaLevel` holding lava after
// settle, pooled per group; ≥ 50 %; every group's population is non-empty on every tier, Task 31's dry run, so a group
// that loses it reads NaN and fails rather than passing vacuously), `lavaSupported` (≥ 99 %) and `lavaSkyRegions`
// (≥ 25 %) per group, the worst, with each group's value and `lavaBelow54Population.<group>`. `aquiferLavaAbove10`
// keeps its own call above (`.out/A3.json`).
metricTest('A3', ['lavaBelow54', 'lavaSupported', 'lavaSkyRegions'], async () => {
  const rec: Record<string, number> = {};
  const gs = (await regionsByGroup((m) => m.water)).map(([g, rs]) => [g, waterParts(rs)] as const);
  for (const [g, p] of gs) rec[`lavaBelow54Population.${g}`] = p.lavaBelow54Population;
  return {
    lavaBelow54: worstOfGroups('lavaBelow54', gs.map(([g, p]) => [g, p.lavaBelow54] as const), 'min', rec),
    lavaSupported: worstOfGroups('lavaSupported', gs.map(([g, p]) => [g, p.lavaSupported] as const), 'min', rec),
    lavaSkyRegions: worstOfGroups('lavaSkyRegions', gs.map(([g, p]) => [g, p.lavaSkyRegions] as const), 'min', rec),
    ...rec,
  };
}, 900_000, { outName: 'A3.tuning' });

// A4 (master :1531; SP7a spec §13.1): `aquiferBodies`, the fewest aquifer bodies of a region, over every group's
// regions (≥ 1), with each group's value.
metricTest('A4', ['aquiferBodies'], async () => {
  const rec: Record<string, number> = {};
  const gs = await regionsByGroup((m) => m.water);
  return { aquiferBodies: worstOfGroups('aquiferBodies', gs.map(([g, rs]) => [g, waterParts(rs).aquiferBodies] as const), 'min', rec), ...rec };
}, 900_000);

// `A5.springsTruncated` (SP7a spec §13.1; the user's addition): the truncated water springs over the water springs of
// the part's regions, in the groups `SPRINGS_TRUNCATED_GATED` names, the worst; its bound the worst reading over the
// tiers it gates after Task 28's levers (the user's, rulings R23 item 1); with each gated group's counts.
if (RUN_GROUPS.some((g) => SPRINGS_TRUNCATED_GATED[g])) {
  metricTest('A5', ['springsTruncated'], async () => {
    const rec: Record<string, number> = {};
    const gs = (await regionsByGroup((m) => m.a5)).filter(([g]) => SPRINGS_TRUNCATED_GATED[g]).map(([g, rs]) => [g, a5Parts(rs)] as const);
    for (const [g, p] of gs) {
      rec[`truncated.${g}`] = p.counts.truncated;
      rec[`waterSprings.${g}`] = p.counts.truncatedSprings;
    }
    return { springsTruncated: worstOfGroups('springsTruncated', gs.map(([g, p]) => [g, p.springsTruncated] as const), 'max', rec), ...rec };
  }, 900_000, { outName: 'A5.springs' });
}

// `A5.islandFalls` (SP7a spec §13.1): island-edge falls per km² of island area in the floating_islands region (≥ 2), in
// the groups `ISLAND_FALLS_GATED` names, with its falls and island area.
if (RUN_GROUPS.some((g) => ISLAND_FALLS_GATED[g])) {
  metricTest('A5', ['islandFalls'], async () => {
    const rec: Record<string, number> = {};
    const gs = (await regionsByGroup((m) => m.a5)).filter(([g]) => ISLAND_FALLS_GATED[g]).map(([g, rs]) => [g, a5Parts(rs)] as const);
    for (const [g, p] of gs) {
      rec[`falls.${g}`] = p.counts.islandFalls;
      rec[`islandKm2.${g}`] = p.counts.islandKm2;
    }
    return { islandFalls: worstOfGroups('islandFalls', gs.map(([g, p]) => [g, p.islandFalls] as const), 'min', rec), ...rec };
  }, 900_000, { outName: 'A5.islandFalls' });
}

// `A5.lavaFalls` (SP7a spec §13.1): lava springs with a fall ≥ 4 per 100,000 abyss cave-air voxels (≥ 0.6, the user's,
// rulings R24 item 4), in the groups `LAVA_FALLS_GATED` names, the worst, with each gated group's falls and abyss air.
if (RUN_GROUPS.some((g) => LAVA_FALLS_GATED[g])) {
  metricTest('A5', ['lavaFalls'], async () => {
    const rec: Record<string, number> = {};
    const gs = (await regionsByGroup((m) => m.a5)).filter(([g]) => LAVA_FALLS_GATED[g]).map(([g, rs]) => [g, a5Parts(rs)] as const);
    for (const [g, p] of gs) {
      rec[`falls.${g}`] = p.counts.lavaFalls;
      rec[`abyssAir.${g}`] = p.counts.abyssAir;
    }
    return { lavaFalls: worstOfGroups('lavaFalls', gs.map(([g, p]) => [g, p.lavaFalls] as const), 'min', rec), ...rec };
  }, 900_000, { outName: 'A5.lavaFalls' });
}

// `A5.borderRatio` (SP7a spec §13.1): springs on a chunk-border voxel over springs ÷ 60/256 (0.8-1.25), in the groups
// `BORDER_RATIO_GATED` names (a group holding ≥ 50 springs, rulings R24 item 5), the farthest from 1, with each gated
// group's springs; on a tier its row gates, a gated group holding fewer than `BORDER_RATIO_MIN_SPRINGS` springs fails.
if (RUN_GROUPS.some((g) => BORDER_RATIO_GATED[g])) {
  metricTest('A5', ['borderRatio'], async () => {
    const rec: Record<string, number> = {};
    const gs = (await regionsByGroup((m) => m.a5)).filter(([g]) => BORDER_RATIO_GATED[g]).map(([g, rs]) => [g, a5Parts(rs)] as const);
    const gated = THRESHOLDS.A5?.borderRatio?.tiers?.includes(TIER) ?? true;
    for (const [g, p] of gs) {
      rec[`springs.${g}`] = p.counts.springs;
      rec[`borderSprings.${g}`] = p.counts.borderSprings;
      if (gated) expect(p.counts.springs, `A5.borderRatio: the ${g} group's springs (a gated group holds ≥ ${BORDER_RATIO_MIN_SPRINGS})`).toBeGreaterThanOrEqual(BORDER_RATIO_MIN_SPRINGS);
    }
    return { borderRatio: worstOfGroups('borderRatio', gs.map(([g, p]) => [g, p.borderRatio] as const), 'ratio', rec), ...rec };
  }, 900_000, { outName: 'A5.borderRatio' });
}

/**
 * `C7.waterWallAny` (SP7a spec §13.2: SP6a's waterWall count, any fluid voxel of T beside dry tagged air, recorded beside
 * the settled `C7.waterWall`): per job, each C7 group's value (`c7c9Groups`) with its settled `waterWall`, in
 * `.out/C7.waterWallAny.<group>.json`.
 */
test('C7.waterWallAny per job (recorded)', async () => {
  const measured = await measuredRegions();
  const jobs = [...new Set(measured.map((m) => jobOf(m.site)))];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of jobs) {
    const rs = measured.filter((m) => jobOf(m.site) === job);
    const groups = c7c9Groups(rs.map((m) => ({ group: groupOf(m.site), full: m.site.size === 32, counts: m.c79 })));
    writeFileSync(join(OUT_DIR, `C7.waterWallAny.${job}.json`), json({
      id: 'C7.waterWallAny', tier: process.env.METRICS_TIER ?? null, group: job,
      groups: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, { waterWallAny: v.waterWallAny, waterWall: v.waterWall }])),
      regions: rs.map((m) => ({ label: m.site.label, waterWallAny: m.c79.waterWallAny, areaKm2: m.c79.areaKm2, waterWall: m.c79.waterWall, waterWallKm2: m.c79.waterWallKm2 })),
    }));
  }
  expect(jobs.length).toBeGreaterThan(0);
}, 900_000 * TIMEOUT_SCALE);

/** The water-wall fronts listed per job (SP7a spec §13.9): at most this many… */
const WALL_FRONTS_MAX = 10;
/** …no two within this many blocks of each other (3D, voxel to voxel, whatever their profiles)… */
const WALL_FRONT_SPACING = 32;
/** …each with the eye this many blocks out on its dry side, level with it, facing it. */
const WALL_FRONT_EYE = 16;
/** The horizontal sides in `fluidRules.ts`' order (a `WaterWallFront`'s mask), their names and the yaw facing back. */
const SIDES = [
  { name: 'N', dx: 0, dz: -1, yaw: 180 }, { name: 'E', dx: 1, dz: 0, yaw: 270 },
  { name: 'S', dx: 0, dz: 1, yaw: 0 }, { name: 'W', dx: -1, dz: 0, yaw: 90 },
] as const;

/** A water-wall front of `wallFrontsOf`: its pose, its dry target sides, the eye's side, its region and the region's reading. */
interface WallFront extends CavePose {
  readonly dry: string[];
  readonly side: string;
  readonly profile: string;
  readonly region: string;
  readonly distance: number;
  /** The region's C7.waterWall per km² of its interior (`waterWall` / `waterWallKm2`). */
  readonly regionWaterWall: number;
}

/**
 * The water-wall fronts of a job's seed '42' regions (SP7a spec §13.9, rulings R24 item 1): the voxels C7.waterWall counts
 * (`waterWallFronts`), nearest their profile's spawn first (horizontal distance from the voxel's centre; ties in region
 * order, then in the count's order), a front kept when no front kept before it lies within `WALL_FRONT_SPACING` blocks
 * (whatever its profile: at seed '42' the profiles share most of their caves near the spawn, so one place would otherwise
 * repeat under several profiles), at most `WALL_FRONTS_MAX`; each with its dry target sides, the eye `WALL_FRONT_EYE`
 * blocks out on the first of them (N, E, S, W) at the voxel's centre height, facing the front (yaw 0 faces −z, 90 +x;
 * pitch 0), its profile, region and the region's C7.waterWall reading.
 */
function wallFrontsOf(rs: readonly Measured[], spawnOf: (profile: Site['profile']) => { x: number; z: number }): WallFront[] {
  const all = rs.flatMap((m) => {
    const spawn = spawnOf(m.site.profile);
    const reading = m.c79.waterWall / m.c79.waterWallKm2;
    return m.c79.waterWallFronts.map((f) => ({ f, m, reading, distance: Math.hypot(f.voxel[0] + 0.5 - spawn.x, f.voxel[2] + 0.5 - spawn.z) }));
  }).map((e, k) => [e, k] as const).sort((a, b) => a[0].distance - b[0].distance || a[1] - b[1]).map(([e]) => e);
  const kept: typeof all = [];
  for (const e of all) {
    if (kept.length === WALL_FRONTS_MAX) break;
    const [x, y, z] = e.f.voxel;
    if (kept.some((k) => Math.hypot(k.f.voxel[0] - x, k.f.voxel[1] - y, k.f.voxel[2] - z) < WALL_FRONT_SPACING)) continue;
    kept.push(e);
  }
  return kept.map(({ f, m, reading, distance }) => {
    const [x, y, z] = f.voxel;
    const sides = SIDES.filter((_, i) => (f.dry & (1 << i)) !== 0);
    const eye = sides[0]!;
    return {
      x: x + 0.5 + WALL_FRONT_EYE * eye.dx, y: y + 0.5, z: z + 0.5 + WALL_FRONT_EYE * eye.dz, yaw: eye.yaw, pitch: 0, voxel: f.voxel, component: 0,
      dry: sides.map((s) => s.name), side: eye.name, profile: m.site.profile, region: m.site.label, distance, regionWaterWall: reading,
    };
  });
}

/**
 * SP7a's review poses (spec §13.9, D16; `waterExamples`) at seed '42', per job (rulings P22): per pose, of the poses the
 * job's seed '42' regions found (each nearest its own profile's `findSpawn`), the one nearest its profile's spawn (ties
 * to the earlier region), with its profile, region and distance, in `.out/sp7a.examples.<group>.json` (null where none
 * was found). Task 24 adds A5's poses to the same record (`a5Examples`): the nearest `islandFall`, `lavaFall`, `lavaPool`
 * and `spillSlope` among the job's regions' as above, and `candidates`, every visible fall (`waterfall`, with its
 * height) and every truncated water spring (`truncated`, with its front) of the job's seed '42' regions, nearest its
 * profile's spawn first (ties in region order). Task 47 adds `wallFronts` (§13.9's water-wall fronts, rulings R24 item 1):
 * `wallFrontsOf` over the voxels C7.waterWall counts in the same regions.
 */
test('SP7a\'s review poses per job (sp7a.examples.<group>.json)', async () => {
  const measured = await measuredRegions();
  const spawns = new Map<string, { x: number; z: number }>();
  const spawnOf = (profile: Site['profile']): { x: number; z: number } => {
    let s = spawns.get(profile);
    if (s === undefined) {
      const p = findSpawn(createGenContext(seedFromInput('42'), resolveProfile(profile)));
      s = { x: p.x, z: p.z };
      spawns.set(profile, s);
    }
    return s;
  };
  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of RUN_GROUPS) {
    const rs = measured.filter((m) => jobOf(m.site) === job && m.waterExamples !== null);
    const poses: Record<string, (CavePose & { profile: string; region: string; distance: number }) | null> = {};
    for (const id of WATER_EXAMPLE_IDS) {
      let best: (CavePose & { profile: string; region: string; distance: number }) | null = null;
      for (const m of rs) {
        const p = m.waterExamples![id];
        if (p === null) continue;
        const spawn = spawnOf(m.site.profile);
        const distance = Math.hypot(p.voxel[0] + 0.5 - spawn.x, p.voxel[2] + 0.5 - spawn.z);
        if (best === null || distance < best.distance) best = { ...p, profile: m.site.profile, region: m.site.label, distance };
      }
      poses[id] = best;
    }
    type Placed = A5Pose & { profile: string; region: string; distance: number };
    const placed = (m: (typeof rs)[number], p: A5Pose): Placed => {
      const spawn = spawnOf(m.site.profile);
      return { ...p, profile: m.site.profile, region: m.site.label, distance: Math.hypot(p.voxel[0] + 0.5 - spawn.x, p.voxel[2] + 0.5 - spawn.z) };
    };
    const a5 = rs.filter((m) => m.a5Examples !== null);
    for (const id of A5_EXAMPLE_IDS) {
      let best: Placed | null = null;
      for (const m of a5) {
        const p = m.a5Examples![id];
        if (p === null) continue;
        const q = placed(m, p);
        if (best === null || q.distance < best.distance) best = q;
      }
      poses[id] = best;
    }
    const listOf = (pick: (m: (typeof rs)[number]) => readonly A5Pose[]): Placed[] =>
      a5.flatMap((m) => pick(m).map((p) => placed(m, p))).map((p, k) => [p, k] as const).sort((a, b) => a[0].distance - b[0].distance || a[1] - b[1]).map(([p]) => p);
    const candidates = { waterfall: listOf((m) => m.a5Examples!.waterfall), truncated: listOf((m) => m.a5Examples!.truncated) };
    const wallFronts = wallFrontsOf(rs, spawnOf);
    writeFileSync(join(OUT_DIR, `sp7a.examples.${job}.json`), json({
      id: 'sp7a.examples', tier: process.env.METRICS_TIER ?? null, group: job, seed: '42', spawns: Object.fromEntries(spawns), poses, candidates,
      wallFronts,
    }));
  }
}, 900_000 * TIMEOUT_SCALE);

// The default-only parts, with the default group.
if (DEFAULT_GROUP) {
  metricTest('C7', ['borderPlaneRatio', 'switchWall'], async () => partsOf(await c7c9(), 'C7', ['borderPlaneRatio', 'switchWall']), 900_000,
    { outName: 'C7.default' });
  // C8.largeShare is returned and recorded in `.out/C8.json`, not gated (ruling R21 (c)); aperiodicity and sizeSpread
  // are gated on quick and full (NaN on fast, ruling P32).
  metricTest('C8', ['aperiodicity', 'typeMixVariation', 'sizeSpread'], async () => partsOf(await c7c9(), 'C8'));
  metricTest('C9', ['entrancesMax', 'thinRoof'], async () => partsOf(await c7c9(), 'C9', ['entrancesMax', 'thinRoof']), 600_000,
    { outName: 'C9.default' });
}

// ---------------------------------------------------------------- the biomes group (SP6b spec §12.2-§12.3; Task 27)

/** `cave_heavy`'s C1, C2 and C9 (SP6b spec §12.3), recorded. */
interface CaveHeavyParts {
  readonly regions: number;
  readonly voidShare: number;
}

/**
 * `cave_heavy`'s parts over its regions (quick and full; none on fast, where every value is NaN): C1's void share,
 * C2's parts and C9's, by `c1c6Parts` and `c7c9Parts` over its regions alone (a group of their own, so C9's
 * default-only parts read them), written with each region's values to `.out/caves.caveHeavy.json`.
 */
async function measureCaveHeavy(): Promise<CaveHeavyParts> {
  const rs = (await measuredRegions()).filter((m) => m.site.profile === 'cave_heavy');
  const c16 = c1c6Parts(rs.map((m) => ({ profile: 'cave_heavy', counts: m.c16! })));
  const c79 = c7c9Parts(rs.map((m) => ({ group: 'default', full: m.site.size === 32, counts: m.c79 })));
  const recorded = (c: Record<string, number>, c9: Record<string, number>) => ({
    C1: { voidShare: c['C1.voidShareMin']! },
    C2: { skyComponents: c['C2.skyComponents']!, skyShare: c['C2.skyShare']! },
    C9: { nearestEntrance: c9['C9.nearestEntrance']!, entrancesMax: c9['C9.entrancesMax']!, holedSurface: c9['C9.holedSurface']!, thinRoof: c9['C9.thinRoof']! },
  });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'caves.caveHeavy.json'), json({
    id: 'caves.caveHeavy', tier: process.env.METRICS_TIER ?? null, profile: 'cave_heavy', regions: rs.length, ...recorded(c16, c79),
    perRegion: rs.map((m) => ({
      label: m.site.label, ms: m.ms,
      ...recorded(c1c6Parts([{ profile: 'cave_heavy', counts: m.c16! }]), c7c9Parts([{ group: 'default', full: m.site.size === 32, counts: m.c79 }])),
    })),
  }));
  return { regions: rs.length, voidShare: c16['C1.voidShareMin'] };
}

let caveHeavyRun: Promise<CaveHeavyParts> | null = null;
/** `cave_heavy`'s parts, measured once (the first test to ask). */
const caveHeavy = (): Promise<CaveHeavyParts> => (caveHeavyRun ??= measureCaveHeavy());

/** The biome region's measurement (the biomes group's default-profile region). */
async function biomeRegionMeasured(): Promise<Measured> {
  const m = (await measuredRegions()).find((r) => r.site.group === 'biomes' && r.site.profile === 'default');
  if (m === undefined) throw new Error('caves.metric: the biomes group has no biome region');
  return m;
}

/** The regular-grid check's grid and parts (`caveZones.ts`), with their times. */
interface Zones {
  readonly parts: ZoneParts;
  readonly gridMs: number;
  readonly partsMs: number;
}

let zonesRun: Promise<Zones> | null = null;
/** B3's regular-grid check, computed once (the first test to ask). */
const zones = (): Promise<Zones> => (zonesRun ??= Promise.resolve().then(() => {
  const t0 = performance.now();
  const grid = caveZoneGrid('42', resolveProfile('default'));
  const t1 = performance.now();
  const parts = caveZoneParts(grid);
  return { parts, gridMs: Math.round(t1 - t0), partsMs: Math.round(performance.now() - t1) };
}));

if (BIOMES_GROUP) {
  // C1 on cave_heavy (SP6b spec §12.3): both parts the one void share, against 10-22 %, recorded until SP12 (activeFrom
  // 'SP12'); C2 and C9 on cave_heavy recorded in `.out/caves.caveHeavy.json`.
  metricTest('C1', ['caveHeavyMin', 'caveHeavyMax'], async () => {
    const h = await caveHeavy();
    return { caveHeavyMin: h.voidShare, caveHeavyMax: h.voidShare, regions: h.regions };
  }, 900_000, { outName: 'C1.caveHeavy' });

  /**
   * The biome region's T window (ruling P33's second check, re-checked over the measured region): some 8 × 8-chunk tile,
   * in `sp6a.region.T.caves`' order, holds stored nibbles 1, 2 and 3; the first such tile is recorded with the masks.
   */
  test('the biome region still holds its scan\'s T window (ruling P33)', async () => {
    const m = await biomeRegionMeasured();
    const masks = m.biomeTiles!;
    const k = firstBiomeTile(masks);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'caves.biomeRegion.json'), json({
      id: 'caves.biomeRegion', tier: process.env.METRICS_TIER ?? null, region: BIOME_REGION, label: m.site.label,
      tileMasks: masks, firstTile: k < 0 ? null : biomeTiles(BIOME_REGION[0], BIOME_REGION[1])[k],
    }));
    expect(masks).toHaveLength(16);
    expect(k, `no 8 × 8-chunk tile of ${m.site.label} holds nibbles 1, 2 and 3 (masks ${masks.join(', ')})`).toBeGreaterThanOrEqual(0);
  }, 900_000 * TIMEOUT_SCALE);

  /**
   * SP6b's review poses of the biomes group (SP6b spec §12.8): the biome region's (`caveBiomeExamples`: `lush`,
   * `dripstone`, `abyss`, `biomeBorder`; seed '42', default profile) and `caveHeavySpawn`, the `cave_heavy` profile's
   * `findSpawn` at seed '42' (the eye at its voxel's centre, yaw and pitch 0, no component), written to
   * `.out/caveBiomes.examples.json` (Task 56 merges it with `caves.examples.json`'s `bottomCavern`). Every pose found.
   */
  test('the biome region\'s review poses and cave_heavy\'s spawn (caveBiomes.examples.json)', async () => {
    const m = await biomeRegionMeasured();
    const spawn = findSpawn(createGenContext(seedFromInput('42'), resolveProfile('cave_heavy')));
    const biomes = Object.fromEntries(BIOME_EXAMPLE_IDS.map((id) => {
      const p = m.biomeExamples![id];
      return [id, p === null ? null : { ...p, profile: 'default', region: m.site.label }];
    }));
    const caveHeavySpawn = {
      x: spawn.x + 0.5, y: spawn.y + 0.5, z: spawn.z + 0.5, yaw: 0, pitch: 0, voxel: [spawn.x, spawn.y, spawn.z], component: 0,
      profile: 'cave_heavy', fallback: spawn.fallback,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'caveBiomes.examples.json'), json({
      id: 'caveBiomes.examples', tier: process.env.METRICS_TIER ?? null, seed: '42', ...biomes, caveHeavySpawn,
    }));
    for (const id of BIOME_EXAMPLE_IDS) expect(biomes[id], `the ${id} pose`).not.toBeNull();
  }, 900_000 * TIMEOUT_SCALE);

  /**
   * `cave_heavy`'s cave-biome shares (SP6b spec §12.1 "Recorded: … `cave_heavy`'s shares"; Task 28): §12.1's population
   * (tagged air, no fluid, under its nibble; `CaveBorderCounts.air`) over `cave_heavy`'s regions (two at seed '42' on
   * quick, eight on full, none on fast: every share NaN there), pooled and per region, in `.out/B3.caveHeavy.json`.
   */
  test('B3: cave_heavy\'s cave-biome shares (recorded)', async () => {
    const rs = (await measuredRegions()).filter((m) => m.site.profile === 'cave_heavy');
    const shares = (air: Float64Array) => {
      const total = air.reduce((a, v) => a + v, 0);
      return { air: total, ...Object.fromEntries(CAVE_BIOME_NAMES.map((name, b) => [name, total === 0 ? Number.NaN : air[b]! / total])) };
    };
    const pooled = poolBorderCounts(rs.map((m) => m.borders)).air;
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'B3.caveHeavy.json'), json({
      id: 'B3.caveHeavy', tier: process.env.METRICS_TIER ?? null, profile: 'cave_heavy', regions: rs.length, ...shares(pooled),
      perRegion: rs.map((m) => ({ label: m.site.label, ...shares(m.borders.air) })),
    }));
    for (const m of rs) expect(m.borders.air.reduce((a, v) => a + v, 0), `cave air at ${m.site.label}`).toBeGreaterThan(0);
  }, 900_000 * TIMEOUT_SCALE);

  /**
   * B3's regular-grid check (SP6b spec §12.2, Spec corrections 18, 19; Task 28; its zone part gated by `B3.zones` below,
   * Task 30, ruling U4), as built in `test/harness/caveZones.ts`: the picker alone (no T) on a 64-block lattice over
   * 64 × 64 km centred on the origin, seed '42', default profile, at depths 0.3, 0.6 and 1.1; per biome indicator the
   * ratio at lags 256 … 16,384 on both axes (C8's), `zoneAperiodicity` (the smallest), `zonePeriodicDip`,
   * `zoneClarkEvans` and `zoneSizeSpread`, each indicator's values and its ratio per lag, in `.out/B3.zoneGrid.json`.
   * The same on every tier (pure; about 8-10 s on the laptop).
   */
  test('B3: the regular-grid check (recorded)', async () => {
    const { parts, gridMs, partsMs } = await zones();
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'B3.zoneGrid.json'), json({
      id: 'B3.zoneGrid', tier: process.env.METRICS_TIER ?? null, seed: '42', profile: 'default', cells: ZONE_CELLS, step: ZONE_STEP,
      origin: ZONE_ORIGIN, depths: ZONE_DEPTHS, lags: ZONE_LAGS, points: ZONE_CELLS * ZONE_CELLS, gridMs, partsMs, ...parts,
    }));
    // Every biome is read at some depth, so each part has data.
    for (const name of ['lush', 'dripstone', 'abyss']) {
      expect(parts.indicators.some((i) => i.biome === name && i.share > 0), `B3 zones: ${name} at some depth`).toBe(true);
    }
    for (const k of ['zoneAperiodicity', 'zonePeriodicDip', 'zoneClarkEvans', 'zoneSizeSpread'] as const) {
      expect(Number.isFinite(parts[k]), `B3.${k} = ${parts[k]}`).toBe(true);
    }
  }, 600_000 * TIMEOUT_SCALE);

  /**
   * B3's zone part gated (SP6b spec §12.2, Spec correction 19; Task 30, ruling U4, the user's): `zonePeriodicDip` (min
   * 0.9: no dip at a period), with `zoneAperiodicity` (the autocorrelation form §12.2 first proposed, which zones that
   * follow the climate fields miss by design), the smallest and the largest indicator's `zoneClarkEvans`
   * (`zoneClarkEvansMin`, `zoneClarkEvansMax`) and `zoneSizeSpread` recorded beside it.
   */
  metricTest('B3', ['zonePeriodicDip'], async () => {
    const { parts } = await zones();
    const ce = parts.indicators.map((i) => i.clarkEvans).filter((v) => !Number.isNaN(v));
    return {
      zonePeriodicDip: parts.zonePeriodicDip, zoneAperiodicity: parts.zoneAperiodicity,
      zoneClarkEvansMin: ce.length === 0 ? Number.NaN : Math.min(...ce), zoneClarkEvansMax: ce.length === 0 ? Number.NaN : Math.max(...ce),
      zoneSizeSpread: parts.zoneSizeSpread,
    };
  }, 600_000, { outName: 'B3.zones' });
}

// ---------------------------------------------------------------- R3 (SP6b spec §12.4, D22; Task 39)

/** R3's measurement: per pose and per path, with the times. */
interface R3Run {
  readonly poses: Array<{ label: string; kind: string; eye: readonly number[]; pitch: number; underground: boolean; caveKind: number; ms: number } & R3PoseCounts>;
  readonly paths: Array<{ name: string; ms: number } & R3PathCounts>;
  readonly regions: Array<{ label: string; ms: number }>;
}

/**
 * R3 over the biomes group's regions (SP6b spec §12.4): each read again through the region cache (`genRegion` with
 * the measurement's options, so a cache hit after `measureRegions`; R3 generates no region of its own) into an
 * `r3Region` and released; the tier's poses (`r3Poses`) over them in the sites' order, the five paths (`r3Paths`) on
 * the biome region.
 */
async function measureR3(): Promise<R3Run> {
  const rs = sites().filter((s) => s.group === 'biomes');
  const regions: CaveRegion[] = [];
  const regionMs: R3Run['regions'] = [];
  for (const s of rs) {
    const t0 = performance.now();
    const { view } = await genRegion({
      seed: s.seed, params: resolveProfile(s.profile), cx0: s.cx0, cz0: s.cz0, w: s.size, h: s.size, upTo: 'T', order: 'spiral',
      threads: 4, cache: true, workerDir: `cavesRegionWorker-${TIER}`,
    });
    regions.push(r3Region(view, s.label));
    regionMs.push({ label: s.label, ms: Math.round(performance.now() - t0) });
  }
  const biome = rs.findIndex((s) => s.profile === 'default');
  if (biome < 0) throw new Error('caves.metric R3: the biomes group has no biome region');
  const poses = r3Poses(TIER, regions).map((p) => {
    const t0 = performance.now();
    const c = r3PoseCounts(regions[p.region]!, p);
    return {
      label: regions[p.region]!.label, kind: p.kind, eye: p.eye, pitch: p.pitch, underground: p.underground, caveKind: p.caveKind,
      ms: Math.round(performance.now() - t0), ...c,
    };
  });
  const paths = r3Paths(regions[biome]!).map((p) => {
    const t0 = performance.now();
    const c = r3PathCounts(regions[biome]!, p);
    return { name: p.name, ms: Math.round(performance.now() - t0), ...c };
  });
  return { poses, paths, regions: regionMs };
}

/** The p-quantile (nearest rank) of finite values; NaN when none. */
function quantile(values: readonly number[], p: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length === 0 ? Number.NaN : v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
}

if (BIOMES_GROUP) {
  describe('R3', () => {
    /**
     * `R3.wronglyCulled` and `R3.popIn` (SP6b spec §12.4; master :1538; both max 0, every tier, holding by §8.2's
     * construction): the seen sections the culler does not draw once each pose's walk has settled, summed over the
     * tier's poses (fast 8, quick 32, full 64); the seen sections the draw rule hides frame by frame over the five
     * paths, summed. `R3.culledUnderground` (§12.4-§12.5, min 0.5, every tier, gated from D25's culling checkpoint,
     * Task 40): the culled share of non-empty sections, 1 − drawn / non-empty pooled over the underground poses.
     * Recorded: per pose its counts (`.out/R3.poses.json`); the culled share's p10 and median per underground pose, the
     * surface poses' pooled share; the walk's over-draw (stamped / seen, pooled over the poses a walk culls); the pops
     * per walk (median, max).
     */
    metricTest('R3', ['wronglyCulled', 'popIn', 'culledUnderground'], async () => {
      const run = await measureR3();
      const under = run.poses.filter((p) => p.underground);
      const surface = run.poses.filter((p) => p.kind === 'surface');
      const pooled = (ps: typeof run.poses): number => {
        const n = ps.reduce((a, p) => a + p.nonEmpty, 0);
        return n === 0 ? Number.NaN : 1 - ps.reduce((a, p) => a + p.nonEmptyDrawn, 0) / n;
      };
      const walked = run.poses.filter((p) => Number.isFinite(p.stamped));
      const seenWalked = walked.reduce((a, p) => a + p.seen, 0);
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, 'R3.poses.json'), json({ id: 'R3.poses', tier: process.env.METRICS_TIER ?? null, ...run }));
      expect(run.poses).toHaveLength(R3_POSE_COUNTS[TIER]);
      expect(under.length, 'R3: underground poses').toBeGreaterThan(0);
      return {
        wronglyCulled: run.poses.reduce((a, p) => a + p.wronglyCulled, 0),
        popIn: run.paths.reduce((a, p) => a + p.popIn, 0),
        culledUnderground: pooled(under),
        culledUndergroundP10: quantile(under.map((p) => p.culledShare), 0.1),
        culledUndergroundMedian: quantile(under.map((p) => p.culledShare), 0.5),
        culledSurface: pooled(surface),
        overDraw: seenWalked === 0 ? Number.NaN : walked.reduce((a, p) => a + p.stamped, 0) / seenWalked,
        popsPerWalkMedian: quantile(walked.map((p) => p.pops), 0.5),
        popsPerWalkMax: quantile(walked.map((p) => p.pops), 1),
        poses: run.poses.length,
        undergroundPoses: under.length,
        seen: run.poses.reduce((a, p) => a + p.seen, 0),
        pathFrames: run.paths.reduce((a, p) => a + p.frames, 0),
        pathCastFrames: run.paths.reduce((a, p) => a + p.castFrames, 0),
      };
    }, 900_000);
  });
}

// B5's lake windows (SP7a spec §13.2, §14's lever (2), Task 55b; rulings P53): moved here from `region.metric.ts`, so
// metrics-quick reads them in the biomes group's job (`caves-biomes-persist`) instead of `region`, and the fast tier
// in `terrain-caves` (every group in one process) instead of metrics-fast `rest`. Their record and reading are
// unchanged: they read none of the group's regions.
if (BIOMES_GROUP) {
  /**
   * B5's lake rim on T and its settled spill (SP7a spec §13.2, master §6.4's B5 third part; Task 25), recorded (gated at
   * the tuning, Task 31), at seed '42', profile default: the first `LAKE_WINDOWS` (fast 4, quick 16, full 32) enabled lake
   * cells (`lakeCell`, `src/gen/column/lakes.ts`) in the square spiral of cells from (0, 0) (`liveness.ts`' order: ring r
   * from (−r, −r) along j = −r, then i = r, j = r, i = −r), each read on a T window of 6 × 6 chunks around the chunk of its
   * centre (cx0 = ⌊cx / 16⌋ − 3, likewise z; spiral, 4 threads, no cache):
   * - the lake mask of the window's positions: 1 where the nearest quart corner's `lakeLevel` is finite (`readLevel` over
   *   `buildColumnSample`), the positions where D19 fills to Lw;
   * - `lakeAirAdjacent` on T and, after `referenceSettle` over the whole window, `lakeSpill` (`test/harness/water.ts`'
   *   `lakeAirAdjacentCount` and `lakeSpillCount`, whose header states both definitions), summed over the windows.
   * The cell's centre lies in warped lake space, so a window may hold its lake whole, a part with its shore, or none of
   * it: each window's lake positions and shore positions (its positions outside the mask beside one inside, 4-connected)
   * are recorded with its counts and its cell (`.<i>`). Written to `.out/B5.lake.json` (`metricTest`'s record layout).
   */
  const LAKE_WINDOWS = pick(4, 16, 32);
  /** A lake window's side, chunks. */
  const LAKE_WINDOW_SIDE = 6;
  /** The most cells the spiral visits looking for `LAKE_WINDOWS` enabled ones. */
  const LAKE_CELLS_MAX = 4096;

  /** The first `n` enabled lake cells of `ctx` in the square spiral of cells from (0, 0) (see above). */
  function lakeCellsInSpiral(ctx: GenContext, n: number): LakeCell[] {
    const out: LakeCell[] = [];
    const visit = (i: number, j: number): boolean => {
      const c = lakeCell(ctx, i, j);
      if (c.enabled) out.push(c);
      return out.length === n;
    };
    let seen = 1;
    if (!visit(0, 0)) {
      spiral: for (let r = 1; seen < LAKE_CELLS_MAX; r++) {
        for (let i = -r; i <= r; i++, seen++) if (visit(i, -r)) break spiral;
        for (let j = 1 - r; j <= r; j++, seen++) if (visit(r, j)) break spiral;
        for (let i = r - 1; i >= -r; i--, seen++) if (visit(i, r)) break spiral;
        for (let j = r - 1; j > -r; j--, seen++) if (visit(-r, j)) break spiral;
      }
    }
    if (out.length < n) throw new Error(`B5: ${out.length} enabled lake cells in the first ${seen} of the spiral, not ${n}`);
    return out;
  }

  /** The lake mask of the window (cx0, cz0, side × side chunks): see above. */
  function lakeMaskOf(ctx: GenContext, cx0: number, cz0: number, side: number): Uint8Array {
    const W = 16 * side;
    const mask = new Uint8Array(W * W);
    const sample = newColumnSample();
    for (let cz = cz0; cz < cz0 + side; cz++) {
      for (let cx = cx0; cx < cx0 + side; cx++) {
        buildColumnSample(ctx, cx, cz, sample);
        for (let z = 16 * cz; z < 16 * cz + 16; z++) {
          for (let x = 16 * cx; x < 16 * cx + 16; x++) {
            if (Number.isFinite(readLevel(sample, 'lakeLevel', x, z))) mask[(z - 16 * cz0) * W + (x - 16 * cx0)] = 1;
          }
        }
      }
    }
    return mask;
  }

  test('B5 lakeAirAdjacent on T and B5.lakeSpill after settle over the lake windows (recorded; SP7a §13.2, gated at the tuning)', async () => {
    const t0 = performance.now();
    const params = resolveProfile('default');
    const ctx = createGenContext(seedFromInput('42'), params);
    const values: Record<string, number> = {};
    let lakeAirAdjacent = 0;
    let lakeSpill = 0;
    let lakePositions = 0;
    let shorePositions = 0;
    let windowsWithShore = 0;
    let genMs = 0;
    let referenceMs = 0;
    const W = 16 * LAKE_WINDOW_SIDE;
    for (const [i, cell] of lakeCellsInSpiral(ctx, LAKE_WINDOWS).entries()) {
      const cx0 = Math.floor(cell.cx / 16) - LAKE_WINDOW_SIDE / 2;
      const cz0 = Math.floor(cell.cz / 16) - LAKE_WINDOW_SIDE / 2;
      const g = await genRegion({
        seed: '42', params, cx0, cz0, w: LAKE_WINDOW_SIDE, h: LAKE_WINDOW_SIDE, upTo: 'T', order: 'spiral', threads: 4, workerDir: dt1WorkerDir(TIER),
      });
      genMs += g.timings.totalMs;
      const mask = lakeMaskOf(ctx, cx0, cz0, LAKE_WINDOW_SIDE);
      let lake = 0;
      let shore = 0;
      for (let z = 0; z < W; z++) {
        for (let x = 0; x < W; x++) {
          if (mask[z * W + x] === 1) { lake++; continue; }
          const beside = (x > 0 && mask[z * W + x - 1] === 1) || (x + 1 < W && mask[z * W + x + 1] === 1)
            || (z > 0 && mask[(z - 1) * W + x] === 1) || (z + 1 < W && mask[(z + 1) * W + x] === 1);
          if (beside) shore++;
        }
      }
      const air = lakeAirAdjacentCount(g.view, mask);
      const r0 = performance.now();
      const settled = referenceSettle(g.view, { x0: 16 * cx0, z0: 16 * cz0, x1: 16 * cx0 + W, z1: 16 * cz0 + W });
      referenceMs += performance.now() - r0;
      const spill = lakeSpillCount(g.view, settled, mask);
      lakeAirAdjacent += air;
      lakeSpill += spill;
      lakePositions += lake;
      shorePositions += shore;
      if (shore > 0) windowsWithShore++;
      Object.assign(values, {
        [`cellI.${i}`]: cell.i, [`cellJ.${i}`]: cell.j, [`lw.${i}`]: cell.Lw, [`cx0.${i}`]: cx0, [`cz0.${i}`]: cz0,
        [`lakePositions.${i}`]: lake, [`shorePositions.${i}`]: shore, [`lakeAirAdjacent.${i}`]: air, [`lakeSpill.${i}`]: spill,
        [`referenceChanged.${i}`]: settled.size,
      });
    }
    const record = {
      lakeAirAdjacent, lakeSpill, windows: LAKE_WINDOWS, windowsWithShore, lakePositions, shorePositions, ...values,
      genSeconds: Math.round(genMs) / 1000, referenceSeconds: Math.round(referenceMs) / 1000, seconds: Math.round(performance.now() - t0) / 1000,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'B5.lake.json'), `${JSON.stringify({ id: 'B5', tier: process.env.METRICS_TIER ?? null, values: record }, null, 2)}\n`);
    expect(windowsWithShore, 'B5: lake windows holding a shore').toBeGreaterThan(0);
  }, 600_000);
}

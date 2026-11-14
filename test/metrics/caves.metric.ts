import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { CARVER_WINDOW_R, CAVE_BIOME_NAMES } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { carverPath, type CarverKind, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import {
  abyssRockStraight, aperiodicRatios, BIOME_EXAMPLE_IDS, poolAbyssRockCounts, poolBorderCounts, borderSampleProblems, bandDetail, borderPlaneRatio, BORDER_PAIR_NAMES, C1_C6_PARTS, caveBorderParts, c1c6Parts, C7_C9_PARTS, c7c9Groups, c7c9Parts, caveBottomGroups, caveBottomParts, emptyBandCounts,
  emptyLayerCounts, emptyWallResidues, EXAMPLE_IDS, floorFaceResidues, GRID_H, GRID_Y0, SP6B_EXAMPLE_IDS, verticalStepDetail, worstToBound,
  type C1C6Part, type C7C9Part, type CaveBottomParts, type CaveC7C9Counts, type CavePose, type CaveRegionCounts,
} from '../harness/caveMetrics';
import type { CaveRegionResult } from '../harness/caveRegionWorker';
import { CARVER_DEFAULTS, CARVER_MAXIMA } from '../harness/carverParams';
import { BIOME_REGION, biomeTiles, caveGroupOf, caveSites, firstBiomeTile, measureCaveRegions, type CaveGroup, type Site } from '../harness/caveSites';
import { caveZoneGrid, caveZoneParts, ZONE_CELLS, ZONE_DEPTHS, ZONE_LAGS, ZONE_ORIGIN, ZONE_STEP, type ZoneParts } from '../harness/caveZones';
import { metricTest } from '../harness/metric';
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
 *   of C7-C9 (`C7.tuning`: verticalStep, flatWallShare, waterWall; `C9`: nearestEntrance, holedSurface) and C7's
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
 *   `cave_heavy`'s per-biome cave-air shares over its regions (§12.1) in `.out/B3.caveHeavy.json`.
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

/** C7's and C9's per-group parts (each the worst of the groups measured, `c7c9Parts`), gated in every group's job. */
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
    walls: m.c79.flat.faces, flatWalls: m.c79.flat.flat, waterWall: m.c79.waterWall, deepSky: m.c79.deepSky,
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { CARVER_WINDOW_R } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { carverPath, type CarverKind, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import { ringCandidates } from '../../src/metrics/sp3eGoldens';
import { AIR } from '../../src/world/blocks/index';
import {
  aperiodicRatios, bandDetail, borderPlaneRatio, C1_C6_PARTS, c1c6Parts, C7_C9_PARTS, c7c9Groups, c7c9Parts, caveC7C9Counts,
  caveComponents, caveExamples, caveGridOf, caveRegionCounts, emptyBandCounts, emptyLayerCounts, emptyWallResidues, EXAMPLE_IDS,
  GRID_H, GRID_Y0, landMask, localThickness, preCaveTops, ravinePathsOf, riverMaskOf, verticalStepDetail, wetMask,
  type C1C6Part, type C7C9Part, type CaveC7C9Counts, type CavePose, type CaveRegionCounts, type ExampleId,
} from '../harness/caveMetrics';
import { CARVER_DEFAULTS, CARVER_MAXIMA } from '../harness/carverParams';
import { metricTest } from '../harness/metric';
import { referenceCarve } from '../harness/refs';
import { genRegion, type RegionView } from '../harness/region';

/**
 * The caves' metrics (SP6a spec §10.1, D26), over harness regions up to 'T' with the tag read from the store
 * (`RegionView.tag`). The regions:
 * - fast: 2 regions 16 × 16 of seed '42', profile default;
 * - quick: per seed '42' and '1', 2 regions 32 × 32 of the default profile and 1 of large_biomes; and one 32 × 32 region
 *   of seed '42' on each of archipelago (a coast and sea floor), amplified (summits and deep columns) and
 *   floating_islands (the island cap), found by the scan below and fixed here;
 * - full: the quick set over seeds '42', '1', '2', '3': per seed 2 default regions, 1 of large_biomes and one per preset,
 *   the preset regions of seeds '1', '2' and '3' found by the same scan when the tier runs.
 * The preset regions' scan (seed '42' run once: `PRESET_REGIONS` holds what it found, and the metric re-checks that each
 * still satisfies its predicate): candidate R(a, b) is the 32 × 32 chunks centred on block (128a, 128b), chunk origin
 * (8a − 16, 8b − 16), in the rings of `sp3eGoldens.ts`' window search (r = 0, 1, …; within a ring a then b ascending);
 * its 256 lattice points are the block centres (x0 + 32i + 16, z0 + 32j + 16), i, j in 0 … 15, read through
 * `columnPoint` on the preset's context; the first candidate whose predicate holds is the preset's region (at seed '42'):
 * - archipelago: 64 … 192 of the points have offset0 < 63 (a coast and its sea floor): R(1, −2), 68 points at sea;
 * - amplified: the largest offset0 ≥ 200 (summits) and ≥ 64 points with offset0 ≥ 180 (deep columns of rock):
 *   R(−5, −1), 65 points ≥ 180, the largest 209;
 * - floating_islands: ≥ 64 points with islandMask ≥ 0.9 (islands overhead, under the cap): R(−2, −1), 81 points.
 *
 * C7's construction parts (D26: hold by construction, gated from this commit, max 0):
 * - `carverReference`: over every region of the tier (the preset regions included), the voxels of the region whose
 *   carver kind in the store (the tag when it is a carver's, 6-8, else 0) differs from `referenceCarve`'s, the global
 *   reference that carves every path whose box meets the region with no per-column window. The reference has no border
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
 * over the default regions only (`defaultSites`), with the instruments of `test/harness/caveMetrics.ts`.
 *
 * C7's tuning parts, C8 and C9 (D26: gated from Task 38): the second 'C7' test (its record `.out/C7.tuning.json`, beside
 * the construction parts' `.out/C7.json`), 'C8' and 'C9', over every region of the tier (the default group: default
 * and large_biomes; and each preset's), with the definitions as built in `caveMetrics.ts`; their measurement also
 * writes `.out/caves.examples.json`, the review poses at seed '42' (§10.1, §10.10, D16). `C8.largeShare` is recorded,
 * not gated (ruling R21). Each region is measured once for every test (`measure`: one grid, one set of components),
 * and each group of parts once (`c1c6`, `c7c9`: the first test to ask takes it).
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

/** A region of the tier: a seed, a profile and R's rectangle. */
interface Site {
  readonly label: string;
  readonly seed: string;
  readonly profile: ProfileId;
  readonly cx0: number;
  readonly cz0: number;
  readonly size: number;
}

type PresetId = 'archipelago' | 'amplified' | 'floating_islands';

/** The preset regions' scan candidates R(a, b) as found at seed '42' (see the header). */
const PRESET_REGIONS: ReadonlyArray<readonly [PresetId, a: number, b: number]> = [
  ['archipelago', 1, -2],
  ['amplified', -5, -1],
  ['floating_islands', -2, -1],
];

/** The scan's predicate on R(a, b) of `preset` at world seed `seed` (see the header). */
function presetRegionHolds(preset: PresetId, seed: string, a: number, b: number): boolean {
  const ctx = createGenContext(seedFromInput(seed), resolveProfile(preset));
  const x0 = 128 * a - 256;
  const z0 = 128 * b - 256;
  let sea = 0;
  let deep = 0;
  let highest = -Infinity;
  let islands = 0;
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16; i++) {
      const p = columnPoint(ctx, x0 + 32 * i + 16, z0 + 32 * j + 16);
      if (p.offset0 < 63) sea++;
      if (p.offset0 >= 180) deep++;
      highest = Math.max(highest, p.offset0);
      if (p.islandMask >= 0.9) islands++;
    }
  }
  if (preset === 'archipelago') return sea >= 64 && sea <= 192;
  if (preset === 'amplified') return highest >= 200 && deep >= 64;
  return islands >= 64;
}

/** The scan (see the header): the first candidate R(a, b), rings 0 … 64, whose predicate holds at `seed`. */
function findPresetRegion(preset: PresetId, seed: string): readonly [a: number, b: number] {
  for (let r = 0; r <= 64; r++) {
    for (const [a, b] of ringCandidates(r)) if (presetRegionHolds(preset, seed, a, b)) return [a, b];
  }
  throw new Error(`caves.metric: no ${preset} region at seed '${seed}' within ring 64`);
}

const DEFAULT_SEEDS: readonly string[] = pick(['42'], ['42', '1'], ['42', '1', '2', '3']);
/** The seeds of the preset regions: '42' (fixed) on quick, and the full tier's other seeds (scanned). */
const PRESET_SEEDS: readonly string[] = pick([], ['42'], ['42', '1', '2', '3']);

/** A preset's region at `seed`: the fixed one at seed '42', which still holds its predicate, else the scan's. */
function presetRegion(preset: PresetId, seed: string): readonly [a: number, b: number] {
  if (seed !== '42') return findPresetRegion(preset, seed);
  const [, a, b] = PRESET_REGIONS.find(([p]) => p === preset)!;
  expect(presetRegionHolds(preset, seed, a, b), `${preset}'s region R(${a}, ${b}) no longer holds its scan's predicate`).toBe(true);
  return [a, b];
}

/** The tier's default regions (the default and large_biomes profiles), where the default parts (C1-C6) run. */
function defaultSites(): Site[] {
  if (TIER === 'fast') {
    return [
      { label: "seed '42' default (-8, -8)", seed: '42', profile: 'default', cx0: -8, cz0: -8, size: 16 },
      { label: "seed '42' default (8, -8)", seed: '42', profile: 'default', cx0: 8, cz0: -8, size: 16 },
    ];
  }
  const out: Site[] = [];
  for (const seed of DEFAULT_SEEDS) {
    out.push({ label: `seed '${seed}' default (-16, -16)`, seed, profile: 'default', cx0: -16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' default (16, -16)`, seed, profile: 'default', cx0: 16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' large_biomes (-16, -16)`, seed, profile: 'large_biomes', cx0: -16, cz0: -16, size: 32 });
  }
  return out;
}

/** Every region of the tier: the default regions, then the preset regions. */
function sites(): Site[] {
  const out = defaultSites();
  for (const seed of PRESET_SEEDS) {
    for (const [preset] of PRESET_REGIONS) {
      const [a, b] = presetRegion(preset, seed);
      out.push({ label: `seed '${seed}' ${preset} R(${a}, ${b})`, seed, profile: preset, cx0: 8 * a - 16, cz0: 8 * b - 16, size: 32 });
    }
  }
  return out;
}

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

/** A column's set in the view: its final set at Decorated or above, else its proto set. */
function columnOf(view: RegionView, cx: number, cz: number) {
  const c = view.store.final(cx, cz) ?? view.store.proto(cx, cz);
  if (c === null) throw new Error(`caves.metric: column (${cx}, ${cz}) has no set`);
  return c;
}

/**
 * The voxels of the region whose store carver kind (the tag when 6-8, else 0) differs from `ref`'s, the carver-tagged
 * voxels, and with `capY` the tagged voxels at y ≥ capY and the non-air voxels at y ≥ 181.
 */
function regionCounts(view: RegionView, ref: Uint8Array, capY: number | null): { mismatches: number; carved: number; capAir: number; islandVoxels: number; examples: string[] } {
  const W = 16 * view.w;
  const D = 16 * view.h;
  let mismatches = 0;
  let carved = 0;
  let capAir = 0;
  let islandVoxels = 0;
  const examples: string[] = [];
  for (let cz = view.cz0; cz < view.cz0 + view.h; cz++) {
    for (let cx = view.cx0; cx < view.cx0 + view.w; cx++) {
      const col = columnOf(view, cx, cz);
      const bx = 16 * (cx - view.cx0);
      const bz = 16 * (cz - view.cz0);
      for (let sy = 0; sy < 24; sy++) {
        const cave = col.sectionCave(sy);
        const blocks = col.sectionBlocks(sy);
        for (let ly = 0; ly < 16; ly++) {
          const y = 16 * sy - 64 + ly;
          for (let lz = 0; lz < 16; lz++) {
            const row = ((y + 64) * D + bz + lz) * W + bx;
            for (let lx = 0; lx < 16; lx++) {
              const i = ly * 256 + lz * 16 + lx;
              const tag = typeof cave === 'number' ? cave : cave[i]!;
              const kind = tag >= 6 && tag <= 8 ? tag : 0;
              if (kind !== 0) carved++;
              const want = ref[row + lx]!;
              if (kind !== want) {
                mismatches++;
                if (examples.length < 10) examples.push(`(${16 * cx + lx}, ${y}, ${16 * cz + lz}) stored ${tag}, reference ${want}`);
              }
              if (capY !== null) {
                if (y >= capY && tag !== 0) capAir++;
                const block = typeof blocks === 'number' ? blocks : blocks[i]!;
                if (y >= 181 && block !== AIR) islandVoxels++;
              }
            }
          }
        }
      }
    }
  }
  return { mismatches, carved, capAir, islandVoxels, examples };
}

/** The y from which the floating_islands region holds no cave air (§10.1's `islandCapAir`). */
const CAP_AIR_Y = 176;

metricTest('C7', ['carverReference', 'reachOverflow', 'endTaper', 'islandCapAir'], async () => {
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

  let mismatches = 0;
  let carved = 0;
  let capAir = Number.NaN;
  let islandVoxels = Number.NaN;
  const all = sites();
  for (const s of all) {
    const params = resolveProfile(s.profile);
    const { view } = await genRegion({
      seed: s.seed, params, cx0: s.cx0, cz0: s.cz0, w: s.size, h: s.size, upTo: 'T', order: 'spiral', threads: 4,
      cache: true, workerDir: `cavesRegionWorker-${TIER}`,
    });
    const island = s.profile === 'floating_islands';
    const c = regionCounts(view, referenceCarve(view, s.seed, params), island ? CAP_AIR_Y : null);
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
  return {
    carverReference: mismatches, reachOverflow: reach.overflow, endTaper: taper.bad, islandCapAir: capAir,
    regions: all.length, carverVoxels: carved, reachPaths: reach.paths, reachDeepest: reach.deepest,
    taperEnds: taper.ends, taperRooms: taper.rooms, taperBranched: taper.branched, islandVoxels,
  };
});

// ---------------------------------------------------------------- C1-C9, the tuning parts (D26)

const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));

/** C7.switchWall's chunk stride: the T of every 2nd chunk's columns in x and z on fast, every 4th on quick and full. */
const SWITCH_STRIDE = pick(2, 4, 4);

/** One region's measurements: C1-C6 (the default group only), C7-C9, and at seed '42' default the review poses. */
interface Measured {
  readonly site: Site;
  readonly c16: CaveRegionCounts | null;
  readonly c79: CaveC7C9Counts;
  readonly examples: Record<ExampleId, CavePose | null> | null;
  /** The ms of the shared grid and components, of C1-C6 (with the thickness), of C7-C9, of the poses. */
  readonly ms: { shared: number; c16: number; c79: number; examples: number };
}

/** The measured regions by label: each region is measured once, by whichever test asks first. */
const MEASURED = new Map<string, Measured>();

/** The group of C7-C9's "default and presets": 'default' for the default and large_biomes profiles, else the preset. */
const groupOf = (s: Site): string => (s.profile === 'default' || s.profile === 'large_biomes' ? 'default' : s.profile);

async function measure(s: Site): Promise<Measured> {
  const done = MEASURED.get(s.label);
  if (done !== undefined) return done;
  const params = resolveProfile(s.profile);
  const { view } = await genRegion({
    seed: s.seed, params, cx0: s.cx0, cz0: s.cz0, w: s.size, h: s.size, upTo: 'T', order: 'spiral', threads: 4,
    cache: true, workerDir: `cavesRegionWorker-${TIER}`, debugTags: true,
  });
  const isDefault = groupOf(s) === 'default';
  const t0 = performance.now();
  const grid = caveGridOf(view);
  const tops = preCaveTops(grid);
  const c = caveComponents(grid, tops);
  const t1 = performance.now();
  const pillar = (x: number, y: number, z: number): boolean => view.pillar(x, y, z);
  const thick = isDefault ? localThickness(c, grid.w, grid.d) : null;
  const c16 = isDefault ? caveRegionCounts(grid, pillar, ravinePathsOf(grid, s.seed, params), 128, { tops, c, thick }) : null;
  const t2 = performance.now();
  const land = landMask(grid);
  const river = riverMaskOf(grid, s.seed, params);
  const eligible = land.map((v, p) => (v === 1 && river[p] === 0 ? 1 : 0));
  const c79 = caveC7C9Counts(grid, tops, c, {
    T: isDefault ? (x, y, z) => view.terrainT(x, y, z) : null, stride: SWITCH_STRIDE, eligible,
    seaFloor: s.profile === 'archipelago' ? wetMask(grid) : null,
  });
  const t3 = performance.now();
  const examples = s.seed === '42' && s.profile === 'default' ? caveExamples(grid, tops, c, thick, pillar) : null;
  const t4 = performance.now();
  const m: Measured = {
    site: s, c16, c79, examples,
    ms: { shared: Math.round(t1 - t0), c16: Math.round(t2 - t1), c79: Math.round(t3 - t2), examples: Math.round(t4 - t3) },
  };
  MEASURED.set(s.label, m);
  return m;
}

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
 * written to `.out/caves.C1-C6.json`: the parts, the value per profile, C5.thinnest's components per value, and per
 * region its counts' summary. Every part is finite (fast: or listed in `NAN_ON_FAST`).
 */
async function measureC1C6(): Promise<Record<C1C6Part, number>> {
  const measured: Array<{ site: Site; counts: CaveRegionCounts; ms: number }> = [];
  for (const s of defaultSites()) {
    const m = await measure(s);
    measured.push({ site: s, counts: m.c16!, ms: m.ms.shared + m.ms.c16 });
  }
  const parts = c1c6Parts(measured.map((m) => ({ profile: m.site.profile, counts: m.counts })));
  const profiles = [...new Set(measured.map((m) => m.site.profile))];
  const perProfile = Object.fromEntries(profiles.map((p) => [p, c1c6Parts(measured.filter((m) => m.site.profile === p).map((m) => ({ profile: p, counts: m.counts })))]));
  const nan = C1_C6_PARTS.filter((p) => Number.isNaN(parts[p]));
  // Per profile, the bands' carve rates and residue ratios behind C4.bands and C6.latticeBias.
  const bands = Object.fromEntries(profiles.map((p) => {
    const sum = emptyBandCounts();
    for (const m of measured) {
      if (m.site.profile !== p) continue;
      for (const k of Object.keys(sum) as Array<keyof typeof sum>) for (let i = 0; i < sum[k].length; i++) sum[k][i]! += m.counts.bands[k][i]!;
    }
    return [p, bandDetail(sum)];
  }));
  const regions = measured.map(({ site, counts: c, ms }) => ({
    label: site.label, profile: site.profile, ms,
    ...c1c6Parts([{ profile: site.profile, counts: c }]),
    tagged: c.kinds.reduce((a, k) => a + k, 0), components: c.components, skyComponentsAll: c.skyComponents,
    tiles: c.pillars.tiles, tilesWithPillar: c.pillars.withPillar, ravineSources: c.ravines.sources,
    ravineSkySources: c.ravines.skySources, ravineVoxels: c.ravines.voxels, landPositions: c.land.land,
    thinnestComponents: c.thinnest.all.length, cheeseComponents: c.thinnest.cheese.length,
    spaghetti3dComponents: c.thinnest.spaghetti3d.length,
  }));
  // C5.thinnest's population: how many components ≥ 64 voxels read each thinnest axis, pooled over the regions.
  const histOf = (pick: (t: CaveRegionCounts['thinnest']) => number[]): Record<string, number> => {
    const hist: Record<string, number> = {};
    for (const m of measured) for (const v of pick(m.counts.thinnest)) hist[String(v)] = (hist[String(v)] ?? 0) + 1;
    return hist;
  };
  const thinnest = { all: histOf((t) => t.all), cheese: histOf((t) => t.cheese), spaghetti3d: histOf((t) => t.spaghetti3d) };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'caves.C1-C6.json'), json({
    id: 'C1-C6', tier: process.env.METRICS_TIER ?? null, values: parts, nanParts: nan, perProfile, bands, thinnest, regions,
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
 * C7's tuning parts, C8 and C9 (SP6a spec §10.1, D26: gated from Task 38): measured over every region of the tier by
 * `caveC7C9Counts` (definitions as built in `test/harness/caveMetrics.ts`) and written to `.out/caves.C7-C9.json` (the
 * parts, the per-group values of the "default and presets" parts, each part's detail, and per region its counts'
 * summary). The review poses at seed '42' (§10.1, §10.10, D16) go to `.out/caves.examples.json`: per pose, the first of
 * the tier's seed '42' default regions (in `defaultSites`' order) holding one. Every part is finite (fast: or listed in
 * `C79_NAN_ON_FAST`), and every pose found.
 */
async function measureC7C9(): Promise<Record<C7C9Part, number>> {
  const measured: Measured[] = [];
  for (const s of sites()) measured.push(await measure(s));
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
  // The review poses: per id the first seed '42' default region holding one.
  const poses: Record<string, (CavePose & { region: string }) | null> = {};
  for (const id of EXAMPLE_IDS) {
    const m = measured.find((r) => r.examples !== null && r.examples[id] !== null);
    poses[id] = m === undefined ? null : { ...m.examples![id]!, region: m.site.label };
  }
  writeFileSync(join(OUT_DIR, 'caves.examples.json'), json({
    id: 'caves.examples', tier: process.env.METRICS_TIER ?? null, seed: '42', profile: 'default', poses,
  }));
  for (const p of C7_C9_PARTS) {
    const v = parts[p];
    if (TIER === 'fast' && Number.isNaN(v)) expect(C79_NAN_ON_FAST, `${p} is NaN on fast`).toContain(p);
    else expect(Number.isFinite(v), `${p} = ${v} is not finite`).toBe(true);
  }
  for (const id of EXAMPLE_IDS) expect(poses[id], `the ${id} pose`).not.toBeNull();
  return parts;
}

let c79Run: Promise<Record<C7C9Part, number>> | null = null;
/** C7's tuning parts, C8 and C9, measured once (the first test to ask). */
const c7c9 = (): Promise<Record<C7C9Part, number>> => (c79Run ??= measureC7C9());

/** The parts of metric `id` among `parts` ('C3.pillars' → 'pillars'). */
function partsOf(parts: Readonly<Record<string, number>>, id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parts)) if (k.startsWith(`${id}.`)) out[k.slice(id.length + 1)] = v;
  return out;
}

// The rows (SP6a spec §10.1, Task 38, ruling R21): each id's parts at their bounds in `test/thresholds.ts`. The first
// test of each group measures it (its timeout covers the regions); the others read the same values.
metricTest('C1', ['voidShareMin', 'voidShareMax'], async () => partsOf(await c1c6(), 'C1'), 900_000);
metricTest('C2', ['skyComponents', 'skyShare'], async () => partsOf(await c1c6(), 'C2'));
metricTest('C3', ['cheeseShare', 'spaghettiShare', 'noodleShare', 'carverShare', 'entranceShare', 'pillars', 'ravines', 'ravinesSky', 'maxShare'],
  async () => partsOf(await c1c6(), 'C3'));
metricTest('C4', ['bands', 'floorPeak'], async () => partsOf(await c1c6(), 'C4'));
// C5.largest is gated on quick and full (ruling R21 (e): fast's 16 × 16 regions read it high by their size).
metricTest('C5', ['largest', 'landCarved', 'thinnest', 'thinnestByKind'], async () => partsOf(await c1c6(), 'C5'));
metricTest('C6', ['latticeBias'], async () => partsOf(await c1c6(), 'C6'));
metricTest('C7', ['borderPlaneRatio', 'verticalStep', 'flatWallShare', 'switchWall', 'waterWall'], async () => partsOf(await c7c9(), 'C7'), 900_000,
  { outName: 'C7.tuning' });
// C8.largeShare is returned and recorded in `.out/C8.json`, not gated (ruling R21 (c)); aperiodicity and sizeSpread
// are gated on quick and full (NaN on fast, ruling P32).
metricTest('C8', ['aperiodicity', 'typeMixVariation', 'sizeSpread'], async () => partsOf(await c7c9(), 'C8'));
metricTest('C9', ['nearestEntrance', 'entrancesMax', 'holedSurface', 'thinRoof'], async () => partsOf(await c7c9(), 'C9'));

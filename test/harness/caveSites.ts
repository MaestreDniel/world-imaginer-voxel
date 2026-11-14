import { Worker } from 'node:worker_threads';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { columnPoint, newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import { ringCandidates } from '../../src/metrics/sp3eGoldens';
import { biomeTileMasks, caveGridOf } from './caveMetrics';
import type { CaveRegionMsg, CaveRegionReply, CaveRegionResult } from './caveRegionWorker';
import { ask, buildNodeTaskWorker } from './nodeWorker';
import { genRegion } from './region';

/**
 * The caves metric's regions per tier and group (SP6a spec §10.1; SP6b spec §13 L4), moved out of
 * `test/metrics/caves.metric.ts` so a unit test reads the lists without importing a metric file (which would register
 * its metric tests). The regions, every one 'T'-deep through the harness:
 * - fast: 2 regions 16 × 16 of seed '42', profile default;
 * - quick: per seed '42' and '1', 2 regions 32 × 32 of the default profile and 1 of large_biomes; and one 32 × 32 region
 *   of seed '42' on each of archipelago (a coast and sea floor), amplified (summits and deep columns) and
 *   floating_islands (the island cap), found by the scan below and fixed here;
 * - full: the quick set over seeds '42', '1', '2', '3': per seed 2 default regions, 1 of large_biomes and one per preset,
 *   the preset regions of seeds '1', '2' and '3' found by the same scan when the tier runs.
 * The groups (`METRICS_CAVE_GROUPS`, one per CI job): `default` the default and large_biomes regions, `presets` the
 * preset regions, `biomes` (SP6b spec §12.2-§12.3, §13; the `caves-biomes` job, Task 27; rulings P2, P28) `cave_heavy`'s
 * two 32 × 32 regions at (−16, −16) and (16, −16) (the default group's origins) per seed ('42' on quick, '42', '1', '2'
 * and '3' on full, none on fast) and then the biome region (every tier); absent, every group of the tier (ruling P2).
 *
 * The preset regions' scan (seed '42' run once: `PRESET_REGIONS` holds what it found, and `caveSites` re-checks that
 * each still satisfies its predicate): candidate R(a, b) is the 32 × 32 chunks centred on block (128a, 128b), chunk
 * origin (8a − 16, 8b − 16), in the rings of `sp3eGoldens.ts`' window search (r = 0, 1, …; within a ring a then b
 * ascending); its 256 lattice points are the block centres (x0 + 32i + 16, z0 + 32j + 16), i, j in 0 … 15, read through
 * `columnPoint` on the preset's context; the first candidate whose predicate holds is the preset's region (at seed '42'):
 * - archipelago: 64 … 192 of the points have offset0 < 63 (a coast and its sea floor): R(1, −2), 68 points at sea;
 * - amplified: the largest offset0 ≥ 200 (summits) and ≥ 64 points with offset0 ≥ 180 (deep columns of rock):
 *   R(−5, −1), 65 points ≥ 180, the largest 209;
 * - floating_islands: ≥ 64 points with islandMask ≥ 0.9 (islands overhead, under the cap): R(−2, −1), 81 points.
 *
 * The biome region (SP6b spec §12.2; ruling P33): a 32 × 32-chunk region of the default profile at seed '42' that holds
 * all three cave biomes, so B3's borders sample each biome | plain pair (the abyss's above all, which the default
 * regions lack). The scan, over the preset scan's candidates R(a, b) in the same ring order (chunk origin
 * (8a − 16, 8b − 16)), takes the first candidate that passes two checks, the second run only when the first passes:
 * - climate only (as §1.6's; no T): `samplePoint` on a 64-block grid, the 64 block centres (x0 + 64i + 32,
 *   z0 + 64j + 32), i, j in 0 … 7, read with the master's raw boxes (the live `caves.biomes` defaults, no border noise,
 *   no jitter): lush where H ≥ lush.hMin, dripstone where C ≥ dripstone.cMin, abyss where E ≤ abyss.eMax,
 *   C > abyss.cMin and surfaceEst − abyss.depthMin · depthScale > −47 (§1.6's room for abyss air above the rock floor);
 *   each box must hold at least `BIOME_SCAN_MIN_POINTS` (8, an eighth) of the points. With one point each the first
 *   candidate holding the T window below is R(−11, 11) (lush 1, dripstone 52, abyss 37), whose generated cave air
 *   holds 30 lush | plain border faces, short of §12.2's 2,000 on the fast tier, where the biome region is the biomes
 *   group alone (ruling P28);
 * - T (ruling P33): some 8 × 8-chunk tile of the candidate, in `sp6a.region.T.caves`' order (rows of tiles from low z
 *   to high z, each from low x to high x), holds stored cave-biome nibbles 1, 2 and 3 (`biomeTileMasks`), so
 *   `sp6b.region.T.biomes`' window (Task 31) exists by construction.
 * Run once at Task 27's head (`GENERATOR_VERSION` 9, after Task 25's levers): R(−12, 12), chunk origin (−112, 80), climate
 * lush 11, dripstone 47, abyss 39, its tile (1, 2) holding the three; the candidates before it whose climate held and
 * whose tiles did not, `BIOME_SCAN_SKIPPED`: R(−7, 10) and R(−7, 11). `BIOME_REGION` holds it; `caveSites` re-checks
 * the climate predicate, the metric re-checks the T window over the measured region, and the unit test re-runs the scan.
 * A retune of the boxes (Task 30) re-runs it and moves the literal and its pins if it moved.
 *
 * The regions' measurement (SP6b spec §13 L6, ruling P6; `measureCaveRegions`): per region in worker threads
 * (`caveRegionWorker.ts`), each region generated (or read from its cached dump) by `genRegion` on this thread; the
 * metric pools the results. Here rather than in the metric file, so a unit test drives it with 1 and 4 workers.
 */
export type CaveTier = 'fast' | 'quick' | 'full';

/** A group of the caves metric's regions (`METRICS_CAVE_GROUPS`); null: every group. */
export type CaveGroup = 'default' | 'presets' | 'biomes';

/** A region of the tier: its group, a seed, a profile and R's rectangle. */
export interface Site {
  readonly label: string;
  readonly group: CaveGroup;
  readonly seed: string;
  readonly profile: ProfileId;
  readonly cx0: number;
  readonly cz0: number;
  readonly size: number;
}

export type PresetId = 'archipelago' | 'amplified' | 'floating_islands';

/** The preset regions' scan candidates R(a, b) as found at seed '42' (see the header). */
export const PRESET_REGIONS: ReadonlyArray<readonly [PresetId, a: number, b: number]> = [
  ['archipelago', 1, -2],
  ['amplified', -5, -1],
  ['floating_islands', -2, -1],
];

/** The scan's predicate on R(a, b) of `preset` at world seed `seed` (see the header). */
export function presetRegionHolds(preset: PresetId, seed: string, a: number, b: number): boolean {
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
export function findPresetRegion(preset: PresetId, seed: string): readonly [a: number, b: number] {
  for (let r = 0; r <= 64; r++) {
    for (const [a, b] of ringCandidates(r)) if (presetRegionHolds(preset, seed, a, b)) return [a, b];
  }
  throw new Error(`caves.metric: no ${preset} region at seed '${seed}' within ring 64`);
}

/** A preset's region at `seed`: the fixed one at seed '42', which must still hold its predicate, else the scan's. */
function presetRegion(preset: PresetId, seed: string): readonly [a: number, b: number] {
  if (seed !== '42') return findPresetRegion(preset, seed);
  const [, a, b] = PRESET_REGIONS.find(([p]) => p === preset)!;
  if (!presetRegionHolds(preset, seed, a, b)) throw new Error(`${preset}'s region R(${a}, ${b}) no longer holds its scan's predicate`);
  return [a, b];
}

/** The default regions' seeds per tier. */
const defaultSeeds = (tier: CaveTier): readonly string[] => (tier === 'full' ? ['42', '1', '2', '3'] : tier === 'quick' ? ['42', '1'] : ['42']);
/** The seeds of the preset regions: '42' (fixed) on quick, and the full tier's other seeds (scanned); none on fast. */
const presetSeeds = (tier: CaveTier): readonly string[] => (tier === 'full' ? ['42', '1', '2', '3'] : tier === 'quick' ? ['42'] : []);

/** The tier's default regions (the default and large_biomes profiles), where the default parts (C1-C6) run. */
function defaultSites(tier: CaveTier): Site[] {
  if (tier === 'fast') {
    return [
      { label: "seed '42' default (-8, -8)", group: 'default', seed: '42', profile: 'default', cx0: -8, cz0: -8, size: 16 },
      { label: "seed '42' default (8, -8)", group: 'default', seed: '42', profile: 'default', cx0: 8, cz0: -8, size: 16 },
    ];
  }
  const out: Site[] = [];
  for (const seed of defaultSeeds(tier)) {
    out.push({ label: `seed '${seed}' default (-16, -16)`, group: 'default', seed, profile: 'default', cx0: -16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' default (16, -16)`, group: 'default', seed, profile: 'default', cx0: 16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' large_biomes (-16, -16)`, group: 'default', seed, profile: 'large_biomes', cx0: -16, cz0: -16, size: 32 });
  }
  return out;
}

/** The tier's preset regions, seed by seed in `PRESET_REGIONS`' order. */
function presetSites(tier: CaveTier): Site[] {
  const out: Site[] = [];
  for (const seed of presetSeeds(tier)) {
    for (const [preset] of PRESET_REGIONS) {
      const [a, b] = presetRegion(preset, seed);
      out.push({ label: `seed '${seed}' ${preset} R(${a}, ${b})`, group: 'presets', seed, profile: preset, cx0: 8 * a - 16, cz0: 8 * b - 16, size: 32 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the biomes group (SP6b spec §12.2-§12.3; Task 27)

/** The biome region's chunk origin (32 × 32 chunks, seed '42', default profile; the header's scan, ruling P33). */
export const BIOME_REGION: readonly [cx0: number, cz0: number] = [-112, 80];
/** The scan's candidates before `BIOME_REGION` whose climate check held and whose tiles held no T window (chunk origins). */
export const BIOME_SCAN_SKIPPED: ReadonlyArray<readonly [cx0: number, cz0: number]> = [[-72, 64], [-72, 72]];
/** The biome region's side, in chunks. */
export const BIOME_REGION_SIZE = 32;
/** The scan's T tiles' side, in chunks (`sp6a.region.T.caves`' window). */
export const BIOME_TILE = 8;
/** The scan's climate grid step, in blocks. */
export const BIOME_SCAN_STEP = 64;
/** The fewest of the climate grid's 64 points each raw box must hold (an eighth; see the header). */
export const BIOME_SCAN_MIN_POINTS = 8;
/** The abyss's room in the climate check: surfaceEst − abyss.depthMin · depthScale above this y (§1.6). */
export const BIOME_SCAN_ROOM_Y = -47;
/** The stored nibbles a T tile must hold: lush, dripstone and abyss (bits 1, 2 and 3 of `biomeTileMasks`' masks). */
export const BIOME_TILE_ALL = 0b1110;

/** The climate check's counts: the grid points inside each raw box. */
export interface BiomeClimateCounts {
  readonly lush: number;
  readonly dripstone: number;
  readonly abyss: number;
}

/** The climate check's counts over the 32 × 32-chunk region at chunk origin (cx0, cz0), default profile, `seed`. */
export function biomeRegionClimate(seed: string, cx0: number, cz0: number): BiomeClimateCounts {
  const params = resolveProfile('default');
  const ctx = createGenContext(seedFromInput(seed), params);
  const b = params.caves.biomes;
  const rec = newPointRecord();
  const n = (16 * BIOME_REGION_SIZE) / BIOME_SCAN_STEP;
  let lush = 0;
  let dripstone = 0;
  let abyss = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const p = samplePoint(ctx, 16 * cx0 + BIOME_SCAN_STEP * i + BIOME_SCAN_STEP / 2, 16 * cz0 + BIOME_SCAN_STEP * j + BIOME_SCAN_STEP / 2, false, rec);
      if (p.H >= b.lush.hMin) lush++;
      if (p.C >= b.dripstone.cMin) dripstone++;
      if (p.E <= b.abyss.eMax && p.C > b.abyss.cMin && p.surfaceEst - b.abyss.depthMin * b.depthScale > BIOME_SCAN_ROOM_Y) abyss++;
    }
  }
  return { lush, dripstone, abyss };
}

/** Whether the climate check holds: each box holds at least `BIOME_SCAN_MIN_POINTS` points. */
export const biomeClimateHolds = (c: BiomeClimateCounts): boolean =>
  c.lush >= BIOME_SCAN_MIN_POINTS && c.dripstone >= BIOME_SCAN_MIN_POINTS && c.abyss >= BIOME_SCAN_MIN_POINTS;

/** The 16 T tiles of the region at chunk origin (cx0, cz0), each tile's chunk origin, in `sp6a.region.T.caves`' order. */
export function biomeTiles(cx0: number, cz0: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = BIOME_REGION_SIZE / BIOME_TILE;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push([cx0 + BIOME_TILE * i, cz0 + BIOME_TILE * j]);
  return out;
}

/** The index of the first tile mask (`biomeTileMasks`' order) holding nibbles 1, 2 and 3; −1 when none does. */
export const firstBiomeTile = (masks: readonly number[]): number => masks.findIndex((m) => (m & BIOME_TILE_ALL) === BIOME_TILE_ALL);

/**
 * The stored-nibble mask (`biomeTileMasks`) of the 8 × 8-chunk tile at chunk origin (cx0, cz0), seed `seed`, default
 * profile, generated up to T (`genRegion`, 4 threads, no region cache).
 */
export async function tileBiomeMask(seed: string, cx0: number, cz0: number, workerDir: string): Promise<number> {
  const { view } = await genRegion({
    seed, params: resolveProfile('default'), cx0, cz0, w: BIOME_TILE, h: BIOME_TILE, upTo: 'T', order: 'spiral', threads: 4,
    cache: false, workerDir,
  });
  return biomeTileMasks(caveGridOf(view), BIOME_TILE)[0]!;
}

/** What the biome region's scan found: the region, the candidates skipped by the T check, and the tile that held. */
export interface BiomeScan {
  readonly region: readonly [cx0: number, cz0: number];
  readonly skipped: Array<readonly [cx0: number, cz0: number]>;
  readonly tile: readonly [cx0: number, cz0: number];
}

/**
 * The biome region's scan (see the header) at `seed`: the first candidate, rings 0 … 64, passing the climate check and
 * then the T check, which asks `tileMask` for each tile's stored-nibble mask (each tile once: neighbouring candidates
 * share tiles). Throws when no candidate passes.
 */
export async function findBiomeRegion(seed: string, tileMask: (cx0: number, cz0: number) => Promise<number>): Promise<BiomeScan> {
  const masks = new Map<string, number>();
  const skipped: Array<readonly [number, number]> = [];
  for (let r = 0; r <= 64; r++) {
    for (const [a, b] of ringCandidates(r)) {
      const cx0 = 8 * a - 16;
      const cz0 = 8 * b - 16;
      if (!biomeClimateHolds(biomeRegionClimate(seed, cx0, cz0))) continue;
      for (const [tx, tz] of biomeTiles(cx0, cz0)) {
        const key = `${tx},${tz}`;
        let m = masks.get(key);
        if (m === undefined) {
          m = await tileMask(tx, tz);
          masks.set(key, m);
        }
        if ((m & BIOME_TILE_ALL) === BIOME_TILE_ALL) return { region: [cx0, cz0], skipped, tile: [tx, tz] };
      }
      skipped.push([cx0, cz0]);
    }
  }
  throw new Error(`caves.metric: no biome region at seed '${seed}' within ring 64`);
}

/** The biome region's site: `BIOME_REGION`, which must still hold the scan's climate predicate. */
function biomeRegionSite(): Site {
  const [cx0, cz0] = BIOME_REGION;
  const c = biomeRegionClimate('42', cx0, cz0);
  if (!biomeClimateHolds(c)) {
    throw new Error(`the biome region (${cx0}, ${cz0}) no longer holds its scan's climate predicate (lush ${c.lush}, dripstone ${c.dripstone}, abyss ${c.abyss})`);
  }
  return { label: `seed '42' default biome region (${cx0}, ${cz0})`, group: 'biomes', seed: '42', profile: 'default', cx0, cz0, size: BIOME_REGION_SIZE };
}

/** The seeds of `cave_heavy`'s regions: '42' on quick, the full tier's four, none on fast (ruling P28). */
const caveHeavySeeds = (tier: CaveTier): readonly string[] => (tier === 'full' ? ['42', '1', '2', '3'] : tier === 'quick' ? ['42'] : []);

/** The tier's biomes group: `cave_heavy`'s two regions per seed, then the biome region (see the header). */
function biomeSites(tier: CaveTier): Site[] {
  const out: Site[] = [];
  for (const seed of caveHeavySeeds(tier)) {
    out.push({ label: `seed '${seed}' cave_heavy (-16, -16)`, group: 'biomes', seed, profile: 'cave_heavy', cx0: -16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' cave_heavy (16, -16)`, group: 'biomes', seed, profile: 'cave_heavy', cx0: 16, cz0: -16, size: 32 });
  }
  out.push(biomeRegionSite());
  return out;
}

/**
 * The regions of `tier` in `groups` (null: every group of the tier, the default regions, the preset regions, then the
 * biomes group).
 */
export function caveSites(tier: CaveTier, groups: CaveGroup | null): Site[] {
  return [
    ...(groups === null || groups === 'default' ? defaultSites(tier) : []),
    ...(groups === null || groups === 'presets' ? presetSites(tier) : []),
    ...(groups === null || groups === 'biomes' ? biomeSites(tier) : []),
  ];
}

/** `METRICS_CAVE_GROUPS` read: absent, every group (null); else one group's name, an unknown one throws (ruling P2). */
export function caveGroupOf(raw: string | undefined): CaveGroup | null {
  if (raw === undefined) return null;
  if (raw === 'default' || raw === 'presets' || raw === 'biomes') return raw;
  throw new Error(`METRICS_CAVE_GROUPS '${raw}' (default, presets or biomes)`);
}

/** What `measureCaveRegions` needs beside the regions. */
export interface CaveRegionsOptions {
  /** C7.switchWall's chunk stride (the metric's `SWITCH_STRIDE`). */
  readonly stride: number;
  /** `genRegion`'s 4-thread worker bundle directory, under test/.cache/ (one per tier and test file). */
  readonly regionWorkerDir: string;
  /** `caveRegionWorker.ts`' bundle directory, under test/.cache/ (one per tier and test file). */
  readonly workerDir: string;
  /** The worker threads (an integer ≥ 1; default 4, plan); never more than the regions. */
  readonly workers?: number;
  /** `genRegion`'s cache directory (default `test/.cache/regions/`). */
  readonly cacheDir?: string;
}

const caveWorkerScripts = new Map<string, Promise<string>>();

function caveRegionWorkerScript(dir: string): Promise<string> {
  let p = caveWorkerScripts.get(dir);
  if (p === undefined) {
    p = buildNodeTaskWorker(dir, { entry: 'test/harness/caveRegionWorker.ts' });
    caveWorkerScripts.set(dir, p);
  }
  return p;
}

/**
 * Every region of `sites` measured by `measureCaveRegion` in worker threads (SP6b spec §13 L6), the results in `sites`'
 * order. A worker that is idle takes the next region of the list: this thread generates it up to 'T' through the
 * region cache (`genRegion`, 4 threads, a shared store; one region at a time, in the list's order) and hands the
 * worker the store's handles, so at most one store per worker, and the one being generated, are alive. Throws on a
 * worker's error, after terminating every worker.
 */
export async function measureCaveRegions(sites: readonly Site[], o: CaveRegionsOptions): Promise<CaveRegionResult[]> {
  const n = o.workers ?? 4;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`measureCaveRegions: workers ${n} (an integer ≥ 1)`);
  const out: Array<CaveRegionResult | undefined> = sites.map(() => undefined);
  if (sites.length === 0) return [];
  const script = await caveRegionWorkerScript(o.workerDir);
  const workers = Array.from({ length: Math.min(n, sites.length) }, () => new Worker(script));
  let next = 0;
  let failed = false;
  // The regions are generated one after the other (each `genRegion` runs its own 4 threads).
  let generating: Promise<unknown> = Promise.resolve();
  const generate = (s: Site, params: CaveRegionMsg['params']) => {
    const p = generating.then(() => genRegion({
      seed: s.seed, params, cx0: s.cx0, cz0: s.cz0, w: s.size, h: s.size, upTo: 'T', order: 'spiral', threads: 4,
      cache: true, workerDir: o.regionWorkerDir, ...(o.cacheDir === undefined ? {} : { cacheDir: o.cacheDir }),
    }));
    generating = p.catch(() => undefined);
    return p;
  };
  const run = async (w: Worker): Promise<void> => {
    try {
      while (!failed && next < sites.length) {
        const k = next++;
        const site = sites[k]!;
        const params = resolveProfile(site.profile);
        const { view } = await generate(site, params);
        const msg: CaveRegionMsg = { type: 'region', handles: view.store.handles(), site, params, stride: o.stride };
        const reply = await ask<CaveRegionReply>(w, msg);
        if (reply.type !== 'measured') throw new Error(`cave region worker, ${site.label}: ${reply.type === 'error' ? reply.message : String((reply as { type: unknown }).type)}`);
        if (reply.label !== site.label) throw new Error(`cave region worker: asked ${site.label}, answered ${reply.label}`);
        out[k] = reply.result;
      }
    } catch (e) {
      failed = true;
      throw e;
    }
  };
  try {
    await Promise.all(workers.map(run));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  const missing = out.findIndex((r) => r === undefined);
  if (missing >= 0) throw new Error(`measureCaveRegions: ${sites[missing]!.label} not measured`);
  return out as CaveRegionResult[];
}

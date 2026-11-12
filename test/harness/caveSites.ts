import { Worker } from 'node:worker_threads';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import { ringCandidates } from '../../src/metrics/sp3eGoldens';
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
 * preset regions; absent, every group of the tier (ruling P2).
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
 * The regions' measurement (SP6b spec §13 L6, ruling P6; `measureCaveRegions`): per region in worker threads
 * (`caveRegionWorker.ts`), each region generated (or read from its cached dump) by `genRegion` on this thread; the
 * metric pools the results. Here rather than in the metric file, so a unit test drives it with 1 and 4 workers.
 */
export type CaveTier = 'fast' | 'quick' | 'full';

/** A group of the caves metric's regions (`METRICS_CAVE_GROUPS`); null: every group. */
export type CaveGroup = 'default' | 'presets';

/** A region of the tier: a seed, a profile and R's rectangle. */
export interface Site {
  readonly label: string;
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
      { label: "seed '42' default (-8, -8)", seed: '42', profile: 'default', cx0: -8, cz0: -8, size: 16 },
      { label: "seed '42' default (8, -8)", seed: '42', profile: 'default', cx0: 8, cz0: -8, size: 16 },
    ];
  }
  const out: Site[] = [];
  for (const seed of defaultSeeds(tier)) {
    out.push({ label: `seed '${seed}' default (-16, -16)`, seed, profile: 'default', cx0: -16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' default (16, -16)`, seed, profile: 'default', cx0: 16, cz0: -16, size: 32 });
    out.push({ label: `seed '${seed}' large_biomes (-16, -16)`, seed, profile: 'large_biomes', cx0: -16, cz0: -16, size: 32 });
  }
  return out;
}

/** The tier's preset regions, seed by seed in `PRESET_REGIONS`' order. */
function presetSites(tier: CaveTier): Site[] {
  const out: Site[] = [];
  for (const seed of presetSeeds(tier)) {
    for (const [preset] of PRESET_REGIONS) {
      const [a, b] = presetRegion(preset, seed);
      out.push({ label: `seed '${seed}' ${preset} R(${a}, ${b})`, seed, profile: preset, cx0: 8 * a - 16, cz0: 8 * b - 16, size: 32 });
    }
  }
  return out;
}

/** The regions of `tier` in `groups` (null: every group of the tier, the default regions then the preset regions). */
export function caveSites(tier: CaveTier, groups: CaveGroup | null): Site[] {
  return [
    ...(groups === null || groups === 'default' ? defaultSites(tier) : []),
    ...(groups === null || groups === 'presets' ? presetSites(tier) : []),
  ];
}

/** `METRICS_CAVE_GROUPS` read: absent, every group (null); else one group's name, an unknown one throws (ruling P2). */
export function caveGroupOf(raw: string | undefined): CaveGroup | null {
  if (raw === undefined) return null;
  if (raw === 'default' || raw === 'presets') return raw;
  throw new Error(`METRICS_CAVE_GROUPS '${raw}' (default or presets)`);
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

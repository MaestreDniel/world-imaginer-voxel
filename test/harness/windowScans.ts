import { CAVE_KIND, caveKindOf, ISLAND_RUN_MIN_BOTTOM, SEA_LEVEL } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { columnPoint, newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { ringCandidates } from '../../src/metrics/sp3eGoldens';
import { FLUID_LAVA, FLUID_WATER, NO_FLUID, WATER_SOURCE, fluidFalling, fluidLevel, fluidType } from '../../src/world/blocks/fluid';
import { AIR, GRASS_BLOCK } from '../../src/world/blocks/index';
import { genRegion, type RegionView } from './region';

/**
 * The scans that place the metrics' fixed windows (SP6a spec §10.4, Task 33; SP7a spec §13.4, Task 17), kept as code
 * so that an output-changing commit re-pins a window by running its scan (rulings P37 and R20 (j)). Each metric pins
 * the window its scan found and re-checks the scan's predicate (below) on the region it already generates, failing
 * when the window no longer holds it; the scans themselves generate regions, so no test runs them: a re-pin calls one
 * from a throwaway test (`await scanCaveRegion('42')`) and writes the window it returns into the metric.
 * - R1's cave region (`render.metric.ts`): candidate C(a, b) is the 6 × 6 region at chunk origin (4a − 1, 4b − 1), whose
 *   interior is the 4 × 4 chunks at (4a, 4b), in the rings of `ringCandidates` (`sp3eGoldens.ts`; r = 0, 1, …), seed
 *   '42', profile default, generated up to 'T'. It holds when, inside the interior, ≥ 8 pairs of face-adjacent voxels
 *   across a chunk border are both tagged entrance (`CAVE_KIND`, the store's tag) and ≥ 8 pairs both tagged ravine.
 * - S1's large island over grass (`light.metric.ts`): candidate W(a, b) is the 10 × 10 region at chunk origin
 *   (8a − 1, 8b − 1), whose interior is the 8 × 8 chunks at (8a, 8b), in the same rings, seed '42', profile
 *   floating_islands; a candidate whose 16 × 16 lattice (block (16·8a + 8i + 4, 16·8b + 8j + 4)) holds fewer than 32
 *   points with `columnPoint` islandMask ≥ 0.9 is skipped, and the first whose interior, generated up to 'T', holds
 *   ≥ 64 deep grass positions under islands (`grassUnderIslands`) is the window.
 * - DT1's settle windows (`region.metric.ts`, `light.metric.ts`; the literals in `settleWindows.ts`, rulings P18,
 *   P28): candidate S(a, b) is the 10 × 10 region at chunk origin (6a − 2, 6b − 2), whose interior is the 6 × 6 chunks
 *   at (6a, 6b) (the region minus two rings, so each interior column's 3 × 3 and its 16-block reach lie in the
 *   region), in the same rings, seed '42', profile default, generated up to 'D' (D on the region, T one ring more). A
 *   feature (`SETTLE_FEATURES`) is read over the interior by `settleFeatures`; the scan for a feature takes the first
 *   candidate that holds it (`settleWindowHolds`) and is not already another feature's window. The coast's scan
 *   skips a candidate whose 12 × 12 lattice over the interior (block (96a + 8i + 4, 96b + 8j + 4)) holds fewer than 16
 *   sea points (`samplePoint`'s offset below SEA_LEVEL, no river, no lake) or fewer than 16 land points (offset above
 *   SEA_LEVEL): seed '42' has no coast within ring 9. Since the springs (SP7a Task 19) the coast window also holds a
 *   water spring (`SettleFeatures.springs`), so DT1's first window settles a spring's stream as well as a coast's
 *   spills; the coast's scan then also skips a candidate whose interior's springs step accepts no water spring
 *   (`interiorSprings`, no region generated). Since the lava springs (SP7a Task 21, rulings P42) the contact window also
 *   holds flowing lava (`SettleFeatures.flowingLava`: lava steps or falls), the lava half of R1's and `mesh.section`'s
 *   flowing-fluid sites.
 */

/** A window's region: its chunk origin and its side in chunks; the interior is the region minus its border ring. */
export interface WindowRegion {
  readonly cx0: number;
  readonly cz0: number;
  readonly size: number;
}

/** A voxel reader of the window's region (blocks or tags), in world coordinates. */
export type VoxelAt = (x: number, y: number, z: number) => number;

// ---------------------------------------------------------------- R1's cave region

/** The cave region's predicate: border-crossing voxel pairs of each kind, at least. */
export const MIN_CROSSING_PAIRS = 8;

/** Candidate C(a, b) of R1's cave region. */
export const caveRegionAt = (a: number, b: number): WindowRegion => ({ cx0: 4 * a - 1, cz0: 4 * b - 1, size: 6 });

/**
 * The cave region's predicate over a region's interior: the pairs of face-adjacent voxels on the two sides of a chunk
 * border inside the interior (x and z borders, every y) whose tags (`tag`, the store's cave byte, read through
 * `caveKindOf`: bits 4-7 hold the cave biome, SP6b spec §2.1) are both entrance, and both ravine.
 */
export function crossingPairs(tag: VoxelAt, r: WindowRegion): { entrance: number; ravine: number } {
  let entrance = 0;
  let ravine = 0;
  const n = r.size - 2;
  const x0 = 16 * (r.cx0 + 1);
  const z0 = 16 * (r.cz0 + 1);
  const pair = (b1: number, b2: number): void => {
    const t1 = caveKindOf(b1);
    if (t1 !== caveKindOf(b2)) return;
    if (t1 === CAVE_KIND.entrance) entrance++;
    else if (t1 === CAVE_KIND.ravine) ravine++;
  };
  for (let y = -64; y < 320; y++) {
    for (let k = 1; k < n; k++) {
      for (let t = 0; t < 16 * n; t++) {
        pair(tag(x0 + 16 * k - 1, y, z0 + t), tag(x0 + 16 * k, y, z0 + t));
        pair(tag(x0 + t, y, z0 + 16 * k - 1), tag(x0 + t, y, z0 + 16 * k));
      }
    }
  }
  return { entrance, ravine };
}

/** Whether `pairs` meets the cave region's predicate. */
export const caveRegionHolds = (pairs: { entrance: number; ravine: number }): boolean =>
  pairs.entrance >= MIN_CROSSING_PAIRS && pairs.ravine >= MIN_CROSSING_PAIRS;

/** The scan for R1's cave region at `seed` (header): the first candidate that holds, with its pairs and ring. */
export async function scanCaveRegion(seed: string, maxRing = 8): Promise<{ a: number; b: number; ring: number; entrance: number; ravine: number }> {
  const params = resolveProfile('default');
  for (let ring = 0; ring <= maxRing; ring++) {
    for (const [a, b] of ringCandidates(ring)) {
      const r = caveRegionAt(a, b);
      const { view } = await genRegion({ seed, params, cx0: r.cx0, cz0: r.cz0, w: r.size, h: r.size, upTo: 'T', order: 'spiral', threads: 4, workerDir: 'windowScanWorker' });
      const pairs = crossingPairs((x, y, z) => view.tag(x, y, z), r);
      if (caveRegionHolds(pairs)) return { a, b, ring, ...pairs };
    }
  }
  throw new Error(`windowScans: no cave region at seed '${seed}' within ring ${maxRing}`);
}

// ---------------------------------------------------------------- S1's large island over grass

/** The island window's predicate: deep grass positions under islands, at least. */
export const MIN_DEEP_GRASS = 64;
/** A deep position's shade: every interior position within this Manhattan distance holds an island run. */
export const DEEP_SHADE = 15;
/** The prefilter: lattice points with islandMask ≥ 0.9, at least (of 256). */
export const MIN_ISLAND_POINTS = 32;

/** Candidate W(a, b) of S1's large island over grass. */
export const islandWindowAt = (a: number, b: number): WindowRegion => ({ cx0: 8 * a - 1, cz0: 8 * b - 1, size: 10 });

/** The prefilter's count at W(a, b) of floating_islands at `seed`: lattice points with islandMask ≥ 0.9. */
export function islandPoints(seed: string, a: number, b: number): number {
  const ctx = createGenContext(seedFromInput(seed), resolveProfile('floating_islands'));
  let n = 0;
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16; i++) if (columnPoint(ctx, 128 * a + 8 * i + 4, 128 * b + 8 * j + 4).islandMask >= 0.9) n++;
  }
  return n;
}

/**
 * The island window's predicate over a region's interior: the grass positions under an island and the deep ones among
 * them. A grass position under an island is a position with an island run (a solid run whose bottom is ≥
 * `ISLAND_RUN_MIN_BOTTOM`) above its ground run (the highest run with bottom < 181), the ground run's top a
 * grass_block; it is deep when every interior position within Manhattan distance `DEEP_SHADE` holds an island run (and
 * none of them lies outside the interior), so sky light (15, one less per block sideways) cannot reach its top from
 * beside the island. A position's runs are read top-down from `block` (a block state; air is not solid).
 */
export function grassUnderIslands(block: VoxelAt, r: WindowRegion): { under: number; deep: number } {
  const n = 16 * (r.size - 2);
  const foot = new Uint8Array(n * n);
  const grass = new Uint8Array(n * n);
  const x0 = 16 * (r.cx0 + 1);
  const z0 = 16 * (r.cz0 + 1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let island = false;
      let groundTop: number | null = null;
      let runTop: number | null = null;
      for (let y = 319; y >= -65; y--) {
        const solid = y >= -64 && block(x0 + i, y, z0 + j) !== AIR;
        if (solid && runTop === null) runTop = y;
        else if (!solid && runTop !== null) {
          if (y + 1 >= ISLAND_RUN_MIN_BOTTOM) { island = true; runTop = null; continue; }
          groundTop = runTop;
          break;
        }
      }
      foot[j * n + i] = island ? 1 : 0;
      grass[j * n + i] = island && groundTop !== null && block(x0 + i, groundTop, z0 + j) === GRASS_BLOCK ? 1 : 0;
    }
  }
  let under = 0;
  let deep = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (grass[j * n + i] !== 1) continue;
      under++;
      let shaded = true;
      for (let dj = -DEEP_SHADE; dj <= DEEP_SHADE && shaded; dj++) {
        const w = DEEP_SHADE - Math.abs(dj);
        for (let di = -w; di <= w && shaded; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n || foot[jj * n + ii] === 0) shaded = false;
        }
      }
      if (shaded) deep++;
    }
  }
  return { under, deep };
}

/** The scan for S1's large island over grass at `seed` (header): the first candidate that holds, with its counts. */
export async function scanIslandWindow(seed: string, maxRing = 8): Promise<{ a: number; b: number; ring: number; under: number; deep: number }> {
  const params = resolveProfile('floating_islands');
  for (let ring = 0; ring <= maxRing; ring++) {
    for (const [a, b] of ringCandidates(ring)) {
      if (islandPoints(seed, a, b) < MIN_ISLAND_POINTS) continue;
      const r = islandWindowAt(a, b);
      const { view } = await genRegion({ seed, params, cx0: r.cx0, cz0: r.cz0, w: r.size, h: r.size, upTo: 'T', order: 'spiral', threads: 4, workerDir: 'windowScanWorker' });
      const g = grassUnderIslands((x, y, z) => view.block(x, y, z), r);
      if (g.deep >= MIN_DEEP_GRASS) return { a, b, ring, ...g };
    }
  }
  throw new Error(`windowScans: no large island over grass at seed '${seed}' within ring ${maxRing}`);
}

// ---------------------------------------------------------------- DT1's settle windows

/** The features DT1's three settle windows hold, in `SETTLE_WINDOWS` order (SP7a spec §13.4). */
export const SETTLE_FEATURES = ['coast', 'contact', 'streamOverPool'] as const;
export type SettleFeature = (typeof SETTLE_FEATURES)[number];

/** The coast's predicate: sea positions and land positions in the interior, each at least. */
export const MIN_COAST_POSITIONS = 256;

/** The coast's prefilter: sea points and land points of the 144-point lattice, each at least. */
export const MIN_COAST_POINTS = 16;

/** Candidate S(a, b) of DT1's settle windows. */
export const settleWindowAt = (a: number, b: number): WindowRegion => ({ cx0: 6 * a - 2, cz0: 6 * b - 2, size: 10 });

/** A settle window's region, read whole: final and proto fluid, block states and cave bytes, `settleBoxOf`'s index. */
export interface SettleBox {
  readonly r: WindowRegion;
  readonly final: Uint8Array;
  readonly proto: Uint8Array;
  readonly blocks: Uint16Array;
  readonly cave: Uint8Array;
}

/**
 * The region of `view` (a settle window generated up to 'D') read whole: per voxel, index `((y + 64)·S + (z − z0))·S +
 * (x − x0)` with S = 16·size, its final fluid (the settle's), its proto fluid, its block and its cave byte.
 */
export function settleBoxOf(view: RegionView): SettleBox {
  if (view.w !== view.h) throw new Error('settleBoxOf: square regions only');
  const side = 16 * view.w;
  const n = side * side * 384;
  const box: SettleBox = {
    r: { cx0: view.cx0, cz0: view.cz0, size: view.w },
    final: new Uint8Array(n), proto: new Uint8Array(n), blocks: new Uint16Array(n), cave: new Uint8Array(n),
  };
  for (let cz = view.cz0; cz < view.cz0 + view.h; cz++) {
    for (let cx = view.cx0; cx < view.cx0 + view.w; cx++) {
      const f = view.store.final(cx, cz);
      const p = view.store.proto(cx, cz);
      if (f === null || p === null) throw new Error(`settleBoxOf: column (${cx}, ${cz}) has no final or proto set`);
      const bx = 16 * (cx - view.cx0);
      const bz = 16 * (cz - view.cz0);
      for (let sy = 0; sy < 24; sy++) {
        const channels = [[f.sectionFluid(sy), box.final], [p.sectionFluid(sy), box.proto], [p.sectionBlocks(sy), box.blocks], [p.sectionCave(sy), box.cave]] as const;
        for (const [src, dst] of channels) {
          for (let ly = 0; ly < 16; ly++) {
            for (let lz = 0; lz < 16; lz++) {
              const at = ((16 * sy + ly) * side + bz + lz) * side + bx;
              if (typeof src === 'number') dst.fill(src, at, at + 16);
              else dst.set(src.subarray(ly * 256 + lz * 16, ly * 256 + lz * 16 + 16), at);
            }
          }
        }
      }
    }
  }
  return box;
}

/** What `settleFeatures` counts over a settle window's interior. */
export interface SettleFeatures {
  /** Voxels whose final fluid differs from their proto fluid. */
  readonly settled: number;
  /** Positions whose proto holds water at y SEA_LEVEL (the sea's top) under dry air. */
  readonly sea: number;
  /** Positions whose block at y SEA_LEVEL + 1 is not air (ground above the sea's top). */
  readonly land: number;
  /**
   * Settle-made water voxels (proto dry, final water) outside caves (untagged) beside a proto water voxel: a sea's,
   * river's or lake's old wall spilling.
   */
  readonly spills: number;
  /** Settle-made water voxels in a cave (tagged): a flooded cave's border spilling into dry cave air. */
  readonly caveBorder: number;
  /** Final lava voxels with a face neighbour holding final water (a water/lava contact). */
  readonly contacts: number;
  /**
   * Flowing final lava voxels (level > 0 or falling): lava steps and falls, which the contact window must hold from
   * Task 21 on (rulings P42: R1's sites and `mesh.section`'s sample take its interior sections for lava steps).
   */
  readonly flowingLava: number;
  /**
   * Settle-made falling water voxels under a settle-made flowing (not falling) one and beside another (§4.1: a stream
   * reaching a pool the settle made falls into it).
   */
  readonly streamOverPool: number;
  /**
   * Water springs (SP7a §3.2; Task 19): untagged proto water sources above the sea level (y > SEA_LEVEL) in a voxel
   * with a block above and below it and on three sides, the fourth side air with no proto fluid (the spring's outlet).
   */
  readonly springs: number;
}

/**
 * The settle features of a settle window's interior (the region minus two rings; neighbours are read in the region),
 * over `settleBoxOf`'s arrays. "Settle-made": proto dry, final wet.
 */
export function settleFeatures(box: SettleBox): SettleFeatures {
  const { r, final, proto, blocks, cave } = box;
  const side = 16 * r.size;
  const layer = side * side;
  const lo = 32;
  const hi = side - 32;
  const made = (i: number): boolean => proto[i] === NO_FLUID && final[i] !== NO_FLUID;
  const madeWater = (i: number): boolean => made(i) && fluidType(final[i]!) === FLUID_WATER;
  const madeFlowing = (i: number): boolean => madeWater(i) && !fluidFalling(final[i]!);
  let settled = 0, sea = 0, land = 0, spills = 0, caveBorder = 0, contacts = 0, flowingLava = 0, streamOverPool = 0, springs = 0;
  const sides = [1, -1, side, -side];
  /** Whether voxel i (y > −64, y < 319) is a water spring (`SettleFeatures.springs`). */
  const spring = (i: number): boolean => {
    if (proto[i] !== WATER_SOURCE || blocks[i] !== AIR || caveKindOf(cave[i]!) !== 0) return false;
    if (blocks[i + layer] === AIR || blocks[i - layer] === AIR) return false;
    let open = 0;
    for (const d of sides) {
      if (blocks[i + d] !== AIR) continue;
      if (proto[i + d] !== NO_FLUID) return false;
      open++;
    }
    return open === 1;
  };
  for (let z = lo; z < hi; z++) {
    for (let x = lo; x < hi; x++) {
      const above = (SEA_LEVEL + 65) * layer + z * side + x;
      if (blocks[above] !== AIR) land++;
      else if (proto[above] === NO_FLUID && fluidType(proto[above - layer]!) === FLUID_WATER) sea++;
      for (let y = -64; y < 320; y++) {
        const i = (y + 64) * layer + z * side + x;
        if (final[i] !== proto[i]) settled++;
        if (y > SEA_LEVEL && y < 319 && spring(i)) springs++;
        if (fluidType(final[i]!) === FLUID_LAVA) {
          if (fluidLevel(final[i]!) > 0 || fluidFalling(final[i]!)) flowingLava++;
          const below = y > -64 && fluidType(final[i - layer]!) === FLUID_WATER;
          const above = y < 319 && fluidType(final[i + layer]!) === FLUID_WATER;
          if (below || above || sides.some((d) => fluidType(final[i + d]!) === FLUID_WATER)) contacts++;
        }
        if (!madeWater(i)) continue;
        if (caveKindOf(cave[i]!) !== 0) caveBorder++;
        else if (sides.some((d) => fluidType(proto[i + d]!) === FLUID_WATER)) spills++;
        if (fluidFalling(final[i]!) && y < 319 && madeFlowing(i + layer) && sides.some((d) => madeFlowing(i + d))) streamOverPool++;
      }
    }
  }
  return { settled, sea, land, spills, caveBorder, contacts, flowingLava, streamOverPool, springs };
}

/** The coast's prefilter counts at S(a, b) of the default profile at `seed` (header). */
export function coastPoints(seed: string, a: number, b: number): { sea: number; land: number } {
  const ctx = createGenContext(seedFromInput(seed), resolveProfile('default'));
  const p = newPointRecord();
  let sea = 0, land = 0;
  for (let j = 0; j < 12; j++) {
    for (let i = 0; i < 12; i++) {
      samplePoint(ctx, 96 * a + 8 * i + 4, 96 * b + 8 * j + 4, false, p);
      if (p.offset < SEA_LEVEL && !p.riverWet && p.lakeMask === 0) sea++;
      else if (p.offset > SEA_LEVEL) land++;
    }
  }
  return { sea, land };
}

/**
 * The water springs T's springs step accepts over S(a, b)'s interior 6 × 6 columns of the default profile at `seed`
 * (`terrainSpringsDebug`; the coast's second prefilter since Task 19, no region generated).
 */
export function interiorSprings(seed: string, a: number, b: number): number {
  const ctx = createGenContext(seedFromInput(seed), resolveProfile('default'));
  const list = newSpringList();
  let n = 0;
  for (let cz = 6 * b; cz < 6 * b + 6; cz++) {
    for (let cx = 6 * a; cx < 6 * a + 6; cx++) {
      terrainSpringsDebug(ctx, cx, cz, list);
      n += list.n;
    }
  }
  return n;
}

/** Whether a settle window's interior holds `feature` (`SETTLE_FEATURES`). */
export function settleWindowHolds(feature: SettleFeature, f: SettleFeatures): boolean {
  if (feature === 'coast') return f.sea >= MIN_COAST_POSITIONS && f.land >= MIN_COAST_POSITIONS && f.spills >= 1 && f.caveBorder >= 1 && f.springs >= 1;
  if (feature === 'contact') return f.contacts >= 1 && f.flowingLava >= 1;
  return f.streamOverPool >= 1;
}

/**
 * The scan for the settle window holding `feature` at `seed` (header): the first candidate that holds it, skipping
 * the candidates in `taken` (the other features' windows), with its features and ring.
 */
export async function scanSettleWindow(
  seed: string, feature: SettleFeature, taken: ReadonlyArray<readonly [number, number]> = [], maxRing = 24,
): Promise<{ a: number; b: number; ring: number } & SettleFeatures> {
  const params = resolveProfile('default');
  for (let ring = 0; ring <= maxRing; ring++) {
    for (const [a, b] of ringCandidates(ring)) {
      if (taken.some(([ta, tb]) => ta === a && tb === b)) continue;
      if (feature === 'coast') {
        const c = coastPoints(seed, a, b);
        if (c.sea < MIN_COAST_POINTS || c.land < MIN_COAST_POINTS) continue;
        if (interiorSprings(seed, a, b) === 0) continue;
      }
      const r = settleWindowAt(a, b);
      const { view } = await genRegion({ seed, params, cx0: r.cx0, cz0: r.cz0, w: r.size, h: r.size, upTo: 'D', order: 'spiral', threads: 4, workerDir: 'windowScanWorker' });
      const f = settleFeatures(settleBoxOf(view));
      if (settleWindowHolds(feature, f)) return { a, b, ring, ...f };
    }
  }
  throw new Error(`windowScans: no settle window holding '${feature}' at seed '${seed}' within ring ${maxRing}`);
}

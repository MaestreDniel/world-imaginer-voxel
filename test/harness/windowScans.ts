import { CAVE_KIND, caveKindOf, ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import { ringCandidates } from '../../src/metrics/sp3eGoldens';
import { AIR, GRASS_BLOCK } from '../../src/world/blocks/index';
import { genRegion } from './region';

/**
 * The scans that place two of the metrics' fixed windows (SP6a spec §10.4, Task 33), kept as code so that an
 * output-changing commit re-pins a window by running its scan (rulings P37 and R20 (j)). Each metric pins the window
 * its scan found and re-checks the scan's predicate (below) on the region it already generates, failing when the
 * window no longer holds it; the scans themselves generate regions, so no test runs them: a re-pin calls one from a
 * throwaway test (`await scanCaveRegion('42')`) and writes the window it returns into the metric.
 * - R1's cave region (`render.metric.ts`): candidate C(a, b) is the 6 × 6 region at chunk origin (4a − 1, 4b − 1), whose
 *   interior is the 4 × 4 chunks at (4a, 4b), in the rings of `ringCandidates` (`sp3eGoldens.ts`; r = 0, 1, …), seed
 *   '42', profile default, generated up to 'T'. It holds when, inside the interior, ≥ 8 pairs of face-adjacent voxels
 *   across a chunk border are both tagged entrance (`CAVE_KIND`, the store's tag) and ≥ 8 pairs both tagged ravine.
 * - S1's large island over grass (`light.metric.ts`): candidate W(a, b) is the 10 × 10 region at chunk origin
 *   (8a − 1, 8b − 1), whose interior is the 8 × 8 chunks at (8a, 8b), in the same rings, seed '42', profile
 *   floating_islands; a candidate whose 16 × 16 lattice (block (16·8a + 8i + 4, 16·8b + 8j + 4)) holds fewer than 32
 *   points with `columnPoint` islandMask ≥ 0.9 is skipped, and the first whose interior, generated up to 'T', holds
 *   ≥ 64 deep grass positions under islands (`grassUnderIslands`) is the window.
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

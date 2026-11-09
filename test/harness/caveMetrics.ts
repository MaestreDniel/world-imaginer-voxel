/**
 * The caves' instruments (SP6a spec §10.1, D26): C1-C9 and the review poses, pure over a `CaveGrid` (a region's voxels copied out of a
 * `RegionView`, or a hand-built fixture) and its accessors, so a unit test can import them (`caves.metric.ts` registers
 * its tests at import, `test/harness/metric.ts:84-85`, as `terrainScatter.ts`, `surfaceAnalysis.ts` and `zMetrics.ts`
 * serve theirs). An instrument whose population is empty or undefined gives NaN, never ±Infinity (ruling P32).
 *
 * The definitions as built (the spec's table words them; where it leaves a choice, the choice is stated here):
 * - The pre-cave top of a position: the highest voxel that is solid (a non-air block) or tagged (a cave kind ≠ 0),
 *   y −64 at the lowest (`RegionView.preCaveTop`'s rule). "Underground" is y −56 … top − 8 (C1's range); C4 and C6
 *   count only underground voxels, so the sea and the sky above a low top do not dilute a band's carve rate.
 * - The components: `components3d` over the tagged voxels of y −56 … yMax, open air = air or fluid with tag 0.
 *   yMax is min(319, the region's highest pre-cave top + 1): every voxel above the highest top is untagged air, so the
 *   layer at top + 1 is open air joined to y 319 over every position, and the components and the sky flood are those
 *   of the box to 319 (spec: "from y −56 to 319"), at a fraction of its memory.
 * - C2: a sky-connected component counts when one of its voxels lies ≥ 8 below its own position's pre-cave top; the
 *   share is over the tagged voxels of the components' box with y ≥ top − 40 ("within 40 of the surface").
 * - C3: each kind's share of the tagged voxels (y −64 … 319); `maxShare` over the single kinds 1-9 (`CAVE_KIND`);
 *   `pillars` over 128 × 128-block tiles aligned to the region's corner (the master's 8 × 8-chunk blocks); a ravine
 *   source carves a voxel when the voxel's tag is ravine and the source is the first ravine source in the global order
 *   (sz, then sx; `referenceCarve`'s, the window's order) whose path's carve test holds there (T's first-source rule).
 * - C4: the bands are 16 blocks from −56: −56 … −41, …, 24 … 39. A floor voxel is a voxel of a component ≥ 10,000
 *   whose voxel below is not tagged; `floorPeak` is the largest share one y holds of those floors.
 * - C5: `largest` per region (the largest component over the region's tagged voxels in the components' box), the
 *   worst region's; a land position's first voxel from y 319 down that is solid or holds fluid is solid without fluid;
 *   a component's thinnest axis is the median over its voxels of the voxel's local thickness (`localThickness`): the
 *   largest ball inside the components that holds the voxel, centred on a voxel centre or a voxel corner, read as its
 *   least extent in voxels along x, y or z (capped at 255). A 10 × 10 × 10 cavern gives 10, a straight 4 × 4 tunnel 4,
 *   a round tube of diameter D (its voxels' centres within D/2 of its axis) D, a diagonal one of diameter 6 within 1
 *   of 6. Unlike a bounding box it follows a winding tunnel, and unlike the shortest axis-aligned run through a voxel
 *   it does not read a round section's edge voxels as thin (that run gave 2, 3, 5, 6, 8 for D 4, 5, 6, 8, 10). The
 *   box's faces cut the components (a component cut by the region's border or by y −56 reads thinner there). "Mostly"
 *   a kind: more than half its voxels.
 * - C6: per band, the carve rate of the underground voxels with y ≡ r (mod 8), x ≡ r (mod 4) and z ≡ r (mod 4), each
 *   over the band's rate; the maximum over residues and the bands whose rate is > 0.
 * The region parts pool their counts over the regions (C1 per profile); the per-km² parts divide by the regions' area.
 *
 * C7-C9 (the tuning parts; C7's construction parts live in `caves.metric.ts`):
 * - A cave wall: a face of a cave voxel (tagged, not solid) whose face neighbour in the grid is solid (a non-air block);
 *   a neighbour beyond the grid is not seen.
 * - C7.borderPlaneRatio: the walls facing along x counted at the cave voxel's x mod 16 (a cut on the chunk border shows
 *   at x mod 16 = 0 when the cave lies on the border's +x side, at 15 when on its −x side), each residue's count over its
 *   face slots (the faces of that orientation with both voxels in the grid, so the grid's own faces do not read low),
 *   and the rate at 0 over the mean rate at 4, 8, 12, at 15 over 3, 7, 11; z alike. The part is the one of the four
 *   ratios farthest from 1 (|ln r|), the bound being two-sided.
 * - C7.verticalStep: the carve rate per y over the underground voxels (y ≤ top − 8, C1's), smoothed as the 3 layers'
 *   pooled counts; per group (below) its largest step, the part the worst group's.
 * - C7.flatWallShare: a wall is flat when it lies in a 6 × 6 square of walls of one orientation (the solid neighbour on
 *   the same side) on one plane; on archipelago, the walls of the sea floor's positions (the true top holds fluid).
 * - C7.switchWall: T is the `terrain` tap's value at the voxel (`RegionView.terrainT`, recomputed per column, so read on
 *   the columns of every 4th chunk in x and z on quick and full, every 2nd on fast); the shell's share of the walls (a
 *   wall in the shell when its cave voxel is) over its share of the pre-cave rock (solid or tagged voxels, y ≥ −56).
 * - C7.waterWall: a fluid voxel with a horizontal neighbour that is tagged air (tagged, neither solid nor fluid).
 * - C8.aperiodicity: m is the tag (1 when tagged) on the layer; the random-pair mean is the expectation 2f(1 − f) of
 *   |m(p) − m(q)| over the layer's ordered pairs (f its tagged share in the region); per (layer, axis, lag) the pooled
 *   Σ |Δm| over Σ expectation, the part the smallest.
 * - C8.typeMixVariation: C3's five shares (cheese, spaghetti 3D + 2D, noodle, the three carvers, entrances; other
 *   density air left out) per 128 × 128 tile of all y; the divergence in bits (0 … 1); pairs with an empty tile left out.
 * - C8.sizeSpread: the sample standard deviation of the natural log of the volumes; C8.largeShare its second value. The
 *   three C8 parts named read only 32 × 32-chunk regions (the spec's region size), so they are NaN on fast.
 * - C9: an opening is a voxel of a C2 component (C2.skyComponents' components) face-adjacent to untagged open air;
 *   C9.nearestEntrance draws its 256 positions among the land positions (C5's rule) that are not river (the column
 *   sample's nearest corner has no wet-river or gorge flag) and measures to the region's own openings (an opening beyond
 *   the region is not seen; a region with none gives NaN distances); C9.entrancesMax is C2.skyComponents' count per km²;
 *   C9.holedSurface's top is the pre-cave top, C9.thinRoof's the true top (land: solid without fluid).
 * - The groups: 'default' (the default and large_biomes regions) and each preset. The parts the spec marks "default and
 *   presets" (verticalStep, nearestEntrance, holedSurface) and "default and archipelago" (flatWallShare, waterWall) are
 *   the worst of those groups; the others read the default group.
 */
import { CARVER_WINDOW_R, CAVE_KIND } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { carveTest, densityTopOf, wetAt } from '../../src/gen/caves/carve';
import { carverParamsOf, carverPath, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { buildColumnSample, nearestCornerIndex, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { hasFluid } from '../../src/world/blocks/fluid';
import { AIR } from '../../src/world/blocks/index';
import { components3d, type Components3d } from './flood';
import type { RegionView } from './region';

/** The grid's y range: the world's, −64 … 319. */
export const GRID_Y0 = -64;
export const GRID_H = 384;
/** A grid cell's bits: the tag (`CAVE_KIND`, bits 0-3), a non-air block (bit 4), a fluid (bit 5). */
export const TAG_MASK = 15;
export const SOLID_BIT = 16;
export const FLUID_BIT = 32;

/**
 * A region's voxels for the instruments: one byte per voxel of x ∈ [x0, x0 + w), z ∈ [z0, z0 + d), y ∈ [−64, 320),
 * index `((y + 64)·d + (z − z0))·w + (x − x0)`.
 */
export interface CaveGrid {
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly d: number;
  readonly cells: Uint8Array;
}

/** An empty grid: every voxel air, untagged, without fluid. */
export function emptyCaveGrid(x0: number, z0: number, w: number, d: number): CaveGrid {
  return { x0, z0, w, d, cells: new Uint8Array(w * d * GRID_H) };
}

/** The cell index of world voxel (x, y, z). */
export function cellAt(g: CaveGrid, x: number, y: number, z: number): number {
  return ((y - GRID_Y0) * g.d + (z - g.z0)) * g.w + (x - g.x0);
}

/** Sets world voxel (x, y, z) of `g`: its tag, whether its block is not air, and whether it holds a fluid. */
export function setCell(g: CaveGrid, x: number, y: number, z: number, tag: number, solid: boolean, fluid = false): void {
  g.cells[cellAt(g, x, y, z)] = (tag & TAG_MASK) | (solid ? SOLID_BIT : 0) | (fluid ? FLUID_BIT : 0);
}

/** The grid of a view's region, from each column's final set (Decorated and above), else its proto set. */
export function caveGridOf(view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>): CaveGrid {
  const g = emptyCaveGrid(16 * view.cx0, 16 * view.cz0, 16 * view.w, 16 * view.h);
  const { w, d, cells } = g;
  for (let cz = view.cz0; cz < view.cz0 + view.h; cz++) {
    for (let cx = view.cx0; cx < view.cx0 + view.w; cx++) {
      const col = view.store.final(cx, cz) ?? view.store.proto(cx, cz);
      if (col === null) throw new Error(`caveGridOf: column (${cx}, ${cz}) has no set`);
      const bx = 16 * (cx - view.cx0);
      const bz = 16 * (cz - view.cz0);
      for (let sy = 0; sy < 24; sy++) {
        const cave = col.sectionCave(sy);
        const blocks = col.sectionBlocks(sy);
        const fluid = col.sectionFluid(sy);
        for (let ly = 0; ly < 16; ly++) {
          for (let lz = 0; lz < 16; lz++) {
            const row = ((16 * sy + ly) * d + bz + lz) * w + bx;
            for (let lx = 0; lx < 16; lx++) {
              const i = ly * 256 + lz * 16 + lx;
              const tag = typeof cave === 'number' ? cave : cave[i]!;
              const block = typeof blocks === 'number' ? blocks : blocks[i]!;
              const fl = typeof fluid === 'number' ? fluid : fluid[i]!;
              cells[row + lx] = (tag & TAG_MASK) | (block !== AIR ? SOLID_BIT : 0) | (hasFluid(fl) ? FLUID_BIT : 0);
            }
          }
        }
      }
    }
  }
  return g;
}

/** The pre-cave top per position (z − z0)·w + (x − x0): the highest voxel solid or tagged, −64 at the lowest. */
export function preCaveTops(g: CaveGrid): Int16Array {
  const { w, d, cells } = g;
  const plane = w * d;
  const out = new Int16Array(plane);
  for (let p = 0; p < plane; p++) {
    let y = GRID_Y0 + GRID_H - 1;
    while (y > GRID_Y0 && (cells[(y - GRID_Y0) * plane + p]! & (TAG_MASK | SOLID_BIT)) === 0) y--;
    out[p] = y;
  }
  return out;
}

/** The components' lowest y (spec §10.1). */
export const COMP_Y_MIN = -56;

/** `components3d` over the grid's tagged voxels, with the box it labelled. */
export interface CaveComponents extends Components3d {
  readonly yMin: number;
  readonly yMax: number;
}

/** The 6-connected components of the tagged voxels of y −56 … yMax (see the header for yMax). */
export function caveComponents(g: CaveGrid, tops: Int16Array): CaveComponents {
  let top = COMP_Y_MIN;
  for (let p = 0; p < tops.length; p++) top = Math.max(top, tops[p]!);
  const yMin = COMP_Y_MIN;
  const yMax = Math.min(GRID_Y0 + GRID_H - 1, top + 1);
  const { w, d, cells } = g;
  const cell = (x: number, y: number, z: number): number => cells[((y - GRID_Y0) * d + z) * w + x]!;
  const c = components3d(
    (x, y, z) => (cell(x, y, z) & TAG_MASK) !== 0,
    (x, y, z) => (cell(x, y, z) & SOLID_BIT) === 0,
    w, d, yMin, yMax,
  );
  return { ...c, yMin, yMax };
}

// ---------------------------------------------------------------- C1

/** C1's counts: the tagged voxels and all voxels of y −56 … top − 8 over the positions. */
export function voidCounts(g: CaveGrid, tops: Int16Array): { tagged: number; voxels: number } {
  const plane = g.w * g.d;
  let tagged = 0;
  let voxels = 0;
  for (let p = 0; p < plane; p++) {
    const hi = tops[p]! - 8;
    for (let y = COMP_Y_MIN; y <= hi; y++) {
      voxels++;
      if ((g.cells[(y - GRID_Y0) * plane + p]! & TAG_MASK) !== 0) tagged++;
    }
  }
  return { tagged, voxels };
}

// ---------------------------------------------------------------- C2

/**
 * C2's counts: the sky-connected components with a voxel ≥ 8 below its position's top (`deepSky`), the tagged voxels
 * of the components' box within 40 of their position's top (`near`) and those of them in a sky-connected component.
 */
export function skyCounts(g: CaveGrid, tops: Int16Array, c: CaveComponents): { deepSky: number; near: number; nearSky: number } {
  const plane = g.w * g.d;
  const deep = new Set<number>();
  let near = 0;
  let nearSky = 0;
  for (let y = c.yMin; y <= c.yMax; y++) {
    const base = (y - c.yMin) * plane;
    for (let p = 0; p < plane; p++) {
      const l = c.label[base + p]!;
      if (l === 0) continue;
      const sky = c.sky.has(l);
      const top = tops[p]!;
      if (sky && y <= top - 8) deep.add(l);
      if (y >= top - 40) {
        near++;
        if (sky) nearSky++;
      }
    }
  }
  return { deepSky: deep.size, near, nearSky };
}

// ---------------------------------------------------------------- C3

/** The tagged voxels per tag 0-15 (index 0 unused: 0 is untagged). */
export function kindCounts(g: CaveGrid): Float64Array {
  const out = new Float64Array(16);
  const cells = g.cells;
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i]! & TAG_MASK;
    if (t !== 0) out[t]!++;
  }
  out[0] = 0;
  return out;
}

/**
 * C3.pillars' counts: the `tile` × `tile`-block tiles of the grid (aligned to its corner; w and d multiples of
 * `tile`) and those holding a voxel `pillarAt` reports, asked of the solid voxels above y −64 only (the pillar bit
 * needs rock), column by column in index order, a tile's scan stopping at its first pillar voxel.
 */
export function pillarTiles(g: CaveGrid, pillarAt: (x: number, y: number, z: number) => boolean, tile = 128): { tiles: number; withPillar: number } {
  const { w, d, cells } = g;
  if (w % tile !== 0 || d % tile !== 0) throw new RangeError(`pillarTiles: ${w} × ${d} is not a multiple of the tile ${tile}`);
  const plane = w * d;
  let tiles = 0;
  let withPillar = 0;
  for (let tz = 0; tz < d; tz += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      tiles++;
      let hit = false;
      for (let z = tz; z < tz + tile && !hit; z++) {
        for (let x = tx; x < tx + tile && !hit; x++) {
          for (let y = GRID_Y0 + 1; y < GRID_Y0 + GRID_H && !hit; y++) {
            if ((cells[(y - GRID_Y0) * plane + z * w + x]! & SOLID_BIT) === 0) continue;
            if (pillarAt(g.x0 + x, y, g.z0 + z)) hit = true;
          }
        }
      }
      if (hit) withPillar++;
    }
  }
  return { tiles, withPillar };
}

/**
 * C3.ravines' counts: of `paths` (ravine paths in the global order), those that carve ≥ 1 of the grid's ravine-tagged
 * voxels as its first carving path (`carves(path, e, x, y, z)`: ellipsoid e of the path carves the voxel), and of them
 * those one of whose voxels `sky` reports (sky-connected).
 */
export function ravineCounts(
  g: CaveGrid, paths: readonly CarverPath[], carves: (path: CarverPath, e: number, x: number, y: number, z: number) => boolean,
  sky: (x: number, y: number, z: number) => boolean,
): { sources: number; skySources: number; voxels: number } {
  const { x0, z0, w, d, cells } = g;
  const RAVINE: number = CAVE_KIND.ravine;
  // The ravine voxels' cell indices, ascending, and whether a path already owns each.
  let count = 0;
  for (let i = 0; i < cells.length; i++) if ((cells[i]! & TAG_MASK) === RAVINE) count++;
  const voxels = new Int32Array(count);
  for (let i = 0, k = 0; i < cells.length; i++) if ((cells[i]! & TAG_MASK) === RAVINE) voxels[k++] = i;
  const owned = new Uint8Array(count);
  const slotOf = (i: number): number => {
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const v = voxels[m]!;
      if (v === i) return m;
      if (v < i) lo = m + 1;
      else hi = m - 1;
    }
    return -1;
  };
  let sources = 0;
  let skySources = 0;
  for (const path of paths) {
    let carved = false;
    let toSky = false;
    const ell = path.ell;
    for (let e = 0; e < path.count; e++) {
      const o = 6 * e;
      const ex = ell[o]!, ey = ell[o + 1]!, ez = ell[o + 2]!, rh = ell[o + 3]!, rv = ell[o + 4]!;
      const xlo = Math.max(x0, Math.floor(ex - rh) - 1), xhi = Math.min(x0 + w - 1, Math.ceil(ex + rh) + 1);
      const zlo = Math.max(z0, Math.floor(ez - rh) - 1), zhi = Math.min(z0 + d - 1, Math.ceil(ez + rh) + 1);
      const ylo = Math.max(GRID_Y0 + 1, Math.floor(ey - rv) - 1), yhi = Math.min(GRID_Y0 + GRID_H - 1, Math.ceil(ey + rv) + 1);
      for (let y = ylo; y <= yhi; y++) {
        for (let z = zlo; z <= zhi; z++) {
          for (let x = xlo; x <= xhi; x++) {
            const i = ((y - GRID_Y0) * d + (z - z0)) * w + (x - x0);
            if ((cells[i]! & TAG_MASK) !== RAVINE) continue;
            const s = slotOf(i);
            if (owned[s] === 1 || !carves(path, e, x, y, z)) continue;
            owned[s] = 1;
            carved = true;
            if (!toSky && sky(x, y, z)) toSky = true;
          }
        }
      }
    }
    if (carved) sources++;
    if (toSky) skySources++;
  }
  return { sources, skySources, voxels: count };
}

/** How far past the region `ravinePathsOf` looks for sources, in chunks (`referenceCarve`'s margin). */
const RAVINE_SOURCE_MARGIN = 2;

/**
 * The ravine paths whose box meets the grid's box, sources sx in cx0 − R − 2 … cx1 + R + 2 (likewise sz) in the
 * global order (sz, then sx), and the carve test `ravineCounts` asks: `carveTest` with the voxel's wet′ (`wetAt` over
 * its column's sample) and its position's density top (`densityTopOf` over the grid's density solidity, a non-air
 * block or a carver tag, with `islands.enabled`'s rule), as `referenceCarve` reads them.
 */
export function ravinePathsOf(g: CaveGrid, seed: string, params: Params): {
  paths: CarverPath[]; carves: (path: CarverPath, e: number, x: number, y: number, z: number) => boolean;
} {
  const { x0, z0, w, d, cells } = g;
  const ctx = createGenContext(seedFromInput(seed), params);
  const p: CarverParams = carverParamsOf(params);
  const R = CARVER_WINDOW_R + RAVINE_SOURCE_MARGIN;
  const cx0 = x0 >> 4, cz0 = z0 >> 4, cx1 = (x0 + w - 1) >> 4, cz1 = (z0 + d - 1) >> 4;
  const paths: CarverPath[] = [];
  for (let sz = cz0 - R; sz <= cz1 + R; sz++) {
    for (let sx = cx0 - R; sx <= cx1 + R; sx++) {
      const path = carverPath(ctx.seed, 'ravine', sx, sz, p);
      if (path === null) continue;
      const b = path.box;
      if (b[3]! < x0 - 1 || b[0]! > x0 + w || b[5]! < z0 - 1 || b[2]! > z0 + d || b[4]! < GRID_Y0 || b[1]! > GRID_Y0 + GRID_H) continue;
      paths.push(path);
    }
  }
  const islands = params.islands.enabled;
  const plane = w * d;
  const wet = new Float64Array(plane).fill(Number.NaN);
  const top = new Float64Array(plane).fill(Number.NaN);
  const sample = newColumnSample();
  const densitySolid = (q: number, y: number): boolean => {
    const c = cells[(y - GRID_Y0) * plane + q]!;
    const t = c & TAG_MASK;
    return (c & SOLID_BIT) !== 0 || t === CAVE_KIND.worm || t === CAVE_KIND.ravine || t === CAVE_KIND.undergroundWorm;
  };
  const carves = (path: CarverPath, e: number, x: number, y: number, z: number): boolean => {
    const q = (z - z0) * w + (x - x0);
    if (Number.isNaN(wet[q]!)) {
      const cx = x >> 4, cz = z >> 4;
      buildColumnSample(ctx, cx, cz, sample);
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const xx = 16 * cx + lx, zz = 16 * cz + lz;
          if (xx >= x0 && xx < x0 + w && zz >= z0 && zz < z0 + d) wet[(zz - z0) * w + (xx - x0)] = wetAt(sample, xx, zz);
        }
      }
    }
    const wq = wet[q]!;
    if (wq > 0 && Number.isNaN(top[q]!)) top[q] = densityTopOf((yy) => densitySolid(q, yy), islands);
    return carveTest(p, path, e, x, y, z, wq, wq > 0 ? top[q]! : Number.NaN) === 1;
  };
  return { paths, carves };
}

// ---------------------------------------------------------------- C4, C6

/** C4's and C6's bands: 16 blocks each from −56 (−56 … −41, …, 24 … 39). */
export const BAND_Y0 = -56;
export const BANDS = 6;

/**
 * C4's and C6's counts per band b (6): the underground voxels (y ≤ top − 8) and the tagged ones, in total and per
 * residue y mod 8, x mod 4, z mod 4 (world coordinates). Index: total [b]; y residues [8b + r]; x and z [4b + r].
 */
export interface BandCounts {
  readonly voxels: Float64Array;
  readonly tagged: Float64Array;
  readonly yVoxels: Float64Array;
  readonly yTagged: Float64Array;
  readonly xVoxels: Float64Array;
  readonly xTagged: Float64Array;
  readonly zVoxels: Float64Array;
  readonly zTagged: Float64Array;
}

export function emptyBandCounts(): BandCounts {
  return {
    voxels: new Float64Array(BANDS), tagged: new Float64Array(BANDS),
    yVoxels: new Float64Array(8 * BANDS), yTagged: new Float64Array(8 * BANDS),
    xVoxels: new Float64Array(4 * BANDS), xTagged: new Float64Array(4 * BANDS),
    zVoxels: new Float64Array(4 * BANDS), zTagged: new Float64Array(4 * BANDS),
  };
}

const mod = (a: number, m: number): number => ((a % m) + m) % m;
/** a / b, NaN when b is 0 (an empty population). */
const ratio = (a: number, b: number): number => (b === 0 ? Number.NaN : a / b);

/** Adds the grid's band counts to `into` (fresh when absent). */
export function bandCounts(g: CaveGrid, tops: Int16Array, into: BandCounts = emptyBandCounts()): BandCounts {
  const { x0, z0, w, d, cells } = g;
  const plane = w * d;
  for (let b = 0; b < BANDS; b++) {
    for (let y = BAND_Y0 + 16 * b; y < BAND_Y0 + 16 * b + 16; y++) {
      const ry = 8 * b + mod(y, 8);
      for (let z = 0; z < d; z++) {
        const rz = 4 * b + mod(z0 + z, 4);
        for (let x = 0; x < w; x++) {
          const p = z * w + x;
          if (y > tops[p]! - 8) continue;
          const t = (cells[(y - GRID_Y0) * plane + p]! & TAG_MASK) !== 0 ? 1 : 0;
          const rx = 4 * b + mod(x0 + x, 4);
          into.voxels[b]!++;
          into.tagged[b]! += t;
          into.yVoxels[ry]!++;
          into.yTagged[ry]! += t;
          into.xVoxels[rx]!++;
          into.xTagged[rx]! += t;
          into.zVoxels[rz]!++;
          into.zTagged[rz]! += t;
        }
      }
    }
  }
  return into;
}

/** C4.bands: the lowest band carve rate; NaN when a band has no underground voxel. */
export function bandsMin(c: BandCounts): number {
  let min = Infinity;
  for (let b = 0; b < BANDS; b++) {
    if (c.voxels[b]! === 0) return Number.NaN;
    min = Math.min(min, c.tagged[b]! / c.voxels[b]!);
  }
  return min;
}

/** C6.latticeBias: the largest residue rate over its band's rate, over the bands carved; NaN when none is. */
export function latticeBias(c: BandCounts): number {
  let max = Number.NaN;
  for (let b = 0; b < BANDS; b++) {
    if (c.voxels[b]! === 0 || c.tagged[b]! === 0) continue;
    const mean = c.tagged[b]! / c.voxels[b]!;
    const consider = (v: Float64Array, t: Float64Array, k: number): void => {
      for (let r = 0; r < k; r++) {
        const i = k * b + r;
        if (v[i]! === 0) continue;
        const ratio = t[i]! / v[i]! / mean;
        if (!(ratio <= max)) max = ratio;
      }
    };
    consider(c.yVoxels, c.yTagged, 8);
    consider(c.xVoxels, c.xTagged, 4);
    consider(c.zVoxels, c.zTagged, 4);
  }
  return max;
}

/** Per band (C4, C6; recorded beside the parts): its first y, its carve rate and each residue's rate over it. */
export function bandDetail(c: BandCounts): Array<{ y0: number; rate: number; y: number[]; x: number[]; z: number[] }> {
  const out: Array<{ y0: number; rate: number; y: number[]; x: number[]; z: number[] }> = [];
  for (let b = 0; b < BANDS; b++) {
    const rate = ratio(c.tagged[b]!, c.voxels[b]!);
    const rel = (v: Float64Array, t: Float64Array, k: number): number[] =>
      Array.from({ length: k }, (_, r) => ratio(ratio(t[k * b + r]!, v[k * b + r]!), rate));
    out.push({ y0: BAND_Y0 + 16 * b, rate, y: rel(c.yVoxels, c.yTagged, 8), x: rel(c.xVoxels, c.xTagged, 4), z: rel(c.zVoxels, c.zTagged, 4) });
  }
  return out;
}

/** The components C4.floorPeak reads: ≥ 10,000 voxels. */
export const FLOOR_MIN_VOXELS = 10_000;

/**
 * C4.floorPeak's counts: the floor voxels of components ≥ `minSize` voxels (a voxel whose voxel below is not tagged)
 * per y, index y + 56 (y −56 … 319, 376 entries, whatever the components' yMax, so regions add up).
 */
export function floorCounts(g: CaveGrid, c: CaveComponents, minSize = FLOOR_MIN_VOXELS): Float64Array {
  const plane = g.w * g.d;
  const out = new Float64Array(GRID_Y0 + GRID_H - COMP_Y_MIN);
  for (let y = c.yMin; y <= c.yMax; y++) {
    const base = (y - c.yMin) * plane;
    const below = (y - 1 - GRID_Y0) * plane;
    for (let p = 0; p < plane; p++) {
      const l = c.label[base + p]!;
      if (l === 0 || c.size.get(l)! < minSize) continue;
      if ((g.cells[below + p]! & TAG_MASK) === 0) out[y - COMP_Y_MIN]!++;
    }
  }
  return out;
}

/** C4.floorPeak: the largest share one y holds of the floors; NaN without floors. */
export function floorPeak(floors: Float64Array): number {
  let total = 0;
  let max = 0;
  for (let i = 0; i < floors.length; i++) {
    total += floors[i]!;
    max = Math.max(max, floors[i]!);
  }
  return total === 0 ? Number.NaN : max / total;
}

// ---------------------------------------------------------------- C5

/** C5.largest's counts: the largest component and the tagged voxels of the components' box. */
export function largestCounts(c: CaveComponents): { largest: number; void: number } {
  let largest = 0;
  let total = 0;
  for (const s of c.size.values()) {
    largest = Math.max(largest, s);
    total += s;
  }
  return { largest, void: total };
}

/** C5.landCarved's counts: the land positions (see the header) and those holding a tagged voxel. */
export function landCounts(g: CaveGrid): { land: number; carved: number } {
  const { cells } = g;
  const plane = g.w * g.d;
  let land = 0;
  let carved = 0;
  for (let p = 0; p < plane; p++) {
    let y = GRID_H - 1;
    while (y > 0 && (cells[y * plane + p]! & (SOLID_BIT | FLUID_BIT)) === 0) y--;
    const c = cells[y * plane + p]!;
    if ((c & SOLID_BIT) === 0 || (c & FLUID_BIT) !== 0) continue;
    land++;
    for (let yy = 0; yy < GRID_H; yy++) {
      if ((cells[yy * plane + p]! & TAG_MASK) !== 0) {
        carved++;
        break;
      }
    }
  }
  return { land, carved };
}

/** The components C5's thinnest axis reads: ≥ 64 voxels. */
export const THIN_MIN_VOXELS = 64;
/** The cap of a local thickness (the per-voxel thicknesses are bytes). */
const THICK_CAP = 255;

/** The median of `v` (the mean of the two middle values for an even count); NaN when empty. */
export function median(v: ArrayLike<number>): number {
  if (v.length === 0) return Number.NaN;
  const s = Float64Array.from(v).sort();
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The median of a histogram of integer values (`hist[v]` = how many values v), NaN when it is empty. */
function histMedian(hist: Int32Array, from: number, n: number): number {
  let total = 0;
  for (let v = 0; v < n; v++) total += hist[from + v]!;
  if (total === 0) return Number.NaN;
  const kth = (k: number): number => {
    let acc = 0;
    for (let v = 0; v < n; v++) {
      acc += hist[from + v]!;
      if (acc > k) return v;
    }
    return n - 1;
  };
  return total % 2 === 1 ? kth(total >> 1) : (kth((total >> 1) - 1) + kth(total >> 1)) / 2;
}

/** The largest integer t ≥ 0 with t² < n; −1 when n ≤ 0. */
function rootBelow(n: number): number {
  if (n <= 0) return -1;
  let t = Math.floor(Math.sqrt(n));
  while (t > 0 && t * t >= n) t--;
  while ((t + 1) * (t + 1) < n) t++;
  return t;
}

/**
 * One line of the half-block distance transform (Felzenszwalb and Huttenlocher's lower envelope of parabolas): the
 * sites are the voxel centres of a run [a, b] and its two boundary voxels, at half-block positions 2(a − 1), 2a, …,
 * 2(b + 1), with `vals[0 … m − 1]` their values (quarter-block² units; the boundaries' the line's floor); writes
 * min over the sites of vals + (p − site)² at every half-block position p = 2a … 2b into `out[0 … 2(m − 2) − 2]`.
 */
function envelope(vals: Float64Array, m: number, out: Float64Array, v: Int32Array, zb: Float64Array): void {
  let k = 0;
  v[0] = 0;
  zb[0] = -Infinity;
  zb[1] = Infinity;
  for (let q = 1; q < m; q++) {
    const fq = vals[q]! + 4 * q * q;
    let r = v[k]!;
    let s = (fq - vals[r]! - 4 * r * r) / (4 * (q - r));
    while (s <= zb[k]!) {
      k--;
      r = v[k]!;
      s = (fq - vals[r]! - 4 * r * r) / (4 * (q - r));
    }
    k++;
    v[k] = q;
    zb[k] = s;
    zb[k + 1] = Infinity;
  }
  k = 0;
  const n = 2 * (m - 2) - 1;
  for (let i = 0; i < n; i++) {
    const p = i + 2;
    while (zb[k + 1]! < p) k++;
    const dp = p - 2 * v[k]!;
    out[i] = dp * dp + vals[v[k]!]!;
  }
}

/**
 * The thickness of the ball {voxel centres p : |p − c|² < F/4} (F in quarter-block² units) centred at the half-block
 * point c whose offsets from a voxel centre are (ox, oy, oz) half blocks (0 or 1): the least of its three extents in
 * voxels along the axes (its extent along an axis is the voxels on the axis-parallel line nearest c), capped at 255.
 */
function ballThickness(f: number, ox: number, oy: number, oz: number): number {
  const extent = (o: number, e: number): number => {
    const t = rootBelow(f - e);
    return t < 0 ? 0 : o === 1 ? 2 * ((t + 1) >> 1) : 2 * (t >> 1) + 1;
  };
  return Math.min(THICK_CAP, extent(ox, oy + oz), extent(oy, ox + oz), extent(oz, ox + oy));
}

/** The half-block distance between a voxel centre and a nearest voxel corner. */
const SQRT3 = Math.sqrt(3);

/**
 * The local thickness of every voxel of `c`'s components (box index `(y·d + z)·w + x`, y from `c.yMin`; 0 outside the
 * components): the largest thickness (`ballThickness`) of a ball that contains it, over the balls centred on voxel
 * centres and on voxel corners (so that an odd and an even width each have a centre), each with the largest radius
 * that keeps every voxel centre outside the components out (a voxel of no component, or any voxel beyond the box: the
 * box's faces cut a component). The distance to the nearest outside voxel centre is an exact separable Euclidean
 * distance transform on the half-block lattice (in y, then x, then z, run by run along each line: a point is inside
 * when every voxel nearest it is), one y plane at a time; a ball that the ball of one of its 8 nearest centres of the
 * other class holds is skipped (Hildebrand and Rüegsegger's local thickness, with the two centre classes). A round
 * tube of diameter D reads D; a square one, its side.
 */
export function localThickness(c: CaveComponents, w: number, d: number): Uint8Array {
  const h = c.yMax - c.yMin + 1;
  const plane = w * d;
  const label = c.label;
  const thick = new Uint8Array(plane * h);
  const w2 = 2 * w - 1;
  const d2 = 2 * d - 1;
  const h2 = 2 * h - 1;
  const plane2 = w2 * d2;
  // Per position, the nearest non-component voxel at or below the current y (−1 below the box) and at or above it.
  const lo = new Int32Array(plane).fill(-1);
  const hi = new Int32Array(plane).fill(-1);
  const f1 = new Float64Array(plane);
  const f2 = new Float64Array(w2 * d);
  // The squared distances (quarter-block² units, 0 = no ball) of three consecutive half-block planes, and their roots.
  let fPrev = new Float64Array(plane2);
  let fCur = new Float64Array(plane2);
  let fNext = new Float64Array(plane2);
  let rPrev = new Float64Array(plane2);
  let rCur = new Float64Array(plane2);
  let rNext = new Float64Array(plane2);
  const maxLen = Math.max(w, d) + 2;
  const vals = new Float64Array(maxLen);
  const out = new Float64Array(2 * maxLen);
  const env = new Int32Array(maxLen);
  const zb = new Float64Array(maxLen + 1);

  /** The half-block plane `yy`'s squared distances into `f` and their roots (half blocks) into `r`. */
  const planeOf = (yy: number, f: Float64Array, r: Float64Array): void => {
    f.fill(0);
    r.fill(0);
    const y = yy >> 1;
    const odd = yy & 1;
    const row = y * plane;
    if (odd === 0) {
      for (let p = 0; p < plane; p++) {
        if (label[row + p]! === 0) { lo[p] = y; hi[p] = y; } else if (hi[p]! < y) {
          let k = y + 1;
          while (k < h && label[k * plane + p]! !== 0) k++;
          hi[p] = k;
        }
      }
    }
    // y: the distance along the column to the nearest outside voxel centre; −1 where a nearest voxel is outside.
    for (let p = 0; p < plane; p++) {
      if (label[row + p]! === 0) { f1[p] = -1; continue; }
      if (odd === 0) {
        const t = 2 * Math.min(y - lo[p]!, hi[p]! - y);
        f1[p] = t * t;
      } else if (hi[p]! > y + 1) {
        const t = Math.min(2 * (y - lo[p]!) + 1, 2 * (hi[p]! - y) - 1);
        f1[p] = t * t;
      } else f1[p] = -1;
    }
    // x, then z: a run's boundary points have the line's floor, the squared half-block offsets already taken.
    const floor1 = odd;
    f2.fill(-1);
    for (let z = 0; z < d; z++) {
      const base = z * w;
      let x = 0;
      while (x < w) {
        if (f1[base + x]! < 0) { x++; continue; }
        let e = x;
        while (e < w && f1[base + e]! >= 0) e++;
        const len = e - x;
        vals[0] = floor1;
        for (let i = 0; i < len; i++) vals[i + 1] = f1[base + x + i]!;
        vals[len + 1] = floor1;
        envelope(vals, len + 2, out, env, zb);
        const o2 = z * w2 + 2 * x;
        for (let i = 0; i < 2 * len - 1; i++) f2[o2 + i] = out[i]!;
        x = e;
      }
    }
    for (let xx = 0; xx < w2; xx++) {
      const floor2 = floor1 + (xx & 1);
      let z = 0;
      while (z < d) {
        if (f2[z * w2 + xx]! < 0) { z++; continue; }
        let e = z;
        while (e < d && f2[e * w2 + xx]! >= 0) e++;
        const len = e - z;
        vals[0] = floor2;
        for (let i = 0; i < len; i++) vals[i + 1] = f2[(z + i) * w2 + xx]!;
        vals[len + 1] = floor2;
        envelope(vals, len + 2, out, env, zb);
        for (let i = 0; i < 2 * len - 1; i++) {
          const k = (2 * z + i) * w2 + xx;
          f[k] = out[i]!;
          r[k] = Math.sqrt(out[i]!);
        }
        z = e;
      }
    }
  };

  /** Paints the balls of half-block plane `yy`'s centres that no ball of a nearest centre of the other class holds. */
  const paint = (yy: number): void => {
    const planes = [rPrev, rCur, rNext];
    const odd = yy & 1;
    for (let zz = odd; zz < d2; zz += 2) {
      for (let xx = odd; xx < w2; xx += 2) {
        const k = zz * w2 + xx;
        const f = fCur[k]!;
        if (f <= 0) continue;
        const r = rCur[k]! + SQRT3 + 1e-9;
        let covered = false;
        for (let dy = -1; dy <= 1 && !covered; dy += 2) {
          if (yy + dy < 0 || yy + dy >= h2) continue;
          const rp = planes[dy + 1]!;
          for (let dz = -1; dz <= 1 && !covered; dz += 2) {
            const z2 = zz + dz;
            if (z2 < 0 || z2 >= d2) continue;
            for (let dx = -1; dx <= 1; dx += 2) {
              const x2 = xx + dx;
              if (x2 < 0 || x2 >= w2) continue;
              if (rp[z2 * w2 + x2]! >= r) { covered = true; break; }
            }
          }
        }
        if (covered) continue;
        const t = ballThickness(f, xx & 1, yy & 1, zz & 1);
        const qy = rootBelow(f);
        for (let vy = Math.max(0, Math.ceil((yy - qy) / 2)); vy <= Math.min(h - 1, (yy + qy) >> 1); vy++) {
          const ey = f - (2 * vy - yy) * (2 * vy - yy);
          const qz = rootBelow(ey);
          for (let vz = Math.max(0, Math.ceil((zz - qz) / 2)); vz <= Math.min(d - 1, (zz + qz) >> 1); vz++) {
            const ez = ey - (2 * vz - zz) * (2 * vz - zz);
            const qx = rootBelow(ez);
            const o = (vy * d + vz) * w;
            for (let vx = Math.max(0, Math.ceil((xx - qx) / 2)); vx <= Math.min(w - 1, (xx + qx) >> 1); vx++) {
              if (thick[o + vx]! < t) thick[o + vx] = t;
            }
          }
        }
      }
    }
  };

  planeOf(0, fCur, rCur);
  for (let yy = 0; yy < h2; yy++) {
    if (yy + 1 < h2) planeOf(yy + 1, fNext, rNext);
    else { fNext.fill(0); rNext.fill(0); }
    paint(yy);
    [fPrev, fCur, fNext] = [fCur, fNext, fPrev];
    [rPrev, rCur, rNext] = [rCur, rNext, rPrev];
  }
  return thick;
}

/**
 * C5.thinnest's values: per component ≥ `minSize` voxels, its thinnest axis (the median over its voxels of their
 * local thickness, `localThickness`), all of them and those of the components mostly cheese and mostly spaghetti 3D
 * (more than half their voxels of that tag).
 */
export function thinnestAxes(
  g: CaveGrid, c: CaveComponents, minSize = THIN_MIN_VOXELS, thickness: Uint8Array | null = null,
): { all: number[]; cheese: number[]; spaghetti3d: number[] } {
  const plane = g.w * g.d;
  const n = plane * (c.yMax - c.yMin + 1);
  const label = c.label;
  const slot = new Map<number, number>();
  for (const [l, s] of c.size) if (s >= minSize) slot.set(l, slot.size);
  const out = { all: [] as number[], cheese: [] as number[], spaghetti3d: [] as number[] };
  if (slot.size === 0) return out;
  const thick = thickness ?? localThickness(c, g.w, g.d);
  // A histogram of thicknesses per large component, and its cheese and spaghetti 3D voxels.
  const hist = new Int32Array(slot.size * (THICK_CAP + 1));
  const cheese = new Int32Array(slot.size);
  const spag = new Int32Array(slot.size);
  for (let i = 0; i < n; i++) {
    const l = label[i]!;
    if (l === 0) continue;
    const s = slot.get(l);
    if (s === undefined) continue;
    hist[s * (THICK_CAP + 1) + thick[i]!]!++;
    const t = g.cells[i + (c.yMin - GRID_Y0) * plane]! & TAG_MASK;
    if (t === CAVE_KIND.cheese) cheese[s]!++;
    else if (t === CAVE_KIND.spaghetti3d) spag[s]!++;
  }
  for (const [l, s] of slot) {
    const v = histMedian(hist, s * (THICK_CAP + 1), THICK_CAP + 1);
    out.all.push(v);
    const size = c.size.get(l)!;
    if (2 * cheese[s]! > size) out.cheese.push(v);
    if (2 * spag[s]! > size) out.spaghetti3d.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- one region, and the parts

/** One region's C1-C6 counts. */
export interface CaveRegionCounts {
  /** The region's area, km². */
  readonly areaKm2: number;
  readonly void: { tagged: number; voxels: number };
  readonly sky: { deepSky: number; near: number; nearSky: number };
  /** Tagged voxels per tag 0-15. */
  readonly kinds: number[];
  readonly pillars: { tiles: number; withPillar: number };
  readonly ravines: { sources: number; skySources: number; voxels: number };
  readonly bands: BandCounts;
  /** Floor voxels per y, y −56 … 319 (`floorCounts`). */
  readonly floors: number[];
  readonly largest: { largest: number; void: number };
  readonly land: { land: number; carved: number };
  readonly thinnest: { all: number[]; cheese: number[]; spaghetti3d: number[] };
  readonly components: number;
  readonly skyComponents: number;
}

/** What one region's instruments share: its pre-cave tops, its components and (when computed) their local thickness. */
export interface CaveShared {
  readonly tops: Int16Array;
  readonly c: CaveComponents;
  readonly thick: Uint8Array | null;
}

/**
 * Every C1-C6 count of one region. `pillarAt` is `RegionView.pillar` (the debug channel); `ravines` the ravine paths
 * and their carve test (`ravinePathsOf`); `tile` C3.pillars' tile (128; a fixture passes a smaller one); `shared` the
 * region's tops, components and thickness when the caller already has them (C7-C9 and the examples read the same).
 */
export function caveRegionCounts(
  g: CaveGrid, pillarAt: (x: number, y: number, z: number) => boolean,
  ravines: { paths: readonly CarverPath[]; carves: (path: CarverPath, e: number, x: number, y: number, z: number) => boolean },
  tile = 128, shared: CaveShared | null = null,
): CaveRegionCounts {
  const tops = shared?.tops ?? preCaveTops(g);
  const c = shared?.c ?? caveComponents(g, tops);
  const plane = g.w * g.d;
  const sky = (x: number, y: number, z: number): boolean => {
    if (y < c.yMin || y > c.yMax) return false;
    const l = c.label[(y - c.yMin) * plane + (z - g.z0) * g.w + (x - g.x0)]!;
    return l !== 0 && c.sky.has(l);
  };
  const floors = floorCounts(g, c);
  const counts: CaveRegionCounts = {
    areaKm2: plane / 1e6,
    void: voidCounts(g, tops),
    sky: skyCounts(g, tops, c),
    kinds: Array.from(kindCounts(g)),
    pillars: pillarTiles(g, pillarAt, tile),
    ravines: ravineCounts(g, ravines.paths, ravines.carves, sky),
    bands: bandCounts(g, tops),
    floors: Array.from(floors),
    largest: largestCounts(c),
    land: landCounts(g),
    thinnest: thinnestAxes(g, c, THIN_MIN_VOXELS, shared?.thick ?? null),
    components: c.size.size,
    skyComponents: c.sky.size,
  };
  return counts;
}

/** C1-C6's parts (spec §10.1; one value per threshold part, B2's split for a part with several values). */
export const C1_C6_PARTS = [
  'C1.voidShareMin', 'C1.voidShareMax',
  'C2.skyComponents', 'C2.skyShare',
  'C3.cheeseShare', 'C3.spaghettiShare', 'C3.noodleShare', 'C3.carverShare', 'C3.entranceShare', 'C3.pillars',
  'C3.ravines', 'C3.ravinesSky', 'C3.maxShare',
  'C4.bands', 'C4.floorPeak',
  'C5.largest', 'C5.landCarved', 'C5.thinnest', 'C5.thinnestByKind',
  'C6.latticeBias',
] as const;
export type C1C6Part = (typeof C1_C6_PARTS)[number];

/**
 * The parts over regions of one or more profiles: C1 per profile (the lowest and the highest profile's share), the
 * others pooled over every region given (the counts summed; `C5.largest` the worst region's).
 */
export function c1c6Parts(regions: ReadonlyArray<{ readonly profile: string; readonly counts: CaveRegionCounts }>): Record<C1C6Part, number> {
  const byProfile = new Map<string, { tagged: number; voxels: number }>();
  let area = 0;
  let deepSky = 0, near = 0, nearSky = 0;
  const kinds = new Float64Array(16);
  let tiles = 0, withPillar = 0, ravines = 0, ravinesSky = 0;
  const bands = emptyBandCounts();
  let floors: Float64Array | null = null;
  let largest = Number.NaN;
  let land = 0, landCarved = 0;
  const thin: number[] = [], cheese: number[] = [], spag: number[] = [];
  for (const { profile, counts: r } of regions) {
    const v = byProfile.get(profile) ?? { tagged: 0, voxels: 0 };
    v.tagged += r.void.tagged;
    v.voxels += r.void.voxels;
    byProfile.set(profile, v);
    area += r.areaKm2;
    deepSky += r.sky.deepSky;
    near += r.sky.near;
    nearSky += r.sky.nearSky;
    for (let t = 1; t < 16; t++) kinds[t]! += r.kinds[t]!;
    tiles += r.pillars.tiles;
    withPillar += r.pillars.withPillar;
    ravines += r.ravines.sources;
    ravinesSky += r.ravines.skySources;
    for (const k of Object.keys(bands) as Array<keyof BandCounts>) {
      const into = bands[k];
      const from = r.bands[k];
      for (let i = 0; i < into.length; i++) into[i]! += from[i]!;
    }
    if (floors === null) floors = new Float64Array(r.floors.length);
    for (let i = 0; i < r.floors.length; i++) floors[i]! += r.floors[i]!;
    const l = ratio(r.largest.largest, r.largest.void);
    if (!Number.isNaN(l) && !(l <= largest)) largest = l;
    land += r.land.land;
    landCarved += r.land.carved;
    thin.push(...r.thinnest.all);
    cheese.push(...r.thinnest.cheese);
    spag.push(...r.thinnest.spaghetti3d);
  }
  const shares = [...byProfile.values()].map((v) => ratio(v.tagged, v.voxels)).filter((s) => !Number.isNaN(s));
  let tagged = 0;
  let maxKind = 0;
  for (let t = 1; t < 16; t++) {
    tagged += kinds[t]!;
    maxKind = Math.max(maxKind, kinds[t]!);
  }
  const share = (...ts: number[]): number => ratio(ts.reduce((a, t) => a + kinds[t]!, 0), tagged);
  const K = CAVE_KIND;
  return {
    'C1.voidShareMin': shares.length === 0 ? Number.NaN : Math.min(...shares),
    'C1.voidShareMax': shares.length === 0 ? Number.NaN : Math.max(...shares),
    'C2.skyComponents': ratio(deepSky, area),
    'C2.skyShare': ratio(nearSky, near),
    'C3.cheeseShare': share(K.cheese),
    'C3.spaghettiShare': share(K.spaghetti3d, K.spaghetti2d),
    'C3.noodleShare': share(K.noodle),
    'C3.carverShare': share(K.worm, K.ravine, K.undergroundWorm),
    'C3.entranceShare': share(K.entrance),
    'C3.pillars': ratio(withPillar, tiles),
    'C3.ravines': ratio(ravines, area),
    'C3.ravinesSky': ratio(ravinesSky, area),
    'C3.maxShare': ratio(maxKind, tagged),
    'C4.bands': bandsMin(bands),
    'C4.floorPeak': floors === null ? Number.NaN : floorPeak(floors),
    'C5.largest': largest,
    'C5.landCarved': ratio(landCarved, land),
    'C5.thinnest': median(thin),
    'C5.thinnestByKind': ratio(median(cheese), median(spag)),
    'C6.latticeBias': latticeBias(bands),
  };
}

// ---------------------------------------------------------------- C7 (the tuning parts)

/** Whether a cell is cave air: tagged and not solid (it may hold a fluid). */
const caveCell = (cell: number): boolean => (cell & TAG_MASK) !== 0 && (cell & SOLID_BIT) === 0;

/**
 * C7.borderPlaneRatio's counts: the cave walls (a cave voxel's face whose neighbour is solid) facing along x per
 * x mod 16 of the cave voxel (index 0-15), and facing along z per z mod 16 (16-31); and the face slots (the voxel faces
 * of that orientation whose two voxels are both in the grid) per residue, so a residue whose plane lies on the grid's
 * face (its outer faces not seen) is not read low.
 */
export interface WallResidues {
  readonly faces: Float64Array;
  readonly slots: Float64Array;
}

export function emptyWallResidues(): WallResidues {
  return { faces: new Float64Array(32), slots: new Float64Array(32) };
}

/** Adds the grid's walls and slots per residue to `into` (fresh when absent). */
export function wallResidues(g: CaveGrid, into: WallResidues = emptyWallResidues()): WallResidues {
  const { x0, z0, w, d, cells } = g;
  const { faces, slots } = into;
  for (let x = 0; x < w; x++) slots[mod(x0 + x, 16)]! += GRID_H * d * ((x > 0 ? 1 : 0) + (x < w - 1 ? 1 : 0));
  for (let z = 0; z < d; z++) slots[16 + mod(z0 + z, 16)]! += GRID_H * w * ((z > 0 ? 1 : 0) + (z < d - 1 ? 1 : 0));
  const rx = new Int32Array(w);
  for (let x = 0; x < w; x++) rx[x] = mod(x0 + x, 16);
  for (let i = 0, n = cells.length; i < n; i++) {
    const c = cells[i]!;
    if ((c & TAG_MASK) === 0 || (c & SOLID_BIT) !== 0) continue;
    const x = i % w;
    const z = ((i - x) / w) % d;
    const r = rx[x]!;
    const q = 16 + mod(z0 + z, 16);
    if (x > 0 && (cells[i - 1]! & SOLID_BIT) !== 0) faces[r]!++;
    if (x < w - 1 && (cells[i + 1]! & SOLID_BIT) !== 0) faces[r]!++;
    if (z > 0 && (cells[i - w]! & SOLID_BIT) !== 0) faces[q]!++;
    if (z < d - 1 && (cells[i + w]! & SOLID_BIT) !== 0) faces[q]!++;
  }
  return into;
}

/**
 * C7.borderPlaneRatio: per orientation, the wall rate (walls / slots) of the chunk-border residue over the mean rate of
 * the three residues of the same lattice residue mod 4 inside the chunk: x 0 over x 4, 8, 12; x 15 over 3, 7, 11; z
 * alike. `value` is the ratio farthest from 1 (|ln r| largest; NaN ratios left out, NaN when all are).
 */
export function borderPlaneRatio(r: WallResidues): { value: number; x0: number; x15: number; z0: number; z15: number } {
  const rate = (k: number): number => ratio(r.faces[k]!, r.slots[k]!);
  const rel = (edge: number, inner: readonly number[]): number =>
    ratio(rate(edge), (rate(inner[0]!) + rate(inner[1]!) + rate(inner[2]!)) / 3);
  const x0 = rel(0, [4, 8, 12]);
  const x15 = rel(15, [3, 7, 11]);
  const z0 = rel(16, [20, 24, 28]);
  const z15 = rel(31, [19, 23, 27]);
  let value = Number.NaN;
  let worst = -1;
  for (const v of [x0, x15, z0, z15]) {
    if (Number.isNaN(v)) continue;
    const dev = v === 0 ? Infinity : Math.abs(Math.log(v));
    if (dev > worst) {
      worst = dev;
      value = v;
    }
  }
  return { value, x0, x15, z0, z15 };
}

/** C7.verticalStep's counts per y (index y + 64): the underground voxels (y ≤ top − 8, C1's) and the tagged ones. */
export interface LayerCounts {
  readonly voxels: Float64Array;
  readonly tagged: Float64Array;
}

export function emptyLayerCounts(): LayerCounts {
  return { voxels: new Float64Array(GRID_H), tagged: new Float64Array(GRID_H) };
}

/** Adds the grid's per-layer counts to `into` (fresh when absent). */
export function layerCounts(g: CaveGrid, tops: Int16Array, into: LayerCounts = emptyLayerCounts()): LayerCounts {
  const plane = g.w * g.d;
  const cells = g.cells;
  for (let p = 0; p < plane; p++) {
    const hi = Math.min(GRID_Y0 + GRID_H - 1, tops[p]! - 8);
    for (let y = GRID_Y0; y <= hi; y++) {
      const k = y - GRID_Y0;
      into.voxels[k]!++;
      if ((cells[k * plane + p]! & TAG_MASK) !== 0) into.tagged[k]!++;
    }
  }
  return into;
}

/** C7.verticalStep's range and the smallest smoothed carve rate it compares (spec §10.1). */
export const STEP_Y0 = -60;
export const STEP_Y1 = 120;
export const STEP_MIN_RATE = 0.001;

/**
 * C7.verticalStep: over y −60 … 120, the largest s(y) / s(y ± 1), s the carve rate smoothed over 3 layers (the tagged
 * voxels of y − 1 … y + 1 over their underground voxels), both rates ≥ 0.1 %; NaN when no pair qualifies.
 */
export function verticalStep(c: LayerCounts, minRate = STEP_MIN_RATE): number {
  return verticalStepDetail(c, minRate).value;
}

/** C7.verticalStep with where it lies: the layer y, its neighbour n, their smoothed rates and y's 3-layer population. */
export function verticalStepDetail(c: LayerCounts, minRate = STEP_MIN_RATE): {
  value: number; y: number; n: number; rate: number; rateN: number; voxels: number;
} {
  const pop = (y: number): number => {
    let v = 0;
    for (let k = y - 1; k <= y + 1; k++) if (k >= GRID_Y0 && k < GRID_Y0 + GRID_H) v += c.voxels[k - GRID_Y0]!;
    return v;
  };
  const s = (y: number): number => {
    let t = 0;
    let v = 0;
    for (let k = y - 1; k <= y + 1; k++) {
      if (k < GRID_Y0 || k >= GRID_Y0 + GRID_H) continue;
      t += c.tagged[k - GRID_Y0]!;
      v += c.voxels[k - GRID_Y0]!;
    }
    return ratio(t, v);
  };
  const out = { value: Number.NaN, y: Number.NaN, n: Number.NaN, rate: Number.NaN, rateN: Number.NaN, voxels: 0 };
  for (let y = STEP_Y0; y <= STEP_Y1; y++) {
    const sy = s(y);
    if (!(sy >= minRate)) continue;
    for (const n of [y - 1, y + 1]) {
      const sn = s(n);
      if (!(sn >= minRate)) continue;
      const r = sy / sn;
      if (!(r <= out.value)) Object.assign(out, { value: r, y, n, rate: sy, rateN: sn, voxels: pop(y) });
    }
  }
  return out;
}

/** The side of C7.flatWallShare's planar patches, in faces. */
export const FLAT_SIDE = 6;

/** A growable Int32 list. */
class IntList {
  a = new Int32Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(2 * this.a.length);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/** Two sorted lists of disjoint inclusive intervals' intersection, the intervals of at least `side` kept. */
function intersect(a: number[], b: number[], side: number): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]!, b[j]!);
    const hi = Math.min(a[i + 1]!, b[j + 1]!);
    if (hi - lo + 1 >= side) out.push(lo, hi);
    if (a[i + 1]! < b[j + 1]!) i += 2;
    else j += 2;
  }
  return out;
}

/**
 * The faces of one orientation (sorted keys `(plane·R + row)·C + col`) that lie in a `side` × `side` square of faces
 * all present (rows in one plane), each marked 1 in `mark` (by key index).
 */
function flatFaces(keys: Int32Array, R: number, C: number, side: number, mark: Uint8Array): number {
  const n = keys.length;
  // The runs along a row of ≥ side faces: their first key index, row (plane·R + row) and first and last column.
  const rs: number[] = [];
  const rr: number[] = [];
  const rc: number[] = [];
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && keys[j] === keys[j - 1]! + 1 && keys[j]! % C !== 0) j++;
    if (j - i >= side) {
      rs.push(i);
      rr.push(Math.floor(keys[i]! / C));
      rc.push(keys[i]! % C, keys[j - 1]! % C);
    }
    i = j;
  }
  // The rows holding runs, in order: [row, first run, end].
  const rows: number[] = [];
  for (let k = 0; k < rr.length;) {
    let e = k + 1;
    while (e < rr.length && rr[e] === rr[k]) e++;
    rows.push(rr[k]!, k, e);
    k = e;
  }
  const runsOf = (a: number): number[] => {
    const out: number[] = [];
    for (let k = rows[3 * a + 1]!; k < rows[3 * a + 2]!; k++) out.push(rc[2 * k]!, rc[2 * k + 1]!);
    return out;
  };
  const nr = rows.length / 3;
  for (let a = 0; a + side - 1 < nr; a++) {
    const q = rows[3 * a]!;
    if (rows[3 * (a + side - 1)]! !== q + side - 1 || Math.floor(q / R) !== Math.floor((q + side - 1) / R)) continue;
    let iv = runsOf(a);
    for (let k = 1; k < side && iv.length > 0; k++) iv = intersect(iv, runsOf(a + k), side);
    if (iv.length === 0) continue;
    for (let k = 0; k < side; k++) {
      const row = a + k;
      for (let m = 0; m < iv.length; m += 2) {
        const lo = iv[m]!;
        const hi = iv[m + 1]!;
        for (let r = rows[3 * row + 1]!; r < rows[3 * row + 2]!; r++) {
          if (rc[2 * r]! > lo || rc[2 * r + 1]! < hi) continue;
          const from = rs[r]! + lo - rc[2 * r]!;
          for (let f = from; f <= from + hi - lo; f++) mark[f] = 1;
          break;
        }
      }
    }
  }
  let flat = 0;
  for (let i = 0; i < n; i++) flat += mark[i]!;
  return flat;
}

/**
 * C7.flatWallShare's counts: the cave walls (a cave voxel's face whose neighbour in the grid is solid) and those lying
 * in an axis-aligned planar patch of at least `side` × `side` faces, i.e. in a `side` × `side` square of walls of one
 * orientation on one plane (the square's faces all present). With `positions` (index (z − z0)·w + (x − x0)), only the
 * walls of cave voxels at positions it marks.
 */
export function flatWallCounts(g: CaveGrid, positions: Uint8Array | null = null, side = FLAT_SIDE): { faces: number; flat: number } {
  const { faces, flat } = flatWallDetail(g, positions, side);
  return { faces, flat };
}

/**
 * `flatWallCounts` per orientation as well (index 0-5: −x, +x, −y (floors), +y (ceilings), −z, +z, the side the solid
 * neighbour lies on), and the flat floors and ceilings per y of their cave voxel (index y + 64).
 */
export function flatWallDetail(g: CaveGrid, positions: Uint8Array | null = null, side = FLAT_SIDE): {
  faces: number; flat: number; facesBy: number[]; flatBy: number[]; flatFloorsByY: Float64Array; flatCeilingsByY: Float64Array;
} {
  const { w, d, cells } = g;
  const plane = w * d;
  // Orientation 0/1: −x/+x (plane x, row y, column z); 2/3: −y/+y (plane y, row z, column x); 4/5: −z/+z (plane z, row
  // y, column x).
  const lists = Array.from({ length: 6 }, () => new IntList());
  for (let i = 0, n = cells.length; i < n; i++) {
    const c = cells[i]!;
    if ((c & TAG_MASK) === 0 || (c & SOLID_BIT) !== 0) continue;
    const x = i % w;
    const rest = (i - x) / w;
    const z = rest % d;
    const y = (rest - z) / d;
    if (positions !== null && positions[z * w + x] === 0) continue;
    const kx = (x * GRID_H + y) * d + z;
    const kz = (z * GRID_H + y) * w + x;
    if (x > 0 && (cells[i - 1]! & SOLID_BIT) !== 0) lists[0]!.push(kx);
    if (x < w - 1 && (cells[i + 1]! & SOLID_BIT) !== 0) lists[1]!.push(kx);
    if (y > 0 && (cells[i - plane]! & SOLID_BIT) !== 0) lists[2]!.push(i);
    if (y < GRID_H - 1 && (cells[i + plane]! & SOLID_BIT) !== 0) lists[3]!.push(i);
    if (z > 0 && (cells[i - w]! & SOLID_BIT) !== 0) lists[4]!.push(kz);
    if (z < d - 1 && (cells[i + w]! & SOLID_BIT) !== 0) lists[5]!.push(kz);
  }
  const dims: ReadonlyArray<readonly [R: number, C: number]> = [[GRID_H, d], [GRID_H, d], [d, w], [d, w], [GRID_H, w], [GRID_H, w]];
  const facesBy: number[] = [];
  const flatBy: number[] = [];
  const byY = [new Float64Array(GRID_H), new Float64Array(GRID_H)];
  for (let o = 0; o < 6; o++) {
    const l = lists[o]!;
    const keys = l.a.subarray(0, l.n).sort();
    const mark = new Uint8Array(l.n);
    facesBy.push(l.n);
    flatBy.push(flatFaces(keys, dims[o]![0], dims[o]![1], side, mark));
    if (o === 2 || o === 3) for (let k = 0; k < l.n; k++) if (mark[k] === 1) byY[o - 2]![Math.floor(keys[k]! / plane)]!++;
  }
  return {
    faces: facesBy.reduce((a, v) => a + v, 0), flat: flatBy.reduce((a, v) => a + v, 0), facesBy, flatBy,
    flatFloorsByY: byY[0]!, flatCeilingsByY: byY[1]!,
  };
}

/** C7.switchWall's shell: |T − 8| < 1 (spec §10.1; the surface ramp's switch at T = d_s, §1.4). */
export const SWITCH_T = 8;

/** C7.switchWall's counts: the walls and those of shell voxels; the pre-cave rock voxels and those in the shell. */
export interface SwitchCounts {
  readonly faces: number;
  readonly shellFaces: number;
  readonly voxels: number;
  readonly shellVoxels: number;
}

/**
 * C7.switchWall's counts over the columns of every `stride`-th chunk in x and in z from the grid's corner chunk: the
 * pre-cave rock voxels (solid or tagged) of y −56 … 319 and those in the shell (|T − 8| < 1, T read at the voxel by
 * `T`, asked of those voxels only, chunk column by chunk column), and the walls of their cave voxels (any of the six
 * faces whose neighbour in the grid is solid), a wall in the shell when its cave voxel is.
 */
export function switchWallCounts(g: CaveGrid, T: (x: number, y: number, z: number) => number, stride = 1): SwitchCounts {
  const { x0, z0, w, d, cells } = g;
  const plane = w * d;
  let faces = 0;
  let shellFaces = 0;
  let voxels = 0;
  let shellVoxels = 0;
  const c0x = Math.floor(x0 / 16);
  const c0z = Math.floor(z0 / 16);
  for (let cz = c0z; 16 * cz < z0 + d; cz += stride) {
    for (let cx = c0x; 16 * cx < x0 + w; cx += stride) {
      for (let wz = Math.max(z0, 16 * cz); wz < Math.min(z0 + d, 16 * cz + 16); wz++) {
        for (let wx = Math.max(x0, 16 * cx); wx < Math.min(x0 + w, 16 * cx + 16); wx++) {
          const x = wx - x0;
          const z = wz - z0;
          for (let y = COMP_Y_MIN; y < GRID_Y0 + GRID_H; y++) {
            const yi = y - GRID_Y0;
            const i = (yi * d + z) * w + x;
            const c = cells[i]!;
            if ((c & (SOLID_BIT | TAG_MASK)) === 0) continue;
            const shell = Math.abs(T(wx, y, wz) - SWITCH_T) < 1;
            voxels++;
            if (shell) shellVoxels++;
            if (!caveCell(c)) continue;
            let k = 0;
            if (x > 0 && (cells[i - 1]! & SOLID_BIT) !== 0) k++;
            if (x < w - 1 && (cells[i + 1]! & SOLID_BIT) !== 0) k++;
            if (yi > 0 && (cells[i - plane]! & SOLID_BIT) !== 0) k++;
            if (yi < GRID_H - 1 && (cells[i + plane]! & SOLID_BIT) !== 0) k++;
            if (z > 0 && (cells[i - w]! & SOLID_BIT) !== 0) k++;
            if (z < d - 1 && (cells[i + w]! & SOLID_BIT) !== 0) k++;
            faces += k;
            if (shell) shellFaces += k;
          }
        }
      }
    }
  }
  return { faces, shellFaces, voxels, shellVoxels };
}

/** C7.switchWall: the shell's share of the walls over its share of the pre-cave rock; NaN for an empty population. */
export function switchWall(c: SwitchCounts): number {
  return ratio(ratio(c.shellFaces, c.faces), ratio(c.shellVoxels, c.voxels));
}

/** C7.waterWall's count: the fluid voxels with a horizontal neighbour in the grid that is tagged air (no fluid). */
export function waterWallCount(g: CaveGrid): number {
  const { w, d, cells } = g;
  const air = (c: number): boolean => (c & TAG_MASK) !== 0 && (c & (SOLID_BIT | FLUID_BIT)) === 0;
  let count = 0;
  for (let i = 0, n = cells.length; i < n; i++) {
    if ((cells[i]! & FLUID_BIT) === 0) continue;
    const x = i % w;
    const z = ((i - x) / w) % d;
    if ((x > 0 && air(cells[i - 1]!)) || (x < w - 1 && air(cells[i + 1]!)) || (z > 0 && air(cells[i - w]!)) || (z < d - 1 && air(cells[i + w]!))) count++;
  }
  return count;
}

// ---------------------------------------------------------------- C8

/** C8.aperiodicity's layers. */
export const APERIODIC_YS: readonly number[] = [-40, 0, 40];

/** C8.aperiodicity's lags along an axis `width` blocks long: 16, 32, 64 … up to width − 16 (pairs inside the region). */
export function aperiodicLags(width: number): number[] {
  const out: number[] = [];
  for (let L = 16; L <= width - 16; L *= 2) out.push(L);
  return out;
}

/**
 * One (layer, axis, lag) of C8.aperiodicity over one region: Σ |m(p) − m(p + L·e)| over the pairs inside the region
 * (m = 1 at a tagged voxel), the pairs, and the random-pair expectation pairs · 2f(1 − f) (f the layer's tagged share in
 * the region: the mean |m(p) − m(q)| over all ordered pairs of the layer).
 */
export interface LagCount {
  readonly y: number;
  readonly axis: 'x' | 'z';
  readonly lag: number;
  readonly diff: number;
  readonly pairs: number;
  readonly expected: number;
}

/** The region's lag counts, per layer of `APERIODIC_YS`: the x lags, then the z lags. */
export function aperiodicCounts(g: CaveGrid): LagCount[] {
  const { w, d, cells } = g;
  const plane = w * d;
  const out: LagCount[] = [];
  const m = new Uint8Array(plane);
  for (const y of APERIODIC_YS) {
    const base = (y - GRID_Y0) * plane;
    let tagged = 0;
    for (let p = 0; p < plane; p++) {
      m[p] = (cells[base + p]! & TAG_MASK) !== 0 ? 1 : 0;
      tagged += m[p]!;
    }
    const f = tagged / plane;
    for (const lag of aperiodicLags(w)) {
      let diff = 0;
      for (let z = 0; z < d; z++) for (let x = 0; x + lag < w; x++) diff += m[z * w + x]! ^ m[z * w + x + lag]!;
      const pairs = (w - lag) * d;
      out.push({ y, axis: 'x', lag, diff, pairs, expected: pairs * 2 * f * (1 - f) });
    }
    for (const lag of aperiodicLags(d)) {
      let diff = 0;
      for (let z = 0; z + lag < d; z++) for (let x = 0; x < w; x++) diff += m[z * w + x]! ^ m[(z + lag) * w + x]!;
      const pairs = (d - lag) * w;
      out.push({ y, axis: 'z', lag, diff, pairs, expected: pairs * 2 * f * (1 - f) });
    }
  }
  return out;
}

/** Per (layer, axis, lag), the pooled Σ diff / Σ expected over the regions given. */
export function aperiodicRatios(counts: readonly LagCount[]): Array<{ y: number; axis: 'x' | 'z'; lag: number; ratio: number }> {
  const sums = new Map<string, { y: number; axis: 'x' | 'z'; lag: number; diff: number; expected: number }>();
  for (const c of counts) {
    const k = `${c.y} ${c.axis} ${c.lag}`;
    const s = sums.get(k) ?? { y: c.y, axis: c.axis, lag: c.lag, diff: 0, expected: 0 };
    s.diff += c.diff;
    s.expected += c.expected;
    sums.set(k, s);
  }
  return [...sums.values()].map((s) => ({ y: s.y, axis: s.axis, lag: s.lag, ratio: ratio(s.diff, s.expected) }));
}

/** C8.aperiodicity: the smallest pooled ratio over the layers, axes and lags; NaN when none is defined. */
export function aperiodicity(counts: readonly LagCount[]): number {
  let min = Number.NaN;
  for (const r of aperiodicRatios(counts)) if (!Number.isNaN(r.ratio) && !(r.ratio >= min)) min = r.ratio;
  return min;
}

/** C3's shares as C8.typeMixVariation reads them: cheese, spaghetti (3D + 2D), noodle, carvers, entrances. */
const MIX_GROUP: Int8Array = (() => {
  const t = new Int8Array(16).fill(-1);
  t[CAVE_KIND.cheese] = 0;
  t[CAVE_KIND.spaghetti3d] = 1;
  t[CAVE_KIND.spaghetti2d] = 1;
  t[CAVE_KIND.noodle] = 2;
  t[CAVE_KIND.worm] = 3;
  t[CAVE_KIND.ravine] = 3;
  t[CAVE_KIND.undergroundWorm] = 3;
  t[CAVE_KIND.entrance] = 4;
  return t;
})();
const MIX_GROUPS = 5;

/** The Jensen-Shannon divergence in bits (0 … 1) of two count vectors, each normalised to its sum. */
export function jensenShannon(p: ArrayLike<number>, q: ArrayLike<number>): number {
  let sp = 0;
  let sq = 0;
  for (let i = 0; i < p.length; i++) {
    sp += p[i]!;
    sq += q[i]!;
  }
  if (sp === 0 || sq === 0) return Number.NaN;
  let js = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]! / sp;
    const b = q[i]! / sq;
    const m = (a + b) / 2;
    if (a > 0) js += 0.5 * a * Math.log2(a / m);
    if (b > 0) js += 0.5 * b * Math.log2(b / m);
  }
  return js;
}

/**
 * C8.typeMixVariation's values: over the grid's `tile` × `tile`-block tiles (aligned to its corner, whole tiles only),
 * the divergence of C3's shares (the tagged voxels of all y per share) between each tile and its +x and +z neighbour,
 * tiles in index order; pairs with a tile holding none left out.
 */
export function typeMixDivergences(g: CaveGrid, tile = 128): number[] {
  const { w, d, cells } = g;
  const nx = Math.floor(w / tile);
  const nz = Math.floor(d / tile);
  const counts = new Float64Array(nx * nz * MIX_GROUPS);
  for (let i = 0, n = cells.length; i < n; i++) {
    const grp = MIX_GROUP[cells[i]! & TAG_MASK]!;
    if (grp < 0) continue;
    const x = i % w;
    const z = ((i - x) / w) % d;
    const tx = Math.floor(x / tile);
    const tz = Math.floor(z / tile);
    if (tx >= nx || tz >= nz) continue;
    counts[(tz * nx + tx) * MIX_GROUPS + grp]!++;
  }
  const at = (tx: number, tz: number): Float64Array => counts.subarray((tz * nx + tx) * MIX_GROUPS, (tz * nx + tx + 1) * MIX_GROUPS);
  const out: number[] = [];
  for (let tz = 0; tz < nz; tz++) {
    for (let tx = 0; tx < nx; tx++) {
      for (const [ux, uz] of [[tx + 1, tz], [tx, tz + 1]] as const) {
        if (ux >= nx || uz >= nz) continue;
        const v = jensenShannon(at(tx, tz), at(ux, uz));
        if (!Number.isNaN(v)) out.push(v);
      }
    }
  }
  return out;
}

/** C8.sizeSpread: the sample standard deviation of ln(v) over `values`; NaN for fewer than 2. */
export function logSd(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  let mean = 0;
  for (const v of values) mean += Math.log(v);
  mean /= n;
  let ss = 0;
  for (const v of values) ss += (Math.log(v) - mean) ** 2;
  return Math.sqrt(ss / (n - 1));
}

/** C8.sizeSpread's components (≥ 64 voxels) and C8.largeShare's large component (≥ 50,000 voxels). */
export const SPREAD_MIN_VOXELS = 64;
export const LARGE_MIN_VOXELS = 50_000;

// ---------------------------------------------------------------- C9

/** The nearest-rank `q` quantile of the values that are not NaN; NaN when none is. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const v = Array.from(values).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  return v[Math.max(0, Math.ceil(q * v.length) - 1)]!;
}

/** C2's components: the sky-connected ones with a voxel ≥ 8 below its position's pre-cave top. */
export function deepSkyLabels(g: CaveGrid, tops: Int16Array, c: CaveComponents): Set<number> {
  const plane = g.w * g.d;
  const deep = new Set<number>();
  for (let y = c.yMin; y <= c.yMax; y++) {
    const base = (y - c.yMin) * plane;
    for (let p = 0; p < plane; p++) {
      const l = c.label[base + p]!;
      if (l !== 0 && y <= tops[p]! - 8 && c.sky.has(l)) deep.add(l);
    }
  }
  return deep;
}

/**
 * C9.nearestEntrance's openings per position (index (z − z0)·w + (x − x0)): 1 where a voxel of a C2 component is
 * face-adjacent to untagged open air (air or fluid with tag 0) in the grid, the opening through which it is
 * sky-connected (`components3d`'s sky rule).
 */
export function openingMask(g: CaveGrid, tops: Int16Array, c: CaveComponents): Uint8Array {
  const { w, d, cells } = g;
  const plane = w * d;
  const deep = deepSkyLabels(g, tops, c);
  const out = new Uint8Array(plane);
  if (deep.size === 0) return out;
  const open = (i: number): boolean => (cells[i]! & (TAG_MASK | SOLID_BIT)) === 0;
  for (let y = c.yMin; y <= c.yMax; y++) {
    const base = (y - c.yMin) * plane;
    const row = (y - GRID_Y0) * plane;
    for (let p = 0; p < plane; p++) {
      const l = c.label[base + p]!;
      if (l === 0 || out[p] === 1 || !deep.has(l)) continue;
      const x = p % w;
      const z = (p - x) / w;
      const i = row + p;
      if ((x > 0 && open(i - 1)) || (x < w - 1 && open(i + 1)) || (z > 0 && open(i - w)) || (z < d - 1 && open(i + w))
        || (y > GRID_Y0 && open(i - plane)) || (y < GRID_Y0 + GRID_H - 1 && open(i + plane))) out[p] = 1;
    }
  }
  return out;
}

/** The true top's y per position: the first voxel from y 319 down that is solid or holds fluid (−64 at the lowest). */
function trueTop(g: CaveGrid, p: number): number {
  const plane = g.w * g.d;
  let y = GRID_H - 1;
  while (y > 0 && (g.cells[y * plane + p]! & (SOLID_BIT | FLUID_BIT)) === 0) y--;
  return y + GRID_Y0;
}

/** The land positions (C5.landCarved's rule: the true top solid without fluid), 1 per position. */
export function landMask(g: CaveGrid): Uint8Array {
  const plane = g.w * g.d;
  const out = new Uint8Array(plane);
  for (let p = 0; p < plane; p++) {
    const c = g.cells[(trueTop(g, p) - GRID_Y0) * plane + p]!;
    out[p] = (c & SOLID_BIT) !== 0 && (c & FLUID_BIT) === 0 ? 1 : 0;
  }
  return out;
}

/** The sea floor's positions (C7.flatWallShare on archipelago): the true top holds fluid, 1 per position. */
export function wetMask(g: CaveGrid): Uint8Array {
  const plane = g.w * g.d;
  const out = new Uint8Array(plane);
  for (let p = 0; p < plane; p++) out[p] = (g.cells[(trueTop(g, p) - GRID_Y0) * plane + p]! & FLUID_BIT) !== 0 ? 1 : 0;
  return out;
}

/**
 * The river positions, 1 per position: the column sample's nearest lattice corner (`nearestCornerIndex`, the corner
 * water v0 fills a position from) is a wet river or a dry gorge (`flags` ≠ 0).
 */
export function riverMaskOf(g: CaveGrid, seed: string, params: Params): Uint8Array {
  const { x0, z0, w, d } = g;
  const ctx = createGenContext(seedFromInput(seed), params);
  const sample = newColumnSample();
  const out = new Uint8Array(w * d);
  for (let cz = Math.floor(z0 / 16); 16 * cz < z0 + d; cz++) {
    for (let cx = Math.floor(x0 / 16); 16 * cx < x0 + w; cx++) {
      buildColumnSample(ctx, cx, cz, sample);
      for (let z = Math.max(z0, 16 * cz); z < Math.min(z0 + d, 16 * cz + 16); z++) {
        for (let x = Math.max(x0, 16 * cx); x < Math.min(x0 + w, 16 * cx + 16); x++) {
          out[(z - z0) * w + (x - x0)] = sample.flags[nearestCornerIndex(sample, x, z)]! !== 0 ? 1 : 0;
        }
      }
    }
  }
  return out;
}

/** C9.nearestEntrance's positions per region. */
export const ENTRANCE_SAMPLES = 256;

/**
 * C9.nearestEntrance's distances: `n` distinct positions drawn among those `eligible` marks (a partial Fisher-Yates
 * by `Xoshiro128(fnv1a32('C9.nearestEntrance'))`; all of them when fewer), and from each the horizontal distance to
 * the nearest opening position of the region (NaN when the region has none: the nearest opening lies outside it).
 */
export function nearestEntranceDistances(
  g: CaveGrid, openings: Uint8Array, eligible: Uint8Array, n = ENTRANCE_SAMPLES,
): { distances: Float64Array; positions: Int32Array } {
  const { w } = g;
  const plane = g.w * g.d;
  const pool: number[] = [];
  for (let p = 0; p < plane; p++) if (eligible[p] === 1) pool.push(p);
  const rng = new Xoshiro128(fnv1a32('C9.nearestEntrance'));
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + rng.nextInt(pool.length - i);
    const t = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = t;
  }
  const positions = Int32Array.from(pool.slice(0, k));
  const ox: number[] = [];
  const oz: number[] = [];
  for (let p = 0; p < plane; p++) {
    if (openings[p] !== 1) continue;
    ox.push(p % w);
    oz.push(Math.floor(p / w));
  }
  const distances = new Float64Array(k).fill(Number.NaN);
  for (let i = 0; i < k; i++) {
    const x = positions[i]! % w;
    const z = Math.floor(positions[i]! / w);
    let best = Infinity;
    for (let j = 0; j < ox.length; j++) {
      const dx = ox[j]! - x;
      const dz = oz[j]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    if (ox.length > 0) distances[i] = Math.sqrt(best);
  }
  return { distances, positions };
}

/**
 * C9.holedSurface's and C9.thinRoof's counts: the land positions (`landMask`'s rule), those whose pre-cave top voxel
 * is tagged, and those with a tagged air voxel (tagged, not solid) 1 … 3 blocks under the true top.
 */
export function surfaceCounts(g: CaveGrid, tops: Int16Array): { land: number; holed: number; thinRoof: number } {
  const plane = g.w * g.d;
  const cells = g.cells;
  let land = 0;
  let holed = 0;
  let thinRoof = 0;
  for (let p = 0; p < plane; p++) {
    const top = trueTop(g, p);
    const c = cells[(top - GRID_Y0) * plane + p]!;
    if ((c & SOLID_BIT) === 0 || (c & FLUID_BIT) !== 0) continue;
    land++;
    if ((cells[(tops[p]! - GRID_Y0) * plane + p]! & TAG_MASK) !== 0) holed++;
    for (let k = 1; k <= 3 && top - k >= GRID_Y0; k++) {
      if (caveCell(cells[(top - k - GRID_Y0) * plane + p]!)) {
        thinRoof++;
        break;
      }
    }
  }
  return { land, holed, thinRoof };
}

// ---------------------------------------------------------------- one region, and the parts

/** One region's C7-C9 counts. */
export interface CaveC7C9Counts {
  /** The region's area, km². */
  readonly areaKm2: number;
  readonly residues: WallResidues;
  readonly layers: LayerCounts;
  readonly flat: ReturnType<typeof flatWallDetail>;
  /** Null where T is not read (the preset regions). */
  readonly switchWall: SwitchCounts | null;
  readonly waterWall: number;
  readonly lags: LagCount[];
  readonly mix: number[];
  /** The volumes of the components ≥ 64 voxels, and the largest component's. */
  readonly volumes: number[];
  readonly largest: number;
  /** C2's components (sky-connected, reaching 8 below the top). */
  readonly deepSky: number;
  /** The positions holding an opening. */
  readonly openings: number;
  /** C9.nearestEntrance's distances (NaN without an opening in the region). */
  readonly distances: number[];
  readonly surface: { land: number; holed: number; thinRoof: number };
}

/** What `caveC7C9Counts` reads beside the grid. */
export interface C7C9Options {
  /** The `terrain` tap's value at a voxel (`RegionView.terrainT`); null: C7.switchWall not measured. */
  readonly T: ((x: number, y: number, z: number) => number) | null;
  /** C7.switchWall's chunk stride (`switchWallCounts`). */
  readonly stride: number;
  /** C9.nearestEntrance's eligible positions (land, not river). */
  readonly eligible: Uint8Array;
  /** C7.flatWallShare's positions (the archipelago sea floor); null: every position. */
  readonly seaFloor: Uint8Array | null;
  /** C8.typeMixVariation's tile (128; a fixture passes a smaller one). */
  readonly tile?: number;
}

/** Every C7-C9 count of one region, over its pre-cave tops and components. */
export function caveC7C9Counts(g: CaveGrid, tops: Int16Array, c: CaveComponents, o: C7C9Options): CaveC7C9Counts {
  const volumes: number[] = [];
  let largest = 0;
  for (const s of c.size.values()) {
    if (s >= SPREAD_MIN_VOXELS) volumes.push(s);
    largest = Math.max(largest, s);
  }
  const openings = openingMask(g, tops, c);
  let open = 0;
  for (let p = 0; p < openings.length; p++) open += openings[p]!;
  return {
    areaKm2: (g.w * g.d) / 1e6,
    residues: wallResidues(g),
    layers: layerCounts(g, tops),
    flat: flatWallDetail(g, o.seaFloor),
    switchWall: o.T === null ? null : switchWallCounts(g, o.T, o.stride),
    waterWall: waterWallCount(g),
    lags: aperiodicCounts(g),
    mix: typeMixDivergences(g, o.tile ?? 128),
    volumes,
    largest,
    deepSky: deepSkyLabels(g, tops, c).size,
    openings: open,
    distances: Array.from(nearestEntranceDistances(g, openings, o.eligible).distances),
    surface: surfaceCounts(g, tops),
  };
}

/** C7-C9's parts (spec §10.1; one value per threshold part; `C8.largeShare` is `sizeSpread`'s second value, plan). */
export const C7_C9_PARTS = [
  'C7.borderPlaneRatio', 'C7.verticalStep', 'C7.flatWallShare', 'C7.switchWall', 'C7.waterWall',
  'C8.aperiodicity', 'C8.typeMixVariation', 'C8.sizeSpread', 'C8.largeShare',
  'C9.nearestEntrance', 'C9.entrancesMax', 'C9.holedSurface', 'C9.thinRoof',
] as const;
export type C7C9Part = (typeof C7_C9_PARTS)[number];

/** A region for the C7-C9 parts: its group ('default' for the default and large_biomes profiles, else the preset). */
export interface C7C9Region {
  readonly group: string;
  /** A region of 32 × 32 chunks (C8.aperiodicity, sizeSpread and largeShare read only these). */
  readonly full: boolean;
  readonly counts: CaveC7C9Counts;
}

/** The parts measured per group ("default and presets"): each group's value, its regions pooled. */
export function c7c9Groups(regions: readonly C7C9Region[]): Record<string, {
  verticalStep: number; flatWallShare: number; waterWall: number; nearestEntrance: number; holedSurface: number;
}> {
  const out: Record<string, { verticalStep: number; flatWallShare: number; waterWall: number; nearestEntrance: number; holedSurface: number }> = {};
  for (const group of [...new Set(regions.map((r) => r.group))]) {
    const rs = regions.filter((r) => r.group === group).map((r) => r.counts);
    const layers = emptyLayerCounts();
    for (const r of rs) {
      for (let k = 0; k < GRID_H; k++) {
        layers.voxels[k]! += r.layers.voxels[k]!;
        layers.tagged[k]! += r.layers.tagged[k]!;
      }
    }
    const sum = (f: (r: CaveC7C9Counts) => number): number => rs.reduce((a, r) => a + f(r), 0);
    out[group] = {
      verticalStep: verticalStep(layers),
      flatWallShare: ratio(sum((r) => r.flat.flat), sum((r) => r.flat.faces)),
      waterWall: ratio(sum((r) => r.waterWall), sum((r) => r.areaKm2)),
      nearestEntrance: percentile(rs.flatMap((r) => r.distances), 0.9),
      holedSurface: ratio(sum((r) => r.surface.holed), sum((r) => r.surface.land)),
    };
  }
  return out;
}

/** The largest of the values that are not NaN; NaN when none is. */
const maxOf = (values: readonly number[]): number => {
  let m = Number.NaN;
  for (const v of values) if (!Number.isNaN(v) && !(v <= m)) m = v;
  return m;
};

/**
 * The C7-C9 parts. The parts the spec marks "default and presets" (verticalStep, nearestEntrance, holedSurface) and
 * "default and archipelago" (flatWallShare on its sea floor, waterWall) are the worst of the groups named (each group's
 * regions pooled); every other part reads the default group only. C8.aperiodicity, sizeSpread and largeShare read only
 * the default group's 32 × 32-chunk regions (NaN without one: fast's are 16 × 16).
 */
export function c7c9Parts(regions: readonly C7C9Region[]): Record<C7C9Part, number> {
  const groups = c7c9Groups(regions);
  const pick = (names: readonly string[] | null, f: (g: (typeof groups)[string]) => number): number =>
    maxOf(Object.entries(groups).filter(([n]) => names === null || names.includes(n)).map(([, g]) => f(g)));
  const def = regions.filter((r) => r.group === 'default').map((r) => r.counts);
  const full = regions.filter((r) => r.group === 'default' && r.full).map((r) => r.counts);
  const residues = emptyWallResidues();
  for (const r of def) {
    for (let k = 0; k < 32; k++) {
      residues.faces[k]! += r.residues.faces[k]!;
      residues.slots[k]! += r.residues.slots[k]!;
    }
  }
  const sw = def.filter((r) => r.switchWall !== null).map((r) => r.switchWall!);
  const sum = (rs: readonly CaveC7C9Counts[], f: (r: CaveC7C9Counts) => number): number => rs.reduce((a, r) => a + f(r), 0);
  return {
    'C7.borderPlaneRatio': borderPlaneRatio(residues).value,
    'C7.verticalStep': pick(null, (g) => g.verticalStep),
    'C7.flatWallShare': pick(['default', 'archipelago'], (g) => g.flatWallShare),
    'C7.switchWall': sw.length === 0 ? Number.NaN : switchWall({
      faces: sw.reduce((a, s) => a + s.faces, 0), shellFaces: sw.reduce((a, s) => a + s.shellFaces, 0),
      voxels: sw.reduce((a, s) => a + s.voxels, 0), shellVoxels: sw.reduce((a, s) => a + s.shellVoxels, 0),
    }),
    'C7.waterWall': pick(['default', 'archipelago'], (g) => g.waterWall),
    'C8.aperiodicity': full.length === 0 ? Number.NaN : aperiodicity(full.flatMap((r) => r.lags)),
    'C8.typeMixVariation': median(def.flatMap((r) => r.mix)),
    'C8.sizeSpread': full.length === 0 ? Number.NaN : logSd(full.flatMap((r) => r.volumes)),
    'C8.largeShare': full.length === 0 ? Number.NaN : full.filter((r) => r.largest >= LARGE_MIN_VOXELS).length / full.length,
    'C9.nearestEntrance': pick(null, (g) => g.nearestEntrance),
    'C9.entrancesMax': ratio(sum(def, (r) => r.deepSky), sum(def, (r) => r.areaKm2)),
    'C9.holedSurface': pick(null, (g) => g.holedSurface),
    'C9.thinRoof': ratio(sum(def, (r) => r.surface.thinRoof), sum(def, (r) => r.surface.land)),
  };
}

// ---------------------------------------------------------------- the review poses (§10.1, §10.10, D16)

/** The poses `caves.examples.json` holds: one per kind, the entrance from the surface, a pillar, the largest interior. */
export const EXAMPLE_IDS = [
  'cheese', 'pillars', 'spaghetti3d', 'spaghetti2d', 'noodle', 'entrance', 'worm', 'ravine', 'undergroundWorm', 'interior',
] as const;
export type ExampleId = (typeof EXAMPLE_IDS)[number];

/** A camera pose (spec §7.5's `/?at=…`): the eye at a voxel's centre, yaw and pitch in degrees (`player/fly.ts`). */
export interface CavePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** The voxel, and the voxels of its component. */
  readonly voxel: readonly [number, number, number];
  readonly component: number;
}

/** The pitch looking down into an entrance from its top. */
export const ENTRANCE_PITCH = -60;
/** How far a pose's yaw looks for open voxels. */
const LOOK_STEPS = 64;
/** A free-standing pillar's rock in its row: at most this many voxels, 4-connected (a wall's rock runs on). */
export const PILLAR_AREA_MAX = 512;
/** A pillar's rock runs at least this far above and below the pillar voxel, in its column. */
export const PILLAR_RISE = 2;
/** The pillars pose stands at least this many open voxels out from its pillar's surface (along one of the eight yaws)… */
export const PILLAR_BACK = 8;
/** …and at most this many, so that the pillar and the cavern on both sides of it fill the view. */
export const PILLAR_VIEW = 20;

/**
 * The poses of one region (§10.1: per kind, its largest component's air voxel nearest the region's centre; D16):
 * - per kind (cheese, spaghetti 3D and 2D, noodle, worm, ravine, underground worm): the component holding the most
 *   voxels of that kind (ties to the lower label), and of its voxels of that kind the one nearest the region's centre
 *   (x0 + w/2, z0 + d/2) horizontally, voxel centres (ties to the lower index: the lower y first);
 * - `entrance`: of the entrance voxels at their position's pre-cave top in a sky-connected component, the nearest;
 * - `interior`: the largest component (ties to the lower label), its voxel of the largest local thickness (`thick`;
 *   all alike when null), the nearest of those;
 * - `pillars` (D16's "a cheese cavern with pillars", §10.10): of the rock voxels with a cheese air voxel of a cavern
 *   beside them (a component ≥ `cavern` voxels, C4's 10,000 by default; any cheese air when no such voxel gives a
 *   pose), asked nearest first, the first that stands free: `pillarAt` holds, its column's rock runs `PILLAR_RISE`
 *   above and below it, and the 4-connected rock of its row holds at most `PILLAR_AREA_MAX` voxels, none at the grid's
 *   edge (the pillar rock of a cavern's wall runs on into the wall). From the pillar's middle (its row's rock's mean
 *   column, rounded; the voxel itself when that is not its rock), along each of the eight yaws out of the rock and on
 *   through the open voxels: the farthest open voxel up to `PILLAR_VIEW` out, and at least `PILLAR_BACK`, that is that
 *   cheese air (the farthest of the yaws; ties to the smaller yaw) is the eye, looking back at the middle, so the view
 *   holds the pillar and the cavern on both sides of it (Task 49's review: the pillar rock nearest the centre was the
 *   cavern's wall, and a pose beside it showed one block of rock).
 * A pose's eye is the voxel's centre; its yaw (0°, 45° … 315°, 0° facing −z, 90° +x) looks along the longest straight
 * run of non-solid voxels from it (up to 64; ties to the smaller yaw), the pillars' at the pillar; pitch 0, the
 * entrance's −60 (into the opening). Null where the region holds no such voxel.
 */
export function caveExamples(
  g: CaveGrid, tops: Int16Array, c: CaveComponents, thick: Uint8Array | null,
  pillarAt: (x: number, y: number, z: number) => boolean, cavern = FLOOR_MIN_VOXELS,
): Record<ExampleId, CavePose | null> {
  const { x0, z0, w, d, cells } = g;
  const plane = w * d;
  const count = c.size.size;
  const off = (c.yMin - GRID_Y0) * plane;
  const n = plane * (c.yMax - c.yMin + 1);
  const label = c.label;
  /** Four times the squared horizontal distance of position p's centre from the region's centre (an integer). */
  const dist2 = (p: number): number => {
    const x = 2 * (p % w) + 1 - w;
    const z = 2 * Math.floor(p / w) + 1 - d;
    return x * x + z * z;
  };
  // The voxels per label and tag, the largest component.
  const perKind = new Int32Array((count + 1) * 16);
  let biggest = 0;
  for (const [l, s] of c.size) if (s > (c.size.get(biggest) ?? 0) || (s === c.size.get(biggest) && l < biggest)) biggest = l;
  for (let b = 0; b < n; b++) {
    const l = label[b]!;
    if (l !== 0) perKind[l * 16 + (cells[b + off]! & TAG_MASK)]!++;
  }
  const kinds: ReadonlyArray<readonly [ExampleId, number]> = [
    ['cheese', CAVE_KIND.cheese], ['spaghetti3d', CAVE_KIND.spaghetti3d], ['spaghetti2d', CAVE_KIND.spaghetti2d],
    ['noodle', CAVE_KIND.noodle], ['worm', CAVE_KIND.worm], ['ravine', CAVE_KIND.ravine],
    ['undergroundWorm', CAVE_KIND.undergroundWorm],
  ];
  const bestOf = new Int32Array(16);
  for (const [, k] of kinds) {
    let best = 0;
    let most = 0;
    for (let l = 1; l <= count; l++) {
      if (perKind[l * 16 + k]! > most) {
        most = perKind[l * 16 + k]!;
        best = l;
      }
    }
    bestOf[k] = best;
  }
  // One pass: per tag its nearest voxel in its component; the entrance; the interior.
  const near = new Float64Array(16).fill(Infinity);
  const at = new Int32Array(16).fill(-1);
  let entNear = Infinity;
  let entAt = -1;
  let inThick = -1;
  let inNear = Infinity;
  let inAt = -1;
  const ENT = CAVE_KIND.entrance;
  for (let b = 0; b < n; b++) {
    const l = label[b]!;
    if (l === 0) continue;
    const p = b % plane;
    const t = cells[b + off]! & TAG_MASK;
    if (l === bestOf[t] && t !== ENT) {
      const q = dist2(p);
      if (q < near[t]!) {
        near[t] = q;
        at[t] = b;
      }
    }
    if (t === ENT && c.sky.has(l) && c.yMin + (b - p) / plane === tops[p]!) {
      const q = dist2(p);
      if (q < entNear) {
        entNear = q;
        entAt = b;
      }
    }
    if (l === biggest) {
      const th = thick === null ? 0 : thick[b]!;
      const q = dist2(p);
      if (th > inThick || (th === inThick && q < inNear)) {
        inThick = th;
        inNear = q;
        inAt = b;
      }
    }
  }
  /** The yaw of the longest run of non-solid voxels from (x, y, z) (grid-local x, z). */
  const yawAt = (x: number, y: number, z: number): number => {
    let best = -1;
    let yaw = 0;
    for (let k = 0; k < 8; k++) {
      const dx = Math.round(Math.sin((k * Math.PI) / 4));
      const dz = Math.round(-Math.cos((k * Math.PI) / 4));
      let s = 0;
      while (s < LOOK_STEPS) {
        const xx = x + dx * (s + 1);
        const zz = z + dz * (s + 1);
        if (xx < 0 || xx >= w || zz < 0 || zz >= d) break;
        if ((cells[(y - GRID_Y0) * plane + zz * w + xx]! & SOLID_BIT) !== 0) break;
        s++;
      }
      if (s > best) {
        best = s;
        yaw = 45 * k;
      }
    }
    return yaw;
  };
  const poseAt = (b: number, pitch: number, yaw: number | null = null): CavePose => {
    const p = b % plane;
    const x = p % w;
    const z = Math.floor(p / w);
    const y = c.yMin + (b - p) / plane;
    return {
      x: x0 + x + 0.5, y: y + 0.5, z: z0 + z + 0.5, yaw: yaw ?? yawAt(x, y, z), pitch,
      voxel: [x0 + x, y, z0 + z], component: c.size.get(label[b]!)!,
    };
  };
  const out = Object.fromEntries(EXAMPLE_IDS.map((id) => [id, null])) as Record<ExampleId, CavePose | null>;
  for (const [id, k] of kinds) if (at[k]! >= 0) out[id] = poseAt(at[k]!, 0);
  if (entAt >= 0) out.entrance = poseAt(entAt, ENTRANCE_PITCH);
  if (inAt >= 0) out.interior = poseAt(inAt, 0);
  // The pillars: candidate rock voxels beside cheese air, nearest first (key dist2·cells + cell index, exact in a double:
  // dist2 < 2^21 and cells < 2^28); beside a cavern's cheese air first, then beside any.
  const CHEESE = CAVE_KIND.cheese;
  const solidCell = (i: number): boolean => (cells[i]! & SOLID_BIT) !== 0;
  const cheeseAir = (i: number): boolean => (cells[i]! & TAG_MASK) === CHEESE && !solidCell(i);
  const sizeAt = (i: number): number => {
    const y = GRID_Y0 + Math.floor(i / plane);
    const l = y >= c.yMin && y <= c.yMax ? label[i - off]! : 0;
    return l === 0 ? 0 : c.size.get(l)!;
  };
  /** Rock voxels known to belong to a row's rock that does not stand free (more than PILLAR_AREA_MAX, or the edge). */
  const walled = new Set<number>();
  /**
   * Rock voxel j's 4-connected rock in its row when it holds at most PILLAR_AREA_MAX voxels, none at the grid's edge;
   * else null.
   */
  const standsFree = (j: number): Set<number> | null => {
    const seen = new Set<number>([j]);
    const stack = [j];
    let free = true;
    while (stack.length > 0 && free) {
      const i = stack.pop()!;
      const p = i % plane;
      const x = p % w;
      const z = (p - x) / w;
      if (walled.has(i) || x === 0 || x === w - 1 || z === 0 || z === d - 1) {
        free = false;
        break;
      }
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (seen.has(n) || !solidCell(n)) continue;
        if (seen.size >= PILLAR_AREA_MAX) {
          free = false;
          break;
        }
        seen.add(n);
        stack.push(n);
      }
    }
    if (!free) for (const i of seen) walled.add(i);
    return free ? seen : null;
  };
  /** Whether rock voxel j's column holds rock PILLAR_RISE above and below it. */
  const rises = (j: number): boolean => {
    for (let dy = 1; dy <= PILLAR_RISE; dy++) {
      const lo = j - dy * plane;
      const hi = j + dy * plane;
      if (lo < 0 || hi >= cells.length || !solidCell(lo) || !solidCell(hi)) return false;
    }
    return true;
  };
  for (const min of [cavern, 0]) {
    const keyList: number[] = [];
    for (let i = plane, len = cells.length; i < len; i++) {
      if (!cheeseAir(i) || sizeAt(i) < min) continue;
      const p = i % plane;
      const x = p % w;
      const z = (p - x) / w;
      for (const [ok, j] of [[x > 0, i - 1], [x < w - 1, i + 1], [z > 0, i - w], [z < d - 1, i + w]] as const) {
        if (ok && solidCell(j)) keyList.push(dist2(j % plane) * cells.length + j);
      }
    }
    const sorted = Float64Array.from(keyList).sort();
    for (let k = 0; k < sorted.length && out.pillars === null; k++) {
      if (k > 0 && sorted[k] === sorted[k - 1]) continue;
      const j = sorted[k]! % cells.length;
      const p = j % plane;
      const x = p % w;
      const z = (p - x) / w;
      const y = GRID_Y0 + (j - p) / plane;
      if (!rises(j) || !pillarAt(x0 + x, y, z0 + z)) continue;
      const rockOf = standsFree(j);
      if (rockOf === null) continue;
      // The pillar's middle: its row's rock's mean column, rounded (j when that is not the pillar's rock).
      let sx = 0;
      let sz = 0;
      for (const i of rockOf) {
        const q = i % plane;
        sx += q % w;
        sz += Math.floor(q / w);
      }
      let mx = Math.round(sx / rockOf.size);
      let mz = Math.round(sz / rockOf.size);
      if (!rockOf.has(j - p + mz * w + mx)) {
        mx = x;
        mz = z;
      }
      // Along each of the eight yaws from the middle: out of the rock, then the open run; the eye the farthest open voxel
      // up to PILLAR_VIEW out (at least PILLAR_BACK) that is the cheese air, the yaw the farthest such (ties to the
      // smaller), the pose looking back at the middle.
      let far = PILLAR_BACK - 1;
      let eye = -1;
      let dir = -1;
      for (let r = 0; r < 8; r++) {
        const dx = Math.round(Math.sin((r * Math.PI) / 4));
        const dz = Math.round(-Math.cos((r * Math.PI) / 4));
        const cell = (k: number): number => {
          const xx = mx + dx * k;
          const zz = mz + dz * k;
          return xx < 0 || xx >= w || zz < 0 || zz >= d ? -1 : j - p + zz * w + xx;
        };
        let t = 1;
        while (cell(t) >= 0 && solidCell(cell(t))) t++;
        let s = 0;
        while (s < PILLAR_VIEW && cell(t + s) >= 0 && !solidCell(cell(t + s))) s++;
        for (let e = s; e > far; e--) {
          const i = cell(t + e - 1);
          if (cheeseAir(i) && sizeAt(i) >= min) {
            far = e;
            eye = i;
            dir = r;
            break;
          }
        }
      }
      if (eye < 0) continue;
      const q = eye % plane;
      const ex = q % w;
      const ez = (q - ex) / w;
      out.pillars = {
        x: x0 + ex + 0.5, y: y + 0.5, z: z0 + ez + 0.5, yaw: 45 * ((dir + 4) % 8), pitch: 0,
        voxel: [x0 + ex, y, z0 + ez], component: sizeAt(eye),
      };
    }
    if (out.pillars !== null) break;
  }
  return out;
}

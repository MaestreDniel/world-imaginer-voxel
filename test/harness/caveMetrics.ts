/**
 * The caves' instruments (SP6a spec §10.1, D26): C1-C6, pure over a `CaveGrid` (a region's voxels copied out of a
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
 *   a component's thinnest axis is the median over its voxels of the voxel's shortest axis-aligned run inside the
 *   component (x, y or z; capped at 255): a 10 × 10 × 10 cavern gives 10, a straight 4 × 4 tunnel 4, and unlike a
 *   bounding box it follows a winding tunnel. "Mostly" a kind: more than half its voxels.
 * - C6: per band, the carve rate of the underground voxels with y ≡ r (mod 8), x ≡ r (mod 4) and z ≡ r (mod 4), each
 *   over the band's rate; the maximum over residues and the bands whose rate is > 0.
 * The region parts pool their counts over the regions (C1 per profile); the per-km² parts divide by the regions' area.
 */
import { CARVER_WINDOW_R, CAVE_KIND } from '../../src/core/constants';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { carveTest, densityTopOf, wetAt } from '../../src/gen/caves/carve';
import { carverParamsOf, carverPath, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
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
/** The cap of a run length (the per-voxel runs are bytes). */
const RUN_CAP = 255;

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

/**
 * C5.thinnest's values: per component ≥ `minSize` voxels, its thinnest axis (the median over its voxels of the
 * shortest axis-aligned run inside it, capped at 255), all of them and those of the components mostly cheese and mostly
 * spaghetti 3D (more than half their voxels of that tag).
 */
export function thinnestAxes(g: CaveGrid, c: CaveComponents, minSize = THIN_MIN_VOXELS): { all: number[]; cheese: number[]; spaghetti3d: number[] } {
  const { w, d } = g;
  const plane = w * d;
  const h = c.yMax - c.yMin + 1;
  const n = plane * h;
  const label = c.label;
  const run = new Uint8Array(n).fill(RUN_CAP);
  /** Writes min(run, length) along each run of labelled voxels of the line from `start` by `step`, `len` voxels. */
  const line = (start: number, step: number, len: number): void => {
    let k = 0;
    while (k < len) {
      if (label[start + k * step]! === 0) {
        k++;
        continue;
      }
      let e = k;
      while (e < len && label[start + e * step]! !== 0) e++;
      const r = Math.min(RUN_CAP, e - k);
      for (let j = k; j < e; j++) {
        const i = start + j * step;
        if (r < run[i]!) run[i] = r;
      }
      k = e;
    }
  };
  for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) line(y * plane + z * w, 1, w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) line(y * plane + x, w, d);
  for (let p = 0; p < plane; p++) line(p, plane, h);
  // A histogram of run lengths per large component, and its cheese and spaghetti 3D voxels.
  const slot = new Map<number, number>();
  for (const [l, s] of c.size) if (s >= minSize) slot.set(l, slot.size);
  const hist = new Int32Array(slot.size * (RUN_CAP + 1));
  const cheese = new Int32Array(slot.size);
  const spag = new Int32Array(slot.size);
  for (let i = 0; i < n; i++) {
    const l = label[i]!;
    if (l === 0) continue;
    const s = slot.get(l);
    if (s === undefined) continue;
    hist[s * (RUN_CAP + 1) + run[i]!]!++;
    const t = g.cells[i + (c.yMin - GRID_Y0) * plane]! & TAG_MASK;
    if (t === CAVE_KIND.cheese) cheese[s]!++;
    else if (t === CAVE_KIND.spaghetti3d) spag[s]!++;
  }
  const out = { all: [] as number[], cheese: [] as number[], spaghetti3d: [] as number[] };
  for (const [l, s] of slot) {
    const v = histMedian(hist, s * (RUN_CAP + 1), RUN_CAP + 1);
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

/**
 * Every C1-C6 count of one region. `pillarAt` is `RegionView.pillar` (the debug channel); `ravines` the ravine paths
 * and their carve test (`ravinePathsOf`); `tile` C3.pillars' tile (128; a fixture passes a smaller one).
 */
export function caveRegionCounts(
  g: CaveGrid, pillarAt: (x: number, y: number, z: number) => boolean,
  ravines: { paths: readonly CarverPath[]; carves: (path: CarverPath, e: number, x: number, y: number, z: number) => boolean },
  tile = 128,
): CaveRegionCounts {
  const tops = preCaveTops(g);
  const c = caveComponents(g, tops);
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
    thinnest: thinnestAxes(g, c),
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

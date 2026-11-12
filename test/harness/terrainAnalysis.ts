import { biomeFamily, biomeId } from '../../src/gen/biomes/registry';
import type { DensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { AIR } from '../../src/world/blocks/index';
import type { AuxView } from '../../src/world/store/api';

/**
 * T1-T5's per-column analysis (`analyseColumn`, its accumulators `Scattered` and its helpers), split out of
 * `terrainScatter.ts` (which re-exports all of it) so the region worker (`regionWorker.ts`) can bundle it: this module
 * imports neither `node:` modules nor vitest (SP6b spec §13 L5; ruling P5). Definitions: terrain.metric.ts' header.
 */

const PEAKS = new Set(['windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks'].map((n) => biomeId(n as Parameters<typeof biomeId>[0])));
const T5_LOCAL = [2, 6, 10, 14];
const FLOAT_MAX_HEIGHT = 6;
const FLOAT_MIN_GAP = 3;

/** What the per-column analysis reads of a column: its blocks, its cave tags and aux A (a `ColumnView` is one). */
export interface ScatterColumn {
  sectionBlocks(sy: number): Uint16Array | number;
  /** The cave tag per voxel (SP6a spec §3.2-§3.3), or its uniform byte. */
  sectionCave(sy: number): Uint8Array | number;
  aux(): Pick<AuxView, 'worldSurfaceWG' | 'oceanFloorWG' | 'surfaceBiome'> | null;
}

/** Column solidity, index ((y + 64) << 8) | (lz << 4) | lx, from the proto sections (also Z1's, SP3e spec §5.3). */
export function solidity(view: ScatterColumn, out: Uint8Array): Uint8Array {
  for (let sy = 0; sy < 24; sy++) {
    const b = view.sectionBlocks(sy);
    const base = sy << 12;
    if (typeof b === 'number') out.fill(b === AIR ? 0 : 1, base, base + 4096);
    else for (let i = 0; i < 4096; i++) out[base + i] = b[i] === AIR ? 0 : 1;
  }
  return out;
}

/**
 * The column's pre-cave solidity (SP6a spec §10.4: T2 reads it), index as `solidity`: 1 where the block is not air or
 * the voxel carries a cave tag (§3.2: tagged air is air the caves made of pre-cave rock), else 0. With every family tap
 * present (the built-in trees) it is the solidity with the caves muted and the carvers off.
 */
export function preCaveSolidity(view: ScatterColumn, out: Uint8Array): Uint8Array {
  solidity(view, out);
  for (let sy = 0; sy < 24; sy++) {
    const c = view.sectionCave(sy);
    const base = sy << 12;
    if (typeof c === 'number') { if (c !== 0) out.fill(1, base, base + 4096); }
    else for (let i = 0; i < 4096; i++) if (c[i] !== 0) out[base + i] = 1;
  }
  return out;
}

/** Solid→air transitions at y ∈ [y0, y1] (y0 ≥ −64) of position p (T2's and Z1's overhang count). */
export function transitions(solid: Uint8Array, p: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = Math.max(-64, y0); y <= y1; y++) {
    if (solid[((y + 64) << 8) | p] === 1 && (y === 319 || solid[((y + 65) << 8) | p] === 0)) n++;
  }
  return n;
}

/** Voxels of position p in solid runs of height ≤ 6 resting on an air gap of ≥ 3 blocks, at y ∈ [−56, top]. */
function floatingVoxels(solid: Uint8Array, p: number, top: number): number {
  let voxels = 0;
  let gap = 0;
  let run = 0;
  let runGap = 0;
  for (let y = -56; y <= top + 1; y++) {
    const s = y <= 319 && solid[((y + 64) << 8) | p] === 1;
    if (s) {
      if (run === 0) runGap = gap;
      run++;
      gap = 0;
    } else {
      if (run > 0 && run <= FLOAT_MAX_HEIGHT && runGap >= FLOAT_MIN_GAP) voxels += run;
      run = 0;
      gap++;
    }
  }
  return voxels;
}


/** Per-position land flag, floor/top, surface and biome of a 16w × 16h block grid, row-major. */
export interface Grid { n: number; m: number; top: Int16Array; ws: Int16Array; land: Uint8Array; biome: Uint8Array }

export const newGrid = (n: number, m: number): Grid =>
  ({ n, m, top: new Int16Array(n * m), ws: new Int16Array(n * m), land: new Uint8Array(n * m), biome: new Uint8Array(n * m) });

/** Copies one column's aux A into the grid at block offset (ox, oz). */
export function putColumn(g: Grid, a: Pick<AuxView, 'worldSurfaceWG' | 'oceanFloorWG' | 'surfaceBiome'>, ox: number, oz: number): void {
  for (let p = 0; p < 256; p++) {
    const k = (oz + (p >> 4)) * g.n + ox + (p & 15);
    const ws = a.worldSurfaceWG[p]!;
    const of = a.oceanFloorWG[p]!;
    g.ws[k] = ws;
    g.top[k] = of - 1;
    g.land[k] = ws === of ? 1 : 0;
    g.biome[k] = a.surfaceBiome[p]!;
  }
}

/** Water-wall diagnostic over a grid: [wall voxels, water voxels above tops]. */
export function waterWalls(g: Grid): [number, number] {
  let walls = 0;
  let water = 0;
  for (let j = 0; j < g.m; j++) {
    for (let i = 0; i < g.n; i++) {
      const k = j * g.n + i;
      const ws = g.ws[k]!;
      const top = g.top[k]!;
      if (ws - 1 <= top) continue;
      water += ws - 1 - top;
      let minWs = Infinity;
      if (i > 0) minWs = Math.min(minWs, g.ws[k - 1]!);
      if (i < g.n - 1) minWs = Math.min(minWs, g.ws[k + 1]!);
      if (j > 0) minWs = Math.min(minWs, g.ws[k - g.n]!);
      if (j < g.m - 1) minWs = Math.min(minWs, g.ws[k + g.n]!);
      walls += Math.max(0, ws - Math.max(minWs, top + 1));
    }
  }
  return [walls, water];
}

/** The accumulators of one population of scattered columns (order-independent sums). */
export interface Scattered {
  hist: Float64Array; // land tops, index top + 64
  land: number;
  over: number;
  peakLand: number;
  peakOver: number;
  peakColumns: number;
  floatPositions: number;
  floatVoxels: number;
  peakFloatPositions: number;
  t5: number[];
  t5Land: number;
  t5Multi: number;
  /** T5 positions whose pre-cave top lies above the true top (a cave opens the surface there; SP6a spec §10.4). */
  t5Raised: number;
  /** T3: per biome, inside pairs and their steep count; per same-family biome pair `(min << 8) | max`, the same. */
  inside: Float64Array;
  insideSteep: Float64Array;
  borderPairs: Float64Array;
  borderSteep: Float64Array;
  landPairs: number;
  crossFamilyPairs: number;
  walls: number;
  water: number;
  columns: number;
  waterPositions: number;
  /** Wall time of the population, set by the caller (a timing key: never compared). */
  seconds: number;
}

export const newScattered = (): Scattered => ({
  hist: new Float64Array(384), land: 0, over: 0, peakLand: 0, peakOver: 0, peakColumns: 0,
  floatPositions: 0, floatVoxels: 0, peakFloatPositions: 0, t5: [], t5Land: 0, t5Multi: 0, t5Raised: 0,
  inside: new Float64Array(256), insideSteep: new Float64Array(256),
  borderPairs: new Float64Array(65536), borderSteep: new Float64Array(65536), landPairs: 0, crossFamilyPairs: 0,
  walls: 0, water: 0, columns: 0, waterPositions: 0, seconds: 0,
});

/** Reusable buffers of `analyseColumn` (one per caller thread): the true and the pre-cave solidity, the grid. */
export interface ScatterScratch { solid: Uint8Array; pre: Uint8Array; g: Grid }

export const newScatterScratch = (): ScatterScratch => ({ solid: new Uint8Array(98304), pre: new Uint8Array(98304), g: newGrid(16, 16) });

/** The true top (no caves to look through): `analyseColumn`'s default `preCaveTop`. */
const TRUE_TOP = (_x: number, _z: number, top: number): number => top;

/**
 * The pre-cave top over a land position's true top (SP6a spec §10.4: T5 reads the pre-cave terrain, which
 * `surfaceEst3` estimates by design): the top of the run of `precave` tap > 0 (`probe`) that continues the true top
 * upward, so a cave that opens the surface is looked through. `dc`'s tree must have a `precave` tap.
 */
export function preCaveTop(dc: DensityContext, x: number, z: number, top: number): number {
  let y = top;
  while (y < 319 && probe(dc, x, y + 1, z, 'precave') > 0) y++;
  return y;
}

/**
 * Adds one generated column (chunk column cx, cz) to `s`: T1's land tops, T2's overhangs and floating rocks, T5's
 * |surfaceEst − pre-cave top| at its 16 positions (`surfaceEst(x, z)` is `surfaceEst3` on the population's density
 * context; `preTop(x, z, top)` the pre-cave top over the true top, `preCaveTop` on that context, SP6a spec §10.4;
 * the population stays the single-surface land positions of the generated voxels), T3's in-column neighbour pairs and
 * the water-wall diagnostic.
 * T2 reads the pre-cave solidity (SP6a spec §10.4, the master's row: "pre-cave"; `preCaveSolidity`: solid or tagged),
 * over the pre-cave run that holds the land position's true top (climbed through the tagged voxels above it, so an
 * entrance that opens the surface is looked through): cave transitions would inflate it. T1, T3, T5's single-surface
 * test and the water walls read the generated voxels as before.
 */
export function analyseColumn(
  s: Scattered,
  view: ScatterColumn,
  cx: number,
  cz: number,
  surfaceEst: (x: number, z: number) => number,
  scratch: ScatterScratch,
  preTop: (x: number, z: number, top: number) => number = TRUE_TOP,
): void {
  const { solid, pre, g } = scratch;
  const aux = view.aux()!;
  solidity(view, solid);
  preCaveSolidity(view, pre);
  s.columns++;
  let peakHere = false;
  for (let p = 0; p < 256; p++) {
    const ws = aux.worldSurfaceWG[p]!;
    if (ws !== aux.oceanFloorWG[p]!) { s.waterPositions++; continue; }
    const top = ws - 1;
    s.land++;
    s.hist[top + 64]!++;
    let preTop = top;
    while (preTop < 319 && pre[((preTop + 65) << 8) | p] === 1) preTop++;
    const over = transitions(pre, p, preTop - 30, preTop) >= 2;
    if (over) s.over++;
    const fv = floatingVoxels(pre, p, preTop);
    if (fv > 0) { s.floatPositions++; s.floatVoxels += fv; }
    if (PEAKS.has(aux.surfaceBiome[p]!)) {
      s.peakLand++;
      peakHere = true;
      if (over) s.peakOver++;
      if (fv > 0) s.peakFloatPositions++;
    }
  }
  if (peakHere) s.peakColumns++;
  for (const lz of T5_LOCAL) {
    for (const lx of T5_LOCAL) {
      const p = (lz << 4) | lx;
      const ws = aux.worldSurfaceWG[p]!;
      if (ws !== aux.oceanFloorWG[p]!) continue;
      s.t5Land++;
      const top = ws - 1;
      if (transitions(solid, p, -56, top) !== 1) { s.t5Multi++; continue; }
      const x = 16 * cx + lx, z = 16 * cz + lz;
      const pre = preTop(x, z, top);
      if (pre !== top) s.t5Raised++;
      s.t5.push(Math.abs(surfaceEst(x, z) - pre));
    }
  }
  putColumn(g, aux, 0, 0);
  const [wl, wt] = waterWalls(g);
  s.walls += wl;
  s.water += wt;
  const pair = (k: number, q: number): void => {
    if (g.land[k] !== 1 || g.land[q] !== 1) return;
    s.landPairs++;
    const steep = Math.abs(g.top[k]! - g.top[q]!) >= 4 ? 1 : 0;
    const a = g.biome[k]!;
    const b = g.biome[q]!;
    if (a === b) {
      s.inside[a]!++;
      s.insideSteep[a]! += steep;
    } else if (biomeFamily(a) === biomeFamily(b)) {
      const e = a < b ? (a << 8) | b : (b << 8) | a;
      s.borderPairs[e]!++;
      s.borderSteep[e]! += steep;
    } else s.crossFamilyPairs++;
  };
  for (let k = 0; k < 256; k++) {
    if ((k & 15) < 15) pair(k, k + 1);
    if (k < 240) pair(k, k + 16);
  }
}

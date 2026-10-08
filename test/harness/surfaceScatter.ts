/**
 * The per-column analysis of `test/metrics/surface.metric.ts` (SP3c spec §5.1-§5.2), run inside its region worker
 * (`surfaceScatterWorker.ts`): every count the metric reports is accumulated per worker in a `SurfaceAcc` of plain
 * numbers and Float64Arrays, and the main thread only merges the workers' records (`mergeSurfaceAcc`, an exact sum:
 * every field is an integer count far below 2^53, so the merged record does not depend on the order of the columns
 * or of the workers). Never imports `node:` modules or vitest: the worker bundle includes it.
 *
 * Readouts (§5.2): each column's ColumnSample is rebuilt (`buildColumnSample`, as the stage builds it) and its voxels
 * re-scanned with the stage's SurfaceContext settings (`scanColumn` over the stored solidity, the stored water and
 * aux A's `surfaceBiome`), so T, steep, T_eff, the cliff predicate (`steepHolds` ∧ `yAboveHolds{runTop}` at the top),
 * the biome, `lake` and the nearest quart corner are the rules' own; C, offset0 and offset are bilinear `readField`
 * readouts. A land top is the top of a position with no water above it (`WORLD_SURFACE_WG == OCEAN_FLOOR_WG`),
 * y = `OCEAN_FLOOR_WG − 1`; a position is wet otherwise. A voxel is in the sky-open run when it lies at or above the
 * bottom of its position's first (topmost) run.
 */
import { deriveSeed, hash2 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { biomeFamily, biomeId, SURFACE_BIOMES, type SurfaceBiome } from '../../src/gen/biomes/registry';
import {
  buildColumnSample, nearestCornerIndex, newColumnSample, readField, riverWetAt, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { lakeHolds, steepHolds, temperatureBelowHolds, yAboveHolds } from '../../src/gen/surface/conditions';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { newSurfaceScan, scanColumn, tEff, type SurfaceScan } from '../../src/gen/surface/scan';
import { fluidType } from '../../src/world/blocks/fluid';
import {
  AIR, BEDROCK, CALCITE, CLAY, COARSE_DIRT, DEEPSLATE, GRASS_BLOCK, GRAVEL, MUD, PACKED_ICE, PODZOL, RED_SAND, REGISTRY,
  SAND, SNOW_BLOCK, STONE,
} from '../../src/world/blocks/index';
import type { AuxView, ColumnView } from '../../src/world/store/api';
import { YMOD16_CLASSES } from './stats';

const SEA = 63;

/** The registry's state count: the length of every per-state array of a `SurfaceAcc`. */
export const SURFACE_STATES = REGISTRY.stateCount;
const STATES = SURFACE_STATES;
export const surfaceBiomeId = (n: SurfaceBiome): number => biomeId(n);
const B = surfaceBiomeId;
const DESERT = B('desert');
const BADLANDS = B('badlands');
const SNOWY_BEACH = B('snowy_beach');
const isLandFamily = (b: number): boolean => { const f = biomeFamily(b); return f === 'lowland' || f === 'highland' || f === 'coast'; };
const isOceanFamily = (b: number): boolean => biomeFamily(b) === 'ocean';

/** Top patches of §4 ([1][3][2]-[4], [1][3][6]): [biome, patch block] on non-cliff land tops with T_eff ≥ snowline. */
export const TOP_PATCHES: ReadonlyArray<readonly [SurfaceBiome, number]> = [
  ['taiga', PODZOL], ['taiga', COARSE_DIRT], ['snowy_taiga', PODZOL], ['snowy_taiga', COARSE_DIRT],
  ['savanna', COARSE_DIRT], ['jungle', PODZOL], ['swamp', MUD], ['windswept_hills', GRAVEL], ['windswept_hills', STONE],
  ['stony_shore', GRAVEL], ['volcano', GRAVEL], ['stony_peaks', CALCITE], ['frozen_peaks', PACKED_ICE],
];
const PATCH_BIOMES = new Set(TOP_PATCHES.map(([b]) => B(b)));
/** Under-water clay ([1][0][2]): river, frozen_river and swamp wet tops. */
const CLAY_BIOMES = new Set(['river', 'frozen_river', 'swamp'].map((n) => B(n as SurfaceBiome)));
/** Biomes [1][0][0]-[2] decide before the lake clay rule [1][0][3]. */
const BEFORE_LAKE_CLAY = new Set(['warm_ocean', 'beach', 'snowy_beach', 'deep_ocean', 'frozen_ocean', 'river', 'frozen_river', 'swamp'].map((n) => B(n as SurfaceBiome)));

/** Every count of the surface metric over a set of columns (numbers and Float64Arrays only: structured-cloneable). */
export interface SurfaceAcc {
  columns: number;
  positions: number;
  landTops: number;
  wetTops: number;
  topMismatch: number;
  buried: number;
  grassNoSky: number;
  snowNoSky: number;
  stoneBelow0: number;
  deepBelow0: number;
  stoneAbove8: number;
  deepAbove8: number;
  bedrockFloor: number;
  snowLineTops: number;
  snowLineSnow: number;
  snowLineCliffs: number;
  desertTops: number;
  desertSnow: number;
  coastTops: number;
  coastOk: number;
  coastTopStates: Float64Array;
  coastBeachBiome: number;
  landBiome: number;
  landBiomeWetBelow: number;
  landBiomeDryBelow: number;
  river: number;
  riverWet: number;
  /** Dry river-channel positions by top: < 63, 63 … 64, 65 … 67, ≥ 68. */
  riverDry: Float64Array;
  riverRiverBiome: number;
  riverDryRiverBiome: number;
  /** The river check over deeper channel positions: bilinear offset < 62 and < 61 (population, wet). */
  river62: number;
  riverWet62: number;
  river61: number;
  riverWet61: number;
  ymod: Float64Array;
  ymodColumns: number;
  topHist: Float64Array;
  islets: number;
  isletTopStates: Float64Array;
  oceanOnLand: number;
  fringe: number;
  fringeOceanOnLand: number;
  fringeLandUnderWater: number;
  fringeSea: number;
  fringeSeaBad: number;
  fringeOceanOnLandTop: Float64Array;
  fringeLandUnderWaterTop: Float64Array;
  sdHist: Float64Array;
  blocks: Float64Array;
  landTopStates: Float64Array;
  wetTopStates: Float64Array;
  /** Per biome: eligible land tops (non-cliff, T_eff ≥ snowline) and their top states. */
  patchTops: Float64Array;
  patchStates: Float64Array;
  clayWetTops: number;
  clayWet: number;
  lakeWetTops: number;
  lakeClay: number;
  /** Wall time of the pass, set by the metric on its own thread (0 in a worker's record). */
  seconds: number;
}

export const newSurfaceAcc = (): SurfaceAcc => ({
  columns: 0, positions: 0, landTops: 0, wetTops: 0, topMismatch: 0, buried: 0, grassNoSky: 0, snowNoSky: 0,
  stoneBelow0: 0, deepBelow0: 0, stoneAbove8: 0, deepAbove8: 0, bedrockFloor: 0,
  snowLineTops: 0, snowLineSnow: 0, snowLineCliffs: 0, desertTops: 0, desertSnow: 0,
  coastTops: 0, coastOk: 0, coastTopStates: new Float64Array(STATES), coastBeachBiome: 0,
  landBiome: 0, landBiomeWetBelow: 0, landBiomeDryBelow: 0,
  river: 0, riverWet: 0, riverDry: new Float64Array(4), riverRiverBiome: 0, riverDryRiverBiome: 0,
  river62: 0, riverWet62: 0, river61: 0, riverWet61: 0,
  ymod: new Float64Array(16 * YMOD16_CLASSES), ymodColumns: 0, topHist: new Float64Array(384),
  islets: 0, isletTopStates: new Float64Array(STATES), oceanOnLand: 0,
  fringe: 0, fringeOceanOnLand: 0, fringeLandUnderWater: 0, fringeSea: 0, fringeSeaBad: 0,
  fringeOceanOnLandTop: new Float64Array(STATES), fringeLandUnderWaterTop: new Float64Array(STATES),
  sdHist: new Float64Array(64), blocks: new Float64Array(STATES), landTopStates: new Float64Array(STATES),
  wetTopStates: new Float64Array(STATES), patchTops: new Float64Array(SURFACE_BIOMES.length),
  patchStates: new Float64Array(SURFACE_BIOMES.length * STATES),
  clayWetTops: 0, clayWet: 0, lakeWetTops: 0, lakeClay: 0, seconds: 0,
});

/**
 * Adds every field of `from` into `into` (numbers, and Float64Arrays element by element) and returns `into`. Throws
 * when `from` is not a record of `into`'s shape (a missing or extra field, another kind or array length), so a worker
 * built from another version of this module cannot be merged silently.
 */
export function mergeSurfaceAcc(into: SurfaceAcc, from: SurfaceAcc): SurfaceAcc {
  const a = into as unknown as Record<string, number | Float64Array>;
  const b = from as unknown as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!(k in a)) throw new Error(`mergeSurfaceAcc: unknown field '${k}'`);
  for (const k of Object.keys(a)) {
    const x = a[k]!;
    const y = b[k];
    if (typeof x === 'number') {
      if (typeof y !== 'number') throw new Error(`mergeSurfaceAcc: field '${k}' is not a number`);
      a[k] = x + y;
    } else {
      if (!(y instanceof Float64Array) || y.length !== x.length) throw new Error(`mergeSurfaceAcc: field '${k}' is not a Float64Array(${x.length})`);
      for (let i = 0; i < x.length; i++) x[i]! += y[i]!;
    }
  }
  return into;
}

/** One column's analysis: adds its counts to `acc`. */
export type SurfaceColumnAnalyser = (view: ColumnView, cx: number, cz: number, acc: SurfaceAcc) => void;

/**
 * The analyser of the columns of seed `seedText` generated with `ctx` (the same seed): decodes the column's proto
 * sections, rebuilds its ColumnSample, re-scans it and counts every part and diagnostic of the metric. Its buffers are
 * its own (one analyser per thread).
 */
export function createSurfaceColumnAnalyser(seedText: string, ctx: GenContext): SurfaceColumnAnalyser {
  const sc = surfaceContextOf(ctx);
  const sp = ctx.params.surface;
  const ymodSeed = deriveSeed(seedFromInput(seedText), 'S1.ymod16');
  const scan = newSurfaceScan();
  const sample: ColumnSample = newColumnSample();
  const STATE = new Uint16Array(98304);
  const SOLID = new Uint8Array(98304);
  const WATER = new Uint8Array(98304);
  const WET = new Uint8Array(256);
  const ISLET = new Uint8Array(256);
  const PERM = new Uint16Array(256);
  const skyBottom = new Int32Array(256);
  /** Per section: its state when the section is uniform, −1 otherwise. */
  const UNIFORM = new Int32Array(24);
  const hist = new Float64Array(STATES);

  /** Decodes a column's proto sections into STATE, SOLID and WATER (index `256·(y + 64) + p`) and UNIFORM. */
  const decode = (view: ColumnView): void => {
    for (let sy = 0; sy < 24; sy++) {
      const b = view.sectionBlocks(sy);
      const f = view.sectionFluid(sy);
      const base = sy << 12;
      UNIFORM[sy] = typeof b === 'number' ? b : -1;
      if (typeof b === 'number') {
        STATE.fill(b, base, base + 4096);
        SOLID.fill(b === AIR ? 0 : 1, base, base + 4096);
      } else {
        STATE.set(b, base);
        for (let i = 0; i < 4096; i++) SOLID[base + i] = b[i] === AIR ? 0 : 1;
      }
      if (typeof f === 'number') WATER.fill(fluidType(f) !== 0 ? 1 : 0, base, base + 4096);
      else for (let i = 0; i < 4096; i++) WATER[base + i] = fluidType(f[i]!) !== 0 ? 1 : 0;
    }
  };

  /**
   * Voxel counts: per state, S1's buried and no-sky voxels, S2's stone-like voxels. A uniform section of a state that
   * is not grass_block, snow_block or red_sand is counted whole (its 4096 voxels, and its stone-like voxels by its
   * y range), every other section voxel by voxel; the counts are the same.
   */
  const countVoxels = (a: SurfaceAcc, s0: SurfaceScan): void => {
    for (let p = 0; p < 256; p++) {
      const r0 = s0.runFirst[p]!;
      skyBottom[p] = r0 < s0.runFirst[p + 1]! ? s0.runBottom[r0]! : 400;
    }
    hist.fill(0);
    let stoneBelow0 = 0, deepBelow0 = 0, stoneAbove8 = 0, deepAbove8 = 0, buried = 0, grassNoSky = 0, snowNoSky = 0;
    for (let sy = 0; sy < 24; sy++) {
      const u = UNIFORM[sy]!;
      const y0 = 16 * sy - 64;
      if (u >= 0 && u !== GRASS_BLOCK && u !== SNOW_BLOCK && u !== RED_SAND) {
        hist[u]! += 4096;
        if (u === STONE || u === DEEPSLATE) {
          // Rows y0 … y0 + 15, 256 voxels each: y < 0 and y > 8 (the rows at 0 … 8 are counted by neither).
          const below = Math.max(0, Math.min(16, -y0));
          const above = Math.max(0, Math.min(16, y0 + 16 - 9));
          stoneBelow0 += 256 * below;
          stoneAbove8 += 256 * above;
          if (u === DEEPSLATE) { deepBelow0 += 256 * below; deepAbove8 += 256 * above; }
        }
        continue;
      }
      const base = sy << 12;
      for (let i = base; i < base + 4096; i++) {
        const s = STATE[i]!;
        hist[s]!++;
        if (s === AIR) continue;
        const y = (i >> 8) - 64;
        if (s === STONE || s === DEEPSLATE) {
          if (y < 0) { stoneBelow0++; if (s === DEEPSLATE) deepBelow0++; }
          else if (y > 8) { stoneAbove8++; if (s === DEEPSLATE) deepAbove8++; }
          continue;
        }
        if (s === GRASS_BLOCK || s === SNOW_BLOCK || s === RED_SAND) {
          if (y < 319 && SOLID[i + 256] === 1) buried++;
          if (s !== RED_SAND && y < skyBottom[i & 255]!) {
            if (s === GRASS_BLOCK) grassNoSky++;
            else snowNoSky++;
          }
        }
      }
    }
    for (let s = 0; s < STATES; s++) a.blocks[s]! += hist[s]!;
    a.stoneBelow0 += stoneBelow0;
    a.deepBelow0 += deepBelow0;
    a.stoneAbove8 += stoneAbove8;
    a.deepAbove8 += deepAbove8;
    a.buried += buried;
    a.grassNoSky += grassNoSky;
    a.snowNoSky += snowNoSky;
  };

  /** The soil depth of a land top (§5.2): contiguous voxels from the top down that are not stone, deepslate, bedrock or air. */
  const soilDepth = (p: number, top: number): number => {
    let d = 0;
    for (let y = top; y >= -64; y--) {
      const s = STATE[((y + 64) << 8) | p]!;
      if (s === STONE || s === DEEPSLATE || s === BEDROCK || s === AIR) break;
      d++;
    }
    return d;
  };

  return (view, cx, cz, a) => {
    const aux: AuxView = view.aux()!;
    decode(view);
    buildColumnSample(ctx, cx, cz, sample);
    scanColumn(scan, sc.settings, sample, SOLID, WATER, aux.surfaceBiome);
    a.columns++;
    countVoxels(a, scan);
    for (let p = 0; p < 256; p++) WET[p] = aux.worldSurfaceWG[p]! > aux.oceanFloorWG[p]! ? 1 : 0;
    ISLET.fill(0);
    for (let p = 0; p < 256; p++) {
      a.positions++;
      const x = 16 * cx + (p & 15);
      const z = 16 * cz + (p >> 4);
      const top = aux.oceanFloorWG[p]! - 1;
      const wet = WET[p] === 1;
      const topState = STATE[((top + 64) << 8) | p]!;
      const biome = scan.biome[p]!;
      const k = nearestCornerIndex(sample, x, z);
      const lakeMask = sample.f.lakeMask[k]!;
      const lake = lakeHolds(scan.lakeLevel[p]!);
      const riverWet = riverWetAt(sample, k);
      const hasRun = scan.runFirst[p]! < scan.runFirst[p + 1]!;
      if ((hasRun ? scan.runTop[scan.runFirst[p]!]! : -64) !== top) a.topMismatch++;
      if (STATE[p] === BEDROCK) a.bedrockFloor++;
      a.sdHist[scan.surfaceDepth[p]!]!++;
      const cliff = steepHolds(scan.steep[p]!, sp.cliffSteep) && yAboveHolds(top, top, sp.cliffMinY, true);
      const te = tEff(scan.T[p]!, top, sp.lapse, sp.lapseBase);
      if (!wet) {
        a.landTops++;
        a.landTopStates[topState]!++;
        a.topHist[top + 64]!++;
        if (temperatureBelowHolds(te, sp.snowline)) {
          if (cliff) a.snowLineCliffs++;
          else { a.snowLineTops++; if (topState === SNOW_BLOCK) a.snowLineSnow++; }
        } else if (!cliff && PATCH_BIOMES.has(biome)) {
          a.patchTops[biome]!++;
          a.patchStates[biome * STATES + topState]!++;
        }
        if (biome === DESERT) { a.desertTops++; if (topState === SNOW_BLOCK) a.desertSnow++; }
        const C = readField(sample, 'C', x, z);
        if (C >= -0.22 && C <= -0.04 && readField(sample, 'offset0', x, z) >= SEA) {
          a.coastTops++;
          a.coastTopStates[topState]!++;
          if (biomeFamily(biome) === 'coast') a.coastBeachBiome++;
          if (topState === SAND || topState === RED_SAND || topState === GRAVEL || topState === STONE || (topState === SNOW_BLOCK && biome === SNOWY_BEACH)) a.coastOk++;
        }
        if (isOceanFamily(biome)) {
          a.oceanOnLand++;
          if (lakeMask > 0 && lakeMask < 1) { a.islets++; a.isletTopStates[topState]!++; ISLET[p] = 1; }
        }
      } else {
        a.wetTops++;
        a.wetTopStates[topState]!++;
        if (CLAY_BIOMES.has(biome)) { a.clayWetTops++; if (topState === CLAY) a.clayWet++; }
        else if (lake && !BEFORE_LAKE_CLAY.has(biome)) { a.lakeWetTops++; if (topState === CLAY) a.lakeClay++; }
      }
      if (isLandFamily(biome) && !lake && !(lakeMask > 0) && !riverWet) {
        a.landBiome++;
        if (top < SEA) { if (wet) a.landBiomeWetBelow++; else a.landBiomeDryBelow++; }
      }
      const offset = readField(sample, 'offset', x, z);
      if (riverWet && offset < SEA - 1) { a.river62++; if (wet) a.riverWet62++; }
      if (riverWet && offset < SEA - 2) { a.river61++; if (wet) a.riverWet61++; }
      if (riverWet && offset < SEA) {
        a.river++;
        const rb = biomeFamily(biome) === 'river';
        if (rb) a.riverRiverBiome++;
        if (wet) a.riverWet++;
        else {
          a.riverDry[top < SEA ? 0 : top <= 64 ? 1 : top <= 67 ? 2 : 3]!++;
          if (rb) a.riverDryRiverBiome++;
        }
      }
    }
    // Shoreline fringe: near-shore positions (Chebyshev ≤ 2 inside the column, other wet/dry state), islets excluded.
    for (let p = 0; p < 256; p++) {
      if (ISLET[p] === 1) continue;
      const lx = p & 15;
      const lz = p >> 4;
      let near = false;
      for (let dz = -2; dz <= 2 && !near; dz++) {
        const qz = lz + dz;
        if (qz < 0 || qz > 15) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const qx = lx + dx;
          if (qx < 0 || qx > 15) continue;
          if (WET[(qz << 4) | qx] !== WET[p]) { near = true; break; }
        }
      }
      if (!near) continue;
      const biome = scan.biome[p]!;
      const wet = WET[p] === 1;
      const bad = wet ? isLandFamily(biome) : isOceanFamily(biome);
      a.fringe++;
      if (bad) {
        const ts = STATE[((aux.oceanFloorWG[p]! - 1 + 64) << 8) | p]!;
        if (wet) { a.fringeLandUnderWater++; a.fringeLandUnderWaterTop[ts]!++; }
        else { a.fringeOceanOnLand++; a.fringeOceanOnLandTop[ts]!++; }
      }
      const k = nearestCornerIndex(sample, 16 * cx + lx, 16 * cz + lz);
      if (lakeHolds(scan.lakeLevel[p]!) || sample.f.lakeMask[k]! > 0 || riverWetAt(sample, k)) continue;
      a.fringeSea++;
      if (bad) a.fringeSeaBad++;
    }
    // S1.ymod16: the first eligible position in the column's own visit order.
    const rr = new Xoshiro128(hash2(ymodSeed, cx, cz));
    for (let i = 0; i < 256; i++) PERM[i] = i;
    for (let i = 255; i >= 1; i--) {
      const j = rr.nextInt(i + 1);
      const t = PERM[i]!;
      PERM[i] = PERM[j]!;
      PERM[j] = t;
    }
    for (let i = 0; i < 256; i++) {
      const p = PERM[i]!;
      if (WET[p] === 1) continue;
      const top = aux.oceanFloorWG[p]! - 1;
      if (top < 80) continue;
      if (steepHolds(scan.steep[p]!, sp.cliffSteep) && yAboveHolds(top, top, sp.cliffMinY, true)) continue;
      if (temperatureBelowHolds(tEff(scan.T[p]!, top, sp.lapse, sp.lapseBase), sp.snowline)) continue;
      if (scan.biome[p] === BADLANDS) continue;
      a.ymod[6 * (top & 15) + Math.min(5, soilDepth(p, top))]!++;
      a.ymodColumns++;
      break;
    }
  };
}

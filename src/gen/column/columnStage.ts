/**
 * ColumnSample and buildColumnSample (master §2.4, SP2a spec §2.7-2.8): every field on the 7 × 7 quart
 * lattice (the column's 5 × 5 corners plus a one-quart halo), computed by the same per-point functions
 * as columnPoint in the same order, so each lattice value equals columnPoint's bit for bit (DT2).
 * Shared work: lattice climate and offset0 feed the steep stencil; lake cells are memoised per context.
 */
import { pickBiome } from '../biomes/picker';
import { zoomQuart } from '../biomes/zoom';
import type { GenContext } from '../context';
import { newClimate, sampleClimate, type ClimateOut } from './climate';
import { waterLevel } from './columnPoint';
import { newLake, sampleLakes } from './lakes';
import { newRiver, sampleRivers } from './rivers';
import { newShape, sampleShape } from './shape';
import { offset0At, steepFrom } from './steep';

const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const STEEP = steepFrom;
const OFFSET0_AT = offset0At;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;
const LAKES = sampleLakes;
const NEW_LAKE = newLake;
const WATER = waterLevel;
const PICK = pickBiome;
const ZOOM = zoomQuart;

/** Continuous fields: bilinear between quart corners. */
export const SAMPLE_FIELDS = [
  'C', 'E', 'W', 'T', 'H', 'R', 'PV', 'offset0', 'sigma0', 'jag0', 'steep', 'riverDist', 'riverStrength',
  'lakeMask', 'offset', 'sigma', 'jag', 'surfaceEst', 'islandMask',
] as const;
/** Level fields (may be −∞): read from the nearest quart corner. */
export const LEVEL_FIELDS = ['lakeLevel', 'lakeFloor', 'surfaceWaterLevel'] as const;
export type SampleField = (typeof SAMPLE_FIELDS)[number];
export type LevelField = (typeof LEVEL_FIELDS)[number];

export interface ColumnSample {
  cx: number; cz: number;
  readonly f: { readonly [K in SampleField | LevelField]: Float64Array };
  /** Per lattice point: bit 0 river wet, bit 1 gorge. */
  readonly flags: Uint8Array;
  readonly biome: Uint8Array;
}

export function newColumnSample(): ColumnSample {
  const f: Record<string, Float64Array> = {};
  for (const k of [...SAMPLE_FIELDS, ...LEVEL_FIELDS]) f[k] = new Float64Array(49);
  return { cx: 0, cz: 0, f: f as ColumnSample['f'], flags: new Uint8Array(49), biome: new Uint8Array(49) };
}

/** Lattice index of quart offsets (i, j) ∈ −1..5. */
export const latticeIndex = (i: number, j: number): number => (j + 1) * 7 + (i + 1);

const CLIM: ClimateOut[] = Array.from({ length: 49 }, () => NEW_CLIMATE());
const SH = NEW_SHAPE();
const RV = NEW_RIVER();
const LK = NEW_LAKE();
const COORDS = new Float64Array(6);

export function buildColumnSample(ctx: GenContext, cx: number, cz: number, out: ColumnSample): ColumnSample {
  const f = out.f;
  out.cx = cx;
  out.cz = cz;
  const x0 = 16 * cx;
  const z0 = 16 * cz;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      const k = latticeIndex(i, j);
      const c = CLIMATE(ctx, x0 + 4 * i, z0 + 4 * j, CLIM[k]!);
      const s = SHAPE(ctx, c, COORDS, SH);
      f.C[k] = c.C; f.E[k] = c.E; f.W[k] = c.W; f.T[k] = c.T; f.H[k] = c.H; f.R[k] = c.R; f.PV[k] = c.PV;
      f.offset0[k] = s.offset0; f.sigma0[k] = s.sigma0; f.jag0[k] = s.jag0;
    }
  }
  const o = f.offset0;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      const k = latticeIndex(i, j);
      const x = x0 + 4 * i;
      const z = z0 + 4 * j;
      // Neighbours inside the lattice are the same offset0 values columnPoint recomputes; the halo's outer ring is sampled.
      const east = i < 5 ? o[latticeIndex(i + 1, j)]! : OFFSET0_AT(ctx, x + 4, z, COORDS);
      const west = i > -1 ? o[latticeIndex(i - 1, j)]! : OFFSET0_AT(ctx, x - 4, z, COORDS);
      const north = j > -1 ? o[latticeIndex(i, j - 1)]! : OFFSET0_AT(ctx, x, z - 4, COORDS);
      const south = j < 5 ? o[latticeIndex(i, j + 1)]! : OFFSET0_AT(ctx, x, z + 4, COORDS);
      f.steep[k] = STEEP(east, west, north, south);
      const c = CLIM[k]!;
      SH.offset0 = o[k]!; SH.sigma0 = f.sigma0[k]!; SH.jag0 = f.jag0[k]!;
      const r = RIVERS(ctx, c, SH, RV);
      const l = LAKES(ctx, x, z, r.offset, r.sigma, r.jag, LK);
      f.riverDist[k] = r.riverDist; f.riverStrength[k] = r.riverStrength;
      f.lakeMask[k] = l.lakeMask; f.lakeLevel[k] = l.lakeLevel; f.lakeFloor[k] = l.lakeFloor;
      f.offset[k] = l.offset; f.sigma[k] = l.sigma; f.jag[k] = l.jag;
      f.surfaceWaterLevel[k] = WATER(l.offset, r.wet, l.lakeMask, l.lakeLevel);
      f.surfaceEst[k] = l.offset;
      f.islandMask[k] = 0;
      out.flags[k] = (r.wet ? 1 : 0) | (r.gorge ? 2 : 0);
      out.biome[k] = PICK(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, o[k]!, r.wet);
    }
  }
  return out;
}

export const riverWetAt = (s: ColumnSample, k: number): boolean => (s.flags[k]! & 1) !== 0;
export const gorgeAt = (s: ColumnSample, k: number): boolean => (s.flags[k]! & 2) !== 0;

/**
 * Bilinear readout of a continuous field at world (x, z) inside the sample's column. Exact at the quart corners i, j ≤ 3
 * only: the far corners (i or j = 4, x = 16·cx + 16 or z = 16·cz + 16) are read as the weight-1 end of the last cell's
 * lerp, which can round the lattice value by a few ulps.
 */
export function readField(s: ColumnSample, field: SampleField, x: number, z: number): number {
  const a = s.f[field];
  const u = (x - 16 * s.cx) / 4;
  const v = (z - 16 * s.cz) / 4;
  const i = Math.min(3, Math.max(0, Math.floor(u)));
  const j = Math.min(3, Math.max(0, Math.floor(v)));
  const fx = u - i;
  const fz = v - j;
  const k = latticeIndex(i, j);
  const v00 = a[k]!;
  const v10 = a[k + 1]!;
  const v01 = a[k + 7]!;
  const v11 = a[k + 8]!;
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fz;
}

/** Level fields from the nearest quart corner (ties to the lower corner). */
export function readLevel(s: ColumnSample, field: LevelField, x: number, z: number): number {
  const i = Math.min(4, Math.max(0, Math.round((x - 16 * s.cx) / 4 - 1e-9)));
  const j = Math.min(4, Math.max(0, Math.round((z - 16 * s.cz) / 4 - 1e-9)));
  return s.f[field][latticeIndex(i, j)]!;
}

const Q: [number, number] = [0, 0];

/** Surface biome id per block position via the jittered-Voronoi zoom. */
export function readBiome(s: ColumnSample, ctx: GenContext, x: number, z: number): number {
  const [qx, qz] = ZOOM(ctx, x, z, Q);
  return s.biome[latticeIndex(qx - 4 * s.cx, qz - 4 * s.cz)]!;
}

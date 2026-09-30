/**
 * The point reference (SP2a spec §2.6): climate → shape → steep → rivers → lakes → water level →
 * surfaceEst → biome, in this order, at one world position. samplePoint writes into a reused record
 * (map tiles skip steep); columnPoint returns a fresh record with steep. buildColumnSample must
 * reproduce every field bit for bit at quart corners.
 */
import { SEA_LEVEL } from '../../core/constants';
import { pickBiome } from '../biomes/picker';
import type { GenContext } from '../context';
import { newClimate, sampleClimate } from './climate';
import { newLake, sampleLakes } from './lakes';
import { newRiver, sampleRivers } from './rivers';
import { newShape, sampleShape } from './shape';
import { steepAt } from './steep';

const SEA = SEA_LEVEL;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const STEEP = steepAt;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;
const LAKES = sampleLakes;
const NEW_LAKE = newLake;
const PICK = pickBiome;

export interface PointRecord {
  x: number; z: number;
  C: number; E: number; W: number; T: number; H: number; R: number; PV: number;
  offset0: number; sigma0: number; jag0: number;
  /** NaN when sampled without steep. */
  steep: number;
  riverDist: number; riverStrength: number; riverWet: boolean; gorge: boolean;
  lakeMask: number; lakeLevel: number; lakeFloor: number;
  offset: number; sigma: number; jag: number;
  surfaceWaterLevel: number; surfaceEst: number; islandMask: number;
  biome: number;
}
export type ColumnPoint = Readonly<PointRecord>;

export const newPointRecord = (): PointRecord => ({
  x: 0, z: 0, C: 0, E: 0, W: 0, T: 0, H: 0, R: 0, PV: 0, offset0: 0, sigma0: 0, jag0: 0, steep: Number.NaN,
  riverDist: 0, riverStrength: 0, riverWet: false, gorge: false, lakeMask: 0, lakeLevel: -Infinity, lakeFloor: -Infinity,
  offset: 0, sigma: 0, jag: 0, surfaceWaterLevel: -Infinity, surfaceEst: 0, islandMask: 0, biome: 0,
});

/** Master §3.7: sea level for ocean (below sea level) and river columns, Lw inside a lake, else −∞. */
export function waterLevel(offset: number, riverWet: boolean, lakeMask: number, lakeLevel: number): number {
  if (lakeMask === 1) return lakeLevel;
  return riverWet || offset < SEA ? SEA : -Infinity;
}

const C_ = NEW_CLIMATE();
const S_ = NEW_SHAPE();
const R_ = NEW_RIVER();
const L_ = NEW_LAKE();
const COORDS = new Float64Array(6);

export function samplePoint(ctx: GenContext, x: number, z: number, withSteep: boolean, out: PointRecord): PointRecord {
  const c = CLIMATE(ctx, x, z, C_);
  const s = SHAPE(ctx, c, COORDS, S_);
  out.x = x; out.z = z;
  out.C = c.C; out.E = c.E; out.W = c.W; out.T = c.T; out.H = c.H; out.R = c.R; out.PV = c.PV;
  out.offset0 = s.offset0; out.sigma0 = s.sigma0; out.jag0 = s.jag0;
  out.steep = withSteep ? STEEP(ctx, x, z, COORDS) : Number.NaN;
  const r = RIVERS(ctx, c, s, R_);
  const l = LAKES(ctx, x, z, r.offset, r.sigma, r.jag, L_);
  out.riverDist = r.riverDist; out.riverStrength = r.riverStrength; out.riverWet = r.wet; out.gorge = r.gorge;
  out.lakeMask = l.lakeMask; out.lakeLevel = l.lakeLevel; out.lakeFloor = l.lakeFloor;
  out.offset = l.offset; out.sigma = l.sigma; out.jag = l.jag;
  out.surfaceWaterLevel = waterLevel(l.offset, r.wet, l.lakeMask, l.lakeLevel);
  out.surfaceEst = l.offset;
  out.islandMask = 0;
  out.biome = PICK(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, s.offset0, r.wet);
  return out;
}

export function columnPoint(ctx: GenContext, x: number, z: number): ColumnPoint {
  return samplePoint(ctx, x, z, true, newPointRecord());
}

/**
 * The preview-level point (SP2a spec §6.1): climate, shape and biome only. Rivers and lakes are
 * narrower than a 256-block pixel, so they are left out: no river, no lake, offset = offset0.
 */
export function sampleCoarse(ctx: GenContext, x: number, z: number, out: PointRecord): PointRecord {
  const c = CLIMATE(ctx, x, z, C_);
  const s = SHAPE(ctx, c, COORDS, S_);
  out.x = x; out.z = z;
  out.C = c.C; out.E = c.E; out.W = c.W; out.T = c.T; out.H = c.H; out.R = c.R; out.PV = c.PV;
  out.offset0 = s.offset0; out.sigma0 = s.sigma0; out.jag0 = s.jag0;
  out.steep = Number.NaN;
  out.riverDist = Infinity; out.riverStrength = 0; out.riverWet = false; out.gorge = false;
  out.lakeMask = 0; out.lakeLevel = -Infinity; out.lakeFloor = -Infinity;
  out.offset = s.offset0; out.sigma = s.sigma0; out.jag = s.jag0;
  out.surfaceWaterLevel = waterLevel(s.offset0, false, 0, -Infinity);
  out.surfaceEst = s.offset0;
  out.islandMask = 0;
  out.biome = PICK(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, s.offset0, false);
  return out;
}

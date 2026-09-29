/**
 * Map layers (SP2a spec §6.2): what each layer paints from a sampled point, and which stage hash
 * invalidates its tiles. Relief and the relief-based layers also need the 4 neighbour heights.
 */
import type { StageId } from '../../core/ids';
import { biomeColor } from '../biomes/registry';
import type { PointRecord } from '../column/columnPoint';
import { blend, diverging, grey, hypsometric, sequential, shade, waterByDepth } from './palette';

const BIOME_COLOR = biomeColor;
const DIVERGING = diverging;
const HYPSO = hypsometric;
const WATER = waterByDepth;
const SEQ = sequential;
const SHADE = shade;
const GREY = grey;
const BLEND = blend;

export const LAYERS = ['biome', 'relief', 'rivers', 'lakes', 'C', 'E', 'PV', 'W', 'T', 'H', 'R', 'offset', 'sigma', 'jag'] as const;
export type LayerId = (typeof LAYERS)[number];

export function isLayerId(v: unknown): v is LayerId {
  return typeof v === 'string' && (LAYERS as readonly string[]).includes(v);
}

/** The stage whose hash keys this layer's tiles. */
export function layerStage(layer: LayerId): StageId {
  if (layer === 'biome') return 'biome2d';
  if (layer === 'C' || layer === 'E' || layer === 'PV' || layer === 'W' || layer === 'T' || layer === 'H' || layer === 'R') return 'climate';
  return 'shape';
}

/** Whether the layer shades by the neighbour heights. */
export const needsRelief = (layer: LayerId): boolean => layer === 'relief' || layer === 'rivers' || layer === 'lakes';

/**
 * NW-lit slope shading from heights 1 pixel (b blocks) away: k = 1 + ((west − east) + (north − south)) / (4·b), in [0.55, 1.35].
 */
export function slopeShade(west: number, east: number, north: number, south: number, b: number): number {
  const k = 1 + ((west - east) + (north - south)) / (4 * b);
  return k < 0.55 ? 0.55 : k > 1.35 ? 1.35 : k;
}

function reliefColor(p: PointRecord, k: number): number {
  if (p.surfaceWaterLevel > p.surfaceEst) return WATER(p.surfaceWaterLevel - p.surfaceEst);
  return SHADE(HYPSO(p.surfaceEst), k);
}

/** 0xRRGGBB of `layer` at a sampled point; `k` is the relief shading factor (1 for unshaded layers). */
export function layerColor(layer: LayerId, p: PointRecord, k: number): number {
  switch (layer) {
    case 'biome': return BIOME_COLOR(p.biome);
    case 'relief': return reliefColor(p, k);
    case 'rivers': {
      if (p.riverWet) return 0x2f6fe0;
      if (p.gorge) return 0xe07a2a;
      const base = GREY(reliefColor(p, k));
      return p.riverDist < 64 ? BLEND(base, 0x9cc8f0, 0.6 * (1 - p.riverDist / 64)) : base;
    }
    case 'lakes': {
      if (p.lakeMask === 1) return BLEND(0x4aa0e0, 0x0c3a8a, (p.lakeLevel - 63) / 137);
      const base = GREY(reliefColor(p, k));
      return p.lakeMask > 0 ? BLEND(base, 0xe6d58a, 0.8 * p.lakeMask) : base;
    }
    case 'C': return DIVERGING(p.C);
    case 'E': return DIVERGING(p.E);
    case 'PV': return DIVERGING(p.PV);
    case 'W': return DIVERGING(p.W);
    case 'T': return DIVERGING(p.T);
    case 'H': return DIVERGING(p.H);
    case 'R': return DIVERGING(p.R);
    case 'offset': return SEQ(p.offset, -64, 320);
    case 'sigma': return SEQ(p.sigma, 0, 16);
    case 'jag': return SEQ(p.jag, 0, 55);
  }
}

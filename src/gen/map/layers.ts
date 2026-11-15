/**
 * Map layers (SP2a spec §6.2): what each layer paints from a sampled point, and which stage hash
 * invalidates its tiles. Relief and the relief-based layers also need the 4 neighbour heights.
 * `islandMask` (SP3e spec §2.6) is the floating_islands cluster mask, keyed by the shape hash (which
 * covers the `islands` group); it is uniformly 0 in every other profile.
 * `caveBiome` (SP6b spec §9.1, D9) is the cave biome a cave at a chosen y would have: it needs the GenContext's
 * picker inputs and y, so the tile painter paints it through `caveBiomeColor`, keyed by the terrain hash.
 */
import { CAVE_BIOME_COLORS } from '../../core/constants';
import type { StageId } from '../../core/ids';
import { caveBiomeAtPoint, type CavePickerInputs } from '../biomes/cavePicker';
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
const CAVE_AT = caveBiomeAtPoint;
const CAVE_COLORS = CAVE_BIOME_COLORS;
/** `CAVE_BIOME_COLORS` as 0xRRGGBB. */
const CAVE_RGB: readonly number[] = CAVE_COLORS.map((c) => Number.parseInt(c.slice(1), 16));

export const LAYERS = ['biome', 'relief', 'rivers', 'lakes', 'C', 'E', 'PV', 'W', 'T', 'H', 'R', 'offset', 'sigma', 'jag', 'islandMask', 'caveBiome'] as const;
export type LayerId = (typeof LAYERS)[number];

export function isLayerId(v: unknown): v is LayerId {
  return typeof v === 'string' && (LAYERS as readonly string[]).includes(v);
}

/** The stage whose hash keys this layer's tiles. */
export function layerStage(layer: LayerId): StageId {
  if (layer === 'biome') return 'biome2d';
  if (layer === 'caveBiome') return 'terrain';
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
      // No proximity tint on the sea: R's zero set crosses oceans, but rivers only exist on land (§2.4).
      const sea = p.surfaceWaterLevel > p.surfaceEst && p.lakeMask < 1;
      return !sea && p.riverDist < 64 ? BLEND(base, 0x9cc8f0, 0.6 * (1 - p.riverDist / 64)) : base;
    }
    case 'lakes': {
      if (p.lakeMask === 1) {
        // Lake surfaces from sea level (63) to 200, clamped (SP2b spec §6.3).
        const t = (p.lakeLevel - 63) / 137;
        return BLEND(0x4aa0e0, 0x0c3a8a, t < 0 ? 0 : t > 1 ? 1 : t);
      }
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
    case 'islandMask': return SEQ(p.islandMask, 0, 1);
    // Painted through caveBiomeColor (it needs the picker and y); this is its relief part.
    case 'caveBiome': return GREY(reliefColor(p, k));
  }
}

/** The caveBiome layer's id of a pixel above the ground (y > surfaceEst): none. */
const NONE = 255;

/**
 * The caveBiome layer's id at a sampled point and height y (§9.1): 255 (none) where y > surfaceEst, else §1.3's
 * choice at (p.x, p.z) and y without jitter, from the point's C, E, H and surfaceEst plus the border and depth noises
 * (`caveBiomeAtPoint`).
 */
export function caveBiomeIdAt(picker: CavePickerInputs, p: PointRecord, y: number): number {
  return y > p.surfaceEst ? NONE : CAVE_AT(picker, p.C, p.E, p.H, p.surfaceEst, p.x, p.z, y).biome;
}

/** The colour of a caveBiome id at a point: `CAVE_BIOME_COLORS`, or the greyed relief (shaded by k) for none. */
export function caveBiomeIdColor(id: number, p: PointRecord, k: number): number {
  return id === NONE ? GREY(reliefColor(p, k)) : CAVE_RGB[id]!;
}

/** 0xRRGGBB of the caveBiome layer at a sampled point and height y: the cave biome's colour, the greyed relief above ground. */
export function caveBiomeColor(picker: CavePickerInputs, p: PointRecord, y: number, k: number): number {
  return caveBiomeIdColor(caveBiomeIdAt(picker, p, y), p, k);
}

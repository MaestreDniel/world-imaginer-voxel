/**
 * The cave registry (SP6b spec §1.3, D2): the three cave-biome boxes in perturbed-climate (C′, E′, H′) and depth units,
 * read from `caves.biomes.*` (the master's registry, :770-775, as the defaults), and the margin rule. Ids and names
 * are `CAVE_BIOME` / `CAVE_BIOME_NAMES` in core/constants.ts (gen exports no numeric data).
 */
import { CAVE_BIOME } from '../../core/constants';

const BIOME = CAVE_BIOME;
const PLAIN = BIOME.plain;
const LUSH = BIOME.lush;
const DRIPSTONE = BIOME.dripstone;
const ABYSS = BIOME.abyss;

export interface CaveBiomeBoxes {
  readonly lush: { readonly hMin: number; readonly depthMin: number; readonly depthMax: number };
  readonly dripstone: { readonly cMin: number; readonly depthMin: number; readonly depthMax: number };
  readonly abyss: { readonly eMax: number; readonly cMin: number; readonly depthMin: number };
}

/** The shape of `params.caves.biomes` minus `noises` (§6.1). */
export interface CaveBiomeSettings extends CaveBiomeBoxes {
  readonly depthScale: number;
  readonly borderWarp: number;
  readonly depthWarp: number;
  readonly edgeJitter: number;
}

/**
 * The cave biome at perturbed climate (c, e, h) = (C′, E′, H′) and depth (§1.3): lush when h ≥ hMin and depthMin ≤
 * depth ≤ depthMax (margin h − hMin); dripstone when c ≥ cMin and depthMin ≤ depth ≤ depthMax (margin c − cMin); abyss
 * when e ≤ eMax, c > cMin and depth ≥ depthMin (margin min(eMax − e, c − cMin)). Among the boxes that hold the point
 * the largest margin wins, a tie goes to the lower id (boxes tried in id order, replaced only on a strictly larger
 * margin); in none, plain.
 */
export function pickCaveBiome(b: CaveBiomeBoxes, c: number, e: number, h: number, depth: number): number {
  let best: number = PLAIN;
  let margin = -Infinity;
  const l = b.lush;
  if (h >= l.hMin && depth >= l.depthMin && depth <= l.depthMax) {
    best = LUSH;
    margin = h - l.hMin;
  }
  const d = b.dripstone;
  if (c >= d.cMin && depth >= d.depthMin && depth <= d.depthMax) {
    const m = c - d.cMin;
    if (m > margin) { best = DRIPSTONE; margin = m; }
  }
  const a = b.abyss;
  if (e <= a.eMax && c > a.cMin && depth >= a.depthMin) {
    const m = Math.min(a.eMax - e, c - a.cMin);
    if (m > margin) best = ABYSS;
  }
  return best;
}

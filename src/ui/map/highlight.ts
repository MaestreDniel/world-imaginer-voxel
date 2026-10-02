/**
 * Biome highlight on the map (SP2b spec §5.3): over a biome tile, a mask that dims every pixel whose biome
 * id is not the highlighted one and leaves the highlighted biome's pixels clear.
 */

/** The mask's opacity over the other biomes (0-255): they show at about 30 % of their brightness. */
export const HIGHLIGHT_DIM_ALPHA = 176;

/** Writes the RGBA mask of `ids` (one byte per pixel) for `biome` into `out` (4 bytes per id). */
export function highlightMask(ids: Uint8Array, biome: number, out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(4 * ids.length)): Uint8ClampedArray<ArrayBuffer> {
  if (out.length !== 4 * ids.length) throw new RangeError(`highlight mask: ${out.length} bytes for ${ids.length} ids`);
  for (let i = 0, o = 0; i < ids.length; i++, o += 4) {
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = ids[i] === biome ? 0 : HIGHLIGHT_DIM_ALPHA;
  }
  return out;
}

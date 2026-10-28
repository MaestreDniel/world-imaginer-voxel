import { DataArrayTexture, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { LAVA_LAYER, LOG_END_LAYER } from '../mesh/greedy';
import { FLAT_COLORS, LAVA_COLOR, type FlatColor } from '../textures/flatColors';
import { REGISTRY } from '../world/blocks/index';

/**
 * The flat-colour texture array (SP4a spec §6.3, D14): one 1 × 1 RGBA8 layer per block state id (layer = state until
 * SP8a's `FACE_TEX`), coloured from `textures/flatColors.ts` by the state's type name and stored sRGB, then the two
 * layers after them (SP5a spec §1.3): the log end (`LOG_END_LAYER`) and still lava (`LAVA_LAYER`). SP8a replaces it
 * with the painted array.
 */

/** Magenta: the layer of a type name with no flat colour (air, which is never meshed). */
const MISSING = [255, 0, 255] as const;

/**
 * The log end's colour (SP5a spec §1.3, D12): Minecraft's oak log top, lighter than `oak_log`'s bark on every channel
 * and ≥ 24 (summed |ΔRGB|) from every type, the sky, water, lava and unknown, so a log's axis shows.
 */
export const LOG_END_COLOR: FlatColor = [176, 145, 95];

/** The RGBA bytes of the layers, layer s = `nameOfState[s]`'s flat colour with alpha 255 (magenta if it has none). */
export function flatColorLayers(nameOfState: readonly string[]): Uint8Array {
  const out = new Uint8Array(4 * nameOfState.length);
  nameOfState.forEach((name, s) => {
    const c = FLAT_COLORS.get(name) ?? MISSING;
    out.set(c, 4 * s);
    out[4 * s + 3] = 255;
  });
  return out;
}

/**
 * The flat-colour array: 1 × 1 × (`stateCount` + 2), layer s < `stateCount` from `REGISTRY`'s state → type name, then
 * the log end and lava; sRGB, nearest, no mipmaps.
 */
export function createFlatColorArray(): DataArrayTexture {
  const names = Array.from({ length: REGISTRY.stateCount }, (_, s) => REGISTRY.typeName(REGISTRY.STATE_TYPE[s]!));
  const depth = names.length + 2;
  const data = new Uint8Array(4 * depth);
  data.set(flatColorLayers(names));
  data.set([...LOG_END_COLOR, 255], 4 * LOG_END_LAYER);
  data.set([...LAVA_COLOR, 255], 4 * LAVA_LAYER);
  const texture = new DataArrayTexture(data, 1, 1, depth);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

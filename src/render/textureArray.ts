import { DataArrayTexture, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { FLAT_COLORS } from '../textures/flatColors';
import { REGISTRY } from '../world/blocks/index';

/**
 * The flat-colour texture array (SP4a spec §6.3, D14): one 1 × 1 RGBA8 layer per block state id (layer = state until
 * SP8a's `FACE_TEX`), coloured from `textures/flatColors.ts` by the state's type name and stored sRGB. SP8a replaces it
 * with the painted array.
 */

/** Magenta: the layer of a type name with no flat colour (air, which is never meshed). */
const MISSING = [255, 0, 255] as const;

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

/** The flat-colour array: 1 × 1 × `stateCount`, from `REGISTRY`'s state → type name; sRGB, nearest, no mipmaps. */
export function createFlatColorArray(): DataArrayTexture {
  const names = Array.from({ length: REGISTRY.stateCount }, (_, s) => REGISTRY.typeName(REGISTRY.STATE_TYPE[s]!));
  const texture = new DataArrayTexture(flatColorLayers(names), 1, 1, names.length);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

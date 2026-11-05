import { Color, SRGBColorSpace, Vector3, type DataArrayTexture, type DataTexture, type IUniform } from 'three';
import { HEIGHT, MIN_Y } from '../../core/constants';
import { XRAY_COLORS } from '../xrayPalette';

/**
 * The uniform objects the materials share (SP4a spec §6.4-§6.6): every material's `uniforms` holds the same objects, so
 * `setFrameUniforms` writes each value once per frame and every material sees it. Colours are stored linear: sRGB
 * inputs are converted on the CPU (spec §6.4's colour management).
 */
export interface SharedUniforms {
  /** The flat-colour array (`render/textureArray.ts`), sRGB. */
  readonly albedo: IUniform<DataArrayTexture>;
  /** The lightmap (`render/lightmap.ts`), linear. */
  readonly lightmap: IUniform<DataTexture>;
  /** The fog's start and end in blocks from the eye, `fogRange` (SP4b spec §6.3). */
  readonly fogStart: IUniform<number>;
  readonly fogEnd: IUniform<number>;
  /** The eye's sky light, 0-15. */
  readonly eyeSky: IUniform<number>;
  readonly skyZenith: IUniform<Color>;
  readonly skyHorizon: IUniform<Color>;
  /** The unit vector towards the sun, x east, y up, z south (`daynight/dayNight.ts`). */
  readonly sunDir: IUniform<Vector3>;
  /**
   * The X-ray toggle (SP6a spec §5.3), 0 or 1: the X-ray's vertex shader collapses every vertex while it is 0, the
   * terrain's (opaque and cutout, not the ghost) and the water's while it is 1.
   */
  readonly xrayOn: IUniform<number>;
  /** The X-ray's depth band, world y: wall fragments outside [xrayYMin, xrayYMax + 1) are discarded (spec §5.2). */
  readonly xrayYMin: IUniform<number>;
  readonly xrayYMax: IUniform<number>;
  /** The X-ray's radius in blocks from the eye: every fragment beyond it is discarded (spec §5.2, D29). */
  readonly xrayRadius: IUniform<number>;
  /** The X-ray's 16 colours by kind (`render/xrayPalette.ts`), linear. */
  readonly xrayPalette: IUniform<Color[]>;
}

/** Shared uniforms over `albedo` and the lightmap texture, at full day until the first `setFrameUniforms`. */
export function createSharedUniforms(albedo: DataArrayTexture, lightmap: DataTexture): SharedUniforms {
  return {
    albedo: { value: albedo },
    lightmap: { value: lightmap },
    fogStart: { value: 0 },
    fogEnd: { value: 1 },
    eyeSky: { value: 15 },
    skyZenith: { value: new Color() },
    skyHorizon: { value: new Color() },
    sunDir: { value: new Vector3(0, 1, 0) },
    xrayOn: { value: 0 },
    xrayYMin: { value: MIN_Y },
    xrayYMax: { value: MIN_Y + HEIGHT - 1 },
    xrayRadius: { value: 0 },
    xrayPalette: { value: XRAY_COLORS.map((hex) => new Color().setStyle(hex, SRGBColorSpace)) },
  };
}

type Uniforms = Record<string, IUniform>;

/** The sky dome's uniforms: the gradient stops and the sun. */
export function skyUniforms(u: SharedUniforms): Uniforms {
  return { skyZenith: u.skyZenith, skyHorizon: u.skyHorizon, sunDir: u.sunDir };
}

/** The lightmap, the sky colour and the fog: what terrain and water read besides their own uniforms. */
function litUniforms(u: SharedUniforms): Uniforms {
  return {
    ...skyUniforms(u),
    lightmap: u.lightmap,
    fogStart: u.fogStart,
    fogEnd: u.fogEnd,
    eyeSky: u.eyeSky,
  };
}

/** The terrain's uniforms without the X-ray toggle: the ghost's base (it is never collapsed, SP6a spec §5.3). */
function terrainBaseUniforms(u: SharedUniforms): Uniforms {
  return { ...litUniforms(u), albedo: u.albedo };
}

/** Terrain's uniforms (opaque and cutout share them all): the base and the X-ray toggle its vertex shader collapses on. */
export function terrainUniforms(u: SharedUniforms): Uniforms {
  return { ...terrainBaseUniforms(u), xrayOn: u.xrayOn };
}

/** The sRGB colour [r, g, b] (0-255) in linear. */
const linear = (r: number, g: number, b: number): Color => new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);

/** Fast water's alpha and its shallow and deep colours, sRGB [64, 128, 230] and [16, 40, 96] (spec §6.4). */
export const WATER_ALPHA = 0.72;
const WATER_SHALLOW = [64, 128, 230] as const;
const WATER_DEEP = [16, 40, 96] as const;

/**
 * Water's uniforms: the shared ones, the X-ray toggle (its vertex shader collapses on it, SP6a spec §5.3), its alpha
 * and its two colours in linear (one tint until SP8a).
 */
export function waterUniforms(u: SharedUniforms): Uniforms {
  return {
    ...litUniforms(u),
    xrayOn: u.xrayOn,
    alpha: { value: WATER_ALPHA },
    waterShallow: { value: linear(...WATER_SHALLOW) },
    waterDeep: { value: linear(...WATER_DEEP) },
  };
}

/** The selection tool's ghost's alpha (SP5c spec §6.2, D11). */
export const GHOST_ALPHA = 0.45;

/**
 * The ghost's uniforms (SP5c spec §6.2, D25): terrain's, shared, plus its own alpha and `ghostTurns`, the quarter turns
 * (0-3) its side faces are remapped by; not the X-ray toggle, which its source never reads (SP6a spec §5.3).
 */
export function ghostUniforms(u: SharedUniforms): Uniforms {
  return { ...terrainBaseUniforms(u), ghostAlpha: { value: GHOST_ALPHA }, ghostTurns: { value: 0 } };
}

/**
 * The X-ray's uniforms (SP6a spec §5.2, §5.3): the toggle, the band, the radius and the palette, and the fog's start
 * and end, over which its walls and film fade to 0. No lightmap: the light floor and night vision do not touch it.
 */
export function xrayUniforms(u: SharedUniforms): Uniforms {
  return {
    fogStart: u.fogStart,
    fogEnd: u.fogEnd,
    xrayOn: u.xrayOn,
    xrayYMin: u.xrayYMin,
    xrayYMax: u.xrayYMax,
    xrayRadius: u.xrayRadius,
    xrayPalette: u.xrayPalette,
  };
}

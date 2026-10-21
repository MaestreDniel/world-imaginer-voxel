import { Color, SRGBColorSpace, Vector2, Vector3, type DataArrayTexture, type DataTexture, type IUniform } from 'three';

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
  readonly fogStart: IUniform<number>;
  readonly fogEnd: IUniform<number>;
  /** The edge fade's end, (RD − 0.5)·16, and its start, edge − `EDGE_FADE` (spec §6.6). */
  readonly edge: IUniform<number>;
  readonly edgeFadeStart: IUniform<number>;
  /** The load centre minus the floating origin, (x, z). */
  readonly edgeCentre: IUniform<Vector2>;
  /** The eye's sky light, 0-15. */
  readonly eyeSky: IUniform<number>;
  readonly skyZenith: IUniform<Color>;
  readonly skyHorizon: IUniform<Color>;
  /** The unit vector towards the sun, x east, y up, z south (`daynight/dayNight.ts`). */
  readonly sunDir: IUniform<Vector3>;
}

/** Shared uniforms over `albedo` and the lightmap texture, at full day until the first `setFrameUniforms`. */
export function createSharedUniforms(albedo: DataArrayTexture, lightmap: DataTexture): SharedUniforms {
  return {
    albedo: { value: albedo },
    lightmap: { value: lightmap },
    fogStart: { value: 0 },
    fogEnd: { value: 1 },
    edge: { value: 1 },
    edgeFadeStart: { value: 0 },
    edgeCentre: { value: new Vector2() },
    eyeSky: { value: 15 },
    skyZenith: { value: new Color() },
    skyHorizon: { value: new Color() },
    sunDir: { value: new Vector3(0, 1, 0) },
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
    edge: u.edge,
    edgeFadeStart: u.edgeFadeStart,
    edgeCentre: u.edgeCentre,
    eyeSky: u.eyeSky,
  };
}

/** Terrain's uniforms (opaque and cutout share them all). */
export function terrainUniforms(u: SharedUniforms): Uniforms {
  return { ...litUniforms(u), albedo: u.albedo };
}

/** The sRGB colour [r, g, b] (0-255) in linear. */
const linear = (r: number, g: number, b: number): Color => new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);

/** Fast water's alpha and its shallow and deep colours, sRGB [64, 128, 230] and [16, 40, 96] (spec §6.4). */
export const WATER_ALPHA = 0.72;
const WATER_SHALLOW = [64, 128, 230] as const;
const WATER_DEEP = [16, 40, 96] as const;

/** Water's uniforms: the shared ones plus its alpha and its two colours in linear (one tint until SP8a). */
export function waterUniforms(u: SharedUniforms): Uniforms {
  return {
    ...litUniforms(u),
    alpha: { value: WATER_ALPHA },
    waterShallow: { value: linear(...WATER_SHALLOW) },
    waterDeep: { value: linear(...WATER_DEEP) },
  };
}

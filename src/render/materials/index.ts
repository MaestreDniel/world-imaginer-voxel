import { DoubleSide, FrontSide, GLSL3, NoBlending, ShaderMaterial, SRGBColorSpace, type DataArrayTexture } from 'three';
import { dayFactor, duskFactor, skyColorsInto, sunDirectionInto } from '../../daynight/dayNight';
import type { FrameState } from '../frameState';
import { createLightmap } from '../lightmap';
import { SKY_FRAGMENT, SKY_VERTEX } from './glsl/sky.glsl';
import { DECODE_DEBUG_FRAGMENT, decodeDebugVertex, TERRAIN_FRAGMENT, terrainVertex } from './glsl/terrain.glsl';
import { WATER_FRAGMENT, waterVertex } from './glsl/water.glsl';
import { createSharedUniforms, skyUniforms, terrainUniforms, waterUniforms } from './uniforms';

/**
 * Materials v1 (SP4a spec §6.4-§6.6, master §4.6): terrain (opaque and cutout), Fast water, the sky dome and the
 * spike's decode-debug material, all `ShaderMaterial`s with `glslVersion: GLSL3`. The terrain and water materials come
 * in a RegionBatch variant (`'batch'`, three's batching chunks) and a RegionMesh variant (`'mesh'`, `REGION_MESH`, no
 * batching chunks), generated from the same GLSL (spec §6.2, D7). Lava, clouds, lod, shadowDepth and selection come
 * with their SPs.
 */

/** Which section renderer the materials serve: RegionBatch or RegionMesh (spec §6.2). */
export type MaterialVariant = 'batch' | 'mesh';

export interface MaterialSettings {
  readonly variant: MaterialVariant;
  readonly ao: boolean;
  readonly smoothLight: boolean;
}

export interface MaterialSystem {
  readonly variant: MaterialVariant;
  readonly terrainOpaque: ShaderMaterial;
  readonly terrainCutout: ShaderMaterial;
  readonly water: ShaderMaterial;
  readonly sky: ShaderMaterial;
  /** Writes each vertex's `data` word as RGBA bytes (the spike's decode check, spec §1.2). */
  readonly decodeDebug: ShaderMaterial;
  readonly lightmap: ReturnType<typeof createLightmap>;
  /**
   * Writes the frame's fog, eye light, sky and sun uniforms and hands the lightmap the frame's day, dusk and brightness
   * (it rebuilds only when they moved a step); allocates nothing (SP4b spec §3.10).
   */
  setFrameUniforms(f: FrameState): void;
  /** Frees the materials and the lightmap; the albedo array stays its owner's. */
  dispose(): void;
}

/**
 * The fog distances (SP4b spec §6.3, D17), written into `out` and returned: end (rd − 1)·16, where every gap at the mesh
 * disc's rim is fully fogged, start `band` blocks before it, never below 0 (RD12 112-176). `rd` is the fog's render
 * distance, fractional while a raise eases outward (spec §5).
 */
export function fogRange(rd: number, band: number, out: { start: number; end: number }): { start: number; end: number } {
  const end = (rd - 1) * 16;
  out.start = Math.max(0, end - band);
  out.end = end;
  return out;
}

type Defines = Record<string, string>;

/** The materials of `s.variant` over `albedo` (the flat-colour array, `render/textureArray.ts`). */
export function createMaterialSystem(s: MaterialSettings, albedo: DataArrayTexture): MaterialSystem {
  const lightmap = createLightmap();
  const u = createSharedUniforms(albedo, lightmap.texture);
  const lightDefines = (): Defines => (s.smoothLight ? { SMOOTH_LIGHT: '' } : {});
  const terrainDefines = (): Defines => ({ ...lightDefines(), ...(s.ao ? { TERRAIN_AO: '' } : {}) });

  const terrain = (cutout: boolean): ShaderMaterial =>
    new ShaderMaterial({
      name: cutout ? 'terrainCutout' : 'terrainOpaque',
      glslVersion: GLSL3,
      uniforms: terrainUniforms(u),
      defines: cutout ? { ...terrainDefines(), CUTOUT: '' } : terrainDefines(),
      vertexShader: terrainVertex(s.variant),
      fragmentShader: TERRAIN_FRAGMENT,
      side: cutout ? DoubleSide : FrontSide,
    });
  const terrainOpaque = terrain(false);
  const terrainCutout = terrain(true);
  const water = new ShaderMaterial({
    name: 'waterFast',
    glslVersion: GLSL3,
    uniforms: waterUniforms(u),
    defines: lightDefines(),
    vertexShader: waterVertex(s.variant),
    fragmentShader: WATER_FRAGMENT,
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
  });
  const sky = new ShaderMaterial({
    name: 'sky',
    glslVersion: GLSL3,
    uniforms: skyUniforms(u),
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    depthWrite: false,
    side: DoubleSide,
  });
  const decodeDebug = new ShaderMaterial({
    name: 'decodeDebug',
    glslVersion: GLSL3,
    vertexShader: decodeDebugVertex(s.variant),
    fragmentShader: DECODE_DEBUG_FRAGMENT,
    blending: NoBlending,
    toneMapped: false,
  });
  const materials = [terrainOpaque, terrainCutout, water, sky, decodeDebug];

  // The frame's scratch: setFrameUniforms writes into these, so a frame allocates nothing (SP4b spec §3.10).
  const fog = { start: 0, end: 0 };
  const zenith = new Float64Array(3);
  const horizon = new Float64Array(3);
  const sun = new Float64Array(3);
  return {
    variant: s.variant,
    terrainOpaque,
    terrainCutout,
    water,
    sky,
    decodeDebug,
    lightmap,
    setFrameUniforms(f) {
      fogRange(f.rd, f.fogBand, fog);
      u.fogStart.value = fog.start;
      u.fogEnd.value = fog.end;
      u.eyeSky.value = f.eyeSky;
      skyColorsInto(f.t, zenith, horizon);
      u.skyZenith.value.setRGB(zenith[0]!, zenith[1]!, zenith[2]!, SRGBColorSpace);
      u.skyHorizon.value.setRGB(horizon[0]!, horizon[1]!, horizon[2]!, SRGBColorSpace);
      sunDirectionInto(f.t, sun);
      u.sunDir.value.set(sun[0]!, sun[1]!, sun[2]!);
      lightmap.update(dayFactor(f.t), duskFactor(f.t), f.brightness);
    },
    dispose() {
      for (const m of materials) m.dispose();
      lightmap.texture.dispose();
    },
  };
}

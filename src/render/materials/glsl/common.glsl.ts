/**
 * The GLSL the materials share (SP4a spec §6.4-§6.6, master §4.6): the GLSL3 fragment output, the lightmap lookup, the
 * sky colour, the fog with the world-edge fade, and the vertex placement of both section renderers. Each material's
 * source is these strings concatenated, so a test can read the whole shader from `material.fragmentShader`.
 */
import type { MaterialVariant } from '../index';

/**
 * three emits `pc_fragColor` and the `gl_FragColor` define only for non-GLSL3 materials (WebGLProgram.js:817-820), and
 * its colour-space chunk assigns `gl_FragColor`; every fragment shader here starts with this (ruling P14).
 */
export const FRAGMENT_OUTPUT = `layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
`;

/** Degrees to radians as a GLSL float literal. */
const rad = (deg: number): string => ((deg * Math.PI) / 180).toFixed(7);

/**
 * The lightmap (render/lightmap.ts): texel x = block light, y = sky light, levels 0-15 (ruling P15). The smooth varyings
 * are looked up unrounded; the texture is filtered linearly (ruling P10).
 */
export const LIGHTMAP_GLSL = `
uniform sampler2D lightmap;
vec3 lightmapAt(float block, float sky) {
  return texture(lightmap, (vec2(block, sky) + 0.5) / 16.0).rgb;
}
`;

/**
 * The sky (spec §6.5, master §4.6). skyGradient(dir), shared by the sky dome and the fog: the gradient from the horizon
 * stop (at and below the horizon) to the zenith stop, both `skyColors(t)` in linear. skyColor(dir), the sky dome's: the
 * gradient plus a sun disc of 2° radius with a glow to 12° that sinks below the horizon with the sun. The gradient's
 * curve, the soft edge of the disc and the sun's colours are this plan's choices.
 */
export const SKY_GLSL = `
uniform vec3 skyZenith;
uniform vec3 skyHorizon;
uniform vec3 sunDir;
const float SUN_DISC = ${rad(2)};
const float SUN_DISC_SOFT = ${rad(0.25)};
const float SUN_GLOW = ${rad(12)};
const vec3 SUN_COLOR = vec3(1.0, 0.92, 0.78);
const vec3 SUN_GLOW_COLOR = vec3(1.0, 0.72, 0.42);
vec3 skyGradient(vec3 dir) {
  return mix(skyHorizon, skyZenith, smoothstep(0.0, 0.6, max(dir.y, 0.0)));
}
vec3 skyColor(vec3 dir) {
  vec3 c = skyGradient(dir);
  float a = acos(clamp(dot(dir, sunDir), -1.0, 1.0));
  float above = smoothstep(-0.02, 0.02, dir.y);
  float glow = 1.0 - smoothstep(SUN_DISC, SUN_GLOW, a);
  c += SUN_GLOW_COLOR * (0.35 * glow * glow * above);
  float disc = 1.0 - smoothstep(SUN_DISC - SUN_DISC_SOFT, SUN_DISC, a);
  return mix(c, SUN_COLOR, disc * above);
}
`;

/**
 * The fog (spec §6.6, D15): spherical, f = smoothstep(fogStart, fogEnd, |viewPos|), raised to the edge fade
 * smoothstep(edge − 24, edge, horizontal distance from the load centre); its colour is the sky gradient towards the
 * fragment's horizon, without the sun's disc and glow (they would paint a bright stripe on the fogged terrain under a
 * low sun; final review B-M1), darkened by the lightmap's sky term at the eye's sky light (block 0, ruling P15). Needs
 * SKY_GLSL and LIGHTMAP_GLSL before it; `worldPos` and `edgeCentre` are relative to the floating origin, as
 * `cameraPosition` is.
 */
export const FOG_GLSL = `
uniform float fogStart;
uniform float fogEnd;
uniform float edge;
uniform float edgeFadeStart;
uniform vec2 edgeCentre;
uniform float eyeSky;
vec3 applyFog(vec3 color, vec3 viewPos, vec3 worldPos) {
  float f = smoothstep(fogStart, fogEnd, length(viewPos));
  f = max(f, smoothstep(edgeFadeStart, edge, length(worldPos.xz - edgeCentre)));
  vec3 h = vec3(worldPos.x - cameraPosition.x, 0.0, worldPos.z - cameraPosition.z);
  vec3 horizonDir = dot(h, h) > 1e-8 ? normalize(h) : vec3(0.0, 0.0, -1.0);
  vec3 fogColor = skyGradient(horizonDir) * lightmapAt(0.0, eyeSky);
  return mix(color, fogColor, f);
}
`;

/**
 * The light varyings' interpolation: smooth with `SMOOTH_LIGHT` (spec §5.3's per-vertex values), flat without it (the
 * mesher then writes the face voxel's light on every vertex). Both stages include it, so the qualifiers match.
 */
export const LIGHT_INTERP_GLSL = `
#ifdef SMOOTH_LIGHT
#define LIGHT_INTERP
#else
#define LIGHT_INTERP flat
#endif
`;

/**
 * The head of a section vertex shader: the batching uniforms for RegionBatch, or `REGION_MESH` (the Uint16
 * region-local position of RegionMesh, no batching chunks; spec §6.2).
 */
export function vertexHead(variant: MaterialVariant): string {
  return variant === 'mesh' ? '#define REGION_MESH\n' : '#include <batching_pars_vertex>\n';
}

/**
 * The placement of a section vertex inside `main()`, from `p` (a vec3 in 1/8-block units: the instance or mesh matrix
 * scales by 1/8, spec §6.2). It declares `worldPos4` (relative to the floating origin) and `mvPos4`, and sets
 * `gl_Position`.
 */
export function vertexPlace(variant: MaterialVariant, p: string): string {
  const batching = variant === 'batch'
    ? `  #include <batching_vertex>
  #ifdef USE_BATCHING
  local = batchingMatrix * local;
  #endif
`
    : '';
  return `  vec4 local = vec4(${p}, 1.0);
${batching}  vec4 worldPos4 = modelMatrix * local;
  vec4 mvPos4 = modelViewMatrix * local;
  gl_Position = projectionMatrix * mvPos4;
`;
}

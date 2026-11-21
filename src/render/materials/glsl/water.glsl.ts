/**
 * Water, both tiers in one program (SP4a spec §5.6, §6.4; SP7a spec §7, D10, D28; master §4.10). Fast: the colour from
 * shallow to deep by depth / 15, × the lightmap, then the fog, at alpha 0.72. Fancy (`waterTier` 1) adds, on the normal
 * from the screen derivatives of the world position (sloped surfaces included), two octaves of scrolling procedural
 * ripple normals driven by `timeSeconds`, and Schlick Fresnel toward the sky in the reflected direction, at alpha
 * 0.6 + 0.3·Fresnel; the tier is a uniform, so a toggle relinks nothing. The mesher keeps every position at the voxel's
 * full height (ruling P25), and the vertex shader lowers each corner by its `cornerDrop` ninths of a block, so a still
 * surface sits at y + 8/9. SP6a (spec §5.3): every vertex is collapsed while the X-ray is on (`xrayOn` 1).
 */
import type { MaterialVariant } from '../index';
import {
  COLLAPSED_GLSL, FOG_GLSL, FRAGMENT_OUTPUT, LIGHT_INTERP_GLSL, LIGHTMAP_GLSL, SKY_GLSL, vertexHead, vertexPlace,
} from './common.glsl';
import { packingGlsl } from './packing.glsl';

/** The water vertex shader: decodes the fluid `data` word; positions are in 1/8-block units, so a ninth is 8/9. */
export function waterVertex(variant: MaterialVariant): string {
  return `${vertexHead(variant)}${LIGHT_INTERP_GLSL}
${packingGlsl()}${COLLAPSED_GLSL}in uint data;
LIGHT_INTERP out float vSky;
LIGHT_INTERP out float vBlock;
flat out float vDepth;
out vec3 vViewPos;
out vec3 vWorldPos;
void main() {
  vSky = float(pkF_sky(data));
  vBlock = float(pkF_block(data));
  vDepth = float(pkF_depth(data));
  float cornerDrop = float(pkF_cornerDrop(data));
  vec3 p = vec3(position.x, position.y - cornerDrop * (8.0 / 9.0), position.z);
${vertexPlace(variant, 'p')}  vViewPos = mvPos4.xyz;
  vWorldPos = worldPos4.xyz;
  if (xrayOn > 0.5) gl_Position = COLLAPSED;
}
`;
}

/**
 * Fancy's ripples (SP7a spec §7, D10): value noise over an integer hash of the lattice cell, and its analytic gradient
 * (the smoothstep-interpolated corner values, differentiated); two octaves at λ 4 and 1.7 blocks scrolling 0.4 and 0.9
 * blocks/s along (1, 0) and (−0.6, 0.8), their summed gradient tilting the normal by `RIPPLE_TILT` (this plan's choice).
 * No texture. `xz` is relative to the floating origin, `t` the frame's clock (`timeSeconds`).
 */
const RIPPLE_GLSL = `
const float RIPPLE_TILT = 0.15;
float rippleHash(vec2 c) {
  uvec2 q = uvec2(ivec2(c));
  uint h = q.x * 0x8da6b343u ^ q.y * 0xd8163841u;
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h ^= h >> 15u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}
vec2 valueNoiseGrad(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float a = rippleHash(i);
  float b = rippleHash(i + vec2(1.0, 0.0));
  float c = rippleHash(i + vec2(0.0, 1.0));
  float d = rippleHash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float k = a - b - c + d;
  return du * vec2(b - a + k * u.y, c - a + k * u.x);
}
vec3 rippleTilt(vec2 xz, float t) {
  vec2 g = valueNoiseGrad((xz - vec2(1.0, 0.0) * (0.4 * t)) / 4.0)
    + valueNoiseGrad((xz - vec2(-0.6, 0.8) * (0.9 * t)) / 1.7);
  return vec3(-g.x, 0.0, -g.y) * RIPPLE_TILT;
}
`;

/**
 * The water fragment shader, shared by both variants; `waterShallow` and `waterDeep` are linear. Fancy's reflected sky
 * is darkened by the lightmap's sky term at the fragment's sky light (block 0), as the fog is at the eye's, so water
 * under rock reflects no daylight.
 */
export const WATER_FRAGMENT = `${FRAGMENT_OUTPUT}${LIGHT_INTERP_GLSL}
uniform float alpha;
uniform vec3 waterShallow;
uniform vec3 waterDeep;
uniform float waterTier;
uniform float timeSeconds;
${LIGHTMAP_GLSL}${SKY_GLSL}${FOG_GLSL}${RIPPLE_GLSL}
LIGHT_INTERP in float vSky;
LIGHT_INTERP in float vBlock;
flat in float vDepth;
in vec3 vViewPos;
in vec3 vWorldPos;
void main() {
  vec3 color = mix(waterShallow, waterDeep, vDepth / 15.0) * lightmapAt(vBlock, vSky);
  float a = alpha;
  if (waterTier > 0.5) {
    vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    n = normalize(n + rippleTilt(vWorldPos.xz, timeSeconds));
    vec3 viewDir = normalize(vWorldPos - cameraPosition);
    float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(-viewDir, n), 0.0, 1.0), 5.0);
    color = mix(color, skyColor(reflect(viewDir, n)) * lightmapAt(0.0, vSky), fresnel);
    a = 0.6 + 0.3 * fresnel;
  }
  gl_FragColor = vec4(applyFog(color, vViewPos, vWorldPos), a);
  #include <colorspace_fragment>
}
`;

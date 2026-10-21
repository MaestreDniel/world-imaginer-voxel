/**
 * Still water, the Fast tier (SP4a spec §5.6, §6.4; master §4.10): the colour from shallow to deep by depth / 15, × the
 * lightmap, then the fog, at alpha 0.72. The mesher keeps every position at the voxel's full height (ruling P25), and
 * the vertex shader lowers each corner by its `cornerDrop` ninths of a block, so a still surface sits at y + 8/9.
 */
import type { MaterialVariant } from '../index';
import { FOG_GLSL, FRAGMENT_OUTPUT, LIGHT_INTERP_GLSL, LIGHTMAP_GLSL, SKY_GLSL, vertexHead, vertexPlace } from './common.glsl';
import { packingGlsl } from './packing.glsl';

/** The water vertex shader: decodes the fluid `data` word; positions are in 1/8-block units, so a ninth is 8/9. */
export function waterVertex(variant: MaterialVariant): string {
  return `${vertexHead(variant)}${LIGHT_INTERP_GLSL}
${packingGlsl()}
in uint data;
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
}
`;
}

/** The water fragment shader, shared by both variants; `waterShallow` and `waterDeep` are linear. */
export const WATER_FRAGMENT = `${FRAGMENT_OUTPUT}${LIGHT_INTERP_GLSL}
uniform float alpha;
uniform vec3 waterShallow;
uniform vec3 waterDeep;
${LIGHTMAP_GLSL}${SKY_GLSL}${FOG_GLSL}
LIGHT_INTERP in float vSky;
LIGHT_INTERP in float vBlock;
flat in float vDepth;
in vec3 vViewPos;
in vec3 vWorldPos;
void main() {
  vec3 color = mix(waterShallow, waterDeep, vDepth / 15.0) * lightmapAt(vBlock, vSky);
  gl_FragColor = vec4(applyFog(color, vViewPos, vWorldPos), alpha);
  #include <colorspace_fragment>
}
`;

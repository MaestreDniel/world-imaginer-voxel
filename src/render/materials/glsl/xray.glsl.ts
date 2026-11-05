/**
 * The X-ray's shaders (SP6a spec §5.2, §5.3, D10), in the `batch` and `mesh` variants: the cave walls and the surface
 * film of the X-ray pass (`mesh/xray.ts`, `PACK_LAYOUT.xray`) in a flat colour, `xrayPalette[kind]` × `FACE_SHADE[face]`,
 * at alpha 0.14 for a wall and 0.05 for the film (kind 15), faded to 0 over the fog's band (`fogStart` … `fogEnd`, the
 * end (RD − 1)·16), then three's colour-space chunk; the material blends it additively, so overlaps read brighter and
 * nothing needs sorting. Every fragment beyond `xrayRadius` is discarded; a wall's fragment also when its hollow
 * voxel's y lies outside the band [`xrayYMin`, `xrayYMax` + 1), the film never (it shows whatever the band, D10). The
 * voxel's y is the fragment's world y moved half a block into the hollow voxel across an up or down face (an up face of
 * voxel y lies at y + 1, a down face at y), so each face tests its own voxel. The scene's y is the world's: the
 * floating origin starts at y 0 and rebases only past 1,024 blocks, which the camera's y bounds (−64 … 400) never reach
 * (`render/floatingOrigin.ts`). No lightmap: the light floor and night vision do not touch the X-ray. The vertex shader
 * collapses every vertex while the X-ray is off (`xrayOn` 0).
 */
import { FACE_DOWN, FACE_UP } from '../../../world/blocks/kinds';
import { CAVE_FILM_KIND } from '../../../core/constants';
import type { MaterialVariant } from '../index';
import { COLLAPSED_GLSL, FRAGMENT_OUTPUT, vertexHead, vertexPlace } from './common.glsl';
import { packingGlsl } from './packing.glsl';
import { FACE_SHADE, floatArray, glslFloat } from './terrain.glsl';

/** A wall's alpha and the film's (spec §5.2). */
export const XRAY_WALL_ALPHA = 0.14;
export const XRAY_FILM_ALPHA = 0.05;

/** The X-ray vertex shader: decodes the X-ray `data` word (kind and face flat); collapsed while the X-ray is off. */
export function xrayVertex(variant: MaterialVariant): string {
  return `${vertexHead(variant)}
${packingGlsl()}${COLLAPSED_GLSL}in uint data;
flat out uint vKind;
flat out uint vFace;
out vec3 vViewPos;
out vec3 vWorldPos;
void main() {
  vKind = pkX_kind(data);
  vFace = pkX_face(data);
${vertexPlace(variant, 'position')}  vViewPos = mvPos4.xyz;
  vWorldPos = worldPos4.xyz;
  if (xrayOn < 0.5) gl_Position = COLLAPSED;
}
`;
}

/** The X-ray fragment shader, shared by both variants; `xrayPalette` is linear. */
export const XRAY_FRAGMENT = `${FRAGMENT_OUTPUT}
uniform vec3 xrayPalette[16];
uniform float xrayYMin;
uniform float xrayYMax;
uniform float xrayRadius;
uniform float fogStart;
uniform float fogEnd;
flat in uint vKind;
flat in uint vFace;
in vec3 vViewPos;
in vec3 vWorldPos;
${floatArray('FACE_SHADE', FACE_SHADE)}
void main() {
  float dist = length(vViewPos);
  if (dist > xrayRadius) discard;
  if (vKind != ${CAVE_FILM_KIND}u) {
    float cellY = floor(vWorldPos.y - (vFace == ${FACE_UP}u ? 0.5 : vFace == ${FACE_DOWN}u ? -0.5 : 0.0));
    if (cellY < xrayYMin || cellY >= xrayYMax + 1.0) discard;
  }
  vec3 color = xrayPalette[vKind] * FACE_SHADE[min(vFace, 5u)];
  float alpha = vKind == ${CAVE_FILM_KIND}u ? ${glslFloat(XRAY_FILM_ALPHA)} : ${glslFloat(XRAY_WALL_ALPHA)};
  float fade = 1.0 - smoothstep(fogStart, fogEnd, dist);
  gl_FragColor = vec4(color, alpha * fade);
  #include <colorspace_fragment>
}
`;

/**
 * The terrain shaders (SP4a spec §6.4, master §4.6) and the decode-debug shaders of the spike's exactness test (§1.2).
 * Terrain: albedo(layer) × faceShade × AO × lightmap(block, sky), then the fog, then three's colour-space chunk; no
 * Lambert and no sun term. The defines `TERRAIN_AO`, `SMOOTH_LIGHT` and `CUTOUT` come from the material.
 */
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../../world/blocks/kinds';
import type { MaterialVariant } from '../index';
import { FOG_GLSL, FRAGMENT_OUTPUT, LIGHT_INTERP_GLSL, LIGHTMAP_GLSL, SKY_GLSL, vertexHead, vertexPlace } from './common.glsl';
import { packingGlsl } from './packing.glsl';

/** A GLSL float literal. */
const glslFloat = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const floatArray = (name: string, values: readonly number[]): string =>
  `const float ${name}[${values.length}] = float[${values.length}](${values.map(glslFloat).join(', ')});`;

/** faceShade by `kinds.ts` face id: up 1, down 0.5, north and south 0.8, east and west 0.6 (master §4.6). */
const FACE_SHADE: readonly number[] = (() => {
  const s: number[] = [];
  s[FACE_NORTH] = 0.8;
  s[FACE_SOUTH] = 0.8;
  s[FACE_EAST] = 0.6;
  s[FACE_WEST] = 0.6;
  s[FACE_UP] = 1;
  s[FACE_DOWN] = 0.5;
  return s;
})();

/** The AO factor by `ao2` (SP4a spec §5.3, 09's table). */
const AO_FACTOR = [1, 0.8, 0.6, 0.45] as const;

/** Glass's frame (SP5a spec §1.3): a framed fragment whose two in-face coordinates both lie in [1/16, 15/16] is clear. */
const FRAME_LO = glslFloat(1 / 16);
const FRAME_HI = glslFloat(15 / 16);

/**
 * The terrain vertex shader: decodes the solid `data` word; layer, face and frame flat, sky, block and AO
 * interpolated.
 */
export function terrainVertex(variant: MaterialVariant): string {
  return `${vertexHead(variant)}${LIGHT_INTERP_GLSL}
${packingGlsl()}
in uint data;
flat out uint vLayer;
flat out uint vFace;
flat out uint vFrame;
LIGHT_INTERP out float vSky;
LIGHT_INTERP out float vBlock;
out float vAo;
out vec3 vViewPos;
out vec3 vWorldPos;
${floatArray('AO_FACTOR', AO_FACTOR)}
void main() {
  vLayer = pkS_layer(data);
  vFace = pkS_face(data);
  vFrame = pkS_frame(data);
  vSky = float(pkS_sky(data));
  vBlock = float(pkS_block(data));
#ifdef TERRAIN_AO
  vAo = AO_FACTOR[pkS_ao(data)];
#else
  vAo = 1.0;
#endif
${vertexPlace(variant, 'position')}  vViewPos = mvPos4.xyz;
  vWorldPos = worldPos4.xyz;
}
`;
}

/**
 * The terrain fragment shader, shared by both variants; `CUTOUT` discards texels with alpha below 0.5 and, on a framed
 * face (glass, SP5a spec §1.3), the inside of the frame: the face's two in-face coordinates of `fract(vWorldPos)` (y
 * and z across an east or west face, x and z across up or down, x and y across north or south) both in [1/16, 15/16].
 * The floating origin is a multiple of 512 blocks (`render/floatingOrigin.ts`), so `fract` is block-aligned, also on
 * merged quads.
 */
export const TERRAIN_FRAGMENT = `${FRAGMENT_OUTPUT}${LIGHT_INTERP_GLSL}
uniform sampler2DArray albedo;
${LIGHTMAP_GLSL}${SKY_GLSL}${FOG_GLSL}
flat in uint vLayer;
flat in uint vFace;
flat in uint vFrame;
LIGHT_INTERP in float vSky;
LIGHT_INTERP in float vBlock;
in float vAo;
in vec3 vViewPos;
in vec3 vWorldPos;
${floatArray('FACE_SHADE', FACE_SHADE)}
void main() {
  vec4 base = texture(albedo, vec3(0.5, 0.5, float(vLayer)));
#ifdef CUTOUT
  if (base.a < 0.5) discard;
  if (vFrame != 0u) {
    vec3 cell = fract(vWorldPos);
    vec2 inFace = vFace == ${FACE_UP}u || vFace == ${FACE_DOWN}u ? cell.xz : vFace == ${FACE_EAST}u || vFace == ${FACE_WEST}u ? cell.zy : cell.xy;
    if (all(greaterThanEqual(inFace, vec2(${FRAME_LO}))) && all(lessThanEqual(inFace, vec2(${FRAME_HI})))) discard;
  }
#endif
  vec3 color = base.rgb * FACE_SHADE[min(vFace, 5u)] * vAo * lightmapAt(vBlock, vSky);
  gl_FragColor = vec4(applyFog(color, vViewPos, vWorldPos), 1.0);
  #include <colorspace_fragment>
}
`;

/** The decode-debug vertex shader: placed like terrain, it passes the raw `data` word flat. */
export function decodeDebugVertex(variant: MaterialVariant): string {
  return `${vertexHead(variant)}
in uint data;
flat out uint vData;
void main() {
  vData = data;
${vertexPlace(variant, 'position')}}
`;
}

/**
 * The decode-debug fragment shader: the `data` word's 4 bytes, low byte first, as RGBA (exact in an RGBA8 target);
 * written to `pc_fragColor` directly, with no colour-space chunk (ruling P14).
 */
export const DECODE_DEBUG_FRAGMENT = `${FRAGMENT_OUTPUT}
flat in uint vData;
void main() {
  uvec4 bytes = uvec4(vData, vData >> 8u, vData >> 16u, vData >> 24u) & 255u;
  pc_fragColor = vec4(bytes) / 255.0;
}
`;

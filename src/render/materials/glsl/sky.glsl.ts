/**
 * The sky dome (SP4a spec §6.5): a full-screen triangle whose `position` is already in clip space (x, y ∈ {−1, 3}),
 * drawn at the far plane (z = w) after the opaque pass with no depth write. The view ray comes from the inverse
 * projection, turned into the world by the view rotation's transpose, and the colour is `skyColor(dir)`.
 */
import { FRAGMENT_OUTPUT, SKY_GLSL } from './common.glsl';

export const SKY_VERTEX = `
out vec3 vDir;
void main() {
  vec4 far = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vDir = transpose(mat3(viewMatrix)) * (far.xyz / far.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const SKY_FRAGMENT = `${FRAGMENT_OUTPUT}${SKY_GLSL}
in vec3 vDir;
void main() {
  gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
  #include <colorspace_fragment>
}
`;

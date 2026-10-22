import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import type { MaterialSystem } from './materials/index';

/**
 * The sky dome (SP4a spec §6.5): one full-screen triangle whose positions are already in clip space (x, y ∈ {−1, 3});
 * the sky material (`render/materials/glsl/sky.glsl.ts`) draws it at the far plane with the view ray from the inverse
 * projection. It is never frustum-culled and draws after the opaque pass (spec §6.1's pass order).
 */

/** The sky's `renderOrder`: after the opaque sections (0), before the cutout pass (`render/renderer.ts`). */
export const SKY_RENDER_ORDER = 1;

/** The sky dome's mesh over `m.sky`; its geometry is the caller's to dispose. */
export function createSky(m: MaterialSystem): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const sky = new Mesh(g, m.sky);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = SKY_RENDER_ORDER;
  return sky;
}

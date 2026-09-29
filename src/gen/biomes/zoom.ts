/**
 * Jittered-Voronoi zoom (SP2a spec §3.3): each quart lattice point (4qx, 4qz) is jittered by
 * hash2 → [−j, j)² blocks; a position takes the nearest of the 4 surrounding jittered points
 * (ties to the lower (qz, qx)). Returns the chosen quart; its biome is the lattice biome there.
 */
import { hash2, hash4 } from '../../core/hash';
import type { GenContext } from '../context';

const H2 = hash2;
const H4 = hash4;
const TO_UNIT = 1 / 4294967296;

export function zoomQuart(ctx: GenContext, px: number, pz: number, out: [number, number]): [number, number] {
  const j = ctx.params.biomes.zoomJitter;
  const s = ctx.zoomSeed;
  const qx0 = Math.floor(px / 4);
  const qz0 = Math.floor(pz / 4);
  let bestD2 = Infinity;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const qx = qx0 + dx;
      const qz = qz0 + dz;
      const jx = 4 * qx + j * (2 * H2(s, qx, qz) * TO_UNIT - 1);
      const jz = 4 * qz + j * (2 * H4(s, 1, qx, qz) * TO_UNIT - 1);
      const d2 = (px - jx) * (px - jx) + (pz - jz) * (pz - jz);
      if (d2 < bestD2) { bestD2 = d2; out[0] = qx; out[1] = qz; }
    }
  }
  return out;
}

import { detErf } from '../detMath';

const ERF = detErf;

/** u = erf(z/√2), written exactly as detErf(z * Math.SQRT1_2) (SP1 spec §2.4). */
export function toUniform(z: number): number {
  return ERF(z * Math.SQRT1_2);
}

/** Largest |u| for clamp c: 0.9973002846585164 at c = 3. */
export function uMax(c: number): number {
  return ERF(c * Math.SQRT1_2);
}

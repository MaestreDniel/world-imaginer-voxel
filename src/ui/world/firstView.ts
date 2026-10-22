/**
 * Where the camera opens (SP4a spec §8.4 step 5, D32; rulings P42, P48): `eyeAbove` blocks (2 by default) above
 * `MOTION_BLOCKING` at the given position unless the query gave y; the yaw toward the lowest of eight
 * `MOTION_BLOCKING` samples 48 blocks away, at yaw 0°, 45° … 315° (ties to the smallest yaw), unless given; pitch −10°
 * unless given. Degrees as in `player/fly.ts`: sample k sits at `(x, z) + 48·forwardXZ(45k)`.
 */
import { forwardXZ } from '../../player/fly';

/** How far the eight yaw samples are, in blocks. */
export const SAMPLE_DISTANCE = 48;
/** The opening pitch, degrees. */
export const DEFAULT_PITCH = -10;

export function firstView(
  motionBlockingAt: (x: number, z: number) => number,
  x: number,
  z: number,
  given: { readonly y: number | null; readonly yaw: number | null; readonly pitch: number | null },
  eyeAbove = 2,
): { y: number; yaw: number; pitch: number } {
  const y = given.y ?? motionBlockingAt(x, z) + eyeAbove;
  let yaw = given.yaw;
  if (yaw === null) {
    let lowest = Number.POSITIVE_INFINITY;
    yaw = 0;
    for (let k = 0; k < 8; k++) {
      const [dx, dz] = forwardXZ(45 * k);
      const h = motionBlockingAt(x + SAMPLE_DISTANCE * dx, z + SAMPLE_DISTANCE * dz);
      // Strictly lower: a tie keeps the smaller yaw.
      if (h < lowest) {
        lowest = h;
        yaw = 45 * k;
      }
    }
  }
  return { y, yaw, pitch: given.pitch ?? DEFAULT_PITCH };
}

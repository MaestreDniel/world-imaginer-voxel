/**
 * The floating origin (SP4a spec §6.8, master §2.1): the scene is drawn relative to an origin snapped to 512 blocks, so
 * float32 positions stay small anywhere in the ±500,000-block world. The origin is rebased when the camera is more
 * than 1,024 blocks from it on any axis; the caller then re-sets the instance matrices (`SectionRenderer.setOrigin`).
 * The load centre sets the first origin; within SP4a's clamp a rebase does not trigger.
 */

/** The snap step, in blocks. */
const SNAP = 512;
/** How far the camera may be from the origin, on any axis, before a rebase. */
const REBASE_DISTANCE = 1024;

/** `v` snapped toward zero to a multiple of 512; `+ 0` turns −0 into +0 (ruling P39). */
const snap = (v: number): number => Math.trunc(v / SNAP) * SNAP + 0;

export interface FloatingOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * Rebases to the camera at (camX, camY, camZ), in absolute blocks, when it is more than 1,024 blocks from the origin
   * on any axis: all three axes are re-snapped. Returns true when the origin moved.
   */
  update(camX: number, camY: number, camZ: number): boolean;
}

/** The origin at (x, y, z) snapped to 512 on each axis. */
export function createFloatingOrigin(x: number, y: number, z: number): FloatingOrigin {
  let ox = snap(x);
  let oy = snap(y);
  let oz = snap(z);
  return {
    get x() {
      return ox;
    },
    get y() {
      return oy;
    },
    get z() {
      return oz;
    },
    update(camX, camY, camZ) {
      const far =
        Math.abs(camX - ox) > REBASE_DISTANCE || Math.abs(camY - oy) > REBASE_DISTANCE || Math.abs(camZ - oz) > REBASE_DISTANCE;
      if (!far) return false;
      ox = snap(camX);
      oy = snap(camY);
      oz = snap(camZ);
      return true;
    },
  };
}

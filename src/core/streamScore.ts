/**
 * The stage score of a column job (SP4b spec §3.3, D10; master §4.3): `d_h − 3·max(0, cos θ)·[d_h > 2] − stageBonus`,
 * lower runs first. One pure function, shared by the coordinator's four heaps and the section renderers' ready queue
 * (§3.9): core is importable from both engine and render, which may not import each other.
 *
 * `core/` follows the Math allowlist (no trigonometry), so the caller passes the camera's horizontal forward as a unit
 * vector `(fx, fz)` computed from its yaw (`[sin yaw, −cos yaw]`, `player/fly.ts`'s `forwardXZ`), and cos θ is the
 * dot product with the offset over its length (amended while planning).
 */

/** Each stage's bonus (master §4.3): a later stage of the same column runs first. */
export const STAGE_BONUS = { T: 0, D: 0.5, L: 1, MESH: 1.5 } as const;
/** The view term's weight: a column straight ahead scores 3 lower than one beside or behind. */
export const VIEW_WEIGHT = 3;
/** The view term applies only beyond this horizontal distance in columns (the columns around the camera come first). */
export const VIEW_MIN_DH = 2;

/**
 * The score of a job for the column at offset (dx, dz) from the camera's column, with the unit forward (fx, fz) and a
 * stage bonus (`STAGE_BONUS`). The quotient is never computed at d ≤ 2, so (0, 0) gives −bonus, never NaN.
 */
export function streamScore(dx: number, dz: number, fx: number, fz: number, bonus: number): number {
  const d = Math.sqrt(dx * dx + dz * dz);
  const view = d > VIEW_MIN_DH ? VIEW_WEIGHT * Math.max(0, (dx * fx + dz * fz) / d) : 0;
  return d - view - bonus;
}

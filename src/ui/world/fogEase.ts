/**
 * The fog's easing after a live render-distance change (SP4b spec §5, D18). Raising the RD moves the fog's end
 * (`(rd_fog − 1)·16`, spec §6.3) outward toward the new target, following the filled radius (the largest r ≤ rd whose
 * disc around the camera's column is fully revealed, scanned every `FILL_SCAN_FRAMES` rendered frames), never faster
 * than 32 blocks/s and never inward; once it reaches the target the easing ends and the fog stays put, whatever later
 * streaming lag leaves empty. Lowering the RD moves the fog's end in at once, to min(where it is, the new end), and an
 * easing still under way continues outward to the new target (SP4b plan, Review Focus 5).
 *
 * The scan lives here, not in render or engine: `ui` may read both the rings (`discOffsets`) and the section
 * renderer's reveal query (`isRevealed`).
 */
import { discOffsets } from '../../engine/rings';

/** The fastest the fog's end moves outward, in blocks per second (spec §5): 2 RD per second. */
export const FOG_EASE_BLOCKS_PER_S = 32;
/** How often the page scans the filled radius while the fog eases, in rendered frames (spec §5). */
export const FILL_SCAN_FRAMES = 30;

/** Blocks per column: the fog's end moves 16 blocks per RD. */
const BLOCKS_PER_RD = 16;
/** The easing's speed in RD per millisecond. */
const RD_PER_MS = FOG_EASE_BLOCKS_PER_S / BLOCKS_PER_RD / 1000;

/**
 * The filled radius around column (cx, cz) at `rd` (spec §5): scans `discOffsets(rd)` in spiral order (by d², so the
 * first unrevealed column is a nearest one); the first unrevealed offset at distance d gives `ceil(d − 0.5) − 1`, the
 * largest r whose disc `dx² + dz² ≤ (r + 0.5)²` leaves it out (−1 when the camera's own column is not revealed); all
 * revealed gives rd. At most 489 lookups at RD 12; nothing is allocated (the offsets are cached).
 */
export function filledRadius(cx: number, cz: number, rd: number, isRevealed: (cx: number, cz: number) => boolean): number {
  const offs = discOffsets(rd);
  for (let i = 0; i < offs.length; i++) {
    const o = offs[i]!;
    const dx = o[0];
    const dz = o[1];
    if (!isRevealed(cx + dx, cz + dz)) return Math.ceil(Math.sqrt(dx * dx + dz * dz) - 0.5) - 1;
  }
  return rd;
}

/** The fog's render distance over time: `step` once per rendered frame, `setTarget` on each live RD change. */
export interface FogEase {
  /**
   * The new target RD. A lower one sets the fog's RD to min(current, rd) at once (never past where it is); a higher
   * one leaves it where it is, for `step` to ease outward.
   */
  setTarget(rd: number): void;
  /**
   * Advances `dtMs` and returns the fog's RD (fractional while easing): while below the target it moves outward by at
   * most 2 RD per second (32 blocks/s), never past `filled` nor the target, and never inward.
   */
  step(dtMs: number, filled: number): number;
  /** The target RD (the last `setTarget`, or the first rd). */
  readonly target: number;
}

/** The fog's easing, starting at rest at `rd`. */
export function createFogEase(rd: number): FogEase {
  let current = rd;
  let target = rd;
  return {
    setTarget(r) {
      target = r;
      if (current > r) current = r;
    },
    step(dtMs, filled) {
      if (current >= target) return current;
      const limit = Math.min(target, filled);
      if (limit > current) current = Math.min(limit, current + Math.max(0, dtMs) * RD_PER_MS);
      return current;
    },
    get target() {
      return target;
    },
  };
}

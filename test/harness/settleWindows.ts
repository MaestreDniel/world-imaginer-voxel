/**
 * DT1's three settle windows (SP7a spec §13.4, D30; Task 17), pinned as literals with their scans (rulings P18, P28):
 * candidate S(a, b) is `windowScans.ts`' `settleWindowAt` (the 10 × 10 region at chunk origin (6a − 2, 6b − 2), whose
 * 6 × 6 interior is at (6a, 6b)), seed '42', profile default, generated up to 'D', each holding its feature over the
 * interior (`settleFeatures`, `settleWindowHolds`). Kept apart from the metric files so that `region.metric.ts`,
 * `light.metric.ts` and later readers (streaming, the bench, R1's sites, the golden) import it without registering a
 * metric file's tests. A re-scan (`scanSettleWindow`, from a throwaway test) edits this file only, the metrics re-check
 * each window's feature ("each SETTLE_WINDOWS entry still holds its feature", `region.metric.ts`).
 * The scans at Task 17 (`GENERATOR_VERSION` 10, before the springs):
 * - `coast`: S(−10, −10) at ring 10, the first candidate past the coast's prefilter (none within ring 9): 1,534 sea
 *   and 5,552 land positions, 1,520 settled voxels, 73 spills from the sea's walls and 554 settle-made voxels in caves
 *   (a flooded cave's border).
 * - `contact`: S(1, 0) at ring 1: 6 lava voxels beside water (1,149 settled voxels).
 * - `streamOverPool`: S(0, 0) at ring 0: 25 settle-made falling voxels under a settle-made stream, beside a settle-made
 *   pool (285 settled voxels).
 * Task 19's re-scan of `coast` (the water springs; the coast now holds a water spring too, `scanSettleWindow` with the
 * springs prefilter `interiorSprings`, taking S(1, 0) and S(0, 0) as taken): S(19, −30) at ring 30, the 273rd coast
 * candidate and the first whose interior's springs step accepts a spring: 1,285 sea and 7,033 land positions, 589
 * settled voxels, 27 spills, 482 settle-made voxels in caves, 38 falls over a settle-made stream, 1 water spring.
 * `contact` and `streamOverPool` keep their windows (each still holds its feature).
 */
import type { SettleFeature } from './windowScans';

/** A settle window: the feature it holds and its candidate S(a, b). */
export interface SettleWindow {
  readonly feature: SettleFeature;
  readonly a: number;
  readonly b: number;
}

/** DT1's settle windows, in `SETTLE_FEATURES` order (header). */
export const SETTLE_WINDOWS: readonly SettleWindow[] = [
  { feature: 'coast', a: 19, b: -30 },
  { feature: 'contact', a: 1, b: 0 },
  { feature: 'streamOverPool', a: 0, b: 0 },
];

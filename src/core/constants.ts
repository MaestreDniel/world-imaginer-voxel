/** Bumped whenever generated output changes; goldens and saves are bound to it (§6.2). */
export const GENERATOR_VERSION = 5;

/** World geometry (master §2.1): lowest block y, world height and sea level. */
export const MIN_Y = -64;
export const HEIGHT = 384;
export const SEA_LEVEL = 63;

/** Map tiles (SP2a spec §6.1): tile size in pixels and levels in blocks per pixel; 256 is the preview level. */
export const MAP_TILE_PX = 256;
export const MAP_LEVELS = [256, 64, 16, 4] as const;
export type MapLevel = (typeof MAP_LEVELS)[number];

/**
 * Tier-1 bounds of a `json` leaf value (SP3d spec §1.7, `core/params/json.ts`): container depth (the value's top
 * container is 1), values counted at every visit, items per array, UTF-16 units per string, characters of the
 * canonical text (128 KiB), issues listed before one TOO_MANY_ISSUES, and the length of an object key
 * (`^[A-Za-z][A-Za-z0-9_]{0,31}$`). Shared by the tier-2 validators and the inspector.
 */
export const TREE_LIMITS = Object.freeze({
  depth: 48,
  values: 65_536,
  arrayItems: 1_024,
  stringUnits: 256,
  textUnits: 131_072,
  issues: 50,
  keyLength: 32,
});

const bound = (lo: number, hi: number): readonly [lo: number, hi: number] => Object.freeze([lo, hi] as const);

/**
 * A closed interval for every continuous ColumnSample field (`SAMPLE_FIELDS`, `gen/column/columnStage.ts`) holding its
 * value at every lattice point, quart corner and `readField` position, for every schema-valid params document and
 * every seed (SP3d spec §1.9: the static magnitude analysis reads a `col` node as this interval). Argued from the
 * formulas in `gen/column/`; exact-arithmetic ranges are widened outward to round numbers, which absorbs the few-ulp
 * rounding of the lerps in rivers and lakes. Shared facts:
 * - `readField` (an outside `col`) is a bilinear blend with weights fx, fz ∈ [0, 0.75] (i, j clamped to 3), and
 *   a + (b − a)·t with t ∈ [0, 0.75] rounds into [min(a, b), max(a, b)]; `interpolated` reads lattice values as they
 *   are. So a field's lattice interval also holds every value a density node reads.
 * - Every NormalNoise `z2` is clamped to ±clampSigma ≤ 8 (`NOISE_FIELD_RANGES.clampSigma`, `core/noise/normal.ts`).
 * - Spline bound S = 5e5: a shape spline (offset [−64, 320], sigma [−16, 64], jag [−16, 128]) nests at most 3 levels
 *   (coords C, E, PV, never reused), has |x| ≤ 2 (segment width h ≤ 4) and |d| ≤ D = 1e5 (`core/spline/validate.ts`).
 *   A Hermite segment y0 + t·dy + t(1 − t)((1 − t)(d0·h − dy) + t(dy − d1·h)), t ∈ [0, 1), leaves its knots' range
 *   [lo, hi] (width W) by at most t(1 − t)(D·h + W) ≤ D + W/4; so from knots in [−64, 320] the three levels give
 *   [−100160, 100416], [−250304, 250560], [−475520, 475776] ⊂ [−S, S].
 */
export const COL_FIELD_BOUNDS = Object.freeze({
  /** C, E, W, T, H, R = toUniform(z) = detErf(z·√½) = ±(1 − 1/q¹⁶) with q ≥ 1 (`core/noise/cdf.ts`, `detMath.ts`). */
  C: bound(-1, 1),
  E: bound(-1, 1),
  W: bound(-1, 1),
  T: bound(-1, 1),
  H: bound(-1, 1),
  R: bound(-1, 1),
  /** PV = 1 − |3|W| − 2| with |W| ≤ 1 (`climate.ts` pvFold). */
  PV: bound(-1, 1),
  /** offset0 = the offset spline: [−S, S]. */
  offset0: bound(-500_000, 500_000),
  /** sigma0, jag0 = max(0, spline) (`shape.ts`): [0, S]. */
  sigma0: bound(0, 500_000),
  jag0: bound(0, 500_000),
  /** steep = √(gx² + gz²), |g·| = |Δoffset0| / 8 ≤ 2S / 8 (`steep.ts`): ≤ √2 · 125,000 ≈ 176,777. */
  steep: bound(0, 200_000),
  /** riverDist = |Rz| / max(gradLen, 1e-4) with |Rz| ≤ 8 (`rivers.ts`): ≤ 8e4. */
  riverDist: bound(0, 100_000),
  /** riverStrength = s · s_alt, both smoothstep fades (or 0/1 steps) in [0, 1] (`rivers.ts`). */
  riverStrength: bound(0, 1),
  /** lakeMask: 1 inside, 0 outside, 1 − (q − 1)/rimWidth on the rim (`lakes.ts`); widened by 1 below 0, since the
   * rounding of the rim test q < 1 + rimWidth may leave m a few ulps below 0. */
  lakeMask: bound(-1, 1),
  /** offset after rivers and lakes (`rivers.ts`, `lakes.ts`): a lerp of offset0 and valley offsets in [min(offset0, 63),
   * offset0]; the channel min with lerp(offset0 − 64 … offset0, −1 … 63); a lake's Lw − depth·(1 − r²) ≥
   * ⌊offset0⌋ − 1 − 128 and its rim ≤ max(offset, Lw + 32 + 3·8): within [−S − 130, S + 55] ⊂ ±6e5. */
  offset: bound(-600_000, 600_000),
  /** sigma, jag after rivers and lakes: sigma0·f, jag0·f with f ∈ [0, 1], the channel's 0.5 and 0, the lake's
   * σ·sigmaMul and rim blends toward min(σ, rimSigma) or 0 (never above, never below 0): [0, S]. */
  sigma: bound(0, 500_000),
  jag: bound(0, 500_000),
  /** surfaceEst = offset (`columnStage.ts`, `columnPoint.ts`). */
  surfaceEst: bound(-600_000, 600_000),
  /** islandMask (SP3e spec §2.2, §2.5, `gen/column/islands.ts`): the literal +0 when `islands.enabled` is off; on,
   * smoothstep(lo, hi, u) = t·t·(3 − 2t) with t clamped to [0, 1] (t·t ≥ +0, 3 − 2t ≥ 1), capped by `s > 1 ? 1 : s`,
   * or the literals 0 and 1 of the step when lo ≥ hi: within [0, 1] by construction. */
  islandMask: bound(0, 1),
});

/**
 * The largest density and rules column costs tier 2 accepts (SP3d spec §1.7, `gen/inspect/cost.ts`): 64 × the default
 * trees' (`DEFAULT_DENSITY_TREE` 14,907,917; `DEFAULT_SURFACE_RULES` 163 nodes × 256 × (1 + 51) = 2,169,856, its
 * largest depth bound being a floor `stoneDepth` offset 4 plus SD_MAX's static maximum 47). A unit test recomputes both.
 */
export const DENSITY_COLUMN_COST_MAX = 954_106_688;
export const RULES_COLUMN_COST_MAX = 138_870_784;

/**
 * The slice viewer's sizes and extents (SP3d spec §4.2, `gen/inspect/fieldSlice.ts`): n × n samples, a 32² draft then
 * the 128² slice; a horizontal plane's side E in blocks. Every allowed E and n give integer sample coordinates
 * (E / (2n) ≥ 1 is an integer). Shared by gen, the workers and the UI.
 */
export const SLICE_NS = Object.freeze([32, 128] as const);
export const SLICE_EXTENTS = Object.freeze([256, 512, 1024, 2048, 4096, 8192] as const);

/**
 * The slice work bound (SP3d spec §5.2), in work units of about 14 ns of reference evaluation on one thread
 * (`gen/inspect/cost.ts` `workCost`): the acquisition costs of a sample column's samples — one full ColumnSample per
 * vertical sample column (about 430 µs), one horizontal sample's four corner points (about 26 µs) or with steep (about
 * 64.5 µs, calibrated: 2^13 would leave a 128² horizontal slice no room, 128² × 2^13 = REQUEST_BUDGET) — and the
 * budgets: one part (about 115 ms), a 32² draft and a 128² request in total. One source for gen's `sliceCostOf`, the
 * worker's bound check and the pool's split (`workers/protocol.ts` re-exports them).
 */
export const COLUMN_SAMPLE_COST = 32_768;
export const CORNER_SAMPLE_COST = 2_048;
export const CORNER_STEEP_COST = 5_120;
export const PART_BUDGET = 8_388_608;
export const DRAFT_BUDGET = 16_777_216;
export const REQUEST_BUDGET = 134_217_728;

/** The `rule` slice field's value on a voxel the rules never evaluate (air, water, the bedrock at y −64): n/a (§4.1). */
export const SLICE_RULE_NA = 255;

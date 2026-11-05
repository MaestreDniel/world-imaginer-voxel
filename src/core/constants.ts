/** Bumped whenever generated output changes; goldens and saves are bound to it (§6.2). */
export const GENERATOR_VERSION = 6;

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
  /** wetMask (SP6a spec §1.4, `gen/column/columnPoint.ts` wetMaskOf): the literals 0 and 1, 1 where `surfaceWaterLevel`
   * is finite. */
  wetMask: bound(0, 1),
});

/**
 * The lowest bottom voxel y of an island run (SP3e spec §3.5, §4.1): a maximal solid run of a position whose bottom
 * voxel is at y ≥ 181 lies "above y 180" and is an island run. One constant for water v0's island rule
 * (`gen/pipeline/terrainStage.ts`), the islands surface branch's `minY` and Z3; the floating_islands term puts its
 * island voxels in y 193-263 (SP3e spec §3.2), 12 above it.
 */
export const ISLAND_RUN_MIN_BOTTOM = 181;

/**
 * The largest density and rules column costs tier 2 accepts (SP3d spec §1.7, `gen/inspect/cost.ts`). Density: 64 × the
 * SP3d default tree's 14,907,917, kept as SP6a's cap (SP6a spec D24): about 35 × SP6a's default. Rules: 64 × the
 * default rules' (`DEFAULT_SURFACE_RULES` 163 nodes × 256 × (1 + 51) = 2,169,856, its largest depth bound being a
 * floor `stoneDepth` offset 4 plus SD_MAX's static maximum 47). A unit test pins both.
 */
export const DENSITY_COLUMN_COST_MAX = 954_106_688;
export const RULES_COLUMN_COST_MAX = 138_870_784;

/**
 * The density op `noiseScaled{id, s}`'s scale range (SP6a spec §1.5, D18): z3(x / s, y / s, z / s) with s in
 * [NOISE_SCALE_MIN, NOISE_SCALE_MAX] = [1/16, 16], a literal or a ref whose static range lies inside it
 * (`gen/density/expr.ts`'s `SCALE_RANGE`).
 */
export const NOISE_SCALE_MIN = 1 / 16;
export const NOISE_SCALE_MAX = 16;

/** One spaghetti family's rarity bands (SP6a spec §1.2-§1.3). */
export interface SpaghettiBands {
  /** The family's tap in the default density tree. */
  readonly tap: string;
  /** The rarity noise r (an id under `caves.noises.`) whose band picks the scale. */
  readonly rarity: string;
  /** The noises scaled by the band's scale (`noiseScaled`). */
  readonly noises: readonly string[];
  /** The scale leaves' group: band k's scale is `<scales>.s<k>`. */
  readonly scales: string;
  /** Each band edge e as its blend zone [e − 0.05, e + 0.05), in increasing order: one fewer than the bands. */
  readonly zones: readonly (readonly [lo: number, hi: number])[];
}

/**
 * The rarity bands of the two spaghetti families (SP6a spec §1.2-§1.3), shared by the default tree's builder
 * (`core/params/defaultTrees.ts`) and U2's scale witnesses (`metrics/liveness.ts`): spaghetti 3D's edges −0.5, 0, 0.5 over
 * its scales s0-s3, spaghetti 2D's −0.75, −0.5, 0.5, 0.75 over s0-s4. The zones are literals, so no rounding moves an edge.
 */
export const SPAGHETTI_BANDS: Readonly<Record<'spaghetti3d' | 'spaghetti2d', SpaghettiBands>> = Object.freeze({
  spaghetti3d: Object.freeze({
    tap: 'spag3d', rarity: 'spag3dRarity', noises: Object.freeze(['spag3dA', 'spag3dB']), scales: 'caves.spaghetti3d.scales',
    zones: Object.freeze([bound(-0.55, -0.45), bound(-0.05, 0.05), bound(0.45, 0.55)]),
  }),
  spaghetti2d: Object.freeze({
    tap: 'spag2d', rarity: 'spag2dRarity', noises: Object.freeze(['spag2d']), scales: 'caves.spaghetti2d.scales',
    zones: Object.freeze([bound(-0.8, -0.7), bound(-0.55, -0.45), bound(0.45, 0.55), bound(0.7, 0.8)]),
  }),
});

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

/**
 * The cave kinds of the store's `cave` channel (SP6a spec §3.2, D17, D20): bits 0-3 of the byte, bits 4-7 reserved
 * (0). 0 none (rock, sky and surface air, edits); the noise kinds cheese 1, spaghetti 3D 2, spaghetti 2D 3, noodle 4 and
 * entrance 5, which T writes from the density's family taps; the carver kinds worm 6, ravine 7 and underground worm 8;
 * 9 other density air (pre-cave rock opened by air that no family tap present in the tree explains); 10-14 reserved.
 * Here rather than in `gen/caves/tags.ts`, which exports functions and types only (gen exports no numeric data): gen,
 * mesh, render, the UI and the metrics all read the ids.
 */
export const CAVE_KIND = Object.freeze({
  none: 0, cheese: 1, spaghetti3d: 2, spaghetti2d: 3, noodle: 4, entrance: 5, worm: 6, ravine: 7, undergroundWorm: 8, other: 9,
});
/** The X-ray's surface film (SP6a spec §5.1): a kind in the X-ray pack only, never stored in the `cave` channel. */
export const CAVE_FILM_KIND = 15;

/**
 * The carvers' window (SP6a spec §2.1, D21): a column reads the sources of the chunks within R of its chunk, 23 × 23 =
 * 529. R is the largest integer with 16·R < 16 + L_max + r_max: L_max = 160 (`caves.worms.length`'s and
 * `caves.ravines.lengthMax`' static maximum: each step moves 1 block), r_max = 9.5 (the largest horizontal radius along
 * a path: (1.5 + 3)·2.0 for worms and underground worms, 1.5 + 8 for ravines; a start room sits at the start), so
 * 185.5 and R = 11. Pinned by `test/unit/constants.test.ts` (recomputed from the leaves' static maxima) and by
 * `reachOverflow`. Here rather than in `gen/caves/`, which exports functions and types only (gen exports no numeric data).
 */
export const CARVER_WINDOW_R = 11;
/**
 * The carver path cache's capacity per worker (SP6a spec §2.5): an LRU of 1,024 `CarverPath`s keyed by (kind, sx, sz),
 * at most about 8.2 MB (all ravines), about 5.5 MB typically; a column needs about 124 paths and its neighbours share
 * most of them. A miss recomputes the same path, so the capacity never changes output (`DT1.carverCache`). Here rather
 * than in `gen/caves/carverCache.ts`, which exports functions and types only (gen exports no numeric data).
 */
export const CARVER_CACHE_PATHS = 1024;

/** The `rule` slice field's value on a voxel the rules never evaluate (air, water, the bedrock at y −64): n/a (§4.1). */
export const SLICE_RULE_NA = 255;

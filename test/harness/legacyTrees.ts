/**
 * The legacy default-tree builders, kept as fixtures (SP3d spec §2): `defaultDensityExpr`
 * (`src/gen/density/defaults.ts`) and `defaultSurfaceRules` (`src/gen/surface/defaults.ts`) copied unchanged as at
 * 9fababa, renamed `legacyDefaultDensityExpr` and `legacyDefaultSurfaceRules`. The data defaults of
 * `src/core/params/defaultTrees.ts` resolve to exactly these trees (§2.1, §2.2). SP6b (Task 22) added rule 4 at
 * `root.rules[2]` of `legacyDefaultSurfaceRules` (its spec §3.4), as `DEFAULT_SURFACE_RULES` gained it.
 */
import type { DensityParams, SurfaceParams } from '../../src/core/params/schema';
import type { SurfaceBiome } from '../../src/gen/biomes/registry';
import type { DensityExpr, Expr, SlideKnot } from '../../src/gen/density/expr';
import type { Condition, Rule } from '../../src/gen/surface/rules';

// ---- density (src/gen/density/defaults.ts) ----

const SLIDE: readonly SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const max = (a: Expr, b: Expr): Expr => ({ op: 'max', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });

/** The default density expression of SP3b spec §3.1 for `p` (= `params.density`). Ids are the `density.noises` keys. */
export function legacyDefaultDensityExpr(p: DensityParams): DensityExpr {
  const J: Expr = { op: 'square', x: add(C(1), neg({ op: 'abs', x: mul({ op: 'noise2', id: 'jag' }, C(1 / p.noises.jag.clampSigma)) })) };
  const N3: Expr = { op: 'noise', id: 'overhang' };
  let inner = add({ op: 'col', field: 'offset' }, mul({ op: 'col', field: 'jag' }, J));
  inner = add(inner, neg(Y));
  inner = add(inner, mul({ op: 'col', field: 'sigma' }, { op: 'slide', x: N3, knots: SLIDE }));
  inner = add(inner, mul(C(2), max(C(0), add(C(-56), neg(Y)))));
  inner = add(inner, neg(mul(C(2), max(C(0), add(Y, C(-296))))));
  const terrain: Expr = { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: inner } };
  const e01: Expr = { op: 'clamp', x: mul(add({ op: 'col', field: 'E' }, C(1)), C(0.5)), lo: 0, hi: 1 };
  const amp = add(C(p.detailAmpLo), mul(C(p.detailAmpHi - p.detailAmpLo), e01));
  const detail = mul({ op: 'noise', id: 'detail' }, amp);
  const islands: Expr = { op: 'tap', name: 'islands', x: C(-1e6) };
  return { root: max(add(terrain, detail), islands), defs: {} };
}

// ---- surface rules (src/gen/surface/defaults.ts) ----

/** The bedrock gradient (rule [0]) and the deepslate gradient (rule [3]; [2] before SP6b's rule 4). */
const BEDROCK_LO = -64;
const BEDROCK_HI = -59;
const DEEPSLATE_LO = 0;
const DEEPSLATE_HI = 8;
/** The patch noise's range limits: the clampSigma maximum of every noise leaf (8), so a one-sided range is total. */
const PATCH_LIMIT = 8;
const PATCH_NOISE = 'surface.noises.patch';

const block = (state: string): Rule => ({ kind: 'block', state });
const seq = (...rules: Rule[]): Rule => ({ kind: 'sequence', rules });
/** `if A ∧ B ∧ … → R`: nested conditions, A outermost. */
const when = (conds: readonly Condition[], then: Rule): Rule =>
  conds.reduceRight<Rule>((r, c) => ({ kind: 'condition', if: c, then: r }), then);
const biome = (...biomes: SurfaceBiome[]): Condition => ({ kind: 'biome', biomes });
const not = (c: Condition): Condition => ({ kind: 'not', if: c });
const floor = (offset: number, addSurfaceDepth: boolean): Condition => ({ kind: 'stoneDepth', side: 'floor', offset, addSurfaceDepth });
const water = (offset: number, runTop: boolean): Condition => ({ kind: 'water', offset, runTop });
const gradient = (trueAtAndBelow: number, falseAtAndAbove: number): Condition => ({ kind: 'verticalGradient', trueAtAndBelow, falseAtAndAbove });

/** SP6b's cave patch noise (its spec §3.4) and a `noiseThreshold` on it ([min, max] in z2, ±8 for "no bound"). */
const CAVE_PATCH = 'surface.noises.cavePatch';
const cavePatch = (min: number, max: number): Condition => ({ kind: 'noiseThreshold', noise: CAVE_PATCH, min, max });
const ceiling = (offset: number): Condition => ({ kind: 'stoneDepth', side: 'ceiling', offset, addSurfaceDepth: false });
const caveBiome = (side: 'floor' | 'ceiling' | 'here', ...biomes: ('lush' | 'dripstone' | 'abyss')[]): Condition => ({ kind: 'caveBiome', side, biomes });

/**
 * Rule 4 (SP6b spec §3.4, D21): ash on abyss floors over the abyss's strata (§3.3's default layers), moss two deep with
 * clay patches on lush floors, dripstone two deep with bare stone patches on dripstone floors and ceilings, moss on lush
 * ceilings; every `stoneDepth` without the surface depth (the plan's Spec correction 10).
 */
function rule4(): Rule {
  const floor1 = floor(1, false);
  const bare = not(cavePatch(-PATCH_LIMIT, -0.97));
  const strata: Rule = {
    kind: 'strata',
    layers: [
      { state: 'abyss_stone', weight: 50, maxLen: 8 }, { state: 'abyss_shale', weight: 25, maxLen: 4 },
      { state: 'cracked_abyss_stone', weight: 15, maxLen: 3 }, { state: 'abyss_stone_veined', weight: 10, maxLen: 1 },
    ],
    minLen: 1, maxLen: 6, noise: 'surface.noises.strataOffset', amp: 6,
  };
  return seq(
    when([caveBiome('here', 'abyss')], seq(when([floor1, caveBiome('floor', 'abyss'), cavePatch(-0.84, PATCH_LIMIT)], block('abyss_ash')), strata)),
    when([floor1, caveBiome('floor', 'lush')], seq(when([cavePatch(0.84, PATCH_LIMIT)], block('clay')), block('moss_block'))),
    when([floor1, caveBiome('floor', 'dripstone'), bare], block('dripstone_block')),
    when([ceiling(0), caveBiome('ceiling', 'lush'), cavePatch(-0.52, PATCH_LIMIT)], block('moss_block')),
    when([ceiling(1), caveBiome('ceiling', 'dripstone'), bare], block('dripstone_block')),
  );
}

/** The default rule tree of SP3c spec §4 for `p` (= `params.surface`), with SP6b's rule 4 at `root.rules[2]`. */
export function legacyDefaultSurfaceRules(p: SurfaceParams): Rule {
  const TOP = floor(0, false);
  const SKIN = floor(0, true);
  const BAND4 = floor(4, true);
  const P: Condition = { kind: 'noiseThreshold', noise: PATCH_NOISE, min: p.patchThreshold, max: PATCH_LIMIT };
  const Pn: Condition = { kind: 'noiseThreshold', noise: PATCH_NOISE, min: 0 - PATCH_LIMIT, max: 0 - p.patchThreshold };
  const LAKE: Condition = { kind: 'lake' };

  const underWater = seq(
    when([biome('warm_ocean', 'beach', 'snowy_beach')], block('sand')),
    when([biome('deep_ocean', 'frozen_ocean')], block('gravel')),
    when([biome('river', 'frozen_river', 'swamp'), P], block('clay')),
    when([LAKE, P], block('clay')),
    when([biome('river', 'frozen_river')], block('dirt')),
    when([LAKE, water(-2, true)], block('sand')),
    when([not(water(-10, true))], block('gravel')),
    when([water(-10, false)], block('sand')),
    block('gravel'),
  );
  const cliffs = seq(when([biome('frozen_peaks')], block('packed_ice')), block('stone'));
  const grassy = seq(
    when([biome('taiga', 'snowy_taiga'), P], block('podzol')),
    when([biome('taiga', 'snowy_taiga'), Pn], block('coarse_dirt')),
    when([biome('savanna'), P], block('coarse_dirt')),
    when([biome('jungle'), P], block('podzol')),
    when([biome('swamp'), P], block('mud')),
    when([biome('windswept_hills'), P], block('gravel')),
    when([biome('windswept_hills'), Pn], block('stone')),
    block('grass_block'),
  );
  const palette = seq(
    when([biome('desert', 'beach', 'snowy_beach', 'river', 'frozen_river', 'ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean')], block('sand')),
    when([biome('badlands')], seq(when([TOP], block('red_sand')), { kind: 'bandlands' })),
    when([biome('stony_shore', 'volcano')], seq(when([TOP, P], block('gravel')), block('stone'))),
    when([biome('stony_peaks')], seq(when([TOP, P], block('calcite')), block('stone'))),
    when([biome('frozen_peaks')], seq(when([TOP, P], block('packed_ice')), when([TOP], block('snow_block')), block('stone'))),
    when([biome('snowy_slopes', 'jagged_peaks')], seq(when([TOP], block('snow_block')), block('stone'))),
    when([TOP], grassy),
    block('dirt'),
  );
  const band = seq(
    when([biome('desert', 'beach', 'snowy_beach')], block('sandstone')),
    when([biome('badlands')], block('red_sandstone')),
  );
  const skin = seq(
    when([not(water(0, false)), SKIN], underWater),
    when([{ kind: 'steep', min: p.cliffSteep }, { kind: 'yAbove', minY: p.cliffMinY, runTop: true }, SKIN], cliffs),
    when([TOP, { kind: 'temperatureBelow', t: p.snowline }], block('snow_block')),
    when([SKIN], palette),
    when([BAND4], band),
  );
  return seq(
    when([gradient(BEDROCK_LO, BEDROCK_HI)], block('bedrock')),
    when([{ kind: 'skyOpen' }], skin),
    rule4(),
    when([gradient(DEEPSLATE_LO, DEEPSLATE_HI)], block('deepslate')),
  );
}

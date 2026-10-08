/**
 * The default surface-rule tree (SP3c spec §4), built from `params.surface` as data in §3.1's JSON encoding (every
 * field written, `runTop: false` included). Its order is Decision 6's: [0] bedrock (the −64 … −59 gradient, dithered
 * over −63 … −60), [1] the sky-open surface skin (under water, cliffs, the snowline, the biome palette, the
 * sandstone band), [2] the deepslate gradient (0 … 8, dithered over 1 … 7) for every solid voxel left, then stone.
 *
 * The badlands branch [1][3][1] is `seq[ [0] if TOP → red_sand  [1] bandlands ]` (the band block under the red sand
 * top, §3.3; §9's cut is not taken). `test/fixtures/sp3c-default-rules.json` is this tree at the defaults. The
 * gradient bounds are constants of this module; the parameters are `cliffSteep`, `cliffMinY`,
 * `snowline` and `patchThreshold` (the patch noise is `surface.noises.patch`). A negated parameter is written
 * `0 - t`, which is +0 when t is 0 (−0 is never written, §3.1).
 */
import type { SurfaceParams } from '../../core/params/schema';
import type { SurfaceBiome } from '../biomes/registry';
import type { Condition, Rule } from './rules';

/** The bedrock gradient (rule [0]) and the deepslate gradient (rule [2]). */
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

/** The default rule tree of SP3c spec §4 for `p` (= `params.surface`). */
export function defaultSurfaceRules(p: SurfaceParams): Rule {
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
    when([gradient(DEEPSLATE_LO, DEEPSLATE_HI)], block('deepslate')),
  );
}

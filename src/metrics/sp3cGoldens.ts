/**
 * SP3c golden digests (SP3c spec §2.2, §7), world seed '42', default profile.
 * - `sp3c.registry`: SP3a §6.4's registry byte stream over the terrain palette, states 3 … 24 (a fixed count, so
 *   appended states never change it; `sp3a.registry` keeps states 0 … 2).
 * - `sp3c.surface.ops`: the compiled rule results of a frozen fixture tree (`surfaceOpsRules`) that uses every rule
 *   kind and every condition kind of §3.1 (`lake` and `bandlands` included), over every voxel of a frozen column list
 *   (`surfaceOpsColumns`). Each column is rebuilt the way the T stage builds it (density fill, water v0, the per-block
 *   biome buffer, the §3.2 scan: `surfaceProbeColumn` on a SurfaceContext of the fixture tree) and the compiled tree
 *   fills it with the fast path (`fillColumn(…, true)`, as the stage does; the fixture has one). Per column in list
 *   order, its 98,304 entries in the stage's `256·(y + 64) + p` order (p = lz·16 + lx); an entry the rules do not write
 *   (a non-solid voxel, y −64) is 0xffff. Hashed as u16 LE with FNV-1a 64.
 * Chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`) after SP3b's, so the unit tests, `?selftest=1`
 * and `test/tools/goldensJsc.ts` all check them. Follows the core determinism rules (in `DET_FILES`, arch-tested).
 * Every value is hex64.
 */
import { createFnv64, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { seedFromInput } from '../core/seed';
import { createGenContext } from '../gen/context';
import type { SurfaceBiome } from '../gen/biomes/registry';
import { createSurfaceContext } from '../gen/surface/context';
import { surfaceProbeColumn } from '../gen/surface/probe';
import type { Condition, Rule } from '../gen/surface/rules';
import { REGISTRY } from '../world/blocks/index';
import type { BlockRegistry as BlockRegistryT } from '../world/blocks/registry';
import { registryStatesDigest } from './sp3aGoldens';

const CREATE_FNV = createFnv64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const CREATE_SC = createSurfaceContext;
const PROBE_COLUMN = surfaceProbeColumn;
const REG = REGISTRY;
const STATES_DIGEST = registryStatesDigest;

/** The terrain palette: states 3 … 24 (SP3c spec §2.1). */
const SP3C_FIRST_STATE = 3;
const SP3C_STATES = 22;
const VOXELS = 98304;
const UNWRITTEN = 0xffff;

/**
 * The fixture columns (cx, cz), seed '42', default profile: dry land (−1963, −2000), open sea (−2000, −2000), a lake
 * (−1001, −2000), a river channel (−742, −2000) and runs without sky under water-line overhangs (−1238, −2000) (the T
 * stage's test fixtures, SP3a/SP3b); a desert (610, −1024) and frozen_peaks with steep tops and overhangs (−495, −1008)
 * (the surface-pass test columns, SP3c Task 9); badlands (−26426, −31088) (U2's badlands class column, §3.5).
 */
const OPS_COLUMNS: ReadonlyArray<readonly [number, number]> = [
  [-1963, -2000], [-2000, -2000], [-1001, -2000], [-742, -2000], [-1238, -2000], [610, -1024], [-495, -1008], [-26426, -31088],
];

const ctx42 = () => CREATE_CTX(SEED('42'), RESOLVE('default'));

const block = (state: string): Rule => ({ kind: 'block', state });
const seq = (...rules: Rule[]): Rule => ({ kind: 'sequence', rules });
/** `if A ∧ B ∧ … → R`: nested conditions, A outermost (SP3c spec §4's notation). */
const when = (conds: readonly Condition[], then: Rule): Rule =>
  conds.reduceRight<Rule>((r, c) => ({ kind: 'condition', if: c, then: r }), then);
const biome = (...biomes: SurfaceBiome[]): Condition => ({ kind: 'biome', biomes });
const not = (c: Condition): Condition => ({ kind: 'not', if: c });
const floor = (offset: number, addSurfaceDepth: boolean): Condition => ({ kind: 'stoneDepth', side: 'floor', offset, addSurfaceDepth });
const ceiling = (offset: number, addSurfaceDepth: boolean): Condition => ({ kind: 'stoneDepth', side: 'ceiling', offset, addSurfaceDepth });
const water = (offset: number, runTop: boolean): Condition => ({ kind: 'water', offset, runTop });
const yAbove = (minY: number, runTop: boolean): Condition => ({ kind: 'yAbove', minY, runTop });
const gradient = (trueAtAndBelow: number, falseAtAndAbove: number): Condition => ({ kind: 'verticalGradient', trueAtAndBelow, falseAtAndAbove });
const noise = (id: string, min: number, max: number): Condition => ({ kind: 'noiseThreshold', noise: `surface.noises.${id}`, min, max });
const SKY: Condition = { kind: 'skyOpen' };
const LAKE: Condition = { kind: 'lake' };

/**
 * The frozen `sp3c.surface.ops` fixture tree (a fresh object per call), in §4's notation:
 * ```
 * root: seq[
 *  [0] if verticalGradient{−64, −61} → bedrock                                         # Y-only
 *  [1] if skyOpen ∧ stoneDepth{floor 2, +surfaceDepth} → seq[                         # depth-bounded, sky-gated
 *    [0] if not{water{0, runTop false}} → seq[ [0] if lake ∧ noiseThreshold{patch −0.5 … 8} → clay
 *                                             [1] if water{−3, runTop true} → sand  [2] gravel ]
 *    [1] if steep{1} ∧ yAbove{90, runTop true} → seq[ [0] if biome{frozen_peaks, jagged_peaks} → packed_ice  [1] stone ]
 *    [2] if biome{badlands} → seq[ [0] if stoneDepth{floor 0} → red_sand  [1] bandlands ]
 *    [3] if stoneDepth{floor 0} → seq[ [0] if temperatureBelow{−0.45} → snow_block
 *                                     [1] if noiseThreshold{depth 0.8 … 8} → coarse_dirt
 *                                     [2] if not{yAbove{70, runTop false}} → sand  [3] grass_block ]
 *    [4] if biome{desert, beach} → sandstone
 *    [5] dirt ]
 *  [2] if not{skyOpen} ∧ stoneDepth{floor 4} ∧ stoneDepth{ceiling 6} → mud             # depth-bounded, not sky-gated
 *  [3] if verticalGradient{0, 8} → deepslate                                            # Y-only
 *  [4] if yAbove{200, runTop false} → calcite ]                                         # Y-only (a band cut at 200)
 * ```
 * Every leaf is depth-bounded or Y-only, so the tree has a fast path (maxSurfaceDepth 2 + SD_MAX), not sky-gated.
 */
export function surfaceOpsRules(): Rule {
  const TOP = floor(0, false);
  return seq(
    when([gradient(-64, -61)], block('bedrock')),
    when([SKY, floor(2, true)], seq(
      when([not(water(0, false))], seq(
        when([LAKE, noise('patch', -0.5, 8)], block('clay')),
        when([water(-3, true)], block('sand')),
        block('gravel'),
      )),
      when([{ kind: 'steep', min: 1 }, yAbove(90, true)], seq(when([biome('frozen_peaks', 'jagged_peaks')], block('packed_ice')), block('stone'))),
      when([biome('badlands')], seq(when([TOP], block('red_sand')), { kind: 'bandlands' })),
      when([TOP], seq(
        when([{ kind: 'temperatureBelow', t: -0.45 }], block('snow_block')),
        when([noise('depth', 0.8, 8)], block('coarse_dirt')),
        when([not(yAbove(70, false))], block('sand')),
        block('grass_block'),
      )),
      when([biome('desert', 'beach')], block('sandstone')),
      block('dirt'),
    )),
    when([not(SKY), floor(4, false), ceiling(6, false)], block('mud')),
    when([gradient(0, 8)], block('deepslate')),
    when([yAbove(200, false)], block('calcite')),
  );
}

/** The fixture columns (cx, cz), in hashing order (a fresh array per call). */
export function surfaceOpsColumns(): Array<[number, number]> {
  return OPS_COLUMNS.map(([cx, cz]) => [cx, cz]);
}

/** The compiled fixture tree's states over every voxel of the fixture columns (0xffff where the rules do not write). */
export function surfaceOpsValues(): Uint16Array {
  const sc = CREATE_SC(ctx42(), surfaceOpsRules());
  const out = new Uint16Array(OPS_COLUMNS.length * VOXELS);
  const column = new Uint16Array(VOXELS);
  for (let n = 0; n < OPS_COLUMNS.length; n++) {
    const [cx, cz] = OPS_COLUMNS[n]!;
    column.fill(UNWRITTEN);
    sc.compiled.fillColumn(PROBE_COLUMN(sc, cx, cz).scan, column, true);
    out.set(column, n * VOXELS);
  }
  return out;
}

/** `sp3c.registry`: SP3a §6.4's byte stream over states 3 … 24 of `reg`; a RangeError when it has fewer states. */
export function sp3cRegistryDigest(reg: BlockRegistryT = REG): string {
  return STATES_DIGEST(reg, SP3C_FIRST_STATE, SP3C_STATES);
}

export function sp3cGoldenKeys(): string[] {
  return ['sp3c.registry', 'sp3c.surface.ops'];
}

export function computeSp3cGolden(key: string): string {
  if (key === 'sp3c.registry') return sp3cRegistryDigest();
  if (key === 'sp3c.surface.ops') {
    const values = surfaceOpsValues();
    const fnv = CREATE_FNV();
    for (let i = 0; i < values.length; i++) fnv.updateU16LE(values[i]!);
    return HEX64(fnv.digest());
  }
  throw new Error(`unknown golden ${key}`);
}

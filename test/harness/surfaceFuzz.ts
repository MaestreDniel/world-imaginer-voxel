/**
 * Random valid surface-rule trees and random hand-built columns for the compile / reference / fast-path fuzz (SP3c
 * spec §3.4, §8).
 *
 * Trees (`randomSurfaceRules`) use every rule kind and condition kind of §3.1 with values aimed at the columns below
 * (y bounds over the whole height and its edges, gradients with and without a dither interval, offsets around the
 * skin depths, thresholds inside the noises' ranges and at their clamps); they are valid by construction (no −0,
 * integers in range, min ≤ max, trueAtAndBelow < falseAtAndAbove, nesting ≤ `maxDepth` ≤ 32). Three styles:
 * - 'free': any condition anywhere (the fast path is almost always off);
 * - 'fastPath': a root sequence of branches whose every leaf is depth-bounded (a `stoneDepth{side floor}` not under a
 *   `not` on its path) or Y-only (only `verticalGradient`, `yAbove{runTop false}` and `not`s of these on its path), in
 *   random order, so Y-only leaves come before and after depth-bounded ones; `skyGated` true gates every depth-bounded
 *   branch with a `skyOpen`, false never does (and draws no `skyOpen` inside it), undefined decides per branch;
 * - 'nearMiss': a 'fastPath' tree plus one branch, at a random place, whose leaf is neither (the fast path must be off).
 *
 * Columns (`randomSurfaceColumn`) are hand-built ColumnSamples (random T and steep corners, some finite lake corners)
 * with solidity and water in the T stage's order: ground resting on the bedrock at a per-column height regime (deep
 * floors below y 0, the 1 … 7 dither band, sea level, mountains, the world top), empty positions, floating runs,
 * cave pockets (runs without sky close under their top, sometimes flooded), water directly above, above a gap and in
 * two segments. Everything is drawn from a u32 stream (`testRng`), so a seed reproduces it.
 */
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import type { Seed64 } from '../../src/core/hash';
import { LEVEL_FIELDS, newColumnSample, SAMPLE_FIELDS, type ColumnSample } from '../../src/gen/column/columnStage';
import { SURFACE_BIOMES, type SurfaceBiome } from '../../src/gen/biomes/registry';
import { ruleLeaves, type Condition, type Rule, type SurfaceNoise, type SurfaceNoiseSource } from '../../src/gen/surface/rules';
import { surfaceScanSettings, type SurfaceScanParams, type SurfaceScanSettings } from '../../src/gen/surface/scan';
import { REGISTRY } from '../../src/world/blocks/index';
import { testFloat } from './stats';

export interface SurfaceFuzzNoiseSpec { readonly id: string; readonly def: NoiseDef }

/** The fuzz's surface noises (2D, remap none): the depth noise the scan needs and two for `noiseThreshold`. */
export const SURFACE_FUZZ_NOISE_SPECS: readonly SurfaceFuzzNoiseSpec[] = [
  { id: 'surface.noises.depth', def: completeNoiseDef({ wavelength: 16, octaves: 2 }) },
  { id: 'surface.noises.patch', def: completeNoiseDef({ wavelength: 8, octaves: 1 }) },
  { id: 'surface.noises.fuzzB', def: completeNoiseDef({ wavelength: 32, octaves: 2, clampSigma: 2 }) },
];

/** The schema paths of the fuzz noises a tree may name. */
export const SURFACE_FUZZ_NOISES: readonly string[] = SURFACE_FUZZ_NOISE_SPECS.map((n) => n.id);

/** The fuzz noises as a SurfaceNoiseSource (each seeded by its schema path under `seed`). */
export function surfaceFuzzNoiseSource(seed: Seed64 = [0x5eed, 0x3c]): SurfaceNoiseSource {
  const m = new Map<string, SurfaceNoise>();
  for (const { id, def } of SURFACE_FUZZ_NOISE_SPECS) {
    const n = new NormalNoise(seed, id, def);
    m.set(id, { dims: 2, remap: 'none', clampSigma: def.clampSigma, z2: (x, z) => n.z2(x, z) });
  }
  return (name) => m.get(name);
}

/** The `surface` defaults the scan reads (§3.5). */
export const SURFACE_FUZZ_PARAMS: SurfaceScanParams = { depthMul: 1, lapse: 0.006, lapseBase: 80 };

/** Random scan parameters on the schema's grids: depthMul 0 … 2 by 0.05, lapse 0 … 0.05 by 0.0005, lapseBase −64 … 319. */
export function randomSurfaceParams(next: () => number): SurfaceScanParams {
  return { depthMul: (next() % 41) * 0.05, lapse: (next() % 101) * 0.0005, lapseBase: -64 + (next() % 384) };
}

/** Scan settings over the fuzz noises. */
export function surfaceFuzzSettings(
  seed: Seed64 = [0x5eed, 0x3c], params: SurfaceScanParams = SURFACE_FUZZ_PARAMS, noises: SurfaceNoiseSource = surfaceFuzzNoiseSource(seed),
): SurfaceScanSettings {
  return surfaceScanSettings(seed, params, noises);
}

/** The biomes trees and columns draw from by default: a few of each family, so biome conditions hit both ways. */
export const SURFACE_FUZZ_BIOMES: readonly SurfaceBiome[] = ['ocean', 'beach', 'river', 'plains', 'desert', 'badlands', 'frozen_peaks'];

/** A hand-built column: its sample, solidity and water (98,304 entries, `256·(y + 64) + p`) and its 256 surface biome ids. */
export interface SurfaceFuzzColumn {
  readonly sample: ColumnSample;
  readonly solid: Uint8Array;
  readonly water: Uint8Array;
  readonly biomes: Uint8Array;
}

export interface SurfaceColumnOptions {
  /** Biomes the positions draw from (default SURFACE_FUZZ_BIOMES). */
  readonly biomes?: readonly SurfaceBiome[];
}

const VOXELS = 98304;
const at = (p: number, y: number): number => 256 * (y + 64) + p;
const clampY = (y: number): number => (y < -63 ? -63 : y > 319 ? 319 : y);

/** Ground-height regimes: [lowest, highest] base top. */
const REGIMES: readonly (readonly [number, number])[] = [
  [-63, -40], [-40, -1], [-6, 12], [0, 30], [40, 75], [60, 100], [100, 220], [280, 319],
];

/** A random hand-built column (see the module comment). */
export function randomSurfaceColumn(next: () => number, opts: SurfaceColumnOptions = {}): SurfaceFuzzColumn {
  const pool = opts.biomes ?? SURFACE_FUZZ_BIOMES;
  const s = newColumnSample();
  s.cx = (next() % 65536) - 32768;
  s.cz = (next() % 65536) - 32768;
  for (const f of SAMPLE_FIELDS) s.f[f].fill(0);
  for (const f of LEVEL_FIELDS) s.f[f].fill(-Infinity);
  const tMid = 2 * testFloat(next) - 1;
  for (let k = 0; k < 49; k++) {
    s.f.T[k] = tMid + 0.6 * (testFloat(next) - 0.5);
    s.f.steep[k] = 3 * testFloat(next);
    if (next() % 3 === 0) s.f.lakeLevel[k] = 50 + (next() % 30);
  }
  const ids = pool.map((b) => SURFACE_BIOMES.indexOf(b));
  const palette = Array.from({ length: 1 + (next() % Math.min(4, ids.length)) }, () => ids[next() % ids.length]!);
  const biomes = new Uint8Array(256);
  for (let p = 0; p < 256; p++) biomes[p] = palette[next() % palette.length]!;

  const solid = new Uint8Array(VOXELS);
  const water = new Uint8Array(VOXELS);
  const fill = (a: Uint8Array, p: number, y0: number, y1: number, v: number) => {
    for (let y = Math.max(-63, y0); y <= Math.min(319, y1); y++) a[at(p, y)] = v;
  };
  const [lo, hi] = REGIMES[next() % REGIMES.length]!;
  const base = lo + (next() % (hi - lo + 1));
  const rough = 1 + (next() % 8);
  const flooded = next() % 2 === 0;
  const waterLevel = clampY(base + (next() % 24) - 4);
  for (let p = 0; p < 256; p++) {
    solid[at(p, -64)] = 1;
    if (next() % 12 === 0) continue; // an empty position: only the stage's bedrock
    const top = clampY(base + (next() % (2 * rough + 1)) - rough);
    fill(solid, p, -63, top, 1);
    // A cave pocket a few voxels under the top: the run below it has no sky and its top lies close under the surface.
    if (next() % 4 === 0 && top > -55) {
      const roof = 1 + (next() % 12);
      const height = 1 + (next() % 6);
      fill(solid, p, top - roof - height + 1, top - roof, 0);
      if (next() % 3 === 0) fill(water, p, top - roof - height + 1, top - roof - (next() % height), 1);
    }
    let cover = top;
    if (flooded && top < waterLevel) {
      const gap = next() % 5 === 0 ? 1 + (next() % 2) : 0;
      fill(water, p, top + 1 + gap, waterLevel, 1);
      // An air voxel inside the water: the run's waterTop is the top of the lower segment.
      if (next() % 6 === 0 && waterLevel - top > 4) {
        const yAir = top + 2 + gap + (next() % (waterLevel - top - 3));
        fill(water, p, yAir, yAir, 0);
      }
      cover = waterLevel;
    }
    // Floating runs (overhangs) above the ground or the water, sometimes with water resting on them.
    let floor = cover;
    for (let k = next() % 7 < 2 ? 1 + (next() % 2) : 0; k > 0 && floor < 316; k--) {
      const bottom = floor + 2 + (next() % 10);
      const t = Math.min(319, bottom + (next() % 12));
      fill(solid, p, bottom, t, 1);
      floor = t;
      if (next() % 4 === 0 && t < 318) {
        const w = Math.min(319, t + 1 + (next() % 4));
        fill(water, p, t + 1, w, 1);
        floor = w;
      }
    }
  }
  return { sample: s, solid, water, biomes };
}

export type SurfaceFuzzStyle = 'free' | 'fastPath' | 'nearMiss';

export interface SurfaceRulesOptions {
  /** 'free' (default), 'fastPath' or 'nearMiss' (see the module comment). */
  readonly style?: SurfaceFuzzStyle;
  /** Maximum nesting depth of a free subtree, rules and conditions counted (default 7). */
  readonly maxDepth?: number;
  /** 'fastPath' / 'nearMiss': true gates every depth-bounded branch with skyOpen, false none, undefined per branch. */
  readonly skyGated?: boolean;
  /** Biomes a `biome` condition draws from (default SURFACE_FUZZ_BIOMES). */
  readonly biomes?: readonly SurfaceBiome[];
  /** Noise schema paths a `noiseThreshold` draws from (default SURFACE_FUZZ_NOISES). */
  readonly noises?: readonly string[];
}

/** y values where rules and columns meet: the bedrock, the dither bands, sea level and the world top. */
const Y_POINTS: readonly number[] = [-64, -63, -60, -59, 0, 1, 7, 8, 63, 64, 80, 319, 320];
const THRESHOLDS: readonly number[] = [-8, -3, -2, -0.55, 0, 0.55, 1.5, 2, 3, 8];
/** +0 for a zero (a product or a difference can give −0, which validateRules rejects). */
const plus0 = (v: number): number => (v === 0 ? 0 : v);

/** A random valid surface-rule tree drawn from `next` (u32 stream, e.g. testRng). */
export function randomSurfaceRules(next: () => number, opts: SurfaceRulesOptions = {}): Rule {
  const style = opts.style ?? 'free';
  const maxDepth = opts.maxDepth ?? 7;
  const biomes = opts.biomes ?? SURFACE_FUZZ_BIOMES;
  const noises = opts.noises ?? SURFACE_FUZZ_NOISES;
  if (maxDepth < 3 || maxDepth > 24) throw new RangeError(`randomSurfaceRules: maxDepth ${maxDepth} is outside 3 … 24`);
  const pick = <T>(xs: readonly T[]): T => xs[next() % xs.length]!;
  const bool = (): boolean => next() % 2 === 0;
  const yValue = (): number => (bool() ? pick(Y_POINTS) + (next() % 3) - 1 : -64 + (next() % 385));
  const threshold = (): number => (next() % 3 === 0 ? pick(THRESHOLDS) : plus0(Math.round((testFloat(next) - 0.5) * 700) / 100));

  const block = (): Rule => ({ kind: 'block', state: REGISTRY.stateKey(1 + (next() % (REGISTRY.stateCount - 1))) });

  const gradient = (): Condition => {
    const lo = bool() ? pick(Y_POINTS) - (next() % 3) : -66 + (next() % 380);
    return { kind: 'verticalGradient', trueAtAndBelow: lo, falseAtAndAbove: lo + 1 + (next() % 12) };
  };
  const floorDepth = (): Condition => ({ kind: 'stoneDepth', side: 'floor', offset: next() % 4 === 0 ? (next() % 21) - 2 : next() % 6, addSurfaceDepth: bool() });

  /** A condition at nesting depth `depth`, any kind (no skyOpen, also inside a not, when `noSky`). */
  const condition = (depth: number, noSky = false): Condition => {
    for (;;) {
      switch (next() % 11) {
        case 0: {
          const n = 1 + (next() % 3);
          return { kind: 'biome', biomes: Array.from({ length: n }, () => pick(biomes)) };
        }
        case 1: return next() % 4 === 0 ? { ...floorDepth(), side: 'ceiling' } as Condition : floorDepth();
        case 2: return { kind: 'water', offset: (next() % 17) - 12, runTop: bool() };
        case 3: return { kind: 'yAbove', minY: yValue(), runTop: bool() };
        case 4: return gradient();
        case 5: return { kind: 'steep', min: plus0(Math.round(testFloat(next) * 300) / 100) };
        case 6: {
          const a = threshold(), b = next() % 8 === 0 ? a : threshold();
          return { kind: 'noiseThreshold', noise: pick(noises), min: Math.min(a, b), max: Math.max(a, b) };
        }
        case 7: return { kind: 'temperatureBelow', t: plus0(Math.round((testFloat(next) - 0.5) * 240) / 100) };
        case 8: if (!noSky) return { kind: 'skyOpen' }; break;
        case 9: return { kind: 'lake' };
        default: if (depth < maxDepth) return { kind: 'not', if: condition(depth + 1, noSky) }; break;
      }
    }
  };

  /** A Y-only condition: a gradient, a yAbove{runTop false}, or a not of one. */
  const yOnly = (depth: number): Condition => {
    const c: Condition = bool() ? gradient() : { kind: 'yAbove', minY: yValue(), runTop: false };
    return depth < maxDepth && next() % 4 === 0 ? { kind: 'not', if: c } : c;
  };

  /** A rule at nesting depth `depth` whose conditions come from `cond`. */
  const rule = (depth: number, cond: (d: number) => Condition): Rule => {
    if (depth >= maxDepth - 1 || (depth > 1 && next() % 4 === 0)) return block();
    if (next() % 3 === 0) {
      const n = next() % 4;
      return { kind: 'sequence', rules: Array.from({ length: n }, () => rule(depth + 1, cond)) };
    }
    return { kind: 'condition', if: cond(depth + 1), then: rule(depth + 1, cond) };
  };

  if (style === 'free') return rule(1, condition);

  /** Wraps `inner` (at depth d + gates.length) in a chain of condition rules, the first gate outermost. */
  const chain = (gates: readonly Condition[], inner: Rule): Rule => {
    let r = inner;
    for (let i = gates.length - 1; i >= 0; i--) r = { kind: 'condition', if: gates[i]!, then: r };
    return r;
  };
  /** A branch whose every leaf is depth-bounded: a gate chain holding a floor stoneDepth (and skyOpen when sky-gated). */
  const depthBounded = (): Rule => {
    const gates: Condition[] = [floorDepth()];
    const sky = opts.skyGated ?? bool();
    if (sky) gates.splice(next() % 2, 0, { kind: 'skyOpen' });
    const cond = (d: number): Condition => condition(d, !sky);
    for (let k = next() % 3; k > 0; k--) gates.splice(next() % (gates.length + 1), 0, cond(maxDepth));
    // Sometimes nested under Y-only gates (a Y-only condition on a depth-bounded path cuts nothing).
    if (next() % 4 === 0) gates.unshift(yOnly(maxDepth));
    const inner = rule(2 + gates.length, cond);
    // A subtree without a leaf (empty sequences) would leave the branch with nothing depth-bounded: add a block.
    return chain(gates, ruleLeaves(inner).length > 0 ? inner : { kind: 'sequence', rules: [inner, block()] });
  };
  const yBranch = (): Rule => rule(2, yOnly);
  /** A branch whose leaf is neither depth-bounded nor Y-only. */
  const offPath = (): Rule => {
    const bad: Condition[] = [
      { kind: 'not', if: floorDepth() },
      { ...floorDepth(), side: 'ceiling' } as Condition,
      { kind: 'yAbove', minY: yValue(), runTop: true },
      { kind: 'biome', biomes: [pick(biomes)] },
      { kind: 'skyOpen' },
      { kind: 'water', offset: (next() % 17) - 12, runTop: bool() },
      { kind: 'lake' },
    ];
    const gates = [pick(bad)];
    if (bool()) gates.splice(next() % 2, 0, yOnly(maxDepth));
    return chain(gates, block());
  };

  const branches: Rule[] = [];
  const n = 2 + (next() % 4);
  let depthCount = 0;
  for (let i = 0; i < n; i++) {
    const d = i === n - 1 && depthCount === 0 ? true : next() % 2 === 0;
    if (d) depthCount++;
    branches.push(d ? depthBounded() : yBranch());
  }
  if (branches.length === depthCount) branches.splice(next() % (branches.length + 1), 0, yBranch());
  if (style === 'nearMiss') branches.splice(next() % (branches.length + 1), 0, offPath());
  return { kind: 'sequence', rules: branches };
}

/** `key` when it is a registered canonical state key, else `standIn`. */
export function registeredKey(key: string, standIn = 'bedrock'): string {
  try {
    REGISTRY.parseStateKey(key);
    return key;
  } catch {
    return standIn;
  }
}

/**
 * A deep copy of the rule tree `rules` whose `block` keys the registry lacks are replaced by `standIn` (rule ids and
 * conditions unchanged). On a branch without the SP3c palette it lets the real default tree (§4) compile with the
 * three SP3a states; once the palette is registered it is an exact copy, so the same tests then run the real tree.
 */
export function withRegisteredBlocks(rules: unknown, standIn = 'bedrock'): unknown {
  if (Array.isArray(rules)) return rules.map((r: unknown) => withRegisteredBlocks(r, standIn));
  if (typeof rules !== 'object' || rules === null) return rules;
  const o = rules as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = withRegisteredBlocks(o[k], standIn);
  if (o['kind'] === 'block' && typeof o['state'] === 'string') out['state'] = registeredKey(o['state'], standIn);
  return out;
}

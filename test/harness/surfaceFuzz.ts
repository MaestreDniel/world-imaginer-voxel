/**
 * Random valid surface-rule trees and random hand-built columns for the compile / reference / fast-path fuzz (SP3c
 * spec §3.4, §8).
 *
 * Trees (`randomSurfaceRules`) use every rule kind (one leaf in 8 is a `bandlands`, one in 16 a `strata`: 1-4 layers or,
 * one time in 8, 1-16, of any solid states, weights and lengths, on any of the trees' noises, amp 0 … 16, SP6b spec §3.3)
 * and condition kind of §3.1 (and SP6b's `caveBiome`, every side and any list of 1-4 distinct cave biomes, SP6b spec
 * §3.2) with
 * values aimed at the columns below
 * (y bounds over the whole height and its edges, gradients with and without a dither interval, offsets around the
 * skin depths, thresholds inside the noises' ranges and at their clamps); they are valid by construction (no −0,
 * integers in range, min ≤ max, trueAtAndBelow < falseAtAndAbove, nesting ≤ `maxDepth` ≤ 32). Three styles:
 * - 'free': any condition anywhere (the fast path is almost always off);
 * - 'fastPath': a root sequence of branches whose every leaf is depth-bounded (a `stoneDepth{side floor}` not under a
 *   `not` on its path) or Y-only (only `verticalGradient`, `yAbove{runTop false}` and `not`s of these on its path), in
 *   random order, so Y-only leaves come before and after depth-bounded ones; `skyGated` true gates every depth-bounded
 *   branch with a `skyOpen`, false never does (and draws no `skyOpen` inside it), undefined decides per branch; with
 *   `ceilingGates`, a depth-bounded branch's own gate is a `stoneDepth{side ceiling}` one time in 2 (its leaves are
 *   ceiling-bounded unless a floor gate is drawn inside it, SP6b spec §3.5);
 * - 'nearMiss': a 'fastPath' tree plus one branch, at a random place, whose leaf is in no class: neither depth-bounded,
 *   ceiling-bounded nor Y-only (the fast path must be off).
 *
 * Columns (`randomSurfaceColumn`) are hand-built ColumnSamples (random T and steep corners, some finite lake corners)
 * with solidity and water in the T stage's order: ground resting on the bedrock at a per-column height regime (deep
 * floors below y 0, the 1 … 7 dither band, sea level, mountains, the world top), empty positions, floating runs,
 * cave pockets (runs without sky close under their top, sometimes flooded), water directly above, above a gap and in
 * two segments. Everything is drawn from a u32 stream (`testRng`), so a seed reproduces it. `withCaveBiomes` gives a
 * column a cave channel and a cave picker (SP6b spec §3.1-§3.2) from a stream of its own: tagged cave air (any kind,
 * the nibble the picker's or another biome, now and then a kind-0 byte with a nibble), cave entrances above some tops,
 * and a hand-filled column pass whose climate regimes and depth origins make every cave biome occur at the column's
 * heights. `caveBiomeHandColumn` is the fixed column of the D18 cases (a plain cave over lush rock, a bedrock-resting
 * run).
 */
import { CAVE_BIOME_NAMES, type CaveBiomeName } from '../../src/core/constants';
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import type { Seed64 } from '../../src/core/hash';
import { LEVEL_FIELDS, newColumnSample, SAMPLE_FIELDS, type ColumnSample } from '../../src/gen/column/columnStage';
import { SURFACE_BIOMES, type SurfaceBiome } from '../../src/gen/biomes/registry';
import type { CaveBiomeSettings } from '../../src/gen/biomes/caveRegistry';
import { caveBiomeOfPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs } from '../../src/gen/biomes/cavePicker';
import { ruleLeaves, type Condition, type Rule, type SurfaceNoise, type SurfaceNoiseSource } from '../../src/gen/surface/rules';
import { surfaceScanSettings, type SurfaceScanParams, type SurfaceScanSettings } from '../../src/gen/surface/scan';
import { SCHEMA } from '../../src/core/params/schema';
import { COLLIDE, REGISTRY } from '../../src/world/blocks/index';
import { COLLIDE_NONE } from '../../src/world/blocks/kinds';
import { testFloat, testRng } from './stats';

export interface SurfaceFuzzNoiseSpec { readonly id: string; readonly def: NoiseDef }

/**
 * The fuzz's surface noises (2D, remap none): the depth noise the scan needs, two for `noiseThreshold` and the band
 * offset noise `bandlands` needs (short wavelength, so the offset changes within a column).
 */
export const SURFACE_FUZZ_NOISE_SPECS: readonly SurfaceFuzzNoiseSpec[] = [
  { id: 'surface.noises.depth', def: completeNoiseDef({ wavelength: 16, octaves: 2 }) },
  { id: 'surface.noises.patch', def: completeNoiseDef({ wavelength: 8, octaves: 1 }) },
  { id: 'surface.noises.fuzzB', def: completeNoiseDef({ wavelength: 32, octaves: 2, clampSigma: 2 }) },
  { id: 'surface.noises.bandOffset', def: completeNoiseDef({ wavelength: 12, octaves: 1 }) },
];

/** The schema paths of the fuzz noises a `noiseThreshold` may name (the band offset noise is `bandlands`'). */
export const SURFACE_FUZZ_NOISES: readonly string[] = SURFACE_FUZZ_NOISE_SPECS.map((n) => n.id).filter((id) => id !== 'surface.noises.bandOffset');

/**
 * The schema's surface noises (every `surface.noises.*` leaf, by path), for `randomSurfaceRules`' `noises` when a tree
 * must pass tier 2 as a `surface.rules` value (SP3d spec §10: `surface.noises.fuzzB` is not a schema noise, so tier 2
 * refuses it as `UNKNOWN_NOISE`); evaluated through the GenContext's `surfaceNoiseSource`.
 */
export const SCHEMA_SURFACE_NOISES: readonly string[] = SCHEMA.leaves
  .filter((l) => l.leaf.kind === 'noise' && l.path.startsWith('surface.noises.'))
  .map((l) => l.path);

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

/** A column's cave picker and its filled pass, as `scanColumn` takes them (SP6b spec §3.2). */
export interface SurfaceFuzzCave {
  readonly inputs: CavePickerInputs;
  readonly pass: CaveColumnPass;
}

/**
 * A hand-built column: its sample, solidity and water (98,304 entries, `256·(y + 64) + p`) and its 256 surface biome
 * ids; with cave biomes (`withCaveBiomes`), its cave channel (kind in bits 0-3, cave biome in bits 4-7) and picker.
 */
export interface SurfaceFuzzColumn {
  readonly sample: ColumnSample;
  readonly solid: Uint8Array;
  readonly water: Uint8Array;
  readonly biomes: Uint8Array;
  readonly tags?: Uint8Array;
  readonly cave?: SurfaceFuzzCave;
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
  /**
   * 'fastPath' / 'nearMiss': a depth-bounded branch's own gate is a ceiling `stoneDepth` one time in 2 (default false,
   * which draws nothing for it, so the trees without it are unchanged; SP6b spec §3.5).
   */
  readonly ceilingGates?: boolean;
  /** Biomes a `biome` condition draws from (default SURFACE_FUZZ_BIOMES). */
  readonly biomes?: readonly SurfaceBiome[];
  /** Noise schema paths a `noiseThreshold` draws from (default SURFACE_FUZZ_NOISES). */
  readonly noises?: readonly string[];
}

/** y values where rules and columns meet: the bedrock, the dither bands, sea level and the world top. */
const Y_POINTS: readonly number[] = [-64, -63, -60, -59, 0, 1, 7, 8, 63, 64, 80, 319, 320];
const THRESHOLDS: readonly number[] = [-8, -3, -2, -0.55, 0, 0.55, 1.5, 2, 3, 8];
/** The keys of every registered state that collides (not air, torches or ladders), in state order. */
const SOLID_KEYS: readonly string[] = Array.from({ length: REGISTRY.stateCount }, (_, s) => s)
  .filter((s) => COLLIDE[s] !== COLLIDE_NONE).map((s) => REGISTRY.stateKey(s));
const CAVE_SIDES = ['floor', 'ceiling', 'here'] as const;
/** `strata` layer weights: even and skewed tables, §3.3's abyss weights among them. */
const STRATA_WEIGHTS: readonly number[] = [1, 2, 10, 15, 25, 50, 0.25, 1000];
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

  /** A `strata` leaf over the trees' noises: 1-4 layers (1-16 one time in 8), lengths 1 … 8, amp 0 … 16. */
  const strata = (): Rule => {
    const n = next() % 8 === 0 ? 1 + (next() % 16) : 1 + (next() % 4);
    const layers = Array.from({ length: n }, () => ({ state: pick(SOLID_KEYS), weight: pick(STRATA_WEIGHTS), maxLen: 1 + (next() % 8) }));
    const a = 1 + (next() % 8), b = 1 + (next() % 8);
    const amp = next() % 4 === 0 ? pick([0, 16]) : Math.round(testFloat(next) * 1600) / 100;
    return { kind: 'strata', layers, minLen: Math.min(a, b), maxLen: Math.max(a, b), noise: pick(noises), amp: plus0(amp) };
  };
  /**
   * A leaf: a `bandlands` one time in 8, a `strata` one time in 16, else a block of any colliding state (a block leaf
   * must collide, tier 2).
   */
  const block = (): Rule => {
    const k = next() % 16;
    return k % 8 === 0 ? { kind: 'bandlands' } : k === 1 ? strata() : { kind: 'block', state: pick(SOLID_KEYS) };
  };

  const gradient = (): Condition => {
    const lo = bool() ? pick(Y_POINTS) - (next() % 3) : -66 + (next() % 380);
    return { kind: 'verticalGradient', trueAtAndBelow: lo, falseAtAndAbove: lo + 1 + (next() % 12) };
  };
  const floorDepth = (): Condition => ({ kind: 'stoneDepth', side: 'floor', offset: next() % 4 === 0 ? (next() % 21) - 2 : next() % 6, addSurfaceDepth: bool() });
  /** A `caveBiome` of any side over 1-4 distinct cave biomes in any order. */
  const caveBiome = (): Condition => {
    const pool = [...CAVE_BIOME_NAMES];
    const list: CaveBiomeName[] = [];
    for (let n = 1 + (next() % pool.length); n > 0; n--) list.push(pool.splice(next() % pool.length, 1)[0]!);
    return { kind: 'caveBiome', side: CAVE_SIDES[next() % CAVE_SIDES.length]!, biomes: list };
  };

  /** A condition at nesting depth `depth`, any kind (no skyOpen, also inside a not, when `noSky`). */
  const condition = (depth: number, noSky = false): Condition => {
    for (;;) {
      switch (next() % 12) {
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
        case 10: return caveBiome();
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
  /**
   * A branch whose every leaf is depth-bounded: a gate chain holding a floor stoneDepth, or with `ceilingGates` one time
   * in 2 a ceiling one (and skyOpen when sky-gated).
   */
  const depthBounded = (): Rule => {
    const gates: Condition[] = [opts.ceilingGates === true && bool() ? { ...floorDepth(), side: 'ceiling' } as Condition : floorDepth()];
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
  /** A branch whose leaf is in no class: neither depth-bounded, ceiling-bounded (SP6b spec §3.5) nor Y-only. */
  const offPath = (): Rule => {
    const bad: Condition[] = [
      { kind: 'not', if: floorDepth() },
      { kind: 'not', if: { ...floorDepth(), side: 'ceiling' } as Condition },
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

/** §6.1's cave-biome defaults (the boxes, depthScale 128, edgeJitter 2), as `params.caves.biomes` minus its noises. */
export const SURFACE_FUZZ_CAVE_SETTINGS: CaveBiomeSettings = Object.freeze({
  lush: { hMin: 0.4, depthMin: 0.2, depthMax: 0.9 },
  dripstone: { cMin: 0.6, depthMin: 0.2, depthMax: 0.9 },
  abyss: { eMax: -0.5, cMin: -0.1, depthMin: 1.0 },
  depthScale: 128,
  borderWarp: 0.05,
  depthWarp: 10,
  edgeJitter: 2,
});

/** A 2D noise that is never read: a hand-filled pass already holds the perturbed fields. */
const UNREAD_NOISE = Object.freeze({ z2: (): number => 0, clamp: 1 });

/** Picker inputs over `settings` for a hand-filled pass (`handCavePass`): only the boxes, D and the jitter seed are read. */
export function fuzzCavePicker(settings: CaveBiomeSettings = SURFACE_FUZZ_CAVE_SETTINGS, jitterSeed = 0x2c4b5eed): CavePickerInputs {
  return { settings, borderC: UNREAD_NOISE, borderE: UNREAD_NOISE, borderH: UNREAD_NOISE, depth: UNREAD_NOISE, jitterSeed };
}

/** One position of a hand-filled pass: the perturbed climate C′, E′, H′ and the depth origin Y0. */
export interface CaveFields { readonly c: number; readonly e: number; readonly h: number; readonly y0: number }

/**
 * A column pass for column (cx, cz) filled with jitter j: entry (x, z), for every x, z within 4 of the column (the 24 ×
 * 24 layout), takes `fields(x, z)`.
 */
export function handCavePass(cx: number, cz: number, j: number, fields: (x: number, z: number) => CaveFields): CaveColumnPass {
  const pass = newCaveColumnPass();
  pass.cx = cx;
  pass.cz = cz;
  pass.j = j;
  for (let k = 0; k < 576; k++) {
    const f = fields(16 * cx - 4 + (k % 24), 16 * cz - 4 + Math.floor(k / 24));
    pass.c[k] = f.c;
    pass.e[k] = f.e;
    pass.h[k] = f.h;
    pass.y0[k] = f.y0;
  }
  return pass;
}

/** The highest solid y of position p (the stage's bedrock −64 when nothing else is solid). */
function topOf(solid: Uint8Array, p: number): number {
  let y = 319;
  while (y > -64 && solid[at(p, y)] === 0) y--;
  return y;
}

/**
 * `col` with a cave channel and a cave picker drawn from `testRng(seed)` (the column's own stream is not touched): the
 * default boxes, sometimes overlapping, D 16 … 128 and edgeJitter 0 … 4; a pass whose 4 × 4 cells each hold a climate
 * regime (plain, lush, dripstone, abyss, or one inside every box, where the margin decides), lightly speckled, with the
 * depth origin a cell offset above the position's top; three cave-air segments in four tagged (kind 1 … 9; the nibble
 * the picker's at the voxel or any biome, one in two), one position in eight with a tagged entrance 1 … 3 voxels above
 * its top, and one air voxel in sixteen written as a kind-0 byte with a nibble (untagged).
 */
export function withCaveBiomes(col: SurfaceFuzzColumn, seed: number): SurfaceFuzzColumn & { readonly tags: Uint8Array; readonly cave: SurfaceFuzzCave } {
  const next = testRng(seed);
  const d = SURFACE_FUZZ_CAVE_SETTINGS;
  const overlap = next() % 4 === 0;
  const settings: CaveBiomeSettings = {
    ...d,
    lush: overlap ? { ...d.lush, depthMax: 1.3 } : d.lush,
    dripstone: overlap ? { ...d.dripstone, cMin: 0.3 } : d.dripstone,
    depthScale: 16 + (next() % 113),
    edgeJitter: next() % 5,
  };
  const inputs = fuzzCavePicker(settings, next());
  const { cx, cz } = col.sample;
  const regimes: number[] = [], offsets: number[] = [];
  for (let k = 0; k < 36; k++) {
    regimes.push(next() % 5);
    offsets.push((next() % 25) - 4);
  }
  const speckle = (): number => (testFloat(next) - 0.5) * 0.1;
  const pass = handCavePass(cx, cz, settings.edgeJitter, (x, z) => {
    const i = z - 16 * cz + 4, jx = x - 16 * cx + 4;
    const cell = (i >> 2) * 6 + (jx >> 2);
    const p = Math.min(15, Math.max(0, i - 4)) * 16 + Math.min(15, Math.max(0, jx - 4));
    const f = testFloat(next);
    let c = speckle(), e = speckle(), h = speckle();
    switch (regimes[cell]) {
      case 1: h += 0.5 + 0.4 * f; break;
      case 2: c += 0.7 + 0.3 * f; break;
      case 3: e += -0.6 - 0.4 * f; c += 0.3 * f; break;
      case 4: h += 0.45 + 0.3 * f; c += 0.65 + 0.3 * f; e += -0.55 - 0.3 * f; break;
      default: break;
    }
    return { c, e, h, y0: topOf(col.solid, p) + offsets[cell]! };
  });
  const tags = new Uint8Array(VOXELS);
  for (let p = 0; p < 256; p++) {
    const top = topOf(col.solid, p);
    const x = 16 * cx + (p & 15), z = 16 * cz + (p >> 4);
    const entrance = next() % 8 === 0 ? 1 + (next() % 3) : 0;
    let segment = false, tagged = false;
    for (let y = -63; y <= Math.min(319, top + entrance); y++) {
      if (col.solid[at(p, y)] !== 0) { segment = false; continue; }
      // A new air segment (cave air under the top, or the entrance above it): tagged three times in four.
      if (!segment) { segment = true; tagged = y > top || next() % 4 !== 0; }
      if (next() % 16 === 0) { tags[at(p, y)] = (next() % 4) << 4; continue; }
      if (!tagged) continue;
      const biome = next() % 2 === 0 ? caveBiomeOfPass(inputs, pass, x, y, z) : next() % 4;
      tags[at(p, y)] = (1 + (next() % 9)) | (biome << 4);
    }
  }
  return { ...col, tags, cave: { inputs, pass } };
}

/**
 * The fixed column of the D18 cases (SP6b spec §3.2, §10), every position with the stage's bedrock at y −64, the picker
 * lush in the rock at y −15 … 74 everywhere (H′ 0.5, Y0 100, D 128, no jitter) and plain above and below:
 * - p 0: ground −63 … 40 (resting on the bedrock) under plain cave air (`1 | 0 << 4`) at 41 … 45: lush rock under a
 *   plain cave;
 * - p 1: ground −63 … 40 under lush cave air (`1 | 1 << 4`) at 41 … 49, an overhang 50 … 60 above it;
 * - p 2: ground −63 … 40 under untagged air.
 * Every other position: ground −63 … 40.
 */
export function caveBiomeHandColumn(): SurfaceFuzzColumn & { readonly tags: Uint8Array; readonly cave: SurfaceFuzzCave } {
  const col = randomSurfaceColumn(testRng(1));
  col.solid.fill(0);
  col.water.fill(0);
  col.sample.f.lakeLevel.fill(-Infinity);
  const tags = new Uint8Array(VOXELS);
  for (let p = 0; p < 256; p++) {
    col.solid[at(p, -64)] = 1;
    for (let y = -63; y <= 40; y++) col.solid[at(p, y)] = 1;
  }
  for (let y = 41; y <= 45; y++) tags[at(0, y)] = 1;
  for (let y = 41; y <= 49; y++) tags[at(1, y)] = 1 | (1 << 4);
  for (let y = 50; y <= 60; y++) col.solid[at(1, y)] = 1;
  const settings = { ...SURFACE_FUZZ_CAVE_SETTINGS, edgeJitter: 0 };
  const pass = handCavePass(col.sample.cx, col.sample.cz, 0, () => ({ c: 0, e: 0, h: 0.5, y0: 100 }));
  return { ...col, tags, cave: { inputs: fuzzCavePicker(settings), pass } };
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

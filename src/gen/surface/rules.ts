/**
 * The surface-rule model (SP3c spec §3.1): a rule tree is plain JSON, one object per rule and per condition, whose
 * discriminator is `kind`; every other property is exactly the kind's fields, all present. A condition is nested as
 * the value of `if` (in `condition` and in `not`). This module holds the types, the kinds, the rule ids (a rule node's
 * id is its path: `root`, `<id>.rules[k]`, `<id>.then`; conditions have no ids), `ruleLeaves` (each leaf with the
 * conditions on its path, for the compiler's fast-path analysis) and `validateRules` with node-path messages.
 * Per-condition semantics are in conditions.ts. A `bandlands` leaf (the badlands band block, bands.ts) is valid only
 * when the noise lookup knows `surface.noises.bandOffset` (§3.1: rejected when the band leaf is absent, §9's cut line).
 */
import { SURFACE_BIOMES, type SurfaceBiome } from '../biomes/registry';
import { REGISTRY } from '../../world/blocks/index';
import { BAND_OFFSET_NOISE } from './bands';

const BIOMES = SURFACE_BIOMES;
const BLOCKS = REGISTRY;
const BAND_NOISE = BAND_OFFSET_NOISE;

export interface SequenceRule { readonly kind: 'sequence'; readonly rules: readonly Rule[] }
export interface ConditionRule { readonly kind: 'condition'; readonly if: Condition; readonly then: Rule }
/** `state` is a canonical state key (SP3a §2.3). */
export interface BlockRule { readonly kind: 'block'; readonly state: string }
/** The badlands band block at the voxel's (x, y, z) (§3.3, bands.ts). */
export interface BandlandsRule { readonly kind: 'bandlands' }
export type Rule = SequenceRule | ConditionRule | BlockRule | BandlandsRule;
export type RuleKind = Rule['kind'];
/** A leaf: a rule that yields a block by itself. */
export type LeafRule = BlockRule | BandlandsRule;

export interface BiomeCondition { readonly kind: 'biome'; readonly biomes: readonly SurfaceBiome[] }
export type StoneDepthSide = 'floor' | 'ceiling';
export interface StoneDepthCondition {
  readonly kind: 'stoneDepth'; readonly side: StoneDepthSide; readonly offset: number; readonly addSurfaceDepth: boolean;
}
export interface WaterCondition { readonly kind: 'water'; readonly offset: number; readonly runTop: boolean }
export interface YAboveCondition { readonly kind: 'yAbove'; readonly minY: number; readonly runTop: boolean }
export interface VerticalGradientCondition {
  readonly kind: 'verticalGradient'; readonly trueAtAndBelow: number; readonly falseAtAndAbove: number;
}
export interface SteepCondition { readonly kind: 'steep'; readonly min: number }
/** `noise` is the schema path of a dims-2 `surface.noises.*` leaf. */
export interface NoiseThresholdCondition { readonly kind: 'noiseThreshold'; readonly noise: string; readonly min: number; readonly max: number }
export interface TemperatureBelowCondition { readonly kind: 'temperatureBelow'; readonly t: number }
export interface SkyOpenCondition { readonly kind: 'skyOpen' }
export interface LakeCondition { readonly kind: 'lake' }
export interface NotCondition { readonly kind: 'not'; readonly if: Condition }
export type Condition =
  | BiomeCondition | StoneDepthCondition | WaterCondition | YAboveCondition | VerticalGradientCondition | SteepCondition
  | NoiseThresholdCondition | TemperatureBelowCondition | SkyOpenCondition | LakeCondition | NotCondition;
export type ConditionKind = Condition['kind'];

/** The rule kinds of §3.1's first table, in its order. */
export const RULE_KINDS: readonly RuleKind[] = ['sequence', 'condition', 'block', 'bandlands'];
/** The condition kinds of §3.1's second table, in its order. */
export const CONDITION_KINDS: readonly ConditionKind[] = [
  'biome', 'stoneDepth', 'water', 'yAbove', 'verticalGradient', 'steep', 'noiseThreshold', 'temperatureBelow', 'skyOpen', 'lake', 'not',
];

/** What validation needs to know about a surface noise. */
export interface SurfaceNoiseInfo {
  readonly dims: 2 | 3;
  readonly remap: 'none' | 'uniform';
  readonly clampSigma: number;
}
/** The surface noises a tree may name, by schema path (`surface.noises.<id>`). */
export type SurfaceNoiseLookup = (name: string) => SurfaceNoiseInfo | undefined;
/** A surface noise the evaluators sample: z2(x, z) at unscaled world block coordinates, in [−clampSigma, clampSigma]. */
export interface SurfaceNoise extends SurfaceNoiseInfo {
  z2(x: number, z: number): number;
}
/** Surface noises by schema path; also a SurfaceNoiseLookup, so one source validates and evaluates. */
export type SurfaceNoiseSource = (name: string) => SurfaceNoise | undefined;

/** The id of the tree's root rule. */
export const ROOT_RULE_ID = 'root';

/** The id of child k of the sequence `id`. */
export function sequenceChildId(id: string, k: number): string {
  return `${id}.rules[${k}]`;
}

/** The id of the `then` rule of the condition rule `id`. */
export function conditionThenId(id: string): string {
  return `${id}.then`;
}

/** A leaf of a tree: its id, the leaf rule and the `if`s of its condition ancestors (outermost first; sequences skipped). */
export interface RuleLeaf {
  readonly id: string;
  readonly rule: LeafRule;
  readonly conditions: readonly Condition[];
}

/** Every leaf of a (valid) tree in evaluation order, with its id and path conditions. */
export function ruleLeaves(root: Rule): RuleLeaf[] {
  const out: RuleLeaf[] = [];
  const walk = (r: Rule, id: string, conds: readonly Condition[]): void => {
    switch (r.kind) {
      case 'sequence':
        for (let k = 0; k < r.rules.length; k++) walk(r.rules[k]!, sequenceChildId(id, k), conds);
        break;
      case 'condition':
        walk(r.then, conditionThenId(id), [...conds, r.if]);
        break;
      case 'block': case 'bandlands':
        out.push({ id, rule: r, conditions: conds });
        break;
    }
  };
  walk(root, ROOT_RULE_ID, []);
  return out;
}

export type RuleErrorCode =
  | 'NOT_OBJECT' | 'NOT_ARRAY' | 'UNKNOWN_KIND' | 'UNKNOWN_FIELD' | 'MISSING_FIELD' | 'UNKNOWN_BLOCK' | 'UNKNOWN_BIOME'
  | 'UNKNOWN_NOISE' | 'NOISE_DIMS' | 'NOISE_REMAP' | 'NOT_FINITE' | 'NOT_INTEGER' | 'OUT_OF_RANGE' | 'NEGATIVE_ZERO'
  | 'NOT_BOOLEAN' | 'BAD_SIDE' | 'RANGE_ORDER' | 'GRADIENT_ORDER' | 'TOO_DEEP' | 'TOO_MANY_NODES' | 'NO_BAND_NOISE';

export interface RuleIssue {
  /** The node path: a rule's id (`root.rules[1].then`), `.if` / `.if.if` for conditions, then the field (`.offset`, `.biomes[2]`). */
  readonly path: string;
  readonly code: RuleErrorCode;
  readonly message: string;
}

export class RuleValidationError extends Error {
  readonly issues: readonly RuleIssue[];
  constructor(issues: readonly RuleIssue[]) {
    super(`invalid surface rules: ${issues.map((i) => `${i.path}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

/** The fields of each kind besides `kind`, in the order they are checked. */
const FIELDS: { readonly [K in RuleKind | ConditionKind]: readonly string[] } = {
  sequence: ['rules'], condition: ['if', 'then'], block: ['state'], bandlands: [],
  biome: ['biomes'], stoneDepth: ['side', 'offset', 'addSurfaceDepth'], water: ['offset', 'runTop'], yAbove: ['minY', 'runTop'],
  verticalGradient: ['trueAtAndBelow', 'falseAtAndAbove'], steep: ['min'], noiseThreshold: ['noise', 'min', 'max'],
  temperatureBelow: ['t'], skyOpen: [], lake: [], not: ['if'],
};
const RULE_SET = new Set<string>(RULE_KINDS);
const CONDITION_SET = new Set<string>(CONDITION_KINDS);
const BIOME_SET = new Set<string>(BIOMES);
/** Integer fields lie in [−INT_LIMIT, INT_LIMIT] (§3.1). */
const INT_LIMIT = 384;
/** Nesting depth limit (the root is at depth 1; rules and conditions count) and node-count limit (§3.1). */
const MAX_DEPTH = 32;
const MAX_NODES = 4096;
const NOISE_PREFIX = 'surface.noises.';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBlockKey(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    BLOCKS.parseStateKey(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single surface-rule validator (SP3c spec §3.1). Collects every issue in DFS pre-order and never throws; [] means
 * the value is a `Rule` the compiler and the reference accept. Checks: kinds (a rule kind where a rule goes, a
 * condition kind where a condition goes), unknown and missing fields, block keys (`parseStateKey`), biomes, the noise
 * of `noiseThreshold` (a dims-2, remap-'none' `surface.noises.*` leaf known to `noises`), integer fields in
 * [−384, 384], finite numbers, booleans, `side`, `min ≤ max`, `trueAtAndBelow < falseAtAndAbove`, −0 anywhere, a
 * `bandlands` leaf without a dims-2, remap-'none' `surface.noises.bandOffset` in `noises` (NO_BAND_NOISE when the leaf
 * is absent, §9's cut line), a
 * nesting depth above 32 (each node past it is reported and not entered) and more than 4096 nodes (reported once, at
 * `root`; the walk stops there).
 */
export function validateRules(value: unknown, noises: SurfaceNoiseLookup): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const push = (path: string, code: RuleErrorCode, message: string) => issues.push({ path, code, message });
  let nodes = 0;
  let overflow = false;

  /** Enters a node: counts it and checks its depth; false when it must not be walked. */
  const enter = (path: string, depth: number): boolean => {
    if (overflow) return false;
    if (++nodes > MAX_NODES) {
      overflow = true;
      push(ROOT_RULE_ID, 'TOO_MANY_NODES', `more than ${MAX_NODES} rule and condition nodes`);
      return false;
    }
    if (depth > MAX_DEPTH) {
      push(path, 'TOO_DEEP', `nesting depth above ${MAX_DEPTH}`);
      return false;
    }
    return true;
  };

  /** Checks the field set of `node` (kind `kind`): unknown and missing fields; true when every field is present. */
  const fields = (node: Record<string, unknown>, kind: RuleKind | ConditionKind, path: string): boolean => {
    let complete = true;
    for (const k of Object.keys(node)) if (k !== 'kind' && !FIELDS[kind].includes(k)) push(`${path}.${k}`, 'UNKNOWN_FIELD', `unknown field "${k}" on ${kind}`);
    for (const k of FIELDS[kind]) {
      if (!Object.hasOwn(node, k)) {
        push(`${path}.${k}`, 'MISSING_FIELD', `${kind}.${k} is missing (every field is written)`);
        complete = false;
      }
    }
    return complete;
  };

  /** A finite number, not −0. */
  const num = (node: Record<string, unknown>, kind: string, k: string, path: string): boolean => {
    const v = node[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) { push(`${path}.${k}`, 'NOT_FINITE', `${kind}.${k} must be a finite number`); return false; }
    if (Object.is(v, -0)) { push(`${path}.${k}`, 'NEGATIVE_ZERO', `${kind}.${k} is −0 (write 0)`); return false; }
    return true;
  };
  /** An integer in [−384, 384], not −0. */
  const int = (node: Record<string, unknown>, kind: string, k: string, path: string): boolean => {
    const v = node[k];
    if (typeof v === 'number' && !Number.isFinite(v)) { push(`${path}.${k}`, 'NOT_FINITE', `${kind}.${k} must be a finite integer`); return false; }
    if (typeof v !== 'number' || !Number.isInteger(v)) { push(`${path}.${k}`, 'NOT_INTEGER', `${kind}.${k} must be an integer`); return false; }
    if (Object.is(v, -0)) { push(`${path}.${k}`, 'NEGATIVE_ZERO', `${kind}.${k} is −0 (write 0)`); return false; }
    if (v < -INT_LIMIT || v > INT_LIMIT) { push(`${path}.${k}`, 'OUT_OF_RANGE', `${kind}.${k} ${v} is outside [−${INT_LIMIT}, ${INT_LIMIT}]`); return false; }
    return true;
  };
  const bool = (node: Record<string, unknown>, kind: string, k: string, path: string): void => {
    if (typeof node[k] !== 'boolean') push(`${path}.${k}`, 'NOT_BOOLEAN', `${kind}.${k} must be a boolean`);
  };

  const condition = (node: unknown, path: string, depth: number): void => {
    if (!enter(path, depth)) return;
    if (!isRecord(node)) { push(path, 'NOT_OBJECT', 'a condition is an object with a kind'); return; }
    const kind = node['kind'];
    if (typeof kind !== 'string' || !CONDITION_SET.has(kind)) { push(path, 'UNKNOWN_KIND', `unknown condition kind ${JSON.stringify(kind)}`); return; }
    const c = kind as ConditionKind;
    if (!fields(node, c, path)) return;
    switch (c) {
      case 'biome': {
        const list = node['biomes'];
        if (!Array.isArray(list)) { push(`${path}.biomes`, 'NOT_ARRAY', 'biome.biomes must be an array of surface biome names'); break; }
        for (let i = 0; i < list.length; i++) {
          const b: unknown = list[i];
          if (typeof b !== 'string' || !BIOME_SET.has(b)) push(`${path}.biomes[${i}]`, 'UNKNOWN_BIOME', `unknown surface biome ${JSON.stringify(b)}`);
        }
        break;
      }
      case 'stoneDepth': {
        const side = node['side'];
        if (side !== 'floor' && side !== 'ceiling') push(`${path}.side`, 'BAD_SIDE', `stoneDepth.side ${JSON.stringify(side)} is not floor or ceiling`);
        int(node, c, 'offset', path);
        bool(node, c, 'addSurfaceDepth', path);
        break;
      }
      case 'water':
        int(node, c, 'offset', path);
        bool(node, c, 'runTop', path);
        break;
      case 'yAbove':
        int(node, c, 'minY', path);
        bool(node, c, 'runTop', path);
        break;
      case 'verticalGradient': {
        const lo = int(node, c, 'trueAtAndBelow', path), hi = int(node, c, 'falseAtAndAbove', path);
        if (lo && hi && (node['trueAtAndBelow'] as number) >= (node['falseAtAndAbove'] as number)) {
          push(path, 'GRADIENT_ORDER', 'verticalGradient needs trueAtAndBelow < falseAtAndAbove');
        }
        break;
      }
      case 'steep': num(node, c, 'min', path); break;
      case 'temperatureBelow': num(node, c, 't', path); break;
      case 'noiseThreshold': {
        const name = node['noise'];
        const info = typeof name === 'string' && name.startsWith(NOISE_PREFIX) ? noises(name) : undefined;
        if (info === undefined) push(`${path}.noise`, 'UNKNOWN_NOISE', `${JSON.stringify(name)} is not a surface.noises.* leaf`);
        else if (info.dims !== 2) push(`${path}.noise`, 'NOISE_DIMS', `noiseThreshold needs a 2D noise; ${String(name)} is ${info.dims}D`);
        else if (info.remap !== 'none') push(`${path}.noise`, 'NOISE_REMAP', `surface noise ${String(name)} must have remap 'none'`);
        const lo = num(node, c, 'min', path), hi = num(node, c, 'max', path);
        if (lo && hi && (node['min'] as number) > (node['max'] as number)) push(path, 'RANGE_ORDER', 'noiseThreshold needs min ≤ max');
        break;
      }
      case 'skyOpen': case 'lake': break;
      case 'not': condition(node['if'], `${path}.if`, depth + 1); break;
    }
  };

  const rule = (node: unknown, path: string, depth: number): void => {
    if (!enter(path, depth)) return;
    if (!isRecord(node)) { push(path, 'NOT_OBJECT', 'a rule is an object with a kind'); return; }
    const kind = node['kind'];
    if (typeof kind !== 'string' || !RULE_SET.has(kind)) { push(path, 'UNKNOWN_KIND', `unknown rule kind ${JSON.stringify(kind)}`); return; }
    const r = kind as RuleKind;
    const complete = fields(node, r, path);
    switch (r) {
      case 'sequence': {
        if (!complete) break;
        const list = node['rules'];
        if (!Array.isArray(list)) { push(`${path}.rules`, 'NOT_ARRAY', 'sequence.rules must be an array of rules'); break; }
        for (let k = 0; k < list.length && !overflow; k++) rule(list[k], sequenceChildId(path, k), depth + 1);
        break;
      }
      case 'condition':
        if (Object.hasOwn(node, 'if')) condition(node['if'], `${path}.if`, depth + 1);
        if (Object.hasOwn(node, 'then')) rule(node['then'], conditionThenId(path), depth + 1);
        break;
      case 'block':
        if (complete && !isBlockKey(node['state'])) push(`${path}.state`, 'UNKNOWN_BLOCK', `${JSON.stringify(node['state'])} is not a registered state key`);
        break;
      case 'bandlands': {
        const info = noises(BAND_NOISE);
        if (info === undefined) push(path, 'NO_BAND_NOISE', `bandlands needs the ${BAND_NOISE} leaf, which is absent`);
        else if (info.dims !== 2) push(path, 'NOISE_DIMS', `bandlands needs a 2D ${BAND_NOISE}; it is ${info.dims}D`);
        else if (info.remap !== 'none') push(path, 'NOISE_REMAP', `surface noise ${BAND_NOISE} must have remap 'none'`);
        break;
      }
    }
  };

  rule(value, ROOT_RULE_ID, 1);
  return issues;
}

/** Returns `value` as a Rule when `validateRules` finds no issue; otherwise throws a RuleValidationError listing them. */
export function requireValidRules(value: unknown, noises: SurfaceNoiseLookup): Rule {
  const issues = validateRules(value, noises);
  if (issues.length > 0) throw new RuleValidationError(issues);
  return value as Rule;
}

/**
 * The surface-rule model (SP3c spec §3.1): a rule tree is plain JSON, one object per rule and per condition, whose
 * discriminator is `kind`; every other property is exactly the kind's fields, all present. A condition is nested as
 * the value of `if` (in `condition` and in `not`). This module holds the types, the kinds, the rule ids (a rule node's
 * id is its path: `root`, `<id>.rules[k]`, `<id>.then`; conditions have no ids), `ruleLeaves` (each leaf with the
 * conditions on its path, for the compiler's fast-path analysis) and `validateRules` with node-path messages.
 * Per-condition semantics are in conditions.ts. A `bandlands` leaf (the badlands band block, bands.ts) is valid only
 * when the noise lookup knows `surface.noises.bandOffset` (§3.1: rejected when the band leaf is absent, §9's cut line).
 * `validateRules` also has the source mode of SP3d (spec §1.3, §1.7) that `validateRulesSource` (source.ts) runs on an
 * edited tree: parameter refs in the numeric fields, every check over their static ranges, literal ranges, the biome
 * list length and solid block states.
 */
import { SURFACE_BIOMES, type SurfaceBiome } from '../biomes/registry';
import { COLLIDE, REGISTRY } from '../../world/blocks/index';
import { COLLIDE_NONE } from '../../world/blocks/kinds';
import { BAND_OFFSET_NOISE } from './bands';

const BIOMES = SURFACE_BIOMES;
const BLOCKS = REGISTRY;
const BAND_NOISE = BAND_OFFSET_NOISE;
const COLLIDES = COLLIDE;
const NO_COLLISION = COLLIDE_NONE;

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

/**
 * The codes the source mode adds (SP3d spec §1.3, §1.7): a malformed ref (`BAD_FIELD`), a ref to a path that is not a
 * target (`UNKNOWN_PARAM`) or to a non-`int` target in an int field (`PARAM_KIND`), a literal beyond ±1e9
 * (`LITERAL_RANGE`), a `biome` list of more than 64 entries (`TOO_MANY_BIOMES`), a block state that does not collide
 * (`NOT_SOLID`).
 */
export type RuleRefCode = 'BAD_FIELD' | 'UNKNOWN_PARAM' | 'PARAM_KIND' | 'LITERAL_RANGE' | 'TOO_MANY_BIOMES' | 'NOT_SOLID';

/** An issue of the source mode: `validateRules`' paths, never `.param` (a ref's issue is at its field). */
export interface RuleSourceIssue {
  readonly path: string;
  readonly code: RuleErrorCode | RuleRefCode;
  readonly message: string;
}

/** A ref target: its static range and whether it is an `int` leaf (the only targets an int field takes). */
export interface RuleRefTarget {
  readonly lo: number;
  readonly hi: number;
  readonly int: boolean;
}

/** The source mode: the ref targets by path (own entries only; undefined: not a target). */
export interface RuleSourceMode {
  readonly target: (path: string) => RuleRefTarget | undefined;
}

/**
 * An issue a RuleValidationError carries: `validateRules`' (code-built trees, through `requireValidRules`) or tier 2's
 * (`resolveRules`, SP3d spec §1.6: the source mode's codes, `COLUMN_COST` and `TOO_MANY_ISSUES` at '').
 */
export interface RuleValidationIssue {
  readonly path: string;
  readonly code: RuleErrorCode | RuleRefCode | 'COLUMN_COST' | 'TOO_MANY_ISSUES';
  readonly message: string;
}

export class RuleValidationError extends Error {
  readonly issues: readonly RuleValidationIssue[];
  constructor(issues: readonly RuleValidationIssue[]) {
    super(`invalid surface rules: ${issues.map((i) => `${i.path}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

/**
 * The fields of each kind besides `kind`, in §3.1's table order, which is also the order they are checked (field names
 * only, frozen; look a kind up with `Object.hasOwn`). The inspector's printer and node form read it (SP3d spec §3.3, §3.5).
 */
export const FIELDS: { readonly [K in RuleKind | ConditionKind]: readonly string[] } = Object.freeze({
  sequence: Object.freeze(['rules']), condition: Object.freeze(['if', 'then']), block: Object.freeze(['state']), bandlands: Object.freeze([]),
  biome: Object.freeze(['biomes']), stoneDepth: Object.freeze(['side', 'offset', 'addSurfaceDepth']), water: Object.freeze(['offset', 'runTop']),
  yAbove: Object.freeze(['minY', 'runTop']), verticalGradient: Object.freeze(['trueAtAndBelow', 'falseAtAndAbove']), steep: Object.freeze(['min']),
  noiseThreshold: Object.freeze(['noise', 'min', 'max']), temperatureBelow: Object.freeze(['t']), skyOpen: Object.freeze([]), lake: Object.freeze([]),
  not: Object.freeze(['if']),
});
const RULE_SET = new Set<string>(RULE_KINDS);
const CONDITION_SET = new Set<string>(CONDITION_KINDS);
const BIOME_SET = new Set<string>(BIOMES);
/** Integer fields lie in [−INT_LIMIT, INT_LIMIT] (§3.1). */
const INT_LIMIT = 384;
/** Nesting depth limit (the root is at depth 1; rules and conditions count) and node-count limit (§3.1). */
const MAX_DEPTH = 32;
const MAX_NODES = 4096;
const NOISE_PREFIX = 'surface.noises.';
/** Source mode: literals in number fields are at most this in magnitude; `biome` lists hold at most MAX_BIOMES. */
const LITERAL_LIMIT = 1e9;
const MAX_BIOMES = 64;
/** The keys of a ref (`{param}` or `{param, neg: true}`). */
const REF_KEYS = new Set(['param', 'neg']);

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
 *
 * With `source` (SP3d spec §1.3, §1.7), each of the nine numeric fields may instead hold a ref `{param: <path>}` or
 * `{param: <path>, neg: true}` (value v, or 0 − v): a malformed ref is BAD_FIELD, a path that `source.target` does not
 * know UNKNOWN_PARAM, a non-`int` target in an int field PARAM_KIND, all at the field's path. Every check then holds over
 * the static ranges (a negated ref's is [0 − hi, 0 − lo]; two refs are independent, even to the same leaf): an int
 * field's range inside [−384, 384] (OUT_OF_RANGE), RANGE_ORDER when the largest `min` exceeds the smallest `max`,
 * GRADIENT_ORDER when the largest `trueAtAndBelow` is not below the smallest `falseAtAndAbove`. Also: number-field
 * literals beyond ±1e9 (LITERAL_RANGE), a `biome` list of more than 64 entries (TOO_MANY_BIOMES at `.biomes`, entries not
 * checked) and a block state that does not collide (NOT_SOLID).
 */
export function validateRules(value: unknown, noises: SurfaceNoiseLookup): RuleIssue[];
export function validateRules(value: unknown, noises: SurfaceNoiseLookup, source: RuleSourceMode): RuleSourceIssue[];
export function validateRules(value: unknown, noises: SurfaceNoiseLookup, source?: RuleSourceMode): RuleSourceIssue[] {
  const issues: RuleSourceIssue[] = [];
  const push = (path: string, code: RuleErrorCode | RuleRefCode, message: string) => issues.push({ path, code, message });
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

  /**
   * A ref's static range (source mode, `v` an object): [lo, hi], or undefined after its issue (BAD_FIELD,
   * UNKNOWN_PARAM, PARAM_KIND) at the field's path.
   */
  const ref = (v: Record<string, unknown>, kind: string, k: string, path: string, isInt: boolean): readonly [number, number] | undefined => {
    const where = `${path}.${k}`;
    const param = Object.hasOwn(v, 'param') ? v['param'] : undefined;
    const negated = Object.hasOwn(v, 'neg');
    if (typeof param !== 'string' || Object.keys(v).some((key) => !REF_KEYS.has(key)) || (negated && v['neg'] !== true)) {
      push(where, 'BAD_FIELD', `${kind}.${k} must be a number, {"param": <path>} or {"param": <path>, "neg": true}`);
      return undefined;
    }
    const t = source!.target(param);
    if (t === undefined) { push(where, 'UNKNOWN_PARAM', `${JSON.stringify(param)} is not a parameter a tree may reference`); return undefined; }
    if (isInt && !t.int) { push(where, 'PARAM_KIND', `${kind}.${k} is an integer field; ${param} is not an int parameter`); return undefined; }
    return negated ? [0 - t.hi, 0 - t.lo] : [t.lo, t.hi];
  };
  /** A finite number, not −0 (source mode: or a ref; a literal within ±1e9). Its static range, or undefined. */
  const num = (node: Record<string, unknown>, kind: string, k: string, path: string): readonly [number, number] | undefined => {
    const v = node[k];
    if (source !== undefined && isRecord(v)) return ref(v, kind, k, path, false);
    if (typeof v !== 'number' || !Number.isFinite(v)) { push(`${path}.${k}`, 'NOT_FINITE', `${kind}.${k} must be a finite number`); return undefined; }
    if (Object.is(v, -0)) { push(`${path}.${k}`, 'NEGATIVE_ZERO', `${kind}.${k} is −0 (write 0)`); return undefined; }
    if (source !== undefined && (v < -LITERAL_LIMIT || v > LITERAL_LIMIT)) {
      push(`${path}.${k}`, 'LITERAL_RANGE', `${kind}.${k} ${v} is outside ±${LITERAL_LIMIT}`);
      return undefined;
    }
    return [v, v];
  };
  /** An integer in [−384, 384], not −0 (source mode: or a ref to an int leaf whose static range lies there). Its static range, or undefined. */
  const int = (node: Record<string, unknown>, kind: string, k: string, path: string): readonly [number, number] | undefined => {
    const v = node[k];
    if (source !== undefined && isRecord(v)) {
      const r = ref(v, kind, k, path, true);
      if (r !== undefined && (r[0] < -INT_LIMIT || r[1] > INT_LIMIT)) {
        push(`${path}.${k}`, 'OUT_OF_RANGE', `${kind}.${k}'s parameter range [${r[0]}, ${r[1]}] is outside [−${INT_LIMIT}, ${INT_LIMIT}]`);
        return undefined;
      }
      return r;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) { push(`${path}.${k}`, 'NOT_FINITE', `${kind}.${k} must be a finite integer`); return undefined; }
    if (typeof v !== 'number' || !Number.isInteger(v)) { push(`${path}.${k}`, 'NOT_INTEGER', `${kind}.${k} must be an integer`); return undefined; }
    if (Object.is(v, -0)) { push(`${path}.${k}`, 'NEGATIVE_ZERO', `${kind}.${k} is −0 (write 0)`); return undefined; }
    if (v < -INT_LIMIT || v > INT_LIMIT) { push(`${path}.${k}`, 'OUT_OF_RANGE', `${kind}.${k} ${v} is outside [−${INT_LIMIT}, ${INT_LIMIT}]`); return undefined; }
    return [v, v];
  };
  /** The ref note of an order message (source mode only). */
  const overRefs = (a: unknown, b: unknown): string => (isRecord(a) || isRecord(b)
    ? ' for every value of its parameters (refs are judged independently, even two to the same parameter)' : '');
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
        if (source !== undefined && list.length > MAX_BIOMES) { push(`${path}.biomes`, 'TOO_MANY_BIOMES', `${list.length} biomes, more than ${MAX_BIOMES}`); break; }
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
        if (lo !== undefined && hi !== undefined && lo[1] >= hi[0]) {
          push(path, 'GRADIENT_ORDER', `verticalGradient needs trueAtAndBelow < falseAtAndAbove${overRefs(node['trueAtAndBelow'], node['falseAtAndAbove'])}`);
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
        if (lo !== undefined && hi !== undefined && lo[1] > hi[0]) {
          push(path, 'RANGE_ORDER', `noiseThreshold needs min ≤ max${overRefs(node['min'], node['max'])}`);
        }
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
        if (!complete) break;
        if (!isBlockKey(node['state'])) push(`${path}.state`, 'UNKNOWN_BLOCK', `${JSON.stringify(node['state'])} is not a registered state key`);
        else if (source !== undefined && COLLIDES[BLOCKS.parseStateKey(node['state'] as string)] === NO_COLLISION) {
          push(`${path}.state`, 'NOT_SOLID', `${node['state'] as string} does not collide; a surface rule yields solid blocks only`);
        }
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

/**
 * The source model of the `surface.rules` leaf (SP3d spec §1.3, §1.7, §1.8): a rule tree as SP3c §3.1 encodes it, whose
 * nine numeric fields (`stoneDepth.offset`, `water.offset`, `yAbove.minY`, `verticalGradient.trueAtAndBelow` and
 * `.falseAtAndAbove`, `steep.min`, `noiseThreshold.min` and `.max`, `temperatureBelow.t`) may hold a parameter ref
 * `{param: <path>}` or `{param: <path>, neg: true}` instead of a number.
 *
 * `validateRulesSource` is tier 2 for the leaf: `validateRules` in its source mode over the schema's surface noises and
 * the ref targets below (every check over the targets' static ranges, so a slider move never invalidates a stored tree),
 * then, on a tree with no other issue, the column cost (`COLUMN_COST` at the leaf path when `rulesColumnCost` exceeds
 * `RULES_COLUMN_COST_MAX`). It collects at most 50 issues (then one TOO_MANY_ISSUES, "N more", at the leaf path) and
 * never throws. Validity is a pure function of the tree, so the result is memoised by the tree object when the tree is
 * deep-frozen (tier 1's clones and the contexts' frozen trees are); any other tree is validated on every call.
 *
 * `resolveRules` (§1.6) runs `validateRulesSource` first (a RuleValidationError with the source paths when it fails),
 * then builds a fresh, deep-frozen tree in which every ref is its number: the target's value in `params` (a schema
 * leaf's q15-normalised value, or a noise leaf's `clampSigma`), or `0 − v` with `neg` (+0 when v is 0, never −0);
 * nothing else changes. `freezeRules` deep-freezes an explicit tree in place (identity kept) for the SurfaceContext.
 * Follows the gen determinism rules.
 */
import { RULES_COLUMN_COST_MAX } from '../../core/constants';
import { getPath } from '../../core/params/kit';
import { NOISE_FIELD_RANGES, SCHEMA, type Params } from '../../core/params/schema';
import { ALLOWED_REF_TARGETS } from '../density/source';
import { rulesColumnCost } from '../inspect/cost';
import {
  RuleValidationError, validateRules, type Rule, type RuleErrorCode, type RuleRefCode, type RuleRefTarget,
  type RuleSourceMode, type SurfaceNoiseInfo, type SurfaceNoiseLookup,
} from './rules';

const SCHEMA_ = SCHEMA;
const REF_TARGETS = ALLOWED_REF_TARGETS;
const NOISE_RANGES = NOISE_FIELD_RANGES;
const VALIDATE = validateRules;
const COLUMN_COST = rulesColumnCost;
const COLUMN_COST_MAX = RULES_COLUMN_COST_MAX;
const GET_PATH = getPath;
const INVALID = RuleValidationError;

/** A parameter ref in a numeric field: the target's value v, or 0 − v with `neg` (never −0). */
export interface RuleParamRef {
  readonly param: string;
  readonly neg?: true;
}

/** Tier 2's codes for the leaf: `validateRules`' codes, the source mode's, the column cost and the issue cap. */
export type RulesSourceCode = RuleErrorCode | RuleRefCode | 'COLUMN_COST' | 'TOO_MANY_ISSUES';

/** A tier-2 issue: the node path in `validateRules`' syntax (`root.rules[1].then.if.min`); '' is the leaf itself. */
export interface RulesSourceIssue {
  readonly path: string;
  readonly code: RulesSourceCode;
  readonly message: string;
}

/** Issues collected before the cap (§1.7: "at most 50, as tier 1"). */
const MAX_ISSUES = 50;

/**
 * The ref targets (§1.3): the spec's single table, `ALLOWED_REF_TARGETS` (every `number` or `int` leaf under `density.`
 * or `surface.`, and the `clampSigma` field of their noise leaves, each with its static range), as `validateRules`
 * reads it; only `int` leaves may stand in an int field.
 */
const TARGETS: ReadonlyMap<string, RuleRefTarget> = (() => {
  const out = new Map<string, RuleRefTarget>();
  for (const [path, t] of REF_TARGETS) out.set(path, Object.freeze({ lo: t.lo, hi: t.hi, int: t.kind === 'int' }));
  return out;
})();

const MODE: RuleSourceMode = Object.freeze({ target: (path: string) => TARGETS.get(path) });

/**
 * The schema's surface noises as validation sees them, from the leaves' metadata (no value is read): dims, and remap
 * 'none' for the leaves that must keep it (every surface noise; any other is taken as possibly 'uniform').
 */
const NOISES: SurfaceNoiseLookup = (() => {
  const m = new Map<string, SurfaceNoiseInfo>();
  for (const { path, meta } of SCHEMA_.leaves) {
    if (meta.kind !== 'noise' || !path.startsWith('surface.noises.')) continue;
    m.set(path, Object.freeze({ dims: meta.dims ?? 2, remap: meta.remapNone === true ? 'none' : 'uniform', clampSigma: NOISE_RANGES.clampSigma.max }));
  }
  return (name: string) => m.get(name);
})();

const MEMO = new WeakMap<object, readonly RulesSourceIssue[]>();
let validations = 0;

/** True when `v` and every object and array inside it are frozen (an iterative walk; shared objects visited once). */
function deepFrozen(v: object): boolean {
  const seen = new Set<object>();
  const stack: object[] = [v];
  while (stack.length > 0) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    if (!Object.isFrozen(x)) return false;
    for (const k of Object.keys(x)) {
      const c: unknown = (x as Record<string, unknown>)[k];
      if (typeof c === 'object' && c !== null) stack.push(c);
    }
  }
  return true;
}

/**
 * Tier 2 for `surface.rules` (§1.7): the issues of the source tree `source` (frozen, never empty when invalid; [] when
 * valid). Never throws. Memoised by identity for deep-frozen trees.
 */
export function validateRulesSource(source: unknown): readonly RulesSourceIssue[] {
  const key = typeof source === 'object' && source !== null ? source : null;
  if (key !== null) {
    const hit = MEMO.get(key);
    if (hit !== undefined) return hit;
  }
  validations++;
  const found: RulesSourceIssue[] = VALIDATE(source, NOISES, MODE);
  if (found.length === 0) {
    const cost = COLUMN_COST(source);
    if (cost > COLUMN_COST_MAX) {
      found.push({ path: '', code: 'COLUMN_COST', message: `column cost ${cost} is above ${COLUMN_COST_MAX} (64 × the default tree's)` });
    }
  }
  const issues = found.length <= MAX_ISSUES
    ? found
    : [...found.slice(0, MAX_ISSUES), { path: '', code: 'TOO_MANY_ISSUES' as const, message: `${found.length - MAX_ISSUES} more` }];
  for (const i of issues) Object.freeze(i);
  const result = Object.freeze(issues);
  if (key !== null && deepFrozen(key)) MEMO.set(key, result);
  return result;
}

/** How many times `validateRulesSource` validated a tree (memo misses); for the tests of the memo (§1.8). */
export function rulesSourceValidations(): number {
  return validations;
}

/** True for a plain object (prototype Object.prototype or null) or an array: the containers a rule tree is made of. */
function isTreeContainer(v: unknown): v is object {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return true;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-freezes `tree` in place and returns it (§1.6, D10): an iterative walk over its plain objects and arrays that,
 * unlike `deepFreeze`, does not stop at an already-frozen node (a partly frozen tree ends frozen at every depth). Shared
 * and cyclic sub-objects are visited once; other values are left alone. Identity and values are unchanged.
 */
export function freezeRules<T>(tree: T): T {
  if (!isTreeContainer(tree)) return tree;
  const seen = new Set<object>();
  const stack: object[] = [tree];
  while (stack.length > 0) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    Object.freeze(x);
    for (const k of Object.keys(x)) {
      const c: unknown = (x as Record<string, unknown>)[k];
      if (isTreeContainer(c)) stack.push(c);
    }
  }
  return tree;
}

/** A ref's value in `params` (§1.3): the target's value v, or 0 − v with `neg`. Only called on a validated tree. */
function refValue(ref: Record<string, unknown>, params: Params): number {
  const path = ref['param'] as string;
  const v = GET_PATH(params, path);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`resolveRules: ${path} is not a finite number in params`);
  return ref['neg'] === true ? 0 - v : v;
}

/**
 * A fresh frozen copy of the validated node `v`: every object without a `kind` (after validation, exactly the refs in
 * the nine numeric fields) becomes its number. Recursion is bounded by `validateRules`' depth limit (32 nodes).
 */
function resolveNode(v: unknown, params: Params): unknown {
  if (Array.isArray(v)) return Object.freeze(v.map((x: unknown) => resolveNode(x, params)));
  if (typeof v !== 'object' || v === null) return v;
  const o = v as Record<string, unknown>;
  if (!Object.hasOwn(o, 'kind')) return refValue(o, params);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = resolveNode(o[k], params);
  return Object.freeze(out);
}

/**
 * The rule tree of the source `source` for `params` (§1.6): tier 2 first (`validateRulesSource`, memoised for frozen
 * sources; a RuleValidationError listing its issues with their source paths when it fails), then a fresh deep-frozen
 * tree with every ref replaced by its number (`0 − v` for `neg`, never −0). The source is not modified.
 */
export function resolveRules(source: unknown, params: Params): Rule {
  const issues = validateRulesSource(source);
  if (issues.length > 0) throw new INVALID(issues);
  return resolveNode(source, params) as Rule;
}

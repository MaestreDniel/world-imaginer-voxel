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
 * Follows the gen determinism rules.
 */
import { RULES_COLUMN_COST_MAX } from '../../core/constants';
import { NOISE_FIELD_RANGES, SCHEMA } from '../../core/params/schema';
import { ALLOWED_REF_TARGETS } from '../density/source';
import { rulesColumnCost } from '../inspect/cost';
import {
  validateRules, type RuleErrorCode, type RuleRefCode, type RuleRefTarget, type RuleSourceMode, type SurfaceNoiseInfo,
  type SurfaceNoiseLookup,
} from './rules';

const SCHEMA_ = SCHEMA;
const REF_TARGETS = ALLOWED_REF_TARGETS;
const NOISE_RANGES = NOISE_FIELD_RANGES;
const VALIDATE = validateRules;
const COLUMN_COST = rulesColumnCost;
const COLUMN_COST_MAX = RULES_COLUMN_COST_MAX;

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

/**
 * The density source model (SP3d spec §1.3-§1.5, §1.7): the tree the `density.defs` leaf holds, before resolution.
 * It is SP3b's `DensityExpr` plus three source-only forms, resolved away before compilation (D5), so `EXPR_OPS`, the
 * compiler, the bounds and the reference never see them:
 * - the op `{op: 'param', path}`, a leaf standing where a `const` would, whose value is a parameter's;
 * - the op `{op: 'recip', x}`, `1 / x` of a constant operand (a `const`, or a `param` whose static range excludes 0);
 * - tap `mute` (the tap yields the mute value instead of its child), and the ref form `{param, neg?}` in every numeric
 *   scalar field (`clamp` and `rangeChoice` bounds, each knot's y and v, `mute`); `const.v` stays a literal.
 * A ref names one of `ALLOWED_REF_TARGETS`: the `number` and `int` leaves under `density.` and `surface.` and the
 * `clampSigma` field of their noise leaves, each with its static range (value-independence, §1.3: every check holds over
 * the whole range, so a slider move never invalidates a stored tree).
 *
 * `validateDensitySource` is tier 2 for density (§1.7): it never throws, returns at most 50 issues (then one
 * `TOO_MANY_ISSUES` at the value, "N more") with node paths in `validateExpr`'s syntax, and is memoised by identity for
 * frozen sources (tier 1's clones are deep-frozen), so a params document whose tree is unchanged costs one `WeakMap`
 * lookup. Every lookup keyed by tree content is a `Map`, a `Set` or `Object.hasOwn` (`constructor`, `toString`, … are
 * valid names).
 */
import { NOISE_FIELD_RANGES, SCHEMA } from '../../core/params/schema';
import type { SampleField } from '../column/columnStage';
import { EXPR_CHILD_KEYS, EXPR_OPS, validateExpr, type DensityNoiseInfo, type ExprIssue, type ExprOp, type RefTarget } from './expr';

const SCHEMA_ = SCHEMA;
const NOISE_RANGES = NOISE_FIELD_RANGES;
const EXPR_CHILDREN = EXPR_CHILD_KEYS;
const OPS = EXPR_OPS;
const VALIDATE = validateExpr;

/** A numeric field of a source node: a literal, or a parameter ref (`neg`: the value is 0 − v, never −0). */
export interface ParamRef { readonly param: string; readonly neg?: true }
export type SourceNumber = number | ParamRef;

export interface SourceConst { readonly op: 'const'; readonly v: number }
export interface SourceY { readonly op: 'y' }
export interface SourceCol { readonly op: 'col'; readonly field: SampleField }
export interface SourceNoise2 { readonly op: 'noise2'; readonly id: string }
export interface SourceNoise { readonly op: 'noise'; readonly id: string }
export interface SourceBinary { readonly op: 'add' | 'mul' | 'min' | 'max'; readonly a: SourceExpr; readonly b: SourceExpr }
export interface SourceUnary { readonly op: 'neg' | 'abs' | 'square'; readonly x: SourceExpr }
export interface SourceClamp { readonly op: 'clamp'; readonly x: SourceExpr; readonly lo: SourceNumber; readonly hi: SourceNumber }
export type SourceKnot = readonly [y: SourceNumber, v: SourceNumber];
export interface SourceSlide { readonly op: 'slide'; readonly x: SourceExpr; readonly knots: readonly SourceKnot[] }
export interface SourceInterpolated { readonly op: 'interpolated'; readonly x: SourceExpr }
export interface SourceRangeChoice {
  readonly op: 'rangeChoice'; readonly x: SourceExpr; readonly lo: SourceNumber; readonly hi: SourceNumber;
  readonly inside: SourceExpr; readonly outside: SourceExpr;
}
export interface SourceTap { readonly op: 'tap'; readonly name: string; readonly x: SourceExpr; readonly mute?: SourceNumber }
export interface SourceRef { readonly op: 'ref'; readonly name: string }
/** A parameter's value, as a leaf node (resolved to a `const`). */
export interface SourceParam { readonly op: 'param'; readonly path: string }
/** 1 / x of a constant operand (resolved to a `const`). */
export interface SourceRecip { readonly op: 'recip'; readonly x: SourceConst | SourceParam }

export type SourceExpr =
  | SourceConst | SourceY | SourceCol | SourceNoise2 | SourceNoise | SourceBinary | SourceUnary | SourceClamp | SourceSlide
  | SourceInterpolated | SourceRangeChoice | SourceTap | SourceRef | SourceParam | SourceRecip;
export type SourceOp = SourceExpr['op'];

/** The `density.defs` leaf's value: the root and its named sub-expressions, in source form. */
export interface DensitySource {
  readonly root: SourceExpr;
  readonly defs: Readonly<Record<string, SourceExpr>>;
}

/** Every source op: `EXPR_OPS`, then the source-only `recip` and `param`. */
export const SOURCE_OPS: readonly SourceOp[] = Object.freeze([...OPS, 'recip', 'param'] as const);

/**
 * The child slots of each source op in evaluation order: `EXPR_CHILD_KEYS` plus `recip: ['x']` and `param: []`. A frozen
 * object without a prototype, so a lookup by an op read from a tree (`constructor`, `toString`) is undefined.
 */
export const SOURCE_CHILD_KEYS: { readonly [K in SourceOp]: readonly string[] } = Object.freeze(Object.assign(
  Object.create(null) as Record<SourceOp, readonly string[]>,
  EXPR_CHILDREN as { readonly [K in ExprOp]: readonly string[] },
  { recip: Object.freeze(['x']), param: Object.freeze([] as string[]) },
));

/**
 * The parameters a ref may name (§1.3), by schema path, in schema order: every `number` / `int` leaf under `density.`
 * or `surface.` with its `[min, max]`, and `<noise leaf>.clampSigma` for every noise leaf under `density.noises.` and
 * `surface.noises.` with `NOISE_FIELD_RANGES.clampSigma`. Built from the schema's leaves, never from `getPath` (which
 * would read anything). Every target is hashed by the `terrain` stage.
 */
export const ALLOWED_REF_TARGETS: ReadonlyMap<string, RefTarget> = (() => {
  const out = new Map<string, RefTarget>();
  const add = (path: string, kind: RefTarget['kind'], lo: number | undefined, hi: number | undefined): void => {
    if (lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      throw new Error(`ref target ${path} has no finite static range`);
    }
    out.set(path, Object.freeze({ kind, lo, hi }));
  };
  for (const { path, meta } of SCHEMA_.leaves) {
    if (!path.startsWith('density.') && !path.startsWith('surface.')) continue;
    if (meta.kind === 'number' || meta.kind === 'int') add(path, meta.kind, meta.min, meta.max);
    else if (meta.kind === 'noise' && (path.startsWith('density.noises.') || path.startsWith('surface.noises.'))) {
      add(`${path}.clampSigma`, 'number', NOISE_RANGES.clampSigma.min, NOISE_RANGES.clampSigma.max);
    }
  }
  return out;
})();

/**
 * The density noises a source tree may read, by id, with what validation needs, value-independently: the schema's
 * `density.noises.*` leaves at their dims; remap 'none' when the leaf keeps it (`remapNone`, every density noise), else
 * 'uniform' (a remap the user could switch is refused); clampSigma at its static maximum.
 */
const SOURCE_NOISES: ReadonlyMap<string, DensityNoiseInfo> = (() => {
  const out = new Map<string, DensityNoiseInfo>();
  const prefix = 'density.noises.';
  for (const { path, leaf } of SCHEMA_.leaves) {
    if (leaf.kind !== 'noise' || !path.startsWith(prefix)) continue;
    out.set(path.slice(prefix.length), Object.freeze({
      dims: leaf.dims ?? 2, remap: leaf.remapNone === true ? 'none' : 'uniform', clampSigma: NOISE_RANGES.clampSigma.max,
    }));
  }
  return out;
})();
const SOURCE_MODE = Object.freeze({ targets: ALLOWED_REF_TARGETS });
const noiseInfo = (id: string): DensityNoiseInfo | undefined => SOURCE_NOISES.get(id);

/** Tier 2 keeps at most this many issues, then one `TOO_MANY_ISSUES` (as tier 1, §1.7). */
const MAX_ISSUES = 50;

const MEMO = new WeakMap<object, readonly ExprIssue[]>();
let validations = 0;

/**
 * Tier 2 for a density source tree (§1.7; this task: step 1, per-node structure, and step 3's refs): `validateExpr`'s
 * source mode over the schema's density noises and `ALLOWED_REF_TARGETS`. Never throws; at most 50 issues, then
 * `{path: '', code: 'TOO_MANY_ISSUES', message: '<N> more'}`. The result (frozen, as are its issues) is memoised by
 * identity when `source` is a frozen object: validity is a pure function of the tree, so a frozen tree is validated once.
 */
export function validateDensitySource(source: unknown): readonly ExprIssue[] {
  const key = typeof source === 'object' && source !== null && Object.isFrozen(source) ? source : null;
  if (key !== null) {
    const hit = MEMO.get(key);
    if (hit !== undefined) return hit;
  }
  validations++;
  const all = VALIDATE(source, noiseInfo, SOURCE_MODE);
  const kept: ExprIssue[] = all.length > MAX_ISSUES ? all.slice(0, MAX_ISSUES) : all;
  if (all.length > MAX_ISSUES) kept.push({ path: '', code: 'TOO_MANY_ISSUES', message: `${all.length - MAX_ISSUES} more` });
  const out = Object.freeze(kept.map((i) => Object.freeze(i)));
  if (key !== null) MEMO.set(key, out);
  return out;
}

/** How many times `validateDensitySource` validated (memo misses), for the tests of the memo (§1.8). */
export function densitySourceValidations(): number {
  return validations;
}

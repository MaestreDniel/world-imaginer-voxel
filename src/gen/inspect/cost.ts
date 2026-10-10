/**
 * The costs of density and surface-rule trees (SP3d spec §1.7 "Costs" and "The two column-cost maxima", §5.2): one
 * function per cost, the only implementation of it, shared by tier 2 (`gen/density/source.ts`, `gen/surface/source.ts`),
 * the UI and the worker.
 * - `structuralCost(node, defs)`: 1 per node plus its children's costs; a `ref` costs its def; `interpolated` costs
 *   1 + 8 × its child (eight corners per voxel); a muted tap counts its child (mutes ignored). Value-independent.
 * - `workCost(expr, params)`: the structural cost of an evaluated expression with every `noise` / `noise2` weighted
 *   4 × octaves × (double ? 2 : 1) of its configured `density.noises.<id>` leaf (§5.2).
 * - `densityColumnCost(source)`: the source structure with mutes applied and refs expanded (no value is read), every
 *   noise at its static maximum weight (16 octaves, double), every node at voxel placement counted 98,304 times (a
 *   chunk column) and every node under `interpolated` 1,225 times (25 × 49 quart corners).
 * - `rulesColumnCost(source)`: the rule and condition node count times the voxels a column evaluates: 98,304 without a
 *   fast path, or 256 × (1 + the fast path's largest depth bound) with one (SP3c §3.4), each ref at the end of its
 *   static range that maximises the bound and SD_MAX at its static maximum.
 * The weights and factors are module-private (gen exports no numbers); every sum and product saturates at 2^31.
 *
 * Trees are read as JSON values (a source tree, a resolved or a code-built one), never trusted: every walk is iterative
 * (no recursion, whatever the depth), every lookup keyed by tree content is own-property only (`constructor`,
 * `toString`, … are valid def names), nothing throws. A value that is not a plain object is not a node (0); a node of an
 * unknown op has no children; a `ref` to a missing def counts as one node; a ref cycle saturates. Tier 2 refuses all of
 * these anyway: the costs only have to stay finite and deterministic on them.
 */
import { NOISE_FIELD_RANGES, SCHEMA, type Params } from '../../core/params/schema';
import { EXPR_CHILD_KEYS } from '../density/expr';
import { surfaceDepthMax } from '../surface/scan';

const SCHEMA_ = SCHEMA;
const NOISE_RANGES = NOISE_FIELD_RANGES;
const EXPR_CHILDREN = EXPR_CHILD_KEYS;
const SD_MAX_OF = surfaceDepthMax;

type Rec = Readonly<Record<string, unknown>>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every sum and product saturates here (2^31). */
const SATURATE = 2147483648;
/** Voxels of a chunk column (16 · 16 · 384) and quart corners of a chunk column (5 · 5 · 49). */
const COLUMN_VOXELS = 98304;
const COLUMN_CORNERS = 1225;
/** Positions of a chunk column: a fast-path tree evaluates the top 1 + maxSurfaceDepth voxels of each. */
const COLUMN_POSITIONS = 256;
/** A noise evaluation costs 4 units per octave per stack (§5.2). */
const NOISE_UNITS_PER_OCTAVE = 4;

const sat = (v: number): number => (v < SATURATE ? v : SATURATE);

/** Source child slots: the Expr ops' slots plus the source ops `recip` and `param` (§1.3, §1.4). */
const CHILD_KEYS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...Object.entries(EXPR_CHILDREN), ['recip', ['x']], ['param', []],
]);
const NO_KEYS: readonly string[] = [];

/** The schema's ref targets (§1.3) and their static ranges: number and int leaves under `density.` and `surface.`, and
 * the `clampSigma` field of their noise leaves. */
const TARGET_RANGES: ReadonlyMap<string, readonly [lo: number, hi: number]> = (() => {
  const out = new Map<string, readonly [number, number]>();
  for (const { path, meta } of SCHEMA_.leaves) {
    if (!path.startsWith('density.') && !path.startsWith('surface.')) continue;
    if ((meta.kind === 'number' || meta.kind === 'int') && meta.min !== undefined && meta.max !== undefined) out.set(path, [meta.min, meta.max]);
    else if (meta.kind === 'noise') out.set(`${path}.clampSigma`, [NOISE_RANGES.clampSigma.min, NOISE_RANGES.clampSigma.max]);
  }
  return out;
})();

/** A noise at its static maximum: 16 octaves, double. */
const NOISE_MAX_WEIGHT = NOISE_UNITS_PER_OCTAVE * NOISE_RANGES.octaves.max * 2;
/** SD_MAX at its static maximum: depthMul and the depth noise's clampSigma at the top of their ranges (47). */
const SD_MAX_STATIC = SD_MAX_OF(TARGET_RANGES.get('surface.depthMul')![1], NOISE_RANGES.clampSigma.max);

const opOf = (n: Rec): string | undefined => (Object.hasOwn(n, 'op') && typeof n['op'] === 'string' ? n['op'] : undefined);
const isNoise = (op: string | undefined): boolean => op === 'noise' || op === 'noise2';

/** How a density cost weighs a node. */
interface Model {
  /** The node's own cost at voxel (false) or corner (true) placement; never called for a resolved `ref`. */
  own(n: Rec, op: string | undefined, corner: boolean): number;
  /** The factor on the sum of the children's costs. */
  factor(op: string | undefined): number;
  /** Mutes applied (a muted tap's child is a `const`) or ignored (the tap counts its child). */
  readonly mutes: boolean;
}

/** The child of a muted tap when mutes are applied. */
const MUTE_CONST: Rec = Object.freeze({ op: 'const' });

interface Frame {
  readonly own: number;
  readonly factor: number;
  readonly corner: boolean;
  readonly kids: readonly unknown[];
  /** The def this frame evaluates (memoised when it completes), or null. */
  readonly def: string | null;
  i: number;
  sum: number;
}

/**
 * The cost of `root` under `model`, refs resolved through `defs` (own properties only), by an explicit-stack post-order
 * walk with one memo per (def, placement); a def met again while it is being costed is a cycle and saturates.
 */
function treeCost(root: unknown, defs: unknown, model: Model): number {
  const memo = [new Map<string, number>(), new Map<string, number>()];
  const busy = [new Set<string>(), new Set<string>()];
  const frames: Frame[] = [{ own: 0, factor: 1, corner: false, kids: [root], def: null, i: 0, sum: 0 }];
  /** Starts a child: its cost when known at once, else a frame is pushed and undefined returned. */
  const start = (v: unknown, corner: boolean): number | undefined => {
    if (!isRec(v)) return 0;
    const op = opOf(v);
    const p = corner ? 1 : 0;
    if (op === 'ref') {
      const name = v['name'];
      if (typeof name !== 'string' || !isRec(defs) || !Object.hasOwn(defs, name)) return model.own(v, op, corner);
      const hit = memo[p]!.get(name);
      if (hit !== undefined) return hit;
      if (busy[p]!.has(name)) return SATURATE;
      busy[p]!.add(name);
      frames.push({ own: 0, factor: 1, corner, kids: [defs[name]], def: name, i: 0, sum: 0 });
      return undefined;
    }
    const keys = (op === undefined ? undefined : CHILD_KEYS.get(op)) ?? NO_KEYS;
    const kids: unknown[] = [];
    if (op === 'tap' && model.mutes && Object.hasOwn(v, 'mute')) kids.push(MUTE_CONST);
    else for (const k of keys) kids.push(Object.hasOwn(v, k) ? v[k] : undefined);
    const own = model.own(v, op, corner);
    if (kids.length === 0) return own;
    frames.push({ own, factor: model.factor(op), corner: corner || op === 'interpolated', kids, def: null, i: 0, sum: 0 });
    return undefined;
  };
  for (;;) {
    const f = frames[frames.length - 1]!;
    if (f.i < f.kids.length) {
      const v = start(f.kids[f.i++], f.corner);
      if (v !== undefined) f.sum = sat(f.sum + v);
      continue;
    }
    frames.pop();
    const value = sat(f.own + sat(f.factor * f.sum));
    if (f.def !== null) {
      const p = f.corner ? 1 : 0;
      busy[p]!.delete(f.def);
      memo[p]!.set(f.def, value);
    }
    if (frames.length === 0) return value;
    const parent = frames[frames.length - 1]!;
    parent.sum = sat(parent.sum + value);
  }
}

const STRUCTURAL: Model = {
  own: () => 1,
  factor: (op) => (op === 'interpolated' ? 8 : 1),
  mutes: false,
};

/**
 * The structural cost of the source subtree `node` (§1.7): 1 per node plus its children's costs, a `ref` costing its
 * def in `defs` (the tree's `defs` object), `interpolated` 1 + 8 × its child, a muted tap its child; saturating at
 * 2^31. The default tree's root costs 333 (source) and 322 (resolved).
 */
export function structuralCost(node: unknown, defs?: unknown): number {
  return treeCost(node, defs, STRUCTURAL);
}

/** 4 × octaves × (double ? 2 : 1) of the density noise leaf `id`; a noise the params do not hold weighs its maximum. */
function noiseWeight(params: Params, id: unknown): number {
  const noises: Rec = params.density.noises;
  if (typeof id !== 'string' || !Object.hasOwn(noises, id)) return NOISE_MAX_WEIGHT;
  const n = noises[id];
  if (!isRec(n) || typeof n['octaves'] !== 'number') return NOISE_MAX_WEIGHT;
  return NOISE_UNITS_PER_OCTAVE * n['octaves'] * (n['double'] === true ? 2 : 1);
}

/**
 * The work cost of the evaluated expression `expr` = {root, defs} (§5.2) under `params`: the structural cost with every
 * `noise` / `noise2` weighted by its configured leaf (a default `jag` or `overhang` costs 16, `detail` 8); saturating at
 * 2^31. The default root costs 569 at the default noises (322 structural units, 17 of them noise evaluations).
 */
export function workCost(expr: unknown, params: Params): number {
  if (!isRec(expr)) return 0;
  const model: Model = {
    own: (n, op) => (isNoise(op) ? noiseWeight(params, n['id']) : 1),
    factor: STRUCTURAL.factor,
    mutes: false,
  };
  return treeCost(Object.hasOwn(expr, 'root') ? expr['root'] : undefined, Object.hasOwn(expr, 'defs') ? expr['defs'] : undefined, model);
}

const DENSITY_COLUMN: Model = {
  own: (_n, op, corner) => (isNoise(op) ? NOISE_MAX_WEIGHT : 1) * (corner ? COLUMN_CORNERS : COLUMN_VOXELS),
  factor: () => 1,
  mutes: true,
};

/**
 * The density column cost of the source `{root, defs}` (§1.7 tier 2 step 5): the root's nodes with mutes applied and
 * refs expanded, each noise at its static maximum weight (128), each node at voxel placement × 98,304 and under
 * `interpolated` × 1,225; value-independent, saturating at 2^31. Tier 2 refuses it above `DENSITY_COLUMN_COST_MAX`.
 */
export function densityColumnCost(source: unknown): number {
  if (!isRec(source)) return 0;
  return treeCost(Object.hasOwn(source, 'root') ? source['root'] : undefined, Object.hasOwn(source, 'defs') ? source['defs'] : undefined, DENSITY_COLUMN);
}

/** The largest value a numeric rule field can take: a literal, or a ref at the top of its static range (`neg`: 0 − lo). */
function fieldMax(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Infinity;
  if (!isRec(v) || !Object.hasOwn(v, 'param') || typeof v['param'] !== 'string') return Infinity;
  const r = TARGET_RANGES.get(v['param']);
  if (r === undefined) return Infinity;
  return Object.hasOwn(v, 'neg') && v['neg'] === true ? 0 - r[0] : r[1];
}

const kindOf = (n: Rec): string | undefined => (Object.hasOwn(n, 'kind') && typeof n['kind'] === 'string' ? n['kind'] : undefined);
const field = (n: Rec, k: string): unknown => (Object.hasOwn(n, k) ? n[k] : undefined);

/** A Y-only condition (the compiler's `isYOnly`): a `verticalGradient`, a `yAbove{runTop false}`, or a `not` of one. */
function isYOnly(c: unknown): boolean {
  let x = c;
  for (;;) {
    if (!isRec(x)) return false;
    const k = kindOf(x);
    if (k === 'verticalGradient') return true;
    if (k === 'yAbove') return field(x, 'runTop') === false;
    if (k !== 'not') return false;
    x = field(x, 'if');
  }
}

interface RulePath {
  readonly rule: unknown;
  /** The smallest floor `stoneDepth` bound among the path's conditions (+∞ when none). */
  readonly bound: number;
  /** A floor `stoneDepth` is on the path. */
  readonly bounded: boolean;
  /** Every condition on the path is Y-only. */
  readonly yOnly: boolean;
}

/**
 * The rules column cost of the source root rule (§1.7 `validateRulesSource`): the rule and condition node count times
 * the voxels a column evaluates, 98,304 without a fast path, or 256 × (1 + the largest depth bound) with one (a leaf
 * bounded by its path's floor `stoneDepth` conditions: offset at its maximising end plus SD_MAX's static maximum when
 * `addSurfaceDepth`; else its conditions must all be Y-only, as `surfaceFastPath` decides), the depth bound clamped
 * to 0 … 383 so the factor never exceeds a whole column; saturating at 2^31. Tier 2 refuses it above
 * `RULES_COLUMN_COST_MAX`.
 */
export function rulesColumnCost(source: unknown): number {
  let nodes = 0;
  let fast = true;
  let maxBound = -1;
  const stack: RulePath[] = [{ rule: source, bound: Infinity, bounded: false, yOnly: true }];
  while (stack.length > 0) {
    const { rule, bound, bounded, yOnly } = stack.pop()!;
    if (!isRec(rule)) continue;
    nodes++;
    switch (kindOf(rule)) {
      case 'sequence': {
        const rules = field(rule, 'rules');
        if (!Array.isArray(rules)) break;
        for (let k = rules.length - 1; k >= 0; k--) stack.push({ rule: rules[k], bound, bounded, yOnly });
        break;
      }
      case 'condition': {
        const c = field(rule, 'if');
        for (let x = c; isRec(x); x = kindOf(x) === 'not' ? field(x, 'if') : undefined) nodes++;
        let b = bound;
        let bd = bounded;
        if (isRec(c) && kindOf(c) === 'stoneDepth' && field(c, 'side') === 'floor') {
          b = Math.min(b, fieldMax(field(c, 'offset')) + (field(c, 'addSurfaceDepth') === true ? SD_MAX_STATIC : 0));
          bd = true;
        }
        stack.push({ rule: field(rule, 'then'), bound: b, bounded: bd, yOnly: yOnly && isYOnly(c) });
        break;
      }
      case 'block': case 'bandlands':
        if (bounded) maxBound = Math.max(maxBound, bound);
        else if (!yOnly) fast = false;
        break;
      default: break;
    }
  }
  const perNode = fast ? Math.min(COLUMN_VOXELS, COLUMN_POSITIONS * (1 + Math.max(0, maxBound))) : COLUMN_VOXELS;
  return sat(nodes * perNode);
}

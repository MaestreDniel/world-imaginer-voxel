/**
 * The costs of density and surface-rule trees (SP3d spec §1.7 "Costs" and "The two column-cost maxima", §5.2): one
 * function per cost, the only implementation of it, shared by tier 2 (`gen/density/source.ts`, `gen/surface/source.ts`),
 * the UI and the worker.
 * - `structuralCost(node, defs)`: 1 per node plus its children's costs; a `ref` costs its def; `interpolated` costs
 *   1 + 8 × its child (eight corners per voxel); a muted tap counts its child (mutes ignored). Value-independent.
 * - `workCost(expr, params)`: the structural cost of an evaluated expression with every `noise` / `noise2` (and SP6a's
 *   `noiseScaled`, its spec §1.5) weighted 4 × octaves × (double ? 2 : 1) of its configured `density.noises.<id>` leaf,
 *   else its `caves.noises.<id>` leaf (SP6a spec §1.5) (§5.2).
 * - `memoWorkCost(expr, params)` (SP6a spec §7.4): `workCost` split for the slice reference's corner memo, the voxel
 *   part of one sample (every `interpolated` node costing 1, its child left to the corners) and the corner part of one
 *   memoised corner (each distinct `interpolated` node's child and each def reachable at corner placement once).
 * - `densityColumnCost(source)`: the source structure with mutes applied and refs expanded (no value is read), every
 *   noise at its static maximum weight (16 octaves, double), every node at voxel placement counted 98,304 times (a
 *   chunk column) and every node under `interpolated` 1,225 times (25 × 49 quart corners).
 * - `rulesColumnCost(source)`: the rule and condition node count times the voxels a column evaluates: 98,304 without a
 *   fast path, or 256 × (1 + the fast path's largest depth bound) with one (SP3c §3.4), each ref at the end of its
 *   static range that maximises the bound and SD_MAX at its static maximum.
 * - `tColumnCost(params)` (§5.2, the `blocks` and `rule` slice fields): one T column's work, the density column cost
 *   of `density.defs` with the configured noise weights (`densityColumnCost(source, params)`) plus the rules column
 *   cost of `surface.rules`; `ruleNodeCount(source)` is the rule and condition count both rule costs use.
 * The slice column cost (`sliceCostOf`) composes these with the evaluated expression of a field, which needs the
 * resolvers of `gen/density/source.ts`; that module imports this one (tier 2's costs), so `sliceCostOf` lives in
 * `gen/inspect/fieldSlice.ts` to keep the import graph acyclic.
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
/** Positions of a chunk column: a fast-path tree evaluates 1 + its largest depth bound voxels of each. */
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
/** A noise read, weighed as one: `noise`, `noise2` and `noiseScaled` (SP6a spec §1.5: the cost weight of `noise`). */
const isNoise = (op: string | undefined): boolean => op === 'noise' || op === 'noise2' || op === 'noiseScaled';

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
 * 2^31. The default tree's root costs 2,522 (source) and 2,455 (resolved) with SP6a's cave terms (333 and 322 in SP5c).
 */
export function structuralCost(node: unknown, defs?: unknown): number {
  return treeCost(node, defs, STRUCTURAL);
}

/**
 * 4 × octaves × (double ? 2 : 1) of the density noise leaf `id`, looked up under `density.noises` and then under
 * `caves.noises` (SP6a spec §1.5); a noise the params do not hold weighs its maximum.
 */
function noiseWeight(params: Params, id: unknown): number {
  if (typeof id !== 'string') return NOISE_MAX_WEIGHT;
  const density: Rec = params.density.noises;
  const caves: Rec = params.caves.noises;
  const noises = Object.hasOwn(density, id) ? density : Object.hasOwn(caves, id) ? caves : null;
  if (noises === null) return NOISE_MAX_WEIGHT;
  const n = noises[id];
  if (!isRec(n) || typeof n['octaves'] !== 'number') return NOISE_MAX_WEIGHT;
  return NOISE_UNITS_PER_OCTAVE * n['octaves'] * (n['double'] === true ? 2 : 1);
}

/**
 * The work cost of the evaluated expression `expr` = {root, defs} (§5.2) under `params`: the structural cost with every
 * `noise` / `noise2` weighted by its configured leaf (a default `jag` or `overhang` costs 16, `detail` 8); saturating at
 * 2^31. The default root costs 4,366 at the default noises (2,455 structural units, 209 of them noise evaluations; 574
 * and 327 before SP6a's cave terms, 569 and 322 before its root slots).
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

/** `memoWorkCost`'s parts: one sample's voxel work and one memoised corner's work. */
export interface MemoWork {
  readonly voxel: number;
  readonly corner: number;
}

/**
 * The work of the evaluated expression `expr` = {root, defs} under the slice reference's corner memo (SP6a spec §7.4),
 * with `workCost`'s weights (noise leaves, mutes ignored), saturating at 2^31:
 * - `voxel`: one sample's work at voxel placement, `workCost` with every `interpolated` node costing 1 and its child
 *   nothing (refs expanded per read, as the reference walks them);
 * - `corner`: one memoised corner's work, the child of each distinct `interpolated` node (by identity) reachable at
 *   voxel placement plus each def reachable from them at corner placement, every one counted once (a `ref` there costs
 *   nothing beyond its def's single count; a ref to a missing def costs 1, as in `workCost`).
 * A sample column whose samples read K distinct corners costs at most n × voxel + K × corner (`sliceCostOf`), never
 * more than `workCost`'s n × (voxel + 8 × the children's expanded cost). The default root: 179 per sample and 1,104
 * per corner at the default noises (`workCost` 17,451 = 179 + 8 × 2,159: the CSE of its defs at a corner).
 */
export function memoWorkCost(expr: unknown, params: Params): MemoWork {
  if (!isRec(expr)) return { voxel: 0, corner: 0 };
  const root = Object.hasOwn(expr, 'root') ? expr['root'] : undefined;
  const defs = Object.hasOwn(expr, 'defs') ? expr['defs'] : undefined;
  const weigh = (n: Rec, op: string | undefined): number => (isNoise(op) ? noiseWeight(params, n['id']) : 1);
  const voxel = treeCost(root, defs, { own: weigh, factor: (op) => (op === 'interpolated' ? 0 : 1), mutes: false });
  const hasDef = (name: unknown): name is string => typeof name === 'string' && isRec(defs) && Object.hasOwn(defs, name);
  const defOf = (name: string): unknown => (defs as Rec)[name];
  // The distinct interpolated nodes reachable at voxel placement (through refs, each def entered once).
  const nodes = new Set<Rec>();
  const entered = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (!isRec(v)) continue;
    const op = opOf(v);
    if (op === 'interpolated') { nodes.add(v); continue; }
    if (op === 'ref') {
      const name = v['name'];
      if (hasDef(name) && !entered.has(name)) { entered.add(name); stack.push(defOf(name)); }
      continue;
    }
    for (const k of (op === undefined ? undefined : CHILD_KEYS.get(op)) ?? NO_KEYS) if (Object.hasOwn(v, k)) stack.push(v[k]);
  }
  // Each node's child, then each def met at corner placement, walked once; refs queue their def.
  let corner = 0;
  const queued = new Set<string>();
  const defsToCost: string[] = [];
  const walk = (start: unknown): void => {
    const st: unknown[] = [start];
    while (st.length > 0) {
      const v = st.pop();
      if (!isRec(v)) continue;
      const op = opOf(v);
      if (op === 'ref') {
        const name = v['name'];
        if (!hasDef(name)) corner = sat(corner + weigh(v, op));
        else if (!queued.has(name)) { queued.add(name); defsToCost.push(name); }
        continue;
      }
      corner = sat(corner + weigh(v, op));
      for (const k of (op === undefined ? undefined : CHILD_KEYS.get(op)) ?? NO_KEYS) if (Object.hasOwn(v, k)) st.push(v[k]);
    }
  };
  for (const node of nodes) walk(Object.hasOwn(node, 'x') ? node['x'] : undefined);
  for (let i = 0; i < defsToCost.length; i++) walk(defOf(defsToCost[i]!));
  return { voxel, corner };
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
 * With `params`, each noise weighs its configured leaf instead (as `workCost`; §5.2's T column work for the `blocks`
 * and `rule` slice fields).
 */
export function densityColumnCost(source: unknown, params?: Params): number {
  if (!isRec(source)) return 0;
  const model: Model = params === undefined ? DENSITY_COLUMN : {
    own: (n, op, corner) => (isNoise(op) ? noiseWeight(params, n['id']) : 1) * (corner ? COLUMN_CORNERS : COLUMN_VOXELS),
    factor: DENSITY_COLUMN.factor,
    mutes: true,
  };
  return treeCost(Object.hasOwn(source, 'root') ? source['root'] : undefined, Object.hasOwn(source, 'defs') ? source['defs'] : undefined, model);
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

/** A here-only condition (the compiler's `isHereOnly`, SP6b §3.5 item 4): a `caveBiome{side here}`, or a `not` of one. */
function isHereOnly(c: unknown): boolean {
  let x = c;
  for (;;) {
    if (!isRec(x)) return false;
    const k = kindOf(x);
    if (k === 'caveBiome') return field(x, 'side') === 'here';
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
  /** The smallest ceiling `stoneDepth` bound among the path's conditions (+∞ when none; SP6b §3.5). */
  readonly ceilBound: number;
  /** A ceiling `stoneDepth` is on the path. */
  readonly ceilBounded: boolean;
  /** Every condition on the path is Y-only or here-only (a here-gated leaf, SP6b §3.5 item 4, when it has no depth gate). */
  readonly yOnly: boolean;
  /** The node is in the `then` of a condition whose `if` is here-only (SP6b's rulings P20: evaluated anywhere). */
  readonly underHere: boolean;
}

/**
 * The rules column cost of the source root rule (§1.7 `validateRulesSource`): each rule and condition node times the
 * voxels a column evaluates it at, 98,304 without a fast path, or with one 256 × (1 + the largest depth bound) (a leaf
 * bounded by its path's floor `stoneDepth` conditions, or with none of those by its ceiling ones (SP6b §3.5): offset
 * at its maximising end plus SD_MAX's static maximum when `addSurfaceDepth`; else its conditions must all be Y-only or
 * here-only (SP6b §3.5 item 4), as `surfaceFastPath` decides; the largest over the floor and ceiling classes, a
 * `caveBiome{floor | ceiling}`-gated leaf counted at its class's bound), the depth bound clamped to 0 … 383 so the
 * factor never exceeds a whole column, except the nodes in the `then` of a here-only condition, 98,304 each (SP6b's
 * rulings P20: the picker's classification may take them at any voxel); saturating at 2^31. Tier 2 refuses it above
 * `RULES_COLUMN_COST_MAX`.
 */
export function rulesColumnCost(source: unknown): number {
  const { nodes, hereNodes, perNode } = rulesCost(source);
  return sat((nodes - hereNodes) * perNode + hereNodes * COLUMN_VOXELS);
}

/** The rule and condition objects of the source root rule reached through `rules[]`, `then` and `if` (§5.2 `rule`). */
export function ruleNodeCount(source: unknown): number {
  return rulesCost(source).nodes;
}

/**
 * One T column's work (§5.2, the `blocks` and `rule` slice fields' per-column cost): the density column cost of
 * `params.density.defs` with the configured noise weights plus the rules column cost of `params.surface.rules`,
 * saturating at 2^31.
 */
export function tColumnCost(params: Params): number {
  return sat(densityColumnCost(params.density.defs, params) + rulesColumnCost(params.surface.rules));
}

/**
 * The node count, the nodes under a here-only condition and the voxels each other node is evaluated at per column (the
 * fast-path rule of `rulesColumnCost`).
 */
function rulesCost(source: unknown): { readonly nodes: number; readonly hereNodes: number; readonly perNode: number } {
  let nodes = 0;
  let hereNodes = 0;
  let fast = true;
  let maxBound = -1;
  const stack: RulePath[] = [
    { rule: source, bound: Infinity, bounded: false, ceilBound: Infinity, ceilBounded: false, yOnly: true, underHere: false },
  ];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const { rule, bound, bounded, ceilBound, ceilBounded, yOnly, underHere } = path;
    if (!isRec(rule)) continue;
    nodes++;
    if (underHere) hereNodes++;
    switch (kindOf(rule)) {
      case 'sequence': {
        const rules = field(rule, 'rules');
        if (!Array.isArray(rules)) break;
        for (let k = rules.length - 1; k >= 0; k--) stack.push({ ...path, rule: rules[k] });
        break;
      }
      case 'condition': {
        const c = field(rule, 'if');
        for (let x = c; isRec(x); x = kindOf(x) === 'not' ? field(x, 'if') : undefined) {
          nodes++;
          if (underHere) hereNodes++;
        }
        let b = bound;
        let bd = bounded;
        let cb = ceilBound;
        let cbd = ceilBounded;
        if (isRec(c) && kindOf(c) === 'stoneDepth') {
          const side = field(c, 'side');
          const d = fieldMax(field(c, 'offset')) + (field(c, 'addSurfaceDepth') === true ? SD_MAX_STATIC : 0);
          if (side === 'floor') {
            b = Math.min(b, d);
            bd = true;
          } else if (side === 'ceiling') {
            cb = Math.min(cb, d);
            cbd = true;
          }
        }
        const here = isHereOnly(c);
        stack.push({
          rule: field(rule, 'then'), bound: b, bounded: bd, ceilBound: cb, ceilBounded: cbd, yOnly: yOnly && (isYOnly(c) || here),
          underHere: underHere || here,
        });
        break;
      }
      case 'block': case 'bandlands': case 'strata':
        // A floor gate bounds the leaf whatever its ceiling gates (SP6b Spec correction 6); with neither, a Y-only or
        // here-gated leaf keeps the fast path (SP6b §3.5 item 4).
        if (bounded) maxBound = Math.max(maxBound, bound);
        else if (ceilBounded) maxBound = Math.max(maxBound, ceilBound);
        else if (!yOnly) fast = false;
        break;
      default: break;
    }
  }
  const perNode = fast ? Math.min(COLUMN_VOXELS, COLUMN_POSITIONS * (1 + Math.max(0, maxBound))) : COLUMN_VOXELS;
  return { nodes, hereNodes, perNode };
}

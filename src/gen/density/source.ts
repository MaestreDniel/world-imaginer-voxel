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
 * valid names). Its whole-tree bounds (node and def counts; per tree root, reachable or not, the expanded depth and the
 * structural cost; the column cost) bound everything that recurses through refs (the compiler, the reference,
 * `exprHash`, the bounds) and a column's work; its static magnitude analysis (§1.9 S, `VALUE_RANGE`) keeps every value
 * of a valid tree within ±1e100, so no NaN or ±∞ can occur; every walk of this module is iterative.
 */
import { COL_FIELD_BOUNDS, DENSITY_COLUMN_COST_MAX } from '../../core/constants';
import { NOISE_FIELD_RANGES, SCHEMA } from '../../core/params/schema';
import type { SampleField } from '../column/columnStage';
import { densityColumnCost, structuralCost } from '../inspect/cost';
import {
  EXPR_CHILD_KEYS, EXPR_OPS, nestedInterpolatedIssues, validateExpr, type DensityNoiseInfo, type ExprIssue, type ExprOp,
  type RefTarget,
} from './expr';
import {
  cornerY, ivAbs, ivAdd, ivClamp, ivHull, ivMax, ivMin, ivMul, ivNeg, ivSet, ivSquare, ivUnknown, ivWiden, rangeChoiceCase,
} from './nodes';

const SCHEMA_ = SCHEMA;
const NOISE_RANGES = NOISE_FIELD_RANGES;
const EXPR_CHILDREN = EXPR_CHILD_KEYS;
const OPS = EXPR_OPS;
const VALIDATE = validateExpr;
const NESTING = nestedInterpolatedIssues;
const STRUCTURAL_COST = structuralCost;
const COLUMN_COST = densityColumnCost;
const COLUMN_COST_MAX = DENSITY_COLUMN_COST_MAX;
const FIELD_BOUNDS = COL_FIELD_BOUNDS;
const CORNER_Y = cornerY;
const IV_ABS = ivAbs;
const IV_ADD = ivAdd;
const IV_CLAMP = ivClamp;
const IV_HULL = ivHull;
const IV_MAX = ivMax;
const IV_MIN = ivMin;
const IV_MUL = ivMul;
const IV_NEG = ivNeg;
const IV_SET = ivSet;
const IV_SQUARE = ivSquare;
const IV_UNKNOWN = ivUnknown;
const IV_WIDEN = ivWiden;
const RANGE_CASE = rangeChoiceCase;

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
/** §1.7 step 2: source nodes (root and every def) and defs. */
const MAX_NODES = 4096;
const MAX_DEFS = 64;
/** §1.7 step 4, per tree root: the depth counting through refs, and the structural cost (gen/inspect/cost.ts). */
const MAX_EXPANDED_DEPTH = 128;
const MAX_STRUCTURAL_COST = 65536;
/** §1.9 S: every node's static interval stays within ±1e100 (`VALUE_RANGE`). */
const VALUE_LIMIT = 1e100;

/** Child slots by source op (a Map: an op is tree content). */
const CHILD_SLOTS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(SOURCE_CHILD_KEYS));

type Rec = Readonly<Record<string, unknown>>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A node of a tree root's own structure (refs not entered): its path and depth (the tree root is 1), and the def a
 * `ref` names when it exists (the ref then stands for its def's expansion). */
interface OwnNode { readonly path: string; readonly depth: number; readonly ref: string | null }

/** The nodes of one tree root's own structure in pre-order (iterative): objects reached through the child slots of
 * known source ops; an unknown op has no children, a non-object is not a node. */
function ownNodes(start: unknown, startPath: string, defs: Rec | null): OwnNode[] {
  const out: OwnNode[] = [];
  const stack: Array<{ readonly node: unknown; readonly path: string; readonly depth: number }> = [{ node: start, path: startPath, depth: 1 }];
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;
    if (!isRec(node)) continue;
    const op = Object.hasOwn(node, 'op') ? node['op'] : undefined;
    const name = op === 'ref' && Object.hasOwn(node, 'name') ? node['name'] : undefined;
    out.push({ path, depth, ref: typeof name === 'string' && defs !== null && Object.hasOwn(defs, name) ? name : null });
    const kids = typeof op === 'string' ? CHILD_SLOTS.get(op) : undefined;
    if (kids === undefined) continue;
    for (let k = kids.length - 1; k >= 0; k--) {
      const key = kids[k]!;
      stack.push({ node: Object.hasOwn(node, key) ? node[key] : undefined, path: `${path}.${key}`, depth: depth + 1 });
    }
  }
  return out;
}

/** A tree root of the source: `root` or a def, with its own nodes. */
interface TreeRoot { readonly path: string; readonly node: unknown; readonly def: string | null; readonly nodes: readonly OwnNode[] }

/**
 * The defs in topological order of the def graph (each after every def it refers to): an iterative post-order from
 * each def in key order, no recursion through refs. Called on an acyclic graph; a def met again while open (impossible
 * then) is skipped.
 */
function defOrder(trees: ReadonlyMap<string, TreeRoot>): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const open = new Set<string>();
  for (const start of trees.keys()) {
    if (done.has(start)) continue;
    const stack: Array<{ readonly name: string; i: number }> = [{ name: start, i: 0 }];
    open.add(start);
    while (stack.length > 0) {
      const f = stack[stack.length - 1]!;
      const t = trees.get(f.name)!;
      if (f.i < t.nodes.length) {
        const target = t.nodes[f.i++]!.ref;
        if (target !== null && !done.has(target) && !open.has(target)) {
          open.add(target);
          stack.push({ name: target, i: 0 });
        }
        continue;
      }
      stack.pop();
      open.delete(f.name);
      done.add(f.name);
      order.push(f.name);
    }
  }
  return order;
}

/**
 * The expanded height of every def (the depth of its deepest node counting through refs, a `ref` being one level above
 * its def's root), in topological order of the def graph.
 */
function defHeights(trees: ReadonlyMap<string, TreeRoot>, order: readonly string[]): Map<string, number> {
  const height = new Map<string, number>();
  for (const name of order) {
    let h = 0;
    for (const n of trees.get(name)!.nodes) h = Math.max(h, n.depth + (n.ref === null ? 0 : height.get(n.ref) ?? 0));
    height.set(name, h);
  }
  return height;
}

// ---- The static magnitude analysis (§1.9 S) ----

/** A static interval [lo, hi]. */
type Iv = readonly [lo: number, hi: number];
const UNKNOWN_IV: Iv = Object.freeze([-Infinity, Infinity] as const);
/** `y` over every voxel and corner: [cornerY(0), cornerY(48)] = [−64, 320]. */
const Y_IV: Iv = Object.freeze([CORNER_Y(0), CORNER_Y(48)] as const);
/** `noise` and `noise2` at clampSigma's static maximum: [−8, 8]. */
const NOISE_IV: Iv = Object.freeze([-NOISE_RANGES.clampSigma.max, NOISE_RANGES.clampSigma.max] as const);
/** `col` fields (a Map: a field name is tree content). */
const FIELD_IV: ReadonlyMap<string, Iv> = new Map(Object.entries(FIELD_BOUNDS));
const SCRATCH = new Float64Array(2);
const scratch = (): Iv => [SCRATCH[0]!, SCRATCH[1]!];

/** A numeric scalar field's static range: a literal [v, v], a ref its target's range (negated: [0 − hi, 0 − lo]). */
function fieldIv(v: unknown): Iv {
  if (typeof v === 'number') return [v, v];
  if (!isRec(v) || typeof v['param'] !== 'string') return UNKNOWN_IV;
  const t = ALLOWED_REF_TARGETS.get(v['param']);
  if (t === undefined) return UNKNOWN_IV;
  return Object.hasOwn(v, 'neg') ? [0 - t.hi, 0 - t.lo] : [t.lo, t.hi];
}

/**
 * One node's static interval from its children's (`kid(key)`), with the interval functions of nodes.ts (an UNKNOWN
 * input gives UNKNOWN). `ref` takes its def's interval; a muted tap the hull of its mute's range and its child's;
 * `clamp` and `rangeChoice` bounds and slide knots their ranges; `slide` multiplies x by the hull of every knot value
 * range, widened (s(y) lies between two consecutive knot values up to rounding); `interpolated` widens its child.
 */
function nodeIv(node: Rec, kid: (key: string) => Iv, defIv: ReadonlyMap<string, Iv>): Iv {
  const op = node['op'];
  switch (op) {
    case 'const': IV_SET(node['v'] as number, node['v'] as number, SCRATCH, 0); return scratch();
    case 'y': return Y_IV;
    case 'noise': case 'noise2': return NOISE_IV;
    case 'col': return (typeof node['field'] === 'string' ? FIELD_IV.get(node['field']) : undefined) ?? UNKNOWN_IV;
    case 'param': {
      const t = typeof node['path'] === 'string' ? ALLOWED_REF_TARGETS.get(node['path']) : undefined;
      return t === undefined ? UNKNOWN_IV : [t.lo, t.hi];
    }
    case 'recip': {
      // 1 / x is decreasing on each side of 0, and division rounds monotonically.
      const [x0, x1] = kid('x');
      if (!(Number.isFinite(x0) && Number.isFinite(x1)) || (x0 <= 0 && x1 >= 0)) return UNKNOWN_IV;
      IV_SET(1 / x1, 1 / x0, SCRATCH, 0);
      return scratch();
    }
    case 'add': case 'mul': case 'min': case 'max': {
      const [a0, a1] = kid('a'), [b0, b1] = kid('b');
      (op === 'add' ? IV_ADD : op === 'mul' ? IV_MUL : op === 'min' ? IV_MIN : IV_MAX)(a0, a1, b0, b1, SCRATCH, 0);
      return scratch();
    }
    case 'neg': case 'abs': case 'square': {
      const [x0, x1] = kid('x');
      (op === 'neg' ? IV_NEG : op === 'abs' ? IV_ABS : IV_SQUARE)(x0, x1, SCRATCH, 0);
      return scratch();
    }
    case 'clamp': {
      // clamp is nondecreasing in x, lo and hi while lo ≤ hi (CLAMP_ORDER holds over the ranges).
      const [x0, x1] = kid('x'), [l0, l1] = fieldIv(node['lo']), [h0, h1] = fieldIv(node['hi']);
      IV_CLAMP(x0, x1, l0, h0, SCRATCH, 0);
      const lo = SCRATCH[0]!, hi0 = SCRATCH[1]!;
      IV_CLAMP(x0, x1, l1, h1, SCRATCH, 0);
      IV_HULL(lo, hi0, SCRATCH[0]!, SCRATCH[1]!, SCRATCH, 0);
      return scratch();
    }
    case 'slide': {
      const knots = node['knots'];
      if (!Array.isArray(knots) || knots.length === 0) return UNKNOWN_IV;
      const knotV = (kn: unknown): Iv => (Array.isArray(kn) ? fieldIv(kn[1]) : UNKNOWN_IV);
      let [f0, f1] = knotV(knots[0]);
      for (let i = 1; i < knots.length; i++) {
        const [v0, v1] = knotV(knots[i]);
        IV_HULL(f0, f1, v0, v1, SCRATCH, 0);
        f0 = SCRATCH[0]!;
        f1 = SCRATCH[1]!;
      }
      IV_WIDEN(f0, f1, SCRATCH, 0);
      const [x0, x1] = kid('x');
      IV_MUL(x0, x1, SCRATCH[0]!, SCRATCH[1]!, SCRATCH, 0);
      return scratch();
    }
    case 'interpolated': { const [x0, x1] = kid('x'); IV_WIDEN(x0, x1, SCRATCH, 0); return scratch(); }
    case 'rangeChoice': {
      // inside for every (lo, hi) when x ⊆ [max lo, min hi); outside when x < min lo or x ≥ max hi.
      const [x0, x1] = kid('x'), [l0, l1] = fieldIv(node['lo']), [h0, h1] = fieldIv(node['hi']);
      const [i0, i1] = kid('inside'), [o0, o1] = kid('outside');
      if (!(Number.isFinite(x0) && Number.isFinite(x1))) return UNKNOWN_IV;
      if (RANGE_CASE(x0, x1, l1, h0) === 'inside') IV_SET(i0, i1, SCRATCH, 0);
      else if (RANGE_CASE(x0, x1, l0, h1) === 'outside') IV_SET(o0, o1, SCRATCH, 0);
      else IV_HULL(i0, i1, o0, o1, SCRATCH, 0);
      return scratch();
    }
    case 'tap': {
      const [x0, x1] = kid('x');
      if (!Object.hasOwn(node, 'mute')) { IV_SET(x0, x1, SCRATCH, 0); return scratch(); }
      const [m0, m1] = fieldIv(node['mute']);
      IV_HULL(m0, m1, x0, x1, SCRATCH, 0);
      return scratch();
    }
    case 'ref': return (typeof node['name'] === 'string' ? defIv.get(node['name']) : undefined) ?? UNKNOWN_IV;
    default: IV_UNKNOWN(SCRATCH, 0); return scratch();
  }
}

/** A node whose static interval leaves ±1e100, with that interval. */
interface ValueRangeHit { readonly path: string; readonly iv: Iv }

/**
 * The static intervals of one tree root's nodes, children before parents (an iterative post-order of its own structure;
 * a ref takes its def's interval from `defIv`): the root's interval and the first node, in that post-order, whose
 * interval leaves ±1e100.
 */
function treeIv(start: unknown, startPath: string, defIv: ReadonlyMap<string, Iv>): { readonly iv: Iv; readonly hit: ValueRangeHit | null } {
  const ivs = new Map<object, Iv>();
  /** Nodes whose children are being computed: met again (an in-memory cycle) it is UNKNOWN, never re-entered. */
  const open = new Set<object>();
  let hit: ValueRangeHit | null = null;
  const stack: Array<{ readonly node: unknown; readonly path: string; open: boolean }> = [{ node: start, path: startPath, open: false }];
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (!isRec(f.node) || ivs.has(f.node) || (!f.open && open.has(f.node))) { stack.pop(); continue; }
    const node = f.node;
    const op = Object.hasOwn(node, 'op') ? node['op'] : undefined;
    const kids = typeof op === 'string' ? CHILD_SLOTS.get(op) ?? [] : [];
    if (!f.open) {
      f.open = true;
      open.add(node);
      for (let k = kids.length - 1; k >= 0; k--) {
        const key = kids[k]!;
        stack.push({ node: Object.hasOwn(node, key) ? node[key] : undefined, path: `${f.path}.${key}`, open: false });
      }
      continue;
    }
    stack.pop();
    open.delete(node);
    const kid = (key: string): Iv => {
      const c = Object.hasOwn(node, key) ? node[key] : undefined;
      return (isRec(c) ? ivs.get(c) : undefined) ?? UNKNOWN_IV;
    };
    const iv = nodeIv(node, kid, defIv);
    ivs.set(node, iv);
    if (hit === null && !(iv[0] >= -VALUE_LIMIT && iv[1] <= VALUE_LIMIT)) hit = { path: f.path, iv };
  }
  return { iv: (isRec(start) ? ivs.get(start) : undefined) ?? UNKNOWN_IV, hit };
}

/**
 * §1.9 S on an acyclic, otherwise valid source: every node of `root` and of every def (reachable or not) gets a static
 * interval, defs once each in topological order (the per-def memo), from y ∈ [−64, 320], noises ∈ [−8, 8], `col` fields
 * at `COL_FIELD_BOUNDS`, consts exact, params and ref-valued fields at their static ranges, `recip` 1 / its operand's
 * range, a muted tap the hull of its mute and its child. `VALUE_RANGE` at the first node, over `root` then each def in
 * key order, each in post-order (so the node named is the one whose own op leaves ±1e100, or a ref whose def does).
 */
function valueRangeIssue(source: Rec, roots: readonly TreeRoot[], byDef: ReadonlyMap<string, TreeRoot>, order: readonly string[]): ExprIssue | null {
  const defIv = new Map<string, Iv>();
  const hits = new Map<string, ValueRangeHit>();
  for (const name of order) {
    const r = treeIv(byDef.get(name)!.node, `defs.${name}`, defIv);
    defIv.set(name, r.iv);
    if (r.hit !== null) hits.set(name, r.hit);
  }
  const rootHit = Object.hasOwn(source, 'root') ? treeIv(source['root'], 'root', defIv).hit : null;
  let hit = rootHit;
  for (const t of roots) if (hit === null && t.def !== null) hit = hits.get(t.def) ?? null;
  if (hit === null) return null;
  return {
    path: hit.path, code: 'VALUE_RANGE',
    message: `${hit.path} may take values in [${String(hit.iv[0])}, ${String(hit.iv[1])}], outside ±1e100 (literals, parameters, noises, y and col fields at their static ranges)`,
  };
}

/**
 * Tier 2 proper (§1.7): the counts (step 2, first, so the 50-issue cap never hides them), `validateExpr`'s source mode
 * (step 1, and step 3's refs and iterative def graph), the per-root bounds when the counts hold and the graph is
 * acyclic (step 4), and only when nothing else is wrong the checks that walk through refs (step 5).
 */
function checkSource(source: unknown): ExprIssue[] {
  if (!isRec(source)) return VALIDATE(source, noiseInfo, SOURCE_MODE);
  const issues: ExprIssue[] = [];
  const defs = Object.hasOwn(source, 'defs') && isRec(source['defs']) ? source['defs'] : null;
  const roots: TreeRoot[] = [];
  if (Object.hasOwn(source, 'root')) roots.push({ path: 'root', node: source['root'], def: null, nodes: ownNodes(source['root'], 'root', defs) });
  if (defs !== null) {
    for (const name of Object.keys(defs)) {
      roots.push({ path: `defs.${name}`, node: defs[name], def: name, nodes: ownNodes(defs[name], `defs.${name}`, defs) });
    }
  }

  // Step 2: the counts.
  let nodeCount = 0;
  for (const t of roots) nodeCount += t.nodes.length;
  const defCount = defs === null ? 0 : Object.keys(defs).length;
  if (nodeCount > MAX_NODES) issues.push({ path: '', code: 'TOO_MANY_NODES', message: `${nodeCount} nodes (at most ${MAX_NODES})` });
  if (defCount > MAX_DEFS) issues.push({ path: 'defs', code: 'TOO_MANY_DEFS', message: `${defCount} defs (at most ${MAX_DEFS})` });

  // Steps 1 and 3.
  const base = VALIDATE(source, noiseInfo, SOURCE_MODE);
  issues.push(...base);
  if (nodeCount > MAX_NODES || defCount > MAX_DEFS || base.some((i) => i.code === 'REF_CYCLE')) return issues;

  // Step 4: every tree root, reachable or not, mutes ignored.
  const byDef = new Map<string, TreeRoot>();
  for (const t of roots) if (t.def !== null) byDef.set(t.def, t);
  const order = defOrder(byDef);
  const heights = defHeights(byDef, order);
  for (const t of roots) {
    let deepest: OwnNode | null = null;
    let depth = 0;
    for (const n of t.nodes) {
      const d = n.depth + (n.ref === null ? 0 : heights.get(n.ref) ?? 0);
      if (d > depth) { depth = d; deepest = n; }
    }
    if (deepest !== null && depth > MAX_EXPANDED_DEPTH) {
      issues.push({ path: deepest.path, code: 'EXPANDED_TOO_DEEP', message: `${t.path} reaches depth ${depth} through refs (at most ${MAX_EXPANDED_DEPTH})` });
    }
    const cost = STRUCTURAL_COST(t.node, defs ?? undefined);
    if (cost > MAX_STRUCTURAL_COST) {
      issues.push({ path: t.path, code: 'TOO_COSTLY', message: `${t.path} has structural cost ${cost} (at most ${MAX_STRUCTURAL_COST})` });
    }
  }
  if (issues.length > 0) return issues;

  // Step 5: the checks that walk through refs, the static magnitude analysis, then the column cost.
  issues.push(...NESTING(source));
  const range = valueRangeIssue(source, roots, byDef, order);
  if (range !== null) issues.push(range);
  const column = COLUMN_COST(source);
  if (column > COLUMN_COST_MAX) {
    issues.push({ path: '', code: 'COLUMN_COST', message: `column cost ${column} (at most ${COLUMN_COST_MAX}, 64 × the default tree's)` });
  }
  return issues;
}

const MEMO = new WeakMap<object, readonly ExprIssue[]>();
let validations = 0;

/**
 * Tier 2 for a density source tree (§1.7 steps 1-5): the counts
 * (`TOO_MANY_NODES` at the value '', `TOO_MANY_DEFS` at `defs`), `validateExpr`'s source mode over the schema's density
 * noises and `ALLOWED_REF_TARGETS` with the iterative def graph (`UNKNOWN_REF`, `REF_CYCLE`), then — when the counts hold
 * and the graph is acyclic — for `root` and every def, reachable or not, mutes ignored: the expanded depth
 * (`EXPANDED_TOO_DEEP` at the deepest node of that root's own structure, a ref standing for its def's expansion) and the
 * structural cost (`TOO_COSTLY` at the root's path), and only when nothing else is wrong `NESTED_INTERPOLATED`, the
 * static magnitude analysis (`VALUE_RANGE` at the first node whose static interval leaves ±1e100, §1.9) and the column
 * cost (`COLUMN_COST` at ''). Never throws; at most 50 issues, then
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
  const all = checkSource(source);
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

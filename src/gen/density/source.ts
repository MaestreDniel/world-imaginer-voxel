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
 * `exprHash`, the bounds) and a column's work; every walk of this module is iterative.
 */
import { DENSITY_COLUMN_COST_MAX } from '../../core/constants';
import { NOISE_FIELD_RANGES, SCHEMA } from '../../core/params/schema';
import type { SampleField } from '../column/columnStage';
import { densityColumnCost, structuralCost } from '../inspect/cost';
import {
  EXPR_CHILD_KEYS, EXPR_OPS, nestedInterpolatedIssues, validateExpr, type DensityNoiseInfo, type ExprIssue, type ExprOp,
  type RefTarget,
} from './expr';

const SCHEMA_ = SCHEMA;
const NOISE_RANGES = NOISE_FIELD_RANGES;
const EXPR_CHILDREN = EXPR_CHILD_KEYS;
const OPS = EXPR_OPS;
const VALIDATE = validateExpr;
const NESTING = nestedInterpolatedIssues;
const STRUCTURAL_COST = structuralCost;
const COLUMN_COST = densityColumnCost;
const COLUMN_COST_MAX = DENSITY_COLUMN_COST_MAX;

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
 * The expanded height of every def (the depth of its deepest node counting through refs, a `ref` being one level above
 * its def's root), in topological order of the def graph (an iterative post-order, no recursion through refs). Called
 * on an acyclic graph; a def met again while open (impossible then) adds nothing.
 */
function defHeights(trees: ReadonlyMap<string, TreeRoot>): Map<string, number> {
  const height = new Map<string, number>();
  const open = new Set<string>();
  const heightOf = (t: TreeRoot): number => {
    let h = 0;
    for (const n of t.nodes) h = Math.max(h, n.depth + (n.ref === null ? 0 : height.get(n.ref) ?? 0));
    return h;
  };
  for (const start of trees.keys()) {
    if (height.has(start)) continue;
    const stack: Array<{ readonly name: string; i: number }> = [{ name: start, i: 0 }];
    open.add(start);
    while (stack.length > 0) {
      const f = stack[stack.length - 1]!;
      const t = trees.get(f.name)!;
      if (f.i < t.nodes.length) {
        const target = t.nodes[f.i++]!.ref;
        if (target !== null && !height.has(target) && !open.has(target)) {
          open.add(target);
          stack.push({ name: target, i: 0 });
        }
        continue;
      }
      stack.pop();
      open.delete(f.name);
      height.set(f.name, heightOf(t));
    }
  }
  return height;
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
  const heights = defHeights(byDef);
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

  // Step 5: the checks that walk through refs (VALUE_RANGE joins them in the next task), then the column cost.
  issues.push(...NESTING(source));
  const column = COLUMN_COST(source);
  if (column > COLUMN_COST_MAX) {
    issues.push({ path: '', code: 'COLUMN_COST', message: `column cost ${column} (at most ${COLUMN_COST_MAX}, 64 × the default tree's)` });
  }
  return issues;
}

const MEMO = new WeakMap<object, readonly ExprIssue[]>();
let validations = 0;

/**
 * Tier 2 for a density source tree (§1.7 steps 1-5; `VALUE_RANGE` comes with the static magnitude analysis): the counts
 * (`TOO_MANY_NODES` at the value '', `TOO_MANY_DEFS` at `defs`), `validateExpr`'s source mode over the schema's density
 * noises and `ALLOWED_REF_TARGETS` with the iterative def graph (`UNKNOWN_REF`, `REF_CYCLE`), then — when the counts hold
 * and the graph is acyclic — for `root` and every def, reachable or not, mutes ignored: the expanded depth
 * (`EXPANDED_TOO_DEEP` at the deepest node of that root's own structure, a ref standing for its def's expansion) and the
 * structural cost (`TOO_COSTLY` at the root's path), and only when nothing else is wrong `NESTED_INTERPOLATED` and the
 * column cost (`COLUMN_COST` at ''). Never throws; at most 50 issues, then
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

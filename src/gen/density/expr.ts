/**
 * The density expression model (SP3b spec §1.1): `Expr` is plain JSON, tagged objects with an `op` field; named
 * sub-expressions live in `defs` next to the root and are used through `ref`. This module holds the node types, the
 * child slots in evaluation order, `validateExpr` (run before ref resolution and CSE, so its paths name real nodes:
 * `root.a.b.x`, `defs.terrain.x`) and the structural hash the compiler's CSE keys on (§2.1).
 * Per-op semantics (values, intervals, classes) are in nodes.ts.
 *
 * SP3d adds `validateExpr`'s source mode (SP3d spec §1.3-§1.5, §1.7 tier 2 step 1): the same walk over the source tree
 * of the `density.defs` leaf (gen/density/source.ts), which also accepts the source-only ops `param` and `recip`, tap
 * `mute` and the ref form `{param, neg?}` in every numeric scalar field, judges every order check over the refs' static
 * ranges, and reports the source codes. Code-built trees keep SP3b's rules exactly.
 */
import { createFnv64, hex64, utf8Bytes } from '../../core/hash';
import { TREE_KEY_RE } from '../../core/params/json';
import { SAMPLE_FIELDS, type SampleField } from '../column/columnStage';

const FNV = createFnv64;
const HEX = hex64;
const UTF8 = utf8Bytes;
const FIELDS = SAMPLE_FIELDS;
const KEY_RE = TREE_KEY_RE;

export interface ConstExpr { readonly op: 'const'; readonly v: number }
export interface YExpr { readonly op: 'y' }
/** A continuous ColumnSample field (never a level field: `col` is limited to finite fields until SP6). */
export interface ColExpr { readonly op: 'col'; readonly field: SampleField }
/** z2(x, z) of the density noise `id` (schema leaf `density.noises.<id>`, dims 2). */
export interface Noise2Expr { readonly op: 'noise2'; readonly id: string }
/** z3(x, y, z) of the density noise `id` (dims 3). */
export interface NoiseExpr { readonly op: 'noise'; readonly id: string }
export type BinaryOp = 'add' | 'mul' | 'min' | 'max';
export interface BinaryExpr { readonly op: BinaryOp; readonly a: Expr; readonly b: Expr }
export type UnaryOp = 'neg' | 'abs' | 'square';
export interface UnaryExpr { readonly op: UnaryOp; readonly x: Expr }
export interface ClampExpr { readonly op: 'clamp'; readonly x: Expr; readonly lo: number; readonly hi: number }
export type SlideKnot = readonly [y: number, v: number];
export interface SlideExpr { readonly op: 'slide'; readonly x: Expr; readonly knots: readonly SlideKnot[] }
export interface InterpolatedExpr { readonly op: 'interpolated'; readonly x: Expr }
export interface RangeChoiceExpr {
  readonly op: 'rangeChoice'; readonly x: Expr; readonly lo: number; readonly hi: number; readonly inside: Expr; readonly outside: Expr;
}
export interface TapExpr { readonly op: 'tap'; readonly name: string; readonly x: Expr }
export interface RefExpr { readonly op: 'ref'; readonly name: string }

export type Expr =
  | ConstExpr | YExpr | ColExpr | Noise2Expr | NoiseExpr | BinaryExpr | UnaryExpr | ClampExpr | SlideExpr
  | InterpolatedExpr | RangeChoiceExpr | TapExpr | RefExpr;
export type ExprOp = Expr['op'];

/** A whole density expression: the root and its named sub-expressions. */
export interface DensityExpr {
  readonly root: Expr;
  readonly defs: Readonly<Record<string, Expr>>;
}

/** Every op, in SP3b spec §1.1's table order. */
export const EXPR_OPS: readonly ExprOp[] = [
  'const', 'y', 'col', 'noise2', 'noise', 'add', 'mul', 'min', 'max', 'neg', 'abs', 'square', 'clamp', 'slide',
  'interpolated', 'rangeChoice', 'tap', 'ref',
];

/** The child slots of each op, in evaluation order (a then b; x then the chosen rangeChoice branch). */
export const EXPR_CHILD_KEYS: { readonly [K in ExprOp]: readonly string[] } = {
  const: [], y: [], col: [], noise2: [], noise: [], ref: [],
  add: ['a', 'b'], mul: ['a', 'b'], min: ['a', 'b'], max: ['a', 'b'],
  neg: ['x'], abs: ['x'], square: ['x'], clamp: ['x'], slide: ['x'], interpolated: ['x'], tap: ['x'],
  rangeChoice: ['x', 'inside', 'outside'],
};

/** The non-child keys of each op (besides `op`). */
const SCALAR_KEYS: { readonly [K in ExprOp]: readonly string[] } = {
  const: ['v'], y: [], col: ['field'], noise2: ['id'], noise: ['id'], ref: ['name'],
  add: [], mul: [], min: [], max: [], neg: [], abs: [], square: [], interpolated: [],
  clamp: ['lo', 'hi'], slide: ['knots'], tap: ['name'], rangeChoice: ['lo', 'hi'],
};

/** The children of a node in evaluation order. */
export function exprChildren(e: Expr): Expr[] {
  const node = e as unknown as Record<string, Expr>;
  return EXPR_CHILD_KEYS[e.op].map((k) => node[k]!);
}

/** What the validator (and later the interval rules) need to know about a density noise. */
export interface DensityNoiseInfo {
  readonly dims: 2 | 3;
  readonly remap: 'none' | 'uniform';
  readonly clampSigma: number;
}
/** The density noises an expression may use, by id (Task 6 builds it from the schema's `density.noises`). */
export type DensityNoiseLookup = (id: string) => DensityNoiseInfo | undefined;

/**
 * A density noise the evaluators sample: its validation info plus `z2(x, z)` / `z3(x, y, z)` in unscaled world block
 * coordinates (a schema NormalNoise, or a test noise). Values lie in [−clampSigma, clampSigma].
 */
export interface DensityNoise extends DensityNoiseInfo {
  z2(x: number, z: number): number;
  z3(x: number, y: number, z: number): number;
}
/** Injected noises by id; also a DensityNoiseLookup, so the same source validates and evaluates. */
export type DensityNoiseSource = (id: string) => DensityNoise | undefined;

export type ExprErrorCode =
  | 'NOT_OBJECT' | 'UNKNOWN_OP' | 'UNKNOWN_KEY' | 'NOT_FINITE' | 'BAD_FIELD' | 'UNKNOWN_NOISE' | 'NOISE_DIMS'
  | 'NOISE_REMAP' | 'BAD_NAME' | 'DUPLICATE_TAP' | 'UNKNOWN_REF' | 'REF_CYCLE' | 'NESTED_INTERPOLATED'
  | 'CLAMP_ORDER' | 'RANGE_ORDER' | 'KNOTS_SHAPE' | 'KNOTS_ORDER';

/**
 * The codes only a density source tree can get (SP3d spec §1.7 tier 2, density): the source mode of `validateExpr`
 * reports `UNKNOWN_PARAM`, `RECIP_OPERAND`, `RECIP_ZERO`, `LITERAL_RANGE` and `SLIDE_SLOPE`; gen/density/source.ts the
 * others (counts, expanded depth and cost, value range, column cost, and the 50-issue cap). Every density field is a
 * number field, which takes any target, so `PARAM_KIND` (an int field given a number target) is a rules code only.
 */
export type DensitySourceCode =
  | 'UNKNOWN_PARAM' | 'RECIP_OPERAND' | 'RECIP_ZERO' | 'LITERAL_RANGE' | 'SLIDE_SLOPE' | 'TOO_MANY_NODES' | 'TOO_MANY_DEFS'
  | 'EXPANDED_TOO_DEEP' | 'TOO_COSTLY' | 'VALUE_RANGE' | 'COLUMN_COST' | 'TOO_MANY_ISSUES';

export interface ExprIssue {
  /**
   * The node path: `root`, `root.a.b.x`, `defs.terrain.x`, `root.knots[2]`; '' is the top-level object. A source tree's
   * field issues name the field (`root.lo`, `root.mute`, `root.x.path`, a knot coordinate `root.knots[2][0]`).
   */
  readonly path: string;
  readonly code: ExprErrorCode | DensitySourceCode;
  readonly message: string;
}

/** A parameter a source tree may reference (SP3d spec §1.3): its kind and static range (finite, lo ≤ hi). */
export interface RefTarget {
  readonly kind: 'number' | 'int';
  readonly lo: number;
  readonly hi: number;
}

/** `validateExpr`'s source mode (gen/density/source.ts builds it): the parameters a ref may name, by schema path. */
export interface ExprSourceMode {
  readonly targets: ReadonlyMap<string, RefTarget>;
}

export class ExprValidationError extends Error {
  readonly issues: readonly ExprIssue[];
  constructor(issues: readonly ExprIssue[]) {
    super(`invalid density expression: ${issues.map((i) => `${i.path === '' ? '<top>' : i.path}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const OP_SET = new Set<string>(EXPR_OPS);
const TOP_KEYS = ['root', 'defs'];

/** The source mode's ops: the Expr ops plus `recip` and `param` (SP3d spec §1.3, §1.4). */
const SOURCE_OP_SET = new Set<string>([...EXPR_OPS, 'recip', 'param']);
/** Child and scalar keys by op, code-built and source (Maps: an op is tree content). */
const CODE_CHILDREN = new Map<string, readonly string[]>(Object.entries(EXPR_CHILD_KEYS));
const SOURCE_CHILDREN = new Map<string, readonly string[]>([...CODE_CHILDREN, ['recip', ['x']], ['param', []]]);
const CODE_SCALARS = new Map<string, readonly string[]>(Object.entries(SCALAR_KEYS));
const SOURCE_SCALARS = new Map<string, readonly string[]>([...CODE_SCALARS, ['tap', ['name', 'mute']], ['recip', []], ['param', ['path']]]);
const NO_TARGETS: ReadonlyMap<string, RefTarget> = new Map();

/** A source literal stays within ±LITERAL_MAX (SP3d spec §1.7; the master's cave formulas use ±1e9 and ±1e6). */
const LITERAL_MAX = 1e9;
/** Appended to an order issue that involves a ref (SP3d spec §1.3, value-independence). */
const REF_NOTE = ' for every value of its parameter refs (each ref is judged over its whole static range, independently: two refs to the same parameter too)';

/** A numeric scalar field of a source node: its static range, and whether a ref gave it. */
interface FieldRange { readonly lo: number; readonly hi: number; readonly ref: boolean }

/**
 * The single density-expression validator (SP3b spec §1.1). Collects every issue, never throws: structural issues in
 * DFS pre-order (root, then defs in key order), then unknown refs and ref cycles, then interpolated nesting (only when
 * the refs resolve). [] means the value is a `DensityExpr` the compiler and the reference accept. Beyond the spec's
 * list it also rejects unknown keys, a noise used with the wrong dimension and duplicate tap names (rulings, Task 2).
 * The root's refs have their own bucket, so a def named '' is never taken for the root (SP3d spec §1.7 step 3).
 *
 * With `source` (SP3d spec §1.7 tier 2 step 1, called by gen/density/source.ts) it validates a source tree: also the
 * ops `param` (`path` names one of `source.targets`, else `UNKNOWN_PARAM` at `.path`) and `recip` (of a `const` or a
 * `param`, `RECIP_OPERAND`; non-zero with finite reciprocals over the whole range, `RECIP_ZERO`; both at `.x`), tap
 * `mute`, and in `clamp`/`rangeChoice` `lo`/`hi`, each knot's y and v and `mute` a literal or a ref `{param, neg?}`
 * (`UNKNOWN_PARAM`, or `BAD_FIELD` for a malformed ref, at the field's path); literals within ±1e9 (`LITERAL_RANGE`);
 * `CLAMP_ORDER`, `RANGE_ORDER` and `KNOTS_ORDER` over the static ranges (a negated ref spans [0 − hi, 0 − lo]); every
 * slide segment's `v1 − vk` and `(v1 − vk) / (y1 − yk)` finite at the range ends that maximise them (`SLIDE_SLOPE`, at
 * the segment's upper knot); tap names matching the key pattern (`BAD_NAME`). Mutes are ignored by the walks (the
 * muted subtree is validated like any other).
 */
export function validateExpr(value: unknown, noises: DensityNoiseLookup, source?: ExprSourceMode): ExprIssue[] {
  const issues: ExprIssue[] = [];
  const push = (path: string, code: ExprIssue['code'], message: string) => issues.push({ path, code, message });
  if (!isRecord(value)) {
    push('', 'NOT_OBJECT', 'a density expression is an object {root, defs}');
    return issues;
  }
  const ops = source === undefined ? OP_SET : SOURCE_OP_SET;
  const children = source === undefined ? CODE_CHILDREN : SOURCE_CHILDREN;
  const scalars = source === undefined ? CODE_SCALARS : SOURCE_SCALARS;
  const targets = source === undefined ? NO_TARGETS : source.targets;
  for (const k of Object.keys(value)) if (!TOP_KEYS.includes(k)) push(k, 'UNKNOWN_KEY', `unknown key "${k}"`);
  const rawDefs = value['defs'];
  const defs: Record<string, unknown> | null = isRecord(rawDefs) ? rawDefs : null;
  const defNames = defs === null ? [] : Object.keys(defs);
  const hasDef = (name: string) => defs !== null && Object.hasOwn(defs, name);
  const taps = new Map<string, string>();
  /** Ref nodes per owner (null = the root, else the def name), in pre-order. */
  const refs = new Map<string | null, Array<{ path: string; name: string }>>();

  /**
   * A numeric scalar field of a source node at `path`: its static range, or null after an issue that leaves no range.
   * A literal is finite (`NOT_FINITE`) and within ±1e9 (`LITERAL_RANGE`, the range still returned); a ref is
   * `{param}` or `{param, neg: true}` (`BAD_FIELD`) naming a target (`UNKNOWN_PARAM`).
   */
  const sourceNumber = (v: unknown, path: string, what: string): FieldRange | null => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) { push(path, 'NOT_FINITE', `${what} must be a finite number or a parameter ref`); return null; }
      if (Math.abs(v) > LITERAL_MAX) push(path, 'LITERAL_RANGE', `${what} ${String(v)} is outside ±1e9`);
      return { lo: v, hi: v, ref: false };
    }
    if (!isRecord(v)) { push(path, 'NOT_FINITE', `${what} must be a finite number or a parameter ref {"param": …}`); return null; }
    const param = Object.hasOwn(v, 'param') ? v['param'] : undefined;
    const negated = Object.hasOwn(v, 'neg');
    if (typeof param !== 'string' || (negated && v['neg'] !== true) || Object.keys(v).some((k) => k !== 'param' && k !== 'neg')) {
      push(path, 'BAD_FIELD', `${what}: a parameter ref is {"param": "<path>"} or {"param": "<path>", "neg": true}`);
      return null;
    }
    const t = targets.get(param);
    if (t === undefined) {
      push(path, 'UNKNOWN_PARAM', `${what}: ${JSON.stringify(param)} is not a number or int parameter of density / surface or a noise clampSigma`);
      return null;
    }
    return negated ? { lo: 0 - t.hi, hi: 0 - t.lo, ref: true } : { lo: t.lo, hi: t.hi, ref: true };
  };
  const note = (...fs: FieldRange[]): string => (fs.some((f) => f.ref) ? REF_NOTE : '');

  const walk = (node: unknown, path: string, owner: string | null): void => {
    if (!isRecord(node)) { push(path, 'NOT_OBJECT', 'an expression node must be an object with an op'); return; }
    const op = node['op'];
    if (typeof op !== 'string' || !ops.has(op)) { push(path, 'UNKNOWN_OP', `unknown op ${JSON.stringify(op)}`); return; }
    const o = op as ExprOp | 'recip' | 'param';
    const at = (k: string) => `${path}.${k}`;
    const own = scalars.get(o)!, kids = children.get(o)!;
    for (const k of Object.keys(node)) {
      if (k !== 'op' && !own.includes(k) && !kids.includes(k)) push(at(k), 'UNKNOWN_KEY', `unknown key "${k}" on ${o}`);
    }
    const finite = (k: string): boolean => {
      if (isFiniteNumber(node[k])) return true;
      push(at(k), 'NOT_FINITE', `${o}.${k} must be a finite number`);
      return false;
    };
    const child = (k: string) => walk(node[k], at(k), owner);
    switch (o) {
      case 'const':
        if (finite('v') && source !== undefined && Math.abs(node['v'] as number) > LITERAL_MAX) push(at('v'), 'LITERAL_RANGE', `const ${String(node['v'])} is outside ±1e9`);
        break;
      case 'y': break;
      case 'col': {
        const f = node['field'];
        if (typeof f !== 'string' || !(FIELDS as readonly string[]).includes(f)) push(at('field'), 'BAD_FIELD', `col.field ${JSON.stringify(f)} is not a continuous ColumnSample field`);
        break;
      }
      case 'noise2': case 'noise': {
        const id = node['id'];
        const info = typeof id === 'string' ? noises(id) : undefined;
        const dims = o === 'noise2' ? 2 : 3;
        if (info === undefined) push(at('id'), 'UNKNOWN_NOISE', `unknown density noise ${JSON.stringify(id)}`);
        else if (info.dims !== dims) push(at('id'), 'NOISE_DIMS', `${o} needs a ${dims}D noise; ${String(id)} is ${info.dims}D`);
        else if (info.remap !== 'none') push(at('id'), 'NOISE_REMAP', `density noise ${String(id)} must have remap 'none'`);
        break;
      }
      case 'add': case 'mul': case 'min': case 'max': child('a'); child('b'); break;
      case 'neg': case 'abs': case 'square': case 'interpolated': child('x'); break;
      case 'clamp': {
        child('x');
        if (source === undefined) {
          const lo = finite('lo'), hi = finite('hi');
          if (lo && hi && (node['lo'] as number) > (node['hi'] as number)) push(path, 'CLAMP_ORDER', 'clamp needs lo ≤ hi');
        } else {
          const lo = sourceNumber(node['lo'], at('lo'), 'clamp.lo'), hi = sourceNumber(node['hi'], at('hi'), 'clamp.hi');
          if (lo !== null && hi !== null && lo.hi > hi.lo) push(path, 'CLAMP_ORDER', `clamp needs lo ≤ hi${note(lo, hi)}`);
        }
        break;
      }
      case 'slide': {
        child('x');
        const knots = node['knots'];
        if (!Array.isArray(knots) || knots.length < 2) { push(at('knots'), 'KNOTS_SHAPE', 'slide needs at least 2 knots [y, v]'); break; }
        if (source === undefined) {
          let prev = -Infinity;
          for (let i = 0; i < knots.length; i++) {
            const kp = `${path}.knots[${i}]`;
            const kn: unknown = knots[i];
            if (!Array.isArray(kn) || kn.length !== 2) { push(kp, 'KNOTS_SHAPE', 'a knot is a pair [y, v]'); prev = NaN; continue; }
            if (!isFiniteNumber(kn[0]) || !isFiniteNumber(kn[1])) { push(kp, 'NOT_FINITE', 'knot y and v must be finite'); prev = NaN; continue; }
            if (kn[0] <= prev) push(kp, 'KNOTS_ORDER', 'knot y must be strictly increasing');
            prev = kn[0];
          }
          break;
        }
        let prev: { readonly y: FieldRange; readonly v: FieldRange } | null = null;
        for (let i = 0; i < knots.length; i++) {
          const kp = `${path}.knots[${i}]`;
          const kn: unknown = knots[i];
          if (!Array.isArray(kn) || kn.length !== 2) { push(kp, 'KNOTS_SHAPE', 'a knot is a pair [y, v]'); prev = null; continue; }
          const y = sourceNumber(kn[0], `${kp}[0]`, 'knot y'), v = sourceNumber(kn[1], `${kp}[1]`, 'knot v');
          if (y === null || v === null) { prev = null; continue; }
          if (prev !== null) {
            if (y.lo <= prev.y.hi) push(kp, 'KNOTS_ORDER', `knot y must be strictly increasing${note(prev.y, y)}`);
            else {
              // slideAt's (v1 − vk) / (y1 − yk): the largest |difference| is at the range ends, the smallest gap is
              // min y1 − max yk (> 0 here), and rounding is monotone, so these bound every value the segment computes.
              const d1 = v.hi - prev.v.lo, d2 = v.lo - prev.v.hi, gap = y.lo - prev.y.hi;
              if (!(Number.isFinite(d1) && Number.isFinite(d2) && Number.isFinite(d1 / gap) && Number.isFinite(d2 / gap))) {
                push(kp, 'SLIDE_SLOPE', `slide segment knots[${i - 1}] → knots[${i}]: v1 − vk and (v1 − vk) / (y1 − yk) must be finite${note(prev.y, prev.v, y, v)}`);
              }
            }
          }
          prev = { y, v };
        }
        break;
      }
      case 'rangeChoice': {
        child('x');
        if (source === undefined) {
          const lo = finite('lo'), hi = finite('hi');
          if (lo && hi && (node['lo'] as number) >= (node['hi'] as number)) push(path, 'RANGE_ORDER', 'rangeChoice needs lo < hi');
        } else {
          const lo = sourceNumber(node['lo'], at('lo'), 'rangeChoice.lo'), hi = sourceNumber(node['hi'], at('hi'), 'rangeChoice.hi');
          if (lo !== null && hi !== null && lo.hi >= hi.lo) push(path, 'RANGE_ORDER', `rangeChoice needs lo < hi${note(lo, hi)}`);
        }
        child('inside');
        child('outside');
        break;
      }
      case 'tap': {
        const name = node['name'];
        if (typeof name !== 'string' || (source === undefined ? name === '' : !KEY_RE.test(name))) {
          push(at('name'), 'BAD_NAME', source === undefined ? 'tap.name must be a non-empty string' : `tap.name must match ${KEY_RE.source}`);
        } else if (taps.has(name)) push(at('name'), 'DUPLICATE_TAP', `tap ${JSON.stringify(name)} already used at ${taps.get(name)!}`);
        else taps.set(name, path);
        if (source !== undefined && Object.hasOwn(node, 'mute')) sourceNumber(node['mute'], at('mute'), 'tap.mute');
        child('x');
        break;
      }
      case 'ref': {
        const name = node['name'];
        if (typeof name !== 'string' || !hasDef(name)) push(at('name'), 'UNKNOWN_REF', `unknown def ${JSON.stringify(name)}`);
        else {
          const list = refs.get(owner) ?? [];
          list.push({ path, name });
          refs.set(owner, list);
        }
        break;
      }
      case 'param': {
        const p = node['path'];
        if (typeof p !== 'string' || !targets.has(p)) {
          push(at('path'), 'UNKNOWN_PARAM', `param.path ${JSON.stringify(p) ?? 'undefined'} is not a number or int parameter of density / surface or a noise clampSigma`);
        }
        break;
      }
      case 'recip': {
        child('x');
        const x = node['x'];
        // A malformed operand has its own issue from the walk.
        if (!isRecord(x) || typeof x['op'] !== 'string' || !ops.has(x['op'])) break;
        if (x['op'] === 'const') {
          const v = x['v'];
          if (isFiniteNumber(v) && !(v !== 0 && Number.isFinite(1 / v))) push(at('x'), 'RECIP_ZERO', `recip of ${String(v)}: the constant must be non-zero with a finite reciprocal`);
        } else if (x['op'] === 'param') {
          const p = x['path'];
          const t = typeof p === 'string' ? targets.get(p) : undefined;
          if (t !== undefined && !((t.lo > 0 || t.hi < 0) && Number.isFinite(1 / t.lo) && Number.isFinite(1 / t.hi))) {
            push(at('x'), 'RECIP_ZERO', `recip of ${p as string}: its static range [${String(t.lo)}, ${String(t.hi)}] must exclude 0 (with finite reciprocals)`);
          }
        } else push(at('x'), 'RECIP_OPERAND', `recip takes a const or a param operand, not ${x['op']}`);
        break;
      }
    }
  };

  if (!Object.hasOwn(value, 'root')) push('root', 'NOT_OBJECT', 'missing root');
  else walk(value['root'], 'root', null);
  if (defs === null) push('defs', 'NOT_OBJECT', 'defs must be an object of named expressions');
  else for (const name of defNames) walk(defs[name], `defs.${name}`, name);
  const structuralOk = issues.length === 0;

  // Ref cycles: DFS over the defs graph; each back edge is one issue at the ref that closes it.
  let cycles = false;
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    state.set(name, 'open');
    stack.push(name);
    for (const r of refs.get(name) ?? []) {
      const s = state.get(r.name);
      if (s === 'open') {
        cycles = true;
        const loop = [...stack.slice(stack.indexOf(r.name)), r.name].map((n) => `defs.${n}`).join(' → ');
        push(r.path, 'REF_CYCLE', `ref cycle ${loop}`);
      } else if (s === undefined) visit(r.name);
    }
    stack.pop();
    state.set(name, 'done');
  };
  for (const name of defNames) if (!state.has(name)) visit(name);

  // Interpolated nesting through refs, from the root, then from the defs the root does not reach (each def once per flag).
  if (structuralOk && !cycles) {
    const reported = new Set<string>();
    const seen = new Set<string>();
    const nest = (node: Expr, path: string, outer: string | null): void => {
      if (node.op === 'interpolated') {
        if (outer !== null && !reported.has(path)) {
          reported.add(path);
          push(path, 'NESTED_INTERPOLATED', `an interpolated inside another (the outer one at ${outer})`);
        }
        nest(node.x, `${path}.x`, outer ?? path);
        return;
      }
      if (node.op === 'ref') {
        const key = `${node.name}|${outer === null ? 0 : 1}`;
        if (seen.has(key)) return;
        seen.add(key);
        nest((defs as Record<string, Expr>)[node.name]!, `defs.${node.name}`, outer);
        return;
      }
      const rec = node as unknown as Record<string, Expr>;
      for (const k of children.get(node.op)!) nest(rec[k]!, `${path}.${k}`, outer);
    };
    nest(value['root'] as Expr, 'root', null);
    for (const name of defNames) nest({ op: 'ref', name }, `defs.${name}`, null);
  }
  return issues;
}

/** Throws an ExprValidationError listing every issue unless `value` is a valid DensityExpr. */
export function assertValidExpr(value: unknown, noises: DensityNoiseLookup): asserts value is DensityExpr {
  const issues = validateExpr(value, noises);
  if (issues.length > 0) throw new ExprValidationError(issues);
}

const DV = new DataView(new ArrayBuffer(8));

/**
 * Structural hash of a node (SP3b spec §2.1 CSE): FNV-1a 64 over the op name, its scalar fields (numbers as IEEE
 * bits, so −0 ≠ +0; strings as length + UTF-8) and its children's hashes in slot order, as 16 hex digits. A `ref` hashes
 * by name (the compiler hashes after resolving refs). `memo` caches every sub-tree's hash by identity, so hashing all
 * nodes of a tree (or a DAG) is linear. Not pinned by a golden: the value may change between versions.
 */
export function exprHash(e: Expr, memo: WeakMap<Expr, string> = new WeakMap()): string {
  const cached = memo.get(e);
  if (cached !== undefined) return cached;
  const h = FNV();
  const str = (s: string) => {
    const b = UTF8(s);
    h.updateU32LE(b.length).update(b);
  };
  const num = (v: number) => {
    DV.setFloat64(0, v, true);
    h.updateU32LE(DV.getUint32(0, true)).updateU32LE(DV.getUint32(4, true));
  };
  str(e.op);
  switch (e.op) {
    case 'const': num(e.v); break;
    case 'col': str(e.field); break;
    case 'noise2': case 'noise': str(e.id); break;
    case 'clamp': case 'rangeChoice': num(e.lo); num(e.hi); break;
    case 'slide':
      h.updateU32LE(e.knots.length);
      for (const [y, v] of e.knots) { num(y); num(v); }
      break;
    case 'tap': case 'ref': str(e.name); break;
    default: break;
  }
  const rec = e as unknown as Record<string, Expr>;
  for (const k of EXPR_CHILD_KEYS[e.op]) str(exprHash(rec[k]!, memo));
  const out = HEX(h.digest());
  memo.set(e, out);
  return out;
}

/**
 * The density expression model (SP3b spec §1.1): `Expr` is plain JSON, tagged objects with an `op` field; named
 * sub-expressions live in `defs` next to the root and are used through `ref`. This module holds the node types, the
 * child slots in evaluation order, `validateExpr` (run before ref resolution and CSE, so its paths name real nodes:
 * `root.a.b.x`, `defs.terrain.x`) and the structural hash the compiler's CSE keys on (§2.1).
 * Per-op semantics (values, intervals, classes) are in nodes.ts.
 */
import { createFnv64, hex64, utf8Bytes } from '../../core/hash';
import { SAMPLE_FIELDS, type SampleField } from '../column/columnStage';

const FNV = createFnv64;
const HEX = hex64;
const UTF8 = utf8Bytes;
const FIELDS = SAMPLE_FIELDS;

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

export interface ExprIssue {
  /** The node path: `root`, `root.a.b.x`, `defs.terrain.x`, `root.knots[2]`; '' is the top-level object. */
  readonly path: string;
  readonly code: ExprErrorCode;
  readonly message: string;
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

/**
 * The single density-expression validator (SP3b spec §1.1). Collects every issue, never throws: structural issues in
 * DFS pre-order (root, then defs in key order), then unknown refs and ref cycles, then interpolated nesting (only when
 * the refs resolve). [] means the value is a `DensityExpr` the compiler and the reference accept. Beyond the spec's
 * list it also rejects unknown keys, a noise used with the wrong dimension and duplicate tap names (rulings, Task 2).
 */
export function validateExpr(value: unknown, noises: DensityNoiseLookup): ExprIssue[] {
  const issues: ExprIssue[] = [];
  const push = (path: string, code: ExprErrorCode, message: string) => issues.push({ path, code, message });
  if (!isRecord(value)) {
    push('', 'NOT_OBJECT', 'a density expression is an object {root, defs}');
    return issues;
  }
  for (const k of Object.keys(value)) if (!TOP_KEYS.includes(k)) push(k, 'UNKNOWN_KEY', `unknown key "${k}"`);
  const rawDefs = value['defs'];
  const defs: Record<string, unknown> | null = isRecord(rawDefs) ? rawDefs : null;
  const defNames = defs === null ? [] : Object.keys(defs);
  const hasDef = (name: string) => defs !== null && Object.hasOwn(defs, name);
  const taps = new Map<string, string>();
  /** Ref nodes per owner ('' = root, else the def name), in pre-order. */
  const refs = new Map<string, Array<{ path: string; name: string }>>();

  const walk = (node: unknown, path: string, owner: string): void => {
    if (!isRecord(node)) { push(path, 'NOT_OBJECT', 'an expression node must be an object with an op'); return; }
    const op = node['op'];
    if (typeof op !== 'string' || !OP_SET.has(op)) { push(path, 'UNKNOWN_OP', `unknown op ${JSON.stringify(op)}`); return; }
    const o = op as ExprOp;
    const at = (k: string) => `${path}.${k}`;
    for (const k of Object.keys(node)) {
      if (k !== 'op' && !SCALAR_KEYS[o].includes(k) && !EXPR_CHILD_KEYS[o].includes(k)) push(at(k), 'UNKNOWN_KEY', `unknown key "${k}" on ${o}`);
    }
    const finite = (k: string): boolean => {
      if (isFiniteNumber(node[k])) return true;
      push(at(k), 'NOT_FINITE', `${o}.${k} must be a finite number`);
      return false;
    };
    const child = (k: string) => walk(node[k], at(k), owner);
    switch (o) {
      case 'const': finite('v'); break;
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
        const lo = finite('lo'), hi = finite('hi');
        if (lo && hi && (node['lo'] as number) > (node['hi'] as number)) push(path, 'CLAMP_ORDER', 'clamp needs lo ≤ hi');
        break;
      }
      case 'slide': {
        child('x');
        const knots = node['knots'];
        if (!Array.isArray(knots) || knots.length < 2) { push(at('knots'), 'KNOTS_SHAPE', 'slide needs at least 2 knots [y, v]'); break; }
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
      case 'rangeChoice': {
        child('x');
        const lo = finite('lo'), hi = finite('hi');
        if (lo && hi && (node['lo'] as number) >= (node['hi'] as number)) push(path, 'RANGE_ORDER', 'rangeChoice needs lo < hi');
        child('inside');
        child('outside');
        break;
      }
      case 'tap': {
        const name = node['name'];
        if (typeof name !== 'string' || name === '') push(at('name'), 'BAD_NAME', 'tap.name must be a non-empty string');
        else if (taps.has(name)) push(at('name'), 'DUPLICATE_TAP', `tap ${JSON.stringify(name)} already used at ${taps.get(name)!}`);
        else taps.set(name, path);
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
    }
  };

  if (!('root' in value)) push('root', 'NOT_OBJECT', 'missing root');
  else walk(value['root'], 'root', '');
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
      for (const k of EXPR_CHILD_KEYS[node.op]) nest(rec[k]!, `${path}.${k}`, outer);
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

/**
 * ParamSchema kit (SP1 spec §4, approach A): nodes are plain data built by small builders; the Params
 * type is inferred from the schema; validation dispatches on `kind`. Part 2 (applyPatch, diffParams,
 * getPath, patchAt, renderReference) is appended in Task 14.
 */
import type { MetricId, RegenScope, StageId } from '../ids';
import { NOISE_DEF_DEFAULTS, type NoiseDef, type NoiseDefPatch } from '../noise/types';
import type { NestedSpline, SplineCoord } from '../spline/types';
import { normalizeSpline, validateSpline, type SplineErrorCode } from '../spline/validate';
import { canonicalJSON, q15 } from './canonical';

export type ParamKind =
  | 'number' | 'int' | 'bool' | 'enum' | 'noise' | 'spline' | 'expr' | 'boxTable' | 'ruleTree' | 'featureList' | 'structureSets';

/** Live leaves are hashed by no stage; every other leaf names its home stage. */
export type Placement =
  | { readonly scope: 'live'; readonly stage?: never }
  | { readonly scope: Exclude<RegenScope, 'live'>; readonly stage: StageId };

export type MetaInput = {
  readonly label: string;
  readonly doc: string;
  readonly unit?: string;
  readonly effectMetric?: MetricId;
} & Placement;

export interface ParamMeta {
  readonly path: string;
  readonly label: string;
  readonly doc: string;
  readonly unit?: string;
  readonly kind: ParamKind;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly dims?: 2 | 3;
  readonly coords?: readonly SplineCoord[];
  readonly scope: RegenScope;
  readonly stage?: StageId;
  readonly effectMetric?: MetricId;
}

export type ParamIssueCode =
  | 'UNKNOWN_KEY' | 'MISSING_KEY' | 'NOT_OBJECT' | 'NOT_NUMBER' | 'NOT_FINITE' | 'NOT_INTEGER' | 'INT_TOO_LARGE'
  | 'OUT_OF_RANGE' | 'NOT_BOOL' | 'BAD_ENUM' | 'AMPLITUDES_LENGTH' | 'AMPLITUDES_ZERO' | 'YSCALE_NOT_1'
  | 'REMAP_NEEDS_DOUBLE' | 'REMAP_NEEDS_2D' | 'BAD_INTERVAL' | 'DUPLICATE_PRIORITY';
export type PresetIssueCode = 'BAD_FORMAT' | 'BAD_NAME' | 'RESERVED_NAME' | 'UNKNOWN_PROFILE' | 'BAD_SCHEMA_VERSION' | 'NEWER_SCHEMA_VERSION';
export type IssueCode = ParamIssueCode | PresetIssueCode | 'MIGRATION_FAILED' | SplineErrorCode;

export interface Issue {
  readonly path: string;
  readonly code: IssueCode;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

// ---------------------------------------------------------------- nodes
export interface Leaf<T, P = T> {
  readonly tag: 'leaf';
  readonly kind: ParamKind;
  readonly merge: 'atomic' | 'fields';
  readonly def: T;
  readonly meta: MetaInput;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly dims?: 2 | 3;
  readonly coords?: readonly SplineCoord[];
  readonly seedName?: string;
  readonly components?: readonly ['x', 'z'];
  /** Phantom: never present at runtime. */
  readonly __patch?: P;
}

export interface Group<C extends Children = Children> {
  readonly tag: 'group';
  readonly label: string;
  readonly doc: string;
  readonly children: C;
}

export type Node = Leaf<unknown, unknown> | Group;
export interface Children {
  readonly [key: string]: Node;
}

export type Value<N> =
  N extends Leaf<infer T, unknown> ? T :
  N extends Group<infer C> ? { readonly [K in keyof C]: Value<C[K]> } :
  never;
export type Patch<N> =
  N extends Leaf<unknown, infer P> ? P :
  N extends Group<infer C> ? { readonly [K in keyof C]?: Patch<C[K]> } :
  never;

// ---------------------------------------------------------------- builders
type Ranged = MetaInput & { readonly min: number; readonly max: number; readonly step?: number };
export type NoiseMeta = MetaInput & {
  readonly wavelength: { readonly min: number; readonly max: number };
  readonly dims: 2 | 3;
  readonly seedName?: string;
  readonly components?: readonly ['x', 'z'];
};
export type SplineMeta = MetaInput & { readonly coords: readonly SplineCoord[]; readonly min: number; readonly max: number };

/** Climate axes of a box row (uniform fields, SP2a spec §3.1). */
export const BOX_AXES = ['C', 'E', 'PV', 'T', 'H'] as const;
export type BoxAxis = (typeof BOX_AXES)[number];
export type Interval = readonly [lo: number, hi: number];
/** One biome box: an interval per climate axis, a sign(W) filter (0 = any) and a unique tie-break priority. */
export type BoxRow = { readonly [A in BoxAxis]: Interval } & { readonly wSign: -1 | 0 | 1; readonly priority: number };
export type BoxTable<K extends string = string> = { readonly [R in K]: BoxRow };
export type BoxTableMeta<K extends string> = MetaInput & { readonly rows: readonly K[] };

export function num(def: number, meta: Ranged): Leaf<number> {
  return { tag: 'leaf', kind: 'number', merge: 'atomic', def, meta, min: meta.min, max: meta.max, ...(meta.step !== undefined ? { step: meta.step } : {}) };
}

export function int(def: number, meta: Ranged): Leaf<number> {
  return { tag: 'leaf', kind: 'int', merge: 'atomic', def, meta, min: meta.min, max: meta.max, step: meta.step ?? 1 };
}

export function bool(def: boolean, meta: MetaInput): Leaf<boolean> {
  return { tag: 'leaf', kind: 'bool', merge: 'atomic', def, meta };
}

export function enumOf<const V extends readonly [string, ...string[]]>(options: V, def: V[number], meta: MetaInput): Leaf<V[number]> {
  return { tag: 'leaf', kind: 'enum', merge: 'atomic', def, meta, options };
}

export function noise(def: Pick<NoiseDef, 'wavelength' | 'octaves'> & NoiseDefPatch, meta: NoiseMeta): Leaf<NoiseDef, NoiseDefPatch> {
  return {
    tag: 'leaf', kind: 'noise', merge: 'fields', def: { ...NOISE_DEF_DEFAULTS, ...def }, meta,
    min: meta.wavelength.min, max: meta.wavelength.max, dims: meta.dims,
    ...(meta.seedName !== undefined ? { seedName: meta.seedName } : {}),
    ...(meta.components !== undefined ? { components: meta.components } : {}),
  };
}

export function spline(def: NestedSpline, meta: SplineMeta): Leaf<NestedSpline> {
  return { tag: 'leaf', kind: 'spline', merge: 'atomic', def, meta, coords: meta.coords, min: meta.min, max: meta.max };
}

/** A table of named boxes (the biome table); patches replace it whole. `rows` fixes the row names. */
export function boxTable<const K extends string>(def: BoxTable<K>, meta: BoxTableMeta<K>): Leaf<BoxTable<K>> {
  return { tag: 'leaf', kind: 'boxTable', merge: 'atomic', def, meta, options: meta.rows };
}

export function group<const C extends Children>(label: string, doc: string, children: C): Group<C> {
  return { tag: 'group', label, doc, children };
}

/** Noise sub-field ranges shared by the validator and the lab widgets (wavelength ranges are per leaf). */
export const NOISE_FIELD_RANGES = {
  octaves: { min: 1, max: 16, step: 1 },
  persistence: { min: 0.05, max: 1, step: 0.01 },
  lacunarity: { min: 1.1, max: 4, step: 0.01 },
  amplitude: { min: -16, max: 16, step: 0.01 },
  yScale: { min: 0.01, max: 100, step: 0.01 },
  clampSigma: { min: 1, max: 8, step: 0.1 },
} as const;

export const NOISE_KEYS = ['wavelength', 'octaves', 'persistence', 'lacunarity', 'amplitudes', 'yScale', 'double', 'remap', 'clampSigma'] as const;

// ---------------------------------------------------------------- validation
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const join = (p: string, k: string): string => (p === '' ? k : `${p}.${k}`);
const fmt = (v: unknown): string => {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

function checkNumber(v: unknown, path: string, out: Issue[], min: number, max: number, integer: boolean): number | undefined {
  if (typeof v !== 'number') { out.push({ path, code: 'NOT_NUMBER', message: `expected a number, got ${fmt(v)}` }); return undefined; }
  if (!Number.isFinite(v)) { out.push({ path, code: 'NOT_FINITE', message: `expected a finite number, got ${String(v)}` }); return undefined; }
  if (integer && !Number.isInteger(v)) { out.push({ path, code: 'NOT_INTEGER', message: `expected an integer, got ${v}` }); return undefined; }
  if (integer && Math.abs(v) >= 1e15) { out.push({ path, code: 'INT_TOO_LARGE', message: `|${v}| must be below 1e15` }); return undefined; }
  const q = q15(v);
  if (q < min || q > max) { out.push({ path, code: 'OUT_OF_RANGE', message: `${q} outside [${min}, ${max}]` }); return undefined; }
  return q;
}

function unknownKeys(v: Record<string, unknown>, known: readonly string[], path: string, out: Issue[]): boolean {
  let any = false;
  for (const k of Object.keys(v)) {
    if (!known.includes(k)) { out.push({ path: join(path, k), code: 'UNKNOWN_KEY', message: `unknown key "${k}"` }); any = true; }
  }
  return any;
}

function checkNoise(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): NoiseDef | undefined {
  if (!isObj(v)) { out.push({ path, code: 'NOT_OBJECT', message: `expected a noise object, got ${fmt(v)}` }); return undefined; }
  const n0 = out.length;
  unknownKeys(v, NOISE_KEYS, path, out);
  for (const k of NOISE_KEYS) if (!Object.hasOwn(v, k)) out.push({ path: join(path, k), code: 'MISSING_KEY', message: 'missing' });
  if (out.length > n0) return undefined;
  const R = NOISE_FIELD_RANGES;
  const wavelength = checkNumber(v['wavelength'], join(path, 'wavelength'), out, leaf.min ?? 1, leaf.max ?? 1e6, false);
  const octaves = checkNumber(v['octaves'], join(path, 'octaves'), out, R.octaves.min, R.octaves.max, true);
  const persistence = checkNumber(v['persistence'], join(path, 'persistence'), out, R.persistence.min, R.persistence.max, false);
  const lacunarity = checkNumber(v['lacunarity'], join(path, 'lacunarity'), out, R.lacunarity.min, R.lacunarity.max, false);
  let amplitudes: number[] | null = null;
  const ap = join(path, 'amplitudes');
  const rawAmps = v['amplitudes'];
  if (rawAmps !== null) {
    if (!Array.isArray(rawAmps)) {
      out.push({ path: ap, code: 'NOT_OBJECT', message: 'expected null or an array of numbers' });
    } else {
      amplitudes = rawAmps.map((a: unknown, i: number) => checkNumber(a, `${ap}[${i}]`, out, R.amplitude.min, R.amplitude.max, false) ?? 0);
      if (octaves !== undefined && rawAmps.length !== octaves) out.push({ path: ap, code: 'AMPLITUDES_LENGTH', message: `length ${rawAmps.length} != octaves ${octaves}` });
      else if (amplitudes.every((a) => a === 0)) out.push({ path: ap, code: 'AMPLITUDES_ZERO', message: 'at least one amplitude must be non-zero' });
    }
  }
  const yScale = checkNumber(v['yScale'], join(path, 'yScale'), out, R.yScale.min, R.yScale.max, false);
  const dbl = v['double'];
  if (typeof dbl !== 'boolean') out.push({ path: join(path, 'double'), code: 'NOT_BOOL', message: `expected a boolean, got ${fmt(dbl)}` });
  const remap = v['remap'];
  if (remap !== 'none' && remap !== 'uniform') out.push({ path: join(path, 'remap'), code: 'BAD_ENUM', message: `expected "none" | "uniform", got ${fmt(remap)}` });
  const clampSigma = checkNumber(v['clampSigma'], join(path, 'clampSigma'), out, R.clampSigma.min, R.clampSigma.max, false);
  if (leaf.dims === 2 && yScale !== undefined && yScale !== 1) out.push({ path: join(path, 'yScale'), code: 'YSCALE_NOT_1', message: 'a 2D noise has yScale 1' });
  if (remap === 'uniform' && dbl === false) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_DOUBLE', message: "remap 'uniform' needs double: true" });
  if (remap === 'uniform' && leaf.dims === 3) out.push({ path: join(path, 'remap'), code: 'REMAP_NEEDS_2D', message: "remap 'uniform' is for 2D noises" });
  if (out.length > n0) return undefined;
  return {
    wavelength: wavelength!, octaves: octaves!, persistence: persistence!, lacunarity: lacunarity!, amplitudes,
    yScale: yScale!, double: dbl as boolean, remap: remap as 'none' | 'uniform', clampSigma: clampSigma!,
  };
}

const BOX_KEYS: readonly string[] = [...BOX_AXES, 'wSign', 'priority'];

function checkBoxTable(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): BoxTable | undefined {
  if (!isObj(v)) { out.push({ path, code: 'NOT_OBJECT', message: `expected a table object, got ${fmt(v)}` }); return undefined; }
  const n0 = out.length;
  const rows = leaf.options!;
  unknownKeys(v, rows, path, out);
  for (const r of rows) if (!Object.hasOwn(v, r)) out.push({ path: join(path, r), code: 'MISSING_KEY', message: 'missing' });
  if (out.length > n0) return undefined;
  const res: Record<string, BoxRow> = {};
  const seen = new Map<number, string>();
  for (const r of rows) {
    const rp = join(path, r);
    const x = v[r];
    if (!isObj(x)) { out.push({ path: rp, code: 'NOT_OBJECT', message: `expected a box row, got ${fmt(x)}` }); continue; }
    const r0 = out.length;
    unknownKeys(x, BOX_KEYS, rp, out);
    for (const k of BOX_KEYS) if (!Object.hasOwn(x, k)) out.push({ path: join(rp, k), code: 'MISSING_KEY', message: 'missing' });
    if (out.length > r0) continue;
    const row: Record<string, unknown> = {};
    for (const a of BOX_AXES) {
      const ap = join(rp, a);
      const iv = x[a];
      if (!Array.isArray(iv) || iv.length !== 2) { out.push({ path: ap, code: 'BAD_INTERVAL', message: `expected [lo, hi], got ${fmt(iv)}` }); continue; }
      const lo = checkNumber(iv[0], `${ap}[0]`, out, -1, 1, false);
      const hi = checkNumber(iv[1], `${ap}[1]`, out, -1, 1, false);
      if (lo === undefined || hi === undefined) continue;
      if (!(lo < hi)) { out.push({ path: ap, code: 'BAD_INTERVAL', message: `lo ${lo} must be below hi ${hi}` }); continue; }
      row[a] = [lo, hi];
    }
    const w = x['wSign'];
    if (w !== -1 && w !== 0 && w !== 1) out.push({ path: join(rp, 'wSign'), code: 'BAD_ENUM', message: `expected -1 | 0 | 1, got ${fmt(w)}` });
    else row['wSign'] = w;
    const pr = checkNumber(x['priority'], join(rp, 'priority'), out, 1, 1000, true);
    if (pr !== undefined) {
      const other = seen.get(pr);
      if (other !== undefined) out.push({ path: join(rp, 'priority'), code: 'DUPLICATE_PRIORITY', message: `priority ${pr} is also used by ${other}` });
      else seen.set(pr, r);
      row['priority'] = pr;
    }
    if (out.length === r0) res[r] = row as BoxRow;
  }
  return out.length > n0 ? undefined : res;
}

function checkSpline(v: unknown, path: string, out: Issue[], leaf: Leaf<unknown, unknown>): NestedSpline | undefined {
  const issues = validateSpline(v, path, { ...(leaf.coords !== undefined ? { coords: leaf.coords } : {}), yMin: leaf.min ?? -Infinity, yMax: leaf.max ?? Infinity });
  if (issues.length > 0) { out.push(...issues); return undefined; }
  return normalizeSpline(v as NestedSpline);
}

/** Validates a complete leaf value; returns the normalised value, or undefined with issues appended. */
export function checkLeaf(leaf: Leaf<unknown, unknown>, v: unknown, path: string, out: Issue[]): unknown {
  switch (leaf.kind) {
    case 'number': return checkNumber(v, path, out, leaf.min ?? -Infinity, leaf.max ?? Infinity, false);
    case 'int': return checkNumber(v, path, out, leaf.min ?? -Infinity, leaf.max ?? Infinity, true);
    case 'bool':
      if (typeof v !== 'boolean') { out.push({ path, code: 'NOT_BOOL', message: `expected a boolean, got ${fmt(v)}` }); return undefined; }
      return v;
    case 'enum':
      if (typeof v !== 'string' || !leaf.options!.includes(v)) { out.push({ path, code: 'BAD_ENUM', message: `expected one of ${leaf.options!.join(' | ')}, got ${fmt(v)}` }); return undefined; }
      return v;
    case 'noise': return checkNoise(v, path, out, leaf);
    case 'spline': return checkSpline(v, path, out, leaf);
    case 'boxTable': return checkBoxTable(v, path, out, leaf);
    default: throw new Error(`no validator for kind ${leaf.kind} yet`);
  }
}

export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ---------------------------------------------------------------- schema
export interface LeafInfo {
  readonly path: string;
  readonly leaf: Leaf<unknown, unknown>;
  readonly meta: ParamMeta;
}

export interface NodeInfo {
  readonly path: string;
  readonly depth: number;
  readonly node: Node;
}

export interface Schema<R extends Group> {
  readonly root: R;
  /** Pre-order, declaration order. */
  readonly nodes: readonly NodeInfo[];
  readonly leaves: readonly LeafInfo[];
  readonly byPath: ReadonlyMap<string, Node>;
  readonly defaults: Value<R>;
}

function toMeta(path: string, l: Leaf<unknown, unknown>): ParamMeta {
  const m = l.meta;
  return {
    path, label: m.label, doc: m.doc, kind: l.kind,
    ...(m.unit !== undefined ? { unit: m.unit } : {}),
    ...(l.min !== undefined ? { min: l.min } : {}),
    ...(l.max !== undefined ? { max: l.max } : {}),
    ...(l.step !== undefined ? { step: l.step } : {}),
    ...(l.options !== undefined ? { options: l.options } : {}),
    ...(l.dims !== undefined ? { dims: l.dims } : {}),
    ...(l.coords !== undefined ? { coords: l.coords } : {}),
    scope: m.scope,
    ...(m.stage !== undefined ? { stage: m.stage } : {}),
    ...(m.effectMetric !== undefined ? { effectMetric: m.effectMetric } : {}),
  };
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Indexes the schema and validates every default; throws on schema bugs (bad keys, bounds or defaults). */
export function buildSchema<R extends Group>(root: R): Schema<R> {
  const nodes: NodeInfo[] = [];
  const leaves: LeafInfo[] = [];
  const byPath = new Map<string, Node>();
  const errs: Issue[] = [];
  const walk = (n: Node, path: string, depth: number): unknown => {
    nodes.push({ path, depth, node: n });
    byPath.set(path, n);
    if (n.tag === 'leaf') {
      for (const b of [n.min, n.max, n.step]) {
        if (b !== undefined && Number.isFinite(b) && q15(b) !== b) throw new Error(`schema bound ${b} at ${path} is not q15-stable`);
      }
      leaves.push({ path, leaf: n, meta: toMeta(path, n) });
      return checkLeaf(n, n.def, path, errs);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) {
      if (!KEY_RE.test(k)) throw new Error(`schema key "${k}" at ${path === '' ? '<root>' : path} must match ${KEY_RE.source}`);
      out[k] = walk(n.children[k]!, join(path, k), depth + 1);
    }
    return out;
  };
  const defaults = walk(root, '', 0);
  if (errs.length > 0) throw new Error(`invalid schema defaults:\n${errs.map((e) => `  ${e.path}: ${e.code} ${e.message}`).join('\n')}`);
  return { root, nodes, leaves, byPath, defaults: deepFreeze(defaults) as Value<R> };
}

/** Validates a complete params document (saves, .wiworld): every key required, unknown keys rejected. */
export function checkParams<R extends Group>(s: Schema<R>, v: unknown): Result<Value<R>> {
  const out: Issue[] = [];
  const walk = (n: Node, x: unknown, path: string): unknown => {
    if (n.tag === 'leaf') return checkLeaf(n, x, path, out);
    if (!isObj(x)) { out.push({ path, code: 'NOT_OBJECT', message: `expected an object, got ${fmt(x)}` }); return undefined; }
    unknownKeys(x, Object.keys(n.children), path, out);
    const res: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) {
      if (!Object.hasOwn(x, k)) { out.push({ path: join(path, k), code: 'MISSING_KEY', message: 'missing' }); continue; }
      res[k] = walk(n.children[k]!, x[k], join(path, k));
    }
    return res;
  };
  const value = walk(s.root, v, '');
  return out.length > 0 ? { ok: false, issues: out } : { ok: true, value: deepFreeze(value) as Value<R> };
}

// ---------------------------------------------------------------- patches
/**
 * Deep-merges a partial document over `base` with validation (profiles, presets, lab URL, panel edits,
 * saves). Groups and noise leaves merge per key; other leaves are replaced whole. Collects every issue
 * and applies nothing on error. A subtree the patch does not mention keeps its reference.
 */
export function applyPatch<R extends Group>(s: Schema<R>, base: Value<R>, patch: unknown): Result<Value<R>> {
  const out: Issue[] = [];
  const walk = (n: Node, b: unknown, p: unknown, path: string): unknown => {
    if (p === undefined) return b;
    if (n.tag === 'leaf') {
      if (n.merge === 'fields') {
        if (!isObj(p)) { out.push({ path, code: 'NOT_OBJECT', message: `expected an object, got ${fmt(p)}` }); return b; }
        if (unknownKeys(p, NOISE_KEYS, path, out)) return b;
        const merged: Record<string, unknown> = { ...(b as Record<string, unknown>) };
        for (const k of NOISE_KEYS) if (p[k] !== undefined) merged[k] = p[k];
        return checkLeaf(n, merged, path, out) ?? b;
      }
      return checkLeaf(n, p, path, out) ?? b;
    }
    if (!isObj(p)) { out.push({ path, code: 'NOT_OBJECT', message: `expected an object, got ${fmt(p)}` }); return b; }
    unknownKeys(p, Object.keys(n.children), path, out);
    const bb = b as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    let changed = false;
    for (const k of Object.keys(n.children)) {
      const v = Object.hasOwn(p, k) ? walk(n.children[k]!, bb[k], p[k], join(path, k)) : bb[k];
      res[k] = v;
      if (v !== bb[k]) changed = true;
    }
    return changed ? res : b;
  };
  const value = walk(s.root, base, patch, '');
  return out.length > 0 ? { ok: false, issues: out } : { ok: true, value: deepFreeze(value) as Value<R> };
}

/** Minimal patch with applyPatch(s, base, diffParams(s, base, v)) canonically equal to v. */
export function diffParams<R extends Group>(s: Schema<R>, base: Value<R>, value: Value<R>): Patch<R> {
  const walk = (n: Node, b: unknown, x: unknown): unknown => {
    if (n.tag === 'leaf') {
      if (n.merge === 'fields' && isObj(b) && isObj(x)) {
        const d: Record<string, unknown> = {};
        for (const k of NOISE_KEYS) if (canonicalJSON(x[k]) !== canonicalJSON(b[k])) d[k] = x[k];
        return Object.keys(d).length > 0 ? d : undefined;
      }
      return canonicalJSON(b) === canonicalJSON(x) ? undefined : x;
    }
    const d: Record<string, unknown> = {};
    const bb = b as Record<string, unknown>;
    const xx = x as Record<string, unknown>;
    for (const k of Object.keys(n.children)) {
      const c = walk(n.children[k]!, bb[k], xx[k]);
      if (c !== undefined) d[k] = c;
    }
    return Object.keys(d).length > 0 ? d : undefined;
  };
  return (walk(s.root, base, value) ?? {}) as Patch<R>;
}

export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let cur: unknown = value;
  for (const k of path.split('.')) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** {a: {b: value}} for path "a.b". */
export function patchAt(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  let acc: unknown = value;
  for (let i = keys.length - 1; i >= 0; i--) acc = { [keys[i]!]: acc };
  return acc as Record<string, unknown>;
}

// ---------------------------------------------------------------- README reference
/** Markdown parameter table (SP1 spec §4.7): path | kind | default | range | unit | scope | doc. */
export function renderReference<R extends Group>(s: Schema<R>): string {
  const esc = (t: string) => t.replaceAll('|', '\\|');
  const rows = ['| path | kind | default | range | unit | scope | doc |', '|---|---|---|---|---|---|---|'];
  for (const { path, meta } of s.leaves) {
    const value = getPath(s.defaults, path);
    const def = meta.kind === 'boxTable' ? `${Object.keys(value as object).length} rows` : canonicalJSON(value);
    const range = meta.options !== undefined ? meta.options.join(' / ')
      : meta.kind === 'noise' ? `wavelength ${meta.min} … ${meta.max}`
      : meta.min !== undefined ? `${meta.min} … ${meta.max}` : '';
    rows.push(`| \`${path}\` | ${meta.kind} | ${esc(def)} | ${esc(range)} | ${esc(meta.unit ?? '')} | ${meta.scope} | ${esc(`${meta.label}: ${meta.doc}`)} |`);
  }
  return rows.join('\n');
}

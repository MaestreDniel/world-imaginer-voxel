/**
 * The Density tab's node form model (SP3d spec §3.3, §1.5, D7, D18): every form operation is a pure function of the
 * session's params and the selection that yields a candidate tree for the selected root (`FormEdit`), committed with
 * one `session.set('<leaf>', candidate)` by `commitFormEdit` (one undo step; validated first with both tiers, so an
 * invalid tree is never sent, and a refusal comes back as issue lines). Node paths are never session paths.
 *
 * Operations: the fields of the selected node (`formFields`: one per scalar, with the select options of noises, sample
 * fields, defs, block states, biomes and sides); parameter refs on every numeric field (`setNumber`: on `const.v` a
 * target replaces the node by `{op: 'param', path}` and "literal" turns a `param` node back into `const(<its current
 * value>)`; elsewhere the ref form `{param, neg?}` and "literal" writes the current resolved value; an int field lists
 * only int targets, `refOptions`); replace op / kind with children kept by position in `SOURCE_CHILD_KEYS` order, the
 * per-kind defaults below and the options that cannot validate disabled (`opOptions`, `replaceOp`); wrap (`wrapNode`),
 * delete (`deleteNode`; a referenced def's deletion is refused by tier 2's `UNKNOWN_REF`), add def and add rule,
 * rename def with every ref to it (`renameDef`), the mute toggle with the neutral value of the tap's parent
 * (`muteValue`, `toggleMute`), and slide knots sorted by y on every commit (`setKnots`). `treeLints` gives the two tree
 * warnings ("no fast path", "density cost ≈ N × the default"), never refusals. The per-kind defaults live here (gen may
 * not export numbers). Every lookup keyed by tree content reads own properties only, and keys are written with
 * `Object.defineProperty`, so a typed `__proto__` def name reaches tier 1 as `BAD_KEY`. Pure; no DOM.
 */
import { DEFAULT_DENSITY_TREE } from '../../core/params/defaultTrees';
import type { JsonFormat, JsonValue } from '../../core/params/json';
import { getPath } from '../../core/params/kit';
import { SCHEMA, type Params } from '../../core/params/schema';
import { SURFACE_BIOMES } from '../../gen/biomes/registry';
import { SAMPLE_FIELDS } from '../../gen/column/columnStage';
import { ALLOWED_REF_TARGETS, resolveDensity, SOURCE_CHILD_KEYS, SOURCE_OPS, type ParamRef } from '../../gen/density/source';
import { workCost } from '../../gen/inspect/cost';
import { surfaceFastPath } from '../../gen/surface/compile';
import { CONDITION_KINDS, FIELDS, RULE_KINDS } from '../../gen/surface/rules';
import { surfaceDepthMax } from '../../gen/surface/scan';
import { resolveRules } from '../../gen/surface/source';
import { COLLIDE, REGISTRY } from '../../world/blocks/index';
import { COLLIDE_NONE } from '../../world/blocks/kinds';
import { parseFieldText } from '../paramPanel/model';
import { checkLeafCandidate, formatOfLeaf, leafValue, stripLeaf, withLeaf, type EditorIssue, type EditorSession, type TreeLeaf } from './editorModel';
import { findNode, followNode, pathSteps, type Selection, type TreeNode } from './model';

/** What a form operation yields: the leaf's candidate value and the selection after it, or a refusal. */
export type FormEdit =
  | { readonly ok: true; readonly leaf: TreeLeaf; readonly value: unknown; readonly select: Selection }
  | { readonly ok: false; readonly issues: readonly EditorIssue[] };

/** A committed edit's outcome: the selection to show (followed, §3.2), or the issues (the selection is kept). */
export type FormCommit =
  | { readonly ok: true; readonly select: Selection }
  | { readonly ok: false; readonly issues: readonly EditorIssue[] };

/** A numeric field's value in the source: a literal or a parameter ref. */
export type NumberValue = number | ParamRef;

/** One control of the form. `key` is the node field (`knots[i][j]` for a knot cell, `defName` for a def's name). */
export type FormField =
  | {
    readonly type: 'number'; readonly key: string; readonly value: NumberValue; readonly current: number;
    /** Only int targets may stand here (§1.3). */
    readonly int: boolean;
    /** "negate" is offered (every numeric field but `const.v`). */
    readonly negatable: boolean;
  }
  | { readonly type: 'select'; readonly key: string; readonly value: string; readonly options: readonly string[] }
  | { readonly type: 'boolean'; readonly key: string; readonly value: boolean }
  | { readonly type: 'name'; readonly key: string; readonly value: string }
  | { readonly type: 'knots'; readonly key: 'knots'; readonly value: readonly (readonly [NumberValue, NumberValue])[] }
  | { readonly type: 'biomes'; readonly key: 'biomes'; readonly value: readonly string[]; readonly options: readonly string[] };

/** A numeric field's new value: a literal (`value` omitted: the field's current value) or a ref to a target. */
export type NumberChoice =
  | { readonly kind: 'literal'; readonly value?: number }
  | { readonly kind: 'param'; readonly path: string; readonly neg?: boolean };

/** A ref target as the select lists it: `<path> = <current value>`. */
export interface RefOption {
  readonly path: string;
  readonly label: string;
  readonly value: number;
  readonly int: boolean;
}

export interface OpOption {
  readonly op: string;
  readonly disabled: boolean;
  readonly current: boolean;
}

/** The actions the form offers on the selection. */
export interface FormActions {
  readonly wrap: boolean;
  readonly delete: boolean;
  readonly addRule: boolean;
  readonly renameDef: boolean;
  readonly mute: boolean;
}

/** The lints (§3.3): warnings, never refusals. */
export const LINT_NO_FAST_PATH = 'no fast path: every solid voxel is evaluated';
/** The density lint fires above this many times the default root's work cost. */
export const LINT_COST_FACTOR = 4;
export const densityCostLint = (ratio: number): string => `density cost ≈ ${String(Math.round(ratio * 10) / 10)} × the default`;

/** The mute toggle's value under each parent op (§1.5: the `islands` convention); 0 elsewhere. */
const MUTE_NEUTRAL: ReadonlyMap<string, number> = new Map([['add', 0], ['mul', 1], ['max', -1e6], ['min', 1e6]]);
/** Ops with one child slot: deleting one unwraps it (§3.3). */
const UNWRAP_OPS: ReadonlySet<string> = new Set(['neg', 'abs', 'square', 'clamp', 'slide', 'interpolated', 'tap', 'recip']);
/** Scalars a replaced op keeps when the new op has the same field with the same meaning. */
const KEPT_SCALARS: ReadonlyMap<string, readonly string[]> = new Map([['clamp', ['lo', 'hi']], ['rangeChoice', ['lo', 'hi']]]);
/** The rules' numeric fields and whether they are int fields (§1.3). */
const RULE_NUMBERS: ReadonlyMap<string, boolean> = new Map([
  ['offset', true], ['minY', true], ['trueAtAndBelow', true], ['falseAtAndAbove', true], ['min', false], ['max', false], ['t', false],
]);
const RULE_CHILD_FIELDS: ReadonlySet<string> = new Set(['if', 'then', 'rules']);
const KNOT_KEY = /^knots\[(0|[1-9][0-9]*)\]\[([01])\]$/;
const DEF_ROOT = /^defs\.([^.[]+)$/;

/** The colliding block states, in registry order (a `block` rule's select, §3.3). */
export const BLOCK_STATE_OPTIONS: readonly string[] = Object.freeze((() => {
  const out: string[] = [];
  for (let s = 0; s < REGISTRY.stateCount; s++) if (COLLIDE[s] !== COLLIDE_NONE) out.push(REGISTRY.stateKey(s));
  return out;
})());
export const BIOME_OPTIONS: readonly string[] = Object.freeze([...SURFACE_BIOMES]);
export const COL_FIELD_OPTIONS: readonly string[] = Object.freeze([...SAMPLE_FIELDS]);
export const SIDE_OPTIONS: readonly string[] = Object.freeze(['floor', 'ceiling']);

/** The schema's noise leaves under `prefix` of dims `dims`, as their names after the prefix (density) or paths (rules). */
function schemaNoises(prefix: string, dims: 2 | 3, strip: boolean): readonly string[] {
  const out: string[] = [];
  for (const { path, leaf } of SCHEMA.leaves) {
    if (leaf.kind === 'noise' && path.startsWith(prefix) && (leaf.dims ?? 2) === dims) out.push(strip ? path.slice(prefix.length) : path);
  }
  return Object.freeze(out);
}
/** `noise2` reads the 2D density noises, `noise` the 3D ones (by id); `noiseThreshold` a 2D surface noise (by path). */
export const DENSITY_NOISE_OPTIONS: Readonly<Record<'noise' | 'noise2', readonly string[]>> = Object.freeze({
  noise2: schemaNoises('density.noises.', 2, true), noise: schemaNoises('density.noises.', 3, true),
});
export const SURFACE_NOISE_OPTIONS: readonly string[] = schemaNoises('surface.noises.', 2, false);

type Rec = Readonly<Record<string, unknown>>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (r: unknown, k: string): unknown => (isRec(r) && Object.hasOwn(r, k) ? r[k] : undefined);
const isRef = (v: unknown): v is ParamRef => isRec(v) && typeof own(v, 'param') === 'string';
const tagOf = (format: JsonFormat): string => (format === 'density' ? 'op' : 'kind');

/** A plain object with these own entries, every key defined (never [[Set]]: `__proto__` stays an own key). */
function record(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}
const withKey = (r: Rec, k: string, v: unknown): Record<string, unknown> =>
  record([...Object.entries(r).filter(([key]) => key !== k), [k, v]]);
const withoutKey = (r: Rec, k: string): Record<string, unknown> => record(Object.entries(r).filter(([key]) => key !== k));

/** `value` with the item at `steps` replaced by `fn(old)` (copy on write along the path). */
function updateAt(value: unknown, steps: readonly (string | number)[], fn: (old: unknown) => unknown, i = 0): unknown {
  if (i === steps.length) return fn(value);
  const s = steps[i]!;
  if (typeof s === 'number') {
    if (!Array.isArray(value) || s >= value.length) throw new RangeError(`form: no item ${String(s)}`);
    const out = [...(value as readonly unknown[])];
    out[s] = updateAt(out[s], steps, fn, i + 1);
    return out;
  }
  if (!isRec(value) || !Object.hasOwn(value, s)) throw new RangeError(`form: no field ${s}`);
  return withKey(value, s, updateAt(value[s], steps, fn, i + 1));
}

interface Located {
  readonly leaf: TreeLeaf;
  readonly format: JsonFormat;
  readonly value: unknown;
  readonly node: TreeNode;
  readonly steps: readonly (string | number)[];
}

/** The selected node, or a RangeError (the DOM only offers operations on existing nodes). */
function locate(params: Params, sel: Selection): Located {
  const format = formatOfLeaf(sel.leaf);
  const value = leafValue(params, sel.leaf);
  const node = findNode(value, format, sel.path);
  const steps = pathSteps(sel.path, format);
  if (node === undefined || steps === null) throw new RangeError(`form: "${sel.path}" names no node of ${sel.leaf}`);
  return { leaf: sel.leaf, format, value, node, steps };
}

const edit = (at: Located, value: unknown, path: string): FormEdit => ({ ok: true, leaf: at.leaf, value, select: { leaf: at.leaf, path } });
const replaceNode = (at: Located, fn: (old: TreeNode) => unknown, path: string): FormEdit =>
  edit(at, updateAt(at.value, at.steps, (old) => fn(old as TreeNode)), path);

/** A rules node under `.if` is a condition. */
const isCondition = (at: Located): boolean => at.format === 'surfaceRules' && at.steps.at(-1) === 'if';

/** The number a source numeric value stands for under `params`: a literal, or a ref's target value (0 − v with `neg`). */
export function currentNumber(params: Params, v: unknown): number {
  if (typeof v === 'number') return v;
  if (!isRef(v)) return Number.NaN;
  const t = getPath(params, v.param);
  if (typeof t !== 'number') return Number.NaN;
  return v.neg === true ? 0 - t : t;
}

/** The ref targets a numeric field may name, each with its current value; an int field lists only int targets. */
export function refOptions(params: Params, int: boolean): RefOption[] {
  const out: RefOption[] = [];
  for (const [path, t] of ALLOWED_REF_TARGETS) {
    if (int && t.kind !== 'int') continue;
    const value = currentNumber(params, { param: path });
    out.push({ path, label: `${path} = ${String(value)}`, value, int: t.kind === 'int' });
  }
  return out;
}

/** The density's tap names (root and every def), for fresh names. */
function tapNames(value: unknown): Set<string> {
  const names = new Set<string>();
  const stack: unknown[] = [own(value, 'root'), ...Object.values(isRec(own(value, 'defs')) ? (own(value, 'defs') as Rec) : {})];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!isRec(n) || typeof n['op'] !== 'string') continue;
    if (n['op'] === 'tap' && typeof own(n, 'name') === 'string') names.add(n['name'] as string);
    const slots = Object.hasOwn(SOURCE_CHILD_KEYS, n['op']) ? (SOURCE_CHILD_KEYS as Readonly<Record<string, readonly string[]>>)[n['op']]! : [];
    for (const k of slots) stack.push(own(n, k));
  }
  return names;
}

/** `<prefix><k>` with the smallest k ≥ 1 not in `used`. */
function fresh(prefix: string, used: ReadonlySet<string>): string {
  for (let k = 1; ; k++) if (!used.has(`${prefix}${String(k)}`)) return `${prefix}${String(k)}`;
}

/** A fresh tap name `tap<k>` for a density leaf value (§3.3). */
export const freshTapName = (value: unknown): string => fresh('tap', tapNames(value));

const defNames = (value: unknown): string[] => {
  const defs = own(value, 'defs');
  return isRec(defs) ? Object.keys(defs).sort() : [];
};

/** The defaults of a density op's scalars (§3.3); `value` is the leaf value (for fresh names, defs and targets). */
function densityScalars(op: string, value: unknown): [string, unknown][] {
  switch (op) {
    case 'const': return [['v', 0]];
    case 'clamp': case 'rangeChoice': return [['lo', 0], ['hi', 1]];
    case 'slide': return [['knots', [[-64, 0], [320, 1]]]];
    case 'noise': case 'noise2': return [['id', DENSITY_NOISE_OPTIONS[op][0]]];
    case 'col': return [['field', 'offset']];
    case 'tap': return [['name', freshTapName(value)]];
    case 'ref': return [['name', defNames(value)[0]]];
    case 'param': return [['path', ALLOWED_REF_TARGETS.keys().next().value]];
    default: return [];
  }
}

const CONST_0 = (): Rec => record([['op', 'const'], ['v', 0]]);
const SKY_OPEN = (): Rec => record([['kind', 'skyOpen']]);
const EMPTY_SEQUENCE = (): Rec => record([['kind', 'sequence'], ['rules', []]]);

/** A condition kind's defaults (§3.3); `not` wraps the old condition. */
function defaultCondition(kind: string, old: TreeNode): Rec {
  const k = (entries: [string, unknown][]): Rec => record([['kind', kind], ...entries]);
  switch (kind) {
    case 'biome': return k([['biomes', ['plains']]]);
    case 'stoneDepth': return k([['side', 'floor'], ['offset', 0], ['addSurfaceDepth', false]]);
    case 'water': return k([['offset', 0], ['runTop', false]]);
    case 'yAbove': return k([['minY', 63], ['runTop', false]]);
    case 'verticalGradient': return k([['trueAtAndBelow', 0], ['falseAtAndAbove', 8]]);
    case 'steep': return k([['min', 1]]);
    case 'noiseThreshold': return k([['noise', 'surface.noises.patch'], ['min', 0], ['max', 8]]);
    case 'temperatureBelow': return k([['t', 0]]);
    case 'not': return k([['if', old]]);
    default: return k([]);
  }
}

/** A rule kind replacing `old`, keeping its child: `rules: [then]` / `then: rules[0]` or an empty sequence (§3.3). */
function replacedRule(kind: string, old: TreeNode): Rec {
  const oldKind = old['kind'];
  const children: unknown[] = oldKind === 'sequence' ? [...((own(old, 'rules') as readonly unknown[] | undefined) ?? [])]
    : oldKind === 'condition' ? [own(old, 'then')] : [];
  switch (kind) {
    case 'sequence': return record([['kind', 'sequence'], ['rules', children]]);
    case 'condition': return record([['kind', 'condition'], ['if', SKY_OPEN()], ['then', children[0] ?? EMPTY_SEQUENCE()]]);
    case 'block': return record([['kind', 'block'], ['state', 'stone']]);
    default: return record([['kind', kind]]);
  }
}

/** The old node's children in evaluation order (`SOURCE_CHILD_KEYS`). */
function densityChildren(node: TreeNode): unknown[] {
  const op = node['op'] as string;
  const slots = Object.hasOwn(SOURCE_CHILD_KEYS, op) ? (SOURCE_CHILD_KEYS as Readonly<Record<string, readonly string[]>>)[op]! : [];
  return slots.filter((k) => Object.hasOwn(node, k)).map((k) => node[k]);
}

/** `op` replacing `old`: children by position, missing slots `const 0` (`recip`'s `const 1`), kept and default scalars. */
function replacedDensity(op: string, old: TreeNode, value: unknown): Rec {
  const children = densityChildren(old);
  const entries: [string, unknown][] = [['op', op]];
  const kept = KEPT_SCALARS.get(op) ?? [];
  for (const [k, v] of densityScalars(op, value)) {
    entries.push([k, (KEPT_SCALARS.get(old['op'] as string) ?? []).includes(k) && kept.includes(k) && Object.hasOwn(old, k) ? old[k] : v]);
  }
  (SOURCE_CHILD_KEYS as Readonly<Record<string, readonly string[]>>)[op]!.forEach((slot, i) => {
    entries.push([slot, i < children.length ? children[i] : op === 'recip' ? record([['op', 'const'], ['v', 1]]) : CONST_0()]);
  });
  return record(entries);
}

const isConstOperand = (v: unknown): boolean => isRec(v) && (v['op'] === 'const' || v['op'] === 'param');

/** The ops / kinds the selected node may become (§3.3), with the options that cannot validate disabled. */
export function opOptions(params: Params, sel: Selection): OpOption[] {
  const at = locate(params, sel);
  const current = at.node[tagOf(at.format)];
  if (at.format === 'surfaceRules') {
    const kinds = isCondition(at) ? CONDITION_KINDS : RULE_KINDS;
    return kinds.map((op) => ({ op, disabled: false, current: op === current }));
  }
  const first = densityChildren(at.node)[0];
  return SOURCE_OPS.map((op) => ({
    op,
    disabled: (op === 'ref' && defNames(at.value).length === 0) || (op === 'recip' && first !== undefined && !isConstOperand(first)),
    current: op === current,
  }));
}

/** Replace op / kind (§3.3); the selection stays on the node. RangeError for a disabled or unknown option. */
export function replaceOp(params: Params, sel: Selection, op: string): FormEdit {
  const option = opOptions(params, sel).find((o) => o.op === op);
  if (option === undefined || option.disabled) throw new RangeError(`form: "${op}" is not available on ${sel.path}`);
  const at = locate(params, sel);
  if (option.current) return edit(at, at.value, sel.path);
  if (at.format === 'density') return replaceNode(at, (old) => replacedDensity(op, old, at.value), sel.path);
  return replaceNode(at, (old) => (isCondition(at) ? defaultCondition(op, old) : replacedRule(op, old)), sel.path);
}

/** What the form offers on the selection. */
export function formActions(params: Params, sel: Selection): FormActions {
  const at = locate(params, sel);
  if (at.format === 'density') {
    return { wrap: true, delete: true, addRule: false, renameDef: DEF_ROOT.test(sel.path), mute: at.node['op'] === 'tap' };
  }
  const cond = isCondition(at);
  return { wrap: !cond, delete: !cond || at.node['kind'] === 'not', addRule: at.node['kind'] === 'sequence', renameDef: false, mute: false };
}

/** Wrap (§3.3): density in a `tap` with a fresh name; a rule in a one-child `sequence`. The selection is the wrapper. */
export function wrapNode(params: Params, sel: Selection): FormEdit {
  const at = locate(params, sel);
  if (!formActions(params, sel).wrap) throw new RangeError(`form: a condition cannot be wrapped (${sel.path})`);
  if (at.format === 'density') {
    const name = freshTapName(at.value);
    return replaceNode(at, (old) => record([['op', 'tap'], ['name', name], ['x', old]]), sel.path);
  }
  return replaceNode(at, (old) => record([['kind', 'sequence'], ['rules', [old]]]), sel.path);
}

/**
 * Delete (§3.3). Density: a def's top removes the def (tier 2 refuses it with `UNKNOWN_REF` while a ref names it);
 * a one-child-slot node is unwrapped; any other node becomes `const 0`. Rules: a sequence child is removed (later
 * siblings renumber, the selection follows); the root or a `then` becomes an empty sequence; a `not` is unwrapped.
 */
export function deleteNode(params: Params, sel: Selection): FormEdit {
  const at = locate(params, sel);
  if (!formActions(params, sel).delete) throw new RangeError(`form: this condition can only be replaced (${sel.path})`);
  if (at.format === 'density') {
    const def = DEF_ROOT.exec(sel.path);
    if (def !== null) {
      const defs = own(at.value, 'defs') as Rec;
      return edit(at, withKey(at.value as Rec, 'defs', withoutKey(defs, def[1]!)), 'root');
    }
    const op = at.node['op'] as string;
    const child = UNWRAP_OPS.has(op) ? densityChildren(at.node)[0] : undefined;
    return replaceNode(at, () => child ?? CONST_0(), sel.path);
  }
  const last = at.steps.at(-1);
  if (typeof last === 'number') {
    const seqSteps = at.steps.slice(0, -1);
    const value = updateAt(at.value, seqSteps, (rules) => (rules as readonly unknown[]).filter((_, i) => i !== last));
    const after = followNode(withLeaf(params, at.leaf, value as JsonValue), sel);
    return edit(at, value, after.path);
  }
  if (at.node['kind'] === 'not') return replaceNode(at, (old) => own(old, 'if'), sel.path);
  return replaceNode(at, () => EMPTY_SEQUENCE(), sel.path);
}

/** "Add def": `def<k>` = `const 0`, selected. */
export function addDef(params: Params): FormEdit {
  const value = params.density.defs;
  const defs = isRec(own(value, 'defs')) ? (own(value, 'defs') as Rec) : {};
  const name = fresh('def', new Set(Object.keys(defs)));
  const out = withKey(value as Rec, 'defs', withKey(defs, name, CONST_0()));
  return { ok: true, leaf: 'density.defs', value: out, select: { leaf: 'density.defs', path: `defs.${name}` } };
}

/** "Add rule": appends `block stone` to the selected `sequence`, selected. */
export function addRule(params: Params, sel: Selection): FormEdit {
  const at = locate(params, sel);
  if (!formActions(params, sel).addRule) throw new RangeError(`form: rules are added to a sequence (${sel.path})`);
  const rules = own(at.node, 'rules') as readonly unknown[];
  return replaceNode(at, (old) => withKey(old, 'rules', [...rules, record([['kind', 'block'], ['state', 'stone']])]), `${sel.path}.rules[${String(rules.length)}]`);
}

/** Every `ref` to `from` (in `root` and every def, muted subtrees included) renamed to `to`. */
function renameRefs(node: unknown, from: string, to: string): unknown {
  if (!isRec(node) || typeof node['op'] !== 'string') return node;
  if (node['op'] === 'ref') return own(node, 'name') === from ? withKey(node, 'name', to) : node;
  let out: Rec = node;
  const slots = Object.hasOwn(SOURCE_CHILD_KEYS, node['op']) ? (SOURCE_CHILD_KEYS as Readonly<Record<string, readonly string[]>>)[node['op']]! : [];
  for (const k of slots) {
    const c = own(node, k);
    const r = renameRefs(c, from, to);
    if (r !== c) out = withKey(out, k, r);
  }
  return out;
}

/** Rename def (§3.3): one edit renaming the def and every ref to it; refused when `to` already names a def. */
export function renameDef(params: Params, from: string, to: string): FormEdit {
  const value = params.density.defs as Rec;
  const defs = own(value, 'defs');
  if (!isRec(defs) || !Object.hasOwn(defs, from)) throw new RangeError(`form: no def ${JSON.stringify(from)}`);
  const select: Selection = { leaf: 'density.defs', path: `defs.${to}` };
  if (to === from) return { ok: true, leaf: 'density.defs', value, select };
  if (Object.hasOwn(defs, to)) {
    return { ok: false, issues: [{ path: `defs.${to}`, code: 'DEF_EXISTS', message: `a def named ${JSON.stringify(to)} already exists` }] };
  }
  const renamed = record(Object.entries(defs).map(([k, v]) => [k === from ? to : k, renameRefs(v, from, to)] as const));
  return { ok: true, leaf: 'density.defs', value: record([...Object.entries(value).filter(([k]) => k !== 'root' && k !== 'defs'), ['root', renameRefs(own(value, 'root'), from, to)], ['defs', renamed]]), select };
}

/** The mute toggle's value for the selected tap (§1.5, D7): the neutral value of its parent op in the source. */
export function muteValue(params: Params, sel: Selection): number {
  locate(params, sel);
  if (sel.path === 'root' || DEF_ROOT.test(sel.path)) return 0;
  const parent = findNode(params.density.defs, 'density', sel.path.slice(0, sel.path.lastIndexOf('.')));
  return MUTE_NEUTRAL.get(parent?.['op'] as string) ?? 0;
}

/** The mute toggle (§1.5): a muted tap loses its `mute`; an unmuted one gets `muteValue`. */
export function toggleMute(params: Params, sel: Selection): FormEdit {
  const at = locate(params, sel);
  if (at.node['op'] !== 'tap') throw new RangeError(`form: only a tap can be muted (${sel.path})`);
  const m = muteValue(params, sel);
  return replaceNode(at, (old) => (Object.hasOwn(old, 'mute') ? withoutKey(old, 'mute') : withKey(old, 'mute', m)), sel.path);
}

/** Knots sorted by y (literal or the ref's current value), stably (§3.3: the table commits sorted). */
function sortKnots(params: Params, knots: readonly (readonly [unknown, unknown])[]): unknown[][] {
  return knots.map((k, i) => ({ k, y: currentNumber(params, k[0]), i }))
    .sort((a, b) => (a.y < b.y ? -1 : a.y > b.y ? 1 : a.i - b.i))
    .map(({ k }) => [k[0], k[1]]);
}

/** The slide table's commit: the knots sorted by y. */
export function setKnots(params: Params, sel: Selection, knots: readonly (readonly [NumberValue, NumberValue])[]): FormEdit {
  const at = locate(params, sel);
  if (at.node['op'] !== 'slide') throw new RangeError(`form: ${sel.path} is not a slide`);
  return replaceNode(at, (old) => withKey(old, 'knots', sortKnots(params, knots)), sel.path);
}

/** Whether `key` is a numeric field of the node, and an int one. */
function numberField(at: Located, key: string): { int: boolean } | null {
  if (at.format === 'surfaceRules') {
    const kind = at.node['kind'] as string;
    const fields = Object.hasOwn(FIELDS, kind) ? (FIELDS as Readonly<Record<string, readonly string[]>>)[kind]! : [];
    return fields.includes(key) && RULE_NUMBERS.has(key) ? { int: RULE_NUMBERS.get(key)! } : null;
  }
  const op = at.node['op'];
  if (key === 'v') return op === 'const' || op === 'param' ? { int: false } : null;
  if (key === 'lo' || key === 'hi') return op === 'clamp' || op === 'rangeChoice' ? { int: false } : null;
  if (key === 'mute') return op === 'tap' ? { int: false } : null;
  return op === 'slide' && KNOT_KEY.test(key) ? { int: false } : null;
}

/**
 * Sets a numeric field (§3.3 "Param ref"): a literal, or a ref to a target. On `const.v` (and a `param` node's `v`) a
 * target makes the node `{op: 'param', path}` and "literal" makes it `const(<current value>)`; elsewhere a target writes
 * `{param, neg?}` and "literal" without a value writes the field's current resolved value. A knot cell re-sorts the
 * knots. RangeError for a field the node does not have, or `neg` on `const.v`.
 */
export function setNumber(params: Params, sel: Selection, key: string, choice: NumberChoice): FormEdit {
  const at = locate(params, sel);
  if (numberField(at, key) === null) throw new RangeError(`form: ${sel.path} has no numeric field ${key}`);
  if (at.format === 'density' && key === 'v') {
    if (choice.kind === 'param') {
      if (choice.neg === true) throw new RangeError('form: const.v takes no negated ref');
      return replaceNode(at, () => record([['op', 'param'], ['path', choice.path]]), sel.path);
    }
    const v = choice.value ?? (at.node['op'] === 'param' ? currentNumber(params, { param: at.node['path'] as string }) : (at.node['v'] as number));
    return replaceNode(at, () => record([['op', 'const'], ['v', v]]), sel.path);
  }
  const knot = KNOT_KEY.exec(key);
  const old = knot === null ? own(at.node, key) : (own(at.node, 'knots') as readonly (readonly unknown[])[])[Number(knot[1])]?.[Number(knot[2])];
  const next: NumberValue = choice.kind === 'param'
    ? (choice.neg === true ? { param: choice.path, neg: true } : { param: choice.path })
    : (choice.value ?? currentNumber(params, old));
  const written = isRef(next) ? record(Object.entries(next)) : next;
  if (knot === null) return replaceNode(at, (n) => withKey(n, key, written), sel.path);
  const knots = (own(at.node, 'knots') as readonly (readonly [unknown, unknown])[]).map((k, i) =>
    (i === Number(knot[1]) ? (knot[2] === '0' ? [written, k[1]] : [k[0], written]) : [k[0], k[1]]) as [unknown, unknown]);
  return replaceNode(at, (n) => withKey(n, 'knots', sortKnots(params, knots)), sel.path);
}

/**
 * A literal typed in a numeric field (§3.3: the form's fields behave as the parameter panel's `valueField`), read by the
 * panel's `parseFieldText`: the number its trimmed text spells (as `Number` reads it: '1e3', '-.5', '0x10'), a typed
 * −0 written 0 (the panel's q15 stores −0 as 0); text that spells no number ('0,5', '') is refused with NOT_NUMBER
 * naming what was typed, as the panel refuses it; a non-finite number reaches tier 1 (NOT_FINITE), as in the panel.
 */
export function setTypedNumber(params: Params, sel: Selection, key: string, text: string): FormEdit {
  const v = parseFieldText(text);
  if (typeof v !== 'number') {
    return { ok: false, issues: [{ path: `${sel.path}.${key}`, code: 'NOT_NUMBER', message: `expected a number, got ${JSON.stringify(v)}` }] };
  }
  return setNumber(params, sel, key, { kind: 'literal', value: v === 0 ? 0 : v });
}

/** Sets a non-numeric field (a select, a boolean, a tap name, a biome list); RangeError for a numeric or unknown one. */
export function setField(params: Params, sel: Selection, key: string, value: string | boolean | readonly string[]): FormEdit {
  const at = locate(params, sel);
  const fields = formFields(params, sel).filter((f) => f.type !== 'number' && f.type !== 'knots' && f.key !== 'defName');
  if (!fields.some((f) => f.key === key)) throw new RangeError(`form: ${sel.path} has no field ${key} to set`);
  return replaceNode(at, (old) => withKey(old, key, Array.isArray(value) ? [...value] : value), sel.path);
}

/** The form's controls for the selected node (§3.3): one per scalar, in table order. */
export function formFields(params: Params, sel: Selection): FormField[] {
  const at = locate(params, sel);
  const n = at.node;
  const num = (key: string, int: boolean, negatable = true): FormField =>
    ({ type: 'number', key, value: own(n, key) as NumberValue, current: currentNumber(params, own(n, key)), int, negatable });
  const sel1 = (key: string, options: readonly string[]): FormField => ({ type: 'select', key, value: String(own(n, key)), options });
  if (at.format === 'density') {
    const out: FormField[] = [];
    const def = DEF_ROOT.exec(sel.path);
    if (def !== null) out.push({ type: 'name', key: 'defName', value: def[1]! });
    switch (n['op']) {
      case 'const': out.push(num('v', false, false)); break;
      case 'param': {
        const path = String(own(n, 'path'));
        out.push({ type: 'number', key: 'v', value: { param: path }, current: currentNumber(params, { param: path }), int: false, negatable: false });
        break;
      }
      case 'col': out.push(sel1('field', COL_FIELD_OPTIONS)); break;
      case 'noise': case 'noise2': out.push(sel1('id', DENSITY_NOISE_OPTIONS[n['op']])); break;
      case 'clamp': case 'rangeChoice': out.push(num('lo', false), num('hi', false)); break;
      case 'slide': out.push({ type: 'knots', key: 'knots', value: own(n, 'knots') as readonly (readonly [NumberValue, NumberValue])[] }); break;
      case 'tap':
        out.push({ type: 'name', key: 'name', value: String(own(n, 'name')) });
        if (Object.hasOwn(n, 'mute')) out.push(num('mute', false));
        break;
      case 'ref': out.push(sel1('name', defNames(at.value))); break;
      default: break;
    }
    return out;
  }
  const kind = n['kind'] as string;
  const fields = Object.hasOwn(FIELDS, kind) ? (FIELDS as Readonly<Record<string, readonly string[]>>)[kind]! : [];
  return fields.filter((f) => !RULE_CHILD_FIELDS.has(f)).map((f): FormField => {
    if (RULE_NUMBERS.has(f)) return num(f, RULE_NUMBERS.get(f)!);
    if (typeof own(n, f) === 'boolean') return { type: 'boolean', key: f, value: own(n, f) as boolean };
    switch (f) {
      case 'biomes': return { type: 'biomes', key: 'biomes', value: own(n, f) as readonly string[], options: BIOME_OPTIONS };
      case 'state': return sel1('state', BLOCK_STATE_OPTIONS);
      case 'side': return sel1('side', SIDE_OPTIONS);
      case 'noise': return sel1('noise', SURFACE_NOISE_OPTIONS);
      default: return { type: 'boolean', key: f, value: own(n, f) === true };
    }
  });
}

/**
 * Commits a form edit (§3.3): both tiers first (`checkLeafCandidate`, so an invalid tree is never sent), then one
 * `session.set('<leaf>', clone)`; a refusal returns the issues (node paths inside the leaf) and the caller keeps its
 * selection; success returns the edit's selection followed on the session's new tree.
 */
export function commitFormEdit(session: EditorSession, e: FormEdit): FormCommit {
  if (!e.ok) return e;
  const checked = checkLeafCandidate(session.state.params, e.leaf, e.value);
  if (checked.value === null) return { ok: false, issues: checked.issues };
  const r = session.set(e.leaf, checked.value);
  if (!r.ok) {
    return { ok: false, issues: r.issues.map((i) => ({ path: stripLeaf(i.path, e.leaf), code: i.code, message: i.message })) };
  }
  return { ok: true, select: followNode(session.state.params, e.select) };
}

/**
 * The selection after a successful commit (§3.2): an edit made in the node form selects the node it returns (the
 * edited node, or the one a renumbering moved it to); a tap's mute toggled from its tree row is a plain edit of another
 * row and keeps the current selection (followed on the new tree by the caller), so the selected node's slice and hover
 * value show the muted world.
 */
export function selectionAfterCommit(source: 'form' | 'row', current: Selection, committed: Selection): Selection {
  return source === 'row' ? current : committed;
}

/**
 * The two tree lints (§3.3) of the session's params: "no fast path" when the resolved rules have none, and "density
 * cost ≈ N × the default" when the resolved root's work cost exceeds LINT_COST_FACTOR × the default tree's at the
 * same params. A tree that does not resolve gets no lint (the session never holds one).
 */
export function treeLints(params: Params): string[] {
  const out: string[] = [];
  try {
    const rules = resolveRules(params.surface.rules, params);
    if (surfaceFastPath(rules, surfaceDepthMax(params.surface.depthMul, params.surface.noises.depth.clampSigma)) === null) out.push(LINT_NO_FAST_PATH);
  } catch { /* not resolvable: no lint */ }
  try {
    const cost = workCost(resolveDensity(params.density.defs, params), params);
    const base = workCost(resolveDensity(DEFAULT_DENSITY_TREE, params), params);
    if (cost > LINT_COST_FACTOR * base) out.push(densityCostLint(cost / base));
  } catch { /* not resolvable: no lint */ }
  return out;
}

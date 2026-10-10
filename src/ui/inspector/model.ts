/**
 * The Density tab's tree model (SP3d spec §3.2, D18). Two roots, **Density** (`root`, then each def `defs.<name>` in key
 * order) and **Surface rules** (`root`), whose rows are built from the session's current values: a row is a node (an
 * object carrying the format's `op` / `kind`) with its path tail, its op or kind, a short summary (`const 0.5`,
 * `param density.detailAmpLo = 0.6`, `slide 4 knots`, `tap terrain`, `if biome(desert, beach, …) → sand`,
 * `if stoneDepth floor 0+sd`, `sequence 3`, …) and its full path as the title; a rule's conditions are rows of their
 * rule (`.if`, a `not`'s `.if.if`) before its `.then`. A tap row carries the mute toggle; a muted tap shows its value and
 * its subtree is dimmed. Expansion is three levels at first (levels 0 and 1 open) with explicit overrides, "Expand to
 * selection" opens the selected node's ancestors, and the indentation is 8 px per level capped at 12 levels. The DOM
 * re-renders only when a key string changes. The selection is (root, node path); after an undo, a reset or a renumbering
 * edit it follows the longest prefix of its path that still names a node (`followNode`). The JSON editor's caret selects
 * the innermost node holding it only while the buffer is clean or parses and only when the path exists in the session's
 * tree (a buffer-only path moves the editor's highlight, not the selection). Every lookup keyed by tree content reads
 * own properties only (`constructor`, `toString`, … are valid names). Pure; no DOM.
 */
import type { JsonFormat } from '../../core/params/json';
import type { Params } from '../../core/params/schema';
import { getPath } from '../../core/params/kit';
import { ALLOWED_REF_TARGETS, SOURCE_CHILD_KEYS } from '../../gen/density/source';
import { FIELDS } from '../../gen/surface/rules';
import { formatOfLeaf, leafValue, TREE_LEAVES, type EditorState, type TreeLeaf } from './editorModel';
import { nodeAt, topPathOf, type TextRange } from './jsonText';

/** A tree row's indentation per level and the level it stops growing at (§3.2: 17 levels deep would not fit 220 px). */
export const INDENT_PX = 8;
export const INDENT_LEVELS = 12;
/** Levels shown at first: nodes above this depth start expanded (the roots' rows are level 0). */
export const INITIAL_LEVELS = 3;

/** A selected node: its tree leaf and its node path inside the leaf (`root.a.x`, `defs.terrain`, `root.rules[1].if`). */
export interface Selection {
  readonly leaf: TreeLeaf;
  readonly path: string;
}

/** The tab's first selection: the density root. */
export const DEFAULT_SELECTION: Selection = Object.freeze({ leaf: 'density.defs', path: 'root' });

/** Explicit expansion overrides by `expansionKey`; a node without one is expanded when its depth < INITIAL_LEVELS − 1. */
export type Expansion = ReadonlyMap<string, boolean>;
export const NO_EXPANSION: Expansion = new Map();

export interface TreeRow {
  readonly leaf: TreeLeaf;
  /** The node path inside the leaf. */
  readonly path: string;
  /** Levels below the row's tree root (`root` and each def are 0). */
  readonly depth: number;
  /** Left padding in px: INDENT_PX per level, capped at INDENT_LEVELS. */
  readonly indent: number;
  /** The path's last step (`x`, `rules[2]`, `if`), or `root` / `defs.<name>` for a tree root. */
  readonly tail: string;
  /** The node's op (density) or kind (rules). */
  readonly kind: string;
  readonly summary: string;
  /** The full path, as issues write it (`density.defs.root.a.x`). */
  readonly title: string;
  /** The node has child nodes. */
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  /** A density tap: the row carries the mute toggle. */
  readonly tap: boolean;
  /** A tap with a mute. */
  readonly muted: boolean;
  /** Strictly inside a muted tap's subtree. */
  readonly dimmed: boolean;
  /** Everything the row shows, as a string. */
  readonly key: string;
}

export interface TreeGroup {
  readonly leaf: TreeLeaf;
  readonly label: string;
  /** The visible rows (the descendants of a collapsed row are left out), in pre-order. */
  readonly rows: readonly TreeRow[];
}

export interface InspectorTree {
  readonly groups: readonly TreeGroup[];
  /** Every row's key; the DOM re-renders when it changes. */
  readonly key: string;
}

const GROUP_LABELS: Readonly<Record<TreeLeaf, string>> = Object.freeze({ 'density.defs': 'Density', 'surface.rules': 'Surface rules' });
/** The rule fields that hold rules or conditions, in FIELDS order. */
const RULE_CHILDREN: ReadonlySet<string> = new Set(['if', 'then', 'rules']);
const NOISE_PREFIX = 'surface.noises.';
/** Biome names a summary lists before `…`. */
const SUMMARY_BIOMES = 2;

/** A node of either format: an object carrying `op` (density) or `kind` (rules) as a string. */
export type TreeNode = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is TreeNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const tagOf = (format: JsonFormat): string => (format === 'density' ? 'op' : 'kind');

function isNode(v: unknown, tag: string): v is TreeNode {
  return isRecord(v) && Object.hasOwn(v, tag) && typeof v[tag] === 'string';
}

/** An own property, or undefined. */
function own(r: TreeNode, k: string): unknown {
  return Object.hasOwn(r, k) ? r[k] : undefined;
}

export const expansionKey = (leaf: TreeLeaf, path: string): string => `${leaf}|${path}`;

export function indentOf(depth: number): number {
  return INDENT_PX * Math.min(depth, INDENT_LEVELS);
}

export function isExpanded(expansion: Expansion, leaf: TreeLeaf, path: string, depth: number): boolean {
  return expansion.get(expansionKey(leaf, path)) ?? depth < INITIAL_LEVELS - 1;
}

/** `expansion` with the node's expansion flipped. */
export function toggleExpansion(expansion: Expansion, leaf: TreeLeaf, path: string, depth: number): Expansion {
  const out = new Map(expansion);
  out.set(expansionKey(leaf, path), !isExpanded(expansion, leaf, path, depth));
  return out;
}

/** The child nodes of a node, as (path step, node) in evaluation order. */
function childNodes(node: TreeNode, path: string, format: JsonFormat): { path: string; node: TreeNode }[] {
  const tag = tagOf(format);
  const kind = node[tag] as string;
  const out: { path: string; node: TreeNode }[] = [];
  if (format === 'density') {
    const slots = Object.hasOwn(SOURCE_CHILD_KEYS, kind) ? (SOURCE_CHILD_KEYS as Readonly<Record<string, readonly string[]>>)[kind]! : [];
    for (const k of slots) {
      const c = own(node, k);
      if (isNode(c, tag)) out.push({ path: `${path}.${k}`, node: c });
    }
    return out;
  }
  const fields = Object.hasOwn(FIELDS, kind) ? (FIELDS as Readonly<Record<string, readonly string[]>>)[kind]! : [];
  for (const f of fields) {
    if (!RULE_CHILDREN.has(f)) continue;
    const c = own(node, f);
    if (Array.isArray(c)) c.forEach((item, i) => { if (isNode(item, tag)) out.push({ path: `${path}.${f}[${i}]`, node: item }); });
    else if (isNode(c, tag)) out.push({ path: `${path}.${f}`, node: c });
  }
  return out;
}

/** The tree roots of a leaf value: density `root` then each def in key order; rules the value itself at `root`. */
function treeRoots(value: unknown, format: JsonFormat): { path: string; node: TreeNode }[] {
  const tag = tagOf(format);
  if (format === 'surfaceRules') return isNode(value, tag) ? [{ path: 'root', node: value }] : [];
  if (!isRecord(value)) return [];
  const out: { path: string; node: TreeNode }[] = [];
  const root = own(value, 'root');
  if (isNode(root, tag)) out.push({ path: 'root', node: root });
  const defs = own(value, 'defs');
  if (isRecord(defs)) {
    for (const name of Object.keys(defs).sort()) {
      const d = defs[name];
      if (isNode(d, tag)) out.push({ path: `defs.${name}`, node: d });
    }
  }
  return out;
}

/** Every node path of a leaf value in pre-order (the rows of a fully expanded tree). */
export function nodePaths(value: unknown, format: JsonFormat): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode, path: string): void => {
    out.push(path);
    for (const c of childNodes(node, path, format)) walk(c.node, c.path);
  };
  for (const r of treeRoots(value, format)) walk(r.node, r.path);
  return out;
}

/** The steps of a node path after the value's top path: `.key` and `[i]`; null when it does not parse. */
export function pathSteps(path: string, format: JsonFormat): (string | number)[] | null {
  const top = topPathOf(format);
  let rest: string;
  if (top === '') rest = `.${path}`;
  else if (path === top) return [];
  else if (path.startsWith(`${top}.`) || path.startsWith(`${top}[`)) rest = path.slice(top.length);
  else return null;
  const steps: (string | number)[] = [];
  const re = /\.([A-Za-z][A-Za-z0-9_]*)|\[(0|[1-9][0-9]*)\]/y;
  let at = 0;
  while (at < rest.length) {
    re.lastIndex = at;
    const m = re.exec(rest);
    if (m === null) return null;
    steps.push(m[1] !== undefined ? m[1] : Number(m[2]));
    at = re.lastIndex;
  }
  return steps;
}

/** One own-property step (an array index below its length, an object's own key), or undefined. */
function step(v: unknown, s: string | number): unknown {
  if (typeof s === 'number') return Array.isArray(v) && s < v.length ? (v as unknown[])[s] : undefined;
  return isRecord(v) ? own(v, s) : undefined;
}

/** The node at `path` in a leaf value, or undefined when the path names no node (own properties only). */
export function findNode(value: unknown, format: JsonFormat, path: string): TreeNode | undefined {
  const steps = pathSteps(path, format);
  if (steps === null || (format === 'density' && steps.length === 0)) return undefined;
  let v: unknown = value;
  for (const s of steps) {
    v = step(v, s);
    if (v === undefined) return undefined;
  }
  return isNode(v, tagOf(format)) ? v : undefined;
}

/** The node paths from the value down to `path` (the node itself included), or null when `path` names no node. */
function nodeChain(value: unknown, format: JsonFormat, path: string): string[] | null {
  const steps = pathSteps(path, format);
  if (steps === null) return null;
  const tag = tagOf(format);
  const out: string[] = [];
  let v: unknown = value;
  let p = topPathOf(format);
  if (isNode(v, tag)) out.push(p);
  for (const s of steps) {
    v = step(v, s);
    if (v === undefined) return null;
    p = typeof s === 'number' ? `${p}[${s}]` : p === '' ? s : `${p}.${s}`;
    if (isNode(v, tag)) out.push(p);
  }
  return out.at(-1) === path ? out : null;
}

/**
 * The selection after the leaf's value changed (undo, redo, reset, load, an edit that renumbers siblings): the longest
 * prefix of its path that still names a node, else the tree's `root`. Returns `sel` itself when it still names a node.
 */
export function followNode(params: Params, sel: Selection): Selection {
  const format = formatOfLeaf(sel.leaf);
  const value = leafValue(params, sel.leaf);
  const steps = pathSteps(sel.path, format);
  const tag = tagOf(format);
  let best = 'root';
  if (steps !== null) {
    let v: unknown = value;
    let p = topPathOf(format);
    for (const s of steps) {
      v = step(v, s);
      if (v === undefined) break;
      p = typeof s === 'number' ? `${p}[${s}]` : p === '' ? s : `${p}.${s}`;
      if (isNode(v, tag)) best = p;
    }
  }
  if (best === sel.path) return sel;
  return { leaf: sel.leaf, path: best };
}

/** `expansion` with every ancestor of the selected node expanded (unchanged, the same object, when nothing changes). */
export function expandToSelection(params: Params, expansion: Expansion, sel: Selection): Expansion {
  const chain = nodeChain(leafValue(params, sel.leaf), formatOfLeaf(sel.leaf), sel.path);
  if (chain === null) return expansion;
  let out: Map<string, boolean> | null = null;
  // Depths: a tree root (`root`, `defs.<name>`) is 0; for density the value itself is not in the chain.
  chain.slice(0, -1).forEach((p, depth) => {
    if (isExpanded(expansion, sel.leaf, p, depth)) return;
    out ??= new Map(expansion);
    out.set(expansionKey(sel.leaf, p), true);
  });
  return out ?? expansion;
}

/** A number as it is written (−0 as `-0`). */
function num(v: number): string {
  return Object.is(v, -0) ? '-0' : String(v);
}

/** A numeric field: a literal, or a ref `{param, neg?}` written `path` / `−path`. */
function field(v: unknown): string {
  if (typeof v === 'number') return num(v);
  if (isRecord(v) && typeof own(v, 'param') === 'string') return `${own(v, 'neg') === true ? '−' : ''}${v['param'] as string}`;
  return '?';
}

/** A ref target's current value (`param density.detailAmpLo = 0.6`), read only for paths of ALLOWED_REF_TARGETS. */
function targetValue(params: Params, path: string): string {
  if (!ALLOWED_REF_TARGETS.has(path)) return '';
  const v = getPath(params, path);
  return typeof v === 'number' ? ` = ${num(v)}` : '';
}

function densitySummary(node: TreeNode, params: Params): string {
  const op = node['op'] as string;
  switch (op) {
    case 'const': return `const ${field(own(node, 'v'))}`;
    case 'col': return `col ${String(own(node, 'field'))}`;
    case 'noise': case 'noise2': return `${op} ${String(own(node, 'id'))}`;
    case 'param': {
      const path = String(own(node, 'path'));
      return `param ${path}${targetValue(params, path)}`;
    }
    case 'clamp': case 'rangeChoice': return `${op} ${field(own(node, 'lo'))} … ${field(own(node, 'hi'))}`;
    case 'slide': {
      const knots = own(node, 'knots');
      const n = Array.isArray(knots) ? knots.length : 0;
      return `slide ${n} ${n === 1 ? 'knot' : 'knots'}`;
    }
    case 'tap': return `tap ${String(own(node, 'name'))}${Object.hasOwn(node, 'mute') ? ` muted ${field(node['mute'])}` : ''}`;
    case 'ref': return `ref ${String(own(node, 'name'))}`;
    default: return op;
  }
}

function conditionSummary(c: TreeNode): string {
  const kind = c['kind'] as string;
  const runTop = own(c, 'runTop') === true ? ' runTop' : '';
  switch (kind) {
    case 'biome': {
      const list = own(c, 'biomes');
      const names = Array.isArray(list) ? list.map(String) : [];
      const shown = names.slice(0, SUMMARY_BIOMES);
      if (names.length > SUMMARY_BIOMES) shown.push('…');
      return `biome(${shown.join(', ')})`;
    }
    case 'stoneDepth':
      return `stoneDepth ${String(own(c, 'side'))} ${field(own(c, 'offset'))}${own(c, 'addSurfaceDepth') === true ? '+sd' : ''}`;
    case 'water': return `water ${field(own(c, 'offset'))}${runTop}`;
    case 'yAbove': return `yAbove ${field(own(c, 'minY'))}${runTop}`;
    case 'verticalGradient': return `verticalGradient ${field(own(c, 'trueAtAndBelow'))} … ${field(own(c, 'falseAtAndAbove'))}`;
    case 'steep': return `steep ${field(own(c, 'min'))}`;
    case 'noiseThreshold': {
      const noise = String(own(c, 'noise'));
      const short = noise.startsWith(NOISE_PREFIX) ? noise.slice(NOISE_PREFIX.length) : noise;
      return `noiseThreshold ${short} ${field(own(c, 'min'))} … ${field(own(c, 'max'))}`;
    }
    case 'temperatureBelow': return `temperatureBelow ${field(own(c, 't'))}`;
    default: return kind;
  }
}

/** A rule's summary; `cond` tells a condition (a node under `.if`) from a rule. */
function rulesSummary(node: TreeNode, cond: boolean): string {
  if (cond) return conditionSummary(node);
  const kind = node['kind'] as string;
  switch (kind) {
    case 'sequence': {
      const rules = own(node, 'rules');
      return `sequence ${Array.isArray(rules) ? rules.length : 0}`;
    }
    case 'condition': {
      const c = own(node, 'if');
      const then = own(node, 'then');
      const head = `if ${isNode(c, 'kind') ? conditionSummary(c) : '?'}`;
      if (isNode(then, 'kind') && then['kind'] === 'block') return `${head} → ${String(own(then, 'state'))}`;
      if (isNode(then, 'kind') && then['kind'] === 'bandlands') return `${head} → bandlands`;
      return head;
    }
    case 'block': return `block ${String(own(node, 'state'))}`;
    default: return kind;
  }
}

/** The short text of a node (§3.2); `cond` marks a rules condition. */
export function nodeSummary(node: TreeNode, format: JsonFormat, params: Params, cond = false): string {
  return format === 'density' ? densitySummary(node, params) : rulesSummary(node, cond);
}

/** The path's last step, or the tree root's own name. */
function tailOf(path: string): string {
  if (path === 'root' || (path.startsWith('defs.') && path.indexOf('.', 5) === -1)) return path;
  return path.slice(path.lastIndexOf('.') + 1);
}

function groupRows(params: Params, leaf: TreeLeaf, expansion: Expansion, selection: Selection | null): TreeRow[] {
  const format = formatOfLeaf(leaf);
  const tag = tagOf(format);
  const rows: TreeRow[] = [];
  const selected = selection !== null && selection.leaf === leaf ? selection.path : null;
  const walk = (node: TreeNode, path: string, depth: number, dimmed: boolean, cond: boolean): void => {
    const children = childNodes(node, path, format);
    const expandable = children.length > 0;
    const expanded = expandable && isExpanded(expansion, leaf, path, depth);
    const kind = node[tag] as string;
    const tap = format === 'density' && kind === 'tap';
    const muted = tap && Object.hasOwn(node, 'mute');
    const summary = nodeSummary(node, format, params, cond);
    const isSel = path === selected;
    const key = `${path}|${depth}|${expandable ? (expanded ? '-' : '+') : '.'}|${isSel ? 's' : ''}${muted ? 'm' : ''}${dimmed ? 'd' : ''}|${summary}`;
    rows.push({
      leaf, path, depth, indent: indentOf(depth), tail: tailOf(path), kind, summary, title: `${leaf}.${path}`,
      expandable, expanded, selected: isSel, tap, muted, dimmed, key,
    });
    if (!expanded) return;
    for (const c of children) walk(c.node, c.path, depth + 1, dimmed || muted, format === 'surfaceRules' && c.path.endsWith('.if'));
  };
  for (const r of treeRoots(leafValue(params, leaf), format)) walk(r.node, r.path, 0, false, false);
  return rows;
}

/** The tree's rows for both roots, from the session's current params (§3.2). */
export function inspectorTree(params: Params, expansion: Expansion, selection: Selection | null): InspectorTree {
  const groups = TREE_LEAVES.map((leaf) => ({ leaf, label: GROUP_LABELS[leaf], rows: groupRows(params, leaf, expansion, selection) }));
  const key = groups.map((g) => `${g.leaf}\n${g.rows.map((r) => r.key).join('\n')}`).join('\n\n');
  return { groups, key };
}

/** What a caret position in the editor does: the node it highlights and, for a path the session's tree has, the selection. */
export interface CaretTarget {
  readonly highlight: string | null;
  readonly select: Selection | null;
}

const NO_TARGET: CaretTarget = Object.freeze({ highlight: null, select: null });

/**
 * The innermost node holding the editor's caret, only while its buffer is clean or parses (`ranges` non-null: the
 * editor sets them after its 150 ms debounce); selected only when the session's tree has a node at that path.
 */
export function caretTarget(editor: Pick<EditorState, 'leaf' | 'ranges' | 'caret'>, params: Params): CaretTarget {
  if (editor.ranges === null) return NO_TARGET;
  const path = nodeAt(editor.ranges, editor.caret);
  if (path === null) return NO_TARGET;
  const inSession = findNode(leafValue(params, editor.leaf), formatOfLeaf(editor.leaf), path) !== undefined;
  return { highlight: path, select: inSession ? { leaf: editor.leaf, path } : null };
}

/** The text range of the selected node in the editor showing its root, or null (another root, no ranges, no such node). */
export function highlightRange(editor: Pick<EditorState, 'leaf' | 'ranges'>, sel: Selection): TextRange | null {
  if (editor.leaf !== sel.leaf || editor.ranges === null || !editor.ranges.nodes.includes(sel.path)) return null;
  return editor.ranges.byPath.get(sel.path) ?? null;
}

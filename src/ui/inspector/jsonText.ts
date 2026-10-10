/**
 * The Density tab's JSON printer and parser (SP3d spec §3.5, D18). `printTree` writes a tree for reading, not
 * canonically: two-space indentation; in each node `op` (or `kind`) first, then its scalar fields in their table order,
 * then its children in evaluation order (unknown keys last, sorted); the density value's `root` before `defs`, `defs`
 * keys sorted; a container with no node below it (a node without child nodes, a knot or biome array, a ref) on one
 * line; a −0 as `-0` (`String(-0)` is "0"), so a typed −0 reaches tier 1 as NEGATIVE_ZERO and print ∘ parse is the
 * identity on every JSON tree. `parseTree` is an iterative JSON parser (any nesting, no recursion) that returns the
 * value, the text range of every value path (to container depth 48, tier 1's bound) and syntax errors with their line
 * and column (`JSON.parse` gives no offsets); a duplicate key is a syntax error, and object keys are defined with
 * `Object.defineProperty` on a null-prototype object then normalised to a plain object, so a `"__proto__"` key reaches
 * tier 1 (BAD_KEY) instead of being dropped. The printer records the same ranges, so highlighting works on printed and
 * typed text alike. Paths are tier 1's (`treeKeyPath`): density `root…` / `defs.<name>…` under '', rules `root…`.
 * Pure; no DOM.
 */
import { TREE_LIMITS } from '../../core/constants';
import { treeKeyPath, type JsonFormat } from '../../core/params/json';
import { SOURCE_CHILD_KEYS } from '../../gen/density/source';
import { FIELDS } from '../../gen/surface/rules';

/** A half-open range [start, end) of UTF-16 offsets in a text. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface TreeRanges {
  /** Every value path (nodes, fields, array items, the value itself) to container depth 48 → its text, in text order. */
  readonly byPath: ReadonlyMap<string, TextRange>;
  /** The paths of the nodes (objects carrying the format's `op` / `kind` as a string), in text order. */
  readonly nodes: readonly string[];
}

export interface PrintedTree {
  readonly text: string;
  readonly ranges: TreeRanges;
}

export interface SyntaxIssue {
  readonly offset: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in UTF-16 units. */
  readonly column: number;
  readonly message: string;
}

export type ParsedTree =
  | { readonly ok: true; readonly value: unknown; readonly ranges: TreeRanges }
  | { readonly ok: false; readonly error: SyntaxIssue };

/** The node path of the value itself: '' for density, `root` for rules (tier 1's, §1.2). */
export const topPathOf = (format: JsonFormat): string => (format === 'surfaceRules' ? 'root' : '');

const tagOf = (format: JsonFormat): string => (format === 'density' ? 'op' : 'kind');

/**
 * Density scalar fields in the order SP3b §1.1's table lists them (`const.v`, `col.field`, a noise `id`, a param `path`,
 * a tap or ref `name`, `lo`/`hi`, `knots`, a tap's `mute` after its name); one list serves every op, since no op has two of
 * them in a different order.
 */
const DENSITY_SCALARS: readonly string[] = ['v', 'field', 'id', 'path', 'name', 'lo', 'hi', 'knots', 'mute'];
/** The rule fields that hold rules or conditions; the other FIELDS are scalars. */
const RULE_CHILDREN: ReadonlySet<string> = new Set(['if', 'then', 'rules']);
/** A ref `{param, neg}` and any other non-node object: these keys first. */
const OTHER_FIRST: readonly string[] = ['param', 'neg'];
const DENSITY_TOP: readonly string[] = ['root', 'defs'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNode(v: unknown, tag: string): boolean {
  return isRecord(v) && Object.hasOwn(v, tag) && typeof v[tag] === 'string';
}

/** `first` (those present, in that order), then the other keys sorted. */
function ordered(keys: readonly string[], first: readonly string[]): string[] {
  const own = new Set(keys);
  const out = first.filter((k) => own.has(k));
  const taken = new Set(out);
  return [...out, ...keys.filter((k) => !taken.has(k)).sort()];
}

/** The printing order of an object's keys (§3.5). */
function keyOrder(obj: Record<string, unknown>, path: string, format: JsonFormat): string[] {
  const keys = Object.keys(obj);
  const tag = tagOf(format);
  if (isNode(obj, tag)) {
    const kind = obj[tag] as string;
    if (format === 'density') {
      const children = Object.hasOwn(SOURCE_CHILD_KEYS, kind) ? (SOURCE_CHILD_KEYS as Readonly<Record<string, readonly string[]>>)[kind]! : [];
      return ordered(keys, [tag, ...DENSITY_SCALARS, ...children]);
    }
    const fields = Object.hasOwn(FIELDS, kind) ? (FIELDS as Readonly<Record<string, readonly string[]>>)[kind]! : [];
    return ordered(keys, [tag, ...fields.filter((f) => !RULE_CHILDREN.has(f)), ...fields.filter((f) => RULE_CHILDREN.has(f))]);
  }
  if (format === 'density' && path === '') return ordered(keys, DENSITY_TOP);
  if (format === 'density' && path === 'defs') return [...keys].sort();
  return ordered(keys, OTHER_FIRST);
}

/** `parent[i]`. */
const itemPath = (parent: string, i: number): string => `${parent}[${i}]`;

/** Prints `value` (a tree of either format) for the editor, with the range of every value path (§3.5). */
export function printTree(value: unknown, format: JsonFormat): PrintedTree {
  const tag = tagOf(format);
  // Containers with a node at or below them (memo, so shared subtrees are walked once).
  const holdsNode = new WeakMap<object, boolean>();
  const holds = (v: unknown, level: number): boolean => {
    if (typeof v !== 'object' || v === null) return false;
    const known = holdsNode.get(v);
    if (known !== undefined) return known;
    if (level + 1 > TREE_LIMITS.depth) throw new RangeError(`printTree: container depth above ${TREE_LIMITS.depth}`);
    let r = isNode(v, tag);
    const children = Array.isArray(v) ? v : Object.values(v);
    for (const c of children) if (holds(c, level + 1)) r = true;
    holdsNode.set(v, r);
    return r;
  };
  const below = (v: object, level: number): boolean => (Array.isArray(v) ? v : Object.values(v)).some((c) => holds(c, level + 1));

  let out = '';
  const byPath = new Map<string, TextRange>();
  const nodes: string[] = [];
  const write = (v: unknown, path: string, level: number, indent: string): void => {
    const start = out.length;
    // Reserve the entry so that byPath lists paths in text order.
    byPath.set(path, { start, end: start });
    switch (typeof v) {
      case 'number':
        if (!Number.isFinite(v)) throw new RangeError(`printTree: ${path || 'the value'} is ${String(v)}, not a JSON number`);
        out += Object.is(v, -0) ? '-0' : String(v);
        break;
      case 'string':
        out += JSON.stringify(v);
        break;
      case 'boolean':
        out += v ? 'true' : 'false';
        break;
      case 'object': {
        if (v === null) throw new RangeError(`printTree: ${path || 'the value'} is null`);
        if (level + 1 > TREE_LIMITS.depth) throw new RangeError(`printTree: container depth above ${TREE_LIMITS.depth}`);
        const arr = Array.isArray(v);
        if (!arr && isNode(v, tag)) nodes.push(path);
        const keys = arr ? null : keyOrder(v as Record<string, unknown>, path, format);
        const n = arr ? (v as unknown[]).length : keys!.length;
        const [open, close] = arr ? ['[', ']'] : ['{', '}'];
        if (n === 0) { out += open + close; break; }
        const multi = below(v, level);
        const inner = `${indent}  `;
        out += multi ? `${open}\n` : arr ? open : `${open} `;
        for (let i = 0; i < n; i++) {
          if (multi) out += inner;
          let childPath: string;
          let child: unknown;
          if (arr) { childPath = itemPath(path, i); child = (v as unknown[])[i]; }
          else {
            const k = keys![i]!;
            childPath = treeKeyPath(path, k);
            child = (v as Record<string, unknown>)[k];
            out += `${JSON.stringify(k)}: `;
          }
          write(child, childPath, level + 1, inner);
          if (i < n - 1) out += multi ? ',\n' : ', ';
        }
        out += multi ? `\n${indent}${close}` : arr ? close : ` ${close}`;
        break;
      }
      default:
        throw new RangeError(`printTree: ${path || 'the value'} is a ${typeof v}, not a JSON value`);
    }
    byPath.set(path, { start, end: out.length });
  };
  write(value, topPathOf(format), 0, '');
  return { text: out, ranges: { byPath, nodes } };
}

/** The 1-based line and column of `offset` in `text` (lines end at '\n'). */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) { line++; lineStart = i + 1; }
  return { line, column: offset - lineStart + 1 };
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: ReadonlyMap<string, string> = new Map([['"', '"'], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);
const HEX4 = /^[0-9A-Fa-f]{4}$/;

class ParseFailure {
  readonly offset: number;
  readonly message: string;
  constructor(offset: number, message: string) {
    this.offset = offset;
    this.message = message;
  }
}

interface Frame {
  readonly array: boolean;
  readonly value: unknown[] | Record<string, unknown>;
  readonly path: string;
  readonly level: number;
  readonly start: number;
  key: string;
}

/** What the next character is, for an error message (`end of text` past the end). */
function got(text: string, i: number): string {
  const c = text[i]!;
  return c < ' ' ? `got ${JSON.stringify(c)}` : `got '${c}'`;
}

/**
 * Parses `text` as one JSON value (§3.5): the value (objects plain, keys defined as own data properties), the range of
 * every value path to container depth 48 and the node paths, or the first syntax error with its offset, line and column.
 */
export function parseTree(text: string, format: JsonFormat): ParsedTree {
  try {
    return parse(text, format);
  } catch (e) {
    if (!(e instanceof ParseFailure)) throw e;
    return { ok: false, error: { offset: e.offset, ...lineColumn(text, e.offset), message: e.message } };
  }
}

function parse(text: string, format: JsonFormat): ParsedTree {
  const tag = tagOf(format);
  const n = text.length;
  const byPath = new Map<string, TextRange>();
  const nodes: { path: string; start: number }[] = [];
  const stack: Frame[] = [];
  let i = 0;
  let result: unknown;
  const fail = (at: number, message: string): never => { throw new ParseFailure(at, message); };
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const string = (): string => {
    const open = i;
    i++;
    let s = '';
    let from = i;
    for (;;) {
      if (i >= n) fail(open, 'unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) { s += text.slice(from, i); i++; return s; }
      if (c < 0x20) fail(i, 'control character in a string');
      if (c !== 0x5c) { i++; continue; }
      s += text.slice(from, i);
      const e = text[i + 1];
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!HEX4.test(hex)) fail(i, `bad escape \\u${hex}`);
        s += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const r = e === undefined ? undefined : ESCAPES.get(e);
        if (r === undefined) fail(i, e === undefined ? 'unterminated string' : `bad escape \\${e}`);
        s += r;
        i += 2;
      }
      from = i;
    }
  };
  /** The path and level of the value about to be parsed. */
  const nextSlot = (): { path: string; level: number } => {
    const top = stack.at(-1);
    if (top === undefined) return { path: topPathOf(format), level: 0 };
    const level = top.level + 1;
    if (level > TREE_LIMITS.depth) return { path: '', level };
    return { path: top.array ? itemPath(top.path, top.value.length as number) : treeKeyPath(top.path, top.key), level };
  };
  /** Stores a finished value into its parent (or as the result) and records its range. */
  const place = (v: unknown, path: string, level: number, start: number): void => {
    if (level <= TREE_LIMITS.depth) byPath.set(path, { start, end: i });
    const top = stack.at(-1);
    if (top === undefined) result = v;
    else if (top.array) (top.value as unknown[]).push(v);
    else Object.defineProperty(top.value, top.key, { value: v, writable: true, enumerable: true, configurable: true });
  };
  /** At a '"' inside an object: reads the key, refuses a duplicate, then the ':'. */
  const key = (f: Frame): void => {
    if (text[i] !== '"') fail(i, i < n ? `expected a string key, ${got(text, i)}` : 'unexpected end of text');
    const at = i;
    const k = string();
    if (Object.hasOwn(f.value, k)) fail(at, `duplicate key ${JSON.stringify(k)}`);
    f.key = k;
    ws();
    if (text[i] !== ':') fail(i, i < n ? `expected ':', ${got(text, i)}` : 'unexpected end of text');
    i++;
  };
  const close = (): void => {
    const f = stack.pop()!;
    i++;
    if (!f.array) {
      Object.setPrototypeOf(f.value, Object.prototype);
      if (f.level <= TREE_LIMITS.depth && isNode(f.value, tag)) nodes.push({ path: f.path, start: f.start });
    }
    place(f.value, f.path, f.level, f.start);
  };

  let expectValue = true;
  for (;;) {
    ws();
    if (expectValue) {
      if (i >= n) fail(i, 'unexpected end of text');
      const { path, level } = nextSlot();
      const start = i;
      const c = text[i]!;
      if (c === '{' || c === '[') {
        const array = c === '[';
        // A null-prototype object: no key can reach a setter; normalised when it closes.
        const f: Frame = { array, value: array ? [] : (Object.create(null) as Record<string, unknown>), path, level, start, key: '' };
        stack.push(f);
        i++;
        ws();
        if (text[i] === (array ? ']' : '}')) { close(); expectValue = false; continue; }
        if (!array) key(f);
        continue;
      }
      if (c === '"') { const s = string(); place(s, path, level, start); expectValue = false; continue; }
      if (c === '-' || (c >= '0' && c <= '9')) {
        NUMBER_RE.lastIndex = i;
        const m = NUMBER_RE.exec(text);
        if (m === null) fail(i, 'bad number');
        i += m![0].length;
        place(Number(m![0]), path, level, start);
        expectValue = false;
        continue;
      }
      const literal = text.startsWith('true', i) ? 'true' : text.startsWith('false', i) ? 'false' : text.startsWith('null', i) ? 'null' : null;
      if (literal === null) fail(i, `expected a value, ${got(text, i)}`);
      i += literal!.length;
      place(literal === 'true' ? true : literal === 'false' ? false : null, path, level, start);
      expectValue = false;
      continue;
    }
    const f = stack.at(-1);
    if (f === undefined) {
      if (i < n) fail(i, `unexpected text after the value, ${got(text, i)}`);
      break;
    }
    if (i >= n) fail(i, 'unexpected end of text');
    const c = text[i];
    if (c === ',') {
      i++;
      ws();
      if (!f.array) key(f);
      expectValue = true;
      continue;
    }
    if (c === (f.array ? ']' : '}')) { close(); continue; }
    fail(i, `expected ',' or '${f.array ? ']' : '}'}', ${got(text, i)}`);
  }
  nodes.sort((a, b) => a.start - b.start);
  // byPath in text order: containers were recorded when they closed, after their children.
  const sorted = new Map([...byPath].sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end));
  return { ok: true, value: result, ranges: { byPath: sorted, nodes: nodes.map((x) => x.path) } };
}

/** The innermost node whose range holds `offset` (start ≤ offset < end), or null outside every node. */
export function nodeAt(ranges: TreeRanges, offset: number): string | null {
  let best: string | null = null;
  let width = Infinity;
  for (const p of ranges.nodes) {
    const r = ranges.byPath.get(p)!;
    if (r.start <= offset && offset < r.end && r.end - r.start < width) { best = p; width = r.end - r.start; }
  }
  return best;
}

/** The range of `path`, else of its longest prefix (`.key` or `[i]` steps) that has one, else of the value itself. */
export function pathRange(ranges: TreeRanges, path: string): TextRange | undefined {
  let p = path;
  for (;;) {
    const r = ranges.byPath.get(p);
    if (r !== undefined) return r;
    const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['));
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return ranges.byPath.get('') ?? ranges.byPath.get('root');
}

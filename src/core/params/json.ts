/**
 * The `json` leaf kind's tier-1 validator (SP3d spec §1.1, §1.7, D1) and the tree issue codes. `checkJson` guarantees a
 * canonical-safe, bounded JSON value whatever it is given (parsed text, a crafted URL, an in-memory candidate that
 * shares sub-objects or is cyclic): one budgeted iterative walk, never a throw, at most 50 issues. On success it returns
 * a fresh deep-frozen clone with sorted object keys, registered so that the same value is returned as itself
 * (identity-preserving, §1.12) and printed by `canonicalJSON` from a cache. Tier 2 (the formats' semantics) is gen's
 * (`validateParamTrees`, §1.8).
 */
import { TREE_LIMITS } from '../constants';
import { canonicalJSON, rememberCanonical } from './canonical';
import type { Issue } from './kit';

/** A JSON value as tier 1 accepts it: no null, finite numbers, plain objects (§1.7). */
export type JsonValue = string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The formats of the `json` kind: the density expression `{root, defs}` and the root surface rule (§1.2). */
export type JsonFormat = 'density' | 'surfaceRules';

/** Tier-1 codes (§1.7); no code names two different bounds. */
export type JsonIssueCode =
  | 'NOT_JSON' | 'NOT_FINITE' | 'NEGATIVE_ZERO' | 'BAD_KEY' | 'JSON_TOO_DEEP' | 'JSON_TOO_MANY_VALUES' | 'ARRAY_TOO_LONG'
  | 'STRING_TOO_LONG' | 'JSON_TOO_LARGE' | 'TOO_MANY_ISSUES';

/**
 * Tier-2 codes, complete for SP3d (§1.7): every code of gen's `validateExpr` (`ExprErrorCode`) and `validateRules`
 * (`RuleErrorCode`), plus the source and bound codes of `validateDensitySource` and `validateRulesSource`. Declared here
 * because core cannot import gen; a type test keeps gen's unions inside it.
 */
export type TreeIssueCode =
  // validateExpr (gen/density/expr.ts)
  | 'NOT_OBJECT' | 'UNKNOWN_OP' | 'UNKNOWN_KEY' | 'NOT_FINITE' | 'BAD_FIELD' | 'UNKNOWN_NOISE' | 'NOISE_DIMS' | 'NOISE_REMAP'
  | 'BAD_NAME' | 'DUPLICATE_TAP' | 'UNKNOWN_REF' | 'REF_CYCLE' | 'NESTED_INTERPOLATED' | 'CLAMP_ORDER' | 'RANGE_ORDER'
  | 'KNOTS_SHAPE' | 'KNOTS_ORDER'
  // validateRules (gen/surface/rules.ts)
  | 'NOT_ARRAY' | 'UNKNOWN_KIND' | 'UNKNOWN_FIELD' | 'MISSING_FIELD' | 'UNKNOWN_BLOCK' | 'UNKNOWN_BIOME' | 'NOT_INTEGER'
  | 'OUT_OF_RANGE' | 'NEGATIVE_ZERO' | 'NOT_BOOLEAN' | 'BAD_SIDE' | 'GRADIENT_ORDER' | 'TOO_DEEP' | 'TOO_MANY_NODES'
  | 'NO_BAND_NOISE'
  // SP3d tier 2: parameter refs, recip, literal and value ranges, slide slopes and knot counts, counts, depth and cost bounds, solidity
  | 'UNKNOWN_PARAM' | 'PARAM_KIND' | 'RECIP_OPERAND' | 'RECIP_ZERO' | 'LITERAL_RANGE' | 'SLIDE_SLOPE' | 'TOO_MANY_KNOTS'
  | 'TOO_MANY_DEFS' | 'EXPANDED_TOO_DEEP' | 'TOO_COSTLY' | 'VALUE_RANGE' | 'COLUMN_COST' | 'TOO_MANY_BIOMES' | 'NOT_SOLID' | 'TOO_MANY_ISSUES';

/**
 * An object key of a tree value, also the pattern of def and tap names (§1.7): it closes empty, dotted and `__proto__`
 * names; `Object.prototype` member names (`constructor`, `toString`, …) match it, so lookups keyed by tree content use a
 * `Map`, a `Set` or `Object.hasOwn`.
 */
export const TREE_KEY_RE = new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${TREE_LIMITS.keyLength - 1}}$`);

/** A rejected key appears in its issue path as JSON.stringify(key) cut to this many characters (§1.2). */
const KEY_PATH_CHARS = 40;

/** The deep-frozen clones checkJson produced; given one, checkJson returns it unchecked. */
const REGISTRY = new WeakSet<object>();

/** The node path of the value itself: '' for density (validateExpr's top level), `root` for rules (§1.2). */
const valuePath = (format: JsonFormat): string => (format === 'surfaceRules' ? 'root' : '');

/** `leaf` + node path: an empty node path gives the leaf path alone (D3). */
function fullPath(leaf: string, node: string): string {
  if (node === '') return leaf;
  if (leaf === '') return node;
  return node.startsWith('[') ? `${leaf}${node}` : `${leaf}.${node}`;
}

const childPath = (parent: string, key: string): string => (parent === '' ? key : `${parent}.${key}`);

/** JSON.stringify(key) cut to 40 characters, never between the two halves of a surrogate pair. */
function quotedKey(key: string): string {
  // Only a prefix is stringified (every unit prints as at least one character), so a huge key costs O(1) here.
  let head = key;
  if (key.length > KEY_PATH_CHARS) {
    head = key.slice(0, KEY_PATH_CHARS);
    const end = head.charCodeAt(KEY_PATH_CHARS - 1);
    if (end >= 0xd800 && end <= 0xdbff) head = head.slice(0, KEY_PATH_CHARS - 1);
  }
  const q = JSON.stringify(head);
  if (q.length <= KEY_PATH_CHARS) return q;
  const last = q.charCodeAt(KEY_PATH_CHARS - 1);
  return q.slice(0, last >= 0xd800 && last <= 0xdbff ? KEY_PATH_CHARS - 1 : KEY_PATH_CHARS);
}

/**
 * The node path of key `key` of the object at node path `parent`, as tier 1 writes it (§1.2): `parent.key` (the key
 * alone under ''), or, for a key that does not match TREE_KEY_RE, `parent.` + JSON.stringify(key) cut to 40 characters.
 * The inspector's printer and parser name their text ranges with it, so an issue path finds its text.
 */
export function treeKeyPath(parent: string, key: string): string {
  return childPath(parent, TREE_KEY_RE.test(key) ? key : quotedKey(key));
}

interface Visit {
  readonly v: unknown;
  /** Node path in the format's syntax. */
  readonly path: string;
  /** Containers above the value (the top value is 0). */
  readonly level: number;
  readonly parent: unknown[] | Record<string, unknown> | null;
  readonly key: string | number;
  /** An issue found when the parent was read (a rejected key, an array hole, an accessor); the value is not visited. */
  readonly bad?: { readonly code: JsonIssueCode; readonly message: string };
}

/**
 * Tier 1 for both formats (§1.7). Appends issues to `out` (paths: `path` + the format's node path) and returns
 * undefined, or returns the deep-frozen, key-sorted, registered clone (a registered value: itself). One iterative walk
 * that counts every value at every visit and keeps the canonical text's length as it goes: the first exceeded count or
 * text bound stops it with that single issue (replacing any collected); per-value bounds (depth, array length, string
 * length) are reported at the value, which is not entered. Collects at most 50 issues, then one TOO_MANY_ISSUES at
 * `path` ("N more"). Never throws.
 */
export function checkJson(v: unknown, path: string, out: Issue[], format: JsonFormat): JsonValue | undefined {
  if (typeof v === 'object' && v !== null && REGISTRY.has(v)) return v as JsonValue;
  const L = TREE_LIMITS;
  const top = valuePath(format);
  const issues: Issue[] = [];
  let more = 0;
  const report = (node: string, code: JsonIssueCode, message: string): void => {
    if (issues.length < L.issues) issues.push({ path: fullPath(path, node), code, message });
    else more++;
  };
  const containers: object[] = [];
  let values = 0;
  let text = 0;
  let height = 0;
  let result: unknown;
  let stop: Issue | null = null;
  const stack: Visit[] = [{ v, path: top, level: 0, parent: null, key: 0 }];
  while (stack.length > 0) {
    const t = stack.pop()!;
    // Every visit counts, rejected ones too: a shared object with bad keys must not escape the budget.
    if (++values > L.values) { stop = { path: fullPath(path, top), code: 'JSON_TOO_MANY_VALUES', message: `more than ${L.values} values` }; break; }
    if (t.bad !== undefined) { report(t.path, t.bad.code, t.bad.message); continue; }
    if (t.level > height) height = t.level;
    const x = t.v;
    let clone: unknown;
    switch (typeof x) {
      case 'number':
        if (!Number.isFinite(x)) { report(t.path, 'NOT_FINITE', `expected a finite number, got ${String(x)}`); continue; }
        if (Object.is(x, -0)) { report(t.path, 'NEGATIVE_ZERO', 'negative zero is not allowed (write 0)'); continue; }
        text += String(x).length;
        clone = x;
        break;
      case 'string':
        if (x.length > L.stringUnits) { report(t.path, 'STRING_TOO_LONG', `${x.length} UTF-16 units, more than ${L.stringUnits}`); continue; }
        text += JSON.stringify(x).length;
        clone = x;
        break;
      case 'boolean':
        text += x ? 4 : 5;
        clone = x;
        break;
      case 'object': {
        if (x === null) { report(t.path, 'NOT_JSON', 'expected a JSON value, got null'); continue; }
        const depth = t.level + 1;
        if (Array.isArray(x)) {
          if (depth > L.depth) { report(t.path, 'JSON_TOO_DEEP', `container depth above ${L.depth}`); continue; }
          if (x.length > L.arrayItems) { report(t.path, 'ARRAY_TOO_LONG', `${x.length} items, more than ${L.arrayItems}`); continue; }
          text += 2 + (x.length > 0 ? x.length - 1 : 0);
          const c: unknown[] = [];
          containers.push(c);
          clone = c;
          for (let i = x.length - 1; i >= 0; i--) {
            const p = `${t.path}[${i}]`;
            const d = Object.getOwnPropertyDescriptor(x, i);
            if (d === undefined) stack.push({ v: undefined, path: p, level: depth, parent: c, key: i, bad: { code: 'NOT_JSON', message: 'an array hole' } });
            else if (d.get !== undefined || d.set !== undefined) stack.push({ v: undefined, path: p, level: depth, parent: c, key: i, bad: { code: 'NOT_JSON', message: 'an accessor property' } });
            else stack.push({ v: d.value, path: p, level: depth, parent: c, key: i });
          }
        } else {
          const proto: unknown = Object.getPrototypeOf(x);
          if (proto !== Object.prototype && proto !== null) { report(t.path, 'NOT_JSON', 'expected a plain object'); continue; }
          if (depth > L.depth) { report(t.path, 'JSON_TOO_DEEP', `container depth above ${L.depth}`); continue; }
          const keys = Object.keys(x);
          let written = 0;
          // A key that matches the pattern prints as itself in quotes, then a colon.
          for (const k of keys) if (TREE_KEY_RE.test(k)) { written++; text += k.length + 3; }
          text += 2 + (written > 0 ? written - 1 : 0);
          // Leaves the switch before sorting a huge key list; the check after it stops the walk.
          if (text > L.textUnits) break;
          keys.sort();
          const c: Record<string, unknown> = {};
          containers.push(c);
          clone = c;
          for (let i = keys.length - 1; i >= 0; i--) {
            const k = keys[i]!;
            if (!TREE_KEY_RE.test(k)) {
              const qk = quotedKey(k);
              stack.push({ v: undefined, path: treeKeyPath(t.path, k), level: depth, parent: c, key: k, bad: { code: 'BAD_KEY', message: `key ${qk} does not match ${TREE_KEY_RE.source}` } });
              continue;
            }
            const p = treeKeyPath(t.path, k);
            const d = Object.getOwnPropertyDescriptor(x, k)!;
            if (d.get !== undefined || d.set !== undefined) stack.push({ v: undefined, path: p, level: depth, parent: c, key: k, bad: { code: 'NOT_JSON', message: 'an accessor property' } });
            else stack.push({ v: d.value, path: p, level: depth, parent: c, key: k });
          }
        }
        break;
      }
      default:
        report(t.path, 'NOT_JSON', `expected a JSON value, got ${typeof x}`);
        continue;
    }
    if (text > L.textUnits) break;
    // Keys are written in the order they are visited (sorted), and only once they matched the pattern.
    if (t.parent === null) result = clone;
    else if (Array.isArray(t.parent)) t.parent[t.key as number] = clone;
    else t.parent[t.key as string] = clone;
  }
  if (stop === null && text > L.textUnits) {
    stop = { path: fullPath(path, top), code: 'JSON_TOO_LARGE', message: `canonical text longer than ${L.textUnits} characters` };
  }
  if (stop !== null) { out.push(stop); return undefined; }
  if (issues.length > 0) {
    out.push(...issues);
    if (more > 0) out.push({ path, code: 'TOO_MANY_ISSUES', message: `${more} more` });
    return undefined;
  }
  for (const c of containers) Object.freeze(c);
  if (typeof result === 'object' && result !== null) {
    // The running count is exact; the canonical text of the clone confirms it, and is cached for canonicalJSON.
    const canonical = canonicalJSON(result);
    if (canonical.length > L.textUnits) {
      out.push({ path: fullPath(path, top), code: 'JSON_TOO_LARGE', message: `canonical text longer than ${L.textUnits} characters` });
      return undefined;
    }
    REGISTRY.add(result);
    rememberCanonical(result, canonical, height);
  }
  return result as JsonValue;
}

/**
 * The nodes of a tier-1-valid tree value (the README's `<format> tree, <n> nodes`): the plain objects that carry the
 * format's discriminator (`op` / `kind`) as a string.
 */
export function countTreeNodes(v: unknown, format: JsonFormat): number {
  const tag = format === 'density' ? 'op' : 'kind';
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x !== 'object' || x === null) continue;
    if (Array.isArray(x)) { for (const item of x) stack.push(item); continue; }
    const rec = x as Record<string, unknown>;
    if (Object.hasOwn(rec, tag) && typeof rec[tag] === 'string') n++;
    for (const k of Object.keys(rec)) stack.push(rec[k]);
  }
  return n;
}

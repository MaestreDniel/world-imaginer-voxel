/**
 * The preset trees (SP3e spec §1.1, D12): the `density.defs` (and later `surface.rules`) values the PROFILES overlays
 * carry, derived from the default trees by subtree replacements at JSON paths and registered at module load, so
 * `checkJson` returns each as itself, `resolveProfile` yields the same identity on every call and the tier-2 memos hit.
 * Every number in them is a tree literal (D13: no new leaves, no refs to upstream groups). Core data: imports only core.
 */
import { canonicalJSON } from './canonical';
import { DEFAULT_DENSITY_TREE, registeredTree } from './defaultTrees';
import type { JsonFormat, JsonValue } from './json';

/** One subtree replacement of `deriveTree`. */
export interface TreeReplacement {
  /**
   * The JSON path as tier 2 prints it: dotted keys with `[i]` array items (`root.a.x`, `root.rules[1].then`); for the
   * rules format the leading `root` names the value itself. It may end at a scalar or array field (`…v`, `…knots`).
   */
  readonly path: string;
  /**
   * What the path names before the replacement: for a node, an object whose every key (its `op`, and a const's `v`)
   * equals the node's; for a field, its value. Compared canonically.
   */
  readonly was: JsonValue;
  readonly by: JsonValue;
}

type Container = Record<string, unknown> | unknown[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SEGMENT = /^([A-Za-z][A-Za-z0-9_]*)?((?:\[\d+\])*)$/;

/** The steps of a path: keys and array indices, in order; null for a malformed path. */
function steps(path: string, format: JsonFormat): Array<string | number> | null {
  const out: Array<string | number> = [];
  const parts = path.split('.');
  for (let n = 0; n < parts.length; n++) {
    const m = SEGMENT.exec(parts[n]!);
    if (m === null) return null;
    const key = m[1];
    if (n === 0 && format === 'surfaceRules') {
      // Tier 2 prints the rules value itself as `root`.
      if (key !== 'root') return null;
    } else if (key === undefined) return null;
    else out.push(key);
    for (const i of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(i[1]));
  }
  return out;
}

/** The node's own non-container fields (its `op` or `kind`, a const's `v`, a col's `field`): what a refusal prints. */
function brief(v: unknown): string {
  if (!isObject(v)) return canonicalJSON(v);
  const own: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (typeof v[k] !== 'object' || v[k] === null) own[k] = v[k];
  return canonicalJSON(own);
}

function matches(v: unknown, was: JsonValue): boolean {
  if (!isObject(was)) return canonicalJSON(v) === canonicalJSON(was);
  if (!isObject(v)) return false;
  for (const k of Object.keys(was)) if (!Object.hasOwn(v, k) || canonicalJSON(v[k]) !== canonicalJSON(was[k])) return false;
  return true;
}

/**
 * `base` (a deep JSON clone of it) with each replacement applied in order, through `registeredTree`. Throws at module
 * load when a path names nothing (`<leaf>: no node at <path>`) or names another node than `was`
 * (`<leaf>: <path> is <node>, not <was>`), or when the result fails tier 1. Own-property lookups only.
 */
export function deriveTree(base: JsonValue, leaf: string, format: JsonFormat, replacements: readonly TreeReplacement[]): JsonValue {
  const holder: unknown[] = [JSON.parse(JSON.stringify(base)) as unknown];
  for (const { path, was, by } of replacements) {
    const s = steps(path, format);
    let parent: Container = holder;
    let key: string | number = 0;
    let ok = s !== null;
    for (const step of s ?? []) {
      const v: unknown = Array.isArray(parent) ? parent[key as number] : parent[key as string];
      if (typeof step === 'number' ? !Array.isArray(v) || step >= v.length : !isObject(v) || !Object.hasOwn(v, step)) { ok = false; break; }
      parent = v as Container;
      key = step;
    }
    if (!ok) throw new Error(`${leaf}: no node at ${path}`);
    const node: unknown = Array.isArray(parent) ? parent[key as number] : parent[key as string];
    if (!matches(node, was)) throw new Error(`${leaf}: ${path} is ${brief(node)}, not ${canonicalJSON(was)}`);
    if (Array.isArray(parent)) parent[key as number] = by;
    else parent[key as string] = by;
  }
  return registeredTree(holder[0] as JsonValue, leaf, format);
}

const col = (field: string): JsonValue => ({ op: 'col', field });
const num = (v: number): JsonValue => ({ op: 'const', v });
/** `k + (−d)·lakeMask` (d = k by default): k where lakeMask is 0 (bit for bit), k − d in a lake basin (lakeMask 1). */
const lakeFade = (k: number, d = k): JsonValue => ({ op: 'add', a: num(k), b: { op: 'mul', a: num(-d), b: col('lakeMask') } });

/**
 * amplified (SP3e spec §1.2, D1, D2, user point 2): the default density tree with six replacements inside the
 * `terrain` tap, so `surfaceEst3` finds the amplified surface while the 2D map, `surfaceEst`, the biome picker and B1
 * keep the unamplified offset:
 * - offset' = offset + (0.9 − 0.9·lakeMask)·max(0, offset − 64): outside lakes the identity at offset ≤ 64 and
 *   64 + 1.9·(offset − 64) above (D1); faded by `lakeMask`, so a lake basin (lakeMask 1) keeps the default's offset and
 *   holds water at its unamplified level Lw, and the rim band blends to the amplified ground (SP3e Review Focus);
 * - jag × 1.6 and σ × (1.6 − 0.6·lakeMask), wrapping the `col` reads (so the jag term associates as (jag·1.6)·J;
 *   IEEE order is meaning): σ × 1.6 outside lakes, the default's σ in a basin (inside it the lake already sets jag 0);
 * - the slide fades σ over y 300-316 (knots [[−64, 0], [−40, 1], [300, 1], [316, 0]]);
 * - the ceiling −3·max(0, y − 270) (a soft knee from 270; the default's is −2·max(0, y − 296)).
 * Where lakeMask is 0 each fade is `k + (−k)·0` = k bit for bit, so the tree equals the plain factors there. The
 * corner bound of §1.2 (lakeMask in [0, 1] up to a few ulps, so the factors are at most 0.9 and 1.6) then leaves no solid voxel at y ≥ 316.
 * 80 nodes; the new subtrees read only `col` and `const`, so they stay in their column slot.
 */
export const AMPLIFIED_DENSITY_TREE: JsonValue = deriveTree(DEFAULT_DENSITY_TREE, 'density.defs', 'density', [
  {
    path: 'root.a.a.x.x.a.a.a.a.a',
    was: col('offset'),
    by: { op: 'add', a: col('offset'), b: { op: 'mul', a: lakeFade(0.9), b: { op: 'max', a: num(0), b: { op: 'add', a: col('offset'), b: num(-64) } } } },
  },
  { path: 'root.a.a.x.x.a.a.a.a.b.a', was: col('jag'), by: { op: 'mul', a: col('jag'), b: num(1.6) } },
  { path: 'root.a.a.x.x.a.a.b.a', was: col('sigma'), by: { op: 'mul', a: col('sigma'), b: lakeFade(1.6, 0.6) } },
  { path: 'root.a.a.x.x.a.a.b.b.knots', was: [[-64, 0], [-40, 1], [240, 1], [320, 0]], by: [[-64, 0], [-40, 1], [300, 1], [316, 0]] },
  { path: 'root.a.a.x.x.b.x.a.v', was: 2, by: 3 },
  { path: 'root.a.a.x.x.b.x.b.b.b.v', was: -296, by: -270 },
]);

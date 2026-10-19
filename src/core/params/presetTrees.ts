/**
 * The preset trees (SP3e spec §1.1, D12): the `density.defs` and `surface.rules` values the PROFILES overlays
 * carry, derived from the default trees by subtree replacements at JSON paths and registered at module load, so
 * `checkJson` returns each as itself, `resolveProfile` yields the same identity on every call and the tier-2 memos hit.
 * Every number in them is a tree literal (D13: no new leaves, no refs to upstream groups). Core data: imports only core.
 */
import { ISLAND_RUN_MIN_BOTTOM } from '../constants';
import { canonicalJSON } from './canonical';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES, registeredTree } from './defaultTrees';
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
  /**
   * The replacement; a function receives the node the path names (a deep clone, after the `was` check) and returns
   * it, so a wrapper keeps the replaced subtree without restating it.
   */
  readonly by: JsonValue | ((node: JsonValue) => JsonValue);
  /**
   * When true, `by` is inserted before the array item the path names (which must be `was`) instead of replacing it,
   * so that item and the ones after it move up by one index.
   */
  readonly insert?: boolean;
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
 * `base` (a deep JSON clone of it) with each replacement (or insertion, or wrapper) applied in order, through `registeredTree`.
 * Throws at module load when a path names nothing (`<leaf>: no node at <path>`), an insertion's path names no array
 * item (`<leaf>: <path> is not an array item`), a path names another node than `was` (`<leaf>: <path> is <node>, not
 * <was>`), or the result fails tier 1. Own-property lookups only.
 */
export function deriveTree(base: JsonValue, leaf: string, format: JsonFormat, replacements: readonly TreeReplacement[]): JsonValue {
  const holder: unknown[] = [JSON.parse(JSON.stringify(base)) as unknown];
  for (const { path, was, by, insert } of replacements) {
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
    // The holder is an array too, so `root` itself is not an item: its key is the holder's 0 with no step.
    if (insert === true && (!Array.isArray(parent) || parent === holder)) throw new Error(`${leaf}: ${path} is not an array item`);
    const node: unknown = Array.isArray(parent) ? parent[key as number] : parent[key as string];
    if (!matches(node, was)) throw new Error(`${leaf}: ${path} is ${brief(node)}, not ${canonicalJSON(was)}`);
    const value: unknown = typeof by === 'function' ? by(node as JsonValue) : by;
    if (insert === true) (parent as unknown[]).splice(key as number, 0, value);
    else if (Array.isArray(parent)) parent[key as number] = value;
    else parent[key as string] = value;
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
 * - jag × 1.6 and σ × (2.2 − 1.2·lakeMask), wrapping the `col` reads (so the jag term associates as (jag·1.6)·J;
 *   IEEE order is meaning): σ × 2.2 outside lakes, the default's σ (× 1 + 2⁻⁵²) in a basin (where the lake already
 *   sets jag 0);
 * - the slide fades σ over y 300-314 (knots [[−64, 0], [−40, 1], [300, 1], [314, 0]]);
 * - the ceiling −3·max(0, y − 270) (a soft knee from 270; the default's is −2·max(0, y − 296)).
 * σ × 2.2 and the slide end 314 are the user's approved retune (SP3e dry run, Checkpoint M; the spec drafted × 1.6
 * and 316): Z1's overhangs reach the master's 8 %. Where lakeMask is 0 each fade is `k + (−d)·0` = k bit for bit, so
 * the tree equals the plain factors there. The corner bound of §1.2 (lakeMask in [0, 1] up to a few ulps, so the
 * factors are at most 0.9 and 2.2: σ' ≤ 57.2; corners ≤ 15.9 at y 312 and ≤ −40.6 at 320) then leaves no solid voxel
 * at y ≥ 315. 80 nodes; the new subtrees read only `col` and `const`, so they stay in their column slot.
 */
export const AMPLIFIED_DENSITY_TREE: JsonValue = deriveTree(DEFAULT_DENSITY_TREE, 'density.defs', 'density', [
  {
    path: 'root.a.a.x.x.a.a.a.a.a',
    was: col('offset'),
    by: { op: 'add', a: col('offset'), b: { op: 'mul', a: lakeFade(0.9), b: { op: 'max', a: num(0), b: { op: 'add', a: col('offset'), b: num(-64) } } } },
  },
  { path: 'root.a.a.x.x.a.a.a.a.b.a', was: col('jag'), by: { op: 'mul', a: col('jag'), b: num(1.6) } },
  { path: 'root.a.a.x.x.a.a.b.a', was: col('sigma'), by: { op: 'mul', a: col('sigma'), b: lakeFade(2.2, 1.2) } },
  { path: 'root.a.a.x.x.a.a.b.b.knots', was: [[-64, 0], [-40, 1], [240, 1], [320, 0]], by: [[-64, 0], [-40, 1], [300, 1], [314, 0]] },
  { path: 'root.a.a.x.x.b.x.a.v', was: 2, by: 3 },
  { path: 'root.a.a.x.x.b.x.b.b.b.v', was: -296, by: -270 },
]);

const y = (): JsonValue => ({ op: 'y' });
const add = (a: JsonValue, b: JsonValue): JsonValue => ({ op: 'add', a, b });
const mul = (a: JsonValue, b: JsonValue): JsonValue => ({ op: 'mul', a, b });
const rangeChoice = (x: JsonValue, lo: number, hi: number, inside: JsonValue, outside: JsonValue): JsonValue =>
  ({ op: 'rangeChoice', x, lo, hi, inside, outside });

/**
 * floating_islands' islands term (SP3e spec §3.1, D3, D4): BODY = 20·(NI − 0.9 − 3·q + 4·(m − 1)), q = ((y − 230)·0.025)²
 * (no subtraction or division in the op set; 0.025 is the double nearest 1/40), m = `col islandMask`, NI the
 * `density.noises.islands` noise. Inside `interpolated` (NI sampled at the 4 × 8 × 4 corners only), gated by
 * `rangeChoice` on m ≥ 0.25 and on the corner y in [192, 265) (the corners 192 … 264), −1e6 elsewhere. With a = 3 ≥
 * clampSigma, k = 4 and c = 0.9 both gates are exact (§3.2: BODY ≤ 0 at the corners 184, 264 + 8 and beyond, and
 * wherever m ≤ 0.475), so island voxels lie in y 193-263, above `ISLAND_RUN_MIN_BOTTOM`.
 */
const ISLANDS_TERM: JsonValue = {
  op: 'interpolated',
  x: rangeChoice(col('islandMask'), 0.25, 2,
    rangeChoice(y(), 192, 265,
      mul(num(20), add(
        add(
          add({ op: 'noise', id: 'islands' }, num(-0.9)),
          { op: 'neg', x: mul(num(3), { op: 'square', x: mul(add(y(), num(-230)), num(0.025)) }) },
        ),
        mul(num(4), add(col('islandMask'), num(-1))),
      )),
      num(-1000000)),
    num(-1000000)),
};

/**
 * floating_islands (SP3e spec §3.1): the default density tree with the islands tap's child `root.b.x` (const −1e6)
 * replaced by the islands term. The root stays `max(add(tap terrain, detail), tap islands)`; the tap stays outside
 * `interpolated`, so its child is a sibling of the terrain's `interpolated` and its mute writes −1e6. 87 nodes.
 */
export const FLOATING_DENSITY_TREE: JsonValue = deriveTree(DEFAULT_DENSITY_TREE, 'density.defs', 'density', [
  { path: 'root.b.x', was: num(-1000000), by: ISLANDS_TERM },
]);

const cond = (c: JsonValue, then: JsonValue): JsonValue => ({ kind: 'condition', if: c, then });
const block = (state: string): JsonValue => ({ kind: 'block', state });
const stoneDepth = (side: 'floor' | 'ceiling', offset: number, addSurfaceDepth: boolean): JsonValue =>
  ({ kind: 'stoneDepth', side, offset, addSurfaceDepth });

/**
 * The islands surface branch (SP3e spec §4.1, §4.2, D6, D7). "On a floating island" = `yAbove{ISLAND_RUN_MIN_BOTTOM,
 * runTop}` then `stoneDepth{ceiling, 100}`: the run's top is ≥ 181 and the voxel within 100 blocks of its bottom, which
 * holds for every island run (y 193-263) and never for a run resting on the bedrock; it also passes overhang lips and
 * floating rocks over peaks above y 180 (§4.1). Gated by `stoneDepth{floor, 4, +SD}` (so the tree keeps its fast path
 * and `maxSurfaceDepth` = 4 + SD_MAX), it yields: grass on the top voxel (first, so thin islands are grass-topped), stone
 * on the bottom three voxels (the underside), dirt within the position's surface depth, and stone for the rest of the
 * skin, so the ground biome's palette never reaches an island. 17 nodes, colliding states only (tier 2's NOT_SOLID).
 * It has no `skyOpen`: under D21 (b) it applies to every run, a stacked island's included (§4.5).
 */
const ISLANDS_BRANCH: JsonValue = cond({ kind: 'yAbove', minY: ISLAND_RUN_MIN_BOTTOM, runTop: true },
  cond(stoneDepth('ceiling', 100, false),
    cond(stoneDepth('floor', 4, true), { kind: 'sequence', rules: [
      cond(stoneDepth('floor', 0, false), block('grass_block')),
      cond(stoneDepth('ceiling', 2, false), block('stone')),
      cond(stoneDepth('floor', 0, true), block('dirt')),
      block('stone'),
    ] })));

/**
 * floating_islands' rules (SP3e spec §4.2, §4.5, D21 (b), user point 1): the default rules with `root.rules[1]` (the
 * sky-open condition) wrapped as `sequence[islands branch, the sky-open condition]`. The branch leaves the sky-open
 * sequence, so it applies to every run (stacked islands are grass-topped) while the ground under an island, which the
 * scan makes the sky-open run with `islands.enabled` (the highest run reaching below y 181), keeps the default palette.
 * Every branch leaf keeps its floor `stoneDepth` gate, so the tree has a fast path with `maxSurfaceDepth` = 4 + SD_MAX,
 * but it is not sky-gated (the pass evaluates the top 4 + SD + 1 voxels of every run). `root.rules[0]` (bedrock) and
 * `root.rules[2]` (the deepslate gradient U2 perturbs) keep their places. 181 nodes.
 */
export const FLOATING_SURFACE_RULES: JsonValue = deriveTree(DEFAULT_SURFACE_RULES, 'surface.rules', 'surfaceRules', [
  {
    path: 'root.rules[1]',
    was: { kind: 'condition', if: { kind: 'skyOpen' } },
    by: (skyOpen) => ({ kind: 'sequence', rules: [ISLANDS_BRANCH, skyOpen] }),
  },
]);

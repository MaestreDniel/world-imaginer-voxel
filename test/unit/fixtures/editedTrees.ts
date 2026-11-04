/**
 * Edited trees of the two `json` leaves for the SP3d tests (spec §1.8 invariant, §1.11 round trips, §6 uiSmoke, §7 U2):
 * plain mutable copies of the defaults with the edits named below. Each call returns a fresh copy.
 */
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../../src/core/params/defaultTrees';
import type { ParamsPatch } from '../../../src/core/params/schema';

// Test-only JSON plumbing: the trees are walked by key, so `any` keeps the edits short.
type Tree = Record<string, any>;

const copy = (v: unknown): Tree => JSON.parse(JSON.stringify(v)) as Tree;

/**
 * The default density tree (a mutable copy). Its terrain tap is `root.a.a.a.x.a` (inside the `precave` tap, SP6a §1.1),
 * `detailG` `root.a.a.a.x.b` (the detail term is its `inside`, `root.a.a.a.x.b.inside`), the caves slot `root.a.a.b.a`
 * and the noodle tap `root.a.b.a` under the wet roof's `add(…, ref wetSteep)` (`root.a.a.b`, `root.a.b`), its islands tap
 * `root.b`.
 */
export const densityTree = (): Tree => copy(DEFAULT_DENSITY_TREE);
/** The default rule tree (a mutable copy). Its deepslate gradient is the condition `rules[2].if`. */
export const rulesTree = (): Tree => copy(DEFAULT_SURFACE_RULES);

/** uiSmoke step 2 (spec §6): the islands const edited from −1e6 to −10. */
export function islandsAt(v: number): Tree {
  const t = densityTree();
  t['root'].b.x.v = v;
  return t;
}

/** uiSmoke step 3 and U2's density variant (spec §6, §7): the terrain tap muted to `mute`. */
export function terrainMuted(mute = 0): Tree {
  const t = densityTree();
  t['root'].a.a.a.x.a.mute = mute;
  return t;
}

/**
 * The default tree without SP6a's cave terms (its root slots kept, §1.1): detailG replaced by its detail term, the caves
 * slot and the noodle slot with the wet roof's steep part (`root.a.a.b`, `root.a.b`) by `const 1e6`, `defs.pillars` and
 * `defs.wetSteep` dropped; the SP5c world's values, work cost 574.
 */
export function caveFreeTree(): Tree {
  const t = densityTree();
  t['root'].a.a.a.x.b = t['root'].a.a.a.x.b.inside;
  t['root'].a.a.b = { op: 'const', v: 1000000 };
  t['root'].a.b = { op: 'const', v: 1000000 };
  delete t['defs'].pillars;
  delete t['defs'].wetSteep;
  return t;
}

/**
 * A tree that reads `col steep` at the weight of the default without its cave terms (work cost 574 + 2): `caveFreeTree`
 * with the islands const replaced by add(const −1e6, col steep), so its horizontal slices take corner samples with steep
 * (spec §4.4, §5.2). SP3d's work bound was calibrated on that weight (P3); today's default with SP6a's cave terms weighs
 * 17,547 since Task 9's wet roof (`steepDefaultTree`).
 */
export function steepTree(): Tree {
  const t = caveFreeTree();
  t['root'].b.x = { op: 'add', a: { op: 'const', v: -1000000 }, b: { op: 'col', field: 'steep' } };
  return t;
}

/** `steepTree`'s edit on today's default tree (SP6a's cave terms with the wet roof: work cost 17,451 + 2 since D25's lever 5). */
export function steepDefaultTree(): Tree {
  const t = densityTree();
  t['root'].b.x = { op: 'add', a: { op: 'const', v: -1000000 }, b: { op: 'col', field: 'steep' } };
  return t;
}

/**
 * A heavy tier-2-valid density patch (spec §4.5, §10: a configure stops a part within 50 ms for every field): the
 * default root plus mul(20, a balanced add of `leaves` (a power of 2) `noise detail` leaves), the detail noise at 16
 * octaves, double. At 32 leaves its column cost is about 0.4 G of `DENSITY_COLUMN_COST_MAX`'s 0.95 G, and the T column
 * (or a rule probe column) takes about 0.1 s to fill.
 */
export function heavyDetailPatch(leaves = 32): ParamsPatch {
  let level: Tree[] = Array.from({ length: leaves }, () => ({ op: 'noise', id: 'detail' }));
  while (level.length > 1) {
    const next: Tree[] = [];
    for (let i = 0; i < level.length; i += 2) next.push({ op: 'add', a: level[i], b: level[i + 1] });
    level = next;
  }
  const t = densityTree();
  t['root'] = { op: 'add', a: t['root'], b: { op: 'mul', a: { op: 'const', v: 20 }, b: level[0] } };
  return { density: { noises: { detail: { octaves: 16, double: true } }, defs: t } } as ParamsPatch;
}

/** U2's rules variant (spec §7): the deepslate gradient's `falseAtAndAbove` 8 → `top`. */
export function gradientTop(top = 12): Tree {
  const t = rulesTree();
  t['rules'][2].if.falseAtAndAbove = top;
  return t;
}

/**
 * Spec §1.11's edited density tree: a def `lift` (2 · detailAmpLo through a `param` node) referenced by the islands tap,
 * the terrain tap muted to 0.5, and the detail amplitude's clamp with a negated ref as its lower bound.
 */
export function editedDensity(): Tree {
  const t = densityTree();
  t['defs'] = { ...t['defs'], lift: { op: 'mul', a: { op: 'const', v: 2 }, b: { op: 'param', path: 'density.detailAmpLo' } } };
  t['root'].b.x = { op: 'add', a: { op: 'ref', name: 'lift' }, b: { op: 'const', v: -1000000 } };
  t['root'].a.a.a.x.a.mute = 0.5;
  const clamp = t['root'].a.a.a.x.b.inside.b.b.b;
  if (clamp.op !== 'clamp') throw new Error('the default density tree moved: no clamp at root.a.a.a.x.b.inside.b.b.b');
  clamp.lo = { param: 'density.detailAmpLo', neg: true };
  return t;
}

/** Spec §1.11's edited rule tree: the gradient top 8 → 12 and the cliff steepness read negated (−cliffSteep ≤ steep). */
export function editedRules(): Tree {
  const t = gradientTop(12);
  const steep = findKind(t, 'steep');
  steep.min = { param: 'surface.cliffSteep', neg: true };
  return t;
}

/** The first node of `kind` in DFS order (rules, then, if, …). */
export function findKind(t: unknown, kind: string): Tree {
  const stack: unknown[] = [t];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null) continue;
    if (!Array.isArray(v) && (v as Tree)['kind'] === kind) return v as Tree;
    const children = Array.isArray(v) ? v : Object.values(v);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  throw new Error(`no ${kind} node`);
}

/** Both trees edited (spec §1.11), as a patch over the default profile. */
export const editedPatch = (): ParamsPatch => ({ density: { defs: editedDensity() }, surface: { rules: editedRules() } }) as ParamsPatch;

/**
 * A density tree at tier 1's depth bound (spec §1.7): its top object is container depth 1, `root` 2, and a chain of
 * `neg` nodes ends in the `y` node at container depth `depth`.
 */
export function deepDensity(depth = 48): Tree {
  let node: Tree = { op: 'y' };
  for (let d = depth - 1; d >= 2; d--) node = { op: 'neg', x: node };
  return { root: node, defs: {} };
}

/**
 * A rule tree of container depth `depth` (48: tier 1's bound): nested one-child sequences (2 levels each) around an
 * empty sequence (depth 2) or, for an odd depth, a sequence holding one block (depth 3).
 */
export function deepRules(depth = 48): Tree {
  let node: Tree = depth % 2 === 0 ? { kind: 'sequence', rules: [] } : { kind: 'sequence', rules: [{ kind: 'block', state: 'stone' }] };
  for (let d = depth % 2 === 0 ? 2 : 3; d < depth; d += 2) node = { kind: 'sequence', rules: [node] };
  return node;
}

/** Container depth of a JSON value (its top container 1; a primitive 0). */
export function jsonDepth(v: unknown): number {
  if (typeof v !== 'object' || v === null) return 0;
  let max = 0;
  for (const c of Array.isArray(v) ? v : Object.values(v)) max = Math.max(max, jsonDepth(c));
  return max + 1;
}

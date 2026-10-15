/**
 * The two trees at the 128 KiB cap of `session.commitMaxTree` (SP3d spec §1.12, §9): a `density.defs` and a
 * `surface.rules` value that pass both tiers and whose canonical text is as close to `TREE_LIMITS.textUnits` (131,072
 * characters) as their padding unit allows, without exceeding it.
 * - Density: the default tree plus unreachable defs (tier 2 bounds every def, reachable or not, §1.7): balanced `add`s of
 *   `const` leaves with 17-digit literals up to 4,000 nodes in all (tier 2's bound is 4,096), then `slide` defs over a
 *   `const` of up to 64 knots (tier 2's `TOO_MANY_KNOTS` bound), the last one's knot count filling the text to within
 *   one knot (≈ 30 characters) of the cap.
 * - Rules: the default tree with Y-only `verticalGradient` conditions appended to its root sequence, in nested sequences
 *   of at most 512 (tier 1 caps arrays at 1,024), so the fast path holds and the column cost stays within tier 2's
 *   maximum; it fills to within one condition (≈ 130 characters) of the cap.
 * Plain (unfrozen, unregistered) values: the session's tier 1 clones them once, when they are set.
 */
import { TREE_LIMITS } from '../../src/core/constants';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';

type Obj = Record<string, unknown>;
const CAP = TREE_LIMITS.textUnits;
/** The density nodes the padding stops at (tier 2: at most 4,096 nodes in all). */
const DENSITY_NODES = 4000;
/** `const` leaves per padding `add` def (2 × 250 − 1 = 499 nodes). */
const LEAVES_PER_DEF = 250;
/** Knots per padding slide (tier 2: at most 64 per slide). */
const KNOTS_PER_SLIDE = 64;
/** Conditions per nested padding sequence (tier 1: arrays ≤ 1,024 items). */
const RULES_PER_SEQUENCE = 512;

const copy = (v: unknown): Obj => JSON.parse(JSON.stringify(v)) as Obj;
const textOf = (v: unknown): number => canonicalJSON(v as never).length;

/** The nodes of a density source value (objects with an `op`), defs included. */
export function densityNodeCount(tree: unknown): number {
  let count = 0;
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
    if (typeof v !== 'object' || v === null) continue;
    if (Object.hasOwn(v, 'op')) count++;
    for (const x of Object.values(v)) stack.push(x);
  }
  return count;
}

/** A 17-significant-digit literal in (−1, 0): `String` prints it in 20-22 characters. */
const literal = (i: number): number => -((i % 9973) + 1) / 9973.000000000001;

/** A balanced binary `add` of `leaves` `const` leaves (level by level: no recursion). */
function constSum(leaves: number, first: number): Obj {
  let level: Obj[] = Array.from({ length: leaves }, (_, i) => ({ op: 'const', v: literal(first + i) }));
  while (level.length > 1) {
    const next: Obj[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push({ op: 'add', a: level[i]!, b: level[i + 1]! });
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}

const slide = (knots: number): Obj => ({ op: 'slide', x: { op: 'const', v: 0 }, knots: Array.from({ length: knots }, (_, i) => [i, literal(i)]) });

/** The default density tree padded with unreachable defs to the 128 KiB cap (see the module comment). */
export function capDensityTree(): Obj {
  const tree = copy(DEFAULT_DENSITY_TREE);
  const defs = tree['defs'] as Obj;
  let nodes = densityNodeCount(tree);
  let pad = 0;
  while (nodes + 2 * LEAVES_PER_DEF - 1 <= DENSITY_NODES) {
    const def = constSum(LEAVES_PER_DEF, pad * LEAVES_PER_DEF);
    defs[`padSum${pad}`] = def;
    if (textOf(tree) > CAP) { delete defs[`padSum${pad}`]; break; }
    nodes += 2 * LEAVES_PER_DEF - 1;
    pad++;
  }
  // Slide defs of KNOTS_PER_SLIDE knots, the last one cut to the largest knot count that fits.
  for (let s = 0; textOf(tree) < CAP; s++) {
    const name = `padSlide${s}`;
    defs[name] = slide(KNOTS_PER_SLIDE);
    if (textOf(tree) <= CAP) continue;
    let lo = 2;
    let hi = KNOTS_PER_SLIDE;
    defs[name] = slide(lo);
    if (textOf(tree) > CAP) { delete defs[name]; break; }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      defs[name] = slide(mid);
      if (textOf(tree) <= CAP) lo = mid; else hi = mid - 1;
    }
    defs[name] = slide(lo);
    break;
  }
  return tree;
}

const gradient = (i: number): Obj => {
  const lo = -64 + (i % 320);
  return { kind: 'condition', if: { kind: 'verticalGradient', trueAtAndBelow: lo, falseAtAndAbove: lo + 5 }, then: { kind: 'block', state: 'stone' } };
};

/** The default rule tree with Y-only conditions appended to its root sequence up to the 128 KiB cap (see the module comment). */
export function capSurfaceRules(): Obj {
  const tree = copy(DEFAULT_SURFACE_RULES);
  const root = tree['rules'] as unknown[];
  // The text grows by exactly the appended value's text plus one comma (the root sequence is not empty), so the
  // length is tracked without reprinting; the caller's tests check the final text against the cap.
  let length = textOf(tree);
  let i = 0;
  for (;;) {
    const seq = { kind: 'sequence', rules: [] as Obj[] };
    const seqText = textOf(seq) + 1;
    if (length + seqText + textOf(gradient(i)) > CAP) return tree;
    root.push(seq);
    length += seqText;
    while (seq.rules.length < RULES_PER_SEQUENCE) {
      const g = gradient(i);
      const add = textOf(g) + (seq.rules.length > 0 ? 1 : 0);
      if (length + add > CAP) return tree;
      seq.rules.push(g);
      length += add;
      i++;
    }
  }
}

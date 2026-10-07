/**
 * Per-op semantics of the density DAG (SP3b spec §1.1, §1.2, §2.1), shared by the compiler, the reference
 * interpreter and the bounds: the scalar value of each op, the one-step evaluator `evalNode` (which pins the
 * evaluation order), the interval rules (with the widening helper) and the class rule.
 *
 * Values: IEEE double, round to nearest, in the written order, never fused or reassociated. Every binary op evaluates
 * a, then b. min/max compare with < / > and return a on ties (also +0 against −0); −0 is a valid density.
 *
 * Intervals are written as two doubles `out[k] = lo`, `out[k + 1] = hi` (allocation-free). Endpoint arithmetic is
 * sound because rounding is monotone; interpolation is not, so callers widen what leaves an `interpolated` node and
 * every voxel-level COLUMN read with `ivWiden`. Endpoints are assumed finite.
 */
import type { ColExpr, Expr, ExprOp, InterpolatedExpr, Noise2Expr, NoiseExpr, RefExpr, SlideKnot } from './expr';

export function valAdd(a: number, b: number): number { return a + b; }
export function valMul(a: number, b: number): number { return a * b; }
export function valMin(a: number, b: number): number { return b < a ? b : a; }
export function valMax(a: number, b: number): number { return b > a ? b : a; }
export function valNeg(x: number): number { return -x; }
/** |x|; |−0| is +0. */
export function valAbs(x: number): number { return Math.abs(x); }
export function valSquare(x: number): number { return x * x; }
/** x < lo ? lo : x > hi ? hi : x (−0 inside the range stays −0). */
export function valClamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/**
 * The slide factor s(y): v_0 below the first knot, v_last at and above the last, and on the half-open segment
 * [y_k, y_{k+1}) `v_k + (y − y_k) · ((v_{k+1} − v_k) / (y_{k+1} − y_k))`, in that order.
 */
export function slideAt(knots: readonly SlideKnot[], y: number): number {
  const n = knots.length;
  const first = knots[0]!;
  if (y < first[0]) return first[1];
  const last = knots[n - 1]!;
  if (y >= last[0]) return last[1];
  let k = 0;
  while (y >= knots[k + 1]![0]) k++;
  const [yk, vk] = knots[k]!;
  const [y1, v1] = knots[k + 1]!;
  return vk + (y - yk) * ((v1 - vk) / (y1 - yk));
}

/** slide's value: x · s(y). */
export function valSlide(x: number, knots: readonly SlideKnot[], y: number): number { return x * slideAt(knots, y); }

/** rangeChoice's test: lo ≤ x < hi chooses `inside`. */
export function inRange(x: number, lo: number, hi: number): boolean { return lo <= x && x < hi; }

/** The reads a node delegates to its caller, whose placement rules (§2.1, §2.2) decide where they are taken. */
export type DelegatedExpr = ColExpr | Noise2Expr | NoiseExpr | InterpolatedExpr | RefExpr;

/** What `evalNode` needs from the walker that calls it. */
export interface NodeEnv {
  /** The current point's y (the voxel's, or the corner's inside `interpolated`). */
  readonly y: number;
  /** A child's value, through the caller's placement rules. */
  child(e: Expr): number;
  /** `col`, `noise2`, `noise`, `interpolated` and `ref`: the caller samples, interpolates or resolves them. */
  read(e: DelegatedExpr): number;
}

/**
 * One node's value from its children (SP3b spec §1.1): children are visited in slot order (a then b), and only the
 * chosen branch of a rangeChoice is evaluated, after its x.
 */
export function evalNode(e: Expr, env: NodeEnv): number {
  switch (e.op) {
    case 'const': return e.v;
    case 'y': return env.y;
    case 'col': case 'noise2': case 'noise': case 'interpolated': case 'ref': return env.read(e);
    case 'add': { const a = env.child(e.a); return valAdd(a, env.child(e.b)); }
    case 'mul': { const a = env.child(e.a); return valMul(a, env.child(e.b)); }
    case 'min': { const a = env.child(e.a); return valMin(a, env.child(e.b)); }
    case 'max': { const a = env.child(e.a); return valMax(a, env.child(e.b)); }
    case 'neg': return valNeg(env.child(e.x));
    case 'abs': return valAbs(env.child(e.x));
    case 'square': return valSquare(env.child(e.x));
    case 'clamp': return valClamp(env.child(e.x), e.lo, e.hi);
    case 'slide': return valSlide(env.child(e.x), e.knots, env.y);
    case 'rangeChoice': { const x = env.child(e.x); return inRange(x, e.lo, e.hi) ? env.child(e.inside) : env.child(e.outside); }
    case 'tap': return env.child(e.x);
  }
}

// ---- Geometry and interpolation (SP3b spec §2.2) ----
// A column is 4 × 48 × 4 cells of 4 × 8 × 4 voxels. Corners sit at local x, z ∈ {0, 4, 8, 12, 16} (i, j = 0 … 4,
// lattice point latticeIndex(i, j)) and y = −64 + 8k (k = 0 … 48). Every fraction below is exact.

/** The cell index along x or z of a local block coordinate 0 … 15. */
export function cellXZ(l: number): number { return l >> 2; }
/** The voxel's fraction across its cell along x or z: (l − 4·cell) / 4. */
export function fracXZ(l: number): number { return (l - 4 * (l >> 2)) / 4; }
/** The cell layer of a voxel y ∈ [−64, 319]: ⌊(y + 64) / 8⌋. */
export function cellY(y: number): number { return (y + 64) >> 3; }
/** The voxel's fraction across its cell layer: (y + 64 − 8·cell) / 8. */
export function fracY(y: number): number { return (y + 64 - 8 * ((y + 64) >> 3)) / 8; }
/** The y of corner layer k: −64 + 8k. */
export function cornerY(k: number): number { return -64 + 8 * k; }

/** lerp(a, b, t) = a + t · (b − a), in that order (the one definition the compiler and the reference share). */
export function lerp(a: number, b: number, t: number): number { return a + t * (b - a); }

/**
 * Trilinear interpolation of a cell's 8 corner values in the pinned order: lerp along x on the four x-edges, then
 * along z, then along y. `cXYZ` is the corner at (x0 + 4X, y0 + 8Y, z0 + 4Z); the arguments come x fastest, then z,
 * then y (c000, c100, c001, c101 on the lower layer, then the upper layer), followed by tx, ty, tz.
 */
export function trilerp(
  c000: number, c100: number, c001: number, c101: number, c010: number, c110: number, c011: number, c111: number,
  tx: number, ty: number, tz: number,
): number {
  const e00 = lerp(c000, c100, tx);
  const e01 = lerp(c001, c101, tx);
  const e10 = lerp(c010, c110, tx);
  const e11 = lerp(c011, c111, tx);
  return lerp(lerp(e00, e01, tz), lerp(e10, e11, tz), ty);
}

// ---- Interval rules (SP3b spec §1.2) ----

/** [lo, hi] as is: `const` is [v, v], `y` the cell's [y0, y1]. */
export function ivSet(lo: number, hi: number, out: Float64Array, k: number): void {
  out[k] = lo;
  out[k + 1] = hi;
}

/** `noise2` / `noise`: [−clampSigma, clampSigma]. */
export function ivNoise(clampSigma: number, out: Float64Array, k: number): void {
  out[k] = -clampSigma;
  out[k + 1] = clampSigma;
}

export function ivAdd(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = a0 + b0;
  out[k + 1] = a1 + b1;
}

/** The min and max of the four endpoint products. */
export function ivMul(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  const p = a0 * b0, q = a0 * b1, r = a1 * b0, s = a1 * b1;
  let lo = p, hi = p;
  if (q < lo) lo = q; if (q > hi) hi = q;
  if (r < lo) lo = r; if (r > hi) hi = r;
  if (s < lo) lo = s; if (s > hi) hi = s;
  out[k] = lo;
  out[k + 1] = hi;
}

export function ivMin(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = b0 < a0 ? b0 : a0;
  out[k + 1] = b1 < a1 ? b1 : a1;
}

export function ivMax(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = b0 > a0 ? b0 : a0;
  out[k + 1] = b1 > a1 ? b1 : a1;
}

export function ivNeg(x0: number, x1: number, out: Float64Array, k: number): void {
  out[k] = -x1;
  out[k + 1] = -x0;
}

/** The exact image of |x|. */
export function ivAbs(x0: number, x1: number, out: Float64Array, k: number): void {
  if (x0 >= 0) { out[k] = x0; out[k + 1] = x1; }
  else if (x1 <= 0) { out[k] = -x1; out[k + 1] = -x0; }
  else { out[k] = 0; out[k + 1] = -x0 > x1 ? -x0 : x1; }
}

/** The exact image of x · x. */
export function ivSquare(x0: number, x1: number, out: Float64Array, k: number): void {
  const a = x0 * x0, b = x1 * x1;
  if (x0 >= 0) { out[k] = a; out[k + 1] = b; }
  else if (x1 <= 0) { out[k] = b; out[k + 1] = a; }
  else { out[k] = 0; out[k + 1] = a > b ? a : b; }
}

/** The exact image of clamp (monotone). */
export function ivClamp(x0: number, x1: number, lo: number, hi: number, out: Float64Array, k: number): void {
  out[k] = valClamp(x0, lo, hi);
  out[k + 1] = valClamp(x1, lo, hi);
}

/**
 * The range of s over [y0, y1]: s(y0), s(y1) and, at each interior knot y_k ∈ (y0, y1], both v_k and the left
 * segment's formula at y_k (which can differ from v_k by an ulp). s is monotone between knots, so this is sound.
 */
export function ivSlideFactor(knots: readonly SlideKnot[], y0: number, y1: number, out: Float64Array, k: number): void {
  let lo = slideAt(knots, y0), hi = lo;
  const e = slideAt(knots, y1);
  if (e < lo) lo = e; if (e > hi) hi = e;
  for (let i = 0; i < knots.length; i++) {
    const [yk, vk] = knots[i]!;
    if (yk <= y0) continue;
    if (yk > y1) break;
    if (vk < lo) lo = vk; if (vk > hi) hi = vk;
    if (i > 0) {
      const [ya, va] = knots[i - 1]!;
      const left = va + (yk - ya) * ((vk - va) / (yk - ya));
      if (left < lo) lo = left; if (left > hi) hi = left;
    }
  }
  out[k] = lo;
  out[k + 1] = hi;
}

/** slide: x's interval times s's range over [y0, y1] (the mul rule). */
export function ivSlide(x0: number, x1: number, knots: readonly SlideKnot[], y0: number, y1: number, out: Float64Array, k: number): void {
  ivSlideFactor(knots, y0, y1, out, k);
  ivMul(x0, x1, out[k]!, out[k + 1]!, out, k);
}

/** Which rangeChoice branches an interval of x can reach: x ⊆ [lo, hi) → inside, disjoint → outside, else both. */
export function rangeChoiceCase(x0: number, x1: number, lo: number, hi: number): 'inside' | 'outside' | 'both' {
  if (x0 >= lo && x1 < hi) return 'inside';
  if (x1 < lo || x0 >= hi) return 'outside';
  return 'both';
}

/** The hull of two intervals (rangeChoice when both branches are reachable). */
export function ivHull(a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number): void {
  out[k] = b0 < a0 ? b0 : a0;
  out[k + 1] = b1 > a1 ? b1 : a1;
}

/** Widening: both ends move out by w = 1e-9 · (1 + max(|lo|, |hi|)). */
export function ivWiden(lo: number, hi: number, out: Float64Array, k: number): void {
  const w = 1e-9 * (1 + Math.max(Math.abs(lo), Math.abs(hi)));
  out[k] = lo - w;
  out[k + 1] = hi + w;
}

// ---- Class rule (SP3b spec §2.1) ----

/** Stage placement classes, ordered COLUMN < CELL < VOXEL. */
export type DensityClass = 'column' | 'cell' | 'voxel';

/**
 * A node's own class: `y`, `slide` and `noise` are y-dependent (CELL inside `interpolated`, VOXEL outside, never
 * COLUMN); `interpolated` is VOXEL (evaluated per voxel from its CELL corners) and is never inside another; every other
 * op adds nothing (COLUMN), so `const`, `col` and `noise2` sub-trees stay COLUMN.
 */
export function ownClass(op: ExprOp, inside: boolean): DensityClass {
  switch (op) {
    case 'y': case 'slide': case 'noise': return inside ? 'cell' : 'voxel';
    case 'interpolated':
      if (inside) throw new Error('an interpolated inside another has no class');
      return 'voxel';
    default: return 'column';
  }
}

export function joinClass(a: DensityClass, b: DensityClass): DensityClass {
  if (a === 'voxel' || b === 'voxel') return 'voxel';
  if (a === 'cell' || b === 'cell') return 'cell';
  return 'column';
}

/**
 * A node's class: the highest of its own and its children's (children of `interpolated` are inside it), with `ref`
 * resolved through `defs`. Equivalently COLUMN when the sub-tree has no y-dependent op, else CELL inside and VOXEL
 * outside. Nesting is validateExpr's to reject; only a
 * directly nested `interpolated` throws here. `memo` (node → is COLUMN) may be shared across calls and makes DAG-shaped trees linear.
 */
export function exprClass(e: Expr, inside: boolean, defs: Readonly<Record<string, Expr>>, memo: WeakMap<Expr, boolean> = new WeakMap()): DensityClass {
  if (e.op === 'interpolated') ownClass('interpolated', inside);
  if (isColumn(e, defs, memo)) return 'column';
  return inside ? 'cell' : 'voxel';
}

function resolve(name: string, defs: Readonly<Record<string, Expr>>): Expr {
  if (!Object.hasOwn(defs, name)) throw new Error(`unknown def ${name}`);
  return defs[name]!;
}

function isColumn(e: Expr, defs: Readonly<Record<string, Expr>>, memo: WeakMap<Expr, boolean>): boolean {
  const cached = memo.get(e);
  if (cached !== undefined) return cached;
  let r: boolean;
  switch (e.op) {
    case 'const': case 'col': case 'noise2': r = true; break;
    case 'y': case 'slide': case 'noise': case 'interpolated': r = false; break;
    case 'ref': r = isColumn(resolve(e.name, defs), defs, memo); break;
    case 'add': case 'mul': case 'min': case 'max': r = isColumn(e.a, defs, memo) && isColumn(e.b, defs, memo); break;
    case 'rangeChoice': r = isColumn(e.x, defs, memo) && isColumn(e.inside, defs, memo) && isColumn(e.outside, defs, memo); break;
    default: r = isColumn(e.x, defs, memo); break;
  }
  memo.set(e, r);
  return r;
}

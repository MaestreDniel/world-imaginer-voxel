import { q15 } from '../params/canonical';
import { SPLINE_SLOT } from './types';
import type { KnotPath, NestedSpline, SplineOpts, SplinePoint } from './types';
import { normalizeSpline, SplineValidationError, validateSpline } from './validate';

const Q15 = q15;
const SLOT = SPLINE_SLOT;
const NORMALIZE = normalizeSpline;
const ValidationError = SplineValidationError;
const VALIDATE = validateSpline;

const OP_CONST = 0;
const OP_LEAF = 1;
const OP_MIX = 2;

/**
 * Program layout (SP1 spec §3.3), root at code[0], DFS pre-order:
 *   CONST [0, k]                  value = nums[k]
 *   LEAF  [1, slot, n, b]         nums[b..b+n) = x, [b+n..b+2n) = d, [b+2n..b+3n) = y
 *   MIX   [2, slot, n, b, c0..]   nums[b..b+n) = x, [b+n..b+2n) = d; c_i = code offset of knot i's child
 */
export interface CompiledSpline {
  readonly code: Int32Array;
  readonly nums: Float64Array;
  /** Register file (2·depth + 1); owned by the program, single-threaded use. */
  readonly regs: Float64Array;
  /** Bit i set = coords[i] is read. */
  readonly coordMask: number;
  readonly depth: number;
  readonly splines: number;
  readonly knots: number;
}

export function compileSpline(s: NestedSpline, opts: SplineOpts = {}): CompiledSpline {
  const issues = VALIDATE(s, '', opts);
  if (issues.length > 0) throw new ValidationError(issues);
  const norm = NORMALIZE(s);
  const code: number[] = [];
  const nums: number[] = [];
  let coordMask = 0;
  let depth = 0;
  let splines = 0;
  let knots = 0;
  const emit = (node: NestedSpline, level: number): number => {
    const at = code.length;
    const n = node.points.length;
    const mix = node.points.some((p) => typeof p.y !== 'number');
    const slot = SLOT[node.coord];
    coordMask |= 1 << slot;
    if (level > depth) depth = level;
    splines++;
    knots += n;
    code.push(mix ? OP_MIX : OP_LEAF, slot, n, nums.length);
    for (const p of node.points) nums.push(p.x);
    for (const p of node.points) nums.push(p.d);
    if (!mix) {
      for (const p of node.points) nums.push(p.y as number);
      return at;
    }
    const refs = code.length;
    for (let i = 0; i < n; i++) code.push(-1);
    for (let i = 0; i < n; i++) {
      const y = node.points[i]!.y;
      if (typeof y === 'number') {
        code[refs + i] = code.length;
        code.push(OP_CONST, nums.length);
        nums.push(y);
      } else {
        code[refs + i] = emit(y, level + 1);
      }
    }
    return at;
  };
  emit(norm, 1);
  return { code: Int32Array.from(code), nums: Float64Array.from(nums), regs: new Float64Array(2 * depth + 1), coordMask, depth, splines, knots };
}

/**
 * Register-file interpreter: writes the node's value to regs[r]; a MIX node's two bracketing children
 * write regs[r+1] and regs[r+2]. No double is returned from the recursion, so V8 never boxes.
 * Canonical segment formula: f = y0 + t*dy + t*(1 - t)*((1 - t)*(d0*h - dy) + t*(dy - d1*h)).
 */
function evalNode(code: Int32Array, nums: Float64Array, o: number, c: Float64Array, regs: Float64Array, r: number): void {
  const op = code[o]!;
  if (op === OP_CONST) { regs[r] = nums[code[o + 1]!]!; return; }
  const q = c[code[o + 1]!]!;
  const n = code[o + 2]!;
  const b = code[o + 3]!;
  if (q !== q) { regs[r] = q; return; }
  let i: number;
  if (q <= nums[b]!) i = -1;
  else if (q >= nums[b + n - 1]!) i = n - 1;
  else { i = 0; while (q >= nums[b + i + 1]!) i++; }
  if (op === OP_LEAF) {
    if (i < 0) { regs[r] = nums[b + 2 * n]!; return; }
    if (i === n - 1) { regs[r] = nums[b + 3 * n - 1]!; return; }
    const x0 = nums[b + i]!;
    const h = nums[b + i + 1]! - x0;
    const t = (q - x0) / h;
    const y0 = nums[b + 2 * n + i]!;
    const dy = nums[b + 2 * n + i + 1]! - y0;
    regs[r] = y0 + t * dy + t * (1 - t) * ((1 - t) * (nums[b + n + i]! * h - dy) + t * (dy - nums[b + n + i + 1]! * h));
    return;
  }
  if (i < 0) { evalNode(code, nums, code[o + 4]!, c, regs, r); return; }
  if (i === n - 1) { evalNode(code, nums, code[o + 3 + n]!, c, regs, r); return; }
  evalNode(code, nums, code[o + 4 + i]!, c, regs, r + 1);
  evalNode(code, nums, code[o + 5 + i]!, c, regs, r + 2);
  const x0 = nums[b + i]!;
  const h = nums[b + i + 1]! - x0;
  const t = (q - x0) / h;
  const y0 = regs[r + 1]!;
  const dy = regs[r + 2]! - y0;
  regs[r] = y0 + t * dy + t * (1 - t) * ((1 - t) * (nums[b + n + i]! * h - dy) + t * (dy - nums[b + n + i + 1]! * h));
}

/** coords: Float64Array(6) in SPLINE_COORDS order. Zero allocation. */
export function evalSpline(p: CompiledSpline, coords: Float64Array): number {
  evalNode(p.code, p.nums, 0, coords, p.regs, 0);
  return p.regs[0]!;
}

/** Structure-of-arrays batch: soa[slot*stride + j] for j < n; writes out[j]. Zero allocation. */
export function evalSplineBatch(p: CompiledSpline, soa: Float64Array, stride: number, n: number, out: Float64Array, scratch: Float64Array): void {
  const mask = p.coordMask;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < 6; k++) if ((mask >> k) & 1) scratch[k] = soa[k * stride + j]!;
    evalNode(p.code, p.nums, 0, scratch, p.regs, 0);
    out[j] = p.regs[0]!;
  }
}

const N = (v: number) => Q15(v) + 0;

/** Object-walk oracle with the same formula; reads every number as q15(v) + 0. */
export function evalSplineRef(s: NestedSpline, coords: Float64Array): number {
  const q = coords[SLOT[s.coord]]!;
  const pts = s.points;
  const n = pts.length;
  const val = (pt: SplinePoint): number => (typeof pt.y === 'number' ? N(pt.y) : evalSplineRef(pt.y, coords));
  if (q !== q) return q;
  if (q <= N(pts[0]!.x)) return val(pts[0]!);
  if (q >= N(pts[n - 1]!.x)) return val(pts[n - 1]!);
  let i = 0;
  while (q >= N(pts[i + 1]!.x)) i++;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const y0 = val(a);
  const y1 = val(b);
  const x0 = N(a.x);
  const h = N(b.x) - x0;
  const t = (q - x0) / h;
  const dy = y1 - y0;
  return y0 + t * dy + t * (1 - t) * ((1 - t) * (N(a.d) * h - dy) + t * (dy - N(b.d) * h));
}

export function knotPathToString(path: KnotPath): string {
  return path.map((i, k) => (k === 0 ? `points[${i}]` : `y.points[${i}]`)).join('.');
}

/** Pure update of one numeric knot's y (structural sharing). */
export function withKnotY(s: NestedSpline, path: KnotPath, y: number): NestedSpline {
  const [i, ...rest] = path;
  if (i === undefined) throw new Error('empty knot path');
  const points = s.points.slice();
  const p = points[i];
  if (p === undefined) throw new Error(`no knot ${i}`);
  if (rest.length === 0) {
    if (typeof p.y !== 'number') throw new Error('knot y is a nested spline');
    points[i] = { x: p.x, y, d: p.d };
  } else {
    if (typeof p.y === 'number') throw new Error('path descends into a numeric knot');
    points[i] = { x: p.x, y: withKnotY(p.y, rest, y), d: p.d };
  }
  return { coord: s.coord, points };
}

import { q15 } from '../params/canonical';
import type { NestedSpline, SplinePoint } from './types';

const Q15 = q15;

function endSlope(h0: number, h1: number, m0: number, m1: number): number {
  let e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (Math.sign(e) !== Math.sign(m0)) e = 0;
  else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > Math.abs(3 * m0)) e = 3 * m0;
  return e;
}

/** Fritsch–Carlson PCHIP tangents with SciPy end conditions over one numeric run (length ≥ 2). */
function pchipRun(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  if (n === 2) {
    const d = (ys[1]! - ys[0]!) / (xs[1]! - xs[0]!);
    return [d, d];
  }
  const h: number[] = [];
  const dl: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1]! - xs[i]!);
    dl.push((ys[i + 1]! - ys[i]!) / h[i]!);
  }
  const d = new Array<number>(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    const a = dl[k - 1]!;
    const b = dl[k]!;
    if (a * b <= 0) continue;
    const w1 = 2 * h[k]! + h[k - 1]!;
    const w2 = h[k]! + 2 * h[k - 1]!;
    d[k] = (w1 + w2) / (w1 / a + w2 / b);
  }
  d[0] = endSlope(h[0]!, h[1]!, dl[0]!, dl[1]!);
  d[n - 1] = endSlope(h[n - 2]!, h[n - 3]!, dl[n - 2]!, dl[n - 3]!);
  return d;
}

/**
 * The hybrid tangent rule (SP1 spec §3.4), authoring-time only: PCHIP inside each maximal run of
 * numeric knots; d = 0 at nested knots, at knots adjacent to a nested knot, at single-knot runs and at
 * end knots strictly inside (−1, 1). Every d is stored as q15(d) + 0.
 */
export function autoTangents(s: NestedSpline): NestedSpline {
  const pts = s.points;
  const n = pts.length;
  const nested = pts.map((p) => typeof p.y !== 'number');
  const ds = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    if (nested[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && !nested[j + 1]) j++;
    if (j > i) {
      const run = pchipRun(pts.slice(i, j + 1).map((p) => p.x), pts.slice(i, j + 1).map((p) => p.y as number));
      for (let k = i; k <= j; k++) ds[k] = run[k - i]!;
    }
    i = j + 1;
  }
  const points: SplinePoint[] = pts.map((p, k) => {
    const zero = nested[k] || nested[k - 1] === true || nested[k + 1] === true
      || (k === 0 && p.x > -1) || (k === n - 1 && p.x < 1);
    const d = zero ? 0 : ds[k]!;
    return { x: p.x, y: typeof p.y === 'number' ? p.y : autoTangents(p.y), d: Q15(d) + 0 };
  });
  return { coord: s.coord, points };
}

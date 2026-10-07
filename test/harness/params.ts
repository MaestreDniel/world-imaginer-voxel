import { q15 } from '../../src/core/params/canonical';
import { AMPLITUDE_MIN, BOX_AXES, checkParams, type Group, type Interval, type Leaf, type Node, type Schema, NOISE_FIELD_RANGES } from '../../src/core/params/kit';
import { SPLINE_MAX_ABS_D, SPLINE_MAX_ABS_X, type NestedSpline } from '../../src/core/spline/types';
import { testFloat } from './stats';

const between = (next: () => number, lo: number, hi: number) => q15(lo + (hi - lo) * testFloat(next));

/**
 * n sorted, distinct knot xs within [−2, 2] (SP2b §6.1), one per equal cell of a span and never nearer than a
 * tenth of a cell: the whole [−2, 2] with the end knots exactly at ±2, the climate range [−1, 1], or a random
 * span of width 0.01·n to 4 (knots down to 0.001 apart).
 */
export function randomKnotXs(next: () => number, n: number): number[] {
  const X = SPLINE_MAX_ABS_X;
  const mode = next() % 3;
  const w = mode === 0 ? 2 * X : mode === 1 ? 2 : between(next, 0.01 * n, 2 * X);
  const lo = mode === 0 ? -X : mode === 1 ? -1 : between(next, -X, X - w);
  const xs = Array.from({ length: n }, (_, k) => q15(lo + (w * (k + 0.05 + 0.9 * testFloat(next))) / n));
  if (mode === 0) {
    if (n > 1) { xs[0] = -X; xs[n - 1] = X; } else xs[0] = (next() & 1) === 1 ? X : -X;
  }
  return xs;
}

/** A tangent within |d| ≤ 1e5 (SP2b §6.1): 0, a typical slope (|d| ≤ 100), any legal slope, or exactly ±1e5. */
export function randomTangent(next: () => number): number {
  const D = SPLINE_MAX_ABS_D;
  switch (next() % 4) {
    case 0: return 0;
    case 1: return between(next, -100, 100);
    case 2: return between(next, -D, D);
    default: return (next() & 1) === 1 ? D : -D;
  }
}

/** An explicit octave amplitude (SP2b §6.2): 0, exactly ±1e-6, a small legal magnitude in [1e-6, 1e-3), or any value in range; never 0 < |a| < 1e-6. */
export function randomAmplitude(next: () => number): number {
  const R = NOISE_FIELD_RANGES.amplitude;
  const sign = (next() & 1) === 1 ? 1 : -1;
  switch (next() % 5) {
    case 0: return 0;
    case 1: return sign * AMPLITUDE_MIN;
    case 2: return sign * q15(AMPLITUDE_MIN * (1 + 999 * testFloat(next)));
    default: {
      const a = between(next, R.min, R.max);
      return Math.abs(a) < AMPLITUDE_MIN ? 0 : a;
    }
  }
}

/** A box interval within [−1, 1]: the whole axis, a 2⁻¹⁰-wide sliver, or a random interval at least 0.05 wide. */
function randomInterval(next: () => number): Interval {
  switch (next() % 4) {
    case 0: return [-1, 1];
    case 1: {
      const lo = between(next, -1, 0.999);
      return [lo, q15(lo + 0.0009765625)];
    }
    default: {
      const lo = between(next, -1, 0.9);
      return [lo, q15(lo + 0.05 + (0.95 - lo) * testFloat(next))];
    }
  }
}

/** n distinct box priorities from 1..1000 (partial Fisher–Yates). */
function randomPriorities(next: () => number, n: number): number[] {
  const pool = Array.from({ length: 1000 }, (_, i) => i + 1);
  for (let i = 0; i < n; i++) {
    const j = i + (next() % (1000 - i));
    const t = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = t;
  }
  return pool.slice(0, n);
}

/** The default's coords, nesting and knot counts, with random knot x and d (SP2b §6.1 ranges) and y in [lo, hi]. */
function randomSplineLike(s: NestedSpline, next: () => number, lo: number, hi: number): NestedSpline {
  const xs = randomKnotXs(next, s.points.length);
  return {
    coord: s.coord,
    points: s.points.map((p, k) => ({
      x: xs[k]!,
      y: typeof p.y === 'number' ? between(next, lo, hi) : randomSplineLike(p.y, next, lo, hi),
      d: randomTangent(next),
    })),
  };
}

/** A random valid value for one leaf. */
export function randomValue(leaf: Leaf<unknown, unknown>, next: () => number): unknown {
  switch (leaf.kind) {
    case 'number': return between(next, leaf.min!, leaf.max!);
    case 'int': return leaf.min! + (next() % (leaf.max! - leaf.min! + 1));
    case 'bool': return (next() & 1) === 1;
    case 'enum': return leaf.options![next() % leaf.options!.length];
    case 'noise': {
      const R = NOISE_FIELD_RANGES;
      const octaves = 1 + (next() % 16);
      const double = (next() & 1) === 1;
      const amplitudes = (next() & 1) === 1 ? null : Array.from({ length: octaves }, () => randomAmplitude(next));
      if (amplitudes !== null && !amplitudes.some((a) => a !== 0)) amplitudes[next() % octaves] = 1;
      return {
        wavelength: between(next, leaf.min!, leaf.max!), octaves,
        persistence: between(next, R.persistence.min, R.persistence.max), lacunarity: between(next, R.lacunarity.min, R.lacunarity.max),
        amplitudes, yScale: leaf.dims === 2 ? 1 : between(next, R.yScale.min, R.yScale.max), double,
        // A remapNone leaf (SP3b's density noises) keeps 'none'; the draw is still made, so the stream is unchanged.
        remap: leaf.dims === 2 && double && (next() & 1) === 1 && leaf.remapNone !== true ? 'uniform' : 'none',
        clampSigma: between(next, R.clampSigma.min, R.clampSigma.max),
      };
    }
    case 'spline': return randomSplineLike(leaf.def as NestedSpline, next, Math.max(leaf.min!, -1000), Math.min(leaf.max!, 1000));
    case 'boxTable': {
      const table: Record<string, unknown> = {};
      const priorities = randomPriorities(next, leaf.options!.length);
      leaf.options!.forEach((name, i) => {
        const row: Record<string, unknown> = { wSign: (next() % 3) - 1, priority: priorities[i] };
        for (const a of BOX_AXES) row[a] = randomInterval(next);
        table[name] = row;
      });
      return table;
    }
    default: throw new Error(`no generator for ${leaf.kind}`);
  }
}

/** A random complete, validated params document. */
export function randomParams<R extends Group>(s: Schema<R>, next: () => number): Schema<R>['defaults'] {
  const walk = (n: Node): unknown => {
    if (n.tag === 'leaf') return randomValue(n, next);
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) o[k] = walk(n.children[k]!);
    return o;
  };
  const r = checkParams(s, walk(s.root));
  if (!r.ok) throw new Error(`randomParams produced an invalid document: ${JSON.stringify(r.issues)}`);
  return r.value;
}

/** A random valid patch: each leaf with probability ½; noise leaves get either a whole def or only a wavelength. */
export function randomPatch<R extends Group>(s: Schema<R>, next: () => number): Record<string, unknown> {
  const walk = (n: Node): unknown => {
    if (n.tag === 'leaf') {
      if ((next() & 1) === 0) return undefined;
      if (n.kind === 'noise' && (next() & 1) === 0) return { wavelength: between(next, n.min!, n.max!) };
      return randomValue(n, next);
    }
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(n.children)) {
      const v = walk(n.children[k]!);
      if (v !== undefined) o[k] = v;
    }
    return Object.keys(o).length > 0 ? o : undefined;
  };
  return (walk(s.root) ?? {}) as Record<string, unknown>;
}

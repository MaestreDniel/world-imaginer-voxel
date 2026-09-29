import { q15 } from '../../src/core/params/canonical';
import { BOX_AXES, checkParams, type Group, type Leaf, type Node, type Schema, NOISE_FIELD_RANGES } from '../../src/core/params/kit';
import type { NestedSpline } from '../../src/core/spline/types';
import { testFloat } from './stats';

const between = (next: () => number, lo: number, hi: number) => q15(lo + (hi - lo) * testFloat(next));

function randomSplineLike(s: NestedSpline, next: () => number, lo: number, hi: number): NestedSpline {
  return { coord: s.coord, points: s.points.map((p) => ({ ...p, y: typeof p.y === 'number' ? between(next, lo, hi) : randomSplineLike(p.y, next, lo, hi) })) };
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
      const amplitudes = (next() & 1) === 1 ? null : Array.from({ length: octaves }, (_, i) => (i === 0 ? 1 : between(next, R.amplitude.min, R.amplitude.max)));
      return {
        wavelength: between(next, leaf.min!, leaf.max!), octaves,
        persistence: between(next, R.persistence.min, R.persistence.max), lacunarity: between(next, R.lacunarity.min, R.lacunarity.max),
        amplitudes, yScale: leaf.dims === 2 ? 1 : between(next, R.yScale.min, R.yScale.max), double,
        remap: leaf.dims === 2 && double && (next() & 1) === 1 ? 'uniform' : 'none',
        clampSigma: between(next, R.clampSigma.min, R.clampSigma.max),
      };
    }
    case 'spline': return randomSplineLike(leaf.def as NestedSpline, next, Math.max(leaf.min!, -1000), Math.min(leaf.max!, 1000));
    case 'boxTable': {
      const table: Record<string, unknown> = {};
      leaf.options!.forEach((name, i) => {
        const row: Record<string, unknown> = { wSign: (next() % 3) - 1, priority: i + 1 };
        for (const a of BOX_AXES) {
          const lo = between(next, -1, 0.9);
          row[a] = [lo, q15(lo + 0.05 + (0.95 - lo) * testFloat(next))];
        }
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

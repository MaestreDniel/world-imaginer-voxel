import { describe, expect, test } from 'vitest';
import { compileSpline, evalSpline, evalSplineRef, withKnotY } from '../../src/core/spline/hermite';
import { autoTangents } from '../../src/core/spline/tangents';
import { SPLINE_SLOT, type NestedSpline } from '../../src/core/spline/types';
import { ADVERSARIAL_DEFS, CLIMATE_FIXTURE_DEFS, DENSITY3D_DEF, JAG, OFFSET, SIGMA, TANGENT_FIXTURE } from '../../src/metrics/sp1Fixtures';
import { nextDown, nextUp, testFloat, testRng } from '../harness/stats';

const FIXTURES: Array<[string, NestedSpline]> = [['OFFSET', OFFSET], ['SIGMA', SIGMA], ['JAG', JAG], ['TANGENT_FIXTURE', TANGENT_FIXTURE]];

interface NodeCtx { readonly node: NestedSpline; readonly depth: number; readonly constraints: ReadonlyArray<{ slot: number; lo: number; hi: number }> }

function collectNodes(s: NestedSpline, depth = 0, constraints: NodeCtx['constraints'] = []): NodeCtx[] {
  const out: NodeCtx[] = [{ node: s, depth, constraints }];
  const n = s.points.length;
  s.points.forEach((p, i) => {
    if (typeof p.y === 'number') return;
    const lo = i > 0 ? s.points[i - 1]!.x : -1.25;
    const hi = i < n - 1 ? s.points[i + 1]!.x : 1.25;
    out.push(...collectNodes(p.y, depth + 1, [...constraints, { slot: SPLINE_SLOT[s.coord], lo, hi }]));
  });
  return out;
}

/** A coordinate vector that makes `ctx.node` matter: every enclosing coordinate inside its bracket. */
function reachable(ctx: NodeCtx, next: () => number): Float64Array {
  const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
  for (const k of ctx.constraints) c[k.slot] = k.lo + (k.hi - k.lo) * (0.05 + 0.9 * testFloat(next));
  return c;
}

describe('spline test 4: C0 at every knot of every node', () => {
  test.each(FIXTURES)('%s', (_name, s) => {
    const p = compileSpline(s);
    const next = testRng(121);
    let worst = 0;
    for (const ctx of collectNodes(s)) {
      const slot = SPLINE_SLOT[ctx.node.coord];
      for (const k of ctx.node.points) {
        for (let r = 0; r < 200; r++) {
          const c = reachable(ctx, next);
          c[slot] = k.x;
          const f = evalSpline(p, c);
          c[slot] = nextUp(k.x);
          const up = evalSpline(p, c);
          c[slot] = nextDown(k.x);
          const down = evalSpline(p, c);
          worst = Math.max(worst, Math.abs(up - f), Math.abs(down - f));
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });
});

/** Second-order one-sided differences along `slot` at c[slot] = x. */
function oneSided(p: ReturnType<typeof compileSpline>, c: Float64Array, slot: number, x: number, f: typeof evalSpline): [number, number] {
  const h = 1e-5;
  const at = (q: number) => { c[slot] = q; return f(p, c); };
  const f0 = at(x);
  const plus = (-3 * f0 + 4 * at(x + h) - at(x + 2 * h)) / (2 * h);
  const minus = (3 * f0 - 4 * at(x - h) + at(x - 2 * h)) / (2 * h);
  return [plus, minus];
}

describe('spline test 5: C1 at interior knots', () => {
  test.each(FIXTURES)('%s', (_name, s) => {
    const p = compileSpline(s);
    const next = testRng(122);
    for (const ctx of collectNodes(s)) {
      const slot = SPLINE_SLOT[ctx.node.coord];
      const pts = ctx.node.points;
      for (let j = 1; j < pts.length - 1; j++) {
        for (let r = 0; r < 200; r++) {
          const c = reachable(ctx, next);
          const [dp, dm] = oneSided(p, c, slot, pts[j]!.x, evalSpline);
          expect(Math.abs(dp - dm)).toBeLessThanOrEqual(1e-3 * Math.max(1, Math.abs(dp)));
          if (ctx.depth === 0) expect(Math.abs(dp - pts[j]!.d)).toBeLessThanOrEqual(1e-3 * Math.max(1, Math.abs(pts[j]!.d)));
        }
      }
    }
  });
  test('TANGENT_FIXTURE catches the "tangent not multiplied by h" mutant', () => {
    const mutant = (s: NestedSpline, c: Float64Array): number => {
      const q = c[SPLINE_SLOT[s.coord]]!;
      const pts = s.points;
      const val = (y: number | NestedSpline) => (typeof y === 'number' ? y : mutant(y, c));
      if (q <= pts[0]!.x) return val(pts[0]!.y);
      if (q >= pts[pts.length - 1]!.x) return val(pts[pts.length - 1]!.y);
      let i = 0;
      while (q >= pts[i + 1]!.x) i++;
      const a = pts[i]!, b = pts[i + 1]!, y0 = val(a.y), dy = val(b.y) - y0, t = (q - a.x) / (b.x - a.x);
      return y0 + t * dy + t * (1 - t) * ((1 - t) * (a.d - dy) + t * (dy - b.d));
    };
    const next = testRng(123);
    let worst = 0;
    for (const ctx of collectNodes(TANGENT_FIXTURE)) {
      const slot = SPLINE_SLOT[ctx.node.coord];
      for (let j = 1; j < ctx.node.points.length - 1; j++) {
        for (let r = 0; r < 20; r++) {
          const c = reachable(ctx, next);
          const [dp, dm] = oneSided(null as never, c, slot, ctx.node.points[j]!.x, (_p, cc) => mutant(TANGENT_FIXTURE, cc));
          worst = Math.max(worst, Math.abs(dp - dm) / Math.max(1, Math.abs(dp)));
        }
      }
    }
    expect(worst).toBeGreaterThan(0.1);
  });
});

test('spline test 6 on the fixtures: compiled equals the reference on 1M points', () => {
  const next = testRng(124);
  let bad = 0;
  for (const [, s] of FIXTURES) {
    const p = compileSpline(s);
    for (let i = 0; i < 250000; i++) {
      const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
      if (!Object.is(evalSpline(p, c), evalSplineRef(s, c))) bad++;
    }
  }
  expect(bad).toBe(0);
});

/** Product of Hermite value-basis weights of the knot along `path` (tangents fixed). */
function pathWeight(s: NestedSpline, path: readonly number[], c: Float64Array): number {
  const [k, ...rest] = path;
  const xs = s.points.map((p) => p.x);
  const n = xs.length;
  const q = c[SPLINE_SLOT[s.coord]]!;
  let w: number;
  if (q <= xs[0]!) w = k === 0 ? 1 : 0;
  else if (q >= xs[n - 1]!) w = k === n - 1 ? 1 : 0;
  else {
    let i = 0;
    while (q >= xs[i + 1]!) i++;
    const t = (q - xs[i]!) / (xs[i + 1]! - xs[i]!);
    w = k === i ? 2 * t ** 3 - 3 * t ** 2 + 1 : k === i + 1 ? -2 * t ** 3 + 3 * t ** 2 : 0;
  }
  if (rest.length === 0 || w === 0) return w;
  return w * pathWeight(s.points[k!]!.y as NestedSpline, rest, c);
}

describe('spline test 8: knot-raise linearity', () => {
  test.each([[[2]], [[5, 1]], [[7, 1, 1]]] as const)('OFFSET knot %j', (path) => {
    const base = compileSpline(OFFSET);
    const raised = compileSpline(withKnotY(OFFSET, path, (() => {
      let node: NestedSpline = OFFSET;
      for (let i = 0; i < path.length - 1; i++) node = node.points[path[i]!]!.y as NestedSpline;
      return (node.points[path[path.length - 1]!]!.y as number) + 10;
    })()));
    const next = testRng(125);
    let hits = 0;
    for (let i = 0; i < 100000; i++) {
      const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
      const delta = evalSpline(raised, c) - evalSpline(base, c);
      const w = pathWeight(OFFSET, path, c);
      expect(w >= 0 && w <= 1).toBe(true);
      if (w === 0) expect(delta).toBe(0);
      else { hits++; expect(Math.abs(delta - 10 * w)).toBeLessThanOrEqual(1e-12); }
    }
    expect(hits).toBeGreaterThan(0);
  });
  test('raising every leaf by 10 shifts the spline by 10', () => {
    const lift = (s: NestedSpline): NestedSpline => ({ coord: s.coord, points: s.points.map((p) => ({ ...p, y: typeof p.y === 'number' ? p.y + 10 : lift(p.y) })) });
    const a = compileSpline(OFFSET);
    const b = compileSpline(lift(OFFSET));
    const next = testRng(126);
    for (let i = 0; i < 20000; i++) {
      const c = Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));
      expect(Math.abs(evalSpline(b, c) - evalSpline(a, c) - 10)).toBeLessThanOrEqual(1e-12);
    }
  });
});

describe('spline test 12: autoTangents', () => {
  test('offset top-level tangents', () => {
    expect(OFFSET.points.map((p) => Math.round(p.d * 1000) / 1000)).toEqual([0, 38.889, 72.506, 87.097, 0, 0, 0, 0, 0]);
  });
  test('d = 0 exactly where the hybrid rule requires it', () => {
    for (const [, s] of [['OFFSET', OFFSET], ['SIGMA', SIGMA], ['JAG', JAG]] as const) {
      for (const { node } of collectNodes(s)) {
        const pts = node.points;
        const nested = pts.map((p) => typeof p.y !== 'number');
        pts.forEach((p, i) => {
          const single = !nested[i] && (i === 0 || nested[i - 1]) && (i === pts.length - 1 || nested[i + 1]);
          const mustBeZero = nested[i] || nested[i - 1] === true || nested[i + 1] === true || single
            || (i === 0 && p.x > -1) || (i === pts.length - 1 && p.x < 1);
          if (mustBeZero) expect(Object.is(p.d, 0)).toBe(true);
        });
      }
    }
  });
  test('no segment leaves its hull by more than 4 ulp (uniform-random and near-knot coordinates)', () => {
    const TOL = 4 * 2 ** -52;
    let worst = 0;
    const check = (s: NestedSpline, c: Float64Array): number => {
      const q = c[SPLINE_SLOT[s.coord]]!;
      const pts = s.points;
      const val = (y: number | NestedSpline) => (typeof y === 'number' ? y : check(y, c));
      if (q <= pts[0]!.x) return val(pts[0]!.y);
      if (q >= pts[pts.length - 1]!.x) return val(pts[pts.length - 1]!.y);
      let i = 0;
      while (q >= pts[i + 1]!.x) i++;
      const a = pts[i]!, b = pts[i + 1]!, y0 = val(a.y), y1 = val(b.y);
      const h = b.x - a.x, t = (q - a.x) / h, dy = y1 - y0;
      const f = y0 + t * dy + t * (1 - t) * ((1 - t) * (a.d * h - dy) + t * (dy - b.d * h));
      const m = Math.max(Math.abs(y0), Math.abs(y1));
      const excess = Math.max(Math.min(y0, y1) - f, f - Math.max(y0, y1), 0);
      worst = Math.max(worst, m === 0 ? (excess > 0 ? Infinity : 0) : excess / (m * TOL));
      return f;
    };
    const next = testRng(127);
    for (const s of [OFFSET, SIGMA, JAG]) {
      for (let i = 0; i < 100000; i++) check(s, Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next)));
      for (const ctx of collectNodes(s)) {
        const slot = SPLINE_SLOT[ctx.node.coord];
        for (const k of ctx.node.points) {
          for (let r = 0; r < 50; r++) {
            const c = reachable(ctx, next);
            let up = k.x;
            let down = k.x;
            for (let step = 0; step < 5; step++) {
              up = nextUp(up);
              down = nextDown(down);
              c[slot] = up; check(s, c);
              c[slot] = down; check(s, c);
            }
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  test('autoTangents is idempotent and leaves x and y untouched', () => {
    expect(autoTangents(OFFSET)).toEqual(OFFSET);
    const strip = (s: NestedSpline): unknown => s.points.map((p) => [p.x, typeof p.y === 'number' ? p.y : strip(p.y)]);
    expect(strip(autoTangents(TANGENT_FIXTURE))).toEqual(strip(TANGENT_FIXTURE));
  });
});

test('noise fixture defs', () => {
  expect(CLIMATE_FIXTURE_DEFS.map((f) => f.seedName)).toEqual([
    'climate.warp.shift.noise.x', 'climate.warp.shift.noise.z', 'climate.warp.C.noise.x', 'climate.warp.C.noise.z',
    'climate.warp.R.noise.x', 'climate.warp.R.noise.z', 'climate.C', 'climate.E', 'climate.W', 'climate.T', 'climate.H', 'climate.R',
  ]);
  expect(CLIMATE_FIXTURE_DEFS.every((f) => f.dims === 2 && !f.corners)).toBe(true);
  expect(DENSITY3D_DEF).toMatchObject({ seedName: 'test.density3d', dims: 3, def: { wavelength: 64, octaves: 4, double: true } });
  expect(ADVERSARIAL_DEFS.map((f) => [f.seedName, f.dims, f.def.wavelength, f.def.octaves, f.def.double, f.corners])).toEqual([
    ['test.adv2d16', 2, 16, 1, false, false], ['test.adv3d8', 3, 8, 1, false, false], ['test.adv3d32', 3, 32, 1, false, true],
  ]);
});

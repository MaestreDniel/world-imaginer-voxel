/**
 * The SP6a goldens (SP6a spec §12.3, D28): `sp6a.density.ops`, chained last into `allGoldenKeys` (push B appends
 * `sp6a.carver.paths` and `sp6a.region.T.caves`). Its fixture is a density source tree that uses `noiseScaled` (D18,
 * §1.5) inside and outside `interpolated`, with literal scales and a `{param}` scale; the values are the compiled
 * corners and voxels of column (0, 0), equal to the reference, and the key matches `test/goldens.json`.
 */
import { describe, expect, test } from 'vitest';
import { hashF64, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { densityNoiseSource } from '../../src/gen/density/context';
import { exprChildren, validateExpr, type Expr } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { validateDensitySource } from '../../src/gen/density/source';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import {
  computeSp6aGolden, densityScaledExpr, densityScaledPoints, densityScaledSource, densityScaledValues, sp6aGoldenKeys,
} from '../../src/metrics/sp6aGoldens';
import { expectGolden } from '../harness/goldens';

const CTX = createGenContext(seedFromInput('42'), resolveProfile('default'));
const CORNERS = 1225;

/** Every node reachable from the root and the defs, with its inside-`interpolated` flag. */
function nodesOf(root: Expr): Array<{ readonly node: Expr; readonly inside: boolean }> {
  const out: Array<{ node: Expr; inside: boolean }> = [];
  const walk = (n: Expr, inside: boolean): void => {
    out.push({ node: n, inside });
    for (const c of exprChildren(n)) walk(c, inside || n.op === 'interpolated');
  };
  walk(root, false);
  return out;
}

test('1 SP6a key, chained last into allGoldenKeys after SP3e\'s: 60 goldens', () => {
  expect(sp6aGoldenKeys()).toEqual(['sp6a.density.ops']);
  expect(allGoldenKeys().slice(-1)).toEqual(['sp6a.density.ops']);
  expect(allGoldenKeys().slice(-2, -1)).toEqual(['sp3e.column.point.floating_islands']);
  expect(allGoldenKeys()).toHaveLength(60);
  expect(new Set(allGoldenKeys()).size).toBe(60);
  for (const bad of ['sp6a.density', 'sp6a.density.ops.x', 'sp6a.carver.paths', 'sp6a.region.T.caves', 'sp6a.nope']) {
    expect(() => computeSp6aGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp6a.density.ops (§12.3)', () => {
  test('the fixture uses noiseScaled inside and outside interpolated, with literal and {param} scales, and validates', () => {
    const source = densityScaledSource();
    expect(validateDensitySource(source)).toEqual([]);
    const text = JSON.stringify(source);
    expect(text).toContain('"s":{"param":"density.noises.detail.clampSigma"}');
    expect(text).toMatch(/"s":0\.75\b/);
    const e = densityScaledExpr();
    expect(validateExpr(e, densityNoiseSource(CTX))).toEqual([]);
    const scaled = nodesOf(e.root).filter((n) => n.node.op === 'noiseScaled');
    expect(scaled.some((n) => n.inside)).toBe(true);
    expect(scaled.some((n) => !n.inside)).toBe(true);
    // The {param} scale is written as the default profile's value.
    const sc = CTX.params.density.noises.detail.clampSigma;
    expect(scaled.filter((n) => (n.node as { s: number }).s === sc).length).toBe(2);
    expect(interpolatedNodes(e)).toHaveLength(1);
  });

  test('the values are column (0, 0)\'s compiled corners and the voxels at 32 points, equal to the reference; the key hashes them', () => {
    const e = densityScaledExpr();
    const r = createDensityReference(e, densityNoiseSource(CTX));
    const inner = interpolatedNodes(e)[0]!.x;
    const points = densityScaledPoints();
    expect(points).toHaveLength(32);
    for (const [x, , z] of points) expect([x >> 4, z >> 4]).toEqual([0, 0]);
    const values = densityScaledValues();
    expect(values.length).toBe(CORNERS + 32);
    const s = buildColumnSample(CTX, 0, 0, newColumnSample());
    const bad: string[] = [];
    for (let idx = 0; idx < CORNERS; idx++) {
      const i = idx % 5, k = Math.floor(idx / 25), j = Math.floor(idx / 5) % 5;
      const want = r.corner(s, inner, i, k, j);
      if (!Object.is(values[idx], want)) bad.push(`corner (${i}, ${k}, ${j}): ${values[idx]} ≠ ${want}`);
    }
    points.forEach(([x, y, z], p) => {
      const want = r.voxel(s, x, y, z);
      if (!Object.is(values[CORNERS + p], want)) bad.push(`voxel (${x}, ${y}, ${z}): ${values[CORNERS + p]} ≠ ${want}`);
    });
    expect(bad).toEqual([]);
    expect(computeSp6aGolden('sp6a.density.ops')).toBe(hex64(hashF64(values)));
    expect(computeAnyGolden('sp6a.density.ops')).toBe(computeSp6aGolden('sp6a.density.ops'));
  });
});

describe('SP6a goldens', () => {
  test.each(sp6aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp6aGolden(key));
  }, 60_000);
});

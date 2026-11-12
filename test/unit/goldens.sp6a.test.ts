/**
 * The SP6a goldens (SP6a spec §12.3, D28): `sp6a.density.ops`, `sp6a.carver.paths` (push B, Task 27) and
 * `sp6a.region.T.caves` (push B, Task 39), chained into `allGoldenKeys` before SP6b's. `sp6a.density.ops`' fixture is a density source tree
 * that uses `noiseScaled` (D18, §1.5) inside and outside `interpolated`, with literal scales and a `{param}` scale; the
 * values are the compiled corners and voxels of column (0, 0), equal to the reference. `sp6a.carver.paths` digests the
 * paths of 64 fixed sources per kind at seed 42 and the defaults (the first 64 per kind whose roll passes, in a spiral
 * from (0, 0)). `sp6a.region.T.caves` digests the 8 × 8 window at seed 42 that the scan found holding a voxel of every
 * kind 1-8 (§10.8): the first of the scan's candidates, so the test re-runs the scan by checking that one. The three
 * keys match `test/goldens.json`.
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
  CAVES_WINDOW, carverGoldenPaths, carverPathsValues, cavesWindowCandidates, cavesWindowStore, computeSp6aGolden,
  densityScaledExpr, densityScaledPoints, densityScaledSource, densityScaledValues, sp6aGoldenKeys,
} from '../../src/metrics/sp6aGoldens';
import { regionHash } from '../../src/metrics/region';
import { CAVE_KIND, caveKindOf } from '../../src/core/constants';
import { DEFAULTS } from '../../src/core/params/defaults';
import { carverParamsOf, carverPath } from '../../src/gen/caves/carvers';
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

test('3 SP6a keys, chained into allGoldenKeys after SP3e\'s (SP6b\'s 1 follows): 63 goldens', () => {
  const keys = ['sp6a.density.ops', 'sp6a.carver.paths', 'sp6a.region.T.caves'];
  expect(sp6aGoldenKeys()).toEqual(keys);
  expect(allGoldenKeys().slice(-4, -1)).toEqual(keys);
  expect(allGoldenKeys().slice(-5, -4)).toEqual(['sp3e.column.point.floating_islands']);
  expect(allGoldenKeys()).toHaveLength(63);
  expect(new Set(allGoldenKeys()).size).toBe(63);
  for (const bad of [
    'sp6a.density', 'sp6a.density.ops.x', 'sp6a.carver', 'sp6a.carver.paths.x', 'sp6a.region.T', 'sp6a.region.T.caves.x',
    'sp6a.region.T.default', 'sp6a.nope',
  ]) {
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

describe('sp6a.carver.paths (§12.3; spec §2.1-§2.3)', () => {
  /** The chunks of a square spiral from (0, 0), as the golden's comment states. */
  function* spiral(): Generator<[number, number]> {
    yield [0, 0];
    for (let r = 1; ; r++) {
      for (let i = -r; i <= r; i++) yield [i, -r];
      for (let j = 1 - r; j <= r; j++) yield [r, j];
      for (let i = r - 1; i >= -r; i--) yield [i, r];
      for (let j = r - 1; j > -r; j--) yield [-r, j];
    }
  }

  test('64 fixed sources per kind: the first 64 whose roll passes in a spiral from (0, 0), seed 42, the default carver leaves', () => {
    const p = carverParamsOf(DEFAULTS);
    for (const kind of ['worm', 'ravine', 'undergroundWorm'] as const) {
      const want: Array<[number, number]> = [];
      for (const [sx, sz] of spiral()) {
        if (carverPath(CTX.seed, kind, sx, sz, p) !== null) want.push([sx, sz]);
        if (want.length === 64) break;
      }
      const got = carverGoldenPaths(kind);
      expect(got.map((q) => [q.sx, q.sz])).toEqual(want);
      for (const q of got) expect(q.kind).toBe(kind);
      // The paths are carverPath's, bit for bit.
      for (const q of got) expect(q).toEqual(carverPath(CTX.seed, kind, q.sx, q.sz, p));
    }
  });

  test('the values: per kind, per path, sx, sz, count, box, ellipsoids and (ravines) f²; the key hashes them', () => {
    const v = carverPathsValues();
    let n = 0;
    for (const kind of ['worm', 'ravine', 'undergroundWorm'] as const) {
      for (const q of carverGoldenPaths(kind)) {
        expect([v[n], v[n + 1], v[n + 2]]).toEqual([q.sx, q.sz, q.count]);
        expect(Array.from(v.subarray(n + 3, n + 9))).toEqual(Array.from(q.box));
        expect(Array.from(v.subarray(n + 9, n + 9 + 6 * q.count))).toEqual(Array.from(q.ell));
        n += 9 + 6 * q.count;
        if (q.widthSq !== null) {
          expect(Array.from(v.subarray(n, n + 384))).toEqual(Array.from(q.widthSq));
          n += 384;
        }
      }
    }
    expect(v.length).toBe(n);
    expect(computeSp6aGolden('sp6a.carver.paths')).toBe(hex64(hashF64(v)));
    expect(computeAnyGolden('sp6a.carver.paths')).toBe(computeSp6aGolden('sp6a.carver.paths'));
  });
});

describe('sp6a.region.T.caves (§12.3, §10.8)', () => {
  test('the scan\'s candidates: the 8 × 8 tiles of the default quick regions (-16, -16) and (16, -16), z rows then x', () => {
    const want: Array<[number, number]> = [];
    for (const rx of [-16, 16]) {
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) want.push([rx + 8 * i, -16 + 8 * j]);
    }
    expect(cavesWindowCandidates()).toEqual(want);
    expect(cavesWindowCandidates()[0]).toEqual(CAVES_WINDOW);
  });

  test('the window is the scan\'s first candidate and holds a voxel of each kind 1-8; the key is its regionHash', () => {
    const [cx0, cz0] = CAVES_WINDOW;
    const store = cavesWindowStore();
    const counts = new Array<number>(16).fill(0);
    for (let cz = cz0; cz < cz0 + 8; cz++) {
      for (let cx = cx0; cx < cx0 + 8; cx++) {
        const v = store.proto(cx, cz);
        expect(v, `column (${cx}, ${cz}) has a proto set`).not.toBeNull();
        for (let sy = 0; sy < 24; sy++) {
          const c = v!.sectionCave(sy);
          if (typeof c === 'number') counts[caveKindOf(c)]! += 4096;
          else for (let i = 0; i < 4096; i++) counts[caveKindOf(c[i]!)]!++;
        }
      }
    }
    const kinds = [
      CAVE_KIND.cheese, CAVE_KIND.spaghetti3d, CAVE_KIND.spaghetti2d, CAVE_KIND.noodle, CAVE_KIND.entrance, CAVE_KIND.worm,
      CAVE_KIND.ravine, CAVE_KIND.undergroundWorm,
    ];
    expect(kinds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(kinds.filter((k) => counts[k]! === 0)).toEqual([]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(64 * 384 * 256);
    expect(computeSp6aGolden('sp6a.region.T.caves')).toBe(hex64(regionHash(store, cx0, cz0, 8, 8)));
    expect(computeAnyGolden('sp6a.region.T.caves')).toBe(computeSp6aGolden('sp6a.region.T.caves'));
  }, 120_000);
});

describe('SP6a goldens', () => {
  test.each(sp6aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp6aGolden(key));
  }, 60_000);
});

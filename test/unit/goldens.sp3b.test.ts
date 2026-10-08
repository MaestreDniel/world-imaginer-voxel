import { describe, expect, test } from 'vitest';
import { hashF64, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { densityNoiseSource } from '../../src/gen/density/context';
import { defaultDensityExpr } from '../../src/gen/density/defaults';
import { EXPR_OPS, validateExpr, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { terrainDensityDebug } from '../../src/gen/pipeline/terrainStage';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import {
  computeSp3bGolden, densityDefaultValues, densityOpsExpr, densityOpsPoints, densityOpsValues, sp3bGoldenKeys,
} from '../../src/metrics/sp3bGoldens';
import { expectGolden } from '../harness/goldens';
import { testRng } from '../harness/stats';

const CTX = createGenContext(seedFromInput('42'), resolveProfile('default'));
const CORNERS = 1225;

function opsOf(e: DensityExpr): Set<string> {
  const seen = new Set<string>();
  const walk = (n: Expr): void => {
    seen.add(n.op);
    for (const k of ['a', 'b', 'x', 'inside', 'outside'] as const) {
      const c = (n as unknown as Record<string, Expr | undefined>)[k];
      if (c !== undefined && typeof c === 'object') walk(c);
    }
  };
  walk(e.root);
  for (const d of Object.values(e.defs)) walk(d);
  return seen;
}

/** Corner (i, k, j) of value index `idx` in a column's 1225 corner values: i fastest, then j, then k. */
const cornerOf = (idx: number): [number, number, number] => [idx % 5, Math.floor(idx / 25), Math.floor(idx / 5) % 5];

test('2 unique SP3b keys, chained into allGoldenKeys after SP3a\'s (SP3c\'s 2 follow)', () => {
  const keys = sp3bGoldenKeys();
  expect(keys).toEqual(['sp3b.density.ops', 'sp3b.density.default']);
  expect(sp3bGoldenKeys().length).toBe(2);
  expect(allGoldenKeys().slice(-4, -2)).toEqual(keys);
  expect(allGoldenKeys().slice(-7, -4)).toEqual(['sp3a.registry', 'sp3a.region.T.default', 'sp3a.region.T.large_biomes']);
  expect(new Set(allGoldenKeys()).size).toBe(allGoldenKeys().length);
  for (const bad of ['sp3b.density', 'sp3b.density.ops.x', 'sp3b.density.large_biomes', 'sp3b.registry', 'sp3b.nope']) {
    expect(() => computeSp3bGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp3b.density.ops (§9)', () => {
  test('the fixture uses every op, with the schema noise ids, and validates', () => {
    const e = densityOpsExpr();
    expect([...opsOf(e)].sort()).toEqual([...EXPR_OPS].sort());
    expect(validateExpr(e, densityNoiseSource(CTX))).toEqual([]);
    expect(interpolatedNodes(e)).toHaveLength(1);
  });

  test('the values are the compiled corners and voxels, equal to the reference (Object.is), and the key hashes them', () => {
    const e = densityOpsExpr();
    const r = createDensityReference(e, densityNoiseSource(CTX));
    const inner = interpolatedNodes(e)[0]!.x;
    const points = densityOpsPoints();
    const values = densityOpsValues();
    const columns = [...new Set(points.map(([x, , z]) => `${x >> 4},${z >> 4}`))];
    const perColumn = points.length / columns.length;
    expect(columns.length).toBeGreaterThanOrEqual(4);
    expect(values.length).toBe(columns.length * (CORNERS + perColumn));
    const bad: string[] = [];
    columns.forEach((key, n) => {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      const s = buildColumnSample(CTX, cx, cz, newColumnSample());
      const base = n * (CORNERS + perColumn);
      for (let idx = 0; idx < CORNERS; idx++) {
        const [i, k, j] = cornerOf(idx);
        const want = r.corner(s, inner, i, k, j);
        if (!Object.is(values[base + idx], want)) bad.push(`(${cx}, ${cz}) corner (${i}, ${k}, ${j}): ${values[base + idx]} ≠ ${want}`);
      }
      points.slice(n * perColumn, (n + 1) * perColumn).forEach(([x, y, z], p) => {
        expect(`${x >> 4},${z >> 4}`).toBe(key);
        const want = r.voxel(s, x, y, z);
        if (!Object.is(values[base + CORNERS + p], want)) bad.push(`(${x}, ${y}, ${z}): ${values[base + CORNERS + p]} ≠ ${want}`);
      });
    });
    expect(bad.slice(0, 10)).toEqual([]);
    // Both branches of the rangeChoice and both signs occur among the voxels.
    const voxels = points.map((_p, i) => values[Math.floor(i / perColumn) * (CORNERS + perColumn) + CORNERS + (i % perColumn)]!);
    expect(voxels.some((v) => v > 0) && voxels.some((v) => v < 0)).toBe(true);
    expect(computeSp3bGolden('sp3b.density.ops')).toBe(hex64(hashF64(values)));
  });
});

describe('sp3b.density.default (§9)', () => {
  const values = densityDefaultValues();

  test('1225 corners then 98,304 voxels of column (0, 0), seed 42, default profile; the key hashes them', () => {
    expect(values.length).toBe(CORNERS + 98304);
    expect(computeSp3bGolden('sp3b.density.default')).toBe(hex64(hashF64(values)));
    expect(computeAnyGolden('sp3b.density.default')).toBe(computeSp3bGolden('sp3b.density.default'));
  });

  test('corners and sampled voxels equal the reference (Object.is); the bulk agrees where it evaluated', () => {
    const e = defaultDensityExpr(CTX.params.density);
    const r = createDensityReference(e, densityNoiseSource(CTX));
    const inner = interpolatedNodes(e)[0]!.x;
    const s = buildColumnSample(CTX, 0, 0, newColumnSample());
    const bad: string[] = [];
    for (let idx = 0; idx < CORNERS; idx++) {
      const [i, k, j] = cornerOf(idx);
      if (!Object.is(values[idx], r.corner(s, inner, i, k, j))) bad.push(`corner (${i}, ${k}, ${j})`);
    }
    const rng = testRng(909);
    for (let n = 0; n < 1500; n++) {
      const idx = rng() % 98304;
      const lx = idx & 15, lz = (idx >> 4) & 15, y = (idx >> 8) - 64;
      if (!Object.is(values[CORNERS + idx], r.voxel(s, lx, y, lz))) bad.push(`voxel (${lx}, ${y}, ${lz})`);
    }
    const out = new Float64Array(98304);
    const mask = new Uint8Array(98304);
    terrainDensityDebug(CTX, 0, 0, out, mask);
    let masked = 0;
    for (let idx = 0; idx < 98304; idx++) {
      if (mask[idx] === 0) continue;
      masked++;
      if (!Object.is(values[CORNERS + idx], out[idx])) bad.push(`bulk voxel ${idx}`);
    }
    expect(masked).toBeGreaterThan(0);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('SP3b goldens', () => {
  test.each(sp3bGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp3bGolden(key));
  }, 60_000);
});

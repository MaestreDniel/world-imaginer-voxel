import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { columnPoint } from '../../src/gen/column/columnPoint';
import {
  buildColumnSample, buildCornerSample, gorgeAt, latticeIndex, LEVEL_FIELDS, newColumnSample, riverWetAt, SAMPLE_FIELDS,
  type ColumnSample, type SampleField,
} from '../../src/gen/column/columnStage';
import type { DensityExpr, Expr } from '../../src/gen/density/expr';
import { createDensityReference, type DensityReference } from '../../src/gen/density/reference';
import {
  colFieldsRead, CORNER_FALLBACK_FIELDS, createCornerSampler, horizontalCoord, horizontalSampling, readsSteep,
} from '../../src/gen/inspect/fieldSlice';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { ctxFor } from '../harness/gen';
import { legacyDefaultDensityExpr } from '../harness/legacyTrees';
import { testRng } from '../harness/stats';

const ALL_FIELDS = [...SAMPLE_FIELDS, ...LEVEL_FIELDS] as const;
const col = (field: SampleField): Expr => ({ op: 'col', field });
const NO_NOISES = () => undefined;

/** Per field: the reference over `col f` (voxel placement, readField) and over `interpolated(col f)` (corner placement). */
const REFS: ReadonlyArray<readonly [SampleField, DensityReference, DensityReference]> = SAMPLE_FIELDS.map((f) => [
  f,
  createDensityReference({ root: col(f), defs: {} }, NO_NOISES),
  createDensityReference({ root: { op: 'interpolated', x: col(f) }, defs: {} }, NO_NOISES),
] as const);

/** 4,096 random voxels over the window: 256 random columns × 16 random voxels each (the full sample built once per column). */
function voxels(seed: number): Array<{ cx: number; cz: number; vs: Array<readonly [number, number, number]> }> {
  const next = testRng(seed);
  return Array.from({ length: 256 }, () => {
    const cx = (next() % 65536) - 32768;
    const cz = (next() % 65536) - 32768;
    const vs = Array.from({ length: 16 }, () => [16 * cx + (next() % 16), (next() % 384) - 64, 16 * cz + (next() % 16)] as const);
    return { cx, cz, vs };
  });
}

/** The quart corners (lattice i, j ∈ 0 … 4) the voxel at (x, z) reads: its cell's four. */
const cornersOf = (x: number, z: number): number[] => {
  const ci = (x & 15) >> 2;
  const cj = (z & 15) >> 2;
  return [latticeIndex(ci, cj), latticeIndex(ci + 1, cj), latticeIndex(ci, cj + 1), latticeIndex(ci + 1, cj + 1)];
};

describe('buildCornerSample (SP3d spec §4.4)', () => {
  const ctx = ctxFor('42');
  const cases = voxels(4411);

  test.each([[true], [false]])('withSteep %s: at 4,096 random voxels the reference reads equal the full sample\'s, except CORNER_FALLBACK_FIELDS', (withSteep) => {
    const full = newColumnSample();
    const corner = newColumnSample();
    const mismatched = new Set<string>();
    let compared = 0;
    for (const { cx, cz, vs } of cases) {
      buildColumnSample(ctx, cx, cz, full);
      for (const [x, y, z] of vs) {
        buildCornerSample(ctx, x, z, withSteep, corner);
        expect([corner.cx, corner.cz]).toEqual([cx, cz]);
        for (const [f, outside, inside] of REFS) {
          compared++;
          const a = outside.voxel(corner, x, y, z);
          const b = inside.voxel(corner, x, y, z);
          if (!withSteep && f === 'steep') {
            // Sampled without steep, the corners hold NaN: an expression that reads steep must take withSteep.
            expect(Number.isNaN(a) && Number.isNaN(b)).toBe(true);
            continue;
          }
          if (!Object.is(a, outside.voxel(full, x, y, z)) || !Object.is(b, inside.voxel(full, x, y, z))) mismatched.add(f);
        }
      }
    }
    expect(compared).toBe(4096 * SAMPLE_FIELDS.length);
    // The corner-vs-full rule: a field whose corner reads differ is read from a full ColumnSample instead.
    expect([...mismatched].sort()).toEqual([...CORNER_FALLBACK_FIELDS].sort());
  }, 60_000);

  test('the four corners hold the point values bit for bit (every field, flags, biome); every other entry is NaN or 0', () => {
    const s = newColumnSample();
    for (const { vs } of cases.slice(0, 16)) {
      for (const [x, , z] of vs) {
        buildCornerSample(ctx, x, z, true, s);
        const own = cornersOf(x, z);
        for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) {
          const k = latticeIndex(i, j);
          if (own.includes(k)) {
            const p = columnPoint(ctx, 16 * s.cx + 4 * i, 16 * s.cz + 4 * j);
            for (const f of ALL_FIELDS) expect(Object.is(s.f[f][k], p[f])).toBe(true);
            expect([riverWetAt(s, k), gorgeAt(s, k), s.biome[k]]).toEqual([p.riverWet, p.gorge, p.biome]);
          } else {
            for (const f of ALL_FIELDS) expect(s.f[f][k]).toBeNaN();
            expect([s.flags[k], s.biome[k]]).toEqual([0, 0]);
          }
        }
      }
    }
  });

  test('floating_islands (SP3e spec §2.3): the corners inherit islandMask; the reads equal the full sample\'s at voxels with 0 < m < 1 and m = 1', () => {
    const fl = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    const next = testRng(4412);
    const full = newColumnSample();
    const corner = newColumnSample();
    let edge = 0;
    let one = 0;
    let picked = 0;
    for (let n = 0; n < 4096 && picked < 24; n++) {
      const cx = (next() % 65536) - 32768;
      const cz = (next() % 65536) - 32768;
      buildColumnSample(fl, cx, cz, full);
      const m = full.f.islandMask;
      if (!m.some((v) => v > 0)) continue;
      picked++;
      for (let v = 0; v < 8; v++) {
        const x = 16 * cx + (next() % 16);
        const y = (next() % 384) - 64;
        const z = 16 * cz + (next() % 16);
        buildCornerSample(fl, x, z, false, corner);
        for (const k of cornersOf(x, z)) {
          const i = (k % 7) - 1;
          const j = Math.floor(k / 7) - 1;
          const p = columnPoint(fl, 16 * cx + 4 * i, 16 * cz + 4 * j);
          expect(Object.is(corner.f.islandMask[k], p.islandMask)).toBe(true);
          expect(Object.is(corner.f.islandMask[k], m[k])).toBe(true);
          if (p.islandMask > 0 && p.islandMask < 1) edge++;
          if (p.islandMask === 1) one++;
        }
        for (const [f, outside, inside] of REFS) {
          if (f === 'steep') continue;
          expect(Object.is(outside.voxel(corner, x, y, z), outside.voxel(full, x, y, z)), f).toBe(true);
          expect(Object.is(inside.voxel(corner, x, y, z), inside.voxel(full, x, y, z)), f).toBe(true);
        }
      }
    }
    expect(picked).toBe(24);
    expect(edge).toBeGreaterThan(0);
    expect(one).toBeGreaterThan(0);
  });

  test('a reused output is fully overwritten; a fresh one is made when none is passed', () => {
    const reused = buildCornerSample(ctx, 3, 5, true, buildColumnSample(ctx, 0, 0, newColumnSample()));
    const fresh = buildCornerSample(ctx, 3, 5, true);
    for (const f of ALL_FIELDS) for (let k = 0; k < 49; k++) expect(Object.is(reused.f[f][k], fresh.f[f][k])).toBe(true);
    expect([...reused.flags]).toEqual([...fresh.flags]);
    expect([...reused.biome]).toEqual([...fresh.biome]);
  });

  test('non-integer positions throw', () => {
    expect(() => buildCornerSample(ctx, 0.5, 0, false)).toThrow(RangeError);
    expect(() => buildCornerSample(ctx, 0, Number.NaN, false)).toThrow(RangeError);
  });
});

describe('the per-part corner memo (createCornerSampler)', () => {
  const ctx = ctxFor('42');
  const same = (a: ColumnSample, b: ColumnSample): boolean => {
    if (a.cx !== b.cx || a.cz !== b.cz) return false;
    for (const f of ALL_FIELDS) for (let k = 0; k < 49; k++) if (!Object.is(a.f[f][k], b.f[f][k])) return false;
    for (let k = 0; k < 49; k++) if (a.flags[k] !== b.flags[k] || a.biome[k] !== b.biome[k]) return false;
    return true;
  };

  test.each([[false], [true]])('withSteep %s: memoised samples equal fresh ones bit for bit (extent 256, n = 32, two passes)', (withSteep) => {
    const sampler = createCornerSampler(ctx, withSteep);
    const fresh = newColumnSample();
    let differing = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
        const x = horizontalCoord(-3000, 256, i, 32);
        const z = horizontalCoord(1201, 256, j, 32);
        if (!same(sampler.sample(x, z), buildCornerSample(ctx, x, z, withSteep, fresh))) differing++;
      }
    }
    expect(differing).toBe(0);
  }, 30_000);

  test('a 128² slice at extent 256 makes 65,536 corner reads of 65² = 4,225 distinct points', () => {
    const sampler = createCornerSampler(ctx, false);
    for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) sampler.sample(horizontalCoord(0, 256, i, 128), horizontalCoord(0, 256, j, 128));
    expect(sampler.points).toBe(4225);
  }, 30_000);

  test('corner samples never enter the DensityContext\'s ColumnCache', () => {
    const fresh = ctxFor('42');
    const columns = surfaceContextOf(fresh).density.columns;
    expect(columns.size).toBe(0);
    const sampler = createCornerSampler(fresh, true);
    for (let i = 0; i < 64; i++) {
      sampler.sample(97 * i - 3000, 31 * i + 17);
      buildCornerSample(fresh, 53 * i, -71 * i, false);
    }
    expect(columns.size).toBe(0);
  });
});

describe('which samples an expression needs', () => {
  const steepDef: DensityExpr = { root: { op: 'add', a: { op: 'ref', name: 'a' }, b: col('E') }, defs: { a: { op: 'ref', name: 'b' }, b: { op: 'interpolated', x: col('steep') } } };
  test('colFieldsRead follows refs from the root only, through every child slot', () => {
    expect([...colFieldsRead(steepDef)].sort()).toEqual(['E', 'steep']);
    expect([...colFieldsRead({ root: col('jag'), defs: { unused: col('steep') } })]).toEqual(['jag']);
    const choice: Expr = { op: 'rangeChoice', x: col('C'), lo: 0, hi: 1, inside: col('W'), outside: { op: 'tap', name: 't', x: col('PV') } };
    expect([...colFieldsRead({ root: choice, defs: {} })].sort()).toEqual(['C', 'PV', 'W']);
    // Own-property lookups: a def named like an Object.prototype member.
    expect([...colFieldsRead({ root: { op: 'ref', name: 'constructor' }, defs: { constructor: col('T') } })]).toEqual(['T']);
  });
  test('readsSteep: through refs and interpolated; not from an unreachable def', () => {
    expect(readsSteep(steepDef)).toBe(true);
    expect(readsSteep({ root: col('offset'), defs: { unused: col('steep') } })).toBe(false);
    expect(readsSteep(legacyDefaultDensityExpr(DEFAULTS.density))).toBe(false);
  });
  test('horizontalSampling: corner samples, with steep only when read, the full sample for a fallback field', () => {
    expect(horizontalSampling(legacyDefaultDensityExpr(DEFAULTS.density))).toBe('corner');
    expect(horizontalSampling(steepDef)).toBe('cornerSteep');
    for (const f of CORNER_FALLBACK_FIELDS) expect(horizontalSampling({ root: col(f), defs: {} })).toBe('full');
    expect(Object.isFrozen(CORNER_FALLBACK_FIELDS)).toBe(true);
  });
  test('a 100,000-deep chain is walked without overflow', () => {
    let e: Expr = col('sigma');
    for (let i = 0; i < 100_000; i++) e = { op: 'neg', x: e };
    expect([...colFieldsRead({ root: e, defs: {} })]).toEqual(['sigma']);
  });
});

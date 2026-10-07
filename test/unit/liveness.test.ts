import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { checkLeaf, getPath, patchAt, type BoxTable, type Issue } from '../../src/core/params/kit';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import type { NestedSpline } from '../../src/core/spline/types';
import { buildColumnSample, gorgeAt, newColumnSample, riverWetAt, type ColumnSample } from '../../src/gen/column/columnStage';
import { cellEligible, lakeCell } from '../../src/gen/column/lakes';
import { hex64 } from '../../src/core/hash';
import {
  cellProbe, findWitness, intendedClass, leafLiveness, livenessColumns, perturbations, stageOutputHash, u2Leaves, type LivenessClass,
  type LivenessColumn,
} from '../../src/metrics/liveness';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const leaf = (path: string) => {
  const info = SCHEMA.leaves.find((l) => l.path === path);
  if (info === undefined) throw new Error(`no leaf ${path}`);
  return info;
};
const CTX = ctxFor('42');
const moved = (path: string, value: unknown) => ctxFor('42', patchAt(path, value) as ParamsPatch);

const CLASSES: readonly LivenessClass[] = [
  'land', 'land', 'coast', 'coast', 'channel', 'channel', 'gorge', 'gorge', 'basin', 'basin', 'rim', 'rim',
  'threshold:lakes.p', 'threshold:lakes.minC', 'threshold:lakes.offsetMin', 'threshold:lakes.offsetMax',
];
let cached: LivenessColumn[] | null = null;
/** The class columns of seed 42 and the default params (the scan runs once per file). */
const columns = (): LivenessColumn[] => (cached ??= livenessColumns(CTX));

describe('perturbations', () => {
  test('every leaf of the schema gets two distinct perturbed values, each valid for the leaf', () => {
    for (const info of SCHEMA.leaves) {
      const value = getPath(DEFAULTS, info.path);
      const values = perturbations(info, value);
      expect(values, info.path).toHaveLength(2);
      expect(new Set([value, ...values].map((v) => canonicalJSON(v))).size, info.path).toBe(3);
      for (const v of values) {
        const issues: Issue[] = [];
        checkLeaf(info.leaf, v, info.path, issues);
        expect(issues, info.path).toEqual([]);
      }
    }
  });

  test('number: ±15 % of |v|, or of the range span when v is 0 or the step leaves the range; clamped', () => {
    expect(perturbations(leaf('climate.scaleMul'), 1)).toEqual([0.85, 1.15]);
    expect(perturbations(leaf('lakes.minC'), -0.1)).toEqual([-0.115, -0.085]);
    expect(perturbations(leaf('rivers.coastFadeLo'), 0)).toEqual([-0.3, 0.3]);
    // 64 − 9.6 is below the minimum 63; 64 − 15 % of the span 65 is too, so it clamps to 63.
    expect(perturbations(leaf('rivers.valleyFloor'), 64)).toEqual([63, 73.6]);
    // At the maximum the upward step clamps back to v and is dropped.
    expect(perturbations(leaf('lakes.p'), 1)).toEqual([0.85]);
  });

  test('noise: wavelength × 0.85 and × 1.15 within the leaf range', () => {
    const def = DEFAULTS.climate.C;
    expect(perturbations(leaf('climate.C'), def)).toEqual([{ ...def, wavelength: 2040 }, { ...def, wavelength: 2760 }]);
    expect(perturbations(leaf('climate.C'), { ...def, wavelength: 20000 })).toEqual([{ ...def, wavelength: 17000 }]);
  });

  test('spline: every numeric knot moves by ±15 % of the leaf y span, clamped to the range; x and d stay', () => {
    const offset = DEFAULTS.shape.offset;
    const [down, up] = perturbations(leaf('shape.offset'), offset) as NestedSpline[];
    expect(down!.points[0]).toEqual({ ...offset.points[0], y: -41.6 });
    expect(up!.points[0]).toEqual({ ...offset.points[0], y: 73.6 });
    const nested = up!.points[5]!.y as NestedSpline;
    expect(nested.points.map((p) => p.y)).toEqual([127.6, 121.6, 120.6]);
    expect(nested.points.map((p) => [p.x, p.d])).toEqual((offset.points[5]!.y as NestedSpline).points.map((p) => [p.x, p.d]));
    const [jagDown] = perturbations(leaf('shape.jag'), DEFAULTS.shape.jag) as NestedSpline[];
    expect(jagDown!.points[0]!.y).toBe(-16);
  });

  test('density leaves (SP3b spec §3.3): every perturbation stays inside the leaf range', () => {
    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    expect(density.map((l) => l.path)).toEqual([
      'density.noises.jag', 'density.noises.overhang', 'density.noises.detail', 'density.detailAmpLo', 'density.detailAmpHi',
    ]);
    for (const info of density) {
      const lo = info.leaf.min!;
      const hi = info.leaf.max!;
      for (const v of perturbations(info, getPath(DEFAULTS, info.path))) {
        const x = info.leaf.kind === 'noise' ? (v as { wavelength: number }).wavelength : (v as number);
        expect(x >= lo && x <= hi, `${info.path}: ${x} in [${lo}, ${hi}]`).toBe(true);
      }
    }
    expect(perturbations(leaf('density.detailAmpLo'), 0.6)).toEqual([0.51, 0.69]);
    expect((perturbations(leaf('density.noises.detail'), DEFAULTS.density.noises.detail) as { wavelength: number }[]).map((d) => d.wavelength))
      .toEqual([8.5, 11.5]);
    // At the top of the range the upward step clamps back to the value and is dropped.
    expect(perturbations(leaf('density.detailAmpHi'), 8)).toEqual([6.8]);
  });

  test('boxTable: every interval shrunk and grown by 15 % of its width about its centre, within [−1, 1]', () => {
    const [shrunk, grown] = perturbations(leaf('biomes.table'), DEFAULTS.biomes.table) as BoxTable[];
    expect(shrunk!['beach']!.C).toEqual([-0.2065, -0.0535]);
    expect(grown!['beach']!.C).toEqual([-0.2335, -0.0265]);
    expect(shrunk!['beach']!.PV).toEqual([-0.85, 0.85]);
    expect(grown!['beach']!.PV).toEqual([-1, 1]);
    expect([grown!['beach']!.wSign, grown!['beach']!.priority]).toEqual([0, 5]);
  });
});

describe('lake cells', () => {
  test('cellProbe reproduces lakeCell eligibility, with the default params and with a variant', () => {
    for (const ctx of [CTX, ctxFor('42', { lakes: { p: 0.3, minC: -0.4, offsetMax: 150 } })]) {
      let enabled = 0;
      for (let j = -20; j <= 20; j++) {
        for (let i = -20; i <= 20; i++) {
          const cell = lakeCell(ctx, i, j);
          expect(cellEligible(cellProbe(ctx, cell), ctx.params.lakes), `cell (${i}, ${j})`).toBe(cell.enabled);
          if (cell.enabled) enabled++;
        }
      }
      expect(enabled).toBeGreaterThan(20);
    }
  });
});

describe('class columns', () => {
  test('the scan of samplePoints(sp2b.liveness, 200000) fills every class with distinct columns', () => {
    const got = columns().map((c) => c.cls);
    const empty = [...new Set(CLASSES)].filter((c) => got.filter((g) => g === c).length < CLASSES.filter((e) => e === c).length);
    expect(empty, `empty classes: ${empty.join(', ')}`).toEqual([]);
    expect(got).toEqual(CLASSES);
    expect(new Set(columns().map((c) => `${c.cx},${c.cz}`)).size).toBe(16);
  });

  test('each column shows its class on its ColumnSample lattice', () => {
    const s: ColumnSample = newColumnSample();
    const any = (p: (k: number) => boolean): boolean => Array.from({ length: 49 }, (_, k) => k).some(p);
    for (const c of columns()) {
      const f = buildColumnSample(CTX, c.cx, c.cz, s).f;
      const river = (k: number) => riverWetAt(s, k) || gorgeAt(s, k);
      const shows: Record<string, () => boolean> = {
        land: () => !any((k) => f.surfaceWaterLevel[k]! > -Infinity),
        coast: () => any((k) => Math.abs(f.offset0[k]! - 63) <= 8),
        channel: () => any((k) => river(k) && f.riverStrength[k]! > 0 && f.offset0[k]! >= 63 && f.offset0[k]! < 120),
        gorge: () => any((k) => river(k) && f.offset0[k]! > 120 && f.offset0[k]! < 170),
        basin: () => any((k) => f.lakeMask[k] === 1),
        rim: () => any((k) => f.lakeMask[k]! > 0 && f.lakeMask[k]! < 1),
      };
      const ok = c.cls.startsWith('threshold:') ? any((k) => f.lakeMask[k]! > 0) : shows[c.cls]!();
      expect(ok, `${c.cls} (${c.cx}, ${c.cz})`).toBe(true);
    }
  });

  test('each threshold column changes its shape hash when its gate leaf moves', () => {
    for (const c of columns().filter((x) => x.cls.startsWith('threshold:'))) {
      const path = c.cls.slice('threshold:'.length);
      const base = stageOutputHash(CTX, 'shape', c.cx, c.cz);
      const hashes = perturbations(leaf(path), getPath(DEFAULTS, path)).map((v) => stageOutputHash(moved(path, v), 'shape', c.cx, c.cz));
      expect(hashes.some((h) => h !== base), c.cls).toBe(true);
    }
  });

  test('a gate whose closing band is empty within the scan falls back to the band a variant opens', () => {
    // lakes.p = 0: no cell is eligible, so no variant closes a lake; the variant p = 0.15 opens some.
    const ctx0 = ctxFor('42', { lakes: { p: 0 } });
    const cols = livenessColumns(ctx0, 400);
    expect(cols.map((c) => c.cls)).toEqual(['land', 'land', 'coast', 'coast', 'channel', 'channel', 'gorge', 'gorge', 'threshold:lakes.p']);
    const p = cols[8]!;
    const s = buildColumnSample(ctx0, p.cx, p.cz, newColumnSample());
    expect(Array.from(s.f.lakeMask).every((m) => m === 0)).toBe(true);
    expect(stageOutputHash(moved('lakes.p', 0.15), 'shape', p.cx, p.cz)).not.toBe(stageOutputHash(ctx0, 'shape', p.cx, p.cz));
  });

  test('intendedClass names the class meant to exercise a leaf', () => {
    expect(intendedClass('lakes.minC')).toBe('threshold:lakes.minC');
    expect(intendedClass('lakes.rimRise')).toBe('rim');
    expect(intendedClass('lakes.depthVar')).toBe('basin');
    expect(intendedClass('rivers.gorgeDepth')).toBe('gorge');
    expect(intendedClass('rivers.coastFadeHi')).toBe('coast');
    expect(intendedClass('rivers.wetMargin')).toBe('channel');
    expect(intendedClass('climate.C')).toBe('land');
    expect(intendedClass('biomes.zoomJitter')).toBe('land');
  });
});

describe('stage output hashes', () => {
  test('biomes.zoomJitter moves only the biome2d hash, through the per-block zoom', () => {
    const c = columns().find((x) => x.cls === 'gorge')!;
    const jitter = moved('biomes.zoomJitter', 1.725);
    expect(stageOutputHash(jitter, 'climate', c.cx, c.cz)).toBe(stageOutputHash(CTX, 'climate', c.cx, c.cz));
    expect(stageOutputHash(jitter, 'shape', c.cx, c.cz)).toBe(stageOutputHash(CTX, 'shape', c.cx, c.cz));
    expect(stageOutputHash(jitter, 'biome2d', c.cx, c.cz)).not.toBe(stageOutputHash(CTX, 'biome2d', c.cx, c.cz));
    const lattice = (ctx: typeof CTX) => Array.from(buildColumnSample(ctx, c.cx, c.cz, newColumnSample()).biome);
    expect(lattice(jitter)).toEqual(lattice(CTX));
  });

  test('terrain: the region hash of the 1 × 1 window after fillColumnT on a fresh ArrayBuffer store', () => {
    for (const c of columns().filter((x) => x.cls === 'land' || x.cls === 'coast')) {
      const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
      expect(fillColumnT(store, CTX, c.cx, c.cz, () => false)).toBe(true);
      const expected = hex64(regionHash(store, c.cx, c.cz, 1, 1));
      expect(stageOutputHash(CTX, 'terrain', c.cx, c.cz), `${c.cls} (${c.cx}, ${c.cz})`).toBe(expected);
      expect(stageOutputHash(CTX, 'terrain', c.cx, c.cz)).toBe(expected);
    }
    const c = columns()[0]!;
    const h = (['climate', 'shape', 'biome2d', 'terrain'] as const).map((st) => stageOutputHash(CTX, st, c.cx, c.cz));
    expect(new Set(h).size).toBe(4);
  });

  test('a density leaf moves only the terrain hash', () => {
    const c = columns().find((x) => x.cls === 'land')!;
    const amp = moved('density.detailAmpHi', 1.725);
    for (const st of ['climate', 'shape', 'biome2d'] as const) {
      expect(stageOutputHash(amp, st, c.cx, c.cz), st).toBe(stageOutputHash(CTX, st, c.cx, c.cz));
    }
    expect(stageOutputHash(amp, 'terrain', c.cx, c.cz)).not.toBe(stageOutputHash(CTX, 'terrain', c.cx, c.cz));
  });

  test('a climate leaf moves the climate hash; the three hashes are distinct and repeatable', () => {
    const c = columns()[0]!;
    const h = (['climate', 'shape', 'biome2d'] as const).map((st) => stageOutputHash(CTX, st, c.cx, c.cz));
    expect(new Set(h).size).toBe(3);
    expect(stageOutputHash(CTX, 'shape', c.cx, c.cz)).toBe(h[1]);
    expect(stageOutputHash(moved('climate.scaleMul', 1.15), 'climate', c.cx, c.cz)).not.toBe(h[0]);
  });
});

describe('the terrain stage in U2 (SP3b spec §3.3)', () => {
  test('U2 covers the leaves of the climate, shape, biome2d and terrain stages, every density.* leaf among them', () => {
    const stages = ['climate', 'shape', 'biome2d', 'terrain'];
    const expected = SCHEMA.leaves.filter((l) => l.meta.stage !== undefined && stages.includes(l.meta.stage)).map((l) => l.path);
    expect(u2Leaves().map((l) => l.path)).toEqual(expected);
    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    expect(density.length).toBe(5);
    for (const l of density) expect(l.meta.stage, l.path).toBe('terrain');
    expect(expected).toEqual(expect.arrayContaining(density.map((l) => l.path)));
    expect(intendedClass('density.detailAmpLo')).toBe('land');
  });

  test('every density.* leaf is decided on a land or coast column', () => {
    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    for (const l of density) {
      const r = leafLiveness(CTX, l.path, columns());
      expect(r.live, `${l.path}: ${r.via ?? 'dead'}`).toBe(true);
      expect(r.via, l.path).toMatch(/^(land|coast) column \(-?\d+, -?\d+\)$/);
      expect(r.cls === 'land' || r.cls === 'coast', l.path).toBe(true);
    }
  });

  test('a terrain leaf is tried on the land and coast columns only, with no stream witness', () => {
    const others = columns().filter((c) => c.cls !== 'land' && c.cls !== 'coast');
    expect(others.length).toBe(12);
    expect(leafLiveness(CTX, 'density.noises.detail', others)).toEqual({ path: 'density.noises.detail', live: false, via: null, cls: 'land' });
  });
});

describe('witnesses', () => {
  test('the lake-cell spiral finds a witness for lakes.minC', () => {
    expect(findWitness(CTX, 'lakes.minC')).toBe('witness cell (-12, 4) → column (-235, 87)');
  });

  test('a flipped cell whose centre column keeps its hash does not end the spiral', () => {
    // Cell (2, 6) comes first in the spiral and minC −0.115 enables it, but the lake warp puts its lake off its centre column.
    const cell = lakeCell(CTX, 2, 6);
    const probe = cellProbe(CTX, cell);
    const loose = moved('lakes.minC', -0.115);
    expect([cellEligible(probe, CTX.params.lakes), cellEligible(probe, loose.params.lakes)]).toEqual([false, true]);
    const cx = Math.floor(cell.cx / 16);
    const cz = Math.floor(cell.cz / 16);
    expect(stageOutputHash(loose, 'shape', cx, cz)).toBe(stageOutputHash(CTX, 'shape', cx, cz));
  });

  test('other leaves take the next stream columns that are not class columns', () => {
    expect(findWitness(CTX, 'climate.C', columns())).toMatch(/^witness column \(-?\d+, -?\d+\)$/);
  });
});

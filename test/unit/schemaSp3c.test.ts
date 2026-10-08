import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { metaOf, PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA, type SurfaceParams } from '../../src/core/params/schema';
import { dirtyStages, stageHashes } from '../../src/core/stage/hash';
import { checkRegistry, STAGES } from '../../src/core/stage/registry';
import type { SurfaceScanParams } from '../../src/gen/surface/scan';

describe('SP3c surface group (spec §3.5)', () => {
  test('leaves, kinds, scope terrain and stage terrain, after the density group (bandOffset is the bandlands task\'s)', () => {
    expect(PARAM_META.filter((m) => m.path.startsWith('surface.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`)).toEqual([
      'surface.noises.depth:noise:terrain:terrain',
      'surface.noises.patch:noise:terrain:terrain',
      'surface.depthMul:number:terrain:terrain',
      'surface.snowline:number:terrain:terrain',
      'surface.lapse:number:terrain:terrain',
      'surface.lapseBase:int:terrain:terrain',
      'surface.cliffSteep:number:terrain:terrain',
      'surface.cliffMinY:int:terrain:terrain',
      'surface.patchThreshold:number:terrain:terrain',
    ]);
    const paths = PARAM_META.map((m) => m.path);
    expect(paths.indexOf('surface.noises.depth')).toBe(paths.indexOf('density.detailAmpHi') + 1);
  });

  test('meta: noise dims, wavelength ranges and remapNone; the number and int ranges', () => {
    expect(metaOf('surface.noises.depth')).toMatchObject({ dims: 2, min: 8, max: 1024, remapNone: true });
    expect(metaOf('surface.noises.patch')).toMatchObject({ dims: 2, min: 4, max: 512, remapNone: true });
    expect(metaOf('surface.depthMul')).toMatchObject({ min: 0, max: 2, step: 0.05 });
    expect(metaOf('surface.snowline')).toMatchObject({ min: -1, max: 1, step: 0.01 });
    expect(metaOf('surface.lapse')).toMatchObject({ min: 0, max: 0.05, step: 0.0005 });
    expect(metaOf('surface.lapseBase')).toMatchObject({ min: -64, max: 319, step: 1 });
    expect(metaOf('surface.cliffSteep')).toMatchObject({ min: 0, max: 8, step: 0.05 });
    expect(metaOf('surface.cliffMinY')).toMatchObject({ min: -64, max: 319, step: 1 });
    expect(metaOf('surface.patchThreshold')).toMatchObject({ min: 0, max: 3, step: 0.01 });
  });

  test('defaults: depth λ 64 × 2 octaves, patch λ 24 × 2 (unit sd, clampSigma 3); depthMul 1, snowline −0.6, lapse 0.006 from y 80, cliffs steep ≥ 1.2 at y ≥ 80, patches at 0.55', () => {
    const d = DEFAULTS.surface;
    const n = (x: typeof d.noises.depth) => [x.wavelength, x.octaves, x.persistence, x.lacunarity, x.remap, x.clampSigma, x.double];
    expect(n(d.noises.depth)).toEqual([64, 2, 0.5, 2, 'none', 3, true]);
    expect(n(d.noises.patch)).toEqual([24, 2, 0.5, 2, 'none', 3, true]);
    expect([d.depthMul, d.snowline, d.lapse, d.lapseBase, d.cliffSteep, d.cliffMinY, d.patchThreshold]).toEqual([1, -0.6, 0.006, 80, 1.2, 80, 0.55]);
  });

  test('params.surface is the scan\'s SurfaceScanParams as is (Task 5\'s field names)', () => {
    const p: SurfaceParams = DEFAULTS.surface;
    const scan: SurfaceScanParams = p;
    expect([scan.depthMul, scan.lapse, scan.lapseBase]).toEqual([1, 0.006, 80]);
  });

  test('the noise instances: seed names are the leaf paths, 2D', () => {
    const inst = noiseInstances(SCHEMA, DEFAULTS).filter((i) => i.path.startsWith('surface.'));
    expect(inst.map((i) => `${i.seedName}|${i.dims}`)).toEqual(['surface.noises.depth|2', 'surface.noises.patch|2']);
  });

  test('a surface noise refuses remap \'uniform\' (validateRules and the scan read unit-sd z2)', () => {
    for (const id of ['depth', 'patch'] as const) {
      const r = applyPatch(SCHEMA, DEFAULTS, { surface: { noises: { [id]: { remap: 'uniform' } } } });
      expect(r.ok ? [] : r.issues.map((i) => `${i.path} ${i.code}`)).toEqual([`surface.noises.${id}.remap REMAP_NOT_ALLOWED`]);
    }
  });

  test('the int leaves refuse fractions; the ranges hold', () => {
    const frac = applyPatch(SCHEMA, DEFAULTS, { surface: { lapseBase: 80.5 } });
    expect(frac.ok ? [] : frac.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['surface.lapseBase NOT_INTEGER']);
    const out = applyPatch(SCHEMA, DEFAULTS, { surface: { cliffMinY: 320, depthMul: 2.05 } });
    expect(out.ok ? [] : out.issues.map((i) => `${i.path} ${i.code}`).sort()).toEqual(['surface.cliffMinY OUT_OF_RANGE', 'surface.depthMul OUT_OF_RANGE']);
  });

  test('the terrain stage hashes the density and surface groups (U4 registry invariants hold)', () => {
    expect(STAGES.find((s) => s.id === 'terrain')!.params).toEqual(['density', 'surface']);
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
    const moved = applyPatch(SCHEMA, DEFAULTS, { surface: { snowline: -0.5 } });
    if (!moved.ok) throw new Error('bad patch');
    // A surface edit dirties the terrain stage and what reads it, never the 2D stages.
    expect(dirtyStages(stageHashes(DEFAULTS), stageHashes(moved.value))).toEqual(['terrain', 'decorate', 'light', 'mesh']);
  });
});

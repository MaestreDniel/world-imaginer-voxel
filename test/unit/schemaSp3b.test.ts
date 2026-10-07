import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { metaOf, PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, stageHashes } from '../../src/core/stage/hash';
import { checkRegistry, STAGES } from '../../src/core/stage/registry';

describe('SP3b density group (spec §3.3)', () => {
  test('leaves, kinds, scope terrain and stage terrain', () => {
    expect(PARAM_META.filter((m) => m.path.startsWith('density.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`)).toEqual([
      'density.noises.jag:noise:terrain:terrain',
      'density.noises.overhang:noise:terrain:terrain',
      'density.noises.detail:noise:terrain:terrain',
      'density.detailAmpLo:number:terrain:terrain',
      'density.detailAmpHi:number:terrain:terrain',
    ]);
  });

  test('meta: dims and wavelength ranges of the noises, ranges of the amplitudes', () => {
    expect(metaOf('density.noises.jag')).toMatchObject({ dims: 2, min: 16, max: 8192 });
    expect(metaOf('density.noises.overhang')).toMatchObject({ dims: 3, min: 16, max: 8192 });
    expect(metaOf('density.noises.detail')).toMatchObject({ dims: 3, min: 4, max: 256 });
    for (const p of ['density.detailAmpLo', 'density.detailAmpHi']) expect(metaOf(p)).toMatchObject({ min: 0, max: 8, step: 0.05, unit: 'blocks' });
  });

  test('defaults: jag λ 28 × 2 octaves, overhang λ 80 yScale 1.25 × 3, detail λ 10 × 1; amplitudes 0.6 and 1.5', () => {
    const d = DEFAULTS.density;
    const n = (x: typeof d.noises.jag) => [x.wavelength, x.octaves, x.yScale, x.remap, x.clampSigma, x.double];
    expect(n(d.noises.jag)).toEqual([28, 2, 1, 'none', 3, true]);
    expect(n(d.noises.overhang)).toEqual([80, 3, 1.25, 'none', 3, true]);
    expect(n(d.noises.detail)).toEqual([10, 1, 1, 'none', 3, true]);
    // λy = λ / yScale = 64 (spec §3.3: overhang λy 64).
    expect(d.noises.overhang.wavelength / d.noises.overhang.yScale).toBe(64);
    expect([d.detailAmpLo, d.detailAmpHi]).toEqual([0.6, 1.5]);
  });

  test('the noise instances: seed names are the leaf paths, with their dims', () => {
    const inst = noiseInstances(SCHEMA, DEFAULTS).filter((i) => i.path.startsWith('density.'));
    expect(inst.map((i) => `${i.seedName}|${i.dims}`)).toEqual(['density.noises.jag|2', 'density.noises.overhang|3', 'density.noises.detail|3']);
  });

  test('a 2D jag noise refuses yScale ≠ 1; the 3D noises accept it', () => {
    const bad = applyPatch(SCHEMA, DEFAULTS, { density: { noises: { jag: { yScale: 2 } } } });
    expect(bad.ok ? [] : bad.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['density.noises.jag.yScale YSCALE_NOT_1']);
    expect(applyPatch(SCHEMA, DEFAULTS, { density: { noises: { detail: { yScale: 2 } } } }).ok).toBe(true);
  });

  test('a density noise refuses remap \'uniform\' (validateExpr rejects the expression, so no T column could be generated)', () => {
    // jag is 2D with double: true, so only this rule stops 'uniform' (a preset, a URL or the panel's remap select).
    const jag = applyPatch(SCHEMA, DEFAULTS, { density: { noises: { jag: { remap: 'uniform' } } } });
    expect(jag.ok ? [] : jag.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['density.noises.jag.remap REMAP_NOT_ALLOWED']);
    for (const id of ['overhang', 'detail'] as const) {
      const r = applyPatch(SCHEMA, DEFAULTS, { density: { noises: { [id]: { remap: 'uniform' } } } });
      expect(r.ok ? [] : r.issues.map((i) => `${i.path} ${i.code}`)).toEqual([`density.noises.${id}.remap REMAP_NOT_ALLOWED`]);
    }
    expect(PARAM_META.filter((m) => m.remapNone === true).map((m) => m.path)).toEqual(['density.noises.jag', 'density.noises.overhang', 'density.noises.detail']);
    // A 2D noise outside the density group keeps 'uniform'.
    expect(applyPatch(SCHEMA, DEFAULTS, { lakes: { rimNoise: { remap: 'uniform' } } }).ok).toBe(true);
  });

  test('the terrain stage hashes the density group (U4 registry invariants hold)', () => {
    expect(STAGES.find((s) => s.id === 'terrain')!.params).toEqual(['density']);
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
    const moved = applyPatch(SCHEMA, DEFAULTS, { density: { detailAmpHi: 2 } });
    if (!moved.ok) throw new Error('bad patch');
    // A density edit dirties the terrain stage and what reads it, never the 2D stages.
    expect(dirtyStages(stageHashes(DEFAULTS), stageHashes(moved.value))).toEqual(['terrain', 'decorate', 'light', 'mesh']);
  });
});

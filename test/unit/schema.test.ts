import { expect, test } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import { metaOf, PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA, type ClimateParams } from '../../src/core/params/schema';

const CLIMATE_META = PARAM_META.filter((m) => m.path.startsWith('climate.'));

test('13 climate leaves, all climate scope and stage, in declaration order', () => {
  expect(CLIMATE_META.map((m) => `${m.path}:${m.kind}`)).toEqual([
    'climate.scaleMul:number',
    'climate.warp.shift.amplitude:number', 'climate.warp.shift.noise:noise',
    'climate.warp.C.amplitude:number', 'climate.warp.C.noise:noise',
    'climate.warp.R.amplitude:number', 'climate.warp.R.noise:noise',
    'climate.C:noise', 'climate.E:noise', 'climate.W:noise', 'climate.T:noise', 'climate.H:noise', 'climate.R:noise',
  ]);
  for (const m of CLIMATE_META) {
    expect(m.scope).toBe('climate');
    expect(m.stage).toBe('climate');
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.doc.length).toBeGreaterThan(0);
  }
  expect(metaOf('climate.scaleMul')).toMatchObject({ min: 0.25, max: 16, step: 0.05, effectMetric: 'Z4' });
  expect(metaOf('climate.warp.C.noise')).toMatchObject({ min: 16, max: 8192, dims: 2 });
  expect(metaOf('climate.T')).toMatchObject({ min: 64, max: 20000, dims: 2 });
  expect(metaOf('nope')).toBeUndefined();
});

test('defaults match spec §4.3', () => {
  const c: ClimateParams = DEFAULTS.climate;
  expect(c.scaleMul).toBe(1);
  expect([c.warp.shift.amplitude, c.warp.C.amplitude, c.warp.R.amplitude]).toEqual([48, 180, 120]);
  expect([c.warp.shift.noise, c.warp.C.noise, c.warp.R.noise].map((n) => [n.wavelength, n.octaves, n.remap])).toEqual([[256, 3, 'none'], [1024, 2, 'none'], [512, 2, 'none']]);
  expect([c.C, c.E, c.W, c.T, c.H, c.R].map((n) => [n.wavelength, n.octaves, n.remap, n.persistence, n.lacunarity, n.double])).toEqual([
    [2400, 6, 'uniform', 0.5, 2, true], [1600, 5, 'uniform', 0.5, 2, true], [900, 5, 'uniform', 0.5, 2, true],
    [5000, 4, 'uniform', 0.5, 2, true], [2400, 4, 'uniform', 0.5, 2, true], [1000, 4, 'uniform', 0.5, 2, true],
  ]);
  expect(Object.isFrozen(DEFAULTS.climate.C)).toBe(true);
});

test('noise instances: warps expand to .x/.z, seed names default to paths', () => {
  const inst = noiseInstances(SCHEMA, DEFAULTS).filter((i) => i.path.startsWith('climate.'));
  expect(inst.map((i) => `${i.seedName}|${i.path}|${i.dims}`)).toEqual([
    'climate.warp.shift.noise.x|climate.warp.shift.noise|2', 'climate.warp.shift.noise.z|climate.warp.shift.noise|2',
    'climate.warp.C.noise.x|climate.warp.C.noise|2', 'climate.warp.C.noise.z|climate.warp.C.noise|2',
    'climate.warp.R.noise.x|climate.warp.R.noise|2', 'climate.warp.R.noise.z|climate.warp.R.noise|2',
    'climate.C|climate.C|2', 'climate.E|climate.E|2', 'climate.W|climate.W|2', 'climate.T|climate.T|2', 'climate.H|climate.H|2', 'climate.R|climate.R|2',
  ]);
  expect(inst[6]!.def).toBe(DEFAULTS.climate.C);
});

test('every octave seed name is distinct within a world (fnv1a32 of name × {#i, \'#i}, i < 16)', () => {
  const names = noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName);
  expect(new Set(names).size).toBe(names.length);
  const hashes = new Set<number>();
  for (const n of names) for (let i = 0; i < 16; i++) { hashes.add(fnv1a32(`${n}#${i}`)); hashes.add(fnv1a32(`${n}'#${i}`)); }
  expect(hashes.size).toBe(names.length * 32);
});

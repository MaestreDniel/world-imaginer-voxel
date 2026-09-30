import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { DEFAULTS } from '../../src/core/params/defaults';
import { BOX_AXES } from '../../src/core/params/kit';
import { PARAM_META } from '../../src/core/params/meta';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';

describe('SP2a schema groups', () => {
  test('leaves, scopes and stages', () => {
    const rows = PARAM_META.filter((m) => !m.path.startsWith('climate.')).map((m) => `${m.path}:${m.kind}:${m.scope}:${m.stage}`);
    const g = (prefix: string, stage: string, names: string) => names.split(' ').map((n) => {
      const [name, kind] = n.split(':');
      return `${prefix}.${name}:${kind ?? 'number'}:terrain:${stage}`;
    });
    expect(rows).toEqual([
      ...g('shape', 'shape', 'offset:spline sigma:spline jag:spline'),
      ...g('rivers', 'shape', 'widthMin widthVar widthNoise:noise valleyBase valleyPerE valleyFloor valleyRise coastFadeLo coastFadeHi altFadeLo altFadeHi depthMin depthVar wetMargin gorgeDepth'),
      ...g('lakes', 'shape', 'cell jitter warpAmp warpNoise:noise p minC offsetMin offsetMax radius rimWidth roughness rimNoise:noise ringFrac depthMin depthVar rimRise rimSigma sigmaMul'),
      ...g('biomes', 'biome2d', 'table:boxTable zoomJitter'),
    ]);
  });
  test('shape defaults equal the frozen SP1 fixtures (until the first retune)', () => {
    expect(canonicalJSON(DEFAULTS.shape.offset)).toBe(canonicalJSON(OFFSET));
    expect(canonicalJSON(DEFAULTS.shape.sigma)).toBe(canonicalJSON(SIGMA));
    expect(canonicalJSON(DEFAULTS.shape.jag)).toBe(canonicalJSON(JAG));
  });
  test('river and lake defaults follow master §3.4-3.5', () => {
    const r = DEFAULTS.rivers;
    expect([r.widthMin, r.widthVar, r.valleyBase, r.valleyPerE, r.valleyFloor, r.valleyRise, r.coastFadeLo, r.coastFadeHi, r.altFadeLo, r.altFadeHi, r.depthMin, r.depthVar, r.wetMargin])
      .toEqual([8, 12, 30, 45, 64, 2, -0.12, -0.02, 120, 170, 3, 3, 2]);
    expect([r.widthNoise.wavelength, r.widthNoise.remap]).toEqual([600, 'uniform']);
    const l = DEFAULTS.lakes;
    expect([l.cell, l.warpAmp, l.warpNoise.wavelength, l.p, l.minC, l.offsetMin, l.offsetMax, l.ringFrac, l.depthMin, l.depthVar, l.rimRise, l.rimSigma, l.sigmaMul, l.rimNoise.wavelength])
      .toEqual([320, 80, 360, 0.12, -0.1, 66, 200, 0.55, 4, 10, 2, 0.5, 0.3, 48]);
  });
  test('the new noise instances have distinct seed names', () => {
    const names = noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName);
    expect(names.filter((n) => !n.startsWith('climate.'))).toEqual(['rivers.widthNoise', 'lakes.warpNoise.x', 'lakes.warpNoise.z', 'lakes.rimNoise']);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('default biome table (SP2a spec §3.1 authoring rules)', () => {
  const T = BIOME_TABLE_DEFAULT;
  const EDGES: Record<string, readonly number[]> = {
    C: [-1, -0.55, -0.22, -0.1, -0.04, 1], E: [-1, -0.375, 1], PV: [-1, -0.6, 0.2, 0.7, 1], T: [-1, -0.8, -0.6, -0.2, 0.2, 0.6, 1], H: [-1, -0.6, -0.2, 0.2, 0.6, 1],
  };
  test('26 box-picked biomes with unique priorities', () => {
    expect(Object.keys(T)).toEqual([...BOX_BIOMES]);
    expect(new Set(Object.values(T).map((r) => r.priority)).size).toBe(26);
  });
  test('every interval edge lies on a band edge', () => {
    for (const [name, row] of Object.entries(T)) for (const a of BOX_AXES) for (const e of row[a]) expect(EDGES[a], `${name}.${a}`).toContain(e);
  });
  test('windswept and peak boxes bound T; beach has no PV restriction; volcano is hot peaks', () => {
    for (const n of ['windswept_hills', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano', 'snowy_slopes'] as const) expect(T[n].T[1] - T[n].T[0]).toBeLessThan(2);
    expect(T.beach.PV).toEqual([-1, 1]);
    expect([T.beach.C, T.snowy_beach.C, T.stony_shore.C]).toEqual([[-0.22, -0.04], [-0.22, -0.04], [-0.22, -0.04]]);
    // Oceans reach up to C −0.1 (the highest C of a sea-floor column); the height filter keeps them off land.
    expect([T.deep_ocean.C, T.ocean.C, T.warm_ocean.C, T.frozen_ocean.C]).toEqual([[-1, -0.55], [-0.55, -0.1], [-1, -0.1], [-1, -0.1]]);
    expect([T.volcano.T, T.volcano.PV, T.volcano.E]).toEqual([[0.6, 1], [0.7, 1], [-1, -0.375]]);
    // Liquid oceans reach down to T −0.8; only the coldest seas freeze (tuning of 2026-09-29).
    expect([T.frozen_ocean.T, T.ocean.T, T.deep_ocean.T]).toEqual([[-1, -0.8], [-0.8, 0.6], [-0.8, 0.6]]);
    const onlyOceans = Object.entries(T).filter(([, r]) => r.T.includes(-0.8)).map(([n]) => n).sort();
    expect(onlyOceans).toEqual(['deep_ocean', 'frozen_ocean', 'ocean']);
  });
  test('the boxes tile the climate space per height class: 20 000 random points fall in exactly one box (edges excluded)', () => {
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
    const OCEANS = new Set(['deep_ocean', 'ocean', 'warm_ocean', 'frozen_ocean']);
    for (let i = 0; i < 20000; i++) {
      const p = { C: rnd(), E: rnd(), PV: rnd(), T: rnd(), H: rnd() };
      const w = rnd() < 0 ? -1 : 1;
      // Sea-floor columns (offset0 below sea level) have C below −0.1 and take only ocean boxes; land columns have
      // C above −0.22 (in practice above −0.14) and take only the others. In the shore band both kinds occur.
      const sea = p.C < -0.22 ? true : p.C > -0.1 ? false : rnd() < 0;
      const inside = Object.entries(T)
        .filter(([n, r]) => OCEANS.has(n) === sea && BOX_AXES.every((a) => p[a] >= r[a][0] && p[a] <= r[a][1]) && (r.wSign === 0 || r.wSign === w))
        .map(([n]) => n);
      const hotHumidValley = !sea && p.T > 0.6 && p.H > 0.2 && p.H < 0.6 && p.PV < -0.6 && p.C > -0.04 && p.E > -0.375;
      expect(inside.length, `${JSON.stringify(p)} sea ${sea} → ${inside.join(',')}`).toBe(hotHumidValley ? 0 : 1);
    }
  });
});

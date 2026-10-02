import { describe, expect, test } from 'vitest';
import type { RegenScope } from '../../src/core/ids';
import type { NoiseDef } from '../../src/core/noise/types';
import { q15 } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, getPath, patchAt } from '../../src/core/params/kit';
import { SCHEMA, type Params } from '../../src/core/params/schema';
import { paramLints } from '../../src/ui/paramPanel/lints';
import {
  amplitudesToggle, controlTip, noiseFieldLock, octavesChange, panelTree, scopeBadge, sliderToValue, valueToSlider,
  type ControlSpec, type SectionSpec,
} from '../../src/ui/paramPanel/model';

const sectionsOf = (s: SectionSpec): SectionSpec[] => [s, ...s.sections.flatMap(sectionsOf)];
const controlsOf = (s: SectionSpec): ControlSpec[] => sectionsOf(s).flatMap((x) => x.controls);
const parentOf = (path: string): string => (path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '');
const control = (path: string): ControlSpec => {
  const c = controlsOf(panelTree()).find((x) => x.path === path);
  if (c === undefined) throw new Error(`no control ${path}`);
  return c;
};
const sliders = (): ControlSpec[] => controlsOf(panelTree()).filter((c) => c.kind === 'number' || c.kind === 'int' || c.kind === 'noise');
const noiseAt = (path: string): NoiseDef => getPath(DEFAULTS, path) as NoiseDef;
const params = (patch: unknown): Params => {
  const r = applyPatch(SCHEMA, DEFAULTS, patch);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};

describe('panel tree', () => {
  test('one section per group and one control per leaf, under its parent, in schema order', () => {
    const root = panelTree();
    expect(root.path).toBe('');
    expect(root.label).toBe('Parameters');
    expect(root.controls).toEqual([]);
    expect(root.sections.map((s) => s.path)).toEqual(['climate', 'shape', 'rivers', 'lakes', 'biomes']);
    const groups = SCHEMA.nodes.filter((n) => n.node.tag === 'group').map((n) => n.path);
    expect(sectionsOf(root).map((s) => s.path).sort()).toEqual([...groups].sort());
    expect(controlsOf(root).map((c) => c.path).sort()).toEqual(SCHEMA.leaves.map((l) => l.path).sort());
    const order = new Map(SCHEMA.nodes.map((n, i) => [n.path, i] as const));
    for (const s of sectionsOf(root)) {
      const node = SCHEMA.byPath.get(s.path)!;
      expect(node.tag).toBe('group');
      if (node.tag === 'group') expect([s.label, s.doc]).toEqual([node.label, node.doc]);
      for (const list of [s.controls.map((c) => c.path), s.sections.map((x) => x.path)]) {
        for (const p of list) expect(parentOf(p)).toBe(s.path);
        const idx = list.map((p) => order.get(p)!);
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
      }
    }
  });

  test("a section's own controls come before its sub-sections (climate: the fields, then Warps)", () => {
    const climate = panelTree().sections[0]!;
    expect(climate.controls.map((c) => c.path)).toEqual([
      'climate.scaleMul', 'climate.C', 'climate.E', 'climate.W', 'climate.T', 'climate.H', 'climate.R',
    ]);
    expect(climate.sections.map((s) => s.path)).toEqual(['climate.warp']);
    expect(climate.sections[0]!.sections.map((s) => s.path)).toEqual(['climate.warp.shift', 'climate.warp.C', 'climate.warp.R']);
    expect(climate.sections[0]!.sections[0]!.controls.map((c) => c.path)).toEqual(['climate.warp.shift.amplitude', 'climate.warp.shift.noise']);
  });

  test('controls carry the leaf metadata; a noise control has the wavelength range, step 1 and its dims', () => {
    for (const { path, meta } of SCHEMA.leaves) {
      const c = control(path);
      expect([c.kind, c.label, c.doc, c.unit, c.scope, c.stage, c.min, c.max])
        .toEqual([meta.kind, meta.label, meta.doc, meta.unit, meta.scope, meta.stage, meta.min, meta.max]);
      expect(c.step).toBe(meta.kind === 'noise' ? 1 : meta.step);
      expect(c.dims).toBe(meta.dims);
    }
    expect(control('climate.C')).toMatchObject({ kind: 'noise', min: 64, max: 20000, step: 1, dims: 2, scale: 'log' });
    expect(control('rivers.widthNoise')).toMatchObject({ kind: 'noise', min: 16, max: 8192, step: 1, dims: 2, scale: 'log' });
  });

  test('scale: log when min > 0 and max / min ≥ 20, and for every noise wavelength; linear otherwise', () => {
    const log = controlsOf(panelTree()).filter((c) => c.scale === 'log').map((c) => c.path);
    expect(log.sort()).toEqual([
      'climate.C', 'climate.E', 'climate.H', 'climate.R', 'climate.T', 'climate.W', 'climate.scaleMul',
      'climate.warp.C.noise', 'climate.warp.R.noise', 'climate.warp.shift.noise',
      'lakes.cell', 'lakes.depthMin', 'lakes.radius', 'lakes.rimNoise', 'lakes.rimWidth', 'lakes.warpNoise',
      'rivers.widthMin', 'rivers.widthNoise',
    ]);
    // ratio 15 (ringFrac 0.1 … 1.5), min 0 (zoomJitter), negative min (coastFadeLo), splines and the table stay linear
    for (const p of ['lakes.ringFrac', 'biomes.zoomJitter', 'rivers.coastFadeLo', 'rivers.valleyFloor', 'shape.offset', 'biomes.table']) {
      expect(control(p).scale).toBe('linear');
    }
  });
});

describe('slider mapping', () => {
  test('the ends of every slider are the range ends', () => {
    for (const c of sliders()) {
      expect(sliderToValue(c, 0)).toBe(c.min);
      expect(sliderToValue(c, 1)).toBe(c.max);
      expect(valueToSlider(c, c.min!)).toBe(0);
      expect(valueToSlider(c, c.max!)).toBe(1);
    }
  });

  test('log mapping (scaleMul 0.25 … 16) and linear mapping (coastFadeLo −1 … 1)', () => {
    const s = control('climate.scaleMul');
    expect(sliderToValue(s, 0.5)).toBe(2);
    expect(valueToSlider(s, 2)).toBeCloseTo(0.5, 12);
    expect(valueToSlider(s, 1)).toBeCloseTo(1 / 3, 12);
    expect(valueToSlider(s, 4)).toBeCloseTo(2 / 3, 12);
    const f = control('rivers.coastFadeLo');
    expect(sliderToValue(f, 0.5)).toBe(0);
    expect(sliderToValue(f, 0.25)).toBe(-0.5);
    expect(valueToSlider(f, -0.12)).toBeCloseTo(0.44, 12);
  });

  test('slider values stay in range, on the step grid, q15-stable, and map back to themselves', () => {
    for (const c of sliders()) {
      for (let k = 0; k <= 97; k++) {
        const v = sliderToValue(c, k / 97);
        expect(v).toBeGreaterThanOrEqual(c.min!);
        expect(v).toBeLessThanOrEqual(c.max!);
        expect(q15(v)).toBe(v);
        const n = (v - c.min!) / c.step!;
        expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6);
        expect(sliderToValue(c, valueToSlider(c, v))).toBe(v);
      }
    }
  });

  test('t and v outside the range clamp; NaN maps to the start', () => {
    const c = control('lakes.radius');
    expect(sliderToValue(c, -3)).toBe(8);
    expect(sliderToValue(c, 7)).toBe(1024);
    expect(sliderToValue(c, Number.NaN)).toBe(8);
    expect(valueToSlider(c, 1)).toBe(0);
    expect(valueToSlider(c, 5000)).toBe(1);
    expect(valueToSlider(c, Number.NaN)).toBe(0);
    expect(valueToSlider(control('climate.scaleMul'), 0)).toBe(0);
  });

  test('an int control rounds; a control without a step is not snapped', () => {
    const base = control('rivers.valleyFloor');
    const i: ControlSpec = { path: 'x', kind: 'int', label: 'x', doc: '', min: 1, max: 16, scale: 'linear', scope: 'terrain' };
    expect(sliderToValue(i, 0.5)).toBe(9);
    expect(sliderToValue(i, 0.35)).toBe(6);
    const free: ControlSpec = { ...base, step: undefined };
    expect(sliderToValue(free, 0.5)).toBe(95.5);
    expect(sliderToValue(base, 0.5)).toBe(96);
  });

  test('controls without a slider throw', () => {
    expect(() => sliderToValue(control('shape.offset'), 0.5)).toThrow(/no slider/);
    expect(() => valueToSlider(control('biomes.table'), 0)).toThrow(/no slider/);
  });
});

describe('scope badges and tooltips', () => {
  test('every scope has a badge; Climate and Terrain use the spec text', () => {
    const scopes: RegenScope[] = ['live', 'remesh', 'decorate', 'terrain', 'climate'];
    expect(scopes.map((s) => scopeBadge(s).label)).toEqual(['Live', 'Remesh', 'Decorate', 'Terrain', 'Climate']);
    for (const s of scopes) expect(scopeBadge(s).tip.length).toBeGreaterThan(0);
    expect(scopeBadge('climate').tip).toBe('recomputes everything');
    expect(scopeBadge('terrain').tip).toBe('recomputes shape and biomes, keeps raw climate');
  });

  test("today's panel shows only Climate and Terrain badges", () => {
    expect([...new Set(controlsOf(panelTree()).map((c) => scopeBadge(c.scope).label))].sort()).toEqual(['Climate', 'Terrain']);
  });

  test('the tooltip holds the doc, the range with its unit, and the path', () => {
    expect(controlTip(control('rivers.widthMin'))).toBe('Channel width where the width noise is lowest.\nRange: 1 … 64 blocks\nPath: rivers.widthMin');
    expect(controlTip(control('climate.scaleMul'))).toBe(
      'Zooms every climate wavelength, warp wavelength and warp amplitude (large_biomes = 4).\nRange: 0.25 … 16\nPath: climate.scaleMul',
    );
    expect(controlTip(control('climate.C'))).toBe('Ocean ↔ inland.\nWavelength: 64 … 20000 blocks\nPath: climate.C');
    expect(controlTip(control('biomes.table'))).toBe(
      'Climate box, sign(W) filter and tie-break priority of every box-picked surface biome.\nPath: biomes.table',
    );
  });
});

describe('noise sub-block', () => {
  test('switching amplitudes to a list writes q15(persistence^i); switching back writes null', () => {
    const c = noiseAt('climate.C');
    expect(c.amplitudes).toBeNull();
    const list = amplitudesToggle(c, true);
    expect(list).toEqual({ amplitudes: [1, 0.5, 0.25, 0.125, 0.0625, 0.03125] });
    expect(amplitudesToggle({ ...c, amplitudes: list.amplitudes! }, false)).toEqual({ amplitudes: null });
    expect(amplitudesToggle({ ...c, persistence: 0.3, octaves: 3 }, true)).toEqual({ amplitudes: [1, 0.3, 0.09] });
  });

  test('items below 1e-6 are written as 0', () => {
    const d = { ...noiseAt('lakes.rimNoise'), persistence: 0.05, octaves: 16 };
    expect(amplitudesToggle(d, true)).toEqual({
      amplitudes: [1, 0.05, 0.0025, 0.000125, 0.00000625, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
  });

  test('the toggle keeps every noise leaf valid at the extreme persistence and octaves', () => {
    for (const { path, leaf } of SCHEMA.leaves) {
      if (leaf.kind !== 'noise') continue;
      for (const persistence of [0.05, 0.1, 0.5, 0.97, 1]) {
        for (const octaves of [1, 7, 16]) {
          const d: NoiseDef = { ...noiseAt(path), persistence, octaves };
          const patch = { persistence, octaves, ...amplitudesToggle(d, true) };
          for (const a of patch.amplitudes!) expect(a === 0 || Math.abs(a) >= 1e-6).toBe(true);
          expect(applyPatch(SCHEMA, DEFAULTS, patchAt(path, patch)).ok).toBe(true);
        }
      }
    }
  });

  test('a toggle to the current state changes nothing', () => {
    const c = noiseAt('climate.C');
    expect(amplitudesToggle(c, false)).toEqual({});
    expect(amplitudesToggle({ ...c, amplitudes: [1, 0, 0, 0, 0, 0] }, true)).toEqual({});
  });

  test('an octaves change resizes an active list in the same patch: truncated, or extended with 0', () => {
    const d: NoiseDef = { ...noiseAt('climate.E'), octaves: 3, amplitudes: [1, 0.5, 0.25] };
    expect(octavesChange(d, 2)).toEqual({ octaves: 2, amplitudes: [1, 0.5] });
    expect(octavesChange(d, 5)).toEqual({ octaves: 5, amplitudes: [1, 0.5, 0.25, 0, 0] });
    expect(octavesChange(d, 3)).toEqual({ octaves: 3, amplitudes: [1, 0.5, 0.25] });
    expect(d.amplitudes).toEqual([1, 0.5, 0.25]);
    const r = applyPatch(SCHEMA, DEFAULTS, patchAt('climate.E', { ...d, ...octavesChange(d, 5) }));
    expect(r.ok).toBe(true);
  });

  test('without a list, or with an octaves value the validator refuses, only octaves is written', () => {
    const e = noiseAt('climate.E');
    expect(octavesChange(e, 9)).toEqual({ octaves: 9 });
    const d: NoiseDef = { ...e, octaves: 3, amplitudes: [1, 0.5, 0.25] };
    for (const bad of [0, 17, 2.5, Number.NaN]) expect(octavesChange(d, bad)).toEqual({ octaves: bad });
  });

  test('fields a rule fixes are locked with the reason', () => {
    const c = control('climate.C');
    const def = noiseAt('climate.C');
    expect(def).toMatchObject({ remap: 'uniform', double: true });
    expect(noiseFieldLock(c, def, 'yScale')).toBe('a 2D noise has yScale 1');
    expect(noiseFieldLock(c, def, 'double')).toBe("remap 'uniform' needs double: true");
    expect(noiseFieldLock(c, def, 'remap')).toBeNull();
    const rim = control('lakes.rimNoise');
    const rimDef = noiseAt('lakes.rimNoise');
    expect(rimDef).toMatchObject({ remap: 'none', double: true });
    expect(noiseFieldLock(rim, rimDef, 'double')).toBeNull();
    expect(noiseFieldLock(rim, rimDef, 'remap')).toBeNull();
    expect(noiseFieldLock(rim, { ...rimDef, double: false }, 'remap')).toBe("remap 'uniform' needs double: true");
    const rim3: ControlSpec = { ...rim, dims: 3 };
    expect(noiseFieldLock(rim3, rimDef, 'yScale')).toBeNull();
    expect(noiseFieldLock(rim3, rimDef, 'remap')).toBe("remap 'uniform' is for 2D noises");
    for (const f of ['wavelength', 'octaves', 'persistence', 'lacunarity', 'amplitudes', 'clampSigma'] as const) {
      expect(noiseFieldLock(c, def, f)).toBeNull();
    }
  });
});

describe('cross-field lints', () => {
  test('the defaults have no lint', () => {
    expect(paramLints(DEFAULTS)).toEqual([]);
  });

  test('each inverted or equal pair gives one warning naming both leaves', () => {
    expect(paramLints(params({ rivers: { coastFadeLo: 0.1, coastFadeHi: -0.1 } }))).toEqual([{
      paths: ['rivers.coastFadeLo', 'rivers.coastFadeHi'],
      message: 'Coast fade start (0.1) should be below Coast fade end (-0.1): valleys switch on as a step instead of fading in from the coast.',
    }]);
    expect(paramLints(params({ rivers: { altFadeLo: 150, altFadeHi: 150 } }))).toEqual([{
      paths: ['rivers.altFadeLo', 'rivers.altFadeHi'],
      message: 'Gorge start (150) should be below Gorge end (150): channels turn into dry gorges as a step instead of fading.',
    }]);
    expect(paramLints(params({ lakes: { offsetMin: 210 } }))).toEqual([{
      paths: ['lakes.offsetMin', 'lakes.offsetMax'],
      message: 'Lowest centre (210) should be below Highest centre (200): lakes (almost) never form.',
    }]);
  });

  test('several lints come in a fixed order; a fixed pair clears its lint', () => {
    const all = params({ rivers: { coastFadeLo: 0.5, altFadeHi: 64 }, lakes: { offsetMax: 0 } });
    expect(paramLints(all).map((l) => l.paths[0])).toEqual(['rivers.coastFadeLo', 'rivers.altFadeLo', 'lakes.offsetMin']);
    expect(paramLints(params({ rivers: { coastFadeLo: 0.5, coastFadeHi: 0.6 } }))).toEqual([]);
  });
});

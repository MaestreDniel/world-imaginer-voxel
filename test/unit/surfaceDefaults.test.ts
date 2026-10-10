import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type Params, type ParamsPatch, type SurfaceParams } from '../../src/core/params/schema';
import { surfaceFastPath } from '../../src/gen/surface/compile';
import { createSurfaceContext, surfaceContextOf, surfaceNoiseSource } from '../../src/gen/surface/context';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { ruleLeaves, validateRules, type Rule } from '../../src/gen/surface/rules';
import { surfaceScanSettings } from '../../src/gen/surface/scan';
import { resolveRules } from '../../src/gen/surface/source';
import { REGISTRY, STONE } from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { randomValue } from '../harness/params';
import { testRng } from '../harness/stats';
import { registeredKey, withRegisteredBlocks } from '../harness/surfaceFuzz';

const FIXTURE = new URL('../fixtures/sp3c-default-rules.json', import.meta.url);
const fixture = (): unknown => JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
const CTX = ctxFor('42');
const NOISES = surfaceNoiseSource(CTX);
/** The default tree at `params` (SP3d: the `surface.rules` data default resolved, spec §2.2). */
const defaultRulesAt = (params: Params): Rule => resolveRules(DEFAULT_SURFACE_RULES, params);

/** The fixture with the parameters' values substituted (the only numbers §4 takes from `params.surface`). */
function fixtureAt(p: SurfaceParams): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    switch (o['kind']) {
      case 'noiseThreshold':
        if (o['min'] === 0.55) o['min'] = p.patchThreshold;
        if (o['max'] === -0.55) o['max'] = 0 - p.patchThreshold;
        break;
      case 'steep': o['min'] = p.cliffSteep; break;
      case 'yAbove': o['minY'] = p.cliffMinY; break;
      case 'temperatureBelow': o['t'] = p.snowline; break;
      default: break;
    }
    return o;
  };
  return walk(fixture());
}

/** Every rule and condition node of a tree (sequences, conditions, blocks, and the conditions under `if`). */
function nodeCount(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + nodeCount(x), 0);
  if (typeof v !== 'object' || v === null) return 0;
  const o = v as Record<string, unknown>;
  return (typeof o['kind'] === 'string' ? 1 : 0) + Object.values(o).reduce<number>((n, x) => n + nodeCount(x), 0);
}

/** The defaults and every surface leaf's range ends (the variants of the SP3c pins). */
const RANGE_ENDS: readonly Params[] = [
  DEFAULTS,
  paramsWith({ surface: { patchThreshold: 0, snowline: -1, cliffSteep: 0, cliffMinY: -64 } }),
  paramsWith({ surface: { patchThreshold: 3, snowline: 1, cliffSteep: 8, cliffMinY: 319 } }),
];

describe('the default rule tree (spec §4; SP3d: the resolved data default)', () => {
  test('resolveRules(DEFAULT_SURFACE_RULES, DEFAULTS) equals test/fixtures/sp3c-default-rules.json (canonical JSON)', () => {
    expect(canonicalJSON(defaultRulesAt(DEFAULTS))).toBe(canonicalJSON(fixture()));
  });

  test('the leaves in evaluation order, with their ids (Decision 6: bedrock, the sky-open skin, deepslate; bandlands at [1][3][1][1])', () => {
    const leaves = ruleLeaves(defaultRulesAt(DEFAULTS)).map((l) => `${l.id} ${l.rule.kind === 'block' ? l.rule.state : l.rule.kind}`);
    const S = 'root.rules[1].then';
    const W = `${S}.rules[0].then.then`;
    const PAL = `${S}.rules[3].then`;
    const G = `${PAL}.rules[6].then`;
    expect(leaves).toEqual([
      'root.rules[0].then bedrock',
      `${W}.rules[0].then sand`, `${W}.rules[1].then gravel`, `${W}.rules[2].then.then clay`, `${W}.rules[3].then.then clay`,
      `${W}.rules[4].then dirt`, `${W}.rules[5].then.then sand`, `${W}.rules[6].then gravel`, `${W}.rules[7].then sand`, `${W}.rules[8] gravel`,
      `${S}.rules[1].then.then.then.rules[0].then packed_ice`, `${S}.rules[1].then.then.then.rules[1] stone`,
      `${S}.rules[2].then.then snow_block`,
      `${PAL}.rules[0].then sand`,
      `${PAL}.rules[1].then.rules[0].then red_sand`, `${PAL}.rules[1].then.rules[1] bandlands`,
      `${PAL}.rules[2].then.rules[0].then.then gravel`, `${PAL}.rules[2].then.rules[1] stone`,
      `${PAL}.rules[3].then.rules[0].then.then calcite`, `${PAL}.rules[3].then.rules[1] stone`,
      `${PAL}.rules[4].then.rules[0].then.then packed_ice`, `${PAL}.rules[4].then.rules[1].then snow_block`, `${PAL}.rules[4].then.rules[2] stone`,
      `${PAL}.rules[5].then.rules[0].then snow_block`, `${PAL}.rules[5].then.rules[1] stone`,
      `${G}.rules[0].then.then podzol`, `${G}.rules[1].then.then coarse_dirt`, `${G}.rules[2].then.then coarse_dirt`, `${G}.rules[3].then.then podzol`,
      `${G}.rules[4].then.then mud`, `${G}.rules[5].then.then gravel`, `${G}.rules[6].then.then stone`, `${G}.rules[7] grass_block`,
      `${PAL}.rules[7] dirt`,
      `${S}.rules[4].then.rules[0].then sandstone`, `${S}.rules[4].then.rules[1].then red_sandstone`,
      'root.rules[2].then deepslate',
    ]);
    // §6's readout example for a grass_block top.
    expect(leaves).toContain('root.rules[1].then.rules[3].then.rules[6].then.rules[7] grass_block');
  });

  test('the parameters flow in: patchThreshold (P and Pn), snowline, cliffSteep, cliffMinY; the other leaves leave the tree alone', () => {
    const p = paramsWith({ surface: { patchThreshold: 0.8, snowline: -0.35, cliffSteep: 2.5, cliffMinY: 120 } });
    expect(canonicalJSON(defaultRulesAt(p))).toBe(canonicalJSON(fixtureAt(p.surface)));
    expect(canonicalJSON(defaultRulesAt(p))).not.toBe(canonicalJSON(fixture()));
    const q = paramsWith({ surface: { depthMul: 0.4, lapse: 0.01, lapseBase: 100, noises: { depth: { wavelength: 32 }, patch: { octaves: 3 } } } });
    expect(canonicalJSON(defaultRulesAt(q))).toBe(canonicalJSON(fixture()));
  });

  test('patchThreshold 0 writes Pn\'s max as +0, never −0 (canonicalJSON and validateRules accept it)', () => {
    const p = paramsWith({ surface: { patchThreshold: 0 } });
    const tree = defaultRulesAt(p);
    const maxima: number[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v !== 'object' || v === null) return;
      const o = v as Record<string, unknown>;
      if (o['kind'] === 'noiseThreshold' && o['min'] === -8) maxima.push(o['max'] as number);
      Object.values(o).forEach(walk);
    };
    walk(tree);
    expect(maxima.length).toBe(2);
    for (const m of maxima) expect(Object.is(m, 0)).toBe(true);
    expect(() => canonicalJSON(tree)).not.toThrow();
    expect(validateRules(tree, NOISES).filter((i) => i.code === 'NEGATIVE_ZERO')).toEqual([]);
  });

  test('it validates against the schema noises (bandOffset included) and the registry (palette included), at the defaults and at the leaves\' range ends', () => {
    for (const p of RANGE_ENDS) {
      const tree = defaultRulesAt(p);
      expect(validateRules(tree, NOISES)).toEqual([]);
      // Every block key is registered: the stand-in copy is exact.
      expect(canonicalJSON(withRegisteredBlocks(tree))).toBe(canonicalJSON(tree));
    }
    // Far inside §3.1's limits (depth 32, 4096 nodes).
    expect(nodeCount(fixture())).toBeLessThan(200);
    // Without the band leaf (§9's cut) the default tree's bandlands leaf is refused, and only it.
    expect(validateRules(defaultRulesAt(DEFAULTS), (n) => (n === 'surface.noises.bandOffset' ? undefined : NOISES(n))).map((i) => `${i.path} ${i.code}`))
      .toEqual(['root.rules[1].then.rules[3].then.rules[1].then.rules[1] NO_BAND_NOISE']);
  });

  test('its fast path (§3.4): maxSurfaceDepth = SD_MAX + 4 from BAND4, sky-gated, bands y −59 … 0 (deepslate) and 8 … 319 (stone), y −63 … −60 and 1 … 7 evaluated', () => {
    const deepslate = REGISTRY.parseStateKey(registeredKey('deepslate'));
    for (const [patch, sdMax] of [[{}, 11], [{ surface: { depthMul: 0 } }, 3], [{ surface: { depthMul: 2 } }, 19]] as const) {
      const ctx = ctxFor('42', patch);
      const set = surfaceScanSettings(ctx.seed, ctx.params.surface, surfaceNoiseSource(ctx));
      expect(set.sdMax).toBe(sdMax);
      const fp = surfaceFastPath(withRegisteredBlocks(defaultRulesAt(ctx.params)) as Rule, set.sdMax)!;
      expect(fp.maxSurfaceDepth).toBe(sdMax + 4);
      expect(fp.skyGated).toBe(true);
      expect(fp.bands).toEqual([
        { yMin: -63, yMax: -60, dither: true, state: -1 },
        { yMin: -59, yMax: 0, dither: false, state: deepslate },
        { yMin: 1, yMax: 7, dither: true, state: -1 },
        { yMin: 8, yMax: 319, dither: false, state: STONE },
      ]);
    }
  });
});

describe('the data default resolves to the legacy builder\'s tree (SP3d spec §2.2)', () => {
  const legacyAt = (p: Params): unknown => legacyDefaultSurfaceRules(p.surface);

  test('at the defaults, at patchThreshold 0 (+0 in Pn.max) and at every leaf\'s range ends', () => {
    const variants: Params[] = [
      ...RANGE_ENDS,
      paramsWith({ surface: { patchThreshold: 0 } }),
      paramsWith({ surface: { patchThreshold: 3, snowline: -1, cliffSteep: 8, cliffMinY: -64 } }),
      paramsWith({ surface: { patchThreshold: 0, snowline: 1, cliffSteep: 0, cliffMinY: 319 } }),
    ];
    for (const p of variants) expect(canonicalJSON(defaultRulesAt(p))).toBe(canonicalJSON(legacyAt(p)));
  });

  test('at 64 random schema-valid surface groups (noise leaves included, q15 through checkParams)', () => {
    const next = testRng(1010);
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('surface.'));
    for (let t = 0; t < 64; t++) {
      const noises: Record<string, unknown> = {};
      const surface: Record<string, unknown> = { noises };
      for (const { path, leaf } of leaves) {
        const key = path.slice('surface.'.length);
        if (key.startsWith('noises.')) noises[key.slice('noises.'.length)] = randomValue(leaf, next);
        else surface[key] = randomValue(leaf, next);
      }
      const p = paramsWith({ surface } as ParamsPatch);
      expect(canonicalJSON(defaultRulesAt(p)), JSON.stringify(surface)).toBe(canonicalJSON(legacyAt(p)));
    }
  });

  test('the compiled states equal the legacy tree\'s at every voxel of the columns (0, 0), (5, −7), (−68, 100)', () => {
    for (const patch of [{}, { surface: { patchThreshold: 3, snowline: 1, cliffSteep: 8, cliffMinY: 319 } }] as const) {
      const c = ctxFor('42', patch);
      const data = surfaceContextOf(c);
      const legacy = createSurfaceContext(c, legacyAt(c.params));
      const a = new Uint16Array(98304), b = new Uint16Array(98304);
      let written = 0;
      for (const [cx, cz] of [[0, 0], [5, -7], [-68, 100]] as const) {
        a.fill(0xffff);
        b.fill(0xffff);
        data.compiled.fillColumn(surfaceProbeColumn(data, cx, cz).scan, a, true);
        legacy.compiled.fillColumn(surfaceProbeColumn(legacy, cx, cz).scan, b, true);
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) diff++;
          if (a[i] !== 0xffff) written++;
        }
        expect(diff, `column (${cx}, ${cz})`).toBe(0);
      }
      expect(written).toBeGreaterThan(0);
    }
  });
});

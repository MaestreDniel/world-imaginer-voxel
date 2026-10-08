import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { SurfaceParams } from '../../src/core/params/schema';
import { surfaceFastPath } from '../../src/gen/surface/compile';
import { surfaceNoiseSource } from '../../src/gen/surface/context';
import { defaultSurfaceRules } from '../../src/gen/surface/defaults';
import { ruleLeaves, validateRules, type Rule } from '../../src/gen/surface/rules';
import { surfaceScanSettings } from '../../src/gen/surface/scan';
import { REGISTRY, STONE } from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { registeredKey, withRegisteredBlocks } from '../harness/surfaceFuzz';

const FIXTURE = new URL('../fixtures/sp3c-default-rules.json', import.meta.url);
const fixture = (): unknown => JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
const CTX = ctxFor('42');
const NOISES = surfaceNoiseSource(CTX);

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

describe('the default rule tree (spec §4)', () => {
  test('defaultSurfaceRules(params.surface) equals test/fixtures/sp3c-default-rules.json (canonical JSON)', () => {
    expect(canonicalJSON(defaultSurfaceRules(DEFAULTS.surface))).toBe(canonicalJSON(fixture()));
  });

  test('the leaves in evaluation order, with their ids (Decision 6: bedrock, the sky-open skin, deepslate; bandlands at [1][3][1][1])', () => {
    const leaves = ruleLeaves(defaultSurfaceRules(DEFAULTS.surface)).map((l) => `${l.id} ${l.rule.kind === 'block' ? l.rule.state : l.rule.kind}`);
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
    const p = paramsWith({ surface: { patchThreshold: 0.8, snowline: -0.35, cliffSteep: 2.5, cliffMinY: 120 } }).surface;
    expect(canonicalJSON(defaultSurfaceRules(p))).toBe(canonicalJSON(fixtureAt(p)));
    expect(canonicalJSON(defaultSurfaceRules(p))).not.toBe(canonicalJSON(fixture()));
    const q = paramsWith({ surface: { depthMul: 0.4, lapse: 0.01, lapseBase: 100, noises: { depth: { wavelength: 32 }, patch: { octaves: 3 } } } }).surface;
    expect(canonicalJSON(defaultSurfaceRules(q))).toBe(canonicalJSON(fixture()));
  });

  test('patchThreshold 0 writes Pn\'s max as +0, never −0 (canonicalJSON and validateRules accept it)', () => {
    const p = paramsWith({ surface: { patchThreshold: 0 } }).surface;
    const tree = defaultSurfaceRules(p);
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
    const variants: SurfaceParams[] = [
      DEFAULTS.surface,
      paramsWith({ surface: { patchThreshold: 0, snowline: -1, cliffSteep: 0, cliffMinY: -64 } }).surface,
      paramsWith({ surface: { patchThreshold: 3, snowline: 1, cliffSteep: 8, cliffMinY: 319 } }).surface,
    ];
    for (const p of variants) {
      const tree = defaultSurfaceRules(p);
      expect(validateRules(tree, NOISES)).toEqual([]);
      // Every block key is registered: the stand-in copy is exact.
      expect(canonicalJSON(withRegisteredBlocks(tree))).toBe(canonicalJSON(tree));
    }
    // Far inside §3.1's limits (depth 32, 4096 nodes).
    expect(nodeCount(fixture())).toBeLessThan(200);
    // Without the band leaf (§9's cut) the default tree's bandlands leaf is refused, and only it.
    expect(validateRules(defaultSurfaceRules(DEFAULTS.surface), (n) => (n === 'surface.noises.bandOffset' ? undefined : NOISES(n))).map((i) => `${i.path} ${i.code}`))
      .toEqual(['root.rules[1].then.rules[3].then.rules[1].then.rules[1] NO_BAND_NOISE']);
  });

  test('its fast path (§3.4): maxSurfaceDepth = SD_MAX + 4 from BAND4, sky-gated, bands y −59 … 0 (deepslate) and 8 … 319 (stone), y −63 … −60 and 1 … 7 evaluated', () => {
    const deepslate = REGISTRY.parseStateKey(registeredKey('deepslate'));
    for (const [patch, sdMax] of [[{}, 11], [{ surface: { depthMul: 0 } }, 3], [{ surface: { depthMul: 2 } }, 19]] as const) {
      const ctx = ctxFor('42', patch);
      const set = surfaceScanSettings(ctx.seed, ctx.params.surface, surfaceNoiseSource(ctx));
      expect(set.sdMax).toBe(sdMax);
      const fp = surfaceFastPath(withRegisteredBlocks(defaultSurfaceRules(ctx.params.surface)) as Rule, set.sdMax)!;
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

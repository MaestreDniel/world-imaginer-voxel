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
import { newSurfaceScan, scanColumn, surfaceScanSettings } from '../../src/gen/surface/scan';
import { resolveRules } from '../../src/gen/surface/source';
import { caveBiomeOfPass } from '../../src/gen/biomes/cavePicker';
import { BEDROCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import { ctxFor, paramsWith } from '../harness/gen';
import { legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { randomValue } from '../harness/params';
import { testRng } from '../harness/stats';
import { fuzzCavePicker, handCavePass, randomSurfaceColumn, SURFACE_FUZZ_CAVE_SETTINGS, withRegisteredBlocks } from '../harness/surfaceFuzz';
import { gv8SurfaceTrees } from '../harness/gv8Trees';

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

  test('the leaves in evaluation order, with their ids (Decision 6: bedrock, the sky-open skin, SP6b\'s rule 4, deepslate; bandlands at [1][3][1][1])', () => {
    const leaves = ruleLeaves(defaultRulesAt(DEFAULTS)).map((l) => `${l.id} ${l.rule.kind === 'block' ? l.rule.state : l.rule.kind}`);
    const S = 'root.rules[1].then';
    const W = `${S}.rules[0].then.then`;
    const PAL = `${S}.rules[3].then`;
    const G = `${PAL}.rules[6].then`;
    const R4 = 'root.rules[2]';
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
      // SP6b's rule 4 (its spec §3.4): the abyss's ash floors and strata, lush floors, dripstone floors, lush and
      // dripstone ceilings; the deepslate gradient follows it at root.rules[3].
      `${R4}.rules[0].then.rules[0].then.then.then abyss_ash`, `${R4}.rules[0].then.rules[1] strata`,
      `${R4}.rules[1].then.then.rules[0].then clay`, `${R4}.rules[1].then.then.rules[1] moss_block`,
      `${R4}.rules[2].then.then.then dripstone_block`, `${R4}.rules[3].then.then.then moss_block`, `${R4}.rules[4].then.then.then dripstone_block`,
      'root.rules[3].then deepslate',
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
      // The patch noise's (rule 4's cavePatch conditions write −8 too, with literal maxima).
      if (o['kind'] === 'noiseThreshold' && o['noise'] === 'surface.noises.patch' && o['min'] === -8) maxima.push(o['max'] as number);
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
    // Far inside §3.1's limits (depth 32, 4096 nodes): 207 since SP6b's rule 4.
    expect(nodeCount(fixture())).toBe(207);
    // Without the band leaf (§9's cut) the default tree's bandlands leaf is refused, and only it.
    expect(validateRules(defaultRulesAt(DEFAULTS), (n) => (n === 'surface.noises.bandOffset' ? undefined : NOISES(n))).map((i) => `${i.path} ${i.code}`))
      .toEqual(['root.rules[1].then.rules[3].then.rules[1].then.rules[1] NO_BAND_NOISE']);
  });

  test('its fast path (§3.4; SP6b §3.5, rulings P12): maxSurfaceDepth = SD_MAX + 4 from BAND4; rule 4\'s floor and ceiling classes at 1; bands y −59 … 0 and 8 … 319 cut, y −63 … −60 and 1 … 7 evaluated', () => {
    for (const [patch, sdMax] of [[{}, 11], [{ surface: { depthMul: 0 } }, 3], [{ surface: { depthMul: 2 } }, 19]] as const) {
      const ctx = ctxFor('42', patch);
      const set = surfaceScanSettings(ctx.seed, ctx.params.surface, surfaceNoiseSource(ctx));
      expect(set.sdMax).toBe(sdMax);
      const fp = surfaceFastPath(withRegisteredBlocks(defaultRulesAt(ctx.params)) as Rule, set.sdMax)!;
      expect(fp.maxSurfaceDepth).toBe(sdMax + 4);
      // Rule 4's floor leaves (stoneDepth{floor, 1}) and ceiling leaves (stoneDepth{ceiling, 0 | 1}) have no skyOpen
      // gate, so the tree is no longer sky-gated: the sky floor class keeps SD_MAX + 4, the other floor class and the
      // ceiling class are 1; every floor leaf of the non-sky class is gated by caveBiome{floor} (lush, dripstone,
      // abyss: bits 1-3) and every ceiling leaf by caveBiome{ceiling} (lush, dripstone), so the biome-gated skip
      // applies (§3.5 item 3); the abyss branch is here-gated (item 4).
      expect([fp.skyGated, fp.skyFloorBound, fp.floorBound, fp.ceilBound]).toEqual([false, sdMax + 4, 1, 1]);
      expect([fp.floorBiomes, fp.ceilBiomes, fp.here]).toEqual([0b1110, 0b0110, true]);
      // The four bands stay; each non-dither band's state depends on the cave biome (the strata under
      // caveBiome{here}), so it is −1 (Task 15's band rule): the classification decides its voxels.
      expect(fp.bands).toEqual([
        { yMin: -63, yMax: -60, dither: true, state: -1 },
        { yMin: -59, yMax: 0, dither: false, state: -1 },
        { yMin: 1, yMax: 7, dither: true, state: -1 },
        { yMin: 8, yMax: 319, dither: false, state: -1 },
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

describe('rule 4 (SP6b spec §3.4, D21): the cave floors, ceilings and the abyss\'s rock', () => {
  const sc = surfaceContextOf(CTX);
  const PATCH = NOISES('surface.noises.cavePatch')!;
  const key = (s: number): string => REGISTRY.stateKey(s);
  const id = (k: string): number => REGISTRY.parseStateKey(k);
  const STRATA = new Set(['abyss_stone', 'abyss_shale', 'cracked_abyss_stone', 'abyss_stone_veined'].map(id));
  const [MOSS, CLAY, DRIP, ASH, DEEPSLATE] = ['moss_block', 'clay', 'dripstone_block', 'abyss_ash', 'deepslate'].map(id) as [number, number, number, number, number];
  const at = (p: number, y: number): number => 256 * (y + 64) + p;

  /**
   * The hand-built column (cx, cz) = (−186, −200) (chosen so every patch branch occurs: cavePatch is the GenContext's), all
   * plains at T 0.5, no water, no jitter. Rows lz 0-3 lush, 4-7 a plain cave over lush rock, 8-11 dripstone, picked from
   * H′ 0.5 / C′ 0.8 with Y0 100, D 128 (the boxes hold y −15 … 74): ground −63 … 20, cave air 21 … 30 tagged with the
   * band's biome (plain in rows 4-7), an overhang 31 … 60 (its bottom a ceiling of that biome), open sky above; at lx 15
   * a ravine instead: the cave air 21 … 40 open to the sky. Rows 12-15 the abyss (E′ −0.8, C′ 0.2, Y0 100: abyss at
   * y ≤ −28): ground −63 … −40, abyss air −39 … −30, an overhang −29 … 60.
   */
  function rule4Column() {
    const col = randomSurfaceColumn(testRng(2201), { biomes: ['plains'] });
    col.sample.cx = -186;
    col.sample.cz = -200;
    col.solid.fill(0);
    col.water.fill(0);
    col.sample.f.lakeLevel.fill(-Infinity);
    col.sample.f.T.fill(0.5);
    col.sample.f.steep.fill(0);
    const tags = new Uint8Array(98304);
    const fill = (p: number, y0: number, y1: number): void => { for (let y = y0; y <= y1; y++) col.solid[at(p, y)] = 1; };
    const tag = (p: number, y0: number, y1: number, b: number): void => { for (let y = y0; y <= y1; y++) tags[at(p, y)] = 1 | (b << 4); };
    for (let p = 0; p < 256; p++) {
      col.solid[at(p, -64)] = 1;
      const band = p >> 6;
      if (band === 3) {
        fill(p, -63, -40);
        tag(p, -39, -30, 3);
        fill(p, -29, 60);
        continue;
      }
      const b = [1, 0, 2][band]!;
      fill(p, -63, 20);
      if ((p & 15) === 15) { tag(p, 21, 40, b); continue; }
      tag(p, 21, 30, b);
      fill(p, 31, 60);
    }
    const settings = { ...SURFACE_FUZZ_CAVE_SETTINGS, edgeJitter: 0 };
    const pass = handCavePass(-186, -200, 0, (_x, z) => {
      const band = Math.min(15, Math.max(0, z + 3200)) >> 2;
      return band === 3 ? { c: 0.2, e: -0.8, h: 0, y0: 100 } : band === 2 ? { c: 0.8, e: 0, h: 0, y0: 100 } : { c: 0, e: 0, h: 0.5, y0: 100 };
    });
    const inputs = fuzzCavePicker(settings);
    const scan = scanColumn(newSurfaceScan(), sc.settings, col.sample, col.solid, col.water, col.biomes, tags, { inputs, pass });
    return { col, scan, inputs, pass };
  }

  test('on hand-built columns: moss and clay on lush floors, none under a plain cave over lush rock, dripstone, moss ceilings, the abyss\'s strata and ash', () => {
    const { col, scan, inputs, pass } = rule4Column();
    const out = new Uint16Array(98304).fill(0xffff);
    sc.compiled.fillColumn(scan, out, true);
    const full = new Uint16Array(98304).fill(0xffff);
    sc.compiled.fillColumn(scan, full, false);
    expect(Buffer.from(out.buffer).equals(Buffer.from(full.buffer))).toBe(true);
    const gv8 = createSurfaceContext(CTX, resolveRules(gv8SurfaceTrees().default, DEFAULTS));
    const seen = { clay: 0, moss: 0, plainLush: 0, bare: 0, drip: 0, ceilMoss: 0, ceilBare: 0, ash: 0, abyssRock: 0, strata: new Set<number>(), ravine: 0 };
    for (let p = 0; p < 256; p++) {
      const x = -2976 + (p & 15), z = -3200 + (p >> 4);
      const v = PATCH.z2(x, z);
      const s = (y: number): number => out[at(p, y)]!;
      const band = p >> 6;
      // The reference agrees at every solid voxel, and rule 4 never places grass, snow or red sand.
      for (let y = -63; y <= 60; y++) {
        if (col.solid[at(p, y)] === 0) continue;
        const r = sc.reference.evaluate(scan, sc.settings, p, y);
        expect(r.state, `p ${p} y ${y}`).toBe(s(y));
        if (r.path.includes('root.rules[2]')) expect(['grass_block', 'snow_block', 'red_sand']).not.toContain(key(r.state));
      }
      if (band === 3) {
        // The abyss: every solid voxel the picker calls abyss that rule 1 does not take is a strata state, except the
        // floor's top two voxels where cavePatch ≥ −0.84 (abyss_ash); never stone or deepslate.
        for (let y = -63; y <= 60; y++) {
          if (col.solid[at(p, y)] === 0) continue;
          const abyss = caveBiomeOfPass(inputs, pass, x, y, z) === 3;
          expect(abyss, `p ${p} y ${y}`).toBe(y <= -28);
          if (!abyss || sc.reference.evaluate(scan, sc.settings, p, y).path[1] === 'root.rules[0]') continue;
          const ashFloor = (y === -40 || y === -41) && v >= -0.84;
          if (ashFloor) { expect(s(y)).toBe(ASH); seen.ash++; continue; }
          expect(STRATA.has(s(y)), `p ${p} y ${y}: ${key(s(y))}`).toBe(true);
          seen.strata.add(s(y));
          seen.abyssRock++;
        }
        continue;
      }
      expect(caveBiomeOfPass(inputs, pass, x, 20, z)).toBe(band === 2 ? 2 : 1);
      // Nothing on a ceiling resting on the bedrock (its run has no ceiling biome): rule 1's bedrock or rule 2's deepslate.
      for (const y of [-63, -62]) expect([BEDROCK, DEEPSLATE]).toContain(s(y));
      if ((p & 15) === 15) {
        // A ravine: its floor run is the sky-open one, so wherever the sky-open rule yields it keeps the surface palette.
        for (let y = -58; y <= 20; y++) {
          const g = gv8.reference.evaluate(scan, gv8.settings, p, y);
          if (g.path[1] !== 'root.rules[1]') continue;
          expect(sc.reference.evaluate(scan, sc.settings, p, y)).toEqual(g);
          seen.ravine++;
        }
        expect(gv8.reference.evaluate(scan, gv8.settings, p, 20).path[1]).toBe('root.rules[1]');
        continue;
      }
      if (band === 0) {
        // Lush: moss two deep on the floor, clay where cavePatch ≥ 0.84; moss on the ceiling where cavePatch ≥ −0.52.
        for (const y of [20, 19]) expect(s(y)).toBe(v >= 0.84 ? CLAY : MOSS);
        expect(s(18)).toBe(STONE);
        expect(s(31)).toBe(v >= -0.52 ? MOSS : STONE);
        expect(s(32)).toBe(STONE);
        if (v >= 0.84) seen.clay++; else seen.moss++;
        if (v >= -0.52) seen.ceilMoss++;
      } else if (band === 1) {
        // A plain cave over lush rock: no moss, no clay.
        for (const y of [20, 19, 31, 32]) expect(s(y)).toBe(STONE);
        seen.plainLush++;
      } else {
        // Dripstone: two deep on the floor and the ceiling, bare stone where cavePatch ≤ −0.97.
        for (const y of [20, 19, 31, 32]) expect(s(y)).toBe(v <= -0.97 ? STONE : DRIP);
        expect([s(18), s(33)]).toEqual([STONE, STONE]);
        if (v <= -0.97) seen.bare++; else seen.drip++;
      }
    }
    // Every branch occurs in this column: some lush ceilings bare (60 lush positions), some abyss floors without ash
    // (64 positions, two voxels each).
    expect(Math.min(seen.clay, seen.moss, seen.plainLush, seen.bare, seen.drip, seen.ceilMoss, seen.ash, seen.ravine)).toBeGreaterThan(0);
    expect(seen.ceilMoss).toBeLessThan(60);
    expect(seen.ash).toBeLessThan(128);
    // The layers alternate: three of the four states over these 36 levels (abyss_stone_veined is a tenth of the draws).
    expect(seen.strata.size).toBe(3);
    // Per position: the floor run −58 … −42 and the overhang's −29 and −28 at least (rule 1 dithers −63 … −59).
    expect(seen.abyssRock).toBeGreaterThan(64 * 19);
  });

  /**
   * The thresholds are z2 values chosen for z2 ≈ N(0, 1) (spec §3.4): the shares 1 − Φ(0.84) = 0.2005 (lush clay),
   * 1 − Φ(−0.52) = 0.6985 (lush ceiling moss), 1 − Φ(−0.84) = 0.7995 (abyss ash) and Φ(−0.97) = 0.1660 (dripstone bare
   * stone). They are gated on the noise itself, on two disjoint 400 × 400 grids 13 blocks apart (a step longer than the
   * noise's 12-block wavelength, so the samples are close to independent; 160,000 points give a binomial σ ≤ 0.0012).
   */
  const PATCH_SHARES = { clay: 0.2005, ceilMoss: 0.6985, ash: 0.7995, bare: 0.166 };
  test.each([[0, 0], [-60_000, 45_000]])('the cavePatch noise\'s threshold shares follow z2 ≈ N(0, 1) (a 400 × 400 grid from (%i, %i))', (x0, z0) => {
    let clay = 0, ceilMoss = 0, ash = 0, bare = 0;
    for (let i = 0; i < 400; i++) {
      for (let j = 0; j < 400; j++) {
        const v = PATCH.z2(x0 + 13 * i, z0 + 13 * j);
        if (v >= 0.84) clay++;
        if (v >= -0.52) ceilMoss++;
        if (v >= -0.84) ash++;
        if (v <= -0.97) bare++;
      }
    }
    const share = { clay: clay / 160_000, ceilMoss: ceilMoss / 160_000, ash: ash / 160_000, bare: bare / 160_000 };
    console.log(`cavePatch threshold shares from (${x0}, ${z0}): ${JSON.stringify(share)}`);
    for (const k of ['clay', 'ceilMoss', 'ash', 'bare'] as const) expect(Math.abs(share[k] - PATCH_SHARES[k]), k).toBeLessThanOrEqual(0.01);
  });

  /**
   * 64 columns of seed '42' on an 8 × 8 grid 4,000 blocks apart: their caves hold every biome (the abyss's floors in 8 of
   * them). Their shares are recorded, not gated: the patch noise varies over 12 blocks, so a cavern's floor is a few
   * samples, not hundreds, and equally valid 64-column sets read shares about ±0.1 apart. The test asserts each class has
   * a sample, both outcomes occur and rule 4 places only its own states there.
   */
  const GRID: ReadonlyArray<readonly [number, number]> = Array.from({ length: 64 }, (_, k) => [-1000 + 250 * (k % 8), -1000 + 250 * (k >> 3)] as const);

  test('over 64 generated columns: every patch branch occurs on lush, dripstone and abyss floors and lush ceilings (shares recorded)', () => {
    const n = { lushFloor: 0, clay: 0, lushCeil: 0, ceilMoss: 0, abyssFloor: 0, ash: 0, dripFloor: 0, bare: 0 };
    const out = new Uint16Array(98304);
    for (const [cx, cz] of GRID) {
      const c = surfaceProbeColumn(sc, cx, cz);
      const scan = c.scan;
      out.fill(0xffff);
      sc.compiled.fillColumn(scan, out, true);
      for (let p = 0; p < 256; p++) {
        const x = 16 * cx + (p & 15), z = 16 * cz + (p >> 4);
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          if (r === scan.skyRun[p]) continue;
          const top = scan.runTop[r]!, bottom = scan.runBottom[r]!;
          const here = (y: number): number => caveBiomeOfPass(scan.cavePicker!, scan.cavePass!, x, y, z);
          // A floor's top voxel (above the bedrock gradient): lush, dripstone (not in the abyss's rock) or abyss.
          if (top > -59) {
            const s = out[at(p, top)]!, f = scan.runFloorBiome[r]!, h = here(top);
            if (f === 1 && h !== 3) { n.lushFloor++; if (s === CLAY) n.clay++; else expect(s).toBe(MOSS); }
            if (f === 2 && h !== 3) { n.dripFloor++; if (s !== DRIP) n.bare++; }
            if (f === 3 && h === 3) { n.abyssFloor++; if (s === ASH) n.ash++; else expect(STRATA.has(s)).toBe(true); }
            expect(['grass_block', 'snow_block', 'red_sand']).not.toContain(key(s));
          }
          // A lush ceiling's bottom voxel that no earlier branch takes (a run more than two deep, not in the abyss).
          if (scan.runCeilBiome[r] === 1 && bottom > -59 && top - bottom > 1 && here(bottom) !== 3) {
            n.lushCeil++;
            if (out[at(p, bottom)] === MOSS) n.ceilMoss++;
          }
        }
      }
    }
    const share = { clay: n.clay / n.lushFloor, ceilMoss: n.ceilMoss / n.lushCeil, ash: n.ash / n.abyssFloor, bare: n.bare / n.dripFloor };
    console.log(`rule 4's patch shares over 64 columns: ${JSON.stringify(n)} → ${JSON.stringify(share)}`);
    expect(Math.min(n.lushFloor, n.lushCeil, n.abyssFloor, n.dripFloor)).toBeGreaterThan(100);
    for (const k of ['clay', 'ceilMoss', 'ash', 'bare'] as const) {
      expect(share[k], k).toBeGreaterThan(0);
      expect(share[k], k).toBeLessThan(1);
    }
  }, 120_000);
});

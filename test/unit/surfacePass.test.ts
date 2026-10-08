import { describe, expect, test } from 'vitest';
import { biomeId, biomeName, type SurfaceBiome } from '../../src/gen/biomes/registry';
import { buildColumnSample, nearestCornerIndex, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { surfaceContextOf, type SurfaceContext } from '../../src/gen/surface/context';
import { surfacePass } from '../../src/gen/surface/pass';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { newSurfaceScan, scanColumn, tEff, type SurfaceScan } from '../../src/gen/surface/scan';
import {
  BEDROCK, CLAY, DEEPSLATE, DIRT, GRASS_BLOCK, GRAVEL, PACKED_ICE, REGISTRY, SAND, SANDSTONE, SNOW_BLOCK, STONE,
} from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';

const MiB = 1 << 20;
const NEVER = () => false;
const CTX = ctxFor('42');
const SC: SurfaceContext = surfaceContextOf(CTX);
const P = CTX.params.surface;

/**
 * Columns of world seed '42' (default profile), found by a scan of the 2D biomes and the T stage (SP3c dry run): the
 * terrainStage fixtures LAND (windswept_hills: grass, gravel and stone patches, stone cliffs), RIVER (meadow grass and
 * a river bed with clay), SEA and OVERHANG (runs without sky); DESERT (all 256 positions desert, sand over sandstone),
 * SNOW (snowy_taiga, every top under the snowline), FROZEN (frozen_peaks cliffs of packed ice, runs without sky) and
 * JAGGED (jagged_peaks stone cliffs and snowy_slopes snow). The tests count what they rely on, so a world change that
 * moves these away fails loudly.
 */
const LAND = [-1963, -2000] as const;
const RIVER = [-742, -2000] as const;
const SEA = [-2000, -2000] as const;
const OVERHANG = [-1238, -2000] as const;
const DESERT = [610, -1024] as const;
const SNOW = [-530, -1008] as const;
const FROZEN = [-495, -1008] as const;
const JAGGED = [-384, -1024] as const;
const REAL = [['land', LAND], ['river', RIVER], ['sea', SEA], ['overhang', OVERHANG], ['desert', DESERT], ['snow', SNOW], ['frozen', FROZEN], ['jagged', JAGGED]] as const;

const key = (state: number): string => REGISTRY.stateKey(state);
const ids = (...names: SurfaceBiome[]): Set<number> => new Set(names.map((n) => biomeId(n)));
/** §4 [1][3][6]: grassy biomes without a top patch rule (their top is grass_block, the rest of the skin dirt). */
const GRASSY_PLAIN = ids('plains', 'meadow', 'forest', 'birch_forest', 'dark_forest', 'snowy_plains');
/** §4 [1][4]: the biomes with a block 4 below the skin. */
const BAND4 = ids('desert', 'beach', 'snowy_beach', 'badlands');

function generate(cx: number, cz: number): ColumnView {
  const store = createStore({ shared: false, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB });
  const w = store.claimColumn(cx, cz, 0);
  expect(terrainStage(CTX, cx, cz, w, NEVER)).toBe(true);
  w.commit(1);
  return store.proto(cx, cz)!;
}

/** The states the deepslate rule [2] or stone (no rule) leave at y: what every voxel below the skin gets. */
function belowSkin(y: number): readonly number[] {
  if (y <= -60) return [BEDROCK, DEEPSLATE];
  if (y <= 0) return [DEEPSLATE];
  if (y <= 7) return [DEEPSLATE, STONE];
  return [STONE];
}

interface Seen {
  grassOverDirt: number;
  desertSandstone: number;
  snowTops: number;
  cliffStone: number;
  cliffIce: number;
  clay: number;
  deepslateBelowSkin: number;
  noSkyStoneAbove8: number;
  ditherBedrock: number;
  ditherDeepslate: number;
  checked: number;
}

/**
 * The default tree's outcome (§4) on a column, read back from `block(p, y)` with the scan's readouts, written
 * independently of the rule tree: bedrock and its dither, deepslate below the skin and in runs without sky, the
 * snowline, cliffs, the desert's sand over sandstone, grass over dirt, grass and snow only on the top voxel of a
 * sky-open run. Returns the problems (first 20) and fills `seen`.
 */
function checkColumn(scan: SurfaceScan, block: (p: number, y: number) => number, seen: Seen): string[] {
  const bad: string[] = [];
  const expectIn = (p: number, y: number, ok: readonly number[], why: string): void => {
    seen.checked++;
    const b = block(p, y);
    if (!ok.includes(b) && bad.length < 20) bad.push(`p ${p} y ${y}: ${key(b)}, expected ${ok.map(key).join(' or ')} (${why})`);
  };
  for (let p = 0; p < 256; p++) {
    const sd = scan.surfaceDepth[p]!;
    const biome = scan.biome[p]!;
    const r0 = scan.runFirst[p]!;
    for (let y = -63; y <= -60; y++) {
      const b = block(p, y);
      if (b === BEDROCK) seen.ditherBedrock++;
      if (b === DEEPSLATE) seen.ditherDeepslate++;
    }
    for (let r = r0; r < scan.runFirst[p + 1]!; r++) {
      const top = scan.runTop[r]!;
      const sky = r === r0;
      const dry = scan.runWaterAbove[r] === 0;
      const cliff = dry && scan.steep[p]! >= P.cliffSteep && top >= P.cliffMinY;
      const snow = tEff(scan.T[p]!, top, P.lapse, P.lapseBase) < P.snowline;
      for (let y = top; y >= scan.runBottom[r]!; y--) {
        const fd = top - y;
        const b = block(p, y);
        if (b === GRASS_BLOCK && !(sky && fd === 0 && dry && !snow)) bad.push(`p ${p} y ${y}: grass_block off a dry sky-open top under the snowline`);
        if (b === SNOW_BLOCK && !(sky && fd === 0)) bad.push(`p ${p} y ${y}: snow_block off a sky-open top`);
        if (b === CLAY) seen.clay++;
        if (!sky) {
          expectIn(p, y, belowSkin(y), 'run without sky');
          if (y >= 8) seen.noSkyStoneAbove8++;
          continue;
        }
        if (fd > sd + 4 || (fd > sd && !BAND4.has(biome))) {
          expectIn(p, y, belowSkin(y), 'below the skin');
          if (b === DEEPSLATE && y > -60) seen.deepslateBelowSkin++;
          continue;
        }
        if (!dry) continue;
        if (cliff) {
          if (fd <= sd) {
            const ice = biome === biomeId('frozen_peaks');
            expectIn(p, y, [ice ? PACKED_ICE : STONE], 'cliff skin');
            if (fd === 0) ice ? seen.cliffIce++ : seen.cliffStone++;
          }
          continue;
        }
        if (fd === 0 && snow) {
          expectIn(p, y, [SNOW_BLOCK], 'top under the snowline');
          seen.snowTops++;
          continue;
        }
        if (biome === biomeId('desert')) {
          expectIn(p, y, [fd <= sd ? SAND : SANDSTONE], fd <= sd ? 'desert skin' : 'desert band');
          if (fd === sd + 1) seen.desertSandstone++;
        } else if (GRASSY_PLAIN.has(biome)) {
          if (fd === 0) expectIn(p, y, [GRASS_BLOCK], 'grassy top');
          else if (fd <= sd) {
            expectIn(p, y, [DIRT], 'grassy skin');
            if (fd === 1 && block(p, top) === GRASS_BLOCK) seen.grassOverDirt++;
          }
        }
      }
    }
  }
  return bad;
}

const newSeen = (): Seen => ({
  grassOverDirt: 0, desertSandstone: 0, snowTops: 0, cliffStone: 0, cliffIce: 0, clay: 0, deepslateBelowSkin: 0,
  noSkyStoneAbove8: 0, ditherBedrock: 0, ditherDeepslate: 0, checked: 0,
});

describe('surfacePass (spec §1 step 5)', () => {
  test.each(REAL)('%s: scan + compiled tree with the fast path; equals full evaluation, writes only solid voxels', (_name, [cx, cz]) => {
    const c = surfaceProbeColumn(SC, cx, cz);
    const s = SC.density.columns.get(cx, cz);
    const out = new Uint16Array(98304).fill(0xffff);
    const scan = newSurfaceScan();
    const evaluated = surfacePass(SC, s, c.solid, c.water, c.biomes, out, scan);
    expect([scan.cx, scan.cz]).toEqual([cx, cz]);
    // The pass's own scan gives the same output and count.
    const own = new Uint16Array(98304).fill(0xffff);
    expect(surfacePass(SC, s, c.solid, c.water, c.biomes, own)).toBe(evaluated);
    expect(own).toEqual(out);
    const full = new Uint16Array(98304).fill(0xffff);
    expect(SC.compiled.fillColumn(scan, full, false)).toBeGreaterThan(evaluated);
    let bad = 0, solid = 0;
    for (let i = 0; i < 98304; i++) {
      if (i < 256 || c.solid[i] === 0) {
        if (out[i] !== 0xffff) bad++;
      } else {
        solid++;
        if (out[i] !== full[i]) bad++;
      }
    }
    expect(bad).toBe(0);
    // The fast path takes most solid voxels (every column here has a deep stone body).
    expect(evaluated).toBeLessThan(solid / 2);
  });

  test('array sizes are checked', () => {
    const c = surfaceProbeColumn(SC, ...LAND);
    const s = SC.density.columns.get(...LAND);
    expect(() => surfacePass(SC, s, c.solid, c.water, c.biomes, new Uint16Array(4096))).toThrow(RangeError);
    expect(() => surfacePass(SC, s, c.solid, c.water, new Uint8Array(16), new Uint16Array(98304))).toThrow(RangeError);
  });
});

describe('the default tree on real columns (spec §4, §8)', () => {
  test('bedrock and its dither, deepslate below the skin, the snowline, cliffs, sand over sandstone, grass over dirt, clay in a river bed (the stage\'s blocks)', () => {
    const seen = newSeen();
    const problems: string[] = [];
    for (const [name, [cx, cz]] of REAL) {
      const view = generate(cx, cz);
      const scan = surfaceProbeColumn(SC, cx, cz).scan;
      for (let p = 0; p < 256; p++) expect(view.block(p & 15, -64, p >> 4)).toBe(BEDROCK);
      for (const m of checkColumn(scan, (p, y) => view.block(p & 15, y, p >> 4), seen)) problems.push(`${name}: ${m}`);
    }
    expect(problems.slice(0, 20)).toEqual([]);
    // Every case was met on these columns (counts at seed '42': see the fixtures' comment).
    expect(seen.grassOverDirt).toBeGreaterThan(50);
    expect(seen.desertSandstone).toBeGreaterThan(200);
    expect(seen.snowTops).toBeGreaterThan(300);
    expect(seen.cliffStone).toBeGreaterThan(100);
    expect(seen.cliffIce).toBeGreaterThan(50);
    expect(seen.clay).toBeGreaterThan(10);
    expect(seen.deepslateBelowSkin).toBeGreaterThan(100_000);
    expect(seen.noSkyStoneAbove8).toBeGreaterThan(100);
    // The bedrock dither over y −63 … −60 shows both states.
    expect(seen.ditherBedrock).toBeGreaterThan(500);
    expect(seen.ditherDeepslate).toBeGreaterThan(500);
  });

  test('grass_block tops of snowy biomes appear only where T_eff ≥ snowline; snowy_taiga is snow-topped', () => {
    const scan = surfaceProbeColumn(SC, ...SNOW).scan;
    const view = generate(...SNOW);
    let snowy = 0;
    for (let p = 0; p < 256; p++) {
      expect(biomeName(scan.biome[p]!)).toBe('snowy_taiga');
      const top = scan.runTop[scan.runFirst[p]!]!;
      expect(tEff(scan.T[p]!, top, P.lapse, P.lapseBase)).toBeLessThan(P.snowline);
      expect(view.block(p & 15, top, p >> 4)).toBe(SNOW_BLOCK);
      if (view.block(p & 15, top - 1, p >> 4) === DIRT) snowy++;
    }
    // Under the snow, the grassy biome's skin is dirt.
    expect(snowy).toBeGreaterThan(100);
  });

  test('lake beds (§4 [1][0], §8): clay where P holds, sand in the shallows, gravel past 10, sand within 10 of the water top; the bed keeps its land biome', () => {
    /**
     * Lake columns of seed '42' (found by a scan of the lake around the terrainStage LAKE fixture and of islet-1's
     * perched lake, §11): LAKE (−1001, −2000) and its neighbours (−1000, −2000) and (−1002, −2001), a birch_forest lake
     * at water level 82, and (−1021, −661), a lake perched at water level 101 in an ocean-biome area.
     */
    const LAKES = [[-1001, -2000], [-1000, -2000], [-1002, -2001]] as const;
    const PERCHED = [-1021, -661] as const;
    /** §4 [1][0]'s list (its leaf ids under `U`), written from the spec: index and state of the yielding entry. */
    const U = 'root.rules[1].then.rules[0].then.then';
    const leafId = (i: number): string => (i === 2 || i === 3 || i === 5 ? `${U}.rules[${i}].then.then` : i === 8 ? `${U}.rules[8]` : `${U}.rules[${i}].then`);
    const SAND_SEA = ids('warm_ocean', 'beach', 'snowy_beach');
    const GRAVEL_SEA = ids('deep_ocean', 'frozen_ocean');
    const RIVERS = ids('river', 'frozen_river');
    const NOT_LAND = ids('ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean', 'river', 'frozen_river', 'beach', 'snowy_beach', 'stony_shore');
    const patch = SC.noises('surface.noises.patch')!;
    const underWater = (biome: number, lake: boolean, p: boolean, depth: number, y: number, waterTop: number): readonly [number, number] => {
      if (SAND_SEA.has(biome)) return [0, SAND];
      if (GRAVEL_SEA.has(biome)) return [1, GRAVEL];
      if ((RIVERS.has(biome) || biome === biomeId('swamp')) && p) return [2, CLAY];
      if (lake && p) return [3, CLAY];
      if (RIVERS.has(biome)) return [4, DIRT];
      if (lake && depth <= 2) return [5, SAND];
      if (depth > 10) return [6, GRAVEL];
      return y >= waterTop - 10 ? [7, SAND] : [8, GRAVEL];
    };
    const tops = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const problems: string[] = [];
    let lakeBeds = 0, perched = 0, checked = 0;
    for (const [cx, cz] of [...LAKES, PERCHED]) {
      const view = generate(cx, cz);
      const scan = surfaceProbeColumn(SC, cx, cz).scan;
      const sample = SC.density.columns.get(cx, cz);
      for (let p = 0; p < 256; p++) {
        const x = 16 * cx + (p & 15), z = 16 * cz + (p >> 4);
        const r = scan.runFirst[p]!;
        const lake = Number.isFinite(sample.f.lakeLevel[nearestCornerIndex(sample, x, z)]!);
        if (scan.runWaterAbove[r] !== 1 || !lake) continue;
        const top = scan.runTop[r]!, waterTop = scan.runWaterTop[r]!, biome = scan.biome[p]!;
        const P_ = patch.z2(x, z) >= P.patchThreshold;
        if (cx === PERCHED[0]) {
          perched++;
          expect(waterTop).toBe(101);
        } else {
          lakeBeds++;
          if (NOT_LAND.has(biome) && problems.length < 20) problems.push(`(${x}, ${z}): lake bed biome ${biomeName(biome)}`);
        }
        for (let y = top; y >= Math.max(top - scan.surfaceDepth[p]!, scan.runBottom[r]!); y--) {
          const [i, state] = underWater(biome, lake, P_, waterTop - top, y, waterTop);
          const got = view.block(p & 15, y, p >> 4);
          const leaf = SC.reference.evaluate(scan, SC.settings, p, y).path.at(-1);
          checked++;
          if ((got !== state || leaf !== leafId(i)) && problems.length < 20) problems.push(`(${x}, ${y}, ${z}): ${key(got)} by ${leaf}, expected ${key(state)} by [1][0][${i}]`);
          if (y === top) tops[i]!++;
        }
      }
    }
    expect(problems).toEqual([]);
    // Every lake case is met on the top voxels (counts at seed '42': clay 124, depth ≤ 2 sand 20, gravel 226, sand 654).
    expect(lakeBeds).toBeGreaterThan(700);
    expect(perched).toBe(256);
    expect(tops[3]).toBeGreaterThan(50);
    expect(tops[5]).toBeGreaterThan(10);
    expect(tops[6]).toBeGreaterThan(100);
    expect(tops[7]).toBeGreaterThan(300);
    expect(checked).toBeGreaterThan(3000);
  });

  test('surface params at their ends: surfaceDepth ≤ SD_MAX, maxSurfaceDepth = SD_MAX + 4, and the pass (fast path) equals full evaluation', () => {
    // (−1916, −2010) and (−2031, −2010): where the depth noise peaks (skins deeper than 15 at depthMul 2).
    const columns = [LAND, RIVER, SEA, [-1916, -2010], [-2031, -2010]] as const;
    let deepest = 0;
    for (const [patch, sdMax] of [
      [{ surface: { depthMul: 0 } }, 3],
      [{ surface: { depthMul: 2, noises: { depth: { clampSigma: 8 } } } }, 47],
      [{ surface: { depthMul: 1.35, noises: { depth: { clampSigma: 6.7 } } } }, 28],
      [{ surface: { lapse: 0.05, lapseBase: -64, cliffSteep: 0, cliffMinY: -64, patchThreshold: 0, snowline: 1 } }, 11],
    ] as const) {
      const sc = surfaceContextOf(ctxFor('42', patch));
      expect(sc.settings.sdMax).toBe(sdMax);
      expect(sc.compiled.fastPath?.maxSurfaceDepth).toBe(sdMax + 4);
      for (const [cx, cz] of columns) {
        const c = surfaceProbeColumn(sc, cx, cz);
        for (let p = 0; p < 256; p++) {
          expect(c.scan.surfaceDepth[p]).toBeLessThanOrEqual(sdMax);
          deepest = Math.max(deepest, c.scan.surfaceDepth[p]!);
        }
        const out = new Uint16Array(98304).fill(0xffff);
        const scan = newSurfaceScan();
        surfacePass(sc, sc.density.columns.get(cx, cz), c.solid, c.water, c.biomes, out, scan);
        const full = new Uint16Array(98304).fill(0xffff);
        sc.compiled.fillColumn(scan, full, false);
        let bad = 0;
        for (let i = 256; i < 98304; i++) if (c.solid[i] !== 0 && out[i] !== full[i]) bad++;
        expect(bad, `(${cx}, ${cz})`).toBe(0);
      }
    }
    // The depth noise reaches past the default's maxSurfaceDepth 15 here (measured: 19).
    expect(deepest).toBeGreaterThan(15);
  });
});

/**
 * Hand-built columns on a real ColumnSample (LAND's: warm, no lake corner) with their own solidity, water and biome
 * buffer, through `surfacePass`: Decision 6's order on skin voxels at y ≤ 0, and runs without sky.
 */
describe('hand-built columns (spec §8: Decision 6, runs without sky)', () => {
  const sample: ColumnSample = buildColumnSample(CTX, LAND[0], LAND[1], newColumnSample());

  test('the sample is warm and has no lake corner (so only the hand-built data decides)', () => {
    for (let p = 0; p < 256; p++) {
      const x = 16 * LAND[0] + (p & 15), z = 16 * LAND[1] + (p >> 4);
      expect(sample.f.lakeLevel[nearestCornerIndex(sample, x, z)]).toBe(-Infinity);
    }
    const scan = surfaceProbeColumn(SC, ...LAND).scan;
    for (let p = 0; p < 256; p++) expect(scan.T[p]).toBeGreaterThan(P.snowline);
  });

  /** Runs the pass over `fill(p, y)` (1 solid, 2 water, 0 air) with `biomeOf(p)`; returns the output and the scan. */
  function pass(fill: (p: number, y: number) => number, biomeOf: (p: number) => SurfaceBiome): { out: Uint16Array; scan: SurfaceScan; solid: Uint8Array } {
    const solid = new Uint8Array(98304), water = new Uint8Array(98304), biomes = new Uint8Array(256);
    for (let p = 0; p < 256; p++) {
      biomes[p] = biomeId(biomeOf(p));
      for (let y = -63; y <= 319; y++) {
        const v = fill(p, y);
        solid[((y + 64) << 8) | p] = v === 1 ? 1 : 0;
        water[((y + 64) << 8) | p] = v === 2 ? 1 : 0;
      }
    }
    const out = new Uint16Array(98304);
    const scan = newSurfaceScan();
    surfacePass(SC, sample, solid, water, biomes, out, scan);
    // The same column scanned apart and fully evaluated agrees with the fast path.
    const full = new Uint16Array(98304);
    SC.compiled.fillColumn(scanColumn(newSurfaceScan(), SC.settings, sample, solid, water, biomes), full, false);
    for (let i = 256; i < 98304; i++) if (solid[i] !== 0 && full[i] !== out[i]) throw new Error(`voxel ${i}: fast ${out[i]} ≠ full ${full[i]}`);
    return { out, scan, solid };
  }
  const at = (out: Uint16Array, p: number, y: number): number => out[((y + 64) << 8) | p]!;

  test('a dry top below y 0 (plains and desert): the skin keeps its surface blocks at y ≤ 0, deepslate starts at surfaceDepth + 1 (+ 5 in the desert)', () => {
    const topOf = (p: number) => -10 - (p % 8);
    const { out, scan } = pass((p, y) => (y <= topOf(p) ? 1 : 0), (p) => (p < 128 ? 'plains' : 'desert'));
    let skin = 0, band = 0, deep = 0;
    for (let p = 0; p < 256; p++) {
      const sd = scan.surfaceDepth[p]!;
      const desert = p >= 128;
      const deepFrom = desert ? sd + 5 : sd + 1;
      for (let y = topOf(p); y >= -59; y--) {
        const fd = topOf(p) - y;
        const want = fd === 0 ? (desert ? SAND : GRASS_BLOCK) : fd <= sd ? (desert ? SAND : DIRT) : fd < deepFrom ? SANDSTONE : DEEPSLATE;
        expect(key(at(out, p, y)), `p ${p} y ${y} fd ${fd} sd ${sd}`).toBe(key(want));
        if (fd <= sd) skin++; else if (fd < deepFrom) band++; else deep++;
      }
    }
    // Both halves have skins several voxels deep below y 0, and the desert its four sandstone voxels.
    expect(skin).toBeGreaterThan(256 * 2);
    expect(band).toBe(128 * 4);
    expect(deep).toBeGreaterThan(0);
  });

  test('a deep ocean floor whose skin reaches below y 0: gravel (deep_ocean) and sand (warm_ocean) down to surfaceDepth, then deepslate', () => {
    const topOf = (p: number) => -2 - (p % 6);
    const { out, scan } = pass((p, y) => (y <= topOf(p) ? 1 : y <= 63 ? 2 : 0), (p) => (p < 128 ? 'deep_ocean' : 'warm_ocean'));
    let below0 = 0;
    for (let p = 0; p < 256; p++) {
      const r0 = scan.runFirst[p]!;
      expect([scan.runWaterAbove[r0], scan.runWaterTop[r0]]).toEqual([1, 63]);
      const sd = scan.surfaceDepth[p]!;
      for (let y = topOf(p); y >= -59; y--) {
        const fd = topOf(p) - y;
        const want = fd <= sd ? (p < 128 ? GRAVEL : SAND) : DEEPSLATE;
        expect(key(at(out, p, y)), `p ${p} y ${y} fd ${fd} sd ${sd}`).toBe(key(want));
        if (fd <= sd) below0++;
      }
    }
    expect(below0).toBeGreaterThan(256 * 2);
  });

  test('a run without sky: deepslate at y ≤ 0, stone at y ≥ 8, never grass; the sky-open run above keeps grass over dirt then stone', () => {
    // Sky-open run y 60 … 30, air 29 … 25, a run without sky y 24 … −63.
    const { out, scan } = pass((_p, y) => (y >= 30 && y <= 60) || y <= 24 ? 1 : 0, () => 'plains');
    let dither = 0;
    for (let p = 0; p < 256; p++) {
      expect(scan.runFirst[p + 1]! - scan.runFirst[p]!).toBe(2);
      const sd = scan.surfaceDepth[p]!;
      expect(key(at(out, p, 60))).toBe('grass_block');
      for (let y = 59; y >= 30; y--) expect(key(at(out, p, y))).toBe(key(60 - y <= sd ? DIRT : STONE));
      for (let y = 24; y >= -59; y--) {
        const b = at(out, p, y);
        expect(belowSkin(y).map(key), `p ${p} y ${y}`).toContain(key(b));
        if (y >= 1 && y <= 7 && b === DEEPSLATE) dither++;
      }
    }
    // The dither band 1 … 7 shows deepslate on some voxels and stone on others.
    expect(dither).toBeGreaterThan(100);
    expect(dither).toBeLessThan(256 * 7 - 100);
  });
});

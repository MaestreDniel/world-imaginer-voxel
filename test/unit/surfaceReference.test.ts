import { describe, expect, test } from 'vitest';
import { CAVE_BIOME_NAMES } from '../../src/core/constants';
import { deriveSeed, hash2, hash3, type Seed64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { readField, readLevel } from '../../src/gen/column/columnStage';
import { SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { pickCaveBiome } from '../../src/gen/biomes/caveRegistry';
import { createSurfaceReference } from '../../src/gen/surface/reference';
import { RuleValidationError, ruleLeaves, type Condition, type Rule } from '../../src/gen/surface/rules';
import { newSurfaceScan, scanColumn, type SurfaceScan, type SurfaceScanSettings } from '../../src/gen/surface/scan';
import { BEDROCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import {
  caveBiomeHandColumn, randomSurfaceColumn, randomSurfaceParams, randomSurfaceRules, surfaceFuzzNoiseSource, surfaceFuzzSettings,
  withCaveBiomes, type SurfaceFuzzColumn,
} from '../harness/surfaceFuzz';
import { testRng } from '../harness/stats';

const SEED: Seed64 = [42, 0];
const NOISES = surfaceFuzzNoiseSource(SEED);
const at = (p: number, y: number): number => 256 * (y + 64) + p;
const isSolid = (c: SurfaceFuzzColumn, p: number, y: number): boolean => c.solid[at(p, y)] !== 0;
const isWater = (c: SurfaceFuzzColumn, p: number, y: number): boolean => c.solid[at(p, y)] === 0 && c.water[at(p, y)] !== 0;

/** The raw-column facts about the solid voxel (p, y) the oracle needs, found by walking the column (no scan). */
interface OracleVoxel { readonly p: number; readonly y: number; readonly x: number; readonly z: number; readonly yTop: number; readonly yBottom: number }

function oracleVoxel(col: SurfaceFuzzColumn, p: number, y: number): OracleVoxel {
  let yTop = y;
  while (yTop < 319 && isSolid(col, p, yTop + 1)) yTop++;
  let yBottom = y;
  while (yBottom > -63 && isSolid(col, p, yBottom - 1)) yBottom--;
  return { p, y, x: 16 * col.sample.cx + (p & 15), z: 16 * col.sample.cz + (p >> 4), yTop, yBottom };
}

/**
 * An independent oracle of one condition at a solid voxel, straight from the raw column (no scan): depths from the
 * voxel's run found by walking the solid voxels, sky by looking above the run, water above the run's top, the readouts
 * of the sample and the hashes and noises recomputed.
 */
function oracleHolds(c: Condition, col: SurfaceFuzzColumn, set: SurfaceScanSettings, seed: Seed64, v: OracleVoxel): boolean {
  const s = col.sample;
  const { p, y, x, z, yTop, yBottom } = v;
  switch (c.kind) {
    case 'biome': return c.biomes.some((b) => SURFACE_BIOMES.indexOf(b) === col.biomes[p]);
    case 'stoneDepth': {
      const ns = set.depthNoise.z2(x, z);
      const sd = Math.max(0, Math.floor(3 + 2.75 * set.depthMul * ns + 0.25 * (hash2(deriveSeed(seed, 'surface.depthHash'), x, z) / 4294967296)));
      const d = c.side === 'floor' ? yTop - y : y - yBottom;
      return d <= c.offset + (c.addSurfaceDepth ? sd : 0);
    }
    case 'water': {
      if (yTop === 319 || !isWater(col, p, yTop + 1)) return true;
      let wTop = yTop + 1;
      while (wTop < 319 && isWater(col, p, wTop + 1)) wTop++;
      return (c.runTop ? yTop : y) >= wTop + c.offset;
    }
    case 'yAbove': return (c.runTop ? yTop : y) >= c.minY;
    case 'verticalGradient': {
      if (y <= c.trueAtAndBelow) return true;
      if (y >= c.falseAtAndAbove) return false;
      const g = deriveSeed(seed, `surface.gradient.${c.trueAtAndBelow}.${c.falseAtAndAbove}`);
      return hash3(g, x, y, z) / 4294967296 < (c.falseAtAndAbove - y) / (c.falseAtAndAbove - c.trueAtAndBelow);
    }
    case 'steep': return readField(s, 'steep', x, z) >= c.min;
    case 'noiseThreshold': {
      const n = NOISES(c.noise)!.z2(x, z);
      return c.min <= n && n <= c.max;
    }
    case 'temperatureBelow': return readField(s, 'T', x, z) - set.lapse * Math.max(0, y - set.lapseBase) < c.t;
    case 'skyOpen': {
      for (let yy = yTop + 1; yy <= 319; yy++) if (isSolid(col, p, yy)) return false;
      return true;
    }
    case 'lake': return Number.isFinite(readLevel(s, 'lakeLevel', x, z));
    case 'not': return !oracleHolds(c.if, col, set, seed, v);
    case 'caveBiome': {
      // floor: the tagged (kind ≠ 0) voxel above the run's top; ceiling: the one below its bottom, none on the bedrock;
      // here: §1.3's box choice at §1.4's jittered position, recomputed from the pass.
      const tag = (yy: number): number => {
        const t = col.tags === undefined ? 0 : col.tags[at(p, yy)]!;
        return (t & 15) === 0 ? -1 : t >> 4;
      };
      let b = -1;
      if (c.side === 'floor') b = yTop < 319 ? tag(yTop + 1) : -1;
      else if (c.side === 'ceiling') b = yBottom > -63 ? tag(yBottom - 1) : -1;
      else if (col.cave !== undefined) {
        const { inputs, pass } = col.cave;
        const h = hash3(inputs.jitterSeed, x, y, z) >>> 0;
        const off = (f: number): number => ((f * (2 * pass.j + 1)) >>> 10) - pass.j;
        const jx = off(h & 1023), jy = off((h >>> 10) & 1023), jz = off((h >>> 20) & 1023);
        const k = (z + jz - 16 * pass.cz + 4) * 24 + (x + jx - 16 * pass.cx + 4);
        b = pickCaveBiome(inputs.settings, pass.c[k]!, pass.e[k]!, pass.h[k]!, (pass.y0[k]! - (y + jy)) / inputs.settings.depthScale);
      }
      return c.biomes.some((n) => CAVE_BIOME_NAMES.indexOf(n) === b);
    }
  }
}

const TERRACOTTAS = [
  'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta',
].map((k) => REGISTRY.parseStateKey(k));

/** §3.3's band block at (x, y, z), recomputed: the table from its Xoshiro128 runs, the offset from the band noise. */
function oracleBand(seed: Seed64, x: number, y: number, z: number): number {
  const r = new Xoshiro128(deriveSeed(seed, 'surface.bands'));
  const table: number[] = [];
  while (table.length < 192) {
    const len = 1 + r.nextInt(4);
    const colour = TERRACOTTAS[r.nextInt(7)]!;
    for (let k = 0; k < len; k++) table.push(colour);
  }
  const n = NOISES('surface.noises.bandOffset')!;
  const o = Math.round((4 * n.z2(x, z)) / n.clampSigma);
  return table[(((y + o) % 192) + 192) % 192]!;
}

/** The rule ids from root to a leaf id: every prefix ending at a `.rules[k]` or `.then` segment. */
function idChain(leafId: string): string[] {
  const out = ['root'];
  let id = 'root';
  for (const m of leafId.slice(4).matchAll(/\.rules\[\d+\]|\.then/g)) out.push((id += m[0]));
  return out;
}

/** The oracle's result: the first leaf (evaluation order) whose path conditions all hold; stone and [] when none. */
function oracle(tree: Rule, col: SurfaceFuzzColumn, set: SurfaceScanSettings, seed: Seed64, v: OracleVoxel) {
  for (const leaf of ruleLeaves(tree)) {
    if (leaf.conditions.every((c) => oracleHolds(c, col, set, seed, v))) {
      const state = leaf.rule.kind === 'block' ? REGISTRY.parseStateKey(leaf.rule.state) : oracleBand(seed, v.x, v.y, v.z);
      return { state, path: idChain(leaf.id) };
    }
  }
  return { state: STONE, path: [] as string[] };
}

function scanOf(col: SurfaceFuzzColumn, set: SurfaceScanSettings): SurfaceScan {
  return scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes, col.tags ?? null, col.cave ?? null);
}

/** Solid voxels to check per position: every voxel within 16 of a run's top or bottom, plus a few random ones. */
function voxelsToCheck(col: SurfaceFuzzColumn, next: () => number, p: number): number[] {
  const ys: number[] = [];
  for (let y = 319; y >= -63; y--) {
    if (!isSolid(col, p, y)) continue;
    let up = 0;
    while (up <= 16 && y + up + 1 <= 319 && isSolid(col, p, y + up + 1)) up++;
    let down = 0;
    while (down <= 16 && y - down - 1 >= -63 && isSolid(col, p, y - down - 1)) down++;
    if (up <= 16 || down <= 16 || next() % 32 === 0) ys.push(y);
  }
  return ys;
}

/** A hand-built column: ground −63 … top at every position, optional water above, overhang runs, constant readouts. */
function handColumn(top: (p: number) => number): SurfaceFuzzColumn {
  const col = randomSurfaceColumn(testRng(1));
  col.solid.fill(0);
  col.water.fill(0);
  col.sample.f.lakeLevel.fill(-Infinity);
  for (let p = 0; p < 256; p++) {
    col.solid[at(p, -64)] = 1;
    for (let y = -63; y <= top(p); y++) col.solid[at(p, y)] = 1;
  }
  return col;
}

const B = (state: string): Rule => ({ kind: 'block', state });
const IF = (c: Condition, then: Rule): Rule => ({ kind: 'condition', if: c, then });
const SEQ = (...rules: Rule[]): Rule => ({ kind: 'sequence', rules });

describe('surface reference evaluator (SP3c spec §3.4)', () => {
  const set = surfaceFuzzSettings(SEED);

  test('first match wins in tree order; the path lists the rule ids from root to the yielding leaf', () => {
    const col = handColumn(() => 40);
    // An overhang 60 … 70 at position 5: its run is the sky-open one there, the ground run has no sky.
    for (let y = 60; y <= 70; y++) col.solid[at(5, y)] = 1;
    const scan = scanOf(col, set);
    const tree = SEQ(
      IF({ kind: 'yAbove', minY: 65, runTop: false }, B('bedrock')),
      IF({ kind: 'skyOpen' }, SEQ(
        IF({ kind: 'stoneDepth', side: 'floor', offset: 0, addSurfaceDepth: false }, B('air')),
        IF({ kind: 'not', if: { kind: 'yAbove', minY: 35, runTop: false } }, SEQ()),
        B('stone'),
      )),
      IF({ kind: 'yAbove', minY: 0, runTop: true }, SEQ(IF({ kind: 'lake' }, B('air')), B('bedrock'))),
    );
    const ref = createSurfaceReference(SEED, tree, NOISES);
    expect(ref.rules).toBe(tree);
    // Position 0: the sky-open ground run. Its top voxel → [1][0]; below it [1][1] yields nothing (an empty sequence)
    // and [1][2] yields stone; the rule path is recorded even when the state is stone.
    expect(ref.evaluate(scan, set, 0, 40)).toEqual({ state: REGISTRY.parseStateKey('air'), path: ['root', 'root.rules[1]', 'root.rules[1].then', 'root.rules[1].then.rules[0]', 'root.rules[1].then.rules[0].then'] });
    expect(ref.evaluate(scan, set, 0, 39)).toEqual({ state: STONE, path: ['root', 'root.rules[1]', 'root.rules[1].then', 'root.rules[1].then.rules[2]'] });
    expect(ref.evaluate(scan, set, 0, -63)).toEqual({ state: STONE, path: ['root', 'root.rules[1]', 'root.rules[1].then', 'root.rules[1].then.rules[2]'] });
    // Position 5: the overhang is sky-open; y ≥ 65 → [0]; the ground run has no sky → [2] (lake off: bedrock).
    expect(ref.evaluate(scan, set, 5, 66)).toEqual({ state: BEDROCK, path: ['root', 'root.rules[0]', 'root.rules[0].then'] });
    expect(ref.evaluate(scan, set, 5, 60).path).toEqual(['root', 'root.rules[1]', 'root.rules[1].then', 'root.rules[1].then.rules[2]']);
    expect(ref.evaluate(scan, set, 5, 40)).toEqual({ state: BEDROCK, path: ['root', 'root.rules[2]', 'root.rules[2].then', 'root.rules[2].then.rules[1]'] });
    expect(ref.state(scan, set, 5, 40)).toBe(BEDROCK);
    expect(ref.state(scan, set, 0, 40)).toBe(REGISTRY.parseStateKey('air'));
  });

  test('bandlands yields the band block of (x, y, z): the seed\'s table, shifted by the band noise; its path ends at the leaf', () => {
    const col = handColumn(() => 200);
    const scan = scanOf(col, set);
    const tree = SEQ(IF({ kind: 'yAbove', minY: 150, runTop: false }, { kind: 'bandlands' }), B('bedrock'));
    const ref = createSurfaceReference(SEED, tree, NOISES);
    const other = createSurfaceReference([43, 0], tree, NOISES);
    const colours = new Set<number>();
    let differ = 0;
    for (let p = 0; p < 256; p += 3) {
      for (let y = 150; y <= 200; y++) {
        const x = 16 * col.sample.cx + (p & 15), z = 16 * col.sample.cz + (p >> 4);
        const got = ref.evaluate(scan, set, p, y);
        expect(got).toEqual({ state: oracleBand(SEED, x, y, z), path: ['root', 'root.rules[0]', 'root.rules[0].then'] });
        colours.add(got.state);
        if (other.state(scan, set, p, y) !== got.state) differ++;
      }
      expect(ref.state(scan, set, p, 149)).toBe(BEDROCK);
    }
    expect([...colours].every((c) => TERRACOTTAS.includes(c))).toBe(true);
    expect(colours.size).toBeGreaterThanOrEqual(5);
    expect(differ).toBeGreaterThan(100);
    // A table passed in is used as is (the SurfaceContext shares one); a tree without bandlands needs none.
    const flat = new Uint16Array(192).fill(BEDROCK);
    expect(createSurfaceReference(SEED, tree, NOISES, flat).state(scan, set, 7, 180)).toBe(BEDROCK);
    expect(createSurfaceReference(SEED, B('stone'), NOISES, flat).state(scan, set, 7, 180)).toBe(STONE);
  });

  test('a voxel no rule matches is stone with an empty path', () => {
    const col = handColumn(() => 10);
    const scan = scanOf(col, set);
    for (const tree of [SEQ(), IF({ kind: 'yAbove', minY: 300, runTop: false }, B('bedrock')), SEQ(SEQ(), IF({ kind: 'lake' }, SEQ()))]) {
      const ref = createSurfaceReference(SEED, tree, NOISES);
      expect(ref.evaluate(scan, set, 17, 10)).toEqual({ state: STONE, path: [] });
      expect(ref.state(scan, set, 17, -63)).toBe(STONE);
    }
    // A bare block at the root yields everywhere, with the path ['root'].
    expect(createSurfaceReference(SEED, B('bedrock'), NOISES).evaluate(scan, set, 3, 0)).toEqual({ state: BEDROCK, path: ['root'] });
  });

  test('verticalGradient dithers with the world seed: same seed same voxels, another seed other voxels', () => {
    const col = handColumn(() => 20);
    const scan = scanOf(col, set);
    const tree = IF({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 }, B('bedrock'));
    const a = createSurfaceReference(SEED, tree, NOISES);
    const b = createSurfaceReference(SEED, tree, NOISES);
    const c = createSurfaceReference([43, 0], tree, NOISES);
    let differ = 0;
    const counts = new Array<number>(9).fill(0);
    for (let p = 0; p < 256; p++) {
      for (let y = -2; y <= 9; y++) {
        const sa = a.state(scan, set, p, y);
        expect(b.state(scan, set, p, y)).toBe(sa);
        if (c.state(scan, set, p, y) !== sa) differ++;
        if (y <= 0) expect(sa).toBe(BEDROCK);
        if (y >= 8) expect(sa).toBe(STONE);
        if (y >= 1 && y <= 7 && sa === BEDROCK) counts[y]!++;
      }
    }
    expect(differ).toBeGreaterThan(100);
    // P(bedrock at y) = (8 − y)/8: 224 of 256 at y 1 down to 32 at y 7 (±5 sd, binomial).
    for (let y = 1; y <= 7; y++) {
      const mean = 256 * (8 - y) / 8;
      expect(Math.abs(counts[y]! - mean)).toBeLessThan(5 * Math.sqrt(mean * (y / 8)));
    }
  });

  test('creation validates the tree; evaluation needs a solid voxel at integer p 0 … 255, y −63 … 319', () => {
    expect(() => createSurfaceReference(SEED, { kind: 'block', state: 'not_a_block' }, NOISES)).toThrow(RuleValidationError);
    expect(() => createSurfaceReference(SEED, IF({ kind: 'noiseThreshold', noise: 'surface.noises.none', min: 0, max: 1 }, B('stone')), NOISES)).toThrow(RuleValidationError);
    expect(() => createSurfaceReference(SEED, { kind: 'bandlands' }, (n) => (n === 'surface.noises.bandOffset' ? undefined : NOISES(n)))).toThrow(/NO_BAND_NOISE/);
    expect(() => createSurfaceReference(SEED, { kind: 'bandlands' }, NOISES, new Uint16Array(64))).toThrow(RangeError);
    const col = handColumn((p) => (p === 9 ? -63 : 30));
    const scan = scanOf(col, set);
    const ref = createSurfaceReference(SEED, B('stone'), NOISES);
    expect(() => ref.evaluate(scan, set, 0, 31)).toThrow(RangeError);
    expect(() => ref.evaluate(scan, set, 9, -62)).toThrow(/not solid/);
    expect(() => ref.evaluate(scan, set, 0, -64)).toThrow(RangeError);
    expect(() => ref.evaluate(scan, set, 0, 320)).toThrow(RangeError);
    expect(() => ref.evaluate(scan, set, 256, 0)).toThrow(RangeError);
    expect(() => ref.evaluate(scan, set, -1, 0)).toThrow(RangeError);
    expect(() => ref.state(scan, set, 1.5, 0)).toThrow(RangeError);
    expect(() => ref.state(scan, set, 0, 0.5)).toThrow(RangeError);
    expect(ref.evaluate(scan, set, 9, -63).state).toBe(STONE);
  });

  test('fuzz: the reference equals the independent oracle on random trees and random columns, every condition both ways', () => {
    const next = testRng(6101);
    const seen = new Map<string, [number, number]>();
    const note = (c: Condition, v: boolean) => {
      const k = c.kind === 'stoneDepth' || c.kind === 'caveBiome' ? `${c.kind}.${c.side}` : c.kind;
      const e = seen.get(k) ?? [0, 0];
      e[v ? 0 : 1]++;
      seen.set(k, e);
    };
    let checked = 0, matched = 0, banded = 0;
    for (let round = 0; round < 24; round++) {
      const seed: Seed64 = [next(), next()];
      const noises = surfaceFuzzNoiseSource(SEED);
      const rset = surfaceFuzzSettings(seed, round % 2 === 0 ? randomSurfaceParams(next) : undefined, noises);
      // Cave biomes from a stream of their own (the column's and the trees' draws are those of SP3c's fuzz).
      const col = withCaveBiomes(randomSurfaceColumn(next), 6101 + round);
      const scan = scanOf(col, rset);
      const styles = ['free', 'fastPath', 'nearMiss'] as const;
      for (let t = 0; t < 6; t++) {
        const tree = randomSurfaceRules(next, { style: styles[t % 3] });
        const ref = createSurfaceReference(seed, tree, noises);
        const leaves = ruleLeaves(tree);
        for (let p = next() % 7; p < 256; p += 7) {
          for (const y of voxelsToCheck(col, next, p)) {
            const v = oracleVoxel(col, p, y);
            const want = oracle(tree, col, rset, seed, v);
            const got = ref.evaluate(scan, rset, p, y);
            if (got.state !== want.state || got.path.join() !== want.path.join()) {
              throw new Error(`round ${round} tree ${t} p ${p} y ${y}: got ${JSON.stringify(got)}, oracle ${JSON.stringify(want)}`);
            }
            expect(ref.state(scan, rset, p, y)).toBe(got.state);
            checked++;
            if (got.path.length > 0) matched++;
            if (got.path.length > 0 && leaves.find((l) => l.id === got.path[got.path.length - 1])!.rule.kind === 'bandlands') banded++;
            if ((p + y) % 5 === 0) for (const l of leaves) for (const c of l.conditions) note(c, oracleHolds(c, col, rset, seed, v));
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
    expect(banded).toBeGreaterThan(1_000);
    expect(matched / checked).toBeGreaterThan(0.2);
    expect(matched / checked).toBeLessThan(0.95);
    for (const k of [
      'biome', 'stoneDepth.floor', 'stoneDepth.ceiling', 'water', 'yAbove', 'verticalGradient', 'steep', 'noiseThreshold', 'temperatureBelow', 'skyOpen',
      'lake', 'not', 'caveBiome.floor', 'caveBiome.ceiling', 'caveBiome.here',
    ]) {
      const [t, f] = seen.get(k) ?? [0, 0];
      expect([k, t > 50, f > 50]).toEqual([k, true, true]);
    }
  });
});

describe('caveBiome (SP6b spec §3.2, D18) on the hand-built column (caveBiomeHandColumn)', () => {
  const set = surfaceFuzzSettings(SEED);
  const col = caveBiomeHandColumn();
  const scan = scanOf(col, set);
  const CB = (side: 'floor' | 'ceiling' | 'here', ...biomes: Array<'plain' | 'lush' | 'dripstone' | 'abyss'>): Condition => ({ kind: 'caveBiome', side, biomes });
  const MOSS = REGISTRY.parseStateKey('moss_block'), CLAY = REGISTRY.parseStateKey('clay');

  test('a moss carpet never lies under a plain cave over lush rock', () => {
    const ref = createSurfaceReference(SEED, SEQ(IF(CB('floor', 'lush'), B('moss_block')), IF(CB('here', 'lush'), B('clay'))), NOISES);
    // p 0: the run's top rock is lush (here) but the air above it is plain (`1 | 0 << 4`).
    expect(ref.conditionHolds('root.rules[0].if', scan, set, 0, 40)).toBe(false);
    expect(ref.conditionHolds('root.rules[1].if', scan, set, 0, 40)).toBe(true);
    expect(ref.evaluate(scan, set, 0, 40)).toEqual({ state: CLAY, path: ['root', 'root.rules[1]', 'root.rules[1].then'] });
    // p 1: lush cave air above the ground run: the carpet; p 2: untagged air above, lush rock: clay.
    expect(ref.state(scan, set, 1, 40)).toBe(MOSS);
    expect(ref.state(scan, set, 2, 40)).toBe(CLAY);
    // here follows the picker: plain rock at y 75 and above, at y −16 and below.
    expect(ref.conditionHolds('root.rules[1].if', scan, set, 0, -16)).toBe(false);
    expect(ref.conditionHolds('root.rules[1].if', scan, set, 0, -15)).toBe(true);
  });

  test('a ceiling rule never fires on a bedrock-resting run', () => {
    const ref = createSurfaceReference(SEED, IF(CB('ceiling', 'lush', 'dripstone', 'abyss', 'plain'), B('moss_block')), NOISES);
    for (let p = 0; p < 256; p++) {
      for (let y = -63; y <= 40; y++) {
        expect(ref.conditionHolds('root.if', scan, set, p, y)).toBe(false);
        expect(ref.state(scan, set, p, y)).toBe(STONE);
      }
    }
    // p 1's overhang rests on lush cave air: every voxel of it takes the ceiling branch.
    for (let y = 50; y <= 60; y++) expect(ref.state(scan, set, 1, y)).toBe(MOSS);
  });

  test('here without a picker (a scan without one) holds for no list', () => {
    const bare = scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes, col.tags);
    const ref = createSurfaceReference(SEED, IF(CB('here', 'lush', 'dripstone', 'abyss', 'plain'), B('moss_block')), NOISES);
    for (const y of [-63, 0, 40]) expect(ref.conditionHolds('root.if', bare, set, 0, y)).toBe(false);
    expect(ref.conditionHolds('root.if', scan, set, 0, 40)).toBe(true);
  });
});

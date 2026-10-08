import { describe, expect, test } from 'vitest';
import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { createSurfaceContext, surfaceNoiseSource } from '../../src/gen/surface/context';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { CONDITION_KINDS, RULE_KINDS, ruleLeaves, validateRules, type Condition, type Rule } from '../../src/gen/surface/rules';
import { runAt } from '../../src/gen/surface/scan';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { computeSp3aGolden } from '../../src/metrics/sp3aGoldens';
import {
  computeSp3cGolden, sp3cGoldenKeys, sp3cRegistryDigest, surfaceOpsColumns, surfaceOpsRules, surfaceOpsValues,
} from '../../src/metrics/sp3cGoldens';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockDef } from '../../src/world/blocks/registry';
import { SOLID_TABLES } from '../harness/blockFixtures';
import { expectGolden } from '../harness/goldens';

const CTX = createGenContext(seedFromInput('42'), resolveProfile('default'));
const VOXELS = 98304;
const UNWRITTEN = 0xffff;

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16 = (v: number): number[] => [v & 255, v >> 8];

/** SP3c spec §2.1, written out: [type, SOUND code, TINT code, CARVABLE] for states 3 … 24 in order. */
const SOUND = { stone: 1, dirt: 2, grass: 3, sand: 4, gravel: 5, snow: 7, glass: 8 } as const;
const PALETTE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['grass_block', SOUND.grass, 1, 1], ['dirt', SOUND.dirt, 0, 1], ['coarse_dirt', SOUND.dirt, 0, 1], ['podzol', SOUND.dirt, 0, 1],
  ['mud', SOUND.dirt, 0, 1], ['sand', SOUND.sand, 0, 1], ['red_sand', SOUND.sand, 0, 1], ['sandstone', SOUND.stone, 0, 1],
  ['red_sandstone', SOUND.stone, 0, 1], ['gravel', SOUND.gravel, 0, 1], ['clay', SOUND.dirt, 0, 1], ['calcite', SOUND.stone, 0, 1],
  ['snow_block', SOUND.snow, 0, 1], ['packed_ice', SOUND.glass, 0, 0], ['deepslate', SOUND.stone, 0, 1],
  ['terracotta', SOUND.stone, 0, 1], ['white_terracotta', SOUND.stone, 0, 1], ['orange_terracotta', SOUND.stone, 0, 1],
  ['yellow_terracotta', SOUND.stone, 0, 1], ['brown_terracotta', SOUND.stone, 0, 1], ['red_terracotta', SOUND.stone, 0, 1],
  ['light_gray_terracotta', SOUND.stone, 0, 1],
];

/**
 * SP3a §6.4's byte stream over states 3 … 24 from the §2.1 table and its common values (OPACITY 15, PASS opaque 1,
 * SHAPE cube 1, FULL_FACES 63, EMIT 0, REPLACEABLE 0, COLLIDE cube 1, FLUID_MODE block 0, FACE_TEX 0), not from the
 * registry's tables.
 */
const SP3C_REGISTRY_BYTES = new Uint8Array(PALETTE.flatMap(([name, sound, tint, carvable], i) => [
  ...ascii(name), 0, ...u16(3 + i), 15, 1, 1, 63, 0, carvable, 0, 1, 0, tint, sound, ...Array<number>(12).fill(0),
]));

test('2 unique SP3c keys, chained into allGoldenKeys after SP3b\'s: 54 goldens', () => {
  const keys = sp3cGoldenKeys();
  expect(keys).toEqual(['sp3c.registry', 'sp3c.surface.ops']);
  expect(sp3cGoldenKeys().length).toBe(2);
  expect(allGoldenKeys().slice(-2)).toEqual(keys);
  expect(allGoldenKeys().slice(-4, -2)).toEqual(['sp3b.density.ops', 'sp3b.density.default']);
  expect(allGoldenKeys().length).toBe(54);
  expect(new Set(allGoldenKeys()).size).toBe(54);
  for (const bad of ['sp3c.surface', 'sp3c.surface.ops.x', 'sp3c.surface.default', 'sp3c.registry.x', 'sp3c.nope']) {
    expect(() => computeSp3cGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp3c.registry (§2.2)', () => {
  test('is the FNV-1a 64 of SP3a §6.4\'s byte stream over states 3 … 24, written from the §2.1 table', () => {
    expect(PALETTE).toHaveLength(22);
    expect(sp3cRegistryDigest()).toBe(hex64(fnv1a64Bytes(SP3C_REGISTRY_BYTES)));
    expect(computeSp3cGolden('sp3c.registry')).toBe(sp3cRegistryDigest());
    expect(computeAnyGolden('sp3c.registry')).toBe(sp3cRegistryDigest());
  });

  test('covers ids 3 … 24 only: an appended type or an SP3a value does not change it, an SP3c value does', () => {
    const appended: BlockDef = { name: 'granite', ...SOLID_TABLES };
    expect(sp3cRegistryDigest(buildRegistry([...BLOCK_DEFS, appended]))).toBe(sp3cRegistryDigest(REGISTRY));
    const louderBedrock: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'bedrock' ? { ...d, sound: 'metal' } : d));
    expect(sp3cRegistryDigest(buildRegistry(louderBedrock))).toBe(sp3cRegistryDigest(REGISTRY));
    const louderClay: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'clay' ? { ...d, sound: 'gravel' } : d));
    expect(sp3cRegistryDigest(buildRegistry(louderClay))).not.toBe(sp3cRegistryDigest(REGISTRY));
    const renamed: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'light_gray_terracotta' ? { ...d, name: 'silver_terracotta' } : d));
    expect(sp3cRegistryDigest(buildRegistry(renamed))).not.toBe(sp3cRegistryDigest(REGISTRY));
    // sp3a.registry (states 0 … 2) does not see the palette.
    expect(computeSp3aGolden('sp3a.registry')).toBe(computeAnyGolden('sp3a.registry'));
  });

  test('a registry with fewer than 25 states is refused', () => {
    expect(() => sp3cRegistryDigest(buildRegistry(BLOCK_DEFS.slice(0, 24)))).toThrow(RangeError);
  });
});

/** Every condition of a tree, nested ones (inside `not`) included. */
function conditionsOf(root: Rule): Condition[] {
  const out: Condition[] = [];
  const cond = (c: Condition): void => {
    out.push(c);
    if (c.kind === 'not') cond(c.if);
  };
  const walk = (r: Rule): void => {
    if (r.kind === 'sequence') r.rules.forEach(walk);
    else if (r.kind === 'condition') { cond(r.if); walk(r.then); }
  };
  walk(root);
  return out;
}

function ruleKindsOf(root: Rule): Set<string> {
  const seen = new Set<string>();
  const walk = (r: Rule): void => {
    seen.add(r.kind);
    if (r.kind === 'sequence') r.rules.forEach(walk);
    else if (r.kind === 'condition') walk(r.then);
  };
  walk(root);
  return seen;
}

describe('sp3c.surface.ops (§7)', () => {
  const tree = surfaceOpsRules();
  const sc = createSurfaceContext(CTX, tree);

  test('the fixture tree uses every rule kind and condition kind, both sides and both runTop / addSurfaceDepth values', () => {
    expect([...ruleKindsOf(tree)].sort()).toEqual([...RULE_KINDS].sort());
    const conds = conditionsOf(tree);
    expect([...new Set(conds.map((c) => c.kind))].sort()).toEqual([...CONDITION_KINDS].sort());
    const depth = conds.filter((c) => c.kind === 'stoneDepth');
    expect(new Set(depth.map((c) => c.side))).toEqual(new Set(['floor', 'ceiling']));
    expect(new Set(depth.map((c) => c.addSurfaceDepth))).toEqual(new Set([true, false]));
    expect(new Set(conds.filter((c) => c.kind === 'water').map((c) => c.runTop))).toEqual(new Set([true, false]));
    expect(new Set(conds.filter((c) => c.kind === 'yAbove').map((c) => c.runTop))).toEqual(new Set([true, false]));
    expect(new Set(conds.filter((c) => c.kind === 'noiseThreshold').map((c) => c.noise)))
      .toEqual(new Set(['surface.noises.depth', 'surface.noises.patch']));
    expect(validateRules(tree, surfaceNoiseSource(CTX))).toEqual([]);
    // Frozen data: a fresh, equal tree on every call.
    expect(surfaceOpsRules()).not.toBe(tree);
    expect(surfaceOpsRules()).toEqual(tree);
  });

  test('the fixture tree has a fast path that is not sky-gated, with Y-only leaves before and after the depth-bounded ones', () => {
    const fp = sc.compiled.fastPath;
    expect(fp).not.toBeNull();
    expect(fp!.skyGated).toBe(false);
    expect(fp!.maxSurfaceDepth).toBe(2 + sc.settings.sdMax);
    expect(fp!.bands.some((b) => !b.dither && b.state >= 0)).toBe(true);
    const leaves = ruleLeaves(tree);
    const yOnly = leaves.map((l) => l.conditions.every((c) => c.kind === 'verticalGradient' || (c.kind === 'yAbove' && !c.runTop) || c.kind === 'not'));
    expect(yOnly[0]).toBe(true);
    expect(yOnly.at(-1)).toBe(true);
    expect(yOnly.some((v) => !v)).toBe(true);
  });

  test('the values are the compiled tree\'s states at every voxel of the fixed columns, equal to the reference; the key hashes them', () => {
    const columns = surfaceOpsColumns();
    expect(columns.length).toBeGreaterThanOrEqual(8);
    const values = surfaceOpsValues();
    expect(values.length).toBe(columns.length * VOXELS);
    const used = new Map<string, number>();
    const bad: string[] = [];
    let solid = 0;
    let evaluated = 0;
    const scratch = new Uint16Array(VOXELS);
    columns.forEach(([cx, cz], n) => {
      const col = surfaceProbeColumn(sc, cx, cz);
      evaluated += sc.compiled.fillColumn(col.scan, scratch, true);
      const base = n * VOXELS;
      for (let i = 0; i < VOXELS; i++) {
        const y = (i >> 8) - 64, p = i & 255;
        const v = values[base + i]!;
        if (y === -64 || col.solid[i] === 0) {
          if (v !== UNWRITTEN) bad.push(`(${cx}, ${cz}) p ${p} y ${y}: ${v} at a voxel the rules do not write`);
          continue;
        }
        solid++;
        expect(runAt(col.scan, p, y)).toBeGreaterThanOrEqual(0);
        const r = sc.reference.evaluate(col.scan, sc.settings, p, y);
        if (v !== r.state) bad.push(`(${cx}, ${cz}) p ${p} y ${y}: ${v} ≠ reference ${r.state}`);
        if (v !== sc.compiled.state(col.scan, p, y)) bad.push(`(${cx}, ${cz}) p ${p} y ${y}: fast ≠ full`);
        const leaf = r.path.at(-1) ?? 'none';
        used.set(leaf, (used.get(leaf) ?? 0) + 1);
      }
    });
    expect(bad.slice(0, 10)).toEqual([]);
    expect(solid).toBeGreaterThan(100000);
    expect(evaluated).toBeLessThan(solid / 2); // the fast path takes most voxels
    // Every leaf of the fixture yields somewhere on the columns, and so does "no rule" (stone).
    const missing = ruleLeaves(tree).filter((l) => (used.get(l.id) ?? 0) === 0).map((l) => l.id);
    expect(missing).toEqual([]);
    expect(used.get('none') ?? 0).toBeGreaterThan(0);
    const bytes = new Uint8Array(values.length * 2);
    for (let i = 0; i < values.length; i++) { bytes[2 * i] = values[i]! & 255; bytes[2 * i + 1] = values[i]! >> 8; }
    expect(computeSp3cGolden('sp3c.surface.ops')).toBe(hex64(fnv1a64Bytes(bytes)));
    expect(computeAnyGolden('sp3c.surface.ops')).toBe(computeSp3cGolden('sp3c.surface.ops'));
  }, 60_000);

  test('the fixture columns hold a lake, water, runs without sky, steep tops and badlands', () => {
    const cols = surfaceOpsColumns().map(([cx, cz]) => {
      const c = surfaceProbeColumn(createSurfaceContext(CTX, tree), cx, cz);
      return { lake: c.scan.lakeLevel.some((l) => Number.isFinite(l)), water: c.water.some((w) => w !== 0), noSky: c.scan.runFirst[256]! > 256 };
    });
    expect(cols.some((c) => c.lake)).toBe(true);
    expect(cols.some((c) => c.water)).toBe(true);
    expect(cols.some((c) => c.noSky)).toBe(true);
  });
});

describe('SP3c goldens', () => {
  test.each(sp3cGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp3cGolden(key));
  }, 60_000);
});

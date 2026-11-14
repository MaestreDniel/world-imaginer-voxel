/**
 * The SP6b goldens (SP6b spec §14.3, D28), chained last into `allGoldenKeys` after SP6a's. `sp6b.registry` is SP3a
 * §6.4's registry byte stream over SP6b's seven types, states 58 … 64 (SP6b spec §4, D36), written here from the §4
 * table, as `sp3c.registry` (a fixed range, so states appended later never change it). The generator push appends
 * `sp6b.caveBiome.points` (Task 17: the picker at 64 fixed 3D points, recomputed here from the module comment) and
 * `sp6b.region.T.biomes` (Task 31: the first 8 × 8 window of the biome region holding the three cave biomes, its
 * candidates written here from the module comment). The keys match `test/goldens.json`.
 */
import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, caveBiomeOf } from '../../src/core/constants';
import { fnv1a32, fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { caveBiomeOfPass, cavePickerOf, fillCaveColumnPass, newCaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { registryDigest } from '../../src/metrics/sp3aGoldens';
import { sp3cRegistryDigest } from '../../src/metrics/sp3cGoldens';
import { regionHash } from '../../src/metrics/region';
import {
  BIOME_SCAN_REGION, BIOMES_WINDOW, biomesWindowCandidates, biomesWindowStore, caveBiomePoints, caveBiomePointsDigest,
  computeSp6bGolden, sp6bGoldenKeys, sp6bRegistryDigest,
} from '../../src/metrics/sp6bGoldens';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockDef } from '../../src/world/blocks/registry';
import { SOLID_TABLES } from '../harness/blockFixtures';
import { BIOME_REGION } from '../harness/caveSites';
import { expectGolden } from '../harness/goldens';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16 = (v: number): number[] => [v & 255, v >> 8];

/** SP6b spec §4, written out: [type, SOUND code] for states 58 … 64 in order (type ids 50 … 56). */
const SOUND = { stone: 1, grass: 3, abyss: 11 } as const;
const SP6B: ReadonlyArray<readonly [string, number]> = [
  ['moss_block', SOUND.grass], ['dripstone_block', SOUND.stone], ['abyss_stone', SOUND.abyss],
  ['abyss_stone_veined', SOUND.abyss], ['cracked_abyss_stone', SOUND.abyss], ['abyss_shale', SOUND.abyss],
  ['abyss_ash', SOUND.abyss],
];

/**
 * SP3a §6.4's byte stream over states 58 … 64 from the §4 table and the terrain types' common values (OPACITY 15,
 * PASS opaque 1, SHAPE cube 1, FULL_FACES 63, EMIT 0, CARVABLE 1, REPLACEABLE 0, COLLIDE cube 1, FLUID_MODE block 0,
 * TINT none 0, FACE_TEX 0), not from the registry's tables.
 */
const SP6B_REGISTRY_BYTES = new Uint8Array(SP6B.flatMap(([name, sound], i) => [
  ...ascii(name), 0, ...u16(50 + i), 15, 1, 1, 63, 0, 1, 0, 1, 0, 0, sound, ...Array<number>(12).fill(0),
]));

test('3 SP6b keys, chained last into allGoldenKeys after SP6a\'s: 65 goldens', () => {
  const keys = ['sp6b.registry', 'sp6b.caveBiome.points', 'sp6b.region.T.biomes'];
  expect(sp6bGoldenKeys()).toEqual(keys);
  expect(allGoldenKeys().slice(-3)).toEqual(keys);
  expect(allGoldenKeys().slice(-6, -3)).toEqual(['sp6a.density.ops', 'sp6a.carver.paths', 'sp6a.region.T.caves']);
  expect(allGoldenKeys()).toHaveLength(65);
  expect(new Set(allGoldenKeys()).size).toBe(65);
  for (const bad of [
    'sp6b.registry.x', 'sp6b.region.T', 'sp6b.region.T.biomes.x', 'sp6b.region.T.default', 'sp6b.caveBiome.points.x', 'sp6b.nope',
  ]) {
    expect(() => computeSp6bGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp6b.registry (§14.3)', () => {
  test('is the FNV-1a 64 of SP3a §6.4\'s byte stream over states 58 … 64, written from the §4 table', () => {
    expect(SP6B.map(([name]) => name)).toEqual(Array.from({ length: 7 }, (_, i) => REGISTRY.stateKey(58 + i)));
    expect(sp6bRegistryDigest()).toBe(hex64(fnv1a64Bytes(SP6B_REGISTRY_BYTES)));
    expect(computeSp6bGolden('sp6b.registry')).toBe(sp6bRegistryDigest());
    expect(computeAnyGolden('sp6b.registry')).toBe(sp6bRegistryDigest());
  });

  test('covers ids 58 … 64 only: an appended type or an older value does not change it, an SP6b value does', () => {
    const appended: BlockDef = { name: 'granite', ...SOLID_TABLES };
    expect(sp6bRegistryDigest(buildRegistry([...BLOCK_DEFS, appended]))).toBe(sp6bRegistryDigest(REGISTRY));
    const louderDeepslate: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'deepslate' ? { ...d, sound: 'abyss' } : d));
    expect(sp6bRegistryDigest(buildRegistry(louderDeepslate))).toBe(sp6bRegistryDigest(REGISTRY));
    const quietAsh: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'abyss_ash' ? { ...d, sound: 'sand' } : d));
    expect(sp6bRegistryDigest(buildRegistry(quietAsh))).not.toBe(sp6bRegistryDigest(REGISTRY));
    const glowingMoss: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'moss_block' ? { ...d, emit: 2 } : d));
    expect(sp6bRegistryDigest(buildRegistry(glowingMoss))).not.toBe(sp6bRegistryDigest(REGISTRY));
    // sp3a.registry (states 0 … 2) and sp3c.registry (3 … 24) do not see the seven: equal without them.
    const before = buildRegistry(BLOCK_DEFS.slice(0, 50));
    expect(registryDigest(before)).toBe(registryDigest(REGISTRY));
    expect(sp3cRegistryDigest(before)).toBe(sp3cRegistryDigest(REGISTRY));
  });

  test('a registry with fewer than 65 states is refused', () => {
    expect(() => sp6bRegistryDigest(buildRegistry(BLOCK_DEFS.slice(0, 56)))).toThrow(RangeError);
  });
});

describe('sp6b.caveBiome.points (§14.3, Task 17)', () => {
  /** The 64 points, written from the module comment: x, z = −4096 + nextInt(8193), y = −63 + nextInt(184), in that order. */
  const points = (): Array<[number, number, number]> => {
    const r = new Xoshiro128(fnv1a32('sp6b.caveBiome.points'));
    return Array.from({ length: 64 }, () => {
      const x = -4096 + r.nextInt(8193);
      const z = -4096 + r.nextInt(8193);
      const y = -63 + r.nextInt(184);
      return [x, y, z];
    });
  };

  test('64 points drawn from Xoshiro128(fnv1a32(\'sp6b.caveBiome.points\')) within ±4,096 blocks, y −63 … 120', () => {
    const p = caveBiomePoints();
    expect(p).toEqual(points());
    expect(p).toHaveLength(64);
    for (const [x, y, z] of p) {
      expect(Math.abs(x) <= 4096 && Math.abs(z) <= 4096 && y >= -63 && y <= 120, `(${x}, ${y}, ${z})`).toBe(true);
    }
  });

  test('is the FNV-1a 64 of caveBiomeOfPass over the default profile\'s picker at the 64 points, world seed \'42\', one byte each', () => {
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('default'));
    const inp = cavePickerOf(ctx);
    const s = newColumnSample();
    const pass = newCaveColumnPass();
    const ids = points().map(([x, y, z]) => {
      fillCaveColumnPass(inp, buildColumnSample(ctx, Math.floor(x / 16), Math.floor(z / 16), s), pass);
      return caveBiomeOfPass(inp, pass, x, y, z);
    });
    expect(caveBiomePointsDigest()).toBe(hex64(fnv1a64Bytes(Uint8Array.from(ids))));
    expect(computeSp6bGolden('sp6b.caveBiome.points')).toBe(caveBiomePointsDigest());
    expect(computeAnyGolden('sp6b.caveBiome.points')).toBe(caveBiomePointsDigest());
    // The points reach more than plain caves, so the digest sees the boxes.
    expect(new Set(ids).size).toBeGreaterThan(1);
    expect(ids.every((b) => b >= CAVE_BIOME.plain && b <= CAVE_BIOME.abyss)).toBe(true);
  });
});

describe('sp6b.region.T.biomes (§14.3, Task 31)', () => {
  /** The stored cave-biome nibbles (ids 0-15) the 8 × 8 window at chunk (cx0, cz0) holds, as bits. */
  const biomeMask = (cx0: number, cz0: number): number => {
    const store = biomesWindowStore(cx0, cz0);
    let mask = 0;
    for (let cz = cz0; cz < cz0 + 8; cz++) {
      for (let cx = cx0; cx < cx0 + 8; cx++) {
        const v = store.proto(cx, cz);
        expect(v, `column (${cx}, ${cz}) has a proto set`).not.toBeNull();
        for (let sy = 0; sy < 24; sy++) {
          const c = v!.sectionCave(sy);
          if (typeof c === 'number') mask |= 1 << caveBiomeOf(c);
          else for (let i = 0; i < 4096; i++) mask |= 1 << caveBiomeOf(c[i]!);
        }
      }
    }
    return mask;
  };
  const ALL = (1 << CAVE_BIOME.lush) | (1 << CAVE_BIOME.dripstone) | (1 << CAVE_BIOME.abyss);

  test('the scan\'s region mirrors the harness\'s BIOME_REGION; its candidates are the 16 tiles, z rows then x', () => {
    expect(BIOME_SCAN_REGION).toEqual(BIOME_REGION);
    expect(BIOME_SCAN_REGION).toEqual([-112, 80]);
    const want: Array<[number, number]> = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) want.push([-112 + 8 * i, 80 + 8 * j]);
    expect(biomesWindowCandidates()).toEqual(want);
    // The window is tile (1, 2), the 10th candidate.
    expect(biomesWindowCandidates()[9]).toEqual(BIOMES_WINDOW);
    expect(BIOMES_WINDOW).toEqual([-104, 96]);
  });

  test('the window holds a voxel of each cave biome 1-3 in its stored nibbles and no candidate before it does; the key is its regionHash', () => {
    const cands = biomesWindowCandidates();
    const at = cands.findIndex(([x, z]) => x === BIOMES_WINDOW[0] && z === BIOMES_WINDOW[1]);
    for (const [cx0, cz0] of cands.slice(0, at)) {
      expect((biomeMask(cx0, cz0) & ALL) === ALL, `candidate (${cx0}, ${cz0}) holds the three biomes`).toBe(false);
    }
    const [cx0, cz0] = BIOMES_WINDOW;
    expect(biomeMask(cx0, cz0) & ALL).toBe(ALL);
    const store = biomesWindowStore();
    expect(computeSp6bGolden('sp6b.region.T.biomes')).toBe(hex64(regionHash(store, cx0, cz0, 8, 8)));
    expect(computeAnyGolden('sp6b.region.T.biomes')).toBe(computeSp6bGolden('sp6b.region.T.biomes'));
  }, 600_000); // 12 windows of 8 × 8 chunks up to T in process
});

describe('SP6b goldens', () => {
  test.each(sp6bGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp6bGolden(key));
  }, 60_000);
});

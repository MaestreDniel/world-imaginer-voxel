/**
 * The SP6b goldens (SP6b spec §14.3, D28), chained last into `allGoldenKeys` after SP6a's. `sp6b.registry` is SP3a
 * §6.4's registry byte stream over SP6b's seven types, states 58 … 64 (SP6b spec §4, D36), written here from the §4
 * table, as `sp3c.registry` (a fixed range, so states appended later never change it). The generator push appends
 * `sp6b.caveBiome.points` and `sp6b.region.T.biomes`. The keys match `test/goldens.json`.
 */
import { describe, expect, test } from 'vitest';
import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { registryDigest } from '../../src/metrics/sp3aGoldens';
import { sp3cRegistryDigest } from '../../src/metrics/sp3cGoldens';
import { computeSp6bGolden, sp6bGoldenKeys, sp6bRegistryDigest } from '../../src/metrics/sp6bGoldens';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockDef } from '../../src/world/blocks/registry';
import { SOLID_TABLES } from '../harness/blockFixtures';
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

test('1 SP6b key, chained last into allGoldenKeys after SP6a\'s: 63 goldens', () => {
  const keys = ['sp6b.registry'];
  expect(sp6bGoldenKeys()).toEqual(keys);
  expect(allGoldenKeys().slice(-1)).toEqual(keys);
  expect(allGoldenKeys().slice(-4, -1)).toEqual(['sp6a.density.ops', 'sp6a.carver.paths', 'sp6a.region.T.caves']);
  expect(allGoldenKeys()).toHaveLength(63);
  expect(new Set(allGoldenKeys()).size).toBe(63);
  for (const bad of ['sp6b.registry.x', 'sp6b.region.T.biomes', 'sp6b.caveBiome.points', 'sp6b.nope']) {
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

describe('SP6b goldens', () => {
  test.each(sp6bGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp6bGolden(key));
  }, 60_000);
});

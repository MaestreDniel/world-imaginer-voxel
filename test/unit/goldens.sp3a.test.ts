import { describe, expect, test } from 'vitest';
import { fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { genRegionInProcess, regionHash } from '../../src/metrics/region';
import { allGoldenKeys, computeAnyGolden } from '../../src/metrics/sp2aGoldens';
import { computeSp3aGolden, regionDigest, registryDigest, sp3aGoldenKeys } from '../../src/metrics/sp3aGoldens';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry, type BlockDef } from '../../src/world/blocks/registry';
import { createStore } from '../../src/world/store/store';
import { SOLID_TABLES } from '../harness/blockFixtures';
import { expectGolden } from '../harness/goldens';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16 = (v: number): number[] => [v & 255, v >> 8];

/**
 * The §6.4 registry byte stream written out from the §2.2 table and the §2.1 codes, not from the registry's tables:
 * key bytes and a 0, STATE_TYPE (u16 LE), OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE,
 * FLUID_MODE, TINT, SOUND (u8), then six FACE_TEX (u16 LE).
 */
const SP3A_REGISTRY_BYTES = new Uint8Array([
  ...ascii('air'), 0, ...u16(0), 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, ...Array<number>(12).fill(0),
  ...ascii('stone'), 0, ...u16(1), 15, 1, 1, 63, 0, 1, 0, 1, 0, 0, 1, ...Array<number>(12).fill(0),
  ...ascii('bedrock'), 0, ...u16(2), 15, 1, 1, 63, 0, 0, 0, 1, 0, 0, 1, ...Array<number>(12).fill(0),
]);

test('3 unique SP3a keys: the registry and one 8 × 8 region per profile, chained into allGoldenKeys', () => {
  const keys = sp3aGoldenKeys();
  expect(keys).toEqual(['sp3a.registry', 'sp3a.region.T.default', 'sp3a.region.T.large_biomes']);
  expect(sp3aGoldenKeys().length).toBe(3);
  expect(allGoldenKeys().slice(-3)).toEqual(keys);
  expect(new Set(allGoldenKeys()).size).toBe(allGoldenKeys().length);
  expect(computeAnyGolden('sp3a.registry')).toBe(computeSp3aGolden('sp3a.registry'));
  for (const bad of ['sp3a.region.T.amplified', 'sp3a.region.T', 'sp3a.region.D.default', 'sp3a.registry.x', 'sp3a.nope']) {
    expect(() => computeSp3aGolden(bad)).toThrow(/unknown golden/);
    expect(() => computeAnyGolden(bad)).toThrow(/unknown golden/);
  }
});

describe('sp3a.registry (§6.4)', () => {
  test('is the FNV-1a 64 of the byte stream written from the §2.2 table', () => {
    expect(registryDigest()).toBe(hex64(fnv1a64Bytes(SP3A_REGISTRY_BYTES)));
  });

  test('covers ids 0-2 only: appending a type does not change it, a changed SP3a value does', () => {
    const appended: BlockDef = { name: 'granite', ...SOLID_TABLES };
    expect(registryDigest(buildRegistry([...BLOCK_DEFS, appended]))).toBe(registryDigest(REGISTRY));
    const louder: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'bedrock' ? { ...d, sound: 'metal' } : d));
    expect(registryDigest(buildRegistry(louder))).not.toBe(registryDigest(REGISTRY));
    const renamed: BlockDef[] = BLOCK_DEFS.map((d) => (d.name === 'stone' ? { ...d, name: 'rock' } : d));
    expect(registryDigest(buildRegistry(renamed))).not.toBe(registryDigest(REGISTRY));
  });

  test('a registry with fewer than 3 states is refused', () => {
    expect(() => registryDigest(buildRegistry(BLOCK_DEFS.slice(0, 2)))).toThrow(RangeError);
  });
});

describe('sp3a.region.T.<profile> (§6.4)', () => {
  test('is hex64 of regionHash of the 8 × 8 region at (−4, −4), seed 42, on a shared store too', () => {
    const store = createStore({ shared: true, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('large_biomes'));
    genRegionInProcess(store, ctx, -4, -4, 8, 8);
    expect(regionDigest('large_biomes')).toBe(hex64(regionHash(store, -4, -4, 8, 8)));
  });

  test('the two profiles differ and each digest is repeatable', () => {
    const d = regionDigest('default');
    expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(regionDigest('default')).toBe(d);
    expect(regionDigest('large_biomes')).not.toBe(d);
  });
});

describe('SP3a goldens', () => {
  test.each(sp3aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp3aGolden(key));
  }, 60_000);
});

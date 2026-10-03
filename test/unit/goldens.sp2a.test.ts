import { describe, expect, test } from 'vitest';
import { allGoldenKeys, computeAnyGolden, computeSp2aGolden, sp2aGoldenKeys } from '../../src/metrics/sp2aGoldens';
import { expectGolden } from '../harness/goldens';

test('20 unique SP2a keys: 2 point profiles, 1 sample, 16 tiles, 1 spawn', () => {
  const keys = sp2aGoldenKeys();
  expect(keys.length).toBe(20);
  expect(new Set(keys).size).toBe(20);
  expect(keys.filter((k) => k.startsWith('sp2a.tile.')).length).toBe(16);
  expect(allGoldenKeys().length).toBe(50); // 27 SP1 + 20 SP2a + 3 SP3a (SP3a spec §6.4)
  expect(() => computeSp2aGolden('sp2a.tile.biome.32')).toThrow(/unknown golden/);
  expect(() => computeSp2aGolden('sp2a.spawn.x')).toThrow(/unknown golden/);
  expect(computeAnyGolden('sp1.params')).toMatch(/^[0-9a-f]{16}$/);
});

describe('SP2a goldens', () => {
  test.each(sp2aGoldenKeys())('%s', (key) => {
    expectGolden(key, computeSp2aGolden(key));
  }, 60_000);
});

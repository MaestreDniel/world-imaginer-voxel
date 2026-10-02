import { describe, expect, test } from 'vitest';
import { q15 } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { BIOME_SIZE_SCALE, biomeSizePosition } from '../../src/ui/map/biomeSize';

const POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const at = (v: number): number => BIOME_SIZE_SCALE[v - 1]!;

describe('biome-size table (SP2b spec §6.4)', () => {
  test('ten frozen q15 values of 4^((v − 5)/5)', () => {
    expect(BIOME_SIZE_SCALE).toHaveLength(10);
    expect(Object.isFrozen(BIOME_SIZE_SCALE)).toBe(true);
    for (const v of POSITIONS) expect(at(v)).toBe(q15(Math.pow(4, (v - 5) / 5)));
  });

  test('every position writes a valid scaleMul that the draft keeps exactly', () => {
    for (const v of POSITIONS) {
      const r = applyPatch(SCHEMA, resolveProfile('default'), { climate: { scaleMul: at(v) } });
      expect(r.ok && r.value.climate.scaleMul).toBe(at(v));
    }
  });
});

describe('biome-size position (SP2b spec §6.4)', () => {
  test('each table value maps to itself without ≈', () => {
    for (const v of POSITIONS) expect(biomeSizePosition(at(v))).toEqual({ v, exact: true });
  });

  test.each<[number, number]>([[2, 8], [2.01, 8], [0.25, 1], [16, 10], [0.5, 3]])('scaleMul %s → position %s with ≈', (scaleMul, v) => {
    expect(biomeSizePosition(scaleMul)).toEqual({ v, exact: false });
  });

  test('the nearest position in log space: within a factor 1.14 of a table value (half a step is 1.149)', () => {
    for (const v of POSITIONS) {
      expect(biomeSizePosition(at(v) * 1.14)).toEqual({ v, exact: false });
      expect(biomeSizePosition(at(v) / 1.14)).toEqual({ v, exact: false });
    }
  });

  test('the ready profiles: default at 5 and large_biomes at 10, both exact', () => {
    expect(biomeSizePosition(resolveProfile('default').climate.scaleMul)).toEqual({ v: 5, exact: true });
    expect(biomeSizePosition(resolveProfile('large_biomes').climate.scaleMul)).toEqual({ v: 10, exact: true });
  });

  test.each<[number, number]>([[0, 1], [-1, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 10]])('out-of-domain scaleMul %s → position %s with ≈', (scaleMul, v) => {
    expect(biomeSizePosition(scaleMul)).toEqual({ v, exact: false });
  });
});

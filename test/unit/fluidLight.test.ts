import { describe, expect, test } from 'vitest';
import {
  FLUID_LAVA, FLUID_NONE, FLUID_WATER, fluidFalling, fluidLevel, fluidType, fluidUnsettled, hasFluid, NO_FLUID, packFluid,
  WATER_SOURCE,
} from '../../src/world/blocks/fluid';
import { blockLight, MAX_LIGHT, packLight, skyLight } from '../../src/world/blocks/light';

describe('fluid byte (SP3a spec §2.1)', () => {
  test('bits 0-2 level, bit 3 falling, bits 4-5 type, bit 6 unsettled, bit 7 reserved', () => {
    expect([FLUID_NONE, FLUID_WATER, FLUID_LAVA]).toEqual([0, 1, 2]);
    expect(NO_FLUID).toBe(0);
    expect(packFluid(FLUID_NONE, 0)).toBe(0);
    expect(packFluid(FLUID_NONE, 7)).toBe(0b0000_0111);
    expect(packFluid(FLUID_NONE, 0, true)).toBe(0b0000_1000);
    expect(packFluid(FLUID_WATER, 0)).toBe(0b0001_0000);
    expect(packFluid(FLUID_LAVA, 0)).toBe(0b0010_0000);
    expect(packFluid(FLUID_NONE, 0, false, true)).toBe(0b0100_0000);
    expect(packFluid(FLUID_LAVA, 5, true, true)).toBe(0b0110_1101);
    expect(WATER_SOURCE).toBe(packFluid(FLUID_WATER, 0));
    expect(WATER_SOURCE).toBe(16);
  });

  test('pack and unpack round-trip over every byte with bit 7 clear', () => {
    for (let b = 0; b < 128; b++) {
      expect(packFluid(fluidType(b), fluidLevel(b), fluidFalling(b), fluidUnsettled(b))).toBe(b);
    }
  });

  test('fields read back; bit 7 is ignored by the readers and never set by packFluid', () => {
    for (const type of [0, 1, 2, 3]) {
      for (let level = 0; level < 8; level++) {
        for (const falling of [false, true]) {
          for (const unsettled of [false, true]) {
            const b = packFluid(type, level, falling, unsettled);
            expect(b & 0x80).toBe(0);
            for (const x of [b, b | 0x80]) {
              expect(fluidType(x)).toBe(type);
              expect(fluidLevel(x)).toBe(level);
              expect(fluidFalling(x)).toBe(falling);
              expect(fluidUnsettled(x)).toBe(unsettled);
              expect(hasFluid(x)).toBe(type !== 0);
            }
          }
        }
      }
    }
  });

  test('out-of-range fields are masked to their width', () => {
    expect(packFluid(FLUID_WATER, 9)).toBe(packFluid(FLUID_WATER, 1));
    expect(packFluid(5, 0)).toBe(packFluid(1, 0));
  });
});

describe('light byte (SP3a spec §2.1)', () => {
  test('sky << 4 | block, round trip over every byte', () => {
    expect(MAX_LIGHT).toBe(15);
    expect(packLight(15, 0)).toBe(0xf0);
    expect(packLight(0, 15)).toBe(0x0f);
    expect(packLight(3, 12)).toBe(0x3c);
    for (let b = 0; b < 256; b++) {
      expect(packLight(skyLight(b), blockLight(b))).toBe(b);
      expect(skyLight(b)).toBe(b >> 4);
      expect(blockLight(b)).toBe(b & 15);
    }
    expect(packLight(16, 17)).toBe(packLight(0, 1));
  });
});

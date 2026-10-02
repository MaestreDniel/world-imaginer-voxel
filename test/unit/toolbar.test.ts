import { describe, expect, test } from 'vitest';
import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
import type { DriverStatus } from '../../src/ui/map/previewDriver';
import { biomeSizeView, previewStatusText, profileSwitchText } from '../../src/ui/map/toolbar';

const status = (s: Partial<DriverStatus>): DriverStatus => ({ lastLatencyMs: null, pending: false, settled: false, poolEpoch: null, error: null, ...s });

describe('toolbar texts (SP2b spec §2.6, §3.1, §6.4)', () => {
  test('the preview status reads "last edit → preview N ms", with the pending state and the error', () => {
    expect(previewStatusText(status({ pending: true }))).toBe('last edit → preview … · pending');
    expect(previewStatusText(status({ lastLatencyMs: 87.4, settled: true, poolEpoch: 3 }))).toBe('last edit → preview 87 ms');
    expect(previewStatusText(status({ lastLatencyMs: 87.5, pending: true }))).toBe('last edit → preview 88 ms · pending');
    expect(previewStatusText(status({ lastLatencyMs: 120, error: 'BAD_PARAMS: x' }))).toBe('last edit → preview 120 ms · error: BAD_PARAMS: x');
  });

  test('the profile switch confirmation counts the modified parameters', () => {
    expect(profileSwitchText('large_biomes', 1)).toBe('Switching to large_biomes clears 1 modified parameter');
    expect(profileSwitchText('default', 3)).toBe('Switching to default clears 3 modified parameters');
  });

  test('every table value shows its own position without "≈"', () => {
    BIOME_SIZE_SCALE.forEach((scaleMul, i) => {
      const b = biomeSizeView(scaleMul);
      expect([b.v, b.mark]).toEqual([i + 1, '']);
      expect(b.tip).toBe(`Biome size ${i + 1} of 10 (climate.scaleMul ${scaleMul})`);
    });
  });

  test('a value off the table shows the nearest position with "≈" and the exact value in the tooltip', () => {
    for (const [scaleMul, v] of [[2, 8], [2.01, 8], [0.25, 1], [16, 10]] as const) {
      const b = biomeSizeView(scaleMul);
      expect([b.v, b.mark]).toEqual([v, '≈']);
      expect(b.tip).toBe(`Biome size ≈ ${v} of 10: climate.scaleMul is ${scaleMul}; moving the slider writes the table value`);
    }
  });
});

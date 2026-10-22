import { describe, expect, test } from 'vitest';
import { forwardXZ } from '../../src/player/fly';
import { firstView } from '../../src/ui/world/firstView';

const NONE = { y: null, yaw: null, pitch: null };

describe('firstView (SP4a spec §8.4 step 5, D32; ruling P42)', () => {
  test('a flat MOTION_BLOCKING of 70 gives y 72, pitch −10 and yaw 0 (ties to the smallest yaw)', () => {
    expect(firstView(() => 70, 100, -200, NONE)).toEqual({ y: 72, yaw: 0, pitch: -10 });
  });

  test('the lowest sample at 135° gives yaw 135', () => {
    const [dx, dz] = forwardXZ(135);
    const lowX = 10 + 48 * dx;
    const lowZ = -20 + 48 * dz;
    const at = (x: number, z: number) => (Math.hypot(x - lowX, z - lowZ) < 1 ? 50 : 70);
    expect(firstView(at, 10, -20, NONE)).toEqual({ y: 72, yaw: 135, pitch: -10 });
  });

  test('the samples are 48 blocks away at yaw 0°, 45° … 315°', () => {
    const seen: Array<[number, number]> = [];
    firstView((x, z) => { seen.push([x, z]); return 70; }, 0, 0, NONE);
    // The centre first (the default y), then the eight samples in yaw order.
    expect(seen).toHaveLength(9);
    seen.slice(1).forEach(([x, z], k) => {
      const [dx, dz] = forwardXZ(45 * k);
      expect(x).toBeCloseTo(48 * dx, 9);
      expect(z).toBeCloseTo(48 * dz, 9);
    });
  });

  test('a given y, yaw and pitch are kept', () => {
    expect(firstView(() => 70, 0, 0, { y: 90, yaw: 45, pitch: -20 })).toEqual({ y: 90, yaw: 45, pitch: -20 });
    // Each one alone: the others take their defaults.
    expect(firstView(() => 70, 0, 0, { y: 90, yaw: null, pitch: null })).toEqual({ y: 90, yaw: 0, pitch: -10 });
    expect(firstView(() => 70, 0, 0, { y: null, yaw: 200, pitch: null })).toEqual({ y: 72, yaw: 200, pitch: -10 });
  });

  test('eyeAbove sets the height above MOTION_BLOCKING (ruling P48)', () => {
    expect(firstView(() => 70, 0, 0, NONE, 32).y).toBe(102);
  });
});

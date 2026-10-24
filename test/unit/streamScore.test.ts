import { describe, expect, test } from 'vitest';
import { STAGE_BONUS, VIEW_MIN_DH, VIEW_WEIGHT, streamScore } from '../../src/core/streamScore';

const EAST = [1, 0] as const;
const NORTH = [0, -1] as const;

describe('streamScore (SP4b spec §3.3, master §4.3)', () => {
  test('the constants: stage bonuses MESH 1.5, L 1, D 0.5, T 0; view weight 3 beyond d_h 2', () => {
    expect(STAGE_BONUS).toEqual({ T: 0, D: 0.5, L: 1, MESH: 1.5 });
    expect(VIEW_WEIGHT).toBe(3);
    expect(VIEW_MIN_DH).toBe(2);
  });

  test('forward east, MESH bonus: (4, 0) → −0.5; (−4, 0) → 2.5; (2, 0) → 0.5 (no view term at d ≤ 2); (−1, 0) → −0.5', () => {
    expect(streamScore(4, 0, EAST[0], EAST[1], STAGE_BONUS.MESH)).toBeCloseTo(-0.5, 12);
    expect(streamScore(-4, 0, EAST[0], EAST[1], STAGE_BONUS.MESH)).toBeCloseTo(2.5, 12);
    expect(streamScore(2, 0, EAST[0], EAST[1], STAGE_BONUS.MESH)).toBeCloseTo(0.5, 12);
    expect(streamScore(-1, 0, EAST[0], EAST[1], STAGE_BONUS.MESH)).toBeCloseTo(-0.5, 12);
  });

  test('forward north, T bonus: (3, 4) → 5 (cos −0.8 clipped), (3, −4) → 2.6', () => {
    expect(streamScore(3, 4, NORTH[0], NORTH[1], STAGE_BONUS.T)).toBeCloseTo(5, 12);
    expect(streamScore(3, -4, NORTH[0], NORTH[1], STAGE_BONUS.T)).toBeCloseTo(2.6, 12);
  });

  test('the centre column gives −bonus, never NaN: T bonus at (0, 0) → 0; MESH bonus at (0, 0) → −1.5', () => {
    const t = streamScore(0, 0, EAST[0], EAST[1], STAGE_BONUS.T);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBe(0);
    expect(streamScore(0, 0, NORTH[0], NORTH[1], STAGE_BONUS.MESH)).toBe(-1.5);
  });
});

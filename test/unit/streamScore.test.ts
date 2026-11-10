import { describe, expect, test } from 'vitest';
import { STAGE_BONUS, VIEW_MIN_DH, VIEW_WEIGHT, streamScore, streamScoreInto } from '../../src/core/streamScore';

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

  test('streamScoreInto writes streamScore\'s value, bit for bit, into out[i] and nothing else (SP6a Task 52d)', () => {
    const out = new Float64Array(3).fill(-7);
    const yaws = [0, 0.3, 1, 2.5, -1.2];
    for (const yaw of yaws) {
      // A unit forward as the coordinator's (sin, −cos), from a rational point on the circle so core needs no trig.
      const fx = (1 - yaw * yaw) / (1 + yaw * yaw);
      const fz = -(2 * yaw) / (1 + yaw * yaw);
      for (let dx = -20; dx <= 20; dx += 3) {
        for (let dz = -20; dz <= 20; dz += 4) {
          for (const bonus of Object.values(STAGE_BONUS)) {
            streamScoreInto(out, 1, dx, dz, fx, fz, bonus);
            expect(Object.is(out[1], streamScore(dx, dz, fx, fz, bonus)), `${dx}, ${dz}, ${yaw}, ${bonus}`).toBe(true);
            expect([out[0], out[2]]).toEqual([-7, -7]);
          }
        }
      }
    }
  });

  test('the view clamp equals the Math.max form bit for bit, a −0 dot product included (SP6a Task 53)', () => {
    // The formula as it was written before Task 53 (`Math.max(0, q)`), the reference for the ternary clamp.
    const before = (dx: number, dz: number, fx: number, fz: number, bonus: number): number => {
      const d = Math.sqrt(dx * dx + dz * dz);
      const view = d > VIEW_MIN_DH ? VIEW_WEIGHT * Math.max(0, (dx * fx + dz * fz) / d) : 0;
      return d - view - bonus;
    };
    // Forwards with ±0 components (a dot product of exactly ±0 beside the camera) and rational points on the circle.
    const forwards: Array<[number, number]> = [[0, -1], [-0, -1], [1, 0], [1, -0], [-1, 0], [0, 1], [-0, 1], [-0, -0]];
    for (const yaw of [0, 0.3, 1, 2.5, -1.2]) forwards.push([(1 - yaw * yaw) / (1 + yaw * yaw), -(2 * yaw) / (1 + yaw * yaw)]);
    for (const [fx, fz] of forwards) {
      for (let dx = -20; dx <= 20; dx++) {
        for (const dz of [-20, -7, -3, -2, -0, 0, 1, 2, 3, 9, 20]) {
          for (const bonus of Object.values(STAGE_BONUS)) {
            const got = streamScore(dx, dz, fx, fz, bonus);
            expect(Object.is(got, before(dx, dz, fx, fz, bonus)), `${dx}, ${dz}, ${fx}, ${fz}, ${bonus}`).toBe(true);
          }
        }
      }
    }
  });
});

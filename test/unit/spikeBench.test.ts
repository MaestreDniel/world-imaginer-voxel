import { describe, expect, test } from 'vitest';
import { longFrames } from '../../src/render/spike/spikeBench';

/**
 * The spike bench's long frames (SP4b spec §7.6): the gap ending at frame i is listed with frame i's main time and frame
 * i − 1's, which ran inside that gap (`spikeVerdict.test.ts` tests the verdict, not the bench).
 */
describe('spikeBench longFrames (SP4b spec §7.6)', () => {
  test('longFrames on frame deltas [16, 16, 50, 16] and main [1, 2, 9, 3] gives one entry { frame: 2, deltaMs: 50, mainMs: 9, prevMainMs: 2 }', () => {
    expect(longFrames(Float64Array.from([16, 16, 50, 16]), Float64Array.from([1, 2, 9, 3]))).toEqual({
      count: 1,
      first: [{ frame: 2, deltaMs: 50, mainMs: 9, prevMainMs: 2 }],
    });
  });

  test('a long first frame has no previous main time; 33 ms is not long', () => {
    expect(longFrames(Float64Array.from([40, 33, 34]), Float64Array.from([5, 1, 2]))).toEqual({
      count: 2,
      first: [{ frame: 0, deltaMs: 40, mainMs: 5, prevMainMs: null }, { frame: 2, deltaMs: 34, mainMs: 2, prevMainMs: 1 }],
    });
  });
});

/**
 * `A5.waterfalls`' sample (SP7a spec §13.1 as corrected by rulings R20, Task 27b; `test/harness/waterfallSample.ts`): the
 * chunk rule against a direct count of the column samples' steep land on a narrowed scan, the visible-fall rule on
 * hand-built probes, one real visible fall of seed '42' (Task 26's default waterfall shot, fall 15), and the slices the
 * gated metric reads in worker threads (Task 31) summing to the whole scan's reading.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample, readField } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import {
  mergeSampleAccs, probesOf, visibleFallOf, waterfallSampleChunks, waterfallSampleCounts, waterfallSampleRows, WATERFALL_SAMPLE_HALF,
  WATERFALL_SAMPLE_MIN_AREA, WATERFALL_SAMPLE_MIN_STEEP, WATERFALL_SAMPLE_STRIDE, type SampleProbes,
} from '../harness/waterfallSample';

describe('A5.waterfalls\' sample (rulings R20)', () => {
  test('the rule\'s constants: stride 4, half-width 240, ≥ 1 steep position, ≥ 1 km²', () => {
    expect([WATERFALL_SAMPLE_STRIDE, WATERFALL_SAMPLE_HALF, WATERFALL_SAMPLE_MIN_STEEP, WATERFALL_SAMPLE_MIN_AREA]).toEqual([4, 240, 1, 1_000_000]);
  });

  test('a narrowed scan (half-width 12) keeps exactly the lattice chunks holding steep land, with their counts and quadrants', () => {
    const chunks = waterfallSampleChunks('42', DEFAULTS, 12);
    const ctx = createGenContext(seedFromInput('42'), DEFAULTS);
    const s = newColumnSample();
    const expected: Array<{ cx: number; cz: number; steep: number; quadrant: number }> = [];
    for (let b = -12; b < 12; b++) {
      for (let a = -12; a < 12; a++) {
        const cx = 4 * a;
        const cz = 4 * b;
        buildColumnSample(ctx, cx, cz, s);
        let steep = 0;
        for (let i = 0; i < 256; i++) {
          const x = 16 * cx + (i & 15);
          const z = 16 * cz + (i >> 4);
          if (readField(s, 'steep', x, z) >= 1.2 && readField(s, 'offset', x, z) >= 80) steep++;
        }
        if (steep > 0) expected.push({ cx, cz, steep, quadrant: (b >= 0 ? 2 : 0) + (a >= 0 ? 1 : 0) });
      }
    }
    expect(chunks).toEqual(expected);
  });

  test('row slices (Task 31\'s worker threads) sum to the whole narrowed scan\'s reading', () => {
    const whole = waterfallSampleCounts('42', DEFAULTS, waterfallSampleChunks('42', DEFAULTS, 12));
    expect(whole.pooled.chunks, 'the narrowed scan holds steep land').toBeGreaterThan(0);
    const slices = [[-12, -5], [-5, 3], [3, 12]].map(([b0, b1]) => waterfallSampleRows('42', DEFAULTS, b0!, b1!, 12));
    expect(mergeSampleAccs(slices)).toEqual(whole);
    // A slice reaching past the scan's rows is clipped to them.
    expect(mergeSampleAccs([waterfallSampleRows('42', DEFAULTS, -40, 40, 12)])).toEqual(whole);
  });

  test('a visible fall: the outlet open to the sky and ≥ 8 non-solid voxels with no fluid below it', () => {
    // A spring at (0, 100, 0) facing E: its outlet column is x 1, z 0.
    const probe = (solidAbove: number | null, floor: number, fluidAt: number | null): SampleProbes => ({
      solid: (x, y, z) => x === 1 && z === 0 && (y === solidAbove || y <= floor),
      fluid: (x, y, z) => (x === 1 && z === 0 && y === fluidAt ? 1 : 0),
    });
    expect(visibleFallOf(probe(null, 89, null), 0, 100, 0, 1)).toBe(10);
    expect(visibleFallOf(probe(250, 89, null), 0, 100, 0, 1)).toBe(0); // a block above the outlet
    expect(visibleFallOf(probe(null, 92, null), 0, 100, 0, 1)).toBe(0); // a fall of 7
    expect(visibleFallOf(probe(null, 92 - 1, null), 0, 100, 0, 1)).toBe(8);
    expect(visibleFallOf(probe(null, 50, 91), 0, 100, 0, 1)).toBe(8); // lands on water after 8
  });

  test('seed \'42\'s spring at (−556, 195, 31) (Task 26\'s default waterfall) is a visible fall of 15', () => {
    const ctx = createGenContext(seedFromInput('42'), DEFAULTS);
    const list = newSpringList();
    terrainSpringsDebug(ctx, -35, 1, list);
    const j = ((195 + 64) * 16 + (31 - 16)) * 16 + (-556 + 560);
    const k = Array.from(list.pos.subarray(0, list.n)).indexOf(j);
    expect(k, 'the spring is in T\'s list').toBeGreaterThanOrEqual(0);
    expect(list.kind[k]).toBe(0);
    expect(visibleFallOf(probesOf(ctx), -556, 195, 31, list.dir[k]!)).toBe(15);
  });
});

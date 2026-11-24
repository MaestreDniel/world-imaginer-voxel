import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { currentTier, metricTest } from '../harness/metric';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import { mergeSampleAccs, WATERFALL_SAMPLE_HALF, WATERFALL_SAMPLE_MIN_AREA, type SampleAcc } from '../harness/waterfallSample';
import type { SampleRowsMsg, SampleRowsReply } from '../harness/waterfallSampleWorker';

/**
 * `A5.waterfalls` (SP7a spec §13.1 as corrected by rulings R20; Task 31, rulings R23's dispatch item 2): visible water
 * falls per km² of steep land on the fixed default-profile sample of seed '42' (`test/harness/waterfallSample.ts`: the
 * lattice chunks (4a, 4b), a and b in −240 … 239, whose column sample holds steep land; the falls from T and its point
 * probes, no settle), gated at Point 2's 25-100 (the user's choice, target about 50).
 * - **Tiers** (spec §14): the sample is one fixed set of chunks, the same on every tier, so it is read on quick and full
 *   only (`tiers: ['quick', 'full']`); on fast this file registers a skipped test and reads nothing, so `npm test` and
 *   CI's metrics-fast shards pay nothing for it.
 * - **Cost** (spec §14): about 3.6 min single-threaded on the laptop (the scan 72 s, the springs 146 s; Task 27), so it
 *   runs in `SAMPLE_WORKERS` worker threads (`waterfallSampleWorker.ts`), each idle worker taking the next slice of
 *   `SLICE_ROWS` lattice rows; the slices' counts are summed (`mergeSampleAccs`, equal to the whole scan's whatever the
 *   slicing). In CI its own file rides the metrics-quick `render` shard (`.github/scripts/metricShards.mjs`), the shard
 *   with the most slack, so the job count stays 20.
 * - **Recorded** (`.out/A5.waterfalls.json`): the pooled counts (chunks, steep land in km², water springs, visible falls),
 *   each lattice quadrant's reading (`waterfalls.q0` … `q3`: (b ≥ 0)·2 + (a ≥ 0)), the fall heights (`fall.<h>`) and the
 *   wall time; the sample's steep land is asserted ≥ 1 km² (`WATERFALL_SAMPLE_MIN_AREA`, rulings R20).
 */
const TIER = currentTier();

/** The worker threads reading the sample (CI's runners have 4 CPUs). */
const SAMPLE_WORKERS = 4;
/** The lattice rows of one slice (480 rows: 30 slices). */
const SLICE_ROWS = 16;

/** The sample's slices' raw counts, read in `SAMPLE_WORKERS` worker threads, each slice's in the slices' order. */
async function sampleSlices(seed: string): Promise<SampleAcc[][]> {
  const script = await buildNodeTaskWorker(`waterfallSampleWorker-${TIER}`, { entry: 'test/harness/waterfallSampleWorker.ts' });
  const params = resolveProfile('default');
  const starts: number[] = [];
  for (let b = -WATERFALL_SAMPLE_HALF; b < WATERFALL_SAMPLE_HALF; b += SLICE_ROWS) starts.push(b);
  const out: SampleAcc[][] = starts.map(() => []);
  const workers = Array.from({ length: SAMPLE_WORKERS }, () => new Worker(script));
  let next = 0;
  try {
    await Promise.all(workers.map(async (w) => {
      while (next < starts.length) {
        const k = next++;
        const b0 = starts[k]!;
        const msg: SampleRowsMsg = { type: 'rows', seed, params, b0, b1: Math.min(b0 + SLICE_ROWS, WATERFALL_SAMPLE_HALF), half: WATERFALL_SAMPLE_HALF };
        const reply = await ask<SampleRowsReply>(w, msg);
        if (reply.type !== 'counted') throw new Error(`waterfall sample worker, rows ${b0}: ${reply.type === 'error' ? reply.message : String((reply as { type: unknown }).type)}`);
        if (reply.b0 !== b0) throw new Error(`waterfall sample worker: asked rows ${b0}, answered ${reply.b0}`);
        out[k] = reply.accs;
      }
    }));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return out;
}

if (TIER === 'fast') {
  test.skip('A5.waterfalls: read on quick and full only (its sample is the same on every tier; spec §14)', () => {});
} else {
  metricTest('A5', ['waterfalls'], async () => {
    const t0 = performance.now();
    const s = mergeSampleAccs(await sampleSlices('42'));
    const p = s.pooled;
    expect(p.steepKm2 * 1e6, 'the sample\'s steep land (rulings R20: at least 1 km²)').toBeGreaterThanOrEqual(WATERFALL_SAMPLE_MIN_AREA);
    const heights = Object.fromEntries(Object.entries(p.fallHeights).map(([h, n]) => [`fall.${h}`, n]));
    return {
      waterfalls: p.waterfalls, chunks: p.chunks, steepKm2: p.steepKm2, waterSprings: p.waterSprings, visibleFalls: p.visibleFalls,
      ...Object.fromEntries(s.quadrants.map((q, i) => [`waterfalls.q${i}`, q.waterfalls])), ...heights,
      ms: Math.round(performance.now() - t0),
    };
  }, 900_000, { outName: 'A5.waterfalls' });
}

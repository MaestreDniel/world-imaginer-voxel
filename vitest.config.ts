import { defineConfig } from 'vitest/config';

type Tier = 'fast' | 'quick' | 'full';

const metrics = (tier: Tier) => ({
  test: { name: `metrics-${tier}`, include: ['test/metrics/**/*.metric.ts'], env: { METRICS_TIER: tier } },
});

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    projects: [
      // Several unit tests make ~1M evaluations (spline test 6, q15): ~2.5 s locally, ~6 s on a CI runner.
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 30_000 } },
      // Real worker threads with wall-clock bounds (abort.test.ts: 50 ms). They run after the other projects, one file
      // at a time, so the parallel forks of the suite do not take the CPUs their threads need.
      {
        test: {
          name: 'integration', include: ['test/integration/**/*.test.ts'], testTimeout: 120_000,
          fileParallelism: false, sequence: { groupOrder: 1 },
        },
      },
      { test: { name: 'arch', include: ['test/arch/**/*.test.ts'] } },
      metrics('fast'),
      metrics('quick'),
      metrics('full'),
      { test: { name: 'bench', include: [], benchmark: { include: ['test/bench/**/*.bench.ts'] } } },
    ],
  },
});

export interface FrameSummary {
  fps: number;
  p50: number;
  p95: number;
  count: number;
}

export interface FrameStats {
  push(frameMs: number): void;
  summary(): FrameSummary;
}

export function nearestRank(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export function createFrameStats(capacity = 120): FrameStats {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`frameStats capacity must be a positive integer (got ${capacity})`);
  const ring = new Float64Array(capacity);
  let next = 0;
  let count = 0;
  return {
    push(frameMs) {
      if (!Number.isFinite(frameMs) || frameMs < 0) return;
      ring[next] = frameMs;
      next = (next + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    summary() {
      if (count === 0) return { fps: 0, p50: 0, p95: 0, count: 0 };
      const sorted = Array.from(ring.subarray(0, count)).sort((a, b) => a - b);
      const mean = sorted.reduce((a, b) => a + b, 0) / count;
      return { fps: mean > 0 ? 1000 / mean : 0, p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95), count };
    },
  };
}

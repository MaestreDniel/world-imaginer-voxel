import { compileSpline, evalSpline, withKnotY } from '../../src/core/spline/hermite';
import { createGenContext } from '../../src/gen/context';
import { newClimate, pvFold, sampleClimate } from '../../src/gen/column/climate';
import { buildColumnSample, latticeIndex, newColumnSample } from '../../src/gen/column/columnStage';
import { offsetFrom } from '../../src/gen/column/shape';
import { Moments, samplePoints } from '../../src/metrics/noiseStats';
import { ctxFor, paramsWith } from '../harness/gen';
import { metricTest } from '../harness/metric';
import { knotY, pathWeight } from '../harness/spline';
import { testFloat, testRng } from '../harness/stats';
import { seedFromInput } from '../../src/core/seed';

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

metricTest('T6', ['minGain', 'maxGain'], () => {
  const params = paramsWith();
  const offset = params.shape.offset;
  const n = pick(20000, 80000, 200000);
  let lo = Infinity;
  let hi = -Infinity;
  for (const path of [[2], [5, 1], [7, 1, 1]]) {
    const raised = paramsWith({ shape: { offset: withKnotY(offset, path, knotY(offset, path) + 10) } });
    const a = createGenContext(seedFromInput('42'), params);
    const b = createGenContext(seedFromInput('42'), raised);
    const pts = samplePoints(`T6.${path.join('.')}`, n);
    const coords = new Float64Array(6);
    let dsum = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const c = sampleClimate(a, pts.x[i]!, pts.z[i]!, newClimate());
      const w = pathWeight(offset, path, Float64Array.of(c.C, c.E, c.W, c.PV, c.T, c.H));
      if (w <= 0) continue;
      dsum += offsetFrom(b, c, coords) - offsetFrom(a, c, coords);
      wsum += w;
    }
    const gain = dsum / wsum;
    lo = Math.min(lo, gain);
    hi = Math.max(hi, gain);
  }
  return { minGain: lo, maxGain: hi };
});

metricTest('T7', ['value', 'borderMismatch'], () => {
  const a = newColumnSample();
  const b = newColumnSample();
  const border: number[] = [];
  const inner: number[] = [];
  let borderMismatch = 0;
  for (const seed of ['42', '1']) {
    const ctx = ctxFor(seed);
    const next = testRng(707);
    for (let t = 0; t < pick(2000, 5000, 12000); t++) {
      const cx = (next() % 20000) - 10000;
      const cz = (next() % 20000) - 10000;
      buildColumnSample(ctx, cx, cz, a);
      buildColumnSample(ctx, cx + 1, cz, b);
      for (let j = 0; j <= 4; j++) {
        // The shared border point must be identical in both samples; then compare a 4-block step across the
        // border (read from the two columns' own samples) with the 4 steps inside a column, by median |Δsteep|.
        if (!Object.is(a.f.steep[latticeIndex(4, j)], b.f.steep[latticeIndex(0, j)])) borderMismatch++;
        border.push(Math.abs(b.f.steep[latticeIndex(1, j)]! - a.f.steep[latticeIndex(4, j)]!));
        for (let i = 0; i < 4; i++) inner.push(Math.abs(a.f.steep[latticeIndex(i + 1, j)]! - a.f.steep[latticeIndex(i, j)]!));
      }
    }
  }
  const median = (v: number[]) => v.sort((x, y) => x - y)[v.length >> 1]!;
  return { value: median(border) / median(inner), borderMismatch };
});

metricTest('T8', ['E', 'PV'], () => {
  const ctx = ctxFor('42');
  const spline = compileSpline(ctx.params.shape.offset);
  const next = testRng(808);
  const n = pick(1000, 4000, 12000);
  const sweep = 41;
  const eSd = new Moments();
  const pvSd = new Moments();
  const v = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    const C = -0.1 + 1.0973 * testFloat(next);
    const W = -1 + 2 * testFloat(next);
    const E = -1 + 2 * testFloat(next);
    const e = new Moments();
    const p = new Moments();
    for (let k = 0; k < sweep; k++) {
      const u = -1 + (2 * k) / (sweep - 1);
      v[0] = C; v[1] = u; v[2] = W; v[3] = pvFold(W);
      const oe = evalSpline(spline, v);
      if (oe >= 63) e.add(oe);
      v[1] = E; v[2] = u; v[3] = pvFold(u);
      const op = evalSpline(spline, v);
      if (op >= 63) p.add(op);
    }
    if (e.n > 1) eSd.add(e.sd);
    if (p.n > 1) pvSd.add(p.sd);
  }
  return { E: eSd.mean, PV: pvSd.mean };
});

metricTest('T1lowland', ['value'], () => {
  const n = pick(60000, 200000, 500000);
  let land = 0;
  let band = 0;
  for (let s = 1; s <= 2; s++) {
    const ctx = ctxFor(String(s));
    const pts = samplePoints(`T1lowland.${s}`, n);
    const coords = new Float64Array(6);
    for (let i = 0; i < n; i++) {
      const o = offsetFrom(ctx, sampleClimate(ctx, pts.x[i]!, pts.z[i]!, newClimate()), coords);
      if (o < 63) continue;
      land++;
      if (o >= 66 && o < 76) band++;
    }
  }
  return { value: band / land };
});

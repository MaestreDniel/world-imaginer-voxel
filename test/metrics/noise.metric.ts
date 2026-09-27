import type { Seed64 } from '../../src/core/hash';
import { toUniform } from '../../src/core/noise/cdf';
import { NormalNoise } from '../../src/core/noise/normal';
import type { NoiseDef } from '../../src/core/noise/types';
import { DEFAULTS } from '../../src/core/params/defaults';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { meanAbsPairDiff, meanAbsShiftDiff, Moments, pearson, samplePoints, ksUniform, type Field } from '../../src/metrics/noiseStats';
import { ADVERSARIAL_DEFS, DENSITY3D_DEF } from '../../src/metrics/sp1Fixtures';
import { metricTest } from '../harness/metric';

const Normal = NormalNoise;
const U = toUniform;

type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

export interface MetricNoise {
  readonly name: string;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
  readonly corners: boolean;
}

/** The 12 live schema instances (SP1 spec §7.3 "schema" set). */
export const SCHEMA_NOISES: readonly MetricNoise[] = noiseInstances(SCHEMA, DEFAULTS).map((i) => ({ name: i.seedName, def: i.def, dims: i.dims, corners: false }));
/** The 6 climate fields. */
export const CLIMATE_NOISES: readonly MetricNoise[] = SCHEMA_NOISES.filter((n) => n.def.remap === 'uniform');
/** Adversarial single-stack defs plus the 3D density-like def. */
export const TEST_NOISES: readonly MetricNoise[] = [...ADVERSARIAL_DEFS, DENSITY3D_DEF].map((f) => ({ name: f.seedName, def: f.def, dims: f.dims, corners: f.corners }));

export function field(seed: Seed64, n: MetricNoise): Field {
  const nn = new Normal(seed, n.name, n.def);
  return n.dims === 2 ? (x, _y, z) => nn.z2(x, z) : (x, y, z) => nn.z3(x, y, z);
}

metricTest('N1', ['ksD', 'sdErr'], () => {
  const seeds = pick(4, 16, 16);
  const n = pick(50000, 50000, 200000);
  const pts = samplePoints('N1', n);
  const u = new Float64Array(n);
  let ksD = 0;
  let sdErr = 0;
  for (let s = 1; s <= seeds; s++) {
    for (const nz of CLIMATE_NOISES) {
      const nn = new Normal([s, 0], nz.name, nz.def);
      const m = new Moments();
      for (let i = 0; i < n; i++) {
        const z = nn.z2(pts.x[i]!, pts.z[i]!);
        m.add(z);
        u[i] = U(z);
      }
      ksD = Math.max(ksD, ksUniform(u));
      sdErr = Math.max(sdErr, Math.abs(m.sd - 1));
    }
  }
  return { ksD, sdErr };
});

metricTest('N2', ['value'], () => {
  const set = TIER === 'fast' ? CLIMATE_NOISES : SCHEMA_NOISES;
  const n = 100000;
  const K = pick(8, 64, 64);
  const bases = pick([1000], [1000], [1000, 5000]);
  const pts = samplePoints('N2', n);
  const valuesAt = (lo: number) => set.map((nz) => {
    const nn = new Normal([lo, 0], nz.name, nz.def);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = nn.z2(pts.x[i]!, pts.z[i]!);
    return v;
  });
  let worst = 0;
  for (const b of bases) {
    const base = valuesAt(b);
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) worst = Math.max(worst, Math.abs(pearson(base[i]!, base[j]!)));
    for (let k = 1; k <= K; k++) {
      const other = valuesAt(b + k);
      for (let i = 0; i < set.length; i++) for (let j = 0; j < set.length; j++) worst = Math.max(worst, Math.abs(pearson(base[i]!, other[j]!)));
    }
  }
  return { value: worst };
});

metricTest('N3', ['value'], () => {
  const n = pick(5000, 20000, 50000);
  const a = samplePoints('N3.a', n);
  const b = samplePoints('N3.b', n);
  let worst = Infinity;
  for (const s of [1, 2]) {
    for (const nz of [...SCHEMA_NOISES, ...TEST_NOISES]) {
      const f = field([s, 0], nz);
      const base = meanAbsPairDiff(f, a, b, nz.corners);
      const dirs: Array<[number, number, number]> = nz.dims === 3 ? [[1, 0, 0], [0, 0, 1], [1, 0, 1], [0, 1, 0]] : [[1, 0, 0], [0, 0, 1], [1, 0, 1]];
      for (const P of [256, 512, 1024, 2048, 4096, 65536]) {
        const L = P * nz.def.wavelength;
        for (const e of dirs) worst = Math.min(worst, meanAbsShiftDiff(f, a, [L * e[0], L * e[1], L * e[2]], nz.corners) / base);
      }
    }
  }
  return { value: worst };
});

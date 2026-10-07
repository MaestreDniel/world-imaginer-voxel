import type { Seed64 } from '../../src/core/hash';
import { toUniform } from '../../src/core/noise/cdf';
import { NormalNoise } from '../../src/core/noise/normal';
import type { NoiseDef } from '../../src/core/noise/types';
import { DEFAULTS } from '../../src/core/params/defaults';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { lastOctaveWavelength, meanAbsPairDiff, meanAbsShiftDiff, Moments, pearson, Rose, samplePoints, ksUniform, zeroRate, type Field } from '../../src/metrics/noiseStats';
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

/** The live schema instances (SP1 spec §7.3 "schema" set): 12 climate, 4 shape (SP2a), 3 density (SP3b). */
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

const latticeTerms = (def: NoiseDef) => def.octaves * (def.double ? 2 : 1);

metricTest('N5', ['horizontal', 'vertical'], () => {
  const n = pick(100000, 200000, 400000);
  const pts = samplePoints('N5', n);
  let horizontal = 0;
  let vertical = 0;
  const DENSITY = TEST_NOISES.find((t) => t.name === 'test.density3d')!;
  for (const s of [1, 2]) {
    for (const nz of [...SCHEMA_NOISES, DENSITY].filter((t) => latticeTerms(t.def) >= 2)) {
      const nn = new Normal([s, 0], nz.name, nz.def);
      const c = nn.clamp;
      const h = lastOctaveWavelength(nz.def) / 128;
      const f: Field = nz.dims === 2 ? (x, _y, z) => nn.z2(x, z) : (x, y, z) => nn.z3(x, y, z);
      // The vertical rose is measured in lattice coordinates (SP3b spec §3.3, master §6.4 amended): the gradient of
      // z3(x, y / yScale, z), so an anisotropic noise (yScale ≠ 1; the overhang noise had 1.25 before the SP3b §8.4
      // retune) is compared with itself on the lattice.
      const ys = nz.def.yScale;
      const g: Field = (x, y, z) => nn.z3(x, y / ys, z);
      const hr = new Rose();
      const vr = new Rose();
      for (let i = 0; i < n; i++) {
        const x = pts.x[i]!, y = pts.y[i]!, z = pts.z[i]!;
        const xp = f(x + h, y, z), xm = f(x - h, y, z), zp = f(x, y, z + h), zm = f(x, y, z - h);
        if (Math.abs(xp) !== c && Math.abs(xm) !== c && Math.abs(zp) !== c && Math.abs(zm) !== c) hr.add(xp - xm, zp - zm);
        if (nz.dims === 3) {
          const gxp = ys === 1 ? xp : g(x + h, y, z), gxm = ys === 1 ? xm : g(x - h, y, z);
          const yp = g(x, y + h, z), ym = g(x, y - h, z);
          if (Math.abs(gxp) !== c && Math.abs(gxm) !== c && Math.abs(yp) !== c && Math.abs(ym) !== c) vr.add(gxp - gxm, yp - ym);
        }
      }
      horizontal = Math.max(horizontal, hr.ratio());
      if (nz.dims === 3) vertical = Math.max(vertical, vr.ratio());
    }
  }
  return { horizontal, vertical };
});

metricTest('N6', ['value'], () => {
  const n = pick(50000, 200000, 1000000);
  const pts = samplePoints('N6', n);
  let worst = 0;
  for (const s of [1, 2]) for (const nz of [...SCHEMA_NOISES, ...TEST_NOISES]) worst = Math.max(worst, zeroRate(field([s, 0], nz), pts, nz.corners));
  return { value: worst };
});

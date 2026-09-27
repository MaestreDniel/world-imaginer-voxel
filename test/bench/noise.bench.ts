import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { detErf } from '../../src/core/detMath';
import { fmix32 } from '../../src/core/hash';
import { lattice3 } from '../../src/core/noise/lattice3';
import { NormalNoise } from '../../src/core/noise/normal';
import { DEFAULTS } from '../../src/core/params/defaults';
import { Xoshiro128 } from '../../src/core/rng';
import { compileSpline, evalSpline } from '../../src/core/spline/hermite';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { DENSITY3D_DEF, JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
import { gateFailures, type Baselines, type BenchKernel } from './gates';
import { buildPerm, perm3 } from './perm512';

const FMIX = fmix32;
const LAT = lattice3;
const PERM = perm3;
const ERF = detErf;
const EVAL = evalSpline;
const HASHES = stageHashes;
const GENKEY = genKey;
const BASELINE_PATH = fileURLToPath(new URL('../baselines.json', import.meta.url));
const N = 4096;
let sink = 0;

test('SP1 kernels', async ({ bench }) => {
  const ns: Record<string, number> = {};
  const measure = async (name: string, evals: number, fn: () => void) => {
    const r = await bench(name, fn).run();
    ns[name] = (r.latency.p50 * 1e6) / evals;
  };
  const rng = new Xoshiro128(7);
  const ints = Uint32Array.from({ length: N }, () => rng.nextU32());
  const rx = Float64Array.from({ length: N }, () => rng.nextFloat() * 4096);
  const ry = Float64Array.from({ length: N }, () => rng.nextFloat() * 4096);
  const rz = Float64Array.from({ length: N }, () => rng.nextFloat() * 4096);
  const wx = Float64Array.from({ length: N }, () => -524288 + 1048576 * rng.nextFloat());
  const wz = Float64Array.from({ length: N }, () => -524288 + 1048576 * rng.nextFloat());
  const cx = Float64Array.from({ length: N }, () => 4 * Math.floor((-524288 + 1048576 * rng.nextFloat()) / 4));
  const cy = Float64Array.from({ length: N }, () => 8 * Math.floor((-64 + 384 * rng.nextFloat()) / 8));
  const cz = Float64Array.from({ length: N }, () => 4 * Math.floor((-524288 + 1048576 * rng.nextFloat()) / 4));
  const coords = Float64Array.from({ length: 6 * N }, () => -1.25 + 2.5 * rng.nextFloat());
  const P = buildPerm(12345);
  const climateC = new NormalNoise([42, 0], 'climate.C', DEFAULTS.climate.C);
  const density = new NormalNoise([42, 0], DENSITY3D_DEF.seedName, DENSITY3D_DEF.def);
  const off = compileSpline(OFFSET);
  const sig = compileSpline(SIGMA);
  const jag = compileSpline(JAG);
  const c6 = new Float64Array(6);

  await measure('calibration.fmix32', N, () => { let s = 0; for (let i = 0; i < N; i++) s ^= FMIX(ints[i]!); sink ^= s; });
  await measure('lattice3.slice', N, () => { let s = 0; for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) s += LAT(12345, 1000.3 + i / 64, 1234.37, 777.1 + j / 64); sink += s; });
  await measure('perm512.slice', N, () => { let s = 0; for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) s += PERM(P, 1000.3 + i / 64, 1234.37, 777.1 + j / 64); sink += s; });
  await measure('lattice3.random', N, () => { let s = 0; for (let i = 0; i < N; i++) s += LAT(12345, rx[i]!, ry[i]!, rz[i]!); sink += s; });
  await measure('perm512.random', N, () => { let s = 0; for (let i = 0; i < N; i++) s += PERM(P, rx[i]!, ry[i]!, rz[i]!); sink += s; });
  await measure('normal.z2.climateC', N, () => { let s = 0; for (let i = 0; i < N; i++) s += climateC.z2(wx[i]!, wz[i]!); sink += s; });
  await measure('normal.z3.density3d', N, () => { let s = 0; for (let i = 0; i < N; i++) s += density.z3(cx[i]!, cy[i]!, cz[i]!); sink += s; });
  await measure('spline.offset', N, () => {
    let s = 0;
    for (let j = 0; j < N; j++) { for (let k = 0; k < 6; k++) c6[k] = coords[6 * j + k]!; s += EVAL(off, c6); }
    sink += s;
  });
  await measure('spline.mix3', N, () => {
    let s = 0;
    for (let j = 0; j < N; j++) { for (let k = 0; k < 6; k++) c6[k] = coords[6 * j + k]!; s += EVAL(off, c6) + EVAL(sig, c6) + EVAL(jag, c6); }
    sink += s;
  });
  await measure('detErf', N, () => { let s = 0; for (let i = 0; i < N; i++) s += ERF(rx[i]! / 512 - 4); sink += s; });
  await measure('stageHashes.genKey', 16, () => { for (let i = 0; i < 16; i++) sink += GENKEY([42, 0], HASHES(DEFAULTS))[0]; });

  const calib = ns['calibration.fmix32']!;
  const kernels: Record<string, BenchKernel> = {};
  for (const [name, v] of Object.entries(ns)) kernels[name] = { nsPerEval: Math.round(v * 1000) / 1000, ratio: Math.round((v / calib) * 1000) / 1000 };
  const killRatio = Math.round(Math.max(ns['lattice3.slice']! / ns['perm512.slice']!, ns['lattice3.random']! / ns['perm512.random']!) * 1000) / 1000;
  console.table(kernels);
  console.log(`killRatio ${killRatio}`);
  expect(Number.isFinite(sink)).toBe(true);
  if (process.env.BENCH_RECORD === '1') {
    const next: Baselines = { machine: cpus()[0]?.model ?? 'unknown', node: process.version, date: new Date().toISOString().slice(0, 10), kernels, killRatio };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const baseline = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baselines) : null;
  if (baseline === null) console.log('no test/baselines.json yet: P1 not gated (run npm run bench:record on the reference machine)');
  expect(gateFailures(baseline, kernels, killRatio)).toEqual([]);
}, 600_000);

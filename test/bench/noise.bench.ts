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
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { paintTile } from '../../src/gen/map/tile';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, type Baselines, type BenchKernel } from './gates';
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

test('SP1, SP2a and SP2b kernels', async ({ bench }) => {
  const ns: Record<string, number> = {};
  const measure = async (name: string, evals: number, fn: () => void, iterations?: number) => {
    const r = await bench(name, fn).run(iterations === undefined ? undefined : { iterations, time: 0, warmupIterations: 1 });
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
  const gen = createGenContext(seedFromInput('42'), DEFAULTS);
  let col = 0;
  await measure('column.point', 64, () => { for (let i = 0; i < 64; i++) sink += columnPoint(gen, wx[(col + i) & (N - 1)]!, wz[(col + i) & (N - 1)]!).offset; col += 64; });
  const sample = newColumnSample();
  let cs = 0;
  const columnRun = await bench('column.sample', () => { cs++; buildColumnSample(gen, (cs * 7919) % 60000 - 30000, (cs * 104729) % 60000 - 30000, sample); sink += sample.f.offset[24]!; }).run();
  ns['column.sample'] = columnRun.latency.p50 * 1e6;
  // tinybench keeps no samples by default; p99 bounds p95 from above, so gating p99 is the stricter check.
  const columnP95 = columnRun.latency.p99;
  const tile = new Uint8ClampedArray(262144);
  let tt = 0;
  await measure('map.tile.b64.biome', 1, () => { paintTile(gen, 'biome', 64, tt++ % 7, 3, tile); sink += tile[0]!; }, 8);
  await measure('map.tile.b16.relief', 1, () => { paintTile(gen, 'relief', 16, tt++ % 7, -2, tile); sink += tile[0]!; }, 8);
  // SP2b §2.8: a worker's configure (default params as a structured clone, as a posted message delivers them)
  // and the 4 preview tiles of the default view (0, 0, 64 bpp).
  const handler = createTaskHandler();
  const posted = structuredClone(DEFAULTS);
  let epoch = 0;
  await measure('worker.configure', 1, () => { sink += handler.handle({ type: 'configure', epoch: epoch++, seedText: '42', params: posted, abort: null }).msg.type === 'ready' ? 1 : 0; });
  const preview = [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const;
  let pt = 0;
  await measure('map.tile.b256.biome', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'biome', 256, tx, tz, tile); sink += tile[0]!; }, 8);
  await measure('map.tile.b256.relief', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'relief', 256, tx, tz, tile); sink += tile[0]!; }, 8);

  const calib = ns['calibration.fmix32']!;
  const kernels: Record<string, BenchKernel> = {};
  for (const [name, v] of Object.entries(ns)) kernels[name] = { nsPerEval: Math.round(v * 1000) / 1000, ratio: Math.round((v / calib) * 1000) / 1000 };
  const killRatio = Math.round(Math.max(ns['lattice3.slice']! / ns['perm512.slice']!, ns['lattice3.random']! / ns['perm512.random']!) * 1000) / 1000;
  console.table(kernels);
  console.log(`killRatio ${killRatio}`);
  console.log(`column.sample p50 ${columnRun.latency.p50.toFixed(3)} ms, p99 (≥ p95) ${columnP95.toFixed(3)} ms`);
  expect(columnRun.latency.p50, 'P1 column p50').toBeLessThanOrEqual(COLUMN_P50_MAX_MS);
  expect(columnP95, 'P1 column p95').toBeLessThanOrEqual(COLUMN_P95_MAX_MS);
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

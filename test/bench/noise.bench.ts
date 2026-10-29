import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Bench } from 'tinybench';
import { expect, test } from 'vitest';
import { detErf } from '../../src/core/detMath';
import { fmix32 } from '../../src/core/hash';
import { lattice3 } from '../../src/core/noise/lattice3';
import { NormalNoise } from '../../src/core/noise/normal';
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { compileSpline, evalSpline } from '../../src/core/spline/hermite';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DENSITY3D_DEF, JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { surfacePass } from '../../src/gen/surface/pass';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { paintTile } from '../../src/gen/map/tile';
import { fillColumnT } from '../../src/metrics/region';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { createDiffStore } from '../../src/sim/diffStore';
import { applyEdits, createEditScratch, type Edit } from '../../src/sim/edits';
import { NO_FLUID } from '../../src/world/blocks/fluid';
import { AIR, OPACITY, STONE, TORCH } from '../../src/world/blocks/index';
import { createTaskHandler } from '../../src/workers/taskHandler';
import { fillColumnD, fillColumnL } from '../../src/workers/worldJobs';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion } from '../../src/light/initial';
import { createMeshScratch, isTrivial } from '../../src/mesh/column';
import { connectivity15 } from '../../src/mesh/connectivity';
import { fluidDepths, meshFluid } from '../../src/mesh/fluid';
import { meshSolid, type MeshOptions } from '../../src/mesh/greedy';
import type { NeighborhoodReader } from '../../src/world/store/api';
import { copyLightRegion, copyPaddedSection } from '../../src/world/store/padded';
import { PART_BUDGET, REQUEST_BUDGET } from '../../src/core/constants';
import type { Params } from '../../src/core/params/schema';
import { sliceCostOf } from '../../src/gen/inspect/fieldSlice';
import { runFieldSlice } from '../../src/workers/fieldSliceJob';
import { planFieldSlice, type FieldSliceMsg, type FieldSliceSpec } from '../../src/workers/protocol';
import { DEFAULT_MAP_STATE, openMapSession, type MapState } from '../../src/ui/map/mapState';
import { capDensityTree, capSurfaceRules } from '../harness/capTrees';
import { PART_WORST_LEAVES, partWorstParams } from '../harness/sliceTrees';
import {
  absoluteGateFailures, BENCH_ROWS, benchKernels, CALIBRATION_BESIDE_RUN, gateFailures, ISLANDS_COLUMNS, ISLANDS_RUN, LIGHT_RUN, MESH_RUN,
  parseBenchExempt, RELIGHT_RUN, type Baselines,
} from './gates';
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

/**
 * SP3d §9: the slice rows' evaluation as one worker of the pool would run it — each part [from, to) of `spec` through
 * the handler's path (`runFieldSlice`: the BAD_ARGS checks and the part bound on `sliceCostOf`, recomputed from the
 * configured params, then `gen/inspect/fieldSlice.ts`'s evaluation), on a fresh GenContext per slice (cold caches: the
 * case right after an edit; the parts share it, as one worker's configured context). A refused part or an empty reply
 * throws, so a row can never time a BAD_ARGS. The density field reads no T column.
 */
const NO_T_COLUMNS = (): never => { throw new Error('a density slice reads no T column'); };
const NEVER = (): boolean => false;
function slice(params: Params, spec: FieldSliceSpec, ranges: readonly (readonly [number, number])[]): number {
  const ctx = createGenContext(seedFromInput('42'), params);
  let s = 0;
  for (const [from, to] of ranges) {
    const msg: FieldSliceMsg = { ...spec, type: 'fieldSlice', jobId: 0, epoch: 0, scope: 0, from, to };
    const r = runFieldSlice(ctx, msg, NEVER, NO_T_COLUMNS);
    if (r === null || 'badArgs' in r) throw new Error(`slice part [${from}, ${to}) refused: ${r === null ? 'stopped' : r.badArgs}`);
    s += new Float64Array(r.msg.values)[0]!;
  }
  return s;
}
/** The pool's split at pool size 1 of a whole n × n density slice (`planFieldSlice` with REQUEST_BUDGET): its ranges. */
function poolOfOne(params: Params, spec: FieldSliceSpec): readonly (readonly [number, number])[] {
  const plan = planFieldSlice(spec.n, sliceCostOf(params, spec.field, spec.path, spec.plane, spec.n), 1, REQUEST_BUDGET);
  if (plan.refused) throw new Error(`the ${spec.plane} ${spec.n}² slice is refused (limit ${plan.limit})`);
  return plan.ranges;
}

/** A voxel's value (`state << 8 | fluid`) and a one-voxel `set` edit, as the sim takes them (SP5a §2.1). */
const val = (state: number, fluid = NO_FLUID): number => (state << 8) | fluid;
const valueAt = (s: VoxelStore, x: number, y: number, z: number): number => val(s.blockAt(x, y, z), s.fluidAt(x, y, z));
const setEdit = (x: number, y: number, z: number, value: number, expectV: number): Edit => ({ x, y, z, op: 'set', value, expect: expectV });
/** Opaque (opacity 15) and dry. */
const solidAt = (s: VoxelStore, x: number, y: number, z: number): boolean => OPACITY[s.blockAt(x, y, z)]! === 15 && s.fluidAt(x, y, z) === NO_FLUID;

test('SP1, SP2a, SP2b, SP3a, SP3b, SP3c, SP3d, SP3e, SP4a and SP5a kernels', async ({ bench }) => {
  // SP3c §7: BENCH_EXEMPT names rows whose ratio gate is skipped (an unknown name fails here, before measuring);
  // bench:record never reads it.
  const exempt = process.env.BENCH_RECORD === '1' ? [] : parseBenchExempt(process.env.BENCH_EXEMPT);
  const ns: Record<string, number> = {};
  /**
   * SP5a Task 43b: each row's divisor, the calibration kernel's p50 per evaluation measured immediately before the row
   * (`CALIBRATION_BESIDE_RUN`, through tinybench as vitest's bench provider runs it, so it is not a reported row), in the
   * same clock state: the CPU leaves its turbo window part-way through the run (Task 40c). `calibration.fmix32` is its own.
   */
  const beside: Record<string, number> = {};
  const calibrateBeside = async (name: string): Promise<void> => {
    const b = new Bench({ ...CALIBRATION_BESIDE_RUN, now: performance.now.bind(performance) });
    b.add(`calibration beside ${name}`, calibrate);
    await b.run();
    const r = b.tasks[0]!.result;
    if (r.state !== 'completed') throw new Error(`the calibration beside ${name} did not complete: ${r.state}`);
    beside[name] = (r.latency.p50 * 1e6) / N;
  };
  /**
   * A row's p50 per evaluation, after its calibration beside it; `run`: a fixed iteration count (`time: 0`, one warm-up
   * iteration) or explicit options.
   */
  const measure = async (name: string, evals: number, fn: () => unknown, run?: number | typeof ISLANDS_RUN | typeof LIGHT_RUN | typeof MESH_RUN) => {
    await calibrateBeside(name);
    const r = await bench(name, fn).run(run === undefined ? undefined : typeof run === 'number' ? { iterations: run, time: 0, warmupIterations: 1 } : { ...run });
    ns[name] = (r.latency.p50 * 1e6) / evals;
    return r;
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

  // The calibration kernel, one function for its own row and every calibration beside a later row.
  const calibrate = (): void => { let s = 0; for (let i = 0; i < N; i++) s ^= FMIX(ints[i]!); sink ^= s; };
  const calibRun = await bench('calibration.fmix32', calibrate).run();
  ns['calibration.fmix32'] = (calibRun.latency.p50 * 1e6) / N;
  beside['calibration.fmix32'] = ns['calibration.fmix32'];
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
  await calibrateBeside('column.sample');
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
  await measure('worker.configure', 1, () => { sink += handler.handle({ type: 'configure', epoch: epoch++, seedText: '42', params: posted, epochs: null }).msg.type === 'ready' ? 1 : 0; });
  const preview = [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const;
  let pt = 0;
  await measure('map.tile.b256.biome', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'biome', 256, tx, tz, tile); sink += tile[0]!; }, 8);
  await measure('map.tile.b256.relief', 1, () => { const [tx, tz] = preview[pt++ % 4]!; paintTile(gen, 'relief', 256, tx, tz, tile); sink += tile[0]!; }, 8);
  // SP3a §7, on one shared store (the backend the 4-thread harness and SP4's streaming use): one alloc and free on
  // the byte pool (the lock, a stack pop and push, the refcount), and (SP3b §10) one column's real T stage including
  // its ColumnSample, through fillColumnT (claim, density phase, water, 24 sections, aux A and B, commit) and the
  // freeColumn that recycles its slots.
  const store = createStore({ shared: true, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
  const bytePool = store.bytePool;
  await measure('store.alloc', N, () => { for (let i = 0; i < N; i++) { const id = bytePool.alloc(); bytePool.free(id); sink += id; } });
  // SP3b §10: one corner of the default density expression (cornerFn: every interpolated slot at one corner, no
  // early-outs), measured as the 5 × 49 × 5 corners of column (0, 0) with the column's corner cache cleared first.
  const dc = createDensityContext(gen);
  dc.column(0, 0);
  const compiled = dc.compiled;
  await measure('density.corner', 1225, () => {
    compiled.cornerReady.fill(0);
    for (let k = 0; k < 49; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) compiled.cornerFn(i, k, j);
    sink += compiled.cornerValues[612]!;
  });
  const never = (): boolean => false;
  let tc = 0;
  const terrainRun = await measure('terrain.real', 1, () => {
    tc++;
    const tcx = (tc * 7919) % 60000 - 30000;
    const tcz = (tc * 104729) % 60000 - 30000;
    sink += fillColumnT(store, gen, tcx, tcz, never) ? 1 : 0;
    store.freeColumn(tcx, tcz);
  });
  // SP3c §7: the surface pass alone (`surfacePass`, the function the T stage calls) over one column whose density,
  // water v0 and surface biome buffer are built once beforehand, as the stage builds them (`surfaceProbeColumn` on
  // the stage's own SurfaceContext): column (0, 0), the density.corner column.
  const sc = surfaceContextOf(gen);
  const sCol = surfaceProbeColumn(sc, 0, 0);
  const sSample = sc.density.columns.get(0, 0);
  const states = new Uint16Array(98304);
  let evaluated = 0;
  const surfaceRun = await measure('surface.column', 1, () => {
    evaluated = surfacePass(sc, sSample, sCol.solid, sCol.water, sCol.biomes, states);
    sink += states[98303]!;
  });
  // SP3d §9: the slice rows, one thread, in-process, 9 timed runs after one warm-up each, a fresh GenContext per slice.
  // slice.vertical128: field density at n = 128 on uiSmoke's mountain line A (−1664, 8) → B (−640, 8), split as the
  // pool of one worker splits it (k = 79 sample columns per part: 2 parts).
  const vSpec: FieldSliceSpec = { plane: 'vertical', ax: -1664, az: 8, bx: -640, bz: 8, y: 63, n: 128, field: 'density', path: '' };
  const vRanges = poolOfOne(DEFAULTS, vSpec);
  const vRun = await measure('slice.vertical128', 1, () => { sink += slice(DEFAULTS, vSpec, vRanges); }, 9);
  // slice.horizontal128: the XZ plane at y 63 centred on (0, 0), extent 8192, from corner samples (k = 25: 6 parts).
  const hSpec: FieldSliceSpec = { plane: 'horizontal', cx: 0, cz: 0, extent: 8192, y: 63, n: 128, field: 'density', path: '' };
  const hRanges = poolOfOne(DEFAULTS, hSpec);
  const hRun = await measure('slice.horizontal128', 1, () => { sink += slice(DEFAULTS, hSpec, hRanges); }, 9);
  // slice.partWorst: one part at PART_BUDGET — one 32-sample vertical column of the interpolated add of
  // PART_WORST_LEAVES 16-octave double `noise detail` leaves (Task 19's calibration tree) — below the request check
  // (planFieldSlice refuses the whole slice; the handler's part bound accepts this part).
  const worst = partWorstParams();
  const wSpec: FieldSliceSpec = { ...vSpec, n: 32 };
  const wCost = sliceCostOf(worst, 'density', '', 'vertical', 32);
  expect(wCost, 'slice.partWorst: one sample column within PART_BUDGET').toBeLessThanOrEqual(PART_BUDGET);
  expect(planFieldSlice(32, wCost, 1, REQUEST_BUDGET).refused, 'slice.partWorst: the whole slice is refused').toBe(true);
  const wRun = await measure('slice.partWorst', 1, () => { sink += slice(worst, wSpec, [[0, 1]]); }, 9);
  // session.commitMaxTree (SP3d §1.12): one slider commit (`set`, outside a gesture) of the page's session
  // (`openMapSession`: tier 2 as its validator) holding both trees at the 128 KiB cap.
  const capped = { ...DEFAULT_MAP_STATE, patch: { density: { defs: capDensityTree() }, surface: { rules: capSurfaceRules() } } as MapState['patch'] };
  const session = openMapSession(capped, () => [3, 9]);
  const cappedDefs = session.state.params.density.defs;
  expect(canonicalJSON(cappedDefs).length, 'session.commitMaxTree: the session holds the capped density tree').toBeGreaterThan(131_000);
  expect(canonicalJSON(session.state.params.surface.rules).length, 'session.commitMaxTree: and the capped rules').toBeGreaterThan(131_000);
  let commits = 0;
  const commitRun = await measure('session.commitMaxTree', 1, () => {
    const r = session.set('climate.scaleMul', 1 + (++commits & 1));
    if (!r.ok) throw new Error('session.commitMaxTree: the commit was refused');
    sink += r.state.epoch;
  });
  expect(session.state.params.density.defs, 'session.commitMaxTree: the commits keep the tree by identity').toBe(cappedDefs);
  // SP3e §7 (D17): terrain.islands — fillColumnT on the floating_islands params at cluster columns: the terrain.real
  // candidate sequence kept where columnPoint (on a separate GenContext, so the timed context's column cache stays cold)
  // gives islandMask ≥ 0.5 at the column's centre block, until 512 are accepted; 256 timed iterations after one
  // warm-up (ISLANDS_RUN: warmupTime 0, so the warm-up is one call), each on the next precomputed column, freed after
  // (no column twice, so the column cache never hits).
  const islandsParams = resolveProfile('floating_islands');
  const islandsGen = createGenContext(seedFromInput('42'), islandsParams);
  const islandsProbe = createGenContext(seedFromInput('42'), islandsParams);
  const islandsStore = createStore({ shared: true, maxBlockBytes: 32 << 20, maxByteBytes: 16 << 20 });
  const islandCols: (readonly [number, number])[] = [];
  let islandTried = 0;
  for (let t = 1; islandCols.length < ISLANDS_COLUMNS; t++) {
    islandTried++;
    const icx = (t * 7919) % 60000 - 30000;
    const icz = (t * 104729) % 60000 - 30000;
    if (columnPoint(islandsProbe, 16 * icx + 8, 16 * icz + 8).islandMask >= 0.5) islandCols.push([icx, icz]);
  }
  let ic = 0;
  const islandsRun = await measure('terrain.islands', 1, () => {
    const [icx, icz] = islandCols[ic++]!;
    sink += fillColumnT(islandsStore, islandsGen, icx, icz, never) ? 1 : 0;
    islandsStore.freeColumn(icx, icz);
  }, ISLANDS_RUN);
  // tinybench calls the function once when it is added (to see whether it returns a promise), then the one warm-up
  // call and the 256 timed ones: 258 of the 512 columns.
  expect(ic, 'terrain.islands: one probe, one warm-up and 256 timed calls, each on its own precomputed column').toBe(1 + ISLANDS_RUN.warmupIterations + ISLANDS_RUN.iterations);

  // SP4a §9.3: the region R of the light and mesh rows, 18 × 18 columns with its corner at terrain.real's first
  // candidate (tc = 1), generated outside the timing on one shared store: T on R grown by one ring, D on R. Its 16 × 16
  // interior has its 3 × 3 at Decorated, so each of those 256 columns can run the light job.
  const worldGen = createGenContext(seedFromInput('42'), DEFAULTS);
  const worldStore = createStore({ shared: true });
  const rx0 = 7919 % 60000 - 30000;
  const rz0 = 104729 % 60000 - 30000;
  for (let z = rz0 - 1; z < rz0 + 19; z++) for (let x = rx0 - 1; x < rx0 + 19; x++) fillColumnT(worldStore, worldGen, x, z, never);
  for (let z = rz0; z < rz0 + 18; z++) {
    for (let x = rx0; x < rx0 + 18; x++) if (!fillColumnD(worldStore, worldGen, x, z, never)) throw new Error(`D of (${x}, ${z}) stopped`);
  }
  const litCols: (readonly [number, number])[] = [];
  for (let z = rz0 + 1; z < rz0 + 17; z++) for (let x = rx0 + 1; x < rx0 + 17; x++) litCols.push([x, z]);
  // light.column: spec §4.2's job without the store's commit — the neighbourhood, the region copy (`copyLightRegion`),
  // the sky fall, seeds and BFS (`lightRegion`) and the 24 centre sections written to the output arrays — on the next of
  // the 256 interior columns (LIGHT_RUN: cyclic, each column timed once). It writes nothing to the store, so the probe
  // and warm-up columns can run again. SP5a §6.2 (D23's scan gate): `mayEmit` false, as `fillColumnL` passes it when no
  // column of the 3 × 3 has the diff flag, so the row measures the gate's closed side, the job of every column no edit
  // touched (the block-light scan runs only when the region holds lava; generated terrain holds no emitter).
  const lightScratch = createLightScratch();
  const lightOut = new Uint8Array(24 * 4096);
  let lc = 0;
  const lightRun = await measure('light.column', 1, () => {
    const [lx, lz] = litCols[lc++ % litCols.length]!;
    copyLightRegion(worldStore.neighborhood(lx, lz), lightScratch.region);
    lightRegion(lightScratch, DEFAULT_LIGHT_TABLES, false);
    for (let sy = 0; sy < 24; sy++) lightOut.set(centreSection(lightScratch, sy), sy * 4096);
    sink += lightOut[24 * 4096 - 1]!;
  }, LIGHT_RUN);
  expect(lc, 'light.column: one probe, one warm-up and 256 timed calls, each column timed once').toBe(1 + LIGHT_RUN.warmupIterations + LIGHT_RUN.iterations);
  // The 256 columns lit to L for real (fillColumnL commits them Published), then the non-trivial sections (`isTrivial`)
  // of the 14 × 14 columns whose 3 × 3 is Published, in (cz, cx, sy) order; 1024 of them evenly spread over the list.
  for (const [x, z] of litCols) if (fillColumnL(worldStore, x, z, lightScratch, never) === null) throw new Error(`L of (${x}, ${z}) stopped`);
  const nonTrivial: { readonly nb: NeighborhoodReader; readonly sy: number }[] = [];
  for (let z = rz0 + 2; z < rz0 + 16; z++) {
    for (let x = rx0 + 2; x < rx0 + 16; x++) {
      const nb = worldStore.neighborhood(x, z);
      for (let sy = 0; sy < 24; sy++) if (isTrivial(nb, sy) === 0) nonTrivial.push({ nb, sy });
    }
  }
  expect(nonTrivial.length, 'mesh.section: the region has at least 1024 non-trivial sections').toBeGreaterThanOrEqual(MESH_RUN.iterations);
  const meshSections = Array.from({ length: MESH_RUN.iterations }, (_, i) => nonTrivial[Math.floor((i * nonTrivial.length) / MESH_RUN.iterations)]!);
  // mesh.section: one non-trivial section as the mesh job runs it (`meshColumnPayload`'s per-section work, without the
  // column buffers' append): the padded copy, the solid passes, the water depths and still water, and the
  // connectivity, with the Medium preset's AO and smooth light (the page's jobs); cyclic, each section timed once.
  const meshScratch = createMeshScratch();
  const meshOptions: MeshOptions = { ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight };
  let mc = 0;
  let quads = 0;
  const meshRun = await measure('mesh.section', 1, () => {
    const { nb, sy } = meshSections[mc++ % meshSections.length]!;
    copyPaddedSection(nb, sy, meshScratch.padded);
    meshScratch.builder.reset();
    meshSolid(meshScratch.padded, meshOptions, meshScratch.builder);
    fluidDepths(nb, sy, meshScratch.depth);
    meshFluid(meshScratch.padded, meshScratch.depth, meshScratch.builder);
    sink += connectivity15(meshScratch.padded);
    for (let pass = 0 as 0 | 1 | 2; pass <= 2; pass++) quads += meshScratch.builder.view(pass).indices / 6;
  }, MESH_RUN);
  expect(mc, 'mesh.section: one probe, one warm-up and 1024 timed calls, each section timed once').toBe(1 + MESH_RUN.warmupIterations + MESH_RUN.iterations);
  expect(quads, 'mesh.section meshes quads').toBeGreaterThan(0);

  // SP5a §6.2: relight.edit — one edit's relight on the lit region, each call a one-edit `applyEdits` (the sim's own
  // pipeline, on a DiffStore of its own) on the next of a 6-edit cycle: a torch placed on the surface and broken, a
  // stone placed on the surface and broken, a shaft opened and closed. The shaft: a closed 5 × 4 × 5 air room carved
  // before the run (one untimed batch) with a 1 × 1 shaft up from it to just under the surface voxel, so breaking that
  // cap opens a shaft 12 blocks deep (the room's sky light 0 → 15) and placing it back closes it. Each place is the first
  // one found in the inner 14 × 14 columns (their 3 × 3 is Published), scanned in (cz, cx) order. Only the relight is
  // timed (`overriddenDuration`: the call's `relightMs`); the write, the heightmap patch and the section copies are not.
  // Each break writes the generated value back, so 6 calls leave the region as they found it and every `expect` of
  // the cycle stays current: the 258 calls (RELIGHT_RUN) are 43 whole turns.
  const relightDiffs = createDiffStore();
  const editScratch = createEditScratch();
  const perfNow = (): number => performance.now();
  const innerCols: (readonly [number, number])[] = [];
  for (let z = rz0 + 2; z < rz0 + 16; z++) for (let x = rx0 + 2; x < rx0 + 16; x++) innerCols.push([x, z]);
  const surfaceY = (x: number, z: number): number => worldStore.heightAt('worldSurface', x, z)!;
  /** Dry air on opaque ground at the surface of block column (x, z), below y 319, else null. */
  const onGround = (x: number, z: number): number | null => {
    const y = surfaceY(x, z);
    return y <= 318 && valueAt(worldStore, x, y, z) === val(AIR) && solidAt(worldStore, x, y - 1, z) ? y : null;
  };
  /** The first column (from `from`) whose centre block column has dry ground: [x, y, z] of the air voxel on it. */
  const groundFrom = (from: number): readonly [number, number, number, number] => {
    for (let i = from; i < innerCols.length; i++) {
      const x = 16 * innerCols[i]![0] + 8;
      const z = 16 * innerCols[i]![1] + 8;
      const y = onGround(x, z);
      if (y !== null) return [x, y, z, i];
    }
    throw new Error('relight.edit: no dry ground in the inner columns');
  };
  const [tx, ty, tz, ti] = groundFrom(0);
  const [sx, sy, sz] = groundFrom(ti + 1);
  /** The shaft: the cap at the surface, the room's top 12 below it, the room grown by one and the shaft opaque and dry. */
  let shaftAt: readonly [number, number, number, number] | null = null;
  for (let i = 0; i < innerCols.length && shaftAt === null; i++) {
    for (let oz = 2; oz < 14 && shaftAt === null; oz++) {
      for (let ox = 2; ox < 14 && shaftAt === null; ox++) {
        const x = 16 * innerCols[i]![0] + ox;
        const z = 16 * innerCols[i]![1] + oz;
        const cap = surfaceY(x, z) - 1;
        const roomTop = cap - 12;
        if (roomTop - 4 < -63) continue;
        let ok = solidAt(worldStore, x, cap, z);
        for (let y = roomTop + 1; ok && y < cap; y++) ok = solidAt(worldStore, x, y, z);
        for (let dz = -3; ok && dz <= 3; dz++) for (let dx = -3; ok && dx <= 3; dx++) for (let y = roomTop - 4; ok && y <= roomTop + 1; y++) ok = solidAt(worldStore, x + dx, y, z + dz);
        if (ok) shaftAt = [x, cap, z, roomTop];
      }
    }
  }
  if (shaftAt === null) throw new Error('relight.edit: no enclosed place for the shaft in the inner columns');
  const [hx, hy, hz, roomTop] = shaftAt;
  const carve: Edit[] = [];
  for (let y = roomTop - 3; y <= roomTop; y++) {
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) carve.push(setEdit(hx + dx, y, hz + dz, val(AIR), valueAt(worldStore, hx + dx, y, hz + dz)));
  }
  for (let y = roomTop + 1; y < hy; y++) carve.push(setEdit(hx, y, hz, val(AIR), valueAt(worldStore, hx, y, hz)));
  const edit = (edits: readonly Edit[]): number => {
    const r = applyEdits(worldStore, relightDiffs, editScratch, edits, perfNow);
    if (r.refused !== null) throw new Error(`relight.edit: an edit at (${edits[0]!.x}, ${edits[0]!.y}, ${edits[0]!.z}) was refused '${r.refused}'`);
    return r.relightMs;
  };
  edit(carve);
  const tv = valueAt(worldStore, tx, ty, tz);
  const sv = valueAt(worldStore, sx, sy, sz);
  const hv = valueAt(worldStore, hx, hy, hz);
  const cycle: readonly (readonly Edit[])[] = [
    [setEdit(tx, ty, tz, val(TORCH), tv)], [setEdit(tx, ty, tz, tv, val(TORCH))],
    [setEdit(sx, sy, sz, val(STONE), sv)], [setEdit(sx, sy, sz, sv, val(STONE))],
    [setEdit(hx, hy, hz, val(AIR), hv)], [setEdit(hx, hy, hz, hv, val(AIR))],
  ];
  // The one known case: the closed room is dark, the open shaft lights its floor at sky 15 (an untimed check, undone).
  const floorSky = (): number => worldStore.lightAt(hx, roomTop - 3, hz) >> 4;
  expect(floorSky(), 'relight.edit: the closed room is dark').toBe(0);
  edit(cycle[4]!);
  expect(floorSky(), 'relight.edit: the open shaft lights the room\'s floor').toBe(15);
  edit(cycle[5]!);
  expect(floorSky(), 'relight.edit: closed again').toBe(0);
  let rc = 0;
  const relightRun = await measure('relight.edit', 1, () => ({ overriddenDuration: edit(cycle[rc++ % cycle.length]!) }), RELIGHT_RUN);
  expect(rc, 'relight.edit: one probe, one warm-up and 256 timed calls, 43 turns of the cycle').toBe(1 + RELIGHT_RUN.warmupIterations + RELIGHT_RUN.iterations);
  expect([valueAt(worldStore, tx, ty, tz), valueAt(worldStore, sx, sy, sz), valueAt(worldStore, hx, hy, hz), floorSky()], 'relight.edit: the cycle ends as it began').toEqual([tv, sv, hv, 0]);

  let solidVoxels = 0;
  for (let i = 256; i < 98304; i++) solidVoxels += sCol.solid[i]!;
  expect(evaluated, 'surface.column evaluates part of the column (the fast path takes the rest)').toBeGreaterThan(0);
  expect(evaluated).toBeLessThan(solidVoxels);
  expect(bytePool.slotCount() - bytePool.freeCount(), 'store rows leak no slot').toBe(0);
  expect(islandsStore.blockPool.slotCount() - islandsStore.blockPool.freeCount(), 'terrain.islands leaks no slot').toBe(0);
  expect(store.blockPool.slotCount() - store.blockPool.freeCount(), 'store rows leak no slot').toBe(0);

  expect(Object.keys(ns), 'the measured rows are BENCH_ROWS').toEqual([...BENCH_ROWS]);
  // Each row's ratio against the calibration beside it (SP5a Task 43b); the table also prints that calibration.
  const kernels = benchKernels(ns, beside);
  const killRatio = Math.round(Math.max(ns['lattice3.slice']! / ns['perm512.slice']!, ns['lattice3.random']! / ns['perm512.random']!) * 1000) / 1000;
  console.table(Object.fromEntries(Object.entries(kernels).map(([name, k]) => [name, { ...k, calibrationBeside: Math.round(beside[name]! * 1000) / 1000 }])));
  console.log(`killRatio ${killRatio}`);
  console.log(`column.sample p50 ${columnRun.latency.p50.toFixed(3)} ms, p99 (≥ p95) ${columnP95.toFixed(3)} ms`);
  console.log(`terrain.real p50 ${terrainRun.latency.p50.toFixed(3)} ms, p99 ${terrainRun.latency.p99.toFixed(3)} ms`);
  console.log(`surface.column p50 ${surfaceRun.latency.p50.toFixed(3)} ms, p99 ${surfaceRun.latency.p99.toFixed(3)} ms (column (0, 0): ${evaluated} of ${solidVoxels} solid voxels evaluated)`);
  const ms = (r: { latency: { p50: number; p99: number } }): string => `p50 ${r.latency.p50.toFixed(3)} ms, p99 ${r.latency.p99.toFixed(3)} ms`;
  console.log(`slice.vertical128 ${ms(vRun)} (${vRanges.length} parts at pool size 1: ${JSON.stringify(vRanges)})`);
  console.log(`slice.horizontal128 ${ms(hRun)} (${hRanges.length} parts at pool size 1: ${JSON.stringify(hRanges)})`);
  console.log(`slice.partWorst ${ms(wRun)} (${PART_WORST_LEAVES} leaves, one 32-sample column of ${wCost} work units)`);
  console.log(`terrain.islands ${ms(islandsRun)} (${islandCols.length} cluster columns accepted of ${islandTried} candidates: ${((100 * islandCols.length) / islandTried).toFixed(1)} %; ${ic} columns used)`);
  console.log(`session.commitMaxTree ${ms(commitRun)} (${commits} commits; trees of ${canonicalJSON(cappedDefs).length} and ${canonicalJSON(session.state.params.surface.rules).length} characters)`);
  console.log(`light.column ${ms(lightRun)} (${litCols.length} interior columns of the 18 × 18 region at (${rx0}, ${rz0}); ${lc} calls)`);
  console.log(`mesh.section ${ms(meshRun)} (${meshSections.length} of the ${nonTrivial.length} non-trivial sections of its 14 × 14 inner columns; ${mc} calls, ${quads} quads)`);
  console.log(`relight.edit ${ms(relightRun)} (torch at (${tx}, ${ty}, ${tz}), stone at (${sx}, ${sy}, ${sz}), shaft cap at (${hx}, ${hy}, ${hz}) over a room topped at y ${roomTop}; ${rc} calls)`);
  // Before the record: bench:record refuses to write when an absolute gate fails.
  expect(absoluteGateFailures({
    columnP50: columnRun.latency.p50, columnP95, terrainP50: terrainRun.latency.p50,
    sliceV128P50: vRun.latency.p50, slicePartP50: wRun.latency.p50, sessionCommitP50: commitRun.latency.p50,
    islandsP50: islandsRun.latency.p50,
    lightP50: lightRun.latency.p50, lightP99: lightRun.latency.p99, meshP50: meshRun.latency.p50, meshP99: meshRun.latency.p99,
    relightP95: relightRun.latency.p99,
  }), 'absolute gates').toEqual([]);
  expect(Number.isFinite(sink)).toBe(true);
  if (process.env.BENCH_RECORD === '1') {
    const next: Baselines = { machine: cpus()[0]?.model ?? 'unknown', node: process.version, date: new Date().toISOString().slice(0, 10), kernels, killRatio };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const baseline = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baselines) : null;
  if (baseline === null) console.log('no test/baselines.json yet: P1 not gated (run npm run bench:record on the reference machine)');
  expect(gateFailures(baseline, kernels, killRatio, exempt)).toEqual([]);
}, 600_000);

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { metricTest } from '../harness/metric';

/**
 * G1's static cells (SP4a spec §9.1, §9.5, D24), every tier, milliseconds: read from the Chrome flight on the Iris Xe
 * re-measured on SP4b's code, `docs/superpowers/specs/assets/sp4b/flight-iris-chrome.json` (`npm run measure:chrome --
 * --route flight`, the `?flight=sp4a` route; SP4b spec §8.4). Its shape is checked first: the route's JSON with the
 * renderer naming the Iris Xe (as reported), the section renderer RegionBatch ('batch'), RD 12, the default profile and
 * a cold driver shader cache (`shaderCache`, rulings R11). The three gated parts:
 * - `mediumStaticP95`: the snapped frame times' p95 (`frames.p95`), max 16.7;
 * - `mediumStaticDrawCalls`: the draw calls' max (`drawCalls.max`), max 100;
 * - `mediumStaticMainP95`: the main-thread ms' p95 (`main.p95`), max 6.
 * SP4a's other flights (the 4-worker Iris run, the RTX, and the user's Firefox cells) stay in `assets/sp4a/` and are
 * recorded, when present, in `.out/G1.others.json`, never gated (§9.5: the Firefox cells are checked at the exit).
 *
 * G1's streaming cells (SP4b spec §8.2, §8.4, D23), every tier, a second call (`G1.streaming`): read from the committed
 * Iris Xe Chrome bench files `assets/sp4b/bench-iris-chrome.json` (the default pool) and `bench-iris-chrome-w4.json`
 * (4 workers), `npm run measure:chrome -- --route bench`. Each file's shape is checked first: route `bench=medium`,
 * the renderer naming the Iris Xe, RegionBatch, RD 12, the default profile, a cold driver shader cache (rulings R11),
 * 4 workers in the w4 file, the `gpuMB` breakdown fields, `structuralFrames` present with every entry's `stutterMs`
 * ≤ 33 ms (the larger of its own snapped frame and the next one's, §8.4; rulings R10), `partialColumnFrames` and
 * `mixedColumnFrames` 0. The six gated parts:
 * - `mediumStreamP95`: the default run's `stream.frames.p95`, max 16.7;
 * - `mediumStreamOver33`: its `stream.frames.over33`, max 0;
 * - `mediumStreamDrawCalls`: its `stream.drawCalls.max`, max 100;
 * - `mediumStreamMainP95`: its `stream.main.p95`, max 6;
 * - `mediumFill4wMs`: the w4 run's `load.revealMs` (the first entry's reveal), max 6000;
 * - `mediumGpuMB`: the default run's `stream.gpuMB`, max 150.
 * The RTX and Firefox bench files are recorded, when present, in `.out/G1.streaming.others.json` (p95, over33, draw
 * calls, JS heap + SAB: the RTX's High-preset parts recorded at Medium for SP11), each checked for
 * `partialColumnFrames` and `mixedColumnFrames` 0; the RTX cell is checked at SP4b's exit (§8.4).
 */
const ASSETS = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp4a/', import.meta.url));
const ASSETS_SP4B = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp4b/', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));
const GATED = 'flight-iris-chrome.json';
const OTHERS = ['flight-iris-chrome-w4.json', 'flight-rtx-chrome.json', 'flight-iris-firefox.json', 'flight-rtx-firefox.json'] as const;

/** The parts of a flight JSON G1 reads (`src/ui/world/flight.ts`' FlightResult, plus measureChrome's additions). */
interface Flight {
  readonly route: string;
  readonly profile: string;
  readonly rd: number;
  readonly workers: number;
  readonly sectionRenderer: string;
  readonly renderer: string | null;
  readonly displayIntervalMs: number;
  readonly frames: { readonly count: number; readonly p95: number; readonly over33: number };
  readonly main: { readonly p95: number };
  readonly gpuMs: { readonly p95: number } | null;
  readonly drawCalls: { readonly max: number };
  readonly load: { readonly revealMs: number | null };
  /** measureChrome's: whether the driver started with an empty shader cache (rulings R11). */
  readonly shaderCache?: string;
}

const read = <T = Flight>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;

metricTest('G1', ['mediumStaticP95', 'mediumStaticDrawCalls', 'mediumStaticMainP95'], () => {
  expect(existsSync(join(ASSETS_SP4B, GATED)), `${GATED} missing: run npm run measure:chrome -- --route flight --gpu iris`).toBe(true);
  const f = read(ASSETS_SP4B, GATED);
  expect(f.route, 'the ?flight=sp4a JSON').toBe('flight=sp4a');
  expect(f.renderer ?? '', 'the renderer names the Iris Xe').toMatch(/Iris/i);
  expect(f.sectionRenderer, 'measured on RegionBatch').toBe('batch');
  expect(f.rd, 'at RD 12').toBe(12);
  expect(f.profile, 'on the default profile').toBe('default');
  expect(f.frames.count, 'a flight was measured').toBeGreaterThan(0);
  expect(f.shaderCache, 'measured on a cold driver shader cache (rulings R11)').toBe('cold');

  const others: Record<string, unknown> = {};
  for (const file of OTHERS) {
    if (!existsSync(join(ASSETS, file))) continue;
    const o = read(ASSETS, file);
    others[file] = {
      renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs,
      p95: o.frames.p95, over33: o.frames.over33, drawCallsMax: o.drawCalls.max, mainP95: o.main.p95, gpuP95: o.gpuMs?.p95 ?? null,
      revealMs: o.load.revealMs,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  return {
    mediumStaticP95: f.frames.p95,
    mediumStaticDrawCalls: f.drawCalls.max,
    mediumStaticMainP95: f.main.p95,
    displayIntervalMs: f.displayIntervalMs,
    over33: f.frames.over33,
    workers: f.workers,
  };
});

const BENCH = 'bench-iris-chrome.json';
const BENCH_W4 = 'bench-iris-chrome-w4.json';
const BENCH_OTHERS = ['bench-rtx-chrome.json', 'bench-iris-firefox.json', 'bench-rtx-firefox.json'] as const;
/** SP4a's rule (spec §8.4): a snapped frame time above 33 ms counts; here, a structural frame's `stutterMs`. */
const OVER_MS = 33;

/** The parts of a bench JSON G1 reads (`src/ui/world/bench.ts`' BenchResult, plus measureChrome's additions). */
interface Bench {
  readonly route: string;
  readonly profile: string;
  readonly rd: number;
  readonly workers: number;
  readonly sectionRenderer: string;
  readonly renderer: string | null;
  readonly displayIntervalMs: number;
  readonly load: { readonly revealMs: number | null };
  readonly stream: {
    readonly frames: { readonly count: number; readonly p95: number; readonly over33: number };
    readonly main: { readonly p95: number };
    readonly drawCalls: { readonly max: number };
    readonly gpuMB: number;
    readonly geometryMB: number;
    readonly texturesMB: number;
    readonly drawingBufferMB: number;
    readonly heapMB: number | null;
    readonly sabMB: number | null;
    readonly partialColumnFrames: number;
    readonly mixedColumnFrames: number;
  };
  readonly structuralFrames?: ReadonlyArray<{ readonly frame: number; readonly kind: string; readonly stutterMs: number }>;
  readonly shaderCache?: string;
}

/** The R7 probe's two counts on a bench file: no column shown half-built or mixing two meshes (spec §8.4). */
function checkReveal(file: string, b: Bench): void {
  expect(b.stream.partialColumnFrames, `${file}: partialColumnFrames`).toBe(0);
  expect(b.stream.mixedColumnFrames, `${file}: mixedColumnFrames`).toBe(0);
}

/** The shape of a gated Iris Xe Chrome bench file (spec §8.4). */
function checkBench(file: string, workers: number | null): Bench {
  expect(existsSync(join(ASSETS_SP4B, file)), `${file} missing: run npm run measure:chrome -- --route bench --gpu iris${workers === 4 ? ' --workers 4' : ''}`).toBe(true);
  const b = read<Bench>(ASSETS_SP4B, file);
  expect(b.route, `${file}: the ?bench=medium JSON`).toBe('bench=medium');
  expect(b.renderer ?? '', `${file}: the renderer names the Iris Xe`).toMatch(/Iris/i);
  expect(b.sectionRenderer, `${file}: measured on RegionBatch`).toBe('batch');
  expect(b.rd, `${file}: at RD 12`).toBe(12);
  expect(b.profile, `${file}: on the default profile`).toBe('default');
  if (workers !== null) expect(b.workers, `${file}: ${workers} workers`).toBe(workers);
  expect(b.stream.frames.count, `${file}: a bench was measured`).toBeGreaterThan(0);
  expect(b.shaderCache, `${file}: measured on a cold driver shader cache (rulings R11)`).toBe('cold');
  for (const k of ['gpuMB', 'geometryMB', 'texturesMB', 'drawingBufferMB'] as const) {
    expect(Number.isFinite(b.stream[k]), `${file}: stream.${k} is a number`).toBe(true);
  }
  expect(Array.isArray(b.structuralFrames), `${file}: structuralFrames present`).toBe(true);
  const over = b.structuralFrames!.filter((e) => !(e.stutterMs <= OVER_MS));
  expect(over, `${file}: structural frames whose stutterMs is over ${OVER_MS} ms`).toEqual([]);
  checkReveal(file, b);
  return b;
}

metricTest('G1', ['mediumStreamP95', 'mediumStreamOver33', 'mediumStreamDrawCalls', 'mediumStreamMainP95', 'mediumFill4wMs', 'mediumGpuMB'], () => {
  const b = checkBench(BENCH, null);
  const w4 = checkBench(BENCH_W4, 4);
  expect(w4.load.revealMs, `${BENCH_W4}: the first entry's reveal was timed`).not.toBeNull();

  const others: Record<string, unknown> = {};
  for (const file of BENCH_OTHERS) {
    if (!existsSync(join(ASSETS_SP4B, file))) continue;
    const o = read<Bench>(ASSETS_SP4B, file);
    checkReveal(file, o);
    others[file] = {
      renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs,
      p95: o.stream.frames.p95, over33: o.stream.frames.over33, drawCallsMax: o.stream.drawCalls.max,
      heapPlusSabMB: o.stream.heapMB === null || o.stream.sabMB === null ? null : o.stream.heapMB + o.stream.sabMB,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.streaming.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  return {
    mediumStreamP95: b.stream.frames.p95,
    mediumStreamOver33: b.stream.frames.over33,
    mediumStreamDrawCalls: b.stream.drawCalls.max,
    mediumStreamMainP95: b.stream.main.p95,
    mediumFill4wMs: w4.load.revealMs!,
    mediumGpuMB: b.stream.gpuMB,
    displayIntervalMs: b.displayIntervalMs,
    structuralFrames: b.structuralFrames!.length,
    workers: b.workers,
  };
}, 600_000, { outName: 'G1.streaming' });

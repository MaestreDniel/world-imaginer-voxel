import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { metricTest } from '../harness/metric';

/**
 * G1's static cells (SP4a spec §9.1, §9.5, D24), every tier, milliseconds: read from the Chrome flight on the Iris Xe
 * re-measured on SP5b's code, `docs/superpowers/specs/assets/sp5b/flight-iris-chrome.json` (`npm run measure:chrome
 * -- --route flight`, the `?flight=sp4a` route; SP4b spec §8.4; SP4c spec §8.4; SP5a spec §6.2; SP5b spec §6.2: every
 * G1 file re-measured into `assets/sp5b/`, the SP5a files staying in `assets/sp5a/`). Its shape is checked first: the
 * route's JSON with the renderer naming the Iris Xe (as reported), the section renderer RegionBatch ('batch'), RD 12,
 * the default profile and a cold driver shader cache (`shaderCache`, rulings R11). The three gated parts:
 * - `mediumStaticP95`: the snapped frame times' p95 (`frames.p95`), max 16.7;
 * - `mediumStaticDrawCalls`: the draw calls' max (`drawCalls.max`), max 100;
 * - `mediumStaticMainP95`: the main-thread ms' p95 (`main.p95`), max 6.
 * SP4a's other flights (the 4-worker Iris run, the RTX, and the user's Firefox cells) stay in `assets/sp4a/` and are
 * recorded, when present, in `.out/G1.others.json`, never gated (§9.5: the Firefox cells are checked at the exit).
 *
 * G1's streaming cells (SP4b spec §8.2, §8.4, D23), every tier, a second call (`G1.streaming`): read from the committed
 * Iris Xe Chrome bench files `assets/sp5b/bench-iris-chrome.json` (the default pool) and `bench-iris-chrome-w4.json`
 * (4 workers), `npm run measure:chrome -- --route bench`, re-measured on SP5b's code (SP5b spec §6.2). Each file's
 * shape is checked first: route `bench=medium`, the renderer naming the Iris Xe, RegionBatch, RD 12, the default
 * profile, a cold driver shader cache (rulings R11), 4 workers in the w4 file, the `gpuMB` breakdown fields,
 * `structuralFrames` present, every entry's `leg` one of L0-L11, with every SP4b-leg entry's
 * (`leg` L0-L6) `stutterMs` ≤ 33 ms (the larger of its own snapped frame and the next one's, §8.4; rulings R10; SP4c's
 * live legs L7-L9 are `G1.live`'s; SP5a's edit leg L10's long frames are its `over33`, an exit check, not a G1 part;
 * SP5b's save leg L11's are `G2.flush`'s parts),
 * `partialColumnFrames` and `mixedColumnFrames` 0. The six gated parts:
 * - `mediumStreamP95`: the default run's `stream.frames.p95`, max 16.7;
 * - `mediumStreamOver33`: its `stream.frames.over33`, max 0;
 * - `mediumStreamDrawCalls`: its `stream.drawCalls.max`, max 100;
 * - `mediumStreamMainP95`: its `stream.main.p95`, max 6;
 * - `mediumFill4wMs`: the w4 run's `load.revealMs` (the first entry's reveal), max 6000;
 * - `mediumGpuMB`: the default run's `stream.gpuMB`, max 150.
 * The RTX and Firefox bench files are recorded, when present, in `.out/G1.streaming.others.json` (p95, over33, draw
 * calls, JS heap + SAB: the RTX's High-preset parts recorded at Medium for SP11), each checked for
 * `partialColumnFrames` and `mixedColumnFrames` 0; the RTX cell is checked at SP4b's exit (§8.4).
 *
 * G1's live cells (SP4c spec §8.2, §8.4, D22), every tier, a third call (`G1.live`): read from the same
 * `assets/sp5b/bench-iris-chrome.json`'s `live` block (the bench's Apply, undo and teleport legs L7-L9). The file's
 * shape is checked as the streaming call's, plus the `live` block's: frames measured, the `gpuMB` breakdown, at least
 * one L7-L9 structural frame and every one's `stutterMs` ≤ 33 ms, `live.partialColumnFrames` and
 * `live.mixedColumnFrames` 0. The three
 * gated parts:
 * - `mediumLiveP95`: `live.frames.p95`, max 16.7;
 * - `mediumLiveOver33`: `live.frames.over33`, max 0;
 * - `mediumLiveGpuMB`: `live.gpuMB`, max 150 (old and new rows coexist during the swaps).
 * The w4 file's live legs are recorded, not gated (§8.4). The RTX and Firefox bench files' `live` blocks are recorded,
 * when present, in `.out/G1.live.others.json`, each checked for `partialColumnFrames` and `mixedColumnFrames` 0; their
 * p95 and over33 are exit checks (§8.4), not rows.
 *
 * G2's edit part (SP5a spec §6.2, D26), every tier, a fourth call (`G2.edit`): read from the same
 * `assets/sp5b/bench-iris-chrome.json`'s `edit` block (the bench's edit leg L10: 100 scripted edits through the page's
 * edit path). The file's shape is checked as the streaming call's, plus the `edit` block's: `timedOut` empty (the
 * hover's RD 12 disc filled) and `editVisibleP95` measured. The gated part:
 * - `editVisibleP95`: `edit.editVisibleP95`, the post → the frame the edited column's new mesh is shown, max 50.
 * The rest of the block is recorded: the other latencies, the step budget (§6.2), `editDropped`, `mainP95Ms` (master
 * §7's 0.3 ms), `editVisibleStreamingP95` and L10's `over33` (an exit check, not a part). The RTX, w4 and Firefox
 * bench files' `edit` blocks are recorded, when present, in `.out/G2.edit.others.json`, never gated.
 *
 * G2's flush parts (SP5b spec §6.2, D28), every tier, a fifth call (`G2.flush`): read from the same
 * `assets/sp5b/bench-iris-chrome.json`'s `persist` block (the bench's save leg L11: four 30 s parts at one place,
 * autosave off, on, off, on, L11a-L11d). The file's shape is checked as the streaming call's, plus the `persist`
 * block's: `timedOut` empty, at least 20 flushes in the "on" parts, every figure a gated part reads measured, and both
 * "on" parts' `editVisibleP95` measured (rulings P42). The gated parts:
 * - `over33Added`: the "on" parts' `over33` sum minus the "off" parts', max 1;
 * - `p95AddedMs`: the "on" parts' mean frame p95 minus the "off" parts', max 4.17 (one 240 Hz interval);
 * - `editVisibleAddedMs`: the same difference of `editVisibleP95`, max 8.33 (two intervals);
 * - `flushEditVisibleP95`: the larger of L11b's and L11d's `editVisibleP95`, max 50 (G2's edit target; the spec's
 *   "`editVisibleP95` (the 'on' parts)", named apart from `G2.edit`'s part);
 * - `replyDuringFlushP95Ms`: post → reply of the edits whose interval overlaps a flush, max 5.
 * The spec's sixth part, `flushMainP95Ms` max 0.3 (the tick's main-thread work), is recorded here, not gated: it is
 * held pending the user's check (SP5b spec §6.2, D28; the controller's rulings R10, R11). The rest of the block is
 * recorded (`flushSyncP95Ms`, `flushSyncMaxMs`, `flushCommitP95Ms`, `flushes`, each part's figures). The w4, RTX and
 * Firefox bench files' `persist` blocks are recorded, when present, in `.out/G2.flush.others.json`, never gated.
 *
 * G1's enter part (SP5b spec §6.2, D28), every tier, a sixth call (`G1.enter`): read from the committed Iris Xe Chrome
 * enter file `assets/sp5b/enter-iris-chrome.json` (`npm run measure:chrome -- --route enter --gpu iris`). Its shape is
 * checked first: route `bench=enter`, the renderer naming the Iris Xe (rulings P42), a cold driver shader cache, six
 * pairs with the first (the cold cache) discarded, five kept. The gated part:
 * - `enterRatio`: the median of the kept pairs' ratios (b) saved / (a) unsaved `revealMs`, max 1.10 (rulings R8).
 * Recorded beside it: both legs' medians, `idbOpenMs + loadMs`, `decodeMs` and `newWorldRevealMs` (null: -1). The RTX
 * and Firefox enter files are recorded, when present, in `.out/G1.enter.others.json`, never gated.
 */
const ASSETS = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp4a/', import.meta.url));
const ASSETS_SP5B = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp5b/', import.meta.url));
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
  expect(existsSync(join(ASSETS_SP5B, GATED)), `${GATED} missing: run npm run measure:chrome -- --route flight --gpu iris`).toBe(true);
  const f = read(ASSETS_SP5B, GATED);
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

/**
 * SP4b's legs (the 95 s script), whose structural frames the streaming call checks; L7-L9 are SP4c's live legs, L10
 * SP5a's edit leg and L11 SP5b's save leg (their structural frames are known, not stutter-checked: L10's `over33` is an
 * exit check, L11's long frames `G2.flush`'s parts).
 */
const SP4B_LEGS: ReadonlySet<string> = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
const LIVE_LEGS: ReadonlySet<string> = new Set(['L7', 'L8', 'L9']);
const EDIT_LEGS: ReadonlySet<string> = new Set(['L10', 'L11']);

/** A frame block of a bench JSON (`stream` over L1-L6, `live` over L7-L9, `edit.frames` over L10; `bench.ts`' StreamFigures). */
interface BenchFrames {
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
}

/** One L11 part's figures (`bench.ts`' SavePartFigures). */
interface SavePart {
  readonly p95: number;
  readonly p99: number;
  readonly over33: number;
  readonly editVisibleP95: number | null;
}

/** L11's block of a bench JSON (`bench.ts`' PersistFigures): the parts a-d, then the "on" parts' flushes. */
interface Persist {
  readonly L11a: SavePart;
  readonly L11b: SavePart;
  readonly L11c: SavePart;
  readonly L11d: SavePart;
  readonly flushSyncP95Ms: number | null;
  readonly flushSyncMaxMs: number | null;
  readonly flushCommitP95Ms: number | null;
  readonly replyDuringFlushP95Ms: number | null;
  readonly flushMainP95Ms: number | null;
  readonly flushes: number;
  readonly over33Added: number;
  readonly p95AddedMs: number;
  readonly editVisibleAddedMs: number | null;
  readonly timedOut: readonly string[];
}

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
  readonly stream: BenchFrames;
  /** SP4c's live legs (SP4c spec §8.4); absent from SP4b's files. */
  readonly live?: BenchFrames & {
    readonly applyFirstSwapMs: number | null;
    readonly applyNearMs: number | null;
    readonly applyFullMs: number | null;
    readonly undoFirstSwapMs: number | null;
    readonly undoNearMs: number | null;
    readonly undoFullMs: number | null;
    readonly teleportFirstRevealMs: number | null;
    readonly teleportRefillMs: number | null;
    readonly timedOut: readonly string[];
  };
  /** SP5a's edit leg L10 (SP5a spec §6.2; `bench.ts`' EditFigures); absent from SP4c's files. */
  readonly edit?: {
    readonly editVisibleP50: number | null;
    readonly editVisibleP95: number | null;
    readonly editVisibleMax: number | null;
    readonly editAllVisibleP95: number | null;
    readonly relightP95Ms: number | null;
    readonly editP95Ms: number | null;
    readonly replyP95Ms: number | null;
    readonly issueToStagedP95Ms: number | null;
    readonly stagedToShownP95Ms: number | null;
    readonly editDropped: number;
    readonly mainP95Ms: number | null;
    readonly editVisibleStreamingP95: number | null;
    readonly streamingRefused: number;
    readonly timedOut: readonly string[];
    readonly frames: BenchFrames & { readonly frames: { readonly max: number } };
  };
  /** SP5b's save leg L11 (SP5b spec §6.2; `bench.ts`' PersistFigures); absent from SP5a's files. */
  readonly persist?: Persist;
  readonly structuralFrames?: ReadonlyArray<{ readonly frame: number; readonly leg: string; readonly kind: string; readonly stutterMs: number }>;
  readonly shaderCache?: string;
}

/** The R7 probe's two counts on a bench file: no column shown half-built or mixing two meshes (spec §8.4). */
function checkReveal(file: string, b: Bench): void {
  expect(b.stream.partialColumnFrames, `${file}: partialColumnFrames`).toBe(0);
  expect(b.stream.mixedColumnFrames, `${file}: mixedColumnFrames`).toBe(0);
}

/** The shape of a gated Iris Xe Chrome bench file (spec §8.4). */
function checkBench(file: string, workers: number | null): Bench {
  expect(existsSync(join(ASSETS_SP5B, file)), `${file} missing: run npm run measure:chrome -- --route bench --gpu iris${workers === 4 ? ' --workers 4' : ''}`).toBe(true);
  const b = read<Bench>(ASSETS_SP5B, file);
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
  // Every entry names a known leg, so a relabelled leg cannot leave either stutter check reading an empty set (final
  // review GOV-3).
  const unknown = b.structuralFrames!.filter((e) => !SP4B_LEGS.has(e.leg) && !LIVE_LEGS.has(e.leg) && !EDIT_LEGS.has(e.leg)).map((e) => e.leg);
  expect(unknown, `${file}: structural frames of a leg outside L0-L11`).toEqual([]);
  // SP4b's legs only, so the re-asserted streaming cells stay as SP4b gated them; L7-L9 are `G1.live`'s (SP4c spec §8.4);
  // L10's long frames are its `over33`, an exit check (SP5a spec §6.2), recorded by `G2.edit`.
  const over = b.structuralFrames!.filter((e) => SP4B_LEGS.has(e.leg) && !(e.stutterMs <= OVER_MS));
  expect(over, `${file}: SP4b-leg structural frames whose stutterMs is over ${OVER_MS} ms`).toEqual([]);
  checkReveal(file, b);
  return b;
}

metricTest('G1', ['mediumStreamP95', 'mediumStreamOver33', 'mediumStreamDrawCalls', 'mediumStreamMainP95', 'mediumFill4wMs', 'mediumGpuMB'], () => {
  const b = checkBench(BENCH, null);
  const w4 = checkBench(BENCH_W4, 4);
  expect(w4.load.revealMs, `${BENCH_W4}: the first entry's reveal was timed`).not.toBeNull();

  const others: Record<string, unknown> = {};
  for (const file of BENCH_OTHERS) {
    if (!existsSync(join(ASSETS_SP5B, file))) continue;
    const o = read<Bench>(ASSETS_SP5B, file);
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

/** The R7 probe's two counts over a bench file's live legs (SP4c spec §8.4: 0 in every file). */
function checkLiveReveal(file: string, b: Bench): void {
  expect(b.live, `${file}: the live block (SP4c's L7-L9) is present`).toBeDefined();
  expect(b.live!.partialColumnFrames, `${file}: live.partialColumnFrames`).toBe(0);
  expect(b.live!.mixedColumnFrames, `${file}: live.mixedColumnFrames`).toBe(0);
}

metricTest('G1', ['mediumLiveP95', 'mediumLiveOver33', 'mediumLiveGpuMB'], () => {
  // The streaming call's shape checks (route, Iris Xe, RegionBatch, RD 12, default profile, cold cache), then the live block's.
  const b = checkBench(BENCH, null);
  checkLiveReveal(BENCH, b);
  const live = b.live!;
  expect(live.frames.count, `${BENCH}: the live legs were measured`).toBeGreaterThan(0);
  for (const k of ['gpuMB', 'geometryMB', 'texturesMB', 'drawingBufferMB'] as const) {
    expect(Number.isFinite(live[k]), `${BENCH}: live.${k} is a number`).toBe(true);
  }
  const liveStructural = b.structuralFrames!.filter((e) => LIVE_LEGS.has(e.leg));
  // The live legs' edit, undo and teleport always restructure: an empty set would gate nothing (GOV-3; 55 today).
  expect(liveStructural.length, `${BENCH}: L7-L9 structural frames`).toBeGreaterThan(0);
  const over = liveStructural.filter((e) => !(e.stutterMs <= OVER_MS));
  expect(over, `${BENCH}: L7-L9 structural frames whose stutterMs is over ${OVER_MS} ms`).toEqual([]);

  // The w4 file's live legs are recorded, not gated (§8.4); the RTX and Firefox files' live blocks are exit checks.
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP5B, file))) continue;
    const o = read<Bench>(ASSETS_SP5B, file);
    checkLiveReveal(file, o);
    const l = o.live!;
    others[file] = {
      renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs,
      p95: l.frames.p95, over33: l.frames.over33, drawCallsMax: l.drawCalls.max, gpuMB: l.gpuMB,
      structuralStutterMaxMs: Math.max(0, ...(o.structuralFrames ?? []).filter((e) => LIVE_LEGS.has(e.leg)).map((e) => e.stutterMs)),
      applyFirstSwapMs: l.applyFirstSwapMs, applyNearMs: l.applyNearMs, undoNearMs: l.undoNearMs, teleportFirstRevealMs: l.teleportFirstRevealMs,
      timedOut: l.timedOut,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.live.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  return {
    mediumLiveP95: live.frames.p95,
    mediumLiveOver33: live.frames.over33,
    mediumLiveGpuMB: live.gpuMB,
    displayIntervalMs: b.displayIntervalMs,
    liveFrames: live.frames.count,
    liveStructuralFrames: liveStructural.length,
    liveDrawCallsMax: live.drawCalls.max,
    liveMainP95: live.main.p95,
    // The exit checks and recorded times (SP4c spec §8.4, D24): numbers or -1 when a threshold was never reached.
    applyFirstSwapMs: live.applyFirstSwapMs ?? -1,
    applyNearMs: live.applyNearMs ?? -1,
    applyFullMs: live.applyFullMs ?? -1,
    undoFirstSwapMs: live.undoFirstSwapMs ?? -1,
    undoNearMs: live.undoNearMs ?? -1,
    undoFullMs: live.undoFullMs ?? -1,
    teleportFirstRevealMs: live.teleportFirstRevealMs ?? -1,
    teleportRefillMs: live.teleportRefillMs ?? -1,
  };
}, 600_000, { outName: 'G1.live' });

metricTest('G2', ['editVisibleP95'], () => {
  // The streaming call's shape checks (route, Iris Xe, RegionBatch, RD 12, default profile, cold cache), then the edit block's.
  const b = checkBench(BENCH, null);
  expect(b.edit, `${BENCH}: the edit block (SP5a's L10) is present`).toBeDefined();
  const e = b.edit!;
  expect(e.timedOut, `${BENCH}: L10's hover filled the RD 12 disc within 60 s`).toEqual([]);
  expect(e.editVisibleP95, `${BENCH}: L10's edits were shown`).not.toBeNull();

  // The RTX, w4 and Firefox files' edit blocks are recorded, never gated (SP5a spec §6.2).
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP5B, file))) continue;
    const o = read<Bench>(ASSETS_SP5B, file);
    if (o.edit === undefined) continue;
    others[file] = {
      renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs,
      editVisibleP95: o.edit.editVisibleP95, editAllVisibleP95: o.edit.editAllVisibleP95, editDropped: o.edit.editDropped,
      mainP95Ms: o.edit.mainP95Ms, editVisibleStreamingP95: o.edit.editVisibleStreamingP95,
      over33: o.edit.frames.frames.over33, frameMaxMs: o.edit.frames.frames.max, timedOut: o.edit.timedOut,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G2.edit.others.json'), `${JSON.stringify({ id: 'G2', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  // Recorded, not gated (SP5a spec §6.2): numbers, or -1 for a figure with no sample.
  const n = (v: number | null): number => v ?? -1;
  return {
    editVisibleP95: e.editVisibleP95!,
    displayIntervalMs: b.displayIntervalMs,
    editVisibleP50: n(e.editVisibleP50),
    editVisibleMax: n(e.editVisibleMax),
    editAllVisibleP95: n(e.editAllVisibleP95),
    relightP95Ms: n(e.relightP95Ms),
    editP95Ms: n(e.editP95Ms),
    replyP95Ms: n(e.replyP95Ms),
    issueToStagedP95Ms: n(e.issueToStagedP95Ms),
    stagedToShownP95Ms: n(e.stagedToShownP95Ms),
    editDropped: e.editDropped,
    mainP95Ms: n(e.mainP95Ms),
    editVisibleStreamingP95: n(e.editVisibleStreamingP95),
    streamingRefused: e.streamingRefused,
    // L10's frames: its over33 is an exit check (SP5a spec §6.2, §12), recorded here, not a part.
    over33: e.frames.frames.over33,
    frameMaxMs: e.frames.frames.max,
    framesP95: e.frames.frames.p95,
  };
}, 600_000, { outName: 'G2.edit' });

/** The "on" parts' flushes the gate needs at least (SP5b spec §6.2: the two "on" parts hold about 30). */
const MIN_FLUSHES = 20;

metricTest('G2', ['over33Added', 'p95AddedMs', 'editVisibleAddedMs', 'flushEditVisibleP95', 'replyDuringFlushP95Ms'], () => {
  // The streaming call's shape checks (route, Iris Xe, RegionBatch, RD 12, default profile, cold cache), then the
  // persist block's.
  const b = checkBench(BENCH, null);
  expect(b.persist, `${BENCH}: the persist block (SP5b's L11) is present`).toBeDefined();
  const p = b.persist!;
  expect(p.timedOut, `${BENCH}: L11's disc filled`).toEqual([]);
  expect(p.flushes, `${BENCH}: the "on" parts' flushes`).toBeGreaterThanOrEqual(MIN_FLUSHES);
  // A null in either "on" part fails the shape check (rulings P42), as does any gated figure with no sample.
  expect(p.L11b.editVisibleP95, `${BENCH}: L11b's edits were shown`).not.toBeNull();
  expect(p.L11d.editVisibleP95, `${BENCH}: L11d's edits were shown`).not.toBeNull();
  expect(p.editVisibleAddedMs, `${BENCH}: editVisibleAddedMs measured`).not.toBeNull();
  expect(p.replyDuringFlushP95Ms, `${BENCH}: replyDuringFlushP95Ms measured`).not.toBeNull();

  // The w4, RTX and Firefox files' persist blocks are recorded, never gated (SP5b spec §6.2).
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP5B, file))) continue;
    const o = read<Bench>(ASSETS_SP5B, file);
    if (o.persist === undefined) continue;
    others[file] = { renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs, ...o.persist };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G2.flush.others.json'), `${JSON.stringify({ id: 'G2', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  // Recorded, not gated: numbers, or -1 for a figure with no sample. `flushMainP95Ms` (the spec's max 0.3) is held
  // pending the user's check (D28; rulings R10, R11), so it is recorded here and is not a part.
  const n = (v: number | null): number => v ?? -1;
  const parts = { L11a: p.L11a, L11b: p.L11b, L11c: p.L11c, L11d: p.L11d };
  const perPart: Record<string, number> = {};
  for (const [name, part] of Object.entries(parts)) {
    perPart[`${name}P95`] = part.p95;
    perPart[`${name}P99`] = part.p99;
    perPart[`${name}Over33`] = part.over33;
    perPart[`${name}EditVisibleP95`] = n(part.editVisibleP95);
  }
  return {
    over33Added: p.over33Added,
    p95AddedMs: p.p95AddedMs,
    editVisibleAddedMs: p.editVisibleAddedMs!,
    flushEditVisibleP95: Math.max(p.L11b.editVisibleP95!, p.L11d.editVisibleP95!),
    replyDuringFlushP95Ms: p.replyDuringFlushP95Ms!,
    displayIntervalMs: b.displayIntervalMs,
    flushMainP95Ms: n(p.flushMainP95Ms),
    flushSyncP95Ms: n(p.flushSyncP95Ms),
    flushSyncMaxMs: n(p.flushSyncMaxMs),
    flushCommitP95Ms: n(p.flushCommitP95Ms),
    flushes: p.flushes,
    ...perPart,
  };
}, 600_000, { outName: 'G2.flush' });

const ENTER = 'enter-iris-chrome.json';
const ENTER_OTHERS = ['enter-rtx-chrome.json', 'enter-iris-firefox.json', 'enter-rtx-firefox.json'] as const;
/** The enter route's pairs, and those its medians keep: all but the first, the cold cache (SP5b spec §6.2). */
const ENTER_PAIRS = 6;
const ENTER_KEPT = 5;

/** One load of an enter JSON (`bench.ts`' EnterResult). */
interface EnterLoad {
  readonly revealMs: number | null;
  readonly idbOpenMs: number | null;
  readonly loadMs: number | null;
  readonly decodeMs: number | null;
}

/** The parts of an enter JSON G1 reads (`bench.ts`' EnterSummary, plus measureChrome's additions). */
interface Enter {
  readonly route: string;
  readonly renderer?: string | null;
  readonly pairs: ReadonlyArray<{ readonly unsaved: EnterLoad; readonly saved: EnterLoad }>;
  readonly kept: number;
  readonly pairRatios: ReadonlyArray<number | null>;
  readonly enterRatio: number | null;
  readonly medianUnsavedMs: number | null;
  readonly medianSavedMs: number | null;
  readonly idbOpenMs: number | null;
  readonly loadMs: number | null;
  readonly decodeMs: number | null;
  readonly newWorldRevealMs: number | null;
  readonly shaderCache?: string;
}

metricTest('G1', ['enterRatio'], () => {
  expect(existsSync(join(ASSETS_SP5B, ENTER)), `${ENTER} missing: run npm run measure:chrome -- --route enter --gpu iris`).toBe(true);
  const e = read<Enter>(ASSETS_SP5B, ENTER);
  expect(e.route, `${ENTER}: the ?bench=enter JSON`).toBe('bench=enter');
  expect(e.renderer ?? '', `${ENTER}: the renderer names the Iris Xe (rulings P42)`).toMatch(/Iris/i);
  expect(e.shaderCache, `${ENTER}: measured on a cold driver shader cache (rulings R11)`).toBe('cold');
  expect(e.pairs.length, `${ENTER}: ${ENTER_PAIRS} pairs`).toBe(ENTER_PAIRS);
  expect(e.kept, `${ENTER}: ${ENTER_KEPT} pairs kept`).toBe(ENTER_KEPT);
  expect(e.enterRatio, `${ENTER}: the kept pairs' ratio was measured`).not.toBeNull();

  const others: Record<string, unknown> = {};
  for (const file of ENTER_OTHERS) {
    if (!existsSync(join(ASSETS_SP5B, file))) continue;
    const o = read<Enter>(ASSETS_SP5B, file);
    others[file] = {
      renderer: o.renderer ?? null, kept: o.kept, pairRatios: o.pairRatios, enterRatio: o.enterRatio,
      medianUnsavedMs: o.medianUnsavedMs, medianSavedMs: o.medianSavedMs, idbOpenMs: o.idbOpenMs, loadMs: o.loadMs,
      decodeMs: o.decodeMs, newWorldRevealMs: o.newWorldRevealMs,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.enter.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  // Recorded, not gated (SP5b spec §6.2): numbers, or -1 for a figure with no sample.
  const n = (v: number | null): number => v ?? -1;
  return {
    enterRatio: e.enterRatio!,
    medianUnsavedMs: n(e.medianUnsavedMs),
    medianSavedMs: n(e.medianSavedMs),
    idbOpenPlusLoadMs: e.idbOpenMs === null || e.loadMs === null ? -1 : e.idbOpenMs + e.loadMs,
    idbOpenMs: n(e.idbOpenMs),
    loadMs: n(e.loadMs),
    decodeMs: n(e.decodeMs),
    newWorldRevealMs: n(e.newWorldRevealMs),
  };
}, 600_000, { outName: 'G1.enter' });

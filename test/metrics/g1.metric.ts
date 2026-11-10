import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { enterFileFailures, pasteFailures, pasteGateOf, persistFailures, screenFailures, type PasteOf, type ScreenOf } from '../harness/benchFiles';
import { metricTest } from '../harness/metric';

/**
 * G1's static cells (SP4a spec §9.1, §9.5, D24), every tier, milliseconds: read from the Chrome flight on the Iris Xe
 * re-measured on SP6a's code with caves, `docs/superpowers/specs/assets/sp6a/flight-iris-chrome.json` (`npm run
 * measure:chrome -- --route flight`, the `?flight=sp4a` route; SP4b spec §8.4; SP4c spec §8.4; SP5a spec §6.2; SP5b spec
 * §6.2; SP5c spec §10.4, D30; SP6a spec §10.6, D29: every G1 file re-measured into `assets/sp6a/`, the SP5c files staying
 * in `assets/sp5c/`). Its shape
 * is checked first: the route's JSON with the renderer naming the Iris Xe (as reported), the section renderer
 * RegionBatch ('batch'), RD 12, the default profile, a cold driver shader cache (`shaderCache`, rulings R11) and the
 * window fullscreen at 1920 × 1080 with a 1920 × 1080 @ 1 viewport (`screenFailures`, final review GOV-4). The three
 * gated parts:
 * - `mediumStaticP95`: the snapped frame times' p95 (`frames.p95`), max 16.7;
 * - `mediumStaticDrawCalls`: the draw calls' max (`drawCalls.max`), max 100;
 * - `mediumStaticMainP95`: the main-thread ms' p95 (`main.p95`), max 6.
 * SP4a's other flights (the 4-worker Iris run, the RTX, and the user's Firefox cells) stay in `assets/sp4a/` and are
 * recorded, when present, in `.out/G1.others.json`, never gated (§9.5: the Firefox cells are checked at the exit).
 *
 * G1's streaming cells (SP4b spec §8.2, §8.4, D23), every tier, a second call (`G1.streaming`): read from the committed
 * Iris Xe Chrome bench files `assets/sp6a/bench-iris-chrome.json` (the default pool) and `bench-iris-chrome-w4.json`
 * (4 workers), `npm run measure:chrome -- --route bench`, re-measured on SP6a's code (SP6a spec §10.6, D29). Each file's
 * shape is checked first: route `bench=medium`, the renderer naming the Iris Xe, RegionBatch, RD 12, the default
 * profile, a cold driver shader cache (rulings R11), the window fullscreen at 1920 × 1080 with a 1920 × 1080 @ 1
 * viewport (final review GOV-4), 4 workers in the w4 file, the `gpuMB` breakdown fields,
 * `structuralFrames` present, every entry's `leg` one of L0-L14, with every SP4b-leg entry's
 * (`leg` L0-L6) `stutterMs` ≤ 33 ms (the larger of its own snapped frame and the next one's, §8.4; rulings R10; SP4c's
 * live legs L7-L9 are `G1.live`'s; SP5a's edit leg L10's long frames are its `over33`, an exit check, not a G1 part;
 * SP5b's save leg L11's are `G2.flush`'s parts, SP5c's paste leg L12's `G2.paste`'s, SP6a's cave and X-ray legs L13 and
 * L14's `G1.caves`' and `G1.xray`'s),
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
 * `assets/sp6a/bench-iris-chrome.json`'s `live` block (the bench's Apply, undo and teleport legs L7-L9). The file's
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
 * `assets/sp6a/bench-iris-chrome.json`'s `edit` block (the bench's edit leg L10: 100 scripted edits through the page's
 * edit path). The file's shape is checked as the streaming call's, plus the `edit` block's: `timedOut` empty (the
 * hover's RD 12 disc filled) and `editVisibleP95` measured. The gated part:
 * - `editVisibleP95`: `edit.editVisibleP95`, the post → the frame the edited column's new mesh is shown, max 50.
 * The rest of the block is recorded: the other latencies, the step budget (§6.2), `editDropped`, `mainP95Ms` (master
 * §7's 0.3 ms), `editVisibleStreamingP95` and L10's `over33` (an exit check, not a part). The RTX, w4 and Firefox
 * bench files' `edit` blocks are recorded, when present, in `.out/G2.edit.others.json`, never gated.
 *
 * G2's flush parts (SP5b spec §6.2, D28), every tier, a fifth call (`G2.flush`): read from the same
 * `assets/sp6a/bench-iris-chrome.json`'s `persist` block (the bench's save leg L11: four 30 s parts at one place,
 * autosave off, on, off, on, L11a-L11d). The file's shape is checked as the streaming call's, plus the `persist`
 * block's: `timedOut` empty, at least 20 flushes in the "on" parts, every figure a gated part reads measured, both
 * "on" parts' `editVisibleP95` measured (rulings P42), and at least 20 edits overlapping a flush
 * (`replyDuringFlushCount`: L11 posts one right after each "on" part's flush, final review GOV-1); the three added
 * parts are recomputed from L11a-L11d and must equal the stored ones (`persistFailures`, final review GOV-4). The
 * gated parts:
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
 * enter file `assets/sp6a/enter-iris-chrome.json` (`npm run measure:chrome -- --route enter --gpu iris`). Its shape is
 * checked first: route `bench=enter`, the renderer naming the Iris Xe (rulings P42), a cold driver shader cache, six
 * pairs with the first (the cold cache) discarded, five kept, and (`enterFileFailures`, final review GOV-4) six
 * `pairRatios` each its pair's (b) / (a), `enterRatio` their median over pairs 1-5 recomputed, `gpu` 'iris' and the window
 * fullscreen at 1920 × 1080 with a 1920 × 1080 @ 1 viewport. The gated part:
 * - `enterRatio`: the median of the kept pairs' ratios (b) saved / (a) unsaved `revealMs`, max 1.10 (rulings R8).
 * Recorded beside it: both legs' medians, `idbOpenMs + loadMs`, `decodeMs` and `newWorldRevealMs` (null: -1). The RTX
 * and Firefox enter files are recorded, when present, in `.out/G1.enter.others.json`, never gated.
 *
 * G2's paste parts (SP5c spec §10.4, D28), every tier, a seventh call (`G2.paste`): read from the same
 * `assets/sp6a/bench-iris-chrome.json`'s `paste` block (the bench's paste leg L12: L12a the hover with the tool off,
 * L12b the house's 28 pastes, undos, redos, a move and a cut, L12c the two maximum blocks' 12 pastes and undos, L12d the
 * ghost swept). The file's shape is checked as the streaming call's, plus the `paste` block's (`pasteFailures`): L12 ran
 * whole (`timedOut` empty, `stoppedBy` null), L12b's 28 and L12c's 12 operations present, each 'ok' and shown, every
 * part's frame p95 measured and a ghost build's slice timed. The gated parts (`pasteGateOf`):
 * - `pasteOver33`: L12b's + L12c's `over33`, max 0;
 * - `sweepOver33`: L12d's `over33`, max 0;
 * - `pasteP95AddedMs`: the largest of L12b's, L12c's and L12d's frame p95 minus L12a's, max 4.17 (one 240 Hz interval);
 * - `housePasteVisibleP95`: the nearest-rank p95 of L12b's 28 `pasteVisibleMs`, max 500;
 * - `maxPasteVisibleMax`: the largest of L12c's 12 `pasteVisibleMs`, max 2000;
 * - `ghostSliceMaxMs`: the longest ghost build slice, max 4.
 * The rest of the block is recorded (`clipboardReadMs`, `clipboardWriteMs`, `diffWaitMaxMs` with the longest `editMs`,
 * `flushMainMaxMs`, `flushSyncMaxMs`, each part's frames, `toolDrawCallsMax` and `drawCallsMax`, the pools' growth).
 * The w4 and RTX bench files' `paste` blocks are recorded, when present, in `.out/G2.paste.others.json`, never gated.
 *
 * G1's cave parts (SP6a spec §10.6, D29), every tier, an eighth call (`G1.caves`): read from the same
 * `assets/sp6a/bench-iris-chrome.json`'s `caves` block (the bench's cave leg L13: the finder's nearest entrance, a flight
 * to it, then 60 s walking a route through cave air at 4.3 blocks per second while the world streams). The file's shape
 * is checked as the streaming call's, plus the `caves` block's: L13 ran whole (`timedOut` empty, `stoppedBy` null), the
 * finder answered with a hit, a route was walked and every gated figure measured. The gated parts:
 * - `caveP95`: the walk's snapped frame p95 (`caves.p95`), max 16.7;
 * - `caveOver33`: its frames over 33 ms (`caves.over33`), max 0;
 * - `caveMainP95`: its main-thread p95 (`caves.mainP95`), max 6.
 * The rest of the block is recorded (`routeBlocks`, `routeKinds`, `growthEvents`, p50/p99/max). The w4, RTX and Firefox
 * bench files' `caves` blocks are recorded, when present, in `.out/G1.caves.others.json`, never gated.
 *
 * G1's X-ray parts (SP6a spec §10.6, D10, D29), every tier, a ninth call (`G1.xray`): read from the same file's `xray`
 * block's RD 12 segment (`xray.rd12`, the bench's X-ray leg L14: X on, a hold, a 360° sweep, PageDown × 4, a cave
 * parameter applied with the map side by side, the refill, X off). The file's shape is checked as the streaming call's,
 * plus the `xray` block's: L14 ran whole (`timedOut` empty), the segment at RD 12 and every gated figure measured. The
 * gated parts:
 * - `xrayP95`: the segment's snapped frame p95 with the X-ray on (`rd12.p95`), max 16.7;
 * - `xrayOver33`: its frames over 33 ms (`rd12.over33`), max 0; the map's open (mode B) leaves the segment's frame
 *   figures, its own frame and the four after it (the canvas resize's GPU stall, `BENCH_MAP_OPEN_FRAMES` = 5), the edit
 *   set after them, as the close stays out of `xrayToggleMaxMs`, and is recorded as `xrayMapOpenMaxMs` (rulings R27, the
 *   user);
 * - `xrayMainP95`: its main-thread p95 (`rd12.mainP95`), max 6;
 * - `xrayGpuMB`: the GPU estimate's peak, the X-ray's buffers included (`rd12.gpuMB`), max 150;
 * - `xrayDrawCalls`: the whole frame's draw calls' max (`rd12.drawCallsMax`, spec §5.5's budget; rulings P46), max 100;
 * - `xrayToggleMaxMs`: the longest of the three frames from each toggle (`rd12.toggleMaxMs`), max 33.
 * Recorded: the renderer's X-ray objects (`xrayDrawCallsMax`, rulings P46), `gpuMs` on and off, `xrayVertexBytes`, the
 * radius, growth events, `xrayMapOpenMaxMs` (the map open's longest frame, recorded only: rulings R27),
 * `xrayApplyRefillMs` (about 8 s, accepted by the user, recorded only in SP6a: rulings R26) and the whole RD 16 segment.
 * The w4, RTX and Firefox bench files' `xray` blocks are recorded, when present, in `.out/G1.xray.others.json`, never
 * gated.
 */
const ASSETS = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp4a/', import.meta.url));
const ASSETS_SP6A = fileURLToPath(new URL('../../docs/superpowers/specs/assets/sp6a/', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));
const GATED = 'flight-iris-chrome.json';
const OTHERS = ['flight-iris-chrome-w4.json', 'flight-rtx-chrome.json', 'flight-iris-firefox.json', 'flight-rtx-firefox.json'] as const;

/** The parts of a flight JSON G1 reads (`src/ui/world/flight.ts`' FlightResult, plus measureChrome's additions). */
interface Flight extends ScreenOf {
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
  expect(existsSync(join(ASSETS_SP6A, GATED)), `${GATED} missing: run npm run measure:chrome -- --route flight --gpu iris`).toBe(true);
  const f = read(ASSETS_SP6A, GATED);
  expect(f.route, 'the ?flight=sp4a JSON').toBe('flight=sp4a');
  expect(f.renderer ?? '', 'the renderer names the Iris Xe').toMatch(/Iris/i);
  expect(f.sectionRenderer, 'measured on RegionBatch').toBe('batch');
  expect(f.rd, 'at RD 12').toBe(12);
  expect(f.profile, 'on the default profile').toBe('default');
  expect(f.frames.count, 'a flight was measured').toBeGreaterThan(0);
  expect(f.shaderCache, 'measured on a cold driver shader cache (rulings R11)').toBe('cold');
  expect(screenFailures(f), 'measured fullscreen at 1920 × 1080 @ 1 (final review GOV-4)').toEqual([]);

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
 * SP5a's edit leg, L11 SP5b's save leg and L12 SP5c's paste leg (their structural frames are known, not stutter-checked:
 * L10's `over33` is an exit check, L11's long frames `G2.flush`'s parts, L12's `G2.paste`'s).
 */
const SP4B_LEGS: ReadonlySet<string> = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
const LIVE_LEGS: ReadonlySet<string> = new Set(['L7', 'L8', 'L9']);
const EDIT_LEGS: ReadonlySet<string> = new Set(['L10', 'L11']);
/** SP5c's paste leg L12, whose long frames are `G2.paste`'s parts (SP5c spec §10.4): known, not stutter-checked. */
const PASTE_LEGS: ReadonlySet<string> = new Set(['L12']);
/** SP6a's cave and X-ray legs L13 and L14, whose frames are `G1.caves`' and `G1.xray`'s parts (SP6a spec §10.6): known. */
const CAVE_LEGS: ReadonlySet<string> = new Set(['L13', 'L14']);

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
  /** The edits `replyDuringFlushP95Ms` reads (final review GOV-1); absent from the files measured before it. */
  readonly replyDuringFlushCount?: number;
  readonly flushMainP95Ms: number | null;
  readonly flushes: number;
  readonly over33Added: number;
  readonly p95AddedMs: number;
  readonly editVisibleAddedMs: number | null;
  readonly timedOut: readonly string[];
}

/** One L12 part's figures (`bench.ts`' PastePartFigures). */
interface PastePart {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly over33: number;
  readonly ghostBuildMs: number | null;
  readonly ghostBuildFrames: number | null;
  readonly ghostSliceMaxMs: number | null;
  readonly overlayMainMaxMs: number | null;
  readonly targetReads: number;
  readonly drawCallsMax: number | null;
  readonly toolDrawCallsMax: number;
}

/** L12's block of a bench JSON (`bench.ts`' PasteFigures): the parts a-d, every operation, the clipboard, flushes and pools. */
interface Paste extends PasteOf {
  readonly L12a: PastePart;
  readonly L12b: PastePart;
  readonly L12c: PastePart;
  readonly L12d: PastePart;
  readonly ops: ReadonlyArray<PasteOf['ops'][number] & { readonly editMs: number | null; readonly subBatchMaxMs: number | null }>;
  readonly clipboardReadMs: number | null;
  readonly clipboardWriteMs: number | null;
  readonly poolBytes: {
    readonly before: { readonly block: number; readonly byte: number } | null;
    readonly after: { readonly block: number; readonly byte: number } | null;
  };
  readonly flushMainMaxMs: number | null;
  readonly flushSyncMaxMs: number | null;
  readonly diffWaitMaxMs: number | null;
}

/** L13's block of a bench JSON (`bench.ts`' CaveFigures). */
interface Caves {
  readonly routeBlocks: number;
  readonly routeKinds: Readonly<Record<string, number>>;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly over33: number;
  readonly mainP95: number | null;
  readonly growthEvents: number;
  readonly find: { readonly hit: unknown } | null;
  readonly timedOut: readonly string[];
  readonly stoppedBy: string | null;
}

/** One L14 segment of a bench JSON (`bench.ts`' XraySegmentFigures). */
interface XraySegment {
  readonly rd: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly over33: number;
  readonly mainP95: number | null;
  readonly gpuMs: {
    readonly on: { readonly p50: number; readonly p95: number } | null;
    readonly off: { readonly p50: number; readonly p95: number } | null;
  };
  readonly gpuMB: number | null;
  readonly drawCallsMax: number | null;
  readonly xrayDrawCallsMax: number | null;
  readonly toggleMaxMs: number | null;
  readonly xrayVertexBytes: number | null;
  readonly radius: number | null;
  readonly growthEvents: number;
}

/** L14's block of a bench JSON (`bench.ts`' XrayFigures). */
interface Xray {
  readonly rd12: XraySegment;
  readonly rd16: XraySegment;
  readonly xrayApplyRefillMs: number | null;
  /** The map open's longest frame, left out of the segments' frame figures (rulings R27); absent before R27's bench. */
  readonly xrayMapOpenMaxMs?: number | null;
  readonly edit: unknown;
  readonly timedOut: readonly string[];
}

/** The parts of a bench JSON G1 reads (`src/ui/world/bench.ts`' BenchResult, plus measureChrome's additions). */
interface Bench extends ScreenOf {
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
  /** SP5c's paste leg L12 (SP5c spec §10.4; `bench.ts`' PasteFigures); absent from SP5b's files. */
  readonly paste?: Paste;
  /** SP6a's cave leg L13 (SP6a spec §10.6; `bench.ts`' CaveFigures); absent from SP5c's files. */
  readonly caves?: Caves;
  /** SP6a's X-ray leg L14 (SP6a spec §10.6; `bench.ts`' XrayFigures); absent from SP5c's files. */
  readonly xray?: Xray;
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
  expect(existsSync(join(ASSETS_SP6A, file)), `${file} missing: run npm run measure:chrome -- --route bench --gpu iris${workers === 4 ? ' --workers 4' : ''}`).toBe(true);
  const b = read<Bench>(ASSETS_SP6A, file);
  expect(b.route, `${file}: the ?bench=medium JSON`).toBe('bench=medium');
  expect(b.renderer ?? '', `${file}: the renderer names the Iris Xe`).toMatch(/Iris/i);
  expect(b.sectionRenderer, `${file}: measured on RegionBatch`).toBe('batch');
  expect(b.rd, `${file}: at RD 12`).toBe(12);
  expect(b.profile, `${file}: on the default profile`).toBe('default');
  if (workers !== null) expect(b.workers, `${file}: ${workers} workers`).toBe(workers);
  expect(b.stream.frames.count, `${file}: a bench was measured`).toBeGreaterThan(0);
  expect(b.shaderCache, `${file}: measured on a cold driver shader cache (rulings R11)`).toBe('cold');
  expect(screenFailures(b), `${file}: measured fullscreen at 1920 × 1080 @ 1 (final review GOV-4)`).toEqual([]);
  for (const k of ['gpuMB', 'geometryMB', 'texturesMB', 'drawingBufferMB'] as const) {
    expect(Number.isFinite(b.stream[k]), `${file}: stream.${k} is a number`).toBe(true);
  }
  expect(Array.isArray(b.structuralFrames), `${file}: structuralFrames present`).toBe(true);
  // Every entry names a known leg, so a relabelled leg cannot leave either stutter check reading an empty set (final
  // review GOV-3).
  const unknown = b.structuralFrames!
    .filter((e) => !SP4B_LEGS.has(e.leg) && !LIVE_LEGS.has(e.leg) && !EDIT_LEGS.has(e.leg) && !PASTE_LEGS.has(e.leg) && !CAVE_LEGS.has(e.leg))
    .map((e) => e.leg);
  expect(unknown, `${file}: structural frames of a leg outside L0-L14`).toEqual([]);
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
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
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
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
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
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
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
/** The edits overlapping a flush the gate needs at least (SP5b spec §6.2: one per "on" flush; final review GOV-1). */
const MIN_REPLIES_DURING_FLUSH = 20;

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
  expect(p.replyDuringFlushCount ?? 0, `${BENCH}: the edits overlapping a flush (replyDuringFlushCount)`).toBeGreaterThanOrEqual(MIN_REPLIES_DURING_FLUSH);
  expect(persistFailures(p), `${BENCH}: the added parts are L11a-L11d's differences (final review GOV-4)`).toEqual([]);

  // The w4, RTX and Firefox files' persist blocks are recorded, never gated (SP5b spec §6.2).
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
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
    replyDuringFlushCount: p.replyDuringFlushCount!,
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
interface Enter extends ScreenOf {
  readonly route: string;
  readonly gpu?: string;
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
  expect(existsSync(join(ASSETS_SP6A, ENTER)), `${ENTER} missing: run npm run measure:chrome -- --route enter --gpu iris`).toBe(true);
  const e = read<Enter>(ASSETS_SP6A, ENTER);
  expect(e.route, `${ENTER}: the ?bench=enter JSON`).toBe('bench=enter');
  expect(e.renderer ?? '', `${ENTER}: the renderer names the Iris Xe (rulings P42)`).toMatch(/Iris/i);
  expect(e.shaderCache, `${ENTER}: measured on a cold driver shader cache (rulings R11)`).toBe('cold');
  expect(e.pairs.length, `${ENTER}: ${ENTER_PAIRS} pairs`).toBe(ENTER_PAIRS);
  expect(e.kept, `${ENTER}: ${ENTER_KEPT} pairs kept`).toBe(ENTER_KEPT);
  expect(e.enterRatio, `${ENTER}: the kept pairs' ratio was measured`).not.toBeNull();
  expect(enterFileFailures(e), `${ENTER}: six pairRatios, their median over pairs 1-5, the Iris Xe, fullscreen (final review GOV-4)`).toEqual([]);

  const others: Record<string, unknown> = {};
  for (const file of ENTER_OTHERS) {
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Enter>(ASSETS_SP6A, file);
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

metricTest('G2', ['pasteOver33', 'sweepOver33', 'pasteP95AddedMs', 'housePasteVisibleP95', 'maxPasteVisibleMax', 'ghostSliceMaxMs'], () => {
  // The streaming call's shape checks (route, Iris Xe, RegionBatch, RD 12, default profile, cold cache), then the paste
  // block's: L12 whole, L12b's 28 and L12c's 12 operations 'ok' and shown (SP5c spec §10.4).
  const b = checkBench(BENCH, null);
  expect(b.paste, `${BENCH}: the paste block (SP5c's L12) is present`).toBeDefined();
  const p = b.paste!;
  expect(pasteFailures(p), `${BENCH}: L12 ran whole`).toEqual([]);
  const gate = pasteGateOf(p);

  // The w4 and RTX files' paste blocks are recorded, never gated (SP5c spec §10.4).
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
    if (o.paste === undefined) continue;
    const failures = pasteFailures(o.paste);
    others[file] = {
      renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs,
      failures, ...(failures.length === 0 ? pasteGateOf(o.paste) : {}),
      L12a: o.paste.L12a, L12b: o.paste.L12b, L12c: o.paste.L12c, L12d: o.paste.L12d,
      clipboardReadMs: o.paste.clipboardReadMs, clipboardWriteMs: o.paste.clipboardWriteMs, diffWaitMaxMs: o.paste.diffWaitMaxMs,
      flushMainMaxMs: o.paste.flushMainMaxMs, flushSyncMaxMs: o.paste.flushSyncMaxMs, poolBytes: o.paste.poolBytes,
    };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G2.paste.others.json'), `${JSON.stringify({ id: 'G2', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  // Recorded, not gated (SP5c spec §10.4): numbers, or -1 for a figure with no sample.
  const n = (v: number | null): number => v ?? -1;
  const maxOf = (values: ReadonlyArray<number | null>): number => {
    const v = values.filter((x): x is number => x !== null);
    return v.length === 0 ? -1 : Math.max(...v);
  };
  const parts = { L12a: p.L12a, L12b: p.L12b, L12c: p.L12c, L12d: p.L12d };
  const perPart: Record<string, number> = {};
  for (const [name, part] of Object.entries(parts)) {
    perPart[`${name}P50`] = n(part.p50);
    perPart[`${name}P95`] = n(part.p95);
    perPart[`${name}P99`] = n(part.p99);
    perPart[`${name}Max`] = n(part.max);
    perPart[`${name}Over33`] = part.over33;
    perPart[`${name}GhostBuildMs`] = n(part.ghostBuildMs);
    perPart[`${name}GhostBuildFrames`] = n(part.ghostBuildFrames);
    perPart[`${name}OverlayMainMaxMs`] = n(part.overlayMainMaxMs);
    perPart[`${name}TargetReads`] = part.targetReads;
    perPart[`${name}DrawCallsMax`] = n(part.drawCallsMax);
    perPart[`${name}ToolDrawCallsMax`] = part.toolDrawCallsMax;
  }
  const { before, after } = p.poolBytes;
  return {
    ...gate,
    displayIntervalMs: b.displayIntervalMs,
    clipboardReadMs: n(p.clipboardReadMs),
    clipboardWriteMs: n(p.clipboardWriteMs),
    // Expected at most the longest `editMs` plus one sub-batch (SP5c spec §10.4).
    diffWaitMaxMs: n(p.diffWaitMaxMs),
    editMaxMs: maxOf(p.ops.map((o) => o.editMs)),
    subBatchMaxMs: maxOf(p.ops.map((o) => o.subBatchMaxMs)),
    flushMainMaxMs: n(p.flushMainMaxMs),
    flushSyncMaxMs: n(p.flushSyncMaxMs),
    toolDrawCallsMax: Math.max(...Object.values(parts).map((s) => s.toolDrawCallsMax)),
    drawCallsMax: maxOf(Object.values(parts).map((s) => s.drawCallsMax)),
    poolBlockBytesBefore: before?.block ?? -1,
    poolBlockBytesAfter: after?.block ?? -1,
    poolByteBytesBefore: before?.byte ?? -1,
    poolByteBytesAfter: after?.byte ?? -1,
    ...perPart,
  };
}, 600_000, { outName: 'G2.paste' });

/** A figure recorded beside the parts: the number, or -1 with no sample. */
const orNone = (v: number | null): number => v ?? -1;

metricTest('G1', ['caveP95', 'caveOver33', 'caveMainP95'], () => {
  // The streaming call's shape checks (route, Iris Xe, RegionBatch, RD 12, default profile, cold cache), then the caves
  // block's: L13 ran whole and every gated figure was measured (SP6a spec §10.6).
  const b = checkBench(BENCH, null);
  expect(b.caves, `${BENCH}: the caves block (SP6a's L13) is present`).toBeDefined();
  const c = b.caves!;
  expect(c.timedOut, `${BENCH}: L13's find and flight within their caps`).toEqual([]);
  expect(c.stoppedBy, `${BENCH}: L13 was not stopped`).toBeNull();
  expect(c.find?.hit ?? null, `${BENCH}: L13's finder found an entrance`).not.toBeNull();
  expect(c.routeBlocks, `${BENCH}: L13 walked a route`).toBeGreaterThan(0);
  for (const k of ['p95', 'mainP95'] as const) expect(c[k], `${BENCH}: caves.${k} measured`).not.toBeNull();

  // The w4, RTX and Firefox files' caves blocks are recorded, never gated (SP6a spec §10.6).
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
    if (o.caves === undefined) continue;
    others[file] = { renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs, ...o.caves };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.caves.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  const kinds: Record<string, number> = {};
  for (const [kind, n] of Object.entries(c.routeKinds)) kinds[`routeKind_${kind}`] = n;
  return {
    caveP95: c.p95!,
    caveOver33: c.over33,
    caveMainP95: c.mainP95!,
    displayIntervalMs: b.displayIntervalMs,
    caveP50: orNone(c.p50),
    caveP99: orNone(c.p99),
    caveMaxMs: orNone(c.max),
    routeBlocks: c.routeBlocks,
    growthEvents: c.growthEvents,
    ...kinds,
  };
}, 600_000, { outName: 'G1.caves' });

/** One L14 segment's recorded figures, prefixed by its RD (`rd12`, `rd16`): numbers, or -1 with no sample. */
function xraySegmentRecord(prefix: string, x: XraySegment): Record<string, number> {
  return {
    [`${prefix}Rd`]: orNone(x.rd),
    [`${prefix}P50`]: orNone(x.p50),
    [`${prefix}P95`]: orNone(x.p95),
    [`${prefix}P99`]: orNone(x.p99),
    [`${prefix}MaxMs`]: orNone(x.max),
    [`${prefix}Over33`]: x.over33,
    [`${prefix}MainP95`]: orNone(x.mainP95),
    [`${prefix}GpuMB`]: orNone(x.gpuMB),
    [`${prefix}DrawCallsMax`]: orNone(x.drawCallsMax),
    [`${prefix}XrayDrawCallsMax`]: orNone(x.xrayDrawCallsMax),
    [`${prefix}ToggleMaxMs`]: orNone(x.toggleMaxMs),
    [`${prefix}XrayVertexBytes`]: orNone(x.xrayVertexBytes),
    [`${prefix}Radius`]: orNone(x.radius),
    [`${prefix}GrowthEvents`]: x.growthEvents,
    [`${prefix}GpuMsOnP50`]: x.gpuMs.on?.p50 ?? -1,
    [`${prefix}GpuMsOnP95`]: x.gpuMs.on?.p95 ?? -1,
    [`${prefix}GpuMsOffP50`]: x.gpuMs.off?.p50 ?? -1,
    [`${prefix}GpuMsOffP95`]: x.gpuMs.off?.p95 ?? -1,
  };
}

metricTest('G1', ['xrayP95', 'xrayOver33', 'xrayMainP95', 'xrayGpuMB', 'xrayDrawCalls', 'xrayToggleMaxMs'], () => {
  // The streaming call's shape checks (route, Iris Xe, RegionBatch, RD 12, default profile, cold cache), then the xray
  // block's: L14 ran whole, its gated segment at RD 12 and every gated figure measured (SP6a spec §10.6).
  const b = checkBench(BENCH, null);
  expect(b.xray, `${BENCH}: the xray block (SP6a's L14) is present`).toBeDefined();
  const x = b.xray!;
  expect(x.timedOut, `${BENCH}: L14's map, refill and RD 16 within their caps`).toEqual([]);
  const s = x.rd12;
  expect(s.rd, `${BENCH}: xray.rd12 measured at RD 12`).toBe(12);
  for (const k of ['p95', 'mainP95', 'gpuMB', 'drawCallsMax', 'toggleMaxMs'] as const) {
    expect(s[k], `${BENCH}: xray.rd12.${k} measured`).not.toBeNull();
  }
  // Measured by R27's bench: the map's open left out of the frame figures and its longest frame recorded.
  expect(x.xrayMapOpenMaxMs ?? null, `${BENCH}: xray.xrayMapOpenMaxMs recorded (rulings R27)`).not.toBeNull();

  // The w4, RTX and Firefox files' xray blocks are recorded, never gated (SP6a spec §10.6).
  const others: Record<string, unknown> = {};
  for (const file of [BENCH_W4, ...BENCH_OTHERS]) {
    if (!existsSync(join(ASSETS_SP6A, file))) continue;
    const o = read<Bench>(ASSETS_SP6A, file);
    if (o.xray === undefined) continue;
    others[file] = { renderer: o.renderer, sectionRenderer: o.sectionRenderer, workers: o.workers, displayIntervalMs: o.displayIntervalMs, ...o.xray };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'G1.xray.others.json'), `${JSON.stringify({ id: 'G1', tier: process.env.METRICS_TIER ?? null, others }, null, 2)}\n`);

  return {
    xrayP95: s.p95!,
    xrayOver33: s.over33,
    xrayMainP95: s.mainP95!,
    xrayGpuMB: s.gpuMB!,
    xrayDrawCalls: s.drawCallsMax!,
    xrayToggleMaxMs: s.toggleMaxMs!,
    displayIntervalMs: b.displayIntervalMs,
    // Recorded, not gated: the map open's longest frame (rulings R27) and the X-ray's refill after the Apply (about 8 s,
    // accepted by the user; rulings R26).
    xrayMapOpenMaxMs: orNone(x.xrayMapOpenMaxMs ?? null),
    xrayApplyRefillMs: orNone(x.xrayApplyRefillMs),
    ...xraySegmentRecord('rd12', s),
    ...xraySegmentRecord('rd16', x.rd16),
  };
}, 600_000, { outName: 'G1.xray' });

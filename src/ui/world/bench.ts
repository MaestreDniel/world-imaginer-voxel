/**
 * The bench route `?bench=medium` (SP4b spec §8.3, §7.5, D22): seed 42, the default profile, RD 12, the default pool
 * (`?workers` overriding it) and the probe's section renderer (`?renderer` overriding it). The world page loads and
 * reveals as usual, with no HUD, input, help, notices or overlay and the stored settings unread (no FPS cap, FOV 70);
 * then, with this module's driver as `WorldPageOptions.bench`, the page:
 * 1. waits 120 idle frames (nothing rendered), whose median rAF delta is the display interval;
 * 2. runs its own streaming frame (`frameStep.ts`, SP4b spec §7.2: the coordinator, the uploads, the reveals, the
 *    throttle) with the camera's pose set by the script before each step (`benchPose`: 95 s of legs at y 150, pitch −15,
 *    the time from 08:00 at ×60), and records each rendered frame into the preallocated `BenchRecord`
 *    (`createBenchRecorder`), so the bench measures the page and not its own garbage;
 * 3. hands the driver the run's fixed figures (`done`); the driver publishes `summarizeBench`'s JSON as
 *    `window.__wiBench.result` (read by `measureChrome.ts --route bench`) and a "Download JSON" button (the Firefox
 *    cells, by hand).
 *
 * `&shot=<name>` (plan; spec §8.7, the review screenshots, taken by `measureChrome.ts --shot`): the script freezes at the
 * shot's moment, the camera drops to 32 blocks above the ground under it at pitch −20 (rulings R9), the page renders
 * three more frames and stops, and `window.__wiBench.shotReady` turns true; nothing is drawn over the world and no JSON
 * is published.
 *
 * The world page imports this module's values; this module loads the page with a dynamic `import()`, so the two do not
 * import each other statically.
 */
import type { Stage } from '../../engine/rings';
import { medianInterval, percentile, snapFrameTime } from '../../render/frameTiming';
import type { GpuEstimate, WorldRenderer } from '../../render/renderer';
import type { RevealProbe, SectionRenderer, SectionRendererCounts, SectionRendererKind, StructuralKind } from '../../render/sectionRenderer';
import { el } from '../common/dom';
import { DEFAULT_MAP_STATE, encodeMapState } from '../map/mapState';
import { displayInterval } from './frameStep';
import { parseWorldQuery, type WorldQuery } from './query';

/** The route's world and camera (spec §8.3). */
export const BENCH_SEED = '42';
export const BENCH_PROFILE = 'default';
export const BENCH_RD = 12;
export const BENCH_Y = 150;
export const BENCH_PITCH = -15;
/** The clock's speed while the script runs: a day in 20 s, so the lightmap's change path runs (spec §8.3). */
export const BENCH_TIME_SPEED = 60;
/** The idle frames after the reveal that measure the display interval (spec §8.3). */
export const BENCH_IDLE_FRAMES = 120;
/** The record's frames: 95 s at 240 Hz is 22,800. */
export const BENCH_FRAME_CAPACITY = 32768;

export interface BenchLeg {
  readonly name: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  readonly seconds: number;
  /** Blocks per second; 0 hovers. */
  readonly speed: number;
  /**
   * The headings flown, in degrees (yaw 0 faces −z, north; 90 faces +x, east; ruling P42), each for an equal share of
   * the leg, turning at once (plan); none for a hover.
   */
  readonly headings: readonly number[];
  /** The render distance from `atS` seconds into the leg; it holds until the next step (BENCH_RD before any). */
  readonly rdSteps: readonly { readonly atS: number; readonly rd: number }[];
}

/** The script (spec §8.3): 95 s, a leg covering [start, end). */
export const BENCH_LEGS: readonly BenchLeg[] = [
  { name: 'L0', seconds: 5, speed: 0, headings: [], rdSteps: [] },
  // East at master §7's streaming budget, 400 blocks.
  { name: 'L1', seconds: 20, speed: 20, headings: [90], rdSteps: [] },
  // Four 90° turns (heap rebuilds); the square closes where L1 stopped.
  { name: 'L2', seconds: 10, speed: 20, headings: [180, 270, 0, 90], rdSteps: [] },
  // North at the user's top speed, 2,880 blocks.
  { name: 'L3', seconds: 30, speed: 96, headings: [0], rdSteps: [] },
  // North at Ctrl × 4, 1,920 blocks: generation falls behind and holes show; the frame must not stutter.
  { name: 'L4', seconds: 5, speed: 384, headings: [0], rdSteps: [] },
  // The refill: the time until the RD 12 disc around the stop is revealed.
  { name: 'L5', seconds: 10, speed: 0, headings: [], rdSteps: [] },
  // Live RD: 12 → 8, hover 5 s, → 12, hover 10 s.
  { name: 'L6', seconds: 15, speed: 0, headings: [], rdSteps: [{ atS: 0, rd: 8 }, { atS: 5, rd: 12 }] },
];

/** Each leg's start, s, and the script's length (95 s). */
const LEG_STARTS: readonly number[] = BENCH_LEGS.map((_, i) => BENCH_LEGS.slice(0, i).reduce((s, l) => s + l.seconds, 0));
export const BENCH_SECONDS = LEG_STARTS[LEG_STARTS.length - 1]! + BENCH_LEGS[BENCH_LEGS.length - 1]!.seconds;

/** L5's window, where the page measures the refill (spec §8.3: until `filledRadius` at RD 12 is 12). */
export const BENCH_REFILL = { leg: 5, fromS: LEG_STARTS[5]!, toS: LEG_STARTS[5]! + BENCH_LEGS[5]!.seconds, rd: BENCH_RD } as const;

/** The camera's pose: blocks, and degrees (ruling P42). */
export interface BenchPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** The unit vectors of the four cardinal headings (0, 90, 180, 270), exact, so the square of L2 closes exactly. */
const CARDINAL_X: readonly number[] = [0, 1, 0, -1];
const CARDINAL_Z: readonly number[] = [-1, 0, 1, 0];

/** x of a heading's unit vector (yaw 0 faces −z, 90 faces +x; ruling P42). */
function headingX(deg: number): number {
  const q = deg / 90;
  return Number.isInteger(q) ? CARDINAL_X[((q % 4) + 4) % 4]! : Math.sin((deg * Math.PI) / 180);
}

/** z of a heading's unit vector. */
function headingZ(deg: number): number {
  const q = deg / 90;
  return Number.isInteger(q) ? CARDINAL_Z[((q % 4) + 4) % 4]! : -Math.cos((deg * Math.PI) / 180);
}

/** The yaw before any heading is flown: L0 hovers facing L1's way (plan). */
const FIRST_HEADING = BENCH_LEGS.find((l) => l.headings.length > 0)!.headings[0]!;

/** `benchPose`'s result, reused by every call (the page calls it once per frame and allocates nothing). */
const POSE_RESULT = { leg: 0, rd: BENCH_RD };

/**
 * The script's pose at `tS` seconds from `start` (spec §8.3), written into `out`: x and z flown along the headings so
 * far, y 150, pitch −15, the yaw the current heading (kept while hovering); a leg and each heading's share of it cover
 * [start, end), so at a boundary the pose is the next one's. Past the end the last pose holds. Returns the leg's index
 * and the render distance the script wants; the result object is reused by the next call.
 */
export function benchPose(tS: number, start: { readonly x: number; readonly z: number }, out: BenchPose): { leg: number; rd: number } {
  const t = Math.min(Math.max(tS, 0), BENCH_SECONDS);
  let x = start.x;
  let z = start.z;
  let yaw = FIRST_HEADING;
  let leg = BENCH_LEGS.length - 1;
  let rd = BENCH_RD;
  for (let i = 0; i < BENCH_LEGS.length; i++) {
    const l = BENCH_LEGS[i]!;
    const end = LEG_STARTS[i]! + l.seconds;
    const into = Math.min(t, end) - LEG_STARTS[i]!;
    const share = l.seconds / Math.max(1, l.headings.length);
    for (let h = 0; h < l.headings.length && into >= h * share; h++) {
      const heading = l.headings[h]!;
      const d = l.speed * (Math.min(into, (h + 1) * share) - h * share);
      x += d * headingX(heading);
      z += d * headingZ(heading);
      yaw = heading;
    }
    // Indexed loops: a for-of makes an iterator per call (rulings R7; the page calls this every frame).
    const steps = l.rdSteps;
    if (t < end) {
      leg = i;
      for (let k = 0; k < steps.length; k++) if (into >= steps[k]!.atS) rd = steps[k]!.rd;
      break;
    }
    // A finished leg's last RD step holds after it (only at the clamped end: L6 is the last leg).
    if (steps.length > 0) rd = steps[steps.length - 1]!.rd;
  }
  out.x = x;
  out.y = BENCH_Y;
  out.z = z;
  out.yaw = yaw;
  out.pitch = BENCH_PITCH;
  POSE_RESULT.leg = leg;
  POSE_RESULT.rd = rd;
  return POSE_RESULT;
}

/**
 * The display interval from the idle frames' rAF deltas (spec §8.3): their median through the page's finite fallback
 * (`displayInterval`, 1000/60 when the median is not finite; rulings R5 (a)), so no frame time snaps to NaN.
 */
export function benchInterval(idle: ArrayLike<number>): number {
  return displayInterval(medianInterval(idle));
}

// ---------------------------------------------------------------- the record

/** The per-frame fields, one preallocated column each (spec §8.3). */
export const BENCH_FIELDS = [
  'leg', 'rawMs', 'snappedMs', 'mainMs', 'coordinatorMs', 'uploadMs', 'rows', 'structuralKind', 'structuralMB', 'gpuMs', 'calls',
  'triangles', 'geometryMB', 'texturesMB', 'drawingBufferMB', 'heapMB', 'sabMB', 'partial', 'mixed', 'genCap',
] as const;
export type BenchField = (typeof BENCH_FIELDS)[number];

/**
 * The bench's frames: one `Float64Array` column per field and the count `n`, so that recording a frame allocates
 * nothing. `leg` is the leg's index; `structuralKind` 0 for none, 1-5 for create / grow / instances / optimize /
 * compact; `gpuMs` the frame's own draw's GPU time, written when its query finishes (1-3 frames later), NaN without a
 * sample; `heapMB` NaN where the browser does not expose it.
 */
export type BenchRecord = { n: number; readonly capacity: number } & { readonly [K in BenchField]: Float64Array };

export function createBenchRecord(capacity: number): BenchRecord {
  const rec: Record<string, unknown> = { n: 0, capacity };
  for (const f of BENCH_FIELDS) rec[f] = new Float64Array(capacity);
  return rec as BenchRecord;
}

/** `structuralKind`'s codes, index = code (0: none). */
const STRUCTURAL_KINDS: readonly (StructuralKind | null)[] = [null, 'create', 'grow', 'instances', 'optimize', 'compact'];

const MIB = 1 << 20;
/** How often the JS heap and the store's SharedArrayBuffers are read, in recorded frames; the last value is carried. */
const MEMORY_SAMPLE_FRAMES = 30;

/** What the recorder reads each frame: structural views of the page's section renderer and world renderer. */
export interface BenchSources {
  readonly sections: Pick<SectionRenderer, 'counts' | 'probe'>;
  /**
   * The world renderer; `renderer.info.render` is read in place: `WorldRenderer.info()` returns a new object per call
   * (Task 23's notes), which the bench would otherwise measure as its own garbage.
   */
  readonly world: Pick<WorldRenderer, 'gpuEstimate' | 'gpuTimer'> & {
    readonly renderer: { readonly info: { readonly render: { readonly calls: number; readonly triangles: number } } };
  };
  /** The JS heap in MiB, NaN where it is not exposed (read every 30 frames). */
  heapMB(): number;
  /** The store's SharedArrayBuffers in MiB (read every 30 frames). */
  sabMB(): number;
}

/**
 * Records one rendered frame per `frame` call at `rec.n`, then `n + 1` (the leg was written there by the driver's
 * `pose`); a full record takes no more. `rawMs` is snapped to `intervalMs` (`snapFrameTime`). Read after the render:
 * the pump's last structural operation (`counts(out).lastStructural`, `lastStructuralBytes`), the probe, the GPU
 * estimate grouped as geometry (the sections and the sky), textures (the texture array and the lightmap) and the
 * drawing buffer (plan), the draw calls and triangles; every 30 frames the memory. The GPU timer's samples finish 1-3
 * frames after their draw: each frame keeps its draw's tag (`timer.draws() − 1`, the page renders once per recorded
 * frame) and every finished sample is written to the row of the draw it timed (Task 26b), so a structural frame's
 * `gpuMs` is its own; a sample of a draw before the first row (the warm-up, the reveal) has no row and is dropped.
 */
export function createBenchRecorder(rec: BenchRecord, src: BenchSources, intervalMs: number): {
  frame(rawMs: number, mainMs: number, coordinatorMs: number, uploadMs: number, rows: number, genCap: number): void;
} {
  const counts: SectionRendererCounts = {
    columnsStaged: 0, columnsComplete: 0, columnsRevealed: 0, columnsRemoving: 0, regions: 0, rows: 0, vertices: 0, indices: 0,
    structuralOps: 0, structuralMs: 0, lastStructural: null, lastStructuralBytes: 0,
  };
  const probe: RevealProbe = { columns: 0, partial: 0, mixed: 0 };
  const gpu: GpuEstimate = { sectionsBytes: 0, skyBytes: 0, textureBytes: 0, lightmapBytes: 0, drawingBufferBytes: 0 };
  const timer = src.world.gpuTimer();
  // Each row's draw (the timer's tag), increasing with the row.
  const draws = new Float64Array(rec.capacity);
  // The row being recorded, where the sink's search starts.
  let row = 0;
  const toRow = (draw: number, ms: number): void => {
    let j = row;
    while (j >= 0 && draws[j]! > draw) j--;
    if (j >= 0 && draws[j] === draw) rec.gpuMs[j] = ms;
  };
  // The last memory samples, in a typed array (a closure double would be boxed on each write).
  const memory = Float64Array.of(Number.NaN, Number.NaN);
  return {
    frame(rawMs, mainMs, coordinatorMs, uploadMs, rows, genCap) {
      const i = rec.n;
      if (i >= rec.capacity) return;
      rec.rawMs[i] = rawMs;
      rec.snappedMs[i] = snapFrameTime(rawMs, intervalMs);
      rec.mainMs[i] = mainMs;
      rec.coordinatorMs[i] = coordinatorMs;
      rec.uploadMs[i] = uploadMs;
      rec.rows[i] = rows;
      src.sections.counts(counts);
      const kind = counts.lastStructural === null ? 0 : STRUCTURAL_KINDS.indexOf(counts.lastStructural);
      rec.structuralKind[i] = kind;
      rec.structuralMB[i] = kind === 0 ? 0 : counts.lastStructuralBytes / MIB;
      rec.gpuMs[i] = Number.NaN;
      if (timer !== null) {
        draws[i] = timer.draws() - 1;
        row = i;
        timer.drain(toRow);
      }
      const info = src.world.renderer.info.render;
      rec.calls[i] = info.calls;
      rec.triangles[i] = info.triangles;
      src.world.gpuEstimate(gpu);
      rec.geometryMB[i] = (gpu.sectionsBytes + gpu.skyBytes) / MIB;
      rec.texturesMB[i] = (gpu.textureBytes + gpu.lightmapBytes) / MIB;
      rec.drawingBufferMB[i] = gpu.drawingBufferBytes / MIB;
      if (i % MEMORY_SAMPLE_FRAMES === 0) {
        memory[0] = src.heapMB();
        memory[1] = src.sabMB();
      }
      rec.heapMB[i] = memory[0]!;
      rec.sabMB[i] = memory[1]!;
      src.sections.probe(probe);
      rec.partial[i] = probe.partial;
      rec.mixed[i] = probe.mixed;
      rec.genCap[i] = genCap;
      rec.n = i + 1;
    },
  };
}

/** `performance.memory.usedJSHeapSize` in MiB (Chrome only), else NaN. */
export function jsHeapMB(): number {
  const memory = (performance as Performance & { readonly memory?: { readonly usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / MIB : Number.NaN;
}

// ---------------------------------------------------------------- the summary

/** What the page knows once, not per frame (spec §8.3): the identity fields, the load, the totals and L5's refill. */
export interface BenchFixed {
  readonly seed: string;
  readonly profile: string;
  readonly rd: number;
  /** The reservation's RD cap when it is below 12: the script's RD steps were clamped to it (Task 26b); else null. */
  readonly rdClampedTo: number | null;
  readonly workers: number;
  readonly sectionRenderer: SectionRendererKind;
  readonly userAgent: string;
  /** As reported (masked on Firefox). */
  readonly renderer: string | null;
  readonly vendor: string | null;
  readonly multiDraw: boolean;
  readonly timerQuery: boolean;
  readonly screen: { readonly width: number; readonly height: number };
  readonly dpr: number;
  /** The drawing buffer's pixel ratio, min(dpr, `pixelRatioCap`). */
  readonly pixelRatio: number;
  /** The median of the idle rAF deltas: the interval the frame times snap to. */
  readonly displayIntervalMs: number;
  readonly load: {
    readonly revealMs: number | null;
    readonly stageMs: Readonly<Record<Stage, number | null>>;
    readonly longTasks: { readonly count: number; readonly maxMs: number } | null;
    /** The page's `stats.first120MaxMs`: the largest delta of the first 120 rendered frames. */
    readonly first120RenderedMaxMs: number | null;
  };
  /** The coordinator's totals at the end of the script. */
  readonly totals: { readonly dropped: number; readonly failed: number; readonly storeFull: number };
  /** From L5's start to the first frame whose RD 12 disc is revealed; null when L5 ended first. */
  readonly refillMs: number | null;
}

export interface FrameFigures {
  /** Snapped frame times: count, nearest-rank p50 / p95 / p99, max, and the count over 33 ms (SP4a's rule). */
  readonly frames: { readonly count: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number; readonly over33: number };
  /** Main-thread ms per frame, from the rAF callback's start to the render's return. */
  readonly main: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly coordinatorMs: { readonly p95: number; readonly max: number };
  readonly uploadMs: { readonly p95: number; readonly max: number };
  readonly rowsPerFrameMax: number;
  /** Frames holding a structural operation (at most one per frame while flying). */
  readonly structuralOps: number;
  readonly drawCalls: { readonly max: number; readonly mean: number };
  readonly trianglesMax: number;
  /** Frames in which the probe saw a column showing some but not all of its rows / rows of two seqs (R7). */
  readonly partialColumnFrames: number;
  readonly mixedColumnFrames: number;
  readonly genCapMin: number;
}

export interface StreamFigures {
  readonly frames: FrameFigures['frames'];
  readonly main: FrameFigures['main'];
  readonly coordinatorMs: FrameFigures['coordinatorMs'];
  readonly uploadMs: FrameFigures['uploadMs'];
  readonly rowsPerFrameMax: number;
  readonly structuralOps: number;
  /** GPU ms over the timer's samples, or null without the timer query or a sample. */
  readonly gpuMs: { readonly p50: number; readonly p95: number; readonly max: number; readonly samples: number } | null;
  readonly drawCalls: FrameFigures['drawCalls'];
  readonly trianglesMax: number;
  /** The GPU estimate's peak (spec §8.4's formula), MB, and its breakdown at that frame. */
  readonly gpuMB: number;
  readonly geometryMB: number;
  readonly texturesMB: number;
  readonly drawingBufferMB: number;
  /** The largest JS heap (null where not exposed) and SharedArrayBuffer sizes, MB. */
  readonly heapMB: number | null;
  readonly sabMB: number | null;
  readonly partialColumnFrames: number;
  readonly mixedColumnFrames: number;
  readonly genCapMin: number;
  readonly dropped: number;
  readonly failed: number;
  readonly storeFull: number;
}

/** The bench's JSON (spec §8.3). */
export interface BenchResult {
  readonly route: 'bench=medium';
  readonly seed: string;
  readonly profile: string;
  readonly rd: number;
  readonly rdClampedTo: number | null;
  readonly workers: number;
  readonly sectionRenderer: SectionRendererKind;
  readonly userAgent: string;
  readonly renderer: string | null;
  readonly vendor: string | null;
  readonly multiDraw: boolean;
  readonly timerQuery: boolean;
  readonly screen: { readonly width: number; readonly height: number };
  readonly dpr: number;
  readonly pixelRatio: number;
  readonly displayIntervalMs: number;
  readonly load: BenchFixed['load'];
  /** L1-L6: the streaming legs. */
  readonly stream: StreamFigures;
  readonly legs: { readonly [K in BenchLeg['name']]: FrameFigures };
  readonly L5: { readonly refillMs: number | null };
  readonly L6: { readonly frames: FrameFigures['frames'] };
  /** Every frame whose snapped time is over 33 ms: its raw delta and its own and the previous frame's main ms. */
  readonly longFrames: ReadonlyArray<{
    readonly frame: number; readonly leg: string; readonly rawMs: number; readonly snappedMs: number; readonly mainMs: number;
    readonly prevMainMs: number | null;
  }>;
  /**
   * Every frame holding a structural operation: `snappedMs` is its own frame time (the gap ending at its rAF, as in
   * `longFrames`), `nextSnappedMs` the next frame's, the gap this frame's work fills (null for the last frame), and
   * `stutterMs` the larger of the two: the stutter the operation causes, which G1's "≤ 33 ms" check and spec §8.4's
   * tuning read (Task 26b). `gpuMs` is the frame's own draw's (the timer's samples are tagged with their draw).
   */
  readonly structuralFrames: ReadonlyArray<{
    readonly frame: number; readonly leg: string; readonly kind: StructuralKind; readonly renderer: SectionRendererKind; readonly MB: number;
    readonly mainMs: number; readonly gpuMs: number | null; readonly snappedMs: number; readonly nextSnappedMs: number | null;
    readonly stutterMs: number;
  }>;
}

/** A failed route: the page could not load or the script stopped (measureChrome writes it as it is and stops). */
export interface BenchError {
  readonly route: 'bench=medium';
  readonly error: string;
}

/** Spec §8.4 (SP4a's rule): a snapped frame time above 33 ms. */
const LONG_FRAME_MS = 33;

/** The values of `col` at `idx`. */
function pick(col: Float64Array, idx: readonly number[]): Float64Array {
  const out = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) out[k] = col[idx[k]!]!;
  return out;
}

function maxOf(values: ArrayLike<number>): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) m = Math.max(m, values[i]!);
  return values.length === 0 ? Number.NaN : m;
}

function minOf(values: ArrayLike<number>): number {
  let m = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i++) m = Math.min(m, values[i]!);
  return values.length === 0 ? Number.NaN : m;
}

const countIf = (values: ArrayLike<number>, f: (v: number) => boolean): number => {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (f(values[i]!)) n++;
  return n;
};

const finite = (values: Float64Array): Float64Array => values.filter((v) => Number.isFinite(v));

function figuresOf(rec: BenchRecord, idx: readonly number[]): FrameFigures {
  const snapped = pick(rec.snappedMs, idx);
  const main = pick(rec.mainMs, idx);
  const coordinator = pick(rec.coordinatorMs, idx);
  const upload = pick(rec.uploadMs, idx);
  const calls = pick(rec.calls, idx);
  let callSum = 0;
  for (let k = 0; k < calls.length; k++) callSum += calls[k]!;
  return {
    frames: {
      count: idx.length,
      p50: percentile(snapped, 50),
      p95: percentile(snapped, 95),
      p99: percentile(snapped, 99),
      max: maxOf(snapped),
      over33: countIf(snapped, (v) => v > LONG_FRAME_MS),
    },
    main: { p50: percentile(main, 50), p95: percentile(main, 95), max: maxOf(main) },
    coordinatorMs: { p95: percentile(coordinator, 95), max: maxOf(coordinator) },
    uploadMs: { p95: percentile(upload, 95), max: maxOf(upload) },
    rowsPerFrameMax: maxOf(pick(rec.rows, idx)),
    structuralOps: countIf(pick(rec.structuralKind, idx), (v) => v !== 0),
    drawCalls: { max: maxOf(calls), mean: idx.length === 0 ? Number.NaN : callSum / idx.length },
    trianglesMax: maxOf(pick(rec.triangles, idx)),
    partialColumnFrames: countIf(pick(rec.partial, idx), (v) => v > 0),
    mixedColumnFrames: countIf(pick(rec.mixed, idx), (v) => v > 0),
    genCapMin: minOf(pick(rec.genCap, idx)),
  };
}

const legName = (i: number): string => BENCH_LEGS[i]?.name ?? `L${i}`;

/**
 * The bench's JSON from its record and the fixed figures (spec §8.3): `stream` over L1-L6 (the streaming legs; L0's
 * hover only settles the first frames), the same frame figures per leg, L5's refill and L6's frames, every long frame
 * and every structural frame. `gpuMB` is the largest per-frame sum of the breakdown, which is reported at that frame.
 */
export function summarizeBench(rec: BenchRecord, fixed: BenchFixed): BenchResult {
  const all: number[] = [];
  const byLeg: number[][] = BENCH_LEGS.map(() => []);
  for (let i = 0; i < rec.n; i++) {
    all.push(i);
    byLeg[rec.leg[i]!]?.push(i);
  }
  const streamIdx = all.filter((i) => rec.leg[i]! >= 1);
  const f = figuresOf(rec, streamIdx);

  let peak = -1;
  let peakMB = Number.NaN;
  for (const i of streamIdx) {
    const mb = rec.geometryMB[i]! + rec.texturesMB[i]! + rec.drawingBufferMB[i]!;
    if (peak < 0 || mb > peakMB) {
      peak = i;
      peakMB = mb;
    }
  }
  const gpu = finite(pick(rec.gpuMs, streamIdx));
  const heap = finite(pick(rec.heapMB, streamIdx));
  const sab = finite(pick(rec.sabMB, streamIdx));
  const stream: StreamFigures = {
    frames: f.frames,
    main: f.main,
    coordinatorMs: f.coordinatorMs,
    uploadMs: f.uploadMs,
    rowsPerFrameMax: f.rowsPerFrameMax,
    structuralOps: f.structuralOps,
    gpuMs: gpu.length === 0 ? null : { p50: percentile(gpu, 50), p95: percentile(gpu, 95), max: maxOf(gpu), samples: gpu.length },
    drawCalls: f.drawCalls,
    trianglesMax: f.trianglesMax,
    gpuMB: peakMB,
    geometryMB: peak < 0 ? Number.NaN : rec.geometryMB[peak]!,
    texturesMB: peak < 0 ? Number.NaN : rec.texturesMB[peak]!,
    drawingBufferMB: peak < 0 ? Number.NaN : rec.drawingBufferMB[peak]!,
    heapMB: heap.length === 0 ? null : maxOf(heap),
    sabMB: sab.length === 0 ? null : maxOf(sab),
    partialColumnFrames: f.partialColumnFrames,
    mixedColumnFrames: f.mixedColumnFrames,
    genCapMin: f.genCapMin,
    dropped: fixed.totals.dropped,
    failed: fixed.totals.failed,
    storeFull: fixed.totals.storeFull,
  };

  const legs = Object.fromEntries(BENCH_LEGS.map((l, k) => [l.name, figuresOf(rec, byLeg[k]!)])) as BenchResult['legs'];
  const longFrames: Array<BenchResult['longFrames'][number]> = [];
  const structuralFrames: Array<BenchResult['structuralFrames'][number]> = [];
  for (const i of all) {
    const leg = legName(rec.leg[i]!);
    if (rec.snappedMs[i]! > LONG_FRAME_MS) {
      longFrames.push({ frame: i, leg, rawMs: rec.rawMs[i]!, snappedMs: rec.snappedMs[i]!, mainMs: rec.mainMs[i]!, prevMainMs: i > 0 ? rec.mainMs[i - 1]! : null });
    }
    const kind = STRUCTURAL_KINDS[rec.structuralKind[i]!];
    if (kind !== null && kind !== undefined) {
      const ms = rec.gpuMs[i]!;
      const snappedMs = rec.snappedMs[i]!;
      const nextSnappedMs = i + 1 < rec.n ? rec.snappedMs[i + 1]! : null;
      structuralFrames.push({
        frame: i, leg, kind, renderer: fixed.sectionRenderer, MB: rec.structuralMB[i]!, mainMs: rec.mainMs[i]!,
        gpuMs: Number.isFinite(ms) ? ms : null, snappedMs, nextSnappedMs,
        stutterMs: nextSnappedMs === null ? snappedMs : Math.max(snappedMs, nextSnappedMs),
      });
    }
  }
  return {
    route: 'bench=medium',
    seed: fixed.seed,
    profile: fixed.profile,
    rd: fixed.rd,
    rdClampedTo: fixed.rdClampedTo,
    workers: fixed.workers,
    sectionRenderer: fixed.sectionRenderer,
    userAgent: fixed.userAgent,
    renderer: fixed.renderer,
    vendor: fixed.vendor,
    multiDraw: fixed.multiDraw,
    timerQuery: fixed.timerQuery,
    screen: { width: fixed.screen.width, height: fixed.screen.height },
    dpr: fixed.dpr,
    pixelRatio: fixed.pixelRatio,
    displayIntervalMs: fixed.displayIntervalMs,
    load: {
      revealMs: fixed.load.revealMs,
      stageMs: { ...fixed.load.stageMs },
      longTasks: fixed.load.longTasks,
      first120RenderedMaxMs: fixed.load.first120RenderedMaxMs,
    },
    stream,
    legs,
    L5: { refillMs: fixed.refillMs },
    L6: { frames: legs.L6.frames },
    longFrames,
    structuralFrames,
  };
}

// ---------------------------------------------------------------- the driver

/** The review shots (spec §8.7; plan), taken by `measureChrome.ts --route bench --shot <name>`. */
export const BENCH_SHOTS = ['fly96', 'fly384', 'rd12', 'rd8', 'rd12back', 'first'] as const;
export type BenchShot = (typeof BENCH_SHOTS)[number];

/**
 * The fixed shots' script times, s (plan): mid-L3 at 96 blocks/s, mid-L4 at 384, half a second before L6's lowering
 * (RD 12), a second after it (RD 8); `first` at the start, before any pose is set (the first view after the reveal).
 */
const SHOT_AT: Readonly<Record<Exclude<BenchShot, 'rd12back'>, number>> = {
  fly96: LEG_STARTS[3]! + 15,
  fly384: LEG_STARTS[4]! + 2.5,
  rd12: LEG_STARTS[6]! - 0.5,
  rd8: LEG_STARTS[6]! + 1,
  first: 0,
};
/** rd12back: the first frame after the RD is raised back (L6 + 5 s) at which the fog's RD is 12 again, else L6's end. */
const RD12BACK_FROM = LEG_STARTS[6]! + 5;
/** The frames rendered at the frozen pose before the shot is ready. */
const SHOT_FRAMES = 3;
/**
 * The review shots' camera (rulings R9; spec §8.7): at the frozen moment the camera drops to this many blocks above the
 * ground under it and looks down at this pitch, so the ground the view centre meets (about 88 blocks ahead) lies inside
 * RD 8's fog while the sky stays in the frame; the route's y 150 and pitch −15 show only sky and fog at RD 8.
 */
export const BENCH_SHOT_ABOVE = 32;
export const BENCH_SHOT_PITCH = -20;

/** Where the driver's output goes: `window.__wiBench` and the panel in the page, a list in a test. */
export interface BenchPublish {
  result(r: BenchResult | BenchError): void;
  shotReady(): void;
}

/** What the page gives the driver once its world exists, before the script's first pose. */
export interface BenchWorld {
  /** The largest RD the store's reservation allows (`reservationRdCap`, capped at RD_MAX). */
  readonly rdMax: number;
  /** The ground's height at block column (x, z): the store's `motionBlocking` heightmap, null when not Published. */
  heightAt(x: number, z: number): number | null;
}

/**
 * The world page's bench hook (`WorldPageOptions.bench`). The page calls `bind` once after the reveal, then `pose`
 * before each frame step, with the camera's current pose in `out` and the fog's RD; `pose` writes the script's pose
 * (the first call fixes the script's start where the camera is) and the frame's leg at `record.leg[record.n]`, and
 * returns the RD the script wants, never above `rdMax` (Task 26b: a reservation cap below 12 clamps the script's RD
 * steps, and `rdClampedTo` records the cap), which the page applies live when it changes; null ends the script, and the
 * page then calls `done`. The page writes each rendered frame into `record` (`createBenchRecorder`). `fail` ends the
 * script with an error (a failure after the reveal), once.
 */
export interface BenchDriver {
  readonly record: BenchRecord;
  /** The RD the script's steps were clamped to (the reservation's cap below 12), or null. */
  readonly rdClampedTo: number | null;
  bind(world: BenchWorld): void;
  pose(tS: number, out: BenchPose, fogRd: number): number | null;
  done(fixed: BenchFixed): void;
  fail(error: string): void;
}

/**
 * When to freeze for `shot` at script time `tS`: the time to freeze the pose at, or null to go on. rd12back waits for
 * the fog back at the script's top RD (`topRd`: 12, or the reservation's cap below it).
 */
function freezeTime(shot: BenchShot, tS: number, fogRd: number, topRd: number): number | null {
  if (shot !== 'rd12back') return tS >= SHOT_AT[shot] ? SHOT_AT[shot] : null;
  if (tS >= BENCH_SECONDS) return BENCH_SECONDS;
  return tS >= RD12BACK_FROM && fogRd >= topRd ? tS : null;
}

export function createBenchDriver(o: { readonly shot: BenchShot | null; readonly capacity?: number; readonly publish: BenchPublish }): BenchDriver {
  const record = createBenchRecord(o.capacity ?? BENCH_FRAME_CAPACITY);
  const start = { x: 0, z: 0 };
  let started = false;
  let ended = false;
  let frozenAt = -1;
  let frozenFrames = 0;
  // The reservation's RD cap (none until `bind`) and the shot's lowered y (NaN: the route's pose).
  let rdMax = Number.POSITIVE_INFINITY;
  let heightAt: BenchWorld['heightAt'] | null = null;
  let shotY = Number.NaN;
  const capped = (rd: number): number => Math.min(rd, rdMax);
  return {
    record,
    get rdClampedTo() {
      return rdMax < BENCH_RD ? rdMax : null;
    },
    bind(world) {
      rdMax = world.rdMax;
      heightAt = (x, z) => world.heightAt(x, z);
    },
    pose(tS, out, fogRd) {
      if (ended) return null;
      if (!started) {
        started = true;
        start.x = out.x;
        start.z = out.z;
      }
      if (o.shot !== null) {
        if (frozenAt < 0) frozenAt = freezeTime(o.shot, tS, fogRd, capped(BENCH_RD)) ?? -1;
        if (frozenAt >= 0) {
          if (frozenFrames >= SHOT_FRAMES) {
            ended = true;
            o.publish.shotReady();
            return null;
          }
          // `first` keeps the first view the page placed at the reveal.
          if (o.shot === 'first') {
            frozenFrames++;
            return capped(BENCH_RD);
          }
          const rd = benchPose(frozenAt, start, out).rd;
          // The shot's camera (rulings R9): the ground's height under the frozen pose, read once at the first frozen
          // frame and kept for the three; where it has no value (an unloaded column) the route's pose stays.
          if (frozenFrames === 0 && heightAt !== null) shotY = heightAt(Math.floor(out.x), Math.floor(out.z)) ?? Number.NaN;
          if (!Number.isNaN(shotY)) {
            out.y = shotY + BENCH_SHOT_ABOVE;
            out.pitch = BENCH_SHOT_PITCH;
          }
          frozenFrames++;
          return capped(rd);
        }
      }
      if (tS >= BENCH_SECONDS) {
        ended = true;
        return null;
      }
      const r = benchPose(tS, start, out);
      if (record.n < record.capacity) record.leg[record.n] = r.leg;
      return capped(r.rd);
    },
    done(fixed) {
      ended = true;
      // A shot publishes no JSON: its script stopped early, and nothing may be drawn over the world.
      if (o.shot !== null) return;
      let result: BenchResult | BenchError;
      try {
        result = summarizeBench(record, fixed);
      } catch (e) {
        result = { route: 'bench=medium', error: e instanceof Error ? e.stack ?? e.message : String(e) };
      }
      o.publish.result(result);
    },
    fail(error) {
      if (ended) return;
      ended = true;
      o.publish.result({ route: 'bench=medium', error });
    },
  };
}

// ---------------------------------------------------------------- the route

declare global {
  interface Window {
    /**
     * The bench's JSON once the script has run, or `{ error }` (read by measureChrome.ts over CDP); `shotReady` turns
     * true once a `&shot=` frame is on screen.
     */
    __wiBench?: { result: BenchResult | BenchError | null; shotReady?: boolean };
  }
}

/** The route's query: the given `workers` and `renderer`, RD 12, no position (the spawn), no capture mode. */
export function benchQuery(query: URLSearchParams): WorldQuery {
  const q = parseWorldQuery(query);
  return { at: null, y: null, yaw: null, pitch: null, rd: BENCH_RD, workers: q.workers, renderer: q.renderer, shot: false, time: null };
}

/** The route's `#` hash: seed 42, the default profile, no patch. */
export function benchHash(): string {
  return `#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: BENCH_SEED, profile: BENCH_PROFILE, patch: {} })}`;
}

const browserName = (): string => (/firefox/i.test(navigator.userAgent) ? 'firefox' : /chrome/i.test(navigator.userAgent) ? 'chrome' : 'browser');

/** The status line and, at the end, the "Download JSON" button, over the world (none for a shot). */
function benchPanel(): { say(s: string): void; done(result: BenchResult | BenchError): void } {
  const panel = el('div', 'flight-panel');
  panel.id = 'bench-panel';
  panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:3;display:flex;gap:8px;align-items:center;padding:4px 8px;'
    + 'background:rgba(15,22,41,.85);border-radius:4px;font:13px/1.4 system-ui,sans-serif;color:#e0e0e0';
  const status = el('span', '', 'Bench: loading the world…');
  panel.append(status);
  document.body.append(panel);
  const say = (s: string): void => { status.textContent = `Bench: ${s}`; };
  return {
    say,
    done(result) {
      if ('error' in result) say(`failed: ${result.error}`);
      else say(`done: stream frame p95 ${result.stream.frames.p95} ms, over 33 ms ${result.stream.frames.over33}, draw calls max ${result.stream.drawCalls.max}`);
      const download = el('button', '', 'Download JSON');
      download.id = 'bench-download';
      download.type = 'button';
      download.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: 'application/json' }));
        const a = el('a');
        a.href = url;
        // The user names the GPU when sending it (spec §8.4).
        a.download = `bench-${browserName()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      });
      panel.append(download);
    },
  };
}

/**
 * Mounts `?bench=medium` in `app`: the world page with the driver as its bench hook. A load that fails, or an unknown
 * `&shot=`, publishes `{ route, error }`, so measureChrome stops at once instead of polling for 15 minutes.
 */
export async function mountBenchRoute(app: HTMLElement, query: URLSearchParams): Promise<void> {
  const shotText = query.get('shot');
  const shot = shotText === null ? null : (BENCH_SHOTS as readonly string[]).includes(shotText) ? (shotText as BenchShot) : undefined;
  const panel = shot === null ? benchPanel() : null;
  let published = false;
  const publish: BenchPublish = {
    result(r) {
      published = true;
      window.__wiBench = { ...window.__wiBench, result: r };
      panel?.done(r);
    },
    shotReady() {
      window.__wiBench = { result: window.__wiBench?.result ?? null, shotReady: true };
    },
  };
  if (shot === undefined) {
    publish.result({ route: 'bench=medium', error: `unknown shot ${shotText}; one of ${BENCH_SHOTS.join(', ')}` });
    return;
  }
  const driver = createBenchDriver({ shot, publish });
  const { mountWorldPage } = await import('./worldPage');
  panel?.say(`running the ${BENCH_SECONDS} s script after the reveal (keep this tab in front)…`);
  const page = await mountWorldPage(app, benchQuery(query), benchHash(), { hud: false, overlay: false, bench: driver });
  if (page.state !== 'revealed' && !published) publish.result({ route: 'bench=medium', error: `the world did not load (page ${page.state})` });
}

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
 * 2b. then the live legs (SP4c spec §8.4, D22; `BENCH_LIVE`), through the page's own loop and its apply control with a
 *    scripted session and no map: L7 the edit `density.detailAmpHi` 1.5 → 4.0 (one urgent change), L8 its undo, L9 a
 *    teleport 20,000 blocks east through `teleport.ts`; each ends once settled (every column of the RD 12 MESH set
 *    revealed since its Apply, or the teleport's disc filled; `createLiveReveals`) or at its cap (20, 20, 15 s);
 * 2c. then the edit leg L10 (SP5a spec §6.2, D26; `BENCH_EDIT`) at L9's destination: a hover until the RD 12 disc is
 *    filled (at most 60 s), 100 block edits through the page's edit path one every 250 ms, and a closing 6 s flight
 *    east while the pool streams, with 20 more edits; their latency is the page's `editLatency.ts`;
 * 3. hands the driver the run's fixed figures (`done`); the driver publishes `summarizeBench`'s JSON as
 *    `window.__wiBench.result` (read by `measureChrome.ts --route bench`) and a "Download JSON" button (the Firefox
 *    cells, by hand).
 *
 * `&shot=<name>` (plan; spec §8.7, the review screenshots, taken by `measureChrome.ts --shot`): the script freezes at the
 * shot's moment, the camera drops to 32 blocks above the ground under it at pitch −20 (rulings R9), the page renders
 * three more frames and stops, and `window.__wiBench.shotReady` turns true; nothing is drawn over the world and no JSON
 * is published. SP5a's four review scenes (SP5a spec §6.5, `REVIEW_SHOTS`) run L10's hover edits, skip its flight,
 * build a fixed scene at its hover point through the page's edit path (`REVIEW_SITE`, `REVIEW_POOL`, `REVIEW_HOUSE`),
 * fix the clock (and walk) and hold the scene's pose; a scene the edit path refuses publishes `{ route, error }`.
 *
 * The world page imports this module's values; this module loads the page with a dynamic `import()`, so the two do not
 * import each other statically.
 */
import { discOffsets, type Stage } from '../../engine/rings';
import { medianInterval, percentile, snapFrameTime } from '../../render/frameTiming';
import type { GpuEstimate, WorldRenderer } from '../../render/renderer';
import type { RevealProbe, SectionRenderer, SectionRendererCounts, SectionRendererKind, StructuralKind } from '../../render/sectionRenderer';
import { el } from '../common/dom';
import { MIN_Y } from '../../core/constants';
import { MAX_Y } from '../../core/coords';
import { lookVector } from '../../player/fly';
import type { Edit } from '../../workers/protocol';
import {
  BRICKS, COBBLESTONE, GLASS, ICE, OAK_PLANKS, REGISTRY, RED_WOOL, STONE, TORCH, WHITE_WOOL,
} from '../../world/blocks';
import { LAVA_SOURCE, WATER_SOURCE } from '../../world/blocks/fluid';
import { DEFAULT_MAP_STATE, encodeMapState } from '../map/mapState';
import type { EditLatencySamples } from './editLatency';
import type { EditOutcome } from './editPath';
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
/**
 * The record's frames (SP5a spec §6.2): 95 s, the live legs at their caps (55 s) and L10 at its caps (91 s: the 60 s
 * hover, 25 s of edits and the 6 s flight) at 240 Hz is 241 s, 57,840 frames; 58,368 holds 243 s.
 */
export const BENCH_FRAME_CAPACITY = 58368;

export interface BenchLeg {
  readonly name: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'L10';
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

/**
 * The live legs after L6 (SP4c spec §8.4, D22): L7 sets `edit.path` from `from` (the default profile's) to `to` (one
 * urgent change), L8 undoes it, L9 teleports `teleportEast` blocks east of the camera at the same z; `maxS` is each
 * leg's cap, s. They hover at y 150 and pitch −15 (after L9's arrival, at the landing's y).
 */
export const BENCH_LIVE = {
  edit: { path: 'density.detailAmpHi', from: 1.5, to: 4.0 },
  maxS: { L7: 20, L8: 20, L9: 15 },
  teleportEast: 20000,
} as const;

/** L7-L9 as legs (`seconds` the cap): no flight and no RD step; they end on their own, not on a timeline. */
export const BENCH_LIVE_LEGS: readonly BenchLeg[] = [
  { name: 'L7', seconds: BENCH_LIVE.maxS.L7, speed: 0, headings: [], rdSteps: [] },
  { name: 'L8', seconds: BENCH_LIVE.maxS.L8, speed: 0, headings: [], rdSteps: [] },
  { name: 'L9', seconds: BENCH_LIVE.maxS.L9, speed: 0, headings: [], rdSteps: [] },
];

/**
 * The edit leg L10 (SP5a spec §6.2, D26), after L9 at its destination: a hover until the RD 12 disc is filled (L9's
 * `live.settled`), at most `hoverMaxS` s (a timeout ends the leg and is recorded); then `count` edits through the
 * page's edit path, one every `everyMs`, within `radius` blocks of the camera's block column on the surface, alternately
 * a stone placed and broken, every tenth a torch; then (plan) the streaming sample: a closing flight east at
 * `streamingSpeed` blocks/s for `streamingFlightS` s while the pool streams (L9 is a teleport that hovers), posting
 * `streamingCount` edits one every `everyMs` from its first second, each on a column within `radius` blocks whose
 * `editState` is 0.
 */
export const BENCH_EDIT = {
  count: 100, everyMs: 250, radius: 8, hoverMaxS: 60, streamingCount: 20, streamingFlightS: 6, streamingSpeed: 20,
} as const;

/** L10 as a leg (`seconds` its caps: the hover's, the edits' and the flight's); it ends on its own, not on a timeline. */
export const BENCH_EDIT_LEG: BenchLeg = {
  name: 'L10',
  seconds: BENCH_EDIT.hoverMaxS + (BENCH_EDIT.count * BENCH_EDIT.everyMs) / 1000 + BENCH_EDIT.streamingFlightS,
  speed: 0,
  headings: [],
  rdSteps: [],
};

/** Every leg, index = the record's `leg` (L0-L6 the timed script, L7-L9 the live legs, L10 the edit leg). */
const ALL_LEGS: readonly BenchLeg[] = [...BENCH_LEGS, ...BENCH_LIVE_LEGS, BENCH_EDIT_LEG];
/** The first live leg's index. */
const FIRST_LIVE = BENCH_LEGS.length;
/** L10's index. */
const EDIT_LEG = FIRST_LIVE + BENCH_LIVE_LEGS.length;

/** Each leg's start, s, and the timed script's length (95 s; the live legs follow it). */
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

/**
 * The per-frame fields, one preallocated column each (spec §8.3). SP4c's live legs (spec §8.4) add `tMs` (the script's
 * time, ms, written by the driver with `leg`), `mark` (1 on a live leg's Apply frame or teleport click) and
 * `revealed2`, `revealed4`, `revealedRd` (the columns within 2 columns of the camera's, of the RD 4 disc and of the live
 * RD's disc revealed since that mark), written by the page (`createLiveReveals`) before the recorder. SP5a (spec §6.2)
 * adds `playerMs`: the frame step's input, walk step and aim (the DDA, the queued clicks, the outline) on the bench's
 * clock, written by the page from the frame step's `timing` before the recorder; L10's `mainP95Ms` is its p95.
 */
export const BENCH_FIELDS = [
  'leg', 'rawMs', 'snappedMs', 'mainMs', 'coordinatorMs', 'uploadMs', 'rows', 'structuralKind', 'structuralMB', 'gpuMs', 'calls',
  'triangles', 'geometryMB', 'texturesMB', 'drawingBufferMB', 'heapMB', 'sabMB', 'partial', 'mixed', 'genCap',
  'tMs', 'mark', 'revealed2', 'revealed4', 'revealedRd', 'playerMs',
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

// ---------------------------------------------------------------- the live legs' reveals

/** "Near the player" for the first swap or reveal (spec §8.4, D24): within this many columns of the camera's, on both axes. */
export const LIVE_NEAR_COLUMNS = 2;
/** The disc of `applyNearMs` and `undoNearMs` (D24): RD 4, 69 columns, within 64 blocks of the camera. */
export const LIVE_NEAR_RD = 4;
/** The stamps' window: 25 × 25 columns around the camera, RD 12's disc and the ring slots every column of it maps to. */
const LIVE_WINDOW = 2 * BENCH_RD + 1;

/**
 * Which columns show the new epoch in a live leg (SP4c spec §8.4; plan): read through `sections.onColumnRevealed` into a
 * preallocated per-column stamp, the record's row of the column's last reveal, over a 25 × 25 ring of slots (column
 * (cx, cz) in slot (cx mod 25, cz mod 25), with its coordinates kept, so a column 25k columns away never counts as the
 * camera's). Every payload revealed at or after an Apply frame is the new epoch's (`staleReveals` 0 in R7), so a column
 * shows it once stamped at or after the leg's `mark`.
 */
export interface LiveReveals {
  /** The section renderer's `onColumnRevealed`: stamps the column with the record's current row. */
  revealed(cx: number, cz: number): void;
  /** The leg's mark (its Apply frame, or the teleport's click): reveals from this row on count; `record.mark` gets 1. */
  mark(): void;
  /** A leg's start: nothing counts until its mark. */
  reset(): void;
  /** Writes the row's counts around column (cx, cz), at the live RD `rd` (≤ 12), and updates `filled`. */
  count(cx: number, cz: number, rd: number): void;
  /** Writes zeros for the row (a teleport not yet arrived: the camera is still at the old place). */
  clear(): void;
  /** Whether the last `count` found every column of the RD disc revealed since the mark. */
  readonly filled: boolean;
}

export function createLiveReveals(rec: BenchRecord): LiveReveals {
  const n = LIVE_WINDOW;
  const half = (n - 1) / 2;
  const slotCx = new Int32Array(n * n);
  const slotCz = new Int32Array(n * n);
  const slotRow = new Float64Array(n * n).fill(-1);
  const slot = (cx: number, cz: number): number => (((cx % n) + n) % n) * n + (((cz % n) + n) % n);
  const nearLim = (LIVE_NEAR_RD + 0.5) * (LIVE_NEAR_RD + 0.5);
  let since = -1;
  let filled = false;
  const write = (n2: number, n4: number, nRd: number): void => {
    const i = rec.n;
    if (i >= rec.capacity) return;
    rec.revealed2[i] = n2;
    rec.revealed4[i] = n4;
    rec.revealedRd[i] = nRd;
  };
  return {
    revealed(cx, cz) {
      const s = slot(cx, cz);
      slotCx[s] = cx;
      slotCz[s] = cz;
      slotRow[s] = rec.n;
    },
    mark() {
      since = rec.n;
      filled = false;
      if (rec.n < rec.capacity) rec.mark[rec.n] = 1;
    },
    reset() {
      since = -1;
      filled = false;
    },
    count(cx, cz, rd) {
      if (since < 0) {
        filled = false;
        write(0, 0, 0);
        return;
      }
      const r = Math.min(rd, half);
      const lim = (r + 0.5) * (r + 0.5);
      let n2 = 0;
      let n4 = 0;
      let nRd = 0;
      let need = 0;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > lim) continue;
          need++;
          const x = cx + dx;
          const z = cz + dz;
          const s = slot(x, z);
          if (slotRow[s]! < since || slotCx[s] !== x || slotCz[s] !== z) continue;
          nRd++;
          if (d2 <= nearLim) n4++;
          if (Math.abs(dx) <= LIVE_NEAR_COLUMNS && Math.abs(dz) <= LIVE_NEAR_COLUMNS) n2++;
        }
      }
      filled = nRd === need;
      write(n2, n4, nRd);
    },
    clear() {
      filled = false;
      write(0, 0, 0);
    },
    get filled() {
      return filled;
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
  /** The coordinator's totals at the end of the script (`editDropped`: its edit MESHes dropped, SP5a spec §4.6). */
  readonly totals: { readonly dropped: number; readonly failed: number; readonly storeFull: number; readonly editDropped: number };
  /** From L5's start to the first frame whose RD 12 disc is revealed; null when L5 ended first. */
  readonly refillMs: number | null;
  /** The canvas's drawing buffer, px (SP4c spec §8.4: the live block's `width` and `height`). */
  readonly canvas: { readonly width: number; readonly height: number };
  /**
   * The page's edit latency at the end of the script (SP5a spec §6.2; `editLatency.ts`): its rings, oldest first, and
   * the `visible` samples recorded (more than the ring holds once it wrapped).
   */
  readonly edit: EditLatencySamples & { readonly count: number };
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

/**
 * The live legs' block (SP4c spec §8.4, D22, D24): SP4b's frame fields over L7-L9 and the Apply's, the undo's and the
 * teleport's times, ms, each from its leg's mark (L7's and L8's Apply frame, L9's click) to the first frame where:
 * a column within 2 columns of the camera's was revealed since (`*FirstSwapMs`, `teleportFirstRevealMs`), the 69
 * columns of the RD 4 disc were (`*NearMs`), every column of the live RD's MESH set was (`*FullMs`,
 * `teleportRefillMs`). A time its leg's cap cut short is null, and `timedOut` names each leg whose MESH set never
 * filled (a null D24 time fails the exit check). `width` and `height` are the canvas's.
 */
export type LiveFigures = StreamFigures & {
  readonly applyFirstSwapMs: number | null;
  readonly applyNearMs: number | null;
  readonly applyFullMs: number | null;
  readonly undoFirstSwapMs: number | null;
  readonly undoNearMs: number | null;
  readonly undoFullMs: number | null;
  readonly teleportFirstRevealMs: number | null;
  readonly teleportRefillMs: number | null;
  readonly width: number;
  readonly height: number;
  readonly timedOut: readonly string[];
  /**
   * Why L9's teleport never moved the camera (final review WLD-5): the landing's failure as `name: message`, or "the
   * teleport did not move the camera" for a teleport that resolved false with no cause; null when it arrived or never
   * ran. A null `teleportFirstRevealMs` beside it is the landing's, not the renderer's.
   */
  readonly teleportError: string | null;
};

/**
 * L10's block (SP5a spec §6.2, D26), ms: over the hover's edits, `editVisible*` from the post to the frame the edited
 * column's new mesh is shown (its first reveal after its edit's payload was staged), G2's sample size beside them
 * (`hoverAccepted` the hover's edits the sim accepted, `editSamples` the samples the `editVisible*` figures read: fewer
 * when an accepted edit never revealed; final review UI-6), `editAllVisibleP95` to the last dirty column's, the sim's `relightP95Ms` and `editP95Ms`, and the step budget (plan): `replyP95Ms` (post → the sim's
 * reply), `issueToStagedP95Ms` (reply → staged: the MESH job and its delivery), `stagedToShownP95Ms`; `editDropped` the
 * coordinator's edit MESHes dropped; `mainP95Ms` the p95 over L10's frames of their input, walk step, DDA, queued
 * clicks and outline time (`playerMs`; master §7's 0.3 ms); `editVisibleStreamingP95` over the closing flight's edits
 * and `streamingRefused` its refusals (not gated); `timedOut` ['L10'] when the hover's disc never filled; `frames`
 * SP4b's frame fields over L10. A figure with no sample is null.
 */
export interface EditFigures {
  readonly editVisibleP50: number | null;
  readonly editVisibleP95: number | null;
  readonly editVisibleMax: number | null;
  readonly hoverAccepted: number;
  readonly editSamples: number;
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
  readonly frames: StreamFigures;
}

/** What the driver knows of L10 (SP5a spec §6.2) and hands `summarizeBench`. */
export interface BenchEditRun {
  /**
   * The hover's edits the sim accepted: each opened one latency sample, all before the flight's (its last post is
   * 1.25 s before the flight's first), so they are the first `hoverAccepted` values of each ring (plan).
   */
  readonly hoverAccepted: number;
  /** The flight's edits refused, and its ticks that found no open column within 8 blocks. */
  readonly streamingRefused: number;
  /** ['L10'] when the hover's disc never filled within 60 s. */
  readonly timedOut: readonly string[];
}

/** No L10 (a run that ended before it). */
const NO_EDIT_RUN: BenchEditRun = { hoverAccepted: 0, streamingRefused: 0, timedOut: [] };

/** The bench's JSON (spec §8.3; SP4c spec §8.4's `live`; SP5a spec §6.2's `edit`). */
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
  /** L7-L9: the live legs (SP4c spec §8.4). */
  readonly live: LiveFigures;
  /** L10: the edit leg (SP5a spec §6.2). */
  readonly edit: EditFigures;
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

const legName = (i: number): string => ALL_LEGS[i]?.name ?? `L${i}`;

/** SP4b's stream figures over the rows `idx`: the frame figures, the GPU ms, the GPU estimate's peak, the memory. */
function streamFiguresOf(rec: BenchRecord, idx: readonly number[], fixed: BenchFixed): StreamFigures {
  const f = figuresOf(rec, idx);
  let peak = -1;
  let peakMB = Number.NaN;
  for (const i of idx) {
    const mb = rec.geometryMB[i]! + rec.texturesMB[i]! + rec.drawingBufferMB[i]!;
    if (peak < 0 || mb > peakMB) {
      peak = i;
      peakMB = mb;
    }
  }
  const gpu = finite(pick(rec.gpuMs, idx));
  const heap = finite(pick(rec.heapMB, idx));
  const sab = finite(pick(rec.sabMB, idx));
  return {
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
}

/** A live leg's three times (ms from its mark), null where the leg ended first or had no mark. */
interface LegTimes {
  first: number | null;
  near: number | null;
  full: number | null;
}

/** The disc sizes the live times wait for: the RD 4 disc (69) and the live RD's MESH set (489 at RD 12). */
const discSize = (rd: number): number => discOffsets(rd).length;

/**
 * A live leg's times over its rows `idx` (SP4c spec §8.4): from the first row marked 1 to the first row at or after it
 * whose `revealed2` is at least 1, whose `revealed4` reaches the RD 4 disc, and whose `revealedRd` reaches `fullOf`.
 */
function legTimes(rec: BenchRecord, idx: readonly number[], fullOf: number): LegTimes {
  const out: LegTimes = { first: null, near: null, full: null };
  const nearOf = discSize(LIVE_NEAR_RD);
  let m = -1;
  for (const i of idx) {
    if (m < 0) {
      if (rec.mark[i] !== 1) continue;
      m = i;
    }
    const dt = rec.tMs[i]! - rec.tMs[m]!;
    if (out.first === null && rec.revealed2[i]! >= 1) out.first = dt;
    if (out.near === null && rec.revealed4[i]! >= nearOf) out.near = dt;
    if (out.full === null && rec.revealedRd[i]! >= fullOf) out.full = dt;
  }
  return out;
}

/** The nearest-rank percentile `p` of `values`, null with none (JSON has no NaN). */
const percentileOrNull = (values: ArrayLike<number>, p: number): number | null => (values.length === 0 ? null : percentile(values, p));

/**
 * L10's block (SP5a spec §6.2) over its rows `idx`: the hover's figures from the first `run.hoverAccepted` values of
 * each latency ring, the streaming p95 from the `visible` values after them (BenchEditRun). A ring that wrapped (more
 * samples than it holds) has lost the hover's first ones, so it is refused.
 */
function editFiguresOf(rec: BenchRecord, idx: readonly number[], fixed: BenchFixed, run: BenchEditRun): EditFigures {
  const s = fixed.edit;
  if (s.count > s.visible.length) throw new Error(`summarizeBench: the edit latency's ring wrapped (${s.count} samples, ${s.visible.length} kept)`);
  const hover = (ring: Float64Array): Float64Array => ring.subarray(0, Math.min(run.hoverAccepted, ring.length));
  const visible = hover(s.visible);
  return {
    editVisibleP50: percentileOrNull(visible, 50),
    editVisibleP95: percentileOrNull(visible, 95),
    editVisibleMax: visible.length === 0 ? null : maxOf(visible),
    hoverAccepted: run.hoverAccepted,
    editSamples: visible.length,
    editAllVisibleP95: percentileOrNull(hover(s.allVisible), 95),
    relightP95Ms: percentileOrNull(hover(s.relight), 95),
    editP95Ms: percentileOrNull(hover(s.edit), 95),
    replyP95Ms: percentileOrNull(hover(s.reply), 95),
    issueToStagedP95Ms: percentileOrNull(hover(s.issueToStaged), 95),
    stagedToShownP95Ms: percentileOrNull(hover(s.stagedToShown), 95),
    editDropped: fixed.totals.editDropped,
    mainP95Ms: percentileOrNull(pick(rec.playerMs, idx), 95),
    editVisibleStreamingP95: percentileOrNull(s.visible.subarray(visible.length), 95),
    streamingRefused: run.streamingRefused,
    timedOut: [...run.timedOut],
    frames: streamFiguresOf(rec, idx, fixed),
  };
}

/**
 * The bench's JSON from its record and the fixed figures (spec §8.3): `stream` over L1-L6 (the streaming legs; L0's
 * hover only settles the first frames), the same frame figures per leg, L5's refill and L6's frames, `live` over L7-L9
 * (SP4c spec §8.4), `edit` over L10 with the driver's `editRun` (SP5a spec §6.2), every long frame and every structural
 * frame. `gpuMB` is the largest per-frame sum of the breakdown, which is reported at that frame. The live legs' MESH set
 * is the RD they ran at: 12, or the reservation's cap below it.
 */
export function summarizeBench(
  rec: BenchRecord,
  fixed: BenchFixed,
  teleportError: string | null = null,
  editRun: BenchEditRun = NO_EDIT_RUN,
): BenchResult {
  const all: number[] = [];
  const byLeg: number[][] = ALL_LEGS.map(() => []);
  for (let i = 0; i < rec.n; i++) {
    all.push(i);
    byLeg[rec.leg[i]!]?.push(i);
  }
  const stream = streamFiguresOf(rec, all.filter((i) => rec.leg[i]! >= 1 && rec.leg[i]! < FIRST_LIVE), fixed);

  const fullOf = discSize(fixed.rdClampedTo ?? BENCH_RD);
  const times = BENCH_LIVE_LEGS.map((_, k) => legTimes(rec, byLeg[FIRST_LIVE + k]!, fullOf));
  const [apply, undo, teleport] = times as [LegTimes, LegTimes, LegTimes];
  // A leg that ran and never filled its MESH set ended at its cap.
  const timedOut = BENCH_LIVE_LEGS.filter((_, k) => byLeg[FIRST_LIVE + k]!.length > 0 && times[k]!.full === null).map((l) => l.name);
  const live: LiveFigures = {
    ...streamFiguresOf(rec, all.filter((i) => rec.leg[i]! >= FIRST_LIVE && rec.leg[i]! < EDIT_LEG), fixed),
    applyFirstSwapMs: apply.first,
    applyNearMs: apply.near,
    applyFullMs: apply.full,
    undoFirstSwapMs: undo.first,
    undoNearMs: undo.near,
    undoFullMs: undo.full,
    teleportFirstRevealMs: teleport.first,
    teleportRefillMs: teleport.full,
    width: fixed.canvas.width,
    height: fixed.canvas.height,
    timedOut,
    teleportError,
  };

  const legs = Object.fromEntries(ALL_LEGS.map((l, k) => [l.name, figuresOf(rec, byLeg[k]!)])) as BenchResult['legs'];
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
    live,
    edit: editFiguresOf(rec, byLeg[EDIT_LEG]!, fixed, editRun),
    longFrames,
    structuralFrames,
  };
}

// ---------------------------------------------------------------- the driver

/** SP5a's review scenes (SP5a spec §6.5), built after L10 at its hover point. */
export const REVIEW_SHOTS = ['build-day', 'build-night', 'walk-water', 'glass-water'] as const;
export type ReviewShot = (typeof REVIEW_SHOTS)[number];

/**
 * The review shots (spec §8.7; plan; SP4c spec §8.7's four live ones; SP5a spec §6.5's four scenes), taken by
 * `measureChrome.ts --route bench --shot <name> --renderer <renderer>`.
 */
export const BENCH_SHOTS = [
  'fly96', 'fly384', 'rd12', 'rd8', 'rd12back', 'first', 'apply-before', 'apply-mid', 'apply-after', 'teleport', ...REVIEW_SHOTS,
] as const;
export type BenchShot = (typeof BENCH_SHOTS)[number];

/** The shots that freeze at a fixed script time. */
type TimedShot = Exclude<BenchShot, 'rd12back' | 'apply-mid' | 'apply-after' | 'teleport' | ReviewShot>;

const isReviewShot = (shot: BenchShot | null): shot is ReviewShot => shot !== null && (REVIEW_SHOTS as readonly string[]).includes(shot);

/**
 * The fixed shots' script times, s (plan): mid-L3 at 96 blocks/s; half a second into L4 at 384, while revealed terrain
 * is still ahead of the camera (by L4 + 1 s generation trails it and every revealed column lies behind, so the frame is
 * sky; rulings R12); half a second before L6's lowering (RD 12), a second after it (RD 8); `first` at the start, before
 * any pose is set (the first view after the reveal); `apply-before` half a second before L7 (SP4c spec §8.7), which
 * starts at the first frame at or after 95 s, the world still the first one.
 */
const SHOT_AT: Readonly<Record<TimedShot, number>> = {
  fly96: LEG_STARTS[3]! + 15,
  fly384: LEG_STARTS[4]! + 0.5,
  rd12: LEG_STARTS[6]! - 0.5,
  rd8: LEG_STARTS[6]! + 1,
  first: 0,
  'apply-before': BENCH_SECONDS - 0.5,
};
/** rd12back: the first frame after the RD is raised back (L6 + 5 s) at which the fog's RD is 12 again, else L6's end. */
const RD12BACK_FROM = LEG_STARTS[6]! + 5;
/** apply-mid: this long after L7's actual start (SP4c spec §8.7). */
const APPLY_MID_AFTER_S = 1;
/** teleport: this long after L9's arrival (SP4c spec §8.7). */
const TELEPORT_SHOT_AFTER_S = 0.3;
/** The frames rendered at the frozen pose before the shot is ready. */
const SHOT_FRAMES = 3;
/**
 * The review shots' camera (rulings R9; spec §8.7): at the frozen moment the camera drops to this many blocks above the
 * ground under it and looks down at this pitch, so the ground the view centre meets (about 88 blocks ahead) lies inside
 * RD 8's fog while the sky stays in the frame; the route's y 150 and pitch −15 show only sky and fog at RD 8.
 */
export const BENCH_SHOT_ABOVE = 32;
export const BENCH_SHOT_PITCH = -20;

// ---------------------------------------------------------------- the review scenes (SP5a spec §6.5)

/**
 * A review scene's voxel: its offset from the scene's anchor (L10's hover point: the camera's block column, at its
 * surface's first free y, `heightAt`) and its value (`state << 8 | fluid`). x grows east, z south; dy 0 is the first
 * layer above the ground.
 */
export type SceneVoxel = readonly [dx: number, dy: number, dz: number, value: number];

/** A voxel value of a state key (no fluid). */
const valueOf = (key: string): number => (REGISTRY.parseStateKey(key) << 8) >>> 0;
const blockValue = (state: number): number => (state << 8) >>> 0;

/**
 * The site (plan): the box cleared to air first, above the ground (dy 0 … 10), so the scene and the poses' eyes are
 * not buried in a hillside; the pool and the house are written over it.
 */
export const REVIEW_SITE = { dx0: -12, dx1: 10, dy0: 0, dy1: 10, dz0: -6, dz1: 11 } as const;

/**
 * The house (plan): 7 × 5 × 7 at dx 2 … 8, dy 0 … 4, dz −3 … 3. Its bottom layer a cobblestone base around a brick
 * floor; oak logs upright at the corners (axis y, dy 1 … 3), and at dy 4 the roof's edge beams along its north and
 * south edges (axis x) and its east and west edges (axis z), each running into one corner (a pinwheel: the south-west
 * and north-east corners axis x, the south-east and north-west axis z), so the build pose, from the south-west, sees an
 * axis-x beam's end face on the west wall's top and an axis-z beam's on the south wall's; oak-plank walls with a stripe
 * of red and white wool at dy 2, a glass window in the south wall (dx 4 … 6) and in the west wall facing the pool
 * (dz −1 … 1); a plank roof; a ladder up the north wall inside; wall torches inside on the east wall and outside on the
 * south and west walls. Outside: a ladder up the south wall at its east corner (dx 8, dy 0 … 2) and an upright log
 * stump beside it (dx 9, dz 4), whose top is the axis-y end face the build pose sees (the posts' tops are under the
 * beams), both on a cobblestone footing at dy −1 (rulings R55): the site clears only dy ≥ 0, so where the terrain is
 * lower than the anchor the sky would show under them.
 */
export const REVIEW_HOUSE: readonly SceneVoxel[] = (() => {
  const planks = blockValue(OAK_PLANKS);
  const glass = blockValue(GLASS);
  const stripe = [blockValue(RED_WOOL), blockValue(WHITE_WOOL)];
  const out: SceneVoxel[] = [];
  for (let dy = 0; dy <= 4; dy++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = 2; dx <= 8; dx++) {
        const edgeX = dx === 2 || dx === 8;
        const edgeZ = dz === -3 || dz === 3;
        let v: number;
        if (dy === 0) v = edgeX || edgeZ ? blockValue(COBBLESTONE) : blockValue(BRICKS);
        else if (dy === 4) {
          const alongX = edgeX && edgeZ ? (dx === 2) === (dz === 3) : edgeZ;
          v = alongX ? valueOf('oak_log[axis=x]') : edgeX ? valueOf('oak_log[axis=z]') : planks;
        } else if (edgeX && edgeZ) v = valueOf('oak_log[axis=y]');
        else if (!edgeX && !edgeZ) {
          // Inside: the ladder against the north wall, a torch on the east wall, air.
          if (dx === 5 && dz === -2) v = valueOf('ladder[facing=south]');
          else if (dx === 7 && dz === 0 && dy === 2) v = valueOf('wall_torch[facing=west]');
          else v = 0;
        } else if (dy === 2 && ((dz === 3 && dx >= 4 && dx <= 6) || (dx === 2 && dz >= -1 && dz <= 1))) v = glass;
        else if (dy === 2) v = stripe[(dx + dz) & 1]!;
        else v = planks;
        out.push([dx, dy, dz, v]);
      }
    }
  }
  // The outside torches, each against its wall.
  out.push([3, 3, 4, valueOf('wall_torch[facing=south]')], [7, 3, 4, valueOf('wall_torch[facing=south]')]);
  out.push([1, 3, -2, valueOf('wall_torch[facing=west]')], [1, 3, 2, valueOf('wall_torch[facing=west]')]);
  // The outside ladder up the south wall's east corner, and the log stump beside it.
  for (let dy = 0; dy <= 2; dy++) out.push([8, dy, 4, valueOf('ladder[facing=south]')]);
  out.push([9, 0, 4, valueOf('oak_log[axis=y]')]);
  // Their footing (rulings R55).
  out.push([8, -1, 4, blockValue(COBBLESTONE)], [9, -1, 4, blockValue(COBBLESTONE)]);
  return out;
})();

/**
 * The pool and the lava (plan): a 9 × 9 × 4 pit west of the house (dx −10 … −2, dy −4 … −1, dz −4 … 4) of bucket water
 * (still sources); its south side a glass wall (dz 5) with a trench of air dug beyond it (dz 6 … 9), so the glass shows
 * against the water from the trench's side (the aquarium); an ice block in the east rim (dx −1, dy −1, dz 0); and a
 * 3 × 3 pool of bucket lava in the ground south of the house (dx 4 … 6, dy −1, dz 6 … 8), which lights it at night.
 */
export const REVIEW_POOL: readonly SceneVoxel[] = (() => {
  const out: SceneVoxel[] = [];
  for (let dy = -4; dy <= -1; dy++) {
    for (let dx = -10; dx <= -2; dx++) {
      for (let dz = -4; dz <= 4; dz++) out.push([dx, dy, dz, WATER_SOURCE]);
      out.push([dx, dy, 5, blockValue(GLASS)]);
      for (let dz = 6; dz <= 9; dz++) out.push([dx, dy, dz, 0]);
    }
  }
  out.push([-1, -1, 0, blockValue(ICE)]);
  for (let dz = 6; dz <= 8; dz++) for (let dx = 4; dx <= 6; dx++) out.push([dx, -1, dz, LAVA_SOURCE]);
  return out;
})();

/** The house's centre, which the build shots look at. */
const HOUSE_CENTRE = [5.5, 2.5, 0.5] as const;
/** The build shots' view of the house: from the south-west, facing north-east, 12 blocks from its centre. */
const BUILD_YAW = 45;
const BUILD_PITCH = -20;
const BUILD_DISTANCE = 12;

/** The build shots' pose, relative to the anchor: `BUILD_DISTANCE` back from the house's centre along the look. */
const buildPose = (): BenchPose => {
  const [lx, ly, lz] = lookVector(BUILD_YAW, BUILD_PITCH);
  return {
    x: HOUSE_CENTRE[0] - BUILD_DISTANCE * lx, y: HOUSE_CENTRE[1] - BUILD_DISTANCE * ly, z: HOUSE_CENTRE[2] - BUILD_DISTANCE * lz,
    yaw: BUILD_YAW, pitch: BUILD_PITCH,
  };
};

/**
 * Each review scene's clock (hours, fixed and paused), mode and camera pose relative to the anchor (plan):
 * `build-day` the house from 12 blocks at noon; `build-night` the same at midnight, lit by its torches and the lava;
 * `walk-water` walking, the eye 0.25 above the pool's water at its west end, looking east across it to the house;
 * `glass-water` beyond the trench, looking down at the glass wall against the water, the ice in the rim beside it.
 */
export const REVIEW_SCENES: Readonly<Record<ReviewShot, { readonly hours: number; readonly walk: boolean; readonly pose: Readonly<BenchPose> }>> = {
  'build-day': { hours: 12, walk: false, pose: buildPose() },
  'build-night': { hours: 0, walk: false, pose: buildPose() },
  'walk-water': { hours: 12, walk: true, pose: { x: -8.5, y: 0.25, z: 0.5, yaw: 90, pitch: -8 } },
  'glass-water': { hours: 12, walk: false, pose: { x: -5.5, y: 1.5, z: 10.5, yaw: 0, pitch: -35 } },
};

/** The scene's edits per batch (plan): small batches, so each reply drains the sim's retired slots before the next. */
export const REVIEW_SCENE_BATCH = 64;
/** How long the posed scene renders before its three frozen frames (plan): its remesh and reveals land well within it. */
export const REVIEW_SETTLE_S = 2;

/**
 * The scene's edits at anchor (ax, ay, az) (plan): the site cleared, then the pool, then the house (a later voxel
 * replaces an earlier one), each a `set` whose `expect` is the voxel's value now (`read`), voxels already at their value
 * and voxels outside the world's height left out.
 */
export function reviewSceneEdits(ax: number, ay: number, az: number, read: (x: number, y: number, z: number) => number): Edit[] {
  const want = new Map<string, SceneVoxel>();
  const put = (b: SceneVoxel): void => { want.set(`${b[0]},${b[1]},${b[2]}`, b); };
  const s = REVIEW_SITE;
  for (let dy = s.dy0; dy <= s.dy1; dy++) for (let dz = s.dz0; dz <= s.dz1; dz++) for (let dx = s.dx0; dx <= s.dx1; dx++) put([dx, dy, dz, 0]);
  for (const b of REVIEW_POOL) put(b);
  for (const b of REVIEW_HOUSE) put(b);
  const edits: Edit[] = [];
  for (const [dx, dy, dz, value] of want.values()) {
    const x = ax + dx;
    const y = ay + dy;
    const z = az + dz;
    if (y < MIN_Y || y > MAX_Y) continue;
    const expect = read(x, y, z);
    if (expect !== value) edits.push({ x, y, z, op: 'set', value, expect });
  }
  return edits;
}

/** Where the driver's output goes: `window.__wiBench` and the panel in the page, a list in a test. */
export interface BenchPublish {
  result(r: BenchResult | BenchError): void;
  shotReady(): void;
}

/** A live leg's index in the record (SP4c spec §8.4). */
export type LiveLeg = 7 | 8 | 9;

/** What the page gives the driver once its world exists, before the script's first pose. */
export interface BenchWorld {
  /** The largest RD the store's reservation allows (`reservationRdCap`, capped at RD_MAX). */
  readonly rdMax: number;
  /** The ground's height at block column (x, z): the store's `motionBlocking` heightmap, null when not Published. */
  heightAt(x: number, z: number): number | null;
  /**
   * The live legs' hooks (SP4c spec §8.4): the page's scripted session (`set` an urgent change, `undo`), its teleport
   * (`teleport.go`; true once the camera moved; rejected with the landing's failure, kept as `live.teleportError`), and
   * whether a leg settled (every column of the live RD's MESH set
   * revealed since its Apply; L9's disc filled since the arrival).
   */
  readonly live: {
    set(path: string, v: number): void;
    undo(): void;
    teleport(x: number, z: number): Promise<boolean>;
    settled(leg: LiveLeg): boolean;
  };
  /**
   * L10's hooks (SP5a spec §6.2): the page's edit path (`editPath.ts`: its gate, the sim, the remesh and the latency)
   * and the coordinator's edit gate of a column (0 open, 1 not loaded, 2 regenerating).
   */
  readonly edit: {
    post(edits: readonly Edit[]): Promise<EditOutcome>;
    editState(cx: number, cz: number): 0 | 1 | 2;
    /** The voxel's value now (`state << 8 | fluid`, 0 where not Published): a review scene's `expect` (SP5a spec §6.5). */
    read(x: number, y: number, z: number): number;
  };
  /** The review scenes' clock (SP5a spec §6.5): fixed at `hours` (0 … 24) and paused. */
  setTime(hours: number): void;
  /** The review scenes' mode (SP5a spec §6.5): F's path (`toggleMode`, the near plane) when the mode differs. */
  walk(on: boolean): void;
}

/**
 * The world page's bench hook (`WorldPageOptions.bench`). The page calls `bind` once after the reveal, then `pose`
 * before each frame step, with the camera's current pose in `out` and the fog's RD; `pose` writes the script's pose
 * (the first call fixes the script's start where the camera is) and the frame's leg and time at `record.leg[record.n]`
 * and `record.tMs[record.n]` (and clears `record.mark` there), and returns the RD the script wants, never above `rdMax`
 * (Task 26b: a reservation cap below 12 clamps the script's RD steps, and `rdClampedTo` records the cap), which the page
 * applies live when it changes; null ends the script, and the page then calls `done`. After L6 (95 s) the live legs run
 * (SP4c spec §8.4): L7 calls `live.set` at its start, L8 `live.undo`, L9 `live.teleport(x + 20,000, z)` from the camera's
 * place; each ends when `live.settled(leg)` holds or at its cap. Then L10 (SP5a spec §6.2, `BENCH_EDIT`) posts its edits
 * through `edit.post` and flies east, and the script ends after it; a review scene's shot (SP5a spec §6.5) skips the
 * flight: once L10's posts have replied it posts the scene (`reviewSceneEdits` at the hover point) in batches of
 * `REVIEW_SCENE_BATCH`, each after the last's reply, then calls `setTime` (and `walk`), holds the scene's pose for
 * `REVIEW_SETTLE_S` and freezes there. In L7-L10 the pose keeps x, z and the yaw, sets the
 * pitch −15 and y 150 (after L9's arrival, the teleport's y); L10's flight sets x and the yaw 90. The page writes each
 * rendered frame into `record` (`createBenchRecorder`). `fail` ends the script with an error (a failure after the
 * reveal), once.
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
 * When a timed shot freezes at script time `tS`: the time to freeze the pose at, or null to go on (always null for the
 * live shots, which freeze on the live legs' events, and the review scenes, which freeze once built). rd12back waits for the fog back at the script's top RD (`topRd`:
 * 12, or the reservation's cap below it).
 */
function freezeTime(shot: BenchShot, tS: number, fogRd: number, topRd: number): number | null {
  if (shot === 'apply-mid' || shot === 'apply-after' || shot === 'teleport' || isReviewShot(shot)) return null;
  if (shot !== 'rd12back') return tS >= SHOT_AT[shot] ? SHOT_AT[shot] : null;
  if (tS >= BENCH_SECONDS) return BENCH_SECONDS;
  return tS >= RD12BACK_FROM && fogRd >= topRd ? tS : null;
}

/** A live leg's cap, s. */
const liveCap = (leg: LiveLeg): number => BENCH_LIVE_LEGS[leg - FIRST_LIVE]!.seconds;

/**
 * L10's columns around the camera's block column (plan): the (dx, dz) of the disc of radius `BENCH_EDIT.radius`,
 * nearest first; the edits take them in turn, so each place and each torch has a column of its own.
 */
const EDIT_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const r = BENCH_EDIT.radius;
  const out: Array<[number, number]> = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) out.push([dx, dz]);
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
})();
/** The voxel values L10 writes (SP5a spec §2.1: `state << 8 | fluid`). */
const STONE_VALUE = (STONE << 8) >>> 0;
const TORCH_VALUE = (TORCH << 8) >>> 0;
/** L10's interval between edits and its edits' span before the flight, s. */
const EDIT_EVERY_S = BENCH_EDIT.everyMs / 1000;
const EDITS_S = BENCH_EDIT.count * EDIT_EVERY_S;
/** L10's phases: the hover for the disc, the edits, the closing flight. */
const L10_HOVER = 0;
const L10_EDITS = 1;
const L10_FLIGHT = 2;
/** A review shot's phase after the edits, in place of the flight (SP5a spec §6.5). */
const L10_SCENE = 3;

export function createBenchDriver(o: { readonly shot: BenchShot | null; readonly capacity?: number; readonly publish: BenchPublish }): BenchDriver {
  const record = createBenchRecord(o.capacity ?? BENCH_FRAME_CAPACITY);
  const start = { x: 0, z: 0 };
  let started = false;
  let ended = false;
  // A timed shot's frozen script time (−1: none); a live shot frozen at the current place (SP4c spec §8.7).
  let frozenAt = -1;
  let frozenLive = false;
  let frozenFrames = 0;
  // The reservation's RD cap (none until `bind`) and the shot's lowered y (NaN: the route's pose).
  let rdMax = Number.POSITIVE_INFINITY;
  let heightAt: BenchWorld['heightAt'] | null = null;
  let live: BenchWorld['live'] | null = null;
  let shotY = Number.NaN;
  // The live legs (SP4c spec §8.4) and L10: the one running (0 before L7, 11 after L10), its start and L7's, s; L9's
  // arrival: `arrived` set by the teleport's promise, `arrivedS` the first pose after it (NaN before).
  let liveLeg = 0;
  let legStartS = 0;
  let l7StartS = Number.NaN;
  let arrived = false;
  let arrivedS = Number.NaN;
  // Why L9's teleport did not arrive (`live.teleportError`; final review WLD-5): null until it fails.
  let teleportError: string | null = null;
  // L10 (SP5a spec §6.2): its hooks (null until `bind`), its phase and the phase's start (s), the edits posted in the
  // phase, the next of EDIT_OFFSETS, the stone placed and not yet broken (x, y, z; y NaN for none), the flight's start
  // x, and what `summarizeBench` reads (BenchEditRun).
  let edit: BenchWorld['edit'] | null = null;
  let editPhase = L10_HOVER;
  let phaseS = 0;
  let editsPosted = 0;
  let nextOffset = 0;
  const placed = Float64Array.of(0, Number.NaN, 0);
  const at = new Float64Array(3);
  let flightX = 0;
  let hoverAccepted = 0;
  let streamingRefused = 0;
  let editTimedOut = false;
  // A review scene (SP5a spec §6.5): the shot, the page's clock and mode hooks, L10's posts not yet replied, the scene's
  // edits (null until built) and the next to post, its anchor, the time it was posed (NaN before), whether it froze,
  // and why it failed (null while it has not).
  const review = isReviewShot(o.shot) ? o.shot : null;
  let sceneHooks: Pick<BenchWorld, 'setTime' | 'walk'> | null = null;
  let pendingPosts = 0;
  let scene: Edit[] | null = null;
  let sceneNext = 0;
  const anchor = new Float64Array(3);
  let posedS = Number.NaN;
  let sceneFrozen = false;
  let sceneError: string | null = null;
  const capped = (rd: number): number => Math.min(rd, rdMax);

  /** The live legs' pose (SP4c spec §8.4): x, z and the yaw kept; pitch −15; y 150 until L9's arrival, then kept. */
  const livePose = (out: BenchPose): void => {
    if (!arrived) out.y = BENCH_Y;
    out.pitch = BENCH_PITCH;
  };
  /** The record's row for this frame: the leg, the script's time, no mark (the page marks an Apply or a click). */
  const writeRow = (leg: number, tS: number): void => {
    const n = record.n;
    if (n >= record.capacity) return;
    record.leg[n] = leg;
    record.tMs[n] = tS * 1000;
    record.mark[n] = 0;
  };
  /** Starts live leg `leg` at `tS` (its row already written): the edit, its undo or the teleport. */
  const startLeg = (leg: LiveLeg, tS: number, out: BenchPose): void => {
    const hooks = live!;
    if (leg === 7) {
      l7StartS = tS;
      hooks.set(BENCH_LIVE.edit.path, BENCH_LIVE.edit.to);
    } else if (leg === 8) hooks.undo();
    else {
      hooks.teleport(out.x + BENCH_LIVE.teleportEast, out.z).then((ok) => {
        if (ok) arrived = true;
        else teleportError = 'the teleport did not move the camera';
      }, (e: unknown) => {
        teleportError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      });
    }
  };
  /**
   * L10's next column around block (bx, bz) whose surface voxel (`heightAt`, the first free y) lies in the world and,
   * with `open`, whose column's `editState` is 0, written into `at` (x, y, z); false when no column of the disc is.
   */
  const nextColumn = (bx: number, bz: number, open: boolean): boolean => {
    for (let tries = 0; tries < EDIT_OFFSETS.length; tries++) {
      const off = EDIT_OFFSETS[nextOffset % EDIT_OFFSETS.length]!;
      nextOffset++;
      const x = bx + off[0];
      const z = bz + off[1];
      if (open && edit!.editState(x >> 4, z >> 4) !== 0) continue;
      const y = heightAt!(x, z);
      if (y === null || y > MAX_Y) continue;
      at[0] = x;
      at[1] = y;
      at[2] = z;
      return true;
    }
    return false;
  };
  /** Posts one voxel edit at (x, y, z); `onOutcome` sees whether the sim accepted it (a post that rejects did not). */
  const postEdit = (x: number, y: number, z: number, value: number, expect: number, onOutcome: (ok: boolean) => void): void => {
    pendingPosts++;
    edit!.post([{ x, y, z, op: 'set', value, expect }]).then((r) => {
      pendingPosts--;
      onOutcome(r.ok);
    }, () => {
      pendingPosts--;
      onOutcome(false);
    });
  };
  /** The outcomes of the hover's edits and of the flight's. */
  const accepted = (ok: boolean): void => { if (ok) hoverAccepted++; };
  const streamed = (ok: boolean): void => { if (!ok) streamingRefused++; };
  /**
   * The hover's edit k around the camera's block column (bx, bz): every tenth a torch on a new column; otherwise the
   * stone placed by the last stone edit broken back to air, or a stone placed on a new column (air expected: above
   * the surface no generated state but air collides or holds fluid).
   */
  const hoverEdit = (k: number, bx: number, bz: number): void => {
    if (k % 10 === 9) {
      if (nextColumn(bx, bz, false)) postEdit(at[0]!, at[1]!, at[2]!, TORCH_VALUE, 0, accepted);
    } else if (!Number.isNaN(placed[1]!)) {
      postEdit(placed[0]!, placed[1]!, placed[2]!, 0, STONE_VALUE, accepted);
      placed[1] = Number.NaN;
    } else if (nextColumn(bx, bz, false)) {
      placed.set(at);
      postEdit(at[0]!, at[1]!, at[2]!, STONE_VALUE, 0, accepted);
    }
  };
  /**
   * One frame of L10 at `tS` (SP5a spec §6.2), after `livePose`: the hover until L9's disc is filled (at most 60 s), the
   * edits one every 250 ms, then the closing flight east with its edits; false once it ends (timed out or flown).
   */
  const editStep = (tS: number, out: BenchPose): boolean => {
    if (editPhase === L10_HOVER) {
      if (!live!.settled(9)) {
        if (tS - legStartS < BENCH_EDIT.hoverMaxS) return true;
        editTimedOut = true;
        if (review !== null) sceneError = `the review scene was not built: L10's disc never filled within ${BENCH_EDIT.hoverMaxS} s`;
        return false;
      }
      editPhase = L10_EDITS;
      phaseS = tS;
      editsPosted = 0;
    }
    if (editPhase === L10_EDITS) {
      if (editsPosted < BENCH_EDIT.count) {
        if (tS - phaseS >= editsPosted * EDIT_EVERY_S) hoverEdit(editsPosted++, Math.floor(out.x), Math.floor(out.z));
        return true;
      }
      if (tS - phaseS < EDITS_S) return true;
      editPhase = review === null ? L10_FLIGHT : L10_SCENE;
      phaseS = tS;
      editsPosted = 0;
      flightX = out.x;
    }
    if (editPhase === L10_SCENE) return sceneStep(tS, out);
    const into = tS - phaseS;
    if (into >= BENCH_EDIT.streamingFlightS) return false;
    out.x = flightX + BENCH_EDIT.streamingSpeed * into;
    out.yaw = 90;
    // The streaming sample: from the flight's first second, each on a column whose 3 × 3 is open.
    if (editsPosted < BENCH_EDIT.streamingCount && into >= 1 + editsPosted * EDIT_EVERY_S) {
      editsPosted++;
      if (nextColumn(Math.floor(out.x), Math.floor(out.z), true)) {
        postEdit(at[0]!, at[1]!, at[2]!, STONE_VALUE, 0, streamed);
      } else streamingRefused++;
    }
    return true;
  };
  /** Writes the review scene's pose (relative to its anchor) into `out`. */
  const scenePose = (out: BenchPose): void => {
    const p = REVIEW_SCENES[review!].pose;
    out.x = anchor[0]! + p.x;
    out.y = anchor[1]! + p.y;
    out.z = anchor[2]! + p.z;
    out.yaw = p.yaw;
    out.pitch = p.pitch;
  };
  /**
   * One frame of a review scene at `tS` (SP5a spec §6.5), in place of L10's flight: once every post has replied, the
   * scene built at the camera's block column on its surface and posted batch by batch, each after the last's reply;
   * then the clock fixed (and the walk), the scene's pose held for `REVIEW_SETTLE_S`, and the shot frozen there
   * (`frozenLive`). False on a failure (`sceneError`): no surface, a refused or failed batch.
   */
  const sceneStep = (tS: number, out: BenchPose): boolean => {
    if (sceneError !== null) return false;
    if (pendingPosts > 0) return true;
    if (scene === null) {
      const bx = Math.floor(out.x);
      const bz = Math.floor(out.z);
      const y = heightAt!(bx, bz);
      if (y === null) {
        sceneError = `the review scene was not built: no surface at (${bx}, ${bz})`;
        return false;
      }
      anchor[0] = bx;
      anchor[1] = y;
      anchor[2] = bz;
      scene = reviewSceneEdits(bx, y, bz, (x, vy, z) => edit!.read(x, vy, z));
    }
    if (sceneNext < scene.length) {
      const batch = scene.slice(sceneNext, sceneNext + REVIEW_SCENE_BATCH);
      pendingPosts++;
      edit!.post(batch).then((r) => {
        pendingPosts--;
        if (r.ok) sceneNext += batch.length;
        else sceneError = `the review scene's edits were refused: ${r.why}`;
      }, (e: unknown) => {
        pendingPosts--;
        sceneError = `the review scene's edits failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
      });
      return true;
    }
    if (Number.isNaN(posedS)) {
      posedS = tS;
      const s = REVIEW_SCENES[review!];
      sceneHooks!.setTime(s.hours);
      if (s.walk) sceneHooks!.walk(true);
    }
    scenePose(out);
    if (tS - posedS >= REVIEW_SETTLE_S) frozenLive = sceneFrozen = true;
    return true;
  };
  /**
   * One frame of the live legs at `tS`: whether a leg ends (settled or at its cap) and the next starts, or the script
   * ends (false); a live shot freezes on its event (`frozenLive`).
   */
  const liveStep = (tS: number, out: BenchPose): boolean => {
    if (live === null) return false;
    if (arrived && Number.isNaN(arrivedS)) arrivedS = tS;
    let next: LiveLeg | 0 = 0;
    // L9 ended: L10 starts.
    let toEdit = false;
    if (liveLeg === 0) next = 7;
    else if (liveLeg >= 7 && liveLeg <= 9) {
      const leg = liveLeg as LiveLeg;
      if (live.settled(leg) || tS - legStartS >= liveCap(leg)) {
        // apply-after: L7's end, before the undo.
        if (leg === 7 && o.shot === 'apply-after') {
          frozenLive = true;
          return true;
        }
        if (leg === 9) toEdit = true;
        else next = (leg + 1) as LiveLeg;
      }
    } else if (liveLeg !== EDIT_LEG) return false;
    if (o.shot === 'apply-mid' && !Number.isNaN(l7StartS) && tS - l7StartS >= APPLY_MID_AFTER_S) frozenLive = true;
    if (o.shot === 'teleport' && !Number.isNaN(arrivedS) && tS - arrivedS >= TELEPORT_SHOT_AFTER_S) frozenLive = true;
    if (frozenLive) return true;
    livePose(out);
    if (next !== 0 || toEdit) {
      liveLeg = toEdit ? EDIT_LEG : next;
      legStartS = tS;
    }
    if (liveLeg === EDIT_LEG && !editStep(tS, out)) {
      liveLeg = EDIT_LEG + 1;
      return false;
    }
    writeRow(liveLeg, tS);
    if (next !== 0) startLeg(next, tS, out);
    return true;
  };

  return {
    record,
    get rdClampedTo() {
      return rdMax < BENCH_RD ? rdMax : null;
    },
    bind(world) {
      rdMax = world.rdMax;
      heightAt = (x, z) => world.heightAt(x, z);
      live = world.live;
      edit = world.edit;
      sceneHooks = { setTime: (h) => world.setTime(h), walk: (on) => world.walk(on) };
    },
    pose(tS, out, fogRd) {
      if (ended) return null;
      if (!started) {
        started = true;
        start.x = out.x;
        start.z = out.z;
      }
      if (o.shot !== null && frozenAt < 0 && !frozenLive) frozenAt = freezeTime(o.shot, tS, fogRd, capped(BENCH_RD)) ?? -1;
      if (frozenAt < 0 && !frozenLive) {
        if (tS < BENCH_SECONDS) {
          const r = benchPose(tS, start, out);
          writeRow(r.leg, tS);
          return capped(r.rd);
        }
        if (liveStep(tS, out) && !frozenLive) return capped(BENCH_RD);
        // The script ended: a live shot whose moment never came freezes here (the teleport failed, say); a review
        // scene that was not built publishes why instead of a shot of something else.
        if (!frozenLive) {
          if (o.shot === null) {
            ended = true;
            return null;
          }
          if (review !== null) {
            ended = true;
            o.publish.result({ route: 'bench=medium', error: sceneError ?? 'the review scene was not built' });
            return null;
          }
          frozenLive = true;
        }
      }
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
      let rd = BENCH_RD;
      // A review scene keeps its own pose.
      if (sceneFrozen) scenePose(out);
      else {
        if (frozenLive) livePose(out);
        else rd = benchPose(frozenAt, start, out).rd;
        // The shot's camera (rulings R9): the ground's height under the frozen pose, read once at the first frozen
        // frame and kept for the three; where it has no value (an unloaded column) the route's pose stays.
        if (frozenFrames === 0 && heightAt !== null) shotY = heightAt(Math.floor(out.x), Math.floor(out.z)) ?? Number.NaN;
        if (!Number.isNaN(shotY)) {
          out.y = shotY + BENCH_SHOT_ABOVE;
          out.pitch = BENCH_SHOT_PITCH;
        }
      }
      frozenFrames++;
      return capped(rd);
    },
    done(fixed) {
      ended = true;
      // A shot publishes no JSON: its script stopped early, and nothing may be drawn over the world.
      if (o.shot !== null) return;
      let result: BenchResult | BenchError;
      try {
        result = summarizeBench(record, fixed, teleportError, { hoverAccepted, streamingRefused, timedOut: editTimedOut ? ['L10'] : [] });
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
  const liveS = BENCH_LIVE_LEGS.reduce((t, l) => t + l.seconds, 0) + BENCH_EDIT_LEG.seconds;
  panel?.say(`running the ${BENCH_SECONDS} s script, the live legs and the edit leg (up to ${liveS} s more) after the reveal (keep this tab in front)…`);
  const page = await mountWorldPage(app, benchQuery(query), benchHash(), { hud: false, overlay: false, bench: driver });
  if (page.state !== 'revealed' && !published) publish.result({ route: 'bench=medium', error: `the world did not load (page ${page.state})` });
}

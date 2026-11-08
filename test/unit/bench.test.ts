import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CAVE_KIND, GENERATOR_VERSION } from '../../src/core/constants';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { hex64, parseHex64 } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import type { KV } from '../../src/persist/kv';
import { createMemoryKV } from '../../src/persist/memory';
import { decodeColumnDiff } from '../../src/persist/diffCodec';
import { loadParams, normalizeState, olderGenerator, parseWorldRecord, todayStateTable, type HistoryWrite } from '../../src/persist/saves';
import { discOffsets } from '../../src/engine/rings';
import { AIR, GLASS, ICE, REGISTRY, STONE, TORCH } from '../../src/world/blocks';
import { LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import type { CopiedMsg, Edit, EditedMsg, FlushedMsg } from '../../src/workers/protocol';
import type { ColumnDiff } from '../../src/world/store/api';
import { CLIPBOARD_KEY, decodeClipboard, encodeClipboard } from '../../src/persist/clipboard';
import type { RayHit } from '../../src/player/raycast';
import { EYE } from '../../src/player/walk';
import { MAX_STEP_EDITS } from '../../src/sim/edits';
import {
  BENCH_CAVE_ROUTE, BENCH_CAVES, BENCH_CAVES_LEG, BENCH_XRAY, BENCH_XRAY_LEG, BENCH_XRAY_SCRIPT, BENCH_EDIT, BENCH_FIELDS, BENCH_FRAME_CAPACITY, BENCH_IDLE_FRAMES, BENCH_LEGS, BENCH_LIVE, BENCH_LIVE_LEGS, BENCH_PITCH, BENCH_RD, BENCH_REFILL,
  BENCH_PASTE, BENCH_PASTE_LEG, BENCH_PASTE_PARTS, BENCH_PASTE_SCRIPT, BENCH_PROFILE, BENCH_SAVE, BENCH_SAVE_LEG, BENCH_SAVE_PARTS, BENCH_SEED, BENCH_SHOT_ABOVE, BENCH_SHOT_PITCH, BENCH_SHOTS, BENCH_TIME_SPEED, BENCH_Y, benchInterval, benchPose, createBenchDriver,
  createBenchRecord, createBenchRecorder, createLiveReveals, ENTER_AUTO_KEY, ENTER_AUTO_SETUP_PATH, ENTER_DENSE_COLUMNS, ENTER_DISC_RD, ENTER_PAIRS, ENTER_POSE, ENTER_SPARSE,
  enterAutoEnded, enterAutoJson, enterAutoRecorded, enterAutoStart, enterOrder as benchEnterOrder, enterPaths as benchEnterPaths, enterSaveDump, gpuOfRenderer, summarizeEnter, REVIEW_HOUSE, REVIEW_POOL, REVIEW_SCENE_BATCH, REVIEW_SCENES, REVIEW_SETTLE_S, REVIEW_SITE,
  REVIEW_SHOTS, benchHouse, caveRoute, createBenchSimLog, reviewSceneEdits, summarizeBench, type BenchCaveHooks, type BenchCaveRun, type BenchEditsRecord, type BenchError, type BenchFixed, type BenchFlush,
  type BenchPasteHooks, type BenchPasteRun, type BenchPose, type BenchRecord, type BenchResult, type BenchSaveRun, type BenchSources, type BenchWorld,
  type BenchXrayHooks, type BenchXrayRun, type ReviewShot, type SceneVoxel,
} from '../../src/ui/world/bench';
import { turnClipboard, turnedCell } from '../../src/ui/world/clipboard';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createEditPath, type EditOutcome } from '../../src/ui/world/editPath';
import type { Box } from '../../src/ui/world/pasteBatch';
import { pasteLitBlock, pasteMaxBlock } from '../../src/ui/world/pasteBlocks';
import { DEFAULT_MAP_STATE, openMapSession } from '../../src/ui/map/mapState';
import { parseWorldQuery } from '../../src/ui/world/query';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { BENCH_DB, benchCaves, benchXray, closeBenchSave, createBenchPaste, createBenchSave, enterResult, newWorldRecord, openBenchSave, type GhostHost } from '../../src/ui/world/worldPage';
import { ENTER_PAIRS as TOOL_ENTER_PAIRS, enterOrder as toolEnterOrder, enterPaths as toolEnterPaths, enterSummary, type EnterPair } from '../tools/measureChrome';

const START = { x: 1000, z: -2000 };
const HZ240 = 1000 / 240;

function pose(): BenchPose {
  return { x: Number.NaN, y: Number.NaN, z: Number.NaN, yaw: Number.NaN, pitch: Number.NaN };
}

/** benchPose at tS, its result copied (the result object is reused by the next call). */
function at(tS: number): BenchPose & { leg: number; rd: number } {
  const out = pose();
  const r = benchPose(tS, START, out);
  return { ...out, leg: r.leg, rd: r.rd };
}

describe('the bench script (SP4b spec §8.3, D22)', () => {
  test('the route\'s constants', () => {
    expect([BENCH_SEED, BENCH_RD, BENCH_Y, BENCH_PITCH, BENCH_TIME_SPEED, BENCH_IDLE_FRAMES]).toEqual(['42', 12, 150, -15, 60, 120]);
    expect(BENCH_FRAME_CAPACITY).toBeGreaterThan(95 * 240);
  });

  test('`BENCH_FRAME_CAPACITY` is 164,448 (SP6a spec §10.6: SP5c\'s 123,168, L13\'s 90 s and L14\'s 82 s at 240 Hz)', () => {
    expect(BENCH_FRAME_CAPACITY).toBe(164_448);
    expect(87_168 + 150 * 240).toBe(123_168);
    expect(123_168 + 90 * 240).toBe(144_768);
    expect(144_768 + 82 * 240).toBe(164_448);
  });

  test('the capacity holds the script\'s 683 s at 240 Hz (SP4c\'s 150 s, L10\'s 91 s at its caps, L11\'s four 30 s parts, L12\'s 150 s, L13\'s 90 s, L14\'s 82 s): 685 s', () => {
    expect(BENCH_EDIT).toEqual({ count: 100, everyMs: 250, radius: 8, hoverMaxS: 60, streamingCount: 20, streamingFlightS: 6, streamingSpeed: 20 });
    const liveS = BENCH_LIVE_LEGS.reduce((s, l) => s + l.seconds, 0);
    const l10S = BENCH_EDIT.hoverMaxS + (BENCH_EDIT.count * BENCH_EDIT.everyMs) / 1000 + BENCH_EDIT.streamingFlightS;
    const l11S = BENCH_SAVE_PARTS.length * BENCH_SAVE.partS;
    // L12's four caps after the fill (the fill is not counted, as L11's hover is not).
    const l12S = BENCH_PASTE.hoverS + BENCH_PASTE.houseMaxS + BENCH_PASTE.maxMaxS + BENCH_PASTE.sweepS;
    expect(BENCH_PASTE).toEqual({ fillMaxS: 60, hoverS: 10, houseMaxS: 80, maxMaxS: 50, sweepS: 10 });
    expect(l12S).toBe(150);
    expect(BENCH_PASTE_LEG).toEqual({ name: 'L12', seconds: l12S, speed: 0, headings: [], rdSteps: [] });
    // L13's caps: the find's 20 s, the flight's 10 s and the walk's 60 s.
    const l13S = BENCH_CAVES.findMaxS + BENCH_CAVES.flyMaxS + BENCH_CAVES.walkS;
    expect(BENCH_CAVES_LEG).toEqual({ name: 'L13', seconds: l13S, speed: 0, headings: [], rdSteps: [] });
    // L14's caps: the hold's 10 s, the sweep's 8 s, the band's 4 s, the map and the refill's 20 s, RD 16's 40 s.
    const l14S = BENCH_XRAY.holdS + BENCH_XRAY.sweepS + BENCH_XRAY.bandS + BENCH_XRAY.refillMaxS + BENCH_XRAY.rd16MaxS;
    expect(BENCH_XRAY_LEG).toEqual({ name: 'L14', seconds: l14S, speed: 0, headings: [], rdSteps: [] });
    expect([95 + liveS, l10S, l11S, l12S, l13S, l14S]).toEqual([150, 91, 120, 150, 90, 82]);
    expect(95 + liveS + l10S + l11S + l12S + l13S + l14S).toBe(683);
    expect(BENCH_FRAME_CAPACITY).toBeGreaterThanOrEqual(683 * 240);
    // 685 s at 240 Hz.
    expect(Math.floor(BENCH_FRAME_CAPACITY / 240)).toBe(685);
  });

  test('the capacity holds 150 s at 240 Hz (36,000 frames): the 95 s script and the live legs at their caps (SP4c spec §8.4)', () => {
    const liveS = BENCH_LIVE_LEGS.reduce((s, l) => s + l.seconds, 0);
    expect(95 + liveS).toBe(150);
    expect((95 + liveS) * 240).toBe(36_000);
    expect(BENCH_FRAME_CAPACITY).toBeGreaterThanOrEqual(36_000);
  });

  test('the legs sum to 95 s', () => {
    expect(BENCH_LEGS.map((l) => l.name)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(BENCH_LEGS.reduce((s, l) => s + l.seconds, 0)).toBe(95);
    expect(BENCH_LEGS.map((l) => [l.seconds, l.speed])).toEqual([[5, 0], [20, 20], [10, 20], [30, 96], [5, 384], [10, 0], [15, 0]]);
  });

  test('L1 flies 400 blocks east (benchPose at 25 s: x = start + 400)', () => {
    expect(BENCH_LEGS[1]!.headings).toEqual([90]);
    expect(at(5)).toMatchObject({ x: START.x, z: START.z, leg: 1 });
    expect(at(15)).toMatchObject({ x: START.x + 200, z: START.z, yaw: 90 });
    expect(at(25)).toMatchObject({ x: START.x + 400, z: START.z });
  });

  test('L2\'s four headings are 90° apart and the square closes (benchPose\'s x and z at 35 s equal those at 25 s; y and pitch unchanged)', () => {
    const h = BENCH_LEGS[2]!.headings;
    expect(h).toEqual([180, 270, 0, 90]);
    for (let i = 1; i < h.length; i++) expect((h[i]! - h[i - 1]! + 360) % 360).toBe(90);
    expect((h[0]! - BENCH_LEGS[1]!.headings[0]! + 360) % 360).toBe(90);
    // Heading 180 is south (+z), 270 west (−x), 0 north (−z), 90 east (+x); 2.5 s each at 20 blocks/s.
    expect(at(27.5)).toMatchObject({ x: START.x + 400, z: START.z + 50, yaw: 270 });
    expect(at(30)).toMatchObject({ x: START.x + 350, z: START.z + 50, yaw: 0 });
    expect(at(32.5)).toMatchObject({ x: START.x + 350, z: START.z, yaw: 90 });
    const a = at(25);
    const b = at(35);
    expect([b.x, b.z]).toEqual([a.x, a.z]);
    expect([b.y, b.pitch]).toEqual([a.y, a.pitch]);
  });

  test('L3 flies 2,880 and L4 1,920 blocks north (z at 65 s = start − 2,880, at 70 s = start − 4,800)', () => {
    expect(BENCH_LEGS[3]!.headings).toEqual([0]);
    expect(BENCH_LEGS[4]!.headings).toEqual([0]);
    expect(at(65)).toMatchObject({ x: START.x + 400, z: START.z - 2880, leg: 4 });
    expect(at(70)).toMatchObject({ x: START.x + 400, z: START.z - 4800, leg: 5 });
    // L5 and L6 hover where L4 stopped.
    expect(at(80)).toMatchObject({ x: START.x + 400, z: START.z - 4800 });
    expect(at(94.99)).toMatchObject({ x: START.x + 400, z: START.z - 4800 });
  });

  test('L6\'s RD is 8 from 80 s and 12 from 85 s', () => {
    expect(BENCH_LEGS[6]!.rdSteps).toEqual([{ atS: 0, rd: 8 }, { atS: 5, rd: 12 }]);
    expect([at(0).rd, at(50).rd, at(79.99).rd]).toEqual([12, 12, 12]);
    expect([at(80).rd, at(84.99).rd]).toEqual([8, 8]);
    expect([at(85).rd, at(94.99).rd]).toEqual([12, 12]);
  });

  test('y 150 and pitch −15 throughout', () => {
    for (let t = 0; t < 95; t += 0.25) {
      const p = at(t);
      expect([p.y, p.pitch], `at ${t} s`).toEqual([150, -15]);
    }
  });

  test('the yaw equals the heading and is kept while hovering; a leg covers [start, end)', () => {
    // L0 hovers facing L1's heading (plan): no heading was flown before it.
    expect(at(0)).toMatchObject({ leg: 0, yaw: 90 });
    expect(at(4.999)).toMatchObject({ leg: 0, yaw: 90 });
    expect(at(25)).toMatchObject({ leg: 2, yaw: 180 });
    expect(at(35)).toMatchObject({ leg: 3, yaw: 0 });
    expect(at(70)).toMatchObject({ leg: 5, yaw: 0 });
    expect(at(80)).toMatchObject({ leg: 6, yaw: 0 });
  });

  test('L5\'s refill window is [70, 80) s at RD 12', () => {
    expect(BENCH_REFILL).toEqual({ leg: 5, fromS: 70, toS: 80, rd: 12 });
  });

  test('the live legs (SP4c spec §8.4, D22): L7 the edit 1.5 → 4.0, L8 its undo, L9 20,000 blocks east; their caps 20, 20 and 15 s', () => {
    expect(BENCH_LIVE).toEqual({ edit: { path: 'density.detailAmpHi', from: 1.5, to: 4.0 }, maxS: { L7: 20, L8: 20, L9: 15 }, teleportEast: 20000 });
    expect(BENCH_LIVE_LEGS).toEqual([
      { name: 'L7', seconds: 20, speed: 0, headings: [], rdSteps: [] },
      { name: 'L8', seconds: 20, speed: 0, headings: [], rdSteps: [] },
      { name: 'L9', seconds: 15, speed: 0, headings: [], rdSteps: [] },
    ]);
    // The timed script still ends at 95 s: the live legs end on their own.
    expect(BENCH_LEGS.reduce((s, l) => s + l.seconds, 0)).toBe(95);
    // `from` is the route's profile's own value, so L7 is one change of 1.5 → 4.0.
    expect(resolveProfile('default').density.detailAmpHi).toBe(BENCH_LIVE.edit.from);
  });
});

// ---------------------------------------------------------------- the record and its summary

interface Frame {
  leg: number;
  /** The script's time, ms (default: the frame index × 1000/240). */
  tMs?: number;
  mark?: number;
  revealed2?: number;
  revealed4?: number;
  revealedRd?: number;
  snappedMs?: number;
  rawMs?: number;
  mainMs?: number;
  playerMs?: number;
  structuralKind?: number;
  structuralMB?: number;
  gpuMs?: number;
  geometryMB?: number;
  texturesMB?: number;
  drawingBufferMB?: number;
  partial?: number;
  mixed?: number;
  genCap?: number;
  calls?: number;
}

function recordOf(frames: readonly Frame[]): BenchRecord {
  const rec = createBenchRecord(frames.length + 4);
  for (const f of frames) {
    const i = rec.n++;
    rec.leg[i] = f.leg;
    rec.rawMs[i] = f.rawMs ?? f.snappedMs ?? HZ240;
    rec.snappedMs[i] = f.snappedMs ?? HZ240;
    rec.mainMs[i] = f.mainMs ?? 2;
    rec.coordinatorMs[i] = 0.2;
    rec.uploadMs[i] = 0.5;
    rec.rows[i] = 4;
    rec.structuralKind[i] = f.structuralKind ?? 0;
    rec.structuralMB[i] = f.structuralMB ?? 0;
    rec.gpuMs[i] = f.gpuMs ?? Number.NaN;
    rec.calls[i] = f.calls ?? 40;
    rec.triangles[i] = 1e6;
    rec.geometryMB[i] = f.geometryMB ?? 30;
    rec.texturesMB[i] = f.texturesMB ?? 10;
    rec.drawingBufferMB[i] = f.drawingBufferMB ?? 15.8;
    rec.heapMB[i] = 120;
    rec.sabMB[i] = 300;
    rec.partial[i] = f.partial ?? 0;
    rec.mixed[i] = f.mixed ?? 0;
    rec.genCap[i] = f.genCap ?? 5;
    rec.tMs[i] = f.tMs ?? i * HZ240;
    rec.mark[i] = f.mark ?? 0;
    rec.revealed2[i] = f.revealed2 ?? 0;
    rec.revealed4[i] = f.revealed4 ?? 0;
    rec.revealedRd[i] = f.revealedRd ?? 0;
    rec.playerMs[i] = f.playerMs ?? 0;
  }
  return rec;
}

const FIXED: BenchFixed = {
  seed: '42', profile: 'default', rd: 12, workers: 6, sectionRenderer: 'batch', userAgent: 'test', renderer: 'Iris', vendor: 'Intel',
  multiDraw: true, timerQuery: true, screen: { width: 1920, height: 1080 }, dpr: 1, pixelRatio: 1, displayIntervalMs: HZ240,
  load: { revealMs: 4000, stageMs: { T: 1000, D: 1500, L: 2000, MESH: 3000 }, longTasks: { count: 3, maxMs: 80 }, first120RenderedMaxMs: 8.3 },
  totals: { dropped: 2, failed: 0, storeFull: 0, editDropped: 0 },
  refillMs: 1234,
  rdClampedTo: null,
  canvas: { width: 1920, height: 1080 },
  edit: {
    visible: new Float64Array(0), allVisible: new Float64Array(0), reply: new Float64Array(0), issueToStaged: new Float64Array(0),
    stagedToShown: new Float64Array(0), relight: new Float64Array(0), edit: new Float64Array(0), count: 0,
  },
};

describe('summarizeBench (SP4b spec §8.3)', () => {
  test('every key of spec §8.3 is present', () => {
    const r = summarizeBench(recordOf([{ leg: 0 }, { leg: 1 }, { leg: 5 }, { leg: 6 }]), FIXED);
    expect(Object.keys(r)).toEqual([
      'route', 'seed', 'profile', 'rd', 'rdClampedTo', 'workers', 'sectionRenderer', 'userAgent', 'renderer', 'vendor', 'multiDraw', 'timerQuery', 'screen', 'dpr',
      'pixelRatio', 'displayIntervalMs', 'load', 'stream', 'legs', 'L5', 'L6', 'live', 'edit', 'persist', 'paste', 'caves', 'xray', 'longFrames',
      'structuralFrames',
    ]);
    expect(r.route).toBe('bench=medium');
    expect(r.rdClampedTo).toBeNull();
    expect(summarizeBench(recordOf([{ leg: 1 }]), { ...FIXED, rd: 10, rdClampedTo: 10 })).toMatchObject({ rd: 10, rdClampedTo: 10 });
    expect(Object.keys(r.load)).toEqual(['revealMs', 'stageMs', 'longTasks', 'first120RenderedMaxMs']);
    expect(r.load.first120RenderedMaxMs).toBe(8.3);
    expect(Object.keys(r.stream)).toEqual([
      'frames', 'main', 'coordinatorMs', 'uploadMs', 'rowsPerFrameMax', 'structuralOps', 'gpuMs', 'drawCalls', 'trianglesMax', 'gpuMB',
      'geometryMB', 'texturesMB', 'drawingBufferMB', 'heapMB', 'sabMB', 'partialColumnFrames', 'mixedColumnFrames', 'genCapMin', 'dropped',
      'failed', 'storeFull',
    ]);
    expect(Object.keys(r.stream.frames)).toEqual(['count', 'p50', 'p95', 'p99', 'max', 'over33']);
    expect(Object.keys(r.stream.main)).toEqual(['p50', 'p95', 'max']);
    expect(Object.keys(r.stream.coordinatorMs)).toEqual(['p95', 'max']);
    expect(Object.keys(r.stream.uploadMs)).toEqual(['p95', 'max']);
    expect(Object.keys(r.stream.drawCalls)).toEqual(['max', 'mean']);
    expect(Object.keys(r.legs)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13', 'L14']);
    expect(Object.keys(r.legs.L1.frames)).toEqual(['count', 'p50', 'p95', 'p99', 'max', 'over33']);
    expect(r.L5).toEqual({ refillMs: 1234 });
    expect(Object.keys(r.L6)).toEqual(['frames']);
    expect([r.stream.dropped, r.stream.failed, r.stream.storeFull]).toEqual([2, 0, 0]);
    // The JSON survives a round trip with every key.
    expect(Object.keys(JSON.parse(JSON.stringify(r)) as object)).toEqual(Object.keys(r));
  });

  test('`over33` counts a snapped 33.3 ms frame at 240 Hz (8 intervals) and not a 29.2 ms one (7); each long frame is listed', () => {
    const r = summarizeBench(recordOf([
      { leg: 1, mainMs: 1 },
      { leg: 1, snappedMs: 8 * HZ240, rawMs: 33.4, mainMs: 7 },
      { leg: 1, snappedMs: 7 * HZ240, mainMs: 3 },
      { leg: 3, snappedMs: 10 * HZ240, rawMs: 41.6, mainMs: 9 },
    ]), FIXED);
    expect(r.stream.frames.over33).toBe(2);
    expect(r.legs.L1.frames.over33).toBe(1);
    expect(r.legs.L3.frames.over33).toBe(1);
    expect(r.longFrames).toEqual([
      { frame: 1, leg: 'L1', rawMs: 33.4, snappedMs: 8 * HZ240, mainMs: 7, prevMainMs: 1 },
      { frame: 3, leg: 'L3', rawMs: 41.6, snappedMs: 10 * HZ240, mainMs: 9, prevMainMs: 3 },
    ]);
  });

  test('`stream` covers L1-L6: L0\'s frames are in its leg only', () => {
    const r = summarizeBench(recordOf([{ leg: 0, snappedMs: 50 * HZ240, calls: 500 }, { leg: 1 }, { leg: 6 }]), FIXED);
    expect(r.stream.frames.count).toBe(2);
    expect(r.stream.frames.max).toBe(HZ240);
    expect(r.stream.frames.over33).toBe(0);
    expect(r.stream.drawCalls.max).toBe(40);
    expect(r.legs.L0.frames.count).toBe(1);
    expect(r.legs.L0.frames.over33).toBe(1);
    expect(r.legs.L2.frames.count).toBe(0);
    expect(r.L6.frames.count).toBe(1);
  });

  test('`gpuMB` = the breakdown\'s sum at the frame where it peaks', () => {
    const r = summarizeBench(recordOf([
      { leg: 1, geometryMB: 30, texturesMB: 10, drawingBufferMB: 15.8 },
      { leg: 2, geometryMB: 52.5, texturesMB: 10.25, drawingBufferMB: 15.8 },
      { leg: 3, geometryMB: 40, texturesMB: 10, drawingBufferMB: 15.8 },
    ]), FIXED);
    expect(r.stream.gpuMB).toBe(52.5 + 10.25 + 15.8);
    expect([r.stream.geometryMB, r.stream.texturesMB, r.stream.drawingBufferMB]).toEqual([52.5, 10.25, 15.8]);
    expect(r.stream.gpuMB).toBe(r.stream.geometryMB + r.stream.texturesMB + r.stream.drawingBufferMB);
  });

  test('structural frames, the probe\'s frames, genCap, GPU ms', () => {
    const r = summarizeBench(recordOf([
      { leg: 1, structuralKind: 2, structuralMB: 3.5, mainMs: 4, gpuMs: 6, snappedMs: 2 * HZ240, genCap: 5 },
      { leg: 2, partial: 1, genCap: 3 },
      { leg: 2, partial: 2, mixed: 1, gpuMs: 4 },
      { leg: 3, structuralKind: 5, structuralMB: 12 },
    ]), FIXED);
    expect(r.stream.structuralOps).toBe(2);
    expect(r.structuralFrames).toEqual([
      { frame: 0, leg: 'L1', kind: 'grow', renderer: 'batch', MB: 3.5, mainMs: 4, gpuMs: 6, snappedMs: 2 * HZ240, nextSnappedMs: HZ240, stutterMs: 2 * HZ240 },
      { frame: 3, leg: 'L3', kind: 'compact', renderer: 'batch', MB: 12, mainMs: 2, gpuMs: null, snappedMs: HZ240, nextSnappedMs: null, stutterMs: HZ240 },
    ]);
    expect([r.stream.partialColumnFrames, r.stream.mixedColumnFrames, r.stream.genCapMin]).toEqual([2, 1, 3]);
    expect(r.stream.gpuMs).toEqual({ p50: 4, p95: 6, max: 6, samples: 2 });
    expect(summarizeBench(recordOf([{ leg: 1 }]), FIXED).stream.gpuMs).toBeNull();
  });

  test('a structural frame followed by a 40 ms frame has stutterMs 40 (the operation\'s cost lands in the next delta; G1 and §8.4\'s tuning read it)', () => {
    const r = summarizeBench(recordOf([
      { leg: 3, structuralKind: 2, structuralMB: 6, snappedMs: HZ240 },
      { leg: 3, snappedMs: 40 },
      { leg: 3, structuralKind: 1, snappedMs: 36 },
      { leg: 3, snappedMs: HZ240 },
    ]), FIXED);
    expect(r.structuralFrames.map((e) => [e.snappedMs, e.nextSnappedMs, e.stutterMs])).toEqual([[HZ240, 40, 40], [36, HZ240, 36]]);
  });
});

describe('summarizeBench: the live legs L7-L9 (SP4c spec §8.4, D22, D24)', () => {
  /** The RD 4 disc (69 columns) and the RD 12 MESH set (489). */
  const NEAR = 69;
  const FULL = 489;

  test('over a synthetic record with legs 7-9 `live` has every key, and SP4b\'s `stream` block still covers L1-L6 only', () => {
    const r = summarizeBench(recordOf([
      { leg: 1 }, { leg: 6 },
      { leg: 7, snappedMs: 50 * HZ240, calls: 900 }, { leg: 8 }, { leg: 9 },
    ]), FIXED);
    expect(Object.keys(r.live)).toEqual([
      'frames', 'main', 'coordinatorMs', 'uploadMs', 'rowsPerFrameMax', 'structuralOps', 'gpuMs', 'drawCalls', 'trianglesMax', 'gpuMB',
      'geometryMB', 'texturesMB', 'drawingBufferMB', 'heapMB', 'sabMB', 'partialColumnFrames', 'mixedColumnFrames', 'genCapMin', 'dropped',
      'failed', 'storeFull', 'applyFirstSwapMs', 'applyNearMs', 'applyFullMs', 'undoFirstSwapMs', 'undoNearMs', 'undoFullMs',
      'teleportFirstRevealMs', 'teleportRefillMs', 'width', 'height', 'timedOut', 'teleportError',
    ]);
    expect(r.live.teleportError).toBeNull();
    expect(Object.keys(r.live.frames)).toEqual(['count', 'p50', 'p95', 'p99', 'max', 'over33']);
    expect([r.live.width, r.live.height]).toEqual([1920, 1080]);
    // The live frames are L7-L9's; SP4b's stream block still covers L1-L6 only.
    expect(r.live.frames.count).toBe(3);
    expect(r.live.drawCalls.max).toBe(900);
    expect(r.stream.frames.count).toBe(2);
    expect(r.stream.frames.over33).toBe(0);
    expect(r.stream.drawCalls.max).toBe(40);
    expect([r.legs.L7.frames.count, r.legs.L8.frames.count, r.legs.L9.frames.count]).toEqual([1, 1, 1]);
    // Each leg's frames are listed under its name.
    expect(r.longFrames.map((f) => f.leg)).toEqual(['L7']);
    expect(Object.keys(JSON.parse(JSON.stringify(r)) as object)).toEqual(Object.keys(r));
  });

  test('`applyNearMs` is the time from L7\'s Apply frame to the frame the 69th RD 4 disc column was revealed; `applyFirstSwapMs` to the first within 2 columns; `applyFullMs` to the last MESH-set column', () => {
    const r = summarizeBench(recordOf([
      { leg: 6, tMs: 94_990, revealed2: 25, revealed4: NEAR, revealedRd: FULL },
      // L7 starts at 95 s; the Apply comes 200 ms later (the quiet window and the configure); nothing counts before it.
      { leg: 7, tMs: 95_000 },
      { leg: 7, tMs: 95_200, mark: 1 },
      { leg: 7, tMs: 95_300 },
      { leg: 7, tMs: 95_450, revealed2: 1, revealed4: 1, revealedRd: 1 },
      { leg: 7, tMs: 96_000, revealed2: 25, revealed4: NEAR - 1, revealedRd: 200 },
      { leg: 7, tMs: 96_100, revealed2: 25, revealed4: NEAR, revealedRd: 201 },
      { leg: 7, tMs: 99_000, revealed2: 25, revealed4: NEAR, revealedRd: FULL - 1 },
      { leg: 7, tMs: 99_500, revealed2: 25, revealed4: NEAR, revealedRd: FULL },
      // L8: the undo's Apply at 100 s.
      { leg: 8, tMs: 99_600 },
      { leg: 8, tMs: 100_000, mark: 1 },
      { leg: 8, tMs: 100_100, revealed2: 3, revealed4: 3, revealedRd: 3 },
      { leg: 8, tMs: 101_000, revealed2: 25, revealed4: NEAR, revealedRd: 300 },
      { leg: 8, tMs: 103_000, revealed2: 25, revealed4: NEAR, revealedRd: FULL },
      // L9: the teleport's click is its mark; the first column within 2 arrives 320 ms later.
      { leg: 9, tMs: 103_100, mark: 1 },
      { leg: 9, tMs: 103_420, revealed2: 1, revealed4: 1, revealedRd: 1 },
      { leg: 9, tMs: 107_100, revealed2: 25, revealed4: NEAR, revealedRd: FULL },
    ]), FIXED);
    expect(r.live.applyFirstSwapMs).toBeCloseTo(250, 9);
    expect(r.live.applyNearMs).toBeCloseTo(900, 9);
    expect(r.live.applyFullMs).toBeCloseTo(4300, 9);
    expect(r.live.undoFirstSwapMs).toBeCloseTo(100, 9);
    expect(r.live.undoNearMs).toBeCloseTo(1000, 9);
    expect(r.live.undoFullMs).toBeCloseTo(3000, 9);
    expect(r.live.teleportFirstRevealMs).toBeCloseTo(320, 9);
    expect(r.live.teleportRefillMs).toBeCloseTo(4000, 9);
    expect(r.live.timedOut).toEqual([]);
  });

  test('the full set follows the reservation\'s cap: under rdClampedTo 10 the MESH set is the RD 10 disc (349 columns)', () => {
    const rows = [{ leg: 7, tMs: 95_000, mark: 1 }, { leg: 7, tMs: 96_000, revealedRd: 349 }];
    expect(summarizeBench(recordOf(rows), FIXED).live.applyFullMs).toBeNull();
    expect(summarizeBench(recordOf(rows), { ...FIXED, rd: 10, rdClampedTo: 10 }).live.applyFullMs).toBe(1000);
  });

  test('a leg that hits its cap (20 s) records its time-outs as null and `live.timedOut` lists it', () => {
    const rows: Array<Parameters<typeof recordOf>[0][number]> = [
      { leg: 7, tMs: 95_000, mark: 1 },
      { leg: 7, tMs: 95_300, revealed2: 4, revealed4: 30, revealedRd: 30 },
      // 20 s later the leg ends at its cap: the RD 4 disc and the MESH set never filled.
      { leg: 7, tMs: 114_990, revealed2: 25, revealed4: NEAR - 2, revealedRd: FULL - 40 },
      { leg: 8, tMs: 115_000, mark: 1 },
      { leg: 8, tMs: 116_000, revealed2: 25, revealed4: NEAR, revealedRd: FULL },
      // L9's teleport never arrived: no column counted in 15 s.
      { leg: 9, tMs: 116_100, mark: 1 },
      { leg: 9, tMs: 131_090 },
    ];
    const r = summarizeBench(recordOf(rows), FIXED);
    expect(r.live.applyFirstSwapMs).toBeCloseTo(300, 9);
    expect([r.live.applyNearMs, r.live.applyFullMs]).toEqual([null, null]);
    expect([r.live.undoNearMs, r.live.undoFullMs]).toEqual([1000, 1000]);
    expect([r.live.teleportFirstRevealMs, r.live.teleportRefillMs]).toEqual([null, null]);
    expect(r.live.timedOut).toEqual(['L7', 'L9']);
    // A leg with no mark (its Apply never came) has no time at all.
    const noApply = summarizeBench(recordOf([{ leg: 7, tMs: 95_000, revealed2: 25, revealed4: NEAR, revealedRd: FULL }]), FIXED);
    expect([noApply.live.applyFirstSwapMs, noApply.live.applyNearMs, noApply.live.applyFullMs]).toEqual([null, null, null]);
    expect(noApply.live.timedOut).toEqual(['L7']);
  });

  test('`live.frames.over33` counts a snapped 33.3 ms frame at 240 Hz and not a 29.2 ms one (SP4b\'s rule over the live frames)', () => {
    const r = summarizeBench(recordOf([
      { leg: 6, snappedMs: 12 * HZ240 },
      { leg: 7, snappedMs: 8 * HZ240, rawMs: 33.4 },
      { leg: 8, snappedMs: 7 * HZ240 },
      { leg: 9, snappedMs: HZ240 },
    ]), FIXED);
    expect(r.live.frames.over33).toBe(1);
    expect(r.live.frames.max).toBeCloseTo(33.333, 3);
    expect(r.stream.frames.over33).toBe(1);
    expect(r.longFrames.map((f) => f.leg)).toEqual(['L6', 'L7']);
  });
});

describe('summarizeBench: the edit leg L10 (SP5a spec §6.2, D26)', () => {
  /** The page's latency rings: the hover's 4 accepted edits, then 2 of the flight's. */
  const EDIT: BenchFixed['edit'] = {
    visible: Float64Array.of(20, 30, 40, 50, 90, 70),
    allVisible: Float64Array.of(25, 35, 45, 55, 95, 75),
    reply: Float64Array.of(2, 3, 4, 5, 9, 9),
    issueToStaged: Float64Array.of(6, 7, 8, 11, 30, 30),
    stagedToShown: Float64Array.of(4, 5, 6, 8, 20, 20),
    relight: Float64Array.of(0.5, 1, 1.5, 2.5, 7, 7),
    edit: Float64Array.of(0.8, 1.2, 1.9, 3.1, 8, 8),
    count: 6,
  };

  test('over a synthetic record with an L10 `edit` has every key; SP4c\'s `live` block still covers L7-L9 only', () => {
    const r = summarizeBench(recordOf([
      { leg: 1 }, { leg: 7 }, { leg: 8 }, { leg: 9 },
      { leg: 10, snappedMs: 50 * HZ240, calls: 700 }, { leg: 10 }, { leg: 10 },
    ]), { ...FIXED, totals: { ...FIXED.totals, editDropped: 3 }, edit: EDIT }, null, { hoverAccepted: 4, streamingRefused: 1, timedOut: [] });
    expect(Object.keys(r.edit)).toEqual([
      'editVisibleP50', 'editVisibleP95', 'editVisibleMax', 'hoverAccepted', 'editSamples', 'editAllVisibleP95', 'relightP95Ms', 'editP95Ms',
      'replyP95Ms', 'issueToStagedP95Ms', 'stagedToShownP95Ms', 'editDropped', 'mainP95Ms', 'editVisibleStreamingP95', 'streamingRefused',
      'timedOut', 'frames',
    ]);
    // The hover's figures read its 4 samples (nearest rank), the streaming p95 the flight's 2.
    expect([r.edit.editVisibleP50, r.edit.editVisibleP95, r.edit.editVisibleMax, r.edit.editAllVisibleP95]).toEqual([30, 50, 50, 55]);
    // G2's sample size is published (final review UI-6): the hover's accepted edits and the samples its p95 read.
    expect([r.edit.hoverAccepted, r.edit.editSamples]).toEqual([4, 4]);
    expect([r.edit.relightP95Ms, r.edit.editP95Ms, r.edit.replyP95Ms, r.edit.issueToStagedP95Ms, r.edit.stagedToShownP95Ms]).toEqual([2.5, 3.1, 5, 11, 8]);
    expect([r.edit.editDropped, r.edit.mainP95Ms, r.edit.editVisibleStreamingP95, r.edit.streamingRefused]).toEqual([3, 0, 90, 1]);
    expect(r.edit.timedOut).toEqual([]);
    // SP4b's frame fields over L10's frames.
    expect(Object.keys(r.edit.frames)).toEqual(Object.keys(r.stream));
    expect([r.edit.frames.frames.count, r.edit.frames.frames.over33, r.edit.frames.drawCalls.max]).toEqual([3, 1, 700]);
    expect(r.legs.L10.frames.over33).toBe(1);
    // SP4c's live block still covers L7-L9 only, and the stream block L1-L6.
    expect(r.live.frames.count).toBe(3);
    expect([r.live.frames.over33, r.live.drawCalls.max]).toEqual([0, 40]);
    expect(r.stream.frames.count).toBe(1);
    expect(r.longFrames.map((f) => f.leg)).toEqual(['L10']);
    expect(Object.keys(JSON.parse(JSON.stringify(r)) as object)).toEqual(Object.keys(r));
    // No sample: the figures are null (JSON has no NaN); no L10 run: nothing timed out.
    const none = summarizeBench(recordOf([{ leg: 1 }]), FIXED);
    expect([none.edit.editVisibleP95, none.edit.editVisibleStreamingP95, none.edit.relightP95Ms]).toEqual([null, null, null]);
    expect([none.edit.streamingRefused, none.edit.timedOut]).toEqual([0, []]);
    expect([none.edit.hoverAccepted, none.edit.editSamples]).toEqual([0, 0]);
    expect(none.edit.mainP95Ms).toBeNull();
  });

  test('G2\'s sample size is published: 5 hover edits accepted but only 3 revealed before the flight\'s give `editSamples` 3, read by `editVisibleP95` (final review UI-6)', () => {
    // The hover's 3 revealed samples, no flight sample: a 3-sample p95 must not read like a 100-sample one.
    const short: BenchFixed['edit'] = {
      visible: Float64Array.of(20, 30, 40), allVisible: Float64Array.of(25, 35, 45), reply: Float64Array.of(2, 3, 4),
      issueToStaged: Float64Array.of(6, 7, 8), stagedToShown: Float64Array.of(4, 5, 6), relight: Float64Array.of(1, 1, 1),
      edit: Float64Array.of(1, 1, 1), count: 3,
    };
    const r = summarizeBench(recordOf([{ leg: 10 }]), { ...FIXED, edit: short }, null, { hoverAccepted: 5, streamingRefused: 0, timedOut: [] });
    expect([r.edit.hoverAccepted, r.edit.editSamples, r.edit.editVisibleP95]).toEqual([5, 3, 40]);
    const json = JSON.parse(JSON.stringify(r)) as { edit: { hoverAccepted: number; editSamples: number } };
    expect([json.edit.hoverAccepted, json.edit.editSamples]).toEqual([5, 3]);
  });

  test('a synthetic L10 whose frames carry main-thread timings reports their p95 as `edit.mainP95Ms`', () => {
    // 20 L10 frames timed 0.20 … 0.01 ms (nearest rank: the 19th smallest, 0.19); L9's slower frames are not L10's.
    const l10 = Array.from({ length: 20 }, (_, k) => ({ leg: 10, playerMs: (20 - k) / 100 }));
    const r = summarizeBench(recordOf([{ leg: 9, playerMs: 5 }, { leg: 9, playerMs: 7 }, ...l10]), { ...FIXED, edit: EDIT }, null, {
      hoverAccepted: 4, streamingRefused: 0, timedOut: [],
    });
    expect(r.edit.mainP95Ms).toBe(0.19);
    expect(r.edit.frames.frames.count).toBe(20);
  });
});

describe('summarizeBench: the save leg L11 (SP5b spec §6.2, D28)', () => {
  /** The parts' windows: script seconds [30i, 30i + 30), the page's clock 1,000 ms later; their latency samples [3i, 3i + 3). */
  const parts = [0, 1, 2, 3].map((i) => ({ tS0: 30 * i, tS1: 30 * i + 30, t0: 1000 + 30_000 * i, t1: 31_000 + 30_000 * i, samples0: 3 * i, samples1: 3 * i + 3 }));
  /** Twelve visible samples, three per part: p95 (nearest rank of 3: the largest) 40, 60, 40, 80. */
  const visible = Float64Array.of(20, 30, 40, 40, 50, 60, 20, 30, 40, 40, 60, 80);
  const EDIT: BenchFixed['edit'] = {
    visible, allVisible: visible, reply: visible, issueToStaged: visible, stagedToShown: visible, relight: visible, edit: visible, count: 12,
  };
  const long = 8 * HZ240;
  /** 20 frames of leg 11 in part i (script ms 30,000 i + 100 k), `longs` of them snapped over 33 ms. */
  const partFrames = (i: number, longs: number): Frame[] =>
    Array.from({ length: 20 }, (_, k) => ({ leg: 11, tMs: 30_000 * i + 100 * k, snappedMs: k < longs ? long : HZ240 }));
  const run = (o: Partial<BenchSaveRun> = {}): BenchSaveRun => ({ samplesFrom: 0, parts, edits: [], flushes: [], timedOut: [], ...o });
  const rec = (): BenchRecord => recordOf([...partFrames(0, 1), ...partFrames(1, 3), ...partFrames(2, 1), ...partFrames(3, 1)]);

  test('`over33Added`, `p95AddedMs` and `editVisibleAddedMs` from fixed parts (on 3 and 1 frames over 33 ms, off 1 and 1 → 2)', () => {
    const r = summarizeBench(rec(), { ...FIXED, edit: EDIT }, null, undefined, run());
    expect(Object.keys(r.persist)).toEqual([
      'L11a', 'L11b', 'L11c', 'L11d', 'flushSyncP95Ms', 'flushSyncMaxMs', 'flushCommitP95Ms', 'replyDuringFlushP95Ms', 'replyDuringFlushCount', 'flushMainP95Ms',
      'flushes',
      'over33Added', 'p95AddedMs', 'editVisibleAddedMs', 'timedOut',
    ]);
    expect(Object.keys(r.persist.L11a)).toEqual(['p95', 'p99', 'over33', 'editVisibleP95']);
    expect([r.persist.L11a.over33, r.persist.L11b.over33, r.persist.L11c.over33, r.persist.L11d.over33]).toEqual([1, 3, 1, 1]);
    // (3 + 1) − (1 + 1).
    expect(r.persist.over33Added).toBe(2);
    // Nearest rank of 20: the 19th smallest. L11b's 3 long frames reach it, the others' one does not.
    expect([r.persist.L11a.p95, r.persist.L11b.p95, r.persist.L11c.p95, r.persist.L11d.p95]).toEqual([HZ240, long, HZ240, HZ240]);
    expect([r.persist.L11a.p99, r.persist.L11b.p99]).toEqual([long, long]);
    expect(r.persist.p95AddedMs).toBeCloseTo((long + HZ240) / 2 - HZ240, 9);
    expect([r.persist.L11a.editVisibleP95, r.persist.L11b.editVisibleP95, r.persist.L11c.editVisibleP95, r.persist.L11d.editVisibleP95]).toEqual([40, 60, 40, 80]);
    // (60 + 80) / 2 − (40 + 40) / 2.
    expect(r.persist.editVisibleAddedMs).toBe(30);
    // No flush: the flush figures are null, and the count 0.
    expect([r.persist.flushSyncP95Ms, r.persist.flushCommitP95Ms, r.persist.replyDuringFlushP95Ms, r.persist.flushMainP95Ms, r.persist.flushes]).toEqual([null, null, null, null, 0]);
    expect(r.persist.replyDuringFlushCount).toBe(0);
    expect(r.persist.timedOut).toEqual([]);
    // The leg's own frame figures, and the JSON round trip.
    expect(r.legs.L11.frames.count).toBe(80);
    expect(Object.keys(JSON.parse(JSON.stringify(r)) as object)).toEqual(Object.keys(r));
    // A part with no sample: its `editVisibleP95` is null, and so is the difference.
    const none = summarizeBench(rec(), { ...FIXED, edit: EDIT }, null, undefined, run({ parts: parts.map((p, i) => (i === 3 ? { ...p, samples1: p.samples0 } : p)) }));
    expect([none.persist.L11d.editVisibleP95, none.persist.editVisibleAddedMs]).toEqual([null, null]);
  });

  test('the "on" parts\' flush figures: sync, commit and main-thread p95 over L11b\'s and L11d\'s flushes, and the replies of edits whose post → reply overlaps a flush', () => {
    const at = (part: number, ms: number): number => parts[part]!.t0 + ms;
    const flush = (tPost: number, o: Partial<BenchFlush> = {}): BenchFlush => ({ tPost, tDone: tPost + 10, ok: true, syncMs: 1, commitMs: 5, mainMs: 0.1, ...o });
    const flushes = [
      // The unmeasured flushNow before L11a, and one in an off part: neither counts.
      flush(500, { syncMs: 9, mainMs: 9 }), flush(at(2, 5000), { syncMs: 9, mainMs: 9 }),
      flush(at(1, 2000), { syncMs: 0.5, commitMs: 4, mainMs: 0.1 }),
      flush(at(1, 4000), { ok: false, syncMs: Number.NaN, commitMs: Number.NaN, mainMs: 0.2 }),
      flush(at(3, 2000), { syncMs: 1.5, commitMs: 6, mainMs: 0.25 }),
    ];
    const edits = [
      // In L11b, inside the first flush's window (2,000-2,010 ms): 3 ms; after it: not counted.
      { tPost: at(1, 2005), tReply: at(1, 2008) }, { tPost: at(1, 2500), tReply: at(1, 2501) },
      // In L11d, posted 2 ms before its flush, answered 2 ms into it: 4 ms.
      { tPost: at(3, 1998), tReply: at(3, 2002) },
      // In L11c (off), overlapping its flush: not counted.
      { tPost: at(2, 5001), tReply: at(2, 5009) },
    ];
    const r = summarizeBench(rec(), { ...FIXED, edit: EDIT }, null, undefined, run({ flushes, edits }));
    expect(r.persist.flushes).toBe(3);
    // Over the committed ones (0.5 and 1.5; nearest rank).
    expect([r.persist.flushSyncP95Ms, r.persist.flushSyncMaxMs, r.persist.flushCommitP95Ms]).toEqual([1.5, 1.5, 6]);
    expect(r.persist.flushMainP95Ms).toBe(0.25);
    expect(r.persist.replyDuringFlushP95Ms).toBe(4);
    // Its sample count (final review GOV-1): L11b's 3 ms and L11d's 4 ms.
    expect(r.persist.replyDuringFlushCount).toBe(2);
  });

  test('a full frame record is an error, not a truncated L11 (final review GOV-7): the driver publishes `{ error }`', () => {
    const frames = [...partFrames(0, 0), ...partFrames(1, 0)];
    // Rows to spare: summarised as usual.
    const roomy = recordOf(frames);
    expect(roomy.n).toBeLessThan(roomy.capacity);
    expect(() => summarizeBench(roomy, { ...FIXED, edit: EDIT }, null, undefined, run())).not.toThrow();
    // Every row used: the frames after it were dropped, so the parts' figures would read a cut part.
    const full = recordOf(frames);
    const exact = createBenchRecord(full.n);
    for (const f of BENCH_FIELDS) exact[f].set(full[f].subarray(0, full.n));
    exact.n = full.n;
    expect(() => summarizeBench(exact, { ...FIXED, edit: EDIT }, null, undefined, run())).toThrow(/^the bench's frame record is full \(40 frames\)/);
    // Through the driver: its `done` publishes the error in place of a JSON.
    const { driver, published } = driverOf(null);
    driver.record.n = driver.record.capacity;
    driver.done(FIXED);
    expect(published).toHaveLength(1);
    expect((published[0] as BenchError).error).toMatch(/frame record is full \(64 frames\)/);
  });

  test('L10\'s streaming p95 reads the samples before L11\'s (`samplesFrom`), not L11\'s', () => {
    const r = summarizeBench(recordOf([{ leg: 10 }]), { ...FIXED, edit: EDIT }, null, { hoverAccepted: 2, streamingRefused: 0, timedOut: [] }, run({ samplesFrom: 4 }));
    // L10's hover read 20 and 30, its flight 40 and 40; L11's 50 … 80 are not L10's.
    expect([r.edit.editVisibleP95, r.edit.editVisibleStreamingP95]).toEqual([30, 40]);
  });
});

// ---------------------------------------------------------------- the per-frame recorder

/**
 * A GPU timer whose draws the test makes (`draw()`, as `world.frame` would) and whose queries finish when the test says
 * (`finish(draw, ms)`); `drain` hands the finished ones over oldest first, as `createGpuTimer` does.
 */
function fakeTimer() {
  let draws = 0;
  const finished: Array<[number, number]> = [];
  return {
    draw: (): void => { draws++; },
    finish: (draw: number, ms: number): void => { finished.push([draw, ms]); },
    timer: {
      begin() {},
      end() {},
      poll: () => null,
      draws: () => draws,
      drain(sink: (draw: number, ms: number) => void) {
        finished.sort((a, b) => a[0] - b[0]);
        for (const [d, ms] of finished) sink(d, ms);
        finished.length = 0;
      },
    },
  };
}

function sources(over: { kind?: 'create' | 'grow' | 'instances' | 'optimize' | 'compact' | null; heap?: number } = {}): BenchSources & { heapReads: number; gpu: ReturnType<typeof fakeTimer> } {
  const MIB = 1 << 20;
  const gpu = fakeTimer();
  const s = {
    heapReads: 0,
    gpu,
    sections: {
      counts(out: Parameters<BenchSources['sections']['counts']>[0]) {
        out.lastStructural = over.kind ?? null;
        out.lastStructuralBytes = 3 * MIB;
        return out;
      },
      probe(out: Parameters<BenchSources['sections']['probe']>[0]) {
        out.columns = 10;
        out.partial = 1;
        out.mixed = 0;
        return out;
      },
    },
    world: {
      renderer: { info: { render: { calls: 42, triangles: 123_456 } } },
      gpuEstimate(out: Parameters<BenchSources['world']['gpuEstimate']>[0]) {
        out.sectionsBytes = 20 * MIB;
        out.skyBytes = 1 * MIB;
        out.textureBytes = 8 * MIB;
        out.lightmapBytes = 2 * MIB;
        out.drawingBufferBytes = 4 * MIB;
        return out;
      },
      gpuTimer: () => gpu.timer,
    },
    heapMB() {
      s.heapReads++;
      return over.heap ?? 100;
    },
    sabMB: () => 256,
  };
  return s;
}

describe('createBenchRecorder: one frame\'s fields, nothing allocated per frame (SP4b spec §8.3)', () => {
  test('writes every field at n, then n + 1; the breakdown grouped as geometry, textures, drawing buffer (plan)', () => {
    const rec = createBenchRecord(8);
    rec.leg[0] = 3;
    const src = sources({ kind: 'optimize' });
    const recorder = createBenchRecorder(rec, src, HZ240);
    src.gpu.draw();
    src.gpu.finish(0, 1.5);
    recorder.frame(8.4, 2.5, 0.3, 0.9, 12, 4);
    expect(rec.n).toBe(1);
    const row = Object.fromEntries(BENCH_FIELDS.map((f) => [f, rec[f][0]]));
    expect(row).toEqual({
      leg: 3, rawMs: 8.4, snappedMs: 2 * HZ240, mainMs: 2.5, coordinatorMs: 0.3, uploadMs: 0.9, rows: 12, structuralKind: 4,
      structuralMB: 3, gpuMs: 1.5, calls: 42, triangles: 123_456, geometryMB: 21, texturesMB: 10, drawingBufferMB: 4, heapMB: 100,
      sabMB: 256, partial: 1, mixed: 0, genCap: 4,
      // The script's time and the live legs' counts are the driver's and the page's, written before the recorder.
      tMs: 0, mark: 0, revealed2: 0, revealed4: 0, revealedRd: 0,
      // The frame step's input, walk step and aim, written by the page's timing before the recorder (SP5a spec §6.2).
      playerMs: 0,
    });
    src.gpu.draw();
    recorder.frame(HZ240, 1, 0, 0, 0, 4);
    expect([rec.n, rec.gpuMs[1], rec.structuralKind[1]]).toEqual([2, Number.NaN, 4]);
  });

  test('each GPU sample lands on the frame whose draw it timed, not on the frame that polled it (Task 26b, review M2)', () => {
    const rec = createBenchRecord(16);
    const src = sources();
    const recorder = createBenchRecorder(rec, src, HZ240);
    // Two draws before the first recorded frame (the warm-up, the reveal): their samples have no row.
    src.gpu.draw();
    src.gpu.draw();
    // Frame i's own draw is draw i + 2 (`world.frame` runs before the recorder). The queries finish later: at frame 2
    // draw 1 (no row) and draw 2 (row 0), at frame 3 draw 3 (row 1), at frame 5 draws 5 and 6 together (rows 3 and 4);
    // draw 4 (row 2) never finishes and draw 7 (row 5) is still pending.
    const finishAt: Record<number, Array<[number, number]>> = { 2: [[1, 99], [2, 10]], 3: [[3, 11]], 5: [[5, 13], [6, 14]] };
    for (let i = 0; i < 6; i++) {
      src.gpu.draw();
      for (const [d, ms] of finishAt[i] ?? []) src.gpu.finish(d, ms);
      recorder.frame(HZ240, 1, 0, 0, 0, 1);
    }
    expect(Array.from(rec.gpuMs.subarray(0, 6))).toEqual([10, 11, Number.NaN, 13, 14, Number.NaN]);
  });

  test('no structural operation records kind 0 and 0 MB', () => {
    const rec = createBenchRecord(2);
    createBenchRecorder(rec, sources(), HZ240).frame(HZ240, 1, 0, 0, 0, 1);
    expect([rec.structuralKind[0], rec.structuralMB[0]]).toEqual([0, 0]);
  });

  test('the JS heap and the SABs are sampled every 30 frames, the last sample carried between', () => {
    const rec = createBenchRecord(64);
    const src = sources();
    const recorder = createBenchRecorder(rec, src, HZ240);
    for (let i = 0; i < 61; i++) recorder.frame(HZ240, 1, 0, 0, 0, 1);
    expect(src.heapReads).toBe(3);
    expect(rec.heapMB[45]).toBe(100);
  });

  test('a full record takes no more frames', () => {
    const rec = createBenchRecord(2);
    const recorder = createBenchRecorder(rec, sources(), HZ240);
    for (let i = 0; i < 5; i++) recorder.frame(HZ240, 1, 0, 0, 0, 1);
    expect(rec.n).toBe(2);
  });
});

// ---------------------------------------------------------------- the driver

function driverOf(shot: (typeof BENCH_SHOTS)[number] | null) {
  const published: Array<BenchResult | BenchError> = [];
  let ready = 0;
  const driver = createBenchDriver({ shot, capacity: 64, publish: { result: (r) => published.push(r), shotReady: () => { ready++; } } });
  return { driver, published, ready: () => ready };
}

describe('createBenchDriver (the page\'s hook, SP4b spec §8.3)', () => {
  test('the script starts where the camera is, writes each frame\'s leg and time and, unbound (no live legs), ends after 95 s', () => {
    const { driver } = driverOf(null);
    const out: BenchPose = { x: 7, y: 80, z: -3, yaw: 12, pitch: 0 };
    expect(driver.pose(0, out, 12)).toBe(12);
    expect(out).toEqual({ x: 7, y: 150, z: -3, yaw: 90, pitch: -15 });
    expect(driver.record.leg[0]).toBe(0);
    driver.record.n = 1;
    expect(driver.pose(25, out, 12)).toBe(12);
    expect([out.x, out.z, driver.record.leg[1], driver.record.tMs[1]]).toEqual([407, -3, 2, 25_000]);
    expect(driver.pose(80, out, 12)).toBe(8);
    expect(driver.pose(95, out, 12)).toBeNull();
    expect(driver.pose(96, out, 12)).toBeNull();
  });

  test('done publishes the summary; fail publishes the error once', () => {
    const { driver, published } = driverOf(null);
    driver.done(FIXED);
    expect(published).toHaveLength(1);
    expect((published[0] as BenchResult).route).toBe('bench=medium');
    const f = driverOf(null);
    f.driver.fail('boom');
    f.driver.fail('again');
    expect(f.published).toEqual([{ route: 'bench=medium', error: 'boom' }]);
    expect(f.driver.pose(1, pose(), 12)).toBeNull();
  });

  test('a shot freezes the script at its time and is ready after three frames (fly96 at L3 + 15 s)', () => {
    const { driver, ready, published } = driverOf('fly96');
    const out: BenchPose = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    driver.pose(0, out, 12);
    driver.pose(49.9, out, 12);
    expect(out.z).toBeCloseTo(-14.9 * 96, 6);
    for (let i = 0; i < 3; i++) {
      expect(driver.pose(50.1 + i, out, 12)).toBe(12);
      expect([out.x, out.z]).toEqual([400, -15 * 96]);
    }
    expect(ready()).toBe(0);
    expect(driver.pose(53.2, out, 12)).toBeNull();
    expect(ready()).toBe(1);
    driver.done(FIXED);
    expect(published).toEqual([]);
  });

  test('rd8 at L6 + 1 s; rd12back once the fog is back at 12 after L6 + 5 s, else at L6\'s end', () => {
    const rd8 = driverOf('rd8');
    const o = pose();
    rd8.driver.pose(0, { ...o, x: 0, z: 0 }, 12);
    expect(rd8.driver.pose(81.02, o, 9)).toBe(8);
    const back = driverOf('rd12back');
    back.driver.pose(0, { ...o, x: 0, z: 0 }, 12);
    back.driver.pose(85.5, o, 10.5);
    back.driver.pose(86, o, 11.9);
    back.driver.pose(87, o, 12);
    back.driver.pose(87.1, o, 12);
    back.driver.pose(87.2, o, 12);
    expect(back.ready()).toBe(0);
    expect(back.driver.pose(87.3, o, 12)).toBeNull();
    expect(back.ready()).toBe(1);
    const late = driverOf('rd12back');
    late.driver.pose(0, { ...o, x: 0, z: 0 }, 12);
    for (const t of [94, 95.1, 95.2, 95.3]) expect(late.driver.pose(t, o, 11)).toBe(12);
    expect(late.driver.pose(95.4, o, 11)).toBeNull();
    expect(late.ready()).toBe(1);
  });

  test('a reservation cap below 12 clamps every RD the script wants to rdMax and records rdClampedTo (Task 26b, review M3)', () => {
    const { driver } = driverOf(null);
    expect(driver.rdClampedTo).toBeNull();
    driver.bind({ rdMax: 10, heightAt: () => null, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    expect(driver.rdClampedTo).toBe(10);
    const out = pose();
    const wants: number[] = [];
    for (let t = 0; t < 95; t += 0.05) wants.push(driver.pose(t, { ...out, x: 0, z: 0 }, 10)!);
    expect(Math.max(...wants)).toBe(10);
    // L6 still lowers to 8 and raises back, to the cap.
    expect([...new Set(wants)]).toEqual([10, 8]);
    expect(wants[Math.round(81 / 0.05)]).toBe(8);
    expect(wants[Math.round(90 / 0.05)]).toBe(10);
    // A cap at 12 or above clamps nothing.
    const free = driverOf(null);
    free.driver.bind({ rdMax: 16, heightAt: () => null, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    expect(free.driver.rdClampedTo).toBeNull();
    expect(free.driver.pose(10, pose(), 12)).toBe(12);
  });

  test('under a cap rd12back waits for the fog at the cap, and `first` asks for the cap', () => {
    const back = driverOf('rd12back');
    back.driver.bind({ rdMax: 10, heightAt: () => null, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    const o = pose();
    back.driver.pose(0, { ...o, x: 0, z: 0 }, 10);
    expect(back.driver.pose(85.5, o, 9.5)).toBe(10);
    for (const t of [86, 86.1, 86.2]) expect(back.driver.pose(t, o, 10)).toBe(10);
    expect(back.driver.pose(86.3, o, 10)).toBeNull();
    expect(back.ready()).toBe(1);
    const first = driverOf('first');
    first.driver.bind({ rdMax: 8, heightAt: () => null, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    expect(first.driver.pose(0, pose(), 8)).toBe(8);
  });

  test('a shot\'s three frames lower the camera to heightAt(floor x, floor z) + 32 at pitch −20, keeping x, z and yaw (rulings R9)', () => {
    expect([BENCH_SHOT_ABOVE, BENCH_SHOT_PITCH]).toEqual([32, -20]);
    const { driver, ready } = driverOf('fly96');
    const asked: Array<[number, number]> = [];
    driver.bind({ rdMax: 12, heightAt: (x, z) => { asked.push([x, z]); return 71; }, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    const out: BenchPose = { x: 0.5, y: 80, z: -0.25, yaw: 0, pitch: 0 };
    driver.pose(0, out, 12);
    // Before the shot's moment the route's pose holds.
    driver.pose(49.9, out, 12);
    expect([out.y, out.pitch]).toEqual([BENCH_Y, BENCH_PITCH]);
    expect(asked).toEqual([]);
    for (let i = 0; i < 3; i++) {
      driver.pose(50.1 + i, out, 12);
      expect(out).toEqual({ x: 400.5, y: 71 + 32, z: -0.25 - 15 * 96, yaw: 0, pitch: -20 });
    }
    expect(asked).toEqual([[400, -1441]]);
    expect(driver.pose(53.2, out, 12)).toBeNull();
    expect(ready()).toBe(1);
  });

  test('where heightAt has no value the shot keeps the route\'s pose; a run without a shot never lowers the camera', () => {
    const hole = driverOf('fly384');
    hole.driver.bind({ rdMax: 12, heightAt: () => null, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    const out: BenchPose = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    hole.driver.pose(0, out, 12);
    for (let i = 0; i < 3; i++) {
      hole.driver.pose(65.6 + i * 0.01, out, 12);
      expect([out.x, out.y, out.z, out.yaw, out.pitch]).toEqual([400, BENCH_Y, -2880 - 0.5 * 384, 0, BENCH_PITCH]);
    }
    const run = driverOf(null);
    run.driver.bind({ rdMax: 12, heightAt: () => 64, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    for (let t = 0; t < 95; t += 0.5) {
      run.driver.pose(t, out, 12);
      expect([out.y, out.pitch]).toEqual([BENCH_Y, BENCH_PITCH]);
    }
  });

  test('`first` keeps the first view after the reveal: the pose is not written', () => {
    const { driver, ready } = driverOf('first');
    const out: BenchPose = { x: 5, y: 90, z: 6, yaw: 33, pitch: -10 };
    for (let i = 0; i < 3; i++) expect(driver.pose(i / 60, out, 12)).toBe(BENCH_RD);
    expect(out).toEqual({ x: 5, y: 90, z: 6, yaw: 33, pitch: -10 });
    expect(driver.pose(0.05, out, 12)).toBeNull();
    expect(ready()).toBe(1);
  });
});

// ---------------------------------------------------------------- the live legs' reveals

describe('createLiveReveals: "shows the new epoch" from the reveals since a leg\'s mark (SP4c spec §8.4; plan)', () => {
  test('a column counts once revealed at or after the mark, within 2 columns, the RD 4 disc and the RD disc around the camera', () => {
    const rec = createBenchRecord(16);
    const live = createLiveReveals(rec);
    // Before any mark nothing counts.
    live.revealed(0, 0);
    live.count(0, 0, 12);
    expect([rec.revealed2[0], rec.revealed4[0], rec.revealedRd[0], live.filled]).toEqual([0, 0, 0, false]);
    rec.n = 1;
    // A reveal before the mark (row 1) and the mark in row 2: the earlier reveal does not count.
    live.revealed(1, 0);
    rec.n = 2;
    live.mark();
    expect(rec.mark[2]).toBe(1);
    live.revealed(0, 0);
    live.revealed(2, 2);
    live.revealed(3, 0);
    live.revealed(0, -4);
    live.revealed(12, 0);
    live.revealed(9, 9);
    live.count(0, 0, 12);
    // (0, 0), (2, 2) within 2; (3, 0), (0, −4) in the RD 4 disc too; (12, 0) in RD 12's; (9, 9) outside it (d² 162 > 156.25).
    expect([rec.revealed2[2], rec.revealed4[2], rec.revealedRd[2]]).toEqual([2, 4, 5]);
    expect(live.filled).toBe(false);
  });

  test('every column of the RD disc revealed since the mark fills it; a reveal far away in the same slot (1,250 columns off) does not count', () => {
    const rec = createBenchRecord(8);
    const live = createLiveReveals(rec);
    live.mark();
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) if (dx * dx + dz * dz <= 20.25 && !(dx === 1 && dz === 1)) live.revealed(100 + dx, 50 + dz);
    // The same ring slot as (101, 51), 1,250 columns east (a teleport of 20,000 blocks): not the camera's column.
    live.revealed(101 + 1250, 51);
    live.count(100, 50, 4);
    expect([rec.revealed4[0], rec.revealedRd[0], live.filled]).toEqual([68, 68, false]);
    live.revealed(101, 51);
    live.count(100, 50, 4);
    expect([rec.revealed2[0], rec.revealed4[0], rec.revealedRd[0], live.filled]).toEqual([25, 69, 69, true]);
  });

  test('reset forgets the mark (a leg\'s start); clear writes zeros (the teleport not arrived yet)', () => {
    const rec = createBenchRecord(8);
    const live = createLiveReveals(rec);
    live.mark();
    live.revealed(0, 0);
    live.count(0, 0, 4);
    expect(rec.revealed2[0]).toBe(1);
    live.reset();
    live.count(0, 0, 4);
    expect([rec.revealed2[0], live.filled]).toEqual([0, false]);
    live.mark();
    live.revealed(0, 0);
    live.clear();
    expect([rec.revealed2[0], rec.revealed4[0], rec.revealedRd[0], live.filled]).toEqual([0, 0, 0, false]);
  });
});

/** A fake of the page's live hooks: what the driver asked, and when each leg settles (`settle[leg] = true`). */
function fakeLive() {
  const calls: string[] = [];
  const settle: Record<7 | 8 | 9, boolean> = { 7: false, 8: false, 9: false };
  let arrive: ((ok: boolean) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const live: BenchWorld['live'] = {
    set: (path, v) => { calls.push(`set ${path} ${v}`); },
    undo: () => { calls.push('undo'); },
    teleport: (x, z) => {
      calls.push(`teleport ${x} ${z}`);
      return new Promise<boolean>((resolve, reject) => {
        arrive = resolve;
        fail = reject;
      });
    },
    settled: (leg) => settle[leg],
  };
  return { live, calls, settle, arrive: (ok = true) => arrive?.(ok), fail: (e: unknown) => fail?.(e) };
}

/**
 * A fake of the page's edit hooks (SP5a spec §6.2): every batch posted with the camera's block column at that moment
 * (`at`, set by the test), its outcome (`outcome`, accepted by default) and each `editState` asked.
 */
function fakeEdit(o: {
  state?: (cx: number, cz: number) => 0 | 1 | 2;
  outcome?: () => EditOutcome | undefined;
  read?: (x: number, y: number, z: number) => number;
} = {}) {
  const posts: Array<{ readonly edits: readonly Edit[] }> = [];
  const asked: Array<[number, number, number]> = [];
  const edit: BenchWorld['edit'] = {
    post: (edits) => {
      posts.push({ edits });
      return Promise.resolve(o.outcome?.() ?? { ok: true, prev: new Uint32Array(edits.length), next: new Uint32Array(edits.length) });
    },
    editState: (cx, cz) => {
      const s = o.state?.(cx, cz) ?? 0;
      asked.push([cx, cz, s]);
      return s;
    },
    read: (x, y, z) => o.read?.(x, y, z) ?? 0,
  };
  return { edit, posts, asked };
}

/** The review scenes' hooks of a run that takes no review shot (SP5a spec §6.5). */
const NO_SCENE: Pick<BenchWorld, 'setTime' | 'walk'> = { setTime() {}, walk() {} };

/** Lets the teleport's promise settle (its `then` runs in a microtask). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createBenchDriver: the live legs after L6 (SP4c spec §8.4, D22; plan)', () => {
  test('L7 sets the leaf to 4.0 at its start, L8 undoes, L9 asks the teleport for x + 20,000 at the same z; each ends when settled', async () => {
    const { driver } = driverOf(null);
    const f = fakeLive();
    driver.bind({ rdMax: 16, heightAt: () => null, live: f.live, edit: fakeEdit().edit, ...NO_SCENE });
    const out: BenchPose = { x: 7, y: 80, z: -3, yaw: 12, pitch: 0 };
    driver.pose(0, out, 12);
    driver.pose(94.99, out, 12);
    expect(f.calls).toEqual([]);
    // L6 ended where L4 stopped: (407, −4,803).
    expect([out.x, out.z]).toEqual([407, -4803]);
    driver.record.n = 5;
    expect(driver.pose(95.01, out, 12)).toBe(12);
    expect(f.calls).toEqual(['set density.detailAmpHi 4']);
    expect([driver.record.leg[5], driver.record.tMs[5], driver.record.mark[5]]).toEqual([7, 95_010, 0]);
    // While L7 runs the pose keeps x, z and yaw, at y 150 and pitch −15.
    out.yaw = 33;
    out.y = 120;
    driver.pose(96, out, 12);
    expect(out).toEqual({ x: 407, y: 150, z: -4803, yaw: 33, pitch: -15 });
    f.settle[7] = true;
    driver.record.n = 6;
    driver.pose(97, out, 12);
    expect(f.calls).toEqual(['set density.detailAmpHi 4', 'undo']);
    expect(driver.record.leg[6]).toBe(8);
    f.settle[8] = true;
    driver.record.n = 7;
    driver.pose(98, out, 12);
    expect(f.calls[2]).toBe('teleport 20407 -4803');
    expect(driver.record.leg[7]).toBe(9);
    // The teleport moves the camera (the page's fly) and resolves: from then on the pose keeps its y.
    out.x = 20407.5;
    out.z = -4802.5;
    out.y = 112;
    f.arrive();
    await flush();
    driver.pose(98.5, out, 12);
    expect(out).toEqual({ x: 20407.5, y: 112, z: -4802.5, yaw: 33, pitch: -15 });
    // L9 settles: L10 (SP5a spec §6.2) follows it at the same place, and the live hooks are not called again.
    f.settle[9] = true;
    driver.record.n = 8;
    expect(driver.pose(99, out, 12)).toBe(12);
    expect(driver.record.leg[8]).toBe(10);
    expect(out).toEqual({ x: 20407.5, y: 112, z: -4802.5, yaw: 33, pitch: -15 });
    expect(f.calls).toHaveLength(3);
  });

  test('a leg that never settles ends at its cap: L7 and L8 after 20 s, L9 after 15 s; before L9\'s arrival y stays 150', () => {
    const { driver } = driverOf(null);
    const f = fakeLive();
    driver.bind({ rdMax: 16, heightAt: () => null, live: f.live, edit: fakeEdit().edit, ...NO_SCENE });
    const out = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    driver.pose(0, out, 12);
    driver.pose(94.9, out, 12);
    driver.pose(95, out, 12);
    expect(f.calls).toEqual(['set density.detailAmpHi 4']);
    driver.pose(114.99, out, 12);
    expect(f.calls).toHaveLength(1);
    driver.pose(115, out, 12);
    expect(f.calls).toEqual(['set density.detailAmpHi 4', 'undo']);
    driver.pose(135, out, 12);
    expect(f.calls[2]).toBe('teleport 20400 -4800');
    out.y = 300;
    driver.pose(149.99, out, 12);
    expect(out.y).toBe(150);
    // L9's cap: L10 hovers for the disc (never filled here) up to its 60 s cap, and the script ends.
    expect(driver.pose(150, out, 12)).toBe(12);
    expect(driver.pose(209.99, out, 12)).toBe(12);
    expect(driver.pose(210, out, 12)).toBeNull();
  });

  test('under a reservation cap the live legs ask for the cap', () => {
    const { driver } = driverOf(null);
    driver.bind({ rdMax: 10, heightAt: () => null, live: fakeLive().live, edit: fakeEdit().edit, ...NO_SCENE });
    const out = pose();
    driver.pose(0, { ...out, x: 0, z: 0 }, 10);
    expect(driver.pose(96, out, 10)).toBe(10);
  });

  test('apply-before freezes at L7 − 0.5 s (94.5 s), before the edit; apply-mid at L7\'s start + 1 s', () => {
    const before = driverOf('apply-before');
    const fb = fakeLive();
    before.driver.bind({ rdMax: 16, heightAt: () => null, live: fb.live, edit: fakeEdit().edit, ...NO_SCENE });
    const o: BenchPose = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    before.driver.pose(0, o, 12);
    before.driver.pose(94.4, o, 12);
    for (const t of [94.51, 94.6, 94.7]) expect(before.driver.pose(t, o, 12)).toBe(12);
    expect(before.driver.pose(94.8, o, 12)).toBeNull();
    expect(before.ready()).toBe(1);
    expect(fb.calls).toEqual([]);

    const mid = driverOf('apply-mid');
    const fm = fakeLive();
    mid.driver.bind({ rdMax: 16, heightAt: () => null, live: fm.live, edit: fakeEdit().edit, ...NO_SCENE });
    mid.driver.pose(0, o, 12);
    // L7's actual start is the first frame at or after 95 s.
    mid.driver.pose(95.02, o, 12);
    mid.driver.pose(96.01, o, 12);
    expect(mid.ready()).toBe(0);
    for (const t of [96.03, 96.04, 96.05]) expect(mid.driver.pose(t, o, 12)).toBe(12);
    expect(mid.driver.pose(96.06, o, 12)).toBeNull();
    expect(mid.ready()).toBe(1);
    expect(fm.calls).toEqual(['set density.detailAmpHi 4']);
  });

  test('apply-after freezes at L7\'s end, before the undo; teleport 0.3 s after L9\'s arrival, the camera lowered over the new place', async () => {
    const after = driverOf('apply-after');
    const fa = fakeLive();
    after.driver.bind({ rdMax: 16, heightAt: () => 70, live: fa.live, edit: fakeEdit().edit, ...NO_SCENE });
    const o: BenchPose = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 };
    after.driver.pose(0, o, 12);
    after.driver.pose(95, o, 12);
    fa.settle[7] = true;
    for (let i = 0; i < 3; i++) {
      expect(after.driver.pose(100 + i / 60, o, 12)).toBe(12);
      expect([o.y, o.pitch]).toEqual([70 + BENCH_SHOT_ABOVE, BENCH_SHOT_PITCH]);
    }
    expect(after.driver.pose(100.1, o, 12)).toBeNull();
    expect(after.ready()).toBe(1);
    expect(fa.calls).toEqual(['set density.detailAmpHi 4']);

    const tp = driverOf('teleport');
    const ft = fakeLive();
    const asked: Array<[number, number]> = [];
    tp.driver.bind({ rdMax: 16, heightAt: (x, z) => { asked.push([x, z]); return 64; }, live: ft.live, edit: fakeEdit().edit, ...NO_SCENE });
    const p: BenchPose = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 };
    tp.driver.pose(0, p, 12);
    // L6's last frame: the camera hovers where L4 stopped, facing north.
    tp.driver.pose(94.9, p, 12);
    tp.driver.pose(95, p, 12);
    ft.settle[7] = true;
    tp.driver.pose(96, p, 12);
    ft.settle[8] = true;
    tp.driver.pose(97, p, 12);
    expect(ft.calls[2]).toBe('teleport 20400.5 -4799.5');
    tp.driver.pose(97.5, p, 12);
    p.x = 20400.5;
    p.z = -4799.5;
    p.y = 90;
    ft.arrive();
    await flush();
    // Arrived at the next frame (98 s): the shot 0.3 s later.
    tp.driver.pose(98, p, 12);
    tp.driver.pose(98.29, p, 12);
    expect(tp.ready()).toBe(0);
    for (let i = 0; i < 3; i++) {
      tp.driver.pose(98.31 + i / 60, p, 12);
      expect(p).toEqual({ x: 20400.5, y: 64 + BENCH_SHOT_ABOVE, z: -4799.5, yaw: 0, pitch: BENCH_SHOT_PITCH });
    }
    expect(asked).toEqual([[20400, -4800]]);
    expect(tp.driver.pose(98.5, p, 12)).toBeNull();
    expect(tp.ready()).toBe(1);
  });

  test('a live shot whose moment never comes freezes when the live legs end (the teleport failed: L9\'s cap)', async () => {
    const tp = driverOf('teleport');
    const f = fakeLive();
    tp.driver.bind({ rdMax: 16, heightAt: () => null, live: f.live, edit: fakeEdit().edit, ...NO_SCENE });
    const p = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    tp.driver.pose(0, p, 12);
    tp.driver.pose(95, p, 12);
    f.settle[7] = true;
    f.settle[8] = true;
    tp.driver.pose(96, p, 12);
    tp.driver.pose(97, p, 12);
    f.arrive(false);
    await flush();
    // L9's cap at 112 s, then L10's hover cap (the disc never fills) at 172 s.
    tp.driver.pose(112, p, 12);
    tp.driver.pose(171.99, p, 12);
    expect(tp.ready()).toBe(0);
    for (const t of [172, 172.01, 172.02]) expect(tp.driver.pose(t, p, 12)).toBe(12);
    expect(tp.driver.pose(172.03, p, 12)).toBeNull();
    expect(tp.ready()).toBe(1);
  });
});

describe('createBenchDriver: the edit leg L10 (SP5a spec §6.2, D26; plan)', () => {
  /** Runs the live legs (L7 and L8 settle at once) to L9's arrival at (20,000.5, 90, 0.5); L9 settles with `settled9`. */
  async function toL10(e: ReturnType<typeof fakeEdit>, settled9: boolean) {
    const run = driverOf(null);
    const f = fakeLive();
    f.settle[7] = true;
    f.settle[8] = true;
    f.settle[9] = settled9;
    run.driver.bind({ rdMax: 16, heightAt: () => 70, live: f.live, edit: e.edit, ...NO_SCENE });
    const p: BenchPose = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 };
    run.driver.pose(0, p, 12);
    run.driver.pose(95, p, 12);
    run.driver.pose(96, p, 12);
    run.driver.pose(97, p, 12);
    expect(f.calls[2]).toBe('teleport 20000.5 0.5');
    p.x = 20000.5;
    p.y = 90;
    f.arrive();
    await flush();
    return { ...run, p };
  }

  test('L10\'s script posts 100 edits 250 ms apart within 8 blocks, every tenth a torch, then 20 during its 6 s flight east, skipping a column whose `editState` is not 0', async () => {
    // Columns with an odd cx are not open (a 3 × 3 stale or not loaded); the last 3 posts are refused.
    let n = 0;
    const e = fakeEdit({ state: (cx) => ((cx & 1) === 0 ? 0 : 2), outcome: () => (++n > 117 ? { ok: false, why: 'regenerating' } : undefined) });
    const { driver, published, p } = await toL10(e, true);
    const stone = (STONE << 8) >>> 0;
    const torch = (TORCH << 8) >>> 0;
    // The hover: L9 settled, so the disc is filled and the edits start at L10's first frame, 98 s; one per 250 ms.
    for (let k = 0; k < 100; k++) {
      expect(driver.pose(98 + k * 0.25, p, 12)).toBe(12);
      expect(e.posts).toHaveLength(k + 1);
      driver.pose(98 + k * 0.25 + 0.2, p, 12);
      expect(e.posts).toHaveLength(k + 1);
    }
    // Hovering where L9 arrived, at its y.
    expect([p.x, p.y, p.z, p.pitch]).toEqual([20000.5, 90, 0.5, -15]);
    const hover = e.posts.map((b) => {
      expect(b.edits).toHaveLength(1);
      return b.edits[0]!;
    });
    // Alternately a stone placed on the surface (heightAt, air expected) and broken back to air; every tenth a torch.
    let placed: Edit | null = null;
    for (let k = 0; k < 100; k++) {
      const ed = hover[k]!;
      expect(ed.op).toBe('set');
      expect((ed.x - 20000) ** 2 + (ed.z - 0) ** 2).toBeLessThanOrEqual(64);
      if (k % 10 === 9) expect([ed.value, ed.expect, ed.y]).toEqual([torch, 0, 70]);
      else if (placed === null) {
        expect([ed.value, ed.expect, ed.y]).toEqual([stone, 0, 70]);
        placed = ed;
      } else {
        expect([ed.x, ed.y, ed.z, ed.value, ed.expect]).toEqual([placed.x, placed.y, placed.z, 0, stone]);
        placed = null;
      }
    }
    expect([torch, stone, 0].map((v) => hover.filter((ed) => ed.value === v).length)).toEqual([10, 45, 45]);
    // Each place and each torch on a column of its own; the hover asks no editState (its disc is filled).
    expect(new Set(hover.filter((ed) => ed.value !== 0).map((ed) => `${ed.x},${ed.z}`)).size).toBe(55);
    expect(e.asked).toEqual([]);
    // The closing flight: from 123 s (the edits' 25 s) east at 20 blocks/s; its edits from its first second.
    driver.pose(123, p, 12);
    expect([p.x, p.yaw, p.z]).toEqual([20000.5, 90, 0.5]);
    driver.pose(123.5, p, 12);
    expect(e.posts).toHaveLength(100);
    for (let j = 0; j < 20; j++) {
      const t = 124 + j * 0.25;
      expect(driver.pose(t, p, 12)).toBe(12);
      expect(p.x).toBe(20000.5 + 20 * (t - 123));
      expect(e.posts).toHaveLength(101 + j);
      const ed = e.posts[100 + j]!.edits[0]!;
      expect([ed.op, ed.value, ed.expect, ed.y]).toEqual(['set', stone, 0, 70]);
      expect((ed.x - Math.floor(p.x)) ** 2 + (ed.z - Math.floor(p.z)) ** 2).toBeLessThanOrEqual(64);
      expect((ed.x >> 4) & 1).toBe(0);
    }
    // Columns not open were asked and skipped.
    expect(e.asked.some(([, , s]) => s !== 0)).toBe(true);
    // The flight ends at 6 s, and with it the script.
    expect(driver.pose(128.99, p, 12)).toBe(12);
    expect(e.posts).toHaveLength(120);
    expect(driver.pose(129, p, 12)).toBeNull();
    await flush();
    driver.done(FIXED);
    const r = published[0] as BenchResult;
    expect([r.edit.timedOut, r.edit.streamingRefused]).toEqual([[], 3]);
  });

  test('a hover past 60 s records `edit.timedOut` [\'L10\'] and ends the leg with no edit', async () => {
    const e = fakeEdit();
    const { driver, published, p } = await toL10(e, false);
    // L9 never settles: its cap (15 s from 97 s) starts L10 at 112 s, whose hover waits for the disc up to 60 s.
    expect(driver.pose(112, p, 12)).toBe(12);
    expect(driver.pose(171.99, p, 12)).toBe(12);
    expect(driver.pose(172, p, 12)).toBeNull();
    expect(e.posts).toEqual([]);
    driver.done(FIXED);
    expect((published[0] as BenchResult).edit.timedOut).toEqual(['L10']);
  });
});

/**
 * A fake of the page's L11 hooks (SP5b spec §6.2): every batch posted with the script time `clock.t` the test sets, its
 * outcome accepted; each `pause`; each `flushNow` (settled at once); the page's clock and the latency count.
 */
function fakeSave(o: { filled?: () => boolean } = {}) {
  const posts: Array<{ readonly t: number; readonly edits: readonly Edit[] }> = [];
  const pauses: boolean[] = [];
  let flushNows = 0;
  const clock = { t: 0, ms: 0, samples: 0 };
  const save: NonNullable<BenchWorld['save']> = {
    post: (edits) => {
      posts.push({ t: clock.t, edits });
      return Promise.resolve({ ok: true, prev: Uint32Array.from(edits, (e) => e.expect), next: Uint32Array.from(edits, (e) => e.value) });
    },
    pause: (on) => { pauses.push(on); },
    flushNow: () => {
      flushNows++;
      return Promise.resolve(null);
    },
    filled: () => o.filled?.() ?? true,
    now: () => clock.ms,
    samples: () => clock.samples,
  };
  return { save, posts, pauses, clock, flushNows: () => flushNows };
}

/**
 * Runs the live legs (each settling at once) and L10 (its 100 edits, its 6 s flight east from L9's arrival at
 * (20,000.5, 90, 0.5)) with `save` bound, to L11's first frame at 129 s.
 */
async function toL11(save: NonNullable<BenchWorld['save']>, paste?: BenchPasteHooks, caves?: BenchCaveHooks, xray?: BenchXrayHooks) {
  const run = driverOf(null);
  const f = fakeLive();
  f.settle[7] = true;
  f.settle[8] = true;
  f.settle[9] = true;
  run.driver.bind({ rdMax: 16, heightAt: () => 70, live: f.live, edit: fakeEdit().edit, save, paste, caves, xray, ...NO_SCENE });
  const p: BenchPose = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 };
  run.driver.pose(0, p, 12);
  run.driver.pose(95, p, 12);
  run.driver.pose(96, p, 12);
  run.driver.pose(97, p, 12);
  p.x = 20000.5;
  p.y = 90;
  f.arrive();
  await flush();
  for (let k = 0; k < 124; k++) expect(run.driver.pose(98 + k * 0.25, p, 12)).toBe(12);
  expect(p.x).toBeGreaterThan(20000.5 + 100);
  // L10's flight ends at 129 s: with the save hooks bound, L11 starts there, the camera back at L10's hover point.
  expect(run.driver.pose(129, p, 12)).toBe(12);
  expect([p.x, p.y, p.z, p.pitch]).toEqual([20000.5, 90, 0.5, -15]);
  return { ...run, p };
}

describe('createBenchDriver: the save leg L11 (SP5b spec §6.2, D28; plan)', () => {
  test('the leg: its constants and its parts', () => {
    expect(BENCH_SAVE).toEqual({ hoverMaxS: 60, partS: 30, editsPerPart: 150, everyMs: 200, area: 4, torchEvery: 10 });
    expect(BENCH_SAVE_PARTS).toEqual([{ name: 'L11a', autosave: false }, { name: 'L11b', autosave: true }, { name: 'L11c', autosave: false }, { name: 'L11d', autosave: true }]);
    expect(BENCH_SAVE_LEG).toEqual({ name: 'L11', seconds: 180, speed: 0, headings: [], rdSteps: [] });
    // Hold-repeat's place rate (master §4.12: every 0.2 s): 150 edits fill a 30 s part.
    expect(BENCH_SAVE.editsPerPart * BENCH_SAVE.everyMs).toBe(BENCH_SAVE.partS * 1000);
  });

  test('L11\'s script has 600 edits in four 30 s parts at 0.2 s spacing over 16 columns, every tenth a torch; autosave paused in L11a and L11c, running in L11b and L11d', async () => {
    const s = fakeSave();
    const { driver, p, published } = await toL11(s.save);
    // The hover's first frame reads no disc (the camera is still where the flight ended); the next one finds it filled
    // and saves L1-L10's edits once, unmeasured, before any part starts.
    expect([s.flushNows(), s.posts.length, s.pauses.length]).toEqual([0, 0, 0]);
    expect(driver.pose(129.05, p, 12)).toBe(12);
    expect(s.flushNows()).toBe(1);
    expect(driver.pose(129.07, p, 12)).toBe(12);
    expect([s.posts.length, s.pauses.length]).toEqual([0, 0]);
    await flush();
    const t0 = 129.1;
    for (let i = 0; i < 2400; i++) {
      const t = t0 + i * 0.05;
      s.clock.t = t;
      expect(driver.pose(t, p, 12)).toBe(12);
      expect([p.x, p.z]).toEqual([20000.5, 0.5]);
    }
    s.clock.t = t0 + 120;
    expect(driver.pose(t0 + 120, p, 12)).toBeNull();
    expect(s.flushNows()).toBe(1);
    // Autosave off, on, off, on, then paused again at the end.
    expect(s.pauses).toEqual([true, false, true, false, true]);
    const edits = s.posts.map((b) => {
      expect(b.edits).toHaveLength(1);
      return b.edits[0]!;
    });
    expect(edits).toHaveLength(600);
    // 150 per part, 0.2 s apart from the part's start.
    for (let k = 0; k < 600; k++) {
      const part = Math.floor(k / 150);
      expect(s.posts[k]!.t - (t0 + 30 * part)).toBeCloseTo(0.2 * (k % 150), 6);
    }
    // Over the 4 × 4 columns around the hover point's column (1250, 0), on the surface (heightAt, the first free y).
    const cols = new Set(edits.map((e) => `${e.x >> 4},${e.z >> 4}`));
    expect(cols.size).toBe(16);
    for (const e of edits) {
      expect(e.x >> 4).toBeGreaterThanOrEqual(1248);
      expect(e.x >> 4).toBeLessThanOrEqual(1251);
      expect(e.z >> 4).toBeGreaterThanOrEqual(-2);
      expect(e.z >> 4).toBeLessThanOrEqual(1);
      expect([e.op, e.y]).toEqual(['set', 70]);
    }
    // Alternately a stone placed (air expected) and broken back to air; every tenth a torch, each on a voxel of its own.
    const stone = (STONE << 8) >>> 0;
    const torch = (TORCH << 8) >>> 0;
    let placed: Edit | null = null;
    for (let k = 0; k < 600; k++) {
      const e = edits[k]!;
      if (k % 10 === 9) expect([e.value, e.expect]).toEqual([torch, 0]);
      else if (placed === null) {
        expect([e.value, e.expect]).toEqual([stone, 0]);
        placed = e;
      } else {
        expect([e.x, e.y, e.z, e.value, e.expect]).toEqual([placed.x, placed.y, placed.z, 0, stone]);
        placed = null;
      }
    }
    expect([torch, stone, 0].map((v) => edits.filter((e) => e.value === v).length)).toEqual([60, 270, 270]);
    expect(new Set(edits.filter((e) => e.value !== 0).map((e) => `${e.x},${e.z}`)).size).toBe(330);
    // The leg's frames are leg 11; the published JSON has its four parts.
    driver.done(FIXED);
    const r = published[0] as BenchResult;
    expect(r.persist.timedOut).toEqual([]);
    expect(Object.keys(r.legs)).toContain('L11');
  });

  test('a disc that never fills within 60 s records `persist.timedOut` [\'L11\'] and ends the script with no flush and no edit', async () => {
    const s = fakeSave({ filled: () => false });
    const { driver, p, published } = await toL11(s.save);
    expect(driver.pose(188.99, p, 12)).toBe(12);
    expect(driver.pose(189, p, 12)).toBeNull();
    expect([s.flushNows(), s.posts.length, s.pauses.length]).toEqual([0, 0, 0]);
    driver.done(FIXED);
    expect((published[0] as BenchResult).persist.timedOut).toEqual(['L11']);
  });

  test('L11\'s "on" parts\' flushes post a non-null history whose `done` grows with the parts\' edits (ruling P11)', async () => {
    let t = 0;
    const posted: Edit[] = [];
    const flushes: Array<{ readonly t: number; readonly history: HistoryWrite | null; readonly steps: number }> = [];
    const ticks: Array<() => void> = [];
    const logged: BenchFlush[] = [];
    const saving = createBenchSave({
      worldId: 'b1',
      fly: { x: 20000.5, y: 90, z: 0.5, yaw: 90, pitch: -15, mode: 'fly', speed: 12 },
      frame: { t: 0.3 },
      edits: {
        post: (edits) => {
          posted.push(...edits);
          return Promise.resolve({ ok: true, prev: Uint32Array.from(edits, (e) => e.expect), next: Uint32Array.from(edits, (e) => e.value) });
        },
        pending: () => false,
        settled: () => Promise.resolve(),
        bulkPending: () => false,
      },
      read: () => 0,
      sim: {
        flush: (_state, history) => {
          flushes.push({ t, history, steps: posted.length });
          return Promise.resolve({ type: 'flushed', id: flushes.length, ok: true, flushSeq: flushes.length, columns: 1, bytes: 9, syncMs: 0.2, commitMs: 3 });
        },
      },
      clock: {
        now: () => t * 1000,
        setInterval: (f) => ticks.push(f),
        clearInterval() {},
        setTimeout: () => 0,
        clearTimeout() {},
      },
      now: () => t * 1000,
      wallNow: () => 1_800_000_000_000 + t * 1000,
      filled: () => true,
      samples: () => 0,
      flushed: (f) => { logged.push(f); },
      flushPosted() {},
      ticked() {},
    });
    expect(ticks).toHaveLength(1);
    const { driver, p } = await toL11(saving.hooks);
    driver.pose(129.05, p, 12);
    await flush();
    // The unmeasured flushNow: nothing recorded yet (L10 posts around the history), so no history.
    expect(flushes).toEqual([{ t: 0, history: null, steps: 0 }]);
    const t0 = 129.1;
    for (let i = 0; i < 2400; i++) {
      t = t0 + i * 0.05;
      driver.pose(t, p, 12);
      // The autosave's 2,000 ms timer, after the posts' replies were recorded.
      if (i % 40 === 39) {
        await flush();
        ticks[0]!();
        await flush();
      }
    }
    const inPart = (f: { t: number }, k: number): boolean => f.t >= t0 + 30 * k && f.t < t0 + 30 * (k + 1);
    // Paused in L11a and L11c: their ticks post nothing.
    expect(flushes.filter((f) => inPart(f, 0) || inPart(f, 2))).toEqual([]);
    for (const k of [1, 3]) {
      const on = flushes.filter((f) => inPart(f, k));
      expect(on.length).toBeGreaterThanOrEqual(14);
      let last: string | null = null;
      for (const f of on) {
        // Every step of the history is one accepted edit (the action post records each), the newest the last posted,
        // carried by the flush as a step no earlier flush stored (SP5c spec §5, D28's lever 3).
        expect(f.history).not.toBeNull();
        const done = f.history!.done;
        expect(done).toHaveLength(Math.min(100, f.steps));
        const e = posted[f.steps - 1]!;
        const step = f.history!.steps.find((s) => s.id === done[done.length - 1]);
        expect(step).toEqual({ id: done[done.length - 1], edits: [{ x: e.x, y: e.y, z: e.z, before: e.expect, after: e.value }] });
        // The newest step moves on with the part's edits.
        const newest = JSON.stringify(step);
        expect(newest).not.toBe(last);
        last = newest;
      }
    }
    // The page's log of every flush, on its clock: the flushNow and each tick's post.
    expect(logged).toHaveLength(flushes.length);
    expect(logged.every((f) => f.ok && f.syncMs === 0.2 && f.commitMs === 3 && f.mainMs >= 0)).toBe(true);
  });

  test('every "on" part\'s flush has one scripted edit posted right after it, and every "off" part\'s timer tick one at the same tick (final review GOV-1): 30 flushes give ≥ 30 overlapping edits, counted in the summary', async () => {
    let t = 0;
    const posted: Array<{ readonly t: number; readonly edit: Edit }> = [];
    const flushTimes: number[] = [];
    // Each flush stays in flight 3 ms on the page's clock, settled by the test after the tick (`settle`).
    const inFlight: Array<() => void> = [];
    const ticks: Array<() => void> = [];
    let bound: ReturnType<typeof createBenchDriver> | null = null;
    const saving = createBenchSave({
      worldId: 'b1',
      fly: { x: 20000.5, y: 90, z: 0.5, yaw: 90, pitch: -15, mode: 'fly', speed: 12 },
      frame: { t: 0.3 },
      edits: {
        post: (edits) => {
          for (const edit of edits) posted.push({ t, edit });
          return Promise.resolve({ ok: true, prev: Uint32Array.from(edits, (e) => e.expect), next: Uint32Array.from(edits, (e) => e.value) });
        },
        pending: () => false,
        settled: () => Promise.resolve(),
        bulkPending: () => false,
      },
      read: () => 0,
      sim: {
        flush: () => {
          flushTimes.push(t);
          return new Promise((resolve) => {
            inFlight.push(() => resolve({ type: 'flushed', id: flushTimes.length, ok: true, flushSeq: flushTimes.length, columns: 1, bytes: 9, syncMs: 0.2, commitMs: 3 }));
          });
        },
      },
      clock: {
        now: () => t * 1000,
        setInterval: (f) => ticks.push(f),
        clearInterval() {},
        setTimeout: () => 0,
        clearTimeout() {},
      },
      now: () => t * 1000,
      wallNow: () => 1_800_000_000_000 + t * 1000,
      filled: () => true,
      samples: () => 0,
      flushed: (f) => bound?.flushed(f),
      flushPosted: () => bound?.flushPosted(),
      ticked: () => bound?.autosaveTicked(),
    });
    const settle = async (): Promise<void> => {
      await flush();
      for (const done of inFlight.splice(0)) done();
      await flush();
    };
    const { driver, p, published } = await toL11(saving.hooks);
    bound = driver;
    driver.pose(129.05, p, 12);
    await settle();
    const t0 = 129.1;
    const tickAt: number[] = [];
    for (let i = 0; i < 2400; i++) {
      t = t0 + i * 0.05;
      driver.pose(t, p, 12);
      // The autosave's 2,000 ms timer; its flush settles 3 ms later.
      if (i % 40 === 39) {
        await flush();
        tickAt.push(t);
        ticks[0]!();
        await flush();
        const tick = t;
        t = tick + 0.003;
        await settle();
        t = tick;
      }
    }
    t = t0 + 120;
    expect(driver.pose(t, p, 12)).toBeNull();
    const inPart = (x: number, k: number): boolean => x >= t0 + 30 * k && x < t0 + 30 * (k + 1);
    // 15 ticks per part; the flushNow and the "on" parts' 30 ticks posted.
    expect(tickAt.map((x) => [0, 1, 2, 3].findIndex((k) => inPart(x, k)))).toEqual([0, 1, 2, 3].flatMap((k) => Array<number>(15).fill(k)));
    expect(flushTimes).toHaveLength(31);
    // At each tick, in every part: one edit beside the part's 0.2 s schedule, posted at the tick's time (after the
    // flush's post in the "on" parts).
    for (const x of tickAt) expect(posted.filter((e) => e.t === x)).toHaveLength(1);
    expect(posted).toHaveLength(600 + 60);
    driver.done(FIXED);
    const r = published[0] as BenchResult;
    expect(r.persist.flushes).toBe(30);
    // Each "on" part's flush overlaps the edit posted after it: at least one sample per flush.
    expect(r.persist.replyDuringFlushCount).toBeGreaterThanOrEqual(30);
    expect(r.persist.replyDuringFlushP95Ms).not.toBeNull();
  });
});

describe('the bench\'s saved world in `wi10-bench` (SP5b spec §6.2; plan)', () => {
  test('the route deletes `wi10-bench` at its start and end after closing the page\'s and the sim\'s connections: at the end the order is the sim client\'s dispose → the page\'s `kv.close()` → `deleteIdb`', async () => {
    const order: string[] = [];
    const mem = createMemoryKV();
    const kv: KV = {
      read: (r) => mem.read(r),
      write: (ops) => {
        order.push(`write ${ops.map((o) => o.store).join(',')}`);
        return mem.write(ops);
      },
      onEvent: (f) => mem.onEvent(f),
      close: () => {
        order.push('kv.close');
        mem.close();
      },
    };
    const deleteDb = async (db: string): Promise<void> => { order.push(`deleteIdb ${db}`); };
    const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: BENCH_SEED, profile: 'default', patch: {} }, () => [3, 9]).state;
    const opened = await openBenchSave({ open: async (db) => { order.push(`open ${db}`); return kv; }, deleteDb, id: 'b1', session, now: 1234 });
    // At the start: deleted, opened, the world created (its `worlds` and `state` in one write).
    expect(BENCH_DB).toBe('wi10-bench');
    expect(order).toEqual(['deleteIdb wi10-bench', 'open wi10-bench', 'write worlds,state']);
    // A world record of the route's seed and parameters, today's generator and table; its `load` an empty world's.
    const parsed = parseWorldRecord(opened.world);
    expect(parsed.ok).toBe(true);
    const params = loadParams(opened.world);
    expect(params.ok && params.value).toEqual(session.params);
    expect(params.ok && olderGenerator(opened.world, params.value)).toBe(false);
    expect(opened.world).toMatchObject({ id: 'b1', seedText: '42', seed: [...session.seed], profile: 'default', generatorVersion: GENERATOR_VERSION, created: 1234, backupOf: null });
    expect(opened.world.genKey).toBe(hex64(genKey(session.seed, stageHashes(session.params))));
    expect(opened.load).toEqual({ db: 'wi10-bench', worldId: 'b1', flushSeq: 0, genKey: opened.world.genKey, updated: 0, stateTable: todayStateTable(), rewrite: null });
    expect(opened.kv).toBe(kv);
    // At the end: the sim's connection (its worker terminated), then the page's, then the database.
    order.length = 0;
    await closeBenchSave({ sim: { dispose: () => { order.push('sim.dispose'); } }, kv, deleteDb });
    expect(order).toEqual(['sim.dispose', 'kv.close', 'deleteIdb wi10-bench']);
    // The page runs both around the bench's run.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/openBenchSave\(\{ open: \(db\) => openIdbKV\(db\), deleteDb: deleteIdb,/);
    expect(src).toMatch(/closeBenchSave\(\{ sim: simClient, kv: benchKv, deleteDb: deleteIdb \}\)/);
  });
});

describe('the enter bench `?bench=enter` (SP5b spec §6.2, D28; plan)', () => {
  test('(a) carries no hash, so it opens the map\'s default world, which is the bench\'s seed and profile with no patch: (a) and (b) are one world (final review GOV-13)', () => {
    const setup = { worldId: 'w', pose: { x: 1, y: ENTER_POSE.y, z: 2, yaw: ENTER_POSE.yaw, pitch: ENTER_POSE.pitch } };
    for (const paths of [benchEnterPaths(setup, false), benchEnterPaths(setup, true), toolEnterPaths(setup)]) expect(paths.unsaved).not.toContain('#');
    expect({ seed: DEFAULT_MAP_STATE.seed, profile: DEFAULT_MAP_STATE.profile, patch: DEFAULT_MAP_STATE.patch }).toEqual({ seed: BENCH_SEED, profile: BENCH_PROFILE, patch: {} });
  });

  const session = openMapSession({ ...DEFAULT_MAP_STATE, seed: BENCH_SEED, profile: 'default', patch: {} }, () => [3, 9]).state;
  const world = newWorldRecord('enter-1', 'Enter bench', session, 1_700_000_000_000);
  const pose = { x: 37, y: ENTER_POSE.y, z: -21, yaw: ENTER_POSE.yaw, pitch: ENTER_POSE.pitch };
  /** A load's record (`window.__wiEnterResult`): an unsaved load has no storage figures. */
  const loadOf = (revealMs: number, saved: boolean) => ({
    revealMs, idbOpenMs: saved ? revealMs / 100 : null, loadMs: saved ? revealMs / 20 : null, decodeMs: saved ? revealMs / 40 : null,
  });

  test('the heavy save holds every column of the RD 15 disc, 64 entries each, 16 dense', () => {
    expect(ENTER_POSE).toEqual({ y: 120, yaw: 45, pitch: -20 });
    expect([ENTER_DISC_RD, ENTER_SPARSE, ENTER_DENSE_COLUMNS]).toEqual([BENCH_RD + 3, 64, 16]);
    const d = enterSaveDump(world, pose, 1_700_000_000_500);
    // Every column of the RD 12 + 3 disc around the pose's column (2, −2), in colKey order, nothing else.
    const disc = discOffsets(15).map(([dx, dz]) => colKey(2 + dx, -2 + dz)).sort((a, b) => a - b);
    expect(d.cols.map((c) => c.key)).toEqual(disc);
    expect(d.cols.length).toBe(discOffsets(15).length);
    let dense = 0;
    for (const c of d.cols) {
      const col = decodeColumnDiff(c.bytes, world.stateTable.length);
      expect(col.genKey).toEqual(parseHex64(world.genKey));
      const bySy = new Map<number, number>();
      for (const sy of col.diff.sy) bySy.set(sy, (bySy.get(sy) ?? 0) + 1);
      // 64 sparse entries in one section (fmt 0), and in 16 columns one full section at another sy (fmt 1).
      const counts = [...bySy.values()].sort((a, b) => a - b);
      if (counts.length === 2) {
        dense++;
        expect(counts).toEqual([64, 4096]);
      } else expect(counts).toEqual([64]);
      // Air entries only, above the terrain: the saved world draws as the unsaved one, so (a) and (b) differ only in persistence.
      expect(col.diff.value.every((v) => v === (AIR << 8) >>> 0)).toBe(true);
      expect([...bySy.keys()].every((sy) => sy >= 22)).toBe(true);
    }
    expect(dense).toBe(16);
    // The state at the pose, flying at the default speed; no history; the world record unchanged.
    expect(d.state.player).toEqual({ ...pose, mode: 'fly', speed: 12 });
    expect(normalizeState(d.state, 'enter-1', STATE_BOUNDS)).toEqual({ state: d.state, reset: false });
    expect(d.state).toMatchObject({ worldId: 'enter-1', updated: 1_700_000_000_500 });
    expect(d.history).toBeNull();
    expect(d.world).toBe(world);
    // Seeded: the same save every time.
    expect(enterSaveDump(world, pose, 1_700_000_000_500).cols).toEqual(d.cols);
  });

  test('the `auto=1` driver\'s URL sequence is setup → (a), (b), then (b), (a), × 3 → end → result, the pose the same in (a) and (b), and its JSON has `measureChrome`\'s keys', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const visited: string[] = [ENTER_AUTO_SETUP_PATH];
    const io = { storage, assign: (url: string) => { visited.push(url); }, here: () => visited[visited.length - 1]! };
    // Without the setup's state nothing navigates (a world load with `enterBench=1&auto=1` opened by hand).
    expect(enterAutoRecorded(io, loadOf(100, false))).toBe(false);
    expect(visited).toEqual(['/?bench=enter&auto=1']);
    const setup = { worldId: 'w-auto', pose: { x: -123, y: 120, z: 456, yaw: 45, pitch: -20 } };
    enterAutoStart(io, setup);
    expect(store.has(ENTER_AUTO_KEY)).toBe(true);
    // The loads in visiting order: (a), (b) in the even pairs, (b), (a) in the odd ones.
    const savedAt = (i: number) => ((i >> 1) % 2 === 0) === (i % 2 === 1);
    const results = Array.from({ length: 12 }, (_, i) => loadOf(100 + 7 * i, savedAt(i)));
    for (const r of results) expect(enterAutoRecorded(io, r)).toBe(true);
    enterAutoEnded(io);
    const tool = toolEnterPaths(setup);
    const pair = [`${tool.unsaved}&auto=1`, `${tool.saved}&auto=1`];
    expect(benchEnterPaths(setup, true)).toEqual({ unsaved: pair[0], saved: pair[1] });
    expect(benchEnterPaths(setup, false)).toEqual(tool);
    expect(visited).toEqual([
      '/?bench=enter&auto=1', ...Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? pair : [pair[1], pair[0]])).flat(), '/?bench=enter&phase=end&auto=1', '/?bench=enter&phase=result&auto=1',
    ]);
    // (a) opens unsaved at the setup's pose, (b) the saved world (whose state holds that pose), both at RD 12.
    const a = parseWorldQuery(new URLSearchParams(visited[1]!.slice(1)));
    expect({ x: a.at?.x, z: a.at?.z, y: a.y, yaw: a.yaw, pitch: a.pitch }).toEqual(setup.pose);
    const b = parseWorldQuery(new URLSearchParams(visited[2]!.slice(1)));
    expect([b.world, b.db, b.enterBench, b.rd, a.rd, a.enterBench]).toEqual(['w-auto', 'wi10-bench', true, 12, 12, true]);
    // The download: measureChrome's shape, with the GPU read from the renderer string and the cache unknown.
    const renderer = 'Mesa Intel(R) Xe Graphics (ADL GT2)';
    const json = enterAutoJson(io, { renderer, userAgent: 'Mozilla/5.0 Firefox/130.0' });
    expect(json).not.toBeNull();
    // Each pair holds its (a) and (b) whatever order they ran in.
    const pairs: EnterPair[] = Array.from({ length: 6 }, (_, i) => (i % 2 === 0
      ? { unsaved: results[2 * i]!, saved: results[2 * i + 1]! }
      : { unsaved: results[2 * i + 1]!, saved: results[2 * i]! }));
    expect(json!.pairs).toEqual(pairs);
    for (const p of json!.pairs) expect([p.unsaved.idbOpenMs, p.saved.idbOpenMs === null]).toEqual([null, false]);
    const fromTool = enterSummary(pairs, { gpu: 'iris', renderer, shaderCache: 'unknown', newWorldRevealMs: null });
    for (const k of Object.keys(fromTool)) expect(json, k).toHaveProperty(k);
    expect(json).toMatchObject({ ...fromTool, measuredBy: 'bench=enter&auto=1', userAgent: 'Mozilla/5.0 Firefox/130.0' });
    expect([gpuOfRenderer('ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6)'), gpuOfRenderer('NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2'), gpuOfRenderer('llvmpipe')])
      .toEqual(['iris', 'rtx', 'unknown']);
  });

  test('a load revealed on a page that is not the step\'s (an F5 or Back after its record, a duplicated tab) is not recorded, and the step\'s page is loaded instead (final review GOV-6)', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const visited: string[] = [ENTER_AUTO_SETUP_PATH];
    let page = ENTER_AUTO_SETUP_PATH;
    const io = { storage, assign: (url: string) => { visited.push(url); page = url; }, here: () => page };
    const setup = { worldId: 'w-auto', pose: { x: -123.5, y: 120, z: 456, yaw: 45, pitch: -20 } };
    enterAutoStart(io, setup);
    const savedAt = (i: number) => ((i >> 1) % 2 === 0) === (i % 2 === 1);
    // Pair 0's (a) and (b) recorded; then pair 0's (a) page is loaded again (Back twice) and reveals while pair 1's (b)
    // is the step's: refused, and pair 1's (b) loaded. (A page of the step's own leg is that leg's load, whichever step
    // first loaded it: pair 0's (b) and pair 1's (b) are one URL.)
    const aPage = page;
    expect(enterAutoRecorded(io, loadOf(100, savedAt(0)))).toBe(true);
    expect(enterAutoRecorded(io, loadOf(107, savedAt(1)))).toBe(true);
    const next = page;
    expect(next).not.toBe(aPage);
    page = aPage;
    const stored = store.get(ENTER_AUTO_KEY);
    expect(enterAutoRecorded(io, loadOf(999, true))).toBe(false);
    expect(store.get(ENTER_AUTO_KEY)).toBe(stored);
    expect(page).toBe(next);
    // The run goes on from the step's page: every later pair keeps its own legs.
    const results = Array.from({ length: 12 }, (_, i) => loadOf(100 + 7 * i, savedAt(i)));
    for (const r of results.slice(2)) expect(enterAutoRecorded(io, r)).toBe(true);
    const json = enterAutoJson(io, { renderer: 'Mesa Intel(R) Xe Graphics (ADL GT2)', userAgent: 'x' });
    expect(json!.pairs.every((p) => p.unsaved.idbOpenMs === null && p.saved.idbOpenMs !== null)).toBe(true);
    expect(json!.pairs.map((p) => p.saved.revealMs)).not.toContain(999);
  });

  test('an `?enterBench=1` load publishes `{ revealMs, idbOpenMs, loadMs, decodeMs }` at its reveal, the last three null when unsaved; `db` replaces `wi10`', () => {
    expect(enterResult(812.5, { idbOpenMs: 3.25, loadMs: 41, decodeMs: 17.5 })).toEqual({ revealMs: 812.5, idbOpenMs: 3.25, loadMs: 41, decodeMs: 17.5 });
    expect(enterResult(640, { idbOpenMs: null, loadMs: null, decodeMs: null })).toEqual({ revealMs: 640, idbOpenMs: null, loadMs: null, decodeMs: null });
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    // The saved world's database: `?db=` (only with `enterBench=1`, `parseWorldQuery`), else `wi10`; the connection's open timed.
    expect(src).toMatch(/const db = q\.db \?\? SAVES_DB;/);
    expect(src).toMatch(/enterTimes\.idbOpenMs = performance\.now\(\) - t;/);
    expect(src).toMatch(/openSavedWorld\(\{ open, db, id: q\.world,/);
    // The `load`'s round trip and the sim's decode, for a saved world only (the bench's own save is not timed).
    expect(src).toMatch(/: saved !== null \? timedLoad\(simClient, saved\.load\)/);
    expect(src).toMatch(/enterTimes\.decodeMs = loaded\.decodeMs;/);
    // Published at the reveal, right after `revealMs` is taken.
    expect(src).toMatch(/stats\.revealMs = performance\.now\(\) - t0;\n    if \(q\.enterBench\) window\.__wiEnterResult = enterResult\(stats\.revealMs, enterTimes\);/);
    // main.ts hands the settled page to `enterLoaded` (a failed load's `{ error }`, the self-driving step).
    const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/if \(q\.enterBench\) \(await import\('\.\/ui\/world\/bench'\)\)\.enterLoaded\(page\.state === 'revealed', query\.get\('auto'\) === '1'\);/);
    expect(main).toMatch(/query\.get\('bench'\) === 'enter'\n\s+\? import\('\.\/ui\/world\/bench'\)\.then\(\(m\) => m\.mountEnterBench\(app, query\)\)/);
  });

  test('`summarizeEnter` and measureChrome\'s `enterSummary` are a pinned mirror (ruling P19): the same six pairs give equal JSON', () => {
    const pairs: EnterPair[] = [900, 101, 97, 110, 99, 103].map((u, i) => ({ unsaved: loadOf(u, false), saved: loadOf(u * (1 + i / 50), true) }));
    const o = { gpu: 'rtx', renderer: 'NVIDIA GeForce RTX 3060', shaderCache: 'cold', newWorldRevealMs: 2500 };
    const page = summarizeEnter(pairs, o);
    expect(page).toEqual(enterSummary(pairs, o));
    expect([ENTER_PAIRS, TOOL_ENTER_PAIRS]).toEqual([6, 6]);
    expect(page.kept).toBe(5);
    // The median of the kept pairs' ratios b/a (1.02 … 1.10): pair 4's 1.06, not median (b) / median (a).
    expect(page.enterRatio).toBe(page.pairRatios[3]);
    expect(page.enterRatio).toBeCloseTo(1.06, 12);
    expect(page.enterRatio).not.toBeCloseTo(page.medianSavedMs! / page.medianUnsavedMs!, 3);
    // Both drivers run each pair's legs in the same alternating order.
    expect(Array.from({ length: ENTER_PAIRS }, (_, i) => benchEnterOrder(i))).toEqual(Array.from({ length: TOOL_ENTER_PAIRS }, (_, i) => toolEnterOrder(i)));
  });
});

describe('the review scenes (SP5a spec §6.5; plan)', () => {
  const typeOf = (v: number): string => REGISTRY.TYPE_NAMES[REGISTRY.STATE_TYPE[v >>> 8]!]!;
  const valueOf = (key: string): number => (REGISTRY.parseStateKey(key) << 8) >>> 0;
  const keyOf = (b: SceneVoxel): string => `${b[0]},${b[1]},${b[2]}`;

  test('`REVIEW_HOUSE` holds oak logs on three axes, a ladder, torches, glass and wool', () => {
    const values = new Set(REVIEW_HOUSE.map((b) => b[3]));
    for (const axis of ['x', 'y', 'z']) expect(values.has(valueOf(`oak_log[axis=${axis}]`))).toBe(true);
    const types = new Set([...values].filter((v) => v !== 0).map(typeOf));
    for (const t of ['ladder', 'wall_torch', 'glass', 'oak_planks', 'bricks', 'cobblestone']) expect(types.has(t)).toBe(true);
    expect([...types].filter((t) => t.endsWith('_wool')).length).toBeGreaterThanOrEqual(2);
    // A 7 × 5 × 7 house (dx 2 … 8, dy 0 … 4, dz −3 … 3), every voxel of it listed once, and outside it its torches
    // on the walls, the ladder up the south wall, the log stump beside it and their cobblestone footing; no voxel twice.
    const keys = REVIEW_HOUSE.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
    for (let dy = 0; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = 2; dx <= 8; dx++) expect(keys).toContain(`${dx},${dy},${dz}`);
    const outside = REVIEW_HOUSE.filter((b) => b[0] < 2 || b[0] > 8 || b[2] < -3 || b[2] > 3 || b[1] < 0 || b[1] > 4);
    expect(outside.length).toBeGreaterThan(0);
    for (const b of outside) expect(['wall_torch', 'ladder', 'oak_log', 'cobblestone']).toContain(typeOf(b[3]));
  });

  test('on a hillside lower than the site (ground 2 below the anchor) the outside ladder and the stump stand on a cobblestone footing, no sky under them (rulings R55; final review UI-5)', () => {
    const STONE_V = (STONE << 8) >>> 0;
    const COBBLE_V = valueOf('cobblestone');
    // Anchor (0, 70, 0); the terrain is stone up to y 68 (dy −2), so dy −1 is air wherever the scene writes nothing.
    const read = (_x: number, y: number): number => (y <= 68 ? STONE_V : 0);
    const world = new Map<string, number>();
    for (const ed of reviewSceneEdits(0, 70, 0, read)) world.set(`${ed.x},${ed.y},${ed.z}`, ed.value);
    const after = (dx: number, dy: number, dz: number): number => world.get(`${dx},${70 + dy},${dz}`) ?? read(dx, 70 + dy);
    const standing = REVIEW_HOUSE.filter((b) => b[1] === 0 && (typeOf(b[3]) === 'ladder' || typeOf(b[3]) === 'oak_log') && (b[0] > 8 || b[2] > 3));
    expect(standing.map(keyOf)).toEqual(['8,0,4', '9,0,4']);
    for (const [dx, , dz] of standing) {
      expect([dx, dz, after(dx, -1, dz)]).toEqual([dx, dz, COBBLE_V]);
      expect(after(dx, -2, dz)).toBe(STONE_V);
    }
    // On flat ground at the anchor's level (stone up to y 69) the footing replaces the ground voxel under them.
    const flat = (_x: number, y: number): number => (y <= 69 ? STONE_V : 0);
    const footing = reviewSceneEdits(0, 70, 0, flat).filter((ed) => ed.y === 69 && ed.z === 4 && (ed.x === 8 || ed.x === 9));
    expect(footing).toEqual([8, 9].map((x) => ({ x, y: 69, z: 4, op: 'set', value: COBBLE_V, expect: STONE_V })));
  });

  test('the build pose sees an end face of an oak log on each axis (x, y and z), and a ladder outside the walls\' footprint', () => {
    const pose = REVIEW_SCENES['build-day'].pose;
    const at = new Map([...REVIEW_POOL, ...REVIEW_HOUSE].map((b) => [keyOf(b), b[3]]));
    const s = REVIEW_SITE;
    // Open: air inside the cleared site (nothing of the scene written there).
    const open = (dx: number, dy: number, dz: number): boolean =>
      dx >= s.dx0 && dx <= s.dx1 && dy >= s.dy0 && dy <= s.dy1 && dz >= s.dz0 && dz <= s.dz1 && (at.get(`${dx},${dy},${dz}`) ?? 0) === 0;
    // An end face in view: a log of that axis whose face along the axis has open air beyond it, with the pose beyond
    // that face's plane.
    const eye = [pose.x, pose.y, pose.z] as const;
    const endFaceSeen = (axis: 0 | 1 | 2): boolean => REVIEW_HOUSE.some((b) => {
      if (b[3] !== valueOf(`oak_log[axis=${'xyz'[axis]}]`)) return false;
      return [-1, 1].some((sign) => {
        const n = [b[0], b[1], b[2]];
        n[axis]! += sign;
        const beyond = sign < 0 ? eye[axis] < b[axis] : eye[axis] > b[axis] + 1;
        return beyond && open(n[0]!, n[1]!, n[2]!);
      });
    });
    expect([endFaceSeen(0), endFaceSeen(1), endFaceSeen(2)]).toEqual([true, true, true]);
    // The ladder: outside the footprint (dx 2 … 8, dz −3 … 3), up the south wall, which the pose sees; one column of
    // at least two voxels against wall that is neither glass nor air, and no torch above it.
    const ladders = REVIEW_HOUSE.filter((b) => typeOf(b[3]) === 'ladder' && (b[0] < 2 || b[0] > 8 || b[2] < -3 || b[2] > 3));
    expect(ladders.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ladders.map((b) => `${b[0]},${b[2]}`)).size).toBe(1);
    expect(pose.z).toBeGreaterThan(5);
    for (const [dx, dy, dz, v] of ladders) {
      expect([dz, v]).toEqual([4, valueOf('ladder[facing=south]')]);
      const wall = at.get(`${dx},${dy},${dz - 1}`) ?? 0;
      expect(wall).not.toBe(0);
      expect(typeOf(wall)).not.toBe('glass');
      for (const [tx, ty, tz, tv] of REVIEW_HOUSE) {
        if (tx === dx && tz === dz && ty > dy) expect(typeOf(tv)).not.toMatch(/torch/);
      }
    }
  });

  test('`REVIEW_POOL`: a 9 × 9 × 4 pit of water sources, a glass wall on one side, ice at its rim, a 3 × 3 lava pool; apart from the house', () => {
    const at = new Map(REVIEW_POOL.map((b) => [keyOf(b), b[3]]));
    expect(at.size).toBe(REVIEW_POOL.length);
    const water = REVIEW_POOL.filter((b) => b[3] === WATER_SOURCE);
    expect(water).toHaveLength(9 * 9 * 4);
    expect(new Set(water.map((b) => b[1]))).toEqual(new Set([-4, -3, -2, -1]));
    const isWater = (dx: number, dy: number, dz: number): boolean => at.get(`${dx},${dy},${dz}`) === WATER_SOURCE;
    const glass = REVIEW_POOL.filter((b) => b[3] === (GLASS << 8) >>> 0);
    expect(glass).toHaveLength(9 * 4);
    // One side: every glass voxel faces water on the same side (−z), and air (the trench) on the other.
    for (const [dx, dy, dz] of glass) {
      expect(isWater(dx, dy, dz - 1)).toBe(true);
      expect(at.get(`${dx},${dy},${dz + 1}`)).toBe(0);
    }
    const ice = REVIEW_POOL.filter((b) => b[3] === (ICE << 8) >>> 0);
    expect(ice).toHaveLength(1);
    const [ix, iy, iz] = ice[0]!;
    expect(iy).toBe(-1);
    expect([isWater(ix - 1, iy, iz), isWater(ix + 1, iy, iz), isWater(ix, iy, iz - 1), isWater(ix, iy, iz + 1)]).toContain(true);
    const lava = REVIEW_POOL.filter((b) => b[3] === LAVA_SOURCE);
    expect(lava).toHaveLength(9);
    expect(new Set(lava.map((b) => b[1]))).toEqual(new Set([-1]));
    const house = new Set(REVIEW_HOUSE.map(keyOf));
    for (const b of REVIEW_POOL) expect(house.has(keyOf(b))).toBe(false);
  });

  test('the poses: the house from 12 blocks; swimming at the pool\'s surface; the glass wall and the ice in view from the trench\'s side', () => {
    const day = REVIEW_SCENES['build-day'].pose;
    expect(REVIEW_SCENES['build-night'].pose).toEqual(day);
    expect(Math.hypot(day.x - 5.5, day.y - 2.5, day.z - 0.5)).toBeCloseTo(12, 9);
    const swim = REVIEW_SCENES['walk-water'].pose;
    // The eye just above the water's top (dy −1's top face, y 0), over the pool.
    expect(swim.y).toBeGreaterThan(0);
    expect(swim.y).toBeLessThan(0.5);
    expect(REVIEW_POOL.some((b) => b[3] === WATER_SOURCE && b[0] === Math.floor(swim.x) && b[2] === Math.floor(swim.z) && b[1] === -1)).toBe(true);
    const glass = REVIEW_SCENES['glass-water'].pose;
    expect(glass.pitch).toBeLessThan(0);
    expect(glass.y).toBeGreaterThan(0);
  });

  /**
   * A review shot's run (SP5a spec §6.5): the live legs settle at once, L9 arrives at (20,000.5, 90, 0.5), L10's 100
   * edits run from 98 s; the scene hooks' calls are kept in `calls`.
   */
  async function sceneRun(shot: ReviewShot, o: { read?: (x: number, y: number, z: number) => number; outcome?: () => EditOutcome | undefined } = {}) {
    const run = driverOf(shot);
    const f = fakeLive();
    f.settle[7] = true;
    f.settle[8] = true;
    f.settle[9] = true;
    const e = fakeEdit(o);
    const calls: string[] = [];
    run.driver.bind({
      rdMax: 16, heightAt: () => 70, live: f.live, edit: e.edit,
      setTime: (h) => { calls.push(`setTime ${h}`); }, walk: (on) => { calls.push(`walk ${on}`); },
    });
    const p: BenchPose = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 };
    // A review shot freezes at no timed moment: the timed script and the live legs run.
    for (const t of [0, 95, 96, 97]) expect(run.driver.pose(t, p, 12)).toBe(12);
    expect(f.calls[2]).toBe('teleport 20000.5 0.5');
    p.x = 20000.5;
    p.y = 90;
    f.arrive();
    await flush();
    for (let k = 0; k < 100; k++) expect(run.driver.pose(98 + k * 0.25, p, 12)).toBe(12);
    await flush();
    expect(e.posts).toHaveLength(100);
    return { ...run, e, calls, p };
  }

  /** Poses every 1/16 s from `t` (exact in binary), letting each post settle, until the driver ends (null) or 50 s pass. */
  async function runOut(driver: ReturnType<typeof driverOf>['driver'], p: BenchPose, t: number, each?: () => void): Promise<Array<number | null>> {
    const results: Array<number | null> = [];
    for (let i = 0; i < 800; i++) {
      const r = driver.pose(t + i / 16, p, 12);
      results.push(r);
      each?.();
      await flush();
      if (r === null) break;
    }
    return results;
  }

  test('`build-day` calls `setTime(12)`, `build-night` `setTime(0)`, `walk-water` `walk(true)` (and `setTime(12)`), `glass-water` `setTime(12)`', async () => {
    const want: Record<ReviewShot, string[]> = {
      'build-day': ['setTime 12'],
      'build-night': ['setTime 0'],
      'walk-water': ['setTime 12', 'walk true'],
      'glass-water': ['setTime 12'],
    };
    for (const shot of REVIEW_SHOTS) {
      const { driver, calls, p, ready } = await sceneRun(shot);
      expect(calls).toEqual([]);
      await runOut(driver, p, 123);
      expect([shot, calls]).toEqual([shot, want[shot]]);
      expect(ready()).toBe(1);
    }
  });

  test('after L10 the scene is built at its hover point through the edit path, in batches with the read values as `expect`, posed and frozen; no flight', async () => {
    // Stone up to y 69 and air above: the surface's first free y is 70.
    const read = (_x: number, y: number): number => (y < 70 ? (STONE << 8) >>> 0 : 0);
    const { driver, e, calls, p, ready, published } = await sceneRun('glass-water', { read });
    const want = new Map<string, number>();
    for (const [dx, dy, dz, v] of [...REVIEW_POOL, ...REVIEW_HOUSE]) {
      const y = 70 + dy;
      if (v !== read(20000 + dx, y)) want.set(`${20000 + dx},${y},${dz}`, v);
    }
    // L10's edits settled at 123 s (its 25 s): the scene's batches follow one at a time, each after the last's reply.
    const poses: BenchPose[] = [];
    const results = await runOut(driver, p, 123, () => { poses.push({ ...p }); });
    const scene = e.posts.slice(100);
    expect(scene.length).toBe(Math.ceil(want.size / REVIEW_SCENE_BATCH));
    const got = new Map<string, number>();
    for (const b of scene) {
      expect(b.edits.length).toBeLessThanOrEqual(REVIEW_SCENE_BATCH);
      for (const ed of b.edits) {
        expect([ed.op, ed.expect]).toEqual(['set', read(ed.x, ed.y)]);
        got.set(`${ed.x},${ed.y},${ed.z}`, ed.value);
      }
    }
    expect(got).toEqual(want);
    // One batch per frame at most, none while the camera is posed; then the pose for REVIEW_SETTLE_S and three frozen
    // frames at it, the shot ready and the script ended. The camera never flew east.
    const scenePose = REVIEW_SCENES['glass-water'].pose;
    const posed = { x: 20000 + scenePose.x, y: 70 + scenePose.y, z: scenePose.z, yaw: scenePose.yaw, pitch: scenePose.pitch };
    expect(poses.at(-2)).toEqual(posed);
    const first = poses.findIndex((q) => q.x === posed.x && q.y === posed.y);
    expect(first).toBe(scene.length);
    expect(poses.length - 1 - first).toBe(REVIEW_SETTLE_S * 16 + 3);
    expect(results.at(-1)).toBeNull();
    expect(ready()).toBe(1);
    expect(calls).toEqual(['setTime 12']);
    driver.done(FIXED);
    expect(published).toEqual([]);
  });

  test('a refused scene batch publishes the error and takes no shot; a hover that never fills does too', async () => {
    let n = 0;
    const refused = await sceneRun('build-day', { outcome: () => (++n > 101 ? { ok: false, why: 'changed' } : undefined) });
    const results = await runOut(refused.driver, refused.p, 123);
    expect(results.at(-1)).toBeNull();
    expect(refused.e.posts).toHaveLength(102);
    expect(refused.published).toEqual([{ route: 'bench=medium', error: expect.stringMatching(/review scene.*refused: changed/) }]);
    expect([refused.ready(), refused.calls]).toEqual([0, []]);

    const run = driverOf('build-night');
    const f = fakeLive();
    f.settle[7] = true;
    f.settle[8] = true;
    run.driver.bind({ rdMax: 16, heightAt: () => 70, live: f.live, edit: fakeEdit().edit, ...NO_SCENE });
    const p: BenchPose = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 };
    for (const t of [0, 95, 96, 97]) run.driver.pose(t, p, 12);
    f.arrive();
    await flush();
    // L9's cap at 112 s, L10's hover cap at 172 s.
    expect(run.driver.pose(112, p, 12)).toBe(12);
    expect(run.driver.pose(172, p, 12)).toBeNull();
    expect(run.published).toEqual([{ route: 'bench=medium', error: expect.stringMatching(/review scene.*not built/) }]);
    expect(run.ready()).toBe(0);
  });
});

describe('createBenchDriver: a teleport that never arrives keeps its cause in the JSON (final review WLD-5)', () => {
  /** Runs the live legs to L9's teleport, settles it with `settle`, lets L9 and L10's hover run to their caps and publishes the JSON. */
  async function l9(settle: (f: ReturnType<typeof fakeLive>) => void): Promise<BenchResult> {
    const { driver, published } = driverOf(null);
    const f = fakeLive();
    driver.bind({ rdMax: 16, heightAt: () => null, live: f.live, edit: fakeEdit().edit, ...NO_SCENE });
    const p = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    driver.pose(0, p, 12);
    driver.pose(95, p, 12);
    f.settle[7] = true;
    f.settle[8] = true;
    driver.pose(96, p, 12);
    driver.pose(97, p, 12);
    expect(f.calls[2]).toBe('teleport 20000 0');
    settle(f);
    await flush();
    expect(driver.pose(112, p, 12)).toBe(12);
    expect(driver.pose(172, p, 12)).toBeNull();
    driver.done(FIXED);
    expect(published).toHaveLength(1);
    return published[0] as BenchResult;
  }

  test('the landing\'s failure (the page\'s teleport rejects with it) is `live.teleportError`, beside L9\'s time-out', async () => {
    const r = await l9((f) => f.fail(new Error('the landing worker failed')));
    expect(r.live.teleportError).toBe('Error: the landing worker failed');
  });

  test('a teleport that resolves false without a cause says so; one that arrived leaves it null', async () => {
    expect((await l9((f) => f.arrive(false))).live.teleportError).toBe('the teleport did not move the camera');
    expect((await l9((f) => f.arrive(true))).live.teleportError).toBeNull();
  });

  test('the page\'s bench teleport records the landing\'s failure and rejects with it', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/onFail: \(cause\) => \{ landingFailure = \{ cause \}; \},/);
    expect(src).toMatch(/if \(!ok && landingFailure !== null\) throw landingFailure\.cause;/);
  });
});

// ---------------------------------------------------------------- the paste leg L12 (SP5c spec §10.4)

/** A voxel's key over the world's window (x, z in ±2^19, y in −64 … 319). */
const vkey = (x: number, y: number, z: number): number => ((x + 524_288) * 1_048_576 + (z + 524_288)) * 512 + (y + 64);
const STONE_V = (STONE << 8) >>> 0;
/** The fake world's ground: stone below y 70, air from it. */
const GROUND_Y = 70;
const genValue = (y: number): number => (y < GROUND_Y ? STONE_V : 0);
const MISS = { hit: false } as RayHit;

/**
 * The bench route's L12 pieces over a fake world (plan): the page's own `createBenchSimLog`, `createEditPath`,
 * `createBenchSave` and `createBenchPaste` over a fake sim whose world is a map of voxels (ground stone below y 70), a
 * fake coordinator whose `markEdited` reveals the dirty columns `revealDelayMs` later (by the batch's index in L12, −1
 * before L12), a fake ghost built in two steps, injected timers and a `MemoryKV` for the clipboard, all on `clock.ms`.
 */
function fakePastePage(o: { revealDelayMs?: (batch: number) => number; events?: string[] } = {}) {
  const clock = { ms: 0 };
  const now = (): number => clock.ms;
  const cells = new Map<number, number>();
  // The highest non-air y + 1 written in each block column (the world's `worldSurface` over its ground).
  const tops = new Map<number, number>();
  const read = (x: number, y: number, z: number): number => cells.get(vkey(x, y, z)) ?? genValue(y);
  const write = (x: number, y: number, z: number, v: number): void => {
    if (v === genValue(y)) cells.delete(vkey(x, y, z));
    else cells.set(vkey(x, y, z), v);
    if (v !== 0) tops.set(vkey(x, 0, z), Math.max(tops.get(vkey(x, 0, z)) ?? GROUND_Y, y + 1));
  };
  const surfaceAt = (x: number, z: number): number => tops.get(vkey(x, 0, z)) ?? GROUND_Y;
  let nextId = 0;
  const copies: Array<{ readonly t: number; readonly box: Box; readonly gen: boolean }> = [];
  const sim = {
    failed: false,
    edits(e: readonly Edit[]): Promise<EditedMsg> {
      const id = ++nextId;
      const n = e.length;
      const prev = new Uint32Array(n);
      const next = new Uint32Array(n);
      const refused = e.some((x) => read(x.x, x.y, x.z) !== x.expect) ? 'changed' as const : null;
      const cols = new Set<number>();
      if (refused === null) {
        for (let k = 0; k < n; k++) {
          const x = e[k]!;
          prev[k] = read(x.x, x.y, x.z);
          const v = x.op === 'revert' ? genValue(x.y) : x.value;
          write(x.x, x.y, x.z, v);
          next[k] = v;
          cols.add(colKey(x.x >> 4, x.z >> 4));
        }
      }
      return Promise.resolve({
        type: 'edited', id, prev, next, dirty: Float64Array.from(cols), entryAdded: new Float64Array(0), entryRemoved: new Float64Array(0),
        refused, relightMs: id, editMs: 10 * id, limboMax: 100 * id, subBatchMaxMs: id / 2,
      });
    },
    copy(b: Box, gen: boolean): Promise<CopiedMsg> {
      copies.push({ t: clock.ms, box: b, gen });
      const values = new Uint32Array(b.w * b.h * b.d);
      const generated = gen ? new Uint32Array(values.length) : null;
      let i = 0;
      for (let y = 0; y < b.h; y++) {
        for (let z = 0; z < b.d; z++) {
          for (let x = 0; x < b.w; x++, i++) {
            values[i] = read(b.x0 + x, b.y0 + y, b.z0 + z);
            if (generated !== null) generated[i] = genValue(b.y0 + y);
          }
        }
      }
      return Promise.resolve({ type: 'copied', id: ++nextId, values, generated, why: null });
    },
    diff: (): Promise<ColumnDiff | null> => Promise.resolve(null),
    hasEntries: () => false,
    flush: (): Promise<FlushedMsg> => Promise.resolve({ type: 'flushed', id: ++nextId, ok: true, flushSeq: 1, columns: 1, bytes: 9, syncMs: 0.2, commitMs: 3 }),
  };
  const timers: Array<{ readonly id: number; readonly at: number; readonly f: () => void }> = [];
  let timerId = 0;
  const pageTimers = {
    set: (f: () => void, ms: number): number => {
      timers.push({ id: ++timerId, at: clock.ms + ms, f });
      return timerId;
    },
    clear: (id: number): void => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const log = createBenchSimLog(sim, now);
  const reveals: Array<{ readonly at: number; readonly cols: readonly number[] }> = [];
  const coordinator = {
    editState: (): 0 => 0,
    simPin() {},
    simUnpin() {},
    markEdited(dirty: ArrayLike<number>) {
      reveals.push({ at: clock.ms + (o.revealDelayMs?.(log.edits.length - 1) ?? 50), cols: Array.from(dirty) });
    },
  };
  const path = createEditPath({ sim: log.sim, coordinator, latency: createEditLatency(), now, notices: { show() {}, hide() {} }, timers: pageTimers });
  let driver: ReturnType<typeof createBenchDriver> | null = null;
  const saving = createBenchSave({
    worldId: 'b1',
    fly: { x: 20000.5, y: 90, z: 0.5, yaw: 90, pitch: -15, mode: 'fly', speed: 12 },
    frame: { t: 0.3 },
    edits: path,
    read,
    sim,
    clock: { now, setInterval: () => 0, clearInterval() {}, setTimeout: (f, ms) => pageTimers.set(f, ms), clearTimeout: (id) => pageTimers.clear(id) },
    now,
    wallNow: () => 1_800_000_000_000 + clock.ms,
    filled: () => true,
    samples: () => 0,
    flushed: (f) => driver?.flushed(f),
    flushPosted() {},
    ticked() {},
  });
  const ghosts: string[] = [];
  let build: 'empty' | 'building' | 'ready' = 'empty';
  let steps = 0;
  let shown = false;
  const ghost: GhostHost = {
    setGhostBox() {}, hideGhostBox() {},
    setGhost(w, h, d) {
      ghosts.push(`${w}x${h}x${d}`);
      o.events?.push(`ghost ${w}x${h}x${d}`);
      build = 'building';
      steps = 0;
      shown = false;
    },
    ghostStep() {
      if (build === 'building' && ++steps >= 2) build = 'ready';
    },
    placeGhost() { shown = true; },
    hideGhost() { shown = false; },
    ghostBuild: () => build,
    setReplaced() {}, hideReplaced() {},
  };
  const kv = createMemoryKV();
  const page = createBenchPaste({
    sim, log, editState: () => 0, kv: () => Promise.resolve(kv), actionPost: (e) => saving.hooks.post(e), history: saving.blockHistory,
    settled: () => path.settled(), view: { setSelectionBox() {}, hideSelectionBox() {} }, ghost, ghostSliceMs: () => 0.25,
    toolDrawCalls: () => (shown ? 6 : 2), poolBytes: () => [4096, 8192], surfaceAt, origin: { x: 0, y: 0, z: 0 },
    body: () => ({ minX: 20000.2, minY: 88.4, minZ: 0.2, maxX: 20000.8, maxY: 90.2, maxZ: 0.8 }), now, timers: pageTimers,
  });
  /** After a pose: the aim's frame step, the due timers, the due reveals. */
  const afterPose = (): void => {
    page.frame(MISS, false);
    for (let i = timers.findIndex((t) => t.at <= clock.ms); i >= 0; i = timers.findIndex((t) => t.at <= clock.ms)) timers.splice(i, 1)[0]!.f();
    for (let i = reveals.length - 1; i >= 0; i--) {
      if (reveals[i]!.at > clock.ms) continue;
      for (const c of reveals.splice(i, 1)[0]!.cols) {
        log.staged(colKeyCx(c), colKeyCz(c), clock.ms);
        log.revealed(colKeyCx(c), colKeyCz(c), clock.ms);
      }
    }
  };
  const clipboard = async (): Promise<Uint32Array | null> => {
    const [raw] = await kv.read([{ op: 'get', store: 'meta', key: CLIPBOARD_KEY }]);
    const d = decodeClipboard(raw);
    return d.ok ? d.values : null;
  };
  return { clock, cells, read, surfaceAt, copies, ghosts, page, saving, path, clipboard, afterPose, bind: (d: ReturnType<typeof createBenchDriver>) => { driver = d; } };
}

/**
 * Runs L1-L11 with `save` and `paste` bound (L11's parts at 0.05 s; the clock `setMs` follows the script), then L12 at
 * 0.1 s steps until the script ends; `between` runs after each L12 pose. Returns the published JSON and L12's start and
 * end (s).
 */
async function runL12(save: NonNullable<BenchWorld['save']>, paste: BenchPasteHooks, o: {
  setMs?(ms: number): void;
  between?(): void;
  atL12?(): void;
  bind?(d: ReturnType<typeof createBenchDriver>): void;
  /** What runs after each L12 pose so the script's awaited steps settle (default: a macrotask). */
  settle?(): Promise<void>;
} = {}) {
  const { driver, p, published } = await toL11(save, paste);
  o.bind?.(driver);
  driver.pose(129.05, p, 12);
  await flush();
  const t0 = 129.1;
  for (let i = 0; i < 2400; i++) {
    o.setMs?.(Math.round((t0 + i * 0.05) * 1000));
    expect(driver.pose(t0 + i * 0.05, p, 12)).toBe(12);
    if (i % 100 === 99) await flush();
  }
  await flush();
  o.atL12?.();
  // L11 ends and L12 starts at the same frame.
  const start = t0 + 120;
  let end = Number.NaN;
  for (let i = 0; i < 4000; i++) {
    const t = start + i * 0.1;
    o.setMs?.(Math.round(t * 1000));
    if (driver.pose(t, p, 12) === null) {
      end = t;
      break;
    }
    expect([p.x, p.z]).toEqual([20000.5, 0.5]);
    o.between?.();
    await (o.settle ?? flush)();
  }
  driver.done(FIXED);
  return { result: published[0] as BenchResult, start, end };
}

/** Settles a stub's steps: their promises resolve at once, so a few microtask turns carry the script on. */
const microtasks = async (): Promise<void> => {
  for (let k = 0; k < 24; k++) await Promise.resolve();
};

/** L12's hooks with every step answering at once, except those `hang` holds forever; each call's script time logged. */
function stubPaste(o: { hang?: (what: string, n: number) => boolean; shown?: () => boolean; at: () => number }) {
  const calls: Array<{ readonly what: string; readonly t: number }> = [];
  const call = <T>(what: string, v: T): Promise<T> => {
    calls.push({ what, t: o.at() });
    const n = calls.filter((c) => c.what === what).length;
    return o.hang?.(what, n) === true ? new Promise<T>(() => {}) : Promise.resolve(v);
  };
  let mode: 'off' | 'select' | 'place' = 'off';
  const hooks: BenchPasteHooks = {
    start() {},
    surfaceAt: () => 70,
    toggle() { mode = mode === 'off' ? 'select' : 'off'; },
    mode: () => mode,
    select() { mode = 'select'; },
    copy: () => call('copy', true),
    cut: () => call('cut', true),
    paste() { mode = 'place'; return call('paste', true); },
    move() { mode = 'place'; return call('move', true); },
    turn() {},
    placeAt() {},
    ghostBuilt: () => true,
    confirm() { mode = 'select'; return call('confirm', 'ok'); },
    cancel() { mode = 'select'; },
    undo: () => call('undo', true),
    redo: () => call('redo', true),
    writeClipboard: () => call('write', true),
    shown: () => o.shown?.() ?? true,
    edits: () => [],
    targetReads: () => 0,
    toolDrawCalls: () => 0,
    poolBytes: () => [1, 2],
    log: () => ({ ghosts: [], overlays: [], clipboardReads: [], clipboardWrites: [], diffs: [] }),
  };
  return { hooks, calls };
}

/**
 * One instrumented L12 run on the fake page (about 1.7 s), shared by the tests that read it: the first redo's columns
 * shown 3.5 s after its reply; each operation's start (with whether every dirty column was shown then); the house
 * checked when the move and the cut run, the cut's clipboard, the world after L12b; the clipboard writes, Ctrl+V, Ctrl+C
 * and the ghosts in order; L12d's start; the world and the house's box when L12 started.
 */
async function runShared() {
  const events: string[] = [];
  const f = fakePastePage({ revealDelayMs: (k) => (k === 2 ? 3500 : 50), events });
  const h = f.page.hooks;
  const house = benchHouse();
  const starts: Array<{ readonly what: string; readonly t: number; readonly shown: boolean }> = [];
  const checks: { move?: boolean; cut?: boolean; afterL12b?: boolean; moveBox?: Box | null; cutBox?: Box | null; clipboard?: Uint32Array | null } = {};
  let start = new Map<number, number>();
  let hb: Box | null = null;
  let writes = 0;
  let l12dFrom = Number.NaN;
  /** Whether every cell of the house's box holds the house turned once (the 6th paste's turn). */
  const houseStands = (): boolean => {
    const b = hb!;
    for (let y = 0; y < b.h; y++) {
      for (let z = 0; z < b.d; z++) {
        for (let x = 0; x < b.w; x++) if (f.read(b.x0 + x, b.y0 + y, b.z0 + z) !== turnedCell(house, 1, x, y, z)) return false;
      }
    }
    return true;
  };
  const opStart = (what: string): void => { starts.push({ what, t: f.clock.ms, shown: h.shown() }); };
  const hooks: BenchPasteHooks = {
    ...h,
    paste() {
      opStart('paste');
      events.push('paste');
      return h.paste();
    },
    undo() {
      opStart('undo');
      return h.undo();
    },
    redo() {
      opStart('redo');
      return h.redo();
    },
    move() {
      opStart('move');
      checks.move = houseStands();
      checks.moveBox = f.page.tool.selection();
      return h.move();
    },
    async cut() {
      opStart('cut');
      checks.cut = houseStands();
      checks.cutBox = f.page.tool.selection();
      const ok = await h.cut();
      checks.clipboard = await f.clipboard();
      return ok;
    },
    copy() {
      events.push('copy');
      return h.copy();
    },
    writeClipboard(b) {
      events.push(`write ${b.w}x${b.h}x${b.d}`);
      // L12c's first write: L12b has ended; L12d's write of the house: the fourth.
      if (++writes === 2) checks.afterL12b = f.cells.size === start.size && [...start].every(([k, v]) => f.cells.get(k) === v);
      if (writes === 4) l12dFrom = f.clock.ms;
      return h.writeClipboard(b);
    },
  };
  const { result } = await runL12(f.saving.hooks, hooks, {
    setMs: (ms) => { f.clock.ms = ms; },
    between: f.afterPose,
    bind: f.bind,
    atL12() {
      start = new Map(f.cells);
      // The house's box: pinned 8 blocks into the column east of the camera's, 8 before its column on z, on the
      // highest surface over the footprint (L11's torches there included).
      let top = -64;
      for (let z = -8; z < 24; z++) for (let x = 20024; x < 20056; x++) top = Math.max(top, f.surfaceAt(x, z));
      hb = { x0: 20024, y0: top, z0: -8, w: 32, h: 12, d: 32 };
    },
  });
  return { f, result, events, starts, checks, start, hb: hb!, l12dFrom };
}
let shared: ReturnType<typeof runShared> | null = null;
const sharedRun = (): ReturnType<typeof runShared> => (shared ??= runShared());

describe('createBenchDriver: the paste leg L12 (SP5c spec §10.4, D30; plan)', () => {
  test('the leg: its constants, its parts and its house', () => {
    expect(BENCH_PASTE_PARTS).toEqual(['L12a', 'L12b', 'L12c', 'L12d']);
    expect(BENCH_PASTE_SCRIPT).toEqual({ gapS: 2, houseCycles: 5, maxCycles: 3, moveDown: 3, turnEveryS: 2, sweepSpan: 64, terrainSide: 64 });
    // §10.1's house enlarged to a 32 × 12 × 32 shell, about 3,300 changed: §10.3's recon shell (3,296).
    const house = benchHouse();
    expect([house.w, house.h, house.d]).toEqual([32, 12, 32]);
    expect(house.values.filter((v) => v !== 0)).toHaveLength(3296);
  });

  test('both maximum blocks and the house round-trip through `encodeClipboard` / `decodeClipboard` (rulings P26)', () => {
    for (const b of [pasteMaxBlock(), pasteLitBlock(), benchHouse()]) {
      // As IndexedDB keeps it: a structured clone of the record.
      const d = decodeClipboard(structuredClone(encodeClipboard(b.w, b.h, b.d, b.values)));
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect([d.w, d.h, d.d, d.unknown]).toEqual([b.w, b.h, b.d, 0]);
      expect(d.values).toEqual(b.values);
    }
  });

  test('L12b runs 28 operations and L12c 12 on a fake clock, each at least 2 s after the last and after every dirty column is shown', async () => {
    const { result, starts } = await sharedRun();
    const r = result.paste;
    expect([r.timedOut, r.stoppedBy]).toEqual([[], null]);
    const b = r.ops.filter((x) => x.part === 'L12b');
    const c = r.ops.filter((x) => x.part === 'L12c');
    expect(b.map((x) => x.op)).toEqual([
      ...Array.from({ length: 5 }, () => ['paste', 'undo', 'redo', 'undo']).flat(), 'paste', 'undo', 'redo', 'move', 'undo', 'cut', 'undo', 'undo',
    ]);
    expect(c.map((x) => x.op)).toEqual(Array.from({ length: 6 }, () => ['paste', 'undo']).flat());
    expect(r.ops.every((x) => x.answer === 'ok')).toBe(true);
    // The operations' starts (L12d's two Ctrl+V follow them): each at least 2 s after the last, with every dirty
    // column of the last batch shown.
    const ops = starts.slice(0, 40);
    expect(ops.map((x) => x.what)).toEqual([...b, ...c].map((x) => x.op));
    for (let k = 1; k < ops.length; k++) expect(ops[k]!.t - ops[k - 1]!.t).toBeGreaterThanOrEqual(2000);
    expect(ops.every((x) => x.shown)).toBe(true);
    // The first redo's columns were shown 3.5 s after its reply: the undo after it waited for them.
    expect(ops[3]!.t - ops[2]!.t).toBeGreaterThanOrEqual(3500);
    // Each operation's batch, shown: its visible times from its post.
    for (const x of [...b, ...c]) {
      expect(x.id).not.toBeNull();
      expect(x.pasteVisibleMs).toBeGreaterThanOrEqual(50);
      expect(x.pasteFirstVisibleMs).toBeLessThanOrEqual(x.pasteVisibleMs!);
    }
    // P27: each L12c paste lands whole in air, exactly the cap.
    for (const x of c.filter((y) => y.op === 'paste')) expect([x.answer, x.changed]).toEqual(['ok', MAX_STEP_EDITS]);
  });

  test('on a fake sim, each operation\'s `replyMs`, `editMs`, `relightMs`, `subBatchMaxMs` and `limboMax` come from its own `edited` reply', async () => {
    const ops = (await sharedRun()).result.paste.ops;
    expect(ops).toHaveLength(40);
    // The fake sim answers batch `id` with editMs 10 · id, relightMs id, subBatchMaxMs id / 2, limboMax 100 · id, at once.
    for (const x of ops) {
      const id = x.id!;
      expect([x.replyMs, x.editMs, x.relightMs, x.subBatchMaxMs, x.limboMax]).toEqual([0, 10 * id, id, id / 2, 100 * id]);
      expect(x.dirtyColumns).toBeGreaterThan(0);
      expect(x.mainPostMs).toBe(0);
    }
    // Every operation its own batch: none shared.
    expect(new Set(ops.map((x) => x.id)).size).toBe(40);
    // An undo's batch is its step's: the same size as the paste before it.
    expect(ops[1]!.changed).toBe(ops[0]!.changed);
  });

  test('the house stands when L12b\'s move and cut run, and the world equals its start after L12b; the cut\'s box is the house\'s and the clipboard after it holds the house (rulings P13, P28)', async () => {
    const { result, checks, hb } = await sharedRun();
    expect(result.paste.stoppedBy).toBeNull();
    expect([checks.move, checks.cut, checks.afterL12b]).toEqual([true, true, true]);
    expect(checks.moveBox).toEqual(hb);
    expect(checks.cutBox).toEqual(hb);
    expect(checks.clipboard).toEqual(turnClipboard(benchHouse(), 1).values);
    // The cut changed the house's 3,296 cells; the move a batch of its own.
    const move = result.paste.ops.find((x) => x.op === 'move')!;
    const cut = result.paste.ops.find((x) => x.op === 'cut')!;
    expect(cut.changed).toBe(3296);
    expect(move.changed).toBeGreaterThan(0);
  });

  test('L12c and L12d write their clipboards before their cycles (L12d\'s first ghost is the house\'s); the world\'s cells are equal before and after L12 on the fake page', async () => {
    const { f, result, events, start } = await sharedRun();
    expect(result.paste.stoppedBy).toBeNull();
    // L12b's house written before its first Ctrl+V.
    const from = events.indexOf('write 32x32x32');
    expect(events.slice(0, 3)).toEqual(['write 32x12x32', 'paste', 'ghost 32x12x32']);
    expect(events.slice(0, from).filter((e) => e.startsWith('write'))).toEqual(['write 32x12x32']);
    expect(events.slice(from)).toEqual([
      'write 32x32x32', ...Array.from({ length: 3 }, () => ['paste', 'ghost 32x32x32']).flat(),
      'write 64x60x32', ...Array.from({ length: 3 }, () => ['paste', 'ghost 64x60x32']).flat(),
      'write 32x12x32', 'paste', 'ghost 32x12x32', 'copy', 'paste', 'ghost 64x64x64',
    ]);
    // Nothing pasted in L12d, every paste of L12b and L12c undone: the world is as it was when L12 started.
    expect(f.cells.size).toBe(start.size);
    for (const [k, v] of start) expect(f.cells.get(k)).toBe(v);
    // The clipboard is written to the bench's database: it holds L12d's 64³ copy of the terrain.
    expect((await f.clipboard())!.length).toBe(64 ** 3);
    // The tool is off at the end.
    expect(f.page.tool.mode).toBe('off');
  });

  test('L12d\'s `targetReads` counts the target `copy`s posted while sweeping', async () => {
    const { f, result, l12dFrom } = await sharedRun();
    // L12d's copies: the ghosts' throttled reads at the sweep's places, and the 64³ copy of the terrain at the hover point.
    const inL12d = f.copies.filter((c) => c.t >= l12dFrom);
    expect(inL12d.filter((c) => c.box.x0 === 20000 - 32)).toHaveLength(1);
    expect(result.paste.L12d.targetReads).toBe(inL12d.length - 1);
    expect(result.paste.L12d.targetReads).toBeGreaterThan(0);
    // The confirms' own reads are no target reads.
    expect(result.paste.L12b.targetReads).toBeLessThan(f.copies.filter((c) => c.t < l12dFrom).length);
    // The tool's draw calls as the fake renderer counts them (6 with the ghost shown, else 2), per part.
    expect([result.paste.L12a.toolDrawCallsMax, result.paste.L12b.toolDrawCallsMax, result.paste.L12d.toolDrawCallsMax]).toEqual([2, 6, 6]);
  });

  test('each L12 part ends at its `BENCH_PASTE` cap with its name in `timedOut`: the fill (60 s), L12b (80 s), L12c (50 s), L12d (10 s)', async () => {
    const T = 129.1 + 120;
    // The fill: the disc at L10's hover point never fills again after L11.
    {
      const s = fakeSave();
      let l11 = true;
      const save = { ...s.save, filled: () => l11 };
      const stub = stubPaste({ at: () => 0 });
      const run = await runL12(save, stub.hooks, { atL12: () => { l11 = false; }, settle: microtasks });
      expect(run.result.paste.timedOut).toEqual(['L12']);
      expect(run.end - run.start).toBeGreaterThanOrEqual(BENCH_PASTE.fillMaxS - 1e-6);
      expect(run.end - run.start).toBeLessThan(BENCH_PASTE.fillMaxS + 0.1 + 1e-6);
      expect(stub.calls).toEqual([]);
    }
    const cases = [
      // L12b: the first paste's columns are never shown.
      { name: 'L12b', cap: BENCH_PASTE.houseMaxS, write: 1, hang: () => false, shown: (calls: number) => calls === 0 },
      // L12c: its first undo (the 15th: L12b has 14) never answers.
      { name: 'L12c', cap: BENCH_PASTE.maxMaxS, write: 2, hang: (what: string, n: number) => what === 'undo' && n === 15, shown: () => true },
      // L12d: the terrain's copy never answers.
      { name: 'L12d', cap: BENCH_PASTE.sweepS, write: 4, hang: (what: string) => what === 'copy', shown: () => true },
    ];
    for (const c of cases) {
      let t = 0;
      const s = fakeSave();
      const stub: ReturnType<typeof stubPaste> = stubPaste({
        at: () => t, hang: c.hang, shown: () => c.shown(stub.calls.filter((x) => x.what === 'confirm').length),
      });
      const run = await runL12(s.save, stub.hooks, { setMs: (ms) => { t = ms / 1000; }, settle: microtasks });
      expect(run.result.paste.timedOut, c.name).toEqual([c.name]);
      expect(run.result.paste.stoppedBy, c.name).toBeNull();
      // The part started with its clipboard's write, and ended at its cap.
      const started = stub.calls.filter((x) => x.what === 'write')[c.write - 1]!.t;
      expect(run.end - started, c.name).toBeGreaterThanOrEqual(c.cap - 1e-6);
      expect(run.end - started, c.name).toBeLessThan(c.cap + 0.1 + 1e-6);
      expect(run.start).toBeCloseTo(T, 6);
      // The autosave ran through L12 and is paused again at its end.
      expect(s.pauses.slice(-2), c.name).toEqual([false, true]);
    }
  });

  test('an operation that does not succeed stops the leg: `stoppedBy` names it, and nothing after it runs', async () => {
    let t = 0;
    const s = fakeSave();
    const stub = stubPaste({ at: () => t });
    const hooks: BenchPasteHooks = { ...stub.hooks, redo: () => Promise.resolve(false) };
    const run = await runL12(s.save, hooks, { setMs: (ms) => { t = ms / 1000; }, settle: microtasks });
    expect(run.result.paste.stoppedBy).toBe('L12b\'s redo (operation 3): nothing was redone');
    expect(run.result.paste.timedOut).toEqual([]);
    expect(run.result.paste.ops.map((x) => [x.op, x.answer])).toEqual([['paste', 'ok'], ['undo', 'ok'], ['redo', 'nothing was redone']]);
    expect(stub.calls.map((x) => x.what)).toEqual(['write', 'paste', 'confirm', 'undo']);
  });

  test('the `paste` block\'s fields and shapes', () => {
    // L12's frames: 20 per part at script ms 10,000 k + 100 i, part k's first `longs[k]` snapped over 33 ms.
    const longs = [0, 2, 1, 3];
    const long = 8 * HZ240;
    const frames: Frame[] = [];
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 20; i++) frames.push({ leg: 12, tMs: 10_000 * k + 100 * i, snappedMs: i < longs[k]! ? long : HZ240, calls: 40 + k });
    }
    const parts = BENCH_PASTE_PARTS.map((name, k) => ({
      name, tS0: 10 * k, tS1: 10 * k + 10, t0: 1000 + 10_000 * k, t1: 11_000 + 10_000 * k, targetReads: k, toolDrawCallsMax: k === 0 ? 0 : 6,
    }));
    const rec = (o: Partial<BenchEditsRecord>): BenchEditsRecord => ({
      id: 7, changed: 3296, tPost: 12_000, mainPostMs: 4, replyMs: 90, editMs: 60, relightMs: 20, subBatchMaxMs: 9, limboMax: 2000,
      refused: null, dirtyColumns: 16, firstVisibleMs: 150, visibleMs: 300, ...o,
    });
    const run: BenchPasteRun = {
      parts,
      ops: [
        { op: 'paste', part: 'L12b', answer: 'ok', edits: rec({}) },
        { op: 'undo', part: 'L12b', answer: 'ok', edits: rec({ id: 8, visibleMs: null, firstVisibleMs: null }) },
        { op: 'cut', part: 'L12b', answer: 'nothing was cut', edits: null },
      ],
      log: {
        // Builds in L12b (two) and L12d (one); the longest of L12b's by its slices in all.
        ghosts: [{ t: 11_500, buildMs: 3, frames: 2, sliceMaxMs: 2.5 }, { t: 12_500, buildMs: 5, frames: 6, sliceMaxMs: 1 }, { t: 31_500, buildMs: 40, frames: 30, sliceMaxMs: 3.5 }],
        overlays: [{ t: 11_600, ms: 0.5 }, { t: 31_600, ms: 2.2 }, { t: 31_700, ms: 1.1 }],
        clipboardReads: [{ t: 11_000, ms: 4 }, { t: 31_000, ms: 9 }],
        clipboardWrites: [{ t: 11_000, ms: 6 }],
        // Diff waits in L12b (counted), L12d (not).
        diffs: [{ t: 12_000, ms: 70 }, { t: 22_000, ms: 30 }, { t: 32_000, ms: 900 }],
      },
      poolsBefore: [4096, 8192],
      poolsAfter: [8192, 8192],
      timedOut: [],
      stoppedBy: null,
    };
    // Flushes in L12a (not counted), L12b and L12c (counted; the failed one's sync not).
    const flushOf = (tPost: number, o: Partial<BenchFlush> = {}): BenchFlush => ({ tPost, tDone: tPost + 10, ok: true, syncMs: 1, commitMs: 5, mainMs: 0.5, ...o });
    const flushes = [flushOf(2000, { syncMs: 50, mainMs: 50 }), flushOf(12_000, { syncMs: 3, mainMs: 1.5 }), flushOf(22_000, { ok: false, syncMs: Number.NaN, mainMs: 2 })];
    const save: BenchSaveRun = { samplesFrom: 0, parts: [], edits: [], flushes, timedOut: [] };
    const r = summarizeBench(recordOf(frames), FIXED, null, undefined, save, run).paste;
    expect(Object.keys(r)).toEqual([
      'L12a', 'L12b', 'L12c', 'L12d', 'ops', 'clipboardReadMs', 'clipboardWriteMs', 'poolBytes', 'flushMainMaxMs', 'flushSyncMaxMs', 'diffWaitMaxMs',
      'timedOut', 'stoppedBy',
    ]);
    expect(Object.keys(r.L12a)).toEqual([
      'p50', 'p95', 'p99', 'max', 'over33', 'ghostBuildMs', 'ghostBuildFrames', 'ghostSliceMaxMs', 'overlayMainMaxMs', 'targetReads', 'drawCallsMax',
      'toolDrawCallsMax',
    ]);
    // Each part's frames (nearest rank of 20: p95 the 19th smallest, p99 the 20th).
    expect([r.L12a.over33, r.L12b.over33, r.L12c.over33, r.L12d.over33]).toEqual(longs);
    expect([r.L12a.p95, r.L12b.p95, r.L12d.p95, r.L12c.p99, r.L12c.max]).toEqual([HZ240, long, long, long, long]);
    expect([r.L12a.p50, r.L12d.p50]).toEqual([HZ240, HZ240]);
    expect([r.L12a.drawCallsMax, r.L12d.drawCallsMax, r.L12a.toolDrawCallsMax, r.L12b.toolDrawCallsMax]).toEqual([40, 43, 0, 6]);
    expect([r.L12a.targetReads, r.L12d.targetReads]).toEqual([0, 3]);
    // The ghost builds and overlays by part; none in L12a.
    expect([r.L12b.ghostBuildMs, r.L12b.ghostBuildFrames, r.L12b.ghostSliceMaxMs]).toEqual([5, 6, 2.5]);
    expect([r.L12d.ghostBuildMs, r.L12d.ghostBuildFrames, r.L12d.ghostSliceMaxMs]).toEqual([40, 30, 3.5]);
    expect([r.L12a.ghostBuildMs, r.L12a.ghostSliceMaxMs, r.L12a.overlayMainMaxMs]).toEqual([null, null, null]);
    expect([r.L12b.overlayMainMaxMs, r.L12d.overlayMainMaxMs]).toEqual([0.5, 2.2]);
    // Per operation, from its batch; none when it posted none.
    expect(Object.keys(r.ops[0]!)).toEqual([
      'op', 'part', 'answer', 'id', 'pasteVisibleMs', 'pasteFirstVisibleMs', 'replyMs', 'editMs', 'relightMs', 'subBatchMaxMs', 'limboMax', 'changed',
      'dirtyColumns', 'mainPostMs',
    ]);
    expect(r.ops[0]).toEqual({
      op: 'paste', part: 'L12b', answer: 'ok', id: 7, pasteVisibleMs: 300, pasteFirstVisibleMs: 150, replyMs: 90, editMs: 60, relightMs: 20,
      subBatchMaxMs: 9, limboMax: 2000, changed: 3296, dirtyColumns: 16, mainPostMs: 4,
    });
    expect([r.ops[1]!.pasteVisibleMs, r.ops[1]!.pasteFirstVisibleMs]).toEqual([null, null]);
    expect(Object.values(r.ops[2]!).slice(3)).toEqual(Array<null>(11).fill(null));
    // The clipboard, the pools, and over L12b and L12c the flushes and the diff waits.
    expect([r.clipboardReadMs, r.clipboardWriteMs]).toEqual([9, 6]);
    expect(r.poolBytes).toEqual({ before: { block: 4096, byte: 8192 }, after: { block: 8192, byte: 8192 } });
    expect([r.flushMainMaxMs, r.flushSyncMaxMs, r.diffWaitMaxMs]).toEqual([2, 3, 70]);
    expect([r.timedOut, r.stoppedBy]).toEqual([[], null]);
    // JSON: every key survives, no NaN.
    const json = JSON.stringify(r);
    expect(json).not.toContain('NaN');
    expect(Object.keys(JSON.parse(json) as object)).toEqual(Object.keys(r));
    // No L12: nothing recorded.
    const none = summarizeBench(recordOf([{ leg: 1 }]), FIXED).paste;
    expect([none.ops, none.L12b.p95, none.L12b.over33, none.poolBytes.before, none.diffWaitMaxMs, none.timedOut]).toEqual([[], null, 0, null, null, []]);
  });

  test('the sim-client wrapper matches each batch to its own `edited` reply by id, from `start`; a column counts as shown once revealed after its staged payload', async () => {
    let t = 0;
    const replies: Array<(m: EditedMsg) => void> = [];
    const diffs: Array<(d: ColumnDiff | null) => void> = [];
    const inner = {
      failed: false,
      edits: (): Promise<EditedMsg> => new Promise((resolve) => { replies.push(resolve); }),
      diff: (): Promise<ColumnDiff | null> => new Promise((resolve) => { diffs.push(resolve); }),
      hasEntries: (cx: number) => cx === 3,
    };
    const log = createBenchSimLog(inner, () => t);
    const edit = (x: number): Edit => ({ x, y: 70, z: 0, op: 'set', value: STONE_V, expect: 0 });
    const reply = (id: number, n: number, dirty: number[], f: number): EditedMsg => ({
      type: 'edited', id, prev: new Uint32Array(n), next: new Uint32Array(n), dirty: Float64Array.from(dirty), entryAdded: new Float64Array(0),
      entryRemoved: new Float64Array(0), refused: null, relightMs: f, editMs: 2 * f, limboMax: 100 * f, subBatchMaxMs: f / 2,
    });
    // Before `start` (L1-L11) nothing is logged, and the calls go through.
    const early = log.sim.edits([edit(0)]);
    replies.shift()!(reply(1, 1, [colKey(0, 0)], 1));
    expect((await early).id).toBe(1);
    void log.sim.diff(0, 0);
    diffs.shift()!(null);
    await flush();
    expect([log.edits, log.diffs, log.shown()]).toEqual([[], [], true]);
    expect([log.sim.hasEntries(3, 0), log.sim.hasEntries(4, 0), log.sim.failed]).toEqual([true, false, false]);
    log.start();
    // A batch built from its operation's mark (t 100) and posted at 103; a second one posted with no mark of its own.
    t = 100;
    log.mark();
    t = 103;
    const a = log.sim.edits([edit(0), edit(1), edit(16)]);
    t = 104;
    const b = log.sim.edits([edit(32)]);
    // Answered out of order: each record takes its own reply's figures.
    t = 150;
    replies[1]!(reply(9, 1, [colKey(2, 0)], 3));
    await b;
    t = 200;
    replies[0]!(reply(8, 3, [colKey(0, 0), colKey(1, 0)], 7));
    await Promise.all([a, b]);
    const row = (r: BenchEditsRecord) => [r.id, r.changed, r.tPost, r.mainPostMs, r.replyMs, r.editMs, r.relightMs, r.subBatchMaxMs, r.limboMax, r.dirtyColumns];
    expect(log.edits.map(row)).toEqual([[8, 3, 103, 3, 97, 14, 7, 3.5, 700, 2], [9, 1, 104, 0, 46, 6, 3, 1.5, 300, 1]]);
    expect(log.shown()).toBe(false);
    // A reveal before the column's payload staged after the reply does not count.
    log.revealed(0, 0, 210);
    expect(log.edits[0]!.firstVisibleMs).toBeNull();
    log.staged(0, 0, 220);
    log.revealed(0, 0, 230);
    expect([log.edits[0]!.firstVisibleMs, log.edits[0]!.visibleMs]).toEqual([127, null]);
    log.staged(1, 0, 240);
    log.revealed(1, 0, 260);
    expect([log.edits[0]!.firstVisibleMs, log.edits[0]!.visibleMs]).toEqual([127, 157]);
    expect(log.shown()).toBe(false);
    log.staged(2, 0, 265);
    log.revealed(2, 0, 270);
    expect([log.edits[1]!.firstVisibleMs, log.edits[1]!.visibleMs, log.shown()]).toEqual([166, 166, true]);
    // A diff's wait, post → reply.
    t = 300;
    const d = log.sim.diff(5, 5);
    t = 340;
    diffs.shift()!(null);
    await d;
    expect(log.diffs).toEqual([{ t: 300, ms: 40 }]);
  });

  test('an autosave tick during a pending L12b paste posts only after the reply, and the flush\'s history holds that step (rulings P32)', async () => {
    let answer: ((m: EditedMsg) => void) | null = null;
    const histories: Array<HistoryWrite | null> = [];
    const ticks: Array<() => void> = [];
    const path = createEditPath({
      sim: { failed: false, edits: () => new Promise<EditedMsg>((resolve) => { answer = resolve; }) },
      coordinator: { editState: () => 0, simPin() {}, simUnpin() {}, markEdited() {} },
      latency: createEditLatency(),
      now: () => 0,
      notices: { show() {}, hide() {} },
      timers: { set: () => 0, clear() {} },
    });
    const saving = createBenchSave({
      worldId: 'b1',
      fly: { x: 20000.5, y: 90, z: 0.5, yaw: 90, pitch: -15, mode: 'fly', speed: 12 },
      frame: { t: 0.3 },
      edits: path,
      read: () => 0,
      sim: {
        flush: (_state, history) => {
          histories.push(history);
          return Promise.resolve({ type: 'flushed', id: histories.length, ok: true, flushSeq: histories.length, columns: 1, bytes: 9, syncMs: 0.2, commitMs: 3 });
        },
      },
      clock: { now: () => 0, setInterval: (f) => ticks.push(f), clearInterval() {}, setTimeout: () => 0, clearTimeout() {} },
      now: () => 0,
      wallNow: () => 1_800_000_000_000,
      filled: () => true,
      samples: () => 0,
      flushed() {},
      flushPosted() {},
      ticked() {},
    });
    // L12 runs with autosave on; the house's paste is posted and not answered yet.
    saving.hooks.pause(false);
    const house = benchHouse();
    const edits: Edit[] = [];
    house.values.forEach((v, i) => {
      if (v !== 0) edits.push({ x: 20024 + (i % 32), y: 90 + Math.floor(i / 1024), z: -8 + (Math.floor(i / 32) % 32), op: 'set', value: v, expect: 0 });
    });
    const posted = saving.hooks.post(edits);
    expect(path.bulkPending()).toBe(true);
    ticks[0]!();
    await flush();
    expect(histories).toEqual([]);
    answer!({
      type: 'edited', id: 1, prev: new Uint32Array(edits.length), next: Uint32Array.from(edits, (e) => e.value), dirty: new Float64Array(0),
      entryAdded: new Float64Array(0), entryRemoved: new Float64Array(0), refused: null, relightMs: 1, editMs: 1, limboMax: 0, subBatchMaxMs: 1,
    });
    expect((await posted).ok).toBe(true);
    await flush();
    expect(histories).toHaveLength(1);
    const done = histories[0]!.done;
    expect(histories[0]!.steps.find((s) => s.id === done[done.length - 1])!.edits).toHaveLength(3296);
  });
});

// ---------------------------------------------------------------- L13 (SP6a spec §10.6, D29)

/** A fixture world: solid everywhere but the air voxels set, each with its cave kind. */
function caveWorld() {
  const air = new Map<number, number>();
  const fill = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, kind: number): void => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) air.set(vkey(x, y, z), kind);
  };
  const solid = (x: number, y: number, z: number): void => { air.delete(vkey(x, y, z)); };
  let reads = 0;
  const tagAt = (x: number, y: number, z: number): number => {
    reads++;
    return air.get(vkey(x, y, z)) ?? 0;
  };
  const solidAt = (x: number, y: number, z: number): boolean => {
    reads++;
    return !air.has(vkey(x, y, z));
  };
  return { fill, solid, tagAt, solidAt, reads: () => reads };
}

/**
 * The fixture cave: a cheese room (x 0 … 3, y 10 … 12, z 0 … 3; its floor at y 9, a one-block ledge at (3, 10, 3))
 * joined on its west side to a spaghetti 3D tunnel (x −1 … −5 at z 1, y 10 … 11) that forks at x −5: a spaghetti 3D
 * branch south (z 2 … 4) and a spaghetti 2D tunnel on west (x −6 … −9); every branch ends blind.
 */
function fixtureCave() {
  const w = caveWorld();
  w.fill(0, 3, 10, 12, 0, 3, CAVE_KIND.cheese);
  w.solid(3, 10, 3);
  w.fill(-5, -1, 10, 11, 1, 1, CAVE_KIND.spaghetti3d);
  w.fill(-5, -5, 10, 11, 2, 4, CAVE_KIND.spaghetti3d);
  w.fill(-9, -6, 10, 11, 1, 1, CAVE_KIND.spaghetti2d);
  return w;
}

const pointsOf = (r: Float64Array): Array<[number, number, number]> =>
  Array.from({ length: r.length / 3 }, (_, k) => [r[3 * k]!, r[3 * k + 1]!, r[3 * k + 2]!]);

describe('caveRoute: L13\'s walk through cave air (SP6a spec §10.6, D29; plan)', () => {
  test('the constants: 258 blocks, 4.3 × 60, at 4.3 blocks per second; the flight at 64; the caps 20, 10 and 60 s', () => {
    expect(BENCH_CAVES).toEqual({ findMaxS: 20, flyMaxS: 10, walkS: 60 });
    expect(BENCH_CAVE_ROUTE).toEqual({ flySpeed: 64, walkSpeed: 4.3, blocks: 258 });
    expect(Math.round(BENCH_CAVE_ROUTE.walkSpeed * BENCH_CAVES.walkS)).toBe(BENCH_CAVE_ROUTE.blocks);
    expect(BENCH_CAVES_LEG.seconds).toBe(90);
  });

  test('on the fixture cave the route is the same twice, starts on the floor under the hit, and prefers cheese, then spaghetti 3D, then 2D', () => {
    const w = fixtureCave();
    const a = caveRoute(w.tagAt, w.solidAt, [0, 12, 1], 258);
    const b = caveRoute(w.tagAt, w.solidAt, [0, 12, 1], 258);
    expect(Array.from(b)).toEqual(Array.from(a));
    const pts = pointsOf(a);
    // Lowered from (0, 12, 1) onto the room's floor.
    expect(pts[0]).toEqual([0, 10, 1]);
    // −x (the tunnel, spaghetti 3D) comes first in the tie-break, but the cheese room is preferred.
    expect(pts[1]).toEqual([1, 10, 1]);
    const kinds = pts.map(([x, y, z]) => w.tagAt(x, y, z));
    const firstTunnel = kinds.findIndex((k) => k !== CAVE_KIND.cheese);
    expect(firstTunnel).toBeGreaterThan(1);
    // Every floor voxel of the room is walked before the tunnel (each cheese neighbour taken first).
    const room = new Set(pts.slice(0, firstTunnel).map((p) => p.join()));
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) if (!(x === 3 && z === 3)) expect(room.has([x, 10, z].join()), `${x}, ${z}`).toBe(true);
    // The ledge (3, 11, 3) is climbed through the step above its neighbour.
    expect(room.has([3, 11, 3].join())).toBe(true);
    // At the fork the spaghetti 3D branch (+z) is taken before the 2D tunnel (−x, first in the tie-break).
    const at = (p: readonly number[]): number => pts.findIndex((q) => q.join() === p.join());
    expect(at([-5, 10, 2])).toBeGreaterThan(0);
    expect(at([-5, 10, 2])).toBeLessThan(at([-6, 10, 1]));
    expect(kinds[firstTunnel]).toBe(CAVE_KIND.spaghetti3d);
  });

  test('every point is cave air one block above a floor, never solid; consecutive points are exactly 1 block apart, the dead ends walked back', () => {
    const w = fixtureCave();
    const pts = pointsOf(caveRoute(w.tagAt, w.solidAt, [0, 12, 1], 258));
    const step = ([x, y, z]: readonly number[]): boolean => !w.solidAt(x!, y! - 1, z!);
    for (const [x, y, z] of pts) {
      expect(w.solidAt(x, y, z), `${x}, ${y}, ${z}`).toBe(false);
      expect(w.tagAt(x, y, z), `${x}, ${y}, ${z}`).not.toBe(0);
      // On the floor, or a step: air below, the floor under it.
      expect(w.solidAt(x, y - 1, z) || w.solidAt(x, y - 2, z), `${x}, ${y}, ${z}`).toBe(true);
    }
    let walkedBack = 0;
    const seen = new Set<string>();
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1]!, pts[k]!];
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]), `${k}`).toBe(1);
      // Never two steps in a row.
      expect(step(a) && step(b), `${k}`).toBe(false);
      if (seen.has(b.join())) walkedBack++;
      seen.add(a.join());
    }
    // The blind ends (the 3D branch, the 2D tunnel, the room's corners) are walked back through voxels already passed.
    expect(walkedBack).toBeGreaterThan(10);
    // The 2D tunnel's blind end (−9, 10, 1) is followed by the voxel before it.
    const end = pts.findIndex((p) => p.join() === [-9, 10, 1].join());
    expect(pts[end + 1]).toEqual([-8, 10, 1]);
    // The whole cave walked and walked back: the route ends at its start, short of 258 blocks.
    expect(pts.length - 1).toBeLessThan(258);
    expect(pts[pts.length - 1]).toEqual([0, 10, 1]);
    expect(new Set(pts.map((p) => p.join())).size).toBe(pts.length / 2 + 0.5);
  });

  test('the route stops at `blocks` moves; a solid start gives no point; the search never expands a voxel twice', () => {
    const w = fixtureCave();
    expect(pointsOf(caveRoute(w.tagAt, w.solidAt, [0, 12, 1], 5))).toHaveLength(6);
    expect(caveRoute(w.tagAt, w.solidAt, [0, 9, 1], 258)).toHaveLength(0);
    // An endless slab of cheese: 258 moves west (−x first), each voxel new.
    const slab = {
      tagAt: (_x: number, y: number): number => (y === 40 || y === 41 ? CAVE_KIND.cheese : 0),
      solidAt: (_x: number, y: number): boolean => y < 40 || y > 41,
    };
    const pts = pointsOf(caveRoute(slab.tagAt, slab.solidAt, [7, 41, 3], 258));
    expect(pts).toHaveLength(259);
    expect(pts[0]).toEqual([7, 40, 3]);
    expect(pts[258]).toEqual([7 - 258, 40, 3]);
  });

  test('off a floor\'s edge the route drops down a shaft deeper than 1 block, one voxel per point, onto the floor below; never sideways mid-fall; never a drop that lands nowhere; links on to an unvisited floor, then back to its first point', () => {
    const w = shaftCave(0);
    const pts = pointsOf(caveRoute(w.tagAt, w.solidAt, [1, 31, 0], 258));
    const at = (p: readonly number[]): number => pts.findIndex((q) => q.join() === p.join());
    expect(pts[0]).toEqual([1, 30, 0]);
    // The fall: off the corridor's edge at (3, 30, 0), straight down 15 voxels to the room's floor, one point each.
    const top = at([3, 30, 0]);
    expect(top).toBeGreaterThan(0);
    expect(pts[top - 1]).toEqual([2, 30, 0]);
    for (let k = 1; k <= 15; k++) expect(pts[top + k], `${k}`).toEqual([3, 30 - k, 0]);
    // Then the cheese room at the bottom is walked.
    expect(pts.slice(top + 16).some(([x, y, z]) => w.tagAt(x, y, z) === CAVE_KIND.cheese)).toBe(true);
    // The −x drop falls onto plain (untagged) air, not cave air: never taken, though −x comes first in the tie-break.
    expect(pts.some(([x]) => x === -1)).toBe(false);
    // The passage off the shaft's side at y 22 has a floor, but a fall goes straight down: not entered before the walk
    // is back at its start, where the link to the nearest unvisited floor takes it there through the shaft's air.
    const home = pts.findIndex((p, k) => k > top && p.join() === [1, 30, 0].join());
    expect(pts.slice(0, home).some(([x, y]) => x >= 4 && y === 22)).toBe(false);
    // (Ties in the moves' order: at (3, 23, 0) +x comes before down.)
    expect(pts.slice(home + 1, home + 12)).toEqual([[2, 30, 0], [3, 30, 0], ...Array.from({ length: 7 }, (_, k) => [3, 29 - k, 0]), [4, 23, 0], [4, 22, 0]]);
    expect(pts.slice(home + 12, home + 16)).toEqual([[5, 22, 0], [6, 22, 0], [5, 22, 0], [4, 22, 0]]);
    // Nothing unvisited is left: the route links back to its first point through the shaft and ends there.
    expect(pts.slice(home + 16)).toEqual([...Array.from({ length: 9 }, (_, k) => [3, 22 + k, 0]), [2, 30, 0], [1, 30, 0]]);
    for (let k = 0; k < pts.length; k++) {
      const [x, y, z] = pts[k]!;
      expect(w.solidAt(x, y, z), `${k}`).toBe(false);
      expect(w.tagAt(x, y, z), `${k}`).not.toBe(0);
      // On a floor, a step, or in a fall: every voxel down to the floor is cave air.
      let f = y;
      while (!w.solidAt(x, f - 1, z)) {
        f--;
        expect(w.tagAt(x, f, z), `${k} at ${f}`).not.toBe(0);
      }
      if (k > 0) {
        const [a, b, c] = pts[k - 1]!;
        expect(Math.abs(a - x) + Math.abs(b - y) + Math.abs(c - z), `${k}`).toBe(1);
      }
    }
    // The walk back climbs the shaft to the start.
    expect(pts.length - 1).toBeLessThan(258);
    const back = pts.findIndex((p, k) => k > top && p.join() === [3, 30, 0].join());
    expect(back).toBeGreaterThan(top + 16);
    for (let k = 1; k <= 15; k++) expect(pts[back - k], `${k}`).toEqual([3, 30 - k, 0]);
  });
});

/**
 * A fixture with a shaft, at x offset `ox`: an entrance corridor (x 0 … 2, y 30 … 31, z 0; its floor at y 29) whose
 * east end opens over a shaft (x 3, y 15 … 31) that drops 15 blocks into a cheese room (x 3 … 6, y 15 … 17, z 0 … 2);
 * a passage on a floor off the shaft's side at y 22 (x 4 … 6); at the corridor's west end a drop (x −1) whose bottom
 * voxel is plain air (kind 0), so it lands on no cave floor.
 */
function shaftCave(ox: number) {
  const w = caveWorld();
  w.fill(ox, ox + 2, 30, 31, 0, 0, CAVE_KIND.entrance);
  w.fill(ox + 3, ox + 3, 15, 31, 0, 0, CAVE_KIND.entrance);
  w.fill(ox + 3, ox + 6, 15, 17, 0, 2, CAVE_KIND.cheese);
  w.fill(ox + 4, ox + 6, 22, 23, 0, 0, CAVE_KIND.spaghetti2d);
  w.fill(ox - 1, ox - 1, 26, 31, 0, 0, CAVE_KIND.entrance);
  w.fill(ox - 1, ox - 1, 25, 25, 0, 0, CAVE_KIND.none);
  return w;
}

/**
 * L13's hooks on a fake page: `find` answers with `answer` (or never), each call's voxel logged; the store's reads a slab
 * of cheese air at y 40 … 41 around (x, z), rock under and over it.
 */
function fakeCaves(answer: (() => Promise<Awaited<ReturnType<BenchCaveHooks['find']>>>) | null) {
  const finds: Array<[number, number, number]> = [];
  const hooks: BenchCaveHooks = {
    find(x, y, z) {
      finds.push([x, y, z]);
      return answer === null ? new Promise(() => {}) : answer();
    },
    tagAt: (_x, y) => (y === 40 || y === 41 ? CAVE_KIND.cheese : 0),
    solidAt: (_x, y) => y < 40 || y > 41,
  };
  return { hooks, finds };
}
const found = (x: number, y: number, z: number) => () => Promise.resolve({ hit: { x, y, z, yaw: 90 }, reason: 'found' });

/**
 * Runs L1-L12 with `caves` (and `xray`) bound (L12's hooks answering at once), then L12, L13 (and L14) at 0.1 s steps
 * until the script ends. Returns the published JSON, L13's and L14's frames (script time, pose, the RD asked for) and
 * the script's end. `clock` follows the script time, for the hooks' logs.
 */
async function runL13(caves: BenchCaveHooks, xray?: (at: () => number) => BenchXrayHooks) {
  let t = 0;
  const s = fakeSave();
  const stub = stubPaste({ at: () => t });
  const { driver, p, published } = await toL11(s.save, stub.hooks, caves, xray?.(() => t));
  driver.pose(129.05, p, 12);
  await flush();
  const t0 = 129.1;
  for (let i = 0; i < 2400; i++) {
    t = t0 + i * 0.05;
    driver.pose(t, p, 12);
    if (i % 100 === 99) await flush();
  }
  await flush();
  type LegFrame = { readonly t: number; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly pitch: number; readonly rd: number };
  const l13: LegFrame[] = [];
  const l14: LegFrame[] = [];
  let lastL12: BenchPose | null = null;
  let end = Number.NaN;
  for (let i = 0; i < 8000; i++) {
    t = t0 + 120 + i * 0.1;
    const rd = driver.pose(t, p, 12);
    if (rd === null) {
      end = t;
      break;
    }
    // The row the driver wrote for this frame (the fake record is never advanced).
    const frame = { t, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, rd };
    if (driver.record.leg[0] === 13) l13.push(frame);
    else if (driver.record.leg[0] === 14) l14.push(frame);
    else lastL12 = { ...p };
    await microtasks();
  }
  driver.done(FIXED);
  return { result: published[0] as BenchResult, l13, l14, end, lastL12: lastL12! };
}

describe('createBenchDriver: the cave leg L13 (SP6a spec §10.6, D29; plan)', () => {
  test('L13 follows L12: the find from the camera\'s voxel at L13\'s start (L10\'s hover point), the flight to the route at 64 blocks/s, the walk at 4.3 for 60 s', async () => {
    const f = fakeCaves(found(20010, 41, 0));
    const run = await runL13(f.hooks);
    expect(run.result.paste.timedOut).toEqual([]);
    // The search starts where the camera is when L13 starts, not at the script's start (0.5, 80, 0.5).
    expect(f.finds).toEqual([[20000, 90, 0]]);
    expect([run.lastL12.x, run.lastL12.y, run.lastL12.z]).toEqual([20000.5, 90, 0.5]);
    expect(run.l13.length).toBeGreaterThan(0);
    const t13 = run.l13[0]!.t;
    // The route from the hit: lowered onto the slab's floor (y 40), then 258 blocks west.
    const c = run.result.caves;
    expect([c.routeBlocks, c.routeKinds, c.timedOut, c.stoppedBy]).toEqual([258, { cheese: 259 }, [], null]);
    expect(c.find.reason).toBe('found');
    expect(c.find.hit).toEqual({ x: 20010, y: 41, z: 0 });
    // The answer is read at the next frame (the find's time, one frame), where the flight starts: (20000.5, 90, 0.5) to
    // the route's start's eye (20010.5, 40 + EYE, 0.5), straight, at 64 blocks/s, facing east.
    const tf = run.l13[1]!.t;
    expect(c.find.ms).toBeCloseTo((tf - t13) * 1000, 6);
    const walk = run.l13.filter((q) => q.pitch === 0);
    const fly = run.l13.filter((q) => q.t >= tf && q.pitch !== 0);
    const dist = Math.hypot(10, 90 - (40 + EYE));
    expect(fly.length).toBeGreaterThan(1);
    for (const q of fly) {
      const d = Math.hypot(q.x - 20000.5, q.y - 90, q.z - 0.5);
      expect(d).toBeCloseTo((q.t - tf) * BENCH_CAVE_ROUTE.flySpeed, 6);
      expect(q.yaw).toBe(90);
    }
    expect(walk[0]!.t - tf).toBeGreaterThanOrEqual(dist / BENCH_CAVE_ROUTE.flySpeed - 1e-9);
    expect(walk[0]!.t - tf).toBeLessThan(dist / BENCH_CAVE_ROUTE.flySpeed + 0.1 + 1e-9);
    // The walk: 4.3 blocks/s west along the route, the eye EYE above the floor, level, for 60 s.
    const w0 = walk[0]!.t;
    for (const q of walk) {
      expect(q.x).toBeCloseTo(20010.5 - (q.t - w0) * BENCH_CAVE_ROUTE.walkSpeed, 6);
      expect([q.y, q.z, q.yaw]).toEqual([40 + EYE, 0.5, 270]);
    }
    expect(run.end - w0).toBeGreaterThanOrEqual(BENCH_CAVES.walkS - 1e-9);
    expect(run.end - w0).toBeLessThan(BENCH_CAVES.walkS + 0.1 + 1e-9);
  });

  test('a route shorter than 258 blocks (its search exhausted, walked back to its start) is walked again from its start until the 60 s end; a fall moves the eye at walking speed', async () => {
    const w = shaftCave(20010);
    const route = pointsOf(caveRoute(w.tagAt, w.solidAt, [20011, 31, 0], 258));
    const moves = route.length - 1;
    expect(moves).toBeLessThan(258);
    expect(route[moves]).toEqual(route[0]);
    const run = await runL13({ find: found(20011, 31, 0), tagAt: w.tagAt, solidAt: w.solidAt });
    const c = run.result.caves;
    expect([c.routeBlocks, c.timedOut, c.stoppedBy]).toEqual([moves, [], null]);
    const walk = run.l13.filter((q) => q.pitch === 0);
    const w0 = walk[0]!.t;
    expect(run.end - w0).toBeGreaterThanOrEqual(BENCH_CAVES.walkS - 1e-9);
    expect(moves / BENCH_CAVE_ROUTE.walkSpeed).toBeLessThan(BENCH_CAVES.walkS / 2);
    // Each point's eye: EYE above its voxel's bottom on a floor, one lower in the air (a step or a fall).
    const eye = route.map(([x, y, z]) => (w.solidAt(x, y - 1, z) ? y : y - 1) + EYE);
    for (const q of walk) {
      // `s` blocks along the route, lap after lap.
      const s = ((q.t - w0) * BENCH_CAVE_ROUTE.walkSpeed) % moves;
      const k = Math.min(Math.floor(s), moves - 1);
      const f = s - k;
      const [a, b] = [route[k]!, route[k + 1]!];
      expect(q.x, `${q.t}`).toBeCloseTo(a[0] + 0.5 + f * (b[0] - a[0]), 6);
      expect(q.z, `${q.t}`).toBeCloseTo(a[2] + 0.5 + f * (b[2] - a[2]), 6);
      expect(q.y, `${q.t}`).toBeCloseTo(eye[k]! + f * (eye[k + 1]! - eye[k]!), 6);
    }
    // The camera moves at most at walking speed on each axis, and never stands still for 0.5 s, laps included (a move
    // up into a step or down out of one keeps the eye: at most one such move in a row).
    for (let k = 1; k < walk.length; k++) {
      const [a, b] = [walk[k - 1]!, walk[k]!];
      for (const v of [b.x - a.x, b.y - a.y, b.z - a.z]) expect(Math.abs(v), `${b.t}`).toBeLessThanOrEqual(BENCH_CAVE_ROUTE.walkSpeed * 0.1 + 1e-6);
      if (k >= 5) {
        const c = walk[k - 5]!;
        expect(Math.abs(b.x - c.x) + Math.abs(b.z - c.z) + Math.abs(b.y - c.y), `${b.t}`).toBeGreaterThan(0);
      }
    }
    // The eye spans the corridor (30 + EYE) and the room's floor at the shaft's foot (15 + EYE).
    expect(Math.max(...walk.map((q) => q.y))).toBeCloseTo(30 + EYE, 6);
    expect(Math.min(...walk.map((q) => q.y))).toBeCloseTo(15 + EYE, 6);
  });

  test('L13 ends at its caps, `timedOut` naming the part: a find with no answer after 20 s; a flight still short of the route after 10 s', async () => {
    const hang = await runL13(fakeCaves(null).hooks);
    const t13 = hang.l13[0]!.t;
    expect(hang.result.caves.timedOut).toEqual(['find']);
    expect(hang.end - t13).toBeGreaterThanOrEqual(BENCH_CAVES.findMaxS - 1e-9);
    expect(hang.end - t13).toBeLessThan(BENCH_CAVES.findMaxS + 0.1 + 1e-9);
    expect([hang.result.caves.find.reason, hang.result.caves.routeBlocks]).toEqual([null, 0]);
    // The camera stayed at L10's hover point while it waited.
    expect(hang.l13.every((q) => q.x === 20000.5 && q.z === 0.5)).toBe(true);
    // 700 blocks east: 11 s at 64 blocks/s.
    const far = await runL13(fakeCaves(found(20700, 41, 0)).hooks);
    // The flight starts where the answer is read, the frame after L13's first.
    const f13 = far.l13[1]!.t;
    expect(far.result.caves.timedOut).toEqual(['fly']);
    expect(far.result.caves.routeBlocks).toBe(258);
    expect(far.end - f13).toBeGreaterThanOrEqual(BENCH_CAVES.flyMaxS - 1e-9);
    expect(far.end - f13).toBeLessThan(BENCH_CAVES.flyMaxS + 0.1 + 1e-9);
    expect(far.l13.some((q) => q.pitch === 0)).toBe(false);
  });

  test('a find with no hit, or a failed one, ends L13 at once with `stoppedBy`; without the cave hooks the script ends after L12', async () => {
    const none = await runL13(fakeCaves(() => Promise.resolve({ hit: null, reason: 'radius' })).hooks);
    expect([none.result.caves.stoppedBy, none.result.caves.timedOut, none.result.caves.find.reason]).toEqual(['no entrance found (radius)', [], 'radius']);
    expect(none.l13.length).toBeLessThanOrEqual(2);
    const failed = await runL13(fakeCaves(() => Promise.reject(new Error('BAD_ARGS'))).hooks);
    expect(failed.result.caves.stoppedBy).toBe('no entrance found (Error: BAD_ARGS)');
    // A hit inside rock (the store's reads say solid): no route.
    const rock = await runL13(fakeCaves(found(20010, 30, 0)).hooks);
    expect(rock.result.caves.stoppedBy).toBe('the route from the entrance at (20010, 30, 0) has no move');
  });

  test('the `caves` block\'s fields and shapes: the walk\'s frames, its main thread, the leg\'s growth events', () => {
    const long = 8 * HZ240;
    const frames: Frame[] = [];
    // L13: 10 frames of the find and flight (one grow, one long frame), 40 of the walk at [10, 50) s (2 grows, 2 long).
    for (let i = 0; i < 10; i++) frames.push({ leg: 13, tMs: 1000 * i, structuralKind: i === 4 ? 2 : 0, snappedMs: i === 5 ? 20 * HZ240 : HZ240 });
    for (let i = 0; i < 40; i++) {
      frames.push({ leg: 13, tMs: 10_000 + 1000 * i, structuralKind: i === 7 || i === 30 ? 2 : i === 8 ? 1 : 0, snappedMs: i < 2 ? long : HZ240, mainMs: i === 39 ? 9 : 1 });
    }
    const run: BenchCaveRun = {
      find: { reason: 'found', ms: 412, hit: { x: 5, y: 40, z: -7 } },
      routeBlocks: 258,
      routeKinds: { cheese: 200, spaghetti3d: 59 },
      walk: { tS0: 10, tS1: 50 },
      timedOut: [],
      stoppedBy: null,
    };
    const r = summarizeBench(recordOf(frames), FIXED, null, undefined, undefined, undefined, run).caves;
    expect(Object.keys(r)).toEqual(['routeBlocks', 'routeKinds', 'p50', 'p95', 'p99', 'max', 'over33', 'mainP95', 'growthEvents', 'find', 'timedOut', 'stoppedBy']);
    expect([r.routeBlocks, r.routeKinds]).toEqual([258, { cheese: 200, spaghetti3d: 59 }]);
    // The walk's 40 frames (nearest rank: p95 the 38th smallest, p99 the 40th): 2 long; the find's 20-interval frame not.
    expect([r.p50, r.p95, r.p99, r.max, r.over33]).toEqual([HZ240, HZ240, long, long, 2]);
    expect(r.mainP95).toBe(1);
    // Every frame of L13 counts its buffer growths (3), not the other structural operations.
    expect(r.growthEvents).toBe(3);
    expect(r.find).toEqual({ reason: 'found', ms: 412, hit: { x: 5, y: 40, z: -7 } });
    expect([r.timedOut, r.stoppedBy]).toEqual([[], null]);
    expect(summarizeBench(recordOf(frames), FIXED).legs.L13.frames.count).toBe(50);
    const json = JSON.stringify(r);
    expect(json).not.toContain('NaN');
    expect(Object.keys(JSON.parse(json) as object)).toEqual(Object.keys(r));
    // No L13: nothing recorded.
    const none = summarizeBench(recordOf([{ leg: 1 }]), FIXED).caves;
    expect([none.routeBlocks, none.routeKinds, none.p95, none.over33, none.mainP95, none.growthEvents, none.find, none.timedOut, none.stoppedBy])
      .toEqual([0, {}, null, 0, null, 0, { reason: null, ms: null, hit: null }, [], null]);
  });

  test('the page\'s cave hooks (`benchCaves`): the finder\'s job for the nearest entrance; the cave kind and the collision of a Published voxel, each in a read section', async () => {
    const asked: unknown[] = [];
    let sections = 0;
    const published = (x: number): boolean => x >= 0;
    const hooks = benchCaves({
      store: {
        enterRead() { sections++; },
        exitRead() { sections--; },
        publishedAt: (x) => published(x),
        final: (cx, cz) => (cx < 0 ? null : { cave: (lx: number, y: number, lz: number) => (y === 40 ? 0x30 | CAVE_KIND.noodle : lx + lz === 3 && cz === -1 ? CAVE_KIND.ravine : 0) } as never),
        blockAt: (x, y) => (!published(x) ? -1 : y < 40 ? STONE : AIR),
        fluidAt: () => 0,
      },
      pool: {
        findCave(req) {
          asked.push(req);
          return { promise: Promise.resolve({ hit: { x: 1, y: 2, z: 3, yaw: 0 }, reason: 'found' as const }), cancel() {} };
        },
      },
    });
    await expect(hooks.find(10, 90, -4)).resolves.toEqual({ hit: { x: 1, y: 2, z: 3, yaw: 0 }, reason: 'found' });
    expect(asked).toEqual([{ kind: CAVE_KIND.entrance, x: 10, y: 90, z: -4 }]);
    // The kind's 4 bits; (1, 2) in the chunk (0, −1) at z −14; 0 off the world's height and where not Published.
    expect([hooks.tagAt(5, 40, 5), hooks.tagAt(1, 41, -14), hooks.tagAt(5, 41, 5), hooks.tagAt(5, 320, 5), hooks.tagAt(5, -65, 5), hooks.tagAt(-1, 40, 5)])
      .toEqual([CAVE_KIND.noodle, CAVE_KIND.ravine, 0, 0, 0, 0]);
    expect([hooks.solidAt(5, 39, 5), hooks.solidAt(5, 40, 5), hooks.solidAt(-1, 39, 5)]).toEqual([true, false, false]);
    expect(sections).toBe(0);
  });
});

/**
 * L14's hooks on a fake page, each call logged with the script time (`at`): the map's tool mounted `readyAfterS` s after
 * the open (null: never), the refill settled `settleAfterS` s after the edit (null: never), the RD 16 disc filled
 * `fillAfterS` s after it is first asked (null: never); the renderer's X-ray draws and vertex bytes and the radius in
 * force: 8, 1,000,000 and 176 with the X-ray on before RD 16 is asked for, 12, 2,000,000 and 240 after; 3 and 500,000 off.
 */
function fakeXray(at: () => number, o: { readyAfterS?: number | null; settleAfterS?: number | null; fillAfterS?: number | null } = {}) {
  const events: Array<{ readonly what: string; readonly t: number }> = [];
  const filledAsked: number[] = [];
  const since = Float64Array.of(Number.NaN, Number.NaN, Number.NaN);
  let on = false;
  const after = (k: number, s: number | null | undefined, otherwise: number): boolean => {
    const d = s === undefined ? otherwise : s;
    return d !== null && !Number.isNaN(since[k]!) && at() - since[k]! >= d - 1e-9;
  };
  const rd16 = (): boolean => !Number.isNaN(since[2]!);
  const hooks: BenchXrayHooks = {
    toggle() {
      on = !on;
      events.push({ what: on ? 'X on' : 'X off', t: at() });
    },
    bandDown() { events.push({ what: 'PageDown', t: at() }); },
    openMap() {
      since[0] = at();
      events.push({ what: 'map open', t: at() });
    },
    mapReady: () => after(0, o.readyAfterS, 0.5),
    closeMap() { events.push({ what: 'map close', t: at() }); },
    set(path, v) {
      since[1] = at();
      events.push({ what: `set ${path} ${v}`, t: at() });
    },
    settled: () => after(1, o.settleAfterS, 3),
    filled(rd) {
      if (!rd16()) since[2] = at();
      filledAsked.push(rd);
      return after(2, o.fillAfterS, 1);
    },
    drawCalls: () => (!on ? 3 : rd16() ? 12 : 8),
    vertexBytes: () => (!on ? 500_000 : rd16() ? 2_000_000 : 1_000_000),
    radius: () => (rd16() ? 240 : 176),
  };
  return { hooks, events, filledAsked };
}

/** The first of `frames` at or after script time `t` (the driver acts on the first frame at or after a part's time). */
const firstAt = <F extends { readonly t: number }>(frames: readonly F[], t: number): F => frames.find((q) => q.t >= t - 1e-9)!;

describe('createBenchDriver: the X-ray leg L14 (SP6a spec §10.6, D10, D29; plan)', () => {
  test('the leg\'s constants: 82 s at its caps; the edit takes `caves.cheese.offset` from its default to cave_heavy\'s 0.20 (ruling P44)', () => {
    expect(BENCH_XRAY).toEqual({ holdS: 10, sweepS: 8, bandS: 4, refillMaxS: 20, rd16MaxS: 40 });
    expect(BENCH_XRAY_LEG.seconds).toBe(82);
    // RD 16's part: the X-ray off at RD 12 for 2 s, the RD 16 disc awaited at most 20 s, the hold and the sweep again.
    expect([BENCH_XRAY_SCRIPT.bandSteps, BENCH_XRAY_SCRIPT.offS, BENCH_XRAY_SCRIPT.rd16FillMaxS]).toEqual([4, 2, 20]);
    expect(BENCH_XRAY_SCRIPT.offS + BENCH_XRAY_SCRIPT.rd16FillMaxS + BENCH_XRAY.holdS + BENCH_XRAY.sweepS).toBe(BENCH_XRAY.rd16MaxS);
    // The from-value is the default at HEAD, read from DEFAULTS, and the applied value differs from it.
    const e = BENCH_XRAY_SCRIPT.edit;
    expect(e.path).toBe('caves.cheese.offset');
    expect(e.from).toBe(DEFAULTS.caves.cheese.offset);
    expect(e.to).not.toBe(DEFAULTS.caves.cheese.offset);
    expect(e.to).toBe(DEFAULTS.caves.cheese.offset === 0.2 ? DEFAULTS.caves.cheese.offset - 0.07 : 0.2);
  });

  test('L14 follows L13 at RD 12 from L13\'s end: X on, hold 10 s, a 360° sweep over 8 s, PageDown × 4, the map side by side and the edit, the refill, X off; then RD 16 filled, X on, hold and sweep', async () => {
    let x: ReturnType<typeof fakeXray> | null = null;
    const run = await runL13(fakeCaves(found(20010, 41, 0)).hooks, (at) => (x = fakeXray(at)).hooks);
    const f = x!;
    expect(run.result.caves.timedOut).toEqual([]);
    expect(run.l14.length).toBeGreaterThan(0);
    const t14 = run.l14[0]!.t;
    // The camera holds where L13 left it (its last frame's pose), at the live legs' pitch.
    const last13 = run.l13[run.l13.length - 1]!;
    const base = { x: last13.x, y: last13.y, z: last13.z, yaw: last13.yaw, pitch: BENCH_PITCH };
    expect(f.events.map((e) => e.what)).toEqual([
      'X on', 'PageDown', 'PageDown', 'PageDown', 'PageDown', 'map open', `set caves.cheese.offset ${BENCH_XRAY_SCRIPT.edit.to}`, 'map close', 'X off', 'X on',
    ]);
    const at = (k: number): number => f.events[k]!.t;
    expect(at(0)).toBe(t14);
    // The hold: 10 s at the start pose.
    for (const q of run.l14.filter((q) => q.t < t14 + BENCH_XRAY.holdS - 1e-9)) {
      expect([q.x, q.y, q.z, q.yaw, q.pitch, q.rd]).toEqual([base.x, base.y, base.z, base.yaw, base.pitch, 12]);
    }
    // The sweep: the yaw turns 360° over 8 s from the first frame at 10 s, the position held.
    const s0 = firstAt(run.l14, t14 + BENCH_XRAY.holdS).t;
    const sweep = run.l14.filter((q) => q.t >= s0 && q.t < s0 + BENCH_XRAY.sweepS - 1e-9);
    expect(sweep.length).toBeGreaterThan(70);
    for (const q of sweep) {
      expect(q.yaw).toBeCloseTo((base.yaw + (360 * (q.t - s0)) / BENCH_XRAY.sweepS) % 360, 6);
      expect([q.x, q.y, q.z, q.pitch]).toEqual([base.x, base.y, base.z, base.pitch]);
    }
    // PageDown four times, one a second from the band's start; the map opened at its end.
    const b0 = firstAt(run.l14, s0 + BENCH_XRAY.sweepS).t;
    for (let k = 0; k < 4; k++) expect(at(1 + k)).toBe(firstAt(run.l14, b0 + k).t);
    expect(at(5)).toBe(firstAt(run.l14, b0 + BENCH_XRAY.bandS).t);
    // The edit once the map's tool is mounted (0.5 s), the map closed and the X-ray off once the refill settled (3 s).
    expect(at(6)).toBe(firstAt(run.l14, at(5) + 0.5).t);
    expect(at(7)).toBe(firstAt(run.l14, at(6) + 3).t);
    expect(at(8)).toBe(at(7));
    // From the release to the frame that swapped the last column (the frame before the first that finds it settled).
    expect(run.result.xray.xrayApplyRefillMs).toBeCloseTo(2900, 6);
    // RD 16 asked for after 2 s with the X-ray off; its disc's fill awaited (1 s), then the X-ray on.
    const r16 = run.l14.find((q) => q.rd === 16)!;
    expect(r16.t).toBe(firstAt(run.l14, at(8) + BENCH_XRAY_SCRIPT.offS).t);
    expect(run.l14.filter((q) => q.t < r16.t).every((q) => q.rd === 12)).toBe(true);
    expect(run.l14.filter((q) => q.t >= r16.t).every((q) => q.rd === 16)).toBe(true);
    expect(new Set(f.filledAsked)).toEqual(new Set([16]));
    expect(at(9)).toBe(firstAt(run.l14, r16.t + 0.1 + 1).t);
    // RD 16's hold and sweep, then the end.
    for (const q of run.l14.filter((q) => q.t >= r16.t && q.t < at(9) + BENCH_XRAY.holdS - 1e-9)) {
      expect([q.x, q.y, q.z, q.yaw, q.pitch]).toEqual([base.x, base.y, base.z, base.yaw, base.pitch]);
    }
    const s16 = firstAt(run.l14, at(9) + BENCH_XRAY.holdS).t;
    for (const q of run.l14.filter((q) => q.t >= s16)) expect(q.yaw).toBeCloseTo((base.yaw + (360 * (q.t - s16)) / BENCH_XRAY.sweepS) % 360, 6);
    expect(run.end).toBeCloseTo(s16 + BENCH_XRAY.sweepS, 6);
    // The block: the edit, the segments' RDs and the renderer's figures read with the X-ray on.
    const r = run.result.xray;
    expect(r.timedOut).toEqual([]);
    expect(r.edit).toEqual({ path: 'caves.cheese.offset', from: DEFAULTS.caves.cheese.offset, to: BENCH_XRAY_SCRIPT.edit.to });
    expect([r.rd12.rd, r.rd12.xrayDrawCallsMax, r.rd12.xrayVertexBytes, r.rd12.radius]).toEqual([12, 8, 1_000_000, 176]);
    expect([r.rd16.rd, r.rd16.xrayDrawCallsMax, r.rd16.xrayVertexBytes, r.rd16.radius]).toEqual([16, 12, 2_000_000, 240]);
  });

  test('L14 ends at its caps, `timedOut` naming the part: a map never mounted (no edit), a refill never settled, an RD 16 disc never filled; the leg stays within its 82 s', async () => {
    const run = async (o: Parameters<typeof fakeXray>[1]) => {
      let x: ReturnType<typeof fakeXray> | null = null;
      const r = await runL13(fakeCaves(found(20010, 41, 0)).hooks, (at) => (x = fakeXray(at, o)).hooks);
      return { ...r, f: x! };
    };
    const t = (r: Awaited<ReturnType<typeof run>>, what: string, k = 0): number => r.f.events.filter((e) => e.what === what)[k]!.t;
    const noMap = await run({ readyAfterS: null, fillAfterS: null });
    expect(noMap.result.xray.timedOut).toEqual(['map', 'rd16']);
    expect(noMap.f.events.some((e) => e.what.startsWith('set '))).toBe(false);
    expect(noMap.result.xray.xrayApplyRefillMs).toBeNull();
    expect(t(noMap, 'X off')).toBe(firstAt(noMap.l14, t(noMap, 'map open') + BENCH_XRAY.refillMaxS).t);
    expect(t(noMap, 'map close')).toBe(t(noMap, 'X off'));
    // RD 16's fill at its cap, 20 s after it was asked for: the X-ray on and RD 16's segment recorded anyway.
    const r16 = noMap.l14.find((q) => q.rd === 16)!.t;
    expect(t(noMap, 'X on', 1)).toBe(firstAt(noMap.l14, r16 + BENCH_XRAY_SCRIPT.rd16FillMaxS).t);
    expect(noMap.end - noMap.l14[0]!.t).toBeLessThanOrEqual(BENCH_XRAY_LEG.seconds + 0.5);
    expect(noMap.end - noMap.l14[0]!.t).toBeGreaterThan(BENCH_XRAY_LEG.seconds - 0.5);
    const noRefill = await run({ settleAfterS: null });
    expect(noRefill.result.xray.timedOut).toEqual(['refill']);
    expect(noRefill.result.xray.xrayApplyRefillMs).toBeNull();
    expect(t(noRefill, 'X off')).toBe(firstAt(noRefill.l14, t(noRefill, 'map open') + BENCH_XRAY.refillMaxS).t);
  });

  test('L14 runs only after L13, never after its time-out; after an L13 that found no entrance it holds at L10\'s hover point', async () => {
    const hang = await runL13(fakeCaves(null).hooks, (at) => fakeXray(at).hooks);
    expect(hang.result.caves.timedOut).toEqual(['find']);
    expect(hang.l14).toEqual([]);
    const none = await runL13(fakeCaves(() => Promise.resolve({ hit: null, reason: 'radius' })).hooks, (at) => fakeXray(at).hooks);
    expect(none.result.caves.stoppedBy).toBe('no entrance found (radius)');
    expect(none.l14.length).toBeGreaterThan(0);
    expect([none.l14[0]!.x, none.l14[0]!.y, none.l14[0]!.z, none.l14[0]!.pitch]).toEqual([20000.5, 90, 0.5, BENCH_PITCH]);
    expect(none.result.xray.timedOut).toEqual([]);
    // Without the X-ray hooks the script ends after L13.
    const without = await runL13(fakeCaves(found(20010, 41, 0)).hooks);
    expect(without.l14).toEqual([]);
  });

  test('the `xray` block\'s fields and shapes: each segment\'s frames with the X-ray on, the GPU ms on and off, the toggles\' longest frames, the growths', () => {
    const long = 8 * HZ240;
    const frames: Frame[] = [];
    // L14 at 1 s a frame: RD 12 on [0, 20), off [20, 22); RD 16 off [22, 25), on [25, 35).
    for (let i = 0; i < 35; i++) {
      const on = i < 20 || i >= 25;
      frames.push({
        leg: 14, tMs: 1000 * i,
        snappedMs: i === 1 || i === 21 ? long : i === 3 ? 20 * HZ240 : i === 27 ? 12 * HZ240 : HZ240,
        mainMs: i === 19 ? 9 : 1,
        gpuMs: on ? (i < 20 ? 4 : 6) : (i < 22 ? 2 : 3),
        calls: i === 5 ? 70 : i === 30 ? 90 : 40,
        geometryMB: i === 6 ? 80 : i === 26 ? 100 : 30,
        structuralKind: i === 2 || i === 21 || i === 23 ? 2 : i === 4 ? 1 : 0,
      });
    }
    const seg = (rd: number, on: [number, number], off: [number, number], toggles: number[], draws: number, bytes: number, radius: number): BenchXrayRun['rd12'] => ({
      rd, on: { tS0: on[0], tS1: on[1] }, off: { tS0: off[0], tS1: off[1] }, toggles, drawCallsMax: draws, vertexBytesMax: bytes, radius,
    });
    const run: BenchXrayRun = {
      edit: { path: 'caves.cheese.offset', from: 0.5, to: 0.2 },
      rd12: seg(12, [0, 20], [20, 22], [0, 20], 9, 1_234_567, 176),
      rd16: seg(16, [25, 35], [22, 25], [25], 14, 2_345_678, 240),
      applyRefillMs: 4321,
      timedOut: ['rd16'],
    };
    const r = summarizeBench(recordOf(frames), FIXED, null, undefined, undefined, undefined, undefined, run).xray;
    expect(Object.keys(r)).toEqual(['rd12', 'rd16', 'xrayApplyRefillMs', 'edit', 'timedOut']);
    expect(Object.keys(r.rd12)).toEqual([
      'rd', 'p50', 'p95', 'p99', 'max', 'over33', 'mainP95', 'gpuMs', 'gpuMB', 'drawCallsMax', 'xrayDrawCallsMax', 'toggleMaxMs',
      'xrayVertexBytes', 'radius', 'growthEvents',
    ]);
    // RD 12's 20 frames with the X-ray on (nearest rank: p95 the 19th, p99 the 20th): one long frame, one of 20 intervals.
    expect([r.rd12.rd, r.rd12.p50, r.rd12.p95, r.rd12.p99, r.rd12.max, r.rd12.over33]).toEqual([12, HZ240, long, 20 * HZ240, 20 * HZ240, 2]);
    expect(r.rd12.mainP95).toBe(1);
    expect(r.rd12.gpuMs).toEqual({ on: { p50: 4, p95: 4 }, off: { p50: 2, p95: 2 } });
    // The GPU estimate's peak and the whole frame's draw calls over the X-ray's frames; the renderer's X-ray figures.
    expect([r.rd12.gpuMB, r.rd12.drawCallsMax, r.rd12.xrayDrawCallsMax, r.rd12.xrayVertexBytes, r.rd12.radius]).toEqual([80 + 10 + 15.8, 70, 9, 1_234_567, 176]);
    // The longest of the three frames from each toggle (0: frames 0-2; 20: frames 20-22).
    expect(r.rd12.toggleMaxMs).toBe(long);
    // The growths over the segment's frames, the X-ray on and off (frames 2 and 21), not the other structural kinds.
    expect(r.rd12.growthEvents).toBe(2);
    // RD 16's 10 frames: p95 the 10th, the frame 2 after the toggle (50 ms).
    expect([r.rd16.rd, r.rd16.p95, r.rd16.max, r.rd16.over33, r.rd16.toggleMaxMs]).toEqual([16, 12 * HZ240, 12 * HZ240, 1, 12 * HZ240]);
    expect(r.rd16.gpuMs).toEqual({ on: { p50: 6, p95: 6 }, off: { p50: 3, p95: 3 } });
    expect([r.rd16.gpuMB, r.rd16.drawCallsMax, r.rd16.growthEvents]).toEqual([100 + 10 + 15.8, 90, 1]);
    expect([r.xrayApplyRefillMs, r.timedOut, r.edit]).toEqual([4321, ['rd16'], { path: 'caves.cheese.offset', from: 0.5, to: 0.2 }]);
    expect(summarizeBench(recordOf(frames), FIXED).legs.L14.frames.count).toBe(35);
    const json = JSON.stringify(r);
    expect(json).not.toContain('NaN');
    expect(JSON.parse(json)).toEqual(r);
    // No L14: every figure null, the counts 0.
    const none = summarizeBench(recordOf([{ leg: 1 }]), FIXED).xray;
    expect(Object.keys(none)).toEqual(Object.keys(r));
    expect(none.rd12).toEqual({
      rd: null, p50: null, p95: null, p99: null, max: null, over33: 0, mainP95: null, gpuMs: { on: null, off: null }, gpuMB: null,
      drawCallsMax: null, xrayDrawCallsMax: null, toggleMaxMs: null, xrayVertexBytes: null, radius: null, growthEvents: 0,
    });
    expect(none.rd16).toEqual(none.rd12);
    expect([none.xrayApplyRefillMs, none.timedOut]).toEqual([null, []]);
    expect(none.edit).toEqual(BENCH_XRAY_SCRIPT.edit);
  });

  test('the page\'s X-ray hooks (`benchXray`): X and PageDown through the page\'s X-ray, the renderer\'s X-ray draws, the rest as given', () => {
    const actions: string[] = [];
    const calls: string[] = [];
    const hooks = benchXray({
      xray: { action: (a) => { actions.push(a); } },
      renderer: { xrayDrawCalls: () => 17, xrayVertexBytes: () => 123_456 },
      map: { open: () => { calls.push('open'); }, close: () => { calls.push('close'); }, ready: () => true },
      live: { set: (path, v) => { calls.push(`set ${path} ${v}`); }, settled: () => false },
      filled: (rd) => rd === 12,
      radius: () => 176,
    });
    hooks.toggle();
    hooks.bandDown();
    hooks.toggle();
    expect(actions).toEqual(['xray', 'xrayDown', 'xray']);
    hooks.openMap();
    hooks.set('caves.cheese.offset', 0.2);
    hooks.closeMap();
    expect(calls).toEqual(['open', 'set caves.cheese.offset 0.2', 'close']);
    expect([hooks.mapReady(), hooks.settled(), hooks.filled(12), hooks.filled(16)]).toEqual([true, false, true, false]);
    expect([hooks.drawCalls(), hooks.vertexBytes(), hooks.radius()]).toEqual([17, 123_456, 176]);
  });
});

describe('benchInterval (the idle frames\' display interval, rulings R5 (a); review M5)', () => {
  test('the median of the idle deltas, or 1000/60 when it is not finite', () => {
    expect(benchInterval(Float64Array.of(4.1, 4.2, 4.3, 4.2, 4.2))).toBeCloseTo(4.2, 9);
    expect(benchInterval(new Float64Array(BENCH_IDLE_FRAMES).fill(Number.NaN))).toBe(1000 / 60);
    expect(benchInterval(new Float64Array(0))).toBe(1000 / 60);
  });
});

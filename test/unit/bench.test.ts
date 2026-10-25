import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import {
  BENCH_FIELDS, BENCH_FRAME_CAPACITY, BENCH_IDLE_FRAMES, BENCH_LEGS, BENCH_LIVE, BENCH_LIVE_LEGS, BENCH_PITCH, BENCH_RD, BENCH_REFILL, BENCH_SEED,
  BENCH_SHOT_ABOVE, BENCH_SHOT_PITCH, BENCH_SHOTS, BENCH_TIME_SPEED, BENCH_Y, benchInterval, benchPose, createBenchDriver, createBenchRecord,
  createBenchRecorder, createLiveReveals, summarizeBench,
  type BenchError, type BenchFixed, type BenchPose, type BenchRecord, type BenchResult, type BenchSources, type BenchWorld,
} from '../../src/ui/world/bench';

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
    expect(BENCH_FRAME_CAPACITY).toBe(49152);
    expect(BENCH_FRAME_CAPACITY).toBeGreaterThan(95 * 240);
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
  }
  return rec;
}

const FIXED: BenchFixed = {
  seed: '42', profile: 'default', rd: 12, workers: 6, sectionRenderer: 'batch', userAgent: 'test', renderer: 'Iris', vendor: 'Intel',
  multiDraw: true, timerQuery: true, screen: { width: 1920, height: 1080 }, dpr: 1, pixelRatio: 1, displayIntervalMs: HZ240,
  load: { revealMs: 4000, stageMs: { T: 1000, D: 1500, L: 2000, MESH: 3000 }, longTasks: { count: 3, maxMs: 80 }, first120RenderedMaxMs: 8.3 },
  totals: { dropped: 2, failed: 0, storeFull: 0 },
  refillMs: 1234,
  rdClampedTo: null,
  canvas: { width: 1920, height: 1080 },
};

describe('summarizeBench (SP4b spec §8.3)', () => {
  test('every key of spec §8.3 is present', () => {
    const r = summarizeBench(recordOf([{ leg: 0 }, { leg: 1 }, { leg: 5 }, { leg: 6 }]), FIXED);
    expect(Object.keys(r)).toEqual([
      'route', 'seed', 'profile', 'rd', 'rdClampedTo', 'workers', 'sectionRenderer', 'userAgent', 'renderer', 'vendor', 'multiDraw', 'timerQuery', 'screen', 'dpr',
      'pixelRatio', 'displayIntervalMs', 'load', 'stream', 'legs', 'L5', 'L6', 'live', 'longFrames', 'structuralFrames',
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
    expect(Object.keys(r.legs)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9']);
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
      'teleportFirstRevealMs', 'teleportRefillMs', 'width', 'height', 'timedOut',
    ]);
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
    driver.bind({ rdMax: 10, heightAt: () => null, live: fakeLive().live });
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
    free.driver.bind({ rdMax: 16, heightAt: () => null, live: fakeLive().live });
    expect(free.driver.rdClampedTo).toBeNull();
    expect(free.driver.pose(10, pose(), 12)).toBe(12);
  });

  test('under a cap rd12back waits for the fog at the cap, and `first` asks for the cap', () => {
    const back = driverOf('rd12back');
    back.driver.bind({ rdMax: 10, heightAt: () => null, live: fakeLive().live });
    const o = pose();
    back.driver.pose(0, { ...o, x: 0, z: 0 }, 10);
    expect(back.driver.pose(85.5, o, 9.5)).toBe(10);
    for (const t of [86, 86.1, 86.2]) expect(back.driver.pose(t, o, 10)).toBe(10);
    expect(back.driver.pose(86.3, o, 10)).toBeNull();
    expect(back.ready()).toBe(1);
    const first = driverOf('first');
    first.driver.bind({ rdMax: 8, heightAt: () => null, live: fakeLive().live });
    expect(first.driver.pose(0, pose(), 8)).toBe(8);
  });

  test('a shot\'s three frames lower the camera to heightAt(floor x, floor z) + 32 at pitch −20, keeping x, z and yaw (rulings R9)', () => {
    expect([BENCH_SHOT_ABOVE, BENCH_SHOT_PITCH]).toEqual([32, -20]);
    const { driver, ready } = driverOf('fly96');
    const asked: Array<[number, number]> = [];
    driver.bind({ rdMax: 12, heightAt: (x, z) => { asked.push([x, z]); return 71; }, live: fakeLive().live });
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
    hole.driver.bind({ rdMax: 12, heightAt: () => null, live: fakeLive().live });
    const out: BenchPose = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    hole.driver.pose(0, out, 12);
    for (let i = 0; i < 3; i++) {
      hole.driver.pose(65.6 + i * 0.01, out, 12);
      expect([out.x, out.y, out.z, out.yaw, out.pitch]).toEqual([400, BENCH_Y, -2880 - 0.5 * 384, 0, BENCH_PITCH]);
    }
    const run = driverOf(null);
    run.driver.bind({ rdMax: 12, heightAt: () => 64, live: fakeLive().live });
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
  const live: BenchWorld['live'] = {
    set: (path, v) => { calls.push(`set ${path} ${v}`); },
    undo: () => { calls.push('undo'); },
    teleport: (x, z) => {
      calls.push(`teleport ${x} ${z}`);
      return new Promise<boolean>((resolve) => { arrive = resolve; });
    },
    settled: (leg) => settle[leg],
  };
  return { live, calls, settle, arrive: (ok = true) => arrive?.(ok) };
}

/** Lets the teleport's promise settle (its `then` runs in a microtask). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createBenchDriver: the live legs after L6 (SP4c spec §8.4, D22; plan)', () => {
  test('L7 sets the leaf to 4.0 at its start, L8 undoes, L9 asks the teleport for x + 20,000 at the same z; each ends when settled', async () => {
    const { driver } = driverOf(null);
    const f = fakeLive();
    driver.bind({ rdMax: 16, heightAt: () => null, live: f.live });
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
    // L9 settles: the script ends after it.
    f.settle[9] = true;
    expect(driver.pose(99, out, 12)).toBeNull();
    expect(driver.pose(99.1, out, 12)).toBeNull();
    expect(f.calls).toHaveLength(3);
  });

  test('a leg that never settles ends at its cap: L7 and L8 after 20 s, L9 after 15 s; before L9\'s arrival y stays 150', () => {
    const { driver } = driverOf(null);
    const f = fakeLive();
    driver.bind({ rdMax: 16, heightAt: () => null, live: f.live });
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
    expect(driver.pose(150, out, 12)).toBeNull();
  });

  test('under a reservation cap the live legs ask for the cap', () => {
    const { driver } = driverOf(null);
    driver.bind({ rdMax: 10, heightAt: () => null, live: fakeLive().live });
    const out = pose();
    driver.pose(0, { ...out, x: 0, z: 0 }, 10);
    expect(driver.pose(96, out, 10)).toBe(10);
  });

  test('apply-before freezes at L7 − 0.5 s (94.5 s), before the edit; apply-mid at L7\'s start + 1 s', () => {
    const before = driverOf('apply-before');
    const fb = fakeLive();
    before.driver.bind({ rdMax: 16, heightAt: () => null, live: fb.live });
    const o: BenchPose = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    before.driver.pose(0, o, 12);
    before.driver.pose(94.4, o, 12);
    for (const t of [94.51, 94.6, 94.7]) expect(before.driver.pose(t, o, 12)).toBe(12);
    expect(before.driver.pose(94.8, o, 12)).toBeNull();
    expect(before.ready()).toBe(1);
    expect(fb.calls).toEqual([]);

    const mid = driverOf('apply-mid');
    const fm = fakeLive();
    mid.driver.bind({ rdMax: 16, heightAt: () => null, live: fm.live });
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
    after.driver.bind({ rdMax: 16, heightAt: () => 70, live: fa.live });
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
    tp.driver.bind({ rdMax: 16, heightAt: (x, z) => { asked.push([x, z]); return 64; }, live: ft.live });
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
    tp.driver.bind({ rdMax: 16, heightAt: () => null, live: f.live });
    const p = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
    tp.driver.pose(0, p, 12);
    tp.driver.pose(95, p, 12);
    f.settle[7] = true;
    f.settle[8] = true;
    tp.driver.pose(96, p, 12);
    tp.driver.pose(97, p, 12);
    f.arrive(false);
    await flush();
    tp.driver.pose(111.99, p, 12);
    expect(tp.ready()).toBe(0);
    for (const t of [112, 112.01, 112.02]) expect(tp.driver.pose(t, p, 12)).toBe(12);
    expect(tp.driver.pose(112.03, p, 12)).toBeNull();
    expect(tp.ready()).toBe(1);
  });
});

describe('benchInterval (the idle frames\' display interval, rulings R5 (a); review M5)', () => {
  test('the median of the idle deltas, or 1000/60 when it is not finite', () => {
    expect(benchInterval(Float64Array.of(4.1, 4.2, 4.3, 4.2, 4.2))).toBeCloseTo(4.2, 9);
    expect(benchInterval(new Float64Array(BENCH_IDLE_FRAMES).fill(Number.NaN))).toBe(1000 / 60);
    expect(benchInterval(new Float64Array(0))).toBe(1000 / 60);
  });
});

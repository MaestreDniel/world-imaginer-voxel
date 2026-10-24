import { describe, expect, test } from 'vitest';
import {
  BENCH_FIELDS, BENCH_FRAME_CAPACITY, BENCH_IDLE_FRAMES, BENCH_LEGS, BENCH_PITCH, BENCH_RD, BENCH_REFILL, BENCH_SEED, BENCH_SHOTS,
  BENCH_TIME_SPEED, BENCH_Y, benchPose, createBenchDriver, createBenchRecord, createBenchRecorder, summarizeBench,
  type BenchError, type BenchFixed, type BenchPose, type BenchRecord, type BenchResult, type BenchSources,
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
    expect(BENCH_FRAME_CAPACITY).toBe(32768);
    expect(BENCH_FRAME_CAPACITY).toBeGreaterThan(95 * 240);
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
});

// ---------------------------------------------------------------- the record and its summary

interface Frame {
  leg: number;
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
  }
  return rec;
}

const FIXED: BenchFixed = {
  seed: '42', profile: 'default', rd: 12, workers: 6, sectionRenderer: 'batch', userAgent: 'test', renderer: 'Iris', vendor: 'Intel',
  multiDraw: true, timerQuery: true, screen: { width: 1920, height: 1080 }, dpr: 1, pixelRatio: 1, displayIntervalMs: HZ240,
  load: { revealMs: 4000, stageMs: { T: 1000, D: 1500, L: 2000, MESH: 3000 }, longTasks: { count: 3, maxMs: 80 }, first120RenderedMaxMs: 8.3 },
  totals: { dropped: 2, failed: 0, storeFull: 0 },
  refillMs: 1234,
};

describe('summarizeBench (SP4b spec §8.3)', () => {
  test('every key of spec §8.3 is present', () => {
    const r = summarizeBench(recordOf([{ leg: 0 }, { leg: 1 }, { leg: 5 }, { leg: 6 }]), FIXED);
    expect(Object.keys(r)).toEqual([
      'route', 'seed', 'profile', 'rd', 'workers', 'sectionRenderer', 'userAgent', 'renderer', 'vendor', 'multiDraw', 'timerQuery', 'screen', 'dpr',
      'pixelRatio', 'displayIntervalMs', 'load', 'stream', 'legs', 'L5', 'L6', 'longFrames', 'structuralFrames',
    ]);
    expect(r.route).toBe('bench=medium');
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
    expect(Object.keys(r.legs)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
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
      { frame: 0, leg: 'L1', kind: 'grow', renderer: 'batch', MB: 3.5, mainMs: 4, gpuMs: 6, snappedMs: 2 * HZ240, nextSnappedMs: HZ240 },
      { frame: 3, leg: 'L3', kind: 'compact', renderer: 'batch', MB: 12, mainMs: 2, gpuMs: null, snappedMs: HZ240, nextSnappedMs: null },
    ]);
    expect([r.stream.partialColumnFrames, r.stream.mixedColumnFrames, r.stream.genCapMin]).toEqual([2, 1, 3]);
    expect(r.stream.gpuMs).toEqual({ p50: 4, p95: 6, max: 6, samples: 2 });
    expect(summarizeBench(recordOf([{ leg: 1 }]), FIXED).stream.gpuMs).toBeNull();
  });
});

// ---------------------------------------------------------------- the per-frame recorder

function sources(over: { kind?: 'create' | 'grow' | 'instances' | 'optimize' | 'compact' | null; heap?: number } = {}): BenchSources & { heapReads: number } {
  const MIB = 1 << 20;
  let polls = 0;
  const s = {
    heapReads: 0,
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
      gpuTimer: () => ({ begin() {}, end() {}, poll: () => (polls++ % 2 === 0 ? 1.5 : null) }),
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
    const recorder = createBenchRecorder(rec, sources({ kind: 'optimize' }), HZ240);
    recorder.frame(8.4, 2.5, 0.3, 0.9, 12, 4);
    expect(rec.n).toBe(1);
    const row = Object.fromEntries(BENCH_FIELDS.map((f) => [f, rec[f][0]]));
    expect(row).toEqual({
      leg: 3, rawMs: 8.4, snappedMs: 2 * HZ240, mainMs: 2.5, coordinatorMs: 0.3, uploadMs: 0.9, rows: 12, structuralKind: 4,
      structuralMB: 3, gpuMs: 1.5, calls: 42, triangles: 123_456, geometryMB: 21, texturesMB: 10, drawingBufferMB: 4, heapMB: 100,
      sabMB: 256, partial: 1, mixed: 0, genCap: 4,
    });
    recorder.frame(HZ240, 1, 0, 0, 0, 4);
    expect([rec.n, rec.gpuMs[1], rec.structuralKind[1]]).toEqual([2, Number.NaN, 4]);
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
  test('the script starts where the camera is, writes each frame\'s leg and ends after 95 s', () => {
    const { driver } = driverOf(null);
    const out: BenchPose = { x: 7, y: 80, z: -3, yaw: 12, pitch: 0 };
    expect(driver.pose(0, out, 12)).toBe(12);
    expect(out).toEqual({ x: 7, y: 150, z: -3, yaw: 90, pitch: -15 });
    expect(driver.record.leg[0]).toBe(0);
    driver.record.n = 1;
    expect(driver.pose(25, out, 12)).toBe(12);
    expect([out.x, out.z, driver.record.leg[1]]).toEqual([407, -3, 2]);
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

  test('`first` keeps the first view after the reveal: the pose is not written', () => {
    const { driver, ready } = driverOf('first');
    const out: BenchPose = { x: 5, y: 90, z: 6, yaw: 33, pitch: -10 };
    for (let i = 0; i < 3; i++) expect(driver.pose(i / 60, out, 12)).toBe(BENCH_RD);
    expect(out).toEqual({ x: 5, y: 90, z: 6, yaw: 33, pitch: -10 });
    expect(driver.pose(0.05, out, 12)).toBeNull();
    expect(ready()).toBe(1);
  });
});

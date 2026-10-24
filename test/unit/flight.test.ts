import { describe, expect, test } from 'vitest';
import { cameraPitch, catmullRom, flightInterval, flightWaypoints, summarizeFlight, type FlightExtra } from '../../src/ui/world/flight';

/** A rolling heightmap: MOTION_BLOCKING between 44 and 84 around y 64. */
const ground = (x: number, z: number): number => Math.floor(64 + 20 * Math.sin(x / 30) * Math.cos(z / 40));
const SPAWN = { x: 120, z: -340 } as const;
const RD = 12;
const R = (RD - 4) * 16;

const dist = (p: { x: number; z: number }): number => Math.hypot(p.x - SPAWN.x, p.z - SPAWN.z);
const above = (p: { x: number; y: number; z: number }): number => p.y - ground(p.x, p.z);

describe('flightWaypoints (SP4a spec §9.5)', () => {
  test('eight waypoints, all within (rd − 4)·16 of the spawn and 20-80 blocks above MOTION_BLOCKING', () => {
    const w = flightWaypoints(SPAWN, RD, ground, () => false);
    expect(w).toHaveLength(8);
    for (const p of w) {
      expect(dist(p)).toBeLessThanOrEqual(R);
      expect(above(p)).toBeGreaterThanOrEqual(20);
      expect(above(p)).toBeLessThanOrEqual(80);
    }
    // A deterministic loop: the same inputs give the same waypoints.
    expect(flightWaypoints(SPAWN, RD, ground, () => false)).toEqual(w);
  });

  test('with no water in the disc, no waypoint flies the low leg', () => {
    expect(flightWaypoints(SPAWN, RD, ground, () => false).filter((p) => above(p) === 20)).toEqual([]);
  });

  test('when the disc has water, exactly one waypoint is 20 above it, over the water', () => {
    // A sea east of x = spawn + 60.
    const water = (x: number, _z: number): boolean => x > SPAWN.x + 60;
    const w = flightWaypoints(SPAWN, RD, ground, water);
    expect(w).toHaveLength(8);
    const low = w.filter((p) => above(p) === 20);
    expect(low).toHaveLength(1);
    expect(water(low[0]!.x, low[0]!.z)).toBe(true);
    for (const p of w) {
      expect(dist(p)).toBeLessThanOrEqual(R);
      expect(above(p)).toBeGreaterThanOrEqual(20);
      expect(above(p)).toBeLessThanOrEqual(80);
    }
  });

  test('water outside the flight disc is not used', () => {
    const far = (x: number, _z: number): boolean => x > SPAWN.x + R + 1;
    expect(flightWaypoints(SPAWN, RD, ground, far).filter((p) => above(p) === 20)).toEqual([]);
  });
});

describe('catmullRom (SP4a spec §9.5; ruling P42)', () => {
  test('the closed spline passes through every waypoint', () => {
    const w = flightWaypoints(SPAWN, RD, ground, (x) => x > SPAWN.x + 60);
    for (let i = 0; i < w.length; i++) {
      const p = catmullRom(w, i / w.length);
      expect(p.x).toBeCloseTo(w[i]!.x, 9);
      expect(p.y).toBeCloseTo(w[i]!.y, 9);
      expect(p.z).toBeCloseTo(w[i]!.z, 9);
    }
    // Closed: u 1 is u 0 again.
    const a = catmullRom(w, 0);
    const b = catmullRom(w, 1);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
  });

  test('the yaw follows the tangent: +x gives yaw 90, −z gives yaw 0; a level tangent gives pitch 0', () => {
    // At P0 the tangent is (P1 − P3)/2 = +x; at P1 it is (P2 − P0)/2 = −z.
    const square = [{ x: 0, y: 50, z: 0 }, { x: 10, y: 50, z: -10 }, { x: 0, y: 50, z: -20 }, { x: -10, y: 50, z: -10 }];
    const p0 = catmullRom(square, 0);
    expect(p0.yaw).toBeCloseTo(90, 9);
    expect(p0.pitch).toBeCloseTo(0, 9);
    const p1 = catmullRom(square, 0.25);
    expect(p1.yaw).toBeCloseTo(0, 9);
    for (let k = 0; k < 64; k++) {
      const p = catmullRom(square, k / 64);
      expect(p.yaw).toBeGreaterThanOrEqual(0);
      expect(p.yaw).toBeLessThan(360);
    }
  });

  test('a climbing tangent gives a positive pitch of atan2(dy, hypot(dx, dz))', () => {
    // At P0 the tangent is (P1 − P3)/2 = (10, 10, 0): 45° up, facing +x.
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 0, z: 20 }, { x: -10, y: -10, z: 0 }];
    const p = catmullRom(pts, 0);
    expect(p.pitch).toBeCloseTo(45, 9);
    expect(p.yaw).toBeCloseTo(90, 9);
  });
});

describe('cameraPitch (the flight looks at the world)', () => {
  test('−10° on a level leg, half the tangent around it, never above the horizon nor below −20°', () => {
    expect(cameraPitch(0)).toBe(-10);
    expect(cameraPitch(10)).toBe(-5);
    expect(cameraPitch(-10)).toBe(-15);
    for (let p = -90; p <= 90; p += 5) {
      expect(cameraPitch(p)).toBeGreaterThanOrEqual(-20);
      expect(cameraPitch(p)).toBeLessThanOrEqual(0);
    }
  });
});

/** The extra figures of a flight: a Chrome-like run, with or without the timer query. */
function extra(n: number, gpu: Float64Array | null): FlightExtra {
  return {
    seed: '42',
    profile: 'default',
    rd: 12,
    workers: 6,
    sectionRenderer: 'batch',
    userAgent: 'test',
    renderer: 'ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6)',
    vendor: 'Google Inc. (Intel)',
    multiDraw: true,
    timerQuery: gpu !== null,
    screen: { width: 1920, height: 1080 },
    dpr: 1,
    pixelRatio: 1,
    load: { revealMs: 9000, stageMs: { T: 2000, D: 4000, L: 6000, MESH: 8000 }, mergeMs: 0, longTasks: { count: 3, maxMs: 80 }, first120MaxMs: 20 },
    gpuMs: gpu,
    drawCalls: Float64Array.from({ length: n }, (_, i) => 20 + (i % 3)),
    triangles: Float64Array.from({ length: n }, (_, i) => 1_000_000 + i),
    heapMB: 120,
    sabMB: 64,
    durationMs: 60_000,
    waypoints: [{ x: 0, y: 100, z: 0 }],
    waypointsAbove: [36],
  };
}

/** 60 Hz deltas with ±0.8 ms of deterministic jitter. */
function jittered(n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => 16.667 + 0.8 * Math.sin(i * 12.9898));
}

describe('summarizeFlight (SP4a spec §9.5; ruling P9)', () => {
  const I = 16.667;

  test('60 Hz frames with jitter: p50, p95, p99 and max are exactly one interval (snapped)', () => {
    const n = 3600;
    const r = summarizeFlight(jittered(n), new Float64Array(n).fill(2), I, extra(n, Float64Array.from([3, 4, 5])));
    expect(r.frames.count).toBe(n);
    expect(r.frames.p95).toBe(16.667);
    expect(r.frames.p50).toBe(16.667);
    expect(r.frames.p99).toBe(16.667);
    expect(r.frames.max).toBe(16.667);
    expect(r.frames.over33).toBe(0);
    expect(r.displayIntervalMs).toBe(I);
  });

  test('frames over 33 ms are counted after snapping, and the long frames name the frame before', () => {
    const n = 100;
    const frames = jittered(n);
    frames[10] = 33.2; // snaps to 2 × 16.667 = 33.334 > 33
    frames[20] = 50.5; // snaps to 3 × 16.667
    const main = Float64Array.from({ length: n }, (_, i) => i / 10);
    const r = summarizeFlight(frames, main, I, extra(n, null));
    expect(r.frames.over33).toBe(2);
    expect(r.frames.max).toBe(3 * I);
    expect(r.longFrames.map((f) => f.frame)).toEqual([10, 20]);
    expect(r.longFrames[0]!.prevMainMs).toBe(main[9]);
    expect(r.longFrames[0]!.mainMs).toBe(main[10]);
  });

  test('main-thread p50, p95 and max by nearest rank', () => {
    const n = 100;
    const main = Float64Array.from({ length: n }, (_, i) => i + 1);
    const r = summarizeFlight(jittered(n), main, I, extra(n, null));
    expect(r.main).toEqual({ p50: 50, p95: 95, max: 100 });
  });

  test('gpuMs: p50 and p95 with the timer query; null without it (Firefox)', () => {
    const n = 100;
    const gpu = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    const r = summarizeFlight(jittered(n), new Float64Array(n), I, extra(n, gpu));
    expect(r.gpuMs).toEqual({ p50: 50, p95: 95, samples: 100 });
    expect(summarizeFlight(jittered(n), new Float64Array(n), I, extra(n, null)).gpuMs).toBeNull();
  });

  test('draw calls max and mean, triangles max', () => {
    const n = 6;
    const r = summarizeFlight(jittered(n), new Float64Array(n), I, extra(n, null));
    expect(r.drawCalls).toEqual({ max: 22, mean: 21 });
    expect(r.triangles).toEqual({ max: 1_000_005 });
  });

  test('every key spec §9.5 lists is present', () => {
    const n = 10;
    const r = summarizeFlight(jittered(n), new Float64Array(n), I, extra(n, null)) as unknown as Record<string, unknown>;
    for (const key of [
      'route', 'seed', 'profile', 'rd', 'workers', 'sectionRenderer', 'userAgent', 'renderer', 'vendor', 'multiDraw',
      'timerQuery', 'screen', 'dpr', 'displayIntervalMs', 'load', 'frames', 'main', 'gpuMs', 'drawCalls', 'triangles',
      'heapMB', 'sabMB',
    ]) expect(r, key).toHaveProperty(key);
    expect(r['route']).toBe('flight=sp4a');
    expect(Object.keys(r['load'] as object).sort()).toEqual(['first120MaxMs', 'longTasks', 'mergeMs', 'revealMs', 'stageMs']);
    expect(Object.keys(r['frames'] as object).sort()).toEqual(['count', 'max', 'over33', 'p50', 'p95', 'p99']);
    expect(Object.keys(r['main'] as object).sort()).toEqual(['max', 'p50', 'p95']);
    expect(Object.keys(r['drawCalls'] as object).sort()).toEqual(['max', 'mean']);
    expect(r['screen']).toEqual({ width: 1920, height: 1080 });
    // The JSON round trip keeps every key (no undefined values).
    expect(Object.keys(JSON.parse(JSON.stringify(r)) as object).sort()).toEqual(Object.keys(r).sort());
  });
});

describe('flightInterval (the idle frames\' display interval, rulings R5 (a))', () => {
  test('the median of the idle deltas, or 1000/60 when it is not finite', () => {
    expect(flightInterval([4.1, 4.2, 4.3, 4.2, 4.2])).toBeCloseTo(4.2, 9);
    expect(flightInterval(new Array<number>(120).fill(Number.NaN))).toBe(1000 / 60);
    expect(flightInterval([])).toBe(1000 / 60);
  });
});

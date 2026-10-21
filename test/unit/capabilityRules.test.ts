import { afterEach, describe, expect, test, vi } from 'vitest';
import { probeGrowableSab, probeStoreReservation } from '../../src/engine/capabilities';
import { evaluateCapabilities, evaluateWorldCapabilities, type CapabilityReport, type CauseCode } from '../../src/engine/capabilityRules';

const OK: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
  growableSab: true, reservation: { blockBytes: 768 << 20, byteBytes: 512 << 20 },
  webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
  renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
};

const codes = (r: Partial<CapabilityReport>) => {
  const e = evaluateCapabilities({ ...OK, ...r });
  return { ok: e.ok, blocking: e.blocking.map((c) => c.code), warnings: e.warnings.map((c) => c.code) };
};

describe('evaluateCapabilities', () => {
  test('everything available → ok, no causes', () => {
    expect(codes({})).toEqual({ ok: true, blocking: [], warnings: [] });
  });

  test('insecure LAN access: secure context is named first', () => {
    const r = codes({ secureContext: false, pageIsolated: false, workerProbe: 'not-isolated', workerIsolated: false, sabShared: false });
    expect(r.ok).toBe(false);
    expect(r.blocking).toEqual<CauseCode[]>(['insecure-context', 'page-not-isolated', 'worker-not-isolated', 'sab-not-shared']);
    expect(evaluateCapabilities({ ...OK, secureContext: false }).blocking[0]!.message).toMatch(/http:\/\/localhost:<port> or HTTPS/);
  });

  test('a worker that fails to load is not reported as missing headers', () => {
    expect(codes({ workerProbe: 'load-error', workerIsolated: null, sabShared: false }).blocking).toEqual(['worker-load-error', 'sab-not-shared']);
  });

  test('a worker that does not answer is reported as a timeout', () => {
    const e = evaluateCapabilities({ ...OK, workerProbe: 'timeout', workerIsolated: null, sabShared: false });
    expect(e.blocking.map((c) => c.code)).toEqual(['worker-timeout', 'sab-not-shared']);
    expect(e.blocking[0]!.message).toMatch(/5 s/);
  });

  test('worker without headers', () => {
    expect(codes({ workerProbe: 'not-isolated', workerIsolated: false, sabShared: false }).blocking).toEqual(['worker-not-isolated', 'sab-not-shared']);
  });

  test('no WebGL2 blocks; missing extensions only warn', () => {
    expect(codes({ webgl2: false, multiDraw: false, timerQuery: false })).toEqual({ ok: false, blocking: ['no-webgl2'], warnings: [] });
    expect(codes({ multiDraw: false, timerQuery: false })).toEqual({ ok: true, blocking: [], warnings: ['no-multi-draw', 'no-timer-query'] });
  });

  test('the ?map rules are unchanged: no growable SAB and no reservation are not its causes', () => {
    expect(codes({ growableSab: false, reservation: null })).toEqual({ ok: true, blocking: [], warnings: [] });
    expect(codes({ sabShared: false, growableSab: false, reservation: null }).blocking).toEqual(['sab-not-shared']);
  });
});

const worldCodes = (r: Partial<CapabilityReport>) => {
  const e = evaluateWorldCapabilities({ ...OK, ...r });
  return { ok: e.ok, blocking: e.blocking.map((c) => c.code), warnings: e.warnings.map((c) => c.code) };
};

describe('evaluateWorldCapabilities (SP4a spec §8.5)', () => {
  test('everything available → ok, no causes', () => {
    expect(worldCodes({})).toEqual({ ok: true, blocking: [], warnings: [] });
  });

  test('no-growable-sab and no-reservation block the world page', () => {
    expect(worldCodes({ growableSab: false })).toEqual({ ok: false, blocking: ['no-growable-sab'], warnings: [] });
    expect(worldCodes({ reservation: null })).toEqual({ ok: false, blocking: ['no-reservation'], warnings: [] });
    expect(worldCodes({ growableSab: false, reservation: null }).blocking).toEqual(['no-growable-sab', 'no-reservation']);
    const e = evaluateWorldCapabilities({ ...OK, growableSab: false, reservation: null });
    expect(e.blocking[0]!.message).toMatch(/grow/i);
    expect(e.blocking[1]!.message).toMatch(/192 MiB/);
  });

  test("today's blocking causes come first, in today's order", () => {
    expect(worldCodes({ pageIsolated: false, sabShared: false, growableSab: false, reservation: null, webgl2: false }).blocking)
      .toEqual(['page-not-isolated', 'sab-not-shared', 'no-webgl2', 'no-growable-sab', 'no-reservation']);
  });

  test('a reduced reservation does not block', () => {
    expect(worldCodes({ reservation: { blockBytes: 192 << 20, byteBytes: 128 << 20 } }).ok).toBe(true);
  });

  test('no-multi-draw is a warning whose text names RegionMesh', () => {
    const e = evaluateWorldCapabilities({ ...OK, multiDraw: false });
    expect(e.ok).toBe(true);
    expect(e.warnings.map((c) => c.code)).toEqual(['no-multi-draw']);
    expect(e.warnings[0]!.message).toBe('WEBGL_multi_draw is missing: the world renders through the per-region path (RegionMesh)');
  });

  test('no-timer-query is a warning: frame timing is CPU-side only', () => {
    const e = evaluateWorldCapabilities({ ...OK, timerQuery: false });
    expect(e.ok).toBe(true);
    expect(e.warnings.map((c) => c.code)).toEqual(['no-timer-query']);
    expect(e.warnings[0]!.message).toBe('GPU time unavailable; frame timing is CPU-side only');
  });
});

describe('the growable-SAB and reservation probes (SP4a spec §8.5)', () => {
  const MIB = 1 << 20;
  const RealSab = SharedArrayBuffer;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A SharedArrayBuffer that refuses a maxByteLength above `limit`. */
  const refusingAbove = (limit: number) => function Sab(length: number, opts?: { maxByteLength?: number }) {
    if ((opts?.maxByteLength ?? 0) > limit) throw new RangeError('Array buffer allocation failed');
    return new RealSab(length, opts);
  };

  test('Node grows a SharedArrayBuffer and accepts the full reservation', () => {
    expect(probeGrowableSab()).toBe(true);
    expect(probeStoreReservation()).toEqual({ blockBytes: 768 * MIB, byteBytes: 512 * MIB });
  });

  test('a refused reservation halves, down to (192, 128) MiB, then null', () => {
    vi.stubGlobal('SharedArrayBuffer', refusingAbove(384 * MIB));
    expect(probeStoreReservation()).toEqual({ blockBytes: 384 * MIB, byteBytes: 256 * MIB });
    vi.stubGlobal('SharedArrayBuffer', refusingAbove(200 * MIB));
    expect(probeStoreReservation()).toEqual({ blockBytes: 192 * MIB, byteBytes: 128 * MIB });
    vi.stubGlobal('SharedArrayBuffer', refusingAbove(191 * MIB));
    expect(probeStoreReservation()).toBeNull();
  });

  test('a fixed-length SharedArrayBuffer (options ignored) or none at all reads as not growable', () => {
    vi.stubGlobal('SharedArrayBuffer', function Sab(length: number) { return new RealSab(length); });
    expect(probeGrowableSab()).toBe(false);
    vi.stubGlobal('SharedArrayBuffer', undefined);
    expect(probeGrowableSab()).toBe(false);
    expect(probeStoreReservation()).toBeNull();
  });
});

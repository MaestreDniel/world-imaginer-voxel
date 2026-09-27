import { describe, expect, test } from 'vitest';
import { evaluateCapabilities, type CapabilityReport, type CauseCode } from '../../src/engine/capabilityRules';

const OK: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
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
});

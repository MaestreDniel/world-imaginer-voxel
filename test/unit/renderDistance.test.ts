import { describe, expect, test } from 'vitest';
import type { CapabilityReport } from '../../src/engine/capabilityRules';
import {
  clampRenderDistance, defaultRenderDistance, isSoftwareRenderer, lowerRd, RD_MAX, RD_MIN, reservationRdCap, resolveRenderDistance,
} from '../../src/engine/renderDistance';
import { lowerRd as noticeLowerRd } from '../../src/ui/world/frameNotice';

const MIB = 1 << 20;
const FULL = { blockBytes: 768 * MIB, byteBytes: 512 * MIB };
const HALF = { blockBytes: 384 * MIB, byteBytes: 256 * MIB };
const QUARTER = { blockBytes: 192 * MIB, byteBytes: 128 * MIB };

/** The user's laptop on Chrome (Iris Xe): every capability, the full reservation. */
const BASE: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
  growableSab: true, reservation: FULL,
  webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
  renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
};
const report = (r: Partial<CapabilityReport>): CapabilityReport => ({ ...BASE, ...r });

describe('defaultRenderDistance (SP4a spec §8.5)', () => {
  test('"Mesa Intel Iris Xe" with 20 cores and no deviceMemory (Firefox) → 12', () => {
    expect(defaultRenderDistance(report({ renderer: 'Mesa Intel Iris Xe', hardwareConcurrency: 20, deviceMemory: null }))).toBe(12);
  });

  test('4 cores → 8', () => {
    expect(defaultRenderDistance(report({ hardwareConcurrency: 4 }))).toBe(8);
  });

  test('deviceMemory 4 → 8', () => {
    expect(defaultRenderDistance(report({ deviceMemory: 4 }))).toBe(8);
  });

  test('a SwiftShader string → 6', () => {
    expect(defaultRenderDistance(report({ renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' }))).toBe(6);
  });

  test('"NVIDIA GeForce GTX 980, or similar" (Firefox\'s mask) → 12', () => {
    expect(defaultRenderDistance(report({ renderer: 'NVIDIA GeForce GTX 980, or similar', deviceMemory: null }))).toBe(12);
  });

  test('reservation (384, 256) → 8 and (192, 128) → 6', () => {
    expect(defaultRenderDistance(report({ reservation: HALF }))).toBe(8);
    expect(defaultRenderDistance(report({ reservation: QUARTER }))).toBe(6);
  });

  test('unknown cores, memory and renderer count as unknown, not weak', () => {
    expect(defaultRenderDistance(report({ hardwareConcurrency: null, deviceMemory: null, renderer: null }))).toBe(12);
  });
});

describe('isSoftwareRenderer', () => {
  test('names a software rasteriser', () => {
    for (const s of ['SwiftShader', 'llvmpipe (LLVM 17.0.6, 256 bits)', 'softpipe', 'Microsoft Basic Render Driver Software']) {
      expect(isSoftwareRenderer(s)).toBe(true);
    }
    for (const s of ['Mesa Intel(R) Graphics (ADL GT2)', 'NVIDIA GeForce RTX 3060 Laptop GPU', 'NVIDIA GeForce GTX 980, or similar']) {
      expect(isSoftwareRenderer(s)).toBe(false);
    }
  });
});

describe('clampRenderDistance', () => {
  test('clampRenderDistance(20, 16) is 16 and clampRenderDistance(2, 16) is 4', () => {
    expect(clampRenderDistance(20, 16)).toBe(16);
    expect(clampRenderDistance(2, 16)).toBe(4);
    expect(RD_MIN).toBe(4);
    expect(RD_MAX).toBe(16);
  });

  test('clampRenderDistance(16, 6) is 6', () => {
    expect(clampRenderDistance(16, 6)).toBe(6);
  });

  test('returns an integer', () => {
    expect(clampRenderDistance(9.6, 16)).toBe(10);
    expect(clampRenderDistance(Number.NaN, 16)).toBe(RD_MIN);
  });
});

describe('reservationRdCap and resolveRenderDistance (ruling P36)', () => {
  test('reservationRdCap gives 16 at (768, 512) MiB, 8 at (384, 256), 6 at (192, 128) and 6 for null', () => {
    expect(reservationRdCap(FULL)).toBe(16);
    expect(reservationRdCap(HALF)).toBe(8);
    expect(reservationRdCap(QUARTER)).toBe(6);
    expect(reservationRdCap(null)).toBe(6);
  });

  test('under (384, 256), a query of 16 gives 8 and a setting of 16 gives 8', () => {
    const r = report({ reservation: HALF });
    expect(resolveRenderDistance(r, 16, null)).toBe(8);
    expect(resolveRenderDistance(r, null, 16)).toBe(8);
  });

  test('under the full reservation, a query of 10 with a setting of 6 gives 10', () => {
    expect(resolveRenderDistance(BASE, 10, 6)).toBe(10);
  });

  test('no query and a setting of 6 gives 6', () => {
    expect(resolveRenderDistance(BASE, null, 6)).toBe(6);
  });

  test('no query and no setting gives defaultRenderDistance(r)', () => {
    for (const r of [BASE, report({ hardwareConcurrency: 4 }), report({ renderer: 'llvmpipe' }), report({ reservation: HALF })]) {
      expect(resolveRenderDistance(r, null, null)).toBe(defaultRenderDistance(r));
    }
  });
});

describe('lowerRd (SP4a ruling P49; moved to engine for the coordinator\'s StoreFull event, SP4b spec §3.6)', () => {
  test('lowerRd(12) 10, lowerRd(5) 4, lowerRd(4) null', () => {
    expect(lowerRd(12)).toBe(10);
    expect(lowerRd(5)).toBe(4);
    expect(lowerRd(4)).toBeNull();
  });

  test('frameNotice re-exports the same function', () => {
    expect(noticeLowerRd).toBe(lowerRd);
  });
});

import { describe, expect, test } from 'vitest';
import {
  chromeArgs, flightLine, gpuMatches, launchEnv, MEASURE_LOAD_MAX, outputName, parseMeasureArgs, routePath, viewportProblem, type MeasureArgs,
} from '../tools/measureChrome';

const IRIS = 'ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6)';
const RTX = 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))';

const args = (o: Partial<MeasureArgs>): MeasureArgs => ({ route: 'spike', gpu: 'iris', workers: null, skipBuild: false, renderer: null, probeOnly: false, ...o });

describe('measureChrome: arguments (SP4a spec §9.5)', () => {
  test('the route, the GPU and 4 workers; --probe-only sets probeOnly', () => {
    expect(parseMeasureArgs(['--route', 'flight', '--gpu', 'rtx', '--workers', '4']))
      .toEqual({ route: 'flight', gpu: 'rtx', workers: 4, skipBuild: false, renderer: null, probeOnly: false });
    expect(parseMeasureArgs(['--route', 'spike', '--gpu', 'iris', '--probe-only']).probeOnly).toBe(true);
    expect(parseMeasureArgs(['--route', 'spike', '--gpu', 'iris', '--skip-build', '--renderer', 'mesh']))
      .toEqual({ route: 'spike', gpu: 'iris', workers: null, skipBuild: true, renderer: 'mesh', probeOnly: false });
  });

  test('--gpu defaults to the gate machine, the Iris Xe', () => {
    expect(parseMeasureArgs(['--route', 'flight']).gpu).toBe('iris');
  });

  test('an unknown flag, a missing --route, --gpu amd, --workers 3 and a bad --renderer throw', () => {
    expect(() => parseMeasureArgs(['--route', 'spike', '--what'])).toThrow(/unknown argument --what/);
    expect(() => parseMeasureArgs(['--gpu', 'iris'])).toThrow(/--route/);
    expect(() => parseMeasureArgs(['--route', 'spike', '--gpu', 'amd'])).toThrow(/--gpu/);
    expect(() => parseMeasureArgs(['--route', 'flight', '--workers', '3'])).toThrow(/--workers/);
    expect(() => parseMeasureArgs(['--route', 'walk'])).toThrow(/--route/);
    expect(() => parseMeasureArgs(['--route', 'spike', '--renderer', 'webgpu'])).toThrow(/--renderer/);
    expect(() => parseMeasureArgs(['--route'])).toThrow(/--route needs a value/);
  });

  test('--workers 4 belongs to the flight route (the spike file has no -w4 name)', () => {
    expect(() => parseMeasureArgs(['--route', 'spike', '--workers', '4'])).toThrow(/--workers/);
  });

  test('the load limit is a 1-minute load average of 2', () => {
    expect(MEASURE_LOAD_MAX).toBe(2);
  });
});

describe('measureChrome: file names and routes', () => {
  test('outputName follows spec §1.2 and §9.5', () => {
    expect(outputName(args({ route: 'spike', gpu: 'iris' }))).toBe('spike-chrome-iris.json');
    expect(outputName(args({ route: 'spike', gpu: 'rtx' }))).toBe('spike-chrome-rtx.json');
    expect(outputName(args({ route: 'flight', gpu: 'iris' }))).toBe('flight-iris-chrome.json');
    expect(outputName(args({ route: 'flight', gpu: 'rtx' }))).toBe('flight-rtx-chrome.json');
    expect(outputName(args({ route: 'flight', gpu: 'iris', workers: 4 }))).toBe('flight-iris-chrome-w4.json');
  });

  test('a forced renderer never overwrites the probe-selected file', () => {
    expect(outputName(args({ route: 'flight', gpu: 'iris', renderer: 'mesh' }))).toBe('flight-iris-chrome-mesh.json');
    expect(outputName(args({ route: 'spike', gpu: 'rtx', renderer: 'batch' }))).toBe('spike-chrome-rtx-batch.json');
  });

  test('routePath: the spike or the flight, then &workers=4 and &renderer= when given', () => {
    expect(routePath(args({ route: 'spike' }))).toBe('/?spike=batch');
    expect(routePath(args({ route: 'flight' }))).toBe('/?flight=sp4a');
    expect(routePath(args({ route: 'flight', workers: 4, renderer: 'mesh' }))).toBe('/?flight=sp4a&workers=4&renderer=mesh');
    expect(routePath(args({ route: 'spike', renderer: 'batch' }))).toBe('/?spike=batch&renderer=batch');
  });
});

describe('measureChrome: the expected GPU', () => {
  test('gpuMatches names the Iris Xe or the RTX, never the other GPU or SwiftShader', () => {
    expect(gpuMatches('iris', IRIS)).toBe(true);
    expect(gpuMatches('rtx', RTX)).toBe(true);
    expect(gpuMatches('iris', RTX)).toBe(false);
    expect(gpuMatches('rtx', IRIS)).toBe(false);
    expect(gpuMatches('iris', SWIFTSHADER)).toBe(false);
    expect(gpuMatches('rtx', SWIFTSHADER)).toBe(false);
    expect(gpuMatches('rtx', '')).toBe(false);
  });

  test('launchEnv: the Iris Xe gets no variables; the RTX gets the offload variables unless PRIME is on nvidia (ruling P6)', () => {
    const offload = { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' };
    expect(launchEnv('iris', 'on-demand')).toEqual({});
    expect(launchEnv('iris', null)).toEqual({});
    expect(launchEnv('rtx', 'nvidia')).toEqual({});
    expect(launchEnv('rtx', 'on-demand')).toEqual(offload);
    expect(launchEnv('rtx', null)).toEqual(offload);
  });
});

describe('measureChrome: the headful window', () => {
  test('chromeArgs: 1920 × 1080 at scale 1, fullscreen, the GPU blocklist ignored, no SwiftShader and no headless', () => {
    for (const a of [args({}), args({ route: 'flight', gpu: 'rtx', workers: 4 })]) {
      const c = chromeArgs(a, '/tmp/wi10-x');
      expect(c).toContain('--window-size=1920,1080');
      expect(c).toContain('--force-device-scale-factor=1');
      expect(c).toContain('--ignore-gpu-blocklist');
      expect(c).toContain('--disable-backgrounding-occluded-windows');
      expect(c).toContain('--start-fullscreen');
      expect(c.filter((f) => /swiftshader/i.test(f))).toEqual([]);
      expect(c.filter((f) => f.startsWith('--headless'))).toEqual([]);
    }
  });

  test('viewportProblem: null only for exactly 1920 × 1080 at dpr 1 (ruling P7)', () => {
    expect(viewportProblem({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 })).toBeNull();
    expect(viewportProblem({ innerWidth: 1920, innerHeight: 987, devicePixelRatio: 1 })).toMatch(/1920.*987/);
    expect(viewportProblem({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1.25 })).toMatch(/1\.25/);
  });
});

describe('measureChrome: the flight summary line (ruling P9)', () => {
  test('frame p95, draw calls max and main p95, n/a where a field is missing', () => {
    expect(flightLine({ frames: { p95: 16.667 }, drawCalls: { max: 84 }, main: { p95: 2.5 } })).toBe('frame p95 16.667 ms, draw calls max 84, main p95 2.5 ms');
    expect(flightLine({ frames: {} })).toBe('frame p95 n/a, draw calls max n/a, main p95 n/a');
    expect(flightLine(null)).toBe('frame p95 n/a, draw calls max n/a, main p95 n/a');
  });
});

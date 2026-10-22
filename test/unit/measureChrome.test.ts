import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import {
  chromeArgs, flightLine, gpuMatches, launchEnv, MEASURE_LOAD_MAX, outputName, parseMeasureArgs, PLACE_ATTEMPTS, placeWindow, pollResult, routePath,
  viewportProblem, watchPage, windowProblem, withTimeout, type MeasureArgs, type WindowBounds,
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

  test('chromeArgs for --gpu rtx adds --use-angle=vulkan and --enable-features=Vulkan,VulkanFromANGLE', () => {
    for (const a of [args({ gpu: 'rtx' }), args({ route: 'flight', gpu: 'rtx', workers: 4 })]) {
      const c = chromeArgs(a, '/tmp/wi10-x');
      expect(c).toContain('--use-angle=vulkan');
      expect(c).toContain('--enable-features=Vulkan,VulkanFromANGLE');
    }
  });

  test('chromeArgs for --gpu iris has no --use-angle and no --enable-features', () => {
    for (const a of [args({}), args({ route: 'flight', workers: 4 })]) {
      const c = chromeArgs(a, '/tmp/wi10-x');
      expect(c.filter((f) => f.startsWith('--use-angle'))).toEqual([]);
      expect(c.filter((f) => f.startsWith('--enable-features'))).toEqual([]);
    }
  });

  test('at most one --enable-features flag', () => {
    // Chrome keeps only the last --enable-features, so a second one would silently drop the first one's features.
    for (const gpu of ['iris', 'rtx'] as const) {
      expect(chromeArgs(args({ gpu }), '/tmp/wi10-x').filter((f) => f.startsWith('--enable-features')).length).toBeLessThanOrEqual(1);
    }
  });

  test('viewportProblem: null only for exactly 1920 × 1080 at dpr 1 (ruling P7)', () => {
    expect(viewportProblem({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 })).toBeNull();
    expect(viewportProblem({ innerWidth: 1920, innerHeight: 987, devicePixelRatio: 1 })).toMatch(/1920.*987/);
    expect(viewportProblem({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1.25 })).toMatch(/1\.25/);
  });
});

describe('measureChrome: the window on the panel eDP-1 (ruling P59)', () => {
  const FULL_EDP = { left: 0, top: 0, width: 1920, height: 1080, windowState: 'fullscreen' } as const;
  const FULL_HDMI = { left: 1920, top: 0, width: 1920, height: 1080, windowState: 'fullscreen' } as const;
  const MAXIMIZED = { left: 0, top: 35, width: 1920, height: 1045, windowState: 'maximized' } as const;

  test('windowProblem: null only for a fullscreen window at (0, 0), and otherwise the bounds and the state', () => {
    expect(windowProblem(FULL_EDP)).toBeNull();
    expect(windowProblem(FULL_HDMI)).toMatch(/fullscreen at 1920,0/);
    expect(windowProblem(MAXIMIZED)).toMatch(/maximized at 0,35/);
    expect(windowProblem({ left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' })).toMatch(/normal/);
    expect(windowProblem({ windowState: 'fullscreen' })).not.toBeNull();
  });

  /** A fake window: `read` returns `states` in turn (the last one repeats); `set` and `sleep` are recorded. */
  const fakeWindow = (states: readonly WindowBounds[]) => {
    const sets: WindowBounds[] = [];
    let reads = 0;
    return {
      sets,
      reads: () => reads,
      control: {
        read: async () => states[Math.min(reads++, states.length - 1)]!,
        set: async (b: WindowBounds) => { sets.push(b); },
        sleep: async () => undefined,
      },
    };
  };
  const SEQUENCE = [{ windowState: 'normal' }, { left: 0, top: 0, width: 1920, height: 1080 }, { windowState: 'fullscreen' }];

  test('placeWindow leaves a window already fullscreen at (0, 0) alone', async () => {
    const w = fakeWindow([FULL_EDP]);
    expect(await placeWindow(w.control)).toEqual({ bounds: FULL_EDP, attempts: 0 });
    expect(w.sets).toEqual([]);
  });

  test('placeWindow moves a window fullscreen on HDMI-1-0 or maximized: normal, then (0, 0) 1920 × 1080, then fullscreen', async () => {
    for (const start of [FULL_HDMI, MAXIMIZED]) {
      // The window keeps its start bounds until the sequence's fullscreen step, then reads fullscreen at (0, 0).
      let placed = false;
      const w = fakeWindow([start]);
      w.control.read = async () => (placed ? FULL_EDP : start);
      w.control.set = async (b: WindowBounds) => { w.sets.push(b); if (b.windowState === 'fullscreen') placed = true; };
      expect(await placeWindow(w.control)).toEqual({ bounds: FULL_EDP, attempts: 1 });
      expect(w.sets).toEqual(SEQUENCE);
    }
  });

  test('placeWindow retries when a sequence does not take, and stops at PLACE_ATTEMPTS with the last bounds and the count', async () => {
    const stuck = { left: 0, top: 0, width: 1761, height: 991, windowState: 'normal' } as const;
    const w = fakeWindow([stuck]);
    expect(await placeWindow(w.control)).toEqual({ bounds: stuck, attempts: 3 });
    expect(PLACE_ATTEMPTS).toBe(3);
    expect(w.sets).toEqual([...SEQUENCE, ...SEQUENCE, ...SEQUENCE]);
  });

  test('placeWindow: a second attempt that takes ends the retries', async () => {
    let fullscreens = 0;
    const w = fakeWindow([MAXIMIZED]);
    w.control.read = async () => (fullscreens >= 2 ? FULL_EDP : MAXIMIZED);
    w.control.set = async (b: WindowBounds) => { w.sets.push(b); if (b.windowState === 'fullscreen') fullscreens++; };
    expect(await placeWindow(w.control)).toEqual({ bounds: FULL_EDP, attempts: 2 });
    expect(w.sets).toEqual([...SEQUENCE, ...SEQUENCE]);
  });
});

describe('measureChrome: the flight summary line (ruling P9)', () => {
  test('frame p95, draw calls max and main p95, n/a where a field is missing', () => {
    expect(flightLine({ frames: { p95: 16.667 }, drawCalls: { max: 84 }, main: { p95: 2.5 } })).toBe('frame p95 16.667 ms, draw calls max 84, main p95 2.5 ms');
    expect(flightLine({ frames: {} })).toBe('frame p95 n/a, draw calls max n/a, main p95 n/a');
    expect(flightLine(null)).toBe('frame p95 n/a, draw calls max n/a, main p95 n/a');
  });
});

describe('measureChrome: the result poll never hangs (Task 2 review, Important 1)', () => {
  const never = () => new Promise<never>(() => undefined);
  const fast = { pollMs: 1, callTimeoutMs: 20, timeoutMs: 60_000 };

  test('withTimeout passes a value through and rejects a promise that never settles', async () => {
    await expect(withTimeout(Promise.resolve(7), 20, 'x')).resolves.toBe(7);
    await expect(withTimeout(never(), 20, 'Runtime.evaluate')).rejects.toThrow(/Runtime\.evaluate timed out after 20 ms/);
  });

  test('pollResult returns the first non-null result', async () => {
    const reads = [null, null, '{"verdict":"pass"}'];
    await expect(pollResult({ ...fast, read: async () => reads.shift() ?? null, dead: () => null })).resolves.toBe('{"verdict":"pass"}');
  });

  test('a read that never settles (the closed socket) is bounded, and a dead Chrome then fails the poll', async () => {
    let calls = 0;
    const t0 = Date.now();
    await expect(pollResult({ ...fast, read: () => { calls++; return never(); }, dead: () => (calls > 0 ? 'Chrome exited (null) during the run' : null) }))
      .rejects.toThrow(/Chrome exited/);
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test('a dead page is refused before any read', async () => {
    let calls = 0;
    await expect(pollResult({ ...fast, read: async () => { calls++; return null; }, dead: () => 'the page crashed (Inspector.targetCrashed)' }))
      .rejects.toThrow(/targetCrashed/);
    expect(calls).toBe(0);
  });

  test('the overall timeout still fires when every read hangs, and names the last read error', async () => {
    await expect(pollResult({ pollMs: 1, callTimeoutMs: 10, timeoutMs: 60, read: never, dead: () => null }))
      .rejects.toThrow(/no result within 60 ms; last read error: Runtime\.evaluate timed out after 10 ms/);
    await expect(pollResult({ pollMs: 1, callTimeoutMs: 10, timeoutMs: 30, read: () => Promise.reject(new Error('page error: boom')), dead: () => null }))
      .rejects.toThrow(/last read error: page error: boom/);
  });

  test('watchPage: Chrome exiting, the target crashing or DevTools detaching mark the page lost and reject `lost`', async () => {
    const fake = () => {
      const listeners = new Map<string, (p: Record<string, unknown>) => void>();
      const proc = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
      return { cdp: { on: (m: string, fn: (p: Record<string, unknown>) => void) => { listeners.set(m, fn); } }, listeners, proc };
    };
    {
      const f = fake();
      const w = watchPage(f.cdp, f.proc as unknown as ChildProcess);
      expect(w.dead()).toBeNull();
      f.listeners.get('Inspector.targetCrashed')!({});
      expect(w.dead()).toMatch(/crashed/);
      await expect(w.lost).rejects.toThrow(/crashed/);
    }
    {
      const f = fake();
      const w = watchPage(f.cdp, f.proc as unknown as ChildProcess);
      f.proc.exitCode = 0;
      f.proc.emit('exit', 0, null);
      expect(w.dead()).toMatch(/Chrome exited/);
      await expect(w.lost).rejects.toThrow(/Chrome exited/);
    }
    {
      const f = fake();
      const w = watchPage(f.cdp, f.proc as unknown as ChildProcess);
      f.listeners.get('Inspector.detached')!({ reason: 'target_closed' });
      expect(w.dead()).toMatch(/detached.*target_closed/);
    }
    {
      const f = fake();
      const w = watchPage(f.cdp, f.proc as unknown as ChildProcess);
      f.proc.signalCode = 'SIGKILL';
      expect(w.dead()).toMatch(/Chrome exited/);
    }
  });
});

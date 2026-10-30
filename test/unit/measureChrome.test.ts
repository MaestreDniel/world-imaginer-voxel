import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { BENCH_SHOTS } from '../../src/ui/world/bench';
import { parseWorldQuery } from '../../src/ui/world/query';
import {
  ASSETS, benchLine, chromeArgs, drawnByProblem, endOfRunWarnings, ENTER_END_PATH, ENTER_NEW_WORLD_PATH, enterLine, enterOrder, enterPaths, enterSummary, flightLine, gpuMatches, launchEnv, machineTelemetry, MEASURE_LOAD_MAX, outputName,
  newWorldLeg, parseMeasureArgs, PLACE_ATTEMPTS, placeWindow, pollResult, routePath, shaderCacheOf, SHOTS, viewportProblem, watchPage, windowProblem, withTimeout, type EnterPair,
  type MeasureArgs, type WindowBounds,
} from '../tools/measureChrome';

const IRIS = 'ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6)';
const RTX = 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))';

const args = (o: Partial<MeasureArgs>): MeasureArgs => ({
  route: 'spike', gpu: 'iris', workers: null, skipBuild: false, renderer: null, probeOnly: false, shot: null, ...o,
});

describe('measureChrome: arguments (SP4a spec §9.5)', () => {
  test('the route, the GPU and 4 workers; --probe-only sets probeOnly', () => {
    expect(parseMeasureArgs(['--route', 'flight', '--gpu', 'rtx', '--workers', '4']))
      .toEqual({ route: 'flight', gpu: 'rtx', workers: 4, skipBuild: false, renderer: null, probeOnly: false, shot: null });
    expect(parseMeasureArgs(['--route', 'spike', '--gpu', 'iris', '--probe-only']).probeOnly).toBe(true);
    expect(parseMeasureArgs(['--route', 'spike', '--gpu', 'iris', '--skip-build', '--renderer', 'mesh']))
      .toEqual({ route: 'spike', gpu: 'iris', workers: null, skipBuild: true, renderer: 'mesh', probeOnly: false, shot: null });
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

  test('--workers 4 belongs to the flight and bench routes (the spike file has no -w4 name)', () => {
    expect(() => parseMeasureArgs(['--route', 'spike', '--workers', '4'])).toThrow(/--workers/);
  });

  test('the load limit is a 1-minute load average of 2', () => {
    expect(MEASURE_LOAD_MAX).toBe(2);
  });
});

describe('measureChrome: the bench route (SP4b spec §8.3, §8.7)', () => {
  test('parseMeasureArgs([\'--route\', \'bench\', \'--workers\', \'4\'])', () => {
    expect(parseMeasureArgs(['--route', 'bench', '--workers', '4']))
      .toEqual({ route: 'bench', gpu: 'iris', workers: 4, skipBuild: false, renderer: null, probeOnly: false, shot: null });
    expect(parseMeasureArgs(['--route', 'bench', '--gpu', 'iris', '--probe-only']).probeOnly).toBe(true);
    expect(parseMeasureArgs(['--route', 'bench', '--shot', 'fly96', '--renderer', 'mesh']))
      .toEqual({ route: 'bench', gpu: 'iris', workers: null, skipBuild: false, renderer: 'mesh', probeOnly: false, shot: 'fly96' });
  });

  test('--shot fly96 is refused without --route bench and without --renderer; an unknown shot is refused', () => {
    expect(() => parseMeasureArgs(['--route', 'flight', '--shot', 'fly96', '--renderer', 'batch'])).toThrow(/--shot applies to --route bench only/);
    expect(() => parseMeasureArgs(['--route', 'bench', '--shot', 'fly96'])).toThrow(/--shot needs --renderer batch\|mesh/);
    expect(() => parseMeasureArgs(['--route', 'bench', '--shot', 'fly200', '--renderer', 'batch'])).toThrow(/--shot must be one of/);
    expect(() => parseMeasureArgs(['--route', 'bench', '--shot'])).toThrow(/--shot needs a value/);
  });

  test('the shot names mirror bench.ts\'s, SP4c\'s four live shots and SP5a\'s four review scenes included (SP4c spec §8.7, SP5a spec §6.5)', () => {
    expect(SHOTS).toEqual(BENCH_SHOTS);
    expect(SHOTS.slice(-8, -4)).toEqual(['apply-before', 'apply-mid', 'apply-after', 'teleport']);
    expect(SHOTS.slice(-4)).toEqual(['build-day', 'build-night', 'walk-water', 'glass-water']);
    expect(parseMeasureArgs(['--route', 'bench', '--shot', 'apply-mid', '--renderer', 'mesh']).shot).toBe('apply-mid');
    expect(parseMeasureArgs(['--route', 'bench', '--shot', 'build-night', '--renderer', 'batch']).shot).toBe('build-night');
  });

  test('outputName for the bench, w4 and shot cases', () => {
    expect(outputName(args({ route: 'bench', gpu: 'iris' }))).toBe('bench-iris-chrome.json');
    expect(outputName(args({ route: 'bench', gpu: 'rtx' }))).toBe('bench-rtx-chrome.json');
    expect(outputName(args({ route: 'bench', gpu: 'iris', workers: 4 }))).toBe('bench-iris-chrome-w4.json');
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'mesh' }))).toBe('bench-iris-chrome-mesh.json');
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'batch', shot: 'fly96' }))).toBe('review-fly96-batch.png');
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'mesh', shot: 'rd12back' }))).toBe('review-rd12back-mesh.png');
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'mesh', shot: 'apply-mid' }))).toBe('review-apply-mid-mesh.png');
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'batch', shot: 'teleport' }))).toBe('review-teleport-batch.png');
    // SP5a's review scenes (spec §6.5): the renderer in the name, as every shot's.
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'batch', shot: 'glass-water' }))).toBe('review-glass-water-batch.png');
    expect(outputName(args({ route: 'bench', gpu: 'iris', renderer: 'batch', shot: 'build-day' }))).toBe('review-build-day-batch.png');
  });

  test('routePath with every flag', () => {
    expect(routePath(args({ route: 'bench' }))).toBe('/?bench=medium');
    expect(routePath(args({ route: 'bench', workers: 4 }))).toBe('/?bench=medium&workers=4');
    expect(routePath(args({ route: 'bench', workers: 4, renderer: 'mesh', shot: 'rd8' }))).toBe('/?bench=medium&workers=4&renderer=mesh&shot=rd8');
  });

  test('every route writes to assets/sp5b since SP5b (SP5b spec §6.2); SP4a\'s-SP5a\'s files stay where they are', () => {
    expect(ASSETS).toBe('docs/superpowers/specs/assets/sp5b');
    expect(ASSETS.endsWith('assets/sp5b')).toBe(true);
  });

  test('the bench summary line, read defensively', () => {
    expect(benchLine({ stream: { frames: { p95: 4.167, over33: 0 }, drawCalls: { max: 61 }, main: { p95: 2.1 }, gpuMB: 74.5, partialColumnFrames: 0 } }))
      .toBe('stream frame p95 4.167 ms, over 33 ms 0, draw calls max 61, main p95 2.1 ms, GPU MB 74.5, partial column frames 0');
    expect(benchLine(null)).toBe('stream frame p95 n/a, over 33 ms n/a, draw calls max n/a, main p95 n/a, GPU MB n/a, partial column frames n/a');
  });
});

/** A load's record (`window.__wiEnterResult`): an unsaved load has no storage figures. */
const loadOf = (revealMs: number, saved: boolean) => ({
  revealMs, idbOpenMs: saved ? revealMs / 100 : null, loadMs: saved ? revealMs / 20 : null, decodeMs: saved ? revealMs / 40 : null,
});

describe('measureChrome: the enter route (SP5b spec §6.2)', () => {
  test('`--route enter` parses; `--workers` and `--shot` refuse it', () => {
    expect(parseMeasureArgs(['--route', 'enter', '--gpu', 'rtx']))
      .toEqual({ route: 'enter', gpu: 'rtx', workers: null, skipBuild: false, renderer: null, probeOnly: false, shot: null });
    expect(parseMeasureArgs(['--route', 'enter']).gpu).toBe('iris');
    expect(() => parseMeasureArgs(['--route', 'enter', '--workers', '4'])).toThrow(/--workers 4 applies to --route flight or bench only/);
    expect(() => parseMeasureArgs(['--route', 'enter', '--shot', 'fly96', '--renderer', 'batch'])).toThrow(/--shot applies to --route bench only/);
    // The cell is the probe's renderer, as G1.enter reads it.
    expect(() => parseMeasureArgs(['--route', 'enter', '--renderer', 'mesh'])).toThrow(/--renderer does not apply to --route enter/);
    // A cold driver shader cache, as the flight and the bench.
    expect(shaderCacheOf(args({ route: 'enter' }))).toBe('cold');
    expect(routePath(args({ route: 'enter' }))).toBe('/?bench=enter');
    expect(ENTER_END_PATH).toBe('/?bench=enter&phase=end');
  });

  test('the enter route\'s new-world leg opens `/?enterBench=1&db=wi10-bench` and records `newWorldRevealMs`', async () => {
    expect(ENTER_NEW_WORLD_PATH).toBe('/?enterBench=1&db=wi10-bench');
    // The menu at that URL opens `wi10-bench`, and its Create's world URL carries both keys (the page's query honours `db` with `enterBench=1`).
    const q = parseWorldQuery(new URL(ENTER_NEW_WORLD_PATH, 'http://localhost/').searchParams);
    expect([q.enterBench, q.db, q.world]).toEqual([true, 'wi10-bench', null]);
    const steps: string[] = [];
    const ms = await newWorldLeg({
      open: async (path) => { steps.push(`open ${path}`); },
      click: async (id) => { steps.push(`click #${id}`); },
      result: async () => { steps.push('result'); return { revealMs: 2345.5, idbOpenMs: 3, loadMs: 12, decodeMs: 0.5 }; },
    });
    expect(steps).toEqual(['open /?enterBench=1&db=wi10-bench', 'click #start-new', 'click #new-create', 'result']);
    expect(ms).toBe(2345.5);
    // The page's `{ error }` stops the leg.
    await expect(newWorldLeg({ open: async () => {}, click: async () => {}, result: () => Promise.reject(new Error('the new world: the world did not load')) }))
      .rejects.toThrow(/the world did not load/);
    // The run's summary carries it.
    expect(enterSummary([], { gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: ms }).newWorldRevealMs).toBe(2345.5);
  });

  test('`outputName({ route: \'enter\', gpu: \'iris\' })` is `enter-iris-chrome.json` in `assets/sp5b/`', () => {
    expect(outputName(args({ route: 'enter', gpu: 'iris' }))).toBe('enter-iris-chrome.json');
    expect(outputName(args({ route: 'enter', gpu: 'rtx' }))).toBe('enter-rtx-chrome.json');
    expect(ASSETS).toBe('docs/superpowers/specs/assets/sp5b');
  });

  test('`enterRatio` of pairs whose first is 10× slower is the median of the five kept pairs\' ratios (the first discarded)', () => {
    const unsaved = [1000, 100, 104, 98, 102, 120];
    const saved = [1100, 105, 112, 101, 108, 140];
    const firstSlow = [10_000, ...unsaved.slice(1)];
    const pairs: EnterPair[] = firstSlow.map((u, i) => ({ unsaved: loadOf(u, false), saved: loadOf(i === 0 ? 10 * saved[0]! : saved[i]!, true) }));
    const s = enterSummary(pairs, { gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: null });
    // Kept: unsaved 100, 104, 98, 102, 120 → 102; saved 105, 112, 101, 108, 140 → 108.
    expect(s.kept).toBe(5);
    expect(s.medianUnsavedMs).toBe(102);
    expect(s.medianSavedMs).toBe(108);
    // The kept pairs' ratios b/a: 1.05, 1.0769, 1.0306, 1.0588, 1.1667; their median is pair 5's, 108 / 102.
    expect(s.pairRatios.slice(1)).toEqual([105 / 100, 112 / 104, 101 / 98, 108 / 102, 140 / 120]);
    expect(s.pairRatios[0]).toBeCloseTo(1.1, 12);
    expect(s.enterRatio).toBe(108 / 102);
    expect(s.pairs).toEqual(pairs);
    // The (b) loads' storage figures: medians over the kept pairs.
    expect([s.idbOpenMs, s.loadMs, s.decodeMs]).toEqual([1.08, 108 / 20, 108 / 40]);
    expect({ gpu: s.gpu, renderer: s.renderer, shaderCache: s.shaderCache, newWorldRevealMs: s.newWorldRevealMs }).toEqual({ gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: null });
    // The slow first pair changes nothing: the same kept pairs after a fast first pair give the same figures.
    const fast = enterSummary([{ unsaved: loadOf(1, false), saved: loadOf(1, true) }, ...pairs.slice(1)], { gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: null });
    expect([fast.enterRatio, fast.medianUnsavedMs, fast.medianSavedMs]).toEqual([s.enterRatio, s.medianUnsavedMs, s.medianSavedMs]);
    // The one-line summary (ruling P9), `n/a` where a figure is missing.
    expect(enterLine(s)).toBe('enterRatio 1.059, median (a) 102.0 ms, median (b) 108.0 ms, (b) idbOpen 1.1 ms, load 5.4 ms, decode 2.7 ms');
    expect(enterLine(enterSummary([], { gpu: 'iris', renderer: null, shaderCache: 'cold', newWorldRevealMs: null })))
      .toBe('enterRatio n/a, median (a) n/a, median (b) n/a, (b) idbOpen n/a, load n/a, decode n/a');
  });

  test('a clock step between the legs\' medians: `enterRatio` is the median of the per-pair ratios (1.05), not median (b) / median (a) (about 2)', () => {
    // Run 2 of the early measurement: the machine's clock halves after pair 3's (a), so median (a) falls before the step
    // and median (b) after it; each pair's two loads run back to back and keep their 1.05.
    const pairs: EnterPair[] = [[4000, 4200], [3400, 3570], [3400, 3570], [3400, 6825], [6500, 6825], [6500, 6825]]
      .map(([a, b]) => ({ unsaved: loadOf(a!, false), saved: loadOf(b!, true) }));
    const s = enterSummary(pairs, { gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: null });
    expect([s.medianUnsavedMs, s.medianSavedMs]).toEqual([3400, 6825]);
    expect(s.medianSavedMs! / s.medianUnsavedMs!).toBeGreaterThan(2);
    expect(s.enterRatio).toBeCloseTo(1.05, 12);
    // A pair without both loads gives no ratio, and the median reads the others; none at all gives null.
    const missing = enterSummary([pairs[0]!, { unsaved: loadOf(0, false), saved: loadOf(10, true) }, { unsaved: { ...loadOf(1, false), revealMs: null }, saved: loadOf(1, true) }, ...pairs.slice(1, 4)],
      { gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: null });
    expect(missing.pairRatios.slice(1, 3)).toEqual([null, null]);
    expect(missing.enterRatio).toBeCloseTo(1.05, 12);
    expect(enterSummary(pairs.slice(0, 1), { gpu: 'iris', renderer: IRIS, shaderCache: 'cold', newWorldRevealMs: null }).enterRatio).toBeNull();
  });

  test('the legs alternate within each pair: (a) then (b), then (b) then (a)', () => {
    expect(Array.from({ length: 6 }, (_, i) => enterOrder(i))).toEqual([
      ['unsaved', 'saved'], ['saved', 'unsaved'], ['unsaved', 'saved'], ['saved', 'unsaved'], ['unsaved', 'saved'], ['saved', 'unsaved'],
    ]);
  });

  test('each load\'s telemetry: the mean `scaling_cur_freq` over the CPUs in MHz and `x86_pkg_temp` in °C, null when unreadable', () => {
    const files = new Map<string, string>([
      ['/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', '2400000\n'],
      ['/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq', '1200000\n'],
      ['/sys/devices/system/cpu/cpu11/cpufreq/scaling_cur_freq', '900000\n'],
      // Not a CPU directory: never read.
      ['/sys/devices/system/cpu/cpufreq/scaling_cur_freq', '1\n'],
      ['/sys/class/thermal/thermal_zone0/type', 'acpitz\n'],
      ['/sys/class/thermal/thermal_zone0/temp', '30000\n'],
      ['/sys/class/thermal/thermal_zone5/type', 'x86_pkg_temp\n'],
      ['/sys/class/thermal/thermal_zone5/temp', '55500\n'],
    ]);
    const dirs = new Map<string, string[]>([
      // cpu2 has no cpufreq (offline): skipped.
      ['/sys/devices/system/cpu', ['cpu0', 'cpu1', 'cpu11', 'cpu2', 'cpufreq', 'cpuidle', 'online']],
      ['/sys/class/thermal', ['cooling_device0', 'thermal_zone0', 'thermal_zone5']],
    ]);
    const fs = {
      list: (dir: string) => { const d = dirs.get(dir); if (d === undefined) throw new Error(`ENOENT ${dir}`); return d; },
      read: (path: string) => { const f = files.get(path); if (f === undefined) throw new Error(`ENOENT ${path}`); return f; },
    };
    expect(machineTelemetry(fs)).toEqual({ cpuMHz: 1500, pkgTempC: 55.5 });
    // No sysfs (another OS, a sandbox): both null, nothing thrown.
    const none = { list: () => { throw new Error('EACCES'); }, read: () => { throw new Error('EACCES'); } };
    expect(machineTelemetry(none)).toEqual({ cpuMHz: null, pkgTempC: null });
    // A garbled reading is skipped, not averaged as NaN.
    files.set('/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq', 'n/a\n');
    files.set('/sys/class/thermal/thermal_zone5/temp', '\n');
    expect(machineTelemetry(fs)).toEqual({ cpuMHz: 1650, pkgTempC: null });
  });

  test('the (a) and (b) URLs carry the same pose', () => {
    const setup = { worldId: 'e1d0c9a8-0000-4000-8000-000000000001', pose: { x: -123, y: 120, z: 456, yaw: 45, pitch: -20 } };
    const p = enterPaths(setup);
    expect(p.unsaved).toBe('/?at=-123,456&y=120&yaw=45&pitch=-20&rd=12&enterBench=1');
    expect(p.saved).toBe(`/?world=${setup.worldId}&rd=12&enterBench=1&db=wi10-bench`);
    // (a) opens unsaved at the pose; (b) opens the saved world, whose state holds the same pose (bench.test.ts).
    const a = parseWorldQuery(new URLSearchParams(p.unsaved.slice(1)));
    expect({ x: a.at?.x, z: a.at?.z, y: a.y, yaw: a.yaw, pitch: a.pitch }).toEqual(setup.pose);
    expect([a.rd, a.enterBench, a.world, a.db]).toEqual([12, true, null, null]);
    const b = parseWorldQuery(new URLSearchParams(p.saved.slice(1)));
    expect([b.world, b.rd, b.enterBench, b.db, b.at, b.y, b.yaw, b.pitch]).toEqual([setup.worldId, 12, true, 'wi10-bench', null, null, null, null]);
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
    expect(launchEnv('iris', 'on-demand', 'warm')).toEqual({});
    expect(launchEnv('iris', null, 'warm')).toEqual({});
    expect(launchEnv('rtx', 'nvidia', 'warm')).toEqual({});
    expect(launchEnv('rtx', 'on-demand', 'warm')).toEqual(offload);
    expect(launchEnv('rtx', null, 'warm')).toEqual(offload);
  });

  test('launchEnv on a cold shader cache: the Iris Xe gets MESA_SHADER_CACHE_DISABLE=true, the RTX __GL_SHADER_DISK_CACHE=0 beside its offload variables (rulings R11)', () => {
    const offload = { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' };
    expect(launchEnv('iris', 'on-demand', 'cold')).toEqual({ MESA_SHADER_CACHE_DISABLE: 'true' });
    expect(launchEnv('iris', null, 'cold')).toEqual({ MESA_SHADER_CACHE_DISABLE: 'true' });
    expect(launchEnv('rtx', 'nvidia', 'cold')).toEqual({ __GL_SHADER_DISK_CACHE: '0' });
    expect(launchEnv('rtx', 'on-demand', 'cold')).toEqual({ ...offload, __GL_SHADER_DISK_CACHE: '0' });
  });

  test('shaderCacheOf: cold for the flight and the bench (its shots included), warm for the spike (rulings R11)', () => {
    expect(shaderCacheOf(args({ route: 'flight' }))).toBe('cold');
    expect(shaderCacheOf(args({ route: 'flight', gpu: 'rtx', workers: 4 }))).toBe('cold');
    expect(shaderCacheOf(args({ route: 'bench' }))).toBe('cold');
    expect(shaderCacheOf(args({ route: 'bench', shot: 'fly96', renderer: 'mesh' }))).toBe('cold');
    expect(shaderCacheOf(args({ route: 'spike' }))).toBe('warm');
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

describe('measureChrome: a shot\'s checks (final review GOV-8)', () => {
  const FULL_EDP = { left: 0, top: 0, width: 1920, height: 1080, windowState: 'fullscreen' } as const;
  const VIEWPORT = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 } as const;
  const clean = { loadAvg1After: 0.4, window: FULL_EDP, viewport: VIEWPORT, consoleErrors: [] } as const;

  test('drawnByProblem: null only when exactly one canvas names the --renderer in data-renderer', () => {
    expect(drawnByProblem('batch', ['batch'])).toBeNull();
    expect(drawnByProblem('mesh', ['mesh'])).toBeNull();
    expect(drawnByProblem('mesh', ['batch'])).toMatch(/data-renderer.*batch.*not mesh/);
    expect(drawnByProblem('batch', [])).toMatch(/no canvas/);
    expect(drawnByProblem('batch', ['batch', 'batch'])).toMatch(/2 canvases/);
  });

  test('endOfRunWarnings: none on a clean run; the load, the window, the viewport and the console each warn', () => {
    expect(endOfRunWarnings(clean, 'cell')).toEqual([]);
    expect(endOfRunWarnings({ ...clean, loadAvg1After: MEASURE_LOAD_MAX }, 'shot')).toEqual([]);
    expect(endOfRunWarnings({ ...clean, loadAvg1After: 2.5 }, 'shot'))
      .toEqual(['the load average rose to 2.50 during the run; rerun this shot on a quiet machine']);
    const moved = endOfRunWarnings({ ...clean, window: { left: 1920, top: 0, width: 1920, height: 1080, windowState: 'fullscreen' } }, 'shot');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^at the end of the run the window is fullscreen at 1920,0 .*; rerun this shot$/);
    const small = endOfRunWarnings({ ...clean, viewport: { innerWidth: 1920, innerHeight: 987, devicePixelRatio: 1 } }, 'cell');
    expect(small).toHaveLength(1);
    expect(small[0]).toMatch(/^at the end of the run the viewport is 1920x987@1.*; rerun this cell$/);
    expect(endOfRunWarnings({ ...clean, consoleErrors: ['exception: x', 'log: y'] }, 'cell'))
      .toEqual(['2 console error(s):\nexception: x\nlog: y']);
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

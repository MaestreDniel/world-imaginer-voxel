import { describe, expect, test } from 'vitest';
import { q15 } from '../../src/core/params/canonical';
import { LAYERS } from '../../src/gen/map/layers';
import { DEFAULT_MAP_STATE, encodeMapState } from '../../src/ui/map/mapState';
import { perfMapState, type PerfRecord } from '../../src/ui/map/perfHook';
import { compactJson, conditionResult, dragResult, knotY, MAP_LAYERS, maxGap, parseArgs, perfHash, scaleCycle, scaleSteps, summarize } from '../tools/mapLatency';

const rec = (id: number, inputAt: number, drawnAt: number | null, more: Partial<PerfRecord> = {}): PerfRecord => ({
  id, kind: 'set', path: 'shape.offset', inputAt, sessionEpoch: id, urgent: true, probe: null, poolEpoch: drawnAt === null ? null : id,
  configurePostedAt: inputAt + 1, readyAt: inputAt + 3, previewDoneAt: drawnAt === null ? null : drawnAt - 5, drawnAt,
  latencyMs: drawnAt === null ? null : drawnAt - inputAt, alreadyShown: false, ...more,
});

describe('latency runner: pure parts (SP2b spec §2.8)', () => {
  test('knot values are new for every edit of a page load, exact under q15 and between the knot\'s neighbours (72, 130)', () => {
    const ys = Array.from({ length: 2048 }, (_, k) => knotY(k));
    expect(new Set(ys).size).toBe(2048);
    expect(ys.every((y) => q15(y) === y && y > 72 && y < 130)).toBe(true);
    expect([knotY(0), knotY(64)]).toEqual([97, 98]);
  });

  test('the runner knows the map layers and its page hash is the page\'s own encoding of the perf state for every layer', () => {
    expect(MAP_LAYERS).toEqual(LAYERS);
    for (const layer of LAYERS) expect(perfHash(layer)).toBe(encodeMapState(perfMapState({ ...DEFAULT_MAP_STATE, view: { ...DEFAULT_MAP_STATE.view, layer } })));
  });

  test('summaries use nearest-rank percentiles, rounded to 0.1 ms', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(summarize(Array.from({ length: 20 }, (_, i) => 20 - i))).toEqual({ n: 20, p50: 10, p95: 19, max: 20 });
    expect(summarize([100.04, 7.25])).toEqual({ n: 2, p50: 7.3, p95: 100, max: 100 });
  });

  test('the largest gap of a drag counts from its first edit to the first landing and from the last landing to the release', () => {
    expect(maxGap(0, [100, 300, 900], 1000)).toBe(600);
    expect(maxGap(0, [], 3000)).toBe(3000);
    expect(maxGap(10, [400], 700)).toBe(390);
  });

  test('a drag\'s biome-size steps move one position at a time between 1 and 10', () => {
    const s = scaleSteps(5, 30);
    expect(s.slice(0, 12)).toEqual([6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(s.every((v, i) => v >= 1 && v <= 10 && Math.abs(v - (i === 0 ? 5 : s[i - 1]!)) === 1)).toBe(true);
    expect(scaleSteps(10, 2)).toEqual([9, 8]);
  });

  test('separate biome-size steps cycle through 1-10, so no position equals the one two steps before', () => {
    const s = scaleCycle(5, 30);
    expect(s.slice(0, 7)).toEqual([6, 7, 8, 9, 10, 1, 2]);
    const all = [5, ...s];
    expect(all.every((v, i) => i < 2 || (v !== all[i - 1] && v !== all[i - 2]))).toBe(true);
  });

  test('a condition passes when its max is at most 300 ms and it had no blank draw; ungated rows have pass null', () => {
    const ok = [rec(1, 0, 120), rec(2, 1000, 1300)];
    const r = conditionResult(ok, 0, true);
    expect(r).toMatchObject({ n: 2, p50: 120, p95: 300, max: 300, pass: true, blankDraws: 0, latencies: [120, 300] });
    expect(r.phases.posted).toEqual({ n: 2, p50: 1, p95: 1, max: 1 });
    expect(r.phases.barrier).toEqual({ n: 2, p50: 2, p95: 2, max: 2 });
    expect(r.phases.preview).toEqual({ n: 2, p50: 112, p95: 292, max: 292 });
    expect(r.phases.draw).toEqual({ n: 2, p50: 5, p95: 5, max: 5 });
    expect(conditionResult([...ok, rec(3, 2000, 2300.5)], 0, true).pass).toBe(false);
    expect(conditionResult(ok, 1, true).pass).toBe(false);
    expect(conditionResult(ok, 0, false).pass).toBeNull();
    expect(() => conditionResult([rec(4, 0, null)], 0, true)).toThrow(/did not land/);
  });

  test('a drag passes when every release is at most 300 ms and a preview landed at least every 500 ms', () => {
    const d = (begin: number, landings: number[], release: number) => ({ begin, end: begin + 3000, landings, release: rec(9, begin + 3000, begin + 3000 + release) });
    const good = dragResult([d(0, [150, 600, 1050, 1500, 1950, 2400, 2850], 140), d(5000, [5200, 5650, 6100, 6550, 7000, 7450, 7900], 0)], 0, true);
    expect(good).toMatchObject({ n: 2, releases: { n: 2, p50: 0, p95: 140, max: 140 }, releaseLatencies: [140, 0], maxGapMs: [450, 450], landings: [7, 7], pass: true });
    expect(dragResult([d(0, [150, 700, 1050, 1500, 1950, 2400, 2850], 140)], 0, true).pass).toBe(false);
    expect(dragResult([d(0, [150, 600, 1050, 1500, 1950, 2400, 2850], 301)], 0, true).pass).toBe(false);
    expect(dragResult([d(0, [150, 600, 1050, 1500, 1950, 2400, 2850], 140)], 2, true).pass).toBe(false);
    expect(dragResult([d(0, [], 140)], 0, false).pass).toBeNull();
  });

  test('the JSON puts arrays of primitives, and objects of primitives and such arrays, on one line', () => {
    const v = { a: [1, 2.5, 3], b: { c: ['x', 'y'], d: [] }, e: [{ f: 1 }, { g: { h: null } }], i: 'j', k: undefined };
    expect(compactJson(v)).toBe('{\n  "a": [1, 2.5, 3],\n  "b": {"c": ["x", "y"], "d": []},\n  "e": [\n    {"f": 1},\n    {\n      "g": {"h": null}\n    }\n  ],\n  "i": "j"\n}');
    expect(JSON.parse(compactJson(v))).toEqual(JSON.parse(JSON.stringify(v)));
  });

  test('arguments: biome and relief gated over 3 page loads with the reported rows by default', () => {
    expect(parseArgs([])).toEqual({ layers: ['biome', 'relief'], loads: 3, reported: true, build: true, quick: false, out: null, profileDir: null });
    expect(parseArgs(['--layers', 'relief', '--loads', '1', '--no-reported', '--skip-build', '--quick', '--out', '/tmp/x', '--profile-dir', '/tmp/p'])).toEqual({
      layers: ['relief'], loads: 1, reported: false, build: false, quick: true, out: '/tmp/x', profileDir: '/tmp/p',
    });
    expect(() => parseArgs(['--layers', 'nope'])).toThrow(/unknown layer nope/);
    expect(() => parseArgs(['--loads', '0'])).toThrow(/--loads/);
    expect(() => parseArgs(['--what'])).toThrow(/unknown argument --what/);
  });
});

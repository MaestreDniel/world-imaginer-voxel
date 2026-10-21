import { describe, expect, test } from 'vitest';
import type { StoreSpikeResult } from '../../src/engine/spikeStore';
import type { RenderSpikeResult, StaticResult } from '../../src/render/spike/spikeBench';
import { spikeVerdict, type SpikeResult } from '../../src/ui/spike/verdict';

const stat = (o: Partial<StaticResult> = {}): StaticResult => ({
  sectionRenderer: 'batch',
  multiDrawMasked: false,
  canvas: { width: 1920, height: 1080, pixelRatio: 1 },
  displayIntervalMs: 6.96,
  frames: 600,
  frame: { p50: 6.96, p95: 13.92, max: 20.88 },
  main: { p50: 1.2, p95: 2.1, max: 4 },
  drawCalls: 48,
  drawCallsMean: 40,
  trianglesMax: 900_000,
  longFrames: { count: 0, first: [] },
  error: null,
  ...o,
});

/** The items, writable so a case can swap one. */
type Items = { -readonly [K in keyof RenderSpikeResult]: RenderSpikeResult[K] };

const items = (): Items => ({
  scene: { columns: 489, sections: 3570, quads: 733_000, regions: 16 },
  decode: { words: 1024, mismatches: 0, firstMismatches: [], error: null },
  static: stat(),
  upload: { quads: 733_000, sections: 3570, buildMs: 300, msPer1kQuads: 0.4, firstRenderMs: 60, projectedRd12Seconds: 0.45, error: null },
  churn: {
    frames: 120, setGeometryPerFrame: 32, mainP95: 2.5, frameP95: 13.9, deleted: 32,
    optimize: [{ rx: 0, rz: 0, pass: 0, ms: 3, mb: 5 }], readdMs: 1, setGeometrySizeMs: 4, error: null,
  },
  noMultiDraw: stat({ multiDrawMasked: true, drawCalls: 3500 }),
});

const store = (o: Partial<StoreSpikeResult> = {}): StoreSpikeResult => ({
  reservedBlockMiB: 768, reservedByteMiB: 512, grewTo: { blockMiB: 37, byteMiB: 37 }, crossReadsOk: 384, crossReadsTotal: 384, errors: [], ...o,
});

const passing = (): SpikeResult => ({ items: items(), store: store() });

/** `passing()` with one change applied to a fresh copy. */
function breach(f: (r: { items: Items; store: StoreSpikeResult }) => void): SpikeResult {
  const r = { items: items(), store: store() };
  f(r);
  return r;
}

describe('spikeVerdict (SP4a spec §1.3)', () => {
  test('a passing fixture passes the gate and the basic criteria', () => {
    expect(spikeVerdict(passing())).toEqual({ gatePass: true, basicPass: true, failures: [] });
  });

  test.each([
    ['static p95', (r: { items: Items }) => { r.items.static = stat({ frame: { p50: 7, p95: 16.8, max: 30 } }); }],
    ['draw calls', (r: { items: Items }) => { r.items.static = stat({ drawCalls: 101 }); }],
    ['main-thread p95', (r: { items: Items }) => { r.items.static = stat({ main: { p50: 1, p95: 3.1, max: 5 } }); }],
    ['projected RD12 upload', (r: { items: Items }) => { r.items.upload = { ...r.items.upload, projectedRd12Seconds: 2.1 }; }],
  ] as const)('a breach of %s fails the gate, names it, and leaves basicPass true', (name, f) => {
    const v = spikeVerdict(breach(f));
    expect(v.gatePass).toBe(false);
    expect(v.basicPass).toBe(true);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain(name);
  });

  test('one decode mismatch fails both, naming the decode', () => {
    const v = spikeVerdict(breach((r) => { r.items.decode = { ...r.items.decode, mismatches: 1 }; }));
    expect(v.gatePass).toBe(false);
    expect(v.basicPass).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain('decode');
  });

  test('a store error fails both, naming the store', () => {
    const v = spikeVerdict(breach((r) => { r.store = store({ errors: ['worker 3: StoreFull'] }); }));
    expect(v.gatePass).toBe(false);
    expect(v.basicPass).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain('store');
    expect(v.failures[0]).toContain('worker 3: StoreFull');
  });

  test('a store cross read that does not match fails the basic criteria', () => {
    const v = spikeVerdict(breach((r) => { r.store = store({ crossReadsOk: 383 }); }));
    expect(v.basicPass).toBe(false);
    expect(v.failures.join('\n')).toContain('store');
  });

  test('basicPass ignores the frame criteria, all breached at once', () => {
    const v = spikeVerdict(breach((r) => {
      r.items.static = stat({ frame: { p50: 20, p95: 40, max: 80 }, drawCalls: 400, main: { p50: 5, p95: 9, max: 20 } });
      r.items.upload = { ...r.items.upload, projectedRd12Seconds: 5 };
    }));
    expect(v.basicPass).toBe(true);
    expect(v.gatePass).toBe(false);
    expect(v.failures).toHaveLength(4);
  });

  test('an item that failed to run fails its criteria with its error', () => {
    const v = spikeVerdict(breach((r) => { r.items.static = stat({ error: 'RegionMesh arrives in Task 22' }); }));
    expect(v.gatePass).toBe(false);
    expect(v.basicPass).toBe(true);
    expect(v.failures.join('\n')).toContain('RegionMesh arrives in Task 22');
    const d = spikeVerdict(breach((r) => { r.items.decode = { ...r.items.decode, error: 'no webgl2' }; }));
    expect(d.basicPass).toBe(false);
    expect(d.failures.join('\n')).toContain('decode');
  });

  test('exactly at the limits passes', () => {
    const v = spikeVerdict(breach((r) => {
      r.items.static = stat({ frame: { p50: 7, p95: 16.7, max: 30 }, drawCalls: 100, main: { p50: 1, p95: 3, max: 5 } });
      r.items.upload = { ...r.items.upload, projectedRd12Seconds: 2 };
    }));
    expect(v.gatePass).toBe(true);
  });
});

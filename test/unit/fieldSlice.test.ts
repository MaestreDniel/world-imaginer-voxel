import { describe, expect, test } from 'vitest';
import { DENSITY_COLUMN_COST_MAX, SLICE_RULE_NA } from '../../src/core/constants';
import type { GenContext } from '../../src/gen/context';
import { createDensityReference } from '../../src/gen/density/reference';
import { probe } from '../../src/gen/density/probe';
import { resolveDensity } from '../../src/gen/density/source';
import { densityColumnCost } from '../../src/gen/inspect/cost';
import {
  densityReferenceOf, evaluateFieldSlice, fieldSliceProblem, nodeReferenceOf, probeField, sliceSampleVoxel,
  type FieldSliceRequest, type FieldSliceValues, type SliceField, type SliceGeometry, type TColumnSource,
} from '../../src/gen/inspect/fieldSlice';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { surfaceProbe, surfaceProbeColumn } from '../../src/gen/surface/probe';
import { createSurfaceReference } from '../../src/gen/surface/reference';
import type { Condition } from '../../src/gen/surface/rules';
import { validateParamTrees } from '../../src/gen/trees';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { fillColumnT } from '../../src/metrics/region';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { createStore } from '../../src/world/store/store';
import { ctxFor, paramsWith } from '../harness/gen';
import { densityTree, heavyDetailPatch, terrainMuted } from './fixtures/editedTrees';

type Tree = Record<string, any>;
const MiB = 1 << 20;
const NEVER = (): boolean => false;

/** uiSmoke's mountain line and a coast line of the review slices (sea, beach and land at seed '42'; 64 chunk columns, so
 * one store holds them all on its 64 × 64 torus). */
const MOUNTAIN: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const COAST: Segment = { ax: -27136, az: -31992, bx: -26113, bz: -31992 };

const vertical = (s: Segment, n = 32): SliceGeometry => ({ plane: 'vertical', n, pointAt: (i) => segmentPointAt(s, i, n) });
const horizontal = (n = 32, extent = 256, cx = 0, cz = 0, y = 63): SliceGeometry => ({ plane: 'horizontal', n, cx, cz, y, extent });

const ctxWith = (tree: Tree): GenContext => ctxFor('42', { density: { defs: tree } } as never);

/** A T-column source over a store of its own: `fillColumnT` on first use (the T stage's states and fluid). */
function storeColumns(ctx: GenContext): TColumnSource {
  const store = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  return (cx, cz, stop) => {
    if (store.proto(cx, cz) === null && !fillColumnT(store, ctx, cx, cz, stop)) return null;
    return store.proto(cx, cz);
  };
}

function run(ctx: GenContext, geometry: SliceGeometry, field: SliceField, path = '', from = 0, to = geometry.n): FieldSliceValues {
  const r = evaluateFieldSlice(ctx, { geometry, field, path, from, to }, NEVER, field === 'blocks' ? storeColumns(ctx) : undefined);
  if (r === null) throw new Error('stopped');
  return r;
}

/** Every sample (c, k) of a part with its voxel and its value index. */
function* samples(g: SliceGeometry, from = 0, to = g.n): Generator<{ c: number; k: number; i: number; x: number; y: number; z: number }> {
  for (let c = from; c < to; c++) {
    for (let k = 0; k < g.n; k++) {
      const [x, y, z] = sliceSampleVoxel(g, c, k);
      yield { c, k, i: (c - from) * g.n + k, x, y, z };
    }
  }
}

const bytes = (v: FieldSliceValues): number[] => [...new Uint8Array(v.values.buffer)].concat(v.fluid === null ? [] : [...v.fluid]);

describe('evaluateFieldSlice: density (SP3d spec §4.1, §5.1)', () => {
  const ctx = ctxFor('42');
  const dc = surfaceContextOf(ctx).density;

  test.each([
    ['vertical, mountain line', vertical(MOUNTAIN)],
    ['horizontal, extent 256 at (0, 0), y 63', horizontal()],
    ['horizontal, extent 8192 at (-1152, 8), y 100', horizontal(32, 8192, -1152, 8, 100)],
  ])('%s: every sample equals the compiled probe at its voxel', (_name, g) => {
    const r = run(ctx, g, 'density');
    expect(r.field).toBe('density');
    expect(r.values).toBeInstanceOf(Float64Array);
    expect(r.values.length).toBe(32 * 32);
    let solid = 0;
    for (const { i, x, y, z } of samples(g)) {
      const want = probe(dc, x, y, z);
      if (!Object.is(r.values[i], want)) throw new Error(`(${x}, ${y}, ${z}): slice ${r.values[i]} probe ${want}`);
      if (want > 0) solid++;
    }
    if (g.plane === 'vertical') expect(solid).toBeGreaterThan(100);
  });

  test('a horizontal slice reads corner samples: the ColumnCache stays empty', () => {
    const fresh = ctxFor('42');
    run(fresh, horizontal(32, 2048), 'density');
    expect(surfaceContextOf(fresh).density.columns.size).toBe(0);
  });
});

describe('evaluateFieldSlice: node (SP3d spec §3.4)', () => {
  // The terrain tap muted to 0: its subtree leaves the resolved tree, but the inspector evaluates it from the source.
  const tree = terrainMuted(0);
  const ctx = ctxWith(tree);
  const noises = surfaceContextOf(ctx).density.noises;
  const path = 'root.a.a.x.x.a';

  /** The source subtree at `path` of the source tree, resolved on its own (inside interpolated, so wrapped). */
  const separately = createDensityReference(
    resolveDensity({ root: { op: 'interpolated', x: tree['root'].a.a.x.x.a }, defs: {} }, ctx.params),
    noises,
  );

  test.each([['vertical', vertical(MOUNTAIN)], ['horizontal', horizontal(32, 1024, -1152, 8, 90)]])(
    '%s: a node under a muted tap equals reference.voxel of its separately resolved subtree',
    (_name, g) => {
      const r = run(ctx, g, 'node', path);
      const d = run(ctx, g, 'density');
      const cols = surfaceContextOf(ctx).density.columns;
      let differs = 0;
      for (const { i, x, y, z } of samples(g)) {
        const want = separately.voxel(cols.get(x >> 4, z >> 4), x, y, z);
        if (!Object.is(r.values[i], want)) throw new Error(`(${x}, ${y}, ${z}): slice ${r.values[i]} separately ${want}`);
        if (!Object.is(r.values[i], d.values[i])) differs++;
      }
      expect(differs).toBeGreaterThan(500);
    },
  );

  test('a selected muted tap shows its subtree: equal to the unmuted tree\'s tap', () => {
    const plain = ctxFor('42');
    const g = vertical(MOUNTAIN);
    expect(bytes(run(ctx, g, 'node', 'root.a.a'))).toEqual(bytes(run(plain, g, 'node', 'root.a.a')));
    // While the density of the muted tree is the islands floor everywhere (terrain 0 + detail, max −1e6).
    expect(bytes(run(ctx, g, 'density'))).not.toEqual(bytes(run(plain, g, 'density')));
  });

  test('`root` is the final density', () => {
    const g = horizontal();
    expect(bytes(run(ctx, g, 'node', 'root'))).toEqual(bytes(run(ctx, g, 'density')));
  });
});

describe('evaluateFieldSlice: blocks and rule (SP3d spec §4.1)', () => {
  const ctx = ctxFor('42');
  const sc = surfaceContextOf(ctx);

  test('blocks equals the T stage\'s states and fluid, which agree with surfaceProbe and the probe column\'s water', () => {
    const g = vertical(COAST);
    const r = run(ctx, g, 'blocks');
    expect(r.field).toBe('blocks');
    expect(r.values).toBeInstanceOf(Uint16Array);
    const own = storeColumns(ctx);
    let water = 0;
    for (const { i, x, y, z } of samples(g)) {
      const view = own(x >> 4, z >> 4, NEVER)!;
      expect(r.values[i]).toBe(view.block(x & 15, y, z & 15));
      expect(r.fluid![i]).toBe(view.fluid(x & 15, y, z & 15));
      expect(r.values[i]).toBe(surfaceProbe(sc, x, y, z).state);
      const c = surfaceProbeColumn(sc, x >> 4, z >> 4);
      const at = ((y + 64) << 8) | ((z & 15) << 4) | (x & 15);
      expect(r.fluid![i]).toBe(c.solid[at] === 0 && c.water[at] !== 0 ? WATER_SOURCE : 0);
      if (r.fluid![i] !== 0) water++;
    }
    expect(water).toBeGreaterThan(20);
  });

  test('a rule mask: 1 where the voxel\'s rule path passes through the rule, n/a on air and water', () => {
    const g = vertical(COAST);
    let ones = 0, zeros = 0, naAir = 0, naWater = 0;
    for (const id of ['root.rules[2]', 'root', 'root.rules[1].then']) {
      expect(sc.reference.nodeAt(id)?.kind).toBe('rule');
      const r = run(ctx, g, 'rule', id);
      expect(r.values).toBeInstanceOf(Uint8Array);
      for (const { i, x, y, z } of samples(g)) {
        const c = surfaceProbeColumn(sc, x >> 4, z >> 4);
        const at = ((y + 64) << 8) | ((z & 15) << 4) | (x & 15);
        if (c.solid[at] === 0) {
          expect(r.values[i]).toBe(SLICE_RULE_NA);
          if (c.water[at] !== 0) naWater++;
          else naAir++;
          continue;
        }
        const want = surfaceProbe(sc, x, y, z).path.includes(id) ? 1 : 0;
        expect(r.values[i]).toBe(want);
        if (want === 1) ones++;
        else zeros++;
      }
    }
    expect([ones, zeros, naAir, naWater].every((v) => v > 20)).toBe(true);
  });

  test('a condition mask: 1 where the condition alone holds (whether the walk reaches it or not)', () => {
    const g = vertical(COAST);
    const conditionIds = ['root.rules[2].if', 'root.rules[1].then.rules[2].if', 'root.rules[1].then.rules[0].if.if'];
    for (const id of conditionIds) {
      const found = sc.reference.nodeAt(id);
      expect(found?.kind).toBe('condition');
      const alone = createSurfaceReference(ctx.seed, { kind: 'condition', if: (found as { condition: Condition }).condition, then: { kind: 'block', state: 'stone' } }, sc.noises);
      const r = run(ctx, g, 'rule', id);
      let ones = 0, zeros = 0;
      for (const { i, x, y, z } of samples(g)) {
        const c = surfaceProbeColumn(sc, x >> 4, z >> 4);
        const p = ((z & 15) << 4) | (x & 15);
        if (c.solid[((y + 64) << 8) | p] === 0) {
          expect(r.values[i]).toBe(SLICE_RULE_NA);
          continue;
        }
        const want = alone.evaluate(c.scan, sc.settings, p, y).path.length > 0 ? 1 : 0;
        expect(r.values[i]).toBe(want);
        if (want === 1) ones++;
        else zeros++;
      }
      expect(ones).toBeGreaterThan(0);
      expect(zeros).toBeGreaterThan(0);
    }
  });
});

describe('evaluateFieldSlice: parts and stop (SP3d spec §5.1, §5.2)', () => {
  const cases: Array<[string, SliceGeometry, SliceField, string]> = [
    ['density vertical', vertical(MOUNTAIN), 'density', ''],
    ['density horizontal', horizontal(32, 512, 100, -300, 70), 'density', ''],
    ['node vertical', vertical(MOUNTAIN), 'node', 'root.a.a.x.x.b'],
    ['node horizontal', horizontal(32, 512, 100, -300, 70), 'node', 'root.a.b'],
    ['blocks vertical', vertical(COAST), 'blocks', ''],
    ['rule vertical', vertical(COAST), 'rule', 'root.rules[1].then'],
  ];

  test.each(cases)('%s: the concatenated parts equal the whole, bit for bit, on another context', (_name, g, field, path) => {
    const whole = run(ctxFor('42'), g, field, path);
    const other = ctxFor('42');
    const parts = [[0, 7], [7, 8], [8, 32]].map(([from, to]) => run(other, g, field, path, from, to));
    expect(parts.flatMap((p) => [...new Uint8Array(p.values.buffer)])).toEqual([...new Uint8Array(whole.values.buffer)]);
    if (field === 'blocks') expect(parts.flatMap((p) => [...p.fluid!])).toEqual([...whole.fluid!]);
    expect(parts.map((p) => p.values.length)).toEqual([7 * 32, 32, 24 * 32]);
  });

  test.each(cases.filter(([, , f]) => f !== 'blocks'))('%s: stop() is polled once per sample, and a stop returns null', (_name, g, field, path) => {
    const ctx = ctxFor('42');
    let polls = 0;
    const req: FieldSliceRequest = { geometry: g, field, path, from: 3, to: 9 };
    expect(evaluateFieldSlice(ctx, req, () => { polls++; return false; })).not.toBeNull();
    // rule: plus 6 polls in each of the 6 probe-column builds (the density fill polls every 8 of its 48 corner rows).
    expect(polls).toBe(field === 'rule' ? 6 * 32 + 6 * 6 : 6 * 32);
    let left = 40;
    expect(evaluateFieldSlice(ctx, req, () => --left < 0)).toBeNull();
    expect(left).toBe(-1);
  });

  test('a rule part, and a rule probe, stop within 50 ms of stop() on a heavy valid tree: the probe column\'s build polls it', () => {
    // heavyDetailPatch: tier-2 valid, its probe column takes about 0.1 s to build (its density fill), which the part
    // must not finish once stop() is true.
    const patch = heavyDetailPatch(32);
    const params = paramsWith(patch);
    expect(validateParamTrees(params)).toEqual([]);
    const cost = densityColumnCost(params.density.defs);
    expect(cost).toBeGreaterThan(400_000_000);
    expect(cost).toBeLessThanOrEqual(DENSITY_COLUMN_COST_MAX);
    // A 32-sample line whose sample columns lie in distinct chunk columns. stop() turns true right after the poll that
    // precedes the second column's build: the 32nd poll made while the cache holds the first column (its samples 1-31,
    // then sample 0 of the second column).
    const g = vertical({ ax: 0, az: 0, bx: 4000, bz: 300 });
    for (let trial = 0; trial < 2; trial++) {
      const ctx = ctxFor('42', patch);
      const cache = surfaceContextOf(ctx).probeColumn;
      let held = 0;
      let firedAt = 0;
      const stop = (): boolean => {
        if (firedAt > 0) return true;
        if (cache.valid && ++held === 32) firedAt = performance.now();
        return false;
      };
      expect(evaluateFieldSlice(ctx, { geometry: g, field: 'rule', path: 'root.rules[1].then', from: 0, to: 32 }, stop)).toBeNull();
      const latency = performance.now() - firedAt;
      expect(latency, `rule part, trial ${trial}: ${latency.toFixed(1)} ms`).toBeLessThan(50);
      // The abandoned build leaves the one-column cache empty, so the next request rebuilds that column.
      expect(cache.valid).toBe(false);
      // A rule probe on another column: stop() turns true right after the poll before its build.
      let probePolls = 0;
      let probeFired = 0;
      const probeStop = (): boolean => {
        probePolls++;
        if (probePolls === 1) { probeFired = performance.now(); return false; }
        return true;
      };
      expect(probeField(ctx, 'rule', 'root', 2000 + 64 * trial, 90, 150, probeStop)).toBeNull();
      const probeLatency = performance.now() - probeFired;
      expect(probeLatency, `rule probe, trial ${trial}: ${probeLatency.toFixed(1)} ms`).toBeLessThan(50);
    }
  });

  test('blocks: a stop inside the T-column source or between samples returns null', () => {
    const ctx = ctxFor('42');
    const req: FieldSliceRequest = { geometry: vertical(COAST), field: 'blocks', path: '', from: 0, to: 4 };
    expect(evaluateFieldSlice(ctx, req, () => true, storeColumns(ctx))).toBeNull();
    expect(evaluateFieldSlice(ctx, req, NEVER, () => null)).toBeNull();
    let polls = 0;
    expect(evaluateFieldSlice(ctx, req, () => { polls++; return false; }, storeColumns(ctx))).not.toBeNull();
    expect(polls).toBeGreaterThanOrEqual(4 * 32);
  });
});

describe('probeField (SP3d spec §5.3): one sample, exactly as the slice', () => {
  const ctx = ctxWith(terrainMuted(0));

  test.each([
    ['density', 'vertical', vertical(MOUNTAIN), ''],
    ['density', 'horizontal', horizontal(32, 4096, 0, 0, 40), ''],
    ['node', 'vertical', vertical(MOUNTAIN), 'root.a.a.x.x.a'],
    ['node', 'horizontal', horizontal(32, 4096, 0, 0, 40), 'root.a.a.x'],
    ['rule', 'vertical', vertical(COAST), 'root.rules[1].then'],
    ['rule', 'vertical', vertical(COAST), 'root.rules[2].if'],
  ] as const)('%s on a %s plane', (field, _plane, g, path) => {
    const r = run(ctx, g, field, path);
    let i = 0;
    for (const s of samples(g)) {
      if ((s.c * 7 + s.k) % 5 !== 0) continue;
      expect(Object.is(probeField(ctx, field, path, s.x, s.y, s.z, NEVER), r.values[s.i])).toBe(true);
      i++;
    }
    expect(i).toBeGreaterThan(150);
  });

  test('the bedrock at y −64 is n/a for rule; density is evaluated there', () => {
    expect(probeField(ctx, 'rule', 'root', 0, -64, 0, NEVER)).toBe(SLICE_RULE_NA);
    expect(probeField(ctx, 'density', '', 0, -64, 0, NEVER)).toBe(probe(surfaceContextOf(ctx).density, 0, -64, 0));
  });

  test('stop() is polled before the column and before evaluating', () => {
    for (const field of ['density', 'node', 'rule'] as const) {
      const path = field === 'node' ? 'root.a' : field === 'rule' ? 'root' : '';
      let polls = 0;
      expect(probeField(ctx, field, path, 5, 70, -9, () => { polls++; return false; })).not.toBeNull();
      // rule: plus the 6 polls of the probe column's density fill.
      expect(polls).toBe(field === 'rule' ? 2 + 6 : 2);
      expect(probeField(ctx, field, path, 5, 70, -9, () => true)).toBeNull();
      let n = 0;
      expect(probeField(ctx, field, path, 5, 70, -9, () => ++n > 1)).toBeNull();
    }
  });

  test('refusals: non-integer or out-of-window coordinates, y outside −64 … 319, a bad field or path', () => {
    expect(() => probeField(ctx, 'density', '', 0.5, 0, 0, NEVER)).toThrow(RangeError);
    expect(() => probeField(ctx, 'density', '', 524288, 0, 0, NEVER)).toThrow(RangeError);
    expect(() => probeField(ctx, 'density', '', 0, 320, 0, NEVER)).toThrow(RangeError);
    expect(() => probeField(ctx, 'density', '', 0, -65, 0, NEVER)).toThrow(RangeError);
    expect(() => probeField(ctx, 'blocks' as never, '', 0, 0, 0, NEVER)).toThrow(RangeError);
    expect(() => probeField(ctx, 'node', 'root.q', 0, 0, 0, NEVER)).toThrow(/names no node/);
    expect(() => probeField(ctx, 'rule', 'root.rules[99]', 0, 0, 0, NEVER)).toThrow(/no rule or condition/);
    expect(() => probeField(ctx, 'density', 'root', 0, 0, 0, NEVER)).toThrow(/takes no node path/);
  });
});

describe('field problems and argument checks (SP3d spec §5.1)', () => {
  const ctx = ctxFor('42');

  test('fieldSliceProblem', () => {
    expect(fieldSliceProblem(ctx, 'density', '', 'horizontal')).toBeNull();
    expect(fieldSliceProblem(ctx, 'node', 'root.a.b.b', 'horizontal')).toBeNull();
    expect(fieldSliceProblem(ctx, 'node', 'defs.x', 'vertical')).toBe('path "defs.x" names no node of density.defs');
    expect(fieldSliceProblem(ctx, 'node', 'root.b.x.v', 'vertical')).toBe('path "root.b.x.v" names no node of density.defs');
    expect(fieldSliceProblem(ctx, 'node', 'constructor', 'vertical')).toBe('path "constructor" names no node of density.defs');
    expect(fieldSliceProblem(ctx, 'rule', 'root.rules[2].if', 'vertical')).toBeNull();
    expect(fieldSliceProblem(ctx, 'rule', 'root.rules[2].if.falseAtAndAbove', 'vertical')).toBe('path "root.rules[2].if.falseAtAndAbove" names no rule or condition of surface.rules');
    expect(fieldSliceProblem(ctx, 'rule', 'root', 'horizontal')).toBe('field rule has no horizontal slice');
    expect(fieldSliceProblem(ctx, 'blocks', '', 'horizontal')).toBe('field blocks has no horizontal slice');
    expect(fieldSliceProblem(ctx, 'blocks', 'root', 'vertical')).toBe('field blocks takes no node path (got "root")');
  });

  test('evaluateFieldSlice refuses bad ranges, geometries, fields and a blocks request without a T-column source', () => {
    const g = vertical(MOUNTAIN);
    const req = (over: Partial<FieldSliceRequest>): FieldSliceRequest => ({ geometry: g, field: 'density', path: '', from: 0, to: 32, ...over });
    for (const [from, to] of [[5, 5], [0, 33], [-1, 4], [0.5, 4]]) expect(() => evaluateFieldSlice(ctx, req({ from, to }), NEVER)).toThrow(/range/);
    expect(() => evaluateFieldSlice(ctx, req({ geometry: { ...g, n: 64 } as SliceGeometry }), NEVER)).toThrow(/not a slice size/);
    expect(() => evaluateFieldSlice(ctx, req({ geometry: horizontal(32, 8192, 524288 - 4095) }), NEVER)).toThrow(/world window/);
    expect(() => evaluateFieldSlice(ctx, req({ geometry: horizontal(), field: 'rule', path: 'root' }), NEVER)).toThrow(/no horizontal slice/);
    expect(() => evaluateFieldSlice(ctx, req({ field: 'blocks' }), NEVER)).toThrow(/T-column source/);
  });
});

describe('DensityReference memos (SP3d spec §5.1, §5.3)', () => {
  test('densityReferenceOf: one per GenContext, over the stage\'s own resolved tree', () => {
    const a = ctxFor('42');
    const b = ctxFor('42');
    expect(densityReferenceOf(a)).toBe(densityReferenceOf(a));
    expect(densityReferenceOf(a).expr).toBe(surfaceContextOf(a).density.expr);
    expect(densityReferenceOf(b)).not.toBe(densityReferenceOf(a));
  });

  test('nodeReferenceOf: per (context, path), an LRU of 8 paths', () => {
    const ctx = ctxFor('42');
    const paths = ['root', 'root.a', 'root.b', 'root.b.x', 'root.a.a', 'root.a.b', 'root.a.b.a', 'root.a.b.b', 'root.a.a.x'];
    const first = new Map(paths.slice(0, 8).map((p) => [p, nodeReferenceOf(ctx, p)]));
    for (const p of paths.slice(0, 8)) expect(nodeReferenceOf(ctx, p)).toBe(first.get(p));
    expect(nodeReferenceOf(ctx, paths[8]!)).toBe(nodeReferenceOf(ctx, paths[8]!));
    // 'root' was the least recently used of the eight: it was evicted by the ninth path; 'root.a' was not.
    expect(nodeReferenceOf(ctx, 'root.a')).toBe(first.get('root.a'));
    expect(nodeReferenceOf(ctx, 'root')).not.toBe(first.get('root'));
    expect(nodeReferenceOf(ctxFor('42'), 'root.a')).not.toBe(first.get('root.a'));
    expect(() => nodeReferenceOf(ctx, 'root.zz')).toThrow(RangeError);
  });

  test('a node reference evaluates the resolved node expression: the islands tap is its const', () => {
    const tree = densityTree();
    tree['root'].b.x.v = -10;
    const ctx = ctxWith(tree);
    const s = surfaceContextOf(ctx).density.columns.get(0, 0);
    expect(nodeReferenceOf(ctx, 'root.b').voxel(s, 3, 200, 4)).toBe(-10);
    expect(nodeReferenceOf(ctx, 'root.b.x').voxel(s, 3, 200, 4)).toBe(-10);
  });
});

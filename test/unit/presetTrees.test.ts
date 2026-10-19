/**
 * The preset trees (SP3e spec §1.1, §1.2, D1, D2, D12, D13, user point 2): the derivation helper of
 * `core/params/presetTrees.ts` (its refusals, its insertions, its wrappers and its registration), and `AMPLIFIED_DENSITY_TREE` = the
 * default density tree with exactly §1.2's six path replacements: identity across `resolveProfile`, node count, tier 2,
 * the static costs, the inspector's cost lint, §1.2's corner bound computed from the tree's literals (no solid voxel at
 * y ≥ 315 since the approved retune: σ × 2.2, slide end 314) and checked on the largest-offset column of a 4,096-column scan,
 * compiled == reference and probe == bulk on columns with offset0 ≥ 180 (voxels and corners in y 296-319), and
 * `surfaceEst3`; and
 * `FLOATING_DENSITY_TREE` (§3.1, §3.4, D3, D4) = the default with exactly `root.b.x` replaced: identity, node count,
 * tier 2, the static costs and the lint (its real columns are `floatingIslands.test.ts`'). `FLOATING_SURFACE_RULES`
 * is `floatingRules.test.ts`'.
 */
import { describe, expect, test } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { checkJson, countTreeNodes, type JsonValue } from '../../src/core/params/json';
import type { Issue } from '../../src/core/params/kit';
import { AMPLIFIED_DENSITY_TREE, deriveTree, FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { columnPoint, newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { readField } from '../../src/gen/column/columnStage';
import { lakeCell } from '../../src/gen/column/lakes';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { resolveDensity } from '../../src/gen/density/source';
import { densityColumnCost, structuralCost, workCost } from '../../src/gen/inspect/cost';
import { terrainDensityDebug } from '../../src/gen/pipeline/terrainStage';
import { validateParamTrees } from '../../src/gen/trees';
import { fillColumnT } from '../../src/metrics/region';
import { treeLints } from '../../src/ui/inspector/form';
import { AIR } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The canonical diff of two density trees: the paths (as tier 2 prints them) of the highest nodes that differ. Two
 * objects with the same keys and the same `op` are compared key by key; anything else (another op, other keys, a
 * number, an array such as `knots`) is one difference when its canonical text differs.
 */
function treeDiff(a: unknown, b: unknown, path = ''): string[] {
  const at = (k: string): string => (path === '' ? k : `${path}.${k}`);
  if (isRec(a) && isRec(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (canonicalJSON(ka) === canonicalJSON(kb) && a['op'] === b['op']) return ka.flatMap((k) => treeDiff(a[k], b[k], at(k)));
  }
  return canonicalJSON(a) === canonicalJSON(b) ? [] : [path];
}

/** The node at a dotted path of a density tree. */
function nodeAt(tree: unknown, path: string): unknown {
  let x = tree;
  for (const k of path.split('.')) x = (x as Rec)[k];
  return x;
}

const AMPLIFIED_PATHS = [
  'root.a.a.x.x.a.a.a.a.a', 'root.a.a.x.x.a.a.a.a.b.a', 'root.a.a.x.x.a.a.b.a', 'root.a.a.x.x.a.a.b.b.knots',
  'root.a.a.x.x.b.x.a.v', 'root.a.a.x.x.b.x.b.b.b.v',
];

describe('deriveTree (SP3e spec §1.1, D12)', () => {
  const base = { root: { op: 'add', a: { op: 'y' }, b: { op: 'const', v: 2 } }, defs: {} };

  test('a replacement at a JSON path: a registered, frozen, key-sorted clone; the base is untouched', () => {
    const t = deriveTree(base, 'density.defs', 'density', [{ path: 'root.b', was: { op: 'const', v: 2 }, by: { op: 'col', field: 'offset' } }]);
    expect(canonicalJSON(t)).toBe(canonicalJSON({ defs: {}, root: { a: { op: 'y' }, b: { field: 'offset', op: 'col' }, op: 'add' } }));
    expect(Object.isFrozen(t)).toBe(true);
    const issues: Issue[] = [];
    expect(checkJson(t, 'density.defs', issues, 'density')).toBe(t);
    expect(issues).toEqual([]);
    expect(base.root.b).toEqual({ op: 'const', v: 2 });
  });

  test('a scalar or array field (a const\'s v, a slide\'s knots) is replaced when it equals `was`', () => {
    const t = deriveTree(base, 'density.defs', 'density', [{ path: 'root.b.v', was: 2, by: 3 }]);
    expect(nodeAt(t, 'root.b')).toEqual({ op: 'const', v: 3 });
  });

  test('rules: tier 2\'s `root` names the value itself, `[i]` an array item', () => {
    const t = deriveTree(DEFAULT_SURFACE_RULES, 'surface.rules', 'surfaceRules', [{ path: 'root.rules[2].if.falseAtAndAbove', was: 8, by: 12 }]);
    const copy = JSON.parse(JSON.stringify(DEFAULT_SURFACE_RULES)) as { rules: Array<{ if: Rec }> };
    copy.rules[2]!.if['falseAtAndAbove'] = 12;
    expect(canonicalJSON(t)).toBe(canonicalJSON(copy));
  });

  test('an insertion (`insert: true`) puts `by` before the array item the path names, which must be `was`', () => {
    const rules = { kind: 'sequence', rules: [{ kind: 'block', state: 'stone' }, { kind: 'block', state: 'dirt' }] };
    const t = deriveTree(rules, 'surface.rules', 'surfaceRules', [
      { path: 'root.rules[1]', was: { kind: 'block', state: 'dirt' }, by: { kind: 'block', state: 'grass_block' }, insert: true },
    ]);
    expect(canonicalJSON(t)).toBe(canonicalJSON({ kind: 'sequence', rules: [
      { kind: 'block', state: 'stone' }, { kind: 'block', state: 'grass_block' }, { kind: 'block', state: 'dirt' }] }));
    expect(rules.rules).toHaveLength(2);
    const insert = (path: string, was: JsonValue) => () =>
      deriveTree(rules, 'surface.rules', 'surfaceRules', [{ path, was, by: { kind: 'block', state: 'stone' }, insert: true }]);
    expect(insert('root.rules[2]', { kind: 'block' })).toThrow('surface.rules: no node at root.rules[2]');
    expect(insert('root.rules[0]', { kind: 'block', state: 'dirt' })).toThrow('surface.rules: root.rules[0] is {"kind":"block","state":"stone"}, not {"kind":"block","state":"dirt"}');
    expect(insert('root.rules', [])).toThrow('surface.rules: root.rules is not an array item');
    expect(insert('root.kind', 'sequence')).toThrow('surface.rules: root.kind is not an array item');
  });

  test('a wrapper (`by` a function) replaces the node the path names by its result on a clone of that node', () => {
    const sky: JsonValue = { kind: 'condition', if: { kind: 'skyOpen' }, then: { kind: 'block', state: 'dirt' } };
    const rules: JsonValue = { kind: 'sequence', rules: [{ kind: 'block', state: 'stone' }, sky] };
    let seen: JsonValue | undefined;
    const t = deriveTree(rules, 'surface.rules', 'surfaceRules', [{
      path: 'root.rules[1]', was: { kind: 'condition', if: { kind: 'skyOpen' } },
      by: (node) => { seen = node; return { kind: 'sequence', rules: [{ kind: 'block', state: 'grass_block' }, node] }; },
    }]);
    expect(canonicalJSON(t)).toBe(canonicalJSON({ kind: 'sequence', rules: [
      { kind: 'block', state: 'stone' },
      { kind: 'sequence', rules: [{ kind: 'block', state: 'grass_block' }, { kind: 'condition', if: { kind: 'skyOpen' }, then: { kind: 'block', state: 'dirt' } }] }] }));
    expect(seen).not.toBe(sky);
    expect(seen).toEqual(sky);
    expect(canonicalJSON(rules)).toBe(canonicalJSON({ kind: 'sequence', rules: [{ kind: 'block', state: 'stone' }, sky] }));
    // The path and `was` are checked before the function runs.
    const wrap = (path: string, was: JsonValue) => () => deriveTree(rules, 'surface.rules', 'surfaceRules', [{ path, was, by: (n) => n }]);
    expect(wrap('root.rules[2]', { kind: 'block' })).toThrow('surface.rules: no node at root.rules[2]');
    expect(wrap('root.rules[1]', { kind: 'condition', if: { kind: 'lake' } })).toThrow('surface.rules: root.rules[1] is {"kind":"condition"}, not {"if":{"kind":"lake"},"kind":"condition"}');
  });

  test('refusals: a missing path, a wrong node (op, const value, scalar), an inherited key, an unregistrable tree', () => {
    const derive = (path: string, was: JsonValue, by: JsonValue = { op: 'y' }) => () => deriveTree(base, 'density.defs', 'density', [{ path, was, by }]);
    expect(derive('root.c', { op: 'y' })).toThrow('density.defs: no node at root.c');
    expect(derive('root.b.x.y', { op: 'y' })).toThrow('density.defs: no node at root.b.x.y');
    expect(derive('root.a[0]', { op: 'y' })).toThrow('density.defs: no node at root.a[0]');
    expect(derive('root.constructor', { op: 'y' })).toThrow('density.defs: no node at root.constructor');
    expect(derive('root.b', { op: 'y' })).toThrow('density.defs: root.b is {"op":"const","v":2}, not {"op":"y"}');
    expect(derive('root.b', { op: 'const', v: 3 })).toThrow('density.defs: root.b is {"op":"const","v":2}, not {"op":"const","v":3}');
    expect(derive('root.b.v', 3, 4)).toThrow('density.defs: root.b.v is 2, not 3');
    expect(() => deriveTree(DEFAULT_SURFACE_RULES, 'surface.rules', 'surfaceRules', [{ path: 'rules[2]', was: {}, by: {} }])).toThrow('surface.rules: no node at rules[2]');
    expect(derive('root.b', { op: 'const', v: 2 }, { op: 'const', v: 1, 'bad key': 1 })).toThrow(/density\.defs tree fails tier 1/);
  });
});

describe('AMPLIFIED_DENSITY_TREE (SP3e spec §1.2, D1, D2, user point 2)', () => {
  const amplified = resolveProfile('amplified');

  test('the overlay holds the registered tree; resolveProfile keeps its identity; checkJson returns it as itself', () => {
    expect(amplified.density.defs).toBe(AMPLIFIED_DENSITY_TREE);
    expect(resolveProfile('amplified').density.defs).toBe(AMPLIFIED_DENSITY_TREE);
    expect(Object.isFrozen(AMPLIFIED_DENSITY_TREE)).toBe(true);
    expect(checkJson(AMPLIFIED_DENSITY_TREE, 'density.defs', [], 'density')).toBe(AMPLIFIED_DENSITY_TREE);
    // Every other leaf is the default's.
    expect(canonicalJSON({ ...amplified, density: { ...amplified.density, defs: null } })).toBe(canonicalJSON({ ...DEFAULTS, density: { ...DEFAULTS.density, defs: null } }));
  });

  test('a canonical diff against the default lists exactly the six paths of §1.2, with the stated values', () => {
    expect(treeDiff(DEFAULT_DENSITY_TREE, AMPLIFIED_DENSITY_TREE)).toEqual(AMPLIFIED_PATHS);
    const col = (field: string) => ({ op: 'col', field });
    const c = (v: number) => ({ op: 'const', v });
    const fade = (k: number, d: number) => ({ op: 'add', a: c(k), b: { op: 'mul', a: c(-d), b: col('lakeMask') } });
    const expected: Array<[unknown, unknown]> = [
      // The amplification and the σ factor fade with lakeMask: k + (−d)·lakeMask (SP3e Review Focus: lakes hold water).
      [col('offset'), { op: 'add', a: col('offset'), b: { op: 'mul', a: fade(0.9, 0.9), b: { op: 'max', a: c(0), b: { op: 'add', a: col('offset'), b: c(-64) } } } }],
      [col('jag'), { op: 'mul', a: col('jag'), b: c(1.6) }],
      // The approved retune (Checkpoint M, proposal-1): σ × 2.2 (was 1.6) and the slide's last knot 314 (was 316).
      [col('sigma'), { op: 'mul', a: col('sigma'), b: fade(2.2, 1.2) }],
      [[[-64, 0], [-40, 1], [240, 1], [320, 0]], [[-64, 0], [-40, 1], [300, 1], [314, 0]]],
      [2, 3],
      [-296, -270],
    ];
    AMPLIFIED_PATHS.forEach((p, i) => {
      expect(canonicalJSON(nodeAt(DEFAULT_DENSITY_TREE, p)), p).toBe(canonicalJSON(expected[i]![0]));
      expect(canonicalJSON(nodeAt(AMPLIFIED_DENSITY_TREE, p)), p).toBe(canonicalJSON(expected[i]![1]));
    });
    // The root shape is the default's (U2 mutes root.a.a; the islands tap is untouched), and the default is unchanged.
    expect(nodeAt(AMPLIFIED_DENSITY_TREE, 'root.a.a')).toMatchObject({ op: 'tap', name: 'terrain' });
    expect(nodeAt(AMPLIFIED_DENSITY_TREE, 'root.b')).toEqual({ op: 'tap', name: 'islands', x: { op: 'const', v: -1e6 } });
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.b.x')).toEqual({ op: 'const', v: -1e6 });
  });

  test('80 nodes; tier 2 []; static costs: structural 493, column 14,932,417, work 729 (the default 333, 14,907,917, 569)', () => {
    expect(countTreeNodes(DEFAULT_DENSITY_TREE, 'density')).toBe(60);
    expect(countTreeNodes(AMPLIFIED_DENSITY_TREE, 'density')).toBe(80);
    expect(validateParamTrees(amplified)).toEqual([]);
    const t = AMPLIFIED_DENSITY_TREE as unknown as { root: unknown; defs: unknown };
    expect(structuralCost(t.root, t.defs)).toBe(493);
    expect(densityColumnCost(AMPLIFIED_DENSITY_TREE)).toBe(14_932_417);
    const work = (tree: unknown, p: Params) => workCost(resolveDensity(tree, p), p);
    expect(work(DEFAULT_DENSITY_TREE, DEFAULTS)).toBe(569);
    expect(work(AMPLIFIED_DENSITY_TREE, amplified)).toBe(729);
  });

  test('the inspector\'s cost lint does not fire (work ≤ 4 × the default) and the rules keep their fast path', () => {
    expect(treeLints(amplified)).toEqual([]);
  });

  test('§1.2\'s corner bound, computed from the tree\'s literals, leaves no solid voxel at y ≥ 315 (§1.5 step 5\'s invariant: ≥ 316)', () => {
    const v = (path: string): number => nodeAt(AMPLIFIED_DENSITY_TREE, path) as number;
    // The fades' k (their value where lakeMask is 0, the largest since lakeMask ≥ 0 up to a few ulps).
    const offsetFactor = v('root.a.a.x.x.a.a.a.a.a.b.a.a.v'), offsetKnee = -v('root.a.a.x.x.a.a.a.a.a.b.b.b.b.v');
    const jagFactor = v('root.a.a.x.x.a.a.a.a.b.a.b.v'), sigmaFactor = v('root.a.a.x.x.a.a.b.a.b.a.v');
    const knots = nodeAt(AMPLIFIED_DENSITY_TREE, 'root.a.a.x.x.a.a.b.b.knots') as Array<[number, number]>;
    const slope = v('root.a.a.x.x.b.x.a.v'), knee = -v('root.a.a.x.x.b.x.b.b.b.v');
    expect([offsetFactor, offsetKnee, jagFactor, sigmaFactor, slope, knee]).toEqual([0.9, 64, 1.6, 2.2, 3, 270]);
    // The shape splines' largest knots (shapeDefaults.ts: offset 210, jag 55, σ 26), J ≤ 1, |N| ≤ clampSigma (3), and
    // the detail term ≤ detailAmpHi × its clampSigma (1.5 × 3), outside `interpolated`.
    const offsetMax = 210 + offsetFactor * (210 - offsetKnee), jagMax = 55 * jagFactor, sigmaMax = 26 * sigmaFactor;
    const nMax = DEFAULTS.density.noises.overhang.clampSigma;
    const detailMax = DEFAULTS.density.detailAmpHi * DEFAULTS.density.noises.detail.clampSigma;
    const slide = (y: number): number => {
      if (y <= knots[0]![0]) return knots[0]![1];
      for (let i = 1; i < knots.length; i++) {
        const [y0, s0] = knots[i - 1]!, [y1, s1] = knots[i]!;
        if (y <= y1) return s0 + ((y - y0) / (y1 - y0)) * (s1 - s0);
      }
      return knots[knots.length - 1]![1];
    };
    const corner = (y: number): number => offsetMax + jagMax - y + sigmaMax * nMax * slide(y) - slope * Math.max(0, y - knee);
    const voxel = (y: number): number => {
      const y0 = Math.floor(y / 8) * 8, t = (y - y0) / 8;
      return (1 - t) * corner(y0) + t * corner(y0 + 8) + detailMax;
    };
    let lowest = 320;
    while (lowest > -64 && voxel(lowest - 1) < 0) lowest--;
    expect(corner(312)).toBeCloseTo(15.914, 3);
    expect(corner(320)).toBeCloseTo(-40.6, 9);
    // y 315 = 312 + 8·(3/8): t > 0.361 makes the voxel bound negative; the spec's invariant (y ≥ 316) holds with a block to spare.
    expect(lowest).toBe(315);
  });
});

describe('amplified on real columns (seed 42; SP3e spec §1.2)', () => {
  const amplified = resolveProfile('amplified');
  const ctx: GenContext = createGenContext(seedFromInput('42'), amplified);
  const base: GenContext = createGenContext(seedFromInput('42'), DEFAULTS);
  /**
   * The `terrain.real` bench's candidate columns (`test/bench/noise.bench.ts`): tc = 1 … 4096, chunk column
   * ((tc·7919) % 60000 − 30000, (tc·104729) % 60000 − 30000), with offset0 at its centre block.
   */
  const scan = (() => {
    const rec = newPointRecord();
    const out: Array<{ cx: number; cz: number; offset0: number }> = [];
    for (let tc = 1; tc <= 4096; tc++) {
      const cx = (tc * 7919) % 60000 - 30000;
      const cz = (tc * 104729) % 60000 - 30000;
      out.push({ cx, cz, offset0: samplePoint(ctx, 16 * cx + 8, 16 * cz + 8, false, rec).offset0 });
    }
    return out;
  })();
  const largest = scan.reduce((m, c) => (c.offset0 > m.offset0 ? c : m));
  const high = scan.filter((c) => c.offset0 >= 180).slice(0, 3);
  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });

  test('no solid voxel at y ≥ 315 at the largest-offset column (the §1.2 corner bound), and it is amplified', () => {
    expect(largest.offset0).toBeGreaterThan(190);
    const { cx, cz } = largest;
    expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
    const view = store.proto(cx, cz)!;
    const dc = createDensityContext(ctx);
    let top = -65;
    for (let p = 0; p < 256; p++) {
      const lx = p & 15, lz = p >> 4;
      for (let y = 319; y >= 315; y--) {
        expect(view.block(lx, y, lz), `(${lx}, ${y}, ${lz})`).toBe(AIR);
        expect(probe(dc, 16 * cx + lx, y, 16 * cz + lz)).toBeLessThanOrEqual(0);
      }
      for (let y = 314; y > top; y--) if (view.block(lx, y, lz) !== AIR) { top = y; break; }
    }
    store.freeColumn(cx, cz);
    // The default tree tops out near offset0 + jag; the amplified one far above it.
    expect(top).toBeGreaterThan(largest.offset0 + 60);
  });

  test('compiled == reference and probe == bulk on offset0 ≥ 180 columns, incl. every voxel and corner in y 296-319', () => {
    expect(high).toHaveLength(3);
    const dc = createDensityContext(ctx);
    const ref = createDensityReference(dc.expr, dc.noises);
    const c = dc.compiled;
    const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
    const out = new Float64Array(98304);
    const mask = new Uint8Array(98304);
    const r = new Xoshiro128(fnv1a32('presetTrees.amplified'));
    let voxels = 0, masked = 0, corners = 0, solidHigh = 0;
    for (const { cx, cz } of high) {
      expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
      const view = store.proto(cx, cz)!;
      terrainDensityDebug(ctx, cx, cz, out, mask);
      const s = dc.column(cx, cz);
      const idx: number[] = [];
      for (let y = 296; y <= 319; y++) for (let p = 0; p < 256; p++) idx.push(((y + 64) << 8) | p);
      for (let n = 0; n < 512; n++) idx.push(256 + r.nextInt(98304 - 256));
      for (const i of idx) {
        const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
        const x = 16 * cx + lx, z = 16 * cz + lz;
        const value = probe(dc, x, y, z);
        const block = view.block(lx, y, lz);
        voxels++;
        expect(value > 0, `(${x}, ${y}, ${z}) probe ${value}, block ${block}`).toBe(block !== AIR);
        if (y >= 296 && block !== AIR) solidHigh++;
        if (mask[i] === 1) {
          masked++;
          expect(Object.is(value, out[i]), `(${x}, ${y}, ${z}) probe ${value} ≠ bulk ${out[i]}`).toBe(true);
        }
        const rv = ref.voxel(s, x, y, z);
        expect(Object.is(value, rv), `(${x}, ${y}, ${z}) compiled ${value} ≠ reference ${rv}`).toBe(true);
      }
      for (let ck = 45; ck <= 47; ck++) {
        for (let cj = 0; cj < 4; cj++) {
          for (let ci = 0; ci < 4; ci++) {
            c.cellCorners(ci, ck, cj);
            for (const { inner, slot } of interp) {
              for (let d = 0; d < 8; d++) {
                const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
                const cv = c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!;
                const rc = ref.corner(s, inner, ii, kk, jj);
                corners++;
                expect(Object.is(cv, rc), `(${cx}, ${cz}) corner (${ii}, ${kk}, ${jj}) compiled ${cv} ≠ reference ${rc}`).toBe(true);
              }
            }
          }
        }
      }
      store.freeColumn(cx, cz);
    }
    expect(voxels).toBe(3 * (24 * 256 + 512));
    expect(masked).toBeGreaterThan(0);
    expect(corners).toBe(3 * 48 * 8);
    // The columns reach the slide (y ≥ 296): the test exercises the knots and the ceiling.
    expect(solidHigh).toBeGreaterThan(0);
  });

  test('surfaceEst3 finds the amplified surface (inside the terrain tap), far above the 2D offset and the default\'s', () => {
    const dc = createDensityContext(ctx);
    const dd = createDensityContext(base);
    for (const { cx, cz } of high) {
      const x = 16 * cx + 8, z = 16 * cz + 8;
      const est = surfaceEst3(dc, x, z);
      expect(probe(dc, x, est, z, 'terrain')).toBeGreaterThan(0);
      if (est < 319) expect(probe(dc, x, est + 1, z, 'terrain')).toBeLessThanOrEqual(0);
      const offset = readField(dc.column(cx, cz), 'offset', x, z);
      expect(est).toBeGreaterThan(offset + 0.9 * (offset - 64) - 60);
      expect(est).toBeGreaterThan(surfaceEst3(dd, x, z) + 50);
    }
  });
});

describe('amplified lakes hold water (seed 42; SP3e spec §1.2, Review Focus)', () => {
  const amplified = resolveProfile('amplified');
  const ctx: GenContext = createGenContext(seedFromInput('42'), amplified);
  const base: GenContext = createGenContext(seedFromInput('42'), DEFAULTS);
  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  /** The water voxels and the top solid voxel of world column (x, z) after the T stage. */
  const column = (c: GenContext, x: number, z: number): { water: number; top: number } => {
    const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15;
    expect(fillColumnT(store, c, cx, cz, () => false)).toBe(true);
    const view = store.proto(cx, cz)!;
    let water = 0, top = -65;
    for (let y = -64; y <= 319; y++) {
      if (view.fluid(lx, y, lz) !== 0) water++;
      if (view.block(lx, y, lz) !== AIR) top = y;
    }
    store.freeColumn(cx, cz);
    return { water, top };
  };

  test('every lake centre (lakeMask 1) holds the default world\'s water: the basin keeps the unamplified offset and σ', () => {
    // The lake cells of i, j in [−40, 40): Lw comes from the unamplified offset0 (shape stage), the same in both worlds.
    let lakes = 0, wetDefault = 0, wetAmplified = 0, high = 0, same = 0;
    for (let i = -40; i < 40; i++) {
      for (let j = -40; j < 40; j++) {
        const cell = lakeCell(ctx, i, j);
        expect(cell).toEqual(lakeCell(base, i, j));
        if (!cell.enabled) continue;
        const x = Math.round(cell.cx), z = Math.round(cell.cz);
        if (columnPoint(ctx, x, z).lakeMask !== 1) continue;
        lakes++;
        const d = column(base, x, z), a = column(ctx, x, z);
        if (d.water > 0) wetDefault++;
        if (a.water > 0) wetAmplified++;
        if (cell.Lw >= 75) high++;
        // Unfaded, the amplification lifted a basin with Lw above about 75 over its own water level (0.9·(Lw − 64) ≥
        // depth): 37 of these 132 centres held water. Faded, a centre whose lattice corners all have lakeMask 1 is the
        // default's column; one at the basin's edge (a lattice corner in the rim band, lakeMask < 1) is partly lifted.
        if (d.water > 0) expect(a.water, `cell (${i}, ${j}) Lw ${cell.Lw}: dry in amplified, ${d.water} water voxels in the default`).toBeGreaterThan(0);
        if (a.water === d.water && a.top === d.top) same++;
      }
    }
    expect([lakes, wetDefault, wetAmplified, same]).toEqual([132, 119, 119, 130]);
    expect(high).toBeGreaterThan(50);
  });

  test('where lakeMask is 0 the fades are the plain factors bit for bit (0.9 and 2.2)', () => {
    const plain = deriveTree(AMPLIFIED_DENSITY_TREE, 'density.defs', 'density', [
      { path: 'root.a.a.x.x.a.a.a.a.a.b.a', was: { op: 'add' }, by: { op: 'const', v: 0.9 } },
      { path: 'root.a.a.x.x.a.a.b.a.b', was: { op: 'add' }, by: { op: 'const', v: 2.2 } },
    ]);
    const dc = createDensityContext(ctx);
    const dp = createDensityContext(createGenContext(seedFromInput('42'), { ...amplified, density: { ...amplified.density, defs: plain } }));
    const r = new Xoshiro128(fnv1a32('presetTrees.amplified.lakeFade'));
    let dry = 0, compared = 0;
    for (let n = 0; n < 64 && dry < 8; n++) {
      const cx = r.nextInt(4096) - 2048, cz = r.nextInt(4096) - 2048;
      const s = dc.column(cx, cz);
      let m = 0;
      for (let k = 0; k < 25; k++) m = Math.max(m, Math.abs(readField(s, 'lakeMask', 16 * cx + 4 * (k % 5), 16 * cz + 4 * Math.floor(k / 5))));
      if (m !== 0) continue;
      dry++;
      for (let k = 0; k < 256; k++) {
        const x = 16 * cx + r.nextInt(16), y = r.nextInt(384) - 64, z = 16 * cz + r.nextInt(16);
        const v = probe(dc, x, y, z), w = probe(dp, x, y, z);
        expect(Object.is(v, w), `(${x}, ${y}, ${z}) ${v} ≠ ${w}`).toBe(true);
        compared++;
      }
    }
    expect(compared).toBe(8 * 256);
  });
});

/** SP3e spec §3.1's replacement of `root.b.x`, written as the spec writes it (`op` first). */
const ISLANDS_BODY = { op: 'mul', a: { op: 'const', v: 20 }, b:
  { op: 'add',
    a: { op: 'add',
      a: { op: 'add', a: { op: 'noise', id: 'islands' }, b: { op: 'const', v: -0.9 } },
      b: { op: 'neg', x: { op: 'mul', a: { op: 'const', v: 3 }, b:
        { op: 'square', x: { op: 'mul', a: { op: 'add', a: { op: 'y' }, b: { op: 'const', v: -230 } },
          b: { op: 'const', v: 0.025 } } } } } },
    b: { op: 'mul', a: { op: 'const', v: 4 }, b: { op: 'add', a: { op: 'col', field: 'islandMask' }, b: { op: 'const', v: -1 } } } } };
const ISLANDS_TERM = { op: 'interpolated', x:
  { op: 'rangeChoice', x: { op: 'col', field: 'islandMask' }, lo: 0.25, hi: 2,
    inside: { op: 'rangeChoice', x: { op: 'y' }, lo: 192, hi: 265,
      inside: ISLANDS_BODY,
      outside: { op: 'const', v: -1000000 } },
    outside: { op: 'const', v: -1000000 } } };

describe('FLOATING_DENSITY_TREE (SP3e spec §3.1, §3.3, §3.4, D3, D4, D12, D13)', () => {
  const floating = resolveProfile('floating_islands');

  test('the overlay holds the registered tree; resolveProfile keeps its identity; checkJson returns it as itself', () => {
    expect(floating.density.defs).toBe(FLOATING_DENSITY_TREE);
    expect(resolveProfile('floating_islands').density.defs).toBe(FLOATING_DENSITY_TREE);
    expect(Object.isFrozen(FLOATING_DENSITY_TREE)).toBe(true);
    expect(checkJson(FLOATING_DENSITY_TREE, 'density.defs', [], 'density')).toBe(FLOATING_DENSITY_TREE);
    expect(floating.islands.enabled).toBe(true);
  });

  test('a canonical diff against the default lists exactly root.b.x, replaced by §3.1\'s term; the root keeps the default\'s shape', () => {
    expect(treeDiff(DEFAULT_DENSITY_TREE, FLOATING_DENSITY_TREE)).toEqual(['root.b.x']);
    expect(canonicalJSON(nodeAt(FLOATING_DENSITY_TREE, 'root.b.x'))).toBe(canonicalJSON(ISLANDS_TERM));
    expect(nodeAt(FLOATING_DENSITY_TREE, 'root')).toMatchObject({ op: 'max' });
    expect(nodeAt(FLOATING_DENSITY_TREE, 'root.a.a')).toMatchObject({ op: 'tap', name: 'terrain' });
    expect(nodeAt(FLOATING_DENSITY_TREE, 'root.b')).toMatchObject({ op: 'tap', name: 'islands' });
    // 0.025 is the double nearest 1/40, the one recip(const 40) gives (§3.1).
    expect(0.025).toBe(1 / 40);
    expect(nodeAt(DEFAULT_DENSITY_TREE, 'root.b.x')).toEqual({ op: 'const', v: -1e6 });
  });

  test('87 nodes (BODY 21, the replacement 28); tier 2 []; the inspector\'s cost lint does not fire', () => {
    expect(countTreeNodes(ISLANDS_BODY as JsonValue, 'density')).toBe(21);
    expect(countTreeNodes(FLOATING_DENSITY_TREE, 'density')).toBe(87);
    expect(validateParamTrees(floating)).toEqual([]);
    expect(treeLints(floating)).toEqual([]);
  });

  test('static costs: structural 549, column 15,096,567, work 905 (§3.4\'s computed figures, measured)', () => {
    const t = FLOATING_DENSITY_TREE as unknown as { root: unknown; defs: unknown };
    expect(structuralCost(t.root, t.defs)).toBe(549);
    expect(densityColumnCost(FLOATING_DENSITY_TREE)).toBe(15_096_567);
    expect(workCost(resolveDensity(FLOATING_DENSITY_TREE, floating), floating)).toBe(905);
  });
});

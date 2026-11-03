/**
 * SP6a Task 6 (spec §1.1, §1.2, §1.4, §4): the `caves` group's first leaves and noises and the cave terms of the default
 * density tree: entrances E, cheese C and pillars P with `keep`, the shared `fl`, `sky`, `ramp` and `rough`, and
 * `detailG` in place of the detail term.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import type { DensityExpr, Expr, TapExpr } from '../../src/gen/density/expr';
import { createDensityReference } from '../../src/gen/density/reference';
import { resolveDensity, validateDensitySource } from '../../src/gen/density/source';
import { ctxFor, paramsWith } from '../harness/gen';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The node at a dotted path (`root.a.b`, `defs.pillars.x`). */
const at = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n as Rec)[k], v);

/** Every tap name of a source tree (root and defs), with its count. */
function tapCounts(tree: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const x = stack.pop();
    if (Array.isArray(x)) { stack.push(...x); continue; }
    if (!isRec(x)) continue;
    if (x['op'] === 'tap') out.set(x['name'] as string, (out.get(x['name'] as string) ?? 0) + 1);
    stack.push(...Object.values(x));
  }
  return out;
}

const CTX = ctxFor('42');
/** The cave class column of seed 42 (`caveColumn` in `src/metrics/liveness.ts`; pinned in test/unit/liveness.test.ts). */
export const CAVE_COLUMN: readonly [number, number] = [546, 25857];
/** SP5c's value-check columns and the cave class column. */
const COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [-1667, -2000], [40, 900], CAVE_COLUMN];

/** The paths of the cave terms in the default source tree (SP6a §1.1). */
const P = {
  detailG: 'root.a.a.a.x.b',
  caves: 'root.a.a.b',
  entrances: 'root.a.a.b.a.a',
  cheese: 'root.a.a.b.a.b',
  keep: 'root.a.a.b.b',
  pillars: 'defs.pillars',
} as const;

describe('the caves group (SP6a spec §4)', () => {
  test('the leaves of this task, sizes first, every one Terrain-scoped on the terrain stage, with spec §4\'s defaults and ranges', () => {
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('caves.') && !l.path.startsWith('caves.noises.'));
    expect(leaves.map((l) => [l.path, l.leaf.def, l.leaf.min, l.leaf.max])).toEqual([
      ['caves.cheese.offset', 0.27, -0.5, 1],
      ['caves.cheese.regional', 0.1, 0, 0.4],
      ['caves.cheese.layerAmp', 4, 0, 8],
      ['caves.cheese.roofDepth', 12, 0, 48],
      ['caves.pillars.threshold', 0.03, 0, 0.5],
      ['caves.entrances.offset', 0.37, -0.5, 1],
      ['caves.entrances.threshold', 0.08, 0, 0.5],
      ['caves.limits.surfaceDepth', 8, 0, 32],
    ]);
    for (const l of SCHEMA.leaves.filter((x) => x.path.startsWith('caves.'))) {
      expect([l.path, l.meta.scope, l.meta.stage]).toEqual([l.path, 'terrain', 'terrain']);
    }
    expect(Object.keys(DEFAULTS).at(-1)).toBe('caves');
  });

  test('the cave noises: single stacks except cheese, clampSigma 3, remap none, every vertical wavelength ≥ 16', () => {
    const n = DEFAULTS.caves.noises;
    const row = (id: keyof typeof n) => {
      const d = n[id];
      const dims = SCHEMA.leaves.find((l) => l.path === `caves.noises.${id}`)!.leaf.dims;
      return [id, dims, d.wavelength, Math.round(d.wavelength / d.yScale), d.octaves, d.double, d.amplitudes];
    };
    expect(Object.keys(n).map((id) => row(id as keyof typeof n))).toEqual([
      ['cheese', 3, 96, 144, 4, true, null],
      ['layer', 3, 96, 16, 1, false, null],
      ['cheeseRegional', 2, 1536, 1536, 2, false, null],
      ['pillar', 3, 30, 400, 1, false, null],
      ['pillarRare', 3, 60, 400, 1, false, null],
      ['pillarThickness', 3, 60, 400, 1, false, null],
      ['roughness', 3, 32, 32, 1, false, null],
      ['roughnessMod', 3, 128, 128, 1, false, null],
      ['entrance', 3, 128, 128, 3, false, [0.4, 0.5, 1.0]],
      ['entranceA', 3, 64, 64, 1, false, null],
      ['entranceB', 3, 64, 64, 1, false, null],
    ]);
    for (const [id, d] of Object.entries(n)) {
      expect([id, d.clampSigma, d.remap]).toEqual([id, 3, 'none']);
      // λy = λ / yScale ≥ 16 (SP3b's rule: 2 × the 8-block vertical corner step; `schema.ts`' overhang doc).
      expect(d.wavelength / d.yScale, id).toBeGreaterThanOrEqual(16 - 1e-9);
    }
  });

  test('the names under density.noises and caves.noises are disjoint', () => {
    const density = Object.keys(DEFAULTS.density.noises);
    expect(Object.keys(DEFAULTS.caves.noises).filter((id) => density.includes(id))).toEqual([]);
  });
});

describe('the cave terms of the default tree (SP6a spec §1.1-§1.2)', () => {
  const dc: DensityContext = createDensityContext(CTX);
  const ref = createDensityReference(dc.expr, dc.noises);
  const expr: DensityExpr = dc.expr;

  test('the default tree validates (tier 2) and compiles; each family tap exists once, at its path', () => {
    expect(validateDensitySource(DEFAULT_DENSITY_TREE)).toEqual([]);
    expect(dc.compiled.root).toBeGreaterThanOrEqual(0);
    const counts = tapCounts(DEFAULT_DENSITY_TREE);
    for (const name of ['entrances', 'cheese', 'pillars', 'precave', 'terrain', 'islands']) expect([name, counts.get(name)]).toEqual([name, 1]);
    expect(at(DEFAULT_DENSITY_TREE, P.entrances)).toMatchObject({ op: 'tap', name: 'entrances' });
    expect(at(DEFAULT_DENSITY_TREE, P.cheese)).toMatchObject({ op: 'tap', name: 'cheese' });
    expect(at(DEFAULT_DENSITY_TREE, P.pillars)).toMatchObject({ op: 'tap', name: 'pillars' });
    expect(at(DEFAULT_DENSITY_TREE, P.keep)).toMatchObject({ op: 'rangeChoice', lo: -1e9, hi: { param: 'caves.pillars.threshold' }, inside: { op: 'const', v: -1e6 } });
    expect(at(DEFAULT_DENSITY_TREE, `${P.keep}.outside`)).toEqual({ op: 'ref', name: 'pillars' });
    expect(at(DEFAULT_DENSITY_TREE, `${P.keep}.x`)).toEqual({ op: 'mul', a: { op: 'ref', name: 'pillars' }, b: { op: 'const', v: 0.0625 } });
    // The noodle slot stays const 1e6 until Task 7.
    expect(at(DEFAULT_DENSITY_TREE, 'root.a.b')).toEqual({ op: 'const', v: 1000000 });
    // Each tap is one compiled node (two `ref pillars` read one tap).
    for (const name of ['entrances', 'cheese', 'pillars']) {
      expect(dc.compiled.nodes.filter((n) => n.op === 'tap' && (n.expr as TapExpr).name === name).length).toBe(1);
    }
  });

  test('compiled = reference on the SP5c columns and the cave class column (root and the family taps, bit for bit)', () => {
    for (const [cx, cz] of COLUMNS) {
      const s = dc.column(cx, cz);
      for (const [lx, lz] of [[0, 0], [5, 11], [15, 15], [9, 3]] as const) {
        for (let y = -64; y < 320; y++) {
          const x = 16 * cx + lx, z = 16 * cz + lz;
          const got = dc.compiled.voxelFn(lx, y, lz), want = ref.voxel(s, x, y, z);
          if (!Object.is(got, want)) throw new Error(`root at (${x}, ${y}, ${z}): compiled ${got}, reference ${want}`);
          for (const name of ['entrances', 'cheese', 'pillars']) {
            const g = dc.compiled.tapFn(name, lx, y, lz), w = ref.tap(s, name, x, y, z);
            if (!Object.is(g, w)) throw new Error(`${name} at (${x}, ${y}, ${z}): compiled ${g}, reference ${w}`);
          }
        }
      }
    }
  });

  test('30 to 45 blocks under the surface of a land column, some voxel of E, C and P is ≤ 0 in a 32 × 32 scan', () => {
    // 16 depths, not one: the entrance arm's Ne·(1/6) (SP6a §1.2) opens where Ne < −2.22, so below the surface E is
    // ≤ 0 mostly in its thin tubes (arm 2), which cross the 32 × 32 square at 25 of these voxels and at none at depth 30.
    const lows = new Map<string, number>([['entrances', 0], ['cheese', 0], ['pillars', 0]]);
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) {
        const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15;
        dc.column(cx, cz);
        let top = 319;
        while (top > -64 && dc.compiled.tapFn('terrain', lx, top, lz) <= 0) top--;
        expect(top).toBeGreaterThanOrEqual(63);
        for (let d = 30; d <= 45; d++) {
          for (const name of lows.keys()) if (dc.compiled.tapFn(name, lx, top - d, lz) <= 0) lows.set(name, lows.get(name)! + 1);
        }
      }
    }
    for (const [name, n] of lows) expect([name, n > 0]).toEqual([name, true]);
  });

  test('detailG is 0 bit for bit where interpolated(ref body) ≥ 16 and the detail term below 16', () => {
    const detailG = at(expr, P.detailG) as Expr & { x: Expr; inside: Expr };
    expect(detailG).toMatchObject({ op: 'rangeChoice', lo: -1e9, hi: 16, outside: { op: 'const', v: 0 } });
    expect(detailG.x).toMatchObject({ op: 'interpolated', x: { op: 'ref', name: 'body' } });
    let above = 0, below = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.column(cx, cz);
      for (let y = -64; y < 320; y++) {
        const x = 16 * cx + 7, z = 16 * cz + 2;
        const t = ref.voxel(s, x, y, z, detailG.x);
        const g = ref.voxel(s, x, y, z, detailG);
        if (t >= 16) { expect(Object.is(g, 0)).toBe(true); above++; } else { expect(Object.is(g, ref.voxel(s, x, y, z, detailG.inside))).toBe(true); below++; }
      }
    }
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  test('sky gives 32 at every corner 8 or more above the surface', () => {
    const sky = at(expr, `${P.cheese}.x.x`) as Expr;
    expect(sky).toMatchObject({ op: 'rangeChoice', lo: -1e9, hi: -8, inside: { op: 'const', v: 32 } });
    const body = expr.defs['body']!;
    let n = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.column(cx, cz);
      for (let k = 0; k <= 48; k++) {
        for (let j = 0; j <= 4; j++) {
          for (let i = 0; i <= 4; i++) {
            if (ref.corner(s, body, i, k, j) >= -8) continue;
            expect(ref.corner(s, sky, i, k, j)).toBe(32);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  test('with caves.limits.surfaceDepth 8 the ramp is 0 at T ≥ 8, 16 at T = 0 and 32 at T ≤ −8', () => {
    const ramp = at(expr, `${P.cheese}.x.x.outside.b`) as Expr;
    expect(ramp).toMatchObject({ op: 'clamp', lo: 0, hi: 32 });
    expect(DEFAULTS.caves.limits.surfaceDepth).toBe(8);
    const s = dc.column(0, 0);
    const rampAt = (t: number): number => {
      const e: DensityExpr = { root: ramp, defs: { body: { op: 'const', v: t } } };
      return createDensityReference(e, dc.noises).voxel(s, 0, 0, 0);
    };
    expect([20, 8, 4, 0, -4, -8, -20].map(rampAt)).toEqual([0, 0, 8, 16, 24, 32, 32]);
  });
});

describe('the family floor F = 48 (SP6a spec §1.4)', () => {
  /** The leaves at the ends of their static ranges that lower the families most: clampSigma 8, offsets −0.5. */
  const WORST: ParamsPatch = {
    caves: {
      cheese: { offset: -0.5, regional: 0.4, layerAmp: 0, roofDepth: 0 },
      entrances: { offset: -0.5, threshold: 0.5 },
      limits: { surfaceDepth: 0 },
      noises: Object.fromEntries(Object.keys(DEFAULTS.caves.noises).map((id) => [id, { clampSigma: 8 }])),
    },
  };

  test('each family\'s slot interval over the leaves\' static ranges is ≥ −48 (bounds.ts\' intervals; the unfloored entrances reach −62.7)', () => {
    const params = paramsWith(WORST);
    const ctx = ctxFor('42', WORST);
    const dc = createDensityContext(ctx, resolveDensity(params.density.defs, params));
    const c = dc.compiled;
    const tapId = (name: string): number => c.nodes.findIndex((n) => n.op === 'tap' && (n.expr as TapExpr).name === name);
    /** The slot: the `interpolated` node under the family tap, and its child (the corner values' node). */
    const slot = (name: string): number => c.nodes[tapId(name)]!.kids[0]!;
    /** The floor's operand: the first child of the `max(v, −48)` node under the slot. */
    const floored = (name: string): number => {
      let k = slot(name);
      for (;;) {
        const n = c.nodes[k]!;
        const b = n.op === 'max' ? c.nodes[n.kids[1]!]! : null;
        if (b !== null && b.op === 'const' && (b.expr as { v: number }).v === -48) return n.kids[0]!;
        k = n.op === 'rangeChoice' ? n.kids[2]! : n.op === 'add' ? n.kids[0]! : n.kids[0]!;
      }
    };
    const iv = new Float64Array(2);
    const lo = (k: number): number => dc.bounds.nodeIntervals[2 * k]!;
    const corner = new Map<string, number>(), tap = new Map<string, number>(), raw = new Map<string, number>();
    const low = (m: Map<string, number>, name: string, v: number): void => { m.set(name, Math.min(m.get(name) ?? Infinity, v)); };
    dc.column(0, 0);
    dc.bounds.beginColumn();
    for (let ck = 0; ck < 48; ck++) {
      dc.bounds.cellInterval(1, ck, 2, iv, 0);
      for (const name of ['entrances', 'cheese']) {
        expect(c.nodes[slot(name)]!.op).toBe('interpolated');
        low(corner, name, lo(c.nodes[slot(name)]!.kids[0]!));
        low(tap, name, lo(tapId(name)));
        low(raw, name, lo(floored(name)));
      }
    }
    for (const name of ['entrances', 'cheese']) {
      // Every corner value the slot interpolates is ≥ −48; the slot's own interval is that hull widened by the
      // bounds' rounding margin (a few ulps of 48).
      expect([name, corner.get(name)! >= -48]).toEqual([name, true]);
      expect(tap.get(name)! >= -48 * (1 + 1e-8)).toBe(true);
    }
    // Spec §1.4: without the floor, entrances reach −62.72 at clampSigma 8 and entrances.threshold 0.5 (the tube arm:
    // 16·(−0.45·7.6 − 0.5)); the scaled Ne arm reaches 16·(−8/6 − 0.5) ≈ −29.3 at entrances.offset −0.5 (§1.2); cheese
    // is clamped to −16.
    expect(raw.get('entrances')).toBeCloseTo(16 * (-0.45 * 7.6 - 0.5), 9);
    expect(raw.get('cheese')).toBe(-16);
    expect(corner.get('entrances')).toBe(-48);
  });
});

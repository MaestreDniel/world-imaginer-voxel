/**
 * SP6a Task 6 (spec §1.1, §1.2, §1.4, §4): the `caves` group's first leaves and noises and the cave terms of the default
 * density tree: entrances E, cheese C and pillars P with `keep`, the shared `fl`, `sky`, `ramp` and `rough`, and
 * `detailG` in place of the detail term. SP6a Task 7 (spec §1.1-§1.3): spaghetti 3D (S3) and 2D (S2) with their
 * continuous rarity blends, and the noodle with its four slots and `nb`.
 */
import { describe, expect, test } from 'vitest';
import { SPAGHETTI_BANDS, type SpaghettiBands } from '../../src/core/constants';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import { compileDensity } from '../../src/gen/density/compile';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr, TapExpr } from '../../src/gen/density/expr';
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
/** The tunnels' cave class column of seed 42 (the second scan slot; pinned in test/unit/liveness.test.ts). */
const TUNNEL_COLUMN: readonly [number, number] = [4705, -24478];
/** SP5c's value-check columns and the cave class columns. */
const COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [-1667, -2000], [40, 900], CAVE_COLUMN, TUNNEL_COLUMN];
/** The family taps (SP6a §1.1). */
const FAMILY_TAPS = ['entrances', 'cheese', 'spag3d', 'spag2d', 'noodle', 'pillars'] as const;

/** The paths of the cave terms in the default source tree (SP6a §1.1): the caves slot max(min(min(min(E, C), S3), S2), keep). */
const P = {
  detailG: 'root.a.a.a.x.b',
  caves: 'root.a.a.b',
  entrances: 'root.a.a.b.a.a.a.a',
  cheese: 'root.a.a.b.a.a.a.b',
  spag3d: 'root.a.a.b.a.a.b',
  spag2d: 'root.a.a.b.a.b',
  keep: 'root.a.a.b.b',
  noodle: 'root.a.b',
  pillars: 'defs.pillars',
} as const;
/** max(rmS(S1), rmS(S2)) in the spaghetti 3D slot, and rmS2(S2d) in the spaghetti 2D slot (the same paths resolved). */
const BLEND = {
  spaghetti3d: `${P.spag3d}.x.x.outside.a.a.b.b.x.a.a.a`,
  spaghetti2d: `${P.spag2d}.x.x.outside.a.a.b.x.a.a`,
} as const;

describe('the caves group (SP6a spec §4)', () => {
  test('the leaves of this task, sizes first, every one Terrain-scoped on the terrain stage, with spec §4\'s defaults and ranges', () => {
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('caves.') && !l.path.startsWith('caves.noises.'));
    expect(leaves.map((l) => [l.path, l.leaf.def, l.leaf.min, l.leaf.max])).toEqual([
      ['caves.cheese.offset', 0.27, -0.5, 1],
      ['caves.cheese.regional', 0.1, 0, 0.4],
      ['caves.cheese.layerAmp', 4, 0, 8],
      ['caves.cheese.roofDepth', 12, 0, 48],
      ['caves.spaghetti3d.thickness', 0.0765, 0, 0.3],
      ['caves.spaghetti3d.thicknessVar', 0.0115, 0, 0.1],
      ['caves.spaghetti3d.regional', 0.05, 0, 0.2],
      ['caves.spaghetti3d.scales.s0', 0.75, 1 / 16, 16],
      ['caves.spaghetti3d.scales.s1', 1, 1 / 16, 16],
      ['caves.spaghetti3d.scales.s2', 1.5, 1 / 16, 16],
      ['caves.spaghetti3d.scales.s3', 2, 1 / 16, 16],
      ['caves.spaghetti2d.thickness', 0.95, 0.5, 1.5],
      ['caves.spaghetti2d.layerAmp', 8, 0, 32],
      ['caves.spaghetti2d.scales.s0', 0.5, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s1', 0.75, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s2', 1, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s3', 2, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s4', 3, 1 / 16, 16],
      ['caves.noodles.thickness', 0.075, 0, 0.3],
      ['caves.noodles.ridgeMul', 1.5, 0.5, 4],
      ['caves.noodles.regional', 0.1, 0, 0.4],
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
      ['spag3dA', 3, 64, 64, 1, false, null],
      ['spag3dB', 3, 64, 64, 1, false, null],
      ['spag3dRarity', 3, 128, 128, 1, false, null],
      ['spag3dThickness', 3, 64, 64, 1, false, null],
      ['spagRegional', 2, 1024, 1024, 2, false, null],
      ['spag2d', 3, 128, 128, 1, false, null],
      ['spag2dElevation', 2, 256, 256, 2, false, null],
      ['spag2dThickness', 3, 64, 64, 1, false, null],
      ['spag2dRarity', 3, 128, 128, 1, false, null],
      ['noodleToggle', 3, 64, 64, 1, false, null],
      ['noodleThickness', 3, 64, 64, 1, false, null],
      ['noodleRidgeA', 3, 18, 18, 1, false, null],
      ['noodleRidgeB', 3, 18, 18, 1, false, null],
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
    for (const name of [...FAMILY_TAPS, 'precave', 'terrain', 'islands']) expect([name, counts.get(name)]).toEqual([name, 1]);
    for (const name of FAMILY_TAPS) expect(at(DEFAULT_DENSITY_TREE, P[name])).toMatchObject({ op: 'tap', name });
    // The caves slot: max(min(min(min(E, C), S3), S2), keep), its mins left-nested in that order.
    expect(['root.a.a.b', 'root.a.a.b.a', 'root.a.a.b.a.a', 'root.a.a.b.a.a.a'].map((p) => (at(DEFAULT_DENSITY_TREE, p) as Rec)['op'])).toEqual(['max', 'min', 'min', 'min']);
    // The spaghetti slots are interpolated under the tap; the noodle is combined at voxel level from four slots.
    for (const name of ['spag3d', 'spag2d'] as const) expect(at(DEFAULT_DENSITY_TREE, `${P[name]}.x`)).toMatchObject({ op: 'interpolated' });
    expect(at(DEFAULT_DENSITY_TREE, `${P.noodle}.x`)).toMatchObject({ op: 'max', b: { op: 'const', v: -48 } });
    expect(tapCounts(at(DEFAULT_DENSITY_TREE, P.noodle)).size).toBe(1);
    const noodleSlots: unknown[] = [];
    const walk = (x: unknown): void => {
      if (!isRec(x)) return;
      if (x['op'] === 'interpolated') { noodleSlots.push(x['x']); return; }
      for (const v of Object.values(x)) walk(v);
    };
    walk(at(DEFAULT_DENSITY_TREE, P.noodle));
    expect(noodleSlots.length).toBe(4);
    expect(at(DEFAULT_DENSITY_TREE, P.keep)).toMatchObject({ op: 'rangeChoice', lo: -1e9, hi: { param: 'caves.pillars.threshold' }, inside: { op: 'const', v: -1e6 } });
    expect(at(DEFAULT_DENSITY_TREE, `${P.keep}.outside`)).toEqual({ op: 'ref', name: 'pillars' });
    expect(at(DEFAULT_DENSITY_TREE, `${P.keep}.x`)).toEqual({ op: 'mul', a: { op: 'ref', name: 'pillars' }, b: { op: 'const', v: 0.0625 } });
    // Each tap is one compiled node (two `ref pillars` read one tap); the ten interpolated slots of spec §1.6.
    expect(dc.compiled.interpolatedSlotCount).toBe(10);
    for (const name of FAMILY_TAPS) {
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
          for (const name of FAMILY_TAPS) {
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

  test('sky gives 32 at every corner 8 or more above the surface (cheese, spaghetti 3D and 2D)', () => {
    const body = expr.defs['body']!;
    for (const name of ['cheese', 'spag3d', 'spag2d'] as const) {
      const sky = at(expr, `${P[name]}.x.x`) as Expr;
      expect(sky).toMatchObject({ op: 'rangeChoice', lo: -1e9, hi: -8, inside: { op: 'const', v: 32 } });
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
      expect([name, n > 0]).toEqual([name, true]);
    }
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
      spaghetti3d: { thickness: 0.3, thicknessVar: 0.1, regional: 0.2 },
      spaghetti2d: { thickness: 1.5 },
      noodles: { thickness: 0.3, regional: 0.4 },
      entrances: { offset: -0.5, threshold: 0.5 },
      limits: { surfaceDepth: 0 },
      noises: Object.fromEntries(Object.keys(DEFAULTS.caves.noises).map((id) => [id, { clampSigma: 8 }])),
    },
  };

  test('each family\'s slot interval over the leaves\' static ranges is ≥ −48 (bounds.ts\' intervals; the unfloored entrances reach −62.7, spaghetti 3D −70.7)', () => {
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
    const SLOTTED = ['entrances', 'cheese', 'spag3d', 'spag2d'] as const;
    for (let ck = 0; ck < 48; ck++) {
      dc.bounds.cellInterval(1, ck, 2, iv, 0);
      for (const name of SLOTTED) {
        expect(c.nodes[slot(name)]!.op).toBe('interpolated');
        low(corner, name, lo(c.nodes[slot(name)]!.kids[0]!));
        low(tap, name, lo(tapId(name)));
        low(raw, name, lo(floored(name)));
      }
      // The noodle is floored at voxel level (its tap's child is the floor).
      low(tap, 'noodle', lo(tapId('noodle')));
      low(raw, 'noodle', lo(floored('noodle')));
    }
    for (const name of SLOTTED) {
      // Every corner value the slot interpolates is ≥ −48; the slot's own interval is that hull widened by the
      // bounds' rounding margin (a few ulps of 48).
      expect([name, corner.get(name)! >= -48]).toEqual([name, true]);
      expect([name, tap.get(name)! >= -48 * (1 + 1e-8)]).toEqual([name, true]);
    }
    expect(tap.get('noodle')! >= -48).toBe(true);
    // Spaghetti 3D unfloored: 16·(rough + clamp(…, −1, 1)) ≥ 16·(−0.45·7.6 − 1) = −70.72 (rough's interval at clampSigma
    // 8); spaghetti 2D is clamped to −16; the noodle reaches 16·(−0.3 − 0.025·8) = −8 at thickness 0.3.
    expect(raw.get('spag3d')).toBeCloseTo(16 * (-0.45 * 7.6 - 1), 9);
    expect(raw.get('spag2d')).toBe(-16);
    // (a voxel-level interval, widened outward by the bounds' rounding margin: about 4e-9 here)
    expect(raw.get('noodle')).toBeCloseTo(-8, 6);
    expect(raw.get('noodle')! <= -8).toBe(true);
    expect(corner.get('spag3d')).toBe(-48);
    // Spec §1.4: without the floor, entrances reach −62.72 at clampSigma 8 and entrances.threshold 0.5 (the tube arm:
    // 16·(−0.45·7.6 − 0.5)); the scaled Ne arm reaches 16·(−8/6 − 0.5) ≈ −29.3 at entrances.offset −0.5 (§1.2); cheese
    // is clamped to −16.
    expect(raw.get('entrances')).toBeCloseTo(16 * (-0.45 * 7.6 - 0.5), 9);
    expect(raw.get('cheese')).toBe(-16);
    expect(corner.get('entrances')).toBe(-48);
  });
});

/** A noise source over `base` that counts the z3 calls of the noises in `watch` (the counting noise stub). */
function countingNoises(base: DensityNoiseSource, watch: readonly string[]): { source: DensityNoiseSource; calls: Map<string, number> } {
  const calls = new Map<string, number>(watch.map((id) => [id, 0]));
  const wrapped = new Map<string, DensityNoise>();
  const source: DensityNoiseSource = (id) => {
    const n = base(id);
    if (n === undefined || !calls.has(id)) return n;
    let w = wrapped.get(id);
    if (w === undefined) {
      w = { dims: n.dims, remap: n.remap, clampSigma: n.clampSigma, z2: (x, z) => n.z2(x, z), z3: (x, y, z) => { calls.set(id, calls.get(id)! + 1); return n.z3(x, y, z); } };
      wrapped.set(id, w);
    }
    return w;
  };
  return { source, calls };
}

/** Band k of `bands` widened by its blend zones, [e_k − 0.05, e_{k+1} + 0.05): where its weight can be non-zero. */
const widened = (bands: SpaghettiBands, k: number): readonly [number, number] =>
  [k === 0 ? -Infinity : bands.zones[k - 1]![0], k === bands.zones.length ? Infinity : bands.zones[k]![1]];
/** The weights of the rarity blend at r (SP6a §1.3), computed here from the edges: w_k = step_k − step_{k+1}. */
function weights(bands: SpaghettiBands, r: number): number[] {
  const step = (z: number): number => Math.min(1, Math.max(0, (r - bands.zones[z]![0]) * 10));
  const n = bands.zones.length + 1;
  return Array.from({ length: n }, (_, k) => (k === 0 ? 1 - step(0) : k === n - 1 ? step(k - 1) : step(k - 1) - step(k)));
}

describe('the rarity blend of the spaghetti families (SP6a spec §1.3)', () => {
  const ctx = CTX;
  const dc: DensityContext = createDensityContext(ctx);
  const ref = createDensityReference(dc.expr, dc.noises);
  const FAMILIES = [
    { name: 'spaghetti3d', bands: SPAGHETTI_BANDS.spaghetti3d, blend: BLEND.spaghetti3d, noiseOf: (e: Expr) => (e as { a: Expr }).a },
    { name: 'spaghetti2d', bands: SPAGHETTI_BANDS.spaghetti2d, blend: BLEND.spaghetti2d, noiseOf: (e: Expr) => e },
  ] as const;

  test('each band\'s noiseScaled term sits under a rangeChoice on the rarity noise over its widened band', () => {
    for (const f of FAMILIES) {
      const terms: Rec[] = [];
      const walk = (x: unknown): void => {
        if (!isRec(x)) return;
        if (x['op'] === 'rangeChoice' && isRec(x['x']) && x['x']['op'] === 'noise' && x['x']['id'] === f.bands.rarity) { terms.push(x); return; }
        for (const v of Object.values(x)) walk(v);
      };
      walk(at(DEFAULT_DENSITY_TREE, f.name === 'spaghetti3d' ? P.spag3d : P.spag2d));
      const n = f.bands.zones.length + 1;
      expect(terms.length).toBe(n * f.bands.noises.length);
      terms.forEach((t, i) => {
        const k = i % n;
        const [lo, hi] = widened(f.bands, k);
        expect([f.name, k, t['lo'], t['hi'], t['outside']]).toEqual([f.name, k, k === 0 ? -1e9 : lo, k === n - 1 ? 1e9 : hi, { op: 'const', v: 0 }]);
        const scaled: Rec[] = [];
        const find = (x: unknown): void => { if (isRec(x)) { if (x['op'] === 'noiseScaled') scaled.push(x); else Object.values(x).forEach(find); } };
        find(t['inside']);
        expect(scaled).toEqual([{ op: 'noiseScaled', id: f.bands.noises[Math.floor(i / n)], s: { param: `${f.bands.scales}.s${k}` } }]);
      });
    }
  });

  test('on 1-block lines across each band edge: the blend equals the band\'s plain scale outside ±0.05, blends linearly inside, and has no jump above its local Lipschitz bound', () => {
    for (const f of FAMILIES) {
      const blend = f.noiseOf(at(dc.expr, f.blend) as Expr);
      const rarity = dc.noises(f.bands.rarity)!;
      const N = dc.noises(f.bands.noises[0]!)!;
      const m = Object.values((ctx.params.caves as unknown as Record<string, { scales: Record<string, number> }>)[f.name]!.scales);
      /** The plain value of band k at a voxel: m_k·|z3(x / m_k, y / m_k, z / m_k)| (noiseScaled's division order). */
      const plain = (k: number, x: number, y: number, z: number): number => m[k]! * Math.abs(N.z3(x / m[k]!, y / m[k]!, z / m[k]!));
      f.bands.zones.forEach(([zlo, zhi], e) => {
        const edge = (zlo + zhi) / 2;
        // The first vertical line (columns in COLUMNS order, then positions) whose rarity crosses this edge with a gentle
        // step at the crossing (|Δr| ≤ 0.05 per block, so the blend spans at least two steps).
        let found: { cx: number; cz: number; lx: number; lz: number } | null = null;
        search: for (const [cx, cz] of [...COLUMNS, [7, -3], [-120, 64], [300, 301]] as const) {
          for (let lz = 0; lz < 16; lz += 5) {
            for (let lx = 0; lx < 16; lx += 5) {
              const x = 16 * cx + lx, z = 16 * cz + lz;
              for (let y = -64; y < 319; y++) {
                const r0 = rarity.z3(x, y, z), r1 = rarity.z3(x, y + 1, z);
                if ((r0 - edge) * (r1 - edge) <= 0 && Math.abs(r1 - r0) <= 0.05) { found = { cx, cz, lx, lz }; break search; }
              }
            }
          }
        }
        expect(found, `${f.name} edge ${edge}: no crossing line`).not.toBeNull();
        const { cx, cz, lx, lz } = found!;
        const s = dc.column(cx, cz);
        const x = 16 * cx + lx, z = 16 * cz + lz;
        let inZone = 0, outside = 0;
        let prev: { v: number; r: number; t: number[] } | null = null;
        for (let y = -64; y < 320; y++) {
          const v = ref.voxel(s, x, y, z, blend);
          const r = rarity.z3(x, y, z);
          const w = weights(f.bands, r);
          const t = w.map((_, k) => plain(k, x, y, z));
          const band = f.bands.zones.filter(([lo]) => r >= lo).length;
          const zone = f.bands.zones.findIndex(([lo, hi]) => r >= lo && r < hi);
          if (zone < 0) {
            // Outside every blend zone: the band's plain value, bit for bit.
            if (!Object.is(v, t[band]!)) throw new Error(`${f.name} at (${x}, ${y}, ${z}), r ${r}: ${v} ≠ plain s${band} ${t[band]}`);
            outside++;
          } else {
            // Inside a zone: the linear blend of the two neighbours, w = clamp((r − (e − 0.05))·10, 0, 1).
            const want = w[zone]! * t[zone]! + w[zone + 1]! * t[zone + 1]!;
            expect(Math.abs(v - want)).toBeLessThanOrEqual(1e-12 * (1 + Math.abs(want)));
            expect(v).toBeGreaterThanOrEqual(Math.min(t[zone]!, t[zone + 1]!) - 1e-12);
            expect(v).toBeLessThanOrEqual(Math.max(t[zone]!, t[zone + 1]!) + 1e-12);
            inZone++;
          }
          if (prev !== null) {
            // The local Lipschitz bound of Σ w_k·T_k over one step: max_k |ΔT_k| + Σ_k |Δw_k|·|T_k(y − 1)|, the k with a
            // non-zero weight at either end (|Δw_k| ≤ 10·|Δr|: clamp is 1-Lipschitz).
            const w0 = weights(f.bands, prev.r);
            let bound = 0;
            for (let k = 0; k < w.length; k++) {
              if (w[k] === 0 && w0[k] === 0) continue;
              bound = Math.max(bound, Math.abs(t[k]! - prev.t[k]!));
            }
            for (let k = 0; k < w.length; k++) bound += Math.abs(w[k]! - w0[k]!) * Math.abs(prev.t[k]!);
            if (!(Math.abs(v - prev.v) <= bound + 1e-12)) throw new Error(`${f.name} at (${x}, ${y}, ${z}): jump ${Math.abs(v - prev.v)} above ${bound}`);
          }
          prev = { v, r, t };
        }
        expect([f.name, e, inZone > 0, outside > 0]).toEqual([f.name, e, true, true]);
      });
    }
  });

  test('a noiseScaled term is not evaluated at a corner outside its widened band (a counting noise stub, compiled)', () => {
    for (const f of FAMILIES) {
      const { source, calls } = countingNoises(dc.noises, f.bands.noises);
      const c = compileDensity(dc.expr, source);
      const rarity = dc.noises(f.bands.rarity)!;
      const body = createDensityReference(dc.expr, dc.noises);
      const bodyExpr = dc.expr.defs['body']!;
      let skipped = 0, blended = 0, plainOnly = 0;
      for (const [cx, cz] of COLUMNS) {
        const s = dc.columns.get(cx, cz);
        c.columnFn(s);
        c.positionFn(s);
        for (let k = 0; k <= 48; k++) {
          for (let j = 0; j <= 4; j++) {
            for (let i = 0; i <= 4; i++) {
              const before = f.bands.noises.map((id) => calls.get(id)!);
              c.cornerFn(i, k, j);
              const got = f.bands.noises.map((id, q) => calls.get(id)! - before[q]!);
              // The sky gate evaluates nothing at corners 8 or more above the surface.
              if (body.corner(s, bodyExpr, i, k, j) < -8) { expect(got.every((g) => g === 0)).toBe(true); skipped++; continue; }
              const r = rarity.z3(16 * cx + 4 * i, -64 + 8 * k, 16 * cz + 4 * j);
              let want = 0;
              for (let b = 0; b <= f.bands.zones.length; b++) { const [lo, hi] = widened(f.bands, b); if (r >= lo && r < hi) want++; }
              for (const g of got) if (g !== want) throw new Error(`${f.name} corner (${i}, ${k}, ${j}) of (${cx}, ${cz}), r ${r}: ${g} evaluations, ${want} bands`);
              if (want === 2) blended++; else plainOnly++;
            }
          }
        }
      }
      expect([f.name, skipped > 0, blended > 0, plainOnly > 0]).toEqual([f.name, true, true, true]);
    }
  });
});

describe('the noodle (SP6a spec §1.1, §1.3)', () => {
  const dc: DensityContext = createDensityContext(CTX);
  const NOODLE_NOISES = ['noodleToggle', 'noodleThickness', 'noodleRidgeA', 'noodleRidgeB'] as const;
  /** The noodle tap's child (resolved) with its four slots replaced by constants: Nn, Kn, An, Bn in the written order. */
  const noodleAt = (nn: number, kn: number, an: number, bn: number): number => {
    const tapNode = at(dc.expr, P.noodle) as TapExpr;
    const slots = new Map<string, number>();
    const sub = (x: unknown): unknown => {
      if (!isRec(x)) return Array.isArray(x) ? x.map(sub) : x;
      if (x['op'] === 'interpolated') {
        const id = JSON.stringify(x['x']).match(/"id":"(noodle\w+)"/)![1]!;
        slots.set(id, 1);
        const v = id === 'noodleToggle' ? nn : id === 'noodleThickness' ? kn : id === 'noodleRidgeA' ? an : bn;
        return { op: 'const', v };
      }
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]));
    };
    const root = sub(tapNode.x) as Expr;
    expect([...slots.keys()].sort()).toEqual([...NOODLE_NOISES].sort());
    return createDensityReference({ root, defs: {} }, dc.noises).voxel(dc.column(0, 0), 0, 0, 0);
  };
  const SIGMA = 3;
  const grid = [-SIGMA, -2, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 2, SIGMA];

  test('with Nrb = 0 and Nn ≤ −0.04 the noodle is closed (> 0) for every Kn, An, Bn in ±clampSigma', () => {
    // Closure needs 4·|Nn| ≥ thickness + 0.025·clampSigma = 0.15 at the defaults, so Nn ≤ −0.0375.
    expect(DEFAULTS.caves.noises.noodleThickness.clampSigma).toBe(SIGMA);
    for (const nn of [-0.04, -0.05, -0.1, -0.5, -1, -SIGMA]) {
      for (const kn of grid) for (const an of grid) for (const bn of grid) {
        const v = noodleAt(nn, kn, an, bn);
        if (!(v > 0)) throw new Error(`noodle ${v} at Nn ${nn}, Kn ${kn}, An ${an}, Bn ${bn}`);
      }
    }
    // The tightest case: Kn = clampSigma, An = Bn = 0 is open at Nn = −0.037 and closed at −0.038.
    expect(noodleAt(-0.037, SIGMA, 0, 0)).toBeLessThan(0);
    expect(noodleAt(-0.038, SIGMA, 0, 0)).toBeGreaterThan(0);
  });

  test('at Kn = 0 and An = Bn = 0 it closes by Nn = −0.019 (−thickness / 4), and is open at the full toggle (Nn ≥ 0)', () => {
    expect(DEFAULTS.caves.noodles.thickness).toBe(0.075);
    expect(noodleAt(-0.018, 0, 0, 0)).toBeLessThan(0);
    expect(noodleAt(-0.019, 0, 0, 0)).toBeGreaterThan(0);
    for (const nn of [0, 0.5, SIGMA]) expect(noodleAt(nn, 0, 0, 0)).toBe(16 * -0.075);
    // The ridges: open only where max(|An|, |Bn|) < thickness / ridgeMul = 0.05.
    expect(noodleAt(0, 0, 0.049, -0.049)).toBeLessThan(0);
    expect(noodleAt(0, 0, 0.051, 0)).toBeGreaterThan(0);
  });

  test('the noodle noises are not evaluated at corners more than 40 blocks outside y −60 … 64 (a counting stub)', () => {
    const { source, calls } = countingNoises(dc.noises, NOODLE_NOISES);
    const c = compileDensity(dc.expr, source);
    const constants: number[] = [];
    let inside = 0, outside = 0;
    for (const [cx, cz] of COLUMNS) {
      const s = dc.columns.get(cx, cz);
      c.columnFn(s);
      c.positionFn(s);
      for (let k = 0; k <= 48; k++) {
        const y = -64 + 8 * k;
        const near = y - 64 < 40 && -60 - y < 40;
        for (let j = 0; j <= 4; j++) {
          for (let i = 0; i <= 4; i++) {
            const before = NOODLE_NOISES.map((id) => calls.get(id)!);
            c.cornerFn(i, k, j);
            const got = NOODLE_NOISES.map((id, q) => calls.get(id)! - before[q]!);
            expect(got, `corner y ${y}`).toEqual(NOODLE_NOISES.map(() => (near ? 1 : 0)));
            if (near) inside++; else outside++;
          }
        }
      }
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
    // Outside the band the constants close the tube: Nn −1 (the toggle adds 4), Kn 0, An and Bn 1 (the ridge adds 1.5).
    const s = dc.column(0, 0);
    const ref = createDensityReference(dc.expr, dc.noises);
    const slots: Expr[] = [];
    const walk = (x: unknown): void => { if (isRec(x)) { if (x['op'] === 'interpolated') slots.push(x['x'] as Expr); else Object.values(x).forEach(walk); } };
    walk(at(dc.expr, P.noodle));
    for (const e of slots) constants.push(ref.corner(s, e, 0, 48, 0));
    expect(constants).toEqual([0, 1, 1, -1]);
    expect(noodleAt(-1, 0, 1, 1)).toBe(16 * (-0.075 + 1.5 + 4));
  });
});

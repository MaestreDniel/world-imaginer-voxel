/**
 * SP6a Task 6 (spec §1.1, §1.2, §1.4, §4): the `caves` group's first leaves and noises and the cave terms of the default
 * density tree: entrances E, cheese C and pillars P with `keep`, the shared `fl`, `sky`, `ramp` and `rough`, and
 * `detailG` in place of the detail term. SP6a Task 7 (spec §1.1-§1.3): spaghetti 3D (S3) and 2D (S2) with their
 * continuous rarity blends, and the noodle with its four slots and `nb`. SP6a Task 8 (spec §1.4, §4): each family's
 * depth band (`minY`, `maxY`, `caves.limits.bandSpan`) and its cap, a gentle part then a steep part. SP6a Task 9 (spec
 * §1.4, D8): the island cap `caves.limits.capTop` in every family's cap.
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
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { buildColumnSample, latticeIndex, newColumnSample, riverWetAt } from '../../src/gen/column/columnStage';
import { samplePoints } from '../../src/metrics/noiseStats';
import { ctxFor, paramsWith } from '../harness/gen';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The node at a dotted path (`root.a.b`, `defs.pillars.x`). */
const at = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n as Rec)[k], v);
/** `interpolated(ref body)`: T at voxel level, the noodle cap's depth d (SP6a §1.4), not one of the noodle's four slots. */
const isBodyRead = (x: Rec): boolean => isRec(x['x']) && x['x']['op'] === 'ref' && x['x']['name'] === 'body';

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
/**
 * The wet roof's columns of seed 42 (SP6a §1.4, ruling P7; re-found by the scan in 'the wet roof'): the first chunk
 * columns of `samplePoints('sp6a.caveTerms.wet', …)` whose 25 quart corners are all in a lake (lakeMask 1), all at sea
 * (offset < 63, neither a lake nor a river), and whose corners hold ≥ 9 on a river's wet flag (offset ≥ 63, no lake).
 */
const WET_COLUMNS = { lake: [-14488, -20872], river: [30566, 9365], sea: [18896, 17558] } as const satisfies Record<string, readonly [number, number]>;
/** SP5c's value-check columns and the cave class columns. */
const COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [-1667, -2000], [40, 900], CAVE_COLUMN, TUNNEL_COLUMN];
/** The family taps (SP6a §1.1). */
const FAMILY_TAPS = ['entrances', 'cheese', 'spag3d', 'spag2d', 'noodle', 'pillars'] as const;

/**
 * The paths of the cave terms in the default source tree (SP6a §1.1): the caves slot max(min(min(min(E, C), S3), S2),
 * keep), under `add(caves, ref wetSteep)` since the wet roof (Task 9), as the noodle tap under `add(noodle, ref wetSteep)`.
 */
const P = {
  detailG: 'root.a.a.a.x.b',
  caves: 'root.a.a.b.a',
  entrances: 'root.a.a.b.a.a.a.a.a',
  cheese: 'root.a.a.b.a.a.a.a.b',
  spag3d: 'root.a.a.b.a.a.a.b',
  spag2d: 'root.a.a.b.a.a.b',
  keep: 'root.a.a.b.a.b',
  noodle: 'root.a.b.a',
  pillars: 'defs.pillars',
} as const;
/** max(rmS(S1), rmS(S2)) in the spaghetti 3D slot, and rmS2(S2d) in the spaghetti 2D slot (the same paths resolved). */
const BLEND = {
  spaghetti3d: `${P.spag3d}.x.x.outside.a.a.a.b.b.x.a.a.a`,
  spaghetti2d: `${P.spag2d}.x.x.outside.a.a.a.b.x.a.a`,
} as const;
/** Each family's cap (SP6a §1.4): after `fl` and `ramp` inside the slot, after `fl` at voxel level for the noodle. */
const CAP = {
  entrances: `${P.entrances}.x.x.b`,
  cheese: `${P.cheese}.x.x.outside.b`,
  spag3d: `${P.spag3d}.x.x.outside.b`,
  spag2d: `${P.spag2d}.x.x.outside.b`,
  noodle: `${P.noodle}.x.b`,
} as const;
/** Each family's band leaves' group and G_f, the gentle rise of its cap (tree literals, SP6a §1.4). */
const BANDS = {
  entrances: ['entrances', 0.4],
  cheese: ['cheese', 5.8],
  spag3d: ['spaghetti3d', 0.5],
  spag2d: ['spaghetti2d', 0.3],
  noodle: ['noodles', 0.4],
} as const;

describe('the caves group (SP6a spec §4)', () => {
  test('the leaves of this task, sizes first, every one Terrain-scoped on the terrain stage, with spec §4\'s defaults and ranges', () => {
    const leaves = SCHEMA.leaves.filter((l) => l.path.startsWith('caves.') && !l.path.startsWith('caves.noises.'));
    expect(leaves.map((l) => [l.path, l.leaf.def, l.leaf.min, l.leaf.max])).toEqual([
      ['caves.cheese.offset', 0.27, -0.5, 1],
      ['caves.cheese.regional', 0.1, 0, 0.4],
      ['caves.cheese.layerAmp', 4, 0, 8],
      ['caves.cheese.roofDepth', 12, 0, 48],
      ['caves.cheese.minY', -56, -64, 320],
      ['caves.cheese.maxY', 320, -64, 320],
      ['caves.spaghetti3d.thickness', 0.0765, 0, 0.3],
      ['caves.spaghetti3d.thicknessVar', 0.0115, 0, 0.1],
      ['caves.spaghetti3d.regional', 0.05, 0, 0.2],
      ['caves.spaghetti3d.scales.s0', 0.75, 1 / 16, 16],
      ['caves.spaghetti3d.scales.s1', 1, 1 / 16, 16],
      ['caves.spaghetti3d.scales.s2', 1.5, 1 / 16, 16],
      ['caves.spaghetti3d.scales.s3', 2, 1 / 16, 16],
      ['caves.spaghetti3d.minY', -56, -64, 320],
      ['caves.spaghetti3d.maxY', 320, -64, 320],
      ['caves.spaghetti2d.thickness', 0.95, 0.5, 1.5],
      ['caves.spaghetti2d.layerAmp', 8, 0, 32],
      ['caves.spaghetti2d.scales.s0', 0.5, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s1', 0.75, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s2', 1, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s3', 2, 1 / 16, 16],
      ['caves.spaghetti2d.scales.s4', 3, 1 / 16, 16],
      ['caves.spaghetti2d.minY', -64, -64, 320],
      // 215, not 320: the highest default from 208 to 244 (no generated output moves) whose U2 step has a witness (spec §4).
      ['caves.spaghetti2d.maxY', 215, -64, 320],
      ['caves.noodles.thickness', 0.075, 0, 0.3],
      ['caves.noodles.ridgeMul', 1.5, 0.5, 4],
      ['caves.noodles.regional', 0.1, 0, 0.4],
      ['caves.noodles.minY', -60, -64, 320],
      ['caves.noodles.maxY', 64, -64, 320],
      ['caves.pillars.threshold', 0.03, 0, 0.5],
      ['caves.entrances.offset', 0.37, -0.5, 1],
      ['caves.entrances.threshold', 0.08, 0, 0.5],
      ['caves.entrances.minY', -64, -64, 320],
      ['caves.entrances.maxY', 320, -64, 320],
      ['caves.limits.surfaceDepth', 8, 0, 32],
      // Task 9: the wet roof's depth d_w (closed within d_w + 4 of the bed, open from d_w + 8 + bandSpan).
      ['caves.limits.waterDepth', 16, 8, 48],
      ['caves.limits.bandSpan', 16, 1, 32],
      // Task 9: the island cap's top (344, above the world, has no effect while bandSpan ≤ 16; 180 in floating_islands' overlay).
      ['caves.limits.capTop', 344, 180, 344],
    ]);
    // The band ends, the water depth, the band span and the cap top are ints (y, blocks).
    for (const l of leaves.filter((x) => /\.(minY|maxY|waterDepth|bandSpan|capTop)$/.test(x.path))) expect([l.path, l.leaf.kind]).toEqual([l.path, 'int']);
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
    expect(['root.a.a.b.a', 'root.a.a.b.a.a', 'root.a.a.b.a.a.a', 'root.a.a.b.a.a.a.a'].map((p) => (at(DEFAULT_DENSITY_TREE, p) as Rec)['op'])).toEqual(['max', 'min', 'min', 'min']);
    // The wet roof's steep part S_w (Task 9, Spec correction 14): added at voxel level to the caves slot and the noodle.
    expect(at(DEFAULT_DENSITY_TREE, 'root.a.a.b')).toMatchObject({ op: 'add', b: { op: 'ref', name: 'wetSteep' } });
    expect(at(DEFAULT_DENSITY_TREE, 'root.a.b')).toMatchObject({ op: 'add', b: { op: 'ref', name: 'wetSteep' } });
    // The spaghetti slots are interpolated under the tap; the noodle is combined at voxel level from four slots.
    for (const name of ['spag3d', 'spag2d'] as const) expect(at(DEFAULT_DENSITY_TREE, `${P[name]}.x`)).toMatchObject({ op: 'interpolated' });
    expect(at(DEFAULT_DENSITY_TREE, `${P.noodle}.x`)).toMatchObject({ op: 'add', a: { op: 'max', b: { op: 'const', v: -48 } } });
    expect(tapCounts(at(DEFAULT_DENSITY_TREE, P.noodle)).size).toBe(1);
    const noodleSlots: unknown[] = [];
    const walk = (x: unknown): void => {
      if (!isRec(x)) return;
      if (x['op'] === 'interpolated') { if (!isBodyRead(x)) noodleSlots.push(x['x']); return; }
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
    const ramp = at(expr, `${P.cheese}.x.x.outside.a.b`) as Expr;
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

describe('the family floor F = 48 (SP6a spec §1.4)', () => {
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
      if (x['op'] === 'interpolated' && !isBodyRead(x)) {
        const id = JSON.stringify(x['x']).match(/"id":"(noodle\w+)"/)![1]!;
        slots.set(id, 1);
        const v = id === 'noodleToggle' ? nn : id === 'noodleThickness' ? kn : id === 'noodleRidgeA' ? an : bn;
        return { op: 'const', v };
      }
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]));
    };
    const root = sub(tapNode.x) as Expr;
    expect([...slots.keys()].sort()).toEqual([...NOODLE_NOISES].sort());
    // The noodle's cap reads `interpolated(ref body)` (the wet roof's d; column (0, 0) is dry, so g_w is 0).
    return createDensityReference({ root, defs: dc.expr.defs }, dc.noises).voxel(dc.column(0, 0), 0, 0, 0);
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
    const walk = (x: unknown): void => { if (isRec(x)) { if (x['op'] === 'interpolated') { if (!isBodyRead(x)) slots.push(x['x'] as Expr); } else Object.values(x).forEach(walk); } };
    walk(at(dc.expr, P.noodle));
    for (const e of slots) constants.push(ref.corner(s, e, 0, 48, 0));
    expect(constants).toEqual([0, 1, 1, -1]);
    expect(noodleAt(-1, 0, 1, 1)).toBe(16 * (-0.075 + 1.5 + 4));
  });
});

/** wet′ = clamp(4·wetMask, 0, 1) (SP6a §1.4, ruling R8). */
const WET = { op: 'clamp', lo: 0, hi: 1, x: { op: 'mul', a: { op: 'const', v: 4 }, b: { op: 'col', field: 'wetMask' } } } as const;
/** The depth d of the wet roof (SP6a §1.4): `ref body` at a slot's corner, `interpolated(ref body)` at the noodle's voxel. */
const D_SLOT = { op: 'ref', name: 'body' } as const;
const D_NOODLE = { op: 'interpolated', x: D_SLOT } as const;
/**
 * cap_f of SP6a §1.4 as data, written from the spec: G·min(1, g + g_w + g_i) + 128·min(1, h + h_i) over the family's
 * band leaves, `bandSpan`, the wet roof's gentle part g_w = wet′·clamp((waterDepth + 8 + s − d)·(1/s), 0, 1) (its
 * steep part is S_w, at voxel level) and `capTop` (the island cap, D8).
 */
function capExpr(group: string, gentle: number, d: unknown): unknown {
  const p = (path: string) => ({ op: 'param', path });
  const y = { op: 'y' };
  const neg = (x: unknown) => ({ op: 'neg', x });
  const add = (a: unknown, b: unknown) => ({ op: 'add', a, b });
  const mul = (a: unknown, b: unknown) => ({ op: 'mul', a, b });
  const clamp01 = (x: unknown) => ({ op: 'clamp', x, lo: 0, hi: 1 });
  const minY = p(`caves.${group}.minY`), maxY = p(`caves.${group}.maxY`), s = p('caves.limits.bandSpan');
  const g = add(clamp01(mul(add(minY, neg(y)), { op: 'recip', x: s })), clamp01(mul(add(y, neg(maxY)), { op: 'recip', x: s })));
  const h = add(clamp01(mul(add(add(minY, neg(s)), neg(y)), { op: 'const', v: 0.125 })), clamp01(mul(add(add(y, neg(maxY)), neg(s)), { op: 'const', v: 0.125 })));
  const gw = mul(WET, clamp01(mul(add(add(add(p('caves.limits.waterDepth'), { op: 'const', v: 8 }), s), neg(d)), { op: 'recip', x: s })));
  const top = p('caves.limits.capTop');
  const gi = clamp01(mul(add(add(add(y, neg(top)), { op: 'const', v: 8 }), s), { op: 'recip', x: s }));
  const hi = clamp01(mul(add(add(y, neg(top)), { op: 'const', v: 8 }), { op: 'const', v: 0.125 }));
  return add(mul({ op: 'const', v: gentle }, { op: 'min', a: { op: 'const', v: 1 }, b: add(add(g, gw), gi) }), mul({ op: 'const', v: 128 }, { op: 'min', a: { op: 'const', v: 1 }, b: add(h, hi) }));
}
/**
 * The cap of §1.4 in numbers: G·min(1, g + g_w + g_i) + 128·min(1, h + h_i) at y (capTop 344 by default: no island cap;
 * g_w from wet′ and d at the voxel, the defaults' waterDepth 16).
 */
function capAt(gentle: number, minY: number, maxY: number, s: number, y: number, capTop = 344, wet = 0, d = 0): number {
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  const g = c01((minY - y) / s) + c01((y - maxY) / s) + wet * c01((16 + 8 + s - d) / s) + c01((y - capTop + 8 + s) / s);
  const h = c01((minY - s - y) / 8) + c01((y - maxY - s) / 8) + c01((y - capTop + 8) / 8);
  return gentle * Math.min(1, g) + 128 * Math.min(1, h);
}
/** The steep fraction h_f of §1.4 at y. */
function steepAt(minY: number, maxY: number, s: number, y: number): number {
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  return c01((minY - s - y) / 8) + c01((y - maxY - s) / 8);
}
type CapFamily = keyof typeof BANDS;
const CAPPED: readonly CapFamily[] = ['entrances', 'cheese', 'spag3d', 'spag2d', 'noodle'];
const bandPatch = (name: CapFamily, minY: number, maxY: number, extra: ParamsPatch = {}): ParamsPatch =>
  ({ ...extra, caves: { ...extra.caves, [BANDS[name][0]]: { ...(extra.caves as Record<string, object> | undefined)?.[BANDS[name][0]], minY, maxY } } }) as ParamsPatch;

describe('the depth bands and their caps (SP6a spec §1.4)', () => {
  test('each family\'s cap is G_f·min(1, g_f + g_w + g_i) + 128·min(1, h_f + h_i) over its minY, maxY, bandSpan, waterDepth and capTop, after the floor (and the ramp)', () => {
    for (const name of CAPPED) {
      const [group, gentle] = BANDS[name];
      expect([name, at(DEFAULT_DENSITY_TREE, CAP[name])]).toEqual([name, capExpr(group, gentle, name === 'noodle' ? D_NOODLE : D_SLOT)]);
    }
    // Entrances: interpolated(fl(…) + cap); the deep families: interpolated(sky(fl(…) + ramp + cap)); the noodle: fl(…) + cap.
    expect(at(DEFAULT_DENSITY_TREE, `${P.entrances}.x.x.a`)).toMatchObject({ op: 'max', b: { op: 'const', v: -48 } });
    for (const name of ['cheese', 'spag3d', 'spag2d'] as const) {
      expect(at(DEFAULT_DENSITY_TREE, `${P[name]}.x.x.outside.a.a`)).toMatchObject({ op: 'max', b: { op: 'const', v: -48 } });
      expect(at(DEFAULT_DENSITY_TREE, `${P[name]}.x.x.outside.a.b`)).toMatchObject({ op: 'clamp', lo: 0, hi: 32 });
    }
    expect(at(DEFAULT_DENSITY_TREE, `${P.noodle}.x.a`)).toMatchObject({ op: 'max', b: { op: 'const', v: -48 } });
  });

  test('the cap evaluates to §1.4\'s formula at every y, for the defaults, a narrow span, an inverted band and the island cap, on a dry and a sea column', () => {
    const cases: Array<[ParamsPatch, number, number]> = [
      [{}, 16, 344], [{ caves: { limits: { bandSpan: 1 } } }, 1, 344], [{ caves: { limits: { bandSpan: 32 } } }, 32, 344],
      [{ caves: { limits: { capTop: 180 } } }, 16, 180], [{ caves: { limits: { capTop: 207, bandSpan: 5 } } }, 5, 207],
    ];
    for (const [patch, s, top] of cases) {
      for (const name of CAPPED) {
        const [group, gentle] = BANDS[name];
        for (const [minY, maxY] of [[DEFAULTS.caves[group].minY, DEFAULTS.caves[group].maxY], [0, 100], [40, 20]] as const) {
          const full = bandPatch(name, minY, maxY, patch);
          const params = paramsWith(full);
          const e = resolveDensity(params.density.defs, params);
          const dc = createDensityContext(ctxFor('42', full), e);
          const capNode = at(e, CAP[name]) as Expr;
          const ref = createDensityReference(dc.expr, dc.noises);
          for (const [cx, cz] of [[0, 0], WET_COLUMNS.sea] as const) {
            const sample = dc.column(cx, cz);
            const x = 16 * cx + 5, z = 16 * cz + 9;
            const wet = ref.voxel(sample, x, 0, z, WET as Expr);
            expect([cx, cz, wet]).toEqual([cx, cz, cx === 0 ? 0 : 1]);
            for (let y = -64; y < 320; y++) {
              const d = ref.voxel(sample, x, y, z, (name === 'noodle' ? D_NOODLE : D_SLOT) as Expr);
              const got = ref.voxel(sample, x, y, z, capNode), want = capAt(gentle, minY, maxY, s, y, top, wet, d);
              if (Math.abs(got - want) > 1e-9) throw new Error(`${name} [${minY}, ${maxY}] s ${s} (${cx}, ${cz}) y ${y}: cap ${got}, §1.4 ${want}`);
            }
          }
        }
      }
    }
  });

  test('wherever a corner\'s h ≥ 1/2 the slot is > 0 over the leaves\' static ranges (bounds.ts: ≥ −48 + 64; the noodle per voxel)', () => {
    let decided = 0;
    for (const s of [1, 16, 32]) {
      for (const [minY, maxY] of [[100, 140], [-40, 0]] as const) {
        for (const name of CAPPED) {
          const full = bandPatch(name, minY, maxY, { ...WORST, caves: { ...WORST.caves, limits: { ...WORST.caves!.limits, bandSpan: s } } });
          const params = paramsWith(full);
          const dc = createDensityContext(ctxFor('42', full), resolveDensity(params.density.defs, params));
          const c = dc.compiled;
          const tapId = c.nodes.findIndex((n) => n.op === 'tap' && (n.expr as TapExpr).name === name);
          // The slot's child (its corner values) for the four interpolated families; the noodle's tap (voxel level).
          const node = name === 'noodle' ? tapId : c.nodes[c.nodes[tapId]!.kids[0]!]!.kids[0]!;
          const iv = new Float64Array(2);
          for (const [cx, cz] of [[0, 0], CAVE_COLUMN, TUNNEL_COLUMN] as const) {
            dc.column(cx, cz);
            dc.bounds.beginColumn();
            for (let ck = 0; ck < 48; ck++) {
              dc.bounds.cellInterval(2, ck, 1, iv, 0);
              const y0 = -64 + 8 * ck, y1 = y0 + (name === 'noodle' ? 7 : 8);
              if (!(Math.min(steepAt(minY, maxY, s, y0), steepAt(minY, maxY, s, y1)) >= 0.5)) continue;
              const lo = dc.bounds.nodeIntervals[2 * node]!;
              if (!(lo >= 16 * (1 - 1e-9))) throw new Error(`${name} s ${s} [${minY}, ${maxY}] cell ${ck} of (${cx}, ${cz}): lower bound ${lo}`);
              decided++;
            }
          }
        }
      }
    }
    expect(decided).toBeGreaterThan(0);
  });

  test('with minY > maxY a family narrows across the inverted range, and is open nowhere once it is 2·bandSpan + 8 wide', () => {
    const s = DEFAULTS.caves.limits.bandSpan;
    for (const name of CAPPED) {
      const [group, gentle] = BANDS[name];
      const open = createDensityContext(ctxFor('42', bandPatch(name, -64, 320)));
      const refOpen = createDensityReference(open.expr, open.noises);
      // Narrow inversion (minY 40, maxY 20): every value in 20 … 40 is raised by at least G·min(1, 20 / s), the voxel of
      // the noodle and each corner of a slot (where `sky` leaves it: 8 or more above the surface both are 32).
      const narrow = createDensityContext(ctxFor('42', bandPatch(name, 40, 20)));
      const refNarrow = createDensityReference(narrow.expr, narrow.noises);
      const rise = gentle * Math.min(1, 20 / s);
      const body = narrow.expr.defs['body']!;
      let n = 0;
      for (const [cx, cz] of COLUMNS) {
        const sample = narrow.column(cx, cz);
        if (name === 'noodle') {
          const t = at(narrow.expr, P.noodle) as Expr, to = at(open.expr, P.noodle) as Expr;
          for (let y = 20; y <= 40; y++) {
            // Under water within 40 blocks of the bed the wet roof's g_w shares the gentle part's min(1, …) (§1.4).
            const wx = 16 * cx + 3, wz = 16 * cz + 5;
            if (refNarrow.voxel(sample, wx, y, wz, WET as Expr) > 0 && refNarrow.voxel(sample, wx, y, wz, D_NOODLE as Expr) < 40) continue;
            const d = refNarrow.voxel(sample, 16 * cx + 3, y, 16 * cz + 5, t) - refOpen.voxel(sample, 16 * cx + 3, y, 16 * cz + 5, to);
            expect(d).toBeGreaterThanOrEqual(rise - 1e-9);
            n++;
          }
        } else {
          const slot = at(narrow.expr, `${P[name]}.x.x`) as Expr, slotOpen = at(open.expr, `${P[name]}.x.x`) as Expr;
          for (let k = 11; k <= 13; k++) {
            for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
              if (name !== 'entrances' && refNarrow.corner(sample, body, i, k, j) < -8) continue;
              // Under water within 40 blocks of the bed the wet roof's g_w shares the gentle part's min(1, …) (§1.4).
              if (refNarrow.corner(sample, WET as Expr, i, k, j) > 0 && refNarrow.corner(sample, body, i, k, j) < 40) continue;
              const d = refNarrow.corner(sample, slot, i, k, j) - refOpen.corner(sample, slotOpen, i, k, j);
              expect(d).toBeGreaterThanOrEqual(rise - 1e-9);
              n++;
            }
          }
        }
      }
      expect([name, n > 0]).toEqual([name, true]);
      // Wide inversion (minY 2·s + 8 = 40 above maxY 0): every y lies s + 4 or more inside one of the two caps (h ≥ 1/2,
      // y ≤ minY − s − 4 = 20 or y ≥ maxY + s + 4 = 20), so the tap is > 0 at every voxel.
      const wide = createDensityContext(ctxFor('42', bandPatch(name, 2 * s + 8, 0)));
      for (const [cx, cz] of COLUMNS) {
        wide.column(cx, cz);
        for (const [lx, lz] of [[0, 0], [5, 11], [15, 15]] as const) {
          for (let y = -64; y < 320; y++) {
            const v = wide.compiled.tapFn(name, lx, y, lz);
            if (!(v > 0)) throw new Error(`${name} open at (${cx}, ${cz}) ${lx} ${y} ${lz}: ${v}`);
          }
        }
      }
    }
  });

  test('nb reads the noodle\'s band leaves; its bound 40 = bandSpan\'s static maximum 32 + 8 stays a literal', () => {
    const slots: Rec[] = [];
    const walk = (x: unknown): void => { if (isRec(x)) { if (x['op'] === 'interpolated') { if (!isBodyRead(x)) slots.push(x['x'] as Rec); } else Object.values(x).forEach(walk); } };
    walk(at(DEFAULT_DENSITY_TREE, P.noodle));
    expect(slots.length).toBe(4);
    for (const nb of slots) {
      expect(nb).toMatchObject({
        op: 'rangeChoice', lo: -1e9, hi: 40,
        x: { op: 'add', a: { op: 'y' }, b: { op: 'neg', x: { op: 'param', path: 'caves.noodles.maxY' } } },
        inside: { op: 'rangeChoice', lo: -1e9, hi: 40, x: { op: 'add', a: { op: 'param', path: 'caves.noodles.minY' }, b: { op: 'neg', x: { op: 'y' } } } },
      });
    }
    expect(SCHEMA.leaves.find((l) => l.path === 'caves.limits.bandSpan')!.leaf.max).toBe(32);
  });
});

/** g_i and h_i in a cap node (`add(mul(G, min(1, add(g_f, g_i))), mul(128, min(1, add(h_f, h_i))))`). */
const islandTerms = (capNode: Expr): readonly [Expr, Expr] => {
  const c = capNode as unknown as { a: { b: { b: { b: Expr } } }; b: { b: { b: { b: Expr } } } };
  return [c.a.b.b.b, c.b.b.b.b];
};

describe('the island cap (SP6a spec §1.4, D8)', () => {
  test('at capTop 344 (the default) g_i and h_i are 0 at every y ≤ 320 of every cap, so they move no default output', () => {
    expect(DEFAULTS.caves.limits.capTop).toBe(344);
    const dc = createDensityContext(CTX);
    const ref = createDensityReference(dc.expr, dc.noises);
    const sample = dc.column(0, 0);
    for (const name of CAPPED) {
      const [gi, hi] = islandTerms(at(dc.expr, CAP[name]) as Expr);
      expect(gi).toMatchObject({ op: 'clamp', lo: 0, hi: 1 });
      expect(hi).toMatchObject({ op: 'clamp', lo: 0, hi: 1 });
      // Every voxel (y −64 … 319) and every corner (y −64 … 320, k 0 … 48).
      for (let y = -64; y < 320; y++) {
        const g = ref.voxel(sample, 0, y, 0, gi), h = ref.voxel(sample, 0, y, 0, hi);
        if (!Object.is(g, 0) || !Object.is(h, 0)) throw new Error(`${name} y ${y}: g_i ${g}, h_i ${h}`);
      }
      for (let k = 0; k <= 48; k++) {
        const g = ref.corner(sample, gi, 2, k, 3), h = ref.corner(sample, hi, 2, k, 3);
        if (!Object.is(g, 0) || !Object.is(h, 0)) throw new Error(`${name} corner k ${k}: g_i ${g}, h_i ${h}`);
      }
    }
  });

  test('at capTop 180 every corner at y ≥ 176 of every family is > 0 over the leaves\' static ranges (bounds.ts: ≥ −48 + 64; the noodle per voxel)', () => {
    let decided = 0;
    for (const s of [1, 16, 32]) {
      const full: ParamsPatch = { ...WORST, caves: { ...WORST.caves, limits: { ...WORST.caves!.limits, bandSpan: s, capTop: 180 } } };
      const params = paramsWith(full);
      const dc = createDensityContext(ctxFor('42', full), resolveDensity(params.density.defs, params));
      const c = dc.compiled;
      for (const name of CAPPED) {
        const tapId = c.nodes.findIndex((n) => n.op === 'tap' && (n.expr as TapExpr).name === name);
        const node = name === 'noodle' ? tapId : c.nodes[c.nodes[tapId]!.kids[0]!]!.kids[0]!;
        const iv = new Float64Array(2);
        for (const [cx, cz] of [[0, 0], CAVE_COLUMN, TUNNEL_COLUMN] as const) {
          dc.column(cx, cz);
          dc.bounds.beginColumn();
          // Cell ck spans y −64 + 8·ck … + 8: from ck 30 (y 176) up, both ends lie at y ≥ 176, where h_i ≥ 1/2.
          for (let ck = 30; ck < 48; ck++) {
            dc.bounds.cellInterval(2, ck, 1, iv, 0);
            const lo = dc.bounds.nodeIntervals[2 * node]!;
            if (!(lo >= 16 * (1 - 1e-9))) throw new Error(`${name} s ${s} cell ${ck} of (${cx}, ${cz}): lower bound ${lo}`);
            decided++;
          }
        }
      }
    }
    expect(decided).toBe(3 * 5 * 3 * 18);
  });

  test('on floating_islands (capTop 180) every corner of each slot and every noodle voxel at y ≥ 176 is > 0, and the caps rise from y 156', () => {
    const fl = resolveProfile('floating_islands');
    expect(fl.caves.limits.capTop).toBe(180);
    const dc = createDensityContext(createGenContext(seedFromInput('42'), fl));
    const ref = createDensityReference(dc.expr, dc.noises);
    for (const [cx, cz] of COLUMNS) {
      const sample = dc.column(cx, cz);
      for (const name of CAPPED) {
        if (name === 'noodle') {
          for (let y = 176; y < 320; y++) {
            const v = dc.compiled.tapFn('noodle', 5, y, 9);
            if (!(v > 0)) throw new Error(`noodle (${cx}, ${cz}) y ${y}: ${v}`);
          }
          continue;
        }
        const slot = at(dc.expr, `${P[name]}.x.x`) as Expr;
        for (let k = 30; k <= 48; k++) {
          for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
            const v = ref.corner(sample, slot, i, k, j);
            if (!(v > 0)) throw new Error(`${name} (${cx}, ${cz}) corner (${i}, y ${-64 + 8 * k}, ${j}): ${v}`);
          }
        }
      }
    }
    // The caps rise from y 156 = capTop − 8 − bandSpan (the families whose band holds y 156 … 172 at the defaults).
    const sample = dc.column(0, 0);
    for (const name of ['entrances', 'cheese', 'spag3d', 'spag2d'] as const) {
      const capNode = at(dc.expr, CAP[name]) as Expr;
      const v = (y: number) => ref.voxel(sample, 0, y, 0, capNode);
      expect([name, v(156), v(157) > 0, v(172), v(176)]).toEqual([name, 0, true, BANDS[name][1], BANDS[name][1] + 64]);
    }
  });
});

/** wet′ = 1 positions' family values with and without the wet roof (SP6a §1.4, D7, Spec correction 14, ruling P7). */
describe('the wet roof (SP6a spec §1.4, D7)', () => {
  const WET_STREAM = 'sp6a.caveTerms.wet';
  type WetKind = keyof typeof WET_COLUMNS;

  test('the lake, river and sea columns of seed 42 are the scan\'s first', () => {
    const ctx = ctxFor('42');
    const s = newColumnSample();
    const pts = samplePoints(WET_STREAM, 4096);
    const found: Partial<Record<WetKind, readonly [number, number]>> = {};
    for (let n = 0; n < 4096 && Object.keys(found).length < 3; n++) {
      const cx = Math.floor(pts.x[n]! / 16), cz = Math.floor(pts.z[n]! / 16);
      buildColumnSample(ctx, cx, cz, s);
      let lake = 0, river = 0, sea = 0;
      for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
        const k = latticeIndex(i, j);
        if (s.f.lakeMask[k] === 1) lake++;
        else if (riverWetAt(s, k) && s.f.offset[k]! >= 63) river++;
        else if (s.f.offset[k]! < 63) sea++;
      }
      if (lake === 25) found.lake ??= [cx, cz];
      if (sea === 25) found.sea ??= [cx, cz];
      if (river >= 9 && lake === 0) found.river ??= [cx, cz];
    }
    expect(found).toEqual(WET_COLUMNS);
  });

  /** The no-roof tree: `dc.expr` with every wet′ node (the cap's g_w factor and S_w's) replaced by the constant 0. */
  function noRoof(expr: DensityExpr): DensityExpr {
    const wetJson = JSON.stringify(at(expr, 'defs.wetSteep.b.a'));
    expect(JSON.parse(wetJson)).toEqual(WET);
    let replaced = 0;
    const sub = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(sub);
      if (!isRec(x)) return x;
      if (JSON.stringify(x) === wetJson) { replaced++; return { op: 'const', v: 0 }; }
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]));
    };
    const out = sub(expr) as DensityExpr;
    // One per family cap (four slots and the noodle) and S_w.
    expect(replaced).toBe(6);
    return out;
  }

  /**
   * Under a lake, a river and a sea column, at the positions whose wet′ is 1 (a 4 × 4 grid of each column), from the bed
   * (the column's pre-cave top) down 64 blocks, with d = `ref body` (§1.4) at the 8 corners of the voxel's cell:
   * - closed where every corner has d ≤ waterDepth + 4 = 20 (then interpolated d ≤ 20, h_w ≥ 1/2 and S_w ≥ 64): every
   *   carving family's value with the wet roof (its tap plus S_w) is > 0;
   * - unaffected where every corner has d ≥ waterDepth + 8 + bandSpan = 40: every family's tap, S_w (0) and the root
   *   equal the no-roof tree's.
   * At the defaults and with the entrances and cheese opened (offsets −0.5 and 1), where the no-roof tree holds air in
   * the closed zone, so the check is not vacuous.
   */
  test('closed (> 0) where every cell corner has d ≤ 20, unaffected where every corner has d ≥ 40, under a lake, a river and a sea', () => {
    const dw = DEFAULTS.caves.limits.waterDepth, span = DEFAULTS.caves.limits.bandSpan;
    expect([dw + 4, dw + 8 + span]).toEqual([20, 40]);
    const families = ['entrances', 'cheese', 'spag3d', 'spag2d', 'noodle'] as const;
    const GRID = [1, 6, 10, 14] as const;
    const lines: string[] = [];
    let openedWithoutRoof = 0;
    for (const [label, patch] of [['defaults', {}], ['opened', { caves: { entrances: { offset: -0.5 }, cheese: { offset: 1 } } }]] as const) {
      const ctx = ctxFor('42', patch as ParamsPatch);
      const dc = createDensityContext(ctx);
      const dn = createDensityContext(ctx, noRoof(dc.expr));
      const ref = createDensityReference(dc.expr, dc.noises);
      const body = dc.expr.defs['body']!;
      const wetSteep = dc.expr.defs['wetSteep']!;
      for (const kind of ['lake', 'river', 'sea'] as const) {
        const [cx, cz] = WET_COLUMNS[kind];
        const sample = dc.column(cx, cz);
        dn.column(cx, cz);
        const dAt = new Map<number, number>();
        const corner = (i: number, k: number, j: number): number => {
          const key = (k * 5 + j) * 5 + i;
          let v = dAt.get(key);
          if (v === undefined) { v = ref.corner(sample, body, i, k, j); dAt.set(key, v); }
          return v;
        };
        let wetPositions = 0, closed = 0, unaffected = 0, opened = 0;
        let closedDeepest = -Infinity, unaffectedShallowest = Infinity;
        for (const lz of GRID) for (const lx of GRID) {
          const x = 16 * cx + lx, z = 16 * cz + lz;
          if (!Object.is(ref.voxel(sample, x, 0, z, WET as Expr), 1)) continue;
          wetPositions++;
          let bed = 319;
          while (bed > -64 && !(dc.compiled.tapFn('precave', lx, bed, lz) > 0)) bed--;
          for (let y = bed; y >= Math.max(-63, bed - 64); y--) {
            const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
            let lo = Infinity, hi = -Infinity;
            for (let c = 0; c < 8; c++) {
              const v = corner(ci + (c & 1), ck + (c >> 2), cj + ((c >> 1) & 1));
              lo = Math.min(lo, v); hi = Math.max(hi, v);
            }
            if (hi <= dw + 4) {
              const sw = ref.voxel(sample, x, y, z, wetSteep);
              if (!(sw >= 64)) throw new Error(`${label} ${kind} (${x}, ${y}, ${z}): S_w ${sw} with every corner d ≤ 20`);
              for (const f of families) {
                const v = dc.compiled.tapFn(f, lx, y, lz) + sw;
                if (!(v > 0)) throw new Error(`${label} ${kind} ${f} (${x}, ${y}, ${z}): ${v} with the wet roof, every corner d ≤ 20`);
                if (!(dn.compiled.tapFn(f, lx, y, lz) > 0)) opened++;
              }
              if (!(dc.compiled.voxelFn(lx, y, lz) === dc.compiled.tapFn('precave', lx, y, lz) || dc.compiled.voxelFn(lx, y, lz) > 0)) {
                throw new Error(`${label} ${kind} root (${x}, ${y}, ${z}) carved inside the wet roof`);
              }
              closed++;
              closedDeepest = Math.max(closedDeepest, bed - y);
            } else if (lo >= dw + 8 + span) {
              if (!Object.is(ref.voxel(sample, x, y, z, wetSteep), 0)) throw new Error(`${label} ${kind} (${x}, ${y}, ${z}): S_w ≠ 0 with every corner d ≥ 40`);
              for (const f of [...families, 'pillars'] as const) {
                const a = dc.compiled.tapFn(f, lx, y, lz), b = dn.compiled.tapFn(f, lx, y, lz);
                if (a !== b) throw new Error(`${label} ${kind} ${f} (${x}, ${y}, ${z}): ${a} with the roof, ${b} without`);
              }
              const a = dc.compiled.voxelFn(lx, y, lz), b = dn.compiled.voxelFn(lx, y, lz);
              if (a !== b) throw new Error(`${label} ${kind} root (${x}, ${y}, ${z}): ${a} with the roof, ${b} without`);
              unaffected++;
              unaffectedShallowest = Math.min(unaffectedShallowest, bed - y);
            }
          }
        }
        expect([label, kind, wetPositions > 0, closed > 0, unaffected > 0]).toEqual([label, kind, true, true, true]);
        openedWithoutRoof += label === 'opened' ? opened : 0;
        lines.push(`${label} ${kind} (${cx}, ${cz}): ${wetPositions} wet positions; closed ${closed} voxels down to ${closedDeepest} below the bed `
          + `(${opened} family values ≤ 0 there without the roof); unaffected ${unaffected} voxels from ${unaffectedShallowest} below the bed`);
      }
    }
    console.log(`the wet roof (bed-relative block depths):\n${lines.join('\n')}`);
    expect(openedWithoutRoof).toBeGreaterThan(0);
  }, 120_000);
});

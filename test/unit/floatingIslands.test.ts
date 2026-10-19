/**
 * floating_islands' islands term on real columns (SP3e spec §3.1-§3.5, D3, D4, D5), seed 42, the mask on:
 * - §3.2's arguments: the ungated BODY = 20·(NI − 0.9 − 3·q + 4·(m − 1)) is ≤ 0 at every corner outside 200 … 256 (so
 *   the window [192, 265) cuts nothing) and at every corner whose m < 0.25 (so the cluster gate cuts nothing);
 * - every island voxel (solid with the tree, air with the islands tap muted) lies in y 193-263, above
 *   `ISLAND_RUN_MIN_BOTTOM`;
 * - compiled == reference and probe == bulk on island columns (m = 1, and 0.25 < m < 1), voxels and corners of the band;
 * - water v0 under islands over the sea (D5 on real data): the column's fluid equals the muted column's, and the
 *   heightmaps equal a top-down scan (the island top + 1 at island positions).
 * The columns are `terrain.real` bench candidates (tc ≤ 216) found by scans; the tests re-derive what they rely on.
 */
import { describe, expect, test } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import type { JsonValue } from '../../src/core/params/json';
import { FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import type { Expr } from '../../src/gen/density/expr';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { terrainDensityDebug } from '../../src/gen/pipeline/terrainStage';
import { fillColumnT } from '../../src/metrics/region';
import { AIR } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { paramsWith } from '../harness/gen';
import { topDownHeightmaps } from '../harness/heightmaps';

type Col = readonly [cx: number, cz: number];
/** m = 1 at all 49 lattice points, offset0 < 63 at the centre: an island over the sea (tc 82). */
const SEA_CORE: Col = [19358, -22222];
/** 0.25 < m < 1 at all 49 lattice points, offset0 < 63 at the centre: a cluster edge over the sea (tc 148). */
const SEA_EDGE: Col = [2012, -10108];
/** 0.25 < m < 1, land: a large island (tc 216). */
const LAND_EDGE: Col = [504, -28536];
/** Lattices that straddle the cluster gate (min m < 0.25 ≤ max m; tc 65, 70, 206). */
const GATE: readonly Col[] = [[4735, -2615], [-15670, -18970], [-18686, 4174]];
const ISLAND_COLUMNS: readonly Col[] = [SEA_CORE, SEA_EDGE, LAND_EDGE];

const FLOATING = resolveProfile('floating_islands');
const ctx: GenContext = createGenContext(seedFromInput('42'), FLOATING);
/** The same world with the islands tap muted (−1e6 under `max`: the default ground, the mask and the flag still on). */
const mutedTree = (): JsonValue => {
  const t = JSON.parse(JSON.stringify(FLOATING_DENSITY_TREE)) as { root: { b: Record<string, unknown> } };
  t.root.b['mute'] = -1000000;
  return t as unknown as JsonValue;
};
const muted: GenContext = createGenContext(seedFromInput('42'), paramsWith({ islands: { enabled: true }, density: { defs: mutedTree() } }));

const dc = createDensityContext(ctx);
const ref = createDensityReference(dc.expr, dc.noises);
/** The resolved tree's nodes of §3.1: interpolated(rangeChoice(m, rangeChoice(y, BODY, −1e6), −1e6)). */
const term = (dc.expr.root as unknown as { b: { x: { x: { x: Expr; inside: { inside: Expr } } } } }).b.x.x;
const M_NODE = term.x;
const BODY = term.inside.inside;

const newStore = (): VoxelStore => createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
const generate = (c: GenContext, store: VoxelStore, [cx, cz]: Col): ColumnView => {
  expect(fillColumnT(store, c, cx, cz, () => false)).toBe(true);
  return store.proto(cx, cz)!;
};
const centre = (c: GenContext, [cx, cz]: Col) => {
  const p = samplePoint(c, 16 * cx + 8, 16 * cz + 8, false, newPointRecord());
  return { m: p.islandMask, offset0: p.offset0 };
};
/** islandMask at the 5 × 5 corner columns of a column, as the tree reads it (`col islandMask` inside `interpolated`). */
const cornerMasks = ([cx, cz]: Col): number[] => {
  const s = dc.column(cx, cz);
  const out: number[] = [];
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) out.push(ref.corner(s, M_NODE, i, 0, j));
  return out;
};

describe('the fixtures (SP3e spec §3.1, seed 42)', () => {
  test('the island columns hold island voxels; the sea ones lie over the sea; the gate columns straddle m = 0.25', () => {
    const sea = centre(ctx, SEA_CORE), edge = centre(ctx, SEA_EDGE), land = centre(ctx, LAND_EDGE);
    expect(cornerMasks(SEA_CORE).every((m) => m === 1)).toBe(true);
    expect(sea.offset0).toBeLessThan(63);
    for (const c of [SEA_EDGE, LAND_EDGE]) expect(cornerMasks(c).every((m) => m > 0.25 && m < 1), `${c}`).toBe(true);
    expect(edge.offset0).toBeLessThan(63);
    expect(land.offset0).toBeGreaterThanOrEqual(63);
    for (const c of GATE) {
      const m = cornerMasks(c);
      expect(Math.min(...m) < 0.25 && Math.max(...m) >= 0.25, `${c}`).toBe(true);
    }
  });
});

describe('§3.2: the window and the cluster gate cut nothing (the ungated BODY at every corner)', () => {
  test('BODY ≤ 0 at every corner y ≤ 192 or ≥ 264, and at every corner with m < 0.25; positive corners exist inside', () => {
    let positive = 0, lowMask = 0, outside = 0;
    let maxInside = -Infinity;
    for (const c of [...ISLAND_COLUMNS, ...GATE]) {
      const s = dc.column(c[0], c[1]);
      for (let k = 0; k <= 48; k++) {
        const y = -64 + 8 * k;
        for (let j = 0; j <= 4; j++) {
          for (let i = 0; i <= 4; i++) {
            const body = ref.corner(s, BODY, i, k, j);
            const m = ref.corner(s, M_NODE, i, k, j);
            expect(Number.isFinite(body), `${c} corner (${i}, ${k}, ${j})`).toBe(true);
            if (y <= 192 || y >= 264) {
              outside++;
              expect(body, `${c} corner (${i}, y ${y}, ${j}) m ${m}`).toBeLessThanOrEqual(0);
            } else if (m >= 0.25) maxInside = Math.max(maxInside, body);
            if (m < 0.25) {
              lowMask++;
              expect(body, `${c} corner (${i}, y ${y}, ${j}) m ${m}`).toBeLessThanOrEqual(0);
            }
            if (body > 0) {
              positive++;
              expect(y >= 200 && y <= 256 && m > 0.475, `${c} corner (${i}, y ${y}, ${j}) m ${m}`).toBe(true);
            }
          }
        }
      }
    }
    expect(outside).toBe(6 * 25 * 41);
    expect(lowMask).toBeGreaterThan(0);
    expect(positive).toBeGreaterThan(0);
    expect(maxInside).toBeGreaterThan(0);
  });
});

describe('island voxels and water v0 under islands (SP3e spec §3.2, §3.5, D5)', () => {
  const store = newStore();
  const mstore = newStore();

  test.each(ISLAND_COLUMNS.map((c) => [`${c[0]}, ${c[1]}`, c] as const))(
    '(%s): island voxels in y 193-263; the fluid equals the muted column\'s; heightmaps = the top-down scan',
    (_name, col) => {
      const v = generate(ctx, store, col);
      const mv = generate(muted, mstore, col);
      const aux = v.aux()!;
      let island = 0, lo = Infinity, hi = -Infinity, islandPositions = 0, wetUnder = 0;
      for (let p = 0; p < 256; p++) {
        const lx = p & 15, lz = p >> 4;
        let top = -65, islandTop = -65;
        for (let y = -64; y <= 319; y++) {
          const solid = v.block(lx, y, lz) !== AIR, mSolid = mv.block(lx, y, lz) !== AIR;
          // max(terrain + detail, islands): the islands term only adds solid voxels.
          if (mSolid) expect(solid, `(${lx}, ${y}, ${lz})`).toBe(true);
          if (solid && !mSolid) { island++; lo = Math.min(lo, y); hi = Math.max(hi, y); islandTop = y; }
          if (solid) top = y;
          expect(v.fluid(lx, y, lz), `fluid (${lx}, ${y}, ${lz})`).toBe(mv.fluid(lx, y, lz));
        }
        const hm = topDownHeightmaps(v, lx, lz);
        expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]], `(${lx}, ${lz})`).toEqual(hm);
        if (islandTop > -65) {
          islandPositions++;
          // The island is the highest solid run, so both heightmaps are its top + 1.
          expect(hm, `(${lx}, ${lz})`).toEqual([top + 1, top + 1]);
          expect(top).toBe(islandTop);
          for (let y = 0; y < ISLAND_RUN_MIN_BOTTOM; y++) if (v.fluid(lx, y, lz) !== 0) { wetUnder++; break; }
        }
      }
      store.freeColumn(col[0], col[1]);
      mstore.freeColumn(col[0], col[1]);
      expect(island).toBeGreaterThan(0);
      expect(lo).toBeGreaterThanOrEqual(193);
      expect(hi).toBeLessThanOrEqual(263);
      expect(lo).toBeGreaterThan(ISLAND_RUN_MIN_BOTTOM);
      // Over the sea, the sea under some island positions holds water (today's rule would leave dry holes).
      if (col !== LAND_EDGE) expect(wetUnder).toBeGreaterThan(0);
      expect(islandPositions).toBeGreaterThan(0);
    },
  );
});

describe('compiled == reference and probe == bulk on island columns (SP3e spec §3.3)', () => {
  const store = newStore();

  test('every voxel of y 184-272 plus 512 uniform voxels, and every corner of the cells ck 31-41, of the m = 1 and 0.25 < m < 1 sea columns', () => {
    const c = dc.compiled;
    const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
    expect(interp).toHaveLength(2);
    const out = new Float64Array(98304);
    const mask = new Uint8Array(98304);
    const r = new Xoshiro128(fnv1a32('floatingIslands.compiled'));
    let voxels = 0, masked = 0, corners = 0, islandVoxels = 0;
    for (const col of [SEA_CORE, SEA_EDGE]) {
      const [cx, cz] = col;
      const view = generate(ctx, store, col);
      terrainDensityDebug(ctx, cx, cz, out, mask);
      const s = dc.column(cx, cz);
      const idx: number[] = [];
      for (let y = 184; y <= 272; y++) for (let p = 0; p < 256; p++) idx.push(((y + 64) << 8) | p);
      for (let n = 0; n < 512; n++) idx.push(256 + r.nextInt(98304 - 256));
      for (const i of idx) {
        const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
        const x = 16 * cx + lx, z = 16 * cz + lz;
        const value = probe(dc, x, y, z);
        const block = view.block(lx, y, lz);
        voxels++;
        expect(value > 0, `(${x}, ${y}, ${z}) probe ${value}, block ${block}`).toBe(block !== AIR);
        if (y >= 193 && y <= 263 && block !== AIR) islandVoxels++;
        if (mask[i] === 1) {
          masked++;
          expect(Object.is(value, out[i]), `(${x}, ${y}, ${z}) probe ${value} ≠ bulk ${out[i]}`).toBe(true);
        }
        const rv = ref.voxel(s, x, y, z);
        expect(Object.is(value, rv), `(${x}, ${y}, ${z}) compiled ${value} ≠ reference ${rv}`).toBe(true);
      }
      for (let ck = 31; ck <= 41; ck++) {
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
    expect(voxels).toBe(2 * (89 * 256 + 512));
    expect(masked).toBeGreaterThan(0);
    expect(corners).toBe(2 * 11 * 16 * 2 * 8);
    expect(islandVoxels).toBeGreaterThan(0);
  });
});

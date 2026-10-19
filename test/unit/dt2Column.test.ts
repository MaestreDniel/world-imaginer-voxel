import { describe, expect, it } from 'vitest';
import { fnv1a32, hash2 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { terrainDensityDebug, terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf } from '../../src/gen/surface/context';
import { surfaceProbe } from '../../src/gen/surface/probe';
import { newSurfaceScan, runAt } from '../../src/gen/surface/scan';
import { fillColumnT } from '../../src/metrics/region';
import { AIR } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { DT2_VOXELS_PER_COLUMN, dt2Column, dt2Setup, newDt2Acc, type Dt2Acc, type Dt2Stratum, type Dt2Voxel } from '../harness/dt2';
import { topDownHeightmaps } from '../harness/heightmaps';

/**
 * `dt2Column` (SP3e spec §5.1 "Extractions", D18): DT2's per-column checks moved out of `region.metric.ts`. The
 * reference below is the inline loop as `region.metric.ts` ran it before the extraction (SP3b/SP3c's DT2 body for one
 * column, its counters only), run on the same column with a stream in the same state.
 */

interface Inline {
  probeBulk: number; compiledReference: number; surfaceProbeBulk: number; surfaceReference: number;
  voxels: number; maskedVoxels: number; corners: number; surfaceVoxels: number; surfaceExtraVoxels: number;
  surfaceExtraSkipped: number; indices: number[];
}

/** The pre-extraction inline DT2 loop for column (cx, cz), with every context built here. */
function inlineDt2(ctx: GenContext, cx: number, cz: number, r: Xoshiro128): Inline {
  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  const out = new Float64Array(98304);
  const mask = new Uint8Array(98304);
  const masked = new Int32Array(98304);
  const scan = newSurfaceScan();
  const dc = createDensityContext(ctx);
  const ref = createDensityReference(dc.expr, dc.noises);
  const c = dc.compiled;
  const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
  const compiled = surfaceContextOf(ctx).compiled;
  const sc = createSurfaceContext(ctx);
  const maxSurfaceDepth = compiled.fastPath!.maxSurfaceDepth;
  const o: Inline = {
    probeBulk: 0, compiledReference: 0, surfaceProbeBulk: 0, surfaceReference: 0, voxels: 0, maskedVoxels: 0,
    corners: 0, surfaceVoxels: 0, surfaceExtraVoxels: 0, surfaceExtraSkipped: 0, indices: [],
  };
  expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
  const view = store.proto(cx, cz)!;
  terrainDensityDebug(ctx, cx, cz, out, mask);
  let m = 0;
  for (let i = 256; i < 98304; i++) if (mask[i] === 1) masked[m++] = i;
  const s = dc.column(cx, cz);
  terrainSurfaceDebug(ctx, cx, cz, scan);
  const checkSurface = (p: number, y: number): boolean => {
    if (runAt(scan, p, y) < 0) return false;
    o.surfaceVoxels++;
    if (compiled.state(scan, p, y) !== sc.reference.state(scan, sc.settings, p, y)) o.surfaceReference++;
    return true;
  };
  for (let v = 0; v < 16; v++) {
    let i: number;
    if (v >= 11) {
      const p = r.nextInt(256);
      const y = Math.min(319, Math.max(-63, view.aux()!.oceanFloorWG[p]! - 1 + r.nextInt(9) - 4));
      i = ((y + 64) << 8) | p;
    } else {
      i = v >= 6 && m > 0 ? masked[r.nextInt(m)]! : 256 + r.nextInt(98304 - 256);
    }
    o.indices.push(i);
    const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
    const x = 16 * cx + lx, z = 16 * cz + lz;
    const value = probe(dc, x, y, z);
    const block = view.block(lx, y, lz);
    o.voxels++;
    if ((value > 0) !== (block !== AIR)) o.probeBulk++;
    if (surfaceProbe(sc, x, y, z).state !== block) o.surfaceProbeBulk++;
    checkSurface(i & 255, y);
    if (mask[i] === 1) {
      o.maskedVoxels++;
      if (!Object.is(value, out[i])) o.probeBulk++;
    }
    if (!Object.is(value, ref.voxel(s, x, y, z))) o.compiledReference++;
    const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
    c.cellCorners(ci, ck, cj);
    for (const { inner, slot } of interp) {
      for (let d = 0; d < 8; d++) {
        const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
        o.corners++;
        if (!Object.is(c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!, ref.corner(s, inner, ii, kk, jj))) o.compiledReference++;
      }
    }
  }
  const rSurface = new Xoshiro128(hash2(fnv1a32('DT2.surface'), cx, cz));
  for (let k = 0; k < 8; k++) {
    const p = rSurface.nextInt(256);
    const d = rSurface.nextInt(maxSurfaceDepth + 1);
    const first = scan.runFirst[p]!;
    if (first < scan.runFirst[p + 1]! && checkSurface(p, scan.runTop[first]! - d)) o.surfaceExtraVoxels++;
    else o.surfaceExtraSkipped++;
  }
  return o;
}

const LABEL = "profile default, seed '42'";
const ctxOf = (): GenContext => createGenContext(seedFromInput('42'), resolveProfile('default'));

/** DT2's stream after its first column draw (the metric's first default column at seed '42'), and that column. */
function firstColumn(): { r: Xoshiro128; cx: number; cz: number } {
  const r = new Xoshiro128(fnv1a32('DT2'));
  const cx = -1024 + r.nextInt(2048);
  const cz = -1024 + r.nextInt(2048);
  return { r, cx, cz };
}

const failures = (a: Dt2Acc) => [a.probeBulk, a.compiledReference, a.surfaceProbeBulk, a.surfaceReference];

describe('dt2Column (SP3e spec §5.1, D18)', () => {
  it('on a default column: no failures, the inline loop\'s populations and voxels, the stream advanced by its draws', () => {
    const ctx = ctxOf();
    const a = firstColumn();
    const b = firstColumn();
    expect([a.cx, a.cz]).toEqual([b.cx, b.cz]);
    const inline = inlineDt2(ctx, a.cx, a.cz, a.r);
    const acc = newDt2Acc(LABEL);
    const indices = dt2Column(ctx, b.cx, b.cz, b.r, acc);
    expect(acc.problems).toEqual([]);
    expect(failures(acc)).toEqual([0, 0, 0, 0]);
    expect(failures(acc)).toEqual([inline.probeBulk, inline.compiledReference, inline.surfaceProbeBulk, inline.surfaceReference]);
    expect({
      voxels: acc.voxels, maskedVoxels: acc.maskedVoxels, corners: acc.corners, columns: acc.columns,
      surfaceVoxels: acc.surfaceVoxels, surfaceExtraVoxels: acc.surfaceExtraVoxels, surfaceExtraSkipped: acc.surfaceExtraSkipped,
    }).toEqual({
      voxels: inline.voxels, maskedVoxels: inline.maskedVoxels, corners: inline.corners, columns: 1,
      surfaceVoxels: inline.surfaceVoxels, surfaceExtraVoxels: inline.surfaceExtraVoxels, surfaceExtraSkipped: inline.surfaceExtraSkipped,
    });
    expect(acc.voxels).toBe(DT2_VOXELS_PER_COLUMN);
    expect(acc.maskedVoxels).toBeGreaterThan(0);
    expect(acc.corners).toBeGreaterThan(0);
    expect(indices).toEqual(inline.indices);
    const next = a.r.nextU32();
    expect(b.r.nextU32()).toBe(next);
    expect(next).toBe(PINNED_NEXT);
  });

  it('accumulates over columns: populations add, columns counts calls', () => {
    const ctx = ctxOf();
    const { r, cx, cz } = firstColumn();
    const acc = newDt2Acc(LABEL);
    dt2Column(ctx, cx, cz, r, acc);
    const once = { ...acc, problems: [...acc.problems] };
    const cx2 = -1024 + r.nextInt(2048);
    const cz2 = -1024 + r.nextInt(2048);
    dt2Column(ctx, cx2, cz2, r, acc);
    expect(acc.columns).toBe(2);
    expect(acc.voxels).toBe(2 * DT2_VOXELS_PER_COLUMN);
    expect(acc.corners).toBeGreaterThan(once.corners);
    expect(failures(acc)).toEqual([0, 0, 0, 0]);
  });

  it('an injected mismatch is counted in its own part: a wrong density reference → compiledReference', () => {
    const ctx = ctxOf();
    const setup = dt2Setup(ctx, LABEL);
    const ref = setup.ref;
    setup.ref = { ...ref, voxel: (s, x, y, z, e) => ref.voxel(s, x, y, z, e) + 1 };
    const { r, cx, cz } = firstColumn();
    const acc = newDt2Acc(LABEL);
    dt2Column(ctx, cx, cz, r, acc);
    expect(acc.compiledReference).toBe(DT2_VOXELS_PER_COLUMN);
    expect([acc.probeBulk, acc.surfaceProbeBulk, acc.surfaceReference]).toEqual([0, 0, 0]);
    expect(acc.problems).toHaveLength(DT2_VOXELS_PER_COLUMN);
    expect(acc.problems[0]).toMatch(new RegExp(`^profile default, seed '42', column \\(${cx}, ${cz}\\): \\(-?\\d+, -?\\d+, -?\\d+\\) compiled .* ≠ reference `));

    setup.ref = { ...ref, corner: (s, e, i, k, j) => ref.corner(s, e, i, k, j) - 1 };
    const acc2 = newDt2Acc(LABEL);
    dt2Column(ctx, cx, cz, new Xoshiro128(7), acc2);
    expect(acc2.corners).toBeGreaterThan(0);
    expect(acc2.compiledReference).toBe(acc2.corners);
    expect([acc2.probeBulk, acc2.surfaceProbeBulk, acc2.surfaceReference]).toEqual([0, 0, 0]);
    expect(acc2.problems[0]).toMatch(/: corner \(\d+, \d+, \d+\) compiled .* ≠ reference /);
  });

  it('an injected mismatch is counted in its own part: a wrong surface reference → surfaceReference', () => {
    const ctx = ctxOf();
    const setup = dt2Setup(ctx, LABEL);
    const sc = setup.sc;
    setup.sc = { ...sc, reference: { ...sc.reference, state: () => 65535 } };
    const { r, cx, cz } = firstColumn();
    const acc = newDt2Acc(LABEL);
    dt2Column(ctx, cx, cz, r, acc);
    expect(acc.surfaceVoxels).toBeGreaterThan(0);
    expect(acc.surfaceReference).toBe(acc.surfaceVoxels);
    expect([acc.probeBulk, acc.compiledReference, acc.surfaceProbeBulk]).toEqual([0, 0, 0]);
    expect(acc.problems.every((t) => t.includes('compiled state') && t.endsWith('≠ reference 65535'))).toBe(true);
  });

  it('dt2Setup is memoised per GenContext and refuses a rule tree without a fast path with the label', () => {
    const ctx = ctxOf();
    expect(dt2Setup(ctx, LABEL)).toBe(dt2Setup(ctx, 'other'));
    expect(dt2Setup(ctx, LABEL).maxSurfaceDepth).toBe(surfaceContextOf(ctx).compiled.fastPath!.maxSurfaceDepth);
    const ctx2 = ctxOf();
    const sc = surfaceContextOf(ctx2);
    Object.defineProperty(sc, 'compiled', { value: { ...sc.compiled, fastPath: null } });
    expect(() => dt2Setup(ctx2, LABEL)).toThrow(`DT2: ${LABEL}: the default tree has no fast path`);
  });
});

describe('dt2Column\'s optional trailing argument (SP3e spec §5.2: DT2.presets)', () => {
  it('without it nothing changes; with it the 16 voxels are the same, the extras follow from the same stream', () => {
    const ctx = ctxOf();
    const a = firstColumn();
    const b = firstColumn();
    const plain = newDt2Acc(LABEL);
    const plainIdx = dt2Column(ctx, a.cx, a.cz, a.r, plain);
    const acc = newDt2Acc(LABEL);
    const seen: Dt2Voxel[] = [];
    const corners: [number, number][] = [];
    const views: [number, number][] = [];
    const idx = dt2Column(ctx, b.cx, b.cz, b.r, acc, {
      extra: { count: 2, yLo: 296, yHi: 319 },
      voxel: (v) => seen.push(v),
      corner: (cv, rc) => corners.push([cv, rc]),
      column: (view) => {
        views.push([view.cx, view.cz]);
        for (let p = 0; p < 256; p++) {
          const aux = view.aux()!;
          expect([aux.worldSurfaceWG[p], aux.oceanFloorWG[p]]).toEqual(topDownHeightmaps(view, p & 15, p >> 4));
        }
      },
    });
    expect(idx.slice(0, DT2_VOXELS_PER_COLUMN)).toEqual(plainIdx);
    expect(idx).toHaveLength(DT2_VOXELS_PER_COLUMN + 2);
    for (const i of idx.slice(DT2_VOXELS_PER_COLUMN)) expect((i >> 8) - 64).toBeGreaterThanOrEqual(296);
    // The extras draw a position, then y in 296 … 319, from DT2's stream after the 16 (a's stream is there now).
    const want: number[] = [];
    for (let k = 0; k < 2; k++) {
      const p = a.r.nextInt(256);
      want.push(((296 + a.r.nextInt(24) + 64) << 8) | p);
    }
    expect(idx.slice(DT2_VOXELS_PER_COLUMN)).toEqual(want);
    expect(b.r.nextU32()).toBe(a.r.nextU32());
    expect(acc.voxels).toBe(DT2_VOXELS_PER_COLUMN + 2);
    expect(failures(acc)).toEqual([0, 0, 0, 0]);
    expect(acc.corners).toBeGreaterThan(plain.corners);
    expect(corners).toHaveLength(acc.corners);
    expect(corners.every(([cv, rc]) => Object.is(cv, rc))).toBe(true);
    expect(views).toEqual([[b.cx, b.cz]]);
    const strata = new Map<Dt2Stratum, number>();
    for (const v of seen) strata.set(v.stratum, (strata.get(v.stratum) ?? 0) + 1);
    expect(Object.fromEntries(strata)).toEqual({ uniform: 6, bulk: 5, top: 5, extra: 2 });
    expect(seen.map((v) => v.index)).toEqual(idx);
    for (const v of seen) {
      expect(Object.is(v.value, v.reference)).toBe(true);
      expect(v.index).toBe(((v.y + 64) << 8) | ((v.z - 16 * b.cz) << 4) | (v.x - 16 * b.cx));
      if (v.runBottom !== null) expect(v.runBottom).toBeLessThanOrEqual(v.y);
      expect(v.runBottom !== null).toBe(v.block !== AIR);
    }
  });

  it('extras on an amplified column with offset0 ≥ 180 check the moved slide and ceiling (y 296 … 319) exactly', () => {
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('amplified'));
    const acc = newDt2Acc("profile amplified, seed '42'");
    const r = new Xoshiro128(fnv1a32('dt2Column.amplified'));
    let nonFinite = 0;
    const extraYs: number[] = [];
    // Task 4's first offset0 ≥ 180 column of the terrain.real scan (offset0 201.7, top 305).
    dt2Column(ctx, -13197, 10773, r, acc, {
      extra: { count: 24, yLo: 296, yHi: 319 },
      voxel: (v) => {
        if (!Number.isFinite(v.value) || !Number.isFinite(v.reference)) nonFinite++;
        if (v.stratum === 'extra') extraYs.push(v.y);
      },
      corner: (cv, rc) => { if (!Number.isFinite(cv) || !Number.isFinite(rc)) nonFinite++; },
    });
    expect(acc.problems).toEqual([]);
    expect(failures(acc)).toEqual([0, 0, 0, 0]);
    expect(nonFinite).toBe(0);
    expect(extraYs).toHaveLength(24);
    expect(Math.min(...extraYs)).toBeGreaterThanOrEqual(296);
    expect(Math.max(...extraYs)).toBeLessThanOrEqual(319);
  });

  it('refuses an extra range outside y −63 … 319 or not made of integers', () => {
    const ctx = ctxOf();
    const { r, cx, cz } = firstColumn();
    for (const extra of [{ count: 1, yLo: -64, yHi: 0 }, { count: 1, yLo: 300, yHi: 320 }, { count: 1, yLo: 10, yHi: 9 }, { count: 1.5, yLo: 0, yHi: 1 }]) {
      expect(() => dt2Column(ctx, cx, cz, r, newDt2Acc(LABEL), { extra })).toThrow(/extra voxels/);
    }
  });
});

/** The DT2 stream's next u32 after the metric's first default column (seed '42') and its 16 voxels. */
const PINNED_NEXT = 3754532636;

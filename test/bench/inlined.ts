/**
 * SP6a §10.5, the kill criterion (master :1640): the default density expression hand-written as straight-line code, the
 * comparator of the DAG closures (`src/gen/density/compile.ts`). `inlinedCorner` writes every interpolated slot's value
 * at one corner, in the compiled slot order (`INLINED_SLOTS`, `cornerValueIndex`'s layout), and `inlinedVoxel` is the
 * voxel phase's combine (the root at one voxel from those corner values). `test/unit/inlined.test.ts` proves both
 * bit-exact against the compiled tree (all 1,225 corners and every straddling voxel of four columns); the bench rows
 * `density.corner` and `density.cornerInlined` and the voxel phase's pair (`noise.bench.ts`) give the overhead:
 * ((`density.corner` − `density.cornerInlined`) per corner × corners per column + the voxel phase's difference per
 * column) / `terrain.real` p50.
 *
 * Like for like: the same work as the compiled closures, without the closures. Every operation of the resolved tree in
 * its order (IEEE addition is not associative; `a + −b` as the tree's `add(a, neg(b))`), the resolver's folds done once
 * in `inlinedLeavesOf` (`neg(param)`, `recip(param)`, all-constant sums such as `minY + −bandSpan`), and the compiler's
 * caches kept as the compiler keeps them: the column slots at the 25 corner columns and the position slots at the 256
 * positions (`inlinedColumn`, as `columnFn` and `positionFn`), the y nodes per y (`inlinedLeavesOf`'s tables, as the y
 * cache: exactly the compiled tree's y nodes, so the entrance and spaghetti 2D `slide`s, which are not y nodes, are
 * evaluated per corner), each node the tree shares once per point (T, `rough`, `ramp`, wet′'s gentle part, each band's
 * weight for both spaghetti 3D noises: the CSE; two families' terms that are equal only because their leaves are, as
 * cheese's and spaghetti 3D's band ends at the defaults, are computed apart), a `rangeChoice` evaluating only its chosen
 * branch, and at
 * voxels the min chains' per-cell skips (`minSkips`, decided by the bounds, not by the closures). Not mirrored: the plane
 * cache (an `interpolated` read is the plain `trilerp`, the same double, SP6a ruling R13).
 *
 * The leaves are read from `InlinedLeaves` (any params with the default tree's shape); the tree's own literals (the caps'
 * G_f, the floor −48, the 16 and 32 of the slots, the band zones, the slide knots, the noodle's 40) are mirrored here, so
 * a task that moves a tree literal updates this file (Global Constraints' mirrors), and the unit test fails until it does.
 */
import { SPAGHETTI_BANDS } from '../../src/core/constants';
import type { NormalNoise } from '../../src/core/noise/normal';
import type { Params } from '../../src/core/params/schema';
import { latticeIndex, readField, type ColumnSample } from '../../src/gen/column/columnStage';
import { noiseFor, type GenContext } from '../../src/gen/context';
import { cornerY, slideAt } from '../../src/gen/density/nodes';
import type { SlideKnot } from '../../src/gen/density/expr';

const LATTICE = latticeIndex;
const READ_FIELD = readField;
const SLIDE = slideAt;
const ABS = Math.abs;

/** The interpolated slots of the default tree, in compiled slot order (`cornerValueIndex(slot, i, k, j)`). */
export const INLINED_SLOTS = Object.freeze([
  'terrain', 'entrances', 'cheese', 'spag3d', 'spag2d', 'pillars', 'noodleThickness', 'noodleRidgeA', 'noodleRidgeB', 'noodleToggle',
] as const);

/**
 * The min-chain slots of the default tree's voxel-level `min` nodes (the compiled `minSlot`s, pinned by the unit test):
 * the caves chain min(min(min(E, C), S3), S2) takes 0-2, the noodle cap's two min(1, ·) 3 and 4 (4 is a y node, never
 * skipped), the root chain min(min(precave, caves + S_w), noodle + S_w) 5 and 6.
 */
export const INLINED_MIN_SLOTS = Object.freeze({ ec: 0, s3: 1, s2: 2, noodleGentle: 3, noodleSteep: 4, precave: 5, root: 6, count: 7 });

/** The thawed slide knots of the tree (the compiler's `slide` thaws them too). */
const KNOTS_OVERHANG: SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];
const KNOTS_ENTRANCE: SlideKnot[] = [[-10, 0.3], [30, 0]];
const KNOTS_SPAG2D: SlideKnot[] = [[-64, 8], [320, -40]];
/** recip(const 6) and recip(const 24), folded. */
const SIXTH = 1 / 6;
const TWENTYFOURTH = 1 / 24;

const S3Z = SPAGHETTI_BANDS.spaghetti3d.zones;
const S2Z = SPAGHETTI_BANDS.spaghetti2d.zones;
// Spaghetti 3D's bands (SP6a §1.3): band k is chosen on [lo_k, hi_k) (its zone's neighbours' outer edges); step_e(r) =
// clamp((r + −(e − 0.05))·10, 0, 1) with −(e − 0.05) the folded `c(−zone[0])`.
const S3_LO1 = S3Z[0]![0], S3_LO2 = S3Z[1]![0], S3_LO3 = S3Z[2]![0];
const S3_HI0 = S3Z[0]![1], S3_HI1 = S3Z[1]![1], S3_HI2 = S3Z[2]![1];
const S3_E0 = -S3Z[0]![0], S3_E1 = -S3Z[1]![0], S3_E2 = -S3Z[2]![0];
const S2_LO1 = S2Z[0]![0], S2_LO2 = S2Z[1]![0], S2_LO3 = S2Z[2]![0], S2_LO4 = S2Z[3]![0];
const S2_HI0 = S2Z[0]![1], S2_HI1 = S2Z[1]![1], S2_HI2 = S2Z[2]![1], S2_HI3 = S2Z[3]![1];
const S2_E0 = -S2Z[0]![0], S2_E1 = -S2Z[1]![0], S2_E2 = -S2Z[2]![0], S2_E3 = -S2Z[3]![0];

/** The leaves the default tree reads, with the resolver's folds, and the y nodes' values per corner layer and per voxel y. */
export interface InlinedLeaves {
  /** 1 / density.noises.jag.clampSigma. */
  readonly jagRecip: number;
  readonly detailLo: number;
  /** detailAmpHi + −detailAmpLo. */
  readonly detailSpan: number;
  readonly surfaceDepth: number;
  /** 1 / caves.limits.bandSpan. */
  readonly recipSpan: number;
  /** (waterDepth + 8) + bandSpan: the wet roof's gentle part. */
  readonly gwConst: number;
  /** waterDepth + 8: its steep part. */
  readonly steepConst: number;
  readonly eOffset: number;
  readonly eNegThreshold: number;
  readonly cLayerAmp: number;
  readonly cOffset: number;
  readonly cRegional: number;
  readonly cRoofDepth: number;
  readonly pThreshold: number;
  readonly s3NegThickness: number;
  readonly s3ThicknessVar: number;
  readonly s3Regional: number;
  readonly s3Scales: readonly [number, number, number, number];
  readonly s2NegThickness: number;
  readonly s2LayerAmp: number;
  readonly s2Scales: readonly [number, number, number, number, number];
  readonly nNegThickness: number;
  readonly nRidgeMul: number;
  readonly nRegional: number;
  /** −caves.noodles.threshold, the toggle slot's last term (the user's check, R31). */
  readonly nNegThreshold: number;
  // The y nodes at the corner layers k (y = −64 + 8k, 49 entries).
  /** −y. */
  readonly kNegY: Float64Array;
  /** 2·max(0, −56 + −y), the floor term. */
  readonly kFloor: Float64Array;
  /** −(2·max(0, y + −296)), the ceiling term. */
  readonly kCeil: Float64Array;
  /** The island cap's gentle part g_i. */
  readonly kGi: Float64Array;
  /** Per family: the depth band's gentle part g_f, and 128·min(1, h_f + h_i). */
  readonly kEG: Float64Array; readonly kEH: Float64Array;
  readonly kCG: Float64Array; readonly kCH: Float64Array;
  readonly kS3G: Float64Array; readonly kS3H: Float64Array;
  readonly kS2G: Float64Array; readonly kS2H: Float64Array;
  /** The noodle band's tests: y + −maxY_n and minY_n + −y. */
  readonly kNbHi: Float64Array; readonly kNbLo: Float64Array;
  // The voxel-level y nodes of the noodle's cap, at y + 64 (384 entries).
  readonly vNG: Float64Array; readonly vNH: Float64Array; readonly vGi: Float64Array;
}

/** The noises the default tree reads and the scratch of one column (`inlinedColumn`). */
export interface InlinedNoises {
  readonly jag: NormalNoise; readonly overhang: NormalNoise; readonly detail: NormalNoise;
  readonly entrance: NormalNoise; readonly entranceA: NormalNoise; readonly entranceB: NormalNoise;
  readonly roughness: NormalNoise; readonly roughnessMod: NormalNoise;
  readonly layer: NormalNoise; readonly cheese: NormalNoise; readonly cheeseRegional: NormalNoise;
  readonly pillar: NormalNoise; readonly pillarRare: NormalNoise; readonly pillarThickness: NormalNoise;
  readonly spag3dA: NormalNoise; readonly spag3dB: NormalNoise; readonly spag3dRarity: NormalNoise; readonly spag3dThickness: NormalNoise;
  readonly spagRegional: NormalNoise;
  readonly spag2d: NormalNoise; readonly spag2dElevation: NormalNoise; readonly spag2dThickness: NormalNoise; readonly spag2dRarity: NormalNoise;
  readonly noodleToggle: NormalNoise; readonly noodleThickness: NormalNoise; readonly noodleRidgeA: NormalNoise; readonly noodleRidgeB: NormalNoise;
  /**
   * The column slots at the corner columns, `cols[slot·25 + j·5 + i]`: 0 offset + jag·(1 − |jag₂/σ|)², 1 sigma, 2 wet′,
   * 3 −(regional·cheeseRegional), 4 −(regional·spagRegional) (spaghetti 3D), 5 layerAmp·spag2dElevation, 6
   * −(regional·spagRegional) (the noodle).
   */
  readonly cols: Float64Array;
  /** The position slots, `pos[slot·256 + lz·16 + lx]`: 0 the detail amplitude, 1 wet′. */
  readonly pos: Float64Array;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** min(const 1, v). */
const min1 = (v: number): number => (v < 1 ? v : 1);
/** fl(v) = max(v, −48). */
const fl = (v: number): number => (-48 > v ? -48 : v);

/** The leaves of `params` for the default tree, folded as the resolver folds them, with the y nodes' tables. */
export function inlinedLeavesOf(params: Params): InlinedLeaves {
  const cv = params.caves, lim = cv.limits;
  const s = lim.bandSpan, rS = 1 / s, capTop = lim.capTop;
  const gi = (y: number): number => clamp((((y + -capTop) + 8) + s) * rS, 0, 1);
  const hi = (y: number): number => clamp(((y + -capTop) + 8) * 0.125, 0, 1);
  const g = (minY: number, maxY: number, y: number): number =>
    clamp((minY + -y) * rS, 0, 1) + clamp((y + -maxY) * rS, 0, 1);
  const h = (minY: number, maxY: number, y: number): number =>
    128 * min1((clamp(((minY + -s) + -y) * 0.125, 0, 1) + clamp(((y + -maxY) + -s) * 0.125, 0, 1)) + hi(y));
  const k49 = (f: (y: number) => number): Float64Array => Float64Array.from({ length: 49 }, (_, k) => f(cornerY(k)));
  const v384 = (f: (y: number) => number): Float64Array => Float64Array.from({ length: 384 }, (_, i) => f(i - 64));
  const e = cv.entrances, c = cv.cheese, s3 = cv.spaghetti3d, s2 = cv.spaghetti2d, n = cv.noodles;
  return {
    jagRecip: 1 / params.density.noises.jag.clampSigma,
    detailLo: params.density.detailAmpLo,
    detailSpan: params.density.detailAmpHi + -params.density.detailAmpLo,
    surfaceDepth: lim.surfaceDepth,
    recipSpan: rS,
    gwConst: (lim.waterDepth + 8) + s,
    steepConst: lim.waterDepth + 8,
    eOffset: e.offset, eNegThreshold: -e.threshold,
    cLayerAmp: c.layerAmp, cOffset: c.offset, cRegional: c.regional, cRoofDepth: c.roofDepth,
    pThreshold: cv.pillars.threshold,
    s3NegThickness: -s3.thickness, s3ThicknessVar: s3.thicknessVar, s3Regional: s3.regional,
    s3Scales: [s3.scales.s0, s3.scales.s1, s3.scales.s2, s3.scales.s3],
    s2NegThickness: -s2.thickness, s2LayerAmp: s2.layerAmp,
    s2Scales: [s2.scales.s0, s2.scales.s1, s2.scales.s2, s2.scales.s3, s2.scales.s4],
    nNegThickness: -n.thickness, nRidgeMul: n.ridgeMul, nRegional: n.regional, nNegThreshold: -n.threshold,
    kNegY: k49((y) => -y),
    kFloor: k49((y) => { const b = -56 + -y; return 2 * (b > 0 ? b : 0); }),
    kCeil: k49((y) => { const b = y + -296; return -(2 * (b > 0 ? b : 0)); }),
    kGi: k49(gi),
    kEG: k49((y) => g(e.minY, e.maxY, y)), kEH: k49((y) => h(e.minY, e.maxY, y)),
    kCG: k49((y) => g(c.minY, c.maxY, y)), kCH: k49((y) => h(c.minY, c.maxY, y)),
    kS3G: k49((y) => g(s3.minY, s3.maxY, y)), kS3H: k49((y) => h(s3.minY, s3.maxY, y)),
    kS2G: k49((y) => g(s2.minY, s2.maxY, y)), kS2H: k49((y) => h(s2.minY, s2.maxY, y)),
    kNbHi: k49((y) => y + -n.maxY), kNbLo: k49((y) => n.minY + -y),
    vNG: v384((y) => g(n.minY, n.maxY, y)), vNH: v384((y) => h(n.minY, n.maxY, y)), vGi: v384(gi),
  };
}

/** The default tree's noises of `ctx` (`density.noises.<id>`, else `caves.noises.<id>`, as the DensityContext's source). */
export function inlinedNoisesOf(ctx: GenContext): InlinedNoises {
  const d = (id: string): NormalNoise => noiseFor(ctx, `density.noises.${id}`);
  const c = (id: string): NormalNoise => noiseFor(ctx, `caves.noises.${id}`);
  return {
    jag: d('jag'), overhang: d('overhang'), detail: d('detail'),
    entrance: c('entrance'), entranceA: c('entranceA'), entranceB: c('entranceB'), roughness: c('roughness'), roughnessMod: c('roughnessMod'),
    layer: c('layer'), cheese: c('cheese'), cheeseRegional: c('cheeseRegional'),
    pillar: c('pillar'), pillarRare: c('pillarRare'), pillarThickness: c('pillarThickness'),
    spag3dA: c('spag3dA'), spag3dB: c('spag3dB'), spag3dRarity: c('spag3dRarity'), spag3dThickness: c('spag3dThickness'),
    spagRegional: c('spagRegional'),
    spag2d: c('spag2d'), spag2dElevation: c('spag2dElevation'), spag2dThickness: c('spag2dThickness'), spag2dRarity: c('spag2dRarity'),
    noodleToggle: c('noodleToggle'), noodleThickness: c('noodleThickness'), noodleRidgeA: c('noodleRidgeA'), noodleRidgeB: c('noodleRidgeB'),
    cols: new Float64Array(7 * 25),
    pos: new Float64Array(2 * 256),
  };
}

/** The column and position slots of column (s.cx, s.cz) into `n` (`columnFn` and `positionFn`); precedes the corners. */
export function inlinedColumn(s: ColumnSample, p: InlinedLeaves, n: InlinedNoises): void {
  const x0 = 16 * s.cx, z0 = 16 * s.cz, f = s.f, cols = n.cols, pos = n.pos;
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const x = x0 + 4 * i, z = z0 + 4 * j, lat = LATTICE(i, j), cc = j * 5 + i;
      const a = 1 + -ABS(n.jag.z2(x, z) * p.jagRecip);
      cols[cc] = f.offset[lat]! + f.jag[lat]! * (a * a);
      cols[25 + cc] = f.sigma[lat]!;
      cols[50 + cc] = clamp(4 * f.wetMask[lat]!, 0, 1);
      cols[75 + cc] = -(p.cRegional * n.cheeseRegional.z2(x, z));
      const sr = n.spagRegional.z2(x, z);
      cols[100 + cc] = -(p.s3Regional * sr);
      cols[125 + cc] = p.s2LayerAmp * n.spag2dElevation.z2(x, z);
      cols[150 + cc] = -(p.nRegional * sr);
    }
  }
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = x0 + lx, z = z0 + lz, q = lz * 16 + lx;
      pos[q] = p.detailLo + p.detailSpan * clamp((READ_FIELD(s, 'E', x, z) + 1) * 0.5, 0, 1);
      pos[256 + q] = clamp(4 * READ_FIELD(s, 'wetMask', x, z), 0, 1);
    }
  }
}

/** |noiseScaled(N, m)|: one division per axis, x then y then z, as the compiler (SP6a spec §1.5). */
const scaled = (nz: NormalNoise, x: number, y: number, z: number, m: number): number => ABS(nz.z3(x / m, y / m, z / m));

/**
 * Every interpolated slot's value at corner (i, k, j) of column (s.cx, s.cz) (`inlinedColumn` ran for it) into
 * `out[cornerValueIndex(slot, i, k, j)]`, slots in `INLINED_SLOTS` order: the compiled `cornerFn`, hand-written.
 */
export function inlinedCorner(s: ColumnSample, p: InlinedLeaves, n: InlinedNoises, i: number, k: number, j: number, out: Float64Array): void {
  const idx = (k * 5 + j) * 5 + i, cc = j * 5 + i, cols = n.cols;
  const x = 16 * s.cx + 4 * i, y = -64 + 8 * k, z = 16 * s.cz + 4 * j;
  // T, the terrain body.
  const T = (((cols[cc]! + p.kNegY[k]!) + cols[25 + cc]! * (n.overhang.z3(x, y, z) * SLIDE(KNOTS_OVERHANG, y))) + p.kFloor[k]!) + p.kCeil[k]!;
  out[idx] = T;
  const negT = -T;
  const wet = cols[50 + cc]!;
  const gw = wet * clamp((p.gwConst + negT) * p.recipSpan, 0, 1);
  const gi = p.kGi[k]!;
  const rough = (-0.05 + -0.05 * n.roughnessMod.z3(x, y, z)) * (-0.4 + ABS(n.roughness.z3(x, y, z)));
  // E, the entrances (no sky test, no ramp).
  {
    const a = ((n.entrance.z3(x, y, z) * SIXTH) + p.eOffset) + 1 * SLIDE(KNOTS_ENTRANCE, y);
    const ea = ABS(n.entranceA.z3(x, y, z)), eb = ABS(n.entranceB.z3(x, y, z));
    const b = rough + clamp((eb > ea ? eb : ea) + p.eNegThreshold, -1, 1);
    out[1225 + idx] = fl(16 * (b < a ? b : a)) + (0.4 * min1((p.kEG[k]! + gw) + gi) + p.kEH[k]!);
  }
  // sky(v) = rangeChoice(T, −1e9, −8, 32, v) and ramp = clamp((surfaceDepth − T)·2, 0, 32), shared by C, S3 and S2.
  const sky = -1e9 <= T && T < -8;
  const ramp = sky ? 0 : clamp((p.surfaceDepth + negT) * 2, 0, 32);
  // C, the cheese.
  if (sky) out[2450 + idx] = 32;
  else {
    const l = n.layer.z3(x, y, z);
    const body = ((p.cLayerAmp * (l * l)) + clamp((n.cheese.z3(x, y, z) + p.cOffset) + cols[75 + cc]!, -1, 1))
      + clamp((p.cRoofDepth + negT) * TWENTYFOURTH, 0, 0.5);
    out[2450 + idx] = (fl(16 * body) + ramp) + (5.8 * min1((p.kCG[k]! + gw) + gi) + p.kCH[k]!);
  }
  // S3, spaghetti 3D: max(rmS(A), rmS(B)), the band terms under their rangeChoice.
  if (sky) out[3675 + idx] = 32;
  else {
    const r = n.spag3dRarity.z3(x, y, z), sc = p.s3Scales, nA = n.spag3dA, nB = n.spag3dB;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
    if (-1e9 <= r && r < S3_HI0) {
      const wm = (1 + -clamp((r + S3_E0) * 10, 0, 1)) * sc[0];
      a0 = wm * scaled(nA, x, y, z, sc[0]); b0 = wm * scaled(nB, x, y, z, sc[0]);
    }
    if (S3_LO1 <= r && r < S3_HI1) {
      const wm = (clamp((r + S3_E0) * 10, 0, 1) + -clamp((r + S3_E1) * 10, 0, 1)) * sc[1];
      a1 = wm * scaled(nA, x, y, z, sc[1]); b1 = wm * scaled(nB, x, y, z, sc[1]);
    }
    if (S3_LO2 <= r && r < S3_HI2) {
      const wm = (clamp((r + S3_E1) * 10, 0, 1) + -clamp((r + S3_E2) * 10, 0, 1)) * sc[2];
      a2 = wm * scaled(nA, x, y, z, sc[2]); b2 = wm * scaled(nB, x, y, z, sc[2]);
    }
    if (S3_LO3 <= r && r < 1e9) {
      const wm = clamp((r + S3_E2) * 10, 0, 1) * sc[3];
      a3 = wm * scaled(nA, x, y, z, sc[3]); b3 = wm * scaled(nB, x, y, z, sc[3]);
    }
    const ra = ((a0 + a1) + a2) + a3, rb = ((b0 + b1) + b2) + b3;
    const pre = (((rb > ra ? rb : ra) + p.s3NegThickness) + -(p.s3ThicknessVar * n.spag3dThickness.z3(x, y, z))) + cols[100 + cc]!;
    out[3675 + idx] = (fl(16 * (rough + clamp(pre, -1, 1))) + ramp) + (0.5 * min1((p.kS3G[k]! + gw) + gi) + p.kS3H[k]!);
  }
  // S2, spaghetti 2D: max(rmS2(S2d) + 0.083·tm, (|layerAmp·Nel + yGrad| + tm)³).
  if (sky) out[4900 + idx] = 32;
  else {
    const r = n.spag2dRarity.z3(x, y, z), sc = p.s2Scales, nz = n.spag2d;
    let t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0;
    if (-1e9 <= r && r < S2_HI0) t0 = ((1 + -clamp((r + S2_E0) * 10, 0, 1)) * sc[0]) * scaled(nz, x, y, z, sc[0]);
    if (S2_LO1 <= r && r < S2_HI1) t1 = ((clamp((r + S2_E0) * 10, 0, 1) + -clamp((r + S2_E1) * 10, 0, 1)) * sc[1]) * scaled(nz, x, y, z, sc[1]);
    if (S2_LO2 <= r && r < S2_HI2) t2 = ((clamp((r + S2_E1) * 10, 0, 1) + -clamp((r + S2_E2) * 10, 0, 1)) * sc[2]) * scaled(nz, x, y, z, sc[2]);
    if (S2_LO3 <= r && r < S2_HI3) t3 = ((clamp((r + S2_E2) * 10, 0, 1) + -clamp((r + S2_E3) * 10, 0, 1)) * sc[3]) * scaled(nz, x, y, z, sc[3]);
    if (S2_LO4 <= r && r < 1e9) t4 = (clamp((r + S2_E3) * 10, 0, 1) * sc[4]) * scaled(nz, x, y, z, sc[4]);
    const tm = p.s2NegThickness + -0.35 * n.spag2dThickness.z3(x, y, z);
    const a = ((((t0 + t1) + t2) + t3) + t4) + 0.083 * tm;
    const q = ABS(cols[125 + cc]! + 1 * SLIDE(KNOTS_SPAG2D, y)) + tm;
    const cube = (q * q) * q;
    out[4900 + idx] = (fl(16 * clamp(cube > a ? cube : a, -1, 1)) + ramp) + (0.3 * min1((p.kS2G[k]! + gw) + gi) + p.kS2H[k]!);
  }
  // P, the pillars.
  {
    const t = 0.55 + 0.55 * n.pillarThickness.z3(x, y, z);
    out[6125 + idx] = (16 * (((2 * n.pillar.z3(x, y, z)) + -1) + -n.pillarRare.z3(x, y, z))) * ((t * t) * t);
  }
  // The noodle's four slots, each nb(N, c): N within 40 blocks of the noodle band, c outside.
  const hiY = p.kNbHi[k]!, loY = p.kNbLo[k]!;
  const band = -1e9 <= hiY && hiY < 40 && -1e9 <= loY && loY < 40;
  out[7350 + idx] = band ? n.noodleThickness.z3(x, y, z) : 0;
  out[8575 + idx] = band ? n.noodleRidgeA.z3(x, y, z) : 1;
  out[9800 + idx] = band ? n.noodleRidgeB.z3(x, y, z) : 1;
  out[11025 + idx] = band ? (n.noodleToggle.z3(x, y, z) + cols[150 + cc]!) + p.nNegThreshold : -1;
}

/** trilerp (nodes.ts: x, then z, then y) of slot `slot` at the cell base `c` (corner index (ck·5 + cj)·5 + ci). */
const tri = (v: Float64Array, slot: number, c: number, tx: number, ty: number, tz: number): number => {
  const b = slot * 1225 + c;
  const c000 = v[b]!, c100 = v[b + 1]!, c001 = v[b + 5]!, c101 = v[b + 6]!;
  const c010 = v[b + 25]!, c110 = v[b + 26]!, c011 = v[b + 30]!, c111 = v[b + 31]!;
  const e00 = c000 + tx * (c100 - c000), e01 = c001 + tx * (c101 - c001);
  const e10 = c010 + tx * (c110 - c010), e11 = c011 + tx * (c111 - c011);
  const l = e00 + tz * (e01 - e00);
  return l + ty * ((e10 + tz * (e11 - e10)) - l);
};

/** min(min(min(E, C), S3), S2) with the cell's skips, then max(·, keep) (the caves slot at a voxel). */
function cavesAt(
  slots: Float64Array, c: number, tx: number, ty: number, tz: number, skips: Uint8Array, skipBase: number, threshold: number,
): number {
  const sk = skipBase >= 0;
  const m2 = sk ? skips[skipBase + 2]! : 0;
  let caves: number;
  if (m2 === 1) caves = tri(slots, 4, c, tx, ty, tz);
  else {
    const m1 = sk ? skips[skipBase + 1]! : 0;
    let v1: number;
    if (m1 === 1) v1 = tri(slots, 3, c, tx, ty, tz);
    else {
      const m0 = sk ? skips[skipBase]! : 0;
      let v0: number;
      if (m0 === 1) v0 = tri(slots, 2, c, tx, ty, tz);
      else if (m0 === 2) v0 = tri(slots, 1, c, tx, ty, tz);
      else { const e = tri(slots, 1, c, tx, ty, tz), ch = tri(slots, 2, c, tx, ty, tz); v0 = ch < e ? ch : e; }
      if (m1 === 2) v1 = v0;
      else { const s3 = tri(slots, 3, c, tx, ty, tz); v1 = s3 < v0 ? s3 : v0; }
    }
    if (m2 === 2) caves = v1;
    else { const s2 = tri(slots, 4, c, tx, ty, tz); caves = s2 < v1 ? s2 : v1; }
  }
  // keep = rangeChoice(P·(1/16), −1e9, threshold, −1e6, P).
  const P = tri(slots, 5, c, tx, ty, tz), p16 = P * 0.0625;
  const keep = -1e9 <= p16 && p16 < threshold ? -1e6 : P;
  return keep > caves ? keep : caves;
}

/** The noodle at a voxel: fl(16·(−thickness − 0.025·Kn + ridgeMul·max(|An|, |Bn|) + 4·max(0, −Nn))) + cap_n. */
function noodleAt(
  slots: Float64Array, p: InlinedLeaves, c: number, tx: number, ty: number, tz: number, y: number, wet: number, negT: number,
  skips: Uint8Array, skipBase: number,
): number {
  const kn = tri(slots, 6, c, tx, ty, tz);
  const ra = ABS(tri(slots, 7, c, tx, ty, tz)), rb = ABS(tri(slots, 8, c, tx, ty, tz));
  const nt = -tri(slots, 9, c, tx, ty, tz);
  const body = ((p.nNegThickness + -0.025 * kn) + p.nRidgeMul * (rb > ra ? rb : ra)) + 4 * (nt > 0 ? nt : 0);
  const yi = y + 64;
  const m3 = skipBase >= 0 ? skips[skipBase + 3]! : 0;
  const x = (p.vNG[yi]! + wet * clamp((p.gwConst + negT) * p.recipSpan, 0, 1)) + p.vGi[yi]!;
  const gentle = m3 === 1 ? x : m3 === 2 ? 1 : x < 1 ? x : 1;
  return fl(16 * body) + (0.4 * gentle + p.vNH[yi]!);
}

/**
 * The root at voxel (lx, y, lz) of column (s.cx, s.cz) from `slots` (`inlinedCorner`'s values at the voxel's cell's 8
 * corners) and `n`'s position slots (`inlinedColumn`): the compiled `voxelFn`, hand-written. `skips[skipBase + slot]` are
 * the cell's min skips (`CompiledDensity.minSkips`, slots `INLINED_MIN_SLOTS`; 1: child a not needed, 2: child b),
 * `skipBase` −1 for none.
 */
export function inlinedVoxel(
  slots: Float64Array, s: ColumnSample, p: InlinedLeaves, n: InlinedNoises, lx: number, y: number, lz: number,
  skips: Uint8Array, skipBase: number,
): number {
  const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
  const c = (ck * 5 + cj) * 5 + ci;
  const tx = (lx - 4 * ci) / 4, ty = (y + 64 - 8 * ck) / 8, tz = (lz - 4 * cj) / 4;
  const q = lz * 16 + lx;
  const T = tri(slots, 0, c, tx, ty, tz);
  const negT = -T;
  const wet = n.pos[256 + q]!;
  const m6 = skipBase >= 0 ? skips[skipBase + 6]! : 0, m5 = skipBase >= 0 ? skips[skipBase + 5]! : 0;
  // S_w, the wet roof's steep part, once per voxel where caves + S_w or noodle + S_w is read.
  const sw = m6 === 2 && m5 === 2 ? 0 : 128 * (wet * clamp((p.steepConst + negT) * 0.125, 0, 1));
  // The root chain: min(min(precave, caves + S_w), noodle + S_w), then max(·, islands −1e6).
  let v: number;
  if (m6 === 1) v = noodleAt(slots, p, c, tx, ty, tz, y, wet, negT, skips, skipBase) + sw;
  else {
    let v5: number;
    if (m5 === 1) v5 = cavesAt(slots, c, tx, ty, tz, skips, skipBase, p.pThreshold) + sw;
    else {
      const a = T + (-1e9 <= T && T < 16 ? n.detail.z3(16 * s.cx + lx, y, 16 * s.cz + lz) * n.pos[q]! : 0);
      if (m5 === 2) v5 = a;
      else { const b = cavesAt(slots, c, tx, ty, tz, skips, skipBase, p.pThreshold) + sw; v5 = b < a ? b : a; }
    }
    if (m6 === 2) v = v5;
    else { const b = noodleAt(slots, p, c, tx, ty, tz, y, wet, negT, skips, skipBase) + sw; v = b < v5 ? b : v5; }
  }
  return -1e6 > v ? -1e6 : v;
}

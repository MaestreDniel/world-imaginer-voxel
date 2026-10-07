/**
 * Interval bounds per 4 × 8 × 4 cell and the early-out column driver (SP3b spec §1.2, §2.4).
 *
 * Bounds. For one cell of the current column, every node of a CompiledDensity gets an interval that holds each value
 * the node takes in that cell, by the nodes.ts rules composed per node (children before parents):
 * - a node inside `interpolated` is evaluated only at corners, so its interval covers the cell's 8 corners: `y` is
 *   [y0, y0 + 8], a COLUMN node with a column slot is the hull of its 4 corner-column values (exact);
 * - a node outside covers the cell's 128 voxels: `y` is [y0, y0 + 7], a COLUMN node with a position slot is the hull of
 *   its 4 × 4 position values, widened (spec §1.2: every voxel-level COLUMN value interval is widened);
 * - `noise` is [−clampSigma, clampSigma]; a `const` is [v, v]; `interpolated` is its child's interval, widened, or,
 *   once the cell's corners exist (`cellIntervalCorners`), the hull of its 8 corner values, widened;
 * - a COLUMN node that no non-COLUMN node reads (only COLUMN parents, which take their hull from slot values) gets no
 *   interval (NaN in `nodeIntervals`).
 *
 * Driver. `fillDensityColumn` writes one column's solidity (density > 0) for all 98,304 voxels, cell by cell, bottom
 * up: the root's interval decides hi < 0 (non-solid) and lo > 0 (solid) without corner or voxel work; otherwise the
 * cell's corners are evaluated (each at most once per column) and the interval is refined with them; only a cell that
 * still straddles 0 runs `voxelFn` per voxel. Early-outs never change a voxel's solidity.
 */
import type { ColumnSample } from '../column/columnStage';
import type { CompiledDensity } from './compile';
import type { DensityNoiseSource, SlideKnot } from './expr';
import {
  cornerY, ivAbs, ivAdd, ivClamp, ivHull, ivMax, ivMin, ivMul, ivNeg, ivSet, ivSlide, ivSquare, ivWiden, rangeChoiceCase,
} from './nodes';

const CORNER_Y = cornerY;
const IV_ABS = ivAbs;
const IV_ADD = ivAdd;
const IV_CLAMP = ivClamp;
const IV_HULL = ivHull;
const IV_MAX = ivMax;
const IV_MIN = ivMin;
const IV_MUL = ivMul;
const IV_NEG = ivNeg;
const IV_SET = ivSet;
const IV_SLIDE = ivSlide;
const IV_SQUARE = ivSquare;
const IV_WIDEN = ivWiden;
const RANGE_CASE = rangeChoiceCase;

/** Offsets of a cell's other 3 corner columns from its (ci, cj) one in a colValues slot: x +1, z +5. */
const COLUMN_OFFSETS = Int32Array.of(1, 5, 6);
/** Offsets of a cell's other 7 corners from its (ci, ck, cj) one in a cornerValues slot: x +1, z +5, y +25. */
const CORNER_OFFSETS = Int32Array.of(1, 5, 6, 25, 26, 30, 31);

// Instruction codes (module-private).
const I_COL_HULL = 0;
const I_POS_HULL = 1;
const I_Y = 2;
const I_NOISE = 3;
const I_ADD = 4;
const I_MUL = 5;
const I_MIN = 6;
const I_MAX = 7;
const I_NEG = 8;
const I_ABS = 9;
const I_SQUARE = 10;
const I_CLAMP = 11;
const I_SLIDE = 12;
const I_INTERP = 13;
const I_RANGE = 14;
const I_PASS = 15;

/** Interval bounds of one CompiledDensity (it reads that compile's slot values and corner cache). */
export interface DensityBounds {
  readonly compiled: CompiledDensity;
  /**
   * Per node `id`, `[nodeIntervals[2·id], nodeIntervals[2·id + 1]]` after the last cellInterval/cellIntervalCorners
   * call (NaN for a COLUMN node that only COLUMN parents read). Read-only for callers.
   */
  readonly nodeIntervals: Float64Array;
  /** Takes the column and position slot hulls of the compile's current column: call after columnFn and positionFn. */
  beginColumn(): void;
  /** The root's interval over cell (ci, ck, cj) into `out[k]`, `out[k + 1]`; `interpolated` from its child's interval. */
  cellInterval(ci: number, ck: number, cj: number, out: Float64Array, k: number): void;
  /**
   * The root's interval over cell (ci, ck, cj) with every `interpolated` taken from the hull of the cell's 8 corner
   * values (widened). Needs `compiled.cellCorners(ci, ck, cj)` and a cellInterval call for the same cell first.
   */
  cellIntervalCorners(ci: number, ck: number, cj: number, out: Float64Array, k: number): void;
}

/** Creates the bounds of `c`; `noises` must be the source `c` was compiled with (for each noise's clampSigma). */
export function createDensityBounds(c: CompiledDensity, noises: DensityNoiseSource): DensityBounds {
  const nodes = c.nodes;
  const n = nodes.length;
  const iv = new Float64Array(2 * n).fill(NaN);
  // Instructions: inside nodes (cell program) then outside nodes (voxel program), each in node order.
  const codes: number[] = [], dst: number[] = [], ka: number[] = [], kb: number[] = [], kc: number[] = [];
  const pa: number[] = [], pb: number[] = [];
  const knots: Array<readonly SlideKnot[] | null> = [];
  const push = (code: number, id: number, a: number, b: number, cc: number, p0: number, p1: number, kn: readonly SlideKnot[] | null): void => {
    codes.push(code); dst.push(id); ka.push(a); kb.push(b); kc.push(cc); pa.push(p0); pb.push(p1); knots.push(kn);
  };
  let cellCount = 0;
  for (const inside of [true, false]) {
    for (let id = 0; id < n; id++) {
      const node = nodes[id]!;
      if (node.inside !== inside) continue;
      const e = node.expr;
      if (e.op === 'const') { iv[2 * id] = e.v; iv[2 * id + 1] = e.v; continue; }
      if (node.cls === 'column') {
        if (node.colSlot >= 0) push(I_COL_HULL, id, node.colSlot, 0, 0, 0, 0, null);
        else if (node.posSlot >= 0) push(I_POS_HULL, id, node.posSlot, 0, 0, 0, 0, null);
        continue;
      }
      const [a = -1, b = -1, k3 = -1] = node.kids;
      switch (e.op) {
        case 'y': push(I_Y, id, 0, 0, 0, inside ? 8 : 7, 0, null); break;
        case 'noise': {
          const nz = noises(e.id);
          if (nz === undefined) throw new Error(`unknown density noise ${e.id}`);
          push(I_NOISE, id, 0, 0, 0, nz.clampSigma, 0, null);
          break;
        }
        case 'add': push(I_ADD, id, a, b, 0, 0, 0, null); break;
        case 'mul': push(I_MUL, id, a, b, 0, 0, 0, null); break;
        case 'min': push(I_MIN, id, a, b, 0, 0, 0, null); break;
        case 'max': push(I_MAX, id, a, b, 0, 0, 0, null); break;
        case 'neg': push(I_NEG, id, a, 0, 0, 0, 0, null); break;
        case 'abs': push(I_ABS, id, a, 0, 0, 0, 0, null); break;
        case 'square': push(I_SQUARE, id, a, 0, 0, 0, 0, null); break;
        case 'clamp': push(I_CLAMP, id, a, 0, 0, e.lo, e.hi, null); break;
        case 'slide': push(I_SLIDE, id, a, 0, 0, inside ? 8 : 7, 0, e.knots); break;
        case 'interpolated': push(I_INTERP, id, a, node.interpSlot, 0, 0, 0, null); break;
        case 'rangeChoice': push(I_RANGE, id, a, b, k3, e.lo, e.hi, null); break;
        case 'tap': push(I_PASS, id, a, 0, 0, 0, 0, null); break;
        default: throw new Error(`unreachable: ${e.op} is COLUMN`);
      }
    }
    if (inside) cellCount = codes.length;
  }
  const count = codes.length;
  const code = Int32Array.from(codes), out0 = Int32Array.from(dst), A = Int32Array.from(ka), B = Int32Array.from(kb);
  const K3 = Int32Array.from(kc), P0 = Float64Array.from(pa), P1 = Float64Array.from(pb);

  const colHull = new Float64Array(c.columnSlotCount * 32);
  const posHull = new Float64Array(c.positionSlotCount * 32);
  const colValues = c.colValues, posValues = c.posValues, cornerValues = c.cornerValues;
  const root = c.root;

  const beginColumn = (): void => {
    for (let slot = 0; slot < c.columnSlotCount; slot++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          const base = slot * 25 + cj * 5 + ci;
          let lo = colValues[base]!, hi = lo;
          for (let q = 0; q < 3; q++) {
            const v = colValues[base + COLUMN_OFFSETS[q]!]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const h = (slot * 16 + cj * 4 + ci) * 2;
          colHull[h] = lo;
          colHull[h + 1] = hi;
        }
      }
    }
    for (let slot = 0; slot < c.positionSlotCount; slot++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          let lo = Infinity, hi = -Infinity;
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              const v = posValues[slot * 256 + lz * 16 + lx]!;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
          IV_WIDEN(lo, hi, posHull, (slot * 16 + cj * 4 + ci) * 2);
        }
      }
    }
  };

  /** Runs instructions [from, to) for cell (ci, ck, cj); `corners`: interpolated from the corner hull. */
  const run = (from: number, to: number, ci: number, ck: number, cj: number, corners: boolean): void => {
    const y0 = CORNER_Y(ck);
    const cc4 = cj * 4 + ci;
    for (let q = from; q < to; q++) {
      const o = 2 * out0[q]!;
      const a = 2 * A[q]!;
      switch (code[q]) {
        case I_COL_HULL: { const h = (A[q]! * 16 + cc4) * 2; iv[o] = colHull[h]!; iv[o + 1] = colHull[h + 1]!; break; }
        case I_POS_HULL: { const h = (A[q]! * 16 + cc4) * 2; iv[o] = posHull[h]!; iv[o + 1] = posHull[h + 1]!; break; }
        case I_Y: IV_SET(y0, y0 + P0[q]!, iv, o); break;
        case I_NOISE: IV_SET(-P0[q]!, P0[q]!, iv, o); break;
        case I_ADD: { const b = 2 * B[q]!; IV_ADD(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_MUL: { const b = 2 * B[q]!; IV_MUL(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_MIN: { const b = 2 * B[q]!; IV_MIN(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_MAX: { const b = 2 * B[q]!; IV_MAX(iv[a]!, iv[a + 1]!, iv[b]!, iv[b + 1]!, iv, o); break; }
        case I_NEG: IV_NEG(iv[a]!, iv[a + 1]!, iv, o); break;
        case I_ABS: IV_ABS(iv[a]!, iv[a + 1]!, iv, o); break;
        case I_SQUARE: IV_SQUARE(iv[a]!, iv[a + 1]!, iv, o); break;
        case I_CLAMP: IV_CLAMP(iv[a]!, iv[a + 1]!, P0[q]!, P1[q]!, iv, o); break;
        case I_SLIDE: IV_SLIDE(iv[a]!, iv[a + 1]!, knots[q]!, y0, y0 + P0[q]!, iv, o); break;
        case I_INTERP: {
          if (!corners) { IV_WIDEN(iv[a]!, iv[a + 1]!, iv, o); break; }
          const base = B[q]! * 1225 + (ck * 5 + cj) * 5 + ci;
          let lo = cornerValues[base]!, hi = lo;
          for (let q = 0; q < 7; q++) {
            const v = cornerValues[base + CORNER_OFFSETS[q]!]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          IV_WIDEN(lo, hi, iv, o);
          break;
        }
        case I_RANGE: {
          const b = 2 * B[q]!, d = 2 * K3[q]!;
          const which = RANGE_CASE(iv[a]!, iv[a + 1]!, P0[q]!, P1[q]!);
          if (which === 'inside') IV_SET(iv[b]!, iv[b + 1]!, iv, o);
          else if (which === 'outside') IV_SET(iv[d]!, iv[d + 1]!, iv, o);
          else IV_HULL(iv[b]!, iv[b + 1]!, iv[d]!, iv[d + 1]!, iv, o);
          break;
        }
        case I_PASS: IV_SET(iv[a]!, iv[a + 1]!, iv, o); break;
        default: throw new Error('unreachable: unknown interval instruction');
      }
    }
  };

  return {
    compiled: c,
    nodeIntervals: iv,
    beginColumn,
    cellInterval: (ci, ck, cj, out, k) => {
      run(0, count, ci, ck, cj, false);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
    cellIntervalCorners: (ci, ck, cj, out, k) => {
      run(cellCount, count, ci, ck, cj, true);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
  };
}

const IV = new Float64Array(2);

/**
 * Fills column (s.cx, s.cz)'s solidity with early-outs (SP3b spec §2.4, §4): runs `columnFn` and `positionFn` of
 * `b.compiled` on `s`, then the 48 cell layers bottom up, polling `stop()` before every 8 layers (6 polls); on true it
 * returns false at once (the outputs are then partial). `solid[((y + 64)·16 + lz)·16 + lx]` (98,304 entries, the T
 * stage's section order) becomes 1 where the density is > 0, else 0. A non-null `mask` is cleared, then set to 1 at
 * each voxel `voxelFn` evaluated; a non-null `values` receives those voxels' values (its other entries are left as they
 * were). Nothing is allocated.
 */
export function fillDensityColumn(
  b: DensityBounds, s: ColumnSample, solid: Uint8Array, values: Float64Array | null, mask: Uint8Array | null,
  stop: () => boolean,
): boolean {
  const c = b.compiled;
  c.columnFn(s);
  c.positionFn(s);
  b.beginColumn();
  if (mask !== null) mask.fill(0);
  const corners = c.interpolatedSlotCount > 0;
  for (let ck = 0; ck < 48; ck++) {
    if ((ck & 7) === 0 && stop()) return false;
    const y0 = CORNER_Y(ck);
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        b.cellInterval(ci, ck, cj, IV, 0);
        let fill = IV[1]! < 0 ? 0 : IV[0]! > 0 ? 1 : -1;
        if (fill < 0 && corners) {
          c.cellCorners(ci, ck, cj);
          b.cellIntervalCorners(ci, ck, cj, IV, 0);
          fill = IV[1]! < 0 ? 0 : IV[0]! > 0 ? 1 : -1;
        }
        for (let y = y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            const row = ((y + 64) * 16 + lz) * 16;
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              if (fill >= 0) { solid[row + lx] = fill; continue; }
              const v = c.voxelFn(lx, y, lz);
              solid[row + lx] = v > 0 ? 1 : 0;
              if (values !== null) values[row + lx] = v;
              if (mask !== null) mask[row + lx] = 1;
            }
          }
        }
      }
    }
  }
  return true;
}

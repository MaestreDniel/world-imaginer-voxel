/**
 * Interval bounds per 4 × 8 × 4 cell and the early-out column driver (SP3b spec §1.2, §2.4).
 *
 * Bounds. For one cell of the current column, every node of a CompiledDensity gets an interval that holds each value
 * the node takes in that cell, by the nodes.ts rules composed per node (children before parents):
 * - a node inside `interpolated` is evaluated only at corners, so its interval covers the cell's 8 corners: `y` is
 *   [y0, y0 + 8], a COLUMN node with a column slot is the hull of its 4 corner-column values (exact);
 * - a node outside covers the cell's 128 voxels: `y` is [y0, y0 + 7], a COLUMN node with a position slot is the hull of
 *   its 4 × 4 position values, widened (spec §1.2: every voxel-level COLUMN value interval is widened);
 * - `noise` and `noiseScaled` are [−clampSigma, clampSigma]; a `const` is [v, v]; `interpolated` is its child's
 *   interval, widened, or, once the cell's corners exist (`cellIntervalCorners`), the hull of its 8 corner values,
 *   widened;
 * - poison (SP3d spec §1.9 D): the interval ops of nodes.ts turn a non-finite input or a NaN result into UNKNOWN =
 *   [−∞, +∞], and every slot and corner hull tests each value it folds in for NaN and the finished hull for
 *   finiteness (never its ±Infinity seed), so a NaN or ±∞ slot or corner value makes the hull UNKNOWN; an UNKNOWN root
 *   decides nothing and the cell's voxels are evaluated. A hull of finite values is exactly SP3b's;
 * - a COLUMN node that no non-COLUMN node reads (only COLUMN parents, which take their hull from slot values) gets no
 *   interval (NaN in `nodeIntervals`).
 *
 * Driver. `fillDensityColumn` writes one column's solidity (density > 0) for all 98,304 voxels, cell by cell, bottom
 * up: the root's interval decides hi < 0 (non-solid) and lo > 0 (solid) without corner or voxel work; otherwise the
 * cell's corners are evaluated (each at most once per column) and the interval is refined with them; only a cell that
 * still straddles 0 runs `voxelFn` per voxel. Early-outs never change a voxel's solidity.
 *
 * Min skips (SP6a spec §1.6 lever (4)). Before a straddling cell's voxels, `cellMinSkips` reads its nodes' intervals
 * (from the corner hulls once the corners exist) and marks, in each min chain of the compile, every operand whose low
 * end exceeds the lowest high end of the chain's operands: it is above another operand at every voxel of the cell, so
 * it cannot be the minimum, and `voxelFn` does not evaluate it there (a `min` of the chain whose two children are both
 * skipped is skipped by its parent). A chain with an unknown or non-finite operand interval skips nothing. The values
 * are kept bit for bit (compile.ts' "Min chains"); the families E, C, S3, S2 of `min(E, C, S3, S2)` and the noodle
 * against `min(T + detailG, caves)` are the default tree's chains.
 *
 * The air witnesses (SP6a ruling R13, output-keeping). From the root, down through every `min` (to its first child)
 * and every `max` (to the child beside a negative constant, or a tap of one; to both children otherwise), to the first
 * nodes of another kind: wherever each of these nodes W is below 0, so is the root (a `min` is at most its first child
 * and a `max` of values below 0 is below 0, NaN aside: a NaN voxel is air). `cellDecide` first runs the witnesses'
 * program (the instructions of their sub-trees, in program order) and, when every W's high end is below 0, decides the
 * cell air without the rest: in the default tree the one witness is the `precave` tap (T + detailG, 26 of about 390
 * instructions), which decides every sky cell; in floating_islands' tree the `precave` and `islands` taps. Otherwise it
 * runs the whole program and gives cellInterval's root interval. Where cellInterval decides air, so do the witnesses,
 * and the other way round unless an operand's interval is UNKNOWN (non-finite), where they still decide air soundly.
 */
import type { ColumnSample } from '../column/columnStage';
import type { CompiledDensity } from './compile';
import type { DensityNoiseSource, SlideKnot } from './expr';
import {
  cornerY, ivAbs, ivAdd, ivClamp, ivMax, ivMin, ivMul, ivNeg, ivRangeChoice, ivSet, ivSlide, ivSquare, ivUnknown, ivWiden,
} from './nodes';

const CORNER_Y = cornerY;
const IV_ABS = ivAbs;
const IV_ADD = ivAdd;
const IV_CLAMP = ivClamp;
const IV_MAX = ivMax;
const IV_MIN = ivMin;
const IV_MUL = ivMul;
const IV_NEG = ivNeg;
const IV_RANGE = ivRangeChoice;
const IV_SET = ivSet;
const IV_SLIDE = ivSlide;
const IV_SQUARE = ivSquare;
const IV_UNKNOWN = ivUnknown;
const IV_WIDEN = ivWiden;
const FINITE = Number.isFinite;
const IS_NAN = Number.isNaN;

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

/** One interval program: per instruction its code, its node, its operands and parameters (module-private). */
interface Program {
  readonly code: Int32Array;
  readonly out0: Int32Array;
  readonly A: Int32Array;
  readonly B: Int32Array;
  readonly K3: Int32Array;
  readonly P0: Float64Array;
  readonly P1: Float64Array;
  readonly knots: ReadonlyArray<readonly SlideKnot[] | null>;
}

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
  /**
   * Node `node`'s interval over cell (ci, ck, cj) into `out[k]`, `out[k + 1]`, as `cellInterval` gives it (no corners),
   * running only the instructions of the nodes up to `node` (a node's sub-tree has smaller indices): the cave tag's
   * pre-cave check (SP6a spec §3.2), cheaper than the root's whole program. Updates `nodeIntervals` of those nodes only.
   */
  nodeInterval(ci: number, ck: number, cj: number, node: number, out: Float64Array, k: number): void;
  /** Whether `fillDensityColumn` applies the min skips (SP6a spec §1.6 lever (4)); `createDensityBounds`' `minSkip`. */
  readonly minSkip: boolean;
  /**
   * The min skips of cell (ci, ck, cj) (SP6a spec §1.6 lever (4)) from `nodeIntervals` as the last cellInterval or
   * cellIntervalCorners call for that cell left them: writes the cell's `compiled.minSkips` and sets its
   * `compiled.minSkipReady`; returns the number of operands skipped. Writes nothing when `minSkip` is false or the
   * compile has no min chain.
   */
  cellMinSkips(ci: number, ck: number, cj: number): number;
  /** Totals since creation (diagnostics): `[0]` the cells with at least one operand skipped, `[1]` the operands skipped. */
  readonly minSkipCounts: Float64Array;
  /** The first air witness (SP6a ruling R13), or −1 when the root has none or `createDensityBounds`' `airWitness` is false. */
  readonly airWitness: number;
  /** Every air witness, in the order the root's walk meets them (empty when `airWitness` is −1). */
  readonly airWitnesses: readonly number[];
  /**
   * As cellInterval, except that when every air witness's high end is below 0 after their program, the rest is not run
   * and `out` receives [−∞, the highest of those high ends] (an interval of the root, wider than cellInterval's);
   * `nodeIntervals` then hold the witnesses' sub-trees only. Otherwise `out` and `nodeIntervals` are cellInterval's.
   */
  cellDecide(ci: number, ck: number, cj: number, out: Float64Array, k: number): void;
  /** Totals since creation (diagnostics): `[0]` the cells cellDecide decided by the air witness alone. */
  readonly airWitnessCount: Float64Array;
}

/**
 * Creates the bounds of `c`; `noises` must be the source `c` was compiled with (for each noise's clampSigma). `minSkip`
 * false turns lever (4)'s min skips off (the same values, every operand evaluated); `airWitness` false turns the air
 * witness off (`cellDecide` is then cellInterval).
 */
export function createDensityBounds(c: CompiledDensity, noises: DensityNoiseSource, minSkip = true, airWitness = true): DensityBounds {
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
        case 'noise': case 'noiseScaled': {
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
        // Thawed knots: element reads of a resolved tree's frozen arrays are slower in V8 (SP3d final review).
        case 'slide': push(I_SLIDE, id, a, 0, 0, inside ? 8 : 7, 0, e.knots.map((k): SlideKnot => [k[0], k[1]])); break;
        case 'interpolated': push(I_INTERP, id, a, node.interpSlot, 0, 0, 0, null); break;
        case 'rangeChoice': push(I_RANGE, id, a, b, k3, e.lo, e.hi, null); break;
        case 'tap': push(I_PASS, id, a, 0, 0, 0, 0, null); break;
        default: throw new Error(`unreachable: ${e.op} is COLUMN`);
      }
    }
    if (inside) cellCount = codes.length;
  }
  const count = codes.length;
  // Per node: the end of the cell program's and of the voxel program's instructions of the nodes up to it.
  const endIn = new Int32Array(n), endOut = new Int32Array(n);
  {
    let a = 0, b = cellCount;
    for (let id = 0; id < n; id++) {
      while (a < cellCount && dst[a]! <= id) a++;
      while (b < count && dst[b]! <= id) b++;
      endIn[id] = a;
      endOut[id] = b;
    }
  }
  const code = Int32Array.from(codes), out0 = Int32Array.from(dst), A = Int32Array.from(ka), B = Int32Array.from(kb);
  const K3 = Int32Array.from(kc), P0 = Float64Array.from(pa), P1 = Float64Array.from(pb);
  const MAIN: Program = { code, out0, A, B, K3, P0, P1, knots };
  /** The sub-program of the instructions whose node is in `keep`, in program order. */
  const subProgram = (keep: Uint8Array): Program => {
    const at: number[] = [];
    for (let q = 0; q < count; q++) if (keep[out0[q]!] === 1) at.push(q);
    return {
      code: Int32Array.from(at, (q) => code[q]!), out0: Int32Array.from(at, (q) => out0[q]!),
      A: Int32Array.from(at, (q) => A[q]!), B: Int32Array.from(at, (q) => B[q]!), K3: Int32Array.from(at, (q) => K3[q]!),
      P0: Float64Array.from(at, (q) => P0[q]!), P1: Float64Array.from(at, (q) => P1[q]!), knots: at.map((q) => knots[q]!),
    };
  };

  const colHull = new Float64Array(c.columnSlotCount * 32);
  const posHull = new Float64Array(c.positionSlotCount * 32);
  const colValues = c.colValues, posValues = c.posValues, cornerValues = c.cornerValues;
  const root = c.root;

  // Min chains (lever (4)), flattened: per chain its operands [opFrom, opTo) in chainOps and its mins [minFrom, minTo)
  // in chainMins (children first); per chain min its slot and, per child, the child's min slot (≥ 0: an inner min of
  // the chain) or −1 with the child's node (an operand).
  const chains = c.minChains, nChains = chains.length, nSlots = c.minSlotCount;
  const opStart = new Int32Array(nChains + 1), minStart = new Int32Array(nChains + 1);
  const chainOps: number[] = [], chainMins: number[] = [];
  for (let q = 0; q < nChains; q++) {
    chainOps.push(...chains[q]!.operands);
    chainMins.push(...chains[q]!.mins);
    opStart[q + 1] = chainOps.length;
    minStart[q + 1] = chainMins.length;
  }
  const opNode = Int32Array.from(chainOps);
  const minSlotOf = Int32Array.from(chainMins, (m) => nodes[m]!.minSlot);
  const kidA = Int32Array.from(chainMins, (m) => nodes[m]!.kids[0]!);
  const kidB = Int32Array.from(chainMins, (m) => nodes[m]!.kids[1]!);
  // A child is an inner min of the same chain (its slot), else an operand (−1), even when it roots a chain of its own.
  const innerSlot = (q: number, k: number): number => (chains[q]!.mins.includes(k) ? nodes[k]!.minSlot : -1);
  const kidSlotA = new Int32Array(chainMins.length), kidSlotB = new Int32Array(chainMins.length);
  for (let q = 0; q < nChains; q++) {
    for (let m = minStart[q]!; m < minStart[q + 1]!; m++) {
      kidSlotA[m] = innerSlot(q, kidA[m]!);
      kidSlotB[m] = innerSlot(q, kidB[m]!);
    }
  }
  // The air witnesses (R13): through `min` (first child) and `max` (beside a negative constant; else both children).
  const negConst = (id: number): boolean => {
    const nd = nodes[id]!;
    if (nd.op === 'tap') return negConst(nd.kids[0]!);
    return nd.op === 'const' && (nd.expr as { v: number }).v < 0;
  };
  const found: number[] = [];
  /** Collects the witnesses under `id`; false when one of them could never be below 0 by an interval of its own. */
  const collect = (id: number): boolean => {
    const nd = nodes[id]!;
    if (nd.op === 'min') return collect(nd.kids[0]!);
    if (nd.op === 'max') {
      if (negConst(nd.kids[1]!)) return collect(nd.kids[0]!);
      if (negConst(nd.kids[0]!)) return collect(nd.kids[1]!);
      return collect(nd.kids[0]!) && collect(nd.kids[1]!);
    }
    // A node with an interval of its own (an instruction): not a const, not a slot-less COLUMN node.
    if (nd.op === 'const' || (nd.cls === 'column' && nd.colSlot < 0 && nd.posSlot < 0)) return false;
    if (!found.includes(id)) found.push(id);
    return true;
  };
  const witnesses = airWitness && collect(c.root) && !found.includes(c.root) ? Int32Array.from(found) : new Int32Array(0);
  const nW = witnesses.length;
  // Their program: every node of their sub-trees.
  const inWitness = new Uint8Array(n);
  {
    const stack = [...witnesses];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (inWitness[id] === 1) continue;
      inWitness[id] = 1;
      for (const k of nodes[id]!.kids) stack.push(k);
    }
  }
  const WITNESS = subProgram(inWitness);
  const wCount = WITNESS.code.length;
  /** Runs the witnesses' program over cell (ci, ck, cj); true when each witness's high end is below 0. */
  const witnessAir = (ci: number, ck: number, cj: number): boolean => {
    run(WITNESS, 0, wCount, ci, ck, cj, false);
    for (let w = 0; w < nW; w++) if (!(iv[2 * witnesses[w]! + 1]! < 0)) return false;
    return true;
  };
  const airWitnessCount = new Float64Array(1);

  const minSkips = c.minSkips, minSkipReady = c.minSkipReady;
  const minSkipCounts = new Float64Array(2);
  const skipOn = minSkip && nChains > 0;

  const cellMinSkips = (ci: number, ck: number, cj: number): number => {
    if (!skipOn) return 0;
    const cell = (ck * 4 + cj) * 4 + ci;
    const base = cell * nSlots;
    let skipped = 0;
    for (let q = 0; q < nChains; q++) {
      // H: the lowest high end of the chain's operands; an operand whose low end exceeds it cannot be the minimum.
      let h = Infinity, known = true;
      for (let o = opStart[q]!; o < opStart[q + 1]!; o++) {
        const id = opNode[o]!, lo = iv[2 * id]!, hi = iv[2 * id + 1]!;
        if (!(FINITE(lo) && FINITE(hi))) { known = false; break; }
        if (hi < h) h = hi;
      }
      for (let m = minStart[q]!; m < minStart[q + 1]!; m++) {
        let st = 0;
        if (known) {
          const sa = kidSlotA[m]!, sb = kidSlotB[m]!;
          // An inner min is not needed when both its children are not (3); an operand when its low end exceeds H.
          const skipA = sa >= 0 ? minSkips[base + sa] === 3 : iv[2 * kidA[m]!]! > h;
          const skipB = sb >= 0 ? minSkips[base + sb] === 3 : iv[2 * kidB[m]!]! > h;
          if (skipA) { st |= 1; if (sa < 0) skipped++; }
          if (skipB) { st |= 2; if (sb < 0) skipped++; }
        }
        minSkips[base + minSlotOf[m]!] = st;
      }
    }
    minSkipReady[cell] = 1;
    if (skipped > 0) { minSkipCounts[0]++; minSkipCounts[1] += skipped; }
    return skipped;
  };

  const beginColumn = (): void => {
    for (let slot = 0; slot < c.columnSlotCount; slot++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          const base = slot * 25 + cj * 5 + ci;
          let lo = colValues[base]!, hi = lo, nan = IS_NAN(lo);
          for (let q = 0; q < 3; q++) {
            const v = colValues[base + COLUMN_OFFSETS[q]!]!;
            if (IS_NAN(v)) nan = true;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const h = (slot * 16 + cj * 4 + ci) * 2;
          if (nan || !FINITE(lo) || !FINITE(hi)) IV_UNKNOWN(colHull, h);
          else { colHull[h] = lo; colHull[h + 1] = hi; }
        }
      }
    }
    for (let slot = 0; slot < c.positionSlotCount; slot++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          let lo = Infinity, hi = -Infinity, nan = false;
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              const v = posValues[slot * 256 + lz * 16 + lx]!;
              if (IS_NAN(v)) nan = true;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
          const h = (slot * 16 + cj * 4 + ci) * 2;
          if (nan || !FINITE(lo) || !FINITE(hi)) IV_UNKNOWN(posHull, h);
          else IV_WIDEN(lo, hi, posHull, h);
        }
      }
    }
  };

  /** Runs instructions [from, to) of program `P` for cell (ci, ck, cj); `corners`: interpolated from the corner hull. */
  const run = (P: Program, from: number, to: number, ci: number, ck: number, cj: number, corners: boolean): void => {
    const code = P.code, out0 = P.out0, A = P.A, B = P.B, K3 = P.K3, P0 = P.P0, P1 = P.P1, knots = P.knots;
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
          let lo = cornerValues[base]!, hi = lo, nan = IS_NAN(lo);
          for (let q = 0; q < 7; q++) {
            const v = cornerValues[base + CORNER_OFFSETS[q]!]!;
            if (IS_NAN(v)) nan = true;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (nan || !FINITE(lo) || !FINITE(hi)) IV_UNKNOWN(iv, o);
          else IV_WIDEN(lo, hi, iv, o);
          break;
        }
        case I_RANGE: {
          const b = 2 * B[q]!, d = 2 * K3[q]!;
          IV_RANGE(iv[a]!, iv[a + 1]!, P0[q]!, P1[q]!, iv[b]!, iv[b + 1]!, iv[d]!, iv[d + 1]!, iv, o);
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
      run(MAIN, 0, count, ci, ck, cj, false);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
    cellIntervalCorners: (ci, ck, cj, out, k) => {
      run(MAIN, cellCount, count, ci, ck, cj, true);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
    nodeInterval: (ci, ck, cj, node, out, k) => {
      run(MAIN, 0, endIn[node]!, ci, ck, cj, false);
      run(MAIN, cellCount, endOut[node]!, ci, ck, cj, false);
      out[k] = iv[2 * node]!;
      out[k + 1] = iv[2 * node + 1]!;
    },
    minSkip,
    cellMinSkips,
    minSkipCounts,
    airWitness: nW > 0 ? witnesses[0]! : -1,
    airWitnesses: Object.freeze([...witnesses]),
    cellDecide: (ci, ck, cj, out, k) => {
      if (nW > 0 && witnessAir(ci, ck, cj)) {
        airWitnessCount[0]++;
        let hi = -Infinity;
        for (let w = 0; w < nW; w++) { const h = iv[2 * witnesses[w]! + 1]!; if (h > hi) hi = h; }
        out[k] = -Infinity;
        out[k + 1] = hi;
        return;
      }
      run(MAIN, 0, count, ci, ck, cj, false);
      out[k] = iv[2 * root]!;
      out[k + 1] = iv[2 * root + 1]!;
    },
    airWitnessCount,
  };
}

const IV = new Float64Array(2);

/**
 * Fills column (s.cx, s.cz)'s solidity with early-outs (SP3b spec §2.4, §4): runs `columnFn` and `positionFn` of
 * `b.compiled` on `s`, then the 48 cell layers bottom up, polling `stop()` before every 8 layers (6 polls); on true it
 * returns false at once (the outputs are then partial). `solid[((y + 64)·16 + lz)·16 + lx]` (98,304 entries, the T
 * stage's section order) becomes 1 where the density is > 0, else 0. A non-null `mask` is cleared, then set to 1 at
 * each voxel `voxelFn` evaluated; a non-null `values` receives those voxels' values (its other entries are left as they
 * were). A non-null `cells` (768 entries, cell `(ck·4 + cj)·4 + ci`) is cleared, then set to 1 at each cell the root's
 * interval did not decide before its corners: its corners were evaluated (a tree with `interpolated`) or, without
 * slots, its voxels were (SP6a spec §3.2: a cell left 0 was decided solid or air by its interval alone). Nothing is
 * allocated.
 */
export function fillDensityColumn(
  b: DensityBounds, s: ColumnSample, solid: Uint8Array, values: Float64Array | null, mask: Uint8Array | null,
  stop: () => boolean, cells: Uint8Array | null = null,
): boolean {
  const c = b.compiled;
  c.columnFn(s);
  c.positionFn(s);
  b.beginColumn();
  if (mask !== null) mask.fill(0);
  if (cells !== null) cells.fill(0);
  const corners = c.interpolatedSlotCount > 0;
  for (let ck = 0; ck < 48; ck++) {
    if ((ck & 7) === 0 && stop()) return false;
    const y0 = CORNER_Y(ck);
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        b.cellDecide(ci, ck, cj, IV, 0);
        let fill = IV[1]! < 0 ? 0 : IV[0]! > 0 ? 1 : -1;
        if (fill < 0 && cells !== null) cells[(ck * 4 + cj) * 4 + ci] = 1;
        if (fill < 0 && corners) {
          c.cellCorners(ci, ck, cj);
          b.cellIntervalCorners(ci, ck, cj, IV, 0);
          fill = IV[1]! < 0 ? 0 : IV[0]! > 0 ? 1 : -1;
        }
        if (fill < 0) b.cellMinSkips(ci, ck, cj);
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

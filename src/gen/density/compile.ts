/**
 * The density compiler (SP3b spec §2.1): validation, ref resolution, placement-keyed CSE, classification and closure
 * emission over typed scratch arrays (no `new Function`, no `eval`). The compiled closures equal the reference
 * interpreter (reference.ts) bit for bit: they use the same per-op expressions (nodes.ts) in the same order, the same
 * reads per placement and the same `trilerp`.
 *
 * Nodes. After ref resolution, equal sub-trees are one node per placement: the CSE key is the node's structure (op,
 * scalar fields with −0 ≠ +0, tap names, its children's nodes) plus the inside-`interpolated` flag. Each node has a
 * class (COLUMN < CELL < VOXEL; `y`, `slide`, `noise` and `noiseScaled` are CELL inside `interpolated` and VOXEL
 * outside; an `interpolated` node is VOXEL) and is evaluated by one of four closures:
 * - `columnFn(s)`: the COLUMN nodes inside `interpolated` that a non-COLUMN node reads (column slots), at the 5 × 5
 *   corner columns: `col` is the lattice value, `noise2` z2 at the corner column's (x, z);
 * - `positionFn(s)`: the COLUMN nodes outside `interpolated` that a non-COLUMN node reads (position slots), and COLUMN
 *   taps, at the 16 × 16 block positions: `col` is `readField`'s bilinear readout, `noise2` z2 at the position;
 * - `cornerFn(i, k, j)`: the children of every `interpolated` node (interpolated slots) at one corner, cached per
 *   column;
 * - `voxelFn(lx, y, lz)`: the root at one voxel (an `interpolated` node is the trilinear interpolation of its slot's
 *   corner values).
 * A `const` never takes a slot: its readers use the value. Within one point (a corner column, a position, a corner or
 * a voxel) a node read more than once is evaluated once (an epoch-stamped memo), and so is every tap reachable from the
 * root, whatever its readers, so that `tapReader` reads it again for nothing; a `rangeChoice` evaluates only its
 * chosen branch, so a VOXEL or CELL branch costs nothing when not chosen (COLUMN slots are filled eagerly).
 *
 * Tap readers (SP6a spec §3.2). `tapReader(name)` is resolved once per compile and reads the tap at the voxel registers
 * of the last `voxelFn` or `atVoxel` call (`atVoxel` sets them without evaluating anything): a tap outside `interpolated`
 * returns its node's memoised value, evaluating it once if the point is new (no Map lookup, no epoch bump); a tap inside
 * evaluates its 8 corners as `tapFn` does (one epoch each), interpolates them, and sets the voxel registers again (a
 * fresh epoch, so the reads that follow stay exact; SP6a ruling P14).
 *
 * Min chains (SP6a spec §1.6 lever (4)). A `min` outside `interpolated` that is not COLUMN starts a chain, which takes in
 * every such `min` child read only by it (no other reader, no tap); the chain's operands are its other children, left to
 * right. A `min` returns the leftmost operand at the minimum value (`vb < va ? vb : va` keeps `a` on a tie), so an
 * operand whose value is above another operand's at every voxel of a cell is never the result there, and dropping it
 * keeps the chain's value bit for bit (NaN aside: the bounds skip nothing over an unknown interval). The bounds decide
 * per cell which children of each chain `min` are not needed (`minSkips`, valid where `minSkipReady`, cleared by
 * `columnFn`); the chain's `min` then returns its other child at that cell's voxels without evaluating the skipped one.
 * A chain's inner `min` may lose its own minimum, but only its chain reads it; the chain's root value is kept, so every
 * reader (the root, a tap reader, another chain) sees the same value with or without the skips.
 *
 * The plane cache (SP6a ruling R13, output-keeping). `trilerp` lerps along x, then z, then y, so its lower and upper
 * z-lerps depend only on the voxel's (lx, lz) in its cell: an `interpolated` node keeps them per voxel column of the
 * cell it is read in (16 pairs per slot) and does only the y-lerp per voxel, the same operations in the same order, so
 * the same double. The kept pairs belong to one cell visit: entering another cell (`setVoxel`), a new column and a newly
 * computed corner each start a new one.
 *
 * Scratch. One CompiledDensity owns the scratch of one column (its slot values, its corner cache and its point
 * registers); compile again for an independent one. Nothing is allocated per column, corner or voxel.
 */
import { latticeIndex, readField, type ColumnSample } from '../column/columnStage';
import {
  EXPR_CHILD_KEYS, ExprValidationError, validateExpr,
  type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type ExprOp, type InterpolatedExpr, type SlideKnot,
} from './expr';
import { cornerY, joinClass, ownClass, slideAt, trilerp, type DensityClass } from './nodes';
import { findTap } from './reference';

const LATTICE = latticeIndex;
const READ_FIELD = readField;
const CHILD_KEYS = EXPR_CHILD_KEYS;
const INVALID = ExprValidationError;
const VALIDATE = validateExpr;
const CORNER_Y = cornerY;
const JOIN = joinClass;
const OWN = ownClass;
const SLIDE_AT = slideAt;
const TRILERP = trilerp;
const FIND_TAP = findTap;

/** One node of the compiled DAG (after ref resolution and CSE). */
export interface DensityNode {
  readonly op: Exclude<ExprOp, 'ref'>;
  /** A source node with this structure (the first one met): its scalar fields (v, field, id, s, lo, hi, knots, name). */
  readonly expr: Expr;
  /** Inside an `interpolated` (evaluated at corners) or not (at voxels and positions). */
  readonly inside: boolean;
  readonly cls: DensityClass;
  /** Child node indices in evaluation order (EXPR_CHILD_KEYS). */
  readonly kids: readonly number[];
  /** ≥ 0: a column slot, `colValues[colValueIndex(slot, i, j)]` after columnFn; else −1. */
  readonly colSlot: number;
  /** ≥ 0: a position slot, `posValues[posValueIndex(slot, lx, lz)]` after positionFn; else −1. */
  readonly posSlot: number;
  /** ≥ 0 on an `interpolated` node: its child's corner values, `cornerValues[cornerValueIndex(slot, i, k, j)]`; else −1. */
  readonly interpSlot: number;
  /** ≥ 0 on a `min` of a min chain (SP6a spec §1.6 lever (4)): its entry in each cell's `minSkips`; else −1. */
  readonly minSlot: number;
}

/** One min chain (SP6a spec §1.6 lever (4)): a `min` and the `min` children only it reads, recursively. */
export interface MinChain {
  /** The chain's `min` nodes in node order (children before parents); the last is the chain's root. */
  readonly mins: readonly number[];
  /** The chain's operands (its `min` nodes' other children), left to right. */
  readonly operands: readonly number[];
}

/** A compiled density expression with the scratch of one column. */
export interface CompiledDensity {
  /** The validated source expression. */
  readonly expr: DensityExpr;
  /** The DAG reachable from the root, children before parents. */
  readonly nodes: readonly DensityNode[];
  /** The root's node index. */
  readonly root: number;
  readonly columnSlotCount: number;
  readonly positionSlotCount: number;
  readonly interpolatedSlotCount: number;
  /** Column slot values, `colValueIndex(slot, i, j)` (i, j ∈ 0 … 4). */
  readonly colValues: Float64Array;
  /** Position slot values, `posValueIndex(slot, lx, lz)` (lx, lz ∈ 0 … 15). */
  readonly posValues: Float64Array;
  /** Corner values of each interpolated slot, `cornerValueIndex(slot, i, k, j)` (k ∈ 0 … 48); valid where cornerReady. */
  readonly cornerValues: Float64Array;
  /** 1 where corner `(k·5 + j)·5 + i` holds every interpolated slot's value for the current column. */
  readonly cornerReady: Uint8Array;
  /** The min chains (SP6a spec §1.6 lever (4)), in the order of their roots. */
  readonly minChains: readonly MinChain[];
  /** The number of chain `min` nodes (each node's `minSlot` is below it). */
  readonly minSlotCount: number;
  /**
   * Per cell `(ck·4 + cj)·4 + ci` and chain `min` slot, `minSkips[cell·minSlotCount + minSlot]`: bit 0 set when the
   * `min`'s child `a` is not needed at the cell's voxels, bit 1 for `b` (never both on a chain's root). Written by the
   * bounds (`cellMinSkips`); read by `voxelFn` (and the tap readers) only where `minSkipReady` is 1.
   */
  readonly minSkips: Uint8Array;
  /** 1 where cell `(ck·4 + cj)·4 + ci` holds its `minSkips` for the current column; cleared by `columnFn`. */
  readonly minSkipReady: Uint8Array;
  /**
   * Starts column (s.cx, s.cz): clears the corner cache and fills the column slots from `s`'s lattice. Must precede
   * positionFn, cornerFn, voxelFn and tapFn for that column.
   */
  columnFn(s: ColumnSample): void;
  /** Fills the position slots from `s` (bilinear `col`). Throws unless columnFn ran last for the same (cx, cz). */
  positionFn(s: ColumnSample): void;
  /** columnFn ran for (cx, cz) and no other column since. */
  hasColumn(cx: number, cz: number): boolean;
  /** positionFn ran for (cx, cz) and no other column since. */
  hasPositions(cx: number, cz: number): boolean;
  /** Evaluates every interpolated slot at corner (i, k, j) unless the column's cache has it. Integers, unchecked. */
  cornerFn(i: number, k: number, j: number): void;
  /** cornerFn for the 8 corners of cell (ci, ck, cj) (ci, cj ∈ 0 … 3, ck ∈ 0 … 47), remembered per cell. */
  cellCorners(ci: number, ck: number, cj: number): void;
  /** The root at voxel (lx, y, lz) of the current column (lx, lz ∈ 0 … 15, y ∈ −64 … 319, integers, unchecked). */
  voxelFn(lx: number, y: number, lz: number): number;
  /**
   * The tap `name` at a voxel, as `DensityReference.tap`: its child at the voxel when its first occurrence is outside
   * `interpolated`, else its child's corner values interpolated (computed for the call, not cached). Throws when no tap
   * of that name is reachable from the root.
   */
  tapFn(name: string, lx: number, y: number, lz: number): number;
  /** The interpolated slot of a source `interpolated` node reachable from the root (by identity), else −1. */
  interpolatedSlot(e: InterpolatedExpr): number;
  /**
   * Sets the voxel registers to (lx, y, lz) of the current column (as `voxelFn` does before the root) and starts a new
   * point (one epoch bump); evaluates nothing. The cell's corners must be ready (`cellCorners`) when a tap read next
   * needs them. Integers, unchecked.
   */
  atVoxel(lx: number, y: number, lz: number): void;
  /** The options it was compiled with, every one given (SP6a ruling R13). */
  readonly options: Required<CompileOptions>;
  /**
   * The reader of tap `name` (SP6a spec §3.2), or null when no tap of that name is reachable from the root; resolved
   * once per compile (the same function on every call). It reads the tap at the voxel registers of the last `voxelFn`
   * or `atVoxel` call, with `tapFn`'s value there: outside `interpolated` its node's memoised value (evaluated once if
   * the point is new; no Map lookup, no epoch bump), inside the trilinear interpolation of its 8 corner values, after
   * which the voxel registers are set again (a new point).
   */
  tapReader(name: string): (() => number) | null;
}

/**
 * Switches of the output-keeping speedups (SP6a ruling R13), each on by default; off, the closures compute the same
 * values the plain way (the bit-exactness tests compare both).
 */
export interface CompileOptions {
  /** The plane cache of `interpolated` nodes (the module header). */
  readonly planes?: boolean;
}

/** Every option on. */
const ALL_ON: Required<CompileOptions> = Object.freeze({ planes: true });

/** Index of column slot `slot` at corner column (i, j) in `colValues`. */
export function colValueIndex(slot: number, i: number, j: number): number { return slot * 25 + j * 5 + i; }
/** Index of position slot `slot` at position (lx, lz) in `posValues`. */
export function posValueIndex(slot: number, lx: number, lz: number): number { return slot * 256 + lz * 16 + lx; }
/** Index of interpolated slot `slot` at corner (i, k, j) in `cornerValues`. */
export function cornerValueIndex(slot: number, i: number, k: number, j: number): number { return slot * 1225 + (k * 5 + j) * 5 + i; }

type Thunk = () => number;

interface Building {
  op: Exclude<ExprOp, 'ref'>;
  expr: Expr;
  inside: boolean;
  cls: DensityClass;
  kids: number[];
  colSlot: number;
  posSlot: number;
  interpSlot: number;
  minSlot: number;
}

/** A number's CSE key: exact (shortest round-trip form), with −0 apart from +0. */
function numKey(v: number): string {
  return Object.is(v, -0) ? '-0' : String(v);
}

function scalarKey(e: Expr): string {
  switch (e.op) {
    case 'const': return numKey(e.v);
    case 'col': return e.field;
    case 'noise2': case 'noise': return JSON.stringify(e.id);
    // id and s: noiseScaled nodes differing only in s are two nodes (and the op in the key keeps them apart from noise).
    case 'noiseScaled': return `${JSON.stringify(e.id)},${numKey(e.s)}`;
    case 'clamp': case 'rangeChoice': return `${numKey(e.lo)},${numKey(e.hi)}`;
    case 'slide': return e.knots.map(([y, v]) => `${numKey(y)}:${numKey(v)}`).join(',');
    case 'tap': return JSON.stringify(e.name);
    default: return '';
  }
}

/**
 * Validates `expr` against `noises` (throws ExprValidationError listing every issue) and compiles it (SP3b spec §2.1);
 * `options` switches the output-keeping speedups (all on by default).
 */
export function compileDensity(expr: DensityExpr, noises: DensityNoiseSource, options: CompileOptions = ALL_ON): CompiledDensity {
  const opts: Required<CompileOptions> = Object.freeze({ ...ALL_ON, ...options });
  const issues = VALIDATE(expr, noises);
  if (issues.length > 0) throw new INVALID(issues);
  const defs = expr.defs;
  const noise = (id: string): DensityNoise => {
    const n = noises(id);
    if (n === undefined) throw new Error(`unknown density noise ${id}`);
    return n;
  };

  // ---- 1. Ref resolution and placement-keyed CSE (post-order: children before parents). ----
  const nodes: Building[] = [];
  const byKey = new Map<string, number>();
  const bySource = [new Map<Expr, number>(), new Map<Expr, number>()];
  const build = (e: Expr, inside: boolean): number => {
    const seen = bySource[inside ? 1 : 0]!;
    const hit = seen.get(e);
    if (hit !== undefined) return hit;
    let id: number;
    if (e.op === 'ref') id = build(defs[e.name]!, inside);
    else {
      const rec = e as unknown as Record<string, Expr>;
      const kidInside = inside || e.op === 'interpolated';
      const kids = CHILD_KEYS[e.op].map((k) => build(rec[k]!, kidInside));
      const key = `${inside ? 1 : 0}|${e.op}|${scalarKey(e)}|${kids.join(',')}`;
      const old = byKey.get(key);
      if (old !== undefined) id = old;
      else {
        let cls = OWN(e.op, inside);
        for (const k of kids) {
          const kc = nodes[k]!.cls;
          // An interpolated node's children are inside it (CELL or COLUMN); the node itself is VOXEL.
          if (e.op !== 'interpolated') cls = JOIN(cls, kc);
        }
        id = nodes.length;
        nodes.push({ op: e.op, expr: e, inside, cls, kids, colSlot: -1, posSlot: -1, interpSlot: -1, minSlot: -1 });
        byKey.set(key, id);
      }
    }
    seen.set(e, id);
    return id;
  };
  const root = build(expr.root, false);

  // Taps: the first occurrence reachable from the root (evaluation order), as the reference reads them.
  const tapNodes = new Map<string, { node: number; inside: boolean }>();
  for (const n of nodes) {
    if (n.op !== 'tap') continue;
    const name = (n.expr as { name: string }).name;
    if (tapNodes.has(name)) continue;
    const found = FIND_TAP(expr, name);
    if (found === undefined) continue;
    tapNodes.set(name, { node: bySource[found.inside ? 1 : 0]!.get(found.node)!, inside: found.inside });
  }

  // ---- 2. Slots and call counts. ----
  let colSlots = 0, posSlots = 0, interpSlots = 0;
  const calls = new Int32Array(nodes.length);
  /** A COLUMN node read from outside its column closures takes a slot (a const never does). */
  const needSlot = (id: number): void => {
    const n = nodes[id]!;
    if (n.op === 'const') return;
    if (n.inside) { if (n.colSlot < 0) { n.colSlot = colSlots++; calls[id]++; } }
    else if (n.posSlot < 0) { n.posSlot = posSlots++; calls[id]++; }
  };
  /** How a non-COLUMN reader (or the root/tap/interpolated driver) reaches node `id`. */
  const readFromOutside = (id: number): void => {
    if (nodes[id]!.cls === 'column') needSlot(id);
    else calls[id]++;
  };
  for (const n of nodes) {
    if (n.op === 'interpolated') { n.interpSlot = interpSlots++; readFromOutside(n.kids[0]!); continue; }
    for (const k of n.kids) {
      if (n.cls !== 'column' && nodes[k]!.cls === 'column') needSlot(k);
      else calls[k]++;
    }
  }
  readFromOutside(root);
  /** The tap nodes a reader may name: memoised whatever their call count (a tap read once has one parent). */
  const tapIds = new Set<number>();
  for (const t of tapNodes.values()) {
    const n = nodes[t.node]!;
    if (n.cls === 'column') needSlot(t.node);
    tapIds.add(t.node);
  }

  // ---- Min chains (SP6a spec §1.6 lever (4)). ----
  /** A `min` evaluated at voxels: outside `interpolated` and not COLUMN. */
  const chainMin = (id: number): boolean => { const n = nodes[id]!; return n.op === 'min' && !n.inside && n.cls !== 'column'; };
  const parentOf = new Int32Array(nodes.length).fill(-1);
  for (let id = 0; id < nodes.length; id++) for (const k of nodes[id]!.kids) parentOf[k] = id;
  /** A chain `min` that only its parent `min` reads (one call, not the root, no tap): inside its parent's chain. */
  const inner = (id: number): boolean =>
    chainMin(id) && id !== root && calls[id] === 1 && !tapIds.has(id) && parentOf[id]! >= 0 && chainMin(parentOf[id]!);
  const minChains: MinChain[] = [];
  let minSlots = 0;
  for (let id = 0; id < nodes.length; id++) {
    if (!chainMin(id) || inner(id)) continue;
    const mins: number[] = [], operands: number[] = [];
    const visit = (m: number): void => {
      for (const k of nodes[m]!.kids) {
        if (inner(k)) visit(k);
        else operands.push(k);
      }
      mins.push(m);
    };
    visit(id);
    mins.sort((x, y) => x - y);
    for (const m of mins) nodes[m]!.minSlot = minSlots++;
    minChains.push(Object.freeze({ mins: Object.freeze(mins), operands: Object.freeze(operands) }));
  }

  // ---- 3. Scratch. ----
  const colValues = new Float64Array(colSlots * 25);
  const posValues = new Float64Array(posSlots * 256);
  const cornerValues = new Float64Array(interpSlots * 1225);
  const cornerReady = new Uint8Array(1225);
  const cellReady = new Uint8Array(768);
  const minSkips = new Uint8Array(768 * minSlots);
  const minSkipReady = new Uint8Array(768);
  const memoVal = new Float64Array(nodes.length);
  const memoStamp = new Float64Array(nodes.length);
  const tmp = new Float64Array(8);
  const tmpReader = new Float64Array(8);
  // The plane cache: per interpolated slot and voxel column (lz & 3)·4 + (lx & 3) of the current cell, the trilerp's
  // lower and upper z-lerps, valid where the entry's stamp is the current cell visit.
  const planeL = new Float64Array(interpSlots * 16);
  const planeU = new Float64Array(interpSlots * 16);
  const planeStamp = new Float64Array(interpSlots * 16);
  // Point registers: world (x, y, z); lat = lattice index and cc = j·5 + i of the corner column; p = lz·16 + lx; the
  // voxel's cell base index (k·5 + j)·5 + i and fractions; the memo epoch.
  let px = 0, py = 0, pz = 0, lat = 0, cc = 0, p = 0, cIdx = 0, tx = 0, ty = 0, tz = 0, epoch = 0;
  // The plane cache's registers: the voxel's column in its cell, (lz & 3)·4 + (lx & 3); the current cell visit and the
  // cell it is in.
  let q16 = 0, cellVisit = 1, visitCIdx = -1;
  // The voxel's cell's base in minSkips (cell·minSlots) where its skips are ready, else −1 (no skip).
  let skipBase = -1;
  // The voxel of the last setVoxel (voxelFn, atVoxel, tapFn outside), which an inside tap's reader sets again.
  let vlx = 0, vy = 0, vlz = 0;
  let sample: ColumnSample | null = null;
  let x0 = 0, z0 = 0, colCx = 0, colCz = 0, colSet = false, posSet = false;

  // ---- 4. Closures, children first. ----
  const thunks: Thunk[] = [];
  const slotReader = (id: number): Thunk => {
    const n = nodes[id]!;
    if (n.op === 'const') { const v = (n.expr as { v: number }).v; return () => v; }
    if (n.inside) { const base = n.colSlot * 25; return () => colValues[base + cc]!; }
    const base = n.posSlot * 256;
    return () => posValues[base + p]!;
  };
  /** The thunk a reader of class `readerCls` calls for child `id`. */
  const reader = (readerCls: DensityClass, id: number): Thunk =>
    (readerCls !== 'column' && nodes[id]!.cls === 'column' ? slotReader(id) : thunks[id]!);

  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id]!;
    const e = n.expr;
    const kid = (slot: number): Thunk => reader(n.cls, n.kids[slot]!);
    let f: Thunk;
    switch (e.op) {
      case 'const': { const v = e.v; f = () => v; break; }
      case 'y': f = () => py; break;
      case 'col': {
        const field = e.field;
        f = n.inside ? () => sample!.f[field][lat]! : () => READ_FIELD(sample!, field, px, pz);
        break;
      }
      case 'noise2': { const nz = noise(e.id); f = () => nz.z2(px, pz); break; }
      case 'noise': { const nz = noise(e.id); f = () => nz.z3(px, py, pz); break; }
      // One division per axis, x then y then z, as the reference (SP6a spec §1.5).
      case 'noiseScaled': { const nz = noise(e.id), sc = e.s; f = () => nz.z3(px / sc, py / sc, pz / sc); break; }
      case 'add': { const a = kid(0), b = kid(1); f = () => { const va = a(); return va + b(); }; break; }
      case 'mul': { const a = kid(0), b = kid(1); f = () => { const va = a(); return va * b(); }; break; }
      case 'min': {
        const a = kid(0), b = kid(1);
        if (n.minSlot < 0) { f = () => { const va = a(), vb = b(); return vb < va ? vb : va; }; break; }
        // A chain min (lever (4)): at a voxel whose cell has its skips, a child that cannot be the minimum is not read.
        const slot = n.minSlot;
        f = () => {
          if (skipBase >= 0) {
            const m = minSkips[skipBase + slot];
            if (m === 1) return b();
            if (m === 2) return a();
          }
          const va = a(), vb = b();
          return vb < va ? vb : va;
        };
        break;
      }
      case 'max': { const a = kid(0), b = kid(1); f = () => { const va = a(), vb = b(); return vb > va ? vb : va; }; break; }
      case 'neg': { const x = kid(0); f = () => -x(); break; }
      case 'abs': { const x = kid(0); f = () => Math.abs(x()); break; }
      case 'square': { const x = kid(0); f = () => { const v = x(); return v * v; }; break; }
      case 'clamp': {
        const x = kid(0), lo = e.lo, hi = e.hi;
        f = () => { const v = x(); return v < lo ? lo : v > hi ? hi : v; };
        break;
      }
      case 'slide': {
        // A thawed copy of the knots (the same doubles): element reads of the resolved tree's frozen arrays made the
        // corner kernel 17-28 % slower in V8 (SP3d final review).
        const x = kid(0), knots = e.knots.map((k): SlideKnot => [k[0], k[1]]);
        f = () => x() * SLIDE_AT(knots, py);
        break;
      }
      case 'interpolated': {
        const base = n.interpSlot * 1225;
        if (!opts.planes) {
          f = () => {
            const b = base + cIdx;
            return TRILERP(cornerValues[b]!, cornerValues[b + 1]!, cornerValues[b + 5]!, cornerValues[b + 6]!,
              cornerValues[b + 25]!, cornerValues[b + 26]!, cornerValues[b + 30]!, cornerValues[b + 31]!, tx, ty, tz);
          };
          break;
        }
        // trilerp (nodes.ts: lerp(a, b, t) = a + t·(b − a)) in two steps: the x- and z-lerps of the lower and upper
        // layers, kept per cell visit, then the y-lerp.
        const pb = n.interpSlot * 16;
        f = () => {
          const e = pb + q16;
          if (planeStamp[e] !== cellVisit) {
            const b = base + cIdx;
            const c000 = cornerValues[b]!, c100 = cornerValues[b + 1]!, c001 = cornerValues[b + 5]!, c101 = cornerValues[b + 6]!;
            const c010 = cornerValues[b + 25]!, c110 = cornerValues[b + 26]!, c011 = cornerValues[b + 30]!, c111 = cornerValues[b + 31]!;
            const e00 = c000 + tx * (c100 - c000), e01 = c001 + tx * (c101 - c001);
            const e10 = c010 + tx * (c110 - c010), e11 = c011 + tx * (c111 - c011);
            planeL[e] = e00 + tz * (e01 - e00);
            planeU[e] = e10 + tz * (e11 - e10);
            planeStamp[e] = cellVisit;
          }
          const l = planeL[e]!;
          return l + ty * (planeU[e]! - l);
        };
        break;
      }
      case 'rangeChoice': {
        const x = kid(0), inside = kid(1), outside = kid(2), lo = e.lo, hi = e.hi;
        f = () => { const v = x(); return lo <= v && v < hi ? inside() : outside(); };
        break;
      }
      case 'tap': { const x = kid(0); f = () => x(); break; }
      case 'ref': throw new Error('unreachable: refs are resolved');
    }
    if (calls[id]! > 1 || tapIds.has(id)) {
      const raw = f;
      f = () => {
        if (memoStamp[id] === epoch) return memoVal[id]!;
        const v = raw();
        memoVal[id] = v;
        memoStamp[id] = epoch;
        return v;
      };
    }
    thunks.push(f);
  }

  const colOut: Array<{ at: number; f: Thunk }> = [];
  const posOut: Array<{ at: number; f: Thunk }> = [];
  const cornerOut: Array<{ at: number; f: Thunk }> = [];
  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id]!;
    if (n.colSlot >= 0) colOut.push({ at: n.colSlot * 25, f: thunks[id]! });
    if (n.posSlot >= 0) posOut.push({ at: n.posSlot * 256, f: thunks[id]! });
    if (n.interpSlot >= 0) cornerOut.push({ at: n.interpSlot * 1225, f: reader('cell', n.kids[0]!) });
  }
  const rootFn = reader('voxel', root);
  const tapFns = new Map<string, { inside: boolean; f: Thunk }>();
  for (const [name, t] of tapNodes) tapFns.set(name, { inside: t.inside, f: reader(t.inside ? 'cell' : 'voxel', t.node) });
  const nCol = colOut.length, nPos = posOut.length, nCorner = cornerOut.length;

  const columnFn = (s: ColumnSample): void => {
    sample = s;
    colCx = s.cx;
    colCz = s.cz;
    x0 = 16 * s.cx;
    z0 = 16 * s.cz;
    colSet = true;
    posSet = false;
    cornerReady.fill(0);
    cellReady.fill(0);
    minSkipReady.fill(0);
    visitCIdx = -1;
    for (let j = 0; j <= 4; j++) {
      for (let i = 0; i <= 4; i++) {
        px = x0 + 4 * i;
        pz = z0 + 4 * j;
        lat = LATTICE(i, j);
        cc = j * 5 + i;
        epoch++;
        for (let o = 0; o < nCol; o++) { const out = colOut[o]!; colValues[out.at + cc] = out.f(); }
      }
    }
    sample = null;
  };

  const positionFn = (s: ColumnSample): void => {
    if (!colSet || s.cx !== colCx || s.cz !== colCz) throw new Error(`positionFn(${s.cx}, ${s.cz}) needs columnFn for that column first`);
    sample = s;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        px = x0 + lx;
        pz = z0 + lz;
        p = lz * 16 + lx;
        epoch++;
        for (let o = 0; o < nPos; o++) { const out = posOut[o]!; posValues[out.at + p] = out.f(); }
      }
    }
    sample = null;
    posSet = true;
  };

  const cornerFn = (i: number, k: number, j: number): void => {
    const idx = (k * 5 + j) * 5 + i;
    if (cornerReady[idx] === 1) return;
    cc = j * 5 + i;
    px = x0 + 4 * i;
    py = CORNER_Y(k);
    pz = z0 + 4 * j;
    epoch++;
    for (let o = 0; o < nCorner; o++) { const out = cornerOut[o]!; cornerValues[out.at + idx] = out.f(); }
    cornerReady[idx] = 1;
    // New corner values: no plane kept before them is read again.
    cellVisit++;
  };

  const cellCorners = (ci: number, ck: number, cj: number): void => {
    const cell = (ck * 4 + cj) * 4 + ci;
    if (cellReady[cell] === 1) return;
    cornerFn(ci, ck, cj); cornerFn(ci + 1, ck, cj); cornerFn(ci, ck, cj + 1); cornerFn(ci + 1, ck, cj + 1);
    cornerFn(ci, ck + 1, cj); cornerFn(ci + 1, ck + 1, cj); cornerFn(ci, ck + 1, cj + 1); cornerFn(ci + 1, ck + 1, cj + 1);
    cellReady[cell] = 1;
  };

  /** Sets the voxel registers (after any corner work, which overwrites them). Fractions as nodes.ts fracXZ/fracY. */
  const setVoxel = (lx: number, y: number, lz: number): void => {
    const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
    vlx = lx;
    vy = y;
    vlz = lz;
    px = x0 + lx;
    py = y;
    pz = z0 + lz;
    p = lz * 16 + lx;
    cIdx = (ck * 5 + cj) * 5 + ci;
    tx = (lx - 4 * ci) / 4;
    ty = (y + 64 - 8 * ck) / 8;
    tz = (lz - 4 * cj) / 4;
    q16 = (lz & 3) * 4 + (lx & 3);
    if (cIdx !== visitCIdx) {
      visitCIdx = cIdx;
      cellVisit++;
    }
    if (minSlots > 0) {
      const cell = (ck * 4 + cj) * 4 + ci;
      skipBase = minSkipReady[cell] === 1 ? cell * minSlots : -1;
    }
    epoch++;
  };

  const voxelFn = (lx: number, y: number, lz: number): number => {
    if (nCorner > 0) cellCorners(lx >> 2, (y + 64) >> 3, lz >> 2);
    setVoxel(lx, y, lz);
    return rootFn();
  };

  const tapFn = (name: string, lx: number, y: number, lz: number): number => {
    const t = tapFns.get(name);
    if (t === undefined) throw new Error(`no tap ${JSON.stringify(name)} reachable from the root`);
    const f = t.f;
    if (!t.inside) {
      if (nCorner > 0) cellCorners(lx >> 2, (y + 64) >> 3, lz >> 2);
      setVoxel(lx, y, lz);
      return f();
    }
    // Inside interpolated: the tap's corner values at the voxel's cell, interpolated as an `interpolated` would.
    const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
    for (let c = 0; c < 8; c++) {
      const i = ci + (c & 1), j = cj + ((c >> 1) & 1), k = ck + (c >> 2);
      cc = j * 5 + i;
      px = x0 + 4 * i;
      py = CORNER_Y(k);
      pz = z0 + 4 * j;
      epoch++;
      tmp[c] = f();
    }
    return TRILERP(tmp[0]!, tmp[1]!, tmp[2]!, tmp[3]!, tmp[4]!, tmp[5]!, tmp[6]!, tmp[7]!,
      (lx - 4 * ci) / 4, (y + 64 - 8 * ck) / 8, (lz - 4 * cj) / 4);
  };

  // Tap readers, resolved once (SP6a spec §3.2; ruling P14 for a tap inside interpolated).
  const tapReaders = new Map<string, Thunk>();
  for (const [name, t] of tapFns) {
    const f = t.f;
    if (!t.inside) { tapReaders.set(name, f); continue; }
    tapReaders.set(name, () => {
      const lx = vlx, y = vy, lz = vlz;
      const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
      for (let c = 0; c < 8; c++) {
        const i = ci + (c & 1), j = cj + ((c >> 1) & 1), k = ck + (c >> 2);
        cc = j * 5 + i;
        px = x0 + 4 * i;
        py = CORNER_Y(k);
        pz = z0 + 4 * j;
        epoch++;
        tmpReader[c] = f();
      }
      const v = TRILERP(tmpReader[0]!, tmpReader[1]!, tmpReader[2]!, tmpReader[3]!, tmpReader[4]!, tmpReader[5]!, tmpReader[6]!,
        tmpReader[7]!, (lx - 4 * ci) / 4, (y + 64 - 8 * ck) / 8, (lz - 4 * cj) / 4);
      setVoxel(lx, y, lz);
      return v;
    });
  }

  const interpBySource = new Map<Expr, number>();
  for (const [src, id] of bySource[0]!) if (src.op === 'interpolated') interpBySource.set(src, nodes[id]!.interpSlot);

  return {
    expr,
    nodes,
    root,
    columnSlotCount: colSlots,
    positionSlotCount: posSlots,
    interpolatedSlotCount: interpSlots,
    colValues,
    posValues,
    cornerValues,
    cornerReady,
    minChains: Object.freeze(minChains),
    minSlotCount: minSlots,
    minSkips,
    minSkipReady,
    columnFn,
    positionFn,
    hasColumn: (cx, cz) => colSet && cx === colCx && cz === colCz,
    hasPositions: (cx, cz) => posSet && cx === colCx && cz === colCz,
    cornerFn,
    cellCorners,
    voxelFn,
    tapFn,
    interpolatedSlot: (e) => interpBySource.get(e) ?? -1,
    atVoxel: setVoxel,
    tapReader: (name) => tapReaders.get(name) ?? null,
    options: opts,
  };
}

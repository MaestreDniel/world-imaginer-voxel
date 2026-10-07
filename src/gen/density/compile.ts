/**
 * The density compiler (SP3b spec §2.1): validation, ref resolution, placement-keyed CSE, classification and closure
 * emission over typed scratch arrays (no `new Function`, no `eval`). The compiled closures equal the reference
 * interpreter (reference.ts) bit for bit: they use the same per-op expressions (nodes.ts) in the same order, the same
 * reads per placement and the same `trilerp`.
 *
 * Nodes. After ref resolution, equal sub-trees are one node per placement: the CSE key is the node's structure (op,
 * scalar fields with −0 ≠ +0, tap names, its children's nodes) plus the inside-`interpolated` flag. Each node has a
 * class (COLUMN < CELL < VOXEL; `y`, `slide` and `noise` are CELL inside `interpolated` and VOXEL outside; an
 * `interpolated` node is VOXEL) and is evaluated by one of four closures:
 * - `columnFn(s)`: the COLUMN nodes inside `interpolated` that a non-COLUMN node reads (column slots), at the 5 × 5
 *   corner columns: `col` is the lattice value, `noise2` z2 at the corner column's (x, z);
 * - `positionFn(s)`: the COLUMN nodes outside `interpolated` that a non-COLUMN node reads (position slots), and COLUMN
 *   taps, at the 16 × 16 block positions: `col` is `readField`'s bilinear readout, `noise2` z2 at the position;
 * - `cornerFn(i, k, j)`: the children of every `interpolated` node (interpolated slots) at one corner, cached per
 *   column;
 * - `voxelFn(lx, y, lz)`: the root at one voxel (an `interpolated` node is the trilinear interpolation of its slot's
 *   corner values).
 * A `const` never takes a slot: its readers use the value. Within one point (a corner column, a position, a corner or
 * a voxel) a node read more than once is evaluated once (an epoch-stamped memo); a `rangeChoice` evaluates only its
 * chosen branch, so a VOXEL or CELL branch costs nothing when not chosen (COLUMN slots are filled eagerly).
 *
 * Scratch. One CompiledDensity owns the scratch of one column (its slot values, its corner cache and its point
 * registers); compile again for an independent one. Nothing is allocated per column, corner or voxel.
 */
import { latticeIndex, readField, type ColumnSample } from '../column/columnStage';
import {
  EXPR_CHILD_KEYS, ExprValidationError, validateExpr,
  type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type ExprOp, type InterpolatedExpr,
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
  /** A source node with this structure (the first one met): its scalar fields (v, field, id, lo, hi, knots, name). */
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
}

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
    case 'clamp': case 'rangeChoice': return `${numKey(e.lo)},${numKey(e.hi)}`;
    case 'slide': return e.knots.map(([y, v]) => `${numKey(y)}:${numKey(v)}`).join(',');
    case 'tap': return JSON.stringify(e.name);
    default: return '';
  }
}

/**
 * Validates `expr` against `noises` (throws ExprValidationError listing every issue) and compiles it (SP3b spec §2.1).
 */
export function compileDensity(expr: DensityExpr, noises: DensityNoiseSource): CompiledDensity {
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
        nodes.push({ op: e.op, expr: e, inside, cls, kids, colSlot: -1, posSlot: -1, interpSlot: -1 });
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
  for (const t of tapNodes.values()) {
    const n = nodes[t.node]!;
    if (n.cls === 'column') needSlot(t.node);
  }

  // ---- 3. Scratch. ----
  const colValues = new Float64Array(colSlots * 25);
  const posValues = new Float64Array(posSlots * 256);
  const cornerValues = new Float64Array(interpSlots * 1225);
  const cornerReady = new Uint8Array(1225);
  const cellReady = new Uint8Array(768);
  const memoVal = new Float64Array(nodes.length);
  const memoStamp = new Float64Array(nodes.length);
  const tmp = new Float64Array(8);
  // Point registers: world (x, y, z); lat = lattice index and cc = j·5 + i of the corner column; p = lz·16 + lx; the
  // voxel's cell base index (k·5 + j)·5 + i and fractions; the memo epoch.
  let px = 0, py = 0, pz = 0, lat = 0, cc = 0, p = 0, cIdx = 0, tx = 0, ty = 0, tz = 0, epoch = 0;
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
      case 'add': { const a = kid(0), b = kid(1); f = () => { const va = a(); return va + b(); }; break; }
      case 'mul': { const a = kid(0), b = kid(1); f = () => { const va = a(); return va * b(); }; break; }
      case 'min': { const a = kid(0), b = kid(1); f = () => { const va = a(), vb = b(); return vb < va ? vb : va; }; break; }
      case 'max': { const a = kid(0), b = kid(1); f = () => { const va = a(), vb = b(); return vb > va ? vb : va; }; break; }
      case 'neg': { const x = kid(0); f = () => -x(); break; }
      case 'abs': { const x = kid(0); f = () => Math.abs(x()); break; }
      case 'square': { const x = kid(0); f = () => { const v = x(); return v * v; }; break; }
      case 'clamp': {
        const x = kid(0), lo = e.lo, hi = e.hi;
        f = () => { const v = x(); return v < lo ? lo : v > hi ? hi : v; };
        break;
      }
      case 'slide': { const x = kid(0), knots = e.knots; f = () => x() * SLIDE_AT(knots, py); break; }
      case 'interpolated': {
        const base = n.interpSlot * 1225;
        f = () => {
          const b = base + cIdx;
          return TRILERP(cornerValues[b]!, cornerValues[b + 1]!, cornerValues[b + 5]!, cornerValues[b + 6]!,
            cornerValues[b + 25]!, cornerValues[b + 26]!, cornerValues[b + 30]!, cornerValues[b + 31]!, tx, ty, tz);
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
    if (calls[id]! > 1) {
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
    px = x0 + lx;
    py = y;
    pz = z0 + lz;
    p = lz * 16 + lx;
    cIdx = (ck * 5 + cj) * 5 + ci;
    tx = (lx - 4 * ci) / 4;
    ty = (y + 64 - 8 * ck) / 8;
    tz = (lz - 4 * cj) / 4;
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
    columnFn,
    positionFn,
    hasColumn: (cx, cz) => colSet && cx === colCx && cz === colCz,
    hasPositions: (cx, cz) => posSet && cx === colCx && cz === colCz,
    cornerFn,
    cellCorners,
    voxelFn,
    tapFn,
    interpolatedSlot: (e) => interpBySource.get(e) ?? -1,
  };
}

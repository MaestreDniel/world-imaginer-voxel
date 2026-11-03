/**
 * The reference interpreter (SP3b spec §2.3): evaluates a density expression at one voxel (or one corner) by walking
 * the tree, with the compiler's placement rules and the §2.2 interpolation, recomputing everything per call. It is the
 * oracle the compiled closures must equal bit for bit (DT2 `compiledReference`, the compile fuzz).
 *
 * Placement (§2.1, §2.2):
 * - outside `interpolated` (voxel level), `y` is the voxel's y, `col` is the ColumnSample's bilinear readout at the
 *   voxel's (x, z) (`readField`), `noise2` is z2(x, z), `noise` z3(x, y, z) and `noiseScaled` z3(x / s, y / s, z / s)
 *   (one division per axis, in that order) at the voxel;
 * - an `interpolated` node evaluates its child at the 8 corners of the voxel's cell and interpolates them (`trilerp`);
 * - at a corner (i, k, j), `y` is −64 + 8k, `col` is the lattice value `latticeIndex(i, j)` exactly, and the noises
 *   sample the corner's world coordinates (16cx + 4i, −64 + 8k, 16cz + 4j).
 * A COLUMN sub-tree read at voxel level depends on nothing but `const`, `col` and `noise2`, so walking it with the
 * voxel's reads is its `positionFn` value at the voxel's position; a COLUMN or CELL sub-tree inside `interpolated` is
 * walked with the corner's reads (its `columnFn` / `cornerFn` value). The walk therefore needs no class pass.
 *
 * Noises are injected (`DensityNoiseSource`), so the reference runs on schema noises and on test noises alike.
 *
 * The corner memo (SP6a spec §7.4): `voxel` and `corner` take an optional `CornerMemo`, which keeps every corner value
 * computed through it, per (interpolated node, column, corner) and per (def, column, corner): an `interpolated` child
 * is evaluated once per corner of a column, and every `ref` to a def at a corner once, however many samples and nodes
 * read it (a def read at voxel placement is walked per read, as without a memo). The values are pure functions of the
 * column's lattice and the corner's world coordinates, so a memoised evaluation is bit-identical to a plain one; the
 * slice job keeps one memo per part (`gen/inspect/fieldSlice.ts`), and the DT2 oracle calls the reference without one.
 */
import { latticeIndex, readField, type ColumnSample } from '../column/columnStage';
import { EXPR_CHILD_KEYS, exprChildren, ExprValidationError, validateExpr, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type InterpolatedExpr, type SlideExpr, type SlideKnot, type TapExpr } from './expr';
import { cellXZ, cellY, cornerY, evalNode, fracXZ, fracY, trilerp, type DelegatedExpr, type NodeEnv } from './nodes';

const LATTICE = latticeIndex;
const READ_FIELD = readField;
const VALIDATE = validateExpr;
const INVALID = ExprValidationError;
const CHILD_KEYS = EXPR_CHILD_KEYS;
const EVAL = evalNode;
const CHILDREN = exprChildren;
const CELL_XZ = cellXZ;
const CELL_Y = cellY;
const FRAC_XZ = fracXZ;
const FRAC_Y = fracY;
const CORNER_Y = cornerY;
const TRILERP = trilerp;

/**
 * Corner values kept across evaluations (SP6a spec §7.4), keyed by (interpolated node or def, column (s.cx, s.cz),
 * corner (i, k, j)). A memo holds the values of the reference that last used it: another reference clears it first.
 * Its values stay valid while the columns' samples are those of one GenContext; `clear()` drops them.
 */
export interface CornerMemo {
  clear(): void;
}

/** One corner's values, by slot (an interpolated node or a def of the owning reference). */
interface CornerCell {
  readonly v: Float64Array;
  readonly has: Uint8Array;
}

interface MemoState extends CornerMemo {
  owner: object | null;
  readonly cells: Map<number, CornerCell>;
}

/** A new, empty corner memo (one per slice part). */
export function createCornerMemo(): CornerMemo {
  const m: MemoState = {
    owner: null,
    cells: new Map<number, CornerCell>(),
    clear() { m.cells.clear(); },
  };
  return m;
}

/** Chunk coordinates lie in [−2^15, 2^15): offset into [0, 2^16); a corner (i, k, j) is one of 5 · 49 · 5. */
const CHUNK_OFFSET = 32768;
const CHUNK_SPAN = 65536;
const CORNERS = 1225;

export interface DensityReference {
  /** The validated expression. */
  readonly expr: DensityExpr;
  /**
   * `e` (default: the root) at the voxel at world (x, y, z): integers, (x, z) inside `s`'s column, y ∈ [−64, 319].
   * Throws a RangeError outside. With `memo`, corner values are read from and kept in it (the same value, bit for bit).
   */
  voxel(s: ColumnSample, x: number, y: number, z: number, e?: Expr, memo?: CornerMemo): number;
  /**
   * `e` at corner (i, k, j) of `s`'s column (i, j ∈ 0 … 4, k ∈ 0 … 48) with the corner placement: the value
   * `cornerFn`/`columnFn` hold for a node inside `interpolated`. `e` must not contain an `interpolated`. With `memo`,
   * its refs' values at this corner are read from and kept in it.
   */
  corner(s: ColumnSample, e: Expr, i: number, k: number, j: number, memo?: CornerMemo): number;
  /**
   * The tap `name` at a voxel: its child at the voxel when its first occurrence (evaluation order, from the root) is
   * outside `interpolated`; otherwise its child's corner values interpolated as an `interpolated` would. Throws when no
   * tap of that name is reachable from the root.
   */
  tap(s: ColumnSample, name: string, x: number, y: number, z: number): number;
}

function checkInt(v: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} ${v} is outside [${lo}, ${hi}]`);
}

/** Validates `expr` against `noises` (throws ExprValidationError) and returns its reference evaluator. */
export function createDensityReference(expr: DensityExpr, noises: DensityNoiseSource): DensityReference {
  const issues = VALIDATE(expr, noises);
  if (issues.length > 0) throw new INVALID(issues);
  const defs = expr.defs;
  // Thawed copies of the knots of every slide node in the tree: element reads of a frozen array (a resolved tree is
  // deep-frozen) are about twice as slow in V8, and a slide is charged 1 whatever its knot count (SP3d final review).
  // The values are the same doubles, so every result is bit-identical; a node from outside the tree reads its own.
  const thawed = new Map<Expr, readonly SlideKnot[]>();
  const seen = new Set<Expr>();
  const stack: Expr[] = [expr.root, ...Object.values(defs)];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (seen.has(e)) continue;
    seen.add(e);
    if (e.op === 'slide') thawed.set(e, e.knots.map((k): SlideKnot => [k[0], k[1]]));
    for (const c of CHILDREN(e)) stack.push(c);
  }
  const knots = (e: SlideExpr): readonly SlideKnot[] => thawed.get(e) ?? e.knots;
  // The memo's slots: every interpolated node of the tree (by identity) and every def (by name).
  const nodeSlots = new Map<Expr, number>();
  for (const e of seen) if (e.op === 'interpolated') nodeSlots.set(e, nodeSlots.size);
  const defSlots = new Map<string, number>();
  for (const name of Object.keys(defs)) defSlots.set(name, nodeSlots.size + defSlots.size);
  const slots = nodeSlots.size + defSlots.size;
  const self = {};
  /** The memo's cell of corner (i, k, j) of `s`'s column, created empty when missing. */
  const cellOf = (m: MemoState, s: ColumnSample, i: number, k: number, j: number): CornerCell => {
    if (m.owner !== self) {
      m.cells.clear();
      m.owner = self;
    }
    const key = ((s.cx + CHUNK_OFFSET) * CHUNK_SPAN + (s.cz + CHUNK_OFFSET)) * CORNERS + (i * 5 + j) * 49 + k;
    let c = m.cells.get(key);
    if (c === undefined) {
      c = { v: new Float64Array(slots), has: new Uint8Array(slots) };
      m.cells.set(key, c);
    }
    return c;
  };
  const noise = (id: string): DensityNoise => {
    const n = noises(id);
    if (n === undefined) throw new Error(`unknown density noise ${id}`);
    return n;
  };

  /** `e` at corner (i, k, j), its refs memoised in `cell` when there is one; the indices are not checked. */
  const cornerAt = (s: ColumnSample, e: Expr, i: number, k: number, j: number, cell: CornerCell | null): number => {
    const cx = 16 * s.cx + 4 * i, cy = CORNER_Y(k), cz = 16 * s.cz + 4 * j, li = LATTICE(i, j);
    const env: NodeEnv = {
      y: cy,
      knots,
      child: (c) => EVAL(c, env),
      read: (r: DelegatedExpr) => {
        switch (r.op) {
          case 'col': return s.f[r.field][li]!;
          case 'noise2': return noise(r.id).z2(cx, cz);
          case 'noise': return noise(r.id).z3(cx, cy, cz);
          case 'noiseScaled': return noise(r.id).z3(cx / r.s, cy / r.s, cz / r.s);
          case 'ref': {
            if (cell === null) return EVAL(defs[r.name]!, env);
            const slot = defSlots.get(r.name)!;
            if (cell.has[slot] === 1) return cell.v[slot]!;
            const v = EVAL(defs[r.name]!, env);
            cell.v[slot] = v;
            cell.has[slot] = 1;
            return v;
          }
          case 'interpolated': throw new Error('an interpolated cannot be evaluated at a corner (nested interpolated)');
        }
      },
    };
    return EVAL(e, env);
  };

  const corner = (s: ColumnSample, e: Expr, i: number, k: number, j: number, memo?: CornerMemo): number => {
    checkInt(i, 0, 4, 'corner i');
    checkInt(k, 0, 48, 'corner k');
    checkInt(j, 0, 4, 'corner j');
    return cornerAt(s, e, i, k, j, memo === undefined ? null : cellOf(memo as MemoState, s, i, k, j));
  };

  const voxel = (s: ColumnSample, x: number, y: number, z: number, e: Expr = expr.root, memo?: CornerMemo): number => {
    const lx = x - 16 * s.cx, lz = z - 16 * s.cz;
    checkInt(lx, 0, 15, 'voxel local x');
    checkInt(lz, 0, 15, 'voxel local z');
    checkInt(y, -64, 319, 'voxel y');
    const ci = CELL_XZ(lx), ck = CELL_Y(y), cj = CELL_XZ(lz);
    const tx = FRAC_XZ(lx), ty = FRAC_Y(y), tz = FRAC_XZ(lz);
    // With a memo: the cell's 8 corner cells, fetched once per voxel (x fastest, then z, then y: trilerp's order).
    let cells: CornerCell[] | null = null;
    const at = (c: Expr, slot: number, n: number, i: number, k: number, j: number): number => {
      const cell = cells![n]!;
      if (cell.has[slot] === 1) return cell.v[slot]!;
      const v = cornerAt(s, c, i, k, j, cell);
      cell.v[slot] = v;
      cell.has[slot] = 1;
      return v;
    };
    const env: NodeEnv = {
      y,
      knots,
      child: (c) => EVAL(c, env),
      read: (r: DelegatedExpr) => {
        switch (r.op) {
          case 'col': return READ_FIELD(s, r.field, x, z);
          case 'noise2': return noise(r.id).z2(x, z);
          case 'noise': return noise(r.id).z3(x, y, z);
          case 'noiseScaled': return noise(r.id).z3(x / r.s, y / r.s, z / r.s);
          case 'ref': return EVAL(defs[r.name]!, env);
          case 'interpolated': {
            const c = r.x;
            const slot = memo === undefined ? undefined : nodeSlots.get(r);
            if (slot === undefined) {
              return TRILERP(
                corner(s, c, ci, ck, cj), corner(s, c, ci + 1, ck, cj), corner(s, c, ci, ck, cj + 1), corner(s, c, ci + 1, ck, cj + 1),
                corner(s, c, ci, ck + 1, cj), corner(s, c, ci + 1, ck + 1, cj), corner(s, c, ci, ck + 1, cj + 1), corner(s, c, ci + 1, ck + 1, cj + 1),
                tx, ty, tz,
              );
            }
            if (cells === null) {
              const m = memo as MemoState;
              cells = [
                cellOf(m, s, ci, ck, cj), cellOf(m, s, ci + 1, ck, cj), cellOf(m, s, ci, ck, cj + 1), cellOf(m, s, ci + 1, ck, cj + 1),
                cellOf(m, s, ci, ck + 1, cj), cellOf(m, s, ci + 1, ck + 1, cj), cellOf(m, s, ci, ck + 1, cj + 1), cellOf(m, s, ci + 1, ck + 1, cj + 1),
              ];
            }
            return TRILERP(
              at(c, slot, 0, ci, ck, cj), at(c, slot, 1, ci + 1, ck, cj), at(c, slot, 2, ci, ck, cj + 1), at(c, slot, 3, ci + 1, ck, cj + 1),
              at(c, slot, 4, ci, ck + 1, cj), at(c, slot, 5, ci + 1, ck + 1, cj), at(c, slot, 6, ci, ck + 1, cj + 1), at(c, slot, 7, ci + 1, ck + 1, cj + 1),
              tx, ty, tz,
            );
          }
        }
      },
    };
    return EVAL(e, env);
  };

  const tap = (s: ColumnSample, name: string, x: number, y: number, z: number): number => {
    const found = findTap(expr, name);
    if (found === undefined) throw new Error(`no tap ${JSON.stringify(name)} reachable from the root`);
    return voxel(s, x, y, z, found.inside ? { op: 'interpolated', x: found.node.x } : found.node.x);
  };

  return { expr, voxel, corner, tap };
}

/**
 * Walks the nodes reachable from the root in evaluation order (slot order; through refs; both rangeChoice branches),
 * with the inside-`interpolated` flag. A def is entered once per flag. `visit` returning true stops the walk.
 */
function walkReachable(expr: DensityExpr, visit: (e: Expr, inside: boolean) => boolean): void {
  const entered = new Set<string>();
  const go = (e: Expr, inside: boolean): boolean => {
    if (visit(e, inside)) return true;
    if (e.op === 'ref') {
      const key = `${inside ? 1 : 0}|${e.name}`;
      if (entered.has(key)) return false;
      entered.add(key);
      return go(expr.defs[e.name]!, inside);
    }
    const rec = e as unknown as Record<string, Expr>;
    const childInside = inside || e.op === 'interpolated';
    for (const k of CHILD_KEYS[e.op]) if (go(rec[k]!, childInside)) return true;
    return false;
  };
  go(expr.root, false);
}

/** The first occurrence of tap `name` reachable from the root (evaluation order), and whether it is inside `interpolated`. */
export function findTap(expr: DensityExpr, name: string): { readonly node: TapExpr; readonly inside: boolean } | undefined {
  let out: { node: TapExpr; inside: boolean } | undefined;
  walkReachable(expr, (e, inside) => {
    if (e.op === 'tap' && e.name === name) { out = { node: e, inside }; return true; }
    return false;
  });
  return out;
}

/** The distinct `interpolated` nodes (by identity) reachable from the root, in evaluation order. */
export function interpolatedNodes(expr: DensityExpr): InterpolatedExpr[] {
  const out: InterpolatedExpr[] = [];
  const seen = new Set<Expr>();
  walkReachable(expr, (e) => {
    if (e.op === 'interpolated' && !seen.has(e)) { seen.add(e); out.push(e); }
    return false;
  });
  return out;
}

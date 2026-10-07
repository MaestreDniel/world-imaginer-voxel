/**
 * The reference interpreter (SP3b spec §2.3): evaluates a density expression at one voxel (or one corner) by walking
 * the tree, with the compiler's placement rules and the §2.2 interpolation, recomputing everything per call. It is the
 * oracle the compiled closures must equal bit for bit (DT2 `compiledReference`, the compile fuzz).
 *
 * Placement (§2.1, §2.2):
 * - outside `interpolated` (voxel level), `y` is the voxel's y, `col` is the ColumnSample's bilinear readout at the
 *   voxel's (x, z) (`readField`), `noise2` is z2(x, z) and `noise` z3(x, y, z) at the voxel;
 * - an `interpolated` node evaluates its child at the 8 corners of the voxel's cell and interpolates them (`trilerp`);
 * - at a corner (i, k, j), `y` is −64 + 8k, `col` is the lattice value `latticeIndex(i, j)` exactly, and the noises
 *   sample the corner's world coordinates (16cx + 4i, −64 + 8k, 16cz + 4j).
 * A COLUMN sub-tree read at voxel level depends on nothing but `const`, `col` and `noise2`, so walking it with the
 * voxel's reads is its `positionFn` value at the voxel's position; a COLUMN or CELL sub-tree inside `interpolated` is
 * walked with the corner's reads (its `columnFn` / `cornerFn` value). The walk therefore needs no class pass.
 *
 * Noises are injected (`DensityNoiseSource`), so the reference runs on schema noises and on test noises alike.
 */
import { latticeIndex, readField, type ColumnSample } from '../column/columnStage';
import { EXPR_CHILD_KEYS, ExprValidationError, validateExpr, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type InterpolatedExpr, type TapExpr } from './expr';
import { cellXZ, cellY, cornerY, evalNode, fracXZ, fracY, trilerp, type DelegatedExpr, type NodeEnv } from './nodes';

const LATTICE = latticeIndex;
const READ_FIELD = readField;
const VALIDATE = validateExpr;
const INVALID = ExprValidationError;
const CHILD_KEYS = EXPR_CHILD_KEYS;
const EVAL = evalNode;
const CELL_XZ = cellXZ;
const CELL_Y = cellY;
const FRAC_XZ = fracXZ;
const FRAC_Y = fracY;
const CORNER_Y = cornerY;
const TRILERP = trilerp;

export interface DensityReference {
  /** The validated expression. */
  readonly expr: DensityExpr;
  /**
   * `e` (default: the root) at the voxel at world (x, y, z): integers, (x, z) inside `s`'s column, y ∈ [−64, 319].
   * Throws a RangeError outside.
   */
  voxel(s: ColumnSample, x: number, y: number, z: number, e?: Expr): number;
  /**
   * `e` at corner (i, k, j) of `s`'s column (i, j ∈ 0 … 4, k ∈ 0 … 48) with the corner placement: the value
   * `cornerFn`/`columnFn` hold for a node inside `interpolated`. `e` must not contain an `interpolated`.
   */
  corner(s: ColumnSample, e: Expr, i: number, k: number, j: number): number;
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
  const noise = (id: string): DensityNoise => {
    const n = noises(id);
    if (n === undefined) throw new Error(`unknown density noise ${id}`);
    return n;
  };

  const corner = (s: ColumnSample, e: Expr, i: number, k: number, j: number): number => {
    checkInt(i, 0, 4, 'corner i');
    checkInt(k, 0, 48, 'corner k');
    checkInt(j, 0, 4, 'corner j');
    const cx = 16 * s.cx + 4 * i, cy = CORNER_Y(k), cz = 16 * s.cz + 4 * j, li = LATTICE(i, j);
    const env: NodeEnv = {
      y: cy,
      child: (c) => EVAL(c, env),
      read: (r: DelegatedExpr) => {
        switch (r.op) {
          case 'col': return s.f[r.field][li]!;
          case 'noise2': return noise(r.id).z2(cx, cz);
          case 'noise': return noise(r.id).z3(cx, cy, cz);
          case 'ref': return EVAL(defs[r.name]!, env);
          case 'interpolated': throw new Error('an interpolated cannot be evaluated at a corner (nested interpolated)');
        }
      },
    };
    return EVAL(e, env);
  };

  const voxel = (s: ColumnSample, x: number, y: number, z: number, e: Expr = expr.root): number => {
    const lx = x - 16 * s.cx, lz = z - 16 * s.cz;
    checkInt(lx, 0, 15, 'voxel local x');
    checkInt(lz, 0, 15, 'voxel local z');
    checkInt(y, -64, 319, 'voxel y');
    const ci = CELL_XZ(lx), ck = CELL_Y(y), cj = CELL_XZ(lz);
    const tx = FRAC_XZ(lx), ty = FRAC_Y(y), tz = FRAC_XZ(lz);
    const env: NodeEnv = {
      y,
      child: (c) => EVAL(c, env),
      read: (r: DelegatedExpr) => {
        switch (r.op) {
          case 'col': return READ_FIELD(s, r.field, x, z);
          case 'noise2': return noise(r.id).z2(x, z);
          case 'noise': return noise(r.id).z3(x, y, z);
          case 'ref': return EVAL(defs[r.name]!, env);
          case 'interpolated': {
            const c = r.x;
            return TRILERP(
              corner(s, c, ci, ck, cj), corner(s, c, ci + 1, ck, cj), corner(s, c, ci, ck, cj + 1), corner(s, c, ci + 1, ck, cj + 1),
              corner(s, c, ci, ck + 1, cj), corner(s, c, ci + 1, ck + 1, cj), corner(s, c, ci, ck + 1, cj + 1), corner(s, c, ci + 1, ck + 1, cj + 1),
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

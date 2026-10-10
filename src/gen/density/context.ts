/**
 * DensityContext (SP3b spec §2.3): what evaluating the density of one GenContext needs, built once per context.
 * - `noises`: the GenContext's schema noises `density.noises.<id>` (seed name = leaf path) as a DensityNoiseSource,
 *   with each leaf's dims; ids are the keys under `density.noises`.
 * - `expr`, `compiled` and `bounds`: one frozen expression (by default `resolveDensity(params.density.defs, params)`,
 *   the `density.defs` leaf resolved for the context's params, SP3d spec §1.6, §2.1; an explicit expression is
 *   deep-frozen in place by `freezeTree`, identity kept) compiled once; its scratch is the per-column cache of the
 *   `columnFn` and `positionFn` values and of the corners evaluated so far.
 * - `columns`: a ColumnCache (SP2a), so that probes and surfaceEst3 do not rebuild a ColumnSample per call.
 * `column(cx, cz)` makes (cx, cz) the compiled expression's current column, running columnFn and positionFn only when
 * another column was current; a T-stage `fillDensityColumn` on `bounds` leaves its column current as well.
 */
import type { NormalNoise } from '../../core/noise/normal';
import { SCHEMA } from '../../core/params/schema';
import { createColumnCache, type ColumnCache } from '../column/columnCache';
import type { ColumnSample } from '../column/columnStage';
import { noiseFor, type GenContext } from '../context';
import { createDensityBounds, type DensityBounds } from './bounds';
import { compileDensity, type CompiledDensity } from './compile';
import type { DensityExpr, DensityNoise, DensityNoiseSource } from './expr';
import { freezeTree, resolveDensity } from './source';

const SCHEMA_ = SCHEMA;
const NOISE_FOR = noiseFor;
const CACHE = createColumnCache;
const COMPILE = compileDensity;
const BOUNDS = createDensityBounds;
const RESOLVE = resolveDensity;
const FREEZE = freezeTree;

/** The schema path prefix of the density noises; an expression's noise id is the key after it. */
const PREFIX = 'density.noises.';

export interface DensityContext {
  readonly ctx: GenContext;
  /** The compiled expression: deep-frozen, the same object as `compiled.expr`. */
  readonly expr: DensityExpr;
  readonly noises: DensityNoiseSource;
  readonly compiled: CompiledDensity;
  readonly bounds: DensityBounds;
  readonly columns: ColumnCache;
  /** Makes column (cx, cz) current (ColumnSample from `columns`; columnFn + positionFn unless already current). */
  column(cx: number, cz: number): ColumnSample;
}

/** Wraps a NormalNoise as a DensityNoise of `dims` (values in [−clampSigma, clampSigma], unscaled coordinates). */
export function densityNoiseOf(n: NormalNoise, dims: 2 | 3): DensityNoise {
  return { dims, remap: n.def.remap, clampSigma: n.clamp, z2: (x, z) => n.z2(x, z), z3: (x, y, z) => n.z3(x, y, z) };
}

/** The GenContext's density noises: id → the prepared NormalNoise of schema leaf `density.noises.<id>`, with its dims. */
export function densityNoiseSource(ctx: GenContext): DensityNoiseSource {
  const m = new Map<string, DensityNoise>();
  for (const { path, leaf } of SCHEMA_.leaves) {
    if (leaf.kind !== 'noise' || !path.startsWith(PREFIX)) continue;
    m.set(path.slice(PREFIX.length), densityNoiseOf(NOISE_FOR(ctx, path), leaf.dims ?? 2));
  }
  return (id) => m.get(id);
}

/**
 * A DensityContext for `ctx` over `expr`. Without `expr` the expression is the `density.defs` leaf of `ctx.params`
 * resolved for them (`resolveDensity`: tier 2 first, then a fresh frozen tree; an invalid source throws an
 * ExprValidationError with its source paths); an explicit `expr` is deep-frozen in place (`freezeTree`, identity
 * kept: mutating it afterwards throws) and validated by the compiler (ExprValidationError).
 */
export function createDensityContext(ctx: GenContext, expr?: DensityExpr): DensityContext {
  const tree = expr === undefined ? RESOLVE(ctx.params.density.defs, ctx.params) : FREEZE(expr);
  const noises = densityNoiseSource(ctx);
  const compiled = COMPILE(tree, noises);
  const bounds = BOUNDS(compiled, noises);
  const columns = CACHE(ctx);
  return {
    ctx, expr: tree, noises, compiled, bounds, columns,
    column(cx, cz) {
      const s = columns.get(cx, cz);
      if (!compiled.hasPositions(cx, cz)) {
        compiled.columnFn(s);
        compiled.positionFn(s);
      }
      return s;
    },
  };
}

/**
 * DensityContext (SP3b spec §2.3): what evaluating the density of one GenContext needs, built once per context.
 * - `noises`: the GenContext's schema noises `density.noises.<id>` (seed name = leaf path) as a DensityNoiseSource,
 *   with each leaf's dims; ids are the keys under `density.noises`.
 * - `compiled` and `bounds`: the expression (by default `defaultDensityExpr(params.density)`) compiled once; its
 *   scratch is the per-column cache of the `columnFn` and `positionFn` values and of the corners evaluated so far.
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
import { defaultDensityExpr } from './defaults';
import type { DensityExpr, DensityNoise, DensityNoiseSource } from './expr';

const SCHEMA_ = SCHEMA;
const NOISE_FOR = noiseFor;
const CACHE = createColumnCache;
const COMPILE = compileDensity;
const BOUNDS = createDensityBounds;
const DEFAULT_EXPR = defaultDensityExpr;

/** The schema path prefix of the density noises; an expression's noise id is the key after it. */
const PREFIX = 'density.noises.';

export interface DensityContext {
  readonly ctx: GenContext;
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

/** A DensityContext for `ctx` over `expr` (default: the §3.1 expression from `ctx.params.density`). */
export function createDensityContext(ctx: GenContext, expr: DensityExpr = DEFAULT_EXPR(ctx.params.density)): DensityContext {
  const noises = densityNoiseSource(ctx);
  const compiled = COMPILE(expr, noises);
  const bounds = BOUNDS(compiled, noises);
  const columns = CACHE(ctx);
  return {
    ctx, expr, noises, compiled, bounds, columns,
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

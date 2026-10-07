/**
 * The default density expression (SP3b spec §3.1), built from `params.density`:
 *
 *   J        = square(1 − abs(noise2('jag') · (1 / clampSigma)))
 *   N3       = noise('overhang')
 *   terrain  = tap('terrain', interpolated( col.offset + col.jag · J − y + col.sigma · slide(N3, SLIDE)
 *                                           + 2·max(0, −56 − y) − 2·max(0, y − 296) ))
 *   amp      = ampLo + (ampHi − ampLo) · clamp((col.E + 1) / 2, 0, 1)
 *   detail   = noise('detail') · amp
 *   final    = max( terrain + detail, islands ),   islands = tap('islands', const −1e6)
 *   SLIDE    = [(−64, 0), (−40, 1), (240, 1), (320, 0)]
 *
 * The sums are left-nested in the written order (IEEE addition is not associative, so the order is part of the
 * expression). `SLIDE`, the floor and ceiling terms and the islands constant stay code until `density.defs` (SP3d).
 * `1 / clampSigma` reads the jag noise's clampSigma, so J uses u = z / clampSigma ∈ [−1, 1] (§1.1); `(E + 1) / 2` is
 * written `(E + 1) · 0.5` (exact) and `ampHi − ampLo` is folded into one constant.
 */
import type { DensityParams } from '../../core/params/schema';
import type { DensityExpr, Expr, SlideKnot } from './expr';

const SLIDE: readonly SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const max = (a: Expr, b: Expr): Expr => ({ op: 'max', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });

/** The default density expression of SP3b spec §3.1 for `p` (= `params.density`). Ids are the `density.noises` keys. */
export function defaultDensityExpr(p: DensityParams): DensityExpr {
  const J: Expr = { op: 'square', x: add(C(1), neg({ op: 'abs', x: mul({ op: 'noise2', id: 'jag' }, C(1 / p.noises.jag.clampSigma)) })) };
  const N3: Expr = { op: 'noise', id: 'overhang' };
  let inner = add({ op: 'col', field: 'offset' }, mul({ op: 'col', field: 'jag' }, J));
  inner = add(inner, neg(Y));
  inner = add(inner, mul({ op: 'col', field: 'sigma' }, { op: 'slide', x: N3, knots: SLIDE }));
  inner = add(inner, mul(C(2), max(C(0), add(C(-56), neg(Y)))));
  inner = add(inner, neg(mul(C(2), max(C(0), add(Y, C(-296))))));
  const terrain: Expr = { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: inner } };
  const e01: Expr = { op: 'clamp', x: mul(add({ op: 'col', field: 'E' }, C(1)), C(0.5)), lo: 0, hi: 1 };
  const amp = add(C(p.detailAmpLo), mul(C(p.detailAmpHi - p.detailAmpLo), e01));
  const detail = mul({ op: 'noise', id: 'detail' }, amp);
  const islands: Expr = { op: 'tap', name: 'islands', x: C(-1e6) };
  return { root: max(add(terrain, detail), islands), defs: {} };
}

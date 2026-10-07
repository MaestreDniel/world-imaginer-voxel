/**
 * Random valid density expressions for the compile == reference and bounds fuzz (SP3b spec §10).
 *
 * Trees use every op of §1.1 over a set of noise ids: by default the test noises of `fuzzNoiseSource()`; pass `noises`
 * to draw over other ids (`SCHEMA_DENSITY_NOISES`, evaluated through `densityNoiseSource(ctx)`, for the schema's
 * `density.noises`). Constants are drawn as §1.2 asks (`fuzzConstant`: log-uniform magnitudes in [1e-6, 1e9] with
 * random signs, plus 0, −0 and small integers).
 *
 * Every tree is valid by construction: defs reference only earlier defs (no cycles), no `interpolated` is generated
 * inside another (a ref inside `interpolated` targets only a def without one), clamp lo ≤ hi, rangeChoice lo < hi,
 * slide knots strictly increasing, tap names unique. Heights (a ref counts as its def's height) are at most `maxDepth`
 * (default 6), so a tree has at most 2^5 multiplicative leaves of magnitude ≤ 1e9 and every value stays finite.
 */
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import type { Seed64 } from '../../src/core/hash';
import { SCHEMA } from '../../src/core/params/schema';
import { SAMPLE_FIELDS } from '../../src/gen/column/columnStage';
import { densityNoiseOf } from '../../src/gen/density/context';
import { exprChildren, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type SlideKnot } from '../../src/gen/density/expr';
import { testFloat } from './stats';

export interface FuzzNoiseSpec { readonly id: string; readonly dims: 2 | 3; readonly def: NoiseDef }

/** The test noise map: two 2D and two 3D noises of different wavelengths, octaves, yScale and clampSigma. */
export const FUZZ_NOISE_SPECS: readonly FuzzNoiseSpec[] = [
  { id: 'fz2a', dims: 2, def: completeNoiseDef({ wavelength: 16, octaves: 2 }) },
  { id: 'fz2b', dims: 2, def: completeNoiseDef({ wavelength: 64, octaves: 1, clampSigma: 2.5 }) },
  { id: 'fz3a', dims: 3, def: completeNoiseDef({ wavelength: 8, octaves: 1 }) },
  { id: 'fz3b', dims: 3, def: completeNoiseDef({ wavelength: 32, octaves: 2, yScale: 2, clampSigma: 4 }) },
];

/** The schema's density noise ids and dims (the keys under `density.noises`), for `randomDensityExpr`'s `noises`. */
export const SCHEMA_DENSITY_NOISES: readonly { readonly id: string; readonly dims: 2 | 3 }[] = SCHEMA.leaves
  .filter((l) => l.leaf.kind === 'noise' && l.path.startsWith('density.noises.'))
  .map((l) => ({ id: l.path.slice('density.noises.'.length), dims: l.leaf.dims ?? 2 }));

/** The test noises as a DensityNoiseSource; seed names are `density.noises.<id>` under `seed`. */
export function fuzzNoiseSource(seed: Seed64 = [0x5eed, 0x3b]): DensityNoiseSource {
  const m = new Map<string, DensityNoise>();
  for (const { id, dims, def } of FUZZ_NOISE_SPECS) m.set(id, densityNoiseOf(new NormalNoise(seed, `density.noises.${id}`, def), dims));
  return (id) => m.get(id);
}

/** 1/8 +0, 1/8 −0, 1/8 an integer in [−10, 10], else a log-uniform magnitude in [1e-6, 1e9] with a random sign. */
export function fuzzConstant(next: () => number): number {
  const r = next() % 8;
  if (r === 0) return 0;
  if (r === 1) return -0;
  if (r === 2) return (next() % 21) - 10;
  const mag = Math.exp(Math.log(1e-6) + (Math.log(1e9) - Math.log(1e-6)) * testFloat(next));
  const m = mag < 1e-6 ? 1e-6 : mag > 1e9 ? 1e9 : mag;
  return next() % 2 === 0 ? m : -m;
}

/** A threshold for clamp / rangeChoice: half the time in [−8, 8] (so both sides occur on typical values), else fuzzConstant. */
function threshold(next: () => number): number {
  return next() % 2 === 0 ? (testFloat(next) - 0.5) * 16 : fuzzConstant(next);
}

function knots(next: () => number): SlideKnot[] {
  const n = 2 + (next() % 4);
  const out: SlideKnot[] = [];
  let y = -80 + (next() % 120);
  for (let i = 0; i < n; i++) {
    const v = next() % 3 === 0 ? (next() % 5) - 2 : (testFloat(next) - 0.5) * 4;
    out.push([y, v]);
    y += 1 + (next() % 120) + (next() % 4 === 0 ? 0.5 : 0);
  }
  return out;
}

/** The height of a node: leaves 1, a ref its def's height. */
export function exprHeight(e: Expr, defs: Readonly<Record<string, Expr>>): number {
  if (e.op === 'ref') return exprHeight(defs[e.name]!, defs);
  let h = 0;
  for (const c of exprChildren(e)) h = Math.max(h, exprHeight(c, defs));
  return h + 1;
}

function hasInterpolated(e: Expr, defs: Readonly<Record<string, Expr>>): boolean {
  if (e.op === 'interpolated') return true;
  if (e.op === 'ref') return hasInterpolated(defs[e.name]!, defs);
  return exprChildren(e).some((c) => hasInterpolated(c, defs));
}

export interface DensityFuzzOptions {
  /** Noise ids and dims to draw from (default FUZZ_NOISE_SPECS). */
  readonly noises?: readonly { readonly id: string; readonly dims: 2 | 3 }[];
  /** Maximum height (default 6: keeps every value finite). */
  readonly maxDepth?: number;
  /** Maximum number of defs (default 3). */
  readonly maxDefs?: number;
}

type Op = Expr['op'];
const INNER_OPS: readonly Op[] = ['add', 'mul', 'min', 'max', 'neg', 'abs', 'square', 'clamp', 'slide', 'interpolated', 'rangeChoice', 'tap'];
const LEAF_OPS: readonly Op[] = ['const', 'y', 'col', 'noise2', 'noise', 'ref'];

/** A random valid DensityExpr drawn from `next` (u32 stream, e.g. testRng). */
export function randomDensityExpr(next: () => number, opts: DensityFuzzOptions = {}): DensityExpr {
  const noises = opts.noises ?? FUZZ_NOISE_SPECS;
  const n2 = noises.filter((n) => n.dims === 2), n3 = noises.filter((n) => n.dims === 3);
  const maxDepth = opts.maxDepth ?? 6;
  const defs: Record<string, Expr> = {};
  const defInfo: Array<{ name: string; height: number; interp: boolean }> = [];
  let taps = 0;
  const pick = <T>(xs: readonly T[]): T => xs[next() % xs.length]!;

  const leaf = (budget: number, inside: boolean): Expr => {
    for (;;) {
      const op = pick(LEAF_OPS);
      switch (op) {
        case 'const': return { op, v: fuzzConstant(next) };
        case 'y': return { op };
        case 'col': return { op, field: pick(SAMPLE_FIELDS) };
        case 'noise2': if (n2.length > 0) return { op, id: pick(n2).id }; break;
        case 'noise': if (n3.length > 0) return { op, id: pick(n3).id }; break;
        case 'ref': {
          const ok = defInfo.filter((d) => d.height <= budget && !(inside && d.interp));
          if (ok.length > 0) return { op, name: pick(ok).name };
          break;
        }
        default: break;
      }
    }
  };

  const gen = (budget: number, inside: boolean): Expr => {
    if (budget <= 1 || next() % 4 === 0) return leaf(budget, inside);
    const sub = budget - 1;
    for (;;) {
      const op = pick(INNER_OPS);
      switch (op) {
        case 'add': case 'mul': case 'min': case 'max': return { op, a: gen(sub, inside), b: gen(sub, inside) };
        case 'neg': case 'abs': case 'square': return { op, x: gen(sub, inside) };
        case 'clamp': {
          const a = threshold(next), b = threshold(next);
          return { op, x: gen(sub, inside), lo: a <= b ? a : b, hi: a <= b ? b : a };
        }
        case 'slide': return { op, x: gen(sub, inside), knots: knots(next) };
        case 'interpolated': if (!inside) return { op, x: gen(sub, true) }; break;
        case 'rangeChoice': {
          const a = threshold(next);
          let b = threshold(next);
          if (b === a) b = a + 1;
          return { op, x: gen(sub, inside), lo: a < b ? a : b, hi: a < b ? b : a, inside: gen(sub, inside), outside: gen(sub, inside) };
        }
        case 'tap': return { op, name: `t${taps++}`, x: gen(sub, inside) };
        default: break;
      }
    }
  };

  const nDefs = next() % ((opts.maxDefs ?? 3) + 1);
  for (let i = 0; i < nDefs; i++) {
    const name = `d${i}`;
    const e = gen(1 + (next() % (maxDepth - 1)), next() % 2 === 0);
    defs[name] = e;
    defInfo.push({ name, height: exprHeight(e, defs), interp: hasInterpolated(e, defs) });
  }
  return { root: gen(maxDepth, false), defs };
}

/**
 * A terrain-shaped stand-in for SP3b §3.1's default expression over the test noises (jag → fz2a, overhang → fz3b,
 * detail → fz3a), for the bounds tests and the driver's cost until Task 6 brings the real one:
 * `max(tap('terrain', interpolated(offset + jag·J − y + sigma·slide(N3, SLIDE) + 2·max(0, −56 − y)
 * − 2·max(0, y − 296))) + N_detail · amp, tap('islands', −1e6))`, J = (1 − |z2 / 3|)², amp = 0.6 + 0.9·clamp((E + 1) / 2, 0, 1).
 */
export function terrainStandInExpr(): DensityExpr {
  const C = (v: number): Expr => ({ op: 'const', v });
  const Y: Expr = { op: 'y' };
  const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
  const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
  const max = (a: Expr, b: Expr): Expr => ({ op: 'max', a, b });
  const neg = (x: Expr): Expr => ({ op: 'neg', x });
  const J: Expr = { op: 'square', x: add(C(1), neg({ op: 'abs', x: mul({ op: 'noise2', id: 'fz2a' }, C(1 / 3)) })) };
  const slide: Expr = { op: 'slide', x: { op: 'noise', id: 'fz3b' }, knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] };
  let inner = add({ op: 'col', field: 'offset' }, mul({ op: 'col', field: 'jag' }, J));
  inner = add(inner, neg(Y));
  inner = add(inner, mul({ op: 'col', field: 'sigma' }, slide));
  inner = add(inner, mul(C(2), max(C(0), add(C(-56), neg(Y)))));
  inner = add(inner, neg(mul(C(2), max(C(0), add(Y, C(-296))))));
  const terrain: Expr = { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: inner } };
  const amp = add(C(0.6), mul(C(0.9), { op: 'clamp', x: mul(add({ op: 'col', field: 'E' }, C(1)), C(0.5)), lo: 0, hi: 1 }));
  const detail = mul({ op: 'noise', id: 'fz3a' }, amp);
  return { root: max(add(terrain, detail), { op: 'tap', name: 'islands', x: C(-1e6) }), defs: {} };
}

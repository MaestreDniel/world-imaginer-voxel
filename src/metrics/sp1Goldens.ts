/**
 * SP1 golden digests (SP1 spec §7.4), shared by test/unit/goldens.sp1.test.ts, the lab's determinism
 * panel and test/tools/goldensJsc.ts. Follows the core determinism rules (arch-tested). Every value is hex64.
 */
import { detCos, detErf, detExp, detExp2, detSin, detSmoothstep } from '../core/detMath';
import { fnv1a32, hashF64, hex64 } from '../core/hash';
import { Xoshiro128 } from '../core/rng';

const SIN = detSin;
const COS = detCos;
const EXP = detExp;
const EXP2 = detExp2;
const ERF = detErf;
const SMOOTH = detSmoothstep;
const FNV32 = fnv1a32;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const Rng = Xoshiro128;

export const DETMATH_FNS = ['detSin', 'detCos', 'detExp', 'detExp2', 'detErf', 'detSmoothstep'] as const;
export type DetMathFn = (typeof DETMATH_FNS)[number];

const DRAWS = 1048576; // 2^20
const COMMON_SPECIALS = [0, -0, NaN, Infinity, -Infinity, 5e-324, -5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 0.5, -0.5, 1, -1];
const TRIG_SPECIALS = [2097152, -2097152, 2097152.0000000005, 1.5707963267948966, 3.141592653589793];
const EXTRA_SPECIALS: Readonly<Record<DetMathFn, readonly number[]>> = {
  detSin: TRIG_SPECIALS,
  detCos: TRIG_SPECIALS,
  detExp: [-745.1332191019412, -745.14, 709.782712893384, 709.79],
  detExp2: [-1075.5, -1075, -1074, 1023, 1024],
  detErf: [6.0926, 2.1213203435596424],
  detSmoothstep: [],
};
const RANGE: Readonly<Record<DetMathFn, readonly [number, number]>> = {
  detSin: [-2097152, 2097152],
  detCos: [-2097152, 2097152],
  detExp: [-746, 710],
  detExp2: [-1076, 1025],
  detErf: [-8, 8],
  detSmoothstep: [-2, 2],
};
const EVAL: Readonly<Record<DetMathFn, (x: number) => number>> = {
  detSin: SIN,
  detCos: COS,
  detExp: EXP,
  detExp2: EXP2,
  detErf: ERF,
  detSmoothstep: (x) => SMOOTH(-1, 1, x),
};

/** 2^20 draws x = lo + (hi − lo)·u (sin/cos: even j in [−64, 64), odd j in [−2^21, 2^21)), then the specials. */
export function detMathInputs(fn: DetMathFn): Float64Array {
  const extra = EXTRA_SPECIALS[fn];
  const out = new Float64Array(DRAWS + COMMON_SPECIALS.length + extra.length);
  const r = new Rng(FNV32(`sp1.detMath.${fn}`));
  const trig = fn === 'detSin' || fn === 'detCos';
  const [lo, hi] = RANGE[fn];
  for (let j = 0; j < DRAWS; j++) {
    const u = r.nextFloat();
    out[j] = trig && (j & 1) === 0 ? -64 + (64 - -64) * u : lo + (hi - lo) * u;
  }
  let k = DRAWS;
  for (const v of COMMON_SPECIALS) out[k++] = v;
  for (const v of extra) out[k++] = v;
  return out;
}

export function detMathDigest(fn: DetMathFn): string {
  const xs = detMathInputs(fn);
  const ys = new Float64Array(xs.length);
  const f = EVAL[fn];
  for (let i = 0; i < xs.length; i++) ys[i] = f(xs[i]!);
  return HEX64(HASH_F64(ys));
}

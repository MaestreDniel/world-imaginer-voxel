/**
 * SP1 golden digests (SP1 spec §7.4), shared by test/unit/goldens.sp1.test.ts, the lab's determinism
 * panel and test/tools/goldensJsc.ts. Follows the core determinism rules (arch-tested). Every value is hex64.
 */
import { toUniform } from '../core/noise/cdf';
import { detCos, detErf, detExp, detExp2, detSin, detSmoothstep } from '../core/detMath';
import { fnv1a32, fnv1a64, hashF64, hex64 } from '../core/hash';
import { NormalNoise } from '../core/noise/normal';
import { canonicalJSON } from '../core/params/canonical';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { compileSpline, evalSpline } from '../core/spline/hermite';
import type { NestedSpline } from '../core/spline/types';
import { genKey, paramsHash, stageHashes } from '../core/stage/hash';
import { ADVERSARIAL_DEFS, CLIMATE_FIXTURE_DEFS, DENSITY3D_DEF, FIXTURE_DEFAULTS, FIXTURE_STAGES, JAG, OFFSET, SIGMA, TANGENT_FIXTURE } from './sp1Fixtures';
import type { FixtureNoise } from './sp1Fixtures';

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
const FNV64 = fnv1a64;
const Normal = NormalNoise;
const U = toUniform;
const CANON = canonicalJSON;
const SEED = seedFromInput;
const COMPILE = compileSpline;
const EVAL_SPLINE = evalSpline;
const HASHES = stageHashes;
const GENKEY = genKey;
const PARAMS_HASH = paramsHash;
const CLIMATE_DEFS = CLIMATE_FIXTURE_DEFS;
const DENSITY3D = DENSITY3D_DEF;
const ADVERSARIAL = ADVERSARIAL_DEFS;
const P_DEFAULTS = FIXTURE_DEFAULTS;
const P_STAGES = FIXTURE_STAGES;
const OFFSET_F = OFFSET;
const SIGMA_F = SIGMA;
const JAG_F = JAG;
const TANGENT_F = TANGENT_FIXTURE;

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

const GOLDEN_POINTS = 4096;
const NOISE_FIXTURES: readonly FixtureNoise[] = [...CLIMATE_DEFS, DENSITY3D, ...ADVERSARIAL];
const SPLINES: Readonly<Record<string, NestedSpline>> = { OFFSET: OFFSET_F, SIGMA: SIGMA_F, JAG: JAG_F, TANGENT_FIXTURE: TANGENT_F };

/** z (then u for uniform fields) at 4096 points from Xoshiro128(fnv1a32('sp1.noise')), world seed '42'. */
export function noiseDigest(f: FixtureNoise): string {
  const r = new Rng(FNV32('sp1.noise'));
  const nn = new Normal(SEED('42'), f.seedName, f.def);
  const uniform = f.def.remap === 'uniform';
  const out = new Float64Array(uniform ? 2 * GOLDEN_POINTS : GOLDEN_POINTS);
  for (let i = 0; i < GOLDEN_POINTS; i++) {
    const x = -524288 + 1048576 * r.nextFloat();
    const y = -64 + 384 * r.nextFloat();
    const z = -524288 + 1048576 * r.nextFloat();
    out[i] = f.dims === 2 ? nn.z2(x, z) : nn.z3(x, y, z);
  }
  if (uniform) for (let i = 0; i < GOLDEN_POINTS; i++) out[GOLDEN_POINTS + i] = U(out[i]!);
  return HEX64(HASH_F64(out));
}

/** evalSpline on 4096 vectors of 6 draws −1.25 + 2.5·u (slot order) from Xoshiro128(fnv1a32('sp1.spline')). */
export function splineDigest(name: string): string {
  const s = SPLINES[name];
  if (s === undefined) throw new Error(`unknown golden spline ${name}`);
  const p = COMPILE(s);
  const r = new Rng(FNV32('sp1.spline'));
  const c = new Float64Array(6);
  const out = new Float64Array(GOLDEN_POINTS);
  for (let j = 0; j < GOLDEN_POINTS; j++) {
    for (let k = 0; k < 6; k++) c[k] = -1.25 + 2.5 * r.nextFloat();
    out[j] = EVAL_SPLINE(p, c);
  }
  return HEX64(HASH_F64(out));
}

/** fnv1a64 of canonicalJSON([H.climate, H.decorate, genKey('42'), paramsHash]) over the frozen params fixture. */
export function paramsDigest(): string {
  const h = HASHES(P_DEFAULTS, P_STAGES);
  return HEX64(FNV64(CANON([HEX64(h.climate!), HEX64(h.decorate!), HEX64(GENKEY(SEED('42'), h)), HEX64(PARAMS_HASH(P_DEFAULTS))])));
}

export function goldenKeys(): string[] {
  return [
    ...DETMATH_FNS.map((fn) => `sp1.detMath.${fn}`),
    ...NOISE_FIXTURES.map((f) => `sp1.noise.${f.seedName}`),
    ...Object.keys(SPLINES).map((n) => `sp1.spline.${n}`),
    'sp1.params',
  ];
}

export function computeGolden(key: string): string {
  if (key.startsWith('sp1.detMath.')) {
    const fn = key.slice('sp1.detMath.'.length);
    if ((DETMATH_FNS as readonly string[]).includes(fn)) return detMathDigest(fn as DetMathFn);
  } else if (key.startsWith('sp1.noise.')) {
    const f = NOISE_FIXTURES.find((x) => x.seedName === key.slice('sp1.noise.'.length));
    if (f !== undefined) return noiseDigest(f);
  } else if (key.startsWith('sp1.spline.')) {
    const name = key.slice('sp1.spline.'.length);
    if (name in SPLINES) return splineDigest(name);
  } else if (key === 'sp1.params') {
    return paramsDigest();
  }
  throw new Error(`unknown golden ${key}`);
}

export interface GoldenRow {
  readonly key: string;
  readonly expected: string | null;
  readonly actual: string;
  readonly ok: boolean;
}

/** Pure comparison used by the unit test, the lab panel and the JSC check; missing keys fail. */
export function compareGoldens(expected: Readonly<Record<string, string>>, keys: readonly string[], compute: (key: string) => string): GoldenRow[] {
  return keys.map((key) => {
    const e = Object.hasOwn(expected, key) ? expected[key]! : null;
    const actual = compute(key);
    return { key, expected: e, actual, ok: e === actual };
  });
}

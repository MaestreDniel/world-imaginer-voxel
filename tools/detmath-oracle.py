#!/usr/bin/env python3
"""CPython port of src/core/detMath.ts and of the sp1.detMath golden inputs (SP1 spec §7.4).

CPython floats are IEEE binary64 with per-operation rounding and no FMA, so this port reproduces the
TypeScript operation order bit for bit. Standard library only. Manual oracle, not run in CI:

    python3 tools/detmath-oracle.py > test/fixtures/detmath-oracle.json
"""
import json
import math
import struct
import sys

M32 = 0xFFFFFFFF


def imul(a, b):
    return ((a & M32) * (b & M32)) & M32


def trunc(v):
    return math.copysign(float(math.trunc(v)), v)


def to_int32(v):
    i = int(v) & M32
    return i - (1 << 32) if i >= (1 << 31) else i


# ---- detMath (Appendix A) --------------------------------------------------------------
INV_PIO2 = 0.6366197723675814
PIO2_1 = 1.5707963267341256
PIO2_2 = 6.077100506303966e-11
PIO2_3 = 2.0222662487959506e-21
S1 = -0.16666650669294172
S2 = 0.00833197866315709
S3 = -0.00019495636237669298
C1 = -0.49999999725108224
C2 = 0.041666623324344655
C3 = -0.001388676379438054
C4 = 0.00002439045070398889
TRIG_MAX = 2097152.0
LOG2E = 1.4426950408889634
LN2 = 0.6931471805599453
LN2_HI = 0.6931471803691238
LN2_LO = 1.9082149292705877e-10
TWO_1023 = 8.98846567431158e+307
E1 = 1.0000000321650302
E2 = 0.4999999420905273
E3 = 0.1666643126270281
E4 = 0.04166800203473628
E5 = 0.008374155305794656
E6 = 0.0013843653543488235
A1 = 0.0705240212098103
A2 = 0.042269704761099335
A3 = 0.009321899859670404
A4 = 0.00005736618267948212
A5 = 0.00036130633257334846
A6 = 0.000007131023504472914
A7 = 0.000005746614264949733

POW2 = [0.0] * 2099
_v = 1.0
for _k in range(0, 1024):
    POW2[_k + 1075] = _v
    _v = _v * 2.0
_v = 0.5
for _k in range(-1, -1076, -1):
    POW2[_k + 1075] = _v
    _v = _v * 0.5


def k_sin(r):
    z = r * r
    return r * (1.0 + z * (S1 + z * (S2 + z * S3)))


def k_cos(r):
    z = r * r
    return 1.0 + z * (C1 + z * (C2 + z * (C3 + z * C4)))


def det_sin(x):
    if not (abs(x) <= TRIG_MAX):
        return math.nan
    t = x * INV_PIO2
    k = trunc(t - 0.5 if t < 0 else t + 0.5)
    r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3
    q = to_int32(k) & 3
    v = k_sin(r) if (q & 1) == 0 else k_cos(r)
    return v if (q & 2) == 0 else -v


def det_cos(x):
    if not (abs(x) <= TRIG_MAX):
        return math.nan
    t = x * INV_PIO2
    k = trunc(t - 0.5 if t < 0 else t + 0.5)
    r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3
    q = to_int32(k + 1.0) & 3
    v = k_sin(r) if (q & 1) == 0 else k_cos(r)
    return v if (q & 2) == 0 else -v


def k_exp(r):
    return 1.0 + r * (E1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * E6)))))


def scale(p, k):
    return p * 2.0 * TWO_1023 if k > 1023 else p * POW2[k + 1075]


def det_exp(x):
    if not (x >= -745.1332191019412):
        return x if x != x else 0.0
    if x > 709.782712893384:
        return math.inf
    k = to_int32(math.floor(x * LOG2E + 0.5))
    r = (x - k * LN2_HI) - k * LN2_LO
    return scale(k_exp(r), k)


def det_exp2(x):
    if not (x >= -1075):
        return x if x != x else 0.0
    if x >= 1024:
        return math.inf
    k = to_int32(math.floor(x + 0.5))
    return scale(k_exp((x - k) * LN2), k)


def det_erf(x):
    a = abs(x)
    q = 1.0 + a * (A1 + a * (A2 + a * (A3 + a * (A4 + a * (A5 + a * (A6 + a * A7))))))
    q2 = q * q
    q4 = q2 * q2
    q8 = q4 * q4
    q16 = q8 * q8
    r = 1.0 - 1.0 / q16
    return -r if x < 0 else r


def det_smoothstep(e0, e1, x):
    t = (x - e0) / (e1 - e0)
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return t * t * (3.0 - 2.0 * t)


# ---- hashing and streams (src/core/hash.ts, src/core/rng.ts) ----------------------------
def fnv1a32_ascii(s):
    h = 0x811C9DC5
    for b in s.encode('utf-8'):
        h = imul(h ^ b, 0x01000193)
    return h


def splitmix32(seed):
    state = [seed & M32]

    def nxt():
        state[0] = (state[0] + 0x9E3779B9) & M32
        z = state[0]
        z ^= z >> 16
        z = imul(z, 0x21F0AAAD)
        z ^= z >> 15
        z = imul(z, 0x735A2D97)
        z ^= z >> 15
        return z

    return nxt


class Xoshiro128:
    def __init__(self, seed):
        sm = splitmix32(seed)
        self.a, self.b, self.c, self.d = sm(), sm(), sm(), sm()

    def next_u32(self):
        x = imul(self.b, 5)
        x = ((x << 7) | (x >> 25)) & M32
        r = imul(x, 9)
        t = (self.b << 9) & M32
        self.c ^= self.a
        self.d ^= self.b
        self.b ^= self.c
        self.a ^= self.d
        self.c ^= t
        self.d = ((self.d << 11) | (self.d >> 21)) & M32
        return r

    def next_float(self):
        return self.next_u32() * 2.3283064365386963e-10


CANONICAL_NAN = struct.pack('<Q', 0x7FF8000000000000)


def hash_f64_hex(values):
    h = 0xCBF29CE484222325
    for v in values:
        data = CANONICAL_NAN if v != v else struct.pack('<d', v)
        for b in data:
            h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return '%016x' % h


# ---- golden inputs (src/metrics/sp1Goldens.ts) ------------------------------------------
DRAWS = 1 << 20
COMMON = [0.0, -0.0, math.nan, math.inf, -math.inf, 5e-324, -5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 0.5, -0.5, 1.0, -1.0]
TRIG = [2097152.0, -2097152.0, 2097152.0000000005, 1.5707963267948966, 3.141592653589793]
FNS = [
    ('detSin', det_sin, (-2097152.0, 2097152.0), TRIG),
    ('detCos', det_cos, (-2097152.0, 2097152.0), TRIG),
    ('detExp', det_exp, (-746.0, 710.0), [-745.1332191019412, -745.14, 709.782712893384, 709.79]),
    ('detExp2', det_exp2, (-1076.0, 1025.0), [-1075.5, -1075.0, -1074.0, 1023.0, 1024.0]),
    ('detErf', det_erf, (-8.0, 8.0), [6.0926, 2.1213203435596424]),
    ('detSmoothstep', lambda x: det_smoothstep(-1.0, 1.0, x), (-2.0, 2.0), []),
]


def inputs(name, rng_range, extra):
    r = Xoshiro128(fnv1a32_ascii('sp1.detMath.' + name))
    trig = name in ('detSin', 'detCos')
    lo, hi = rng_range
    xs = []
    for j in range(DRAWS):
        u = r.next_float()
        if trig and (j & 1) == 0:
            xs.append(-64.0 + (64.0 - -64.0) * u)
        else:
            xs.append(lo + (hi - lo) * u)
    return xs + COMMON + list(extra)


def main():
    out = {}
    for name, fn, rng_range, extra in FNS:
        out[name] = hash_f64_hex([fn(x) for x in inputs(name, rng_range, extra)])
        print(name, out[name], file=sys.stderr)
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()

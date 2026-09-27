# SP1 — Deterministic math core (Design)

Date: 2026-09-27
Status: Draft — awaiting user review
Parent: master spec `2026-09-26-architecture-design.md` — §10 SP1, §1, §2.5, §2.7, §3.1-3.3, §3.17, §5.1, §6.3, §6.4, §7, §8 risks 4 and 6; decisions D6, D16, D17 and the new D20.

References written "master §x" point to the master spec; a bare "§x" points to this document.

Evidence: a throwaway SP1 spike (2026-09-27) with four probes (detMath, noise, params, splines) and an independent challenge pass (CPython port of detMath, exact rational integration, JavaScriptCore/QuickJS/XS shells). Numbers are measured on the reference i7-12700H with Node 24.21 unless stated otherwise. The spike code is not carried over; this spec is the contract.

## Goal

Build the pure, bit-deterministic foundation every generator stage stands on, and a research page to look at it:

- `core/hash`, `core/rng`, seed text, `core/detMath`, canonical JSON with number normalisation, and a NaN policy;
- hashed-lattice gradient noise (`lattice3`), `OctaveNoise`, `NormalNoise` and the CDF remap;
- nested cubic-Hermite splines compiled to a zero-allocation program;
- `ParamSchema` (typed builders, validation, patches), profiles skeleton, presets envelope, migrations, stage registry, `stageHash` and `genKey`;
- the `?lab=noise` page: inspector plus A/B comparison of any schema noise, with histogram, gradient rose, statistics and a browser determinism check;
- metric tests N1, N2, N3, N5, N6 and U4, the SP1 goldens and the first bench baseline.

## Non-goals

- No climate stage: warps, `scaleMul`, the PV fold and the ColumnSample arrive in SP2. The lab shows unwarped noise fields.
- No density, cave or 3D schema noises (SP3 and later). 3D code paths are built and tested with test-only definitions.
- No spline defaults in the schema: `shape.*` leaves arrive in SP2. SP1 exercises splines through fixtures.
- No parameter panel, spline editor, URL world hash or preset UI (SP2); no `SETTINGS` schema or `graphicsPresets.ts` (SP5 and later).
- No workers: the lab runs on the main thread (only `engine/` may spawn workers).
- No log, pow or atan2 in detMath (nothing consumes them).

## Decisions (confirmed by the user, 2026-09-27)

| topic | decision |
|---|---|
| lab page | Inspector + A/B comparison: any schema noise, live seed and params, pan/zoom, histogram, gradient rose, statistics; side-by-side view with two seeds or two configs |
| determinism references | **Chrome, Firefox and Safari** (V8, SpiderMonkey, JavaScriptCore); recorded as master decision D20 |
| seed box | text or number: an integer (negative allowed) is used as is, other text is hashed; trim only, case-sensitive, no Unicode normalisation; an empty box generates a random seed and writes it back |
| presets and URL | store only a patch over the chosen profile; saves store full params |
| ParamSchema | approach A: pure-data builders with inferred types |
| gradients | 12 balanced edge gradients (not GRAD16) |
| CDF remap | no rescale to ±1 |
| permutation fallback | removed from `src/`; kept only as a bench comparator |
| README reference | gated from SP1 |
| browser determinism check | moved into SP1 (lab determinism panel) |

## Module layout after SP1

```
src/core/
  hash.ts            Seed64/Hash64, fmix32, axis pre-mix, hash2/3/4, utf8 walker, fnv1a32/64, hex64, hashF64, deriveSeed
  rng.ts             splitmix32, Xoshiro128 (xoshiro128** 1.1)
  seed.ts            seedFromInput, seedToText
  detMath.ts         detSin, detCos, detExp, detExp2, detErf, detSmoothstep (Appendix A)
  noise/lattice3.ts  hashed-lattice gradient noise, 12 balanced gradients, PERLIN3_SD, PERLIN2_SD
  noise/octave.ts    OctaveNoise
  noise/normal.ts    NormalNoise
  noise/cdf.ts       toUniform, uMax
  spline/types.ts    SplineCoord, SplinePoint, NestedSpline, KnotPath
  spline/validate.ts validateSpline, SplineIssue codes
  spline/hermite.ts  compileSpline, evalSpline, evalSplineBatch, evalSplineRef, withKnotY
  spline/tangents.ts autoTangents (hybrid rule; authoring only)
  params/canonical.ts q15, canonicalJSON, CanonicalError
  params/kit.ts      node types, builders, Value/Patch, buildSchema, validators, applyPatch/checkParams/diffParams,
                     getPath, patchAt, deepFreeze, renderReference
  params/schema.ts   ROOT, SCHEMA, Params, ParamsPatch, ClimateParams, NOISE_FIELD_RANGES
  params/meta.ts     derived re-exports only (PARAM_META, metaOf)
  params/defaults.ts derived re-exports only (DEFAULTS)
  params/noises.ts   noiseInstances(params): the schema noise instances with their seed names
  params/profiles.ts ProfileId, PROFILES, resolveProfile
  params/presets.ts  exportPreset, importPreset
  params/migrate.ts  SCHEMA_VERSION, MIGRATIONS, migrate, renamePath/deletePath/mapPath
  stage/registry.ts  StageDef, STAGES, SCOPE_OF_STAGE, checkRegistry
  stage/hash.ts      stageHashes, genKey, dirtyStages, paramsHash
src/metrics/
  noiseStats.ts      sampling streams, moments, ksUniform, histogram, gradientRose, pearson, aperiodicity, zeroRate
  sp1Goldens.ts      the SP1 golden digests (shared by the unit suite and the lab)
src/ui/lab/
  noiseLab.ts labState.ts fieldView.ts statsPanel.ts determinismPanel.ts
tools/detmath-oracle.py   CPython port of detMath (manual oracle; not run in CI)
test/unit/**  test/metrics/noise.metric.ts params.metric.ts  test/bench/noise.bench.ts perm512.ts
test/schema-shape.lock.json  test/baselines.json  test/fixtures/detmath-oracle.json
```

`main.ts` routes `?lab=noise` through a literal `import('./ui/lab/noiseLab')`, so the default bundle does not grow.

## 1. Determinism base

### 1.1 Seed64 and Hash64

```ts
type Seed64 = readonly [lo: number, hi: number];   // value = hi·2^32 + lo
type Hash64 = Seed64;
```

- **Invariant:** both words are integers in [0, 2^32), normalised with `>>> 0` wherever a Seed64 or Hash64 is built. An int32 word such as −1 would give the same `deriveSeed` but a different `genKey`, `hex64` and `seedToText`.
- A small seed n is `[n, 0]`, matching the little-endian binary formats of master §2.7.
- `hex64(h)` prints 16 lower-case hex digits, **hi first**: `hex64(fnv1a64('a')) === 'af63dc4c8601ec8c'`.

### 1.2 `core/hash.ts`

Constants: `KX = 0x27d4eb2d`, `KY = 0x165667b1`, `KZ = 0x9e3779b1`, `KS = 0x85ebca77`, `M1 = 0x85ebca6b`, `M2 = 0xc2b2ae35`.

```ts
fmix32(h)  : h ^= h >>> 16; h = imul(h, M1); h ^= h >>> 13; h = imul(h, M2); h ^= h >>> 16; return h >>> 0
ax(v, K)   : t = imul(v, K); return imul(t ^ (t >>> 15), M1)          // per-axis pre-mix
hash2(s, x, z)       = fmix32(s ^ ax(x, KX) ^ ax(z, KZ))              // == hash3(s, x, 0, z)
hash3(s, x, y, z)    = fmix32(s ^ ax(x, KX) ^ ax(y, KY) ^ ax(z, KZ))
hash4(s, salt, x, z) = fmix32(s ^ ax(salt, KS) ^ ax(x, KX) ^ ax(z, KZ))
deriveSeed(w, name)  = fmix32(w[0] ^ fmix32(w[1] ^ fnv1a32(name)))  // unchanged from master §3.1
```

- **Why the pre-mix.** For odd K, `imul(−v, K) = imul(v, K) ^ (~0 << (tz(v) + 1))`, so the master formula's xor of plain products is unchanged when two coordinates with equal trailing-zero counts are negated. Measured on the master formula: `hash2(x,z) == hash2(−x,−z)` for 33.4 % of positions, 6.6 M duplicate corners in [−128, 128)³ (birthday expectation 32.8 k), and a noise-to-reflection correlation of about ±0.1. With the pre-mix: 0 equal pairs, 32 808 duplicates, reflection |r| ≤ 0.0011. It is also faster.
- **UTF-8.** A hand-written walker feeds the UTF-8 bytes of a string; a lone surrogate encodes as `EF BF BD`, as TextEncoder does. TextEncoder is a host API (absent from the JSC and QuickJS shells) and is banned in `core/`.
- **`fnv1a32(str)`:** `h = 0x811c9dc5`; per byte `h = imul(h ^ b, 0x01000193)`; return `h >>> 0`.
- **`fnv1a64(str)` / `fnv1a64Bytes(bytes)`:** two u32 halves, returned as `[lo, hi]`. Per byte: `lo = (lo ^ b) >>> 0; p = lo * 0x1b3; nlo = p >>> 0; hi = (imul(hi, 0x1b3) + (p − nlo) / 4294967296 + (lo << 8)) >>> 0; lo = nlo`, starting from `lo = 0x84222325, hi = 0xcbf29ce4`. `lo · 0x1b3 < 2^41` is exact.
- **`hashF64(values: Float64Array): Hash64`:** fnv1a64 over the little-endian bytes of each value (DataView), writing every NaN as `0x7FF8000000000000` (§1.7). All SP1 golden digests use it or fnv1a64 over canonical JSON.
- **Vectors:** `fmix32(1) = 1364076727`, `fmix32(0xdeadbeef) = 233162409`; `fnv1a32('a') = 0xe40c292c`, `fnv1a32('foobar') = 0xbf9cf968`; `fnv1a64('') = cbf29ce484222325`, `('a') = af63dc4c8601ec8c`, `('foobar') = 85944171f73967e8`.
- A 3D positional hash with a salt is added (`hash5`) when a later SP first needs one.

### 1.3 `core/rng.ts`

- `splitmix32(seed): () => number`: `s = (s + 0x9e3779b9) | 0; z = s; z ^= z >>> 16; z = imul(z, 0x21f0aaad); z ^= z >>> 15; z = imul(z, 0x735a2d97); z ^= z >>> 15; return z >>> 0`. Vector: `splitmix32(0)` → 1684164658, 3653269916, 2939563536, 2141751570.
- `class Xoshiro128` (xoshiro128** 1.1): the state words a, b, c, d are four successive `splitmix32(seed)` outputs. `nextU32()`: `x = imul(b, 5); x = rotl(x, 7); r = imul(x, 9) >>> 0; t = b << 9; c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11); return r`. Vectors: raw state [1, 2, 3, 4] → 11520, 0, 5927040, 70819200, 2031721883, 1637235492; seed 12345 → 1093274547, 203003357, 3741353573, 3803725158, 4178738660, 810247443.
- `nextFloat() = nextU32() · 2^−32`: exactly one draw per call, so stream consumption is part of determinism.
- `nextInt(n)`, 1 ≤ n ≤ 2^32: `thr = 4294967296 % n; u = nextU32(); while (u < thr) u = nextU32(); return u % n` (unbiased; faster than float-Lemire in JS).

### 1.4 Seed text (`core/seed.ts`)

- `seedFromInput(text)`: `t = text.trim()` (String.prototype.trim only; no Unicode normalisation; case-sensitive). If `t` matches `/^[+-]?[0-9]+$/` and `v = BigInt(t)` lies in [−2^63, 2^64 − 1], the seed is `BigInt.asUintN(64, v)` split into `[lo, hi]`. Otherwise it is `fnv1a64(t)`.
- `seedToText(s)` returns the unsigned decimal of `hi·2^32 + lo`; `seedFromInput(seedToText(s))` equals `s` for every Seed64.
- Consequences: `'-1'` and `'18446744073709551615'` are the same seed (as in Minecraft); `'007'` is 7; `'1e5'` and `'0x10'` are text; `''` is `fnv1a64('')`.
- Vectors: `'007'` → [7, 0]; `'+5'` → [5, 0]; `' 42 '` → [42, 0]; `'-1'` → [4294967295, 4294967295]; `'-9223372036854775808'` → [0, 2147483648]; `'9007199254740993'` → [1, 2097152]; `'18446744073709551616'` → the text hash.
- **Empty box (UI only):** the UI draws `crypto.getRandomValues(new Uint32Array(2))`, writes `seedToText` of it into the box and then parses the box, so the world is always reproducible from the visible text. `core/` never draws randomness.
- BigInt appears only in seed parsing and printing.

### 1.5 `core/detMath.ts`

**Basis (ECMA-262).** `+ − × ÷` are IEEE 754 roundTiesToEven per operation, so engines cannot contract `a*b + c` into an FMA. `Math.sqrt` is correctly rounded. `sin`, `cos`, `exp`, `log`, `pow`, `atan2` and `**` are implementation-approximated, and measured V8, JSC, SpiderMonkey and QuickJS results for them differ. Decimal literals with more than 20 significant digits round in an implementation-defined way, so every coefficient is the shortest round-trip decimal (≤ 17 significant digits) with its bit pattern in a comment. **The operation order in Appendix A is part of the contract.**

| function | domain and specials | design error | acceptance |
|---|---|---|---|
| `detSin(x)`, `detCos(x)` | \|x\| ≤ 2^21; outside, ±∞ and NaN → NaN; `detSin(−x) === −detSin(x)` bitwise (incl. −0 and exact ties), `detCos(−x) === detCos(x)` | ≤ 2e-9 absolute (1.793e-9) | ≤ 2e-6 |
| `detExp(x)` | +0 for x < −745.1332191019412 and −∞; +∞ for x > 709.782712893384; NaN → NaN; `detExp(0) === 1` | ≤ 2.5e-9 relative for results ≥ 2^−1022 (1.975e-9) | ≤ 2e-6 |
| `detExp2(x)` | +0 for x < −1075; +∞ for x ≥ 1024; `detExp2(k) === 2^k` exactly for integers k ∈ [−1074, 1023] | as detExp | ≤ 2e-6 |
| `detErf(x)` | all reals; odd; \|detErf\| ≤ 1; ±∞ → ±1; NaN → NaN; `detErf(±0) = +0`; provably non-decreasing | ≤ 1e-7 absolute (8.497e-8) | ≤ 2e-6 |
| `detSmoothstep(e0, e1, x)` | `t = (x − e0)/(e1 − e0)`, clamped with a ternary, `t·t·(3 − 2·t)`; precondition e0 < e1 (enforced by validation at call sites); NaN → NaN | exact formula | — |

- Algorithms: 3-part Cody–Waite π/2 reduction with degree-7/8 kernels for sin/cos; degree-6 `1 + r·P(r)` kernel plus an exact 2^k table for exp/exp2; `erf = sign(x)·(1 − (1 + |x|·P(|x|))^−16)` with all seven coefficients positive (monotone and branch-free). Remez fits in mpmath.
- Call sites write the remap as `detErf(z * Math.SQRT1_2)`; `z / Math.SQRT2` differs for 86.6 % of z and changes the erf result for 9.2 %.
- detMath uses only `Math.abs`, `Math.floor`, `Math.trunc`, int32 `&`/`|` and one Float64Array table.
- Measured: output bits identical in Node 24 (every V8 tier), Chrome 153, Firefox 152, JavaScriptCore, QuickJS, XS and a Rolldown-minified bundle; cost 0.25-1.6× the engine's `Math.*`.
- The `^1.5` of master §3.12 becomes `s * Math.sqrt(s)`.

### 1.6 Canonical JSON and number normalisation (`core/params/canonical.ts`)

- **`q15(x) = x === 0 ? 0 : Number(x.toPrecision(15))`.** Every numeric validator applies it. ECMA-262 leaves the last digit of Number::toString open (27 % of slider×0.35 values have more than one valid shortest form); `toPrecision` is exactly specified, so after q15 the printed form is unique. q15 is idempotent, turns −0 into +0 and costs about 110 ns.
  - Integer leaves require |v| < 1e15 (q15 changes larger integers).
  - q15 runs before ordering and duplicate checks (spline x).
  - Schema `min`, `max` and `step` must be q15-stable (`buildSchema` throws otherwise), so a q15'd value cannot leave its range.
- **`canonicalJSON(v)`** is RFC 8785 (JCS): keys sorted by UTF-16 code units (default `.sort()`), no whitespace, numbers via Number::toString. It is stricter than JCS: NaN, ±Infinity and −0 throw `CanonicalError` with the path; object keys whose value is `undefined` are omitted; an `undefined` array item throws; only plain objects, arrays, strings, finite numbers, booleans and null are accepted; depth > 64 throws.
- Vector: `{b:1, a:[1,2,{d:1e21,c:1e-7}], 'é':'x', Z:null, u:undefined}` → `{"Z":null,"a":[1,2,{"c":1e-7,"d":1e+21}],"b":1,"é":"x"}`.

### 1.7 NaN policy

- A NaN computed at runtime has platform-dependent bits: `0xFFF8000000000000` in V8, JSC and QuickJS on x86-64, `0x7FF8000000000000` on ARM64 and in XS. Any digest over Float64 bits must therefore canonicalise NaN, which `hashF64` does.
- Stronger rule: **generator outputs are NaN-free.** SP1 asserts it for noise, spline and detMath outputs over their valid domains; DT1/DT2 assert it for ColumnSample, density and spline outputs from SP2 on.

### 1.8 Arch rule changes (`test/arch/rules/banned.ts`)

- The strict `Math` allowlist and the `**`/`**=` ban extend from `gen/` and `core/noise/` to **all of `core/`** plus `gen/`. `fround` leaves the allowlist (master §3.17 forbids it and nothing needs it).
- New bans in `core/` and `gen/`: `Intl`, `.localeCompare(`, `.toLocaleString(`/`toLocaleUpperCase`/`toLocaleLowerCase`/`toLocaleDateString`/`toLocaleTimeString`, `.normalize(`, `TextEncoder`, `TextDecoder`. localeCompare orders differently across engines (measured), and normalize depends on the engine's ICU data (Safari uses the OS copy).
- **Hot-module imports:** in `core/noise/**` and `core/spline/**`, an imported value binding may appear only in its import statement and in top-level alias statements of the form `const NAME = binding;`. Vitest's module transform turns imported bindings into getters, which made the noise code 7-8.5× slower under vitest and would trip the kill criterion falsely. Type-only imports are exempt.
- Each new rule gets `good/` and `bad/` fixtures, as in SP0.

## 2. Noise

### 2.1 `lattice3(s, x, y, z)` (`core/noise/lattice3.ts`)

- Integer cell `X = Math.floor(x)` (likewise Y, Z), fractions `fx = x − X` (likewise fy, fz). Corner c gets gradient `g_c = GRAD[((hash3(s, cX, cY, cZ) & 0xffff) * 12) >>> 16]` and contributes `g_c · (p − c)`.
- **Gradients: the 12 cube edges, balanced.** In index order:
  `GX = [1,−1,1,−1, 1,−1,1,−1, 0,0,0,0]`, `GY = [1,1,−1,−1, 0,0,0,0, 1,−1,1,−1]`, `GZ = [0,0,0,0, 1,1,−1,−1, 1,1,−1,−1]`.
  The index `((h & 0xffff)·12) >>> 16` has a bias of at most 1/65 536 per gradient, below 1e-4 relative on the SD constants.
- Fade `fade(t) = t*t*t*(t*(t*6 − 15) + 10)`. Interpolate along x, then y, then z, always as `a + u*(b − a)`.
- The shipped kernel precomputes the per-axis terms (`imul(X + 1, K) === (imul(X, K) + K) | 0`) and inlines fmix32; a unit test proves it bit-identical to the literal 8-call form.
- There is no permutation table and no period.
- **Why 12 balanced gradients instead of GRAD16 (12 edges + 4 repeats).** Measured N5 (max/min of the 16-bin gradient-direction histogram, n = 200 k, 2 seeds, ≥ 2 lattice terms):

| gradients | 2D slice | 3D horizontal (xz) | 3D vertical (xy) |
|---|---|---|---|
| GRAD16 | 1.03-1.09 | 1.02-1.05 | **1.10-1.22** (fails 1.15) |
| 12 balanced | 1.02-1.08 | 1.02-1.07 | **1.03-1.08** |

  GRAD16's repeats give the vertical derivative 8 % more variance, visible in cliffs, overhangs and caves. The balanced set costs about 4 % more and lets N5 gate vertical planes too.
- **Closed-form SD constants** (exact rational integration of the quintic fade; E[A] = 181/231, E[B] = 535/9009; per-axis gradient energy 2/3, Σ = 2; cross terms 0):
  - `PERLIN3_SD = Math.sqrt(35054270 / 480729249)` = 0.2700350823341202 (3D spatial average; Var3 = Σσ²·E[B]·E[A]²);
  - `PERLIN2_SD = Math.sqrt(2052359 / 24972948)` = 0.2866762789162117 (2D slice at frac(y) = ½; Var2 = E[A]·(σx²·E[B]/2 + σz²·E[B]/2 + σy²·E[A]/8)).
  - Measured with the balanced set: 0.27018 and 0.28661 (1 M points each).

### 2.2 `OctaveNoise` (`core/noise/octave.ts`)

For a world seed, a seed name and a complete NoiseDef:

- `f_0 = 1 / wavelength`, `f_i = f_{i−1} · lacunarity`; `a_0 = 1`, `a_i = a_{i−1} · persistence`, both by repeated multiplication. When `amplitudes` is non-null, `a_i = amplitudes[i]`.
- Octave seed `seed_i = deriveSeed(world, `${name}#${i}`)`.
- Octave origin, in lattice units: `sm = splitmix32(seed_i); ox_i = sm() * 2^−20; oy_i = sm() * 2^−20; oz_i = sm() * 2^−20` (in [0, 4096) with 20 fractional bits, exact dyadic). Integer origins recreated lattice zeros for single-stack small-λ noises (1.16 % at integer points, failing N6).
- **2D fields** sample a fixed slice: `y2_i = Math.floor(oy_i) + 0.5`, value `lattice3(seed_i, x*f_i + ox_i, y2_i, z*f_i + oz_i)`. The master's random fractional y made the slice sd vary from 0.893× to 1.090× and failed N1 per seed.
- **3D fields:** `lattice3(seed_i, x*f_i + ox_i, (y*f_i)*yScale + oy_i, z*f_i + oz_i)`.
- The sum starts at 0 and adds `a_i · lattice3(…)` in octave order. Octaves with `a_i = 0` may be skipped (the result is bit-identical).
- `sumA2 = Σ a_i²` in octave order.

### 2.3 `NormalNoise` (`core/noise/normal.ts`)

- A = `OctaveNoise(world, name, def)`; B = `OctaveNoise(world, `${name}'`, def)` when `def.double` (default true).
- `R = 337 / 331`, evaluated once as a double. B samples at `(x*R, z*R)` in 2D and `(x*R, y*R, z*R)` in 3D.
- `S = Math.sqrt(A.sumA2 + B.sumA2)` (B term absent for a single stack); `invSd2 = 1 / (PERLIN2_SD * S)`, `invSd3 = 1 / (PERLIN3_SD * S)`, computed once per instance.
- `z2(x, z) = clamp((A.sample2(x, z) + B.sample2(x*R, z*R)) * invSd2, −c, c)`; `z3` likewise with `invSd3`; `c = clampSigma` (default 3); `clamp(v) = v < −c ? −c : v > c ? c : v`. The reciprocal multiply is the pinned form (faster than a division, and a different bit pattern).
- Whether a use is 2D or 3D is decided by the caller (the DAG's `noise2` and `noise` ops). The schema leaf's `dims` says how the lab shows it and which normaliser the metrics test.

### 2.4 CDF remap (`core/noise/cdf.ts`)

- `toUniform(z) = detErf(z * Math.SQRT1_2)`; `uMax(c) = detErf(c * Math.SQRT1_2)`, 0.9973002846585164 at c = 3.
- u is approximately uniform on [−uMax, uMax], with the clamped tail mass (about 0.08 % per end for a 6-octave double stack) at the ends. A band inside that range has area share width/2. **No rescale to ±1:** spline knots at ±1 act as end knots (the value holds beyond them), and interior shares stay exact.
- `remap: 'uniform'` requires `double: true` (validation error otherwise): a single stack's erf fit has KS D 0.012-0.023, failing N1.

### 2.5 Schema noises and seed names (`core/params/noises.ts`)

- `noiseInstances(params)` lists every noise instance of the schema as `{ path, seedName, def, dims }`. A noise leaf's seed name defaults to its path; a leaf may set `seedName` to keep its old name (and its worlds) after a rename. Warp leaves yield two instances, `<seedName>.x` and `<seedName>.z`. Octaves append `#i` and stack B appends `'` (§2.2-2.3).
- A unit test asserts that all seed names are distinct and that `fnv1a32` of every name × {`#i`, `'#i`} for i < 16 is distinct, which makes every octave seed distinct within a world.
- SP1 instances: 6 climate fields plus 3 warps × 2 = 12.

### 2.6 Kill criterion (SP1 bench)

- The 512-entry per-octave permutation variant is **removed from `src/`**. It lives only in `test/bench/perm512.ts` as the comparator: its octave 0 repeats with period 256·λ, so it cannot honestly pass N3.
- Criterion: in the same `npm run bench` run, with locally aliased kernels, p50 ns/eval of `lattice3` ÷ p50 of the permutation kernel over (a) a 64×64 coherent slice with step 1/64 cell and (b) 4096 random points in [0, 4096)³. `killRatio` is the larger of the two ratios. **If it exceeds 1.6, SP1 does not exit and the master spec is revisited**; there is no automatic fallback. Measured with GRAD16: 1.06-1.27 (vitest, aliased: 1.11-1.20).

## 3. Splines (`core/spline/`)

### 3.1 Data and semantics

```ts
type SplineCoord = 'C' | 'E' | 'W' | 'PV' | 'T' | 'H';      // coords vector slots 0..5, in this order
interface SplinePoint { x: number; y: number | NestedSpline; d: number }
interface NestedSpline { coord: SplineCoord; points: SplinePoint[] }
type KnotPath = readonly number[];                          // [7, 1, 1] = points[7].y.points[1].y.points[1]
```

- `d` is required. It is dy/dx in output units per unit of the node's own coordinate; the segment formula multiplies it by h = x1 − x0.
- **Outside [x_0, x_{n−1}] the end knot's value holds**; the end tangent is not used. Minecraft extends linearly with the end tangent instead. Hold keeps the output bounded and the editor's y-axis honest; it matters because the master §3.3 C spline ends at 0.60, so C_u ∈ (0.6, 1) (20 % of the world) lies beyond the last knot.
- Segment i is the last knot with x_i ≤ q. For a nested knot, only the two bracketing children are evaluated, at the same coordinate vector. **Canonical formula**, copied exactly by every evaluator: with `h = x1 − x0`, `t = (q − x0)/h`, `dy = y1 − y0`,
  `f = y0 + t*dy + t*(1 − t)*((1 − t)*(d0*h − dy) + t*(dy − d1*h))`.
- A NaN coordinate yields NaN. A 1-point spline is a constant.
- Guarantees: C0 everywhere for valid data; C1 at interior knots by construction (one d per knot); a kink is possible only at a hold boundary with d_end ≠ 0.
- The default offset of master §3.3 has 14 nodes and 52 knots at depth 3; one evaluation visits at most 7 nodes.

### 3.2 Validation (`validateSpline(value, basePath, opts)`)

The single validator; the ParamSchema `spline` leaf calls it. It applies q15 to x, y and d first, then collects every issue in DFS pre-order and never throws. Issues use the ParamSchema format `{ path, code, message }` with paths such as `shape.offset.points[1].y.points[1].x`. It returns `[]` exactly when `compileSpline` succeeds.

| rule | code |
|---|---|
| a spline is a plain object `{coord, points}`; any other key | `NOT_OBJECT`, `UNKNOWN_KEY` |
| `coord` is one of the leaf's allowed coords | `BAD_COORD` |
| `coord` differs from every ancestor's (depth ≤ 6) | `COORD_REUSED` |
| `points` is an array of 1-32 points | `POINTS_NOT_ARRAY`, `EMPTY`, `TOO_MANY_POINTS` |
| each point is `{x, y, d}` | `POINT_NOT_OBJECT`, `UNKNOWN_KEY` |
| x and d are finite numbers | `X_NOT_FINITE`, `D_NOT_FINITE` |
| y is a finite number within the leaf's [min, max], or a nested spline | `Y_NOT_FINITE`, `Y_OUT_OF_RANGE`, `Y_BAD_TYPE` |
| x strictly increases (after q15) | `X_DUPLICATE`, `X_UNSORTED` |
| at most 4096 nodes in the program | `PROGRAM_TOO_LARGE` |

|x| > 1 is legal (unreachable knots); editor lints arrive with the editor (SP2/SP10).

### 3.3 Compiled program (`core/spline/hermite.ts`)

- `compileSpline(s)` validates (throws `SplineValidationError` carrying the issues) and emits an `Int32Array code` plus a `Float64Array nums`, root at `code[0]`, in DFS pre-order:
  - CONST `[0, k]` with value `nums[k]`;
  - LEAF `[1, slot, n, b]` with x[n], d[n], y[n] at `nums[b…]`;
  - MIX `[2, slot, n, b, c0 … c(n−1)]` with x[n], d[n] at `nums[b…]` and child code offsets; numeric points of a MIX become CONST children.
- Every stored number is written as `v + 0` (maps −0 to +0), so equal canonical JSON implies bit-identical programs.
- `evalSpline(p, coords: Float64Array)` is a recursive interpreter that writes results into a per-program register file (`Float64Array` of length 2·depth + 1): a node at register r writes `regs[r]` and its children write r + 1 and r + 2. No double crosses a non-inlined call, so V8 never boxes; it allocates nothing (0 scavenges over 4 M calls) and runs 71-86 ns (offset) and 43-48 ns (mix of 3). A single Float64Array program was no faster than an object walk and allocated about 48 B/eval.
- `evalSplineBatch(p, soa, stride, n, out, scratch)` evaluates n points from a structure-of-arrays buffer, bit-identical to `evalSpline`.
- `evalSplineRef(s, coords)` walks the objects with the same formula: the oracle.
- `withKnotY(s, path, y)` returns a new spline with one knot's y replaced (structural sharing). The editor and the T6 harness share this addressing.

### 3.4 Default tangents (`core/spline/tangents.ts`, authoring only)

`autoTangents(s)` returns the spline with every d rewritten by the **hybrid rule**; it is never called at compile or evaluation time (re-deriving tangents after an edit changed 42 % of columns and lowered 24 % in the spike):

1. Split each node's knots into maximal runs of consecutive numeric knots.
2. In each run of ≥ 2 knots, compute Fritsch–Carlson PCHIP tangents (SciPy end conditions): interior `d_k = 0` if `δ_{k−1}·δ_k ≤ 0`, else `(w1 + w2)/(w1/δ_{k−1} + w2/δ_k)` with `w1 = 2h_k + h_{k−1}`, `w2 = h_k + 2h_{k−1}`; ends `e = ((2h0 + h1)δ0 − h0δ1)/(h0 + h1)`, 0 if `sign(e) ≠ sign(δ0)`, `3δ0` if `sign(δ0) ≠ sign(δ1)` and `|e| > |3δ0|`; a 2-knot run gets `δ0` at both ends.
3. Set d = 0 at every nested knot, at every knot adjacent to a nested knot, at a single-knot run and at end knots strictly inside (−1, 1).
4. Recurse into nested splines.

The rule keeps every segment inside the hull of its end values (no overshoot: jag and sigma never fall below their minimum knot) and avoids kinks at hold boundaries. PCHIP from child means overshot in the spike (1.9 % of offset segments, negative jag). This rule simplifies the spike's variant, which used child means for end formulas; the two differ only at a node end whose third knot is nested.

## 4. ParamSchema (`core/params/`)

### 4.1 Kit (approach A)

- Nodes are plain data (no closures; `structuredClone` works). Builders: `num`, `int`, `bool`, `enumOf`, `noise`, `spline`, `group`, and `buildSchema(root)`. `recordOf` arrives in SP3 (density noises and defs).
- `type Params = Value<typeof ROOT>` and `type ParamsPatch = Patch<typeof ROOT>` are inferred. Each section also gets a named interface, `interface ClimateParams extends Value<typeof ROOT.children.climate> {}`, so hovers and errors show readable names.

```ts
type Placement = { scope: 'live'; stage?: never } | { scope: Exclude<RegenScope, 'live'>; stage: StageId };
type MetaInput = { label: string; doc: string; unit?: string; effectMetric?: MetricId } & Placement;
interface ParamMeta { path: string; label: string; doc: string; unit?: string; kind: ParamKind;
  min?: number; max?: number; step?: number; options?: readonly string[]; dims?: 2 | 3;
  scope: RegenScope; stage?: StageId; effectMetric?: MetricId }
type Value<N> = N extends Leaf<infer T, unknown> ? T : N extends Group<infer C> ? { readonly [K in keyof C]: Value<C[K]> } : never;
type Patch<N> = N extends Leaf<unknown, infer P> ? P : N extends Group<infer C> ? { readonly [K in keyof C]?: Patch<C[K]> } : never;
type Result<T> = { ok: true; value: T } | { ok: false; issues: readonly { path: string; code: IssueCode; message: string }[] };
```

- `ParamMeta.stage` is present exactly when `scope !== 'live'`; enum leaves list `options`; noise leaves carry `dims`.
- `buildSchema` exposes `nodes` (pre-order, declaration order, with depth), `leaves` (with their ParamMeta), `byPath` and validated, deep-frozen `defaults`. It throws on invalid defaults or non-q15-stable bounds.
- `meta.ts` and `defaults.ts` only re-export derived values; the schema is the single source.

### 4.2 Validation and patches

- `applyPatch(schema, base, patch)` is used for profiles, presets, the lab's URL state, panel edits and loading saves. Groups and noise leaves merge per key; every other leaf is replaced whole. It rejects unknown keys (including `__proto__`), applies q15 to every number, collects **all** issues with dotted paths plus `[i]` indices, applies nothing if any issue exists, keeps unchanged subtrees by reference and deep-freezes the result.
- `checkParams(schema, value)` validates a complete document. `diffParams(schema, base, value)` returns the minimal patch; diff → JSON → apply is an identity.
- `getPath(value, path)` and `patchAt(path, value)` address subtrees by dotted path.
- **Validated params hold a complete NoiseDef**, so one noise has one spelling (and one stageHash): `{ wavelength, octaves, persistence, lacunarity, amplitudes, yScale, double, remap, clampSigma }` with defaults persistence 0.5, lacunarity 2, amplitudes `null`, yScale 1, double true, remap `'none'`, clampSigma 3. Only patches may be partial.
- **Noise field ranges** (`NOISE_FIELD_RANGES`, shared by the validator and the lab widgets): wavelength per leaf; octaves integer 1-16; persistence 0.05-1; lacunarity 1.1-4; amplitudes `null` or an array of length `octaves` with finite entries in [−16, 16], not all zero; yScale 0.01-100 and exactly 1 when `dims` is 2; clampSigma 1-8; `remap: 'uniform'` requires `double: true` and `dims: 2`.

### 4.3 SP1 schema: 13 leaves, all scope `climate`, stage `climate`

| path | kind | default | range |
|---|---|---|---|
| `climate.scaleMul` | num | 1 (effectMetric Z4) | 0.25-16, step 0.05 |
| `climate.warp.shift.amplitude` | num, blocks | 48 | 0-1000 |
| `climate.warp.shift.noise` | noise, dims 2 | λ 256, 3 octaves, remap none | λ 16-8192 |
| `climate.warp.C.amplitude` | num, blocks | 180 | 0-1000 |
| `climate.warp.C.noise` | noise, dims 2 | λ 1024, 2 octaves, remap none | λ 16-8192 |
| `climate.warp.R.amplitude` | num, blocks | 120 | 0-1000 |
| `climate.warp.R.noise` | noise, dims 2 | λ 512, 2 octaves, remap none | λ 16-8192 |
| `climate.C` / `E` / `W` / `T` / `H` / `R` | noise, dims 2 | λ 2400 / 1600 / 900 / 5000 / 2400 / 1400; octaves 6 / 5 / 5 / 4 / 4 / 4; remap uniform | λ 64-20000 |

- This fills three gaps in master §3.2: the C and R warps use 2 octaves; every climate noise uses persistence 0.5 and lacunarity 2; warp noises are NormalNoise z values with unit sd.
- `scaleMul` is applied by the SP2 climate stage by dividing the stage's input coordinates before warping, `(x, z) → (x/s, z/s)`: an exact zoom of every climate λ, warp λ and warp amplitude. The lab shows NoiseDefs directly and does not apply it.
- The `spline()` builder ships in SP1 and is exercised only by fixtures; SP2 adds `shape.offset/sigma/jag`.

### 4.4 Profiles (`profiles.ts`)

- `ProfileId = 'default' | 'large_biomes' | 'archipelago' | 'amplified' | 'floating_islands' | 'cave_heavy'`; `PROFILES: Record<ProfileId, { overlay: ParamsPatch; readyFrom: SubProjectId }>`, typed so an overlay typo is a compile error. `resolveProfile(id) = applyPatch(DEFAULTS, overlay)`; a unit test resolves every profile.
- SP1 content: `default {}` (SP1); `large_biomes {climate: {scaleMul: 4}}` (SP2); `archipelago {climate: {C: {wavelength: 840}}}` (SP2, which adds its spline remap); `amplified`, `floating_islands` `{}` (SP3); `cave_heavy {}` (SP6). A profile is hidden in the UI until its `readyFrom` SP (SP2 defines how the UI learns the current SP).
- Neither the seed nor the profile is a parameter leaf. The seed is WorldSession state and enters `genKey` directly; switching profile has the scope of the earliest stage it dirties (`dirtyStages`).

### 4.5 Presets envelope (`presets.ts`)

- Format `{ format: 'wi10-preset', schemaVersion, name, profile, params }`, where `params = diffParams(resolveProfile(profile), draft)`: a patch over the profile, not over the defaults.
- `importPreset(doc)` checks, in order: format → name (profile ids are reserved) → profile → schemaVersion (a newer version is rejected) → `migrate` → `applyPatch(resolveProfile(profile), params)`. It collects every issue with a `params.`-prefixed path. Unknown keys are a hard error.
- Saves and `.wiworld` store full params and load as `migrate` → `applyPatch(DEFAULTS, doc)`, so adding a key never needs a migration.
- SP2 wires the UI (import loads, export writes the draft) and the world URL hash.

### 4.6 Migrations and the schema-shape lock (`migrate.ts`)

- `SCHEMA_VERSION = 1`, `MIGRATIONS: readonly ((doc: JsonObject) => JsonObject)[] = []`, invariant `MIGRATIONS.length === SCHEMA_VERSION − 1`. `migrate(doc, from, migrations = MIGRATIONS)` returns a `Result`; at the current version it is the identity.
- Migrations run on plain JSON and touch only keys that are present, so one migration handles partial patches and full documents. Helpers: `renamePath`, `deletePath`, `mapPath`. The machinery is tested with an injected v1 → v2 list.
- `test/schema-shape.lock.json = { schemaVersion, leaves: { [path]: kind } }`. The U4 `shapeLock` part counts violations:
  - a locked leaf removed, renamed or changing kind while `SCHEMA_VERSION` equals the lock's version: "bump SCHEMA_VERSION and add a migration";
  - leaves added, or `SCHEMA_VERSION` ahead of the lock: "run `npm run test:accept-schema`".
  `ACCEPT_SCHEMA=1` (the new `test:accept-schema` script) rewrites the lock and refuses removals or kind changes without a version bump.
- For every retired version n, a committed fixture `test/fixtures/preset-v{n}.json` must import to `expected-v{n}.json` (none exist in SP1).

### 4.7 README parameter reference

`renderReference(SCHEMA)` renders the parameter table (path, kind, default, range, unit, scope, doc). README.md holds it between `<!-- params:begin -->` and `<!-- params:end -->`; `npm run docs:params` rewrites the block, and the U4 `readme` part fails when it is stale.

## 5. Stage registry and hashes (`core/stage/`)

- `interface StageDef { id: StageId; version: number; reads: readonly StageId[]; params: readonly string[]; checkpoint: 'columnSample' | 'proto' | 'final' | 'none' }`. SP1 registers all 10 stages at version 1; only `climate` has params.

| id | reads | params (SP1) | checkpoint | SCOPE_OF_STAGE |
|---|---|---|---|---|
| climate | — | `climate` | columnSample | climate |
| shape | climate | — | columnSample | terrain |
| surfaceEst | shape | — | columnSample | terrain |
| biome2d | climate, shape, surfaceEst | — | columnSample | terrain |
| terrain | shape, surfaceEst, biome2d | — | proto | terrain |
| decorate | terrain | — | final | decorate |
| light | decorate | — | none | (hosts no params) |
| mesh | light | — | none | remesh |
| lod | surfaceEst, biome2d | — | none | (hosts no params) |
| map | climate, shape, surfaceEst, biome2d | — | none | (hosts no params) |

- `checkRegistry(schema, stages)` returns `[]` when: (1) ids are unique and every `reads` entry names a stage earlier in `STAGES`; (2) every params prefix resolves to a schema node, matched on dot boundaries (`climate.C` does not cover `climate.CX`); (3) no stage covers a live leaf; (4) every non-live leaf's home stage covers it; (5) each leaf's declared scope equals `SCOPE_OF_STAGE` of the first stage, in topological order, that covers it; (6) light, lod and map host no params.
- **stageHash:** `H[S] = fnv1a64(`${S.id}|${S.version}|${canonicalJSON(slice)}|${S.reads.map((r) => hex64(H[r])).join(',')}`)`, with `slice = { [prefix]: getPath(params, prefix) }` over `S.params`. The encoding is injective (ids contain no `|`; canonical JSON is self-delimiting). Stage hashes do not depend on the seed; `dirtyStages(a, b)` is the list of stages whose hash differs.
- **genKey:** `fnv1a64(`${GENERATOR_VERSION}|${seed[0]}|${seed[1]}|${hex64(H.decorate)}`)`, with seed[0] = lo and seed[1] = hi printed as decimal u32.
- `paramsHash(params) = fnv1a64(canonicalJSON(params))`.
- Cost: all stage hashes plus genKey take 30-48 µs for the SP1 schema.

## 6. The `?lab=noise` page (`src/ui/lab/`)

A research page on a 2D canvas (`ImageData`), running on the main thread in slices of ≤ 8 ms per frame. Rendering goes coarse to fine (1/8, 1/2, full resolution) and restarts on any change. A 512² view of a 6-octave double stack costs about 90 ms of work.

**Inspector.**
- Noise selector over the schema's noise instances (`noiseInstances` of the current params; warps expose `.x` and `.z`).
- Seed box with the §1.4 rules (empty → random, written back).
- NoiseDef fields generated from the schema meta and `NOISE_FIELD_RANGES`; edits go through `applyPatch` and invalid values show their issue path inline without being applied.
- Output mode `z` or `u` (u only for `remap: 'uniform'`); one diverging colour map over [−c, c] or [−1, 1].
- Pan by drag, zoom by wheel from 1/16 to 1024 blocks per pixel, clamped to the window [−2^19, 2^19)²; the cursor readout shows world coordinates, z and u.
- 3D-ready: for a `dims: 3` leaf (none in SP1), a plane selector (xz or xy) and a slider for the third coordinate appear.

**Statistics** (from `src/metrics/noiseStats.ts`, the functions the metric tests use). They are computed over 50 000 uniform-random points of the whole window from a fixed stream, not over the visible pixels (neighbouring pixels are correlated and bias the KS statistic):
- mean, sd, min, max and the share of samples at the clamp (±c);
- KS D of u against U(−1, 1);
- a 64-bin histogram with the reference curve (uniform for u, the standard normal for z);
- the 16-bin gradient rose with the N5 definition (§7.3) and its max/min ratio.

**A/B mode.** Two canvases side by side with a shared camera. B starts as a copy of A and may change the seed, the params or both. Each side shows its statistics, and `r(A, B)` is the Pearson correlation over the same sample points.

**URL state.** `?lab=noise#<base64url(canonicalJSON(state))>` with `state = { v: 1, seed, noise, patch, view: { x, z, bpp, mode, plane?, slice? }, b?: { seed?, patch? } }`, where `patch` is a ParamsPatch over DEFAULTS. An invalid hash falls back to defaults with a notice. A unit test round-trips states.

**Determinism panel.** A button recomputes every `sp1.*` golden digest in the browser with `src/metrics/sp1Goldens.ts` and compares it with `test/goldens.json` (a `ui/` import SP0 already allows), showing ✓/✗ per key. It verifies SpiderMonkey (Firefox) and, when a Mac is available, JavaScriptCore (Safari) against the Node-recorded goldens. SP2's `?selftest=1` page extends the same idea to worker-run stages.

## 7. Tests

### 7.1 Unit (`test/unit/`)

- **Hash:** the §1.2 vectors; avalanche 50 ± 2 % (fmix32: N = 100 k per input bit; hash2/3/4: N ≥ 20 k per (word, bit)); `hash2(x, z) ≠ hash2(−x, −z)` for all 1 ≤ x, z < 2000; corner-hash duplicates in [−128, 128)³ within 3σ of the birthday expectation (32 768); `|corr(lattice3(s, p), lattice3(s, Rp))| ≤ 0.02` for R = (x, y, z) → (−x, y, −z) and (−x, −y, −z) (the master formula gave about ±0.1); the UTF-8 walker equals TextEncoder (test-side) on 20 k random strings with lone surrogates; `hashF64` writes computed and literal NaN identically.
- **deriveSeed:** one name × seeds [0, 100 k) gives 0 collisions (a bijection of world[0]); the §2.5 exhaustive name check.
- **RNG:** the §1.3 vectors; `nextInt` with n = 3·2^30, 100 k draws in 3 bins (floor(v / 2^30)): χ² p > 0.01, with plain modulo as a negative control (p ≈ 0).
- **Seed:** the §1.4 table and 100 k random round-trips; the UI empty-box path with an injected random source.
- **detMath** (T-DM1 to T-DM7): error bounds per function and domain (2^20-point grids and random sets, including every k·π/2 ± 4 ulp for |k| ≤ 63 662, the rivers path `detExp(−(t*t))` for t ∈ [0, 50], erf against an in-test Taylor + continued-fraction reference checked against hard-coded mpmath values); the special-value table (`Object.is`); bitwise symmetry; range; monotonicity of erf, exp and exp2 (grids and consecutive-ulp windows, including the k-switch points); constant bits and ≤ 17 significant digits per literal; output digests equal `test/fixtures/detmath-oracle.json`, produced by `tools/detmath-oracle.py` (CPython floats are binary64 with per-operation rounding and no FMA, so the port reproduces the operation order).
- **Canonical JSON and q15:** the §1.6 vector; every rejection case; q15 idempotence, −0 → +0, `q15(0.1 + 0.2) === 0.3`.
- **Noise:** fused `lattice3` equals the 8-call reference bit-for-bit on 300 k points; **SD pin**: the empirical sd of 3D random points and of the 2D slice matches `PERLIN3_SD` and `PERLIN2_SD` within ±0.5 %, per seed, with 4 seeds × 250 k points (per-seed rms error 0.12 %; the 62.5 k size failed 26 % of seed draws); noise outputs finite and NaN-free; octave skipping for zero amplitudes is bit-identical.
- **Splines** (on the master §3.3 offset, sigma and jag knots with `autoTangents`, plus a fixture with non-zero tangents and uneven spacing):
  1. the segment formula equals the textbook Hermite basis within 1e-12;
  2. numeric knots interpolate bit-exactly; a nested knot equals its child at the same coordinates;
  3. hold outside the end knots; 1-point constant; NaN → NaN;
  4. C0 at every knot of every node, |f(nextDown/nextUp(x_i)) − f(x_i)| < 1e-9 over 200 reachable enclosing coordinate vectors;
  5. C1 at interior knots (second-order one-sided differences at h = 1e-5): |D+ − D−| ≤ 1e-3·max(1, |D|), and |D − d_i| at top-level knots; the fixture must catch the "tangent not multiplied by h" mutant;
  6. compiled equals `evalSplineRef` bit-exactly on 1 M random points;
  7. batch equals point bit-exactly;
  8. `withKnotY(+10)` changes f by exactly 10·w (w = product of the value-basis weights along the path, in [0, 1]) within 1e-12 and by 0 outside its support; raising every leaf by 10 shifts f by 10;
  9. one validation case per issue code with its exact path, in DFS order; `compileSpline` throws with the same issues;
  10. −0 knots evaluate to +0; equal canonical JSON gives equal `code`/`nums`;
  11. zero allocation: `v8.GCProfiler` reports 0 scavenges over 4 M `evalSpline` calls after warm-up;
  12. `autoTangents` leaves 0 % of segment evaluations outside their end values on the three fixtures, and returns d = 0 exactly where §3.4 requires it.
- **ParamSchema:** builder and validation cases with exact paths and codes (unknown key, `__proto__`, non-integer, range, enum, noise-field rules, spline leaf); all issues collected and nothing applied on error; 2000 random diff → JSON → apply round-trips; deep freeze; `buildSchema` rejects non-q15-stable bounds and invalid defaults.
- **Stages:** `checkRegistry(SCHEMA, STAGES) = []`, and a broken fixture per invariant produces its message; prefix matching on dot boundaries; stage hashes independent of the seed; `dirtyStages` for single-leaf edits and for each profile switch; the empty SP3/SP6 profiles have the default genKey.
- **Profiles, presets, migrations:** every profile resolves; the import order and its error paths (reserved name, unknown profile, newer schemaVersion, unknown key); export → import is a canonical identity for every profile and 100 random drafts; the injected v1 → v2 rename imports an old document; migrations are the identity at the current version.
- **Lab state:** URL state round-trips; invalid states fall back to defaults.

### 7.2 Arch (`test/arch/`)

The §1.8 rule changes, each with `good/` and `bad/` fixtures; `core/` spike-style code (Math.abs/floor/trunc/imul/sqrt, SQRT1_2, BigInt shifts) passes.

### 7.3 Metrics (`test/metrics/noise.metric.ts`, `params.metric.ts`)

Sampling rules shared by N1-N6 (implemented in `src/metrics/noiseStats.ts`):
- points uniform-random in the colKey window [−2^19, 2^19)² (teleport clamps to ±500 000), from fixed xoshiro streams; 3D points take y uniform in [−64, 320); values are normalised z unless stated;
- seeds are `[s, 0]`; grids and small windows are never used (spatial correlation inflates KS D: grid spacing 256 gave D = 0.061);
- noise sets: **climate** = the 6 fields; **schema** = the 12 instances of §2.5; **adversarial** = test-only single-stack defs (2D λ 16 one octave, 3D λ 8 one octave, 3D λ 32 one octave sampled at 4×8×4 cell corners); **3D** = a test-only density-like def (λ 64, 4 octaves, double, yScale 1).

| id.part | definition | gate | fast | quick | full |
|---|---|---|---|---|---|
| N1.ksD | per (seed, climate field): KS D of `toUniform(z)` against U(−1, 1); max | ≤ 0.015 | 4 seeds × 50 k | 16 × 50 k | 16 × 200 k |
| N1.sdErr | same points: max \|sd(z) − 1\| | ≤ 0.02 | ″ | ″ | ″ |
| N2.maxAbsR | max \|Pearson r\| over all same-seed pairs and over f([b, 0]) vs g([b + k, 0]) for k = 1..K and every ordered pair (f, g) | ≤ 0.02 | climate set, n 50 k, K 8, b 1000 | schema set, n 100 k, K 64, b 1000 | schema set, n 100 k, K 64, b ∈ {1000, 5000} |
| N3.minRatio | min over noises, P ∈ {256, 512, 1024, 2048, 4096} and directions e ∈ {x, z, xz} (+ y for 3D) of mean\|f(p) − f(p + P·λ0·e)\| ÷ mean\|f(a) − f(b)\| (independent random pairs); λ0 = the octave-0 wavelength | ≥ 0.9 | schema + adversarial + 3D, n 5 k | 20 k | 50 k |
| N5.horizontal | noises with octaves × stacks ≥ 2 (2D fields and the xz plane of the 3D def): θ = atan2(∂f/∂z, ∂f/∂x) by central differences with h = λ_min/128 (λ_min = the last octave's wavelength); 16 bins centred on axes and diagonals, `bin = floor((θ + π + π/16)/(2π)·16) mod 16`; max/min | ≤ 1.15 | n 100 k | 200 k | 400 k |
| N5.vertical | the same on the xy plane of the 3D def | ≤ 1.15 | ″ | ″ | ″ |
| N6.zeroRate | max over noises of P(\|z\| < 1e-6) at uniform-random integer points (Z² for 2D, Z³ for 3D) and at random 4×8×4 cell corners for 3D | ≤ 0.001 | schema + adversarial + 3D, 50 k | 200 k | 1 M |
| U4.registryIssues | `checkRegistry(SCHEMA, STAGES).length` (every leaf has meta, scope and a covering stage) | ≤ 0 | all tiers | | |
| U4.migrationFailures | failures of the migration invariant, fixtures and export → import identities | ≤ 0 | all tiers | | |
| U4.shapeLockViolations | §4.6 | ≤ 0 | all tiers | | |
| U4.readmeStale | 1 if the README block differs from `renderReference(SCHEMA)` | ≤ 0 | all tiers | | |

- All parts are `activeFrom: 'SP1'`.
- N2 sizes: from sampling alone, max |r| sits near 4/√n (2319 comparisons for the climate set at K = 64; about 9300 for the schema set). K = 64 therefore needs n ≥ 100 k, which puts the gate at 6.3σ (at 50 k a correct implementation failed on 1 of 18 bases). K = 8 with the climate set at 50 k (303 comparisons) keeps the false-failure estimate near 0.2 %.
- N5 excludes single-lattice-term noises: single-octave gradient noise is intrinsically 1.26-1.52.
- N6 needs the adversarial defs: double stacks and large-λ fields pass even with integer origins, so without them the metric measures nothing.
- Measured in the spike (GRAD16, ±2^22 window; to be re-measured): N1 D 0.0091/0.0089/0.0076 (0.01076 at 16 × 50 k on ±2^19), N2 0.0158/0.0158/0.0119, N3 0.954/0.982/0.982, N5 1.063/1.041/1.033, N6 0.0040 %/0.0005 %/0.0002 %. Fast tier ≈ 3 s under vitest with aliased imports.

### 7.4 Goldens

`src/metrics/sp1Goldens.ts` computes, and `test/unit/goldens.sp1.test.ts` checks with `expectGolden`:
- `sp1.detMath.<fn>`: `hashF64` of each function's outputs over 2^20 fixed inputs per function (from a fixed xoshiro stream over each function's domain) plus the special values;
- `sp1.noise.<seedName>`: `hashF64` of z (and, for uniform fields, u) at 4096 fixed points, seed `seedFromInput('42')`, for every schema instance, plus the 3D test def;
- `sp1.spline.<fixture>`: `hashF64` of `evalSpline` on 4096 fixed coordinate vectors;
- `sp1.params.<profileId>`: fnv1a64 over the `hex64` list of every stage hash and of genKey (seed '42') for that profile; `sp1.params.paramsHash`: `paramsHash(DEFAULTS)`.

`npm run test:goldens` records them. `GENERATOR_VERSION` stays 0, because no existing golden changes.

### 7.5 Bench, baseline and kill criterion (`test/bench/`)

- Kernels: `lattice3` (coherent 64×64 slice, 4096 random 3D points), the perm512 comparator (same inputs), `z2` of `climate.C` (6 × 2), `z3` of the 3D def (4 × 2) at cell corners, `evalSpline` of the offset fixture and a 3-spline mix, `detErf`, and `stageHashes` + `genKey`.
- Method: each bench call loops ≥ 4096 evaluations (a single-call bench measures the harness); hot kernels are aliased locally; every kernel is reported as a ratio to a calibration kernel (a 4096-element `fmix32` loop) measured in the same run, because absolute ns drifted 16 % within one run and 2× across runs under load.
- `test/baselines.json` records, per kernel, `nsPerEval` and `ratio`, plus `killRatio`, the machine, Node version and date. `npm run bench:record` (new script) writes it on the reference machine at SP exit. `npm run bench` fails when a kernel's ratio exceeds its baseline by more than 30 % (P1) or `killRatio` exceeds 1.6.

## 8. Governance steps

- The SP1 branch's first commit appends `'SP1'` to `STARTED_SPS`. Each THRESHOLDS row (N1, N2, N3, N5, N6, U4) is added in the commit that adds its metric test, so every active part is always covered. Each lock change runs `npm run test:accept-thresholds`; the branch also updates this spec (Status line, exit evidence), which satisfies the CI governance check for the range.
- New scripts: `test:accept-schema`, `docs:params`, `bench:record`. CLAUDE.md and README list them.
- CLAUDE.md gains the SP1 conventions: hot-module import aliasing, the NaN rule, the locale-API ban, q15 at validation, and "renaming a noise path needs `seedName`".

## 9. Master-spec amendments made with this spec

In this list, a bold section number is a master section; "here" marks a section of this document.

- **Decisions log:** add **D20** — determinism references are V8 (Chrome, Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari); goldens must match bit-for-bit in all three. XS and QuickJS are not references (XS mis-parses `9007199254740993` and prints non-round-tripping doubles).
- **§1 layout:** detMath exports (§1.5 here); `lattice3` uses 12 balanced gradients; `spline/hermite.ts` compiles to Int32Array code + Float64Array numbers with a register-file evaluator; `core/` adds `seed.ts`, `params/kit.ts`, `params/noises.ts`, `params/presets.ts`, `spline/{types,validate,tangents}.ts`; ParamSchema defaults live in `core/params` (core cannot import `gen/`).
- **§1 banned APIs** (and the SP0 spec's banned-API section): §1.8 here.
- **§2.5 types:** `Seed64 = readonly [lo, hi]` with the u32 invariant, `Hash64` alike; ParamMeta with optional `stage` (exactly when live), `options` and `dims`; NoiseDef complete in validated params (`amplitudes: number[] | null`; `double` defaults to true); SplinePoint `d` units.
- **§2.7:** the genKey preimage and `hex64`; presets store a patch over `resolveProfile(profile)` with the §4.5 import order; saves store full params and load over DEFAULTS.
- **§3.1:** replaced by §1.2-1.4 and §2.1-2.3 here (axis pre-mix, `hash4` defined, 12 balanced gradients, closed-form `PERLIN3_SD` and `PERLIN2_SD`, fractional octave origins in lattice units, fixed 2D slice, stack B name and scale, reciprocal normalisation); the kill criterion becomes §2.6 (no automatic fallback).
- **§3.2:** u lies in [−uMax, uMax] (width/2 shares inside); warp octaves 3/2/2; persistence 0.5 and lacunarity 2; `scaleMul` divides the climate-stage coordinates before warping; noise seed names come from schema paths (`seedName` for renames); `remap: 'uniform'` requires `double`.
- **§3.3:** spline semantics (hold, canonical formula, tangents as explicit data, the hybrid rule, validation rules).
- **§3.12:** `(…)^1.5` → `s * Math.sqrt(s)`.
- **§3.17:** add the ECMA-262 basis (§1.5), the NaN rule (§1.7), the locale/ICU and host-API bans, the hand-written UTF-8 rule, "iteration over plain-object keys only after sorting", and "reciprocal multiply is not a substitute for division unless the formula says so".
- **§5.1:** the stageHash preimage; the scope table's Terrain row drops "profile" and the Climate row notes that the seed is session state; live leaves have no stage.
- **§6.3:** hash/RNG, detMath, spline and preset test definitions as in §7.1 here (presets: an injected v1 → v2 migration, not "v0 → v1").
- **§6.4:** N1, N2, N3, N5, N6 and U4 as in §7.3 here; **T6** becomes a gain: `gain = ΣΔoffset_col / Σw_col` over columns with w_col > 0, where w_col ∈ [0, 1] is the product of Hermite value-basis weights along the raised knot's path (= Δspline_col/10 with fixed tangents), for one knot per depth; gate 10 ± 1.5. As worded, T6 cannot pass for any Hermite spline (mean shifts 5.00, 2.49, 1.26 at depths 1-3).
- **§6.1 / P1:** the §7.5 bench method (calibration ratios, `bench:record`).
- **§8 risk 4 and §9 noise row:** the permutation variant is a bench comparator only.
- **§10:** SP1 exit as in §11 here; SP10's "U4 in full, including README freshness" becomes "U4 (all parts active since SP1)"; SP2's preset item wires the SP1 envelope.

## 10. Notes handed to later SPs

- **SP2:** the pure master §3.3 offset puts about 34 % of land columns in one 10-block band, [66, 76), against T1's ≤ 25 % on the final surface, and 44 % ocean (≤ 63), near the top of B1's 25-45 %. SP2 must confirm that σ, jag and rivers spread the band, or retune the lowland knots (E 0.2 → PV{65, 72, 80}; E 1 → 66/70). SP2 also authors the `shape.*` defaults with `autoTangents`.
- **SP3:** amplified's `offset' = 64 + 1.9·(offset − 64)` is a downstream multiplier, against master §3.3's "no downstream multipliers". Bake it into the profile's spline data (knots and tangents; up to 2.16 blocks of deviation in 0.2-0.3 % of columns) or plot post-transform values in the editor.
- **SP3:** `detSmoothstep` and products of rounded terms are not ulp-monotone (0.15-1.2 % of consecutive-ulp steps decrease, by ≤ 2.11e-16 relative). `boundsCell` must widen such results outward by at least 1 ulp. DAG validation rejects smoothstep with e0 ≥ e1.
- **SP3:** records (`recordOf`) validate keys against `/^[a-z][A-Za-z0-9_]{0,31}$/` and return them sorted; `gen/` iterates records only in sorted key order.
- **gen/ hot loops** follow the same import-aliasing convention; the SP that adds a hot `gen/` module decides whether to extend the arch rule.

## 11. Exit criteria

- `npm run build`, `npm test` and `npm run test:metrics:full` pass, with N1, N2, N3, N5, N6 and U4 active.
- detMath design bounds (§1.5) and acceptance ≤ 2e-6; oracle digests match.
- Spline tests 1-12 pass.
- `PERLIN3_SD` and `PERLIN2_SD` pinned within ±0.5 %.
- `sp1.*` goldens recorded.
- `test/baselines.json` recorded on the reference machine, with `killRatio` ≤ 1.6.
- `?lab=noise` deployed on Vercel and reviewed visually in Chrome and Firefox, with the determinism panel green in both; screenshots (each climate field, a warp, the A/B view) attached under `docs/superpowers/specs/assets/sp1/`.
- **Cut line:** none.

## Exit evidence

(Filled in at SP exit.)

## Appendix A — `core/detMath.ts` reference implementation

Copy verbatim; the operation order is part of the contract.

```ts
const INV_PIO2 = 0.6366197723675814; // 0x3FE45F306DC9C883
const PIO2_1 = 1.5707963267341256; // 0x3FF921FB54400000 (31 significant bits)
const PIO2_2 = 6.077100506303966e-11; // 0x3DD0B4611A600000 (32 significant bits)
const PIO2_3 = 2.0222662487959506e-21; // 0x3BA3198A2E037073
const S1 = -0.16666650669294172; // 0xBFC55553FDCAD915
const S2 = 0.00833197866315709; // 0x3F81105B3EF42E99
const S3 = -0.00019495636237669298; // 0xBF298DA666AF25D2
const C1 = -0.49999999725108224; // 0xBFDFFFFFFD0C621C
const C2 = 0.041666623324344655; // 0x3FA55553E1068F2D
const C3 = -0.001388676379438054; // 0xBF56C087E89A3DB8
const C4 = 0.00002439045070398889; // 0x3EF99343027DE200
function kSin(r: number): number { const z = r * r; return r * (1 + z * (S1 + z * (S2 + z * S3))); }
function kCos(r: number): number { const z = r * r; return 1 + z * (C1 + z * (C2 + z * (C3 + z * C4))); }
const TRIG_MAX = 2097152; // 2^21
export function detSin(x: number): number {
  if (!(Math.abs(x) <= TRIG_MAX)) return NaN;
  const t = x * INV_PIO2;
  const k = Math.trunc(t < 0 ? t - 0.5 : t + 0.5);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const q = k & 3;
  const v = (q & 1) === 0 ? kSin(r) : kCos(r);
  return (q & 2) === 0 ? v : -v;
}
export function detCos(x: number): number {
  if (!(Math.abs(x) <= TRIG_MAX)) return NaN;
  const t = x * INV_PIO2;
  const k = Math.trunc(t < 0 ? t - 0.5 : t + 0.5);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const q = (k + 1) & 3;
  const v = (q & 1) === 0 ? kSin(r) : kCos(r);
  return (q & 2) === 0 ? v : -v;
}
const LOG2E = 1.4426950408889634; // 0x3FF71547652B82FE
const LN2 = 0.6931471805599453; // 0x3FE62E42FEFA39EF
const LN2_HI = 0.6931471803691238; // 0x3FE62E42FEE00000 (fdlibm ln2_hi)
const LN2_LO = 1.9082149292705877e-10; // 0x3DEA39EF35793C76
const TWO_1023 = 8.98846567431158e+307; // 0x7FE0000000000000
const E1 = 1.0000000321650302; // 0x3FF0000008A25D32
const E2 = 0.4999999420905273; // 0x3FDFFFFFC1D1F721
const E3 = 0.1666643126270281; // 0x3FC5554196125B1D
const E4 = 0.04166800203473628; // 0x3FA55582240EC5EC
const E5 = 0.008374155305794656; // 0x3F812678195C2FBD
const E6 = 0.0013843653543488235; // 0x3F56AE72FB0C97F2
const POW2 = new Float64Array(2099); // POW2[k + 1075] = 2^k, k in [-1075, 1023]; entry 0 = +0
{ let v = 1; for (let k = 0; k <= 1023; k++) { POW2[k + 1075] = v; v = v * 2; } v = 0.5; for (let k = -1; k >= -1075; k--) { POW2[k + 1075] = v; v = v * 0.5; } }
function kExp(r: number): number { return 1 + r * (E1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * E6))))); }
function scale(p: number, k: number): number { return k > 1023 ? p * 2 * TWO_1023 : p * POW2[k + 1075]; }
export function detExp(x: number): number {
  if (!(x >= -745.1332191019412)) return x !== x ? x : 0;
  if (x > 709.782712893384) return Infinity;
  const k = Math.floor(x * LOG2E + 0.5) | 0;
  const r = (x - k * LN2_HI) - k * LN2_LO;
  return scale(kExp(r), k);
}
export function detExp2(x: number): number {
  if (!(x >= -1075)) return x !== x ? x : 0;
  if (x >= 1024) return Infinity;
  const k = Math.floor(x + 0.5) | 0;
  return scale(kExp((x - k) * LN2), k);
}
const A1 = 0.0705240212098103; // 0x3FB20DDCBCADB52A
const A2 = 0.042269704761099335; // 0x3FA5A45FEF1EF97B
const A3 = 0.009321899859670404; // 0x3F83175C38455E5B
const A4 = 0.00005736618267948212; // 0x3F0E138F072D7DE3
const A5 = 0.00036130633257334846; // 0x3F37ADB6E1DA7EEC
const A6 = 0.000007131023504472914; // 0x3EDDE8E0D0B60ED0
const A7 = 0.000005746614264949733; // 0x3ED81A614D191411
export function detErf(x: number): number {
  const a = Math.abs(x);
  const q = 1 + a * (A1 + a * (A2 + a * (A3 + a * (A4 + a * (A5 + a * (A6 + a * A7))))));
  const q2 = q * q; const q4 = q2 * q2; const q8 = q4 * q4; const q16 = q8 * q8;
  const r = 1 - 1 / q16;
  return x < 0 ? -r : r;
}
export function detSmoothstep(e0: number, e1: number, x: number): number { // precondition e0 < e1
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
```

Reference erf values (mpmath, dps 40, rounded to double) for the in-test reference check: erf(0.125) = 0.1403162048013338, erf(0.5) = 0.5204998778130465, erf(1) = 0.8427007929497149, erf(1.5) = 0.9661051464753108, erf(2) = 0.9953222650189527, erf(2.1213203435596424) = 0.9973002039367398, erf(2.5) = 0.999593047982555, erf(3) = 0.9999779095030014, erf(4) = 0.9999999845827421, erf(6) = 1.0. `detErf(3 * Math.SQRT1_2) = 0.9973002846585164`.

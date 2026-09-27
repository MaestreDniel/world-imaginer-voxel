# SP1 — Deterministic math core (Design)

Date: 2026-09-27
Status: Approved (2026-09-27); in implementation on branch `sp1/math-core`
Parent: master spec `2026-09-26-architecture-design.md` — §10 SP1, §1, §2.5, §2.7, §3.1-3.3, §3.17, §5.1, §6.3, §6.4, §7, §8 risks 4 and 6; decisions D6, D16, D17 and the new D20.

References written "master §x" point to the master spec; a bare "§x" points to this document.

Evidence: a throwaway SP1 spike (2026-09-27) with four probes (detMath, noise, params, splines), an independent challenge pass (CPython port of detMath, exact rational integration, JavaScriptCore/QuickJS/XS shells), and a review pass that re-implemented the spec from its text. Numbers are measured on the reference i7-12700H with Node 24.21 unless stated otherwise. The spike code is not carried over; this spec is the contract.

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
- No parameter panel, spline editor, world URL hash or preset UI (SP2); no `SETTINGS` schema or `graphicsPresets.ts` (SP5 and later).
- No workers: the lab runs on the main thread (only `engine/` may spawn workers).
- No log, pow or atan2 in detMath (nothing consumes them).

## Decisions (confirmed by the user, 2026-09-27)

| topic | decision |
|---|---|
| lab page | Inspector + A/B comparison: any schema noise, live seed and params, pan/zoom, histogram, gradient rose, statistics; side-by-side view with two seeds or two configs |
| determinism references | **Chrome, Firefox and Safari** (V8, SpiderMonkey, JavaScriptCore); recorded as master decision D20. No JSC job in CI; Safari is checked by hand when a Mac is available |
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
  ids.ts             (existing) + RegenScope, StageId
  hash.ts            Seed64/Hash64, fmix32, axis pre-mix, hash2/3/4, utf8 walker, fnv1a32/64, hex64, hashF64, deriveSeed
  rng.ts             splitmix32, Xoshiro128 (xoshiro128** 1.1)
  seed.ts            seedFromInput, seedToText
  detMath.ts         detSin, detCos, detExp, detExp2, detErf, detSmoothstep (Appendix A)
  noise/types.ts     NoiseDef (complete), NoiseDefPatch
  noise/lattice3.ts  hashed-lattice gradient noise, 12 balanced gradients, PERLIN3_SD, PERLIN2_SD
  noise/octave.ts    OctaveNoise
  noise/normal.ts    NormalNoise
  noise/cdf.ts       toUniform, uMax
  spline/types.ts    SplineCoord, SplinePoint, NestedSpline, KnotPath, SplineOpts
  spline/validate.ts validateSpline, SplineErrorCode, normalizeSpline
  spline/hermite.ts  compileSpline, evalSpline, evalSplineBatch, evalSplineRef, withKnotY
  spline/tangents.ts autoTangents (hybrid rule; authoring only)
  params/canonical.ts q15, canonicalJSON, CanonicalError
  params/kit.ts      node types, builders, Value/Patch, buildSchema, validators, NOISE_FIELD_RANGES, applyPatch/checkParams/
                     diffParams, getPath, patchAt, deepFreeze, renderReference, issue codes
  params/schema.ts   ROOT, SCHEMA, Params, ParamsPatch, ClimateParams (re-exports NOISE_FIELD_RANGES)
  params/meta.ts     derived re-exports only (PARAM_META, metaOf)
  params/defaults.ts derived re-exports only (DEFAULTS)
  params/noises.ts   noiseInstances(schema, params): the schema noise instances with their seed names
  params/profiles.ts ProfileId, PROFILES, resolveProfile
  params/presets.ts  exportPreset, importPreset
  params/migrate.ts  SCHEMA_VERSION, MIGRATIONS, migrate, renamePath/deletePath/mapPath
  stage/registry.ts  StageDef, STAGES, SCOPE_OF_STAGE, checkRegistry
  stage/hash.ts      stageHashes, genKey, dirtyStages, paramsHash
src/metrics/
  noiseStats.ts      point streams, moments, ksUniform, histogram, gradientRose, pearson, aperiodicity, zeroRate
                     (incremental accumulators, so the lab can slice the work)
  sp1Fixtures.ts     frozen fixture data: noise defs, spline fixtures, params fixture schema (Appendix B)
  sp1Goldens.ts      the SP1 golden digests (shared by the unit suite, the lab and the JSC check)
src/ui/
  seedBox.ts         DOM-free seed-box logic (empty → random, written back); SP2 reuses it
  lab/noiseLab.ts labState.ts fieldView.ts statsPanel.ts determinismPanel.ts
tools/detmath-oracle.py     CPython port of detMath (manual oracle; not run in CI)
test/unit/**  test/arch/{schemaShape,paramsDoc}.test.ts  test/metrics/{noise,params}.metric.ts
test/bench/{noise.bench.ts, perm512.ts, gates.ts}  test/tools/goldensJsc.ts
test/schema-shape.lock.json  test/baselines.json  test/fixtures/detmath-oracle.json
```

`main.ts` routes `?lab=noise` first, before the capability probe (the lab needs no SharedArrayBuffer), through a literal `import('./ui/lab/noiseLab')`, so the default bundle does not grow.

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

- **Why the pre-mix.** For odd K, `imul(−v, K) = imul(v, K) ^ (~0 << (tz(v) + 1))`, so the master formula's xor of plain products is unchanged when two coordinates with equal trailing-zero counts are negated. Measured on the master formula: `hash2(x,z) == hash2(−x,−z)` for 33.4 % of positions, 6.6 M duplicate corners in [−128, 128)³ (birthday expectation about 32.7 k), and a correlation of about ±0.1 between the noise and its two-axis reflection. With the pre-mix: 0 equal pairs, 32 808 duplicates, reflection |r| ≤ 0.005. It is also faster.
- **UTF-8.** A hand-written walker feeds the UTF-8 bytes of a string; a lone surrogate encodes as `EF BF BD`, as TextEncoder does. TextEncoder is a host API (absent from the JSC and QuickJS shells) and is banned in `core/`.
- **`fnv1a32(str)`:** `h = 0x811c9dc5`; per byte `h = imul(h ^ b, 0x01000193)`; return `h >>> 0`.
- **`fnv1a64(str)` / `fnv1a64Bytes(bytes)`:** two u32 halves, returned as `[lo, hi]`. Per byte: `lo = (lo ^ b) >>> 0; p = lo * 0x1b3; nlo = p >>> 0; hi = (imul(hi, 0x1b3) + (p − nlo) / 4294967296 + (lo << 8)) >>> 0; lo = nlo`, starting from `lo = 0x84222325, hi = 0xcbf29ce4`. `lo · 0x1b3 < 2^41` is exact.
- **`hashF64(values: Float64Array): Hash64`:** fnv1a64 over the little-endian bytes of each value (DataView), writing every NaN as `0x7FF8000000000000` (§1.7).
- **Vectors:** `fmix32(1) = 1364076727`, `fmix32(0xdeadbeef) = 233162409`; `fnv1a32('a') = 0xe40c292c`, `fnv1a32('foobar') = 0xbf9cf968`; `fnv1a64('') = cbf29ce484222325`, `('a') = af63dc4c8601ec8c`, `('foobar') = 85944171f73967e8`.
- A 3D positional hash with a salt is added (`hash5`) when a later SP first needs one.

### 1.3 `core/rng.ts`

- `splitmix32(seed): () => number`: `s = (s + 0x9e3779b9) | 0; z = s; z ^= z >>> 16; z = imul(z, 0x21f0aaad); z ^= z >>> 15; z = imul(z, 0x735a2d97); z ^= z >>> 15; return z >>> 0`. Vector: `splitmix32(0)` → 1684164658, 3653269916, 2939563536, 2141751570.
- `class Xoshiro128` (xoshiro128** 1.1). `new Xoshiro128(seed: number)` sets the state words a, b, c, d to four successive `splitmix32(seed)` outputs; `Xoshiro128.fromState(a, b, c, d)` sets them directly. `nextU32()`: `x = imul(b, 5); x = rotl(x, 7); r = imul(x, 9) >>> 0; t = b << 9; c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11); return r`. Vectors: `fromState(1, 2, 3, 4)` → 11520, 0, 5927040, 70819200, 2031721883, 1637235492; `new Xoshiro128(12345)` → 1093274547, 203003357, 3741353573, 3803725158, 4178738660, 810247443.
- `nextFloat() = nextU32() * 2.3283064365386963e-10` (2^−32): exactly one draw per call, so stream consumption is part of determinism.
- `nextInt(n)`, 1 ≤ n ≤ 2^32: `thr = 4294967296 % n; u = nextU32(); while (u < thr) u = nextU32(); return u % n` (unbiased; faster than float-Lemire in JS).

### 1.4 Seed text (`core/seed.ts`)

- `seedFromInput(text)`: `t = text.trim()` (String.prototype.trim only; no Unicode normalisation; case-sensitive). If `t` matches `/^[+-]?[0-9]+$/` and `v = BigInt(t)` lies in [−2^63, 2^64 − 1], the seed is `BigInt.asUintN(64, v)` split into `[lo, hi]`. Otherwise it is `fnv1a64(t)`.
- `seedToText(s)` returns the unsigned decimal of `hi·2^32 + lo`; `seedFromInput(seedToText(s))` equals `s` for every Seed64.
- Consequences: `'-1'` and `'18446744073709551615'` are the same seed (as in Minecraft); `'007'` is 7; `'1e5'` and `'0x10'` are text; `''` is `fnv1a64('')`.
- Vectors: `'007'` → [7, 0]; `'+5'` → [5, 0]; `' 42 '` → [42, 0]; `'-1'` → [4294967295, 4294967295]; `'-9223372036854775808'` → [0, 2147483648]; `'9007199254740993'` → [1, 2097152]; `'18446744073709551616'` → the text hash.
- **Empty box (`ui/seedBox.ts`):** when the trimmed box text is empty, the UI draws `crypto.getRandomValues(new Uint32Array(2))`, writes `seedToText` of it into the box and then parses the box, so the world is always reproducible from the visible text. The random source is injected (tests pass a fake). `core/` never draws randomness.
- BigInt appears only in seed parsing and printing, and BigInt constants use shifts, never `**`.

### 1.5 `core/detMath.ts`

**Basis (ECMA-262).** `+ − × ÷` are IEEE 754 roundTiesToEven per operation, so engines cannot contract `a*b + c` into an FMA. `Math.sqrt` is correctly rounded. `sin`, `cos`, `exp`, `log`, `pow`, `atan2` and `**` are implementation-approximated, and measured V8, JSC, SpiderMonkey and QuickJS results for them differ. Decimal literals with more than 20 significant digits round in an implementation-defined way, so every coefficient is the shortest round-trip decimal (≤ 17 significant digits) with its bit pattern in a comment. **The operation order in Appendix A is part of the contract.**

| function | domain and specials | design error | acceptance |
|---|---|---|---|
| `detSin(x)`, `detCos(x)` | \|x\| ≤ 2^21; outside, ±∞ and NaN → NaN; `detSin(−x) === −detSin(x)` bitwise (incl. −0 and exact ties), `detCos(−x) === detCos(x)` | ≤ 2e-9 absolute (1.793e-9) | ≤ 2e-6 |
| `detExp(x)` | +0 for x < −745.1332191019412 and −∞; +∞ for x > 709.782712893384; NaN → NaN; `detExp(0) === 1` | ≤ 2.5e-9 relative for results ≥ 2^−1022 (1.975e-9) | ≤ 2e-6 |
| `detExp2(x)` | +0 for x < −1075; +∞ for x ≥ 1024; `detExp2(k) === 2^k` exactly for integers k ∈ [−1074, 1023] | as detExp | ≤ 2e-6 |
| `detErf(x)` | all reals; odd bitwise for x ≠ 0; `detErf(±0) = +0`; \|detErf\| ≤ 1; ±∞ → ±1; NaN → NaN; provably non-decreasing | ≤ 1e-7 absolute (8.497e-8) | ≤ 2e-6 |
| `detSmoothstep(e0, e1, x)` | `t = (x − e0)/(e1 − e0)`, clamped with a ternary, `t·t·(3 − 2·t)`; precondition e0 < e1 (enforced by validation at call sites); NaN → NaN | exact formula | — |

- Algorithms: 3-part Cody–Waite π/2 reduction with degree-7/8 kernels for sin/cos; degree-6 `1 + r·P(r)` kernel plus an exact 2^k table for exp/exp2; `erf = sign(x)·(1 − (1 + |x|·P(|x|))^−16)` with all seven coefficients positive (monotone and branch-free). Remez fits in mpmath.
- Call sites write the remap as `detErf(z * Math.SQRT1_2)`. `z / Math.SQRT2` differs for most z (85-87 %) and changes the erf result for 5-9 %.
- detMath uses only `Math.abs`, `Math.floor`, `Math.trunc`, int32 `&`/`|` and one Float64Array table.
- Measured: output bits identical in Node 24 (every V8 tier), Chrome 153, Firefox 152, JavaScriptCore, QuickJS, XS and a Rolldown-minified bundle; cost 0.25-1.6× the engine's `Math.*`.
- The `^1.5` of master §3.12 becomes `s * Math.sqrt(s)`.

### 1.6 Canonical JSON and number normalisation (`core/params/canonical.ts`)

- **`q15(x) = x === 0 ? 0 : Number(x.toPrecision(15))`.** Every numeric validator applies it. ECMA-262 leaves the last digit of Number::toString open (27 % of slider×0.35 values have more than one valid shortest form); `toPrecision` is exactly specified, so after q15 the printed form is unique. q15 is idempotent and monotone, turns −0 into +0 and costs about 110 ns.
  - Integer leaves require |v| < 1e15 (q15 changes larger integers).
  - q15 runs before ordering and duplicate checks (spline x).
  - Schema `min`, `max` and `step` must be q15-stable (`buildSchema` throws otherwise), so a q15'd value cannot leave its range.
- **`canonicalJSON(v)`** is RFC 8785 (JCS): keys sorted by UTF-16 code units (default `.sort()`), no whitespace, numbers via Number::toString. It is stricter than JCS: NaN, ±Infinity and −0 throw `CanonicalError` with the path; object keys whose value is `undefined` are omitted; an `undefined` array item throws; only plain objects, arrays, strings, finite numbers, booleans and null are accepted; depth > 64 throws.
- Vector: `{b:1, a:[1,2,{d:1e21,c:1e-7}], 'é':'x', Z:null, u:undefined}` → `{"Z":null,"a":[1,2,{"c":1e-7,"d":1e+21}],"b":1,"é":"x"}`.

### 1.7 NaN policy

- A NaN computed at runtime has platform-dependent bits: `0xFFF8000000000000` in V8, JSC and QuickJS on x86-64, `0x7FF8000000000000` on ARM64 and in XS. Any digest over Float64 bits must therefore canonicalise NaN, which `hashF64` does.
- Stronger rule: **generator outputs are NaN-free.** SP1 asserts it for noise, spline and detMath outputs over their valid domains; DT1/DT2 assert it for ColumnSample, density and spline outputs from SP2 on.

### 1.8 Arch rule changes (`test/arch/rules/banned.ts`)

- The strict `Math` allowlist and the `**`/`**=` ban extend from `gen/` and `core/noise/` to **all of `core/`**, `gen/`, `metrics/sp1Goldens.ts` and `metrics/sp1Fixtures.ts`. `fround` leaves the allowlist (master §3.17 forbids it and nothing needs it). The nondeterminism bans of `core/` (`Math.random`, `Date.now`, `performance.now`, `console.*`) also cover those two metrics files.
- New bans in `core/`, `gen/` and those two metrics files: `Intl`, `.localeCompare(`, `.toLocaleString(`, `.toLocaleUpperCase(`, `.toLocaleLowerCase(`, `.toLocaleDateString(`, `.toLocaleTimeString(`, `.normalize(`, `TextEncoder`, `TextDecoder`. localeCompare orders differently across engines (measured), and normalize depends on the engine's ICU data (Safari uses the OS copy). Naming convention: `core/` and `gen/` never define their own methods called `normalize` or `localeCompare` (a vector normalise is `unit()`), so the literal bans stay unambiguous.
- **Hot-module imports:** in `core/noise/**`, `core/spline/**` and `metrics/**`, an imported **value** binding may be referenced only in its import statement and in top-level alias statements of the form `const NAME = binding;`. Property names after `.` and object-literal keys are not references. Namespace imports (`import * as`) are banned in these directories. A class used only as a type is imported with `import type` (or referred to as `typeof Alias`). Vitest's module transform turns imported bindings into getters, which made the noise code 7-8.5× slower under vitest and would trip the kill criterion falsely.
- Each new rule gets `good/` and `bad/` fixtures, as in SP0.

## 2. Noise

### 2.1 `lattice3(s, x, y, z)` (`core/noise/lattice3.ts`)

- Integer cell `X = Math.floor(x)` (likewise Y, Z), fractions `fx = x − X` (likewise fy, fz). Corner c gets gradient `g_c = GRAD[((hash3(s, cX, cY, cZ) & 0xffff) * 12) >>> 16]` and contributes `g_c · (p − c)`.
- **Gradients: the 12 cube edges, balanced.** In index order:
  `GX = [1,−1,1,−1, 1,−1,1,−1, 0,0,0,0]`, `GY = [1,1,−1,−1, 0,0,0,0, 1,−1,1,−1]`, `GZ = [0,0,0,0, 1,1,−1,−1, 1,1,−1,−1]`.
  The index `((h & 0xffff)·12) >>> 16` gives indices {0, 3, 6, 9} 5462 of 65 536 values and the others 5461; Σσ² stays exactly 2 and the 2D constant moves by 1.7e-6 relative.
- Fade `fade(t) = t*t*t*(t*(t*6 − 15) + 10)`. Interpolate along x, then y, then z, always as `a + u*(b − a)`.
- The shipped kernel precomputes the per-axis terms (`imul(X + 1, K) === (imul(X, K) + K) | 0`) and inlines fmix32; a unit test proves it bit-identical to the literal 8-call form.
- There is no permutation table and no period.
- **Why 12 balanced gradients instead of GRAD16 (12 edges + 4 repeats).** GRAD16's repeats give the vertical derivative 8 % more variance, visible in cliffs, overhangs and caves. Measured N5 (max/min of the 16-bin gradient-direction histogram, ≥ 2 lattice terms):

| gradients | 2D slice | 3D horizontal (xz) | 3D vertical (xy) |
|---|---|---|---|
| GRAD16 | 1.03-1.09 | 1.02-1.05 | 1.10-1.22 (2-term configs above 1.15; a 4-octave double stack 1.10-1.12) |
| 12 balanced | 1.02-1.08 | 1.02-1.07 | 1.03-1.08 |

  The balanced set costs about 4 % more. N5 alone does not catch a GRAD16 regression on the 4-octave 3D def; the SD pin does (PERLIN2_SD would be 2.7 % off, and N1.sdErr rises to 0.033).
- **Closed-form SD constants** (exact rational integration of the quintic fade; E[A] = 181/231, E[B] = 535/9009, A(½) = ½, B(½) = ⅛; per-axis gradient energy 2/3, Σ = 2; cross terms 0):
  - `PERLIN3_SD = Math.sqrt(35054270 / 480729249)` = 0.2700350823341202 (3D spatial average; Var3 = Σσ²·E[B]·E[A]²);
  - `PERLIN2_SD = Math.sqrt(2052359 / 24972948)` = 0.2866762789162117 (2D slice at frac(y) = ½; Var2 = E[A]·(σx²·E[B]/2 + σz²·E[B]/2 + σy²·E[A]/8)).
  - Measured with the balanced set: 0.27018 and 0.28661 (1 M points each).

### 2.2 `OctaveNoise` (`core/noise/octave.ts`)

`new OctaveNoise(world: Seed64, name: string, def: NoiseDef)`, with `sample2(x, z)`, `sample3(x, y, z)` and `sumA2`:

- `f_0 = 1 / wavelength`, `f_i = f_{i−1} · lacunarity`; `a_0 = 1`, `a_i = a_{i−1} · persistence`, both by repeated multiplication. When `amplitudes` is non-null, `a_i = amplitudes[i]`.
- Octave seed `seed_i = deriveSeed(world, `${name}#${i}`)`.
- Octave origin, in lattice units: `sm = splitmix32(seed_i); ox_i = sm() * 2^−20; oy_i = sm() * 2^−20; oz_i = sm() * 2^−20` (in [0, 4096) with 20 fractional bits, exact dyadic). Integer origins recreated lattice zeros for single-stack small-λ noises (0.66-1.97 % at integer points and corners, failing N6).
- **2D fields** sample a fixed slice: `y2_i = Math.floor(oy_i) + 0.5`, value `lattice3(seed_i, x*f_i + ox_i, y2_i, z*f_i + oz_i)`. The master's random fractional y made the slice sd depend on frac(y) (0.87-1.00× the ½-slice value with the balanced set) and failed N1 per seed (D 0.031, sdErr 0.12).
- **3D fields:** `lattice3(seed_i, x*f_i + ox_i, (y*f_i)*yScale + oy_i, z*f_i + oz_i)`.
- The sum starts at 0 and adds `a_i · lattice3(…)` in octave order. Octaves with `a_i = 0` may be skipped (the result is bit-identical).
- `sumA2 = Σ a_i²` in octave order.

### 2.3 `NormalNoise` (`core/noise/normal.ts`)

`new NormalNoise(world: Seed64, name: string, def: NoiseDef)`, with `z2(x, z)`, `z3(x, y, z)` and `clamp` (= c):

- A = `new OctaveNoise(world, name, def)`; B = `new OctaveNoise(world, `${name}'`, def)` when `def.double` (default true).
- `R = 337 / 331`, evaluated once as a double. B samples at `(x*R, z*R)` in 2D and `(x*R, y*R, z*R)` in 3D.
- `S = Math.sqrt(A.sumA2 + B.sumA2)` (B term absent for a single stack); `invSd2 = 1 / (PERLIN2_SD * S)`, `invSd3 = 1 / (PERLIN3_SD * S)`, computed once per instance.
- `z2(x, z) = clamp((A.sample2(x, z) + B.sample2(x*R, z*R)) * invSd2, −c, c)`; `z3` likewise with `invSd3`; `c = clampSigma` (default 3); `clamp(v) = v < −c ? −c : v > c ? c : v`. The reciprocal multiply is the pinned form (faster than a division, and a different bit pattern).
- Octaves and stacks are independent, so the variance of the sum is Σa²·SD² and sd(z) ≈ 1 (measured per seed |sd(z) − 1| ≤ 0.011 at 50 k points).
- Whether a use is 2D or 3D is decided by the caller (the DAG's `noise2` and `noise` ops). The schema leaf's `dims` says how the lab shows it and which normaliser the metrics test.

### 2.4 CDF remap (`core/noise/cdf.ts`)

- `toUniform(z) = detErf(z * Math.SQRT1_2)`; `uMax(c) = detErf(c * Math.SQRT1_2)`, 0.9973002846585164 at c = 3.
- u is approximately uniform on [−uMax, uMax], with the clamped tail mass (about 0.09 % per end for the climate fields) at the ends. A band inside that range has area share width/2. **No rescale to ±1:** spline knots at ±1 act as end knots (the value holds beyond them), and interior shares stay exact.
- `remap: 'uniform'` requires `double: true` (validation error otherwise). This is a design choice for margin, not something N1 enforces: single stacks also pass N1 with the balanced set (max D 0.0121 at 16 × 50 k), but with less margin than double stacks.

### 2.5 Schema noises and seed names (`core/params/noises.ts`)

- `noiseInstances(schema, params)` lists every noise instance as `{ path, seedName, def, dims }`, in schema pre-order. A noise leaf's seed name is its `seedName` option, or its path when absent; `seedName` keeps an old name (and its worlds) after a rename. A leaf with `components: ['x', 'z']` (the warps) yields two instances, `<seedName>.x` and `<seedName>.z`. Octaves append `#i` and stack B appends `'` (§2.2-2.3).
- A unit test asserts that all seed names are distinct and that `fnv1a32` of every name × {`#i`, `'#i`} for i < 16 is distinct (384 values for SP1), which makes every octave seed distinct within a world.
- SP1 instances: 6 climate fields plus 3 warps × 2 = 12.

### 2.6 Kill criterion (SP1 bench)

- The 512-entry per-octave permutation variant is **removed from `src/`**. It lives only in `test/bench/perm512.ts` as the comparator: its octave 0 repeats with period 256·λ, so it cannot honestly pass N3.
- **perm512 definition** (bench only): per octave seed s, `P = new Uint8Array(512)` with `P[i] = i` for i < 256; then for i = 255 down to 1, `j = r.nextInt(i + 1)` with `r = new Xoshiro128(s)` and swap `P[i]`, `P[j]`; then `P[i + 256] = P[i]`. Corner hash `h = P[P[P[X & 255] + (Y & 255)] + (Z & 255)]`, gradient `GRAD[h % 12]` from the same 12-gradient set, and the same fade, lerp order and dot-product form as `lattice3`. `P` is read through a local alias.
- Criterion: in the same `npm run bench` run, with locally aliased kernels, the p50 ns/eval ratio `lattice3 / perm512` is measured over (a) a 64×64 coherent slice with step 1/64 cell and (b) 4096 random points in [0, 4096)³. `killRatio` is the larger of the two. **If it exceeds 1.6, SP1 does not exit and the master spec is revisited**; there is no automatic fallback. Measured with GRAD16: 1.06-1.27 (vitest, aliased: 1.11-1.20); the balanced set adds about 4 %.

## 3. Splines (`core/spline/`)

### 3.1 Data and semantics

```ts
type SplineCoord = 'C' | 'E' | 'W' | 'PV' | 'T' | 'H';      // coords vector slots 0..5, in this order
interface SplinePoint { x: number; y: number | NestedSpline; d: number }
interface NestedSpline { coord: SplineCoord; points: SplinePoint[] }
type KnotPath = readonly number[];                          // [7, 1, 1] = points[7].y.points[1].y.points[1]
interface SplineOpts { coords?: readonly SplineCoord[]; yMin?: number; yMax?: number }   // default: all coords, y unbounded
```

- `d` is required. It is dy/dx in output units per unit of the node's own coordinate; the segment formula multiplies it by h = x1 − x0.
- **Outside [x_0, x_{n−1}] the end knot's value holds**; the end tangent is not used. Minecraft extends linearly with the end tangent instead. Hold keeps the output bounded and the editor's y-axis honest; it matters because the master §3.3 C spline ends at 0.60, so C_u ∈ (0.6, 1) (20 % of the world) lies beyond the last knot.
- Segment i is the last knot with x_i ≤ q. For a nested knot, only the two bracketing children are evaluated, at the same coordinate vector. **Canonical formula**, copied exactly by every evaluator: with `h = x1 − x0`, `t = (q − x0)/h`, `dy = y1 − y0`,
  `f = y0 + t*dy + t*(1 − t)*((1 − t)*(d0*h − dy) + t*(dy − d1*h))`.
- A NaN coordinate yields NaN. A 1-point spline is a constant.
- Guarantees: C0 everywhere for valid data; C1 at interior knots by construction (one d per knot); a kink is possible only at a hold boundary with d_end ≠ 0.
- The master §3.3 default offset has 14 spline objects and 52 knots at depth 3; one evaluation visits at most 7 spline objects.

### 3.2 Validation (`validateSpline(value, basePath, opts?)`)

The single validator; the ParamSchema `spline` leaf calls it with the leaf's coords and [min, max]. It applies q15 to x, y and d first, then collects every issue in DFS pre-order and never throws. Issues use the ParamSchema format `{ path, code, message }`. It returns `[]` exactly when `compileSpline(value, opts)` succeeds with the same opts.

| rule | code | path |
|---|---|---|
| a spline is a plain object `{coord, points}` | `NOT_OBJECT` | the spline |
| no other key | `UNKNOWN_KEY` | `<spline>.<key>` |
| `coord` is one of the allowed coords | `BAD_COORD` | `<spline>.coord` |
| `coord` differs from every ancestor's (depth ≤ 6) | `COORD_REUSED` | `<spline>.coord` |
| `points` is an array of 1-32 points | `POINTS_NOT_ARRAY`, `EMPTY`, `TOO_MANY_POINTS` | `<spline>.points` |
| each point is `{x, y, d}` with no other key | `POINT_NOT_OBJECT`, `UNKNOWN_KEY` | `<spline>.points[i]`, `….<key>` |
| x and d are finite numbers | `X_NOT_FINITE`, `D_NOT_FINITE` | `….x`, `….d` |
| y is a finite number within [yMin, yMax], or a nested spline | `Y_NOT_FINITE`, `Y_OUT_OF_RANGE`, `Y_BAD_TYPE` | `….y` |
| x strictly increases (after q15) | `X_DUPLICATE`, `X_UNSORTED` | the later point's `.x` |
| at most 4096 spline objects in total | `PROGRAM_TOO_LARGE` | `basePath` |

Paths look like `shape.offset.points[1].y.points[1].x`. |x| > 1 is legal (unreachable knots); editor lints arrive with the editor (SP2/SP10). `normalizeSpline(s)` returns the spline with every number replaced by `q15(v) + 0`.

### 3.3 Compiled program (`core/spline/hermite.ts`)

- `compileSpline(s, opts?)` validates (throws `SplineValidationError` carrying the issues), then compiles `normalizeSpline(s)` into an `Int32Array code` plus a `Float64Array nums`, root at `code[0]`, in DFS pre-order:
  - CONST `[0, k]` with value `nums[k]`;
  - LEAF `[1, slot, n, b]` with x[n], d[n], y[n] at `nums[b…]`;
  - MIX `[2, slot, n, b, c0 … c(n−1)]` with x[n], d[n] at `nums[b…]` and child code offsets; numeric points of a MIX become CONST children.
  Equal canonical JSON therefore implies bit-identical programs.
- `evalSpline(p, coords: Float64Array)` is a recursive interpreter that writes results into a per-program register file (`Float64Array` of length 2·depth + 1): a node at register r writes `regs[r]` and its children write r + 1 and r + 2. No double crosses a non-inlined call, so V8 never boxes; it allocates nothing and runs 71-86 ns (offset) and 43-48 ns (mix of 3). A single Float64Array program was no faster than an object walk and allocated about 48 B/eval.
- `evalSplineBatch(p, soa, stride, n, out, scratch)` evaluates n points from a structure-of-arrays buffer, bit-identical to `evalSpline`.
- `evalSplineRef(s, coords)` walks the objects with the same formula, reading every number as `q15(v) + 0`: the oracle, bit-identical to the compiled program.
- `withKnotY(s, path, y)` returns a new spline with one knot's y replaced (structural sharing). The editor and the T6 harness share this addressing.

### 3.4 Default tangents (`core/spline/tangents.ts`, authoring only)

`autoTangents(s)` returns the spline with every d rewritten by the **hybrid rule**, each d stored as `q15(d) + 0`. It is never called at compile or evaluation time (re-deriving tangents after an edit changed 42 % of columns and lowered 24 % in the spike):

1. Split each node's knots into maximal runs of consecutive numeric knots.
2. In each run of ≥ 2 knots, compute Fritsch–Carlson PCHIP tangents with SciPy end conditions. Interior: `d_k = 0` if `δ_{k−1}·δ_k ≤ 0`, else `(w1 + w2)/(w1/δ_{k−1} + w2/δ_k)` with `w1 = 2h_k + h_{k−1}`, `w2 = h_k + 2h_{k−1}`. Left end: `e = ((2h0 + h1)δ0 − h0δ1)/(h0 + h1)`, then 0 if `sign(e) ≠ sign(δ0)`, else `3δ0` if `sign(δ0) ≠ sign(δ1)` and `|e| > |3δ0|`; the right end mirrors it with `h_{n−2}, h_{n−3}, δ_{n−2}, δ_{n−3}`. A 2-knot run gets `δ0` at both ends.
3. Set d = 0 at every nested knot, at every knot adjacent to a nested knot, at a single-knot run and at end knots strictly inside (−1, 1).
4. Recurse into nested splines.

In exact arithmetic the rule keeps every segment inside the hull of its end values (PCHIP tangents stay in the monotone region [0, 3δ]², and zeroing stays inside it), and it avoids kinks at hold boundaries. In floating point the canonical formula can leave the hull by a few ulp near knots (measured ≤ 2.8e-14 on offset; jag reached −3.6e-15), so the guarantee is **inside the hull up to 4 ulp of max(|y0|, |y1|)**, and consumers that need a non-negative value (jag, σ) clamp with `max(0, ·)`. PCHIP from child means overshot in the spike (1.9 % of offset segments, negative jag by −0.33). This rule simplifies the spike's variant, which used child means for end formulas; the two differ only at a node end whose third knot is nested.

## 4. ParamSchema (`core/params/`)

### 4.1 Kit (approach A)

Nodes are plain data (no closures; `structuredClone` works). `type Params = Value<typeof ROOT>` and `type ParamsPatch = Patch<typeof ROOT>` are inferred, and each section gets a named interface (`interface ClimateParams extends Value<typeof ROOT.children.climate> {}`) so hovers and errors show readable names.

```ts
type ParamKind = 'number' | 'int' | 'bool' | 'enum' | 'noise' | 'spline' | 'expr' | 'boxTable' | 'ruleTree'
  | 'featureList' | 'structureSets';                        // master §2.5; SP1 builders produce the first six
type Placement = { scope: 'live'; stage?: never } | { scope: Exclude<RegenScope, 'live'>; stage: StageId };
type MetaInput = { label: string; doc: string; unit?: string; effectMetric?: MetricId } & Placement;
interface ParamMeta { path: string; label: string; doc: string; unit?: string; kind: ParamKind;
  min?: number; max?: number; step?: number; options?: readonly string[]; dims?: 2 | 3; coords?: readonly SplineCoord[];
  scope: RegenScope; stage?: StageId; effectMetric?: MetricId }
interface Leaf<T, P = T> { readonly tag: 'leaf'; readonly kind: ParamKind; readonly merge: 'atomic' | 'fields';
  readonly def: T; readonly meta: ParamMeta; readonly seedName?: string; readonly components?: readonly ['x', 'z'];
  readonly __patch?: P /* phantom */ }
interface Group<C> { readonly tag: 'group'; readonly label: string; readonly doc: string; readonly children: C }
type Value<N> = N extends Leaf<infer T, unknown> ? T : N extends Group<infer C> ? { readonly [K in keyof C]: Value<C[K]> } : never;
type Patch<N> = N extends Leaf<unknown, infer P> ? P : N extends Group<infer C> ? { readonly [K in keyof C]?: Patch<C[K]> } : never;
interface Issue { path: string; code: IssueCode; message: string }
type Result<T> = { ok: true; value: T } | { ok: false; issues: readonly Issue[] };

num(def: number, meta: MetaInput & { min: number; max: number; step?: number }): Leaf<number>;
int(def: number, meta: MetaInput & { min: number; max: number; step?: number }): Leaf<number>;
bool(def: boolean, meta: MetaInput): Leaf<boolean>;
enumOf<const V extends readonly [string, ...string[]]>(options: V, def: V[number], meta: MetaInput): Leaf<V[number]>;
noise(def: Pick<NoiseDef, 'wavelength' | 'octaves'> & Partial<NoiseDef>, meta: MetaInput & {
  wavelength: { min: number; max: number }; dims: 2 | 3; seedName?: string; components?: readonly ['x', 'z'] }): Leaf<NoiseDef, NoiseDefPatch>;
spline(def: NestedSpline, meta: MetaInput & { coords: readonly SplineCoord[]; min: number; max: number }): Leaf<NestedSpline>;
group<const C extends Record<string, Leaf<unknown, unknown> | Group<unknown>>>(label: string, doc: string, children: C): Group<C>;
buildSchema<R extends Group<unknown>>(root: R): Schema<R>;
// Schema<R> = { root: R; nodes: readonly {path, depth, node}[] (pre-order, declaration order); leaves: readonly {path, leaf}[];
//               byPath: ReadonlyMap<string, Leaf | Group>; defaults: Value<R> (validated, deep-frozen) }
```

- `ParamMeta.stage` is present exactly when `scope !== 'live'`; enum leaves list `options`; noise leaves carry `dims`; spline leaves carry `coords`.
- `buildSchema` throws on invalid defaults or non-q15-stable bounds.
- `meta.ts` and `defaults.ts` only re-export derived values; the schema is the single source. `RegenScope` and `StageId` live in `core/ids.ts`; `NoiseDef` and `NoiseDefPatch` in `core/noise/types.ts`.
- `recordOf` arrives in SP3 (density noises and defs).

### 4.2 Validation and patches

```ts
applyPatch<R>(s: Schema<R>, base: Value<R>, patch: unknown): Result<Value<R>>;
checkParams<R>(s: Schema<R>, value: unknown): Result<Value<R>>;
diffParams<R>(s: Schema<R>, base: Value<R>, value: Value<R>): Patch<R>;
getPath(value: unknown, path: string): unknown;   patchAt(path: string, value: unknown): JsonObject;
```

- **Validity.** A number is valid iff it is finite, lies in [min, max] inclusive after q15 and, for `int`, is an integer with |v| < 1e15. `step` is a UI hint: validators never snap to it.
- **applyPatch** is used for profiles, presets, the lab's URL state, panel edits and loading saves. Groups and noise leaves merge per key; every other leaf is replaced whole. It rejects unknown keys (including `__proto__`), applies q15 to every number, collects **all** issues, applies nothing if any issue exists, and deep-freezes the result. A subtree the patch does not mention is kept by reference; an `undefined` patch value means absent.
- **checkParams** validates a complete document with the same rules.
- **diffParams** recurses into groups and noise leaves. A noise leaf contributes only the NoiseDef keys whose canonical JSON differs (`amplitudes` as a whole array); any other leaf appears whole iff its canonical JSON differs; empty groups and noise leaves are omitted; equal inputs give `{}`. diff → JSON → apply is an identity.
- **Validated params hold a complete NoiseDef**, so one noise has one spelling (and one stageHash): `{ wavelength, octaves, persistence, lacunarity, amplitudes, yScale, double, remap, clampSigma }` with defaults persistence 0.5, lacunarity 2, amplitudes `null`, yScale 1, double true, remap `'none'`, clampSigma 3. Only patches may be partial.
- **`NOISE_FIELD_RANGES`** (in `kit.ts`, shared by the validator and the lab widgets; wavelength ranges are per leaf): octaves integer 1-16 (step 1); persistence 0.05-1 (0.01); lacunarity 1.1-4 (0.01); each amplitude −16-16 (0.01); yScale 0.01-100 (0.01), exactly 1 when `dims` is 2; clampSigma 1-8 (0.1). `amplitudes` is `null` or an array of length `octaves`, not all zero; `remap: 'uniform'` requires `double: true` and `dims: 2`.
- **Issue codes** (`IssueCode` is the union of these and the spline codes of §3.2):

| family | codes |
|---|---|
| params | `UNKNOWN_KEY`, `MISSING_KEY`, `NOT_OBJECT`, `NOT_NUMBER`, `NOT_FINITE`, `NOT_INTEGER`, `INT_TOO_LARGE`, `OUT_OF_RANGE`, `NOT_BOOL`, `BAD_ENUM`, `AMPLITUDES_LENGTH`, `AMPLITUDES_ZERO`, `YSCALE_NOT_1`, `REMAP_NEEDS_DOUBLE`, `REMAP_NEEDS_2D` |
| presets | `BAD_FORMAT`, `BAD_NAME`, `RESERVED_NAME`, `UNKNOWN_PROFILE`, `BAD_SCHEMA_VERSION`, `NEWER_SCHEMA_VERSION` |
| migrations | `MIGRATION_FAILED` |

- **Issue paths.** The path is the offending value's dotted path, with `[i]` for array indices. Cross-field NoiseDef rules report at `<leaf>.amplitudes`, `<leaf>.yScale` or `<leaf>.remap`. Root-level issues use `''`. Issues are ordered by schema pre-order, then array index.

### 4.3 SP1 schema: 13 leaves, all scope `climate`, stage `climate`

| path | kind | default | range |
|---|---|---|---|
| `climate.scaleMul` | number | 1 (effectMetric Z4) | 0.25-16, step 0.05 |
| `climate.warp.shift.amplitude` | number, blocks | 48 | 0-1000 |
| `climate.warp.shift.noise` | noise, dims 2, components x/z | λ 256, 3 octaves, remap none | λ 16-8192 |
| `climate.warp.C.amplitude` | number, blocks | 180 | 0-1000 |
| `climate.warp.C.noise` | noise, dims 2, components x/z | λ 1024, 2 octaves, remap none | λ 16-8192 |
| `climate.warp.R.amplitude` | number, blocks | 120 | 0-1000 |
| `climate.warp.R.noise` | noise, dims 2, components x/z | λ 512, 2 octaves, remap none | λ 16-8192 |
| `climate.C` / `E` / `W` / `T` / `H` / `R` | noise, dims 2 | λ 2400 / 1600 / 900 / 5000 / 2400 / 1400; octaves 6 / 5 / 5 / 4 / 4 / 4; remap uniform | λ 64-20000 |

- This fills three gaps in master §3.2: the C and R warps use 2 octaves; every climate noise uses persistence 0.5 and lacunarity 2; warp noises are NormalNoise z values with unit sd.
- `scaleMul` is applied by the SP2 climate stage by dividing the stage's input coordinates before warping, `(x, z) → (x/s, z/s)`: an exact zoom of every climate λ, warp λ and warp amplitude. The lab shows NoiseDefs directly and does not apply it.
- The `spline()` builder ships in SP1 and is exercised only by fixtures; SP2 adds `shape.offset/sigma/jag`.

### 4.4 Profiles (`profiles.ts`)

- `ProfileId = 'default' | 'large_biomes' | 'archipelago' | 'amplified' | 'floating_islands' | 'cave_heavy'`; `PROFILES: Record<ProfileId, { overlay: ParamsPatch; readyFrom: SubProjectId }>`, typed so an overlay typo is a compile error. `resolveProfile(id): Params` is `applyPatch(SCHEMA, DEFAULTS, overlay)` and throws on an invalid overlay (a unit test resolves every profile, so it never throws at runtime).
- SP1 content: `default {}` (SP1); `large_biomes {climate: {scaleMul: 4}}` (SP2); `archipelago {climate: {C: {wavelength: 840}}}` (SP3, which drafts its spline remap, per master §10); `amplified`, `floating_islands` `{}` (SP3); `cave_heavy {}` (SP6). "Profiles" are the master's built-in world presets (master §3.15).
- A profile is hidden in the UI until its `readyFrom` SP. The UI cannot import `test/harness/sp.ts`, so SP2 adds a `src/`-side constant for the current SP.
- Neither the seed nor the profile is a parameter leaf. The seed is WorldSession state and enters `genKey` directly; switching profile has the scope of the earliest stage it dirties (`dirtyStages`).

### 4.5 Presets envelope (`presets.ts`)

```ts
interface PresetDoc { format: 'wi10-preset'; schemaVersion: number; name: string; profile: ProfileId; params: ParamsPatch }
exportPreset(name: string, profile: ProfileId, draft: Params): PresetDoc;
importPreset(doc: unknown): Result<{ name: string; profile: ProfileId; params: Params }>;
```

- `params = diffParams(SCHEMA, resolveProfile(profile), draft)`: a patch over the profile, not over the defaults.
- `importPreset` reports unknown envelope keys first (all of them, `UNKNOWN_KEY`). Then it checks format, name, profile and schemaVersion in that order and stops at the first failure (one issue at that field's path). Then `migrate` runs (a failure is one `MIGRATION_FAILED` issue at `params`). Then it reports every `applyPatch(SCHEMA, resolveProfile(profile), params)` issue with a `params.` prefix.
- A name is a string whose trim is 1-64 UTF-16 units and is not a ProfileId (case-sensitive); the trimmed name is stored. A newer schemaVersion is rejected (`NEWER_SCHEMA_VERSION`).
- Saves and `.wiworld` store full params and load as `migrate` → `applyPatch(SCHEMA, DEFAULTS, doc)`, so adding a key never needs a migration.
- SP2 wires the UI (import loads, export writes the draft) and the world URL hash (which must carry the profile id).

### 4.6 Migrations and the schema-shape lock (`migrate.ts`)

- `SCHEMA_VERSION = 1`, `MIGRATIONS: readonly Migration[] = []` with `type Migration = (doc: JsonObject) => JsonObject`, invariant `MIGRATIONS.length === SCHEMA_VERSION − 1`. `migrate(doc, from, migrations = MIGRATIONS): Result<JsonObject>`; at the current version it is the identity.
- Migrations run on plain JSON and touch only keys that are present, so one migration handles partial patches and full documents. Helpers: `renamePath`, `deletePath`, `mapPath`. The machinery is tested with an injected v1 → v2 list.
- `test/schema-shape.lock.json = { schemaVersion, leaves: { [path]: kind } }`. The U4 `shapeLockViolations` part counts:
  - each locked leaf removed, renamed or changing kind while `SCHEMA_VERSION` equals the lock's version ("bump SCHEMA_VERSION and add a migration");
  - one violation when leaves were added, when `SCHEMA_VERSION` is ahead of the lock, or when the lock file is missing ("run `npm run test:accept-schema`").
- `npm run test:accept-schema` = `ACCEPT_SCHEMA=1 vitest run --project arch test/arch/schemaShape.test.ts`: it rewrites the lock and refuses removals or kind changes without a version bump.
- For every retired version n, a committed fixture `test/fixtures/preset-v{n}.json` must import to `expected-v{n}.json` (none exist in SP1).

### 4.7 README parameter reference

- `renderReference(schema)` renders a Markdown table with the columns path | kind | default | range | unit | scope | doc, one row per leaf in schema pre-order. A NoiseDef default renders as its canonical JSON; `|` in any cell is escaped as `\|`.
- README.md holds it between `<!-- params:begin -->` and `<!-- params:end -->`. `npm run docs:params` = `WRITE_PARAMS_DOC=1 vitest run --project arch test/arch/paramsDoc.test.ts` rewrites the block; the U4 `readmeStale` part fails when it differs.

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

- `checkRegistry(schema, stages)` returns `[]` when: (1) ids are unique and every `reads` entry names a stage earlier in `stages`; (2) every params prefix resolves to a schema node, matched on dot boundaries (`climate.C` does not cover `climate.CX`); (3) no stage covers a live leaf; (4) every non-live leaf's home stage covers it; (5) each leaf's declared scope equals `SCOPE_OF_STAGE` of the first stage, in `stages` order, that covers it; (6) light, lod and map host no params.
- `stageHashes(params, stages = STAGES): Record<StageId, Hash64>`: `H[S] = fnv1a64(`${S.id}|${S.version}|${canonicalJSON(slice)}|${S.reads.map((r) => hex64(H[r])).join(',')}`)`, with `slice = { [prefix]: getPath(params, prefix) }` over `S.params`. The encoding is injective (ids contain no `|`; canonical JSON is self-delimiting). Stage hashes do not depend on the seed; `dirtyStages(a, b)` lists, in `STAGES` order, the stages whose hash differs.
- `genKey(seed, H) = fnv1a64(`${GENERATOR_VERSION}|${seed[0]}|${seed[1]}|${hex64(H.decorate)}`)`, with seed[0] = lo and seed[1] = hi printed as decimal u32.
- `paramsHash(params) = fnv1a64(canonicalJSON(params))`.
- Cost: all stage hashes plus genKey take 30-48 µs for the SP1 schema.

## 6. The `?lab=noise` page (`src/ui/lab/`)

A research page on a 2D canvas (`ImageData`) whose backing store matches its CSS size (device pixel ratio 1). It runs on the main thread in slices of ≤ 8 ms per frame: rendering goes coarse to fine (1/8, 1/2, full resolution) and restarts on any change. A full pass over 1600×900 px of a 6-octave double stack is about 0.5 s of work (about 1 s wall time in slices).

**Inspector.**
- Noise selector: the schema's noise instances (`noiseInstances` of the current params; warps expose `.x` and `.z`), plus a "test" group with the 3D and adversarial fixture defs (`sp1Fixtures.ts`), so the 3D controls can be reviewed.
- Seed box with the §1.4 rules (`ui/seedBox.ts`: empty → random, written back).
- NoiseDef fields generated from the schema meta and `NOISE_FIELD_RANGES`; edits go through `applyPatch`, and invalid values show their issue path inline without being applied.
- Output mode `z` or `u` (u only for `remap: 'uniform'`); one diverging colour map over [−c, c] or [−1, 1].
- Pan by drag, zoom by wheel from 1/16 to 1024 blocks per pixel, clamped to the window [−2^19, 2^19)²; the cursor readout shows world coordinates, z and u.
- For a 3D def, a plane selector (xz or xy) and a slider for the third coordinate.

**Statistics** (from `src/metrics/noiseStats.ts`, the functions the metric tests use, through incremental accumulators so the work is sliced like the rendering). They are computed over 50 000 uniform-random points of the whole window from a fixed stream, not over the visible pixels (neighbouring pixels are correlated and bias the KS statistic):
- mean, sd, min, max and the share of samples at the clamp (±c);
- KS D of u against U(−1, 1);
- a 64-bin histogram with the reference curve (uniform for u, the standard normal for z);
- the 16-bin gradient rose with the N5 definition (§7.3) and its max/min ratio.

**A/B mode.** Two canvases side by side with a shared camera. B's params are `applyPatch(SCHEMA, A's params, b.patch)`, so B follows A except where it differs; a missing `b.seed` means A's seed. Each side shows its statistics, and `r(A, B)` is the Pearson correlation over the same sample points.

**URL state.** `?lab=noise#<base64url(canonicalJSON(state))>`, base64url per RFC 4648 §5 without padding (the decoder also accepts padding), with `state = { v: 1, seed, noise, patch, view: { x, z, bpp, mode, plane?, slice? }, b?: { seed?, patch? } }`. `seed` is the trimmed, non-empty box text; `noise` is the instance's seed name; `patch` is a ParamsPatch over DEFAULTS; view numbers are q15'd (−0 → +0) before encoding. An invalid hash falls back to defaults with a notice.

**Determinism panel.** A button recomputes every `sp1.*` golden digest in the browser with `src/metrics/sp1Goldens.ts` and compares it with `test/goldens.json` (a `ui/` import SP0 already allows). It computes one key per frame, shows ✓/✗ per key with progress, and offers "copy as JSON" (`{ userAgent, results: {key: {expected, actual}} }`) for the exit evidence. The six 2^20-input detMath digests take about 0.4 s in total.

## 7. Tests

### 7.1 Unit (`test/unit/`)

- **Hash:** the §1.2 vectors. Avalanche: the flip rate of every (input bit, output bit) pair is 50 ± 2 % (fmix32 with 100 k inputs per bit; hash2/3/4 with ≥ 20 k per (input word, bit)). `hash2(x, z) ≠ hash2(−x, −z)` for all 1 ≤ x, z < 2000 and seeds 1-4. For seed 1, the corner hashes of [−128, 128)³ have `n − distinct` within 3σ of 32 725. `|corr(lattice3(s, p), lattice3(s, Rp))| ≤ 0.02` for each two-axis reflection R ∈ {(−x, y, −z), (−x, −y, z), (x, −y, −z)}, with 200 k points uniform in [−4096, 4096)³ and s = 1 (the master formula gives about ±0.11). The UTF-8 walker equals TextEncoder (test-side) on 20 k random strings with lone surrogates. `hashF64` writes computed and literal NaN identically. Setting any bit 12-31 of one coordinate changes `hash3` (so no 16-bit wrap hides a period).
- **deriveSeed:** one name × seeds [0, 100 k) gives 0 collisions (a bijection of world[0]); the §2.5 exhaustive name check.
- **RNG:** the §1.3 vectors; `nextInt` with n = 3·2^30, 100 k draws in 3 bins (floor(v / 2^30)): χ² p > 0.01, with plain modulo as a negative control (p ≈ 0).
- **Seed:** the §1.4 table and 100 k random round-trips; `seedBox` with an injected random source.
- **detMath** (references: test-side `Math.*` for sin, cos and exp, and an in-test Taylor + continued-fraction erf checked against the Appendix A mpmath values):
  - T-DM1 error bounds per function and domain: 2^20-point grids and random sets; every k·π/2 ± 4 ulp for |k| ≤ 63 662; the rivers path `detExp(−(t*t))` for t ∈ [0, 50];
  - T-DM2 the §1.5 special-value table (`Object.is`);
  - T-DM3 bitwise symmetry (sin odd incl. −0 and constructed ties; cos even; erf odd for x ≠ 0);
  - T-DM4 range (|sin|, |cos|, |erf| ≤ 1; exp ≥ 0);
  - T-DM5 monotonicity of erf, exp and exp2 on grids and consecutive-ulp windows, including the k-switch points;
  - T-DM6 digests: `sp1Goldens` detMath digests equal `test/fixtures/detmath-oracle.json` (§7.4);
  - T-DM7 constants: each coefficient's bits equal its comment and each literal has ≤ 17 significant digits.
- **Canonical JSON and q15:** the §1.6 vector; every rejection case; q15 idempotence, −0 → +0, `q15(0.1 + 0.2) === 0.3`.
- **Noise:** fused `lattice3` equals the 8-call reference bit-for-bit on 300 k points. **SD pin:** for seeds s = 1-4 and 250 k points per seed, with `s' = deriveSeed([s, 0], 'sp1.sdpin')`, the empirical sd of `lattice3(s', p)` over p uniform in [0, 65536)³ matches `PERLIN3_SD`, and over (x, Y + 0.5, z) with x, z uniform in [0, 65536) and Y a uniform integer in [0, 65536) matches `PERLIN2_SD`, each within ±0.5 % per seed (per-seed rms error 0.13-0.14 %; smaller windows fail). Noise outputs are finite and NaN-free; octave skipping for zero amplitudes is bit-identical.
- **Splines** (on the Appendix B fixtures):
  1. the segment formula equals the textbook Hermite basis within 1e-13·max(1, |y0|, |y1|, |d0·h|, |d1·h|);
  2. numeric knots interpolate bit-exactly; a nested knot equals its child at the same coordinates;
  3. hold outside the end knots; 1-point constant; NaN → NaN;
  4. C0 at every knot of every node: |f(nextDown/nextUp(x_i)) − f(x_i)| < 1e-9 over 200 reachable enclosing coordinate vectors;
  5. C1 at interior knots (second-order one-sided differences at h = 1e-5): |D+ − D−| ≤ 1e-3·max(1, |D|), and |D − d_i| ≤ 1e-3·max(1, |d_i|) at top-level knots; `TANGENT_FIXTURE` must catch the "tangent not multiplied by h" mutant (offset, sigma and jag cannot);
  6. `compileSpline` equals `evalSplineRef` bit-exactly on 1 M random points, including a −0 knot fixture;
  7. batch equals point bit-exactly;
  8. `withKnotY(+10)` changes f by exactly 10·w (w = product of the value-basis weights along the path, in [0, 1]) within 1e-12 and by 0 outside its support; raising every leaf by 10 shifts f by 10;
  9. one validation case per issue code with its exact path, in DFS order; `compileSpline` throws with the same issues;
  10. −0 knots evaluate to +0; equal canonical JSON gives equal `code`/`nums`;
  11. allocation: `v8.GCProfiler` reports at most 1 scavenge over 4 M `evalSpline` calls after warm-up;
  12. `autoTangents`: no segment evaluation leaves its hull by more than 4 ulp of max(|y0|, |y1|), on uniform-random and near-knot coordinates of OFFSET, SIGMA and JAG; d = 0 exactly where §3.4 requires it; offset's top-level d = [0, 38.889, 72.506, 87.097, 0, 0, 0, 0, 0] to 3 decimals.
- **ParamSchema:** builder and validation cases with exact paths and codes (§4.2 tables); all issues collected and nothing applied on error; 2000 random diff → JSON → apply round-trips; deep freeze; unchanged subtrees kept by reference; `buildSchema` rejects non-q15-stable bounds and invalid defaults.
- **Stages:** `checkRegistry(SCHEMA, STAGES) = []`, and a broken fixture per invariant produces its message; prefix matching on dot boundaries; stage hashes independent of the seed; `dirtyStages` for single-leaf edits and for each profile switch; the empty SP3/SP6 profiles have the default genKey.
- **Profiles, presets, migrations:** every profile resolves; the import order and its error paths (§4.5); export → import is a canonical identity for every profile and 100 random drafts; the injected v1 → v2 rename imports an old document; migrations are the identity at the current version.
- **Lab state:** URL state round-trips (including −0 view values and padded input); invalid states fall back to defaults; A/B param layering.

### 7.2 Arch (`test/arch/`)

The §1.8 rule changes, each with `good/` and `bad/` fixtures; `core/` code using only `Math.abs/floor/trunc/imul/sqrt`, `Math.SQRT1_2` and BigInt shifts passes. `schemaShape.test.ts` and `paramsDoc.test.ts` implement the accept and write flows of §4.6-4.7.

### 7.3 Metrics (`test/metrics/noise.metric.ts`, `params.metric.ts`)

Sampling rules shared by N1-N6 (implemented in `src/metrics/noiseStats.ts`):
- each metric draws points from `new Xoshiro128(fnv1a32('<ID>'))`, shared by all its seeds and noises; each point draws x, then y, then z (all three always, in this order), with `u = nextFloat()`: x and z = −524288 + 1048576·u (the colKey window [−2^19, 2^19); teleport clamps to ±500 000), y = −64 + 384·u (used by 3D noises only);
- world seeds are `[s, 0]`; values are normalised z unless stated; grids and small windows are never used (spatial correlation inflates KS D: grid spacing 256 gave D = 0.061);
- noise sets: **climate** = the 6 fields; **schema** = the 12 instances of §2.5; **adversarial** = `ADVERSARIAL_DEFS` (single-stack: 2D λ 16 one octave; 3D λ 8 one octave; 3D λ 32 one octave, always sampled at 4×8×4 cell corners); **3D** = `DENSITY3D_DEF` (λ 64, 4 octaves, double, yScale 1).

| id.part | definition | gate | fast | quick | full |
|---|---|---|---|---|---|
| N1.ksD | per (seed, climate field): KS D of `toUniform(z)` against U(−1, 1); max | ≤ 0.015 | s = 1-4, 50 k | s = 1-16, 50 k | s = 1-16, 200 k |
| N1.sdErr | same points: max \|sd(z) − 1\| | ≤ 0.02 | ″ | ″ | ″ |
| N2.value | max \|Pearson r\| over (a) same-seed pairs f ≠ g at [b, 0] and (b) cross-seed ordered pairs (f, g), f = g included, with f at [b, 0] and g at [b + k, 0], k = 1..K; values streamed per k | ≤ 0.02 | climate set, n 100 k, K 8, b 1000 | schema set, n 100 k, K 64, b 1000 | schema set, n 100 k, K 64, b ∈ {1000, 5000} |
| N3.value | min over noises, P ∈ {256, 512, 1024, 2048, 4096, 65536} and e ∈ {(1,0,0), (0,0,1), (1,0,1)} (+ (0,1,0) for 3D) of mean\|f(p) − f(p + P·λ0·e)\| ÷ mean\|f(a) − f(b)\| over independent random pairs (a, b); λ0 = the octave-0 wavelength; s = 1, 2 | ≥ 0.9 | schema + adversarial + 3D, n 5 k | 20 k | 50 k |
| N5.horizontal | noises with octaves × stacks ≥ 2 (2D fields and the xz plane of `DENSITY3D_DEF`): θ = atan2(∂f/∂z, ∂f/∂x) by central differences with h = λ_min/128 (λ_min = the last octave's wavelength); samples where any of the four evaluations is at ±c are skipped; 16 bins centred on axes and diagonals, `bin = floor((θ + π + π/16)/(2π)·16) mod 16`; max/min; s = 1, 2 | ≤ 1.15 | n 100 k | 200 k | 400 k |
| N5.vertical | the same on the xy plane of `DENSITY3D_DEF` | ≤ 1.15 | ″ | ″ | ″ |
| N6.value | max over noises of P(\|z\| < 1e-6) at uniform-random integer points (Z² for 2D, Z³ for 3D; the λ 32 def at random 4×8×4 cell corners), s = 1, 2 | ≤ 0.001 | schema + adversarial + 3D, 50 k | 200 k | 1 M |
| U4.registryIssues | `checkRegistry(SCHEMA, STAGES).length` (every leaf has meta, scope and a covering stage) | ≤ 0 | all tiers | | |
| U4.migrationFailures | failures of the migration invariant, fixtures and export → import identities | ≤ 0 | all tiers | | |
| U4.shapeLockViolations | §4.6 | ≤ 0 | all tiers | | |
| U4.readmeStale | 1 if the README block differs from `renderReference(SCHEMA)` | ≤ 0 | all tiers | | |

- All parts are `activeFrom: 'SP1'`. Single-cell rows use the part name `value` (SP0 convention).
- **N2 sizes.** From sampling alone max |r| sits near 4/√n, but large-λ fields inflate the variance of r over the window (rms(r)·√n = 1.45 for T, 1.21 for C at 100 k), so T–T pairs sit about 4.4σ from the gate. With n = 100 k every tier's false-failure rate on a hash or seeding change stays well under 1 % (the 50 k fast tier measured about 0.5 %). Measured at the pinned configurations: 0.011-0.014.
- N5 excludes single-lattice-term noises, which are intrinsically anisotropic (1.1-1.4 measured). It skips clamped samples because both differences are 0 there and atan2(0, 0) = 0 inflates one bin (bias about 0.02).
- N6 needs the adversarial defs: double stacks and large-λ fields pass even with integer origins (which give 0.66-1.97 % on the adversarial defs), so without them the metric measures nothing.
- P = 65536 in N3 catches a 16-bit lattice-coordinate wrap that {256 … 4096} misses.
- Measured by the review re-implementation (balanced gradients, ±2^19): N1 D ≤ 0.0118 (16 × 50 k) and ≤ 0.0073 (16 × 200 k), sdErr ≤ 0.011; N3 0.951; N5 1.031-1.100. The plan's dry run (fast tier, 7 s under vitest): N1 D 0.0100, sdErr 0.0076; N2 0.0122; N3 0.953; N5 1.074 / 1.051; N6 0.058 %, all from `test.adv2d16` (exact cancellations of a single-octave field on the ½ slice at integer points; 0.054 % at 1 M points, so the 0.1 % gate keeps a 1.9× margin while integer origins would give 0.66 %).

### 7.4 Goldens

`src/metrics/sp1Goldens.ts` computes every digest; `test/unit/goldens.sp1.test.ts` checks them with `expectGolden`; the lab panel and the JSC check (§11) recompute them. **Every golden value is a `hex64` string.** Goldens hash frozen fixtures (`sp1Fixtures.ts`, Appendix B), not the live schema defaults, so retuning a default in a later SP does not churn them; they change only when the math changes.

- **`sp1.detMath.<fn>`**, for fn ∈ {detSin, detCos, detExp, detExp2, detErf, detSmoothstep}: `r = new Xoshiro128(fnv1a32('sp1.detMath.' + fn))`; for j < 2^20, `u = r.nextFloat(); x = lo + (hi − lo) * u` (this operation order) over [lo, hi): detSin/detCos [−64, 64) for even j and [−2097152, 2097152) for odd j; detExp [−746, 710); detExp2 [−1076, 1025); detErf [−8, 8); detSmoothstep(−1, 1, x) with x ∈ [−2, 2). Then the special inputs are appended in this order: common `[0, −0, NaN, Infinity, −Infinity, 5e-324, −5e-324, 1.7976931348623157e308, −1.7976931348623157e308, 0.5, −0.5, 1, −1]`, then for sin/cos `[2097152, −2097152, 2097152.0000000005, 1.5707963267948966, 3.141592653589793]`, for exp `[−745.1332191019412, −745.14, 709.782712893384, 709.79]`, for exp2 `[−1075.5, −1075, −1074, 1023, 1024]`, for erf `[6.0926, 2.1213203435596424]`. Digest = `hex64(hashF64(outputs))`.
- **Oracle.** `tools/detmath-oracle.py` (CPython ≥ 3.8, standard library only) ports splitmix32, Xoshiro128, fnv1a32/64, hashF64 (NaN → `0x7FF8000000000000`) and Appendix A, reproduces the inputs above and writes `test/fixtures/detmath-oracle.json = {"detSin": "<hex64>", …}`. CPython floats are binary64 with per-operation rounding and no FMA, so the port reproduces the operation order. T-DM6 asserts that each fixture value equals the corresponding `sp1.detMath.<fn>` digest.
- **`sp1.noise.<seedName>`**, for every fixture def (`CLIMATE_FIXTURE_DEFS`: frozen copies of the 12 SP1 instances; `DENSITY3D_DEF`; `ADVERSARIAL_DEFS`): world seed `seedFromInput('42')`; points from `new Xoshiro128(fnv1a32('sp1.noise'))`, drawn as in §7.3 (x, y, z per point), 4096 of them, shared by all defs; values `[z_0 … z_4095]` (`z2(x, z)` for dims 2, `z3(x, y, z)` for dims 3), followed by `[u_0 … u_4095]` for uniform fields. Digest = `hex64(hashF64(values))`.
- **`sp1.spline.<name>`**, for OFFSET, SIGMA, JAG (with `autoTangents`) and TANGENT_FIXTURE: `r = new Xoshiro128(fnv1a32('sp1.spline'))`; 4096 coordinate vectors of 6 draws each, `−1.25 + 2.5·u` in slot order; digest = `hex64(hashF64(evalSpline outputs))`.
- **`sp1.params`**: over `PARAMS_FIXTURE` (a frozen fixture schema with its two-stage list, Appendix B): `hex64(fnv1a64(canonicalJSON([hex64(H.climate), hex64(H.decorate), hex64(genKey(seedFromInput('42'), H)), hex64(paramsHash(FIXTURE_DEFAULTS))])))`.
- **Recording.** The goldens test and its recording land in the plan's **last generator-affecting task**, after hash, rng, detMath, noise, splines, `autoTangents`, `sp1Fixtures`, the kit and the stage hashing are final. `GENERATOR_VERSION` stays 0, since no existing golden changes. Any later change to them inside SP1 requires a `GENERATOR_VERSION` bump.

### 7.5 Bench, baseline and kill criterion (`test/bench/`)

- Kernels: `lattice3` (coherent 64×64 slice, 4096 random 3D points), perm512 (same inputs, §2.6), `z2` of `climate.C` (6 × 2), `z3` of `DENSITY3D_DEF` (4 × 2) at cell corners, `evalSpline` of OFFSET and of MIX3 (OFFSET, SIGMA and JAG at one point), `detErf`, and `stageHashes` + `genKey`.
- Method: each bench call loops ≥ 4096 evaluations (a single-call bench measures the harness); hot kernels are aliased locally; every kernel is reported as a ratio to a calibration kernel (a 4096-element `fmix32` loop) measured in the same run, because absolute ns drifted 16 % within one run and 2× across runs under load.
- `test/baselines.json` records, per kernel, `nsPerEval` and `ratio`, plus `killRatio`, the machine, Node version and date. `npm run bench:record` = `BENCH_RECORD=1 vitest bench --run --project "bench (bench)"` writes it on the reference machine at SP exit. `npm run bench` fails when a kernel's ratio exceeds its baseline by more than 30 % (P1) or `killRatio` exceeds 1.6; without a baseline file it only reports.
- The gates live in `test/bench/gates.ts`, outside `THRESHOLDS` and the lock in SP1 (the lock's coverage scan reads only metric files). Changing them requires a spec amendment.

## 8. Governance steps

- The SP1 branch's first commit appends `'SP1'` to `STARTED_SPS`. Each THRESHOLDS row (N1, N2, N3, N5, N6, U4) is added in the commit that adds its metric test, so every active part is always covered.
- CI checks the governance range **per push** (`github.event.before`). Therefore **every commit that changes `test/thresholds.lock.json` also edits this spec**, appending a line to the "Threshold log" under Exit evidence, after running `npm run test:accept-thresholds`.
- Goldens are recorded once, in the last generator-affecting task (§7.4).
- New scripts (env flag + vitest, like SP0's accept flows; no `scripts/` folder): `test:accept-schema`, `docs:params`, `bench:record`. README and CLAUDE.md already name D1-D20 (updated with this spec); the first implementation commit lists the new scripts in both and adds the SP1 conventions to CLAUDE.md: hot-module import aliasing, the NaN rule, the locale-API ban, q15 at validation, and "renaming a noise path needs `seedName`".

## 9. Master-spec amendments made with this spec

In this list, a bold section number is a master section; "here" marks a section of this document.

- **Decisions log:** add **D20** — determinism references are V8 (Chrome, Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari); goldens must match bit-for-bit in all three. Every SP exit checks V8 and SpiderMonkey in the browser and JavaScriptCore through Bun (§11 here); Safari itself is checked by hand when a Mac is available. XS and QuickJS are not references (XS mis-parses `9007199254740993` and prints non-round-tripping doubles).
- **§1 layout:** detMath exports (§1.5 here); `lattice3` uses 12 balanced gradients; `spline/*` compiles to Int32Array code + Float64Array numbers with a register-file evaluator; `core/` adds `seed.ts`, `noise/types.ts`, `params/kit.ts`, `params/noises.ts`, `params/presets.ts`, `spline/{types,validate,tangents}.ts`; `metrics/` adds `noiseStats.ts`, `sp1Fixtures.ts`, `sp1Goldens.ts`; `ui/` adds `seedBox.ts` and `lab/*`; `tools/detmath-oracle.py`; `test/` adds `schema-shape.lock.json`, `fixtures/` and `tools/`. ParamSchema defaults live in `core/params` (core cannot import `gen/`).
- **§1 banned APIs** (and the SP0 spec's banned-API section): §1.8 here.
- **§2.4:** the raw climate fields are uniform on [−uMax, uMax].
- **§2.5 types:** `Seed64 = readonly [lo, hi]` with the u32 invariant, `Hash64` alike; ParamMeta with `stage` present exactly when not live, plus `options`, `dims` and `coords`; NoiseDef complete in validated params (`amplitudes: number[] | null`; `double` defaults to true); SplinePoint `d` units.
- **§2.7:** the genKey preimage and `hex64`; presets store a patch over `resolveProfile(profile)` with the §4.5 import order; saves store full params and load over DEFAULTS; the session URL hash carries the profile id.
- **§3.1:** replaced by §1.2-1.4 and §2.1-2.3 here (axis pre-mix, `hash4` defined, 12 balanced gradients, closed-form `PERLIN3_SD` and `PERLIN2_SD`, fractional octave origins in lattice units, fixed 2D slice, stack B name and scale, reciprocal normalisation); the kill criterion becomes §2.6 (no automatic fallback).
- **§3.2:** u lies in [−uMax, uMax] (width/2 shares inside); warp octaves 3/2/2; persistence 0.5 and lacunarity 2; `scaleMul` divides the climate-stage coordinates before warping; noise seed names come from schema paths (`seedName` for renames); `remap: 'uniform'` requires `double`.
- **§3.3:** spline semantics (hold, canonical formula, tangents as explicit data, the hybrid rule with its hull-up-to-rounding guarantee, validation rules).
- **§3.12:** `(…)^1.5` → `s * Math.sqrt(s)`.
- **§3.15:** built-in presets are the `PROFILES` entries of `core/params/profiles.ts`.
- **§3.17:** add the ECMA-262 basis (§1.5 here), the NaN rule (§1.7), the locale/ICU and host-API bans, the hand-written UTF-8 rule, "plain-object keys in generator output paths are iterated only after sorting", "reciprocal multiply is not a substitute for division unless the formula says so", shortest round-trip coefficient literals in detMath and polynomial kernels, and q15 plus canonical JSON.
- **§5.1:** the stageHash preimage; README freshness is the U4 `readmeStale` part; the scope table's Terrain row drops "profile" and the Climate row notes that the seed is session state; live leaves have no stage.
- **§6.1 / P1:** the §7.5 bench method (calibration ratios, `bench:record`).
- **§6.3:** hash/RNG, detMath, spline and preset test definitions as in §7.1 here (presets: an injected v1 → v2 migration, not "v0 → v1").
- **§6.4:** N1, N2, N3, N5, N6 and U4 as in §7.3 here; **T6** becomes a gain: `gain = ΣΔoffset_col / Σw_col` over columns with w_col > 0, where w_col ∈ [0, 1] is the product of Hermite value-basis weights along the raised knot's path (= Δspline_col/10 with fixed tangents), for one knot per depth; gate 10 ± 1.5. As worded, T6 cannot pass for any Hermite spline (mean shifts 5.00, 2.49, 1.26 at depths 1-3).
- **§6.5:** "diagonal bias → 12 balanced gradients"; "migrate/deep-merge → migrate/applyPatch".
- **§8 risk 4, risk 6 and §9 noise row:** the permutation variant is a bench comparator only; risk 6 names D20, the SP1 lab determinism panel and the Bun JSC check.
- **§10:** SP1 as in §11 here (cut line: the A/B mode → SP10); SP2 receives the §10-here hand-offs; SP10's README reference is already gated from SP1 and U4 is active in full since SP1; SP2's preset item wires the SP1 envelope.

## 10. Notes handed to later SPs

- **SP2:** the pure master §3.3 offset puts about 34 % of land columns in one 10-block band, [66, 76), against T1's ≤ 25 % on the final surface, and 44 % ocean (≤ 63), near the top of B1's 25-45 %. SP2 must confirm that σ, jag and rivers spread the band, or retune the lowland knots (E 0.2 → PV{65, 72, 80}; E 1 → 66/70).
- **SP2:** author the `shape.*` defaults with `autoTangents` (starting from the Appendix B knots); clamp jag and σ with `max(0, ·)`; add the `src/`-side current-SP constant that hides profiles before their `readyFrom`; put the profile id in the world URL hash.
- **SP3:** amplified's `offset' = 64 + 1.9·(offset − 64)` is a downstream multiplier, against master §3.3's "no downstream multipliers". Bake it into the profile's spline data (knots and tangents; up to 2.16 blocks of deviation in 0.2-0.3 % of columns) or plot post-transform values in the editor.
- **SP3:** `detSmoothstep` and products of rounded terms are not ulp-monotone (0.15-1.2 % of consecutive-ulp steps decrease, by ≤ 2.11e-16 relative). `boundsCell` must widen such results outward by at least 1 ulp. DAG validation rejects smoothstep with e0 ≥ e1.
- **SP3:** records (`recordOf`) validate keys against `/^[a-z][A-Za-z0-9_]{0,31}$/` and return them sorted; `gen/` iterates records only in sorted key order.
- **gen/ hot loops** follow the same import-aliasing convention; the SP that adds a hot `gen/` module decides whether to extend the arch rule.

## 11. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with N1, N2, N3, N5, N6 and U4 active | `npm run build && npm test && npm run test:metrics:full` |
| CI green on the SP1 pull request | GitHub Actions |
| detMath design bounds, acceptance ≤ 2e-6, oracle digests | unit tests T-DM1-T-DM7 |
| spline tests 1-12 | unit tests `spline.01`-`spline.12` |
| `PERLIN3_SD` and `PERLIN2_SD` pinned within ±0.5 % | the SD-pin unit test |
| `sp1.*` goldens recorded | `goldens.sp1.test.ts` |
| `test/baselines.json` recorded with `killRatio` ≤ 1.6 | `npm run bench:record`, then `npm run bench`, on the reference machine (not in CI) |
| JavaScriptCore matches the goldens | `npx --yes bun@1 test/tools/goldensJsc.ts` (Bun runs JSC; no dependency is added), output pasted into Exit evidence |
| the lab works and its determinism panel is green in Chrome and Firefox | manual, on the Vercel preview deployment of the SP1 branch; the panel's JSON pasted into Exit evidence |
| visual review | screenshots of each climate field, a warp, a 3D test def and the A/B view under `docs/superpowers/specs/assets/sp1/` |

**Cut line:** the lab's A/B mode (→ SP10).

## Exit evidence

(Filled in at SP exit.)

### Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP1`; no threshold rows yet.

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

## Appendix B — fixtures (`src/metrics/sp1Fixtures.ts`)

Frozen data used by tests, benches, goldens and the lab. Changing any of it changes goldens (and needs a `GENERATOR_VERSION` bump once recorded).

**Noise defs** (complete NoiseDefs; unlisted fields take the §4.2 defaults):
- `CLIMATE_FIXTURE_DEFS`: the 12 SP1 instances exactly as §4.3 defines them today, keyed by seed name (`climate.C` … `climate.R`, `climate.warp.shift.noise.x`, `….z`, `climate.warp.C.noise.x`, …).
- `DENSITY3D_DEF` (seed name `test.density3d`): λ 64, 4 octaves, double, yScale 1, remap none.
- `ADVERSARIAL_DEFS`: `test.adv2d16` (2D, λ 16, 1 octave, single), `test.adv3d8` (3D, λ 8, 1 octave, single), `test.adv3d32` (3D, λ 32, 1 octave, single; sampled at 4×8×4 corners).

**Spline fixtures** (x, y as below; d from `autoTangents`, except TANGENT_FIXTURE). `PV3(a, b, c)` is `{coord: 'PV', points: [{x: −1, y: a}, {x: 0, y: b}, {x: 1, y: c}]}`.

```
OFFSET = C: [−1: 16], [−0.6: 26], [−0.4: 40], [−0.24: 52], [−0.16: 60],
  [−0.10: E: [−1: 70], [0: 64], [1: 63]],
  [0.05: E: [−1: PV3(72, 96, 130)], [−0.4: PV3(68, 82, 100)], [0.2: PV3(65, 72, 80)], [1: 66]],
  [0.30: E: [−1: PV3(80, 125, 175)], [−0.4: PV3(72, 92, 120)], [0.2: PV3(66, 76, 88)], [0.6: 70], [1: 66]],
  [0.60: E: [−1: PV3(90, 150, 210)], [−0.4: PV3(76, 104, 140)], [0.2: PV3(68, 82, 96)], [1: 70]]
SIGMA  = C: [−1: 3], [−0.16: 3], [−0.10: 1.5],
  [0.05: E: [−1: PV: [−1: 4], [1: 16]], [0: 3], [1: 1.2]]
JAG    = C: [−0.10: 0],
  [0.05: E: [−1: PVJ], [−0.5: PVJ], [−0.4: 0]]          with PVJ = PV: [0.3: 0], [0.7: 30], [1.0: 55]
TANGENT_FIXTURE = C: [−0.9: 10, d 12],
  [−0.2: E: [−0.7: 5, d −3], [0.4: 20, d 8], [0.8: 14, d −6], d 4],
  [0.5: 30, d −9]
MIX3   = [OFFSET, SIGMA, JAG] evaluated at one coordinate vector (bench only)
```

This is the spike's reading of master §3.3: SIGMA's ocean/coast/inland positions and JAG's "inland with E ≤ −0.5" knots are fixture choices; SP2 may retune the real defaults.

**Params fixture** (`PARAMS_FIXTURE`): `buildSchema(group('fixture', …, { a: group('a', …, { n: num(0.5, {min 0, max 1, scope climate, stage climate}), k: int(3, {min 1, max 8, …}), e: enumOf(['p', 'q'], 'q', …), w: noise({wavelength: 128, octaves: 3}, {wavelength {min 16, max 1024}, dims 2, …}) }), b: group('b', …, { s: spline(TANGENT_FIXTURE, {coords all, min −100, max 100, scope decorate, stage decorate}) }) }))`, with the stage list `[{id: 'climate', version: 1, reads: [], params: ['a'], checkpoint: 'columnSample'}, {id: 'decorate', version: 1, reads: ['climate'], params: ['b'], checkpoint: 'final'}]`. `FIXTURE_DEFAULTS` is its defaults.

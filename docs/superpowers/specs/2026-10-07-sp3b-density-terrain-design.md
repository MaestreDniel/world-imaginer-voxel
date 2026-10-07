# SP3b — Density and terrain shape (Design)

Date: 2026-10-07
Status: Approved by the user (2026-10-07): the design section by section (2026-10-06 and 2026-10-07), then the written spec after the adversarial review (§15), then the §8.4 retune after the dry run's measurement. Revised by the implementation-plan dry run (2026-10-07, §16)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3b, which this spec narrows: its surface-rule half becomes the new SP3c, and the old SP3c becomes SP3d (§12);
- §2.5 (key types), §3.6 (density DAG), §3.7 (surfaceEstimate and surfaceWaterLevel), §3.16 (cross-column consistency), §3.17 (determinism);
- §5.1 (parameter model and stage hashes), §5.5 (probe);
- the testing sections §6.1-6.4 (N5, U2, DT1, DT2, T1-T5, P1) and §7 (performance budget).
Previous SP: `2026-10-02-sp3a-blocks-store-harness-design.md` (its §10 lists what SP3a handed over).

References written "master §x" point to the master spec, "SP3a §x" (and SP1, SP2a, SP2b) to those specs, and a bare "§x" to this document.

## Goal

Replace SP3a's provisional terrain with the real one. A data-driven density DAG (`Expr`), compiled to closures with a bit-exact reference interpreter, interval bounds and exact early-outs, drives a new T stage that fills each column with stone, water and air in 3D (overhangs, jagged peaks, surface detail). A 3D `surfaceEstimate` searches the same field. The world's shape is measured on voxels (T1-T5) and the machinery is proven exact (DT1, DT2). The Voxels mode of `?map` and the harness slices show it.

## Non-goals

- Surface rules, the terrain palette and every new block state (new SP3c). SP3b's T writes only air, stone, bedrock and water; bedrock stays the flat layer at y −64.
- Caves, carvers, aquifers (SP6), structures and the beard term (SP9). The `islands` term exists but stays −1e6 (SP3d's floating_islands draft).
- The editable DAG (`density.defs` JSON, inspector, mutes, slice view): SP3d. In SP3b the expression's structure is code; its tunables are schema leaves.
- Changing how the map, the cross-section's Profile mode, the biome picker or the column stage compute the surface: they keep the 2D `surfaceEst` (= `offset`). (A retune of the `shape.*` defaults, §8.4, changes their output like any other edit.)
- Streaming, meshing and the coordinator (SP4).

## Decisions (confirmed by the user, 2026-10-06/07)

1. **Split:** master SP3b is cut in two. SP3b (this spec) is density, the real T, water and surfaceEstimate with T1-T5, DT2 and P1; the new SP3c is surface rules, the terrain palette, B4 (voxel parts) and S1-S3. The old SP3c becomes SP3d (§12).
2. **Map stays 2D, voxels go 3D:** the map, the preview, the biome height filter and the column stage keep the 2D `surfaceEst`; the 3D estimate is used only for voxels and T5 (§5).
3. **Tuning:** T1 and T2 are first measured on the real T; if they fail, the offset (and σ) knots are retuned and the user approves before/after slices, the map and the numbers. T3 is redefined to compare borders inside one biome family (§8).
4. **Approach A:** the master's DAG (Expr data, closure compiler with stage placement, reference interpreter, interval bounds), restricted to the ops the terrain needs; caves add ops on the same base in SP6.

## Module layout after SP3b

```
src/gen/density/
  expr.ts          the Expr node types (JSON-shaped data), structural hash, validateExpr
  nodes.ts         per-op semantics: value, interval rule, class rule (one table shared by compile and reference)
  compile.ts       validation, ref resolution, placement-keyed CSE, stage placement, closure emission
  reference.ts     the point interpreter (tree walk, same placement rules and interpolation, bit-exact with compile)
  bounds.ts        interval evaluation per 4×8×4 cell
  context.ts       DensityContext: the compiled expression, a ColumnCache and the per-column corner cache
  probe.ts         probe(dc, x, y, z, tap?): one voxel through the compiled path, no early-outs
  defaults.ts      the default expression built from params.density (§3)
src/gen/column/surfaceEstimate.ts   surfaceEst3: the 3D search on the terrain tap (§5)
src/gen/pipeline/terrainStage.ts    the real T (replaces SP3a's provisional fill); terrainDensityDebug (test hook)
src/core/params/schema.ts           + the `density` group (§3.3)
src/world/store/api.ts, store.ts    + ColumnView.auxB() (§7)
src/metrics/sp3bGoldens.ts          sp3b.density.* goldens (in DET_FILES)
src/metrics/liveness.ts             + the `terrain` output stage (§3.3)
src/workers/sliceJob.ts, protocol.ts, src/engine/workerPool.ts   + slice split across workers (§6)
test/harness/densityFuzz.ts         random Expr trees for the compile/reference/bounds fuzz
test/metrics/terrain.metric.ts      T1-T5 on voxels; region.metric.ts gains DT2
```

## 1. The Expr model (`gen/density/expr.ts`, `nodes.ts`)

### 1.1 Nodes

`Expr` is plain JSON (tagged objects with an `op` field). Named sub-expressions live in `defs: Record<string, Expr>` next to the root and are used through `ref`.

| op | fields | value |
|---|---|---|
| `const` | `v: number` (finite) | v |
| `y` | — | the voxel's (or corner's) y |
| `col` | `field`: one of the ColumnSample's continuous fields (`SAMPLE_FIELDS`, all finite) | the field at the position (§2.2) |
| `noise2` | `id` | `z2(x, z)` of the density noise `id` |
| `noise` | `id` | `z3(x, y, z)` of the density noise `id` |
| `add`, `mul`, `min`, `max` | `a, b` | a + b, a · b, min, max |
| `neg`, `abs`, `square` | `x` | −x, \|x\|, x · x |
| `clamp` | `x, lo, hi` (constants, lo ≤ hi) | x < lo ? lo : x > hi ? hi : x |
| `slide` | `x, knots: [y, v][]` (y strictly increasing, ≥ 2 knots) | x · s(y), s piecewise linear (below) |
| `interpolated` | `x` | trilinear interpolation of x's corner values (§2.2) |
| `rangeChoice` | `x, lo, hi, inside, outside` (constants lo < hi) | lo ≤ x < hi ? inside : outside (only the chosen branch is evaluated) |
| `tap` | `name, x` | x (names a field for the probe, the metrics and later the inspector) |
| `ref` | `name` | the value of `defs[name]` (resolved at compile time) |

- **Evaluation order is fixed.** Every binary op evaluates `a`, then `b`. Arithmetic is IEEE double, round to nearest, in the written order, never fused or reassociated. `min(a, b)` is `b < a ? b : a` and `max(a, b)` is `b > a ? b : a`: ties (including +0 against −0) return `a`. −0 is a valid density; DT2 compares values with `Object.is`.
- **`slide` segments are half-open.** On [y_k, y_{k+1}), `s(y) = v_k + (y − y_k) · ((v_{k+1} − v_k) / (y_{k+1} − y_k))`. Below y_0, s = v_0; at and above the last knot, s = v_last.
- **Noise.** `noise2`/`noise` read the GenContext's schema noise `density.noises.<id>`, so the seed name is the leaf path as for every schema noise. Values are `z` (unit sd, clamped to ±`clampSigma`, SP1 §2.3); amplitude is a `mul`. They sample unscaled world block coordinates (x, y, z): `large_biomes`' `scaleMul` stretches climate, not overhangs or detail. A density noise must have `remap: 'none'` (validated).
- **J uses u.** The jag term reads `u = z / clampSigma` ∈ [−1, 1] (a `mul` by the constant 1/clampSigma), so `J = (1 − |u|)²` ∈ [0, 1]: the master's formula (SP3a §10 left z vs u open).
- **Validation** (`validateExpr`) runs before ref resolution and CSE, so its messages name real node paths (`root.a.b.x`, `defs.terrain.x`). It rejects:
  - unknown ops, fields or noise ids, and non-finite constants;
  - a `ref` cycle or unknown name;
  - an `interpolated` inside another;
  - `clamp` with lo > hi, `rangeChoice` with lo ≥ hi, `slide` knots not strictly increasing;
  - a density noise whose `remap` is not `'none'`.

### 1.2 Interval rules (`nodes.ts`)

Each op maps its children's intervals to its own. `bounds.ts` uses these (§2.4):
- **Leaves:**
  - `const` is [v, v] and `y` is the cell's [y0, y1];
  - `col` inside `interpolated` takes the min and max over the cell's 4 corner columns;
  - a COLUMN value read at voxel level (§2.1) takes the min and max of its per-position values over the cell's 4 × 4 positions;
  - `noise2`/`noise` are [−clampSigma, clampSigma].
- **Arithmetic and selection:**
  - `add` is [a0 + b0, a1 + b1] and `neg` is [−x1, −x0];
  - `mul` takes the min and max of the four endpoint products;
  - `min` and `max` work endpoint-wise; `abs`, `square` and `clamp` take their exact images.
- **`slide`:** s's range over [y0, y1] is taken from s at y0 and y1 and, at each interior knot y_k ∈ (y0, y1], from both the left segment's formula and v_k. The `mul` rule then applies.
- **Structure:**
  - `interpolated` takes the inner expression's interval over the cell;
  - `rangeChoice` takes `inside`'s interval if x ⊆ [lo, hi), `outside`'s if x is disjoint from it, and their hull otherwise;
  - `tap` and `ref` pass the child's interval through.
- **Widening.** Rounding is monotone, so endpoint arithmetic in double is sound. Interpolation and bilinear readouts are not: they can step out of their inputs' hull by a few ulps of the largest magnitude involved. So every interval leaving an `interpolated` node, and every voxel-level `col` or `positionFn` value interval, is widened on both ends by `w = 1e-9 · (1 + max(|lo|, |hi|))`.
- **Fuzz** (§10): no evaluated value ever leaves its interval. The fuzz draws constants log-uniformly over [1e-6, 1e9] with random signs.

## 2. Compiler, reference, probe and bounds

### 2.1 Stage placement (`compile.ts`)

1. **Validate** (§1.1).
2. **Resolve `ref`s.**
3. **Classify each node** (COLUMN < CELL < VOXEL; a node takes the highest of its children's classes and of its own):
   - **COLUMN:** depends only on `const`, `col` and `noise2`.
   - **CELL:** inside `interpolated` and not COLUMN.
   - **VOXEL:** outside `interpolated` and not COLUMN.
   - `y` and `slide` are y-dependent: CELL inside `interpolated`, VOXEL outside, never COLUMN.
   - An `interpolated` node is evaluated per voxel by interpolating its CELL corner values (§2.2), at no expression cost.
4. **CSE.** The key is (structural hash, inside-`interpolated` flag): equal sub-trees are shared only within one placement.
5. **Emit closures over typed scratch arrays.** No `new Function` or `eval`.
   - `columnFn`: the COLUMN nodes that CELL nodes read, at the 5 × 5 corner columns.
   - `positionFn`: the COLUMN nodes that VOXEL nodes read, at the 16 × 16 block positions. `col` is the bilinear readout and `noise2` is sampled at the position's integer (x, z).
   - `cornerFn`: the CELL nodes, at the 5 × 49 × 5 corners.
   - `voxelFn`: the VOXEL nodes, per voxel.

### 2.2 Geometry and interpolation

- **Cells and corners.** A column (16 × 384 × 16 voxels) is 4 × 48 × 4 cells of 4 × 8 × 4.
  - Corners sit at local x, z ∈ {0, 4, 8, 12, 16} and y = −64 + 8k, k = 0 … 48.
  - Corner column (i, j) is the ColumnSample lattice point `latticeIndex(i, j)`. Corners on a chunk border are therefore computed identically by both neighbours (master §3.16).
- **Trilinear interpolation.** Voxel (lx, y, lz) in cell (ci, ck, cj) has fractions `tx = (lx − 4ci) / 4`, `ty = (y + 64 − 8ck) / 8` and `tz = (lz − 4cj) / 4`.
  - The order is fixed: lerp along x on the four x-edges, then along z, then along y.
  - `lerp(a, b, t) = a + t · (b − a)`.
- **`col` reads.** At a corner, `col` reads the lattice value exactly. At a position (`positionFn`), it is the ColumnSample's bilinear readout (`readField`: x then z).

### 2.3 DensityContext, reference and probe

- **`createDensityContext(ctx)`** owns:
  - the compiled expression;
  - a `ColumnCache` (`createColumnCache(ctx)`, SP2a), so that probes and `surfaceEst3` do not rebuild a ColumnSample (≈ 0.4 ms) per call;
  - a per-column cache of the `columnFn` and `positionFn` values and of the corners evaluated so far.
- **`reference.ts`** evaluates an `Expr` at a voxel by walking the tree with the same placement rules:
  - COLUMN and CELL sub-trees at the cell's corners (recomputed per call);
  - COLUMN sub-trees read by VOXEL nodes at the voxel's position;
  - the §2.2 interpolation;
  - VOXEL nodes at the voxel.

  It uses only `+ − × ÷ √`, `floor`, detMath and the SP1 noise classes, in the §1.1 order.
- **`probe(dc, x, y, z, tap?)`** returns the final density (or a tap's value) at one voxel through the compiled closures, without early-outs.
- **`terrainDensityDebug(ctx, cx, cz, out: Float64Array, mask: Uint8Array)`** is a test-only hook. It runs the T stage's density phase and records the value of every voxel the bulk evaluated (`mask` 1), leaving the early-out voxels at mask 0.

### 2.4 Bounds and early-outs (`bounds.ts`)

For each cell, after `columnFn` and `positionFn`, the root's interval over the cell (§1.2) decides:
- **hi < 0:** every voxel of the cell is non-solid, with no corner or voxel evaluation.
- **lo > 0:** every voxel is solid, with none either.
- **Otherwise:** the cell's 8 corners are evaluated, each at most once per column and shared by up to 8 cells. When the root has VOXEL nodes, `voxelFn` runs only for the voxels of cells whose interval (with the interpolated part replaced by the hull of the cell's corner values, widened) straddles 0.

Early-outs never change a voxel. DT2's `probeBulk` checks this against the probe, which uses no early-outs.

## 3. The default expression and its parameters

### 3.1 Expression (`defaults.ts`, built from `params.density`)

```
J        = square(1 − abs(noise2('jag') · (1 / clampSigma)))
N3       = noise('overhang')
terrain  = tap('terrain', interpolated( col.offset + col.jag · J − y + col.sigma · slide(N3, SLIDE)
                                        + 2·max(0, −56 − y) − 2·max(0, y − 296) ))
amp      = ampLo + (ampHi − ampLo) · clamp((col.E + 1) / 2, 0, 1)
detail   = noise('detail') · amp
final    = max( terrain + detail, islands ),   islands = tap('islands', const −1e6)
SLIDE    = [(−64, 0), (−40, 1), (240, 1), (320, 0)]
```

- The floor term `2·max(0, −56 − y)` and the ceiling term `−2·max(0, y − 296)` are master §3.6's. They sit inside the interpolated `terrain`.
- `detail` is VOXEL-class and is evaluated only in straddling cells. `amp` is a COLUMN sub-tree read by a VOXEL node, so it comes from `positionFn` (bilinear E at the position).

### 3.2 Behaviour pinned by tests

- **Early-outs.** Cells above `offset + jag + clampSigma(overhang) · σ + clampSigma(detail) · ampHi` early-out to non-solid. Cells whose lower bound `offset − y1 − clampSigma(overhang) · σ + 2·max(0, −56 − y1) − clampSigma(detail) · ampHi` (y1 = y0 + 8, the cell's top corner) is positive early-out to solid: every cell below about offset − 3σ − 13 with the default offsets (≥ 16). The floor term alone decides no cell, because the lowest cell's top corner is y −56, where it is 0.
- **Reduction to SP3a.** With the σ and jag splines at 0, both detail amplitudes at 0, and columns away from river channels (rivers hard-code σ 0.5 in channels, `rivers.ts`), the solid rule is `y < offset`. That equals SP3a's `y ≤ ⌊surfaceEst⌋` wherever the bilinear offset is not within 1e-9 of an integer. The test counts the remaining positions (0 expected in its fixture) and replaces SP3a's provisional fill tests (§10).

### 3.3 Parameters (`density` group, scope Terrain, stage `terrain`)

| leaf | default | meta |
|---|---|---|
| `density.noises.jag` | λ 28, 2 octaves | dims 2, wavelength 16 … 8192 |
| `density.noises.overhang` | λ 32, `yScale` 1 (λy 32), 2 octaves, persistence 0.65 (after the §8.4 retune; designed as λ 80, `yScale` 1.25, 3 octaves) | dims 3, wavelength 16 … 8192 |
| `density.noises.detail` | λ 10, 1 octave | dims 3, wavelength 4 … 256 |
| `density.detailAmpLo` | 0.6 blocks | min 0, max 8, step 0.05 |
| `density.detailAmpHi` | 1.5 blocks | min 0, max 8, step 0.05 |

- **Departures from master §3.6's figures**, made because the corner lattice is 4 blocks horizontally and 8 vertically: jag has 2 octaves (a third, at λ 7, would alias), and overhang was designed with λy 64 (λy 48's third octave, at 12, would alias). Both stay tunable. The §8.4 retune (approved by the user, 2026-10-07) made the overhang noise λ 32, 2 octaves, persistence 0.65, `yScale` 1: its octaves at λy 32 and 16 still stay ≥ 2 × the 8-block corner step.
- **Constants in `defaults.ts`.** `SLIDE` and the floor and ceiling terms stay code in SP3b. They become data with `density.defs` in SP3d.
- **Wiring.** The `terrain` stage gains `params: ['density']`. The schema change goes through `npm run test:accept-schema` and the parameter reference through `npm run docs:params`.
- **Noise metrics.** The three noises join `SCHEMA_NOISES`, so N2, N3, N5 and N6 cover them. **N5's vertical rose is amended** (master §6.4, SP1) to measure in lattice coordinates, i.e. the gradient of `z3(x, y / yScale, z)`. Measured on world axes, an anisotropic noise fails by construction (the designed overhang noise, λy 64: 1.58 against 1.15 on the fast tier; ≈ 2.8 at the master's λy 48). After the retune no default noise is anisotropic, but the amendment stays for any `yScale` edit.
- **U2.** It gains the output stage `terrain`: the hex of `regionHash` over the 1 × 1 window after `fillColumnT` on a fresh `ArrayBuffer` store, at U2's land and coast class columns, with no witness search for terrain leaves (each try costs three T columns). Its leaf filter becomes `stage ∈ {climate, shape, biome2d, terrain}`, and `liveness.test.ts` asserts that every `density.*` leaf is decided. Its perturbations stay inside each leaf's range.

## 4. The real T stage (`gen/pipeline/terrainStage.ts`)

- **Signature unchanged** (SP3a §4): `terrainStage(ctx, cx, cz, w, stop)`. `fillColumnT` and every caller are unchanged. The stage keeps a module-level DensityContext per GenContext.
- **Density phase.**
  1. Build the ColumnSample.
  2. Run `columnFn` and `positionFn`.
  3. For each of the 48 cell layers, bottom up: bounds, then corners, then voxels, into a column-wide solidity scratch.

  `stop()` is polled before every 8 cell layers (6 polls). Water needs the whole column's `top`, so no section is written during this phase.
- **Fill:**
  - y = −64 is bedrock;
  - otherwise density > 0 is stone, and anything else is air.
- **Water v0.** `top` is the y of the highest stone voxel at each (x, z) position (−64 when there is none above bedrock). Air with `top − 12 < y ≤ surfaceWaterLevel` becomes a water source (type 1, level 0).
  - `surfaceWaterLevel` is read from the nearest quart corner, as in SP3a.
  - Air under an overhang near the water line fills. Deeper enclosed air stays dry (aquifers, SP6).
- **Known v0 artefact: water walls.** A position whose own level is −∞ stays dry even when its top drops below an adjacent water surface (σ, detail and the 3D shape make this possible). It leaves a vertical water face beside a dry pit at coasts, lake rims and river banks, until aquifers and the gen-time settle (SP6, SP7). The T metrics record the share of water voxels with a horizontally adjacent air voxel at the same y, as an ungated diagnostic, and the review slices show it to the user.
- **Sections.** Sections 0 … 23 go to `setProto` in order, each stored uniform or dense per channel, with `stop()` before each (24 polls, as SP3a). On a true `stop()` the stage returns false without aux or commit; `fillColumnT` frees the column.
- **Aux A:** `WORLD_SURFACE_WG` and `OCEAN_FLOOR_WG` by scanning the voxels with SP3a §3.4's predicates, and `surfaceBiome` as in SP3a.
- **Aux B** is written for the first time. The offsets are SP3a §3.4's; the index order is pinned here:
  - `surfaceBiomeQ[qz·4 + qx]` is the quart's 2D biome before the zoom (lattice point (qx, qz), qx, qz ∈ 0 … 3);
  - `caveBiomeQ[(qy·4 + qz)·4 + qx]`, with `qy = (y + 64) >> 2` ∈ 0 … 95, is 0 (none) until SP6;
  - `tintTH` (aux A) stays unwritten; its layout is pinned by the SP that writes it.
- **Version:** the `terrain` stage goes to version 2 with `params: ['density']`, and `GENERATOR_VERSION` goes to 4. The `surfaceEst` stage keeps version 2, because the 2D estimate is unchanged (§5).
- **Determinism:** the `gen` rules apply. A column's output depends only on the seed, the params and (cx, cz).
- **SP2a minor 5:** a no-allocation assertion on the T stage's hot path: heap growth over 1000 columns must stay below a fixed bound once the caches are warm. The column stage's per-call allocations in lakes and steep are fixed or documented.

## 5. surfaceEstimate 3D (`gen/column/surfaceEstimate.ts`)

`surfaceEst3(dc, x, z): number` (an integer):
1. Let `y = ⌊offset(x, z)⌋`, with `offset` the bilinear ColumnSample value, clamped to [−64, 319].
2. If `probe(terrain)` at y is > 0, step up by 8 while the next step is > 0. Otherwise step down by 8 while the next step is ≤ 0.
3. That gives a bracket [a, a + 8] with terrain(a) > 0 ≥ terrain(a + 8). Three bisection steps reduce it to [b, b + 1], and the result is b.
4. Ends: no sign change up to 319 returns 319; none down to −64 returns −64.

- **What it reads:** the `terrain` tap (interpolated, without `detail`), so T5 measures the estimate against the real voxels.
- **Gaps:** an 8-step scan can cross a gap and return an overhang's underside. T5's single-surface filter (§8.2) excludes those positions.
- **Users in SP3b:** T5, its tests and the probe. Not the map, the biome picker or the column stage (Decision 2): the ColumnSample's `surfaceEst` stays `offset`.
- **Caching** on the quart lattice comes with its first consumer (aquifers, structures, spawn, teleport: SP4-SP9).

## 6. The slice job split across workers

The Voxels mode shows the real T with no change of its own, because the slice job calls `fillColumnT`. A real column costs about 2 ms instead of 0.7, so a 512-sample line over distinct columns would take ≈ 1 s on one worker. `pool.slice` therefore splits the work:
- **Ranges.** The 512 samples are split into one contiguous range [from, to) per worker, as `pool.stats` splits. Each worker fills its range from its own worker-local store and LRU (SP3a §5.1). A column that two ranges share is generated by both workers.
- **Message and reply.** The `slice` message gains `from, to`. `BAD_ARGS` is returned when they are not integers with 0 ≤ from < to ≤ 512.
- **Part layout and merge.** A part's buffers hold that range only, indexed `(319 − y)·(to − from) + (i − from)`. The pool merges the parts row by row into the full `(319 − y)·512 + i` layout.
- **Failures.** The first failing part rejects the call and drops its queued siblings (as `stats` does). A stale epoch is handled as before.
- **Equivalence.** The merged result is byte-identical to the single-worker slice (tested).
- **Store bound.** The slice store's comment becomes 65 × 26 = 1,690 byte slots (with aux B), still within its 16 MiB.

**Cut line:** if SP3b runs short, the split moves to SP3d and the slice stays on one worker (slower, correct).

## 7. Harness, cache and CI

- **Store API.** `ColumnView.auxB(): AuxBView | null` is added (null when the column has no aux B slot), with a master §2.5 / SP3a §3.5 amendment.
- **Region hash.** `regionHash` (SP3a §6.2) appends each column's 4096 aux B bytes (zeros when absent) after its aux A bytes.
- **Region cache.** The dump stores aux A, then aux B, per column, and `REGION_CACHE_FORMAT` goes to 2.
- **CI.** An `actions/cache@v6` step caches `test/.cache/regions` only (never the bundled worker or `taskHandler*` files). It runs before `npm run test:metrics`, keyed by `hashFiles('src/**', 'test/harness/**', 'package-lock.json')`, with no `restore-keys` (SP3a §10).
- **SP3a §10's six harness minors:**
  - a per-tier DT1 worker directory;
  - a dump's mtime refreshed on a hit;
  - `test/stateIds.lock.json` checked against `GOVERNANCE_BASE`;
  - `SLAB_FUZZ_SEED` validated;
  - `masterSpec.test.ts`'s path built through `import.meta.url`;
  - one shared `ask()` helper.
- **Review slices** (`npm run docs:review-slices`) are written to `docs/superpowers/specs/assets/sp3b/` (SP3a's evidence stays). The sites are SP3a's coast, lake and river, a mountain (a highland site with σ > 8 found by a scan) and y 62. `reviewSlices.ts` derives each line's kinds and crop checks from the voxels (top, water), not from the 2D estimate, so overhangs pass.
- **uiSmoke** gains a mountain line for the Voxels-mode screenshot.

## 8. Metrics

### 8.1 Sampling

- **Scattered columns.** T1, T2, T3 and T5 use columns generated one by one with `fillColumnT` (they are independent), on 4 region workers, each column read once by the main thread (Task 13 ruling).
  - Seeds per tier as DT1: fast '42'; quick '42'; full '42', '1', '2', '3'.
  - Profiles: default and large_biomes.
  - Columns per (profile, seed): fast 4,096 / 16,384, quick 8,192 / 32,768, full 4,096 / 16,384 (default / large_biomes). T3's 2,000 lowland border pairs set them: a default column holds ≈ 0.64 such pairs, a large_biomes one ≈ 0.17 (its biomes are 4 times larger).
  - The draw is uniform over a square of ±16384 blocks (default) or ±65536 (large_biomes, whose climate is 4 times larger), with `Xoshiro128` and a fixed seed per metric family.
- **T3** uses the x and z neighbour pairs inside each scattered column (no regions; aux A's `surfaceBiome` is per block, so borders cross the columns everywhere).
- **Regions.** T4 goes through the harness (`genRegion`, `cache: false`: each region is generated once per run).
  - T4 uses 16 × 16-column regions (256² blocks) at sites whose 2D `offset` < 40 (open ocean): fast 4, quick 4, full 16.
  - Sites are drawn as above.
- **Insufficient samples.** A part whose population is below its stated minimum fails with "insufficient sample", never passes silently. The minimums:
  - peak positions 20 columns;
  - single-surface positions for T5: 1,000;
  - lowland border pairs for T3: 2,000 (on every tier, although T3 gates on full only).

### 8.2 Definitions on voxels

- **True top.** A position's true top is `WORLD_SURFACE_WG − 1` on land (no water voxel above its highest stone) and `OCEAN_FLOOR_WG − 1` as the floor under water.
- **T5 positions.** T5 measures 16 positions per sampled column (lx, lz ∈ {2, 6, 10, 14}). T1 and T2 use all 256.

| metric | parts | threshold |
|---|---|---|
| T1 | `band`: the largest share of land tops in a sliding window [b, b + 10), b an integer; `span`: p95 − p5 of land tops; `above120`, `above200`: shares | ≤ 25 % / ≥ 60 / ≥ 6 % / ≥ 0.5 % |
| T2 | `overhangs`: share of land positions with ≥ 2 solid→air transitions above top − 30; `overhangsPeaks`: the same within windswept_hills, snowy_slopes, stony_peaks, jagged_peaks, frozen_peaks | ≥ 1.5 % / ≥ 10 % |
| T3 | `value`: Σ_pairs steep / Σ_pairs (p_a + p_b)/2, over land neighbour pairs (x and z) of two different biomes of the `lowland` family; steep = \|Δtop\| ≥ 4; p_b is biome b's inside-biome steep share over the same columns. Gates on the full tier only (the row's `tiers: ['full']`); fast and quick record it | ≤ 1.5 (full) |
| T4 | `floorSd`: mean over regions of the sd of the floor; `exposedBedrock`: floor positions at y −64 under water; `deepFloor`: floor ≤ −50 | ≥ 3 / 0 / 0 |
| T5 | \|surfaceEst3 − true top\| over single-surface land positions (exactly one solid→air transition above y −56): `median`, `p90`, `p99` | ≤ 1 / ≤ 2 / ≤ 6 |
| DT2 | `probeBulk`: voxels whose probe solidity (final > 0) differs from the block (stone ⇔ solid; air and water ⇔ not solid), y −64 excluded, plus voxels where `terrainDensityDebug`'s mask is set and `Object.is(probe, bulk)` fails; `compiledReference`: corner and voxel values where compiled ≠ reference. Fast 512, quick 8,192, full 32,768 random voxels in generated columns. | 0 / 0 |

- **T3** is redefined (master §6.4 amended). A lowland ↔ highland border is steep by design (SP2a measured 2.38 over all borders), so only borders within one family (`biomeFamily`) count. The ratio is stratified by the pair's biomes, because a pooled denominator is dominated by flat lowlands (measured: pooled 1.24 against stratified 1.66 on the same data). After the measurement (2026-10-07) the user narrowed it to borders between two `lowland` biomes: highland biomes are split by height and PV thresholds, so their borders follow slopes by design; every other family's ratio is an ungated diagnostic. T3 rests on a few dozen steep pairs per 5,000 border pairs, so it gates on the full tier only (4 seeds), through `ThresholdPart.tiers`.
- **DT2** is a new row. SP2a's batch == point stays a unit test.
- **Diagnostics** (recorded in `test/metrics/.out`, not gated): the water-wall share (§4), the per-tier populations, T3 for the other families, and the floating-rock share (land positions with a solid run ≤ 6 blocks high resting on an air gap ≥ 3 blocks, y ≥ −56; a per-column proxy that also counts thin ledges).
- **Rows.** Every new row is `activeFrom: 'SP3b'`, accepted with `npm run test:accept-thresholds` and logged in the Threshold log. SP2a's 2D rows (`T1lowland`, B1, B2, B4's 2D parts, B5, T6-T8, N4) stay. A row gates from the commit that adds it, so the T1-T5 metric code and its rows land together, after the dry run's measurement and any approved retune (§8.4).
- **SP2a minor 6** (`B2.dryRiverBiome` is 0 by construction) is not redefined in SP3b. On voxels, 26 % of river-biome positions have no water (the wet margin and the zoom jitter), so max 0 cannot hold. The part stays SP2a's 2D statement, documented as such, and a voxel river-water check moves to SP3c with the B4 voxel parts.

### 8.3 Knobs

| metric | knobs |
|---|---|
| T1, T2 | offset knots (the lowland band), σ knots; for T2 also the overhang noise (wavelength, octaves, persistence, `yScale`): its vertical derivative is too small at λ 80 for σ alone to reach 10 % in the peaks |
| T5 | `density.detailAmpLo` / `detailAmpHi` |
| T4 | σ and jag at ocean C |
| T3 | none: a failure is reported and the user decides |

### 8.4 Tuning

1. The plan's dry run measures T1-T5 on the real T before any retune.
2. If a part fails, its knobs are retuned. The user approves:
   - before/after review slices: a plain, the coast and a mountain;
   - the map;
   - the numbers.
3. A retune of `shape.*` defaults also changes the 2D world:
   - the map;
   - the SP2a goldens built from the default profile (`sp2a.column.*`, `sp2a.tile.*`, `sp2a.spawn`);
   - every 2D metric (B1, B2, B4, B5, T1lowland, T6-T8, N4).

   Those metrics must still pass on all tiers, and their values go into the exit evidence. Everything ships in the same `GENERATOR_VERSION` 4.
4. The ocean-floor σ/jag stripe (SP2b §11) is checked in the same review and fixed with the T4 knobs if it is visible.
5. **Done (2026-10-07).** The dry run measured T1.band 0.42, T2.overhangs 0.002 and T2.overhangsPeaks 0.007 on every tier, and T3 failing on the default profile. The user approved the retune of §16 item 1 (the lowland offset knots, the C 0.05 σ node and the overhang noise) from before/after slices of a plain, the coast and a mountain and from the numbers, accepted the small floating rocks above peaks it brings (an ungated diagnostic; detached islets are cleaned up in SP3d or SP6), and narrowed T3 (§8.2). The figures are in the exit evidence.

## 9. Goldens

- **New file:** `src/metrics/sp3bGoldens.ts`, added to `DET_FILES` and chained into `allGoldenKeys` / `computeAnyGolden` after SP3a's. Its unit test asserts `sp3bGoldenKeys().length === 2`.
  - `sp3b.density.ops`: FNV-1a 64 over the compiled corner and voxel values of a fixture expression that uses every op, at a fixed point list, with the default params (its noise ids are the schema's).
  - `sp3b.density.default`: the default expression at column (0, 0), seed '42', default profile: the 5 × 49 × 5 corner values and all 98,304 voxel values through the probe path (no early-outs).
- **`GENERATOR_VERSION` 4** re-records `sp3a.region.T.default` and `sp3a.region.T.large_biomes`, which now hash the real T and aux B (same keys, region and seed).
- **SP1 goldens** do not change, except `sp1.params`, which hashes `genKey` and so `GENERATOR_VERSION`. SP2a goldens change only through an approved retune of `shape.*` (§8.4). Any other change is a bug.
- **Recording happens once**, after the retune: `npm run test:goldens` refuses a changed key at an unchanged `GENERATOR_VERSION`. Any earlier v4 record (during development) is discarded by restoring `test/goldens.json` from `main` before the final record.
- **Count and checks:** the count goes from 50 to 52; `?selftest=1` (Chrome, Firefox) and Bun check all keys.

## 10. Tests (summary)

- **Unit:**
  - one test per op (value, evaluation order, ties and −0, `slide` segments, interval rule, class);
  - `validateExpr` messages with real node paths;
  - compiler placement (y and `slide` never COLUMN; COLUMN read by VOXEL goes through `positionFn`) and placement-keyed CSE;
  - **fuzz** of random `Expr` trees (`test/harness/densityFuzz.ts`): compiled == reference bit-exact, and every value inside its widened interval;
  - the §3.2 behaviour;
  - the T stage: water under an overhang, dry deep pockets, a water wall, uniform sections, the aux B layout, abort without leaks in both phases (as SP3a);
  - `surfaceEst3` on hand-built fields (bracket, ends);
  - the split slice equal to the single-worker slice;
  - `ColumnView.auxB()`;
  - the region hash and dump with aux B, and the format bump.
- **Replaced:** SP3a's provisional-fill tests (`terrainStage.test.ts`'s fill rule at land, sea, lake and river, and the no-aux-B assertions) give way to the real-T tests and the §3.2 reduction. `sliceJob.test.ts`'s coast expectations are re-checked on the real T.
- **Integration:** the 4-thread harness against the 1-thread one on the real T.
- **Metrics:** DT1, DT2 and T1-T5 on every tier, plus the amended N5 and U2 with the terrain stage.
- **Bench:**
  - `density.corner`: one corner of the default expression;
  - `terrain.real`: one column including its ColumnSample, as `terrain.provisional` did;
  - `terrain.provisional` is removed;
  - a new absolute gate `TERRAIN_P50_MAX_MS = 4` in `test/bench/gates.ts` (master §10's SP3b exit), also enforced by `bench:record`'s refusal, with `benchGates.test.ts`'s row list updated;
  - the procedure is SP3a §7's (quiet machine; bench → record → bench).
- **Tools:** `uiSmoke.ts` keeps its Voxels step and adds the mountain screenshot; the review slices are regenerated into `assets/sp3b/`.

## 11. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with DT1, DT2, T1-T5 active | `npm run build && npm test && npm run test:metrics:full` |
| CI green, with the region cache step | GitHub Actions |
| compiled == reference, probe == bulk, bounds sound | DT2, the fuzz |
| T1-T5 pass on voxels; every 2D metric still passes | `terrain.metric.ts`, all tiers |
| `GENERATOR_VERSION` 4; `sp3a.region.T.*` re-recorded, `sp3b.density.*` added, no SP1 golden change but `sp1.params` (it hashes `GENERATOR_VERSION`), SP2a goldens changed only by an approved retune; `?selftest=1` all keys in Chrome and Firefox; Bun all keys | goldens tests, browsers, Bun tool |
| bench within +30 %, `terrain.real` p50 ≤ 4 ms | `npm run bench` |
| visual review approved by the user | `assets/sp3b/` slices (coast, lake, river, mountain, y 62), a Voxels-mode screenshot of a mountain line, and the before/after set of any retune |

## 12. Governance

- **Sub-project ids.** `SubProjectId`, `SUB_PROJECTS` and `SP_DEPS`: `'SP3c'` is renamed `'SP3d'` (draft presets, inspector and slice viewer), and a new `'SP3c'` (surface rules and terrain palette) is inserted after `'SP3b'`.
- **Dependencies** (`SP_DEPS`): SP3c ← SP3b; SP3d ← SP3c; SP4 ← SP3b; SP6 ← SP3c, SP5.
- **References to the renamed SP:**
  - the profiles with `readyFrom: 'SP3c'` move to `'SP3d'`, and the "arrives in SP3c" message tests follow;
  - `test/unit/profiles.test.ts`'s `CURRENT_SP` pin moves to `'SP3b'`.
- **First commit:**
  - appends `'SP3b'` to `STARTED_SPS`;
  - sets `CURRENT_SP = 'SP3b'`;
  - accepts the thresholds lock;
  - appends to the Threshold log.
- **Master amendments** checked by `test/arch/masterSpec.test.ts` land with the id change (§14):
  - §2.5's `SubProjectId` line;
  - the §10 headers, including SP6's "(L; SP3c, SP5 for in-game review)".
- **No state appended.** `test/stateIds.lock.json` does not change; the `sp3b.registry` golden that SP3a §6.4 named moves to SP3c with the palette, as `sp3c.registry`.
- **New threshold rows** (§8.2) are `activeFrom: 'SP3b'`, each with a lock accept and a Threshold-log line. N5's amended definition lands with the schema group (§3.3).

## 13. Notes handed to later SPs

- **SP3c (surface rules and terrain palette):**
  - master §3.11's data tree, compiler and whole-column scan;
  - the terrain palette appended to the registry and the lock, with an `sp3c.registry` golden;
  - bedrock dithered over −63 … −60 (SP3b keeps the flat layer);
  - B4's voxel parts (snow in desert, the coast-band beach share, land-biome tops below sea level outside rivers and lakes), a voxel river-water check (SP2a minor 6, §8.2), and S1-S3;
  - lake-rim islets and the shoreline zoom fringe (SP2a §10).
- **SP3d:**
  - `density.defs` as an editable JSON leaf, with the inspector, mutes and slice view (master §5.5);
  - `SLIDE` and the floor and ceiling terms become data;
  - the floating_islands, amplified and archipelago drafts (SP3a §10's SP3c notes move here).
- **SP4-SP9:**
  - cache `surfaceEst3` on the quart lattice with its first consumer;
  - aquifers and the gen-time settle remove the dry pockets and water walls (SP6, SP7);
  - caves add their ops on §1's base, add the level fields' −∞ interval rule to `col`, and must keep DT2.

## 14. Master-spec amendments made with this spec

- **§10 (sub-project list):**
  - SP3b becomes **SP3b — Density and terrain shape** (L; SP3a). Deliverable: 3D voxel terrain from the density DAG with water, in the harness slices and the Voxels mode. Exit as §11 here. Cut line: the worker-split slice → SP3d.
  - A new **SP3c — Surface rules and terrain palette** (M; SP3b): master §3.11, the palette, the B4 voxel parts and S1-S3; its exit is set by its spec.
  - The old SP3c becomes **SP3d — Draft presets, inspector and slice viewer** (M; SP3c).
- **§10 (dependencies and references):**
  - SP4 ← SP3b; SP6's header becomes "(L; SP3c, SP5 for in-game review)";
  - every other old-SP3c reference (the cut-line receivers' "inspector pins", SP12's continental line) becomes SP3d, and the parallelism line reads "SP3c and SP3d alongside SP4";
  - SP2a's "a 2D `surfaceEst = offset` (SP3b replaces it)" says SP3b keeps it for the map, biomes and column stage, and SP2b's hand-over moves SP2a minor 6 on to SP3c;
  - the critical path stays SP3a → SP3b → SP4.
- **§2.5:**
  - `SubProjectId` gains `'SP3d'`;
  - `ColumnView` gains `auxB(): AuxBView | null`;
  - the `Expr` and `CompiledDensity` sketches note SP3b's op subset, field names and closures.
- **§2.3:** aux B's index orders (§4).
- **§3.6:**
  - the op set, evaluation order, ties and −0, `slide` segments, interval rules and widening of §1;
  - the `positionFn` placement of §2.1;
  - `col` is limited to finite fields until SP6;
  - J uses u = z / clampSigma;
  - jag has 2 octaves, and the overhang noise is λ 32, 2 octaves, persistence 0.65, yScale 1 after the §8.4 retune (§3.3);
  - density noises sample unscaled world coordinates.
- **§3.7:**
  - the 3D estimate is `surfaceEst3` (§5), used by T5 and later consumers;
  - the ColumnSample's `surfaceEst` (map, biomes, column stage) stays the 2D `offset`;
  - the `surfaceEst` stage version is not bumped;
  - the search bisects 3 times (an 8-block bracket to 1 block), and its quart-lattice cache comes with its first consumer.
- **§6.1:** region cache format 2 with aux B; the CI cache step.
- **§6.2:** a threshold part may name the tiers it gates on.
- **§6.4:**
  - T3 is the stratified ratio over borders between two lowland biomes, gated on the full tier only;
  - N5's vertical rose is measured in lattice coordinates;
  - DT2's parts are `probeBulk` and `compiledReference`;
  - U2 covers the `terrain` stage;
  - T5 measures `surfaceEst3`;
  - B2's `dryRiverBiome` stays 2D, and its voxel check moves to SP3c.
- **§7:** the measured column and T costs and the 4 ms T gate.
- **§1 module layout:** `gen/density/context.ts` and `probe.ts`; `metrics/sp3bGoldens.ts`; `test/harness/densityFuzz.ts`; `test/metrics/terrain.metric.ts`.
- **SP1 spec:** N5's vertical rose in lattice coordinates.
- **SP3a spec §3.5:** `ColumnView.auxB()`; **§5.1:** the slice is split across the workers (§6).

## 15. Changes made after the adversarial spec review (2026-10-07)

All 30 findings were taken. The ones that changed the design:
- **N5.** The anisotropic overhang noise would fail N5's vertical rose (measured 2.80 against 1.15), so N5 now measures in lattice coordinates.
- **COLUMN values read per voxel.** They get their own closure (`positionFn`) and a sound interval rule.
- **Retune and goldens.** A retune of `shape.*` changes SP2a goldens and every 2D metric, so they are re-run and recorded once at version 4.
- **SP2a minor 6.** It is not redefined on voxels: 26 % of river-biome positions are dry by construction. It moves to SP3c.
- **T3** is a stratified ratio with a minimum sample.
- **Fast tier.** It samples 512 columns, and every part has a minimum population, because rare parts were luck at 64 columns.
- **Metric rows** land after the measurement and any retune, with named knobs.
- **Water walls** are stated as a v0 artefact, with a diagnostic and a review.
- **Other fixes:**
  - probe and `surfaceEst3` go through a DensityContext with caches;
  - DT2 compares solidity and debug-hook values;
  - widening uses the larger endpoint;
  - CSE is keyed by placement;
  - `y` and `slide` are never COLUMN;
  - `ColumnView.auxB()`;
  - U2 covers the terrain stage;
  - the governance amendments are complete;
  - the slice split's layout and failures;
  - the surfaceEst3 bracket and ends;
  - abort polls in the density phase;
  - `slide` segments, ties and −0;
  - the bench gate's wiring;
  - the golden plumbing;
  - one list of review sites in `assets/sp3b/`;
  - unscaled noise coordinates;
  - jag 2 octaves and overhang λy 64 against aliasing;
  - T1's sliding band;
  - SP3a's provisional tests replaced.

## 16. Changes made by the implementation-plan dry run (2026-10-07)

The plan was dry-run in a scratch worktree: every task was implemented and every test, metric tier and the bench were run. These are the resulting changes to the approved spec:

1. **Retune (§8.4), approved by the user.** T1.band (0.42) and T2 (`overhangs` 0.002, `overhangsPeaks` 0.007) failed on every tier. The retune:
   - `shape.offset`'s lowland knots: C 0.05: E 0.2 PV (65, 72, 80) → (72, 84, 98), E 1 66 → 76; C 0.3: E 0.2 (66, 76, 88) → (78, 92, 108), E 0.6 70 → 90, E 1 66 → 86; C 0.6: E 0.2 (68, 82, 96) → (86, 104, 124), E 1 70 → 102;
   - `shape.sigma`'s C 0.05 node: E −1 PV (4, 16) → (12, 26), E 0 3 → 6, E 1 1.2 → 3;
   - `density.noises.overhang`: λ 80 → 32, 3 → 2 octaves, persistence 0.5 → 0.65, `yScale` 1.25 → 1. σ alone could not reach T2: the designed noise's vertical derivative (sd 0.06 per block) needs σ ≈ 16 for one overhang.

   The 2D world moves with it: the SP2a goldens of the default profile, T1lowland 0.33 → 0.08, T8.E 21.2 → 14.1 (minimum 10) and B5.highShare 0.47 → 0.65. Every 2D metric still passes. The small floating rocks above peaks are accepted; their share is a diagnostic.
2. **T3** (§8.2) gates only borders between two `lowland` biomes, and only on the full tier. Highland biomes are split by height and PV thresholds, so their borders follow slopes by design. The default lowland ratio measured 1.37 / 1.51 / 1.19 (fast / quick / full) on a few dozen steep pairs per tier, i.e. sampling noise around a true value of about 1.2-1.4. `ThresholdPart` gains `tiers`; the other families are diagnostics.
3. **Sampling** (§8.1).
   - T3 counts the neighbour pairs inside the scattered columns instead of 32 × 32 regions: the full tier's region dumps took 9.3 GB, and the fast tier's 4 regions could never reach 2,000 pairs.
   - The scattered columns grow to fast 4,096 / 16,384, quick 8,192 / 32,768 and full 4,096 / 16,384 per seed (default / large_biomes), generated on 4 workers.
   - T4 runs 4 regions on the fast tier (one large_biomes region measured 2.65 against ≈ 3.2 over more) with `cache: false`.
4. **Diagnostics** (§8.2): the floating-rock share and the other families' T3 join the water-wall share.
5. **Region hash** (§7, §9). Aux B enters `regionHash` in the `GENERATOR_VERSION` 4 commit, not with the store API: appending any byte, zeros included, changes `sp3a.region.T.*`, which `npm run test:goldens` refuses at an unchanged version.
6. **Corrections:**
   - §3.2's solid early-out is the cell's lower bound; the floor term alone decides no cell;
   - §3.3's world-axis N5 figure is 1.58 at λy 64 (2.8 was λy 48's);
   - U2's terrain leaves use the land and coast class columns, with no witness search (§3.3);
   - `sp1.params` changes with `GENERATOR_VERSION` (§9, §11);
   - structures and the beard term are SP9's (Non-goals, §5, §13);
   - §8.3 names the overhang noise as a T2 knob;
   - §14 gains the parallelism line, SP2a's `surfaceEst` line and the amendments of master §2.3, §6.1, §6.2 and §7.
7. **Measured, unchanged:**
   - `terrain.real` p50 1.42-1.46 ms against the 4 ms gate;
   - DT2 draws 5 of its 16 voxels per column from the bulk-evaluated cells and 5 near the top, because uniform voxels alone missed a mutated early-out on the fast tier;
   - a 512-sample slice over distinct columns takes 1.07 s on one worker and 0.29 s on 6;
   - SP2a minor 5 is a retained-heap assertion (< 16 KiB over 1,000 warm columns): the closures and noise calls box about 1.5 MB of short-lived doubles per column, so literal zero allocation would need a compiler rewrite;
   - the ocean-floor σ/jag stripe (§8.4 item 4) is not visible on voxels.

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP3b` (SP3b split into SP3b and a new SP3c; the old SP3c becomes SP3d); no threshold rows change.
- Task 9: DT2 row added (`probeBulk` max 0, `compiledReference` max 0, activeFrom `SP3b`); no other row changes.

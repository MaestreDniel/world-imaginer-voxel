# SP3b — Density and terrain shape (Design)

Date: 2026-10-07
Status: Written for review (design approved section by section by the user, 2026-10-06 and 2026-10-07)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3b, which this spec narrows: its surface-rule half becomes the new SP3c, and the old SP3c becomes SP3d (§12);
- §3.6 (density DAG), §3.7 (surfaceEstimate and surfaceWaterLevel), §3.16 (cross-column consistency), §3.17 (determinism);
- §5.1 (parameter model and stage hashes), §5.5 (probe);
- the testing sections §6.1-6.4 (DT1, DT2, T1-T5, P1) and §7 (performance budget).
Previous SP: `2026-10-02-sp3a-blocks-store-harness-design.md` (its §10 lists what SP3a handed over).

References written "master §x" point to the master spec, "SP3a §x" (and SP2a, SP2b) to those specs, and a bare "§x" to this document.

## Goal

Replace SP3a's provisional terrain with the real one: a data-driven density DAG (`Expr`), compiled to closures with a bit-exact reference interpreter, interval bounds and exact early-outs, drives a new T stage that fills each column with stone, water and air in 3D (overhangs, jagged peaks, surface detail). A 3D `surfaceEstimate` searches the same field. The world's shape is measured on voxels (T1-T5) and its machinery proven exact (DT1, DT2). The Voxels mode of `?map` and the harness slices show it.

## Non-goals

- Surface rules, the terrain palette and every new block state (new SP3c). SP3b's T writes only air, stone, bedrock and water; bedrock stays the flat layer at y −64.
- Caves, carvers, aquifers (SP6), structures and the beard term (SP7). The `islands` term exists but stays −1e6 (SP3d's floating_islands draft).
- The editable DAG (`density.defs` JSON, inspector, mutes, slice view): SP3d. In SP3b the expression's structure is code; its tunables are schema leaves.
- Changing the map, the cross-section's Profile mode, the biome picker or the column stage: they keep the 2D `surfaceEst` (= `offset`).
- Streaming, meshing and the coordinator (SP4).

## Decisions (confirmed by the user, 2026-10-06/07)

1. **Split:** master SP3b is cut in two. SP3b (this spec) is density, the real T, water and surfaceEstimate with T1-T5, DT2 and P1; the new SP3c is surface rules, the terrain palette, B4 (voxel parts) and S1-S3. The old SP3c becomes SP3d (§12).
2. **Map stays 2D, voxels go 3D:** the map, the preview, the biome height filter and the column stage keep the 2D `surfaceEst`; the 3D estimate is used only for voxels and T5 (§5).
3. **Tuning:** T1 and T2 are first measured on the real T; if they fail, the offset (and σ) knots are retuned and the user approves before/after slices, the map and the numbers. T3 is redefined to compare borders inside one biome family (§8).
4. **Approach A:** the master's DAG (Expr data, closure compiler with stage placement, reference interpreter, interval bounds), restricted to the ops the terrain needs; caves add ops on the same base in SP6.

## Module layout after SP3b

```
src/gen/density/
  expr.ts          the Expr node types (JSON-shaped data), structural hash, validation errors
  nodes.ts         per-op semantics: value, interval rule, class rules (one table, shared by compile and reference)
  compile.ts       ref resolution, CSE, stage placement (COLUMN / CELL / VOXEL), closure emission over scratch arrays
  reference.ts     the point interpreter (tree walk, same interpolation, bit-exact with compile)
  bounds.ts        interval evaluation per 4×8×4 cell
  probe.ts         probe(ctx, x, y, z, tap?): one point through the compiled path, no early-outs
  defaults.ts      the default expression built from params.density (§3)
src/gen/column/surfaceEstimate.ts   surfaceEst3: the 3D search on the terrain tap (§5)
src/gen/pipeline/terrainStage.ts    the real T (replaces SP3a's provisional fill)
src/gen/context.ts                  + the compiled density per GenContext
src/core/params/schema.ts           + the `density` group (§3.3)
src/workers/sliceJob.ts, protocol.ts, src/engine/workerPool.ts   + slice split across workers (§6)
test/harness/densityFuzz.ts         random Expr trees for the compile/reference/bounds fuzz
test/metrics/terrain.metric.ts      T1-T5 on voxels; region.metric.ts gains DT2
```

## 1. The Expr model (`gen/density/expr.ts`, `nodes.ts`)

### 1.1 Nodes

`Expr` is plain JSON (tagged objects, `op` field). Named sub-expressions live in a `defs: Record<string, Expr>` next to the root and are used through `ref`.

| op | fields | value |
|---|---|---|
| `const` | `v: number` (finite) | v |
| `y` | — | the voxel's (or corner's) y as a number |
| `col` | `field`: one of the ColumnSample's continuous fields (`SAMPLE_FIELDS`, finite) | the field at the position (§2.3) |
| `noise2` | `id` | `NormalNoise.z2(x, z)` of the density noise `id` |
| `noise` | `id` | `NormalNoise.z3(x, y, z)` of the density noise `id` |
| `add`, `mul`, `min`, `max` | `a, b` | a + b, a · b, min, max (`min`/`max` of equal values return `a`) |
| `neg`, `abs`, `square` | `x` | −x, \|x\|, x · x |
| `clamp` | `x, lo, hi` (constants, lo ≤ hi) | x < lo ? lo : x > hi ? hi : x |
| `slide` | `x, knots: [y, v][]` (y strictly increasing, ≥ 2 knots) | x · s(y), s piecewise linear through the knots, constant beyond the ends |
| `interpolated` | `x` | trilinear interpolation of x's corner values (§2.2) |
| `rangeChoice` | `x, lo, hi, inside, outside` (lo < hi constants) | lo ≤ x < hi ? inside : outside (only the chosen branch is evaluated) |
| `tap` | `name, x` | x (names a field for the probe, metrics and later the inspector) |
| `ref` | `name` | the value of `defs[name]` (resolved at compile time) |

- **Evaluation order is fixed:** every binary op evaluates `a` then `b`; arithmetic is IEEE double, round to nearest, in the written order; no fused or reassociated forms. `slide` evaluates `s(y)` as `v0 + (y − y0) · ((v1 − v0) / (y1 − y0))` on the segment containing y.
- **Noise** values are `z` (unit sd, clamped to ±`clampSigma`, SP1 §2.3); amplitude is a `mul`. The noise for `id` is `new NormalNoise(world, 'density.' + id, params.density.noises[id])`.
- **J uses u:** the jag term reads `u = z / clampSigma` ∈ [−1, 1] (a `mul` by the constant 1/clampSigma), so `J = (1 − |u|)²` ∈ [0, 1] (the master's formula; SP3a §10 left z vs u open).
- **Validation** (`validateExpr`, run by the compiler and by `defaults.ts`'s tests) rejects, with a message naming the node path: unknown ops or fields, non-finite constants, an unknown noise id, a `ref` cycle or unknown name, an `interpolated` inside another (the only node whose class inside `interpolated` would be VOXEL), `clamp` with lo > hi, `rangeChoice` with lo ≥ hi, `slide` knots not increasing.

### 1.2 Interval rules (`nodes.ts`)

Each op maps child intervals to its own, used by `bounds.ts` (§2.4):
- `const` [v, v]; `y` the cell's [y0, y1]; `col` the min and max of the field over the cell's four corner columns (bilinear, so exact); `noise2`/`noise` [−clampSigma, clampSigma];
- `add` [a0 + b0, a1 + b1]; `neg` [−x1, −x0]; `mul` the min and max of the four endpoint products; `min`/`max` endpoint-wise; `abs` and `square` the exact image; `clamp` the clamped endpoints;
- `slide`: s's exact range over [y0, y1] (its values at y0, y1 and every knot inside), then a `mul`;
- `interpolated`: the inner expression's interval over the cell (the interpolation stays in the hull of the corner values, which stay in that interval);
- `rangeChoice`: `inside`'s interval if x ⊆ [lo, hi), `outside`'s if x is disjoint from it, else their hull; `tap`/`ref`: the child's.

Rounding is monotone, so endpoint arithmetic in double is sound for every op above; the interpolated value can exceed the hull of its corners by rounding, so every interval leaving an `interpolated` node is widened outward by `1e-9 · (1 + |endpoint|)`. A fuzz (§10) checks that no evaluated value ever leaves its interval.

## 2. Compiler, reference, probe and bounds

### 2.1 Stage placement (`compile.ts`)

1. Resolve `ref`s; deduplicate structurally equal sub-trees (CSE by structural hash).
2. Classify each node: **COLUMN** if it depends only on `const`, `col` and `noise2`; **CELL** if it is inside `interpolated` and is not COLUMN; **VOXEL** otherwise (`noise`, `y` or arithmetic on them outside `interpolated`). Classes order COLUMN < CELL < VOXEL and a node takes its highest child's class; an `interpolated` node is evaluated per voxel by interpolating its CELL corner values (§2.2), which costs no expression evaluation.
3. Validate (§1.1).
4. Emit closures over typed scratch arrays: `columnFn` (COLUMN nodes at the 5 × 5 corner columns), `cornerFn` (CELL nodes at the 5 × 49 × 5 corners) and `voxelFn` (VOXEL nodes per voxel). No `new Function`, no `eval`.

### 2.2 Geometry and interpolation

- A column (16 × 384 × 16 voxels) is 4 × 48 × 4 cells of 4 × 8 × 4; corners at local x, z ∈ {0, 4, 8, 12, 16} and y = −64 + 8k, k = 0 … 48. Corner (i, j) is the ColumnSample lattice point `latticeIndex(i, j)`, so corners on a chunk border are computed identically by both neighbours (master §3.16).
- Voxel (lx, y, lz) in cell (ci, ck, cj) has fractions `tx = (lx − 4ci) / 4`, `ty = (y + 64 − 8ck) / 8`, `tz = (lz − 4cj) / 4`. Interpolation order is fixed: lerp along x on the four x-edges, then along z, then along y, with `lerp(a, b, t) = a + t · (b − a)`.
- `col` at a corner reads the lattice value exactly; at a voxel (VOXEL-class use) it reads the bilinear value from the four corners of its cell, in the same x-then-z order as the ColumnSample readout.

### 2.3 Reference and probe

- **`reference.ts`** evaluates an `Expr` at a point by walking the tree: COLUMN and CELL sub-trees at the cell's corners (recomputed per call), the interpolation of §2.2, VOXEL nodes at the point. It uses only `+ − × ÷ √`, `floor`, detMath and the SP1 noise classes, in the §1.1 order.
- **`probe(ctx, x, y, z, tap?)`** returns the final density (or a tap's value) at one voxel through the compiled closures without any early-out.
- DT2 requires compiled == reference bit-exact (corners and voxels) and probe == bulk (every probed voxel's solidity and value equal the T stage's).

### 2.4 Bounds and early-outs (`bounds.ts`)

Per cell, the root's interval over the cell (§1.2):
- `hi < 0`: air for every voxel of the cell; no corner or voxel evaluation;
- `lo > 0`: solid for every voxel; none either;
- otherwise the cell's 8 corners are evaluated (each corner once per column, shared by up to 8 cells) and, when the root has VOXEL nodes, `voxelFn` runs only for the voxels of cells whose interpolated interval straddles 0.

Early-outs never change a voxel: DT2's probe == bulk compares voxels produced with early-outs against the probe, which uses none. Bounds are evaluated with the same COLUMN values the corners use.

## 3. The default expression and its parameters

### 3.1 Expression (`defaults.ts`, built from `params.density`)

```
J        = square(1 − abs(noise2('jag') / clampSigma))
N3       = noise('overhang')
terrain  = tap('terrain', interpolated( col.offset + col.jag · J − y + col.sigma · slide(N3, SLIDE)
                                        + 2·max(0, −56 − y) − 2·max(0, y − 296) ))
detail   = noise('detail') · amp(E),   amp(E) = ampLo + (ampHi − ampLo) · clamp((col.E + 1) / 2, 0, 1)
final    = max( terrain + detail, islands ),   islands = tap('islands', const −1e6)
SLIDE    = [(−64, 0), (−40, 1), (240, 1), (320, 0)]
```

The floor term (`2·max(0, −56 − y)`) and the ceiling term (`−2·max(0, y − 296)`) are master §3.6's, inside the interpolated `terrain`.

`detail` is VOXEL-class (it is outside `interpolated` and reads `noise`), so it is evaluated only in straddling cells. `col.E` at a voxel is bilinear (§2.2).

### 3.2 Behaviour pinned by tests

- Above the highest possible surface (offset + jag + 3σ + |detail| < y) cells early-out to air; below y −56 the floor term makes cells early-out to solid.
- A column with σ = 0 and jag = 0 has its surface at `⌊offset⌋` ± `detail` (no overhangs): the provisional T is the special case σ = jag = detail = 0.

### 3.3 Parameters (`density` group, scope Terrain)

| leaf | default | notes |
|---|---|---|
| `density.noises.jag` | noise λ 28, 3 octaves | 2D (`noise2`) |
| `density.noises.overhang` | noise λ 80, `yScale` 80/48, 3 octaves | 3D, λy 48 |
| `density.noises.detail` | noise λ 10, 1 octave | 3D |
| `density.detailAmpLo` | 0.6 blocks | detail amplitude at E = −1 |
| `density.detailAmpHi` | 1.5 blocks | detail amplitude at E = 1 |

`SLIDE` and the floor/ceiling terms are constants of `defaults.ts` in SP3b (they become editable with `density.defs` in SP3d). The `terrain` stage gains `params: ['density']`; the schema change is accepted with `npm run test:accept-schema`, the parameter reference with `npm run docs:params`, and U2 must find every new leaf live (its witness for terrain leaves is the T stage's voxels at sampled columns).

## 4. The real T stage (`gen/pipeline/terrainStage.ts`)

- **Signature unchanged** (SP3a §4): `terrainStage(ctx, cx, cz, w, stop)`; `fillColumnT` and every caller are unchanged.
- **Per column:** build the ColumnSample; run `columnFn` on the 5 × 5 corner columns; per cell: bounds, then corners (cached per column), then voxels; then water; then the sections.
- **Fill:** y = −64 → bedrock; density > 0 → stone; else air. Then **water v0:** with `top` = the y of the highest stone voxel of the (x, z) position (−64 when none above bedrock), air with `top − 12 < y ≤ surfaceWaterLevel` becomes a water source (type 1, level 0). `surfaceWaterLevel` is read from the nearest quart corner as in SP3a. Air under an overhang near the water line fills; deeper enclosed air stays dry (aquifers, SP6). Without overhangs the rule equals SP3a's.
- **Aux A:** `WORLD_SURFACE_WG`, `OCEAN_FLOOR_WG` by scanning the voxels with SP3a §3.4's predicates; `surfaceBiome` as in SP3a.
- **Aux B** (written for the first time; SP3a §3.4 offsets, index order pinned here): `surfaceBiomeQ[qz·4 + qx]` = the quart's 2D biome before the zoom (lattice point (qx, qz)); `caveBiomeQ[(qy·4 + qz)·4 + qx]` with `qy = (y + 64) >> 2` = 0 (none) until SP6. `tintTH` (aux A) stays unwritten; its layout is pinned by the SP that writes it.
- **Order and abort** as SP3a §4: `stop()` before each of the 24 sections; on true return false without aux or commit.
- **Version:** the `terrain` stage goes to version 2 with `params: ['density']`; `GENERATOR_VERSION` goes to 4. The `surfaceEst` stage keeps version 2 (the 2D estimate is unchanged, §5).
- **Determinism:** `gen` rules; a column's output depends only on the seed, the params and (cx, cz).

## 5. surfaceEstimate 3D (`gen/column/surfaceEstimate.ts`)

- `surfaceEst3(ctx, x, z): number`: start at `y0 = ⌊offset(x, z)⌋`; step by 8 (up while `probe(terrain) > 0` at the step, else down) until the sign changes or the world ends; then 4 bisection steps on the bracket; return the highest y with `terrain > 0` found (integer). `offset` is the bilinear ColumnSample value.
- It reads the same interpolated `terrain` tap the T stage writes (without `detail`), so T5 measures the estimate against the real voxels.
- **Users in SP3b:** T5, its tests and the probe. Not the map, the biome picker or the column stage (Decision 2); the ColumnSample's `surfaceEst` stays `offset`. Caching it on the quart lattice comes with its first consumer (aquifers, structures, spawn, teleport: SP4-SP7).

## 6. The slice job split across workers

The Voxels mode now shows the real T automatically (the slice job calls `fillColumnT`). A real column costs about 2-4 ms instead of 0.7, so a 512-sample line over distinct columns would take 1-2 s on one worker. `pool.slice` splits the 512 samples into one contiguous range per worker (as `pool.stats` splits), each worker fills its range from its own worker-local store and LRU (SP3a §5.1), and the pool concatenates the parts in sample order. The message gains `from, to`; the reply's buffers hold that range only; `BAD_ARGS` and stale-epoch handling are unchanged. The result is byte-identical to the single-worker slice (tested).

**Cut line:** if SP3b runs short, the split moves to SP3d and the slice stays on one worker (slower, correct).

## 7. Harness, cache and CI

- `regionHash` (SP3a §6.2) appends each column's aux B bytes (4096, zeros when the column has none) after its aux A; the cache dump stores aux B; `REGION_CACHE_FORMAT` goes to 2.
- CI: an `actions/cache@v6` step for `test/.cache/regions` only (never the bundled `test/.cache/*Worker*` or `taskHandler*` files), before `npm run test:metrics`, keyed by `hashFiles('src/**', 'test/harness/**', 'package-lock.json')`, no `restore-keys` (SP3a §10).
- The six harness minors of SP3a §10: a per-tier DT1 worker directory; refresh a dump's mtime on a hit; `test/stateIds.lock.json` checked against `GOVERNANCE_BASE`; `SLAB_FUZZ_SEED` validated; `masterSpec.test.ts`'s path through `import.meta.url`; one shared `ask()` helper.
- `npm run docs:review-slices` regenerates the review slices from the real T (same sites as SP3a, re-picked if a feature moved; §11).

## 8. Metrics

### 8.1 Sampling

- **Scattered columns** (generated one by one with `fillColumnT`, independent): T1, T2, T5. Per tier, seeds as DT1 (fast '42'; quick '42'; full '42', '1', '2', '3'), profiles default and large_biomes; column counts fast 64, quick 1024, full 4096 per (profile, seed), drawn uniformly over the ±16384-block square with `Xoshiro128` (fixed seed per metric).
- **Regions** through the harness (`genRegion`, cache on): T3 (needs neighbours) and T4 (16 × 16 columns = 256² blocks). Fast 1 region, quick 4, full 16 per (profile, seed), at fixed sites drawn the same way (T4 sites restricted to columns whose 2D `offset` < 40, i.e. open ocean).

### 8.2 Definitions on voxels

The true top of a column position is `WORLD_SURFACE_WG − 1` on land (no water above) and `OCEAN_FLOOR_WG − 1` for the floor under water. Land = no water voxel at the top.

| metric | parts | threshold |
|---|---|---|
| T1 | `band` largest share of land tops in one 10-block band; `span` p95 − p5 of land tops; `above120`, `above200` shares | ≤ 25 % / ≥ 60 / ≥ 6 % / ≥ 0.5 % |
| T2 | `overhangs` share of land positions with ≥ 2 solid→air transitions above top − 30; `overhangsPeaks` the same within windswept_hills, snowy_slopes, stony_peaks, jagged_peaks, frozen_peaks | ≥ 1.5 % / ≥ 10 % |
| T3 | `value` = P(\|Δtop\| ≥ 4 across a border between two biomes of the **same family**) / P(\|Δtop\| ≥ 4 between neighbours inside one biome), over land neighbour pairs (x and z) | ≤ 1.5 |
| T4 | `floorSd` mean over regions of the sd of the floor; `exposedBedrock` floor positions at y −64 under water; `deepFloor` floor ≤ −50 | ≥ 3 / 0 / 0 |
| T5 | \|surfaceEst3 − true top\| over single-surface land positions (exactly one solid→air transition above y −56): `median`, `p90`, `p99` | ≤ 1 / ≤ 2 / ≤ 6 |
| DT2 | `probeBulk` mismatching probed voxels (fast 512, quick 8192, full 32768 random voxels in generated columns); `compiledReference` mismatching corner and voxel values (same counts); the SP2a `batchPoint` part is unchanged | 0 / 0 / 0 |

- **T3** is redefined (master §6.4 amended): a lowland ↔ highland border is steep by design (SP2a measured 2.38 across all borders), so only borders within one family count. Families are the registry's (`biomeFamily`).
- Every new row is `activeFrom: 'SP3b'`, accepted with `npm run test:accept-thresholds` and a Threshold-log line. SP2a's 2D rows (`T1lowland`, the 2D B4 parts) stay.
- **SP2a minor 6** (`B2.dryRiverBiome` is 0 by construction): the part is redefined on voxels, the share of river-biome land positions with no water voxel in their column, and stays max 0.

### 8.3 Tuning

The plan's dry run measures T1-T5 on the real T before any retune. If T1 or T2 fails, the offset knots (lowland band) and, if needed, σ are retuned; the user approves before/after review slices (a plain, a coast, a mountain), the map and the numbers before the change lands. The retune ships inside the same `GENERATOR_VERSION` 4. The ocean-floor σ/jag stripe (SP2b §11) is checked in the same review slices and fixed with the T4 tuning if visible.

## 9. Goldens

- `GENERATOR_VERSION` 4 re-records `sp3a.region.T.default` and `sp3a.region.T.large_biomes` (the real T and aux B; same keys, same region and seed).
- New: `sp3b.density.ops`: FNV-1a 64 over the compiled corner and voxel values of a fixture expression that uses every op, at fixed points; `sp3b.density.default`: the default expression's corner values and voxel densities of the column (0, 0), seed '42', default profile. `sp3b.region.T` is not added: the `sp3a.region.T.*` keys already hash the real T.
- No SP1 or SP2a golden changes (their inputs do not include the `density` leaves or the T stage; `sp1.params` hashes a frozen fixture). An unexpected change is a bug. The count goes 50 → 52; `?selftest=1` (Chrome, Firefox) and Bun check all.

## 10. Tests (summary)

- **Unit:** one test per op (value, order, interval rule, class); `validateExpr` messages; the compiler's CSE and placement; **fuzz** of random `Expr` trees (`test/harness/densityFuzz.ts`): compiled == reference bit-exact, and every value inside its interval; the default expression's §3.2 behaviour; the T stage: water under an overhang and dry deep pockets, uniform sections, aux B layout, abort without leaks (as SP3a), the σ = jag = detail = 0 case equal to SP3a's provisional fill; `surfaceEst3` on hand-built fields; the split slice equal to the single-worker slice.
- **Integration:** the 4-thread harness against the 1-thread one on the real T (SP3a's test, now on real terrain).
- **Metrics:** DT1 and DT2, T1-T5, every tier.
- **Bench:** `density.corner` (one corner of the default expression) and `terrain.real` (one column, absolute gate p50 ≤ 4 ms as master §7's T budget); `terrain.provisional` is removed. The bench procedure is SP3a §7's (quiet machine, bench → record → bench).
- **SP2a minor 5:** a no-allocation assertion on the T stage's hot path (heap growth over 1000 columns below a fixed bound), with the column stage's lakes and steep allocation fixed or documented.
- **Tools:** `uiSmoke.ts` keeps its Voxels step; the review slices are regenerated.

## 11. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with DT1, DT2, T1-T5 active | `npm run build && npm test && npm run test:metrics:full` |
| CI green, with the region cache step | GitHub Actions |
| compiled == reference, probe == bulk, bounds sound | DT2, the fuzz |
| T1-T5 pass on voxels (after the approved retune, if any) | `terrain.metric.ts` |
| `GENERATOR_VERSION` 4; `sp3a.region.T.*` re-recorded, `sp3b.density.*` added, no other golden changes; `?selftest=1` all keys in Chrome and Firefox; Bun all keys | goldens tests, browsers, Bun tool |
| bench within +30 % with `terrain.real` p50 ≤ 4 ms | `npm run bench` |
| visual review | the review slices (coast, lake, river, a mountain, y 62) and a Voxels-mode screenshot of a mountain line, approved by the user |

## 12. Governance

- `SubProjectId`, `SUB_PROJECTS` and `SP_DEPS`: `'SP3c'` is renamed `'SP3d'` (draft presets, inspector and slice viewer) and a new `'SP3c'` (surface rules and terrain palette) is inserted after `'SP3b'`. `SP_DEPS`: SP3c ← SP3b, SP3d ← SP3c, SP4 ← SP3b, SP6 ← SP3c. The profiles with `readyFrom: 'SP3c'` move to `'SP3d'`; the "arrives in SP3c" message test follows.
- The first commit appends `'SP3b'` to `STARTED_SPS`, sets `CURRENT_SP = 'SP3b'`, accepts the thresholds lock and appends to the Threshold log.
- No state appended: `test/stateIds.lock.json` does not change (the `sp3b.registry` golden SP3a §6.4 named moves to SP3c with the palette).
- New threshold rows (§8.2), `activeFrom: 'SP3b'`, each with a lock accept and a Threshold-log line.

## 13. Notes handed to later SPs

- **SP3c (surface rules and terrain palette):** master §3.11's data tree, compiler and whole-column scan; the terrain palette appended to the registry and the lock with an `sp3c.registry` golden; bedrock dithered over −63 … −60 (SP3b keeps the flat layer); B4's voxel parts (snow in desert, coast-band beach share, land-biome tops below sea level outside rivers and lakes) and S1-S3; lake-rim islets and the shoreline zoom fringe (SP2a §10).
- **SP3d:** `density.defs` as an editable JSON leaf with the inspector, mutes and slice view (master §5.5); `SLIDE` and the floor/ceiling terms become data; the floating_islands, amplified and archipelago drafts (SP3a §10's SP3c notes move here).
- **SP4-SP7:** cache `surfaceEst3` on the quart lattice with its first consumer; aquifers fill the dry pockets (SP6); caves add their ops on §1's base and must keep DT2.

## 14. Master-spec amendments made with this spec

- **§10:** SP3b becomes **SP3b — Density and terrain shape** (L; SP3a; deliverable: 3D voxel terrain from the density DAG with water, in the harness slices and the Voxels mode; exit as §11 here; cut line: the worker-split slice → SP3d). A new **SP3c — Surface rules and terrain palette** (M; SP3b; master §3.11, the palette, B4 voxel parts, S1-S3; exit set by its spec). The old SP3c becomes **SP3d — Draft presets, inspector and slice viewer** (M; SP3c). SP4 ← SP3b, SP6 ← SP3c; the critical path stays SP3a → SP3b → SP4.
- **§3.6:** the op set, evaluation order, interval rules and the outward widening of §1; `col` is limited to finite fields until SP6 adds the level fields' −∞ rule; J uses u = z / clampSigma.
- **§3.7:** the 3D estimate is `surfaceEst3`, used by T5 and later consumers; the ColumnSample's `surfaceEst` (map, biomes, column stage) stays the 2D `offset`; the `surfaceEst` stage version is not bumped.
- **§6.4:** T3 compares borders within one biome family; B2's `dryRiverBiome` is measured on voxels.
- **§1 module layout:** `gen/density/probe.ts`; `test/harness/densityFuzz.ts`; `test/metrics/terrain.metric.ts`.

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

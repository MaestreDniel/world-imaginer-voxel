# SP2a — Column stage, worker pool and the `?map` page (Design)

Date: 2026-09-28
Status: Implemented on branch `sp2a/column-map` (2026-09-29); exit pending CI and the Vercel preview (first-image timing in Chrome, `?selftest=1` in Chrome and Firefox)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP2, which this spec splits into SP2a and SP2b;
- the data model and generation sections: §2.4, §2.7, §3.0, §3.2-3.5, §3.7, §3.10, §3.16, §3.17;
- the engine and UI sections: §4.1, §4.3, §5.6;
- the testing and performance sections: §6.3, §6.4, §7.
Previous SP: `2026-09-27-sp1-deterministic-math-core-design.md` (§10 there lists what SP1 handed over).

References written "master §x" point to the master spec, "SP1 §x" to the SP1 spec, and a bare "§x" to this document.

## Goal

Turn the SP1 math core into a playable 2D world: every column's climate, target height, rivers, lakes and surface biome, computed identically by a point reference and a batched ColumnSample, rendered by a worker pool into an interactive map.

- The column stage (`src/gen/column/`, `src/gen/biomes/`):
  - climate with warps, `scaleMul`, CDF and the PV fold;
  - the offset, σ and jag splines, in blocks;
  - steep from the quart halo;
  - rivers: channel, valley and gorges;
  - lakes: column terms;
  - a 2D `surfaceEst`;
  - the 28 surface biomes (master's 27 plus volcano, decision 6) with picker and jittered-Voronoi zoom;
  - spawn search.
- A point reference `columnPoint` and a batched `buildColumnSample`, bit-identical at quart corners (DT2).
- A module-worker task pool with a typed protocol and map-tile, point, spawn and selftest jobs.
- The `?map` page:
  - coarse-first tiles, layers, pan and zoom, and a hover readout;
  - seed and profile, a JSON patch box, and the URL hash.
- `?selftest=1`: the column and map-tile goldens, recomputed in a real module worker in the browser.
- Metric tests B1, B4 (climate parts), N4, T6, T7, T8, T1lowland, B2 (column parts) and B5 (column parts), plus a unit test that the terrain does not depend on the biomes (in place of T3 on 2D relief, §12); the SP2a goldens; bench kernels with P1 targets.

## Non-goals

- SP2b owns the parameter panel, the spline editor, the biome table and the presets UI, together with the U2 metric and the ≤ 300 ms spline-edit preview.
- No density, voxels, surface rules, caves, aquifers or structures (SP3 and later). `surfaceEst` is the 2D estimate of §3.6, and `islandMask` is 0.
- No 3D view. The app root keeps SP0's sky and capability report, and `?map` is a standalone page (as `?lab=noise` was). Clicking the map shows a coordinate; teleport is SP4.
- No cave biomes, and no map layers for caves, structures, the player, the column-status heatmap or bookmarks (later SPs).

## Decisions (confirmed by the user, 2026-09-28)

1. **The master's SP2 splits in two.**
   - **SP2a** (this spec): column stage, pool, map and selftest.
   - **SP2b**: the parameter tooling on top of the working map.

   Each part gets its own spec, plan and PR. The dependency chain is SP1 → SP2a → SP2b → SP3.
2. **The map is its own page, `?map`.** Its logic lives in `src/ui/map/` so that SP4 can mount it as the in-game panel unchanged.
3. **Parameters in SP2a:**
   - The URL hash carries `{seed, profile, patch}`.
   - A JSON patch box validates with `applyPatch` and lists issues by path.
   - The profile select hides profiles whose `readyFrom` has not started yet.

   SP2b adds the schema-driven panel and the editors on the same state.
4. **Approach: point reference plus a verified batch.**
   - `columnPoint` is the readable oracle.
   - `buildColumnSample` is the fast path.
   - A unit test holds them bit-equal at every quart corner of thousands of random columns.
5. **`surfaceEst = offset` in SP2a.** It is the final column-stage height, after rivers and lakes. SP3 replaces it with the density-tap search of master §3.7, bumping the `surfaceEst` stage version.
6. **A volcano biome (2026-09-29), a touch of distinction from Minecraft.**
   - **In SP2a it is a climate box only:** hot peaks (§3.1), with its own map colour. Its surface identity comes later: basalt, blackstone, ash and magma via the surface rules in SP3, and lava in SP7.
   - **The volcanic cone is reserved for a later SP** (§10): sparse cells inside hot high ground that add a cone and crater to `offset` and assign the biome by the cell mask. It is not built in SP2a.

## Module layout after SP2a

New files only; SP0/SP1 files are unchanged unless listed in §8-9.

```
src/
  core/
    ids.ts                    SubProjectId gains 'SP2a' | 'SP2b' (drops 'SP2'); SUB_PROJECTS; CURRENT_SP; MetricId gains 'T1lowland'
    constants.ts              + MIN_Y, HEIGHT, SEA_LEVEL; MAP_TILE_PX, MAP_LEVELS (§6.1)
    seed.ts                   + resolveSeedText(text, random) (the SP1 seed-box rule, moved from ui/seedBox.ts)
    params/kit.ts             + the boxTable leaf kind (§4.1)
    params/schema.ts          + shape.*, rivers.*, lakes.*, biomes.* groups (§4.1)
    params/shapeDefaults.ts   offset / sigma / jag defaults, authored with autoTangents (§2.2)
    params/biomeDefaults.ts   BOX_BIOMES and the 26 default boxes (§3.1, Appendix A)
    params/profiles.ts        readyFrom 'SP2' → 'SP2a'; isProfileReady
    stage/registry.ts         prefixes and version bumps for shape, surfaceEst, biome2d, map (§4.2)
  gen/
    context.ts                GenContext: prepared noises, compiled splines and boxes, per (seed, params)
    column/climate.ts shape.ts steep.ts rivers.ts lakes.ts
    column/columnPoint.ts     samplePoint / columnPoint (the point reference) and sampleCoarse (§2.6)
    column/columnStage.ts     buildColumnSample, the ColumnSample layout and readout (§2.7-2.8)
    column/columnCache.ts     LRU of 1024 ColumnSamples keyed by colKey
    column/spawn.ts           spawn search (§2.9)
    biomes/registry.ts picker.ts zoom.ts
    map/palette.ts layers.ts tile.ts   pure tile painting (§6.1-6.2)
  workers/
    protocol.ts               typed messages + validators (§5.1)
    taskHandler.ts            pure handle(msg): configure / mapTile / point / spawn / selftest
    task.worker.ts            the module-worker shell around taskHandler
  engine/
    workerPool.ts             N workers, configure per epoch, priority queue, cancellation (§5.2)
    session.ts                WorldSession (§4.3)
  ui/
    seedBox.ts                delegates to core/seed.ts
    map/mapState.ts tileCache.ts viewMath.ts hoverPanel.ts mapView.ts mapPage.ts map.css   (§6)
    selftest/selftestPage.ts  (§6.4)
  metrics/
    columnStats.ts            water raster for B2/B5
    sp2aGoldens.ts            SP2a digests; allGoldenKeys / computeAnyGolden (§7.4)
test/
  harness/gen.ts flood.ts spline.ts
  unit/…  integration/twoWorkers.test.ts (§7.2)
  metrics/biomes.metric.ts relief.metric.ts water.metric.ts
  bench/noise.bench.ts        + the SP2a kernels and the P1 column gate (§7.5)
```

## 1. Coordinates and conventions

- **Units.** World x and z are block coordinates, integers or reals.
  - A **quart** is 4 blocks.
  - A **column** is 16 × 16 blocks: `cx = floor(x/16)`, `cz = floor(z/16)`.
  - The column's quart corners are the 5 × 5 points at `(16cx + 4i, 16cz + 4j)`, i, j ∈ 0..4.
  - The ColumnSample lattice is those corners plus a one-quart halo, 7 × 7 points, i, j ∈ −1..5.
- **One function per field.** Each field is a pure function of `(GenContext, x, z)`, composed in the fixed order of §2.6. There is no hidden state, no `Math` outside the SP1 allowlist, and every transcendental goes through detMath (SP1 §1.5).
- **Readout between corners.**
  - Continuous fields are bilinear between the four surrounding quart corners (master §2.4).
  - The biome per block comes from the jittered-Voronoi zoom (§3.3).
  - At a corner, the readout returns exactly the corner value.

## 2. Column stage

### 2.1 Climate (`gen/column/climate.ts`)

Master §3.2 applies verbatim.
- **Order:**
  1. divide by `scaleMul`;
  2. apply the shared shift warp;
  3. apply the per-field extra warps (C and R);
  4. sample the six NormalNoises;
  5. CDF to [−uMax, uMax], with uMax = 0.9973.
- `PV = 1 − |3|W| − 2|` uses W_u.
- The noises are SP1's schema instances (`noiseInstances`), with their SP1 seed names. The schema adds no new climate leaves.
- Output: `C, E, W, T, H, R, PV` and the warped coordinates `(xw, zw)` that rivers need for their gradient.

### 2.2 Shape (`gen/column/shape.ts`, `core/params/shapeDefaults.ts`)

- `offset0 = eval(offsetSpline, coords)`, `sigma = max(0, eval(sigmaSpline))`, `jag = max(0, eval(jagSpline))`. The coords are `[C, E, W, PV, T, H]` in the SP1 slot order.
- **Defaults:**
  - They are master §3.3's tables, authored with `autoTangents` (SP1 §3.4).
  - They are the same knots as SP1's `OFFSET`, `SIGMA` and `JAG` fixtures. The fixtures stay frozen for the SP1 goldens; the schema defaults are separate data that start equal to them.
  - A unit test pins schema default = fixture as long as nobody has retuned it. The first retune removes that test in the same commit, with a note in the spec's log.
- **The lowland band** (SP1 §10): the share of land columns with `offset0 ∈ [66, 76)` on the pure offset is reported by a diagnostic metric (`T1lowland`, reported, not gated; T1 itself is SP3's). If it exceeds 40 % on the full tier, the plan retunes the E 0.2 knots before exit.

### 2.3 Steep (`gen/column/steep.ts`)

- `steep = |∇offset0|` by central differences at ±4 blocks (one quart), evaluated on `offset0`, before rivers and lakes.
- `columnPoint` evaluates the 4 neighbour offsets directly. `buildColumnSample` reads them from its 7 × 7 lattice. The two agree bit for bit because the neighbour points *are* lattice points (§2.7).

### 2.4 Rivers (`gen/column/rivers.ts`)

Master §3.4 applies, with one amendment found by the plan's dry run (§12). Every constant is a `rivers.*` leaf.

- **Inputs.** `R_z` is R's NormalNoise value before the CDF. Its gradient uses ±2-block central differences in R-warped space: `h = 2/scaleMul` scaled units, `∇ = (ΔR_z)/4` per world block. `u2 = (toUniform(widthNoise(xr, zr)) + 1)/2`.
- `riverDist = |R_z| / max(|∇R_z|, 1e-4)`; `w = widthMin + widthVar·u2`; `valleyWidth = valleyBase + valleyPerE·(1 + E)`.
- `s = smoothstep(coastFadeLo, coastFadeHi, C)`; `s_alt = 1 − smoothstep(altFadeLo, altFadeHi, offset0)`.
- **Valley** (amended: strength `sv = s·s_alt` instead of `s`):
  - `t = 1 − detExp(−(max(0, riverDist − w/2)/valleyWidth)²)`;
  - `valleyOffset = lerp(min(offset0, valleyFloor + valleyRise·t), offset0, t)`;
  - `offset = lerp(offset0, valleyOffset, sv)`, with σ and jag × `(1 − sv·(1 − t))`.
- **Channel** (`riverDist < w/2`, with `r = 2·riverDist/w`, `profile = 1 − r²`):
  - `channelOffset = 63 − (depthMin + depthVar·u2)·profile`;
  - `gorgeOffset = offset0 − gorgeDepth·profile`;
  - `offset = min(offset, lerp(gorgeOffset, channelOffset, s_alt))`, σ = 0.5, jag = 0.
- **Wet.** Water (surfaceWaterLevel 63, the river biome) applies where `offset0 ≥ 63` **and** `riverDist < w/2 + wetMargin` **and** `lerp(offset0 − gorgeDepth, 63 − depth, s_alt) ≤ 62`. A channel column on land that fails the last condition is a dry **gorge**.
- **Land only** (fix of 2026-09-30). A river, wet or gorge, exists only where the column would be land without it (`offset0 ≥ 63`). On the sea floor the channel still lowers shelves shallower than its floor (a drowned mouth that continues the river under the sea), but it sets neither flag, so the column is sea: the picker gives it its climate biome, as for any other sea column, and the rivers layer shows no river there.
- **Why the land rule.** R's zero set is a line field that crosses the whole world, oceans included. Before the fix, 47 % of wet columns were at sea: seed 42 at (−38343.6, 44384), with C −0.89 and offset0 17, was a river in deep ocean. A threshold on C cannot replace the rule: the shoreline sits at C −0.138..−0.10 depending on E, and moves whenever the offset spline is edited. `offset0 ≥ 63` is the shoreline itself.
- **Why the amendment.** With the master formula the valley pulls any terrain near a river down to about 64, however high it is, so a 200-block mountain next to a river became a flat, dry valley at sea level. With `sv` the valley fades on high ground, and the channel cuts a dry gorge `gorgeDepth` (default 12) below offset0 there.
- **Outputs:** `riverDist`, `width`, `riverStrength = s·s_alt`, `offset`, `sigma`, `jag`, `wet`, `gorge`.

### 2.5 Lakes (`gen/column/lakes.ts`)

Master §3.5, with the concrete formulas the plan fixed. Constants are `lakes.*` leaves.

- **Lake space.** Lakes use world coordinates, so `scaleMul` does not scale them: `(xl, zl) = (x, z) + warpAmp·(Nx(x, z), Nz(x, z))` from `lakes.warpNoise` (.x/.z).
- **Cells.** Cell `(i, j)` has side `cell`. Its centre is `((i + 0.5 + jitter·(u − 0.5))·cell, (j + 0.5 + jitter·(v − 0.5))·cell)`, with `u = hash2(lakeSeed, i, j)/2³²` and `v = hash4(lakeSeed, 1, i, j)/2³²`. `lakeSeed = deriveSeed(seed, 'lakes.cells')`.
- **Eligibility** (`cellEligible`):
  - the centre, as a world point, is evaluated with climate → shape → rivers and no lakes;
  - the cell is enabled when all of: `hash4(lakeSeed, 2, i, j)/2³² < p`, `C > minC`, `offset0 ∈ [offsetMin, offsetMax]`, not river-wet, and `riverDist > valleyWidth`.
- **Level.** `Lw = floor(min over 8 ring points of offset0) − 1`. The ring points lie at `ringFrac·radius` from the centre, at the 8 compass directions (diagonals at ±√½). The master's `jag·J` term needs SP3's jag noise and is added there with a stage bump.
- **Depth.** `depth = depthMin + depthVar·hash4(lakeSeed, 3, i, j)/2³²`.
- **Cell memo.** Cells are memoised per GenContext under the numeric key `(i + 32768)·65536 + (j + 32768)`. The memo is cleared at 65 536 entries.
- **Per column.** The F1 cell is the nearest centre among the 3 × 3 cells around `(xl, zl)`, ties to the first in (dj, di) order. Let `d` be its distance and `q = d/radius − roughness·(rimNoise(x, z)/clamp)`.
  - **Inside** (`q ≤ 1`):
    - `offset = min(offset, Lw − depth·(1 − max(q, 0)²))`;
    - σ × sigmaMul, jag = 0;
    - `lakeMask = 1`, `lakeLevel = Lw`, `lakeFloor = Lw − depth`.
  - **Rim band** (`1 < q < 1 + rimWidth`):
    - `m = 1 − (q − 1)/rimWidth`;
    - `offset += (max(offset, Lw + rimRise + 3·rimSigma) − offset)·m`;
    - σ → min(σ, rimSigma) by m, jag → 0 by m;
    - `lakeMask = m`, and there is no water.
  - **Outside:** unchanged.
- **Order.** Lakes run after rivers, on the river-adjusted offset, σ and jag.

### 2.6 `columnPoint(ctx, x, z)` — the point reference

```
climate  → C E W T H R PV
shape    → offset0 sigma0 jag0
steep    → steep (on offset0; NaN when sampled without steep)
rivers   → riverDist riverStrength riverWet gorge offset sigma jag
lakes    → lakeMask lakeLevel lakeFloor offset sigma jag
water    → surfaceWaterLevel (lake inside → Lw; river wet (land only, §2.4) or offset < 63 → 63; else −∞)
estimate → surfaceEst = offset; islandMask = 0
biome    → picker at this point (§3.2)
```

- `samplePoint(ctx, x, z, withSteep, out)` writes every field into a reused `PointRecord` in exactly this order. `columnPoint(ctx, x, z)` is `samplePoint` with steep into a fresh record.
- Each step is a separate exported function (`sampleClimate`, `sampleShape`, `steepAt`, `sampleRivers`, `sampleLakes`, `waterLevel`, `pickBiome`), so metrics and the batch path call them directly.
- `sampleCoarse(ctx, x, z, out)` is the preview-level point (§6.1): climate, shape and biome only. It has no river, no lake, and `offset = offset0`.

### 2.7 `ColumnSample` and `buildColumnSample(ctx, cx, cz, out)`

- **Layout:** a `Float64Array(49)` per field over the 7 × 7 lattice (index `(j+1)·7 + (i+1)`), plus `flags` and `biome` as `Uint8Array(49)`. With 22 fields this is about 8.7 KB, more than master §2.4's estimate of 6.5 KB.
- **Fields:**
  - `C E W T H R PV`;
  - `offset0 sigma0 jag0`;
  - `offset sigma jag`;
  - `riverDist riverStrength surfaceWaterLevel`;
  - `lakeMask lakeLevel lakeFloor`;
  - `steep surfaceEst`;
  - `islandMask` (0);
  - flags (bit 0 river wet, bit 1 gorge).
- **The same operations as `columnPoint`, in the same order.**
  - The only reuse allowed is of values that `columnPoint` would compute identically. These are:
    - lattice-point climate and `offset0` shared by the steep stencil;
    - per-cell lake levels, cached by cell id per ColumnSample.
  - Hoisting a computation out of a point is allowed only when the hoisted expression is the same IEEE expression. A code comment names each hoist.
- **Writes into `out`**, a reused ColumnSample, with no allocation in steady state. The bench checks this through the heap-growth assertion used for SP1's spline program.
- **Halo steep.** Halo lattice points compute their steep neighbour outside the lattice with the same `offset0At` the point path uses.
- **`columnCache.ts`:** an LRU of 1024 ColumnSamples per GenContext, keyed by `colKey = (cx + 32768)·65536 + (cz + 32768)` (master §2.1: no string keys).

### 2.8 Readout

- `readField(sample, field, x, z)` interpolates the continuous fields bilinearly inside the column.
- `readLevel(sample, field, x, z)` reads the level fields (`lakeLevel`, `lakeFloor`, `surfaceWaterLevel`, which may be −∞) from the nearest quart corner. Bilinear mixing of −∞ would give NaN.
- `readBiome(sample, ctx, x, z)` uses the zoom (§3.3).
- All three return exactly the lattice value at quart corners.

### 2.9 Spawn (`gen/column/spawn.ts`)

- **Search:** a fixed spiral of quart points from (0,0), step 64 blocks, up to radius 4096.
- **Acceptance:** the first point with all of:
  - `surfaceWaterLevel = −∞` (dry land);
  - `offset ≥ 64`;
  - `steep ≤ 1.0`;
  - a surface biome that is not ocean, river or beach.
- **Fallback:** if no point passes, the least-bad point by `(water, |steep|)`.
- **Output:** `{x, z, y: floor(surfaceEst) + 1, biome}`.

## 3. Surface biomes (`gen/biomes/`, `core/params/biomeDefaults.ts`)

### 3.1 Registry and boxes

- **The 28 biomes of master §3.10** (volcano included). The registry (`gen/biomes/registry.ts`) keeps, per biome:
  - `id` (a stable u8, the index in master order, with volcano last);
  - `name`;
  - `family` (ocean | coast | river | lowland | highland);
  - a map colour.
- **Boxes.** The 26 box-picked biomes (all but river and frozen river) get a box in `params.biomes.table` (a `boxTable` leaf, §4.1): an interval per climate axis `C, E, PV, T, H`, a `wSign` (−1 | 0 | +1) and a unique `priority`.
- **Authoring rules**, checked by a unit test on the default table:
  - T and H edges are on −0.6 / −0.2 / 0.2 / 0.6, plus −0.8 for the ocean boxes only: frozen oceans are the coldest seas (T < −0.8) and liquid oceans reach down to −0.8 (tuning of 2026-09-29; frozen oceans went from 7.7 % to 3.8 % of the world).
  - C bands: deep ocean < −0.55; ocean < −0.22; coast −0.22..−0.10; inland above.
  - E splits mountains (< −0.375) from lowlands.
  - PV edges −0.6 (valleys), 0.2 (meadow) and 0.7 (peaks).
  - Windswept, snowy slopes and every peak box bound T.
  - The coast band holds beach (T ≥ −0.6), snowy beach (T < −0.6) and stony shore (mountain E), with no PV restriction.
  - Volcano takes the hot peaks: T ≥ 0.6, PV ≥ 0.7, mountain E. Hot mountain slopes are badlands.
  - River and frozen river come from the river flag (§3.2).
- **Partition.** The default boxes tile the climate space: every point lies in exactly one box, apart from shared edges and one small gap (hot, humid valleys, which go to the nearest box by overshoot). A unit test checks 20 000 random points.
- **The default table is Appendix A.** The dry run measured it against B1/B4 and needed no tuning.

### 3.2 Picker (`picker.ts`)

- **Order of rules:**
  1. River override: `isRiverChannel` (the §2.4 wet flag, so land only) gives `river`, or `frozen_river` when T_u < −0.6.
  2. Lake columns keep the land biome underneath: the picker runs on climate only.
  3. Otherwise, for each box: `fitness = Σ_axis overshoot²`, where overshoot is the distance outside the interval (0 inside).
  4. The best is the lowest fitness, with ties broken by the lowest `priority`. `wSign` boxes are skipped when sign(W) disagrees.
- **Exact ties** (equal fitness and equal priority) are impossible by construction, since priorities are unique. B1's "exact ties 0" counts equal-fitness pairs resolved by priority *inside* boxes, which should be 0 for a partition-shaped table.
- **"Outside all boxes"** means best fitness > 0. B1 caps it at 2 %.

### 3.3 Zoom (`zoom.ts`)

- Each quart centre is jittered by `hash2(seedZoom, qx, qz)` → offset in [−1.5, 1.5)² blocks.
- A block takes the biome of the nearest of the 4 surrounding jittered centres (squared distance). Ties go to the lower `(qz, qx)`.
- This gives `surfaceBiome(x, z)` per block. The map uses it at 4 blocks/px or finer.

## 4. Parameters, session and registry

### 4.1 Schema additions (all `scope: 'terrain'`, one stage each)

| group | stage | leaves (defaults) |
|---|---|---|
| `shape` | `shape` | `offset`, `sigma`, `jag`: spline leaves over `C E PV`, with y ranges −64..320, −16..64 and −16..128 (σ and jag clamped at 0 when used) |
| `rivers` | `shape` | `widthMin` 8, `widthVar` 12, `widthNoise` (λ 600, 2 octaves, uniform), `valleyBase` 30, `valleyPerE` 45, `valleyFloor` 64, `valleyRise` 2, `coastFadeLo` −0.12, `coastFadeHi` −0.02, `altFadeLo` 120, `altFadeHi` 170, `depthMin` 3, `depthVar` 3, `wetMargin` 2, `gorgeDepth` 12 |
| `lakes` | `shape` | `cell` 320, `jitter` 0.8, `warpAmp` 80, `warpNoise` (λ 360, 2 octaves, .x/.z), `p` 0.12, `minC` −0.1, `offsetMin` 66, `offsetMax` 200, `radius` 90, `rimWidth` 0.35, `roughness` 0.15, `rimNoise` (λ 48, 2 octaves), `ringFrac` 0.55, `depthMin` 4, `depthVar` 10, `rimRise` 2, `rimSigma` 0.5, `sigmaMul` 0.3 |
| `biomes` | `biome2d` | `table` (boxTable, Appendix A), `zoomJitter` 1.5 |

- **One new leaf kind: `boxTable`.** `ParamKind` already reserved it.
  - Its value is `{[row]: {C, E, PV, T, H: [lo, hi], wSign, priority}}`, with the row names fixed by the leaf.
  - Intervals lie within [−1, 1] with lo < hi. `wSign` is −1, 0 or 1. Priorities are integers 1..1000, unique within the table.
  - New issue codes: `BAD_INTERVAL` and `DUPLICATE_PRIORITY`.
  - A patch replaces the whole table (merge `atomic`), and the README shows a row count.
- Numeric intervals such as the fades are two `num` leaves, not a pair kind (YAGNI).
- **Governance:**
  - The schema-shape lock accepts the added leaves. No existing leaf changes kind, so `SCHEMA_VERSION` stays 1.
  - The README table regenerates.
  - U4 stays green.

### 4.2 Registry changes

- **`shape`** v2: params `['shape', 'rivers', 'lakes']`.
- **`surfaceEst`** v2: it keeps `reads: ['shape']` and hashes no params. Its version encodes "2D estimate".
- **`biome2d`** v2: params `['biomes']`.
- **`map`** v2: no params (tile rendering constants are code, versioned by this bump).
- **`climate`** stays v1: SP2a changes no climate code.

Every version bump is part of the golden preimages. `GENERATOR_VERSION` stays 0 because SP2a records its first goldens and changes no SP1 golden.

### 4.3 `WorldSession` (`engine/session.ts`)

- **State:** `{seedText, seed, profile, patch, params, epoch}`.
- `new WorldSession(random, init?)` takes the random-seed source as a parameter. The page passes `cryptoSeed`, and tests pass a constant.
- `setSeedText(text)` applies SP1 §1.4 through `core/seed.resolveSeedText(text, random)`: trim, and an empty box draws a random seed and writes it back.
- `setProfile(id)` accepts only a ready profile (§4.4) and resets the patch to `{}`. The UI asks for confirmation first when the patch is not empty.
- `setPatch(p)` validates `applyPatch(SCHEMA, resolveProfile(profile), p)`:
  - on failure, the issues are returned and nothing changes;
  - on success, `patch` and `params` update.
- **Epoch.** It increments only when the seed or `paramsHash(params)` changes.
- **Initial state.** An unready profile or invalid patch falls back to `default` and `{}`.
- The URL state lives in the page (§6.3), not in the session.

### 4.4 Profile readiness

- `CURRENT_SP` is a constant in `core/ids.ts`, set to `'SP2a'` in this SP's first commit.
- `isReady(profile) = spIndex(readyFrom) ≤ spIndex(CURRENT_SP)`.
- `large_biomes` moves from `readyFrom: 'SP2'` to `'SP2a'` and becomes selectable. The other profiles stay hidden.

## 5. Workers

### 5.1 Protocol (`workers/protocol.ts`, `workers/taskHandler.ts`)

Messages are plain objects checked by `parseToWorker` / `parseFromWorker`. Coordinates must stay inside the colKey window, and tile indices must satisfy `|t|·256·level ≤ 2^19`. A malformed message is answered with `error {jobId, code: 'BAD_MESSAGE'}`.

| to worker | from worker |
|---|---|
| `configure {epoch, seedText, params}` (full params, checked with `checkParams`) | `ready {epoch, stageHashes (hex), genKey}` or `error {code: 'BAD_PARAMS'}` |
| `mapTile {jobId, epoch, layer, level, tx, tz}` | `tile {jobId, epoch, rgba: ArrayBuffer (256·256·4, transferred)}` |
| `point {jobId, epoch, x, z}` | `pointResult {jobId, epoch, fields: ColumnPoint}` |
| `spawn {jobId, epoch}` | `spawnResult {jobId, epoch, spawn}` |
| `selftest {jobId, key}` (no configure needed) | `selftestResult {jobId, key, actual, error}` |
| — | `error {jobId, code: BAD_MESSAGE \| BAD_PARAMS \| NOT_CONFIGURED \| STALE_EPOCH \| INTERNAL, message}` |

- `createTaskHandler().handle(msg): {msg, transfer}` holds one GenContext per configured epoch and never touches the DOM or worker globals. `task.worker.ts` only wires it to `onmessage`/`postMessage`.
- A job whose epoch differs from the configured one gets `STALE_EPOCH` and no work is done.

### 5.2 Pool (`engine/workerPool.ts`)

- `createWorkerPool(size, spawn)` takes the worker factory as a parameter, so tests drive it with fake workers that run the real handler. `createBrowserPool(size = clamp(hardwareConcurrency − 2, 2, 6))` spawns module workers on `task.worker.ts`.
- **`configure`** goes to every worker. It resolves once all `ready` messages have arrived, and rejects if any `stageHashes` or `genKey` differ, or on `BAD_PARAMS`. Jobs queued meanwhile wait.
- **Queue.** Jobs are ordered by `(priority, id)`, with at most one in flight per worker.
- **Cancellation:**
  - `cancelTiles(pred)` rejects matching queued tiles with `JobCancelled`;
  - a new `configure` rejects every queued job, and in-flight results of an old epoch reject on arrival.
- The pool is the only place that spawns workers (SP0 arch rule).

## 6. The `?map` page (`src/ui/map/`)

### 6.1 Tiles and levels

- **Tile geometry.** A tile is 256 × 256 px at a **level** `b ∈ MAP_LEVELS = {256, 64, 16, 4}` blocks per pixel. Tile `(tx, tz)` at level b covers `[256·b·tx, 256·b·(tx+1))` in x, and the same in z. Pixel `(i, j)` samples its centre.
- **Painting** (`gen/map/tile.ts`, pure; revised by the dry run):
  - **b = 256** is the **preview level** and uses `sampleCoarse` (climate, shape and biome only; rivers and lakes are narrower than a 256-block pixel) at one point per 2 × 2 pixel block, the block centre, shaded from the neighbouring blocks at spacing 2b. A preview tile costs about 0.05 s (tuning of 2026-09-29: production first images were 281-318 ms with one sample per pixel).
  - **Finer levels** use `samplePoint` without steep at every pixel centre.
  - The dry run showed why ColumnSamples are not used for tiles: at 16 blocks/px each pixel is its own column, and even at 4 blocks/px a ColumnSample (49 points) serves only 16 pixels, so the point path is 4× cheaper. DT2 already ties the two paths together.
  - Shaded layers (relief, rivers, lakes) sample a one-pixel border in the same pass, so adjacent tiles shade seamlessly.
- **Levels on screen.** `levelFor(bpp)` gives the coarsest level ≤ 2·bpp, at least 4. Every view first requests preview tiles (priority by distance), then its own level (priority 1000 + distance).
- **Cache.** An LRU of 256 ImageBitmaps on the main thread, keyed by `(layer, level, tx, tz, seed words, layer stage hash, map stage version)` through `ui/map/tileSource.ts`. Stage hashes do not depend on the seed, so the seed is part of the key. The map stage's *hash* chains every upstream stage, so only its version enters the key; an edit invalidates only the layers whose own stage hash changed. Keys exist only while the pool runs the epoch the source was set for, so a reconfigure never stores new-world tiles under old keys (final review).
- **Display.** Zoom is continuous from 1/4 to 256 blocks/px, anchored at the cursor. The view draws cached preview tiles first and the view-level tiles on top.

### 6.2 Layers (`gen/map/layers.ts`, `palette.ts`)

| layer | colour |
|---|---|
| `biome` | registry colour |
| `relief` | hypsometric ramp of surfaceEst (63 → 263), slope-shaded from the NW by `k = 1 + ((west − east) + (north − south))/(4·b)` clamped to [0.55, 1.35]; water (level > surfaceEst) in blue by depth (0-64) |
| `rivers` | wet channel blue, dry gorge orange, a blue tint for `riverDist < 64` on land and lakes only (none on the sea, §2.4), over grey shaded relief |
| `lakes` | lake inside blue by level, rim band sand by m, over grey shaded relief |
| `C` `E` `PV` `W` `T` `H` `R` | the SP1 diverging map on [−1, 1] |
| `offset` `sigma` `jag` | a sequential ramp over −64..320, 0..16 and 0..55 |

`layerStage(layer)` gives the stage hash that invalidates each layer: `climate` for the raw fields, `biome2d` for biome, and `shape` for the rest.

The page draws the overlays: the spawn marker, the pinned point, and an optional grid whose spacing is a power of two times 16 blocks, at least 48 px.

### 6.3 Interaction and state

- **Toolbar:**
  - layer select;
  - seed box (SP1 rule through the session);
  - profile select (ready profiles only, with a confirmation before a non-empty patch is dropped);
  - JSON patch textarea and an Apply button (issues listed as `path: CODE — message`);
  - grid checkbox.
- **Side panel:**
  - the world status: seed, profile, epoch, workers, view, spawn and the first-image timing;
  - the hover readout from a `point` job, with at most one in flight and the latest position queued;
  - a click pins a point.
- **URL hash:** `{v: 1, seed, profile, patch, view: {x, z, bpp, layer}}`, written through SP1's `createUrlWriter`.
  - The seed must be non-empty and free of CR/LF.
  - The profile must be ready and the patch valid over it.
  - A bad hash opens the defaults with a notice.
- **Timing.** The first-image timing runs from `setSource` (after `configure`) to the first frame in which every preview tile of the view is drawn.

### 6.4 `?selftest=1` (`ui/selftest/selftestPage.ts`)

- The page starts a one-worker pool and sends one `selftest` message per key in `allGoldenKeys()` (SP1 then SP2a).
- It compares each digest with the bundled `test/goldens.json` and shows a row per key; a key whose computation throws shows its error.
- It ends with the summary line (`✓ all N goldens match` or `✗ …`, plus elapsed time) and copy-as-JSON. A clipboard failure is reported on the button.

## 7. Tests

### 7.1 Unit (`test/unit/`)

- **Kit:** `boxTable` validation cases (codes and paths), whole-table patches, the README row count, random tables.
- **Schema:** the SP2a leaves, scopes and stages; shape defaults equal SP1's frozen fixtures until the first retune; river and lake defaults; distinct noise seed names; the default biome table follows §3.1 (band edges, T bounds, beach, volcano, and the 20 000-point partition check).
- **Climate:**
  - `scaleMul = s` equals the unscaled climate at (x/s, z/s) bit for bit;
  - all fields stay within [−uMax, uMax];
  - PV at W = ±2/3 is 1 and at W = 0 is −1;
  - with zero warps, fields are sampled at (x, z), and the C warp moves only C.
- **Shape and steep:**
  - σ and jag are ≥ 0 (never −0) over 1M random coordinate vectors;
  - `steepFrom` and `steepAt` match the §2.3 formula.
- **Rivers:**
  - `riverTerms` at named points — channel floor, parabolic profile, valley edge, σ/jag × t, coast fade (the channel stays wet down to the shoreline, offset0 63), gorge depth and the half-altitude case;
  - the land rule (§2.4): on the sea floor (offset0 < 63, including the reported open-ocean point and a zero-depth channel) the channel still carves a drowned mouth but sets neither flag;
  - invariant over 20 000 `columnPoint`s: riverWet, gorge and the river family only where offset0 ≥ 63;
  - regression: seed 42 at (−38343.6, 44384) under the GENERATOR_VERSION 1 river parameters (R λ 1400, widths 5/9, where R's zero set crosses it) is ocean with no flag;
  - the rivers layer tints river proximity on land and lakes only.
- **Lakes:**
  - `lakeTerms` inside, on the rim (containment `Lw + rimRise + 3·rimSigma` at the inner edge) and outside;
  - the `cellEligible` rules;
  - determinism of the cell memo, jitter bounds, and that some lakes exist;
  - the nearest-cell choice.
- **Biomes:**
  - registry order, families and colours;
  - each box centre picks its biome with a clean margin;
  - W sign, river override, overshoot outside every box, edge ties by priority, volcano versus badlands;
  - the zoom's neighbourhood, determinism and tie rule.
- **columnPoint:**
  - `waterLevel` cases;
  - composition order;
  - river columns are river biomes;
  - `samplePoint` without steep equals every other field;
  - **the terrain does not depend on the biomes:** shuffling the biome table and the zoom jitter changes biomes but no height, water or steep field (this replaces T3 in SP2a, §12).
- **DT2:** 4096 random columns × 49 lattice points (seed 42), plus 512 columns with `scaleMul` 4. Every field equals `columnPoint` under `Object.is`, biome and flags included.
- **Readout:** exact at quart corners; bilinear in between; levels from the nearest corner; biome through the zoom. **Cache:** LRU order, hits, rebuilt values.
- **Spawn:** ring order; valid dry inland spawns for seeds 1-16; the all-ocean fallback.
- **Tiles:**
  - unshaded layers equal `layerColor` of the pixel-centre point;
  - the preview uses `sampleCoarse`;
  - relief shading is seamless across the tile edge;
  - determinism; palette end colours; the shading clamp; `levelFor`.
- **Protocol and handler:**
  - valid and malformed messages;
  - configure / tile / point / spawn / selftest results equal the direct functions;
  - `BAD_MESSAGE`, `NOT_CONFIGURED`, `STALE_EPOCH` and `BAD_PARAMS` keep their jobId.
- **Pool** (fake workers running the real handler):
  - size clamp;
  - configure agreement and hash disagreement;
  - bad params;
  - priority order;
  - `cancelTiles`;
  - a new epoch cancels old jobs.
- **Session:** the seed rule, profile readiness, invalid patches leave the state unchanged, epoch semantics, fallback of the initial state.
- **Map page state:** URL round-trip and fallback cases; view maths; the tile plan; the tile cache.
- **Harness:** the flood labelling and the metric-id regex (`T1lowland`).

### 7.2 Integration (`test/integration/twoWorkers.test.ts`, project `unit`)

- Bundles `taskHandler` with Vite's `build` API into `test/.cache/` (ESM, one file), then starts two Node `worker_threads` running it.
- Both workers get the same `configure`, then render the same 24 tiles (the 3 levels × 4 layers × 2 positions).
- Every returned `rgba` is equal byte for byte, and both `ready.stageHashes` are equal. This is the CI half of "two workers produce byte-identical map tiles"; the browser half is `?selftest=1`.

### 7.3 Metrics (`test/metrics/`)

All metrics sample fixed windows inside the colKey window with world seeds 1..S. B2 and B5 use a 4-block `waterRaster` (climate → shape → rivers → lakes, without steep or biome) over 2048-block regions, with 8-connected labelling (`test/harness/flood.ts`). Tiers are fast / quick / full, and every part is `activeFrom: 'SP2a'`.

| ID | measured as | threshold | dry-run full tier |
|---|---|---|---|
| B1 | surface-biome shares over sampled columns; ties = non-river points whose best and runner-up fitness are equal; outside = best fitness > 0 | minShare ≥ 0.3 %, minRareShare ≥ 0.1 % (jagged peaks, frozen peaks, badlands, volcano), largestLand ≤ 16 %, ocean family 25-45 %, ties 0, outside ≤ 2 % | 0.37 %, 0.70 %, 7.3 %, 38.4 %, 0, 0.19 % |
| B4 (climate) | windswept/taiga/snowy-taiga columns with T > 0.6, or windswept with T < −0.6; dry coast-band (C −0.22..−0.10) columns that are beach, snowy beach or stony shore | < 1 % / ≥ 70 % | 0 / 100 % |
| N4 | min over C E W T H R of sd at (0, 0) over 64 seeds ÷ global sd; spawn biome over 64 seeds | ≥ 0.8; top ≤ 30 %; ≥ 8 distinct; on land 100 % | 0.90; 14 %; 17; 100 % |
| T6 | raise knot [2], [5,1] or [7,1,1] of offset by 10: `ΣΔoffset0/Σw` over columns with w > 0 | 8.5-11.5 | 10.0 |
| T7 | median \|Δsteep\| of a 4-block step across a column border (from the two columns' own samples) ÷ median of the 4 steps inside a column; plus exact equality of the shared border point in both samples | 0.9-1.1; mismatches 0 | 1.00; 0 |
| T8 | mean over sampled (C, W) (resp. (C, E)) of the sd of land offset0 as E (resp. W through PV) sweeps [−1, 1] | ≥ 10 / ≥ 10 blocks | 21.3 / 10.3 |
| T1lowland | share of land columns with offset0 ∈ [66, 76) | ≤ 0.40 (SP1's retune trigger, now gated) | 0.335 |
| B2 (column) | median river length weighted by river cells (the length half the river water lies in, from component bounding boxes); share of land; components ≥ 300 blocks touching sea water; gorge columns cut ≥ 8 per 100 km² of land with offset0 ≥ 120; dry river biome | ≥ 300 / 2-7 % / ≥ 50 % / ≥ 1 / 0 | 551 / 3.6 % / 71 % / 2973 / 0 |
| B5 (column) | lake-mask components per km² of land; share with Lw ≥ 70 | 0.2-2 / ≥ 30 % | 1.38 / 47 % |

- **After the fix of 2026-09-30** (GENERATOR_VERSION 2, land-only rivers and the river retune), the full tier measures B2 at 498 / 3.5 % / 62 % / 7573 / 0 and the ocean family at 39.2 %. See Exit evidence.
- **T3 on 2D relief is not an SP2a metric** (§12). In SP2a the terrain is independent of the biomes by construction, and a unit test (§7.1) pins that. T3 as defined measured the correlation "mountain biomes are steep" (2.38), not the biome cliffs it targets. T3 stays in SP3 on voxel terrain.
- A metric that fails is fixed by retuning the data defaults, never by moving a threshold without a spec amendment.

### 7.4 Goldens (`metrics/sp2aGoldens.ts`)

Twenty keys:

- **`sp2a.column.point.default` and `.large_biomes`:** every ColumnPoint field (booleans as 0/1) at 4096 points from `Xoshiro128(fnv1a32('sp2a.point'))`, world seed '42'.
- **`sp2a.column.sample`:** 64 full ColumnSamples at columns from `Xoshiro128(fnv1a32('sp2a.sample'))`.
- **`sp2a.tile.<layer>.<level>`:** the RGBA digest of tile (1, −1) for the layers biome, relief, rivers and C, at levels 256, 64, 16 and 4 (16 keys).
- **`sp2a.spawn`:** spawns of seeds 1..64.

`allGoldenKeys()` and `computeAnyGolden(key)` cover SP1 and SP2a. They are checked in the V8 unit run, in Bun (`test/tools/goldensJsc.ts`, all 47 keys) and in the browser (`?selftest=1`, Chrome and Firefox). The dry run matched 47/47 in Bun 1.4.2 and in headless Chrome.

### 7.5 Bench (`test/bench/noise.bench.ts`)

Kernels are added to SP1's bench test (`test/bench/noise.bench.ts`, one baseline file):
- `column.point` (per point);
- `column.sample` (buildColumnSample);
- `map.tile.b64.biome` and `map.tile.b16.relief` (8 iterations each).

**P1 gate:** `buildColumnSample` p50 ≤ 0.7 ms, and p95 ≤ 1.2 ms checked through p99, which bounds p95 from above (tinybench keeps no samples by default).

The baseline is re-recorded in SP2a. `stageHashes.genKey` is about 5× slower than SP1's baseline, because `DEFAULTS` now carries the splines and the biome table.

Dry run: column.sample p50 0.36 ms, p99 0.51 ms; tiles about 0.31-0.34 s; killRatio 0.85.

## 8. Governance steps

- **First commit:**
  - `STARTED_SPS` gains `'SP2a'`;
  - `SubProjectId` and `SP_DEPS` gain SP2a and SP2b (SP2a ← SP1, SP2b ← SP2a, SP3 ← SP2b), and `'SP2'` is removed;
  - the thresholds lock is accepted;
  - the spec's Threshold log gets its first line.
- Each commit that changes the thresholds lock edits this spec's Threshold log (the CI per-push rule).
- The schema-shape lock is accepted when the new leaves land.
- Registry version bumps land together with the code they version.
- The arch rules:
  - the SP0 layer table already has `gen` → core, `workers` → gen/metrics, `engine` → gen types only, and `ui` → anything but materials and worker entries, so `ui/map` may use gen values such as `layerStage`;
  - the hot-module import-alias rule extends to `gen/**`;
  - `metrics/sp2aGoldens.ts` follows the determinism rules;
  - the engine-dependent-API ban matches the member name alone, so `.normalize.call(…)` is caught too (SP1 review minor).

## 9. Master-spec amendments made with this spec

- **§10:**
  - SP2 is replaced by **SP2a — Column stage, worker pool and map** (L; SP1) and **SP2b — Parameter tooling** (M; SP2a). The deliverable, exit and cut-line bullets are split as in §11 here and the SP2b summary of decision 1.
  - SP3 depends on SP2b.
  - In the critical path, SP2 becomes SP2a → SP2b.
- **§2.5:** `SubProjectId` has 'SP2a' | 'SP2b' instead of 'SP2'.
- **§3.7:** "SP2a uses `surfaceEst = offset`; SP3 introduces the density-tap search and bumps the `surfaceEst` stage."
- **§6.4:** DT2 "batch == point (column stage)" is tightened from ≤ 1e-9 to bit-exact at quart corners.
- **§6.1:** the metrics master list gains `T1lowland` (gated ≤ 0.40 from SP2a).
- **§10 SP2a exit:** T3 on 2D relief is replaced by the unit test that the terrain does not depend on the biomes (§12).
- **§3.4:** the valley fades with altitude and high ground gets dry gorges (§2.4).
- **§3.4 and §3.2 (fix of 2026-09-30):** rivers are land only: the wet flag, the gorge flag and the river biome need `offset0 ≥ 63`, and on the sea floor the channel only carves a drowned mouth (§2.4). The river retune goes with it: R λ 1400 → 1000, `w = 8 + 12·u2` (was 5 + 9·u2).
- **§5.6:** map levels are 256 (preview) / 64 / 16 / 4 blocks per pixel.
- **§1** module layout lists `gen/map/`, `workers/taskHandler.ts`, `ui/map/`, `ui/selftest/` and `test/integration/`.
- The rule scopes gain `metrics/**` and the SP1 metrics files (the SP1 review's deferred minor).

## 10. Notes handed to SP2b and later

- **SP2b:**
  - The schema-driven panel, the spline editor and the biome table edit the same `WorldSession.patch`. The map's per-layer `layerHash` already gives the partial invalidation the ≤ 300 ms spline-edit preview needs.
  - Fix the SP1 deferred minors that become reachable through the editor: spline knot and tangent bounds, and tiny amplitudes.
- **SP3:**
  - Replace the 2D `surfaceEst` (bump `surfaceEst`), fill `islandMask`, add T1/T5 against voxel terrain, and re-check the lowland diagnostic against T1.
  - Inside `w/2` the channel sets σ = 0.5 and jag = 0 even on the sea floor, where it does not lower `offset` (§2.4). On the map, only the `sigma` layer shows it, as a thin line along R's zero set across oceans (σ0 is 3 there). Voxel terrain would get a smooth stripe on the ocean floor. Limit the σ/jag override to where the channel lowers `offset`.
- **SP4:** mount `ui/map` as the in-game panel; wire click-to-teleport.
- **SP2b — biome-size slider (user request, 2026-09-29).** A 1-10 slider in the panel that drives `climate.scaleMul = 4^((v − 5)/5)`: 5 = default (1), 10 = large_biomes (4), 1 ≈ 0.33.
- **Future profile "continental" (user request, 2026-09-29; SP3 or SP12).** Large continents with islands in open ocean, the opposite of today's inland-sea look: C at a much longer wavelength (about 8000) with an offset spline where deep ocean dominates the low C band.
- **Islands and archipelagos in open ocean (user request, 2026-09-30; with the continental profile, SP3 or SP12).** Small islands or archipelagos at extremely low C, to liven up open oceans. Islets need no rivers. The land rule (§2.4) lets a channel cross any column with offset0 ≥ 63, so an island mechanism also gates rivers off islets, for example through `islandMask` or a minimum island size.
- **Volcanic cone (receiving SP: SP12 by default, pullable earlier by amendment).**
  - A column-stage term modelled on the lakes:
    - sparse warped-Voronoi cells enabled only where the cell centre has T_u ≥ 0.6 and offset0 ≥ 120;
    - a cone that raises `offset`, with a crater ring;
    - σ and jag damped on the flanks;
    - `volcano` assigned by the cell mask instead of the box.
  - It adds `volcano.*` schema leaves, bumps the `shape` and `biome2d` stages, and needs a metric (volcanoes per 100 km² of hot high land).
  - Lava in the crater waits for SP7's fluids.

## 11. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with the §7.3 table active | `npm run build && npm test && npm run test:metrics:full` |
| CI green on the SP2a pull request | GitHub Actions |
| DT2 point = batch bit-exact | `columnStage.test.ts` |
| two workers byte-identical tiles | `twoWorkers.test.ts` (Node) and `?selftest=1` (browser) |
| P1: buildColumnSample ≤ 0.7 ms p50 / 1.2 ms p90 | `npm run bench:record`, then `npm run bench` on the reference machine |
| first coarse map image ≤ 0.3 s | `?map` timing readout (preview level, default view) in Chrome on the Vercel preview, recorded in Exit evidence (dry run: 280 ms on the dev server, 6 workers) |
| `sp2a.*` goldens recorded (20); SP1 goldens unchanged | `goldens.sp2a.test.ts`; the goldens merge refuses changed keys without a GENERATOR_VERSION bump |
| JavaScriptCore matches the goldens | Bun tool, output in Exit evidence |
| `?selftest=1` green in Chrome and Firefox | manual, on the Vercel preview; JSON in Exit evidence |
| visual review | screenshots of the biome, relief, rivers, lakes and C layers at 32 and 4 bpp for seed 42, plus the large_biomes profile |

**Cut line:** the raw W/T/H/R layers and the grid overlay (→ SP2b). The dry run built both, so the cut line is only a fallback.

## 12. Changes made by the implementation-plan dry run (2026-09-29)

The plan was dry-run in a scratch worktree: every task was implemented and every test run. These are the resulting changes to the approved spec:

1. **Rivers** (§2.4). The valley fades with altitude (strength `s·s_alt`), and high ground gets a dry gorge `gorgeDepth` (new leaf, 12) below offset0. The master formula pulled mountains beside rivers down to about 64.
2. **T3 on 2D relief removed from the SP2a exit.** It is replaced by the unit test that the terrain does not depend on the biomes (§7.1, §7.3).
3. **T1lowland is gated ≤ 0.40**, not only reported. **B2's median length is weighted by river cells**: the plain median counts the many tiny loops of R's zero set. **T7 uses medians plus an exact border check**, because mean |Δsteep| is heavy-tailed.
4. **Leaf kinds:** one `boxTable` kind (already reserved) and plain `num` pairs, instead of new `pair` and `list` kinds.
5. **Map tiles** use the point path at every level; the levels are 256 (preview, climate/shape/biome only) / 64 / 16 / 4 (§6.1). ColumnSamples would cost 4-60× more per tile, and without a preview level the first image was about 1.4 s.
6. **Protocol:** the `spawn` message, plus one `selftest` message per key.
7. **ColumnSample size** is about 8.7 KB. The **lake formulas** are concrete (§2.5). The **seed-box rule** moves to `core/seed.ts`. The **map constants** move to `core/constants.ts` (gen may not export numbers).
8. **Bench:** p95 is gated through p99, and the baseline is re-recorded because the schema grew.
9. **Arch:** `ui/map` uses gen values under the existing SP0 table. The `.normalize.call` hole is closed.

## Exit evidence

Done (2026-09-29, branch `sp2a/column-map`; 12th Gen Intel(R) Core(TM) i7-12700H, Node v24.21.0):
- `npm run typecheck`, `npm run build`, `npm test` (616 passed, 2 skipped), `npm run test:metrics` and `npm run test:metrics:full` all green.

Metrics as measured (`test/metrics/.out/*.json`):

| metric | fast | quick | full |
|---|---|---|---|
| B1.minShare | 0.0034 | 0.0036 | 0.0037 |
| B1.minRareShare | 0.0071 | 0.0069 | 0.007 |
| B1.largestLand | 0.0729 | 0.0734 | 0.0732 |
| B1.oceanFamilyMin | 0.3855 | 0.3843 | 0.3841 |
| B1.oceanFamilyMax | 0.3855 | 0.3843 | 0.3841 |
| B1.ties | 0 | 0 | 0 |
| B1.outside | 0.0019 | 0.0019 | 0.0019 |
| B4.hotColdSpruceWindswept | 0 | 0 | 0 |
| B4.coastBandBeach | 1 | 1 | 1 |
| N4.originSdRatio | 0.8978 | 0.9008 | 0.9029 |
| N4.spawnTopShare | 0.1406 | 0.1406 | 0.1406 |
| N4.spawnDistinct | 17 | 17 | 17 |
| N4.spawnOnLand | 1 | 1 | 1 |
| T6.minGain | 10 | 10 | 10 |
| T6.maxGain | 10 | 10 | 10 |
| T7.value | 0.9855 | 0.9866 | 1.002 |
| T7.borderMismatch | 0 | 0 | 0 |
| T8.E | 21.12 | 21.19 | 21.28 |
| T8.PV | 10.14 | 10.06 | 10.33 |
| T1lowland.value | 0.3325 | 0.3342 | 0.3349 |
| B2.medianLength | 360.3 | 475.2 | 551.3 |
| B2.landShareMin | 0.0416 | 0.0433 | 0.0361 |
| B2.landShareMax | 0.0416 | 0.0433 | 0.0361 |
| B2.mouths | 0.871 | 0.8182 | 0.7143 |
| B2.gorgesPer100km2 | 4004 | 2537 | 2973 |
| B2.dryRiverBiome | 0 | 0 | 0 |
| B5.perKm2Min | 1.224 | 1.535 | 1.38 |
| B5.perKm2Max | 1.224 | 1.535 | 1.38 |
| B5.highShare | 0.4444 | 0.4545 | 0.4681 |

Bench (`npm run bench:record`, then a gated `npm run bench`; 15 kernels; `column.sample p50 0.350 ms, p99 (≥ p95) 0.507 ms`; `killRatio 0.835`):

| kernel | ns/eval | ratio to calibration |
|---|---|---|
| `calibration.fmix32` | 0.636 | 1 |
| `lattice3.slice` | 22.73 | 35.727 |
| `perm512.slice` | 27.865 | 43.797 |
| `lattice3.random` | 22.804 | 35.843 |
| `perm512.random` | 26.854 | 42.207 |
| `normal.z2.climateC` | 321.936 | 506.005 |
| `normal.z3.density3d` | 218.873 | 344.015 |
| `spline.offset` | 44.753 | 70.342 |
| `spline.mix3` | 87.756 | 137.932 |
| `detErf` | 3.12 | 4.904 |
| `stageHashes.genKey` | 197030 | 309683.377 |
| `column.point` | 16014.531 | 25170.959 |
| `column.sample` | 351885 | 553077.882 |
| `map.tile.b64.biome` | 325498211.5 | 511604249.538 |
| `map.tile.b16.relief` | 314875469.5 | 494907875.313 |

JavaScriptCore: `npx --yes bun@1 test/tools/goldensJsc.ts` → `47/47 match on Bun 1.4.2 (JavaScriptCore)`. The goldens recorded in V8 are identical to the plan's dry run.

Browser checks (headless Chrome over the DevTools protocol, dev server, 6 workers):
- `?map`: tiles cover the view; hover, patch errors, reconfiguration and reload restore all work, with no console errors.
- First image of the default view (64 blocks/px): 254-319 ms over eight loads. The `large_biomes` view at 256 blocks/px needs 20 preview tiles: 1025 ms.
- `?selftest=1`: `✓ all 47 goldens match` (6.2 s).

Screenshots (`docs/superpowers/specs/assets/sp2a/`, 1400 × 900, seed 42, 256-colour palette PNGs):
- `biome-64.png`, `relief-64.png`, `rivers-64.png`, `lakes-64.png`, `C-64.png`;
- `biome-4-spawn.png`, `relief-4-spawn.png`;
- `biome-256-large_biomes.png`.

Observations for SP2b: at 64 blocks/px the rivers layer is speckled, because channels are narrower than a pixel. Oceans at the default λ 2400 read as 2-5 km seas rather than continents; this is a tuning target for the editor.

Done after the merge (2026-09-29): `main` pushed at 6d03c93, CI green, production (Vercel) serves `?map`.
- Production, headless Chrome: the `?map` checks all pass. First image 281 / 318 / 308 ms: over the 300 ms target, so the preview level was tuned (2 × 2 sampling, below).
- Production, headless Chrome: `?selftest=1` `✓ all 47 goldens match` (6.1 s).
- Production, Firefox 152 (the user): 47/47 match. The JSON is in `assets/sp2a/selftest-firefox-v0.json` (GENERATOR_VERSION 0 build).

Tuning of 2026-09-29, with GENERATOR_VERSION 0 → 1:
- Frozen oceans take only T < −0.8 (3.8 % of the world, down from 7.7 %).
- Preview tiles sample one point per 2 × 2 pixels.
- Goldens re-recorded: 10 keys changed (sp1.params through genKey's version, the column points and sample, the 4 preview tiles, biome at 64 and 16).
- Bun 47/47. All metric tiers green (B1 full: minShare 0.37 %, ocean family 38.4 %).
- Production after the tuning (e75cea2, CI green):
  - `?map` first image 111 / 115 / 113 ms in headless Chrome (target ≤ 300 ms), all `?map` checks green;
  - `?selftest=1` `✓ all 47 goldens match` in headless Chrome (5.8 s) and 47/47 in Firefox 152 (the user; JSON in `assets/sp2a/selftest-firefox-v1.json`).

Fix of 2026-09-30, GENERATOR_VERSION 1 → 2 (rivers in open ocean, reported by the user from production):
- Rivers are land only (§2.4): no wet or gorge flag, and so no river biome, where offset0 < 63. The rivers layer no longer tints river proximity on the sea (§6.2).
- Retune that goes with it: R λ 1400 → 1000, `widthMin` 5 → 8, `widthVar` 9 → 12, which brings the river land share back to what it was before the fix.
- Goldens re-recorded: 14 keys changed (sp1.params through genKey's version, the column points and sample, spawn, and biome, relief and rivers at 64, 16 and 4). The preview tiles did not change, since level 256 samples no rivers.
- `npm run build`, `npm test` (627 passed, 2 skipped), quick and full metrics green. Bun 47/47. Gated bench: `column.sample p50 0.346 ms, p99 (≥ p95) 0.485 ms`.
- Every metric that moved. The others (B4, N4 other than spawnTopShare, T6, T8, T1lowland) are unchanged at the precision of the table above:

| metric | before (full) | fast | quick | full |
|---|---|---|---|---|
| B1.minShare | 0.0037 | 0.0037 | 0.0037 | 0.0037 |
| B1.minRareShare | 0.007 | 0.007 | 0.0069 | 0.0069 |
| B1.largestLand | 0.0732 | 0.0718 | 0.0722 | 0.072 |
| B1.oceanFamily | 0.3841 | 0.393 | 0.3919 | 0.3917 |
| B1.outside | 0.0019 | 0.0019 | 0.0018 | 0.0018 |
| N4.spawnTopShare | 0.1406 | 0.125 | 0.125 | 0.125 |
| T7.value | 1.002 | 0.9855 | 0.9866 | 1.001 |
| B2.medianLength | 551.3 | 405.6 | 403.1 | 497.7 |
| B2.landShare | 0.0361 | 0.0373 | 0.0318 | 0.0352 |
| B2.mouths | 0.7143 | 0.6471 | 0.6667 | 0.6173 |
| B2.gorgesPer100km2 | 2973 | 6618 | 8133 | 7573 |
| B5.perKm2 | 1.38 | 0.979 | 1.364 | 1.17 |
| B5.highShare | 0.4681 | 0.4286 | 0.4737 | 0.4615 |

- Why the retune. With the land rule alone, three locked gates failed:
  - B2 land share: 1.57-1.67 %, against a minimum of 2 %;
  - B2 mouths: 0.375 on the full tier, against a minimum of 0.5;
  - B1 minShare: 0.19 % (frozen river), against a minimum of 0.3 %.
  The earlier values passed only because about half of the river cells were at sea, and B2 counts every river cell as land. The retune meets the gates with real land rivers; no threshold moved.
- Open, handled separately: about 83 % of the coast-band columns picked as beach, snowy beach or stony shore are under water, because the C band −0.22..−0.10 is wider than the shoreline (−0.138..−0.10).


### Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP2a`; no threshold rows yet.
- Task 14: add B1 (minShare ≥ 0.003, minRareShare ≥ 0.001, largestLand ≤ 0.16, ocean family 0.25-0.45, ties ≤ 0, outside ≤ 0.02), B4 (hotColdSpruceWindswept ≤ 0.01, coastBandBeach ≥ 0.7) and N4 (originSdRatio ≥ 0.8, spawnTopShare ≤ 0.3, spawnDistinct ≥ 8, spawnOnLand ≥ 1), all `activeFrom: 'SP2a'`.
- Task 15: add T6 (gain 8.5-11.5), T7 (median ratio 0.9-1.1, borderMismatch ≤ 0), T8 (E, PV ≥ 10) and T1lowland (≤ 0.40), all `activeFrom: 'SP2a'`.
- Task 16: add B2 (weighted median length ≥ 300, land share 0.02-0.07, mouths ≥ 0.5, gorges ≥ 1 per 100 km², dry river biome ≤ 0) and B5 (lakes per km² 0.2-2, share with Lw ≥ 70 ≥ 0.3), all `activeFrom: 'SP2a'`.

## Appendix A — default surface-biome table

Uniform climate units; `[lo, hi]` per axis; W = `wSign` (0 any); P = priority. Source: `src/core/params/biomeDefaults.ts`.

| biome | C | E | PV | T | H | W | P |
|---|---|---|---|---|---|---|---|
| deep_ocean | −1, −0.55 | any | any | −0.8, 0.6 | any | 0 | 1 |
| ocean | −0.55, −0.22 | any | any | −0.8, 0.6 | any | 0 | 2 |
| warm_ocean | −1, −0.22 | any | any | 0.6, 1 | any | 0 | 3 |
| frozen_ocean | −1, −0.22 | any | any | −1, −0.8 | any | 0 | 4 |
| beach | −0.22, −0.1 | −0.375, 1 | any | −0.6, 1 | any | 0 | 5 |
| snowy_beach | −0.22, −0.1 | −0.375, 1 | any | −1, −0.6 | any | 0 | 6 |
| stony_shore | −0.22, −0.1 | −1, −0.375 | any | any | any | 0 | 7 |
| plains | −0.1, 1 | −0.375, 1 | −1, 0.2 | −0.2, 0.2 | −1, 0.2 | 0 | 8 |
| meadow | −0.1, 1 | −0.375, 1 | 0.2, 1 | −0.2, 0.2 | −1, 0.2 | 0 | 9 |
| forest | −0.1, 1 | −0.375, 1 | any | −0.2, 0.6 | 0.2, 0.6 | −1 | 10 |
| birch_forest | −0.1, 1 | −0.375, 1 | any | −0.2, 0.6 | 0.2, 0.6 | +1 | 11 |
| dark_forest | −0.1, 1 | −0.375, 1 | −0.6, 1 | −0.2, 0.6 | 0.6, 1 | 0 | 12 |
| taiga | −0.1, 1 | −0.375, 1 | any | −0.6, −0.2 | any | 0 | 13 |
| snowy_taiga | −0.1, 1 | −0.375, 1 | any | −1, −0.6 | 0.2, 1 | 0 | 14 |
| snowy_plains | −0.1, 1 | −0.375, 1 | any | −1, −0.6 | −1, 0.2 | 0 | 15 |
| desert | −0.1, 1 | −0.375, 1 | any | 0.6, 1 | −1, 0.2 | 0 | 16 |
| savanna | −0.1, 1 | −0.375, 1 | any | 0.2, 0.6 | −1, 0.2 | 0 | 17 |
| swamp | −0.1, 1 | −0.375, 1 | −1, −0.6 | −0.2, 1 | 0.6, 1 | 0 | 18 |
| jungle | −0.1, 1 | −0.375, 1 | −0.6, 1 | 0.6, 1 | 0.2, 1 | 0 | 19 |
| badlands | −0.1, 1 | −1, −0.375 | −1, 0.7 | 0.6, 1 | any | 0 | 20 |
| windswept_hills | −0.1, 1 | −1, −0.375 | −1, 0.7 | −0.2, 0.6 | any | 0 | 21 |
| snowy_slopes | −0.1, 1 | −1, −0.375 | −1, 0.7 | −1, −0.2 | any | 0 | 22 |
| stony_peaks | −0.1, 1 | −1, −0.375 | 0.7, 1 | −0.2, 0.6 | any | 0 | 23 |
| jagged_peaks | −0.1, 1 | −1, −0.375 | 0.7, 1 | −1, −0.2 | any | +1 | 24 |
| frozen_peaks | −0.1, 1 | −1, −0.375 | 0.7, 1 | −1, −0.2 | any | −1 | 25 |
| volcano | −0.1, 1 | −1, −0.375 | 0.7, 1 | 0.6, 1 | any | 0 | 26 |

Measured shares (dry run, full tier): all ≥ 0.37 %, volcano 0.72 %, taiga (largest land) 7.3 %, ocean family 38.4 %.

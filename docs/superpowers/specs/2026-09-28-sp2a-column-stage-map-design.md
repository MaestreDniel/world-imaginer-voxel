# SP2a — Column stage, worker pool and the `?map` page (Design)

Date: 2026-09-28
Status: Draft for review
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
- A module-worker task pool with a typed protocol and `MAP_TILE` jobs.
- The `?map` page:
  - coarse-first tiles, layers, pan and zoom, and a hover readout;
  - seed and profile, a JSON patch box, and the URL hash.
- `?selftest=1`: the column and map-tile goldens, recomputed in a real module worker in the browser.
- Metric tests B1, B4 (climate parts), N4, T3 (2D relief), T6, T7, T8, B2 (column parts) and B5 (column parts); the SP2a goldens; bench kernels with P1 targets.

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

New files only; SP0/SP1 files are unchanged unless listed in §9.

```
src/
  core/
    ids.ts                    SubProjectId gains 'SP2a' | 'SP2b' (and drops 'SP2'); CURRENT_SP (§4.4)
    params/schema.ts          + shape.*, rivers.*, lakes.*, biomes.* groups (§4.1)
    params/shapeDefaults.ts   offset / sigma / jag defaults, authored with autoTangents (§2.2)
    params/biomeDefaults.ts   the 28 surface biome boxes as data (§3.1)
    params/profiles.ts        readyFrom 'SP2' → 'SP2a'
    stage/registry.ts         prefixes and version bumps for shape, surfaceEst, biome2d, map (§4.2)
  gen/
    context.ts                GenContext: noises, warps, compiled splines, biome table, per (seed, paramsHash)
    column/climate.ts shape.ts rivers.ts lakes.ts steep.ts
    column/columnPoint.ts     the point reference (§2.6)
    column/columnStage.ts     buildColumnSample + the ColumnSample layout (§2.7)
    column/columnCache.ts     LRU of 1024 ColumnSamples
    column/spawn.ts           spawn search (§2.9)
    biomes/registry.ts picker.ts zoom.ts
    map/layers.ts tile.ts palette.ts   pure tile painting (§5.3)
  workers/
    protocol.ts               typed messages + validators (§5.1)
    taskHandler.ts            pure `handle(msg)`: configure / MAP_TILE / SELFTEST (§5.1)
    task.worker.ts            the module-worker shell around taskHandler
  engine/
    workerPool.ts             N workers, configure per epoch, queue, cancellation (§5.2)
    session.ts                WorldSession: seed text, profile, patch, epoch (§4.3)
  ui/
    map/mapPage.ts mapView.ts tileCache.ts hoverPanel.ts mapState.ts map.css   (§6)
    selftest/selftestPage.ts
  metrics/
    sp2aFixtures.ts sp2aGoldens.ts columnStats.ts
test/
  unit/…  metrics/column.metric.ts biomes.metric.ts water.metric.ts  bench/column.bench.ts
  integration/twoWorkers.test.ts   (§7.2)
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

- Master §3.4 applies verbatim. Every constant in it is a schema leaf under `rivers.*` (§4.1).
- `R_z` is R's NormalNoise value *before* the CDF. Its gradient uses ±2-block central differences in warped space.
- Outputs: `riverDist`, `riverStrength` (s·s_alt), the adjusted `offset`, `sigma` and `jag`, `surfaceWaterLevel` (63 or −∞), and `isRiverChannel` / `isGorge` flags.

### 2.5 Lakes (`gen/column/lakes.ts`)

- Master §3.5 applies verbatim. Constants are `lakes.*` leaves.
- **Cells.** Warped Voronoi with cell 320:
  - Cell centres are jittered by `hash2(seedLakes, i, j)`.
  - Each enabled cell is evaluated once, at its centre, by a column-stage point call without lakes (no recursion).
  - `Lw` is computed from 8 ring samples at 0.55·R.
- **Per column,** the F1 cell gives:
  - `lakeMask`, from the F1 distance with the λ 48 rim noise;
  - `lakeLevel = Lw`, with `lakeFloor = Lw − depth`;
  - the offset, σ and jag adjustments;
  - `surfaceWaterLevel = Lw` inside the mask.
- **Order.** Lakes run after rivers. A cell whose centre is in a river valley (`riverDist < valleyWidth`) is disabled.

### 2.6 `columnPoint(ctx, x, z)` — the point reference

A plain function returning a frozen `ColumnPoint` object:

```
climate  → C E W T H R PV
shape    → offset0 sigma0 jag0
steep    → steep (on offset0)
rivers   → riverDist riverStrength offset sigma jag surfaceWaterLevel flags
lakes    → lakeMask lakeLevel lakeFloor offset sigma jag surfaceWaterLevel
estimate → surfaceEst = offset
biome    → surfaceBiome (picker at this point; §3.2)
```

- The steps run in exactly this order. Each step is a separate exported function, so metrics and the hover can call a prefix.
- It is written for clarity: a few allocations per call are fine. The fast path is §2.7.

### 2.7 `ColumnSample` and `buildColumnSample(ctx, cx, cz, out)`

- **Layout:** a `Float64Array` per field over the 7 × 7 lattice (index `(j+1)·7 + (i+1)`), plus `surfaceBiomeQ: Uint8Array(49)`. This is about 6.5 KB (master §2.4).
- **Fields:**
  - `C E W T H R PV`;
  - `offset0 sigma0 jag0`;
  - `offset sigma jag`;
  - `riverDist riverStrength surfaceWaterLevel`;
  - `lakeMask lakeLevel lakeFloor`;
  - `steep surfaceEst`;
  - `islandMask` (0);
  - the flags as a `Uint8Array`.
- **The same operations as `columnPoint`, in the same order.**
  - The only reuse allowed is of values that `columnPoint` would compute identically. These are:
    - lattice-point climate and `offset0` shared by the steep stencil;
    - per-cell lake levels, cached by cell id per ColumnSample.
  - Hoisting a computation out of a point is allowed only when the hoisted expression is the same IEEE expression. A code comment names each hoist.
- **Writes into `out`**, a reused ColumnSample, with no allocation in steady state. The bench checks this through the heap-growth assertion used for SP1's spline program.
- **`columnCache.ts`:** an LRU of 1024 ColumnSamples per worker, keyed by `(cx, cz)` and cleared on `configure`.

### 2.8 Readout

- `readField(sample, field, x, z)` interpolates bilinearly inside the column.
- `readBiome(sample, ctx, x, z)` uses the zoom (§3.3).
- Both return exactly the lattice value at quart corners.

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

- **The 28 biomes of master §3.10** (volcano included), each with:
  - `id` (a stable u8, in master order);
  - `name`;
  - `family` (ocean | coast | river | lowland | highland);
  - `priority` (a unique integer);
  - a colour for the map;
  - a **box**: an interval per climate axis `C, E, PV, T, H` and an optional `wSign` (−1 | 0 | +1).
- **Authoring rules** (master §3.10), checked by a unit test on the default table:
  - T and H edges are on −0.6 / −0.2 / 0.2 / 0.6.
  - C bands: deep ocean < −0.55; ocean < −0.22; coast −0.22..−0.10; near inland −0.10..0.05; mid 0.05..0.30; far > 0.30.
  - E has 7 bands, with edges −0.78 / −0.375 / −0.2225 / 0.05 / 0.45 / 0.55.
  - PV runs from valleys (< −0.6) up to peaks (> 0.7).
  - Windswept and peak boxes bound T.
  - Beach covers the whole coast band for temperate T, with no PV restriction. Snowy beach covers cold T and stony shore covers high E.
  - River and frozen river are not picked from boxes: they come from the river flag (§3.2).
  - Volcano takes the hot-peaks niche: T in the top band (T_u ≥ 0.6), PV > 0.7 and E in the two lowest bands (mountainous). It sits in the highland family with a priority above stony peaks and badlands, so those no longer receive hot peaks. B1 treats it as rare.
- **The table is data under `biomes.*`** (§4.1). The concrete default table (28 rows) is authored in the implementation plan's first biome task. It is tuned there against B1/B4 on the fast tier and recorded as Appendix A of this spec in the same commit. The rules above are the contract; the numbers are tuning.

### 3.2 Picker (`picker.ts`)

- **Order of rules:**
  1. River override: `isRiverChannel` gives `river`, or `frozen_river` when T_u < −0.6.
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

| group | stage | leaves |
|---|---|---|
| `shape` | `shape` | `offset`, `sigma`, `jag` (spline leaves, coords `C E W PV`, y range per master §3.3) |
| `rivers` | `shape` | `widthMin` 5, `widthVar` 9, `widthNoise` (λ 600), `valleyBase` 30, `valleyPerE` 45, `coastFade` [−0.12, −0.02], `altFade` [120, 170], `channelDepthMin` 3, `channelDepthVar` 3, `wetMargin` 2 |
| `lakes` | `shape` | `cell` 320, `warpAmp` 80, `warpNoise` (λ 360), `p` 0.12, `offsetRange` [66, 200], `minC` −0.1, `ringFrac` 0.55, `depthMin` 4, `depthVar` 10, `rimNoise` (λ 48), `rimRise` 2, `rimSigma` 3, `sigmaMul` 0.3 |
| `biomes` | `biome2d` | `table` (a list leaf of box rows, §3.1), `zoomJitter` 1.5 |

- New leaf kinds are the smallest additions to the SP1 kit:
  - `pair(min, max)`, an ordered numeric interval;
  - `list(rowSchema, {minLen, maxLen})` for the biome table.

  Both come with their validation codes, patch semantics (a list is replaced whole, never merged) and README rendering.
- **Governance:**
  - The schema-shape lock gains the new leaves: added leaves need only an accept. No existing leaf changes kind, so `SCHEMA_VERSION` stays 1.
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
- `setSeedText(text)` applies SP1 §1.4: trim, and an empty box draws a random seed and writes it back.
- `setProfile(id)` accepts only a ready profile (§4.4) and resets the patch to `{}` after confirmation in the UI.
- `setPatch(p)` validates `applyPatch(SCHEMA, resolveProfile(profile), p)`:
  - on failure, the issues are returned and nothing changes;
  - on success, `params` and `epoch` update.
- **Epoch.** The epoch increments on every accepted change. Unchanged params (same `paramsHash`) do not bump it.
- `toHash()` / `fromHash()` read and write the world URL state `{v: 1, seed, profile, patch}`:
  - canonical JSON, base64url;
  - decode validation as in the SP1 lab: a bad hash gives the defaults plus a notice.
- The page adds the view `{x, z, bpp, layer}` under `view`.

### 4.4 Profile readiness

- `CURRENT_SP` is a constant in `core/ids.ts`, set to `'SP2a'` in this SP's first commit.
- `isReady(profile) = spIndex(readyFrom) ≤ spIndex(CURRENT_SP)`.
- `large_biomes` moves from `readyFrom: 'SP2'` to `'SP2a'` and becomes selectable. The other profiles stay hidden.

## 5. Workers

### 5.1 Protocol (`workers/protocol.ts`, `workers/taskHandler.ts`)

Messages are plain objects validated by a hand-written `isX(msg)` per kind; an invalid message is answered with `error {jobId?, code: 'BAD_MESSAGE'}`.

| to worker | from worker |
|---|---|
| `configure {epoch, seedText, params}` | `ready {epoch, stageHashes, genKeyHex}` |
| `mapTile {jobId, epoch, layer, zoom, tx, tz}` | `tile {jobId, epoch, rgba: ArrayBuffer (256·256·4, transferred)}` |
| `point {jobId, epoch, x, z}` | `point {jobId, epoch, fields: ColumnPoint}` |
| `selftest {jobId}` | `selftest {jobId, rows: GoldenRow[]}` |
| — | `error {jobId?, code, message}` |

- `taskHandler.handle(msg): Reply` is pure apart from its own GenContext and LRU, and never touches the DOM. `task.worker.ts` only wires it to `onmessage`/`postMessage`.
- A job whose epoch differs from the configured epoch is answered with `error {code: 'STALE_EPOCH'}` without work.

### 5.2 Pool (`engine/workerPool.ts`)

- `N = clamp(navigator.hardwareConcurrency − 2, 2, 6)`, module workers created with `new Worker(new URL('../workers/task.worker.ts', import.meta.url), {type: 'module'})`.
- **`configure`** goes to all workers. The pool resolves once every `ready` has arrived, and fails loudly (a visible error) if any `stageHashes` differ.
- **Queue:** a priority queue ordered by `(zoomLevel coarse-first, distance to view centre)`. At most one in-flight job per worker.
- **`cancel(predicate)`** drops queued jobs. In-flight results of an old epoch are discarded on arrival.
- The pool is the only place that spawns workers (SP0 arch rule).

## 6. The `?map` page (`src/ui/map/`)

### 6.1 Tiles and levels

- A **tile** is 256 × 256 px at a **level** `bpp ∈ {32, 16, 4}` blocks per pixel. Tile `(tx, tz)` at level b covers `[256·b·tx, 256·b·(tx+1))` in x, and the same in z.
- **Painting** (`gen/map/tile.ts`, pure). The sample point of each pixel is its centre.
  - **b = 32:** one `columnPoint` prefix per pixel. Fields stop at the prefix the layer needs.
  - **b = 16 and 4:** `buildColumnSample` per covered column, through the worker's LRU, then `readField`/`readBiome` at each pixel centre.
- **Cache:** an LRU of 256 on the main thread, keyed by `(layer, b, tx, tz, layerHash)`.
  - `layerHash` is the stage hash that layer depends on:
    - `climate` for raw C/E/W/T/H/R/PV;
    - `shape` for offset/σ/jag, relief, rivers and lakes;
    - `biome2d` for biomes;
    - all of them combined with `map`.
  - An edit invalidates only the layers whose hash changed.
- **Display.** The view shows continuous zoom from 1/4 to 64 blocks/px, anchored at the cursor. For every screen area it draws the finest cached tile, scaled, and requests missing tiles coarse-first.

### 6.2 Layers (`gen/map/layers.ts`, `palette.ts`)

| layer | source | colour |
|---|---|---|
| `biome` | `surfaceBiome` | registry colour |
| `relief` | `surfaceEst` + water | hypsometric ramp; slope shading lit from the NW, from the 4-neighbour difference in the same tile; water at `surfaceWaterLevel` in blue by depth |
| `rivers` | `riverDist`, flags | channel, valley ramp, gorge highlight, over grey relief |
| `lakes` | `lakeMask`, `lakeLevel` | lake water by level, rim band, over grey relief |
| `C` `E` `PV` | raw fields | the SP1 diverging map on [−1, 1] |
| `W` `T` `H` `R` | raw fields | the same (cut line, §11) |
| `offset` `sigma` `jag` | shape outputs | sequential ramps with fixed ranges (offset −64..320, σ 0..16, jag 0..55) |

**Overlays:** spawn marker, a grid (256-block lines, with column lines at bpp ≤ 1), and the pinned readout point.

### 6.3 Interaction and state

- **Toolbar:**
  - layer select;
  - seed box (SP1 `resolveSeedText`);
  - profile select, ready profiles only;
  - JSON patch textarea with an Apply button. Issues are listed as `path: CODE — message`.
- **Side panel:** hover readout from a `point` job, throttled to one in flight. It shows every `ColumnPoint` field, the biome name, and x/z. Clicking pins the readout.
- **URL hash:** `{v: 1, seed, profile, patch, view: {x, z, bpp, layer}}`, written through SP1's `createUrlWriter`. A bad hash opens the defaults with a notice.
- **Timing.** The page measures, with `performance.now()`, the time from `configure` to the first full coarse screen, and shows it in the side panel (§10 evidence).

### 6.4 `?selftest=1` (`ui/selftest/selftestPage.ts`)

- Spawns one pool worker and sends `selftest`. The worker recomputes every `sp2a.*` golden (§7.4) and the SP1 goldens, and compares them with the bundled `test/goldens.json` via SP1's `compareGoldens`.
- The page shows the SP1 panel's summary, rows and copy-as-JSON. Every golden computation is wrapped: a thrown error shows `✗ key error: …` instead of stalling (this fixes SP1's deferred minor for the new page).

## 7. Tests

### 7.1 Unit (`test/unit/`)

- **Climate:**
  - `scaleMul = s` equals the unscaled climate at (x/s, z/s) bit for bit;
  - warps are applied in the §2.1 order;
  - PV at W = ±2/3 is 1 and at W = 0 is −1.
- **Shape:** σ, jag ≥ 0 over 1 M random coords; schema default = fixture (§2.2).
- **Rivers:** hand-built R fields (a stub `GenContext` whose R noise is a linear ramp) give the master §3.4 channel depth, the valley shape, the coast fade and the gorge case, each at named points.
- **Lakes:**
  - a stub cell gives `Lw`, the mask, the rim containment `rim ≥ Lw + 2 + 3·σ_rim`, and the disable rules;
  - the lake-cell cache agrees with the uncached evaluation.
- **Biomes:**
  - the table follows the §3.1 authoring rules;
  - each biome's box centre picks that biome;
  - no equal-fitness pairs among box centres;
  - the zoom is deterministic, with the tie rule.
- **DT2:** for 4096 random columns × 49 lattice points, every `ColumnSample` field equals `columnPoint` at that point under `Object.is`, biome ids included.
- **Readout:** exact at corners; bilinear in between, checked against a hand computation.
- **Spawn:** deterministic; the fixture seeds give the recorded spawns; the fallback path is taken on a stub all-ocean context.
- **Session:**
  - seed rules;
  - profile readiness;
  - an invalid patch leaves the state unchanged;
  - epoch semantics;
  - hash round-trip and bad-hash fallback cases.
- **Protocol:** every message kind is valid; malformed messages give `BAD_MESSAGE`; a stale epoch gives `STALE_EPOCH`.
- **Tile:**
  - A b = 32 tile equals, pixel for pixel, colours computed directly from `columnPoint` at its pixel centres.
  - A b = 16 or b = 4 tile equals colours computed from `readField`/`readBiome` over independently built ColumnSamples at its pixel centres.
  - Together with DT2 this ties both paths to the point reference.

### 7.2 Integration (`test/integration/twoWorkers.test.ts`, project `unit`)

- Bundles `taskHandler` with Vite's `build` API into `test/.cache/` (ESM, one file), then starts two Node `worker_threads` running it.
- Both workers get the same `configure`, then render the same 24 tiles (the 3 levels × 4 layers × 2 positions).
- Every returned `rgba` is equal byte for byte, and both `ready.stageHashes` are equal. This is the CI half of "two workers produce byte-identical map tiles"; the browser half is `?selftest=1`.

### 7.3 Metrics (`test/metrics/`)

- **Sampling.** Every metric samples `columnPoint` on fixed windows inside the colKey window, with seeds 1..S and point sets from `samplePoints` (SP1).
- **Rasters.** Metrics that need connectivity (B2, B5) rasterise on a 4-block grid over square regions and use `test/harness/flood.ts`, a union-find labelling of the raster.
- **Tiers.** Sizes are per tier (fast / quick / full), and `activeFrom: 'SP2a'` for every part.

| ID | measured as | threshold |
|---|---|---|
| B1 | surface-biome shares over the sampled land and sea; ties; outside-all-boxes | each ≥ 0.3 % (rare ≥ 0.1 %: jagged peaks, frozen peaks, badlands, volcano); largest land biome ≤ 16 %; ocean family 25-45 %; exact ties 0; outside ≤ 2 % |
| B4 (climate) | T_u ≥ 0.2 or ≤ −0.6 columns inside windswept or taiga-family boxes; coast-band land columns whose biome is beach, snowy beach or stony shore | < 1 % / ≥ 70 % |
| N4 | sd of each climate field at (0,0) over 64 seeds vs its global sd; spawn biome over 64 seeds | ≥ 0.8; most common ≤ 30 %; ≥ 8 distinct; on land 100 % |
| T3 (2D) | P(\|Δoffset\| ≥ 4 across a biome border) / P(within a biome), 4-block neighbour pairs | ≤ 1.5 |
| T6 | raise one knot per depth (C, C→E, C→E→PV) by 10: `ΣΔoffset0 / Σw` over columns with w > 0 | 10 ± 1.5 |
| T7 | `steep` gradient ratio across column borders vs interior, from ColumnSamples | 0.9-1.1 |
| T8 | per-axis relief: sd of land `offset0` when E_u (resp. W) sweeps [−1, 1] at sampled other coords | ≥ 10 blocks (E) / ≥ 10 blocks (PV) |
| B2 (column) | river columns: median connected length (4-block raster, 8-connected), share of land, components ≥ 300 blocks touching ocean, gorge columns per 100 km² of land with offset0 ≥ 120 | ≥ 300 / 2-7 % / ≥ 50 % / ≥ 1 |
| B5 (column) | lakes (connected lake-mask components) per km² of land; share with Lw ≥ 70 | 0.2-2 / ≥ 30 % |
| T1lowland | share of land columns with offset0 ∈ [66, 76) (diagnostic) | reported, not gated |

Metrics that fail on the fast tier during implementation are fixed by retuning the data defaults (§3.1, §2.2), never by moving a threshold without a spec amendment.

### 7.4 Goldens (`metrics/sp2aGoldens.ts`)

- **`sp2a.column.point.<profile>`:** a digest of every `ColumnPoint` field at 4096 points from `Xoshiro128(fnv1a32('sp2a.point'))`, world seed '42'. Profiles: default and large_biomes.
- **`sp2a.column.sample`:** a digest of 64 full ColumnSamples at fixed `(cx, cz)`.
- **`sp2a.tile.<layer>.<b>`:** the RGBA digest of fixed tiles for biome, relief, rivers and C at b = 32, 16 and 4 (12 keys).
- **`sp2a.spawn`:** spawns of seeds 1..64.

The goldens are recorded once and checked in the V8 unit run, in Bun (the SP1 JSC tool extended to `sp2a.*`), and in the browser via `?selftest=1` (Chrome and Firefox).

### 7.5 Bench (`test/bench/column.bench.ts`)

Kernels, added to SP1's baseline file:
- `columnPoint`;
- `buildColumnSample` (cold LRU);
- `mapTile.b32.biome`;
- `mapTile.b16.relief`.

**P1 targets (gated):** `buildColumnSample` ≤ 0.7 ms p50 and ≤ 1.2 ms p90 on the reference machine. The +30 % regression gate and the calibration ratios work as in SP1 §7.5.

## 8. Governance steps

- **First commit:**
  - `STARTED_SPS` gains `'SP2a'`;
  - `SubProjectId` and `SP_DEPS` gain SP2a and SP2b (SP2a ← SP1, SP2b ← SP2a, SP3 ← SP2b), and `'SP2'` is removed;
  - the thresholds lock is accepted;
  - the spec's Threshold log gets its first line.
- Each commit that changes the thresholds lock edits this spec's Threshold log (the CI per-push rule).
- The schema-shape lock is accepted when the new leaves land.
- Registry version bumps land together with the code they version.
- The arch rules gain:
  - `gen/**` imports only `core/**` (and `world/store/api.ts` types, unused in SP2a);
  - `workers/**` may import `gen/**`;
  - `ui/map/**` and `engine/**` import `gen/**` only as types;
  - the SP1 determinism rules (Math allowlist, hot-module import aliasing) extend to `gen/**`.

## 9. Master-spec amendments made with this spec

- **§10:**
  - SP2 is replaced by **SP2a — Column stage, worker pool and map** (L; SP1) and **SP2b — Parameter tooling** (M; SP2a). The deliverable, exit and cut-line bullets are split as in §11 here and the SP2b summary of decision 1.
  - SP3 depends on SP2b.
  - In the critical path, SP2 becomes SP2a → SP2b.
- **§2.5:** `SubProjectId` has 'SP2a' | 'SP2b' instead of 'SP2'.
- **§3.7:** "SP2a uses `surfaceEst = offset`; SP3 introduces the density-tap search and bumps the `surfaceEst` stage."
- **§6.4:** DT2 "batch == point (column stage)" is tightened from ≤ 1e-9 to bit-exact at quart corners.
- **§6.1:** the metrics master list gains `T1lowland` (diagnostic).
- **§1** module layout lists `gen/map/`, `workers/taskHandler.ts`, `ui/map/`, `ui/selftest/` and `test/integration/`.
- The rule scopes gain `metrics/**` and the SP1 metrics files (the SP1 review's deferred minor).

## 10. Notes handed to SP2b and later

- **SP2b:**
  - The schema-driven panel, the spline editor and the biome table edit the same `WorldSession.patch`. The map's per-layer `layerHash` already gives the partial invalidation the ≤ 300 ms spline-edit preview needs.
  - Fix the SP1 deferred minors that become reachable through the editor: spline knot and tangent bounds, and tiny amplitudes.
- **SP3:** replace the 2D `surfaceEst` (bump `surfaceEst`), fill `islandMask`, add T1/T5 against voxel terrain, and re-check the lowland diagnostic against T1.
- **SP4:** mount `ui/map` as the in-game panel; wire click-to-teleport.
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
| first coarse map image ≤ 0.3 s | `?map` timing readout on the Vercel preview (Chrome), recorded in Exit evidence |
| `sp2a.*` goldens recorded; SP1 goldens unchanged | `goldens.sp2a.test.ts`; `git diff` of `test/goldens.json` adds keys only |
| JavaScriptCore matches the goldens | Bun tool, output in Exit evidence |
| `?selftest=1` green in Chrome and Firefox | manual, on the Vercel preview; JSON in Exit evidence |
| visual review | screenshots of the biome, relief, rivers, lakes and C layers at 32 and 4 bpp for seed 42, plus the large_biomes profile |

**Cut line:** the raw W/T/H/R layers and the spawn fallback refinement (→ SP2b).

## Exit evidence

(Filled in at SP exit.)

### Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

## Appendix A — default surface-biome table

(Recorded by the plan's first biome task, §3.1.)

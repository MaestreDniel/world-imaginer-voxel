# SP3c — Surface rules and terrain palette (Design)

Date: 2026-10-07
Status: Written for review (design approved section by section by the user, 2026-10-07)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3c (created by SP3b), whose deliverable, exit and cut line this spec sets;
- §2.2 (block registry: the palette appends), §3.10 (biomes), §3.11 (surface rules), §3.16 (cross-column consistency), §3.17 (determinism);
- §5.1 (parameters and stage hashes), §5.5 (probe: the surface-rule branch path);
- the testing sections §6.1-6.4 (DT1, DT2, S1, S2, S3, B4, B2, T1-T5, U2, P1) and §7.
Previous SP: `2026-10-07-sp3b-density-terrain-design.md` (its §13 lists what SP3b handed over).

References written "master §x" point to the master spec, "SP3a §x", "SP3b §x" (and SP2a, SP2b) to those specs, and a bare "§x" to this document.

## Goal

Give the voxel terrain its skin. A data-driven surface-rule tree, compiled to closures and checked against a reference evaluator, runs a whole-column scan inside the T stage and turns SP3b's stone into the blocks of each biome: grass and dirt, sand and sandstone, gravel, clay and mud under water, snow above the snowline, stone cliffs, deepslate underground, dithered bedrock and the badlands' terracotta bands. Twenty-two terrain block types join the frozen registry. The result is measured on voxels (S1, S2, S3, B4, a river-water check), reviewed by the user in slices and the Voxels mode, and proven deterministic and exact (DT1, DT2).

## Non-goals

- Ice on water and snow layers: they run in the decorate stage (D, master §3.11 rule 5), with their own states.
- Cave floors and ceilings, `caveBiome` and the cave palettes (moss, dripstone, abyss): SP6.
- The JSON editor for the rules (`surface.rules` as an editable leaf) and the inspector: SP3d. In SP3c the rule tree is code; its tunables are schema leaves.
- Textures and the per-biome grass tint (`FACE_TEX`, tint colormaps): SP8a. The Voxels mode shows one flat colour per block.
- Changing the density, the 2D map, the biome picker or the world's height limits and sea level (fixed constants, see Decision 5).

## Decisions (confirmed by the user, 2026-10-07)

1. **Palette:** the master's full terrain palette, 22 types (§2), all without properties.
2. **2D defects inherited from SP2a** (lake-rim islets, the shoreline zoom fringe): measured in the dry run with voxel diagnostics; fixed in SP3c with the user's approval if they show, otherwise handed to SP10.
3. **Approach A:** the master's data condition tree compiled to closures, with a whole-column scan (§3), rule ids for the probe, tunables as schema leaves.
4. **Tuning:** as SP3b — measure first; any retune (surface depth, snowline, lapse, patch thresholds, the lake and zoom parameters for Decision 2) is shown to the user as before/after slices and lands inside the same `GENERATOR_VERSION` 5.
5. **Fixed world constants:** the height limits (y −64 … 319) and sea level (63) are not SP3c knobs: they shape the store layout, the aux heightmaps, the region hash and every golden.

## Module layout after SP3c

```
src/world/blocks/defs.ts         + 22 terrain types (§2), appended after bedrock
src/gen/surface/
  rules.ts         the rule and condition types (JSON-shaped data), validateRules with node paths, rule ids
  conditions.ts    per-condition semantics shared by compile and reference
  compile.ts       rules → closures over the scan context; the fast-path analysis (§3.4)
  reference.ts     a tree-walking evaluator (same order, same results) for tests and DT2
  scan.ts          the whole-column scan: runs, depths, sky, water, steep, T_eff, biome, surfaceDepth
  defaults.ts      the default rule tree built from params.surface (§4)
  probe.ts         surfaceProbe(dc, x, y, z) → { state, path: rule ids }
src/gen/pipeline/terrainStage.ts   + the surface pass after density and water
src/core/params/schema.ts          + the `surface` group (§3.5)
src/ui/crossSection/voxels.ts      + colours, legend entries and hover rule path
src/metrics/sp3cGoldens.ts         sp3c.* goldens (in DET_FILES)
test/harness/surfaceFuzz.ts        random rule trees for the compile/reference fuzz
test/metrics/surface.metric.ts     S1, S2, S3, B4 voxel parts, the river check, 2D-defect diagnostics
test/stateIds.lock.json            + 22 entries
```

## 1. The T stage after SP3c

T runs, per column: the ColumnSample; SP3b's density phase (solidity); SP3b's water v0; **the surface pass** (§3), which rewrites solid voxels from stone to their final block and sets bedrock; then aux A, aux B and the 24 sections as before (SP3b §4). The surface pass reads only the column's own data (its solidity and water, its ColumnSample, the seed): a column's output still depends only on the seed, the params and (cx, cz) (master §3.16). `stop()` is polled before the surface pass and keeps SP3b's other polls. The `terrain` stage goes to version 3 with `params: ['density', 'surface']`; `GENERATOR_VERSION` goes to 5.

## 2. The terrain palette

### 2.1 Types

Twenty-two types without properties append to `BLOCK_DEFS` after bedrock, in this order (state ids 3 … 24):

| # | type | sound | tint | notes |
|---|---|---|---|---|
| 3 | `grass_block` | grass | grass | top of grassy biomes; tinted by biome from SP8a |
| 4 | `dirt` | dirt | none | |
| 5 | `coarse_dirt` | dirt | none | taiga / savanna patches |
| 6 | `podzol` | dirt | none | taiga / jungle patches |
| 7 | `mud` | dirt | none | swamp patches |
| 8 | `sand` | sand | none | |
| 9 | `red_sand` | sand | none | badlands top |
| 10 | `sandstone` | stone | none | under sand |
| 11 | `red_sandstone` | stone | none | under red sand |
| 12 | `gravel` | gravel | none | |
| 13 | `clay` | dirt | none | underwater patches |
| 14 | `calcite` | stone | none | stony-peaks patches |
| 15 | `snow_block` | snow | none | snowline and snowy peaks |
| 16 | `packed_ice` | glass | none | frozen-peaks cliffs and patches |
| 17 | `deepslate` | stone | none | below y 0 (no `axis`: Decision recorded in §2.2) |
| 18 | `terracotta` | stone | none | badlands bands |
| 19 | `white_terracotta` | stone | none | 〃 |
| 20 | `orange_terracotta` | stone | none | 〃 |
| 21 | `yellow_terracotta` | stone | none | 〃 |
| 22 | `brown_terracotta` | stone | none | 〃 |
| 23 | `red_terracotta` | stone | none | 〃 |
| 24 | `light_gray_terracotta` | stone | none | 〃 |

Common values (all 22): `OPACITY` 15, `PASS` opaque, `SHAPE` cube, `FULL_FACES` 63, `EMIT` 0, `REPLACEABLE` false, `COLLIDE` cube, `FLUID_MODE` block, `FACE_TEX` 0 (until SP8a). `CARVABLE` is true for every type except `packed_ice` (SP6 caves carve soil and stone, not ice).

### 2.2 Lock, golden and frozen choices

- `npm run test:accept-state-ids` appends the 22 keys (bare type names) to `test/stateIds.lock.json`; the commit message says the lock changed (SP3a §2.3).
- **`sp3c.registry`:** SP3a §6.4's byte stream (canonical key, 0 byte, `STATE_TYPE` u16 LE, the u8 tables, the six `FACE_TEX` u16 LE) over states 3 … 24, a fixed count. `sp3a.registry` (states 0-2) does not change.
- Frozen by the lock: `deepslate` has no `axis` (a later axis variant would be a new type with `withType`); `ice`, `snow` layers, moss, grass plants and every cave or decoration block are not added here (their SPs append them).

## 3. Rules, compiler and scan

### 3.1 The rule model (`rules.ts`)

A surface rule is JSON data:

| kind | fields | result |
|---|---|---|
| `sequence` | `rules: Rule[]` | the first child that yields a block |
| `condition` | `if: Condition, then: Rule` | `then`'s result when `if` holds, else none |
| `block` | `state: string` (canonical key, §2.3 of SP3a) | that state |
| `bandlands` | — | the badlands band block at the voxel's y (§3.3) |

A rule that yields no block leaves the voxel as stone. Every node has a stable id: its path in the default tree (`root.rules[2].then.rules[0]`), recorded by the probe.

Conditions (master §3.11's set without the cave-only ones):

| condition | fields | holds when |
|---|---|---|
| `biome` | `biomes: string[]` | the voxel's per-block surface biome is in the set |
| `stoneDepth` | `side: floor \| ceiling, offset, addSurfaceDepth: boolean, secondaryDepthRange` | depth from the run's top (floor) or bottom (ceiling) ≤ offset (+ surfaceDepth if `addSurfaceDepth`) (+ the secondary depth if a range is given) |
| `water` | `offset, mult` | there is no water above the run, or `y ≥ waterTop + offset + mult·depthFromTop` (master's MC-style rule) |
| `yAbove` | `y, mult` | `y ≥ y0 + mult·depthFromTop` |
| `verticalGradient` | `trueAtAndBelow, falseAtAndAbove` | hash dither: true below the first, false above the second, linear probability between |
| `steep` | `min` | the position's `steep` ≥ min |
| `noiseThreshold` | `noise, min, max` | the 2D surface noise at the position is in [min, max] |
| `temperatureBelow` | `t` | `T_eff(y) < t` |
| `skyOpen` | — | the run is the topmost solid run of the position |
| `not` | `if` | the inner condition does not hold |

`caveBiome` is SP6's; `abovePreliminarySurface` is not needed (SP3b's `surfaceEst3`).

**Validation** (`validateRules`), before compilation, with node-path messages: unknown kinds or fields; an unknown block key (must parse with `parseStateKey`); an unknown biome or noise id; `min > max`, `trueAtAndBelow ≥ falseAtAndAbove`; non-finite numbers; a nesting depth above 32 or more than 4096 nodes (SP3b §13's lesson for editable trees, applied here from the start).

### 3.2 The scan (`scan.ts`)

For each of the 256 positions, top-down from y 319, over the solidity and water that density and water v0 produced:
- **runs:** maximal vertical runs of solid voxels; the topmost run is the sky-open run (`skyOpen`);
- per solid voxel: `floorDepth` (0 at its run's top voxel), `ceilDepth` (0 at its run's bottom voxel), `depthFromTop` = floorDepth;
- per run: `waterAbove` (the voxel above the run's top is water) and `waterTop` (the y of the top water voxel of that water body);
- per position: `steep` and `T` (bilinear ColumnSample readouts, as SP3b's `col`), the per-block surface biome (aux A's `surfaceBiome`, the jittered-Voronoi zoom), `surfaceDepth = ⌊3 + 2.75·Ns(x, z) + 0.25·hash01(x, z)⌋` with `Ns` the `surface.noises.depth` noise and `hash01` a seeded per-position hash;
- per voxel: `T_eff(y) = T − lapse·max(0, y − lapseBase)` (master §3.10: lapse 0.006, base 80; schema leaves).

All hashes derive from the seed through `core/seed` as the zoom does; the scan reads nothing outside its column.

### 3.3 Bandlands

`bandlands` returns the band block at y from a 192-entry band table built once per GenContext from the seed (`surface.bands`): runs of 1-4 blocks drawn among `terracotta` and the six coloured terracottas, offset by a 2D noise `surface.noises.bandOffset` (±4 blocks), as master §3.11's badlands bands. It is deterministic and column-local.

### 3.4 Compiler and fast path (`compile.ts`, `reference.ts`)

- **Compile:** validate, then build one closure per node over a scan-context object (preallocated, no per-voxel allocation). Evaluation order is the tree's: `sequence` children in order, `condition` evaluates `if` then `then`.
- **Reference:** a tree walk with the same semantics; DT2's `surfaceReference` part requires compiled == reference (same state) at sampled voxels, and the fuzz (`test/harness/surfaceFuzz.ts`) compares them on random trees.
- **Fast path:** at compile time the compiler derives two bounds from the tree: the deepest `floorDepth` any reachable block rule can need (`maxSurfaceDepth`, from `stoneDepth` offsets plus the maximum `surfaceDepth`), and the y bands any `verticalGradient` or `yAbove` can distinguish. A solid voxel outside both (deeper than `maxSurfaceDepth` below its run's top and outside the dither bands) takes its band's constant result: stone above y 8, deepslate below y 0 — written per section without evaluating rules. A unit test proves the fast path equals full evaluation on every voxel of sampled columns.

### 3.5 Parameters (`surface` group, scope Terrain, stage `terrain`)

| leaf | default | meta |
|---|---|---|
| `surface.noises.depth` | λ 64, 2 octaves | dims 2 (`Ns`) |
| `surface.noises.patch` | λ 24, 2 octaves | dims 2 (coarse dirt, podzol, mud, gravel, clay, calcite, packed-ice patches) |
| `surface.noises.bandOffset` | λ 128, 1 octave | dims 2 |
| `surface.snowline` | −0.6 | `T_eff` threshold for snow (min −1, max 1) |
| `surface.lapse` | 0.006 | per block (min 0, max 0.05) |
| `surface.lapseBase` | 80 | y (min −64, max 319) |
| `surface.cliffSteep` | 1.2 | min 0, max 8 |
| `surface.cliffMinY` | 80 | y (min −64, max 319) |
| `surface.patchThreshold` | 0.55 | |Npatch| above it gives a patch (min 0, max 3) |
| `surface.bands` | seed-derived | not a leaf: the band table is derived from the seed |

The bedrock (−63 … −60) and deepslate (0 … 8) dither ranges are constants of `defaults.ts`. The schema change is accepted with `npm run test:accept-schema`, the reference with `npm run docs:params`; U2 must decide every new leaf live (its `terrain` output stage, SP3b §3.3).

### 3.6 Probe

`surfaceProbe(dc, x, y, z)` returns the voxel's final state and the ids of the rule nodes that chose it (the master §5.5 "surface-rule branch path"). The Voxels-mode hover shows them (§6).

## 4. The default rule tree (`defaults.ts`)

First match wins:

1. **Bedrock:** `yAbove` false at −64 → `bedrock`; `verticalGradient(trueAtAndBelow −64, falseAtAndAbove −59)` → `bedrock` (dither over −63 … −60).
2. **Deepslate:** `verticalGradient(trueAtAndBelow 0, falseAtAndAbove 8)` → `deepslate` (below 0 always; dither over 1 … 7).
3. **Sky-open run, within `surfaceDepth` of its top** (`skyOpen` and `stoneDepth{floor, offset 0, addSurfaceDepth}`):
   1. **Under water** (`not water{offset 0}`): `sand` in warm_ocean, beach, snowy_beach and lake shallows (water depth ≤ 2); `gravel` in deep_ocean, frozen_ocean and water deeper than 10 elsewhere; `dirt` in river and frozen_river; `clay` patches (`noiseThreshold` on `surface.noises.patch`) in rivers, swamps and lakes; otherwise `sand` within 10 of the water top, `gravel` below.
   2. **Cliffs:** `steep{cliffSteep}` and `yAbove{cliffMinY}` → `stone` (`packed_ice` in frozen_peaks).
   3. **Snow:** top voxel (`stoneDepth{floor, offset 0}`) and `temperatureBelow{snowline}` → `snow_block`.
   4. **Biome palette** (top voxel / below it within `surfaceDepth` / a secondary band below sand):

| biomes | top | under | extra |
|---|---|---|---|
| plains, meadow, forest, birch_forest, dark_forest, snowy_plains | grass_block | dirt | — |
| taiga, snowy_taiga | grass_block | dirt | podzol and coarse_dirt patches on top |
| savanna | grass_block | dirt | coarse_dirt patches |
| jungle | grass_block | dirt | podzol patches |
| swamp | grass_block | dirt | mud patches |
| desert, beach, snowy_beach | sand | sand | sandstone for 4 more blocks below |
| badlands | red_sand | `bandlands` | red_sandstone under red_sand where bands are skipped |
| stony_shore, volcano | stone | stone | gravel patches |
| windswept_hills | grass_block | dirt | gravel and stone patches |
| snowy_slopes, jagged_peaks | snow_block | stone | — |
| frozen_peaks | snow_block | stone | packed_ice patches |
| stony_peaks | stone | stone | calcite patches |
| river, frozen_river (above water) | sand | sand | — |
| ocean family (above water: islets) | sand | sand | — |

4. **Runs without sky** (under overhangs): no rule matches, so they stay stone (grass never appears off the sky-open run). SP6 adds cave floors and ceilings here.

## 5. Metrics and tuning

### 5.1 Sampling

As SP3b §8.1 (scattered columns through the 4-worker sampler; fast 4096 / quick 8192 / full 4096 × 4 seeds per profile; both profiles; insufficient-sample minimums that fail, never pass silently).

### 5.2 Definitions (voxels)

| metric | parts | threshold |
|---|---|---|
| S1 | `buried`: top-block types (grass_block, snow_block, sand at the top of a land column, red_sand) with a solid voxel directly above; `grassNoSky`: grass_block not in a sky-open run; `ymod16`: χ² p-value of the land top y mod 16 | 0 / 0 / ≥ 0.001 |
| S2 | `deepslateBelow0`: share of stone-like voxels (stone + deepslate) below y 0 that are deepslate; `deepslateAbove8`: share above y 8 that are deepslate; `bedrockFloor`: share of positions with bedrock at y −64 | ≥ 95 % / ≤ 1 % / 100 % |
| S3 (snowline part) | `snowAboveLine`: share of sky-open land tops with `T_eff < snowline` (not cliffs) that are snow_block; `snowNoSky`: snow_block not in a sky-open run | ≥ 90 % / 0 |
| B4 (voxel parts) | `snowInDesert`: desert land tops that are snow_block; `coastBandBeach`: coast-band land tops (C in −0.22 … −0.04, offset0 ≥ 63) that are sand, red_sand, gravel or stone (beach, stony shore); `landTopsBelowSea`: land-biome tops below y 63 outside river and lake positions | 0 / ≥ 70 % / ≤ 1 % |
| B2 (voxel river check, SP2a minor 6) | `riverChannelWater`: share of river channel positions (wet quart corner and bilinear offset < 63) with a water voxel in their column | threshold set from the dry run's measurement and approved with the spec revision |

- **Ungated diagnostics** (recorded in `test/metrics/.out`): `lakeRimIslets` (land positions inside a lake's mask surrounded by lake water on all four sides), `shorelineFringe` (ocean-family biome on land tops, or land biome under water, within the coast band), per-block shares of every palette block.
- Rows are `activeFrom: 'SP3c'`, each with a lock accept and a Threshold-log line; as SP3b, rows land after the dry run's measurement and any approved retune.

### 5.3 Tuning

The dry run measures S1-S3, B4, B2 and the diagnostics before any retune. If a part fails or the 2D defects show, the knobs are: `surfaceDepth`'s noise, `snowline`, `lapse`/`lapseBase`, `patchThreshold`, `cliffSteep`/`cliffMinY`, and for Decision 2 the lake rim and zoom parameters (`lakes.*`, `biomes.zoomJitter`). The user approves before/after review slices (coast, lake, river, mountain, desert or badlands, snow) and the numbers; a retune of 2D parameters re-runs every 2D metric and re-records the SP2a goldens it moves, all inside `GENERATOR_VERSION` 5.

## 6. UI and tools

- **Voxels mode:** `VOXEL_COLORS` gains one colour per palette block (grass green, earth browns, light sand, sandstone, greys for gravel and deepslate, whites for snow and calcite, pale blue for packed ice, oranges and reds for the terracottas); the legend lists them; the hover readout adds the rule path (rule ids) from `surfaceProbe`. The PNG review slices use the same palette.
- **Review slices** (`npm run docs:review-slices`, `assets/sp3c/`): coast, lake, river, mountain, a desert or badlands site and a snowy site, each re-derived from the voxels by a test as SP3b's.
- **uiSmoke:** checks the legend and a hover readout with a rule path.

## 7. Goldens and bench

- `GENERATOR_VERSION` 5 re-records `sp1.params` (it hashes `genKey`) and `sp3a.region.T.*` (the surface now in T). `sp3b.density.*` must not change (the density is untouched); SP2a goldens change only through an approved 2D retune (§5.3).
- New: `sp3c.registry` (§2.2) and `sp3c.surface.ops` (compiled rule results over a fixture tree using every condition and kind, at a fixed point list of real columns). Count 52 → 54; `?selftest=1` (Chrome, Firefox) and Bun check all keys.
- Bench: a new row `surface.column` (the surface pass of one column, density already done) and `terrain.real` now includes the surface pass; its 4 ms p50 gate stays (SP3b §10). Quiet-machine procedure as SP3a §7.

## 8. Tests (summary)

- **Unit:** each condition (value, edges, validation with node paths); the band table; the scan (runs, depths, sky-open under an overhang, water above, surfaceDepth range); the compiler vs the reference (fuzz on random trees); the fast path vs full evaluation on every voxel; the default tree on real columns (grass over dirt, sand and sandstone in the desert, snow above the snowline, stone cliffs, deepslate and dithered bedrock, no grass off the sky-open run); `surfaceProbe` paths; the 22 states' table values; the lock append.
- **Integration:** the 4-thread harness against the 1-thread one on the T with surface.
- **Metrics:** DT1, DT2 (with `surfaceReference`), S1, S2, S3, B4 voxel parts, the B2 river check, T1-T5 still passing, U2 with the `surface.*` leaves, every tier.
- **Bench, tools:** as §6-§7.

## 9. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with DT1, DT2, S1-S3, B4 voxel parts and the river check active; T1-T5 still pass | `npm run build && npm test && npm run test:metrics:full` |
| CI green | GitHub Actions |
| the 22 states appended; the lock accepted; `sp3c.registry` recorded | lock test, goldens |
| `GENERATOR_VERSION` 5; only the allowed goldens change; `?selftest=1` all keys in Chrome and Firefox; Bun all keys | goldens tests, browsers, Bun tool |
| bench within +30 %, `terrain.real` p50 ≤ 4 ms | `npm run bench` |
| visual review approved by the user, incl. the 2D-defect decision | `assets/sp3c/` slices and a Voxels-mode screenshot |

**Cut line:** if SP3c runs short, the `bandlands` rule (and its noise and band table) moves to SP10; badlands then uses `terracotta` as its under block. The terracotta states are still registered, so the lock does not change.

## 10. Governance

- The first commit appends `'SP3c'` to `STARTED_SPS`, sets `CURRENT_SP = 'SP3c'`, accepts the thresholds lock and appends to the Threshold log.
- The state-id lock grows by 22 entries through `npm run test:accept-state-ids` (append-only; the commit message says so).
- New threshold rows (§5.2), `activeFrom: 'SP3c'`.

## 11. Notes handed to later SPs

- **SP3d:** `surface.rules` as an editable JSON leaf with the inspector; `validateRules` already bounds depth and node count.
- **SP6:** `caveBiome`, cave floor and ceiling rules for runs without sky, the cave palettes.
- **Decorate (D):** ice on sky-exposed water with `T_eff < −0.45`, snow layers on sky-exposed ground, S3's ice parts.
- **SP8a:** textures and the per-biome grass tint for `grass_block`.
- **SP10:** the 2D defects if Decision 2 hands them over.

## 12. Master-spec amendments made with this spec

- **§10 SP3c:** deliverable — biome surfaces on the voxel terrain (the 22-block palette, surface rules, dithered bedrock and deepslate, snowline, cliffs, badlands bands), in the slices and the Voxels mode; exit as §9 here; cut line: `bandlands` → SP10.
- **§2.2:** the terrain palette's 22 types and their table values (§2.1 here); `deepslate` without `axis`.
- **§3.11:** the SP3c condition set and rule kinds (§3.1), the scan's quantities (§3.2), the fast path (§3.4), the parameters (§3.5), the default tree (§4); `abovePreliminarySurface` dropped; ice and snow layers stay in D.
- **§6.4:** S1's `grassNoSky` replaces "grass at sky 0" until light exists (SP4); B2's voxel river check (§5.2); the voxel B4 parts' definitions.

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

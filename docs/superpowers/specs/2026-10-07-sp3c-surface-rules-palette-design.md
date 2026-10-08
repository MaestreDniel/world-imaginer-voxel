# SP3c — Surface rules and terrain palette (Design)

Date: 2026-10-07
Status: Approved by the user (2026-10-07): the design section by section, then the written spec after the adversarial review (§13) and Decision 6 (rule order); the dry run's measurement decided by the user on 2026-10-08 (B2 `riverChannelWater` ≥ 85 %, Decision 2's defects handed to SP10, no retune, `surface.depthMul` unchanged); revised by the implementation-plan dry run (§14). Implemented; exit evidence below (the user's visual review, Firefox and CI after the merge)
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3c (created by SP3b), whose deliverable, exit and cut line this spec sets;
- §2.2 (block registry: the palette appends), §3.10 (biomes), §3.11 (surface rules), §3.16 (cross-column consistency), §3.17 (determinism);
- §5.1 (parameters and stage hashes), §5.5 (probe: the surface-rule branch path);
- the testing sections §6.1-6.5 (DT1, DT2, S1, S2, S3, B4, B2, T1-T5, U2, P1) and §7.
Previous SP: `2026-10-07-sp3b-density-terrain-design.md` (its §13 lists what SP3b handed over).

References written "master §x" point to the master spec, "SP3a §x", "SP3b §x" (and SP2a, SP2b) to those specs, and a bare "§x" to this document.

## Goal

Give the voxel terrain its skin. A data-driven surface-rule tree, compiled to closures and checked against a reference evaluator, runs a whole-column scan inside the T stage and turns SP3b's stone into the blocks of each biome: grass and dirt, sand and sandstone, gravel, clay and mud under water, snow above the snowline, stone cliffs, deepslate under the surface skin, dithered bedrock and the badlands' terracotta bands. Twenty-two terrain block types join the frozen registry. The result is measured on voxels (S1, S2, S3, B4, a river-water check), reviewed by the user in slices and the Voxels mode, and proven deterministic and exact (DT1, DT2).

## Non-goals

- Ice on water and snow layers: they run in the decorate stage (D, master §3.11 rule 5), with their own states.
- Cave floors and ceilings, `caveBiome` and the cave palettes (moss, dripstone, abyss): SP6.
- The JSON editor for the rules (`surface.rules` as an editable leaf) and the inspector: SP3d. In SP3c the rule tree is code; its tunables are schema leaves.
- Textures and the per-biome grass tint (`FACE_TEX`, tint colormaps): SP8a. The Voxels mode shows one flat colour per block.
- Changing the density, the 2D map, the biome picker or the world's height limits and sea level (fixed constants, see Decision 5).

## Decisions (confirmed by the user, 2026-10-07)

1. **Palette:** the master's full terrain palette, 22 types (§2), all without properties.
2. **2D defects inherited from SP2a** (lake-rim islets, the shoreline zoom fringe): measured in the dry run with voxel diagnostics; fixed in SP3c with the user's approval if they show, otherwise handed to SP10 (decided on 2026-10-08 from the dry run's measurement: handed to SP10, §11, §14).
3. **Approach A:** the master's data condition tree compiled to closures, with a whole-column scan (§3), rule ids for the probe, tunables as schema leaves.
4. **Tuning:** as SP3b — measure first; any retune (surface depth, snowline, lapse, patch thresholds, the lake and zoom parameters for Decision 2) is shown to the user as before/after slices and lands inside the same `GENERATOR_VERSION` 5.
5. **Fixed world constants:** the height limits (y −64 … 319) and sea level (63) are not SP3c knobs: they shape the store layout, the aux heightmaps, the region hash and every golden.
6. **Rule order** (confirmed by the user on 2026-10-07, after the spec review): the sky-open surface skin goes before deepslate, as in Minecraft. The default tree (§4) is, in order: [0] bedrock (y −64 and the −63 … −60 dither); [1] the sky-open surface branch (under water, cliffs, snow, biome palette, sandstone bands); [2] the deepslate gradient (y ≤ 0, dithered over 1 … 7), the rule for every solid voxel still left; then nothing (stone). Any sky-open skin voxel at y ≤ 7, where the deepslate gradient can hold (under a top as high as y 7 + maxSurfaceDepth, and below y 0 under a deep ocean floor), keeps its surface block (gravel, sand, dirt, clay, …), and deepslate replaces only the stone below the surface skin and the stone of runs without sky (a top at y 8 or higher, and every skin voxel at y ≥ 8, is the same under both orders). This amends master §3.11's order, where deepslate was rule 2 (§12).

## Module layout after SP3c

```
src/world/blocks/defs.ts         + 22 terrain types (§2), appended after bedrock
src/gen/surface/
  rules.ts         the rule and condition types (JSON-shaped data), validateRules with node paths, rule ids
  conditions.ts    per-condition semantics shared by compile and reference (one helper per condition)
  compile.ts       rules → closures over the scan context; the fast-path analysis (§3.4)
  reference.ts     a tree-walking evaluator (same order, same results) that records the rule path
  scan.ts          the whole-column scan: runs, depths, sky, water, steep, T_eff, biome, lake, surfaceDepth
  bands.ts         the badlands band table (§3.3)
  pass.ts          surfacePass: scan + compiled rules + fast path over one column (§1, the bench row)
  context.ts       SurfaceContext: DensityContext, compiled rules, reference tree, band table; memoised per GenContext
  defaults.ts      the default rule tree built from params.surface (§4)
  probe.ts         surfaceProbe(sc, x, y, z) → { state, path } (§3.6)
src/gen/pipeline/terrainStage.ts   + the per-block biome buffer and the surface pass after density and water (§1);
                                   `columnWaterV0` (water v0, shared with the probe) and the test hook `terrainSurfaceDebug` (§5.2)
src/gen/column/columnStage.ts      + `nearestCornerIndex` (the nearest quart corner, shared by water v0, `lake` and the metrics)
src/core/params/schema.ts          + the `surface` group (§3.5)
src/metrics/liveness.ts            + five SP3c class columns for the terrain stage, found in a third pass (§3.5)
src/workers/protocol.ts, taskHandler.ts, src/engine/workerPool.ts
                                   + the `surfaceProbe` job (§6)
src/ui/crossSection/voxels.ts, section.ts
                                   + colours, legend entries and the hover rule id (§6)
src/metrics/sp3cGoldens.ts         sp3c.* goldens (added to DET_FILES in test/arch/rules/banned.ts)
test/harness/surfaceFuzz.ts        random rule trees for the compile / reference / fast-path fuzz
test/harness/metric.ts             + `MetricEnv.outName` (§5.2)
test/harness/stats.ts              + the χ² p-value and `S1.ymod16`'s class-merging test (§5.2)
test/harness/reviewSlices.ts       + the `desertTop`, `snowTop` and `badlandsTop` needs and the SP3c sites (§6)
test/fixtures/sp3c-default-rules.json   the default tree of §4 as data
test/metrics/surface.metric.ts     S1, S2, S3, the B4 and B2 voxel parts, the diagnostics
test/harness/surfaceScatter.ts     its per-column analysis and count record, merged by sum on the main thread
test/harness/surfaceScatterWorker.ts   its region worker: generates, analyses and frees each scattered column
test/metrics/region.metric.ts      + DT2's surface parts (§5.2)
test/tools/uiSmoke.ts              + the rule-id readout check
test/bench/gates.ts, noise.bench.ts   + `surface.column`; the `BENCH_EXEMPT` row list (§7)
test/stateIds.lock.json            + 22 entries
```

## 1. The T stage after SP3c

T runs, per column:
1. the ColumnSample;
2. SP3b's density phase (solidity);
3. SP3b's water v0 (`top` and the water level per position), written into a per-voxel column water scratch (`columnWaterV0`) that the scan reads and from which the stage derives the fluid channel (the same v0 rule, evaluated once);
4. the per-block surface biome (`readBiome`, the jittered-Voronoi zoom), computed once into a 256-entry buffer that both the surface pass and aux A's `surfaceBiome` read;
5. **the surface pass** (§3, `surfacePass` in `pass.ts`): it writes the final state of every solid voxel at y −63 … 319 into a column-wide state scratch (stone becomes its final block); air and water are not touched;
6. as in SP3b §4: the 24 sections (y −64 is bedrock as before; `stop()` before each; a true stop returns false with no aux written), aux A (reusing the step 4 buffer), aux B.

The surface pass reads only the column's own data (its solidity and water, its ColumnSample, the seed): a column's output still depends only on the seed, the params and (cx, cz) (master §3.16). It never changes solidity, so the heightmaps and water v0 are unchanged. `stop()` is also polled once before the surface pass, after water v0 and the biome buffer (the 7th of the column's 31 polls: 6 in the density phase, this one, then 24 before the sections), and SP3b's other polls stay. The `terrain` stage goes to version 3 with `params: ['density', 'surface']`; `GENERATOR_VERSION` goes to 5. The stage's DensityContext memo becomes the SurfaceContext memo (`context.ts`), which holds it.

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
| 11 | `red_sandstone` | stone | none | under the badlands bands |
| 12 | `gravel` | gravel | none | |
| 13 | `clay` | dirt | none | underwater patches |
| 14 | `calcite` | stone | none | stony-peaks patches |
| 15 | `snow_block` | snow | none | snowline and snowy peaks |
| 16 | `packed_ice` | glass | none | frozen-peaks cliffs and patches |
| 17 | `deepslate` | stone | none | y ≤ 0, dithered over 1 … 7, for every solid voxel that branch [1] (§4) yields no block for: below the skin and in runs without sky (a stone skin stays stone; Decision 6; no `axis`: Decision recorded in §2.2) |
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
| `bandlands` | — | the badlands band block at the voxel's (x, y, z) (§3.3) |

**JSON encoding.** Every rule and every condition is one JSON object whose discriminator is the property `kind` (the kind names of the two tables); its other properties are exactly the fields listed for that kind, all present (`defaults.ts` and the fixture write every field, including `runTop: false`), and nothing else. A condition is nested as the value of `if` (in `condition` and in `not`); there is no single-key wrapper. One literal per kind:
- `{"kind":"sequence","rules":[R1,R2]}`, `{"kind":"condition","if":C,"then":R}`, `{"kind":"block","state":"grass_block"}`, `{"kind":"bandlands"}`;
- `{"kind":"biome","biomes":["desert","beach"]}` (in the order written), `{"kind":"stoneDepth","side":"floor","offset":0,"addSurfaceDepth":true}`, `{"kind":"water","offset":-10,"runTop":true}`, `{"kind":"yAbove","minY":80,"runTop":true}`, `{"kind":"verticalGradient","trueAtAndBelow":0,"falseAtAndAbove":8}`, `{"kind":"steep","min":1.2}`, `{"kind":"noiseThreshold","noise":"surface.noises.patch","min":0.55,"max":8}`, `{"kind":"temperatureBelow","t":-0.6}`, `{"kind":"skyOpen"}`, `{"kind":"lake"}`, `{"kind":"not","if":C}`.

Numbers are JSON numbers; −0 is never written (`canonicalJSON` throws on it): `validateRules` rejects a −0 with its node path, and `defaults.ts` writes a negated parameter as `0 - t`, which is +0 when t is 0.

A rule that yields no block leaves the voxel as stone. **Rule ids:** every rule node's id is its path in the tree being evaluated: the root is `root`, child k of a sequence `<id>.rules[k]`, the `then` of a condition `<id>.then` (conditions have no ids of their own). A leaf's id therefore names the whole branch. The probe records them (§3.6).

Conditions (master §3.11's set without the cave-only ones, plus `lake`). In the table, y is the voxel's height, yTop its run's top voxel, x and z integer world coordinates:

| condition | fields | holds when |
|---|---|---|
| `biome` | `biomes: string[]` | the position's per-block surface biome (§1 step 4) is in the set |
| `stoneDepth` | `side: floor \| ceiling, offset: int, addSurfaceDepth: boolean` | `floorDepth` (floor) or `ceilDepth` (ceiling) ≤ offset (+ surfaceDepth if `addSurfaceDepth`) |
| `water` | `offset: int, runTop: boolean` | the run has no water directly above its top (`waterAbove` false), or `(runTop ? yTop : y) ≥ waterTop + offset` |
| `yAbove` | `minY: int, runTop: boolean` | `(runTop ? yTop : y) ≥ minY` |
| `verticalGradient` | `trueAtAndBelow: int, falseAtAndAbove: int` | hash dither: holds at y ≤ trueAtAndBelow, never at y ≥ falseAtAndAbove, with a probability that falls linearly in between (§3.2) |
| `steep` | `min` | the position's `steep` ≥ min |
| `noiseThreshold` | `noise, min, max` | min ≤ z ≤ max, where z is the named noise's z2 at (x, z) (remap 'none': unit sd, clamped to ±clampSigma ≤ 8) |
| `temperatureBelow` | `t` | `T_eff(y) < t` |
| `skyOpen` | — | the run is the topmost solid run of the position |
| `lake` | — | the position's nearest quart corner (`readLevel`'s rounding, the corner water v0 reads its level from) has a finite `lakeLevel` (equivalently lakeMask = 1 at that corner) |
| `not` | `if` | the inner condition does not hold |

- `water` and `yAbove` are not MC's exact rules: MC's `waterHeight` is `waterTop + 1`, its `addStoneDepth` is our `runTop`, and our rules have no surfaceDepth multiplier. `runTop: true` makes the whole run decide alike (it reads yTop); `runTop: false` tests the voxel's own y. Both fields default to false.
- There is no `or` and no `and`: an `and` is two nested conditions; |z| ≥ t is two sibling branches.
- `caveBiome` is SP6's; `abovePreliminarySurface` is not needed (SP3b's `surfaceEst3`). **`secondaryDepthRange`** (master §3.11) is deferred to the SP whose default rules first need it, together with its own noise leaf (that SP's default tree reads it, so U2 stays satisfied); until then `validateRules` rejects it as an unknown field.

**Validation** (`validateRules`), before compilation, with node-path messages: unknown kinds or fields; an unknown block key (must parse with `parseStateKey`); an unknown biome; a `noiseThreshold.noise` that is not a dims-2 `surface.noises.*` leaf of the schema; `offset`, `minY`, `trueAtAndBelow`, `falseAtAndAbove` not integers in [−384, 384]; `runTop` or `addSurfaceDepth` not booleans; `min > max`, `trueAtAndBelow ≥ falseAtAndAbove`; non-finite numbers; `bandlands` when the band leaf is absent (§9 cut line), i.e. when the noise lookup `validateRules` is given has no `surface.noises.bandOffset` (code `NO_BAND_NOISE` at the `bandlands` node's path; a present one that is not dims-2 or not remap-'none' is `NOISE_DIMS` / `NOISE_REMAP` there, as for `noiseThreshold`); a nesting depth above 32 or more than 4096 nodes (SP3b §13's lesson for editable trees, applied here from the start).

### 3.2 The scan (`scan.ts`)

For each of the 256 positions, top-down from y 319 to y −63, over the solidity and water that density and water v0 produced (y −64 is the stage's bedrock and is not scanned):
- **runs:** maximal vertical runs of solid voxels; the topmost run is the sky-open run (`skyOpen`);
- per solid voxel: `floorDepth` (0 at its run's top voxel), `ceilDepth` (0 at its run's bottom voxel);
- per run: yTop, `waterAbove` (the voxel above the run's top holds water) and `waterTop` (the y of the highest voxel of the contiguous water directly above the run's top);
- per position:
  - `steep` and `T`: bilinear ColumnSample readouts (`readField`, as SP3b's `col`), not `columnPoint`;
  - the per-block surface biome (the §1 step 4 buffer, the value aux A stores);
  - `lake` (§3.1);
  - `surfaceDepth = max(0, ⌊3 + 2.75·depthMul·Ns + 0.25·hash01⌋)`, with `Ns` the z2 of `surface.noises.depth` at (x, z) and `depthMul` the leaf `surface.depthMul`. surfaceDepth is never negative, so the top voxel of every sky-open run passes the `SKIN` gates of §4's branch [1] and surfaceDepth only sets how many under blocks follow it (MC's ON_FLOOR / UNDER_FLOOR split). At 0 a position has its top block only. Its range is [0, SD_MAX] with `SD_MAX = ⌊3.25 + 2.75·depthMul·c⌋`, c the depth noise's `clampSigma` (3 at the defaults, so SD_MAX = ⌊3.25 + 8.25⌋ = 11);
- per voxel: `T_eff(y) = T − lapse·max(0, y − lapseBase)` (master §3.10: lapse 0.006, base 80; schema leaves).

**Noises and hashes.** Surface noises are sampled at unscaled world block coordinates (x, z), like SP3b's density noises (`climate.scaleMul` does not apply); their values are z2 (remap 'none'). Every seed derives from the world seed through `deriveSeed` and `hash2` / `hash3` of `core/hash`, as the zoom's `biomes.zoom` seed does (`gen/context.ts`):
- `hash01(x, z) = hash2(deriveSeed(seed, 'surface.depthHash'), x, z) · 2^−32` ∈ [0, 1);
- `verticalGradient` at (x, y, z): true when y ≤ trueAtAndBelow; false when y ≥ falseAtAndAbove; otherwise true when `u < (falseAtAndAbove − y) / (falseAtAndAbove − trueAtAndBelow)`, with `u = hash3(deriveSeed(seed, 'surface.gradient.' + trueAtAndBelow + '.' + falseAtAndAbove), x, y, z) · 2^−32`. The seed is derived once at compile time; salting it with the bounds keeps a dither stable when a node moves in the tree (SP3d) and needs no extra field. The compiled closures and the reference evaluator call the same helpers (`conditions.ts`).

The scan reads nothing outside its column.

### 3.3 Bandlands (`bands.ts`)

`bandlands` returns the band block at (x, y, z) from a 192-entry band table built once per SurfaceContext (§3.6; so once per GenContext through `surfaceContextOf`):
- **Table:** `r = Xoshiro128(deriveSeed(seed, 'surface.bands'))`; i = 0; while i < 192, one run draws, in this order, first `len = 1 + r.nextInt(4)`, then `colour = r.nextInt(7)`, an index into [`terracotta`, `white_terracotta`, `orange_terracotta`, `yellow_terracotta`, `brown_terracotta`, `red_terracotta`, `light_gray_terracotta`] (repeats allowed); it writes that colour to the entries [i, min(192, i + len)) and sets i += len. No other draw is made from `r`.
- **Lookup:** `table[((y + o) mod 192 + 192) mod 192]` with `o = Math.round(4 · z / clampSigma)` ∈ [−4, 4], z the z2 of `surface.noises.bandOffset` at (x, z) and clampSigma that leaf's.

It is deterministic and column-local (master §3.11's badlands bands).

### 3.4 Compiler and fast path (`compile.ts`, `reference.ts`)

- **Compile:** validate, then build one closure per node over a scan-context object (preallocated, no per-voxel allocation). Evaluation order is the tree's: `sequence` children in order, `condition` evaluates `if` then `then`. A compiled tree is bound to the scan settings it is compiled with (SD_MAX for the fast path, `lapse` and `lapseBase` for T_eff), and every scan it evaluates is made with the same settings.
- **Reference:** a tree walk with the same semantics that also records the rule path.
- **The band table:** `compileSurfaceRules(seed, rules, noises, settings, bands?)` and `createSurfaceReference(seed, rules, noises, bands?)` take the SurfaceContext's band table (§3.6), so both evaluators share one; when it is absent they build it from the seed (only if the tree has a `bandlands` leaf). DT2's `surfaceReference` part requires compiled == reference (§5.2), and the fuzz (`test/harness/surfaceFuzz.ts`) compares them on random trees.
- **Fast path** (compile time, general and conservative). The compiler sorts every `block` and `bandlands` leaf by the conditions on its path from the root (the `if`s of its condition ancestors; sequences are ignored):
  1. *Depth-bounded:* the path holds a `stoneDepth{side floor}` that is not under a `not`. Its bound is the smallest, over those gates, of `offset + (addSurfaceDepth ? SD_MAX : 0)` (§3.2, read from the live params).
  2. *Y-only:* every condition on the path is a `verticalGradient`, a `yAbove{runTop false}`, or a `not` of these.

  If any leaf is neither, the tree has no fast path and every solid voxel is fully evaluated. Otherwise `maxSurfaceDepth` is the largest bound of the depth-bounded leaves (−1 when there is none, or every bound is negative: every voxel of a constant band then takes the band, since floorDepth ≥ 0). The tree is *sky-gated* when the path of every depth-bounded leaf also holds a `skyOpen` (a path `if` that is `skyOpen` itself, not inside a `not`; a tree without depth-bounded leaves is sky-gated). The gates are read from the path `if`s themselves: `not{not{stoneDepth floor}}` is no depth gate and `not{not{skyOpen}}` no sky gate (conservative). The y range −63 … 319 is cut only by the conditions on the paths of the Y-only leaves (the conditions of depth-bounded leaves, `yAbove{runTop true}` included, never cut it, since a band's result is computed with those leaves removed): at the `minY` of every such `yAbove{runTop false}` and at every such gradient's dither interval [trueAtAndBelow + 1, falseAtAndAbove − 1]; the dither intervals are always evaluated, and each remaining interval is a constant band. A band's result is the tree evaluated at compile time with every depth-bounded leaf removed (stone when nothing matches): the first Y-only leaf, in evaluation order, whose conditions all hold at the band's lowest y. A band whose result would be a Y-only `bandlands` leaf has no constant block (it varies with x, y, z): it is always evaluated, like a dither interval, and does not turn the fast path off. Adjacent constant bands with the same result are not merged, and cuts and dither intervals outside −63 … 319 are clipped. A solid voxel in a constant band takes its band's result without evaluating rules when floorDepth > maxSurfaceDepth or, in a sky-gated tree, when its run is not sky-open (every depth-bounded leaf then fails whatever the depth, so the band's result is the same); whole sections that qualify are written uniform (the store's `setProto` already stores a channel uniform when its 4,096 values are equal, so no explicit shortcut is needed at the measured cost, §14). Non-solid voxels are never written by the fast path. The analysis does not depend on where the Y-only leaves sit in the tree: depth-bounded leaves placed before them (Decision 6's order) are excluded by the same depth or sky test.

  For the default tree (§4, Decision 6's order): every leaf of the sky-open branch [1] is depth-bounded (its path holds SKIN, TOP or BAND4) and sky-gated; bedrock [0] and deepslate [2] are Y-only. maxSurfaceDepth = SD_MAX + 4 (15 at the defaults, from BAND4); only the two gradients cut the y range (the cliff leaves' `yAbove{minY $cliffMinY, runTop true}` is on depth-bounded paths and does not), so the bands are exactly y −59 … 0 (deepslate) and y 8 … 319 (stone); y −63 … −60 and 1 … 7 are always evaluated. maxSurfaceDepth is 15 / 7 / 23 at `depthMul` 1 / 0 / 2 (SD_MAX 11 / 3 / 19). The default tree's `bandlands` leaf is depth-bounded (under SKIN), so it changes none of this. The deepslate fast path therefore applies only to solid voxels at y −59 … 0 (outside the dither band) that lie more than maxSurfaceDepth below their run's top or belong to a run without sky. The top maxSurfaceDepth + 1 voxels of every sky-open run are evaluated at any y, so a sky-open skin voxel at y ≤ 7 (under any top up to y 22, and below y 0 under the deepest ocean floors, §5.2's S2 note) gets its surface block, and the voxels of that run that branch [1] leaves (below surfaceDepth + 4, or below the skin where no band block applies) fall through to the deepslate rule [2].
- **Tests:** the fast path equals full evaluation on every voxel of sampled real columns (default tree) and of the fuzz's random trees and columns, including trees for which the analysis must turn the fast path off, sky-gated and non-sky-gated trees, Y-only leaves before and after the depth-bounded ones, and runs without sky whose voxels lie within maxSurfaceDepth of their run's top.

### 3.5 Parameters (`surface` group, scope Terrain, stage `terrain`)

| leaf | default | meta |
|---|---|---|
| `surface.noises.depth` | λ 64, 2 octaves | dims 2, wavelength 8 … 1024, `remapNone` (`Ns`) |
| `surface.noises.patch` | λ 24, 2 octaves | dims 2, wavelength 4 … 512, `remapNone` (every patch, §4) |
| `surface.noises.bandOffset` | λ 128, 1 octave | dims 2, wavelength 16 … 2048, `remapNone` (absent if the §9 cut is taken) |
| `surface.depthMul` | 1 | multiplies Ns in surfaceDepth (min 0, max 2, step 0.05) |
| `surface.snowline` | −0.6 | `T_eff` threshold for snow (min −1, max 1, step 0.01) |
| `surface.lapse` | 0.006 | per block (min 0, max 0.05, step 0.0005) |
| `surface.lapseBase` | 80 | y, int (min −64, max 319) |
| `surface.cliffSteep` | 1.2 | min 0, max 8, step 0.05 |
| `surface.cliffMinY` | 80 | y, int (min −64, max 319) |
| `surface.patchThreshold` | 0.55 | t: a single-block patch where Npatch ≥ t; a two-block patch, the first block where Npatch ≥ t and the second where Npatch ≤ −t (min 0, max 3, step 0.01). At 0.55 each patch block covers ≈ 29 % of its biome's tops |

- The band table is not a leaf: it is derived from the seed (§3.3). The bedrock (−64, −59) and deepslate (0, 8) gradient bounds are constants of `defaults.ts`; their dithered y are −63 … −60 and 1 … 7. The bedrock gradient is rule [0], before everything; the deepslate gradient is rule [2], after the sky-open branch (Decision 6).
- `remapNone` keeps every surface noise unit-sd, so surfaceDepth, the patch ranges and the band offset keep their meaning (a 'uniform' remap is refused, as for the density noises).
- The schema change is accepted with `npm run test:accept-schema`, the reference with `npm run docs:params`.
- **U2.** Every `surface.*` leaf must be decided live on the `terrain` output stage (SP3b §3.3: the region hash of one column after `fillColumnT`). The two land and two coast class columns cannot decide `cliffMinY` and `surface.noises.bandOffset` (at seed 42 none holds badlands or a steep top within cliffMinY ± 15 %); measured on the surfaced T they decide the other eight leaves (`snowline`, `lapse`, `lapseBase` and the patch leaves on land #1, `cliffSteep` on land #2), but only by accident of those columns. So `livenessColumns` gains five SP3c class slots, which make each leaf decided on its intended class: `cliffY`, `cliffSteep`, `snowline`, `patch`, `badlands`, in this order. `badlands` is last so that the late bandlands task (§9), which adds it, leaves the other four pins unchanged: a column it takes is one every earlier open slot rejected.
  - **Before the class columns.** The `surface.*` leaves enter the schema before the surface pass reads them, and until the class columns exist every one of them is dead on U2's columns. Until the U2 class-column task, `u2Leaves` therefore skips the `surface.*` group (`U2_DEFERRED_PREFIXES = ['surface.']`, pinned by `liveness.test.ts`); that task removes the deferral and its pin, and every `surface.*` leaf is decided from then on (the bandlands task adds `bandOffset` together with its slot, so no deferral is needed again).
  - **A third pass.** They are filled by a third pass over the same `sp2b.liveness` stream, after SP2b's two passes (`scan(1)` over every existing slot, `scan(2)` over the gate slots) and skipping every column those passes used. The 16 existing columns, and every climate, shape, biome2d and `density.*` verdict decided on them, are therefore unchanged; `liveness.test.ts` asserts that the first 16 columns equal SP3b's. In the third pass each stream column is offered to the open SP3c slots in the order above; the first slot whose two tests below hold takes it (a column fills one slot).
  - **Corner prefilter** (cheap, on the column's ColumnSample at its 25 quart corners i, j ∈ 0 … 4, no T run). A corner is *dry* when its `surfaceWaterLevel` is −∞; `T_top = T − lapse·max(0, surfaceEst − lapseBase)`:
    - `cliffY`: a dry corner with steep ≥ 0.85·cliffSteep and surfaceEst in [0.85·cliffMinY − 8, 1.15·cliffMinY + 8];
    - `cliffSteep`: a dry corner with steep ≥ 0.85·cliffSteep and surfaceEst ≥ cliffMinY − 8;
    - `snowline`: a dry corner with steep < cliffSteep, surfaceEst ≥ lapseBase and |T_top − snowline| ≤ 0.1;
    - `patch`: a dry corner with steep < cliffSteep, T_top ≥ snowline and a 2D biome with top patches (taiga, snowy_taiga, savanna, jungle, swamp, windswept_hills, stony_shore, volcano, stony_peaks, frozen_peaks);
    - `badlands`: a dry corner whose 2D biome is badlands.
  - **Acceptance check** (on the generated column; the prefilter alone does not guarantee that a leaf can act: at seed 42, (23279, 27598), SP2b's first coast column, meets the `cliffY` prefilter but its land tops lie at y 63-64 only; the third pass never offers it, since it is used, and the acceptance check would reject it). A prefiltered column is generated once at the default params (the T stage's density fill, water v0 and biome buffer, as `surfaceProbeColumn` rebuilds them, pinned equal to `fillColumnT`'s blocks and fluid) and scanned (§3.2). The slot accepts it when, for **every** leaf the slot serves (below), some solid voxel of the column within `maxSurfaceDepth` (the larger of the default's and the variant's) of the top of a sky-open run gets, from the reference evaluator (§3.4), a different state under one of the leaf's U2 perturbations (`perturbations`, the other leaves at their defaults) than at the defaults. No `surface.*` leaf changes solidity or water, so the variants re-run only the scan and the rules on the default fill. A slot makes at most 64 acceptance checks; after the 64th failure it stays empty.
  - **Leaves per class**, each tried on its intended class first, then on land, coast and the other SP3c columns, with no further witness search: `surface.noises.bandOffset` → badlands; `cliffMinY` → cliffY; `cliffSteep` → cliffSteep; `snowline`, `lapse`, `lapseBase` → snowline; `noises.patch`, `patchThreshold` → patch; `noises.depth`, `depthMul` → land. The acceptance check makes each SP3c leaf decided on its own class column; an empty slot leaves its class missing and its leaves fail U2 (never a silent pass).
  - **Count:** 21 class columns (16 + 5; 20 if the §9 cut is taken).
  - **Pins.** Pre-measured at seed 42 (default profile) with the scan's readouts on SP3b's T, with the cliff and snow tests of §4 standing in for the rule evaluation (the surface pass did not exist yet): `cliffY` (17107, 13836), stream index 53; `cliffSteep` (−24200, −4864), index 61; `snowline` (−25681, 32120), index 255, its 9th acceptance check; `patch` (−20548, −22882), index 11 (256 patch-eligible tops); `badlands` (−26426, −31088), index 35 (256 badlands tops). Without the `badlands` slot the other four columns are the same. Every slot except `snowline` accepted its first prefiltered column. The implementation re-measures them with the real acceptance check (the dry run did, on the surfaced T: the same five columns and stream indices, §14). `liveness.test.ts` re-derives the five columns, pins them (cx, cz) and asserts that every `surface.*` leaf is decided and names its deciding column. A 2D retune that moves them updates the pins with the user's approval. The found columns are recorded in the exit evidence. Decision 6's order does not move them: a column's witnesses can only grow under it (at y ≥ 8 the deepslate and bedrock gradients never hold, so both orders give every voxel the same state; at y ≤ 7 a voxel the old order did not make deepslate went through the same sky-open branch), so every slot still accepts the column it accepted. Only `snowline` rejected columns (eight), and its leaves act only through the snow branch [1][2], which no skin under water reaches ([1][0] comes first) and which tests only the top voxel, while every measured dry top lies at y ≥ 36 (§5.2's S2 note); its rejected columns stay rejected. The implementation's re-measurement confirms it.

### 3.6 Probe (`probe.ts`, `context.ts`)

- **SurfaceContext.** `surfaceContextOf(ctx)` returns the SurfaceContext of a GenContext (memoised in a WeakMap, as SP3b's DensityContext): its DensityContext, the compiled default rules, the reference tree, the band table (passed to both evaluators, §3.4) and a one-column cache of the last column the probe rebuilt. `createSurfaceContext(ctx)` builds one apart (DT2 uses it, so a shared-state bug cannot hide).
- **`surfaceProbe(sc, x, y, z) → { state, path: string[] }`** returns the voxel's final state and the master §5.5 "surface-rule branch path". It rebuilds column (⌊x/16⌋, ⌊z/16⌋) the way T does (ColumnSample, the density fill, water v0, the biome buffer and the §3.2 scan), reusing its column cache when the column is the last one, then walks the reference evaluator at (x, y, z) and never takes the fast path, so a fast-path voxel such as deepslate at y −30 still reports its rule (the path ends `root.rules[2].then`). `path` lists the rule ids from `root` to the `block` or `bandlands` leaf that yielded the state. It is `[]` for air and water (state air: water is the fluid channel over an air block), for a solid voxel that no rule matches (state stone), and at y −64 (state bedrock, the stage's). Integer coordinates inside the world window, y in −64 … 319; otherwise a RangeError.
- The Voxels-mode hover shows the leaf's id (§6).

## 4. The default rule tree (`defaults.ts`)

The tree as data. `defaults.ts` must build exactly this tree from `params.surface`; a unit test compares `canonicalJSON(defaultRules(params.surface))` with `test/fixtures/sp3c-default-rules.json`, which is this listing at the default params in §3.1's JSON encoding. Notation (each maps to one §3.1 literal):
- `seq[…]` is a `sequence` whose children are numbered `[k]`; `if A → R` is `{"kind":"condition","if":A,"then":R}`; `if A ∧ B → R` abbreviates `if A → if B → R`, i.e. `{"kind":"condition","if":A,"then":{"kind":"condition","if":B,"then":R}}` (ids follow the expansion; `if A ∧ B ∧ C → R` nests three deep, A outermost); a bare block name is `{"kind":"block","state":"<name>"}`; `bandlands` is `{"kind":"bandlands"}`.
- A condition written `kind{field value, …}` is the object with that `kind` and those fields; `biome{a, b}` is `{"kind":"biome","biomes":["a","b"]}` in the order written; `skyOpen` and `lake` are `{"kind":"skyOpen"}` and `{"kind":"lake"}`; `not{A}` is `{"kind":"not","if":A}`.
- `$name` is the leaf `surface.name`.
- `TOP = stoneDepth{side floor, offset 0, addSurfaceDepth false}`, `SKIN = stoneDepth{side floor, offset 0, addSurfaceDepth true}`, `BAND4 = stoneDepth{side floor, offset 4, addSurfaceDepth true}`.
- `P = noiseThreshold{noise 'surface.noises.patch', min $patchThreshold, max 8}`, `Pn = noiseThreshold{noise 'surface.noises.patch', min −8, max 0 − $patchThreshold}` (written as `0 - t`, never −0, §3.1).

```
root: seq[
 [0] if verticalGradient{trueAtAndBelow −64, falseAtAndAbove −59} → bedrock          # dither over −63 … −60
 [1] if skyOpen → seq[                                                                  # the surface skin, before deepslate (Decision 6)
   [0] if not{water{offset 0, runTop false}} ∧ SKIN → seq[                             # under water
     [0] if biome{warm_ocean, beach, snowy_beach} → sand
     [1] if biome{deep_ocean, frozen_ocean} → gravel
     [2] if biome{river, frozen_river, swamp} ∧ P → clay
     [3] if lake ∧ P → clay
     [4] if biome{river, frozen_river} → dirt
     [5] if lake ∧ water{offset −2, runTop true} → sand                                 # lake shallows: depth ≤ 2
     [6] if not{water{offset −10, runTop true}} → gravel                               # deeper than 10
     [7] if water{offset −10, runTop false} → sand                                     # within 10 of the water top
     [8] gravel ]
   [1] if steep{min $cliffSteep} ∧ yAbove{minY $cliffMinY, runTop true} ∧ SKIN → seq[  # cliffs
     [0] if biome{frozen_peaks} → packed_ice
     [1] stone ]
   [2] if TOP ∧ temperatureBelow{t $snowline} → snow_block                             # snowline
   [3] if SKIN → seq[                                                                  # biome palette
     [0] if biome{desert, beach, snowy_beach, river, frozen_river,
                  ocean, deep_ocean, warm_ocean, frozen_ocean} → sand                  # incl. islets and banks above water
     [1] if biome{badlands} → seq[ [0] if TOP → red_sand  [1] bandlands ]
     [2] if biome{stony_shore, volcano} → seq[ [0] if TOP ∧ P → gravel  [1] stone ]
     [3] if biome{stony_peaks} → seq[ [0] if TOP ∧ P → calcite  [1] stone ]
     [4] if biome{frozen_peaks} → seq[ [0] if TOP ∧ P → packed_ice  [1] if TOP → snow_block  [2] stone ]
     [5] if biome{snowy_slopes, jagged_peaks} → seq[ [0] if TOP → snow_block  [1] stone ]
     [6] if TOP → seq[
       [0] if biome{taiga, snowy_taiga} ∧ P → podzol
       [1] if biome{taiga, snowy_taiga} ∧ Pn → coarse_dirt
       [2] if biome{savanna} ∧ P → coarse_dirt
       [3] if biome{jungle} ∧ P → podzol
       [4] if biome{swamp} ∧ P → mud
       [5] if biome{windswept_hills} ∧ P → gravel
       [6] if biome{windswept_hills} ∧ Pn → stone
       [7] grass_block ]
     [7] dirt ]
   [4] if BAND4 → seq[                                                                 # 4 blocks below the skin
     [0] if biome{desert, beach, snowy_beach} → sandstone
     [1] if biome{badlands} → red_sandstone ] ]
 [2] if verticalGradient{trueAtAndBelow 0, falseAtAndAbove 8} → deepslate              # every solid voxel left: y ≤ 0; dither over 1 … 7
]
```

Reading the tree:
- First match wins. y −64 is never evaluated (the stage writes bedrock there). The order is Decision 6's, as in MC: bedrock, the sky-open surface skin, then deepslate for every solid voxel left, then stone.
- In branch [1], [1][0], [1][1] and [1][3] cover the skin (floorDepth ≤ surfaceDepth); the snow branch [1][2] tests the top voxel only, so S3 never depends on the depth noise; [1][4] fills floorDepth surfaceDepth + 1 … surfaceDepth + 4 (the voxels above were taken by [1][0]-[1][3], which always yield).
- **Below the skin.** A voxel of a sky-open run that branch [1] leaves (floorDepth > surfaceDepth + 4, or > surfaceDepth where [1][4] has no block for the biome) falls to [2]: deepslate at y ≤ 0, dithered over 1 … 7, stone above. Every sky-open skin voxel at y ≤ 7 keeps its surface block (the voxels where the order matters: at y ≥ 8 the deepslate gradient never holds, so a top at y 8 or above and its skin there are the same under master §3.11's order). This covers the skin under tops up to y 7 + maxSurfaceDepth (22) in the dither band and, below y 0, the skin under floors up to y 10 (its BAND4 voxels under floors up to y 14), such as a deep ocean floor (the lowest measured floors lie at y 5-6, §5.2); deepslate starts below the skin (floorDepth > surfaceDepth, or > surfaceDepth + 4 where [1][4] yields a band block). A stone skin (cliffs, the stony palettes, the windswept_hills Pn patch) stays stone even at y ≤ 0, as in MC; the measured dry tops never come near y 0 (§5.2's S2 note).
- Under water (the sky-open run with water directly above): warm ocean and beaches sand; deep and frozen ocean gravel; clay patches in rivers, swamps and lakes; river dirt; lake shallows sand; deeper than 10 gravel; elsewhere sand within 10 of the water top and gravel below. A lake keeps its land biome, so `lake` is the only way to tell it.
- Cliffs: `runTop` makes the whole skin of a run decide alike. Master §3.11's `steep > 1.2` and y ≥ 90 become `steep ≥ $cliffSteep` (1.2) and yTop ≥ `$cliffMinY` (80).
- Palette [1][3][0]-[5] cover every non-grassy biome; [6] and [7] are reached only by the grassy ones (plains, meadow, forest, birch_forest, dark_forest, taiga, snowy_taiga, snowy_plains, savanna, swamp, jungle, windswept_hills): the top is grass_block or a patch, the rest of the skin dirt. Patches replace the top voxel only, except clay, which fills the under-water skin.
- **Snowy biomes.** snowy_plains, snowy_taiga and snowy_beach have T ≤ −0.6 (their boxes), so the snow branch [1][2] makes their top snow_block almost everywhere; their grass_block, patch or sand top shows only where T_eff ≥ snowline (zoom and bilinear-T edges). Their under blocks apply as listed. This is master §3.11's snowline rule; S3 relies on it.
- Runs without sky (under overhangs) match no rule of [1] and fall to [2]: deepslate at y ≤ 0 (dithered over 1 … 7), stone above (grass never appears off the sky-open run). SP6 adds cave floors and ceilings here, as rules before [2] (§11).
- **Cut line variant** (§9): [1][3][1] becomes `seq[ [0] if TOP → red_sand  [1] terracotta ]`.

## 5. Metrics and tuning

### 5.1 Sampling

As SP3b §8.1:
- S1-S3 and the B4 and B2 voxel parts use the same scattered columns as T1-T5 (the same draw: `Xoshiro128(fnv1a32('T1-T5'))` in T1-T5's order (profile, seed, column), ±16384 / ±65536 blocks, the same counts), generated with `fillColumnT` on 4 workers. vitest isolates metric files, so `surface.metric.ts` generates them again on its own 4 region workers (`test/harness/surfaceScatterWorker.ts`) rather than sharing T1-T5's pass; each worker analyses every column in place (`test/harness/surfaceScatter.ts`: ColumnSample, scan, readouts and every per-part count) and frees it, and the main thread only sums the workers' integer count records (`mergeSurfaceAcc`; exact and independent of the order the workers answer in).
- Seeds per tier as DT1: fast '42'; quick '42'; full '42', '1', '2', '3'. Both profiles.
- Columns per (profile, seed): fast 4,096 / 16,384, quick 8,192 / 32,768, full 4,096 / 16,384 (default / large_biomes).
- **Minimums.** Every population-dependent part records its population beside it (`<part>.n.<profile>`; `<part>.<profile>` is the per-profile value, as T1-T5's `perProfile` writes it) and fails with "insufficient sample" below 1,000 per profile, on every tier: the land tops (S1 `buried`, `grassNoSky`; S3 `snowNoSky`), the `ymod16` positions, S2's stone-like voxels below y 0 and above y 8, S3's `snowAboveLine` tops, the desert tops (`snowInDesert`), the coast-band tops (`coastBandBeachVoxel`), the `landTopsBelowSea` positions and the river channel positions (`riverChannelWater`). Measured fast-tier populations (seed 42, default) are far above it: 25,300 desert tops, 37,882 coast-band tops, 173,849 snow-eligible tops, 13,824 channel positions. The exception is **`ymod16`** (one position per column, §5.2), measured in the review with its exact eligibility on SP3b's T over 4,096 default columns (±1024 chunks): 1,114 positions for seed '42' (the fast tier's whole default population, an 11 % margin), 1,212 / 1,078 / 1,048 for seeds '1' / '2' / '3'; large_biomes 4,975 (seed '42', 16,384 columns). Quick (8,192 default columns) has about twice the fast population, and full pools its four seeds per profile (§5.2), about 4,450 default. The fast default margin is listed here for the user's approval at the spec review. If a retune or the dry run takes it below 1,000, the part fails "insufficient sample" and the remedy (more columns for this part) is the user's call. A minimum is never lowered without the user's approval.

### 5.2 Definitions (voxels)

- **Land top:** the top voxel (`OCEAN_FLOOR_WG − 1`) of a position with no water above it (`WORLD_SURFACE_WG == OCEAN_FLOOR_WG`, SP3b §8.2); it is the top of the sky-open run.
- **Readouts:** T, steep, T_eff, the cliff predicate (`steep ≥ cliffSteep` and y_top ≥ `cliffMinY`, branch [1][1] at the top), the biome, `lake` and the nearest quart corner come from the exported scan helpers (§3.2), so a metric cannot drift from the rules. C and offset0 are bilinear `readField` readouts.
- **Nearest quart corner:** the corner `readLevel` reads (its rounding, ties to the lower corner), the one water v0 reads its level from. *River-wet* means `riverWetAt` at that corner.

| metric | parts | threshold |
|---|---|---|
| S1 | `buried`: grass_block, snow_block or red_sand voxels with a solid voxel directly above (sand is excluded: sand under sand is legitimate); `grassNoSky`: grass_block not in a sky-open run; `ymod16`: χ² test of independence (p-value) of the land top's y mod 16 against the top run's soil depth, below | 0 / 0 / ≥ 0.001 |
| S2 | `deepslateBelow0`: share of stone-like voxels (stone + deepslate) below y 0 that are deepslate; `deepslateAbove8`: share above y 8 that are deepslate; `bedrockFloor`: share of positions with bedrock at y −64 | ≥ 95 % / ≤ 1 % / 100 % |
| S3 (snowline part) | `snowAboveLine`: share of land tops with `T_eff(y_top) < snowline` that are not cliffs and are snow_block; `snowNoSky`: snow_block not in a sky-open run | ≥ 90 % / 0 |
| B4 (voxel parts) | `snowInDesert`: desert land tops that are snow_block; `coastBandBeachVoxel`: share of coast-band land tops (C in −0.22 … −0.04, the C interval of the beach, snowy_beach and stony_shore boxes; offset0 ≥ 63) whose top is sand, red_sand, gravel or stone, or snow_block at a snowy_beach position (beach, stony shore, snowy beach: master §6.4); `landTopsBelowSea`: below | 0 / ≥ 70 % / ≤ 1 % |
| B2 (voxel river check, SP2a minor 6) | `riverChannelWater`: among positions whose nearest quart corner is river-wet and whose bilinear `offset` < 63, the share with water above their top (`WORLD_SURFACE_WG > OCEAN_FLOOR_WG`) | ≥ 85 % (approved by the user on 2026-10-08 from the dry run: 0.895 … 0.930 on every tier and both profiles, the worst 0.8951 on the fast tier's large_biomes; 94 % of the dry positions are channel-margin tops at y 63-64, bilinear offset 62-63, where the density surface sits at or above the water level 63, so master §6.4's 2D ≥ 95 % does not carry over to the voxels) |
| DT2 (SP3c parts) | `probeBulk` (redefined) and the new `surfaceProbeBulk`, `surfaceReference`: below | 0 / 0 / 0 |

- **`S1.ymod16`.** One position per scattered column.
  - **Choice:** the column's 256 positions are visited in a per-column order, the permutation of the column indices 0 … 255 drawn by a Fisher-Yates shuffle (for i = 255 down to 1: j = `r.nextInt(i + 1)`, swap i and j) with `r = Xoshiro128(hash2(deriveSeed(seed, 'S1.ymod16'), cx, cz))`, and the first eligible one is taken. The order depends only on the world seed and (cx, cz), never on the order in which the workers return columns (`forEachColumnThreaded` visits in completion order).
  - **Eligible:** a land top at y ≥ 80, not a cliff, `T_eff(y_top) ≥ snowline` (no snow), biome not badlands.
  - **Soil depth:** the number of contiguous voxels from the land top downward that are neither stone, deepslate nor bedrock (nor air or water), the top included; the count stops at the first stone, deepslate, bedrock, air or water voxel. A stone top gives 0 (e.g. windswept_hills on the Pn patch, even with dirt under it).
  - **Classes:** 0, 1, 2, 3, 4, 5+. Merging is repeated until every remaining class other than 2 has ≥ 80 positions: each round takes the first class, in the order 0, 1, 5+, 4, 3, with fewer than 80 positions and merges it into its neighbour toward class 2 (0 → 1, 1 → 2, 5+ → 4, 4 → 3, 3 → 2; the merged class keeps the target's name, so it can merge again in a later round). Class 2 never merges into another class; if it then still has fewer than 80 positions, it absorbs its nearest remaining neighbours one at a time, below before above (1, 0, 3, 4, 5+), keeping its name, until it has ≥ 80 or none is left (still below 80 with nothing left, the table is degenerate). With k classes left (k = 1 fails the part as "degenerate table"), the 16 rows y mod 16 = 0 … 15, an empty row dropped, give the χ² independence test of the 16 × k table, df (rows − 1)·(k − 1).
  - **Pooling:** the table pools every seed of the tier per profile (fast and quick: '42'; full: '42', '1', '2', '3'); the population minimum (§5.1) applies to each profile's pooled table. Each profile's p-value is recorded as `ymod16.<profile>` and the part's value is the smaller (SP3b's `perProfile` worst-of, `min`), gated ≥ 0.001. The review measured p 0.066 (seed 42) and 0.047 (four seeds pooled) with a soil-depth proxy, so the test is feasible.
  - **Rationale:** the land tops' heights are SP3b's density (the surface pass never moves a top, and no §5.3 knob does), and their y mod 16 histogram is not flat (the sea-level pile-up and the density's 8-voxel cell layers; χ² 14,057 against a uniform null on 574,507 fast-tier tops). What master §6.5 targets is banding of the surface material ("chunk-local depth … banding → whole-column scan"): a whole-column scan makes the soil depth independent of where the top falls within a section.
- **`B4.landTopsBelowSea`.** Population: positions whose aux A `surfaceBiome` family is lowland, highland or coast (SP2b's "land biome"), excluding positions whose nearest quart corner has a finite `lakeLevel`, lakeMask > 0 or is river-wet. Value: the share whose floor (`OCEAN_FLOOR_WG − 1`) is below 63 **with water above it** (`WORLD_SURFACE_WG > OCEAN_FLOOR_WG`): a land biome under water (pre-measured ≈ 0.06 % on seed 42). The dry share (same population, no water above, top < 63; ≈ 2 % on seed 42) is SP3b §4's water-v0 dry pits: the ungated diagnostic `dryPitsBelowSea`, handed to SP6/SP7 (§11).
- **DT2 after SP3c** (in the existing `metricTest('DT2', …)` call of `region.metric.ts`; same columns and voxels, fast 512, quick 8,192, full 32,768):
  - `probeBulk`: its block predicate changes from "stone ⇔ solid; any other block counts" to "probe solidity (final > 0) ⇔ block ≠ air" (palette blocks and dithered bedrock are solid; air with or without water is not), y −64 excluded; the masked `Object.is(probe, bulk)` check is unchanged;
  - `surfaceProbeBulk` (new): DT2 voxels where `surfaceProbe(sc, x, y, z).state` (a SurfaceContext built apart, reference walk, no fast path) ≠ the T stage's stored block (compiled, fast path included);
  - `surfaceReference` (new): at each DT2 voxel plus 8 per column drawn uniformly within maxSurfaceDepth of the top of a sky-open run, the solid voxels where the compiled tree's state on the stage's scan context ≠ the reference evaluator's state. The metric reaches the stage's scan through the stage test hook `terrainSurfaceDebug(ctx, cx, cz, scan)`, which reruns the stage's phases up to the surface pass on the stage's own code path, scanning into the metric's scan, and writes no store; the compiled side is the stage's SurfaceContext (`surfaceContextOf`, full evaluation), the reference side a SurfaceContext built apart. The 8 extra voxels are drawn from their own stream, `Xoshiro128(hash2(fnv1a32('DT2.surface'), cx, cz))` per column (a position, then a depth 0 … maxSurfaceDepth below its sky-open top), never from DT2's `r`, so DT2's columns and its 16 voxels per column are drawn exactly as in SP3b. A draw that lands on a non-solid voxel (below a sky-open run thinner than the depth) or on a position without a run is skipped, both its numbers still consumed, and counted in the ungated `surfaceExtraSkipped` (≈ 0.5-1 %).
  - The new parts are exactness checks: they need no dry-run measurement and land with their code.
  - `probeBulk` keeps its name, its threshold (0) and its lock entry; only its predicate changes, in code, in the same commit as the surface pass (no lock change, no Threshold-log line).
- **S2 under Decision 6's order.** "Stone-like" is stone and deepslate only; the skin's other blocks (sand, gravel, clay, dirt, sandstone, …) count in neither share. "Below y 0" is y < 0 and "above y 8" is y > 8.
  - `deepslateBelow0` (≥ 95 %): below y 0 the deepslate gradient always holds, so a stone-like voxel there that is not deepslate is stone that branch [1] yielded in a sky-open skin: the cliff branch [1][1], the stony palettes [1][3][2]-[5] or the windswept_hills Pn top. These need a run with no water above (the under-water branch [1][0] comes first and always yields sand, gravel, clay or dirt), and such a skin reaches below y 0 only from a dry top at y ≤ SD_MAX − 1 (10 at the defaults); a cliff also needs yTop ≥ cliffMinY (80). Measured on SP3b's T (the fast tier's 4,096 default columns, the same columns for seeds '1', '2', '3', and 16,384 scattered large_biomes columns at ±4096 chunks, seed '42', the first 16,384 draws of a fresh `Xoshiro128(fnv1a32('T1-T5'))`): the lowest dry land top lies at y 36 … 51, so no stone skin reaches below y 0 and the share is 100 %.
    - Under water, a skin voxel (floorDepth ≤ surfaceDepth ≤ SD_MAX) lies below y 0 only under a floor at y ≤ SD_MAX − 1 (10): 1,963 … 2,375 positions per 4,096 default columns (seeds '3' … '2'; 8,555 per 16,384 large_biomes), the lowest floor at y 5 (seed '42' default; y 6 elsewhere). The bound used is SD_MAX, not maxSurfaceDepth: every solid voxel within SD_MAX of the floor, i.e. at most SD_MAX − f voxels below y 0 for a floor at y f. It gives at most 3,060 … 4,167 voxels below y 0 per 4,096 default columns (14,045 per 16,384 large_biomes), against 16,128 solid voxels per column there (y −63 … −1 is solid in every sampled column). None of them is stone: within surfaceDepth the under-water branch [1][0] yields sand, gravel, clay or dirt (they leave both counts); past it, a voxel is BAND4's sandstone or red_sandstone (desert, beaches, badlands; it leaves both counts) or falls to [2] as deepslate, which only raises the share. The same holds for the BAND4 voxels under floors at y 11 … 14 (the maxSurfaceDepth bound: floors at y ≤ 14, 27,968 … 29,682 positions and at most 60,002 … 65,404 voxels below y 0 per 4,096 default columns). Of the SD_MAX population, 232 … 460 positions (1,451 large_biomes) have their floor at y ≤ 8.
    - The margin: a position adds at most SD_MAX + 1 = 12 stone voxels below y 0, so the share falls under 95 % only if more than a quarter of all positions had a dry stony skin reaching below y 0.
  - `deepslateAbove8` (≤ 1 %): 0 by construction, as before: the deepslate gradient never holds at y ≥ 8, and no other rule yields deepslate.
  - `bedrockFloor` (100 %): unchanged; the stage writes bedrock at y −64.
- **Guards by construction.** `buried`, `grassNoSky`, `snowNoSky`, `snowAboveLine`, S2's `deepslateAbove8` and `bedrockFloor` hold by construction for the default tree, and `deepslateBelow0` by the bound above (100 % on the measured samples); they are regression guards against scan, fast-path and rule-order bugs (master §6.5 "chunk-local depth"), not tuning targets. The dithers are covered by the §8 unit tests.
- **Ungated diagnostics** (recorded in `test/metrics/.out`):
  - `landTopYmod16`: the land-top y mod 16 histogram, raw and against the neighbour-average expectation E_r = Σ_{y≡r} (h(y − 1) + h(y + 1)) / 2, with its χ²; any lattice artefact goes to SP3d/SP6 (§11);
  - `dryPitsBelowSea` (above);
  - `lakeRimIslets`: land tops whose `surfaceBiome` is ocean-family and whose nearest quart corner has 0 < lakeMask < 1 (a lake rim band, SP2a §2.5), as a share of all sampled positions, beside SP2a's 0.014 % of the world (SP2a §10). The comparison is indicative only: SP2a's figure counts sea-class 2D points a rim lifts above sea level, while the voxel islets also include the rims of lakes perched in sea areas and the density's relief;
  - `oceanBiomeLandTops`: land tops whose `surfaceBiome` is ocean-family, as a share of all sampled positions (with the raw count). Most are sea-class density islands above sea level, not rim islets (the dry run's measurement: 0.7-0.8 % of positions, the rim islets 4-7 % of them);
  - `shorelineFringe`: over near-shore positions (Chebyshev distance ≤ 2, inside the column, from a position with the other wet/dry state), excluding the `lakeRimIslets` positions, the share where an ocean-family biome sits on a land top or a land-family biome (lowland, highland or coast, as `landTopsBelowSea`) sits under water. It counts every lake bed (a lake keeps its land biome, §4), so `shorelineFringeSea` records the same share without the positions whose nearest quart corner is at a lake (finite `lakeLevel`), has lakeMask > 0 or is river-wet;
  - `topMismatch`: positions where the scan's sky-open top differs from aux A's `OCEAN_FLOOR_WG − 1` (0 expected);
  - the surfaceDepth histogram (the share at 0 included);
  - `patchCoverage` per (biome, patch block), and the per-block shares of every palette block.
- **Rows.** The SP2a 2D parts (`B4.hotColdSpruceWindswept`, `B4.coastBandBeach`, every B2 part including `dryRiverBiome`) stay unchanged, active and in `biomes.metric.ts` and `water.metric.ts`. The voxel parts are new keys of the existing B4 and B2 rows. `surface.metric.ts` registers them with its own `metricTest('B4', [voxel parts])` and `metricTest('B2', ['riverChannelWater'])` calls (the coverage check allows two calls per id with disjoint parts); `MetricEnv` gains `outName` (default: the id), and these calls pass `B4.voxel` and `B2.voxel`, so `.out/B4.json` and `.out/B2.json` keep the 2D records. Every new part is `activeFrom: 'SP3c'`, each with a lock accept and a Threshold-log line (one line per commit, naming every part it adds). As in SP3b, the S, B4 and B2 rows land after the dry run's measurement and any approved retune; the DT2 parts land with their code.

### 5.3 Tuning

The dry run measures S1-S3, B4, B2 and the diagnostics before any retune. If a part fails or the 2D defects show, the knobs are: `surface.depthMul`, `snowline`, `lapse`/`lapseBase`, `patchThreshold`, `cliffSteep`/`cliffMinY`, and for Decision 2 the lake rim and zoom parameters (`lakes.*`, `biomes.zoomJitter`).
- Whether the Decision 2 defects "show" is the user's call, made from `lakeRimIslets` (against SP2a's 0.014 %, indicatively), `shorelineFringe` and the lake and coast review slices; there is no gate. (Decided on 2026-10-08: handed to SP10, §11, §14.)
- The land tops are SP3b's density and water v0: no surface knob moves `ymod16`'s top heights, `landTopsBelowSea` or `dryPitsBelowSea`. A `landTopsBelowSea` failure is shown to the user with its 2D knob (`biomes.zoomJitter`); the dry pits are a diagnostic for SP6/SP7.
- The user approves before/after review slices (coast, lake, river, mountain, desert, snow) and the numbers. A retune of 2D parameters re-runs every 2D metric and re-records the SP2a goldens it moves, all inside `GENERATOR_VERSION` 5.

## 6. UI and tools

- **Voxels mode:** `VOXEL_COLORS` gains one colour per palette block (grass green, earth browns, light sand, sandstone, distinct greys for gravel and deepslate, whites for snow and calcite, pale blue for packed ice, oranges and reds for the terracottas); the legend lists them. The PNG review slices use the same palette.
- **Hover rule id (a worker probe).** The slice buffers do not change. `protocol.ts` gains `SurfaceProbeMsg {type: 'surfaceProbe', jobId, epoch, x, y, z}` and `SurfaceProbeResultMsg {type: 'surfaceProbeResult', jobId, epoch, state, path: string[]}`, each with its guard. Non-integer coordinates, a position outside the world window or y outside −64 … 319 are BAD_ARGS; STALE_EPOCH is handled as for `point`, and like a point job it never aborts (it ignores the abort cell), so ABORTED cannot arise. `taskHandler.ts` answers with `surfaceProbe(surfaceContextOf(ctx), …)` on its configured context. The pool gains `surfaceProbe(x, y, z, priority?)`, a single job. `section.ts` follows the map hover's point-job pattern (`hoverPanel.ts`): one probe in flight, the latest hovered cell wins, replies for an old epoch or cell are dropped. The epoch is the session epoch of the shown slice: after a parameter edit the pool runs the new draft while the dimmed slice still shows the old voxels, so a slice of an older epoch shows no rule suffix and sends no probe, and a reply that lands after the epoch moved is neither shown nor remembered; a `JobCancelled` at the same epoch asks again. The readout shows SP3a's text at once, then appends ` · rule …` while waiting, replaced by ` · rule <leaf id>` (the last id of `path`, e.g. `root.rules[1].then.rules[3].then.rules[6].then.rules[7]` for a grass_block top) or ` · rule none` when `path` is `[]`; any other error shows ` · rule failed: <message>` (not retried). A probe is sent for every hovered voxel, air and water included (they answer `[]`).
- **Review slices** (`npm run docs:review-slices`, `assets/sp3c/`): coast, lake, river, mountain, a desert site and a snowy site (and SP3b's y 62 plane, which the set keeps), each re-derived from the voxels by a test as SP3b's. `needs` gains two kinds read from the voxels: `desertTop` (land positions whose top is sand with surfaceBiome desert) and `snowTop` (land positions whose top is snow_block); the desert and snowy lines must each hold ≥ 64 positions of their kind. The two sites are windows found by a scan, as SP3b found the mountain (the 2D biomes of the line's quart points, then the best windows counted on the voxels), recorded in the site's comment. A badlands site is added the same way when `bandlands` ships: its line is scanned for the 2D badlands biome like the mountain, and it needs `badlandsTop` (red_sand tops, ≥ 64), which counts every red_sand top (the SP3b mountain line holds some too). At 1 px per block the 1-voxel snow top, the 4-voxel sandstone band and the bands are hairlines, so each SP3c site is drawn whole from y −64 at 1 px per block plus a 16-column zoom at 4 px per block inside its window, with the same needs.
- **uiSmoke:** checks the legend; hovers the top solid voxel of a land sample on the mountain line (found from the slice's ground-top data, not a fixed height) and waits for ` · rule root.…`. `voxelReadoutOk` accepts SP3a's format with an optional ` · rule (…|none|<rule id>)` suffix, the rule id matching `root(\.rules\[\d+\]|\.then)*`. The `--shots` mountain screenshot (§9's "Voxels-mode screenshot with a hover rule id") hovers the same top voxel and waits for its ` · rule root…` before the shot (SP3b's pointed at a fixed y 120).

## 7. Goldens and bench

- `GENERATOR_VERSION` 5 re-records `sp1.params` (it hashes `genKey`) and `sp3a.region.T.*` (the surface now in T).
- `sp3b.density.*` change only if an approved 2D retune (§5.3) moves the ColumnSample fields they read (`offset`, `sigma`, `jag`) at their fixed columns (none lies in a lake or rim at the defaults); they are then re-recorded with the SP2a goldens. SP2a goldens change only through an approved 2D retune. Any other change is a bug.
- New: `sp3c.registry` (§2.2) and `sp3c.surface.ops`: the compiled rule results (u16 LE state ids, FNV-1a 64, as SP3b §9) of a fixture tree that uses every SP3c condition and kind (`lake` included; `bandlands` unless cut), over every voxel of a fixed column list, seed '42', default profile; the fixture tree and the columns are frozen in `sp3cGoldens.ts`, whose unit test asserts `sp3cGoldenKeys().length === 2`. Each column contributes 98,304 u16 LE in the stage's `256·(y + 64) + p` order, filled as the stage fills it (`fillColumn` with the fast path on), with 0xffff where the rules write nothing (non-solid voxels and y −64), so air, water and "not evaluated" never collide with a state id. The fixture tree has a fast path (every leaf depth-bounded or Y-only), so the golden exercises it too; its unit test checks, at every solid voxel, value = compiled full evaluation = reference. Count 52 → 54; `?selftest=1` (Chrome, Firefox) and Bun check all keys.
- **Recording happens once**, after the §5.3 dry run and any approved retune, and after the bandlands task or the cut decision (§9): `npm run test:goldens` refuses a changed key at an unchanged `GENERATOR_VERSION`, so any earlier v5 record made during development is discarded by restoring `test/goldens.json` from `main` before the final record (as SP3b §9). Never bump to 6 to get past the refusal.
- **Bench:** `terrain.real` now includes the surface pass, so its ratio rises by design. In the pre-record run of SP3a §7's procedure (bench against SP3b's baseline), every row must pass its +30 % gate except `terrain.real`, which is checked only against its absolute 4 ms p50 gate (SP3b §10); the record then re-baselines it. The mechanism: `noise.bench.ts` reads `BENCH_EXEMPT`, a comma-separated list of `BENCH_ROWS` names (empty when unset or blank; each name trimmed; an unknown name or an empty entry fails the run before anything is measured), and passes it to `gateFailures(baseline, kernels, killRatio, exempt)`, which skips the ratio gate of those rows and prints `<row>: exempt, ratio r vs baseline b` (r and b to 3 decimals); an exempt row without a baseline entry is skipped like any new row. The kill criterion and the absolute gates (`absoluteGateFailures`, `terrain.real` p50 ≤ 4 ms included) are never exempt, and `bench:record` ignores `BENCH_EXEMPT`. The pre-record run is `BENCH_EXEMPT=terrain.real npm run bench`; the exit run is a plain `npm run bench` against the new baseline. `benchGates.test.ts` covers the exempt list. New row `surface.column`, appended to `BENCH_ROWS` after `terrain.real`: one column's density is filled once (column (0, 0) of seed '42', `density.corner`'s column, built with `surfaceProbeColumn` on the stage's SurfaceContext), then `surfacePass` (`pass.ts`, the function `terrainStage` calls, so the bench and the stage share one code path) is timed alone. `test/baselines.json` is re-recorded. Quiet-machine procedure as SP3a §7.

## 8. Tests (summary)

- **Unit:**
  - each condition (value, edges, validation with node paths), `lake` at a lake, rim and dry corner, `water` and `yAbove` with both `runTop` values, `verticalGradient`'s ends and probabilities, `noiseThreshold`'s closed ends;
  - the band table (run lengths, colours, the negative-y wrap, the ±4 offset);
  - the scan (runs, depths, sky-open under an overhang, water above and `waterTop`, surfaceDepth ∈ [0, SD_MAX] with the maximum reached);
  - the compiler vs the reference, and the fast path vs full evaluation, on every voxel of sampled real columns and of the fuzz's random trees (with trees whose fast path must be off);
  - `defaultRules` equals `test/fixtures/sp3c-default-rules.json`;
  - the default tree on real columns: grass over dirt, sand and sandstone in the desert, snow_block tops where T_eff < snowline (grass_block in snowy biomes only where T_eff ≥ snowline), stone cliffs, deepslate below the skin and dithered bedrock; Decision 6's order on skin voxels at y ≤ 0, the case that tells it from master §3.11's order (a top at y 8, or skin voxels only in the dither band 1 … 7, would pass under both and does not count): a hand-built column with a dry top below y 0 (a grassy biome and a desert one) and a real or hand-built deep ocean floor whose skin reaches below y 0, each checked voxel by voxel: every voxel with floorDepth ≤ surfaceDepth at y ≤ 0 is its surface block (grass_block, dirt, sand, gravel, …), not deepslate; the BAND4 voxels (surfaceDepth + 1 … surfaceDepth + 4) are sandstone in the desert; and, at y ≤ 0, deepslate starts at floorDepth surfaceDepth + 1 (surfaceDepth + 5 where BAND4 yields); a run without sky deepslate at y ≤ 0 and stone at y ≥ 8, no grass off the sky-open run, clay in a river or lake bed;
  - `surfaceProbe`: its state equals the T stage's block at sampled voxels (fast-path voxels included), a deepslate voxel at y −30 reports the deepslate rule's path (ending `root.rules[2].then`), `[]` for air, water and an overhang's stone at y ≥ 8;
  - the 22 states' table values; the lock append;
  - the Voxels palette: every state 0 … `REGISTRY.stateCount − 1` has its own colour (`voxelRgb` never returns `VOXEL_COLORS.unknown` for one), the non-air colours are pairwise ≥ 24 apart in summed |ΔRGB|;
  - the protocol guards of the two `surfaceProbe` messages; `MetricEnv.outName`; the five U2 class columns, their acceptance checks and pins (§3.5); `gateFailures`' exempt list (§7).
- **Replaced** (earlier tests whose pins SP3c changes: SP3b's "solid ⇒ stone" pins, the SP pins, the U2 column list, the bench gate calls):
  - `terrainStage.test.ts`: the expected-column builder (~l.80), the estimate-column check (~l.231) and the bulk-mask check (~l.409) compare solidity as block ≠ air, or the surfaced palette (the expected column takes each solid voxel's state from `surfaceProbe` on a SurfaceContext built apart); the poll-order and stop tests count 31 polls per column (§1); the uniform land section 1 (~l.309, y −48 … −33) is uniform deepslate (it lies far more than maxSurfaceDepth below the land top, so Decision 6's order leaves it deepslate);
  - `blockDefs.test.ts` (3 types and 3 states) gains the 22 appended types; `stateLock.test.ts`'s 'swapping stone and bedrock is refused' builds its swapped registry with `...BLOCK_DEFS.slice(3)` appended (otherwise the 22 locked palette states are also reported as no longer registered);
  - `stage.test.ts` (`terrain@2` → `terrain@3`); `region.test.ts` (31 polls per column, the surface poll being poll 6 counted from 0, §1: its abort list and comment); `test/integration/region.test.ts` (§8's 4-thread integration on the surfaced T, which also asserts the surfaced region); `sliceJob.test.ts`'s poll arithmetic moves to 1 + 31 = 32 polls per column (its assertions pass either way);
  - `goldens.sp2a.test.ts` (the key count 52 → 54), the key-slice assertions of `goldens.sp3a.test.ts` and `goldens.sp3b.test.ts` (SP3c's two keys follow), and `uiSmoke.test.ts`'s selftest summary strings (§7);
  - `terrainHeap.test.ts` measures the retained heap without V8's JIT spaces (`code_*`, `trusted_*`, `shared_trusted_*`; the 16 KiB limit unchanged): what the compiler installs there depends on the machine's load, and the extra load of `surface.metric.ts` beside it under `npm run test:goldens` pushed the whole-heap growth over 16 KiB; a retained object per column is still caught;
  - `crossSectionVoxels.test.ts`'s `voxelRgb(7) === unknown` moves to a state id ≥ `REGISTRY.stateCount`;
  - `profiles.test.ts` and `test/arch/sp.test.ts` pin `'SP3c'` (§10);
  - `liveness.test.ts` (`CLASSES` ~l.26-29, the class-column test ~l.123-129): the expected class list `CLASSES` (in `CLASS_ORDER`, which appends the new classes) gains `cliffY`, `cliffSteep`, `snowline`, `patch` and `badlands` after SP2b's classes, the distinct-column count goes from 16 to 21 (20 if the §9 cut is taken), the first 16 columns are asserted equal to SP3b's, and the "shows its class" test gains the five corner prefilters;
  - `benchGates.test.ts`: `gateFailures` calls gain the exempt argument (an empty list keeps today's cases).
  - Unchanged: `sliceJob.test.ts`'s assertions (its `stone > 0` still holds; only its poll counts move, above), and the hand-built views of `reviewSlices.test.ts` and `png.test.ts`.
- **Integration:** the 4-thread harness against the 1-thread one on the T with surface.
- **Metrics:** DT1, DT2 (with `surfaceProbeBulk` and `surfaceReference`), S1, S2, S3, the B4 voxel parts, the B2 river check, T1-T5 still passing, U2 with the `surface.*` leaves, every tier.
- **Bench, tools:** as §6-§7.

## 9. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with DT1, DT2 (`probeBulk`, `surfaceProbeBulk`, `surfaceReference`), S1-S3, the B4 voxel parts and the river check active; T1-T5 still pass; U2 decides every `surface.*` leaf | `npm run build && npm test && npm run test:metrics:full` |
| CI green | GitHub Actions |
| the 22 states appended; the lock accepted; `sp3c.registry` recorded | lock test, goldens |
| `GENERATOR_VERSION` 5; only the allowed goldens change; `?selftest=1` all keys in Chrome and Firefox; Bun all keys | goldens tests, browsers, Bun tool |
| bench: every row recorded before SP3c within +30 % except `terrain.real`; `terrain.real` p50 ≤ 4 ms; the exit run against the new SP3c baseline | `BENCH_EXEMPT=terrain.real npm run bench` (pre-record, against SP3b's baseline), `npm run bench:record`, then `npm run bench` (no exemption) |
| visual review approved by the user, incl. the 2D-defect decision | `assets/sp3c/` slices and a Voxels-mode screenshot with a hover rule id |

The exit evidence (the build, `npm test` and `test:metrics:full` totals and values, the goldens, the bench, Bun, the browser checks and the review) is recorded under `## Exit evidence`, before the Threshold log, as SP3b.

**Cut line.** If SP3c runs short, `bandlands` is not built and moves to SP10; badlands then uses `terracotta` as its under block (§4's cut variant). To keep the cut free of the schema lock and the goldens, the plan builds `bandlands` as its own late task: that task adds the `surface.noises.bandOffset` leaf, the band table, the `bandlands` kind, the badlands branch of §4, the `badlands` U2 class column and the badlands review site. The `sp3c.surface.ops` fixture's `bandlands` case lands with `sp3cGoldens.ts` itself, which comes after the bandlands task (its fixture tree then includes a `bandlands` leaf; without it, if cut). Earlier tasks use the cut variant. The cut is decided when that task starts, before the leaf is accepted with `test:accept-schema` and before the goldens are recorded (§7):
- if cut, the leaf never reaches `test/schema-shape.lock.json` (no dead leaf for U2), the fixture has no bandlands case, and the §12 amendments and the §10 SP3c deliverable drop the bands;
- if the leaf was already accepted on the SP3c branch but not pushed to `main`, `test/schema-shape.lock.json` is restored from the base commit and accepted again (no `SCHEMA_VERSION` bump: the leaf never shipped);
- once the bandlands task is on `main`, it is not cut.

The terracotta states are registered either way, so the state-id lock does not change.

## 10. Governance

- The first commit appends `'SP3c'` to `STARTED_SPS`, sets `CURRENT_SP = 'SP3c'`, moves the `CURRENT_SP` pin of `test/unit/profiles.test.ts` and the `STARTED_SPS` / `CURRENT_SP` pins of `test/arch/sp.test.ts` to SP3c (as SP3b §12), accepts the thresholds lock and appends to the Threshold log.
- The state-id lock grows by 22 entries through `npm run test:accept-state-ids` (append-only; the commit message says so).
- New threshold parts, `activeFrom: 'SP3c'`: S1 (`buried`, `grassNoSky`, `ymod16`), S2 (`deepslateBelow0`, `deepslateAbove8`, `bedrockFloor`), S3 (`snowNoSky`, `snowAboveLine`), B4 (`snowInDesert`, `coastBandBeachVoxel`, `landTopsBelowSea`), B2 (`riverChannelWater`), DT2 (`surfaceProbeBulk`, `surfaceReference`), Each lands with a lock accept and a Threshold-log line (§5.2's order; one line per commit, naming every part it adds). DT2.`probeBulk`'s predicate changes in code, in the same commit as the surface pass, with no lock change (its name and threshold stay).
- The master amendments of §12 land with the spec; those `test/arch/masterSpec.test.ts` checks land with the code they describe.

## 11. Notes handed to later SPs

- **SP3d:** `surface.rules` as an editable JSON leaf with the inspector (`validateRules` already bounds depth and node count; the fast path is already general, §3.4); block rules naming non-solid states would break the stage's heightmap shortcut (`oceanFloorWG` from solidity), so the editable leaf must reject them or recompute the heightmaps; `stoneDepth.secondaryDepthRange` with its own noise leaf when a default rule needs it.
- **SP3d / SP6 (density):** the land tops carry an 8-periodic residue artefact from the density's 8-voxel cell layers (fast tier, seed 42, after detrending: −28 % at residue 15, +12 % at residue 0; on the surfaced T, against `landTopYmod16`'s neighbour average, +7.3 % at residue 0, +4.7 % at 8, −5.4 % at 7, −6.8 % at 14, fast default); SP3c records it (`landTopYmod16`) but cannot change the frozen density.
- **SP6:** `caveBiome`, cave floor and ceiling rules for runs without sky, inserted before the deepslate rule [2] (Decision 6's order: the voxels they leave fall through to deepslate or stone), the cave palettes; `secondaryDepthRange` if its cave rules need it.
- **SP4 / SP6:** master S1's "grass at sky 0" (≤ 0.1 %) replaces `grassNoSky` once SP4's light exists; SP6's exit re-asserts it.
- **SP6 / SP7:** `dryPitsBelowSea` (SP3b §4's water-v0 dry pits; ≈ 2 % of land-family positions on seed 42) goes with the aquifers and the settle.
- **Decorate (D):** ice on sky-exposed water with `T_eff < −0.45`, snow layers on sky-exposed ground, S3's ice parts; D's freezing reads `surface.lapse` and `surface.lapseBase`.
- **SP8a:** textures and the per-biome grass tint for `grass_block`. `sp3c.registry` hashes `FACE_TEX` (0 until SP8a) over states 3 … 24, so it changes when textures land: decide it together with `sp3a.registry` (SP3a §10), re-keying the registry goldens over the final tables rather than bumping `GENERATOR_VERSION` for a texture-only change.
- **SP8b:** snowy_taiga and snowy_plains tops are mostly snow_block (§4); master §3.12's tree ground check ("grass, dirt, podzol or snowy grass") must accept snow_block, or the surface tree must exempt these biomes from the snow branch, before spruce placement.
- **SP10:** the 2D defects of Decision 2, handed over by the user on 2026-10-08 after the dry run's measurement (no 2D change in SP3c, so `sp2a.*` and `sp3b.density.*` are unchanged; the §9 cut was not taken, so `bandlands` ships here):
  - **Lake-rim islets:** land tops with an ocean-family biome at a lake-rim corner (0 < lakeMask < 1). `lakeRimIslets` measured 0.053 % / 0.030 % / 0.026 % of positions on the default profile (fast / quick / full) and 0.0065 % / 0.012 % / 0.011 % on large_biomes, beside SP2a's indicative 0.014 % (a different population, §5.2); their tops are mostly sand (66-80 %), the rest stone cliffs and, on large_biomes, snow. Rare overall, but they show as large geometric shapes where they occur. **The example is islet-1** (seed '42', default; x −16384 … −16177, z −10624 …): a lake perched at y ≈ 100 in an ocean-biome sea area, whose rim is a 4,556-position sand-topped stone mesa rising ~35 blocks from the sea floor, with a quart-staircase edge (4-block steps) in plan and a bare stone wall on the sea side. Two other dense sites (x 14912 …, z −5920 …; x −9664 …, z −15040 …) read as sand spits between lake and sea.
  - **Shoreline zoom fringe:** within 2 blocks (Chebyshev, inside the column) of the other wet/dry state, an ocean-family biome on a land top or a land-family biome under water. `shorelineFringe` measured 20-22 % of near-shore positions on the default profile and ≈ 35 % on large_biomes (`shorelineFringeSea`, without lakes and river-wet corners, 25-26 % / ≈ 37 %); its blocks match what the other biome would give there (sand on both sides, clay or gravel under water), so it is nearly invisible on the voxels.
  - **Ocean-family biomes on land** in general (`oceanBiomeLandTops`, 0.7-0.8 % of positions): mostly sea-class density islands above sea level, sand-topped; the rim islets are 4-7 % of them.
  - The knobs are `lakes.*` and `biomes.zoomJitter` (§5.3); any fix is a 2D retune that re-records the SP2a goldens it moves. The four diagnostics stay ungated in `surface.metric.ts` until SP10 decides.

## 12. Master-spec amendments made with this spec

- **§10 SP3c:** deliverable — biome surfaces on the voxel terrain (the 22-block palette, surface rules, dithered bedrock and deepslate, snowline, cliffs, badlands bands), in the slices and the Voxels mode with the hover rule id; exit as §9 here; cut line as §9 (`bandlands` → SP10, decided before its leaf enters the schema lock).
- **§1 (module layout):** `gen/surface/` adds `conditions.ts`, `reference.ts`, `bands.ts`, `pass.ts`, `context.ts` and `probe.ts`; the `metrics/*.ts` entry adds "SP3c: sp3cGoldens.ts" after "SP3b: sp3bGoldens.ts" (master l.130); the `test/` entry adds "SP3c: harness/surfaceFuzz.ts, harness/surfaceScatter.ts, harness/surfaceScatterWorker.ts, metrics/surface.metric.ts, fixtures/sp3c-default-rules.json" after the SP3b list (master l.155); the determinism-files list of "Banned APIs" (`DET_FILES`, master l.179) adds `metrics/sp3cGoldens.ts` beside `metrics/sp3aGoldens.ts`, as the module layout here says (and `metrics/sp3bGoldens.ts`, which `test/arch/rules/banned.ts` already lists but the master line omits).
- **§2.2:** the terrain palette's 22 types and their table values (§2.1 here); `deepslate` without `axis`.
- **§3.10:** the T_eff lapse 0.006 and base 80 become `surface.lapse` and `surface.lapseBase`.
- **§3.11:**
  - the SP3c condition set and rule kinds (§3.1): `lake` added; `water{offset, runTop}` and `yAbove{minY, runTop}` replace `mult`; `secondaryDepthRange` deferred; `abovePreliminarySurface` dropped; `caveBiome` stays SP6's;
  - the scan's quantities, hashes and noise sampling (§3.2); `surfaceDepth = max(0, ⌊3 + 2.75·depthMul·Ns + 0.25·hash01⌋)` (the master formula assumed MC's narrower surface noise);
  - the default order (Decision 6, confirmed by the user on 2026-10-07): [0] bedrock, [1] the sky-open surface branch, [2] the deepslate gradient for every solid voxel left, then stone. Master rule 2 (deepslate) moves after rules 3 and 4, as in MC; the resulting master order is: rule 1 bedrock, rule 3 the open-sky top run, rule 4 the lower-run cave floor and ceiling rules (SP6), then rule 2 deepslate for every solid voxel left (its absolute-y strata unchanged), then stone. Every sky-open skin voxel at y ≤ 7 (the skin of deep ocean floors below y 0 included) keeps its surface block, and deepslate replaces the stone below the skin and in runs without sky;
  - the general fast path (§3.4, with the sky gate for runs without sky), the parameters (§3.5) and the default tree (§4): the cliff rule becomes `steep ≥ surface.cliffSteep` (1.2) and yTop ≥ `surface.cliffMinY` (80, was > 1.2 and y ≥ 90); deepslate is dithered over 1 … 7 (was 0 … 8); ice and snow layers stay in D.
- **§5.5:** the surface-rule branch path reaches the slice view through the `surfaceProbe` worker job (§6).
- **§6.4:**
  - S1: `grassNoSky` replaces "grass at sky 0" until light exists (SP4); "surface y mod 16 χ²" becomes the χ² independence of the top's y mod 16 and the soil depth (§5.2), which targets the banding of master §6.5;
  - S2 and S3 part names as §5.2;
  - B4's voxel parts: `snowInDesert`, `coastBandBeachVoxel` (snowy beach counted by its snow_block top), `landTopsBelowSea` (land-family positions with water above a floor below 63, outside lake and river-wet corners);
  - B2: the voxel river check `riverChannelWater` (≥ 85 %, §5.2);
  - DT2: `probeBulk` compares probe solidity with block ≠ air; SP3c adds `surfaceProbeBulk` (surfaceProbe == the stored block) and `surfaceReference` (compiled == reference);
  - U2: SP3c adds five class columns for terrain leaves (`cliffY`, `cliffSteep`, `snowline`, `patch`, `badlands`; 21 class columns, 20 if the §9 cut is taken), found by a third pass after SP2b's two so the existing 16 stay, each accepted only when every leaf it serves changes a voxel of the generated column; every `surface.*` leaf must be decided.
- **§7 (performance budget):** `terrain.real` (T ≤ 4 ms p50) now includes the surface pass; the bench gains `surface.column`.
- **§10 SP6:** its exit's "S1 (grass at sky 0)" is master S1's part restored in place of `grassNoSky` once SP4's light exists.
- **§10 SP10:** received from SP3c, the lake-rim islets and the shoreline fringe (Decision 2, handed over by the user on 2026-10-08), with the example site islet-1 and the four ungated diagnostics (§11).

## 13. Changes made after the adversarial spec review (2026-10-07)

All 46 kept findings were taken (none rejected; the per-finding map is in `.superpowers/sp3c/revision-map.md`). Where a finding's fix and its verifiers' better fixes differed, the controller's rulings and the version that is correct against the code were taken. The ones that changed the design:
- **surfaceDepth.** A unit-sd `Ns` made it negative on ≈ 13 % of positions: bare-stone tops, and S3 capped near 0.87. It is now `max(0, …)` with a new knob `surface.depthMul`; the snow rule is its own top-voxel branch, so S3 never depends on the depth noise. (A 'uniform' remap was the alternative; the clamp keeps the master formula and gives the dry run a real lever.)
- **The default tree is exact data** (§4) with a fixture test: no dead branch, every parameter and `runTop` given, patches one-sided per sign, the sandstone band reachable (rule [1][4], numbered as after Decision 6), red_sandstone placed under the bands.
- **`lake`** joins the conditions (controller ruling; the verifiers preferred a biome-only rewording, but water v0 levels sea and rivers at 63 everywhere, so only the lake corner tells a lake apart).
- **`water` and `yAbove`** take `runTop` instead of `mult`, and the MC claim is corrected; **`secondaryDepthRange`** is deferred (no default rule reads it, and a noise leaf for it would be dead for U2).
- **S1 `ymod16`** is a χ² independence test of soil depth against the top's y mod 16: the top heights are the frozen density, not flat mod 16 (χ² 14,057 against uniform), and no SP3c knob moves them; the height histogram is a diagnostic and its lattice artefact goes to SP3d/SP6.
- **B4 `landTopsBelowSea`** counts only land-family positions with water above a floor below 63 (≈ 0.06 %); the dry pits (≈ 2 %, SP3b's water v0) are a diagnostic for SP6/SP7. **`coastBandBeachVoxel`** counts snowy beaches and no longer collides with SP2a's 2D part; the voxel calls write their own `.out` files.
- **DT2** treats palette blocks as solid and gains `surfaceProbeBulk` and `surfaceReference`; the SP3b tests that pin stone are listed as replaced.
- **U2** gains five SP3c class columns (cliffY, cliffSteep, snowline, patch, badlands) found by a fixed scan with a re-derivation test: at seed 42 the land and coast columns could not decide `bandOffset` or `cliffMinY`.
- **The fast path** is a general, conservative compile-time analysis with exact band ends, fuzzed on random trees.
- **The hover rule id** comes from a `surfaceProbe` worker job; the slice buffers do not change.
- **The cut line** builds `bandlands` as its own late task, decided before its leaf enters the schema lock or the goldens.
- **The bench** exempts `terrain.real`'s rise from the pre-record ratio gate (its 4 ms gate stays) and times `surfacePass` alone as `surface.column`.
- **Other fixes:**
  - §1's stage order (sections, then aux) and the biome buffer computed once;
  - hashes through `deriveSeed` / `hash2` / `hash3` with named seeds, the dither formula and its ends;
  - noise metas (wavelength ranges, `remapNone`, unscaled coordinates) and the band algorithm with its ±4 offset;
  - the probe's semantics, context and empty path;
  - sampling copied from SP3b with per-part minimums of 1,000;
  - the B2 river check's exact population (its threshold stays the dry run's, by ruling);
  - `buried` without the circular sand clause, and the guards stated as such;
  - S3 and every part read the scan's own readouts;
  - the golden recording procedure, the `sp3b.density.*` and `sp3c.surface.ops` statements, the SP8a registry note;
  - the snowy biomes' snow tops stated, with an SP8b note on the tree ground check;
  - `lakeRimIslets` measures SP2a's rim islets, `shorelineFringe` has a population, and "if they show" is the user's call;
  - desert and snowy review sites with voxel needs, and a palette-completeness test;
  - the master amendments and hand-overs completed (§3.10, §3.11 cliff values, §5.5, §6.4 DT2/U2, §10 SP6) and the `CURRENT_SP` pins.
- **Second check of the revision** (13 problems, all fixed; map in `.superpowers/sp3c/revision-map.md`):
  - U2's SP3c slots run in a third pass after SP2b's two, so the 16 existing columns and their verdicts stay (scanning them first would have moved land #1 and coast #1). The single cliff slot became `cliffY` and `cliffSteep`, and every SP3c slot has an acceptance check on the generated column, because a corner prefilter alone picked a dead cliff column. The slot order is fixed with `badlands` last, and the pins were pre-measured at seed 42. `liveness.test.ts` (21 columns) is listed as replaced.
  - `S1.ymod16`: per-column visit orders seeded by (cx, cz), not by worker arrival; soil depth contiguous from the top; repeated class merging in a fixed order; per-profile pooling and worst-of p-value; its thin population margin (1,114 on the fast default) is listed for the user's approval (the controller's one-position-per-column ruling stands).
  - The JSON encoding of rules and conditions (`kind` discriminator, `if` nesting, every field written, no −0), the band table's draw order, SD_MAX's clampSigma (3, not 11), the `BENCH_EXEMPT` mechanism, `probeBulk`'s predicate change without a lock change, DT2's surface voxels on their own stream, and the master §1 test-side files and `DET_FILES`.
- **Decision 6 (the user, 2026-10-07, after this revision):** the sky-open surface branch moved before deepslate (MC's order), so every sky-open skin voxel at y ≤ 7 (the skin of deep ocean floors below y 0 included) keeps its surface block and deepslate replaces only the stone below the skin and in runs without sky; a top at y 8 or above is the same under both orders.
  - The rule ids changed: the sky-open branch is `root.rules[1]` and deepslate `root.rules[2]` (bedrock stays `root.rules[0]`). Every branch reference here was renumbered ([2][k] → [1][k]), with the §4 listing and its fixture, the probe path examples (§3.6, §6, §8) and the cut variant; the `sp3c.surface.ops` fixture tree names no paths.
  - The fast path (§3.4) gained the sky gate, so stone in runs without sky still takes the deepslate band; its bands are unchanged (and now stated as cut only by the Y-only leaves' conditions), and the top maxSurfaceDepth + 1 voxels of every sky-open run are evaluated at any y.
  - S2 (§5.2): `deepslateBelow0` is argued by a measured bound instead of by construction (no dry top below y 36 on the measured seeds and profiles, so 100 %); `deepslateAbove8` and `bedrockFloor` stay by construction; the thresholds are unchanged.
  - The U2 pins stand (§3.5); the tests gained the no-sky and fast-path cases (§3.4, §8) and the discriminating skin-below-y-0 case (a dry top below y 0 and a deep ocean floor whose skin reaches below y 0, §8; a top at y 8 would not tell the orders apart); master §3.11's order (written out in full) and the SP6 hand-over are amended (§11, §12).
  - S2's under-water figures (§5.2) are restated for one population: floors at y ≤ SD_MAX − 1 with the SD_MAX bound (re-measured; the earlier text paired the y ≤ 8 position counts with voxel counts of the y ≤ 10 floors).

## 14. Changes made by the implementation-plan dry run (2026-10-08)

The plan was dry-run in a scratch worktree: every task was implemented and every test, metric tier, the bench and the browser smoke were run, and the surface metrics were measured on all three tiers and both profiles before any row landed. These are the resulting changes to the approved spec:

1. **The user's decisions on the measurement (2026-10-08).**
   - **B2 `riverChannelWater` ≥ 85 %** over the population of §5.2 (every river-channel position, no offset restriction). Measured 0.895 … 0.930 on every tier and both profiles (worst 0.8951, fast, large_biomes; quick 0.9065, full 0.9195). 94 % of the dry positions are channel-margin tops at y 63-64 (bilinear offset 62-63), where the density surface sits at or above the water level 63; over offset < 62 the share is 95.5-97.5 %. So master §6.4's 2D ≥ 95 % does not carry over to the voxels, and 85 % leaves a 4.5-point margin under the worst value.
   - **Decision 2 → SP10.** The lake-rim islets and the shoreline fringe are not fixed in SP3c: no 2D change, so `sp2a.*` and `sp3b.density.*` are unchanged. They stay ungated diagnostics (`lakeRimIslets`, `shorelineFringe`, `shorelineFringeSea`, `oceanBiomeLandTops`), and §11 hands them to SP10 with **islet-1** as the example: a lake perched at y ≈ 100 in an ocean-biome sea area (seed '42', x −16384 … −16177, z −10624 …), whose rim is a sand-topped stone mesa rising ~35 blocks from the sea floor with a quart-staircase edge.
   - **`surface.depthMul` unchanged.** 22.5 % of positions have surfaceDepth 0 (a top block directly on stone or deepslate; mean 2.86, SD_MAX 11 reached); the user accepts it, and it stays a diagnostic.
   - **No retune.** Every gated part passes on every tier and both profiles at the §3.5 defaults, so no before/after slices were needed and no 2D golden moves.
   - **Bandlands built, the §9 cut not taken.** `bandlands`, its `surface.noises.bandOffset` leaf and the `badlands` U2 column ship in SP3c, in their own late task as §9 planned.
   - **`surface.metric.ts` optimised** (the user's decision, after its first version roughly doubled `npm test`): the per-column analysis moved from the main thread into the region workers (§5.1, `test/harness/surfaceScatter.ts` and `surfaceScatterWorker.ts`); every value, population and diagnostic is unchanged (485 of 485 full-tier values equal).
2. **Measured, unchanged.**
   - Gated values (worst profile; fast / quick / full): S1 `buried` and `grassNoSky` 0; `ymod16` p 0.156 / 0.176 / 0.0267 (df 75, no class merged); S2 1 / 0 / 1 (no stone below y 0 at all); S3 `snowAboveLine` 1, `snowNoSky` 0; B4 `snowInDesert` 0, `coastBandBeachVoxel` 0.871 / 0.868 / 0.896, `landTopsBelowSea` 0.00062 / 0.00055 / 0.00063; B2 as above; DT2's four parts 0 on every tier; the scan's top equals aux A's at every sampled position.
   - The fast-tier populations equal §5.1's pre-measured figures exactly (25,300 desert tops, 37,882 coast-band tops, 173,849 snow-line tops, 13,824 channel positions, 1,114 `ymod16` positions), and every population is ≥ 1,000 per profile on every tier.
   - The five U2 class columns are exactly §3.5's pins (the real acceptance check on the surfaced T; `snowline` after the same 8 rejections), SP3b's 16 columns are unchanged, and U2 decides all 10 `surface.*` leaves.
   - Diagnostics: `dryPitsBelowSea` 1.95-2.00 % (default) and 1.44-1.54 % (large_biomes), as §5.2 expected; patch coverage ≈ 25-32 % per (biome, patch block) where the population is large (§3.5's ≈ 29 %); `landTopYmod16` shows the density's 8-voxel cell layers, not material banding (§11).
   - Costs: the T column (`fillColumnT`, surface pass included) p50 2.2-2.4 ms against SP3b's 1.46-1.59 ms; `surfacePass` alone p50 0.73-0.75 ms, evaluating about 20 % of a column's solid voxels (the rest take the deepslate or stone band). The bench's `terrain.real` p50 2.25-2.62 ms (1.32 × SP3b's ratio before the record, exempt by design, under its 4 ms gate) and `surface.column` p50 0.75-0.83 ms (16 % of column (0, 0)'s solid voxels evaluated); every other row within its +30 % gate. No explicit uniform-section shortcut was needed (§3.4).
   - Goldens: only `generatorVersion`, `sp1.params` and `sp3a.region.T.*` change, and the two `sp3c.*` keys are added (54 entries, Bun 54/54).
   - Wall times after the optimisation (quiet machine, 20 threads): `surface.metric.ts` alone 33 s fast and 138 s full (267 s before); `npm test` 116-129 s (86 s at the tree before the surface metric: `surface.metric.ts` shares the CPUs with `terrain.metric.ts` in the metrics-fast project, which is now the long pole); `npm run test:metrics:full` 369 s (458 s before).
   - Review points shown to the user, not defects: a steep river-biome bank above water reads as a sand cliff (an 18-block one between the river and the lake of the lake slice: river positions above water take sand, [1][3][0]); packed_ice's pale blue reads close to the sky colour at a glance; the band skin is 0 … 11 voxels thick (surfaceDepth) under the red_sand top.
3. **Sampling and recording** (§5.1, §5.2). `surface.metric.ts` generates T1-T5's columns again on its own workers and analyses them there; populations are `<part>.n.<profile>`; the diagnostics gain `oceanBiomeLandTops`, `shorelineFringeSea` and `topMismatch`; `shorelineFringe` is defined with a Chebyshev distance, and `lakeRimIslets`' comparison with SP2a is indicative only.
4. **Corrections:**
   - §1: water v0 fills a per-voxel column water scratch (`columnWaterV0`) that the scan reads and the fluid channel derives from; the surface poll sits after water v0 and the biome buffer (the 7th of 31 polls);
   - §3.1: `bandlands` is refused (`NO_BAND_NOISE`) when the noise lookup has no `surface.noises.bandOffset`, and with `NOISE_DIMS` / `NOISE_REMAP` when it has one that is not dims-2 or not remap-'none';
   - §3.3, §3.4, §3.6: the band table is per SurfaceContext and passed to both evaluators; a compiled tree is bound to its scan settings;
   - §3.4: maxSurfaceDepth is −1 without depth-bounded leaves (such a tree is sky-gated); gates are read from the path `if`s; a band whose result would be a Y-only `bandlands` leaf is always evaluated; same-state bands are not merged; uniform sections come from the store's `setProto`;
   - §3.5: the land and coast columns alone leave `cliffMinY` and `bandOffset` dead (they decide the other eight by accident); `u2Leaves` defers the `surface.*` group until the class-column task; (23279, 27598) is SP2b's coast column, which the third pass never offers; the acceptance check rebuilds the column on the stage's code path (`surfaceProbeColumn`);
   - §3.6: the probe's state is air for air and water, bedrock at y −64;
   - §5.2: DT2's `surfaceReference` reads the stage's scan through the `terrainSurfaceDebug` hook, and an extra draw on a non-solid voxel is skipped; S2's "below y 0" / "above y 8" are y < 0 / y > 8;
   - §5.2: `S1.ymod16`'s merge loop is completed for a class 2 below 80 positions (where "Class 2 never merges" left it unfinished): class 2 absorbs its nearest remaining neighbours, 1, 0, 3, 4, 5+, keeping its name, and still below 80 with nothing left the table is degenerate (`test/harness/stats.ts`, pinned by `ymod16.test.ts`; inert on every measured table, where no class merged);
   - §6: a surface probe never aborts; the stale-epoch, cancel and error behaviour of the hover; the rule-id grammar; the y 62 plane kept; each SP3c site drawn whole plus a 4 px/block zoom; the badlands site scanned for the 2D biome; the `--shots` screenshot hovers the rule step's voxel;
   - §7: the `sp3c.surface.ops` value layout (0xffff where nothing is written, the fast path on, a fixture tree with a fast path); `BENCH_EXEMPT`'s parsing and print format; `surface.column`'s column;
   - §8 Replaced gains `stateLock.test.ts`, `stage.test.ts`, `region.test.ts`, the 4-thread integration, `sliceJob.test.ts`'s poll counts, the golden-count pins (`goldens.sp2a/sp3a/sp3b.test.ts`, `uiSmoke.test.ts`) and `terrainHeap.test.ts` (JIT spaces excluded);
   - §9: the `sp3c.surface.ops` bandlands case lands with `sp3cGoldens.ts`, after the bandlands task; the exit evidence goes under `## Exit evidence` before the Threshold log;
   - §5.2, §10: one Threshold-log line per commit, naming every part it adds;
   - §12 gains the §10 SP10 hand-over and the two harness files of the master's test/ entry.

## Exit evidence

Measured on the branch `sp3c/surface-rules-palette` at the end of Task 18 (2026-10-08; 12th Gen Intel(R) Core(TM) i7-12700H with 20 threads, Node v24.21.0, headless Chrome 155, Bun 1.4.2; load average 3.5 at the start of `npm test` and of the exit bench run; the Task 16 bench below ran on a quiet machine). Every metric value and golden is deterministic, so the branch's own run repeats them; only timings differ.
- `npm run build` (1.5 s, typecheck incremental), `npm test` (150 files passed, 2 skipped; 2049 tests passed, 1 expected fail, 5 skipped; 116 s wall) and `npm run test:metrics:full` (9 files, 29 tests; 388 s wall) are green with DT1, DT2 (`probeBulk`, `compiledReference`, `surfaceProbeBulk`, `surfaceReference`), S1-S3, the B4 voxel parts and the river check active, T1-T5 still passing and U2 deciding every `surface.*` leaf. `surface.metric.ts` analyses each scattered column inside its region worker (`test/harness/surfaceScatterWorker.ts`) and the main thread only sums the workers' count records, so every gated value, population and diagnostic is unchanged by the readout. `surface.metric.ts` runs beside `terrain.metric.ts` in the metrics-fast project and they share the CPUs.
- `git diff main -- test/goldens.json`:
  - `generatorVersion` 4 → 5;
  - `sp1.params` → 0ef3ba26bfc92a94 (it hashes `genKey`, so the version);
  - `sp3a.region.T.default` → 454c4d8287c4b075 and `sp3a.region.T.large_biomes` → 67936d16e11d5725 (the surface now in T);
  - added `sp3c.registry` 2ade4ab7c488e7c2 and `sp3c.surface.ops` df53f0d1115b0d39.

  Unchanged: every other `sp1.*` key, every `sp2a.*` key (no 2D retune), `sp3a.registry` and `sp3b.density.*`. The file holds 54 entries, recorded once from `main`'s file after the bandlands task.
- State ids: `test/stateIds.lock.json` appended the 22 terrain keys (ids 3 … 24) through `npm run test:accept-state-ids`; the schema lock gained the 10 `surface.*` leaves (additive, `SCHEMA_VERSION` unchanged).

Surface metrics on voxels. Each part gates the worse profile; the cells show default / large_biomes. Quick is Task 13's run of the same code (deterministic).

| part | threshold | fast | quick | full |
|---|---|---|---|---|
| S1.buried / grassNoSky | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| S1.ymod16 (p) | ≥ 0.001 | 0.868 / 0.156 | 0.176 / 0.194 | 0.0267 / 0.0965 |
| S2.deepslateBelow0 | ≥ 0.95 | 1 / 1 | 1 / 1 | 1 / 1 |
| S2.deepslateAbove8 | ≤ 0.01 | 0 / 0 | 0 / 0 | 0 / 0 |
| S2.bedrockFloor | 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| S3.snowNoSky | 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| S3.snowAboveLine | ≥ 0.9 | 1 / 1 | 1 / 1 | 1 / 1 |
| B4.snowInDesert | 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| B4.coastBandBeachVoxel | ≥ 0.7 | 0.871 / 0.919 | 0.868 / 0.917 | 0.896 / 0.928 |
| B4.landTopsBelowSea | ≤ 0.01 | 0.00062 / 0.00015 | 0.00055 / 0.00014 | 0.00063 / 0.00015 |
| B2.riverChannelWater | ≥ 0.85 | 0.930 / 0.895 | 0.921 / 0.907 | 0.925 / 0.920 |
| DT2 (all four parts) | 0 | 0 (512 voxels) | 0 (8,192) | 0 (32,768) |
| DT1.mismatches | 0 | 0 | 0 | 0 (40 regions) |

- **Populations** (default / large_biomes, every one ≥ 1,000): land tops fast 574,507 / 2,286,613, full 2,251,347 / 9,021,799; `ymod16` positions fast 1,114 / 4,975 (the default's 11 % margin, as §5.1 measured), full 4,531 / 20,225 (df 75, no class merged); snow-line tops fast 173,849 / 751,537, full 599,224 / 2,594,778; desert tops fast 25,300 / 120,139, full 157,133 / 647,918; coast-band tops fast 37,882 / 151,868, full 161,818 / 668,242; `landTopsBelowSea` positions fast 550,892 / 2,195,528, full 2,160,085 / 8,684,594; river channel positions fast 13,824 / 12,271, full 55,162 / 58,482; stone-like voxels below y 0 fast 64.0 M / 255.8 M. The scan's top equals aux A's `OCEAN_FLOOR_WG − 1` at every sampled position.
- **Diagnostics** (ungated; full, default / large_biomes): `dryPitsBelowSea` 1.95 % / 1.54 %; `lakeRimIslets` 0.026 % / 0.011 % of positions (fast 0.053 % / 0.0065 %); `shorelineFringe` 21.7 % / 34.9 % of near-shore positions (`shorelineFringeSea` 26.3 % / 37.1 %); `oceanBiomeLandTops` 0.79 % / 0.72 %; surfaceDepth 0 on 22.3 % / 22.4 % of positions (mean 2.86, SD_MAX 11 reached; accepted by the user, `depthMul` unchanged); `landTopYmod16` χ² 3,237 / 9,269 against the neighbour average (the density's 8-voxel cell layers: +7.9 % at residue 0, −9.0 % at 14 on full default; §11's SP3d/SP6 note). Patch coverage is ≈ 25-32 % per (biome, patch block) where the population is large, as §3.5 expects.
- **Unchanged from SP3b** (the surface pass never changes solidity or water): T1 band 0.239 / 0.183, span 104 / 107, above120 0.157 / 0.179, above200 0.0204 / 0.0214; T2 0.0373 / 0.0432, peaks 0.109 / 0.118; T3 lowland 1.189; T4 floorSd 5.69 / 3.19, exposedBedrock 0, deepFloor 0; T5 1 / 2 / 4 (full), equal to SP3b's exit evidence. Every 2D metric passes unchanged (no 2D change). U2 1 over 66 leaves: the five SP3c class columns are exactly §3.5's pins (`cliffY` (17107, 13836) index 53, `cliffSteep` (−24200, −4864) index 61, `snowline` (−25681, 32120) index 255 after 8 rejections, `patch` (−20548, −22882) index 11, `badlands` (−26426, −31088) index 35), SP3b's 16 columns unchanged; `noises.depth` and `depthMul` decided on land, the others on their own class column.

Bench (Task 16, this branch; quiet machine, CPU idle, own process only, load 0.13-0.43 at the runs that count; each run ≈ 31 s):
- Pre-record, `BENCH_EXEMPT=terrain.real npm run bench` against SP3b's baseline: exit 0; every pre-SP3c row within its +30 % gate (0.81 … 1.09 × its SP3b ratio); `terrain.real` printed `terrain.real: exempt, ratio 3504686 vs baseline 2689148` (1.303 ×, the surface pass, by design) at p50 2.229 ms, under its 4 ms gate; killRatio 0.847.
- `npm run bench:record` (2026-10-08, re-recorded on a quiet machine at aba2457, killRatio 0.825): `terrain.real` p50 2.269 ms (3,568,756 ns-ratio, 1.327 × SP3b's 2,689,148); `surface.column` p50 0.730 ms (column (0, 0) of seed '42': 6,912 of 42,623 solid voxels evaluated, 16 %; the rest take the fast path); `column.sample` p50 0.338 ms, equal to SP3b's baseline.
- Exit run (Task 18, load 3.5 at its start), plain `npm run bench` against the new baseline: PASS, every row within +30 %; `terrain.real` p50 2.641 ms, p99 3.744 ms; `surface.column` p50 0.838 ms, p99 0.931 ms; killRatio 0.858.

JavaScriptCore: `npx --yes bun@1 test/tools/goldensJsc.ts` → `54/54 match on Bun 1.4.2 (JavaScriptCore)` (not timed on this branch; 6.2 s in the plan's dry run).

Browser checks (`node test/tools/uiSmoke.ts --profile-dir <tmp> --shots <dir>`: its own build, `vite preview` on a free port and headless Chrome 155, 1400 × 900 at DPR 1; not timed on this branch, 49 s in the plan's dry run) → `smoke: 82/82 checks pass`:
- `?selftest=1`: `✓ all 54 goldens match` (its timing on this branch was not recorded; 6.0 s in the plan's dry run);
- the Voxels legend lists the 25 states, water and the sea line; the mountain line A (−1664, 8) → B (−640, 8) hovers sample 205's top voxel and reads "(-1254, 209, 8) · stone · no fluid · point 205, 410.8 blocks from A · rule root.rules[1].then.rules[3].then.rules[2].then.rules[1]" (a volcano stone top);
- no page error apart from the favicon.ico 404.
- Firefox (`?selftest=1` 54/54) and CI are checked after the merge.

Visual review (`docs/superpowers/specs/assets/sp3c/`; world seed '42', default profile, the surfaced T at `GENERATOR_VERSION` 5, one flat colour per block). `npm run docs:review-slices` writes the slices; `slices.json` records each line's site and summary (kinds, top kinds, tops, overhangs, water-wall faces), and a test re-derives every site's needs from the voxels:
- `slice-coast.png` (1024 × 224, y −64 … 159; x −27136 … −26113, z −31992): warm_ocean floors sand under water (551 sea positions), the stony_shore plain stone with gravel patches, a volcano/badlands needle with bare stone faces and red_sandstone under its skin, jungle grass and podzol over dirt with beach sand at its shore; deepslate below y 0 with the 1 … 7 dither, the bedrock dither at the bottom.
- `slice-lake.png` (2 px per block, y 32 … 95; x −16384 … −15873): plains and birch_forest grass over dirt, a river pool with a dirt bed and clay patches, the lake at y 82 (140 positions) with sand shallows, clay patches and gravel where deeper than 10; an 18-block sand river bank between river and lake (river biome above water takes sand).
- `slice-river.png` (2 px per block, y 32 … 127; x −15552 … −15041): savanna and birch_forest plateaus, the river's five pools with dirt beds and clay patches, sand margins, coarse_dirt patches on the savanna side.
- `slice-mountain.png` (1024 × 256, y 64 … 319; x −1664 … −641, z 8; the uiSmoke line): the badlands/volcano crest skinned with red_sand tops (519) over the seven-colour terracotta bands and red_sandstone; steep faces, overhang undersides and floating rocks bare stone (cliff branch and volcano palette).
- `slice-y62.png` (the y plane 62 of the coast's 64 × 64 columns): sand and sandstone rims outline every coast, lake beds of gravel and clay, red_sandstone and a brown_terracotta band where the badlands highland crosses y 62, and SP3b's dry hollows unchanged.
- `slice-desert.png` (1024 × 192, y −64 … 127; x 14096 … 15119, z −14328; 991 desert sand tops) and `slice-desert-zoom.png` (4 px per block, x 14480 … 14735, y 56 … 119): sand 1 … ~11 deep over a constant 4-voxel sandstone band that follows the surface, stone below; a small desert lake with sand and clay beds.
- `slice-snow.png` (1024 × 352, y −64 … 287; x −10240 … −9217, z 3080; snowy_slopes, jagged_peaks, frozen_peaks; 906 snow_block tops) and `slice-snow-zoom.png` (4 px per block, x −9472 … −9217, y 96 … 239): a 1-voxel snow_block line over every sky-open top, bare stone on steep faces and every underside, packed_ice (22 tops) on two frozen_peaks summits from the cliff branch; no grass. Packed ice's pale blue is close to the sky colour at a glance (a review point).
- `slice-badlands.png` (1024 × 256, y −64 … 191; x −1760 … −737, z 2056; 873 red_sand tops) and `slice-badlands-zoom.png` (4 px per block, x −1408 … −1153, y 48 … 127): eroded mesas with a red_sand top over horizontal terracotta strata in the seven colours (runs of 1-4 voxels at fixed y, cutting across the sloping skin, 0 … 11 voxels thick) and 4 voxels of red_sandstone, stone on the steep walls. Whether the band skin should be deeper is the user's call.
- `cross-section-voxels-mountain.png` (1400 × 900, `uiSmoke.ts --shots`): `?map` in relief with the mountain cut line and the drawer in Voxels mode (the full 25-state legend), the hover crosshair on sample 205 with the readout's rule id `root.rules[1].then.rules[3].then.rules[2].then.rules[1]`.
- The user's approval of this visual review, including the Decision 2 hand-over (above and §11), is the last exit criterion; the assets are committed and the user reviews them before the merge.

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- Task 1: `STARTED_SPS` gains `SP3c`; no threshold rows change.
- Task 10: DT2 gains `surfaceProbeBulk` (max 0) and `surfaceReference` (max 0), activeFrom `SP3c` (§5.2's exactness parts, with their code); no other row changes.
- Task 13: S1 `buried` (max 0), `grassNoSky` (max 0), `ymod16` (min 0.001); S2 `deepslateBelow0` (min 0.95), `deepslateAbove8` (max 0.01), `bedrockFloor` (min 1); S3 `snowNoSky` (max 0), `snowAboveLine` (min 0.9); B4 `snowInDesert` (max 0), `coastBandBeachVoxel` (min 0.7), `landTopsBelowSea` (max 0.01); B2 `riverChannelWater` (min 0.85, approved by the user on 2026-10-08), all activeFrom `SP3c` (§5.2's voxel parts, measured in the dry run on every tier and both profiles; no retune); no other row changes.

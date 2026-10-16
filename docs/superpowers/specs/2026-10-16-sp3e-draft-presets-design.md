# SP3e — Draft presets: amplified, archipelago and floating islands (Design)

Date: 2026-10-16
Status: Draft for the user's review. The design was approved by the user section by section on 2026-10-16 (`.superpowers/sp3e/design-brief.md`); this text adds the decisions the code survey required ("Decisions taken by this spec"), each with its alternative.
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3e (created by SP3d), whose deliverable, exit and cut line this spec sets, and the SP8b, SP11 and SP12 entries it hands work to;
- §2.4-§2.5 (the `islandMask` ColumnSample field), §3.6 (density DAG: the `islands` tap), §3.11 (surface rules), §3.15 (extreme presets), §3.16-§3.17 (consistency and determinism);
- §5.1 (parameters and stage hashes), §5.6 (map layers);
- the testing sections §6.2 (goldens per preset) and §6.4 (B1, DT2, U2, Z1-Z3) and §7 (performance budget).
Previous SP: `2026-10-09-sp3d-editable-dag-inspector-design.md` (its §13 lists what SP3d handed over: presets as overlays holding whole trees, the islands tap and `islandMask` in `COL_FIELD_BOUNDS`, amplified's multiplier and the 320 range, archipelago's B1 ocean cap, the islands surface branch, Z1-Z3 on the drafts, per-preset goldens, the column-cost maxima).

References written "master §x" point to the master spec, "SP3b §x", "SP3c §x", "SP3d §x" (and SP1, SP2a, SP2b, SP3a) to those specs, and a bare "§x" to this document. Code is cited as it is at `main` 42319a8 (`GENERATOR_VERSION` 5, `SCHEMA_VERSION` 2, `CURRENT_SP` 'SP3d'), always with its directory under `src/` or `test/`; the maps behind the citations are `.superpowers/sp3e/map-{params,column,density,surface,metrics,governance}.md`.

## Goal

Make the three draft presets real and selectable: `amplified` (the default ground with taller, rougher mountains), `archipelago` (a sea of islands) and `floating_islands` (clusters of islands floating at y 190-270 over the default ground). Each is an overlay in `PROFILES`: archipelago changes parameters and splines (the 2D map shows it); amplified and floating_islands carry whole `density.defs` and `surface.rules` trees on SP3d's editable DAG, plus, for floating islands, a real `islandMask` column field from a new 2D cluster noise and an islands term in the density. The default world does not change (`GENERATOR_VERSION` 5, the 54 golden keys byte-identical). The drafts are tuned by eye with the user, measured by Z1-Z3 as diagnostics (SP12 stays their gate), checked for exactness and sanity by gated metrics, and pinned by new per-preset goldens.

## Non-goals

- **Island-edge springs:** the decorate SP (SP8b), which the master already gives "springs, lava lakes and island-edge springs feeding settle" (master §10 SP8b) and whose fluid features and settle do not exist yet. SP3e leaves the islands term, `islandMask` and the island-run predicate (§4.1) as the data a spring placement needs (§12).
- **Final tuning and the Z1-Z3 gates:** SP12. SP3e measures Z1-Z3 and records them; their thresholds enter the table with `activeFrom: 'SP12'` (§5.3).
- **The LOD island scan:** SP11 (master §4.14, R6).
- **`cave_heavy`:** SP6 (`readyFrom: 'SP6'`, `src/core/params/profiles.ts:23`).
- **Amplifying the 2D map's offset:** amplified's amplification lives in the density tree, so the 2D map, the ColumnSample's `offset` and `surfaceEst`, the biome picker and B1 see the unamplified offset; the effect shows in the cross-section's Voxels mode, the slices and the 3D view, not in the 2D map (as SP3d's "a tree edit never changes the map", SP3d's points decided by the user, item 2).
- The `continental` profile (master §10 SP12): stays with SP12.
- How islands look in the renderer (skylight under islands, meshing of detached runs): SP4 (§12).

## Decisions confirmed by the user (2026-10-16)

All answers took the recommended option; each design section was then approved in turn (`.superpowers/sp3e/design-brief.md`).
1. **Finish level:** drafts tuned by eye. Z1-Z3 are measured and the drafts tuned in the dry run with the user's visual approval (before/after slices and Voxels shots, as SP3b's retune); Z1-Z3 are recorded as diagnostics, SP12 stays their final gate; per-preset goldens pin the drafts against silent drift.
2. **Springs:** island-edge springs are not built in SP3e; they stay with the decorate SP. The master's SP3e entry and §3.15 are amended (§13).
3. **B1 and archipelago:** B1 gets per-profile ocean-family ranges: archipelago its own (55-80 %, aligned with Z2's 60-75 %); every other B1 part applies unchanged to every preset.
4. **Metrics on presets:** a dedicated preset metric file: Z1-Z3 (diagnostics) plus a gated subset (DT2-style exactness, B1 with its per-profile range, a terrain-generates check) on every tier; T1-T5 and S1-S3 on the presets only on the full tier, as diagnostics. `npm test` grows only a little.
5. **Island cluster mask, approach B:** `islandMask` (an existing ColumnSample field, always 0 today) is computed in the column stage from a new 2D noise (λ 700) as `m = smoothstep(0.55, 0.8, u)`, u the noise's uniform value through the existing CDF, only when the preset enables it (default off → 0, goldens unchanged); the density tree reads it with `col islandMask`.
6. **Design sections approved:** the presets as overlays (brief §1), the islands mask and surface branch (§2), metrics, goldens and bench (§3), governance, cut line and exit (§4).

## Decisions taken by this spec (for the user's review)

The brief left these open, or the code survey showed the brief's literal text would not work as intended. The recommendation is the text of the section cited; the alternative is stated.
- **D1 Amplified's offset is the identity below 64** (§1.2): `offset' = offset + 0.9·max(0, offset − 64)`, the master's "`64 + 1.9·(offset − 64)` where offset > 64" (master §3.15). The brief's shorthand `64 + 1.9·max(0, offset − 64)` maps every offset ≤ 64 to 64, which would turn every ocean, beach and river into a flat plain at y 64 (`map-density.md` §4). Alternative: the brief's literal form.
- **D2 Amplified's ceiling** (§1.2): the slide knots move to 300-316 as the brief says, and the ceiling term becomes `−8·max(0, y − 300)` (today `−2·max(0, y − 296)`). With slope 2 about 1.15 % of amplified columns keep a solid voxel at y 319, i.e. mountain tops cut flat by the build limit (`map-density.md` §4: 23 of 2,000 columns); slope 8 squashes every peak into y 300-315 instead. Alternative: slope 2 and accept the cut tops.
- **D3 Islands term coefficients** (§3.1, §3.2): the term is written in the brief's form with its two coefficients explicit, `20·(NI − a·q + k·(m − 1))`, q = ((y − 230)/40)², and this spec sets **a = 3, k = 4** instead of the brief's a = 0.35, k = 1. Measured with the brief's values (`map-density.md` §5): at m = 0 the term is still positive wherever NI > 1 + 0.35q, so islands fill 9.6-17.1 % of the band in **every** column (not only in clusters), and at the band's edges (q = 1) 35-36 % of the voxels are solid, so every cluster has flat floors and ceilings cut at y 190 and 270. With a ≥ clampSigma (3) the term is ≤ 0 at q ≥ 1 for every NI and m ≤ 1, so the band window cuts nothing; with k = 4 the term is ≤ 0 wherever m ≤ 0.25, so islands exist only inside clusters and the cluster gate (§3.1) is exact at the corners. Alternative: the brief's values with the measured defects accepted for the draft (and SP12 to fix them).
- **D4 Islands term placement and gates** (§3.1, §3.4): inside an `interpolated` node (the term costs ≈ 1 % of the default's static column cost, instead of ≈ 98 % at voxel placement, and keeps `terrain.real` under its gate; `map-density.md` §2, §5), with a `rangeChoice` on `col islandMask` (≥ 0.25) and one on `y` (window [184, 273)), so columns outside clusters and cells outside the band never sample NI. Alternative: voxel placement (exact band, ≈ 10 ms per column).
- **D5 Water under floating islands** (§3.5): with the islands enabled, water v0 skips runs lying wholly above y 180 when it finds a position's `top`, so the sea under an island is filled as everywhere else. Today `top` is the highest solid voxel (`src/gen/pipeline/terrainStage.ts:82-104`), so the sea under every island over an ocean would be a dry hole to the sea floor. Off, the code path is today's. Alternative: accept the dry holes in the draft and hand them to SP12.
- **D6 The island predicate uses existing conditions** (§4.1): `yAbove{minY 181, runTop true}` then `stoneDepth{ceiling, offset 100}` (vertically detached above y 180 at this position). No new condition kind, so no change to `sp3c.surface.ops` (whose test requires the fixture to use every condition kind, `test/unit/goldens.sp3c.test.ts:119-122`), the inspector, the fuzz or the condition table. Alternative: a new exact `runBottomAbove` kind (`map-surface.md` §8 option B), with a new golden key for its coverage.
- **D7 Island tops are grass everywhere** (§4.2): the brief's "grass with dirt below by the column's biome" is read as: grass top, `dirt` under it for the position's surface depth, stone underside; the column's biome (the ground's 2D biome, `src/gen/surface/scan.ts:198-205`) shows through SP8a's grass tint, not through other blocks. The ground's biome says nothing about an island 150 blocks above it (an ocean or desert biome would give sand; the lapse rate would give snow at y 190-270 for most temperatures, `map-surface.md` §7), and Z3 asks ≥ 90 % grass tops. Alternative: snow tops for the frozen biomes (≈ 15 % of tops, Z3 ≈ 85 %).
- **D8 Archipelago's C remap reaches every C-keyed default** (§1.3): one map φ of the C axis (a shift of +0.3 for C ≥ −0.24) is applied to the offset, sigma and jag splines, `rivers.coastFadeLo/Hi`, `lakes.minC` and the C bounds of the biome boxes, so sigma, jag, valleys, lakes and beaches follow the new shoreline instead of acting in the new shallow sea (`map-params.md` §9 item 7). The brief named only C λ and the offset spline. Alternative: only the offset spline (jag up to 55 blocks and σ under the new shallow sea; beaches off the shore).
- **D9 The `islands` group is top-level and hashed by the `shape` stage** (§2.1): `params: ['shape', 'rivers', 'lakes', 'islands']`, so an edit of the mask dirties the map's `islandMask` tiles and the T stage. Alternative: `shape.islands` (no registry change, but non-spline leaves in the shape group) or under `density.` (terrain-only hash: stale map tiles).
- **D10 `islands.enabled` is a `bool` leaf** (§2.1), the schema's first: the parameter panel gains a checkbox control and U2 a bool perturbation (`map-params.md` §2). Alternative: no switch (the default would then compute a mask and move `sp2a.column.*`), or an int 0/1.
- **D11 The mask's u** (§2.2): `u = toUniform(z2)` ∈ (−1, 1), the climate convention (`src/core/noise/cdf.ts:6-8`, as master §3.15's C_u), at unscaled world block coordinates (as the density and surface noises: `climate.scaleMul` does not zoom the clusters), 2 octaves. With these, m > 0 on ≈ 22.5 % of the area and m = 1 on ≈ 10 % (measured 21.9 % and 9.7 %, `map-column.md` §2). Alternative: rivers' (u + 1)/2 convention (45 % / 20 %).
- **D12 Preset trees are derived from the default trees in code and registered at load** (§1.1), in a new core module, so `checkJson` returns them as themselves and identity holds across `resolveProfile` calls (`map-params.md` §4). Alternative: literal trees (no derivation; harder to review against the default).
- **D13 Constants, not leaves:** the preset trees' numbers (0.9, 1.6, the slide knots, the ceiling, 20, 3, 4, 230, 0.025, the windows) are tree literals, editable in the Density tab; no new `density.*` number leaves (no schema-shape, U2 or README consequences). Alternative: leaves under `density.` (ref targets for sliders).
- **D14 Goldens in a new module** (§6): `src/metrics/sp3eGoldens.ts` with `sp3e.*` keys chained last, five keys (three region hashes, and 2D column points for archipelago **and floating_islands**: the latter is the only golden that pins `islandMask`'s values). Each region window is found by a pinned search, because the SP3a window near the origin may hold no island or mountain. Alternative: extending `sp3a.region.T.<p>` and `sp2a.column.point.<p>` (moves more pins, among them `goldens.sp3a.test.ts:37`, which uses `sp3a.region.T.amplified` as its unknown key).
- **D15 B1 for amplified and floating_islands is gated by identity** (§5.4): their B1 inputs (climate, shape, rivers, lakes, biomes) equal the default's, so their B1 is the default's, already gated; a part counts presets whose inputs differ. Archipelago gets its own parts, minShare included; if the dry run measures archipelago's minShare below 0.3 % (estimated ≈ 0.26 %, `map-governance.md` §H), the spec goes back to the user.
- **D16 Z1-Z3 as threshold rows with `activeFrom: 'SP12'`** (§5.3): recorded and not gated now; they activate when SP12 starts, as master §10's DoD rule says. Alternative: unlisted extra values of a gated call (SP12 would then have to add the rows).
- **D17 The bench row runs on cluster columns** (§7): `terrain.islands`, `fillColumnT` on floating_islands at the `terrain.real` candidates whose centre has m ≥ 0.5, gated at p50 ≤ 4 ms. On `terrain.real`'s plain columns ≈ 77.5 % have m = 0 and cost the default, so the p50 would hide the term (`map-density.md` §6).
- **D18 Two harness extractions:** T1-T5's column scatter and analysis move from `test/metrics/terrain.metric.ts` to `test/harness/terrainScatter.ts`, and DT2's per-(profile, seed) checks from `test/metrics/region.metric.ts` to `test/harness/dt2.ts`, both unchanged, so the preset file reuses them without entering the `PROFILES` worst-of aggregation (`map-metrics.md` §2) and the existing outputs stay identical (§5.7).
- **D19 The default world's metric outputs are compared exactly** (§5.7, §10), as SP3d's exit did.
- **D20 The map layer is appended** after `jag` (§2.6), with the other raw ColumnSample-field layers, and the level-256 preview computes the mask too (`sampleCoarse` writes 0 today, `src/gen/column/columnPoint.ts:99`).

## Module layout after SP3e

```
src/core/ids.ts                    CURRENT_SP 'SP3e' (§11)
src/core/constants.ts              COL_FIELD_BOUNDS.islandMask [0, 1] (§2.5)
src/core/stage/registry.ts         the shape stage hashes 'islands' too (§2.1)
src/core/params/schema.ts          + the `islands` group (enabled, noise, lo, hi) and `density.noises.islands` (§2.1, §3.1)
src/core/params/defaultTrees.ts    `registeredTree` exported (§1.1)
src/core/params/presetTrees.ts     AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE, FLOATING_SURFACE_RULES: derived from the
                                   default trees, registered at load (§1.1)
src/core/params/shapeDefaults.ts   + ARCHIPELAGO_OFFSET, ARCHIPELAGO_SIGMA, ARCHIPELAGO_JAG (§1.3)
src/core/params/biomeDefaults.ts   + ARCHIPELAGO_BIOME_TABLE (§1.3)
src/core/params/profiles.ts        the three overlays (§1)
src/gen/column/islands.ts          islandMaskAt(ctx, x, z): the one mask function (§2.2)
src/gen/column/columnStage.ts, columnPoint.ts
                                   call it in the lattice, samplePoint and sampleCoarse (§2.3)
src/gen/pipeline/terrainStage.ts   water v0's `top` skips island runs when `islands.enabled` (§3.5)
src/gen/map/layers.ts              + the `islandMask` layer (§2.6)
src/ui/paramPanel/model.ts, controls.ts
                                   + the `bool` checkbox control (§2.1)
src/metrics/liveness.ts            + islandMask in the shape digest, the bool perturbation, the islands base and class column (§5.6)
src/metrics/pointDigest.ts         `pointDigest` and `pointValues`, moved unchanged from sp2aGoldens.ts (§6)
src/metrics/sp3eGoldens.ts         sp3e.* goldens (§6; added to DET_FILES in test/arch/rules/banned.ts)
src/metrics/sp2aGoldens.ts         + the SP3e key chain (§6)
test/thresholds.ts                 + DT2's preset parts, B1's archipelago parts, the Z1-Z3 rows (§5)
test/metrics/presets.metric.ts     the preset metrics (§5)
test/harness/terrainScatter.ts     T1-T5's column scatter and analysis, moved from terrain.metric.ts unchanged (D18)
test/harness/dt2.ts                DT2's per-(profile, seed) checks, moved from region.metric.ts unchanged (D18)
test/harness/reviewSlices.ts       + the preset sites (§8)
test/tools/uiSmoke.ts              + the `presets` step and the preset shots (§8)
test/bench/gates.ts, noise.bench.ts   + `terrain.islands` and its absolute gate (§7)
test/fixtures/expected-v1.json     regenerated with the new leaves at their defaults (§2.1)
docs/superpowers/specs/assets/sp3e/   review slices, Voxels shots, tuning before/after, selftest-firefox.json (§8)
```

## 1. The presets as overlays

### 1.1 Mechanics

- **Overlays.** Each preset is its `PROFILES` entry (`src/core/params/profiles.ts:17-24`): `resolveProfile(id)` = `applyPatch(SCHEMA, DEFAULTS, overlay)` (`profiles.ts:36-40`). Splines, the box table and `json` leaves are atomic (replaced whole after `checkLeaf`, `src/core/params/kit.ts:450-478`), so an overlay carries whole values. The final overlays:
  - `archipelago: { climate: { C: { wavelength: 840 } }, shape: { offset: ARCHIPELAGO_OFFSET, sigma: ARCHIPELAGO_SIGMA, jag: ARCHIPELAGO_JAG }, rivers: { coastFadeLo: 0.18, coastFadeHi: 0.28 }, lakes: { minC: 0.2 }, biomes: { table: ARCHIPELAGO_BIOME_TABLE } }`;
  - `amplified: { density: { defs: AMPLIFIED_DENSITY_TREE } }`;
  - `floating_islands: { islands: { enabled: true }, density: { defs: FLOATING_DENSITY_TREE }, surface: { rules: FLOATING_SURFACE_RULES } }`.
  `readyFrom` is already `'SP3e'` for all three (`profiles.ts:20-22`); `CURRENT_SP` → 'SP3e' makes them selectable (§11).
- **Registered trees** (D12). `defaultTrees.ts`' private `registeredTree` (`src/core/params/defaultTrees.ts:15-20`) is exported. `presetTrees.ts` builds each preset tree from the default tree by a deep JSON clone and a list of subtree replacements at JSON paths (each path must exist and name the node stated below, else module load throws), then passes the result through `registeredTree`. So `checkJson` returns the tree as itself (`src/core/params/json.ts:112`), `resolveProfile` yields the same identity on every call, the tier-2 memos hit (`src/gen/trees.ts:6-8`), and `diffParams` compares by identity (`kit.ts:487`). An unregistered literal would re-run tier 1 and give a new identity on every session commit (`map-params.md` §4).
- **Validation.** `setProfile` runs tier 2 on the preset's trees and refuses the preset if they fail (`src/engine/session.ts:246-254`); SP3d's invariant test (`validateParamTrees(resolveProfile(p))` is [] for every profile) covers the three. `reset('density.defs')`, `reset('surface.rules')` and `reset('islands')` return to the preset's values (`session.ts:267-270`).
- **Dirty stages on a profile switch** (`test/unit/profiles.test.ts:34-43` today asserts "non-empty overlay dirties all stages"; it becomes per-profile, computed from the overlay's top-level keys and the registry): archipelago (climate) dirties every stage; amplified (density only) dirties `terrain`, `decorate`, `light`, `mesh`; floating_islands (islands, density, surface) dirties every stage but `climate`.
- **Each tree keeps the default's root shape** `max(add(tap terrain, detail), tap islands)`: U2's `density.defs` variant mutes the node at `['root','a','a']` and throws unless it is the `terrain` tap (`src/metrics/liveness.ts:208-211`), and the inspector's mute under `max` writes −1e6 (`src/ui/inspector/form.ts:101`). The default trees do not change (the inspector, uiSmoke and the tests that pin `root.b` of the default keep working, `map-density.md` §3).

### 1.2 amplified

`AMPLIFIED_DENSITY_TREE` = `DEFAULT_DENSITY_TREE` (SP3d §2.1) with five replacements (paths as tier 2 prints them, `map-density.md` §3):

| path | default | amplified |
|---|---|---|
| `root.a.a.x.x.a.a.a.a.a` | `col offset` | `add(col offset, mul(const 0.9, max(const 0, add(col offset, const −64))))` |
| `root.a.a.x.x.a.a.a.a.b.a` | `col jag` | `mul(col jag, const 1.6)` |
| `root.a.a.x.x.a.a.b.a` | `col sigma` | `mul(col sigma, const 1.6)` |
| `root.a.a.x.x.a.a.b.b.knots` | `[[−64, 0], [−40, 1], [240, 1], [320, 0]]` | `[[−64, 0], [−40, 1], [300, 1], [316, 0]]` |
| `root.a.a.x.x.b.x.a.v`, `root.a.a.x.x.b.x.b.b.b.v` | 2, −296 | 8, −300 |

So `offset' = offset + 0.9·max(0, offset − 64)` (D1: the identity at offset ≤ 64, 64 + 1.9·(offset − 64) above), jag and σ ×1.6 (the multiplications in that order: IEEE products are order-sensitive), the slide fades σ over y 300-316, and the ceiling is `−8·max(0, y − 300)` (D2). Written as data (sorted keys in storage; `op` first here):
```
offset':  { "op": "add", "a": { "op": "col", "field": "offset" }, "b": { "op": "mul", "a": { "op": "const", "v": 0.9 },
            "b": { "op": "max", "a": { "op": "const", "v": 0 }, "b": { "op": "add", "a": { "op": "col", "field": "offset" }, "b": { "op": "const", "v": -64 } } } } }
jag:      { "op": "mul", "a": { "op": "col", "field": "jag" }, "b": { "op": "const", "v": 1.6 } }
sigma:    { "op": "mul", "a": { "op": "col", "field": "sigma" }, "b": { "op": "const", "v": 1.6 } }
```
- The tree has 71 nodes (60 + 7 + 2 + 2, counted as `countTreeNodes` counts, `src/core/params/json.ts:236`). The three new subtrees read only `col` and `const`, so each stays in its column slot; measured column cost 14,922,617 (1.001 × the default, 1.6 % of `DENSITY_COLUMN_COST_MAX`), work cost 665 (1.17 × the default, under the inspector's 4 × lint), tier 2 [] (`map-density.md` §2).
- **Height.** The offset spline's largest knot is 210 (`src/core/params/shapeDefaults.ts:20`), so offset' ≤ 341.4, and the jag spline's largest is 55, so 88 after ×1.6. With the slope-8 ceiling the zero of `S − y − 8(y − 300)` for a target surface S is y = (S + 2400)/9, i.e. 314.4 for S = 430 (341.4 + 88 + the detail amplitude); at y 319 the slide is 0 and the density ≤ 341.4 + 88 + 4.5 − 319 − 152 < 0. Z1 records `cappedTops` (positions with a solid voxel at y 319) and the design expects 0. Over 3,000 columns of seed 42 the amplified offset' has p99 266.7 (Z1 wants p99 land height ≥ 250; `map-density.md` §4).
- **Inside the `terrain` tap.** The amplification is inside the tap, so `surfaceEst3` (which reads the `terrain` tap, `src/gen/column/surfaceEstimate.ts:16`) finds the amplified surface; it starts from ⌊offset⌋ and steps by 8 without a step limit (`surfaceEstimate.ts:38-56`), so it reaches it, up to ≈ 15 steps farther. The 2D map, `surfaceEst`, the biome picker (offset0, `src/gen/biomes/picker.ts:27-29`) and B1 keep the unamplified offset (non-goal).
- Cost: +14 % voxel evaluations and +30 % corners in the density phase, within run noise in ms (`map-density.md` §4); `terrain.real` on amplified is measured once in the dry run and recorded, not gated (§7).

### 1.3 archipelago

Parameters and splines only; both trees are the default's. The 2D map shows the preset.

**The C map φ** (D8): φ(C) = C + 0.3 for C ≥ −0.24; below, the piecewise-linear map through (−1, −1), (−0.6, −0.45), (−0.4, −0.15), (−0.24, 0.06). Every value below is written as its literal (not computed: in doubles −0.22 + 0.3 is 0.07999999999999999).

| default | φ | used by |
|---|---|---|
| −1, −0.6, −0.4, −0.24, −0.16, −0.1, 0.05 | −1, −0.45, −0.15, 0.06, 0.14, 0.2, 0.35 | offset, sigma and jag knots |
| −0.55, −0.22, −0.1, −0.04 | −0.375, 0.08, 0.2, 0.26 | biome-box C bounds |
| −0.12, −0.02 | 0.18, 0.28 | `rivers.coastFadeLo`, `coastFadeHi` |
| −0.1 | 0.2 | `lakes.minC` |

- **`ARCHIPELAGO_OFFSET`** (in `shapeDefaults.ts`, authored with `autoTangents` and the module's `S`/`PV3` helpers like `OFFSET_DEFAULT`): C knots `[−1, 16], [−0.45, 26], [−0.15, 40], [0.06, 52], [0.14, 60], [0.2, E(−1: 70, 0: 64, 1: 63)], [0.35, E(−1: PV3(72, 96, 130), −0.4: PV3(68, 82, 100), 0.2: PV3(72, 84, 98), 1: 76)]`: the default's knots and values through φ, with the default's C 0.3 and 0.6 knots (the big-mountain E splines, up to 210) dropped. Beyond the last knot a spline holds its last value (`src/core/spline/hermite.ts:91-96`), so every C ≥ 0.35 is "near-inland" (offset ≤ 130): the brief's "only the coast and near-inland E splines". The shore (offset0 = 63) lies between C 0.14 and 0.2, so C_u < 0.2 is ocean (master §3.15), ≈ 57-60 % of the area (the default's ocean family is 44.1 % at a shore near −0.12, `map-metrics.md` §5).
- **`ARCHIPELAGO_SIGMA`**: `[−1, 3], [0.14, 3], [0.2, 1.5], [0.35, E(−1: PV(−1: 12, 1: 26), 0: 6, 1: 3)]`; **`ARCHIPELAGO_JAG`**: `[0.2, 0], [0.35, E(−1: PVJ, −0.5: PVJ, −0.4: 0)]` (the defaults through φ, `shapeDefaults.ts:23-31`).
- **`ARCHIPELAGO_BIOME_TABLE`** (in `biomeDefaults.ts`): `BIOME_TABLE_DEFAULT` with every C interval endpoint mapped by the table above (deep_ocean C [−1, −0.375], ocean [−0.375, 0.2], warm_ocean and frozen_ocean [−1, 0.2], COAST [0.08, 0.26], INLAND [0.26, 1]); E, PV, T, H, W signs and priorities unchanged. The picker's height filter (offset0 < 63) still splits sea and land (`picker.ts:27-29`); the boxes now place beaches at the new shore.
- **C wavelength** 840 (= 2400 × 0.35, today's overlay, `profiles.ts:20`; `src/core/params/schema.ts:57`). The biome-size slider zooms it as for every profile (`climate.scaleMul`, `src/gen/context.ts:65`).
- B1 and Z2 measure the result (§5.3, §5.4).

### 1.4 floating_islands

The default ground, the islands term in the density (§3), the islands' surface branch (§4), the mask switched on (§2), and water v0's island rule (§3.5). The tree's root is the default's; only `root.b.x` changes.

### 1.5 Tuning procedure

As SP3b's retune (SP3b §8.4) and the brief:
1. The dry run builds the drafts exactly as specified, renders the review slices and the Voxels shots (§8) and runs `presets.metric.ts` on the quick tier: these are the "before" set, with Z1-Z3 and the extras.
2. Any change is proposed to the user with its "after" set (slices, shots, Z values) under `assets/sp3e/tuning/`, produced by a throwaway plan tool as SP3b's (not committed tooling), and lands only with the user's approval.
3. What may move, with approval: amplified's factors (0.9, 1.6, 1.6), slide knots and ceiling; archipelago's C wavelength and the φ shift (+0.3; the table of §1.3 is then rewritten with the new literals); floating_islands' 20, a, k (the cluster gate's lower bound is then 1 − 3/k), the band centre and half-width (230, 40) with the window [184, 273) moved to the corners just outside the band, NI's wavelength, yScale and octaves, the mask's lo and hi, the noise's octaves, and the branch's minY 181, ceiling offset 100 and underside depth 2. What may not move: the gated thresholds of §5.2 and §5.4, the Z thresholds (the master's), the default world.
4. The final values are written into this spec (a "Changes made by the implementation-plan dry run" section, as SP3c and SP3d) before the goldens of §6 are recorded: a recorded `sp3e.*` key can only change with a `GENERATOR_VERSION` bump, which would also move `sp1.params` (SP3d §8).

## 2. The islands group and `islandMask`

### 2.1 Parameters

A new top-level group after `lakes` (D9), meta `{scope: 'terrain', stage: 'shape'}` (the `SHAPE` meta, `src/core/params/schema.ts:9`):

| leaf | kind | default | range | doc |
|---|---|---|---|---|
| `islands.enabled` | bool | false | | Computes the island cluster mask `islandMask` (on in floating_islands; off it is 0). |
| `islands.noise` | noise (2D, remap 'uniform') | λ 700, 2 octaves | λ [16, 8192] (`shapeNoise`, `schema.ts:18-22`) | u = U(z2) of this noise sets the mask. |
| `islands.lo` | number | 0.55 | [−1, 1], step 0.01 (`frac`) | u where `islandMask` starts to rise from 0. |
| `islands.hi` | number | 0.8 | [−1, 1], step 0.01 | u from which `islandMask` is 1. |

and under `density.noises`: `islands`, `densityNoise('Island noise', …, { wavelength: 72, octaves: 2, yScale: 2 }, 3, { min: 16, max: 8192 })` (NI: λxz 72, λy 72/2 = 36, octave λy 36 and 18 ≥ 16, the 2 × corner-step rule; `schema.ts:34-35`, `:113`). It makes `{op: 'noise', id: 'islands'}` valid in every profile's tree (`src/gen/density/source.ts:158-168`) and adds the ref target `density.noises.islands.clampSigma` (`source.ts:135-151`). `islands.*` leaves are not ref targets (prefix filter, `source.ts:144`); nothing needs them to be.

Consequences, all additive:
- **Stage registry:** the shape stage becomes `params: ['shape', 'rivers', 'lakes', 'islands']` (`src/core/stage/registry.ts:17`); `checkRegistry` then covers the group with scope 'terrain' (`registry.ts:41-66`). The live `H.shape` and everything downstream change for every world (a new prefix in the slice); no golden reads live stage hashes (`sp1.params` hashes the frozen fixture schema, `src/metrics/sp1Fixtures.ts:108-111`), so region caches miss once. No stage version bumps: no output changes for existing params.
- **Schema-shape lock:** additive, accepted with `npm run test:accept-schema` at `SCHEMA_VERSION` 2 (`test/harness/schemaShape.ts:47-55`); no migration (patches are partial, `src/core/params/migrate.ts:24,30`). As SP3d §1.11 noted, an older build importing an SP3e preset that names `islands.*` reports `UNKNOWN_KEY`, not `NEWER_SCHEMA_VERSION`.
- **Fixtures and docs:** `test/fixtures/expected-v1.json` (the full canonical params of `preset-v1.json` after import, compared by U4 and `test/unit/presetFile.test.ts:360-364`) is regenerated with the new leaves at their defaults; `preset-v1.json` stays. `npm run docs:params` regenerates the README table (a `bool` prints `true`/`false` with an empty range cell, `kit.ts:532-537`).
- **Panel:** `PANEL_KINDS` gains `'bool'` (`src/ui/paramPanel/model.ts:188`) and `createControl` a checkbox that commits on change (`src/ui/paramPanel/controls.ts:512-521` throws for it today); a new top-level section "Islands" (`test/unit/paramPanelModel.test.ts:38` pins the section list, `:301`, `:305` the kinds).
- **Noise metrics:** both noises enter `SCHEMA_NOISES` (N3, N5, N6), and `islands.noise` (remap 'uniform') also `CLIMATE_NOISES` (N1 KS and sd error, N2), automatically (`test/metrics/noise.metric.ts:27,29`); it is a standard double noise like `rivers.widthNoise`, which passes them. The noise lab lists both (`src/ui/lab/noiseLab.ts:28`).
- **Seeds:** new instances get seeds from their own paths (`src/core/params/noises.ts:15-26`); no existing noise's seed moves.
- **Leaf lists that move:** `test/unit/schemaSp3b.test.ts:12-19` (density leaves), `:43` (density noise instances), `:59-62` (remapNone list); `test/unit/paramPanelModel.test.ts:38`, `:78` (log-scale controls: noise controls are log, `model.ts:48`).

### 2.2 The mask (`src/gen/column/islands.ts`)

```
islandMaskAt(ctx, x, z):
  p = ctx.params.islands
  if (!p.enabled) return 0                          // the literal +0
  u = toUniform(N.z2(x, z))                         // N: islands.noise, prepared per GenContext; u ∈ [−uMax, uMax] ⊂ (−1, 1)
  if (p.lo < p.hi) { s = detSmoothstep(p.lo, p.hi, u); return s > 1 ? 1 : s }
  return u >= p.lo ? 1 : 0
```
- x, z are world block coordinates as the caller has them, unscaled and unwarped (D11); `N` is fetched with `noiseFor(ctx, 'islands.noise')` and cached in a `WeakMap<GenContext, NormalNoise>` (the rivers pattern, `src/gen/column/rivers.ts:91-97`); `toUniform(z) = detErf(z·√½)` (`src/core/noise/cdf.ts:6-8`); `detSmoothstep` clamps t to [0, 1] and returns t·t·(3 − 2t) (`src/core/detMath.ts:81-85`).
- **lo ≥ hi** is a legal parameter state (no cross-leaf check exists in kit) and is defined as a step at lo (rivers' `fade` guard, `rivers.ts:44-45`); unguarded, lo = hi would give 0/0 = NaN.
- **Range and sign:** t·t is +0 or positive and 3 − 2t ≥ 1, so s is +0 or positive, never −0 or negative; the explicit `s > 1 ? 1 : s` makes m ≤ 1 by construction (the rounding of t²(3 − 2t) near t = 1 is not argued anywhere). The step returns the literals 1 and 0. So m ∈ {+0} ∪ (0, 1].
- The gen hot-module rules apply (imported bindings aliased as top-level consts, no `Math.*` transcendental; `test/arch/rules/banned.ts:25-26,135-160,197`).
- **Cost** (`map-column.md` §2, measured on 2 octaves): 172 ns per point, 8.4 µs per ColumnSample (49 lattice points), 1.3 % of a 672 µs ColumnSample when enabled; off, one branch per point. The P1 column gate and `column.sample` run on `DEFAULTS` (off) and do not move.

### 2.3 Point == bulk

The three writers of `islandMask` call `islandMaskAt` instead of writing 0: the lattice loop of `buildColumnSample` (`src/gen/column/columnStage.ts:103`, x = x0 + 4i, z = z0 + 4j for the 7 × 7 quart lattice), `samplePoint` (`src/gen/column/columnPoint.ts:74`) and `sampleCoarse` (`columnPoint.ts:99`). The function depends only on (x, z) and params, with no shared mutable state, so its place in the stage's order is free and the lattice value equals `columnPoint`'s at the same integers, which DT2's batch == point test compares (`test/unit/columnStage.test.ts:25`). `buildCornerSample` copies `samplePoint`'s fields (`columnStage.ts:126-155`), so the slices' corner samples inherit it; `CORNER_FALLBACK_FIELDS` stays empty (`src/gen/inspect/fieldSlice.ts:175`). Tests: `columnStage.test.ts:16-32`, `cornerSample.test.ts:51-92` and `columnPoint.test.ts:45` gain a floating_islands case with m > 0 at some points and m = 1 at others (today they run with the mask off and would pass trivially, `map-column.md` §7). The column cache is per GenContext, i.e. per params epoch (`src/gen/column/columnCache.ts:13-37`, `src/gen/context.ts:56-71`), so toggling `enabled` never sees stale samples.

### 2.4 The default stays byte-identical

`islandMask` is hashed by `sp2a.column.point.default`, `sp2a.column.point.large_biomes` (`src/metrics/sp2aGoldens.ts:54-58`, 25 point fields) and `sp2a.column.sample` (all `SAMPLE_FIELDS`, `sp2aGoldens.ts:74-88`); no other golden reads it (`map-column.md` §6). Those profiles do not enable the mask, so the literal +0 is written as today. No field is added to `SAMPLE_FIELDS` or the hashed point list (which would move `sp2a.column.sample`), and no −0 or NaN can be written when off. The new noise instances are constructed but never sampled on the default, and seeds derive from names, so no other noise moves. The sp2a tile layers (biome, relief, rivers, C) never read the mask. The density, surface and water code paths read the mask or the switch only in floating_islands' trees and under `enabled` (§3.5). Hence the 54 keys stay byte-identical and `GENERATOR_VERSION` stays 5; the exit checks it (§10).

### 2.5 `COL_FIELD_BOUNDS`

`islandMask: bound(0, 0)` with its comment "no island term until SP3e" (`src/core/constants.ts:82-83`) becomes `bound(0, 1)`, argued in the table's header style: off +0; on, §2.2's m ∈ [0, 1] by construction; `readField`'s bilinear blend stays in the hull of its corners (`constants.ts:38-40`). The static magnitude analysis reads it (`src/gen/density/source.ts:30,53,299,414`); every preset tree passes with it (`map-density.md` §2). Tests: `test/unit/densitySource.test.ts:441-455` (today "islandMask [0, 0] never leaves", special-casing m === 0) asserts [0, 1]; `test/unit/colFieldBounds.test.ts:71-79` adds floating_islands to its sampled profiles, so the [0, 1] bound is exercised by real values.

### 2.6 The map layer

`LAYERS` gains `'islandMask'` after `'jag'` (15 ids, `src/gen/map/layers.ts:19`, D20); `layerStage` gives it `'shape'` (the default branch, `layers.ts:27-31`), so its tiles are keyed by the shape hash, which covers the `islands` group (`src/ui/map/tileSource.ts:35`); unshaded; `layerColor` maps it with `sequential(v, 0, 1)` (`src/gen/map/palette.ts:24-30`). The fine levels read `samplePoint` and the level-256 preview `sampleCoarse` (`src/gen/map/tile.ts:36-38`), which now computes the mask (§2.3), so the preview is not blank. In the default and every other preset the layer is uniformly 0. The toolbar, the URL state and the worker protocol accept the id through `isLayerId` (`src/ui/map/toolbar.ts:89-91`, `src/ui/map/mapState.ts:68`, `src/workers/protocol.ts:286`). Pins: `test/unit/tile.test.ts:55` (14 → 15), `:58`; `test/tools/mapLatency.ts:46` and its equality test `test/unit/mapLatency.test.ts:23`. `MAP_VERSION` does not change (no existing tile changes). The hover readout does not gain the field.

## 3. The islands density term

### 3.1 The tree

`FLOATING_DENSITY_TREE` = `DEFAULT_DENSITY_TREE` with `root.b.x` (the islands tap's `const −1e6`, `src/core/params/defaultTrees.ts:103`) replaced by:
```
{ "op": "interpolated", "x":
  { "op": "rangeChoice", "x": { "op": "col", "field": "islandMask" }, "lo": 0.25, "hi": 2,
    "inside": { "op": "rangeChoice", "x": { "op": "y" }, "lo": 184, "hi": 273,
      "inside": BODY,
      "outside": { "op": "const", "v": -1000000 } },
    "outside": { "op": "const", "v": -1000000 } } }

BODY = { "op": "mul", "a": { "op": "const", "v": 20 }, "b":
  { "op": "add",
    "a": { "op": "add",
      "a": { "op": "noise", "id": "islands" },
      "b": { "op": "neg", "x": { "op": "mul", "a": { "op": "const", "v": 3 }, "b":
        { "op": "square", "x": { "op": "mul", "a": { "op": "add", "a": { "op": "y" }, "b": { "op": "const", "v": -230 } },
                                             "b": { "op": "const", "v": 0.025 } } } } } },
    "b": { "op": "mul", "a": { "op": "const", "v": 4 }, "b": { "op": "add", "a": { "op": "col", "field": "islandMask" }, "b": { "op": "const", "v": -1 } } } } }
```
i.e. `islands = 20·(NI − 3·q + 4·(m − 1))` with q = ((y − 230)·0.025)² (the op set has no subtraction or division, `src/gen/density/expr.ts:57-60`; 0.025 is the double nearest 1/40, the same double `recip(const 40)` gives), on cells whose corner column has m ≥ 0.25 and whose corner y is in [184, 273) (`rangeChoice` is lo ≤ x < hi, `src/gen/density/nodes.ts:58-59`), −1e6 elsewhere. The root stays `max(add(tap terrain, detail), tap islands)`; the tap stays outside `interpolated`, so its child is a sibling of the terrain's `interpolated` (no `NESTED_INTERPOLATED`) and its mute writes −1e6 (`map-density.md` §5). The tree has 85 nodes (60 − 1 + 26). NI is `density.noises.islands` (§2.1), sampled only at the 4 × 8 × 4 corners (CELL placement inside `interpolated`); `col islandMask` is the corner column's lattice value exactly (`src/gen/density/bounds.ts:150-167`).

### 3.2 Why these coefficients and windows (D3, D4)

Let cs = NI's clampSigma (3, the default for unspecified fields, `src/core/noise/types.ts:16-24`); NI ∈ [−cs, cs] (`src/core/noise/normal.ts:12`, `:67-72`).
- **Clusters only.** At m < 0.25, 4·(m − 1) < −3, so BODY < 20·(NI − 3) ≤ 0: no island outside a cluster. The brief's k = 1 left BODY > 0 wherever NI > 1 + 0.35q at m = 0 (≈ 16 % of points at y 230; measured 9.6-17.1 % solid at y 200-250 in every column, `map-density.md` §5). The m gate at 0.25 is therefore the line where the ungated term provably stops; at a corner it changes a negative value into −1e6. Inside a cell that straddles the m = 0.25 contour the interpolation blends that −1e6 with the other corners, so a voxel the ungated term would make solid there is lost when its neighbour corner is positive (which needs NI > 3q + 4·(1 − m) at that corner). The dry run measures the loss on the Z3 columns (ungated vs gated tree) and records it in the exit evidence; a visible wall along the contour is a tuning item (§1.5).
- **The band window cuts nothing.** At q ≥ 1 (y ≤ 190 or ≥ 270), BODY ≤ 20·(cs − 3) = 0 for every m ≤ 1. The window's lowest and highest corners, y 184 (q = 1.3225) and 272 (q = 1.1025), are inside it and hold BODY ≤ 0; the corners outside (176 and 280) hold −1e6, and a cell whose corners are all ≤ 0 has no positive voxel (trilinear blends of non-positive values). So the window only skips NI where the term cannot be positive. Island voxels lie in y 185-271 (BODY > 0 needs q < 1 at some corner, i.e. a corner in 192-264, and the cells reach one corner step around them). With the brief's a = 0.35, 35-36 % of voxels were solid at y 190 and 270, cut flat by the window (`map-density.md` §5).
- **The shape.** At m = 1 a voxel is solid roughly where NI > 3q: about half the points at y 230, a quarter at q = 0.25 (y 210, 250), ≈ 4.5 % at q = 0.5625 (y 200, 260): lens-shaped islands up to ≈ 70 blocks thick, thinner and rarer towards the cluster edges (m 0.75: NI > 1 + 3q).
- **clampSigma.** Both arguments hold for cs ≤ 3. `density.noises.islands.clampSigma` is a slider (range [1, 8]); above 3 the window and the gate cut where NI > 3 (P ≤ 0.27 % per sample), as stated in the leaf's doc.

### 3.3 Interval bounds and tier 2

Tier 2 is [] for the tree (`map-density.md` §2, measured with `overhang` standing in before the `islands` noise exists, and with `islandMask` at [0, 0]; [0, 1] does not change the outcome: BODY's static interval is about ±1e2, the gates' ±1e6). Literals are within ±1e9; both `rangeChoice` have lo < hi (`RANGE_ORDER`, `expr.ts:341-344`); the static `col islandMask` interval is `COL_FIELD_BOUNDS`' [0, 1] (§2.5). At run time the bounds refine per cell: inside `interpolated` the corner hull applies (`bounds.ts:209-222`, `:278-282`), so cells whose corners are all non-positive are skipped without voxel evaluation; `rangeChoice` evaluates only its chosen branch (`src/gen/density/compile.ts:20-21`, `:304-307`), so m < 0.25 columns and out-of-band corners never sample NI. `cornerFn` evaluates every interpolated slot at a corner the terrain needs (`compile.ts:378-388`), which the gates keep cheap.

### 3.4 Cost against the bounds

Static (`src/gen/inspect/cost.ts:194-215`; each node inside `interpolated` × 1,225, each noise × 128, every `rangeChoice` branch charged): measured for this structure with the brief's coefficients, column cost 15,091,667 = 1.012 × the default and 1.6 % of `DENSITY_COLUMN_COST_MAX` (954,106,688 = 64 × the default, `src/core/constants.ts:86-91`), work cost 873 (1.53 × the default, under the inspector's 4 × lint, `src/ui/inspector/form.ts:97`, `:612-614`) (`map-density.md` §2). a and k change constants only, not the node count, so the static numbers are the same; the plan pins them. The 64 × bound is not a constraint. Real time (density phase, `map-density.md` §5, brief's coefficients): m = 0 columns at the default's cost (+0.2 ms), m = 1 columns +1.3-1.5 ms; with a = 3, k = 4 fewer cells are positive at m = 1 (about half the brief's solid volume), so the evaluated voxels can only fall. §7 gates it.

### 3.5 Water v0 under islands (D5)

`columnWaterV0` (`src/gen/pipeline/terrainStage.ts:82-104`) takes `top` = the highest solid voxel of a position and fills water at `top − 12 < y ≤ waterTop` (`WATER_DEPTH` 12, `:53`). Under an island that `top` is the island's (≥ 185), so the sea below gets no water. SP3e: **when `ctx.params.islands.enabled`**, `top` is the top voxel of the highest solid run whose bottom voxel is at y ≤ 180, so runs lying wholly above y 180 (the islands, §4.1's predicate) are skipped; when off, the code path is today's (the switch is read once per column). The probe shares `columnWaterV0`, so probe == bulk holds. The heightmaps stay the highest solid voxel (`terrainStage.ts:137-145`): `oceanFloorWG` and `worldSurfaceWG` are the island top + 1 at island positions. The sea floor under an island is not sky-open, so the surface rules give it band stone (`src/gen/surface/compile.ts:389-391`): an island's "shadow" of bare stone on the ground or the sea floor, consistent with S1's `grassNoSky` = 0 and SP3c's overhang semantics; recorded for SP12 (§12). Tests: a unit test on a floating_islands column over the sea (water under the island equals the column's water with the islands tap muted) and on a default column (unchanged).

## 4. The islands surface branch

### 4.1 The condition (D6)

"On a floating island" = the voxel's run is vertically detached above y 180 at this position, from the data the scan already has (runTop and runBottom per run, `src/gen/surface/scan.ts:65-68`; the scan reads nothing outside its column, so lateral connection cannot be known, `scan.ts:14`):
`yAbove{minY: 181, runTop: true}` then `stoneDepth{side: 'ceiling', offset: 100, addSurfaceDepth: false}`, which hold iff runTop ≥ 181 and y − runBottom ≤ 100 (`src/gen/surface/conditions.ts:33-38`, `:45-48`).
- Every island voxel passes: island runs lie in y 185-271 (§3.2), so y − runBottom ≤ 86.
- A run resting on bedrock (runBottom −63, `scan.ts:67`, `:195`) never passes at runTop ≥ 181 (y − runBottom ≥ 244), so the ground, mountains included, and islands fused with a peak keep the normal palette.
- It also passes for other detached runs above y 180 within 100 blocks of their bottom: overhang lips and the floating rocks over peaks that SP3b accepted. They get the island palette (grass top), which suits them. From SP6, ground over a cave whose ceiling is within 100 blocks below a voxel at runTop ≥ 181 would too (§12).
- Z3 and water v0 use the same notion of an island run: a run whose bottom voxel is at y ≥ 181.

### 4.2 The rules (D7)

`FLOATING_SURFACE_RULES` = `DEFAULT_SURFACE_RULES` with this branch inserted as the first child of the sky-open sequence, i.e. at `root.rules[1].then.rules[0]` (the default's five children move to indices 1-5; `root.rules[0]` bedrock and `root.rules[2]` deepslate keep their places, so U2's pinned variant path `['rules', 2, 'if']` still names the deepslate gradient, `src/metrics/liveness.ts:197-211`):
```
{ "kind": "condition", "if": { "kind": "yAbove", "minY": 181, "runTop": true },
  "then": { "kind": "condition", "if": { "kind": "stoneDepth", "side": "ceiling", "offset": 100, "addSurfaceDepth": false },
    "then": { "kind": "condition", "if": { "kind": "stoneDepth", "side": "floor", "offset": 4, "addSurfaceDepth": true },
      "then": { "kind": "sequence", "rules": [
        { "kind": "condition", "if": { "kind": "stoneDepth", "side": "floor", "offset": 0, "addSurfaceDepth": false },
          "then": { "kind": "block", "state": "grass_block" } },
        { "kind": "condition", "if": { "kind": "stoneDepth", "side": "ceiling", "offset": 2, "addSurfaceDepth": false },
          "then": { "kind": "block", "state": "stone" } },
        { "kind": "condition", "if": { "kind": "stoneDepth", "side": "floor", "offset": 0, "addSurfaceDepth": true },
          "then": { "kind": "block", "state": "dirt" } },
        { "kind": "block", "state": "stone" } ] } } } }
```
- The top voxel of an island run is grass (first, so thin islands are grass-topped too); the bottom three voxels are stone (the underside); the voxels within the position's surface depth (0-11 blocks, SP3c §3.2) below the top are dirt; the rest of the skin down to 4 + surfaceDepth is stone, and that final unconditional `stone` keeps the ground's palette (sand, sandstone, snow, cliff stone) from reaching island voxels. Deeper voxels fall through to the default's rules, all bounded at ≤ 4 + SD (nothing yields), so they are stone (`compile.ts:372`, `:403`).
- The branch has 17 nodes; the tree 180. It only yields colliding states (grass_block, stone, dirt), as tier 2's `NOT_SOLID` requires (`src/gen/surface/rules.ts:406-408`).

### 4.3 Fast path and cost

Every leaf of the branch has `skyOpen` (the enclosing `root.rules[1]`) and a `stoneDepth{floor}` gate on its path (offset 4 + SD at most), so the tree keeps a fast path, stays sky-gated and keeps `maxSurfaceDepth` = 4 + SD_MAX (`compile.ts:148-195`). DT2 (`test/metrics/region.metric.ts:291`) and U2's `maxSurfaceDepthOf` (`liveness.ts:604-607`) throw without a fast path, and the inspector would lint it (`form.ts:95`, `:609`); a leaf gated by `stoneDepth{ceiling}` alone would have broken it (`map-surface.md` §9). Rules column cost 180 × 256 × 52 = 2,396,160, 1.7 % of `RULES_COLUMN_COST_MAX` (138,870,784, `constants.ts:86-92`). A unit test asserts the fast path, `skyGated` and `maxSurfaceDepth` (as `goldens.sp3c.test.ts:136-140`), and compiled == reference on islands columns.

### 4.4 Cut line

The branch is SP3e's cut line (brief §4): without it, the islands use the default tree (the sky-open branch still gives grass tops in grass biomes, but sand over ocean, beach and desert biomes, snow wherever T_eff is below the snowline, and no stone underside, `map-surface.md` §7), and the branch goes to SP12. The decision is made when the branch's task would start; if cut, `FLOATING_SURFACE_RULES` is not built, the overlay omits `surface`, Z3's `grassTops` records what the default tree gives, and §13's amendments name SP12 as the receiver.

## 5. Metrics

### 5.1 `test/metrics/presets.metric.ts`

One file, in every metrics tier (`vitest.config.ts:5-7`), over the three presets resolved with `resolveProfile`; its own streams, so no existing stream draws differently; worker dirs `presetRegionWorker-${TIER}` (unique per file and tier, `test/harness/nodeWorker.ts:6-7`). Columns are generated with `forEachColumnThreaded` (4 region workers) from `test/harness/terrainScatter.ts` (D18). Each `metricTest` call has its own `outName` literal (`test/harness/metric.ts:122-176`). Sizes:

| quantity | fast | quick | full |
|---|---|---|---|
| DT2 preset columns per preset (seed '42') | 8 | 32 | 128 |
| B1 archipelago points (seeds 1 … k) | 40k, k 2 | 100k, k 4 | 250k, k 8 |
| Z1 columns per seed (seeds: fast/quick '42', full T1-T5's 4) | 64 | 256 | 1024 |
| Z2 raster n × n at step 64 per seed | 256 | 512 | 1024 |
| Z3 columns per seed | 64 | 256 | 1024 |

The fast tier is budgeted at ≤ 25 s wall for the file on the bench machine (the dry run measures it; if over, the diagnostic sizes shrink, never the gated parts). `metricTest` runs `run()` even for inactive parts (`metric.ts:77-99`), so the Z computations run on every tier at these sizes.

### 5.2 Gated parts (DT2, `outName: 'DT2.presets'`)

New parts of the DT2 row, activeFrom 'SP3e', max 0, all tiers, in one call `metricTest('DT2', [...], …, { outName: 'DT2.presets' })` (single coverage: the default call keeps its parts):
- `presetProbeBulk`, `presetCompiledReference`, `presetSurfaceProbeBulk`, `presetSurfaceReference`: DT2's `probeBulk`, `compiledReference`, `surfaceProbeBulk` and `surfaceReference` (`region.metric.ts:309-379`) on the presets, through the same per-(profile, seed) function (`test/harness/dt2.ts`), 16 voxels per column as DT2.
- `presetNonFinite`: non-finite compiled density values at those voxels and cell corners (the `editedDensityNonFinite` precedent, `region.metric.ts:205`, `:218`).
- `presetHeightmaps`: positions of those columns whose `worldSurfaceWG` or `oceanFloorWG` differs from a top-down scan of the generated column's blocks and fluid (the predicate of `test/unit/terrainStage.test.ts:316-330`).
Columns come from `Xoshiro128(fnv1a32('DT2.presets'))`: per preset, the first half are drawn as DT2 draws its columns; the second half are feature columns, drawn from the same stream and kept only when the column's centre block (16cx + 8, 16cz + 8) has, through `columnPoint`, offset0 ≥ 100 (amplified), offset0 within 63 ± 4 (archipelago: the shore) or islandMask ≥ 0.5 (floating_islands); at most 4096 draws per feature column, else the part fails with "no feature column". So the islands term, the amplified slide and the new shore are exercised.

### 5.3 Diagnostics Z1-Z3 (rows activeFrom 'SP12', D16)

Three new rows with the master's thresholds (master §6.4), all `activeFrom: 'SP12'` (recorded, not gated; `metric.ts:43`, `:91-97`), one call each, `outName` `Z1`, `Z2`, `Z3`:

| row | part | threshold | definition |
|---|---|---|---|
| Z1 | `overhangs` | min 0.08 | amplified: among land positions (`worldSurfaceWG === oceanFloorWG`, top = WS − 1, as T1-T5, `test/metrics/terrain.metric.ts:34-36`) of scattered columns, the share with ≥ 2 solid → air transitions at y ≥ top − 30 (T2's definition, `terrain.metric.ts:295-296`) |
| Z1 | `p99Top` | min 250 | the 99th percentile of those positions' top |
| Z2 | `oceanShare` | min 0.60, max 0.75 | archipelago: the share of raster cells with offset0 < 63 (the picker's sea class) |
| Z2 | `islandsPer100km2` | min 20 | 8-connected components of land cells (offset0 ≥ 63) whose area n_cells · 64² ≥ 10⁶ block² (1 km²), per 100 km² of raster area; components touching the raster border count when their clipped area qualifies |
| Z3 | `islandColumns` | min 0.03 | floating_islands: the share of positions holding an island run (a solid run whose bottom voxel is at y ≥ 181), over columns scattered uniformly in the 8 × 8 km window [−4096, 4096)² per seed |
| Z3 | `grassTops` | min 0.90 | among those positions whose sky-open run is an island run, the share whose top voxel is `grass_block` |

- Z1 columns: uniform chunk columns in ±1024 chunks (terrain.metric's default range, `terrain.metric.ts:73`) from `Xoshiro128(fnv1a32('Z1'))`. Extras recorded: p5/p50/p95/max top, `cappedTops` (positions with a solid voxel at y 319; expected 0, §1.2).
- Z2 raster: `waterRaster(ctx, x0, z0, n, 64)` (`src/metrics/columnStats.ts:34-61`) centred on (0, 0) (x0 = z0 = −32n), components with `test/harness/flood.ts:11-57` (as B2/B5). Extras: the island count, the largest island's area, the beach share.
- Z3 columns from `Xoshiro128(fnv1a32('Z3'))`; states read from the generated column's blocks. Extras: island runs per island position, the share of island tops above y 250 and below 200.
- B1's archipelago ocean family (§5.4) is the same sea class as Z2's `oceanShare` (the picker's height filter), measured at B1's points.

### 5.4 B1 per profile (D15)

New B1 parts, activeFrom 'SP3e', all tiers, in `metricTest('B1', [...], …, { outName: 'B1.presets' })`:
- on archipelago, computed as the default B1 call computes them (`test/metrics/biomes.metric.ts:18-28`, `src/metrics/biomeShares.ts:71-131`) at the same seeds and point counts with the archipelago ctx: `oceanFamilyArchipelago` min 0.55, max 0.80 (Decision 3); `minShareArchipelago` min 0.003; `minRareShareArchipelago` min 0.001; `largestLandArchipelago` max 0.16; `tiesArchipelago` max 0; `outsideArchipelago` max 0.02;
- `presetInputsDiffer` max 0: the number of presets among amplified and floating_islands whose `climate`, `shape`, `rivers`, `lakes` and `biomes` subtrees are not canonically equal to `DEFAULTS`'. B1 reads only those (`map-metrics.md` §5), so at 0 their B1 is the default's, gated by the existing call with the 25-45 % range.
- **Risk:** archipelago shrinks land from ≈ 56 % to ≈ 40 %, which scales every land biome's share by ≈ 0.7; the default's smallest share is 0.3675 % (`map-governance.md` §H), so `minShareArchipelago` may measure ≈ 0.26 %. If the dry run measures it below 0.3 %, the spec goes back to the user with the options (a per-profile floor such as 0.2 %, or tuning φ or the boxes); the part is not loosened silently.

### 5.5 Full tier: T1-T5 and S1-S3 on the presets

Under `if (TIER === 'full')`, record-only calls (no parts: nothing gated) `metricTest('T1', [], …, { outName: 'T1.presets' })` and likewise T2-T5 and S1-S3, over the three presets, seed '42', 4096 columns per preset in the default's range, from `Xoshiro128(fnv1a32('T1-T5.presets'))` and `fnv1a32('S1-S3.presets')`, through `terrainScatter.ts` and `surfaceScatterWorker.ts` (which takes any params, `test/harness/surfaceScatterWorker.ts:20-24`). Keys are `<part>.<preset>`; nothing enters `perProfile`'s worst-of (`terrain.metric.ts:350-354`, `surface.metric.ts:156-160`). Heightmap-based values read island tops at island positions (`terrainStage.ts:137-145`), which the record names.

### 5.6 U2

- **Bool:** `perturbations` gains `bool` (one variant: `!v`) (`src/metrics/liveness.ts:245-277` throws today).
- **Shape digest:** `hashSample('shape')` adds `f.islandMask` (`liveness.ts:307-310`). On the default base the mask is +0 in both the base and every perturbed sample, so no existing decision changes.
- **The islands base:** leaves whose path starts with `islands.` or equals `density.noises.islands` (5 leaves) are decided on `RESOLVE('floating_islands')`, seed 42, at an **island class column**: chunk columns drawn from `Xoshiro128(fnv1a32('U2.islands'))` uniform in [−2048, 2048)², the first whose 7 × 7 lattice holds an islandMask in (0, 1) and one ≥ 0.75, and on which every one of the 5 leaves changes its home-stage output (shape digest for `islands.*`, the T column's region hash for `density.noises.islands`; SP3c's acceptance rule); at most 4096 draws, else U2 fails with "no island column". The existing 21 class columns and their stream are untouched.
- U2 stays 1, over 73 leaves (68 + 5). Pins: `test/unit/liveness.test.ts:389` (density leaves 6 → 7), `:396-404` ("every density.* leaf is decided on a land or coast column": `density.noises.islands` is decided on the island column), master §6.4's "68 leaves".

### 5.7 The default world's metrics, exactly (D19)

The `.out` JSON of the quick and full tiers is compared with a run of `main` 42319a8, every `seconds` key dropped. Equal: B1, B2, B2.voxel, B4, B4.voxel, B5, M1, S1-S3, T1-T8, T1lowland, U4, DT1, and DT2 (its existing parts and populations). Expected differences, and only these: N1-N6 gain the entries of the two new noises (an aggregate over all schema noises may change only through them); `U2.leaves` gains 5 entries; the new `.out` files (`DT2.presets`, `B1.presets`, `Z1`-`Z3`, and on full `T1.presets` … `S3.presets`). This proves the extractions of D18 and the default-off paths changed nothing.

## 6. Goldens

- **New keys** in `src/metrics/sp3eGoldens.ts`, chained last in `allGoldenKeys` / `computeAnyGolden` (`src/metrics/sp2aGoldens.ts:130-140`):
  - `sp3e.region.T.amplified`, `sp3e.region.T.archipelago`, `sp3e.region.T.floating_islands`: `regionHash` (blocks, fluid, aux A, aux B; `src/metrics/region.ts:61-68`) of an 8 × 8-chunk window, seed '42', generated in process on a fresh `ArrayBuffer` store (as `regionDigest`, `src/metrics/sp3aGoldens.ts:70-84`), at the preset's window below;
  - `sp3e.column.point.archipelago`, `sp3e.column.point.floating_islands`: `pointDigest(profile)` (4096 points from `fnv1a32('sp2a.point')` over ±2^19, the 25 point fields with `islandMask`, `sp2aGoldens.ts:52-71`) on the preset. `pointDigest` and `pointValues` move unchanged to `src/metrics/pointDigest.ts` (imported by both modules; `sp2aGoldens.ts` imports `sp3eGoldens.ts` for the chain, so importing back would form a cycle).
- **Windows.** Window w(a, b) is the 8 × 8 chunks from chunk (8a − 4, 8b − 4) (w(0, 0) is SP3a's window), centre block (128a, 128b). Candidates in rings r = 0, 1, …, 64 (max(|a|, |b|) = r), within a ring by a then b ascending; the first candidate whose predicate holds, through `columnPoint` on the preset's ctx (seed '42'), is the preset's window: amplified, offset0 ≥ 150 at the centre; archipelago, among the centre and the four blocks (128a ± 60, 128b ± 60) both offset0 < 63 and offset0 ≥ 63 occur; floating_islands, islandMask ≥ 0.9 at the centre. The found (a, b) are constants of `sp3eGoldens.ts`; a unit test re-runs the search and asserts that the floating_islands window holds an island run and the amplified one a land top ≥ 200. (The SP3a window near the origin is grassland, `test/integration/region.test.ts:52-53`; with m > 0 on ≈ 22.5 % of the area it may hold no island, and amplified equals the default wherever offset ≤ 64, so the window search pins what the presets change.)
- **The tool accepts added keys at an unchanged version** (the brief's condition, verified): `mergeObservations` refuses only existing keys whose hash changed without a version increase and merges new keys at the same version (`test/harness/goldens.ts:72-97`, pinned by `test/arch/goldensMerge.test.ts:46-50`), and CI's governance requires a bump only for changed or removed base keys (`test/harness/governance.ts:46-53`). So `GENERATOR_VERSION` stays 5 and the 54 existing keys stay byte-identical.
- **When:** the keys are recorded (`npm run test:goldens`) after the user approves the tuning (§1.5), in one commit; from then on any change of a preset's generation needs a version bump (which moves `sp1.params`), so post-approval retunes are forbidden in SP3e.
- **Counts:** 54 → 59 keys. `?selftest=1` iterates `allGoldenKeys()` in one worker against the bundled `test/goldens.json` (`src/ui/selftest/selftestPage.ts:47`), uiSmoke compares with the count in `test/goldens.json` (`test/tools/uiSmoke.ts:110-123`), Bun's `test/tools/goldensJsc.ts` fails on a missing key: all 59 in Chrome, Firefox and Bun. Pins that move: `test/unit/goldens.sp2a.test.ts:10` (total), `goldens.sp3a.test.ts:34` and `goldens.sp3b.test.ts:44-45` (slice offsets), `goldens.sp3c.test.ts:53-56` (`slice(-2)` and the totals); `goldens.sp3a.test.ts:37` (`sp3a.region.T.amplified` is unknown) stays true. Header comments naming the SPs whose keys are checked: `selftestPage.ts:2`, `goldensJsc.ts:2`, `sp2aGoldens.ts:1-4`, `CLAUDE.md:28`.
- **Arch:** `sp3eGoldens.ts` and `pointDigest.ts` join `DET_FILES` (`test/arch/rules/banned.ts:18-19`) and the master's "Banned APIs" list; master §1's `metrics/*.ts` entry names `sp3eGoldens.ts` (`test/arch/masterSpec.test.ts:112-128`).

## 7. Bench

- **New row `terrain.islands`**, appended to `BENCH_ROWS` after `session.commitMaxTree` (`test/bench/gates.ts:25-31`): `fillColumnT` on the floating_islands params, with the sample count and statistic of `terrain.real` (`test/bench/noise.bench.ts:164-172`), at the `terrain.real` candidate columns ((tc·7919) mod 60000 − 30000, (tc·104729) mod 60000 − 30000), tc = 0, 1, 2, …, kept only when `columnPoint` gives islandMask ≥ 0.5 at the column's centre block (D17).
- **Gate:** absolute p50 ≤ `TERRAIN_P50_MAX_MS` (4 ms), a new field of `AbsoluteLatencies` and `absoluteGateFailures` (`gates.ts:92-115`), plus the ratio gate once recorded. Estimate: the density phase of m = 1 columns +1.3-1.5 ms over `terrain.real`'s 2.42 ms baseline with the brief's coefficients (`map-density.md` §6), less with a = 3, k = 4. **If the dry run measures p50 > 4 ms**, the spec goes back to the user with the options: bound the term (a narrower band, a higher gate, fewer NI octaves) or a preset-specific limit.
- **Pre-record run:** `npm run bench` against SP3d's baseline passes every existing row (`terrain.real` stays on `DEFAULTS`, unchanged code path); then `npm run bench:record` (it rewrites every baseline; `test/unit/benchGates.test.ts:87-107` pins the rows and requires all in `test/baselines.json`); the exit run is a plain `npm run bench`.
- **Amplified** has no row: `terrain.real` on the amplified params is measured once in the dry run and recorded in the exit evidence. Bench gates stay outside the thresholds lock (`gates.ts:1`); master §7 names the new row and gate.

## 8. Review assets and uiSmoke

- **Review slices** (`test/harness/reviewSlices.ts`): `writeReviewSlices(dir, seed, params, sites)` takes one params for all its sites (`reviewSlices.ts:382-396`), so the SP3e script calls it once per preset with that preset's params and its own sites, placed at fixed lines (the §6 windows' centres; no `ReviewKind` search, whose kinds have no island or islet, `reviewSlices.ts:27`, `:35`): `amplified-mountain` (vertical along x through the amplified window's centre, 512 blocks, y −64 … 319), `archipelago-coast` (vertical along x through its window's centre, 512 blocks, y −64 … 160), `islands-cluster` (vertical along x through its window's centre, 512 blocks, y 120 … 319). `slices.json` records each site's profile (today the literal 'default', `test/unit/reviewSlices.test.ts:370-375`). `docs:review-slices` is repointed to `docs/superpowers/specs/assets/sp3e` (`reviewSlices.test.ts:359-362`); earlier SPs' assets stay.
- **Voxels shots:** uiSmoke's `--shots` writes `preset-amplified.png`, `preset-archipelago.png` and `preset-floating_islands.png`: the cross-section's Voxels mode at each site's line, opened by URL as `mapHash({...START, profile, view})` (`test/tools/uiSmoke.ts:82`, `:912`; a ready profile is accepted, `src/ui/map/mapState.ts:59`).
- **uiSmoke step `presets`**, inserted before `console` in `SMOKE_STEPS` (`uiSmoke.ts:246-250`, pinned `test/unit/uiSmoke.test.ts:221-229`): for each preset, the page opened with that profile shows it in the profile select and no page error; amplified's Voxels summary on its line reports a ground top ≥ 250 (`src/ui/crossSection/voxels.ts:281-310`); floating_islands' reports a top ≥ 185 on its line, and its `islandMask` layer draws a tile with at least two distinct pixel colours; archipelago's `biome` layer tile at its window holds ocean and land colours. The existing `profile` step (one ArrowDown from default → large_biomes, `uiSmoke.ts:1006-1024`) is unchanged: the order of `PROFILE_IDS` puts large_biomes second (`profiles.ts:14`). The density steps keep editing the default tree's `root.b.x` (unchanged default).
- **Before/after tuning sets** (§1.5) under `assets/sp3e/tuning/`; Firefox's selftest JSON as `assets/sp3e/selftest-firefox.json`.

## 9. Tests (summary)

- **Unit, params and profiles:** the three overlays resolve and pass both tiers (SP3d's invariant over every profile); preset trees by identity across `resolveProfile` calls and equal to the default plus exactly the replacements of §1.2, §3.1 and §4.2 (a canonical diff of the trees lists exactly those paths); archipelago's splines and table equal the §1.3 values; per-profile dirty stages (`profiles.test.ts:34-43`); the `bool` leaf (validation, `randomParams`, README cell) and its panel checkbox; the schema-shape lock and `expected-v1.json`; `paramTrees.test.ts:42` (every profile's `surface.rules` is the default) becomes per-profile.
- **Unit, column and map:** `islandMaskAt` (off → +0 with `Object.is`; lo ≥ hi step; values at u = lo, hi, ±uMax; m ∈ [0, 1] over 10⁵ points; never −0); batch == point, corner samples and `columnPoint` with the mask on (§2.3); `COL_FIELD_BOUNDS` [0, 1] sampled on floating_islands (§2.5); the `islandMask` layer and the level-256 preview (§2.6).
- **Unit, density and surface:** tier 2 [] for both preset density trees and the rules tree; the static costs pinned (§1.2, §3.4); the window and gate arguments of §3.2 checked on real columns (corners at y 184 and 272 non-positive; BODY ≤ 0 at corners with m < 0.25); compiled == reference and probe == bulk on island and amplified columns; the fast path, `skyGated` and `maxSurfaceDepth` of `FLOATING_SURFACE_RULES` (§4.3); the island branch's blocks on a constructed island column (grass top, dirt, stone underside, a thin island grass-topped); water v0 under an island (§3.5).
- **Session and UI:** tests that used archipelago as the unready example switch to `cave_heavy` (`test/unit/session.test.ts:42`, `:176`, `:294`; `presetFile.test.ts:152-155`, `:258`; `mapState.test.ts:34`, `:100`); `setProfile` on each preset; `reset` of a tree returns the preset's.
- **Metrics:** §5 (DT2 preset parts and B1 archipelago parts gated on every tier; Z1-Z3 recorded; full-tier records; U2 73 leaves; the exact comparison of §5.7).
- **Goldens:** §6's pins and the window search test.
- **Arch:** `masterSpec.test.ts` gains the SP3e checks (the entry names this spec, has Deliverable, Exit and Cut line, and no "set by the SP3e spec"; an `SP3e:` list in §1's `test/` entry whose files exist; `gen/column/islands.ts`, `core/params/presetTrees.ts` and `metrics/sp3eGoldens.ts` named in §1), each landing with what it checks (§11); headers on new files; `DET_FILES`.
- **Replaced pins** (beyond those named above): `test/arch/sp.test.ts:18-21` (`STARTED_SPS`, `CURRENT_SP` 'SP3e'); `test/unit/profiles.test.ts:26-27` (ready list: every profile but cave_heavy); `test/unit/stage.test.ts` stays (versions unchanged); `schemaSp3b.test.ts:12-19`, `:43`, `:59-62`; `paramPanelModel.test.ts:38`, `:78`, `:301`, `:305`; `densitySource.test.ts:441-455`; `tile.test.ts:55`, `:58`; `liveness.test.ts:389`, `:396-404`; `reviewSlices.test.ts:359-362`, `:370-375`; `uiSmoke.test.ts:221-229`; `benchGates.test.ts:10-38`, `:87-107`.

## 10. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics green with the preset gates active: DT2's six preset parts, B1's seven new parts, U2 (1 over 73 leaves), U4, N1-N6 with the new noises, every earlier metric | `npm run build && npm test && npm run test:metrics:full` |
| the default world's metrics unchanged exactly (§5.7) on the quick and full tiers against `main` 42319a8 | a diff of the `.out` metric JSON of both runs |
| CI green | GitHub Actions |
| goldens: `GENERATOR_VERSION` 5; the 54 existing keys byte-identical; the five `sp3e.*` keys recorded after the user's tuning approval; `?selftest=1` all 59 in Chrome and Firefox; Bun all 59 | `npm run test:goldens`, `git diff main -- test/goldens.json` adds exactly the five keys, browsers, `npx --yes bun@1 test/tools/goldensJsc.ts` |
| the three presets valid and selectable: both tiers pass, fast path kept, trees by identity, `setProfile` accepts each, the select lists them | §9's tests, uiSmoke |
| Z1-Z3 recorded on every tier (diagnostics; the values in the exit evidence) | `.out/Z1.json`, `Z2.json`, `Z3.json` |
| bench: every pre-SP3e row within +30 %, `terrain.real` ≤ 4 ms p50; `terrain.islands` p50 ≤ 4 ms (or the user's decision, §7); amplified's `terrain.real` recorded | `npm run bench`, `npm run bench:record`, `npm run bench` |
| browser smoke with the `presets` step and the preset shots | `node test/tools/uiSmoke.ts --shots` |
| the three profiles selectable in production; the user's visual review approval (review slices, Voxels shots, the 2D map of archipelago and the `islandMask` layer) | screenshots and the user's check (the last criterion) |

The exit evidence goes under `## Exit evidence`, before the Threshold log, as SP3c and SP3d.

**Cut line.** The islands' own surface branch (§4.4) → SP12. Nothing else is cuttable: the mask, the islands term, the water rule, the three overlays, the metrics, the goldens and the bench row are the deliverable.

## 11. Governance

- **First commit:** `STARTED_SPS` gains `'SP3e'` (`test/harness/sp.ts:33`, append-only) and `CURRENT_SP` becomes `'SP3e'` (`src/core/ids.ts:21`; `currentSpOf` gives SP3e, `sp.ts:44-51`), so the three profiles become selectable (their overlays fill in as their tasks land; until then they resolve to the default plus archipelago's C wavelength); the pins of §9 for the SP id and the unready-profile tests move; `npm run test:accept-thresholds` (the lock's `startedSps`) and a Threshold-log line; `CLAUDE.md:9` and `README.md:9` say SP3e is in progress (the draft presets), with SP4 next.
- **Thresholds lock** (`test/thresholds.lock.json`; `test/harness/lock.ts:45-52`, an added part is TIGHTEN, `:92-93`): it changes in the first commit (`startedSps`), in the commit that adds DT2's preset parts and B1's archipelago parts (with `presets.metric.ts`), and in the commit that adds the Z1-Z3 rows. Each such commit adds one line to the Threshold log naming everything it adds, and touches this spec in the same push (`test/harness/governance.ts:54-56`).
- **Schema-shape lock:** accepted at `SCHEMA_VERSION` 2 in the commit that adds the `islands` group and `density.noises.islands` (additive), with `expected-v1.json` and the README table regenerated in the same commit. The state-id lock does not change (no new block types).
- **Goldens:** recorded once, after the user's tuning approval (§6).
- **Master amendments** land with what they describe (the arch tests check some against files): the SP3e entry's Deliverable/Exit/Cut line and its `Spec:` with the first commit; §1's file names with the files; the `SP3e:` test list and its check with the last file it names; §3.15, §6.4 and §7 at the latest in the exit commit; the cut-line receivers worded by whether §4.4's branch was built.

## 12. Notes handed to later SPs

- **SP12 (final tuning):** finalise the three presets with the Z1-Z3 gates active (their rows activate when SP12 starts); the islands coefficients and the cluster-gate contour (the dry run's measured loss, §3.2); the islands' stone "shadow" on the ground and the sea floor under them (§3.5); amplified's capped tops if any, and `surfaceEst3`'s longer climbs; archipelago's minShare and Z2; receives the islands surface branch if cut (§4.4); B1 on large_biomes and cave_heavy as their presets are finalised.
- **SP8b (decorate: island-edge springs):** the data for spring placement is in place: `islandMask` (a ColumnSample field), the island runs (a solid run with bottom ≥ 181, from the surface scan's `runTop`/`runBottom`), and water v0's island rule (water under islands is the sea's, so a spring's fall reaches it).
- **SP11 (LOD island scan, R6):** the islands term is non-positive outside y 184-272 and wherever m < 0.25 (§3.2), so a coarse 8-block scan of the `islands` tap needs only columns with m ≥ 0.25 and the corners 184 … 272; the mask is a ColumnSample field, so LOD tiles read it as any column value.
- **SP4 (renderer):** floating islands are detached solid runs over air: skylight under them (the island shadow), meshing of their undersides, and the 3D view of amplified's peaks up to y 315.
- **SP6 (caves):** the island predicate (§4.1) also holds for ground over a cave whose ceiling lies within 100 blocks below a voxel with runTop ≥ 181; SP6 must exclude cave-detached runs from the island branch (for example with an exact run-bottom condition, `map-surface.md` §8 option B) when caves reach y ≥ 181; water v0's island rule likewise reads "bottom ≥ 181".

## 13. Master-spec amendments made with this spec

Applied to the master when the user approves this spec, each in the commit §11 assigns.
- **§10 SP3e** becomes: `**SP3e — Draft presets** (M; SP3d). Spec: ` followed by the backticked file name `2026-10-16-sp3e-draft-presets-design.md` and a period (the arch check reads ``/Spec: `([^`]+)`/``):
  - draft `floating_islands`, `amplified` and `archipelago` presets on the editable DAG (terms, splines and params; the islands surface-rule branch), so per-preset goldens and SP11's LOD island scan have a target; their profiles become selectable (`readyFrom: 'SP3e'`); the `islands` group and a real `islandMask`; Z1-Z3 measured on the drafts (SP12 stays their final gate); island-edge springs stay with SP8b;
  - **Deliverable:** the three selectable draft presets;
  - Received from SP3a (its spec §10, moved from SP3d): archipelago's ocean share against B1's 45 % cap (delivered: per-profile B1 parts, archipelago 55-80 %); amplified's offset multiplier and the 320 range (delivered: in the density tree, with the slide and ceiling at 300-316);
  - **Exit:** as the SP3e spec §10;
  - **Cut line:** the islands' own surface branch (→ SP12).
- **§10 SP8b:** "springs, lava lakes and island-edge springs feeding settle" gains "(island-edge springs on SP3e's islands term, `islandMask` and island runs; SP3e spec §12)".
- **§10 SP11:** "LOD clipmap with fill mask and island terms" gains "(the islands tap is non-positive outside y 184-272 and where islandMask < 0.25; SP3e spec §12)".
- **§10 SP12:** gains "Received from SP3e (its spec §12): …" with §12's SP12 list; "goldens per preset" becomes "goldens per preset (SP3e's drafts are pinned by `sp3e.*`; finalising them bumps `GENERATOR_VERSION`)"; if the branch is cut, the receivers paragraph gains "SP3e islands surface branch → SP12".
- **§3.15:** the amplified, archipelago and floating_islands rows are written as built in SP3e: amplified `offset' = offset + 0.9·max(0, offset − 64)`, σ ×1.6, jag ×1.6, slide 300-316, ceiling `−8·max(0, y − 300)`, in `density.defs`; archipelago C λ 840, the φ remap of §1.3 (shore at C_u 0.14-0.2) on the offset, sigma and jag splines, coast fade, `lakes.minC` and the biome boxes, near-inland as the highest C knot; floating_islands `islands = 20·(NI − 3·q + 4·(m − 1))`, q = ((y − 230)/40)², NI λxz 72 λy 36 2 octaves, inside `interpolated` with the gates m ≥ 0.25 and y ∈ [184, 273), m = smoothstep(0.55, 0.8, u(λ 700)) with u the climate-style uniform at block coordinates, its own surface-rule branch (grass tops, dirt, stone undersides) and water v0 skipping island runs; "and island-edge springs" moves to SP8b. The intro's "drafted in SP3e and finalised in SP12" stays.
- **§2.4, §2.5:** `islandMask` is "0 unless `islands.enabled` (the floating_islands preset)".
- **§3.6:** "`islands` is −1e6 except in the floating_islands preset (SP3e)" gains "(SP3e spec §3)".
- **§5.6:** the map layers gain `islandMask` (shape stage).
- **§6.2:** "Goldens (region hashes per built-in preset, per stage)" gains "(SP3e: `sp3e.region.T.<preset>` and the column points of archipelago and floating_islands)".
- **§6.4:** B1's row gains "per profile: archipelago's ocean family 55-80 % with its own parts; amplified and floating_islands share the default's B1 inputs (amended by SP3e)"; DT2's row gains "SP3e: the four exactness parts, non-finite values and heightmaps on the presets (`DT2.presets`)"; U2's row ends "a `bool` leaf's perturbation is its negation; the islands leaves are decided on a floating_islands island column; U2 covers 73 leaves (amended by SP3e)"; Z1-Z3 "first measured on SP3e's drafts" gains "as threshold rows activeFrom SP12, recorded on every tier (amended by SP3e)".
- **§7:** the T-stage budget names the `terrain.islands` bench row (p50 ≤ 4 ms on cluster columns).
- **§1 (module layout):** `core/params/` adds `presetTrees.ts`; `gen/column/` adds `islands.ts`; `metrics/` adds `pointDigest.ts` and `sp3eGoldens.ts` (and the "Banned APIs" DET_FILES line both); the `test/` entry adds "SP3e: metrics/presets.metric.ts, harness/terrainScatter.ts, harness/dt2.ts".

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

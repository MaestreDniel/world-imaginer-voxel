# SP6b — Cave biomes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Underground, caves differ by where they lie: **lush** caves (moss_block floors two deep with clay patches, moss ceilings) under humid ground, **dripstone** caves (dripstone_block floors and ceilings with bare stone patches) far inland, both 26-115 blocks under the surface, and deep under mountains **the abyss**, dark layered rock all through (abyss_stone, abyss_shale, cracked_abyss_stone, single-line abyss_stone_veined) with abyss_ash floors, lit only by SP6a's light floor. Borders are wavy and speckled, never straight or on a grid. Wide caves end on a rolling rock floor of mounds and gullies, never on the flat bedrock plane (Point 2, F1). C switches the X-ray between "by cave type" and "by cave biome"; the strip no longer covers the F3 counts; the map gains a cave-biome layer at a chosen y, the Density tab a "Cave biome" slice, the Caves tab "Colour by" and a biome finder; `cave_heavy` appears in New world and the map. Cave culling hides sections no straight line of sight reaches, with nothing popping in. CI first becomes faster (R23: ≤ 5 min 30 s, then ≤ 6 min 0 s at the exit). Size XL (about 55 tasks in the spec; the user's "XL completa"); the 6 s refill target goes to SP12 and is re-measured here (the user's "A SP12, re-medir"). The generated world changes once: `GENERATOR_VERSION` 8 → 9 in the generator push (10 only after a retune the user's check asks for).

**Architecture:**
- **CI first** (D30, §13). Shards named by (file, env); T1-T5 and S1-S3 split by profile, caves by group; T1's analysis and caves' `measure` in worker threads (Tasks 2-6), before any generator change. The 19th job, `caves-biomes`, arrives with its content (Task 27).
- **Blocks** (D36, §4). Seven property-less terrain cubes, ids 58-64, flat colours, `EMIT` 0 (Task 7).
- **The picker** (D2, D3, D16, §1). `CAVE_BIOME`, `CAVE_BIOME_COLORS` and `caveKindOf` in `core/constants.ts`, every whole-byte reader masked first (Task 8); `readFieldHalo` (Task 9); `gen/biomes/caveRegistry.ts` (boxes, margin rule) and `gen/biomes/cavePicker.ts` (the per-column field pass over (16 + 2J)² positions, the ±J jitter, `caveBiomeAt`), pure and taking its values as arguments (Task 10); its per-GenContext inputs from `caves.biomes.*` arrive with the leaves (Task 17).
- **Surface rules** (D18-D21, §3). The scan's per-run `floorBiome`/`ceilBiome` (Task 11), `caveBiome{floor | ceiling | here}` (Task 12), the `strata` rule kind (Task 13), the fast path's four output-preserving extensions with their fuzz (Tasks 14-15); rule 4 at `root.rules[2]` of both built-in trees (Task 22).
- **The generator push** (D28, §14.3; Tasks 16-31): the GV8 trees' migration (`SCHEMA_VERSION` 5, Task 16); T's cave-biome step writing the `cave` byte's high nibble and aux B's `caveBiomeQ` (`GENERATOR_VERSION` 9, Task 17); the probes (Task 18); the rock floor (`floorY = caves.floor.y + caves.floor.amp·|Nf|`, g_b in every cap, S_b in `defs.steep`, σ_b in the carvers; Tasks 19-20); C7's bottom parts (Task 21); rule 4 (Task 22); B3's shares (Task 23); D25's generator checkpoint and its levers (Tasks 24-25); B3's border, abyss-rock and grid parts and the `caves-biomes` job with `cave_heavy` (Tasks 26-28); U2-U4 (Task 29); the tuning (Task 30); the record and the push (Task 31).
- **The X-ray by biome** (D7, D17, D24, D8, §7, §9.5). The mesher keys walls on the whole byte and writes the pack's `biome` bits (Task 32); `xrayBiomePalette` and `xrayColorMode` (Task 33); C, the page's mode, the strip's two legends, the HUD (Task 34); the terrain and water passes draw nothing while the X-ray is on, RegionMesh's `applyDrawRange` (Task 35); one top container for the HUD and the strip (Task 36).
- **Cave culling** (D13, D22, D23, §8). The pure walk `render/culling/caveCulling.ts` (Task 37), its triggers and `drawAll` (Task 38), the raycast reference and R3 (Task 39), D25's culling checkpoint and its lever (Tasks 40-41), RegionBatch's draw filter (Task 42), RegionMesh's region culling (Task 43).
- **UI** (D9-D11, §9). The map's `caveBiome` layer at a y (Tasks 44-45), the `biome3d` slice field and the Voxels mode (Task 46), the Caves tab (Task 47), the biome finder (Task 48).
- **Measurement.** B3, R3, C7's bottom parts, C1 on `cave_heavy`, DT2 `caveBiomeProbe`, R1 `xrayBiome`, L2 `abyssLit`; P1 with `caveBiome.column`, `cull.walk.rd12`/`rd16`, `slice.biome3d128`; L13 with culling and L14 with a biome segment, every Chrome route re-measured into `assets/sp6b/` (Tasks 49-51); the user's Firefox run (Task 52).

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24.21 (`worker_threads`), three r186 (`~0.186.1`), the tools' own Chrome over CDP, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md` (approved 2026-11-12; the binding authority, with the user's answers under Points for the user: Point 1 "XL completa (Recomendado)", so the finder, its two extra buttons, the Voxels mode's biome colours, cave culling with R3 and the raycast reference are all in scope; Point 2 "Suelo de roca (Recomendado)", the rock floor F1 (§5.2), F2 and F3 not built; Point 3 "A SP12, re-medir (Recomendado)", `xrayApplyRefillMs` re-measured in L14 and recorded, the 6 s target handed to SP12; the CI budget "5:30, luego 6:00 (Recomendado)": the work item ≤ 5 min 30 s with Stage 2 joining it if Stage 1 misses, the exit ≤ 6 min 0 s). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Recon behind the spec: `.superpowers/sp6b/recon-{obligations,gen,render,ui,tests}.md`, `review-technical.md`, `review-fidelity.md`, `builder-check.md`, `revise-notes.md` (git-ignored; the controller has them). Template: the SP6a plan.

**Plan form.** Compact, as SP4a's to SP6a's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (what it consumes and produces, with exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies (sketched only where the tests do not pin the order: the field pass's operation order, the strata table's draws, the walk's queue); the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` 441b67d (code identical to 1ac9e7b, the spec's citation base: `git diff --stat 1ac9e7b 441b67d` touches only the spec).

**Spec corrections found while planning** (numbered as the tasks cite them; each folded in by the task named, the first one when it names two; the controller rewords the spec in that task's commit, whose `git add` includes `docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`):
1. **§15's amendments are not in the master at 441b67d** (§15's intro "Applied when the user approves this spec"): the master's SP6b header still reads `**SP6b — Cave biomes** (size set by the SP6b spec; SP6a).` (`2026-09-26-architecture-design.md:1931`) and §1 still lists `culling/frustum.ts caveCulling.ts` (`:181`). Each item lands in the commit that makes it true (Global Constraints' "Master amendments by task"), as SP6a's §13 did; §14.1's "the master amendments of §15 that the first commit makes true" is item 1's header. Task 1 (§15's intro reworded).
2. **The generator checkpoint needs rule 4, B3's shares and C7's bottom parts before it** (Point 1's order puts the checkpoint before rule 4 and the metrics after it): D25 measures `terrain.real` "after the picker, rule 4 and the bottom floor exist", and B3 per window, `C7.bottomFloorSpread` and `C7.bedrockExposed`. Rule 4 (Task 22), B3's share parts (Task 23) and C7's bottom parts (Task 21) precede the checkpoint (Task 24); B3's border, abyss-rock and grid parts and the `caves-biomes` job follow it (Tasks 26-28), before the tuning. Task 24 (Point 1's list and §12.5 reworded).
3. **The migration lands first in the generator push** (Point 1 lists it after rule 4): rule 4's change to `DEFAULT_SURFACE_RULES` turns `test/unit/saves.test.ts:74-80` red (the SP5b fixture, schema 2, must load equal to `resolveProfile('default')`) until `MIGRATIONS[3]` maps the GV8 surface tree, as SP6a Task 4 Step 5 found for the density tree. At Task 16 the map sends each GV8 tree to the live built-in tree, which is still the same JSON, so no output sees it; the fixtures are exported before any tree changes. Task 16 (§14.4 reworded).
4. **The masked readers land before the nibble** (Point 1 pairs them with T's writes): with bits 4-7 set, `C7.carverReference` (max 0, gated; `test/harness/refs.ts:333-334`, `test/metrics/caves.metric.ts:365-366`) and DT2's `tagProbe` (`test/harness/dt2.ts:309-312`) fail at T's first write. `caveKindOf` and every masked reader change no output and land pre-push. Task 8 (§2.1 reworded).
5. **U2 decides every new leaf in `npm test`** (§12.7, Point 1's separate "U2 over the new leaves" task): U2 runs on every tier and fails on a dead leaf (`test/metrics/params.metric.ts:43-50`; SP6a Spec correction 4), so each leaf group's witnesses, the U2 count (`U2_LEAVES` 172, `test/unit/liveness.test.ts:52`; `expect(n).toBe(172)`, `test/arch/masterSpec.test.ts:2066`) and master §6.4's U2 row land with the leaves: 187 at Task 17 (15 `caves.biomes.*` leaves), 191 at Task 19 (`caves.noises.floor`, `caves.floor.y`, `.amp`, `.span`), 193 at Task 22 (`surface.noises.cavePatch`, `strataOffset`). Task 29 is the full-tier audit and the row's final wording. Tasks 17, 19, 22, 29 (§12.7 reworded).
6. **Fast-path extension 1's ceiling bound counts only leaves with no floor gate** (§3.5 item 1 "a leaf whose path holds `stoneDepth{ceiling, c}` is bounded by c from the run's bottom"): floating_islands' island branch holds `stoneDepth{ceiling, 100}` under `stoneDepth{floor, 4}` gates (`src/core/params/presetTrees.ts:197-204`); counting it would evaluate the bottom 100 voxels of every run there. A leaf with a `stoneDepth{floor}` gate is floor-bounded only (its floor gate already excludes every voxel beyond it); a leaf whose depth gates are all `stoneDepth{ceiling}` is ceiling-bounded. Task 14 (§3.5 reworded).
7. **`sp6a.density.ops` does not move with the floor** (§14.3 lists it as allowed: "the floor is a density term"): it hashes a fixture tree that uses `noiseScaled`, resolved for the profile's `density.noises.detail.clampSigma` (`src/metrics/sp6aGoldens.ts:5-12`), never the default tree. It is expected unchanged; a move is a bug. `sp3b.density.default` (the default tree) stays allowed. Task 17 (§14.3 reworded).
8. **`sp6bGoldens.ts` in `DET_FILES` changes two master lines §15 does not list**: master §0's "Banned APIs" `DET_FILES` parenthesis must equal `DET_FILES` (`test/arch/masterSpec.test.ts:265-267`), and §1's `metrics/*.ts` entry names each golden module (SP6a Task 3's precedent). Task 7 (§15 gains them under item 6).
9. **3 → 4 already maps SP6a's pre-R31 trees to SP6b's** (§14.4 "3 → 4 … maps SP6a's pre-R31 trees to 1ac9e7b's, and 4 → 5 then maps those to SP6b's"): `SP6A_TREE_HASHES` (and 2 → 3's `SP5C_TREE_HASHES`) map to `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE` and `FLOATING_DENSITY_TREE` by reference (`src/core/params/migrate.ts:24-28`, `:49-53`), so they reach the live (SP6b) trees in one step and 4 → 5 keeps them (no GV8 hash). The end state is the spec's; the tests assert the one step. Task 16 (§14.4 reworded).
10. **Rule 4's `stoneDepth` conditions need `addSurfaceDepth`** (§3.4 writes `stoneDepth{floor, 1}`): every kind's fields are all present (`src/gen/surface/rules.ts:2-6`, `FIELDS` `:181`); rule 4 writes `addSurfaceDepth: false` on each, as the island branch does (`presetTrees.ts:199-202`). Task 22 (§3.4 reworded).
11. **The border noises are named instances, not `deriveSeed` integers** (§1.2 "sampled with three seeds `deriveSeed(seed, 'caveBiome.C' | …)`"): a `NormalNoise` derives its octaves' seeds from (world, name) (`src/core/noise/normal.ts:21-24`); the three are `new NormalNoise(ctx.seed, 'caveBiome.C' | 'caveBiome.E' | 'caveBiome.H', params.caves.biomes.noises.border)`, z2 / `noise.clamp` clamped to [−1, 1]; the depth noise is the schema instance `caves.biomes.noises.depth`; the jitter's `hash3` seed stays `deriveSeed(seed, 'caveBiome.jitter')`. Task 17 (§1.2 reworded).
12. **"Borders" is not a panel sub-section** (§6.1's table puts `depthScale`, `borderWarp`, `depthWarp`, `edgeJitter` under "Cave biomes › Borders" while naming them `caves.biomes.depthScale` …): the panel makes a sub-section per schema group only (`src/ui/paramPanel/model.ts:85-100`). The paths stay as §1.2 and the tests name them, shown directly in the Cave biomes section after Abyss and before Noises. Task 17 (§6.1 reworded).
13. **`layerColor` cannot paint `caveBiome` from a `PointRecord` and y alone** (§9.1 "`layerColor` takes an optional y"): the border noises live in the GenContext (`cavePickerOf(ctx)`), which `layerColor(layer, p, k)` (`src/gen/map/layers.ts:52`) does not receive; the tile painter (`src/gen/map/tile.ts:117`, `:163`, which holds `ctx`) passes the picker and y. Task 44 (§9.1 reworded).
14. **`cave_heavy`'s dirty stages are not `['terrain']`** (§6.2 "Its regen scopes become ['terrain']"): an overlay under `caves` dirties terrain and every stage that reads it (`src/core/stage/registry.ts:20-23`: decorate reads terrain, light decorate, mesh light), as amplified's density overlay does (`test/unit/profiles.test.ts:42-50` computes the list through `reads`, `:55` pins amplified's `['terrain', 'decorate', 'light', 'mesh']`). `cave_heavy`'s dirty stages are `['terrain', 'decorate', 'light', 'mesh']` (its badge scope terrain). Task 1 (§6.2 reworded).
15. **The slice job copies the whole cave byte; the Voxels mode masks where it reads** (§2.1 lists `src/workers/sliceJob.ts:150`, `:203` among the masked readers): `sliceJob.ts:203` fills `SliceResult.cave`, which the Voxels mode reads (`src/ui/crossSection/voxels.ts:174`) and which must carry the nibble for the Voxels mode's biome colours (§9.2, Task 46). The copy stays unmasked; `voxels.ts:174` reads `caveRgb(caveKindOf(byte))`, and the `caves` field's codes mask where they are computed. Task 8 (§2.1 reworded).
16. **The strata draw excludes the previous layer** (§3.3 "draw a layer by weight (one `nextFloat`) … No other draw" and "veins are single lines"): with independent draws two consecutive draws of one layer merge into one longer run, so a veined run of 2 or more and a run longer than its layer's `maxLen` occur in almost every table (a simulation over 8 tables: 99 % and 100 %). With ≥ 2 layers the draw excludes the previous layer (one `nextFloat` over the remaining layers' cumulative weights; with one layer no exclusion), so "no other draw" still holds and each maximal run is one draw. The layers' run shares then follow the exclusion chain's stationary share w_i(1 − w_i)/Σ_j w_j(1 − w_j) (the abyss default ≈ 0.382, 0.286, 0.195, 0.137). Task 13 (§3.3 reworded).
17. **Stage 2 item 3's job count** (§13 "keeps the job count ≤ 20 (19 with `caves-biomes`)"): it holds only when item 1 was not taken. Counted without the merge job (it runs after metrics-quick): 18 test jobs, 21 after item 1, 22 after item 2, 21 after item 3's listed folds, each + 1 with `caves-biomes`. Item 3 folds two more small shards (named with their measured times) so the count with `caves-biomes` is ≤ 20, and a work item that stops after item 1 or 2 folds enough in that item's commit. Task 6 (§13 reworded in its docs commit; Task 58's docs commit when Task 6 never runs).
18. **A square lattice's Clark-Evans value is 2.0** (§12.2 "a lattice ≈ 2.15"): R = mean nearest-neighbour distance / (0.5/√ρ) is 2.0 for a square lattice and 2.149 for a hexagonal one. §12.2 reads "a lattice ≈ 2.0 (square) to 2.15 (hexagonal)". Task 28 (§12.2 reworded).
19. **`B3.zoneAperiodicity` measures autocorrelation, not periodicity** (§12.2 "C8's ratio at lags 256 … 16,384, the smallest; proposed ≥ 0.9"): C8's ratio at lag L is Σ|m(p) − m(p+L)| / 2f(1 − f), 1 minus the indicator's correlation at L (`test/harness/caveMetrics.ts:54`, `:1441-1457`); zones that follow climate fields of 1,600-2,400-block wavelengths (`src/core/params/schema.ts:94-98`) read about 0.2-0.4 at lag 256, so the proposed bound is expected to miss by design. §12.2 gains a periodicity form, `zonePeriodicDip` = min over L ≥ 1,024 of ratio(L) / max(ratio at lags < L) (a periodic field dips well below 1 at its period, a smooth random one rises and saturates near 1), both recorded; the gated form and its bound are the user's choice at Task 30 Step 4. Task 28 (§12.2 reworded).
20. **Rule 4 moves the rules cost model** (§3.4-§3.5 do not mention it): `rulesCost` (`src/gen/inspect/cost.ts:359-397`) bounds only floor `stoneDepth` paths and Y-only paths, so rule 4's `stoneDepth{ceiling}` leaves would cost the default tree as unbounded (about 9×) and `strata` is no leaf case there. `rulesCost` gains Tasks 14-15's classes (a ceiling bound, the non-sky floor bound, a `caveBiome`-gated leaf costed at its class's bound only, `strata` beside `block`/`bandlands`); `RULES_COLUMN_COST_MAX` stays 138,870,784, its pin reworded to "the SP6a default's 64 ×" (as `DENSITY_COLUMN_COST_MAX`) **(plan)**. Task 22 (§3.5 gains the cost line).
21. **§8.4's draw-range writers are mislabelled, and `setXray` is one** (§8.4 "`setHighWater` (`:322`, called at `:400`, `:432`, `:563` on reveals, removals and compaction) and the compaction at `:480`"): `:400` is inside `compact`, `:432` inside `grow`, `:563` the last row's release, and `:478-481` is `upload`'s first-row span raising `highWater`; a reveal writes no draw range; `setXray` (`src/render/regionMesh.ts:620-626`) touches only the X-ray arenas and must re-apply the range to the terrain arenas. Task 35 (§8.4 reworded).
22. **A section is popped at most 5 times, not 3** (§8.1 "Under the monotone rule a section has at most 3 entry faces"): a section outside the seed box that lies in S0's plane on an axis can be entered from both sides on that axis, so it collects up to 3 + (the number of axes on which it lies in S0's plane) ≤ 5 entry faces; a seed-box section is popped once. §8.2's cost estimate counts pops with this bound. Task 37 (§8.1 and §8.2 reworded).
23. **RegionMesh re-applies the draw ranges when culling changes** (§8.4 derives the range only from the span writers and the X-ray): nothing re-applies `applyDrawRange` when a walk completes, `shown` moves or `drawAll` is set, so an arena at (0, 0) would stay hidden after the camera moves or a wall is dug open. On each frame where the culler's `shown` or `drawAll` changed, RegionMesh re-runs `applyDrawRange` over its pass 0-2 arenas (no allocation). Task 43 (§8.4 reworded).
24. **The map's hover line comes from the worker** (§9.1 "The hover readout … gains the line"): `hoverPanel.ts` receives only a `ColumnPoint` from the worker's 'point' job (`src/ui/map/hoverPanel.ts:14`, `src/workers/protocol.ts:76`, `src/workers/taskHandler.ts:328-329`), and the border and depth noises live in the worker's GenContext (Spec correction 13's limit); the point job gains an optional y and replies with the cave biome and depth. Task 45 (§9.1 reworded).

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin (`SMOKE_KEYS`, `measureChrome.ts`' `ASSETS`, `READY_PROFILES`). A `.mjs` module a TS test imports gets a sibling `.d.mts`.
  - **No new dependencies** (`CLAUDE.md`'s rule; master §0's YAGNI line).
- **Layers** (`test/arch/rules/imports.ts`; no rule changes, every new module sits in an existing layer):
  - `gen/biomes/caveRegistry.ts`, `gen/biomes/cavePicker.ts` are `gen/` (value-import `core`, `gen`, `world/blocks/**`; `world/store/api.ts` type-only, `imports.ts:18`); they export functions and types only (gen exports no numeric data, `test/arch/rules/banned.ts:87-97`), so `CAVE_BIOME`, `CAVE_BIOME_COLORS` and `caveKindOf` live in `src/core/constants.ts`; every import a hot loop uses is bound to a module `const` (`banned.ts:32`, `HOT_PREFIXES`).
  - `render/culling/caveCulling.ts` is `render/` (value-imports `core`, `mesh` for `connectivityBit`; **no three import**, so Node's R3 runs it); it takes its clock as an argument.
  - `src/metrics/sp6bGoldens.ts` is `metrics/` and joins `DET_FILES` (`banned.ts:20-22`; Spec correction 8).
  - `mesh/xray.ts` reads the padded view's `cave` array, never the store; `render/xrayPalette.ts` holds `XRAY_BIOME_COLORS`/`XRAY_BIOME_LABELS`, value-imported by `ui`; no `ui` module imports `render/materials/**`.
  - `ui/world/xrayStrip.ts`, `ui/map/cavesTab.ts`, `ui/map/toolbar.ts`, `ui/map/hoverPanel.ts`: text through `textContent` only (`test/arch/uiText.test.ts`), no browser dialogs (`test/arch/uiDialogs.test.ts`).
  - Test harness modules (`test/harness/cull.ts`, `refs.ts`' `raycastVisible`) import `src/` freely.
- **Pure and deterministic generator.** `core/`, `world/`, `gen/` and `DET_FILES` use no `Math.random`, `Date.now`, `performance.now`, `console.*` (`banned.ts:8`, `:192-193`); `gen/` and `core/` use only `MATH_ALLOWED` (abs, floor, ceil, round, trunc, sign, min, max, imul, clz32, sqrt and the constants), never `**`; every sine and cosine is `detSin`/`detCos`; every RNG is `Xoshiro128` seeded from `deriveSeed` (`src/core/rng.ts:17`, `src/core/hash.ts:262`); every per-position value is computed in world coordinates in one fixed operation order, so two columns compute the same doubles for one position (`src/gen/column/columnStage.ts:1-4`). The jitter uses `hash3` (`src/core/hash.ts:32`) with `>>> 0`.
- **The generated world: one output-changing push** (spec §14.3, D28; the table under "The generator push").
  - **Pre-push** (Tasks 1-15; base 441b67d): no generated output changes; each task runs `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`, except Task 7, which adds `sp6b.registry` (63 keys) and changes no other key. The controller pushes at will; **Task 15 ends with the controller's push, whose head is `<push base>`**, the base of the generator push's golden diff (CI's `before`, `.github/workflows/ci.yml:69`).
  - **The generator push** (Tasks 16-31): `GENERATOR_VERSION` 8 → 9 and the terrain stage's version 4 → 5 (`src/core/stage/registry.ts:20`) in Task 17, its first output-changing commit. Every commit of the push that touches `gen/`, `core/params/`, `world/store/`, `workers/`, `metrics/` or `test/goldens.json` runs `git checkout <push base> -- test/goldens.json && npm run test:goldens`, then `git diff <push base> -- test/goldens.json`, which lists only `generatorVersion` and §14.3's allowed keys: `sp1.params`; `sp3a.region.T.default`, `sp3a.region.T.large_biomes`; `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`; `sp6a.region.T.caves`; `sp3c.surface.ops`; `sp3b.density.default`; and the added `sp6b.caveBiome.points` (Task 17), `sp6b.region.T.biomes` (Task 31). **Expected unchanged:** every `sp2a.*`, `sp1.*` but params, `sp3e.column.point.*`, `sp3b.density.ops`, `sp3a.registry`, `sp3c.registry`, `sp6a.carver.paths`, `sp6a.density.ops` (Spec correction 7), `sp6b.registry`. Task 16 shows an empty diff. A key outside the list is a bug: find it, never re-record past it.
  - **After the push** (Tasks 32-60): no generated output changes; each task runs `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`; pushed at will. A retune after the user's check is a second push (`GENERATOR_VERSION` 10) recorded from its own base with the same allowed keys.
  - **The key count** 62 → 63 (Task 7) → 64 (Task 17) → 65 (Task 31), each change moving the tests that pin the key list by count and negative slices (`test/unit/goldens.sp2a.test.ts:10`, `goldens.sp3a.test.ts:34`, `goldens.sp3b.test.ts:46-47`, `goldens.sp3c.test.ts:49-56`, `goldens.sp3e.test.ts:47-56`, `goldens.sp6a.test.ts:46-52`; the new `test/unit/goldens.sp6b.test.ts`), followed by `?selftest=1` (the smoke counts from `goldens.json`) and `npx --yes bun@1 test/tools/goldensJsc.ts` at the push's record.
- **Saved worlds** (§14.4, D29). `SCHEMA_VERSION` 4 → 5 with `MIGRATIONS[3]` (Task 16); `test/schema-shape.lock.json` accepted with `npm run test:accept-schema` in Task 16 and in every task that adds a leaf or moves a leaf default (17, 19, 22, 25's output-changing levers, 30); `wi10` and the diff format unchanged (the cave channel is never persisted); `test/stateIds.lock.json` appended once (Task 7, `npm run test:accept-state-ids`).
  - **U4's fixtures.** `test/fixtures/expected-v1.json` … `expected-v4.json` hold the full imported params (`test/metrics/params.metric.ts:24-30`); every task that adds a leaf, moves a default or changes a built-in tree regenerates them from `importPreset(preset-v{v}).params` (canonical) and stages them: Tasks 16 (adds v4), 17, 19, 22, 25's output-changing levers, 30.
  - **Mirrors of the defaults.** A task that moves a cave default or a tree literal also updates, by explicit path: `npm run docs:params` (README); `test/harness/carverParams.ts` when a carver or floor default moves (pinned equal to `carverParamsOf(DEFAULTS)`); master §3.6's table and its pin (`test/arch/masterSpec.test.ts:2073`'s pattern, cross-checked against `DEFAULTS.caves`); U4's fixtures; the schema lock.
  - **The default tree's cost and count pins.** Every task that changes `DEFAULT_DENSITY_TREE` (19, and a floor lever) recomputes in the same commit `test/unit/inspectCost.test.ts`, `test/unit/sliceCost.test.ts`, `test/unit/presetTrees.test.ts` and `test/unit/defaultTrees.test.ts`'s node-count and cost literals; `DENSITY_COLUMN_COST_MAX` stays `64 × 14,907,917`. Task 22, which changes `DEFAULT_SURFACE_RULES`, moves the rule tree's pins by its own list (Spec correction 20); `RULES_COLUMN_COST_MAX` stays 138,870,784.
  - **The floor against C1, C4 and C5 before the levers** (`npm test` runs `metrics-fast` with C1-C9 gated, `package.json:16`): if `C1`, `C4.bands` or `C5.thinnest` misses on fast or quick at Tasks 19-22, that task applies Task 25c's levers in order (`caves.floor.y` −58 → −60 → −62, then `caves.floor.span` 8 → 4) with the mirrors, re-measured on quick, recorded in that commit's Exit evidence (carried into Task 24's table), in that task's commit. A miss after them is a **STOP** for the user; never a bound change.
- **Governance.**
  - `test/thresholds.lock.json` changes only through `npm run test:accept-thresholds`, in Task 1 (`startedSps`), Task 18 (`DT2.caveBiomeProbe`), Task 20 (`C7.bottomPlane`), Task 21 (`C7.bedrockExposed`), Task 27 (`C1.caveHeavyMin`/`Max` at `activeFrom: 'SP12'`), Task 30 (every tuning part), Task 32 (`R1.xrayBiome`), Task 39 (`R3.wronglyCulled`, `R3.popIn`), Task 40 (`R3.culledUnderground`), Task 50 (L13's and L14's new parts) and a conditional lever the user's decision changes; each such commit adds one line to the SP6b spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`); `<date>` below stands for that commit's date. No gate is loosened without the user's decision recorded in that line.
  - `test/bench/gates.ts` changes by spec amendment only (`gates.ts:1`): `SLICE_BIOME3D_P50_MAX_MS` 300 (Task 46, §9.2); the T gates 13 / 20 and 14.5 / 26.5 stay (D27). `test/baselines.json` (not a lock) is re-recorded in Tasks 24, 31, 40 and 46, each after a `BENCH_EXEMPT` run of the rows that rise by design; a new row is inserted in `BENCH_ROWS` where `noise.bench.ts` measures it (`benchGates.test.ts`' order pins follow).
  - `CURRENT_SP` 'SP6b' and `STARTED_SPS` gaining 'SP6b' land in Task 1, which flips every "cave_heavy is not ready" test (§14.1's list).
  - Master amendments are pinned in a new `describe('master spec amendments (SP6b §15)')` in `test/arch/masterSpec.test.ts`, created by Task 1, with a header-comment paragraph (MST:104-149's pattern), an `SP6B_MODULES: Array<[head: RegExp, token: string, file: string]>` table checked by "§1 names each SP6b module in its entry, which exists" (MST:2173-2196's pattern, first row in Task 10), and, in Task 54, the completeness test reading the spec between "## 15. Master-spec amendments made with this spec" and "## 16. Notes handed to later SPs" (MST:2474-2496's pattern). The pins that read text SP6b rewords move out of the SP6a describe into SP6b's in the task that rewords it: MST:1926 (Task 1), :1927 and :1931-1932 (Task 59 Step 0), :1957-1959 (Task 59 Step 0), :1983 (Task 43), :1984 (Task 17), :1991 (Task 12), :1992 (Task 22), :1993 (Task 7), :1995 (Task 17), :2007-2017 (Task 59 Step 0), :2066's U2 count (Task 17), :2101-2103 and :2111 (Task 20: rewritten with g_b, S_b and `defs.steep`, still cross-checked against `DEFAULTS.caves`), :2127 (Task 17), :2295-2297 (Task 39). MST:1949-1950, :1963-1965 and :2000 stay.
- **Master amendments by task** (§15's items; each pinned in the SP6b describe by the task that lands it, its test title naming "§15 item n"): Task 1: item 1's header; Task 7: items 7 and 13, Spec correction 8's two lines; Task 10: item 6's `gen/biomes/` token; Task 12: item 12's `caveBiome` and `secondaryDepthRange` halves; Task 13: item 12's `strata` half; Task 17: items 8 (cave byte, aux B), 9, 10, 11, 18's §5.4, and §6.4's U2 row (count 187); Task 18: item 20's DT2 part; Task 19: the U2 count 191; Task 20: item 15; Task 22: item 12's order, rule 4 and "As built", the U2 count 193; Task 29: item 20's U2 row as built; Task 30: items 5, 14, 20's B3, C1, C7, C6 and S2 parts; Task 32: item 16's mesher half, item 20's R1 part; Task 33: item 16's material half; Task 34: item 18's §5.9; Task 35: item 16's terrain-pass half; Task 37: item 6's `render/culling/` token; Task 39: items 6's test entry, 19, 20's R3 row (`wronglyCulled`, `popIn`); Task 40: item 20's R3 row gains `culledUnderground`; Task 43: items 8's meta line, 17; Task 45: item 18's §5.6; Task 46: item 18's §5.5; Task 53: items 2, 3, 21 and item 17's measured cost; Task 54: the completeness test, item 4's Default receivers entries in their pre-exit form; Task 59 Step 0 (its own commit, before Task 58's measured runs): items 1 (contents, Received lines as delivered, Exit, Cut line) and 4 as delivered.
- **Zero allocation** (SP4b D25): the frame step at rest allocates nothing with culling on and walking (the walk, the filter and `applyDrawRange` write preallocated arrays only), and a C press writes one uniform and two `hidden` flags; pinned in `test/unit/zeroAlloc.test.ts` (`unit (heavy)`), under the 256 B-per-tick budget (`:1047`'s pattern) and 256 KB per 10,000 calls (`:1101`'s pattern) (Tasks 34, 42).
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit. Tasks touching `gen/`, `workers/`, `world/store/` or `sim/` also run `npm run test:goldens` and state the golden diff they must show.
- **The throttled machine** (R18, D33). The laptop thermally throttles: a local test that fails only by timing out and passes when run alone counts as green; CI is the authority for golden equality. `metricTest`'s timeout is scaled by `METRICS_TIMEOUT_SCALE` (default 1, Task 1); the full-tier steps run `METRICS_TIMEOUT_SCALE=3 npm run test:metrics:full` with C7 (`caves.metric.ts`), DT1 (`region.metric.ts`), S1 (`surface.metric.ts`) and T1 (`terrain.metric.ts`) one at a time.
- **CI time budget** (§13, D30; against SP6a's exit run 42769333417 at 9:01 and the later 8:10-8:31, wall ≈ 0:20 + the longest job, ±45 % between runs on one `src/**`):
  - **the work item first** (Tasks 2-6, after Task 1 and before any generator change): Stage 1's levers L1-L6, **no sample reductions** (ruling R23); **≤ 5 min 30 s wall in two consecutive green cold-cache runs**; if missed, Stage 2's items join the work item in order (Task 6), each pushed and measured, until two consecutive cold runs read ≤ 5:30 or the list is exhausted, then the measured wall is recorded and the work goes on;
  - SP6b's own additions (estimates): T +5-15 % on every terrain-generating job; B3 +5-10 % of `terrain-default`; the border and bottom parts +5-15 s per region; the 19th job `caves-biomes` about 3:10-4:00 cold (Task 27); unit +20-40 s, slow files into `unit (heavy)` (`.github/scripts/unitShards.mjs`) by the tasks that create them;
  - **the exit: ≤ 6 min 0 s on the last two cold runs before the docs-only exit commit** (Task 58), Stage 2's items not yet taken joining in order if missed; the docs-only path grows by the unit additions only; every measured run's job table, with a warm re-run beside each cold one, goes into Exit evidence. A cold run is one whose region caches miss (`ci.yml:128`, `:161`: keyed on `src/**`, `test/harness/**`, the lockfile and the shard); the job log names the miss.
- **GPU measurements** (§12.6):
  - **Chrome cells** are an agent's, through `npm run measure:chrome -- --route bench|flight|enter --gpu iris [--workers 4]`, on a cold driver shader cache (`MESA_SHADER_CACHE_DISABLE=true` in the tool's own Chrome's env only), **only under PRIME on-demand, on the laptop panel eDP-1 at 240 Hz, the session unlocked (`loginctl show-session "$XDG_SESSION_ID" -p LockedHint` reads `LockedHint=no`), the 1-minute load below 1**. Only the user switches PRIME or displays.
  - **Firefox runs** are the user's, by hand, on the controller's `vite preview` on **port 4173** (reserved for it): the selftest (65/65, "IndexedDB contract: 10/10 passed") and a Firefox bench file (`?bench=medium`, L13 and L14 included; recorded, not gated).
- **Where the plan stops for the user** (each marked **STOP** in its task): Task 24 (the GPU conditions before its Chrome step; a miss after Task 25's levers); Task 25 (the B3 window gate's form, after its levers); Task 30 (a master bound or a proposed bound missed after the levers and the tuning: the user's bound with a Threshold-log line); Task 41 (`R3.culledUnderground` still below 0.5 after the frustum lever); Task 50 (the GPU conditions); Task 51 (before each lever's measurement; a gate still missed, `cullMainMaxMs` above 1.5 included: the user's bound); Task 52 (the user's Firefox selftest and bench file on 4173); Task 58 (the exit's 6:00 missed after Stage 2); Task 60 (the go-ahead to merge; the GPU conditions for the agent's headful Chrome production check; the user's Firefox production steps; the user's check). The controller never switches PRIME and never runs the user's check for the user.
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and preview an agent serves runs on its own free port (**never 5183**, the user's compose service; **never 4190 or 4211**; **never 4173**, reserved for the controller's Firefox preview) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never touch `~/.cache/mesa_shader_cache`, `~/.nv` or the user's own browsers; no `xdotool` or any desktop input; never change PRIME or displays.
- **Outward-facing actions.** Pushing is the controller's call (Task 15's push is the generator push's base; Task 31 pushes the generator push; others at will). Merging to `main`, pushing `main` and the production check happen in Task 60, after the user's go-ahead. Read-only git otherwise; never rewrite history (`git checkout <base> -- test/goldens.json` restores one file in the working tree). `.superpowers/` is never committed.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.
- **Styling deferred.** Colours are chosen only so the biomes can be told apart (spec Non-goals); no layout or styling work beyond what the tests need (the top container of Task 36 is a fix, not styling).
- **The cut line** (§17; the user took Point 1 "XL completa", so every item is built unless the controller cuts one when time runs short). Items are cut whole and in order, each before its first task starts, recorded in Exit evidence and worded by Task 54 (Default receivers) and Task 59 Step 0 (the SP6b entry's Cut line): item 1 skips Task 48 and Task 47's "Show cave biomes on the map" and "Cave biome parameters" buttons (Task 55 drops "Nearest lush cave"); item 2 skips Tasks 44-45 (Review Focus 5's y-field case stays on Task 34's toolbar input; Task 55 drops the layer check; `review-map-cave-biome.png` not taken); item 3 skips Task 46, so Task 47's "Cave slice" opens `caves` in both modes (Task 55 drops its biome3d check; `review-slice-biome3d.png` not taken); item 4 drops only Task 43's region culling (`setCuller` and the arena rule): its master §2.3 meta line, §4.15 (worded without RegionMesh's arenas), `section.ts` comment and pins still land in Task 43's commit. Nothing outside §17's four items is cut.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways a user of SP6b would see biomes disagree, caves vanish or pop in, or lose work, most likely first; each names the test that pins it and the task that owns it.

1. **A live cave-biome Apply racing the X-ray in biome mode and the culling walk.** X-ray on in biome mode, the map side by side, `caves.biomes.lush.hMin` 0.4 → 0.2 released (the Apply regenerates every loaded column from T, ~8 s), C pressed mid-refill, X off and on, then the camera walking underground. A person expects each column's X-ray colours to change whole with its swap, the mode to stay as set, no culling while the X-ray is on, and no hole when it turns off. Task 34 pins in `worldPage.test.ts`: "X on in biome mode, an Apply of `caves.biomes.lush.hMin` 0.4 → 0.2 settling over 30 fake frames with C at frame 5 and X twice at frames 10 and 11: the strip ends '· by cave type', `xrayColorMode` is 0 and `xrayOn` 1 at the end, the uniform written once per C, every column's shown seq is the Apply's"; Task 42 pins in `regionGrid.test.ts`: "X on: 12 swaps (an Apply's) over 30 frames start no walk, the terrain batches' multi-draw counts stay 0 and the X-ray batches' lists are three's own; X off at frame 20: `drawAll` is set until the first walk that started after it completes, the filtered list equals the unfiltered one meanwhile, and after it no section the walk stamped is dropped".
2. **A GV8 saved world with edits in columns whose floor F1 closes.** A world saved in SP6a (schema 4, the GV8 default tree) whose diff digs air at y −60 where F1 now leaves rock and places stone in a cave above the floor. A person expects the world to open with the floor and the cave biomes (the older-generator badge), the dug voxel air, the placed stone where it was, and neither a moss skin nor an X-ray wall on the edited voxels. Task 20 pins in `test/integration/caveSavedWorld.test.ts`: "a GV8 world record (`schemaVersion: 4`, `density.defs` and `surface.rules` the GV8 trees from `test/fixtures/gv8-*-trees.json`, a `ColumnDiffV1` digging (x, −60, z) where today's T leaves rock under the floor and placing stone at a cave voxel above it) opened through `openPersistWorld`: both trees are today's (`toBe`); `olderGenerator` true; the dug voxel reads air with cave byte 0 and the placed stone keeps its column's byte; `meshXray` emits no wall toward the dug voxel"; Task 22 extends it: "the placed stone keeps its state (rule 4 never runs on a published edit)".
3. **Culling with the camera above or below the section range, or teleported by a review link.** Flight to y 400, down to y 300, then a review link's `?at=` 20,000 blocks away with RD 12 streaming in. A person expects nothing missing at any moment: everything drawn while the eye is outside −64 … 319 or outside the last walk's box, columns streaming in drawn, and culling resuming once a walk around the new place completes. Task 38 pins in `caveCulling.test.ts`: "eye y 400: `drawAll` and no walk; eye y 300: a walk starts and `drawAll` clears when it completes; a jump of 20,000 blocks: `drawAll` at once, every unrevealed column within RD walked as open (0x7FFF), revealed columns drawn until a walk that saw them completes, `drawAll` cleared only by a walk seeded around the new section"; Task 39 adds the pose paths "flight at y 300 → 400 → 300" and "a teleport" to `R3.popIn` (max 0).
4. **Biome borders at chunk and region borders while streaming.** Two columns generated in different jobs, threads or regions, one of them alone after a teleport, sharing a speckled border at x ≡ 0 (mod 16) and at a region border x ≡ 0 (mod 512). A person expects no seam: the speckle crosses the chunk line as anywhere else. Task 9 pins `readFieldHalo`'s bit equality between neighbours; Task 17 pins in `terrainStage.test.ts`: "with `edgeJitter` 4, the columns (31, 0) and (32, 0) generated alone (`isolatedColumn`) and inside one region give the same nibbles and `caveBiomeQ`, and the nibble at every tagged voxel of the 8 blocks either side of x = 512 equals `caveBiomeAt` at it"; `B3.borderLattice` (Task 26) measures it over regions.
5. **C and the legend with the map side by side at narrow widths.** The map split at 1280 × 720 (a 640 px host), F3 on, the X-ray on in biome mode, the caveBiome layer's y number field focused. A person expects C typed in the field to type nothing into the world and not switch the X-ray, and the strip, its five-entry legend and the HUD never to overlap. Task 34 pins in `worldPage.test.ts`: "with the map split and the caveBiome y field focused (owner map, `ownerOf`), C is neither acted on nor prevented (`input.ts:132`)"; Task 36 pins in `worldTop.test.ts` (new) the container's flex rules; Task 55's smoke checks the HUD and strip rects disjoint at 1400 × 900 full screen, 1920 × 1080 and 1280 × 720 side by side, F3 and the X-ray on, both modes.

## Branch

Task 1 creates `sp6b/cave-biomes` from `main` 441b67d: `git switch main && git switch -c sp6b/cave-biomes`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP6b; `cave_heavy` ready; `METRICS_TIMEOUT_SCALE`; the SP6b describe | §14.1, §15 item 1, D33, Spec correction 1 |
| 2 | CI I: shards by (file, env); L1-L4 | §13, D30 |
| 3 | CI II: L5, T1's analysis in the region workers | §13 |
| 4 | CI III: L6, caves' `measure` and `referenceCarve` in worker threads | §13 |
| 5 | CI IV: two cold runs against 5:30; the evidence | §13 |
| 6 | CI V (conditional): Stage 2 in order | §13 |
| 7 | The seven blocks; `sp6b.registry` | §4, D36, §14.3, Spec correction 8 |
| 8 | `CAVE_BIOME`, `caveKindOf` and the masked readers | §1.1, §2.1, Spec correction 4 |
| 9 | `readFieldHalo` | §1.2 |
| 10 | The pure picker: `caveRegistry.ts`, `cavePicker.ts` | §1.2-§1.5, D2, D3, D16 |
| 11 | The scan's per-run cave biomes | §3.1, D18 |
| 12 | The `caveBiome` condition | §3.2, D18 |
| 13 | The `strata` rule kind | §3.3, D19 |
| 14 | Fast path I: ceiling-bounded leaves, per-class bounds | §3.5, D20, Spec correction 6 |
| 15 | Fast path II: the biome-gated skip, the `here` classification; the push base | §3.5, D20 |
| 16 | D29: `SCHEMA_VERSION` 5 and the GV8 trees' migration | §14.4, D29, Spec corrections 3, 9 |
| 17 | T writes the cave biome: the `caves.biomes.*` leaves, the nibble, `caveBiomeQ` (GENERATOR_VERSION 9) | §1, §2.1-§2.2, §6.1, D17, Spec corrections 5, 7, 11, 12 |
| 18 | Probes: `caveBiomeAt`, the surface probe; DT2 `caveBiomeProbe` | §2.3, §12.5 |
| 19 | The floor I: `floorY`, g_b, S_b in `defs.steep` | §5.2, D6 |
| 20 | The floor II: σ_b; `C7.bottomPlane` gated, `bedrockExposed` recorded | §5.2, §12.3 |
| 21 | C7's bottom parts; `bedrockExposed` gated; the `bottomCavern` pose | §12.3, D26 |
| 22 | Rule 4 in the built-in trees; `cavePatch`, `strataOffset` | §3.4, D21, Spec correction 10 |
| 23 | B3 I: shares per 8 × 8 km window | §12.1, D26 |
| 24 | D25's generator checkpoint; `caveBiome.column` | §12.5, D25, Spec correction 2 |
| 25 | Levers I (conditional): the generator checkpoint's | §12.5, §10, §3.5 |
| 26 | B3 II: border parts on `caves` and `caves-presets` | §12.2 |
| 27 | B3 III: the `caves-biomes` job; the biome region; `cave_heavy`'s C1, C2, C9 | §12.2-§12.3, §13 |
| 28 | B3 IV: `abyssRockStraight`, the regular-grid check, recorded shares; L2 `abyssLit` | §12.1-§12.3 |
| 29 | U2-U4 over the new leaves | §12.7, Spec correction 5 |
| 30 | Tuning: the dry run, the rows at their bounds, `cave_heavy`'s cheese offset | §6.2, §12, D26 |
| 31 | The generator push: `sp6b.region.T.biomes`, the bench record, the push, CI | §14.3, §12.5 |
| 32 | X-ray I: the mesher's biome bits; `R1.xrayBiome` | §7.1, D17 |
| 33 | X-ray II: the material's colour mode | §7.2 |
| 34 | X-ray III: C, the page's mode, the strip, the HUD, the notices | §7.3, §9.4, D7 |
| 35 | The terrain passes draw nothing under the X-ray; `applyDrawRange` | §7.4, D24, §8.4 |
| 36 | The strip and the F3 HUD in one top container | §9.5, D8 |
| 37 | Culling I: the pure walk | §8.1-§8.2, D22 |
| 38 | Culling II: triggers, `drawAll`, slices | §8.2 |
| 39 | Culling III: the raycast reference; `R3.wronglyCulled`, `R3.popIn` | §12.4 |
| 40 | D25's culling checkpoint; `cull.walk`; `R3.culledUnderground` | §12.5, D25 |
| 41 | Levers II (conditional): the frustum restriction | §12.5 |
| 42 | Culling IV: RegionBatch's draw filter | §8.3 |
| 43 | Culling V: RegionMesh's region culling; master §4.15 | §8.4, D23 |
| 44 | Map I: the `caveBiome` layer in the tile job | §9.1, D9, Spec correction 13 |
| 45 | Map II: `caveY` in the hash, the y control, the hover line | §9.1 |
| 46 | The `biome3d` slice field; the Voxels mode by biome; `slice.biome3d128` | §9.2, D10 |
| 47 | The Caves tab: Colour by, Cave slice by mode, the two links | §9.3, D11 |
| 48 | The biome finder | §9.3, D11 |
| 49 | Bench legs: L13 with culling, L14's biome segment; `measureChrome` → `assets/sp6b` | §12.6, D31, D35 |
| 50 | GPU cells (Chrome, agent): every route into `assets/sp6b`; the new parts gated | §12.6, §8.5 |
| 51 | Levers III (conditional): the Chrome gates | §12.6 |
| 52 | The user's Firefox run | §12.6 |
| 53 | Master pins I: §7, §8 risk 3, the "Received from SP6b" lines | §15 items 2, 3, 17, 21 |
| 54 | Master pins II: the completeness test; the obligations audit | §15, §19 |
| 55 | Smoke: the `caves` step for SP6b | §12.8 |
| 56 | Review links and screenshots | §12.8, D14 |
| 57 | Whole-branch review | §10, §18 |
| 58 | CI at the exit (conditional Stage 2) | §13 |
| 59 | Exit: evidence and docs | §18, Exit evidence |
| 60 | Merge, production check, the user's check, SP6b complete | §12.8, §18 |

The order de-risks early: governance; CI before anything heavier lands (Tasks 2-6); the blocks, the masked readers, the halo read, the pure picker, the rule engine's new condition and kind and the fast path as code no built-in tree uses yet (Tasks 7-15, pushed at will). Then the generator push: the migration, T's writes and the probes, the floor, C7's bottom parts, rule 4 and B3's shares, the checkpoint before anything is built on them, then the rest of B3, U2, the tuning and the record (Tasks 16-31). Then the X-ray by biome and the overlap, cave culling with its own checkpoint, the UI, the Chrome legs, the docs and the checks.

### The generator push (spec §14.3, D28)

| span | tasks | base | `GENERATOR_VERSION` | output-changing commits | goldens against the base |
|---|---|---|---|---|---|
| pre-push | 1-15 | 441b67d | 8 | none | `sp6b.registry` added (Task 7, 63 keys) |
| the generator push | 16-31 | `<push base>` (Task 15's pushed head) | 9 (Task 17) | 17, 19, 20, 22, 25's output-changing levers, 30 | `generatorVersion`, `sp1.params`, `sp3a.region.T.default`, `.large_biomes`, `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`, `sp6a.region.T.caves`, `sp3c.surface.ops`, `sp3b.density.default`; `sp6b.caveBiome.points` (Task 17), `sp6b.region.T.biomes` (Task 31) added (65 keys) |
| after | 32-60 | the push's head | 9 | none (a retune after the user's check: a second push, 10) | none |

### Where each new leaf lands (Spec correction 5)

| task | leaves (§6.1) | read by | U2 decides it on |
|---|---|---|---|
| 17 | `caves.biomes.lush.hMin`, `.depthMin`, `.depthMax`; `caves.biomes.dripstone.cMin`, `.depthMin`, `.depthMax`; `caves.biomes.abyss.eMax`, `.cMin`, `.depthMin`; `caves.biomes.depthScale`, `.borderWarp`, `.depthWarp`, `.edgeJitter`; `caves.biomes.noises.border`, `.depth` | `cavePickerOf(ctx)` → T's cave-biome step | a bounded biome witness (columns whose cave air holds each biome, found by a scan, as SP6a's class columns) |
| 19 | `caves.noises.floor` (end of `caves.noises`), `caves.floor.y`, `.amp`, `.span` (a `floor` sub-group after `caves.noises`) | the tree's `floorY`, g_b, S_b; the carvers' σ_b (Task 20) | the default class column at the bottom |
| 22 | `surface.noises.cavePatch`, `surface.noises.strataOffset` | rule 4's `noiseThreshold`s and `strata` | a biome witness |

The `caves` group's order after Task 22 (§6.1): Cheese … Ravines, Limits, Cave noises (`floor` last), Floor, Cave biomes (Lush, Dripstone, Abyss, then `depthScale`, `borderWarp`, `depthWarp`, `edgeJitter`, then Noises). Task 17 appends `biomes` after `noises`; Task 19 inserts `floor` between them (the `biomes` draws of `randomParams` shift once; whatever pins them re-records in Task 19).

### The cave biomes (spec §1.1, D7)

| id | biome | box (defaults, §1.3) | X-ray and map colour | X-ray legend |
|---|---|---|---|---|
| 0 | plain | none of the boxes | `#6f86a6` | Plain cave |
| 1 | lush | H′ ≥ 0.4, 0.2 ≤ depth ≤ 0.9; margin H′ − 0.4 | `#4dff7a` | Lush |
| 2 | dripstone | C′ ≥ 0.6, 0.2 ≤ depth ≤ 0.9; margin C′ − 0.6 | `#ffb347` | Dripstone |
| 3 | abyss | E′ ≤ −0.5, C′ > −0.1, depth ≥ 1.0; margin min(−0.5 − E′, C′ + 0.1) | `#b05cff` | Abyss |
| 4-15 | reserved | — | — | — |
| (15 in the pack's kind) | the surface film | — | `#c8c8c8` | Surface |

---

### Task 1: Governance: start SP6b; `cave_heavy` ready; `METRICS_TIMEOUT_SCALE`; the SP6b describe

**Files:**
- Modify: `src/core/ids.ts` (the comment `:20-24` gains "SP6b (cave biomes) started on 2026-11-12 and is the current SP (SP6b spec §14.1)."; `CURRENT_SP` `:27` → `'SP6b'`); `test/harness/sp.ts:38` (`STARTED_SPS` appends `'SP6b'`); `src/core/params/profiles.ts:38` (`cave_heavy.overlay` = `{ caves: { cheese: { offset: 0.43 }, entrances: { offset: 0.3 }, noodles: { maxY: 96 }, worms: { chance: 0.225 }, undergroundWorms: { chance: 0.105 }, ravines: { chance: 0.0225 } } }`, `readyFrom` stays `'SP6b'`; §6.2); `test/harness/metric.ts:81` (`timeoutMs = 600_000` scaled: the registered timeout is `timeoutMs * scale`, `scale` = `Number(process.env.METRICS_TIMEOUT_SCALE ?? 1)`, a positive finite number or a thrown Error naming the variable **(plan)**); `test/metrics/caves.metric.ts:673`, `:681` (their explicit `900_000` go through the same scale); `CLAUDE.md` and `README.md` (status lines: "SP6a … complete. SP6b (cave biomes: the cave-biome picker, rule 4, the rock floor, the X-ray by biome, cave culling) is in progress"); the SP6b spec (Spec corrections 1, 14)
- Modify (pins, §14.1's list; the grep `cave_heavy` over `test/` finds any other):
  - `test/arch/sp.test.ts` (started list ends `'SP6a', 'SP6b'`; `CURRENT_SP` `'SP6b'`)
  - `test/unit/profiles.test.ts:29-34` (ready), `:55` (`cave_heavy`'s dirty stages `['terrain', 'decorate', 'light', 'mesh']`, as amplified's; Spec correction 14)
  - `test/unit/toolbar.test.ts:27-28`
  - `test/unit/session.test.ts:44`, `:228`, `:246-248`, `:346`
  - `test/unit/mapState.test.ts:35`, `:101`
  - `test/unit/uiSmoke.test.ts:605`
  - `test/unit/presetFile.test.ts:152`, `:166-167`, `:258`
  - `test/tools/uiSmoke.ts:354` (`READY_PROFILES` gains `'cave_heavy'`)
  - `test/unit/metric.test.ts` (a `METRICS_TIMEOUT_SCALE` case)
  - `test/arch/masterSpec.test.ts` (new describe; MST:1926 moved)
  - `test/thresholds.lock.json` (generated)
  - master §10's SP6b header (`:1931`)

**Interfaces:**
- Consumes: `isProfileReady` (`src/core/params/profiles.ts:42-44`), `metricTest` (`test/harness/metric.ts:77-83`).
- Produces: `CURRENT_SP === 'SP6b'`; `isProfileReady('cave_heavy')` true; `resolveProfile('cave_heavy').caves.cheese.offset === 0.43`; the describe `'master spec amendments (SP6b §15)'` with its header-comment paragraph.

- [ ] **Step 0:** `git switch main && git switch -c sp6b/cave-biomes`.
- [ ] **Step 1: Write the tests.**
  - `sp.test.ts`: "SP6b has started and is the current SP (SP6b spec §14.1)"; `currentSpOf(STARTED_SPS)` is `'SP6b'`.
  - `profiles.test.ts`: "cave_heavy is ready from SP6b with §6.2's overlay": the six overlay values above; its dirty stages `['terrain', 'decorate', 'light', 'mesh']` (badge scope terrain; the computed list through `reads` and the table at `:55` agree); `isProfileReady('cave_heavy', 'SP6a')` false.
  - The flipped pins assert "ready" (toolbar and New world list `cave_heavy`; the session and the map hash accept it; a preset file of profile `cave_heavy` imports).
  - `metric.test.ts`: "METRICS_TIMEOUT_SCALE multiplies metricTest's timeout": with the variable at 3 a fake `register` receives 1,800,000 for the default and 2,700,000 for an explicit 900,000; unset, 600,000; `'0'` and `'x'` throw.
  - The SP6b describe, test "§10's SP6b header names the size and the spec (SP6b spec §15 item 1)": `spEntry('SP6b', 'SP7')` starts ``**SP6b — Cave biomes** (XL; SP6a). Spec: `2026-11-12-sp6b-cave-biomes-design.md`.`` (MST:1926's `startsWith` pin removed from the SP6a describe).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/unit/metric.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (`CURRENT_SP` `'SP6a'`).
- [ ] **Step 3: Implement**; the master header; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 1: startedSps gains 'SP6b' (spec §14.1); no part changes.`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json` (no golden reads `cave_heavy`). Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `chore(sp6b): start SP6b; cave_heavy ready; METRICS_TIMEOUT_SCALE` (`git add src/core/ids.ts test/harness/sp.ts src/core/params/profiles.ts test/harness/metric.ts test/metrics/caves.metric.ts test/arch/sp.test.ts test/unit/profiles.test.ts test/unit/toolbar.test.ts test/unit/session.test.ts test/unit/mapState.test.ts test/unit/uiSmoke.test.ts test/unit/presetFile.test.ts test/unit/metric.test.ts test/tools/uiSmoke.ts test/arch/masterSpec.test.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md CLAUDE.md README.md`, and any other flipped pin by explicit path).

---

### Task 2: CI I: shards by (file, env); L1-L4

**Files:**
- Modify:
  - `.github/scripts/shardLib.mjs` (a shard is `string[] | { files: string[], env: Record<string, string> } | null`; `shardArgs` `:18` returns the files and `run` passes the env; `coverageProblems` `:29` accepts a file named by several shards when their `env`s differ in one variable whose values partition it **(plan)**: the same keys, distinct values), its `.d.mts`, `.github/scripts/metricShards.mjs:18-44` (`terrain` → `terrain-default: { files: [terrain, apply], env: { METRICS_PROFILES: 'default' } }`, `terrain-large: { files: [terrain], env: { METRICS_PROFILES: 'large_biomes' } }`; `surface` → `surface-default`, `surface-large` likewise; `caves` → `caves: { files: [caves], env: { METRICS_CAVE_GROUPS: 'default' } }`, `caves-presets: { … 'presets' }`; each with its measured-time comment)
  - `test/metrics/terrain.metric.ts:71` and `test/metrics/surface.metric.ts:85` (`PROFILES` filtered by `METRICS_PROFILES`, absent: both; an unknown name throws)
  - `test/metrics/caves.metric.ts` (`METRICS_CAVE_GROUPS`: `default` holds the six default-group regions, C1-C6, the default group's C7-C9 and their `carverReference`; `presets` the three preset regions, their C7-C9 groups, `carverReference`, `islandCapAir`, and the pure parts `reachOverflow`, `endTaper`; absent: every group **(plan)**. The calls split into disjoint literal part lists with distinct `outName`s, each registered by a condition on `METRICS_CAVE_GROUPS` (`measureC7C9` asserts every part finite and every pose non-null, `:651-656`, and the default-only parts and the poses are NaN or null without default regions, `test/harness/caveMetrics.ts:1839-1868`; a missing or NaN gated part is an error, `test/harness/metric.ts:42`, `:47`): (a) `metricTest('C7', ['verticalStep', 'flatWallShare', 'waterWall'], …, { outName: 'C7.tuning' })` and `metricTest('C9', ['nearestEntrance', 'holedSurface'], …)`, the per-group parts, registered in both groups (each job gates its own regions, so the worst group is gated implicitly); (b) the default-only parts in their own calls (`metricTest('C7', ['borderPlaneRatio', 'switchWall'], …, { outName: 'C7.default' })`, C8's three parts, `metricTest('C9', ['entrancesMax', 'thinRoof'], …, { outName: 'C9.default' })`) registered only when the default group runs, with the review poses and the finiteness check over them in the default group only; (c) the construction parts: `metricTest('C7', ['carverReference'], …)` registered in both groups, and `metricTest('C7', ['reachOverflow', 'endTaper', 'islandCapAir'], …, { outName: 'C7.construction' })` registered only when the presets group runs (or no group is set); C1-C6 only with the default group. The coverage scan still sees each part in exactly one literal call), `test/harness/caveSites.ts` (new: the tier's site lists moved out of `caves.metric.ts:96-175`, `export interface Site` and `export function caveSites(tier: 'fast' | 'quick' | 'full', groups: 'default' | 'presets' | null): Site[]`, with `PRESET_REGIONS`, `presetRegionHolds`, `findPresetRegion` and `presetRegion`'s scan, its `expect` replaced by a thrown Error; `caves.metric.ts` calls it with `TIER` and `METRICS_CAVE_GROUPS`, so a unit test can read the lists without importing a metric file, which would register its metricTests; Task 27's biomes group extends it), `.github/workflows/ci.yml` (the region-cache steps `:125-128`, `:158-161` skipped for the terrain and surface shards, which never save one), `.github/scripts/slowest.mjs` (per-test rows from `assertionResults` for metric jobs)
  - `test/unit/shards.test.ts:24-73`
- Test: `test/unit/shards.test.ts`, `test/unit/cavesMetric.test.ts` (the group filter)

**Interfaces:**
- Produces: the metrics-quick matrix `['terrain-default', 'terrain-large', 'surface-default', 'surface-large', 'render', 'edit', 'persist', 'clipboard', 'caves', 'caves-presets', 'rest']` (18 test jobs with check, unit × 2, fast × 4); `METRICS_PROFILES` and `METRICS_CAVE_GROUPS` read once per file.

- [ ] **Step 1: Write the tests.** `shards.test.ts`: the matrix above in that order; `node .github/scripts/metricShards.mjs check` passes; `coverageProblems` accepts `terrain.metric.ts` in `terrain-default` and `terrain-large` (env `METRICS_PROFILES` default / large_biomes) and refuses it in two shards with one env value, or in a shard with an env and one without; `apply.metric.ts` is in `terrain-default` only. `cavesMetric.test.ts`: `caveSites('quick', 'default')` has the six default-group sites, `('quick', 'presets')` the three preset sites, `('quick', null)` all 9, `('fast', 'presets')` none (the unit project runs with `METRICS_TIER` unset, `caves.metric.ts:80`, so the test names the tier); `coverageErrors` over `findMetricCalls` stays empty with the split calls.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/shards.test.ts test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every gated part stays exact under the split: T1-T5 and S1-S3 gate the worse profile or a sum with max 0 (`terrain.metric.ts:120-125`, `:243-244`; `surface.metric.ts:182-198`, `:230-233`); C7-C9's per-group parts are gated in each group's job (so the worst group is gated), the default-only parts in `caves`, the construction parts as (c) above; C1-C6 stay pooled in `caves` (`test/harness/caveMetrics.ts:945-990`, `:1804-1868`).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; locally, per new shard, `node .github/scripts/metricShards.mjs run <name> "$(mktemp -d)/r.json"` for `caves` and `caves-presets` (the C1-C9 and C7 construction values equal the unsplit run's `.out` values). Expected: PASS.
- [ ] **Step 5: Commit** `ci: shards by file and env; T1-T5, S1-S3 by profile and caves by group (SP6b §13 L1-L4)` (`git add .github/scripts/shardLib.mjs .github/scripts/shardLib.d.mts .github/scripts/metricShards.mjs .github/scripts/slowest.mjs .github/workflows/ci.yml test/metrics/terrain.metric.ts test/metrics/surface.metric.ts test/metrics/caves.metric.ts test/harness/caveSites.ts test/unit/shards.test.ts test/unit/cavesMetric.test.ts`).
- [ ] **Step 6: Push** (the controller): `git push -u origin sp6b/cave-biomes`; two green runs' job tables recorded (Task 5 writes them).

---

### Task 3: CI II: L5, T1's analysis in the region workers

**Files:**
- Modify:
  - `test/harness/terrainScatter.ts` (`forEachColumnThreaded` `:306-341` and `analyseColumn` `:221`: the region worker runs `analyseColumn` per column and returns its `Scattered` partial; the main thread sums **(plan)** `mergeScattered(into: Scattered, part: Scattered): void`, order-free: sums, histograms and the T5 list sorted after the merge), the region worker (`test/harness/regionWorker.ts`)
  - `test/metrics/terrain.metric.ts`
- Test: `test/unit/terrainScatter.test.ts`

- [ ] **Step 1: Write** `terrainScatter.test.ts`: "sliced-and-summed equals serial": over a fast-size sample (512 default columns, seed '42'), the threaded result's every accumulator equals the serial `analyseColumn` loop's (`toEqual`, the sorted T5 list included), and with 1, 2 and 4 workers alike.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/terrainScatter.test.ts`. Expected: FAIL (no merge).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npx vitest run --project metrics-quick test/metrics/terrain.metric.ts` with `METRICS_PROFILES=default`: T1-T5's `.out` values equal Task 2's. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): T1's analysis in the region workers (SP6b §13 L5)` (`git add test/harness/terrainScatter.ts test/harness/regionWorker.ts test/metrics/terrain.metric.ts test/unit/terrainScatter.test.ts`).

---

### Task 4: CI III: L6, caves' `measure` and `referenceCarve` in worker threads

**Files:**
- Modify:
  - `test/metrics/caves.metric.ts` (`measure` `:459-508` and the C7 construction pass `:390-436` per region in 4 `worker_threads` reading the cached region dumps; the main thread pools **(plan)**), a new `test/harness/caveRegionWorker.ts` (returns `CaveRegionCounts` and `CaveC7C9Counts` for one region)
  - `test/harness/caveMetrics.ts` (counts made transferable: plain objects of numbers and typed arrays)
- Test: `test/unit/cavesMetric.test.ts`

- [ ] **Step 1: Write** "per-region counts in a worker equal the in-process ones": the two fast regions' `CaveRegionCounts`, `CaveC7C9Counts` and `referenceCarve` result computed by `caveRegionWorker` and in process are `toEqual`; pooled C1-C9 values are equal with 1 and 4 workers.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the `caves` and `caves-presets` shards locally: every C1-C9 and C7 construction value equals Task 2's. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): caves' measure and carver reference in worker threads (SP6b §13 L6)` (`git add test/metrics/caves.metric.ts test/harness/caveRegionWorker.ts test/harness/caveMetrics.ts test/unit/cavesMetric.test.ts`).
- [ ] **Step 6: Push** (the controller). L5 and L6 change `test/harness/**`, so this run is cold (cold run 1).

---

### Task 5: CI IV: two cold runs against 5:30; the evidence

**Files:**
- Modify: the SP6b spec (`## Exit evidence`: "### The CI work item (Tasks 2-6)")

- [ ] **Step 1: Cold run 2** (the controller): a second cold run of Task 4's head, made cold **(plan)** by deleting that run's `regions-*` caches (`gh cache list --key regions-` then `gh cache delete <key>` for each, the repository's own Actions caches, which CI rebuilds) and `gh run rerun <run id>`; or, at the controller's choice, Task 7's push (it changes `src/**` and no generated output). Either way Task 8 onward (the first `gen/` change) waits for Step 3's rule, and for Task 6 when it fires.
- [ ] **Step 2: Record** for every run (Task 2's two, cold runs 1 and 2, and a warm re-run beside each cold one): the run id, the wall (creation to the last job's end), each job's duration against §13's expected times (`terrain-large` 2:50-5:00, `terrain-default` 2:50-4:15, `surface-large` 2:50-4:55, `surface-default` 1:15-2:15, `caves` cold 3:00-3:35, `caves-presets` cold 2:20-3:55, the unchanged jobs up to about 4:35), runner minutes, the cache misses from the logs; the account's plan and its concurrent-job limit (`gh api user --jq .plan` **(plan)**; the 18 jobs ≤ 20).
- [ ] **Step 3: The rule.** Two consecutive green cold runs ≤ 5 min 30 s → the work item is done (Task 6 is skipped). Otherwise → Task 6.
- [ ] **Step 4: Commit** `docs(sp6b): the CI work item measured` (`git add docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 6: CI V (conditional): Stage 2 in order

Run only when Task 5's rule fires. Each item one commit, pushed and measured as Task 5 (two cold runs, a warm re-run beside each), before the next; stop at the first that gives two consecutive cold runs ≤ 5:30; after the list, record the measured wall and go on (§13's "a miss inside the work item"; no STOP). No sample reductions.

- [ ] **6a: column slices with a merge job.** `terrain-large` and `surface-large` each in 2 slices (slice k takes draws k, k + 2, … of the unchanged column list, drawn whole first so the RNG sequence is unchanged), each writing its partial `Scattered`/`SurfaceAcc` as an artifact (`actions/upload-artifact`); a `metrics-merge` job (`needs: metrics-quick`) downloads them and gates through `metricTest`; the caves default group merged by seed the same way. Files: `.github/workflows/ci.yml`, `.github/scripts/metricShards.mjs`, `shardLib.mjs` (a slice env `METRICS_SLICE=k/2`), `test/metrics/terrain.metric.ts`, `surface.metric.ts`, `caves.metric.ts`, a merge entry `test/metrics/merge.metric.ts` **(plan)**, `test/unit/shards.test.ts` (sliced-and-merged == unsliced on a fast sample). Commit `ci: the large profiles in two column slices with a merge job (SP6b §13 Stage 2 item 1)`.
- [ ] **6b: `unit (rest)` in a third shard** (`liveness`, `densityFast`, `carve`, `densityDefaults`, `floatingIslands`; `.github/scripts/unitShards.mjs`, `shards.test.ts`). Commit `ci: a third unit shard (SP6b §13 Stage 2 item 2)`.
- [ ] **6c: `persist.metric.ts` in a fast shard of its own** (`.github/scripts/fastShards.mjs`), folding `metrics-fast (caves)` into a neighbour and `metrics-quick (clipboard)` with `(edit)`, and two further small shards so the count with `caves-biomes` is ≤ 20: for example `metrics-quick (persist)` into `(edit)` and a sub-minute `metrics-fast` shard into a neighbour, each named with its measured time. Commit `ci: persist in a fast shard of its own; small shards folded (SP6b §13 Stage 2 item 3)`.
- [ ] **The job count** (concurrent test jobs, the merge job excluded since it runs after metrics-quick; Spec correction 17): Task 2's 18; after 6a 21, after 6b 22, after 6c's listed folds 21 (each + 1 with `caves-biomes`, Task 27), ≤ 20 with `caves-biomes` only after 6c's two further folds. If the work item stops after 6a or 6b, that item's commit folds enough small shards (named with their measured times) that the count with `caves-biomes` stays ≤ 20.
- [ ] Each item: `npm run typecheck && npm test`; the shard tables' `check`; the measured runs in Exit evidence (docs commit `docs(sp6b): CI Stage 2 measured`, which also rewords §13's "(19 with `caves-biomes`)" per Spec correction 17).

---

### Task 7: The seven blocks; `sp6b.registry`

**Files:**
- Modify:
  - `src/world/blocks/defs.ts` (appended after `black_wool`, `:118-125`, with `terrain(name, sound, 'none')` `:18-22`: `moss_block` grass, `dripstone_block` stone, `abyss_stone`, `abyss_stone_veined`, `cracked_abyss_stone`, `abyss_shale`, `abyss_ash` abyss)
  - `src/textures/flatColors.ts` (§4's colours: [78, 112, 52], [150, 120, 96], [36, 34, 44], [58, 48, 74], [50, 44, 46], [70, 64, 48], [92, 88, 86]; a colour moves by a few units only if the pairwise rule fails, recorded in the spec)
  - `test/stateIds.lock.json` (`npm run test:accept-state-ids`: ids 58-64)
  - `test/unit/crossSectionVoxels.test.ts:72-73` (`stateCount` 65, `typeCount` 57)
  - `test/unit/flatColors.test.ts:33` (56 named types), `:76-83` (67 layers; `LOG_END_LAYER`, `LAVA_LAYER` 65, 66)
  - `test/unit/meshGreedy.test.ts:428` (`LOG_END_LAYER` 65), `test/unit/meshFluid.test.ts:254` (`LAVA_LAYER` 66)
  - `test/unit/wiworld.test.ts:321-323` (today's state table 65 keys, in the test title too)
  - `test/unit/uiSmoke.test.ts:227-229` (the Voxels legend 67 labels; the comment's "58 state keys" becomes 65)
  - `test/unit/crossSectionVoxels.test.ts:110-125` (the seven keys appended to the explicit state list in id order; `toHaveLength(65)`)
  - `src/metrics/sp2aGoldens.ts` (`allGoldenKeys` and `computeAnyGolden` route `sp6b.`, beside `:132`)
  - `test/arch/rules/banned.ts:20-22` (`DET_FILES` gains `'metrics/sp6bGoldens.ts'`)
  - `test/goldens.json` (one key added), the key-list pins (Global Constraints; 63)
  - master §2.2 (item 7)
  - §3.12 (item 13)
  - §0's "Banned APIs" `DET_FILES` list and §1's `metrics/*.ts` entry ("SP6b: sp6bGoldens.ts, the sp6b.* goldens"; Spec correction 8)
  - `test/arch/masterSpec.test.ts` (MST:1993 moved), the SP6b spec (Spec correction 8)
- Create: `src/metrics/sp6bGoldens.ts`, `test/unit/goldens.sp6b.test.ts`
- Test: `test/unit/blockDefs.test.ts`, `test/unit/blockTags.test.ts`, `test/unit/clipboardCodec.test.ts`, `test/unit/flatColors.test.ts`, `test/unit/crossSectionVoxels.test.ts`, `test/unit/stateLock.test.ts`

**Interfaces:**
- Produces: state ids `moss_block` 58, `dripstone_block` 59, `abyss_stone` 60, `abyss_stone_veined` 61, `cracked_abyss_stone` 62, `abyss_shale` 63, `abyss_ash` 64; `export function sp6bGoldenKeys(): string[]` (this task `['sp6b.registry']`; Tasks 17 and 31 append), `export function computeSp6bGolden(key: string): string`; `sp6b.registry` = the registry's byte stream over states 58-64 (SP3c's `sp3c.registry` pattern, `src/metrics/sp3cGoldens.ts:3-4`, a fixed range so later appends never change it).

- [ ] **Step 1: Write the tests.**
  - `blockDefs.test.ts`: "SP6b's seven types (§4, D36)": names and ids as above, each opaque, `fullFaces` 63, `carvable` true, no properties, tint none, the sounds above; `EMIT` of each is 0 (the abyss stays dark, R21).
  - `blockTags.test.ts`: each lands in the creative palette's `terrain` category (`src/world/blocks/tags.ts:33-34`, `:47`).
  - `clipboardCodec.test.ts`: a clipboard holding the seven states round-trips by state key; `rotateState` maps each to itself (`src/world/blocks/registry.ts:372-377`).
  - `flatColors.test.ts`, `crossSectionVoxels.test.ts`: the counts above; every pair (plus sky, water, lava, unknown) ≥ 24 apart in summed |ΔRGB| (`:69-80`).
  - `goldens.sp6b.test.ts`: `sp6b.registry` matches `test/goldens.json`; the key-list pins at 63.
  - SP6b describe: "§2.2's terrain palette gains SP6b's seven types (SP6b spec §15 item 7)": the palette paragraph names the seven in id order with "ids 58-64, property-less full cubes, carvable" and the sounds; "§3.12 names the abyss surface-palette blocks (SP6b spec §15 item 13)": the line starting `- abyss:` contains `The abyss surface-palette blocks are abyss_stone, abyss_stone_veined, cracked_abyss_stone, abyss_shale and abyss_ash (SP6b);` (moved from MST:1993); the Banned APIs line names `` `metrics/sp6bGoldens.ts` `` (MST:265-267 holds).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/blockDefs.test.ts test/unit/blockTags.test.ts test/unit/clipboardCodec.test.ts test/unit/flatColors.test.ts test/unit/crossSectionVoxels.test.ts test/unit/goldens.sp6b.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-state-ids`; `npm run test:goldens`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `git diff HEAD -- test/goldens.json` adds `sp6b.registry` only (`generatorVersion` 8, 63 keys; `sp3a.registry` and `sp3c.registry` unchanged). Expected: PASS.
- [ ] **Step 5: Commit** `feat(blocks): moss, dripstone and the abyss palette, ids 58-64; sp6b.registry (SP6b D36)` (`git add src/world/blocks/defs.ts src/textures/flatColors.ts test/stateIds.lock.json src/metrics/sp2aGoldens.ts src/metrics/sp6bGoldens.ts test/arch/rules/banned.ts test/goldens.json test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp3c.test.ts test/unit/goldens.sp3e.test.ts test/unit/goldens.sp6a.test.ts test/unit/goldens.sp6b.test.ts test/unit/blockDefs.test.ts test/unit/blockTags.test.ts test/unit/clipboardCodec.test.ts test/unit/flatColors.test.ts test/unit/crossSectionVoxels.test.ts test/unit/meshGreedy.test.ts test/unit/meshFluid.test.ts test/unit/wiworld.test.ts test/unit/uiSmoke.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 8: `CAVE_BIOME`, `caveKindOf` and the masked readers

No generated output changes (Spec correction 4): T writes no nibble yet; every reader is masked so that T's first write (Task 17) changes nothing they compute.

**Files:**
- Modify:
  - `src/core/constants.ts` (beside `CAVE_KIND` `:177`: `CAVE_BIOME`, `CAVE_BIOME_COLORS`, `CAVE_BIOME_NAMES`, `caveKindOf`, `caveBiomeOf`; the comment `:169-175` names bits 4-7 "the cave biome (`CAVE_BIOME`), written by T at tagged voxels (SP6b)"); the readers that compare the stored byte with a kind or a range (§2.1, re-found by `grep -rn "\.cave(\|\.tag(\|sectionCave\|cave\[" src test`): `src/gen/caves/tags.ts:534` (a uniform section's byte), `:537`, `:619` (`yawAt`)
  - `src/ui/crossSection/voxels.ts:174` (`caveRgb(caveKindOf(byte))`; Spec correction 15: `src/workers/sliceJob.ts:150`, `:203` keep copying the whole byte, unmasked, because the Voxels mode needs the nibble in Task 46; the `caves` field's codes mask where they are computed)
  - `test/harness/refs.ts:333-334`
  - `test/metrics/caves.metric.ts:365-366`
  - `test/harness/windowScans.ts:56-59`
  - `test/metrics/region.metric.ts:293`
  - `test/harness/dt2.ts:309-312`, and the unit and integration tests §2.1 lists (`test/unit/terrainStage.test.ts:441`, `:467`, `:482`, `test/unit/caveTags.test.ts:108`, `:381`, `test/unit/carve.test.ts:582`, `:760`, `test/unit/refsCarve.test.ts:49`, `:109`, `test/unit/crossSectionVoxels.test.ts:232`, `test/integration/caveSavedWorld.test.ts:98`, `:146`) and any other the grep finds; a comparison with 0 stays unmasked (T writes the nibble only where the kind ≠ 0)
  - the SP6b spec (Spec correction 15)
- Test:
  - `test/unit/constants.test.ts`
  - `test/unit/caveTags.test.ts`
  - `test/unit/caveFinder.test.ts`
  - `test/unit/crossSectionVoxels.test.ts`
  - `test/unit/refsCarve.test.ts`
  - `test/unit/cavesMetric.test.ts`
  - `test/unit/dt2Column.test.ts`

**Interfaces:**
- Produces:
  - `export const CAVE_BIOME = Object.freeze({ plain: 0, lush: 1, dripstone: 2, abyss: 3 });`
  - `export const CAVE_BIOME_NAMES = Object.freeze(['plain', 'lush', 'dripstone', 'abyss'] as const); export type CaveBiomeName = (typeof CAVE_BIOME_NAMES)[number];`
  - `export const CAVE_BIOME_COLORS: readonly string[] = Object.freeze(['#6f86a6', '#4dff7a', '#ffb347', '#b05cff']);` (sRGB, the X-ray's, the map's, the slice's and the Voxels mode's one table)
  - `export const caveKindOf = (byte: number): number => byte & 15;` `export const caveBiomeOf = (byte: number): number => byte >> 4;`

- [ ] **Step 1: Write the tests.** One fixture **(plan)**, `withNibbles(view)`: a fixture column (a cheese cavern crossed by a worm, an entrance and a ravine, from `caveTags.test.ts`' fixtures) with every tagged byte given biome `(x + z) & 3` in bits 4-7. "A column with every nibble set gives the same kind-level outputs as with them cleared (SP6b §2.1)": `referenceCarve`'s carved voxels and `isCarverTag` count, the stored side's carver count (`caves.metric.ts`' loop), `crossingPairs`, `nearestCave`'s hit and yaw over loaded columns (a uniform section with a nibble included), the `caves` field's codes, the Voxels mode's colours (from `sliceJob`'s unmasked copy, the mask at the read), DT2's `tagProbe` comparison count — each `toEqual` between the two columns (the raw copy is not compared: it carries the nibble by design, Spec correction 15). `constants.test.ts`: `caveKindOf(0x35) === 5`, `caveBiomeOf(0x35) === 3`; the four colours and names in id order.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/constants.test.ts test/unit/caveTags.test.ts test/unit/caveFinder.test.ts test/unit/crossSectionVoxels.test.ts test/unit/refsCarve.test.ts test/unit/cavesMetric.test.ts test/unit/dt2Column.test.ts`. Expected: FAIL (no `caveKindOf`; the nibbled column differs).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `refactor(caves): caveKindOf; every reader of the cave byte masks the kind (SP6b §2.1)` (`git add src/core/constants.ts src/gen/caves/tags.ts src/ui/crossSection/voxels.ts test/harness/refs.ts test/metrics/caves.metric.ts test/harness/windowScans.ts test/metrics/region.metric.ts test/harness/dt2.ts test/unit/constants.test.ts test/unit/caveTags.test.ts test/unit/caveFinder.test.ts test/unit/crossSectionVoxels.test.ts test/unit/refsCarve.test.ts test/unit/cavesMetric.test.ts test/unit/dt2Column.test.ts test/unit/terrainStage.test.ts test/unit/carve.test.ts test/integration/caveSavedWorld.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, and any other masked file by explicit path).

---

### Task 9: `readFieldHalo`

**Files:**
- Modify: `src/gen/column/columnStage.ts` (after `readField` `:169-185`)
- Test: `test/unit/columnStage.test.ts`

**Interfaces:**
- Produces: `export function readFieldHalo(s: ColumnSample, field: SampleField, x: number, z: number): number`: u = (x − 16·s.cx)/4, v likewise; i = ⌊u⌋, j = ⌊v⌋ clamped to −1 … 4 **(plan: a RangeError when x or z lies outside [16·cx − 4, 16·cx + 20))**; fx = u − i, fz = v − j; `latticeIndex(i, j)` and the corners k, k + 1, k + 7, k + 8 in `readField`'s order; `top = v00 + (v10 − v00)·fx`, `bottom = v01 + (v11 − v01)·fx`, `top + (bottom − top)·fz`.

- [ ] **Step 1: Write the tests.**
  - "readFieldHalo equals readField inside the column": for C, E, H and `surfaceEst` at all 256 positions of columns (0, 0), (−1667, −2000), (40, 900), `Object.is` equal.
  - "two neighbours agree bit for bit on every shared halo position": columns (cx, cz) and each of (cx + 1, cz), (cx, cz + 1), (cx + 1, cz + 1), (cx − 1, cz − 1) for (cx, cz) ∈ {(0, 0), (31, −1)}: at every world position within 4 blocks of both columns, C, E, H, `surfaceEst` and Y0 = `surfaceEst` + 10·`Nd` (a fixed test noise) are `Object.is` equal., x = 16·cx + 20 and 16·cx − 5 throw a RangeError.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/columnStage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(column): readFieldHalo, the bilinear read over the halo (SP6b §1.2)` (`git add src/gen/column/columnStage.ts test/unit/columnStage.test.ts`).

---

### Task 10: The pure picker: `caveRegistry.ts`, `cavePicker.ts`

The picker takes its values as arguments (§6.1); no schema leaf exists until Task 17.

**Files:**
- Create: `src/gen/biomes/caveRegistry.ts`, `src/gen/biomes/cavePicker.ts`, `test/unit/cavePicker.test.ts`
- Modify:
  - master §1 (`gen/biomes/`'s line gains `caveRegistry.ts cavePicker.ts (SP6b)`; item 6)
  - `test/arch/masterSpec.test.ts` (`SP6B_MODULES`, its two rows; the module test), `.github/scripts/unitShards.mjs` (`cavePicker.test.ts` in `unit (heavy)` if over 20 s)

**Interfaces:**
- Produces (`caveRegistry.ts`):
  - `export interface CaveBiomeBoxes { readonly lush: { readonly hMin: number; readonly depthMin: number; readonly depthMax: number }; readonly dripstone: { readonly cMin: number; readonly depthMin: number; readonly depthMax: number }; readonly abyss: { readonly eMax: number; readonly cMin: number; readonly depthMin: number } }`
  - `export interface CaveBiomeSettings extends CaveBiomeBoxes { readonly depthScale: number; readonly borderWarp: number; readonly depthWarp: number; readonly edgeJitter: number }` (the shape of `params.caves.biomes` minus `noises`)
  - `export function pickCaveBiome(b: CaveBiomeBoxes, c: number, e: number, h: number, depth: number): number` (§1.3: inside tests as the table, the largest margin wins, a tie to the lower id, none → 0)
- Produces (`cavePicker.ts`):
  - `export interface Noise2 { z2(x: number, z: number): number; readonly clamp: number }` (a `NormalNoise` satisfies it)
  - `export interface CavePickerInputs { readonly settings: CaveBiomeSettings; readonly borderC: Noise2; readonly borderE: Noise2; readonly borderH: Noise2; readonly depth: Noise2; readonly jitterSeed: number }`
  - `export interface CaveColumnPass { cx: number; cz: number; j: number; readonly c: Float64Array; readonly e: Float64Array; readonly h: Float64Array; readonly y0: Float64Array }` (576 entries each, stride 24, offset 4: position (x, z) at `(z − 16·cz + 4)·24 + (x − 16·cx + 4)` **(plan)**); `export function newCaveColumnPass(): CaveColumnPass`
  - `export function fillCaveColumnPass(inp: CavePickerInputs, s: ColumnSample, pass: CaveColumnPass): CaveColumnPass` (for the (16 + 2J)² positions, in z-then-x order: C, E, H, surfaceEst by `readFieldHalo`; Nb = clamp(z2 / clamp, −1, 1) for each border noise, Nd likewise; C′ = C + w·NbC, E′, H′; Y0 = surfaceEst + dW·Nd; this operation order fixed **(plan)**)
  - `export function caveBiomeOfPass(inp: CavePickerInputs, pass: CaveColumnPass, x: number, y: number, z: number): number` (§1.4: h = `hash3(jitterSeed, x, y, z) >>> 0`; jx = ((h & 1023)·(2J + 1)) >>> 10 − J, jy from bits 10-19, jz from bits 20-29; `pickCaveBiome` at (x + jx, z + jz) with depth (Y0 − (y + jy))/D)
  - `export function caveBiomeUnjittered(inp: CavePickerInputs, pass: CaveColumnPass, x: number, y: number, z: number): number` (the map's, the finder's and the probe's no-jitter form)
  - `export function caveBiomePoint(b: CaveBiomeSettings, c: number, e: number, h: number, surfaceEst: number, nb: readonly [number, number, number], nd: number, y: number): { biome: number; depth: number }` (one position from exact values: the map layer's and the hover's)

- [ ] **Step 1: Write the tests** (`cavePicker.test.ts`; settings = §6.1's defaults as a literal).
  - "the boxes and the margin rule (§1.3)": (C 0.7, E 0, H 0.45, depth 0.5) → dripstone (margins 0.1 > 0.05); (C 0.7, H 0.5, depth 0.5) → lush (0.5 − 0.4 and 0.7 − 0.6 are both 0.09999999999999998 in binary, a true tie; it goes to id 1; (C 0.65, H 0.45) is no tie in floating point: 0.050000000000000044 > 0.04999999999999999, so dripstone); (E −0.6, C 0, depth 1.2) → abyss; (E −0.6, C −0.1, depth 1.2) → plain (C′ > cMin is strict); (H 0.5, depth 0.95) → plain (the 0.1 gap); (H 0.5, depth 0.2) and (H 0.5, depth 0.9) → lush (inclusive ends); with `lush.depthMax` 1.5 and (H 0.5, E −0.6, C 0, depth 1.2): lush margin 0.1, abyss 0.1 → lush (tie, lower id).
  - "the jitter's three 10-bit fields": for J = 2 and every f in 0 … 1023, ((f·5) >>> 10) − 2 ∈ [−2, 2] and each value occurs 204 or 205 times; with J = 0 every voxel's pick equals `caveBiomeUnjittered`; for J = 4 the 3D offsets of 100,000 voxels lie in [−4, 4]³.
  - "pure in (seed, settings, x, y, z)": two passes built in different column orders give `Object.is`-equal arrays at shared positions and equal picks at 10,000 voxels; `caveBiomeOfPass` at a voxel of column (cx, cz) whose jittered position lies in column cx + 1 equals the pick made from cx + 1's pass at the same jittered position (halo consistency through `readFieldHalo`).
  - "the map's form agrees with the pass": at 1,000 positions, `caveBiomePoint` fed the same C, E, H and `surfaceEst` (read by `readFieldHalo`) and the same three border and one depth noise values gives the same biome as `caveBiomeUnjittered` at that position and y, and `depth` = (Y0 − y)/D.
  - "the speckle": along a straight border of the unperturbed field (borderWarp 0, depthWarp 0), J = 2 makes the biome change within ±2 blocks of the border at ≥ 20 % of positions and nowhere farther.
  - SP6b describe: "§1 names each SP6b module in its entry, which exists (SP6b spec §15 item 6)" with `SP6B_MODULES` rows `[/^\s+biomes\/registry\.ts /, 'caveRegistry.ts cavePicker.ts (SP6b)', 'src/gen/biomes/caveRegistry.ts']` and `[/^\s+biomes\/registry\.ts /, 'cavePicker.ts', 'src/gen/biomes/cavePicker.ts']` (§1's line `      biomes/registry.ts picker.ts zoom.ts`, master :133).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/cavePicker.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §1 (item 6's token).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(caves): the cave-biome picker, per block from per-position fields (SP6b §1, D16)` (`git add src/gen/biomes/caveRegistry.ts src/gen/biomes/cavePicker.ts test/unit/cavePicker.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md .github/scripts/unitShards.mjs`).

---

### Task 11: The scan's per-run cave biomes

**Files:**
- Modify: `src/gen/surface/scan.ts` (`SurfaceScan` `:72-99` gains `runFloorBiome: Int8Array` and `runCeilBiome: Int8Array` (`MAX_RUNS`, −1 = none), `cavePicker: CavePickerInputs | null`, `cavePass: CaveColumnPass | null`; `newSurfaceScan`; `scanColumn` `:163` gains the trailing optional `tags: Uint8Array | null = null` and `cave: { readonly inputs: CavePickerInputs; readonly pass: CaveColumnPass } | null = null` **(plan)**, so every existing caller is unchanged)
- Test: `test/unit/surfaceScan.test.ts`

**Interfaces:**
- Produces: per run r, `runFloorBiome[r]` = `caveBiomeOf(tags[voxel above runTop])` when that voxel is tagged (kind ≠ 0), else −1; `runCeilBiome[r]` = the same for the voxel below `runBottom`, −1 for a run whose bottom is −63 (`scan.ts:81`, `:211-213`); with `tags` null every entry is −1.

- [ ] **Step 1: Write the tests** (hand-built columns, `surfaceScan.test.ts`' helpers): a run under tagged air of byte `1 | 1 << 4` has floor biome 1; under untagged air −1; a run over tagged air of byte `5 | 3 << 4` has ceiling biome 3; a run resting on the bedrock (bottom −63) has ceiling biome −1 whatever lies below; a run under water-filled tagged air (byte `2 | 2 << 4`) has floor biome 2; `tags` omitted gives −1 everywhere; the other scan outputs are identical with and without `tags`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/surfaceScan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(surface): the scan records each run's floor and ceiling cave biome (SP6b §3.1)` (`git add src/gen/surface/scan.ts test/unit/surfaceScan.test.ts`).

---

### Task 12: The `caveBiome` condition

**Files:**
- Modify:
  - `src/gen/surface/rules.ts` (`CaveBiomeCondition`, the `Condition` union `:52-54`, `CONDITION_KINDS` `:60-62` appends `'caveBiome'`, `FIELDS` `:181` gains `caveBiome: ['side', 'biomes']` last, after `not` (`test/unit/jsonText.test.ts:141` pins `FIELDS`' key order as `RULE_KINDS` then `CONDITION_KINDS`), validation)
  - `src/gen/surface/conditions.ts` (`caveBiomeHolds`)
  - `src/gen/surface/compile.ts` (the closure; `surfaceFastPath` classes a leaf under `caveBiome` as neither depth-bounded nor Y-only until Task 15, so such a tree has no fast path)
  - `src/gen/surface/reference.ts`
  - `src/gen/surface/source.ts` (source mode: a literal list only)
  - `src/ui/inspector/form.ts`
  - `src/ui/inspector/model.ts` (the node's form and summary)
  - `test/harness/treeMutator.ts` and `test/harness/surfaceFuzz.ts` (generate and mutate it: every side, any non-empty list)
  - `test/unit/goldens.sp3c.test.ts:119-122` (the fixture tree "uses every rule kind and condition kind": its condition-kind assertion compares against `CONDITION_KINDS` without `'caveBiome'`, with the comment "until SP6b Task 22 (the generator push)"; adding the kind to `surfaceOpsRules` here would change `sp3c.surface.ops` in the pre-push span, and the surface probe tags no column before Task 18)
  - master §3.11's Conditions line (item 12's half)
  - `test/arch/masterSpec.test.ts` (MST:1991 moved)
- Test:
  - `test/unit/surfaceRules.test.ts`
  - `test/unit/surfaceConditions.test.ts`
  - `test/unit/surfaceCompile.test.ts`
  - `test/unit/surfaceReference.test.ts`
  - `test/unit/inspectorForm.test.ts`
  - `test/unit/inspectorModel.test.ts`
  - `test/unit/treeMutator.test.ts`
  - `test/unit/surfaceFuzz.test.ts`

**Interfaces:**
- Produces: `export interface CaveBiomeCondition { readonly kind: 'caveBiome'; readonly side: 'floor' | 'ceiling' | 'here'; readonly biomes: readonly CaveBiomeName[] }`; error codes **(plan)** `'CAVE_BIOME_SIDE'` ("caveBiome side must be floor, ceiling or here"), `'CAVE_BIOME_LIST'` ("caveBiome needs 1-4 distinct cave biome names"); `floor` holds when the run's `runFloorBiome` is in the list, `ceiling` with `runCeilBiome`, `here` when `caveBiomeOfPass(scan.cavePicker, scan.cavePass, x, y, z)` is in the list (false when the scan has no picker); the inspector's summary `caveBiome floor [lush, dripstone]`.

- [ ] **Step 1: Write the tests.**
  - `surfaceRules.test.ts`: `{kind: 'caveBiome', side: 'floor', biomes: ['lush']}` is valid; `side: 'wall'` → `CAVE_BIOME_SIDE`; `biomes: []`, `['lush', 'lush']`, `['moss']` → `CAVE_BIOME_LIST`; a missing `biomes` → the kind's missing-field error.
  - `surfaceConditions.test.ts` and `surfaceReference.test.ts` (hand-built columns from Task 11): "a moss carpet never lies under a plain cave over lush rock": a run whose top's rock is in the lush box (`here` lush) but whose air above is plain (byte `1 | 0 << 4`): `caveBiome{floor, [lush]}` false, `caveBiome{here, [lush]}` true at the top voxel; "a ceiling rule never fires on a bedrock-resting run": `caveBiome{ceiling, [lush, dripstone, abyss, plain]}` false at every voxel of a run with bottom −63.
  - `surfaceCompile.test.ts`: compiled equals reference on every solid voxel of four hand-built columns holding every biome, for a tree with each side.
  - `treeMutator.test.ts`, `surfaceFuzz.test.ts`: the mutator emits `caveBiome` of every side; compiled = reference on 200 mutated trees (the fast path off for trees holding `caveBiome`, until Task 15).
  - `inspectorForm.test.ts`, `inspectorModel.test.ts`: the form edits `side` (a select) and `biomes` (checkboxes); the summary above.
  - SP6b describe: "§3.11's Conditions: caveBiome delivered, secondaryDepthRange to SP8b (SP6b spec §15 item 12)": the line starting `**Conditions:**` contains `` `caveBiome{floor | ceiling | here, biomes}` (SP6b) `` and `deferred to SP8b (amended by SP6b)`, and no longer `` `caveBiome` stays SP6b's `` (MST:1991 moved).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/surfaceRules.test.ts test/unit/surfaceConditions.test.ts test/unit/surfaceCompile.test.ts test/unit/surfaceReference.test.ts test/unit/inspectorForm.test.ts test/unit/inspectorModel.test.ts test/unit/treeMutator.test.ts test/unit/surfaceFuzz.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the master line.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff (no built-in tree uses it).
- [ ] **Step 5: Commit** `feat(surface): the caveBiome condition, floor, ceiling and here (SP6b D18)` (`git add src/gen/surface/rules.ts src/gen/surface/conditions.ts src/gen/surface/compile.ts src/gen/surface/reference.ts src/gen/surface/source.ts src/ui/inspector/form.ts src/ui/inspector/model.ts test/harness/treeMutator.ts test/harness/surfaceFuzz.ts test/unit/surfaceRules.test.ts test/unit/surfaceConditions.test.ts test/unit/surfaceCompile.test.ts test/unit/surfaceReference.test.ts test/unit/inspectorForm.test.ts test/unit/inspectorModel.test.ts test/unit/treeMutator.test.ts test/unit/surfaceFuzz.test.ts test/unit/goldens.sp3c.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 13: The `strata` rule kind

**Files:**
- Modify:
  - `src/gen/surface/rules.ts` (`StrataRule`, `Rule` and `LeafRule` unions `:30-33`, `RULE_KINDS` `:58` appends `'strata'`, `FIELDS` gains `strata: ['layers', 'minLen', 'maxLen', 'noise', 'amp']` right after `bandlands` (`test/unit/jsonText.test.ts:141` pins `FIELDS`' key order as `RULE_KINDS` then `CONDITION_KINDS`), validation; `ruleLeaves` treats it as a leaf)
  - `test/unit/goldens.sp3c.test.ts:119-122` (the rule-kind assertion compares against `RULE_KINDS` without `'strata'`, with the comment "until SP6b Task 22 (the generator push)", beside Task 12's)
  - the SP6b spec (Spec correction 16)
  - `src/gen/surface/bands.ts` (the table builder beside `bandlandsTable`)
  - `src/gen/surface/compile.ts` (the closure, sampled once per position as `bandlands` `:314-329`; a Y-only `strata` leaf decides an evaluated band, as `bandlands`)
  - `src/gen/surface/reference.ts`
  - `src/gen/surface/source.ts`
  - `src/ui/inspector/form.ts`
  - `src/ui/inspector/model.ts`
  - `test/harness/treeMutator.ts`
  - `test/harness/surfaceFuzz.ts`
  - master §3.11 (item 12's "`strata` joins the rule kinds (SP6b)")
- Test: `test/unit/surfaceBands.test.ts`, `test/unit/surfaceRules.test.ts`, `test/unit/surfaceCompile.test.ts`, `test/unit/surfaceReference.test.ts`, `test/unit/treeMutator.test.ts`, `test/unit/inspectorModel.test.ts`

**Interfaces:**
- Produces:
  - `export interface StrataLayer { readonly state: string; readonly weight: number; readonly maxLen: number }`; `export interface StrataRule { readonly kind: 'strata'; readonly layers: readonly StrataLayer[]; readonly minLen: number; readonly maxLen: number; readonly noise: string; readonly amp: number }`;, validation **(plan)**: `'STRATA_LAYERS'` (1-16 layers, each state a solid block state), `'STRATA_WEIGHT'` (weight > 0, finite), `'STRATA_LEN'` (integers 1 ≤ minLen ≤ maxLen ≤ 8, each layer's maxLen an integer in 1 … 8), `noise` as `noiseThreshold`'s rule (2D, remap 'none' `surface.noises.*`, `rules.ts:367-377`), `amp` finite in [0, 16];
  - `export function strataTable(seed: Seed64, k: number, r: StrataRule): Uint16Array` (192 state ids: `Xoshiro128(deriveSeed(seed, 'surface.strata.' + k))`; while i < 192: one `nextFloat` picks a layer by cumulative weight, over every layer for the first draw and, with ≥ 2 layers, over the layers other than the previous draw's after it (Spec correction 16; one layer: no exclusion), `len = minLen + nextInt(min(maxLen, layer.maxLen) − minLen + 1)`, or `layer.maxLen` when it is below minLen; fill [i, min(192, i + len)); no other draw), k the node's index among the tree's `strata` nodes in depth-first order;, lookup `table[((y + o) % 192 + 192) % 192]`, `o = Math.round(amp·z / clampSigma)`, z the z2 of `noise` at (x, z).

- [ ] **Step 1: Write the tests.**
  - `surfaceBands.test.ts`: "the strata table (§3.3)": for §3.3's abyss layers (abyss_stone 50/8, abyss_shale 25/4, cracked_abyss_stone 15/3, abyss_stone_veined 10/1; minLen 1, maxLen 6), seed '42', k 0: 192 entries; the same table twice; no two consecutive runs share a layer (each maximal run is one draw); every veined run is exactly 1 long; every run ≤ min(6, its layer's maxLen) (runs counted within the table, not across its wrap); pooled over seeds '1' … '8', each layer's share of runs within ±0.08 of the exclusion chain's stationary share w_i(1 − w_i)/Σ_j w_j(1 − w_j) (≈ 0.382, 0.286, 0.195, 0.137); a one-layer rule fills the table with its layer; k 1 gives a different table.
  - `surfaceRules.test.ts`: the codes above (17 layers; weight 0; minLen 0; maxLen 9; a 3D noise → `NOISE_DIMS`).
  - `surfaceCompile.test.ts`, `surfaceReference.test.ts`: compiled = reference on hand-built columns with a `strata` leaf under a Y-only condition and under `caveBiome{here}`; the lookup at y and y + 192 is equal; `amp` 0 ignores the noise.
  - `treeMutator.test.ts`: `strata` nodes generated with any of `surface.noises.depth`, `patch`, `bandOffset` as their noise (the 2D remap-'none' leaves before Task 22, `src/core/params/schema.ts:160-164`) and mutated; compiled = reference on 200 trees.
  - `inspectorModel.test.ts`: the summary `strata 4 layers ×6 ±6`.
  - SP6b describe: "§3.11's rule kinds gain strata (SP6b spec §15 item 12)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/surfaceBands.test.ts test/unit/surfaceRules.test.ts test/unit/surfaceCompile.test.ts test/unit/surfaceReference.test.ts test/unit/treeMutator.test.ts test/unit/inspectorModel.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(surface): the strata rule kind, a data band table shifted by a noise (SP6b D19)` (`git add src/gen/surface/rules.ts src/gen/surface/bands.ts src/gen/surface/compile.ts src/gen/surface/reference.ts src/gen/surface/source.ts src/ui/inspector/form.ts src/ui/inspector/model.ts test/harness/treeMutator.ts test/harness/surfaceFuzz.ts test/unit/surfaceBands.test.ts test/unit/surfaceRules.test.ts test/unit/surfaceCompile.test.ts test/unit/surfaceReference.test.ts test/unit/treeMutator.test.ts test/unit/inspectorModel.test.ts test/unit/goldens.sp3c.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 14: Fast path I: ceiling-bounded leaves, per-class bounds

**Files:**
- Modify: `src/gen/surface/compile.ts` (`SurfaceFastPath` and `surfaceFastPath` `:152-195`; `fillColumn`'s `deep` rule `:392`; the header comment `:12-26`), the SP6b spec (Spec correction 6)
- Test: `test/unit/surfaceCompile.test.ts`, `test/unit/surfaceFuzz.test.ts`, `test/unit/floatingRules.test.ts`

**Interfaces:**
- Produces: `SurfaceFastPath` gains `skyFloorBound: number` (the largest floor bound over floor-bounded leaves under `skyOpen`), `floorBound: number` (over the other floor-bounded leaves), `ceilBound: number` (over ceiling-bounded leaves: those whose depth gates are all `stoneDepth{ceiling}`; −1 when none) **(plan)**; a solid voxel of run r takes its band state when it is beyond every class's bound: `floorDepth > (r is sky-open ? max(skyFloorBound, floorBound) : floorBound)` and `ceilDepth > ceilBound` (Spec correction 6); `maxSurfaceDepth` and `skyGated` stay for the default tree's reading (a sky-gated tree has `floorBound` −1).

- [ ] **Step 1: Write the tests.**
  - `surfaceCompile.test.ts`: for the default tree the bounds read (15, −1, −1) and `fillColumn`'s evaluated count equals today's on 64 columns; a tree of rule 4's ceiling leaves with their `caveBiome` conditions removed (`stoneDepth{ceiling, 0}` → `noiseThreshold{surface.noises.patch …}` → moss_block; `stoneDepth{ceiling, 1}` → `not(noiseThreshold)` → dripstone_block; `surface.noises.patch` standing in for `cavePatch` until Task 22; no floor gate; a leaf under `caveBiome` has no fast path until Task 15, Task 12) gets `ceilBound` 1 and evaluates only each run's bottom 2 voxels plus the floor class's (Task 15 adds the same tree with its `caveBiome{ceiling}` gates back, extension 3); floating_islands' tree keeps `floorBound` 15 and `ceilBound` −1 (its `stoneDepth{ceiling, 100}` leaves are floor-bounded), and its evaluated count equals today's.
  - `surfaceFuzz.test.ts`: "the fast path equals full evaluation" on 300 `treeMutator` trees with ceiling gates, over 32 columns: every voxel's state `toEqual`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/surfaceCompile.test.ts test/unit/surfaceFuzz.test.ts test/unit/floatingRules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `perf(surface): the fast path bounds ceiling leaves and each leaf class apart (SP6b D20 1-2)` (`git add src/gen/surface/compile.ts test/unit/surfaceCompile.test.ts test/unit/surfaceFuzz.test.ts test/unit/floatingRules.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 15: Fast path II: the biome-gated skip, the `here` classification; the push base

**Files:**
- Modify: `src/gen/surface/compile.ts` (extension 3: when every non-sky floor (ceiling) leaf holds `caveBiome{floor}` (`{ceiling}`) on its path, a run whose `runFloorBiome` (`runCeilBiome`) is −1 or named by no such leaf takes the band state for that class; extension 4: per position, from the scan's pass over the (2J + 1)² neighbourhood, each box's climate test surely true, surely false or mixed and its depth tests' y ranges (J beyond the extremes of Y0 − D·depthMin and Y0 − D·depthMax), so a y range is **surely b** when b's box is surely true and every other box surely false, **surely not b** when b's box is surely false; a `caveBiome{here, biomes}` leaf takes its branch without evaluating the picker in a range surely in `biomes`, skips it in a range surely outside, evaluates `caveBiomeOfPass` elsewhere **(plan: a per-position `Int16Array` of range ends, filled once per position in `setPosition`)**), `src/gen/surface/scan.ts` (the classification arrays)
- Test: `test/unit/surfaceFuzz.test.ts`, `test/unit/surfaceCompile.test.ts`, `.github/scripts/unitShards.mjs` (the fuzz in `unit (heavy)` if over 20 s)

**Interfaces:**
- Consumes: Tasks 10-14.
- Produces: `fillColumn`'s output unchanged for every tree, settings and column; its evaluated count, for rule 4 over a column holding each biome (Task 22's tree, written here as a test fixture with `surface.noises.patch` in place of `cavePatch` and `surface.noises.bandOffset` in place of `strataOffset`, both 2D remap 'none': the leaves Task 22 adds do not exist yet, and validation refuses an unknown `surface.noises.*` name, `src/gen/surface/rules.ts:367-370`; Task 22 re-points the fixture to the real leaves), ≤ the floor class's evaluations plus about 3 voxels per biome run end; Task 14's ceiling tree with its `caveBiome{ceiling}` gates back takes extension 3.

- [ ] **Step 1: Write the tests.**
  - `surfaceFuzz.test.ts`: "the fast path equals full evaluation over caveBiome and strata trees and random cave-biome settings (§3.5)": 300 `treeMutator` trees (every `caveBiome` side, any lists, `strata`), each paired with random `caves.biomes` settings (boxes overlapping: `lush.depthMax` and `dripstone.depthMax` up to 2, `abyss.depthMin` down to 0; `edgeJitter` 0-4), over 16 hand-built columns whose tags hold every biome (the nibble from the picker on Task 10's settings) and 16 generated: every state `toEqual`.
  - `surfaceCompile.test.ts`: with the default boxes the abyss's range is surely abyss wherever its climate test is surely true: over 64 positions of an abyss column, at the positions whose abyss climate test is surely true over the position's (2J + 1)² neighbourhood, the classification marks every voxel below min over that neighbourhood of Y0, minus D·depthMin + J (128 + J at the defaults), surely abyss, and no voxel above max over the neighbourhood of Y0, minus 128, plus J surely abyss (abyss columns lie under mountains, so Y0 slopes across the neighbourhood); with `lush.depthMax` 1.5 the overlap y range is evaluated; the Task 14 ceiling tree with its `caveBiome{ceiling}` gates back gives `fillColumn`'s output unchanged and evaluates only the ceiling class's voxels of runs whose `runCeilBiome` it names.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/surfaceFuzz.test.ts test/unit/surfaceCompile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `perf(surface): the biome-gated skip and the caveBiome here classification (SP6b D20 3-4)` (`git add src/gen/surface/compile.ts src/gen/surface/scan.ts test/unit/surfaceFuzz.test.ts test/unit/surfaceCompile.test.ts .github/scripts/unitShards.mjs`).
- [ ] **Step 6: Push** (the controller): `git push`; `git rev-parse HEAD` is **`<push base>`**, the generator push's base (Tasks 16-31 record from it); CI green.

---

### Task 16: D29: `SCHEMA_VERSION` 5 and the GV8 trees' migration

The first commit of the generator push; no generated output changes (Spec correction 3).

**Files:**
- Create:
  - `test/fixtures/gv8-density-trees.json`
  - `test/fixtures/gv8-surface-trees.json` (written in Step 1 from the code at `<push base>`, before any tree changes)
  - `test/unit/gv8Trees.test.ts`
  - `test/fixtures/preset-v4.json` (schema 4, the GV8 default trees, one edited leaf: `caves.cheese.offset` 0.45)
  - `test/fixtures/expected-v4.json`
- Modify:
  - `src/core/params/migrate.ts` (`SCHEMA_VERSION` `:14` → 5; `MIGRATIONS` gains `[3]`; the doc comment)
  - `test/fixtures/expected-v1.json` … `expected-v3.json` (regenerated)
  - `test/unit/presetFile.test.ts:91`, `:95` (`presetText` writes `SCHEMA_VERSION`: `"schemaVersion": 5`), `:165` (`schemaVersion: 6`, "newer than this build (5)"), `:361` (`toBe(5)`)
  - `test/unit/saves.test.ts:107` (6)
  - `test/unit/profiles.test.ts:74` (`[5, 4]`, its title "SCHEMA_VERSION 5 (SP6b D29): four migrations"), `:333` (the "newer schema version" case: `d.schemaVersion = 6`)
  - any other literal schema-4 pin a grep of `test/` for `schemaVersion` finds
  - `test/schema-shape.lock.json` (accepted at 5), the SP6b spec (Spec corrections 3, 9)
- Test: `test/unit/profiles.test.ts`, `test/unit/saves.test.ts`, `test/unit/presetFile.test.ts`, `test/unit/wiworld.test.ts`, `test/unit/gv8Trees.test.ts`

**Interfaces:**
- Consumes: `canonicalJSON`, `fnv1a64`, `hex64`, `mapPath` (`migrate.ts`).
- Produces: `MIGRATIONS[3]` **(plan: `sp6bTrees`)**: a stored `density.defs` whose `hex64(fnv1a64(canonicalJSON(…)))` is one of the three GV8 hashes (`GV8_DENSITY_HASHES`, a non-exported `Map` to `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE`, `FLOATING_DENSITY_TREE`) becomes that live tree; a stored `surface.rules` equal to the GV8 `DEFAULT_SURFACE_RULES` or `FLOATING_SURFACE_RULES` (`GV8_SURFACE_HASHES`) becomes the live one; anything else kept; the input never mutated; missing new leaves take the profile's values (nothing written).

- [ ] **Step 1: The fixtures, before any edit.** `WRITE_GV8_TREES=1 npx vitest run --project unit test/unit/gv8Trees.test.ts` writes `{default, amplified, floating_islands}` density trees and `{default, floating_islands}` surface trees as canonical JSON and prints the five hashes; without the variable the test reads the fixtures, checks each hash against its literal, and checks each passes tier 2 (`validateDensitySource`, `validateRulesSource`); `test/fixtures/sp6a-density-trees.json` and `test/unit/sp6aTrees.test.ts` are untouched.
- [ ] **Step 2: Write the tests.**
  - `profiles.test.ts`: each GV8 density tree in a schema-4 document migrates to the live tree of its kind (`toBe`); each GV8 surface tree likewise; a tree with one literal changed is kept; a document without the leaves is the same object; the input is not mutated; `MIGRATIONS.length === SCHEMA_VERSION − 1`; "a schema-3 document runs 3 → 4 then 4 → 5 (Spec correction 9)": SP6a's pre-R31 default tree (`sp6a-density-trees.json`) ends as `DEFAULT_DENSITY_TREE` and its noodle defaults 0.11 / 64 become 0.22 / 48.
  - `saves.test.ts`: a GV8 world record (schema 4, the GV8 trees) opens through `loadParams` with the live trees; `olderGenerator` is computed as today (`saves.ts:248-250`); `:74-80` (the SP5b fixture equals `resolveProfile('default')`) still passes.
  - `presetFile.test.ts`: a schema-4 preset file holding the GV8 default trees imports with the live trees; `:91`, `:95` and `:361` read 5; `:165` reads 6 and "(5)".
  - `wiworld.test.ts`: a `.wiworld` file whose params are a schema-4 document with the GV8 default trees imports with the live trees (§14.4: every stored-params path goes through `migrate`).
  - U4 (`params.metric.ts:24-30`) finds `preset-v4.json`/`expected-v4.json`.
- [ ] **Step 3: Run** `npx vitest run --project unit test/unit/profiles.test.ts test/unit/saves.test.ts test/unit/presetFile.test.ts test/unit/wiworld.test.ts test/unit/gv8Trees.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement**; the fixtures regenerated; `npm run test:accept-schema`.
- [ ] **Step 5: Run** `npm run typecheck && npm test` (U4 `migrationFailures` 0); `git checkout <push base> -- test/goldens.json && npm run test:goldens && git diff --exit-code <push base> -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 6: Commit** `feat(params): schema version 5 migrates GV8's built-in density and surface trees (SP6b D29)` (`git add src/core/params/migrate.ts test/fixtures/gv8-density-trees.json test/fixtures/gv8-surface-trees.json test/fixtures/preset-v4.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/fixtures/expected-v3.json test/fixtures/expected-v4.json test/unit/gv8Trees.test.ts test/unit/profiles.test.ts test/unit/saves.test.ts test/unit/presetFile.test.ts test/unit/wiworld.test.ts test/schema-shape.lock.json docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 17: T writes the cave biome: the `caves.biomes.*` leaves, the nibble, `caveBiomeQ` (GENERATOR_VERSION 9)

**Files:**
- Modify:
  - `src/core/params/schema.ts` (the `caves` group gains `biomes: group('Cave biomes', …)` after `noises` `:292-318`: `lush`, `dripstone`, `abyss` sub-groups with §6.1's leaves, defaults and ranges, then `depthScale` (128, 32 … 256), `borderWarp` (0.05, 0 … 0.2), `depthWarp` (10, 0 … 32), `edgeJitter` (int 2, 0 … 4), then `noises` with `border` (2D, λ 64, 2 octaves) and `depth` (2D, λ 96, 2 octaves); each with the Terrain badge; Spec correction 12);
  - `src/ui/paramPanel/lints.ts:26` (`ORDERED` gains `['caves.biomes.lush.depthMin', 'caves.biomes.lush.depthMax', 'the biome never occurs']` and dripstone's);
  - `src/gen/biomes/cavePicker.ts` (`export function cavePickerOf(ctx: GenContext): CavePickerInputs`, memoised per context; Spec correction 11);
  - `src/gen/pipeline/terrainStage.ts` (after `TAG_COLUMN` `:184`, before `columnWaterV0`: `fillCaveColumnPass`, then at every voxel with `TAG[j] !== 0`, `TAG[j] = TAG[j] | caveBiomeOfPass(…) << 4`; aux B's `caveBiomeQ` beside `surfaceBiomeQ` `:221-224`: per quart (qy, qz, qx) 0 with no tagged voxel, else 1 + the biome most of its tagged voxels carry, ties to the lower id; the header comment `:28-29`);
  - `src/core/constants.ts:2` (`GENERATOR_VERSION = 9`), `src/core/stage/registry.ts:20` (terrain version 5), `test/unit/stage.test.ts:18` (`'terrain@5'`) and `:20-22` (`[5, ['density', 'surface', 'caves']]`; the title "SP6b: terrain is version 5 …");
  - `src/metrics/liveness.ts` (the biome witness: columns whose tagged air holds each biome, found by a scan over a bounded stream, as SP6a's class columns; the 15 leaves decided there), `test/unit/liveness.test.ts:52` (`U2_LEAVES` 187);
  - `src/metrics/sp6bGoldens.ts` (`sp6b.caveBiome.points`: `caveBiomeOfPass` over the default profile's picker at 64 fixed 3D points drawn from `Xoshiro128(fnv1a32('sp6b.caveBiome.points'))` within ±4,096 blocks, y −63 … 120, world seed '42' **(plan)**), `test/goldens.json`, the key-list pins (64), `test/unit/goldens.sp6b.test.ts`;
  - `test/schema-shape.lock.json`, U4's fixtures, `README.md` (`npm run docs:params`);
  - master §2.3's `cave` line (`:351`) and aux B line (`:379`) (item 8), §3.2 (`:586`, item 9), §3.9 (`:755`, item 10), §3.10 (`:770-794`, item 11), §5.4 (`:1354`, item 18), §6.4's U2 row (`; SP6b: the caves.biomes.* leaves are decided on a bounded biome witness …; U2 covers 187 leaves (amended by SP6b)`), `test/arch/masterSpec.test.ts` (MST:1984, :1995, :2066's count and :2127, the SP6a `cave` line pin, moved), the SP6b spec (Spec corrections 5, 7, 11, 12)
- Test: `test/unit/terrainStage.test.ts`, `test/unit/cavePicker.test.ts`, `test/unit/liveness.test.ts`, `test/unit/paramPanel.test.ts`, `test/unit/goldens.sp6b.test.ts`

**Interfaces:**
- Consumes: Tasks 8-10; `noiseFor` (`src/gen/context.ts:72`).
- Produces: every tagged voxel's byte is `kind | biome << 4`; untagged voxels 0; `caveBiomeQ` written; `cavePickerOf(ctx).settings` equals `ctx.params.caves.biomes` minus `noises`.

- [ ] **Step 1: Write the tests.**
  - `terrainStage.test.ts`: "T writes each tagged voxel's cave biome into bits 4-7 (§2.1)": over columns (0, 0), (−1667, −2000), (40, 900) and an abyss column found by a scan at seed '42', every voxel's byte >> 4 equals `caveBiomeOfPass(cavePickerOf(ctx), pass, x, y, z)` where kind ≠ 0 and is 0 elsewhere; `caveKindOf(byte)` equals `caveTagAt(dc, x, y, z)` at every voxel of those columns (the kinds unchanged); "caveBiomeQ is the majority (§2.2)": a hand-checked quart with 3 lush, 3 dripstone and 1 plain tagged voxels reads 1 + 1 (tie to lush); a quart with no tagged voxel reads 0; tagged voxels holding water v0's water count; Review Focus 4: "with `edgeJitter` 4, the columns (31, 0) and (32, 0) generated alone (`isolatedColumn`) and inside one region give the same nibbles and `caveBiomeQ`, and the nibble at every tagged voxel within 8 blocks of x = 512 equals the pick at it".
  - `cavePicker.test.ts`: `cavePickerOf(ctx)` uses `NormalNoise(ctx.seed, 'caveBiome.C' | 'caveBiome.E' | 'caveBiome.H', border)` (two contexts of one seed give `Object.is`-equal z2 at 100 points; a different seed differs) and the schema instance for `depth`.
  - `paramPanel.test.ts`: the Caves section ends Cave noises, Cave biomes (Lush, Dripstone, Abyss, the four leaves, Noises); the lint `caves.biomes.lush.depthMin` 0.9 with `depthMax` 0.9 reads "the biome never occurs".
  - `liveness.test.ts`: `U2_LEAVES` 187; each of the 15 new leaves is decided (on the witness).
  - SP6b describe: "§2.3's cave byte and aux B lines name the cave biome (SP6b spec §15 item 8)" (`:351` contains `bits 4-7: the cave biome (\`CAVE_BIOME\`), written by T at tagged voxels (SP6b)`; `:379` contains `` `caveBiomeQ`: 0 for a quart with no tagged voxel, else 1 + the biome most of its tagged voxels carry; written by T (SP6b) ``; MST:1984 moved; MST:2127's §2.3 `cave` pin, which reads "bits 4-7 reserved", moved here with the new wording); "§3.2's depth axis as built (SP6b spec §15 item 9)"; "§3.9's abyss box (SP6b spec §15 item 10)" (contains `the Abyss holds no water and stays dark; lava may appear there (SP7)`); "§3.10's registry and per-block evaluation (SP6b spec §15 item 11)" (contains `Cave biomes per block: per-position climate and depth perturbed by two 2D border noises, chosen at a position and height jittered by ±\`edgeJitter\` blocks per voxel (SP6b, D16); \`caveBiomeQ\` summarises them per quart`, and the box values equal `DEFAULTS.caves.biomes`); "§5.4: the cave biomes arrived as leaves (SP6b spec §15 item 18)" (MST:1995 moved: `the 3 cave biomes arrived in SP6b as \`caves.biomes.*\` leaves on the parameter panel, not as biome-table rows (SP6b, D15)`); "§6.4's U2 row covers the schema's U2 leaves (SP6b spec §15 item 20)" (n 187, moved from MST:2066).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/terrainStage.test.ts test/unit/cavePicker.test.ts test/unit/liveness.test.ts test/unit/paramPanel.test.ts test/unit/goldens.sp6b.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-schema`; U4's fixtures; `npm run docs:params`; the master items.
- [ ] **Step 4: Run** `npm run typecheck && npm test` (U2 with the witness, U4 0, DT1 and DT2 on fast); `npx vitest run --project metrics-quick test/metrics/region.metric.ts` (DT1 `isolated`, `carverCache` with the picker's halo positions); `git checkout <push base> -- test/goldens.json && npm run test:goldens && git diff <push base> -- test/goldens.json`: `generatorVersion` 8 → 9, `sp1.params`, `sp3a.region.T.default`, `.large_biomes`, `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`, `sp6a.region.T.caves`; `sp6b.caveBiome.points` added (64 keys); `sp3c.surface.ops`, `sp3b.density.default`, `sp6a.density.ops` unchanged. Expected: PASS.
- [ ] **Step 5: Commit** `feat(caves): T writes each cave voxel's biome and caveBiomeQ; the caves.biomes leaves (SP6b D17, GENERATOR_VERSION 9)` (`git add src/core/params/schema.ts src/ui/paramPanel/lints.ts src/gen/biomes/cavePicker.ts src/gen/pipeline/terrainStage.ts src/core/constants.ts src/core/stage/registry.ts test/unit/stage.test.ts src/metrics/liveness.ts src/metrics/sp6bGoldens.ts test/goldens.json test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp3c.test.ts test/unit/goldens.sp3e.test.ts test/unit/goldens.sp6a.test.ts test/unit/goldens.sp6b.test.ts test/unit/terrainStage.test.ts test/unit/cavePicker.test.ts test/unit/liveness.test.ts test/unit/paramPanel.test.ts test/schema-shape.lock.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/fixtures/expected-v3.json test/fixtures/expected-v4.json README.md test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 18: Probes: `caveBiomeAt`, the surface probe; DT2 `caveBiomeProbe`

**Files:**
- Modify:
  - `src/gen/biomes/cavePicker.ts` (`export function caveBiomeAt(dc: DensityContext, x: number, y: number, z: number): number`: the voxel's column sample from `dc.columns.get(cx, cz)`, a one-column pass memo, `caveBiomeOfPass`; integers, y −64 … 319, (x, z) in the world window, else a RangeError)
  - `src/gen/surface/probe.ts` (`surfaceProbeColumn` `:43-62`: `FILL(bounds, s, c.solid, null, null, stop, c.cells)` (`tagColumn` throws unless it gets the fill's 768-entry per-cell record, `src/gen/caves/tags.ts:239-244`; T fills with `CELLS`, `terrainStage.ts:178`), `CARVE` with `c.tags`, then `tagColumn(c, readers, threshold, c.solid, c.cells, c.tags, sc.density.bounds, true)` as T does, the cave-biome step and the scan with `tags` and the pass, as T)
  - `src/gen/surface/context.ts` (`SurfaceProbeColumn` `:48-56` gains `cells: Uint8Array(768)`, `tags: Uint8Array(98,304)` and its `CaveColumnPass`)
  - `src/gen/pipeline/terrainStage.ts` (`terrainSurfaceDebug` `:249-258` tags and picks before the pass; `SURFACE_PASS` gets the tags and the pass in both callers)
  - `src/gen/surface/pass.ts` (`surfacePass` passes `tags`/`cave` through to `scanColumn`)
  - `test/bench/noise.bench.ts:263` (the `surface.column` row's call)
  - `test/harness/dt2.ts` and `test/metrics/region.metric.ts:443` (`caveBiomeProbe`: at every tagged voxel of the DT2 columns, `caveBiomeOf(stored)` against `caveBiomeAt`; for every quart holding a tagged voxel, the stored `caveBiomeQ` against the majority of `caveBiomeAt` over its tagged voxels)
  - `test/thresholds.ts` (`DT2.caveBiomeProbe: { max: 0, activeFrom: 'SP6b' }`)
  - `test/thresholds.lock.json`
  - master §6.4's DT2 row (item 20's part)
- Test: `test/unit/surfaceProbe.test.ts`, `test/unit/dt2Column.test.ts`, `test/unit/cavePicker.test.ts`

- [ ] **Step 1: Write the tests.** `cavePicker.test.ts`: `caveBiomeAt` equals T's stored nibble at every tagged voxel of the three columns of Task 17, visited in a shuffled order across columns. `surfaceProbe.test.ts`: the probe's scan of a column equals `terrainSurfaceDebug`'s (`runFloorBiome`, `runCeilBiome` included) on 8 columns. `dt2Column.test.ts`: `caveBiomeProbe` counts 0 mismatches on two columns and counts one when a stored nibble is flipped. SP6b describe: "§6.4's DT2 row gains caveBiomeProbe (SP6b spec §15 item 20)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/surfaceProbe.test.ts test/unit/dt2Column.test.ts test/unit/cavePicker.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 18: DT2.caveBiomeProbe max 0, gated from SP6b on every tier (spec §12.5, D26; holds by construction; new part, measured 0 on fast).`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check from `<push base>`: the same key set as Task 17 (no new change: the probe changes no T output and no golden fixture reaches rule 4 yet). Expected: PASS.
- [ ] **Step 5: Commit** `feat(caves): caveBiomeAt; the surface probe tags and picks as T; DT2 caveBiomeProbe (SP6b §2.3)` (`git add src/gen/biomes/cavePicker.ts src/gen/surface/probe.ts src/gen/surface/context.ts src/gen/surface/pass.ts src/gen/pipeline/terrainStage.ts test/bench/noise.bench.ts test/harness/dt2.ts test/metrics/region.metric.ts test/thresholds.ts test/thresholds.lock.json test/unit/surfaceProbe.test.ts test/unit/dt2Column.test.ts test/unit/cavePicker.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 19: The floor I: `floorY`, g_b, S_b in `defs.steep`

**Files:**
- Modify:
  - `src/core/params/schema.ts` (`caves.noises.floor` appended last in `caves.noises` (2D, λ 48, 3 octaves); a `floor: group('Floor', …)` after `noises` and before `biomes`: `y` int −58 (−62 … −16, "Floor y"), `amp` 5 (0 … 12, "Floor relief"), `span` int 8 (1 … 32, "Floor softness"))
  - `src/core/params/defaultTrees.ts` (`floorY = add(param('caves.floor.y'), mul(param('caves.floor.amp'), abs(clamp(noise2('floor'), -3, 3))))`; in `cap` `:100-113` the gentle sum gains `g_b = clamp(mul(add(add(add(floorY, c(8)), span), neg(y())), recip(span)), 0, 1)`; the noodle's voxel-level cap likewise; `wetSteep` `:120` renamed `steep` = `add(S_w, S_b)` with `S_b = mul(c(128), clamp(mul(add(add(floorY, c(8)), neg(y())), c(0.125)), 0, 1))`; the root's two refs `:289`, `:291` read `ref('steep')`; the docs `:250-255`)
  - `src/core/params/presetTrees.ts` (amplified and floating_islands re-derive), the tests naming `defs.wetSteep`, the cost and count pins (Global Constraints)
  - U4's fixtures
  - `test/schema-shape.lock.json`
  - `README.md`
  - `src/metrics/liveness.ts` (the floor leaves on the default class column at the bottom)
  - `test/unit/liveness.test.ts:52` (191)
  - master §6.4's U2 row (191)
  - `test/arch/masterSpec.test.ts`
- Test: `test/unit/caveTerms.test.ts`, `test/unit/caveContinuity.test.ts`, `test/unit/defaultTrees.test.ts`, `test/unit/gv8Trees.test.ts`, `test/unit/paramPanel.test.ts` (Task 17's pin: the Caves section ends Cave noises (Floor noise last), Floor (Floor y, Floor relief, Floor softness), Cave biomes)

**Interfaces:**
- Produces: the tree's `defs.steep` (S_w + S_b); the root's paths unchanged (`root.a.a.b.b` and `root.a.b.b` the two refs).

- [ ] **Step 1: Write the tests.**
  - `caveTerms.test.ts`: "the floor closes every noise family (§5.2)": over 64 columns of seed '42' and the leaves at their range ends (`caves.floor.y` −62 and −16; `amp` 0 and 12; `span` 1 and 32), no voxel with final density ≤ 0 lies at y ≤ floorY(x, z) + 4 among the caves slot's and the noodle's air, and none below `caves.floor.y` + 5; the default-valued expectations are written from `DEFAULTS.caves.floor`, not as literals, so a floor lever (Task 25c-d, or the Global Constraints' early levers) moves them with the leaf: at the defaults none below `y` + 5 (−53 today); floorY at a position with Nf 0 is `y` (−58), with |Nf| ≥ 3 is `y + 3·amp` (−43).
  - `caveContinuity.test.ts`: the steep part closes over 8 blocks (90 % → 10 % air within 8 blocks above floorY + 4).
  - `defaultTrees.test.ts`: the paths above; `defs.wetSteep` is gone and `defs.steep` holds both terms; the recomputed counts.
  - `gv8Trees.test.ts`: the GV8 default density tree now differs from `DEFAULT_DENSITY_TREE`, and `MIGRATIONS[3]` maps it there.
  - SP6b describe: §6.4's U2 row count 191.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/caveTerms.test.ts test/unit/caveContinuity.test.ts test/unit/defaultTrees.test.ts test/unit/gv8Trees.test.ts test/unit/liveness.test.ts test/unit/paramPanel.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the mirrors.
- [ ] **Step 4: Run** `npm run typecheck && npm test` (a C1, `C4.bands` or `C5.thinnest` miss on fast: the Global Constraints' early floor levers, in this commit); the golden check from `<push base>`: Task 17's keys plus `sp3b.density.default` and, if its fixture columns hold cave air within the floor's reach, `sp3c.surface.ops` (its probe columns fill and carve with the default density tree, `src/metrics/sp3cGoldens.ts:126-135`, `src/gen/surface/probe.ts:50-55`); `sp6a.density.ops` unchanged. Expected: PASS.
- [ ] **Step 5: Commit** `feat(caves): the rock floor in the density tree: floorY, its gentle and steep parts (SP6b D6)` (`git add src/core/params/schema.ts src/core/params/defaultTrees.ts src/core/params/presetTrees.ts src/metrics/liveness.ts test/goldens.json test/schema-shape.lock.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/fixtures/expected-v3.json test/fixtures/expected-v4.json README.md test/unit/caveTerms.test.ts test/unit/caveContinuity.test.ts test/unit/defaultTrees.test.ts test/unit/gv8Trees.test.ts test/unit/liveness.test.ts test/unit/paramPanel.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/presetTrees.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`, and each test naming `defs.wetSteep` by explicit path).

---

### Task 20: The floor II: σ_b; `C7.bottomPlane` gated, `bedrockExposed` recorded

**Files:**
- Modify:
  - `src/gen/caves/carvers.ts` (`CarverParams` `:133` gains `floor: { readonly y: number; readonly amp: number; readonly span: number }`; `carverParamsOf` `:333`)
  - `src/gen/caves/carve.ts` (`export function floorYAt(p: CarverParams, n: Noise2, x: number, z: number): number` (the tree's operation order); `carveShrink` `:104` and `carveTest` `:116` gain `floorY: number`: σ = max(σ_w, σ_i, σ_u, σ_b), σ_b = clamp((floorY + 8 + span − y)·(1/span), 0, 1); `carveColumn` and `carvedKind` compute floorY once per position from `noiseFor(ctx, 'caves.noises.floor')`; `carvedAt` likewise)
  - `src/gen/caves/carverCache.ts` (holds the floor noise)
  - `test/harness/carverParams.ts`
  - `test/harness/refs.ts` (`referenceCarve` with σ_b)
  - `test/metrics/caves.metric.ts` and `test/harness/caveMetrics.ts` (`C7.bottomPlane` = flat floor faces at y −63 over all flat faces, per group: `metricTest('C7', ['bottomPlane'], …, { outName: 'C7.bottomPlane' })` registered in every group, each job gating its own regions, so the worst group is gated (Task 2's split); `C7.bedrockExposed` = cave-air voxels face-adjacent to a bedrock voxel, written to `.out/caves.bottom.json` per group, not gated. `CaveGrid` gains a block-class channel (`cls: Uint8Array`, one per voxel: 0 other, 1 bedrock, 2 abyss rock, one of the five abyss states, used by Task 28), filled by `caveGridOf` from `sectionBlocks`; `setCell` takes an optional class for hand-built fixtures; `bedrockExposed` reads it (the grid's byte holds only `tag | SOLID | FLUID`, `:86-90`, `:141`, and rule 1 dithers bedrock over y −63 … −60 among solid voxels, so "solid" is not "bedrock"))
  - `test/harness/caveRegionWorker.ts` (Task 4's per-region counts gain the new fields)
  - `test/thresholds.ts` (`C7.bottomPlane: { max: 0.01, activeFrom: 'SP6b' }`)
  - `test/thresholds.lock.json`
  - `README.md`
  - master §3.6 and §3.8 (item 15)
  - `test/arch/masterSpec.test.ts` (the SP6a §3.6 test's `want` lines MST:2101-2103 (cap_f, S_w, final) and :2111 moved into the SP6b describe, rewritten with g_b, S_b and `defs.steep`, still cross-checked against `DEFAULTS.caves`)
  - `test/integration/caveSavedWorld.test.ts` (Review Focus 2)
- Test: `test/unit/carve.test.ts`, `test/unit/refsCarve.test.ts`, `test/unit/carverPaths.test.ts`, `test/unit/cavesMetric.test.ts`

- [ ] **Step 1: Write the tests.**
  - `cavesMetric.test.ts`: `caveGridOf` fills `cls` from the blocks (bedrock 1, each abyss state 2, else 0); on a hand-built grid a cave-air voxel above a class-1 voxel counts one `bedrockExposed` and above a plain solid voxel none; the per-region counts from `caveRegionWorker` still equal the in-process ones.
  - `carve.test.ts`: "carvers shrink to nothing at y ≤ floorY + 8 (§5.2)": over 64 columns no carved voxel at y ≤ floorY(x, z) + 8 (at the defaults none below `DEFAULTS.caves.floor.y` + 9, −49 today, written from `DEFAULTS`, not as a literal); `floorYAt` equals the density tree's floorY bit for bit at 64 positions (as wet′ is pinned equal); σ_b is 0 at y ≥ floorY + 8 + span.
  - `refsCarve.test.ts`: the reference carves exactly as T.
  - `caveSavedWorld.test.ts`, Review Focus 2: "a GV8 world record (`schemaVersion: 4`, both trees from `test/fixtures/gv8-*-trees.json`, a `ColumnDiffV1` digging (x, −60, z) where today's T leaves rock under the floor and placing stone at a cave voxel above it) opened through `openPersistWorld`: both trees are today's (`toBe`); `olderGenerator` true; the dug voxel reads air with cave byte 0 and the placed stone keeps its column's byte; `meshXray` emits no wall toward the dug voxel".
  - SP6b describe: "§3.6 and §3.8: the floor as built, DEFAULTS.caves cross-checked (SP6b spec §15 item 15)": §3.6 contains `floorY(x, z) = caves.floor.y + caves.floor.amp·|Nf|`, the g_b and S_b terms, `defs.steep`, and §3.8 σ_b; the values equal `DEFAULTS.caves.floor`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch --project integration test/unit/carve.test.ts test/unit/refsCarve.test.ts test/unit/carverPaths.test.ts test/unit/cavesMetric.test.ts test/integration/caveSavedWorld.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Measure** `npx vitest run --project metrics-quick test/metrics/caves.metric.ts` (every group): `C7.bottomPlane` ≤ 0.01 (from 15.7-34.5 %); `C7.bedrockExposed` per group recorded in `.out/caves.bottom.json`; `C7.carverReference` 0. A `bottomPlane` above 0.01 goes to the floor's terms (a family or carver the floor misses), never to the bound. `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 20: C7.bottomPlane max 0.01, gated from SP6b on every tier (spec §12.3, D26; holds by construction under §5.2; new part, measured <values> on quick).`
- [ ] **Step 5: Run** `npm run typecheck && npm test` (a C1, `C4.bands` or `C5.thinnest` miss on fast: the Global Constraints' early floor levers, in this commit); the golden check from `<push base>`: Task 19's key set, plus `sp3c.surface.ops` if it first moves here (σ_b in the probe's carve; it may move again) (`sp6a.carver.paths` unchanged: σ_b acts at carve time). Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): carvers shrink above the rock floor; C7.bottomPlane gated (SP6b D6, §12.3)` (`git add src/gen/caves/carvers.ts src/gen/caves/carve.ts src/gen/caves/carverCache.ts test/harness/carverParams.ts test/harness/refs.ts test/metrics/caves.metric.ts test/harness/caveMetrics.ts test/harness/caveRegionWorker.ts test/unit/cavesMetric.test.ts test/thresholds.ts test/thresholds.lock.json test/goldens.json README.md test/unit/carve.test.ts test/unit/refsCarve.test.ts test/unit/carverPaths.test.ts test/integration/caveSavedWorld.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 21: C7's bottom parts; `bedrockExposed` gated; the `bottomCavern` pose

**Files:**
- Modify:
  - `test/harness/caveMetrics.ts` (`bottomFlatRatio`: the share of flat floor faces (≥ 6 × 6 patches) among wall faces for cave voxels at y ≤ −40, over the same share at y −40 … 0; `bottomFloorSpread`: per cave component ≥ 10k voxels with floor faces at y ≤ −40, the p10-p90 range of its floor faces' y at y ≤ −32, the median over components; recorded: the flat-floor histogram y −64 … −32, `bottomFloorPeak` (C4's `floorPeak` restricted to floor faces at y ≤ −32), cave air per 16-block band at the bottom; `caveExamples` gains `bottomCavern`, the widest component's floor at the bottom, its pose looking along the floor)
  - `test/metrics/caves.metric.ts` (the parts written to `.out/caves.bottom.json`; `C7.bedrockExposed` becomes a `metricTest` part, `metricTest('C7', ['bedrockExposed'], …, { outName: 'C7.bedrockExposed' })` registered in every group, each job gating its own regions)
  - `test/harness/caveRegionWorker.ts` (the returned counts gain the bottom parts' accumulators)
  - `test/thresholds.ts` (`C7.bedrockExposed: { max: 0, activeFrom: 'SP6b' }`)
  - `test/thresholds.lock.json`
- Test: `test/unit/cavesMetric.test.ts`

- [ ] **Step 1: Write the tests** (hand-built grids): a flat 20 × 20 floor at y −50 gives `bottomFloorSpread` 0 and a large `bottomFlatRatio`; a floor rising 0.5 per block over 20 blocks gives spread ≈ 8; a cave voxel above a bedrock voxel counts one `bedrockExposed`; `bottomCavern` is the component with the most floor faces at y ≤ −40.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Gate `bedrockExposed` only if Task 20's `.out` read 0 on every group (default and presets); a non-zero group goes to the floor's terms first (a kind-9 or preset body air under the floor: S_b joins that term), re-measured, then gated.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npx vitest run --project metrics-quick test/metrics/caves.metric.ts`; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 21: C7.bedrockExposed max 0, gated from SP6b on every tier (spec §12.3; measured 0 on every group on quick in Task 20 and here).` Expected: PASS.
- [ ] **Step 5: Commit** `test(caves): C7's bottom parts recorded; bedrockExposed gated; the bottomCavern pose (SP6b §12.3)` (`git add test/harness/caveMetrics.ts test/harness/caveRegionWorker.ts test/metrics/caves.metric.ts test/thresholds.ts test/thresholds.lock.json test/unit/cavesMetric.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 22: Rule 4 in the built-in trees; `cavePatch`, `strataOffset`

**Files:**
- Modify:
  - `src/core/params/schema.ts` (`surface.noises` `:160-164` gains `cavePatch` (λ 12, 2 octaves) and `strataOffset` (λ 128, 2 octaves) after `bandOffset`)
  - `src/core/params/defaultTrees.ts` (rule 4 inserted at `root.rules[2]` of `DEFAULT_SURFACE_RULES`, exactly §3.4's tree with `addSurfaceDepth: false` on every `stoneDepth` (Spec correction 10), both `noiseThreshold` fields (±8 for "no bound"), the strata of §3.3's defaults with `amp` 6 and `noise: 'surface.noises.strataOffset'`)
  - `src/core/params/presetTrees.ts` (floating_islands keeps its `root.rules[1]` derivation, `:215-221`; rule 4 at `root.rules[2]`; the comment `:213` → `root.rules[3]`), the paths naming `root.rules[2]` as the deepslate gradient → `root.rules[3]`: `test/unit/surfaceDefaults.test.ts:91`
  - `test/unit/inspectorForm.test.ts:126-127`, `:170-171`, `:203-209`
  - `src/metrics/liveness.ts:363` (U2's pinned perturbation "the deepslate gradient's upper bound 8 → 12": `['rules', 3, 'if']`) with its doc comment `:353`; the two noises on a biome witness; `test/unit/liveness.test.ts:279-280`
  - the default rule tree's pins (rule 4 changes `DEFAULT_SURFACE_RULES`): `test/fixtures/sp3c-default-rules.json` and `test/harness/legacyTrees.ts`' `legacyDefaultSurfaceRules` (`:63`) both gain rule 4 (or the pins retarget a new fixture, recorded in the commit); `test/unit/surfaceDefaults.test.ts:65-95` (the fixture equality and the full leaf list), `:157-170`; `test/unit/defaultTrees.test.ts:262-278` (the fixture, the legacy tree, the node count 163); `test/unit/surfaceResolve.test.ts:127-128`; `test/unit/inspectCost.test.ts:236-306` (node count, `RULES_DEFAULT` 2,169,856, `:263`'s `RULES_COLUMN_COST_MAX` pin reworded to "the SP6a default's 64 ×" with the SP6a value as a literal, `:276-277`'s `rules[2].if` → `rules[3].if`); `test/unit/presetTrees.test.ts:92-93`; `test/unit/inspectorModel.test.ts:98-109`; `test/unit/perfHook.test.ts:150`; `test/unit/fixtures/editedTrees.ts:92` (`gradientTop` → `rules[3]`, read by `paramTrees.test.ts:148`); and every other `rules[2]` / `'rules', 2` a grep of `test/` finds that assumes the deepslate gradient (`crossSectionVoxels.test.ts:436`, `fieldSlice.test.ts`, `fieldSliceJob.test.ts`, `fieldSliceHeavy.test.ts`, `fieldSliceProtocol.test.ts` are checked: a path that still names a rule after the insert may stay)
  - `src/gen/inspect/cost.ts` (`rulesCost` `:359-397`, Spec correction 20: a ceiling bound for leaves whose depth gates are all `stoneDepth{ceiling}`, the non-sky floor bound, a `caveBiome`-gated leaf costed as evaluated only at its class's bound, `strata` as a leaf beside `block`/`bandlands`; `tColumnCost` then moves the `blocks`/`rule` slice costs, `src/gen/inspect/fieldSlice.ts:706-708`, and their pins move), `test/unit/inspectCost.test.ts` (the new `RULES_DEFAULT`), `test/unit/sliceCost.test.ts`; `RULES_COLUMN_COST_MAX` (`src/core/constants.ts:106`) stays 138,870,784 **(plan)**
  - `src/metrics/sp3cGoldens.ts` (`surfaceOpsRules` gains a `caveBiome` node (any side) and a `strata` leaf on `surface.noises.strataOffset`, both reachable on the fixture columns now that the probe tags, Task 18; the header comment `:5-6`) and `test/unit/goldens.sp3c.test.ts` (Tasks 12-13's reduced kind assertions restored to the full `RULE_KINDS` and `CONDITION_KINDS`; the fixture's fast-path tests re-checked: non-sky-gated, Y-only leaves before and after); `sp3c.surface.ops` is an allowed key of the push
  - `test/unit/surfaceCompile.test.ts`, `test/unit/surfaceFuzz.test.ts` (Task 15's rule-4 fixture re-pointed to `surface.noises.cavePatch` and `strataOffset`)
  - `test/unit/liveness.test.ts:52` (193)
  - master §3.11 (`:807`, `:816`, the "As built" paragraph; item 12)
  - §6.4's U2 row (193)
  - `test/arch/masterSpec.test.ts` (MST:1992 moved)
  - U4's fixtures
  - `test/schema-shape.lock.json`
  - `README.md`
  - `test/integration/caveSavedWorld.test.ts` (Review Focus 2's extension), the SP6b spec (Spec corrections 10, 20)
- Test: `test/unit/surfaceDefaults.test.ts`, `test/unit/floatingRules.test.ts`, `test/unit/surfacePass.test.ts`, `test/unit/gv8Trees.test.ts`

- [ ] **Step 1: Write the tests** (hand-built columns with tags, and generated ones).
  - `surfaceDefaults.test.ts`, "rule 4 (§3.4)": a lush floor (floor biome 1) gets moss_block at floorDepth 0 and 1 where `cavePatch` < 0.84 and clay where ≥ 0.84; under a plain cave over lush rock: no moss; a dripstone floor and ceiling get dripstone_block two deep except where `cavePatch` ≤ −0.97 (stone or deepslate); a lush ceiling gets moss at ceilDepth 0 where `cavePatch` ≥ −0.52; in the abyss every solid voxel where `caveBiomeAt` is abyss, that rule 1 (bedrock, `root.rules[0]`) and rule 3 (open sky) do not take and that is not an ash floor voxel, takes one of the four strata states (no stone, no deepslate), and its floors abyss_ash at floorDepth ≤ 1 where `cavePatch` ≥ −0.84; nothing on a bedrock-resting ceiling; an open-sky floor (a ravine) keeps the surface palette; rule 4 places no grass_block, snow_block or red_sand.
  - Over 64 generated columns at seed '42': the shares of patch blocks on lush floors 0.2 ± 0.08, moss on lush ceilings 0.7 ± 0.1, ash on abyss floors 0.8 ± 0.1, bare stone on dripstone floors 0.17 ± 0.08 (recorded; the bounds are a sanity check on z2 ≈ N(0, 1)).
  - `floatingRules.test.ts`: the `was` check of `root.rules[1]` holds; rule 4 at `root.rules[2]`.
  - `surfacePass.test.ts`: the pass with the fast path equals full evaluation on 64 columns of each built-in tree.
  - `gv8Trees.test.ts`: both GV8 surface trees now differ from the live ones and migrate to them.
  - `inspectCost.test.ts`: `rulesCost` with the classes above prices the default tree with rule 4 at its new `RULES_DEFAULT` (bounded: ceiling leaves at their ceiling bound, not 98,304 per node) and the SP6a tree at 2,169,856 still; a `strata` leaf under a Y-only path is fast.
  - `goldens.sp3c.test.ts`: the fixture tree uses every rule and condition kind again, `caveBiome` and `strata` included.
  - `caveSavedWorld.test.ts`: "the placed stone keeps its state (rule 4 never runs on a published edit)".
  - SP6b describe: "§3.11: rule 4 at root.rules[2], as built (SP6b spec §15 item 12)": the order line contains `SP6b inserted rule 4 at \`root.rules[2]\`; the deepslate gradient is \`root.rules[3]\``; rule 4's text names moss_block, clay, dripstone_block, the strata and abyss_ash with `(clay under cave water in lush, gravel under cave water elsewhere: SP7, with aquifers)`; the As built paragraph names the terrain stage's version 5 and `GENERATOR_VERSION` 9; MST:1992 moved; the U2 count 193.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch --project integration test/unit/surfaceDefaults.test.ts test/unit/floatingRules.test.ts test/unit/surfacePass.test.ts test/unit/gv8Trees.test.ts test/unit/inspectorForm.test.ts test/unit/inspectCost.test.ts test/unit/goldens.sp3c.test.ts test/unit/liveness.test.ts test/integration/caveSavedWorld.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the mirrors.
- [ ] **Step 4: Run** `npm run typecheck && npm test` (S1, S2, T4 on fast; U2 with the noises' witness; a C1, `C4.bands` or `C5.thinnest` miss on fast: the Global Constraints' early floor levers); `npx vitest run --project metrics-quick test/metrics/surface.metric.ts` with `METRICS_PROFILES=default` (S1 `buried` 0, `grassNoSky` 0, `grassSky0` ≤ 0.001; S2 `bedrockFloor` ≥ 1, `deepslateBelow0` ≥ 0.95); the golden check from `<push base>`: Task 20's key set, with `sp3c.surface.ops` (it moves again: the fixture tree gains `caveBiome` and `strata` here; the fixture holds no rule 4). Expected: PASS.
- [ ] **Step 5: Commit** `feat(surface): rule 4, the cave floors, ceilings and the abyss's rock in the built-in trees (SP6b §3.4)` (`git add src/core/params/schema.ts src/core/params/defaultTrees.ts src/core/params/presetTrees.ts src/metrics/liveness.ts src/metrics/sp3cGoldens.ts src/gen/inspect/cost.ts test/goldens.json test/schema-shape.lock.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/fixtures/expected-v3.json test/fixtures/expected-v4.json test/fixtures/sp3c-default-rules.json test/harness/legacyTrees.ts test/unit/fixtures/editedTrees.ts README.md test/unit/surfaceDefaults.test.ts test/unit/floatingRules.test.ts test/unit/surfacePass.test.ts test/unit/gv8Trees.test.ts test/unit/inspectorForm.test.ts test/unit/inspectorModel.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/defaultTrees.test.ts test/unit/surfaceResolve.test.ts test/unit/presetTrees.test.ts test/unit/perfHook.test.ts test/unit/goldens.sp3c.test.ts test/unit/surfaceCompile.test.ts test/unit/surfaceFuzz.test.ts test/unit/liveness.test.ts test/integration/caveSavedWorld.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, and each other retargeted `rules[2]` pin by explicit path).

---

### Task 23: B3 I: shares per 8 × 8 km window

**Files:**
- Modify:
  - `test/harness/terrainScatter.ts` (`analyseColumn` counts cave air = tagged, air, no fluid, under its nibble, per window of the default profile's ±16,384-block square (4 × 4 windows of 8,192 blocks), per depth band (0.1 bins of (Y0 − y)/D from the column's pass), per 16-block y band and per kind; the large_biomes profile per 32 × 32 km window. `ScatterColumn` (`:43-48`) gains `sectionFluid(sy): Uint8Array | number` (a `ColumnView` already has it); `analyseColumn` (`:221-229`) gains an optional trailing `caveDepth: ((x: number, y: number, z: number) => number) | null = null`, built in the region worker (Task 3) from the column's `CaveColumnPass` (Y0 and `depthScale` from `cavePickerOf(ctx)`); null skips the depth-band histogram)
  - `test/harness/regionWorker.ts` (builds `caveDepth` per column)
  - `test/metrics/terrain.metric.ts` (B3's per-window record written to `.out/B3.windows.json`: per window lush, dripstone, abyss and plain shares and cave-air count; the minima `lushMin`, `dripstoneMin`, `abyssMin`, `windowAir`; Task 30's gated call keeps `outName: 'B3.shares'`, so neither file overwrites the other), the SP6b spec (`## Exit evidence`); `test/metrics/presets.metric.ts:499` unchanged (the parameter is optional)
- Test: `test/unit/terrainScatter.test.ts` (its fakes gain `sectionFluid`)

- [ ] **Step 1: Write the tests.** A fake column set with known nibbles gives the expected per-window shares; a window with fewer than 50,000 cave-air voxels is flagged (`windowAir`); sliced-and-summed (Task 3) still equals serial with the new accumulators.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/terrainScatter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `METRICS_PROFILES=default npx vitest run --project metrics-quick test/metrics/terrain.metric.ts`: the 16 windows' values into Exit evidence. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): B3's cave-biome shares per 8 × 8 km window, recorded (SP6b §12.1)` (`git add test/harness/terrainScatter.ts test/harness/regionWorker.ts test/metrics/terrain.metric.ts test/unit/terrainScatter.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 24: D25's generator checkpoint; `caveBiome.column`

**STOP for the user before Step 3:** PRIME on-demand, eDP-1 at 240 Hz, `LockedHint=no`, the 1-minute load below 1. The controller asks and waits.

**Files:**
- Modify:
  - `test/bench/noise.bench.ts` (the row `caveBiome.column`: `fillCaveColumnPass` plus the step's picks over T's tagged voxels, per column; log lines: evaluated voxels per class of the surface pass, the cave channel's bytes per column)
  - `test/bench/gates.ts` (`BENCH_ROWS` gains `'caveBiome.column'` after `'terrain.real'` **(plan)**)
  - `test/unit/benchGates.test.ts`
  - `test/baselines.json` (re-recorded), the SP6b spec (`## Exit evidence`: "### D25's generator checkpoint (Task 24)"; Spec correction 2)

- [ ] **Step 1: Node** (quiet machine; an agent touching no other process): `BENCH_EXEMPT=terrain.real,terrain.islands,surface.column,caveBiome.column npm run bench` twice; `npx vitest run --project metrics-quick test/metrics/caves.metric.ts` (every group) and `METRICS_PROFILES=default npx vitest run --project metrics-quick test/metrics/terrain.metric.ts`; the abyss's air without the floor: a scratch script (in the scratchpad, never committed) running B3's window count on the default profile with `caves.floor.y` set to −200 past `checkParams` (a measuring run only), then with the defaults.
- [ ] **Step 2: Screenshot** the `bottomCavern` pose (`.out/caves.examples.json`) at RD 12: `uiSmoke.ts` takes only `--skip-build`, `--profile-dir` and `--shots DIR` (`test/tools/uiSmoke.ts:177`), and `--shots` shoots its literal poses only, so **(plan)** a scratch CDP script in the scratchpad (never committed) imports `test/tools/cdp.ts`' helpers (`freePort`, `startPreview`, `startChrome`, `connect`), opens `/?at=x,z&y=…&yaw=…&pitch=…&rd=12` at the pose with its own free port, its own headless Chrome and a `mktemp -d` profile, saves one PNG into the scratchpad, and stops only what it started.
- [ ] **Step 3: Chrome** (the STOP's conditions; cold shader cache): `npm run measure:chrome -- --route bench --gpu iris --probe-only`, then `… --route bench --gpu iris --workers 4`; the cave channel's shared memory at RD 12 (`sabMB` against SP6a's); the file not committed. `measureChrome.ts` still writes into `assets/sp6a` until Task 49 (`:71`, `:933-990`; no output option), over committed SP6a evidence that `g1.metric.ts` and `benchFiles.test.ts` read: read `sabMB` from the run's file, copy the file into the scratchpad, then restore the committed SP6a files with `git checkout -- docs/superpowers/specs/assets/sp6a/` (a working-tree restore) and move any new file the run wrote there into the scratchpad, before Step 6; `git status --short docs/superpowers/specs/assets/` shows nothing.
- [ ] **The evidence table:**

  | measure | estimate (spec) | run 1 | run 2 | gate or trigger |
  |---|---|---|---|---|
  | `terrain.real` p50 / p99 | +0.1-0.3 ms over 10.46 / 16.76 | | | ≤ 13 / 20; p50 > 12 → find the fast-path leak first |
  | `terrain.islands` p50 / p99 | +0.3-0.6 ms over 11.89 | | | ≤ 14.5 / 26.5; a miss → lever 25e |
  | `caveBiome.column` | 0.1-0.2 ms | | | recorded |
  | evaluated voxels per class (surface pass) | ≈ 0.4k for biome runs | | | recorded |
  | B3 per window: lush, dripstone, abyss min | 17.6 / 13.4 / 5.6 % overall | | | each ≥ 0.005; a miss → levers 25a-25b |
  | B3 per depth band | — | | | recorded |
  | the abyss's air with / without the floor | about a third lost | | | recorded |
  | abyss spacing: the median nearest-abyss distance from 64 seeded points within ±8 km at seed 42 (`caveBiomeAt` on §9.3's 16-block prefilter grid; a scratch script) | — | | | recorded (Task 48's text) |
  | C1 void share | 10-14 % of air lost | | | 0.05-0.15 |
  | C4's lowest band; `C4.floorPeak` (before: Task 4's quick `.out` at the push base, per group) | ≥ 2 %; 0.014-0.049 | | | ≥ 0.02; ≤ 0.1; a miss → lever 25c |
  | C5's thinnest median | 4 | | | ≥ 4; a miss → lever 25c |
  | `C7.flatWallShare` (before: Task 4's quick `.out`) | falls from 0.0319 | | | ≤ 0.037 |
  | `slice.caves128` p50 (σ_b joins `carvedKind` and `carvedAt` in Task 20) | about 280 ms | | | ≤ 300; a miss → lever 25f |
  | `C7.bottomFloorSpread`; the screenshot | 7-8 blocks; not a plane | | | ≥ 6; a miss or a plane → lever 25d |
  | `C7.bedrockExposed` per group | 0 | | | 0 |
  | the cave channel's shared memory at RD 12 | — | | | recorded |
  | the levers applied | — | | | Task 25 |

- [ ] **Step 4: The rule** (D25, §12.5): any trigger above → **Task 25's levers in its order**, each measured by Steps 1-2 before the next, all before Task 26; a miss after them → **STOP for the user** with every measurement. Otherwise nothing runs; recorded either way.
- [ ] **Step 5: Record** `npm run bench:record` (quiet machine); `npm run bench` within every gate and the +30 % rule.
- [ ] **Step 6: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 7: Commit** `perf(bench): caveBiome.column; D25's generator checkpoint measured (SP6b D25)` (`git add test/bench/noise.bench.ts test/bench/gates.ts test/unit/benchGates.test.ts test/baselines.json docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 25: Levers I (conditional): the generator checkpoint's

Run only when Task 24's rule fires; each lever one commit, measured (Task 24's Steps 1-2; Step 3 only when the memory was the miss, **STOP** before it), before the next; stop at the first that meets every trigger it answers. Output-changing levers re-record from `<push base>` (Task 22's key set), move the leaf default with every mirror (Global Constraints; the floor's unit expectations in `test/unit/caveTerms.test.ts` and `test/unit/carve.test.ts` follow `DEFAULTS.caves.floor`, Tasks 19-20) and amend §6.1 and §5.2 in the spec. A 25c lever already applied by Tasks 19-22 (the Global Constraints' early floor levers) is not repeated; 25c continues from the next step.

- [ ] **25a: the abyss's share** (`B3.abyssMin` < 0.005 in a window): `caves.biomes.abyss.depthMin` 1.0 → 0.9, then → 0.85; then `caves.biomes.abyss.eMax` −0.5 → −0.4; each re-measures B3 per window. Commit `fix(caves): the abyss's depth edge <v> (SP6b D25)`.
- [ ] **25b: STOP for the user** when the abyss still misses a window after 25a: the window gate's form (master :1505) with the measurements; the user's choice is entered with a Threshold-log line at Task 30.
- [ ] **25c: the floor too high** (C4's lowest band < 2 % or C5's thinnest median < 4): `caves.floor.y` −58 → −60 → −62 (the range's end), then `caves.floor.span` 8 → 4. Commit `fix(caves): the rock floor lowered to <v> (SP6b §10)`.
- [ ] **25d: the floor too flat** (`C7.bottomFloorSpread` < 6, `C7.bottomFlatRatio` > 1.5 or the screenshot reads as a plane): `caves.floor.amp` 5 → 7, then the floor noise's λ 48 → 32. Commit `fix(caves): the rock floor's relief <v> (SP6b §10)`.
- [ ] **25e: T over its gate** (`terrain.real` p50 > 12 after the leak hunt, or `terrain.islands` over 14.5 / 26.5): first the evaluated-voxel counts per class, then for floating_islands §3.5's lever, output-keeping: extension 3 treats the leaves gated by `yAbove{ISLAND_RUN_MIN_BOTTOM}` as a class of their own, so runs below the islands take the band state (`src/gen/surface/compile.ts`, the fuzz re-run). Commit `perf(surface): island-branch leaves as their own fast-path class (SP6b §3.5)`.
- [ ] **25f: `slice.caves128` over 300 ms** (σ_b's per-position floor noise in the carvers' probe path): the `deriveSeed` memo per kind (`src/gen/caves/carvers.ts:322`; D32), output-keeping, with a test that the carver paths are equal with and without it (no golden moves; `sp6a.carver.paths` unchanged). Commit `perf(caves): memoise the carvers' derived seeds per kind (SP6b D32)`. Task 46 then does not repeat it.
- [ ] **STOP:** a trigger still missed after its levers: every measurement to the user (D25); no gate is loosened.
- [ ] Each lever: `npm run typecheck && npm test`; its golden check; the measurement under Task 24's evidence; staging by explicit path.

---

### Task 26: B3 II: border parts on `caves` and `caves-presets`

**Files:**
- Modify:
  - `test/harness/caveMetrics.ts` (the grid's byte `tag & 15 | SOLID 16 | FLUID 32` gains the biome in bits 6-7, `:87-90`, `:141`; per job over its regions, overall and per biome pair: `borderLattice` (border faces between face-adjacent cave-air voxels of different biomes on planes ≡ 0 (mod 4) over the mean of residues 1-3, per axis, the ratio farthest from 1, `borderPlaneRatio`'s pattern `:41-45`), `straightBorder` (on horizontal layers every 4 blocks, the share of border edge length in axis-aligned straight runs ≥ 8), `flatBorder` (border faces in axis-aligned planar patches ≥ 4 × 4, `flatWallDetail`'s finder `:1264-1304`), the overall and per-pair border-face counts, the painted skin's mix within 2 blocks of a border per pair)
  - `test/harness/caveRegionWorker.ts`
  - `test/metrics/caves.metric.ts` (written to `.out/B3.borders.<group>.json`)
- Test: `test/unit/cavesMetric.test.ts`

- [ ] **Step 1: Write the tests** (hand-built grids): a border on the plane x = 32 plus a jittered border elsewhere in the grid (so residues 1-3 hold faces) gives `borderLattice` > 2 on the x axis; a border only on planes ≡ 0 (mod 4) gives NaN (no residue 1-3 faces: `ratio(a, 0)` is NaN, `caveMetrics.ts:426`, and `borderPlaneRatio`'s pattern leaves NaN ratios out, `:1066-1085`), which the gate fails as a NaN; a straight border on x = 32 gives `straightBorder` 1; a jittered border (Task 10's speckle on a 64 × 64 grid) gives `borderLattice` within 0.9-1.1 and `straightBorder` < 0.1; a 4 × 4 flat patch of border faces counts in `flatBorder`; the biome bits survive the grid's packing.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the `caves` and `caves-presets` shards locally; the values into Exit evidence. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): B3's border parts per job and biome pair, recorded (SP6b §12.2)` (`git add test/harness/caveMetrics.ts test/harness/caveRegionWorker.ts test/metrics/caves.metric.ts test/unit/cavesMetric.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 27: B3 III: the `caves-biomes` job; the biome region; `cave_heavy`'s C1, C2, C9

**Files:**
- Modify:
  - `test/harness/caveSites.ts` (Task 2's `caveSites` gains the `'biomes'` group: `cave_heavy`'s two 32 × 32-chunk regions at seed '42' on quick (4 seeds on full) and the **biome region**: the first 32 × 32-chunk region of the default profile at seed '42' whose climate-only scan (`samplePoint` on a 64-block grid, raw boxes) holds all three biomes, pinned as an exported literal `BIOME_REGION` with its scan and a re-check **(plan)**)
  - `test/metrics/caves.metric.ts` (`METRICS_CAVE_GROUPS=biomes` over `caveSites(TIER, 'biomes')`: B3's border parts there, each biome | plain pair ≥ 2,000 border faces or an insufficient-sample failure, lush | dripstone recorded; C1's `cave_heavy` void share as `metricTest('C1', ['caveHeavyMin', 'caveHeavyMax'], …, { outName: 'C1.caveHeavy' })` (both parts the same void share, recorded until SP12), C2 and C9 on `cave_heavy` written to `.out/caves.caveHeavy.json` (recorded, §12.3); the biomes group registers none of Task 2's C1-C9 calls and none of Tasks 20-21's C7 calls (`bottomPlane`, `bedrockExposed`; spec §10 and §12.3 name the default and preset groups), so "every group" in Tasks 20-21 means `default` and `presets`; the review poses written to `.out/caveBiomes.examples.json`: `lush`, `dripstone`, `abyss`, `biomeBorder` and `caveHeavySpawn`)
  - `test/harness/caveMetrics.ts` (`caveBiomeExamples`: per biome the first cave-air voxel with that nibble standing on a floor face in `BIOME_REGION`, yaw along the floor so floor and ceiling are in view; `biomeBorder` the first cave-air voxel whose neighbourhood holds both a biome's nibble and plain, looking across the border; `caveHeavySpawn` from `findSpawn` on the `cave_heavy` profile; Task 21's `bottomCavern` stays in `.out/caves.examples.json` and Task 56 merges the two files)
  - `test/thresholds.ts` (`C1.caveHeavyMin: { min: 0.10, activeFrom: 'SP12' }`, `C1.caveHeavyMax: { max: 0.22, activeFrom: 'SP12' }`, the fixture's pattern `test/unit/metric.test.ts:9`)
  - `test/thresholds.lock.json`, `.github/scripts/metricShards.mjs` (`caves-biomes: { files: [caves], env: { METRICS_CAVE_GROUPS: 'biomes' } }`, the 19th job)
  - `test/unit/shards.test.ts`
- Test: `test/unit/cavesMetric.test.ts`, `test/unit/shards.test.ts`

- [ ] **Step 1: Write the tests.** `cavesMetric.test.ts`: `caveSites('quick', 'biomes')` is `cave_heavy` ×2 plus `BIOME_REGION`; `BIOME_REGION` is the scan's first candidate holding the three biomes; a pair with 1,999 border faces fails with "insufficient sample"; on a hand-built grid each biome pose stands in cave air of its biome on a floor face and `biomeBorder`'s view crosses a border face. `shards.test.ts`: the matrix gains `caves-biomes` after `caves-presets` (19 jobs, or Task 6's count + 1).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts test/unit/shards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 27: C1.caveHeavyMin min 0.10, caveHeavyMax max 0.22, activeFrom 'SP12' (recorded in SP6b, gated in SP12; master :1508, :2009; spec §12.3).`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the `caves-biomes` shard locally (its wall recorded against §13's 3:10-4:00 cold estimate). Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): the caves-biomes job: the biome region, cave_heavy's C1, C2 and C9 (SP6b §12.2-§12.3)` (`git add test/harness/caveSites.ts test/harness/caveMetrics.ts test/metrics/caves.metric.ts test/thresholds.ts test/thresholds.lock.json .github/scripts/metricShards.mjs test/unit/cavesMetric.test.ts test/unit/shards.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 28: B3 IV: `abyssRockStraight`, the regular-grid check, recorded shares; L2 `abyssLit`

**Files:**
- Modify:
  - `test/harness/caveMetrics.ts` (`abyssRockStraight`: over exposed wall voxels (solid with a cave-air face neighbour) of the biome region and the default regions, the share of abyss-rock / other-rock boundary edge length in horizontal straight runs ≥ 8, `straightBorder`'s method on wall voxels; abyss rock = a wall voxel of `cls` 2, Task 20's block-class channel)
  - `test/harness/caveRegionWorker.ts` (the returned counts gain `abyssRockStraight`'s accumulators)
  - `test/metrics/caves.metric.ts` (`caves-biomes` and `caves`), a pure regular-grid check (`test/harness/caveZones.ts`, new: `caveBiomePoint` on a 64-block lattice over 64 × 64 km from `samplePoint`'s climate and `surfaceEst` and `cavePickerOf(ctx)`'s noises, at y = Y0 − D·depth for depths 0.3, 0.6 and 1.1, about 1 M points; `zoneAperiodicity` = per biome indicator C8's ratio at lags 256 … 16,384, the smallest, with the ratio per lag recorded in `.out`; `zonePeriodicDip` = min over L ≥ 1,024 of ratio(L) / max(ratio at lags < L) (Spec correction 19: the ratio is 1 minus the indicator's correlation, so zones that follow 1,600-2,400-block climate fields read about 0.2-0.4 at lag 256; a periodic field dips well below 1 at its period, a smooth random one rises and saturates near 1); recorded `zoneClarkEvans` (patch centroids ≥ 4 cells) and `zoneSizeSpread` (log-sd of patch areas))
  - `test/metrics/caves.metric.ts` (the grid check in `caves-biomes`; the biomes group's per-biome cave-air shares over `cave_heavy`'s two regions, recorded in `.out/B3.caveHeavy.json`)
  - `test/metrics/terrain.metric.ts` (recorded: large_biomes per 32 × 32 km window only; `terrain.metric.ts:71` generates only the default and large_biomes scatters, so `cave_heavy`'s shares come from `caves.metric.ts`)
  - `test/metrics/light.metric.ts` (`L2.abyssLit` recorded: abyss cave air with sky light > 0 or block light > 0)
- Test: `test/unit/cavesMetric.test.ts`

- [ ] **Step 1: Write the tests.** A horizontal abyss boundary across a 30-block wall gives `abyssRockStraight` 1; a speckled one < 0.1; on a fixed periodic indicator (period 512) `zoneAperiodicity` < 0.5 and `zonePeriodicDip` < 0.5, on a white-noise field `zoneAperiodicity` ≈ 1, on a smooth random field (wavelength ≥ 1,024) `zonePeriodicDip` ≥ 0.9; a square lattice of patches gives Clark-Evans ≈ 2.0 ± 0.1 (a hexagonal one ≈ 2.15 ± 0.1; Spec correction 18).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the `caves`, `caves-biomes` shards and `light.metric.ts` on quick locally; the values into Exit evidence; §12.2 reworded (Spec corrections 18, 19). Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): the abyss rock's boundary, the regular-grid check, L2 abyssLit, recorded (SP6b §12.1-§12.3)` (`git add test/harness/caveMetrics.ts test/harness/caveRegionWorker.ts test/harness/caveZones.ts test/metrics/caves.metric.ts test/metrics/terrain.metric.ts test/metrics/light.metric.ts test/unit/cavesMetric.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 29: U2-U4 over the new leaves

**Files:**
- Modify:
  - `src/metrics/liveness.ts` (only if the full tier finds a leaf decided on no witness there)
  - `test/unit/liveness.test.ts`
  - master §6.4's U2 row (as built: `; SP6b: the caves.biomes.* leaves are decided on a bounded biome witness, the floor leaves on the default class column at the bottom, surface.noises.cavePatch and strataOffset on a biome witness; U2 covers 193 leaves (amended by SP6b)`)
  - `test/arch/masterSpec.test.ts`, the SP6b spec (Spec correction 5)

- [ ] **Step 1: Write the pins.** SP6b describe: "§6.4's U2 row as built (SP6b spec §15 item 20)": the row contains the sentence above; n 193. `liveness.test.ts`: every new leaf's deciding column is the witness named; U4's registry check accepts the unchanged stage list (D15).
- [ ] **Step 2: Run** `METRICS_TIMEOUT_SCALE=3 npx vitest run --project metrics-full test/metrics/params.metric.ts` (U2, U3, U4 on full) and `npx vitest run --project unit --project arch test/unit/liveness.test.ts test/arch/masterSpec.test.ts`. Expected: PASS after the row.
- [ ] **Step 3: Run** `npm run typecheck && npm test`; the golden check from `<push base>` (Task 22's key set). Expected: PASS.
- [ ] **Step 4: Commit** `test(params): U2-U4 over SP6b's leaves on every tier; the U2 row as built (SP6b §12.7)` (`git add src/metrics/liveness.ts test/unit/liveness.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 30: Tuning: the dry run, the rows at their bounds, `cave_heavy`'s cheese offset

**Files:**
- Modify:
  - `test/metrics/terrain.metric.ts` (`metricTest('B3', ['lushMin', 'dripstoneMin', 'abyssMin', 'windowAir'], …, { outName: 'B3.shares' })`, registered only when the active profiles (`METRICS_PROFILES`) include `'default'`: the `terrain-large` job has no default-profile windows, and a missing value is an error, `test/harness/metric.ts:42`; still one literal call)
  - `test/metrics/caves.metric.ts` (three literal calls with disjoint parts, each registered by `METRICS_CAVE_GROUPS`, since a file runs in several jobs, a part may be covered by one call only (`metric.ts:170-172`) and "the worst job's value" cannot be computed inside one job: `metricTest('B3', ['borderLattice', 'straightBorder', 'flatBorder'], …, { outName: 'B3.borders' })`, each job gating its own regions so the worst job is gated: always in `biomes`, where each biome | plain pair needs ≥ 2,000 border faces or the part fails as an insufficient sample (§12.2, Task 27); in `default` and `presets` **(plan)** only when that group's overall border-face count (recorded by Task 26's parts; Step 1's dry run reads it on every tier) is ≥ 2,000 on every tier (the spec puts the pair minimum on `caves-biomes` only, and a group with no border face would read NaN, a failure); a group below it is recorded, not gated, and Exit evidence says so; `metricTest('B3', ['abyssRockStraight'], …, { outName: 'B3.abyssRock' })` in the default and biomes groups (the default regions and the biome region, §12.2; not presets); `metricTest('B3', [<the zone part Step 4 settles>], …, { outName: 'B3.zones' })` in the biomes group only; and `metricTest('C7', ['bottomFlatRatio', 'bottomFloorSpread'], …, { outName: 'C7.bottom' })` in the groups whose regions compute them (default and presets, as Task 21's `.out/caves.bottom.json`))
  - `test/thresholds.ts` (`B3: { lushMin: { min: 0.005 }, dripstoneMin: { min: 0.005 }, abyssMin: { min: 0.005 }, windowAir: { min: 50000 }, borderLattice: { min: 0.9, max: 1.1 }, straightBorder: { max: 0.1 }, flatBorder: { max: 0.05 }, abyssRockStraight: { max: 0.1 }, <the zone row Step 4 settles> }`, C7 `bottomFlatRatio: { max: 1.5 }`, `bottomFloorSpread: { min: 6 }`, each `activeFrom: 'SP6b'`)
  - `test/thresholds.lock.json`
  - `src/core/params/profiles.ts:38` (`cave_heavy`'s cheese offset) and `test/unit/profiles.test.ts` (Task 1's pin of `cave_heavy`'s cheese offset → the chosen value)
  - `src/core/params/schema.ts` (retuned defaults, if any)
  - `test/goldens.json`
  - `README.md`, the mirrors on a retune
  - master §3.15 (item 14)
  - §10 SP12's line (item 5)
  - §6.4 (item 20: B3's row with its parts, C1's "`cave_heavy` recorded from SP6b, gated in SP12", C7's bottom parts, C6's "1.1 pending (SP12, with the structural levers)", S2's note "the SP6b blocks leave `deepslateBelow0`'s counts"; cross-checked against `THRESHOLDS`)
  - `test/arch/masterSpec.test.ts`, the SP6b spec (`## Threshold log`, `## Exit evidence`)

- [ ] **Step 1: The dry run.** `METRICS_TIMEOUT_SCALE=3 npm run test:metrics:full` with C7, DT1, S1 and T1 one at a time: every part's value per tier against its bound, in a table in Exit evidence; C1-C9, L2, S1, S2, T4, DT1, DT2 re-asserted.
- [ ] **Step 2: `cave_heavy`'s cheese offset.** On quick, C1's `cave_heavy` void share at 0.43, 0.38, 0.33, 0.30 in that order (each a profile overlay change: no generated-output change of the default profile; `cave_heavy` is in no golden); the overlay takes the largest value whose share is ≥ 12 %; recorded with C2 and C9.
- [ ] **Step 3: Tune** (only on a miss): the leaves of §6.1 and the floor's, one change at a time, each re-run on quick; every change re-records from `<push base>` (Task 22's key set) and updates the mirrors. For `B3.abyssRockStraight` > 0.1, spec §10's levers in order: `caves.biomes.depthWarp` 10 → 16, then `caves.biomes.noises.depth` λ 96 → 48, each re-run on quick and re-recorded from `<push base>` with its mirrors (the schema lock, U4's fixtures, README, master §3.6's table); Step 4's STOP if it still misses.
- [ ] **Step 4: STOP for the user** when a master bound (B3's 0.5 %, C1-C9) still misses after the levers and the tuning, or a bound this spec proposes (B3's border parts, `abyssRockStraight`, C7's bottom parts) misses: the measurements go to the user, whose bound is entered with a Threshold-log line (SP6a D26's rule). `zoneAperiodicity` as specified (≥ 0.9) is expected to miss (Spec correction 19): Task 28's two measurements (`zoneAperiodicity` per lag and `zonePeriodicDip`) and the dip form go to the user before Step 5 writes the zone row; the user's choice (the part and its bound) is the row.
- [ ] **Step 5: The rows.** `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 30: B3 lushMin, dripstoneMin, abyssMin min 0.005, windowAir min 50000 (master :1505), borderLattice 0.9-1.1, straightBorder max 0.1, flatBorder max 0.05, abyssRockStraight max 0.1, <the zone part and bound the user chose at Step 4>; C7 bottomFlatRatio max 1.5, bottomFloorSpread min 6; gated from SP6b (spec §12.1-§12.3, D26; new parts; measured <values> on full; <the user's bounds, if any>).` Master items 5, 14 and 20's parts, with their pins (titles "§15 item 5", "§15 item 14", "§15 item 20").
- [ ] **Step 6: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(caves): B3 and C7's bottom parts at their bounds; cave_heavy's cheese offset <v> (SP6b §12)` (`git add test/metrics/terrain.metric.ts test/metrics/caves.metric.ts test/thresholds.ts test/thresholds.lock.json src/core/params/profiles.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, and on a retune `src/core/params/schema.ts test/goldens.json README.md` with each mirror that moved by explicit path).

---

### Task 31: The generator push: `sp6b.region.T.biomes`, the bench record, the push, CI

**Files:**
- Modify:
  - `src/metrics/sp6bGoldens.ts` (`sp6b.region.T.biomes`: `regionHash` of the first 8 × 8-chunk window, seed '42', default profile, holding a voxel of each biome 1-3 in its stored nibbles, scanned over the tiles of the biome region in `sp6a.region.T.caves`' order; the region mirrored as the literal `BIOME_SCAN_REGION` in `sp6bGoldens.ts` (a `metrics/` module cannot import `test/`, `test/arch/rules/imports.ts:25`; `sp6aGoldens.ts:173-174`'s `CAVES_SCAN_REGIONS` is the precedent), the window pinned as a literal `BIOMES_WINDOW` **(plan)**)
  - `test/goldens.json`
  - `test/unit/goldens.sp6b.test.ts` (pins `BIOME_SCAN_REGION` equal to `test/harness/caveSites.ts`' `BIOME_REGION`), the key-list pins (65)
  - `test/baselines.json`, the SP6b spec (`## Exit evidence`: "### The generator push (Task 31)")

- [ ] **Step 1: The last key.** `goldens.sp6b.test.ts`: `BIOME_SCAN_REGION` equals `BIOME_REGION`; the window holds each biome and is the scan's first candidate; `git checkout <push base> -- test/goldens.json && npm run test:goldens`; `git diff <push base> -- test/goldens.json` lists exactly `generatorVersion` 8 → 9, `sp1.params`, `sp3a.region.T.default`, `.large_biomes`, `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`, `sp6a.region.T.caves`, `sp3c.surface.ops`, `sp3b.density.default`, and the added `sp6b.caveBiome.points`, `sp6b.region.T.biomes` (65 keys); `npx --yes bun@1 test/tools/goldensJsc.ts` 65/65.
- [ ] **Step 2: The bench record** (quiet machine): `BENCH_EXEMPT=terrain.real,terrain.islands,surface.column,caveBiome.column npm run bench`; `npm run bench:record`; `npm run bench`: `terrain.real` ≤ 13 / 20, `terrain.islands` ≤ 14.5 / 26.5, every other gate and the +30 % rule; `surface.column` re-baselined (from 0.747 ms).
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS.
- [ ] **Step 4: Commit** `test(goldens): sp6b.region.T.biomes; the generator push's record (GENERATOR_VERSION 9)` (`git add src/metrics/sp6bGoldens.ts test/goldens.json test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp3c.test.ts test/unit/goldens.sp3e.test.ts test/unit/goldens.sp6a.test.ts test/unit/goldens.sp6b.test.ts test/baselines.json docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).
- [ ] **Step 5: Push** (the controller): `git push`. CI green (governance sees one bump against `<push base>`); the head SHA, the wall and each job (19, cold) recorded in the next docs commit against §13's estimates; the exit bound is Task 58's.

---

### Task 32: X-ray I: the mesher's biome bits; `R1.xrayBiome`

Tasks 32-60 change no generated output (each runs `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`) and are pushed at will.

**Files:**
- Modify:
  - `src/mesh/xray.ts` (the wall key `:116` becomes the whole byte `cave[v]` (kind | biome << 4; the film keeps 15 with biome 0); the merge keys on it `:125`; the sink `:69-77` writes `key & 15` into `kind` and `(key >> 4) & 15` into `biome` (`PACK_LAYOUT.xray`, `src/mesh/packing.ts:75`); the header `:12-14`)
  - `src/render/xrayPalette.ts` (`XRAY_BIOME_COLORS`: 16 entries, 0-3 from `CAVE_BIOME_COLORS`, 15 `#c8c8c8`, the rest the unused colour; `XRAY_BIOME_LABELS`: 'Plain cave', 'Lush', 'Dripstone', 'Abyss', 15 'Surface')
  - `test/harness/refs.ts` (`xrayKey` `:162` becomes `faceKey·256 + (kind | biome << 4)`; `bruteXrayFaces` `:175` keys on the voxel's whole byte (the film 15, biome 0); `meshFaceCounts` `:236`, `:255`, `:279` also decodes `PACK_LAYOUT.xray.biome`, so the mesh side's keys carry the biome too and R1.xray stays 0)
  - `test/metrics/render.metric.ts` (`R1.xrayBiome`: each X-ray face's biome bits against the nibble at its hollow voxel, mismatches; R1 records `quadsXray` on its existing sites, `:71-84`, no site added)
  - `test/thresholds.ts` (`R1.xrayBiome: { max: 0, activeFrom: 'SP6b' }`)
  - `test/thresholds.lock.json`
  - master §4.4 / §4.5 (item 16's half)
  - §6.4's R1 row (item 20's part)
- Test: `test/unit/meshXray.test.ts`, `test/unit/xrayPalette.test.ts`

- [ ] **Step 1: Write the tests.** `meshXray.test.ts`: a lush wall and a dripstone wall of one kind side by side make two quads with biome bits 1 and 2, merged with nothing across the biome change; one biome's wall merges as before; the film's biome is 0; a section with no nibble meshes byte-identically to before. `xrayPalette.test.ts`: the tables above. SP6b describe: "§4.4/§4.5: the xray word's biome bits written from the nibble (SP6b spec §15 item 16)", "§6.4's R1 row gains xrayBiome (SP6b spec §15 item 20)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/meshXray.test.ts test/unit/xrayPalette.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (before it, `npx vitest run --project metrics-quick test/metrics/render.metric.ts` on the previous commit, its `.out/R1.json` `quadsXray` kept in the scratchpad); `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 32: R1.xrayBiome max 0, gated from SP6b on every tier (spec §12.5; holds by construction; new part, measured 0; X-ray quads +<n> % on R1's sites, quick, this commit's .out/R1.json quadsXray over the previous commit's).`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npx vitest run --project metrics-quick test/metrics/render.metric.ts`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(mesh): the X-ray's walls carry their cave biome; R1.xrayBiome (SP6b §7.1)` (`git add src/mesh/xray.ts src/render/xrayPalette.ts test/harness/refs.ts test/metrics/render.metric.ts test/thresholds.ts test/thresholds.lock.json test/unit/meshXray.test.ts test/unit/xrayPalette.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 33: X-ray II: the material's colour mode

**Files:**
- Modify:
  - `src/render/materials/glsl/xray.glsl.ts` (`flat out uint vBiome = pkX_biome(data)` beside `:34`; `uniform vec3 xrayBiomePalette[16]; uniform float xrayColorMode;`; the colour `xrayColorMode > 0.5 && vKind != 15u ? xrayBiomePalette[vBiome] : xrayPalette[vKind]`, times the face shade `:63`)
  - `src/render/materials/uniforms.ts:28-35`, `:49-53`, `:122-129` (`xrayBiomePalette` linear from `XRAY_BIOME_COLORS`, `xrayColorMode` 0)
  - `src/render/materials/index.ts` (`MaterialSystem.setXrayColorMode(mode: 0 | 1): void`)
  - `src/render/renderer.ts` (`createXrayControl` `:628-667` gains `setColorMode(mode: 0 | 1): void`; `WorldRenderer.setXrayColorMode`)
  - master §4.5 (item 16's material half)
- Test: `test/unit/materials.test.ts`, `test/unit/renderer.test.ts`

- [ ] **Step 1: Write the tests.** `materials.test.ts`: both variants' X-ray material declares the two uniforms; the fragment source selects as above; `setXrayColorMode(1)` writes `xrayColorMode` 1 and nothing else. `renderer.test.ts`: `setXrayColorMode` reaches the uniform, allocates nothing over 10,000 calls (256 KB) and remeshes nothing (no `stage` call). SP6b describe: "§4.5: the X-ray pass coloured by kind or by cave biome by a uniform (SP6b spec §15 item 16)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/materials.test.ts test/unit/renderer.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): the X-ray's colour by cave type or cave biome, one uniform (SP6b §7.2)` (`git add src/render/materials/glsl/xray.glsl.ts src/render/materials/uniforms.ts src/render/materials/index.ts src/render/renderer.ts test/unit/materials.test.ts test/unit/renderer.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 34: X-ray III: C, the page's mode, the strip, the HUD, the notices

**Files:**
- Modify:
  - `src/player/keymap.ts` (`Action` `:19` gains `'xrayColor'`; after `:103`: `{ action: 'xrayColor', bindings: [code('KeyC', false)], label: 'X-ray colours: cave type or cave biome', group: 'view', since: 'SP6b' }`)
  - `src/ui/loading/tips.ts:35` (§9.4's tip text)
  - `src/ui/world/xrayStrip.ts` (`stripText(b: XrayBand, mode: 0 | 1): string` `:67` ends `· by cave type` or `· by cave biome`; the strip holds two prebuilt legends (kinds; Plain cave, Lush, Dripstone, Abyss, Surface) and shows one; `set(on, b, mode)` writes only what changed)
  - `src/ui/hud.ts:93`, `:134` (`xray: { band: XrayBand; mode: 0 | 1 } | null`)
  - `src/ui/world/worldPage.ts` (`createPageXray` `:2232-2272` gains `mode` and the `xrayColor` action: it flips the mode, calls `setXrayColorMode`, shows "X-ray by cave biome" / "X-ray by cave type" for `NIGHT_VISION_NOTICE_MS` 1,500; the first-X notice `:2204-2205` names C; the mode is page state, not saved)
  - master §5.9 (item 18's part)
  - `test/unit/zeroAlloc.test.ts`
- Test: `test/unit/keymap.test.ts:54` (44), `test/unit/tips.test.ts:13` (44), `test/unit/help.test.ts`, `test/unit/xrayStrip.test.ts`, `test/unit/hud.test.ts`, `test/unit/worldPage.test.ts`, `test/unit/zeroAlloc.test.ts`

- [ ] **Step 1: Write the tests.**
  - `keymap.test.ts`: 44 actions; `xrayColor` on plain C; Ctrl+C still matches `copy` only.
  - `tips.test.ts`, `help.test.ts`: the tip text; the Keys table's C row.
  - `xrayStrip.test.ts`: `stripText({all}, 1)` is `X-ray · y −64 … 319 · by cave biome`; a mode switch flips the two legends' `hidden` and rebuilds no node.
  - `worldPage.test.ts`: C toggles the mode with the X-ray off (shown at the next X) and on; the notice texts; Review Focus 1: "X on in biome mode, an Apply of `caves.biomes.lush.hMin` 0.4 → 0.2 settling over 30 fake frames with C at frame 5 and X twice at frames 10 and 11: the strip ends '· by cave type', `xrayColorMode` is 0 and `xrayOn` 1 at the end, the uniform written once per C, every column's shown seq is the Apply's"; Review Focus 5: "with the map split and the caveBiome y field focused (owner map, `ownerOf`), C is neither acted on nor prevented (`input.ts:132`)" (the field arrives in Task 45; until then a focused map toolbar input, and Task 45 re-pins the case on the real field).
  - `zeroAlloc.test.ts`: "N presses of C at a fixed band grow the heap by less than 256 KB (SP6b §7.3)".
  - SP6b describe: "§5.9 gains C (SP6b spec §15 item 18)": `C (X-ray colours: cave type or cave biome; SP6b)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/keymap.test.ts test/unit/tips.test.ts test/unit/help.test.ts test/unit/xrayStrip.test.ts test/unit/hud.test.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(world): C colours the X-ray by cave biome; the strip's and HUD's mode (SP6b D7)` (`git add src/player/keymap.ts src/ui/loading/tips.ts src/ui/world/xrayStrip.ts src/ui/hud.ts src/ui/world/worldPage.ts test/unit/keymap.test.ts test/unit/tips.test.ts test/unit/help.test.ts test/unit/xrayStrip.test.ts test/unit/hud.test.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 35: The terrain passes draw nothing under the X-ray; `applyDrawRange`

**Files:**
- Modify:
  - `src/render/regionBatch.ts` (passes 0-2 get an `onBeforeRender` that sets `_multiDrawCount` 0 while the X-ray is on, mirroring `xrayBeforeRender` `:172-179`; uploads continue)
  - `src/render/regionMesh.ts` (`applyDrawRange(a: Arena): void` derives the range from (culled — false until Task 43, the X-ray on for passes 0-2, the high-water mark); `setHighWater` `:322` and its callers `:400` (compaction), `:432` (growth) and `:563` (the last row's release), the upload's first-row span `:478-481` (raising `highWater`), and `setXray` `:620` (re-applied over every pass 0-2 arena; today it touches only the X-ray arenas) all call it (Spec correction 21; `arenaGeometry` starts at (0, 0), `:202`); passes 0-2 get (0, 0) while the X-ray is on, never `visible = false`)
  - master §4.5 (item 16's terrain-pass half), the SP6b spec (Spec correction 21)
- Test: `test/unit/regionBatch.test.ts`, `test/unit/regionMesh.test.ts`

- [ ] **Step 1: Write the tests.** `regionBatch.test.ts`: with the X-ray on a terrain batch's multi-draw count is 0 after `onBeforeRender` and its rows still upload; off, three's own list. `regionMesh.test.ts`: every writer (an upload taking a new span, a growth, a compaction, a release) during the X-ray leaves passes 0-2 at (0, 0) and the X-ray arenas visible; X on alone puts them at (0, 0) the same call; a reveal does not undo it; after X off each arena is back at (0, high water); `rowVisible` ignores the X-ray state (`:565-575`). The collapse uniform stays. SP6b describe: "§4.5: the terrain and water passes draw nothing while the X-ray is on (SP6b spec §15 item 16)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `perf(render): the terrain passes draw nothing while the X-ray is on; RegionMesh's one draw-range writer (SP6b D24)` (`git add src/render/regionBatch.ts src/render/regionMesh.ts test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 36: The strip and the F3 HUD in one top container

**Files:**
- Modify:
  - `src/ui/styles.css` (`.world-top { position: absolute; top: .5rem; left: .5rem; right: .5rem; display: flex; flex-wrap: wrap; align-items: flex-start; gap: .5rem; pointer-events: none; z-index: 2 }`; `.world-hud` `:42` loses its position, top, left and z-index; `.world-xray-strip` `:66` loses its position, left, top and transform and gains `margin-inline: auto; max-width: 40rem`)
  - `src/ui/world/worldPage.ts` (one `.world-top` per host, the HUD mounted then the strip, `:5217`, `:5231`; the bench's strip `:4689`)
  - `src/ui/hud.ts` (`mountWorldHud` takes the container)
- Create: `test/unit/worldTop.test.ts`

- [ ] **Step 1: Write** `worldTop.test.ts`: the host holds one `.world-top` whose children are the HUD then the strip; the CSS rules above (parsed from `styles.css`); with the HUD hidden the strip is the container's only visible child; the bench page uses the same container.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldTop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS (the rect check is Task 55's).
- [ ] **Step 5: Commit** `fix(world): the X-ray strip no longer covers the F3 counts (SP6b D8)` (`git add src/ui/styles.css src/ui/world/worldPage.ts src/ui/hud.ts test/unit/worldTop.test.ts`).

---

### Task 37: Culling I: the pure walk

**Files:**
- Create: `src/render/culling/caveCulling.ts`, `test/unit/caveCulling.test.ts`
- Modify: master §1 (`render/culling/` reads `caveCulling.ts (SP6b; frustum culling is three's per instance)` in place of `frustum.ts caveCulling.ts`, `:181`; item 6), `test/arch/masterSpec.test.ts` (an `SP6B_MODULES` row), the SP6b spec (Spec correction 22)

**Interfaces:**
- Produces:
  - `export const torusSlot = (cx: number, cz: number): number => ((cz & 63) << 6) | (cx & 63);`
  - `export interface CaveWalk { readonly conn: Uint16Array /* 98,304 */; readonly slotKey: Float64Array /* 4,096 */; readonly entry: Uint8Array; readonly entryWalk: Uint32Array; readonly queue: Int32Array; readonly stamp: Uint32Array; walkId: number; running: boolean; s0x: number; s0y: number; s0z: number }` (S0, the seed box's centre section, written by `startWalk` and read by the monotone rule); `export function newCaveWalk(): CaveWalk`
  - `export function setColumnConn(w: CaveWalk, key: number, cx: number, cz: number, conn: Uint16Array): boolean` (copies 24 values; true when some section gains a bit it lacked)
  - `export function clearColumn(w: CaveWalk, key: number, cx: number, cz: number): void`
  - `export function startWalk(w: CaveWalk, sx: number, sy: number, sz: number, inRange: (cx: number, cz: number) => boolean): void` (the seed box: the 3 × 3 × 3 sections around (sx, sy, sz), each seeded with every face an exit)
  - `export function stepWalk(w: CaveWalk, maxPops: number, inRange: (cx: number, cz: number) => boolean, isRevealed: (cx: number, cz: number) => boolean): boolean` (true when the walk completed; pop t: `exits` = the union over entered faces f of faces g with `connectivityBit(f, g)` set in `conn[t]`, at most 5 bit tests per face; the monotone rule relative to the box: +x only if sx ≥ S0x − 1, −x only if sx ≤ S0x + 1, likewise y and z; an unrevealed column in range reads 0x7FFF; a column out of range stops; nothing above section 23 or below 0; a popped section is pushed again when an entry bit it was not popped with arrives; each reached section stamped `walkId`)

- [ ] **Step 1: Write the tests** (synthetic `conn` grids).
  - "a sealed room culls everything outside": a sealed room of 5 × 5 × 5 sections whose outer faces join nothing, the eye at its centre section: after a walk only the room's 125 sections are stamped (a smaller room cannot hold the 3 × 3 × 3 seed box, whose sections are seeded with every face an exit).
  - "an L tunnel": a tunnel turning once is stamped along both legs and nothing past its walls.
  - "1-voxel apertures": connectivity built from padded blocks (`src/mesh/connectivity.ts:58`) with a 1-voxel hole at a section face, edge and corner, at distances 1, 4 and 10 sections: every section a ray through the hole can enter is stamped.
  - "unmeshed sections and unrevealed columns count as open"; "a column beyond range stops the walk".
  - "monotone ties at section planes": an eye seed on a section boundary reaches what both neighbours' boxes reach.
  - "the re-push of a popped section on a new entry bit": a section entered first by −x then by +y exits through the +y entry's faces too; each section outside the seed box is popped at most 3 + (the number of axes on which it lies in S0's plane) ≤ 5 times, a seed-box section once (Spec correction 22: a section sharing S0's x can be entered via +x and via −x).
  - SP6b describe: an `SP6B_MODULES` row `[/^\s+lod\/rings\.ts /, 'caveCulling.ts (SP6b; frustum culling is three\'s per instance)', 'src/render/culling/caveCulling.ts']` (§1's line `      lod/rings.ts fillMask.ts  culling/frustum.ts caveCulling.ts`, master :181) (item 6).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/caveCulling.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the queue as a ring over `queue` with a waiting mask per section in `entry` validated by `entryWalk` (no clearing per walk).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): cave culling's walk, monotone with entry faces from a seed box (SP6b D22)` (`git add src/render/culling/caveCulling.ts test/unit/caveCulling.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 38: Culling II: triggers, `drawAll`, slices

**Files:**
- Modify: `src/render/culling/caveCulling.ts` (the culler state machine)
- Test: `test/unit/caveCulling.test.ts`

**Interfaces:**
- Produces: `export interface CaveCuller { readonly walk: CaveWalk; drawAll: boolean; shown: number; enabled: boolean; setCamera(x: number, y: number, z: number): void; setRadius(rd: number): void; setXray(on: boolean): void; onReveal(key: number, cx: number, cz: number, conn: Uint16Array): void; onSwap(key: number, cx: number, cz: number, conn: Uint16Array): void; onRetire(key: number, cx: number, cz: number): void; frame(nowMs: number, maxPops: number, clock: (() => number) | null, budgetMs: number): void; drawnAt(section: number): boolean; drawn(cx: number, sy: number, cz: number): boolean }`; `export function createCaveCuller(): CaveCuller`; `drawnAt(section)` = `drawAll || walk.stamp[section] ≥ shown`, section = `torusSlot(cx, cz)·24 + sy` (§8.1's `slot·24 + sy`; RegionBatch's filter calls it, Task 42); `drawn(cx, sy, cz)` = `drawnAt(torusSlot(cx, cz)·24 + sy)`, for R3 (a section the walk in progress reached passes); triggers: (1) the camera's section ≠ S0 → a new walk after the one in progress; `drawAll` set if the camera leaves the old box before a walk seeded around it completes; (2) a swap adding a bit → `drawAll` and a walk; a swap only removing bits keeps the set; (3) reveals → a walk when none runs, at most every 250 ms while the queue is not empty and once when it drains; a reveal never sets `drawAll`; an eye outside −64 … 319 → `drawAll`, no walk; X-ray on, `warmUp` or before the reveal frame → no walk, `drawAll`; `drawAll` cleared when a walk completes whose box holds the camera's section and that started after the last trigger that set it; `frame` polls `clock` every 256 pops and stops at `budgetMs` (0.5 in the renderer); with `clock` null it runs `maxPops` (R3's 2,000).

- [ ] **Step 1: Write the tests.** Each trigger and its `drawAll`; a half-done walk never hides what the previous one showed; Review Focus 3: "eye y 400: `drawAll` and no walk; eye y 300: a walk starts and `drawAll` clears when it completes; a jump of 20,000 blocks: `drawAll` at once, every unrevealed column within RD walked as open (0x7FFF), revealed columns drawn until a walk that saw them completes, `drawAll` cleared only by a walk seeded around the new section"; reveals during a stand-still start a walk within 250 ms and one when the queue drains; X on: no walk across 30 frames; the slice stops after the first poll past 0.5 ms (a fake clock); `drawn(cx, sy, cz)` and `drawnAt(torusSlot(cx, cz)·24 + sy)` agree at every section of a walked grid.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveCulling.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): the culler's triggers, drawAll and 0.5 ms slices (SP6b §8.2)` (`git add src/render/culling/caveCulling.ts test/unit/caveCulling.test.ts`).

---

### Task 39: Culling III: the raycast reference; `R3.wronglyCulled`, `R3.popIn`

**Files:**
- Modify:
  - `test/harness/refs.ts` (`export function raycastVisible(opaqueAt: (x: number, y: number, z: number) => boolean, eye: readonly [number, number, number], maxDist: number, faceRes: number, onSection: (cx: number, sy: number, cz: number) => void): void`: 3D DDA rays in 6 × faceRes² cube-map directions (faceRes 128), a ray stopping at the first opaque full cube (`PASS` opaque and `fullFaces` 63, `src/mesh/greedy.ts:151`) and passing cutout, partial shapes and water; every section a ray enters, the stopping one included, reported)
  - `test/metrics/caves.metric.ts` (an R3 describe in the `caves-biomes` group over its regions' proto blocks, `connectivity15` from each section's padded copy; `R3.wronglyCulled` = seen sections not stamped; `R3.popIn` = over pose paths replayed frame by frame with 2,000 pops per frame (a walk through a doorway into a cavern, flight at two sections per walk, flight y 300 → 400 → 300, a teleport, a wall dug open into a sealed cave), the sections the reference sees at frame n that `drawn` hides at frame n; recorded `R3.culledUnderground` per pose (p10, median), the surface poses' share, over-draw (stamped / seen), pops per walk)
  - `test/thresholds.ts` (`R3: { wronglyCulled: { max: 0, activeFrom: 'SP6b' }, popIn: { max: 0, activeFrom: 'SP6b' } }`; `ThresholdPart` requires `activeFrom` on each part, `test/thresholds.ts:5-15`)
  - `test/thresholds.lock.json`
  - master §6.1 (`:1430`, item 19)
  - §6.4's R3 row (item 20's part)
  - master §1's test entry (item 6)
  - `test/arch/masterSpec.test.ts` (MST:2295-2297 moved; an `SP6B_MODULES` row for `test/harness/cull.ts`)
- Create: `test/harness/cull.ts` (**(plan)** `export function r3Poses(tier: Tier, regions: readonly CaveRegion[]): R3Pose[]`: fast 8, quick 32, full 64, deterministic: tagged cave air at several depths and kinds (eye ≥ 16 below the pre-cave top: underground), surface poses, eyes within 0.5 block of a section face, edge and corner, pitch ±90, an eye inside an opaque voxel, an eye above y 319 and one below −64, a sealed room opened by an edited wall, a pose with one disc column marked unrevealed; `r3Paths(...)`: the five paths), `test/unit/raycastVisible.test.ts`

- [ ] **Step 1: Write the tests.** `raycastVisible.test.ts`: in an empty grid every section within `maxDist` is seen; behind a solid wall none; through a 1-voxel hole the section beyond is seen from 1 section away. SP6b describe: "§6.1's raycast reference as built (SP6b spec §15 item 19)" (`the raycast visibility reference: DDA rays in cube-map directions from the eye, the sections they enter (SP6b, \`harness/refs.ts\`)`); "§6.4's R3 row (SP6b spec §15 item 20)"; "§1's test entry names R3's files (SP6b spec §15 item 6)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/raycastVisible.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `METRICS_CAVE_GROUPS=biomes npx vitest run --project metrics-quick test/metrics/caves.metric.ts`: `wronglyCulled` 0 and `popIn` 0 (a non-zero value is a bug in the walk, never a bound); `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 39: R3.wronglyCulled max 0, R3.popIn max 0, gated from SP6b on every tier (master :1538; spec §12.4; hold by §8.2's construction; new parts, measured 0 on quick).`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): the raycast visibility reference; R3 wronglyCulled and popIn (SP6b §12.4)` (`git add test/harness/refs.ts test/harness/cull.ts test/metrics/caves.metric.ts test/thresholds.ts test/thresholds.lock.json test/unit/raycastVisible.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, the spec for Step 3's Threshold-log line).

---

### Task 40: D25's culling checkpoint; `cull.walk`; `R3.culledUnderground`

**Files:**
- Modify:
  - `test/bench/noise.bench.ts` (rows `cull.walk.rd12` and `cull.walk.rd16` **(plan)**: a full walk from a cave pose over the disc's real `connectivity15`, meshed in Node; `cull.walk.rd12` over the biome region (`BIOME_SCAN_REGION` imported from `src/metrics/sp6bGoldens.ts`; importing a metric file would register its metricTests), whose 32 × 32 chunks hold RD 12's 25-column disc; `cull.walk.rd16` over a 36 × 36-chunk window centred on the biome region's centre (seed 42, default profile; RD 16's disc is 33 columns, 35 with the meshing ring), walked from a cave pose at its centre)
  - `test/metrics/caves.metric.ts` (the R3 metricTest's parts gain `'culledUnderground'`, returned as the pooled value over underground poses beside the per-pose record, in the commit that adds its row (Step 2; a part in a call without a row is an error))
  - `test/bench/gates.ts` (`BENCH_ROWS`)
  - `test/unit/benchGates.test.ts`
  - `test/baselines.json`
  - `test/thresholds.ts` (`R3.culledUnderground: { min: 0.5, activeFrom: 'SP6b' }`, pooled over underground poses)
  - `test/thresholds.lock.json`, the SP6b spec (`## Exit evidence`: "### D25's culling checkpoint (Task 40)")
  - master §6.4's R3 row and its Task 39 pin (item 20's R3 part, cross-checked against `THRESHOLDS`): the row's gated parts gain `culledUnderground` ≥ 50 % as built, in the commit that adds its row, so the cross-check stays green; `test/arch/masterSpec.test.ts`, `docs/superpowers/specs/2026-09-26-architecture-design.md`

- [ ] **Step 1: Measure** (Node, quiet machine): `R3.culledUnderground` pooled and per pose on quick; `npm run bench` twice for the two rows (estimates 0.3-1.5 ms and 0.5-2.5 ms).
- [ ] **Step 2: The rule.** `culledUnderground` < 0.5 → **Task 41**; otherwise gate it: `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 40: R3.culledUnderground min 0.5, gated from SP6b on every tier (master :1538; spec §12.4-§12.5, D25's culling checkpoint; measured <value> on quick).`
- [ ] **Step 3: Record** `npm run bench:record`; `npm run bench` within every gate and the +30 % rule.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(render): D25's culling checkpoint; cull.walk; R3.culledUnderground gated (SP6b D25)` (`git add test/bench/noise.bench.ts test/bench/gates.ts test/unit/benchGates.test.ts test/baselines.json test/metrics/caves.metric.ts test/thresholds.ts test/thresholds.lock.json test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 41: Levers II (conditional): the frustum restriction

Run only when Task 40's rule fires.

- [ ] **41a:** the walk restricted to the master's frustum widened by 10° on each side (a step allowed only into a section intersecting it), re-run on a turn of more than 10°; R3's reference cast inside the widened frustum; `R3.popIn` gains turning paths (a 90° turn at 30° per frame and at 120° per second). Its cost, named in Exit evidence: a turn faster than the margin per walk shows edge pop-in for a few frames, which `popIn`'s turning paths measure. Files: `src/render/culling/caveCulling.ts`, `test/harness/cull.ts`, `test/metrics/caves.metric.ts`, `test/unit/caveCulling.test.ts`, the spec (§8.2, §10, §12.5). Commit `perf(render): cave culling within a widened frustum (SP6b D25 lever)`; then Task 40's Steps 1-5 (the R3 call's `culledUnderground` part kept).
- [ ] **STOP:** `culledUnderground` still below 0.5 after it: every measurement to the user; no gate is loosened.

---

### Task 42: Culling IV: RegionBatch's draw filter

**Files:**
- Modify:
  - `src/render/regionGrid.ts` (`createStreamingRenderer` `:254` owns a `CaveCuller`; `stage` `:433-461`, the reveal in pump step 5 `:566-577`, `swapIn` `:348-354`, `retire` `:342-345` feed it from `p.connectivity` (`src/mesh/column.ts:56-57`); `onColumnRevealed` `:578-579` unchanged; `RegionBackend` `:170` gains `setCuller?(c: CaveCuller | null): void`; a bench-only `setCulling(on: boolean)`)
  - `src/render/regionBatch.ts` (per batch `sectionOf: Int32Array(maxInstanceCount)` holding `torusSlot(cx, cz)·24 + sy` per instance, written in `upload` `:318-333`, regrown in the `'instances'` operation `:291-293`; passes 0-2's `onBeforeRender` keeps Task 35's branch: with the X-ray on, `_multiDrawCount` is 0 and there is no compaction (D24); otherwise it calls three's own, then compacts `_multiDrawStarts`, `_multiDrawCounts` and `_indirectTexture.image.data` in place keeping entry k only if `culler.drawnAt(sectionOf[indirect[k]])` (Task 38), and sets `_multiDrawCount`; order kept)
  - `src/render/sectionRenderer.ts` (the `SectionRenderer` interface `:150` gains `readonly culler: CaveCuller` and the bench-only `setCulling(on: boolean)`; `renderer.ts` holds only a `SectionRenderer` and cannot reach the culler `createStreamingRenderer` owns otherwise)
  - `src/render/renderer.ts` (the frame step calls `sections.culler.setCamera` and `sections.culler.frame(now, Infinity, NOW, 0.5)` with a module-level `const NOW = (): number => performance.now();` (an unbound `performance.now` throws "Illegal invocation" when the slice polls; one closure, no allocation per frame); `setRenderDistance` also calls `sections.culler.setRadius(rd)`, and the initial RD is applied at creation; `warmUp` `:763-765` sets `drawAll`; `setXray` informs the culler)
  - `test/unit/zeroAlloc.test.ts`
- Test: `test/unit/regionBatch.test.ts`, `test/unit/regionGrid.test.ts`, `test/unit/renderer.test.ts`, `test/unit/zeroAlloc.test.ts`

- [ ] **Step 1: Write the tests.**
  - `regionBatch.test.ts`: on a fake batch the filter keeps exactly the drawn sections' entries in order; "X-ray on: the count stays 0 whatever the culler holds"; "three r186's private fields" — `_multiDrawStarts`, `_multiDrawCounts`, `_multiDrawCount`, `_indirectTexture` exist on a `BatchedMesh` (as `xrayBeforeRender` relies on them); the reveal state (`setVisibleAt`) is untouched by the filter, so R7's probe reads the same.
  - `renderer.test.ts`: `setRenderDistance(rd)` reaches `culler.setRadius(rd)`, and the RD at creation too; the frame step's clock polls without throwing.
  - `regionGrid.test.ts`: reveals, swaps and retires reach the culler with the payload's 24 values; Review Focus 1: "X on: 12 swaps (an Apply's) over 30 frames start no walk, the terrain batches' multi-draw counts stay 0 and the X-ray batches' lists are three's own; X off at frame 20: `drawAll` is set until the first walk that started after it completes, the filtered list equals the unfiltered one meanwhile, and after it no section the walk stamped is dropped".
  - `zeroAlloc.test.ts`: "N frame steps at rest with culling on, walking and filtering, grow the heap by less than 256 B per tick (SP6b §8.1)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/regionBatch.test.ts test/unit/regionGrid.test.ts test/unit/renderer.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npx vitest run --project metrics-quick test/metrics/stream.metric.ts` (R7's `partialColumnFrames`, `mixedEpochFrames` 0 with culling on); the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): cave culling filters RegionBatch's draw lists (SP6b §8.3)` (`git add src/render/regionGrid.ts src/render/regionBatch.ts src/render/sectionRenderer.ts src/render/renderer.ts test/unit/regionBatch.test.ts test/unit/regionGrid.test.ts test/unit/renderer.test.ts test/unit/zeroAlloc.test.ts`).

---

### Task 43: Culling V: RegionMesh's region culling; master §4.15

**Files:**
- Modify:
  - `src/render/regionMesh.ts` (`setCuller`; an arena (region, pass 0-2) none of whose columns has a drawn section gets (0, 0) through `applyDrawRange` (Task 35); on each frame where the culler's `shown` or `drawAll` changed, RegionMesh re-runs `applyDrawRange` over its pass 0-2 arenas (O(arenas × columns × 24), no allocation; Spec correction 23: the span writers alone would leave an arena hidden after the camera moves or a wall is dug open); the X-ray arenas keep their toggle `:620-626`; `rowVisible` ignores culling)
  - `src/world/store/section.ts:22` (the stale comment: "meta bits 17-31 stay 0: cave culling reads `connectivity15` from the staging (SP6b)")
  - master §2.3's meta line (`:350`, item 8)
  - §4.15 (`:1237-1240`, item 17 as built) and §7's main-thread row (`:1683`, its wording; the measured cost by Task 53)
  - `test/arch/masterSpec.test.ts` (MST:1983 moved), the SP6b spec (Spec correction 23)
- Test: `test/unit/regionMesh.test.ts`

- [ ] **Step 1: Write the tests.** An arena whose region holds no drawn section gets (0, 0) and keeps uploading; a reveal during culling does not undo it; X-ray arenas never culled; `drawAll` set: every culled arena back at (0, high water) the same frame; a completed walk that stamps a section of a culled arena restores it the same frame; a frame where neither `shown` nor `drawAll` changed re-applies nothing. SP6b describe: "§2.3's meta line: bits 17-31 stay 0 (SP6b spec §15 item 8)" (`bits 17-31 stay 0: cave culling reads \`connectivity15\` from the staging (SP6b)`); "§4.15 and §7's main-thread row: cave culling as built (SP6b spec §15 item 17)" (§4.15 names the monotone walk with entry faces from a 3 × 3 × 3 seed box, no frustum, unrevealed columns open, `drawAll`, 0.5 ms slices, RegionBatch's filter and RegionMesh's arenas (re-applied when the culler's `shown` or `drawAll` changes), never while the X-ray is on, the reveal state untouched).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/regionMesh.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): RegionMesh culls whole region arenas; master §4.15 as built (SP6b D23)` (`git add src/render/regionMesh.ts src/world/store/section.ts test/unit/regionMesh.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 44: Map I: the `caveBiome` layer in the tile job

**Files:**
- Modify:
  - `src/gen/map/layers.ts` (`LAYERS` `:21` appends `'caveBiome'`; `layerStage` `:29-33` returns `'terrain'` for it; `export function caveBiomeColor(picker: CavePickerInputs, p: PointRecord, y: number, k: number): number` (§1.3's choice at the pixel's position and y through Task 10's `caveBiomePoint`, no jitter, from the `PointRecord`'s C, E, H and `surfaceEst` plus the border and depth noises at (p.x, p.z); the relief greyed where y > `surfaceEst`))
  - `src/gen/map/tile.ts` (`paintTileAbortable` `:117` and `paintTile` `:163` gain `y?: number`, passing `cavePickerOf(ctx)` and y for this layer; per-pixel cave-biome ids into `ids`)
  - `src/workers/protocol.ts` (`MapTileMsg` `:75` gains `readonly y?: number`; validation `:510`: an integer in −64 … 319, required for `caveBiome`, absent otherwise), the tile worker's handler, the SP6b spec (Spec correction 13)
  - `caveBiome` is not a `needsRelief` layer (`src/gen/map/layers.ts:36` unchanged): the shaded fine path keeps only `surfaceEst`, water, river and lake fields per pixel and paints from one shared `P` whose C, E and H are the last border sample's (`src/gen/map/tile.ts:135-158`, `:81-88`), so the layer paints in the unshaded path, which samples each pixel whole, its relief part the greyed unshaded relief (k = 1) **(plan; shading would need the shaded pass to store C, E and H per pixel)**
  - `test/unit/applyControl.test.ts:576-583` (the loop "a cave leaf changes no map layer's stage hash" skips `caveBiome`, and a new expect pins that `caveBiome`'s stage hash changes with the terrain's on a cave edit, by design: D9/D15)
  - `test/tools/mapLatency.ts:46` (`MAP_LAYERS` appends `'caveBiome'`, pinned equal to `LAYERS` by `test/unit/mapLatency.test.ts:23`, which builds a `perfHash` for every layer) and `test/unit/mapLatency.test.ts`
  - `test/unit/tile.test.ts:62-63` (`LAYERS` length 16, the last two `['islandMask', 'caveBiome']`); the implementer greps the other `LAYERS` readers (`biomeTableModel.test.ts` and any other)
- Test: `test/unit/tile.test.ts`, `test/unit/protocol.test.ts`, `test/unit/applyControl.test.ts`, `test/unit/mapLatency.test.ts`

- [ ] **Step 1: Write the tests.** `tile.test.ts`: at a pixel whose point is in the lush box at y such that depth 0.5, the colour is `#4dff7a`'s; at y > `surfaceEst` the relief greyed; ids per pixel 0-3; the layer's tiles key on the terrain stage; two pixels of one fine tile with different climates get different cave-biome colours. `protocol.test.ts`: `y` 0 accepted for `caveBiome`, `y` 320 or missing refused for it, `y` present refused for other layers.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/tile.test.ts test/unit/protocol.test.ts test/unit/applyControl.test.ts test/unit/mapLatency.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): the caveBiome layer at a y in the tile job (SP6b D9)` (`git add src/gen/map/layers.ts src/gen/map/tile.ts src/workers/protocol.ts src/workers/worldJobs.ts test/unit/tile.test.ts test/unit/protocol.test.ts test/unit/applyControl.test.ts test/tools/mapLatency.ts test/unit/mapLatency.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, the tile handler's file by explicit path if it is not `worldJobs.ts`, and any other `LAYERS` reader that moved).

---

### Task 45: Map II: `caveY` in the hash, the y control, the hover line

**Files:**
- Modify:
  - `src/ui/map/mapState.ts` (`MapView` `:20-26` gains `caveY?: number`; written to the hash only when the layer is `caveBiome` `:45-51`; `VIEW_KEYS` `:51` accepts `caveY` as optional `:66`)
  - `src/ui/map/tileSource.ts:33-36` (the key gains `:y<n>` for this layer only)
  - `src/ui/map/mapView.ts:141` (keys; the legend row highlight `:64`, `:92`)
  - `src/ui/map/toolbar.ts` (with `caveBiome` selected a "y" slider and number field, −64 … 319, step 4, default 0)
  - `src/ui/map/hoverPanel.ts:14-26` (the line "cave biome at y n: lush (depth 0.42)", formatted from the point reply's field; `HoverPool.point` `:32` gains `y`, the map's `caveY` while the layer is `caveBiome`)
  - the worker's point job (Spec correction 24: `formatPoint` gets only a `ColumnPoint`, and the noises live in the worker's GenContext): `src/workers/protocol.ts:76` (`PointMsg` gains optional `y`, an integer in −64 … 319, validated; `pointResult` gains `caveBiome?: { id: number; depth: number }`), `src/workers/taskHandler.ts:328-329` (with `y` set, `caveBiomePoint` over the point's `PointRecord` and `cavePickerOf(ctx)`'s noises, as Task 44's pixel), `src/engine/workerPool.ts` (`point(x, z, …, y?)`)
  - `test/unit/worldPage.test.ts` (Task 34's Review Focus 5 case re-pinned with the caveBiome layer's y number field focused (owner map, `ownerOf`): C neither acted on nor prevented, the X-ray mode unchanged)
  - master §5.6 (`:1378`, item 18), the SP6b spec (Spec correction 24)
- Test: `test/unit/mapState.test.ts`, `test/unit/tileSource.test.ts`, `test/unit/toolbar.test.ts`, `test/unit/hoverPanel.test.ts`, `test/unit/mapView.test.ts`, `test/unit/protocol.test.ts`, `test/unit/worldPage.test.ts`

- [ ] **Step 1: Write the tests.** `mapState.test.ts`: every existing hash (SP6a's review links' included) decodes and re-encodes byte-identical; a `caveBiome` view with `caveY` −12 round-trips; `caveY` on another layer is dropped on encode. `tileSource.test.ts`: two y values give two keys for `caveBiome` and none for `biome`. `toolbar.test.ts`: the y control appears only with the layer; its range and step. `hoverPanel.test.ts`: the line's text from a point reply with `caveBiome` lush; with the layer selected the pool's `point` receives `caveY`; with another layer no `y` and no line. `protocol.test.ts`: a point message's `y` −64 and 319 accepted, 320, −65 and 1.5 refused, absent accepted. `worldPage.test.ts`: Review Focus 5 on the real y field. SP6b describe: "§5.6: the cave-biome layer at a chosen y (SP6b spec §15 item 18)".
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/mapState.test.ts test/unit/tileSource.test.ts test/unit/toolbar.test.ts test/unit/hoverPanel.test.ts test/unit/mapView.test.ts test/unit/protocol.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): the caveBiome layer's y in the hash, the toolbar and the hover readout (SP6b §9.1)` (`git add src/ui/map/mapState.ts src/ui/map/tileSource.ts src/ui/map/mapView.ts src/ui/map/toolbar.ts src/ui/map/hoverPanel.ts src/workers/protocol.ts src/workers/taskHandler.ts src/engine/workerPool.ts test/unit/mapState.test.ts test/unit/tileSource.test.ts test/unit/toolbar.test.ts test/unit/hoverPanel.test.ts test/unit/mapView.test.ts test/unit/protocol.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, and the file that wires the map's `HoverPool` by explicit path).

---

### Task 46: The `biome3d` slice field; the Voxels mode by biome; `slice.biome3d128`

**Files:**
- Modify:
  - `src/gen/inspect/fieldSlice.ts` (`SliceField` `:271` gains `'biome3d'`, the result union `:299`, `fieldSliceProblem` `:366-369`; samples through the `caves` field's `CAVE_RUN` grouping `:476-501`: the column's nibbles computed once per chunk column it touches (the cave-biome step over the probe's tags); 0 open air, 1 + biome for tagged air, `CAVE_SLICE_SOLID` 16 solid; `sliceCostOf` `:702-707` a picker term)
  - `src/workers/protocol.ts:317`, `:347` (`SLICE_FIELDS`, refusable)
  - `src/ui/inspector/sliceModel.ts` (`FieldChoice` `:61-62` and `FIELD_CHOICES` gain `'biome3d'`; a label map `{ caves: 'Cave type', biome3d: 'Cave biome' }` replaces the ternary `:98`; `biome3d` beside `caves` at the acquisition cost and the refusal noun `:620`, `:623`, `widestCaveExtent` `:758`, the real gesture hold `:833` (`(f.field === 'density' || f.field === 'node' || f.field === 'caves') && src.held?.()`; `:27` and `:663` are doc comments), `cavesRgba` `:946`, `cavesCodeText` `:1088` and the label `:1138`; the legend of the biomes present from `CAVE_BIOME_COLORS`)
  - `src/engine/workerPool.ts:829` (`'biome3d'` joins the `Uint8Array` copy branch beside `'rule'` and `'caves'`; today a `biome3d` part would take the `Float64Array` branch into the `Uint8Array` allocated at `:808-811` and write garbage without throwing)
  - `src/ui/inspector/sliceView.ts:336` (`case 'biome3d':` beside `case 'blocks': case 'caves':`, the biome legend from `CAVE_BIOME_COLORS`)
  - `src/ui/crossSection/voxels.ts` (`:150`, `:162`: `sliceRgba(s, mode)`, dry cave air coloured by `caveBiomeOf(byte)` from Task 8's unmasked copy when the mode is biome, by `caveKindOf(byte)` otherwise)
  - `src/ui/crossSection/section.ts` (`SectionDeps` `:46` gains `xrayColorMode(): 0 | 1`, absent on `?map` meaning 0; `:323-325` calls `sliceRgba(s, mode)` and repaints when the mode differs from the painted one, tracked beside `painted`, since a mode change on the same slice never repaints today) and the world page's wiring of that dep (`src/ui/world/worldPage.ts`; Task 34's C handler calls the section's refresh)
  - `test/bench/noise.bench.ts`
  - `test/bench/gates.ts` (`SLICE_BIOME3D_P50_MAX_MS = 300`; the row `slice.biome3d128` after `slice.caves128`)
  - `test/unit/benchGates.test.ts`
  - `test/baselines.json`
  - master §5.5 (`:1366-1367`, item 18)
- Test: `test/unit/fieldSlice.test.ts`, `test/unit/fieldSliceProtocol.test.ts`, `test/unit/sliceModel.test.ts`, `test/unit/crossSectionVoxels.test.ts`, `test/unit/fieldSlicePool.test.ts`, `test/unit/section.test.ts`

- [ ] **Step 1: Write the tests.** `fieldSlice.test.ts`: the `biome3d` values equal 1 + the stored nibble at tagged voxels of a generated region, 16 at solid, 0 at open air, the same in any sample order; the `caves` field's values unchanged. `sliceModel.test.ts`: the option "Cave biome" on both planes; it redraws on release (the gesture hold at `:833` holds for `biome3d`). The pool test: a 2-part `biome3d` slice reassembles byte-equal to the parts. `crossSectionVoxels.test.ts`: in biome mode a lush cave voxel is `#4dff7a`'s colour, in type mode its kind's. The section test: pressing C with a slice shown repaints once; on `?map` (no dep) the mode is 0. `benchGates.test.ts`: the gate constant and the row's place. SP6b describe: "§5.5: biome3d delivered as the Cave biome field (SP6b spec §15 item 18)": §5.5 names the "Cave biome" field (SP6b) and hands the probe's cave biome to SP10.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/fieldSlice.test.ts test/unit/fieldSliceProtocol.test.ts test/unit/sliceModel.test.ts test/unit/crossSectionVoxels.test.ts test/unit/fieldSlicePool.test.ts test/unit/section.test.ts test/unit/benchGates.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Measure and record** (quiet machine): `npm run bench`: `slice.biome3d128` and `slice.caves128` ≤ 300 ms p50; **if either passes 300 ms** and Task 25f did not land it, the `deriveSeed` memo per kind (`src/gen/caves/carvers.ts:322`, output-keeping; D32) lands in this commit with a test that the paths are equal with and without it; `npm run bench:record`.
- [ ] **Step 5: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 6: Commit** `feat(inspector): the Cave biome slice field; the Voxels mode by biome; slice.biome3d128 (SP6b D10)` (`git add src/gen/inspect/fieldSlice.ts src/workers/protocol.ts src/ui/inspector/sliceModel.ts src/ui/inspector/sliceView.ts src/engine/workerPool.ts src/ui/crossSection/voxels.ts src/ui/crossSection/section.ts src/ui/world/worldPage.ts test/bench/noise.bench.ts test/bench/gates.ts test/unit/benchGates.test.ts test/baselines.json test/unit/fieldSlice.test.ts test/unit/fieldSliceProtocol.test.ts test/unit/sliceModel.test.ts test/unit/crossSectionVoxels.test.ts test/unit/fieldSlicePool.test.ts test/unit/section.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`, and `src/gen/caves/carvers.ts` with its test if the memo landed).

---

### Task 47: The Caves tab: Colour by, Cave slice by mode, the two links

**Files:**
- Modify:
  - `src/ui/map/cavesTab.ts` (order `:131-187`: X-ray (X); **Colour by** (Cave type / Cave biome), in step with C both ways; band line; sliders; All depths; the legend following the mode; radius; "Cave slice" opening `caves` or `biome3d` by the mode; **"Show cave biomes on the map"** (the layer at `caveSliceY` `:120-123`); "Cave parameters"; **"Cave biome parameters"** (reveals `caves.biomes.lush.hMin`, a leaf, `src/ui/paramPanel/panel.ts:130-141`); Find)
  - `src/ui/map/mapTool.ts:88-108` (the slice by mode, the layer link, the parameters link)
  - `src/ui/world/worldPage.ts:5647-5659` (the mode both ways)
- Test: `test/unit/cavesTab.test.ts`, `test/unit/mapTool.test.ts`

- [ ] **Step 1: Write the tests.** The radio reflects C and sets the page's mode; the legend switches; "Cave slice" in biome mode opens `biome3d`; "Show cave biomes on the map" sets the layer `caveBiome` with `caveY` the band's middle y rounded to 4; "Cave biome parameters" reveals `caves.biomes.lush.hMin`; `?map` has no Caves tab (`layout.ts:16-31`).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesTab.test.ts test/unit/mapTool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): the Caves tab's Colour by, the biome slice and its two links (SP6b D11)` (`git add src/ui/map/cavesTab.ts src/ui/map/mapTool.ts src/ui/world/worldPage.ts test/unit/cavesTab.test.ts test/unit/mapTool.test.ts`).

---

### Task 48: The biome finder

**Files:**
- Modify:
  - `src/gen/caves/tags.ts` (`export function nearestCaveBiome(dc: DensityContext, biome: number, x: number, y: number, z: number, o: FindOptions): FindResult` **(plan)**, beside `nearestCave` `:452`, sharing its rings: (1) loaded columns' tagged voxels with that nibble (`caveBiomeOf`); (2) beyond them, a 2D prefilter on a 16-block grid of column-stage points whose perturbed climate meets the biome's box and whose depth window [Y0 − D·depthMax, Y0 − D·depthMin] (the abyss: below Y0 − D·depthMin) meets −64 … 319, then `caveTagAt` at the density-cell lattice voxels inside the window, a hit confirmed by `caveBiomeAt`)
  - `src/workers/protocol.ts` (`FIND_BIOME_RADIUS = 1024` beside `:156`; `FindCaveMsg` `:164-167` gains `readonly biome?: number`; `findCaveProblem` `:424`: with `biome` set, `kind` 0, `biome` an integer 1-3, radius 1 … `FIND_BIOME_RADIUS`)
  - `src/workers/taskHandler.ts:340-365` (the find handler, `case 'findCave'`: with `m.biome` set it calls `nearestCaveBiome`)
  - `src/engine/workerPool.ts:844-862` (`FindCaveRequest` gains `biome?`; with `biome` set the default radius is `FIND_BIOME_RADIUS` (today `req.radius ?? FIND_RADIUS`, 512, and the message carries no biome); the posted message carries `biome`)
  - `src/ui/world/worldPage.ts` (`createCaveFind` `:1776` gains the biome form; it passes no radius, `:1789`, so the pool's default applies)
  - `src/ui/map/cavesTab.ts` (a second Find row: "Nearest lush cave", "Nearest dripstone cave", "Nearest abyss"; texts "Lush cave at x, y, z · d blocks away", "No lush cave found within 1024 blocks", "No lush cave found in 2 s"; the same cancel rules and "Save as place")
- Test: `test/unit/caveFinder.test.ts`, `test/unit/protocol.test.ts`, `test/unit/workerPool.test.ts`, `test/unit/cavesTab.test.ts`, `test/unit/worldPage.test.ts`

- [ ] **Step 1: Write the tests.** `caveFinder.test.ts`: in loaded columns the nearest voxel of that nibble wins; beyond them a hit is a tagged voxel whose `caveBiomeAt` is the biome; the deadline returns `budget`, the radius `radius`; the same answer twice. `protocol.test.ts`: `findCaveProblem({kind: 0, biome: 3, radius: 1024, …})` null; `biome: 4`, `radius: 1025`, `kind: 1` with `biome` refused; kind searches still capped at 512. `workerPool.test.ts`: a biome request posts `biome` and radius 1024; a kind request still posts 512. `cavesTab.test.ts`: the three buttons and their texts. `worldPage.test.ts`: a hit moves the camera into the cave in flight.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveFinder.test.ts test/unit/protocol.test.ts test/unit/workerPool.test.ts test/unit/cavesTab.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** If Task 24's "abyss spacing" row measured the abyss sparser than one per 2 km at seed 42, the "No abyss found within 1024 blocks" text stays as written (honest) and Exit evidence says so.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): find the nearest lush cave, dripstone cave or abyss (SP6b D11)` (`git add src/gen/caves/tags.ts src/workers/protocol.ts src/workers/taskHandler.ts src/engine/workerPool.ts src/ui/world/worldPage.ts src/ui/map/cavesTab.ts test/unit/caveFinder.test.ts test/unit/protocol.test.ts test/unit/workerPool.test.ts test/unit/cavesTab.test.ts test/unit/worldPage.test.ts`).

---

### Task 49: Bench legs: L13 with culling, L14's biome segment; `measureChrome` → `assets/sp6b`

**Files:**
- Modify:
  - `src/ui/world/bench.ts` (L13: its 60 s with culling on, then the first 20 s of the same route with culling off through `sections.setCulling(false)`; the `caves` block gains `cullMainMeanMs` (the walk's and the filter's main-thread time over L13's frames, mean), `cullMainMaxMs` (the largest per-frame walk plus filter), culled sections and triangles drawn, `gpuMs` p50/p95, walks per second, the culling-off segment's figures; L14 (`:343`): a biome-mode segment after the hold (C, a hold, a 360° sweep, C), with `xrayBiomeP95`, `xrayBiomeOver33`, `xrayColorToggleMaxMs` (the longest frame within 2 frames of each C), `xrayVertexBytes` in both modes, `gpuMs` with the X-ray on (D24's gain), `xrayCulledSections`, `xrayApplyRefillMs` (Point 3: recorded); `BENCH_FRAME_CAPACITY` `:116` recomputed for the added seconds)
  - `src/ui/world/worldPage.ts` (the bench's hooks)
  - `src/render/renderer.ts` (`culledSections(): number`, per frame, read as `toolDrawCalls()` is)
  - `test/tools/measureChrome.ts:71` (`ASSETS` → `'docs/superpowers/specs/assets/sp6b'`)
  - `test/unit/measureChrome.test.ts`
- Test: `test/unit/bench.test.ts`, `test/unit/renderer.test.ts`, `test/unit/measureChrome.test.ts`

- [ ] **Step 1: Write the tests.** `bench.test.ts`: on a fake page L13's segments in order (60 s on, 20 s off) and L14's biome segment between the hold and the sweep; the new fields and shapes; the capacity rule. `renderer.test.ts`: `culledSections()` counts the sections the filter dropped last frame. `measureChrome.test.ts`: `ASSETS` is `'docs/superpowers/specs/assets/sp6b'`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/bench.test.ts test/unit/renderer.test.ts test/unit/measureChrome.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; **(plan)** one headless dry run of `?bench=medium` in the smoke's own Chrome (its own port and `mktemp -d` profile): L13 and L14 complete with the new fields (values not judged; the file not kept).
- [ ] **Step 5: Commit** `feat(bench): L13 with culling and a culling-off segment, L14's biome segment; measureChrome writes assets/sp6b` (`git add src/ui/world/bench.ts src/ui/world/worldPage.ts src/render/renderer.ts test/tools/measureChrome.ts test/unit/bench.test.ts test/unit/renderer.test.ts test/unit/measureChrome.test.ts`).

---

### Task 50: GPU cells (Chrome, agent): every route into `assets/sp6b`; the new parts gated

**STOP for the user before Step 1:** PRIME on-demand, eDP-1 at 240 Hz, `LockedHint=no`, the 1-minute load below 1. The controller asks and waits.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp6b/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `enter-iris-chrome.json`
- Modify:
  - `test/thresholds.ts` (G1 gains `cullMainMeanMs: { max: 1.0 }`, `cullMainMaxMs: { max: 1.5 }` (§8.5's proposal; a measurement above it goes to Task 51a, then to the user, whose bound replaces 1.5 with a Threshold-log line), `xrayBiomeP95: { max: 16.7 }`, `xrayBiomeOver33: { max: 0 }`, `xrayColorToggleMaxMs: { max: 33 }`, each `activeFrom: 'SP6b'`)
  - `test/thresholds.lock.json`
  - `test/metrics/g1.metric.ts` (`ASSETS_SP6A` `:145` → `ASSETS_SP6B` for every read; the new parts from the `caves` and `xray` blocks)
  - `test/unit/benchFiles.test.ts` (a new `ASSETS_SP6B` for the Iris reads, `:31`, `:58`'s two Iris files and `:128`; the RTX reads (`:32`'s `enter-rtx-chrome.json` and `:58`'s `bench-rtx-chrome.json`) stay on the kept `ASSETS_SP6A` constant `:5`, since no RTX cell is measured in SP6b and those files exist only in `assets/sp6a/`), the SP6b spec (Threshold log; `## Exit evidence`)

- [ ] **Step 1: Measure** (an agent; cold shader cache; touching no other process): `npm run measure:chrome -- --route bench --gpu iris --probe-only` (a refusal: back to the STOP); then `… --route bench --gpu iris` twice (both recorded, the second committed), `… --gpu iris --workers 4`, `… --route flight --gpu iris`, `… --route enter --gpu iris`.
- [ ] **Step 2: Check.** Gated: `caveP95` ≤ 16.7, `caveOver33` 0, `caveMainP95` ≤ 6 with culling; `cullMainMeanMs` ≤ 1.0; `cullMainMaxMs` ≤ 1.5; L14's parts (`xrayP95` ≤ 16.7, `xrayOver33` 0, `xrayMainP95` ≤ 6, `xrayGpuMB` ≤ 150, `xrayDrawCalls` ≤ 100, `xrayToggleMaxMs` ≤ 33) and the biome segment's; every earlier G1 cell, `mediumFill4wMs` ≤ 6,000, G2 and G1.enter re-read. Recorded: `xrayCulledSections` (a non-zero value is a blocking finding), `xrayApplyRefillMs` (Point 3), `gpuMs` on and off, the culling-off segment. `replyDuringFlushP95Ms` over 5 ms in a run where three re-runs read ≤ 5 ms is SP6a's flake, logged (D32). A gate miss: **Task 51's levers in order**, then this task again from Step 1.
- [ ] **Step 3: The rows.** `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6b Task 50: G1 cullMainMeanMs max 1.0 (master :1683), cullMainMaxMs max 1.5 or the user's bound (measured <value>; spec §8.5), xrayBiomeP95 max 16.7, xrayBiomeOver33 max 0, xrayColorToggleMaxMs max 33 (G1.caves, G1.xray), gated from SP6b from assets/sp6b/; the other G1, G1.enter and G2 cells re-read from assets/sp6b (D31); measured on eDP-1 at 240 Hz.`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with every G1 and G2 part asserted on the SP6b files.
- [ ] **Step 5: Commit** `feat(sp6b): the Chrome cells in assets/sp6b; L13's culling and L14's biome parts gated` (the four JSON files by explicit path, with `test/thresholds.ts test/thresholds.lock.json test/metrics/g1.metric.ts test/unit/benchFiles.test.ts docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 51: Levers III (conditional): the Chrome gates

Run only for a gate Task 50 measured as missed; each lever one commit, measured by Task 50's Step 1 Iris bench route only, **STOP before each measurement** under Task 50's conditions (confirmed again after a resume or a sleep); stop at the first that meets the gate. Output-changing T levers would need a second generator push and are not here.

- [ ] **51a: the walk's slice** (`cullMainMaxMs` or `caveMainP95` missed): the per-frame budget 0.5 → 0.3 ms, then the filter skipped on frames with no walk progress and no camera section change (its result cached per batch, output-identical; a unit test). Commit `perf(render): the culler's per-frame cost (SP6b §8.5)`.
- [ ] **51b: the biome segment** (`xrayBiomeP95` or `xrayColorToggleMaxMs` missed): the toggle writes the uniform on the next frame's start only. Commit `perf(render): the X-ray colour mode's frame (SP6b §7.2)`.
- [ ] **STOP:** a gate still missed: every measurement to the user; no gate is loosened.
- [ ] Each lever: `npm run typecheck && npm test`; the golden check (no diff); the measurement under Task 50's evidence.

---

### Task 52: The user's Firefox run

This task is the controller's and the user's.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp6b/selftest-firefox.json`, `docs/superpowers/specs/assets/sp6b/bench-iris-firefox.json`

- [ ] **Step 1: STOP for the user.** The controller runs `npm run build`, then its own `npx vite preview --port 4173 --strictPort` (stopped only by the controller), and gives the user `http://localhost:4173/?selftest=1` (required: 65/65 and "IndexedDB contract: 10/10 passed") and `http://localhost:4173/?bench=medium` (L13 with RegionMesh's region culling and L14 with the biome segment; recorded, not gated).
- [ ] **Step 2: Record** both in Exit evidence (L13's culled arenas and `gpuMs`, L14's figures, the refill).
- [ ] **Step 3: Commit** `docs(sp6b): the Firefox selftest and bench` (the two files by explicit path, and the spec).

---

### Task 53: Master pins I: §7, §8 risk 3, the "Received from SP6b" lines

**Files:**
- Modify:
  - master §10 SP7, SP8a, SP8b, SP8c, SP9, SP10, SP11 and SP12 (new lines `- Received from SP6b (its spec §16; amended by SP6b):` with §16's text; SP7's with the abyss's lava and the user's words "y la propia lava que también emite luz", SP8b's the crystals or gems and the gothic touch, SP8c's the silence; item 2)
  - §8 risk 3 (item 3: written only if D25's generator checkpoint `terrain.real` p50 (Task 24's evidence table, after any of Task 25's levers, 25e included when it ran) is more than 0.5 ms above 10.46 (`test/baselines.json`'s row at 1ac9e7b, spec §15 item 3), the sentence naming the levers that ran in Task 25; else unchanged and Exit evidence says "not needed")
  - §7 ("Measured in SP6b": `terrain.real` and `terrain.islands` with cave biomes and the floor, `caveBiome.column`, `cull.walk.rd12`/`rd16`, `slice.biome3d128`, the refill; the T row's "25 surface + about 300 cave quarts" restated as measured (cave-air quarts per column p50 60, p90 177, max 575); item 21)
  - §7's main-thread row with `cullMainMeanMs` measured (item 17)
  - `test/arch/masterSpec.test.ts` (the header-comment's SP6b paragraph completed)
  - `CLAUDE.md` (C, the Caves tab's additions, the map layer, `caves-biomes`, `measure:chrome`'s `assets/sp6b`)
  - `README.md`

- [ ] **Step 1: Write the pins.** "§10's Received from SP6b lines (SP6b spec §15 item 2)": each of SP7-SP12 has the line, SP7's contains `lava may appear in the abyss`, SP8b's `crystals or gems`, SP8c's `silent`; the SP6a lines still hold none of them (MST:1949-1950 stays green). "§8 risk 3 (SP6b spec §15 item 3)": the measured move and levers, or the risk's text unchanged. "§7 as measured in SP6b (SP6b spec §15 item 21)" and "§7's main-thread row: the walk's measured cost (SP6b spec §15 item 17)", cross-checked against `BENCH_ROWS` and the gate constants.
- [ ] **Step 2: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3: Commit** `docs(sp6b): the hand-overs to SP7-SP12; §7 and §8 as measured; CLAUDE.md and README` (`git add docs/superpowers/specs/2026-09-26-architecture-design.md test/arch/masterSpec.test.ts CLAUDE.md README.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 54: Master pins II: the completeness test; the obligations audit

**Files:**
- Modify: `test/arch/masterSpec.test.ts` (the describe's last test, MST:2474-2496's pattern: reads the SP6b spec between "## 15. Master-spec amendments made with this spec" and "## 16. Notes handed to later SPs", collects `^(\d+)\. \*\*` items, and checks every item 1-21 is named by a test title "§15 item n" / "§15 items …" of this describe and no title names an item the spec lacks), master §10's Default receivers (`2026-09-26-architecture-design.md:1794`: item 4's four entries appended in pre-exit form, "SP6b Find-a-cave-biome buttons → SP10; SP6b map cave-biome layer → SP10; SP6b Cave biome slice field → SP10; SP6b RegionMesh region culling → SP11"; no task before this one writes them), the SP6b spec (`## Exit evidence`: §19's table with each obligation's commit or receiving line)

- [ ] **Step 1: Write** "every item of the SP6b spec §15 is pinned by a test of this describe that names it (ruling P52)"; "the Default receivers name SP6b's cut-line items (SP6b spec §15 item 4)" on the four entries just written; items 1 and 4 are pinned now in their pre-exit wording and re-pinned by Task 59 Step 0, which appends "(delivered in SP6b, so nothing moved)" to each item taken.
- [ ] **Step 2: The audit.** For every row of spec §19, the commit or the receiving SP's "Received from SP6b" line that places it; a missing one is a blocking finding for Task 57.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(arch): every SP6b §15 item pinned; the obligations audit` (`git add test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`).

---

### Task 55: Smoke: the `caves` step for SP6b

**Files:**
- Modify: `test/tools/uiSmoke.ts` (the `caves` step: C (the strip's text and legend; a pixel read of a biome colour at a known pose: the `lush` pose from the `caves-biomes` run's `.out/caveBiomes.examples.json` (Task 27), mirrored as a literal; Task 56, which commits the examples after this task, pins that literal against the committed copy); the Colour-by radio in step with C; "Cave slice" in biome mode opening `biome3d`; "Nearest lush cave" moving the camera; `cave_heavy` in both selects and generating; the caveBiome layer with its y control drawing a known colour at a known pixel; the HUD and strip rects disjoint at 1400 × 900 full screen, 1920 × 1080 and 1280 × 720 side by side, F3 and the X-ray on, both modes (Review Focus 5); a new state (moss_block) copied and pasted by key; `SMOKE_KEYS` `:899` gains C), `test/unit/uiSmoke.test.ts`

- [ ] **Step 1: Write** `uiSmoke.test.ts`: the step's literals equal the key map's codes; the three viewport sizes; `SMOKE_KEYS.xrayColor` is `'KeyC'` without Ctrl.
- [ ] **Step 2: Run** `npm run build && node test/tools/uiSmoke.ts` (its own port and Chrome profile): green, `?selftest=1` 65/65, every step including `caves`.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(smoke): the caves step for cave biomes, C, the map layer and the strip's rects (SP6b §12.8)` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts`).

---

### Task 56: Review links and screenshots

**Files:**
- Commit:
  - `docs/superpowers/specs/assets/sp6b/caveBiomes.examples.json` (merged from the `caves-biomes` run's `.out/caveBiomes.examples.json` (Task 27: `lush`, `dripstone`, `abyss`, each in a cave of that biome in seed 42's default world, yaw along the floor; `biomeBorder`; `caveHeavySpawn`) and the `caves` run's `.out/caves.examples.json` (Task 21's `bottomCavern`))
  - `docs/superpowers/specs/assets/sp6b/review-lush.png`
  - `review-dripstone.png`
  - `review-abyss.png`
  - `review-abyss-night-vision.png`
  - `review-biome-border.png`
  - `review-bottom-before.png`
  - `review-bottom-after.png`
  - `review-xray-biome.png`
  - `review-slice-biome3d.png`
  - `review-map-cave-biome.png`
  - `review-hud-strip.png`
- Modify:
  - `test/tools/uiSmoke.ts` (a new `SP6B_POSES` (each with `profile: 'default' | 'cave_heavy'`) and `SP6B_AT` beside `CAVE_POSES`/`CAVE_AT` `:1192-1229`, which stay unchanged with their SP6a tests (`test/unit/uiSmoke.test.ts:1731`, `:1743-1762` pin them to SP6a's ten ids, and `CAVE_AT … satisfies Record<CavePoseId, …>`); each link carries its pose's profile hash, not `SEED_42_HASH`; `SP6B_SHOTS` beside `SP6A_SHOTS` `:1160`; `--shots` writes them at `SHOT_RD` 12 with the stream settled; night vision on for the abyss's second shot)
  - `test/unit/uiSmoke.test.ts` (`SP6B_POSES` and Task 55's `lush` literal equal the committed `caveBiomes.examples.json`; `SP6B_AT`'s corners computed with `solidAt` on each pose's profile context; each PNG at `VIEWPORT` 1400 × 900), the SP6b spec (`## Exit evidence`: the links)

- [ ] **Step 1:** merge the two `.out` files into `assets/sp6b/caveBiomes.examples.json`; write the tests.
- [ ] **Step 2: Shots.** `npm run build && node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"`; `review-bottom-before.png` from a build of 441b67d: `git archive 441b67d | tar -x -C "$(mktemp -d /tmp/wi10-gv8-XXXX)"` (read-only git), `npm ci && npm run build` there, served on its own free port, the same pose **(plan)**. The shots reviewed for straight borders, flat cuts, the floor's relief and the abyss's darkness, then copied in.
- [ ] **Step 3: Links:** one `/?at=x,z&y=…&yaw=…&pitch=…&rd=12#<hash>` per pose (in flight), written into Exit evidence.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(smoke): SP6b's review links and shots` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts docs/superpowers/specs/assets/sp6b/caveBiomes.examples.json docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`, and the eleven PNGs by explicit path).

---

### Task 57: Whole-branch review

- [ ] **Step 1:** The controller runs the final review of `git diff main...sp6b/cave-biomes` against the spec, this plan and Review Focus 1-5 (superpowers:requesting-code-review), the reviewer resolving its own cannot-verify items in the code at HEAD. Beyond the per-task reviews it checks what only the whole branch shows:
  - every **(plan)** decision is in the code as written or its change is in the spec; every Spec correction is reworded in the spec;, the golden diff of the generator push against `<push base>` lists only §14.3's keys (Spec correction 7 applied); `GENERATOR_VERSION` 9; no generator commit after Task 31;, the generator's determinism: no `Math.sin`/`cos`/`**` or clock in `gen/biomes/*`; the field pass's operation order identical in T, `caveBiomeAt`, the surface probe, the fast path's classification and the map; DT1 (`isolated`, `carverCache`) and DT2 (`tagProbe`, `caveBiomeProbe`, `surfaceProbeBulk`, `surfaceReference`, `editedSurfaceReference`) 0 on full;, one picker: T, the probes, rule 4, the X-ray, B3 and the finder read the nibble or `caveBiomeAt`, never a re-derivation;
  - SP5a-SP6a's rules still hold: zero allocation at rest (culling, C), the layers, every key's meaning (Ctrl+C copy, plain C the colour mode), `?map` without the Caves tab, `wi10` unchanged, the migration only for the built-in trees, every old map hash byte-identical;, every disposer the culler, the strip's legends, the finder and the top container add is reached from the page's teardown;, the CI time against §13 (Tasks 5, 6, 31) and the masterSpec block's pins against §15;
  - §16's hand-overs still true of the code as built (the nibble and `caveBiomeQ` for SP8b and SP8c; `floorY` for SP7's lava; `applyDrawRange` and region culling for SP11).
- [ ] **Step 2:** Each finding is fixed test-first in its module, one commit each (`fix(sp6b): …`); a finding that changes generated output or would loosen a gate goes to the user (a second generator push would bump to 10).
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:metrics`, `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`, and the smoke again. Expected: PASS; no golden diff.

---

### Task 58: CI at the exit (conditional Stage 2)

**Files:**
- Modify: the SP6b spec (`## Exit evidence`: "### CI at the exit (Task 58)")

- [ ] **Step 0:** Task 59 Step 0's commit (the master at the exit and its pins; it touches `test/arch/`, not `src/**` or `test/harness/**`, so the region caches stay warm) is pushed before Step 1, so the exit commit is docs-only (§13).
- [ ] **Step 1: Measure** the last two cold runs before the exit commit (pushes that change `src/**` or `test/harness/**`; a cold re-run made as Task 5 Step 1 if needed), each job's time and the wall, a warm re-run beside each.
- [ ] **Step 2: The rule.** Both ≤ 6 min 0 s → done. Otherwise Stage 2's items not yet taken (Task 6's 6a-6c) in order, each pushed and measured, until two cold runs read ≤ 6:00; still above after the list → **STOP for the user** with the job tables (no sample reductions, R23).
- [ ] **Step 3: Commit** `docs(sp6b): CI at the exit measured` (`git add docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md`; when Task 6 never ran, this commit also rewords §13 per Spec correction 17).

---

### Task 59: Exit: evidence and docs

**Files:**
- Modify:
  - the SP6b spec (`## Exit evidence`, Status)
  - `CLAUDE.md`
  - `README.md`
  - Step 0's commit only (before Task 58's measured runs, so the exit commit stays docs-only, §13, `.github/workflows/ci.yml:31`): master §10 (the SP6b entry's contents line as built, the "Received from SP6a" items worded as delivered or handed on in place, the "Received from SP6a's user check" item worded as delivered (D6, §5), **Exit** "as the SP6b spec §18 (…)", **Cut line** §17's wording with whether each item was taken; item 1), the Default receivers (`:1794`, item 4: Task 54's four entries, each gaining "(delivered in SP6b, so nothing moved)" when taken), and `test/arch/masterSpec.test.ts` (MST:1927, :1931-1932, :1957-1959 and :2007-2017 moved and rewritten, each Received item pinned on its delivered wording in the SP6b describe; items 1 and 4 pinned with `toBe`/`toContain` on the exit wording)

- [ ] **Step 0: Master at the exit** (its own commit, before Task 58 Step 1; it touches no `src/**` or `test/harness/**`, so the region caches stay warm): the master §10 rewording and the pins above, so `npm test` stays green; `npm run typecheck && npm test`; commit `docs(sp6b): master §10 at the exit; its pins` (`git add docs/superpowers/specs/2026-09-26-architecture-design.md test/arch/masterSpec.test.ts`).
- [ ] **Step 1: Exit checks** (§18): `npm run build && npm test && METRICS_TIMEOUT_SCALE=3 npm run test:metrics:full` (C7, DT1, S1, T1 one at a time; B3, R3, C1-C9 with C7's bottom parts, L2, S1, S2, T4, DT1, DT2 on every tier); `npm run bench` (`terrain.real` ≤ 13 / 20, `terrain.islands` ≤ 14.5 / 26.5, `slice.biome3d128` and `slice.caves128` ≤ 300, every other row and the +30 % rule; `caveBiome.column`, `cull.walk.rd12`/`rd16` recorded); `GENERATOR_VERSION` 9; `npx --yes bun@1 test/tools/goldensJsc.ts` 65/65; `?selftest=1` 65/65 in Chrome (the smoke) and Firefox (Task 52); `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` green; CI per Task 58.
- [ ] **Step 2: Master at the exit**: landed by Step 0; if Steps 1-3 change a fact the master's exit wording states (a cut-line item, a delivered line), a follow-up of Step 0's form lands before the exit commit, which then still touches docs only.
- [ ] **Step 3: Exit evidence**, before the Threshold log: the CI work item and the exit's runs; D25's two checkpoints with the levers applied (Tasks 24, 25, 40, 41); the generator push's golden diff; `cave_heavy`'s cheese offset with its C1, C2, C9; B3 per window and its border parts; R3's values; the bench; L13 and L14 in Chrome and the user's Firefox run, `xrayApplyRefillMs`; the review links and shots; the selftests; §19's audit (Task 54); the cut line as taken.
- [ ] **Step 4:** Status "implemented, awaiting CI, the production check and the user's check"; `CLAUDE.md` and `README.md` the same.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `docs(sp6b): exit evidence and docs`, docs-only (`git add docs/superpowers/specs/2026-11-12-sp6b-cave-biomes-design.md CLAUDE.md README.md`).

---

### Task 60: Merge, production check, the user's check, SP6b complete

**STOP for the user's go-ahead** before Step 0.

- [ ] **Step 0: An SP6a world in production** (under Step 2's Chrome STOP conditions: PRIME on-demand, eDP-1 at 240 Hz, `LockedHint=no`, load below 1): before the merge, while the production URL still serves SP6a, the agent's headful Chrome (a `mktemp -d /tmp/wi10-XXXX` profile kept until Step 2) opens the production URL and saves a world there with an edit under a wide cave's floor.
- [ ] **Step 1:** Merge `sp6b/cave-biomes` to `main` and push; CI green, its wall recorded against 6:00.
- [ ] **Step 2: Production, headful** (§18), on the deployed build:
  - **Chrome** (RegionBatch; the agent's own headful Chrome on the Iris Xe, its own `mktemp -d` profile, `MESA_SHADER_CACHE_DISABLE=true` in its env only; **STOP** until the user confirms the GPU conditions): each biome by its link, the X-ray by biome (C), the map layer, `cave_heavy`, a cave with culling (no hole, no pop-in on a walk through a doorway), the bottom cavern; Step 0's SP6a world shows the floor, the cave biomes and the older-generator badge (D29) with its edit kept; `?selftest=1` 65/65 and "IndexedDB contract: 10/10"; page and console errors 0;
  - **Firefox** (RegionMesh; **STOP for the user**, in the user's own Firefox, by hand): the same steps and production's `?selftest=1`;, the controller commits `assets/sp6b/production-check.json` (`docs(sp6b): the production check`).
- [ ] **Step 3: STOP for the user's check** (§12.8): from the links (or flying with C and Find), go down into caves and recognise lush (moss floors and ceilings, clay patches), dripstone (dripstone floors and ceilings) and the abyss (dark layered rock all round, ash floors) by their blocks, with night vision (L) where the cave is too dark; see that wide caves no longer end on a flat bedrock floor (the `bottomCavern` link). Offered, not part of the check: the X-ray by biome (C), `cave_heavy`, the map's layer.
- [ ] **Step 4:** After the user's verdict (a finding goes back test-first, with another go-ahead before it reaches `main`; a retune is a second generator push, `GENERATOR_VERSION` 10), a final commit marks SP6b complete (`CLAUDE.md`, `README.md`, the spec's Status, the cut-line pin): `docs: SP6b complete`.

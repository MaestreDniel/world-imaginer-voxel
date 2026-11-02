# SP6a — The shape of the caves: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the surface the player finds, now and then, an entrance or a ravine that leads down; underground there are eight kinds of cave (cheese caverns with pillars, spaghetti 3D and 2D, noodles, entrances, worms with flat floors, ravines, underground worms) and, in some regions, very large interiors; no flat wall or clean cut shows where a cave meets a chunk border, a depth limit, water, the islands' cap or another kind. Every size, frequency, depth range and rarity is a leaf of a new `caves` group on the map's Parameters tab, regenerating the world live (SP4c). X shows the X-ray (the caves' hollows translucent and coloured by kind, a depth band moved with PageUp, PageDown and Home, the surface a faint film); light level 0 shows a faint floor; L turns on night vision. Worlds saved before SP6a open with the caves (D36). Size XL (about 51 tasks; the user's "XL, complete"); the floating_islands summit caps that caves add are accepted until SP12 (the user's "Accept until SP12"). The generated world changes: `GENERATOR_VERSION` 5 → 6 at push A and 6 → 7 at push B (8 only after a retune the user's check asks for).

**Architecture:**
- **The density tree as data** (D17, D18, D2, D7, D8). One new Expr op, `noiseScaled{id, s}` (Tasks 2-3). `DEFAULT_DENSITY_TREE` gets the terrain body as `defs.body` read through `ref body`, and its final root shape with two placeholder slots, output byte-identical (Task 4); then the cave families as one `interpolated` slot each, with the family floor, the surface ramp, the sky gate, `detailG`, the rarity blends, the noodle's four slots and `nb`, the depth-band caps (gentle then steep), the wet roof and the island cap `caves.limits.capTop` (Tasks 6-9). Amplified and floating_islands re-derive from it.
- **Parameters** (D9). A top-level `caves` group after `islands`, its noises under `caves.noises.*`; `ALLOWED_REF_TARGETS`, the noise lookups and the cost weights accept `caves.`; the terrain stage reads `['density', 'surface', 'caves']` (version 4). Leaves land with the tree term or carver that reads them (U2 refuses a dead leaf; Spec correction 4).
- **Saved worlds** (D36). `SCHEMA_VERSION` 3: a stored tree canonically equal to one of SP5c's three built-in trees becomes today's tree of the same kind (Task 5).
- **The tag** (D20, D22). A per-voxel `cave` u8 channel in the store (proto and final sets, the padded view, a 208-int record; Task 10); a compiled `tapReader` and the tag rule (noise kinds and kind 9, Task 11; carver kinds, Task 27); `caveTagAt` and `solidAt` (Task 12; with the carvers, Task 27).
- **Carvers** (D5, D21, D35). `gen/caves/carvers.ts` (pure paths: worms with rooms and branches, underground worms, ravines; `Xoshiro128` from `deriveSeed`, detMath), `carverCache.ts` (an LRU of 1,024 paths per GenContext), `carve.ts` (the carve step in T before water v0 and the surface pass, the shrinks σ_w, σ_i, σ_u; `carvedAt`) (Tasks 24-28).
- **Measured first** (D25). The slice reference's corner memo (Task 13), then D25's prototype (Task 14) with its levers (Task 15) before the X-ray and the carvers; the second checkpoint after them (Task 36) with its levers (Task 37).
- **The X-ray** (D10, D23). `mesh/xray.ts` (`meshXray`, the `xray` pack layout, pass 3), pass 3 through the payload, the protocol and both renderers, `xray.glsl` (additive, the band, the radius, the film), the `xrayOn` collapse uniform in the terrain (not `GHOST`) and water shaders, the strip, the HUD line and the notices (Tasks 17-21).
- **Light** (D14, D15). `LIGHT_FLOOR` 0.02 in `lightmapRgba`; night vision as a lightmap input eased over 0.3 s, `WorldSettings.nightVision`, L (Tasks 22-23).
- **UI** (D11-D13, D16). Five `view` actions; the Caves section's lints; the Density tab's `caves` field and the Cross-section tint; the Caves tab with the band sliders, the cave slice, the parameters link and the finder (Tasks 20, 41-44).
- **Measurement.** `test/metrics/caves.metric.ts` (C1-C9) with its own CI shards; the harness's `debugTags`, 3D components and global carver reference; DT1 `carverCache`, `isolated`; DT2 `tagProbe`; L2, S1, T2, R1, R2 re-asserted; P1 (T ≤ 10 / 20 ms), the kill criterion against `test/bench/inlined.ts`; bench legs L13 (caves) and L14 (the X-ray) with every Chrome route re-measured into `assets/sp6a/`.
- **Pushes** (D28, §12.3). Push A (Task 16) carries the op, the cave families, the caps, the wet roof, the island cap, the migration and the tag channel with the noise kinds (5 → 6); the X-ray and the light (Tasks 17-23) change no generated output and follow push A; push B (Task 39) carries the carvers, the carver kinds, the metrics, the levers and the tuning (6 → 7); the UI, the Chrome legs and the docs follow it.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24.21 (`worker_threads`), three r186 (`~0.186.1`), the tools' own Chrome over CDP, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md` (approved 2026-11-02; the binding authority, with the user's answers under Points for the user: Point 1 "XL, complete", so the `caves` slice field, the Caves tab with its finder and the gating of C7-C9 are in scope; Point 2 "Accept until SP12", so `runBottomAbove` stays SP12's and `islandBranchOnGround` is recorded before and after caves). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Recon behind the spec: `.superpowers/sp6/recon-{obligations,gen,render,ui,tests}.md`, `review-technical.md`, `review-fidelity.md`, `builder-check.md`, `revise-notes.md` (git-ignored; the controller has them). Template: the SP5c plan.

**Plan form.** Compact, as SP4a's to SP5c's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (what it consumes and produces, with exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies (sketched only for the tag pass over a filled column and the carve loop, whose orders the tests do not fully pin; the carver paths' draw order is pinned as a numbered list, since `sp6a.carver.paths` freezes it); the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` c64b4a9 (code identical to 5631c45, the spec's citation base: `git diff --stat 5631c45 c64b4a9` touches only the spec).

**Spec corrections found while planning** (numbered as the tasks cite them; each folded in by the task named, the first one when it names two; the controller rewords the spec in that task's commit, whose `git add` includes `docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`):
1. **The stand-ins and the swap live in `regionGrid.ts`, and its stand-in list is fixed at three passes** (§5.1 "Compiled at load through the stand-ins (`src/render/sectionRenderer.ts:224-231`)", §5.4 "SP4c's swap, `sectionRenderer.ts:188-195`"): `sectionRenderer.ts` has 172 lines; `addStandIns` is `src/render/regionGrid.ts:551-559`, whose loop names `[MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT]`, and the swap is `RegionBackend.swap` (`regionGrid.ts:175-178`). `addStandIns` gains pass 3, a site §5.1's list lacks. Task 19 (§5.1, §5.2, §5.4 reworded).
2. **Gen exports no numeric data** (§3.2 "`gen/caves/tags.ts` … CAVE_KIND ids"; the module layout): `test/arch/rules/banned.ts:84-99` refuses an exported numeric constant or exported data with numbers anywhere in `gen/` outside the structure templates. `CAVE_KIND`, `CAVE_FILM_KIND` (15), `CARVER_WINDOW_R` (11) and `CARVER_CACHE_PATHS` (1,024) live in `src/core/constants.ts`, which gen, mesh, render, ui and the metrics all value-import; `gen/caves/*` exports functions and types only. Task 11 (`CAVE_KIND`), Task 24 (`CARVER_WINDOW_R`), Task 26 (`CARVER_CACHE_PATHS`) (the module layout and §3.2 reworded).
3. **`SCHEMA_VERSION` 3 needs U4's version-2 fixtures** (§12.4 names the migration and its tests only): U4's `migrationFailures` imports `test/fixtures/preset-v{v}.json` and compares it with `expected-v{v}.json` for every v < `SCHEMA_VERSION` (`test/metrics/params.metric.ts:24-30`); only `preset-v1.json` and `expected-v1.json` exist. Task 5 adds `preset-v2.json` (schema 2, the SP5c default tree in `density.defs`, one other edited leaf) and `expected-v2.json` (today's default tree, the edited leaf kept) (§12.4 reworded).
4. **A leaf lands with the term that reads it** (§4 and Point 1's count put "the parameters (2)" apart from the terms and the carvers): U2 runs on every tier and fails on any dead leaf (`test/metrics/params.metric.ts:43-50`, `src/metrics/liveness.ts`), so a `caves.*` leaf no tree or carver reads would turn `npm test` red. The noise-family leaves and `caves.noises.*` land with the terms (Tasks 6-9), the carver leaves with the carve step in T (Task 27); Parameters II (Task 41) carries the panel's lints and the live-Apply test only. `liveness.ts:231`'s `density.defs` variant (`at: ['root', 'a', 'a']`, the `terrain` tap) follows the new root (Task 4). Task 4, Task 6, Task 27 (§4 reworded).
5. **`T + detailG` is not a tap** (§3.2 step 2 "else if `T + detailG ≤ 0` (not pre-cave solid), 0"; the pillar bit; "the values are read through a new compiled `tapReader(name)`"): the tag needs the pre-cave density at voxels `voxelFn` never evaluated (cells decided air after their corners, `src/gen/density/bounds.ts:277-292`), and no reader can name an untapped node. The default tree taps it: `tap precave(add(tap terrain(…), detailG))`, output unchanged; a tree without `precave` falls back to the `terrain` tap (pre-cave solid where T > 0), and with neither to §3.2's "no `terrain` tap" rule. Task 4 (the tap), Task 11 (the reader) (§3.2 and §1.1 reworded).
6. **`detailG` cannot read the `terrain` tap** (§1.1 "`detailG = rangeChoice(T, −1e9, 16, detail, 0)`"): a tap name is unique (`DUPLICATE_TAP`, `src/gen/density/expr.ts:105`), so `detailG`'s `x` is `interpolated(ref body)`, which the compiler CSE-shares with the tap's child (same structure, inside; `src/gen/density/compile.ts:174-187`); the same holds for every read of T inside a slot (`ref body` at the corner) and for the noodle's voxel-level wet roof. Task 6 (§1.1 reworded).
7. **The X-ray commit cannot resize the reservations from caves with carvers** (§5.1 "D25's second checkpoint re-measures every pass's use with caves and the X-ray commit resizes the reservations"): D28 orders the X-ray (no generated output) between push A and push B, and the resize needs Task 36's measurements with carvers and the X-ray pass, which exist only inside push B (D25 puts the second checkpoint after the carvers); §12.3 keeps the X-ray, light, UI and Chrome work out of push B's unpushed generator commits, so the resize lands right after push B. Pass 3 starts at the 16,384-vertex estimate (Task 19); the second checkpoint measures every pass's use (Task 36), and the resize lands right after push B (Task 40). Task 19, Task 40 (§5.1 and D25 reworded).
8. **`slice.caves128` cannot run at the prototype** (D25 "measure … `slice.vertical128`, `slice.caves128` (with the reference's corner memo)"): the `caves` field needs `caveTagAt` with the carvers (§7.4), which push B builds. The prototype measures `slice.vertical128` with the memo (Task 14); `slice.caves128` is added and gated with the field (Task 42), under the same rule (a miss after the memo → the slice redraws on release, then the user). Task 14, Task 42 (D25 reworded).
9. **Plain bindings would take the browser's Ctrl shortcuts** (§7.1's table binds `PageDown`, `PageUp`, `Home` and `KeyL` with no modifier; only `KeyX` says "without Ctrl"): a code binding without `ctrl` matches with Ctrl held (`src/player/keymap.ts:20-24`) and a bound key has its default prevented (`src/player/input.ts:8-11`), so Ctrl+PageDown (next tab), Ctrl+PageUp, Ctrl+Home and Ctrl+L (the address bar) would stop working. All five bindings are `ctrl: false`. Task 20 (§7.1 reworded).
10. **`measureChrome.ts`' `ASSETS` is at `:71`** (§10.6 cites `:73`). Task 46.
11. **`panel.reveal('caves')` reveals nothing** (§7.3 "Cave parameters" (`panel.reveal('caves')`, `src/ui/paramPanel/panel.ts:130-141`)): `reveal(path)` looks the path up among the leaf controls and returns when it finds none (`panel.ts:131-132`), so a group path does nothing. The link reveals `caves.cheese.offset`, the Caves section's first leaf, which opens the section and its Cheese sub-section. Task 43 (§7.3 reworded).
12. **U2's leaf count is pinned in master §6.4's U2 row** (§13 lists no U2-row amendment): `test/arch/masterSpec.test.ts:425-431` pins `U2 covers 73 leaves (amended by SP3e)` and `test/unit/liveness.test.ts:465-467` the count 73, and every task that adds terrain-stage leaves changes it. §6.4's U2 row gains `; SP6a: the caves.* leaves are decided on the cave class column or a bounded witness; U2 covers <n> leaves (amended by SP6a)`, rewritten with the new n by Tasks 6, 7, 8, 9 and 27 and pinned in the SP6a describe (the `:425-431` check moves there). Task 6 (§13 gains the item).
13. **`caves.spaghetti2d.maxY` 320 is dead under U2** (§4's default, with Spec correction 4's "U2 fails on any dead leaf"): spaghetti 2D's layer term opens only where |layerAmp·Nel + 8 − (y + 64)/8| < 0.95 + 0.35·Nthk ≤ 2 (|Nel|, |Nthk| ≤ clampSigma 3), so never above y ≈ 208, and U2's steps of 320 are 272 and 320 (`numberSteps`, `src/metrics/liveness.ts:183-193`: 368 re-steps and clamps back to 320). Task 8 **STOPs for the user**: (a) the default lowered (the plan's proposal 200, so the step to 170 reaches the layer; spec §4 and the master's value amended), or (b) a U2 exemption for the leaf recorded in the spec with its reason. Task 8 (§4 reworded as the user decides).
14. **The wet roof's steep part is read per position, at voxel level** (§1.4 "the gain 4 makes a position whose nearest corner is in a lake fully wet (the nearest corner's bilinear weight is ≥ 1/4)"): inside a slot wet′ is a COLUMN subtree evaluated at the cell's four lattice corners and trilerped (`src/gen/density/reference.ts:10`, `src/gen/density/bounds.ts:7`), so wet′ = 1 at a wet position does not close the slot there (at a shoreline cell whose nearest corner alone is wet the cap is a blend weighted about 1/4 toward wet). The steep part `128·h_w` is added at voxel level, outside the slots, to the caves slot and to the noodle, with wet′ from the position's bilinear `col` readout and d = `interpolated(ref body)` (Spec correction 6); the gentle part g_w stays in the slots. `wetCover`'s position scan is then exact. Task 9 (§1.4 reworded).
15. **Lever 4's noodle skip keeps the output only against the other terms** (§1.6 lever (4) "the noodle is skipped where its cell interval is positive"): the noodle is often the smallest positive term in rock, so dropping a positive noodle changes the value of `min(…)` and DT2's `Object.is` checks (`test/harness/dt2.ts:207-217`, against the reference, which never skips). The noodle is skipped where its cell interval's low end exceeds the high end of min(T + detailG, caves) over the cell (it cannot be the minimum), as for the families. Task 15 (15a; Task 37 when it runs there) (§1.6 reworded).
16. **Lever 6 is written in the tree** (§1.6 lever (6) "it needs per-slot laziness in `cornerFn`"): a laziness in `compile.ts` alone would make the compiled values differ from `reference.ts` (the DT2 `compiledReference` oracle and the slice evaluator), and a skipped slot read as +∞ makes `trilerp` NaN (0·∞, `src/gen/density/nodes.ts:125-134`). Each spaghetti slot's body becomes `rangeChoice(min(<E's corner body>, <C's corner body>), −1e9, −16, const 1e6, <its body>)` inside its `interpolated`, the two bodies written as `ref`s CSE-shared with the entrance and cheese taps' children; the compiled `rangeChoice` evaluates only the chosen branch, so the skip needs no compiler change and compiled = reference by construction. Task 15 (15c; Task 37 when it runs there) (§1.6 reworded).
17. **`C7.endTaper` excludes the start room** (§10.1 "path ends (branch points excluded)"; §2.2 "both ends taper to 1.5·mul"): a room is the path's first ellipsoid, up to 7·hMul, larger than the 4 step ellipsoids after it and the path's median. The start end is measured from the first step ellipsoid after the room. Task 24 (§10.1's `endTaper` and §2.2 reworded).
18. **The carve's top under floating islands** (§2.4 "d = the target position's pre-cave top (its highest solid voxel after the density fill, before carving)"): with `islands.enabled` that voxel is an island's top, so σ_w is 0 under an island over the sea and carvers open right under the sea bed, where water v0 fills them (`src/gen/pipeline/terrainStage.ts:113-134`: island runs never shelter the sea under them). With `islands.enabled` the top is that of the highest solid run whose bottom lies below `ISLAND_RUN_MIN_BOTTOM` (water v0's BASE rule), else the highest solid y. The plan names it the column's **density top** (`densityTop`), apart from Task 29's `preCaveTop` (the highest voxel solid or tagged, which an entrance breaching the top raises). Task 26 (§2.4 reworded).
19. **C2's sky-connected components are components of tagged air** (§10.1's C2, C3.ravines, C5, C9): over every air voxel the open atmosphere is one component that every entrance joins (C2 ≈ 1 per region, C5.largest ≈ the whole void); over tagged voxels only, nothing reaches y 319. `components3d` labels tagged air, and a component is sky-connected when one of its voxels is face-adjacent to untagged air that a sky flood from y 319 reaches. Task 29 (§10.1's instrument reworded).
20. **L13 searches from its own start** (§10.6 "the finder's job finds the nearest entrance within 512 blocks of the bench's start"): by L13 the camera hovers at L10's point, about 20,000 blocks east of the script's start (L9's teleport, `src/ui/world/bench.ts:136-142`, `:2100`), where nothing is loaded. The finder searches from the camera at L13's start, whose RD 12 disc is loaded. Task 45 (§10.6 reworded).
21. **A carver kind's hit needs one density read** (§7.3 "for carver kinds, the path cache's boxes and their ellipsoids, with no density"): an ellipsoid centre is carver-tagged only where the density left it solid (a worm through a cheese cavern is tagged cheese there, §3.2 step 3; a worm path above the ground carves nothing), so a hit from the paths alone can name a voxel of another kind or of open sky. The paths give the candidates with no density over the search area; each candidate is confirmed by one `caveTagAt`. Task 44 (§7.3 reworded).

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin (`SMOKE_KEYS`, `measureChrome.ts`' `ASSETS`). A `.mjs` module a TS test imports gets a sibling `.d.mts`.
  - **No new dependencies** (`CLAUDE.md`'s rule; master §0's YAGNI line).
- **Layers** (`test/arch/rules/imports.ts`; no rule changes, every new module sits in an existing layer):
  - `gen/caves/carvers.ts`, `carverCache.ts`, `carve.ts`, `tags.ts` are `gen/` (value-import `core`, `gen`, `world/blocks/**`; `world/store/api.ts` type-only, `imports.ts:18`); they export functions and types only (Spec correction 2); every import a hot file uses is bound to a module `const` (`banned.ts:197-198`, the `const READ = readField;` pattern of `liveness.ts`). The finder's search core lives in `tags.ts` **(plan)**, its clock injected.
  - `src/metrics/sp6aGoldens.ts` is `metrics/` and joins `DET_FILES` (`banned.ts:19-21`).
  - `mesh/xray.ts` is `mesh/` (`LIGHT_MESH`, `imports.ts:12`); it reads the padded view's `cave` array, never the store.
  - `render/materials/glsl/xray.glsl.ts` and the X-ray material are the only new GLSL (`render/materials/**`, the GLSL boundary, `banned.ts:218-219`); `src/render/xrayPalette.ts` **(plan)** holds the 16 sRGB colours and labels, which `ui` (the strip, the legend, the slice) value-imports; no `ui` module imports `render/materials/**`.
  - `ui/world/xrayStrip.ts` (the strip and the pure band model), `ui/map/cavesTab.ts`: `ui/`, text through `textContent` only (`test/arch/uiText.test.ts`), no browser dialogs (`test/arch/uiDialogs.test.ts`).
- **Pure and deterministic generator.** `core/`, `world/`, `gen/` and `DET_FILES` use no `Math.random`, `Date.now`, `performance.now`, `console.*`; `gen/` and `core/` use only `MATH_ALLOWED` (`banned.ts:10-11`: abs, floor, ceil, round, trunc, sign, min, max, imul, clz32, sqrt and the constants), never `**` (`banned.ts:205`); every sine and cosine is `detSin`/`detCos` (`src/core/detMath.ts`, |x| ≤ 2^21); every RNG is `Xoshiro128` seeded from `deriveSeed` (`src/core/rng.ts:17-66`, `src/core/hash.ts:262`). The carve test runs in world coordinates in one operation order (§2.4), so two columns compute the same doubles for one voxel.
- **The generated world: two output-changing pushes** (spec §12.3, D28).
  - **Push A** (Tasks 1-16; base `c64b4a9`): `GENERATOR_VERSION` 5 → 6 and the terrain stage's version 3 → 4 in Task 6, its first output-changing commit. **Push B** (Tasks 24-39; base push A's head, recorded in Task 16): 6 → 7 in Task 27, its first output-changing commit.
  - Within a push, every commit that touches `gen/`, `core/params/`, `world/store/`, `workers/` or `metrics/` runs `git checkout <base> -- test/goldens.json && npm run test:goldens`, then `git diff <base> -- test/goldens.json`, which lists only `generatorVersion` and §12.3's allowed keys: `sp1.params`; `sp3a.region.T.default`, `sp3a.region.T.large_biomes`; `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`; `sp3b.density.default`; `sp3c.surface.ops`; the new `sp6a.density.ops` (push A), `sp6a.carver.paths` and `sp6a.region.T.caves` (push B). Expected unchanged: every `sp2a.*` (`sp2a.spawn` keeps the 2D path, §3.4), `sp3e.column.point.*`, `sp3b.density.ops`, `sp3a.registry`, `sp3c.registry`. A commit before its push's first output-changing commit (Task 2, and Tasks 4-5, one commit) shows an empty diff (Task 3 only adds `sp6a.density.ops`). A key outside the list is a bug: find it, never re-record past it.
  - Work that changes no generated output (the X-ray, the light, the UI, the Chrome legs) sits between push A and push B (Tasks 17-23) or after push B (Tasks 40-54), never between unpushed generator commits; its tasks run `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`.
  - The count of golden keys: 59 → 60 (Task 3) → 61 (Task 27) → 62 (Task 39), each change also moving the five tests that pin the key list by count and negative slices (`test/unit/goldens.sp2a.test.ts:10`, `goldens.sp3a.test.ts:34`, `goldens.sp3b.test.ts:44-45`, `goldens.sp3c.test.ts:53-56`, `goldens.sp3e.test.ts:53-56`; Task 3), followed by `?selftest=1`, the smoke (it counts from `goldens.json`, `test/tools/uiSmoke.ts:200-213`) and `npx --yes bun@1 test/tools/goldensJsc.ts`.
- **Saved worlds.** `SCHEMA_VERSION` 2 → 3 with `MIGRATIONS[1]` (Task 5, D36); `test/schema-shape.lock.json` accepted with `npm run test:accept-schema` in Task 5 and in every task that adds leaves or moves a leaf default (6, 7, 8, 9, 27, 38, lever 15b); `wi10` and the diff format unchanged (the `cave` channel is never persisted); `test/stateIds.lock.json` byte-identical (no state is added).
  - **U4's migration fixtures.** `test/fixtures/expected-v1.json` (and, from Tasks 4-5 on, `expected-v2.json`) hold the full imported params, every group and the profile's whole density tree (`test/metrics/params.metric.ts:24-30`; U4 runs on every tier, so in `npm test`'s metrics-fast). Every task that adds a leaf, moves a default or changes the default tree regenerates both from `importPreset(preset-v{v}).params` (canonical) and stages them: Tasks 4-5, 6, 7, 8, 9, 27, 38 and the output-changing levers 15b and 15c (SP3e's precedent, f7806f5 and 27824dc); each such task's run checks U4 `migrationFailures` 0.
  - **Mirrors of the defaults.** A task or lever that moves a cave default or a tree literal also updates what mirrors it, by explicit path: master §3.6's table and its pin (Task 9's, read from `DEFAULTS.caves`); `npm run docs:params` (README); `test/harness/carverParams.ts` when a carver default moves (pinned equal to `carverParamsOf(DEFAULTS)` by Task 27); `test/bench/inlined.ts` and `test/unit/inlined.test.ts` once they exist (Task 35) when a tree literal or lever 6's skip changes; U4's fixtures; the schema lock when a leaf default moves.
  - **The default tree's cost and count pins.** Every task that changes `DEFAULT_DENSITY_TREE` (4, 6, 7, 8, 9, and the levers 15c) recomputes in the same commit the literals that pin its node counts and costs: `test/unit/inspectCost.test.ts:136-141` (and `:172`), `test/unit/sliceCost.test.ts:29-80` (its paths too), `test/unit/presetTrees.test.ts:185-193` and `:462-471`, `test/unit/defaultTrees.test.ts:176-180`; `DENSITY_COLUMN_COST_MAX` stays pinned as `64 × 14,907,917` (D24), never as 64 × the live default.
- **Governance.**
  - `test/thresholds.lock.json` changes only through `npm run test:accept-thresholds`, in Task 1 (`startedSps` and `S1.grassSky0`'s `activeFrom`), Task 12 (`DT2.tagProbe`), Task 19 (`R1.xray`), Task 28 (`DT1.carverCache`, `DT1.isolated`), Task 30 (`C7.carverReference`, `C7.reachOverflow`, `C7.endTaper`, `C7.islandCapAir`), Task 38 (every tuning part), Task 47 (L13's and L14's parts) and a conditional lever or tuning step that the user's decision changes; each such commit adds one line to the SP6a spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`); `<date>` in the log lines below stands for that commit's date. No gate is loosened without the user's decision recorded in that line.
  - `test/bench/gates.ts` changes by spec amendment only (`gates.ts:1`): `TERRAIN_P50_MAX_MS` 4 → 10 and `TERRAIN_P99_MAX_MS` 20 (Task 14), `SLICE_CAVES_P50_MAX_MS` 300 (Task 42); `test/baselines.json` (not a lock) is re-recorded in Tasks 14, 34, 35, 39 and 42, each time after a `BENCH_EXEMPT` run of §10.5's rows that rise by design: `test/unit/benchGates.test.ts:264-266` requires its kernels to equal `BENCH_ROWS`, so a task that adds a row records it in the same commit. `noise.bench.ts:573` requires the measured rows to equal `BENCH_ROWS` in order, so a new row is inserted in `BENCH_ROWS` where it is measured, and `benchGates.test.ts`' order pins (`:247-261`) follow. `finder.nearest` is logged by `noise.bench.ts`, outside `BENCH_ROWS` (recorded, no gate; Task 44).
  - Master amendments land in the commits below, each pinned in a new `describe('master spec amendments (SP6a §13)')` in `test/arch/masterSpec.test.ts`, created by Task 1, with the earlier pins that name SP6 moved into it (`:639-640`, `:883`, `:973`, `:1187`, `:1214-1215`, `:1416`, `:1756`, `:1803`, `:1830`, `:1836`; the header comment `:39`, `:69` and the paragraph after `:90-104`; `:141-168` follow the new ids). **(plan)** A table `SP6A_MODULES: Array<[head: RegExp, token: string, file: string]>` in that describe, checked by "§1 names each SP6a module in its entry, which exists" (the `SP5C_MODULES` pattern, `masterSpec.test.ts:1644-1664`), added with its first row by Task 11; each task that creates a module appends its row.
- **Master amendments by task** (spec §13's items; each pinned in the SP6a describe by the task that lands it): Task 1: items 1-7 (the split paragraph, the SP6a and SP6b entries, the SP7 header and the "Received from SP6a" lines of SP7-SP12, the critical path and visible value, the default receivers, §2.5's `SubProjectId`, the bare "SP6" rewording); Task 3: item 10 (§2.5 `noiseScaled`), and §1's `metrics/*.ts` entry and §0's "Banned APIs" `DET_FILES` list gaining `sp6aGoldens.ts` (pinned by the existing checks `masterSpec.test.ts:202-218` and in the SP6a describe); Task 6: item 16's §5.1 (Terrain scope "caves (`caves.*`)"); Tasks 6, 7, 8, 9 and 27: §6.4's U2 row and its leaf count (Spec correction 12); Task 9: item 11 (§3.6 as built, but its debug-channel sentence); Task 10: item 9 (§2.3 `cave`); Task 11: item 11's debug-channel sentence, item 8's `gen/caves/*` token (the line under `gen/` reads `      caves/carvers.ts carverCache.ts carve.ts tags.ts (SP6a)`, its `SP6A_MODULES` rows, all with the head `/^\s+caves\/carvers\.ts /`, added by Tasks 11, 24 and 26); Task 17: item 8's `mesh/` token; Task 18: item 8's `materials/` line; Task 19: item 13 (§4.5); Task 20: item 15's §5.9; Task 21: item 8's `ui/world/*` token; Task 22: item 14 (§4.8's floor, §6.3); Task 23: item 14's night-vision half, item 15's §4.16; Task 27: item 12 (§3.8); Task 30: item 17 (§6.1), item 8's test entry (`metrics/caves.metric.ts`), item 18's C7 construction rows and `MetricId`; Task 35: item 8's test entry (`bench/inlined.ts`); Task 38: item 18 (§6.4's C1-C9, S1, L2, R2 rows, cross-checked against `THRESHOLDS`); Task 40: §4.5's reservation sentence (`masterSpec.test.ts:843`) when a reservation changes; Task 42: item 16's §5.5 and §5.6; Task 43: item 8's `ui/map/*` token; Task 47: item 18's G1 row (L13, L14); Task 50: item 19 (§7's "Measured in SP6a", §8 risk 3); Task 53: item 2's "Received from SP3e" worded as delivered, the Cut line and item 5's receivers worded by whether each cut-line item was taken.
- **Zero allocation** (SP4b D25): the frame step at rest allocates nothing with the X-ray on at a fixed band and with night vision on after its ease: a toggle and the ease write uniforms, the clear colour and the lightmap's preallocated bytes only (spec §5.3 asks it of a toggle; a band step returns a new `XrayBand` and rebuilds the strip's text, a user action, not a frame); the strip's text is set only when the state changes. Pinned in Task 21 (the X-ray) and Task 23 (night vision) in `test/unit/zeroAlloc.test.ts` (`unit (heavy)`), under the 256 B-per-tick budget and 256 KB per 10,000 calls.
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit.
- **CI time budget** (spec §11, against SP5c's exit run 41396465620: wall 2 min 56 s; long pole `metrics-quick (terrain)` 158 s; `unit (rest)` 152 s; `metrics-quick (surface)` 147 s; `metrics-fast (rest)` 141 s; `check` 128 s; ±45 s between runs on one commit):
  - every terrain-generating metric file runs the heavier T: `metrics-quick (terrain)` ≈ 170-200 s, `metrics-quick (surface)` ≈ 170-200 s, the others +5-20 s each; region caches are keyed on `src/**` (`.github/workflows/ci.yml:128`, `:161`), so SP6a's first run starts every shard cold;
  - `caves.metric.ts` in new shards `caves`: quick ≈ 80-160 s plus setup, fast ≈ 20-40 s (`.github/scripts/metricShards.mjs:18-40`, `fastShards.mjs:20-24`, pinned by `test/unit/shards.test.ts:35-55`);
  - unit +15-30 s: SP5b's GOV-8 lever at once, the slowest new files into `unit (heavy)` (`.github/scripts/unitShards.mjs:20-24`) by the tasks that create them (`caveContinuity`, `caveTags`, `meshXray`, `carverPaths`);
  - `check` +5-10 s; expected wall ≈ 3.2-3.7 min without levers, ≈ 3.0-3.4 min with lever 1; **at most 3 min 30 s at the exit**. Levers in order, each measured (Task 39): (1) `apply.metric.ts` into a shard of its own (`metricShards.mjs:20`); (2) the `caves` quick shard split by profile; (3) the quick tier's caves regions 4 → 3 and (4) the quick terrain scatter's columns reduced, both **the user's decision**. Push A gives the first CI measurement with the heavier T, push B the first with the `caves` shards; the docs-only path grows by the unit additions only.
- **GPU measurements** (spec §10.6, as SP5c):
  - **Chrome cells** are an agent's, through `npm run measure:chrome -- --route bench|flight|enter --gpu iris|rtx [--workers 4]`, on a cold driver shader cache (`MESA_SHADER_CACHE_DISABLE=true` for the Iris Xe, `__GL_SHADER_DISK_CACHE=0` for the RTX, in the tool's own Chrome's env only; never `~/.cache/mesa_shader_cache` or any user cache), on the laptop panel eDP-1 at 240 Hz with the user's display awake and unlocked, on a quiet machine (the tool refuses above a 1-minute load of 2). The Iris Xe needs PRIME **on-demand**; the RTX cells run as SP5c's, and if the RTX probe refuses, under **'nvidia'**. Only the user switches PRIME; a switch logs the user out and ends the session, which the controller resumes with `claude --resume`.
  - **Firefox runs** are the user's, on a local `vite preview` the controller serves on **port 4173**: the selftest (62/62 and "IndexedDB contract: 10/10 passed") and a Firefox bench file (`?bench=medium`, L13 and L14 included; recorded, not gated; spec §10.6 and §16 "Firefox and RTX recorded") are asked for; the user's check is the user's.
- **Where the plan stops for the user** (each marked **STOP** in its task): Task 1 (`S1.grassSky0` above 0.1 % before it is gated); Task 8 (`caves.spaghetti2d.maxY`'s default or a U2 exemption, Spec correction 13, and any other `maxY` leaf whose witness scan finds none); Task 9 (a `wetCover` miss after its three widenings); Task 14 (PRIME on-demand for the 4-worker fill; and a miss after the levers, with the measurements, D25); Task 15 when it runs (before each Chrome re-measurement; a miss after its levers); Task 35 (a closure overhead above 25 %: the codegen amendment is the user's to approve); Task 36 (PRIME on-demand for the fill and the mesh rows); Task 37 when it runs (as Task 15); Task 38 (D4's entrance figures shown to the user at tuning, as D4 asks, before the rows are entered; a C1-C6 miss after the levers and the tuning, or a proposed bound the dry run misses: the measurements go to the user, whose bound is entered with a Threshold-log line); Task 33 (an R2 bound missed with caves); Task 39 (CI levers 3 and 4); Task 42 (a `slice.caves128` or `slice.vertical128` miss after the memo); Task 47 (PRIME on-demand, the display awake and unlocked, eDP-1 at 240 Hz; the RTX cells under 'nvidia' if their probe refuses, then back to on-demand); Task 48 when it runs (before each lever's measurement; `xrayApplyRefillMs` above 6,000 ms or a gate still missed after the levers); Task 51 (the user's Firefox selftest and bench file on 4173); Task 54 (the go-ahead to merge; Step 0's SP5c world saved in the agent's headful Chrome at the production URL before the merge; PRIME on-demand and the display awake for the agent's headful Chrome production check; the user's Firefox production steps; the user's check, the last criterion). The controller never switches PRIME and never runs the user's check for the user.
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and preview the controller serves runs on its own free port (**never 5183**, the user's compose service; **never 4190** for Firefox: the Firefox preview is 4173) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never open, close or touch the user's own browsers; no `xdotool` or any desktop input.
- **Outward-facing actions.** Pushing the branch is the controller's call (Task 16 pushes push A, Task 39 push B; other pushes at will after push B). Merging to `main`, pushing `main` and the production check happen in Task 54, after the user's go-ahead. Read-only git otherwise; never rewrite history (the goldens' `git checkout <base> -- test/goldens.json` restores one file in the working tree). `.superpowers/` is never committed.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.
- **Styling deferred.** Colours are named only so the kinds can be told apart (spec Non-goals); no layout or styling work beyond what the tests need.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways a user of SP6a would see caves vanish, mix or stutter, or lose work, most likely first; each names the test that pins it and the task that owns it.

1. **A live cave-parameter Apply racing the X-ray and the streaming.** X-ray on, the map side by side, a cave size released (the Apply regenerates every loaded column from T), then PageDown, X off and X on again while the columns swap. A person expects each column to show its old caves until its new ones swap in whole, never one column with the old terrain rows and the new X-ray rows, and the band and the toggle to stay as set. Task 19 pins in `regionGrid.test.ts`: "a revealed column staged again with rows in passes 0-3: until its last row uploads `prev`'s four passes show and the new ones are hidden; the pump that uploads the last swaps all four passes in one call; a column whose replacement has no pass-3 row hides `prev`'s pass-3 rows in the same swap; `setXray(true)` and `setXrayBand(-40, -9)` between the two pumps change uniforms only (no `stage`, `unstage` or `remove`, the staged count unchanged)"; Task 21 pins in `worldPage.test.ts`: "X on, an Apply of `caves.cheese.offset` 0.27 → 0.20 settling over 30 fake frames with PageDown at frame 5 and X twice at frames 10 and 11: the strip reads the moved band, `xrayOn` is 1 at the end, every column's shown seq is the Apply's, the stale count reaches 0".
2. **A world saved before SP6a opening with edits in what are now caves.** A GV5 world (schema 2, the SP5c default tree) whose diff places stone where a cheese cavern now is and digs a voxel that is now carved air; then the X-ray. A person expects the world to open with the caves (the older-generator badge), the placed stone floating where it was, the dug voxel air, and the X-ray to treat the stone as a wall and the dug-but-uncarved voxel as not cave. Task 11 pins in `test/integration/caveSavedWorld.test.ts`: "a GV5 world record (`schemaVersion: 2`, `params.density.defs` the SP5c default tree from `test/fixtures/sp5c-density-trees.json`, a `ColumnDiffV1` placing stone at a voxel the T stage now tags cheese and digging a voxel T leaves solid) opened through `openPersistWorld` (`test/harness/persistWorld.ts:212`): `density.defs` is `DEFAULT_DENSITY_TREE` (canonical); `olderGenerator` true; the stone and the dug air read back; the stone's voxel keeps tag 1 in the final set (`replaceBlocks` kept the section's cave entry); the dug voxel's tag is 0"; Task 17 adds to the same test: "`meshXray` over that section emits walls toward the stone and none toward the dug voxel".
3. **The X-ray band at the world's limits and with the map side by side.** PageDown held at the bottom, PageUp at the top, the first press from "all" with the camera flying at y 400 or at y −64, Home, then the Caves tab's sliders crossed. A person expects the band to stop at −64 and 319 without shrinking, the first press to give a 32-block band inside the world, the strip to name what is shown, and a focused slider to take PageDown without moving the 3D band. Task 21 pins in `xrayStrip.test.ts`: "from all with the camera at y 400, PageDown gives [288, 319]; at y −80 it gives [−64, −33]; ten PageDowns from [−40, −9] end at [−64, −33] (32 blocks); ten PageUps from [216, 247] end at [288, 319] (clamped, 32 blocks); Home gives all and the strip reads `X-ray · y −64 … 319 · by cave type`"; Task 43 pins in `cavesTab.test.ts`: "setting Lowest y to 200 with Highest y 100 sets Highest y to 200 (lowest ≤ highest kept); a slider change sets the page's band and the strip", and in `worldPage.test.ts`: "with the map split and a band slider focused (owner map, `ownerOf`, `mapOverlay.ts:123-124`), PageDown is neither acted on nor prevented (`input.ts:132`), so only the slider moves", and the smoke (Task 49) does it in the browser.
4. **Night vision with the day/night cycle and the fog.** L at midnight with time at ×60, through dusk and noon and back, Brightness moved during the ease, the camera in a cave and on the surface. A person expects the change to ease over 0.3 s, the fog in a cave to brighten with it (far walls fading to the sky's colour), the night to come back exactly as before when L is pressed again, and nothing stored to change. Task 23 pins in `lightmap.test.ts` and `nightVision.test.ts`: "at nv 1 every texel's brightest channel is 255 at t 0.75 (midnight) and t 0.25 (noon) at β 0, 0.3 and 1; nv 0 after nv 1 restores the exact bytes; the eased nv is 0, 0.5, 1 at 0, 0.15, 0.3 s and the lightmap rebuilds on each eased frame and on no frame after; a Brightness change mid-ease rebuilds once more; the fog's colour input `lightmapAt(0, eyeSky = 0)` with nv 1 equals the floor texel normalised (its max channel 255)"; and in `worldPage.test.ts`: "L toggled twice posts no worker message and leaves `litHash` of the loaded columns unchanged".
5. **A carver crossing column and region borders while the player teleports.** A worm whose source lies 9-11 chunks from the column it carves, the column generated, then a teleport 20,000 blocks away (the LRU fills with other paths and the column is freed), then back. A person expects the same tunnel, unbroken at the chunk border, after the return. Task 28 pins in `DT1.isolated` and `carve.test.ts`: "a column carved by a worm from a source 10 chunks away: generated in a region, alone on a fresh store (`isolatedColumn`), and again after `carverCacheOf(ctx).path` over every window source of 2,000 columns 20,000 blocks away (no T generation) has filled the 1,024-path LRU, and after `configure` cleared it: three equal region hashes; with an LRU of 1 equal too; the two columns either side of the worm's chunk border carve the voxels next to the border exactly as one column of the global reference does" (the reference is Task 30's `referenceCarve`, which re-points the check).

## Branch

Task 1 creates `sp6a/cave-shapes` from `main` c64b4a9: `git switch main && git switch -c sp6a/cave-shapes`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP6a; the split; the §10 amendments | §12.1, §13 items 1-7, §14 |
| 2 | `noiseScaled` I: expr, nodes, compile, bounds, reference | §1.5, D18 |
| 3 | `noiseScaled` II: source, cost, inspector, fuzzers; `sp6a.density.ops` | §1.5, §10.8, D18 |
| 4 | The tree's shape: `defs.body`, `precave`, the root's slots (no output change); the SP5c trees fixture; the cost pin (one commit with Task 5) | §1.1, D24, Spec corrections 4, 5 |
| 5 | D36: `SCHEMA_VERSION` 3 and the built-in trees' migration (in Task 4's commit, §12.4's "push A's tree commit") | §12.4, D36, Spec correction 3 |
| 6 | Cave terms I: the `caves` group; entrances, cheese, pillars, roughness, the ramp, the floor, `detailG` (GENERATOR_VERSION 6) | §1.1-§1.2, §1.4, §4, D1, D3, D4, D17 |
| 7 | Cave terms II: spaghetti 3D and 2D with their rarity blends; the noodle's four slots and `nb` | §1.1-§1.3, D2, D18 |
| 8 | Caps: the depth bands' gentle and steep parts; continuity and closure tests | §1.3-§1.4, D2 |
| 9 | The wet roof and the island cap (`wetCover`; `capTop` 180 in floating_islands) | §1.4, D7, D8, D19, D31 |
| 10 | The store's `cave` channel | §3.3, D20 |
| 11 | `tapReader` and the tag rule; T writes the noise kinds | §3.1-§3.2, D17, D20 |
| 12 | Probes I: `caveTagAt`, `solidAt`; DT2 `tagProbe` (on Task 3's `treeMutator` trees) | §3.4, §10.3, D22 |
| 13 | The slice reference's corner memo | §1.6, §7.4 |
| 14 | D25's prototype: P1's gates, the measurements, the rule | §1.6, §10.5, D24, D25 |
| 15 | Levers I (conditional) | §1.6, D25 |
| 16 | Push A: the golden record, Bun, the push, CI measured | §11, §12.3, D28 |
| 17 | The X-ray I: `meshXray` and the `xray` pack layout | §5.1, D23 |
| 18 | The X-ray II: the material and the collapse uniform | §5.2-§5.3, D23 |
| 19 | The X-ray III: pass 3 through the payload, the protocol, both renderers and the staging; `R1.xray` | §5.1, §5.4, §10.4, D23, Spec corrections 1, 7 |
| 20 | Keys: five `view` actions, labels, help and tip | §7.1, §7.5, Spec correction 9 |
| 21 | The X-ray IV: the page, the band, the strip, the HUD, the notices | §5.3, §7.2, D10, D11 |
| 22 | The light floor | §6.1, D14 |
| 23 | Night vision | §6.2, D15 |
| 24 | Carvers I: sources and worm paths (rooms, branches) | §2.1-§2.2, D5, D21, D35 |
| 25 | Carvers II: ravine paths and the underground worm; the window R | §2.1-§2.3 |
| 26 | Carvers III: the path cache and `carveColumn` | §2.4-§2.5 |
| 27 | Carvers IV: the carve step in T, the carver leaves, the carver kinds; `carvedAt`, `solidAt`, `caveTagAt` and the surface probe with carvers; `sp6a.carver.paths` (GENERATOR_VERSION 7) | §2.4, §3.1-§3.2, §3.4, §4, D6 |
| 28 | Probes II: `isolatedColumn`, the cache capacity hook; DT1 `carverCache`, `isolated` | §3.4, §10.3 |
| 29 | Harness I: `debugTags`, 3D components, the pre-cave top | §10.1, master §6.1 |
| 30 | Harness II: the global carver reference; `caves.metric.ts` with C7's construction parts; the `caves` shards | §10.1, §11, D26 |
| 31 | Metrics I: C1-C6 recorded | §10.1, D26, D34 |
| 32 | Metrics II: C7, C8, C9 recorded; `caves.examples.json` | §10.1-§10.2 |
| 33 | Metrics re-asserted: L2, S1, T2, R1, R2, `islandBranchOnGround`, `landTopYmod16` | §10.4, D31, D33 |
| 34 | Bench I: `terrain.caves.warm`, `carver.paths`, `mesh.xray` | §10.5 |
| 35 | Bench II: the kill criterion (`inlined.ts`, `density.cornerInlined`) | §10.5 |
| 36 | D25's second checkpoint | D25, §2.5, §5.1 |
| 37 | Levers II (conditional) | §1.6, D25 |
| 38 | Tuning: the dry run, the rows at their bounds | §10.1, D26 |
| 39 | Push B: the golden record, the bench record, the push, CI and its levers | §10.5, §10.8, §11, §12.3 |
| 40 | The staging reservations from the second checkpoint | §5.1, Spec correction 7 |
| 41 | Parameters II: the lints; the cave-only Apply and the watchdog | §4 |
| 42 | The `caves` slice field, the Cross-section tint, `slice.caves128` | §7.4, D13, Spec correction 8 |
| 43 | The Caves tab | §7.3, D12 |
| 44 | The finder: the search job and the Find buttons; `finder.nearest` | §7.3, D12, D16 |
| 45 | Bench leg L13 (caves) | §10.6, D29 |
| 46 | Bench leg L14 (the X-ray); `measureChrome` → `assets/sp6a` | §10.6, D29, Spec correction 10 |
| 47 | GPU cells (Chrome, agent): every route into `assets/sp6a`; L13 and L14 gated | §10.6, D29 |
| 48 | Levers III (conditional): the Chrome gates and L14's radius | §5.5, §10.6, D25 |
| 49 | Browser smoke: the `caves` step; the screenshots; the review links | §10.9-§10.10, D16 |
| 50 | Master pins and the obligations audit | §13, §17 |
| 51 | The user's Firefox run | §10.8, §16 |
| 52 | Whole-branch review | §8, §16 |
| 53 | Exit: evidence and docs | §16, Exit evidence |
| 54 | Merge, production check, the user's check, SP6a complete | §16, §10.11 |

The order de-risks early: governance; the op and the tree's shape with no output change (Tasks 2-5); the cave families with their caps, the wet roof and the island cap as data (Tasks 6-9); the tag channel and the probes (Tasks 10-12); D25's prototype before anything is built on the terms (Tasks 13-15); push A. Then the X-ray and the light, which change no generated output (Tasks 17-23). Then push B: the carvers (Tasks 24-28), the harness and the metrics (Tasks 29-33), the bench and the kill criterion, the second checkpoint, the levers and the tuning (Tasks 34-39). Then the reservations, the UI, the Chrome legs and cells, the smoke and the docs.

### The two output-changing pushes (spec §12.3, D28)

| push | tasks | base | `GENERATOR_VERSION` | output-changing commits | goldens against the base |
|---|---|---|---|---|---|
| A, before its bump | 1-5 | c64b4a9 | 5 | none (Task 3 adds `sp6a.density.ops`, a new key) | `sp6a.density.ops` added; nothing changed |
| A | 6-16 | c64b4a9 | 6 (Task 6) | 6, 7, 8, 9, 10, 11, Task 14's G_f fix, 15b-15c when they run | `generatorVersion`, `sp1.params`, `sp3a.region.T.default`, `sp3a.region.T.large_biomes`, `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`, `sp3b.density.default`, `sp3c.surface.ops`; `sp6a.density.ops` added (60 keys) |
| pushed at will | 17-23 | push A's head | 6 | none | none |
| B | 24-39 | push A's head | 7 (Task 27) | 27 (with the probes: `sp3c.surface.ops` moves because the surface probe carves), 37's 15b-15c, 38 | `generatorVersion`, the keys of push A's list that move with the carvers and the tuning; `sp6a.carver.paths` (Task 27), `sp6a.region.T.caves` (Task 39) added (62 keys) |
| pushed at will | 40-54 | push B's head | 7 | none (a retune after the user's check: a third push, 8) | none |

Within a push each output-changing commit records from the push's base (`git checkout <base> -- test/goldens.json && npm run test:goldens`), so every commit is green and the push shows one bump (`test/harness/goldens.ts:88-91` locally, `test/harness/governance.ts:46-52` with `.github/workflows/ci.yml:69`'s `before` in CI).

### Where each `caves` leaf lands (Spec correction 4)

| task | leaves (spec §4) | read by |
|---|---|---|
| 6 | `caves.cheese.offset`, `.regional`, `.layerAmp`, `.roofDepth`; `caves.pillars.threshold`; `caves.entrances.offset`, `.threshold`; `caves.limits.surfaceDepth`; `caves.noises.cheese`, `layer`, `cheeseRegional`, `pillar`, `pillarRare`, `pillarThickness`, `roughness`, `roughnessMod`, `entrance`, `entranceA`, `entranceB` | the tree's E, C, P, `keep`, `rough`, `ramp` |
| 7 | `caves.spaghetti3d.thickness`, `.thicknessVar`, `.regional`, `.scales.*`; `caves.spaghetti2d.thickness`, `.layerAmp`, `.scales.*`; `caves.noodles.thickness`, `.ridgeMul`, `.regional`; `caves.noises.spag3dA`, `spag3dB`, `spag3dRarity`, `spag3dThickness`, `spagRegional`, `spag2d`, `spag2dElevation`, `spag2dThickness`, `spag2dRarity`, `noodleToggle`, `noodleThickness`, `noodleRidgeA`, `noodleRidgeB` | S3, S2, the noodle |
| 8 | `minY`, `maxY` of cheese, spaghetti 3D, spaghetti 2D, noodles, entrances; `caves.limits.bandSpan` | the caps, `nb` |
| 9 | `caves.limits.waterDepth`, `caves.limits.capTop` (180 in floating_islands' overlay) | the wet roof, the island cap |
| 27 | `caves.worms.*` (with `caves.worms.shape.*`), `caves.undergroundWorms.*`, `caves.ravines.*` | `carverParamsOf`, the carve step |

The Caves section's sub-group order (D9, this spec's) is fixed by the group's children in `schema.ts` from Task 6 on: Cheese, Spaghetti 3D, Spaghetti 2D, Noodles, Pillars, Entrances, Worms, Underground worms, Ravines, Limits, then `caves.noises` (collapsed); each later task adds its leaves to its sub-group, sizes first. `cave_heavy` (SP6b) needs exactly `cheese.offset` 0.20, `entrances.offset` 0.30, `noodles.maxY` 120 and the three carver chances × 1.5 (§4), which all exist after Task 27.

### The cave kinds (spec §3.2, D10)

| id | kind | tagged by | X-ray colour **(plan)** |
|---|---|---|---|
| 0 | none | — | — |
| 1 | cheese | the tag rule (Task 11) | amber `#ffb000` |
| 2 | spaghetti 3D | Task 11 | cyan `#00e5ff` |
| 3 | spaghetti 2D | Task 11 | blue `#3d7bff` |
| 4 | noodle | Task 11 | magenta `#ff3df0` |
| 5 | entrance | Task 11 | green `#3ddc5a` |
| 6 | worm | the carve step (Task 27) | orange `#ff7a1a` |
| 7 | ravine | Task 27 | red `#ff3030` |
| 8 | underground worm | Task 27 | yellow `#ffe83d` |
| 9 | other density air | Task 11 (trees without the family taps) | grey `#9aa0a6` |
| 10-14 | reserved | — | — |
| 15 | the surface film (the X-ray pack only, never stored) | `meshXray` (Task 17) | light grey `#c8c8c8` |

---

### Task 1: Governance: start SP6a; the split; the §10 amendments

**Files:**
- Modify:
  - `src/core/ids.ts` (the module comment `:1-8` gains "SP6 was split on 2026-11-02 into SP6a (the shape of the caves) and SP6b (cave biomes)."; `SubProjectId` `:9-11` and `SUB_PROJECTS` `:14-17` replace `'SP6'` by `'SP6a', 'SP6b'`; the comment `:19-24` gains "SP6a (the shape of the caves) started on 2026-11-02 and is the current SP (SP6a spec §12)."; `CURRENT_SP` `:25` → `'SP6a'`);
  - `test/harness/sp.ts` (`SP_DEPS` `:20-21`: `SP6a: ['SP3c', 'SP5c']`, `SP6b: ['SP6a']`, `SP7: ['SP6b', 'SP5a']`; `STARTED_SPS` `:37` appends `'SP6a'`);
  - `src/core/params/profiles.ts:38` (`cave_heavy.readyFrom` → `'SP6b'`);
  - `test/thresholds.ts:73-76` (`S1.grassSky0` `activeFrom: 'SP6a'`, its comment "gated by SP6a");
  - comments naming SP6 (`src/gen/density/expr.ts:25` "until SP6a"; `src/gen/pipeline/terrainStage.ts:10` "aquifers, SP7", `:21` "until SP6b"; `src/gen/pipeline/decorateStage.ts:30` "SP8b onwards"; `test/metrics/light.metric.ts:35`, `:38` "SP6a")
- Modify (pins):
  - `test/arch/sp.test.ts` (`:18-22` → "SP6a has started and is the current SP (SP6a spec §12)"; `:34-46` the order with `'SP6a', 'SP6b'` and `SP_DEPS.SP6a`; `:61` the parallel path's `'SP6'` → `'SP6a', 'SP6b'`; `:79-83` "SP6a needs SP3c and SP5c, not SP3d" and a new "SP7 needs SP6b" case);
  - `test/unit/profiles.test.ts:19`, `:29` (`'SP6b'`);
  - `test/unit/presetFile.test.ts:152`, `:258` ("profile cave_heavy arrives in SP6b");
  - `test/unit/metric.test.ts:9-112` and `test/unit/lock.test.ts:43-44`, `:66` (the fixtures' `'SP6'` → `'SP6a'`; `lock.test.ts:44`'s expected `activeFrom SP3a→SP6a`);
  - `test/arch/masterSpec.test.ts` (new `describe('master spec amendments (SP6a §13)')`; the moved pins below; the header comment gains an SP6a paragraph after `:104`; `:39` and `:69` reworded "SP6a")
- Modify: master §10 (the split paragraph after `:1854`; the SP6 entry `:1894-1899` replaced by the SP6a and SP6b entries; SP7's header `:1901`; the "Received from SP6a" lines of SP7, SP8a, SP8b, SP8c, SP9, SP10, SP11, SP12; the Default receivers `:1766`; the Critical path `:1968`; Visible value `:1972`), master §2.5 `:396`, the bare "SP6" of §13 item 7 (`:349`, `:377`, `:681`, `:684`, `:685`, `:694`, `:787`, `:789`, `:844`, `:1019`, `:1333`, `:1388`, `:1495`, `:1511`, `:1808`), `test/thresholds.lock.json` (generated), the SP6a spec (`## Threshold log`), `CLAUDE.md:9`, `README.md` (status line)

**Interfaces:**
- Consumes: `spEntry` and `text` in `masterSpec.test.ts`; `diffGovernance` (`test/harness/lock.ts:72-75`).
- Produces: `STARTED_SPS` ends `'SP5c', 'SP6a'`; `CURRENT_SP === 'SP6a'`; `SP_ORDER` `… 'SP5c', 'SP6a', 'SP6b', 'SP7' …` (25 ids); `isProfileReady('cave_heavy')` false (readyFrom SP6b). The SP6a describe that later tasks extend.

- [ ] **Step 0:** `git switch main && git switch -c sp6a/cave-shapes`.
- [ ] **Step 1: Check `grassSky0` before gating it.** `npx vitest run --project metrics-fast test/metrics/light.metric.ts`, then read `test/metrics/.out/S1.light.json`: `grassSky0` ≤ 0.001 on the fast windows (it becomes gated in this commit, spec §12.1). Above it: **STOP for the user** with the value (the spec gates it from the first commit; no other task changes it before caves).
- [ ] **Step 2: Update the pinned tests first.**
  - `sp.test.ts`: the started list ends `'SP5c', 'SP6a'`; `CURRENT_SP` and `currentSpOf(STARTED_SPS)` `'SP6a'`; "SP_DEPS covers all 25 sub-projects"; `[SP_DEPS.SP6a, SP_DEPS.SP6b, SP_DEPS.SP7]` equal `[['SP3c', 'SP5c'], ['SP6a'], ['SP6b', 'SP5a']]`; `validateStarted([…upTo5c, 'SP6b'])` reports `SP6b started before its dependency SP6a`.
  - The SP6a describe, test "§10's SP6a and SP6b entries, the split and the hand-overs (SP6a spec §13 items 1-7, §14)":
    - the split paragraph contains `SP6 was split on 2026-11-02 into SP6a (the shape of the caves) and SP6b (cave biomes), proposed in brainstorming because it grew past L and accepted by the user ("Sí, partámoslo en SP6a y SP6b"); each is testable on its own (the SP6a spec's "What was agreed", item 1).`;
    - `spEntry('SP6a', 'SP6b')` starts ``**SP6a — The shape of the caves** (XL; SP3c, SP5c; walking for in-game review from SP5a). Spec: `2026-11-02-sp6a-cave-shapes-design.md`.``, contains §13 item 2's contents line, `**Deliverable:** explorable caves with visible surface entrances and ravines, seen through the X-ray.`, the "Received from SP3e (its spec §12): …" line moved verbatim from the SP6 entry (pinned with `ISLAND_RUN_MIN_BOTTOM`, moved from `:639-640`), `**Exit:** as the SP6a spec §16 (C1-C9; re-asserted with caves: L2, S1 \`grassSky0\`, DT1, DT2 probe == bulk and the tag; P1 T ≤ 10 ms p50, ≤ 20 ms p99; the DAG-closure overhead measured; L13 and L14; the user's check)` and a Cut line with §15's three items in order;
    - `spEntry('SP6b', 'SP7')` starts `**SP6b — Cave biomes** (size set by the SP6b spec; SP6a).`, contains §13 item 2's SP6b contents line, `**Deliverable:** cave biomes recognised by their blocks.`, a line starting `- Received from SP6a (its spec §14; amended by SP6a):` and `**Exit** and **Cut line:** set by the SP6b spec`;
    - `spEntry('SP7', 'SP8a')` starts `**SP7 — Water and fluids** (L; SP6b, SP5a)` (moved from `:1215`); SP7, SP8a, SP8b, SP8c, SP9, SP10, SP11 and SP12 each have a line starting `- Received from SP6a (its spec §14; amended by SP6a):` with §14's text for it (SP7's contains `\`wetCover\``; SP8a's `the floor's value is re-judged with textures`; SP8b's `ores in stone, never in tagged air`; SP8c's `may read the tag`; SP9's `shrink carvers through`; SP10's `the carver-tunnel layer`; SP11's `the TSL seam`; SP12's `\`islandBranchOnGround\``), and none holds the abyss hand-overs (§13 item 3: SP6b records them);
    - the critical path contains `SP5c → SP6a → SP6b → SP7` (moved from `:1187`); Visible value contains `caves and the X-ray in SP6a, cave biomes in SP6b`; the Default receivers contain `SP6a underground-only carver and spaghetti-2D rarity bands → SP12; SP6a cave finder → SP10 (worded by the SP6a spec)` **(plan)** (worded at the exit by Task 53);
    - §13 item 7: each listed line names SP6a or SP6b as the item says (`:349` "SP6b decides", `:377` "until SP6b", `:685` contains `SP6a's wet roof reads \`lakeMask\`, \`riverStrength\` and \`offset\`, so no level-field rule is needed (amended by SP6a)`, `:1388` `SP6a adds the cave scenario` (moved from `:883`), `:1495` `gated from SP6a`, `:1019` and `:1511` `re-baselined at SP6a`, `:694` `(aquifers, structures: SP7-SP9; …` (moved from `:973`)); master §10 holds no bare `SP6` outside the split paragraphs (the SP5 split's check, `:1803`'s pattern);
    - the earlier pins naming `spEntry('SP5c', 'SP6')` (`:1416`, `:1756`, `:1803`, `:1836`) become `spEntry('SP5c', 'SP6a')`, and `:1830` checks that neither SP6a nor SP6b holds `Received from SP5c`; `:141-145`, `:147-154` and `:156-168` pass with the new ids unchanged in code.
  - `profiles.test.ts`, `presetFile.test.ts`, `metric.test.ts`, `lock.test.ts` as listed.
- [ ] **Step 3: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/unit/presetFile.test.ts test/unit/metric.test.ts test/unit/lock.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (`CURRENT_SP` `'SP5c'`; no SP6a entry).
- [ ] **Step 4: Implement.**
  - `ids.ts`, `sp.ts`, `profiles.ts`, the comments; the master as §13 items 1-7 word it.
  - `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 1: startedSps gains 'SP6a'; S1.grassSky0 activeFrom 'SP6' → 'SP6a' (spec §12.1; the accept report prints it as LOOSEN only because spIndex('SP6') is −1 once 'SP6' leaves SP_DEPS, test/harness/lock.ts:72-75; it is not one: the part becomes gated, measured <value> on fast).`
  - `CLAUDE.md:9` and `README.md`'s status: "SP5c … is complete (2026-11-02 …). SP6 was split into SP6a and SP6b (2026-11-02): SP6a (the shape of the caves: noise caves and carvers, the X-ray, the light floor and night vision) is in progress".
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `chore(sp6a): start SP6a; split SP6 into SP6a and SP6b; the master's §10 amendments` (`git add src/core/ids.ts test/harness/sp.ts src/core/params/profiles.ts test/thresholds.ts src/gen/density/expr.ts src/gen/pipeline/terrainStage.ts src/gen/pipeline/decorateStage.ts test/metrics/light.metric.ts test/arch/sp.test.ts test/unit/profiles.test.ts test/unit/presetFile.test.ts test/unit/metric.test.ts test/unit/lock.test.ts test/arch/masterSpec.test.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md CLAUDE.md README.md`).

---

### Task 2: `noiseScaled` I: expr, nodes, compile, bounds, reference

**Files:**
- Modify: `src/gen/density/expr.ts` (`ExprOp`, the `Expr` union, `EXPR_OPS` `:57-60`, `EXPR_CHILD_KEYS` `:63-68`, `SCALAR_KEYS` `:71-75`, `ExprErrorCode` `:104-106`, `validateExpr` `:202`, `exprHash` `:525`), `src/gen/density/nodes.ts` (value, interval, class `:310-318`), `src/gen/density/compile.ts` (`scalarKey` `:135-145`, the closure case), `src/gen/density/bounds.ts` (the instruction), `src/gen/density/reference.ts` (the `read` case beside `'noise'`, `:121-123`)
- Test: `test/unit/densityExpr.test.ts`, `test/unit/densityNodes.test.ts`, `test/unit/densityCompile.test.ts`, `test/unit/densityBounds.test.ts`, `test/unit/densityReference.test.ts`

**Interfaces:**
- Consumes: `DensityNoise.z3`, the noise lookup and `NOISE_DIMS` / `UNKNOWN_NOISE` checks of `'noise'`.
- Produces:
  - `{ readonly op: 'noiseScaled'; readonly id: string; readonly s: number }` in `Expr`; `EXPR_OPS` appends `'noiseScaled'` after `'ref'` **(plan)** (an appended op keeps every existing index); child keys `[]`; scalar keys `['id', 's']`;
  - `ExprErrorCode` gains `'SCALE_RANGE'` **(plan)**: `s` not finite or outside [1/16, 16] ("noiseScaled s must lie in [1/16, 16]");
  - value `noise(id).z3(x / s, y / s, z / s)` (one division per axis, in that order, in the compiled closure and in the reference alike); interval `[−clampSigma, clampSigma]` as `noise`; class as `noise` (CELL inside `interpolated`, VOXEL outside, `nodes.ts:310-318`); `exprHash` and the CSE key hash `id` and `numKey(s)`, so `noise` and `noiseScaled s 1` never share a node.

- [ ] **Step 1: Write the tests.**
  - `densityExpr.test.ts:39-41`: "EXPR_OPS lists the 19 ops" (the 18 of today, `ref` included, and `noiseScaled`; the sorted array of 19, the title's "17 ops" corrected); `validateExpr({op: 'noiseScaled', id: 'detail', s: 0}, …)` → `SCALE_RANGE`; `s: 0.0625` and `s: 16` valid, `s: 0.03125` and `s: 17` → `SCALE_RANGE`; an unknown id → `UNKNOWN_NOISE`; a 2D id (`jag`) → `NOISE_DIMS`; `exprHash` differs between `s` 1 and 2 and between `noise detail` and `noiseScaled detail s 1`.
  - `densityNodes.test.ts`: the interval is ±clampSigma; the class is CELL inside `interpolated`, VOXEL outside.
  - `densityCompile.test.ts` and `densityReference.test.ts`: for `add(noiseScaled(detail, 0.75), interpolated(noiseScaled(detail, 1.5)))` the compiled values equal the reference's bit for bit on every voxel of columns (0, 0) and (−37, 12); `noiseScaled(detail, 1)` equals `noise(detail)` bit for bit (x / 1 is x); two nodes differing only in `s` compile to two nodes.
  - `densityBounds.test.ts`: the bounds' interval of a `noiseScaled` leaf contains every compiled value over a column.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/densityExpr.test.ts test/unit/densityNodes.test.ts test/unit/densityCompile.test.ts test/unit/densityBounds.test.ts test/unit/densityReference.test.ts`. Expected: FAIL (unknown op).
- [ ] **Step 3: Implement** the op through every switch over `ExprOp` (the compiler's exhaustiveness checks name the rest).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff (no tree uses the op).
- [ ] **Step 5: Commit** `feat(density): the noiseScaled op (SP6a D18)` (`git add src/gen/density/expr.ts src/gen/density/nodes.ts src/gen/density/compile.ts src/gen/density/bounds.ts src/gen/density/reference.ts test/unit/densityExpr.test.ts test/unit/densityNodes.test.ts test/unit/densityCompile.test.ts test/unit/densityBounds.test.ts test/unit/densityReference.test.ts`).

---

### Task 3: `noiseScaled` II: source, cost, inspector, fuzzers; `sp6a.density.ops`

**Files:**
- Modify: `src/gen/density/source.ts` (the source form of `s`: a literal or a `{param}` ref whose static range lies inside [1/16, 16]; magnitude; resolve and fold), `src/gen/inspect/cost.ts` (`isNoise` `:77` includes `'noiseScaled'`, so it is weighted as `noise` by `noiseWeight` `:171-177`), `src/ui/inspector/form.ts` and `src/ui/inspector/model.ts` (the node's form and summary), `test/harness/densityFuzz.ts`, `test/harness/treeMutator.ts` (generate and mutate the op), `src/metrics/sp2aGoldens.ts:114-125` (`allGoldenKeys` and `computeAnyGolden` route `sp6a.`), `test/arch/rules/banned.ts:19-21` (`DET_FILES` gains `'metrics/sp6aGoldens.ts'`), `test/goldens.json` (one key added), master §2.5's Expr ops (§13 item 10), master §1's `metrics/*.ts` entry (`:163`, gains "SP6a: sp6aGoldens.ts, the sp6a.* goldens") and §0's "Banned APIs" `DET_FILES` parenthesis (`:245`, gains `` `metrics/sp6aGoldens.ts` `` and "SP6a" in its "amended by" list), which the existing checks `test/arch/masterSpec.test.ts:202-218` require, `test/arch/masterSpec.test.ts`
- Create: `src/metrics/sp6aGoldens.ts`
- Test: `test/unit/densitySource.test.ts`, `test/unit/inspectCost.test.ts`, `test/unit/inspectorModel.test.ts`, `test/unit/goldens.sp3b.test.ts:54-57`, `test/unit/goldens.sp6a.test.ts` (new), `test/unit/densityFuzz.test.ts`, and the key-list pins `test/unit/goldens.sp2a.test.ts:10` (59 → 60), `goldens.sp3a.test.ts:34` (`slice(-12, -9)` → `slice(-13, -10)`), `goldens.sp3b.test.ts:44-45` (`slice(-9, -7)` → `slice(-10, -8)`, `slice(-12, -9)` → `slice(-13, -10)`), `goldens.sp3c.test.ts:53-56` (`slice(-7, -5)` → `slice(-8, -6)`, `slice(-9, -7)` → `slice(-10, -8)`, 59 → 60), `goldens.sp3e.test.ts:53-56` (`slice(-5)` → `slice(-6, -1)`, `slice(-7, -5)` → `slice(-8, -6)`, 59 → 60), each test title's "59" and "chained last" following; Tasks 27 and 39 shift them again by one key each (61, 62) and stage the same files

**Interfaces:**
- Consumes: Task 2's op.
- Produces:
  - source mode: `s` is a number or `{param, neg?}`; a ref whose static range leaves [1/16, 16] → `SCALE_RANGE` at `<path>.s`; `resolveDensity` writes the number;
  - inspector summary `noiseScaled <id> /<s>` **(plan)**; its form edits `id` (the noise select) and `s` (a number or a param);
  - `src/metrics/sp6aGoldens.ts`: `export function sp6aGoldenKeys(): string[]` (this task: `['sp6a.density.ops']`; Tasks 27 and 39 append `'sp6a.carver.paths'`, `'sp6a.region.T.caves'`), `export function computeSp6aGolden(key: string): string`; `sp6a.density.ops` is the digest of a fixture tree that uses `noiseScaled` inside and outside `interpolated`, evaluated over column (0, 0) as `sp3b.density.ops` is (`src/metrics/sp3bGoldens.ts`), with literal and `{param}` scales (the `{param}` scale is `density.noises.detail.clampSigma`: before Task 7 only the `*.clampSigma` targets, [1, 8] (`src/core/params/kit.ts:186`), lie inside [1/16, 16]).

- [ ] **Step 1: Write the tests.**
  - `densitySource.test.ts`: `{op: 'noiseScaled', id: 'detail', s: {param: 'density.noises.detail.clampSigma'}}` resolves to the leaf's value; `s: {param: 'density.detailAmpLo'}` (static range [0, 8], `src/core/params/schema.ts:36-37`) → `SCALE_RANGE` at `<path>.s`; the resolved tree's `exprHash` equals the literal tree's.
  - `inspectCost.test.ts`: a `noiseScaled` leaf costs what a `noise` leaf costs, inside and outside `interpolated`.
  - `inspectorModel.test.ts`: the summary `noiseScaled detail /0.75`.
  - `goldens.sp3b.test.ts:54-57`: "the fixture uses every SP3b op" compares with `EXPR_OPS` minus `'noiseScaled'` (SP3b's 18, `ref` included); `goldens.sp6a.test.ts`: the `sp6a.density.ops` fixture uses `noiseScaled`, validates, and its golden matches `test/goldens.json`; the key-list pins listed under Test, shifted by one key (60 goldens).
  - `inspectCost.test.ts`: `isNoise('noiseScaled')` weighs `4·octaves·(double ? 2 : 1)`.
  - `densityFuzz.test.ts`: the fuzzer and `treeMutator` produce `noiseScaled` nodes, and compiled = reference on them.
  - SP6a describe: §2.5's Expr ops list contains `` `noiseScaled{id, s}` `` with `z3(x/s, y/s, z/s)` and `s ∈ [1/16, 16]` (§13 item 10); §1's `metrics/*.ts` entry contains `SP6a: sp6aGoldens.ts, the sp6a.* goldens`; the "Banned APIs" line names `` `metrics/sp6aGoldens.ts` `` (the existing checks `:202-218` hold with it).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/densitySource.test.ts test/unit/inspectCost.test.ts test/unit/inspectorModel.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp6a.test.ts test/unit/densityFuzz.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §2.5 as §13 item 10 words it.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens`; `git diff c64b4a9 -- test/goldens.json` adds `sp6a.density.ops` only (`generatorVersion` 5, 60 keys). Expected: PASS.
- [ ] **Step 5: Commit** `feat(density): noiseScaled in the source, the cost, the inspector and the fuzzers; sp6a.density.ops` (`git add src/gen/density/source.ts src/gen/inspect/cost.ts src/ui/inspector/form.ts src/ui/inspector/model.ts test/harness/densityFuzz.ts test/harness/treeMutator.ts src/metrics/sp2aGoldens.ts src/metrics/sp6aGoldens.ts test/arch/rules/banned.ts test/goldens.json test/unit/densitySource.test.ts test/unit/inspectCost.test.ts test/unit/inspectorModel.test.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp3c.test.ts test/unit/goldens.sp3e.test.ts test/unit/goldens.sp6a.test.ts test/unit/densityFuzz.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 4: The tree's shape: `defs.body`, `precave`, the root's slots (no output change); the SP5c trees fixture; the cost pin

**Files:**
- Create: `test/fixtures/sp5c-density-trees.json` (written in Step 1 from the code at c64b4a9, before any tree change), `test/unit/sp5cTrees.test.ts`
- Modify:
  - `src/core/params/defaultTrees.ts:32-112` (the shape below);
  - `src/core/params/presetTrees.ts:129-139` (amplified's six paths `root.a.a.x.x.<rest>` → `defs.body.<rest>`; floating_islands' `root.b.x` unchanged);
  - `src/metrics/liveness.ts:231` (the `density.defs` variant `at: ['root', 'a', 'a', 'a', 'x', 'a']`, the `terrain` tap; Spec correction 4);
  - `src/core/constants.ts:96-100` (`DENSITY_COLUMN_COST_MAX`'s comment: "64 × the SP3d default tree's 14,907,917, kept as SP6a's cap (SP6a spec D24): about 35 × SP6a's default");
  - `src/gen/density/source.ts:24` (the doc's "so the resolved default is the very tree SP3b's builder made" reworded: the resolved default's `defs.body` is the tree SP3b's builder made under `root.a.x.x`, and its values are bit-equal to it);
  - SP3d's legacy-identity tests, which the new shape breaks: `test/unit/densityResolve.test.ts:193-210` (`checkIdentity`'s structural `exprHash`/`sameTree` identity and `checkCompiled`'s 51-node shape), `test/unit/defaultTrees.test.ts:155-181` ("with no defs", the `treeDiff` against `legacyDefaultDensityExpr`, the 60-node count), `test/unit/inspectCost.test.ts:62-71` ("333 as source and 322 as the legacy-built tree"): replaced by value identity (below), the retired shapes and counts re-pinned as recomputed literals;
  - the cost and count pins (Global Constraints): `test/unit/inspectCost.test.ts:136-141` and `:172`, `test/unit/sliceCost.test.ts:29-80` (its literals and its `root.a.a…` paths), `test/unit/presetTrees.test.ts:185-193` and `:462-471`, `test/unit/defaultTrees.test.ts:176-180`; Task 4 adds about 5 voxel-level nodes, each counted 98,304 times;
  - `test/fixtures/expected-v1.json` (U4: regenerated from `importPreset(preset-v1).params`, canonical; it holds the profile's whole tree);
  - the tests that address the default tree by path (`test/unit/inspectCost.test.ts:155-176`, `test/unit/inspectorModel.test.ts`, `test/unit/inspectorHover.test.ts:36`, `:76`, `test/unit/densityTab.test.ts:101`, `test/unit/fieldSlicePool.test.ts:75`, `:77`, `:212`, `:226`, `test/integration/fieldSlice.test.ts:88`, `test/unit/spawn.test.ts:124`, `:143`, `test/unit/liveness.test.ts`, `test/unit/presetTrees.test.ts`, `test/arch/masterSpec.test.ts:576-618`; any other the grep `root\.a\.a|'root', 'a'` finds over `DEFAULT_DENSITY_TREE` or its presets)
- Test: `test/unit/defaultTrees.test.ts`, the files above

**Interfaces:**
- Consumes: `registeredTree`, `deriveTree` (`presetTrees.ts:80-104`), `canonicalJSON` (`src/core/params/canonical.ts:94`), `fnv1a64` (`src/core/hash.ts:194`).
- Produces:
  - `DEFAULT_DENSITY_TREE` = `{ root, defs: { body } }` with `body` the old `root.a.a.x.x` subtree, unchanged, and **(plan)** the root
    `max(a: min(a: min(a: tap precave(add(a: tap terrain(interpolated(ref body)), b: <detail term, unchanged>)), b: const 1e6 /* caves slot */), b: const 1e6 /* noodle slot */), b: tap islands(const −1e6))`;
    so `root.a.a.a` is the `precave` tap (Spec correction 5), `root.a.a.a.x.a` the `terrain` tap, `root.a.a.a.x.b` the detail term, `root.a.a.b` the caves slot, `root.a.b` the noodle slot, `root.b` the islands tap (unchanged, so `root.b.x` and every test of it keep their paths). `min(v, 1e6)` is `v` for every value a valid tree reaches, so every density value, every bounds decision and every golden are unchanged;
  - `test/fixtures/sp5c-density-trees.json`: `{ "default": …, "amplified": …, "floating_islands": … }`, the three SP5c trees as canonical JSON objects; `sp5cTrees.test.ts` pins `hex64(fnv1a64(canonicalJSON(tree)))` of each as three literals, which Task 5's migration repeats.

- [ ] **Step 1: The fixture, before any edit.** A one-off `WRITE_SP5C_TREES=1 npx vitest run --project unit test/unit/sp5cTrees.test.ts` writes the three trees from `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE` and `FLOATING_DENSITY_TREE` at c64b4a9 and prints their hashes; without the variable the test reads the fixture, checks each hash against its literal, and checks that each fixture tree passes tier 2 (`validateDensitySource`).
- [ ] **Step 2: Write the tests.**
  - `defaultTrees.test.ts`: `defs.body` deep-equals the fixture's `root.a.a.x.x`; the nodes at the paths above are as listed; the resolved default compiles to values bit-equal to the fixture's default on every voxel of columns (0, 0), (−1667, −2000) and (40, 900); every bounds decision per cell is equal; `:155-181` rewritten: DEFAULT_DENSITY_TREE has the one def `body`, and its node count is the recomputed literal.
  - `densityResolve.test.ts:193-210`: value identity instead of structural identity: `legacyDefaultDensityExpr(p.density).root.a.x.x` deep-equals the resolved tree's `defs.body` (−0-aware, at DEFAULTS, the four `clampSigma` values and the four `detailAmp` pairs as today), and the corner and voxel values of the resolved default and the legacy tree are bit-equal (`Object.is`) on the three columns; the 51-node shape is retired for the recomputed literal.
  - `inspectCost.test.ts:62-71`: the "333 vs 322" pin replaced by the default's recomputed structural cost; the work cost 569 is recomputed with the new nodes.
  - `presetTrees.test.ts`: amplified and floating_islands are bit-equal to their fixture trees on the same columns.
  - `inspectCost.test.ts:155-157`: `DENSITY_COLUMN_COST_MAX` is `64 * 14_907_917` (D24) and `densityColumnCost(DEFAULT_DENSITY_TREE) ≤ DENSITY_COLUMN_COST_MAX`; `:162-176` re-pointed (`root.a.a.a.x.a` is the `terrain` tap) with the cost deltas recomputed.
  - `liveness.test.ts`: the `density.defs` variant mutes the `terrain` tap at its new path.
  - the path-addressed tests re-pointed, each still asserting what it asserted.
- [ ] **Step 3: Run** `npx vitest run --project unit test/unit/defaultTrees.test.ts test/unit/densityResolve.test.ts test/unit/presetTrees.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/liveness.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement**; `test/fixtures/expected-v1.json` regenerated (U4).
- [ ] **Step 5: Task 5's Steps 1-3 in the same working tree.** Task 4 is not committed alone: once the default tree's JSON changes, the committed SP5b world fixture (`test/fixtures/sp5bWorldParams.json`, schema 2, SP5c's tree in `density.defs`) no longer equals `resolveProfile('default')` (`test/unit/saves.test.ts:71-76`) until `MIGRATIONS[1]` lands, and spec §12.4 puts `SCHEMA_VERSION` 3 "in push A's tree commit".
- [ ] **Step 6: Run** `npm run typecheck && npm test` (U4 `migrationFailures` 0 with the regenerated `expected-v1.json` and Task 5's v2 fixtures); `npm run test:goldens && git diff --exit-code c64b4a9 -- test/goldens.json` apart from Task 3's added key. Expected: PASS; no changed key (the tree's values are unchanged; `spawnY` compares canonically with today's `DEFAULT_DENSITY_TREE`, `src/gen/column/spawn.ts:52`, so `sp2a.spawn` keeps the 2D path).
- [ ] **Step 7: Commit** Tasks 4 and 5 together: `refactor(density): the default tree's body as a def, the precave tap and the root's cave slots; schema version 3 migrates SP5c's built-in trees (SP6a D36)` (`git add test/fixtures/sp5c-density-trees.json test/unit/sp5cTrees.test.ts src/core/params/defaultTrees.ts src/core/params/presetTrees.ts src/metrics/liveness.ts src/core/constants.ts src/gen/density/source.ts test/fixtures/expected-v1.json test/unit/defaultTrees.test.ts test/unit/densityResolve.test.ts test/unit/presetTrees.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/inspectorModel.test.ts test/unit/inspectorHover.test.ts test/unit/densityTab.test.ts test/unit/fieldSlicePool.test.ts test/integration/fieldSlice.test.ts test/unit/spawn.test.ts test/unit/liveness.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, Task 5's paths (its Step 5), plus any other re-pointed test by explicit path).

---

### Task 5: D36: `SCHEMA_VERSION` 3 and the built-in trees' migration

Task 5 lands in Task 4's commit (Task 4 Step 5; spec §12.4 "in push A's tree commit"): its Steps 1-3 run in Task 4's working tree, its Step 4 is Task 4's Step 6 and its Step 5 is Task 4's Step 7.

**Files:**
- Modify: `src/core/params/migrate.ts` (`SCHEMA_VERSION` `:10` → 3; `MIGRATIONS` `:16` gains `[1]`; its doc comment), `test/unit/presetFile.test.ts:151` ("schemaVersion 4 is newer than this build (3)"), `test/unit/saves.test.ts:103-107` (the too-new version becomes 4), `test/unit/profiles.test.ts:68-69` and `:130`, `test/schema-shape.lock.json` (accepted at version 3), the SP6a spec (Spec correction 3)
- Create: `test/fixtures/preset-v2.json`, `test/fixtures/expected-v2.json` (Spec correction 3)
- Test: `test/unit/profiles.test.ts` (its migration cases), `test/unit/saves.test.ts` (beside `:434-444`), `test/unit/presetFile.test.ts`

**Interfaces:**
- Consumes: Task 4's fixture and hashes; `DEFAULT_DENSITY_TREE`, `AMPLIFIED_DENSITY_TREE`, `FLOATING_DENSITY_TREE`; `loadParams` (`src/persist/saves.ts:237-245`), `importPreset` (`src/core/params/presets.ts:43`), `olderGenerator` (`saves.ts:248-250`).
- Produces: `SCHEMA_VERSION = 3`; `MIGRATIONS[1]`: when `doc.density.defs` exists and `hex64(fnv1a64(canonicalJSON(defs)))` is one of the three SP5c hashes (`SP5C_TREE_HASHES`, a non-exported `Map` of hash → today's tree **(plan)**), the returned document's `density.defs` is today's tree of that kind (by identity: the registered frozen tree), every other leaf and any other tree kept, the input never mutated; a document without `density.defs` is returned as is.

- [ ] **Step 1: Write the tests.**
  - the migration: each fixture tree in a schema-2 document migrates to today's tree of its kind (`toBe` the built-in); a tree with one literal changed is kept; a document without `density.defs` is the same object; the input is not mutated; `MIGRATIONS.length === SCHEMA_VERSION - 1`.
  - the existing version pins that treat 3 as too new or count the versions: `saves.test.ts:103-107` "`schemaVersion` 4 → a `MIGRATION_FAILED` issue"; `profiles.test.ts:130` `d.schemaVersion = 4` → `NEWER_SCHEMA_VERSION`; `profiles.test.ts:68-69` `[SCHEMA_VERSION, MIGRATIONS.length]` equals `[3, 2]`, titled "SCHEMA_VERSION 3 (SP6a D36): two migrations, 1 → 2 the identity, 2 → 3 the built-in trees".
  - `saves.test.ts`: a GV5 world record of each of default, amplified and floating_islands (`schemaVersion: 2`, `params.density.defs` its fixture tree) opens through `loadParams` with today's tree; an edited tree is kept; for each, the badge and the page compute the same genKey (the `:434-444` pattern) and `olderGenerator` is true.
  - `presetFile.test.ts`: a schema-2 preset file holding the SP5c default tree imports with today's tree; `:151` "schemaVersion 4 is newer than this build (3)".
  - U4 (`params.metric.ts:24-30`) finds `preset-v2.json` and `expected-v2.json` and passes.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/profiles.test.ts test/unit/saves.test.ts test/unit/presetFile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the fixtures; `npm run test:accept-schema` (version 3, no leaf change).
- [ ] **Step 4: Run** as Task 4's Step 6 (`saves.test.ts:71-76` passes again: the SP5b fixture's SP5c tree migrates to today's).
- [ ] **Step 5: Commit** in Task 4's commit (its Step 7), adding `src/core/params/migrate.ts test/fixtures/preset-v2.json test/fixtures/expected-v2.json test/schema-shape.lock.json test/unit/profiles.test.ts test/unit/saves.test.ts test/unit/presetFile.test.ts` to its `git add`.

---

### Task 6: Cave terms I: the `caves` group; entrances, cheese, pillars, roughness, the ramp, the floor, `detailG` (GENERATOR_VERSION 6)

**Files:**
- Modify:
  - `src/core/params/schema.ts` (the group `caves` appended after `islands` `:137-143`, with **(plan)** a `caveNoise(label, doc, def, clampSigma, range)` helper beside `densityNoise` `:34-35`);
  - `src/gen/density/source.ts:135-151` (`ALLOWED_REF_TARGETS` takes number and int leaves under `caves.` and `clampSigma` under `caves.noises.`) and `:158-168` (`SOURCE_NOISES` reads `caves.noises.*` too);
  - `src/gen/density/context.ts:32`, `:51-59` (the noise lookup tries `density.noises.<id>`, then `caves.noises.<id>`);
  - `src/gen/inspect/cost.ts:171-177` (`noiseWeight` tries `params.density.noises`, then `params.caves.noises`; an unknown id still weighs `NOISE_MAX_WEIGHT`), so a cave noise weighs `4·octaves·(double ? 2 : 1)` in the work costs (`TARGET_RANGES` `:61-70` serves only the rules and stays);
  - `src/ui/inspector/form.ts:133-135` (`DENSITY_NOISE_OPTIONS` includes the `caves.noises.*` ids by dims, so the Density tab's noise select offers them);
  - the tests that pin `islands` as the last group: `test/unit/islandMask.test.ts:28-35` (the islands leaves come right before the first `caves.*` leaf; `Object.keys(DEFAULTS).at(-1)` is `'caves'`), `test/unit/paramPanelModel.test.ts:38` (`[…, 'surface', 'islands', 'caves']`);
  - the tests that pin the generator version 5 on a newly written world record (the code writes `GENERATOR_VERSION`): `test/unit/worldsMenu.test.ts:284` and `test/unit/bench.test.ts:1643` use `generatorVersion: GENERATOR_VERSION` (imported), so Task 27 needs no further edit;
  - the default tree's cost and count pins (Global Constraints) and U4's `test/fixtures/expected-v1.json`, `expected-v2.json` (regenerated);
  - master §6.4's U2 row (Spec correction 12) and `test/unit/liveness.test.ts:465-467` (the new count; the islands leaves checked by name, not by `slice(-4)`);
  - `test/unit/densitySource.test.ts:34-40` (the exact `ALLOWED_REF_TARGETS` list gains this task's targets; Tasks 7, 8, 9 and 27 grow it again);
  - `src/core/stage/registry.ts:20` (terrain: version 4, params `['density', 'surface', 'caves']`);
  - `src/core/constants.ts:2` (`GENERATOR_VERSION` 6);
  - `src/core/params/defaultTrees.ts` (the families below in the caves slot; `detailG` in place of the detail term);
  - `src/metrics/liveness.ts` (a `cave` class column for `caves.*` leaves: a land column of seed 42 where every family of this task carves, found by a scan of `samplePoints('sp6a.liveness.caves', …)` **(plan)**);
  - `README.md` (the params block: `npm run docs:params`);
  - `test/schema-shape.lock.json`;
  - `test/goldens.json`;
  - `test/unit/decorateStage.test.ts:218` (`AUX_FIXTURE` re-pinned only if a cave breaches column (−1667, −2000)'s surface);
  - master §5.1's Terrain scope (§13 item 16);
  - `test/arch/masterSpec.test.ts`;
  - the SP6a spec (Spec corrections 4, 6, 12)
- Test: `test/unit/caveTerms.test.ts` (new), `test/unit/densitySource.test.ts`, `test/unit/stage.test.ts` (the registry), `test/unit/liveness.test.ts`, `test/unit/inspectCost.test.ts`, `test/unit/inspectorForm.test.ts`, and the pins listed above

**Interfaces:**
- Consumes: Task 4's slots; `noiseScaled` (Task 7 uses it); `recip(param …)` (`defaultTrees.ts:53`'s form).
- Produces:
  - **Leaves (this task)**, defaults and ranges from spec §4: `caves.cheese.offset` 0.27 (−0.5 … 1), `caves.cheese.regional` 0.1 (0 … 0.4), `caves.cheese.layerAmp` 4 (0 … 8), `caves.cheese.roofDepth` 12 (0 … 48); `caves.pillars.threshold` 0.03 (0 … 0.5); `caves.entrances.offset` 0.37 (−0.5 … 1), `caves.entrances.threshold` 0.08 (0 … 0.5); `caves.limits.surfaceDepth` 8 (0 … 32); in each sub-group the sizes first (D9); every leaf scope Terrain, stage terrain.
  - **Noises** `caves.noises.*` (single stack, `double: false`, except `cheese`; every one with `clampSigma` 3, the `caveNoise` helper's argument, pinned by a unit test, so the closure bounds of Task 7 hold; λxz / λy, octaves): `cheese` 96 / 144, 4, double; `layer` 96 / 16, 1; `cheeseRegional` 2D 1536, 2; `pillar` 30 / 400, 1; `pillarRare` 60 / 400, 1; `pillarThickness` 60 / 400, 1; `roughness` 32, 1; `roughnessMod` 128, 1; `entrance` 128, 3, amplitudes [0.4, 0.5, 1.0]; `entranceA` 64, 1; `entranceB` 64, 1. Every λy ≥ 16 (`schema.ts:113`'s rule). A unit test: the names under `density.noises` and `caves.noises` are disjoint.
  - **Terms** (§1.1-§1.2, values in blocks; `rangeChoice(x, lo, hi, a, b)` is `a` where lo ≤ x < hi):
    - the shared parts: `fl(v) = max(v, −48)` (the family floor F = 48, a tree literal); `sky(v) = rangeChoice(ref body, −1e9, −8, 32, v)` (the deep families skipped 8 or more above the surface); `ramp = clamp((surfaceDepth − ref body)·2, 0, 32)` at the corner (0 at T ≥ 8, 16 at T = 0, 32 from 8 above); `rough = (−0.05 − 0.05·Nrm)·(−0.4 + |Nr|)`;
    - `E = tap entrances(interpolated(fl(16·min(Ne + 0.37′ + yGrad(−10 → 0.3, 30 → 0), rough + clamp(max(|E1|, |E2|) − threshold, −1, 1)))))` with 0.37′ = `caves.entrances.offset` and `yGrad` a `slide(const 1, [[−10, 0.3], [30, 0]])` (entrances get no `sky` and no `ramp`: the master's "entrances NOT depth-ramped");
    - `C = tap cheese(interpolated(sky(fl(16·(layerAmp·L² + clamp(Nch + offset − regional·Nra, −1, 1) + clamp((roofDepth − ref body)·(1/24), 0, 0.5))) + ramp)))` (with `layerAmp` 4 and `roofDepth` 12, the master's cheese with its roof term; `regional` lowers the threshold where Nra is high, D3);
    - `P = tap pillars(interpolated(16·(2·Np − 1 − rare)·(0.55 + 0.55·thk_p)³))` (cube as `mul(square(x), x)`), `P` is written once in `defs.pillars` (a tap counts where it is written, `src/gen/density/expr.ts:349-355`, so two `ref pillars` read one tap) and `keep = rangeChoice(mul(ref pillars, const 0.0625), −1e9, {param: 'caves.pillars.threshold'}, const −1e6, ref pillars)` **(plan)** (spec §1.1's `rangeChoice(P, −1e9, 0.48, −1e6, P)`, its bound 0.48 = 16 × 0.03 taken from the leaf: a bound is a literal or one ref, so P is scaled back by the exact 1/16);
    - the caves slot `max(min(E, C), keep)` (Task 7 adds S3 and S2 to the `min`); the noodle slot stays `const 1e6` (Task 7);
    - `detailG = rangeChoice(interpolated(ref body), −1e9, 16, <detail term>, const 0)` (Spec correction 6).
  - The SP6a tree keeps Task 4's paths for `precave`, `terrain`, the slots and `root.b`; the amplified and floating_islands trees re-derive (`was` checks at module load).

- [ ] **Step 1: Write the tests.**
  - `caveTerms.test.ts`: the default tree validates (tier 2) and compiles; each family tap exists once; compiled = reference on columns (0, 0), (−1667, −2000), (40, 900) and one cave class column; at a voxel 30 blocks under the surface of a land column some voxel of E, C and P is ≤ 0 in a 32 × 32 scan; `detailG` is 0 bit for bit where `interpolated(ref body)` ≥ 16 and equals the detail term below 16; `sky` gives 32 at every corner 8 or more above the surface; with `caves.limits.surfaceDepth` 8 the ramp is 0 at T ≥ 8, 16 at T = 0, 32 at T ≤ −8; the family floor: each family's slot interval over the leaves' static ranges (clampSigma 8, `entrances.offset` −0.5) is ≥ −48 (`bounds.ts`' intervals, not values at the defaults).
  - `densitySource.test.ts`: `{param: 'caves.cheese.offset'}` and `{param: 'caves.noises.cheese.clampSigma'}` are allowed refs; a `noise` id `cheese` resolves to `caves.noises.cheese`; `:34-40`'s exact list with this task's targets.
  - `inspectCost.test.ts`: a `caves.noises` noise weighs `4·octaves·(double ? 2 : 1)`; `inspectorForm.test.ts:351`: the 3D and 2D noise options include the `caves.noises` ids of those dims.
  - the registry: terrain is version 4 and hashes `caves`; every `caves.*` leaf's badge is Terrain.
  - `liveness.test.ts`: the `cave` class column is found and every leaf of this task is live on it (U2 runs in `npm test`); `:465-467`'s count.
  - `islandMask.test.ts`, `paramPanelModel.test.ts`, `worldsMenu.test.ts`, `bench.test.ts` as listed; the cost and count pins recomputed; U4 green with the regenerated fixtures.
  - SP6a describe: §5.1's Terrain scope examples contain `caves (\`caves.*\`)`; the U2 check (moved from `:425-431`): n (leaves with stage climate, shape, biome2d or terrain) is this task's literal and the U2 row contains `U2 covers ${n} leaves (amended by SP6a)`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveTerms.test.ts test/unit/densitySource.test.ts test/unit/liveness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **(plan)** The cave subtrees are built by non-exported helpers in `defaultTrees.ts` (`fl`, `sky`, `ramp`, `capOf` …) before `registeredTree`, so the data stays one literal tree; every sum stays left-nested in the written order (IEEE). `npm run test:accept-schema`; `npm run docs:params`.
- [ ] **Step 4: Goldens (push A's first output-changing commit).** `git checkout c64b4a9 -- test/goldens.json && npm run test:goldens`; `git diff c64b4a9 -- test/goldens.json` lists `generatorVersion` 5 → 6, `sp1.params`, `sp3a.region.T.default`, `sp3a.region.T.large_biomes`, `sp3e.region.T.amplified`, `.archipelago`, `.floating_islands`, `sp3b.density.default`, `sp3c.surface.ops`, and `sp6a.density.ops` added; nothing else.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): the caves group; entrances, cheese and pillars in the default tree (GENERATOR_VERSION 6)` (`git add src/core/params/schema.ts src/gen/density/source.ts src/gen/density/context.ts src/gen/inspect/cost.ts src/ui/inspector/form.ts src/core/stage/registry.ts src/core/constants.ts src/core/params/defaultTrees.ts src/metrics/liveness.ts README.md test/schema-shape.lock.json test/goldens.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/unit/caveTerms.test.ts test/unit/densitySource.test.ts test/unit/liveness.test.ts test/unit/inspectCost.test.ts test/unit/inspectorForm.test.ts test/unit/sliceCost.test.ts test/unit/presetTrees.test.ts test/unit/defaultTrees.test.ts test/unit/islandMask.test.ts test/unit/paramPanelModel.test.ts test/unit/worldsMenu.test.ts test/unit/bench.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, `test/unit/stage.test.ts`, and `test/unit/decorateStage.test.ts` if re-pinned).

---

### Task 7: Cave terms II: spaghetti 3D and 2D with their rarity blends; the noodle's four slots and `nb`

**Files:**
- Modify: `src/core/params/schema.ts` (leaves and noises below), `src/core/params/defaultTrees.ts` (S3, S2 in the caves slot's `min`; the noodle slot), `src/metrics/liveness.ts` (the `cave` column holds these families too, or a second scan slot), `README.md`, `test/schema-shape.lock.json`, `test/goldens.json`, `test/fixtures/expected-v1.json` and `expected-v2.json` (U4, regenerated), the default tree's cost and count pins (Global Constraints), master §6.4's U2 row (Spec correction 12), `test/arch/masterSpec.test.ts`
- Test: `test/unit/caveTerms.test.ts`, `test/unit/liveness.test.ts` (`:465-467`'s count), `test/unit/densitySource.test.ts` (`:34-40`'s list gains this task's targets)

**Interfaces:**
- Consumes: Task 6's terms; `noiseScaled` (Task 2).
- Produces:
  - **Leaves:** `caves.spaghetti3d.thickness` 0.0765 (0 … 0.3), `.thicknessVar` 0.0115 (0 … 0.1), `.regional` 0.05 (0 … 0.2), `.scales` `{s0: 0.75, s1: 1, s2: 1.5, s3: 2}` **(plan)** (each 1/16 … 16); `caves.spaghetti2d.thickness` 0.95 (0.5 … 1.5), `.layerAmp` 8 (0 … 32), `.scales` `{s0: 0.5, s1: 0.75, s2: 1, s3: 2, s4: 3}` (each 1/16 … 16; cut line); `caves.noodles.thickness` 0.075 (0 … 0.3), `.ridgeMul` 1.5 (0.5 … 4), `.regional` 0.1 (0 … 0.4).
  - **Noises** (each `clampSigma` 3, as Task 6's): `spag3dA`, `spag3dB` 64, 1; `spag3dRarity` 128, 1; `spag3dThickness` 64, 1; `spagRegional` 2D 1024, 2; `spag2d` 128, 1; `spag2dElevation` 2D 256, 2; `spag2dThickness` 64, 1; `spag2dRarity` 128, 1; `noodleToggle` 64, 1; `noodleThickness` 64, 1; `noodleRidgeA`, `noodleRidgeB` 18, 1.
  - **Rarity blend** (§1.3): with the band edges e_k of a rarity noise r and the scales m_k, `rmS(N) = Σ_k w_k(r)·m_k·|noiseScaled(N, m_k)|`, where each w_k is built from `clamp` of affine functions of r so that w_k = 1 inside band k, both neighbours blend linearly within ±0.05 of an edge, and **(plan)** each `noiseScaled` term sits under a `rangeChoice` on r that evaluates it only where its weight can be non-zero (band k widened by 0.05 on each side; "both evaluated only there"). 3D: edges −0.5, 0, 0.5 over `.scales` s0-s3; 2D: edges −0.75, −0.5, 0.5, 0.75 over s0-s4.
  - `S3 = tap spag3d(interpolated(sky(fl(16·(rough + clamp(max(rmS(S1), rmS(S2)) − thickness − thicknessVar·thk_s − regional·Nrb, −1, 1))) + ramp)))`;
  - `S2 = tap spag2d(interpolated(sky(fl(16·clamp(max(rmS2(S2d) + 0.083·tm, cube(|layerAmp·Nel + slide(const 1, [[−64, 8], [320, −40]])| + tm)), −1, 1)) + ramp)))` with `tm = −thickness − 0.35·Nthk` (spec §1.2's `−0.95 − 0.35·Nthk`, 0.95 the leaf);
  - the noodle slot `tap noodle(fl(16·(−thickness − 0.025·Kn + ridgeMul·max(|An|, |Bn|) + 4·max(0, −Nn))))` with `Nn = interpolated(nb(Nt − regional·Nrb, −1))`, `Kn = interpolated(nb(thk_n, 0))`, `An = interpolated(nb(Ra, 1))`, `Bn = interpolated(nb(Rb, 1))`, `nb(N, c) = rangeChoice(y − maxY_n, −1e9, 40, rangeChoice(minY_n − y, −1e9, 40, N, c), c)`; until Task 8 adds `caves.noodles.minY` / `maxY`, `nb` reads the literals −60 and 64 **(plan)**; the combine is VOXEL (outside `interpolated`).
  - The caves slot `max(min(E, C, S3, S2), keep)`.

- [ ] **Step 1: Write the tests** (`caveTerms.test.ts`): the four new taps exist once and validate; compiled = reference on the four columns; the rarity blend on a 1-block line across each 3D and 2D band edge: the blended value is continuous (no jump larger than the family's local Lipschitz bound) and equals the plain scale's value outside ±0.05; a `noiseScaled` term is not evaluated at a corner outside its widened band (a counting noise stub); with Nrb = 0 and Nn ≤ −0.04 the noodle is ≥ 0 (closed) for every Kn, An, Bn in ±clampSigma (closure needs 4·|Nn| ≥ thickness + 0.025·clampSigma = 0.15 at the defaults, so Nn ≤ −0.0375); at Kn = 0 and An = Bn = 0 it closes by Nn = −0.019 (−thickness/4; the spec's ≈ −0.025); the noodle noises are not evaluated at corners more than 40 blocks outside y −60 … 64 (a counting stub); every new leaf live on the `cave` column; `densitySource.test.ts:34-40`'s list, `liveness.test.ts:465-467`'s count, the SP6a describe's U2 count and row (Spec correction 12), the cost and count pins and U4 follow.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveTerms.test.ts test/unit/liveness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-schema`; `npm run docs:params`.
- [ ] **Step 4: Goldens:** `git checkout c64b4a9 -- test/goldens.json && npm run test:goldens`; the diff against c64b4a9 lists Task 6's set only.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): spaghetti 3D and 2D with continuous rarity bands; the noodle's four slots` (`git add src/core/params/schema.ts src/core/params/defaultTrees.ts src/metrics/liveness.ts README.md test/schema-shape.lock.json test/goldens.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/unit/caveTerms.test.ts test/unit/liveness.test.ts test/unit/densitySource.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/presetTrees.test.ts test/unit/defaultTrees.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 8: Caps: the depth bands' gentle and steep parts; continuity and closure tests

**Files:**
- Modify: `src/core/params/schema.ts` (`minY`/`maxY` per family and `caves.limits.bandSpan`), `src/core/params/defaultTrees.ts` (each family's `cap_f`), `src/metrics/liveness.ts` (each family's `maxY` decided on a mountain witness: a bounded scan of `samplePoints('sp6a.liveness.mountain', …)` **(plan)** for a column whose pre-cave top is ≥ 300 and that holds that family's air above y 272, since U2's only effective step of 320 is 272, `numberSteps`, `liveness.ts:183-193`; the `minY` leaves on the `cave` class column), `README.md`, `test/schema-shape.lock.json`, `test/goldens.json`, `test/fixtures/expected-v1.json` and `expected-v2.json` (U4, regenerated), the default tree's cost and count pins (Global Constraints), master §6.4's U2 row (Spec correction 12), `test/arch/masterSpec.test.ts`, `.github/scripts/unitShards.mjs:20-24` (`caveContinuity` into `heavy`), `test/unit/shards.test.ts`, the SP6a spec (Spec correction 13, as the user decides)
- Create: `test/unit/caveContinuity.test.ts`
- Test: `test/unit/caveTerms.test.ts`, `test/unit/liveness.test.ts` (the maxY witnesses; `:465-467`'s count), `test/unit/densitySource.test.ts` (`:34-40`'s list)

**STOP for the user before Step 3** (Spec correction 13): `caves.spaghetti2d.maxY` 320 is dead under U2 by construction (spaghetti 2D never opens above y ≈ 208; U2's steps of 320 are 272 and 320). Before asking, the controller runs Step 1's witness scan for the candidate defaults: U2's lower step of a default v is v − ⌊0.15·v⌉ (`liveness.ts:116`, `:183-193`), and spaghetti 2D air at y 170 needs |8·Nel − 21.25| < 0.95 + 0.35·Nthk, so Nel ≈ 2.7 of its clampSigma 3 (rare), under ground at least that high. The controller gives the user the two options with the scan's result, (a) the default lowered to the highest value whose lower step has a witness (200 **(plan's proposal)** if its step 170 has one; any default from 208 to 244 changes no generated output, a lower one caps the layer below y 208), the range kept −64 … 320, spec §4 amended, or (b) a U2 exemption for the leaf with its reason recorded in the spec and in `liveness.ts` (an exempt list U2 reports), and waits; the spec is reworded in this commit as the user decides. Any other `maxY` leaf whose mountain witness the scan does not find goes to the user in the same STOP, with the same two options.

**Interfaces:**
- Consumes: Tasks 6-7's families.
- Produces:
  - **Leaves:** `caves.cheese.minY` −56, `.maxY` 320; `caves.spaghetti3d.minY` −56, `.maxY` 320; `caves.spaghetti2d.minY` −64, `.maxY` 320 (or 200, as the user decides at the STOP); `caves.noodles.minY` −60, `.maxY` 64; `caves.entrances.minY` −64, `.maxY` 320 (each `int`, −64 … 320); `caves.limits.bandSpan` 16 (1 … 32). `nb`'s `x` reads the noodle leaves (`add(y, neg(param caves.noodles.maxY))`, `add(param caves.noodles.minY, neg(y))`) and its bound 40 stays a literal (`bandSpan`'s static maximum 32 + 8; a bound is a literal or one ref, `source.ts:1-12`).
  - **Caps** (§1.4): `g_f = clamp((minY − y)·recip(bandSpan), 0, 1) + clamp((y − maxY)·recip(bandSpan), 0, 1)`; `h_f = clamp((minY − bandSpan − y)·(1/8), 0, 1) + clamp((y − maxY − bandSpan)·(1/8), 0, 1)`; `cap_f = G_f·min(1, g_f [+ g_w + g_i]) + 128·min(1, h_f [+ h_i])` (Task 9 adds the bracketed terms; the wet roof's steep part `128·h_w` is voxel-level, Spec correction 14), added after `fl` inside each slot (the noodle's at voxel level); G_f (tree literals): entrances 16, cheese 16, spaghetti 3D 2.4, spaghetti 2D 2.4, noodle 2.4.

- [ ] **Step 1: Write the tests.**
  - `caveContinuity.test.ts` (§1.3; `unit (heavy)`): each family tap sampled on 1-block grids across every cap edge (minY, maxY, minY − bandSpan, maxY + bandSpan), every rarity edge and the ramp's ends shows no jump larger than the family's local Lipschitz bound (measured from the same grid away from the edge, × 2); the closure distance: across each band edge on a 64 × 64 grid of a cave class column region, the y span over which the carve rate falls from 90 % to 10 % of its value inside the band is ≥ 4 blocks at the defaults (§1.4); each value is printed for D25's record.
  - `caveTerms.test.ts`: wherever a corner's h ≥ 1/2 the slot is > 0 for every leaf value in its static range (interval check: ≥ −48 + 64); with `minY` > `maxY` the family narrows across the inverted range and is open nowhere a full band span inside it.
  - `liveness.test.ts`: each family's `maxY` has its mountain witness and is live; `spaghetti2d.maxY` as the user decided (live at the new default, or reported as exempt); the count and the lists that grow (Task 7's).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveContinuity.test.ts test/unit/caveTerms.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-schema`; `npm run docs:params`; `caveContinuity` into `unitShards.mjs`' `heavy` with its pin.
- [ ] **Step 4: Goldens:** from c64b4a9 as Task 6; the same key set.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): depth bands that narrow before they close; continuity and closure tests` (`git add src/core/params/schema.ts src/core/params/defaultTrees.ts src/metrics/liveness.ts README.md test/schema-shape.lock.json test/goldens.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/unit/caveContinuity.test.ts test/unit/caveTerms.test.ts test/unit/liveness.test.ts test/unit/densitySource.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/presetTrees.test.ts test/unit/defaultTrees.test.ts .github/scripts/unitShards.mjs test/unit/shards.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 9: The wet roof and the island cap (`wetCover`; `capTop` 180 in floating_islands)

**Files:**
- Modify: `src/core/params/schema.ts` (`caves.limits.waterDepth` 16 (8 … 48), `caves.limits.capTop` 344 (180 … 344), both `int` **(plan)**), `src/core/params/profiles.ts:34-37` (floating_islands' overlay gains `caves: { limits: { capTop: 180 } }`), `src/core/params/defaultTrees.ts` (g_w, g_i, h_i in every family's cap; the wet steep part `128·h_w` at voxel level, Spec correction 14), `src/metrics/liveness.ts` (`capTop` decided on a floating_islands witness column found by a bounded scan **(plan)**: one whose pre-cave top is ≥ 200 and that holds noise-cave air in y 176-200 at `capTop` 207 but not at 180 (U2's only effective step of 180 is 207, `numberSteps`, `liveness.ts:183-193`); not the island class column, which island noise picks, and `isIslandLeaf` `:161` unchanged; `waterDepth` on a coast class column), `README.md`, `test/schema-shape.lock.json`, `test/goldens.json`, `test/fixtures/expected-v1.json` and `expected-v2.json` (U4, regenerated), the default tree's cost and count pins (Global Constraints), master §3.6 (§13 item 11, but its debug-channel sentence), master §6.4's U2 row (Spec correction 12), `test/arch/masterSpec.test.ts`, the SP6a spec (Spec correction 14)
- Create: `test/unit/wetCover.test.ts`
- Test: `test/unit/caveTerms.test.ts`, `test/unit/floatingIslands.test.ts`, `test/unit/liveness.test.ts` (`:465-467`'s count), `test/unit/densitySource.test.ts` (`:34-40`'s list)

**Interfaces:**
- Consumes: Task 8's caps; the `col` fields `lakeMask`, `riverStrength`, `offset` (`SAMPLE_FIELDS`, `src/gen/column/columnStage.ts:37-40`; bounds `src/core/constants.ts:48-86`); water v0 (`src/gen/pipeline/terrainStage.ts:90-135`).
- Produces (§1.4, the defaults written as the tree reads them):
  - `wet′ = max(clamp(4·lakeMask, 0, 1), clamp(4·riverStrength, 0, 1), clamp((65 − offset)·(1/2), 0, 1))` (a `col`-only subtree, COLUMN class: inside a slot it reads the four lattice corners, at voxel level the position's bilinear readout);
  - `g_w = wet′·clamp((waterDepth + 8 + bandSpan − d)·recip(bandSpan), 0, 1)` inside each slot (d = `ref body` at the corner) and in the noodle's voxel-level cap (d = `interpolated(ref body)`, Spec correction 6);
  - the steep wet part (Spec correction 14): `S_w = 128·h_w`, `h_w = wet′·clamp((waterDepth + 8 − d)·(1/8), 0, 1)`, written once at voxel level, outside the slots, with wet′ at the position and d = `interpolated(ref body)`, and added to the caves slot and to the noodle: the root's `min(min(precave, add(caves slot, S_w)), add(noodle, S_w))` **(plan)** (S_w ≥ 0, so a voxel open with it is open without it and the tag's candidates are unchanged); the caves slot moves to `root.a.a.b.a` and the noodle slot to `root.a.b.a`, and the tests that address them are re-pointed in this commit;
  - `g_i = clamp((y − capTop + 8 + bandSpan)·recip(bandSpan), 0, 1)`, `h_i = clamp((y − capTop + 8)·(1/8), 0, 1)`.

- [ ] **Step 1: Write the tests.**
  - `caveTerms.test.ts`: under a lake column, a river column and a sea column (found by scans at seed 42), measured from the bed (the column's pre-cave top), every family's value with the wet roof (the slot plus S_w; the noodle plus S_w) is > 0 within d_w + 4 = 20 blocks below the bed and unaffected by the roof from d_w + 8 + s = 40 blocks below it; at `capTop` 180 every corner at y ≥ 176 of every family is > 0 and the caps rise from y 156; at `capTop` 344 the island terms are 0 for every y ≤ 319.
  - `wetCover.test.ts` (§1.4): over 100,000 positions of seeds 42 and 1 on default and archipelago, every position whose water v0 `waterTop` ≥ −64 has wet′ = 1 (bit for bit) at the position, which is what `S_w` reads (Spec correction 14). **Conditional:** a miss widens in this order, each re-run before the next, all in this commit: the gain 4 → 8; the margin 65 → 67; a river term `clamp((W − riverDist)·(1/4), 0, 1)` with W the largest wet half-width plus `wetMargin` (read from the rivers leaves); still a miss → **STOP for the user** with the positions.
  - `floatingIslands.test.ts`: `resolveProfile('floating_islands').caves.limits.capTop` is 180, the default's 344; no noise cave air at y ≥ 176 in 64 floating_islands cluster columns.
  - `liveness.test.ts`: `capTop` is decided and live on its floating_islands witness (not the island class column); `waterDepth` on the coast class column; `:465-467`'s count; `densitySource.test.ts:34-40`'s list; the cost and count pins and U4 follow; the SP6a describe's U2 count and row.
  - `inspectCost.test.ts` (D24, §10.5): `:176`'s check that the muted and islands trees fit keeps its trees, and the amplified and floating_islands trees with caves are added to it: each `densityColumnCost` ≤ `DENSITY_COLUMN_COST_MAX` (954,106,688); the default's cost printed for the record (about 35 × below the cap, D24's estimate).
  - SP6a describe: §3.6 holds §1.1's tree, §1.2's table with the schema defaults (the header comment's rule, `masterSpec.test.ts:4-6`, read from `DEFAULTS.caves`), §1.3's continuity rule and §1.4's floors, caps, wet roof and island cap; "every cave family is a tap (SP6a: …)"; the early-out line "(SP6a: the cave taps' intervals come from their noises' ±clampSigma, so underground cells need their corners)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveTerms.test.ts test/unit/wetCover.test.ts test/unit/floatingIslands.test.ts test/unit/liveness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-schema`; `npm run docs:params`; master §3.6.
- [ ] **Step 4: Goldens:** from c64b4a9 as Task 6; the same key set (`sp3e.region.T.floating_islands` moves with the cap).
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): the wet roof under lakes, rivers and seas, and the island cap capTop` (`git add src/core/params/schema.ts src/core/params/profiles.ts src/core/params/defaultTrees.ts src/metrics/liveness.ts README.md test/schema-shape.lock.json test/goldens.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/unit/caveTerms.test.ts test/unit/wetCover.test.ts test/unit/floatingIslands.test.ts test/unit/inspectCost.test.ts test/unit/sliceCost.test.ts test/unit/presetTrees.test.ts test/unit/defaultTrees.test.ts test/unit/liveness.test.ts test/unit/densitySource.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, and any test re-pointed to the slots' new paths).

---

### Task 10: The store's `cave` channel

**Files:**
- Modify:
  - `src/world/store/section.ts:23-32` (`FINAL_CAVE = 4`, `FINAL_INTS = 5`; `PROTO_CAVE = 2`, `PROTO_INTS = 3`; the module comment);
  - `src/world/store/columnTable.ts:24-45` (`REC_PROTO = 136`, `RECORD_INTS = 208`);
  - `src/world/store/api.ts` (`ColumnWriter.setProto` `:63` and the `TerrainWriter` `:183`; `ColumnView` `:147-166`);
  - `src/world/store/store.ts` (`setProto` `:403`, `:511`; `shareFinal` `:423-436` shares `PROTO_CAVE` → `FINAL_CAVE`; `replaceBlocks` `:582-590` leaves `FINAL_CAVE`; the release `:684-695` and `releaseProto`);
  - `src/world/store/padded.ts:37-45` (`PaddedSection.cave`, a fourth array, and `createPaddedSection`) and `:163-189` (`copyPaddedSection` copies `sectionCave` from the 3 × 3 final views; 0 below and above the world); `src/mesh/column.ts:27` only calls it and is unchanged;
  - `src/metrics/region.ts:69-93` (`regionHash` hashes the **proto** set's cave channel, `v.sectionCave(sy)`, after each section's fluid bytes, uniform sections expanded; T-only regions have no final set; its doc comment `:60-67`);
  - `test/harness/cache.ts` (`REGION_CACHE_FORMAT` `:47` 3 → 4, so old dumps miss; the dump layout `:14-21`, `:187-236` carries the 24 × `PROTO_INTS` proto descriptors and the dense cave slots they reference, 4,096 bytes each; the final cave is shared like the blocks and fluid; the rebuild `:365` calls `setProto(sy, blocks, fluid, cave)`), `test/harness/region.ts:282-286` (`descriptors` returns 24 × `PROTO_INTS` ints; its doc);
  - master §2.3 (§13 item 9);
  - `test/arch/masterSpec.test.ts`
- Test: `test/unit/columnTable.test.ts` (`:28`, `:36`, `:43-44`), `test/unit/store.test.ts`, `test/unit/padded.test.ts`, `test/unit/section.test.ts:30` (`PROTO_CAVE` 2, `PROTO_INTS` 3, `FINAL_CAVE` 4, `FINAL_INTS` 5), `test/unit/region.test.ts:23-50` (`referenceHash` gains the 4,096 cave bytes per section: `per = 24·(8192 + 4096 + 4096) + 2·4096`), `test/unit/regionCache.test.ts:133-149`, `test/unit/regionHarness.test.ts:93`, `test/integration/region.test.ts:27` (where they pin the layout), `test/unit/surfaceScatter.test.ts:137-147` and `:168-178` (`ColumnView` literals gain `sectionCave: (sy) => view.sectionCave(sy)` and `cave: (lx, y, lz) => view.cave(lx, y, lz)`, which `typecheck` requires once the members exist; and any other `ColumnView` literal a grep of `test/` finds), `test/unit/aux.test.ts` if it pins the record layout

**Interfaces:**
- Consumes: the section descriptors' share, uniform and release rules (`section.ts:1-16`).
- Produces:
  - `setProto(sy: number, blocks: Uint16Array, fluid: Uint8Array, cave?: Uint8Array): void` (absent: uniform 0, so `spikeStoreHandler.ts:28` and every existing caller are unchanged) **(plan)**;
  - `ColumnView.sectionCave(sy: number): Uint8Array | number`, `ColumnView.cave(lx: number, y: number, lz: number): number` (a proto view reads the proto set, a final view the final set);
  - `PaddedSection.cave: Uint8Array` (`PAD_VOXELS`), filled by the padded copy (0 outside the world);
  - `COLUMN_TABLE_BYTES` = 4,096 × 208 × 4 = 3,407,872.

- [ ] **Step 1: Write the tests.**
  - `columnTable.test.ts`: `RECORD_INTS` 208, `REC_FINAL` 16, `REC_PROTO` 136, the final set 24 × 5 and the proto set 24 × 3 inside the record.
  - store: a section written with a non-zero cave array takes one byte-pool slot and reads back; an all-zero cave array is uniform 0 and takes no slot; `shareFinal` shares the cave slot by reference (one slot, two references); `replaceBlocks` on an edited section keeps its cave entry (the X-ray's and the tag's channel survive D's diff overlay and the sim's edits); freeing the column releases the cave slots (the pool's free count back to its start); a proto view and a final view read their own set's cave.
  - padded: the copy reads the six neighbours' cave bytes at the border and 0 above and below the world.
  - region: `regionHash` covers the proto cave channel (`region.test.ts`' `referenceHash` rebuilt with it); `regionCache.test.ts` / `regionHarness.test.ts`: a cache hit of a region with a non-zero cave section reads back the same `cave()` values and the same `hash()` (a fixture section written through `setProto` with cave bytes, since T writes no tag before Task 11); a format-3 dump misses.
  - SP6a describe: §2.3's section channels contain `` `cave` (u8 per voxel: the cave kind in bits 0-3, bits 4-7 reserved; written by T, shared from the proto set, never persisted; SP6a) ``.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/columnTable.test.ts test/unit/store.test.ts test/unit/padded.test.ts test/unit/section.test.ts test/unit/region.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §2.3.
- [ ] **Step 4: Goldens:** from c64b4a9 as Task 6; the same key set (`regionHash` now covers an all-zero channel, so the region keys move again, inside the allowed set).
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(store): the cave channel in the proto and final sets and the padded view (SP6a D20)` (`git add src/world/store/section.ts src/world/store/columnTable.ts src/world/store/api.ts src/world/store/store.ts src/world/store/padded.ts src/metrics/region.ts test/harness/cache.ts test/harness/region.ts test/goldens.json test/unit/columnTable.test.ts test/unit/store.test.ts test/unit/padded.test.ts test/unit/section.test.ts test/unit/region.test.ts test/unit/regionCache.test.ts test/unit/regionHarness.test.ts test/integration/region.test.ts test/unit/surfaceScatter.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`, and any other `ColumnView` literal or layout pin by explicit path).

---

### Task 11: `tapReader` and the tag rule; T writes the noise kinds

**Files:**
- Modify: `src/gen/density/compile.ts` (`CompiledDensity` `:65-…` gains `tapReader` and `atVoxel`; `setVoxel` `:399` reused), `src/gen/density/bounds.ts:261-298` (`fillDensityColumn` gains `cells`), `src/core/constants.ts` (`CAVE_KIND`, `CAVE_FILM_KIND`; Spec correction 2), `src/gen/pipeline/terrainStage.ts` (`TAG` scratch beside `SOLID` `:60`; the tag pass after the fill `:144`; `setProto(sy, BLOCKS, FLUID, TAG section)` `:165`), master §3.6's debug-channel sentence and §1's `gen/caves/*` entry (§13 items 11, 8), `test/arch/masterSpec.test.ts` (`SP6A_MODULES`, first row), `.github/scripts/unitShards.mjs` (`caveTags` into `heavy`), `test/unit/shards.test.ts`, `test/goldens.json`
- Create: `src/gen/caves/tags.ts`, `test/unit/caveTags.test.ts`, `test/integration/caveSavedWorld.test.ts` (Review Focus 2)
- Test: `test/unit/densityCompile.test.ts`, `test/unit/terrainStage.test.ts`, `test/unit/constants.test.ts`

**Interfaces:**
- Consumes: Task 4's `precave` tap (Spec correction 5); Task 10's `setProto`; `CompiledDensity.cellCorners`, `cornerValues`.
- Produces:
  - `src/core/constants.ts`: `export const CAVE_KIND = Object.freeze({ none: 0, cheese: 1, spaghetti3d: 2, spaghetti2d: 3, noodle: 4, entrance: 5, worm: 6, ravine: 7, undergroundWorm: 8, other: 9 })`; `export const CAVE_FILM_KIND = 15` (the X-ray pack only, never stored);
  - `CompiledDensity.atVoxel(lx: number, y: number, lz: number): void` (sets the voxel registers and bumps the epoch once; the cell's corners must be ready); `CompiledDensity.tapReader(name: string): (() => number) | null` (null when the tap is not reachable; resolved once per compile; reads at the registers of the last `voxelFn` or `atVoxel` call: an inside tap trilerps its corner values exactly as `tapFn` does, `compile.ts:427-439`; a VOXEL tap returns its node's memoised value, evaluating it once if the epoch is new; no Map lookup, no epoch bump). The compiler's epoch memo (`compile.ts:312-320`) wraps a thunk only when `calls[id] > 1`, and a tap read once (`precave`, each family tap) has one parent, so `compileDensity` applies the memo to every tap node a `tapReader` may name, whatever `calls` says;
  - `fillDensityColumn(b, s, solid, values, mask, stop, cells?: Uint8Array | null): boolean`: `cells` (768 entries, `(ck·4 + cj)·4 + ci`) is set to 1 where the cell's corners were evaluated, and for cells evaluated voxel by voxel; a tree without `interpolated` evaluates no corners (`bounds.ts:283-288`), so its straddling cells set `cells` without them;
  - `src/gen/caves/tags.ts`: `export interface CaveReaders { readonly precave, terrain, entrances, cheese, spaghetti3d, spaghetti2d, pillars, noodle: (() => number) | null }`; `export function caveReadersOf(c: CompiledDensity): CaveReaders` (taps `precave`, `terrain`, `entrances`, `cheese`, `spag3d`, `spag2d`, `pillars`, `noodle`); `export function tagVoxel(c: CompiledDensity, r: CaveReaders, pillarThreshold: number, lx: number, y: number, lz: number): number` (the rule at one density-air voxel above y −64 whose cell's corners are ready, or of a tree without slots, steps 2-3); `export function tagColumn(c: CompiledDensity, r: CaveReaders, pillarThreshold: number, solid: Uint8Array, cells: Uint8Array, out: Uint8Array): void`.
  - The rule (§3.2; steps 1-3 here, step 4 is Task 27's), a pure function of the voxel:
    1. the final block is solid → 0; y −64 (voxel index < 256) is always bedrock (`terrainStage.ts:151-153` writes `BEDROCK` there whatever the density) → 0, so a family whose `minY` is −64 (entrances, spaghetti 2D) never tags it, and the carve step (Task 27) leaves y −64 solid;
    2. pre-cave solidity: `precave > 0`; without a `precave` tap, `terrain > 0`; with neither, unknown → 0 for density air (only carver kinds are tagged); not pre-cave solid → 0 (sky or surface air);
    3. density air: `keep = pillars·(1/16) < pillars.threshold ? −1e6 : pillars` (no `pillars` tap: −∞); `caves = max(min(the present E, C, S3, S2), keep)`; the candidates are the present E, C, S3, S2 when `caves ≤ 0` and the noodle when `noodle ≤ 0`; the lowest value wins, ties in the order E, C, S3, S2, noodle; density air no candidate explains → 9;
    4. (Task 27) carved: the kind of the first source, in the window's order, whose ellipsoid carved it.
- **The tag pass** (sketch; spec §3.2 "where the values come from"):
  ```
  for each cell (ci, ck, cj):
    if the cell was decided solid: continue                          // tag 0 (out is cleared)
    if cells[cell] === 0:                                            // decided air before its corners
      if the precave tap's (else the terrain tap's) cell interval hi ≤ 0: continue   // sky or surface air: tag 0
      if the tree has slots: c.cellCorners(ci, ck, cj)               // otherwise air under a muted or negative family
    for each voxel v of the cell with solid[v] === 0 and v ≥ 256:    // y −64 is bedrock
      c.atVoxel(lx, y, lz)                                           // registers only; the cell's corners are ready
      out[v] = tagVoxel(c, r, threshold, lx, y, lz)
  ```
  (the precave interval is `b.cellInterval` on that tap, or `tapReader` at its voxels; a tree whose taps straddle 0 underground decides its cave cells after their corners, so the extra branch runs only on trees like `treeMutator`'s, whose muted taps (−1e6) decide a cell air before its corners where precave > 0.)

- [ ] **Step 1: Write the tests.**
  - `densityCompile.test.ts`: `tapReader(name)()` after `voxelFn` equals `tapFn(name, …)` bit for bit for every tap of the default tree on every voxel of column (0, 0) and of a cave class column; after `atVoxel` in a cell decided air after its corners, the same; an unknown name → null; reading twice costs no second evaluation of a shared subterm (a counting noise stub); with a counting noise stub, `tapReader('precave')()` after `voxelFn` evaluates the detail noise zero more times (the tap memo).
  - `caveTags.test.ts` (`unit (heavy)`): on 64 columns (seed 42, default), the tagged set equals (pre-cave solid ∧ density air) voxel for voxel; on the default tree no cell decided air before its corners (`cells` 0, not decided solid) holds a voxel with `precave` > 0 (spec §3.2, §10.7); no voxel at y −64 is tagged; the stored tag equals the per-voxel rule on every voxel of a tree with a family tap muted to −1e6 (cells decided air before their corners where precave > 0) and of a tree without `interpolated` (no corners); ties resolve in the order E, C, S3, S2, noodle (a fixture tree with equal family values); a voxel inside pillar rock (`keep > 0`) opened by the noodle is tagged 4; the default tree yields no 9; a tree with only `terrain` and `noodle` taps tags density air the noodle explains 4 and the rest 9; a tree with no `terrain` and no `precave` tap tags density air 0.
  - `terrainStage.test.ts`: a column's proto `cave` sections equal `tagColumn`'s output section by section; a column with no cave is uniform 0 in every section.
  - `constants.test.ts`: `CAVE_KIND`'s ten values and `CAVE_FILM_KIND` 15, all < 16.
  - `caveSavedWorld.test.ts` (Review Focus 2): the case of the Review Focus, with the X-ray's walls checked in Task 17's test once `meshXray` exists (this task checks the tag and the blocks).
  - SP6a describe: §3.6 contains "T writes the winning kind per carved voxel into the `cave` channel (SP6a)"; `SP6A_MODULES` gains its first row, `[/^\s+caves\/carvers\.ts /, 'carve.ts tags.ts (SP6a)', 'src/gen/caves/tags.ts']` (the master entry is the indented line under `gen/`, `docs/superpowers/specs/2026-09-26-architecture-design.md:126`, and the existing rows use `/^\s+…/` heads, `masterSpec.test.ts:1645-1654`), and §1's line under `gen/` reads `      caves/carvers.ts carverCache.ts carve.ts tags.ts (SP6a)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project integration --project arch test/unit/densityCompile.test.ts test/unit/caveTags.test.ts test/unit/terrainStage.test.ts test/unit/constants.test.ts test/integration/caveSavedWorld.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §3.6 and §1; `caveTags` into `heavy`.
- [ ] **Step 4: Goldens:** from c64b4a9 as Task 6; the same key set (the region keys now hash real tags).
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): tapReader and the cave tag; T writes the noise kinds into the cave channel` (`git add src/gen/density/compile.ts src/gen/density/bounds.ts src/core/constants.ts src/gen/caves/tags.ts src/gen/pipeline/terrainStage.ts test/goldens.json test/unit/densityCompile.test.ts test/unit/caveTags.test.ts test/unit/terrainStage.test.ts test/unit/constants.test.ts test/integration/caveSavedWorld.test.ts test/arch/masterSpec.test.ts .github/scripts/unitShards.mjs test/unit/shards.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 12: Probes I: `caveTagAt`, `solidAt`; DT2 `tagProbe`

**Files:**
- Modify: `src/gen/caves/tags.ts` (`caveTagAt`), `src/gen/density/probe.ts:19-26` (`solidAt`), `test/metrics/region.metric.ts:260` (DT2 gains `tagProbe` and the straddle stratum), `test/harness/dt2.ts` (the stratum), `test/thresholds.ts` (`DT2.tagProbe`), `test/thresholds.lock.json` (generated), the SP6a spec (`## Threshold log`)
- Test: `test/unit/dt2Column.test.ts`, `test/unit/caveTags.test.ts`

**Interfaces:**
- Consumes: Task 11's readers; `probe` (`probe.ts:19`); `treeMutator` with `noiseScaled` (Task 3).
- Produces:
  - `export function caveTagAt(dc: DensityContext, x: number, y: number, z: number): number` (steps 1-3 at one voxel: 0 at y −64; `dc.column`, the cell's corners, `voxelFn` for solidity, `atVoxel`, the readers; RangeError outside the window as `probe`); Task 27 adds step 4;
  - `export function solidAt(dc: DensityContext, x: number, y: number, z: number): boolean` (`probe(dc, x, y, z) > 0`; Task 27 adds `!carvedAt`);
  - DT2 `tagProbe`: over DT2's columns per (profile, seed) (16 on fast, 256 on quick and full, `region.metric.ts:146`), the stored proto tag against `caveTagAt` on every sampled voxel of the default tree and of `treeMutator` trees (§3.2's fallback; their muted taps exercise Task 11's cells decided air before their corners); a new stratum samples voxels in cells whose cave interval straddles 0; row `tagProbe: { max: 0, activeFrom: 'SP6a' }`; `probeBulk` compares the probe with the stored block as today (density only until Task 27, which carves in T and in the probes in one commit).

- [ ] **Step 1: Write the tests.** `caveTags.test.ts`: `caveTagAt` equals the stored tag on every voxel of 8 columns, in cave interiors (cells decided air after corners) and in straddling cells; `dt2Column.test.ts`: the straddle stratum picks only cells whose cave interval straddles 0, at least 1 per column that holds a cave.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveTags.test.ts test/unit/dt2Column.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the row; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 12: DT2 tagProbe max 0, gated from SP6a on every tier (spec §10.3, D22; new part, holds by construction).`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS (DT2 0 on fast); no golden diff against Task 11.
- [ ] **Step 5: Commit** `feat(caves): caveTagAt and solidAt; DT2's tagProbe` (`git add src/gen/caves/tags.ts src/gen/density/probe.ts test/metrics/region.metric.ts test/harness/dt2.ts test/thresholds.ts test/thresholds.lock.json test/unit/caveTags.test.ts test/unit/dt2Column.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 13: The slice reference's corner memo

**Files:**
- Modify: `src/gen/density/reference.ts` (`createDensityReference` `:62`; the `interpolated` read `:125-131` goes through a memo), `src/gen/inspect/fieldSlice.ts` (each slice part creates one memo and passes it, `:19-20` header)
- Test: `test/unit/densityReference.test.ts`, `test/unit/fieldSliceHeavy.test.ts`

**Interfaces:**
- Consumes: the reference evaluator (the DT2 oracle).
- Produces: **(plan)** `export interface CornerMemo { clear(): void }`, `export function createCornerMemo(): CornerMemo`; `DensityReference`'s evaluation takes an optional memo; with it, `corner(s, node, ci, ck, cj)` is computed once per (interpolated node, column, corner) within the memo's life; values bit-exact (pure); the DT2 oracle calls it without a memo, so DT2 is unchanged.

- [ ] **Step 1: Write the tests.** `densityReference.test.ts`: with and without a memo, the reference's values are equal bit for bit on 4 columns of the default tree (ten interpolated slots) and of an edited tree; with a memo the corner evaluations of a 128-sample vertical line fall below 1/5 of the count without it (a counting noise stub). `fieldSliceHeavy.test.ts`: a vertical 128² `density` slice is byte-identical with the memo.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/densityReference.test.ts test/unit/fieldSliceHeavy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `perf(density): the slice reference memoises corner values per part (SP6a §7.4)` (`git add src/gen/density/reference.ts src/gen/inspect/fieldSlice.ts test/unit/densityReference.test.ts test/unit/fieldSliceHeavy.test.ts`).

---

### Task 14: D25's prototype: P1's gates, the measurements, the rule

**STOP for the user before Step 3:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Modify: `test/bench/gates.ts` (`TERRAIN_P50_MAX_MS` `:11` → 10 and its comment; `TERRAIN_P99_MAX_MS = 20`; `:280`, `:283` and two p99 checks for `terrain.real` and `terrain.islands`), `test/bench/noise.bench.ts` (`terrain.real`'s p99 and the log lines `:584-587`: corners per column (median, p90), the voxel phase's share, 64 amplified mountain columns' p99, the cave channel's bytes per column, each family's slot value at the median voxel it tags), `test/unit/benchGates.test.ts`, `test/baselines.json` (re-recorded), the SP6a spec (`## Exit evidence`: "### D25's prototype (Task 14)"; Spec correction 8 and the stub's replacement **(plan)**: the prototype measures the real channel, built in Tasks 10-11, instead of a stub, because §1.6's voxel estimate counts the tag's reads of the family slots, which a stub would leave out of `terrain.real`; the tag and the probes (Tasks 10-12) are push A's content and the levers keep every family tap, so nothing past push A is built before the prototype; if a miss leads the user to D20's alternative, Tasks 10-12 are redone over aux B), `src/core/params/defaultTrees.ts` (only under Step 4's G_f rule)

**Interfaces:**
- Consumes: Tasks 6-13; `measure` (`noise.bench.ts`); `BENCH_EXEMPT` (`gates.ts:229-245`); `npm run measure:chrome -- --route bench --gpu iris --workers 4` (`mediumFill4wMs`, SP5c 4,921 ms, gate 6,000, `test/thresholds.ts:148`).
- Produces: `TERRAIN_P50_MAX_MS = 10`, `TERRAIN_P99_MAX_MS = 20` (D24, master P1); D25's rule applied and recorded.

- [ ] **Step 1: Write** `benchGates.test.ts`: the two constants; a `terrain.real` p99 of 20.1 ms and a `terrain.islands` p99 of 20.1 ms each report a gate miss; p50 10.1 likewise.
- [ ] **Step 2: Measure in Node** (an agent; the reference CPU, the i7-12700H; quiet machine, load below 2, touching no other process): `BENCH_EXEMPT=terrain.real,terrain.islands,density.corner,slice.vertical128,slice.horizontal128,light.column,mesh.section,surface.column npm run bench` twice. Record per run: `terrain.real` p50 and p99, `terrain.islands` p50 and p99, the voxel phase's share of `terrain.real`, amplified columns' p99, corners per column (median 475 and p90 718 estimated), `density.corner`, `slice.vertical128` (with the memo) and the cave channel's bytes per column; from `caveContinuity.test.ts`' output, each cap's closure distance; per family, its slot value at the median voxel it tags over the 256 columns (spec §1.4: G_f is "about the family's typical air depth", its defaults "set from D25's measurement").
- [ ] **Step 3: Measure in Chrome** (an agent; the STOP's conditions; cold shader cache): `npm run measure:chrome -- --route bench --gpu iris --probe-only`, then `… --route bench --gpu iris --workers 4`, recording `mediumFill4wMs`, the shared memory (`sabMB` against SP5c's 53.6 MB; the cave channel's share estimated +31-47 MB) and the stage-T time; the file is not committed here (Task 47 re-measures every route).
- [ ] **Step 4: The rule** (D25): `terrain.real` p50 > 7 ms or `mediumFill4wMs` > 5,600 ms → **Task 15's levers in order**, each measured by Steps 2-3 before the next, all before Task 16; a miss after them → **STOP for the user** with every measurement (D25). `slice.vertical128` > 300 ms after the memo → the slice redraws on release (D13's fallback, `src/ui/inspector/sliceView.ts:12-13`) in Task 15 and the gate goes to the user with the measurement. Otherwise nothing runs; recorded either way. **G_f** **(plan)**: a family whose G_f differs from the magnitude of its measured median value by more than × 2 gets G_f = that magnitude (rounded to 0.1) in its own commit before Task 16 (`fix(caves): the caps' gentle rise from D25's measurement`; re-recorded from c64b4a9 as Task 6, with Task 6's mirrors: the cost pins, U4's fixtures, master §3.6's table and pin; the closure-distance test re-run and green); Task 38 may re-set them again.
- [ ] **The evidence table** (the spec's "### D25's prototype (Task 14)", one row per measure, both runs and the estimate beside each):

  | measure | estimate (spec) | run 1 | run 2 | gate or trigger |
  |---|---|---|---|---|
  | `terrain.real` p50 / p99 | 4-9 / — ms | | | ≤ 10 / ≤ 20; p50 > 7 triggers the levers |
  | `terrain.islands` p50 / p99 | — | | | ≤ 10 / ≤ 20 |
  | the voxel phase's share of `terrain.real` | +3-4.5 ms | | | recorded |
  | amplified columns' p99 | 12-20 ms | | | recorded |
  | corners per column, median / p90 | 475 / 718 | | | recorded |
  | `density.corner` | 2-2.5 µs | | | recorded |
  | `slice.vertical128` (with the memo) | — | | | ≤ 300 ms |
  | the cave channel's bytes per column; `sabMB` | +31-47 MB at RD 12 | | | recorded |
  | `mediumFill4wMs` (Chrome, 4 workers) | 5.7-6.3 s | | | ≤ 6,000; > 5,600 triggers the levers |
  | each cap's closure distance (90 % → 10 %) | ≥ 4 blocks | | | the unit test's bound |
  | each family's median tagged value against its G_f | 16, 16, 2.4, 2.4, 2.4 | | | Step 4's G_f rule |
  | the levers applied | — | | | Task 15 |

- [ ] **Step 5: Gate and record.** `npm run bench:record` on the quiet machine (after the exempt runs); `npm run bench` again: within every gate (`terrain.real` and `terrain.islands` p50 ≤ 10, p99 ≤ 20) and the +30 % p50 ratio against the new baselines.
- [ ] **Step 6: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 7: Commit** `perf(bench): P1's T gates at 10 and 20 ms; D25's prototype measured` (`git add test/bench/gates.ts test/bench/noise.bench.ts test/unit/benchGates.test.ts test/baselines.json docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 15: Levers I (conditional)

Run only when Task 14's rule fires; each lever is one commit, measured (Task 14's Steps 2-3; the Chrome step only when the fill missed, **STOP** before it under Task 14's conditions) before the next; stop at the first that meets every gate. Levers (1)-(3) of §1.6 are built in (Tasks 6-7). Each output-changing lever re-records from c64b4a9 (the same key set as Task 6); each output-keeping lever shows no golden diff against its predecessor.

- [ ] **15a: lever 4, output-keeping.** Per cell, from the corner hulls: a family whose hull's low end exceeds another family's high end cannot be the minimum and is not trilerped at the cell's voxels; the noodle is skipped where its cell interval's low end exceeds the high end of min(T + detailG, caves) over the cell (it cannot be the minimum either; Spec correction 15: dropping a merely positive noodle would change `min(…)`'s value). Files: `src/gen/density/compile.ts`, `src/gen/density/bounds.ts`, the SP6a spec (Spec correction 15); test "with and without the lever, every voxel value and every tag of 64 columns are equal bit for bit" (DT2's `Object.is` checks against the reference stay 0). Commit `perf(density): skip families that cannot be the minimum in a cell (SP6a D25 lever 4)`.
- [ ] **15b: lever 5, output-changing.** `caves.noises.cheese.octaves` 4 → 3 and `caves.noises.entrance.octaves` 3 → 2 (with `entrance`'s amplitudes cut to its last two **(plan)**); the spec's §1.2 table amended in this commit. Files: `src/core/params/schema.ts`, the schema lock (`npm run test:accept-schema`), `README.md` (`npm run docs:params`), U4's `test/fixtures/expected-v1.json` and `expected-v2.json` (regenerated), master §3.6's table and its pin (Task 9's), `test/bench/inlined.ts` and `test/unit/inlined.test.ts` when they exist (Task 37), the cost pins where an octave weight enters them (`inspectCost.test.ts`, `sliceCost.test.ts`), the spec. Commit `perf(caves): fewer octaves for the cheese and entrance noises (SP6a D25 lever 5)`.
- [ ] **15c: lever 6, output-changing** (Spec correction 16). Written in the tree, not in `cornerFn`: each spaghetti slot's body becomes `rangeChoice(min(ref entrancesBody, ref cheeseBody), −1e9, −16, const 1e6, <its body>)` inside its `interpolated` **(plan)**, with `defs.entrancesBody` and `defs.cheeseBody` the corner bodies the entrance and cheese taps' `interpolated` read (`tap entrances(interpolated(ref entrancesBody))`), so the compiler CSE-shares them (Spec correction 6's argument) and its `rangeChoice` evaluates only the chosen branch: no compiler change, and compiled = reference (`reference.ts`, the DT2 `compiledReference` oracle and the slice evaluator with Task 13's memo) by construction. A skipped corner holds the finite 1e6 (as Task 4's empty slots), so `trilerp` stays finite and `tapReader` trilerps it unchanged: a cell with a skipped corner reads a large positive spaghetti there, never the lowest candidate. Files: `src/core/params/defaultTrees.ts`, the cost and count pins (Global Constraints), U4's fixtures, `test/bench/inlined.ts` and `test/unit/inlined.test.ts` when they exist (Task 37), `test/unit/caveTerms.test.ts` (compiled = reference on the four columns with the lever), the spec (Spec correction 16); DT2 `compiledReference` 0 on fast. Commit `perf(density): skip the spaghetti slots under deep cheese and entrances (SP6a D25 lever 6)`.
- [ ] **15d: the slice on release** (only when `slice.vertical128` missed): `sliceView.ts` re-requests a `density`/`node` slice on a gesture's end, not per configure, while a cave leaf is being dragged. Commit `fix(inspector): density slices redraw on release over the cave tree (SP6a D13)`.
- [ ] **STOP:** a gate still missed after its levers: every measurement to the user (D25); no gate is loosened.
- [ ] Each lever: `npm run typecheck && npm test` (U4 `migrationFailures` 0 after 15b and 15c); its golden check as above; the measurement recorded under Task 14's evidence; staging by explicit path, every mirror Global Constraints' "Mirrors of the defaults" names included.

---

### Task 16: Push A: the golden record, Bun, the push, CI measured

**Files:**
- Modify: the SP6a spec (`## Exit evidence`: "### Push A (Task 16)")

- [ ] **Step 1: The record.** `git checkout c64b4a9 -- test/goldens.json && npm run test:goldens`; `git diff --exit-code HEAD -- test/goldens.json` (the last generator commit already recorded it); `git diff c64b4a9 -- test/goldens.json` lists exactly `generatorVersion` 5 → 6, `sp1.params`, `sp3a.region.T.default`, `sp3a.region.T.large_biomes`, `sp3e.region.T.amplified`, `sp3e.region.T.archipelago`, `sp3e.region.T.floating_islands`, `sp3b.density.default`, `sp3c.surface.ops` and the added `sp6a.density.ops` (60 keys); `npx --yes bun@1 test/tools/goldensJsc.ts` 60/60; `npm run test:metrics` green (quick; DT1, DT2 with `tagProbe`, U2, U4).
- [ ] **Step 2: Evidence:** the golden diff key by key, the Bun run, `GENERATOR_VERSION` 6. Commit `docs(sp6a): push A's golden diff and evidence` (`git add docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`). This commit is push A's head; a commit cannot name its own SHA, so Step 3 records it.
- [ ] **Step 3: Push** (the controller): `git push -u origin sp6a/cave-shapes`; `git rev-parse HEAD` is push A's head, push B's `<push A head>` (Tasks 27, 37, 38, 39) and the base of push B's golden diff. CI green; the head SHA, the CI wall and each job against §11 (the heavier T, no `caves` shard yet) recorded in the next docs commit (Task 17's commit may carry it, staging the spec); above 3 min 30 s, the levers run at push B (Task 39).

---

### Task 17: The X-ray I: `meshXray` and the `xray` pack layout

Tasks 17-23 change no generated output and are pushed at will after push A (none sits between unpushed generator commits); each runs `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`.

**Files:**
- Create: `src/mesh/xray.ts`, `test/unit/meshXray.test.ts`
- Modify: `src/mesh/builder.ts:10` (`MeshPass` 0-3, a fourth pass buffer), `src/mesh/packing.ts:1-12` (`PACK_LAYOUT` gains `xray`; the doc comment), `src/render/materials/glsl/packing.glsl.ts` (generates the `xray` unpack, which Task 18's shader uses), `.github/scripts/unitShards.mjs` (`meshXray` into `heavy`), `test/unit/shards.test.ts`, `test/integration/caveSavedWorld.test.ts` (Review Focus 2's X-ray half), master §1's `mesh/` entry (§13 item 8), `test/arch/masterSpec.test.ts` (`SP6A_MODULES` row)
- Test: `test/unit/packing.test.ts`

**Interfaces:**
- Consumes: Task 10's `PaddedSection.cave`; `MeshBuilder` (`src/mesh/builder.ts`); the opaque-full-face predicate `meshSolid` uses (`greedy.ts:173`); `CAVE_KIND`, `CAVE_FILM_KIND`.
- Produces:
  - `export function meshXray(padded: PaddedSection, builder: MeshBuilder): void` **(plan)** (the spec's `meshXray(padded, cave, builder)` with the cave array read from `padded.cave`, which Task 10 put there); emits into the builder's pass 3 (this task: `MeshPass = 0 | 1 | 2 | 3` and the builder's fourth buffer, `src/mesh/builder.ts:10`; the payload keeps iterating passes 0-2 until Task 19, so this task's tests read the builder's pass-3 view directly);
  - a voxel is **hollow** when its tag's low 4 bits ≠ 0 and its block is not an opaque full cube; a wall quad is each face of a hollow voxel whose neighbour shows an opaque full face, kind = the hollow's tag; the film is each up face of an opaque or fluid voxel whose up neighbour is air with sky light 15 (`padded.light >> 4 === 15`), kind 15; greedy merge on (kind, face) only, no light, no AO;
  - `PACK_LAYOUT.xray`: position as the solid word's; data word `face` 0-2, `kind` 3-6, `biome` 7-10 (reserved for SP6b, written 0), bits 11-31 spare **(plan)**.

- [ ] **Step 1: Write the tests** (`meshXray.test.ts`, `unit (heavy)`): against a brute force on fixtures: one hollow voxel in stone (6 walls, kind its tag); a 3 × 3 × 3 cheese void (6 merged quads, one per face); two kinds side by side (no merge across kinds; air-to-air faces between them none); a hollow voxel beside glass (a cutout block: no wall) and beside water (no wall); a flat grass surface under sky 15 (one merged film quad, kind 15) and under an overhang (a gap where sky < 15); a placed stone block inside a tagged cave (walls toward it, Review Focus 2) and a dug, untagged voxel (no wall); the section's border reads the padded neighbours. `packing.test.ts`: `xray` round-trips face, kind and biome; the generated GLSL names them.
- [ ] **Step 2: Run** `npx vitest run --project unit --project integration test/unit/meshXray.test.ts test/unit/packing.test.ts test/integration/caveSavedWorld.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §1's `mesh/` entry gains `xray.ts (SP6a)`; the `SP6A_MODULES` row.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(mesh): meshXray, the cave walls and the surface film (SP6a D23)` (`git add src/mesh/xray.ts src/mesh/builder.ts src/mesh/packing.ts src/render/materials/glsl/packing.glsl.ts test/unit/meshXray.test.ts test/unit/packing.test.ts test/integration/caveSavedWorld.test.ts .github/scripts/unitShards.mjs test/unit/shards.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 18: The X-ray II: the material and the collapse uniform

**Files:**
- Create: `src/render/materials/glsl/xray.glsl.ts`, `src/render/xrayPalette.ts`
- Modify:
  - `src/render/materials/uniforms.ts:3-12` (`SharedUniforms` gains `xrayOn`, `xrayYMin`, `xrayYMax`, `xrayRadius`, `xrayPalette`);
  - `src/render/materials/index.ts` (`MaterialSystem.xray` in both variants; `setXray`; the stand-ins and disposal);
  - `src/render/materials/glsl/terrain.glsl.ts` (the vertex collapse while `xrayOn` is 1, under `#ifndef GHOST`, `:121-123`'s define);
  - `src/render/materials/glsl/water.glsl.ts` (the same collapse);
  - `src/render/renderer.ts` (`WorldRenderer.setXray`, `setXrayBand`; the X-ray material compiles at load through Task 19's pass-3 stand-in, `renderer.ts:325-343`);
  - `src/render/selection.ts:39-41` (`export const XRAY_ORDER = AFTER_WATER_ORDER − 1` **(plan)**: after every water region, whose orders `regionMesh.ts:592-594` renumbers 0 … N − 1 with N ≪ 2^20, and before the ghost, whose `GHOST_ORDER` equals `AFTER_WATER_ORDER`, so nothing lies strictly between them); Task 19 sets it where the pass-3 objects are created;
  - master §1's `materials/` line (§13 item 8);
  - `test/arch/masterSpec.test.ts`
- Test: `test/unit/materials.test.ts`, `test/unit/renderer.test.ts`, `test/unit/xrayPalette.test.ts`

**Interfaces:**
- Consumes: Task 17's `xray` pack layout; `fogRange` (`materials/index.ts:54-64`).
- Produces:
  - `src/render/xrayPalette.ts`: `export const XRAY_COLORS: readonly string[]` (16 sRGB hex strings by kind: 0 unused, 1 cheese amber `#ffb000`, 2 spaghetti 3D cyan `#00e5ff`, 3 spaghetti 2D blue `#3d7bff`, 4 noodle magenta `#ff3df0`, 5 entrance green `#3ddc5a`, 6 worm orange `#ff7a1a`, 7 ravine red `#ff3030`, 8 underground worm yellow `#ffe83d`, 9 other density air grey `#9aa0a6`, 10-14 unused, 15 film grey `#c8c8c8`) **(plan)** (D10's names; styling deferred), `export const XRAY_LABELS: readonly string[]` (the legend's names, 1-9 and 15);
  - `xray.glsl` (`batch` and `mesh` variants): colour `palette[kind]·FACE_SHADE[face]`; alpha 0.14 for walls, 0.05 for the film; additive blending, `depthWrite: false`, `depthTest: false`, `DoubleSide`, `forceSinglePass`; a distance fade to 0 at the fog end ((RD − 1)·16); wall fragments outside `[xrayYMin, xrayYMax + 1)` and every fragment beyond `xrayRadius` discarded; the film ignores the band; every vertex collapsed while `xrayOn` is 0; no lightmap read;
  - `MaterialSystem.setXray(on: boolean, yMin: number, yMax: number, radius: number): void` (uniforms only; allocates nothing); `WorldRenderer.setXray(on: boolean): void` (the uniform, the sky dome's visibility, the clear colour `#0b0e14` while on; there are no clouds before SP11) and `WorldRenderer.setXrayBand(yMin: number, yMax: number): void`; `xrayRadius` = the fog end unless Task 48 sets a radius.

- [ ] **Step 1: Write the tests.**
  - materials: `xray` exists in both variants with additive blending, `depthWrite` false, `depthTest` false, `DoubleSide`, `forceSinglePass`; its shader source discards outside the band only for kind ≠ 15; the terrain shader's collapse sits outside `#ifdef GHOST` (the ghost material's compiled source has no `xrayOn` branch); `setXray` writes the four uniforms and allocates nothing (10,000 calls under 256 KB).
  - `renderer.test.ts`: `setXray(true)` hides the sky dome and sets the clear colour `#0b0e14`; `setXray(false)` restores both; `setXrayBand` writes the two band uniforms only.
  - `xrayPalette.test.ts`: 16 entries; the nine kinds and the film distinct; `XRAY_LABELS[1]` "Cheese" … `[15]` "Surface" **(plan)**.
  - SP6a describe: §1's `materials/` line names the X-ray material.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/materials.test.ts test/unit/renderer.test.ts test/unit/xrayPalette.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(render): the X-ray material, its palette and the collapse uniform (SP6a §5.2-§5.3)` (`git add src/render/materials/glsl/xray.glsl.ts src/render/xrayPalette.ts src/render/materials/uniforms.ts src/render/materials/index.ts src/render/materials/glsl/terrain.glsl.ts src/render/materials/glsl/water.glsl.ts src/render/renderer.ts src/render/selection.ts test/unit/materials.test.ts test/unit/renderer.test.ts test/unit/xrayPalette.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 19: The X-ray III: pass 3 through the payload, the protocol, both renderers and the staging; `R1.xray`

**Files:**
- Modify:
  - `src/mesh/column.ts` (`MESH_PASS_XRAY = 3` beside `:37-39`; `payloadProblem` `:83` accepts 0 … 3; `PASSES` `:265` → `[0, 1, 2, 3]`; `MAX_ROWS` `:101` → `PASSES.length * SECTIONS` (it sizes `rows` and `spheres`, `:143-144`, and `appendRow` `:246-253` writes past them without growth, so rows beyond 72 would be dropped); `meshColumnPayload` `:304-336` calls `meshXray` after `MESH_FLUID`);
  - `src/workers/protocol.ts:566-569`, `:613-616` (the guard and the rebuild accept pass 3);
  - `src/render/regionBatch.ts` (`PASSES` `:37`, `materialOf` `:119-123` (pass 3: `materials.xray`, Task 18), `newRegion` `:170` four slots, `:219-220` `sortObjects = pass !== MESH_PASS_XRAY`; `needRows`, `needVertices`, `needIndices` `:131-133` sized `PASSES.length` (4), so `columnNeed` `:183-189` asks `passNeed` about the pass-3 batch; the pass-3 objects' `renderOrder = XRAY_ORDER`, Task 18);
  - `src/render/regionMesh.ts` (`:37`, `:192`, `:403`; the translucent sort `:592-594` excludes pass 3; the pass-3 objects' `renderOrder = XRAY_ORDER`);
  - `src/render/regionGrid.ts` (`RESERVATION` `:38-42` gains `[MESH_PASS_XRAY]: [16_384, 24_576]`; `addStandIns` `:551-559` includes pass 3: Spec correction 1);
  - `test/metrics/render.metric.ts:192` (`R1` gains the part `xray`);
  - `test/harness/refs.ts` (`bruteXrayFaces(view, cx, cz)` beside `bruteFaces` `:119`; `meshFaceCounts` `:160-209` handles pass 3 apart: today every row with pass ≠ 2 is filed as opaque and decoded with the solid layout (`:171-175`), so pass-3 rows are excluded from `opaque`, `water`, `quadsOpaque` and `quadsWater` and returned as an X-ray face-key list decoded with `PACK_LAYOUT.xray.face`, which `R1.xray` compares with `bruteXrayFaces`);
  - `test/thresholds.ts`;
  - `test/thresholds.lock.json` (generated);
  - master §4.5 (§13 item 13);
  - `test/arch/masterSpec.test.ts`;
  - the SP6a spec (Spec corrections 1, 7; `## Threshold log`)
- Test: `test/unit/meshColumn.test.ts` (the payload), `test/unit/meshPayload.test.ts:62-63` (the case becomes `['pass outside 0-3 (4)', (p) => { p.rows[1] = 4; }, /pass 4/]`), `test/unit/worldProtocol.test.ts` (the mesh result's guard), `test/unit/regionGrid.test.ts`, `test/unit/regionBatch.test.ts`, `test/unit/regionMesh.test.ts`, `test/unit/regionHarness.test.ts` (its `meshFaceCounts` cases)

**Interfaces:**
- Consumes: Task 17's `meshXray`; Task 18's `materials.xray`, `setXray`, `setXrayBand`.
- Produces: pass 3 rows in every payload whose sections hold hollow voxels or film; both renderers keep a fourth object per region, its rows staged, uploaded under the gate, revealed and swapped with the column's other passes; the pass-3 reservation 16,384 vertices (Spec correction 7: resized in Task 40); R1 row `xray: { max: 0, activeFrom: 'SP6a' }` (missing + extra X-ray faces against `bruteXrayFaces` over R1's regions).

- [ ] **Step 1: Write the tests.**
  - payload: a column with a cave yields pass-3 rows and `payloadProblem` accepts them; pass 4 is refused (`meshPayload.test.ts:62-63` as listed); the rows' spheres bound their vertices; a column with rows in all four passes of all 24 sections keeps all 96 rows.
  - `meshFaceCounts`: on a column with film rows, R1's and R2's counts equal those of the same payload without its pass-3 rows; the X-ray face list decodes `PACK_LAYOUT.xray.face`.
  - protocol: a mesh result with pass-3 rows passes the guard and rebuilds equal.
  - `regionGrid.test.ts` (Review Focus 1): "a revealed column staged again with rows in passes 0-3: until its last row uploads `prev`'s four passes show and the new ones are hidden; the pump that uploads the last swaps all four passes in one call; a replacement with no pass-3 row hides `prev`'s pass-3 rows in that swap; `setXray(true)` and `setXrayBand(-40, -9)` between the two pumps change uniforms only (no `stage`, `unstage` or `remove`; the staged count unchanged)"; `addStandIns` adds a pass-3 stand-in when the region set has none, so the X-ray material compiles behind the loading screen (`renderer.ts:325-343`).
  - `regionBatch.test.ts`, `regionMesh.test.ts`: a pass-3 object exists per region with rows; `sortObjects` false on it, true on the others; RegionMesh's translucent ordering never touches it; its `renderOrder` is `XRAY_ORDER` (above every water region's, below `GHOST_ORDER`); `regionBatch.test.ts`: a column whose pass-3 rows exceed the reservation makes `columnNeed` return `'grow'` or `'optimize'`.
  - R1's `xray` part 0 on fast; R1's other parts, R2 and R4 unchanged on fast.
  - SP6a describe: §4.5's pass list contains `the X-ray pass (SP6a): cave walls and the surface film, additive, drawn alone while the X-ray is on` and the draw calls `+1 per region with X-ray rows (SP6a)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/meshColumn.test.ts test/unit/meshPayload.test.ts test/unit/worldProtocol.test.ts test/unit/regionGrid.test.ts test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts test/unit/regionHarness.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the row; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 19: R1 xray max 0 (X-ray faces missing + extra against a brute force over hollow voxels), gated from SP6a on every tier (spec §10.4; new part, holds by construction).`
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(render): the X-ray pass through the payload, the protocol, both renderers and the staging; R1.xray` (`git add src/mesh/column.ts src/workers/protocol.ts src/render/regionBatch.ts src/render/regionMesh.ts src/render/regionGrid.ts test/metrics/render.metric.ts test/harness/refs.ts test/thresholds.ts test/thresholds.lock.json test/unit/meshColumn.test.ts test/unit/meshPayload.test.ts test/unit/worldProtocol.test.ts test/unit/regionGrid.test.ts test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts test/unit/regionHarness.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 20: Keys: five `view` actions, labels, help and tip

**Files:**
- Modify: `src/player/keymap.ts` (`Action` `:12-18`; `DEFAULT_KEYMAP` after `lower` `:96`; `CODE_LABELS` `:178-194`), `src/ui/loading/tips.ts:18-34` (one template), `test/tools/uiSmoke.ts:846` (`SMOKE_KEYS` gains `xray`, `xrayDown`, `xrayAll`, `nightVision`), `test/unit/uiSmoke.test.ts` (its pin), master §5.9 (§13 item 15), `test/arch/masterSpec.test.ts`, the SP6a spec (Spec correction 9)
- Test: `test/unit/keymap.test.ts:51`, `test/unit/tips.test.ts:13`, `test/unit/input.test.ts`, `test/unit/help.test.ts`

**Interfaces:**
- Produces: `Action` gains `'xray' | 'xrayDown' | 'xrayUp' | 'xrayAll' | 'nightVision'`; entries (each `group: 'view'`, `since: 'SP6a'`): `xray` `[code('KeyX', false)]` "X-ray on or off"; `xrayDown` `[code('PageDown', false)]` "Move the X-ray band down"; `xrayUp` `[code('PageUp', false)]` "Move the X-ray band up"; `xrayAll` `[code('Home', false)]` "Show every depth in the X-ray"; `nightVision` `[code('KeyL', false)]` "Night vision on or off" (Spec correction 9); `CODE_LABELS` gains `PageUp: 'Page Up'`, `PageDown: 'Page Down'`, `Home: 'Home'` **(plan)**; the tip "{xray} shows the caves through the rock; {xrayDown} and {xrayUp} move the depth band, {xrayAll} shows every depth; {nightVision} is night vision."

- [ ] **Step 1: Write the tests.** `keymap.test.ts:51` 43 entries; no new binding shares a code with another context-free binding (`overlaps`, `:35-40`); Ctrl+X still resolves `cut` and plain X `xray`; `input.test.ts`: `{code: 'PageDown', ctrlKey: true}`, `{code: 'PageUp', ctrlKey: true}`, `{code: 'Home', ctrlKey: true}` and `{code: 'KeyL', ctrlKey: true}` resolve nothing and are not prevented; the plain forms resolve their actions and are prevented; `tips.test.ts:13` 43 and every action named; the help's View table lists the five with their labels; `uiSmoke.test.ts` pins `SMOKE_KEYS`' new codes against the key map.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/keymap.test.ts test/unit/tips.test.ts test/unit/input.test.ts test/unit/help.test.ts test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §5.9 gains "X (X-ray; SP6a); PageUp / PageDown / Home (the X-ray band; SP6a); L (night vision; SP6a);" with its pin.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (the page's `onAction` ignores the five until Tasks 21 and 23).
- [ ] **Step 5: Commit** `feat(keys): X, PageUp, PageDown, Home and L as view actions (SP6a §7.1)` (`git add src/player/keymap.ts src/ui/loading/tips.ts test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts test/unit/keymap.test.ts test/unit/tips.test.ts test/unit/input.test.ts test/unit/help.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 21: The X-ray IV: the page, the band, the strip, the HUD, the notices

**Files:**
- Create: `src/ui/world/xrayStrip.ts`, `test/unit/xrayStrip.test.ts`
- Modify: `src/ui/world/worldPage.ts` (`onAction` `:5076-5136` gains `xray`, `xrayDown`, `xrayUp`, `xrayAll`; the strip element `#world-xray-strip` beside the build HUD; the first-press notice; the renderer calls), `src/ui/hud.ts:124-127` (the X-ray line while on, as "stale"), `test/unit/zeroAlloc.test.ts` (the X-ray at rest), master §1's `ui/world/*` entry (§13 item 8), `test/arch/masterSpec.test.ts`
- Test: `test/unit/worldPage.test.ts`, `test/unit/hud.test.ts`

**Interfaces:**
- Consumes: Task 18's `setXray`, `setXrayBand`; Task 20's actions; `WorldNotices.show` (`worldPage.ts:632`).
- Produces (`xrayStrip.ts`):
  - `export interface XrayBand { readonly all: boolean; readonly yMin: number; readonly yMax: number }`; `export const XRAY_ALL: XrayBand` (−64 … 319, all);
  - `export function bandStep(b: XrayBand, dir: -1 | 1, cameraY: number): XrayBand` **(plan)**: from all, the 32-block band centred on ⌊cameraY⌋ (`[c − 16, c + 15]`), whatever `dir`; otherwise the band moved 8 by `dir`; either way its low end clamped to −64 … 288, so it keeps 32 blocks inside −64 … 319;
  - `export function bandSet(yMin: number, yMax: number): XrayBand` (the sliders; lowest ≤ highest kept by the caller);
  - `export function stripText(b: XrayBand): string` → `X-ray · y −64 … 319 · by cave type` (the minus sign U+2212, as the spec writes it);
  - `export function createXrayStrip(host: HTMLElement): { set(on: boolean, b: XrayBand): void; dispose(): void }` (text and legend through `textContent`; set only on change).
- The notice at the first X in a page: "X-ray: PageDown and PageUp move the depth band, Home shows every depth" (6 s; key names from the key map's labels).

- [ ] **Step 1: Write the tests.**
  - `xrayStrip.test.ts` (Review Focus 3): "from all with the camera at y 400, PageDown gives [288, 319]; at y −80 it gives [−64, −33]; ten PageDowns from [−40, −9] end at [−64, −33] (32 blocks); ten PageUps from [216, 247] end at [288, 319] (clamped, 32 blocks); Home gives all and the strip reads `X-ray · y −64 … 319 · by cave type`"; the strip of [−40, −9] reads `X-ray · y −40 … −9 · by cave type`; the legend lists the nine kinds and the surface.
  - `worldPage.test.ts`: X toggles `setXray`, the strip and the HUD line; the first X shows the notice once per page; PageDown with the X-ray off still moves the band (shown at the next X) **(plan)**; keys act only while the world owns the controls (`:5181-5182`); Review Focus 1's case: "X on, an Apply of `caves.cheese.offset` 0.27 → 0.20 settling over 30 fake frames with PageDown at frame 5 and X twice at frames 10 and 11: the strip reads the moved band, `xrayOn` is 1 at the end, every column's shown seq is the Apply's, the stale count reaches 0".
  - `zeroAlloc.test.ts`: "N frame steps at rest with the X-ray on at a fixed band grow the heap by less than the boxing budget of 256 B per tick (SP6a §5.3)"; "N toggles of X at a fixed band grow the heap by less than 256 KB" (spec §5.3 asks it of a toggle; a band step returns a new `XrayBand` and sets the strip's text, so it is not in the zero-allocation case).
  - SP6a describe: §1's `ui/world/*` entry gains `xrayStrip.ts (SP6a)`; `SP6A_MODULES` row.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/xrayStrip.test.ts test/unit/worldPage.test.ts test/unit/hud.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(world): the X-ray on X with its depth band, strip, HUD line and notice` (`git add src/ui/world/xrayStrip.ts src/ui/world/worldPage.ts src/ui/hud.ts test/unit/xrayStrip.test.ts test/unit/worldPage.test.ts test/unit/hud.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 22: The light floor

**Files:**
- Modify: `src/render/lightmap.ts` (`LIGHT_FLOOR = 0.02`; `lightmapRgba` `:41-57`: after the per-channel max, before the lift, `c′ = F + (1 − F)·c`; the doc comment `:36-40` replacing "(0, 0) stays 0 for every β"), master §4.8 and §6.3 (§13 item 14), `test/arch/masterSpec.test.ts`
- Test: `test/unit/lightmap.test.ts` (`:30-36` replaced; `:38-43` kept)

**Interfaces:**
- Produces: `LIGHT_FLOOR` (render, not exported from gen); every texel lifted; (15, 15) stays 255; stored light, the light jobs and every L metric untouched; the ghost keeps its own floor (`terrain.glsl.ts:122`); the X-ray reads no lightmap.

- [ ] **Step 1: Write the tests** (`lightmap.test.ts`): the (0, 0) texel's byte is 5 at β 0, 10 at β 0.3, 20 at β 1 (§6.1); (0, 0) luminance > 0 and ≤ 0.3 × the midnight sky-15 texel's luminance (t of day factor 0) at β 0, 0.3 and 1 (replacing `:30-36`'s ≤ 0.02·255); every block-only texel independent of t (`:38-43`, kept); noon (15, 15) is [255, 255, 255]; every level stays distinct along both axes (strictly increasing luminance at β 0). SP6a describe: §4.8 contains `a light floor F = 0.02 lifting every texel before the brightness (SP6a)`; §6.3 contains `(0,0) = the light floor: > 0 and ≤ 0.3 × the midnight sky-15 texel's luminance at every β, with night vision off (SP6a)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/lightmap.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS; no golden diff; L1, L2, L3, DT1.light unchanged on fast.
- [ ] **Step 5: Commit** `feat(render): a light floor of 0.02 in the lightmap (SP6a D14)` (`git add src/render/lightmap.ts test/unit/lightmap.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 23: Night vision

**Files:**
- Modify:
  - `src/render/lightmap.ts` (`lightmapRgba(day, dusk, brightness, out, nightVision = 0)`; `createLightmap().update(day, dusk, brightness, nightVision)` with `nightVision` in the rebuild rule `:81-90`);
  - `src/render/frameState.ts:7-18` (`nightVision: number`, required, so every frame writes it) and the `FrameState` literals that `typecheck` (with `tsconfig.test.json`) then refuses without it, each gaining `nightVision: 0`: `src/render/renderer.ts:566`, `src/render/spike/spikeBench.ts:134`, `test/unit/materials.test.ts:27`, `test/unit/mapOverlay.test.ts:157`, `test/unit/frameStep.test.ts:55` (against `src/ui/world/frameStep.ts:89`'s `state` type, which gains `nightVision: number`);
  - `src/render/materials/index.ts:157` (passes it);
  - `src/ui/settings.ts` (`WorldSettings.nightVision: boolean`; `SETTINGS_DEFAULTS` `nightVision: false`; `normalizeSettings` `:51-68`);
  - `src/ui/settingsPanel.ts` (Graphics: "Night vision (L)" after Brightness `:173`, `#setting-night-vision`; **(plan)** `setNightVision(on: boolean)` beside `setRd` `:38-43`, so the checkbox follows L);
  - `src/ui/world/worldPage.ts` (`onAction`'s `nightVision`: flip, save, notice "Night vision on" / "Night vision off" 1.5 s; the frame's eased value);
  - `src/ui/world/frameStep.ts` (**(plan)** the ease: `NIGHT_VISION_EASE_S = 0.3`, linear toward the setting, clamped to [0, 1]);
  - `test/unit/zeroAlloc.test.ts`;
  - master §4.8's night-vision half and §4.16 (§13 items 14, 15);
  - `test/arch/masterSpec.test.ts`
- Create: `test/unit/nightVision.test.ts`
- Test: `test/unit/lightmap.test.ts`, `test/unit/settings.test.ts`, `test/unit/settingsPanel.test.ts`, `test/unit/worldPage.test.ts`

**Interfaces:**
- Produces: `c″ = mix(c′, c′ / max(c′.r, c′.g, c′.b), nv)` after the floor and the lift; `FrameState.nightVision ∈ [0, 1]`; the lightmap rebuilds every frame during the ease only; no worker message; the fog follows (its colour reads `lightmapAt(0, eyeSky)`, `common.glsl.ts:74`).

- [ ] **Step 1: Write the tests** (Review Focus 4).
  - `lightmap.test.ts`: at nv 1 every texel's brightest channel is 255 at t 0.75 and t 0.25 at β 0, 0.3 and 1; nv 0 after nv 1 restores the exact bytes; at nv 0 the bytes equal Task 22's.
  - `nightVision.test.ts`: the eased value is 0, 0.5 and 1 at 0, 0.15 and 0.3 s after L and back to 0 0.3 s after the second L; the lightmap rebuilds on each eased frame and on no frame after; a Brightness change mid-ease rebuilds once more; the fog's colour input `lightmapAt(0, 0)` at nv 1 has its max channel 255.
  - `settings.test.ts`: a stored settings object without `nightVision` normalises to false; true survives a round trip; `settingsPanel.test.ts`: the checkbox after Brightness and `setNightVision` sets it without firing `onSettings`.
  - `worldPage.test.ts`: "L toggled twice posts no worker message and leaves `litHash` of the loaded columns unchanged"; L shows the 1.5 s notice and saves the setting; the checkbox follows.
  - `zeroAlloc.test.ts`: "N frame steps at rest with night vision on after its ease grow the heap by less than the boxing budget of 256 B per tick".
  - SP6a describe: §4.8 contains `night vision normalising each texel to its brightest channel, eased over 0.3 s (SP6a)`; §4.16's overridable settings contain `night vision (SP6a)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/lightmap.test.ts test/unit/nightVision.test.ts test/unit/settings.test.ts test/unit/settingsPanel.test.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(world): night vision on L and in Settings, eased over 0.3 s (SP6a D15)` (`git add src/render/lightmap.ts src/render/frameState.ts src/render/renderer.ts src/render/spike/spikeBench.ts test/unit/materials.test.ts test/unit/mapOverlay.test.ts test/unit/frameStep.test.ts src/render/materials/index.ts src/ui/settings.ts src/ui/settingsPanel.ts src/ui/world/worldPage.ts src/ui/world/frameStep.ts test/unit/nightVision.test.ts test/unit/lightmap.test.ts test/unit/settings.test.ts test/unit/settingsPanel.test.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 24: Carvers I: sources and worm paths (rooms, branches)

Tasks 24-39 are push B (base: push A's head, recorded in Task 16). Tasks 24-26 add pure functions no stage calls yet (no golden diff against their predecessor); Task 27 is push B's first output-changing commit.

**Files:**
- Create: `src/gen/caves/carvers.ts`, `test/unit/carverPaths.test.ts`, `test/harness/carverParams.ts` (the spec §4 defaults and the leaves' static maxima as `CarverParams` literals, for the tests until Task 27's leaves; pinned equal to `carverParamsOf(DEFAULTS)` there)
- Modify: `.github/scripts/unitShards.mjs` (`carverPaths` into `heavy`), `test/unit/shards.test.ts`, `test/arch/masterSpec.test.ts` (`SP6A_MODULES` row `[/^\s+caves\/carvers\.ts /, 'carvers.ts', 'src/gen/caves/carvers.ts']`, Task 11's head), `test/arch/rules/banned.ts` (no change: `gen/` is scanned by layer; the test asserts it), the SP6a spec (Spec correction 17)
- Test: `test/unit/carverPaths.test.ts`

**Interfaces:**
- Consumes: `Xoshiro128` (`src/core/rng.ts:17-66`), `hash2`, `deriveSeed` (`src/core/hash.ts:28-36`, `:262`), `detSin`, `detCos` (`src/core/detMath.ts:21-85`), the seed type of `GenContext`.
- Produces:
  - `export type CarverKind = 'worm' | 'ravine' | 'undergroundWorm'`;
  - `export interface WormShape { readonly pitchKeep: number; readonly yawStep: number; readonly pitchStep: number; readonly yawDriftKeep: number; readonly yawDriftMul: number; readonly pitchDriftKeep: number; readonly pitchDriftMul: number }` (defaults 0.7, 0.1, 0.1, 0.75, 4, 0.9, 2: §2.2's drift);
  - `export interface CarverParams` with `worms` {chance 0.15, length 112, lengthVar 28, radiusMin 0.7, radiusMax 1.4, vRatioMin 0.8, vRatioMax 1.3, floorMin −1, floorMax −0.4, branchChance 0.25, roomChance 0.25, roomYScaleMin 0.1, roomYScaleMax 0.9, startYMin −56, startYMax 180, shape}, `undergroundWorms` {chance 0.07, startYMin −56, startYMax 24, maxY 40}, `ravines` {chance 0.015, lengthMin 84, lengthMax 112, thicknessMax 6, plateau 2, yScale 3, widthSmoothness 3, vRotation 0.125, startYMin 10, startYMax 72}, `limits` {waterDepth, bandSpan, capTop} (spec §4's values and ranges);
  - `export interface CarverPath { readonly kind: CarverKind; readonly sx: number; readonly sz: number; readonly count: number; readonly ell: Float64Array /* 6 per ellipsoid: x, y, z, rh, rv, floor */; readonly box: Float64Array /* minX, minY, minZ, maxX, maxY, maxZ: the voxel reach, the centres widened by the largest effective radius */; readonly widthSq: Float64Array | null /* ravines: f² per world y, 384 */ }`;
  - `export function carverPath(seed: GenContext['seed'], kind: CarverKind, sx: number, sz: number, p: CarverParams): CarverPath | null` (the roll, then the path; this task: worms and underground worms' path shape; Task 25: ravines and the underground worm's start range).
- **Draw order** **(plan)** (spec §2.1-§2.2 fix the formulas; this pins the order, which the golden `sp6a.carver.paths` then freezes):
  1. `rng = new Xoshiro128(hash2(deriveSeed(seed, 'caves.' + kind), sx, sz))`; `u < chance`, else null;
  2. the start: x `16·sx + 16·u`, z `16·sz + 16·u`, y `startYMin + (startYMax − startYMin)·u`; yaw `2π·u`; pitch `(u − 0.5)/4`;
  3. the size: n `max(1, length − ⌊lengthVar·u⌋)`; t `2·u + u`; hMul `radiusMin + (radiusMax − radiusMin)·u`; vMul `vRatioMin + (vRatioMax − vRatioMin)·u`; floor `floorMin + (floorMax − floorMin)·u`;
  4. the room roll `u < roomChance`; a room draws its radius `(1 + 6·u)·hMul` and yScale `roomYScaleMin + (roomYScaleMax − roomYScaleMin)·u`, and is the path's first ellipsoid (rh that radius, rv rh·yScale, the worm's floor);
  5. the branch roll `u < branchChance` (it acts only when t > 1);
  6. per step i < n: the ellipsoid `(x, y, z, rh, rv, floor)` with `rh = (1.5 + detSin(π·i/n)·t)·hMul`, `rv = (1.5 + detSin(π·i/n)·t)·vMul`; then the move `x += detCos(p)·detCos(yaw)`, `y += detSin(p)`, `z += detCos(p)·detSin(yaw)`; `p ·= pitchKeep`; `yaw += yawStep·yd`; `p += pitchStep·pd`; `yd = yawDriftKeep·yd + (u − u)·u·yawDriftMul`; `pd = pitchDriftKeep·pd + (u − u)·u·pitchDriftMul` (yd and pd start at 0; the three draws of each in that order);
  7. a branch: at step ⌊n/2⌋ the trunk ends; two branches start at its last centre with yaw + π/2 then yaw − π/2, each drawing its thickness `0.5 + 0.5·u` and running n − ⌊n/2⌋ steps of rule 6 from the same stream, appended to `ell` after the trunk (the trunk's end lies inside the branches' starts, so it is not a visible end); each branch continues i from ⌊n/2⌋ to n − 1 with the same n (rh = (1.5 + detSin(π·i/n)·t_b)·hMul, rv likewise with vMul, t_b its drawn thickness), its pitch, yd and pd starting from the trunk's values at the fork; the first branch's draws and ellipsoids all precede the second's.

- [ ] **Step 1: Write the tests** (`carverPaths.test.ts`, `unit (heavy)`):
  - purity: 64 fixed sources per kind give byte-identical `ell`, `box` and `widthSq` across two calls and in reversed call order;
  - n ≥ 1 for every combination of `length` and `lengthVar` at their static ends (32 … 160, 0 … 64; `lengthVar` ≥ `length` gives 1 step);
  - the end taper (`C7.endTaper`'s rule, §10.1, Spec correction 17): over 10,000 sources per kind, no path end (branch points and the start room excluded; the start end is measured from the first step ellipsoid after the room) whose last ellipsoid is larger than any of the 4 before it or whose radius exceeds the path's median;
  - the branch with `branchChance` 1 and t > 1: the trunk holds ⌊n/2⌋ + 1 ellipsoids (the room excluded), two branches start at its last centre with yaw ± π/2 and n − ⌊n/2⌋ steps, their i running ⌊n/2⌋ … n − 1 (no pinch at the fork: each branch's first rh is (1.5 + detSin(π·⌊n/2⌋/n)·t_b)·hMul) and their pitch the trunk's at the fork; t ≤ 1 never branches;
  - the room with `roomChance` 1: the first ellipsoid's rh in [hMul, 7·hMul) and rv = rh·yScale with yScale in [0.1, 0.9];
  - the starts' χ² of (x mod 16, z mod 16) over 100,000 sources is p ≥ 0.01 (§10.1's note);
  - no `Math.sin`, `Math.cos` or `**` in the file (the arch rule; asserted by `npm test`'s arch project).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/carverPaths.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(caves): carver sources and worm paths with rooms and branches (SP6a §2.1-§2.2)` (`git add src/gen/caves/carvers.ts test/unit/carverPaths.test.ts test/harness/carverParams.ts .github/scripts/unitShards.mjs test/unit/shards.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 25: Carvers II: ravine paths and the underground worm; the window R

**Files:**
- Modify: `src/gen/caves/carvers.ts`, `src/core/constants.ts` (`CARVER_WINDOW_R = 11`; Spec correction 2), `test/harness/carverParams.ts`
- Test: `test/unit/carverPaths.test.ts`, `test/unit/constants.test.ts`

**Interfaces:**
- Produces:
  - ravines (§2.3; draw order after the roll **(plan)**): start x, z as worms, y `startYMin + (startYMax − startYMin)·u` (10 … 72); yaw `2π·u`; pitch `(u − 0.5)·2·vRotation`; t from the trapezoid on [0, thicknessMax] with plateau `plateau`: `t = u·(thicknessMax − g) + u·g`, g = (thicknessMax − min(plateau, thicknessMax))/2 **(plan)** (so t ∈ [0, thicknessMax] for every `plateau` in its range, Task 27's 0 … 8) (Minecraft's trapezoid: at the defaults 0 … 6, flat over 2 … 4); n `lengthMin + ⌊(max(lengthMin, lengthMax) − lengthMin + 1)·u⌋` (84 … 112); then the 384 width factors, one draw pair per `widthSmoothness` rows from y −64 (`f = 1 + u·u`, stored as f² on each of those rows) **(plan)** (spec: "redrawn every 3 blocks"); then per step `rh = 1.5 + detSin(π·i/n)·t`, `rv = rh·yScale`, floor −1 (none), the move and the drift as worms with the `caves.worms.shape` leaves **(plan)** (spec §2.3: "start as worms"; no ravine drift leaves);
  - underground worms: the worm path with `undergroundWorms.chance` and start range (−56 … 24), every other leaf the worms'; their shrink is Task 26's σ_u;
  - `CARVER_WINDOW_R = 11`: the largest R with 16·R < 16 + L_max + r_max, L_max = 160 (`worms.length`'s and `ravines.lengthMax`' static maximum) and r_max = 9.5 (max of (1.5 + 3)·2.0 for worms, 1.5 + 8 for ravines; the room's 14 sits at the start).

- [ ] **Step 1: Write the tests.** Ravines: n in [84, 112] over 10,000 sources; with `lengthMin` > `lengthMax` n is `lengthMin`; `widthSq` holds f² ∈ [1, 4], constant over each run of 3 rows; every rh ≤ 1.5 + thicknessMax, with `plateau` at its static maximum (8) as well as its default; both ends taper (the end-taper rule above); underground worms start in [−56, 24]. `constants.test.ts`: `CARVER_WINDOW_R` recomputed from `test/harness/carverParams.ts`' static maxima is 11 (16·11 < 185.5 < 16·12). `reachOverflow` (§10.1, the unit form on 10,000 sources per kind): at the defaults and with every carver leaf at its static maximum (`plateau`, `vRotation` and `worms.shape.*` included, with Task 27's ranges mirrored in `carverParams.ts`), every path's `box` lies inside the chunks within R of its source chunk.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/carverPaths.test.ts test/unit/constants.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff). Expected: PASS.
- [ ] **Step 5: Commit** `feat(caves): ravine and underground-worm paths; the carver window R = 11 (SP6a §2.1, §2.3)` (`git add src/gen/caves/carvers.ts src/core/constants.ts test/harness/carverParams.ts test/unit/carverPaths.test.ts test/unit/constants.test.ts`).

---

### Task 26: Carvers III: the path cache and `carveColumn`

**Files:**
- Create: `src/gen/caves/carverCache.ts`, `src/gen/caves/carve.ts`, `test/unit/carve.test.ts`
- Modify: `src/core/constants.ts` (`CARVER_CACHE_PATHS = 1024`; Spec correction 2), `test/arch/masterSpec.test.ts` (`SP6A_MODULES` rows `[/^\s+caves\/carvers\.ts /, 'carverCache.ts', 'src/gen/caves/carverCache.ts']` and `[…, 'carve.ts', 'src/gen/caves/carve.ts']`, Task 11's head), the SP6a spec (Spec correction 18)
- Test: `test/unit/carve.test.ts`, `test/unit/constants.test.ts`

**Interfaces:**
- Consumes: Tasks 24-25; `surfaceContextOf`'s WeakMap pattern (`src/gen/surface/context.ts:115-119`); `readField` for the `col` fields.
- Produces:
  - `export interface CarverCache { path(kind: CarverKind, sx: number, sz: number): CarverPath | null; readonly size: number }`; `export function createCarverCache(ctx: GenContext, p: CarverParams, capacity: number): CarverCache` (`carverCacheOf(ctx)`, which needs `carverParamsOf` and the carver leaves, is Task 27's); **(plan)** a numeric key `(kindIndex·2^21 + (sx + 2^20))·2^21 + (sz + 2^20)`, LRU by a `Map`'s insertion order (delete and set on a hit, no allocation), null results not cached (a roll costs about 50 ns);
  - `export function carveColumn(cache: CarverCache, p: CarverParams, s: ColumnSample, cx: number, cz: number, solid: Uint8Array, densityTop: Int16Array, tags: Uint8Array | null): void` (no `stop`: the stage polls once before calling it, Task 27, so the poll sequence `terrainStage.test.ts:425` pins stays exact; `solid` and `tags` in `fillDensityColumn`'s index; `densityTop[lz·16 + lx]` the column's **density top** (Spec correction 18): the highest solid y after the density fill, before carving, −65 when none; with `islands.enabled`, the top of the highest solid run whose bottom lies below `ISLAND_RUN_MIN_BOTTOM`, water v0's BASE rule (`terrainStage.ts:113-134`), so σ_w sees the ground under an island over the sea; never voxel y −64, which stays bedrock);
  - `export function densityTopOf(solid: Uint8Array, islands: boolean, lx: number, lz: number): number` **(plan)** (that rule over a filled column, shared by T, `carvedAt` and `referenceCarve`);
  - `export function carvedKind(cache: CarverCache, p: CarverParams, s: ColumnSample, x: number, y: number, z: number, densityTopAt: () => number): number` (the kind that carves the voxel, 0 when none; `densityTopAt` is called only when some ellipsoid covers the voxel and wet′ > 0) **(plan)**;
  - **the window's order** **(plan)**: sources sz from cz − R to cz + R, then sx likewise, then kinds `worm`, `ravine`, `undergroundWorm`; per path its ellipsoids in index order; the first carving source keeps its kind (a later one never overwrites `tags`).
- **The carve loop** (sketch; spec §2.4's order):
  ```
  for each source in the window's order, path = cache.path(kind, sx, sz); skip null or a box missing the column box
    for each ellipsoid e of path whose box meets the column box:
      for each voxel (x, y, z) in both boxes with solid[v] === 1:
        dx = (x + 0.5 − cx)/rh; dz = (z + 0.5 − cz)/rh; dy = (y + 0.5 − cy)/rv
        d = dx·dx·w(y) + dz·dz·w(y) + dy·dy          // w = 1, or the ravine's widthSq[y + 64]; this order
        σ = max(σ_w, σ_i, σ_u)                        // each in [0, 1]
        if d < 1 − σ and (kind is a ravine or dy > floor) and y > −64: solid[v] = 0; tags?.[v] ||= KIND
  ```
  with `σ_w = wet′(x, z)·clamp((waterDepth + 8 + bandSpan − (densityTop − y))·(1/(8 + bandSpan)), 0, 1)`, `σ_i = clamp((y − capTop + 8 + bandSpan)·(1/bandSpan), 0, 1)`, `σ_u = clamp((y − maxY_u + 16)·(1/16), 0, 1)` (underground worms only); `wet′(x, z)` from the column sample's bilinear `lakeMask`, `riverStrength` and `offset` at the voxel's position with Task 9's formula (its constants mirrored in `carve.ts`, pinned against the tree). Only solid voxels are carved; the `CARVABLE` check stays in the loop for SP9 (every state T has there is carvable, `src/world/blocks/registry.ts:223`, `:260`).

- [ ] **Step 1: Write the tests** (`carve.test.ts`):
  - bit-identity across chunk borders: one ellipsoid straddling the border of columns (0, 0) and (1, 0) carves, in the two columns, exactly the voxels a carve of a 32 × 16 box computes;
  - the LRU's purity: capacities 1 and 1,024, cold and warm (from another region), give byte-identical `solid` and `tags` on 16 columns;
  - the shrinks: with wet′ = 1 no voxel within 16 blocks of the density top is carved, and the threshold 1 − σ_w rises linearly from 0 at 16 to 1 at 40 blocks below the density top (checked on σ_w directly), the carve rate rising monotonically over that span (an ellipsoid's carved volume scales as (1 − σ)^{3/2}, so the rate is not linear); at `capTop` 180 nothing at y ≥ 172 is carved; an underground worm carves nothing at y ≥ 40 and at full size below 24; nothing is carved at y −64;
  - under a floating_islands island over the sea (`islands.enabled`), `densityTopOf` is the sea bed's top, not the island's, and nothing is carved within 16 blocks of the bed (Spec correction 18);
  - the order: a voxel two sources carve is tagged with the first in the window's order;
  - wet′ in `carve.ts` equals the tree's wet′ subtree (Task 9, through the reference) bit for bit at 10,000 positions;
  - `carvedKind` equals `carveColumn`'s `tags` on every voxel of 8 columns;
  - `constants.test.ts`: `CARVER_CACHE_PATHS` 1024.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/carve.test.ts test/unit/constants.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the `SP6A_MODULES` rows.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check (no diff: no stage calls it yet). Expected: PASS.
- [ ] **Step 5: Commit** `feat(caves): the carver path cache and carveColumn with its wet, island and underground shrinks` (`git add src/gen/caves/carverCache.ts src/gen/caves/carve.ts src/core/constants.ts test/unit/carve.test.ts test/unit/constants.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 27: Carvers IV: the carve step in T, the carver leaves, the carver kinds (GENERATOR_VERSION 7)

**Files:**
- Modify:
  - `src/core/params/schema.ts` (`caves.worms.*` with `caves.worms.shape.*`, `caves.undergroundWorms.*`, `caves.ravines.*`: spec §4's leaves, defaults and ranges; `branchChance`, `roomChance` 0 … 1, `roomYScaleMin`/`Max` 0.1 … 0.9, `startYMin`/`Max` −64 … 320, `ravines.plateau` 0 … 8, `ravines.vRotation` 0 … 0.5, `worms.shape.*` each 0 … 8 **(plan)** where §4 gives no range);
  - `src/gen/caves/carvers.ts` (`carverParamsOf(p: Params): CarverParams`);
  - `src/gen/caves/carverCache.ts` (`export function carverCacheOf(ctx: GenContext): CarverCache`: one per GenContext, memoised in a WeakMap as `surfaceContextOf`, built from `carverParamsOf(ctx.params)` with capacity `CARVER_CACHE_PATHS`, dropped with the context on `configure`);
  - `src/gen/pipeline/terrainStage.ts` (after the fill `:144`: the density top (`densityTopOf`, Task 26), one `stop()` poll, `carveColumn` writing `TAG` (it does not poll), then `tagColumn` skipping voxels the carve tagged, then water v0 `:145`);
  - `src/gen/caves/tags.ts` (step 4 in `tagVoxel`'s callers; `caveTagAt`'s step 4 through `carvedAt`);
  - the probes, in this commit because T carves here: DT2's `probeBulk` and `surfaceProbeBulk` compare the probes with the stored block (`test/harness/dt2.ts:196-204`) and `tagProbe` (Task 12, gated) the stored tag with `caveTagAt`, all three max 0 in `npm test`'s metrics-fast: `src/gen/caves/carve.ts` (`export function carvedAt(dc: DensityContext, x: number, y: number, z: number): number`: the carving kind, 0 none, through `carvedKind` with `carverCacheOf(dc.ctx)`; the density top by a downward scan of the density probe with `densityTopOf`'s island rule, only when needed), `src/gen/density/probe.ts` (`solidAt` = density > 0 ∧ `carvedAt` = 0), `src/gen/surface/probe.ts:37-59` (`surfaceProbeColumn` carves through `carveColumn` before its surface pass), `test/harness/dt2.ts:196-199` (`probeBulk` compares `solidAt`, not `probe > 0`, with the block);
  - `test/harness/carverParams.ts` (the leaves' static maxima, the new ranges included);
  - U4's `test/fixtures/expected-v1.json`, `expected-v2.json` (regenerated); master §6.4's U2 row and the SP6a describe's count (Spec correction 12); the key-list pins of Task 3 (61 keys);
  - `src/metrics/liveness.ts` (the carver leaves: the `cave` class column first, then a bounded witness search over 64 columns for `chance`, `branchChance`, `roomChance` **(plan)**, `params.metric.ts:43`);
  - `src/metrics/sp6aGoldens.ts` (`sp6a.carver.paths`);
  - `src/core/constants.ts:2` (`GENERATOR_VERSION` 7);
  - `README.md`;
  - `test/schema-shape.lock.json`;
  - `test/goldens.json`;
  - `test/unit/terrainStage.test.ts:420`;
  - `test/unit/decorateStage.test.ts:218` (re-pinned if it moves);
  - master §3.8 (§13 item 12);
  - `test/arch/masterSpec.test.ts`
- Test: `test/unit/terrainStage.test.ts`, `test/unit/caveTags.test.ts`, `test/unit/liveness.test.ts` (`:465-467`'s count), `test/unit/densitySource.test.ts` (`:34-40`'s list gains the carver targets), `test/unit/goldens.sp6a.test.ts`, `test/unit/carverPaths.test.ts`, `test/unit/carve.test.ts`, `test/unit/surfaceProbe.test.ts`, the key-list pins (`goldens.sp2a`, `sp3a`, `sp3b`, `sp3c`, `sp3e`)

**Interfaces:**
- Consumes: Task 26's `carveColumn`, `createCarverCache`, `densityTopOf`; Task 11's tag pass.
- Produces: T's order (§3.1): density fill → density top → poll → carve (`TAG` gets the carver kinds) → tag (density air; carved voxels skipped) → water v0 → surface biomes → surface pass → sections → aux; `carverParamsOf(DEFAULTS)` deep-equals `test/harness/carverParams.ts`' defaults; `sp6a.carver.paths` = the digest of the paths of 64 fixed sources per kind at seed 42 and the defaults (the first 64 per kind whose roll passes, scanning a spiral from (0, 0) **(plan)**).

- [ ] **Step 1: Write the tests.**
  - `terrainStage.test.ts:420`: "7 density polls: 6 in the fill, 1 before the carve; 1 before the surface pass; then sections 0 … 23 …" (the poll count +1 and its order); a column holding a worm has its carved voxels air, tagged 6, and its ravine floor open to the sky skinned with the biome's top (the scan's sky run); a cave floor under a ceiling gets stone or deepslate and never grass (D6).
  - `caveTags.test.ts`: the tagged set equals (pre-cave solid ∧ air) on every voxel of 64 columns, carved voxels included (step 4); `caveTagAt` and `solidAt` equal the stage on every voxel of 8 columns, carved voxels included.
  - `surfaceProbe.test.ts`: the probe's rebuilt column equals the stage's proto blocks on 8 columns with carvers.
  - `carve.test.ts`: `carverCacheOf(ctx)` is one cache per GenContext with `carverParamsOf(ctx.params)` and capacity 1,024, a new one after `configure`; `carvedAt` equals the stage's carve on every voxel of 8 columns, an island-over-sea column of floating_islands included.
  - `liveness.test.ts`: every carver leaf live (class column or witness).
  - `carverPaths.test.ts`: `carverParamsOf(DEFAULTS)` equals the harness defaults; the schema's static maxima equal the harness maxima (so Task 25's R holds for the leaves).
  - `goldens.sp6a.test.ts`: `sp6a.carver.paths` computes and matches.
  - the key-list pins shifted by one key (61 goldens); `densitySource.test.ts:34-40`'s list; the SP6a describe's U2 count and row; U4's fixtures.
  - SP6a describe: §3.8 contains `within R = 11 chunks (23 × 23), R derived from the leaves' maxima (SP6a)`, the rooms, the underground worm's shrink below y 40 and `Only \`CARVABLE\` blocks; carvers shrink to nothing under water and below \`caves.limits.capTop\` (from y 172 in floating_islands) (SP6a)`, `carving runs before the surface pass, which skins the carved column (SP6a)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/terrainStage.test.ts test/unit/caveTags.test.ts test/unit/liveness.test.ts test/unit/carverPaths.test.ts test/unit/carve.test.ts test/unit/surfaceProbe.test.ts test/unit/goldens.sp6a.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `npm run test:accept-schema`; `npm run docs:params`; master §3.8.
- [ ] **Step 4: Goldens (push B's first output-changing commit).** `git checkout <push A head> -- test/goldens.json && npm run test:goldens`; `git diff <push A head> -- test/goldens.json` lists `generatorVersion` 6 → 7, the allowed keys that move (`sp1.params`, the `sp3a.region.T.*` and `sp3e.region.T.*` keys, `sp3b.density.default` only if its column changes, `sp3c.surface.ops`) and the added `sp6a.carver.paths` (61 keys); nothing else.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS (DT1; DT2 `probeBulk`, `surfaceProbeBulk`, `tagProbe` and the preset parts 0 on fast with carvers, because the probes carve in this same commit; U4 `migrationFailures` 0; U2 with the carver leaves).
- [ ] **Step 6: Commit** `feat(caves): carvers in the T stage and the probes, before water and the surface pass; the carver leaves (GENERATOR_VERSION 7)` (`git add src/core/params/schema.ts src/gen/caves/carvers.ts src/gen/caves/carverCache.ts src/gen/caves/carve.ts src/gen/caves/tags.ts src/gen/density/probe.ts src/gen/surface/probe.ts src/gen/pipeline/terrainStage.ts src/metrics/liveness.ts src/metrics/sp6aGoldens.ts src/core/constants.ts README.md test/harness/dt2.ts test/harness/carverParams.ts test/schema-shape.lock.json test/goldens.json test/fixtures/expected-v1.json test/fixtures/expected-v2.json test/unit/terrainStage.test.ts test/unit/caveTags.test.ts test/unit/liveness.test.ts test/unit/densitySource.test.ts test/unit/carverPaths.test.ts test/unit/carve.test.ts test/unit/surfaceProbe.test.ts test/unit/goldens.sp6a.test.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp3c.test.ts test/unit/goldens.sp3e.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`, and `test/unit/decorateStage.test.ts` if re-pinned).

---

### Task 28: Probes II: `isolatedColumn`, the cache capacity hook; DT1 `carverCache`, `isolated`

`carvedAt`, `solidAt` and `caveTagAt` with carvers and the carving surface probe land in Task 27's commit (T carves there, and DT2's `probeBulk`, `surfaceProbeBulk` and `tagProbe`, gated at 0 in `npm test`, compare the probes with the stored blocks and tags). This task adds the determinism parts only.

**Files:**
- Modify: `src/gen/caves/carverCache.ts` (`export function setCarverCacheCapacity(n: number): void` **(plan)**: a module-level capacity, default `CARVER_CACHE_PATHS`, read by `carverCacheOf` for caches created afterwards; functions only, so `banned.ts` allows it), `test/harness/region.ts` (`GenRegionOptions` `:37` gains `carverCacheCapacity?: number`, forwarded to every `regionWorker` before it builds its GenContext and to `isolatedColumn`; `isolatedColumn`), `test/harness/regionWorker.ts` (applies the capacity), `test/metrics/region.metric.ts:62` (DT1 gains `carverCache`, `isolated`), `test/thresholds.ts`, `test/thresholds.lock.json` (generated), the SP6a spec (`## Threshold log`)
- Test: `test/unit/carve.test.ts`, `test/unit/regionHarness.test.ts`

**Interfaces:**
- Produces: `setCarverCacheCapacity`; `export async function isolatedColumn(o: { seed: string; params: Params; cx: number; cz: number; carverCacheCapacity?: number }): Promise<Hash64>` (the column generated alone on a fresh store, its `regionHash`); DT1 rows `carverCache: { max: 0, activeFrom: 'SP6a' }` (the region hash at capacities 1 and 1,024 and warm from another region, against the cold default: mismatches), `isolated: { max: 0, activeFrom: 'SP6a' }`.

- [ ] **Step 1: Write the tests.**
  - `carve.test.ts` (Review Focus 5): "a column carved by a worm from a source 10 chunks away: generated in a region, alone on a fresh store (`isolatedColumn`), and again after `carverCacheOf(ctx).path` over every window source of 2,000 columns 20,000 blocks away (no T generation, so the unit test stays within its 30 s timeout, `vitest.config.ts:15`) has filled the 1,024-path LRU, and after `configure` cleared it: three equal region hashes; with an LRU of 1 (`carverCacheCapacity: 1`) equal too; the two columns either side of the worm's chunk border carve the voxels next to the border exactly as one column of the global reference does" (until Task 30's `referenceCarve`, a 2-column `carveColumn` on one 32-wide box **(plan)**; Task 30 re-points it).
  - `regionHarness.test.ts`: `carverCacheCapacity` reaches the workers (a region generated at capacity 1 and at 1,024 hashes the same).
  - DT1's two parts 0 on fast.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/carve.test.ts test/unit/regionHarness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the rows; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 28: DT1 carverCache max 0 and isolated max 0, gated from SP6a on every tier (spec §10.3; new parts, hold by construction).`
- [ ] **Step 4: Goldens:** `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json` (the capacity hook moves no output). Expected: no diff.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `test(caves): DT1 carverCache and isolated; isolatedColumn and the cache capacity hook` (`git add src/gen/caves/carverCache.ts test/harness/region.ts test/harness/regionWorker.ts test/metrics/region.metric.ts test/thresholds.ts test/thresholds.lock.json test/unit/carve.test.ts test/unit/regionHarness.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 29: Harness I: `debugTags`, 3D components, the pre-cave top

**Files:**
- Modify: `test/harness/region.ts` (`GenRegionOptions` `:37` gains `debugTags?: boolean`; `RegionView` `:87-111` gains `tag(x, y, z): number` (the store's cave channel) and, with `debugTags`, `pillar(x, y, z): boolean` from **(plan)** `caveDebugColumn` in the harness (the readers of Task 11 per voxel: rock kept by `keep` where `min(E, C, S3, S2) < 0`), and with `debugTags` `terrainT(x, y, z): number` (the `terrain` tap's value per voxel, from the same `caveDebugColumn`, for C7.switchWall); `preCaveTop(x, z): number` (the highest voxel solid or tagged; not the carve's density top, Spec correction 18)), `test/harness/flood.ts` (`components3d`), the SP6a spec (Spec correction 19)
- Test: `test/unit/flood.test.ts` (the 3D cases beside the 2D ones), `test/unit/regionHarness.test.ts`

**Interfaces:**
- Produces: `export function components3d(cave: (x: number, y: number, z: number) => boolean, open: (x: number, y: number, z: number) => boolean, w: number, d: number, yMin: number, yMax: number): { label: Int32Array; size: Map<number, number>; sky: Set<number> }` **(plan)** (Spec correction 19): 6-connected components over the region's **tagged** air (`cave`) from y −56 to 319, labelled per 16-block slab with a union-find across slabs; a sky flood from y 319 over untagged open air (`open`: air or fluid not tagged); a component is sky-connected when one of its voxels is face-adjacent to a voxel that flood reaches.

- [ ] **Step 1: Write the tests.** `flood.test.ts`: against a brute-force BFS on random 32 × 64 × 32 fixtures (density 0.3, 0.5, 0.7): identical partitions; a tube crossing three slab boundaries is one component; a tagged tube opening into untagged air above the pre-cave top is one sky-connected component, and two such tubes are two components (the atmosphere joins none); a tagged pocket sealed by rock is not sky-connected. The harness: `pillar` is true only inside pillar rock under a negative family minimum (a fixture column); `terrainT` equals `tapFn('terrain', …)` on a column; `preCaveTop` is the true top where no cave breaches it and the breached voxel's height where one does.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/flood.test.ts test/unit/regionHarness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(harness): debugTags, 3D components and the pre-cave top (SP6a §10.1)` (`git add test/harness/region.ts test/harness/flood.ts test/unit/flood.test.ts test/unit/regionHarness.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 30: Harness II: the global carver reference; `caves.metric.ts` with C7's construction parts; the `caves` shards

**Files:**
- Create: `test/metrics/caves.metric.ts`
- Modify: `test/harness/refs.ts` (`referenceCarve`), `src/core/ids.ts:28-48` (`MetricId` gains `'C7' | 'C8' | 'C9'`), `test/thresholds.ts` (four rows), `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs:18-40` and `.github/scripts/fastShards.mjs:20-24` (shard `caves: [caves.metric.ts]` in each), their `.d.mts` siblings if typed, `test/unit/shards.test.ts:35-55` (both tables gain `caves`; `shardArgs(FAST_SHARDS, 'rest')` gains `'--exclude', 'test/metrics/caves.metric.ts'`), `test/unit/carve.test.ts` (Review Focus 5's border check re-pointed from Task 28's 2-column stand-in to `referenceCarve`), master §6.1 (§13 item 17), §1's test entry (item 8), §6.4's C7 construction rows (item 18), `test/arch/masterSpec.test.ts`, the SP6a spec (`## Threshold log`)
- Test: `test/unit/refsCarve.test.ts` **(plan)**, `test/unit/shards.test.ts`

**Interfaces:**
- Produces:
  - `export function referenceCarve(view: RegionView, seed: string, params: Params): Uint8Array` **(plan)** (over the view's box: every path whose box meets the region, carved from `carverPath` directly, no cache and no per-column work; per voxel the first source's kind in the window's order; the pre-carve solidity read from the region (density-solid = the block solid, or tagged 6-8), and σ_w's top the carve step's own, the density top: the highest density-solid voxel with `densityTopOf`'s island rule (Task 26), never Task 29's `preCaveTop`, which counts noise-tagged air and differs wherever an entrance breaches the top);
  - `caves.metric.ts`, regions per §10.1: fast 2 regions 16 × 16 (seed 42, default); quick 4 regions 32 × 32 (seeds 42 and 1, default), 2 large_biomes, one 32 × 32 each on archipelago (a coast and sea floor), amplified (summits and deep columns) and floating_islands (the island cap), found by scans at seed 42 **(plan)** (fixed in the file once found); full the quick set over seeds 42, 1, 2, 3;
  - `metricTest('C7', ['carverReference', 'reachOverflow', 'endTaper', 'islandCapAir'], …)`: `carverReference` interior voxels where the stage's carver-tagged set ≠ `referenceCarve`'s (0); `reachOverflow` over 100,000 sources per kind at the defaults and at the static maxima (0); `endTaper` over 100,000 sources per kind, branch points and the start room excluded (0; Spec correction 17); `islandCapAir` cave air at y ≥ 176 in the floating_islands region (0; `tiers: ['quick', 'full']`; on fast, which has no floating_islands region, the metric returns NaN for it, which an other-tier part accepts, since `evaluateMetric` refuses a missing value before it checks the tier, `test/harness/metric.ts:41-44`); each `{ max: 0, activeFrom: 'SP6a' }` (D26: hold by construction).

- [ ] **Step 1: Write the tests.** `refsCarve.test.ts`: on a 4 × 4 region `referenceCarve` equals the stage's carver tags at the interior; a path crossing the region's border carves the same voxels as the stage; at a partly wet position (0 < wet′ < 1) under an entrance that breaches the top, it uses the density top. `shards.test.ts`: `caves` in both tables and in the fast `rest` exclusions. `carve.test.ts`: Review Focus 5's border voxels against `referenceCarve`. C7 on fast returns `islandCapAir` NaN and passes. SP6a describe: §6.1's harness line `debugTags` "reads the store's `cave` channel and adds the pillar bit", references "3D sky flood and components; a global carver reference (SP6a)"; §1's test entry "(SP6a: metrics/caves.metric.ts, bench/inlined.ts)" **(plan)** (the `inlined.ts` half pinned by Task 35); §6.4's C7 row holds the four construction parts with their 0 bounds, cross-checked against `THRESHOLDS` (the SP5c pattern, `masterSpec.test.ts:1730-1757`).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/refsCarve.test.ts test/unit/shards.test.ts test/unit/carve.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the rows; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 30: C7 carverReference, reachOverflow, endTaper max 0 on every tier and islandCapAir max 0 on quick and full, gated from SP6a (spec §10.1, D26: hold by construction; new metric C7).`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npx vitest run --project metrics-quick test/metrics/caves.metric.ts` (its time recorded for §11). Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): caves.metric.ts with C7's construction parts and the global carver reference; the caves shards` (`git add test/metrics/caves.metric.ts test/harness/refs.ts src/core/ids.ts test/thresholds.ts test/thresholds.lock.json .github/scripts/metricShards.mjs .github/scripts/fastShards.mjs test/unit/shards.test.ts test/unit/refsCarve.test.ts test/unit/carve.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, and the `.d.mts` siblings if changed).

---

### Task 31: Metrics I: C1-C6 recorded

**Files:**
- Create: `test/harness/caveMetrics.ts` **(plan)** (the C1-C9 instruments, pure over a `RegionView` or fixture accessors; a unit test cannot import `caves.metric.ts`, whose `metricTest` and `test` calls register at import, `test/harness/metric.ts:84-85`, as `terrainScatter.ts`, `surfaceAnalysis.ts` and `zMetrics.ts` serve theirs)
- Modify: `test/metrics/caves.metric.ts` (imports the instruments)
- Test: `test/unit/cavesMetric.test.ts` **(plan)** (the instruments on fixtures, imported from `test/harness/caveMetrics.ts`)

**Interfaces:**
- Produces **(plan)** (D26: no row before Task 38, since a row is enforced once its `activeFrom` is started, `test/harness/metric.ts:43`): one plain `test('C1-C6 recorded (SP6a D26)', …)` that measures every part below on the tier's regions and writes `test/metrics/.out/caves.C1-C6.json` (the value per profile and region set), asserting only that each is finite; Task 38 turns each into a `metricTest` part of the same id. A threshold row bounds one value per part (`test/thresholds.ts`, `{ min?, max? }`), so a spec part with several values is split **(plan)** (B2's `landShareMin`/`landShareMax` pattern). The parts (§10.1):
  - `C1.voidShareMin`, `C1.voidShareMax`: tagged voxels / voxels in y −56 … preCaveTop − 8, per profile (default, large_biomes; cave_heavy is SP6b's), the lowest and the highest profile's;
  - `C2.skyComponents`: sky-connected components reaching ≥ 8 below the pre-cave top, per km²; `C2.skyShare`: the sky-connected share of cave air within 40 of the surface;
  - `C3.cheeseShare`, `C3.spaghettiShare` (3D + 2D), `C3.noodleShare`, `C3.carverShare` (worm + ravine + underground worm), `C3.entranceShare`: each kind's share of tagged voxels (spec §10.1's `shares`); `C3.pillars`: 128 × 128-block tiles holding ≥ 1 pillar-bit voxel; `C3.ravines`: ravine sources carving ≥ 1 voxel per km²; `C3.ravinesSky`: those sky-exposed (one carved voxel sky-connected) per km²; `C3.maxShare`: the largest kind's share (D34);
  - `C4.bands`: the carve rate per 16-block band −56 … 40 (the minimum); `C4.floorPeak`: the largest single y share of the floors of components ≥ 10k voxels;
  - `C5.largest`: the largest component / void; `C5.landCarved`: land columns with a tagged voxel; `C5.thinnest`: the median thinnest axis of components ≥ 64 voxels; `C5.thinnestByKind`: the same for components mostly cheese over those mostly spaghetti 3D;
  - `C6.latticeBias`: within each 16-block band, the carve rate per residue y mod 8 (and x mod 4, z mod 4) over the band's mean; the maximum over residues and bands (depth variation between bands is C4's).

- [ ] **Step 1: Write the tests** (`cavesMetric.test.ts`, on hand-built fixtures): each instrument's value on a fixture with a known answer (a single 10 × 10 × 10 cavern: `thinnest` 10; a lattice-aligned slab of carving at y ≡ 0 mod 8: `latticeBias` 8; a 1 × 1 vertical shaft to the sky: one sky component).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test && npx vitest run --project metrics-quick test/metrics/caves.metric.ts`; read `.out/caves.C1-C6.json` (recorded in the next evidence commit). Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): C1-C6 measured and recorded (SP6a §10.1, D26)` (`git add test/harness/caveMetrics.ts test/metrics/caves.metric.ts test/unit/cavesMetric.test.ts`).

---

### Task 32: Metrics II: C7, C8, C9 recorded; `caves.examples.json`

**Files:**
- Modify: `test/harness/caveMetrics.ts` (the C7-C9 instruments), `test/metrics/caves.metric.ts`
- Test: `test/unit/cavesMetric.test.ts`

**Interfaces:**
- Produces (recorded as Task 31's, into `.out/caves.C7-C9.json`):
  - `C7.borderPlaneRatio`: cave-wall faces on the planes x mod 16 = 0 over the planes x mod 16 ∈ {4, 8, 12}, and on x mod 16 = 15 over {3, 7, 11} (the same lattice residue mod 4), alike for z;
  - `C7.verticalStep`: the maximum over y −60 … 120 of rate(y) / rate(y ± 1), 3-layer smoothed, where rate ≥ 0.1 % (default and presets);
  - `C7.flatWallShare`: cave-wall faces in axis-aligned planar patches ≥ 6 × 6 faces (default and the archipelago sea floor);
  - `C7.switchWall`: faces in the shell |T − 8| < 1 over the shell's share of all faces (T read through `RegionView.terrainT` with `debugTags`, Task 29);
  - `C7.waterWall`: water voxels horizontally adjacent to tagged air, per km² (default and archipelago);
  - `C8.aperiodicity`: at y −40, 0, 40, the mean |m(p) − m(p + L·e)| for L 16, 32, 64 … up to the region's width − 16, e x or z, over pairs inside one region, over the random-pair mean (a quick region is 512 wide and a fast one 256, so L = 512 has no pair);
  - `C8.typeMixVariation`: the median Jensen-Shannon divergence of C3's shares between edge-adjacent 128 × 128 tiles;
  - `C8.sizeSpread`: the log-sd of component volumes ≥ 64; `C8.largeShare` **(plan)** (the spec's second `sizeSpread` value): the share of 32 × 32 regions holding a component ≥ 50k voxels (undefined on fast's 16 × 16 regions: there, `C8.aperiodicity`, `C8.sizeSpread` and `C8.largeShare` are returned as NaN, and Task 38 gates them on quick and full);
  - `C9.nearestEntrance`: from 256 land, non-river positions per region, the p90 horizontal distance to the nearest C2 opening (default and presets); `C9.entrancesMax`: C2's count per km²; `C9.holedSurface`: land positions whose pre-cave top voxel is tagged (default and presets); `C9.thinRoof`: land positions with tagged air within 3 blocks under a solid true top;
  - `test/metrics/.out/caves.examples.json`: per kind, the pose (x, y, z, yaw, pitch) of its largest component's air voxel nearest the region's centre at seed 42, and one for the largest interior (§10.1, D16); the entrance's pose at an entrance air voxel at its pre-cave top in a sky-connected component (D16's "entrance from the surface"); and a pillars pose, standing in the cheese air beside the pillar-bit voxel nearest the region's centre (D16 lists pillars among the links).

- [ ] **Step 1: Write the tests** (fixtures): `borderPlaneRatio` 1 on a lattice-uniform fixture and > 1.1 on one cut at x mod 16 = 0; `flatWallShare` counts a 6 × 6 planar patch and not a 5 × 6 one; `aperiodicity` < 0.9 on a 16-periodic fixture and computed only for L ≤ the fixture's width − 16; `switchWall` on a fixture with a known T; `nearestEntrance` on a fixture with one opening.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/cavesMetric.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test && npx vitest run --project metrics-quick test/metrics/caves.metric.ts` (time recorded). Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): C7's tuning parts, C8 and C9 recorded; the cave examples (SP6a §10.1-§10.2)` (`git add test/harness/caveMetrics.ts test/metrics/caves.metric.ts test/unit/cavesMetric.test.ts`).

---

### Task 33: Metrics re-asserted: L2, S1, T2, R1, R2, `islandBranchOnGround`, `landTopYmod16`

**Files:**
- Modify: `test/metrics/light.metric.ts` (`:35`'s comment "with real caves (SP6a)"; the quick and full tiers gain a floating_islands window holding a large island over grass, found by a scan, SP4a :737), `test/harness/terrainScatter.ts` (T2 reads pre-cave solidity: solid or tagged), `test/metrics/render.metric.ts` (R1 gains a region holding an entrance and a ravine across a chunk border, found by a scan; R2 and R4 re-measured), `test/metrics/surface.metric.ts` **(plan)** (`islandBranchOnGround` and `landTopYmod16` recorded to `.out`)
- Test: the metric files themselves; `test/unit/terrainScatter.test.ts` for the pre-cave read

**Interfaces:**
- Produces: L2 `enclosedLit` 0 with caves (`test/thresholds.ts:95`, unchanged); S1 `grassSky0` ≤ 0.1 % and `grassNoSky` 0 with the new window (D33: both stay); T2 on pre-cave solidity; R1 0 / 0 and `xray` 0 on the cave region; R2's bounds 0.85 / 0.55 unchanged unless the measurement misses (**STOP for the user** with the measurement; a new bound with a Threshold-log line); R4 recorded; `islandBranchOnGround` **(plan)**: the share of floating_islands positions where the island branch fires on a run with bottom < 181, measured with caves and "before caves" on the same tree with the six family taps muted to 1e6 and the three carver chances 0 (equal to SP5c's solidity, since `min(v, 1e6)` is v and `detailG` changes no sign), both written to `.out/S.islandBranchOnGround.json`; `landTopYmod16` re-measured (SP3c :357), recorded.

- [ ] **Step 1: Write the tests.** `terrainScatter.test.ts`: on a column with a cave under its top, the pre-cave transition count equals the same column's with carvers off and families muted; the scans find their windows at seed 42 (fixed in the files once found).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/terrainScatter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics` (quick; L2, S1, T2, R1, R2 green or R2's STOP); the values recorded for the exit.
- [ ] **Step 5: Commit** `test(metrics): L2, S1, T2, R1 and R2 re-asserted with caves; islandBranchOnGround before and after (SP6a §10.4, D31)` (`git add test/metrics/light.metric.ts test/harness/terrainScatter.ts test/metrics/render.metric.ts test/metrics/surface.metric.ts test/unit/terrainScatter.test.ts`).

---

### Task 34: Bench I: `terrain.caves.warm`, `carver.paths`, `mesh.xray`

**Files:**
- Modify: `test/bench/noise.bench.ts` (three rows, measured after `'paste.maxLit'` at the end of the file, in `BENCH_ROWS` order, `:573`; the log lines), `test/bench/gates.ts` (`BENCH_ROWS` `:98-105` appends `'terrain.caves.warm', 'carver.paths', 'mesh.xray'`), `test/unit/benchGates.test.ts` (its order pins `:247-261`), `test/baselines.json` (re-recorded: `benchGates.test.ts:264-266` requires a baseline per row)

**Interfaces:**
- Produces: `terrain.caves.warm` (`fillColumnT` over a 16 × 16 spiral of neighbours, the LRU warm: the streaming case; recorded); `carver.paths` (one source's path per kind, cold; recorded); `mesh.xray` (`meshXray` alone over `mesh.section`'s region sections; recorded); `mesh.section` keeps its gates (p50 ≤ 1.0, p99 ≤ 2.5 ms) with pass 3 inside it.

- [ ] **Step 1: Write** `benchGates.test.ts`: `BENCH_ROWS`' new rows.
- [ ] **Step 2: Measure** (as Task 14 Step 2; quiet machine): `BENCH_EXEMPT=<the §10.5 rows that rise by design> npm run bench` twice; every gate holds (`terrain.real`, `terrain.islands` p50 ≤ 10, p99 ≤ 20 with carvers; `mesh.section` p50 ≤ 1.0, p99 ≤ 2.5); misses → Task 37. Then `npm run bench:record` (the three new rows and the risen ones).
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `perf(bench): terrain.caves.warm, carver.paths and mesh.xray (SP6a §10.5)` (`git add test/bench/noise.bench.ts test/bench/gates.ts test/unit/benchGates.test.ts test/baselines.json`).

---

### Task 35: Bench II: the kill criterion (`inlined.ts`, `density.cornerInlined`)

**Files:**
- Create: `test/bench/inlined.ts`, `test/unit/inlined.test.ts`
- Modify: `test/bench/noise.bench.ts` (`density.cornerInlined` beside `density.corner` `:219-223`; the voxel phase's pair printed), `test/bench/gates.ts` (`BENCH_ROWS` inserts `'density.cornerInlined'` right after `'density.corner'`, its measurement order, `noise.bench.ts:573`), `test/unit/benchGates.test.ts` (its order pins `:247-261`, `:255` and `:260-261` included), `test/baselines.json` (re-recorded), master §1's test entry (`bench/inlined.ts`, item 8), `test/arch/masterSpec.test.ts`, the SP6a spec (`## Exit evidence`: the ratio)

**Interfaces:**
- Produces: `export function inlinedCorner(s: ColumnSample, p: InlinedLeaves, n: InlinedNoises, i: number, k: number, j: number, out: Float64Array): void` (the default expression hand-written as one function writing every interpolated slot's corner value, in the compiled slot order, with the leaves read from `p` and the tree's literals mirrored); **(plan)** `export function inlinedVoxel(slots: Float64Array, …): number` for the voxel phase's combine, measured in the row's log; the ratio = ((`density.corner` − `density.cornerInlined`) per corner × corners per column (median, Task 14) + the voxel phase's same difference × its voxels per column) / `terrain.real` p50.

- [ ] **Step 1: Write** `inlined.test.ts`: `inlinedCorner` equals the compiled tree's corner values bit for bit on all 1,225 corners (5 × 49 × 5) of 4 columns (land, sea, mountain, a floating_islands cluster column on its tree **(plan)**: the comparator covers the default tree, so the fourth is a default cave class column); `inlinedVoxel` equals `voxelFn` on every straddling voxel of those columns.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/inlined.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §1's test entry.
- [ ] **Step 4: Measure** (quiet machine): `BENCH_EXEMPT=<the §10.5 rows that rise by design> npm run bench` twice, then `npm run bench:record` (the new row); the ratio recorded in Exit evidence and (Task 50) master §7. **Conditional:** above 25 % → **STOP for the user**: master :1640's `new Function` codegen behind a CSP probe, `reference.ts` the oracle, is added by an amendment of this spec (its size grows); never exempt.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `perf(bench): the hand-inlined default expression and the DAG-closure overhead (SP6a §10.5, the kill criterion)` (`git add test/bench/inlined.ts test/unit/inlined.test.ts test/bench/noise.bench.ts test/bench/gates.ts test/unit/benchGates.test.ts test/baselines.json test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 36: D25's second checkpoint

**STOP for the user before Step 2:** as Task 14's.

**Files:**
- Modify: the SP6a spec (`## Exit evidence`: "### D25's second checkpoint (Task 36)"); nothing else (a docs-only commit inside push B, Spec correction 7)

- [ ] **Step 1: Node** (quiet machine): `npm run bench` twice (`terrain.real`, `terrain.caves.warm`, `mesh.section` p99, `mesh.xray`); the path cache's memory (bytes held by a full LRU after a 32 × 32 region, worst and typical: estimated 8.2 and 5.5 MB per worker); `test/unit/terrainHeap.test.ts` still passes with caves (it bounds only retained growth over a warm second pass, `HEAP_GROWTH_MAX` 16 KiB, `:36-37`; the LRU full and the same tail of accesses in both passes); the garbage per column measured with `--trace-gc` scavenge bytes over 1,000 columns, recorded against `src/gen/column/lakes.ts:9-10`'s 1.5 MB; **(plan)** each pass's vertex use per region over an RD 12 disc meshed in Node from real payloads (the p50, p99 and maximum per pass against `RESERVATION`, `src/render/regionGrid.ts:38-42`) and the growth events that use implies (× 1.5, `:44`), written by the measuring script as JSON into the scratchpad for Task 40's fixture.
- [ ] **Step 2: Chrome** (the STOP's conditions): `npm run measure:chrome -- --route bench --gpu iris --workers 4` on a local build of HEAD; `mediumFill4wMs`, `sabMB`, the stage times; the file not committed.
- [ ] **The evidence table** (the spec's "### D25's second checkpoint (Task 36)"):

  | measure | at the prototype (Task 14) | now | gate or use |
  |---|---|---|---|
  | `terrain.real` p50 / p99; `terrain.caves.warm` | | | ≤ 10 / ≤ 20 |
  | `mesh.section` p50 / p99; `mesh.xray` | — | | ≤ 1.0 / ≤ 2.5 ms |
  | the path cache's memory per worker, worst / typical | — | | ≈ 8.2 / 5.5 MB (estimate) |
  | garbage per column (`--trace-gc` scavenges); `terrainHeap`'s retained growth | 1.5 MB (SP3b, `lakes.ts:9-10`); — | | recorded; < 16 KiB (the test) |
  | per pass, the largest region's vertices (opaque, cutout, translucent, X-ray) | — | | Task 40's reservations |
  | growth events over the RD 12 disc | — | | recorded; Task 40 makes them 0 |
  | `mediumFill4wMs`, `sabMB` | | | ≤ 6,000; > 5,600 triggers the levers |

- [ ] **Step 3: The rule.** `terrain.real` p50 > 7 ms, either T gate missed, or `mediumFill4wMs` > 5,600 ms → **Task 37** (levers not yet applied, in §1.6's order); `mesh.section` p99 > 2.5 ms → **STOP for the user** with the measurement (no lever in the spec); the reservations' sizes go to Task 40.
- [ ] **Step 4: Commit** `docs(sp6a): D25's second checkpoint measured` (`git add docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 37: Levers II (conditional)

Run only when Task 36's rule fires, or a Node gate missed in Task 34; as Task 15 (each lever one commit, measured by Task 36's Steps 1-2 before the next, a **STOP** before each Chrome measurement; stop at the first that meets every gate). Levers 15a-15c not yet applied, in that order, each with Task 15's Files (its mirrors: `test/bench/inlined.ts` and `inlined.test.ts` exist by now); output-changing ones (15b, 15c) land here, before Task 38's tuning and push B's record (D25), and re-record from push A's head (the same key set as Task 27). **STOP:** a gate still missed after them goes to the user with every measurement.

---

### Task 38: Tuning: the dry run, the rows at their bounds

**Files:**
- Modify: `test/metrics/caves.metric.ts` (the recorded parts become `metricTest('C1' …)` … `metricTest('C9' …)` parts; C7's tuning parts as `metricTest('C7', ['borderPlaneRatio', 'verticalStep', 'flatWallShare', 'switchWall', 'waterWall'], …, { outName: 'C7.tuning' })`, since Task 30's `metricTest('C7', …)` already writes `.out/C7.json` and two writers of one name are refused, `test/harness/metric.ts:148-155`), `test/thresholds.ts` (every tuning part `activeFrom: 'SP6a'` at its bound), `test/thresholds.lock.json` (generated), `src/core/params/schema.ts` (retuned defaults, if any), `src/core/params/defaultTrees.ts` (retuned tree literals G_f, if any), `test/goldens.json`, `README.md`, and on a retune the mirrors (Global Constraints): U4's `test/fixtures/expected-v1.json` and `expected-v2.json`, the schema lock, master §3.6's table and its pin, `test/harness/carverParams.ts`, `test/bench/inlined.ts` and `test/unit/inlined.test.ts`, master §6.4 (§13 item 18: C1-C6 parts as built with C6's new definition and C5's `thinnestByKind`, C7-C9 rows, S1 "gated from SP6a; `grassNoSky` stays beside it", L2's note, R2's re-baseline), `test/arch/masterSpec.test.ts`, the SP6a spec (`## Threshold log`, `## Exit evidence`)

**Interfaces:**
- Produces: the rows, under Tasks 31-32's part ids (§10.1's bounds; preset parts, `C8.aperiodicity`, `C8.sizeSpread` and `C8.largeShare` `tiers: ['quick', 'full']`, fast returning NaN for them, Task 32):
  - `C1.voidShareMin` min 0.05, `C1.voidShareMax` max 0.15;
  - `C2.skyComponents` min 20 (per km²), `C2.skyShare` min 0.2;
  - `C3.cheeseShare` min 0.2, `spaghettiShare` min 0.1, `noodleShare` min 0.02, `carverShare` min 0.1, `entranceShare` min 0.02; `pillars` min 0.9; `ravines` min 10, `ravinesSky` min 3 (per km²); `maxShare` max 0.7 (D34);
  - `C4.bands` min 0.02, `C4.floorPeak` max 0.1;
  - `C5.largest` max 0.6 (the spec's "< 60 %"), `landCarved` min 0.6, `thinnest` min 4, `thinnestByKind` min 1.5;
  - `C6.latticeBias` max 1.1;
  - `C7.borderPlaneRatio` min 0.9 max 1.1, `verticalStep` max 1.5, `flatWallShare` max 0.005, `switchWall` max 2, `waterWall` max 1;
  - `C8.aperiodicity` min 0.9, `typeMixVariation` min 0.05, `sizeSpread` min 1.5, `largeShare` min 0.1 max 0.4;
  - `C9.nearestEntrance` max 192 (the p90), `entrancesMax` max 150, `holedSurface` max 0.02, `thinRoof` max 0.05.

- [ ] **Step 1: The dry run.** `npm run test:metrics:full` (caves, terrain, light, render, region); every part's value per tier against its bound, in a table in Exit evidence.
- [ ] **Step 2: Tune** (only on a miss): the leaves of §4 and the cap literals (G_f), one change at a time, each re-run on quick; every change re-records from push A's head (the same key set as Task 27) and updates the mirrors (master §3.6's table and pin, `npm run docs:params`, `test/harness/carverParams.ts` when a carver default moves, `test/bench/inlined.ts` and `inlined.test.ts` when a tree literal moves, U4's fixtures, the schema lock when a leaf default moves); the closure-distance and continuity tests stay green.
- [ ] **Step 3: STOP for the user: D4's entrance figures** (D4: "this spec's proposal, shown to the user with the measurements at tuning"). After the tuning, the controller shows the user `C9.nearestEntrance` (p90, against 192 blocks), `C9.entrancesMax` (against 150 per km²), `C9.holedSurface` (against 2 %), `C9.thinRoof` and C2's two parts, per region set, with the entrance pose from `test/metrics/.out/caves.examples.json` as a `/?at=…` link on a local preview the controller serves (its own port, never 5183 or 4190), and waits for the user's OK or the user's bounds; a bound the user sets is entered in Step 4 with its Threshold-log line, a retune the user asks for runs Step 2 again.
- [ ] **Step 3b: STOP for the user** when, after §1.6's levers and the tuning, a master bound (C1-C6) still misses, or a bound this spec proposes (`C3.maxShare`, `C5.thinnestByKind`, C7's tuning parts, C8, C9) misses: the measurements go to the user, whose bound is entered with a Threshold-log line. C1's cave_heavy 10-22 % is SP6b's to record.
- [ ] **Step 4: The rows.** `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 38: C1-C6 at the master's bounds, C3 maxShare max 0.7, C5 thinnestByKind min 1.5, C7 borderPlaneRatio 0.9-1.1, verticalStep max 1.5, flatWallShare max 0.005, switchWall max 2, waterWall max 1, C8 aperiodicity min 0.9, typeMixVariation min 0.05, sizeSpread min 1.5, largeShare 0.1-0.4, C9 nearestEntrance max 192, entrancesMax max 150, holedSurface max 0.02, thinRoof max 0.05, gated from SP6a (spec §10.1, D26; new parts; measured <values> on full; <the user's bounds, if any>).` Master §6.4 rows as §13 item 18, cross-checked against `THRESHOLDS`.
- [ ] **Step 5: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(caves): tuned defaults; C1-C9 gated at their bounds (SP6a §10.1)` (`git add test/metrics/caves.metric.ts test/thresholds.ts test/thresholds.lock.json src/core/params/schema.ts src/core/params/defaultTrees.ts test/goldens.json README.md test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, and by explicit path each mirror that moved: `test/fixtures/expected-v1.json`, `test/fixtures/expected-v2.json`, `test/schema-shape.lock.json`, `test/harness/carverParams.ts`, `test/bench/inlined.ts`, `test/unit/inlined.test.ts`).

---

### Task 39: Push B: the golden record, the bench record, the push, CI and its levers

**Files:**
- Modify: `src/metrics/sp6aGoldens.ts` (`sp6a.region.T.caves`: an 8 × 8 window at seed 42 holding every kind, its corner from `caves.examples.json`'s scan, pinned as a literal **(plan)**), `test/goldens.json`, `test/unit/goldens.sp6a.test.ts`, the key-list pins of Task 3 (62 keys: `goldens.sp2a`, `sp3a`, `sp3b`, `sp3c`, `sp3e` tests), `test/baselines.json`, the SP6a spec (`## Exit evidence`)

- [ ] **Step 1: The last key.** `goldens.sp6a.test.ts`: the window holds a voxel of each kind 1-8; `git checkout <push A head> -- test/goldens.json && npm run test:goldens`; `git diff <push A head> -- test/goldens.json` lists `generatorVersion` 6 → 7, §12.3's allowed keys and the added `sp6a.carver.paths`, `sp6a.region.T.caves` (62 keys); `npx --yes bun@1 test/tools/goldensJsc.ts` 62/62.
- [ ] **Step 2: The bench record** (quiet machine): `BENCH_EXEMPT=terrain.real,terrain.islands,density.corner,slice.vertical128,slice.horizontal128,light.column,mesh.section,surface.column npm run bench`; `npm run bench:record`; `npm run bench`: every gate and the +30 % rule.
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS.
- [ ] **Step 4: Commit** `test(goldens): sp6a.region.T.caves; push B's record (GENERATOR_VERSION 7)` (`git add src/metrics/sp6aGoldens.ts test/goldens.json test/unit/goldens.sp6a.test.ts test/unit/goldens.sp2a.test.ts test/unit/goldens.sp3a.test.ts test/unit/goldens.sp3b.test.ts test/unit/goldens.sp3c.test.ts test/unit/goldens.sp3e.test.ts test/baselines.json docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).
- [ ] **Step 5: Push** (the controller): `git push`. CI green; its wall and each job against §11 recorded in a docs commit. **Conditional:** above 3 min 30 s → lever 1 (`apply.metric.ts` into a shard of its own, `metricShards.mjs:20`, with `shards.test.ts`; commit `ci: apply.metric.ts in a shard of its own (SP6a §11 lever 1)`), push and measure; then lever 2 (the `caves` quick shard split by profile, `ci: the caves quick shard split by profile (SP6a §11 lever 2)`); still above → **STOP for the user** (levers 3 and 4 are sample reductions, the user's decision).

---

### Task 40: The staging reservations from the second checkpoint

Tasks 40-54 change no generated output (each runs `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`) and are pushed at will.

**Files:**
- Create: `test/fixtures/sp6a-region-use.json` (per pass, the per-region vertex use over the RD 12 disc from Task 36 Step 1's Node measurement, written by that measurement's script; re-run here if it was not saved)
- Modify: `src/render/regionGrid.ts:34-44` (`RESERVATION` per pass from Task 36's measurement; its comment), `test/unit/regionGrid.test.ts`, the SP6a spec (Spec correction 7: §5.1's "the X-ray commit resizes the reservations" → this task); when a reservation changes, the pins of today's values: master §4.5's reservation sentence ("Medium: opaque 131,072 vertices / 196,608 indices, translucent 16,384 / 24,576, cutout 8,192 / 12,288 …") and its pin `test/arch/masterSpec.test.ts:843`, `test/unit/regionBatch.test.ts:79-88`, `:119`, `:168` (131,072 vertices, `gpuBytes` 180,224), `test/unit/regionMesh.test.ts:446` ("32 rows of 4,096 vertices = 131,072"), `test/unit/sectionRendererContract.ts:758-762` (20 + 20 rows that "do not fit the 131,072", `gpuBytes` 1,835,008 / 2,359,296)

**Interfaces:**
- Produces **(plan)**: each pass's reservation = the largest per-region vertex use Task 36 measured over the RD 12 disc × 1.25, rounded up to a multiple of 4,096 vertices, never below today's value (opaque 131,072, cutout 8,192, translucent 16,384; pass 3's estimate 16,384); indices 1.5 × vertices as today.

- [ ] **Step 1: Write the test** (`regionGrid.test.ts`): the four reservations equal the pinned values; over Task 36's per-region uses (a fixture JSON of the counts, committed under `test/fixtures/` **(plan)**) the growth events are 0 for every region at or under the measured maximum.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/regionGrid.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS.
- [ ] **Step 5: Commit** `perf(render): the staging reservations sized for caves and the X-ray (SP6a §5.1, D25)` (`git add src/render/regionGrid.ts test/unit/regionGrid.test.ts test/fixtures/sp6a-region-use.json docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, and when a reservation changed `docs/superpowers/specs/2026-09-26-architecture-design.md test/arch/masterSpec.test.ts test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts test/unit/sectionRendererContract.ts`).

---

### Task 41: Parameters II: the lints; the cave-only Apply and the watchdog

**Files:**
- Modify: `src/ui/paramPanel/lints.ts:15-19` (`ORDERED` and two special lints), `src/ui/map/previewDriver.ts` (only if the test fails: a cycle that requests no tile lands by its preview at once, `:92-96`, `:183-188`), `test/unit/paramPanelModel.test.ts`, `test/unit/previewDriver.test.ts`, `test/unit/applyControl.test.ts`

**Interfaces:**
- Produces: `ORDERED` gains every `minY`/`maxY` pair of `caves.cheese`, `caves.spaghetti3d`, `caves.spaghetti2d`, `caves.noodles`, `caves.entrances` ("the range is inverted: the family narrows across it") and every `*Min`/`*Max` pair of `caves.worms` (radius, vRatio, floor, roomYScale, startY), `caves.undergroundWorms` (startY) and `caves.ravines` (length, startY) ("the range is empty"); two lints returned by `paramLints` after the `ORDERED` pairs (the panel shows only what `paramLints` returns, `src/ui/paramPanel/panel.ts:167`): `caves.worms.lengthVar ≥ caves.worms.length` → "some worms are 1 step long"; `islands.enabled` on with `caves.limits.capTop` > 180 → "caves may detach runs above y 180; the island rules then treat them as islands" (D8).

- [ ] **Step 1: Write the tests.**
  - `paramPanelModel.test.ts`: the Parameters tab shows Caves after Islands with its sub-groups in the order Cheese, Spaghetti 3D, Spaghetti 2D, Noodles, Pillars, Entrances, Worms, Underground worms, Ravines, Limits, sizes first in each (D9: the schema's order, built by Tasks 6-9 and 27); every `caves.*` badge reads Terrain; each lint fires on its pair and not on the defaults; the island lint fires on default + `islands.enabled` and not on floating_islands (capTop 180).
  - `previewDriver.test.ts` / `applyControl.test.ts` (§4, §10.7): "an edit of `caves.cheese.offset` alone (the map stage reads no cave leaf, so every tile is cached) is applied `APPLY_QUIET_MS` (150) after the release plus one frame, not after the watchdog's `WATCHDOG_MIN_MS` 1,000".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/paramPanelModel.test.ts test/unit/previewDriver.test.ts test/unit/applyControl.test.ts`. Expected: FAIL (the lints; the watchdog case if it waits).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(params): the caves lints; a cave-only Apply lands without the watchdog (SP6a §4)` (`git add src/ui/paramPanel/lints.ts test/unit/paramPanelModel.test.ts test/unit/previewDriver.test.ts test/unit/applyControl.test.ts`, and `src/ui/map/previewDriver.ts` if changed).

---

### Task 42: The `caves` slice field, the Cross-section tint, `slice.caves128`

**Files:**
- Modify:
  - `src/ui/inspector/sliceModel.ts:55-56`, `:79-84` (`FieldChoice` and `FIELD_CHOICES` gain `'caves'`, "Cave type", on both planes);
  - `src/gen/inspect/fieldSlice.ts` (`SliceField` `:261` gains `'caves'`; samples through a batched `caveTagAt` and `solidAt`; `FieldSliceValues` `:284-288` gains `{ field: 'caves'; values: Uint8Array; fluid: null }`; `fieldSliceProblem` `:353` accepts `'caves'` with path `''`; `sliceCostOf` `:531-554` gains the `caves` case, which today throws `RangeError('unknown field')` on every UI request, `sliceModel.ts:663`);
  - `src/gen/caves/tags.ts` (`caveTagBatch`);
  - `src/workers/protocol.ts` (`SLICE_FIELDS` `:283` gains `'caves'`; `isRefusableField` true for `'caves'`; `fieldSliceBytes` `:299-304`: `caves` → u8 values; the Cross-section's `slice` reply `SliceResultMsg` `:190-194` gains `cave: ArrayBuffer`, and `sliceCheck` `:509-517` checks it is `(to − from)·SLICE_ROWS` bytes);
  - the Cross-section's reply chain: `src/workers/sliceJob.ts:51-54` (`SliceData.cave`, from the proto view's cave channel per sample, beside blocks and fluid), `src/workers/taskHandler.ts:283-290` (the `sliceResult` carries and transfers `cave`), `src/engine/workerPool.ts:80`, `:716-743` (`SliceResult.cave` assembled from the parts) and `:768-787` (the `fieldSlice` assembly allocates and copies a `caves` part as `Uint8Array`, not as `Float64Array`);
  - `src/ui/inspector/sliceView.ts` (colours and the legend);
  - `src/ui/crossSection/voxels.ts:143` (`sliceRgba(s: SliceResult)` tints air with tag ≠ 0 by kind, from `s.cave`);
  - `src/ui/crossSection/section.ts` (only if the tint needs it);
  - `test/bench/noise.bench.ts` (`slice.caves128` measured last, after Task 34's rows, in `BENCH_ROWS` order);
  - `test/bench/gates.ts` (`SLICE_CAVES_P50_MAX_MS = 300`; `BENCH_ROWS` appends `'slice.caves128'`; `benchGates.test.ts`' order pins follow);
  - `test/unit/benchGates.test.ts`;
  - `test/baselines.json`;
  - master §5.5 and §5.6 (§13 item 16);
  - `test/arch/masterSpec.test.ts`;
  - the SP6a spec (Spec correction 8)
- Test: `test/unit/sliceModel.test.ts`, `test/unit/fieldSlice.test.ts`, `test/unit/fieldSliceProtocol.test.ts`, `test/unit/sliceView.test.ts`, `test/unit/crossSectionVoxels.test.ts`, `test/unit/sliceJob.test.ts`, `test/unit/sliceCost.test.ts`, `test/unit/fieldSlicePool.test.ts`

**Interfaces:**
- Produces: `sliceCostOf(params, 'caves', '', plane, n)` = n × (the default tree's work cost + the carver window's per-sample cost) + the column cost **(plan)**, refusable like `density`; `export function caveTagBatch(dc: DensityContext, xs: Int32Array, ys: Int32Array, zs: Int32Array, out: Uint8Array): void` (codes: 0 open air, 1-9 the kinds, 16 other solid **(plan)**; one column's window, sources and paths shared by its samples); the field's colours: `XRAY_COLORS` for 1-9, pale grey `#d8d8d8` **(plan)** for other solid, `VOXEL_COLORS.sky` for open air; the horizontal plane's square drawn on the map as today (`src/ui/map/mapTool.ts:363-372`); `slice.caves128`: a horizontal 128 × 128 `caves` slice, 256 blocks across, p50 ≤ 300 ms.

- [ ] **Step 1: Write the tests.** `sliceModel.test.ts`: "Cave type" on both planes for any selection; `fieldSlice.test.ts`: a 32² `caves` slice equals `caveTagAt`/`solidAt` per sample on both planes, carvers included; `caveTagBatch` equals the per-sample probe; `fieldSliceProtocol.test.ts`: the byte lengths and the guards (`fieldSliceResult` u8 for `caves`; `sliceResult`'s `cave` of `(to − from)·SLICE_ROWS` bytes); `sliceJob.test.ts`: the `cave` bytes equal the store's tags per sample; `sliceCost.test.ts`: `sliceCostOf` for `caves` on both planes, refusable; `fieldSlicePool.test.ts`: a `caves` slice assembles as `Uint8Array`; `sliceView.test.ts`: the legend lists the kinds present with the X-ray's colours; `crossSectionVoxels.test.ts`: air with tag 1 is drawn amber, air with tag 0 sky. `benchGates.test.ts`: the new gate. SP6a describe: §5.5's slice fields deliver "cave type (SP6a)"; §5.6 contains `the cave slice at y: the Density tab's horizontal cave-type field, its square on the map (SP6a); a tile layer and carver tunnels → SP10`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/sliceModel.test.ts test/unit/fieldSlice.test.ts test/unit/fieldSliceProtocol.test.ts test/unit/sliceJob.test.ts test/unit/sliceCost.test.ts test/unit/fieldSlicePool.test.ts test/unit/sliceView.test.ts test/unit/crossSectionVoxels.test.ts test/unit/benchGates.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Measure** (quiet machine): `npm run bench` twice; `slice.caves128` and `slice.vertical128` p50 ≤ 300. **Conditional:** a miss → the slice redraws on release instead of during a drag (Task 15d's change, if not applied) and **STOP for the user** with the measurements (§7.4). `npm run bench:record` for the new row.
- [ ] **Step 5: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS.
- [ ] **Step 6: Commit** `feat(inspector): the cave-type slice field and the Cross-section's cave tint; slice.caves128 (SP6a D13)` (`git add src/ui/inspector/sliceModel.ts src/gen/inspect/fieldSlice.ts src/gen/caves/tags.ts src/workers/protocol.ts src/workers/sliceJob.ts src/workers/taskHandler.ts src/engine/workerPool.ts src/ui/inspector/sliceView.ts src/ui/crossSection/voxels.ts test/bench/noise.bench.ts test/bench/gates.ts test/baselines.json test/unit/sliceModel.test.ts test/unit/fieldSlice.test.ts test/unit/fieldSliceProtocol.test.ts test/unit/sliceJob.test.ts test/unit/sliceCost.test.ts test/unit/fieldSlicePool.test.ts test/unit/sliceView.test.ts test/unit/crossSectionVoxels.test.ts test/unit/benchGates.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`, and `src/ui/crossSection/section.ts` if changed).

---

### Task 43: The Caves tab

**Files:**
- Create: `src/ui/map/cavesTab.ts`, `test/unit/cavesTab.test.ts`
- Modify: `src/ui/map/layout.ts:16-24` (`TabId` gains `'caves'`; `TAB_LABELS.caves` "Caves"; `layoutTabs(places: boolean, caves: boolean)`, Caves after Presets and before Places), `src/ui/map/mapTool.ts` (its only caller, `:141-142`: `MapToolDeps.caves?: CavesTabDeps`; mounts `createCavesTab` when given, `caves: true`, and `?map` passes none; `openSlice(y)` via `layout.openDrawer('density')` and `SliceView.open(…)`; `revealParameters()` via `layout.showTab('parameters')` (`:312`) and `panel.reveal('caves.cheese.offset')` (the panel `:305`); all local to `createMapTool`), `src/ui/world/mapOverlay.ts:428-462` (the tool is mounted on demand here: it passes the page's cave deps as it passes `places`, and pushes the page's X-ray state into the tab on mount), `src/ui/inspector/sliceView.ts:58-69` (`SliceView.open({ plane: 'horizontal', field: 'caves', y, cx, cz, extent: 256 })` **(plan)**, the opener Task 43 consumes, which no earlier task creates), `src/ui/world/worldPage.ts` (the tab's state from the page's X-ray state and back), master §1's `ui/map/*` entry (§13 item 8), `test/arch/masterSpec.test.ts`, the SP6a spec (Spec correction 11)
- Test: `test/unit/layout.test.ts` (`:135`'s pin of `mapTool.ts:141-142`'s source text rewritten), `test/unit/worldPage.test.ts`, `test/unit/mapTool.test.ts` (new **(plan)**), `test/unit/mapOverlay.test.ts`, `test/unit/sliceView.test.ts`

**Interfaces:**
- Consumes: the page's X-ray state (Task 21), `bandSet`, `stripText`, `XRAY_COLORS`, `XRAY_LABELS`; `panel.reveal` (`src/ui/paramPanel/panel.ts:130-141`); `SliceView.open` (this task).
- Produces: `export function createCavesTab(host: HTMLElement, deps: CavesTabDeps): { set(on: boolean, band: XrayBand, radius: number): void; dispose(): void }` with `CavesTabDeps { onXray(on: boolean): void; onBand(b: XrayBand): void; openSlice(y: number): void; revealParameters(): void; find(kind: number): void; cancelFind(): void }` **(plan)**; contents: "X-ray (X)" checkbox; "Lowest y" and "Highest y" sliders (−64 … 319, step 1; lowest ≤ highest kept by moving the other); "All depths"; the legend; the radius readout; "Cave slice" (the Density tab's horizontal `caves` slice at the band's middle y, or the camera's y with the band at all, 256 blocks across, centred on the camera); "Cave parameters" (Spec correction 11: `reveal` takes a leaf path and does nothing for `'caves'`, `panel.ts:130-131`, so it reveals `caves.cheese.offset`, the section's first leaf); the Find row is Task 44's.

- [ ] **Step 1: Write the tests.** `layout.test.ts`: `layoutTabs(false, true)` is World, Parameters, Biomes, Presets, Caves; `layoutTabs(true, true)` ends Caves, Places; `?map`'s tabs unchanged. `cavesTab.test.ts` (Review Focus 3): "setting Lowest y to 200 with Highest y 100 sets Highest y to 200; a slider change calls `onBand` and the page's strip follows; All depths gives `XRAY_ALL`; the checkbox mirrors X both ways; Cave slice opens the Density tab at y = ⌊(yMin + yMax)/2⌋ (the camera's y at all); Cave parameters reveals `caves.cheese.offset`". `mapTool.test.ts` / `mapOverlay.test.ts`: the world's map mounts the Caves tab with the page's deps and its X-ray state; `?map` has no Caves tab. `sliceView.test.ts`: `open` sets the plane, the field, y and the centre and requests one slice. `worldPage.test.ts`: "with the map split and a band slider focused (owner map, `ownerOf`, `mapOverlay.ts:123-124`), PageDown is neither acted on nor prevented (`input.ts:132`, wired at `worldPage.ts:5182`), so only the slider moves" (`worldIgnoresKeys` covers only the panels in `keyPanels`, `worldPage.ts:5161-5166`, not the map).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/layout.test.ts test/unit/cavesTab.test.ts test/unit/mapTool.test.ts test/unit/mapOverlay.test.ts test/unit/sliceView.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; master §1's `ui/map/*` gains `cavesTab.ts (SP6a)`; the `SP6A_MODULES` row.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): the Caves tab with the X-ray's band, the cave slice and the parameters link (SP6a D12)` (`git add src/ui/map/cavesTab.ts src/ui/map/layout.ts src/ui/map/mapTool.ts src/ui/world/mapOverlay.ts src/ui/inspector/sliceView.ts src/ui/world/worldPage.ts test/unit/cavesTab.test.ts test/unit/layout.test.ts test/unit/mapTool.test.ts test/unit/mapOverlay.test.ts test/unit/sliceView.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 44: The finder: the search job and the Find buttons; `finder.nearest`

**Files:**
- Modify: `src/gen/caves/tags.ts` (`nearestCave`), `src/workers/protocol.ts` (`findCave`, `caveFound`), `src/workers/taskHandler.ts` (the job, on the shared store; its `stop` from a scoped `stopFor` epoch, `taskHandler.ts:287`, `protocol.ts:21`, if one fits **(plan)**), `src/engine/workerPool.ts` (`pool.findCave(req): { promise, cancel }`, cancelled pool-side as `fieldSlice` is, `workerPool.ts:768`, `:792`: a worker runs one message to completion, `src/workers/task.worker.ts:9-13`, and the pool expects one reply per job, so a cancel message could not reach a running search), `src/ui/map/cavesTab.ts` (Find: one button per kind, "Nearest <kind>"; the result line; "Save as place" in a saved world), `src/ui/world/worldPage.ts` (`teleporter.toPlace` in flight, `src/ui/world/teleport.ts:92-97`), `test/bench/noise.bench.ts` (`finder.nearest` logged, outside `BENCH_ROWS`: recorded, no gate, as spec §10.5 says; a row in `BENCH_ROWS` would need a baseline, `benchGates.test.ts:264-266`, and the +30 % gate, `gates.ts:208-226`), the SP6a spec (Spec correction 21)
- Test: `test/unit/caveFinder.test.ts` (new), `test/unit/worldProtocol.test.ts`, `test/unit/cavesTab.test.ts`, `test/unit/workerPool.test.ts` (the cancel)

**Interfaces:**
- Produces:
  - `export function nearestCave(dc: DensityContext, kind: number, x: number, y: number, z: number, o: { radius: number; deadline: number; now: () => number; stop: () => boolean; loaded: (cx: number, cz: number) => ColumnView | null }): { hit: { x: number; y: number; z: number; yaw: number } | null; reason: 'found' | 'radius' | 'budget' | 'stopped' }` **(plan)** (gen; the clock and the stop injected, both polled every column): rings of 64 blocks (r = 0, 64 … 448, each ring from r to r + 64 around (x, z)) out to `radius` (512); per ring (1) the ring's loaded columns: their stored tags; (2) for carver kinds, candidates from the path cache with no density over the ring: the ellipsoid centres of the window's paths whose boxes meet the ring, nearest first, each confirmed by one `caveTagAt` at that voxel (a centre can lie in density air, where a noise kind wins, §3.2 step 3, or above ground, where nothing is carved), so density is evaluated only at the candidates tried, never over the ring; (3) for noise kinds beyond the loaded area, `caveTagAt` on a 4 × 8 × 4 lattice of the ring's unloaded columns until `deadline` (2 s), `now()` and `stop()` polled every column; the first ring with a hit returns the hit nearest (x, y, z), its yaw along the cave (**(plan)** the axis with the longest run of the same kind from the hit), else `radius`;
  - messages `{ type: 'findCave', jobId, kind, x, y, z, radius: 512, budgetMs: 2000 }` and `{ type: 'caveFound', jobId, hit, reason }`, guarded like the slice messages (no cancel message: the pool cancels its promise, and the worker's search stops through `stop`);
  - the result line: "<kind> at x, y, z · d blocks away", "No <kind> found within 512 blocks", "No <kind> found in 2 s"; a second press or closing the tab cancels; the job stays even if the buttons are cut (§15 item 1: L13 uses it).
- [ ] **Step 1: Write the tests.** `caveFinder.test.ts`: at seed 42 from L10's hover point (Task 45's L13 start, named as a literal), each kind 1-8 (kind 9 has no button: the default tree yields none) returns a voxel whose `caveTagAt` is that kind within 512 blocks, with `now` a clock that never passes the deadline; a carver kind is found with the loaded set empty and density evaluated only in the columns of the candidates it tried (a counting stub: no ring lattice); a candidate centre in density air or above ground is skipped for the next; a noise kind beyond the loaded area stops at the deadline with reason `budget` on an advancing fake clock; `stop` true ends the search with `stopped`; a kind absent within 512 (a params patch with `ravines.chance` 0) returns `radius`; no ring reaches past 512. `worldProtocol.test.ts`: the two messages' guards. `workerPool.test.ts`: `findCave`'s `cancel` rejects the promise and drops the late reply. `cavesTab.test.ts`: the buttons, the three result lines, the cancel on a second press and on closing, "Save as place" only in a saved world.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/caveFinder.test.ts test/unit/worldProtocol.test.ts test/unit/workerPool.test.ts test/unit/cavesTab.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `finder.nearest` logged by `noise.bench.ts` (the worst kind's search from L10's hover point at seed 42, only searches that find their hit before the deadline; recorded, no gate, not in `BENCH_ROWS`).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the golden check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(caves): find the nearest cave of each kind from the Caves tab (SP6a D12, D16)` (`git add src/gen/caves/tags.ts src/workers/protocol.ts src/workers/taskHandler.ts src/engine/workerPool.ts src/ui/map/cavesTab.ts src/ui/world/worldPage.ts test/bench/noise.bench.ts test/unit/caveFinder.test.ts test/unit/worldProtocol.test.ts test/unit/workerPool.test.ts test/unit/cavesTab.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 45: Bench leg L13 (caves)

**Files:**
- Modify: `src/ui/world/bench.ts` (`BenchLeg.name` gains `'L13'`; `BENCH_CAVES`; `caveRoute`; `ALL_LEGS` `:250`; the JSON's `caves` block; `BENCH_FRAME_CAPACITY` `:101`), `src/ui/world/worldPage.ts` (the bench's hooks: the finder job, the camera on the route), the SP6a spec (Spec correction 20)
- Test: `test/unit/bench.test.ts`

**Interfaces:**
- Produces:
  - **(plan)** `export const BENCH_CAVES = { findMaxS: 20, flyMaxS: 10, walkS: 60 } as const;` (L13 is a `BenchLeg` whose `seconds` is 90);
  - `export function caveRoute(tagAt: (x: number, y: number, z: number) => number, solidAt: (x: number, y: number, z: number) => boolean, start: readonly [number, number, number], blocks: number): Float64Array` **(plan)** (pure: a walk through cave air one block above a floor, preferring cheese, then spaghetti 3D and 2D, then any kind, with a fixed tie-break (−x, +x, −z, +z, down, up); the search never expands a voxel twice; on a dead end the emitted route walks back along its own path to the last branch (those voxels repeat in the output), so consecutive route points are always 6-adjacent; `blocks` = 4.3 × 60 = 258);
  - L13 after L12: the finder job finds the nearest entrance within 512 blocks of the camera at L13's start (L10's hover point, whose RD 12 disc is loaded; Spec correction 20); the camera flies to it at **(plan)** 64 blocks per second (cap 10 s), then follows `caveRoute` at 4.3 blocks per second, the eye 1.62 above the floor (`EYE`, `src/player/walk.ts:44`), no physics, for 60 s while the world streams;
  - the JSON's `caves` block: the route's kinds and length, frame p50, p95, p99, max, `over33`, main-thread p95, region buffer growth events, `timedOut`;
  - `BENCH_FRAME_CAPACITY` = 123,168 + 90 × 240 = 144,768.

- [ ] **Step 1: Write the tests** (`bench.test.ts`): the leg list ends `'L12', 'L13'`; `BENCH_FRAME_CAPACITY` 144,768 and the capacity rule (the script's sum fits); `caveRoute` on a fixture cave (a cheese room joined to a spaghetti tunnel) is the same route twice, prefers cheese, never enters solid, and stays one block above a floor; consecutive points are exactly 1 block apart, a dead end included (it walks back); L13's search starts at the camera's position when the leg starts; on a fake page L13 ends at its caps with `timedOut` naming the part; the `caves` block's fields and shapes.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/bench.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; **(plan)** one headless dry run of `?bench=medium` in the smoke's own Chrome (its own port and `mktemp -d` profile): L13 completes and the `caves` block is present (values not judged; the file not kept).
- [ ] **Step 5: Commit** `feat(bench): leg L13 walks a cave route found at the leg's start (SP6a D29)` (`git add src/ui/world/bench.ts src/ui/world/worldPage.ts test/unit/bench.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 46: Bench leg L14 (the X-ray); `measureChrome` → `assets/sp6a`

**Files:**
- Modify: `src/ui/world/bench.ts` (`'L14'`; `BENCH_XRAY`; the JSON's `xray` block; `BENCH_FRAME_CAPACITY`), `src/ui/world/worldPage.ts` (the bench's hooks: X, PageDown, the map side by side, the apply control, RD 16), `src/render/renderer.ts` (**(plan)** `xrayDrawCalls(): number` and `xrayVertexBytes(): number`: the pass-3 objects drawn in the last frame and their vertex bytes, numbers read per frame as `toolDrawCalls()` is, `renderer.ts:179`, since the recorder avoids per-frame objects, `bench.ts:393-397`), `test/tools/measureChrome.ts:71` (`ASSETS` → `'docs/superpowers/specs/assets/sp6a'`, its doc; Spec correction 10), `test/unit/measureChrome.test.ts` (the `ASSETS` pins), the SP6a spec (Spec correction 10)
- Test: `test/unit/bench.test.ts`, `test/unit/renderer.test.ts`, `test/unit/measureChrome.test.ts`. `test/unit/benchFiles.test.ts` stays on `assets/sp5c` (it reads committed files) until Task 47 moves it with them.

**Interfaces:**
- Produces:
  - **(plan)** `export const BENCH_XRAY = { holdS: 10, sweepS: 8, bandS: 4, refillMaxS: 20, rd16MaxS: 40 } as const;` (L14's `seconds` 82);
  - L14 after L13 at RD 12: X on; hold 10 s; a 360° sweep over 8 s; PageDown × 4 (one per second); the map side by side and `caves.cheese.offset` 0.27 → 0.20 through the apply control **(plan)** (cave_heavy's value, §4); wait for the refill (cap 20 s); X off; then RD 16 (`RD_MAX`, `src/engine/renderDistance.ts:10`): the disc filled (cap 20 s), X on, hold and sweep again, recorded, not gated;
  - the JSON's `xray` block: per segment frame p50, p95, p99, max, `over33`, main-thread p95; `gpuMs` p50 and p95 with the X-ray on and off; `gpuMB` (X-ray buffers included), `drawCallsMax`, `toggleMaxMs` (the longest frame within 2 frames of each toggle), `xrayVertexBytes`, the radius in force, region buffer growth events, `xrayApplyRefillMs` (from the release to the last column swapped); `timedOut`;
  - `BENCH_FRAME_CAPACITY` = 144,768 + 82 × 240 = 164,448.

- [ ] **Step 1: Write the tests.** `bench.test.ts`: the leg list ends `'L13', 'L14'`; the capacity 164,448; on a fake page L14's sequence (X, hold, sweep, four PageDowns, the Apply, the refill, X off, RD 16) in order with its caps; `xrayApplyRefillMs` measured from the release to the last swap; the `xray` block's fields. `renderer.test.ts`: `xrayDrawCalls()` counts the pass-3 objects drawn in the last frame and `xrayVertexBytes()` their vertex bytes. `measureChrome.test.ts`: `ASSETS` is `'docs/superpowers/specs/assets/sp6a'`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/bench.test.ts test/unit/renderer.test.ts test/unit/measureChrome.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; the dry run as Task 45's (L13 and L14 complete; the `xray` block present).
- [ ] **Step 5: Commit** `feat(bench): leg L14, the X-ray at RD 12 with a live cave edit and RD 16 recorded; measureChrome writes assets/sp6a` (`git add src/ui/world/bench.ts src/ui/world/worldPage.ts src/render/renderer.ts test/tools/measureChrome.ts test/unit/bench.test.ts test/unit/renderer.test.ts test/unit/measureChrome.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 47: GPU cells (Chrome, agent): every route into `assets/sp6a`; L13 and L14 gated

**STOP for the user before Step 1:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp6a/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `enter-iris-chrome.json`, `bench-rtx-chrome.json`, `enter-rtx-chrome.json`
- Modify: `test/thresholds.ts` (G1 rows; the comment), `test/thresholds.lock.json` (generated), `test/metrics/g1.metric.ts` (`ASSETS_SP5C` `:112` → `ASSETS_SP6A` for every read: G1, `G1.streaming`, `G1.live`, `G1.enter`, `G2.edit`, `G2.flush`, `G2.paste`; `checkBench`'s known legs L0-L14; two new calls), `test/unit/benchFiles.test.ts` (`ASSETS_SP5C` `:5-6` → the `assets/sp6a/` files committed here), master §6.4's G1 row (§13 item 18), `test/arch/masterSpec.test.ts`, the SP6a spec (Threshold log; `## Exit evidence`)

**Interfaces:**
- Produces: rows, each `activeFrom: 'SP6a'`: `G1` gains `caveP95: { max: 16.7 }`, `caveOver33: { max: 0 }`, `caveMainP95: { max: 6 }` (`metricTest('G1', […], …, { outName: 'G1.caves' })` from the `caves` block) and `xrayP95: { max: 16.7 }`, `xrayOver33: { max: 0 }`, `xrayMainP95: { max: 6 }`, `xrayGpuMB: { max: 150 }`, `xrayDrawCalls: { max: 100 }`, `xrayToggleMaxMs: { max: 33 }` (`{ outName: 'G1.xray' }` from the `xray` block's RD 12 segment); the shape checks: route, /Iris/, `batch`, rd 12, cold cache, L13's and L14's parts present. Recorded: the RD 16 segment, `gpuMs` on and off, `xrayVertexBytes`, growth events, `xrayApplyRefillMs`, the RTX files (`.out/G1.caves.others.json`, `.out/G1.xray.others.json`).

- [ ] **Step 1: Measure** (an agent; quiet machine; cold shader cache; touching no other process): `npm run measure:chrome -- --route bench --gpu iris --probe-only` (a refusal: back to the STOP); then `… --route bench --gpu iris` twice (both recorded, the second committed **(plan)**), `… --gpu iris --workers 4`, `… --route flight --gpu iris`, `… --route enter --gpu iris`, `… --route bench --gpu rtx`, `… --route enter --gpu rtx` (if the RTX probe refuses, **STOP**: the user switches to 'nvidia', the controller resumes with `claude --resume` and runs those two, then the user switches back to on-demand).
- [ ] **Step 2: Check.** Gated: L13's and L14's parts on both Iris bench runs; every earlier G1 part, `mediumFill4wMs` ≤ 6,000, `G2.edit`, `G2.flush`, `G2.paste` and `enterRatio` on the new files. `xrayApplyRefillMs` > 6,000 → **STOP for the user** (T-bound; a radius does not shorten it). A gate miss: **Task 48's levers in order** (each measured as this Step 1's Iris bench route before the next), then this task again from Step 1; no gate is loosened.
- [ ] **Step 3: The rows, the metric and the files in one commit.** SP6a describe: §6.4's G1 row contains L13's and L14's parts (`caves: frame p95 ≤ 16.7 ms, no frame > 33 ms, main thread p95 ≤ 6 ms; the X-ray at RD 12: the same, GPU ≤ 150 MB, draw calls ≤ 100, a toggle's frame ≤ 33 ms (SP6a, from L13 and L14)` **(plan)**), cross-checked against `THRESHOLDS`; `npm run test:accept-thresholds`; Threshold log: `- <date> — SP6a Task 47: G1 caveP95 max 16.7, caveOver33 max 0, caveMainP95 max 6 (G1.caves) and xrayP95 max 16.7, xrayOver33 max 0, xrayMainP95 max 6, xrayGpuMB max 150, xrayDrawCalls max 100, xrayToggleMaxMs max 33 (G1.xray), gated from SP6a on every tier from assets/sp6a/ (g1.metric.ts; spec §10.6, D29); G1's, G1.enter's, G2's cells re-read from assets/sp6a (D29); new parts (measured <values> on eDP-1 at 240 Hz).`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with G1, G1.streaming, G1.live, G1.enter, G1.caves, G1.xray, G2.edit, G2.flush and G2.paste asserted on the SP6a files.
- [ ] **Step 5: Commit** `feat(sp6a): the Chrome cells in assets/sp6a; L13 and L14 gated` (the six JSON files staged by explicit path, with `test/thresholds.ts test/thresholds.lock.json test/metrics/g1.metric.ts test/unit/benchFiles.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md`).

---

### Task 48: Levers III (conditional): the Chrome gates and L14's radius

Run only for a gate Task 47 measured as missed; each lever one commit, measured (Task 47 Step 1, the Iris bench route only) before the next; stop at the first that meets the gate. **STOP before each measurement** under Task 47's conditions (confirmed again after a resume or a sleep). Output-changing T levers would need a third output-changing push (`GENERATOR_VERSION` 8), so they are not here: a T-bound miss (the fill, `caveP95`) goes first to Task 37's output-keeping lever 15a if not applied, then to the user.

- [ ] **48a: L14's radius** (`xrayP95` or `xrayGpuMB` missed at RD 12): `xrayRadius` = the largest multiple of 16 blocks, from the fog end down, at which L14's RD 12 segment meets 16.7 ms **(plan)** (found by re-runs at fog end − 16·k), set in `setXray` and shown in the strip and the tab's readout ("· radius r"). Files: `src/render/renderer.ts` (`WorldRenderer.setXrayRadius(r)` → `MaterialSystem.setXray(on, yMin, yMax, radius)`), `src/ui/world/xrayStrip.ts` (`stripText(b, radius: number | null)` and `set(on, b, radius)` append ` · radius r` when a radius below the fog end is in force; Task 21's interfaces take none), `test/unit/xrayStrip.test.ts` (the new case), `src/ui/world/worldPage.ts` (the radius to the strip and to the Caves tab's `set(on, band, radius)`), `test/unit/renderer.test.ts`. Commit `perf(render): the X-ray's radius <r> at RD 12 (SP6a D10, L14)`.
- [ ] **48b: the staging** (growth events in L13 or L14 on a frame over 33 ms): the reservation of the pass that grew, from the files' measured use (Task 40's rule). Commit `perf(render): staging reservations from L13 and L14 (SP6a §5.1)`.
- [ ] **48c: the X-ray rows on demand** (D23's alternative; only when `mediumFill4wMs` or `caveP95` misses with the X-ray off and the mesh time is the cause): **STOP for the user** first (a behaviour change: a 1-3 s first toggle).
- [ ] **STOP:** a gate still missed after its levers: every measurement to the user (D25); no gate is loosened.
- [ ] Each lever: `npm run typecheck && npm test`; the golden check (no diff); the measurement recorded under Task 47's evidence.

---

### Task 49: Browser smoke: the `caves` step; the screenshots; the review links

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` `:526-541` gains `'caves'` between `'select'` and `'console'`, since `stepId` throws for a title it lacks; the step; `SMOKE_KEYS` from Task 20; `--shots`; `SP6A_SHOTS` listing the fourteen names beside `SP5C_SHOTS` `:1087-1093`), `test/unit/uiSmoke.test.ts`, the SP6a spec (`## Exit evidence`: the review links)
- Commit: `docs/superpowers/specs/assets/sp6a/review-*.png` (the shots below), `docs/superpowers/specs/assets/sp6a/caves.examples.json` (a committed copy of the git-ignored `test/metrics/.out/caves.examples.json`, `.gitignore:6`, made at push B's head after Task 38's tuning)

**Interfaces:**
- Produces: the `caves` step (§10.9) in `/?rd=4&renderer=batch&wiTest=1` at a cave pose from the committed `assets/sp6a/caves.examples.json` (mirrored as a literal, pinned by `uiSmoke.test.ts` against that committed copy, which the unit CI jobs can read): X shows the strip and hides the terrain (a pixel read of the clear colour `#0b0e14` at a sky pixel); PageDown changes the strip's band; Home restores "all"; L toggles night vision, the Settings checkbox follows and survives a reload; the Caves tab exists in the world's map and "Cave slice" opens the Density tab with the `caves` field; a cave parameter change regenerates (the HUD's stale count rises, then falls to 0); with the map side by side and a band slider focused, PageDown moves only the slider; `--shots` writes `review-xray.png`, `review-xray-band.png`, `review-entrance.png`, `review-ravine.png`, `review-cheese-pillars.png`, `review-spaghetti3d.png`, `review-spaghetti2d.png`, `review-noodle.png`, `review-worm.png`, `review-light-floor.png`, `review-night-vision.png`, `review-night-surface.png`, `review-slice-vertical.png`, `review-slice-horizontal.png` into the given directory.
- The review links (§10.10, D16): from the committed `caves.examples.json`, one `/?at=x,z&y=…&yaw=…&pitch=…#<seed 42 default hash>` per kind (cheese, pillars, spaghetti 3D, spaghetti 2D, noodle, entrance from the surface, worm, ravine; Task 32's poses) and one for a large interior, written into Exit evidence.

- [ ] **Step 1: Write** `uiSmoke.test.ts`. First run `npx vitest run --project metrics-quick test/metrics/caves.metric.ts` on push B's head and copy `test/metrics/.out/caves.examples.json` to `docs/superpowers/specs/assets/sp6a/caves.examples.json`. Then: the step's literals equal the key map's codes and the committed examples file's poses; the order test `:292-315` with `'caves'` immediately before `'console'` and `'select'` immediately before `'caves'` (its title gains SP6a's step); `SP6A_SHOTS` lists the fourteen names, and a test reads each from `docs/superpowers/specs/assets/sp6a/` as a PNG at `VIEWPORT` (1400 × 900), as `:1443-1451` does for SP5c's.
- [ ] **Step 2: Run** `npm run build && node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` (its own port and Chrome profile): green, `?selftest=1` 62/62, every step including `caves`; the shots reviewed for flat ends, cut tunnels and the light (risk 11's visual review, master :1721) and copied into `assets/sp6a/`.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(smoke): the caves step; SP6a's review shots and links` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md docs/superpowers/specs/assets/sp6a/caves.examples.json`, and the fourteen PNGs by explicit path).

---

### Task 50: Master pins and the obligations audit

**Files:**
- Modify: master §7 and §8 (§13 item 19), `test/arch/masterSpec.test.ts` (the header comment's SP6a paragraph completed), `CLAUDE.md` (the X-ray's keys, the Caves tab, night vision, the bench legs L13 and L14, the smoke's `caves` step, `measure:chrome`'s `assets/sp6a`), `README.md`, the SP6a spec (`## Exit evidence`: §17's table with each obligation's commit)

- [ ] **Step 1: Write the pins.** SP6a describe: §7 has a "Measured in SP6a" line naming `terrain.real` and `terrain.islands` with caves, `terrain.caves.warm`, `carver.paths`, `mesh.xray`, `slice.caves128`, `finder.nearest`, the kill-criterion ratio and the fill, each with its measured value; the T gate's text reads "gated as p50 ≤ 10, p99 ≤ 20 by `TERRAIN_P50_MAX_MS` and `TERRAIN_P99_MAX_MS`"; §8 risk 3 states which levers ran (Tasks 15, 37, 48); every §13 item 1-19 has a test in the describe (a list in the describe's header, checked by a test that counts them **(plan)**).
- [ ] **Step 2: The audit.** For every row of spec §17, the commit or the receiving SP's "Received from SP6a" line that places it; anything missing is a blocking finding for Task 52.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `docs(sp6a): §7 and §8 as measured; CLAUDE.md and README for the caves` (`git add docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md test/arch/masterSpec.test.ts CLAUDE.md README.md`).

---

### Task 51: The user's Firefox run

This task is the controller's and the user's.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp6a/selftest-firefox.json` (the user's reading, as SP5c's), `docs/superpowers/specs/assets/sp6a/bench-iris-firefox.json` (spec §10.6 and §16: "Firefox and the RTX recorded")

- [ ] **Step 1: STOP for the user.** The controller runs `npm run build`, then its own `npx vite preview --port 4173 --strictPort` (stopped only by the controller), and gives the user `http://localhost:4173/?selftest=1` (required: 62/62 and "IndexedDB contract: 10/10 passed") and `http://localhost:4173/?bench=medium` (required: L13 and L14 included; recorded, not gated).
- [ ] **Step 2: Record** the selftest and the bench file (L13 and L14 in Firefox) in the exit evidence.
- [ ] **Step 3: Commit** `docs(sp6a): the Firefox selftest` (the files by explicit path, and the spec).

---

### Task 52: Whole-branch review

- [ ] **Step 1:** The controller runs the final review of `git diff main...sp6a/cave-shapes` against the spec, this plan and Review Focus 1-5 (superpowers:requesting-code-review), the reviewer resolving its own cannot-verify items in the code at HEAD. Beyond the per-task reviews it checks what only the whole branch shows:
  - every `(plan)` decision is in the code as written, or its change is recorded in the spec; every Spec correction is reworded in the spec;
  - the golden diffs: push A's against c64b4a9 and push B's against push A's head list only §12.3's keys; `GENERATOR_VERSION` 7; no generator commit after push B;
  - the generator's determinism: no `Math.sin`/`cos`/`**` or clock in `gen/caves/*`; every carver path a pure function of (seed, kind, sx, sz, leaves); the carve's operation order identical in `carveColumn`, `carvedKind`, `carvedAt` and `referenceCarve`; DT1 (`carverCache`, `isolated`) and DT2 (`probeBulk`, `tagProbe`, `surfaceProbeBulk`) 0 on full;
  - the tag: one rule in `tags.ts` used by T, `caveTagAt`, `caveTagBatch`, the finder and the harness; the X-ray, the slice and the metrics read it, never a re-derivation;
  - the continuity rule: no hard switch outside an `interpolated` slot can change a voxel's sign (§1.3's list); every cap has its gentle part; the family floor holds over the static ranges;
  - SP5a-SP5c's rules still hold: zero allocation at rest (the X-ray on, night vision on), the layers, every existing key's meaning (Ctrl+X cut, plain X the X-ray), `?map` without the Caves tab, `wi10` unchanged, the saved-world migration only for the three built-in trees;
  - every disposer the strip, the tab, the finder job and the X-ray objects add is reached from the page's teardown;
  - the CI time against §11 (Tasks 16 and 39) and the masterSpec block's pins against spec §12's and §13's lists;
  - spec §14's hand-overs still true of the code as built (the `xray` pack's 4 reserved bits and pass 3 outside culling for SP6b; `aquifer.fluidAt`'s place in the carve loop and `waterDepth` for SP7; the shrink hook for SP9; the X-ray material in `render/materials` for SP11).
- [ ] **Step 2:** Each finding is fixed test-first in its module, one commit each (`fix(sp6a): …`); a finding that changes generated output or would loosen a gate goes to the user (a third output-changing push would bump to 8).
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:metrics`, `npm run test:goldens && git diff --exit-code HEAD -- test/goldens.json`, and the smoke again. Expected: PASS; no golden diff.

---

### Task 53: Exit: evidence and docs

**Files:**
- Modify: the SP6a spec (`## Exit evidence`, Status), `CLAUDE.md:9`, `README.md`, master §10 (the SP6a entry's "Received from SP3e" worded as delivered; the Cut line and the receivers worded by whether each cut-line item was taken), `test/arch/masterSpec.test.ts` (Task 1's receivers and Cut-line pins rewritten to the exit's wording)

- [ ] **Step 1: Exit checks** (spec §16): `npm run build && npm test && npm run test:metrics:full` (C1-C9, L2, S1 `grassSky0` ≤ 0.1 % and `grassNoSky` 0, DT1 with `carverCache` and `isolated`, DT2 with `tagProbe`, all on every tier); `npm run bench` within every gate (`terrain.real` and `terrain.islands` p50 ≤ 10, p99 ≤ 20; `slice.vertical128` and `slice.caves128` ≤ 300) and the +30 % rule; the kill-criterion ratio ≤ 25 % (or the amendment); `GENERATOR_VERSION` 7; `npx --yes bun@1 test/tools/goldensJsc.ts` 62/62; `?selftest=1` 62/62 in Chrome (the smoke) and Firefox (Task 51); `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` green.
- [ ] **Step 2: Master at the exit.** The SP6a entry's "Received from SP3e" line reads "(delivered: the SP6a spec §1.4, D8: no cave air at y ≥ 180, so water v0's island rule and the sky-open run stay exact; except the island branch over cave-hollowed summits → SP12 with the summit caps, the SP6a spec D31 and its Point 2)", pinned with `toBe`; the Cut line ends with whether each of §15's three items was taken ("It was not taken: …, so nothing moved" when all three shipped) and the receivers say the same (`SP6a underground-only carver and spaghetti-2D rarity bands → SP12 (delivered in SP6a, so nothing moved); SP6a cave finder → SP10 (delivered in SP6a, so nothing moved)`, or the cut wording); Task 1's pins rewritten to match, so `npm test` stays green.
- [ ] **Step 3: Exit evidence**, before the Threshold log: D25's prototype (Task 14) and its second checkpoint (Task 36) with the levers applied (Tasks 15, 37, 48); push A's and push B's golden diffs and CI runs job by job against §11; the bench's exit run and the kill-criterion ratio; L13 and L14 on the Iris Xe in Chrome, Firefox and the RTX, RD 16 recorded, `xrayApplyRefillMs`; each tuning part's measurement and the bound taken (Task 38); `islandBranchOnGround` before and after caves (Point 2); `landTopYmod16`; the review links; the review shots described; the selftests; the masterSpec pins of 'master spec amendments (SP6a §13)'; §17's audit (Task 50); the cut line as taken.
- [ ] **Step 4:** Status "implemented, awaiting CI, the production check and the user's check"; `CLAUDE.md:9` and `README.md` the same.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `docs(sp6a): exit evidence and docs` (`git add docs/superpowers/specs/2026-11-02-sp6a-cave-shapes-design.md docs/superpowers/specs/2026-09-26-architecture-design.md test/arch/masterSpec.test.ts CLAUDE.md README.md`).

---

### Task 54: Merge, production check, the user's check, SP6a complete

**STOP for the user's go-ahead** before Step 0.

- [ ] **Step 0: An SP5c world in production** (under Step 2's Chrome STOP conditions: PRIME on-demand, the display awake and unlocked): before the merge, while the production URL still serves SP5c, the agent's headful Chrome (a `mktemp -d /tmp/wi10-XXXX` profile the controller keeps until Step 2) opens the production URL and saves a world there. IndexedDB is per origin (`wi10`, `src/persist/saves.ts`), so a world saved on a local preview would not be visible in production.
- [ ] **Step 1:** Merge `sp6a/cave-shapes` to `main` and push; CI green, its wall recorded against §11's ≈ 3.0-3.4 min (above 3 min 30 s: Task 39's levers first).
- [ ] **Step 2: Production, headful** (spec §16), on the deployed build:
  - **Chrome** (RegionBatch; the agent's own headful Chrome on the Iris Xe, its own `mktemp -d` profile, `MESA_SHADER_CACHE_DISABLE=true` in its env only; **STOP** until the user confirms PRIME on-demand and the display awake and unlocked): the X-ray on and off, the band with PageDown, PageUp and Home, a live cave edit with the map side by side, night vision on and off, the light floor in a cave, a walk down an entrance; Step 0's SP5c world, opened in production from the same profile, shows the noise caves and the older-generator badge (D36); `?selftest=1` 62/62 and "IndexedDB contract: 10/10"; page and console errors 0;
  - **Firefox** (RegionMesh; **STOP for the user**, in the user's own Firefox, by hand, as SP5c's `production-check.json` records `firefox.by`): the same steps and production's `?selftest=1`;
  - the controller commits `assets/sp6a/production-check.json` (`docs(sp6a): the production check`).
- [ ] **Step 3: STOP for the user's check** (§10.11): "Bajar por una o varias entradas y recorrer los distintos tipos de cueva": from the review links or by flying, go down one or more entrances and walk through each kind of cave (the last criterion). Offered as optional steps (§10.11): the X-ray with the map side by side and a cave size changed; night vision and the light floor judged by eye (§6.1 leaves the floor's value to the user's eye). With the check, the controller shows the user `islandBranchOnGround` before and after caves (Task 33's `.out/S.islandBranchOnGround.json`, in Exit evidence), the record behind Point 2's "Accept until SP12" of the summit caps (spec Point 2, §16).
- [ ] **Step 4:** After the user's verdict (a finding goes back test-first, with another go-ahead before it reaches `main`; a retune is a third output-changing push, `GENERATOR_VERSION` 8), a final commit marks SP6a complete (`CLAUDE.md:9`, `README.md`, the spec's Status, the cut-line pin): `docs: SP6a complete`.

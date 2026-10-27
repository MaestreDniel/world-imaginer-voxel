# SP5a — Build and walk: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The world becomes a creative sandbox you can build in and walk through. LMB breaks, RMB places, MMB picks, with a crosshair and a black outline on the aimed block (reach 6 walking, 10 flying); a 9-slot hotbar (1-9 or the wheel) and a creative palette (E) of every placeable block in four groups with a search box; 25 appended block types (oak planks, oak logs by axis, cobblestone, bricks, clear framed glass, torches on floors and walls that emit light, ladders, ice, 16 wools); F switches flight and walking (a 0.6 × 1.8 body that collides, steps up 0.6, climbs ladders, swims in water and still bucket lava, slides on ice); a walking teleport lands on the ground; Ctrl+Z / Ctrl+Y undo blocks when the 3D has the controls (optionally, "Hold mouse button to repeat"). Underneath: a sim worker owning Published final sets, an edit writer, incremental relight, the in-memory DiffStore with read-through, the edit remesh at −1000. The generated world does not change (`GENERATOR_VERSION` 5, the 59 goldens byte-identical).

**Architecture:**
- **Blocks.** 25 types appended (ids 25 … 57, `stateCount` 58), `SOUND` `wool` 12, `world/blocks/tags.ts` (`PLACEABLE`, `CATEGORY`, `SLIPPERY`, `CLIMBABLE`, display names); colours ≥ 24 apart per type; the state-id lock grown once.
- **Store.** Wrap-aware reclamation (STORE-3, D24); view-free `blockAt`/`fluidAt`/`publishedAt`/`diffFlag` (D25); the copy-on-write edit writer `reopenPublished` with `replaceBlocks`/`replaceLight`/`publish` and `patchHeightmaps` (D18).
- **Light.** The scan gate on `REC_DIFF_FLAG` with descending seeds (D23); `light/relight.ts` over a sparse 3 × 3 accessor (D19).
- **Sim.** `sim/diffStore.ts` (D20) and `sim/edits.ts` (`applyEdits`: validate, write, relight, record, the dirty set); `workers/simHandler.ts` + `sim.worker.ts` (thread 15), spawned by `engine/simClient.ts` (D17).
- **Engine.** D's overlay through the decorate message's `diff` and the read-through adapter (D21); the pool's edit lane (−1000 on the aux lane, `cancelWorld` over both lanes); the coordinator's `editState`/`simPin`/`simUnpin`/`markEdited`/edit queue (D22).
- **Measured early** (D30): the page's edit path and the bench leg L10, then an early `editVisibleP95` on the Iris Xe, before the polish; D30's three levers as conditional tasks.
- **Rendering.** `mesh/boxes.ts` (torch, wall torch, ladder), cutout/water culling, the log-end and lava layers at `stateCount` and `stateCount + 1`, the glass frame bit 30, still lava; `render/selection.ts` (outline at `renderOrder` 3); near plane 0.05 walking.
- **Player and UI.** `player/raycast.ts`, `interaction.ts`, `hotbar.ts`, `physics.ts`, `walk.ts`; the key map's `build` group; `ui/palette.ts`, `ui/world/buildHud.ts`, `blockHistory.ts`, `editPath.ts`, `editLatency.ts`; `WorldSettings.holdRepeat`.
- **Measurement.** L3 and E5's session part (`test/metrics/edit.metric.ts`), `relight.edit` in `npm run bench`, `integration/edit.test.ts`, the smoke's `build` and `walk`, G2's edit part from the committed Iris Xe Chrome file (`assets/sp5a/`).

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`), three r186 (`~0.186.1`), Chrome 155 over CDP for the browser tools, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md` (approved 2026-10-27, "Aprobada"; the binding authority, with the user's five answers under Points for the user: glass clear with a thin frame in the cutout pass; `ice` added; `oak_planks` and `oak_log`; today's Minecraft water, in-water gravity 0.005; "Hold mouse button to repeat" as a setting, off by default). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Recon behind the spec: `.superpowers/sp5/recon-{obligations,engine,blocks,player-ui}.md`, `review-technical.md`, `builder-check.md`, `revise-notes.md` (git-ignored; the controller has them). Template: the SP4c plan.

**Plan form.** Compact, as SP4a's, SP4b's and SP4c's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies (sketched only for the relight BFS and the swept-AABB loop, whose order the tests do not pin); the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` 4c41cfb (code identical to 9d28951, the spec's citation base: `git diff --stat 9d28951 4c41cfb` touches only the spec).

**Spec corrections found while planning** (each folded in by the task named, the first one when it names two; the controller rewords the spec in that task's commit, whose `git add` includes `docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`):
- **Only `engine/` spawns workers** (§2.1 "The world page spawns it"): `test/arch/rules/imports.ts`'s `worker-edge` rule ("only engine/ may spawn workers"); every `new Worker` is under `src/engine/` (`workerPool.ts:833`, `capabilities.ts:56`, `spikeStore.ts:38`). A new `src/engine/simClient.ts` (`createBrowserSim`, `createSimClient`) spawns `sim.worker.ts` and owns the entry set and the `diff` waits; the page calls it. The module layout gains it. Task 10.
- **The sim's message guard cannot live in `sim/`** (§2.1 "a pure handler `sim/edits.ts`"): `LAYER_RULES.sim` value-imports `L2_CORE` only (`imports.ts:11`, `:27`), not `workers/protocol.ts`. `sim/edits.ts` is the pure core (`applyEdits`, `readDiff`); the guard and the dispatch are `workers/simHandler.ts` (`createSimHandler`), which `sim.worker.ts` wires as `task.worker.ts` wires `taskHandler.ts`. `buildNodeTaskWorker` imports `createTaskHandler` and drains every `LIMBO_RETRY_MS` (`test/harness/nodeWorker.ts:53-75`): it gains `factory` and `retryMs` options so the integration test runs the sim's own entry with its 100 ms drain (§6.3). Task 10, Task 38.
- **`replaceBlocks` is a `ColumnWriter` method too** (§2.2, §2.5): D's overlay writes through D's writer, a `ColumnWriter` reopened at Proto (`workers/worldJobs.ts:39`), and `gen/` sees only `world/store/api.ts`'s types (`imports.ts:17`). `ColumnWriter` gains `replaceBlocks` and `setDiffFlag`; the edit writer extends them; master §2.5's `interface ColumnWriter` names both, since `masterSpec.test.ts:142-146` requires it to name exactly api.ts's methods (spec §9 gains that §2.5 line). With a diff, D's heightmaps read its rebuilt scratch sections, since `nb.final` is null below Decorated (`store.ts:123-124`). Task 5, Task 11.
- **§8's moved pins miss five, and SP8a's header keeps a bare SP5** (§8, §9): §9's own rewordings break `masterSpec.test.ts:938` (§3.7, `(SP5)`), `:946` (§5.6, `(SP5: …)`), `:987` (§4.1, both SP5 mentions), `:999` (§5.1, SP5's fork dialog) and `:1006` (risk 1's Kill line, `SP5's sim worker`), which §8's list leaves out; and SP8a's header (master :1881) ends "in parallel with SP5-SP7", which §9's SP8a item does not reword and the bare-SP5 test (Task 43) would refuse: it becomes "in parallel with SP5a-SP7". Task 1.
- **The gate is `editState(cx, cz): 0 | 1 | 2`, not a boolean `editable(cx, cz)`** (§2.1, §6.3, the module layout): the page and the block history must tell "not loaded" (1) from "regenerating" (2, stale after an Apply) to word their refusals (D13). Task 13.
- **The provisional box table lives in `world/blocks/provisionalBoxes.ts`, not only in `mesh/boxes.ts`** (§1.3, the module layout): the raycast (`player/`) tests the boxes, and `player/` may not import `mesh/` even as a type (`imports.ts:30`); `world/blocks/**` is value-importable by both `mesh/` and `player/`. `mesh/boxes.ts` keeps `meshBoxes`; master §1's blocks entry names the new file (provisional until SP8a). Task 20.
- **Cutout and box faces are culled against lava as against water** (§1.3, D12's "never two faces flickering"): bucket lava is an opaque face drawn against non-occluding neighbours, so beside glass, ice or a ladder's boundary face it would be coplanar with them. The culling rule reads "water or lava". Task 20.
- **The empty bucket stops at the first block on the ray** (§3.5, §4.2 "the first voxel with fluid on the ray"): read literally, it drains water behind a stone wall within reach. It hits the first voxel with fluid and misses at the first other non-air state (a box state by its box). Task 22.
- **An undo's or redo's `expect` when the other side has no entry** (§4.5 "each with the other side's value as `expect`"): an entry side of `NO_ENTRY` holds no voxel value, and the voxel then holds its generated value, which the main thread reads now (`blockAt`/`fluidAt` inside a read section). Task 28.
- **The streaming edit sample runs in L10's closing flight, not "during L9's flight"** (§6.2): L9 is an instant 20,000-block teleport that hovers (`bench.ts:84-98`, speed 0), and the camera's 3 × 3 is unpublished right after it. L10 ends with a 6 s flight east at 20 blocks/s while the pool streams, 20 edits one every 250 ms; `BENCH_FRAME_CAPACITY` 58,368 (243 s at 240 Hz; the need is 241 s) in place of 57,344 ("239 s", in fact 238.9 s). Task 17.
- **The smoke's torch check reads block light, with no night setup** (§6.4 "a torch at night raises the block light"): block light does not depend on the time of day, and T only cycles the time speed (`keymap.ts:45`); the night look is the review shot `build-night`'s. Task 39.
- **The review shots carry the renderer in their names, and the pool is placed** (§6.5): `measureChrome.ts:131` refuses `--shot` without `--renderer`, and a shot's file is `review-<shot>-<renderer>.png` (`:141-142`, pinned by `measureChrome.test.ts:77-80`, the SP4c precedent `review-teleport-batch.png`): `review-build-day-batch.png`, `review-build-night-batch.png`, `review-walk-water-batch.png`, `review-glass-water-batch.png`. "Swimming at a lake's surface" and "ice beside a lake" become a placed pool (`REVIEW_POOL`) at L10's hover point, so the shots do not depend on a lake near it. Task 40.
- **The DDA and the walk step cannot call `lookVector`/`forwardXZ`** (§3.5 "along `lookVector` (`fly.ts:48-51`) … Zero allocation"): both return a fresh tuple per call (`fly.ts:43-51`). `player/fly.ts` gains `lookVectorInto(out: Float64Array, yawDeg, pitchDeg): void` (the same formula), which the DDA and the walk step use. Task 22.
- **"The frame the edited column's new mesh is shown" needs a staging signal** (§4.6, §6.2): `onColumnRevealed(cx, cz)` carries no seq (`render/sectionRenderer.ts:156`), and an older payload staged before the edit can still reveal after it. The coordinator calls `CoordinatorOptions.onEditStaged?(cx, cz)` when it stages a payload issued at or after the slot's latest `markEdited`; the first reveal of that column after it is the edit's. Task 14, Task 16.
- **The decorate message's diff is cloned, not transferred** (§2.5): the pool posts every job without a transfer list (`workerPool.ts:434`); a diff is a few KB. Only the sim's `diff` reply is transferred (§2.1). Task 11.
- **The `relight.edit` row records `test/baselines.json` once** (§6.2, §8 "No other lock changes"): `BENCH_ROWS` must all be recorded (`test/bench/gates.ts:47-52`: "a row added without `npm run bench:record` cannot stay ungated"). `baselines.json` is not a lock; it changes once, in Task 37, on a quiet machine. Task 37.
- **Pins the spec's §6.3 lists leave out:** `test/unit/blockDefs.test.ts:53-54` (every type without props), `:57-62`, `:97-108` and `:113-123` (bare keys, zero past the states, identity rotations over every state), `test/unit/surfaceSource.test.ts:168` (air the only non-colliding state), `test/unit/keymap.test.ts:25` (the action count), `:30` (`since` SP4a or SP4c), `:15`, `:82`, `:99-106` and `:117-118` (the wheel's key, `KeyF` unbound, `resolveWheel`'s signature, wheel labels), `test/unit/help.test.ts:57` (the group headings), `test/unit/flatColors.test.ts:45-54` (layer = state, extended by the two extra layers). Task 2, Task 21, Task 24.

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin. A `.mjs` module a TS test imports gets a sibling `.d.mts`.
  - **No new dependencies.**
- **Layers** (`test/arch/rules/imports.ts`; no rule changes, every new module sits in an existing layer):
  - `sim/` (`diffStore.ts`, `edits.ts`) is a pure layer (`banned.ts:9`: no `document`, `window`, `localStorage`) that value-imports `L2_CORE` only (core, world, gen, textures, audio, light, mesh, sim, persist): never `workers/` or `engine/`; its clock is injected.
  - `workers/sim.worker.ts` and `workers/simHandler.ts` are `workers` (value: `L2_CORE`, metrics, daynight, workers); the sim's messages live in `workers/protocol.ts`, which `engine` may value-import (`imports.ts:28`).
  - `engine/simClient.ts` spawns the sim (only `engine/` spawns workers); `engine` value-imports core, world, engine and `workers/protocol.ts`, never `sim/`, render or ui.
  - `light/relight.ts` imports `world/blocks/**`, `world/store/padded.ts` and `light/` values and `world/store/api.ts` types only; `light/`, `mesh/` and `world/blocks/` are hot prefixes (`banned.ts:30`): imported bindings read through top-level aliases in loops.
  - `player/` (`walk.ts`, `physics.ts`, `raycast.ts`, `interaction.ts`, `hotbar.ts`) value-imports core, world, daynight, player and `workers/protocol.ts`, engine and render as types only (`imports.ts:30`); `player/` is not a pure layer, but **(plan)** its storage is injected (`Pick<Storage, 'getItem' | 'setItem'> | null`), as `ui/settings.ts` does.
  - three only in `render/` (`render/selection.ts`); `render/materials/**` imported only from `render/`; GLSL only in `render/materials/**/*.glsl.ts`.
  - `gen/**` exports no numeric constants (`patchHeightmaps` is a function); `world/blocks/` (`tags.ts`) follows the core determinism rules (`DET_DIRS`, `banned.ts:27`); `ui` and `main` anything but `render/materials/**` and `*.worker.ts`.
- **Pure and deterministic layers.** `core/` follows the Math allowlist; `core/`, `world/`, `gen/` and `DET_FILES` use no `Math.random`, `Date.now`, `performance.now`, `console.*`; pure layers no DOM globals.
- **The generated world does not change.** `GENERATOR_VERSION` stays 5; `test/goldens.json` (59 goldens) and `test/schema-shape.lock.json` stay byte-identical. `test/stateIds.lock.json` grows **once**, in Task 2, by `npm run test:accept-state-ids` (append-only, no id changed; the commit says so, `test/arch/stateIds.test.ts:6-7`). Every task that touches `gen/`, `workers/`, `world/store/` or `light/` (Tasks 3-6, 9-12, 15, 21) runs `npm run test:goldens`, then `git diff --exit-code main -- test/goldens.json`; if the run rewrote anything, restore with `git checkout main -- test/goldens.json` and find the bug.
- **Governance.**
  - `test/thresholds.lock.json` changes only in Task 1 (`startedSps`), Task 36 (L3 and E5) and Task 41 (G2), always through `npm run test:accept-thresholds`; each such commit adds one line to the SP5a spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`); `2026-10-2X` in the log lines below stands for that commit's date. Every new part is new (a tightening); no gate is loosened.
  - Master amendments land in the commit spec §8 assigns (the split's in the first commit; the rest with what they describe), each pinned in a new `describe('master spec amendments (SP5a §9)')` in `test/arch/masterSpec.test.ts`, created by Task 1, with the moved earlier pins (`masterSpec.test.ts:917`, `:961-971`, `:1094`). **(plan)** A table `SP5A_MODULES: Array<[head: RegExp, token: string, file: string]>` in that describe, "§1 names each SP5a module in its entry, which exists" (the `SP4C_MODULES` pattern, `:921-929`, `:1080`); the tasks that create a module append its row. At the exit, the bare-SP5 test (Task 43): a bare `SP5` only in the split paragraph and the pinned historical receivers (the SP4 precedent, `:693-697`).
- **Master amendments by task** (spec §9; each pinned in the SP5a describe by the task that lands it): Task 1: §10's split paragraph and the SP5a, SP5b and SP5c entries, SP6, SP7, SP8a (its "in parallel with SP5a-SP7" too, a Spec correction) and SP8c, the Default receivers, the critical path, the parallelism and visible-value lines, SP4a's start-menu parenthesis, SP10's and SP8b's "Received from SP5a" lines, §0.7, §1's settings-block line, the renames of §2.3, §2.5 (`SubProjectId`, `setLight`), §3.7, §4.1, §5.1, §5.6 and risk 1, §4.12's "(SP8a)" and "(SP7)"; Task 2: §2.2's four lines; Task 5: §2.5's `interface ColumnWriter` (`replaceBlocks`, `setDiffFlag`; a Spec correction); Tasks 2, 7-10, 20, 22, 23, 26-28, 31: §1's module lines (`SP5A_MODULES` heads: `/^\s+blocks\/kinds\.ts /` for `tags.ts` (Task 2) and `provisionalBoxes.ts` (Task 20), `/^\s+light\/initial\.ts /`, `/^\s+sim\/fluidSim\.ts /`, `/^\s+workers\/protocol\.ts /`, `/^\s+coordinator\.ts /` for `simClient.ts`, `/^\s+mesh\/greedy\.ts /`, `/^\s+renderer\.ts /` for `selection.ts`, `/^\s+player\/fly\.ts /`, `/^\s+ui\/world\/\* /`, the ui line naming `palette.ts`); Task 8: §2.7; Task 13: risk 7; Task 24: §4.17's Fly line, §5.9; Task 28: §4.12's block-undo paragraph; Task 29: §4.12's Actions; Task 31: §4.17's Walk lines; Task 36: §6.4's E1-E6 and §1's test entry (`edit.metric.ts`); Task 38: §1's test entry (`edit.test.ts`); Task 41: §6.4's G2 and §4.12's Target; Task 45: the cut-line wording.
- **Zero allocation** (SP4b D25): the frame step at rest allocates nothing, SP5a's additions included: the walk step (its view-free reads), the DDA, the outline update with scalars, the hotbar and HUD refresh at rest. Pinned per module in its task and together in Task 35.
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit.
- **CI time budget** (spec §7, against SP4c's last run on `main`, 40389787923, 3 min 13 s): `check` ≈ 95-105 s, `unit (heavy)` ≈ 90-95 s, `unit (rest)` ≈ 150-165 s, metrics-fast `rest` ≈ 75-85 s, metrics-quick `render` ≈ 100-115 s; wall ≈ 3.2-3.3 min, metrics-quick `terrain` (173 s) still the long pole. If `unit (rest)` passes 173 s, `relight.test.ts` and `coordinator.test.ts` move to `heavy` (`unitShards.mjs`). Above 3 min 30 s at the exit, the named lever first: `edit.metric.ts` into a metrics-quick shard of its own.
- **GPU measurements** (spec §6.2, as SP4c):
  - **Chrome cells** are an agent's, through `npm run measure:chrome -- --route bench|flight --gpu iris|rtx`, on a cold driver shader cache (`MESA_SHADER_CACHE_DISABLE=true` for the Iris Xe, `__GL_SHADER_DISK_CACHE=0` for the RTX, in the tool's own Chrome's env only; never `~/.cache/mesa_shader_cache` or any user cache), on the laptop panel eDP-1 at 240 Hz with the user's display awake and unlocked, on a quiet machine (the tool refuses above a 1-minute load of 2). The Iris Xe needs PRIME **on-demand**; the RTX Chrome cell runs as SP4c's (offload variables and ANGLE Vulkan under on-demand), and if its probe refuses, under **'nvidia'**. Only the user switches PRIME; a switch logs the user out and ends the session, which the controller resumes with `claude --resume`.
  - **Firefox runs** are the user's, on a local `vite preview` the controller serves on **port 4173**: the selftest (59/59) is required, a Firefox bench file optional (spec §6.2).
- **Where the plan stops for the user** (each marked **STOP** in its task): Task 18 (the early G2 measurement: PRIME on-demand, display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running); Task 19, when it runs, before each lever's measurement (Task 18's conditions) and if `editVisibleP95` still misses after D30's three levers (the measurements go to the user); Task 41 (same conditions as Task 18; the RTX cell under 'nvidia' if its probe refuses, then back to on-demand); Task 42 (the user's Firefox selftest on 4173, required, and the optional Firefox bench); Task 45 (the go-ahead to merge; PRIME on-demand and the display awake for the agent's headful Chrome production check; the user's own Firefox production steps and production selftest, as in SP4c, `assets/sp4c/production-check.json` `firefox.by`; the user's check, the last criterion). The controller never switches PRIME and never runs the user's check for the user.
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and preview the controller serves runs on its own free port (**never 5183**, the user's compose service; **never 4190** for Firefox: the Firefox preview is 4173) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never open, close or touch the user's own browsers; no `xdotool` or any desktop input.
- **Outward-facing actions.** Pushing the branch is the controller's call (Task 36 pushes it for the first CI run). Merging to `main`, pushing `main` and the production check happen in Task 45, after the user's go-ahead. Read-only git otherwise; never rewrite history. `.superpowers/` is never committed.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways the user, building and walking, would see SP5a break, most likely first; each names the test that pins it and the task that owns it.

1. **Fast clicking and hold-repeat while the edited column remeshes.** Clicks every 50 ms (or held LMB with the setting on) land while the previous edit's MESH is in flight or staged and not yet shown: `meshSeq` bumps drop raced MESHes, the restage replaces a pending payload, and a double click on one voxel races `expect`. A person expects every click to show, none lost, no stale mesh left. Task 14 pins "10 `markEdited` of one column 20 ms apart while each fake MESH settles 30 ms after issue: never two MESHes of the slot in flight, every raced result counted in `editDropped` (not `dropped`), no `staged over a pending payload` throw, and the column ends staged with the 10th `editSeq`"; Task 29 pins "held LMB for 1.0 s with each reply 50 ms after its post: breaks posted at 0, 0.3, 0.6 and 0.9 s, each after the previous reply, each retargeted from that frame's aim and one history step; no `changed` refusal".
2. **Undo bursts across columns being regenerated.** Ctrl+Z held (key repeat every 33 ms) after building across a border, with a map Apply in flight: some steps' 3 × 3 is stale. A person expects the steps that can be undone to undo in order and the one that cannot to say why and stay. Task 28 pins "12 undos 33 ms apart, step 3's column stale (`editState` 2) until the 8th press: steps 1-2 undone, every press from the 3rd to the 7th refused with `Can't undo there: regenerating` with step 3 still on top, the 8th undoes step 3, and no press runs before the previous reply"; Task 38 runs the real-store version (undo of all 50 after an Apply, equal to `genRegion` on the Apply's params with no diff).
3. **Walking into unloaded or regenerating columns.** Walking east at full speed off the loaded disc, or standing on ground an Apply frees and rebuilds higher. A person expects to be held up (not fall into the void) and to end standing on the new ground, never inside it. Task 31 pins "walking east at 4.4 blocks/s from a Published column onto a non-Published one: `vy` 0 and y unchanged for 40 ticks while x keeps growing by 0.2203 per tick and nothing in the unpublished column collides"; Task 34 pins "the column under the feet re-published with ground 3 blocks above the feet: on the next tick the feet are at the first free y (the ground's top), then the body falls normally".
4. **Torches, glass and water at column borders and corners.** A torch at a column corner lights four columns; glass or water on a border changes the neighbour's faces; a stale border face is a visible seam. Task 9 pins, on a canned 5 × 5 store (stone up to y 69, air above), "a torch at world (15, 70, 15) of column (0, 0): `dirty` is exactly {(0, 0), (1, 0), (0, 1), (1, 1)}; glass at (16, 70, 5), which changes no light: (0, 0) is dirty through the block ring alone; bucket water placed into air at (0, 70, 0): (−1, −1), (−1, 0), (0, −1) and (0, 0) are dirty"; Task 14 pins "after each of 200 random edits, border and corner ones included, every column of the edited column's 3 × 3 (and every column of `dirty`) re-meshed from scratch equals the payload staged".
5. **Flying away and back, and a map Apply over a build.** A build left behind, freed and regenerated (with a torch beside a border so a neighbour regenerates alone), or a terrain Apply while an edit is still in flight. A person expects the build back at the same coordinates, lit the same, on the new terrain after an Apply. Task 13 pins "a stale column pinned by an edit at `apply` is freed after `simUnpin` with no camera move"; Task 36 pins E5 (`sessionStale` 0, `sessionLightMismatches` 0, the race with a 20 ms reply and the teleport in the same frame, the neighbour regenerated alone); Task 38 pins "a terrain Apply (`density.detailAmpHi` 4.0) after 50 edits: the inner region equals `genRegion` on the new params with the same entries".

## Branch

Task 1 creates `sp5a/build-and-walk` from `main`: `git switch main && git switch -c sp5a/build-and-walk`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP5a; the split | §8, §9 (split, §10, receivers, renames), D27 |
| 2 | Registry: the 25 types, `wool`, `tags.ts`, colours; the state-id lock | §1.1, §1.3 (colours), D11 |
| 3 | STORE-3: wrap-aware reclamation | §2.1, D24 |
| 4 | View-free reads: `blockAt`, `fluidAt`, `publishedAt`, `diffFlag` | §1.2, §3.2, D25 |
| 5 | The edit writer and `patchHeightmaps` | §2.2, D18 |
| 6 | The scan gate and descending seeds | §1.2, D23 |
| 7 | Incremental relight: `light/relight.ts` | §2.3, D19 |
| 8 | The DiffStore | §2.4, D20 |
| 9 | `sim/edits.ts`: validate, write, relight, record, the dirty set | §2.1, §2.2, §2.6, D17 |
| 10 | The sim worker: protocol, `simHandler.ts`, `sim.worker.ts`, `engine/simClient.ts` | §2.1, D17 |
| 11 | D's overlay and the decorate message's diff | §2.5, D21 |
| 12 | Pool: the edit lane | §2.6, D22 |
| 13 | Coordinator I: `editState`, `simPin`/`simUnpin` | §2.1, §2.7, D22 |
| 14 | Coordinator II: `markEdited`, the edit queue, restaging | §2.6, D22 |
| 15 | Read-through and the sim failure path | §2.1, §2.5, D21 |
| 16 | The page's edit path, the test hook, the edit latency | §2.6, §4.6, D16 |
| 17 | Bench leg L10; `measureChrome` → `assets/sp5a` | §6.2, D26 |
| 18 | The early G2 measurement | D30 |
| 19 | D30's levers (conditional) | D30 |
| 20 | Provisional boxes and culling | §1.3, D12 |
| 21 | Log ends, the glass frame, still lava | §1.3, D12, Point 1 |
| 22 | Raycast | §3.5, D8 |
| 23 | The outline and the frame's second read section | §3.5, §3.1 (near plane), D8 |
| 24 | Input and the key map | §4.1, D6, D9 |
| 25 | Interaction rules | §4.2, D7 |
| 26 | Hotbar and the build HUD | §4.3, D9 |
| 27 | The creative palette | §4.4, D10 |
| 28 | Block undo and redo | §4.5, D13 |
| 29 | Hold to repeat | §4.1, D6, Point 3 |
| 30 | Physics: the swept AABB and step-up | §3.2, D25 |
| 31 | The walk controller at 20 Hz | §3.2, §3.3, D2-D5, Point 5 |
| 32 | Modes: F and the frame step's dispatch | §3.1, D1 |
| 33 | The walking teleport | §3.4, D15 |
| 34 | Unstuck | §3.2, D29 |
| 35 | HUD, help and tips; zero allocation of SP5a's frame | §4.6, D16 |
| 36 | L3 and E5: `edit.metric.ts` and its rows (first CI run) | §6.1, §7, D26 |
| 37 | `relight.edit` in `npm run bench`; `light.column` re-measured | §6.2 |
| 38 | Integration: `edit.test.ts` | §6.3 |
| 39 | Browser smoke: `build` and `walk`; `overlay`'s Ctrl+Z | §6.4 |
| 40 | The bench's review scenes | §6.5 |
| 41 | GPU cells (Chrome, agent): the bench files, G2's row, G1 re-pointed, the review shots | §6.2, §6.5 |
| 42 | The user's Firefox run | §6.2, §12 |
| 43 | Whole-branch review; the bare-SP5 rule | §5, §8, §12 |
| 44 | Exit: evidence and docs | §12 |
| 45 | Merge, production check, the user's check, SP5a complete | §12 |

The order is D30's: governance; the registry with the lock; the store; light; the sim, DiffStore and overlay; the coordinator and the pool; the page's edit path and L10 measured early, before any polish; then the meshers, the player, the UI and the metrics; the integration test, the smoke, the GPU cells and the screenshots; docs.

---

### Task 1: Governance: start SP5a; the split

**Files:**
- Modify: `src/core/ids.ts` (doc comment :1-7 gains the split; `SubProjectId` :9-10 and `SUB_PROJECTS` :13-16 replace `'SP5'` with `'SP5a', 'SP5b', 'SP5c'`; `CURRENT_SP` :24 and its comment :22; `:26`'s "E1-E6 expanded" → "E1-E7 expanded"), `test/harness/sp.ts` (`SP_DEPS` :17-22 per D27; `STARTED_SPS` :35 appends `'SP5a'`)
- Modify (pins): `test/arch/sp.test.ts` (:18-22, :34-45, :57-64, :76-79), `test/unit/profiles.test.ts:26`, `test/arch/masterSpec.test.ts` (`:917`, `:961-971` and `:1094` moved into a new `describe('master spec amendments (SP5a §9)')` with `SP5A_MODULES` empty; `:938`, `:946`, `:987`, `:999` and `:1006` updated in place to §9's rewordings, a Spec correction)
- Modify (comments, spec §8): `src/gen/pipeline/decorateStage.ts:11`, `src/world/store/reclaim.ts:10`, `src/world/store/store.ts:91`, `src/world/store/api.ts:60`, `src/engine/coordinator.ts:108` (SP5a); `src/ui/help.ts:2`, `src/ui/world/applyControl.ts:11`, `:65`, `src/ui/world/worldPage.ts:1770`, `src/ui/settings.ts:3`, `src/ui/world/startScreen.ts:7` (SP5b); `src/player/keymap.ts:8` (SP10)
- Modify: master (§10 split paragraph and the three entries; SP6, SP7, SP8a, SP8c; Default receivers; critical path; parallelism; visible value; SP4a's start-menu parenthesis; SP10's and SP8b's "Received from SP5a"; §0.7; §1's settings-block line; §2.3, §4.1, §8 risk 1; §2.5's `SubProjectId` and `setLight` comment; §3.7; §4.12's "(SP8a)" on doors, trapdoors, fence gates, stairs, slabs, double plants and "(SP7)" on step 2's fluid ticks; §5.1; §5.6), `test/thresholds.lock.json` (generated), the SP5a spec's `## Threshold log`, `CLAUDE.md:9`, `README.md:9`
- Spec: Spec corrections (§8's moved pins; SP8a's "in parallel with SP5a-SP7")

**Interfaces:**
- Produces: `SUB_PROJECTS` has 24 ids with `'SP5a', 'SP5b', 'SP5c'` between `'SP4c'` and `'SP6'`; `SP_DEPS`: `SP5a: ['SP4b', 'SP4c']`, `SP5b: ['SP5a']`, `SP5c: ['SP5b']`, `SP6: ['SP3c', 'SP5c']`, `SP7: ['SP6', 'SP5a']`, `SP8c: ['SP7', 'SP5a']` (SP8a stays `['SP4a']`); `STARTED_SPS` ends `'SP4c', 'SP5a'`; `CURRENT_SP === 'SP5a'`. No profile has `readyFrom: 'SP5'` (`src/core/params/profiles.ts:21-38`), so readiness does not change.

- [ ] **Step 0:** `git switch main && git switch -c sp5a/build-and-walk`.
- [ ] **Step 1: Update the pinned tests first.**
  - `sp.test.ts`: ":18-22" title "SP5a has started and is the current SP (SP5a spec §8)", the list ends `'SP4c', 'SP5a'`, `CURRENT_SP` and `currentSpOf(STARTED_SPS)` `'SP5a'`; ":34-45" "SP_DEPS covers all 24 sub-projects" with the new `SP_ORDER` and deps array (`SP_DEPS.SP5a`, `.SP5b`, `.SP5c`, `.SP6` = `['SP4b', 'SP4c'], ['SP5a'], ['SP5b'], ['SP3c', 'SP5c']`); ":57-64" paths through `'SP5a', 'SP5b', 'SP5c', 'SP6', 'SP7', 'SP8c'`, "SP8c without SP7 is rejected"; ":76-79" "SP6 needs SP3c and SP5c".
  - `profiles.test.ts:26`: `CURRENT_SP` is `'SP5a'`.
  - The SP5a describe: "the split": the master contains `SP5 was split on 2026-10-27 into SP5a (build and walk), SP5b (saved worlds) and SP5c (the selection tool), proposed in brainstorming because it grew past M and accepted by the user ("Vamos con esta partición")`; `spEntry('SP5a', 'SP5b')` starts ``**SP5a — Build and walk** (L; SP4b, SP4c). Spec: `2026-10-27-sp5a-build-and-walk-design.md` `` and contains `**Deliverable:** build and walk in the world; edits kept for the session.`, `**Exit:** as the SP5a spec §12`, `walk mode's teleport (the SP4c spec §3.5)` and a line starting `- **Cut line:** palette search (→ SP10)`; `spEntry('SP5b', 'SP5c')` starts `**SP5b — Saved worlds** (M; SP5a)` and contains `saved places as a section of each saved world's map`; `spEntry('SP5c', 'SP6')` starts `**SP5c — The selection tool** (M; SP5b)`; the receivers contain `SP5a palette search → SP10; SP5b worlds-menu polish → SP10` and still `SP4b deferred-reclamation primitive → SP5 (delivered in SP4b, so nothing moved);`; the critical path contains `SP4c → SP5a → SP5b → SP5c → SP6`; SP7's entry no longer contains `swimming` nor `the empty bucket`; SP10's entry has a line starting `- Received from SP5a (its spec §10; amended by SP5a): sneaking`; SP8b's `- Received from SP5a (its spec §10, D20, D23):`; §0.7 contains `region editing tools beyond SP5c's selection tool (sphere fill, brushes)`; §2.5's `setLight` comment contains `SP5a's relight`; §3.7 contains `in walk mode (SP5a)`.
  - Moved pins: `:917`'s `spEntry('SP5', 'SP6')` → `spEntry('SP5a', 'SP5b')`; `:961-971`'s SP4c test uses `spEntry('SP4c', 'SP5a')`, `:969-970` become `expect(spEntry('SP5a', 'SP5b')).toContain('walk mode\'s teleport (the SP4c spec §3.5)')` (§9's SP5a entry does not carry the SP5 entry's whole teleport sentence), and `:971`'s saved-places string is read unchanged from `spEntry('SP5b', 'SP5c')`; `:1094`'s `spEntry('SP4c', 'SP5')` → `spEntry('SP4c', 'SP5a')`.
  - Pins §9 rewords in place (a Spec correction; each takes the amended text as §9 words it): `:938` the Teleport line's `in walk mode (SP5)` → `in walk mode (SP5a)`; `:946` `saved places per saved world (SP5: …)` → `(SP5b: …)`; `:987` both SP5 mentions → SP5a (`the sim worker's ownership, SP5a,` and `the sim worker (SP5a) stays its first writer`); `:999` `…the hooks Apply and SP5b's world-modification mode attach to (the fork dialog is replaced, the SP5a spec's split).`; `:1006` `SP5a's sim worker is deferred reclamation's first necessary consumer` (risk 1's Kill line: Task 1 renames its `SP5's sim worker` to `SP5a's sim worker`, together with `SP3a-SP5` → `SP3a-SP5b`).
  - The SP8a header: `spEntry('SP8a', 'SP8b')` contains `in parallel with SP5a-SP7` and `SP5a for collision/raycast/orientation against boxes` (a Spec correction for the first).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (`CURRENT_SP` `'SP4c'`, no SP5a header).
- [ ] **Step 3: Implement.** `ids.ts`, `sp.ts`, the comments and the master as spec §9 words each item, plus SP8a's "in parallel with SP5a-SP7"; the spec's §8 list of moved pins gains `masterSpec.test.ts:938`, `:946`, `:987`, `:999` and `:1006`, and §9's SP8a item the "in parallel with SP5a-SP7" wording (the Spec corrections); `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP5a Task 1: startedSps gains 'SP5a' (spec §8).`; `CLAUDE.md:9` and `README.md:9`: SP4c complete, SP5 split into SP5a, SP5b and SP5c (2026-10-27), SP5a (build and walk) in progress.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `chore(sp5a): start SP5a; split SP5 into SP5a, SP5b and SP5c` (`git add src/core/ids.ts test/harness/sp.ts test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts test/thresholds.lock.json src/gen/pipeline/decorateStage.ts src/world/store/reclaim.ts src/world/store/store.ts src/world/store/api.ts src/engine/coordinator.ts src/ui/help.ts src/ui/world/applyControl.ts src/ui/world/worldPage.ts src/ui/settings.ts src/ui/world/startScreen.ts src/player/keymap.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md CLAUDE.md README.md`).

---

### Task 2: Registry: the 25 types, `wool`, `tags.ts`, colours; the state-id lock

**Files:**
- Modify: `src/world/blocks/defs.ts` (append after `light_gray_terracotta`, :60), `src/world/blocks/kinds.ts` (`SOUND_VALUES` :78 appends `'wool'`, `SOUND_WOOL = 12`; the frozen-list comment :1-3), `src/world/blocks/index.ts` (state-id exports of the new types), `src/world/blocks/fluid.ts` (`LAVA_SOURCE = 32` beside `WATER_SOURCE`, :13), `src/textures/flatColors.ts` (25 colours and `LAVA_COLOR`), `src/ui/crossSection/voxels.ts` (`VOXEL_COLORS` :38-68)
- Create: `src/world/blocks/tags.ts`, `test/unit/blockTags.test.ts`
- Modify (tests): `test/unit/blockDefs.test.ts` (:41-55, :53-54, :57-62, :64-68, :93-95, :97-108, :113-123), `test/unit/surfaceSource.test.ts:168`, `test/unit/blockRegistry.test.ts:45-47`, `test/unit/flatColors.test.ts:31-32`, `test/unit/crossSectionVoxels.test.ts` (:62-80 per type, :96-106 the legend), `test/unit/uiSmoke.test.ts:167-172`, `test/stateIds.lock.json` (generated once), `test/arch/masterSpec.test.ts`
- Master: §2.2's box-model line, `PLACEABLE` and `category` line, ice line, enum-code line (spec §9); §1's `blocks/kinds.ts registry.ts …` entry: `tags.ts` gains "(SP5a)" (spec §9's §1 line), so the entry reads `tags.ts (SP5a)`

**Interfaces:**
- Produces (spec §1.1): in this order, `oak_planks`, `oak_log` (`props: [{ name: 'axis', kind: 'axis', default: 'y' }]`), `cobblestone`, `bricks`, `glass`, `torch`, `wall_torch` (`facing` facing4, default north), `ladder` (`facing` facing4, default north), `ice`, then `white_wool` … `black_wool` in spec §1.1's order; the values of spec §1.1's table, `CARVABLE` false, `REPLACEABLE` false, `TINT` none, `FACE_TEX` 0. **(plan)** The property's name is `facing` (`axis` for the log), the kind's own name, as the registry's keys spell them (`oak_log[axis=y]`).
- `tags.ts` (per type id, `Uint8Array(typeCount)` tables built once from names; no new per-state table, so `sp3aGoldens.ts:52`'s digest list is unchanged): `PLACEABLE`, `CATEGORY` (codes **(plan)** `CATEGORY_VALUES = ['none', 'building', 'wool', 'terrain'] as const`), `SLIPPERY`, `CLIMBABLE`, `displayName(typeId): string` ("Oak planks", "Light blue wool", "Grass block"), `CATEGORY_ORDER: readonly ['building', 'wool', 'terrain']`.
- `LAVA_COLOR` (outside `FLAT_COLORS`; `VOXEL_COLORS.lava`), every new colour ≥ 24 (summed |ΔRGB|) from every other type, sky, water, lava and unknown; the seven clashing candidates (`recon-blocks.md` §4) move the new colour, never the old.

- [ ] **Step 1: Write the tests.**
  - `blockDefs.test.ts`: "50 types, 58 states; the 25 SP3a/SP3c types keep ids 0 … 24; the appended types at 25 … 57 in spec §1.1's order"; "props only on `oak_log` (axis, default y), `wall_torch` and `ladder` (facing4, default north)"; spec §1.1's table row by row (`OPACITY`, `PASS`, `SHAPE`, `FULL_FACES`, `EMIT`, `COLLIDE`, `FLUID_MODE`, `SOUND`) on every state of each new type; "every `EMIT` in the registry is 0 or 14" (Task 6's two seed passes rely on it). `COUNT` stays 25 (the SP3a/SP3c states): `:57-62` (bare keys), `:93-95` (face textures) and `:113-123` (identity rotations and mirrors) stay over `ids(25)`; `:97-108`'s zero-past check uses `R.stateCount` (58) in place of `COUNT`. Per new type: "the keys `oak_log[axis=x|y|z]`, `wall_torch[facing=…]` and `ladder[facing=…]` parse back"; "`rotateState(oak_log[axis=x], 1)` is `axis=z` and `axis=y` is fixed"; "`wall_torch` and `ladder` turn north → east → south → west under q 1, and q 4 is the identity"; "`mirrorState` flips `facing` across its axis" (spec §6.3's `rotateState` on the new types).
  - `surfaceSource.test.ts:168`: `expect(solid).toBe(REGISTRY.stateCount - 10)` (air, torch, the 4 `wall_torch` and the 4 `ladder` states have `COLLIDE` none).
  - `blockRegistry.test.ts:45-47`: `SOUND_VALUES` ends `'abyss', 'wool'`; `SOUND_WOOL` is 12; every earlier code unchanged.
  - `blockTags.test.ts`: `PLACEABLE` false only for `air` and `wall_torch`; `CATEGORY` building = the 7 of spec §1.1, wool = the 16, terrain = stone, bedrock, ice and the 22 SP3c types, none = air and wall_torch; `SLIPPERY` = {ice, packed_ice}; `CLIMBABLE` = {ladder}; `displayName` of `oak_planks`, `light_blue_wool`, `grass_block` = "Oak planks", "Light blue wool", "Grass block".
  - `flatColors.test.ts:31-32`: 49 names; `crossSectionVoxels.test.ts:62-80`: per type (a log's three states share one colour), ≥ 24 apart from every other type, sky, water, lava (`LAVA_COLOR`) and unknown; `:96-106` and `uiSmoke.test.ts:167-172`: the legend lists the 58 keys.
  - SP5a describe: §2.2 contains `(SP5a: torch, wall torch and ladder use SHAPE box with provisional boxes and FULL_FACES 0, so a torch's light leaves its voxel)`, `in SP5a, in \`tags.ts\`, with \`SLIPPERY\` and \`CLIMBABLE\``, `(SP5a appends \`ice\`)` and `, wool 12 (SP5a; a value list only appends, and no code changes)`; `SP5A_MODULES` row `[/^\s+blocks\/kinds\.ts /, 'tags.ts (SP5a)', 'src/world/blocks/tags.ts']` (master §1's `blocks/kinds.ts registry.ts …` entry, whose continuation names `tags.ts`).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/blockDefs.test.ts test/unit/blockRegistry.test.ts test/unit/blockTags.test.ts test/unit/flatColors.test.ts test/unit/crossSectionVoxels.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; then `npm run test:accept-state-ids` once (33 entries appended, ids 25 … 57; no id changed). The master §2.2 lines as spec §9 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`, `git diff main -- test/stateIds.lock.json | grep -c '^-  '`. Expected: PASS; no golden diff; 0 removed lines in the lock.
- [ ] **Step 5: Commit** `feat(blocks): 25 building types, wool sound, tags and colours; stateIds.lock.json appended (33 states, ids 25-57)` (`git add src/world/blocks/defs.ts src/world/blocks/kinds.ts src/world/blocks/index.ts src/world/blocks/fluid.ts src/world/blocks/tags.ts src/textures/flatColors.ts src/ui/crossSection/voxels.ts test/unit/blockDefs.test.ts test/unit/surfaceSource.test.ts test/unit/blockRegistry.test.ts test/unit/blockTags.test.ts test/unit/flatColors.test.ts test/unit/crossSectionVoxels.test.ts test/unit/uiSmoke.test.ts test/stateIds.lock.json test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 3: STORE-3: wrap-aware reclamation

**Files:**
- Modify: `src/world/store/reclaim.ts` (`drain` :125-147, `enterRead` :152-158), `test/unit/reclaim.test.ts`

**Interfaces:**
- `drain` (D24): `m` = the epoch `e` of the live, non-dead reader with the largest `(G − e) | 0` (G = `Atomics.load(r, R_EPOCH)`); with no live reader every entry is freed; otherwise frees the ring prefix while `((tag − m) | 0) < 0`.
- `enterRead` never announces 0: **(plan)** a loaded G of 0 is moved to 1 with `Atomics.compareExchange(r, R_EPOCH, 0, 1)` and reloaded, before the announce and in the re-check loop.

- [ ] **Step 1: Write the tests** (the buffer's `R_EPOCH` set with `Atomics.store` before the scenario):
  - "G at 2³¹ − 3: reader A enters (2³¹ − 3); four releases take tags 2³¹ − 3 … −2³¹ (wrapping); reader B enters at −2³¹ + 1; drain frees nothing; A exits: drain frees the four releases tagged before B's epoch and keeps none older than B";
  - "two readers either side of the wrap (A at 2³¹ − 1, B at −2³¹ + 2): `m` is A's; a release tagged −2³¹ + 1 stays until A exits";
  - "no live reader: a drain after the wrap frees every entry"; "a dead reader is ignored on either side of the wrap";
  - "with G stored as 0, `enterRead` announces 1 and G reads 1".
  - SP4b's suite unchanged.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/reclaim.test.ts`. Expected: FAIL (the numeric minimum picks the newer reader).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `fix(store): wrap-aware reclamation epochs (STORE-3)` (`git add src/world/store/reclaim.ts test/unit/reclaim.test.ts`).

---

### Task 4: View-free reads: `blockAt`, `fluidAt`, `publishedAt`, `diffFlag`

**Files:**
- Modify: `src/world/store/store.ts` (`VoxelStore` :85-160; implementations beside `lightAt` :591-597), `test/unit/store.test.ts`, `test/unit/zeroAlloc.test.ts`

**Interfaces:**
- Produces (D25, §1.2; modelled on `lightAt`, no view, no allocation):
  - `blockAt(bx: number, by: number, bz: number): number` — the state; −1 when the column is not Published; for a Published column `BEDROCK` below y −64 and `AIR` above y 319 (as `padded.ts:160-162`), never a `RangeError`;
  - `fluidAt(bx, by, bz): number` — the fluid byte; 0 when not Published or outside −64 … 319;
  - `publishedAt(bx: number, bz: number): boolean` — the column of block (bx, bz) is Published (block coordinates, as the other reads);
  - `diffFlag(cx: number, cz: number): boolean` — `Atomics.load` of `REC_DIFF_FLAG` (`columnTable.ts:40`) of the record holding (cx, cz); false when none holds it.

- [ ] **Step 1: Write the tests** (`store.test.ts`, a real shared store with one Published column built by the region harness): "`blockAt`/`fluidAt` equal `final(cx, cz).block`/`.fluid` at 2,000 random voxels"; "y −65 → `BEDROCK`, y 320 → `AIR`, fluid 0 there"; "a Decorated or absent column → −1, 0, false"; "`diffFlag` false after a claim; true after `Atomics.store(ints, base + REC_DIFF_FLAG, 1)`; false again after `freeColumn` and a new claim". `zeroAlloc.test.ts`: "10,000 `blockAt`, `fluidAt` and `publishedAt` calls allocate nothing".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/store.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(store): view-free blockAt, fluidAt, publishedAt and diffFlag` (`git add src/world/store/store.ts test/unit/store.test.ts test/unit/zeroAlloc.test.ts`).

---

### Task 5: The edit writer and `patchHeightmaps`

**Files:**
- Modify: `src/world/store/api.ts` (`ColumnWriter` gains `replaceBlocks`, `setDiffFlag`; new `EditWriter`; the `setLight` comment), `src/world/store/store.ts` (`reopenPublished`; the writer's new methods), `src/gen/pipeline/finalHeightmaps.ts` (`patchHeightmaps`)
- Create: `test/unit/editWriter.test.ts`
- Modify (tests): `test/unit/finalHeightmaps.test.ts`, `test/unit/storeReopen.test.ts`, `test/unit/decorateStage.test.ts` (:62-73, the `ColumnWriter` fake gains `replaceBlocks: () => { calls.push('replaceBlocks'); }` and `setDiffFlag: () => { calls.push('setDiffFlag'); }`, so the call-order assertions hold without a diff), `test/unit/terrainStage.test.ts` (:397-410, the fake gains `replaceBlocks() { throw new Error('the T stage writes no final set'); }` and `setDiffFlag() { throw new Error('the T stage sets no diff flag'); }`), `test/arch/masterSpec.test.ts`
- Spec: Spec corrections (`replaceBlocks` on `ColumnWriter`, master §2.5)
- Master: §2.5's `interface ColumnWriter` gains `replaceBlocks(sy:number, blocks:Uint16Array, fluid:Uint8Array): void /* copy-on-write, blocks and fluid only (SP5a) */;` and `setDiffFlag(): void /* REC_DIFF_FLAG (SP5a) */` (`masterSpec.test.ts:142-146` already checks the method set; the SP5a describe pins the two comments)

**Interfaces:**
- `ColumnWriter.replaceBlocks(sy: number, blocks: Uint16Array, fluid: Uint8Array): void` — both channels through `storeChannel`'s copy-on-write (`section.ts:73-96`), meta recomputed (`store.ts:354-357`), sets `wroteBlocks` only (never `wroteLight`, unlike `setFinal`, `store.ts:380`).
- `ColumnWriter.setDiffFlag(): void` — `Atomics.store(ints, base + REC_DIFF_FLAG, 1)`.
- `interface EditWriter { readonly cx: number; readonly cz: number; replaceBlocks(sy, blocks, fluid): void; replaceLight(sy: number, light: Uint8Array): void; setDiffFlag(): void; aux(): AuxView; publish(): void; rollback(): void }` — `replaceLight` copy-on-write with no light-once refusal (`api.ts:57-63`); `publish()` bumps `blockVersion` when blocks or fluid were written and `lightVersion` when light was, since the last `publish`, and never touches the status; the stale guard of `store.ts:311-320` on every call. **(plan, for Task 9's `StoreFull` rollback)** Each `replaceBlocks`/`replaceLight` retains the entry's previous code (`pool.retain`, or keeps the uniform code) until `publish` (which releases them) or `rollback()` (which re-points every replaced entry to its retained code with no `pool.alloc`, retires the new slots and clears the pending bumps; re-allocating would fail in the pool that has just run out, and the replaced slot sits in limbo under the sim's own read section, `reclaim.ts:169-179`). The heightmaps are not the writer's: Task 9 re-runs `patchHeightmaps` after a rollback.
- `VoxelStore.reopenPublished(cx: number, cz: number): EditWriter` — throws `reopenPublished: (cx, cz) is not Published` unless the record holds (cx, cz) at status 3; `aux()` views the record's slot.
- `patchHeightmaps(blockAt: (lx, y, lz) => number, fluidAt: (lx, y, lz) => number, aux: AuxView, lx: number, lz: number, fromY: number): void` — rescans `worldSurface`, `motionBlocking`, `oceanFloor` and `lightBlocking` of block column (lx, lz) top down from `fromY` with `writeFinalHeightmaps`'s predicates (`finalHeightmaps.ts:34-65`), in place (element-wise Int16 stores; the one in-place write on the edit path, spec §5). `fromY` is the scan's first y, never above 319: the caller's `min(319, max(edited y, oldWorldSurface − 1, oldMotionBlocking − 1, oldOceanFloor − 1, oldLightBlocking − 1))` (a heightmap value is already y + 1, up to 320, `finalHeightmaps.ts:2-4`, `TOP_Y` 319 at `:27`). The scan's initial `above` is `blockAt(lx, fromY + 1, lz)`, or air when `fromY` is 319, as predicate N needs.

- [ ] **Step 1: Write the tests.**
  - `editWriter.test.ts` (a Published column whose final blocks share the proto's slots, `shareFinal`): "`replaceBlocks` leaves the proto's section unchanged: its slot's words are equal before and after, and the proto entry's code is the same; the slot's `refcount` is 2 before (shared by the final), stays 2 while another reader holds the release in limbo, and is 1 after that reader exits and the drain runs (1 at once with no reader); the final reads the new values from a different slot"; "`replaceBlocks` then `publish` bumps `blockVersion` by 1 and `lightVersion` by 0, and the status stays 3"; "`replaceLight` over a dense light entry succeeds, the old slot goes through `retire` (in limbo under a reader), `publish` bumps `lightVersion` only"; "a `publish` with nothing written bumps nothing"; "`rollback` after `replaceBlocks` and `replaceLight` re-points both entries to their previous codes with no `pool.alloc` call (a counting pool), retires the new slots, and a later `publish` bumps nothing"; "after a `publish`, the retained previous codes are released (the old slot's `refcount` back to its value without the writer)"; "`reopenPublished` on a Decorated column throws; on a freed and re-claimed record every call throws `WriterStale`"; "`setDiffFlag` makes `diffFlag` true".
  - `finalHeightmaps.test.ts`: "after each of 300 random voxel edits (place and break stone, glass, water, ice at random heights, edits at y 319 and y −64 included), `patchHeightmaps` of that block column from the caller's `fromY` leaves aux A equal to a full `writeFinalHeightmaps` over the same final, and reads no y above 319".
  - SP5a describe: §2.5's `interface ColumnWriter` contains `replaceBlocks(sy:number, blocks:Uint16Array, fluid:Uint8Array): void /* copy-on-write, blocks and fluid only (SP5a) */` and `setDiffFlag(): void /* REC_DIFF_FLAG (SP5a) */`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/editWriter.test.ts test/unit/finalHeightmaps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** No path of `EditWriter` writes a dense block or fluid slot in place.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(store): the copy-on-write edit writer for Published columns; patchHeightmaps` (`git add src/world/store/api.ts src/world/store/store.ts src/gen/pipeline/finalHeightmaps.ts test/unit/editWriter.test.ts test/unit/finalHeightmaps.test.ts test/unit/storeReopen.test.ts test/unit/decorateStage.test.ts test/unit/terrainStage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 6: The scan gate and descending seeds

**Files:**
- Modify: `src/light/initial.ts` (`lightRegion` :184-245), `src/workers/worldJobs.ts` (`fillColumnL` :55-67), `test/unit/lightInitial.test.ts`, `test/integration/worldJobs.test.ts`

**Interfaces:**
- `lightRegion(s: LightScratch, t: LightTables = TABLES, mayEmit = true): void` — the block BFS runs when `(mayEmit && tableEmits(t.emit)) || anyLava(fluid)`; its seeds are pushed in two passes over the region, level 15 first, then every other `effEmit > 0` (the registry's emitters are 0, 14 and lava's 15, pinned in Task 2), so the FIFO BFS stays monotone and each voxel is pushed at most once per BFS (`initial.ts:70-74`). The default `true` keeps L1, L2 and every caller unchanged.
- `fillColumnL` passes `mayEmit` = some column of the 3 × 3 has `store.diffFlag` set.

- [ ] **Step 1: Write the tests.**
  - `lightInitial.test.ts` (registry tables, a canned region): "a torch voxel and no lava: `mayEmit` false leaves every block light 0; `mayEmit` true lights the torch at 14 falling by 1 per step"; "lava anywhere scans with `mayEmit` false"; "a torch beside a lava voxel: the queue's high-water mark (a counting wrapper) stays ≤ the region's voxel count and the result equals `referenceLight`"; "the default call equals today's output on L1's regions".
  - `worldJobs.test.ts`: "an L whose 3 × 3 has no flag skips the scan (a torch written into a neighbour's final set stays unlit); with the neighbour's `REC_DIFF_FLAG` set, the torch's light enters the L's column".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/lightInitial.test.ts`, `npx vitest run --project integration test/integration/worldJobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npx vitest run --project metrics-quick test/metrics/light.metric.ts`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; L1 `mismatches` 0, L2 0; no golden diff.
- [ ] **Step 5: Commit** `feat(light): the emitter scan only where an emitter can be; seeds by descending level` (`git add src/light/initial.ts src/workers/worldJobs.ts test/unit/lightInitial.test.ts test/integration/worldJobs.test.ts`).

---

### Task 7: Incremental relight: `light/relight.ts`

**Files:**
- Create: `src/light/relight.ts`, `test/unit/relight.test.ts`
- Modify: `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `light/relight.ts`)
- Master: §1's light line gains "(SP5a)" for `relight.ts` (spec §9)

**Interfaces:**
- Coordinates local to the edited column's 3 × 3: x, z in 0 … 47 (block x = 16·(cx − 1) + x), y in 0 … 383 (block y + 64); index `(y·48 + z)·48 + x` (< 2²⁰).
- `interface RelightAccess { block(i: number): number; fluid(i: number): number; light(i: number): number; setLight(i: number, v: number): void; lightBlocking(x: number, z: number): number }` — `lightBlocking` after the edit (row 0 … 384, as `rowOf`); `setLight` marks its column's section dirty.
- `interface RelightScratch` — two Int32 rings of 2²⁰ entries (`index << 4 | level`), the per-column report; `createRelightScratch(): RelightScratch`.
- `interface RelightReport { readonly sections: Uint32Array /* 9 columns, bit sy: a light voxel changed */; readonly edges: Uint8Array /* 9 columns, bits W 1, E 2, N 4, S 8, NW 16, NE 32, SW 64, SE 128: a changed voxel lies on that border or corner */ }`; column index `dz·3 + dx` (0 … 8).
- `relight(a: RelightAccess, s: RelightScratch, i: number, before: { readonly state: number; readonly fluid: number; readonly lightBlocking: number }, t?: LightTables): RelightReport` — after the voxel at `i` was written; the result equals a full `lightRegion` of each column of the 3 × 3 (spec §2.3).
- The BFS, per channel (block, then sky), **(plan: the order the tests do not pin)**:
  ```
  removal ring R, re-add ring A
  block: if old effEmit(i) or the old light at i can no longer hold (new effOpacity higher, a full face added):
           push (i, old level) on R, set 0
  sky:   for y in the column (x, z) of i between before.lightBlocking and lightBlocking(x, z):
           closing (new > old): each voxel in [old, new) with sky 15 → push (v, 15) on R, set 0
           opening (new < old): each voxel in [new, old) → set sky 15, push on A
         and as block, for the voxel i itself
  while R: pop (u, lu); for each neighbour n reachable by propagate's rule (no full face either side):
           ln = level(n); if ln > 0 and ln < lu and not (sky and n at or above its column's lightBlocking): set 0, push (n, ln)
           else if ln >= lu (or n is a fall voxel): push n on A
  new sources: effEmit(i) > 0 → set i's block level, push on A; an opened voxel: push its six neighbours on A
  y 383 with an open top face takes 15 − max(1, effOpacity) from above (initial.ts:217-232's seed)
  propagate A with initial.ts:83-113's rule (cost max(1, effOpacity), strict increase only)
  ```
  The BFS never visits a voxel outside the 3 × 3 (a change reaches at most 14 voxels from `i`, master §4.8).

- [ ] **Step 1: Write the tests** (canned worlds of 5 × 5 columns; the stub `RelightAccess` on typed arrays covers the inner 3 × 3, local x, z 0 … 47; the initial light and the reference are `lightRegion` (`mayEmit` true) of each of the inner 9 columns, each over its own 3 × 3 within the 5 × 5; every edit, the random ones included, lies in the centre column (local x, z 16 … 31), which the "at most 14 voxels from `i`" bound needs; "equals" compares every voxel of the inner 3 × 3):
  - **block light:** "a torch placed in a closed room, then removed: equals after each"; "a stone placed between a torch and the wall it lit, then removed"; "a torch beside lava, the lava removed"; "a waterlogged ladder placed in a torch's light (fluid effective opacity 1)";
  - **sky:** "a 1 × 1 shaft of 12 blocks opened into a closed 5 × 4 × 5 room: the shaft is 15 its full height, the room lit; closed again: equals the closed state"; "glass and ice placed in the sky fall (ice filters by 1, glass by 0)"; "an edit at y 319 with and without an open top";
  - **full faces:** "an injected table with a partial full face blocks across it" (`lightInitial.test.ts`'s injected-table pattern);
  - **the report:** "a torch at local (15, y, 15) of the centre column in open air: `sections` and `edges` mark the centre's E, S and SE edges and the E, S and SE columns"; "a removal whose changed voxels stay inside the centre column 2 blocks from every border: `edges` of the centre 0";
  - "500 random edits in the centre column of a canned 5 × 5 (seeded, stone, glass, ice, torch, wall torch, water, lava, at y 0 … 383): equals after each".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/relight.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** (hot-loop aliases, `banned.ts:30`).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(light): incremental relight with the sky re-seed` (`git add src/light/relight.ts test/unit/relight.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 8: The DiffStore

**Files:**
- Create: `src/sim/diffStore.ts`, `test/unit/diffStore.test.ts`
- Modify: `src/world/store/api.ts` (`ColumnDiff`), `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `sim/diffStore.ts`)
- Master: §2.7's generated-value line (spec §9); §1's `sim/` line gains "(SP5a)" for `edits.ts diffStore.ts`

**Interfaces:**
- `NO_ENTRY = 0xFFFFFFFF`; a value is `state << 8 | fluid`.
- `interface ColumnDiff { readonly sy: Uint8Array; readonly idx: Uint16Array; readonly value: Uint32Array }` (canonical order: sy ascending, then idx) — **(plan)** declared in `world/store/api.ts` as a type, so gen, workers, engine and sim share it.
- `interface DiffStore { get(cx: number, cz: number, sy: number, idx: number): number /* NO_ENTRY */; set(cx, cz, sy, idx, value): void; remove(cx, cz, sy, idx): void; has(cx, cz): boolean; columnDiff(cx, cz): ColumnDiff | null; columns(): IterableIterator<number> /* colKeys */; readonly size: number }`; `createDiffStore(): DiffStore` over `Map<colKey, Map<sy, Map<idx, u32>>>` (master §2.7); empty maps are deleted.

- [ ] **Step 1: Write the tests:** SP5a describe: §2.7 contains `(SP5a: an edit equal to the column's current generated value, read from its retained proto, removes the entry)`, and §1's `sim/` line names `edits.ts diffStore.ts` with "(SP5a)"; "set, get, remove round-trip"; "`columnDiff` is canonical whatever the insertion order, and null for a column without entries"; "removing a column's last entry removes the column (`has` false, `columns()` without it, `size` 0)"; "the store never drops entries on its own (1,000 sets over 30 columns: all retrievable)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/diffStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): the in-memory DiffStore` (`git add src/sim/diffStore.ts src/world/store/api.ts test/unit/diffStore.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 9: `sim/edits.ts`: validate, write, relight, record, the dirty set

**Files:**
- Create: `src/sim/edits.ts`, `test/unit/simEdits.test.ts`
- Modify: `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `sim/edits.ts`)

**Interfaces:**
- `interface Edit { readonly x: number; readonly y: number; readonly z: number; readonly op: 'set' | 'revert'; readonly value: number; readonly expect: number }`.
- `type EditRefusal = 'unloaded' | 'changed' | 'noProto' | 'full'`. Both are declared here and re-exported as types by `workers/protocol.ts` (Task 10), from which `player/`, `engine/` and `ui/` import them (`player/` may not import `sim/`, even as a type, `imports.ts:30`).
- `interface EditResult { readonly prev: Uint32Array; readonly dirty: Float64Array /* colKeys */; readonly entryCols: Float64Array; readonly refused: EditRefusal | null; readonly relightMs: number; readonly editMs: number }`.
- `createEditScratch(): EditScratch` (the relight scratch, section scratch `Uint16Array(4096)`/`Uint8Array(4096)`, the sparse 3 × 3 accessor that reads sections in place and copies a section's light on its first write, D19).
- `applyEdits(store: VoxelStore, diffs: DiffStore, s: EditScratch, edits: readonly Edit[], now: () => number): EditResult` — inside one `enterRead`/`exitRead`:
  - **validate all first** (spec §2.1, L14): each voxel's column and its 3 × 3 at status 3 (`'unloaded'`), its current value equals `expect` (`'changed'`), `store.proto(cx, cz)` not null (`'noProto'`); any refusal refuses the batch with nothing written;
  - **then per edit** (spec §2.2): `reopenPublished`; the section into scratch; set the voxel (`revert`: the proto's value); `replaceBlocks`; `setDiffFlag`; `patchHeightmaps` from the `fromY` of Task 5 (the old heights read before the write); `relight`; `replaceLight` of each dirty light section; the DiffStore: `revert` removes, a `set` equal to the proto's value removes, else sets; `prev[k]` the entry before (or `NO_ENTRY`);
  - `publish()` on each written column once at the end;
  - **`StoreFull`**: the partial writes undone with no allocation: `rollback()` on every `EditWriter` the batch opened (Task 5), then `patchHeightmaps` re-run on each restored block column, the DiffStore restored from `prev`; `refused: 'full'`;
  - **`dirty`** (spec §2.6): every column whose padded view holds a changed voxel: the edited column, the face and diagonal neighbours whose one-voxel ring holds a changed block or fluid voxel (local x or z 0 or 15), and from the relight report each column with a changed section plus the neighbours its `edges` bits face;
  - `entryCols`: every column with entries after the batch.

- [ ] **Step 1: Write the tests** (a store filled to 'L' by the region harness, seed 42, 5 × 5 columns, `threads: 1`, `retainAllProtos` semantics: protos kept; the dirty-set cases on a canned 5 × 5 store instead: stone up to y 69 and air above, written with the store's writers, lit by `lightRegion` and Published, protos retained):
  - "a place: the voxel reads the value, `prev` `NO_ENTRY`, the entry set, `REC_DIFF_FLAG` set, `blockVersion` + 1, the 3 × 3's light equals a fresh `lightRegion`";
  - "a `set` to the proto's value removes the entry; `revert` writes the proto's value and removes it";
  - "a batch of 3 whose 2nd `expect` is stale: `refused` `'changed'` and nothing written (every version and value unchanged)"; "a voxel of a column whose 3 × 3 has a Decorated neighbour: `'unloaded'`"; "a column whose proto was freed: `'noProto'`";
  - "`StoreFull` on the 2nd edit (a store whose `maxBlockBytes` leaves room for one slot): `refused` `'full'`; the first edit's voxel, light, heightmaps (aux A equal to before) and entry restored, and every version unchanged";
  - **the dirty set** (Review Focus 4, the canned store): "a torch at world (15, 70, 15) of column (0, 0): `dirty` is exactly {(0, 0), (1, 0), (0, 1), (1, 1)}"; "glass at (16, 70, 5), which changes no light: (0, 0) is dirty through the block ring alone (local x 0 of column (1, 0))"; "bucket water placed into air at (0, 70, 0): (−1, −1), (−1, 0), (0, −1) and (0, 0) are dirty";
  - "the proto's slots are unchanged after 100 random edits (their words compared before and after)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simEdits.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(sim): applyEdits: validated batches, copy-on-write writes, relight and the dirty set` (`git add src/sim/edits.ts test/unit/simEdits.test.ts test/arch/masterSpec.test.ts`).

---

### Task 10: The sim worker: protocol, `simHandler.ts`, `sim.worker.ts`, `engine/simClient.ts`

**Files:**
- Modify: `src/workers/protocol.ts` (the sim's messages and guards)
- Create: `src/workers/simHandler.ts`, `src/workers/sim.worker.ts`, `src/engine/simClient.ts`, `test/unit/simHandler.test.ts`, `test/unit/simClient.test.ts`
- Modify: `test/unit/protocol.test.ts`, `test/arch/masterSpec.test.ts` (`SP5A_MODULES` rows `workers/sim.worker.ts`, `engine/simClient.ts`), `test/harness/region.ts` (`GenRegionOptions.shared?: boolean`, default `threads === 4`; `createStore({ shared: o.shared ?? o.threads === 4 })`, `region.ts:439`: the attach guard needs `SharedArrayBuffer`s, `protocol.ts:403-410`, and only `threads: 4` makes them today, with 4 workers and a build), `test/unit/regionHarness.test.ts` ("threads 1, shared true: a `SharedArrayBuffer` store, the same hash")
- Spec: Spec corrections (only `engine/` spawns; the guard outside `sim/`)
- Master: §1's workers line gains "(SP5a)" for `sim.worker.ts` and `simHandler.ts`; the engine line naming `coordinator.ts` gains `simClient.ts (SP5a)` (spec §9's §1 line and the Spec correction)

**Interfaces:**
- `protocol.ts`: `EditsMsg { type: 'edits'; id: number; edits: readonly Edit[] }`; `DiffRequestMsg { type: 'diff'; id: number; cx: number; cz: number }`; `ToSim = AttachMsg | EditsMsg | DiffRequestMsg`; `EditedMsg { type: 'edited'; id; prev: Uint32Array; dirty: Float64Array; entryCols: Float64Array; refused: EditRefusal | null; relightMs: number; editMs: number }`; `DiffMsg { type: 'diff'; id; cx; cz; sy: Uint8Array; idx: Uint16Array; value: Uint32Array }`; `FromSim = AttachedMsg | EditedMsg | DiffMsg | ErrorMsg`; `parseToSim(m: unknown): ToSim | null`, `parseFromSim(m: unknown): FromSim | null`. **(plan)** `id` on `diff` (the spec's message has none) so a reply matches its request; an attach with thread 15 only. `protocol.ts` also re-exports `export type { Edit, EditRefusal } from '../sim/edits'` (workers may import sim); `player/`, `engine/` and `ui/` take them from here.
- `simHandler.ts`: `createSimHandler(): { handle(m: unknown): { msg: FromSim; transfer: ArrayBuffer[] }; drain(): number }` (the shape of `createTaskHandler`'s, so `buildNodeTaskWorker` wraps it, Task 38) — attach as thread 15, `applyEdits` with `performance.now`, `readDiff` (the DiffStore's `columnDiff`, transferred); a refused guard answers `BAD_MESSAGE`; any throw from `applyEdits`/`readDiff` (`StoreFull` is already `refused: 'full'`) answers `{ type: 'error', jobId: id, epoch: null, code: e instanceof StoreCorrupt ? 'STORE_CORRUPT' : 'INTERNAL', message }` (`ErrorMsg`, `protocol.ts:170`, carries `jobId`), `jobId` null when the id is unreadable. `SIM_DRAIN_MS = 100`.
- `interface SimWorkerLike { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null; terminate(): void }` (in `simClient.ts`; a `Worker` satisfies it, as `WorkerLike` in `workerPool.ts:59`).
- `sim.worker.ts`: wires the handler; drains after each message and every `SIM_DRAIN_MS` while the limbo is not empty.
- `simClient.ts`: `interface SimClient { attach(h: StoreHandles): Promise<void>; edits(e: readonly Edit[]): Promise<EditedMsg>; diff(cx: number, cz: number): Promise<ColumnDiff | null>; hasEntries(cx: number, cz: number): boolean; readonly failed: boolean; dispose(): void }`; `createSimClient(spawn: () => SimWorkerLike, o: { onFailure(e: Error): void }): SimClient` (the entry set from each reply's `entryCols`; on an `error` event, an `error` reply (any code: the sim's failure) or a reply `parseFromSim` refuses, in this order: `failed` true, `hasEntries` false, `onFailure` once and synchronously (the page's `onSimFailure`, Task 16: `markDead(15)`, `simUnpinAll`, the notice), then every pending `edits` rejects `SimFailed` and every pending and later `diff` resolves null, so a rejected post finds its pins already released); `createBrowserSim(o): SimClient` spawns `new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' })`.

- [ ] **Step 1: Write the tests.**
  - `protocol.test.ts`: each sim message accepted; a non-integer coordinate, an unknown `op`, a `value` above 2³² − 1, a thread other than 15 refused.
  - `simHandler.test.ts` (a shared store filled by the region harness, `genRegion({ …, upTo: 'L', threads: 1, shared: true })`, the handler attached as 15): "edits → `edited` with the result of `applyEdits`"; "`diff` after two edits of a column → its canonical entries, transferred"; "messages are handled in order: an `edits` then a `diff` of the same column returns the new entry"; "a malformed message → `BAD_MESSAGE` and nothing written"; "a throw inside `applyEdits` other than `StoreFull` (a `StoreCorrupt`, an injected bug) → an `error` reply with that `jobId` and `STORE_CORRUPT`/`INTERNAL`".
  - `simClient.test.ts` (a fake `SimWorkerLike`): "the entry set follows `entryCols`"; "after an `error` event: pending `edits` reject `SimFailed`, pending and later `diff` resolve null, `hasEntries` false, `onFailure` called once, before the first rejection runs"; "an `error` reply takes the same path".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/protocol.test.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; the build emits a `sim.worker` chunk; no golden diff.
- [ ] **Step 5: Commit** `feat(workers): the sim worker on thread 15 and its client` (`git add src/workers/protocol.ts src/workers/simHandler.ts src/workers/sim.worker.ts src/engine/simClient.ts test/unit/protocol.test.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts test/harness/region.ts test/unit/regionHarness.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 11: D's overlay and the decorate message's diff

**Files:**
- Modify: `src/gen/pipeline/decorateStage.ts` (:11 comment, :55-90), `src/workers/protocol.ts` (`WorldJobMsg` :130 gains `diff?: ColumnDiff`; the guard :418-419, :452), `src/workers/worldJobs.ts` (`fillColumnD`, `decorateReply`), `src/workers/taskHandler.ts` (passes it), `src/engine/workerPool.ts` (`decorate(cx, cz, diff?)`; `worldJob` puts `diff` into the message only when given)
- Modify (tests): `test/unit/decorateStage.test.ts`, `test/unit/protocol.test.ts`, `test/unit/workerPool.test.ts`, `test/integration/worldJobs.test.ts`
- Spec: Spec corrections (cloned, not transferred; D's heightmaps from its scratch)

**Interfaces:**
- `decorateStage(ctx, nb, w, stop, diff: ColumnDiff | null = null): boolean` — without a diff byte-identical to today (no extra write, no version bump); with one, after the 24 `shareFinal`s, each section holding entries is rebuilt from the proto plus the entries into scratch and written with `w.replaceBlocks` (the proto stays generated; no light written), `SECTION_BLOCKS`/`SECTION_FLUID` point at the rebuilt scratch for the heightmaps, and `w.setDiffFlag()`.
- `WorkerPool.decorate(cx: number, cz: number, diff?: ColumnDiff): Promise<ColumnDone>`; the guard accepts `diff` only on `decorate`, with equal lengths, `sy` < 24, `idx` < 4096, `value` states < `stateCount`.

- [ ] **Step 1: Write the tests.** `decorateStage.test.ts`: "with a diff of 40 entries over 3 sections: the final equals proto + entries, the proto's slots unchanged, `REC_DIFF_FLAG` set, the heightmaps equal `writeFinalHeightmaps` over the final"; "without a diff: the final shares the proto's slots and the versions and aux equal today's (a fixture recorded before the change)"; "a diff equal to the proto everywhere leaves the column's values unchanged". `protocol.test.ts`: `diff` refused on `light`, with mismatched lengths, or `sy` 24. `workerPool.test.ts`: the decorate message carries `diff` only when given. `worldJobs.test.ts`: "a D with a diff, then L: the column's light equals `lightRegion` over the overlaid finals".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(gen): D's diff overlay` (`git add src/gen/pipeline/decorateStage.ts src/workers/protocol.ts src/workers/worldJobs.ts src/workers/taskHandler.ts src/engine/workerPool.ts test/unit/decorateStage.test.ts test/unit/protocol.test.ts test/unit/workerPool.test.ts test/integration/worldJobs.test.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 12: Pool: the edit lane

**Files:**
- Modify: `src/engine/workerPool.ts` (`WorkerPool.meshColumn` :264; `enqueue` :552-562; `cancelWorld` :785-795), `test/unit/workerPool.test.ts`

**Interfaces:**
- `meshColumn(cx: number, cz: number, o?: { readonly edit: boolean }): Promise<MeshColumnDone>` — with `edit: true` the job goes to the aux lane at `EDIT_MESH_PRIORITY = -1000` (exported), which a free worker takes first (`workerPool.ts:417-419`), outside `auxCap` (it is a world type, so `auxRunning` never counts it); the reply rule of a world job is unchanged.
- `cancelWorld(pred)` also removes world-type jobs from the aux lane.

- [ ] **Step 1: Write the tests:** "an edit `meshColumn` issued after 6 queued world jobs and 3 queued map tiles runs first on the next free worker"; "two edit MESHes run in issue order"; "with `setAuxPolicy('aux', 1)` and one aux job running, an edit MESH still runs on the next free worker"; "`cancelWorld` matching its column rejects a queued edit MESH with `JobCancelled`; a non-matching one stays"; "a plain `meshColumn` still goes to the world lane".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/workerPool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(engine): edit MESHes on the aux lane at -1000; cancelWorld over both lanes` (`git add src/engine/workerPool.ts test/unit/workerPool.test.ts`).

---

### Task 13: Coordinator I: `editState`, `simPin`/`simUnpin`

**Files:**
- Modify: `src/engine/coordinator.ts` (`Coordinator` :238-268; the slot table :391-424 gains `simPins: Uint16Array(SLOTS)`; `freeable` :834-837), `test/unit/coordinator.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §8 risk 7 (spec §9)
- Spec: Spec corrections (`editState` in place of `editable`: §2.1, §6.3 and the module layout reworded)

**Interfaces:**
- `Coordinator.editState(cx: number, cz: number): 0 | 1 | 2` — 0 when every column of the 3 × 3 is tracked, Published, at the applied epoch (`colEpoch === wEpoch`) and not failed; 2 when all are tracked and Published-or-stale but one has `colEpoch ≠ wEpoch` ("regenerating"); 1 otherwise ("not loaded"). An in-flight MESH does not close it. Allocates nothing.
- `simPin(cx, cz): void` / `simUnpin(cx, cz): void` — ±1 on `simPins` of the 3 × 3; `freeable` also requires `simPins` 0; a slot whose `simPins` reaches 0 runs `unloadCheck` and `considerAround` (as a settle does, `coordinator.ts:1053-1068`). `simUnpin` never takes a count below 0: a count already at 0 stays 0 and runs no `unloadCheck` (a backstop: a `Uint16Array` would wrap to 65535 and pin the column for ever).
- `simUnpinAll(): void` — every count to 0, each slot then as `simUnpin` (the sim failure path, Task 15).

- [ ] **Step 1: Write the tests** (fake jobs and sink, RD 6):
  - "after the fill, `editState` of a column 2 inside the MESH set is 0, of a column whose 3 × 3 has an unmeshed or absent neighbour 1"; "a MESH in flight on it leaves it 0"; "after `apply`, a stale column's `editState` is 2 until it is freed, 1 while it is regenerated (`follow` resets it to stage 0, `colEpoch` 0, `coordinator.ts:782-790`), and 0 once it and its 3 × 3 are Published at the new epoch";
  - "a pinned column beyond keepVoxels is not freed over 50 updates; after `simUnpin` it is freed in the next update";
  - **Review Focus 5:** "a stale column pinned at `apply` is freed after `simUnpin` with no camera move, then regenerated";
  - "`simUnpinAll` releases 3 overlapping pins and the frees follow"; "`simUnpinAll` then `simUnpin` of the same 3 × 3 leaves every count 0 and the column freeable in the next update"; "no L is issued for a column whose 3 × 3 includes a Published edited column while `editState` is 0 (an L needs a Decorated column, which the gate excludes): 200 random pinned edits during a fill drop no L: the fake jobs count L issues per column, and each column's L is issued exactly once (a dropped L would be requeued and issued again)";
  - "`editState` allocates nothing" (`zeroAlloc.test.ts` pattern).
  - SP5a describe: risk 7 contains `edits never run beside a light job that reads them (SP5a's edit gate), and L3 checks incremental against full light after random edits`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): the edit gate and the sim's pins` (`git add src/engine/coordinator.ts test/unit/coordinator.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 14: Coordinator II: `markEdited`, the edit queue, restaging

**Files:**
- Modify: `src/engine/coordinator.ts` (`CoordinatorJobs.run` :143; `CoordinatorOptions` :181; `CoordinatorCounts` :208-235; `worldJobsOf` :314-335; `nextJob` :501-531; `pump` :953-985; `issue`; `intake` :1113-1127), `src/ui/world/worldPage.ts` and `test/metrics/stream.metric.ts`, `test/metrics/apply.metric.ts`, `test/integration/streaming.test.ts`, `test/integration/apply.test.ts` (the `run` signature only), `test/unit/coordinator.test.ts`, `test/unit/zeroAlloc.test.ts`
- Spec: Spec corrections (`onEditStaged`)

**Interfaces:**
- `CoordinatorJobs.run(stage, cx, cz, protoOnly, edit: boolean): Promise<JobOutcome>`; `worldJobsOf` maps `edit` to `pool.meshColumn(cx, cz, { edit: true })`.
- `Coordinator.markEdited(keys: ArrayLike<number> /* colKeys */): void` — per tracked slot: `editSeq` + 1, `meshSeq` + 1 (an in-flight MESH of the slot drops at intake), the slot pushed onto the edit ring (a preallocated `Int32Array(SLOTS)` FIFO, a slot at most once); then `pump()` at once.
- `pump` drains the edit ring **before** the generation gate (`coordinator.ts:957`) and the caps (`:961`, `:968`): a slot whose 3 × 3 is Published and current and that is not busy gets its MESH (`edit` true, counted in `inFlight[3]` and `total`); a busy slot stays queued until its settle.
- The two "already meshed" rules (`:508`, `:519-523`) do not apply to a slot whose `editSeq` is newer than `stagedEditSeq`; the staging assertion (`:1121-1123`) allows a restage at the same epoch when the job's issued `editSeq` is newer than the staged one.
- `CoordinatorCounts.editDropped: number` (results dropped by an edit, apart from `dropped`). In `intake`, **before** the versions check (`coordinator.ts:1094-1105`, which an edit's `publish` fails first, since it bumps `blockVersion` and `lightVersion` inside the 3 × 3, and whose `drop()` counts `dropped`, is fatal while strict and requeues), a MESH result is an edit drop if the slot's `editSeq` has moved since the job was issued, or if the slot's `simPins` > 0 at intake (an edit published but not yet answered). An edit drop counts in `editDropped`, not `dropped`, and is never fatal; a slot on the edit ring is not requeued (the ring re-issues it), otherwise it is requeued with `considerAround`, as `requeue` does today.
- `CoordinatorOptions.onEditStaged?: (cx: number, cz: number) => void` — called when a payload issued at or after the slot's latest `markEdited` is staged.

- [ ] **Step 1: Write the tests** (fake jobs whose settle the test controls):
  - "`markEdited` of a meshed column with `total` at N, `inFlight[3]` at N and the fake pool's generation moved: its MESH is issued in the same call with `edit` true"; "a busy slot is issued at its settle";
  - "a MESH in flight when `markEdited` runs is dropped at intake (`editDropped` 1, `dropped` unchanged) and the slot meshes again"; "a MESH settling after the sim's publish but before its reply (the slot's `simPins` > 0, its versions moved) counts in `editDropped`, not `dropped`, and is not fatal while strict";
  - **Review Focus 1:** "10 `markEdited` of one column 20 ms apart, each MESH settling 30 ms after issue: never two MESHes of the slot in flight, every raced result in `editDropped`, no `staged over a pending payload` throw, the column ends staged with the 10th `editSeq`, `onEditStaged` called for it";
  - **Review Focus 4:** "after each of 200 random edits through a real store and `applyEdits` (border and corner ones included), every column of the edited column's 3 × 3 (and every column of `dirty`) re-meshed from scratch (`meshColumnPayload`) equals the payload the fake sink was last staged with" (a column missing from `dirty` keeps the payload staged before the edit, so the comparison catches it);
  - "an edit MESH for a column that left keepMesh before issue is not issued"; "the generation gate still holds every stream job while the edit ring drains";
  - `zeroAlloc.test.ts`: "`update` at rest with an empty edit ring allocates nothing".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/coordinator.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The metric and integration harnesses pass `edit` through unchanged.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npx vitest run --project metrics-fast test/metrics/stream.metric.ts test/metrics/apply.metric.ts`. Expected: PASS; R7 unchanged.
- [ ] **Step 5: Commit** `feat(engine): edit remeshes issued at once, past the caps, restaged in the same epoch` (`git add src/engine/coordinator.ts src/ui/world/worldPage.ts test/metrics/stream.metric.ts test/metrics/apply.metric.ts test/integration/streaming.test.ts test/integration/apply.test.ts test/unit/coordinator.test.ts test/unit/zeroAlloc.test.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 15: Read-through and the sim failure path

**Files:**
- Modify: `src/engine/coordinator.ts` (`worldJobsOf`), `test/unit/coordinator.test.ts` (the `worldJobsOf` describe, `:2038-2119`)

**Interfaces:**
- `interface ReadThrough { hasEntries(cx: number, cz: number): boolean; diff(cx: number, cz: number): Promise<ColumnDiff | null> }` (`SimClient` satisfies it).
- `worldJobsOf(pool, readThrough: ReadThrough | null = null)`: a D on a column for which `hasEntries` is true awaits `diff` first and passes it to `pool.decorate(cx, cz, diff ?? undefined)`; otherwise today's path, with no wait.

- [ ] **Step 1: Write the tests:** "a D on a column with entries awaits the diff and passes it; a D on another column passes none and does not call `diff`"; "a read-through whose `diff` resolves null (the sim failed) runs D without an overlay"; **sim failure:** "with a fake sim that never answers, `simClient`'s failure resolves every pending wait null, so each held D runs and settles; `simUnpinAll` then lets the frees follow (a pinned column beyond keepVoxels freed in the next update)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/coordinator.test.ts test/unit/simClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(engine): D's read-through from the sim` (`git add src/engine/coordinator.ts test/unit/coordinator.test.ts test/unit/simClient.test.ts`).

---

### Task 16: The page's edit path, the test hook, the edit latency

**Files:**
- Create: `src/ui/world/editPath.ts`, `src/ui/world/editLatency.ts`, `test/unit/editPath.test.ts`, `test/unit/editLatency.test.ts`
- Modify: `src/ui/world/worldPage.ts` (`createBrowserSim` after the pool (:1164-1172), for every route but flight (`opts.flight === undefined`; null on flight), attached as 15 to `store.handles()`; `worldJobsOf(workers, sim)` at :1214, shared by every route (`readThrough` null on flight); `onEditStaged`; the streaming route's `sections.onColumnRevealed = (cx, cz) => latency.revealed(cx, cz, performance.now())`, installed only outside the bench branch (the bench's own hook at :1408 calls both, Task 17), cleared at teardown; the failure wiring through `onSimFailure`; `WiTest` :739-761 gains `edit` and `blockAt`; teardown disposes the sim), `test/unit/worldPage.test.ts`
- Spec: Spec corrections (`onEditStaged`)

**Interfaces:**
- `editPath.ts` **(plan)**: `type EditOutcome = { readonly ok: true; readonly prev: Uint32Array } | { readonly ok: false; readonly why: 'unloaded' | 'regenerating' | 'changed' | 'noProto' | 'full' | 'failed' }`; `createEditPath(o: { sim: Pick<SimClient, 'edits' | 'failed'>; coordinator: Pick<Coordinator, 'editState' | 'simPin' | 'simUnpin' | 'markEdited'>; latency: EditLatency; now(): number; notices: { show(text: string, ms: number): void } }): { post(edits: readonly Edit[]): Promise<EditOutcome>; pending(): boolean; disable(): void; readonly enabled: boolean }` (`Edit` imported as a type from `workers/protocol.ts`) — `post` refuses at once with `editState` 1/2 of any edited column's 3 × 3 (`unloaded`/`regenerating`), and with `failed` once disabled or `sim.failed`; otherwise it records the post time, `simPin` of each distinct column, the sim's `edits`, then in the reply's task: `simUnpin`, `markEdited(dirty)`, `latency.posted(tPost, now(), edited, dirty, reply.relightMs, reply.editMs)` (`edited` the first edit's column: every SP5a action is one voxel; a multi-voxel undo step is timed by its first). On `SimFailed` the post does not unpin (`simUnpinAll` has already released every pin) and resolves `failed`. `full` shows `Could not edit: memory full` (4 s).
- `editLatency.ts`: `createEditLatency(capacity = 2048): { posted(tPost: number, tReply: number, edited: number /* colKey */, dirty: ArrayLike<number>, relightMs: number, editMs: number): void; staged(cx: number, cz: number, t: number): void; revealed(cx: number, cz: number, t: number): void; visibleP95(): number; allVisibleP95(): number; readonly count: number; samples(): { visible: Float64Array; allVisible: Float64Array; reply: Float64Array; issueToStaged: Float64Array; stagedToShown: Float64Array; relight: Float64Array; edit: Float64Array } }` — a sample's visible time is from `tPost` to the first `revealed` of the edited column after its `staged`; all-visible to the last dirty column's; `reply` = tReply − tPost, `issueToStaged` = the edited column's staged t − tReply, `stagedToShown` = its reveal − its staged t, `relight` and `edit` the sim's figures; all preallocated rings. The page passes `staged(cx, cz, performance.now())` from `onEditStaged`.
- The sim's failure: an exported `onSimFailure(o: { store: Pick<VoxelStore, 'markDead'>; coordinator: Pick<Coordinator, 'simUnpinAll'>; editPath: { disable(): void }; notices: Pick<WorldNotices, 'show'> }): void`, which the route calls from the sim client's `onFailure`: `store.markDead(15)`, `editPath.disable()`, `coordinator.simUnpinAll()`, the notice `Editing stopped: the edit worker failed; this session's edits are lost` (no timeout).
- `WiTest.edit(x: number, y: number, z: number, state: number, fluid: number): Promise<string>` ('ok' or the refusal), `WiTest.blockAt(x, y, z): number` (inside a read section).

- [ ] **Step 1: Write the tests.** `editPath.test.ts` (fakes): "a post pins each edited column's 3 × 3 once, unpins at the reply, calls `markEdited` with `dirty` in the reply's task"; "`editState` 2 → `{ ok: false, why: 'regenerating' }` and nothing posted"; "a sim rejection (`SimFailed`) → `failed`, and the post calls no `simUnpin`"; "a failure with 2 posts pending (`onSimFailure`, then both rejections) leaves every `simPins` at 0 and the frees follow in the next update" (a real coordinator with fake jobs); "after `disable`, a `post` resolves `failed` with nothing posted"; "`full` shows the notice"; "the reply's `relightMs` and `editMs` reach `latency.posted`". `editLatency.test.ts`: "posted at 100 with the reply at 104, staged at 115, a reveal of the edited column at 130 and of the last dirty at 145: visible 30, all-visible 45, reply 4, issueToStaged 11, stagedToShown 15, and the sim's relight and edit figures kept"; "a reveal before `staged` does not count". `worldPage.test.ts` (dom shim): "`onSimFailure` marks 15 dead, unpins all, shows the notice with no timeout, and a later `post` resolves `failed`".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the world's edit path through the sim worker, with its latency` (`git add src/ui/world/editPath.ts src/ui/world/editLatency.ts src/ui/world/worldPage.ts test/unit/editPath.test.ts test/unit/editLatency.test.ts test/unit/worldPage.test.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 17: Bench leg L10; `measureChrome` → `assets/sp5a`

**Files:**
- Modify: `src/ui/world/bench.ts` (`BENCH_FRAME_CAPACITY` :50; `BenchLeg` :52-58; the legs after L9; `BenchResult` gains `edit`; `summarizeBench` :731; `BenchWorld` :864 gains `edit`), `src/ui/world/worldPage.ts` (the bench branch: an edit path and latency over the sim Task 16 created; the bench's reveal hook at :1408), `test/tools/measureChrome.ts` (`ASSETS` :63), `test/unit/bench.test.ts`, `test/unit/measureChrome.test.ts`, `CLAUDE.md` (the `measure:chrome` line)
- Spec: Spec corrections (the streaming sample in L10's closing flight; the capacity)

**Interfaces:**
- `BENCH_FRAME_CAPACITY = 58368`; `BenchLeg.name` gains `'L10'`; `BENCH_EDIT = { count: 100, everyMs: 250, radius: 8, hoverMaxS: 60, streamingCount: 20, streamingFlightS: 6, streamingSpeed: 20 }` (spec §6.2).
- L10 after L9 at the destination: hover until the RD 12 disc is filled (at most 60 s; a timeout is recorded in `edit.timedOut` and fails the leg), then 100 edits through the page's edit path, one every 250 ms, within 8 blocks of the camera's column on the surface (`heightAt('motionBlocking')`): alternately place and break stone, every tenth a torch. **(plan)** Then the streaming sample (a Spec correction; L9 is a teleport that hovers, `bench.ts:84-98`): L10 flies east at 20 blocks/s for 6 s while the pool streams, posting 20 edits one every 250 ms from its first second, each at a voxel within 8 blocks of the camera whose column's `editState` is 0; refusals counted apart (`edit.streamingRefused`), the answered ones' p95 as `editVisibleStreamingP95`. G1's L1-L4 cells are not perturbed.
- `BenchResult.edit: { editVisibleP50; editVisibleP95; editVisibleMax; editAllVisibleP95; relightP95Ms; editP95Ms; replyP95Ms; issueToStagedP95Ms; stagedToShownP95Ms; editDropped; mainP95Ms; editVisibleStreamingP95; streamingRefused: number; timedOut: string[]; frames: SP4b's frame fields over L10 }` — **(plan)** the step budget from `editLatency`'s samples (Task 16): `replyP95Ms` (post → reply), `issueToStagedP95Ms` (reply → staged: the MESH job and its delivery), `stagedToShownP95Ms`, `relightP95Ms` and `editP95Ms`; `mainP95Ms` the frame step's input, walk step, DDA and outline time (0 until Task 35 times it).
- The bench's reveal hook (`worldPage.ts:1408`) calls both: `(cx, cz) => { reveals.revealed(cx, cz); latency.revealed(cx, cz, performance.now()); }` (`sections.onColumnRevealed` holds one hook, `sectionRenderer.ts:156`).
- `ASSETS = 'docs/superpowers/specs/assets/sp5a'`.

- [ ] **Step 1: Write the tests.** `bench.test.ts`: "`summarizeBench` over a synthetic record with an L10 has every `edit` key; SP4c's `live` block still covers L7-L9 only"; "L10's script posts 100 edits 250 ms apart within 8 blocks, every tenth a torch, then 20 during its 6 s flight east, skipping a column whose `editState` is not 0"; "a hover past 60 s records `edit.timedOut` `['L10']`"; "the capacity holds 241 s at 240 Hz (57,840 frames: SP4c's 150 s, L10's 60 s hover cap, its 25 s of edits and its 6 s flight)". `measureChrome.test.ts`: `ASSETS` ends `assets/sp5a`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `CLAUDE.md`'s `measure:chrome` line: `assets/sp5a` since SP5a. The spec's §6.2: "during L9's flight" → "during L10's closing 6 s flight east", and "57,344 (239 s at 240 Hz)" → "58,368 (243 s at 240 Hz)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS. (No Chrome on the GPU here: the probe runs in Task 18, after its STOP.)
- [ ] **Step 5: Commit** `feat(ui): the bench's edit leg L10` (`git add src/ui/world/bench.ts src/ui/world/worldPage.ts test/tools/measureChrome.ts test/unit/bench.test.ts test/unit/measureChrome.test.ts CLAUDE.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 18: The early G2 measurement

**STOP for the user before Step 1:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Modify: the SP5a spec (`## Exit evidence`: "### The early G2 measurement (Task 18)")

- [ ] **Step 1: Measure** (an agent; quiet machine; cold shader cache; touching no other process): first `npm run measure:chrome -- --route bench --gpu iris --probe-only` (it prints the Iris renderer; a refusal means PRIME is not on-demand: back to the STOP), then `npm run measure:chrome -- --route bench --gpu iris`, twice. After each run, move (`mv`) `docs/superpowers/specs/assets/sp5a/bench-iris-chrome.json` to `.superpowers/sp5a/early-<n>.json` (never committed; the directory holds no tracked file until Task 41, so `git checkout` cannot clean it); then `git status --porcelain docs/superpowers/specs/assets` is empty.
- [ ] **Step 2: Read** `edit.editVisibleP95` against 50 ms, with the step budget (`replyP95Ms` ≤ 5, `issueToStagedP95Ms` ≤ 10 + one frame, `stagedToShownP95Ms` ≤ 2 frames at 240 Hz), `editAllVisibleP95`, `editDropped`, `editVisibleStreamingP95`, and L10's `over33`.
- [ ] **Step 3: Decide.** ≤ 50 ms in both runs: Task 19 is skipped (recorded). Above: Task 19's levers in order.
- [ ] **Step 4: Commit** `docs(sp5a): the early G2 measurement` (`git add docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 19: D30's levers (conditional)

Run only if Task 18 measured `editVisibleP95` above 50 ms (the skip is recorded in Task 18); each lever is one commit, measured (as Task 18 Step 1) before the next; stop at the first that brings it to ≤ 50 ms. **STOP before each measurement** under Task 18's conditions: the controller confirms them with the user again when the session was resumed or the display may have slept.

- [ ] **19a: The edit payload's upload exempt from the frame's budget.** Files: `src/engine/coordinator.ts` (`StreamSink.stage(p, seq, edit?: boolean)`, `:163-165`, `:1124`: `edit` true for a payload issued at or after the slot's latest `markEdited`), `src/render/sectionRenderer.ts` and `src/render/regionGrid.ts` (`stage`'s edit flag marks the column), the page's sink adapter in `src/ui/world/worldPage.ts`; `pump` uploads an edit column's rows before checking `budget.exhausted()` (`engine/uploadBudget.ts:5-6`'s 2 ms and 32 rows still bound the rest). Tests in `coordinator.test.ts` ("an edit payload is staged with `edit` true, a stream payload without"), `regionGrid.test.ts` and `sectionRendererContract.ts`: "an edit column's rows upload in the frame they are staged even with the budget exhausted; stream rows still wait". Commit `perf(render): edit payloads upload outside the frame budget (D30 lever 1)`.
- [ ] **19b: Mesh only the sections whose padded view holds a changed voxel.** Files: `src/workers/protocol.ts` (`EditedMsg.sections: Uint32Array`, one 24-bit mask per dirty column, and its guard), `src/sim/edits.ts` (the mask from the edited voxels and `RelightReport.sections`), `src/workers/simHandler.ts`, `src/engine/coordinator.ts` (passes the mask to `meshColumn`), `src/engine/workerPool.ts` (`meshColumn(cx, cz, { edit: true, sections })`), the mesh job (`meshColumn`'s worker path) meshing those sections only, and `src/render/regionGrid.ts` with a restage that merges the unchanged rows from the shown record (today the swap makes the shown record `prev` and releases it, `regionGrid.ts:220-223`). Tests in `meshColumn.test.ts`, `coordinator.test.ts` and `regionGrid.test.ts`: "the partial payload merged with the shown rows equals the full one in every section". Commit `perf(mesh): edit remeshes rebuild only the changed sections (D30 lever 2)`.
- [ ] **19c: One pool worker reserved for edit MESHes while edits are pending.** `CoordinatorOptions.editsPending?: () => boolean`, which the page wires to `editPath.pending()` (`engine/` cannot import `ui/`); the coordinator's caps lower `total`'s N by 1 while it returns true or the edit ring is not empty; test: "with an edit pending, at most N − 1 stream jobs run". Commit `perf(engine): a worker reserved for edit remeshes while edits are pending (D30 lever 3)`.
- [ ] **STOP:** still above 50 ms after 19c: the controller reports every measurement to the user before the exit (spec D30); no gate is loosened.
- [ ] Each lever: `npm run typecheck && npm test`; the measurement recorded under Task 18's heading.

---

### Task 20: Provisional boxes and culling

**Files:**
- Create: `src/world/blocks/provisionalBoxes.ts` (`BOXES`, `boxOf`), `src/mesh/boxes.ts` (`meshBoxes`), `test/unit/meshBoxes.test.ts`
- Modify: `src/mesh/greedy.ts` (`meshSolid` :121-150 skips `SHAPE` box states; culling), `src/mesh/fluid.ts` (water against boxes, unchanged rule), `src/mesh/column.ts` (calls `meshBoxes`), `test/unit/meshGreedy.test.ts`, `test/unit/meshFluid.test.ts`, `test/arch/masterSpec.test.ts` (`SP5A_MODULES` rows `mesh/boxes.ts` and, under `/^\s+blocks\/kinds\.ts /`, `world/blocks/provisionalBoxes.ts`)
- Master: §1's mesh line gains `boxes.ts (SP5a, provisional until SP8a)`; §1's `blocks/kinds.ts registry.ts …` entry gains `provisionalBoxes.ts (SP5a, provisional until SP8a)` (a Spec correction)
- Spec: Spec corrections (the box table in `world/blocks/`; culling against lava)

**Interfaces:**
- `world/blocks/provisionalBoxes.ts`: `BOXES` (eighths, facing north): `torch` x 3-5, y 0-5, z 3-5; `wall_torch` x 3-5, y 2-7, z 6-8; `ladder` x 0-8, y 0-8, z 7-8; other facings by `REGISTRY.rotateState`'s quarter turns. `boxOf(state: number, out: Uint8Array /* x0 y0 z0 x1 y1 z1 */): boolean` (shared with the raycast, Task 22, which imports it from `../world/blocks/provisionalBoxes`: `player/` may not import `mesh/`, `imports.ts:30`; `world/blocks/**` is a hot prefix, so its tables read through top-level aliases). `mesh/boxes.ts` imports `boxOf` from there (`LIGHT_MESH`'s `world/blocks/**`).
- `meshBoxes(p: PaddedSection, o: MeshOptions, b: MeshBuilder, t?: MeshTables): void` — six faces per box into pass 1; a face on the voxel boundary culled when the neighbour is a `SHAPE` cube state (opaque or cutout) or holds water or lava; AO 1; light the voxel's own.
- `meshSolid`: no cutout cube face (glass, ice) against a voxel holding water or lava; a glass face not against ice; ice's face against glass drawn; same-type cutout faces stay culled (`greedy.ts:140-141`).

- [ ] **Step 1: Write the tests.** `meshBoxes.test.ts`: "a torch emits 6 quads at x 3-5, y 0-5, z 3-5 eighths"; "a wall torch facing east and a ladder facing south: the boxes rotated" (`boxOf` per facing: spec §6.3's boxes for each facing); "a ladder on glass: its back face culled"; "a torch under water: none of its faces culled but the one on the boundary is"; "a ladder whose back faces lava: back face culled". `meshGreedy.test.ts`: "a torch state emits nothing from `meshSolid`"; "glass beside water: no glass face on that side; the water mesher's face there stays (`meshFluid`)"; "glass beside bucket lava: no glass face on that side"; "ice beside lava: the same"; "glass beside ice: the ice face drawn, the glass face not"; "glass beside glass: none". The spec's §1.3 culling rule reads "water or lava", and the module layout names `world/blocks/provisionalBoxes.ts` (the Spec corrections).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** (hot-loop aliases).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run bench` (`mesh.section` within its gates and +30 %). Expected: PASS.
- [ ] **Step 5: Commit** `feat(mesh): provisional torch, wall torch and ladder boxes; cutout and water culling` (`git add src/world/blocks/provisionalBoxes.ts src/mesh/boxes.ts src/mesh/greedy.ts src/mesh/fluid.ts src/mesh/column.ts test/unit/meshBoxes.test.ts test/unit/meshGreedy.test.ts test/unit/meshFluid.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 21: Log ends, the glass frame, still lava

**Files:**
- Modify: `src/mesh/packing.ts` (`frame: field(30, 1)` appended to `PACK_LAYOUT.solid` and `SolidFields`, outside `flags`, bits 26-29), `src/mesh/greedy.ts` (`emit` :155-168: the layer and pass from key A's state), `src/mesh/fluid.ts` (still lava), `src/render/textureArray.ts` (:15-37: `stateCount + 2` layers), `src/render/materials/glsl/terrain.glsl.ts` (:72-77: the frame discard; its vertex shader passes a flat `vFrame` from the word's `frame` field through `packing.glsl.ts`'s generated unpack of `PACK_LAYOUT.solid.frame`, and the cutout fragment discards on `vFrame`), `src/render/spike/spikeBench.ts` (:217 `zeroSolid` gains `frame: 0`), `src/render/spike/stressScene.ts` (:199-202 the `packSolid` literal gains `frame: 0`; `pack` throws on `frame: undefined`, `packing.ts:75`), `src/ui/crossSection/voxels.ts` (:85-90 lava), tests `test/unit/packing.test.ts` (the solid `top` 29 → 30, the layout pin), `test/unit/meshGreedy.test.ts`, `test/unit/meshFluid.test.ts`, `test/unit/flatColors.test.ts` (:45-54), `test/unit/materials.test.ts`, `test/unit/crossSectionVoxels.test.ts`

**Interfaces:**
- `LOG_END_LAYER = stateCount`, `LAVA_LAYER = stateCount + 1` (computed from `REGISTRY` at run time, 58 and 59 in SP5a); `createFlatColorArray` builds `stateCount + 2` layers (the log end lighter than `oak_log`, ≥ 24 apart from every type; lava `LAVA_COLOR`).
- `emit`: the face of an `oak_log` state along its axis takes `LOG_END_LAYER`, every other face the state; the mesh pass from key A's state's `PASS`, not `pass[layer]` (`greedy.ts:166`); bit 30 set for `glass`.
- The cutout shader discards a framed fragment whose two in-face coordinates `fract(vWorldPos)` both lie in [1/16, 15/16] (the floating origin is a multiple of 512 blocks, `floatingOrigin.ts:9`).
- The fluid mesher: a lava voxel's faces against non-lava neighbours that do not occlude them, into pass 0 with the solid word and `LAVA_LAYER`, full height; the Voxels palette draws lava in `LAVA_COLOR`.

- [ ] **Step 1: Write the tests:** "an axis-x log's ±x faces carry layer 58, its other faces its state; two logs of different axes never merge"; "glass's words carry bit 30 (`frame`), stone's do not"; "a lava source beside air: 6 faces in pass 0 at layer 59, full height; lava beside lava: none"; "the lava face against a cutout cube (glass, ice) or a box state stays drawn" (Task 20 culled their faces against it); "the array has 60 layers; layer 58's colour is the log end's"; "the terrain shaders unpack `frame` (the generated unpack names it) and the fragment GLSL contains the frame discard on `vFrame` under `CUTOUT`" (`materials.test.ts`); "the Voxels palette shows lava as `LAVA_COLOR`". Run `stressScene.test.ts` and the decode-word tests too.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run bench` (`mesh.section` within its gates and +30 %), then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(render): log ends, the glass frame and still lava` (`git add src/mesh/packing.ts src/mesh/greedy.ts src/mesh/fluid.ts src/render/textureArray.ts src/render/materials/glsl/terrain.glsl.ts src/render/spike/spikeBench.ts src/render/spike/stressScene.ts src/ui/crossSection/voxels.ts test/unit/packing.test.ts test/unit/meshGreedy.test.ts test/unit/meshFluid.test.ts test/unit/flatColors.test.ts test/unit/materials.test.ts test/unit/crossSectionVoxels.test.ts`).

---

### Task 22: Raycast

**Files:**
- Create: `src/player/raycast.ts`, `test/unit/raycast.test.ts`
- Modify: `src/player/fly.ts` (`lookVectorInto`), `test/unit/fly.test.ts`, `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `player/raycast.ts`)
- Spec: Spec corrections (`lookVectorInto`; the empty bucket stops at the first block)
- Master: §1's `player/*` line gains "(SP5a)" (walk, physics, raycast, interaction, hotbar)

**Interfaces:**
- `lookVectorInto(out: Float64Array, yawDeg: number, pitchDeg: number): void`.
- `REACH_WALK = 6`, `REACH_FLY = 10`.
- `interface RayHit { hit: boolean; x: number; y: number; z: number; face: number /* FACE_* of the hit face */; px: number; py: number; pz: number /* the hit point */; state: number }` (one reused object).
- `castRay(read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>, ox, oy, oz, dx, dy, dz, reach: number, mode: 'block' | 'fluid', out: RayHit): RayHit` — Amanatides-Woo DDA; `'block'` passes through fluids and air and hits any other state, testing `boxOf` (from `world/blocks/provisionalBoxes.ts`, Task 20) for `SHAPE` box states (a miss continues) and the cell otherwise; `'fluid'` (the empty bucket) stops at the first voxel with fluid and misses at the first other non-air state on the way (a box state tested by its box: a ray past a torch's stick continues); in both modes a −1 read (an unpublished column) ends the ray with no hit. Allocates nothing.

- [ ] **Step 1: Write the tests** (a canned reader over a Map): "a stone 3 blocks ahead on each of the six axes reports the facing face"; "water in between is passed; with `'fluid'` the water voxel is the hit"; "water behind a stone wall within reach: `'fluid'` misses"; "a waterlogged ladder: `'fluid'` hits it"; "a stone at 6.5 blocks: missed at reach 6, hit at 10"; "a torch: a ray through its stick hits it, one through the cell beside the stick misses it and hits the wall behind"; "a ladder's plate is hit at z 7/8"; "a ray into an unpublished column (−1) reports no hit"; "`castRay` allocates nothing over 10,000 rays". The spec's §3.5 and §4.2 empty-bucket sentences gain "before any block" (the Spec correction).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/raycast.test.ts test/unit/fly.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): the block raycast` (`git add src/player/raycast.ts src/player/fly.ts test/unit/raycast.test.ts test/unit/fly.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 23: The outline and the frame's second read section

**Files:**
- Create: `src/render/selection.ts`, `test/unit/selection.test.ts`
- Modify: `src/render/renderer.ts` (`WorldRenderer` gains `setOutline` and `setNear`; `NEAR` :28-29; an exported `applyNear`), `src/ui/world/frameStep.ts` (the read section :147-152 widens: the DDA, the queued clicks, the outline, the eye light; `FrameStepDeps` gains `aim`, and `FrameStepDeps.store` (:67) widens to `Pick<VoxelStore, 'enterRead' | 'exitRead' | 'lightAt' | 'drain' | 'blockAt' | 'fluidAt'>`), `src/ui/world/worldPage.ts` (both `createFrameStep` calls, the bench's :1543 and the streaming route's :2008, pass `aim`: the DDA (Task 22) and the outline, the queued clicks joining in Task 25; the bench's as below), `test/unit/frameStep.test.ts`, `test/unit/renderer.test.ts`, `test/unit/zeroAlloc.test.ts` (:502's `createFrameStep` gains a no-op `aim`, and its store `blockAt`/`fluidAt` if it is a fake), `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `render/selection.ts`)
- Master: §1's render line gains `selection.ts (SP5a)`

**Interfaces:**
- `selection.ts`: a `LineSegments` box in black, enlarged by 0.002, `depthTest` on, an opaque material at `renderOrder` 3 (after `CUTOUT_ORDER` 2, before water).
- `WorldRenderer.setOutline(x0, y0, z0, x1, y1, z1): void` (relative to the floating origin) and `hideOutline(): void`; `setNear(near: number): void` — `NEAR_WALK = 0.05`, `NEAR_FLY = 0.1`. `applyNear(camera: PerspectiveCamera, near: number): void` (sets `camera.near` and calls `updateProjectionMatrix`), exported on the `applyRenderDistance` pattern (`renderer.ts:37`), which `setNear` calls (a `WorldRenderer` needs WebGL, `renderer.ts:364`, which the unit tests do not have).
- `FrameStepDeps.aim(read: Pick<VoxelStore, 'blockAt' | 'fluidAt'>, paused: boolean): void` — called on every rendered tick inside the second read section, before `world.frame` (`frameStep.ts:155`), and never on a skipped tick; the page's `aim` runs the DDA, then the queued clicks (Task 25; Task 29's repeat tick between them), then sets or hides the outline; while `paused` it hides the outline and runs no queued clicks (the frame keeps rendering behind the help, the palette and map mode B). Hidden while the pointer is free, with no target, and when `hud` is false. The bench's `aim` (Task 17's step is always paused, `worldPage.ts:1547`) runs the DDA and the outline update from the scripted pose despite `paused`, so `mainP95Ms` measures them (Task 35).

- [ ] **Step 1: Write the tests.** `selection.test.ts`: "the box's bounds are the target's ± 0.002; its material is opaque with `depthTest` true at `renderOrder` 3". `renderer.test.ts`: "`opaquePassSort` orders the outline after the cutout pass"; "`applyNear(camera, 0.05)` sets `near` 0.05 and updates `projectionMatrix`". `frameStep.test.ts`: "the tick order: motion, update, counts, uploads, origin, drain, then one read section holding `aim` and the eye light, then `world.frame`"; "paused: `aim` called with `paused` true (the page hides the outline); a skipped tick: `aim` not called".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): the block outline and the frame's aim read section` (`git add src/render/selection.ts src/render/renderer.ts src/ui/world/frameStep.ts src/ui/world/worldPage.ts test/unit/selection.test.ts test/unit/renderer.test.ts test/unit/frameStep.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 24: Input and the key map

**Files:**
- Modify: `src/player/keymap.ts` (`Action` :12-14, `Binding` :16, `group` :22, `DEFAULT_KEYMAP` :35-50, `resolveWheel` :78-86), `src/player/input.ts` (`attachInput`: mouse buttons, `contextmenu`, `auxclick`, the click path :117-125, the wheel :131-139), `src/ui/help.ts` (`GROUP_TITLES` :50), `src/ui/loading/tips.ts` (:17 and a build tip), tests `test/unit/keymap.test.ts` (:15, :25, :30, :54-66, :82, :99-106, :117-118), `test/unit/input.test.ts` (:62-77), `test/unit/help.test.ts` (:57), `test/unit/tips.test.ts`
- Master: §4.17's Fly line; §5.9 (spec §9)

**Interfaces:**
- `Action` gains `'toggleWalk' | 'palette' | 'slot1' … 'slot9' | 'slotNext' | 'slotPrev'`, all `since: 'SP5a'`, `group: 'build'` (`GROUP_TITLES.build = 'Build'`). Bindings: F (`KeyF`), E (`KeyE`), `Digit1` … `Digit9` by code, `slotNext` wheel down and `slotPrev` wheel up (no Ctrl).
- `Binding` wheel: `{ kind: 'wheel'; dir: 'up' | 'down'; ctrl: boolean }`; `speedUp` = `wheel(up, ctrl)`, `+`, `=`; `speedDown` = `wheel(down, ctrl)`, `-`; `resolveWheel(deltaY: number, ctrl: boolean, map?)` matches the modifier.
- `attachInput`'s options gain an optional `onButton?(b: 0 | 1 | 2, down: boolean): void` (optional, so `worldPage.ts:1919`, `mapOverlay.test.ts:426` and `input.test.ts:150` compile unchanged until Task 25 wires it) and an optional `wheelCtrlAsSlot?(): boolean`: while it returns true the wheel resolves as if Ctrl were up (`slotNext`/`slotPrev`); `mousedown`/`mouseup` on the canvas call `onButton` only while it holds the lock and `active()` (button 1 `preventDefault`); `contextmenu` and `auxclick` are prevented on the canvas; `click` requests the lock only while unlocked, so the first click never edits.
- The page (Task 32 wires the mode): while walking `+`/`-` do nothing and Ctrl+wheel acts as the plain wheel (D9), through `wheelCtrlAsSlot: () => fly.mode === 'walk'`.

- [ ] **Step 1: Write the tests.** `keymap.test.ts`: the count; "every entry is SP4a's except `map` (SP4c) and the build group (SP5a)"; "Ctrl+wheel up → `speedUp`, plain wheel up → `slotPrev`, down → `slotNext`"; "`Digit1` with `key` '!' (shifted) resolves `slot1`". The pins the new bindings move: `:15` `bindingKey` includes the modifier (`` `wheel:${b.dir}${b.ctrl ? '+ctrl' : ''}` ``), so `speedUp`'s and `slotPrev`'s wheels stay distinct in "no binding is shared by two actions" (:42-51); `:82` `KeyF` → `'toggleWalk'`; `:99-106` `resolveWheel(-100, true)` / `resolveWheel(3, true)` / `resolveWheel(0, false)`, and `resolveWheel(-1, false, map)`; `:117-118` `bindingLabel` of a wheel with Ctrl (`'Ctrl+Wheel up'`) and without (`'Wheel up'`). `input.test.ts`: ":62-77 Ctrl+wheel steps the speed and the plain wheel steps the slot"; "with `wheelCtrlAsSlot` true, Ctrl+wheel up → `slotPrev`, and `+` still → `speedUp`"; "the first click while unlocked only requests the lock (no `onButton`)"; "locked: LMB, MMB, RMB down/up reach `onButton`; not `active()`: nothing"; "`contextmenu` and `auxclick` are default-prevented on the canvas". `help.test.ts`: "a Build table lists F, E, 1-9, the wheel"; `:57` the headings `['Move', 'Speed', 'World', 'View', 'Build']`. `tips.test.ts`: every action named by a template.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.17 Fly and §5.9 as spec §9 words them, pinned in the SP5a describe.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): F, E, 1-9, the wheel's Ctrl and the mouse buttons` (`git add src/player/keymap.ts src/player/input.ts src/ui/help.ts src/ui/loading/tips.ts test/unit/keymap.test.ts test/unit/input.test.ts test/unit/help.test.ts test/unit/tips.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 25: Interaction rules

**Files:**
- Create: `src/player/interaction.ts`, `test/unit/interaction.test.ts`
- Modify: `src/ui/world/worldPage.ts` (the click queue run in `aim`: LMB break only; `onButton` wired), `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `player/interaction.ts`)

**Interfaces:**
- `type Slot = { readonly type: string; readonly pinned: Readonly<Record<string, string>> } | { readonly fluid: 'water' | 'lava' } | { readonly tool: 'emptyBucket' }` (spec §4.3, master §4.12; `pinned` always `{}` in SP5a: the palette, pick and the defaults create it; shared with Task 26; **(plan)** declared here).
- `interface BodyBox { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }`; `bodyOf(mode: 'walk' | 'fly', eyeX, eyeY, eyeZ, out: BodyBox): BodyBox` (0.6 × 1.8; flight: top 0.18 above the eye).
- `Edit` imported as a type from `workers/protocol.ts` (Task 10's re-export).
- `read` below is `Pick<VoxelStore, 'blockAt' | 'fluidAt'>` (the `aim` section's reader, Task 23). `breakAt(hit: RayHit, read): Edit | null`; `placeAt(hit: RayHit, slot: Slot, lookYawDeg: number, body: BodyBox, read, editable: (cx: number, cz: number) => boolean): Edit | null` (the page passes `(cx, cz) => coordinator.editState(cx, cz) === 0`; the edit path still words a refusal by `editState`, Task 16); `emptyBucketAt(fluidHit: RayHit, read): Edit | null`; `pickAt(hit: RayHit): string /* type name */ | null` — each `Edit` carries `expect` = the voxel's value read now (spec §4.1). Rules exactly spec §4.2: break leaves the fluid byte of a `hold` state; place needs air (any fluid) in y −64 … 319, an editable column, no intersection with the body; `block` clears fluid, `hold` keeps it, `displace` refused in fluid; log axis = the hit face's axis; torch top → `torch`, side → `wall_torch` facing the face's normal, bottom refused; ladder side → facing the face's normal, top/bottom → the horizontal direction nearest the opposite of the look; buckets: `WATER_SOURCE` 16 or `LAVA_SOURCE` 32 into air, water also into a `hold` state; pick: `wall_torch` → `torch`.

- [ ] **Step 1: Write the tests:** one per rule of spec §4.2, including "a stone into the walking body refused"; "flying with the eye at y0 + 1.62 over open air (no floor): a stone at the eye's voxel is refused; a stone at voxel y0 − 1, whose top touches the feet, is allowed (touching is not intersecting; the test is strict)"; "torch on the top of stone → `torch`; on its east face → `wall_torch[facing=east]`; on its bottom → null"; "ladder on a north face faces north; on a floor looking at yaw 200 (south, slightly west; the opposite 20) → facing north; at yaw 250 (the opposite 70) → facing east"; "log on a ±x face → axis x"; "a torch into water → null"; "a ladder into water keeps the water"; "breaking a waterlogged ladder leaves water"; "water into a ladder → ladder + 16; lava into a ladder → null"; "the empty bucket removes the first fluid on the ray"; "pick of a wall torch → `torch`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/interaction.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the page wires `onButton` and runs the queued LMB breaks in `aim`, posting through the edit path; `placeAt`, `emptyBucketAt` and `pickAt` stay unit-tested here, and the page's RMB and MMB arrive with the hotbar (Task 26). Reach and the body use the flight values (`REACH_FLY`, `bodyOf('fly', …)`) until Task 32 adds the mode.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): break, place, buckets and pick` (`git add src/player/interaction.ts src/ui/world/worldPage.ts test/unit/interaction.test.ts test/arch/masterSpec.test.ts`).

---

### Task 26: Hotbar and the build HUD

**Files:**
- Create: `src/player/hotbar.ts`, `src/ui/world/buildHud.ts`, `test/unit/hotbar.test.ts`, `test/unit/buildHud.test.ts`
- Modify: `src/ui/styles.css` (:46 `.world-notices` to `bottom: 4.5rem`; the bar, the crosshair), `src/ui/world/worldPage.ts` (slot actions; the wheel steps the slot (by mode in Task 32); the page's RMB place, `placeAt` with the hotbar's active slot, buckets included, and MMB pick, `pickAt` → `hotbar.pick`), `test/arch/masterSpec.test.ts` (`SP5A_MODULES` rows `player/hotbar.ts`, `ui/world/buildHud.ts`)
- Master: §1's `ui/world/*` entry gains `buildHud.ts (SP5a)` (spec §9's §1 line)

**Interfaces:**
- `HOTBAR_KEY = 'wi.world.hotbar'`; `DEFAULT_HOTBAR: readonly Slot[]` = stone, dirt, grass_block, oak_planks, glass, oak_log, torch, water, lava (each block slot with `pinned: {}`); `interface Hotbar { readonly slots: readonly Slot[]; readonly active: number; select(i: number): void; step(d: 1 | -1): void; assign(slot: Slot): void; pick(typeName: string): void; subscribe(f: () => void): () => void }`; `createHotbar(storage: Pick<Storage, 'getItem' | 'setItem'> | null): Hotbar` — stored at once as `{ v: 1, active, slots }` by type name; `normalizeHotbar(raw: unknown): { active: number; slots: Slot[] }` (an unknown type name, a non-placeable one or a malformed slot → the default slot; a missing or non-object `pinned` → `{}`).
- `buildHud.ts`: `mountBuildHud(host: HTMLElement, o: { hotbar: Hotbar; hud: boolean; locked(): boolean }): { refresh(): void; dispose(): void }` — the crosshair `+` (shown once locked), nine 40 × 40 px swatches 10 px above the bottom centre, the active one with a 2 px white border, the slot name 8 px above the bar for `SLOT_NAME_MS = 1500` (a timer `dispose` clears); text through `textContent`; nothing when `hud` is false.

- [ ] **Step 1: Write the tests.** `hotbar.test.ts`: "defaults; `select(4)`; `step(1)` from 8 wraps to 0"; "`assign` writes the active slot and stores at once"; "round-trip through `wi.world.hotbar` by name, the stored block slots carrying `pinned: {}`"; "an unknown name normalised to the default slot; a missing `pinned` normalised to `{}`"; "`pick('torch')` selects the slot holding torch; `pick('bricks')` puts bricks in the active slot". `buildHud.test.ts` (dom shim): "nine swatches, the active framed"; "the name shows for 1.5 s after a change and its timer is cleared on dispose"; "`hud` false: nothing mounted".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the hotbar, the crosshair and the slot name` (`git add src/player/hotbar.ts src/ui/world/buildHud.ts src/ui/styles.css src/ui/world/worldPage.ts test/unit/hotbar.test.ts test/unit/buildHud.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 27: The creative palette

**Files:**
- Create: `src/ui/palette.ts`, `test/unit/palette.test.ts`
- Modify: `src/ui/world/worldPage.ts` (`paused` :2012 gains `palette.isOpen`; E, M and H with the palette through `paletteFirst`), `src/ui/styles.css`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `ui/palette.ts`)
- Master: §1's ui line naming `palette.ts` gains "(SP5a)" (spec §9's §1 line)

**Interfaces:**
- `paletteFirst(palette: Pick<Palette, 'isOpen' | 'close'>, then: () => void): void` (exported from `worldPage.ts`, the `mapKey` pattern, `worldPage.ts:946`): closes an open palette, then runs `then`; the M and H handlers both use it.
- **The cut line (spec §11):** the search box and its filter are this task's last step and their own commit, so they can be taken out whole; the controller takes the cut only with the user's agreement (a STOP, raised only if the schedule slips), and Task 45 Step 3 words the cut line either way.
- `paletteGroups(query: string): { group: 'building' | 'wool' | 'terrain' | 'fluids'; items: Slot[] }[]` (pure; registry order within a group; Fluids = water, lava, empty bucket; a case-insensitive substring of the display name; empty groups dropped).
- `mountPalette(host: HTMLElement, o: { hotbar: Hotbar; requestLock(): void; onClose(): void }): { readonly isOpen: boolean; open(): void; close(): void; dispose(): void }` — opening releases the lock; a swatch click assigns the active slot; hover names it below the grid; E closes and requests the lock unless the search box has focus (`isTextEntry`); Esc closes and is consumed (the help's pattern, `help.ts:211-219`); no `confirm`/`alert`.

- [ ] **Step 1: Write the tests:** "every `PLACEABLE` type appears once, in its `CATEGORY` group, plus the three bucket items"; "`'wool'` keeps only the Wool group; `'oak'` keeps Oak planks and Oak log; `'zzz'` nothing"; "a click on Bricks assigns it to the active slot"; "E with the search focused types (no close); E unfocused closes and requests the lock; Esc closes and is default-prevented". `worldPage.test.ts`: "M with the palette open closes it, then toggles the map"; "H with the palette open closes it, then opens the help"; a source pin: the frame step's `paused` includes `palette.isOpen`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/palette.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the creative palette` (the palette without the search box, its search tests skipped; `git add src/ui/palette.ts src/ui/world/worldPage.ts src/ui/styles.css test/unit/palette.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).
- [ ] **Step 6: The search** (the cut line): the box, `paletteGroups`' filter, E's focus rule; the search tests enabled; `npm run typecheck && npm test`; commit `feat(ui): the palette's search` (`git add src/ui/palette.ts src/ui/styles.css test/unit/palette.test.ts`).

---

### Task 28: Block undo and redo

**Files:**
- Create: `src/ui/world/blockHistory.ts`, `test/unit/blockHistory.test.ts`
- Modify: `src/ui/world/worldPage.ts` (`installShortcuts` :1998-2001 routed by owner, `ownerOf` `mapOverlay.ts:117-121`; each successful action post recorded), `src/ui/world/editPath.ts` (`settled()`), `src/ui/help.ts` (`UNDO_REDO_LINE` :56), `test/unit/editPath.test.ts`, `test/unit/help.test.ts:62`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts` (`SP5A_MODULES` row `ui/world/blockHistory.ts`)
- Master: §4.12's block-undo paragraph (spec §9); §1's `ui/world/*` entry gains `blockHistory.ts` (spec §9's §1 line)
- Spec: Spec corrections (an undo's `expect` when the other side has no entry)

**Interfaces:**
- `BLOCK_HISTORY_STEPS = 100`; `interface BlockStep { readonly edits: readonly { x: number; y: number; z: number; before: number; after: number }[] }` (`before`/`after` entries, `NO_ENTRY` for none).
- The edit path (Task 16) gains `settled(): Promise<void>`: resolves once no post is pending and after each reply's continuations (the page's `record`) have run.
- `createBlockHistory(o: { post(edits: readonly Edit[]): Promise<EditOutcome>; read(x, y, z): number; pending(): boolean; settled(): Promise<void>; notices: { show(text: string, ms: number): void } }): { record(step: BlockStep): void; undo(): void; redo(): void; readonly size: number; readonly redoSize: number }` (`pending` and `settled` the edit path's) — undo posts the before-entries (`set` with the value, `revert` for `NO_ENTRY`) with the after side's value as `expect`, redo the reverse; a side that is `NO_ENTRY` takes `read(x, y, z)` as its `expect`, where `read` is the page's view-free `blockAt`/`fluidAt` packed as state << 8 | fluid inside an `enterRead`/`exitRead` (the voxel then holds its generated value); a press while `pending()` (any post, clicks included, or its own previous undo) is held until `settled()`; a refusal keeps the step and shows `Can't undo there: not loaded` / `Can't undo there: regenerating` (`Can't redo there: …`) for 4 s; **(plan)** the other refusals (`changed`, `noProto`, `full`, `failed`) also keep the step and show no notice of their own (the edit path already shows `full`'s and the failure's); success shows `Undo · blocks` / `Redo · blocks` for 1.5 s; a new step clears the redo side.
- `UNDO_REDO_LINE = "Ctrl+Z undo · Ctrl+Y redo: blocks while you play, the map's settings while the map has the controls (Ctrl+Shift+Z also descends while flying; Ctrl+Y does not)"`.
- The page records: after each successful action post (a click, a bucket, a hold-repeat, and `WiTest.edit`), `history.record` with one `BlockStep`: per edit k, `before` = the reply's `prev[k]` (`NO_ENTRY` when 0xFFFFFFFF) and `after` = the posted `value` (`NO_ENTRY` for a `revert`); a refused post records nothing.

- [ ] **Step 1: Write the tests** (fake post with controllable replies): "101 steps keep the last 100"; "undo then a new step clears redo"; "undo of a place posts `revert` with `expect` the placed value; redo posts `set` with `expect` = the generated value read now"; "place, undo, redo: the redo is accepted" and "undo of a step whose after is `NO_ENTRY` is accepted" (a fake sim checking `expect` against its voxels); "Ctrl+Z during a click's pending post undoes that click's step after its reply"; **Review Focus 2:** "12 undos 33 ms apart, step 3's post answering `regenerating` until the 8th press: steps 1-2 undone, presses 3-7 each refused with `Can't undo there: regenerating` and step 3 still on top, the 8th undoes it, and no press runs before the previous reply"; `editPath.test.ts`: "`settled` resolves after the pending replies and their continuations"; `worldPage.test.ts`: "the page: owner 'world' → the block history, 'map' → `session.undo()`"; "a place, then Ctrl+Z with the world owning, posts its `revert`"; "a hook edit (`WiTest.edit`) then Ctrl+Z posts the revert"; `help.test.ts:62` with the new line. The spec's §4.5: "each with the other side's value as `expect` (the value read now when that side has no entry)" (the Spec correction).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.12's paragraph as spec §9 words it.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): block undo and redo by who has the controls` (`git add src/ui/world/blockHistory.ts src/ui/world/worldPage.ts src/ui/world/editPath.ts src/ui/help.ts test/unit/blockHistory.test.ts test/unit/editPath.test.ts test/unit/help.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 29: Hold to repeat

**Files:**
- Modify: `src/ui/settings.ts` (`WorldSettings` :7-19, `SETTINGS_DEFAULTS`, `normalizeSettings` :47-64), `src/ui/help.ts` (settings :150-175: the checkbox row), `src/ui/world/worldPage.ts` (the repeat timer on the frame clock; Task 25's `onButton` now goes through `down`/`up`), tests `test/unit/settings.test.ts`, `test/unit/help.test.ts`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts`
- Create: `src/ui/world/holdRepeat.ts`, `test/unit/holdRepeat.test.ts`
- Master: §4.12's Actions line (spec §9)

**Interfaces:**
- `WorldSettings.holdRepeat: boolean`, default `false`, normalised like `watchLive`; the help row "Hold mouse button to repeat" (a checkbox, `setting-hold-repeat`).
- `REPEAT_BREAK_S = 0.3`, `REPEAT_PLACE_S = 0.2`; `createHoldRepeat(o: { enabled(): boolean; pending(): boolean; queue(b: 0 | 1 | 2): void }): { down(b: 0 | 1 | 2, t: number): void; up(b: 0 | 1 | 2): void; stop(): void; tick(t: number): void }` — `down` queues once for every button; while enabled and held, `tick` queues 0 or 2 again at max(previous + `REPEAT_*`, the previous reply's arrival), never while `pending()` (it waits for the reply); `stop` on the lock's release, the palette, the map or a mode switch; button 1 never repeats. The page's `onButton(b, down)` (Task 25) calls `down(b, t)`/`up(b)` in place of queuing directly, so a press queues exactly once with the setting off; `tick` runs inside the page's `aim` (Task 23), after the DDA and before the queued clicks run, so a repeat is aimed by that frame's DDA (the frame step is unchanged).

- [ ] **Step 1: Write the tests:** "off: one action per press however long held"; **Review Focus 1:** "on, held LMB for 1.0 s with each reply 50 ms after its post: queued at 0, 0.3, 0.6, 0.9 s; each a new target (the page's `aim` re-reads) and one history step; no `changed` refusal"; "RMB on: 0, 0.2, 0.4, … 1.0 s"; "RMB held with each reply 250 ms after its post: the second place is queued at 0.25 s (at the reply), not 0.2 s; LMB with each reply 350 ms after its post: the second break at 0.35 s"; "`up`, `stop` end it; MMB never repeats"; `settings.test.ts`: "`holdRepeat` false for a missing or non-boolean value"; `help.test.ts`: "the checkbox round-trips through `wi.world.settings`"; `worldPage.test.ts` (exported helpers, dom shim): "with the setting on and LMB held, opening the palette, releasing the lock (a `pointerlockchange` to none) and opening the map each call `stop`: no break is queued after them"; "with the setting off, one LMB press posts one break". SP5a describe: §4.12's Actions contain `(SP5a: the player's body counts in flight too; one action per click, or, with the 'Hold mouse button to repeat' setting, repeated while held: break every 0.3 s, place every 0.2 s)`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.12's Actions as spec §9.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Hold mouse button to repeat, off by default` (`git add src/ui/settings.ts src/ui/help.ts src/ui/world/worldPage.ts src/ui/world/holdRepeat.ts test/unit/settings.test.ts test/unit/help.test.ts test/unit/worldPage.test.ts test/unit/holdRepeat.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 30: Physics: the swept AABB and step-up

**Files:**
- Create: `src/player/physics.ts`, `test/unit/physics.test.ts`

**Interfaces:**
- `BODY_W = 0.6`, `BODY_H = 1.8`, `STEP_UP = 0.6`, `SUBSTEP = 0.35`.
- `interface VoxelReader { blockAt(bx, by, bz): number; fluidAt(bx, by, bz): number; publishedAt(bx, bz): boolean; collideTop?(state: number): number }` (`VoxelStore` satisfies it). **(plan)** `collideTop`, when present, gives the top of a colliding state's collision box within its voxel, in (0, 1]; absent, every colliding state is a full cube (1). A voxel then collides over [by, by + top) in all three axes: it blocks x/z only where the body's minY < by + top, it clips the y sweep at by + top, and step-up lowers onto it. Only the unit test's synthetic 0.5 ledge uses it until SP8a (spec §3.2).
- `solidAt(r: VoxelReader, bx, by, bz): boolean` — `COLLIDE` cube or boxes (as cube until SP8a); −1 (unpublished) is not solid.
- `moveBody(r: VoxelReader, p: { x: number; y: number; z: number /* feet */ }, dx, dy, dz, onGround: boolean, out: { x: number; y: number; z: number; hitX: boolean; hitY: boolean; hitZ: boolean; onGround: boolean }): void` — per axis y, then x, then z, in substeps of at most 0.35; a horizontal move blocked while on the ground is retried 0.6 higher and the body then lowered onto what it finds; colliding voxels by `collideTop`; allocates nothing. **(plan: the loop the tests do not pin)**
  ```
  for axis in (y, x, z): remaining = d[axis]
    while |remaining| > 0: step = clamp(remaining, ±0.35)
      the AABB swept by step: for each voxel it newly overlaps (at most 2 × 3 × 2 per step) that is solid:
        clip step to the face (minus 1e-7); hit[axis] = true
      move by step; remaining -= step (0 after a hit)
  step-up: if onGround and (hitX or hitZ): retry from p raised by min(0.6, the free height above), then move down by up to 0.6 + |dy|
           keep the retry only if it moved further horizontally
  ```

- [ ] **Step 1: Write the tests:** "falling 10 blocks onto stone stops with the feet at its top, `onGround` true"; "a move of 2.0 in x into a wall 1.2 away stops at 0.9 (the half width), `hitX`"; "a diagonal into a corner slides along the free axis"; "substeps: a move of 3 per tick does not tunnel through a 1-block wall"; "step-up onto a 0.5 ledge (a canned reader whose `collideTop` gives 0.5 for its ledge state) succeeds, the feet ending at the ledge's top; onto a 1-block wall fails"; "an unpublished column's voxels never collide"; "allocates nothing over 10,000 moves".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/physics.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): the swept AABB with step-up` (`git add src/player/physics.ts test/unit/physics.test.ts`).

---

### Task 31: The walk controller at 20 Hz

**Files:**
- Create: `src/player/walk.ts`, `test/unit/walk.test.ts`
- Modify: `test/arch/masterSpec.test.ts`
- Master: §4.17's Walk lines (spec §9)

**Interfaces:**
- `TICK_S = 0.05`, `MAX_TICKS = 5`, `EYE = 1.62`; per-tick constants (spec §3.2): `SLIP = 0.6`, `SLIP_ICE = 0.98`, `AIR_DRAG = 0.91`, `WALK_ACCEL = 0.1 * 0.16277136` (divided by f³), `SPRINT_MUL = 1.3`, `AIR_ACCEL = 0.02`, `AIR_ACCEL_SPRINT = 0.026`, `JUMP_VY = 0.42`, `GRAVITY = 0.08`, `VDRAG = 0.98`, `WATER_DRAG = 0.8`, `WATER_GRAVITY = 0.005`, `LAVA_DRAG = 0.5`, `LAVA_GRAVITY = 0.02`, `SWIM_ACCEL = 0.04`, `FLUID_MOVE = 0.02`, `BANK_HOP_VY = 0.3`, `LADDER_V = 0.1175`.
- `interface WalkState { px: number; py: number; pz: number; x: number; y: number; z: number /* feet: previous and current tick */; vx: number; vy: number; vz: number; onGround: boolean; acc: number; snapPending: boolean }`; `createWalkState(): WalkState`.
- `walkTick(w: WalkState, r: VoxelReader, wishX: number, wishZ: number, jump: boolean, down: boolean, sprint: boolean): void` — one 20 Hz tick per spec §3.2's table: ground (f = slip · 0.91, slip 0.98 when the block under the body's centre at feet − 0.5 is `SLIPPERY`), air, out-of-fluid vertical (terminal 3.92), water, lava, bank hop, ladder (after the fluid row), unloaded (a column under the footprint not Published: `vy` 0, no vertical move, horizontal free and not colliding with it; `onGround` keeps its value from the previous tick, since no vertical sweep runs to update it: a body that was on the ground keeps the ground row with slip 0.6, the block under its centre in an unpublished column reading −1, not `SLIPPERY`, and one in the air keeps the air row).
- `walkStep(w: WalkState, r, held: ReadonlySet<Action>, yawDeg: number, dtS: number, eye: { x: number; y: number; z: number }): void` — the accumulator (at most 5 ticks), `wish` from `forward`/`back`/`left`/`right` along the yaw's horizontal projection (normalised, computed inline: no `forwardXZ`), writes the drawn eye (previous/current feet interpolated by `acc / TICK_S`, + 1.62) into `eye`.
- `setFeet(w: WalkState, x, y, z): void` — both feet set, velocity 0, `acc` 0 (no interpolation across F or a teleport).

- [ ] **Step 1: Write the tests** (a flat stone floor reader; displacement per tick once steady, 200 ticks of warm-up):
  - "walking: 0.2203 ± 0.0005 per tick (4.4 blocks/s); sprinting 0.2863 ± 0.0005 (5.7)";
  - "ice (`ice` and `packed_ice` under the centre at feet − 0.5): steady 0.2121 ± 0.0005; 90 % of it at tick 20 or 21; after letting go the slide is 1.75 ± 0.05 blocks (0.265 ± 0.01 on stone)"; "a body half over ice with its centre over stone does not slide";
  - "jump apex 1.2522 ± 0.01; terminal −3.92 ± 0.001 per tick";
  - "air: 0.02 per tick of wish, 0.026 sprinting, `·0.91`";
  - "water: no key −0.025 ± 0.0005 per tick (0.5 blocks/s), Space +0.175, Shift −0.225, horizontal 0.1"; "lava: −0.04, Space +0.04, Shift −0.12, horizontal 0.04";
  - "bank hop: in water against a 1-block bank with air 0.6 higher, `vy` becomes 0.3 and the body climbs out";
  - "ladder: Space +0.1175 per tick (2.35 blocks/s), Shift 0, no key falls at most 0.1175; a waterlogged ladder applies the clamp after the water row";
  - **Review Focus 3:** "walking east at 4.4 blocks/s from a Published column onto a non-Published one: `vy` 0 and y unchanged for 40 ticks while x keeps growing by 0.2203 ± 0.0005 per tick (`onGround` kept, so the ground row applies) and nothing in the unpublished column collides";
  - "`walkStep` with dt 0.016 runs 0 or 1 ticks and interpolates the eye; dt 0.4 runs 5 ticks"; "`setFeet` makes the drawn eye jump with no interpolation"; "reads below y −64 hit bedrock, above 319 air"; "`walkStep` allocates nothing over 10,000 calls".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/walk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.17 as spec §9 words it (the in-water gravity, lava, `SLIPPERY`, the 20 Hz values); `SP5A_MODULES` rows `player/walk.ts`, `player/physics.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): the walk controller at 20 Hz: ground, air, water, lava, ladders, ice` (`git add src/player/walk.ts test/unit/walk.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 32: Modes: F and the frame step's dispatch

**Files:**
- Modify: `src/player/fly.ts` (`FlyState` :17 gains the required `mode: 'fly' | 'walk'`), `src/ui/world/frameStep.ts` (:125 dispatch by mode; the walk step inside its own `enterRead`/`exitRead`; `FrameStepDeps` gains the required `walk`), `src/ui/world/worldPage.ts` (F; the near plane; the mode's reads below), tests `test/unit/frameStep.test.ts`, `test/unit/fly.test.ts`, `test/unit/worldPage.test.ts`, and the `FlyState` literals `tsc` reports: `test/unit/teleport.test.ts:34`, `test/unit/mapOverlay.test.ts:150`, `test/unit/zeroAlloc.test.ts:302` (each gains `mode: 'fly'`), plus any `src/` literal; `test/unit/zeroAlloc.test.ts:502`'s `createFrameStep` gains a no-op `walk` for the flying case

**Interfaces:**
- `FlyState.mode` (`'fly'` at the reveal and after every load, D1); `toggleMode(fly: FlyState, w: WalkState): void` — fly → walk: `setFeet(w, x, eye − 1.62, z)`, `vy` 0 (the unstuck scan is Task 34's); walk → fly: the eye kept, the velocity zeroed.
- `FrameStepDeps.walk: WalkState` (Task 31) and `FrameStepDeps.store` widened again by `'publishedAt' | 'heightAt'` (Task 33's `WalkReader`); the frame step: `if (fly.mode === 'walk') { store.enterRead(); walkStep(d.walk, store, d.held(), fly.yaw, dtS, fly); store.exitRead(); } else stepFly(…)` (`held` carries `forward`/`back`/`left`/`right`, `up` = jump, swim up and climb, `down` = swim down and hold, `sprint` = Ctrl, `keymap.ts:12-14`), skipped while `paused` as `stepFly` is; the page sets `setNear(NEAR_WALK | NEAR_FLY)` on each switch and stops hold-repeat (Task 29).
- The page reads `fly.mode` for: the reach in `aim` (`REACH_WALK` 6 / `REACH_FLY` 10), `bodyOf`'s mode in `placeAt`, the wheel (`attachInput`'s `wheelCtrlAsSlot: () => fly.mode === 'walk'`, Task 24), and `+`/`-` (`speedUp`/`speedDown` ignored while walking). Until this task the page uses the flight values (Tasks 25-26).

- [ ] **Step 1: Write the tests:** "F flies → walks: the feet at eye − 1.62, the drawn eye unchanged on that frame, then falling"; "walks → flies: eye kept, velocity 0"; "the frame step in walk mode calls the walk step inside one read section and never `stepFly`"; "the near plane follows the mode"; "a load opens in flight"; `worldPage.test.ts` (exported helpers): "reach 6 walking, 10 flying"; "Ctrl+wheel steps the slot while walking"; "`+` does nothing while walking".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): F switches flight and walking` (`git add src/player/fly.ts src/ui/world/frameStep.ts src/ui/world/worldPage.ts test/unit/frameStep.test.ts test/unit/fly.test.ts test/unit/worldPage.test.ts test/unit/teleport.test.ts test/unit/mapOverlay.test.ts test/unit/zeroAlloc.test.ts`, plus any `src/` file `tsc` named).

---

### Task 33: The walking teleport

**Files:**
- Modify: `src/ui/world/teleport.ts` (`TeleportOptions` :44-56), `src/ui/world/worldPage.ts` (:1933), `src/player/walk.ts` (the snap; `WalkReader`), `test/unit/teleport.test.ts` (:81-236 kept for flight), `test/unit/walk.test.ts` (its canned readers gain `heightAt`), and `test/unit/frameStep.test.ts` if its fake reader reaches `walkStep`
- Master: §3.7 already renamed in Task 1; nothing more

**Interfaces:**
- `TeleportOptions.walk?: { active(): boolean; arrive(x: number, feetY: number, z: number): void }` — walking: the feet at `max(surface, water) + 1` (both feet set, yaw and pitch kept, velocity 0, `snapPending` true); flight unchanged (`landingY`).
- The walk tick (Task 31's `walkTick`): while `snapPending` and the column is not Published, the unloaded rule holds it; on the first tick it is Published, the feet go to `heightAt('motionBlocking')` (already y + 1, `store.ts:143-147`), `snapPending` clears (the unstuck scan follows in Task 34). **(plan)** `walk.ts` declares `interface WalkReader extends VoxelReader { heightAt(kind: 'motionBlocking', bx: number, bz: number): number | null }` (the store's `heightAt(kind, bx, bz)`, `store.ts:147`) and `walkTick`/`walkStep` take it; `VoxelReader` and `physics.test.ts` stay unchanged.

- [ ] **Step 1: Write the tests:** "walking teleport over land (surface 70, water −∞): feet 71, look kept, `snapPending`"; "over the sea (surface 40, water 62): feet 63"; "hover while unpublished (y unchanged over 20 ticks), then on publish the feet at `heightAt('motionBlocking')` (65) and `snapPending` false"; "flight's landing unchanged (`teleport.test.ts:81-236`)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/teleport.test.ts test/unit/walk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): a walking teleport lands on the ground` (`git add src/ui/world/teleport.ts src/ui/world/worldPage.ts src/player/walk.ts test/unit/teleport.test.ts test/unit/walk.test.ts`, and `test/unit/frameStep.test.ts` if changed).

---

### Task 34: Unstuck

**Files:**
- Modify: `src/player/walk.ts`, `src/player/physics.ts`, `test/unit/walk.test.ts`

**Interfaces:**
- `UNSTUCK_MAX_Y = 400`; `bodyIntersects(r: VoxelReader, x, y, z): boolean` (the body's at most 2 × 3 × 2 voxels, no allocation); at the start of every `walkTick`, when the body intersects a colliding block, the feet move up one block at a time to the first free y (at most 400), the velocity's `vy` set to 0; F and the teleport's snap call the same scan.

- [ ] **Step 1: Write the tests:** "F with the eye 1 block under the ground's top T: on the first tick the feet are at T + 0.38 (whole-block lifts keep the fraction), and after falling the body stands on T (feet T, `onGround`)"; "after the snap onto a column published with other terrain"; **Review Focus 3:** "the column under the feet (feet at a whole y) re-published with ground 3 blocks above the feet: on the next tick the feet are at the ground's top, then the body falls normally"; "a stone placed into the body (an edit landing): lifted on the next tick"; "feet 1 block inside the stone floor of a 2-block air pocket under 10 blocks of stone: lifted into the pocket (the first free y), not above the stone"; "a canned reader solid from −64 to 450: the scan stops with the feet at 400 (`UNSTUCK_MAX_Y`)"; "no allocation".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/walk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): lifted out of blocks on any tick` (`git add src/player/walk.ts src/player/physics.ts test/unit/walk.test.ts`).

---

### Task 35: HUD, help and tips; zero allocation of SP5a's frame

**Files:**
- Modify: `src/ui/hud.ts` (`HudData` :36-66 gains `mode` and `edit`; lines :122-123), `src/ui/help.ts` (the Ctrl-before-a-digit note), `src/ui/loading/tips.ts` (the new keys), `src/ui/world/worldPage.ts`, `src/ui/world/frameStep.ts` (the main-thread timings), `src/ui/world/bench.ts` (the `mainP95Ms` ring), `test/tools/uiSmoke.ts` (`HUD_POSITION` :696 accepts the mode prefix, `` new RegExp(`^(?:(?:Walk|Fly) · )?x ${NUM} y ${NUM} z ${NUM} ·`, 'm') ``, and the `parseHud` doc comment says so), tests `test/unit/hud.test.ts`, `test/unit/help.test.ts`, `test/unit/tips.test.ts`, `test/unit/zeroAlloc.test.ts` (the frame-step case :581-670), `test/unit/bench.test.ts`, `test/unit/uiSmoke.test.ts` (:693-718's `hudData` gains `mode: 'fly'` and `edit: null`, or the shape this task gives them; :741-744 parse a fly-mode and a walk-mode HUD)

**Interfaces:**
- The position line starts `Walk · ` or `Fly · `; the speed line reads `walking` in walk mode; `edit p95 <n> ms (<k>)` once `k` > 0 edits (from `editLatency.visibleP95()`).
- `mainP95Ms` (Task 17's 0 until now): the frame step times its input handling, the walk step and `aim` (the DDA, the queued clicks, the outline) per frame on the bench's clock into a preallocated ring of the bench record (no allocation); `summarizeBench`'s `edit.mainP95Ms` is that ring's p95 over L10.
- The help's note: "Let go of Ctrl before a digit: Ctrl+1 … Ctrl+8 switch the browser's tabs". The tips name F, E, 1-9 and the wheel, Ctrl+wheel and `+`/`-`.

- [ ] **Step 1: Write the tests.** `hud.test.ts`: "walk mode: `Walk · x …` and `speed walking`"; "no edits: no edit line; 12 edits p95 31.4: `edit p95 31 ms (12)`". `help.test.ts`, `tips.test.ts`: the note and the tips. `uiSmoke.test.ts`: "`parseHud` reads the position from a `Fly · x …` and a `Walk · x …` row of `mountWorldHud`". `bench.test.ts`: "a synthetic L10 whose frames carry main-thread timings reports their p95 as `edit.mainP95Ms`". `zeroAlloc.test.ts`: "10,000 frame steps at rest in walk mode on a Published floor (the walk step, the DDA, the outline with a fixed target, the hotbar and the hold-repeat tick) grow the heap by less than the boxing budget of 256 B per tick"; "the same flying".
- [ ] **Step 2: Run** them. Expected: FAIL (the HUD lines); `zeroAlloc` PASS on Tasks 22-34's code, else find the allocation, fix it in its module with a unit test.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the HUD's mode and edit latency, the help's and the tips' new keys; zero allocation of SP5a's frame` (`git add src/ui/hud.ts src/ui/help.ts src/ui/loading/tips.ts src/ui/world/worldPage.ts src/ui/world/frameStep.ts src/ui/world/bench.ts test/tools/uiSmoke.ts test/unit/hud.test.ts test/unit/help.test.ts test/unit/tips.test.ts test/unit/zeroAlloc.test.ts test/unit/bench.test.ts test/unit/uiSmoke.test.ts`).

---

### Task 36: L3 and E5: `edit.metric.ts` and its rows (first CI run)

**Files:**
- Create: `test/metrics/edit.metric.ts`, `test/harness/inProcessSim.ts` (`inProcessSimWorker(handler: ReturnType<typeof createSimHandler>, delayMs: () => number): SimWorkerLike`: posts each message to the handler and answers after the injected delay, transfers kept)
- Modify: `test/thresholds.ts` (L3 and E5 rows), `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs` (`render` gains `edit.metric.ts`), `test/unit/shards.test.ts` (:39), the SP5a spec's Threshold log, master §6.4's E1-E6 line, `test/arch/masterSpec.test.ts`

**Interfaces:**
- Rows: `L3: { mismatches: { max: 0, activeFrom: 'SP5a' } }`, `E5: { sessionStale: { max: 0, activeFrom: 'SP5a' }, sessionLightMismatches: { max: 0, activeFrom: 'SP5a' } }`.
- `metricTest('L3', ['mismatches'], …)` (spec §6.1): `genRegion` upTo 'L' (seed 42, the spawn; 6 × 6 fast, 10 × 10 quick and full) into a store; `applyEdits` with the real relight, each edit ≥ 2 columns from the edge; 100 edits on fast, 500 on quick and full: place and break stone, glass, ice, torch, wall torch, a waterlogged ladder, water and lava (seeded), edits at y 319 and torches beside lava, plus 20 shaft cases (a 1 × 1 shaft of ≥ 10 blocks into an enclosed space, opened then closed); after each, each column of the edited 3 × 3 compared with a fresh `copyLightRegion` + `lightRegion` (`mayEmit` true); every 50th and after the last, also with `referenceLight` over the 5 × 5-column box centred on it.
- `metricTest('E5', ['sessionStale', 'sessionLightMismatches'], …, { outName: 'E5.session' })`: the real coordinator (`retainAllProtos: true`, `setStrict(false)` after the fill), `createWorkerPool(2, inProcessWorker)`, an in-process sim answering after a seeded 0-20 ms delay (`sim = createSimClient(() => inProcessSimWorker(createSimHandler(), seededDelay), …)`), `worldJobsOf(pool, sim)`, edits posted through `createEditPath` (its pins and `markEdited`), a shared store at RD 4 (fast) or 6: 20 edits near the spawn (torches among them, some within 15 voxels of a border); a teleport 640 columns east until the old place is freed; back; every edited voxel at its latest value and each edited 3 × 3's light equal to a fresh `lightRegion`; **the race:** an edit with a 20 ms reply, then the teleport in the same frame; **the neighbour:** a torch near a border, the camera moved so only the neighbour across it leaves keepVoxels and regenerates, its light compared.
- Recorded: per tier the edit count, relight p50/p95, the comparison time, E5's frames.

- [ ] **Step 1: Write the metric and the rows in one go** (a part activates at once in a started SP). SP5a describe: §6.4's E1-E6 line contains `(the session part SP5a, the flush part SP5b)`; `shards.test.ts:39`: `render` lists `edit.metric.ts` last; `SP5A_MODULES` row for the test entry `metrics/edit.metric.ts`.
- [ ] **Step 2: Prototype timing** (spec §7): `time npx vitest run --project metrics-fast test/metrics/edit.metric.ts` and `--project metrics-quick`. Expected: PASS, every part 0; fast ≤ 25 s, quick ≤ 50 s. Above: E5's RD on quick drops to 4 first, then the lever (a shard of its own), recorded.
- [ ] **Step 3: Govern.** `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP5a Task 36: L3 mismatches max 0, E5 sessionStale max 0 and sessionLightMismatches max 0, gated from SP5a on every tier (edit.metric.ts, L3 and E5.session; spec §6.1); new parts.`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then `node .github/scripts/metricShards.mjs check` and `node .github/scripts/fastShards.mjs check`. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): L3 and E5's session part` (`git add test/metrics/edit.metric.ts test/harness/inProcessSim.ts test/thresholds.ts test/thresholds.lock.json .github/scripts/metricShards.mjs test/unit/shards.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).
- [ ] **Step 6: The controller pushes the branch** (`git push -u origin sp5a/build-and-walk`), waits for the run (`gh run watch`), and records every job's time against spec §7 under `## Exit evidence` as "### The first SP5a CI run (Task 36)"; `unit (rest)` above 173 s: `.github/scripts/unitShards.mjs`'s `heavy` gains `relight` and `coordinator` (:17-19); `test/unit/shards.test.ts`'s `HEAVY` (:17-18) gains the two files (12), `rest` has length 24, the title says "its twelve files"; `npm run typecheck && npm test` and `node .github/scripts/unitShards.mjs check`; committed as `ci: relight and coordinator tests into the heavy unit shard` (`git add .github/scripts/unitShards.mjs test/unit/shards.test.ts`), pushed, and that run's times recorded too. Commit `docs(sp5a): the first CI run` (`git add docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 37: `relight.edit` in `npm run bench`; `light.column` re-measured

**Files:**
- Modify: `test/bench/gates.ts` (`BENCH_ROWS` :56-63 appends `relight.edit`; `RELIGHT_P95_MAX_MS = 3`; `AbsoluteLatencies.relightP95`; `absoluteGateFailures`), `test/bench/noise.bench.ts` (the row; `light.column` passes `mayEmit` false as L does without a flag), `test/baselines.json` (recorded), `test/unit/benchGates.test.ts`
- Spec: Spec corrections (baselines recorded once)

**Interfaces:**
- `relight.edit`: 256 items on a seed-42 region, cycling torch place, torch break, stone place, stone break, shaft open, shaft close (a 1 × 1 shaft 12 blocks deep into a closed 5 × 4 × 5 air room carved before the run); `RELIGHT_RUN = { iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 }`. The timed call: each item is `applyEdits` of that item's one edit on the region's store with a `DiffStore`, returning `{ overriddenDuration: result.relightMs }`, so only the relight is timed (the write, the heightmap patch and the section copies stay untimed), and the cycle keeps every `expect` current. **(plan)** tinybench 6.2 reports no p95 (`index.d.ts:562-576`): `relightP95` is the row's `latency.p99`, an upper bound of p95 (the `column.sample` precedent, `noise.bench.ts:144-145`), and the gate is p99 ≤ `RELIGHT_P95_MAX_MS` = 3, stricter than the spec's p95 ≤ 3 ms.

- [ ] **Step 1: Write the tests:** `benchGates.test.ts`: "a relight p99 (`relightP95`) of 3.1 ms fails `absoluteGateFailures`; 2.9 passes"; "`BENCH_ROWS` ends `'light.column', 'mesh.section', 'relight.edit'`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/benchGates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; on a quiet machine `npm run bench:record`, then `npm run bench`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS; `relight.edit` p95 ≤ 3 ms; `light.column` within 4 ms / 8 ms and +30 %; every row within its gates.
- [ ] **Step 5: Commit** `test(bench): relight.edit, p95 within 3 ms` (`git add test/bench/gates.ts test/bench/noise.bench.ts test/baselines.json test/unit/benchGates.test.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 38: Integration: `edit.test.ts`

**Files:**
- Create: `test/integration/edit.test.ts`
- Modify: `test/harness/nodeWorker.ts` (`NodeWorkerOptions` gains `factory?: string` (default `'createTaskHandler'`) and `retryMs?: number` (default `LIMBO_RETRY_MS`)), `test/harness/region.ts` (`GenRegionOptions` :33 gains `diff?: ReadonlyMap<number, ColumnDiff>`, which requires `threads: 1` and no `cache`: `genRegion` throws `genRegion: diff needs threads 1 and no cache` otherwise, since the 4-thread path's D runs in `regionWorker.ts:91` with no diff and the region cache's key ignores it), `test/unit/regionHarness.test.ts`, `test/arch/masterSpec.test.ts`
- Spec: Spec corrections (the sim's Node worker)
- Master: §1's test entry gains `integration/edit.test.ts`

**Interfaces:**
- Two pool workers from `buildNodeTaskWorker('edit')` and the sim from `buildNodeTaskWorker('edit-sim', { entry: 'src/workers/simHandler.ts', factory: 'createSimHandler', retryMs: 100 })`, wrapped as a `SimWorkerLike` for `createSimClient`; one shared store at RD 4 around seed 42's spawn; the real coordinator (`retainAllProtos: true`, `setStrict(false)` after the fill), pool, driver, apply control and edit path; each check compares the inner region's `litRegionHash` with `genRegion`'s with the same entries as `diff`.

- [ ] **Step 1: Write the test** (one file, its cases in order, about 15-20 s): "50 edits of every kind (stone, glass, ice, torch, wall torch, ladder, water, lava, breaks) after the fill: equal to `genRegion` + entries"; **Review Focus 5:** "a terrain Apply (`density.detailAmpHi` 4.0): equal to `genRegion` on the new params + the same entries"; **Review Focus 2:** "undo of all 50 through the block history: equal to `genRegion` on the Apply's params with no diff (the DiffStore empty)"; "after unloading everything and draining the limbo, every pool slot is free"; every `genRegion` comparison uses `threads: 1`. `regionHarness.test.ts`: "`genRegion` with a diff equals the overlay of D"; "a diff with `threads: 4`, or with `cache: true`, throws". SP5a describe: the test entry contains `(SP5a: metrics/edit.metric.ts, integration/edit.test.ts)` and both exist.
- [ ] **Step 2: Run** `npx vitest run --project integration test/integration/edit.test.ts`. Expected: PASS; a failure is a bug, fixed in its module with a unit test.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(integration): edits, an Apply and undo equal genRegion with the same entries` (`git add test/integration/edit.test.ts test/harness/nodeWorker.ts test/harness/region.ts test/unit/regionHarness.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 39: Browser smoke: `build` and `walk`; `overlay`'s Ctrl+Z

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` :467-471; the `overlay` step :2479-2485), `test/unit/uiSmoke.test.ts` (:240-245), `src/ui/world/worldPage.ts` (`WiTest` gains `mode()`, `aim()`, `hotbar()`, `blockHistory()`, `lightAt()`, `feet()`, `heightAt()`)
- Spec: Spec corrections (the torch check reads block light, no night setup)

**Interfaces:**
- `WiTest.mode(): 'fly' | 'walk'`; `aim(): { hit: boolean; x: number; y: number; z: number; face: number; outline: boolean }` (the DDA's hit whether or not the pointer is locked; `outline` whether the outline object is visible); `hotbar(): { active: number; slots: string[] }`; `blockHistory(): { size: number; redo: number }`; `lightAt(x: number, y: number, z: number): number` (−1 when the column is not Published); `feet(): { x: number; y: number; z: number; onGround: boolean; snapPending: boolean } | null` (null while flying); `heightAt(x: number, z: number): number | null` (`motionBlocking`); each read inside a read section. (`WiTest.edit` records a block-history step, Task 28.)
- Steps `build` and `walk` between `overlay-mesh` and `console`, as spec §6.4:
  - **build**, on `/?rd=4&renderer=batch&wiTest=1&pitch=-60` (the default opening pitch −10° from 2 blocks up meets the ground about 11.5 blocks away, past reach 10, `firstView.ts:11-21`; at −60° it is about 2.3 away): place and break through the hook (and with the mouse when headless Chrome grants the lock, skipped with the reason otherwise, as `uiSmoke.ts:2490-2496`); `blockAt` reads the value back; the HUD's edit count grows; Ctrl+Z restores, Ctrl+Y redoes (the hook's edits are history steps); E opens the palette listing every `PLACEABLE` type (48 type swatches plus 3 buckets), a swatch click sets the active slot, Esc closes it; **(plan)** a torch placed through the hook raises the block light beside it (`lightAt(…) & 15 ≥ 13`), with no night setup (a Spec correction: block light does not depend on the time, and T only cycles the time speed; `build-night` covers the night look); a block under water: read `aim()` for block B, place water on B's hit-face neighbour through the hook, then `aim()` still reports B; `outline` true checked only when the lock was granted, otherwise skipped with the reason (the headful production check covers it).
  - **walk**, on `/?rd=4&renderer=batch&wiTest=1`: F; within 3 s `mode()` is 'walk' and `feet()` reports `onGround` with y stable; then a 16-block stone path placed through the hook at the feet's level along the yaw (stone at feet y − 1, the two voxels above each set to air), W held on it for 4 s moves the feet more than 12 blocks horizontally (on a failure the yaw, the start and end feet and the blocks ahead are recorded); Space jumps: a page-side requestAnimationFrame tracker of `feet().y`'s maximum, read back with `p.eval`, rises more than 1 above the start (the HUD's 250 ms refresh would miss the 270 ms window); a walking teleport: once `feet().snapPending` clears, `feet().y === heightAt(x, z)`.
  - `overlay`'s "Ctrl+Z / Ctrl+Y from the 3D" becomes a block undo; its param undo runs with the map owning.

- [ ] **Step 1: Write the tests.** `uiSmoke.test.ts`: the list gains `build` and `walk` between `overlay-mesh` and `console`; the pins `build` = `overlay-mesh` + 1 and `walk` = console − 1; the palette's expected swatch count 51 equals `PLACEABLE`'s count (48) + 3. The spec's §6.4 "a torch at night raises the block light around it" → "a torch raises the block light around it" (the Spec correction).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` (its own port and Chrome profile). Expected: every step passes (about 40-60 s more).
- [ ] **Step 5: Commit** `test(ui): the build and walk smoke steps` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts src/ui/world/worldPage.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 40: The bench's review scenes

**Files:**
- Modify: `src/ui/world/bench.ts` (`BENCH_SHOTS` :817 gains `build-day`, `build-night`, `walk-water`, `glass-water`; `BenchWorld` :864 gains `setTime` and `walk`), `src/ui/world/worldPage.ts` (the bench's `BenchWorld` implements them; the bench query builds with `time: null`, `bench.ts:1103`), `test/tools/measureChrome.ts` (`SHOTS` :69 mirrored), `test/unit/bench.test.ts`, `test/unit/measureChrome.test.ts`, `test/unit/worldPage.test.ts`
- Spec: Spec corrections (the shots' `-batch` names; the placed pool)

**Interfaces:**
- `BenchWorld.setTime(hours: number): void` (the clock fixed at that hour and paused) and `BenchWorld.walk(on: boolean): void` (the page's mode switch, F's path: `toggleMode`, the near plane, hold-repeat stopped).
- **(plan)** After L10, a shot of these four builds a fixed scene through the page's edit path at L10's hover point (where its 100 edits ran, before its closing flight; a shot run skips the flight), relative to its surface: `REVIEW_HOUSE` (a 7 × 5 × 7 house: oak planks walls, oak logs at the corners on three axes, a brick floor, a cobblestone base, wool stripes, a glass window, a ladder inside, torches on the walls) and `REVIEW_POOL` (a 9 × 9 × 4 pit dug beside it, filled with bucket water, with a glass wall on one side and an ice block at its rim; a lava 3 × 3 pool), then the pose: `build-day` (`setTime(12)`, the house from 12 blocks), `build-night` (`setTime(0)`, torches and lava lighting it), `walk-water` (`walk(true)`, swimming at the pool's surface; a placed pool, so the shot does not depend on a lake near the hover point), `glass-water` (the glass wall against the water and the ice beside it).
- `outputName` keeps its rule (`measureChrome.ts:141-142`, a shot needs `--renderer`, `:131`): `--shot build-day --renderer batch` is `review-build-day-batch.png`.

- [ ] **Step 1: Write the tests:** "`REVIEW_HOUSE` holds oak logs on three axes, a ladder, torches, glass and wool"; "the shots list mirrors `BENCH_SHOTS`"; "`outputName({ route: 'bench', gpu: 'iris', renderer: 'batch', shot: 'glass-water' })` is `review-glass-water-batch.png`"; `bench.test.ts`: "`build-day` calls `setTime(12)`, `build-night` `setTime(0)`, `walk-water` `walk(true)`" (a fake `BenchWorld`); `worldPage.test.ts`: the page's `setTime` and `walk` helpers (exported) fix the clock and switch the mode.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The spec's §6.5: the four names with `-batch` (`review-build-day-batch.png`, `review-build-night-batch.png`, `review-walk-water-batch.png`, `review-glass-water-batch.png`), "swimming at a placed pool's surface" and "ice at the pool's rim" (the Spec correction).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the bench's SP5a review scenes` (`git add src/ui/world/bench.ts src/ui/world/worldPage.ts test/tools/measureChrome.ts test/unit/bench.test.ts test/unit/measureChrome.test.ts test/unit/worldPage.test.ts docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md`).

---

### Task 41: GPU cells (Chrome, agent): the bench files, G2's row, G1 re-pointed, the review shots

**STOP for the user before Step 1:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp5a/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `bench-rtx-chrome.json` (and any `-tune<k>` files), `review-build-day-batch.png`, `review-build-night-batch.png`, `review-walk-water-batch.png`, `review-glass-water-batch.png`
- Modify: `test/thresholds.ts` (G2 row), `test/thresholds.lock.json` (generated), `test/metrics/g1.metric.ts` (`ASSETS_SP4C` :52 → `ASSETS_SP5A` for the static, streaming and live calls; a new call; `EDIT_LEGS: ReadonlySet<string> = new Set(['L10'])` beside `SP4B_LEGS` and `LIVE_LEGS` (:118-119), which `checkBench`'s known-leg filter (:187) also accepts, its message "outside L0-L10"; SP4b's stutter check (:190) stays on `SP4B_LEGS` only, and L10's `over33` stays an exit check, not a G1 part), the SP5a spec's Threshold log, master §6.4's G2 row and §4.12's Target, `test/arch/masterSpec.test.ts`

**Interfaces:**
- Row: `G2: { editVisibleP95: { max: 50, activeFrom: 'SP5a' } }`.
- `metricTest('G2', ['editVisibleP95'], …, { outName: 'G2.edit' })` reads `bench-iris-chrome.json`'s `edit` (shape: route `bench=medium`, /Iris/, `batch`, rd 12, `shaderCache: 'cold'`, `edit.timedOut` empty) and returns `edit.editVisibleP95`; the RTX file's `edit` recorded in `.out/G2.edit.others.json`. G1's three calls re-read SP4a's, SP4b's and SP4c's parts from `assets/sp5a/` (the SP4c files stay).

- [ ] **Step 1: Measure** (an agent, quiet machine, cold shader cache, touching no other process), each about 4 minutes: `npm run measure:chrome -- --route bench --gpu iris`; `… --gpu iris --workers 4`; `… --route flight --gpu iris`; `… --route bench --gpu rtx` (if its probe refuses, **STOP**: the user switches to 'nvidia', the controller resumes with `claude --resume` and re-runs this cell, then the user switches back to on-demand before Step 2b).
- [ ] **Step 2: Check.** Gated: `edit.editVisibleP95` ≤ 50; G1's every part within its rows. Exit checks (recorded): L10's `over33` 0; `editVisibleStreamingP95`, the step budget, `editDropped`, `mainP95Ms` against master §7's 0.3 ms. A G2 miss: Task 19's levers not yet taken, then **STOP** and report every JSON; no gate is loosened.
- [ ] **Step 2b: Review shots** (on-demand): `npm run measure:chrome -- --route bench --gpu iris --renderer batch --shot <name>` for `build-day`, `build-night`, `walk-water`, `glass-water` (files `review-<name>-batch.png`); each confirms exactly one `canvas[data-renderer]`. The controller looks at each (no flicker at the aquarium wall, the log axes visible, the glass frame thin, the torches and lava lit).
- [ ] **Step 3: The row, the metric and the artifacts in one commit.** SP5a describe: §6.4's G2 row contains `(the edit part gated from SP5a's bench leg L10)`; §4.12's Target contains `(SP5a: gated from the bench's L10)`. `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP5a Task 41: G2 editVisibleP95 max 50, gated from SP5a on every tier from assets/sp5a/bench-iris-chrome.json (g1.metric.ts, G2.edit; spec §6.2, D26); G1's cells re-read from assets/sp5a; new part (measured <p95> ms on eDP-1 at 240 Hz).`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with G1, G1.streaming (L10's structural frames accepted as `EDIT_LEGS`), G1.live and G2.edit asserted on the SP5a file.
- [ ] **Step 5: Commit** `feat(sp5a): the Chrome bench cells, G2's edit row and the review shots` (the JSON and PNG files staged by explicit path, with the files above).

---

### Task 42: The user's Firefox run

This task is the controller's and the user's.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp5a/bench-iris-firefox.json` (only if the user sends one)

- [ ] **Step 1: STOP for the user.** The controller runs `npm run build`, then its own `npx vite preview --port 4173 --strictPort` (stopped only by the controller), and gives the user `http://localhost:4173/?selftest=1` (required: 59/59) and, optionally, `http://localhost:4173/?bench=medium` (about 4 minutes, under on-demand, the JSON downloaded).
- [ ] **Step 2: Record** the selftest result and any bench file (recorded, not gated; L10's `over33` and `editVisibleP95` noted) in the exit evidence.
- [ ] **Step 3: Commit** `docs(sp5a): the Firefox selftest and bench file` (the file, if any, staged by explicit path, and the spec).

---

### Task 43: Whole-branch review; the bare-SP5 rule

**Files:**
- Modify: `test/arch/masterSpec.test.ts` (the bare-SP5 test)

- [ ] **Step 1: The bare-SP5 test** (spec §8): "a bare SP5 is left only in the §10 split paragraph and the pinned historical receivers" (`kept = ['SP5 was split on ', …]` plus the lines holding `SP4b deferred-reclamation primitive → SP5` and SP4b's cut line `(→ SP5)`); `npm run typecheck && npm test`; commit `test(arch): a bare SP5 only in the split and the historical receivers` (`git add test/arch/masterSpec.test.ts`).
- [ ] **Step 2:** The controller runs the final review of `git diff main...sp5a/build-and-walk` against the spec, this plan and Review Focus 1-5 (superpowers:requesting-code-review), the reviewer resolving its own cannot-verify items in the code at HEAD. Beyond the per-task reviews it checks what only the whole branch shows:
  - every `(plan)` decision is in the code as written, or its change is recorded in the spec; every Spec correction is reworded in the spec;
  - no write path of the edit writer or D's overlay takes a slot without `storeChannel` (aux A's heightmap patch the one in-place write);
  - every disposer the sim, the palette, the build HUD, the hold-repeat timer and the block history add is reached from the world page's teardown;
  - SP4b's and SP4c's rules still hold: zero allocation at rest, the layers, `data-renderer` once, no golden diff, no L dropped by an edit;
  - the CI time against §7 (Task 36's run) and the masterSpec block's pins against spec §9's list;
  - spec §10's hand-overs still true of the code as built (`wi.world.hotbar` and the mode left for SP5b's world record, 58 states, the provisional `boxes.ts`/frame bit/log-end layer for SP8a, the sim's `REC_DIFF_FLAG` rule for SP8b, `interaction.ts`/`walk.ts` as SP8c's event sources); a hand-over the code made untrue is reworded in the spec in that finding's commit.
- [ ] **Step 3:** Each finding is fixed test-first in its module, one commit each (`fix(sp5a): …`); a finding that would loosen a gate or change the spec goes to the user.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`, and the smoke again. Expected: PASS; no golden diff.

---

### Task 44: Exit: evidence and docs

**Files:**
- Modify: the SP5a spec (`## Exit evidence`, Status), `CLAUDE.md` (`:9`; F, E, 1-9, the palette; the smoke's `build` and `walk`; `measure:chrome`'s `assets/sp5a`), `README.md` (`:9`, an SP5a paragraph)

- [ ] **Step 1: Exit checks** (spec §12): `npm run build && npm test && npm run test:metrics:full` (L3 and E5 on every tier, every earlier metric unchanged); `git diff main -- test/goldens.json` empty; `GENERATOR_VERSION` 5; `npx --yes bun@1 test/tools/goldensJsc.ts` 59/59; `?selftest=1` 59/59 in Chrome (the smoke) and Firefox (Task 42); `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` green; `npm run bench` within its gates and +30 % (`relight.edit` ≤ 3 ms).
- [ ] **Step 2: Exit evidence**, before the Threshold log: the first CI run; the early G2 measurement and any lever (Tasks 18-19); G2 and every G1 cell with its file; the RTX file; the Firefox selftest and any bench file; L3 and E5 per tier; `relight.edit` and `light.column`; the smoke; the review shots described; the masterSpec pins of 'master spec amendments (SP5a §9)'; whether palette search shipped or was cut (§11).
- [ ] **Step 3:** Status "implemented, awaiting CI, the production check and the user's check"; `CLAUDE.md:9` and `README.md:9` the same.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(sp5a): exit evidence and docs` (`git add docs/superpowers/specs/2026-10-27-sp5a-build-and-walk-design.md CLAUDE.md README.md`).

---

### Task 45: Merge, production check, the user's check, SP5a complete

**STOP for the user's go-ahead** before Step 1.

- [ ] **Step 1:** Merge `sp5a/build-and-walk` to `main` and push; CI green, its wall recorded against §7's ≈ 3.2-3.3 min (above 3 min 30 s: the lever first, `edit.metric.ts` into a shard of its own).
- [ ] **Step 2: Production, headful** (spec §12), on the deployed build:
  - **Chrome** (RegionBatch; the agent's own headful Chrome on the Iris Xe, its own `mktemp -d` profile, `MESA_SHADER_CACHE_DISABLE=true` in its env only; **STOP** until the user confirms PRIME on-demand and the display awake and unlocked): place, break, the palette, F and walking, swimming, a torch at night, the context Ctrl+Z; `?selftest=1` 59/59; page and console errors 0;
  - **Firefox** (RegionMesh; **STOP for the user**, in the user's own Firefox, by hand, as SP4c's `production-check.json` records `firefox.by`): the same steps and production's `?selftest=1` 59/59;
  - the controller commits `assets/sp5a/production-check.json` and `assets/sp5a/selftest-firefox.json` (`docs(sp5a): the production check`).
- [ ] **Step 3: The cut line:** palette search shipped (Task 27 Step 6) → master §10's cut line worded "It was not taken: palette search shipped in SP5a, so nothing moved." and the receivers' `SP5a palette search → SP10 (delivered in SP5a, so nothing moved)`, pinned in the SP5a describe; if it was cut, the receivers and SP10's "Received from SP5a" line say so.
- [ ] **Step 3b: STOP for the user's check:** build and walk (break, place, palette, swimming, ice, ladders, torches) and the context Ctrl+Z (the last criterion).
- [ ] **Step 4:** After the user's verdict (a finding goes back test-first, with another go-ahead before it reaches `main`), a final commit marks SP5a complete (`CLAUDE.md:9`, `README.md:9`, the spec's Status, the cut-line pin): `docs: SP5a complete`.

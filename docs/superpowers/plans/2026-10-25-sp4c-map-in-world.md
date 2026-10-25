# SP4c — The map in the world and live editing: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The map moves into the world. M opens the same map tool as `?map` over the 3D world, centred on the camera with an arrow; a plain click teleports there at once (except while the cut tool is armed), landing about 24 blocks above the real 3D surface or the water, and terrain appears nearest-first with no loading screen and no fog change. Everything `?map` edits applies to the 3D world live: the old world stays visible while the new one replaces it column by column, nearest first; a drag applies only its release value; a change that leaves the world as it is rebuilds nothing; undo and redo apply live. Two remembered modes: A, full screen with "Watch live", and B, side by side. The generated world does not change (`GENERATOR_VERSION` 5, the 59 goldens byte-identical).

**Architecture:**
- **Pool.** World replies that committed resolve with their generation (D7); `configure` moves every epoch cell past every value a job was issued with (ENG-4); two lanes, a world FIFO and an aux binary heap (`engine/jobHeap.ts`), with `setAuxPolicy(first, cap)` (D11); a `landing` job at −2 over `landingSurface` (D12).
- **Engine.** `engine/invalidation.ts`'s `regenFrom` (D8); the coordinator gains the generation gate (D3), the per-column epoch (`colEpoch`, `shownEpoch`, `stagedEpoch`, D5), the sink's column per slot (the technical review's C1), `apply` and `adopt` (D6).
- **Rendering.** `stage` on a shown column is a swap and `unstage` drops a pending payload, on RegionBatch and RegionMesh (D9); the pump disposes emptied regions outside the budget and caps releases at half the rows while uploads wait (D10).
- **Map.** `ui/map/mapTool.ts`'s `createMapTool` holds today's `mountMapPage` composition with every disposer (D1); `mountMapPage` is the standalone shell; the configure driver adopts the page's first configure, replays its source into a canvas mounted later and reports every resolved configure (§4.2).
- **World page.** `ui/world/mapOverlay.ts` (the overlay host, mounted at the first M, the controls owner, modes A and B, D2, D15-D18), `applyControl.ts` (when a draft is applied, D4), `teleport.ts` (D12-D14); the URL follows the session (D20); notices route over the map (D26, D27).
- **Measurement.** R7's Apply part (`test/metrics/apply.metric.ts`, D21), the Apply integration test, the browser smoke's `overlay` steps with leak checks, `?bench=medium`'s live legs L7-L9 and G1's live cells from `assets/sp4c/` (D22, D24).

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`), three r186 (`~0.186.1`), Chrome 155 over CDP for the browser tools, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-sp4c-map-in-world-design.md` (approved 2026-10-25, "Queda aprobado"; the binding authority, with the user's four answers under Points decided by the user). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Recon behind the spec: `.superpowers/sp4c/recon-{map,engine,page,obligations}.md`, `review-technical.md` (git-ignored; the controller has them). Template: the SP4b plan.

**Plan form.** Compact, as SP4a's and SP4b's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies; the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` d54eb73 (code identical to c8b3c40, the spec's citation base).

**Spec corrections found while planning** (each folded in by the task named, the first one when it names two; the controller rewords the spec in that task's commit, and that task's `git add` includes `docs/superpowers/specs/2026-10-25-sp4c-map-in-world-design.md`):
- **The workers' hashes are hex** (§4.1, §4.10): `ReadyMsg.stageHashes` and `genKey` are hex strings (`workers/protocol.ts:142`), while `StageHashes` is `Hash64` tuples (`core/stage/hash.ts:8`). `AppliedDraft` is `{ seedKey: string; hashes: Readonly<Partial<Record<StageId, string>>>; genKey: string }`; `regenFrom` compares hex per stage in `STAGES` order, and `epochOf` interns the genKey hex. Task 2.
- **`adopt` needs the seed key** (§4.2): the replaying sink's `setSource(poolEpoch, seedKey, hashes)` (`previewDriver.ts` `DriverCanvas`, `mapView.ts:45`) cannot replay without it. `adopt({ poolEpoch, sessionEpoch, seedKey, ready })`; and `DriverPool.configure` resolves `{ epoch, stageHashes, genKey }` (the driver drops `genKey` today). Task 11.
- **"The first `show()` after an adopt plans tiles" cannot run in Node** (§4.2, §8.5): `mapView.request` needs a 2D context and a DOM (`vitest.config.ts:11`). The unit test asserts the replay into a fake canvas (source, interactivity, spawn); the planned tiles are the smoke's "tiles drawn within 5 s without any edit" (§8.6). Task 11, Task 24.
- **The help's copy of the settings would undo a mode switch** (§2.5): `helpChange` returns `{ ...next, rd: saved.rd }` (`worldPage.ts:568-572`), so with `mapMode` and `watchLive` in `WorldSettings` a later FOV change in the help writes back the mode the help saw at mount. `helpChange` keeps `mapMode` and `watchLive` from `saved` (the help has no control for them). Task 14.
- **The bench's frame record fills before the live legs end** (§8.4): `BENCH_FRAME_CAPACITY = 32768` (`ui/world/bench.ts:43`) and the recorder stops silently at capacity (`bench.ts:247`); 95 s plus up to 55 s of L7-L9 at 240 Hz is about 36,000 frames. The capacity becomes 49,152 (205 s at 240 Hz). Task 25.
- **`surfaceEst3` takes integer positions** (`gen/column/surfaceEstimate.ts:30-31`, RangeError otherwise): the landing job is asked at the clicked block (⌊x⌋, ⌊z⌋) and the camera goes to (⌊x⌋ + 0.5, ⌊z⌋ + 0.5) (§3.1, §3.2). Task 7, Task 17.
- **The integration test's worker build** (§8.5): `buildNodeTaskWorker(dir)` names a cache directory (`test/harness/nodeWorker.ts:53-54`), not a worker kind; SP4b's streaming test builds `'streaming'`. `apply.test.ts` builds `'apply'`. Task 23.
- **The cut line's cache is decided after the merge** (§6.4, §10, §14): its deciding measurement is the headful production check, so the cut-line wording for both items (the cache, decided by the production check; the readout, built in Task 20 unless time runs short, the skip recorded in Task 29's exit evidence), the receivers and their pin land in the completion commit (Task 30), not the exit commit.
- **ENG-4's formula applies from the second configure on** (§4.9): `max(epoch + 1, max(cells) + 1)` on the pool's first configure (`epoch` −1, `workerPool.ts:333`; the cells start at 0, `world/store/epochs.ts:22-24`) gives 1, not 0, though the cells' initial 0 was issued to no job; the first configure stays 0, so SP4b's pool tests keep their epochs (`workerPool.test.ts:215`, `:333`, `:565`, `:741`). Task 3.
- **`MapViewState` is `MapView`** (§1.1): no `MapViewState` exists; the map's view type is `MapView` (`ui/map/mapState.ts:19`). `MapToolDeps.initialView` and `MapTool.view` are typed `MapView`. Task 12.
- **Shift+click runs today's table as is** (§3.1): the parenthetical "with the Density tab shown and a horizontal plane, set its centre; else open Cross-section near the cut line, else set the pin" restates today's routing inexactly: with the Density tab shown on a vertical plane, today's routing pins even near the cut line (`clickAction.ts:38`). Shift runs `mapClickAction` with today's unarmed table (`clickAction.ts:37-39`). Task 13.

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin. A `.mjs` module a TS test imports gets a sibling `.d.mts`.
  - **No new dependencies.**
- **Layers** (`test/arch/rules/imports.ts`):
  - three only in `render/`; `render/materials/**` imported only from `render/`; GLSL only in `render/materials/**/*.glsl.ts`;
  - `render` never imports `engine` (`imports.ts:29`): `StreamSink.unstage` is satisfied structurally by `SectionRenderer.unstage`;
  - `engine` value-imports core, world, engine and `workers/protocol.ts` (`imports.ts:28`), never render or ui: `invalidation.ts` and `jobHeap.ts` live in `engine/`, the aux policy's inputs come from the page;
  - `gen/**` exports no numeric constants (`landingSurface` is a function; the 24-block margin lives in `ui/world/teleport.ts`); `ui` and `main` anything but `render/materials/**` and `*.worker.ts`; only `engine/` spawns workers; `ui/map` never imports `ui/lab` (`test/arch/imports.test.ts:36-41`); every `new WorldSession(` under `src/ui/` passes `validateParams` (`test/arch/uiSessions.test.ts`).
- **Pure and deterministic layers.** `core/` follows the Math allowlist; `core/`, `world/`, `gen/` and `DET_FILES` use no `Math.random`, `Date.now`, `performance.now`, `console.*`; pure layers no DOM globals.
- **The generated world does not change.** `GENERATOR_VERSION` stays 5; `test/goldens.json` (59 goldens), `test/stateIds.lock.json` and `test/schema-shape.lock.json` stay byte-identical. Tasks 3, 6 and 7 touch the pool, the workers or gen: each runs `npm run test:goldens`, then `git diff --exit-code main -- test/goldens.json`; if the run rewrote anything, restore with `git checkout main -- test/goldens.json` and find the bug. `spawnY` and the spawn goldens are untouched (§3.2).
- **Governance.**
  - `test/thresholds.lock.json` changes only in Task 1 (`startedSps`), Task 22 (R7's Apply part) and Task 26 (G1's live part), always through `npm run test:accept-thresholds`; each such commit adds one line to the SP4c spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`); `2026-10-2X` in the log lines below stands for that commit's date. Every new part is new (a tightening); no gate is loosened. `test/baselines.json` does not change.
  - Master amendments land in the commit spec §10/§12 assigns, each pinned in a new `describe('master spec amendments (SP4c §12)')` in `test/arch/masterSpec.test.ts`, created by Task 1. SP4b's pins that SP4c rewrites move into it: `:698` (the SP4c header, Task 1), `:789` (§2.3's epoch-cell sentence, Task 3), `:751` (§4.1's single-writer line, Task 5), `:851-853` (R7's keys and row, Task 22). **(plan)** A table `SP4C_MODULES: Array<[head: RegExp, token: string, file: string]>` in that describe, "§1 names each SP4c module in its entry, which exists" (as `SP4B_MODULES`, `:712`); Tasks 6, 12, 15, 17 and 18 append rows.
- **Zero allocation** (SP4b D25, §3.10, spec §4.10): the frame step at rest allocates nothing, SP4c's additions included (the apply control's `tick`, `setAuxPolicy` with scalars and a no-op when unchanged, the arrow update, the owner check); `coordinator.apply`, `adopt` and `update` allocate nothing. Pinned in Task 5 and Task 21.
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit.
- **CI time budget** (spec §9, against SP4b's exit run 40107822274, 2 min 57 s, `surface` 158 s the long pole): `check` ≈ 105-110 s, `unit (heavy)` ≈ 95-100 s, `unit (rest)` ≈ 140-150 s, `metrics-fast` ≤ 158 s, quick `terrain` ≈ 120-125 s; wall ≈ 3.0-3.1 min. The map tool's real mount and dispose run in the smoke, never in the unit project. If `unit (rest)` passes 158 s, `coordinator.test.ts` moves into `heavy` (`unitShards.mjs`'s rule); if `metrics-fast` passes 158 s, the fast tier's Apply script drops to E1 alone first; above 3 min 30 s at the exit, SP4b's named lever (a slow file out of `metrics-fast` into its own job).
- **GPU measurements** (spec §8.3, §8.4, as SP4b):
  - **Chrome cells** are an agent's, through `npm run measure:chrome -- --route bench|flight --gpu iris|rtx`, on a cold driver shader cache (`MESA_SHADER_CACHE_DISABLE=true` for the Iris Xe, `__GL_SHADER_DISK_CACHE=0` for the RTX, in the tool's own Chrome's env only; never a user cache), on the laptop panel eDP-1 at 240 Hz with the user's display awake and unlocked, on a quiet machine (the tool refuses above a 1-minute load of 2). The Iris Xe needs PRIME **on-demand**; the RTX Chrome cell runs as SP4b's (NVIDIA offload variables and ANGLE Vulkan under on-demand, P59/P60), and if its probe refuses, under **'nvidia'**. Only the user switches PRIME; a switch logs the user out and ends the session, which the controller resumes with `claude --resume`.
  - **Firefox runs** are the user's, on a local `vite preview` the controller serves on **port 4173**: the Iris Xe run is **required**, the RTX run optional (Point 2).
- **Where the plan stops for the user** (each marked **STOP** in its task): before Task 26 (PRIME on-demand, display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running); in Task 26 if a cell misses after §8.4's tuning or the RTX probe needs 'nvidia' (and the switch back to on-demand); Task 27 (the Firefox Iris Xe run, required; the RTX run, optional, under 'nvidia', then back to on-demand); Task 30 (the go-ahead to merge; PRIME on-demand and the display awake for the agent's headful Chrome check; the headful production check in the user's Firefox; the user's own check, the last criterion). The controller never switches PRIME and never runs the user's check for the user.
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and preview the controller serves runs on its own free port (**never 5183**, the user's compose service; **never 4190** for Firefox: the Firefox preview is 4173) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never open, close or touch the user's own browsers.
- **Outward-facing actions.** Pushing the branch is the controller's call (Task 22 pushes it for the first CI run). Merging to `main`, pushing `main` and the production check happen in Task 30, after the user's go-ahead. Read-only git otherwise; never rewrite history.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways the user, teleporting and editing live, would see SP4c break, most likely first; each names the test that pins it and the task that owns it.

1. **Chained climate edits while the world is still regenerating.** The user types continentalness 2400 → 1800, then 1200, then undoes once, a second apart, each before the last Apply finished: columns then carry three epochs (kept A, B regenerated or in flight, C stale), staged B payloads wait for their reveal, and the undo returns to B. A person expects the world to settle on B with no hole, no column shown twice in one epoch and no mixed column. Task 5 pins "apply A → B, 20 updates, apply C, 20 updates, apply B again, jobs settling in LCG order (seed 4242): every MESH-set column ends shown at B, `stage` is never called with `stagedEpoch` ≠ 0, the fake sink never shows two seqs for a column, `counts.stale` reaches 0, and no column is freed while pinned or busy"; Task 23 runs the real-store version (the mid-regeneration undo).
2. **Undo and redo bursts.** Ctrl+Z held (key repeat every 33 ms) or Ctrl+Z / Ctrl+Y alternated fast: every press is an urgent change. Applying an intermediate draft regenerates for nothing; a burst that ends on the applied world must rebuild nothing. Task 18 pins "12 undos 33 ms apart (fake clock, each configure resolving 20 ms after it starts): exactly one `coordinator.apply`, with the last undo's genKey, ≥ 150 ms after the last change; an alternating Z, Y, Z, Y burst ending on the applied draft: no `apply`, one `adopt` with the last configure's generation".
3. **Mode switches while the world regenerates.** Switching A ↔ B with the map shown must lift the covered 60 fps cap, resize the 3D with a drawn frame, hand the owner over and flip the aux policy. A cap stuck at 60 after leaving A halves the frame rate in B for the rest of the session with no visible cause. Task 16 pins "user cap 0, 4 workers, T pending: A shown → B shown → B locked → A shown → hidden gives limiter caps 60, 0, 0, 60, 0; owners map, map, world, map, world; `exitPointerLock` on the locked B → A switch; `resize()` then one `frame` on each A ↔ B switch"; Task 18 pins the aux policies over the same sequence (world not held): (aux, 3), (world, 1), (world, 1), (aux, 3), (world, 1).
4. **Esc and the pointer lock in mode B.** The Esc that releases the lock may also arrive as a keydown, before or after `pointerlockchange`; acting on it closes the drawer the user was about to use, and a W held across the hand-over keeps the camera drifting while the map has the keys. Task 14 pins the rule ("Escape ignored while `pointerLockElement` is set and for 150 ms after the lock is lost: lost at 1,000 ms, keydowns at 1,000 (still locked) and 1,100 do nothing, 1,200 closes the drawer"); Task 15 pins the wiring ("W held while locked in mode B, then the lock lost: `held` empty and `paused()` true from that tick; `fly.x` unchanged over the next 60 ticks").
5. **Clicking again or editing during a teleport's refill.** In mode B the map stays open, so the user clicks a second place before the first landing has answered; landings run on different workers and can resolve out of order, and a camera that ends at the first click looks like a lost click. Task 17 pins "two `go` calls whose landings resolve in reverse order: the camera ends at the second, and the first resolves false calling neither `onArrive` nor `onFail`". Or the user teleports and edits before the new place has filled: old-place frees are half done, the new disc is partly staged, MESH jobs are in flight, and an old column freed by the Apply can still hold a shown mesh on a slot that moved on (C1). Task 5 pins "teleport 640 columns east at RD 6, 10 updates later apply epoch 2: after the fill every column the fake sink holds is tracked by its slot or was removed (no ghost), every old-place column was removed, every MESH-set column ends shown at epoch 2, `stage` is never called with `stagedEpoch` ≠ 0, and the first 16 T after the Apply are nearest-first from the new place".

## Branch

Create `sp4c/map-in-world` from `main` before Task 1: `git switch main && git switch -c sp4c/map-in-world`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP4c; the §10 entry, SP5's and SP10's lines, the receivers | §10, §12 (§10), D23 |
| 2 | `engine/invalidation.ts`: `regenFrom` | §4.1, D8 |
| 3 | Pool I: world replies with their generation, `configure` past every cell, `spawn(priority)` | §4.6, §4.9, §6.3, D7, D8 |
| 4 | Coordinator I: the generation gate, the per-column epoch, the sink's column, `adopt`, counts | §4.2, §4.4, §4.5 (sink), §4.6, D3, D5, D7 |
| 5 | Coordinator II: `apply`, "old meshes kept on Apply" | §4.4, §4.5, §8.5, D5, D6 |
| 6 | Pool II: two lanes, `jobHeap.ts`, `setAuxPolicy` | §6.1, §6.2, D11 |
| 7 | The `landing` job and `landingSurface` | §3.2, D12 |
| 8 | The swap: `regionGrid.ts`, `unstage`, the contract cases, RegionBatch | §5.1, §5.2, §5.5, D9 |
| 9 | The swap on RegionMesh | §5.3, §5.5 |
| 10 | The pump's order | §5.4, §5.5, D10 |
| 11 | The configure driver: adopt, onConfigured, preview wanted, the replaying sink | §4.2, §6.3 |
| 12 | `createMapTool`, every disposer, the standalone shell, shortcuts with `enabled` | §1.1, §1.2, §1.4, §2.2 (container query), D1 |
| 13 | The tool in the world: the arrow, the hidden state, the click routing, the header slot | §1.5, §2.5, §3.1, D14, D19 |
| 14 | Input: M, `active`, Esc's rule, the help's undo line; `mapMode` and `watchLive` | §2.3, §2.4, §2.5, D15, D17 |
| 15 | The overlay: lazy mount, the controls owner, the world's keys | §1.3, §2.3, §2.4, D2, D15 |
| 16 | Modes A and B: layout, `resize()`, availability, the covered cap, Watch live | §2.1, §2.2, §2.6, D16, D18 |
| 17 | Teleport and the eye light | §3.2-§3.4, D12, D13, D14 |
| 18 | `applyControl` and the page's Apply | §4.2, §4.3, §4.7, §4.8, §6.2, D3, D4 |
| 19 | The URL and the help | §1.6, D20 |
| 20 | The notices; the map's regeneration readout (cut line) | §2.1, §2.4, §4.5, §13, D23, D26, D27 |
| 21 | Zero allocation: SP4c's frame additions | §4.10 |
| 22 | R7's Apply part: `apply.metric.ts` and its row (first CI run) | §8.1, §8.2, §9, D21 |
| 23 | Integration: `apply.test.ts` | §8.5 |
| 24 | Browser smoke: `overlay`, `overlay-mesh`, the leak checks; the map latency re-run | §8.6, §1.4, §14 |
| 25 | The bench's live legs; `measureChrome` → `assets/sp4c` | §8.4, §8.7, D22, D24 |
| 26 | GPU cells (Chrome, agent): the bench files, G1's live rows, the review shots | §8.2, §8.4, §8.7 |
| 27 | The user's Firefox run | §8.4, Point 2 |
| 28 | Whole-branch review | §14 |
| 29 | Exit: evidence and docs | §10, §13, §14 |
| 30 | Merge, production check, the user's check, SP4c complete | §6.4, §14 |

The order is spec §10's: governance; `invalidation.ts` and the pool with their tests; the coordinator on fake jobs ("old meshes kept on Apply" lands there); the lanes and `landing`; the renderers' swap and the pump behind the extended contract suite; the map tool's refactor with the standalone smoke green before the world mounts it; the overlay, the modes and the input; teleport; the apply control and the page; R7's Apply row with its metric; the integration test; the smoke; the bench's live legs; the artifacts with G1's live rows in one commit; the screenshots; docs.

---

### Task 1: Governance: start SP4c; the §10 entry, SP5's and SP10's lines, the receivers

**Files:**
- Modify: `src/core/ids.ts` (doc comment; `CURRENT_SP` :23), `test/harness/sp.ts` (`STARTED_SPS` :35)
- Modify (pins): `test/arch/sp.test.ts:18-22`, `test/unit/profiles.test.ts:26`, `test/arch/masterSpec.test.ts` (`:698` removed from the SP4b block; a new `describe('master spec amendments (SP4c §12)')` after it, with `SP4C_MODULES` empty)
- Modify: master §10 (SP4c entry, SP5 entry, SP10 entry, Default receivers), `test/thresholds.lock.json` (generated), the SP4c spec's `## Threshold log`, `CLAUDE.md:9`, `README.md:9`

**Interfaces:**
- Produces: `STARTED_SPS` ends `'SP4b', 'SP4c'`; `CURRENT_SP === 'SP4c'`; no profile has `readyFrom: 'SP4c'`, so readiness does not change.

- [ ] **Step 1: Update the pinned tests first.**
  - `sp.test.ts:18-22`: title "SP4c has started and is the current SP (SP4c spec §10)"; the list ends `'SP4b', 'SP4c'`; `CURRENT_SP` and `currentSpOf(STARTED_SPS)` are `'SP4c'`.
  - `profiles.test.ts:26`: `CURRENT_SP` is `'SP4c'` (the readiness list unchanged).
  - The SP4c describe, test "§10's SP4c entry, SP5's walk-mode teleport and saved places, SP10 without bookmarks": `spEntry('SP4c', 'SP5')` starts ``**SP4c — The map in the world and live editing** (L; SP4b). Spec: `2026-10-25-sp4c-map-in-world-design.md` ``, contains `- **Deliverable:** teleport from the map and edit the world live in both modes.`, `**Exit:** as the SP4c spec §14` and a line starting `- **Cut line:** the climate-grid cache and the map's regeneration readout (→ SP10)`; the text contains `SP4c climate-grid cache and the map's regeneration readout → SP10`; `spEntry('SP5', 'SP6')` contains `Walk mode's teleport: the feet at the landing surface + 1, the look direction kept, snapped to \`MOTION_BLOCKING\` once published (the SP4c spec §3.5)` and `saved places as a section of each saved world's map`; SP10's `complete map layers (` list does not contain `bookmarks`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (CURRENT_SP `'SP4b'`, the master unamended).
- [ ] **Step 3: Implement.**
  - `ids.ts`: `CURRENT_SP = 'SP4c'`; the doc comment names SP4c as started. `sp.ts`: `STARTED_SPS` appends `'SP4c'`.
  - Master §10 as spec §12's §10 item words it:
    - the SP4c entry: header `(L; SP4b)` with the spec file, its contents, `**Deliverable:**`, `**Exit:** as the SP4c spec §14 (…)` and `**Cut line:** the climate-grid cache and the map's regeneration readout (→ SP10), worded at the exit by whether it was taken` (worded in Task 30, Spec corrections);
    - the Default receivers gain `SP4c climate-grid cache and the map's regeneration readout → SP10`;
    - SP10's "complete map layers (…)" drops `bookmarks` (saved places are SP5's);
    - SP5's entry gains the walk-mode teleport and saved-places line.
  - `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP4c Task 1: startedSps gains 'SP4c' (spec §10).`
  - `CLAUDE.md:9` and `README.md:9`: SP4b complete, SP4c in progress (the map in the world and live editing), then SP5.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `chore(sp4c): start SP4c` (`git add src/core/ids.ts test/harness/sp.ts test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-25-sp4c-map-in-world-design.md CLAUDE.md README.md`).

---

### Task 2: `engine/invalidation.ts`: `regenFrom`

**Files:**
- Create: `src/engine/invalidation.ts`, `test/unit/invalidation.test.ts`

**Interfaces:**
- Produces (Spec corrections: hex hashes):
  - `type WorldStage = 'T' | 'D' | 'L' | 'MESH'`;
  - `interface AppliedDraft { readonly seedKey: string; readonly hashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }`;
  - `regenFrom(prev: AppliedDraft, next: AppliedDraft): WorldStage | null` — a different `seedKey` → `'T'`; else the first stage of `STAGES` (`core/stage/registry.ts:15-26`) whose hex differs or is missing on either side, mapped climate, shape, surfaceEst, biome2d, terrain → `'T'`; decorate → `'D'`; light → `'L'`; mesh → `'MESH'`; lod or map only, or nothing → `null`.
  - `appliedDraftOf(seedKey: string, ready: { readonly stageHashes: Readonly<Partial<Record<StageId, string>>>; readonly genKey: string }): AppliedDraft`.
- Consumes: `STAGES` and `StageId` from core.

- [ ] **Step 1: Write the tests** (synthetic hex over every stage id, then the real hashes):
  - "equal drafts → null"; "a seed change with equal hashes → T";
  - "each of climate, shape, surfaceEst, biome2d and terrain alone differing → T"; "decorate alone → D, light alone → L, mesh alone → MESH";
  - "lod alone and map alone → null"; "climate and mesh differing → T (the earliest wins)"; "a stage missing on one side counts as dirty";
  - "the real `stageHashes` (hexed) of the default params against `density.detailAmpHi` 4.0 → T; against `climate.C`'s wavelength 1200 → T; the default params twice → null" (every SP4c leaf is terrain- or climate-scope, `core/params/schema.ts:8-11`, so only T and null are reachable).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/invalidation.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** (pure; no allocation beyond the result).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): invalidation.ts, the first world stage a configure dirties` (`git add src/engine/invalidation.ts test/unit/invalidation.test.ts docs/superpowers/specs/2026-10-25-sp4c-map-in-world-design.md`; Spec corrections: §4.1's and §4.10's `AppliedDraft` in hex).

---

### Task 3: Pool I: world replies with their generation, `configure` past every cell, `spawn(priority)`

**Files:**
- Modify: `src/engine/workerPool.ts` (`ColumnDone` :141-146, `WorkerPool` :188-284 docs of `configure`, `bumpScope`, the world jobs and `spawn`; reply judging :437-447; `columnJob`/`worldJob` :478-488; `configure` :495-508; `meshColumn` :534-539; `spawn` :552-557), `src/ui/map/perfHook.ts` (`instrument` :205-240 forwards `spawn(priority)`), `src/engine/coordinator.ts` (`worldJobsOf` :243-261 only)
- Modify (tests): `test/unit/workerPool.test.ts`, `test/unit/worldPool.test.ts` (`:99`, `:126`, `:141-142`, `:243-244`, `:271` expect `generation`; `:182-194` read the payload from `.payload`), `test/unit/coordinator.test.ts:1295` (the worldJobsOf fake's `meshColumn` resolves `{ payload, generation: 0 }`; its `done` gains `generation: 0` in Task 4), `test/integration/worldJobs.test.ts:89`, `test/arch/masterSpec.test.ts` (`:789` moved into the SP4c describe)
- Modify: the SP4c spec (Spec corrections: ENG-4's formula from the second configure)
- Master: §2.3's epoch-cell sentence (spec §12)

**Interfaces:**
- Produces:
  - `ColumnDone.generation: number` — the job's `epoch` at issue;
  - **(plan)** `interface MeshColumnDone { readonly payload: ColumnMeshPayload; readonly generation: number }`; `meshColumn(cx, cz): Promise<MeshColumnDone>` (a mesh-layer `ColumnMeshPayload` carries no pool field);
  - the reply rule: a world job (`terrain`, `decorate`, `light`, `meshColumn`) whose worker replied OK resolves whatever the pool's generation or its cells are now; an `ABORTED` or `STALE_EPOCH` error rejects `JobCancelled`; every other job type keeps today's rule (`job.epoch !== epoch || moved(job)` → `JobCancelled`);
  - `configure`: once a configure has run (`epoch` ≥ 0), `epoch = max(epoch + 1, max over the four cells + 1)` before storing it into all four (ENG-4); the first configure stays 0 (no job ran under a cell before it; Spec corrections); without cells, `epoch + 1` as today;
  - `spawn(priority = -2): Promise<Spawn>`.

- [ ] **Step 1: Write the tests.**
  - `workerPool.test.ts` (fake workers that hold a reply until the test releases it):
    - "a decorate whose OK reply arrives after a configure resolves with `generation` g (its issue epoch), not JobCancelled"; "the same for terrain, light and meshColumn";
    - "an L that replied ABORTED after a configure rejects JobCancelled; a T that replied STALE_EPOCH rejects JobCancelled";
    - "a mapTile and a point whose OK replies arrive after a configure still reject JobCancelled" (today's rule for every other type);
    - **ENG-4:** "configure (g), `bumpScope('light')` → cells [g, g, g + 1, g + 1]; the next configure stores g + 2 into all four and `pool.epoch` is g + 2; an L issued between them (scope g + 1) sees its cell differ from its scope and stops";
    - "without cells, configure counts epoch + 1" (the standalone map page's pool);
    - "with cells, the first configure stores 0 and the next 1 (SP4b's `:215`, `:333`, `:565` and `:741` keep their epochs)";
    - "`spawn()` queues at −2 before a queued point at −1; `spawn(600)` runs after a stats part at 500".
  - `worldPool.test.ts`: the `toEqual` replies gain `generation` (the configure's epoch); `meshColumn` resolves `{ payload, generation }`.
  - SP4c describe: "§2.3's epoch cell: Apply is one configure (SP4c)": the `**Epoch cell.**` paragraph contains `Apply is one \`configure\`, which moves all four cells past every value a job was issued with; every SP4c leaf is terrain- or climate-scope, so \`bumpScope\` from the dirty stage waits for SP8b's decorate-scope Apply, SP4c` and `(amended by SP3a, SP4a, SP4b and SP4c)`; SP4b's `:789` assertion removed.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/workerPool.test.ts test/unit/worldPool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `worldJobsOf` (`coordinator.ts:243-261`) maps `MeshColumnDone` back to today's `JobOutcome` (`payload`, `versions: payload.versions`) until Task 4 adds `generation`. The `WorkerPool.bumpScope` doc says nothing calls it in SP4c (kept for SP8b, §4.9). Master §2.3 as spec §12 words it.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `fix(engine): world replies keep their generation; configure moves past every cell (ENG-4)` (`git add` the files above).

---

### Task 4: Coordinator I: the generation gate, the per-column epoch, the sink's column, `adopt`, counts

**Files:**
- Modify: `src/engine/coordinator.ts` (`JobOutcome` :101-104, `CoordinatorJobs` :107-114, `StreamSink` :127-132, `CoordinatorOptions` :140-155, `CoordinatorCounts` :166-181, `createCoordinatorCounts` :232-235, `worldJobsOf` :243-261, the slot table :312-335, `nextJob` :401-436, `classify` :638-668, `unloadCheck` :686-691, `unmesh` :738-743, `unload` :750-794, `pump` :824-855, `issue` :868-891, `intake` :949-1001, `countDone` :1089-1110, `counts` :1165-1187), `src/ui/world/worldPage.ts` (`createCoordinator` :831-848: `generation: workers.epoch`, `epoch: 1`, the sink's `unstage: () => false` **(plan:** nothing calls `apply` on the page before Task 18; Task 8 wires `sections.unstage`)), `test/metrics/stream.metric.ts`, `test/integration/streaming.test.ts` (their sinks and jobs)
- Modify (tests): `test/unit/coordinator.test.ts` (the fake jobs gain `generation()`, the fake sink `unstage`; `:211`'s "staged again while revealed" and `:565`'s title become "staged at most once per epoch", the fake sink reading `c.counts(out).epoch` at each stage; the worldJobsOf fake's `done`, `:1286`, gains `generation: 0`), `test/unit/zeroAlloc.test.ts` (`fakeWorld`'s jobs, `:215-227`, gain `generation: () => 0` and `generation: 0` on each outcome, its sink, `:228`, `unstage: () => false`; `filledCoordinator`, `:239-241`, passes `generation: 0, epoch: 1`)

**Interfaces:**
- Produces (spec §4.10):
  - `JobOutcome.generation: number`; `CoordinatorJobs.generation(): number` (the pool's `epoch`); `worldJobsOf(pool: Pick<WorkerPool, 'epoch' | 'terrain' | 'decorate' | 'light' | 'meshColumn' | 'cancelWorld' | 'liveWorkers'>)`;
  - `CoordinatorOptions.generation: number` and `epoch: number` (the first configure's; the page's first epoch is 1);
  - `StreamSink.unstage(cx: number, cz: number): boolean` (true: a pending payload was dropped);
  - `CoordinatorCounts.stale: number`, `epoch: number`;
  - `Coordinator.adopt(generation: number): void` — sets `appliedGeneration`, rebuilds the heaps; changes no epoch, frees and stages nothing.
- Slot table additions, each `Int32Array(4096)`: `colEpoch` (0 for Absent; **(plan)** set at T's intake from the job's issue epoch, so a T dropped or rejected leaves 0), `shownEpoch`, `stagedEpoch`, `sinkCx`, `sinkCz` (`NO_COLUMN` when the sink holds nothing), `busyEpoch` (`wEpoch` at issue). The coordinator keeps `wEpoch` and `appliedGeneration`.
- Rules (spec §4.2, §4.4-§4.6):
  - **Gate:** `pump` issues nothing unless `jobs.generation() === appliedGeneration`;
  - **Eligibility:** D, L and MESH need their 3 × 3 at the stage **with `colEpoch === wEpoch`**; MESH also needs the target (`stagedEpoch || shownEpoch`) ≠ `wEpoch`; a Published current column whose target is `wEpoch` is marked `meshed` without a MESH;
  - **Stage and remove through the sink's column:** `stage` sets `sinkCx/Cz` and `stagedEpoch = wEpoch` (a debug assertion: only with `stagedEpoch` 0); `unmesh` calls `sink.remove(sinkCx[s], sinkCz[s])` and clears both mesh epochs and the sink column; `H_MESH_OUT` keys on "the sink holds a column outside keepMesh" (`flagsAt(sinkCx, sinkCz)`), separate from `meshed`; `classify` removes the mesh of a sink column the slot no longer tracks before it calls `follow`;
  - **Intake (D7):** T, D and L results are recorded as the store stands, whatever generation they ran under; a MESH whose `busyEpoch` ≠ `wEpoch` is dropped (counted in `dropped`, as SP4b's superseded results);
  - **Counts:** `done` counts current columns only (T, D, L: `colEpoch === wEpoch`; MESH: meshed with target `wEpoch`); `stale` = MESH-set columns with (stage ≥ 1 and `colEpoch ≠ wEpoch`) or (target ≠ 0 and ≠ `wEpoch`); `epoch = wEpoch`.

- [ ] **Step 1: Write the tests** (`coordinator.test.ts`, fake jobs whose `generation()` the test sets, fake sink):
  - **the gate:** "with the fake pool's generation moved to g + 1 and not adopted, 50 updates issue no world job (the heaps kept); `adopt(g + 1)` resumes issuing, and frees, stages and unstages nothing";
  - **D7:** "a D issued at g whose reply resolves (generation g) after the fake pool moved to g + 1 and `adopt(g + 1)` advances its column to Decorated, and its L is issued at g + 1" (the store side is Task 23's);
  - **the sink's column:** "over a fill and a crossing of 10 columns, every `sink.remove` names a column the sink was staged with, and the sink's held set equals the columns staged and not removed since: it contains the MESH set around the final camera and lies within keepMesh (RD + 1)";
  - **counts:** "after the first fill `counts.stale` is 0, `counts.epoch` is the options' epoch (1), and every stage's `done` equals SP4b's for the same fill";
  - the SP4b suite otherwise unchanged; the fake sink's `:211` check becomes "staged at most once per epoch" (a `stage` of a column the fake sink still holds at the same `counts().epoch`, with no `remove` since, is a violation; a re-stage after a `remove`, as `:576-577`'s, or over a column held at another epoch (the swap), is not). The MESH-of-another-epoch case needs `apply` and lands in Task 5.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `stream.metric.ts` passes `generation`/`epoch` and an `unstage` of `() => false` until Task 8 wires `sections.unstage` (**(plan)**, as the page); `streaming.test.ts` passes `generation`/`epoch`, and its recording sink keeps `unstage: () => false` (it has no renderer and never applies).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npx vitest run --project metrics-fast test/metrics/stream.metric.ts`. Expected: PASS; R7 `partialColumnFrames` 0.
- [ ] **Step 5: Commit** `feat(engine): the generation gate, the per-column epoch and the sink's column` (`git add` the files above).

---

### Task 5: Coordinator II: `apply`, "old meshes kept on Apply"

**Files:**
- Modify: `src/engine/coordinator.ts` (`Coordinator` :183-201 gains `apply`; `unloadCheck`, `freeable` :715-718, the free path in `unload` :765-779), `test/unit/coordinator.test.ts`, `test/unit/zeroAlloc.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §4.1 (single writer), §4.2 (re-generation swaps), §5.1 (the four items), §8 risk 1 (spec §12)

**Interfaces:**
- Produces: `Coordinator.apply(a: { readonly epoch: number; readonly generation: number; readonly from: WorldStage }): void` (`WorldStage` from Task 2; SP4c treats any `from` as `'T'`).
- `apply` (spec §4.5), one pass over the 4,096 slots (≤ 1 ms, as a crossing), no allocation:
  - sets `wEpoch = epoch` and `appliedGeneration = generation`;
  - **pending payloads of another epoch** (`stagedEpoch` ≠ 0 and ≠ `wEpoch`): `sink.unstage(sinkCx, sinkCz)`; true → `stagedEpoch = 0`; false → `shownEpoch = stagedEpoch`, `stagedEpoch = 0`; a payload staged at `wEpoch` (an undo back to the pending epoch) stays;
  - **stale columns** (stage ≥ 1, `colEpoch ≠ wEpoch`): `meshSeq` bumped (a MESH in flight is dropped at intake); freeable **inside** keepVoxels (SP4b's `freeable`, `:715-718`, requires outside) at zero pins and not busy, through `H_FREE` keyed by their own T score, ≤ 16 per update (`FREES_PER_FRAME`); such a free calls `store.freeColumn` and returns the slot to Absent but keeps the shown mesh (no `sink.remove`; `sinkCx/Cz` and `shownEpoch` stay);
  - **stale meshes outside the MESH set** (the keepMesh ring, RD + 1): queued into `H_MESH_OUT` by `apply` and `unloadCheck`, whose condition (both at queue and at the pop, `coordinator.ts:689`, `:754`) becomes "the sink column lies outside keepMesh, or outside the MESH set with a target ≠ `wEpoch`", ≤ 64 per update (`MESH_REMOVALS_PER_FRAME`);
  - **current columns** whose target ≠ `wEpoch` lose `meshed` and get a MESH when eligible; Published current columns whose target is `wEpoch` are marked `meshed`;
  - the unload heaps re-collected and the stage heaps rebuilt from the camera; `unloadCheck` (`:686-691`) also queues a stale column at stage ≥ 1 into `H_FREE` inside keepVoxels, so a column busy at `apply` is queued again by the settle that ends its job.

- [ ] **Step 1: Write the tests** (`coordinator.test.ts`; RD 6, 5 fake workers, LCG settle orders as SP4b's suite):
  - **"old meshes are kept on Apply"** (master §6.3): after `apply`, no MESH-set column is removed from the sink before its new payload is staged, and each stale column's next `stage` happens under the new epoch;
  - "stale frees go nearest first (each update's frees in non-decreasing T score, `streamScore` from the last rebuild's centre and yaw, as `pushUnload` keys them, `coordinator.ts:547-551`), ≤ 16 per update, and only at zero pins";
  - "a stale column busy at `apply` is freed after its job settles"; "a column at the applied epoch is never freed (an undo keeps it)";
  - "no D, L or MESH is issued while its 3 × 3 is not all at the applied epoch"; "a MESH in flight at `apply` and settling after it is not staged";
  - "stale meshes outside the MESH set are removed after `apply`, ≤ 64 per update"; "`adopt` frees and stages nothing"; "an Apply of the epoch already applied frees nothing";
  - **the sink column:** "`apply`, let 30 stale columns be freed with their old meshes kept, then move the camera 40 columns before they regenerate: every column the fake sink holds is tracked by its slot or was removed, and the removals name the old columns"; the same with a 640-column teleport;
  - **the mesh epochs** (spec §8.5's three cases):
    - (1) "right after a teleport and during the first fill `counts.stale` is 0 (Absent columns are needed, not stale)";
    - (2) "apply A → B, X freed with its A mesh shown, undo to A before X's B payload is staged: X regenerates as A, is marked meshed without a MESH, and MESH `done` reaches `needed`";
    - (3) "X's B payload staged, then an undo whose `unstage` returns true: X still shows A and no MESH is issued for it; with `unstage` returning false (B already shown), X's shown epoch becomes B and it re-meshes as A";
  - **Review Focus 1** and **Review Focus 5** as worded there;
  - the fake jobs' `:153` check becomes "MESH issued for a column the fake sink holds at the current `counts().epoch`" (the fake sink records the epoch of each held column at `stage`), so a current or regenerated column still showing its old mesh may get its MESH (the swap);
  - `zeroAlloc.test.ts`: "1,000 × (`apply` alternating epochs 2 and 3 under a held generation, then one `update`) after a fill grow the heap by less than 256 KB" (no job is issued under a held generation, so no promise is made).
  - SP4c describe: "§4.1, §4.2, §5.1 and risk 1 say how SP4c applies": each contains its spec §12 parenthetical (§4.1 `SP4c's Apply frees a stale column at zero pins and regenerates it from T, rewriting no Published final set`; §4.2 `the column's voxels are freed and regenerated while its old meshes stay shown`; §5.1 `**Since SP4c** the world applies the session's drafts live`, `auto-apply only`, `the column's epoch is the interned genKey of its T's draft`, `SP4c shows the stale count in the HUD`; risk 1 `SP4c's Apply frees and regenerates instead of rewriting`), and §5.1 no longer contains `**Until SP4c**`. SP4b's `:751` single-writer assertion is removed and replaced in the SP4c describe by one that ends `…the sim worker's ownership, SP5, is of the final set; SP4c's Apply frees a stale column at zero pins and regenerates it from T, rewriting no Published final set, so the sim worker (SP5) stays its first writer).`
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/coordinator.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master amendments as spec §12 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): coordinator.apply keeps old meshes while columns regenerate nearest-first` (`git add src/engine/coordinator.ts test/unit/coordinator.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 6: Pool II: two lanes, `jobHeap.ts`, `setAuxPolicy`

**Files:**
- Create: `src/engine/jobHeap.ts`, `test/unit/jobHeap.test.ts`
- Modify: `src/engine/workerPool.ts` (`queue` :331, `pump` :351-360, `fail` :375-391, `dropGroup` :451-456, `enqueue` :462-476, `configure`, `bumpScope`, `cancelTiles` :673, `cancelWorld` :679, `queued`, `probe`), `src/ui/map/perfHook.ts` (forwards `setAuxPolicy`), `test/unit/workerPool.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §1's engine line (`jobHeap.ts (SP4c)`), §4.3's caps line (spec §12)

**Interfaces:**
- Produces, in `jobHeap.ts` **(plan: the shape)**: `interface JobHeap<T> { readonly size: number; push(item: T, priority: number, id: number): void; peek(): T | undefined; pop(): T | undefined; removeWhere(drop: (item: T) => boolean): T[]; clear(): T[] }`; `createJobHeap<T>(capacity = 64): JobHeap<T>` — an `Int32Array` of slot indices over preallocated `Float64Array` priority and id keys, ordered by (priority, id), grown ×2 when full; `removeWhere` rebuilds in O(n).
- Produces, in `workerPool.ts`: the world lane (a FIFO of `terrain`/`decorate`/`light`/`meshColumn` jobs in issue order) and the aux lane (the heap, every other job); `setAuxPolicy(first: 'world' | 'aux', cap: number): void` — scalars, a no-op when unchanged; **(plan)** the default is `('world', size)` (the first entry's order: world jobs before spawn's ring search only through priorities, as today). A free worker takes, in order: an aux job of priority < 0 (point, probes, landing, the standalone spawn; uncapped, not counted); then by `first` — `'world'`: the world FIFO, else an aux job while non-interactive aux jobs running < `cap`; `'aux'`: an aux job while under `cap`, else the world FIFO.

- [ ] **Step 1: Write the tests.**
  - `jobHeap.test.ts`: "pops in (priority, id) order over 200 randomised sequences of pushes and pops (LCG 4242)"; "grows past its capacity"; "`removeWhere` returns the removed items and keeps the order of the rest".
  - `workerPool.test.ts` (fake workers):
    - "the aux lane yields the same order as today's sort on 200 randomised queues of tiles, points, stats and slices";
    - "interactive first and uncapped: with `('world', 1)` and a tile running, a queued point runs on the next free worker and does not count against the cap";
    - "`('world', 1)` on 4 workers, the pool ready, 6 tiles enqueued and then 6 world jobs: 1 tile and 3 world jobs run; with the 6 world jobs enqueued first (or all 12 released at once), 4 world jobs and no tile" (the pool pumps on every enqueue, `workerPool.ts:474`);
    - **I2:** "`('aux', 3)` on 4 workers with 20 tiles queued and world jobs waiting: one world job is always running";
    - "the world held, `('aux', 4)`: all 4 workers take tiles";
    - "`setAuxPolicy` with unchanged values does nothing (no pump)";
    - "`cancelTiles` and `cancelWorld` filter their lane; `configure` rejects both lanes; a failed slice part drops its group's queued parts; a dead worker's last failure rejects both lanes";
    - "the world FIFO keeps issue order".
  - SP4c describe: `SP4C_MODULES` gains `[/^\s+coordinator\.ts /, 'jobHeap.ts (SP4c)', 'src/engine/jobHeap.ts']`; §4.3's caps line contains `(SP4c: while the 3D is visible; while the map covers the 3D, map jobs go first and the world streams on the workers left; points, landing and probes go first and are not capped; the pool keeps world jobs in a FIFO lane and the rest in a heap)`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/jobHeap.test.ts test/unit/workerPool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1 and §4.3 as spec §12 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(engine): the pool's world and aux lanes and the aux policy` (`git add` the files above).

---

### Task 7: The `landing` job and `landingSurface`

**Files:**
- Modify: `src/gen/column/spawn.ts` (beside `spawnY` :45-50, unchanged), `src/workers/protocol.ts` (`ToWorker` :128, `CELL_OF` :133-136, the message guard :417-420, `FromWorker` :214, the reply guards :523-526), `src/workers/taskHandler.ts` (the dispatch :257-300), `src/engine/workerPool.ts` (`WorkerPool.landing`), `src/ui/map/perfHook.ts`
- Modify (tests): `test/unit/spawn.test.ts`, `test/unit/protocol.test.ts`, `test/unit/workerPool.test.ts`
- Modify: the SP4c spec (Spec corrections: `surfaceEst3`'s integer positions, §3.1, §3.2)

**Interfaces:**
- Produces:
  - `landingSurface(ctx: GenContext, x: number, z: number): number` (integers in the world window) — `⌊surfaceEst⌋` from `columnPoint`; when `FIND_TAP(CREATE_DC(ctx).expr, 'terrain')` is defined (the default tree included), `max(⌊surfaceEst⌋, surfaceEst3(dc, x, z))`;
  - `LandingMsg = Scoped & { readonly type: 'landing'; readonly x: number; readonly z: number }` on the terrain cell; `LandingResultMsg { type: 'landingResult'; jobId; epoch; surface: number; water: number }` (`water` = `surfaceWaterLevel`, −∞ allowed by the guard); BAD_ARGS for non-integers or a position outside the window;
  - `WorkerPool.landing(x: number, z: number): Promise<{ readonly surface: number; readonly water: number }>` at priority −2 in the aux lane (interactive: first, uncapped).

- [ ] **Step 1: Write the tests.**
  - `spawn.test.ts`:
    - "landingSurface under the default tree is max(⌊surfaceEst⌋, surfaceEst3) at 64 lattice points";
    - **(plan)** "a default-profile jagged column: the test scans seed 42's 64-block lattice within ±2,048 blocks for the first column where `surfaceEst3` exceeds ⌊surfaceEst⌋ by ≥ 20, asserts one exists, and pins its coordinates after the first run; there landingSurface equals `surfaceEst3`" (Task 17 reuses the column);
    - "under amplified, at seeds 1-8's spawn points (where `spawn.test.ts:88-101` already pins surfaceEst3 + 1 ≥ ⌊surfaceEst⌋ + 1), landingSurface equals `surfaceEst3`, and exceeds ⌊surfaceEst⌋ by > 20 at at least one of them" (at an arbitrary column `surfaceEst3` can step below ⌊offset⌋, `surfaceEstimate.ts:33-49`, and the max is then ⌊surfaceEst⌋); "under a tree with no reachable `terrain` tap it is ⌊surfaceEst⌋";
    - "findSpawn and `spawnY` are unchanged (the spawn goldens pass)".
  - `protocol.test.ts`: "the guards accept a landing message and a result with `water` −∞; they refuse a non-integer `x`, a missing `z` and a result without `surface`".
  - `workerPool.test.ts`: "landing runs before 20 queued tiles under `('world', 1)` and before a queued point"; "a configure rejects a queued landing with JobCancelled"; "a landing at a position outside the window rejects with the worker's BAD_ARGS".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/spawn.test.ts test/unit/protocol.test.ts test/unit/workerPool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(workers): the landing job over the 3D surface estimate` (`git add` the files above).

---

### Task 8: The swap: `regionGrid.ts`, `unstage`, the contract cases, RegionBatch

**Files:**
- Modify: `src/render/sectionRenderer.ts` (`stage` doc :92-96, a new `unstage`), `src/render/regionGrid.ts` (`StagedColumn` :113-135 gains `prev`, `RegionBackend` :150-176 gains `swap`, `stage` :308-330, `remove`, the reveals :426-436, `probe` :487-504), `src/render/regionBatch.ts` (`swap`), `src/render/regionMesh.ts` (it implements `RegionBackend`, `:401`: **(plan)** the interim `swap` = `hide(prev)` then `reveal(next)`; Task 9 pins it), `src/ui/world/worldPage.ts` (the sink's `unstage: (cx, cz) => sections.unstage(cx, cz)`), `test/metrics/stream.metric.ts` (its sink's `unstage` → `sections.unstage`)
- Modify (tests): `test/unit/sectionRendererContract.ts` (`:295`'s case replaced), `test/unit/regionGrid.test.ts`, `test/unit/regionBatch.test.ts`

**Interfaces:**
- Produces (spec §5.1):
  - `SectionRenderer.stage(p, seq)`: on a revealed column, a replacement whose `prev` is the shown record (visible, counted in its region); on an unrevealed one, replaced as today; during a swap, the pending replacement is replaced and `prev` kept; a replacement with no non-empty row hides `prev` at once;
  - `SectionRenderer.unstage(cx: number, cz: number): boolean` — drops a staged, unrevealed payload (its uploaded rows hidden, released under the gate), keeps what is shown (`prev` becomes the live record again); true when a payload was dropped;
  - `remove` during a swap hides both;
  - `RegionBackend.swap(prev: StagedColumn<R>, next: StagedColumn<R>): void` — `prev`'s rows hidden and `next`'s shown in one call; RegionBatch: one pass of `setVisibleAt` over both; `prev` then goes to the release queue;
  - `probe`: `partial` over shown columns (`prev` included), `mixed` a column showing rows of two seqs;
  - `onColumnRevealed(cx, cz)` fires once per swap, in the pump that swaps (and for an empty replacement, in the call that hides `prev`), as it fires for a first reveal (`regionGrid.ts:426-434`); `revealed` (counts) does not change on a swap; `unstage` never fires it (Tasks 22 and 25 read swaps through it).

- [ ] **Step 1: Write the contract cases** (both renderers, spec §5.5; `:295`'s "staging a revealed column throws" replaced):
  - "a staged replacement keeps every old row visible until its last row is uploaded, then the old are hidden and the new shown in one pump" (the visible index sum equals the old payload's on every pump before, the new's from that pump on);
  - "a second `stage` during a swap replaces the pending payload and keeps the old shown";
  - "`unstage` during a swap keeps the old shown, releases the pending rows and returns true; `unstage` of a revealed column with nothing pending returns false and changes nothing; `unstage` of an unknown column returns false";
  - "`remove` during a swap hides both"; "an empty replacement hides the old at once";
  - "on a swap that needs no growth, `gpuBytes()` returns to the old level after the swap's releases; a swap that grew its region is compared with the post-growth size" (growth ×1.5 is never undone, SP4b §4.3);
  - "probe's `partial` and `mixed` are 0 on every pump of a 1,000-step LCG sequence (seed 4242) of stage / re-stage / unstage / remove / pump over revealed columns";
  - "`isRevealed` stays true for a column through its swap";
  - "a swap calls `onColumnRevealed` once, in the pump that swaps it; an empty replacement once; `unstage` never".
  - `regionBatch.test.ts`: "an `optimize()` during a swap keeps `prev`'s rows visible and their ids valid"; "the swap sets visibility in one pass (no frame shows neither)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/regionGrid.test.ts test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts`. Expected: FAIL (the contract file runs on both renderers; RegionMesh's specifics are Task 9, and **(plan)** its `swap` is `hide(prev)` then `reveal(next)` here, enough for the generic cases).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npx vitest run --project metrics-fast test/metrics/stream.metric.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): a shown column swaps to its replacement in one frame` (`git add` the files above).

---

### Task 9: The swap on RegionMesh

**Files:**
- Modify: `src/render/regionMesh.ts` (`swap`, the arena with `prev` and the replacement coexisting, the culling sphere), `test/unit/regionMesh.test.ts`

**Interfaces:**
- Produces (spec §5.3): the replacement takes vertex and index ranges from the arena's free list (first fit), its index range zero until the swap; `swap` writes the new range's rebased indices and zeroes `prev`'s index range in the same call (two update ranges: `addUpdateRange` plus `needsUpdate`); `prev`'s ranges are freed under the budget; growth ×1.5 and compaction (≥ 40 % free) move `prev` with the rest; the region's culling sphere is the union of the shown spans, `prev` included until it is hidden.

- [ ] **Step 1: Write the tests** (`regionMesh.test.ts`):
  - "a swap issues exactly two index update ranges in one call: the new range's rebased indices and `prev`'s zeroed";
  - "until the swap the replacement's index range is all zero" (nothing of it is drawn);
  - "a compaction (≥ 40 % free) during a swap moves `prev` and keeps it visible"; "a growth (×1.5) during a swap keeps `prev` visible";
  - "the culling sphere covers `prev` until the swap and only the new spans after the releases".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/regionMesh.test.ts`. Expected: PASS on Task 8's interim swap. These cases pin RegionMesh's spec §5.3 behaviour, which `hide(prev)` + `reveal(next)` in one call already gives (each writes its span's index range through `mark(a, 2, …)`, `regionMesh.ts:478-509`; a span's indices stay zero until its reveal; `bound()`, `:277-286`, unions only the shown spans; compaction and growth move every span). Only a case that Task 8's code does not satisfy may FAIL.
- [ ] **Step 3: Implement** only what a failing case needs (e.g. a dedicated `swap` doing both writes in one pass); if nothing fails, keep Task 8's swap and commit the tests as pins.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (the contract cases on both renderers).
- [ ] **Step 5: Commit** `test(render): RegionMesh's swap pinned, two update ranges` (`feat(render): …` if Step 3 changed code) (`git add src/render/regionMesh.ts test/unit/regionMesh.test.ts`).

---

### Task 10: The pump's order

**Files:**
- Modify: `src/render/regionGrid.ts` (`pump` :337-436: the releases :357-382 and the emptied regions :383-389), `test/unit/sectionRendererContract.ts` (`:182`, `:264` rewritten), `test/unit/regionGrid.test.ts`, `test/unit/regionBatch.test.ts` (`:269` rewritten), `test/arch/masterSpec.test.ts`
- Master: §4.2's Unload, §4.3's Uploads (spec §12)

**Interfaces:**
- Produces (spec §5.4), per pump: (1) emptied regions (no column shown or staged) disposed outright after their pending removals are purged from the release queue without a per-row release, outside the row cap and the structural slot, at most `EMPTIED_PER_PUMP = 8` (exported from `regionGrid.ts`); (2) one structural operation for the nearest pending column; (3) releases of removed rows and swapped-out `prev` rows: at most `RELEASE_SHARE = 16` rows while any staged column waits for an upload, else up to the cap; (4) uploads nearest-first with the rest; (5) reveals and swaps.

- [ ] **Step 1: Write the tests.**
  - Contract (both renderers):
    - "an emptied region is disposed in the next pump without spending a row or the structural slot, also while removals of it are still queued (they are purged, and no release afterwards touches the disposed region)";
    - "with 200 rows to release and an upload waiting, a pump spends at most 16 rows on releases"; "with nothing waiting, releases take up to 32";
    - "at most 8 regions are disposed per pump; the ninth goes in the next";
    - "a region holding one swapped-out `prev` and one live column is not disposed";
    - SP4b's cases that empty a region, rewritten for D10: `sectionRendererContract.ts:182` becomes a staged column in a new region plus 40 removed rows in a region that keeps a live column (the first pump creates the region and releases ≤ 16 rows while the upload waits); `:264` disposes the emptied region (0, 0) in the first pump with 0 rows spent, `rows`/`vertices`/`indices` dropping by the purged rows and `regionAt(r, 0, 0)` empty after that pump.
  - `regionBatch.test.ts:269` ("removal releases at most 32 rows per pump") keeps a second live column in the same region so the 32-row release cap is still exercised (or asserts the emptied-region path: 0 rows spent and no per-row `deleteGeometry`).
  - `regionGrid.test.ts`: "after a far jump that removes 489 shown columns of 14 rows, the first new column's rows upload in the first pump that has them" (SP4b's order spent about 220 pumps first).
  - SP4c describe: §4.2's Unload contains `(SP4c: a region left with no column is disposed at once, outside the row cap and the structural slot)` and §4.3's Uploads `(SP4c: at most half the row cap on releases while an upload waits)`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/regionGrid.test.ts test/unit/regionBatch.test.ts test/unit/regionMesh.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.2 and §4.3 as spec §12 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npx vitest run --project metrics-fast test/metrics/stream.metric.ts`. Expected: PASS; `partialColumnFrames` 0.
- [ ] **Step 5: Commit** `feat(render): emptied regions go at once; releases share the rows with uploads` (`git add` the files above).

---

### Task 11: The configure driver: adopt, onConfigured, preview wanted, the replaying sink

**Files:**
- Modify: `src/ui/map/previewDriver.ts`, `src/ui/map/mapPage.ts`, `test/unit/previewDriver.test.ts`, `test/unit/fallback.test.ts` (`:168`'s `SimPool` resolves `{ epoch: e, stageHashes: {…}, genKey: h }`), `test/unit/toolbar.test.ts` (`:6`'s `status` gains `queued: false`), the SP4c spec (Spec corrections: `adopt`'s seed key; the `show()` note)

**Interfaces:**
- Produces (spec §4.2, §6.3; Spec corrections: `adopt` needs the seed key):
  - `DriverPool.configure(…)` resolves `{ readonly epoch: number; readonly stageHashes: Readonly<Record<string, string>>; readonly genKey: string }`; `DriverPool.spawn(priority?: number): Promise<Spawn>`;
  - `createPreviewDriver(pool, canvas, clock, opts?: { readonly spawnPriority?: number })` — the world passes 600, the standalone page nothing (−2);
  - `interface Configured { readonly poolEpoch: number; readonly sessionEpoch: number; readonly seedKey: string; readonly ready: { readonly stageHashes: Readonly<Record<string, string>>; readonly genKey: string }; readonly gesture: boolean; readonly urgent: boolean }` (the change that started the cycle);
  - `PreviewDriver.adopt(a: { readonly poolEpoch: number; readonly sessionEpoch: number; readonly seedKey: string; readonly ready: Configured['ready'] }): void` — a landed cycle with that source, `canvas.setSource` called; the next `change` of the same session epoch does nothing;
  - `PreviewDriver.setPreviewWanted(on: boolean): void` — off: a cycle lands as soon as its configure resolves (no `lastLatencyMs` sample); the watchdog stays;
  - `PreviewDriver.onConfigured(fn: (c: Configured) => void): () => void` — once per resolved configure, superseded ones excluded;
  - `DriverStatus.queued: boolean` (the slot holds a draft); `PreviewDriver.dispose(): void` (the watchdog cleared, late configures and spawns ignored);
  - `createReplayingCanvas(): DriverCanvas & { attach(c: DriverCanvas): void; detach(): void }` — keeps the last source, interactivity and spawn and replays them into a canvas attached later.

- [ ] **Step 1: Write the tests** (`previewDriver.test.ts`, the fake pool, canvas and clock it has):
  - "adopt, then a change with the same session epoch configures nothing; `status.poolEpoch` and `sessionEpoch` are the adopted ones";
  - "with the preview not wanted, a cycle lands when its configure resolves (no `previewProgress`), and a second edit waiting in the slot starts then, not after the ≥ 1 s watchdog";
  - "with the preview wanted again, a cycle waits for its preview as today";
  - "onConfigured fires once per resolved configure with the change's `gesture` and `urgent` and the ready's `genKey`; never for a configure superseded before it resolved";
  - "`queued` is true while the slot holds a draft, false once it starts";
  - "dispose clears the watchdog (the fake clock has no pending timer) and a configure resolving after it calls nothing";
  - "the spawn after a settle uses `spawnPriority` (600) when given, −2 by default";
  - "the replaying canvas: after an adopt, `attach(fake)` receives `setSource` with the adopted epoch, seed key and hashes, then the interactivity and the spawn; after `detach` nothing is forwarded; a second `attach` replays again" (Spec corrections: the planned tiles are the smoke's).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/previewDriver.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `mapPage.ts` creates its driver over a replaying canvas and attaches its `MapCanvas` (Task 12 moves this into the shell).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): the configure driver adopts, reports and replays` (`git add src/ui/map/previewDriver.ts src/ui/map/mapPage.ts test/unit/previewDriver.test.ts test/unit/fallback.test.ts test/unit/toolbar.test.ts docs/superpowers/specs/2026-10-25-sp4c-map-in-world-design.md`).

---

### Task 12: `createMapTool`, every disposer, the standalone shell

**Files:**
- Create: `src/ui/map/mapTool.ts`, `src/ui/common/disposers.ts`, `test/unit/disposers.test.ts`, `test/unit/notice.test.ts`
- Modify: `src/ui/map/mapPage.ts` (the shell), `src/ui/map/layout.ts` (`createLayout` :173 mounts into a child `.map`, not `root.replaceChildren` :251; `dispose`), `src/ui/map/map.css` (:44 `@media (max-width: 899px)` → `@container map (max-width: 899px)`; the host gets `container: map / inline-size`), `src/ui/map/mapView.ts` (`destroy` :303 also cancels its queued tiles and ignores resolutions after it), `src/ui/map/hoverPanel.ts`, `src/ui/inspector/hoverModel.ts`, `src/ui/crossSection/voxels.ts` (a `disposed` flag), `src/ui/map/toolbar.ts`, `src/ui/common/notice.ts` (row timers cleared), `src/ui/common/urlWriter.ts` (`dispose`: a pending write flushed), `src/ui/splineEditor/plot.ts:287`, `src/ui/crossSection/section.ts:470` (the ResizeObservers kept and disconnected), `src/engine/session.ts` (`listenerCount()`), `src/ui/map/previewDriver.ts` (`draftOf` exported), `src/ui/common/keys.ts` (`installShortcuts` :65-75 gains `enabled`, moved here from Task 14), `test/unit/keys.test.ts`, `test/unit/fixtures/domShim.ts` (`classList`: add/remove/toggle/contains over `className`), `test/unit/session.test.ts`, `test/unit/urlWriter.test.ts`, `test/arch/masterSpec.test.ts`, the SP4c spec (Spec corrections: `MapViewState` is `MapView`)
- Master: §1's `ui/map/*` line (spec §12)

**Interfaces:**
- Produces (spec §1.1): `createMapTool(host: HTMLElement, deps: MapToolDeps): MapTool` with `MapToolDeps` and `MapTool` as spec §1.1, the view typed `MapView` (Spec corrections), plus **(plan)**:
  - `MapTool.notices: Notices` (the tool's notice row, for Task 20);
  - `MapToolDeps.onMounted?: (parts: { canvas: MapCanvas; host: HTMLElement; view(): MapView; editAt<T>(at: number, fn: () => T): T }) => void` (the standalone shell's `?perf=edit` hook);
  - `MapToolDeps.relay: { attach(c: DriverCanvas): void; detach(): void }` (the driver's replaying canvas, Task 11): the tool attaches its own sink at mount (`setSource`/`setInteractive` to its `MapCanvas`; `setSpawn` to the canvas and the World tab's spawn readout, as today's sink, `mapPage.ts:150-157`) and detaches it in its disposers (spec §4.2);
  - `MapToolDeps.shortcutsEnabled: (a: ShortcutAction) => boolean`: the tool installs `installShortcuts(on, (a) => (a === 'togglePanel' || a === 'closeDrawer') && deps.shortcutsEnabled(a))`; the standalone shell passes `() => true`, the world's overlay its owner rule (Task 15);
  - `MapToolDeps.onView: ((v: MapView) => void) | null`, called wherever the tool would call `urlSink` for a view change (pan, zoom, layer, Centre on me); null on the standalone page, where `urlSink` covers it; the world's overlay passes the page's `viewChanged` (Task 19);
  - `type MapPool = WorkerPool` (every editor already takes the pool's type).
- Produces: `createDisposers(): { add(fn: () => void): void; dispose(): void }` — runs each once, in reverse order of `add`, each guarded (a throw is reported and the rest run); `WorldSession.listenerCount(): number`; `draftOf(s: SessionState): DriverDraft` exported from `previewDriver.ts` (today a module-private const, `mapPage.ts:51`), used by the shell, the world page (Task 15) and the apply control's initial draft (Task 18); `installShortcuts(on, enabled: (a: ShortcutAction) => boolean = () => true)` — a disabled action is neither run nor default-prevented (moved here from Task 14: today `installShortcuts(on)` prevents all four actions and returns on `defaultPrevented`, `keys.ts:65-75`, so with the shell's and the tool's two listeners one half would stop working until Task 14).
- **The split of `mapPage.ts:54-351`:**
  - **into the tool:** the layout (`:63`), its notices (`:65`), the World tab's readouts and hover (`:84-97`), `editAt`/`edit` (`:100-105`), the cut tool and pin (`:111-115`, `:247-263`), the canvas (`:116-144`), the hover-biome highlight (`:160-166`), `setView` (`:168-174`), the toolbar (`:175-181`, its "Open in 3D" from `deps`), `driver.onStatus` (`:187-197`), the draft log and `session.subscribe` (`:199-207`, the URL through `deps.urlSink`), the parameter panel, spline drawer, cross-section, Density tab, slice view, probes, shares, biome table and presets tab (`:212-329`), the P and Escape shortcuts (`:331-337`, through `installShortcuts(on, enabled)` as above), `import './map.css'` (`:16`, so the world's chunk, which imports only `mapTool`, carries the stylesheet), and, run once at creation, `drafts.remember(session.state.epoch, session.state.params, driver.status.sessionEpoch)` (`:345`), `toolbar.setStatus(driver.status)` (`:347`) and `renderStatus()` (`:349`), so a tool mounted after an adopt seeds its draft log (the slice view runs on `drafts.configured(driver.status)`, `:271`, null for a never-remembered epoch, `sliceModel.ts:1017-1020`); each handle into one `createDisposers()` registry;
  - **into the shell** (spec §1.4): the perf hook (`:56-58`), `decodeMapState` and `openMapSession` (`:57-60`), its own pool (`:68-70`), the URL writer and `pagehide` (`:72-73`), `mapHash`/`writeUrl` (`:75-81`), the driver over a replaying canvas (`createReplayingCanvas`, Task 11) passed to the tool as `relay`, undo and redo (`:332-333`, through `installShortcuts(on, (a) => a === 'undo' || a === 'redo')`), `hashchange` (`:338-342`), then `createMapTool(root, { host: 'page', shortcutsEnabled: () => true, onView: null, … })`, then the first cycle's `driver.change(draftOf(session.state), { kind: 'load', … })` (`:346`) and `writeUrl()` (`:348`). The smoke's map steps and SP2b's latency runner see the same page.
- The tool's canvas carries no `data-renderer` (the world keeps exactly one, SP4b GOV-8).

- [ ] **Step 1: Write the tests.**
  - `disposers.test.ts`: "runs every disposer once, in reverse order of `add`"; "a second dispose runs nothing"; "a disposer that throws does not stop the others, and the throw is reported"; "an `add` after dispose runs at once".
  - `session.test.ts`: "listenerCount counts each subscribe and its remover".
  - `urlWriter.test.ts`: "dispose flushes a pending write and clears its timer". `notice.test.ts` (dom shim, `classList` added): "dispose clears every row's timer".
  - `keys.test.ts` (moved here from Task 14): "undo and redo installed alone: Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, P and Escape pass through unprevented"; "P and Escape installed with `enabled` false: nothing runs, nothing prevented; with true: as today".
  - The tool's draft log seeded at mount needs a DOM: a smoke check in Task 24's step 2 (the Density tab's slice draws after M without an edit).
  - SP4c describe: the `ui/map/*` line contains `(SP4c: \`mapTool.ts\`, the tool both \`?map\` and the world's M overlay mount)` and still `the standalone ?map page (mounted in-game from SP4c)`; `SP4C_MODULES` gains `[/^\s+ui\/map\/\* /, 'mapTool.ts', 'src/ui/map/mapTool.ts']`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1 as spec §12 words it.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build`, then the smoke's map steps `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` (its own port and Chrome profile). Expected: PASS; every map step unchanged.
- [ ] **Step 5: Commit** `refactor(map): createMapTool with every disposer; ?map is its standalone shell` (`git add` the files above).

---

### Task 13: The tool in the world: the arrow, the hidden state, the click routing, the header slot

**Files:**
- Modify: `src/ui/map/mapView.ts` (`setPlayer`, `setHidden`; `onClick` gains `shift`), `src/ui/map/viewMath.ts` (the arrow's geometry), `src/ui/map/clickAction.ts`, `src/ui/map/toolbar.ts` (`ToolbarDeps`, "Open in 3D" :215), `src/ui/map/mapTool.ts` (`show`, `hide`, `setPlayer`, routing by `host`), tests `test/unit/clickAction.test.ts`, `test/unit/toolbar.test.ts`, a new `test/unit/mapArrow.test.ts`, `test/unit/fixtures/domShim.ts` (a global `Option` stub installed by `installDom`, for `createToolbar`'s selects, `toolbar.ts:106`, `:117`), the SP4c spec (Spec corrections: Shift+click's table)

**Interfaces:**
- Produces:
  - `arrowGeometry(x: number, z: number, yawDeg: number, v: MapView, w: number, h: number, out: Float64Array): boolean` (viewMath) — the isosceles triangle 14 px long and 10 px wide along the screen vector (sin yaw, −cos yaw) into `out` (6 values), false when its centre is outside the view; `arrowMoved(px, pz, pyaw, x, z, yaw, bpp): boolean` — ≥ 1 px or ≥ 2°; **(plan)** `ARROW_MIN_MS = 33`, `arrowDue(lastDrawMs: number, nowMs: number): boolean` — ≥ 33 ms since the last arrow redraw (≤ 30 per second);
  - `MapCanvas.setPlayer(x: number, z: number, yawDeg: number): void` — drawn white with a 1.5 px `#111` outline above the tiles and below the hover cursor; redraws only when `arrowMoved` and `arrowDue`; `MapCanvas.setHidden(on: boolean): void` — no tile requests while hidden, its queued tiles cancelled;
  - `MapViewOptions.onClick(x: number, z: number, shift: boolean)` (`mapView.ts:24`), passed `e.shiftKey` in `endDrag` (`mapView.ts:255-258`); the tool's `onClick` puts it in `MapClick.shift`;
  - `MapClick.host: 'world' | 'page'`, `MapClick.shift: boolean`; `MapClickAction` gains `{ readonly kind: 'teleport' }`; world: armed cut → `cut`; plain → `teleport`; Shift → today's unarmed table as is (`clickAction.ts:37-39`: Density tab shown → `centre` on a horizontal plane, else `pin`; otherwise near line → `openSection`, else `pin`; Spec corrections); page: today's table, Shift ignored;
  - `ToolbarDeps.embedded: { readonly slot: HTMLElement; readonly hint: string } | null` — embedded hides "Open in 3D" and shows the hint `Click: go here · Shift+click: pin`;
  - `MapTool.show(centre?)` re-measures, centres on `centre` at the current `bpp` and layer, `setHidden(false)`, `driver.setPreviewWanted(true)`; `hide()` `setHidden(true)`, `driver.setPreviewWanted(false)`.

- [ ] **Step 1: Write the tests.**
  - `clickAction.test.ts` (the full table for both hosts, Point 3's answer):
    - "world, plain: teleport (Density shown or not, near the line or not)"; "world, armed cut, plain or Shift: cut";
    - "world, Shift on the Density tab's horizontal plane: centre; Shift on Density's vertical plane near the line: pin; Shift, Density tab not shown, near the line: openSection; Shift elsewhere: pin";
    - "page: today's routing, with and without Shift" (`clickAction.ts:35-40` unchanged for `host: 'page'`).
  - `mapArrow.test.ts`: "yaw 0 points up the screen, 90 right, 180 down, 270 left"; "the tip is 14 px from the base's midpoint and the base 10 px wide"; "a centre outside the view: false"; "`arrowMoved` at 4 blocks/px: 3.6 blocks and 1.9° → false; 4 blocks or 2° → true"; "`arrowDue(1000, 1020)` false, `(1000, 1033)` true".
  - `toolbar.test.ts`: "embedded: no Open in 3D, the hint `Click: go here · Shift+click: pin`, the slot appended after the hint".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): the player arrow, the hidden state and the world's click routing` (`git add` the files above).

---

### Task 14: Input: M, `active`, Esc's rule, the help's undo line; `mapMode` and `watchLive`

**Files:**
- Modify: `src/player/keymap.ts` (`DEFAULT_KEYMAP` :34-48), `src/player/input.ts` (`attachInput` :63-153), `src/ui/common/keys.ts` (`escapeAllowed`; `installShortcuts`'s `enabled` is Task 12's), `src/ui/settings.ts`, `src/ui/world/worldPage.ts` (`helpChange` :568-572), `src/ui/loading/tips.ts` (`TIP_TEMPLATES` :13-23 gains a template naming `{map}`, e.g. `'{map} opens the map over the world: click to go there, edit the world live'`; the stale `?map … "Open in 3D"` tip reworded), `src/ui/help.ts` (the undo and redo line), the SP4c spec (Spec corrections: `helpChange`)
- Modify (tests): `test/unit/keymap.test.ts:26`, `test/unit/input.test.ts`, `test/unit/keys.test.ts`, `test/unit/settings.test.ts`, `test/unit/worldPage.test.ts`, `test/unit/tips.test.ts` (`:13`: 13 → 14 entries), `test/unit/help.test.ts`

**Interfaces:**
- Produces:
  - `{ action: 'map', bindings: [code('KeyM')], label: 'Map: teleport and live editing', group: 'view', since: 'SP4c' }`;
  - `attachInput` options gain `active(): boolean` — checked for every action but `map`; while false a world key is neither acted on nor default-prevented, and the wheel changes no speed (still prevented: the world never scrolls); the handle gains `clear(): void`;
  - `ESC_AFTER_UNLOCK_MS = 150`; `escapeAllowed(nowMs: number, locked: boolean, unlockedAtMs: number): boolean` (keys.ts) — false while locked and while `nowMs − unlockedAtMs < 150`;
  - `WorldSettings.mapMode: 'full' | 'split'` (default `'full'`) and `watchLive: boolean` (default `true`), normalised; `helpChange` keeps both from `saved` (Spec corrections);
  - the help names undo and redo (no keymap entry carries them, so the generated key table does not): `Ctrl+Z undo · Ctrl+Y redo (Ctrl+Shift+Z also descends while flying; Ctrl+Y does not)` (spec §2.4).

- [ ] **Step 1: Write the tests** (spec §2.4's key table):
  - `keymap.test.ts:26`: every entry is `since: 'SP4a'` except `map` (`'SP4c'`); KeyM resolves to `map`; no binding shared.
  - `input.test.ts` (the fake doc it has):
    - "inactive: W, A, S, D, Space, Shift, Ctrl, T, H, F1, F3, + and − do nothing and are not default-prevented (Space presses a focused map button, − types)";
    - "inactive: M still fires `onAction('map')`"; "M in a text field does nothing, active or not";
    - "the wheel while inactive changes no speed"; "`clear()` empties `held`".
  - `keys.test.ts`:
    - **Review Focus 4:** "lost at 1,000 ms: `escapeAllowed(1000, true, 0)` false, `(1100, false, 1000)` false, `(1200, false, 1000)` true".
  - `settings.test.ts`: "mapMode and watchLive kept through `normalizeSettings`; a bad value (`'half'`, `1`) defaults; an old stored object without them gets the defaults".
  - `tips.test.ts`: every keymap action, `map` included, is named by a template; 14 entries.
  - `help.test.ts`: "the help's text contains `Ctrl+Z undo · Ctrl+Y redo (Ctrl+Shift+Z also descends while flying; Ctrl+Y does not)`".
  - `worldPage.test.ts`: "after the mode switch to split, a FOV change from the help keeps `mapMode: 'split'` and `watchLive: false`" (Spec corrections).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The help's key table, the HUD hints and the tips follow the keymap.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(input): M, an active predicate, Esc after unlock` (`git add` the files above).

---

### Task 15: The overlay: lazy mount, the controls owner, the world's keys

**Files:**
- Create: `src/ui/world/mapOverlay.ts`, `test/unit/mapOverlay.test.ts`
- Modify: `src/ui/world/worldPage.ts` (the first configure's `ReadyMsg` kept, :794; after the reveal, :913-916: the driver and the overlay; `attachInput` :1371-1379 with `active`; the frame step's `paused` :1389; undo/redo installed for the page's lifetime; teardown; the fatal and context-loss paths :686-708, `failAfterReveal`, `handleContextLoss`), `src/ui/styles.css` (`.map-overlay`), `test/unit/worldPage.test.ts`, `test/unit/fixtures/domShim.ts` (`FakeDocument.activeElement` with `FakeElement.focus()`/`blur()`, `pointerLockElement` and `exitPointerLock()`), `test/arch/masterSpec.test.ts`
- Master: §5.6 (click, the 3D streaming at reduced priority, bookmarks → saved places), §5.9 (M) (spec §12)

**Interfaces:**
- Produces, pure: `ownerOf(mode: 'full' | 'split', shown: boolean, locked: boolean): 'world' | 'map'` (hidden → world; full shown → map; split shown → world when locked, else map).
- Produces: `createMapOverlay(o: { app: HTMLElement; worldHost: HTMLElement; canvas: HTMLCanvasElement; session: WorldSession; pool: WorkerPool; driver: PreviewDriver; relay: ReturnType<typeof createReplayingCanvas>; settings: Pick<WorldSettings, 'mapMode' | 'watchLive'>; save(s: Pick<WorldSettings, 'mapMode' | 'watchLive'>): void; fly: FlyState; input: { clear(): void }; doc: Document; win: Window; now(): number; onTeleport(x: number, z: number): Promise<boolean> }): MapOverlay`, `interface MapOverlay { readonly owner: 'world' | 'map'; readonly shown: boolean; readonly mode: 'full' | 'split'; toggle(): void; open(): void; close(): void; tick(counts: CoordinatorCounts): void; readonly tool: MapTool | null; dispose(): void }` **(plan: the shape)**.
- Behaviour (spec §1.3, §2.3, §2.4):
  - `div.map-overlay` appended to `#app` beside `#world-host` (not inside it); created at the reveal, so M before it does nothing (nothing may configure the pool before the reveal, `coordinator.ts:59`);
  - 2 s after the reveal `import('../map/mapTool')` preloads the chunk and its CSS without mounting;
  - the first `open` mounts the tool (`host: 'world'`, `urlSink: null`, the toolbar slot, its `onTeleport` wrapping the overlay's: true in full closes the map, split keeps it open, false keeps it as it is, Task 16) and passes `relay` and `shortcutsEnabled` in the tool's deps (the tool attaches its own sink, Task 12), so the map draws at once; later `open`/`close` call `show({ x: fly.x, z: fly.z })`/`hide()`, the host `display: none` while hidden;
  - `tick(counts)`, called by the page from the frame step's `onRendered` (`frameStep.ts:72`) with the page's one counts object: while shown and the tool is mounted, `tool.setPlayer(fly.x, fly.z, fly.yaw)` (scalars, allocation-free; the canvas redraws only when `arrowMoved`, ≤ 30/s); `open` also calls it once right after `show`, so the arrow is drawn at the camera on opening in both modes (spec §1.5, D19); Task 20 reads `counts.stale` in the same tick;
  - opening releases the pointer lock; every owner change calls `input.clear()`;
  - P and Esc run through the tool's `installShortcuts` with the overlay's `shortcutsEnabled`: `owner === 'map' && shown`, and for `closeDrawer` also `escapeAllowed(now(), doc.pointerLockElement !== null, unlockedAt)` from the last `pointerlockchange` (Task 14);
  - the page's `paused()` is `help.isOpen || overlay.owner === 'map'`; `attachInput`'s `active()` is `overlay.owner === 'world'`, so H, F1, F3 and T do nothing while the map owns;
  - a fatal error or a context loss calls `overlay.dispose()` before the failure panel or the notice (D27; `worldPage.ts:237` releases the pool right after); the world page's teardown disposes it; the bench and flight routes create none.
- The page, at the reveal **(plan: moved here from Task 18, since the overlay needs it)**: the driver `createPreviewDriver(pool, relay, clock, { spawnPriority: 600 })`, then `driver.setPreviewWanted(false)` (spec §4.2: no map is shown until the first M; the first `open` mounts the tool and calls `tool.show(…)`, which sets it true, Task 13), `driver.adopt({ poolEpoch: workers.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready })` from the kept first `ReadyMsg`, `session.subscribe` → `driver.change(draftOf(s), …)` (`draftOf`, Task 12) **only while the tool is not mounted** **(plan: exactly one caller of `driver.change` per change; once the first M mounts the tool, its own subscribe, `mapPage.ts:199-207`, is the caller, hidden or shown, so a second urgent change of the same epoch never restarts a gesture's cycle, `previewDriver.ts:169-179`; test: after a mount, one session change gives exactly one `driver.change` call)**. Until Task 18 an edit holds the world (D3's gate: the pool's generation moves, the coordinator issues nothing): expected between these tasks, never pushed alone to production.

- [ ] **Step 1: Write the tests.**
  - `mapOverlay.test.ts` (dom shim, a fake `pointerLockElement`, a fake tool module):
    - "`ownerOf` over the 8 combinations";
    - **Review Focus 4 (wiring):** "W held while locked in split, then the lock lost: `held` empty and `paused()` true from that tick; `fly.x` unchanged over the next 60 ticks";
    - "a click on the 3D half that takes the lock blurs a focused seed field (`document.activeElement` is the body), so W moves the camera";
    - "the first open imports and mounts once; close and open again do not remount; open re-centres on the camera at the last `bpp`";
    - "open in full while locked calls `exitPointerLock`"; "P toggles the panel only while the map is shown and owns; with the map hidden, P does nothing";
    - "shown: 30 rendered ticks while `fly.x` grows by 64 call `setPlayer` with the camera's x, z and yaw; hidden: none; `open` calls it once";
    - "before the first M the overlay sets nothing on the driver; the first `open` calls the tool's `show`, which wants the preview (Task 13)"; the page's `setPreviewWanted(false)` at the reveal lands a session change's cycle when its configure resolves, with no watchdog wait (Task 11's "with the preview not wanted" case on the driver; the page itself mounts only in the smoke).
  - `worldPage.test.ts`: "a fatal with the overlay open disposes it before the failure panel shows"; "the same for a context loss".
  - SP4c describe: §5.6's click line contains `(SP4c: in the world's map a plain click teleports, except while the cut tool is armed; Shift+click sets the pin or the slice centre; on \`?map\` a click sets the pin)`, its streaming line `(SP4c: in mode A, map open; in mode B the 3D streams first and the map's jobs are capped as §4.3)`, its layers `saved places per saved world (SP5: a section of each saved world's map, one map per saved world)` and no `bookmarks per save`; §5.9 `M (map: SP4c's overlay, full screen or side by side)`; `SP4C_MODULES` gains `[/^\s+ui\/world\/\* /, 'mapOverlay.ts', 'src/ui/world/mapOverlay.ts']`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1's `ui/world/*` line gains `mapOverlay.ts`; §5.6 and §5.9 as spec §12 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the map overlay in the world and the controls owner` (`git add` the files above).

---

### Task 16: Modes A and B: layout, `resize()`, availability, the covered cap, Watch live

**Files:**
- Modify: `src/render/renderer.ts` (`resize` :396-398 returned on `WorldRenderer`), `src/ui/world/mapOverlay.ts`, `src/ui/styles.css` (`.world-host.split { left: 50%; }`; `.map-overlay` full and split; `.world-notices` :33 `max-width: calc(100% - 2rem)`), `src/ui/world/worldPage.ts` (the limiter's cap; the overlay's new options), tests `test/unit/mapOverlay.test.ts` (no renderer test: no unit test can construct a `WorldRenderer`, `render/renderer.ts:380` needs WebGL and `:398` a ResizeObserver; `resize` returns the existing closure over `applyViewport`, covered by `viewport.test.ts`; the half-width canvas after the switch is the smoke's split step, Task 24 step 4)

**Interfaces:**
- Produces:
  - `WorldRenderer.resize(): void`;
  - `createMapOverlay`'s options gain `world: Pick<WorldRenderer, 'resize' | 'frame'>`, `frameState(): FrameState`, `limiter: Pick<FpsLimiter, 'setCap'>` and `userCap(): FpsCap`;
  - `SPLIT_MIN_WIDTH = 1000`; `splitAvailable(innerWidth: number): boolean`; a stored `'split'` opens as full below it, and the switch shows B disabled with the reason `Side by side needs a window at least 1,000 px wide`; the overlay listens to `win` `'resize'` (removed in `dispose`) and re-evaluates `splitAvailable(win.innerWidth)` for the switch: B disabled with the reason below 1,000, enabled at or above (spec §2.2);
  - `frameCapFor(mode, shown, userCap: FpsCap): FpsCap` — full shown → 60, or the user's cap when lower and non-zero; else the user's cap;
  - the switch (full ↔ split, shown): the host class, then `world.resize()` and one `world.frame(state)`, so the switch's painted frame is drawn; a switch to full while locked calls `exitPointerLock`; the header's controls (in the tool's slot): "Full screen | Side by side", "Watch live" (full only), "Centre on me", "✕ Close (M)"; a change saves the setting at once;
  - `MapOverlay.applied(from: WorldStage | null): void` — full, shown, `watchLive` and `from !== null` → close (the map hides, the 3D shows the regeneration); a null `from` changes nothing (Task 18 calls it from `onApplied`).

- [ ] **Step 1: Write the tests.**
  - `mapOverlay.test.ts`:
    - "`splitAvailable(999)` false, `(1000)` true; a stored split at 999 opens full and the switch shows the reason; at 1,000 it opens split";
    - "`frameCapFor`: full shown, user 0 → 60, user 30 → 30, user 144 → 60; split shown or hidden → the user's";
    - **Review Focus 3** as worded there, without the aux-policy column (Task 18's): limiter caps, owners, `exitPointerLock`, `world.resize()` then one `world.frame` on a fake (fake renderer, limiter and lock);
    - "at 999 the switch shows B disabled with the reason; a resize event at 1,000 enables it; `dispose` removes the listener";
    - "`applied('T')` with Watch live in full shown closes the map and the owner becomes world; with Watch live off, in split, or `applied(null)`, the map stays";
    - "the mode switch and Watch live are saved at once (`save` called with the new settings)";
    - "a teleport from the tool whose `onTeleport` resolves true closes the map in full (owner world) and keeps it open in split; false (`Could not teleport`, or superseded) keeps it open in both" (spec §2.1, §2.2);
    - "Centre on me calls the tool's `show` with the camera's x and z (the fake tool's view keeps its `bpp`)" (spec §1.5).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/mapOverlay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): full-screen and side-by-side modes with Watch live` (`git add` the files above).

---

### Task 17: Teleport and the eye light

**Files:**
- Create: `src/ui/world/teleport.ts`, `test/unit/teleport.test.ts`
- Modify: `src/ui/world/frameStep.ts` (`eyeSkyLight` :85-91 keeps the last value; the call in `tick`), `src/ui/world/worldPage.ts` (`skyLightAt` :201-208; the tool's `onTeleport`), `test/unit/frameStep.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §3.7's caching and Teleport lines (spec §12)

**Interfaces:**
- Produces, in `teleport.ts`:
  - `LANDING_ABOVE = 24`, `LANDING_MAX_Y = 400`, `LANDING_RETRIES = 3`;
  - `landingY(surface: number, water: number): number` = min(400, max(surface, water) + 24) (over the sea 87; over plains near 64 about 90; over a 300-block peak 324);
  - `createTeleport(o: { pool: Pick<WorkerPool, 'landing'>; fly: FlyState; state: { eyeSky: number }; onArrive(x: number, z: number, landing: { readonly surface: number; readonly water: number; readonly y: number }): void; onFail(): void }): { go(x: number, z: number): Promise<boolean> }` — x and z clamped to ±500,000 (`AT_LIMIT`, `ui/world/query.ts:27`), `landing(⌊x⌋, ⌊z⌋)` (Spec corrections), retried up to 3 times on `JobCancelled` (a configure moved the generation); any other rejection or a fourth cancel → `onFail()` ("Could not teleport", Task 20) and nothing moves; else `fly.x = ⌊x⌋ + 0.5`, `fly.z = ⌊z⌋ + 0.5`, `fly.y = landingY(…)`, `vx = vy = vz = 0`, yaw, pitch and speed kept, `state.eyeSky = 15`, `onArrive(fly.x, fly.z, { surface, water, y: fly.y })` (the landing, for Task 24's `lastLanding`); **(plan)** the latest `go` wins: a `go` superseded by a later one before its landing resolved resolves false and calls neither `onArrive` nor `onFail` (Review Focus 5); the next tick's `coordinator.update` does the long crossing (SP4b §3.4), the pump's order (Task 10) lets the first rows in at once.
- Produces, in `frameStep.ts`: `eyeSkyLight(store, x, y, z, last: number): number` — `last` when `lightAt` returns −1; the frame step passes `state.eyeSky`; the pre-reveal `skyLightAt` passes 15.
- The page: the overlay's `onTeleport` → `teleport.go` (the overlay closes the map on true in full, split keeps it and the arrow moves, Task 16). The fog does not react (Point 1).

- [ ] **Step 1: Write the tests.**
  - `teleport.test.ts` (the real `landingSurface` and `columnPoint` on a `GenContext`, a fake pool around them):
    - "`landingY(64, −∞)` is 88; `landingY(40, 63)` is 87 (over the sea); `landingY(330, −∞)` is 354; `landingY(380, −∞)` is 400 (404 clamped; `surfaceEst3` caps at 319, so only a synthetic value reaches the clamp)";
    - "on Task 7's jagged default-profile column, the camera is 24 above `surfaceEst3` (not only above ⌊surfaceEst⌋)"; "under amplified, 24 above `surfaceEst3`";
    - "x 600,000 and z −600,000 clamp to ±500,000; the landing is asked at the integer block, the camera placed at its centre";
    - "yaw, pitch and speed kept, velocity zeroed, `eyeSky` 15";
    - "two JobCancelled then success lands; four cancels or one WorkerFailed call `onFail` and move nothing";
    - **Review Focus 5 (second click)** as worded there.
  - `frameStep.test.ts`: "with `lightAt` −1 the eye light keeps its last value (6); 15 after a teleport; a Published column's light is read as today".
  - SP4c describe: §3.7's Teleport line as spec §12 words it, its caching line `(aquifers, structures: SP6-SP9; spawn and teleport query one point each and need none, SP4c)`; `SP4C_MODULES` gains `[/^\s+ui\/world\/\* /, 'teleport.ts', 'src/ui/world/teleport.ts']`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §3.7 and §1's `teleport.ts` as spec §12 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): teleport from the map, 24 blocks above the 3D surface` (`git add` the files above).

---

### Task 18: `applyControl` and the page's Apply

**Files:**
- Create: `src/ui/world/applyControl.ts`, `test/unit/applyControl.test.ts`
- Modify: `src/ui/world/frameStep.ts` (`FrameStepDeps` gains `beforeUpdate(): void` and `afterCounts(c: CoordinatorCounts): void` **(plan)**), `src/ui/world/worldPage.ts` (`createCoordinator` :831-848 with `epoch: epochs.of(ready.genKey)`; the apply control after Task 15's driver; the frame-step hooks; `driver.onStatus`: an `error` after the reveal is fatal, spec §4.3), `test/unit/frameStep.test.ts`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts`

**Interfaces:**
- Produces (spec §4.3):
  - `createEpochs(): { of(genKeyHex: string): number }` — interned from 1 (the first entry's draft), session-wide;
  - `createApplyControl(o: { coordinator: Pick<Coordinator, 'apply' | 'adopt'>; driver: Pick<PreviewDriver, 'onConfigured' | 'status'>; session: Pick<WorldSession, 'state' | 'inGesture' | 'subscribe'>; pool: Pick<WorkerPool, 'epoch'>; clock: { now(): number }; epochs: { of(k: string): number }; initial: AppliedDraft; initialGeneration: number; quietMs?: number /* 150 */; beforeApply(from: WorldStage | null): boolean; onApplied(a: { readonly from: WorldStage | null }): void }): { tick(): void; readonly applied: AppliedDraft; readonly generation: number; dispose(): void }` — keeps the latest `Configured`; it records the session's last change time itself through `subscribe` **(plan)**; `tick` applies when its `poolEpoch === pool.epoch`, `!driver.status.queued`, `!session.inGesture`, its `sessionEpoch === session.state.epoch` and `now − lastChange ≥ 150`; then `from = regenFrom(applied, next)`; `beforeApply(from)` (true in SP4c); `from === null` → `adopt(poolEpoch)`, else `apply({ epoch: epochs.of(genKey), generation: poolEpoch, from })`; `applied = next`; `generation = poolEpoch`; `onApplied({ from })`; the kept `Configured` is then dropped (null), so later ticks do nothing until the next `onConfigured`; allocation-free at rest (scalar compares); `initial` is `appliedDraftOf(draftOf(session.state).seedKey, ready)` from the kept first `ReadyMsg` (`draftOf`, Task 12), `initialGeneration` the first configure's epoch (`workers.epoch` at the reveal), and `generation` is `initialGeneration` until the first Apply or adopt, then that `Configured`'s `poolEpoch`;
  - `auxFirst(held: boolean, covers: boolean): 'world' | 'aux'` and `auxCap(held: boolean, covers: boolean, tPending: boolean, n: number): number` (spec §6.2): held → (aux, n); covers → (aux, max(1, n − 1)); else (world, tPending ? 1 : n). **(plan)** The page's `afterCounts` body is the exported `updateAuxPolicy(pool: Pick<WorkerPool, 'epoch' | 'size' | 'setAuxPolicy'>, generation: number, covers: boolean, counts: CoordinatorCounts): void`, which calls `pool.setAuxPolicy(auxFirst(…), auxCap(…))` with `held = pool.epoch !== generation` (the page passes `apply.generation`), `covers` (the page passes `overlay.mode === 'full' && overlay.shown`), `tPending = counts.T.done < counts.T.needed`, n = `pool.size`; `beforeUpdate` calls `apply.tick()`; `onApplied` calls `overlay.applied(from)` (Task 16), the URL (Task 19) and the undo notice (Task 20);
  - **(plan)** `onDriverStatus(s: DriverStatus, fail: (cause: string, e: unknown) => void): void` (worldPage.ts), the page's `driver.onStatus` after the reveal: an `error` calls `fail` (the failure panel with Copy details, spec §4.3).

- [ ] **Step 1: Write the tests.**
  - `applyControl.test.ts` (fake clock, a real `WorldSession` from `openMapSession`, a fake driver emitting `Configured`, a fake coordinator recording calls):
    - "a gesture's drafts are never applied (`density.detailAmpHi` 2.0, 3.0, 4.0 inside one gesture); the draft configured after the release is applied 150 ms after the release";
    - "at 149 ms nothing, at 150 ms the apply"; "a `Configured` whose `poolEpoch` is not `pool.epoch` (a newer configure issued) is never applied";
    - "a queued newer draft waits; its own `Configured` applies once quiet";
    - "an equal genKey adopts (`adopt(poolEpoch)`, no `apply`)"; "a new genKey applies with `epoch` from `createEpochs` (A → 1, B → 2, back to A → 1)";
    - "`beforeApply` sees `from`; `onApplied` fires once per Apply or adopt with its `from`";
    - "after an Apply, 100 more ticks call neither `apply`, `adopt` nor `onApplied`";
    - "`generation` is `initialGeneration` until the first Apply, then that `Configured`'s `poolEpoch`";
    - "a seed change and a profile change through the real session each apply with `from` 'T' and a new epoch, like any setting" (decision 9, spec §4.7);
    - **Review Focus 2** as worded there;
    - "the aux policy table, n = 4: held → (aux, 4); covers → (aux, 3); visible with T pending → (world, 1); visible without → (world, 4); n = 1 covers → (aux, 1)";
    - **Review Focus 3's aux policies:** "the A shown → B shown → B locked → A shown → hidden sequence (user cap 0, 4 workers, T pending, world not held) through `updateAuxPolicy` gives `setAuxPolicy` (aux, 3), (world, 1), (world, 1), (aux, 3), (world, 1)".
  - `frameStep.test.ts`: "`beforeUpdate` runs before `coordinator.update` and `afterCounts` after `counts`, on every tick, rendered or not".
  - `worldPage.test.ts`: "`onDriverStatus` with an `error` calls `fail` (the failure panel with Copy details); a status without one calls nothing" (`mountWorldPage` cannot mount in the unit project; the panel itself is `stopAfterFailure`'s).
  - SP4c describe: `SP4C_MODULES` gains `[/^\s+ui\/world\/\* /, 'applyControl.ts', 'src/ui/world/applyControl.ts']`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1's `ui/world/*` line gains `applyControl.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the apply control: the world applies the session's drafts live` (`git add` the files above).

---

### Task 19: The URL and the help

**Files:**
- Modify: `src/ui/world/reload.ts` (beside `hereUrl` :34-37), `src/ui/world/worldPage.ts` (`here` :1179 reads the live session; the URL writer; the help's options :1307-1327; `WorldNotices` :332-358 gains `show`/`hide`; the doc comment `:52`, now saying the button "Map (M)" opens the overlay), `src/ui/world/mapOverlay.ts` (passes the page's `viewChanged` as the tool's `onView`), `src/ui/help.ts` (the doc comments `:5` and `:33`, `mapHereHref` :31, `navigate` :36, the link :183-189, `:218`), tests `test/unit/worldReload.test.ts`, `test/unit/help.test.ts`, `test/unit/worldPage.test.ts`

**Interfaces:**
- Produces:
  - `withArrival(search: string, s: HereState): string` (reload.ts) — the search with `at`, `y`, `yaw` and `pitch` set in `hereUrl`'s formats (`reload.ts:30-37`), every other parameter kept in place;
  - `worldHash(session: Pick<WorldSession, 'state'>, view: MapView): string` — `encodeMapState({ v: 1, seed, profile, patch, view })`;
  - `HelpOptions.openMap(): void` replaces `mapHereHref` and `navigate`; the link becomes the button "Map (M)" (`#help-map`), which closes the help and opens the overlay;
  - **(plan)** `createWorldUrl(o: { session: Pick<WorldSession, 'state'>; view(): MapView; writer: { set(u: string): void }; loc: Pick<Location, 'pathname' | 'search'> }): { applied(): void; viewChanged(): void; arrived(s: HereState): void; here(rd: number | null): string }` (worldPage.ts or reload.ts): the page's URL rules below, testable on fakes (`mountWorldPage` cannot mount in the unit project);
  - `WorldNotices.show(text: string, o?: NoticeOptions): void` and `hide(text: string): void` (Notices-shaped, in `.world-notices`), so `oversizeNotice(worldNotices)` (`urlWriter.ts:28`) works.
- The page (spec §1.6, D20):
  - after every Apply (`onApplied`) and every view change of the tool (its `onView`, Task 12, which the overlay passes as the page's `viewChanged`), `location.pathname + location.search + '#' + worldHash(…)` through `createUrlWriter` (200 ms debounce, `history.replaceState`, hashes over 64 KiB dropped with `oversizeNotice`), never `?map`; the view is the tool's, or camera-centred at 4 blocks/px before the first M;
  - each teleport's `onArrive` replaces the search with `withArrival` (flight never does), so F5 returns to the last teleport;
  - `here()` and the failure and context-loss Reloads read the live session and camera, not the hash captured at mount; no `hashchange` listener in the world; the writer's `dispose` (a pending write flushed) runs in the teardown.

- [ ] **Step 1: Write the tests.**
  - `worldReload.test.ts`: "`withArrival('?at=1,2&rd=8&renderer=mesh', s)` sets at, y, yaw and pitch in `hereUrl`'s formats and keeps rd and renderer in place"; "an empty search gains the four"; "a `?y=` already present is replaced, not repeated".
  - `help.test.ts`: "the button reads `Map (M)`, calls `openMap` and closes the help; no `?map` link is left".
  - `worldPage.test.ts` (`createWorldUrl` on fakes): "after an Apply of `density.detailAmpHi` 4.0, `here()` (the context-loss Reload's href) decodes to the edited patch"; "the URL written after the Apply is `pathname + search + '#' + hash`, never `?map`"; "`viewChanged` writes the new view in the hash"; "before the first M the hash's view is centred on the camera at 4 blocks/px"; "`arrived` rewrites the search's `at` to the arrival, and nothing else does (a flight of 500 blocks does not)"; "`oversizeNotice(worldNotices)` shows and hides its notice in `.world-notices`".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `grep -rn "mapHereHref\|Open the map here" src/`. Expected: PASS; the grep prints nothing.
- [ ] **Step 5: Commit** `feat(ui): the world's URL follows the session and the last teleport` (`git add` the files above).

---

### Task 20: The notices; the map's regeneration readout (cut line)

**Files:**
- Modify: `src/ui/hud.ts` (`HudData` :36-50 gains `stale` and `needed`; the stages line :103-108), `src/ui/world/worldPage.ts` (`createWorldNotices` :420-480 routing; the HUD source; the undo/redo hook), `src/ui/world/mapOverlay.ts` (the Watch-live notice and the regeneration readout, both from `tick(counts)`), tests `test/unit/hud.test.ts`, `test/unit/worldPage.test.ts`, `test/unit/mapOverlay.test.ts`

**Interfaces:**
- Produces (spec §2.1, §2.4, §4.5, D26, D27):
  - the HUD line `stale <n> / <needed>` while `counts.stale > 0`;
  - the Watch-live notice `Regenerating… near → far · M returns to the map` at the bottom of the 3D while a Watch-live Apply hid the map and `counts.stale > 0` (the overlay reads `counts.stale` in `tick(counts)`, Task 15);
  - `UNDO_NOTICE_MS = 1500`: `Undo` or `Redo` at the bottom of the 3D for 1.5 s, hung on the apply control as spec §4.3 says: the page remembers the kind of the session's last change (`'undo'`, `'redo'` or other, from `subscribe`), and `onApplied` shows the notice when that kind is undo or redo and the map is hidden (an undo that rebuilds nothing, `from` null, shows it too); **(plan)** as the exported `createUndoNotice(o: { subscribe: WorldSession['subscribe']; mapShown(): boolean; show(text: string, ms: number): void }): { applied(from: WorldStage | null): void }` (worldPage.ts), the page's `onApplied` calling `applied(from)`;
  - `WorldNotices.route(target: Notices | null): void` **(plan)** — redirects `show`, `hide` (Task 19) and `storeFull` to `target` while it is non-null: while the overlay covers the 3D (full, shown) the transient notices (StoreFull, the URL oversize, `Could not teleport`, which is `notices.show('Could not teleport', { kind: 'warn', timeoutMs: 4000 })`) go to `tool.notices`; the failure panel and the context-loss notice never route (the overlay is disposed first, Task 15); **(plan)** `createMapOverlay`'s options gain `notices: Pick<WorldNotices, 'route'>`, and the overlay calls `route(tool.notices)` when it starts covering the 3D (full and shown) and `route(null)` when it stops (close, a switch to split, `dispose`);
  - **the map's regeneration readout** (the cut line, spec §13, D23): `Regenerating <n> / <needed>` (the HUD line's two values) in the toolbar slot while `counts.stale > 0`, fed by `overlay.tick(counts)`; skipped only if time runs short, and the skip is recorded in the exit evidence (Task 29) and worded in master §10 at Task 30.

- [ ] **Step 1: Write the tests.**
  - `hud.test.ts`: "stale 0: no line; stale 12 of 349: `stale 12 / 349`".
  - `worldPage.test.ts` (dom shim): "while routed, `storeFull`, the URL-oversize notice and `Could not teleport` show in the tool's row and not in `.world-notices`; unrouted, the reverse"; (`createUndoNotice` on fakes) "an undo with the map hidden shows `Undo` from its Apply for 1,500 ms, a redo `Redo`; with the map shown, nothing; a typed edit's Apply shows nothing".
  - `mapOverlay.test.ts`: "after `applied('T')` with Watch live, the notice shows while stale > 0 and goes at 0; M during it returns to the map and hides the notice" (the fake's stale driven through the counts passed to `tick`); "the readout: stale 12 of 349 → `Regenerating 12 / 349` in the slot; stale 0 → none" (unless the readout is skipped); "`route` gets the tool's notices on opening in full, null on close, on a switch to split and on `dispose`".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the stale count, Watch live's notice, Undo and Redo, notices over the map` (`git add` the files above).

---

### Task 21: Zero allocation: SP4c's frame additions

**Files:**
- Modify: `test/unit/zeroAlloc.test.ts` (the frame-step case :402)

**Interfaces:**
- Measures as SP4b's (no gc between readings, `v8.GCProfiler`, 3 attempts). The frame step's deps add a real apply control at rest (nothing configured since the last Apply), `afterCounts` calling `setAuxPolicy` on a real pool with unchanged values, the owner check, and in split shown `overlay.tick(counts)` calling `tool.setPlayer` (a fake `MapCanvas` over the real `arrowMoved`) at a fixed camera.

- [ ] **Step 1: Write the tests.** "10,000 frame steps at rest with SP4c's additions, the map hidden, grow the heap by less than the boxing budget of 256 B per tick"; "the same with the map shown in split mode (the arrow updated every rendered frame)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/zeroAlloc.test.ts`. Expected: PASS on Tasks 15-20's code; if it fails, find the allocation, fix it in its module with a unit test, rerun.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(ui): zero allocation for SP4c's frame additions` (`git add test/unit/zeroAlloc.test.ts` and any fixed module).

---

### Task 22: R7's Apply part: `apply.metric.ts` and its row (first CI run)

**Files:**
- Create: `test/metrics/apply.metric.ts`
- Modify: `test/thresholds.ts` (R7 :88), `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs` (`terrain` :19 gains `apply.metric.ts`), `test/unit/shards.test.ts` (:37's pin), the SP4c spec's Threshold log, `test/arch/masterSpec.test.ts` (`:851-853` moved)
- Master: §6.4's R7 row (spec §12)

**Interfaces:**
- Row: `R7.applyPartialColumnFrames: { max: 0, activeFrom: 'SP4c' }`, `R7.mixedEpochFrames: { max: 0, activeFrom: 'SP4c' }`, every tier; `partialColumnFrames` unchanged.
- `metricTest('R7', ['applyPartialColumnFrames', 'mixedEpochFrames'], …, { outName: 'R7.apply' })` (spec §8.1, D21; one call, so each part is covered once, `test/harness/metric.ts:164-176`):
  - **the run:** SP4b's harness (`stream.metric.ts:277`: a shared store, `createWorkerPool(2, inProcessWorker)`, the real coordinator and throttle, each section renderer in turn without a GL context, a fake clock of 0.05 ms per uploaded row and 16 ms per frame), plus `openMapSession` (seed 42, default profile), the real driver over a replaying canvas with no preview wanted, the real apply control and `createEpochs` on the same fake clock; a frame = `apply.tick`, `update`, one event-loop turn, `pump`, the store's `drain()`, `probe` (as SP4b's frame, `stream.metric.ts:189-197`); RD 6 on quick and full, RD 4 on fast;
  - **the script** (quick and full): E0 the first entry at the spawn until `firstFill`, its reveal, 20 idle frames; E1 one gesture setting `density.detailAmpHi` 2.0, 3.0 and 4.0 on three consecutive frames, then its end, until every MESH-set column shows the applied epoch; E2 undo, until every column is back at epoch 1; E3 one gesture setting 2.0 then 1.5 (the applied value), its end, then 60 frames; E4 a teleport 640 columns east (10,240 blocks) until the disc refills. **Fast:** E0, E1 and E4 only;
  - **parts:** `applyPartialColumnFrames` = frames over E1-E4 in which a shown column has some but not all of a payload's non-empty rows visible; `mixedEpochFrames` = frames over E1-E4 in which a column shows rows of two seqs (the probe's `partial` and `mixed`).
- Asserted each run: every issued world job's `generation()` is an applied or adopted one (the driver's latest-wins slot normally never configures E1's middle draft, so drafts are not named); `staleReveals` 0 (no payload staged before an Apply frame is revealed after it, through `onColumnRevealed`); E3 frees and stages nothing; the first 16 T after E4 nearest-first; no fatal, skipped or StoreFull event; after unloading everything, every pool slot free once the limbo drains (bounded 5 s).
- Recorded (`Record<string, number>`): frames per leg, swaps, frees, `applyFirstSwapFrames` (the Apply to the first swap within 2 columns of the camera), `applyFullFrames`, `teleportFirstRevealFrames`, structural operations, rows per pump max, release rows per pump max (asserted ≤ 16 while uploads wait), `dropped`.

- [ ] **Step 1: Write the metric and the row in one go** (a part activates at once in a started SP, spec §10). SP4c describe: "§6.4's R7 row names the Apply part and THRESHOLDS holds it": the row contains `and a terrain Apply (SP4c: \`applyPartialColumnFrames\` and \`mixedEpochFrames\`, from the Apply metric's scripted edits and teleport in Node)` and `| 0 (the flight part SP4b, the Apply part SP4c) |`; `Object.keys(THRESHOLDS.R7)` equals `['partialColumnFrames', 'applyPartialColumnFrames', 'mixedEpochFrames']` with the two new parts `{ max: 0, activeFrom: 'SP4c' }` (SP4b's `:851-853` removed). `shards.test.ts:37`: `terrain` lists `test/metrics/terrain.metric.ts` and `test/metrics/apply.metric.ts`.
- [ ] **Step 2: Run** `npx vitest run --project metrics-fast test/metrics/apply.metric.ts`, then `npx vitest run --project metrics-quick test/metrics/apply.metric.ts`. Expected: PASS, both parts 0 (about 8-10 s fast, 25-35 s quick, spec §8.1's cost).
- [ ] **Step 3: Govern.** `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP4c Task 22: R7 applyPartialColumnFrames max 0 and mixedEpochFrames max 0, gated from SP4c on every tier (apply.metric.ts, R7.apply; spec §8.1-§8.2); new parts.` Master §6.4's R7 row as spec §12 words it.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then `node .github/scripts/metricShards.mjs check`. Expected: PASS; `shards cover the 15 metrics-quick files exactly once`.
- [ ] **Step 5: Commit** `test(metrics): R7's Apply part, no partial or mixed column through an Apply` (`git add` the files above).
- [ ] **Step 6: The controller pushes the branch** (`git push -u origin sp4c/map-in-world`), waits for the run (`gh run watch`), and records every job's time against spec §9 under `## Exit evidence` as "### The first SP4c CI run (Task 22)". `metrics-fast` above 158 s: the fast tier drops to E1 alone first; `unit (rest)` above 158 s: `coordinator.test.ts` moves into `heavy`. Commit `docs(sp4c): the first CI run`.

---

### Task 23: Integration: `apply.test.ts`

**Files:**
- Create: `test/integration/apply.test.ts`
- Modify: `test/arch/masterSpec.test.ts`
- Master: §1's `test/` entry (spec §12)

**Interfaces:**
- Two Node workers from `buildNodeTaskWorker('apply')` (Spec corrections) on one shared store, the real coordinator, pool, driver and apply control, RD 4 around seed 42's spawn; each check compares the inner region's `litRegionHash` with `genRegion`'s on the same params (`test/harness/region.ts:153`), as `integration/streaming.test.ts:143-216`. Its recording sink implements `unstage` (it stages and shows at once, so it returns false), and its "staged twice" check (`streaming.test.ts:168`) becomes "staged at most once per `coordinator.counts(out).epoch`".

- [ ] **Step 1: Write the test** (one file, its cases in order on one store, about 20-25 s):
  - "after the first fill, the inner region equals `genRegion`";
  - "a terrain Apply (`density.detailAmpHi` 4.0) through the real driver and apply control: equal on the new params";
  - "its undo: equal on the original";
  - **"an undo in the middle of a regeneration"**: a second Apply of 4.0, the undo after the first k swaps (k = ⌈69 / 4⌉ = 18, counted as the recording sink's `stage` calls of a column it already holds, after the second Apply), so kept original columns sit beside freed and rebuilt ones: equal on the original (D5's kept-column path on the real store; Review Focus 1);
  - **"a climate Apply"** (`climate.C`'s wavelength 2400 → 1200, continentalness): equal on its params;
  - **"a biome-table climate limit"** (one `biomes.table` row's temperature bound moved): equal on its params;
  - **D7 on the real store:** "a wrapper around the worker holds one D's OK reply after the D committed; a configure is issued and adopted (equal genKey); the reply is then delivered: the column is Decorated in the table and its L runs and succeeds on the real store" (today's requeue would make the next `reopenColumn` throw, `store.ts:108-113`);
  - "after unloading everything and draining the limbo, every pool slot is free".
  - SP4c describe: the `test/` entry contains `(SP4c: metrics/apply.metric.ts, integration/apply.test.ts)` and both files exist.
- [ ] **Step 2: Run** `npx vitest run --project integration test/integration/apply.test.ts`. Expected: PASS (about 20-25 s); a failure is a coordinator or pool bug, fixed in its module with a unit test.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(integration): Apply, undo, climate and biome edits equal genRegion` (`git add test/integration/apply.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-25-sp4c-map-in-world-design.md`).

---

### Task 24: Browser smoke: `overlay`, `overlay-mesh`, the leak checks; the map latency re-run

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` :449-453), `test/unit/uiSmoke.test.ts` (:240-245), `src/main.ts` and `src/ui/world/worldPage.ts` (the test hook)

**Interfaces:**
- **(plan)** `?wiTest=1` installs, before the page mounts, `window.__wiTest = { listenerCount(): number /* the session's */; timers(): number /* pending setTimeout/setInterval through counting wrappers */; tileRequests(): number; closeOverlay(): void; disposeTool(): void; forceFatal(): void; owner(): string; stale(): number; lastLanding(): { readonly surface: number; readonly water: number | null; readonly y: number } | null }` (`lastLanding`: recorded from the landing the page's teleport `onArrive` receives, Task 17; `water` null for −∞, which CDP's `returnByValue` cannot carry); absent without the flag.
- Steps `overlay` and `overlay-mesh` after `stream` (one `t.step` each; the runner refuses a repeated id), on `/?rd=4&renderer=batch&wiTest=1` and `…=mesh`, as spec §8.6. Each overlay step first sends `Emulation.setDeviceMetricsOverride` `{ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }` (step 4's resize sends 1,600 × 1080) and puts `VIEWPORT` back at the step's end, as `density narrow` does (`uiSmoke.ts:1549`, `:1571`); `VIEWPORT` (1400 × 900, `:105`) and `--window-size` stay unchanged; `review-overlay-*.png` is captured at 1920 × 1080. The leak check runs on the baseline's document, before the reload:
  1. **baseline:** after the reveal, before the first M: CDP `DOMDebugger.getEventListeners` on `window` and `document`, `listenerCount()`, `timers()`;
  2. **M:** the overlay visible, exactly one `canvas[data-renderer]` (GOV-8), the arrow drawn at the camera, tiles drawn within 5 s without any edit (the replayed source, Spec corrections); the Density tab's slice draws without an edit (the tool's draft log seeded at mount, Task 12);
  3. **teleport:** a click 300 px east of the arrow: the camera's x and z within 1 block of the clicked point; `lastLanding().y` equals `min(400, max(surface, water ?? -Infinity) + 24)` (24 and 400 as literals in `uiSmoke.ts`, pinned by `uiSmoke.test.ts` against `teleport.ts`) and the HUD's y matches it within its display rounding; the map closed in full mode, the search's `at` rewritten; after the click the HUD's revealed count falls below its pre-click value (the old place removed), then grows above the lowest value read after the click, within 10 s (at RD 4 the disc is already full before the click);
  4. **split:** the 3D canvas half the window's width ± 2 px, the setting stored; at the 960 px half the panel sits beside the map; after resizing the window to 1,600 px the half is 800 px and the panel stacks under the map (the container query);
  5. **edits:** a typed `density.detailAmpHi`; Ctrl+Z; a typed continentalness wavelength (`climate.C`); a biome-table temperature bound: each `stale()` above 0, then 0 within 30 s, no page error; then M closes the map and Ctrl+Y from the 3D redoes live (`stale()` above 0, then 0; `Redo` in `.world-notices`), and M reopens it (spec §2.4: undo and redo work from the 3D);
  6. **the lock:** a click on the 3D half asks for the pointer lock; granted: W moves the camera with the map open, Esc gives the controls back with the drawer still open; refused: skipped with the reason logged (the headful production check covers it, §14);
  7. **leak check** (the baseline's document): the overlay closed and the tool disposed through the hook: the listeners, `listenerCount()` and `timers()` equal the baseline; `tileRequests()` unchanged over 1 s after `hide` and after `dispose`;
  8. **reload:** split and the edited values kept (the URL follows the session);
  9. **failure with the map open**, on the reloaded page (a fresh tool; no planned API remounts a disposed one): M (it opens split, the stored mode), the header's "Full screen" (the stored mode becomes full), `forceFatal()`: the overlay closed, the failure panel visible with "Copy details", no page error after it.
- `overlay-mesh` (the same Chrome profile, so the stored mode is remembered) switches to full through the header after its M if the stored mode is split, then repeats 2, 3 (the map closed on arrival) and the terrain Apply of 5. The driver's `lastLatencyMs` in split during an Apply is printed, read from the tool's toolbar status text (`last edit → preview N ms`; no hook needed; information only; SwiftShader does not decide the cut line, §6.4). `--shots` writes `review-overlay-full.png` and `review-overlay-split.png`. About 75-90 s more.

- [ ] **Step 1: Write the tests.** `uiSmoke.test.ts:240-245`: the list gains `overlay` and `overlay-mesh` between `stream` and `console`; the pin `stream` = console − 1 (`:245`) replaced by `overlay` = `stream` + 1 and `overlay-mesh` = console − 1; the smoke's landing literals (24, 400) equal `teleport.ts`'s `LANDING_ABOVE` and `LANDING_MAX_Y`; the title names SP4c's steps; a pure parser of the HUD's `stale (\d+) / (\d+)` line.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` (its own port, its own Chrome profile), then `node test/tools/mapLatency.ts --profile-dir "$(mktemp -d /tmp/wi10-XXXX)" --out docs/superpowers/specs/assets/sp4c` (about 35 min; on the two-lane pool, spec §1.4; without `--out` it overwrites SP2b's committed `assets/sp2b/latency-*.json`, `mapLatency.ts:52`, `:621`). Expected: every step passes on both renderers; mapLatency within SP2b's gate (≤ 300 ms per edit, drag landings ≤ 500 ms apart); `git status` shows no change under `assets/sp2b` (if it does, `git checkout -- docs/superpowers/specs/assets/sp2b`). Copy the two overlay shots into `docs/superpowers/specs/assets/sp4c/`.
- [ ] **Step 5: Commit** `test(ui): the overlay smoke steps with leak checks on both renderers` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts src/main.ts src/ui/world/worldPage.ts docs/superpowers/specs/assets/sp4c/review-overlay-full.png docs/superpowers/specs/assets/sp4c/review-overlay-split.png docs/superpowers/specs/assets/sp4c/latency-biome.json docs/superpowers/specs/assets/sp4c/latency-relief.json docs/superpowers/specs/assets/sp4c/latency-offset.json`).

---

### Task 25: The bench's live legs; `measureChrome` → `assets/sp4c`

**Files:**
- Modify: `src/ui/world/bench.ts` (`BenchLeg` :45-58, `BENCH_FRAME_CAPACITY` :43, `BenchResult` :374, `summarizeBench` :488, `BENCH_SHOTS` :589, the shot times), `src/ui/world/worldPage.ts` (the bench branch: a driver with no canvas and the preview not wanted, the apply control, `createTeleport`), `test/tools/measureChrome.ts` (`ASSETS` :63, `SHOTS` :65), tests `test/unit/bench.test.ts`, `test/unit/measureChrome.test.ts`, the SP4c spec (Spec corrections: `BENCH_FRAME_CAPACITY`)

**Interfaces:**
- Produces (spec §8.4, D22, D24):
  - `BENCH_FRAME_CAPACITY = 49152` (Spec corrections);
  - `BENCH_LIVE = { edit: { path: 'density.detailAmpHi', from: 1.5, to: 4.0 }, maxS: { L7: 20, L8: 20, L9: 15 }, teleportEast: 20000 }`; the live legs run after L6 at y 150, pitch −15, through the page's loop: L7 sets the leaf to 4.0 (urgent), until every RD 12 MESH-set column was revealed since the Apply or 20 s; L8 undo, the same; L9 `teleport.go(x + 20000, z)`, until the RD 12 disc is filled or 15 s; the record's `leg` is 7-9;
  - **(plan)** how the bench driver runs the live legs (today a pure time script: `pose` writes x/z/y from a fixed timeline, `bench.ts:713-718`, and the shots freeze at fixed `SHOT_AT` times, `:598`, `:655`): `BenchLeg.name` gains `L7 | L8 | L9` (`seconds` = the cap: 20, 20, 15). `BenchWorld` gains `live: { set(path: string, v: number): void; undo(): void; teleport(x: number, z: number): Promise<boolean>; settled(leg: 7 | 8 | 9): boolean }`. After L6 the script runs live: L7 calls `set` at its start, L8 `undo`, L9 `teleport(start.x + 20000, start.z)`. Each live leg ends when `settled(leg)` holds or at its cap. In L7-L9 `pose` keeps x/z (and, after L9's arrival, the teleport's y), sets only pitch −15 and y 150 before L9, and records the leg. The script ends after L9 rather than at `BENCH_SECONDS` (95 s still bounds L0-L6). The shots `apply-before` (L7 − 0.5 s) and `apply-mid` (L7 + 1 s) are timed from L7's actual start; `apply-after` (L7's end) and `teleport` (L9's arrival + 0.3 s) freeze on those events, as `rd12back` does;
  - **(plan)** "shows the new epoch" is read through `sections.onColumnRevealed` into a preallocated per-column stamp over a 25 × 25 window around the camera (every payload revealed after an Apply frame is the new epoch's, `staleReveals` 0 in R7);
  - `BenchResult.live: StreamFigures & { applyFirstSwapMs; applyNearMs; applyFullMs; undoFirstSwapMs; undoNearMs; undoFullMs; teleportFirstRevealMs; teleportRefillMs; width; height; timedOut }`, SP4b's nested fields (`bench.ts:346`), so `live.frames.{p50,p95,p99,max,over33}`, `live.drawCalls`, `live.gpuMB`: SP4b's frame fields over L7-L9 (p50, p95, p99, max, `over33`, main thread, upload and coordinator ms, structural frames with `stutterMs`, draw calls, `gpuMB` and its breakdown, `partialColumnFrames`, `mixedColumnFrames`) and `applyFirstSwapMs`, `applyNearMs` (the 69-column RD 4 disc), `applyFullMs`, `undoFirstSwapMs`, `undoNearMs`, `undoFullMs`, `teleportFirstRevealMs` (within 2 columns), `teleportRefillMs`, and the canvas's `width` and `height`; **(plan)** a time its leg's cap cut short is null and `live.timedOut: string[]` names the leg (a null D24 time fails the exit check);
  - the bench page builds the same pieces as the world page, without a map: the driver over an unattached replaying canvas with the preview not wanted, `createEpochs`, the apply control (its `onApplied` stamps the Apply frame), `createTeleport` over the bench's pool; the stored settings stay unread (SP4b);
  - `BENCH_SHOTS` gains `apply-before` (L7 − 0.5 s), `apply-mid` (L7 + 1 s), `apply-after` (L7's end), `teleport` (L9 + 0.3 s); measureChrome's mirror the same; `ASSETS = 'docs/superpowers/specs/assets/sp4c'` (every route; SP4a's and SP4b's files stay).

- [ ] **Step 1: Write the tests.**
  - `bench.test.ts`:
    - "`summarizeBench` over a synthetic record with legs 7-9 has every `live` key, and SP4b's `stream` block still covers L1-L6 only";
    - "`applyNearMs` is the time from L7's Apply frame to the frame the 69th RD 4 disc column was revealed; `applyFirstSwapMs` to the first within 2 columns; `applyFullMs` to the last MESH-set column";
    - "a leg that hits its cap (20 s) records its time-outs as null and `live.timedOut` lists it";
    - "the capacity holds 150 s at 240 Hz (36,000 frames)";
    - "L9 asks the teleport for x + 20,000 at the same z";
    - "`live.frames.over33` counts a snapped 33.3 ms frame at 240 Hz and not a 29.2 ms one" (SP4b's rule over the live frames).
  - `measureChrome.test.ts`: the shots list mirrors `BENCH_SHOTS`; `outputName` for `--shot apply-mid --renderer mesh` is `review-apply-mid-mesh.png`; `ASSETS` ends `assets/sp4c`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `CLAUDE.md`'s `measure:chrome` line: `assets/sp4c` since SP4c.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; then, on a quiet machine, `npm run measure:chrome -- --route bench --gpu iris --probe-only`. Expected: PASS; the probe prints the Iris renderer (or refuses under 'nvidia', the cue for Task 26's stop).
- [ ] **Step 5: Commit** `feat(ui): the bench's Apply, undo and teleport legs` (`git add` the files above and `CLAUDE.md`).

---

### Task 26: GPU cells (Chrome, agent): the bench files, G1's live rows, the review shots

**STOP for the user before Step 1:** PRIME on **on-demand** (the user switches it; the logout ends the session, resumed with `claude --resume`), the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp4c/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `bench-rtx-chrome.json` (and any `-tune<k>` files), `review-apply-{before,mid,after}-{batch,mesh}.png`, `review-teleport-{batch,mesh}.png`
- Modify: `test/thresholds.ts` (G1), `test/thresholds.lock.json` (generated), `test/metrics/g1.metric.ts` (`ASSETS_SP4C` for `GATED` and the streaming call's files; a third call), the SP4c spec's Threshold log, master §6.4's G1 and G2 rows and §7's Apply line, `test/arch/masterSpec.test.ts`

**Interfaces:**
- Rows: `G1.mediumLiveP95: { max: 16.7, activeFrom: 'SP4c' }`, `mediumLiveOver33: { max: 0, … }`, `mediumLiveGpuMB: { max: 150, … }`; SP4a's and SP4b's parts unchanged, re-read from `assets/sp4c/`.
- `metricTest('G1', ['mediumLiveP95', 'mediumLiveOver33', 'mediumLiveGpuMB'], …, { outName: 'G1.live' })` reads `bench-iris-chrome.json`'s `live` (shape: route `bench=medium`, /Iris/, `batch`, rd 12, `shaderCache: 'cold'`, every structural frame's `stutterMs` ≤ 33, `partialColumnFrames` and `mixedColumnFrames` 0) and returns `live.frames.p95`, `live.frames.over33`, `live.gpuMB`; the RTX file recorded in `.out/G1.live.others.json`.
- `checkBench`'s structural-frame assertion (`g1.metric.ts:150-152`, today over every entry, and `structuralFrames` covers every frame, `bench.ts:533-548`) filters to SP4b's legs (`leg` L0-L6), so the re-asserted SP4b cells stay as they were; `G1.live` asserts `stutterMs` ≤ 33 on the L7-L9 structural frames of `bench-iris-chrome.json` only; the w4 file's live legs are recorded, not gated (spec §8.4).

- [ ] **Step 1: Measure** (an agent, quiet machine, cold shader cache, touching no other process), each about 3 minutes:
  - `npm run measure:chrome -- --route bench --gpu iris` → `bench-iris-chrome.json` (the gated file);
  - `npm run measure:chrome -- --route bench --gpu iris --workers 4` → `bench-iris-chrome-w4.json` (SP4b's `mediumFill4wMs`);
  - `npm run measure:chrome -- --route flight --gpu iris` → `flight-iris-chrome.json` (SP4a's static cells on SP4c's code);
  - `npm run measure:chrome -- --route bench --gpu rtx` → `bench-rtx-chrome.json` (offload and ANGLE Vulkan, P59/P60; if the probe refuses, **STOP**: the user switches to 'nvidia', the controller resumes with `claude --resume` and re-runs this cell, then the user switches back to on-demand before Step 2b).
- [ ] **Step 2: Check and tune.**
  - Gated (§8.2): `live.frames.p95` ≤ 16.7, `live.frames.over33` 0 with every structural frame's `stutterMs` ≤ 33, `live.gpuMB` ≤ 150; SP4b's six streaming parts and SP4a's three static parts still within their rows.
  - Exit checks (D24, recorded, not rows): `applyNearMs` and `undoNearMs` ≤ 2,000 ms, `teleportFirstRevealMs` ≤ 500 ms; `applyFullMs`, `undoFullMs`, `teleportRefillMs` recorded; `applyFirstSwapMs` recorded against G2's 500 ms for SP10; the RTX file's `live.frames.over33` 0 and `live.frames.p95` ≤ 16.7; `partialColumnFrames` and `mixedColumnFrames` 0 in every file.
  - A miss: §8.4's levers in order (row cap 32 → 16, structural operations only in rowless frames, growth over two frames, larger reservations, the release share of §5.4), re-measured after each, committed as `bench-<gpu>-chrome-tune<k>.json`. **Still missing: STOP** and report every JSON for the user; no gate is loosened.
- [ ] **Step 2b: Review shots** (after the tuning, under on-demand): `npm run measure:chrome -- --route bench --gpu iris --shot <name> --renderer batch|mesh` for `apply-before`, `apply-mid`, `apply-after`, `teleport`; the first confirms exactly one `canvas[data-renderer]` (GOV-8).
- [ ] **Step 3: Rows, the metric's third call, the re-pointed reads and the artifacts in one commit.** SP4c describe: "§6.4's G1 row names the live parts THRESHOLDS holds activeFrom SP4c" (the row contains `SP4c gates the Medium live cells (p95, no frame > 33 ms, GPU estimate) over the bench's Apply, undo and teleport legs, and re-asserts SP4a's and SP4b's cells on SP4c's code`); G2 contains `(SP4c records the Apply part from the bench; SP10 gates it)`; §7's line contains `(recorded from SP4c's bench; gated by SP10)`. `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP4c Task 26: G1 mediumLiveP95 max 16.7, mediumLiveOver33 max 0 and mediumLiveGpuMB max 150, gated from SP4c on every tier from assets/sp4c/bench-iris-chrome.json (g1.metric.ts, G1.live; spec §8.2, §8.4, D22); SP4a's and SP4b's cells re-read from assets/sp4c; new parts (measured <p95> / <over33> / <MB> on eDP-1 at 240 Hz).`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with G1, G1.streaming and G1.live asserted.
- [ ] **Step 5: Commit** `feat(sp4c): the Chrome bench cells and G1's live rows` (the JSON and PNG files staged by explicit path, with the files above).

---

### Task 27: The user's Firefox run

This task is the controller's and the user's.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp4c/bench-iris-firefox.json` (required), `bench-rtx-firefox.json` (if sent)

- [ ] **Step 1: STOP for the user.** The controller runs `npm run build`, then its own `npx vite preview --port 4173 --strictPort` (stopped only by the controller), and gives the user `http://localhost:4173/?bench=medium` and `http://localhost:4173/?selftest=1`. Under on-demand the user runs the bench in Firefox on the Iris Xe (about 3 minutes; it ends with an edit, its undo and a teleport), downloads the JSON and runs the selftest (59/59). Optional: the user switches to 'nvidia' (the session ends; resumed with `claude --resume`; the controller restarts its own preview on 4173) and runs the RTX bench; then the user switches back to on-demand (another resume) before Task 30's Chrome check.
- [ ] **Step 2: Check** (spec §8.4, Point 2): the Iris Xe file's `live.frames.p95` ≤ 25, `live.frames.over33` 0, `live.drawCalls.max` ≤ 100, `partialColumnFrames` and `mixedColumnFrames` 0 in every block. A miss: §8.4's tuning (the Chrome cells re-measured too, Task 26 Step 2), then one more run asked of the user.
- [ ] **Step 3: Commit** `docs(sp4c): the Firefox bench files` (each file under the GPU the user names, staged by explicit path).

---

### Task 28: Whole-branch review

- [ ] **Step 1:** The controller runs the final review of `git diff main...sp4c/map-in-world` against the spec, this plan and Review Focus 1-5 (superpowers:requesting-code-review), the reviewer resolving its own cannot-verify items in the code at HEAD. Beyond the per-task reviews it checks what only the whole branch shows:
  - every `(plan)` decision above is in the code as written, or its change is recorded in the spec;
  - every Spec correction above is reworded in the spec;
  - every disposer the tool and the overlay add is reached from the world page's teardown and from the standalone shell (no leftover `session.subscribe`, timer or window listener);
  - SP4b's rules still hold: zero allocation at rest, the layers, `data-renderer` once, the throttle fed every tick, no golden diff;
  - the CI time against §9 (the first run, Task 22) and the masterSpec block's pins against spec §12's list.
- [ ] **Step 2:** Each finding is fixed test-first in its module, one commit each (`fix(sp4c): …`); a finding that would loosen a gate or change the spec goes to the user.
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:metrics`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`, and the smoke again. Expected: PASS; no golden diff.

---

### Task 29: Exit: evidence and docs

**Files:**
- Modify: the SP4c spec (`## Exit evidence`, Status), `CLAUDE.md` (`:9`; M and the two modes; the `overlay` smoke steps; `measure:chrome`'s `assets/sp4c`; the help's "Map (M)"), `README.md` (`:9`, an SP4c paragraph)

- [ ] **Step 1: Exit checks** (spec §14):
  - `npm run build && npm test && npm run test:metrics:full` (R7's both parts on every tier, `partialColumnFrames` still 0, every earlier metric unchanged);
  - `git diff main -- test/goldens.json` empty; `GENERATOR_VERSION` 5; `npx --yes bun@1 test/tools/goldensJsc.ts` 59/59; `?selftest=1` 59/59 in Chrome (the smoke) and in Firefox (Task 27);
  - `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` green (map, `stream`, `overlay`, `overlay-mesh`);
  - `npm run bench` within its gates and +30 %;
  - `grep -rn "mapHereHref\|Open the map here" src/` prints nothing.
- [ ] **Step 2: Exit evidence**, before the Threshold log: the first CI run (Task 22); every G1 cell with its file and the D24 exit checks; the RTX Chrome cell; the Firefox files; R7 per tier; the smoke's leak checks and the headless `lastLatencyMs` (information); mapLatency (`assets/sp4c/latency-{biome,relief,offset}.json`); the review shots described (`review-overlay-*`, `review-apply-*`, `review-teleport-*`); the masterSpec pins of 'master spec amendments (SP4c §12)'; whether the map's regeneration readout was built (Task 20) or skipped for time (§13; the master wording for both items is Task 30's).
- [ ] **Step 3:** Status "implemented, awaiting CI, the production check and the user's check"; `CLAUDE.md:9` and `README.md:9` the same.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(sp4c): exit evidence and docs` (`git add` the files above).

---

### Task 30: Merge, production check, the user's check, SP4c complete

**STOP for the user's go-ahead** before Step 1.

- [ ] **Step 1:** Merge `sp4c/map-in-world` to `main` and push; CI green, its wall time recorded in the exit evidence against §9's ≈ 3.0-3.2 min (above 3 min 30 s: SP4b's lever first, a slow file out of `metrics-fast` into its own job).
- [ ] **Step 2: Production, headful** (spec §14), on the deployed build:
  - **Chrome** (RegionBatch; the agent's own headful Chrome on the Iris Xe, its own profile; **STOP** until the user confirms PRIME on-demand and the display awake and unlocked, as before Task 26): the overlay opens, a teleport lands, an edit applies; in split a click takes the pointer lock and Esc releases it, and whether the Esc keydown reached the page is recorded; the in-world preview's `lastLatencyMs` in split during an Apply is recorded (it decides the cache, Step 3);
  - **Firefox** (RegionMesh; **STOP for the user**, in the user's own Firefox): the same overlay, teleport, edit and lock checks, the Esc keydown recorded; `?selftest=1` on production (59/59);
  - the controller commits `assets/sp4c/selftest-firefox.json` and `assets/sp4c/production-check.json` (`docs(sp4c): the production check`).
- [ ] **Step 3: The cut line** (Spec corrections): `lastLatencyMs` ≤ 500 ms and the user does not find the map slow in split → the climate-grid cache goes to SP10; else it is built now (on a branch from `main`, test-first, per SP2b :232, re-measured, then merged with the user's go-ahead). Master §10's cut line and receivers worded for both items in one pin (the cache by this step's decision, the readout by whether Task 20 built it, Task 29's evidence), pinned in the SP4c describe (as `:920-926` pin SP4b's).
- [ ] **Step 3b: STOP for the user's check:** some teleports and live editing in both modes, climate experiments among them (the last criterion).
- [ ] **Step 4:** After the user's verdict (a finding goes back test-first, with another go-ahead before it reaches `main`), a final commit marks SP4c complete (`CLAUDE.md:9`, `README.md:9`, the spec's Status, the cut-line pin): `docs: SP4c complete`.

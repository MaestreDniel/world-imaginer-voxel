# SP4b — Streaming, the world without an edge: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The world has no edge. After SP4a's first entry (start screen, loading screen, the whole RD revealed at once), the coordinator keeps loading the world around the camera while the user flies and unloads what is left behind, column by column behind the fog, with no stutter; flight is horizontal (Minecraft's creative flight); the render distance changes live. Before that, CI's unit tests run as two parallel shards. The generated world does not change.

**Architecture:**
- **CI.** `.github/scripts/shardLib.mjs` is the shard tool both tables share; `unitShards.mjs` splits the unit project into `heavy` and `rest`, which run as a `unit` matrix job beside `check` (build, arch, integration).
- **Store.** The column record gains a claim generation (int 12); versions stay monotone across claims; protoFlags bit 0 is the alive bit; every slot release goes through deferred reclamation (`world/store/reclaim.ts`: reader epochs per thread, a limbo list per thread); the pool lock word holds its owner and a dead owner is `StoreCorrupt`.
- **Workers.** Every job carries its configure generation (`epoch`) and its phase's epoch cell at issue (`scope`); `configure` stores the generation into the four cells; `bumpScope` exists for SP4c. Each world job runs inside a read section; L resets its light first; `T(protoOnly)` regenerates a freed proto through `reopenProto`.
- **Coordinator.** `engine/coordinator.ts` becomes a per-frame `update(camera)`: a 4,096-entry per-torus-slot table, needed and retained sets from per-RD membership tables, four heaps keyed by `core/streamScore.ts` with the view term, reader pins, unload hysteresis, record collisions, cancellation, errors after the reveal, the adaptive throttle, proto retention. The first entry runs on it with reveals held.
- **Rendering.** `SectionRenderer` streams: `stage` / `remove` / `pump(gate, …)` / `holdReveals` / `revealAll`, under an `UploadGate` (2 ms, 32 rows, one structural operation per frame). RegionBatch reserves per region and pass and carries region-local instance matrices; RegionMesh keeps an arena per region and pass with column ranges hidden by degenerate indices until the reveal frame.
- **Page.** The frame step (`ui/world/frameStep.ts`) runs input and the coordinator every rAF and pumps, rebases, drains and renders on rendered frames; live RD eases the fog outward.
- **Measurement.** R7 is a deterministic Node metric (`test/metrics/stream.metric.ts`); `?bench=medium` is a 95 s streaming route measured by `measureChrome.ts --route bench` (agents, Chrome) and by the user (Firefox); G1's streaming cells gate the committed Iris Xe Chrome files.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`), three r186 (`~0.186.1`), Chrome 155 over CDP for the browser tools, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-sp4b-streaming-design.md` (approved 2026-10-23; the binding authority). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Maps behind the spec: `.superpowers/sp4b/map-{code,master,tests}.md` (git-ignored; the controller has them). Template: the SP4a plan.

**Plan form.** Compact, as SP4a's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies; the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` 8ce64f6 (code identical to 7832727).

**Spec corrections found while planning** (each folded in by the task named; the controller rewords the spec in that task's commit):
- **`core/` cannot compute the view term from a yaw** (§3.3). `core/` follows the Math allowlist (`test/arch/rules/banned.ts:10-11`, `:199-205`: no `Math.sin`, `Math.cos`, `Math.hypot`, no `**`). So `streamScore` takes the forward unit vector `(fx, fz)` the caller computed from the yaw, and `d_h` through `Math.sqrt`. Task 10.
- **The store id cannot be random** (§2.5, §2.8). `world/` is a non-deterministic-API-free layer (`banned.ts:191-192`: no `Math.random`). The id is a per-thread counter starting at 1 (the store is created on one thread, and only stores of that thread are ever attached to its workers). Task 5.
- **`attachPool(h, thread)` cannot see the dead-owner mask** (§2.6): the mask lives in the reclaim buffer. `attachPool` takes `owner?: { thread; dead }`. Task 6.
- **`heightAt`'s "−1 when not Published"** (§2.4, §12.2) collides with a real height (heightmaps hold `y + 1`, −64 … 320, `api.ts:8`). `heightAt` returns `null` when the column is not Published; `lightAt` keeps −1 (a light byte is 0-255). §12.2's "`store.heightAt`'s −1" is reworded. Task 4.
- **RegionBatch's index is Uint16 below 65,536 vertices** (`BatchedMesh.js:400-405`): the translucent (16,384) and cutout (8,192) reservations get a Uint16 index, so `gpuBytes()` sums the arrays' `byteLength`, never `4 · indices`. Task 16.
- **The help's RD control is a `<select>`** (`#setting-rd`, `ui/help.ts:65-79`), not a slider (§5, §7.5). Task 22.
- **The fog's filled radius needs a reveal query** (§5): the scan over `discOffsets` lives in `ui` (render may not import `engine/rings.ts`), so `SectionRenderer` gains `isRevealed(cx, cz): boolean`. Task 16.
- **The ready queue's centre** (§3.9: "from the camera's column and yaw at the last rebuild"): `CoordinatorCounts` carries the last rebuild's `cx`, `cz` and `yawDeg`, which the page passes to `pump`. Task 11.
- **`lowerRd` moves to `engine/renderDistance.ts`** (the coordinator raises "Lower to RD n", §3.6; engine may not import `ui/world/frameNotice.ts`, where it lives today). Task 12.
- **The throttle is fed every rAF tick** (§7.2 puts "the throttle fed the previous frame's time" in step 5, which the FPS limiter skips on frames it does not render; §3.8 "each frame's snapped frame time"): it is fed the snapped raw delta of every tick, before the limiter, so an FPS cap never reads as slow frames and never starves generation (Review Focus 1). §7.2 and §3.8 are reworded. Task 21.
- **A heap-growth bound read after a gc sees only retention** (§8.5, D25): `terrainHeap.test.ts`'s double `gc()` before every reading collects the short-lived per-call objects D25 bans. The zero-allocation tests read the heap after the calls with no gc in between (`v8.GCProfiler` confirms none ran), and both run 10,000 calls (§8.5's 1,000 frames become 10,000), so the 256 KB bound means under 26 B per call or frame step, as §8.5 intends. Task 23.
- **The review shots need a GPU** (§8.7): headless SwiftShader cannot run the 96 and 384 blocks/s legs at a real frame rate, so the streaming state at the shot times would not be the user's. The shots are taken through `measureChrome.ts --route bench --gpu iris --shot <name> --renderer batch|mesh` in the agent's headful Chrome on the Iris Xe, under the on-demand profile with the user's display awake. §8.7 is reworded. Task 26 (the tool), Task 27 (the shots).

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin. A `.mjs` module a TS test imports gets a sibling `.d.mts` (the test tsconfig has no `allowJs`).
  - **No new dependencies.**
- **Layers** (`test/arch/rules/imports.ts`):
  - three only in `render/`; `render/materials/**` imported only from `render/`; GLSL only in `render/materials/**/*.glsl.ts`;
  - `render` value-imports core, world, light, mesh, textures, daynight, render and `workers/protocol.ts`, **never engine** (`imports.ts:29`): `UploadGate` is declared in `render/sectionRenderer.ts` and engine's budget satisfies it structurally;
  - `engine` value-imports core, world, engine and `workers/protocol.ts` (`imports.ts:28`), never render or ui (hence `lowerRd` moves to `engine/renderDistance.ts`);
  - `player` value-imports core, world, daynight, player, `workers/protocol.ts`; `ui` and `main` anything but `render/materials/**` and `*.worker.ts`; only `engine/` spawns workers.
- **Pure and deterministic layers.** `core/` follows the Math allowlist (`abs floor ceil round trunc sign min max imul clz32 sqrt` and the constants; no `**`); `core/`, `world/`, `gen/` and `DET_FILES` (incl. `metrics/region.ts`) use no `Math.random`, `Date.now`, `performance.now`, `console.*`; pure layers no DOM globals; `gen/**` exports no numeric constants.
- **The generated world does not change.** `GENERATOR_VERSION` stays 5; `test/goldens.json` (59 goldens), `test/stateIds.lock.json` and `test/schema-shape.lock.json` stay byte-identical. Tasks 3-9, 13 and 14 touch the store, the workers, gen or the mesher: each runs `npm run test:goldens`, then `git diff --exit-code main -- test/goldens.json`; if the run rewrote anything, restore with `git checkout main -- test/goldens.json` and find the bug.
- **Governance.**
  - `test/thresholds.lock.json` changes only in Task 1 (`startedSps`), Task 25 (R7) and Task 27 (G1's streaming parts), always through `npm run test:accept-thresholds`; each such commit adds one line to the SP4b spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`). Every new part is new (a tightening); no gate is loosened.
  - `test/baselines.json` does not change (Task 14 checks the bench against it).
  - Master amendments land with what they describe (spec §11, §13); each task lists its own and the `masterSpec.test.ts` pin it adds to `describe('master spec amendments (SP4b §13)')`.
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit.
- **GPU measurements** (spec §8.4):
  - **Chrome cells** are an agent's, through `npm run measure:chrome`, on the user's laptop: the laptop panel eDP-1 at 240 Hz, the user's display awake and unlocked (a locked session invalidates frame times), a quiet machine (the tool refuses above a 1-minute load of 2). The Iris Xe cells need the PRIME **on-demand** profile, which only the user switches (log out and in); the RTX 3060 Mobile cells run under on-demand through the NVIDIA offload variables and ANGLE's Vulkan backend, as SP4a's rulings P59/P60 (`launchEnv`, `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE`).
  - **Firefox cells** are the user's, by hand, on a local `vite preview` the controller serves (the Vercel preview is behind SSO): the Iris Xe under on-demand, the RTX under the **'nvidia'** profile. The controller commits each JSON under the GPU the user names.
  - **Where the plan stops for the user:** before Task 27 (switch to on-demand, display awake, eDP-1 at 240 Hz); a G1 streaming part, a structural frame over 33 ms or the RTX Chrome cell still missing after §8.4's tuning (Task 27); Task 28's Firefox cells and the 'nvidia' switch; a Firefox cell outside D28's check; the merge, the production check and the user's own check (Task 28).
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and every preview the controller serves runs on its own free port (**never 5183**, the user's compose service) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never open, close or touch the user's own browsers.
- **Outward-facing actions.** Pushing the branch is the controller's call (Task 2 pushes it to run the sharded CI). Merging to `main`, pushing `main` and the production check happen in Task 28, after the user's go-ahead.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways a person flying the streaming world would see it break, most likely first; each names the test that pins it and the task that owns it.

1. **An FPS cap starves generation.** The user caps at 30 fps on a 60 Hz display (SP4a's setting). If the throttle is fed the rendered-frame interval (33.3 ms), its p95 sits above 16.7 ms whenever generation runs, `genCap` falls to 1 and stays there: terrain fills at a quarter of the speed with no visible cause. A person expects the cap to cost frames, not terrain. **(plan)** the throttle is fed the snapped raw rAF delta of every tick, before the limiter, as the slow-frame notice is (`createFrameClock`). Task 21 pins "with the FPS cap at 30 and 16.667 ms rAF ticks for 600 ticks with generation in flight, the throttle is fed 16.667 ms on every tick and `genCap` stays at its maximum".
2. **Flying across north.** The yaw wraps at 360° (`fly.ts:35-38`). A naive `|yaw − lastYaw| > 30` sees a 10° turn from 355° to 5° as 350° and rebuilds every crossing of north; the wrong sign can also miss a real turn. Task 11 pins "a turn from 355° to 5° counts 10° (no rebuild); 350° → 25° counts 35° (a rebuild); 10° → 340° counts 30° (no rebuild: the bound is strict)".
3. **Flying a long way west or south.** Negative and large coordinates (the world is ±31,250 columns): `& 63`, `>> 3` and the window formula `c = camC + ((s − camC + 32) & 63) − 32` must hold there, and the floating origin rebases far from 0. Task 11 pins "a fill around column (−31,249, −31,249) at RD 4 issues exactly 213 / 157 / 109 / 69 jobs and classifies every slot as around (0, 0)"; Task 16 pins "column (−31,249, −31,249) is in region (−3,907, −3,907), whose batch or mesh position with the origin at (−499,712, 0, −499,712) is (−384, −64, −384)".
4. **Spinning the view while terrain loads.** Turning more than 30° every frame rebuilds the heaps every frame while jobs are in flight; a rebuild that re-pushes a busy column issues the same job twice (a double claim: `SlotBusy`, or a wasted MESH). Task 11 pins "rotating the yaw by 45° every frame for 200 frames while jobs settle in LCG order never issues a job for a busy column nor the same (stage, column) twice before it settles, and the fill completes".
5. **Changing the render distance again before the last change settled.** Raise 8 → 12, then lower to 10 while the fog is still easing out (at 128 blocks): "lowering moves the fog in at once" must not pull it past where it is, nor stop it short of the new target, and `camera.far` must follow the last value. **(plan)** a lower RD sets the fog end to min(current, (rd − 1)·16) at once and the easing continues outward to the new target. Task 22 pins "raise 8 → 12, 30 frames later (fog end 128) lower to 10: the fog end stays 128, eases on to 144 and stops there; lowering to 8 at fog 128 instead gives 112 at once" (`fogEase.test.ts`) and "apply(12) then apply(10): the last RD on the coordinator and the world is 10 and `camera.far` is 288" (`createRdControl`); Task 12 pins "setRenderDistance(12) then (10) before the next `update`: MESH needed 349".

## Branch

Create `sp4b/streaming` from `main` before Task 1: `git switch main && git switch -c sp4b/streaming`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP4b, add SP4c, the split's master amendments | §11, §13 (split), D26 |
| 2 | CI: the unit shards (first sharded run recorded) | §1, D1, D2, §9 |
| 3 | Store: claim generation, monotone versions, alive bit, status guard | §2.1-§2.4, D5 |
| 4 | Store: `resetLight`, `reopenProto`/`ProtoWriter`, `versionsInto`, `lightAt`, `heightAt`, `holder` | §2.3, §2.4 |
| 5 | Store: deferred reclamation and the store id | §2.5, §2.8, D4 |
| 6 | Store: the lock owner and `StoreCorrupt` | §2.6, D6 |
| 7 | Protocol, task handler, pool: the per-scope epoch cells and `scope` | §2.7, D7 |
| 8 | World jobs and the pool's fixes | §2.6, §2.8, §3.7, §8.5, D8 |
| 9 | The column-table race fuzz | §2.9 |
| 10 | `streamScore`, membership tables, the throttle, the upload budget | §3.2, §3.3, §3.8, §3.9, D10, D13, D29 |
| 11 | Coordinator I: slot table, classification, heaps, caps, intake, first fill | §3.1-§3.4, §3.6 (intake), §3.11, §3.13, D9, D10, D16, D21 |
| 12 | Coordinator II: pins, unloads, collisions, cancellation, errors, proto retention, live RD | §3.5-§3.8, §5, D3, D8, D11, D12, D18 |
| 13 | The in-process pool and the streaming integration test | §8.1 (harness), §8.5 |
| 14 | The mesh-job levers and the bench rows | §3.13, D27, §10 (bench) |
| 15 | `regionGrid.ts`: the shared row gathering and section bounds | §4.1, §7.6 |
| 16 | The streaming `SectionRenderer`, the staging and RegionBatch | §3.9, §4.1, §4.2, §4.4, D13, D14, D16 |
| 17 | RegionMesh's arena | §4.3, D15 |
| 18 | Renderer: unculled uploads, warm-up, GPU timer, far plane, `data-renderer`, first origin | §3.4, §3.9, §4.5, §7.6 |
| 19 | Materials: no edge fade, fog end (RD − 1)·16, zero-allocation uniforms | §3.10, §6.2 (fade), §6.3, D17, D25 |
| 20 | Horizontal flight; R, the clamp and the edge notice removed | §6.1, §6.2, D19, D20 |
| 21 | The page: first entry on the coordinator, the streaming frame, errors, HUD | §3.10, §7.1-§7.4, D12, D21 |
| 22 | Live render distance and the fog easing | §5, §6.3, D18 |
| 23 | Zero allocation at rest | §3.10, §8.5, D25 |
| 24 | Browser smoke: `stream` and `data-renderer` | §8.6 |
| 25 | R7: `stream.metric.ts` and its row | §8.1, §8.2, D24 |
| 26 | The `?bench=medium` route and `measureChrome --route bench` | §7.5, §8.3, D22 |
| 27 | GPU cells (Chrome, agent): bench files, re-measured flight, G1's streaming rows | §8.2, §8.4, D23 |
| 28 | Firefox cells (user), RTX check, review shots, exit evidence, docs | §8.4, §8.7, §10, §11, §13, D28 |

The order is spec §11's: governance, the sharding as its own push, the store, pool and protocol, the coordinator on fake jobs, the renderers behind the extended contract suite (the extraction first), the page, flight, edge removal and live RD, R7's row with its metric, the bench route, then the bench artifacts with G1's rows in one commit.

---

### Task 1: Governance: start SP4b, add SP4c, the split's master amendments

**Files:**
- Modify: `src/core/ids.ts` (doc comment :1-6, `SubProjectId` :7-9, `SUB_PROJECTS` :12-15, `CURRENT_SP` :22), `test/harness/sp.ts` (`SP_DEPS` :14-16, `STARTED_SPS` :34)
- Modify (pins): `test/arch/sp.test.ts` :18-22, :34-45, :58, :63, :78-79; `test/unit/profiles.test.ts` :25-26; `test/arch/masterSpec.test.ts` :664 and a new `describe('master spec amendments (SP4b §13)')`
- Modify: master spec, `test/thresholds.lock.json` (generated), SP4b spec `## Threshold log`, `CLAUDE.md:9`, `README.md:9`

**Interfaces:**
- Produces: `SubProjectId` and `SUB_PROJECTS` with `'SP4c'` after `'SP4b'` (22 ids); `SP_DEPS.SP4c = ['SP4b']`, `SP_DEPS.SP5 = ['SP4b', 'SP4c']`; `STARTED_SPS` ends `'SP4a', 'SP4b'`; `CURRENT_SP === 'SP4b'`.

- [ ] **Step 1: Update the pinned tests first.**
  - `sp.test.ts`: the started list ends `…, 'SP4a', 'SP4b'` and `CURRENT_SP` / `currentSpOf(STARTED_SPS)` are `'SP4b'` (title "SP4b has started and is the current SP (SP4b spec §11)"); "all 22 sub-projects" with `'SP4c'` after `'SP4b'` in `SP_ORDER`; the deps tuple reads `SP_DEPS.SP4b` `['SP4a']`, `SP_DEPS.SP4c` `['SP4b']`, `SP_DEPS.SP5` `['SP4b', 'SP4c']`; the paths at :58, :63, :78 and :79 insert `'SP4c'` right after `'SP4b'` (their expected errors are unchanged).
  - `profiles.test.ts:26`: `CURRENT_SP` is `'SP4b'` (the readiness list unchanged).
  - `masterSpec.test.ts:664`: `'the standalone ?map page (mounted in-game from SP4c)'`.
  - New describe `'master spec amendments (SP4b §13)'`, test "the split": the master contains the paragraph `SP4b was split on 2026-10-23 into SP4b (streaming) and SP4c (the map in the world and live editing), at the user's request`; `spEntry('SP4b', 'SP4c')` contains ``Spec: `2026-10-23-sp4b-streaming-design.md` `` and a `- **Cut line:** deferred reclamation's primitive (→ SP5)` line; `spEntry('SP4c', 'SP5')` starts `**SP4c — The map in the world and live editing** (M; SP4b)`; the receivers contain `SP4b deferred-reclamation primitive → SP5`; §6.3's scheduler header (master :1407) contains `SP4b: cancel, zero allocation, throttle; SP4c: Apply; amended by SP4a and SP4b`, and its bullet (master :1413) reads `old meshes are kept on Apply (SP4c)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (no `'SP4c'`, CURRENT_SP `'SP4a'`, the master unamended).
- [ ] **Step 3: Implement.**
  - `ids.ts`: `'SP4c'` inserted after `'SP4b'` in the union and the list; the doc comment adds "SP4b was split on 2026-10-23 into SP4b (streaming) and SP4c (the map in the world and live editing)", and SP4a's split sentence names SP4b "(streaming and life, later split)"; `CURRENT_SP = 'SP4b'`.
  - `sp.ts`: `SP4c: ['SP4b']` after `SP4b`; `SP5: ['SP4b', 'SP4c']` (D26); `STARTED_SPS` appends `'SP4b'`. If any other entry names SP4b's map or Apply, stop and report.
  - **Master amendments (spec §13, the split's):** §2.5 `type SubProjectId` with `'SP4c'`; §1 "the standalone ?map page (mounted in-game from SP4c)" (master :183) and the engine line's `invalidation.ts` "(SP4c with Apply's dirty stages; completed for every scope by SP10)"; §3.7 "teleport: SP4b" → "SP4c" and "SP4b-SP9" → "SP4c-SP9" (:670, :673); §5.1 "Until SP4c" and "SP4c's Apply" (:1281); §6.3's scheduler header as spec §13 gives it (:1407) and its bullet "old meshes are kept on Apply (SP4c)" (:1413); §8 risk 1's kill window "SP3a-SP5 … (amended by SP4b: …)" (:1677); §10: the split paragraph after :1819, the SP4b entry rewritten as spec §13 gives it (header `**SP4b — Streaming** (L; SP4a). Spec: \`2026-10-23-sp4b-streaming-design.md\``), the SP4c entry `(M; SP4b)`, SP5's header `(M; SP4b, SP4c)` and its added line, the receivers' "SP4b deferred-reclamation primitive → SP5", SP10's "on SP4c's teleport" (:1883); the critical path `… → SP4a → SP4b → SP4c → SP5 → …` (:1905); the visible-value line "streaming in SP4b, teleport and live editing from the map in SP4c" (:1909). Every other §13 item lands with its task.
  - `npm run test:accept-thresholds`; the SP4b spec's Threshold log gains `- 2026-10-2X — SP4b Task 1: startedSps gains 'SP4b' (SP4b split into SP4b and SP4c, spec §11).`
  - `CLAUDE.md:9` and `README.md:9`: SP4b in progress (streaming), then SP4c, then SP5.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS, the headers, `SubProjectId` and critical-path checks included.
- [ ] **Step 5: Commit** `chore(sp4b): start SP4b; split SP4b into SP4b and SP4c`.

---

### Task 2: CI: the unit shards

**Files:**
- Create: `.github/scripts/shardLib.mjs`, `.github/scripts/shardLib.d.mts`, `.github/scripts/unitShards.mjs`, `.github/scripts/unitShards.d.mts`, `.github/scripts/metricShards.d.mts` (`export const SHARDS: Record<string, string[] | null>`; `shards.test.ts` imports the table and the test tsconfig has no `allowJs`), `test/unit/shards.test.ts`
- Modify: `.github/scripts/metricShards.mjs` (its table and CLI over `shardLib`), `.github/workflows/ci.yml` (`changes` :18-37, `check` :39-63, a new `unit` job, `ci-ok` :121-139, the header comment :14-16), `CLAUDE.md:44`, master §1's `ci.yml` line (:68), `docs/backlog.md:7` (the "Shard the unit project" bullet removed), `test/arch/masterSpec.test.ts`

**Interfaces:**
- Produces, in `shardLib.mjs` (today's `metricShards.mjs:22-89` with `PROJECT`/`DIR` as parameters):
  - `shardArgs(shards: Record<string, string[] | null>, name: string): string[]` — a named shard's files, or `--exclude f` for every named file for the catch-all; throws `unknown shard <name>; shards: <a, b>`;
  - `coverageProblems(o: { project: string; shards: Record<string, string[] | null>; all: string[]; onDisk: string[]; listed: Record<string, string[]> }): string[]` — every rule `check` has today (exactly one catch-all, every on-disk file in the project, every named file in the project, each named shard lists exactly its files, no file twice, none dropped, none outside), as messages;
  - `shardTool({ project, dir, suffix, shards }): { matrix(): string[]; check(): void; run(name: string, report: string): never }` — `check` lists with `vitest list --project <project> --filesOnly --json=<tmp>` and calls `coverageProblems`; `suffix` is the on-disk file suffix (`.metric.ts`, `.test.ts`);
  - the CLI shape is unchanged: `node <table>.mjs matrix | check | run NAME REPORT`.
- Produces, in `unitShards.mjs`: `SHARDS = { heavy: [10 files], rest: null }`, `heavy` = `test/unit/{sliceJob,floatingRules,workerPool,treeMutator,reviewSlices,columnStage,tile,fieldSlice,splineFixtures,surfaceProbe}.test.ts`; its comment: "Measured in CI run 39950653330: the ten 202 s of the 412 s summed, rest (209 files) 210 s; rebalance by the job summaries (`slowest.mjs`)".

- [ ] **Step 1: Write `test/unit/shards.test.ts`** (synthetic lists, no `vitest list`).
  - `shardArgs(SHARDS, 'heavy')` equals the ten paths; `shardArgs(SHARDS, 'rest')` is `--exclude` and each of the ten, 20 strings; `shardArgs(SHARDS, 'nope')` throws `unknown shard nope; shards: heavy, rest`.
  - `coverageProblems` on a clean synthetic table is `[]`; with two catch-alls it names "there must be exactly one catch-all shard"; a named file outside the project, a file in two shards, a dropped file and a file outside the project each produce their message.
  - `metricShards.mjs`'s `SHARDS` keys are still `terrain, surface, render, rest` with today's files (Task 25 adds `test/metrics/stream.metric.ts` to this pin's `render`).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/shards.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - The workflow (spec §1.2, D2):
    - `changes` gains output `unit_shards` (`node .github/scripts/unitShards.mjs matrix`).
    - New job `unit`: `needs: changes`, `name: unit (${{ matrix.shard }})`, `strategy: { fail-fast: false, matrix: { shard: ${{ fromJSON(needs.changes.outputs.unit_shards) }} } }`, on both paths; steps: checkout (shallow), setup-node (`.nvmrc`, npm cache), `npm ci`, `unitShards.mjs check`, `unitShards.mjs run "$SHARD" "$RUNNER_TEMP/vitest.json"`, then `slowest.mjs --title "Slowest test files (unit $SHARD)"` under `if: ${{ !cancelled() }}`. No build, no cache step (`regionCache.test.ts:415-445` requires that only metrics jobs cache).
    - `check`: `npm run build`, then `npx vitest run --project arch` plus `--project integration` unless docs-only; its comment (:52-53) says the docs-only path runs arch (master spec, governance and threshold-log tests read the docs) and that the unit shards run on both paths because `uiSmoke.test.ts` and `reviewSlices.test.ts` read files under `docs/`.
    - `ci-ok`: `needs: [changes, check, unit, metrics-fast, metrics-quick]`; `UNIT: ${{ needs.unit.result }}` must be `success` on both paths.
  - `CLAUDE.md:44`: the CI sentence names `check` (build, arch, integration), the `unit` shards (`unitShards.mjs`: `heavy` and `rest`, rebalanced by the job summaries) and the docs-only path (build, arch and the unit shards). Master §1's `ci.yml` line as spec §13 gives it. `docs/backlog.md`: the "Shard the unit project" bullet goes (its numbers go stale here).
  - `masterSpec.test.ts`, the SP4b describe: "§1's ci.yml line names the unit shards": `layoutEntry(/^\s+\.github\/workflows\/ci\.yml /)` contains ``the two unit shards (`.github/scripts/unitShards.mjs`)`` and the file exists. **(plan)** A table `SP4B_MODULES: Array<[head: RegExp, token: string, file: string]>` in that describe, "§1 names each SP4b module in its entry, which exists": for each row, `layoutEntry(head)` contains `token` and `existsSync(file)` (as SP4a's pin, `masterSpec.test.ts:640-663`); this task adds `[/^\s+\.github\/workflows\/ci\.yml /, '.github/scripts/unitShards.mjs', '.github/scripts/unitShards.mjs']`, and Tasks 5, 10, 16 and 26 append theirs.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node .github/scripts/unitShards.mjs check` and `node .github/scripts/metricShards.mjs check`. Expected: PASS; `unitShards` prints `shards cover the 220 unit files exactly once` (219 today plus `shards.test.ts`), `metricShards` prints `shards cover the 13 metrics-quick files exactly once` (14 from Task 25 on).
- [ ] **Step 5: Commit** `ci(sp4b): shard the unit project into two parallel jobs`.
- [ ] **Step 6: The controller pushes the branch** (`git push -u origin sp4b/streaming`), waits for the run (`gh run watch`), and records its wall time and every job's time against spec §1.3 (`check` ≈ 80-100 s, each unit shard ≈ 90-110 s, the run ≈ 3.3 min cold) in a new `## Exit evidence` section of the SP4b spec, before `## Threshold log`, as "### The first sharded run (Task 2)". A unit shard longer than the metrics jobs moves named files into `heavy` by the summaries (spec §9). Commit `docs(sp4b): the first sharded CI run`.

---

### Task 3: Store: claim generation, monotone versions, alive bit, status guard

**Files:**
- Modify: `src/world/store/columnTable.ts` (layout doc :6-8, `clearRecord` :99-118, `claim` :142-152, `find` :153-158, `unclaim` :160-164, the interface :73-97), `src/world/store/store.ts` (writer `check` :207-211, `commit` :282-290, `freeProto` :329-332, `proto` :334-337), `src/world/store/api.ts` (`CommitStatus` doc, `commit` doc :63-69)
- Modify (tests): `test/unit/columnTable.test.ts` (:108-127 "unclaim frees the record; a later claim … starts initial" and :129-141 "claim resets a record left dirty": versions now kept), `test/unit/storeReopen.test.ts` (:246-249 `idle.commit(1)` now throws), `test/harness/fuzzWorker.ts` (the model's `commits` per record, :87, :400; `proto()` null after `freeProto`, :383-389), `test/unit/store.test.ts`
- Master: §2.3's record table row 12, ints 4-5 and int 6 (spec §13)

**Interfaces:**
- Produces, in `columnTable.ts`: `REC_GEN = 12`; `PROTO_ALIVE = 1` (protoFlags bit 0; bit 1 `pinnedByTuning` reserved, SP8b); `ColumnTable.generation(base): number`; `class WriterStale extends Error` (name `'WriterStale'`).
  - `claim`: CAS `claimed` 0 → 1, `clearRecord` (now leaves `blockVersion`, `lightVersion` and `REC_GEN` alone), store cx, cz, epoch, then `Atomics.add(gen, 1)` (odd).
  - `unclaim`: `Atomics.add(gen, 1)` (even), then cx = cz = `NO_COLUMN`, then `claimed` 0.
  - `find(cx, cz)`: `g1 = load(gen)`, −1 when even; check `claimed`, cx, cz; `g2 = load(gen)`; the base only when `g1 === g2`.
- Produces, in `store.ts`: the writer captures the generation at its claim or reopen; `check()` throws `WriterStale` when the generation, `claimed`, cx or cz changed. **The status guard (plan, made exact):** a writer opened by a claim has `from = 0`, a reopened one `from` = its reopen status; `commit(s)` throws `RangeError` before any version bump unless `s > from` and `s ≥` the last status this writer committed (so a writer never lowers its own status, and `commit(2); commit(2)` stays legal). Every commit of a writer opened by `claimColumn` sets `PROTO_ALIVE` (in the pipeline that is T's `commit(1)`; tests that claim and commit 2 or 3 directly, e.g. `store.test.ts:132-134`, `:217-238`, `padded.test.ts:47-51` → `:206`, keep a live proto); a writer from `reopenColumn` never sets it; `ProtoWriter.commitProto` does (Task 4); `freeProto` releases the proto entries, then clears the bit; `proto(cx, cz)` is null when the bit is clear.

- [ ] **Step 1: Write the tests.**
  - `columnTable.test.ts`: "the generation is even while free and odd while held: 0, claim → 1, unclaim → 2, claim → 3"; "find against a re-claim: a base found before an unclaim and re-claim of another column is not returned for the old column (g changed)"; "versions never decrease across claims: claim (0, 0), bump block and light, unclaim, claim (64, 0) on the same record → blockVersion 1, lightVersion 1"; "a never-used record starts at versions 0"; the two tests at :108-141 keep versions instead of expecting 0.
  - `store.test.ts`: "a writer whose record was freed and re-claimed by another column throws WriterStale on setProto, aux and commit"; "every commit of a claim writer sets the alive bit (T's commit(1), and a claim committed straight at 2 or 3); a reopenColumn writer's commit does not set it; after freeProto, proto() is null and the bit is clear, final() still reads the shared slots"; "the status guard: a claim writer's commit(0 as 1) throws; reopenColumn(…, 2).commit(2) throws RangeError with blockVersion and lightVersion unchanged; reopenColumn(…, 1).commit(2) then commit(2) is legal; commit(3) then commit(2) throws".
  - `storeReopen.test.ts:246-249`: "a commit at the status the writer was opened at throws RangeError and bumps nothing".
  - The fuzz model (`fuzzWorker.ts`): `commits` lives per record and survives a free and re-claim. `commit(c, s)` (`:354-357`, called at `:425` with 1 and `:429` with 2 on the same claim writer in random order) commits `Math.max(s, c.status)`, so a writer never lowers its own status under the new guard (a repeat of 2 stays legal). The model keeps a per-column alive flag: a commit sets it (the claim-writer rule above) and `freeProto` clears it; `lookupOp` expects `proto()` null while the flag is clear and checks the data otherwise.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/columnTable.test.ts test/unit/store.test.ts test/unit/storeReopen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Amend the `api.ts` `commit` doc ("a status above the one the writer opened at, never below its last commit (SP4b)"). Master §2.3: the record table gains `| 12 | claim generation (Atomics; even free, odd held; bumped by claim and unclaim; lookups and writers validate it; SP4b) |`, ints 4-5 "never reset by a claim: monotone over the record's life (SP4b)", int 6 "bit 0 alive (set by a claim writer's commit, i.e. T's, and by `commitProto`; cleared by `freeProto`; `proto()` is null when clear), bit 1 pinnedByTuning (SP8b)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS, the slab fuzz included; no golden diff.
- [ ] **Step 5: Commit** `fix(store): claim generation, monotone versions, the proto alive bit, the status guard`.

---

### Task 4: Store: `resetLight`, `reopenProto`/`ProtoWriter`, `versionsInto`, `lightAt`, `heightAt`, `holder`

**Files:**
- Modify: `src/world/store/api.ts` (`ColumnWriter` gains `resetLight`; `setLight` doc :50-55; the thread-contract doc :36-39; `NeighborhoodReader` gains `versionsInto`; new `ProtoWriter`, `TerrainWriter`, `HeightmapKind`), `src/world/store/store.ts`, `src/world/store/aux.ts` (`createScratchAux`), `src/gen/pipeline/terrainStage.ts:31`, `:141` (the writer typed `TerrainWriter`)
- Modify (tests): `test/unit/store.test.ts`, `test/unit/storeReopen.test.ts`, `test/unit/aux.test.ts`, `test/arch/masterSpec.test.ts` (:124's list gains `'ProtoWriter'`)
- Master: §2.5 (spec §13: `ColumnWriter.resetLight`, `commit`'s and `setLight`'s comments, `NeighborhoodReader.versionsInto`, the `ProtoWriter` line, the store comment above `interface ColumnWriter`)

**Interfaces:**
- Produces, in `api.ts`:
  - `ColumnWriter.resetLight(): void` — releases the 24 light entries to uniform 0 (through reclamation once Task 5 lands; until then a plain release);
  - `NeighborhoodReader.versionsInto(out: Int32Array): void` — the 18 values of `versions()` into `out` (length ≥ 18), allocation-free;
  - `type TerrainWriter = Pick<ColumnWriter, 'setProto' | 'aux' | 'auxB'>`;
  - `interface ProtoWriter { readonly cx: number; readonly cz: number; setProto(sy: number, blocks: Uint16Array, fluid: Uint8Array): void; aux(): AuxView; auxB(): AuxBView; commitProto(): void }` — `aux`/`auxB` are worker-local zeroed scratch, discarded; `commitProto` sets the alive bit, bumps no version, leaves the status;
  - `type HeightmapKind = 'worldSurfaceWG' | 'oceanFloorWG' | 'worldSurface' | 'motionBlocking' | 'oceanFloor' | 'lightBlocking'`.
- Produces, in `store.ts` (`VoxelStore`):
  - `reopenProto(cx: number, cz: number): ProtoWriter` — throws `reopenProto: (cx, cz) is not at status ≥ 2 with a freed proto` unless the record holds (cx, cz) at status ≥ 2 with the alive bit clear; never touches the record's aux slots;
  - `versionsInto(cx: number, cz: number, out: Int32Array): void` (the coordinator's `StreamStore`, no `neighborhood()` object);
  - `lightAt(bx: number, by: number, bz: number): number` — integer block coordinates, `by` in −64 … 319 (else `RangeError`); the raw light byte of a Published column, −1 otherwise;
  - `heightAt(kind: HeightmapKind, bx: number, bz: number): number | null` — the column's aux A heightmap value, `null` when the column is not Published (Spec corrections);
  - `holder(cx: number, cz: number): 'free' | 'self' | 'other'` — of the record (cx, cz) maps to.
- Produces, in `aux.ts`: `createScratchAux(): { readonly a: AuxView; readonly b: AuxBView }` over two worker-local 4096-byte `ArrayBuffer`s, zero-filled.
- Consumes: Task 3's generation and alive bit.

- [ ] **Step 1: Write the tests.**
  - `store.test.ts`: "resetLight releases the 24 light entries to uniform 0, then 24 setLight succeed after a partial write" (write 5 dense lights, throw, retry: `resetLight` then 24 `setLight`, `commit(3)`; lightVersion +1); "reopenProto throws (`not at status ≥ 2 with a freed proto`) at status 1, for an absent column, and while the alive bit is set; after freeProto at status 2 it writes the 24 proto sections, and commitProto sets the bit and leaves blockVersion, lightVersion and status unchanged"; "reopenProto never touches the record's aux A and aux B bytes (byte-for-byte equal before and after)"; "versionsInto writes what versions() returns, into a reused array, for a centre with absent neighbours (−1)"; "lightAt and heightAt read a Published column; −1 and null at status 2 and for an absent column; heightAt('motionBlocking', …) equals final().aux().motionBlocking at the same position"; "holder: free, self (claimed, uncommitted included), other (the record held by (cx + 64, cz))".
  - `aux.test.ts`: `createScratchAux()`'s views have the `AuxView`/`AuxBView` shapes and lengths and read 0.
  - `masterSpec.test.ts:124`: `test.each(['ColumnWriter', 'ColumnView', 'NeighborhoodReader', 'ProtoWriter'])`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `terrainStage(ctx, cx, cz, w: TerrainWriter, stop)` (it calls only `setProto`, `aux`, `auxB`: `terrainStage.ts:165`, `:167`, `:179`). `api.ts:36-39`'s thread contract: "a column has one writer at a time, chosen by the coordinator's states; the coordinator's reader pins forbid freeing a column while a job of it or its 3 × 3 runs, and queued jobs are dropped with `cancelWorld` (SP4b)". `setLight`'s doc: "the refusal stays in SP4b as the light-once invariant inside one job; SP5's relight lifts it under the reclamation protocol". The master §2.5 amendments of spec §13, with `ProtoWriter`'s line and the store comment naming `reopenProto`, `freeProto`, `holder`, `lightAt`, `heightAt`, `enterRead`, `exitRead` and `markDead` (the last three arrive in Tasks 5-6; the comment names them now, as spec §13 words it).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(store): resetLight, reopenProto, versionsInto and the main-thread readers`.

---

### Task 5: Store: deferred reclamation and the store id

**Files:**
- Create: `src/world/store/reclaim.ts`, `test/unit/reclaim.test.ts`
- Modify: `src/world/store/section.ts` (`storeChannel` :70-82, `releaseEntry` :95-99, `shareEntry` :102-108 take a `retire` parameter), `src/world/store/store.ts` (`StoreHandles.reclaim`, `attachStore(h, thread)`, `freeColumn` :313-327, `releaseProto` :187-193, `resetLight`, the read API), `src/workers/protocol.ts` (`storeHandlesOk` :347-352 and `isStoreHandles` :539-541 accept `reclaim`), `src/ui/world/worldPage.ts` (`storeSabMiB` :191-195 counts it), `test/arch/masterSpec.test.ts`
- Master: §2.3's **Reclamation** paragraph (spec §13)

**Interfaces:**
- Produces, in `reclaim.ts`:
  - `RECLAIM_BYTES = 192`, `RECLAIM_THREADS = 16`, `R_EPOCH = 0`, `R_DEAD = 1`, `R_STORE_ID = 2`, `R_READER = 16`, `R_LIMBO = 32`, `MAIN_THREAD = 0`, `SIM_THREAD = 15`, `LIMBO_ENTRIES = 1024`;
  - `createReclaimBuffer(shared: boolean, storeId: number): SharedArrayBuffer | ArrayBuffer` — G at 1, the store id stamped;
  - `type Retire = (pool: SlabPool, slot: number) => void`;
  - `interface Reclaimer { readonly thread: number; readonly storeId: number; enterRead(): void; exitRead(): void; retire: Retire; drain(): number; limboCount(thread: number): number; markDead(thread: number): void }`;
  - `attachReclaimer(buf: SharedArrayBuffer | ArrayBuffer, thread: number, pools: readonly [SlabPool, SlabPool], shared: boolean): Reclaimer`.
  - Semantics (spec §2.5): `enterRead` publishes `e = load(G)` into `R[t]` and repeats while `load(G) !== e`; `exitRead` stores 0 then drains; `retire`: `tag = Atomics.add(G, 1)`, then frees at once when unshared or every `R[t]` reads 0, else pushes `(pool index, slot, tag)` on the thread's limbo ring (3 × 1024 Int32, grown on overflow) and counts it in `[32 + t]`; `drain`: `m` = the smallest non-zero `R[t]` over threads whose dead bit is clear (else +∞), frees every entry with `tag < m`, returns the entries left; `markDead(t)` sets bit t of `[1]`, then `R[t] = 0`.
- Produces, in `section.ts`: `storeWords`, `storeBytes`, `releaseEntry`, `shareEntry` gain a last parameter `retire: Retire = FREE_NOW` (`(p, s) => p.free(s)`), so `section.test.ts` stays unchanged.
- Produces, in `store.ts`: `StoreHandles.reclaim`; `createStore` stamps the store id **(plan)** from a module counter starting at 1 (Spec corrections: `world/` bans `Math.random`); `attachStore(h: StoreHandles, thread = 0)`; `VoxelStore` gains `readonly thread: number; readonly storeId: number; enterRead(): void; exitRead(): void; drain(): number; limboCount(thread: number): number; markDead(thread: number): void`. Every release `section.ts` and `freeColumn` make goes through the thread's `retire`.

- [ ] **Step 1: Write `reclaim.test.ts`** (one thread, simulated readers by writing `R[t]` through a second `attachReclaimer` on the same buffer).
  - "the fast path: no reader inside a read section frees at once (the slot is back on the free stack); an unshared store frees at once even with a reader announced";
  - "the limbo path: a slot retired while thread 2 is inside a read section is not freed, counts 1 in [32 + t], and is freed by the drain after thread 2's exitRead";
  - "a reader that entered after the release does not hold it: retire with tag g, thread 3 enters (R = g + 1), drain frees the slot";
  - "markDead(2) clears R[2] and the drain ignores it: a slot held in limbo by dead thread 2 is freed";
  - "a limbo of more than 1024 entries grows and drains completely";
  - "createStore stamps distinct non-zero store ids; attachStore(h, 3).thread is 3 and its storeId equals the creator's";
  - `store.test.ts`: "freeColumn under an active reader leaves every slot in limbo until exitRead; the pools' freeCount then equals the count before the claim". The existing immediate-free tests (`store.test.ts:165-166`, `:195-196`, `pool.test.ts`, `section.test.ts`, `storeReopen.test.ts`, `region.test.ts`, `regionCache.test.ts:409`, the slab fuzz) stay unchanged and pass through the fast path.
  - `worldProtocol.test.ts`: the attach guard refuses handles whose `reclaim` is not a 192-byte `SharedArrayBuffer`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §2.3 gains the **Reclamation** paragraph of spec §13. `masterSpec.test.ts`: `SP4B_MODULES` gains `[/^\s+store\/pool\.ts /, 'reclaim.ts (SP4b)', 'src/world/store/reclaim.ts']`, and master §1's store entry (`world/`'s `store/pool.ts …` line, master :105) writes `reclaim.ts (SP4b)`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(store): deferred reclamation through every slot release`.

---

### Task 6: Store: the lock owner and `StoreCorrupt`

**Files:**
- Modify: `src/world/store/pool.ts` (`lock` :140-146, `attachPool` :128, `createPool` :96-113), `src/world/store/store.ts` (passes the owner), `test/unit/pool.test.ts`, `test/unit/store.test.ts`
- Master: §2.3's slabs paragraph (spec §13)

**Interfaces:**
- Produces, in `pool.ts`: `class StoreCorrupt extends Error` (name `'StoreCorrupt'`), re-exported by `store.ts`; `attachPool(h: PoolHandles, owner?: { readonly thread: number; readonly dead: Int32Array }): SlabPool` — `dead` is the reclaim buffer's view (`dead[R_DEAD]` the mask); without `owner` the lock word is `0 + 1` and no dead check runs (`createPool`, single-threaded stores, today's tests). A shared store passes `{ thread, dead }` from `createStore` (thread 0, the main thread, so a main-thread allocation behind a dead worker's lock throws too) and from `attachStore(h, thread)`; an unshared store passes none. `lock()` CASes 0 → `thread + 1`; after the backoff reaches `MAX_SPIN` (1024) it re-reads the word every 4,096 spins and throws `StoreCorrupt('pool lock held by failed thread k')` when bit k of the mask is set (k = word − 1). `LOCK_RECHECK_SPINS = 4096`.

- Produces, as the test seam **(plan)**: `SlabPool.withLock<T>(fn: () => T): T` (runs `fn` holding the pool lock under this pool's owner) and `SlabPool.lockWord(): number` (the raw word). Nothing runs inside `alloc`/`free` while they hold the lock (`pool.ts:179-191`, `:208-215`), so only `withLock` can observe a held word.

- [ ] **Step 1: Write the tests.** `pool.test.ts`: "the lock word holds thread + 1 while held: `const p = attachPool(h, { thread: 4, dead }); p.withLock(() => p.lockWord())` is 5; `p.lockWord()` is 0 afterwards; without `owner` it is 1"; "a lock left at 3 by thread 2 marked dead makes alloc() throw StoreCorrupt naming thread 2" (write `new Int32Array(h.ctl)[0] = 3`, set bit 2 of the mask); `store.test.ts`: "attachStore(h, 2) allocates under owner 3: `const s2 = attachStore(h, 2); s2.blockPool.withLock(() => s2.blockPool.lockWord())` is 3; markDead(2) on a store whose pool lock word is 3 makes the next alloc throw StoreCorrupt".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §2.3's slabs paragraph gains "the lock word holds its owner's thread index + 1, and a thread spinning on a failed owner's lock throws `StoreCorrupt` (SP4b)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS.
- [ ] **Step 5: Commit** `fix(store): the pool lock holds its owner; a dead owner is StoreCorrupt`.

---

### Task 7: Protocol, task handler, pool: the per-scope epoch cells and `scope`

**Files:**
- Modify: `src/workers/protocol.ts` (`ConfigureMsg` :42, `isAbortCell` :200 → `isEpochCells`, every job message, `parseToWorker` :355-389, the header doc), `src/workers/taskHandler.ts` (`stopFor` :157-160, configure :168-182), `src/engine/workerPool.ts` (`PoolOptions.abortCell` :146-151, `Job` :229-239, `createWorkerPool` :250-263, the settle rule :340-347, `configure` :388-401, `createBrowserPool` :578-583, a new `bumpScope`), `src/world/store/epochs.ts` (doc :1-5), `src/ui/world/worldPage.ts` (the pool gets the store's cells), `src/ui/map/mapPage.ts:68` and `src/ui/selftest/selftestPage.ts:46` (unchanged calls, the default cells)
- Modify (tests: `abort:` → `epochs:`, `abortCell` → `epochCells`; every epoch-cell buffer becomes `new SharedArrayBuffer(16)` (`workerPool.test.ts:181`, `:204`, `:408`, `:585`; `worldProtocol.test.ts:160`; `abort.test.ts:43`, `:75`; `fieldSlice.test.ts:136`, `:166`; `protocol.test.ts:42`, `:202`, `:291`, `:411`, `:534`; `fieldSliceJob.test.ts:107`, `:148`; `worldJobs.test.ts:73`), the `stall` helpers' 4-byte wait buffers stay; every hand-built job message gains an integer `scope`): `test/unit/workerPool.test.ts`, `test/unit/protocol.test.ts`, `test/unit/worldProtocol.test.ts`, `test/unit/fieldSliceProtocol.test.ts` (`V`, `H`, `P` at `:12-14`), `test/unit/fieldSliceJob.test.ts`, `test/unit/fieldSliceHeavy.test.ts`, `test/integration/abort.test.ts`, `test/integration/twoWorkers.test.ts`, `test/integration/fieldSlice.test.ts`, `test/integration/worldJobs.test.ts:73`, `test/bench/noise.bench.ts`
- Master: §2.3's epoch-cell sentence gains spec §13's parenthesis (the pinned "SP4b wires them in place of SP2b's pool-wide cell" stays, `masterSpec.test.ts:679`)

**Interfaces:**
- Produces, in `protocol.ts`:
  - `ConfigureMsg.epochs: SharedArrayBuffer | null` (16 bytes; guard `isEpochCells`), replacing `abort`;
  - every message with an `epoch` (`mapTile`, `point`, `spawn`, `stats`, `slice`, `surfaceProbe`, `fieldSlice`, `fieldProbe` and the four world jobs) gains `scope: number`, checked an integer by its guard; `selftest` has neither;
  - `export type ScopedJobType = Exclude<ToWorker['type'], 'configure' | 'attach' | 'selftest'>` and `cellOf(type: ScopedJobType): 0 | 1 | 2 | 3` — `decorate` 1, `light` 2, `meshColumn` 3, every other scoped type 0 (terrain, spawn, tiles, stats, slices, field slices, probes, points). Protocol may not import engine's `JobType` (`workerPool.ts:127`; `imports.ts:27` gives `workers` no engine import); engine may import protocol. The pool calls `cellOf` only for job types other than `selftest` (selftest records no scope).
- Produces, in `taskHandler.ts`: the worker answers `STALE_EPOCH` when `m.epoch` differs from its configure's (unchanged, `:196`), and stops when `Atomics.load(cells, cellOf(m.type)) !== m.scope` (ABORTED); no cells: never stops.
- Produces, in `workerPool.ts`:
  - `PoolOptions.epochCells?: Int32Array | null` (4 cells), replacing `abortCell`; the pool accepts them only when `cells.buffer instanceof SharedArrayBuffer && cells.length === 4` (else `TypeError`) and posts `cells.buffer` as `ConfigureMsg.epochs`, so callers pass `store.epochs.cells` (`epochs.ts:13`, a plain `Int32Array`) unchanged; the pool never writes them before its first `configure`;
  - each `Job` records `scope` = `Atomics.load(cells, cellOf(type))` at issue (the generation without cells); a reply settles as `JobCancelled` when `job.epoch !== epoch`, when `cells` and `load(cells, cellOf(type)) !== job.scope`, or on ABORTED;
  - `configure`: `epoch++`, stores it into all four cells, rejects every queued job (as today);
  - `bumpScope(from: 'terrain' | 'decorate' | 'light' | 'mesh'): void` — adds 1 to the cells from that phase onward and rejects the queued jobs of those phases with `JobCancelled`; called by nothing in SP4b outside its tests;
  - `createBrowserPool(size?, opts?: { onFailure?; epochCells? })` — default: a pool-owned 16-byte buffer under isolation, null otherwise; the world page passes `store.epochs.cells`.

- [ ] **Step 1: Write the tests.**
  - `protocol.test.ts`: `configure` accepts `epochs` null or a 16-byte SAB and refuses 4 bytes or an `ArrayBuffer`; every job message without an integer `scope` is refused; `cellOf` maps the twelve scoped job types as above.
  - `workerPool.test.ts`: "epochCells over an ArrayBuffer, or of length other than 4, is refused with TypeError".
  - `workerPool.test.ts`: "configure stores the new generation into all four cells (the store's cells start 0, the pool's generation −1: after the first configure all four read 0, after the second 1)"; "bumpScope('light') rejects queued L and MESH jobs, keeps queued T and D, and the cells read [g, g, g + 1, g + 1]"; "after bumpScope('light') a new L job succeeds (its scope is the new cell value; its epoch still the configure's, so no STALE_EPOCH)"; "a reply whose cell moved since issue settles as JobCancelled".
  - `worldProtocol.test.ts`: the ABORTED case (`:158-170`) drives `scope` and `epochs`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, migrating every caller and test listed. `epochs.ts`'s doc: "wired by SP4b in place of the pool-wide abort cell".
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS, the integration abort and two-worker tests included.
- [ ] **Step 5: Commit** `feat(workers): per-scope epoch cells; every job carries its scope`.

---

### Task 8: World jobs and the pool's fixes

**Files:**
- Modify: `src/workers/protocol.ts` (`AttachMsg` gains `thread`; `WorldJobMsg` gains `protoOnly?: boolean`, terrain only; `ErrorCode` :119 gains `STORE_CORRUPT`), `src/workers/taskHandler.ts` (attach :183-187, `worldReply` :201-209, the INTERNAL catch :270-272, `TaskHandler` gains `drain`), `src/workers/task.worker.ts` (drain after each reply, 16 ms retry), `test/harness/nodeWorker.ts` (the generated `node-worker.mjs`, `:58-65`, drains as `task.worker.ts` does), `src/ui/world/worldPage.ts` (the `createBrowserPool` call :496), `src/workers/worldJobs.ts` (`fillColumnL` :49-60 calls `resetLight`; `fillProtoOnly`; `terrainReply` :104-108), `src/engine/workerPool.ts`, `src/engine/coordinator.ts` (`worldJobsOf` :45-57 passes `protoOnly`; SP4a's `load` unchanged until Task 11)
- Modify (tests): `test/unit/worldProtocol.test.ts`, `test/unit/worldPool.test.ts`, `test/unit/workerPool.test.ts`, `test/integration/worldJobs.test.ts` (there is no unit `worldJobs.test.ts`)

**Interfaces:**
- Produces, in `taskHandler.ts`:
  - `attach` carries `thread` (1 … 15); a worker already attached replies `attached` when the new handles' store id (`Atomics.load` of `reclaim[R_STORE_ID]`) and the thread equal its own, else `BAD_MESSAGE` `the store is already attached`;
  - every world job runs between `store.enterRead()` and `store.exitRead()`;
  - a `StoreCorrupt` thrown by a job maps to `STORE_CORRUPT`; other throws stay `INTERNAL`;
  - `TaskHandler.drain(): number` — `store.drain()` (0 without a store);
  - `terrain` with `protoOnly: true` runs `fillProtoOnly`.
- Produces, in `taskHandler.ts`: `LIMBO_RETRY_MS = 16`; `drainAfterReply(h: Pick<TaskHandler, 'drain'>, setTimer: (f: () => void, ms: number) => unknown): void` — drains, then re-drains every 16 ms while it returns > 0. `task.worker.ts` and Task 13's `inProcessWorker` call it after each post; the `node-worker.mjs` that `buildNodeTaskWorker` writes (both the stamped and the plain line) mirrors it in plain JS with `h.drain?.()` and `setTimeout` (it cannot import the helper: the `fuzzWorker`/`regionWorker` entries have neither it nor `drain`, and the `?.` keeps them working).
- Produces, in `worldJobs.ts`: `fillColumnL` calls `w.resetLight()` before its 24 `setLight`; `fillProtoOnly(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean): boolean` — `reopenProto`, `terrainStage(ctx, cx, cz, pw, stop)`, `commitProto()`; a stop or a throw releases the written proto entries (`freeProto`) and leaves the bit clear.
- Produces, in `workerPool.ts`:
  - `class StoreCorruptError extends Error` (name `'StoreCorruptError'`), the rejection for `STORE_CORRUPT`;
  - `attachStore(h)` posts `{ type: 'attach', handles: h, thread: w + 1 }` per worker `w`; a retried `attachStore` after a partial failure succeeds (idempotent per worker);
  - `terrain(cx: number, cz: number, protoOnly = false): Promise<ColumnDone>`;
  - `cancelWorld(pred: (stage: Stage, cx: number, cz: number) => boolean): void` — rejects matching queued world jobs with `JobCancelled` (`Stage` from `engine/rings.ts`; `terrain` T, `decorate` D, `light` L, `meshColumn` MESH);
  - `liveWorkers(): number`;
  - `PoolOptions.onWorkerDead?: (thread: number) => void` — called by `fail(w)` with `w + 1` before its rejections; `createBrowserPool`'s `opts` gains `onWorkerDead?`, passed through to `PoolOptions`; the world page passes `(t) => store.markDead(t)`;
  - `terminate()` rejects `pendingAttach`, `pendingReady` and every busy job with `WorkerFailed('terminated')`, then the queue (as today).
- Consumes: Tasks 4-7.

- [ ] **Step 1: Write the tests.**
  - `worldProtocol.test.ts`: **the ABORTED table** — for each of terrain, decorate, light and meshColumn (with its 3 × 3 prepared at the stage it needs), moving that job's own cell before `handle` gives `ABORTED`, and moving each of the three other cells does not (the job replies done); "attach twice with the same store and thread replies attached; with another store's handles or another thread BAD_MESSAGE"; "a StoreCorrupt inside a world job replies STORE_CORRUPT"; "L after a partial setLight retries cleanly: inject a throw after 5 setLight, retry the job, it replies columnDone and lightVersion moved by 1"; "D's partial shares on a throw are tolerated: inject a throw between shares, the retry commits at Decorated and the pools' refcounts are balanced"; "terrain protoOnly on a status-2 column with a freed proto replies columnDone, sets the bit, leaves versions, status and the aux bytes unchanged, and the proto's region hash equals the original's"; "a world job's slots released by its own L resetLight sit in the worker's limbo while another thread reads, and drain() empties it after"; "attach is refused with `thread` 0, 16 or 1.5, or missing"; "`protoOnly` is refused unless boolean, and on decorate, light and meshColumn".
  - `taskHandler` (`worldProtocol.test.ts`), with a fake timer: "drainAfterReply drains once after the reply, re-drains every 16 ms while it returns > 0, and stops once a drain returns 0".
  - `worldPool.test.ts` (scripted workers, `:26-58`): "cancelWorld drops matching queued world jobs only"; "liveWorkers counts down on a failure and onWorkerDead receives thread w + 1 (also when given through `createBrowserPool`'s options, which forwards it)"; "terminate during an attach rejects attachStore and every busy job with WorkerFailed('terminated')"; "a retried attachStore after one worker answered BAD_MESSAGE resolves once each live worker answered attached"; "STORE_CORRUPT rejects with StoreCorruptError".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The world page passes `onWorkerDead` (through `createBrowserPool`'s options, :496) and `store.epochs.cells` unchanged (Task 7's checked `Int32Array`); `worldJobsOf` maps `protoOnly` (its `run` keeps SP4a's three-argument callers working with `protoOnly` defaulting false until Task 11).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS, `test/integration/worldJobs.test.ts` included.
- [ ] **Step 5: Commit** `feat(workers): read sections, idempotent attach, T(protoOnly), retry-safe L, cancelWorld`.

---

### Task 9: The column-table race fuzz

**Files:**
- Create: `test/integration/columnTableFuzz.test.ts`, `test/harness/tableFuzzWorker.ts` **(plan: the worker script, as `fuzzWorker.ts` is the slab fuzz's)**

**Interfaces:**
- Four `worker_threads` on one shared store, 100,000 operations, seeded by `SLAB_FUZZ_SEED` through `integerEnv` (a non-integer is an error, `test/unit/harnessHelpers.test.ts:48`). Three phases, each reporting counters the test asserts at 0:
  - **column-table races:** all four threads `claim`/`unclaim` the same 64 records and `find` against them — `twoHolders` (a record claimed by two threads at once, through a per-record Atomics owner word the threads set after a successful claim), `staleFinds`, `versionsDecreased`; **`staleFinds`, exact:** each claiming thread, after a successful claim, reads `generation(base)` and logs the claimed column into a per-record shared history `hist[rec][g]` (Atomics; sized for the run's claims); a finder reads g0 = the generation before `find(cx, cz)` and g3 after; when `find` returns the base, it waits (bounded spin) until every odd g in [g0, g3] is logged, and counts a stale find when none of them holds (cx, cz) (the record never held that column while `find` ran). A correct `find` linearises at an odd g1 = g2 inside the window, so it never counts, while a torn read (cx from one claim, cz from another) does. The queried columns alias across records in both axes (e.g. claims of (0, 64) and (64, 0) with finds of (0, 0)), so torn reads can produce a stale match; a record is freed only under its test-level ownership token (the fuzz's analogue of the pins), and `WriterStale` is asserted only for writer calls that start after a takeover completed, sequenced by an Atomics handshake (`missedStale`, `spuriousStale`);
  - **cross-thread slot handoff:** a slot allocated and shared on one thread is freed on another — `doubleAllocs`, `negativeRefcounts`;
  - **deferred reclamation:** readers stamp a canary into a slot inside a read section and check it at exit while writers retire and reuse slots — `reusedUnderReader`.

- [ ] **Step 1: Write the test** with those counters and a 60 s timeout; about 5 s (spec §2.9).
- [ ] **Step 2: Run** `npx vitest run --project integration test/integration/columnTableFuzz.test.ts`. Expected: PASS on Tasks 3-6's code (this task adds coverage, no production change). To show it bites, run it once against a stash that drops the `g1 === g2` check of `find`: `staleFinds` > 0; restore.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(store): the column-table race fuzz`.

---

### Task 10: `streamScore`, membership tables, the throttle, the upload budget

**Files:**
- Create: `src/core/streamScore.ts`, `src/engine/throttle.ts`, `test/unit/streamScore.test.ts`, `test/unit/throttle.test.ts`
- Modify: `src/engine/rings.ts` (membership tables, `assertTorusSafe` :90-95 at RD + 5), `src/engine/uploadBudget.ts`, `test/unit/rings.test.ts` (:81-86 "rd 16 passes and rd 29 throws" → 26 / 27), `test/unit/uploadBudget.test.ts`, `src/ui/world/worldPage.ts:550` (`createUploadBudget(12, Infinity, …)`), `test/arch/masterSpec.test.ts`
- Master: §1's engine and core lines for `throttle.ts (SP4b)`, `scheduler.ts` marked not created (the coordinator holds the scheduler), `core/streamScore.ts`; §4.3's heap and throttle sentences (spec §13)

**Interfaces:**
- Produces, in `core/streamScore.ts`:
  - `STAGE_BONUS = { T: 0, D: 0.5, L: 1, MESH: 1.5 } as const`; `VIEW_WEIGHT = 3`; `VIEW_MIN_DH = 2`;
  - `streamScore(dx: number, dz: number, fx: number, fz: number, bonus: number): number` — `d = Math.sqrt(dx·dx + dz·dz)`; `d − (d > 2 ? 3·max(0, (dx·fx + dz·fz)/d) : 0) − bonus` (the quotient is never computed at d ≤ 2, so (0, 0) gives −bonus, never NaN); `(fx, fz)` is the unit forward the caller computed from the yaw (`[sin yaw, −cos yaw]`, `fly.ts:41`'s convention) — `core/`'s Math allowlist forbids trigonometry here (Spec corrections).
- Produces, in `rings.ts`:
  - `M_MESH = 1, M_L = 2, M_D = 4, M_T = 8, M_KEEP_MESH = 16, M_KEEP_VOXELS = 32, M_PROTO_RING = 64`; `KEEP_MESH_EXTRA = 1`, `KEEP_VOXELS_EXTRA = 5`;
  - `membershipTable(rd: number): Uint8Array` — side `2·(rd + 5) + 1`, index `(dz + R)·side + (dx + R)` with `R = rd + 5`, cached per rd; keepMesh `dx² + dz² ≤ (rd + 1.5)²`, keepVoxels `≤ (rd + 5.5)²`, protoRing = T and not L;
  - `assertTorusSafe(rd)` throws when `2·(rd + 5) + 1 > 64`.
- Produces, in `throttle.ts`: `THROTTLE_WINDOW = 60`, `THROTTLE_P95_MS = 16.7`, `THROTTLE_RISE_FRAMES = 120`, `THROTTLE_FAST_MS = 13`; `interface Throttle { push(frameMs: number, generating: boolean): void; cap(): number; setMax(n: number): void; readonly max: number }`; `createThrottle(o: { max: number }): Throttle` — `cap()` starts at `max`; on each push with ≥ 60 frames since the last restart and `generating`, a nearest-rank p95 (57th of 60) above 16.7 drops the cap by 1 (min 1) and restarts the window; 120 consecutive pushes under 13 ms raise it by 1 (max `max`) and restart that count; `setMax(n)` sets `max = max(1, n)` and clamps the cap; a 120-value ring and a 60-value scratch, preallocated.
- Produces, in `uploadBudget.ts`: `createUploadBudget(ms: number, rows: number, now: () => number): UploadBudget`, `UploadBudget = { start(): void; exhausted(): boolean; spend(rows: number): void; structural(): boolean; rowsSpent(): number }`; `exhausted()` when `ms` passed or `rows` spent; `structural()` grants one per frame and only while no row was spent this frame, **(plan)** and is uncapped (every call granted while the time lasts) when `rows` is `Infinity` (the loading screen's mode).

- [ ] **Step 1: Write the tests.**
  - `streamScore.test.ts` (forward east `(1, 0)` unless named): MESH bonus at (4, 0) → −0.5; (−4, 0) → 2.5; (2, 0) → 0.5 (no view term at d ≤ 2); (−1, 0) → −0.5; forward north `(0, −1)`, T bonus: (3, 4) → 5 (cos −0.8 clipped), (3, −4) → 2.6; T bonus at (0, 0) → 0; MESH bonus at (0, 0) → −1.5.
  - `rings.test.ts`: for every rd in [4, 16] the table's MESH, L, D, T counts equal `stageOffsets(rd)`'s and its keepMesh and keepVoxels counts equal `discOffsets(rd + 1)` and `discOffsets(rd + 5)`; MESH ⊂ keepMesh, T ⊂ keepVoxels; pinned: rd 4 keepMesh 97, keepVoxels 293, protoRing 104; rd 12 keepMesh 577, keepVoxels 973, protoRing 232; rd 16 keepVoxels 1,457 and side 43; `assertTorusSafe(26)` passes, `assertTorusSafe(27)` throws.
  - `throttle.test.ts` (max 3): "57 frames of 10 ms then 3 of 20 ms with generation in flight leave the cap 3; one more 20 ms frame drops it to 2"; "60 slow frames without generation change nothing"; "after a drop the window restarts: 59 more slow frames keep 2, the 60th drops to 1, then it stays 1"; "after a drop to 2 (60 frames of 20 ms with generation in flight), 120 frames of 10 ms raise it to 3; after the same drop, 119 frames of 10 ms then one of 13 ms leave it 2 (13 is not under 13)"; "setMax(1) clamps to 1; setMax(3) does not raise it; createThrottle({ max: 1 }) stays 1 (N = 2)".
  - `uploadBudget.test.ts`: `createUploadBudget(2, 32, now)`: after `start()`, `spend(31)` not exhausted, `spend(1)` exhausted; time: exhausted at 2 ms; `structural()` true once, false the second time, false after `spend(1)`; a new `start()` grants again; `createUploadBudget(12, Infinity, now)`: never row-exhausted, `structural()` true on every call while under 12 ms; SP4a's two tests kept with `(12, Infinity, now)`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `SP4B_MODULES` gains `[/^\s+engine\/\s/, 'throttle.ts (SP4b)', 'src/engine/throttle.ts']` and `[/^\s+core\/\s/, 'streamScore.ts (SP4b', 'src/core/streamScore.ts']`; master §1: the engine entry writes `throttle.ts (SP4b)`, and core's subtree gains a `streamScore.ts` line carrying spec §13's "(SP4b: the stage score shared by the coordinator and the section renderers' ready queue)"; §4.3 as listed.
- [ ] **Step 4: Run** `npm run typecheck && npm test` (arch's Math allowlist on `core/streamScore.ts` included). Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): the stream score, membership tables, the throttle and the row-capped upload budget`.

---

### Task 11: Coordinator I: slot table, classification, heaps, caps, intake, first fill

**Files:**
- Rewrite: `src/engine/coordinator.ts`; `test/unit/coordinator.test.ts` (the fakes `:29-75` extended with a camera, frames, a store model and a sink)
- Modify: `src/ui/world/worldPage.ts` (the first entry drives `update`/`firstFill`, `:535-559`; the `LoadError` import :38; `causeOf` :150-156 and `fail`'s details :414, which read the `fatal` event's `message` and `cause` in place of `LoadError`'s: a `StoreFullError` cause keeps the store-full text and the lower-RD link, and the details carry the cause's stack; the doc :23), `test/unit/coordinator.test.ts`'s `progressFraction`/`phaseName` tests (`:233-255`)
- Master: §4.1's `meshSeq` sentence (spec §13)

**Interfaces:**
- Produces (spec §3.13, made exact):
  ```ts
  interface StreamCamera { readonly x: number; readonly z: number; readonly yawDeg: number }
  interface JobOutcome { readonly versions: Int32Array | null; readonly payload: ColumnMeshPayload | null }
  interface CoordinatorJobs {
    run(stage: Stage, cx: number, cz: number, protoOnly: boolean): Promise<JobOutcome>;
    cancel(pred: (stage: Stage, cx: number, cz: number) => boolean): void;
    liveWorkers(): number;
  }
  interface StreamStore { versionsInto(cx, cz, out: Int32Array): void; holder(cx, cz): 'free' | 'self' | 'other'; freeColumn(cx, cz): void; freeProto(cx, cz): void }
  interface StreamSink { stage(p: ColumnMeshPayload, seq: number): void; remove(cx: number, cz: number): void }
  type StreamEvent =
    | { readonly kind: 'skipped'; readonly cx: number; readonly cz: number }
    | { readonly kind: 'storeFull'; readonly lowerRd: number | null }
    | { readonly kind: 'fatal'; readonly message: string; readonly cause: unknown };
  interface CoordinatorOptions { readonly jobs; readonly store; readonly sink; readonly throttle: Throttle; readonly rd: number; readonly rdMax: number; readonly retainAllProtos: boolean; readonly strict: boolean; readonly onEvent: (e: StreamEvent) => void }
  interface StageCounts { needed: number; done: number; inFlight: number; queued: number }
  interface CoordinatorCounts { T: StageCounts; D: StageCounts; L: StageCounts; MESH: StageCounts; dropped: number; failed: number; storeFull: number; collisionWaits: number; genCap: number; rd: number; cx: number; cz: number; yawDeg: number }
  interface Coordinator { update(cam: StreamCamera): void; setRenderDistance(rd: number): void; setStrict(on: boolean): void; firstFill(): boolean; counts(out: CoordinatorCounts): CoordinatorCounts; dispose(): void }
  function createCoordinatorCounts(): CoordinatorCounts;
  function createCoordinator(o: CoordinatorOptions): Coordinator;
  function worldJobsOf(pool: Pick<WorkerPool, 'terrain' | 'decorate' | 'light' | 'meshColumn' | 'cancelWorld' | 'liveWorkers'>): CoordinatorJobs;
  function progressFraction(c: CoordinatorCounts, uploadsDone: number, uploadsTotal: number): number;   // SP4a's weights over c[stage].done/needed
  function phaseName(c: CoordinatorCounts, uploadsDone: number, uploadsTotal: number): 'Generating' | 'Lighting' | 'Meshing' | 'Preparing the view';
  ```
  `CoordinatorCounts.cx`, `cz`, `yawDeg` are the last rebuild's centre column and yaw (the ready queue's, §3.9; Spec corrections). `LoadError`, `LoadProgress` and `load` go.
- Semantics:
  - **Validation first** (§7.6): `rd` and `rdMax` integers with `RD_MIN ≤ rd ≤ rdMax`, `assertTorusSafe(rdMax)`; `RangeError` before anything is allocated. No work runs inside a Promise executor.
  - **The slot table** (§3.1): preallocated typed arrays of 4,096 per slot `(cx & 63) + 64·(cz & 63)`: tracked `cx`, `cz` (`NO_COLUMN` = 0x7fffffff when none), stage (0-3), `meshed`, `meshSeq` (Uint32), `issuedSeq`, `busy` (0 none, 1 T … 4 MESH), `protoReaders`, `finalReaders` (Uint16), `protoAlive`, the window column and its flags, `retries`, `failed`, four heap positions.
  - **Classification** (§3.2): on a crossing or an RD change, every slot: per axis `c = camC + ((s − camC + 32) & 63) − 32`, flags from `membershipTable(rd)` (0 outside RD + 5).
  - **Heaps** (§3.3, D10): one binary heap per stage, `Int32Array` slots over `Float64Array` keys, ties by `colKey`; Floyd rebuild on a crossing, an RD change, or a turn **(plan, exact)** `|((yaw − lastYaw) % 360 + 540) % 360 − 180| > 30`; a newly eligible job is pushed with the last rebuild's centre and forward; `pump` takes the smallest top among stages whose cap allows another job, without popping held-back jobs, and re-checks eligibility at the pop.
  - **Eligibility** (§3.3): T for an Absent column of the T set whose record is `free`; D for a Proto column of the D set whose 3 × 3 are ≥ Proto with live protos; L for a Decorated column of the L set whose 3 × 3 are ≥ Decorated; MESH for a Published, unmeshed column of the MESH set whose 3 × 3 are Published; never busy or failed.
  - **Caps** (§3.8, D29): N = `jobs.liveWorkers()`; T + D + L in flight ≤ `throttle.cap()`; T ≤ max(1, N − 1); MESH ≤ N; total ≤ N.
  - **Intake** (§3.6): L on the nine `blockVersion`s, MESH on all 18, into one preallocated `Int32Array(18)` scratch; MESH also dropped unless its seq equals the slot's `meshSeq` and the column is still in keepMesh; a result for a column the slot no longer tracks is dropped; a dropped result counts in `dropped` and requeues. MESH stages through `sink.stage(payload, seq)` and sets `meshed`; **no path stages a revealed column again** (D16). After every settle (an accepted, dropped or rejected result) the coordinator pumps again within the caps, as SP4a's intake does (`coordinator.ts:310`), so a worker never waits for the next rAF (the RD 12 fill is 2,612 jobs: one batch per rAF would take about 10.9 s at 60 Hz with 4 workers, above G1's `mediumFill4wMs` ≤ 6000); `update` also pumps.
  - **First entry: strict mode** (spec §3.6, D12: "the first entry keeps SP4a's rule"): while `strict` (from the options, changed by `setStrict`), any job rejection (`JobCancelled` included, as SP4a), a dropped result, a MESH without a payload, `StoreFullError`, `WorkerFailed`, `StoreCorrupt`/`StoreCorruptError`, an intake exception and `liveWorkers()` decreasing emit `fatal` with the stage and column in `message` and the rejection (or null) as `cause`, without retries, and the coordinator stops issuing. Task 12's D12 policy applies only while not strict. The page creates the coordinator with `strict: true` and calls `setStrict(false)` at the reveal (Task 21).
  - **`firstFill()`**: every MESH column of the current set meshed and handed to the sink. **`dispose()`** **(plan)**: cancels queued world jobs (`jobs.cancel(() => true)`), stops issuing, frees every tracked column whose pins and `busy` are clear, and the rest as they settle; `update` after `dispose` is a no-op.
- The page (D21, partial): the coordinator is created with `strict: true` and a `createThrottle({ max: max(1, workers.size − 1) })` (Task 21 keeps that same throttle); the loading loop calls `coordinator.update({ x: at.x, z: at.z, yawDeg: 0 })` every frame and finishes when `firstFill()` and every region is built; a `fatal` event calls `fail` while loading (the failure panel, as SP4a's `LoadError` did); the sink stages into SP4a's `SectionRenderer` (`expect` the MESH disc, `stage(p)`); after the reveal the page does not call `update` yet (Task 21).

- [ ] **Step 1: Write the tests** (`coordinator.test.ts`; fakes: jobs settle on a manual tick in FIFO or LCG order, a store model of records with `holder`, versions and frees, a sink recording `stage`/`remove`, a counting `liveWorkers`).
  - "rd is validated before anything else: rd 3, 17 with rdMax 16, 4.5 and rdMax 27 throw RangeError".
  - "a fill at RD 4 around (0, 0) issues exactly 213 T, 157 D, 109 L and 69 MESH and stages 69 payloads; at RD 12, 825 / 705 / 593 / 489".
  - "the first job is T at the centre; MESH at the centre is issued before any T at distance 13" (SP4a's, with the yaw's forward column first among equal distances).
  - "the view term: at yaw 90 with columns (4, 0) and (−4, 0) both T-eligible, (4, 0) is issued first; (−3, 0) after (4, 0)".
  - "the cross-stage tie-break: an L at d 2 (score 1.0) and a T at d 1 (score 1.0) tie, broken by colKey" (§7.6 hand-over).
  - "D is never issued before its 3 × 3 are at Proto, L before Decorated, MESH before Published" (an invariant at every issue).
  - "caps: never more than genCap T + D + L, max(1, N − 1) T, N MESH, N in total".
  - "re-centring on a crossing: after moving one column east the sets follow and no job outside its set is issued".
  - "a turn below 30° rebuilds nothing; above 30° the forward columns come first".
  - "intake: a MESH whose versions moved is dropped and requeued (dropped 1); an L whose lightVersions moved but blockVersions did not is accepted; a MESH of an old meshSeq is dropped; a result for a column the slot no longer tracks is dropped".
  - "no revealed column is ever re-staged: over a fill, a crossing back and forth and an LCG settle order, sink.stage is called at most once per (column, meshSeq)".
  - "firstFill is false until the last MESH column of the set is staged".
  - "update after dispose is a no-op; dispose cancels queued jobs".
  - "every settle issues the next job: with fakes that settle synchronously, a fill at RD 4 completes within one update".
  - "strict: one INTERNAL, one JobCancelled, one dropped MESH and liveWorkers 2 → 1 each emit fatal (stage and column in the message, the rejection as cause) with no retry and no further issue".
  - **Review Focus 2:** "a turn from 355° to 5° counts 10° (no rebuild); 350° → 25° counts 35° (a rebuild); 10° → 340° counts 30° (no rebuild)" (observed through a rebuild counter in the counts or the issue order).
  - **Review Focus 3:** "a fill around column (−31,249, −31,249) at RD 4 issues 213 / 157 / 109 / 69 jobs, and a crossing one column west there classifies every slot's flags as the same crossing around (0, 0)".
  - **Review Focus 4:** "rotating the yaw by 45° every frame for 200 frames while jobs settle in LCG order never issues a job for a busy column nor the same (stage, column) twice before it settles; the fill completes".
  - `progressFraction` / `phaseName`: SP4a's values over `CoordinatorCounts`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the page's first-entry loop as above. Master §4.1's `meshSeq` sentence gains "(SP4b: per column, since one MESH_COLUMN job covers a column's sections; a result of an older seq is dropped)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts` (the `world` and `world-mesh` steps load through the new coordinator). Expected: PASS, the same smoke pass count as `main`.
- [ ] **Step 5: Commit** `feat(engine): the streaming coordinator's core (slot table, heaps, intake, first fill)`.

---

### Task 12: Coordinator II: pins, unloads, collisions, cancellation, errors, proto retention, live RD

**Files:**
- Modify: `src/engine/coordinator.ts`, `src/engine/renderDistance.ts` (`lowerRd` moved in from `ui/world/frameNotice.ts:20-23`, re-exported there), `test/unit/coordinator.test.ts`, `test/unit/renderDistance.test.ts`, `test/unit/frameNotice.test.ts`
- Master: §4.1's lock and single-writer sentences, §4.2's proto retention and unload, §4.3's cancellation and uploads (spec §13)

**Interfaces:**
- Semantics (spec §3.5-§3.8, §5):
  - **Pins** (D3): at issue, D adds 1 to `protoReaders` of its nine columns, L and MESH to `finalReaders`; every settle (reply, rejection, failure) subtracts them.
  - **Mesh unload:** a meshed column outside keepMesh → `sink.remove`, `meshed` 0, `meshSeq + 1`; ≤ 64 per update (`MESH_REMOVALS_PER_FRAME = 64`).
  - **Voxel unload:** a tracked column outside keepVoxels, not busy, pins 0 → `store.freeColumn` (a meshed one is removed first), the entry back to Absent with `failed` and `retries` cleared; ≤ 16 per update (`FREES_PER_FRAME = 16`); ordered by the score of the needed column the slot's window maps to (non-needed slots last). **(plan)** Candidates are re-collected on a crossing, an RD change and when a settle drops a pin of a column outside its keep set; at rest nothing is scanned.
  - **Record collisions:** a T whose record `holder` is `other` waits; each such T counts once per wait in `collisionWaits`. No `SlotBusy` reaches a worker.
  - **Cancellation** (D8): a column leaving its stage's set leaves the heap at the next pop or rebuild, and `jobs.cancel` drops its queued pool job; in-flight jobs finish and are judged at intake.
  - **Errors after the reveal** (D12; while not strict — before, Task 11's first-entry strict mode): `JobCancelled` and `WorkerFailed` requeue silently (a dead worker is not the job's fault; no retry is counted); another rejection (`INTERNAL`) requeues once, the second marks the column `failed` (skipped by every stage until its voxels unload) and the first such failure emits `skipped`; more than 32 failed columns (`FAILED_FATAL = 32`) emits `fatal`; `StoreFullError` pauses new T jobs until the next voxel unload frees a column, counts `storeFull` and emits `storeFull` with `lowerRd(rd)`; `liveWorkers()` 0, `StoreCorrupt` or `StoreCorruptError` emit `fatal`. The caps and `throttle.setMax(max(1, N − 1))` follow `liveWorkers()` whenever it changes.
  - **Proto retention** (D11, §3.7): with `retainAllProtos: false`, K's proto is freed (`store.freeProto`, at `protoReaders` 0, status ≥ Decorated) unless K is in the proto ring or a column of K's 3 × 3 in the D set is below Decorated; a D whose 3 × 3 holds a column at status ≥ 2 without a live proto first gets `run('T', cx, cz, true)` for it, at the D job's score; ≤ 16 proto frees per update, after the voxel frees **(plan)**.
  - **`setRenderDistance(rd)`** (§5): validated (`RangeError` outside [4, rdMax]); acts at the next `update` (re-classify, unloads, rebuild).
- Produces, in `renderDistance.ts`: `lowerRd(rd: number): number | null` (unchanged semantics: `max(RD_MIN, rd − 2)` above `RD_MIN`).

- [ ] **Step 1: Write the tests.**
  - "hysteresis at RD 4 after a fill: one column east and back removes no mesh and frees nothing; two columns east removes 9 meshes and frees 8 columns in that update".
  - "pins block frees: a column outside keepVoxels with an L of its neighbour in flight is freed only in the update after that L settles".
  - "a record collision waits for the far column's free: after a fill at RD 4 around (0, 0) and a jump to (64, 0), every new T collides, collisionWaits > 0, the frees take 14 updates (13 × 16 + 5) and the meshes 2 (64 + 5), the first T issued after the jump is (64, 0), and the T jobs issued after the jump come in nondecreasing score order (spec §8.5: the frees ordered by the slot's needed column)".
  - "cancel on leaving range: queued T jobs of columns that left the T set are cancelled through jobs.cancel; an in-flight one settles and is judged at intake (a T of a column outside keepVoxels is freed by the unload rule)".
  - "strict first, then D12: a strict coordinator emits fatal on one INTERNAL with no retry; after setStrict(false) one INTERNAL requeues".
  - "setRenderDistance(12) then setRenderDistance(10) before the next update: counts show MESH needed 349" (Review Focus 5).
  - "retries and the skipped column: one INTERNAL requeues, a second marks it failed and emits one skipped event; its neighbours' dependent jobs wait; 33 failed columns emit fatal".
  - "a failed column flown beyond keepVoxels and back is regenerated from scratch".
  - "StoreFull pauses T, counts 1, emits storeFull with lowerRd 10 at RD 12 and leaves the RD unchanged; the next voxel unload resumes T".
  - "caps follow liveWorkers: 4 → 3 sets genCap's max to 2; 2 → 1 keeps generating with genCap 1 and at most one job in flight; 0 emits fatal; the job rejected with WorkerFailed is requeued with no retry counted".
  - "StoreCorruptError emits fatal".
  - "proto retention on: a Decorated column outside the proto ring with no D needing it has its proto freed; a D that needs it issues T(protoOnly) first; a status-1 column outside the ring keeps its proto and is decorated when it re-enters the D set".
  - "setRenderDistance after a full RD 12 fill: to 8 removes 196 meshes over 4 updates (64, 64, 64, 4) and frees 248 columns over 16 updates (15 × 16 + 8); back to 12 needs 489 MESH again; 3 and 17 throw".
  - `renderDistance.test.ts`: `lowerRd(12)` 10, `lowerRd(5)` 4, `lowerRd(4)` null; `frameNotice.test.ts` unchanged through the re-export.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.1 ("the coordinator's reader pins are main-thread counters, not locks"; the single-writer parenthesis), §4.2 (proto retention, unload), §4.3 (cancellation; the uploads' structural sentence lands in Task 16).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): pins, unload hysteresis, collisions, error policy and proto retention`.

---

### Task 13: The in-process pool and the streaming integration test

**Files:**
- Create: `test/harness/inProcessPool.ts`, `test/integration/streaming.test.ts`
- Modify: `test/unit/perfHook.test.ts:130-138` (its `handlerWorker` moves to the harness)

**Interfaces:**
- Produces, in `inProcessPool.ts`: `inProcessWorker(): WorkerLike` — `createTaskHandler()` behind `WorkerLike`, replying on `setTimeout(0)` and calling Task 8's `drainAfterReply(handler, setTimeout)` after each reply.
- `streaming.test.ts`: the real coordinator and `createWorkerPool(2, spawnNode, { epochCells: store.epochs.cells, onWorkerDead })` (Task 7's checked `Int32Array`) over `buildNodeTaskWorker('worldJobs')`, whose `node-worker.mjs` drains after each reply (Task 8) (`test/integration/worldJobs.test.ts:36-48`'s `spawnNode` adapter) on a shared store, seed 42, the default profile, RD 4 around seed 42's spawn column (0, 0) (`uiSmoke.ts:475`'s `PARITY_VIEW`), `retainAllProtos: false`, `strict: true` until the first fill and `setStrict(false)` after it (as the page), a recording sink.

- [ ] **Step 1: Write the test.**
  - "after the first fill the 7 × 7 window centred on the spawn column (inside the RD 4 MESH disc) has `litRegionHash` (`test/harness/region.ts:153`) equal to `genRegion`'s at upTo 'L' over the same window";
  - "after flying 24 columns east (the start unloads: 24 > 9.5) and back, the window's hash is equal again, every D saw live protos (a wrapper around the jobs checks `store.proto` of the nine at each D's issue), at least one `T(protoOnly)` ran, and each regenerated column's proto blocks and fluid equal its final set's section by section (the final set shares the original proto's slots, D11, so this compares with the original)";
  - the test calls `store.drain()` after each `coordinator.update` of its frame loop and on every poll of the final wait (the main thread's once-per-frame drain, spec §2.5);
  - "after `dispose()` and every job settled, the test waits (bounded, 5 s) until every thread's limbo count in the reclaim buffer reads 0, then asserts every pool slot is free (`freeCount() === slotCount()`)".
  - About 10-15 s, timeout 120 s.
- [ ] **Step 2: Run** `npx vitest run --project integration test/integration/streaming.test.ts`. Expected: PASS (it covers Tasks 3-12; a failure is a defect in them, fixed here with a unit test in the owning module).
- [ ] **Step 3: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS.
- [ ] **Step 4: Commit** `test(engine): the real coordinator and pool against genRegion; the in-process pool`.

---

### Task 14: The mesh-job levers and the bench rows

**Files:**
- Modify: `src/mesh/column.ts` (`meshColumnPayload` :272-307, `finalOf` :167-171), `src/mesh/fluid.ts` (`fluidDepths` :164-200 returns whether the section holds fluid), `test/unit/meshColumn.test.ts`, `test/unit/meshFluid.test.ts`

**Interfaces:**
- Produces: `fluidDepths(nb, sy, out): boolean` — true when any voxel of the section holds fluid (false on the uniform-dry early return and when every depth is 0); `meshColumnPayload` builds **(plan)** one caching `NeighborhoodReader` per column whose `final(dx, dz)` returns the nine views fetched once, passes it to `isTrivial`, `copyPaddedSection` and `fluidDepths`, and skips `meshFluid` when `fluidDepths` returned false (D27). The payload is byte-identical.

- [ ] **Step 1: Write the tests.** "the payload with the levers equals SP4a's for every column of a 5 × 5 region of seed 42 lit to L (every array byte-equal)" (the old path kept in the test as a reference wrapper); "nb.final is called at most 9 times per column"; "fluidDepths returns false for a dry section and true for one with water".
- [ ] **Step 2: Run** them. Expected: FAIL (call count, return type).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, the goldens check, then on a quiet machine `npm run bench`. Expected: PASS; every row within +30 % of `test/baselines.json` and its absolute gates (`mesh.section` p50 ≤ 1.0 ms, p99 ≤ 2.5 ms). A missed absolute gate: STOP and report the numbers.
- [ ] **Step 5: Commit** `perf(mesh): fetch the nine views once per column; skip dry sections' fluid`.

---

### Task 15: `regionGrid.ts`: the shared row gathering and section bounds

**Files:**
- Modify: `src/render/regionGrid.ts`, `src/render/regionBatch.ts` (`sectionGeometry` :29-48, `buildRegion` :76-114), `src/render/regionMesh.ts` (`mergeRows` :48-101, `buildRegion` :127-164), `test/unit/regionGrid.test.ts` (new)

**Interfaces:**
- Produces, in `regionGrid.ts`: `interface PayloadRow { readonly p: ColumnMeshPayload; readonly o: number; readonly r: number }`; `rowsOfPass(payloads: readonly ColumnMeshPayload[], pass: number, out: PayloadRow[]): { vertices: number; indices: number }`; `rowBounds(p: ColumnMeshPayload, r: number, ox: number, oy: number, oz: number, sphere: Sphere, box: Box3): void` — the payload's sphere × 8 shifted by `(ox, oy, oz)` (1/8 units) and its cube clipped to the 128-unit section there, degenerate at the centre when empty (today's `regionBatch.ts:39-46` and `regionMesh.ts:81-91`).

- [ ] **Step 1: Write `regionGrid.test.ts`** on `fakePayload` rows: `rowsOfPass` lists a pass's rows in payload order with the sums; `rowBounds` at offset 0 equals RegionBatch's sphere and box today, and at `(ox, oy, oz)` RegionMesh's.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** and use the helpers in both renderers, behaviour unchanged.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS, both renderers' SP4a tests and the contract suite unchanged.
- [ ] **Step 5: Commit** `refactor(render): share the row gathering and section bounds in regionGrid`.

---

### Task 16: The streaming `SectionRenderer`, the staging and RegionBatch

**Files:**
- Modify: `src/render/sectionRenderer.ts` (the interface :36-62, counts :20-34), `src/render/regionGrid.ts` (`createRegionStaging` :24-146 replaced by the column staging), `src/render/regionBatch.ts`, `src/render/spike/spikeBench.ts` (:304-307, `longFrames` :390-399), `src/ui/world/worldPage.ts` (the load stages and pumps; `:612` `stats.mergeMs` taken from `counts(out).structuralMs` after the load, so `?flight`'s `load.mergeMs` keeps its key and `LoadStats` and `flight.test.ts:196` stay unchanged; `:712` the HUD's sections from `counts(out).rows` until Task 21), `test/unit/sectionRendererContract.ts`, `test/unit/regionBatch.test.ts`, `test/unit/regionMesh.test.ts` (its helper `:40-47` ported to stage/pump with an unbounded gate plus `revealAll`; the "counts().mergeMs accumulates" test `:253-256` becomes "counts(out).structuralMs is finite and ≥ 0"; Task 17 extends the same file), `test/unit/spikeBench.test.ts` (new: `spikeVerdict.test.ts` tests the verdict, not the bench), `test/arch/masterSpec.test.ts`
- Temporarily: `src/render/regionMesh.ts` adapted to the new interface with SP4a's region merge (re-merging a region on change) until Task 17
- Master: §1's render line (`renderer.ts sectionRenderer.ts (interface) …`, master :170) writes `sectionRenderer.ts (interface; SP4b: and UploadGate)`, pinned by the `SP4B_MODULES` row `[/^\s+renderer\.ts sectionRenderer\.ts /, 'sectionRenderer.ts (interface; SP4b: and UploadGate)', 'src/render/sectionRenderer.ts']`; §2.1's floating-origin parenthesis; §4.3's uploads parenthesis; §4.5's RegionBatch sentences (spec §13)

**Interfaces:**
- Produces, in `sectionRenderer.ts` (spec §4.1):
  ```ts
  interface UploadGate { exhausted(): boolean; spend(rows: number): void; structural(): boolean }
  interface RevealProbe { columns: number; partial: number; mixed: number }
  interface SectionRendererCounts { columnsStaged: number; columnsComplete: number; columnsRevealed: number; columnsRemoving: number; regions: number; rows: number; vertices: number; indices: number; structuralOps: number; structuralMs: number;
    lastStructural: 'create' | 'grow' | 'instances' | 'optimize' | 'compact' | null; lastStructuralBytes: number }   // reset at the start of each pump, set by the operation granted in it (Task 26's structuralFrames)
  interface SectionRenderer {
    readonly kind: SectionRendererKind; readonly root: Group;
    stage(p: ColumnMeshPayload, seq: number): void;   // replaces an unrevealed staged column; throws for a revealed one (D16)
    remove(cx: number, cz: number): void;             // hidden at once; rows released by pump under the gate
    pump(gate: UploadGate, cx: number, cz: number, yawDeg: number): number;  // rows spent
    holdReveals(hold: boolean): void; revealAll(): void;
    isRevealed(cx: number, cz: number): boolean;      // (plan) the fog's filled radius (Task 22)
    setOrigin(x: number, y: number, z: number): void; sortTranslucent(camX: number, camY: number, camZ: number): void;
    counts(out: SectionRendererCounts): SectionRendererCounts; gpuBytes(): number; probe(out: RevealProbe): RevealProbe;
    onColumnRevealed: ((cx: number, cz: number) => void) | null;   // SP11's fill-mask hook; no listener in SP4b
    dispose(): void;
  }
  function createSectionRendererCounts(): SectionRendererCounts; function createRevealProbe(): RevealProbe;
  ```
- Produces, in `regionGrid.ts`: the column staging both renderers share (per column: payload, seq, rows uploaded, revealed, removal pending; per region its live columns) and the ready queue: each upload takes the staged column with the smallest `streamScore(dx, dz, fx, fz, STAGE_BONUS.MESH)` from `(cx, cz, yawDeg)`, a linear scan with no allocation; `expect`, `buildNext` and "a region builds when all its columns are staged" go; a region whose last column is removed is disposed.
- Pump order **(plan)**: (1) restore `frustumCulled = true` on objects whose attributes hold no pending update range; (2) when the nearest staged row needs a structural operation (a region-pass object, growth, optimise/compact or an instance-table grow), request `gate.structural()` before any release and perform it on a grant (`structural()` grants only while no row was spent, Task 10, so requesting it after the releases would starve region creation whenever a removal backlog exists, i.e. every frame while flying at 96 blocks/s); (3) release removed rows (each counted against the row cap); (4) upload staged rows nearest-first, with no further structural operation in this pump (a row that still needs a refused or second structural operation waits); (5) reveal every column whose last row was uploaded in this call, all its rows in one call (`onColumnRevealed`). An object with any range written in this pump (rows uploaded, RegionMesh's reveal-frame index writes, removals' zeroed or released ranges) gets `frustumCulled = false` (§3.9). While `holdReveals(true)`, rows are uploaded visible inside the hidden root and `revealAll()` shows the root. **The probe** counts a row visible only when its instance (`getVisibleAt`) or its non-zero index range, its region object and `root` are all visible, so rows inside the hidden root never count as partial.
- RegionBatch (spec §4.2, D14): per region and pass `new BatchedMesh(1536, vertices, indices, material)` at the region's first row of that pass (structural); reservations opaque 131,072 / 196,608, translucent 16,384 / 24,576, cutout 8,192 / 12,288 on demand; `perObjectFrustumCulled` on; `mesh.position` = `(rx·128, −64, rz·128)` − origin; `boundingSphere` (centre (64, 192, 64), radius 212.26) and `boundingBox` set once; each row's instance matrix `T((cx & 7)·16, sy·16, (cz & 7)·16)·S(1/8)` set once; rows added hidden (`setVisibleAt(false)`); removal hides at once and `deleteGeometry` per row in `pump`; a row that does not fit: `optimize()` when the region's deleted space ≥ 40 % of its reservation, else `setGeometrySize(× 1.5)`; a full instance table: `setInstanceCount(× 1.5)`; `setOrigin` moves region positions only (O(regions)); `lastStructural`/`lastStructuralBytes` report `'create'`, `'grow'`, `'optimize'` or `'instances'` with the batch's byte size after it. `gpuBytes()` sums every live batch's attribute and index `array.byteLength` (Spec corrections: Uint16 index under 65,536 vertices).
- The spike (`?spike=batch`): stages every payload, pumps with an unbounded gate until nothing is left, then `revealAll`; `longFrames` entries become `{ frame, deltaMs, mainMs: main[i], prevMainMs: main[i − 1] | null }` (exported for its test); the spike is not re-measured.

- [ ] **Step 1: Write the contract suite** (`sectionRendererContract(kind)`, both kinds; `fakePayload` rows; a fake gate with a row cap and a structural slot; a fake clock):
  - "upload order is nearest-first from the camera with distinct distances: staged (5, 0), (1, 0), (3, 0) at yaw 0 upload in the order (1, 0), (3, 0), (5, 0)";
  - "the row cap: in a region whose opaque and translucent objects already exist (an earlier column with rows in both passes, uploaded and revealed under an Infinity-row gate), a column of 40 rows (24 opaque, 16 translucent, one per section and pass) with a 32-row gate uploads 32 rows in the first pump and 8 in the second; nothing of it shows after the first, and all 40 rows show after the second, in one call";
  - "structural before releases: with 40 rows pending release and a staged column in a new region, one pump under a 32-row gate creates the region's object and releases 32 rows; the column's rows upload in the following pumps and it is revealed";
  - "under holdReveals(true) with a 32-row gate and a column spanning two pumps, probe partial is 0 on every pump until revealAll";
  - "lastStructural: a pump that creates a region reports 'create' with the reservation's bytes (1,835,008 for batch, 2,359,296 for mesh), and the next pump reports null and 0";
  - "one structural operation per frame while flying: two new regions in one pump create one; the second waits for the next pump; under an Infinity-row gate both are created in one pump";
  - "removal: hidden at once (probe partial 0 in that frame), rows released under the gate, an emptied region disposed";
  - "re-staging an unrevealed column replaces it; staging a revealed column throws";
  - "a column removed and re-staged at another seq shows exactly its new rows once revealed; probe mixed 0";
  - "an object with rows written in a pump has frustumCulled false until its attributes hold no pending update range (cleared as three's upload does), and true again at the next pump";
  - "holdReveals: complete columns stay hidden in the hidden root; revealAll shows the root in one call";
  - "the probe is 0 (partial and mixed) on every frame of a seeded random stage/remove/pump sequence of 400 frames";
  - "origin rebase: with a revealed column in region (1, 0) and the origin at (0, 0, 0), `setOrigin(512, 0, 0)` moves that region's objects to (−384, −64, 0), leaves every row's instance matrix (batch) or vertex range (mesh) unchanged, and the probe stays 0"; "counts and gpuBytes: a region with one opaque row — batch 1,835,008 bytes, mesh 2,359,296";
  - **Review Focus 3:** "column (−31,249, −31,249) is in region (−3,907, −3,907); with the origin at (−499,712, 0, −499,712) its object position is (−384, −64, −384)".
  - `regionBatch.test.ts`: "reservations: the first opaque row creates a batch with maxInstanceCount 1,536, 131,072 vertices and a Uint32 index of 196,608; the first translucent row 16,384 vertices and a Uint16 index of 24,576 (gpuBytes 180,224 for that batch); cutout on demand 8,192 / 12,288"; "a row that does not fit grows the batch to 196,608 / 294,912 when deleted space is under 40 % and optimizes at or above it, one per pump"; "the 1,537th instance waits for setInstanceCount(2,304)"; "instance-id reuse: delete and re-add, then rebase: every instance matrix is still its section offset × 1/8 (no NaN)"; "removal releases at most 32 rows per pump".
  - `spikeBench.test.ts`: `longFrames` on frame deltas [16, 16, 50, 16] and main [1, 2, 9, 3] gives one entry `{ frame: 2, deltaMs: 50, mainMs: 9, prevMainMs: 2 }`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, with the page's load on `stage`/`pump`/`holdReveals(true)`/`revealAll` under `createUploadBudget(12, Infinity, …)` and RegionMesh adapted (its merge kept until Task 17, so the contract cases RegionMesh cannot pass yet are marked `kind === 'mesh' ? test.todo` and enabled in Task 17). Master §1's render line, §2.1, §4.3 (uploads), §4.5 (RegionBatch) as spec §13.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts`. Expected: PASS; the smoke's parity check still within 1 %.
- [ ] **Step 5: Commit** `feat(render): the streaming section renderer; RegionBatch reservations and region-local instances`.

---

### Task 17: RegionMesh's arena

**Files:**
- Modify: `src/render/regionMesh.ts`, `test/unit/regionMesh.test.ts`, `test/unit/sectionRendererContract.ts` (the `test.todo`s enabled)
- Master: §4.5's Fallback paragraph (spec §13)

**Interfaces:**
- Produces (spec §4.3, D15): per region and pass one `Mesh` over one `BufferGeometry`: `position` `BufferAttribute(Uint16Array, 4)` region-local, `data` Uint32, a Uint32 index, of the RegionBatch reservations (opaque 131,072 / 196,608: 2,359,296 bytes), created at the region's first row of that pass (structural); `setDrawRange(0, index high-water)`; each column's rows of a pass take one vertex range and one index range, first-fit from a free list sorted by start and coalesced on release; uploading writes vertices (positions rewritten region-local, `data` copied) and zero indices; the reveal frame writes the rebased indices; removal zeroes the index range and frees both ranges; **every range write is `addUpdateRange(start, count)` plus `needsUpdate = true`**; a full arena compacts in place (`copyWithin`, indices rebased, `clearUpdateRanges()` then `needsUpdate`) when free space ≥ 40 %, else grows × 1.5 into a new `BufferGeometry` with `mesh.geometry = next` and `prev.dispose()` in the same frame; the sphere is the union of live columns' spheres, recomputed on add or removal; translucent `renderOrder` back to front (`regionMesh.ts:194-205`). `structuralMs` times each structural operation, and `lastStructural`/`lastStructuralBytes` report it (`'create'`, `'grow'`, `'compact'`, with the arena's new byte size; Task 16's contract).

- [ ] **Step 1: Write the tests.** "the free list: first fit, coalescing on release (three ranges, free the middle and the first: one range from 0)"; "a column is hidden by zero indices until the reveal frame, then its rebased indices are written"; "update ranges are exactly the written ranges, with needsUpdate set (attribute version + 1)"; "compaction at ≥ 40 % free space moves the live columns down in place (same arrays, no reallocation) and uploads the whole attribute"; "growth below 40 % builds a new geometry of 196,608 vertices and 294,912 indices, disposes the old (its dispose event fired), and gpuBytes() equals the new arena's 3,538,944 bytes"; "counts().structuralOps and structuralMs grow on each"; the contract suite passes on 'mesh'.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.5's Fallback parenthesis.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts`. Expected: PASS; parity within 1 %.
- [ ] **Step 5: Commit** `feat(render): RegionMesh's per-region arena with column ranges`.

---

### Task 18: Renderer: unculled uploads, warm-up, GPU timer, far plane, `data-renderer`, first origin

**Files:**
- Modify: `src/render/renderer.ts` (`createGpuTimer` :123-163 exported and its disjoint path :140-152, `withSectionsShown` :229-242 exported for its test, `warmUp` :270-272, the far plane :205, the first origin :206, `WorldRendererOptions` :102-113, the initial uniforms :192), `src/render/floatingOrigin.ts:1-6` (doc, `firstOrigin`), `src/ui/world/worldPage.ts` (passes the spawn), `test/unit/renderer.test.ts` (new, pure exports only; `viewport.test.ts` is the precedent), `test/unit/floatingOrigin.test.ts`

**Interfaces:**
- Produces: `createGpuTimer(gl: WebGL2RenderingContext): (GpuTimer & { dispose(): void }) | null` exported; on a `disjoint` read every pending query is deleted and `poll` returns null; `withSectionsShown(root: Object3D, fn)` exported **(plan: lifted out of `createWorldRenderer` with the root as a parameter)**; `withRegionsUnculled(root: Object3D, fn)` exported (sets `frustumCulled = false` on every region object, runs `fn`, restores, also on a throw), which `warmUp` uses; `applyRenderDistance(camera: PerspectiveCamera, rd: number): void` exported (`far = cameraFar(rd)`, projection updated), which `WorldRenderer.setRenderDistance(rd: number): void` calls; in `floatingOrigin.ts`, `firstOrigin(at: { x: number; z: number }): FloatingOrigin` (the origin at the snapped spawn), which `createWorldRenderer` uses for `WorldRendererOptions.originAt: { x: number; z: number }`; the canvas carries `data-renderer="batch"` or `"mesh"` (asserted only by the browser smoke, Task 24: `createWorldRenderer` needs WebGL, the DOM and `ResizeObserver`, which the Node unit project lacks, `vitest.config.ts:11`); `WorldRenderer.gpuEstimate(out: { sectionsBytes: number; skyBytes: number; textureBytes: number; lightmapBytes: number; drawingBufferBytes: number }): typeof out` — `sectionsBytes` is `sections.gpuBytes()`, the others from the objects' own sizes (the sky geometry's attribute and index `byteLength`s, the texture array's width × height × depth × 4 with mips if any, the lightmap's data `byteLength`, the canvas's width × height × 8), computed by an exported pure `gpuEstimateOf(parts, out)` that the method calls; Tasks 21 (HUD `gpuMB`) and 26 (`geometryMB` = sections + sky, `texturesMB` = texture array + lightmap, `drawingBufferMB`) consume it.

- [ ] **Step 1: Write the tests** (pure exports only). `createGpuTimer` with a fake `gl` (fake queries, an extension, a `GPU_DISJOINT_EXT` flag): "a disjoint deletes every pending query, available or not, and poll returns null"; "without the extension, null"; `withSectionsShown` on a `Group` of `Mesh`es with `fn` standing in for compile and warmUp: "hidden objects are hidden again after fn and after a throw"; `withRegionsUnculled`: "frustum culling is off inside fn on every region object and restored after, also after a throw"; `applyRenderDistance(camera, 10)`: "camera.far is 288 and the projection matrix updated"; `floatingOrigin.test.ts`: "firstOrigin of spawn (1,100, −700) is (1,024, 0, −512)"; `gpuEstimateOf` with fake parts: "each field from its object's sizes".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `floatingOrigin.ts:5`'s comment: "the spawn sets the first origin (`snap`)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(render): warm-up and new rows drawn unculled, the disjoint timer, the live far plane`.

---

### Task 19: Materials: no edge fade, fog end (RD − 1)·16, zero-allocation uniforms

**Files:**
- Modify: `src/render/materials/index.ts` (`EDGE_FADE` :42-43, `fogRange` :45-49, `setFrameUniforms` :112-130), `src/render/materials/uniforms.ts` (:15-19, :35-37, :59-61), `src/render/materials/glsl/common.glsl.ts` (`applyFog` :67-82, the edge term :70-72, :76), `src/render/frameState.ts` (:13-18), `src/render/lightmap.ts` (:33-48, :54-71), `src/render/frameTiming.ts` (`medianInterval` :31-37), `src/render/fpsLimiter.ts:45`, `src/daynight/dayNight.ts` (`skyColorsInto`, `sunDirectionInto`), `src/render/renderer.ts:192`, `src/ui/world/worldPage.ts` (`frameState` :588-595), `src/render/spike/spikeBench.ts:125` (its `FRAME` literal loses `edgeCentre`), `src/core/params/graphicsPresets.ts:19` (doc), `test/unit/materials.test.ts` (:5 the `EDGE_FADE` import, :21 `FRAME`, :155-171, :182), `test/unit/lightmap.test.ts`, `test/unit/frameTiming.test.ts`, `test/unit/dayNight.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §4.6's fog sentence (spec §13, the user chose D17); pin in `describe('master spec amendments (SP4b §13)')`: §4.6 contains `SP4b: end (RD − 1)·16, start 64 blocks before, no edge fade`

**Interfaces:**
- Produces: `fogRange(rd: number, band: number, out: { start: number; end: number }): { start: number; end: number }` — `end = (rd − 1)·16`, `start = max(0, end − band)`, written into `out`; `FrameState` loses `edgeCentre` and its `rd` doc reads "the fog's render distance, fractional while a raise eases (spec §5)"; `skyColorsInto(t, zenith: Float64Array, horizon: Float64Array): void` and `sunDirectionInto(t, out: Float64Array): void` beside the allocating versions; `medianInterval(deltas: ArrayLike<number>, scratch?: Float64Array, n = deltas.length)` copies and sorts the first n values in `scratch[0, n)` with an insertion sort (no subarray, no allocation); `fpsLimiter.ts:45` calls `medianInterval(deltas, scratch, count)` with a preallocated 30-value scratch in place of `deltas.subarray(0, count)`, and so does the frame step (Task 21); `setFrameUniforms` allocates nothing; the lightmap rebuilds **(plan, exact)** only when `round(dayFactor·512)`, `round(duskFactor·512)` or the brightness changed, into preallocated `tint` and `curve` arrays (`lightmap.ts:35-36` no longer allocate).

- [ ] **Step 1: Write the tests.** `materials.test.ts`: the fogRange test (`:155-159`) becomes "`fogRange(12, 64, out)` → { start: 112, end: 176 } and returns `out` itself; rd 8 → 48-112; rd 4 → 0-48", the `EDGE_FADE` import and assertion go; "setFrameUniforms at rd 12: the fog spans 112-176 (`:162-171`); no edge, edgeFadeStart or edgeCentre uniform on any material"; the shared-uniform list (`:182`) without the three; "the GLSL has no edge term" (`applyFog` source contains no `edge`). `lightmap.test.ts`: "two times whose day and dusk factors round to the same 1/512 rebuild nothing (the texture's version unchanged); a brightness change rebuilds". `frameTiming.test.ts`: `medianInterval` with a scratch returns the same values and writes into the scratch; with n < scratch.length (odd and even n) it equals the allocating result over the first n values. `dayNight.test.ts`: the `Into` variants equal the allocating ones at t 0, 1/12, 0.25, 0.5, 0.75.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, migrating every `FrameState` builder. Master §4.6: "SP4b: end (RD − 1)·16, start 64 blocks before, no edge fade; after a live RD raise the end follows the filled radius outward".
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): fog end (RD − 1)·16 without the edge fade; frame uniforms without allocation`.

---

### Task 20: Horizontal flight; R, the clamp and the edge notice removed

**Files:**
- Modify: `src/player/fly.ts` (doc :3-11, `FlyBounds` :15-16, `stepFly` :61-118, `atEdge` :120-123, `EDGE_EPS` :31-32), `src/player/keymap.ts` (`Action` :12-14, `DEFAULT_KEYMAP` :42; the labels :32-37 carry the flight text the help's Keys section renders, `help.ts:46-62`: forward "Forward (at your height)", back "Back (at your height)", up "Rise", down "Descend"), `src/ui/loading/tips.ts` (:8-24; the first two templates, "forward follows your look" and "whatever way you look", are replaced by the new flight tip), `test/unit/help.test.ts`, `test/arch/masterSpec.test.ts`, `src/ui/world/worldPage.ts` (`bounds` :574-577, `WorldNotices.edge` :235-278, `case 'loadHere'` :776-777, `notices.edge` :808, the doc :21-31), `test/unit/fly.test.ts` (:74, :115-146), `test/unit/keymap.test.ts` (:9, :54), `test/unit/tips.test.ts`, `test/unit/worldReload.test.ts` (:146-155)
- Master: §4.17's flight sentence, §5.9's R removed (spec §13); pin in the SP4b describe: §4.17 contains `creative-style flight`, and the master no longer contains `R (load the world around you`

**Interfaces:**
- Produces: `FlyBounds = { yMin: -64; yMax: 400 }`; `stepFly(s, held, dtS, bounds)` moves forward and back along `forwardXZ(yaw)`, strafes along `forwardXZ(yaw + 90)`, normalises only the horizontal pair (dx, dz), applies the vertical axis on its own at the speed; `atEdge` and `loadHere` go; the R key is unbound; `TIP_TEMPLATES`' edge tip is replaced by "The world loads around you as you fly; change the render distance in Help ({help}) → Settings." and the flight tip reads "{forward} {back} fly forward and back at your height, {left} {right} strafe; {up} and {down} rise and descend."

- [ ] **Step 1: Write the tests.** `fly.test.ts`: "W at pitch −45° keeps its height" (replaces :74); "strafe is level"; "W with D never exceeds the speed (|v_xz| ≤ 12 after 2 s)"; "W with Space keeps the full horizontal speed while climbing (the horizontal distance after 2 s equals W alone's)"; "no horizontal limit: at x 500,000 and z −500,000, W moves on" (replaces :115-146); y clamped to −64 … 400 (kept). `keymap.test.ts`: no `loadHere`, nothing bound to `KeyR`. `tips.test.ts`: the key map has 13 entries (`:13`: 14 → 13), every action named, the new tip present, no "edge". `help.test.ts`: the Keys rows read "Forward (at your height)" and "Rise". `worldReload.test.ts`: the edge-notice test goes; `hereUrl` and the reloader tests stay (the context-loss Reload uses them).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.17 ("creative-style flight: …") and §5.9 (R removed).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `grep -rn "atEdge\|loadHere\|edgeCentre" src/`. Expected: PASS; the grep prints nothing.
- [ ] **Step 5: Commit** `feat(player): horizontal flight; drop the edge clamp, the edge notice and R`.

---

### Task 21: The page: first entry on the coordinator, the streaming frame, errors, HUD

**Files:**
- Create: `src/ui/world/frameStep.ts`, `test/unit/frameStep.test.ts`
- Modify: `src/ui/world/worldPage.ts` (the loop :795-821, `fail` :421-430, `skyLightAt` :158-170, `motionBlockingAt` :172-178, `hasWaterAt` :180-188, the HUD closure :705-725, the doc; `WorldNotices` :236-300 gains `skipped` and `failed`), `src/ui/hud.ts` (`HudData` :25-48 and its text), `test/unit/hud.test.ts`, `test/unit/worldPage.test.ts`, `test/unit/worldReload.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §5.8's HUD sentence ("SP4b: the streaming counts"); pin in the SP4b describe: §5.8 contains `SP4b: the streaming counts`

**Interfaces:**
- Produces, in `frameStep.ts` (spec §7.2):
  ```ts
  interface FrameStepDeps {
    readonly fly: FlyState; held(): ReadonlySet<Action>; paused(): boolean;
    readonly clock: FrameClock;                         // createFrameClock(limiter, notice, start): the rendered dt or null
    readonly coordinator: Pick<Coordinator, 'update' | 'counts'>; readonly counts: CoordinatorCounts;
    readonly throttle: Throttle; readonly budget: UploadBudget;
    readonly sections: Pick<SectionRenderer, 'pump'>;
    readonly world: Pick<WorldRenderer, 'origin' | 'camera' | 'frame' | 'sections'>;
    readonly store: Pick<VoxelStore, 'enterRead' | 'exitRead' | 'lightAt' | 'drain'>;
    readonly state: { t: number; brightness: number; eyeSky: number; rd: number; fogBand: number };  // the one reused FrameState
    timeSpeed(): number; fogStep(dtMs: number): number;  // Task 22's easing; until then the target RD
    onRendered(dtMs: number): void;
  }
  function createFrameStep(d: FrameStepDeps): { tick(now: number): void };
  ```
  Each rAF: the raw delta snapped to the display interval (a 30-delta window and `medianInterval(deltas, scratch, count)`) is pushed to `throttle` with `generating` = T + D + L in flight > 0 in `counts` (the previous tick's), before the FPS limiter (Spec corrections: the throttle is fed every rAF tick; Review Focus 1); `stepFly` (unless `paused`), `coordinator.update`, `coordinator.counts(counts)` (into the one reused object); on rendered ticks only: `budget.start()`, `sections.pump(budget, counts.cx, counts.cz, counts.yawDeg)`, the floating origin and `setOrigin`, `store.drain()`, the eye light (`enterRead`, `lightAt(...) >> 4` or 15 for −1 and above y 319, `exitRead`), the time, `state.rd = fogStep(dt)`, `world.frame(state)`.
- The page:
  - **First entry** (§7.1, §3.11): store, pool (`?workers`), `attachStore`, `configure`, the centre from `?at` or `spawn`; `createWorldRenderer({ …, originAt })`; the throttle `createThrottle({ max: max(1, workers.size − 1) })`, created before the coordinator and passed in its options (not fed before the reveal, so it stays at max); the coordinator at the centre with `retainAllProtos: true` (D11) and `strict: true` (Task 11), `holdReveals(true)`, `update` and `pump` under `createUploadBudget(12, Infinity, …)` every loading frame, the loading bar from `progressFraction(counts, columnsComplete, MESH needed)`; when `firstFill()` and every staged column is complete: `compile`, `firstView` (from `store.heightAt('motionBlocking', …)`, +∞ for null), three warm-up frames, `revealAll`, `holdReveals(false)`, `coordinator.setStrict(false)`, the fade, "Click to fly"; `stats.first120MaxMs` keeps recording the largest delta of the first 120 rendered frames, now from the frame step's `onRendered` (unchanged meaning and key; `LoadStats`, `?flight` and `flight.test.ts:196` unchanged); Task 26's bench reports it under the key `first120RenderedMaxMs`.
  - **After the reveal:** `createFrameStep` with `createUploadBudget(MEDIUM.uploadBudgetMs, MEDIUM.uploadSections, …)` and the first entry's throttle.
  - **Errors** (§7.4, D12): `onEvent` `skipped` → a dismissible notice "Some terrain could not be generated" with "Copy details"; `storeFull` → a dismissible notice offering "Lower to RD n" (applied live in Task 22; until then the link reloads); `fatal`, an exception escaping the frame step (today's catch at :815-819) and the pool's `onFailure` with no live worker → the failure panel with "Copy details" and a reload link (`fail` no longer returns after the reveal, :422). The loading screen's panel (`loading.fail`, :428) is gone after the reveal (`loading.dispose`/`fadeOut` remove it, `loadingScreen.ts:134-139`, `:166-175`) and has no reload link, so after the reveal `fail` stops the loop, calls `releaseOnFailure` and shows `notices.failed(cause, details(e), here(null))`; before the reveal it keeps `loading.fail`.
  - **Exports for the tests** (`mountWorldPage` hard-wires the capability probe, the browser pool and WebGL, `:473`, `:496`): `WorldNotices` gains `skipped(details: string): void` (shown once, dismissible, with "Copy details") and `failed(cause: string, details: string, reloadHref: string): void` (a panel with the cause, "Copy details" and a Reload link through the reloader, `reloadLink`, shown once); `storeFull(lower: number | null, apply: () => void)` (a dismissible notice with a "Lower to RD n" button, without the button when `lower` is null at RD 4; until Task 22 the page's `apply` reloads at `lower`). `worldPage.ts` exports `handleStreamEvent(e: StreamEvent, o: { notices: WorldNotices; fail(cause: string, e: unknown): void; lower(rd: number): void }): void`, which the page's `onEvent` calls.
  - **HUD** (§7.3): `HudData` gains `stages` (per stage done / needed / in flight / queued), `revealed`, `genCap`, `dropped`, `failed`, `rdTarget`, `rdFog`, `liveWorkers`, `regions`, `gpuMB` (the sum of `world.gpuEstimate(out)`'s fields / 2^20, Task 18); its text contains `revealed <n>`, `RD <target> (fog <rdFog.toFixed(1)>)`, `genCap <n>`, `dropped <n>`, `failed <n>`, `workers <live>/<size>`, `regions <n>`, `GPU <x.x> MB`.
  - With `opts.flight` (`?flight=sp4a`) the page stops calling `update` after the reveal (SP4a's static route).

- [ ] **Step 1: Write the tests.** `frameStep.test.ts` (fakes): "update runs on every tick, pump and render only on rendered ticks (a 30 fps cap at 60 Hz renders every other tick)"; "the order on a rendered tick: update, pump, origin, drain, eye light inside one read section, render"; "a −1 from lightAt reads as sky 15"; **Review Focus 1:** "with the FPS cap at 30 and 16.667 ms ticks for 600 ticks with generation in flight, the throttle is fed 16.667 ms on every tick and genCap stays at its maximum". `hud.test.ts`: the new strings. `worldPage.test.ts` (`handleStreamEvent` with `createWorldNotices` over `test/unit/fixtures/domShim`): "a fatal stream event calls fail with its message and cause"; "a skipped event shows one dismissible notice with Copy details (a second skipped shows nothing new)"; "a storeFull event with lowerRd 10 shows the notice whose button calls lower(10); with lowerRd null, no button". `worldReload.test.ts` (modelled on `contextLost`'s): "notices.failed is shown once, its Reload link goes through the reloader, and Copy details is present".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §5.8's HUD counts gain "SP4b: the streaming counts".
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the streaming frame, the first entry on the coordinator, errors after the reveal`.

---

### Task 22: Live render distance and the fog easing

**Files:**
- Create: `src/ui/world/fogEase.ts`, `test/unit/fogEase.test.ts`
- Modify: `src/ui/world/worldPage.ts` (`applySettings` :728-739, the slow notice :680, `WorldNotices.slow` :279-294), `src/ui/world/frameNotice.ts` (doc), `src/ui/help.ts` (the label :136 "Render distance", `HelpOptions.onSettings` doc :19-20, `HelpOptions.rdMax: number` (also the select's cap), the System section appends after `renderCapabilityReport` (:157-159) a row "Render distance maximum <rdMax>" — the table itself lives in `capabilityReport.ts`, keyed by `CapabilityReport` and shared with the error screen, so it is not touched; `Help.setRd(rd: number | null): void` (`Help` :37-41) updates the help's settings copy (:112) and `#setting-rd` without calling `onSettings`), `test/unit/help.test.ts`, `test/unit/worldReload.test.ts` (the slow-notice test), `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts`
- Master: §4.16's Live sentence (spec §13); pin in the SP4b describe: §4.16 contains `the render distance live since SP4b, within the reservation's cap`

**Interfaces:**
- Produces, in `fogEase.ts`: `FOG_EASE_BLOCKS_PER_S = 32`, `FILL_SCAN_FRAMES = 30`; `filledRadius(cx: number, cz: number, rd: number, isRevealed: (cx: number, cz: number) => boolean): number` — scans `discOffsets(rd)` in spiral order; the first unrevealed offset at distance d gives `ceil(d − 0.5) − 1`; all revealed gives rd; `createFogEase(rd: number): { setTarget(rd: number): void; step(dtMs: number, filled: number): number; readonly target: number }` — `step` returns the fog's RD: while below the target it moves outward at ≤ 32 blocks/s (≤ 2 RD/s), never past `filled` nor the target, never inward; a lower target sets the fog end to min(current, the new end) at once **(plan, Review Focus 5)**.
- The page (spec §5): RD in [4, `rdMax`], `rdMax = min(16, reservationRdCap(caps.reservation))`; a change (help select, the slow notice's "Lower to RD n", StoreFull's "Lower to RD n") calls `coordinator.setRenderDistance(rd)`, `world.setRenderDistance(rd)`, `fog.setTarget(rd)` and saves the setting; "Default (n)" applies the resolved default; the slow-frame notice and StoreFull's notice offer a live action (a button), never automatic; the filled radius is evaluated every 30 rendered frames.
- Produces, in `worldPage.ts` (testable without `mountWorldPage`): `createRdControl(o: { coordinator: Pick<Coordinator, 'setRenderDistance'>; world: Pick<WorldRenderer, 'setRenderDistance' | 'camera'>; fog: { setTarget(rd: number): void }; help: Pick<Help, 'setRd'>; save(rd: number | null): void; defaultRd: number }): { apply(rd: number | null): void }` — `null` is "Default" (saved as null, applies `defaultRd`); every `apply` calls `help.setRd`, so a notice's lower RD never leaves the help with a stale copy that a later FOV or brightness change would send back through `onSettings` (spec §5: nothing changes the saved RD except the user). `WorldNotices.slow` becomes `slow(rd: number, lower: number, apply: () => void)` (a button instead of the reload link) and `WorldNotices.storeFull`'s action (Task 21) now applies live. The page wires the help's `onSettings`, the slow notice and StoreFull to `apply`.

- [ ] **Step 1: Write the tests.** `fogEase.test.ts`: "filledRadius: an unrevealed column at (5, 0) gives 4, at (3, 4) 4, at (4, 4) 5; all revealed gives rd"; "raise 8 → 12 with every ring filled: the fog end goes 112 → 176 in 2.0 s (120 steps of 16.667 ms, 0.5333 blocks each) and stops"; "with the filled radius at 10 it stops at 144 until the radius grows"; "never inward while the filled radius shrinks after the target is reached"; **Review Focus 5:** "raise 8 → 12, 30 frames later (fog end 128) lower to 10: the fog end stays 128, eases on to 144 and stops; lowering to 8 at 128 gives 112 at once". `worldPage.test.ts` (`createRdControl` with fakes, the real `cameraFar` through Task 18's `applyRenderDistance`): "apply(10) applies live: coordinator.setRenderDistance(10), world.setRenderDistance(10), fog target 10, saved 10, no navigation, and camera.far 288"; "apply(null) after RD 8 applies the default 12 and saves null"; **Review Focus 5:** "apply(12) then apply(10) before the fog settles: the last setRenderDistance on the coordinator and the world is 10, and camera.far is 288"; "the slow notice's action lowers the RD live to lowerRd(rd)" (`createWorldNotices` over the dom shim); "after the slow notice lowers 12 → 10, changing the FOV in the help keeps RD 10 (no setRenderDistance(12)) and #setting-rd shows 10". `help.test.ts`: the label is "Render distance" (no "(reloads)"), the select's maximum is `rdMax`, the System section's "Render distance maximum <rdMax>" row text; "setRd(10) updates #setting-rd without calling onSettings".
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.16: "(the render distance live since SP4b, within the reservation's cap)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): live render distance with the fog easing outward`.

---

### Task 23: Zero allocation at rest

**Files:**
- Create: `test/unit/zeroAlloc.test.ts`

**Interfaces:**
- Measures allocation, not retention (Spec corrections; `terrainHeap.test.ts`'s `used()`, `:28-34`, runs `gc()` twice before every reading, so short-lived objects are never counted): `--expose-gc` through `v8.setFlagsFromString`; warm up (N calls), then `gc()` twice and read `space_used_size` of the heap spaces without `code|trusted|shared_trusted` (`new_space` included); start `new v8.GCProfiler()`; run the N calls; read the spaces again **with no gc in between**; stop the profiler. The run counts only if the profiler recorded no GC; retry up to 3 times, and if all 3 attempts saw a GC the test fails (a scavenge during N calls at rest already means far more allocation than the bound). Growth < 256 KB (`ZERO_ALLOC_MAX = 256 * 1024`) over N = 10,000 calls: under 26 B per call. A 120 s timeout.

- [ ] **Step 1: Write the test.** "10,000 `coordinator.update` calls at rest after a fill (fake jobs, no movement, no arriving results) grow the heap by less than 256 KB"; "10,000 frame steps at rest (a real coordinator at rest, `pump` with nothing staged on a real RegionBatch, a real `MaterialSystem`'s `setFrameUniforms` with the time running at ×60, the FPS limiter and frame timing) grow it by less than 256 KB". Written to tolerate load (no wall-clock bound).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/zeroAlloc.test.ts`. Expected: PASS on Tasks 10-22's code; if it fails, find the allocation, fix it in its module with a unit test, and rerun.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `test(engine): zero allocation at rest for update and the frame step`.

---

### Task 24: Browser smoke: `stream` and `data-renderer`

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` :441-446, the `world` and `world-mesh` steps), `test/unit/uiSmoke.test.ts`

**Interfaces:**
- `world` and `world-mesh` assert the canvas's `data-renderer` equals the forced or expected renderer.
- New step `stream`, after `world-mesh`: one `stream` step (a single `t.step`, as `world-mesh`, since the runner refuses a repeated id, `uiSmoke.ts:1070`) that runs `/?rd=4&renderer=batch`, then `…=mesh`, each: after the reveal, click the canvas, hold W for 4 s with real key input (CDP `Input.dispatchKeyEvent`); assert the HUD position moved more than 40 blocks (12 blocks/s × 4 s ≈ 47), the HUD's `revealed <n>` grew, no console error; then open the help (H) and choose 6 in `#setting-rd`: the HUD shows `RD 6` and a larger `revealed` within 30 s, with no navigation (a token set on `window` at mount is unchanged); save `stream.png` (and `stream-mesh.png`).

- [ ] **Step 1: Write the tests.** `uiSmoke.test.ts:233-243`: the exact list gains `stream` between `world-mesh` and `console`; the pin `world-mesh` = console − 1 becomes `stream` = `world-mesh` + 1 and `stream` = console − 1; the test title names SP4b's `stream`; the pure parser of the HUD's `revealed (\d+)` and `RD (\d+)` lines.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"`. Expected: every step passes on both renderers.
- [ ] **Step 5: Commit** `test(ui): the stream smoke step on both renderers; data-renderer asserted`.

---

### Task 25: R7: `stream.metric.ts` and its row

**Files:**
- Create: `test/metrics/stream.metric.ts`
- Modify: `test/thresholds.ts` (R7), `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs` (`render` gains `stream.metric.ts`), `test/unit/shards.test.ts` (Task 2's metricShards pin: `render` gains `test/metrics/stream.metric.ts`), the SP4b spec's Threshold log, master §1's `test/` entry (`(SP4b: metrics/stream.metric.ts, harness/inProcessPool.ts, integration/streaming.test.ts, integration/columnTableFuzz.test.ts)`) and §6.4's R7 row, `test/arch/masterSpec.test.ts`

**Interfaces:**
- Row: `R7: { partialColumnFrames: { max: 0, activeFrom: 'SP4b' } }` (every tier).
- `metricTest('R7', ['partialColumnFrames'], …)` (spec §8.1, D24): a shared store, `createWorkerPool(2, inProcessWorker)`, the real coordinator with a throttle that is never fed (Node has no frame time; `genCap` stays at its maximum), `retainAllProtos: true`, `strict` until `firstFill` then `setStrict(false)`, each of `createSectionRenderer('batch' | 'mesh', …)` in turn without a `WebGLRenderer`, a fake clock advancing 0.05 ms per uploaded row behind `createUploadBudget(2, 32, now)`; a frame = `update`, one event-loop turn, `pump`, `probe`. Script (seed 42, default profile; RD 6 on quick and full, RD 4 on fast): the first entry at the spawn until `firstFill` and its reveal; 60 frames east at 1 column per 2 frames; a 90° turn; 60 frames north at 1 column per frame; a jump of 64 columns west until the disc refills; quick and full: RD 6 → 4 for 20 frames, then 6 until refilled; fast: RD 4 → 5 until refilled, then 4 for 20 frames.
- Values: `partialColumnFrames` (gated); recorded `frames`, `revealed`, `removed`, `structuralOps`, `dropped` (expected 0), `collisionWaits` (asserted > 0 in the metric), `mixedColumnFrames` (0), `rowsPerPumpMax` and `rowsPerPumpMean` (over both renderers' pumps; `metricTest`'s run returns `Record<string, number>`, `test/harness/metric.ts:77-80`); and an assertion that the first T jobs after the jump are issued nearest-first.

- [ ] **Step 1: Write the metric and the row in one go.** `masterSpec.test.ts`: "§6.4's R7 row names `partialColumnFrames` and the SP4b flight part, and THRESHOLDS holds it activeFrom SP4b" (the Z-row pattern, `:378-399`); "§1's test entry lists SP4b's test files in their own parentheses, which exist" (the four files).
- [ ] **Step 2: Run** `npx vitest run --project metrics-fast test/metrics/stream.metric.ts`. Expected: PASS with `partialColumnFrames` 0 (about 5 s).
- [ ] **Step 3: Govern.** `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP4b Task 25: R7 partialColumnFrames max 0, gated from SP4b on every tier (stream.metric.ts, spec §8.1-§8.2); a new part.` Master §6.4's R7 row as spec §13 words it.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then `node .github/scripts/metricShards.mjs check`. Expected: PASS; R7 20-30 s on the quick tier; `metricShards` prints `shards cover the 14 metrics-quick files exactly once`, with `stream.metric.ts` in `render`.
- [ ] **Step 5: Commit** `test(metrics): R7, the atomic reveal while streaming`.

---

### Task 26: The `?bench=medium` route and `measureChrome --route bench`

**Files:**
- Create: `src/ui/world/bench.ts`, `test/unit/bench.test.ts`
- Modify: `src/main.ts` (:55-66, `?bench=medium`), `src/ui/world/worldPage.ts` (`WorldPageOptions.bench`), `test/tools/measureChrome.ts` (`MeasureArgs.route` :58, `parseMeasureArgs` :71-110, `outputName` :114-118, `routePath` :120-126, `readResult` :262-265, `ASSETS` :55, a `benchLine`), `test/unit/measureChrome.test.ts`, master §5.8's bench-route sentence, master §1 (the `ui/world/bench.ts` token of spec §13 in the `ui/world/*` entry: the `?bench=medium` route and its JSON, SP4b), `test/arch/masterSpec.test.ts`

**Interfaces:**
- Produces, in `bench.ts` (spec §8.3, D22):
  - `BENCH_SEED = '42'`, `BENCH_RD = 12`, `BENCH_Y = 150`, `BENCH_PITCH = -15`, `BENCH_TIME_SPEED = 60`, `BENCH_IDLE_FRAMES = 120`;
  - `BENCH_LEGS: readonly BenchLeg[]`, `BenchLeg = { name: 'L0' | … | 'L6'; seconds: number; speed: number; headings: readonly number[]; rdSteps: readonly { atS: number; rd: number }[] }`: L0 hover 5 s; L1 heading 90 at 20 b/s, 20 s; L2 headings 180, 270, 0, 90 at 20 b/s, 2.5 s each (instant 90° turns **(plan)**); L3 heading 0 at 96 b/s, 30 s; L4 heading 0 at 384 b/s, 5 s; L5 hover 10 s; L6 hover 15 s with RD 8 at 0 s and 12 at 5 s; the yaw equals the heading and is kept while hovering; a leg covers [start, end), so at a leg boundary the pose is the next leg's;
  - `benchPose(tS: number, start: { x: number; z: number }, out: { x: number; y: number; z: number; yaw: number; pitch: number }): { leg: number; rd: number }`;
  - `BENCH_FRAME_CAPACITY = 32768` (95 s at 240 Hz is 22,800 frames); `createBenchRecord(capacity: number): BenchRecord` — one preallocated `Float64Array` column per frame field (`leg`, `rawMs`, `snappedMs`, `mainMs`, `coordinatorMs`, `uploadMs`, `rows`, `structuralKind` (0 none, 1-5 create / grow / instances / optimize / compact), `structuralMB`, `gpuMs` (NaN without the timer query), `calls`, `triangles`, `geometryMB`, `texturesMB`, `drawingBufferMB`, `heapMB`, `sabMB`, `partial`, `mixed`, `genCap`) and a count `n`, so recording a frame allocates nothing; `BenchFixed` = the identity fields, `load`, the totals `{ dropped, failed, storeFull }` and `refillMs: number | null`;
  - `summarizeBench(rec: BenchRecord, fixed: BenchFixed): BenchResult`, with every key of spec §8.3: identity fields (`route: 'bench=medium'`, seed, profile, rd, workers, sectionRenderer, userAgent, renderer, vendor, multiDraw, timerQuery, screen, dpr, displayIntervalMs); `load` (`revealMs`, `stageMs`, `longTasks`, `first120RenderedMaxMs` = the page's `stats.first120MaxMs`, Task 21); `stream` over L1-L6 (`frames` {count, p50, p95, p99, max, over33}, `main` {p50, p95, max}, `coordinatorMs` and `uploadMs` {p95, max}, `rowsPerFrameMax`, `structuralOps`, `gpuMs` or null, `drawCalls` {max, mean}, `trianglesMax`, `gpuMB` with `geometryMB` (sections' `gpuBytes()` + the sky's geometry), `texturesMB` (the texture array + the lightmap) and `drawingBufferMB` (`width × height × 8`) **(plan: the breakdown's grouping)**, each summed from Task 18's `world.gpuEstimate(out)` fields, the breakdown taken at the frame where `gpuMB` peaks, `heapMB`, `sabMB`, `partialColumnFrames`, `mixedColumnFrames`, `genCapMin`, `dropped`, `failed`, `storeFull`); `legs` (the same frame figures per leg); `L5.refillMs` (from L5's start to the first frame at which `filledRadius(camera column, 12, sections.isRevealed)`, Task 22, evaluated every frame during L5, is 12; null if L5 ends first); `L6.frames`; `longFrames` (each snapped frame over 33 ms: raw delta, own and previous main ms, leg); `structuralFrames` (kind, renderer, MB, main ms, GPU ms or null, snapped frame ms; kind and MB from the pump's `counts(out).lastStructural` and `lastStructuralBytes`, Tasks 16-17);
  - `interface BenchDriver { readonly record: BenchRecord; pose(tS: number, out: BenchPose): number | null; done(fixed: BenchFixed): void }` (`BenchPose` = `benchPose`'s `out`): `WorldPageOptions.bench?: BenchDriver`; the page calls `pose` before each frame step (its result is the RD the script wants, applied through Task 22's `createRdControl.apply` when it changes; null ends the script, and the page calls `done`), and writes each rendered frame's fields into `record` at `record.n++`;
  - `mountBenchRoute(app: HTMLElement, query: URLSearchParams): Promise<void>` — the world page with `opts.bench`: the stored settings unread (no FPS cap, FOV 70), no HUD, input, help or notices, the time from 08:00 at ×60; after the reveal 120 idle frames give the display interval; then the page's own frame step runs with the pose set by `benchPose` each frame and the probe recorded; `window.__wiBench = { result }` and a "Download JSON" button. **(plan)** `&shot=<name>` (`fly96` at L3 + 15 s, `fly384` at L4 + 2.5 s, `rd12` at L6 − 0.5 s, `rd8` at L6 + 1 s, `rd12back` at the first frame after L6 + 5 s at which the fog's RD is back at 12 (the disc refilled, spec §8.7), else at L6's end, `first` after the reveal) freezes the script there with the HUD hidden and sets `__wiBench.shotReady` three frames later.
- Produces, in `measureChrome.ts`: `route: 'spike' | 'flight' | 'bench'`; `--workers 4` on flight and bench; `--shot <name>` on bench only, and only with `--renderer batch|mesh` (the shot's file name comes from that flag); `outputName`: `bench-<gpu>-chrome.json`, `bench-iris-chrome-w4.json`, `review-<shot>-<renderer>.png` for a shot; `routePath`: `/?bench=medium[&workers=4][&renderer=…][&shot=…]`; `ASSETS = 'docs/superpowers/specs/assets/sp4b'` **(plan: every route now writes there; SP4a's files stay where they are)**; `readResult` reads `__wiBench`; a shot is captured with `Page.captureScreenshot` once `shotReady`.

- [ ] **Step 1: Write the tests.** `bench.test.ts`: "the legs sum to 95 s"; "L1 flies 400 blocks east (benchPose at 25 s: x = start + 400)"; "L2's four headings are 90° apart and the square closes (benchPose's x and z at 35 s equal those at 25 s; y and pitch unchanged)"; "L3 flies 2,880 and L4 1,920 blocks north (z at 65 s = start − 2,880, at 70 s = start − 4,800)"; "L6's RD is 8 from 80 s and 12 from 85 s"; "y 150 and pitch −15 throughout"; `summarizeBench` on a synthetic `BenchRecord`: every key present, `over33` counts a snapped 33.3 ms frame at 240 Hz (8 intervals) and not a 29.2 ms one (7), `gpuMB` = the breakdown's sum. `measureChrome.test.ts`: `parseMeasureArgs(['--route','bench','--workers','4'])`; `--shot fly96` refused without `--route bench` and without `--renderer`; `outputName` for the bench, w4 and shot cases; `routePath` with every flag.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `SP4B_MODULES` gains `[/^\s+ui\/world\/\* /, 'ui/world/bench.ts', 'src/ui/world/bench.ts']`, and master §1's `ui/world/*` entry names `ui/world/bench.ts` (SP4b: the `?bench=medium` route and its JSON). Master §5.8's bench route as spec §13 words it. `CLAUDE.md`: `?bench=medium` and `npm run measure:chrome -- --route bench` (its cells, `assets/sp4b`).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; then, on a quiet machine, `npm run measure:chrome -- --route bench --gpu iris --probe-only`. Expected: PASS; the probe prints the Iris renderer (or refuses under the 'nvidia' profile, which is the cue for Task 27's stop).
- [ ] **Step 5: Commit** `feat(ui): the ?bench=medium streaming route; measureChrome --route bench`.

---

### Task 27: GPU cells (Chrome, agent): bench files, re-measured flight, G1's streaming rows

**STOP for the user before Step 1:** the PRIME profile on **on-demand** (the user switches it and logs out and in), the display awake and unlocked, the laptop panel eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp4b/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `bench-rtx-chrome.json` (and any `-tune<k>` files), the review screenshots `review-<shot>-batch.png` and `review-<shot>-mesh.png`
- Modify: `test/thresholds.ts` (G1), `test/thresholds.lock.json` (generated), `test/metrics/g1.metric.ts` (a new `ASSETS_SP4B` = `../../docs/superpowers/specs/assets/sp4b/` for `GATED`, the re-measured `flight-iris-chrome.json`, and the bench files of the second call; `ASSETS` :19 (`assets/sp4a/`) kept for `OTHERS` :21, which stay in `assets/sp4a`; `read` takes the directory; the header comment :8-17 updated to match; a second call), the SP4b spec's Threshold log, master §4.18, §6.4's G1 row, §7 and §8 risk 17 (spec §13), `test/arch/masterSpec.test.ts`

**Interfaces:**
- Rows: `G1` gains `mediumStreamP95: { max: 16.7, activeFrom: 'SP4b' }`, `mediumStreamOver33: { max: 0, … }`, `mediumStreamDrawCalls: { max: 100, … }`, `mediumStreamMainP95: { max: 6, … }`, `mediumFill4wMs: { max: 6000, … }`, `mediumGpuMB: { max: 150, … }`; SP4a's three static parts unchanged.
- `g1.metric.ts`: the static call (`G1`) reads `assets/sp4b/flight-iris-chrome.json` through `ASSETS_SP4B` (SP4a's other flights stay recorded in `G1.others`, read from `assets/sp4a/` through `ASSETS`); a second call `metricTest('G1', ['mediumStreamP95', 'mediumStreamOver33', 'mediumStreamDrawCalls', 'mediumStreamMainP95', 'mediumFill4wMs', 'mediumGpuMB'], …, { outName: 'G1.streaming' })` reads `bench-iris-chrome.json` and `bench-iris-chrome-w4.json`, checks their shape (route `bench=medium`, renderer /Iris/, section renderer `batch`, rd 12, profile `default`, workers 4 in the w4 file, the `gpuMB` breakdown fields, `structuralFrames` present with every entry's snapped frame ≤ 33 ms, `partialColumnFrames` and `mixedColumnFrames` 0) and returns `stream.frames.p95`, `stream.frames.over33`, `stream.drawCalls.max`, `stream.main.p95`, the w4 file's `load.revealMs`, `stream.gpuMB`; the RTX and Firefox bench files are recorded in `.out/G1.streaming.others.json` when present, each with `stream.frames.p95`, `stream.frames.over33`, `stream.drawCalls.max` and `stream.heapMB + stream.sabMB` (for the RTX file, the High-preset parts of spec §8.4, recorded at Medium for SP11), and each checked for `partialColumnFrames` and `mixedColumnFrames` 0.

- [ ] **Step 1: Measure (an agent, quiet machine, touching no other process).**
  - `npm run measure:chrome -- --route bench --gpu iris`
  - `npm run measure:chrome -- --route bench --gpu iris --workers 4`
  - `npm run measure:chrome -- --route flight --gpu iris` (SP4a's static route on SP4b's code, now into `assets/sp4b/`)
  - `npm run measure:chrome -- --route bench --gpu rtx` (NVIDIA offload and ANGLE Vulkan, P59/P60)
  Expected: four JSON files.
- [ ] **Step 2: Tune if a cell misses** (spec §8.4): any G1 streaming part, a `structuralFrames` entry over 33 ms, or the RTX's `stream.frames.over33` > 0 or `stream.frames.p95` > 16.7. Levers in order: the row cap 32 → 16; structural operations only in frames with no rows; a growth split into a CPU-copy frame and a first-render frame; larger reservations; RegionMesh's compaction threshold; the throttle's thresholds; the pixel-ratio cap. Re-measure after each step and commit its JSON as `bench-<gpu>-chrome-tune<k>.json`. **If it still misses: STOP** and report every JSON to the controller for the user; no gate is loosened.
- [ ] **Step 2b: Review screenshots** (spec §8.7, Spec corrections: the review shots need a GPU), in the same on-demand session, after the tuning so the shots show the tuned code: 1920 × 1080, by the agent through `npm run measure:chrome -- --route bench --gpu iris --shot <name> --renderer batch` and `--renderer mesh` for `fly96`, `fly384`, `rd12`, `rd8`, `rd12back` and `first`. They are committed with Step 5's commit; Task 28's exit evidence describes each.
- [ ] **Step 3: Add G1's streaming rows, the metric's second call and the artifacts in one commit.** `masterSpec.test.ts`: "§6.4's G1 row names the six streaming parts THRESHOLDS holds activeFrom SP4b"; "no 'first playable' is left in §4.18, §6.4, §7 or §8". `npm run test:accept-thresholds`; Threshold log: `- 2026-10-2X — SP4b Task 27: G1 mediumStreamP95 max 16.7, mediumStreamOver33 max 0, mediumStreamDrawCalls max 100, mediumStreamMainP95 max 6, mediumFill4wMs max 6000 and mediumGpuMB max 150, gated from SP4b on every tier from the committed Iris Xe Chrome bench files (g1.metric.ts, G1.streaming; spec §8.2, §8.4, D23); the static cells re-asserted from assets/sp4b/flight-iris-chrome.json; all new parts (measured <p95> / <over33> / <calls> / <main> / <fill> / <MB> on eDP-1 at 240 Hz).` Master §4.18, §6.4's G1 row (incl. the RTX sentence), §7's first-entry and streaming lines, §8 risk 17, as spec §13 words them.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with G1 and G1.streaming asserted; the RTX cell checked by the controller against `over33` 0 and p95 ≤ 16.7 (D23).
- [ ] **Step 5: Commit** `feat(sp4b): the Chrome bench cells and G1's streaming rows` (the JSON and the review screenshots staged by explicit path).

---

### Task 28: Firefox cells (user), RTX check, review shots, exit evidence, docs

This task is mostly the controller's; the implementer prepares and the user measures.

**Files:**
- Commit: `assets/sp4b/bench-iris-firefox.json`, `bench-rtx-firefox.json` (the user's downloads), `selftest-firefox.json` (the review screenshots are Task 27's)
- Modify: master §10's SP4b cut line and the Default receivers worded by whether the cut was taken, `test/arch/masterSpec.test.ts` (the cut-line pin), the SP4b spec (`## Exit evidence`, Status), `CLAUDE.md` (`:9`, the unit shards, `?bench=medium`, `measure:chrome --route bench`, the R key and "Render distance (reloads)" gone), `README.md` (`:9`, an SP4b paragraph)

- [ ] **Step 1: Firefox cells (STOP for the user).** The controller builds and serves its own `npx vite preview --port <a free port, never 5183>` (started and stopped by the controller only) and gives the user `http://localhost:<port>/?bench=medium`. Under **on-demand** the user runs it in Firefox on the Iris Xe and downloads the JSON, and runs `?selftest=1` on the same preview (59/59: spec §10's "the world unchanged" in Firefox before the merge; production's run is Step 6); then switches to the **'nvidia'** profile (log out and in), the controller restarts its own preview if the session change stopped it, and the user runs the RTX cell. The controller commits each file under the GPU the user names and checks D28: `stream.frames.p95` ≤ 25, `stream.drawCalls.max` ≤ 100, `stream.frames.over33` 0, `partialColumnFrames` and `mixedColumnFrames` 0. A cell outside goes back through §8.4's tuning (re-measuring the Chrome cells too) and, still missing, back to the user with the numbers.
- [ ] **Step 2: Review screenshots** (spec §8.7): taken in Task 27 Step 2b under on-demand (the 'nvidia' switch of Step 1 would make `--gpu iris` refuse; Spec corrections: the review shots need a GPU). The exit evidence describes each.
- [ ] **Step 3: Exit checks** (spec §10).
  - `npm run build && npm test && npm run test:metrics:full` (R7 on every tier);
  - `git diff main -- test/goldens.json` is empty; `GENERATOR_VERSION` 5;
  - `?selftest=1` 59/59 in Chrome (uiSmoke) and Bun (`npx --yes bun@1 test/tools/goldensJsc.ts`);
  - `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` (parity, `stream` on both renderers);
  - `npm run bench` within its gates and +30 % (Task 14);
  - `grep -rn "edgeCentre\|atEdge\|loadHere" src/` prints nothing.
- [ ] **Step 4: Master and docs.** The cut line: deferred reclamation was built, so the SP4b entry's cut line says "It was not taken: deferred reclamation shipped in SP4b, so nothing moved" and the receivers read "SP4b deferred-reclamation primitive → SP5 (delivered in SP4b, so nothing moved)" (if it was cut instead: SP5's entry gains "SP5 builds it first …" and the receiver stays "→ SP5"), pinned in `masterSpec.test.ts` as `:670-672` pins SP4a's. The SP4b spec's `## Exit evidence` (before the Threshold log): the first sharded run (Task 2), the exit run's wall time and each job's slowest files against §9; every G1 cell with its file; the RTX Chrome cell: over33 and p95 against D23, and its p95 and heapMB + sabMB at Medium recorded as the High-preset parts for SP11; the Firefox cells; R7 per tier; the bench rows; the review shots described; the masterSpec pins of 'master spec amendments (SP4b §13)'. Status: "implemented, awaiting CI, the production check and the user's check". `CLAUDE.md:9` and `README.md:9`: SP4b implemented, awaiting those.
- [ ] **Step 5: Commit** `docs(sp4b): exit evidence, the cut line, Firefox cells`.
- [ ] **Step 6: The controller, with the user's go-ahead:**
  1. Merge `sp4b/streaming` to `main` and push; check CI green and record its wall time in the exit evidence.
  2. Production: the deployed build streams in Chrome (RegionBatch) and Firefox (RegionMesh); the user runs `?selftest=1` in Firefox on production (59/59) and the controller commits `assets/sp4b/selftest-firefox.json`.
  3. The user's check: flying around, and a long way in one direction, without stutter on the Iris Xe and on the RTX 3060 Mobile, and the render distance changed live.
  4. A final commit marks SP4b complete (`CLAUDE.md:9`, `README.md:9`, the spec's Status).

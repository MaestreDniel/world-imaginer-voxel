# SP5c — The selection tool: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Q turns on the selection tool. LMB and RMB mark two corners on the aimed blocks up to 32 blocks away; a yellow box with its size shows the volume, through terrain too. Ctrl+C copies it, Ctrl+X cuts it, N moves it (the place it leaves goes back to the terrain), Ctrl+V pastes the clipboard as a translucent ghost that rests on the aimed surface, with the blocks it would replace in red and the count of blocks it changes; the wheel turns it 90° (logs, ladders and wall torches turn with it), ↑ and ↓ raise and lower it, RMB pastes, LMB cancels. Each cut, paste and move is one undo step, persisted with the world. The clipboard is one per browser in IndexedDB `wi10`'s `meta` store and survives reloads, terrain changes and switching worlds. Underneath: linear validation and sub-batches of 1,024 edits in the sim, a `copy` message, the history capped by its total edits. The three SP5b notes are done (Rename's Save, the Modify terrain notice, the reminder on disabled parameters). Size L, as the user chose ("L, completo"). The generated world does not change (`GENERATOR_VERSION` 5, the 59 goldens byte-identical).

**Architecture:**
- **Sim.** `sim/edits.ts`: `validate` linear through a `Map` (D20); `applyEdits` in sub-batches of `SUB_BATCH` 1,024 with a drain between them, a headroom check before a large batch and a compensating pass on a late `StoreFull`, so a batch stays all or nothing (D21); `readVolume` for the new `copy` message; `MAX_STEP_EDITS`, the one declaration of the cap (Spec correction 1). `workers/protocol.ts` and `simHandler.ts`: `copy`/`copied` (a box outside the world answered `outside`, never BAD_MESSAGE) and the `edits` guard's length cap (D22, §3.3). `engine/simClient.ts`: `copy()` and the `copied` guard.
- **Measured first** (D31): bench rows `paste.max` and `paste.maxLit` in Node, both batch orders timed, and D31's rule keeping 32,768 or lowering the cap to 16,384, all before any code uses the cap (Task 5).
- **The page's model, pure.** `ui/world/clipboard.ts` (the clipboard and its turns: `rotateState` with the position map), `persist/clipboard.ts` (`ClipboardV1` by state keys, D24), `ui/world/clipboardStore.ts` (where it lives: `meta['clipboard']` through a KV, or memory; D15, D26), `ui/world/pasteBatch.ts` (changed cells only, the move's merge with its reverts, bounds and refusals, the cap, the body), `ui/world/selectTool.ts` (modes, corners, labels, the anchor, the throttled target read).
- **The edit path and the autosave.** Bulk batches open no latency sample and show "Working on n blocks…"; `bulkPending()`; the autosave's tick and a navigation's flush wait for a pending bulk batch up to `BULK_SETTLE_WAIT_MS` 5,000 ms (D23). The history keeps 100 steps per side and at most `MAX_HISTORY_EDITS` 65,536 edits in all (D14).
- **Keys.** Code bindings gain `ctrl?: boolean` (AltGr refused); nine actions in a `select` group; the placing context shares the plain wheel between slots and turns and claims ↑ ↓ only while placing (D4).
- **Rendering.** `render/selection.ts`'s `createVolumeBox` (drawn twice: depth-tested, and dimmed through terrain); the ghost material (`GHOST` define: alpha, `ghostTurns`, the 0.6 light floor) in `render/materials`; `render/ghost.ts` (the sliced main-thread mesh build, at most one 16³ cell past 1 ms per frame, and the replaced-cell `InstancedMesh`); all driven through `WorldRenderer` methods and compiled behind the loading screen.
- **The page.** `worldPage.ts`: the click queue's tool branch, the aim's reach 32, the hold repeat bypassed, and **(plan)** `createSelectActions` (the copy, cut, paste and move flows, exported as `createClickQueue` and `leaveAfterSave` are, so `openPersistWorld` drives the page's own path).
- **Measurement.** `test/metrics/clipboard.metric.ts` (`L3.paste`, `E3.paste`, `E5.paste`) in a new metrics-quick shard `clipboard`; the integration paste; bench leg L12 and `G2.paste` from the committed Iris Xe Chrome file in `assets/sp5c/`, every Chrome route re-measured there (D30); the smoke's `select` step and the changed `menus` and `modify` steps.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24.21 (`worker_threads`), three r186 (`~0.186.1`), the tools' own Chrome over CDP, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md` (approved 2026-11-01; the binding authority, with the user's answer under Points for the user: Point 1, size L as specified, "L, completo", so the move key, the replaced-block overlay and bench leg L12 with `G2.paste` are all in scope). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Recon behind the spec: `.superpowers/sp5c/recon-{obligations,engine,ui,tests}.md`, `review-technical.md`, `review-fidelity.md`, `builder-check.md`, `revise-notes.md` (git-ignored; the controller has them). Template: the SP5b plan.

**Plan form.** Compact, as SP4a's to SP5b's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (what it consumes and produces, with exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies (sketched only for the sub-batch loop with its compensating pass, the turned cell's source index and the ghost's slice loop, whose orders the tests do not fully pin); the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` 12f47f5 (code identical to b56dae5, the spec's citation base: `git diff --stat b56dae5 12f47f5` touches only the spec).

**Spec corrections found while planning** (numbered as the tasks cite them; each folded in by the task named, the first one when it names two; the controller rewords the spec in that task's commit, whose `git add` includes `docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`):
1. **`MAX_STEP_EDITS` cannot live in `blockHistory.ts` for the sim's guard** (§3.3 "`parseToSim`'s `edits` guard … refuses a batch longer than 32,768 (`MAX_STEP_EDITS`)"; §5 "`MAX_STEP_EDITS` … in `blockHistory.ts`, mirrored in `saves.ts`"): `workers/` value-imports `L2_CORE`, `metrics`, `daynight` and `workers` only (`test/arch/rules/imports.ts:27`), never `ui/`. The cap is declared once, `export const MAX_STEP_EDITS = 32_768` in `src/sim/edits.ts` (the sim layer, which `workers`, `persist` and `ui` may all value-import, `imports.ts:24`, `:27`, `:32`), and imported by `protocol.ts`, `blockHistory.ts` and `saves.ts`; `MAX_HISTORY_EDITS` = 65,536 is declared in `blockHistory.ts` and mirrored in `saves.ts` (persist cannot import ui), pinned equal by `test/unit/stateBounds.test.ts` beside `:29`'s step pin. Task 6, Task 13.
2. **The limbo cases need a shared store** (§10.5 "`limboMax` at most 4,096 for a maximum paste" and the two "really full store" cases, on `simEdits.test.ts`'s region): that region is `genRegion({… threads: 1})` (`test/unit/simEdits.test.ts:96`), whose store is unshared (`test/harness/region.ts:457`, `shared: o.shared ?? o.threads === 4`), and an unshared store's `retire` frees at once (`src/world/store/reclaim.ts:189`, `if (!shared || noReader())`), so `limboMax` would read 0 there and the test would pass with the sub-batches dropped. The paste describe builds its own region with `shared: true`, and the full-store cases use `createStore({ shared: true, maxBlockBytes, maxByteBytes })`. Task 3, Task 4.
3. **The `edited` reply carries the sub-batch figures** (§3.2 adds only `EditResult.limboMax`; §10.4's L12 records per operation "the sim's `editMs`, `relightMs`, longest sub-batch and `limboMax`", which reach the page only through the reply): `EditResult` and `EditedMsg` gain `limboMax` and `subBatchMaxMs`, checked by `parseFromSim`'s `edited` case (`src/workers/protocol.ts:871-877`) and copied by the handler (`src/workers/simHandler.ts:428-433`). Task 3.
4. **The drain between sub-batches needs read depth 0** (§3.2 "calls `exitRead` and `enterRead` … so the retired slots are reclaimed between sub-batches"): `exitRead` drains only when it closes the outermost read section (`reclaim.ts:182`, `if (--depth > 0) return;`). The sim handler calls `applyEdits` at depth 0 (`simHandler.ts:428`); every test, metric and bench row that reads `limboMax` calls it outside any read section, and `applyEdits`' comment says so. Task 3.
5. **At most 25 `editState` reads, not 49** (§6.4 "at most 49 `editState` reads"; §2.5 "`editState` over the 3 × 3 of every column the box covers (at most 7 × 7 columns …)"): `editState(cx, cz)` already checks its column's whole 3 × 3 (`src/engine/coordinator.ts:1551-1562`), and a 64-wide box covers at most 5 columns a side, so the check is one `editState` call per covered column: at most 25 calls, covering at most 7 × 7 columns. Task 16.
6. **`paste.maxLit`'s stacked shells overshoot the cap** (§10.3 "stacked 32 × 12 × 32 house shells … as many as reach about 32,768 changes"): one shell is 3,296 changes, so 9 shells are 29,664 and 10 are 32,960, over `MAX_STEP_EDITS`. The row pastes 9 whole shells and the 10th shell's cells in a fixed shell-major order up to exactly 32,768 changes, the same cell set in both batch orders. Task 5.
7. **The edit path's gate can refuse a cut after its clipboard write** (D6 "Only the sim's own refusals (the blocks changed, memory full) can follow the write"; §2.2 step 5 "Only the sim's refusals (`'changed'`, `'full'`) can come after step 4"): the gate runs again inside `post` (`src/ui/world/editPath.ts:84-94`), after the awaited copy and the awaited clipboard write (about 160 ms behind a flush, §4.2), so an Apply started or a column unloaded meanwhile resolves `'unloaded'` or `'regenerating'` with nothing posted; `'noProto'` and `'failed'` (`EditOutcome`, `editPath.ts:27-29`) can follow too. Each leaves the box as it was and the clipboard holding the selection, as after `'changed'`. Task 19 (D6 and §2.2 step 5 reworded).
8. **`across` cannot serve the anchor as exported** (§2.5 "a = h + n (`across`, … exported for this)"): `across` takes a whole `RayHit` and returns a fresh array (`src/player/interaction.ts:97-104`), so the per-frame anchor would allocate. `interaction.ts` gains `acrossInto(hit, out)`, which writes the voxel into an `Int32Array`; `across` delegates to it. Task 16 (§2.5 reworded).
9. **The ghost covers the aimed block when raised or lowered** (§2.5 "then y + `offset`. The ghost never covers the aimed block."): on a ±y face an offset moves the box onto the hit voxel (+y with offset −2 starts at h.y − 1; −y with offset 3 reaches h.y + 2). The property holds with offset 0, and on a side face at any offset. Task 16 (§2.5 reworded).
10. **L12b's sequence leaves no house to move or cut** (§10.4 "6 cycles of paste …, undo, redo, undo; then a move of the house 3 blocks down …, undone, and a cut of the house, undone"): every cycle ends with an undo, so the move and the cut would act on terrain (and the cut would put terrain in the clipboard). L12b runs 5 cycles of paste, undo, redo, undo; a 6th paste (turn 1), undo, redo, so the house stands; the move, undone; the cut, undone; the 6th paste undone (still 28 operations, the world back at its start). Task 31 (§10.4 reworded).
11. **The bench blocks need a module of their own** (the module layout and §13's §1 `ui/world/*` token name no such module): `paste.max`'s and `paste.maxLit`'s blocks are built by the Node bench (Task 5) and by L12c in the page (Task 31), and `src/` cannot import `test/` (`test/arch/rules/imports.ts`), so they live in a pure `src/ui/world/pasteBlocks.ts` that `noise.bench.ts` imports. Task 5 (the module layout and §13's `ui/world/*` token gain `pasteBlocks.ts`), Task 9 (the master token).
12. **Two texts for a selection over 64 a side** (D3's label "Selection W × H × D: at most 64 blocks on a side"; §1.4's notice "The selection is larger than 64 blocks on a side"; D5 and §2.7's table "refused with D3's text"): the label keeps D3's text and the notice at Ctrl+C, Ctrl+X and N is §1.4's. Task 18 (D5 and §2.7 reworded).

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin (`SMOKE_KEYS`, `KV_CONTRACT_CASES`, `measureChrome.ts`'s `ASSETS`). A `.mjs` module a TS test imports gets a sibling `.d.mts`.
  - **No new dependencies** (`CLAUDE.md`'s rule; master §0's YAGNI line).
- **Layers** (`test/arch/rules/imports.ts`; no rule changes, every new module sits in an existing layer):
  - `sim/edits.ts` stays pure (its clock injected; `readVolume` reads the store it is given). `persist/clipboard.ts` is a pure layer (`banned.ts:9`: no `document`, `window`, `localStorage`) that value-imports `L2_CORE` only (`imports.ts:24`): the registry and `saves.ts`' `remapOf`, never `ui/`. **`indexedDB` only in `persist/idb.ts`** (`banned.ts:210-211`), which now also serves the clipboard on the main thread (D26; master §1's exception amended in Task 11).
  - `workers/protocol.ts` value-imports `sim/edits.ts` (`MAX_STEP_EDITS`); `engine/simClient.ts` imports `workers/protocol.ts` only (`imports.ts:28`).
  - `ui/world/clipboard.ts`, `clipboardStore.ts`, `selectTool.ts`, `pasteBatch.ts` and `ui/common/modeTip.ts` are `ui/` (value-import any layer but `render/materials/**` and `*.worker.ts`, `imports.ts:32`); `clipboard.ts`, `selectTool.ts` and `pasteBatch.ts` are pure (no DOM; clocks and timers injected). Text through `textContent` only (`test/arch/uiText.test.ts`); no browser dialogs (`test/arch/uiDialogs.test.ts`).
  - `render/ghost.ts` and `createVolumeBox` are `render/` (three, `mesh/`, `world/store/padded.ts`, `world/blocks`; `imports.ts:29`); they take the clipboard as typed arrays, never a `ui/` type. Only `render/materials/**` creates a `ShaderMaterial` or GLSL (`banned.ts:218-219`): the ghost material lives in `materials/index.ts`; `LineBasicMaterial` and `MeshBasicMaterial` are allowed elsewhere. `ui` reaches the box, the ghost and the overlay only through `WorldRenderer` methods.
- **Pure and deterministic layers.** `core/` follows the Math allowlist; `core/`, `world/`, `gen/` and `DET_FILES` use no `Math.random`, `Date.now`, `performance.now`, `console.*`; pure layers no DOM globals. Timers and clocks reach `editPath.ts`, `autosave.ts`, `selectTool.ts` and `render/ghost.ts` injected.
- **The generated world does not change.** `GENERATOR_VERSION` stays 5; `test/goldens.json` (59 goldens), `test/schema-shape.lock.json` and `test/stateIds.lock.json` stay byte-identical (no state is added). Every task that touches `gen/`, `workers/`, `world/store/` or `sim/` (Tasks 2, 3, 4, 6, 33) runs `npm run test:goldens`, then `git diff --exit-code main -- test/goldens.json`; if the run rewrote anything, restore with `git checkout main -- test/goldens.json` and find the bug.
- **Governance.**
  - `test/thresholds.lock.json` changes only in Task 1 (`startedSps`), Task 27 (`L3.paste`, `E3.paste`, `E5.paste`), Task 32 (`G2.paste`, with the committed Iris Xe file) and Task 33d when it runs (a new `L3.paste` part, a tightening, with its Threshold-log line), always through `npm run test:accept-thresholds`; each such commit adds one line to the SP5c spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`); `<date>` in the log lines below stands for that commit's date. Every part is new (a tightening); no gate is loosened. `test/baselines.json` (not a lock) is re-recorded in Task 5 with `paste.max` and `paste.maxLit`.
  - Master amendments land in the commit spec §12 and §13 assign: the §10 ones in the first commit, the rest with what they describe; each is pinned in a new `describe('master spec amendments (SP5c §13)')` in `test/arch/masterSpec.test.ts`, created by Task 1, with the moved earlier pins (`:1169` in Task 1, `:1499` and `:1511` in Task 11, `:1463` at the exit). `:1401`, `:1540`, `:1587` and `:1153` stay where they are: §13 keeps their text. **(plan)** A table `SP5C_MODULES: Array<[head: RegExp, token: string, file: string]>` in that describe, checked by "§1 names each SP5c module in its entry, which exists" (the `SP5B_MODULES` pattern, `masterSpec.test.ts:1365-1385`, checked as `:1633-1641`), added with its first row by Task 9; each task that creates a module appends its row. At the exit, master §10 holds no bare `SP5` outside the places SP5a's test allows.
- **Master amendments by task** (spec §13; each pinned in the SP5c describe by the task that lands it): Task 1: §10's SP5c entry (header "(L; SP5b). Spec: …", the contents line, Exit, Cut line), the Default receivers, SP7's, SP8a's, SP8c's, SP10's and SP11's "Received from SP5c"; Task 9: §1's `ui/world/*` entry gains `selectTool.ts clipboard.ts clipboardStore.ts pasteBatch.ts pasteBlocks.ts (SP5c)` (Spec correction 11; Tasks 11, 12 and 15 add only their rows), §2.2's `rotateState` line; Task 10: §1's `persist/*` entry gains `clipboard.ts (SP5c)`; Task 11: §2.7's `meta` line, §1's dependency rule; Task 13: §6.3's Selection line; Task 14: §5.9; Task 17: §1's `selection.ts (SP5a)` token gains ", the volume box (SP5c)"; Task 20: §1's `materials/` line; Task 21: §1's `render/ghost.ts (SP5c)`, §4.5's pass 7 and draw calls; Task 23: §4.12's Selection tool paragraph; Task 26: §1's `ui/common/*` entry gains `modeTip.ts (SP5c)`; Task 27: §6.4's L3 and E1-E6 rows, §1's test entry; Task 32: §6.4's G2 row, §4.12's Target line, §7's Latency; Task 36: the SP5c entry's "Received from SP5b" worded as delivered, the Cut line and the receivers worded by whether the overlay was taken.
- **Zero allocation** (SP4b D25): the frame step at rest allocates nothing with the selection box shown and with the ghost shown at a fixed aim and turn: the box's `set` and the ghost's matrix are written in place, the label is set only when the tool's state, the counts or the refusal change, the anchor's checks run only when the hit voxel, its face, the turns or the offset change, and the target read runs only after 100 ms still. Pinned in Task 18 (the box) and Task 22 (the ghost) in `test/unit/zeroAlloc.test.ts` (`unit (heavy)`), under the 256 B-per-tick budget (`:173`) and 256 KB per 10,000 calls (`:160`).
- **Never a sim refusal or error from normal use.** An `error` reply latches the sim handler for the session (`simHandler.ts:253-256`) and the client treats it as the sim's failure (`simClient.ts:15-20`). So every edit's y and window are checked on the main thread before posting (§2.7), the page never posts a `copy` outside the world (the sim answers one `outside` anyway, §3.3), and the guard's length cap is a backstop the page never reaches (the page's own cap check runs first).
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit.
- **CI time budget** (spec §11, against SP5b's exit run 41299209682, wall 3 min 01 s, and `main`'s 41299749363, 2 min 57 s; one job varies by ±45 s between runs on one commit):
  - `unit (rest)` ≈ 117-152 s, `unit (heavy)` ≈ 122-125 s, `check` +3-8 s;
  - `clipboard.metric.ts` about 30-55 s on quick in the new metrics-quick shard `clipboard` (`.github/scripts/metricShards.mjs:18-36`, `test/unit/shards.test.ts:35-45`; a job of about 70-110 s beside the long pole) and 15-25 s in fast `rest` (≈ 115-145 s);
  - wall ≈ 2.9-3.2 min, metrics-quick `rest` and `terrain` (≈ 160 s) still the long pole; at most 3 min 30 s at the exit. The docs-only path grows by the unit additions only.
  - The named lever, taken before the exit if `unit (rest)` passes the long pole: `.github/scripts/unitShards.mjs` moves the slowest new unit files to `heavy` (SP5b's GOV-8, `unitShards.mjs:15-24`).
- **GPU measurements** (spec §10.4, as SP5b):
  - **Chrome cells** are an agent's, through `npm run measure:chrome -- --route bench|flight|enter --gpu iris|rtx`, on a cold driver shader cache (`MESA_SHADER_CACHE_DISABLE=true` for the Iris Xe, `__GL_SHADER_DISK_CACHE=0` for the RTX, in the tool's own Chrome's env only; never `~/.cache/mesa_shader_cache` or any user cache), on the laptop panel eDP-1 at 240 Hz with the user's display awake and unlocked, on a quiet machine (the tool refuses above a 1-minute load of 2). The Iris Xe needs PRIME **on-demand**; the RTX cells run as SP5b's, and if the RTX probe refuses, under **'nvidia'**. Only the user switches PRIME; a switch logs the user out and ends the session, which the controller resumes with `claude --resume`.
  - **Firefox runs** are the user's, on a local `vite preview` the controller serves on **port 4173**: the selftest (59/59 and "IndexedDB contract: 9/9 passed") is asked for; a Firefox bench file is optional; the user's check is the user's.
- **Where the plan stops for the user** (each marked **STOP** in its task): Task 5, only if a Node bench gate still misses after D31's rule and the sim's levers (the measurements go to the user, D28); Task 32 (PRIME on-demand, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running; the RTX cells under 'nvidia' if their probe refuses, then back to on-demand); Task 33, when it runs, before each lever's measurement and if a gate still misses after the levers (the measurements go to the user, D28); Task 34 (the user's Firefox selftest on 4173); Task 37 (the go-ahead to merge; PRIME on-demand and the display awake for the agent's headful Chrome production check; the user's Firefox production steps; the user's check, the last criterion). The controller never switches PRIME and never runs the user's check for the user. D31's prototype (Task 5) is Node only and needs no PRIME stop.
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and preview the controller serves runs on its own free port (**never 5183**, the user's compose service; **never 4190** for Firefox: the Firefox preview is 4173) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never open, close or touch the user's own browsers; no `xdotool` or any desktop input.
- **Outward-facing actions.** Pushing the branch is the controller's call (Task 27 pushes it for the first CI run). Merging to `main`, pushing `main` and the production check happen in Task 37, after the user's go-ahead. Read-only git otherwise; never rewrite history. `.superpowers/` is never committed.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways a user of the selection tool would see SP5c lose work, refuse a paste wrongly or end editing, most likely first; each names the test that pins it and the task that owns it.

1. **Columns unloading or the world regenerating while a paste or its undo is in flight.** A maximum paste posted, then a teleport far away (or a terrain change applied from the map) before its reply; then Ctrl+Z while the world regenerates. A person expects the paste whole when they come back, the undo refused with a notice while regenerating and the step kept, and the undo working once the world settles. Task 27 pins in `E5.paste`: "a maximum paste across a column border with its reply delayed 1,500 ms; at 100 ms a teleport of 640 columns: until the reply every pasted column's 3 × 3 keeps its sim pin and is not freed; after the reply the columns are freed; back: every pasted cell at its pasted value and its light equal to a fresh `lightRegion`", and in `E3.paste`: "a paste, then the mode on and a 'T' Apply started; Ctrl+Z while it regenerates: `Can't undo there: regenerating`, the step kept (`history.size` unchanged); after the Apply settles Ctrl+Z restores every cell (a `NO_ENTRY` before → the new generated value)".
2. **A second press while an operation is in flight.** A double RMB on the ghost (the confirm awaits a target `copy` and then the bulk reply, up to about 1.5 s), a double Ctrl+X, or LMB pressed right after RMB. Without a guard the second confirm reads the target before the first paste lands, posts stale `expect`s and shows "Can't paste here: the blocks changed" after a paste that worked, with the tool already back in `select`; a second cut writes the clipboard again and is refused the same way. A person expects one paste, one cut, no refusal notice, and the paste to land even if LMB follows RMB. Task 18 adds the guard (`SelectActions.busy()`), Task 22 pins in `worldPage.test.ts`: "RMB twice 30 ms apart, the target `copy`'s reply at 200 ms: one target `copy`, one `edits`, one step, `Pasted …` once and no `Can't paste here` notice; LMB at 50 ms after RMB changes nothing and the paste lands; Q, the wheel and Ctrl+V while it is in flight change nothing", and Task 19: "Ctrl+X twice 30 ms apart: one `copy`, one clipboard write, one `edits`, one step".
3. **Ctrl held, or AltGr on the user's Spanish layout, while turning or pasting.** Ctrl still down after Ctrl+V, then the wheel, ↑, N or Q; AltGr+C or AltGr+V typed for another character. A person expects the wheel to turn while walking, the flying speed to change while flying, AltGr never to copy or paste, and the browser's Ctrl+N and Ctrl+Q left alone. Task 14 pins in `input.test.ts`: "while placing and walking, a wheel step down with `ctrlKey` resolves `turn`; while placing and flying it resolves `speedDown`, not `turn`; keydown `{code: 'KeyV', key: 'v', ctrlKey: true, altKey: true}` (AltGr+V) and `{code: 'KeyC', key: 'c', ctrlKey: true, altKey: true}` resolve nothing and are not prevented; `{code: 'KeyN', key: 'n', ctrlKey: true}` and `{code: 'KeyQ', key: 'q', ctrlKey: true}` resolve nothing and are not prevented; `{code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true}` while placing resolves nothing; `{code: 'KeyC', key: 'c', ctrlKey: true}` resolves `copy` and is prevented".
4. **Two tabs writing the shared clipboard while one pastes.** Tab A presses Ctrl+V and aims; tab B copies something else; A presses RMB, then Ctrl+V again. A person expects A to paste what its ghost showed, never a mix, and the next Ctrl+V to read B's copy. Task 22 pins in `worldPage.test.ts` (two `createClipboardStore`s over one `MemoryKV`): "A's `paste()` reads clipboard X and shows its ghost; B writes Y; A's confirm pastes exactly X's turned cells (the ghost's clipboard, read at Ctrl+V); A's next `paste()` reads Y; a write of Y while A's read of X is in flight resolves A's read with X or Y whole, never a mixture of their sizes and cells".
5. **Undo and redo of a paste after the modification mode applied a terrain change and made a backup.** A house pasted over generated ground; the mode switched on and a parameter changed (the backup copy is written with the paste's step); then Ctrl+Z and Ctrl+Y in the world, and the copy opened from Load world. A person expects Ctrl+Z to take the house away leaving today's terrain, Ctrl+Y to put it back exactly, and the copy to undo to its own terrain. Task 27 pins in `E3.paste`: "a house pasted where 40 target cells held generated ground; the mode on; a 'T' Apply that raises the surface (one backup posted and committed, its `history` holding the paste's step); Ctrl+Z: each cell whose `before` was `NO_ENTRY` equals the new generated value, each other its saved entry; Ctrl+Y: every cell the pasted value; the backup opened with `openPersistWorld` and its paste undone: every cell equals the copy's own pre-paste values (its old parameters' terrain)".

## Branch

Task 1 creates `sp5c/selection-tool` from `main` 12f47f5: `git switch main && git switch -c sp5c/selection-tool`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP5c; the §10 amendments | §12, §13 (§10, receivers), §14, §15 |
| 2 | Sim I: linear validation | §3.1, D20 |
| 3 | Sim II: sub-batches of 1,024 and `limboMax` | §3.2, D21 |
| 4 | Sim III: the headroom check and the compensating pass | §3.2, D21 |
| 5 | D31's prototype: `paste.max`, `paste.maxLit`, both orders, the cap's rule | §10.3, D31, §2.3 |
| 6 | The `copy` message and the batch's length cap | §3.3, D22 |
| 7 | Bulk batches on the edit path | §3.4, D23 |
| 8 | The autosave's and the leave's wait for a bulk batch | §2.8, D23 |
| 9 | The clipboard model and its turns | §2.6, D10 |
| 10 | `ClipboardV1`: `persist/clipboard.ts` | §4.1, D24 |
| 11 | Where the clipboard lives; the selftest's ninth case | §4.2, D15, D26, §10.7 |
| 12 | The paste batch: `pasteBatch.ts` | §2.2-§2.4, §2.7, D9, D12, D13 |
| 13 | The history's caps | §5, D14 |
| 14 | Keys: `ctrl` bindings, nine actions, the placing context | §1.1, D4 |
| 15 | The tool I: modes, corners, labels | §1.2, §1.3, D1-D3 |
| 16 | The tool II: the anchor, the main-thread checks, the throttled target read | §2.5, D7, D13 |
| 17 | The volume box and the label element | §6.1, §1.3, D3 |
| 18 | The page I: Q, the corners, the box, Ctrl+C | §1.2, §1.4, §2.1, D1, D2, D5 |
| 19 | The page II: Ctrl+X | §2.2, D6, D26 |
| 20 | The ghost material | §6.2, D25 |
| 21 | The ghost mesh: `render/ghost.ts` | §6.2, §6.4, D11, D25 |
| 22 | The page III: Ctrl+V, the ghost, turn, raise, RMB | §2.3, §2.5, D7, D9, D13, D16 |
| 23 | The page IV: N, the move | §2.4, D8 |
| 24 | The replaced-cell overlay and the counts | §6.3, §2.5, D11 |
| 25 | UX notes 1 and 2: Rename's Save; the Modify terrain notice | §7.1, §7.2, D17, D18 |
| 26 | UX note 3: the reminder on disabled parameters | §7.3, D19 |
| 27 | `clipboard.metric.ts`: `L3.paste`, `E3.paste`, `E5.paste` (first CI run) | §10.1, §11, D27 |
| 28 | Integration: a maximum paste and a `copy` through the Node worker | §10.6 |
| 29 | Browser smoke I: the hook and the `select` step | §10.8 |
| 30 | Browser smoke II: `menus`, `modify`; the review screenshots | §7, §10.8, §10.10 |
| 31 | Bench leg L12 and the JSON's `paste` block; `measureChrome` → `assets/sp5c` | §10.4, D30 |
| 32 | GPU cells (Chrome, agent): L12 on the Iris Xe, `G2.paste`, every route into `assets/sp5c` | §10.4, D28, D30 |
| 33 | The levers (conditional) | §10.4, §5, D28 |
| 34 | The user's Firefox run | §10.7, §16 |
| 35 | Whole-branch review | §8, §16 |
| 36 | Exit: evidence and docs | §16, Exit evidence |
| 37 | Merge, production check, the user's check, SP5c complete | §16 |

The order de-risks early: governance; the sim's two changes with the real full-store tests (Tasks 2-4); D31's measuring prototype before any code uses the cap (Task 5); the `copy` message with its out-of-range answer and the guard's cap (Task 6); bulk batches and the autosave's and leave's wait (Tasks 7-8); the pure model (clipboard, codec, store, batch, history caps; Tasks 9-13); keys and the tool's model (Tasks 14-16); then the page's flows from the cheapest visible piece (box, copy, cut) to the ghost, paste, move and overlay (Tasks 17-24); the UX notes; the metrics, the integration test and the smoke; L12 and the GPU cells; docs.

---

### Task 1: Governance: start SP5c; the §10 amendments

**Files:**
- Modify: `src/core/ids.ts` (the comment `:19-24` gains "SP5c (the selection tool) started on 2026-11-01 and is the current SP (SP5c spec §12)."; `CURRENT_SP` `:25` → `'SP5c'`), `test/harness/sp.ts:37` (`STARTED_SPS` appends `'SP5c'`; `SP_DEPS.SP5c` is already `['SP5b']`, `:19`)
- Modify (pins): `test/arch/sp.test.ts:18-22`, `test/unit/profiles.test.ts:26`, `test/arch/masterSpec.test.ts` (new `describe('master spec amendments (SP5c §13)')`; `:1169`'s header pin moved into it and rewritten; the module comment `:75-90` gains an SP5c paragraph)
- Modify: master §10 (the SP5c entry `:1878-1882`, the Default receivers line `:1758`, SP7's `:1891`, SP8a's `:1898`, SP8c's `:1913`, SP10's `:1926` and SP11's `:1937` entries), `docs/backlog.md:16` (the entry replaced by a pointer to SP10's "Received from SP5c"), `test/thresholds.lock.json` (generated), the SP5c spec (`## Threshold log`), `CLAUDE.md:9`, `README.md:9`

**Interfaces:**
- Consumes: `SP_DEPS.SP5c = ['SP5b']` (`test/harness/sp.ts:19`); `spEntry` and `text` in `masterSpec.test.ts`.
- Produces: `STARTED_SPS` ends `'SP5b', 'SP5c'`; `CURRENT_SP === 'SP5c'`. No profile has `readyFrom: 'SP5c'` (`src/core/params/profiles.ts:21-38`), so readiness does not change. The SP5c describe that later tasks extend. The code comments naming SP5c (spec §12's list) are reworded by the task that builds each.

- [ ] **Step 0:** `git switch main && git switch -c sp5c/selection-tool`.
- [ ] **Step 1: Update the pinned tests first.**
  - `sp.test.ts:18-22`: title "SP5c has started and is the current SP (SP5c spec §12)", the list ends `'SP5b', 'SP5c'`, `CURRENT_SP` and `currentSpOf(STARTED_SPS)` `'SP5c'`; `profiles.test.ts:26`: `'SP5c'`.
  - The SP5c describe, test "§10's SP5c entry, its receivers and the hand-overs (SP5c spec §13, §14, §15)":
    - `spEntry('SP5c', 'SP6')` starts ``**SP5c — The selection tool** (L; SP5b). Spec: `2026-11-01-sp5c-selection-tool-design.md`.`` (moved from `:1169`, which the SP5a describe drops);
    - it contains `Q (the tool), Ctrl+C / Ctrl+X / Ctrl+V, N (move, the source back to the terrain); a ghost that rests on the aimed surface, turned with the wheel; one clipboard per browser in \`meta\`; at most 64 blocks a side and 32,768 changed blocks per operation (SP5c).`;
    - it contains `**Exit:** as the SP5c spec §16 (\`L3.paste\`, \`E3.paste\`, \`E5.paste\`; \`paste.max\`, \`paste.maxLit\`; \`G2.paste\` with the SP5c spec's thresholds; the three notes received from SP5b; the user's check)`;
    - it has a line starting `- **Cut line:** the replaced-block overlay (the red cubes; the label's counts "n blocks change, m replaced" stay) (→ SP10)` **(plan)** (§15's wording; worded at the exit by Task 36), and no longer contains `**Exit** and **Cut line:** set by the SP5c spec`;
    - the Default receivers line contains `SP5c replaced-block overlay → SP10 (worded by the SP5c spec)`;
    - `spEntry('SP7', 'SP8a')`, `spEntry('SP8a', 'SP8b')`, `spEntry('SP8c', 'SP9')`, `spEntry('SP10', 'SP11')` and `spEntry('SP11', 'SP12')` each have a line starting `- Received from SP5c (its spec §14; amended by SP5c):` holding §14's text for that SP (SP7's contains `8k-updates-per-tick`; SP8a's `rotateState`; SP8c's `one break-or-place event`; SP10's `the nine actions` and `Configurable Ctrl+Z / Ctrl+Y for blocks`; SP11's `the ghost material`); `spEntry('SP6', 'SP7')` contains no `Received from SP5c`.
  - `:1401` (the contents line's storage parenthesis) stays in the SP5b describe unchanged: §13 keeps that line.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (`CURRENT_SP` `'SP5b'`; the SP5c header `(M; SP5b)`).
- [ ] **Step 3: Implement.**
  - `ids.ts`, `sp.ts`; the master as spec §13 words its §10 items (the new contents line follows the kept one; the "Exit and Cut line: set by the SP5c spec" line becomes the Exit and Cut lines above).
  - `docs/backlog.md:16` → `- **Configurable Ctrl+Z / Ctrl+Y for blocks** → master §10's SP10 entry ("Received from SP5c"), with SP5c's key map.`
  - `npm run test:accept-thresholds`; Threshold log: `- <date> — SP5c Task 1: startedSps gains 'SP5c' (spec §12).`
  - `CLAUDE.md:9` and `README.md:9`: "SP5b … is complete (2026-11-01 …); SP5c (the selection tool: select a volume, copy, cut, paste and move it with a ghost) is in progress".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `chore(sp5c): start SP5c; the master's §10 amendments` (`git add src/core/ids.ts test/harness/sp.ts test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md docs/backlog.md CLAUDE.md README.md`).

---

### Task 2: Sim I: linear validation

**Files:**
- Modify: `src/sim/edits.ts` (`validate` `:250-269`; `applyEdits`' call `:308`; the module comment's step 1 `:4-6`)
- Test: `test/unit/simEdits.test.ts`

**Interfaces:**
- Consumes: `colKey` (`src/core/coords.ts:51`, below 2^32), `generatedAt` (`edits.ts:244`), `store.blockAt`/`fluidAt`/`proto`.
- Produces: **(plan)** `validate(store: VoxelStore, edits: readonly Edit[], prevValue: Uint32Array): EditRefusal | null` — the same refusals in the same order (`'unloaded'`, `'changed'`, `'noProto'`), and `prevValue[k]` = the value edit k replaces (the batch's value so far, else the store's), which Task 4's compensating pass keeps. `applyEdits` allocates `prevValue` beside `prev`/`next` (`:299-300`).
- Pinned: the key `colKey(cx, cz) * 98_304 + (y + 64) * 256 + lz * 16 + lx` (below 2^53: `(y + 64) * 256 + 255` ≤ 98,303); a `Map<number, number>` from the key to the batch's value so far (after edit k: `generatedAt(p, …)` for a `revert`, else `e.value`); a batch of one edit builds no map.

- [ ] **Step 1: Write the tests** (`simEdits.test.ts`, on the existing seed-42 region `:79-98`):
  - "linear validation equals the scan: 1,000 random batches (seeded with `testRng`, each 1-40 edits over 6 voxels of the centre column, sets and reverts, each `expect` right or stale; every failure printing its seed and batch) give the same `refused` and, when accepted, the same values and `prev`/`next` as the reference scan" (the reference is today's backward scan, `:259-263`, copied into the test as `validateScan`; each accepted batch is undone after);
  - "a voxel set twice in one batch: the second edit's `expect` must be the first's `value`"; "a `revert` then a `set` of the same voxel: the `set`'s `expect` is the generated value";
  - "a one-edit batch builds no `Map`" **(plan)**: through a counter exported for tests only (`/** @internal */ export const validateStats = { maps: 0 }`): 0 after a one-edit batch, 1 after a two-edit batch.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simEdits.test.ts`. Expected: FAIL on `validateStats` (not exported) only; the equality cases pass on today's scan.
- [ ] **Step 3: Implement** the map; the module comment's step 1 names it ("linear in the batch through a `Map` from the packed voxel position", SP5c D20).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff; `relight.edit` and L3 unchanged.
- [ ] **Step 5: Commit** `perf(sim): linear validation (SP5c D20)` (`git add src/sim/edits.ts test/unit/simEdits.test.ts`).

---

### Task 3: Sim II: sub-batches of 1,024 and `limboMax`

**Files:**
- Modify: `src/sim/edits.ts` (`applyEdits` `:296-449`, `EditResult` `:63-72`, the module comment), `src/workers/protocol.ts` (`EditedMsg` `:727-731`; `parseFromSim`'s `edited` `:871-877`), `src/workers/simHandler.ts` (`:428-433`), every harness or test that builds an `edited` reply by hand, the SP5c spec (Spec corrections 2, 3, 4)
- Test: `test/unit/simEdits.test.ts`, `test/unit/protocol.test.ts`, `test/unit/simHandler.test.ts`

**Interfaces:**
- Consumes: `store.enterRead`/`exitRead`/`limboCount(thread)` (`src/world/store/store.ts:105-110`, `:655-658`), `store.thread`, Task 2's `validate`.
- Produces:
  - `export const SUB_BATCH = 1024;` in `sim/edits.ts`;
  - `EditResult` and `EditedMsg` gain `readonly limboMax: number` (the most entries in the calling thread's limbo, `store.limboCount(store.thread)`, at the end of any sub-batch before its `exitRead`; 0 for a refusal before any write) and `readonly subBatchMaxMs: number` (the longest sub-batch's time on `now`) (Spec correction 3); `parseFromSim` requires both finite and ≥ 0; the handler copies both.
- The loop (sketch; the rollback scoped to sub-batch k is Task 4's, until then a throw in sub-batch k > 0 restores sub-batch k and rethrows):
  ```
  validate all → prevValue
  for (s = 0; s < n; s += SUB_BATCH):
    t = now(); opened = []                       // writers reopened per sub-batch
    for k in s … min(s + SUB_BATCH, n) − 1: today's per-edit body (:327-391)
    for (w of opened) w.publish()
    limboMax = max(limboMax, store.limboCount(store.thread)); subBatchMaxMs = max(…, now() − t)
    if (s + SUB_BATCH < n) { store.exitRead(); store.enterRead(); }   // the drain; the last exitRead stays in finally (:427)
  ```
  One reply, one `dirty`, `relightMs` the sum, one `editMs`. The module comment states Spec correction 4: the drain needs read depth 0, so `applyEdits` is never called inside a read section.

- [ ] **Step 1: Write the tests.**
  - `simEdits.test.ts`, a new describe "a paste in sub-batches (SP5c spec §3.2)" on its own region: `genRegion({ seed: '42', params, cx0, cz0, w: 5, h: 5, upTo: 'L', order: 'spiral', threads: 1, shared: true })` at the same spawn (Spec correction 2), with a fresh DiffStore:
    - "a 32,768-edit paste across a column corner (a 32 × 32 × 32 stone block from x = 16·(C.x − 1), z = 16·(C.z − 1), y = the footprint's highest `worldSurface` + 1): every voxel reads stone; each of the four edited columns' 3 × 3 equals a fresh `lightRegion` (the file's light check); `prev[k]` `NO_ENTRY` and `next[k]` the value for every k; `limboMax` ≤ 4,096; `limboCount(store.thread)` 0 after the call; its revert batch then restores every voxel and empties the DiffStore";
    - "a stale `expect` at the last edit (k = 32,767): `refused` `'changed'`, nothing written (every value, block and light version, and the DiffStore unchanged), `limboMax` 0";
    - "sub-batches counted through a store wrapper counting `exitRead`: 1,024 edits → 1, 1,025 → 2, 32,768 → 32";
    - "`relightMs` is the sum over sub-batches; `subBatchMaxMs` ≤ `editMs`";
    - "inside an outer `enterRead` the batch is still applied whole and exact, and `limboMax` then counts every retire of the batch" (Spec correction 4, documented).
  - `protocol.test.ts`: "an `edited` without `limboMax`, or with `subBatchMaxMs` −1 or NaN, is refused".
  - `simHandler.test.ts`: "`edited` carries `limboMax` and `subBatchMaxMs` from `applyEdits`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simEdits.test.ts test/unit/protocol.test.ts test/unit/simHandler.test.ts`. Expected: FAIL (`limboMax` absent; one `exitRead` for 32,768 edits).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `perf(sim): apply a batch in sub-batches of 1,024 with a drain between them (SP5c D21)` (`git add src/sim/edits.ts src/workers/protocol.ts src/workers/simHandler.ts test/unit/simEdits.test.ts test/unit/protocol.test.ts test/unit/simHandler.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md` and each hand-built `edited` fixture by path).

---

### Task 4: Sim III: the headroom check and the compensating pass

**Files:**
- Modify: `src/sim/edits.ts` (`applyEdits`, the rollback `:393-418`, the module comment)
- Test: `test/unit/simEdits.test.ts`

**Interfaces:**
- Consumes: `SlabPool.freeCount()`, `slotCount()`, `maxSlots` (`src/world/store/pool.ts:90`, `:103-104`); `store.blockPool`, `store.bytePool` (`store.ts:94-95`); `StoreFull` (`pool.ts:43-48`); Task 2's `prevValue`.
- Produces:
  - `export const HEADROOM_BLOCK_SLOTS = 4096;` `export const HEADROOM_BYTE_SLOTS = 8192;` `export function headroom(pool: SlabPool): number` = `pool.freeCount() + pool.maxSlots − pool.slotCount()`;
  - **(plan)** a test seam: `applyEdits(store, diffs, s, edits, now, hooks?: EditHooks)`, `export interface EditHooks { beforeEdit?(k: number): void }`, called before edit k's write; production passes none.
- Rules (spec §3.2):
  - a batch of more than `SUB_BATCH` edits, after validation and before any write, refuses `'full'` with nothing written (no version bumped, `dirty` empty) when `headroom(store.blockPool) < HEADROOM_BLOCK_SLOTS` or `headroom(store.bytePool) < HEADROOM_BYTE_SLOTS`;
  - a `StoreFull` in sub-batch k: the sketch below (today's rollback loops limited to `[s, written)` and `[s, recorded)`); the diff flag stays set; the reply is `refused: 'full'` with `dirty` covering every column touched by either pass; `entryAdded`/`entryRemoved` empty;
  - a throw inside the compensating pass is rethrown (INTERNAL, the last resort).
- The late `StoreFull` (sketch; the per-edit body is Task 3's, `writeVoxel(e, value)` below standing for it):
  ```
  catch (StoreFull in sub-batch k, edits [s, written)):
    rollback sub-batch k's writers; rescan its heightmaps; restore its DiffStore entries from prev[]
    store.exitRead(); store.enterRead()                      // the rolled-back slots drained
    for (j = s − 1; j >= 0; j -= SUB_BATCH):                 // sub-batches k−1 … 0, edits in reverse order
      for (i = j; i > j − SUB_BATCH && i >= 0; i--):
        writeVoxel(edits[i], prevValue[i])                   // scratch, replaceBlocks, heightmaps, relight
        prev[i] === NO_ENTRY ? diffs.remove(…) : diffs.set(…, prev[i])   // never the per-edit rule (:385-388)
      publish the opened writers; store.exitRead(); store.enterRead()
    bump the versions of every column written by either pass; refused = 'full'
  ```

- [ ] **Step 1: Write the tests** (`simEdits.test.ts`):
  - on Task 3's shared region: "a `StoreFull` thrown by the hook at edit 3,082 of an 8,192-edit paste (sub-batch 3 of 8): `refused` `'full'`; every voxel, every light section (against a fresh `lightRegion`), each block column's heightmaps (aux A) and every DiffStore entry equal to the batch's start; `dirty` ⊇ every edited column; `entryAdded` and `entryRemoved` empty; a later 1-edit batch is accepted";
  - "a DiffStore entry equal to the generated value before the batch (written with `diffs.set` directly, as after an Apply) is restored by the compensating pass, not removed";
  - "a really full store" (Spec correction 2), on a canned 5 × 5 store as `:290`'s (stone up to y 69, air above, lit, Published, protos kept) built with `createStore({ shared: true, maxBlockBytes, maxByteBytes })` **(plan)** sizes chosen so each precondition holds, each asserted before the batch:
    - (a) block slots taken with `store.blockPool.alloc()` until `headroom(store.blockPool)` is 4,095: a 2,048-edit paste is refused `'full'` with nothing written, `dirty` empty, no version bumped;
    - (b) a 4,096-edit batch whose sub-batches 0-2 swap underground stone for `oak_planks` below y 60 (opaque for opaque: no light changes, so no byte slot) and whose sub-batch 3 places wall torches in the open air (light changes); both headrooms above their thresholds before the batch; the hook at edit 3,072 allocates byte slots until 16 remain (another thread taking the headroom): sub-batch 3 throws `StoreFull` in its first relight, `refused` `'full'`, the start state restored (voxels, light, heightmaps, DiffStore), the compensating pass not throwing (it needs no byte slot); after the hook's slots are freed and one `exitRead`/`enterRead` drains the limbo, every pool's live slots (`slotCount() − freeCount()`, as `noise.bench.ts`'s leak checks) equal those before the batch (not its free count: the hook grows the byte pool to its maximum, and sub-batches 0-2 may grow the block pool).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simEdits.test.ts`. Expected: FAIL (no headroom check; sub-batch 3's throw leaves sub-batches 0-2 written).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `fix(sim): a large batch checks the store's headroom and stays all or nothing (SP5c D21)` (`git add src/sim/edits.ts test/unit/simEdits.test.ts`).

---

### Task 5: D31's prototype: `paste.max`, `paste.maxLit`, both orders, the cap's rule

**Files:**
- Create: `src/ui/world/pasteBlocks.ts` (Spec correction 11; pure, value-imports the registry only)
- Modify: `test/bench/noise.bench.ts` (two rows after `persist.flush`, `:448-475`; the log lines `:506-507`; it imports `pasteBlocks.ts`), `test/bench/gates.ts` (constants; `BENCH_ROWS` `:76-84` and its comment), `test/baselines.json` (re-recorded), the SP5c spec (`## Exit evidence`: "### D31's prototype (Task 5)"; Spec corrections 6 and 11: the module layout and §13's `ui/world/*` token gain `pasteBlocks.ts`)
- Test: `test/unit/benchGates.test.ts`, `test/unit/pasteBlocks.test.ts`

**Interfaces:**
- Consumes: Tasks 2-4's `applyEdits` (sub-batched, `limboMax`, `subBatchMaxMs`); `relight.edit`'s seed-42 region (`worldStore`, shared, `noise.bench.ts:307-336`, the inner columns `:379`); `measure` with `overriddenDuration`.
- Produces (`gates.ts`): `PASTE_MAX_P99_MAX_MS = 800`, `PASTE_LIT_P99_MAX_MS = 1600`, `PASTE_RUN = Object.freeze({ iterations: 16, time: 0, warmupIterations: 1, warmupTime: 0 })`, `PASTE_LIT_RUN = Object.freeze({ iterations: 8, time: 0, warmupIterations: 1, warmupTime: 0 })`, D31's rule as `D31_LIT_P50_MAX_MS = 1500` and `D31_MAX_P99_MAX_MS = 800`; `BENCH_ROWS` ends `'relight.edit', 'persist.flush', 'paste.max', 'paste.maxLit'`. The cap (32,768 or 16,384) and the batch order that Tasks 6 and 12 code.
- Produces (`src/ui/world/pasteBlocks.ts`, Spec correction 11): `export interface PasteBlock { readonly w: number; readonly h: number; readonly d: number; readonly values: Uint32Array }` (Task 9's `Clipboard` shape, index `(y · d + z) · w + x`, values `state << 8 | fluid`; `pasteBlocks.ts` declares it, as `clipboard.ts` does not exist yet) and `export function pasteMaxBlock(changes = 32_768): PasteBlock`, `export function pasteLitBlock(changes = 32_768): PasteBlock` — the two rows' blocks below, cut to their first `changes` changed cells in the fixed order the rows name (Spec correction 6's shell-major cut), the other cells air; `noise.bench.ts` imports both, as L12c does (Task 31). `pasteBlocks.test.ts`: "each block has exactly `changes` non-air cells for 32,768 and 16,384; the first 16,384 of the 32,768 cut are the 16,384 cut's cells".
- The rows, each through `applyEdits` with a DiffStore of its own, outside any read section (Spec correction 4), each timed call's `overriddenDuration` its paste's `editMs` and its undo (a `revert` per cell, `expect` the pasted value) applied untimed in the same call, so the region ends as it began:
  - **`paste.max`:** a 32³ block of stone with an `oak_log` (axis y) at every cell whose index is a multiple of 7, into air above the inner columns' highest surface + 1 (every cell air before: 32,768 changed); order §2.3's (y descending, then z, then x);
  - **`paste.maxLit`:** 32 × 12 × 32 house shells of oak planks with a glass band at the shell's 5th row and interior wall torches facing in, stacked from the surface + 1 (Spec correction 6: 9 whole shells and the 10th's cells in shell-major order up to exactly 32,768 changes), timed in §2.3's order; its first run also times the same cells in y-ascending order once (one direct `applyEdits` before the warm-up, printed).
- The order's rule **(plan)**: y ascending replaces §2.3's order only if its single timing is below 0.85 × y descending's p50 (outside the ±15 % noise of a single run); else y descending stays.

- [ ] **Step 1: Write the rows and their checks.**
  - `benchGates.test.ts`: `BENCH_ROWS`' four last rows; the six constants' values;
  - in the bench, each row asserts its change count (32,768), every cell equal to the pasted value after a paste and to the start after its undo, `refused` null, and its probe, warm-up and timed call counts (1 + 1 + 16; 1 + 1 + 8);
  - the log lines print, beside `relight.edit`'s (`noise.bench.ts:506-507`), each row's p50, p99, `limboMax`, `subBatchMaxMs` and, for `paste.maxLit`, the y-ascending timing.
- [ ] **Step 2: Measure** (an agent; on the reference CPU, the Iris Xe laptop's i7-12700H, spec header; quiet machine, load below 2, touching no other process): `npm run bench` twice. Record per run: `paste.max` p50, p99, max, the last call's `limboMax` and `subBatchMaxMs`; `paste.maxLit` p50, p99 and the y-ascending timing; the pools' byte lengths before and after each row.
- [ ] **Step 3: Apply D31's rule once** (spec §10.3), before any code uses the cap:
  - **conditional:** in either run `paste.maxLit` p50 > 1,500 ms or `paste.max` p99 > 800 ms → the cap becomes 16,384 (D12's alternative): the SP5c spec's figures amended in this commit (Goal, D12, D13's "at most 32,768 at once", §2.2, §2.7's table, §3.3, §3.5, §5's `MAX_STEP_EDITS`, §10.1-§10.4's "32,768", §13's master texts) and the master's SP5c contents line (Task 1's) with its pin; every later task reads `MAX_STEP_EDITS` and the text `at most 16,384 at once`; the rows `paste.max` and `paste.maxLit` become `MAX_STEP_EDITS`-change rows (16,384: `pasteMaxBlock(16_384)` and `pasteLitBlock(16_384)`, the first 16,384 changes of the same builders in the same order), their gates unchanged, re-measured (Step 2's two runs) before Step 4 (a 32,768-change row would be refused by the guard and could never pass Step 4's gate after the rule lowered the cap); L12c's blocks (Task 31), Task 28's integration paste and every later "32,768" maximum in a test or metric use `MAX_STEP_EDITS` changes **(plan)**;
  - otherwise 32,768 stays; recorded either way. The order's rule as above; if y ascending wins, §2.3's sentence is amended in this commit.
- [ ] **Step 4: Gate and record.** `paste.max` p99 ≤ 800 and `paste.maxLit` p99 ≤ 1,600 asserted in the bench as `relight.edit`'s gate is; `npm run bench:record` on the quiet machine; `npm run bench` again: within the gates and the +30 % p50 ratio rule. **Conditional:** a p99 miss after the rule → the sim's levers of Task 33 in order (33b, 33d, then 33e if the cap is still 32,768; 33a acts on the page's clone and 33c on the flush, neither on this row), each committed and measured by this Step's two `npm run bench` runs before the next, all before Task 6; still a miss → **STOP for the user** with every measurement (D28); no gate is loosened.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `perf(bench): paste.max and paste.maxLit; D31's measurement before the cap` (`git add src/ui/world/pasteBlocks.ts test/unit/pasteBlocks.test.ts test/bench/noise.bench.ts test/bench/gates.ts test/baselines.json test/unit/benchGates.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`, and `docs/superpowers/specs/2026-09-26-architecture-design.md test/arch/masterSpec.test.ts` when the cap was lowered).

---

### Task 6: The `copy` message and the batch's length cap

**Files:**
- Modify: `src/sim/edits.ts` (`MAX_STEP_EDITS`, `MAX_COPY_SIDE`, `readVolume`), `src/workers/protocol.ts` (`CopyMsg`, `CopiedMsg`, `ToSim` `:721`, `FromSim` `:768`, `parseToSim` `:827-850` with the `edits` guard `:834-836`, `parseFromSim` `:860+`), `src/workers/simHandler.ts` (`case 'copy'`, the module comment `:1-16`), `src/engine/simClient.ts` (`copy`, `REQUEST_OF` `:90`, the reply guard, the module comment), the SP5c spec (Spec correction 1)
- Test: `test/unit/simEdits.test.ts`, `test/unit/protocol.test.ts`, `test/unit/simHandler.test.ts`, `test/unit/simClient.test.ts`

**Interfaces:**
- Consumes: Task 5's cap; `store.blockAt` (−1 for a column not Published, `store.ts:763-765`), `fluidAt`, `proto`; `pointInWindow` (`protocol.ts:373`); `yInWorld`/`WINDOW_HALF` (`src/core/coords.ts:23`, `:36`).
- Produces:
  - `sim/edits.ts`: `export const MAX_STEP_EDITS = 32_768;` (Task 5's outcome; Spec correction 1), `export const MAX_COPY_SIDE = 64;`, `export interface VolumeRead { readonly values: Uint32Array | null; readonly generated: Uint32Array | null; readonly why: 'outside' | 'unloaded' | null }`, `export function readVolume(store: VoxelStore, x0: number, y0: number, z0: number, w: number, h: number, d: number, gen: boolean, hook?: (i: number) => void): VolumeRead` — `outside` with nothing read when any cell leaves y −64 … 319 or the window `[−524,288, 524,288)`; else one read section, cells in index order `(y · d + z) · w + x`, `blockAt << 8 | fluidAt`, stopping at the first `blockAt` of −1 with `unloaded` (−1 never shifted into a value); with `gen`, each cell's proto value (`generatedAt`'s rule), `unloaded` when a column's proto is gone; `hook(i)` after cell i (tests only).
  - `protocol.ts`: `export interface CopyMsg { readonly type: 'copy'; readonly id: number; readonly x0: number; readonly y0: number; readonly z0: number; readonly w: number; readonly h: number; readonly d: number; readonly gen: boolean }` (integers, 1 ≤ w, h, d ≤ `MAX_COPY_SIDE`, `gen` boolean; anything else BAD_MESSAGE; a corner outside the world is not malformed); `export interface CopiedMsg { readonly type: 'copied'; readonly id: number; readonly values: Uint32Array | null; readonly generated: Uint32Array | null; readonly why: 'outside' | 'unloaded' | null }`; the `edits` guard adds `edits.length <= MAX_STEP_EDITS`.
  - `simHandler.ts`: `copy` → `readVolume` (NOT_ATTACHED before the attach), answered even after the handler latched (it writes nothing, as `diff`), its buffers transferred.
  - `simClient.ts`: `copy(box: { x0: number; y0: number; z0: number; w: number; h: number; d: number }, gen: boolean): Promise<CopiedMsg>`; a `copied` must answer a pending `copy` by id, `why` one of the three, `values` (and `generated` when asked; null when not asked) null or a `Uint32Array` of length w · h · d, every value's state below `REGISTRY.stateCount` and its fluid bit 7 clear; else the sim's failure. On the sim's failure a pending `copy` rejects `SimFailed`.

- [ ] **Step 1: Write the tests** (spec §10.5's Sim and sim-client items):
  - `simEdits.test.ts` (Task 3's shared region): "`readVolume` of a 20 × 10 × 20 box across a column corner equals `blockAt << 8 | fluidAt` cell for cell in `(y · d + z) · w + x` order"; "a box reaching a column outside the Published set: `values` null, `why` `'unloaded'`"; "a column freed by the hook between cells 100 and 101 (`store.freeColumn` of cell 101's column): `unloaded`" (on a region of its own, `genRegion({…, threads: 1, shared: true})` or a canned `createStore` as Task 4's, never Task 3's shared region, which the later cases read whole and which cannot bring a freed column back, `store.ts:683-699`); "y0 300, h 30: `outside`; x0 524,280, w 10: `outside`; the hook never called"; "with `gen`, `generated` equals the region's proto values, and after a placed block the two differ only there".
  - `protocol.test.ts`: "a `copy` with w 65, w 0, a fractional x0 or `gen` missing is refused; one with y0 400 is accepted"; "an `edits` of 32,769 edits is refused, of 32,768 accepted".
  - `simHandler.test.ts`: "a `copy` outside answers `copied` with `why` `'outside'`, no `error` reply, and a later `edits` is accepted (the handler not latched)"; "`copy` after an `error` latched the handler still answers"; "`copy` before the attach answers NOT_ATTACHED"; "an `edits` of `MAX_STEP_EDITS` + 1 answers BAD_MESSAGE".
  - `simClient.test.ts`: "a `copied` answering no pending `copy`, of length w · h · d − 1, holding a state ≥ `stateCount` or a fluid byte with bit 7, or carrying `generated` when not asked, is the sim's failure (`failed` true, `onFailure` once)"; "a valid `copied` resolves `copy` with its arrays".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simEdits.test.ts test/unit/protocol.test.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the handler's and the client's module comments name `copy`; the spec reworded for Spec correction 1.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(workers): the copy message, a box outside answered, and the edits guard's length cap (SP5c D22)` (`git add src/sim/edits.ts src/workers/protocol.ts src/workers/simHandler.ts src/engine/simClient.ts test/unit/simEdits.test.ts test/unit/protocol.test.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 7: Bulk batches on the edit path

**Files:**
- Modify: `src/ui/world/editPath.ts` (`createEditPath` `:61-128`, `EditPath` `:33-52`, the module comment's latency sentence `:9-13`), `src/ui/world/worldPage.ts` (the edit paths' adapters: the bench's no-op at `:3044` gains `hide() {}`; the streaming route's at `:3383` becomes `editPathNotices(notices)`), `test/harness/persistWorld.ts` (`:253-254`, already has `hide`) and `test/metrics/edit.metric.ts` (`:352`), and every other caller of `createEditPath`, each passing `hide`: `test/unit/blockHistory.test.ts` (`:88`, `:95`, `:104`), `test/integration/edit.test.ts` (`:366-367`), `test/unit/worldPage.test.ts` (`:2055`, `:3572`, `:3676`), `test/unit/editPath.test.ts` (`:49-51`, `:289`)
- Test: `test/unit/editPath.test.ts`, `test/unit/worldPage.test.ts`

**Interfaces:**
- Consumes: `WorldNotices.hide` (`worldPage.ts:633`); `EditLatency.posted` (`editPath.ts:103`).
- Produces:
  - `export const BULK_MIN_EDITS = 3;` (a batch of more than 2 edits is bulk: a door's two halves are the largest click), `export const WORKING_NOTICE_MS = 250;`, `export function formatCount(n: number): string` (`n.toLocaleString('en-US')`: "12,345"), `export function workingNotice(n: number): string` = `` `Working on ${formatCount(n)} blocks…` ``;
  - `createEditPath`'s deps: `notices: { show(text: string, ms: number): void; hide(text: string): void }` (`hide` required, so typecheck finds every caller listed above) and **(plan)** `timers?: { set(f: () => void, ms: number): number; clear(id: number): void }` (optional, defaulting to `globalThis`'s `setTimeout`/`clearTimeout`; the unit tests inject theirs);
  - `EditPath.bulkPending(): boolean` (a bulk batch posted and not answered). A bulk batch skips `latency.posted`; 250 ms after its post, if still pending, `notices.show(workingNotice(n), 0)` **(plan)** (ms 0 means no timeout: hidden through `notices.hide` at its reply, refused, `SimFailed` or not); one notice per batch.
  - **(plan)** `export function editPathNotices(n: Pick<WorldNotices, 'show' | 'hide'>): { show(text: string, ms: number): void; hide(text: string): void }` in `worldPage.ts`, the streaming route's adapter (`:3383`): `show: (text, ms) => n.show(text, ms > 0 ? { kind: 'warn', timeoutMs: ms } : { kind: 'warn' })`, `hide: (text) => n.hide(text)`. `WorldNotices.show` schedules a removal for any `timeoutMs` it is given, 0 included (`worldPage.ts:828-833`), so passing `timeoutMs: 0` would take the working notice down on the next macrotask.

- [ ] **Step 1: Write the tests** (`editPath.test.ts`, injected clock and timers):
  - "a 3-edit batch opens no latency sample; a 2-edit batch opens one, as today";
  - "a 32,768-edit batch whose reply comes at 400 ms shows `Working on 32,768 blocks…` at 250 ms and hides it at the reply"; "a bulk reply at 200 ms never shows it";
  - "`bulkPending()` is true from the post to the reply; false for a 2-edit batch, after a refusal and after `SimFailed`";
  - "a bulk batch refused at the gate (`unloaded`) shows nothing and leaves `bulkPending()` false";
  - "an undo of a 3,296-edit step through the block history is bulk too (no latency sample, `bulkPending()` true until its reply)".
  - `worldPage.test.ts`: "through `editPathNotices` over a `createWorldNotices` (fake timers), a 32,768-edit batch whose reply comes at 1,500 ms: `Working on 32,768 blocks…` shown at 300 ms and still at 1,000 ms, gone at the reply"; "`editPathNotices`' `show(text, 4000)` still takes its notice down at 4,000 ms".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/editPath.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the module comment's "an accepted batch's latency sample opened" reads "an accepted batch of at most two edits (SP5c D23)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): bulk batches open no latency sample and show their work (SP5c D23)` (`git add src/ui/world/editPath.ts src/ui/world/worldPage.ts test/harness/persistWorld.ts test/metrics/edit.metric.ts test/unit/editPath.test.ts test/unit/worldPage.test.ts test/unit/blockHistory.test.ts test/integration/edit.test.ts`; `persistWorld.ts` only if changed).

---

### Task 8: The autosave's and the leave's wait for a bulk batch

**Files:**
- Modify: `src/ui/world/autosave.ts` (the comment `:13-17`, `AutosaveDeps` `:135-165`, `settledOrWait` `:252-259`, `tick` `:261-270`, `beforeLeave` `:285-296`), `src/ui/world/worldPage.ts` (`createPageAutosave`'s `bulkPending` from the edit path), `test/harness/persistWorld.ts`
- Test: `test/unit/autosave.test.ts`, `test/unit/worldPage.test.ts`

**Interfaces:**
- Consumes: Task 7's `EditPath.bulkPending()`; `leaveAfterSave` (`worldPage.ts:2180-2195`) and `createReloader`, unchanged.
- Produces: `export const BULK_SETTLE_WAIT_MS = 5000;` `AutosaveDeps` gains `bulkPending(): boolean` (required; `createAutosave`'s callers are `createPageAutosave` and `autosave.test.ts`'s helper); `createPageAutosave`'s deps gain **(plan)** `bulkPending?(): boolean`, optional and defaulting to `() => false`, so its other callers (`worldPage.ts:2450`, the bench's `:3991`, `autosave.test.ts:509`, `worldPage.test.ts:1625`, `:3066`, `:3318`, `:3696`, `:3907`, `zeroAlloc.test.ts:913`) compile unchanged; the streaming route passes the edit path's; `settledOrWait(ms: number)`; the tick waits `settledOrWait(o.bulkPending() ? BULK_SETTLE_WAIT_MS : SETTLE_WAIT_MS)`; `beforeLeave(ms = LEAVE_WAIT_MS)`: when `bulkPending()`, first `settledOrWait(BULK_SETTLE_WAIT_MS)`, then post and wait `ms` as today; otherwise unchanged. The hide and close triggers post at once as today (the tab's own close stays SP5b's accepted window).

- [ ] **Step 1: Write the tests.**
  - `autosave.test.ts` (injected clock): "with a bulk batch pending whose reply comes at 1,500 ms, the tick posts at 1,500 ms, after the reply, with the history holding the step"; "a bulk reply that never comes: the tick posts at 5,000 ms"; "with no bulk batch pending the tick still waits at most 1,000 ms"; "`beforeLeave` with a bulk post replied at 1,500 ms posts its flush after the reply (the flush's history holds the step) and resolves at `flushed`, or 1,000 ms after its post with null"; "with no bulk batch pending `beforeLeave` posts at once, as today".
  - `worldPage.test.ts`: "a 32,768-edit paste whose reply comes at 1,500 ms; `leaveAfterSave` (Load world) at 10 ms: the flush is posted only after the reply and carries the paste's step, and the navigation happens only after `flushed`"; "the same through `createReloader`'s Reload link"; "`pagehide` at 10 ms posts at once with no wait (unchanged)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/autosave.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `autosave.ts`'s comment states the 5,000 ms wait and the leave's wait (spec §2.8).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(ui): the autosave and a leave wait for a pending bulk batch (SP5c D23)` (`git add src/ui/world/autosave.ts src/ui/world/worldPage.ts test/harness/persistWorld.ts test/unit/autosave.test.ts test/unit/worldPage.test.ts`).

---

### Task 9: The clipboard model and its turns

**Files:**
- Create: `src/ui/world/clipboard.ts`
- Modify: `test/arch/masterSpec.test.ts` (`SP5C_MODULES`' first rows and the module test), master §1's `ui/world/*` entry, §2.2's `rotateState` line
- Test: `test/unit/clipboard.test.ts`

**Interfaces** (spec §2.6):
- Consumes: `REGISTRY.rotateState` (`src/world/blocks/registry.ts:113`, `:372-377`), `propsOf`, `boxOf` (`src/world/blocks/provisionalBoxes.ts:36-45`).
- Produces:
  - `export interface Clipboard { readonly w: number; readonly h: number; readonly d: number; readonly values: Uint32Array }` — values `state << 8 | fluid`, index `(y · d + z) · w + x`, sides 1-64, unturned (the copy's own orientation);
  - `export function turnedSize(c: Pick<Clipboard, 'w' | 'd'>, q: number): { w: number; d: number }` (swapped on odd q); `export function turnValue(v: number, q: number): number` = `REGISTRY.rotateState(v >>> 8, q) << 8 | (v & 0xFF)` (the fluid byte has no direction, `src/world/blocks/fluid.ts:2-4`);
  - `export function sourceIndex(c: Clipboard, q: number, x: number, y: number, z: number): number` — the index in `c.values` of the cell that turned cell (x, y, z) comes from. Sketch: one turn maps (x, z) in W × D to (D − 1 − z, x) in D × W, so its inverse maps (x′, z′) in D × W to (z′, D − 1 − x′); apply the inverse (q mod 4) times, the sizes swapping each time, then `(y · d + z) · w + x`;
  - `export function turnedCell(c: Clipboard, q: number, x: number, y: number, z: number): number` = `turnValue(c.values[sourceIndex(…)]!, q)`; `export function turnClipboard(c: Clipboard, q: number): Clipboard` (tests and round trips; the batch builder uses `turnedCell`). q is any integer, taken mod 4. Nothing here runs in the frame step.

- [ ] **Step 1: Write the tests** (`clipboard.test.ts`, spec §10.5's Rotation, seeded with `testRng`, every failure printing its seed and case):
  - "for every registry state and q in −5 … 5, `rotateState(s, q) === rotateState(s, ((q % 4) + 4) % 4)`, its type kept, only `facing` and `axis` changed (`propsOf`)";
  - "for 200 random clipboards (sides 1-8, every oriented state in every orientation, fluids 0, a source and a level, a waterlogged ladder): four turns are the identity cell for cell; a turn then three turns is the identity; two single turns equal one double; sizes swap on odd turns";
  - "every turned value passes the sim's guard, through `parseToSim` of an `edits` message holding it as `value` and `expect` (`isVoxelValue` is not exported, `protocol.ts:778`), and keeps its fluid byte";
  - "each oriented state's direction (facing → its unit vector; axis → the axis) turned by the position map (x, z) → (−z, x) equals the turned state's direction; each provisional box turned by the same map equals the turned state's box";
  - "named: a north `wall_torch` at (1, 0, 0) with its support block at (1, 0, 1) (to its south) in a 3 × 1 × 2 clipboard: after one turn an east wall torch with its support to its west, both inside the turned 2 × 1 × 3 clipboard".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/clipboard.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.** Master §1: after the `ui/world/*` entry's SP5b line, `selectTool.ts clipboard.ts clipboardStore.ts pasteBatch.ts pasteBlocks.ts (SP5c)` (Spec correction 11); §2.2's "`rotateState(state, quarterTurns)` and `mirrorState` serve structure pieces and placement" gains "and the selection tool's turns (SP5c)". SP5c describe: `SP5C_MODULES` with two rows, `[/^\s+ui\/world\/\* /, 'selectTool.ts clipboard.ts clipboardStore.ts pasteBatch.ts pasteBlocks.ts (SP5c)', 'src/ui/world/clipboard.ts']` and the same head and token for `'src/ui/world/pasteBlocks.ts'` (Task 5's module); later rows for `ui/world/*` use the same token; the test "§1 names each SP5c module in its entry, which exists" (`SP5B_MODULES`' loop, `:1633-1641`), and "§2.2's `rotateState` line names the selection tool's turns (SP5c spec §13)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the clipboard model and its turns (SP5c D10)` (`git add src/ui/world/clipboard.ts test/unit/clipboard.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 10: `ClipboardV1`: `persist/clipboard.ts`

**Files:**
- Create: `src/persist/clipboard.ts`
- Modify: `test/arch/masterSpec.test.ts` (row), master §1's `persist/*` entry
- Test: `test/unit/clipboardCodec.test.ts`

**Interfaces** (spec §4.1; all pure):
- Consumes: `REGISTRY.stateKey` (`registry.ts:119`), `remapOf` (`src/persist/saves.ts:214-226`: −1 for a key `parseStateKey` refuses), `WriteOp` (`kv.ts`).
- Produces:
  - `export interface ClipboardV1 { readonly v: 1; readonly w: number; readonly h: number; readonly d: number; readonly keys: string[]; readonly states: Uint16Array; readonly fluids: Uint8Array }`; `export const CLIPBOARD_KEY = 'clipboard';` `export const MAX_CLIPBOARD_KEYS = 4096;` (`MAX_STATES`);
  - `export function encodeClipboard(w: number, h: number, d: number, values: Uint32Array): ClipboardV1` — `keys` the distinct state keys in first-use order, `states[i]` an index into them, `fluids[i]` the fluid byte;
  - `export type DecodedClipboard = { readonly ok: true; readonly w: number; readonly h: number; readonly d: number; readonly values: Uint32Array; readonly unknown: number } | { readonly ok: false }`; `export function decodeClipboard(raw: unknown): DecodedClipboard` — keys through `remapOf`: an unknown key's cells become air (state 0, fluid 0), counted in `unknown`; unreadable, never a throw, on `v` not 1, a size not an integer in 1-64, `states` not a `Uint16Array` or `fluids` not a `Uint8Array` of length w · h · d, an index ≥ `keys.length`, a fluid byte with bit 7 set (`fluid.ts:1-5`), more than 4,096 keys or a key that is not a string;
  - `export function clipboardOps(c: ClipboardV1): WriteOp[]` = `[{ op: 'put', store: 'meta', key: CLIPBOARD_KEY, value: c }]`.

- [ ] **Step 1: Write the tests** (`clipboardCodec.test.ts`, spec §10.5):
  - "round trip: 200 random clipboards (seeded, sides 1-16, every placeable state) decode to their values";
  - "a key table permuted, and one cut to its first keys with the rest renamed `nope[x=1]`: every cell equal by state key, the unknown ones air, `unknown` their cell count";
  - "each malformed field of §4.1 reads `{ ok: false }` and never throws": `v` 2, `w` 0, `w` 65, `h` 1.5, `states` a `Uint8Array`, `fluids` one short, an index equal to `keys.length`, a fluid byte 0x80, 4,097 keys, a key 7, `raw` null or a string;
  - "a 64³ clipboard's arrays are 3 B per cell (768 KiB)"; "`clipboardOps` is one `put` of `meta['clipboard']`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/clipboardCodec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1's `persist/kv.ts …` entry gains ` clipboard.ts (SP5c)` after its `(SP5b)` token; `SP5C_MODULES` row `[/^\s+persist\/kv\.ts /, 'clipboard.ts (SP5c)', 'src/persist/clipboard.ts']`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (`persist/` imports only `L2_CORE`).
- [ ] **Step 5: Commit** `feat(persist): ClipboardV1, its states by state key (SP5c D24)` (`git add src/persist/clipboard.ts test/unit/clipboardCodec.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 11: Where the clipboard lives; the selftest's ninth case

**Files:**
- Create: `src/ui/world/clipboardStore.ts`
- Modify: `src/persist/kvContract.ts` (a ninth case), `src/persist/kv.ts:9-14` (the `meta` comment), `src/persist/idb.ts:1-3` (also the clipboard on the main thread), `test/tools/uiSmoke.ts:211` (`KV_CONTRACT_CASES` 8 → 9), `test/arch/masterSpec.test.ts` (row; `:1499` and `:1511` moved into the SP5c describe and rewritten), master §2.7's `meta` line (`:497`), §1's dependency rule (`:230`)
- Test: `test/unit/clipboardStore.test.ts`, `test/unit/kv.test.ts`, `test/unit/saves.test.ts`, `test/unit/uiSmoke.test.ts` (`:145-152`: `:147` → `toBe(9)`, the `kvSelftestPassed` cases at 9: `'IndexedDB contract: 9/9 passed'` true, `8/9` and `8/8` false; the test's title names SP5c spec §10.7 beside SP5b's §6.4)

**Interfaces** (spec §4.2, D15, D26):
- Consumes: Task 9's `Clipboard`; Task 10's codec; `KV.read`/`write`; `backupFailureReason` (`src/ui/world/modifyMode.ts:77`).
- Produces:
  - `export type ClipboardWrite = { readonly ok: true; readonly stored: boolean } | { readonly ok: false; readonly reason: string }`; `export interface ClipboardRead { readonly clip: Clipboard | null; readonly unreadable: boolean; readonly unknown: number }`;
  - `export interface ClipboardStore { write(c: Clipboard): Promise<ClipboardWrite>; read(): Promise<ClipboardRead> }`; `export function createClipboardStore(o: { kv(): Promise<KV | null>; notices: { show(text: string, ms: number): void } }): ClipboardStore`;
  - `write`: keeps `c` in memory, then one `KV.write(clipboardOps(encodeClipboard(…)))`; `complete` → `{ ok: true, stored: true }`; `abort` → `{ ok: false, reason: backupFailureReason(errorName) }` **(plan)** (SP5b's storage wording), `closed` → `{ ok: false, reason: 'storage was closed' }` **(plan)**; no KV → `{ ok: true, stored: false }` and, at the first such write only, `NO_STORAGE_NOTICE` = "The clipboard is kept only until this page closes: this browser window cannot store data" for 6,000 ms;
  - `read`: one `get` of `meta['clipboard']`, decoded; absent → the memory copy (null when none); unreadable → `{ clip: null, unreadable: true, unknown: 0 }`; a rejected read → the memory copy;
  - `kvContract.ts`'s ninth case "a `Uint16Array` and a `Uint8Array` put in `meta` read back with their types and bytes"; the selftest reads "IndexedDB contract: 9/9 passed".
- The page's `kv()` **(plan)**, wired in Task 18: a saved world's `saved.kv` (`worldPage.ts:3864`); an unsaved world opens `openIdbKV('wi10')` (`src/persist/idb.ts:158`) once, at the first copy or paste, when `idbAvailable()` (`:149`), else null; the bench passes its `wi10-bench` connection.

- [ ] **Step 1: Write the tests.**
  - `clipboardStore.test.ts` (`MemoryKV`): "write then read equals the clipboard"; "`failAt(0, 'QuotaExceededError')`: `{ ok: false }` with the reason, the memory copy kept"; "a read that rejects falls back to the memory copy"; "an unreadable record reads `unreadable` true"; "a record with 3 unknown-key cells reads `unknown` 3"; "no KV: `{ ok: true, stored: false }` and the notice once over two writes"; "two stores over one `MemoryKV`: B's write is read by A's next `read()`; a write of Y while A's read of X is in flight resolves A's read with X or Y whole" (`readDelayMs`, `writeDelayMs`).
  - `saves.test.ts` (spec §10.5): "`Saves.delete`, an Import and a backup copy (`copyOps`, `saves.ts:545-558`) over a KV holding `meta['clipboard']` leave it byte for byte".
  - `kv.test.ts`: the ninth case on `MemoryKV`.
  - SP5c describe: §2.7's lines contain ``- `meta`: key `'clipboard'`, the selection tool's clipboard, one per browser: `{v: 1, w, h, d, keys, states, fluids}`, its states by state key (SP5c).`` and not ``- `meta`: empty in SP5b.`` (moved from `:1499`; the SP5b test keeps its other assertions); the dependency rule reads `- **Pure layers:** none of the layers above imports three, \`document\`, \`window\` or \`indexedDB\`. The exception is \`persist/idb.ts\`, which runs in the sim worker and, for the worlds menu and the selection tool's clipboard, on the main thread (SP5b, SP5c).` (moved from `:1511`).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/clipboardStore.test.ts test/unit/saves.test.ts test/unit/kv.test.ts test/unit/uiSmoke.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `SP5C_MODULES` row for `clipboardStore.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the clipboard kept in meta, one per browser (SP5c D15, D26)` (`git add src/ui/world/clipboardStore.ts test/unit/clipboardStore.test.ts src/persist/kvContract.ts src/persist/kv.ts src/persist/idb.ts test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts test/unit/kv.test.ts test/unit/saves.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 12: The paste batch: `pasteBatch.ts`

**Files:**
- Create: `src/ui/world/pasteBatch.ts`
- Modify: `src/player/interaction.ts` (`cellIntersects` `:134` exported), `test/arch/masterSpec.test.ts` (row)
- Test: `test/unit/pasteBatch.test.ts`

**Interfaces** (spec §2.2-§2.4, §2.7; pure):
- Consumes: Task 9's `Clipboard`, `turnedSize`, `turnedCell`; `MAX_STEP_EDITS`; Task 7's `formatCount`; `COLLIDE`, `COLLIDE_NONE`, `BodyBox`, `cellIntersects`; Task 5's batch order.
- Produces:
  - `export interface Box { readonly x0: number; readonly y0: number; readonly z0: number; readonly w: number; readonly h: number; readonly d: number }`;
  - `export type Refusal = { readonly why: 'outsideY' | 'edge' | 'unloaded' | 'regenerating' | 'body' | 'tooMany' | 'changed'; readonly n?: number }`; `export function refusalText(r: Refusal): string`: `it would leave the world (y −64 … 319)`, `it would cross the world's edge`, `part of it is not loaded`, `the world is regenerating`, `you are inside it`, `` `it would change ${formatCount(n)} blocks; at most ${formatCount(MAX_STEP_EDITS)} at once` ``, `the blocks changed; try again`;
  - `export function boxChecks(b: Box, editState: (cx: number, cz: number) => 0 | 1 | 2): Refusal | null` — y (every cell in −64 … 319), the window (x, z in [−524,288, 524,288)), then one `editState` per column the box covers (Spec correction 5): any 1 → `unloaded`, else any 2 → `regenerating`; allocates nothing;
  - `export function pasteBatch(c: Clipboard, q: number, at: Box, target: Uint32Array): Edit[] | Refusal` — for every cell of the turned clipboard, `value = turnedCell(…)`, a `{ op: 'set', value, expect: read }` where it differs from the target's read value; the order Task 5 kept (y descending, then z ascending, then x ascending, unless Task 5 chose y ascending); more than `MAX_STEP_EDITS` changed → `{ why: 'tooMany', n }`;
  - `export function moveBatch(q: number, src: Box, srcNow: Uint32Array, srcGen: Uint32Array, at: Box, target: Uint32Array): Edit[] | Refusal` — the union of both boxes, one edit per voxel: a target cell takes the turned source value as read at RMB (`srcNow`, spec §2.4 "the turned source value read now"; never the copy made at N, which only feeds the ghost: Ctrl+Z and block edits still act while placing, D1, D4) as a `set` where it differs from its read value; a source cell outside the target, `{ op: 'revert', value: 0, expect: read }` where its generated value differs from its read value; the cap counted over both; one pass over the union in the batch order, so a voxel appears once and the sim's in-batch rule is never needed;
  - `export function cutBatch(b: Box, values: Uint32Array): Edit[] | Refusal` — `{ op: 'set', value: 0, expect: v }` for each cell whose value v is not 0; the cap;
  - `export function bodyHits(c: Clipboard, q: number, at: Box, body: BodyBox): boolean` — a turned cell whose state collides (`COLLIDE` not none) intersects `body` (`placeAt`'s rule, `interaction.ts:155`).

- [ ] **Step 1: Write the tests** (`pasteBatch.test.ts`, spec §10.5's batch):
  - "changed cells only, each `expect` the read value; a paste at its copy's own place with q 0 is empty";
  - "the clipboard's air written over a terrain bump (D9)"; "fluids written as copied: a source stays a source, a level byte kept";
  - "the order is y descending, then z, then x";
  - "a move overlapping its source 3 blocks down: each voxel once, the target its turned value, a source cell outside the target a `revert` only where its generated value differs from now (a floating house's source: generated air; a buried house's source: the new ground)"; "the target takes `srcNow`'s turned values: a source cell whose `srcNow` differs from an earlier copy of the source is moved with its `srcNow` value";
  - "every refusal of §2.7 with its text: a cell at y 320, a cell at x 524,288, an `editState` 1 column, an `editState` 2 column, the body, 32,769 changed (`it would change 32,769 blocks; at most 32,768 at once`)";
  - "the cap is counted after the skip: a 64³ paste of which 32,768 cells change is accepted";
  - "`boxChecks` calls `editState` at most 25 times for a 64 × 64 box (a counting stub)";
  - "a cut of a box holding 100 non-air cells is 100 `set 0`s".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/pasteBatch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `SP5C_MODULES` row for `pasteBatch.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the paste, move and cut batches with their bounds (SP5c D9, D12, D13)` (`git add src/ui/world/pasteBatch.ts test/unit/pasteBatch.test.ts src/player/interaction.ts test/arch/masterSpec.test.ts`).

---

### Task 13: The history's caps

**Files:**
- Modify: `src/ui/world/blockHistory.ts` (the comment `:1-24`, `MAX_HISTORY_EDITS`, `record` `:144-149`, `restore` `:158-162`), `src/persist/saves.ts` (`MAX_HISTORY_EDITS` beside `HISTORY_STEPS` `:125`; `normalizeSide` `:361-371`, `normalizeHistory` `:379-384`), `test/arch/masterSpec.test.ts`, master §6.3
- Test: `test/unit/blockHistory.test.ts`, `test/unit/saves.test.ts`, `test/unit/stateBounds.test.ts:29`

**Interfaces** (spec §5, D14):
- Consumes: `MAX_STEP_EDITS` (`sim/edits.ts`, Spec correction 1).
- Produces:
  - `blockHistory.ts`: `export const MAX_HISTORY_EDITS = 65_536;` `record(step)`: push, clear the redo side, then drop `done[0]` while the total edits of both sides exceed `MAX_HISTORY_EDITS` and `done.length > 1` (the new step kept whole). `restore(d, u)`: each side's newest 100 steps; a step over `MAX_STEP_EDITS` dropped; then, while the total exceeds 65,536, the oldest undo step (`done[0]`), then the redo step furthest from the present (`undone[0]`, the one redo reaches last);
  - `saves.ts`: `export const MAX_HISTORY_EDITS = 65_536;` (mirrored: persist cannot import ui); the normaliser applies `restore`'s rule after the 100-step cut, counting what it drops in `dropped`.

- [ ] **Step 1: Write the tests.**
  - `blockHistory.test.ts`: "two 32,768-edit steps then a 1-edit step: the older 32,768 step is dropped (D14: two maximum operations fill it)"; "a 32,768 step then a 1-edit step: both kept (32,769)"; "a 32,768 step after 50 one-edit steps keeps all 51 (32,818)"; "three 30,000 steps: the first dropped"; "the 100-step bound kept for 1-edit steps"; "`restore` drops a 32,769-edit step; with undo steps 30,000 × 2 and a 30,000 redo step drops the oldest undo step (60,000 left); with a 10,000 undo step and redo steps 30,000, 30,000, 10,000 (`undone[0]` first) drops the undo step, then `undone[0]` (40,000 left)".
  - `saves.test.ts`: the normaliser's same three `restore` cases, with `dropped` 1, 1 and 2.
  - `stateBounds.test.ts`: "`MAX_HISTORY_EDITS` of `saves.ts` equals `blockHistory.ts`'s, both 65,536; `MAX_STEP_EDITS` is 32,768" (or Task 5's 16,384).
  - SP5c describe: §6.3 holds `**Selection** (SP5c): the clipboard codec and its remap by state key; positions and states turned together (four turns the identity, the provisional boxes turned); the paste batch (changed cells only, the move's merge, bounds and refusals); the history's caps.`
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/blockHistory.test.ts test/unit/saves.test.ts test/unit/stateBounds.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `blockHistory.ts`'s comment states the caps (spec §12's list).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the block history capped at 65,536 changed blocks in all (SP5c D14)` (`git add src/ui/world/blockHistory.ts src/persist/saves.ts test/unit/blockHistory.test.ts test/unit/saves.test.ts test/unit/stateBounds.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 14: Keys: `ctrl` bindings, nine actions, the placing context

**Files:**
- Modify: `src/player/keymap.ts` (`Action` `:12-17`, `Binding` `:20-23`, `KeyEntry.group` `:29`, `DEFAULT_KEYMAP` `:48-78` and its comment, `resolveKey` `:90-100`, `resolveWheel` `:108-117`, `bindingLabel` `:141-148`), `src/player/input.ts` (`onKeyDown` `:117-131`, `onWheel` `:169-176`, the options `:80-95`), `src/ui/help.ts` (`GROUP_TITLES` `:41-43`), `src/ui/loading/tips.ts` (`TIP_TEMPLATES` `:17-31`), `src/ui/world/worldPage.ts` (the action switch: the nine cases as no-ops until Tasks 18-23 **(plan)**; `placing: () => false` until Task 22), `test/arch/masterSpec.test.ts`, master §5.9
- Test: `test/unit/keymap.test.ts`, `test/unit/input.test.ts`, `test/unit/help.test.ts`, `test/unit/tips.test.ts`

**Interfaces** (spec §1.1, D4):
- Consumes: `shortcutFor`'s Alt rule (`src/ui/common/keys.ts:41-42`); `wheelCtrlAsSlot` (`input.ts:90`, `:174`); `createWheelSteps` (`:62`).
- Produces:
  - `Action` gains `'selectTool' | 'copy' | 'cut' | 'paste' | 'move' | 'turn' | 'turnBack' | 'raise' | 'lower'`; `KeyEntry.group` gains `'select'`, titled "Selection tool"; the nine entries appended after `slotPrev`, each `since: 'SP5c'`, group `'select'`:

    | action | binding | label |
    |---|---|---|
    | `selectTool` | `{kind: 'code', code: 'KeyQ', ctrl: false}` | Selection tool on or off |
    | `copy` | `{kind: 'code', code: 'KeyC', ctrl: true}` | Copy the selection |
    | `cut` | `{kind: 'code', code: 'KeyX', ctrl: true}` | Cut the selection |
    | `paste` | `{kind: 'code', code: 'KeyV', ctrl: true}` | Paste |
    | `move` | `{kind: 'code', code: 'KeyN', ctrl: false}` | Move the selection |
    | `turn` | `wheel('down', false)` | Turn the paste 90° clockwise |
    | `turnBack` | `wheel('up', false)` | Turn the paste back 90° |
    | `raise` | `{kind: 'code', code: 'ArrowUp', ctrl: false}` | Raise the paste |
    | `lower` | `{kind: 'code', code: 'ArrowDown', ctrl: false}` | Lower the paste |

  - `Binding`'s code kind: `{ kind: 'code'; code: string; ctrl?: boolean }`: absent matches with or without Ctrl (moving with Ctrl held); `true` only with `ctrlKey || metaKey` and not `altKey` (AltGr sets both); `false` only without Ctrl or Cmd;
  - `resolveKey(e: { code: string; key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, map = DEFAULT_KEYMAP, active?: (a: Action) => boolean): Action | null` — `ctrl: true` code bindings first, then the other code bindings, then key bindings; an entry whose action `active` refuses is skipped; `resolveWheel(deltaY, ctrl, map = DEFAULT_KEYMAP, active?)` likewise; `bindingLabel` of a `ctrl: true` code binding → "Ctrl+C";
  - `export const PLACING_ACTIONS: ReadonlySet<Action>` (turn, turnBack, raise, lower); `export function placingContext(placing: boolean): (a: Action) => boolean` — while placing those four are active and `slotNext`, `slotPrev` are not; otherwise the reverse;
  - `attachInput`'s options gain `placing?(): boolean`; `onKeyDown` and `onWheel` resolve with `placingContext(o.placing?.() === true)`; an unresolved key is not prevented (so ↑, ↓ off placing, Ctrl+N, Ctrl+Q and AltGr+C pass to the browser);
  - tips: `'Press {selectTool} for the selection tool: LMB and RMB mark two corners, {copy} copies, {cut} cuts, {move} moves.'` and `'{paste} pastes: {turn} and {turnBack} turn the paste, {raise} and {lower} raise and lower it, RMB places it.'`.

- [ ] **Step 1: Write the tests** (spec §10.5's Keys):
  - `keymap.test.ts`: `:35` 29 → 38; the `since` rule (`:41`) gains the SP5c actions → `'SP5c'`, group `'select'`; "Ctrl+C resolves `copy`, plain C nothing; Ctrl+Alt+C nothing; Cmd+C `copy`; Ctrl+Q and Ctrl+N nothing; plain Q `selectTool`, plain N `move`; plain W still resolves `forward` with Ctrl"; `:55`'s "no binding is shared by two actions" becomes "a binding shared by two actions is between actions whose contexts exclude each other (never both active under `placingContext(true)` or `placingContext(false)`): only the plain wheel's `slotNext`/`turn` and `slotPrev`/`turnBack`"; "with the placing context off the plain wheel resolves `slotNext`/`slotPrev` and ↑, ↓ resolve nothing; on, `turn`/`turnBack` and `raise`/`lower`"; "`bindingLabel` of `{kind: 'code', code: 'KeyC', ctrl: true}` is `Ctrl+C`".
  - `input.test.ts`: Review Focus 3's cases (above), and "↑ and ↓ off placing are not prevented; while placing they are, and a held ↑ (`repeat` true) acts once".
  - `help.test.ts:41-48`: the "Selection tool" group's nine rows, the wheel's rows reading `Wheel down` and `Wheel up`; `help.test.ts:55`'s headings gain `'Selection tool'` after `'Build'`. `tips.test.ts:13`: 38, every action named; `tips.test.ts:25`'s sprint check becomes `/\bCtrl\b(?!\+(Wheel|[CXV]\b))/` (the selection tips name Ctrl+C, Ctrl+X and Ctrl+V; the sprint tip still names no Ctrl).
  - SP5c describe: §5.9 contains `E (creative palette); Q (selection tool; SP5c); Ctrl+C / Ctrl+X / Ctrl+V (copy, cut, paste; SP5c); N (move the selection; SP5c); while placing a paste, the wheel, ↑, ↓ (turn, raise, lower it; SP5c);` (`:1587`'s pin of the substring before it stays).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/keymap.test.ts test/unit/input.test.ts test/unit/help.test.ts test/unit/tips.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `DEFAULT_KEYMAP`'s comment names SP5c's group and the placing context.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (`uiSmoke.test.ts:1224-1227`'s `SMOKE_KEYS` unchanged until Task 29).
- [ ] **Step 5: Commit** `feat(player): Ctrl bindings, the selection tool's nine keys and the placing context (SP5c D4)` (`git add src/player/keymap.ts src/player/input.ts src/ui/help.ts src/ui/loading/tips.ts src/ui/world/worldPage.ts test/unit/keymap.test.ts test/unit/input.test.ts test/unit/help.test.ts test/unit/tips.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 15: The tool I: modes, corners, labels

**Files:**
- Create: `src/ui/world/selectTool.ts`
- Modify: `test/arch/masterSpec.test.ts` (row)
- Test: `test/unit/selectTool.test.ts`

**Interfaces** (spec §1.2, §1.3; pure):
- Consumes: Task 12's `Box`; Task 7's `formatCount`; `Action`; `MAX_COPY_SIDE`.
- Produces:
  - `export const SELECT_REACH = 32;` `export const MAX_SELECTION_SIDE = 64;` (equal to `MAX_COPY_SIDE`, pinned by a test);
  - `export type ToolMode = 'off' | 'select' | 'place';` `export interface Corner { readonly x: number; readonly y: number; readonly z: number }`;
  - `export interface SelectTool { readonly mode: ToolMode; readonly corner1: Corner | null; readonly corner2: Corner | null; readonly kind: 'paste' | 'move' | null; readonly turns: number; readonly offset: number; readonly version: number; toggle(): void; mark(button: 0 | 2, hit: Corner | null): void; place(kind: 'paste' | 'move'): boolean; turn(dir: 1 | -1): void; raise(dir: 1 | -1): void; cancel(): void; placed(b: Box): void; selection(): Box | null }`; `export function createSelectTool(): SelectTool`;
  - `selection()` (spec D3): with both corners, their box; with one corner set, the 1 × 1 × 1 box at it; with none, null. So the callers' "fewer than two corners" check reads `corner1` and `corner2`, never `selection()`;
  - transitions (spec §1.2): `toggle` off → select, select → off, place → off (cancel; corners kept for the page's life); `place('paste')` from off or select → place (turns 0, offset 0); `place('move')` only from select with both corners (false otherwise); in place: `turn` ±1 mod 4, `raise` ±1 on `offset`, `cancel` → select; `placed(b)` → select with the corners set to `b`'s; in select: `mark(0, hit)` → corner1, `mark(2, hit)` → corner2, a null hit no change; `version` moves on every change (the label and the box redraw only then);
  - `export function selectLabel(t: SelectTool, keyName: (a: Action) => string): string | null` (null with the tool off): `Selection tool: LMB marks corner 1, RMB corner 2`; `Corner 1 at x, y, z: RMB marks corner 2` / `Corner 2 at x, y, z: LMB marks corner 1`; `` `Selection ${W} × ${H} × ${D} (${formatCount(n)} blocks) · ${keyName('copy')} copy · ${keyName('cut')} cut · ${keyName('move')} move · ${keyName('paste')} paste` ``; over 64 a side: `Selection W × H × D: at most 64 blocks on a side`. The placing label is Task 16's.

- [ ] **Step 1: Write the tests** (`selectTool.test.ts`):
  - every transition of §1.2: Q from each mode; Ctrl+V from off and from select; N only with both corners (`place('move')` false otherwise); RMB, LMB, turn (four turns back to 0, `turn(-1)` from 0 to 3) and raise in place; LMB and RMB in select; a null hit;
  - "the corners survive off → select"; "`placed(b)` sets the corners to `b`'s min and max"; "`version` moves only on a change"; "`selection()` with corner 1 only (or corner 2 only) is the 1 × 1 × 1 box at it; with none, null";
  - the labels' texts with the key names `Ctrl+C`, `Ctrl+X`, `N`, `Ctrl+V` from `bindingLabel` and a thousands separator (`(262,144 blocks)` for 64³); "one corner: `Corner 1 at 10, 64, -3: RMB marks corner 2`"; "65 on a side: the over-64 text"; "the tool off: no label";
  - `MAX_SELECTION_SIDE === MAX_COPY_SIDE`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/selectTool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `SP5C_MODULES` row for `selectTool.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the selection tool's modes, corners and labels (SP5c D1-D3)` (`git add src/ui/world/selectTool.ts test/unit/selectTool.test.ts test/arch/masterSpec.test.ts`).

---

### Task 16: The tool II: the anchor, the main-thread checks, the throttled target read

**Files:**
- Modify: `src/ui/world/selectTool.ts`, `src/player/interaction.ts` (`acrossInto` added beside `across` `:97-104`, Spec correction 8), the SP5c spec (Spec correction 5: §2.5, §6.4; Spec corrections 8 and 9: §2.5)
- Test: `test/unit/selectTool.test.ts`, `test/unit/interaction.test.ts`

**Interfaces** (spec §2.5):
- Consumes: Task 12's `boxChecks`, `refusalText`, `Refusal`; Task 6's `CopiedMsg`; Task 9's `turnedSize`.
- Produces:
  - `interaction.ts`: `export function acrossInto(hit: { readonly x: number; readonly y: number; readonly z: number; readonly face: number }, out: Int32Array): void` (the voxel across the hit face written into `out[0..2]`, allocating nothing); `across(hit)` delegates to it and keeps its signature for `placeAt` and the buckets (`:148`, `:154`);
  - `export function anchorBox(hit: { x: number; y: number; z: number; face: number }, size: { w: number; h: number; d: number }, offset: number, out: Int32Array): void` — `a` = `acrossInto(hit, scratch)` into a module scratch `Int32Array(3)` (the turned sizes W′, H, D′ passed in); the min corner by face: +y (a.x − ⌊W′/2⌋, a.y, a.z − ⌊D′/2⌋); −y (a.x − ⌊W′/2⌋, a.y − H + 1, a.z − ⌊D′/2⌋); +x (a.x, a.y, a.z − ⌊D′/2⌋); −x (a.x − W′ + 1, a.y, a.z − ⌊D′/2⌋); +z (a.x − ⌊W′/2⌋, a.y, a.z); −z (a.x − ⌊W′/2⌋, a.y, a.z − D′ + 1); then y + `offset`; writes x0, y0, z0 into `out`; allocates nothing;
  - `export const TARGET_READ_SETTLE_MS = 100;`
  - `export interface GhostState { readonly box: Box | null; readonly refusal: Refusal | null; readonly counts: { readonly n: number; readonly m: number } | null }`;
  - `export function readRefusal(r: CopiedMsg): Refusal | null` — `why` `'unloaded'` → `{ why: 'unloaded' }`; otherwise null (the page never posts an `outside` box, §2.7); Task 22's `onRead` uses it for the ghost's refusal;
  - `export function createTargetReader(o: { timers: { set(f: () => void, ms: number): number; clear(id: number): void }; copy(b: Box): Promise<CopiedMsg>; onRead(b: Box, r: CopiedMsg): void }): { moved(b: Box | null): void; dispose(): void }` — `moved` with a new box restarts the 100 ms settle (one timer); at settle, posts `copy` unless one is in flight (the box then waits as the one queued, replacing an older queued one); a reply for a box that is no longer the last `moved` box is dropped; `moved(null)` (a refused or hidden ghost) cancels the settle and drops the in-flight reply;
  - `export function placingLabel(t: SelectTool, size: { w: number; h: number; d: number }, g: GhostState, keyName: (a: Action) => string, tooMany: boolean): string` **(plan)**: `` `Paste ${W} × ${H} × ${D}${turned} · ${counts} · RMB pastes, LMB cancels · ${turnHint} · ↑ ↓ raise or lower` `` (D11's wording) with `turnHint` = `Wheel turns` when `turn` and `turnBack` are the plain wheel's two directions (the default map), else `` `${keyName('turn')} / ${keyName('turnBack')} turn` `` (a wheel binding's own label reads `Wheel down`, `keymap.ts:141-142`), and `turned` = `` ` · turned ${90 · q}°` `` for q ≥ 1, `counts` `counting…` until a read, else `` `${formatCount(n)} blocks change, ${formatCount(m)} replaced` ``; "Move …" for a move; a refusal replaces the counts with its `refusalText`; ` · no preview: too many faces` appended when `tooMany`.
- The page runs `anchorBox` and `boxChecks` only when the hit voxel, its face, the turns or the offset change.

- [ ] **Step 1: Write the tests** (spec §10.5's tool):
  - "the anchor for each of the six faces, a 5 × 3 × 7 clipboard, turns 0-3 and offsets −2, 0, 3: the min corners above, and with offset 0 the box never covers the hit voxel (a side face's box never does at any offset)" (Spec correction 9); "10,000 `anchorBox` calls grow the heap by less than 256 KB";
  - `interaction.test.ts`: "`acrossInto` writes `across`'s voxel for each of the six faces";
  - "a ghost whose top is at y 319 raised once: `boxChecks` → `it would leave the world (y −64 … 319)`, `moved(null)`, no `copy`"; "a box reaching x = 524,288: `it would cross the world's edge`, no `copy`"; "a box whose 3 × 3 is not loaded: `part of it is not loaded`, no `copy`";
  - "the target read is posted only after 100 ms still (injected timers); a box moved every 50 ms for 2 s posts none; with one in flight and one queued, a third box replaces the queued one; a reply for a stale box is dropped"; "`readRefusal` of a `copied` with `why` `'unloaded'` gives a refusal whose `refusalText` is `part of it is not loaded`; of one with values, null";
  - the placing labels: `counting…`, `turned 90°`, `12,345 blocks change, 40 replaced`, a refusal's text, the move's, `no preview: too many faces`; with the default map the label ends `· RMB pastes, LMB cancels · Wheel turns · ↑ ↓ raise or lower`; with `turn` remapped to a key, its name and `turnBack`'s.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/selectTool.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the spec's §2.5 and §6.4 sentences reworded (Spec correction 5), and §2.5's `across` and "never covers" sentences (Spec corrections 8, 9).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the ghost's anchor, its main-thread checks and the throttled target read (SP5c §2.5)` (`git add src/ui/world/selectTool.ts src/player/interaction.ts test/unit/selectTool.test.ts test/unit/interaction.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 17: The volume box and the label element

**Files:**
- Modify: `src/render/selection.ts` (`createVolumeBox`; the comment `:1-15`), `src/render/renderer.ts` (`WorldRenderer` `:116-140`, the scene `:397-401`, `compile` `:466-470`), `src/ui/world/buildHud.ts` (`#world-select-label` beside `#world-slot-name` `:40-42`; `setSelectLabel`), `src/ui/styles.css` (`#world-select-label`, `pointer-events: none`, placed above the slot name **(plan)**), `test/arch/masterSpec.test.ts`, master §1's renderer line (`:175`)
- Test: `test/unit/selection.test.ts`, `test/unit/renderer.test.ts`, `test/unit/buildHud.test.ts`, `test/unit/zeroAlloc.test.ts`

**Interfaces** (spec §6.1):
- Consumes: `EDGES`, `OUTLINE_GROW`, `OUTLINE_ORDER` (`selection.ts:16-25`); the renderer's `withSectionsShown` (`renderer.ts:469`).
- Produces:
  - `selection.ts`: `export const SELECTION_YELLOW = 0xffd400;` `export const GHOST_CYAN = 0x3fd0ff;` `export const REFUSED_RED = 0xff4040;` `export const DIM_OPACITY = 0.35;` **(plan)** `export const AFTER_WATER_ORDER = 1 << 20;` (above any translucent region's `renderOrder`: RegionMesh gives its translucent regions 0 … N − 1 every frame, `src/render/regionMesh.ts:593-594`, and N passes 10 at RD 12, so a small order would sort between water regions on Firefox; RegionBatch's `sortTranslucent` is a no-op, `regionBatch.ts:332`), `export const GHOST_ORDER = AFTER_WATER_ORDER;` (the depth-tested ghost, Task 21) and `export const VOLUME_DIM_ORDER = AFTER_WATER_ORDER + 1;` (the through-terrain lines, after the ghost; the replaced-cell overlay shares it, Task 24); `export interface VolumeBox { readonly object: Group; set(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number): void; hide(): void; dispose(): void }`; `export function createVolumeBox(): VolumeBox` — one unit-cube `LineSegments` geometry shared by two objects: a depth-tested opaque `LineBasicMaterial` at `OUTLINE_ORDER`, and one with `depthTest: false`, `transparent: true`, `opacity: DIM_OPACITY` at `VOLUME_DIM_ORDER`; `set` moves and scales both with `OUTLINE_GROW` and sets both colours (`material.color.setHex`), allocating nothing;
  - `WorldRenderer` gains `setSelectionBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number): void`, `hideSelectionBox(): void`, `setGhostBox(…same…): void`, `hideGhostBox(): void` (scene coordinates, relative to the floating origin, as `setOutline`); `compile()` counts both boxes visible for its walk;
  - `mountBuildHud`'s result gains `setSelectLabel(text: string | null): void` (null hides; the text through `textContent`, set only when it differs).

- [ ] **Step 1: Write the tests.**
  - `selection.test.ts`: "`createVolumeBox` holds two objects sharing one geometry; the first depth-tested and opaque at `OUTLINE_ORDER`, the second `depthTest` false, transparent, opacity 0.35, `renderOrder` `VOLUME_DIM_ORDER`"; "`set` positions and scales both with `OUTLINE_GROW` and sets both colours"; "`hide` hides both"; "`GHOST_ORDER` and `VOLUME_DIM_ORDER` are above 65,536";
  - `renderer.test.ts`: "the two boxes are in the scene, hidden until `set`; `compile` counts them visible"; "with a RegionMesh holding 64 translucent regions after its sort, the dimmed box sorts after every one of them in three's transparent list";
  - `buildHud.test.ts`: "the label is hidden at mount, shown with its text, hidden by null; the same text twice writes once";
  - `zeroAlloc.test.ts` (`unit (heavy)`): "10,000 `set`s of a volume box (alternating colours) grow the heap by less than 256 KB";
  - SP5c describe: §1's renderer line contains `selection.ts (SP5a), the volume box (SP5c)` (`:1153`'s token pin unchanged).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/selection.test.ts test/unit/renderer.test.ts test/unit/buildHud.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `selection.ts`'s comment states the volume box.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): the selection's volume box, seen through terrain (SP5c D3)` (`git add src/render/selection.ts src/render/renderer.ts src/ui/world/buildHud.ts src/ui/styles.css test/unit/selection.test.ts test/unit/renderer.test.ts test/unit/buildHud.test.ts test/unit/zeroAlloc.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 18: The page I: Q, the corners, the box, Ctrl+C

**Files:**
- Modify: `src/ui/world/worldPage.ts` (`createClickQueue` `:1644-1703`, `createAim` `:1726-1781`, the `onButton` wiring `:3818-3821`, the action switch, the paused frame `:4049`, `createSelectActions` **(plan)**, the clipboard store's `kv()`)
- Test: `test/unit/worldPage.test.ts`, `test/unit/zeroAlloc.test.ts`

**Interfaces:**
- Consumes: Tasks 9-17's modules; `SimClient.copy`; `editPath`'s gate state through `coordinator.editState`; `WorldRenderer.setSelectionBox`; the build HUD's `setSelectLabel`; `bindingLabel`.
- Produces:
  - `createClickQueue`'s deps gain `tool?: { readonly mode: ToolMode; mark(button: 0 | 2, hit: Corner | null): void; confirm(): void; cancel(): void }`: with `tool.mode` `select`, LMB → `mark(0, the hit voxel or null)`, RMB → `mark(2, …)`; with `place`, RMB → `confirm()` (the page's adapter calls `selectActions.confirm()`, which acts on the box the frame step last anchored, so it takes no hit), LMB → `cancel()`; MMB does nothing while the tool is on; `breakAt`/`place` only with the tool off;
  - `createAim`'s deps gain `reach(): number` (**(plan)**: `SELECT_REACH` while the tool is on, else `REACH_WALK`/`REACH_FLY`; one cast per frame) and `selection?: { frame(hit: RayHit, paused: boolean, shown: boolean): void }` (the box written after the outline, hidden while paused, with the pointer free or without the HUD, as the outline); the page passes `selection: selectActions`;
  - the hold repeat: while the tool is on, `onButton` pushes the press to the click queue itself and does not call `holdRepeat.down` (`holdRepeat.ts:59-65`), so a held button acts once; and the page calls `holdRepeat.stop()` whenever the tool leaves `off` (Q here, Ctrl+V in Task 22), as `switchMode` does, because a repeat already held when the tool turns on keeps queuing its button at every `tick` (`holdRepeat.ts:85-89`) until `stop()` (`:80-83`), which would mark corners or confirm a paste with no new press (spec §1.2);
  - `export interface SelectActions { copy(): Promise<void>; cut(): Promise<void>; paste(): Promise<void>; move(): Promise<void>; frame(hit: RayHit, paused: boolean, shown: boolean): void; placeAt(x0: number, y0: number, z0: number, pin?: boolean): void; confirm(): Promise<string>; busy(): boolean; ghostState(): GhostState & { readonly shown: boolean } }` and `export function createSelectActions(o: { tool: SelectTool; sim: Pick<SimClient, 'copy'>; editState(cx: number, cz: number): 0 | 1 | 2; clipboard: ClipboardStore; actionPost(edits: readonly Edit[]): Promise<EditOutcome>; notices: { show(text: string, ms: number): void }; keyName(a: Action): string; view: { setSelectionBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number): void; hideSelectionBox(): void; setSelectLabel(text: string | null): void }; ghost: GhostHost; body(): BodyBox; stopRepeat(): void; timers?: { set(f: () => void, ms: number): number; clear(id: number): void } }): SelectActions` **(plan)**, with `copy`, `busy` and `frame`'s box and label in this task (cut, paste, `placeAt`, `confirm`, `ghostState`, the frame's ghost steps and move follow in Tasks 19, 22, 23); `view` is the renderer's and the build HUD's setters (Task 17), no-ops in the harnesses; `stopRepeat` is the page's `holdRepeat.stop` (a no-op in the harnesses); `timers` feed Task 16's target reader (default `globalThis`'s, as Task 7's); `GhostState` is Task 16's.
  - **(plan)** `export interface GhostHost { setGhostBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number): void; hideGhostBox(): void; setGhost(w: number, h: number, d: number, values: Uint32Array): void; ghostStep(): void; placeGhost(x0: number, y0: number, z0: number, q: number): void; hideGhost(): void; ghostBuild(): 'empty' | 'building' | 'ready' | 'tooMany'; setReplaced(x0: number, y0: number, z0: number, cells: Int32Array, count: number): void; hideReplaced(): void }` in `worldPage.ts`: the `WorldRenderer` methods of Tasks 17, 21 and 24 (the page passes the renderer; `WorldRenderer` must satisfy it structurally once Task 24 lands, Task 21's `GhostBuild` being the same union), no-ops until those tasks and in the harnesses.
  - **(plan)** One operation at a time (Review Focus 2): `busy()` is true from the start of `copy`, `cut`, `paste` (its clipboard read), `move` (its read) or `confirm` to its last await, refused or not. While busy, every tool action (`selectTool`, `copy`, `cut`, `paste`, `move`, `turn`, `turnBack`, `raise`, `lower`) and every press reaching the click queue's tool branch is ignored, so a double RMB pastes once and LMB right after RMB does not cancel a paste already posted.
  - Over 64 a side, the label reads D3's text and the notice at Ctrl+C, Ctrl+X and N §1.4's (Spec correction 12).
  - `frame(hit, paused, shown)` is the per-frame home of the box and label (this task) and of Task 22's ghost steps 1-4, so the zero-allocation tests drive the page's own code: it writes the selection box (`SELECTION_YELLOW`, or `REFUSED_RED` over 64 a side) and the label only when `tool.version` changed, and hides the box while `paused` or not `shown`.
  - `placeAt(x0, y0, z0, pin = false)` (Task 22): the ghost's min corner set as an aim would set it (the box's checks, the colour, `placeGhost`, the target reader's `moved`, the label), counted as an aim since Ctrl+V; with `pin`, the frame's anchor step leaves the corner alone until the paste or move is confirmed or cancelled (a turn or a raise keeps the pinned corner; the sizes turn about it and the offset is not applied while pinned), so the harnesses (Tasks 27, 29, 31) place a paste at a chosen box. `confirm()` (Tasks 22, 23) uses the current box and resolves `'ok'` on an accepted paste or move, the notice's text on a refusal (e.g. `Can't paste here: you are inside it`), or `''` when it did nothing (not placing, or no aim since Ctrl+V).
- The notices of spec §1.4, each with the task that shows it:

  | when | text | time | task |
  |---|---|---|---|
  | copy, cut or move done | Copied / Cut / Moved W × H × D | 1.5 s | 18, 19, 23 |
  | paste done | Pasted W × H × D | 1.5 s | 22 |
  | fewer than two corners | Mark two corners first: Q, then LMB and RMB | 4 s | 18, 19, 23 |
  | over 64 a side | The selection is larger than 64 blocks on a side | 4 s | 18, 19, 23 |
  | an unloaded column | Part of the selection is not loaded: come closer and try again | 4 s | 18, 19, 23 |
  | no clipboard | The clipboard is empty: select a volume (Q) and copy it (Ctrl+C) | 4 s | 22 |
  | the kept clipboard unreadable | The kept clipboard could not be read | 4 s | 22 |
  | unknown state keys | n blocks of unknown types became air | 6 s | 22 |
  | a refused paste or move | Can't paste here: <reason> / Can't move here: <reason> | 4 s | 22, 23 |
  | a refused cut | Can't cut: <reason> | 4 s | 19 |
  | a cut's write failed | Could not keep the clipboard (<reason>): nothing was cut | 6 s | 19 |
  | the first copy without storage | The clipboard is kept only until this page closes: this browser window cannot store data | 6 s | 11 |
  | a bulk batch past 250 ms | Working on n blocks… | until its reply | 7 |

  The key names in these texts come from the key map (`Q`, `Ctrl+C`).
- Copy (spec §2.1): the checks above (fewer than two corners read from `tool.corner1`/`corner2`, since `selection()` is a one-block box with one corner), then `copy(box, false)`; `copied` null → the unloaded notice; else the clipboard built, kept and written (a failed write of a copy keeps the memory copy and shows `Could not keep the clipboard (<reason>)` 6 s **(plan)**); `Copied W × H × D`. A copy works while regenerating. The page's `kv()` (Task 11) is wired here.

- [ ] **Step 1: Write the tests.**
  - `worldPage.test.ts`, the click queue and the aim: "with the tool on, LMB marks corner 1 and RMB corner 2 at the hit; a miss changes nothing; MMB does nothing; with the tool off the queue breaks and places as before"; "with the tool on and hold repeat on, a held RMB over 2 s of frames queues exactly one press"; "RMB held placing blocks with hold repeat on, then Q: over 2 s of frames no RMB reaches the tool (no corner 2 marked; `holdRepeat.stop()` called)"; "the aim casts with reach 32 while the tool is on (a block 20 away is hit), 6 and 10 otherwise"; "a paused frame (help, palette, place dialog, Settings, the map owning the controls) hides the box and clears queued clicks";
  - `worldPage.test.ts`, the copy: the copy rows of the table with their times; "a copy while an Apply regenerates reads and writes the clipboard"; "Ctrl+C with the tool off does nothing; with focus in a text field nothing resolves";
  - `worldPage.test.ts`, the box and label: "Q, then one mark: a one-block yellow box at the corner and the label `Corner 1 at x, y, z: RMB marks corner 2`; Ctrl+C then shows `Mark two corners first: Q, then LMB and RMB`"; "Q, then two marks: the box shown in yellow and the label `Selection 3 × 2 × 4 (24 blocks) · Ctrl+C copy · Ctrl+X cut · N move · Ctrl+V paste`"; "a 65-wide selection: the box red and the over-64 label"; "Q again hides the box and the label; a third Q shows the kept corners' box and label";
  - `worldPage.test.ts`, the guard: "a second Ctrl+C while the first's `copy` is in flight posts no second `copy`; `busy()` is false after its reply and after a refusal";
  - `zeroAlloc.test.ts`: "10,000 frame steps at rest with the selection box shown (both corners set, the aim fixed) stay under 256 B per tick" — the test builds `createSelectActions` (no-op `view`, `ghost` and stores) and passes it to `createAim` as `selection`, as the page does.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; the action switch's `selectTool` and `copy` cases act (spec §1.1: `copy` only with the tool on and not placing; none while `busy()`); D5's and §2.7's "D3's text" reworded (Spec correction 12).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Q, the corners, the selection box and Ctrl+C (SP5c D1, D2, D3, D5)` (`git add src/ui/world/worldPage.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 19: The page II: Ctrl+X

**Files:**
- Modify: `src/ui/world/worldPage.ts` (`createSelectActions.cut`; the `cut` action case), the SP5c spec (Spec correction 7: D6's last sentences and §2.2 step 5)
- Test: `test/unit/worldPage.test.ts`

**Interfaces** (spec §2.2, D6, D26):
- Consumes: Task 12's `cutBatch`, `refusalText`; Task 11's `ClipboardStore.write`; `actionPost` (`createActionPost`, `blockHistory.ts:174-184`).
- Produces: `cut(): Promise<void>`, in this order: (1) fewer than two corners → `Mark two corners first: Q, then LMB and RMB` 4 s; a side over 64 → `The selection is larger than 64 blocks on a side` 4 s; then `copy(box, false)` (null → the unloaded notice); (2) `cutBatch`; (3) the page's checks before anything is written: the cap (`Can't cut: it would change n blocks; at most 32,768 at once`) and `editState` over every edited column (`Can't cut: part of it is not loaded`, `Can't cut: the world is regenerating`) — any of them leaves the previous clipboard unwritten; (4) the clipboard built and `clipboard.write` awaited (a failure: `Could not keep the clipboard (<reason>): nothing was cut` 6 s, nothing posted); (5) `actionPost(batch)` as one step; accepted → `Cut W × H × D` 1.5 s; `'changed'` → `Can't cut: the blocks changed; try again` 4 s (the clipboard holds the selection, the box as it was); `'full'` → the edit path's own notice; `'unloaded'` / `'regenerating'` from the gate, which runs again inside `post` after the awaited write (Spec correction 7) → `Can't cut: part of it is not loaded` / `Can't cut: the world is regenerating` 4 s (the clipboard then holds the selection, as after `'changed'`); `'noProto'` → the `unloaded` text; `'failed'` → nothing (the sim's failure notice shows).

- [ ] **Step 1: Write the tests** (`worldPage.test.ts`, spec §10.5's cut order):
  - "Ctrl+X with one corner: `Mark two corners first: Q, then LMB and RMB` 4 s; with a 65-wide selection: `The selection is larger than 64 blocks on a side` 4 s; neither posts a `copy`";
  - "a cut refused by the cap, by `unloaded` or by `regenerating` leaves the previous clipboard (`clipboard.write` never called), each with its `Can't cut: …` text";
  - "an Apply started while the cut's clipboard write is pending (`writeDelayMs` 200; `editState` 2 from 100 ms): `Can't cut: the world is regenerating`, no `edits` posted, every cell unchanged, the clipboard holding the selection";
  - "a failed clipboard write (`failAt(0, 'QuotaExceededError')`) posts nothing and shows `Could not keep the clipboard (…): nothing was cut` for 6 s";
  - "the post is issued only after the write's `complete` (a `MemoryKV` with `writeDelayMs` 200: no `edits` before 200 ms)";
  - "a sim `'changed'` after the write: the clipboard holds the selection, every cell unchanged, `Can't cut: the blocks changed; try again`";
  - "an accepted cut is one step and `Cut 4 × 3 × 5`; Ctrl+Z restores every cell; a cut ladder's water goes with it (D6: every fluid goes)";
  - Review Focus 2's cut case (above).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; D6's "Only the sim's own refusals (the blocks changed, memory full) can follow the write" and §2.2 step 5's "Only the sim's refusals (`'changed'`, `'full'`) can come after step 4" reworded: the edit path's gate (an unloaded column, a regeneration) and the sim's refusals can follow the write; each leaves the box as it was and the clipboard holding the selection (Spec correction 7).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Ctrl+X cuts only after the clipboard is kept (SP5c D6)` (`git add src/ui/world/worldPage.ts test/unit/worldPage.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 20: The ghost material

**Files:**
- Modify: `src/render/materials/index.ts` (`MaterialSystem` `:27-43`, `createMaterialSystem` `:60-104`, the comment `:10-15`), `src/render/materials/glsl/terrain.glsl.ts` (`TERRAIN_FRAGMENT` `:84-101` under `GHOST`), `src/render/materials/uniforms.ts` (the ghost's uniforms), `test/arch/masterSpec.test.ts`, master §1's `materials/` line (`:179`)
- Test: `test/unit/materials.test.ts`

**Interfaces** (spec §6.2, D25):
- Consumes: `terrainVertex(variant)`, `terrainDefines()`, `terrainUniforms(u)`; face ids north 0, east 1, south 2, west 3, up 4, down 5 (`src/world/blocks/kinds.ts:27-32`).
- Produces:
  - `MaterialSystem` gains `readonly ghost: ShaderMaterial` (name `'ghost'`, the variant's terrain vertex shader, `TERRAIN_FRAGMENT` with `CUTOUT`, `GHOST` and `terrainDefines()`, `transparent: true`, `depthWrite: false`, depth-tested, `DoubleSide` as the cutout's) and `setGhostTurns(q: number): void` (writes the uniform; no allocation); it joins `materials` for `dispose`;
  - `export const GHOST_ALPHA = 0.45;` `export const GHOST_LIGHT_FLOOR = 0.6;` Under `#ifdef GHOST` the fragment: `uint face = vFace < 4u ? (vFace + ghostTurns) % 4u : vFace;` used for both the glass frame's in-face coordinates and `FACE_SHADE`; light `max(lightmapAt(vBlock, vSky), vec3(GHOST_LIGHT_FLOOR))`; alpha `ghostAlpha`. Without `GHOST` the fragment is byte-identical to today's.

- [ ] **Step 1: Write the tests** (`materials.test.ts`):
  - "the ghost material: defines `CUTOUT` and `GHOST`, transparent, `depthWrite` false, `depthTest` true, uniforms `ghostAlpha` 0.45 and `ghostTurns` 0, in both variants";
  - "its fragment source remaps the face before both uses (the glass frame's in-face coordinates and `FACE_SHADE`), writes alpha from `ghostAlpha` and floors the light at 0.6";
  - "the source with `GHOST` undefined equals today's `TERRAIN_FRAGMENT` (no ghost code outside `#ifdef GHOST`), so the terrain materials are unchanged";
  - "`setGhostTurns(3)` writes 3; `dispose` frees the ghost material";
  - SP5c describe: §1's materials line contains `(SP5c: the ghost material, a GHOST define)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/materials.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `index.ts:14`'s "selection come with their SPs" names the ghost as built.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (`banned.ts`: the GLSL stays in `render/materials`).
- [ ] **Step 5: Commit** `feat(render): the ghost material, translucent, turned and lit at night (SP5c D25)` (`git add src/render/materials/index.ts src/render/materials/glsl/terrain.glsl.ts src/render/materials/uniforms.ts test/unit/materials.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 21: The ghost mesh: `render/ghost.ts`

**Files:**
- Create: `src/render/ghost.ts`
- Modify: `src/render/renderer.ts` (methods; `compile` with a hidden ghost placeholder), `test/arch/masterSpec.test.ts` (row; §4.5), master §1's render entry, §4.5 (`:1058`, `:1062`)
- Test: `test/unit/ghost.test.ts`, `test/unit/renderer.test.ts`

**Interfaces** (spec §6.2, §6.4):
- Consumes: `PaddedSection` and `padIndex` (`src/world/store/padded.ts:26-46`), `meshSolid` (`src/mesh/greedy.ts:145`), `meshBoxes` (`src/mesh/boxes.ts:59`), RegionMesh's Uint16 position layout (`src/render/regionMesh.ts:11-13`, `:180-182`), Task 20's `ghost` material and `setGhostTurns`.
- Produces:
  - `export const GHOST_SLICE_MS = 1;` `export const GHOST_MAX_QUADS = 131_072;` `export type GhostBuild = 'empty' | 'building' | 'ready' | 'tooMany';`
  - `export interface Ghost { readonly object: Mesh; readonly build: GhostBuild; readonly lastSliceMs: number; setClipboard(w: number, h: number, d: number, values: Uint32Array): void; step(now: () => number): void; place(x0: number, y0: number, z0: number, q: number): void; hide(): void; dispose(): void }`; `export function createGhost(m: MaterialSystem): Ghost`;
  - `setClipboard` starts a new build; `step` builds 16³ cells in order (sketch below), each through a `PaddedSection` filled from the clipboard (its border from the neighbouring cells, air outside; light `0xF0`, sky 15, as above the world, `padded.ts:23-24`), `meshSolid` and `meshBoxes` (AO on), opaque and cutout quads appended into growable arrays with positions widened to Uint16 in 1/8-block units; fluids are not meshed; over `GHOST_MAX_QUADS` the build stops at `'tooMany'` with no geometry; the `BufferGeometry` is uploaded once when the last cell is done:
    ```
    step(now): if (build !== 'building') return
      const t0 = now()
      do { meshCell(next++) } while (next < cells && build === 'building' && now() − t0 < GHOST_SLICE_MS)
      lastSliceMs = now() − t0
      if (next === cells && build === 'building') { upload(); build = 'ready' }
    ```
  - the mesh's `renderOrder` is `GHOST_ORDER` (Task 17's, after every translucent region on RegionMesh too);
  - `place`: the mesh's position is the box's min corner (scene coordinates) plus the turn's translation (q 1: (D, 0, 0); q 2: (W, 0, D); q 3: (0, 0, W), W and D unturned), `rotation.y = −q · π / 2`, scale 1/8, and `setGhostTurns(q)`; it writes the matrix only and allocates nothing;
  - `WorldRenderer` gains `setGhost(w: number, h: number, d: number, values: Uint32Array): void`, `ghostStep(): void` (once per rendered frame), `placeGhost(x0: number, y0: number, z0: number, q: number): void`, `hideGhost(): void`, `ghostBuild(): GhostBuild`, `ghostSliceMs(): number`; `compile()` shows a hidden one-cell placeholder of the ghost for its walk, so the first Ctrl+V does not link a program.

- [ ] **Step 1: Write the tests.**
  - `ghost.test.ts` (three without WebGL): "a 1 × 1 × 1 stone clipboard builds 6 quads"; "a glass pane and a wall torch build cutout and box quads into the one geometry";
  - "a solid 64³ clipboard on an injected clock advancing 0.3 ms per cell: each slice stops after the cell that crosses 1 ms (4 cells), 64 cells in 16 slices, uploaded once at the end; `lastSliceMs` recorded per slice";
  - "a clipboard whose quads pass 131,072 (a 64³ checkerboard) ends `'tooMany'` with no geometry"; "`setClipboard` during a build restarts it";
  - "`place` for q 0-3 maps the centre of cell (x, y, z) to the world cell §2.6 gives ((D − 1 − z, y, x) for q 1), checked through `object.matrixWorld`"; "`place` 10,000 times grows the heap by less than 256 KB";
  - `renderer.test.ts`: "the ghost is in the scene at `renderOrder` `GHOST_ORDER`, hidden until placed; `compile` counts its placeholder visible"; "with a RegionMesh holding 64 translucent regions after its sort, the ghost sorts after every one of them and before the dimmed box";
  - SP5c describe: §1's render entry names `ghost.ts (SP5c)`; §4.5 contains `7. Selection box, and with the selection tool (SP5c) its volume box and the ghost, drawn after the translucent pass.` and `selection 1 (up to 7 while the selection tool shows a box and a ghost, SP5c)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/ghost.test.ts test/unit/renderer.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `SP5C_MODULES` row for `src/render/ghost.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): the ghost's sliced mesh, placed and turned by its matrix (SP5c D11, D25)` (`git add src/render/ghost.ts test/unit/ghost.test.ts src/render/renderer.ts test/unit/renderer.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 22: The page III: Ctrl+V, the ghost, turn, raise, RMB

**Files:**
- Modify: `src/ui/world/worldPage.ts` (`createSelectActions.paste`, `placeAt`, `confirm`; `frame`'s ghost steps; `placing` for `attachInput`; the `paste`, `turn`, `turnBack`, `raise`, `lower` action cases)
- Test: `test/unit/worldPage.test.ts`, `test/unit/zeroAlloc.test.ts`

**Interfaces** (spec §2.3, §2.5, D7, D9, D13, D15, D16):
- Consumes: Task 16's `anchorBox`, `createTargetReader`, `readRefusal`, `placingLabel`; Task 12's `boxChecks`, `pasteBatch`, `bodyHits`; Task 21's renderer methods; `bodyOf` (`interaction.ts:65`).
- Produces:
  - `paste(): Promise<void>` — `clipboard.read()`; none → the empty notice; unreadable → the unreadable notice; `unknown` > 0 → `n blocks of unknown types became air` 6 s, and the paste goes on (D15: those cells are air in the decoded clipboard); then `tool.place('paste')` (the tool turned on if off; `o.stopRepeat()` as Task 18), `setGhost(…)` and the anchor's change key cleared (the size changes too); the ghost hidden until the first aim;
  - `frame(hit, paused, shown)` (Task 18's), per rendered frame while placing, in this order:
    1. the aim's hit (reach 32; a miss leaves the ghost where it was; no aim since Ctrl+V keeps it hidden);
    2. unless the corner is pinned (`placeAt(…, true)`), when the hit voxel, its face, the turns or the offset differ from the change key: `anchorBox` with the turned sizes, then `placeAt(x0, y0, z0)`, which runs `boxChecks`, the ghost box's colour (`GHOST_CYAN`, or `REFUSED_RED` with the refusal), `placeGhost`, `targetReader.moved(box or null)` and the label (`placingLabel`); the change key updated;
    3. `ghostStep()` (one slice at most), the label's `no preview: too many faces` once the build ends `'tooMany'`;
    4. paused: the ghost, its box and the overlay hidden, the target reader's `moved(null)`, and the anchor's change key cleared, so the first unpaused frame re-anchors and re-reads the target even with the aim unchanged.
    The `turn`, `turnBack`, `raise`, `lower` actions act through `tool` and mark the anchor changed (pinned: the box re-checked at the pinned corner);
  - `placeAt(x0, y0, z0, pin = false)` as Task 18 states it; `onRead` sets the ghost's refusal from `readRefusal`; `ghostState()` returns the current box, refusal, counts and whether the ghost is shown (the smoke's `ghost()` hook, Task 29);
  - `confirm()` (RMB, through the click queue's adapter): no aim since Ctrl+V → `''`, nothing; the box's checks and `bodyHits` (walking: the walk's feet; flying: the eye's; `bodyOf`) → `Can't paste here: <reason>` 4 s, the ghost kept; `copy(box, false)` of the target (`unloaded` → the refusal); `pasteBatch` (`tooMany` → the refusal); `actionPost` as one step; accepted → `Pasted W × H × D` 1.5 s, `tool.placed(box)`, `'ok'`; `'changed'` → `Can't paste here: the blocks changed; try again` 4 s, the ghost kept; `'unloaded'` / `'regenerating'` from the gate (which runs again inside `post`, after the awaited target `copy`; Spec correction 7) → `Can't paste here: part of it is not loaded` / `Can't paste here: the world is regenerating` 4 s, the ghost kept; `'noProto'` → the `unloaded` text; `'full'` → the edit path's own notice; `'failed'` → nothing (the sim's failure notice shows). Each refusal resolves with its notice's text. The ghost and the paste use the clipboard read at Ctrl+V; LMB or Q cancels;
  - `attachInput`'s `placing` reads `tool.mode === 'place'`.

- [ ] **Step 1: Write the tests.**
  - `worldPage.test.ts`, Ctrl+V: "with the tool off it turns the tool on and shows the ghost at the first aim; with no aim since Ctrl+V, RMB does nothing"; "each paste row of Task 18's notice table with its time"; "a clipboard with 3 unknown-key cells shows `3 blocks of unknown types became air` and the ghost, and RMB pastes air there"; "RMB held placing blocks with hold repeat on, then Ctrl+V and an aim: over 2 s of frames no RMB reaches the tool (no confirm)";
  - `worldPage.test.ts`, placing: "the wheel turns the ghost (the label `turned 90°`, `placeGhost` with q 1) and ↑ raises it by 1 for the rest of the placing"; "a ghost moved every frame posts no target `copy` until it rests 100 ms"; "LMB and Q cancel with nothing changed"; "Ctrl+V, aim, open and close the help with the aim unchanged: the ghost shows again and one target `copy` is posted 100 ms after the resume"; "a second Ctrl+V of a different-size clipboard at the same aim re-anchors the ghost (its box the new size)"; "`placeAt(…, true)` then a wheel turn: the min corner stays pinned while the aim points elsewhere; `confirm()` pastes there";
  - `worldPage.test.ts`, RMB: "a refusal keeps the ghost; a paste over the player's body is refused `you are inside it` and `confirm()` resolves its text"; "an accepted paste is one step, the selection is the pasted box, the mode `select` and `confirm()` resolves `'ok'`"; "a `'changed'` reply: `Can't paste here: the blocks changed; try again`, the ghost kept"; "an Apply started after the target `copy` was posted (`editState` 2 at its reply): `Can't paste here: the world is regenerating`, nothing posted, the ghost kept";
  - Review Focus 2's paste case and Review Focus 4's case (above);
  - "after a first aim, a frame whose cast misses (the sky) leaves the ghost and its box where they were and posts no target `copy`";
  - "a paste is refused while regenerating (`Can't paste here: the world is regenerating`), never makes a backup (no `beforeApply` call), and works with the mode on or off";
  - `zeroAlloc.test.ts`: "10,000 frame steps at rest with the ghost shown at a fixed aim and turn (built and placed) stay under 256 B per tick" (through `createSelectActions` passed to `createAim` as `selection`, as Task 18's).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Ctrl+V's ghost, turned with the wheel, pasted with RMB (SP5c D7, D9, D13)` (`git add src/ui/world/worldPage.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts`).

---

### Task 23: The page IV: N, the move

**Files:**
- Modify: `src/ui/world/worldPage.ts` (`createSelectActions.move` and the move's `confirm`; the `move` action case), `test/arch/masterSpec.test.ts`, master §4.12 (after the Block undo line `:1180`)
- Test: `test/unit/worldPage.test.ts`

**Interfaces** (spec §2.4, D8):
- Consumes: Task 12's `moveBatch`; Task 6's `copy(box, gen)`.
- Produces: `move(): Promise<void>` — fewer than two corners, a side over 64 or an unloaded column → the copy's notices; else `copy(selection, false)` → the ghost shows those values (the clipboard untouched), `tool.place('move')` and the anchor's change key cleared (Task 22). The move's `confirm()`: the box's checks and the body; `copy(source, true)` then `copy(target, false)` (two messages, answered in order); `moveBatch(q, source, srcNow, srcGen, target, targetNow)` with `srcNow`/`srcGen` from this confirm's `copy(source, true)` (spec §2.4, never the N-time copy the ghost shows); `Can't move here: <reason>` for its refusals; `actionPost` as one step; accepted → `Moved W × H × D` 1.5 s, `tool.placed(target)`, `'ok'`; `'changed'` → `Can't move here: the blocks changed; try again` 4 s; `'unloaded'` / `'regenerating'` from the gate (Spec correction 7) → `Can't move here: part of it is not loaded` / `Can't move here: the world is regenerating` 4 s; `'noProto'` (a source column's proto gone for a `revert`) → the `unloaded` text; `'full'` → the edit path's own notice; `'failed'` → nothing; each refusal keeps the ghost and resolves with its notice's text. LMB or Q cancels with nothing changed.

- [ ] **Step 1: Write the tests.**
  - `worldPage.test.ts`: "a floating house moved 6 blocks down onto the ground with N and RMB: the source air, the target the house, one step, `Moved 8 × 5 × 8`; one Ctrl+Z restores both boxes";
  - "a house moved 3 blocks down (overlapping its source): every cell right, one step";
  - "a buried house moved up: the source cells outside the target equal the generated ground";
  - "the clipboard is not changed by a move"; "LMB after N changes nothing"; "N with one corner: `Mark two corners first: Q, then LMB and RMB`"; "N with a 65-wide selection: `The selection is larger than 64 blocks on a side`"; "a move whose target is refused: `Can't move here: <reason>`";
  - "a Ctrl+Z of a block inside the source while placing, then RMB: the target holds the source as read at RMB, and the source cells outside the target are generated";
  - "an Apply started after the two `copy`s were posted (`editState` 2 at their replies): `Can't move here: the world is regenerating`, nothing posted, both boxes unchanged";
  - SP5c describe: §4.12 holds the paragraph starting `**Selection tool** (SP5c): Q turns it on;` as spec §13 words it (with Task 5's cap), right after the Block undo line (`:1540`'s pin unchanged).
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/worldPage.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): N moves the selection, its source back to the terrain (SP5c D8)` (`git add src/ui/world/worldPage.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 24: The replaced-cell overlay and the counts

**Files:**
- Modify: `src/render/ghost.ts` (the overlay), `src/render/renderer.ts` (`setReplaced`, `hideReplaced`; `compile`), `src/ui/world/worldPage.ts` (the target reply's count and fill)
- Test: `test/unit/ghost.test.ts`, `test/unit/renderer.test.ts`, `test/unit/worldPage.test.ts`

**Interfaces** (spec §6.3, §2.5):
- Consumes: Task 16's target reader's `onRead`; `turnedCell`.
- Produces:
  - `export const REPLACED_MAX = 4096;` `export const REPLACED_OPACITY = 0.3;` `export const REPLACED_GROW = 0.01;` one `InstancedMesh` of a unit cube grown by 0.01, `MeshBasicMaterial` red `0xff4040`, opacity 0.3, transparent, `depthTest: false`, `renderOrder` `VOLUME_DIM_ORDER` (Task 17's: after every translucent region and the ghost), capacity 4,096, its instance buffer allocated once (256 KB);
  - `WorldRenderer.setReplaced(x0: number, y0: number, z0: number, cells: Int32Array, count: number): void` (cell offsets as x, y, z triples; `count` drawn), `hideReplaced(): void`; `compile()` shows the overlay for its walk (three's instancing variant is new to the page);
  - the page, on a target reply for the current box: n = changed cells, m = changed cells whose target value is not 0, the first `min(m, 4096)` replaced cells in index order (x, then z, then y) into a scratch `Int32Array` allocated once (3 × 4,096); the label's counts; the overlay hidden with the ghost and while paused.

- [ ] **Step 1: Write the tests.**
  - `ghost.test.ts`: "`setReplaced` with 5,000 cells draws 4,096 (`count`), each instance matrix at its cell grown by 0.01"; "1,000 fills grow the heap by less than 256 KB";
  - `worldPage.test.ts`: "a target reply with 40 replaced among 3,296 changed: the label reads `3,296 blocks change, 40 replaced` and the overlay draws 40"; "a reply for a stale box changes nothing"; "air written over air is neither changed nor replaced; a fluid replaced by air is replaced"; "the overlay hides with the ghost and while paused";
  - `renderer.test.ts`: the overlay in the scene at `renderOrder` `VOLUME_DIM_ORDER`, sorting after every translucent region of a RegionMesh holding 64 of them and after the ghost, and in `compile`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/ghost.test.ts test/unit/renderer.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): the blocks a paste replaces, in red through terrain (SP5c D11)` (`git add src/render/ghost.ts src/render/renderer.ts src/ui/world/worldPage.ts test/unit/ghost.test.ts test/unit/renderer.test.ts test/unit/worldPage.test.ts`).

---

### Task 25: UX notes 1 and 2: Rename's Save; the Modify terrain notice

**Files:**
- Modify: `src/ui/worldsMenu.ts` (`startRename` `:441-480`, the comments `:20-21` and `:438-440`), `src/ui/world/modifyMode.ts` (`set` `:156-164`, the comment `:8`), the SP5b spec's D3 sentence (spec §7.1: "Enter or Save keeps, Esc cancels")
- Test: `test/unit/worldsMenu.test.ts`, `test/unit/modifyMode.test.ts`

**Interfaces** (spec §7.1, §7.2):
- Consumes: `underLock`, `writesStopped`, `cancel` (`worldsMenu.ts:450-477`); `createModifyMode`'s `o.backup.notices` (`modifyMode.ts:98-103`, `:133`), `BACKUP_NOTICE_MS` (`:58`).
- Produces:
  - `startRename` inserts after `input.world-name-input` a `button.world-rename-save` with the text "Save"; one `commit()` serves Enter and the button: trim; empty, unchanged or writes stopped → `cancel()`; else the input and the button disabled and `underLock(world.id, 'renamed', () => saves.rename(world.id, typed))`; `close()` removes the button; Esc unchanged; no blur handler;
  - `export const MODIFY_ON_NOTICE = "Modify terrain is on: the first terrain change saves a backup copy of this world first, if you have built in it.";` `set(true)` from off shows it with `{ kind: 'info', timeoutMs: BACKUP_NOTICE_MS }` (6,000 ms); not when already on (`:158`'s early return), not at switch off.

- [ ] **Step 1: Write the tests.**
  - `worldsMenu.test.ts` (DOM shim): "Save renames to the trimmed name"; "Save with the unchanged name writes nothing and closes"; "Save with an empty name writes nothing and closes"; "the button is disabled while the write runs and gone after"; "a held lock refuses it with D7's notice as Enter does"; "Enter and Esc unchanged";
  - `modifyMode.test.ts`: "`set(true)` shows the text once with 6,000 ms"; "`set(true)` again shows nothing"; "`set(false)` shows nothing"; "a backup's `Backup saved as …` still shows after it".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldsMenu.test.ts test/unit/modifyMode.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `modifyMode.ts:8`'s "neither switch shows a notice" reworded; `worldsMenu.ts:20-21` reads "Enter or Save keeps, Esc cancels"; SP5b's D3 sentence likewise.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Rename's Save button and the Modify terrain notice (SP5c D17, D18)` (`git add src/ui/worldsMenu.ts src/ui/world/modifyMode.ts test/unit/worldsMenu.test.ts test/unit/modifyMode.test.ts docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 26: UX note 3: the reminder on disabled parameters

**Files:**
- Create: `src/ui/common/modeTip.ts`
- Modify: `src/ui/paramPanel/controls.ts` (`lockInput` `:184-191`; the badge, dot and reset titles `:281-286`; `:305`, `:314`, `:427-431`, `:629-631`), `src/ui/map/toolbar.ts` (`setEditable` `:254-258`; the Undo/Redo group `:167`), `src/ui/biomeTable/table.ts` (`:375-379`, `:457-460`), `src/ui/splineEditor/drawer.ts:614`, `src/ui/inspector/densityTab.ts:644-648`, `src/ui/inspector/jsonEditor.ts:259-263`, `src/ui/presets/presetsTab.ts:232-234`, `test/arch/masterSpec.test.ts` (row), master §1's `ui/common/*` entry (`:191-193`), `test/unit/fixtures/domShim.ts` (`title` as an accessor over the attribute map, `:45`: the setter stores it, `removeAttribute('title')` deletes it, `getAttribute('title')` returns null when absent, the getter `''`; today `title` is a plain field that neither `removeAttribute` nor `getAttribute` sees, `:163-174`, so "absent, not empty" could not be tested)
- Test: `test/unit/modeTip.test.ts`, `test/unit/paramPanel.test.ts`, `test/unit/toolbar.test.ts`, `test/unit/biomeTableDom.test.ts`, `test/unit/splineDrawer.test.ts`, `test/unit/densityTab.test.ts`, `test/unit/presetsTab.test.ts`

**Interfaces** (spec §7.3):
- Consumes: each editor's `setEditable` (reached through `MapTool.setEditable`, `src/ui/map/mapTool.ts:504-511`).
- Produces:
  - `export const MODE_OFF_TIP = "Enable 'Modify terrain' to edit here";` `export function setModeTip(el: HTMLElement, editable: boolean, own?: string): void` **(plan)** (not editable: `el.title = own === undefined ? MODE_OFF_TIP : `${own}\n${MODE_OFF_TIP}``; editable: `own === undefined ? el.removeAttribute('title') : el.title = own`);
  - `lockInput`: a rule's reason → the row's `fixed: <reason>` (as today); else not editable → the row's title `MODE_OFF_TIP`; else no attribute (not `''`, which hides every ancestor's title); while not editable the label's title is `${tip}\n${MODE_OFF_TIP}`, and the badge's, the dot's and the reset button's titles gain the same line; the frame's label (`controls.ts:278`) too, since a number control's visible label is the frame's (`numberControl` passes `labelled = false`, `:319-321`, so `lockInput`'s row label is never attached, `:236`): `frame().setEditable(on)` sets `label.title = on ? controlTip(c) : `${controlTip(c)}\n${MODE_OFF_TIP}``;
  - each other editor's `setEditable` calls `setModeTip` on its disabled controls' enabled wrapper (the toolbar's seed, Same seed, New seed, preset, biome size and the Undo/Redo group; the amplitude, bool and reset controls; the biome table; the spline drawer; the density tab and its JSON editor; the Presets import); a disabled control with its own title (`toolbar.ts:121`'s buttons: Same seed, New seed, Undo, Redo; `:138`'s `Profile`; `controls.ts:414`'s `octave ${i}`) gets `setModeTip(control, editable, own)`: `${own}\n${MODE_OFF_TIP}` while not editable and its own title back after, since the nearest titled ancestor rule would otherwise show its own title alone. `?map` and unsaved worlds never call `setEditable(false)`.

- [ ] **Step 1: Write the tests.**
  - `modeTip.test.ts`: the two branches (the attribute absent, not empty, when editable: `getAttribute('title')` null), and with `own` (`${own}\n${MODE_OFF_TIP}`, then `own` back);
  - per editor (`toolbar.test.ts`, `biomeTableDom.test.ts`, `splineDrawer.test.ts`, `densityTab.test.ts`, `presetsTab.test.ts`): "the nearest titled ancestor of each disabled control (itself included) contains `MODE_OFF_TIP` while not editable and not while editable; a control's own title (Same seed's, Profile's) is kept in both";
  - `paramPanel.test.ts`: "a row fixed by a rule keeps `fixed: …` both ways"; "for a number control (`density.detailAmpHi`), the title the browser would show (the nearest titled ancestor's) for its attached `label[for=<input id>]` (the frame's label), the input and the slider contains `MODE_OFF_TIP` while not editable and not while editable"; "an octave field's title reads `octave 0\n…` while not editable and `octave 0` after"; "the badge's, the dot's and the reset button's titles gain the line while not editable";
  - SP5c describe: §1's `ui/common/*` entry contains `modeTip.ts (SP5c)`.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/unit/modeTip.test.ts test/unit/paramPanel.test.ts test/unit/toolbar.test.ts test/unit/biomeTableDom.test.ts test/unit/splineDrawer.test.ts test/unit/densityTab.test.ts test/unit/presetsTab.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `SP5C_MODULES` row `[/^\s+ui\/common\/\* /, 'modeTip.ts (SP5c)', 'src/ui/common/modeTip.ts']`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): "Enable 'Modify terrain' to edit here" on the map's disabled controls (SP5c D19)` (`git add src/ui/common/modeTip.ts test/unit/modeTip.test.ts src/ui/paramPanel/controls.ts src/ui/map/toolbar.ts src/ui/biomeTable/table.ts src/ui/splineEditor/drawer.ts src/ui/inspector/densityTab.ts src/ui/inspector/jsonEditor.ts src/ui/presets/presetsTab.ts test/unit/paramPanel.test.ts test/unit/toolbar.test.ts test/unit/biomeTableDom.test.ts test/unit/splineDrawer.test.ts test/unit/densityTab.test.ts test/unit/presetsTab.test.ts test/unit/fixtures/domShim.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 27: `clipboard.metric.ts`: `L3.paste`, `E3.paste`, `E5.paste` (first CI run)

**Files:**
- Create: `test/metrics/clipboard.metric.ts`
- Modify: `test/harness/persistWorld.ts` (`PersistWorld` `:76-123` gains `select: SelectActions` and `tool: SelectTool` beside it (the paste and the move placed with `select.placeAt(x0, y0, z0, true)` and confirmed with `select.confirm()`, the harness having no aim or frame step, `:216-226`) over a second `MemoryKV` for the clipboard, `leave(): Promise<FlushedMsg | null>` (the autosave's `beforeLeave`, then `dispose`) and `copy` through its sim client; **(plan)** `openPersistWorld`'s options (`:157`, today `{ kv, worldId, rd, delayMs }`) gain `clipKv?: MemoryKV` (the clipboard's store, passed again to each reopen and to the second world, so the clipboard outlives `dispose`); `PersistWorld` gains `teleport(dcx: number, dcz: number): void` (moves its stream camera, today a fixed `const cam`, `:195`, read only by the frame, `:220`), `pinned(cx: number, cz: number): boolean` and `published(cx: number, cz: number): boolean` (the coordinator's sim pin and the store's column state, for `E5.paste` and Review Focus 1), and `change`'s option `noWait: true` (returns once the Apply has started; today `change()` awaits until the Apply settles, `:404-430`), for Review Focus 1's Ctrl+Z while regenerating), `test/thresholds.ts` (rows; the comments `:96-114`), `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs` (`clipboard: [\`${DIR}/clipboard.metric.ts\`]` before `rest`, with its comment), `test/unit/shards.test.ts:35-45`, the SP5c spec's Threshold log, `test/arch/masterSpec.test.ts`, master §6.4 (L3's and E1-E6's rows), §1's test entry (`:206`)

**Interfaces:**
- Consumes: `openPersistWorld` (`test/harness/persistWorld.ts:157`), `genRegion`, `lightRegion`, `referenceLight`, `testRng` (`test/harness/stats.ts:2-10`), every module of Tasks 2-24; E5.session's script (`test/metrics/edit.metric.ts:46-58`, `:528-533`).
- Produces: rows, each `{ max: 0, activeFrom: 'SP5c' }`, exact, every tier: `L3` gains `pasteValueMismatches`, `pasteLightMismatches`, `pasteLimboOver` (`outName: 'L3.paste'`); `E3` gains `pasteUndoMismatches`, `pasteRedoMismatches`, `clipboardReloadMismatches`, `pasteLeaveMismatches` (`outName: 'E3.paste'`); `E5` gains `pasteStale` (`outName: 'E5.paste'`).
- The measures, exactly as spec §10.1, seeded with `testRng`, every failure printing its seed and case:
  - **`L3.paste`:** its own seed-42 region upTo 'L', 10 × 10 columns on every tier, `shared: true`, `applyEdits` called outside any read section (Spec correction 4); K random pastes (5 fast, 20 quick and full) of clipboards 1-32 a side drawn from every placeable state (oriented ones in every orientation, torches, glass, water sources and levels, a waterlogged ladder), a random turn, at a random anchor across column borders, built by `pasteBatch`; one maximum paste per tier; one move whose source holds generated ground (`moveBatch`, `readVolume` with `gen`). After each: every cell the turned clipboard's, and after the move every source cell outside the target `genRegion`'s value → `pasteValueMismatches`; every touched column's 3 × 3 against a fresh `lightRegion`, and after every 5th paste and the maximum `referenceLight` over the box → `pasteLightMismatches`; `pasteLimboOver` counts pastes whose `limboMax` > 4,096. Half undone by `blockHistory`'s inverse batch and checked the same way against the values before;
  - **`E3.paste`** (RD 4; the clipboard on a second `MemoryKV`): the house (planks, glass, logs on three axes, wall torches and ladders in four facings, a waterlogged ladder, a water source) copied, pasted across a column border turned once, undone and redone three times (every cell of the box and a one-cell shell, the DiffStore entries of the touched columns, light against a fresh `lightRegion`); flush, dispose, reopen, undo and redo again; a move 3 blocks down, undone (both boxes as before); the clipboard after the reopen equal (sizes, keys, cells) and its paste equal to the pre-reload paste; a second world with a permuted `stateTable` pastes it equal by state key; a 'T' Apply between copy and paste changes no pasted value; a house a 'T' Apply left partly buried, moved up with one step: the source cells outside the target equal the new terrain, one undo restores both boxes; a cut whose clipboard write is `crashNext()`ed cuts nothing (`crashNext()` makes that write never settle, `src/persist/memory.ts:9`, so `cut()` is not awaited, and never through `settle`, which would throw after 50,000 frames, `persistWorld.ts:240-244`: the case runs frames until the clipboard write has been issued, plus 50 frames, then checks that no `edits` was posted, every cell of the box is unchanged and the history size is unchanged); **the leave:** a maximum paste with its reply delayed past 1,000 ms (`delayMs`), `leave()`, reopen: the paste and its step there → `pasteLeaveMismatches`; plus Review Focus 1's regenerating undo and Review Focus 5's backup case. Recorded: the DiffStore's entries and the load's decode time after the pastes; with a 65,536-edit history, the open's normalise-and-restore time and the first flush's main-thread clone, timed as `structuredClone` of the flush message the page's autosave builds (its state and its whole history, as `simClient` sends the first flush after a load), because the in-process sim clones nothing (`test/harness/inProcessSim.ts:6-7`, `:43-46`);
  - **`E5.paste`:** a maximum paste across a column border, a teleport of 640 columns (`teleport`) until its columns are freed (`published` false), back: every pasted cell at its latest value; plus Review Focus 1's delayed-reply teleport (`pinned` read for every pasted column's 3 × 3 until the reply).
- Recorded, not gated (`.out/L3.paste.json` and the others): each paste's `editMs`, `relightMs`, `subBatchMaxMs`, `limboMax`, each pool's byte length before and after.

- [ ] **Step 1: Write the metric and the rows in one go** (a part activates at once in a started SP).
  - `shards.test.ts`: the quick table's keys `['terrain', 'surface', 'render', 'edit', 'persist', 'clipboard', 'rest']`, `clipboard: ['test/metrics/clipboard.metric.ts']`;
  - SP5c describe: §6.4's L3 row contains `(SP5c: and pastes up to the maximum, \`L3.paste\`)`, E1-E6's `(SP5c: E3 and E5 with pastes, their undo and redo, and the clipboard across a reload)`, both cross-checked against `THRESHOLDS` as `:1404-1447` does;
  - SP5c describe: §1's test entry contains `(SP5c: metrics/clipboard.metric.ts)`; `SP5C_MODULES` gains its row.
- [ ] **Step 2: Prototype timing** (spec §11): `time npx vitest run --project metrics-fast test/metrics/clipboard.metric.ts` and `--project metrics-quick`. Expected: PASS, every part 0; quick ≤ 55 s, fast ≤ 25 s; above, recorded and reported (no part dropped, no gate loosened). The recorded open or first-flush cost with a 65,536-edit history above 16 ms → **conditional:** Task 33's lever 3 runs before the exit (spec §5), recorded.
- [ ] **Step 3: Govern.** `npm run test:accept-thresholds`; Threshold log: `- <date> — SP5c Task 27: L3 pasteValueMismatches, pasteLightMismatches and pasteLimboOver (L3.paste), E3 pasteUndoMismatches, pasteRedoMismatches, clipboardReloadMismatches and pasteLeaveMismatches (E3.paste), E5 pasteStale (E5.paste), each max 0, gated from SP5c on every tier (clipboard.metric.ts; spec §10.1); new parts.`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then `node .github/scripts/metricShards.mjs check` and `node .github/scripts/fastShards.mjs check`. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): L3, E3 and E5's paste parts in a shard of their own` (`git add test/metrics/clipboard.metric.ts test/harness/persistWorld.ts test/thresholds.ts test/thresholds.lock.json .github/scripts/metricShards.mjs test/unit/shards.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).
- [ ] **Step 6: The controller pushes the branch** (`git push -u origin sp5c/selection-tool`), waits for the run (`gh run watch`), and records every job's time against spec §11 under `## Exit evidence` as "### The first SP5c CI run (Task 27)". `unit (rest)` above the long pole: the named lever (`.github/scripts/unitShards.mjs`'s `heavy` gains the slowest new unit files by that run's summary; `shards.test.ts` follows; `npm run typecheck && npm test`, `node .github/scripts/unitShards.mjs check`), committed as `ci: the slowest SP5c unit files in unit (heavy)` (`git add .github/scripts/unitShards.mjs test/unit/shards.test.ts`), pushed, that run's times recorded too. Commit `docs(sp5c): the first CI run` (`git add docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 28: Integration: a maximum paste and a `copy` through the Node worker

**Files:**
- Modify: `test/integration/edit.test.ts` (two cases before the final stop-the-sim case, so its limbo and free-slot checks `:600` still hold)

**Interfaces** (spec §10.6):
- Consumes: the file's spawned sim (`:270`), its comparison against `genRegion` plus the entries (`:393`); Task 6's guards and transfers as `sim.worker.ts` wires them.
- Produces: "a `MAX_STEP_EDITS`-changed paste (32,768, or 16,384 after Task 5's rule; a longer batch would be BAD_MESSAGE and latch the sim) through the sim in the Node worker equals `genRegion` plus the entries"; "a `copy` of a 40 × 20 × 40 box through the worker's guard and transfer equals the store's values cell for cell; a `copy` outside the window answers `outside` and a later edit is accepted". About 3-6 s more.

- [ ] **Step 1: Write the cases.**
- [ ] **Step 2: Run** `npx vitest run --project integration test/integration/edit.test.ts`. Expected: PASS; a failure is a bug, fixed in its module with a unit test.
- [ ] **Step 3: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 4: Commit** `test(integration): a maximum paste and a copy through the sim's Node worker` (`git add test/integration/edit.test.ts`).

---

### Task 29: Browser smoke I: the hook and the `select` step

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` `:517-522`, `SMOKE_KEYS` `:829`, the `select` step), `src/ui/world/worldPage.ts` (`WiTest` `:1112-1191`, `WiTestPage` `:1193-1196`, `installWiTest` `:1305-1346`, the page's `attach`)
- Test: `test/unit/uiSmoke.test.ts` (`:1224-1227`)

**Interfaces:**
- Consumes: CDP's key events with modifiers (`p.key(key, code, keyCode, modifiers)`, `uiSmoke.ts:1508-1512`) and mouse wheel (`Input.dispatchMouseEvent`); the `build` step's pattern (`:3048-3124`).
- Produces:
  - `WiTest` gains `selection(): { mode: ToolMode; corner1: [number, number, number] | null; corner2: [number, number, number] | null }`, `clipboard(): Promise<{ w: number; h: number; d: number; hash: string } | null>` (read from storage through the page's store; `hash` **(plan)** `hex64` of a 64-bit FNV over the values), `ghost(): { shown: boolean; anchor: [number, number, number] | null; turns: number; refusal: string | null }` (from `selectActions.ghostState()` and `tool.turns`; `refusal` the `refusalText`), `select(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void`, `placeGhost(x: number, y: number, z: number): void` (`selectActions.placeAt(x, y, z, true)`: pins the ghost's min corner, the aim ignored, until the paste is confirmed or cancelled; a turn or raise keeps the pinned corner, since the headless camera's aim still casts, `worldPage.ts:1146-1150`, and the frame would otherwise re-anchor at the next turn), `confirmPaste(): Promise<string>` (the page's own `selectActions.confirm()`; `'ok'` or the refusal's text), all on `WiTestPage`;
  - `SMOKE_KEYS` gains `selectTool: 'KeyQ'`, `copy: 'KeyC'`, `paste: 'KeyV'`, `move: 'KeyN'` (mirrored; the unit test compares them with `DEFAULT_KEYMAP`);
  - the `select` step, after `settings-world` and before `console`, in the saved world of the `save` step (spec §10.8): a small house through the hook (planks, an x-axis log, a wall torch facing east on its support, a ladder facing south, a waterlogged ladder); Q; the corners through `select`; Ctrl+C by CDP (modifiers 2); Ctrl+V, `placeGhost`, one wheel step down by CDP (one turn), `confirmPaste()`: every cell checked, the turned states by name (`wall_torch[facing=south]`, `ladder[facing=west]`, `oak_log[axis=z]`); Ctrl+Z and Ctrl+Y exact; a floating copy 6 blocks above the ground moved with N onto the ground: the source empty, the target the house, one Ctrl+Z restoring both; `Page.reload`; Ctrl+V and a paste equal to the first. About 60-90 s more, local only.

- [ ] **Step 1: Write the tests** (`uiSmoke.test.ts`):
  - the list gains `select` after `settings-world`, `console` last;
  - `SMOKE_KEYS` equals the map's codes for its nine actions (its five and the four SP5c adds);
  - the turned names equal `REGISTRY.stateKey(rotateState(…, 1))` of the placed states.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts` (its own port and Chrome profile). Expected: every step passes; the `select` step's time recorded in the task's report.
- [ ] **Step 5: Commit** `test(ui): the smoke's select step and the selection hooks` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts src/ui/world/worldPage.ts`).

---

### Task 30: Browser smoke II: `menus`, `modify`; the review screenshots

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`menus` after the Enter rename `:3373-3378`; `modify` `:3907-3956`; the shots)
- Test: `test/unit/uiSmoke.test.ts`
- Commit: `docs/superpowers/specs/assets/sp5c/review-selection.png`, `review-ghost.png`, `review-rotated-paste.png`, `review-rename-save.png`, `review-modify-notice.png`

**Interfaces:**
- Consumes: Tasks 25-26's elements; `SMOKE_BACKUP_NOTICE` (`:867`); `MODIFY_EDIT` (`:864`).
- Produces:
  - `menus`: a second rename typed and saved by clicking `.world-rename-save`, then listed;
  - `modify`: after checking the switch, the notice row holds `MODIFY_ON_NOTICE` (mirrored as `SMOKE_MODIFY_ON_NOTICE`, compared by a unit test); the later `SMOKE_BACKUP_NOTICE` wait still passes; with the mode off, the nearest titled ancestor of `#pp-density.detailAmpHi` and of its attached label (`label[for]`, the frame's label, Task 26) contains `Enable 'Modify terrain' to edit here`; on, neither does;
  - `--shots <dir>` writes spec §10.10's five PNGs (1400 × 900, as SP5b's): the box with its label; a ghost before a paste with replaced cells and the counts; a turned house with logs, ladders, torches and a glass pane, both as a ghost and as pasted; the Rename field with Save; the Modify notice.

- [ ] **Step 1: Write the tests** (`uiSmoke.test.ts`):
  - `SMOKE_MODIFY_ON_NOTICE` equals `MODIFY_ON_NOTICE`, and the reminder text equals `MODE_OFF_TIP`;
  - the five shot names, in `SP5C_SHOTS` **(plan)** (SP5b's `SP5B_SHOTS` pattern).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts --shots docs/superpowers/specs/assets/sp5c/` (its own port and profile). Expected: every step passes; the five PNGs written. The controller checks what each shows and where (spec §10.10: the turned ghost's face shading and glass frame against the pasted result); styling is not reviewed (Non-goals); a missing element is fixed test-first before the commit.
- [ ] **Step 5: Commit** `test(ui): the smoke's Save and Modify notes; SP5c's review screenshots` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts` and the five PNGs by explicit path).

---

### Task 31: Bench leg L12 and the JSON's `paste` block; `measureChrome` → `assets/sp5c`

**Files:**
- Modify: `src/ui/world/bench.ts` (`BENCH_FRAME_CAPACITY` `:92` and its comment `:85-91`, `BenchLeg.name` `:95`, `ALL_LEGS`, L12, `BENCH_PASTE`, the JSON's `paste` block), `src/ui/world/worldPage.ts` (the bench's hooks into the tool's path; **(plan)** `diffWaitMaxMs` as the time from each sim `diff` post to its reply, maxed over L12b and L12c, and the `edits` figures below, both through the sim-client wrapper the bench holds), `src/render/renderer.ts` (`toolDrawCalls()`), `test/tools/measureChrome.ts` (`ASSETS` `:71` → `'docs/superpowers/specs/assets/sp5c'`, its doc `:68-70`), the SP5c spec (Spec correction 10: §10.4's L12b sentence)
- Test: `test/unit/bench.test.ts`, `test/unit/measureChrome.test.ts` (the `ASSETS` pins `:96-98` and `:148-151`, titles included, → `'docs/superpowers/specs/assets/sp5c'`), `test/unit/renderer.test.ts`. `test/unit/benchFiles.test.ts` stays on `assets/sp5b` here (it reads committed files, `:5-6`, `:30-35`, and `assets/sp5c` holds none until Task 32, which moves it in the same commit as those files if it is to read them).

**Interfaces** (spec §10.4):
- Consumes: `createSelectActions` (Tasks 18-23) through the bench's own page path, the paste placed with `placeAt(x0, y0, z0, true)` (Task 18's pin, so the frame's aim does not re-anchor it) and confirmed with `confirm()`; `pasteMaxBlock()` and `pasteLitBlock()` from `src/ui/world/pasteBlocks.ts` (Task 5, Spec correction 11; `MAX_STEP_EDITS` changes each); L10's hover point; `wi10-bench` (L11).
- Produces:
  - **(plan)** `export const BENCH_PASTE = { fillMaxS: 60, hoverS: 10, houseMaxS: 80, maxMaxS: 50, sweepS: 10 } as const;` each part ends at its cap with a `timedOut` naming it in the JSON's `paste` block (as L10's and L11's, `bench.ts:640`, `:709`); L12 is a `BenchLeg` (as `BENCH_SAVE_LEG`) whose `seconds` is `hoverS + houseMaxS + maxMaxS + sweepS` = 150; the fill is not counted in the capacity, as L11's hover is not (the disc at L10's point stays filled after L11);
  - `BENCH_FRAME_CAPACITY = 123_168` (L12's 150 s at 240 Hz added to 87,168: it holds 513 s, the script's 511); `BenchLeg.name` gains `'L12'`;
  - **(plan)** `WorldRenderer.toolDrawCalls(): number` — the visible objects of the two volume boxes (two each), the ghost and the overlay in the last rendered frame (at most 6, spec §6.4: the outline is not the tool's); the bench maxes it as `toolDrawCallsMax`;
  - L12 after L11, at L10's hover point, in `wi10-bench` with autosave on, the RD 12 disc filled (cap 60 s):
    - **L12a** 10 s hover, the tool off;
    - **L12b** the 32 × 12 × 32 house shell (about 3,300 changed) pasted through the tool's own path with its ghost shown, the anchor set (pinned) by the bench on the surface across a column corner; 5 cycles of paste (turns = the cycle's index mod 4), undo, redo, undo; a 6th paste (turn 1), undo, redo, so the house stands; a move of the house 3 blocks down, undone; a cut of the house, undone; the 6th paste undone; each operation waiting until every dirty column is shown and at least 2 s apart (28 operations; the world back at its start) (Spec correction 10);
    - **L12c** `pasteMaxBlock()`'s solid block and `pasteLitBlock()`'s lit block, each written to the clipboard by the bench before its cycles, 3 cycles of paste and undo each (12 operations);
    - **L12d** the bench writes the house back to the clipboard first; the house's ghost, then a 64³ clipboard copied from the terrain under the hover point, each moved along a fixed path (the anchor pinned one block further every frame, the turn every 2 s) for 5 s, then cancelled; nothing pasted;
    - the world ends as it began; the clipboard is written to `wi10-bench`;
  - **(plan)** the bench's sim-client wrapper also wraps `edits`: per operation it records `replyMs` (its post to its reply) and the `edited` reply's `editMs`, `relightMs`, `subBatchMaxMs` and `limboMax` (Spec correction 3), matched by id to the operation that posted it (undo and redo included), since `EditOutcome` carries only `prev` and `next` and Task 7 opens no latency sample for a bulk batch;
  - the JSON's `paste` block: per operation `pasteVisibleMs`, `pasteFirstVisibleMs`, `replyMs`, `editMs`, `relightMs`, `subBatchMaxMs`, `limboMax`, `changed`, `dirtyColumns`, `mainPostMs`; per part (`L12a`-`L12d`) frame `p50`, `p95`, `p99`, `max`, `over33`; `ghostBuildMs`, `ghostSliceMaxMs` and its frames, `overlayMainMaxMs`, `targetReads`, `drawCallsMax` (the whole frame's, `worldPage.ts:3602`'s `info.calls`), `toolDrawCallsMax`; `clipboardReadMs`, `clipboardWriteMs`; the pools' byte lengths before and after L12; over L12b and L12c `flushMainMaxMs`, `flushSyncMaxMs`, `diffWaitMaxMs`; `timedOut`.

- [ ] **Step 1: Write the tests.**
  - `bench.test.ts`: the leg list ends `'L11', 'L12'`; `BENCH_FRAME_CAPACITY` 123,168; the capacity tests (`:50-65`) rewritten: `87_168 + 150 * 240` is 123,168; `BENCH_PASTE`'s four caps after the fill sum to 150 and equal L12's `seconds`; the script's sum is 511 s (`[150, 91, 120, 150]`); `Math.floor(BENCH_FRAME_CAPACITY / 240)` is 513;
  - "L12b runs 28 operations and L12c 12 on a fake clock, each at least 2 s after the last and after every dirty column is shown"; "the house stands when L12b's move and cut run, and the world equals its start after L12b"; "L12c and L12d write their clipboards before their cycles (L12d's first ghost is the house's)";
  - "each L12 part ends at its `BENCH_PASTE` cap with its name in `timedOut`";
  - "the `paste` block's fields and shapes"; "on a fake sim, each operation's `replyMs`, `editMs`, `relightMs`, `subBatchMaxMs` and `limboMax` come from its own `edited` reply"; "L12d's `targetReads` counts the target `copy`s posted while sweeping";
  - "the world's cells are equal before and after L12 on the fake page";
  - `renderer.test.ts`: "`toolDrawCalls()` is 0 with the tool hidden and 6 with both boxes, the ghost and the overlay shown";
  - `measureChrome.test.ts`: `ASSETS` is `'docs/superpowers/specs/assets/sp5c'` (`:96-98`, `:148-151`).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/bench.test.ts test/unit/measureChrome.test.ts test/unit/renderer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; §10.4's L12b sentence reworded to the sequence above (Spec correction 10).
- [ ] **Step 4: Run** `npm run typecheck && npm test`; then **(plan)** one headless dry run of `?bench=medium` in the smoke's own Chrome (its own port and `mktemp -d` profile): L12 completes and the JSON's `paste` block is present (the values are not judged off the panel; the file is not kept).
- [ ] **Step 5: Commit** `feat(bench): leg L12, pastes, moves, cuts and a swept ghost; measureChrome writes assets/sp5c` (`git add src/ui/world/bench.ts src/ui/world/worldPage.ts src/render/renderer.ts test/tools/measureChrome.ts test/unit/bench.test.ts test/unit/measureChrome.test.ts test/unit/renderer.test.ts docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 32: GPU cells (Chrome, agent): L12 on the Iris Xe, `G2.paste`, every route into `assets/sp5c`

**STOP for the user before Step 1:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp5c/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `enter-iris-chrome.json`, `bench-rtx-chrome.json`, `enter-rtx-chrome.json`
- Modify: `test/thresholds.ts` (G2 rows; the comment `:140-144`), `test/thresholds.lock.json` (generated), `test/metrics/g1.metric.ts` (`ASSETS_SP5B` `:95` → `ASSETS_SP5C` for every read: G1, `G1.streaming`, `G1.live`, `G2.edit`, `G2.flush`, `G1.enter`; `checkBench`'s known legs L0-L12; a third G2 call), `test/unit/benchFiles.test.ts` (**(plan)** `ASSETS_SP5B` `:5-6` → the `assets/sp5c/` files committed here, in this commit, so it reads the files G1 now reads), the SP5c spec's Threshold log and `## Exit evidence`, `test/arch/masterSpec.test.ts`, master §6.4's G2 row, §4.12's Target line, §7's Latency (`:1690`)

**Interfaces:**
- Consumes: Task 31's `paste` block; `measureChrome.ts`'s routes and shape checks.
- Produces: rows, each `activeFrom: 'SP5c'`: `G2` gains `pasteOver33: { max: 0 }`, `sweepOver33: { max: 0 }`, `pasteP95AddedMs: { max: 4.17 }`, `housePasteVisibleP95: { max: 500 }`, `maxPasteVisibleMax: { max: 2000 }`, `ghostSliceMaxMs: { max: 4 }`; `metricTest('G2', [the six], …, { outName: 'G2.paste' })` reads `bench-iris-chrome.json`'s `paste` block (the streaming call's shape checks: route, /Iris/, `batch`, rd 12, cold cache; L12b's 28 and L12c's 12 operations present): `pasteOver33` = L12b's + L12c's `over33`; `sweepOver33` = L12d's; `pasteP95AddedMs` = the largest of L12b's, L12c's and L12d's p95 minus L12a's; `housePasteVisibleP95` = the p95 of L12b's 28 `pasteVisibleMs`; `maxPasteVisibleMax` = the max of L12c's; `ghostSliceMaxMs` as recorded. The RTX file recorded in `.out/G2.paste.others.json`.

- [ ] **Step 1: Measure** (an agent; quiet machine; cold shader cache; touching no other process): `npm run measure:chrome -- --route bench --gpu iris --probe-only` (it prints the Iris renderer; a refusal means PRIME is not on-demand: back to the STOP); then `… --route bench --gpu iris` twice (both recorded; the second committed **(plan)**), `… --gpu iris --workers 4`, `… --route flight --gpu iris`, `… --route enter --gpu iris`, `… --route bench --gpu rtx`, `… --route enter --gpu rtx` (if the RTX probe refuses, **STOP**: the user switches to 'nvidia', the controller resumes with `claude --resume` and runs those two, then the user switches back to on-demand).
- [ ] **Step 2: Check.** Gated: the six `G2.paste` parts on both Iris bench runs; every earlier G1 part, `G2.edit`, `G2.flush` and `enterRatio` on the new files. Recorded: the rest of the `paste` block (`clipboardReadMs`, `clipboardWriteMs`, `diffWaitMaxMs` against the longest `editMs` plus one sub-batch, `flushSyncMaxMs`, `toolDrawCallsMax` ≤ 6 (spec §6.4: at most 6 beyond the outline's 1; `drawCallsMax` counts the whole frame, `worldPage.ts:3602`) and `drawCallsMax` ≤ 100 (G1's cell, `mediumStreamDrawCalls`), both recorded, the pools' growth). A miss: **Task 33's levers in order** (each measured as this Step 1's Iris bench route before the next), then this task again from Step 1; no gate is loosened.
- [ ] **Step 3: The rows, the metric and the files in one commit.**
  - SP5c describe: §10's Exit names `G2.paste` (Task 1's pin) and the six rows equal spec §10.4's values and §16's criterion, each `{ max, activeFrom: 'SP5c' }`;
  - §6.4's G2 row contains `/ a paste: no frame > 33 ms, the p95 frame ≤ one interval above the hover, a large build visible ≤ 0.5 s p95, the maximum ≤ 2 s (SP5c, from L12)`, cross-checked against `THRESHOLDS`;
  - §4.12's Target line ends `; a large build's paste → visible ≤ 0.5 s p95, the maximum paste ≤ 2 s, with no frame over 33 ms (SP5c, gated from the bench's L12)`; §7's Latency contains `a large build's paste → visible ≤ 0.5 s p95; the maximum paste ≤ 2 s (SP5c)`;
  - `npm run test:accept-thresholds`; Threshold log: `- <date> — SP5c Task 32: G2 pasteOver33 max 0, sweepOver33 max 0, pasteP95AddedMs max 4.17, housePasteVisibleP95 max 500, maxPasteVisibleMax max 2000 and ghostSliceMaxMs max 4 (G2.paste), gated from SP5c on every tier from assets/sp5c/ (g1.metric.ts; spec §10.4, D28); G1's, G2.edit's, G2.flush's and G1.enter's cells re-read from assets/sp5c (D30); new parts (measured <values> on eDP-1 at 240 Hz).`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with G1, G1.streaming, G1.live, G1.enter, G2.edit, G2.flush and G2.paste asserted on the SP5c files.
- [ ] **Step 5: Commit** `feat(sp5c): the Chrome cells in assets/sp5c and G2.paste` (the six JSON files staged by explicit path, with `test/thresholds.ts test/thresholds.lock.json test/metrics/g1.metric.ts test/unit/benchFiles.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md`).

---

### Task 33: The levers (conditional)

Run only for a gate Task 32 measured as missed, for a Node bench gate Task 5 measured as missed after D31's rule (levers 33b, 33d, 33e only, measured with `npm run bench`, no PRIME stop; 33d's `L3.paste` part then lands with Task 27's rows), or for lever 3 when Task 27 recorded the open or the first flush with a 65,536-edit history above 16 ms (each skip recorded in Task 32's evidence); each lever is one commit, measured (as Task 32 Step 1, the Iris bench route only) before the next; stop at the first that meets the gate. **STOP before each measurement** under Task 32's conditions: the controller confirms them with the user again when the session was resumed or the display may have slept.

- [ ] **33a: a packed `edits` form.** `EditsMsg` gains a packed variant `{ type: 'edits'; id; packed: { xyz: Int32Array; value: Uint32Array; expect: Uint32Array; revert: Uint8Array } }` **(plan)**, transferred, used by the page for a bulk batch; the guard checks the arrays' lengths and every element as `editOk` does; `simClient.edits` keeps its signature. Files: `src/workers/protocol.ts`, `src/workers/simHandler.ts`, `src/engine/simClient.ts`, `src/ui/world/editPath.ts`, their tests ("a packed batch equals its object form's result"; "a packed batch over `MAX_STEP_EDITS` is BAD_MESSAGE"). Commit `perf(workers): a packed, transferred form for bulk batches (SP5c D28 lever 1)`.
- [ ] **33b: sub-batches of 512.** `SUB_BATCH` 1,024 → 512; Task 3's counting cases follow (512 → 1, 513 → 2); `HEADROOM_*` kept. Commit `perf(sim): sub-batches of 512 (SP5c D28 lever 2)`.
- [ ] **33c: per-step history records** (`wi10` version 2): a `historySteps` store keyed `[worldId, stepId]` **(plan)**, the flush writing only new steps and deletes, the open reading the range; `persist/idb.ts` `VERSION` 2 with an upgrade keeping every SP5b store; `kv.ts`'s `StoreName`; the contract suite's case and `KV_CONTRACT_CASES`; `saves.ts`' records, normaliser, Delete, `copyOps`; `.wiworld`'s history unchanged on disk (assembled at export); E1-E7 still 0; `KV_CONTRACT_CASES` 10 (`test/tools/uiSmoke.ts:211`) and `uiSmoke.test.ts`'s pin and `kvSelftestPassed` cases at 10, so Tasks 34, 36 and 37 (and the Global Constraints' Firefox line) then require "IndexedDB contract: 10/10 passed"; the SP5c spec's D14, §5, §4.2 ("No version bump: `VERSION` stays 1"), §9 ("`wi10` v1's five stores"), §10.7 and §16 ("9/9") and master §2.7 reworded in this commit. Commit `perf(persist): the history written step by step (SP5c D28 lever 3)`.
- [ ] **33d: a batched relight per section** with its own coverage (an `L3.paste` part added before the code, through `npm run test:accept-thresholds` with a Threshold-log line). Commit `perf(sim): one relight per touched section for a bulk batch (SP5c D28 lever 4)`.
- [ ] **33e: the cap lowered to 16,384** (D12's alternative; as Task 5's conditional step: its amendments, the bench rows `paste.max` and `paste.maxLit` as 16,384-change rows re-measured, L12c's blocks (Task 31) and Task 28's integration paste included). Commit `fix(sim): at most 16,384 changed blocks per operation (SP5c D28 lever 5)`.
- [ ] **STOP:** a gate still missed after its levers: the controller reports every measurement to the user (D28); no gate is loosened; the user's own check decides.
- [ ] Each lever: `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`; the measurement recorded under Task 32's evidence.

---

### Task 34: The user's Firefox run

This task is the controller's and the user's.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp5c/selftest-firefox.json` (the user's reading, as SP5b's), `bench-iris-firefox.json` (only if the user sends it)

- [ ] **Step 1: STOP for the user.** The controller runs `npm run build`, then its own `npx vite preview --port 4173 --strictPort` (stopped only by the controller), and gives the user `http://localhost:4173/?selftest=1` (required: 59/59 and "IndexedDB contract: 9/9 passed") and, optionally, `http://localhost:4173/?bench=medium` (L12 included; recorded, not gated).
- [ ] **Step 2: Record** the selftest and any bench file in the exit evidence.
- [ ] **Step 3: Commit** `docs(sp5c): the Firefox selftest` (the files by explicit path, and the spec).

---

### Task 35: Whole-branch review

- [ ] **Step 1:** The controller runs the final review of `git diff main...sp5c/selection-tool` against the spec, this plan and Review Focus 1-5 (superpowers:requesting-code-review), the reviewer resolving its own cannot-verify items in the code at HEAD. Beyond the per-task reviews it checks what only the whole branch shows:
  - every `(plan)` decision is in the code as written, or its change is recorded in the spec; every Spec correction is reworded in the spec;
  - nothing posts an `edits` or a `copy` the sim would refuse as BAD_MESSAGE: every batch and box the page builds goes through `boxChecks` or a checked selection first; no path reaches the guard's length cap;
  - every bulk post (paste, cut, move and the undo or redo of their steps) goes through `createEditPath.post`, so `bulkPending`, the working notice and the autosave's wait cover undo and redo too;
  - the clipboard is written only by `clipboardStore.ts`, and a cut posts only after its `complete`; no `indexedDB` outside `persist/idb.ts`;
  - SP5a's and SP5b's rules still hold: zero allocation at rest (the box and the ghost), the layers, no golden diff, every existing key's meaning, the 100-step history bound, `?map` unchanged;
  - every disposer the tool, the ghost, the overlay, the target reader and the clipboard store add is reached from the page's teardown;
  - the CI time against §11 (Task 27's run) and the masterSpec block's pins against spec §12's and §13's lists;
  - spec §14's hand-overs still true of the code as built (the clipboard by state keys for SP6 and PER-3; the ghost material for SP11; the nine actions and `ctrl` bindings for SP10).
- [ ] **Step 2:** Each finding is fixed test-first in its module, one commit each (`fix(sp5c): …`); a finding that would loosen a gate or change the spec goes to the user.
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:metrics`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`, and the smoke again. Expected: PASS; no golden diff.

---

### Task 36: Exit: evidence and docs

**Files:**
- Modify: the SP5c spec (`## Exit evidence`, Status), `CLAUDE.md` (`:9`; the selection tool's keys; the smoke's `select` step; `measure:chrome`'s `assets/sp5c`), `README.md` (`:9`, an SP5c paragraph), master §10 (the SP5c entry's "Received from SP5b" worded as delivered; the Cut line and the receivers worded by whether the overlay was taken), `test/arch/masterSpec.test.ts` (`:1463` moved into the SP5c describe and rewritten; Task 1's receivers pin, which today requires `SP5c replaced-block overlay → SP10 (worded by the SP5c spec)`, and its Cut-line pin rewritten to the exit's wording)

- [ ] **Step 1: Exit checks** (spec §16): `npm run build && npm test && npm run test:metrics:full` (`L3.paste`, `E3.paste`, `E5.paste` at 0 on every tier; L3, E1-E7, `E5.session`, `E5.flush` still 0); `git diff main -- test/goldens.json` empty; `GENERATOR_VERSION` 5; `npx --yes bun@1 test/tools/goldensJsc.ts` 59/59; `?selftest=1` 59/59 and "IndexedDB contract: 9/9" in Chrome (the smoke) and Firefox (Task 34); `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` green; `npm run bench` within its gates and +30 % (`paste.max` p99 ≤ 800, `paste.maxLit` p99 ≤ 1,600, `relight.edit` unchanged).
- [ ] **Step 2: Master at the exit.** The SP5c entry's "Received from SP5b" line worded as delivered (SP5b's precedent), pinned in the SP5c describe with `toBe` (moved from `:1463`; its SP5b-spec half kept); the overlay shipped (Task 24) → the Cut line ends "It was not taken: the overlay shipped in SP5c, so nothing moved." and the receivers read `SP5c replaced-block overlay → SP10 (delivered in SP5c, so nothing moved)`; if it was cut, both and SP10's "Received from SP5c" say so. In the SP5c describe, Task 1's receivers pin is rewritten to contain `SP5c replaced-block overlay → SP10 (delivered in SP5c, so nothing moved)` (or the cut wording) and no longer `(worded by the SP5c spec)`, and the Cut line's pin gains its ending (`It was not taken: …`), so `npm test` stays green.
- [ ] **Step 3: Exit evidence**, before the Threshold log: D31's prototype (Task 5) with both orders and the cap it kept; the first CI run job by job against §11; `L3.paste`, `E3.paste`, `E5.paste` per tier with `limboMax` and the pools' growth; the open and first-flush costs with a 65,536-edit history; `paste.max` and `paste.maxLit`; the bench files with `G2.paste` and the re-read G1 and G2 cells; the RTX files; any lever (Task 33); the smoke with its `select` step; the review screenshots described; the Chrome and Firefox selftests; the masterSpec pins of 'master spec amendments (SP5c §13)'; the cut line as taken.
- [ ] **Step 4:** Status "implemented, awaiting CI, the production check and the user's check"; `CLAUDE.md:9` and `README.md:9` the same.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `docs(sp5c): exit evidence and docs` (`git add docs/superpowers/specs/2026-11-01-sp5c-selection-tool-design.md docs/superpowers/specs/2026-09-26-architecture-design.md test/arch/masterSpec.test.ts CLAUDE.md README.md`).

---

### Task 37: Merge, production check, the user's check, SP5c complete

**STOP for the user's go-ahead** before Step 1.

- [ ] **Step 1:** Merge `sp5c/selection-tool` to `main` and push; CI green, its wall recorded against §11's ≈ 2.9-3.2 min (above 3 min 30 s: the `unitShards.mjs` lever first).
- [ ] **Step 2: Production, headful** (spec §16), on the deployed build:
  - **Chrome** (RegionBatch; the agent's own headful Chrome on the Iris Xe, its own `mktemp -d` profile, `MESA_SHADER_CACHE_DISABLE=true` in its env only; **STOP** until the user confirms PRIME on-demand and the display awake and unlocked): select, copy, paste turned, cut and move, undo and redo, reload and paste, Rename's Save, the Modify notice, the reminder on a disabled parameter; `?selftest=1` 59/59 and "IndexedDB contract: 9/9"; page and console errors 0;
  - **Firefox** (RegionMesh; **STOP for the user**, in the user's own Firefox, by hand, as SP5b's `production-check.json` records `firefox.by`): the same steps and production's `?selftest=1`;
  - the controller commits `assets/sp5c/production-check.json` (`docs(sp5c): the production check`).
- [ ] **Step 3: STOP for the user's check** (§10.9): select a build; copy and paste it elsewhere, rotated; cut and move a house a terrain change left floating (or buried); undo and redo a paste; reload and paste again from the kept clipboard; the three notes; whether pasting or moving stutters or freezes, and whether the size limits are enough (the last criterion; D28: the user's check decides).
- [ ] **Step 4:** After the user's verdict (a finding goes back test-first, with another go-ahead before it reaches `main`), a final commit marks SP5c complete (`CLAUDE.md:9`, `README.md:9`, the spec's Status, the cut-line pin): `docs: SP5c complete`.

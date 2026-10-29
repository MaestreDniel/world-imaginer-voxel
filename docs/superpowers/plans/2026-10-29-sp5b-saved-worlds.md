# SP5b — Saved worlds: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The world is kept. `/` opens a start screen (New world · Load world · Settings); New world takes a name, a preset and a seed (random, typed or a dice); Load world lists the worlds newest first with Play, Rename, Export and Delete, and imports a `.wiworld`. Play opens a world exactly as it was left: its blocks, the pose, walking or flying and the flying speed, the time of day, the hotbar and its slot, the block undo and redo history and the saved places. The world saves itself every 2 s and when the tab is hidden or closed; one world opens in one tab at a time. Settings (the start screen, or G) has a Graphics and a Controls tab. B saves a place; the map shows places as dots and lists them in a Places tab. Terrain changes from a saved world's map need the world-modification mode, off whenever a world opens; the first terrain change in a world with builds, per mode session, keeps the world before it as a backup copy. A world saved with an older generator opens with today's terrain and a notice. The generated world does not change (`GENERATOR_VERSION` 5, the 59 goldens byte-identical).

**Architecture:**
- **Storage.** `persist/kv.ts` (the narrow KV interface: `read` of several requests in one readonly transaction, `write` of one batch in one readwrite transaction, no cursor), `persist/memory.ts` (`MemoryKV` with fault injection), `persist/kvContract.ts` (one contract suite both adapters pass), `persist/idb.ts` (`IdbKV`, `wi10` v1's five stores, the only `indexedDB` user, on both threads, D17).
- **Formats.** `persist/diffCodec.ts` (`ColumnDiffV1` exactly as master §2.7, D21), `persist/saves.ts` (the records, D33's params load, D22's remap, §2.1's normaliser, the menu's operations, the flush and copy batches), `persist/wiworld.ts` (`.wiworld`, D23, E2's hash).
- **Sim.** The DiffStore's dirty-column set and bulk column load; `edited` carries `entryAdded`/`entryRemoved` (D20); the handler's `handle(m, post)` with deferred replies for `load`, `flush` and `backup`, everything after `load` held until it settles (D18); the flush as one transaction from the sim worker, one in flight, an abort merged back (§3.2); the backup copy encoded from the DiffStore (§3.6).
- **The page.** `?world=<id>` opens the session from the record and awaits `loaded` before the first update (§3.4, D19); the player, the clock, the hotbar, the history and the places restored; `ui/world/autosave.ts` (the 2 s tick, the hide and close triggers, the state snapshot); every page navigation saves first; `ui/world/worldLock.ts` (Web Locks, D24).
- **Measured early** (D28, revise-notes builder question 5): the `persist.flush` bench row, bench leg L11 and `?bench=enter` right after the flush, the open and the persisted history (Task 14) exist, then an early `G2.flush` and `G1.enter` on the Iris Xe, before the menus; the named levers as a conditional task.
- **Screens.** `ui/worldsMenu.ts` (start, New world, Load world; replaces `ui/world/startScreen.ts`), `ui/settingsPanel.ts` (Graphics and Controls), `ui/world/modifyMode.ts` (the switch, the session gate D25, the backup latch and hold D26), `ui/world/places.ts`, `placeDialog.ts`, `ui/map/placesTab.ts`, `ui/common/files.ts`'s binary helpers.
- **Measurement.** `test/metrics/persist.metric.ts` (E1-E4, `E5.flush`, E6, E7), the integration round trip, the smoke's eight new steps, `G2.flush` and `G1.enter` from the committed Iris Xe Chrome files (`assets/sp5b/`).

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`, `navigator.locks`, `CompressionStream`), three r186 (`~0.186.1`), Chrome 155 over CDP for the browser tools, Bun 1 for the JavaScriptCore golden check. No new dependencies (D27: no `fake-indexeddb`).

**Spec:** `docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md` (approved 2026-10-29, "Aprobada"; the binding authority, with the user's two answers under Points for the user: Point 1, the backup once per mode session, "Cada vez que activas el modo"; Point 2, `?at`, `?rd` and `?workers` without `?world` open an unsaved SP5a world with a notice, "Un mundo sin guardar"). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Recon behind the spec: `.superpowers/sp5b/recon-{obligations,persistence,ui,tests}.md`, `review-technical.md`, `builder-check.md`, `revise-notes.md` (git-ignored; the controller has them). Template: the SP5a plan.

**Plan form.** Compact, as SP4a's to SP5a's (the user's choice of 2026-10-20). Each task gives the files, the interfaces (exact signatures), the tests with the spec's exact values, the pinned values, and the decisions the spec leaves open, marked **(plan)**. The implementer writes the bodies (sketched only for the codec's layout and the flush's merge rules, whose order the tests do not fully pin); the task reviewer checks each one against the spec sections the task cites. Every cited file, line, name and signature below was checked against `main` 78d745e (code identical to d3f45a6, the spec's citation base: `git diff --stat d3f45a6 78d745e` touches only the spec).

**Spec corrections found while planning** (numbered as the tasks cite them; each folded in by the task named, the first one when it names two; the controller rewords the spec in that task's commit, whose `git add` includes `docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`):
1. **`persist/` cannot import the normaliser's sources** (§2.1 "the hotbar goes through `normalizeHotbar`", "a step … that `editOk` would refuse", `speedIndex` "an index of `TIME_SPEEDS`", `speed` "1-96"): `LAYER_RULES.persist` value-imports `L2_CORE` only (`test/arch/rules/imports.ts:11`, `:24`), so `saves.ts` cannot import `player/hotbar.ts` (`normalizeHotbar`, `:84-92`), `player/fly.ts` (`SPEED_MIN`/`SPEED_MAX`, `:31-33`), `daynight/dayNight.ts` (`TIME_SPEEDS`, `:15`), `ui/world/query.ts` (`Y_MIN`, `Y_MAX`, `:29-30`) or `workers/protocol.ts` (`editOk`, `:663-665`). The normaliser takes those bounds injected (`StateBounds`, which the UI builds from them, pinned equal by a test), and checks a history edit with core's `WINDOW_HALF` and `yInWorld` (`src/core/coords.ts:23`, `:34`) and `REGISTRY.stateCount`, the same bounds `editOk` reads. A saved pose's x, z bound is `WINDOW_HALF` too, not `ui/world/query.ts:27`'s `AT_LIMIT` (500,000, which bounds only `?at`): flight has no horizontal limit (`src/player/fly.ts:8-10`), so a player beyond ±500,000 is still "exactly as left" (D4). Task 4.
2. **§8's moved pins miss five, and two count pins** (§8 lists only `masterSpec.test.ts:1159-1160`): §9's rewordings also break `masterSpec.test.ts:1162` (the receivers: §11's wording puts "(the Load list's place count)" between "polish" and "→ SP10"), `:1202` (§1's "(SP5b's graphics settings screen replaces it)"), `:1276` (§4.12's whole Block undo line), `:957` (§5.6's saved-places phrase, which §9's "(SP5b: coloured dots; …)" extends) and `:1208` (the SP5a describe's `toContain('if SP3a-SP5b shows an unfixable isolation or concurrency problem')` on risk 1's Kill line, which §9 rewords at the exit; the SP4b-era pin of that line's "(amended by SP4b: …)" parenthesis, `:1013-1015`, stays, its text kept verbatim in the new line); each moves into the SP5b describe in the task that lands its amendment. Adding B and G breaks `test/unit/keymap.test.ts:32` and `test/unit/tips.test.ts:14` (27 actions → 29) and needs a `{settings}` tip placeholder as well as `{savePlace}` (`tips.test.ts:9-12`: every action named). Task 1, Task 14, Task 26, Task 27, Task 28, Task 36.
3. **E1's "fluid 0 and 255" contradicts §2.2's rejects** (§6.1 E1; §2.2 "a fluid byte with its reserved bit 7 set"): 255 sets bit 7 (`src/world/blocks/fluid.ts:1-5`), so decode must refuse it and no round trip can hold it. E1's round trips draw fluid 0 and 127 (every non-reserved bit), and a 255 fluid byte is one of `rejectFailures`' cases. Task 3, Task 30.
4. **A third caller posts `handle`'s result at once** (§3.3 names `sim.worker.ts` and `test/harness/inProcessSim.ts`): `test/harness/nodeWorker.ts:83-84`'s generated wrapper does too, and the integration test runs the sim through it (`test/integration/edit.test.ts:270`). It passes `post` as well; for §6.3's `load` → `flush` → `load` round trip the wrapper gains a harness-only renew message that rebuilds the handler over the same in-worker `MemoryKV`. Task 8, Task 31.
5. **`?time` fixes the clock only with `?shot=1`** (D4 "a `?time=` query still fixes the clock", §3.4 step 5): `main.ts:41-42` passes `timeHours` only under `shot` (ruling P48). D4 and §3.4 read "a `?shot=1&time=` capture, as today". Task 11.
6. **`G2` already has a part named `editVisibleP95`** (§6.2's `G2.flush` "`editVisibleP95` (the 'on' parts) max 50"): SP5a's edit part, `test/thresholds.ts:122`. The flush gate's part is `flushEditVisibleP95` (the bench JSON's field keeps its name inside the `persist` block); the other five keep the spec's names. Task 34.
7. **`?bench=enter`'s saved world cannot open through `/?world=<id>` alone** (§6.2: the world in `wi10-bench`, (b) "the saved world (`?world=<id>`)"): the world page reads `wi10`. The enter route's loads carry `enterBench=1`, and its (b) loads `&db=wi10-bench`, a key the page honours only together with `enterBench=1`; so does the menu at `/?enterBench=1&db=wi10-bench`, whose Create carries both keys into `/?world=<id>&enterBench=1&db=wi10-bench`, so the new-world leg is measured in that database (Task 20). Task 16.
8. **The browser files' directory** (§6.2 "G1's and `G2.edit`'s reads move to `assets/sp5b/`", citing `g1.metric.ts:52-58`, `:327`): `measureChrome.ts` writes `assets/sp5a/` (its doc and out directory, `test/tools/measureChrome.ts:5`, `:63-65`), and `g1.metric.ts` reads `ASSETS_SP5A` at `:61-62` (the G2 call at `:323`). Both move to `assets/sp5b/`; the flight, w4 and RTX files are re-measured with the bench file, as SP5a's Task 41 did. Task 16, Task 34.
9. **E1's "over all 24 sections" cannot run in its budget** (§6.1 E1, §7's "E1 1-3 s"): a column with every one of its 24 sections drawn from {0, 1, 2559, 2560, 4096} holds about 44k entries; a minimal per-column pass (generate, the DiffStore's nested-`Map` rebuild, a compare) measured about 6 ms per column, so 10,000 columns with the encode, decode, re-encode, shuffled-order encode and rebuild are 60-200 s. E1 reads: each random column holds 1-3 sections at random `sy` (every `sy` 0-23 drawn over the run), each section's count from {1, 2559, 2560, 4096} (an absent section is the 0); the DiffStore-rebuild check runs on every 10th column. Task 3's 2,000-column unit test uses the same shape. Task 3, Task 30.
10. **A new world has no `history` record, and opens with no notice** (§3.4 step 2 "a missing or unreadable `state` or `history` → its defaults … with D14's notice"): `create` writes only `worlds` and `state` (§1.2), so every new world's first Play would show "This world's undo history could not be read", against D4's clean first Play. §3.4 step 2 reads: an absent `history` is a new world's and opens with none and no notice; a present one that cannot be read gets D14's notice. Task 10.
11. **The page's kept record changes at the open too** (§3.6 "the page keeps the loaded record and updates it only in `onApplied`"): an open whose `stateTable` differs from today's writes `rewrite.world` (today's table, D22), and an older-generator open sends `record` with today's genKey (D8); a later `record` or backup built from the record as loaded would write the old table back over today's ids (against D22's "a world never holds ids of two tables") or give the copy the stale genKey (the "older generator" badge on the copy, and E6's `backupMissing`). §3.6 reads: the page keeps the record it opened, replaced by `rewrite.world` at such an open, by the older-generator open's `record` and in `onApplied`. Task 10, Task 23, Task 25.
12. **`load` carries the world's genKey and its last `updated`** (§3.3 `load {id, db, worldId, flushSeq, stateTable, rewrite}`): the sim's flush writes each column header with the world's genKey (D21) and the backup's copy takes the original's last committed `updated` (§3.6), but the sim reads only the `diffs` range and `rewrite` is null for an ordinary world, so before the first `record` or committed flush it knows neither. §3.3's `load` gains `genKey` (16 hex digits) and `updated` (the stored state's). Task 8, Task 9, Task 25.
13. **A walking place teleport cannot go through `walk.arrive`** (§3.7 "walking, `walk.arrive` at y − `EYE`"): the page's `walk.arrive` is `arriveFeet` (`worldPage.ts:2557`), which sets `snapPending` (`src/player/walk.ts:125-128`), and the next walk tick over a Published column moves the feet to the column's motionBlocking top, so a place in a cave, under a roof or inside a building would land the player on top (against D12's exact position and D13's "you stand there"). §3.7 reads "`setFeet` at y − `EYE` (no snap), then SP5a D29's lift". Task 27.

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`; ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` and `.github/scripts/` run under plain Node and cannot import `src/`: they mirror the values they need as literals, which unit tests pin. A `.mjs` module a TS test imports gets a sibling `.d.mts`.
  - **No new dependencies** (D27; `CLAUDE.md:42`).
- **Layers** (`test/arch/rules/imports.ts`; no rule changes, every new module sits in an existing layer):
  - `persist/` (`kv.ts`, `memory.ts`, `kvContract.ts`, `diffCodec.ts`, `saves.ts`, `wiworld.ts`, `idb.ts`) is a pure layer (`banned.ts:9`: no `document`, `window`, `localStorage`) that value-imports `L2_CORE` only (core, world, gen, textures, audio, light, mesh, sim, persist): never `workers/`, `engine/`, `player/`, `daynight/` or `ui/` (Spec correction 1). **`indexedDB` only in `persist/idb.ts`** (`banned.ts:210-211`), which runs in the sim worker and, for the worlds menu, on the main thread (D17; master §1's dependency rule, amended in Task 6).
  - `workers/simHandler.ts` and `sim.worker.ts` value-import `persist/` (`imports.ts:27`); the new messages live in `workers/protocol.ts`, which type-imports `persist/`'s record types.
  - `engine/simClient.ts` and `engine/session.ts` import `persist/` as types only (`imports.ts:28`); `engine` never imports `ui`.
  - `sim/` (`diffStore.ts`, `edits.ts`) stays pure, its clock injected.
  - `ui/` (`worldsMenu.ts`, `settingsPanel.ts`, `ui/world/autosave.ts`, `worldLock.ts`, `modifyMode.ts`, `places.ts`, `placeDialog.ts`, `ui/map/placesTab.ts`, `ui/common/files.ts`) value-imports any layer but `render/materials/**` and `*.worker.ts`; text through `textContent` only (`test/arch/uiText.test.ts`); no browser dialogs (`test/arch/uiDialogs.test.ts`); every `new WorldSession(` passes `validateParams` (`test/arch/uiSessions.test.ts`).
  - `player/` storage stays injected (`createHotbar(storage)`, `hotbar.ts:105`); the Web Lock, the clock and the KV are injected wherever a test drives them.
- **Pure and deterministic layers.** `core/` follows the Math allowlist; `core/`, `world/`, `gen/` and `DET_FILES` use no `Math.random`, `Date.now`, `performance.now`, `console.*`; pure layers no DOM globals. Ids (`crypto.randomUUID()`) and wall-clock dates (`Date.now()`) are taken in `ui/` and passed in.
- **The generated world does not change.** `GENERATOR_VERSION` stays 5; `test/goldens.json` (59 goldens), `test/schema-shape.lock.json` and `test/stateIds.lock.json` stay byte-identical (no state is added). Every task that touches `sim/`, `workers/` or `world/store/` (Tasks 7-9, 15, 18, 25, 31) runs `npm run test:goldens`, then `git diff --exit-code main -- test/goldens.json`; if the run rewrote anything, restore with `git checkout main -- test/goldens.json` and find the bug.
- **Governance.**
  - `test/thresholds.lock.json` changes only in Task 1 (`startedSps`), Task 30 (E1-E7, `E5.flush`) and Task 34 (`G2.flush`, `G1.enter`), always through `npm run test:accept-thresholds`; each such commit adds one line to the SP5b spec's `## Threshold log` in the same push (`test/harness/governance.ts:54-56`); `<date>` in the log lines below stands for that commit's date. Every new part is new (a tightening); no gate is loosened.
  - Master amendments land in the commit spec §8 and §9 assign: the §10 ones in the first commit, the rest with what they describe; each is pinned in a new `describe('master spec amendments (SP5b §9)')` in `test/arch/masterSpec.test.ts`, created by Task 1, with the moved earlier pins (`:1159-1160`, `:1162`, and Spec correction 2's). **(plan)** A table `SP5B_MODULES: Array<[head: RegExp, token: string, file: string]>` in that describe, "§1 names each SP5b module in its entry, which exists" (the `SP5A_MODULES` pattern, `masterSpec.test.ts:1125-1146`, checked as `:1320-1327`); the tasks that create a module append its row. At the exit, master §10 holds no bare `SP5` outside the places SP5a's test allows (`masterSpec.test.ts:1351-1363`).
- **Master amendments by task** (spec §9; each pinned in the SP5b describe by the task that lands it): Task 1: §10's SP5b entry (header "(L; SP5a). Spec: …", contents, Exit, Cut line), the Default receivers, SP10's "Received from SP5b", SP8c, SP11 and SP5c; Task 2: §1's `persist/*` line (with `kvContract.ts`); Task 3: §2.7's header genKey "(informative …)"; Task 4: §2.7's records and "over `resolveProfile(profile)`", §2.2's `stateTable` line; Task 6: §1's dependency rule; Task 8: §4.13's World open (the Prefetch line removed); Task 9: §4.13's Flush; Task 10: §1's `ui/world/*` entry's SP5b modules (`stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)`; Tasks 12, 19, 24 and 26 add only their `SP5B_MODULES` rows against it); Task 11: §4.17; Task 14: §4.12's Block undo and Hotbar lines; Task 20: §1's ui/world line (the start and worlds menus) and the `ui/shell.ts` entry's `worldsMenu.ts settingsPanel.ts (SP5b)` (Task 28's row rides on it), §2.7's Session, §5.2's World; Task 22: §2.7's `.wiworld` header, §1's `ui/common/*` entry's `files.ts (SP5b: downloadBlob, readBinaryFile)`; Task 23: §2.7's "A save is valid only …", §6.2's Dev saves, risk 13, §9's save binding; Task 24: §2.7's Fork dialog paragraph, §1's `session.ts` token; Task 26: §5.9; Task 27: §5.6, §1's `ui/map/*` entry's `placesTab.ts (SP5b)`; Task 28: §1's settings-block line, §4.16, §5.2's Settings; Task 30: §6.3, §6.4's E1-E6 and E7 rows, §1's test entry; Task 36: risk 1's Kill line; Task 38: the cut-line wording.
- **Zero allocation** (SP4b D25): the frame step at rest allocates nothing, SP5b's additions included: autosave has no per-frame hook (its state is built at the tick, never per frame, §3.2), the place dots are drawn only on a scheduled map redraw, the modification mode's `beforeApply` runs only when a configure is kept. Pinned in Task 13 (`test/unit/zeroAlloc.test.ts`).
- **TDD.** Write the test, watch it fail for the stated reason, implement, watch it pass. `npm run typecheck && npm test` is green before every commit.
- **CI time budget** (spec §7, against SP5a's exit run 40821727832, 2 min 42 s, and `main`'s 40948457416, ≈ 2 min 55 s): `unit (rest)` ≈ 115-120 s, `check` ≈ 120-125 s, metrics-quick `edit` ≈ 115-125 s with `persist.metric.ts`, metrics-fast `rest` ≈ 90 s; wall ≈ 2.8-3.1 min, metrics-quick `terrain`/`surface` (≈ 145 s) still the long pole; at most 3 min 30 s at the exit. The named lever, taken before the exit if `edit` passes 145 s: `persist.metric.ts` in a metrics-quick shard of its own, `persist` (`.github/scripts/metricShards.mjs`, `test/unit/shards.test.ts:40`).
- **GPU measurements** (spec §6.2, as SP5a):
  - **Chrome cells** are an agent's, through `npm run measure:chrome -- --route bench|flight|enter --gpu iris|rtx`, on a cold driver shader cache (`MESA_SHADER_CACHE_DISABLE=true` for the Iris Xe, `__GL_SHADER_DISK_CACHE=0` for the RTX, in the tool's own Chrome's env only; never `~/.cache/mesa_shader_cache` or any user cache), on the laptop panel eDP-1 at 240 Hz with the user's display awake and unlocked, on a quiet machine (the tool refuses above a 1-minute load of 2). The Iris Xe needs PRIME **on-demand**; the RTX Chrome cell runs as SP5a's, and if its probe refuses, under **'nvidia'**. Only the user switches PRIME; a switch logs the user out and ends the session, which the controller resumes with `claude --resume`.
  - **Firefox runs** are the user's, on a local `vite preview` the controller serves on **port 4173**: the selftest (59/59 and the IndexedDB contract) and the enter file (`?bench=enter&auto=1`, spec §6.2's "Firefox recorded") are asked for; export/import into another browser profile and the user's check are the user's; a Firefox bench file is optional.
- **Where the plan stops for the user** (each marked **STOP** in its task): Task 17 (the early measurement: PRIME on-demand, display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running); Task 18, when it runs, before each lever's measurement and if a gate still misses after the levers (the measurements go to the user, D28); Task 34 (Task 17's conditions; the RTX cell under 'nvidia' if its probe refuses, then back to on-demand); Task 35 (the user's Firefox selftest on 4173, export/import into another profile); Task 38 (the go-ahead to merge; PRIME on-demand and the display awake for the agent's headful Chrome production check; the user's Firefox production steps; the user's check, the last criterion). The controller never switches PRIME and never runs the user's check for the user.
- **Processes.** Never kill, signal or touch a process you did not start; never `pkill`, `killall` or a pattern kill. Every tool and preview the controller serves runs on its own free port (**never 5183**, the user's compose service; **never 4190** for Firefox: the Firefox preview is 4173) and every Chrome on its own fresh `mktemp -d /tmp/wi10-XXXX` profile; stop only those. Never open, close or touch the user's own browsers; no `xdotool` or any desktop input.
- **Outward-facing actions.** Pushing the branch is the controller's call (Task 30 pushes it for the first CI run). Merging to `main`, pushing `main` and the production check happen in Task 38, after the user's go-ahead. Read-only git otherwise; never rewrite history. `.superpowers/` is never committed.
- **Commits.** Trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Pida15wksGqd9gSbCgkKT1`. Staging with explicit paths only (`git add <path> …`; never `-A`, `.` or `-u`).
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff in the code at HEAD and in this plan's later tasks, and resolves its own cannot-verify items; a requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are the likeliest ways a user with saved worlds would see SP5b lose work or refuse a world, most likely first; each names the test that pins it and the task that owns it.

1. **Closing or reloading the tab mid-flush or mid-edit burst.** Hold-repeat placing every 0.2 s, then F5 or Ctrl+W while a flush's transaction is open and an edit's reply is still out. A person expects everything up to the last completed save back, nothing half applied, and Ctrl+Z still reaching the older steps. Task 9 pins "edits A posted, `flush` posted, edits B posted before A's reply; the flush's write `crashNext()`ed: a fresh handler's `load` on the same KV gives exactly the previous committed flush's columns, and `kv.read([{ op: 'get', store: 'state', key: worldId }])` gives its `flushSeq`; with the write completing instead, A's column is in it and B's column is dirty again and in the next flush with `flushSeq` + 1"; Task 14 pins "one step on voxel A recorded and flushed first; then three steps on voxel B (distinct values) posted 50 ms apart, each reply 70 ms late; `pagehide` at 110 ms posts at once (no settled wait), its history holding A's step and B's first; after a reopen from the KV, Ctrl+Z ×3: B's first step dropped with `Can't undo there: the blocks changed`, A's step undone, and the third press finds nothing".
2. **Two tabs, or a reload racing the lock.** F5 on a world while its previous document still holds the lock; a duplicated tab; Rename in the menu while another tab opens the world. A person expects the reload to reopen, the second tab to be refused with the notice, and never two writers. Task 19 pins "the page's request with the previous holder releasing at 1,500 ms opens the world; one releasing at 2,500 ms gives `This world is open in another tab` and no `load` is posted; the menu's Rename with the lock held writes nothing and shows the notice; a Rename whose write is in flight when a page requests the lock: the page's callback runs only after the write's `complete`; `pageshow` with `persisted` reloads".
3. **Importing a `.wiworld` from an older build or a different `stateTable`.** A file exported before a later SP appended states, or one whose table is permuted or names a state that no longer exists, made with an older generator. A person expects the world in, every block the same block, unknown ones air with a count, and the badge. Task 22 pins "a file whose header's `stateTable` is today's 58 keys permuted and cut to 55 plus one unknown key `nope[x=1]`, with a stored genKey of another generator: imports with every voxel equal by state key, the unknown key's 3 voxels air and `3 blocks of unknown types became air`, the imported record's `stateTable` equal to today's, its records re-encoded under today's ids, and `olderGenerator(dump.world, p.value)` true (`p = loadParams(dump.world)`); a file whose `version` is 2 is refused (`Made by a newer version of world-imaginer-voxel`) with nothing written", and Task 23 the list's `older generator` badge on such an imported row.
4. **Switching the modification mode and applying while a backup is being written.** The mode on, a terrain change held at `beforeApply` while its copy is written slowly; meanwhile the mode switched off and on and another terrain change made. A person expects one copy per mode session, each holding the world just before its change, and no change lost or applied twice. Task 25 pins "mode on; change 1 ('T') held, its backup's write settling at 500 ms; at 100 ms the mode off (the open gesture ended), at 200 ms on again; change 1 applies only after its `backedUp`; at 800 ms, after that apply, change 2 ('D') posts a second copy `My world (before the change 2)` holding change 1's parameters; exactly two copies, and the world ends with change 2's parameters", and "a change made while a copy is held supersedes the held draft; after `backedUp` the combined draft applies with that one copy" (the apply control keeps only the latest configure, `applyControl.ts:95-98`).
5. **Storage quota or blocked storage mid-session.** The disk fills, or the user clears site data, while building. A person expects to keep playing, a clear notice, and the save to resume by itself when space returns. Task 29 pins "`failAt(0, 'QuotaExceededError')` on three successive flushes: the world keeps editing, `Not saving: the browser's storage is full. Free space, or export your worlds from Load world.` stays, every tick and `pagehide` post again; the fourth flush commits the union of the dirty columns, the latest history and the pending `record` with `flushSeq` + 1 and the notice hides; a `closed` connection shows `Not saving: this browser's storage was closed. Reload to continue.` and the tick stops posting".

## Branch

Task 1 creates `sp5b/saved-worlds` from `main` 78d745e: `git switch main && git switch -c sp5b/saved-worlds`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: start SP5b; the §10 amendments | §8, §9 (§10, receivers), §11 |
| 2 | `persist/kv.ts`, `MemoryKV` and the contract suite | §2.1, D27, §6.3 |
| 3 | `ColumnDiffV1`: `persist/diffCodec.ts` | §2.2, D21 |
| 4 | `saves.ts` I: the params load, the remap, the normaliser | §2.1, §2.3, D22, D33 |
| 5 | `saves.ts` II: world records over the KV | §1.2, §1.3, §2.1, D16 |
| 6 | `IdbKV` and the selftest's IndexedDB section | §2.1, §6.4, D17 |
| 7 | Sim I: the dirty set; the entry set as changes | §3.2, §3.3, D20 |
| 8 | Sim II: deferred replies and `load` | §3.3, §3.4, D18, D19, D22 |
| 9 | Sim III: `flush` and `record` | §3.2, D18 |
| 10 | Opening a saved world | §3.4 steps 2-3, D19, D14 |
| 11 | Restoring the player: pose, mode, flying speed, time | §3.4 step 5, D4 |
| 12 | `ui/world/autosave.ts`: triggers and the state snapshot | §3.2, D5 |
| 13 | Autosave in the page: navigations, Reload URLs, the last flush on failure | §3.2, §3.4 step 7, D4, D14 |
| 14 | The hotbar per world; the block history kept | §3.4 step 6, D6, D32 |
| 15 | `persist.flush` in `npm run bench`; bench leg L11 | §6.2, D28 |
| 16 | `?bench=enter`; `measureChrome` → `assets/sp5b` | §6.2, D28 |
| 17 | The early measurement: `G2.flush` and `G1.enter` | D28 |
| 18 | The levers (conditional) | D28 |
| 19 | One tab per world | §3.5, D7, D24 |
| 20 | Routes, the start screen and New world | §1.1, §1.2, D1, D2, D29, Point 2 |
| 21 | Load world: the list, Play, Rename, Delete | §1.3, D3, D7 |
| 22 | `.wiworld`: `persist/wiworld.ts`, Export and Import | §2.4, D15, D23 |
| 23 | An older generator | §3.4 step 4, D8 |
| 24 | The modification mode: `setWritable` and the switch | §3.6, D10, D25 |
| 25 | The automatic backup | §3.6, D11, D26, Point 1 |
| 26 | Saved places: the model, B and its dialog; B and G in the key map | §3.7, D12 |
| 27 | Places on the map: dots and the Places tab | §3.7, D13 |
| 28 | The Settings screen; the help's Settings (G) and Worlds menu buttons | §1.4, D9, D31 |
| 29 | Storage problems | §3.8, D14 |
| 30 | `persist.metric.ts`: E1-E7 and `E5.flush` (first CI run) | §6.1, §7 |
| 31 | Integration: `load` → `flush` → `load` in a Node worker | §6.3 |
| 32 | Browser smoke I: the hook, `start`, `menus`, `save`, `crash`, `two tabs` | §6.5 |
| 33 | Browser smoke II: `export/import`, `places`, `modify`, `settings-world`, `stream`; the review screenshots | §6.5, §6.7 |
| 34 | GPU cells (Chrome, agent): the bench and enter files, `G2.flush`, `G1.enter` | §6.2, §12 |
| 35 | The user's Firefox run | §6.4, §6.6, §12 |
| 36 | Whole-branch review | §4, §8, §12 |
| 37 | Exit: evidence and docs | §12 |
| 38 | Merge, production check, the user's check, SP5b complete | §12 |

The order de-risks early: governance; storage and formats with their property tests; the sim's load and flush; opening a saved world and restoring the player; autosave; the per-world hotbar and the persisted block history (Task 14, before the measurement, so the measured flush writes the history and the tick builds its snapshot, both inside `flushSyncP95Ms` and `flushMainP95Ms`); the flush and entry measurements, run on the Iris Xe before any menu; then the lock, the menus, `.wiworld`, the older-generator rule, the mode and the backup, places, settings, storage problems; the metrics, the integration test, the smoke, the GPU cells; docs.

---

### Task 1: Governance: start SP5b; the §10 amendments

**Files:**
- Modify: `src/core/ids.ts` (the comment `:20-24` gains "SP5b (saved worlds) started on 2026-10-29 and is the current SP (SP5b spec §8)."; `CURRENT_SP` `:25` → `'SP5b'`), `test/harness/sp.ts:37` (`STARTED_SPS` appends `'SP5b'`)
- Modify (pins): `test/arch/sp.test.ts:18-21`, `test/unit/profiles.test.ts:26`, `test/arch/masterSpec.test.ts` (new `describe('master spec amendments (SP5b §9)')` with `SP5B_MODULES` empty; `:1159`'s header pin and `:1162`'s receivers pin moved into it; `:1160` read there unchanged)
- Modify: master §10 (the SP5b entry, the Default receivers line, SP10's "Received from SP5b", SP8c, SP11, SP5c), `test/thresholds.lock.json` (generated), the SP5b spec (`## Threshold log`; §8's moved-pin list gains `:1162`, `:1202`, `:1276`, `:957`, `:1208`: Spec correction 2), `CLAUDE.md:9`, `README.md:9`

**Interfaces:**
- Produces: `STARTED_SPS` ends `'SP5a', 'SP5b'`; `CURRENT_SP === 'SP5b'`. No profile has `readyFrom: 'SP5b'` (`src/core/params/profiles.ts:21-38`), so readiness does not change. The comments naming SP5b (spec §8's list) are reworded by the task that builds each.

- [ ] **Step 0:** `git switch main && git switch -c sp5b/saved-worlds`.
- [ ] **Step 1: Update the pinned tests first.**
  - `sp.test.ts:18-21`: title "SP5b has started and is the current SP (SP5b spec §8)", the list ends `'SP5a', 'SP5b'`, `CURRENT_SP` and `currentSpOf(STARTED_SPS)` `'SP5b'`; `profiles.test.ts:26`: `'SP5b'`.
  - The SP5b describe, test "§10's SP5b entry and its receivers (SP5b spec §9, §11)": `spEntry('SP5b', 'SP5c')` starts ``**SP5b — Saved worlds** (L; SP5a). Spec: `2026-10-29-sp5b-saved-worlds-design.md` `` (moved from `:1159`) and contains `saved places as a section of each saved world's map` (moved from `:1160`), `the Settings screen (G; Graphics and Controls)`, `**Exit:** as the SP5b spec §12 (E1-E4, E5's flush part, E6 as redefined there, E7; the failure criteria's gates \`G2.flush\` and \`G1.enter\`, with the SP5b spec's thresholds; the user's check)` and a line starting `- **Cut line:** the Load list's place count ("· n places" on Load world's rows) (→ SP10)`; the receivers contain `SP5a palette search → SP10 (delivered in SP5a, so nothing moved); SP5b worlds-menu polish (the Load list's place count) → SP10` (moved from `:1162`, Spec correction 2); SP10's entry has a line starting `- Received from SP5b (its spec §10; amended by SP5b): the preset library (master §2.7's \`presets\` store); touchpad sensitivity in Settings' Controls tab (the SP4a spec :729)`; `spEntry('SP8c', 'SP9')` contains ``Adds the **Audio** tab to SP5b's `ui/settingsPanel.ts` `` and `(the \`packs\` store, by a \`wi10\` version bump)` and not `Creates \`ui/settingsPanel.ts\``; `spEntry('SP11', 'SP12')` contains `fills SP5b's Graphics tab: the quality preset and the greyed rows (fog distance, clouds, shadows)`; `spEntry('SP5c', 'SP6')` contains `(stored in IndexedDB \`wi10\`, its \`meta\` store or a store of its own by a version bump; a paste is one block-history step, which SP5b persists)`.
  - The SP5a describe drops the two moved assertions (`:1159`, `:1162`); its other pins stay.
- [ ] **Step 2: Run** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts`. Expected: FAIL (`CURRENT_SP` `'SP5a'`, the SP5b header `(M; SP5a)`).
- [ ] **Step 3: Implement.** `ids.ts`, `sp.ts`, the master as spec §9 words its §10 items (the Cut line as pinned above, **(plan)** its wording at the exit by Task 38); `npm run test:accept-thresholds`; Threshold log: `- <date> — SP5b Task 1: startedSps gains 'SP5b' (spec §8).`; `CLAUDE.md:9` and `README.md:9`: SP5a complete, SP5b (saved worlds) in progress; the spec's §8 list of moved pins (the Spec correction).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `chore(sp5b): start SP5b; the master's §10 amendments` (`git add src/core/ids.ts test/harness/sp.ts test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts test/thresholds.lock.json docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md CLAUDE.md README.md`).

---

### Task 2: `persist/kv.ts`, `MemoryKV` and the contract suite

**Files:**
- Create: `src/persist/kv.ts`, `src/persist/memory.ts`, `src/persist/kvContract.ts`, `test/unit/kv.test.ts`
- Modify: `test/arch/masterSpec.test.ts` (`SP5B_MODULES` rows for the three files), master §1's `persist/*` line

**Interfaces** (all **(plan)**; spec §2.1 fixes the shape: several reads in one readonly transaction, one batch per readwrite transaction, no cursor, `{status, errorName}`):
- `kv.ts`, the keys:
  - `type StoreName = 'worlds' | 'state' | 'history' | 'diffs' | 'meta'`; `STORES: readonly StoreName[]` in that order (D16; `packs` and `presets` are SP8c's and SP10's, by a version bump);
  - `type Key = string | readonly [string, number]` (`worlds`, `state`, `history` by world id; `diffs` by `[worldId, colKey]`; `meta` by a string);
  - `interface KeyRange { readonly lower: Key; readonly upper: Key }` (lower inclusive, upper exclusive); `worldRange(worldId: string): KeyRange` = `[worldId, 0] … [worldId, 2 ** 32)` (a colKey is below 2^32, `src/core/coords.ts:3`, `:50`);
  - `compareKeys(a: Key, b: Key): number` in IndexedDB's order (a number < a string < an array; arrays element by element, a shorter prefix first).
- `kv.ts`, the requests:
  - `type ReadRequest = { op: 'get'; store: StoreName; key: Key } | { op: 'getAll'; store: StoreName; range: KeyRange | null } | { op: 'count'; store: StoreName; range: KeyRange | null }`; the answers, in request order: `unknown` (`undefined` when absent), `{ keys: Key[]; values: unknown[] }` in key order, `number`;
  - `type WriteOp = { op: 'put'; store: StoreName; key: Key; value: unknown } | { op: 'delete'; store: StoreName; key: Key } | { op: 'deleteRange'; store: StoreName; range: KeyRange }`;
  - `interface WriteResult { readonly status: 'complete' | 'abort' | 'closed'; readonly errorName: string | null }`; `type KvEvent = 'versionchange' | 'blocked' | 'closed'`;
  - `interface KV { read(reqs: readonly ReadRequest[]): Promise<unknown[]>; write(ops: readonly WriteOp[]): Promise<WriteResult>; onEvent(f: (e: KvEvent) => void): () => void; close(): void }`; `read` rejects with a `KvError extends Error` whose `name` is the transaction's error's; `write` never rejects.
- `memory.ts`:
  - `createMemoryKV(o?: { readDelayMs?: number; writeDelayMs?: number }): MemoryKV`; `interface MemoryKV extends KV { failAt(k: number | 'commit', errorName?: string): void; crashNext(): void; closeNow(): void; dump(store: StoreName): Array<[Key, unknown]>; readonly opCount: number }`;
  - values are `structuredClone`d on put and on read; a batch is staged and applied only at its end, so `failAt(k)` (k the 0-based op index of the next batch, or `'commit'`; `errorName` default `'AbortError'`) settles `abort` with nothing applied, once;
  - `crashNext()`: the next `write` never settles and is never applied (the tab died before `oncomplete`); `closeNow()`: later writes settle `closed`, the `closed` event fires once; a `DataCloneError` from `structuredClone` aborts the batch, as IndexedDB's `put` does.
- `kvContract.ts`: `KV_CONTRACT: readonly { name: string; run(kv: KV): Promise<void> }[]` (each throws an `Error` naming its first mismatch; each uses its own world ids and leaves nothing behind, so the cases share one database) and `runKvContract(open: () => Promise<KV>): Promise<{ name: string; ok: boolean; error: string | null }[]>`, framework-free (no vitest import, no `console`) so `?selftest=1` runs it (Task 6).

- [ ] **Step 1: Write the tests** (`kv.test.ts`): each `KV_CONTRACT` case as a vitest test on a fresh `createMemoryKV()`; the cases (spec §6.3): "put, get, delete";
  - "`getAll` of `worldRange('a')` returns a's `diffs` keys only, in colKey order (keys 2^32 − 1, 0, 65536 put in that order come back 0, 65536, 2^32 − 1), not b's";
  - "tuple order: `['a', 4294967295]` < `['b', 0]`; every string key sorts before every tuple key";
  - "atomic abort: a batch whose third op puts a function settles `abort` with `errorName` `'DataCloneError'`, and its first two puts are not visible" (IndexedDB's `put` throws that synchronously without aborting; Task 6's adapter aborts and names it);
  - "a later put of the same key in one batch wins";
  - "structured-clone isolation: mutating the value after `put`, or a value `read` returned, changes nothing stored";
  - "`count` by range";
  - "`deleteRange(worldRange('a'))` removes a's 3 keys and leaves b's 2". MemoryKV's own: "`failAt(1, 'QuotaExceededError')` → `{status: 'abort', errorName: 'QuotaExceededError'}`, nothing applied, the next write applies";
  - "`crashNext()` → the write never settles (a 200 ms race resolves first) and a later `read` sees nothing of it";
  - "`closeNow()` → `closed` and the event once".
  - `compareKeys` against the cases above.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/kv.test.ts`. Expected: FAIL (no modules).
- [ ] **Step 3: Implement.** Master §1: `persist/kv.ts idb.ts memory.ts kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)   L2 (IStorage adapter; MemoryKV for tests; kvContract.ts, the contract suite both adapters pass)`; `SP5B_MODULES` rows `[/^\s+persist\/kv\.ts /, 'kvContract.ts diffCodec.ts wiworld.ts saves.ts (SP5b)', 'src/persist/<file>']` for `kv.ts`, `memory.ts`, `kvContract.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (the arch's dom-global rule passes `persist/`).
- [ ] **Step 5: Commit** `feat(persist): the KV interface, MemoryKV with fault injection, the contract suite` (`git add src/persist/kv.ts src/persist/memory.ts src/persist/kvContract.ts test/unit/kv.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 3: `ColumnDiffV1`: `persist/diffCodec.ts`

**Files:**
- Create: `src/persist/diffCodec.ts`, `test/unit/diffCodec.test.ts`, `test/fixtures/columnDiffV1.json`
- Modify: `test/arch/masterSpec.test.ts` (row; the §2.7 pin), master §2.7 (the header's genKey), the SP5b spec (Spec correction 3: E1's fluid values; Spec correction 9: E1's column shape)

**Interfaces:**
- `FluidTick { readonly packedPos: number; readonly dueOffset: number }`; `DecodedColumn { readonly diff: ColumnDiff; readonly genKey: Hash64; readonly ticks: readonly FluidTick[] }`; `class DiffDecodeError extends Error`; `DENSE_MIN = 2560`; `encodedSize(d: ColumnDiff, tickCount: number): number`; `encodeColumnDiff(d: ColumnDiff, genKey: Hash64, ticks?: readonly FluidTick[]): Uint8Array`; `decodeColumnDiff(b: Uint8Array, stateCount: number): DecodedColumn` (`stateCount` the stored `stateTable`'s length).
- Layout (§2.2, D21; little-endian): `u8 v = 1`, `u32 genKeyLo`, `u32 genKeyHi` (`Hash64` is `[lo, hi]`, `src/core/hash.ts:1-3`), `u8 sections`; per section by `sy`: `u8 sy`, `u8 fmt`, `u16 n`; fmt 0 when n < 2560: n × `{u16 idx, u16 state, u8 fluid}` by idx; fmt 1 when n ≥ 2560: a 512 B mask (bit `idx & 7` of byte `idx >> 3`), then 4096 u16 states and 4096 u8 fluids, every voxel, unmasked ones 0; trailer `u16 count` and count × `{u32 packedPos, u16 dueOffset}` by packedPos. So `encodedSize` = 10 + Σ (4 + (n < 2560 ? 5n : 12800)) + 2 + 6 × ticks. A value is `state << 8 | fluid` (`diffStore.ts:3`). `encode` sorts its input (sections by sy, entries by idx, ticks by packedPos), throws on a duplicate, and returns a fresh `Uint8Array` over an `ArrayBuffer` of exactly its size (never a view of a scratch buffer).
- `decode` throws `DiffDecodeError` (never a partial diff) on: `v` ≠ 1; `fmt` ∉ {0, 1}; more than 24 sections, `sy` ≥ 24 or sections out of order; n = 0; a sparse section with n ≥ 2560; a dense one whose mask's popcount ≠ n; `idx` ≥ 4096; unsorted or duplicate entries or ticks; a state ≥ `stateCount`; a fluid byte with bit 7 set (`src/world/blocks/fluid.ts:1-5`); a short or over-long buffer. Decoded ticks are returned; SP5b's callers drop them (D21).

- [ ] **Step 1: Write the tests** (`diffCodec.test.ts`, seeded with `testRng`, `test/harness/stats.ts:2-10`, each failure printing its seed and case): "decode(encode(d)) equals d over 2,000 random columns, each with 1-3 sections at random `sy` (every `sy` 0-23 drawn over the run) and each section's count from {1, 2559, 2560, 4096} (Spec correction 9), state ids ≥ 256, fluid 0 and 127 (Spec correction 3), 0, 1 and 40 ticks with `packedPos` near 2^32 − 1";
  - "a DiffStore rebuilt from a decoded column reads every voxel as the source" (every 10th column);
  - "encode(decode(b)) === b byte for byte";
  - "input order does not change the bytes";
  - "the size equals `encodedSize`, and `byteLength === buffer.byteLength`";
  - "fmt is 1 exactly when n ≥ 2560: 12,800 B at n = 2560 equals sparse's 5 × 2560"; one test per reject of the list above (a fluid byte of 255 among them), each a `DiffDecodeError` with the case in its message, and no partial result; "the fixture's three cases encode to their committed hex" (`test/fixtures/columnDiffV1.json`: **(plan)** `{ cases: [{ name, sy, idx, value, genKey: [lo, hi], ticks, hex }] }`, cases "two sparse entries", "a dense section beside a sparse one", "one tick", written once by `encode` and checked by hand against the layout).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/diffCodec.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §2.7: the header's genKey gains "(informative: entries apply under any generator, SP5b)", pinned; `SP5B_MODULES` row for `diffCodec.ts`; the spec's §6.1 E1 (Spec corrections 3 and 9).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(persist): the ColumnDiffV1 codec` (`git add src/persist/diffCodec.ts test/unit/diffCodec.test.ts test/fixtures/columnDiffV1.json test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 4: `saves.ts` I: the params load, the remap, the normaliser

**Files:**
- Create: `src/persist/saves.ts` (the pure part), `test/unit/saves.test.ts`, `test/fixtures/sp5bWorldParams.json`
- Modify: `src/core/params/kit.ts:426` (the `checkParams` comment: "(complete documents; saves and `.wiworld` load through `applyPatch` over the profile, SP5b D33)"), `test/arch/masterSpec.test.ts` (row; the §2.7 and §2.2 pins), master §2.7 (the five stores' records; "… over `resolveProfile(profile)` (SP5b)"), §2.2 (`stateTable`), the SP5b spec (Spec correction 1)

**Interfaces** (records exactly as spec §2.1's table):
- The records:
  - `WorldRecord { id: string; name: string; seedText: string; seed: [number, number]; profile: ProfileId; params: JsonObject; schemaVersion: number; paramsHash: string; generatorVersion: number; genKey: string; stateTable: string[]; created: number; backupOf: string | null }` (`genKey`, `paramsHash` 16 hex digits, `hex64`; `params` the full document, master §2.7; `backupOf` the original's id, D11);
  - `PlayerRecord { x: number; y: number; z: number; yaw: number; pitch: number; mode: 'walk' | 'fly'; speed: number }` (`y` the eye, `fly.ts:18-20`); `Place { id: string; name: string; colour: number; x: number; y: number; z: number; yaw: number; pitch: number }` (`colour` 0-7, an index of Task 26's `PLACE_COLOURS`);
  - `HotbarRecord { v: 1; active: number; slots: readonly unknown[] }` (by type name, `hotbar.ts:67-92`: no remap);
  - `StateRecord { worldId: string; flushSeq: number; updated: number; player: PlayerRecord | null; time: { t: number; speedIndex: number }; hotbar: HotbarRecord; places: Place[] }`;
  - `HistoryEdit { x: number; y: number; z: number; before: number; after: number }` (as `BlockStep`'s, `blockHistory.ts:31-34`); `HistoryRecord { worldId: string; done: { edits: HistoryEdit[] }[]; undone: { edits: HistoryEdit[] }[] }`.
- `MAX_PLACES = 256`, `MAX_NAME = 64`, `HISTORY_STEPS = 100`, `DEFAULT_SPEED = 12`, `DEFAULT_T = 1 / 12` (pinned equal to `BLOCK_HISTORY_STEPS`, `blockHistory.ts:25`, `SPEED_DEFAULT`, `fly.ts:31`, and `OPENING_T`, `dayNight.ts:11`, by Task 10's `test/unit/stateBounds.test.ts`: `persist/` cannot import them), `NO_VALUE = 0xFFFFFFFF` (`NO_ENTRY`'s value, `diffStore.ts:12`, which `persist/` may import; **(plan)** re-exported under this name).
- `parseWorldRecord(raw: unknown): { ok: true; world: WorldRecord } | { ok: false; reason: string }` (the `worlds` record's one shape check, which `list`'s broken rows, Task 5, and `readSavedWorld`, Task 10, both cite): string `id`, `name`, `seedText`; `seed` a `[u32, u32]`; `profile` a known `ProfileId`; `params` an object; `schemaVersion` an integer; `paramsHash` and `genKey` 16 hex digits (`/^[0-9a-f]{16}$/`); `generatorVersion` an integer; `stateTable` a string[]; `created` finite; `backupOf` a string or null. `reason` names the first failing field.
- `loadParams(w: Pick<WorldRecord, 'params' | 'schemaVersion' | 'profile'>): Result<Params>` (D33): `migrate(params, schemaVersion)` (`migrate.ts:21`) → `applyPatch(SCHEMA, resolveProfile(profile), migrated)` (`kit.ts:450`); an unknown or unready profile → an issue; the session's own validation is the caller's.
- `todayStateTable(): string[]` (`REGISTRY.stateKey(s)` for `s < stateCount`, `registry.ts:119`); `tableRelation(stored: readonly string[]): 'equal' | 'prefix' | 'other'`; `remapOf(stored: readonly string[]): { to: Int32Array; unknownKeys: number }` (`to[id]` today's id, −1 for a key `parseStateKey` refuses); `remapValue(v: number, to: Int32Array): { value: number; unknown: boolean }` (`NO_VALUE` kept; an unknown state → **(plan)** `0` (air, fluid 0)); `remapDiff(d: ColumnDiff, to): { diff: ColumnDiff; unknown: number }` (an entry that becomes equal to another of the same voxel cannot happen: one entry per voxel).
- `interface StateBounds { normalizeHotbar(raw: unknown): HotbarRecord; timeSpeedCount: number; speedMin: number; speedMax: number; xzLimit: number; yMin: number; yMax: number }` (Spec correction 1; the UI's `STATE_BOUNDS`, Task 10, is `{ normalizeHotbar: (r) => ({ v: 1, ...normalizeHotbar(r) }), timeSpeedCount: TIME_SPEEDS.length, speedMin: SPEED_MIN, speedMax: SPEED_MAX, xzLimit: WINDOW_HALF, yMin: Y_MIN, yMax: Y_MAX }`: `WINDOW_HALF`, `src/core/coords.ts:23`, not `AT_LIMIT`, since flight has no horizontal limit, `fly.ts:8-10`).
- `normalizeState(raw: unknown, worldId: string, b: StateBounds): { state: StateRecord; reset: boolean }` (§2.1), at open and at import, and under the tick's snapshot:
  - a non-finite or out-of-range number takes its default: `player` → null when x or z is outside ±`xzLimit` or y outside `[yMin, yMax]`; yaw and pitch any finite value (the page's `look` wraps and clamps them, `worldPage.ts:1739-1740`); `speed` outside `[speedMin, speedMax]` → `DEFAULT_SPEED` (12); `t` outside [0, 1) → `DEFAULT_T` (1/12); `speedIndex` not an integer below `timeSpeedCount` → 0; `flushSeq` a non-negative integer, else 0;
  - a `mode` other than `'walk'`/`'fly'` → `'fly'`; the hotbar through `b.normalizeHotbar`;
  - places past 256 or with a colour outside 0-7 dropped, names cut to 64 characters, a place with a bad coordinate (the player's bounds: x, z within ±`xzLimit`, y within `[yMin, yMax]`) dropped;
  - −0 → 0 everywhere (`canonicalJSON` throws on it, `canonical.ts:52-53`);
  - `reset` true when the raw value was not a record at all (D14's notice).
- `normalizeHistory(raw: unknown, worldId: string, to: Int32Array | null): { history: HistoryRecord; reset: boolean; dropped: number }`: each value remapped through `to` when given; a step with any edit outside the window (±`WINDOW_HALF`), outside `yInWorld`, with a non-integer coordinate, or with a `before`/`after` that is neither `NO_VALUE` nor a state below `REGISTRY.stateCount` after the remap is dropped and counted, as are steps past 100 per side (the newest kept). `normalizeHistory(undefined, …)` (a new world has no `history` record, Task 5) → an empty history with `reset` false; any other value that is not a record → an empty history with `reset` true (Spec correction 10).
- `newState(worldId: string, b: StateBounds): StateRecord` (`player: null`, `{t: DEFAULT_T, speedIndex: 0}`, the default hotbar from `b.normalizeHotbar(null)`, no places, `flushSeq` 0, `updated` 0).
- `olderGenerator(w: WorldRecord, params: Params): boolean` = `hex64(genKey(w.seed, stageHashes(params))) !== w.genKey` (`src/core/stage/hash.ts:14-34`), on the params as `loadParams` gives them.

- [ ] **Step 1: Write the tests** (`saves.test.ts`): "the committed SP5b-era fixture `sp5bWorldParams.json` (a complete default-profile document, `schemaVersion` 2) loads, and equals `resolveProfile('default')`";
  - "the fixture with `density.defs` removed loads with the profile's `density.defs` (a leaf a later SP adds), where `checkParams` refuses it with `MISSING_KEY`";
  - "an amplified world missing a leaf takes amplified's value, not the default's";
  - "`schemaVersion` 3 → a `MIGRATION_FAILED` issue";
  - `tableRelation`: today's table `'equal'`, its first 55 keys `'prefix'`, a permutation `'other'`; "`remapOf` of a permuted table with one unknown key `nope[x=1]`: every known key maps to its id, the unknown to −1, `unknownKeys` 1";
  - "`remapValue(5 << 8 | 3, to)` keeps the fluid byte; an unknown → 0 with `unknown` true; `NO_VALUE` kept"; the normaliser, one test per field of §2.1 (a `NaN` x → `player: null`; `speed` 0 and 97 → 12; `t` 1 → 1/12; `speedIndex` 4 → 0; `mode: 'swim'` → `'fly'`; `pitch: -0` → 0 and the record passes `canonicalJSON`; 300 places → 256; a colour 8 dropped; a 70-character name cut to 64; a step with `y` 320, one with `x` 2^19, one with a state 4095 dropped and counted; 120 done steps → the newest 100; a string record → defaults with `reset` true; a player at x 510,000 (beyond `AT_LIMIT`, inside `WINDOW_HALF`) kept, one at x 2^19 → `player: null`); "`normalizeHistory(undefined, …)` → empty with `reset` false; `normalizeHistory(7, …)` → empty with `reset` true"; `parseWorldRecord`, one test per field (each field of the record made wrong in turn → `{ok: false}` with that field named; a well-formed record → ok); "`olderGenerator` false for a record written by today's code, true for one whose `genKey` came from `GENERATOR_VERSION` 4's formula (the fixture's genKey recomputed with 4)";
  - "**(D33/§1.3)** the badge and the page agree on the fixture missing `density.defs`: `olderGenerator` uses `loadParams`' params, and their genKey equals the session's (`new WorldSession(…, { seedText, profile, patch }).state.params` hashed the same way)".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/saves.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The fixture is today's `resolveProfile('default')` written by `canonicalJSON`, with `schemaVersion` 2 beside it **(plan)** `{ schemaVersion: 2, profile: 'default', params: … }`. Master §2.7 (the five stores and their records as spec §2.1's table; "Saves and `.wiworld` store full params and load as migrate → applyPatch over `resolveProfile(profile)` (SP5b)") and §2.2 ("(kept equal to the ids on disk: rewritten at an open whose table differs from today's, SP5b)"), each pinned; the spec's Spec correction 1.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(persist): saved params load over the profile, the stateTable remap, the state and history normaliser` (`git add src/persist/saves.ts test/unit/saves.test.ts test/fixtures/sp5bWorldParams.json src/core/params/kit.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 5: `saves.ts` II: world records over the KV

**Files:**
- Modify: `src/persist/saves.ts`, `test/unit/saves.test.ts`

**Interfaces:**
- `createSaves(kv: KV): Saves`; `interface Saves { list(): Promise<WorldRow[]>; create(w: WorldRecord, state: StateRecord): Promise<WriteResult>; readOpen(id: string): Promise<{ world: unknown; state: unknown; history: unknown }>; rename(id: string, name: string): Promise<WriteResult>; remove(id: string): Promise<WriteResult>; readAll(id: string): Promise<WorldDump | null>; writeAll(d: WorldDump): Promise<WriteResult>; readonly kv: KV }`.
- `list`:
  - `WorldRow = { broken: false; world: WorldRecord; updated: number; places: number } | { broken: true; id: string; reason: string }` **(plan)** (a record that `parseWorldRecord`, Task 4, refuses stays in the list with its reason, so Delete can remove it, D14);
  - reads `worlds` and `state` (`getAll` with range null) in one `read`, never `diffs` or `history` (§1.3); `places` is `state.places.length`;
  - sorted by `state.updated` (or `created` before the first save) descending, ties by id.
- The writes:
  - `create`: `worlds` and `state` in one `write` (§1.2);
  - `rename`: `name.trim()` cut to 64; an empty name is refused with nothing written (**(plan)** `{status: 'abort', errorName: 'EmptyName'}`); the caller holds the world's lock (Task 21);
  - `remove`: `worlds[id]`, `state[id]`, `history[id]` and `deleteRange(diffs, worldRange(id))` in one `write` (E7);
  - `writeAll` (Import): the three records and every column in one `write`.
- `readAll` (Export, §2.4): the three records and the `diffs` range in one `read`, so a world open in another tab is read at one `flushSeq`; `WorldDump { world: WorldRecord; state: StateRecord; history: HistoryRecord | null; cols: { key: number; bytes: Uint8Array }[] }`, `cols` in colKey order.
- Pure batch builders the sim uses (Tasks 8, 9, 25): `flushOps(worldId: string, cols: readonly { key: number; bytes: Uint8Array | null }[], state: StateRecord, history: HistoryRecord | null, world: WorldRecord | null): WriteOp[]` (null bytes → delete of `[worldId, key]`); `copyOps(world: WorldRecord, state: StateRecord, history: HistoryRecord | null, cols: readonly { key: number; bytes: Uint8Array }[]): WriteOp[]`.
- `newWorldName(taken: readonly string[]): string` = "New world N", N ≥ 1 the smallest no world uses (D2); `backupName(name: string, taken: readonly string[]): string` = "<name> (before the change)", then "<name> (before the change 2)", "… 3" (D11); `exportFileName(name: string): string` = the name with every character outside letters, digits, space, `-` and `_` replaced by `_`, plus `.wiworld` (D15).

- [ ] **Step 1: Write the tests** (on `createMemoryKV()`): "`list` orders by `updated` descending, a never-saved world by `created`";
  - "`list` makes one `read` and never touches `diffs` or `history` (a spy KV)";
  - "a `worlds` record with a non-string `name` is listed as a broken row with `parseWorldRecord`'s reason";
  - "`create` then `readOpen` returns both records; `history` undefined";
  - "rename trims and cuts to 64; an empty name is refused";
  - "`remove` leaves no key of the world in any store, and another world's keys untouched (E7's `deleteLeftovers` in small)";
  - "a `failAt(2)` during `remove` leaves every key";
  - "`readAll` returns the diffs in colKey order";
  - "`flushOps` with a null column deletes its key";
  - `newWorldName` with "New world 1", "New world 3" taken → "New world 2";
  - `backupName('My world', ['My world (before the change)'])` → "My world (before the change 2)";
  - `exportFileName('a/b:c é')` → `a_b_c é.wiworld` **(plan)** (letters include non-ASCII letters, `\p{L}`).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/saves.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** (`saves.ts`'s `SP5B_MODULES` row is Task 4's.)
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(persist): world records over the KV: list, create, rename, delete, export reads, batches` (`git add src/persist/saves.ts test/unit/saves.test.ts`).

---

### Task 6: `IdbKV` and the selftest's IndexedDB section

**Files:**
- Create: `src/persist/idb.ts`
- Modify: `src/ui/selftest/selftestPage.ts` (a second section after the goldens), `test/unit/selftestPage.test.ts`, `test/tools/uiSmoke.ts` (the `selftest` step, `:1400-1405`, also reads `#selftest-kv`; moved here from Task 32), `test/unit/uiSmoke.test.ts`, `test/arch/masterSpec.test.ts` (row; the dependency-rule pin), master §1's dependency rule (`architecture-design.md:228`)

**Interfaces:**
- `openIdbKV(name: string, factory?: IDBFactory, onBlocked?: () => void): Promise<KV>` (default the global `indexedDB`): version 1's `upgradeneeded` creates the five stores (`STORES`) with out-of-line keys **(plan)**; a `blocked` during its own open is reported through `onBlocked` (no `onEvent` listener exists before the promise resolves); `read` maps each request to `get`, `getAll` + `getAllKeys` (zipped) or `count` with `IDBKeyRange.bound(lower, upper, false, true)` in one readonly transaction.
- `write`, in one readwrite transaction: `put` → `store.put(value, key)`, `delete` → `store.delete(key)`, `deleteRange` → `store.delete(IDBKeyRange.bound(lower, upper, false, true))`; each op is issued in a `try`, and a synchronous throw (`DataCloneError` from `put`'s clone, `DataError` from a bad key; neither aborts the transaction by itself) calls `tx.abort()` and settles `abort` with that exception's `name`; otherwise `complete` on `oncomplete` and `abort` on `onabort` with `tx.error?.name ?? null` (`QuotaExceededError` included). A `closed` flag is set by the connection's `close` event (the browser closed it: site data cleared), by the self-close on `versionchange` and by `close()`; `write` settles `{status: 'closed', errorName: null}` when the flag is set or when `db.transaction()` throws (`InvalidStateError`), so `write` never rejects (Task 2's contract); a transaction in flight during a forced close settles `abort` (`AbortError`) before `close` fires. Durability is left at the browser's default; on `versionchange` the connection closes itself and emits `versionchange`; `close()` closes it. `deleteIdb(name: string, factory?: IDBFactory): Promise<void>` (for the bench and the selftest, after every connection is closed).
- `selftestPage.ts`: `runKvSelftest(open: () => Promise<KV>, remove: () => Promise<void>): Promise<{ name; ok; error }[]>` (removes `wi10-selftest` before and after, closing its connection first); the page shows `#selftest-kv` "IndexedDB contract: n/n passed" (each failure's name and error listed); it never opens `wi10`.

- [ ] **Step 1: Write the tests** (`selftestPage.test.ts`): "`runKvSelftest` over `createMemoryKV` reports every `KV_CONTRACT` case ok and calls `remove` before and after";
  - "a failing case is reported with its name and error and the rest still run";
  - "the page's section opens only `wi10-selftest`" (a recording opener).
  - `uiSmoke.test.ts`: "the `selftest` step waits for `#selftest-kv` and expects `IndexedDB contract: n/n passed` with n = `KV_CONTRACT.length`" (n mirrored as a literal in `uiSmoke.ts`, pinned against `KV_CONTRACT.length`). The adapter itself is verified in Chrome by that step and in Firefox by the user (Task 35); **(plan)** the controller runs `node test/tools/uiSmoke.ts` once after this task's commit (its own port and profile) and records the `#selftest-kv` line in the task's report.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/selftestPage.test.ts test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1: "The exception is `persist/idb.ts`, which runs in the sim worker and, for the worlds menu, on the main thread (SP5b)." pinned; `SP5B_MODULES` row for `idb.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`. Expected: PASS; the build emits.
- [ ] **Step 5: Commit** `feat(persist): IdbKV over wi10 v1; the IndexedDB contract in ?selftest=1` (`git add src/persist/idb.ts src/ui/selftest/selftestPage.ts test/unit/selftestPage.test.ts test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 7: Sim I: the dirty set; the entry set as changes

**Files:**
- Modify: `src/sim/diffStore.ts`, `src/sim/edits.ts` (`EditResult` `:58-66`, the return `:415-424`), `src/workers/protocol.ts` (`EditedMsg` `:640-643`, `parseFromSim`'s `edited` `:695-702`), `src/workers/simHandler.ts` (`:71-75`), `src/engine/simClient.ts` (`:110-115`), `test/unit/diffStore.test.ts`, `test/unit/simEdits.test.ts`, `test/unit/protocol.test.ts`, `test/unit/simClient.test.ts`, `test/unit/simHandler.test.ts`, `test/unit/editPath.test.ts` (`:25`), `test/unit/blockHistory.test.ts` (`:45`), `test/unit/coordinator.test.ts` (`:2984-2988`: its reply goes through the real client and `parseFromSim`, so an `entryCols` there would fail the sim)

**Interfaces:**
- `DiffStore` gains `takeDirty(): Float64Array` (the colKeys whose entries changed since the last take, cleared), `markDirty(keys: Iterable<number>): void` (an aborted flush's merge-back, §3.2) and `setColumn(cx: number, cz: number, d: ColumnDiff): void` (the load: replaces the column's entries; marks nothing dirty). **(plan)** `set` and `remove` mark the column dirty, so both the writes at `edits.ts:375-376` and the restores at `:397-398` are covered (§3.2's dirty set) with no change to `applyEdits`' body.
- `EditResult` and `EditedMsg`: `entryCols` → `entryAdded: Float64Array` and `entryRemoved: Float64Array` (the colKeys whose `has` turned true / false in this batch, a refused batch's both empty), transferred (D20). `simClient`: `entries` add/delete per reply; `loaded` fills it whole (Task 8).

- [ ] **Step 1: Write the tests:** `diffStore.test.ts`: "set and remove mark their column; `takeDirty` returns each once, then nothing";
  - "`setColumn` marks nothing and replaces the column";
  - "a remove that empties a column marks it" (a flush then deletes its key). `simEdits.test.ts`: "after 200 random edits (places, breaks, reverts, a refused batch), the union of `entryAdded` minus `entryRemoved` replayed into a set equals `diffs.columns()` after each batch" (spec §6.3); "a batch refused `'full'` restores its entries and reports neither added nor removed, while its columns stay dirty (restored values marked)".
  - `protocol.test.ts`: `edited` with `entryAdded`/`entryRemoved` accepted, one missing refused. `simClient.test.ts`: "the entry set follows `entryAdded`/`entryRemoved`".
  - The three other `edited` literals carry `entryAdded`/`entryRemoved` in place of `entryCols`: `editPath.test.ts:25` (`entryAdded` its one column, `entryRemoved` empty), `blockHistory.test.ts:45` (both empty), and `coordinator.test.ts:2986`'s entry columns become `entryAdded` (`entryRemoved` empty).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/diffStore.test.ts test/unit/simEdits.test.ts test/unit/protocol.test.ts test/unit/simClient.test.ts test/unit/simHandler.test.ts test/unit/editPath.test.ts test/unit/blockHistory.test.ts test/unit/coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(sim): the dirty-column set; edited replies carry the entry changes (D20)` (`git add src/sim/diffStore.ts src/sim/edits.ts src/workers/protocol.ts src/workers/simHandler.ts src/engine/simClient.ts test/unit/diffStore.test.ts test/unit/simEdits.test.ts test/unit/protocol.test.ts test/unit/simClient.test.ts test/unit/simHandler.test.ts test/unit/editPath.test.ts test/unit/blockHistory.test.ts test/unit/coordinator.test.ts`).

---

### Task 8: Sim II: deferred replies and `load`

**Files:**
- Modify: `src/workers/protocol.ts` (`LoadMsg`, `LoadedMsg`; `ToSim` `:632`, `FromSim` `:651`, the guards `:667-713`), `src/workers/simHandler.ts`, `src/workers/sim.worker.ts`, `src/engine/simClient.ts`, `test/harness/inProcessSim.ts` (`:31-32`), `test/harness/nodeWorker.ts` (`:83-84`), `test/integration/edit.test.ts` (`:270`'s `factory: 'createSimHandler'` → `'createMemorySimHandler'`: `createSimHandler` now needs its `o`), `test/metrics/edit.metric.ts:371`, `test/unit/simHandler.test.ts`, `test/unit/simClient.test.ts`, `test/unit/protocol.test.ts`, `src/core/hash.ts` (`parseHex64`), `test/unit/hash.test.ts` (its round trip), `test/arch/masterSpec.test.ts` (the §4.13 pin), master §4.13 (World open; Prefetch removed), the SP5b spec (Spec corrections 4 and 12)

**Interfaces:**
- `LoadMsg { type: 'load'; id: number; db: string; worldId: string; flushSeq: number; genKey: string; updated: number; stateTable: readonly string[]; rewrite: { world: WorldRecord; history: HistoryRecord | null } | null }` (`genKey` the record's 16 hex digits, `updated` the stored state's: Spec correction 12); `LoadedMsg { type: 'loaded'; id: number; entryCols: Float64Array; entries: number; unknownStates: number; skippedColumns: number }` (`entryCols` transferred). The guards check the scalar fields (`genKey` against `/^[0-9a-f]{16}$/`, `updated` finite), `stateTable` an array of strings, `rewrite` null or an object with a string `world.id` **(plan)** (the records were normalised on the main thread).
- `parseHex64(s: string): Hash64` = `[parseInt(s.slice(8), 16), parseInt(s.slice(0, 8), 16)]` (the inverse of `hex64`, `src/core/hash.ts:236`, beside it **(plan)**); a round-trip unit test (`hex64(parseHex64(s)) === s` for seeded strings, and `parseHex64(hex64(h))` equals `h`). The sim keeps `load`'s genKey as a `Hash64`; a later `record` replaces it (Task 9).
- The handler (D18):
  - `createSimHandler(o: { openKV(db: string): Promise<KV> }): SimHandler`; `SimHandler.handle(m: unknown, post: (r: SimReply) => void): void`;
  - `attach`, `edits` and `diff` post at once, as today; `load` posts when its read (and its rewrite's write) settles;
  - from a `load`'s arrival until it settles every later message waits in arrival order **(plan)** (D18's "every later message"; §3.3 names `edits` and `diff`); a second `load` is BAD_MESSAGE;
  - `createMemorySimHandler(): SimHandler` (one `MemoryKV` per `db` name, module-level, for Node; Spec correction 4);
  - `sim.worker.ts` passes `{ openKV: (db) => openIdbKV(db) }` and posts each reply through `post` with its transfers; `inProcessSimWorker` posts through `post` after the injected delay;
  - the node wrapper (`nodeWorker.ts:78-87`) is shared with every task-handler worker (`createTaskHandler`'s `handle(raw): Reply` is synchronous, and nine integration files build through it), so it defines `post = (r) => parentPort.postMessage(r.msg, r.transfer)` (with `stamp`, `handledAt` added inside `post`) and runs `const r = h.handle(m, post); if (r !== undefined) post(r);`: synchronous handlers keep working unchanged, and the sim posts through `post`.
- `load` in the sim:
  - `openKV(db)`; one `read` of `getAll(diffs, worldRange(worldId))`;
  - each record `decodeColumnDiff(bytes, stateTable.length)` (a throw → skipped and counted), its ticks dropped (D21), remapped through `remapOf(stateTable)` when `tableRelation` is `'other'` (unknown states → air, counted), then `diffs.setColumn`;
  - with `rewrite`: one `write` of `worlds` ← `rewrite.world`, and, when the relation is `'other'`, every column re-encoded under today's ids (each keeping its decoded header genKey) and `history` ← `rewrite.history`, and the skipped columns' keys deleted (still encoded under the old table's ids, they would decode against the wrong table at the next open: D22's "a world never holds ids of two tables"), in the same write, before answering;
  - then `loaded`; `load`'s `flushSeq`, `genKey` (parsed to `Hash64`) and `updated` are kept for Task 9's flush and Task 25's copy;
  - a KV open or read failure answers **(plan)** an `error` reply (INTERNAL, its message), which the client treats as the sim's failure: the world opens without editing and nothing is written.
- `SimClient.load(m: Omit<LoadMsg, 'type' | 'id'>): Promise<LoadedMsg>` fills `entries` from `entryCols` before resolving. The client's `Pending` union (`simClient.ts:51-53`) gains `load`, `settleAll` (`:70-80`) rejects a pending `load` with the `SimFailed`, and a `load` on a closed client (failed or disposed) rejects `SimFailed` at once; the reply-kind check (`:107`) pairs `load`/`loaded` (and Task 9's `flush`/`flushed`), any other pairing failing the sim. The page (Task 10) catches a `load`'s `SimFailed` as it does `simAttached`'s (`worldPage.ts:1630-1635`) and opens without editing.

- [ ] **Step 1: Write the tests:** `simHandler.test.ts` (a MemoryKV seeded through `flushOps`, a store from the region harness as SP5a's tests attach it): "`load` fills the DiffStore and answers the set, the entry count and 0 skipped";
  - "a corrupt record is skipped and counted, the others load";
  - "a `diff` posted right after `load` waits and returns the loaded entries (with a 50 ms read delay)";
  - "an `edits` posted during the load runs after it, in order";
  - "a permuted stored table: the entries load under today's ids, `unknownStates` counts the unknown key's voxels";
  - "`rewrite` with a prefix table writes `worlds` only; with a non-prefix one writes every column re-encoded and the history, in one write, before `loaded`";
  - "a permuted table with one undecodable column: after `load`, that key is gone and the others are re-encoded";
  - "a KV open failure → an `error` reply".
  - `simClient.test.ts`: "`load` resolves after `hasEntries` holds the loaded set"; "a pending `load` rejects `SimFailed` when the sim fails, and a `load` on a disposed client rejects at once"; "a `loaded` reply to a pending `edits` fails the sim".
  - `protocol.test.ts`: `load` and `loaded` accepted; a non-string `stateTable` entry refused; a `genKey` of 15 digits or upper-case hex refused.
  - The integration test `edit.test.ts` runs through the new wrapper with `createMemorySimHandler`, and the pool's task workers through the same wrapper unchanged.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simHandler.test.ts test/unit/simClient.test.ts test/unit/protocol.test.ts test/unit/hash.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.13: "- **World open:** the sim worker loads all of the world's diffs in one key-range read (SP5b; no prefetch)." and the Prefetch line removed, pinned; the spec's Spec corrections 4 and 12 (§3.3's `load` fields).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; the integration test `edit.test.ts` still green through the wrapper's `post`.
- [ ] **Step 5: Commit** `feat(workers): deferred sim replies; load fills the DiffStore before anything else runs` (`git add src/workers/protocol.ts src/workers/simHandler.ts src/workers/sim.worker.ts src/engine/simClient.ts src/core/hash.ts test/harness/inProcessSim.ts test/harness/nodeWorker.ts test/integration/edit.test.ts test/metrics/edit.metric.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts test/unit/protocol.test.ts test/unit/hash.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 9: Sim III: `flush` and `record`

**Files:**
- Modify: `src/workers/protocol.ts`, `src/workers/simHandler.ts`, `src/engine/simClient.ts`, `test/unit/simHandler.test.ts`, `test/unit/simClient.test.ts`, `test/unit/protocol.test.ts`, `test/arch/masterSpec.test.ts`, master §4.13's Flush

**Interfaces:**
- `FlushMsg { type: 'flush'; id: number; state: StateRecord; history: HistoryRecord | null }`; `RecordMsg { type: 'record'; world: WorldRecord }` (no reply); `FlushedMsg { type: 'flushed'; id: number; ok: true; flushSeq: number; columns: number; bytes: number; syncMs: number; commitMs: number } | { type: 'flushed'; id: number; ok: false; status: 'abort' | 'closed'; errorName: string | null }` **(plan)** (§3.3's `error` as the KV's status and name, so D14 tells "full" from "closed").
- The sim (§3.2):
  - a `flush` arriving with none in flight runs its synchronous part at once: `takeDirty()`; for each key `encodeColumnDiff(columnDiff(cx, cz), genKey)` when the column `has` entries, else a delete; `state` with `flushSeq` = last committed + 1; the history when given; the pending `record` when one arrived; `flushOps` in one `write`; the header's genKey is `load`'s `genKey` (kept as a `Hash64`, Task 8), replaced by each `record`'s genKey (parsed with `parseHex64`) when that `record` arrives (Spec correction 12);
  - with one in flight, a new `flush` replaces any queued one (its state is newer; a queued history is kept unless the new one carries one), and the queued one runs when the first settles;
  - on `complete`: last committed = that `flushSeq` (and its state's `updated`, Task 25), `flushed` ok;
  - on `abort` or `closed`: `markDirty` of the taken keys; the history and the `record` stay pending unless a newer one arrived; `flushed` not ok;
  - `syncMs` the synchronous part (take, encode, batch), `commitMs` write → settle, on `performance.now`; `columns` and `bytes` the batch's;
  - a latched (failed) handler never flushes (`simHandler.ts:51-52`); an edit handled between a flush's encode and its settle marks its column again, so the next flush carries it;
  - a `record` with none in flight waits for the next flush (it is never written alone **(plan)**: the main thread counts it as a change, so the next tick posts).
- `SimClient.flush(state: StateRecord, history: HistoryRecord | null): Promise<FlushedMsg>`, `SimClient.record(world: WorldRecord): void`. A pending `flush` rejects `SimFailed` when the sim fails or the client is disposed (`settleAll`), and a `flush` on a closed client rejects at once; autosave (Task 12) treats that as not saved, with no storage notice (the sim's own failure notice shows). `record` on a closed client does nothing.

- [ ] **Step 1: Write the tests** (`simHandler.test.ts`, MemoryKV): "a flush writes the dirty columns, the state with `flushSeq` 1 and the history in one write; a second with nothing dirty writes the state only with `flushSeq` 2";
  - "a column reverted to its generated value deletes its key";
  - "an abort (`failAt(3)`) merges the columns back: the next flush commits the union with `flushSeq` + 1, and a history and a `record` of the aborted batch are in it";
  - "two flushes posted while one is in flight: the first queued is replaced by the second, the queued history kept when the second has none";
  - **Review Focus 1:** "edits A posted, `flush` posted, edits B posted before A's reply; the flush's write `crashNext()`ed: a fresh handler's `load` on the same KV gives exactly the previous committed flush's columns, and `kv.read([{ op: 'get', store: 'state', key: worldId }])` gives its `flushSeq`; with the write completing instead, A's column is in it and B's column is dirty again and in the next flush with `flushSeq` + 1";
  - "a column flushed before any `record` carries `load`'s genKey in its header; after a `record` with another genKey, the next flushed column carries that one";
  - "after an `error` reply nothing is flushed";
  - "`syncMs` and `commitMs` are finite and ≥ 0".
  - `simClient.test.ts`: "a pending `flush` rejects `SimFailed` when the sim fails; a `flush` on a disposed client rejects at once".
  - `protocol.test.ts`: the three messages.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/simHandler.test.ts test/unit/simClient.test.ts test/unit/protocol.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.13's Flush: "… dirty diffs plus the `state` record (player, time, hotbar, places, `flushSeq`) and, when changed, the `history` record, in one readwrite transaction …", pinned.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(workers): the sim flushes dirty columns, state and history in one transaction` (`git add src/workers/protocol.ts src/workers/simHandler.ts src/engine/simClient.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts test/unit/protocol.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 10: Opening a saved world

**Files:**
- Modify: `src/ui/world/query.ts` (`WorldQuery.world: string | null`, `?world=<id>`), `src/ui/world/startScreen.ts` (`WORLD_KEYS` `:15` gains `'world'`; moves in Task 20), `src/ui/map/mapState.ts` (`openSavedSession`), `src/ui/world/worldPage.ts` (`run()` `:1563-1785`: steps 2-3 of §3.4), `test/unit/worldQuery.test.ts`, `test/unit/startScreen.test.ts`, `test/unit/mapSession.test.ts`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts` (the `stateBounds.ts` row), master §1's `ui/world/*` entry, the SP5b spec (Spec corrections 10 and 11)
- Create: `src/ui/world/stateBounds.ts`, `test/unit/stateBounds.test.ts`

**Interfaces:**
- `openSavedSession(params: Params, w: Pick<WorldRecord, 'seedText' | 'profile'>, random: () => Seed64): WorldSession` (`new WorldSession(random, { seedText, profile, patch: diffParams(SCHEMA, resolveProfile(profile), params), validateParams })`, the arch's `uiSessions` rule).
- `readSavedWorld(saves: Saves, id: string, bounds: StateBounds): Promise<{ ok: true; world: WorldRecord; params: Params; state: StateRecord; history: HistoryRecord; notices: string[] } | { ok: false; reason: string }>` (exported from `worldPage.ts`; §3.4 step 2, D14): `readOpen`; a missing `worlds` record, one `parseWorldRecord` (Task 4) refuses, or `loadParams` refused → `{ ok: false, reason }` (the page then mounts the menu with "This world could not be opened: <reason>", Task 20); a bad `state` → `newState` with "This world's position, time, hotbar and places could not be read and were reset"; an absent `history` (a new world's, Task 5) → none and no notice; a present one that is not a record → none with "This world's undo history could not be read" (`normalizeHistory`'s `reset`, Spec correction 10); the history remapped through `remapOf(world.stateTable)` when `'other'`.
- `STATE_BOUNDS: StateBounds` in a new `src/ui/world/stateBounds.ts` **(plan)** (Task 4's shape, built from `normalizeHotbar`, `TIME_SPEEDS`, `SPEED_MIN`/`SPEED_MAX`, `WINDOW_HALF`, `Y_MIN`/`Y_MAX`; used by this task's page, Task 12's autosave and Task 20's Create), with `test/unit/stateBounds.test.ts`: "`STATE_BOUNDS` equals the player's, the world's and the clock's constants; saves' `HISTORY_STEPS` equals `BLOCK_HISTORY_STEPS`, `DEFAULT_SPEED` equals `SPEED_DEFAULT` and `DEFAULT_T` equals `OPENING_T`". This task adds master §1's `ui/world/*` SP5b token (`stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)`) and its `SP5B_MODULES` row for `stateBounds.ts`.
- The page with `q.world !== null` **(plan)**: opens `IdbKV('wi10')` once (Task 15 opens the bench route's `wi10-bench` through the bench driver's option; Task 16 adds the `?enterBench=1&db=` override; the connection closed at the page's teardown), `readSavedWorld`, the session from `openSavedSession` in place of `decodeMapState`/`openMapSession` (`:1565`, `:1597`). The page refuses the world when `openSavedSession(…).initNotice !== null` (the session's own validation refused the saved params and opened `default` with `{}`, `session.ts:152`, `:160`): the menu with "This world could not be opened: <initNotice>", no `load`, no `record` (so no `record` with another world's genKey overwrites it). `simClient.load({ db, worldId, flushSeq: state.flushSeq, genKey: world.genKey, updated: state.updated, stateTable: world.stateTable, rewrite })` posted right after `attach` (`:1630-1633`), `rewrite` per D22 (`tableRelation` not `'equal'`: the record with `todayStateTable()`, and the remapped history when `'other'`); awaited with `simAttached` (`:1637`), before the coordinator's first `update` (`:1709`); a `SimFailed` from it is caught as `simAttached`'s (the world opens without editing). `loaded.skippedColumns` > 0 shows "n columns of this world could not be read"; `loaded.unknownStates` > 0 "n blocks of unknown types became air".
- The page keeps the record it opened (the one later `record` messages and Task 25's backup are built from); when `rewrite` is non-null, the kept record is `rewrite.world` (today's table) from then on (Spec correction 11; Task 23 and Task 25 add the other two updates).

- [ ] **Step 1: Write the tests:** `worldQuery.test.ts`: "`?world=abc` → `world` 'abc'; absent → null".
  - `startScreen.test.ts`: "`?world=abc` → 'world'".
  - `mapSession.test.ts`: "`openSavedSession` over amplified params equals `openMapSession` of the same seed, profile and patch".
  - `worldPage.test.ts` (MemoryKV): "`readSavedWorld` of a created world → ok with `newState`'s defaults and `notices` `[]`";
  - "a missing record → `{ok: false}`"; "a record `parseWorldRecord` refuses → `{ok: false}` with its reason";
  - "a state `'garbage'` → the reset notice and defaults; a history `7` → the history notice and none";
  - "a permuted `stateTable`: the history's values remapped";
  - "params a tree validator refuses (`openSavedSession(…).initNotice` set) → not opened (the could-not-be-opened text), nothing written, no `load` posted";
  - "after a permuted-table open, the kept record's `stateTable` equals `todayStateTable()`". The rule that every saved edit is seen from the first D is E3's (Task 30) and the smoke's `save` (Task 32).
  - `stateBounds.test.ts`: the pins above.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldQuery.test.ts test/unit/startScreen.test.ts test/unit/mapSession.test.ts test/unit/worldPage.test.ts test/unit/stateBounds.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1's `ui/world/*` entry gains the SP5b token, pinned through the `stateBounds.ts` row; the spec's §3.4 step 2 (Spec correction 10) and §3.6's kept record (Spec correction 11).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): /?world=<id> opens a saved world, its diffs loaded before the first update` (`git add src/ui/world/query.ts src/ui/world/startScreen.ts src/ui/map/mapState.ts src/ui/world/worldPage.ts src/ui/world/stateBounds.ts test/unit/worldQuery.test.ts test/unit/startScreen.test.ts test/unit/mapSession.test.ts test/unit/worldPage.test.ts test/unit/stateBounds.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 11: Restoring the player: pose, mode, flying speed, time

**Files:**
- Modify: `src/ui/world/worldPage.ts` (`:1641-1647`, `:1735-1743`; the reveal's mode), `src/player/fly.ts:18-20` (the comment: the mode restored per saved world, SP5b), `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts`, master §4.17, the SP5b spec (Spec correction 5)

**Interfaces:**
- `restoredStart(state: StateRecord, q: WorldQuery, fixedT: number | null): { centre: { x: number; z: number } | null; view: { y: number | null; yaw: number | null; pitch: number | null }; speed: number; t: number; speedIndex: number; walk: boolean; saveClock: boolean }` (exported, §3.4 step 5): with `state.player`, its x, z as the centre (skipping `workers.spawn()`), its y, yaw, pitch into `firstView`'s query slot, its `speed`, `walk` = `mode === 'walk'`; `?at`, `?y`, `?yaw`, `?pitch` ignored (D4); with `player: null`: centre null (the spawn search), the query slot empty, `SPEED_DEFAULT`, flying; `t`, `speedIndex` from `state.time` unless `fixedT !== null` (then `fixedT`, the stored time kept: `saveClock` false). After the reveal, `walk` calls `switchMode` once (`:1355-1364`). Replaces "Every load opens in flight" (`:1736`) in saved worlds; unsaved worlds unchanged (D29).

- [ ] **Step 1: Write the tests** (`worldPage.test.ts`): "player `{x: 100.5, y: 80.25, z: -40.75, yaw: 90, pitch: -20, mode: 'walk', speed: 30}` → centre (100.5, −40.75), view `{y: 80.25, yaw: 90, pitch: -20}`, speed 30, walk true";
  - "`?at=1,2&y=5&yaw=10&pitch=3` beside `?world` is ignored";
  - "`player: null` → centre null, speed 12, flying, `t` 1/12, `speedIndex` 0";
  - "`time {t: 0.5, speedIndex: 2}` → 0.5 and 2";
  - "a `?shot=1&time=12` capture (`fixedT` 0.25): `t` 0.25, `saveClock` false";
  - "the page's helper that applies `walk` after the reveal calls `switchMode` exactly once" (a fake `switchMode`).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §4.17: "Player mode, position, yaw, pitch" restored per world gains "and the flying speed (SP5b)", pinned; the spec's D4 and §3.4 step 5 read "a `?shot=1&time=` capture" (Spec correction 5).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): a saved world reopens at its pose, mode, flying speed and time` (`git add src/ui/world/worldPage.ts src/player/fly.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 12: `ui/world/autosave.ts`: triggers and the state snapshot

**Files:**
- Create: `src/ui/world/autosave.ts`, `test/unit/autosave.test.ts`
- Modify: `test/arch/masterSpec.test.ts` (the `autosave.ts` row, against the `ui/world/*` token Task 10 added)

**Interfaces:**
- `STATE_BOUNDS` is imported from `src/ui/world/stateBounds.ts` (Task 10).
- `snapshotState(o: { worldId: string; fly: Pick<FlyState, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'mode' | 'speed'>; time: { t: number; speedIndex: number }; hotbar: HotbarRecord; places: readonly Place[]; updated: number }): StateRecord` (through `normalizeState` with `STATE_BOUNDS`, so −0 and non-finite numbers never reach Export, §2.1; `flushSeq` set by the sim). The hotbar is a `HotbarRecord` (`{ v: 1, active, slots }`, what Task 14's `hotbarStorage` `get()` returns): `normalizeHotbar` gives the defaults for anything without `v: 1` (`src/player/hotbar.ts:84-85`), so a bare `{ active, slots }` would save the default hotbar every tick.
- `createAutosave(o: AutosaveDeps): Autosave`; `AutosaveDeps { clock: { now(): number; setInterval(f: () => void, ms: number): number; clearInterval(id: number): void; setTimeout(f: () => void, ms: number): number; clearTimeout(id: number): void }; events: { on(type: 'visibilitychange' | 'pagehide' | 'beforeunload', f: () => void): () => void; hidden(): boolean }; flush(state: StateRecord, history: HistoryRecord | null): Promise<FlushedMsg>; build(): { state: StateRecord; history: HistoryRecord; historyVersion: number }; settled(): Promise<void>; editsSince(): number; onResult(r: FlushedMsg): void }`; `Autosave { tick(): Promise<void>; flushNow(): Promise<FlushedMsg | null>; beforeLeave(ms?: number): Promise<void>; markChanged(): void; pause(on: boolean): void; dispose(): void }`.
- Rules (§3.2): `AUTOSAVE_MS = 2000`, `SETTLE_WAIT_MS = 1000`, `LEAVE_WAIT_MS = 1000`.
  - **(plan)** "Changed" means any of: an edit reply since the last committed flush (`editsSince()` > 0); the state differing from the last committed one (its canonical JSON without `updated` and `flushSeq`); a history version differing from the last committed one; `markChanged()` (a pending `record`, a place); a failed flush;
  - the counters (`editsSince()`, the `markChanged` count, the history version and the state's canonical JSON) are captured when a flush is posted; its `flushed` ok clears only what it captured, so a `markChanged()` or an edit reply that arrives while that flush is in flight still counts as changed for the next tick;
  - a `flush` that rejects `SimFailed` (Task 9) counts as not saved, with no storage notice, and the timer stops (the sim is gone);
  - the timer is independent of frames (the frame pauses under overlays); its tick waits for `settled()` at most 1,000 ms, then builds the state and the history in the same task, so a flushed edit's step is in the same flush;
  - the history is posted only when its version differs from the last committed one, else `null`;
  - `visibilitychange` to hidden, `pagehide` and `beforeunload` post at once, with no settled wait;
  - a failed flush keeps "changed", so every later tick and trigger posts again; a `closed` result stops the timer (Task 29);
  - `beforeLeave(ms)` posts and resolves at `flushed` or after `ms`;
  - `pause(true)` stops the timer's posts (the bench's L1-L10 and L11's "off" parts), never `flushNow`;
  - the state object is built at the tick, never per frame.

- [ ] **Step 1: Write the tests** (an injected clock, fake events): "nothing changed → the 2,000 ms tick posts nothing";
  - "an edit reply → the next tick posts once";
  - "the tick waits for `settled()`: a settle at 300 ms posts at 300 ms with the step's history; a settle that never comes posts at 1,000 ms";
  - "hidden, `pagehide` and `beforeunload` post at once, without waiting";
  - "a failed flush: the next tick posts with nothing new, and so does `pagehide`";
  - "the history is posted only when its version changed since the last committed flush";
  - "`beforeLeave(1000)` resolves at `flushed` (200 ms), or at 1,000 ms when none comes";
  - "paused: the tick posts nothing, `flushNow` posts";
  - "`markChanged()` between a flush's post and its `flushed` → the next tick posts"; "an edit reply in that window → the next tick posts";
  - "a `flush` rejecting `SimFailed` → `flushNow` resolves null, no storage notice, the timer stops";
  - "`snapshotState` maps `pitch: -0` to 0 and passes `canonicalJSON`; a `NaN` x gives `player: null`";
  - "a hotbar with `active` 4 and slot 0 `'bricks'` survives `snapshotState` unchanged".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/autosave.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `SP5B_MODULES` row `[/^\s+ui\/world\/\* /, 'stateBounds.ts autosave.ts worldLock.ts modifyMode.ts places.ts placeDialog.ts (SP5b)', 'src/ui/world/autosave.ts']`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): autosave's triggers and the state snapshot` (`git add src/ui/world/autosave.ts test/unit/autosave.test.ts test/arch/masterSpec.test.ts`).

---

### Task 13: Autosave in the page: navigations, Reload URLs, the last flush on failure

**Files:**
- Modify: `src/ui/world/worldPage.ts` (the reveal `:2169-2330`: autosave created, the URL writer not created in a saved world `:2213-2222`, `here` `:2224`, `failAfterReveal` `:2239-2256`, `handleContextLoss`'s `hereHref` `:2276`, the loading failure's `lowerRdHref` `:1493-1496`, `EDIT_FAILED_NOTICE` `:1059`), `src/ui/world/reload.ts` (`savedWorldUrl`), `test/unit/worldPage.test.ts`, `test/unit/worldReload.test.ts`, `test/unit/zeroAlloc.test.ts`

**Interfaces:**
- `savedWorldUrl(id: string, rd: number | null): string` = `/?world=<encodeURIComponent(id)>[&rd=<rd>]` (D4, §3.4 step 7); in a saved world `here`, the failure panel's Reload, the lost context's Reload and the loading failure's lower-RD link use it; the URL writer is not created, so the address stays `/?world=<id>`.
- Every navigation the page starts in a saved world (the reloader's, `createReloader`, `reload.ts:133-142`) first `await autosave.beforeLeave(1000)` **(plan)** (the reloader's `navigate` wrapped; D31's Worlds menu, Task 28, uses the same path).
- A failure after the reveal in a saved world (`failAfterReveal`) stops the loop and closes the overlays, then, unless the sim is what failed, `flushNow()` with a 1,000 ms bound before the release list runs and the panel shows (D14).
- `SAVED_EDIT_FAILED_NOTICE = 'Editing stopped: the edit worker failed; changes after the last save (at most 2 s) are lost'` (D14) in saved worlds; unsaved worlds keep SP5a's (D29).
- The page's `AutosaveDeps`: `flush` = `simClient.flush`, `build` from `fly`, `frame.t`/`speedIndex` (the stored time while `saveClock` is false), the hotbar, the places (Task 26; empty until then), the block history's snapshot (Task 14; empty until then), `Date.now()`; `editsSince` counts the edit path's accepted replies since the last committed flush; `onResult` hands the flush result to the notices (Task 29).

- [ ] **Step 1: Write the tests:** `worldReload.test.ts`: "`savedWorldUrl('a b', 12)` is `/?world=a%20b&rd=12`; without rd `/?world=a%20b`".
  - `worldPage.test.ts`: "in a saved world the failure panel's Reload, the context loss's Reload and the lower-RD link are `savedWorldUrl`s, never `/?at=`";
  - "a navigation waits for `beforeLeave`: the URL is set after `flushed`, or after 1,000 ms";
  - "a failure after the reveal posts one flush and releases the sim only after `flushed` (or 1,000 ms); a failure of the sim itself posts none";
  - "the saved world's sim notice is `SAVED_EDIT_FAILED_NOTICE`".
  - `zeroAlloc.test.ts`: "N frame steps at rest in a saved world (autosave armed, its timer not firing) grow the heap by less than the boxing budget of 256 B per tick".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldReload.test.ts test/unit/worldPage.test.ts test/unit/zeroAlloc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): autosave in the saved world; every Reload and navigation saves first and reopens /?world` (`git add src/ui/world/worldPage.ts src/ui/world/reload.ts test/unit/worldPage.test.ts test/unit/worldReload.test.ts test/unit/zeroAlloc.test.ts`).

---

### Task 14: The hotbar per world; the block history kept

**Files:**
- Modify: `src/player/hotbar.ts:6` (the comment), `src/ui/world/blockHistory.ts` (`snapshot`, `restore`, `version`; D32's drop; the doc `:15-18`), `src/ui/world/editPath.ts` (`'changed'` in `EditOutcome.why` reaches the history), `src/ui/world/worldPage.ts` (`:2189-2196`, `:2395`), `test/unit/hotbar.test.ts`, `test/unit/blockHistory.test.ts`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts` (`:1276`'s Block undo pin moved into the SP5b describe), master §4.12 (Block undo, Hotbar)

**Interfaces:**
- `hotbarStorage(get: () => HotbarRecord, set: (h: HotbarRecord) => void): Pick<Storage, 'getItem' | 'setItem'>` (exported from `worldPage.ts`; `getItem(HOTBAR_KEY)` returns the world's hotbar JSON, `setItem` parses and marks it changed; `get()`'s `HotbarRecord`, with its `v: 1`, is what the autosave's `build` hands `snapshotState`, Task 12); a saved world's `createHotbar` gets it, so `wi.world.hotbar` is not read or written there; unsaved worlds keep SP5a's localStorage hotbar **(plan)** (D29).
- `BlockHistory` gains `snapshot(): { done: BlockStep[]; undone: BlockStep[] }`, `restore(done: readonly BlockStep[], undone: readonly BlockStep[]): void` (each side cut to the newest `BLOCK_HISTORY_STEPS` = 100) and `readonly version: number` (bumped by `record`, an accepted undo or redo, a drop and `restore`). **D32:** a press refused as `'changed'` drops that step (by identity) and shows `Can't undo there: the blocks changed` / `Can't redo there: the blocks changed` for 4,000 ms (`REFUSED_NOTICE_MS`), so the next press reaches the older steps; `unloaded` and `regenerating` keep SP5a's rule (the step stays). D32 applies in every world.

- [ ] **Step 1: Write the tests:** `hotbar.test.ts`: "a hotbar over `hotbarStorage` reads the world's `{v: 1, active: 4, slots}` and writes every change through `set`; `localStorage` untouched".
  - `blockHistory.test.ts`: "`snapshot` then `restore` into a fresh history gives the same sides and the same undo";
  - "`restore` of 120 steps keeps the newest 100";
  - "a `'changed'` refusal drops the step with its notice; the next press undoes the older step";
  - "`unloaded` keeps the step on top (SP5a)";
  - "`version` moves on record, undo, redo, drop and restore". **Review Focus 1** (`worldPage.test.ts`, MemoryKV and the in-process sim, which handles and answers each message `delayMs()` after its post, `inProcessSim.ts:13-46`; a step is recorded only after its accepted reply): "one step on voxel A recorded and flushed first; then three steps on voxel B (distinct values) posted 50 ms apart, each reply 70 ms late; `pagehide` at 110 ms posts at once (no settled wait), its history holding A's step and B's first; after a reopen from the KV, Ctrl+Z ×3: B's first step dropped with `Can't undo there: the blocks changed`, A's step undone, and the third press finds nothing".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/hotbar.test.ts test/unit/blockHistory.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The page restores the history from `readSavedWorld` (remapped) and the autosave's `build` reads `snapshot()` and `version`. Master §4.12: "**Block undo** (SP5a): … the last 100 undo and 100 redo steps per world, kept across reloads (SP5b), separate from the map's history." (the line pinned whole, moved from `:1276`) and "Hotbar slots persist per world by type name" gains "(SP5b, in the `state` store)".
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the hotbar per world; the block history kept across reloads; a changed step is dropped (D32)` (`git add src/player/hotbar.ts src/ui/world/blockHistory.ts src/ui/world/editPath.ts src/ui/world/worldPage.ts test/unit/hotbar.test.ts test/unit/blockHistory.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 15: `persist.flush` in `npm run bench`; bench leg L11

**Files:**
- Modify: `test/bench/gates.ts` (`BENCH_ROWS` `:67-73` appends `persist.flush`; `PERSIST_FLUSH_P99_MAX_MS = 2` beside `RELIGHT_P95_MAX_MS` `:33`; `PERSIST_RUN`; `absoluteGateFailures`), `test/bench/noise.bench.ts` (the row), `test/baselines.json` (recorded), `test/unit/benchGates.test.ts`, `src/ui/world/bench.ts` (`BenchLeg.name` gains `'L11'`; `BENCH_FRAME_CAPACITY` `:65` → 87168; L11; the `persist` block), `src/ui/world/worldPage.ts` (the bench route's world saved in `wi10-bench`), `src/workers/simHandler.ts` (`flushSyncPart` exported), `test/unit/bench.test.ts`, `test/unit/simHandler.test.ts`

**Interfaces:**
- `persist.flush` (§6.2): one flush's synchronous part on a `MemoryKV` (the dirty walk, `encodeColumnDiff` per column, `flushOps`) for 64 dirty columns, 4 with a dense section, the rest 200-600 sparse entries (seeded); `PERSIST_RUN = { iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 }`; gated p99 ≤ 2 ms. **(plan)** The timed call is `flushSyncPart(diffs: DiffStore, worldId: string, genKey: Hash64, state: StateRecord, history: HistoryRecord | null, world: WorldRecord | null): { ops: WriteOp[]; taken: Float64Array; bytes: number }` exported from `simHandler.ts`: the take (`takeDirty()`), the encode per column with `genKey`, and `flushOps`, which Task 9's flush calls before `write` (it keeps `taken` for the abort's merge-back), so the row times the sim's own code; Task 9's body moves into it unchanged. `takeDirty()` clears the set, so the row's per-iteration setup (untimed) calls `markDirty` with the 64 keys, and passes a fixed genKey.
- The bench route **(plan)**: deletes `wi10-bench` (every connection closed first: the sim's by disposing the sim client, which terminates the worker and with it its connection, IdbKV's self-close on `versionchange` being the backstop; then the page's by `kv.close()`; then `deleteIdb`), creates a world record there for its seed and parameters, posts `load` (an empty world) before the first update, creates autosave paused; L1-L10 unchanged with autosave paused; after L10 at its hover point with the RD 12 disc filled, one unmeasured `flushNow()`; then L11a-L11d, four 30 s parts, autosave off, on, off, on, each 150 scripted edits at 5 per second through the page's edit path over a 4 × 4-column area at the hover point, alternately placing and breaking stone, every tenth a torch (each flush carries the block history those edits record, Task 14); at the end every connection closed and `wi10-bench` deleted.
- `BenchResult.persist`: per part `{ p95: number; p99: number; over33: number; editVisibleP95: number | null }` (L11a-L11d), and over the "on" parts `flushSyncP95Ms`, `flushSyncMaxMs`, `flushCommitP95Ms`, `replyDuringFlushP95Ms` (edits whose post → reply overlaps a flush), `flushMainP95Ms` (the tick's main-thread work: build and post), `flushes` (count); derived `over33Added` (Σ on − Σ off), `p95AddedMs` (mean p95 on − off), `editVisibleAddedMs`. `BENCH_FRAME_CAPACITY` 87,168 (58,368 + L11's 120 s at 240 Hz).

- [ ] **Step 1: Write the tests:** `benchGates.test.ts`: "`BENCH_ROWS` ends `'relight.edit', 'persist.flush'`";
  - "a `persist.flush` p99 of 2.1 ms fails `absoluteGateFailures`, 1.9 passes".
  - `bench.test.ts`: "L11's script has 600 edits in four 30 s parts at 0.2 s spacing over 16 columns, every tenth a torch; autosave paused in L11a and L11c, running in L11b and L11d";
  - "`over33Added`, `p95AddedMs` and `editVisibleAddedMs` from fixed parts (on 3 and 1 frames over 33 ms, off 1 and 1 → 2)";
  - "`BENCH_FRAME_CAPACITY` is 87168";
  - "the route deletes `wi10-bench` at its start and end after closing the page's and the sim's connections: at the end the order is the sim client's dispose → the page's `kv.close()` → `deleteIdb`" (fakes recording the order);
  - `simHandler.test.ts`: "`flushSyncPart` of 64 marked keys returns their ops, the keys as `taken` and the batch's bytes; the dirty set is empty after it".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/benchGates.test.ts test/unit/bench.test.ts test/unit/simHandler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; on a quiet machine `npm run bench:record`, then `npm run bench`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff; `persist.flush` p99 ≤ 2 ms; every row within its gates and +30 %.
- [ ] **Step 5: Commit** `test(bench): persist.flush within 2 ms; bench leg L11 alternates autosave off and on` (`git add test/bench/gates.ts test/bench/noise.bench.ts test/baselines.json test/unit/benchGates.test.ts src/ui/world/bench.ts src/ui/world/worldPage.ts src/workers/simHandler.ts test/unit/bench.test.ts test/unit/simHandler.test.ts`).

---

### Task 16: `?bench=enter`; `measureChrome` → `assets/sp5b`

**Files:**
- Modify: `src/main.ts` (`:62-76`: `?bench=enter`), `src/ui/world/bench.ts` (`mountEnterBench`), `src/ui/world/query.ts` (`enterBench`, `db`), `src/ui/world/worldPage.ts` (the enter result), `test/tools/measureChrome.ts` (`--route enter`, `ROUTE_QUERY` `:154`, the out directory `assets/sp5b/`, the doc `:5`, `:63-65`), `test/unit/measureChrome.test.ts`, `test/unit/bench.test.ts`, `test/unit/worldQuery.test.ts`, the SP5b spec (Spec corrections 7 and 8)

**Interfaces:**
- `?bench=enter` (the setup page, **(plan)**): deletes `wi10-bench`; creates the world (seed 42, `default`, RD 12) with a heavy save written through `saves` and `encodeColumnDiff` (every column of the RD 12 + 3 disc around the spawn with 64 sparse entries, 16 of them with a dense section, seeded), its state at a fixed pose (the spawn's centre, y 120, yaw 45, pitch −20, flying); writes `window.__wiEnter = { worldId, pose }`; `?bench=enter&phase=end` closes and deletes `wi10-bench`.
- `?enterBench=1` on a world load records `window.__wiEnterResult = { revealMs, idbOpenMs, loadMs, decodeMs }` (`revealMs` as the bench's, `bench.ts:496`; the last three null on an unsaved load); `&db=<name>` is honoured only with `enterBench=1` (Spec correction 7).
- `measureChrome --route enter --gpu iris|rtx` (cold shader cache, `shaderCacheOf` cold): the setup page, then six alternations, each a fresh page load, of (a) `/?at=<x>,<z>&y=<y>&yaw=<yaw>&pitch=<pitch>&rd=12&enterBench=1` and (b) `/?world=<id>&rd=12&enterBench=1&db=wi10-bench`; then a new world from the start screen (`/?enterBench=1&db=wi10-bench`, `#start-new` then `#new-create` clicked over CDP; Task 20 implements this leg, and until then it is recorded as skipped, `newWorldRevealMs: null`); then the end page. Output `enter-<gpu>-chrome.json`: `{ pairs: [{ unsaved, saved }] × 6, kept: 5, enterRatio, medianUnsavedMs, medianSavedMs, idbOpenMs, loadMs, decodeMs, newWorldRevealMs, shaderCache: 'cold', gpu }` with `enterRatio` = median (b) / median (a) over pairs 2-6. Every route now writes `docs/superpowers/specs/assets/sp5b/` (Spec correction 8).
- `?bench=enter&auto=1` **(plan)**, the self-driving form for a browser with no CDP driver (the user's Firefox, Task 35; spec §6.2's "RTX and Firefox recorded"): the setup page as above, then the six (a)/(b) pairs as fresh page loads driven by `sessionStorage` (`wi.enterAuto`: the step index and the results so far; each world load with `enterBench=1&auto=1` stores its `__wiEnterResult` there and `location.assign`s the next URL), then the end phase, then a page offering the JSON in `measureChrome`'s shape (`gpu` from the renderer string, `shaderCache: 'unknown'`, the new-world leg null) for download (`downloadText`). Without `auto=1` nothing navigates by itself.

- [ ] **Step 1: Write the tests:** `measureChrome.test.ts`: "`--route enter` parses; `--workers` and `--shot` refuse it";
  - "`outputName({ route: 'enter', gpu: 'iris' })` is `enter-iris-chrome.json` in `assets/sp5b/`";
  - "`enterRatio` of pairs whose first is 10× slower is the median of the five kept (the first discarded)";
  - "the (a) and (b) URLs carry the same pose".
  - `worldQuery.test.ts`: "`db` without `enterBench=1` is ignored".
  - `bench.test.ts`: "the heavy save holds every column of the RD 15 disc, 64 entries each, 16 dense"; "the `auto=1` driver's URL sequence is setup → (a), (b) × 6 → end → result, the pose the same in (a) and (b), and its JSON has `measureChrome`'s keys" (a fake `sessionStorage` and navigator).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/measureChrome.test.ts test/unit/bench.test.ts test/unit/worldQuery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The spec's §6.2 enter row and the directory (Spec corrections 7, 8).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bench): ?bench=enter and measureChrome --route enter; browser files into assets/sp5b` (`git add src/main.ts src/ui/world/bench.ts src/ui/world/query.ts src/ui/world/worldPage.ts test/tools/measureChrome.ts test/unit/measureChrome.test.ts test/unit/bench.test.ts test/unit/worldQuery.test.ts docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 17: The early measurement: `G2.flush` and `G1.enter`

**STOP for the user before Step 1:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running. The controller asks and waits.

**Files:**
- Modify: the SP5b spec (`## Exit evidence`: "### The early measurement (Task 17)")

- [ ] **Step 1: Measure** (an agent; quiet machine; cold shader cache; touching no other process): `npm run measure:chrome -- --route bench --gpu iris --probe-only` (it prints the Iris renderer; a refusal means PRIME is not on-demand: back to the STOP), then `npm run measure:chrome -- --route bench --gpu iris` and `npm run measure:chrome -- --route enter --gpu iris`, each twice. After each run, move (`mv`) the written file from `docs/superpowers/specs/assets/sp5b/` to `.superpowers/sp5b/early-<route>-<n>.json` (never committed); then `git status --porcelain docs/superpowers/specs/assets` is empty.
- [ ] **Step 2: Read** the `persist` block against `G2.flush` (`over33Added` ≤ 1, `p95AddedMs` ≤ 4.17, `editVisibleAddedMs` ≤ 8.33, the "on" parts' `editVisibleP95` ≤ 50, `replyDuringFlushP95Ms` ≤ 5, `flushMainP95Ms` ≤ 0.3) and `enterRatio` against 1.10; record `flushSyncP95Ms`, `flushCommitP95Ms`, `idbOpenMs + loadMs` and L1-L10's cells against SP5a's file.
- [ ] **Step 3: Decide.** Both gates met in both runs: Task 18 is skipped (recorded). A miss: Task 18's levers for that gate, in order.
- [ ] **Step 4: Commit** `docs(sp5b): the early flush and entry measurement` (`git add docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 18: The levers (conditional)

Run only for a gate Task 17 measured as missed (each skip recorded in Task 17); each lever is one commit, measured (as Task 17 Step 1, the missed route only) before the next; stop at the first that meets the gate. **STOP before each measurement** under Task 17's conditions: the controller confirms them with the user again when the session was resumed or the display may have slept.

- [ ] **18a (`G2.flush`): the flush's encode split over several messages.** Files: `src/workers/simHandler.ts` (the flush encodes `FLUSH_SLICE` = 8 **(plan)** columns per slice, and each slice ends with a macrotask yield (`setTimeout(…, 0)` in the handler), so the worker's port and the in-process harness, which delivers each message from a `setTimeout`, `inProcessSim.ts:23-35`, deliver the messages queued meanwhile; a message arriving between slices is handled at once (`edits`, `diff`) or queued (`flush`, `backup`, as with one in flight); an edit to a column already encoded marks it dirty again; the batch is written once, after the last slice), `test/unit/simHandler.test.ts` ("an `edits` posted during a 64-column flush is answered before the flush's write; the write holds every column"). Commit `perf(workers): the flush's encode in slices, edits answered between them (D28 lever 1)`.
- [ ] **18b (`G2.flush`): the columns per flush capped.** `FLUSH_MAX_COLUMNS` = 32 **(plan)**; the rest stay dirty for the next tick; test "96 dirty columns: three flushes of 32". Commit `perf(workers): at most 32 columns per flush (D28 lever 2)`.
- [ ] **18c (`G2.flush`): the tick's snapshot reduced to what changed.** `src/ui/world/autosave.ts`: the canonical-JSON comparison replaced by per-part versions (pose, time, hotbar, places), the state rebuilt only when one moved; test "an unchanged tick builds nothing". Commit `perf(ui): autosave builds only the changed parts (D28 lever 3)`.
- [ ] **18d (`G1.enter`): decode each column at its first `diff` request.** `load` reads the range once (D19's single read kept) and keeps the bytes; `diff` decodes and remaps on first use; `loaded.entryCols` from the keys; tests "a column is decoded once, at its first `diff`"; "a corrupt column is skipped and counted at its first `diff`, its `diff` answers none". Commit `perf(workers): decode a saved column at its first diff request (D28 enter lever 1)`.
- [ ] **18e (`G1.enter`): the master's ring prefetch in place of D19's whole load.** `load` reads the keys only (**(plan)** a `keys` read request added to `kv.ts`: `{ op: 'keys'; store; range }` answering `Key[]` in key order, `getAllKeys` in IdbKV); `diff` reads and decodes the column on demand, becoming a deferred reply (still answered in arrival order); the spec's D19, §2.1 (the read requests) and §3.3, and master §4.13 reworded in this commit. Files: `src/persist/kv.ts`, `src/persist/memory.ts`, `src/persist/idb.ts`, `src/persist/kvContract.ts` (a `keys` case: a world range's keys in colKey order, another world's not), `test/unit/kv.test.ts`, `src/workers/simHandler.ts`, `test/unit/simHandler.test.ts` ("a `diff` of a saved column reads it once and answers after an `edits` posted before it"), the SP5b spec, the master; the selftest's `n` in `uiSmoke.ts` and its pin (`KV_CONTRACT.length` grows). Commit `perf(workers): saved diffs read on demand (D28 enter lever 2)`.
- [ ] **STOP:** a gate still missed after its levers: the controller reports every measurement to the user (D28); no gate is loosened; the user's own check decides.
- [ ] Each lever: `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`; the measurement recorded under Task 17's heading.

---

### Task 19: One tab per world

**Files:**
- Create: `src/ui/world/worldLock.ts`, `test/unit/worldLock.test.ts`
- Modify: `src/ui/world/worldPage.ts` (§3.4 step 1; teardown `:1536-1551`; `pagehide`, `pageshow`), `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts` (row)

**Interfaces:**
- `interface LockManagerLike { request<T>(name: string, o: { signal?: AbortSignal; ifAvailable?: boolean }, cb: (lock: unknown | null) => Promise<T> | T): Promise<T> }` (`navigator.locks` satisfies it; Node 24.21 has one, so unit tests also run the real one).
- `LOCK_WAIT_MS = 2000`; `lockName(id) = 'wi10.world.' + id` (D24).
- `holdWorld(locks: LockManagerLike, id: string, timeoutMs?: number): Promise<{ release(): void } | null>` (the page: `{signal: AbortSignal.timeout(2000)}`; an abort → null; the callback's promise held until `release`).
- `withWorldIfFree<T>(locks: LockManagerLike, id: string, write: () => Promise<T>): Promise<{ held: true } | { held: false; value: T }>` (the menu's Rename and Delete: `{ifAvailable: true}`, a null lock → held; the write inside the callback, the lock released after its promise settles, D24).
- The page: `holdWorld` first in `run()`; null → the menu with "This world is open in another tab" (Task 20 mounts it; until then the page's load fails with that text); the sim's `load` is posted only after the lock is held; `pagehide` posts the last save (Task 13's trigger) then releases; the teardown releases; `pageshow` with `persisted` → `location.reload()`.

- [ ] **Step 1: Write the tests** (`worldLock.test.ts`, `navigator.locks` and a fake): **Review Focus 2:** "the page's request with the previous holder releasing at 1,500 ms opens the world; one releasing at 2,500 ms gives `This world is open in another tab` and no `load` is posted";
  - "the menu's Rename with the lock held writes nothing and reports held";
  - "a Rename whose write is in flight when a page requests the lock: the page's callback runs only after the write's `complete`";
  - "two different worlds lock independently";
  - `worldPage.test.ts`: "`pagehide` posts the flush before `release`";
  - "`pageshow` with `persisted` reloads; without it nothing".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldLock.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `SP5B_MODULES` row for `worldLock.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): one tab per world through Web Locks (D24)` (`git add src/ui/world/worldLock.ts test/unit/worldLock.test.ts src/ui/world/worldPage.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts`).

---

### Task 20: Routes, the start screen and New world

**Files:**
- Create: `src/ui/worldsMenu.ts`, `test/unit/worldsMenu.test.ts` (with `startScreen.test.ts:12-29`'s cases moved)
- Delete: `src/ui/world/startScreen.ts`, `test/unit/startScreen.test.ts` (`git rm`)
- Modify: `src/main.ts` (`:32-59`), `src/ui/world/worldPage.ts` (Point 2's notice; `WorldPageOptions.unsavedNotice`; the "open in another tab" and "could not be opened" redirects), `src/ui/styles.css` (reuse `:85-102`'s classes; no new styling), `test/unit/worldPage.test.ts`, `test/unit/fixtures/domShim.ts` (what the menu needs), `test/tools/measureChrome.ts` (the enter route's new-world leg, Task 16's skip removed), `test/unit/measureChrome.test.ts`, `test/arch/masterSpec.test.ts` (row; pins), master §1's ui/world line and the `ui/shell.ts` entry's `worldsMenu.ts settingsPanel.ts (SP5b)`, §2.7's Session, §5.2's World

**Interfaces:**
- `startModeOf(query): 'start' | 'world'` (moved): 'world' iff `world`, `at`, `rd` or `workers` is in the query (§1.1).
- `mountWorldsMenu(root: HTMLElement, o: WorldsMenuOptions): { dispose(): void }`; `WorldsMenuOptions { saves: Saves | null; locks: LockManagerLike; random: () => Seed64; newId(): string; now(): number; navigate(url: string): void; persistStorage(): Promise<boolean>; enterUnsaved(hash: string, notice: string): void; loadManifest; rand; notice: string | null; settings(): void }` (`saves` null when storage cannot open, Task 29; `notice` the redirect's text). `enterUnsaved` mounts the unsaved world in place (`main.ts`'s `enter()`, `:46-58`, after the menu's dispose) with `WorldPageOptions.unsavedNotice?: string | null` set to its `notice`; the page shows `unsavedNotice`, when given, in place of Point 2's query-keyed text (an in-place enter has no `?at`/`?rd`/`?workers`, and a notice set on the menu dies with its dispose).
- `?enterBench=1&db=<name>` on `/` (Spec correction 7): the menu opens that database instead of `wi10`, and Create navigates to `/?world=<id>&enterBench=1&db=<name>`, so the enter route's new-world leg is written to and measured in `wi10-bench`. `measureChrome --route enter`'s new-world leg is implemented here: `/?enterBench=1&db=wi10-bench`, `#start-new` then `#new-create` clicked over CDP, `newWorldRevealMs` from the revealed page's `__wiEnterResult`.
- Start (D1): the title, buttons `#start-new` "New world", `#start-load` "Load world", `#start-settings` "Settings", links `#start-map` "Map" (`?map`) and `#start-selftest` "Selftest" (`?selftest=1`), a `#start-notice` row (`createNotices`); a `#` hash is ignored.
- New world (D2): `#new-name` (proposed `newWorldName`, a cleared name takes it at Create), `#new-preset` (`profileOptions()` order, `toolbar.ts:31-34`: default, large_biomes, archipelago, amplified, floating_islands), `#new-seed` (`seedToText(cryptoSeed())`), `#new-dice` (another one), `#new-create`, `#new-back`. Create: `resolveSeedText`, `loadParams` of the preset's resolved parameters, `paramsHash`/`genKey` hex, `stateTable: todayStateTable()`, `created: now()`, `backupOf: null`, `generatorVersion` 5; `saves.create(world, newState(id, STATE_BOUNDS))` (`STATE_BOUNDS` from `src/ui/world/stateBounds.ts`, Task 10); at the first create `navigator.storage.persist()` once **(plan)** (a `wi.persistAsked` localStorage flag); then `navigate('/?world=<id>')`. Names at most 64 characters.
- Point 2: the unsaved world (`?at`, `?rd`, `?workers` without `?world`) shows "This world is not saved: it was opened from a link. Use New world on the start screen to keep one." until dismissed; the bench, the flight, `?shot=1` captures and `?enterBench=1` loads do not **(plan)** (the enter route's unsaved (a) leg must differ from its saved (b) leg only in persistence, spec §6.2).
- The page's refusals (§3.4 steps 1-2) navigate to `/` with the notice carried as `?notice=<code>` **(plan)** (`locked` → "This world is open in another tab"; `unreadable` → "This world could not be opened: <reason>" from sessionStorage).

- [ ] **Step 1: Write the tests** (`worldsMenu.test.ts`, the DOM shim, MemoryKV): `startModeOf` with `world` and the moved cases; "the start screen shows the three buttons and the two links, and ignores a `#` hash";
  - "New world proposes `New world 2` when `New world 1` exists; a cleared name takes it at Create";
  - "the preset select lists the five ready profiles in code order";
  - "the dice changes the seed text; a typed seed `hello` resolves as `seedFromInput`";
  - "Create writes `worlds` and `state` in one write and navigates to `/?world=<id>`; `persistStorage` is called at the first create only";
  - "a 70-character name is cut to 64";
  - "Back returns to the start";
  - "Create under `?enterBench=1&db=x` writes to x and navigates to `/?world=<id>&enterBench=1&db=x`; `db` without `enterBench=1` is ignored".
  - `worldPage.test.ts`: "an unsaved `?at` world shows Point 2's notice; a saved world, the bench and an `?at=…&enterBench=1` load do not"; "an in-place unsaved world with `unsavedNotice` shows that text instead".
  - `measureChrome.test.ts`: "the enter route's new-world leg opens `/?enterBench=1&db=wi10-bench` and records `newWorldRevealMs`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldsMenu.test.ts test/unit/worldPage.test.ts test/unit/measureChrome.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1: the ui/world line's "the minimal start screen at `/`" → "the start and worlds menus at `/` (SP5b: `ui/worldsMenu.ts`)", the `ui/shell.ts` entry's `worldsMenu.ts settingsPanel.ts (SP5b)`; §2.7's Session: "last world" → "the open world is in the URL (`/?world=<id>`; SP5b)", and the URL rule "for the map and for unsaved worlds"; §5.2's World "worlds" → "(the start screen's menus, SP5b)"; each pinned; `SP5B_MODULES` row `[/^\s+ui\/shell\.ts /, 'worldsMenu.ts settingsPanel.ts (SP5b)', 'src/ui/worldsMenu.ts']`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the start screen and New world; links open an unsaved world with a notice` (`git add src/ui/worldsMenu.ts test/unit/worldsMenu.test.ts src/ui/world/startScreen.ts test/unit/startScreen.test.ts src/main.ts src/ui/world/worldPage.ts src/ui/styles.css test/unit/worldPage.test.ts test/unit/fixtures/domShim.ts test/tools/measureChrome.ts test/unit/measureChrome.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`; the two deletions staged by the `git rm`).

---

### Task 21: Load world: the list, Play, Rename, Delete

**Files:**
- Modify: `src/ui/worldsMenu.ts`, `test/unit/worldsMenu.test.ts`

**Interfaces** (D3; **(plan)** ids): `#load-list` with one `.world-row[data-id]` per `saves.list()` row: "name · preset · seed N", "Modified YYYY-MM-DD HH:MM" (local time, from `updated`), "· n places" when n > 0 (the cut line's item), "automatic copy" when `backupOf` is set, "older generator" and "opens with today's terrain; your blocks stay at their coordinates" when `olderGenerator` (Task 4's function; Task 23 wires it into the rows, until then never shown); buttons `.world-play`, `.world-rename`, `.world-export` (Task 22), `.world-delete`; `#load-import` and `#load-back` below; "No saved worlds yet." when empty; a broken row (D14) shows "This world could not be opened: <reason>" with Delete only.
- Play → `navigate('/?world=<id>')`. Rename: the name becomes a text field (Enter keeps, Esc cancels), written through `withWorldIfFree`; held → "This world is open in another tab". Delete: `notices.confirm("Delete 'name'? This cannot be undone.", 'Delete')`, then `withWorldIfFree` → `saves.remove`; held → the same notice. The list is read again on `visibilitychange` to visible (§1.1). The list's time is recorded on `window.__wiMenuListMs` **(plan)** for the smoke's `menus` step.

- [ ] **Step 1: Write the tests:** "rows newest first, each with its text; a backup row says `automatic copy`; a world with 3 places `· 3 places`";
  - "the empty list says `No saved worlds yet.`";
  - "Rename: Enter keeps (the record renamed), Esc cancels (nothing written)";
  - "Rename and Delete of a world whose lock is held are refused with `This world is open in another tab` and write nothing";
  - "Delete asks in the notice row; Cancel writes nothing; Delete removes every key";
  - "a hidden → visible switch reads the list again";
  - "no `confirm(` anywhere" (the arch's uiDialogs rule covers it).
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldsMenu.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Load world: the list, Play, Rename and Delete under the world's lock` (`git add src/ui/worldsMenu.ts test/unit/worldsMenu.test.ts`).

---

### Task 22: `.wiworld`: `persist/wiworld.ts`, Export and Import

**Files:**
- Create: `src/persist/wiworld.ts`, `test/unit/wiworld.test.ts`
- Modify: `src/ui/common/files.ts` (`downloadBlob`, `readBinaryFile` beside `downloadText` `:10`), `src/ui/worldsMenu.ts` (Export, Import), `test/unit/worldsMenu.test.ts`, `test/arch/masterSpec.test.ts` (rows; the `.wiworld` pin), master §2.7's `.wiworld` header, the `ui/common/*` entry's `files.ts (SP5b: downloadBlob, readBinaryFile)`

**Interfaces:**
- `WIWORLD_VERSION = 1`; `writeWiworld(d: WorldDump): Promise<Blob>` (§2.4): a gzip `CompressionStream` over `"WI10"`, `u32 version`, `u32 headerLen`, the header as UTF-8 `canonicalJSON` (`{format: 'wi10-world', world: <the record without id>, state: <the state without worldId>, history}`), then per edited column by colKey `i32 cx, i32 cz, u32 len, bytes` (the stored bytes, not decoded).
- `readWiworld(b: Blob | Uint8Array, bounds: StateBounds, newId: string, now: number): Promise<{ ok: true; dump: WorldDump; skippedColumns: number; unknownStates: number } | { ok: false; reason: 'Not a .wiworld file' | 'Made by a newer version of world-imaginer-voxel' | 'The file is damaged' }>`: the magic, the version (newer refused), the `format`; the params through `loadParams`; `normalizeState`, `normalizeHistory` (remapped); each record's framing (a record past the end refuses the file); each record decoded against the header's table (a failure skipped and counted); remapped (`remapOf`); re-encoded under today's ids, each keeping its decoded header genKey (D21: the genKey when the column was written; so the bytes are unchanged when the header's table is today's, and D15's "the exported one in every saved part" holds); `stateTable` today's; the record's genKey kept (an older one follows D8 at its open); `id` new, `name` the header's.
- `wiworldHash(d: WorldDump): string` (E2): `hex64(fnv1a64(…))` over the header's canonical JSON with `id`, `worldId` and `updated` removed, then every record by colKey, decoded and re-encoded under today's ids with that record's decoded genKey.
- Menu: Export → `saves.readAll(id)` (one read) → `writeWiworld` → `downloadBlob(exportFileName(name), blob)`; it works while another tab holds the world (D7). Import → `#load-import-file` picker → `readBinaryFile` → `readWiworld` → `saves.writeAll` (one write) → "Imported 'name'"; any refusal writes nothing and shows its reason; skipped columns add "n columns of this world could not be read".

- [ ] **Step 1: Write the tests** (`wiworld.test.ts`, MemoryKV, Node's `CompressionStream`): "export → import of a world with edits, places, history, a walking player and `amplified`: every saved part equal except `id` and `updated`, and `wiworldHash` equal";
  - "the gzip bytes are never hashed: the hash of a re-compressed file is equal";
  - "a world with a column flushed before an Apply (its header the earlier genKey) and one after: export → import keeps each column's bytes and header genKey, and `wiworldHash` is equal";
  - "bad magic → `Not a .wiworld file`; `version` 2 → `Made by a newer version of world-imaginer-voxel`; a truncated record → `The file is damaged`; each writes nothing";
  - "a record that fails to decode is skipped and counted; the rest import"; each `state` and `history` field §2.1 normalises arrives normalised; **Review Focus 3:** "a file whose header's `stateTable` is today's 58 keys permuted and cut to 55 plus one unknown key `nope[x=1]`, with a stored genKey of another generator: imports with every voxel equal by state key, the unknown key's 3 voxels air and `3 blocks of unknown types became air`, the imported record's `stateTable` equal to today's, its records re-encoded under today's ids, and, with `p = loadParams(dump.world)` ok, `olderGenerator(dump.world, p.value)` true (Task 4; the list's badge is Task 23's); a file whose `version` is 2 is refused with nothing written".
  - `worldsMenu.test.ts`: "Export names the file `exportFileName`; Import adds the world with `Imported 'name'`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/wiworld.test.ts test/unit/worldsMenu.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §2.7's `.wiworld` header as spec §2.4, pinned; `SP5B_MODULES` rows for `wiworld.ts` and `files.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(persist): .wiworld export and import (D15, D23)` (`git add src/persist/wiworld.ts test/unit/wiworld.test.ts src/ui/common/files.ts src/ui/worldsMenu.ts test/unit/worldsMenu.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 23: An older generator

**Files:**
- Modify: `src/ui/world/worldPage.ts` (§3.4 step 4, after `firstReady` `:1636`), `src/ui/worldsMenu.ts` (the badge), `test/unit/worldPage.test.ts`, `test/unit/worldsMenu.test.ts`, `test/arch/masterSpec.test.ts`, master §2.7 ("A save is valid only for its genKey."), §6.2 (Dev saves), §8 risk 13, §9 (save binding)

**Interfaces:**
- `OLDER_GENERATOR_NOTICE = 'This world was made with an earlier generator version; it opens with today\'s terrain and your blocks stay at their coordinates.'`, shown 8,000 ms (D8).
- The page: `firstReady.genKey` (`ReadyMsg.genKey`, already 16 hex digits, `protocol.ts:162`) ≠ the kept record's `genKey` → the notice, and `simClient.record({ ...world, genKey, generatorVersion: GENERATOR_VERSION, paramsHash })` (today's), counted as a change for the next tick (autosave's `markChanged`); the page's kept record becomes the one sent in `record`, so a later backup copies today's genKey (Spec correction 11). Entries load and apply under any generator (D21): no copy, no dialog. The list's badge: `const p = loadParams(world); p.ok && olderGenerator(world, p.value)` (Task 4); a refused `loadParams` shows the row as broken with its reason (Delete only).

- [ ] **Step 1: Write the tests:** `worldPage.test.ts`: "a stored genKey ≠ today's → the notice once (8 s), one `record` with today's genKey and version, posted with the next tick; no `backup`"; "equal → no notice, no `record`"; "after an older-generator open, the page's kept record carries today's genKey" (Task 25 checks a backup built from it). `worldsMenu.test.ts`: "the badge shows on that world until its open's `record` is written, then not (D8)"; "an imported older-generator file's row shows `older generator`"; "a record whose `loadParams` is refused shows a broken row". E6's `olderGeneratorWrong` (Task 30) runs it on the real stack.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldPage.test.ts test/unit/worldsMenu.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The master as spec §9: §2.7 "A world whose stored genKey differs from today's opens with today's terrain, its edits at their coordinates, with a notice and an 'older generator' badge in the list (SP5b)."; §6.2 "Dev saves whose genKey no longer matches open with today's terrain and a notice (§2.7, SP5b)"; risk 13 "Save and golden churn during development: an older generator opens with today's terrain (§2.7, SP5b)"; §9's save binding "(SP5b: a mismatch opens with today's terrain and a notice)"; each pinned.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): a world from an older generator opens with today's terrain and a notice (D8)` (`git add src/ui/world/worldPage.ts src/ui/worldsMenu.ts test/unit/worldPage.test.ts test/unit/worldsMenu.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 24: The modification mode: `setWritable` and the switch

**Files:**
- Create: `src/ui/world/modifyMode.ts`, `test/unit/modifyMode.test.ts`
- Modify: `src/engine/session.ts` (`:205-294`), `src/ui/map/toolbar.ts` (`:172-173`, the seed, preset and biome-size controls), `src/ui/paramPanel/controls.ts:178`, `src/ui/paramPanel/panel.ts:101`, `src/ui/biomeTable/table.ts:356`, `:429`, `src/ui/splineEditor/drawer.ts:490`, `:557`, `src/ui/inspector/densityTab.ts` (the form's inputs; the tree and slices stay live), `src/ui/presets/presetsTab.ts:169-170` (import and the JSON box; Export stays), `src/ui/map/mapTool.ts` (`setEditable`), `src/ui/world/mapOverlay.ts` (`:273-296`: `#map-modify` before "Watch live"), `src/ui/world/worldPage.ts`, `test/unit/session.test.ts`, `test/unit/toolbar.test.ts`, `test/unit/mapOverlay.test.ts`, `test/unit/paramPanel.test.ts`, `test/unit/densityTab.test.ts`, `test/unit/worldPage.test.ts`, `test/unit/fixtures/domShim.ts`, `test/arch/masterSpec.test.ts` (rows; the §2.7 pin)
- Create: `test/unit/biomeTableDom.test.ts`, `test/unit/splineDrawer.test.ts`, `test/unit/presetsTab.test.ts`, master §2.7's Fork dialog paragraph, §1's `session.ts` token

**Interfaces:**
- `WorldSession.setWritable(on: boolean): void` and `readonly writable: boolean` (D25): `setWritable(false)` first ends an open gesture; while off, `setSeedText`, `newSeed`, `setProfile`, `set`, `reset`, `undo`, `redo` and `load` change nothing and notify nothing, **(plan)** answering as an unchanged success (the current `SessionState`; `{ ok: true, state }`; `undo`/`redo` false), so no caller shows an error notice (D10); `beginGesture`, `endGesture`, `subscribe` work; `load(s, { force: true })` passes (the backup's revert, Task 25).
- `MapTool.setEditable(on: boolean): void` calls each editor's `setEditable(on)` (each sets its own controls' `disabled`, keeping its other reasons: a control disabled for a rule stays disabled when the mode turns on).
- `createModifyMode(o: { session: WorldSession; tool: () => Pick<MapTool, 'setEditable'> | null; checkbox: HTMLInputElement }): ModifyMode`; `ModifyMode { readonly on: boolean; set(on: boolean): void; readonly sessionCount: number; dispose(): void }` (`sessionCount` bumps at each switch-on: Task 25's latch). A saved world's session is set not writable once built; the checkbox `#map-modify` "Modify terrain" exists only in a saved world (D10; unsaved worlds and `?map` never call `setWritable`). Ctrl+Z / Ctrl+Y with the map owning reach `session.undo/redo` (`worldPage.ts:794-809`) and do nothing while off.

- [ ] **Step 1: Write the tests:** `session.test.ts`: "`setWritable(false)` refuses every mutator: state, epoch and history unchanged, no listener called";
  - "it ends an open gesture first (`inGesture` false, one `gestureEnd`)";
  - "`load(…, {force: true})` passes while off";
  - "on again, every mutator works".
  - `toolbar.test.ts`: "`setEditable(false)` disables the seed, Same seed, New seed, the preset, the biome size, Undo and Redo; the layer, grid and cut-line controls stay enabled".
  - `mapOverlay.test.ts`: "the header slot holds `#map-modify` before Watch live in a saved world, none in an unsaved one".
  - `modifyMode.test.ts`: "off at the open; on → writable and every editor editable; off → not writable, a drag in progress ended, an edit already made still applies (its kept configure is not dropped)";
  - "Ctrl+Z with the map owning does nothing while off".
  - `paramPanel.test.ts`: "`setEditable(false)` disables every value input and section Reset; a control a rule disables stays disabled after `setEditable(true)`"; `densityTab.test.ts`: "the form's inputs disabled, the tree, the selection and the slices still work"; **(plan)** each of `biomeTable/table.ts`, `splineEditor/drawer.ts` and `presets/presetsTab.ts` gets a DOM-shim test of its own `setEditable` in new files `test/unit/biomeTableDom.test.ts`, `test/unit/splineDrawer.test.ts` and `test/unit/presetsTab.test.ts` (its controls disabled; Presets' Export enabled; a control disabled for a rule stays disabled after `setEditable(true)`; `domShim.ts` extended as they need): the real `createMapTool` cannot mount in Node (its map view calls `canvas.getContext('2d')`, `mapView.ts:91`, which the shim lacks; `mapOverlay.test.ts:38` injects a fake tool), and `createModifyMode` takes only `Pick<MapTool, 'setEditable'>`, so `modifyMode.test.ts` checks only that `set(on)` calls `tool().setEditable(on)`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/session.test.ts test/unit/toolbar.test.ts test/unit/mapOverlay.test.ts test/unit/modifyMode.test.ts test/unit/paramPanel.test.ts test/unit/densityTab.test.ts test/unit/biomeTableDom.test.ts test/unit/splineDrawer.test.ts test/unit/presetsTab.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §2.7's Fork dialog paragraph, its four options and "During development…" replaced by spec §9's "**World-modification mode and backup (SP5b).** …" (pinned; `not.toContain('During development this dialog is expected often')`); §1's engine entry gains `(SP5b: session.ts's setWritable)`; `SP5B_MODULES` rows for `modifyMode.ts` and `session.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the world-modification mode gates every terrain edit in the session (D10, D25)` (`git add src/ui/world/modifyMode.ts test/unit/modifyMode.test.ts src/engine/session.ts src/ui/map/toolbar.ts src/ui/paramPanel/controls.ts src/ui/paramPanel/panel.ts src/ui/biomeTable/table.ts src/ui/splineEditor/drawer.ts src/ui/inspector/densityTab.ts src/ui/presets/presetsTab.ts src/ui/map/mapTool.ts src/ui/world/mapOverlay.ts src/ui/world/worldPage.ts test/unit/session.test.ts test/unit/toolbar.test.ts test/unit/mapOverlay.test.ts test/unit/paramPanel.test.ts test/unit/densityTab.test.ts test/unit/biomeTableDom.test.ts test/unit/splineDrawer.test.ts test/unit/presetsTab.test.ts test/unit/fixtures/domShim.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 25: The automatic backup

**Files:**
- Modify: `src/workers/protocol.ts` (`BackupMsg`, `BackedUpMsg`), `src/workers/simHandler.ts`, `src/engine/simClient.ts`, `src/ui/world/modifyMode.ts`, `src/ui/world/applyControl.ts` (`:11`, `:65` comments), `src/ui/world/worldPage.ts` (`beforeApply` `:2319-2320`, `onApplied` `:2321-2327`), `test/unit/simHandler.test.ts`, `test/unit/simClient.test.ts`, `test/unit/protocol.test.ts`, `test/unit/applyControl.test.ts` (`:113-116`, `:276-293`), `test/unit/modifyMode.test.ts`

**Interfaces:**
- `BackupMsg { type: 'backup'; id: number; newWorld: WorldRecord; newId: string; state: StateRecord; history: HistoryRecord }` (always the full history, autosave's `build`: the sim holds none of its own; it writes it into the copy and, as the pending flush's history, into the original; the guard refuses a null `history`); `BackedUpMsg { type: 'backedUp'; id: number; ok: boolean; error: string | null }` (**(plan)** `error` the KV's `errorName`, or `'closed'` for a closed connection; null when ok). The sim, in one `write`: the pending flush (its dirty columns, with `backup`'s state and history), then `copyOps` under `newId` (every column encoded from the DiffStore, D19; `newWorld` with `backupOf` the original's id, its state with `updated` = the original's last committed `updated` **(plan)**, which starts as `load`'s `updated` (Spec correction 12) and follows each committed state). A `backup` arriving while a flush is in flight waits, queued like a flush (its state and history replace a queued flush's, which it absorbs), and runs when the in-flight write settles, with `flushSeq` = last committed + 1 then (Task 9's one-in-flight rule). On `abort`/`closed` the flush part merges back as Task 9's. `SimClient.backup(…): Promise<BackedUpMsg>` (a pending one rejects `SimFailed` as `flush`'s does).
- `modifyMode.beforeApply(from: WorldStage | null): boolean` (D26), its rules in this order: while a backup is in flight, every 'T'/'D' returns false, the mode off included (a second one waits for the first to settle; a change held meanwhile supersedes the held draft, since the apply control keeps only the latest configure, `applyControl.ts:95-98`, and after `backedUp` the combined draft applies with that one copy); then `from` 'T' or 'D', the mode on, the latch clear and `sim.hasAnyEntries()` (the client's entry set not empty; `SimClient.hasAnyEntries(): boolean` added in this task beside `hasEntries`, `simClient.ts:46`) → post `backup` with the page's kept record (Task 10's, updated at a rewrite's open, the older-generator open's `record`, Task 23, and in `onApplied`: Spec correction 11), the state and history built now (autosave's `build`), `newId()`, `backupName(name, names)`; set the latch; return false until `backedUp`; otherwise (`from` null, 'L' or 'MESH', the mode off, or no entries) → true (a change without entries leaves the latch clear). On `ok`: true from then on for that change, and "Backup saved as 'name'" (6,000 ms). On failure: `session.load(applied, { force: true })`, `applied` **(plan)** the `SessionSnapshot` the page keeps beside the kept record, set at the open and in each `onApplied`, "Could not save a backup copy (<reason>): the terrain change was cancelled" (`<reason>` "storage full" for `QuotaExceededError`). The latch clears at each switch-on (`sessionCount`). `onApplied`: the kept record becomes the new seed, preset, params, `paramsHash` and genKey, sent with `sim.record`; autosave `markChanged()`.

- [ ] **Step 1: Write the tests:** `applyControl.test.ts`: "`beforeApply` returning false holds the draft and retries each tick until true; then it applies once" (the SP5a tests' always-true stays). `simHandler.test.ts`: "a backup writes the pending flush and the copy in one write: the copy's diff keys, record (with `backupOf`) and state equal the original's";
  - "an aborted backup merges the flush back";
  - "a backup posted during an in-flight flush writes after it, with `flushSeq` + 2";
  - "the copy's `state.updated` is `load`'s `updated` before any committed flush, then the last committed one's".
  - `protocol.test.ts`: `backup` with a null `history` refused. `simClient.test.ts`: "a pending `backup` rejects `SimFailed` when the sim fails"; "`hasAnyEntries()` is false on an empty set, true after a `loaded` or an `entryAdded`, false again after the last `entryRemoved`".
  - `modifyMode.test.ts`: "a 'T' change with entries posts one backup and holds until `backedUp`";
  - "after an older-generator open, the backup's `newWorld` carries today's genKey (the kept record)";
  - "no entries → no backup and the latch stays clear; a later change after building makes the copy (Point 1)";
  - "'L', 'MESH' and `null` never copy";
  - "a second change in the same mode session makes none; off then on makes one more";
  - "a revert to the applied draft while the copy is written adopts at once, and the copy, once committed, is kept and spends the latch (D11)";
  - "a failed copy reloads the applied snapshot with `force` and shows the failure";
  - **Review Focus 4:** "mode on; change 1 ('T') held, its backup's write settling at 500 ms; at 100 ms the mode off (the open gesture ended), at 200 ms on again; change 1 applies only after its `backedUp`; at 800 ms, after that apply, change 2 ('D') posts a second copy `My world (before the change 2)` holding change 1's parameters; exactly two copies, and the world ends with change 2's parameters";
  - "a change made while a copy is held supersedes the held draft; after `backedUp` the combined draft applies with that one copy".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/applyControl.test.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts test/unit/protocol.test.ts test/unit/modifyMode.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The comments at `applyControl.ts:11`, `:65` and `worldPage.ts:2319` reworded as built.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 5: Commit** `feat(ui): the first terrain change per mode session keeps a backup copy (D11, D26)` (`git add src/workers/protocol.ts src/workers/simHandler.ts src/engine/simClient.ts src/ui/world/modifyMode.ts src/ui/world/applyControl.ts src/ui/world/worldPage.ts test/unit/simHandler.test.ts test/unit/simClient.test.ts test/unit/protocol.test.ts test/unit/applyControl.test.ts test/unit/modifyMode.test.ts`).

---

### Task 26: Saved places: the model, B and its dialog; B and G in the key map

**Files:**
- Create: `src/ui/world/places.ts`, `src/ui/world/placeDialog.ts`, `test/unit/places.test.ts`, `test/unit/placeDialog.test.ts`
- Modify: `src/player/keymap.ts` (`Action`; `DEFAULT_KEYMAP` `:45-73`), `src/ui/loading/tips.ts` (`:15-28`), `src/ui/world/worldPage.ts` (`onAction` `:2473-2511`; the pause `:2650`; `closeOverlays` `:817-826`), `test/unit/keymap.test.ts` (`:32`, `:36-37`, `:61`), `test/unit/tips.test.ts` (`:14`), `test/unit/help.test.ts:46`, `test/arch/masterSpec.test.ts` (rows; §5.9 pin), master §5.9, the SP5b spec (Spec correction 2's count pins)

**Interfaces:**
- `PLACE_COLOURS = ['#e5534b', '#e0a030', '#e8d44d', '#57ab5a', '#4aa3df', '#986ee2', '#e275ad', '#dddddd'] as const` (red, orange, yellow, green, blue, purple, pink, light grey; D12); `proposedPlaceName(count: number, x: number, y: number, z: number): string` = `Place ${count + 1} (${⌊x⌋}, ${⌊y⌋}, ${⌊z⌋})`; `createPlaces(initial: readonly Place[], newId: () => string): Places`; `Places { readonly list: readonly Place[]; add(p: Omit<Place, 'id'>): Place | 'full'; edit(id: string, name: string, colour: number): void; remove(id: string): Place | null; subscribe(f: () => void): () => void }` (256 cap: "A world holds at most 256 places"; names trimmed and cut to 64; an empty name keeps the proposal). **(plan)** At 256 places, B and "+ Add at the pin" show "A world holds at most 256 places" (4,000 ms) and open no dialog..
- `mountPlaceDialog(host, o: { requestLock(): void; onClose(): void }): PlaceDialog`; `PlaceDialog { open(proposed: string, save: (name: string, colour: number) => void): void; close(): void; readonly isOpen: boolean; dispose(): void }`: the palette's modal pattern (`palette.ts:151-193`: release the lock, its own Esc consumed, the lock requested on close) plus Enter = Save; `#place-name` (selected), `.place-swatch` × 8 (the first selected), `#place-save`, `#place-cancel`.
- Key map: `savePlace` (`KeyB`, "Save this place", group 'world', since 'SP5b'), `settings` (`KeyG`, "Settings", group 'view', since 'SP5b'); the help's label (`keymap.ts:56`) "Help". B with the world owning and no panel open: the dialog with the camera's exact pose (x, y, z, yaw, pitch), "Place saved" (1,500 ms) on save; B and G go through `paletteFirst` like M and H (`worldPage.ts:1171-1174`, spec §1.4): with the palette open it closes and the action runs; B does nothing while the help, the settings or the place dialog is open. The world pauses while the dialog is open and the dialog joins `closeOverlays`. Tips: a template names `{savePlace}`; the settings tip (`tips.ts:21`) becomes "The world loads around you as you fly; change the render distance in Settings ({settings})." and a template names `{settings}`.

- [ ] **Step 1: Write the tests:** `places.test.ts`: "`proposedPlaceName(3, 312.7, 88.2, -1540.1)` is `Place 4 (312, 88, -1541)`";
  - "the 257th add answers 'full'";
  - "edit cuts a 70-character name to 64";
  - "remove returns the place".
  - `placeDialog.test.ts`: "Enter saves the typed name and the chosen colour; Esc closes without saving and is consumed; the name field is selected; red is preselected".
  - `keymap.test.ts`: the action count 29 (`:32`), `since` SP5b for `savePlace` and `settings` (`:36-37`), the bindings `code:KeyB` and `code:KeyG`, no binding shared. `tips.test.ts`: count 29 (`:14`), `{savePlace}` and `{settings}` named. `help.test.ts:46`: both rows in Keys. `worldPage.test.ts`: "B with the palette open closes it and opens the dialog; with the help open B does nothing; with nothing open it opens the dialog and pauses the world"; "B with 256 places shows `A world holds at most 256 places` and no dialog".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/places.test.ts test/unit/placeDialog.test.ts test/unit/keymap.test.ts test/unit/tips.test.ts test/unit/help.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The page keeps `places` in the autosave's state (`markChanged` on each change). Master §5.9: "G (graphics)" → "G (settings; SP5b)" and "B (save a place; SP5b)" added, pinned; `SP5B_MODULES` rows for `places.ts` and `placeDialog.ts`; the spec's §6.3 pins (Spec correction 2).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): B saves a place with a name and a colour; B and G in the key map (D12)` (`git add src/ui/world/places.ts src/ui/world/placeDialog.ts test/unit/places.test.ts test/unit/placeDialog.test.ts src/player/keymap.ts src/ui/loading/tips.ts src/ui/world/worldPage.ts test/unit/keymap.test.ts test/unit/tips.test.ts test/unit/help.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 27: Places on the map: dots and the Places tab

**Files:**
- Create: `src/ui/map/placesTab.ts`, `test/unit/placesTab.test.ts`
- Modify: `src/ui/map/mapView.ts` (`MapCanvas.setPlaces`; `drawOverlays` `:185-285` calls `drawPlaceDots` before the arrow), `src/ui/map/viewMath.ts` (`drawPlaceDots`), `src/ui/map/layout.ts` (`TabId` `:16-18` gains `'places'`; `createLayout` with the tabs shown; `parseLayout` `:83-100` ignores an id the layout does not show), `src/ui/map/mapTool.ts` (`MapToolDeps.places`; the pin exposed: `pin()` and `onPin`, `:157`, `:188`), `src/ui/world/mapOverlay.ts` (`onTeleport`'s close, `:400-417`), `src/ui/world/teleport.ts` (`toPlace`), `src/ui/world/worldPage.ts`, `test/unit/layout.test.ts` (`:26`), `test/unit/mapArrow.test.ts`, `test/unit/teleport.test.ts`, `test/arch/masterSpec.test.ts` (row; `:957`'s §5.6 pin moved), master §5.6 and §1's `ui/map/*` entry, the SP5b spec (Spec correction 13)

**Interfaces:**
- `drawPlaceDots(ctx: Pick<CanvasRenderingContext2D, 'beginPath' | 'arc' | 'fill' | 'stroke' | 'fillStyle' | 'strokeStyle' | 'lineWidth'>, view: MapView, w: number, h: number, list: readonly { x: number; z: number; colour: number }[], colours: readonly string[]): void` **(plan)** (`colours` is `PLACE_COLOURS`, passed in by the page so `ui/map/` does not import `ui/world/`), pure and exported from `viewMath.ts` (the real `createMapCanvas` cannot run in Node: `getContext('2d')`, `requestAnimationFrame`, `ResizeObserver`, `mapView.ts:88-92`, `:304`, `:318`): one filled arc in `PLACE_COLOURS[c]` and one white-rim stroke per place, places off the view skipped. `MapCanvas.setPlaces(list, colours): void` stores both and calls `schedule()`; `drawOverlays` calls `drawPlaceDots` before `drawArrow`.
- `TAB_IDS` stays the four for `?map` **(plan)**: `createLayout(…, { tabs: readonly TabId[] })` and a `layoutTabs(places: boolean)` helper; `parseLayout(text, shown: readonly TabId[])` takes the default tab for a stored id not shown (tested on `?map` with a stored `'places'`).
- `MapTool` gains `pin(): readonly [number, number] | null` and `onPin(f: (p: readonly [number, number] | null) => void): () => void`, fired at `mapTool.ts:188`'s `case 'pin'` (nothing tells a mounted tab of a Shift+click otherwise).
- `mountPlacesTab(host, o: { places: Places; teleport(p: Place): void; pin: { get(): readonly [number, number] | null; subscribe(f: (p: readonly [number, number] | null) => void): () => void }; addAt(x: number, z: number): void; notices }): { dispose(): void }` (the tab unsubscribes in `dispose`): the places in saved order, each "● name", ↗ (teleport), ✎ (the name and the 8 colours inline, Save/Cancel), 🗑 (deletes at once, "Deleted 'name'"); "+ Add at the pin" enabled once a pin is set (read at mount and on each `subscribe` call), opening the B dialog for the pin's column on its ground (`pool.landing`, `teleport.ts:100`), looking where the camera looks; **(plan)** a landing that fails (the teleport's `onFail` path, `teleport.ts:100-104`) opens no dialog and shows the teleport's failure notice.
- `toPlace(p: Place)` (§3.7): x, y, z, yaw, pitch set, velocity 0; walking, `setFeet(walk, x, y − EYE, z)` (`src/player/walk.ts:109`; never `walk.arrive`/`arriveFeet`, whose snap, `walk.ts:125-128`, `:170-177`, would move the feet to the column's motionBlocking top: Spec correction 13), then SP5a D29's unstuck lifts out of a block that is now there; over an unloaded column the walk's unloaded rule hovers (SP5a D15); a full-screen map closes as `onTeleport` does. A plain map click still teleports (SP4c).

- [ ] **Step 1: Write the tests:** `placesTab.test.ts`: "lists in saved order; ↗ teleports with the exact pose; ✎ edits name and colour; 🗑 deletes with `Deleted 'name'`; `+ Add at the pin` disabled until a pin is set; a failed landing opens no dialog"; "the pin callback (a Shift+click) enables `+ Add at the pin` on the mounted tab; `dispose` unsubscribes".
  - `layout.test.ts`: "`TAB_IDS` keeps the four (`:26`); a world layout with places shows five; `parseLayout` of a stored `'places'` on `?map` gives the World tab".
  - `mapArrow.test.ts`: "`drawPlaceDots` draws one filled arc in `PLACE_COLOURS[c]` and one white stroke per place in view, and skips a place off the view" (a recording 2D context). `teleport.test.ts`: "`toPlace` flying sets the exact pose; walking puts the feet at y − 1.62 and lifts out of a block now there"; "walking `toPlace` under a roof: after one `walkTick` over the Published column the feet stay at y − 1.62".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/placesTab.test.ts test/unit/layout.test.ts test/unit/mapArrow.test.ts test/unit/teleport.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §5.6: the saved-places phrase becomes "saved places per saved world (SP5b: a section of each saved world's map, one map per saved world; coloured dots; a Places tab; B in the world and '+ Add at the pin' on the map)" **(plan)** (`:957`'s pin moved and rewritten, Spec correction 2); master §1's `ui/map/*` entry gains `placesTab.ts (SP5b)`, pinned through the `SP5B_MODULES` row `[/^\s+ui\/map\/\* /, 'placesTab.ts (SP5b)', 'src/ui/map/placesTab.ts']`; the spec's §3.7 (Spec correction 13).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (the smoke's `tabs` step still ends on Presets on `?map`).
- [ ] **Step 5: Commit** `feat(ui): places as dots on the map and a Places tab in a saved world (D13)` (`git add src/ui/map/placesTab.ts test/unit/placesTab.test.ts src/ui/map/mapView.ts src/ui/map/viewMath.ts src/ui/map/layout.ts src/ui/map/mapTool.ts src/ui/world/mapOverlay.ts src/ui/world/teleport.ts src/ui/world/worldPage.ts test/unit/layout.test.ts test/unit/mapArrow.test.ts test/unit/teleport.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 28: The Settings screen; the help's Settings (G) and Worlds menu buttons

**Files:**
- Create: `src/ui/settingsPanel.ts`, `test/unit/settingsPanel.test.ts` (with `help.test.ts:125-211`'s cases moved)
- Modify: `src/ui/help.ts` (the Settings section `:146-194` out; `:2-3`; "Settings (G)" and "Worlds menu" beside "Map (M)", `:210-222`), `src/ui/settings.ts:3`, `src/ui/worldsMenu.ts` (`#start-settings`), `src/ui/world/worldPage.ts` (G; `applySettings` `:2402-2414`; `rdControl`'s `setRd`, `:2460-2465`; the pause; `closeOverlays`; the Worlds menu's save-then-navigate), `test/unit/help.test.ts`, `test/unit/worldsMenu.test.ts`, `test/unit/worldPage.test.ts`, `test/arch/masterSpec.test.ts` (row; `:1202`'s pin moved), master §1's settings-block line, §4.16, §5.2's Settings

**Interfaces:**
- `mountSettingsPanel(host, o: { settings: WorldSettings; onSettings(s: WorldSettings): void; rdMax: number | null; defaultRd: number | null; onClose(): void }): SettingsPanel`; `SettingsPanel { open(): void; close(): void; readonly isOpen: boolean; setRd(rd: number | null): void; dispose(): void }`. Tabs `#settings-tab-graphics`, `#settings-tab-controls`; rows `#setting-rd` (Default, 4 … `rdMax` in the world, 4 … 16 and "Default" with no number from the start screen), `#setting-fps-cap` (Off, 30, 60, 120, 144), `#setting-fov` (50-100), `#setting-brightness` (0-1), `#setting-sensitivity` (0.1-5), `#setting-hold-repeat`; greyed below Graphics: disabled rows "Fog distance · Clouds · Shadows · Quality preset (Low…Ultra) — coming in SP11" with no setting behind them. Changes apply at once and are kept in `wi.world.settings` (`settings.ts:25`); `WorldSettings`/`normalizeSettings` are the settings schema. Esc closes (consumed).
- In the world: G opens it (through `paletteFirst`), the help's "Settings (G)" too; it pauses the world (joining `help.isOpen || palette.isOpen`) and joins `closeOverlays`; while it, the help, the palette or the B dialog is open the world handles no keys (a focused select, slider or button keeps its own: SP4a spec :731's `isTextEntry` hand-over). The help keeps Keys, System, "Map (M)", "Settings (G)", "Worlds menu" (D31: autosave's `beforeLeave(1000)`, then `/`; only in a saved world **(plan)**; an unsaved world's goes to `/` at once) and "Fullscreen".

- [ ] **Step 1: Write the tests:** `settingsPanel.test.ts`: the moved row tests (ids, ranges, `onSettings` with the whole settings, `setRd` without `onSettings`); "the greyed rows are disabled and change nothing";
  - "from the start screen the RD's first option is `Default` and the last 16";
  - "Esc closes and is consumed".
  - `help.test.ts`: "no Settings section; the buttons read `Map (M)`, `Settings (G)`, `Worlds menu`, `Fullscreen`".
  - `worldsMenu.test.ts`: "`#start-settings` opens the panel over the start screen".
  - `worldPage.test.ts`: "G opens the panel and pauses the world; a slider focused in it gets the arrow keys (the world handles none)";
  - "Worlds menu saves, then navigates to `/`, after `flushed` or 1,000 ms".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/settingsPanel.test.ts test/unit/help.test.ts test/unit/worldsMenu.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Master §1's "the world's small settings block (SP5b's graphics settings screen replaces it)" → "(replaced by SP5b's Settings screen, `ui/settingsPanel.ts`)" (`:1202`'s pin moved); §4.16 "Every setting can be overridden individually" gains spec §9's parenthesis; §5.2's Settings → "Graphics and Controls (SP5b), Audio (SP8c)"; each pinned; `SP5B_MODULES` row for `settingsPanel.ts`; the comments `help.ts:2-3`, `settings.ts:3` reworded.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the Settings screen (G), Graphics and Controls; the help's Worlds menu button (D9, D31)` (`git add src/ui/settingsPanel.ts test/unit/settingsPanel.test.ts src/ui/help.ts src/ui/settings.ts src/ui/worldsMenu.ts src/ui/world/worldPage.ts test/unit/help.test.ts test/unit/worldsMenu.test.ts test/unit/worldPage.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).

---

### Task 29: Storage problems

**Files:**
- Modify: `src/persist/saves.ts` (`openSaves`), `src/ui/worldsMenu.ts`, `src/ui/world/worldPage.ts` (the flush result's notices; `versionchange`, `blocked`), `test/unit/worldsMenu.test.ts`, `test/unit/worldPage.test.ts`

**Interfaces:**
- `openSaves(open: () => Promise<KV>): Promise<Saves | null>` (null when `IdbKV` cannot open or `indexedDB` is absent: `available()` false, §3.8).
- Menu without storage: Load world shows "Saving is not available in this browser window"; New world opens the unsaved world in place (`enterUnsaved(hash, 'This world is not saved: this browser window cannot store data.')`, Task 20, as SP4a's "Enter the world", `startScreen.ts:26`) with the seed and preset as its `#` hash in `?map`'s encoding and no `?rd`; the mounted page shows that notice through `WorldPageOptions.unsavedNotice`, in place of Point 2's (D14).
- During play (D14): a flush answered `{ok: false, status: 'abort', errorName: 'QuotaExceededError'}` → `QUOTA_NOTICE = "Not saving: the browser's storage is full. Free space, or export your worlds from Load world."`, shown until a later flush succeeds (then hidden); `status: 'closed'` → `CLOSED_NOTICE = "Not saving: this browser's storage was closed. Reload to continue."`, and autosave stops posting; another abort keeps retrying with no notice of its own **(plan)**; `versionchange` → "Reload to continue" (in the menu too, which then stops writing); `blocked` (reported through `openIdbKV`'s `onBlocked`, Task 6) → "Close other tabs of world-imaginer-voxel". The world stays playable and the dirty set stays in the sim's memory.

- [ ] **Step 1: Write the tests:** `worldsMenu.test.ts`: "with `saves` null, Load world says `Saving is not available in this browser window`, and New world calls `enterUnsaved` with the hash and `This world is not saved: this browser window cannot store data.`". `worldPage.test.ts`: "a page mounted with that `unsavedNotice` shows it, and not Point 2's text".
  - `worldPage.test.ts` (MemoryKV, in-process sim): **Review Focus 5:** "`failAt(0, 'QuotaExceededError')` on three successive flushes: the world keeps editing, `Not saving: the browser's storage is full. Free space, or export your worlds from Load world.` stays, every tick and `pagehide` post again; the fourth flush commits the union of the dirty columns, the latest history and the pending `record` with `flushSeq` + 1 and the notice hides; a `closed` connection shows `Not saving: this browser's storage was closed. Reload to continue.` and the tick stops posting";
  - "`versionchange` shows `Reload to continue`".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/worldsMenu.test.ts test/unit/worldPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): storage unavailable, full or closed: the world keeps playing and says why (D14)` (`git add src/persist/saves.ts src/ui/worldsMenu.ts src/ui/world/worldPage.ts test/unit/worldsMenu.test.ts test/unit/worldPage.test.ts`).

---

### Task 30: `persist.metric.ts`: E1-E7 and `E5.flush` (first CI run)

**Files:**
- Create: `test/metrics/persist.metric.ts`, `test/harness/persistWorld.ts`
- Modify: `test/thresholds.ts` (the rows; E5 gains its flush parts; `:99-101`'s comment), `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs` (`edit` `:30` gains `persist.metric.ts`), `test/unit/shards.test.ts:40`, the SP5b spec's Threshold log, `test/arch/masterSpec.test.ts` (row; pins), master §6.3, §6.4 (E1-E6's last clause, E7), §1's test entry

**Interfaces:**
- `persistWorld.ts` **(plan)**: `openPersistWorld(o: { kv: MemoryKV; worldId: string; rd: number; delayMs?: () => number }): Promise<PersistWorld>` — §3.4's steps in-process on the real stack (as `edit.metric.ts:362`'s E5: the real coordinator with `retainAllProtos: true` and `setStrict(false)`, `createWorkerPool(2, inProcessWorker)`, the sim through `inProcessSimWorker(createSimHandler({ openKV: async () => kv }), o.delayMs ?? (() => 0))`, `openKV` returning a `Promise<KV>` as Task 8 declares and `inProcessSimWorker` taking its delay, `inProcessSim.ts:13`), the restored pose, hotbar, history and places; `PersistWorld { edit(edits): Promise<EditOutcome>; flushNow(): Promise<FlushedMsg>; windowHash(r: number): string; state(): StateRecord; modify(on: boolean): void; change(patch: ParamsPatch, o?: { revertBeforeCommit?: boolean }): Promise<{ from: WorldStage | null; backedUp: boolean }>; record(world: WorldRecord): void; readonly kv: MemoryKV; readonly simClient: SimClient; dispose(): void }` (`modify` and `change` go through the page's apply control with `createModifyMode`'s `beforeApply`, its checkbox a DOM-shim input, so E6 and E4's pending `record` are driven on the real stack; `kv` and `simClient` read the copy back).
- Rows, each part `{ max: 0, activeFrom: 'SP5b' }`, exact: `E1: roundTripFailures, canonicalFailures, rejectFailures`; `E2: roundTripMismatches, regionHashMismatches`; `E3: reloadHashMismatches, reloadStateMismatches`; `E4: abortedFlushInconsistent, crashedFlushInconsistent, lostAfterRetry`; `E5` gains `flushStale, flushLightMismatches` (`outName: 'E5.flush'`; the session call keeps `E5.session`); `E6: olderGeneratorWrong, backupMissing, backupSpurious`; `E7: crossWorldLeaks, deleteLeftovers, perWorldStateWrong, remapMismatches`.
- The measures, exactly as spec §6.1, seeded with `testRng`, every failure printing its seed and case:
  - **E1** (codec, no world): 10,000 random columns (1,000 on fast), each with 1-3 sections at random `sy` (every `sy` 0-23 drawn over the run), each section's count from {1, 2559, 2560, 4096} (an absent section is the 0; Spec correction 9), the DiffStore-rebuild check on every 10th column, state ids ≥ 256, fluid 0 and 127 (Spec correction 3: 255 is a reject case), trailers of 0, 1 and many ticks with `packedPos` near 2^32 − 1; `roundTripFailures` (decode(encode(d)) ≠ d, or a store rebuilt from it reads differently), `canonicalFailures` (encode(decode(b)) ≠ b; order independent of input order; size ≠ `encodedSize`; the committed fixture's hex), `rejectFailures` (each malformed case of §2.2 accepted);
  - **E2** (`.wiworld`): export → import of worlds with edits, places, history, a walking player and `amplified`; `roundTripMismatches` (any saved part different but `id` and `updated`; `wiworldHash` different) and `regionHashMismatches` (the imported world's region at upTo 'L' with its entries as `diff`, `litRegionHash`, `test/harness/region.ts:168`, against the source's); plus D15's rejects writing nothing, an undecodable column skipped and counted, and each `state`/`history` field the normaliser handles;
  - **E3** (reload): 50 edits of `test/integration/edit.test.ts:17-19`'s mix, places, history, a walking player at `t` 0.3; `flushNow`; dispose the coordinator, pool and sim; `openPersistWorld` again on the same KV; `reloadHashMismatches` (the 7 × 7 window's `litRegionHash` against before) and `reloadStateMismatches` (pose, mode, speed, time, hotbar, slot, history, places); the second case delays an edit's reply past a hide flush, reloads and undoes every step (D32: the stale step dropped, every older one undone);
  - **E4** (aborted flush): for every op index k of a heavy flush (64 dirty columns, 4 dense) `failAt(k)` then a KV-level reopen (a fresh handler's `load` into an empty DiffStore, compared with the committed snapshot); `crashNext()` then a fresh handler on the same KV; `abortedFlushInconsistent`, `crashedFlushInconsistent` (the store not the last committed `flushSeq`'s, or the record's `flushSeq` moved), `lostAfterRetry` (after an abort the next flush not committing the union with `flushSeq` + 1; a history or a `record` of the aborted batch missing from it; an edit between encode and completion missing from the next flush; a column reverted to its generated value keeping its key);
  - **`E5.flush`**: edits, then the session torn down at a seeded point within a flush window and reopened from the KV's committed state; `flushStale` (an edit accepted before the last completed flush not at its latest value, or one after it half applied) and `flushLightMismatches` (light against a fresh `lightRegion`);
  - **E6** (redefined): `olderGeneratorWrong` (a stored genKey ≠ today's opens with today's terrain, its edits at their coordinates, an entry equal to today's generated value kept as a saved entry with its key still in `diffs` after the next flush (D21), the notice flag set once and cleared by the `record` write, no copy), `backupMissing` (the first 'T' or 'D' change with the mode on in a world with edits makes exactly one copy whose record, parameters, genKey, state, history and diff keys equal the original's just before the change, while the original continues under its id with the new parameters and every block at its coordinates, one equal to the new terrain's value included (D11); also after an earlier change of the same mode session found no edits), `backupSpurious` (a copy without edits, a second copy in one mode session, a copy for 'L', 'MESH' or an adopt; a copy posted before the draft returned to the applied one is expected, D11);
  - **E7**: two worlds with the same genKey; `crossWorldLeaks`, `deleteLeftovers` (any key of the deleted world's range in any store), `perWorldStateWrong` (hotbar, player, time, history or places of one world in the other), `remapMismatches` (a permuted `stateTable` and one with an unknown key: every voxel equal by state key, unknown ones air with the right count; the sequence open with a stored table shorter than today's → an edit with a state outside it → flush → reopen, and the same with a non-prefix table: voxels and history equal, the stored table today's after the open).
- Recorded, not gated (`.out/persist.json`): `flushSyncP95Ms`, the frames to the first fill with an empty and a heavy save on `MemoryKV`, the backup's time and the DiffStore's heap with the heavy save (D19, D26).

- [ ] **Step 1: Write the metric and the rows in one go** (a part activates at once in a started SP). SP5b describe: §6.4's E1-E6 row keeps `(the session part SP5a, the flush part SP5b)` and ends with spec §9's E6 clause; the E7 row contains `/ time, history and places restored per world`; §6.3's Persistence `(E1-E7)` and Palette `per world`; the test entry contains `(SP5b: metrics/persist.metric.ts)`; `shards.test.ts:40`: `edit` lists `edit.metric.ts`, `persist.metric.ts`.
- [ ] **Step 2: Prototype timing** (spec §7): `time npx vitest run --project metrics-fast test/metrics/persist.metric.ts` and `--project metrics-quick`. Expected: PASS, every part 0; fast ≤ 25 s, quick ≤ 40 s; E1's own time recorded (spec §7: 1-3 s). Above: E3/E4/E5's RD on quick stays 4 and E1 drops to 5,000 on quick first, then the lever (a `persist` shard), recorded; E1 still above 3 s on quick is reported, not loosened.
- [ ] **Step 3: Govern.** `npm run test:accept-thresholds`; Threshold log: `- <date> — SP5b Task 30: E1 (roundTripFailures, canonicalFailures, rejectFailures), E2 (roundTripMismatches, regionHashMismatches), E3 (reloadHashMismatches, reloadStateMismatches), E4 (abortedFlushInconsistent, crashedFlushInconsistent, lostAfterRetry), E5 flushStale and flushLightMismatches, E6 (olderGeneratorWrong, backupMissing, backupSpurious) and E7 (crossWorldLeaks, deleteLeftovers, perWorldStateWrong, remapMismatches), each max 0, gated from SP5b on every tier (persist.metric.ts, E5.flush; spec §6.1); new parts.`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then `node .github/scripts/metricShards.mjs check` and `node .github/scripts/fastShards.mjs check`. Expected: PASS.
- [ ] **Step 5: Commit** `test(metrics): E1-E7 and E5's flush part` (`git add test/metrics/persist.metric.ts test/harness/persistWorld.ts test/thresholds.ts test/thresholds.lock.json .github/scripts/metricShards.mjs test/unit/shards.test.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).
- [ ] **Step 6: The controller pushes the branch** (`git push -u origin sp5b/saved-worlds`), waits for the run (`gh run watch`), and records every job's time against spec §7 under `## Exit evidence` as "### The first SP5b CI run (Task 30)"; metrics-quick `edit` above 145 s: the named lever (`.github/scripts/metricShards.mjs` gains `persist: [\`${DIR}/persist.metric.ts\`]` and `edit` loses it; `shards.test.ts` follows; `npm run typecheck && npm test`, `node .github/scripts/metricShards.mjs check`), committed as `ci: persist.metric.ts in a metrics-quick shard of its own` (`git add .github/scripts/metricShards.mjs test/unit/shards.test.ts`), pushed, that run's times recorded too. Commit `docs(sp5b): the first CI run` (`git add docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 31: Integration: `load` → `flush` → `load` in a Node worker

**Files:**
- Modify: `test/integration/edit.test.ts` (a case), `test/harness/nodeWorker.ts` (`NodeWorkerOptions.renew?: boolean`), `src/workers/simHandler.ts` (`createMemorySimHandler` exported, Task 8), `test/unit/harnessHelpers.test.ts`, the SP5b spec (Spec correction 4)

**Interfaces:**
- With `renew: true` the generated wrapper declares `let h` (not `const`, `nodeWorker.ts:79`) and answers a harness message `{ type: '__renew' }` only after `h.drain()` returns 0 (otherwise `{ type: 'renewed', ok: false }`, and the case retries after `SIM_DRAIN_MS`, so no retired pool slot is left in the old handler's limbo), then sets `h = factory()` and answers `{ type: 'renewed', ok: true }`; the module-level `MemoryKV` registry of `createMemorySimHandler` survives (Spec correction 4). Never in `src/`.
- `spawnNode` (`edit.test.ts:85-96`) returns its raw `Worker` as well; its message listener swallows `{ type: 'renewed' }` (resolving the case's promise) instead of forwarding it to the client, whose `parseFromSim` would refuse the unknown type and fail the sim (`simClient.ts:97`, and every later `clean()`, `:262`). The case posts `{ type: '__renew' }` on the raw `Worker`.
- The case (one more in `edit.test.ts`'s sequence, about 3-5 s, before the final stop-the-sim case, so the final limbo and free-slot checks, `:23-25`, still hold): the sim from `buildNodeTaskWorker('edit-sim', { entry: 'src/workers/simHandler.ts', factory: 'createMemorySimHandler', retryMs: SIM_DRAIN_MS, renew: true })`, wrapped for `createSimClient`; `attach`, `load` (an empty world), 20 edits, `flush` (ok, `flushSeq` 1); `__renew` on the raw worker; the client sends `attach` again, then `load` of the same world: `loaded.entryCols` equals the 20 edits' columns and each `diff` equals the DiffStore's before; so the guards (`parseToSim`, `parseFromSim`) and the transfers run as `sim.worker.ts` wires them.

- [ ] **Step 1: Write the test.** `harnessHelpers.test.ts`: "`renew` adds the `__renew` branch to the wrapper (with `let h` and the drain check); without it the message reaches the handler (BAD_MESSAGE)".
- [ ] **Step 2: Run** `npx vitest run --project integration test/integration/edit.test.ts` and `npx vitest run --project unit test/unit/harnessHelpers.test.ts`. Expected: PASS; a failure is a bug, fixed in its module with a unit test.
- [ ] **Step 3: Run** `npm run typecheck && npm test`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`. Expected: PASS; no golden diff.
- [ ] **Step 4: Commit** `test(integration): a load, flush and load round trip through the sim's Node worker` (`git add test/integration/edit.test.ts test/harness/nodeWorker.ts src/workers/simHandler.ts test/unit/harnessHelpers.test.ts docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 32: Browser smoke I: the hook, `start`, `menus`, `save`, `crash`, `two tabs`

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` `:468-472`; `start` `:2127-2151`, `START_READ` `:2074-2083`; the `selftest` step's `#selftest-kv` read is Task 6's), `test/unit/uiSmoke.test.ts`, `src/ui/world/worldPage.ts` (`WiTest` `:878-933`)

**Interfaces:**
- `WiTest` gains `worldId(): string | null`, `flushNow(): Promise<{ ok: boolean; flushSeq: number | null }>`, `places(): Place[]`, `modify(on: boolean): void`, `worldHash(): string` (`wiworldHash` of the world's last committed save, read through `saves.readAll`), and, for what the HUD (one decimal, no yaw, `hud.ts:131`) and a saved world's fixed address cannot show: `pose(): { x: number; y: number; z: number; yaw: number; pitch: number }`, `clock(): { t: number; speedIndex: number }`, `fov(): number` (the camera's) and `markOlderGenerator(id: string): Promise<void>` (rewrites that world's `worlds.genKey` through the page's `saves`, for Task 33's older-generator row), all on `WiTestPage`.
- The hook exists only under `?wiTest=1` (`main.ts:34`), and Create navigates to `/?world=<id>` without it: after Create, and on each new target, the smoke opens the world as `/?world=<id>&wiTest=1`; `Page.reload` keeps the query.
- Steps before `console`, in this order: `menus`, `save`, `crash`, `two tabs` (Task 33 appends four more):
  - `start` (rewritten): `/` shows `#start-new`, `#start-load`, `#start-settings`, `#start-map`, `#start-selftest`; a `#` hash changes nothing.
  - **menus:** New world with seed `smoke-7` and `amplified` → Create → the world reveals at `/?world=<id>`; back to `/` → Load world lists it first ("smoke-7" seed text shown), the list's time recorded (`__wiMenuListMs`); Rename to `Smoke world`; Settings from the start screen opens and closes.
  - **save:** in the world: 12 edits through the hook, a place, F to walk, T to ×10; `flushNow()`; `Page.reload` → every block (`blockAt`), the place, the pose (`pose()` within 0.01), walking, the time speed back (`clock().speedIndex`); then one edit and a reload within 300 ms: whether it survived recorded (the `pagehide` outcome, spec §3.2), never gated.
  - **crash:** an edit, `flushNow()`, one more edit, CDP `Page.crash`; a new target on `/?world=<id>`: the first edit back, the world opens.
  - **two tabs:** a second target on the same `?world` shows `This world is open in another tab` on the start screen; after the first target closes, the second opens it; `Page.reload` of a world's own target reopens it; Worlds menu → Play the same world in the same target opens it.

- [ ] **Step 1: Write the tests.** `uiSmoke.test.ts`: the list gains `menus`, `save`, `crash`, `two tabs` after `walk` and before `console`; the `start` reads the new ids; the world URLs the smoke opens after Create and on a new target are `/?world=<id>&wiTest=1`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts` (its own port and Chrome profile). Expected: every step passes; the `pagehide` outcome recorded in the task's report.
- [ ] **Step 5: Commit** `test(ui): the smoke's menus, save, crash and two-tabs steps` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts src/ui/world/worldPage.ts`).

---

### Task 33: Browser smoke II: `export/import`, `places`, `modify`, `settings-world`, `stream`; the review screenshots

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`stream` `:2229-2243`; the shots), `test/unit/uiSmoke.test.ts`
- Commit: `docs/superpowers/specs/assets/sp5b/review-*.png`

**Interfaces:**
- Steps after `two tabs`, before `console`: **export/import** (CDP's download behaviour into the run's temp directory; Delete; Import with `DOM.setFileInputFiles`; `worldHash()` equal); **places** (B, a name typed, Enter → `Place saved`; M → the Places tab lists it; ↗ teleports to its pose within 0.01, read through `pose()`, yaw and pitch included); **modify** (off: `#map-modify` unchecked, a parameter control disabled, the map's Ctrl+Z inert; on: one `density.detailAmpHi` change → after `backedUp` the Load list shows `<name> (before the change)` with `automatic copy`); **settings-world** (G opens, FOV 80 applies to the camera, `fov()` 80, Esc closes). `stream` sets the render distance through the Settings screen (G, `#setting-rd`), still "no navigation". `overlay`, `build` and `walk` run on unsaved worlds as now.
- `--shots <dir>` (`uiSmoke.ts:95`) writes **(plan)** `review-start.png`, `review-new-world.png`, `review-load-world.png` (with an automatic copy and an older-generator row, the latter written through the hook's `markOlderGenerator`, Task 32), `review-settings-graphics.png`, `review-settings-controls.png`, `review-place-dialog.png`, `review-map-places.png` (dots and the Places tab).

- [ ] **Step 1: Write the tests.** `uiSmoke.test.ts`: the four steps after `two tabs`, `console` last; the shot names.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/uiSmoke.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts --shots docs/superpowers/specs/assets/sp5b/` (its own port and profile). Expected: every step passes (about 90-120 s more than SP5a's run); the seven PNGs written. The controller checks each screen's content and placement against the mockups (`.superpowers/brainstorm/80479-1793306513/content/sp5b-screens.html`, `69132-1793058381/content/start-menu.html`); styling is not reviewed (Non-goals); a missing element is fixed test-first before the commit.
- [ ] **Step 5: Commit** `test(ui): the smoke's export/import, places, modify and settings steps; SP5b's review screenshots` (`git add test/tools/uiSmoke.ts test/unit/uiSmoke.test.ts` and the seven PNGs by explicit path).

---

### Task 34: GPU cells (Chrome, agent): the bench and enter files, `G2.flush`, `G1.enter`

**STOP for the user before Step 1:** PRIME on **on-demand**, the display awake and unlocked, eDP-1 at 240 Hz, nothing heavy running.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp5b/bench-iris-chrome.json`, `bench-iris-chrome-w4.json`, `flight-iris-chrome.json`, `bench-rtx-chrome.json`, `enter-iris-chrome.json`, `enter-rtx-chrome.json`
- Modify: `test/thresholds.ts` (G1 and G2 rows), `test/thresholds.lock.json` (generated), `test/metrics/g1.metric.ts` (`ASSETS_SP5A` `:62` → `ASSETS_SP5B` for every call; `EDIT_LEGS` gains `'L11'`, `checkBench`'s known legs "L0-L11"; two calls), the SP5b spec's Threshold log (and Spec correction 6), `test/arch/masterSpec.test.ts`

**Interfaces:**
- Rows: `G2` gains `over33Added: { max: 1 }`, `p95AddedMs: { max: 4.17 }`, `editVisibleAddedMs: { max: 8.33 }`, `flushEditVisibleP95: { max: 50 }` (Spec correction 6), `replyDuringFlushP95Ms: { max: 5 }`, `flushMainP95Ms: { max: 0.3 }`, each `activeFrom: 'SP5b'`; `G1` gains `enterRatio: { max: 1.10, activeFrom: 'SP5b' }`.
- `metricTest('G2', [the six], …, { outName: 'G2.flush' })` reads `bench-iris-chrome.json`'s `persist` block (the shape checks of the streaming call: route, /Iris/, `batch`, rd 12, cold cache, plus `persist.flushes` ≥ 20); `metricTest('G1', ['enterRatio'], …, { outName: 'G1.enter' })` reads `enter-iris-chrome.json` (cold, /Iris/, 6 pairs, 5 kept); the RTX files recorded in `.out/G2.flush.others.json` and `.out/G1.enter.others.json`. G1's and `G2.edit`'s calls re-read from `assets/sp5b/` (the SP5a files stay).

- [ ] **Step 1: Measure** (an agent, quiet machine, cold shader cache, touching no other process): `npm run measure:chrome -- --route bench --gpu iris`; `… --gpu iris --workers 4`; `… --route flight --gpu iris`; `… --route enter --gpu iris`; `… --route bench --gpu rtx` and `… --route enter --gpu rtx` (if the RTX probe refuses, **STOP**: the user switches to 'nvidia', the controller resumes with `claude --resume` and re-runs those cells, then the user switches back to on-demand).
- [ ] **Step 2: Check.** Gated: the six `G2.flush` parts, `enterRatio` ≤ 1.10, every earlier G1 part and `G2.edit` on the new files. Recorded: `idbOpenMs + loadMs`, `flushSyncP95Ms`, `flushCommitP95Ms`, `newWorldRevealMs`, L10's `over33`. A miss: Task 18's levers not yet taken for it, then **STOP** and report every JSON (D28); no gate is loosened.
- [ ] **Step 3: The rows, the metric and the files in one commit.** SP5b describe: §10's Exit names `G2.flush` and `G1.enter` (Task 1's pin) and the rows equal the spec's. `npm run test:accept-thresholds`; Threshold log: `- <date> — SP5b Task 34: G2 over33Added max 1, p95AddedMs max 4.17, editVisibleAddedMs max 8.33, flushEditVisibleP95 max 50, replyDuringFlushP95Ms max 5, flushMainP95Ms max 0.3 (G2.flush), and G1 enterRatio max 1.10 (G1.enter), gated from SP5b on every tier from assets/sp5b/ (g1.metric.ts; spec §6.2, D28); G1's and G2.edit's cells re-read from assets/sp5b; new parts (measured <values> on eDP-1 at 240 Hz).`
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`. Expected: PASS with G1, G1.streaming, G1.live, G1.enter, G2.edit and G2.flush asserted on the SP5b files.
- [ ] **Step 5: Commit** `feat(sp5b): the Chrome bench and enter cells, G2.flush and G1.enter` (the six JSON files staged by explicit path, with `test/thresholds.ts test/thresholds.lock.json test/metrics/g1.metric.ts test/arch/masterSpec.test.ts docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md`).

---

### Task 35: The user's Firefox run

This task is the controller's and the user's.

**Files:**
- Commit: `docs/superpowers/specs/assets/sp5b/selftest-firefox.json` (the user's reading, as SP5a's), `enter-iris-firefox.json` (from `?bench=enter&auto=1`), `bench-iris-firefox.json` (only if the user sends it)

- [ ] **Step 1: STOP for the user.** The controller runs `npm run build`, then its own `npx vite preview --port 4173 --strictPort` (stopped only by the controller), and gives the user `http://localhost:4173/?selftest=1` (required: 59/59 and the IndexedDB contract all passed), the export/import into another Firefox profile (create a world, build, export, import in a second profile, compare), `http://localhost:4173/?bench=enter&auto=1` (Task 16's self-driving enter route; it ends by offering `enter-iris-firefox.json` for download, which the user sends: spec §6.2 records Firefox's enter cell), and, optionally, `http://localhost:4173/?bench=medium`.
- [ ] **Step 2: Record** the selftest result, the cross-profile import, the enter file and any bench file (recorded, not gated) in the exit evidence.
- [ ] **Step 3: Commit** `docs(sp5b): the Firefox selftest and cross-profile import` (the files by explicit path, and the spec).

---

### Task 36: Whole-branch review

**Files:**
- Modify: `test/arch/masterSpec.test.ts` (the bare-SP5 rule still holds; `:1207-1208`'s Kill pin, `toContain('if SP3a-SP5b shows an unfixable isolation or concurrency problem')` in the SP5a describe, moved into the SP5b describe and rewritten to the new wording, Spec correction 2; `:1013-1015`'s SP4b pin unchanged, its "(amended by SP4b: …)" parenthesis kept verbatim in the new line), master §8 risk 1's Kill line

- [ ] **Step 1:** Risk 1's Kill line worded by whether SP5b met an isolation or concurrency problem (spec §9), keeping the SP4b parenthesis verbatim, pinned in the SP5b describe; `npm run typecheck && npm test`; commit `docs(sp5b): risk 1's kill window closed at SP5b` (`git add test/arch/masterSpec.test.ts docs/superpowers/specs/2026-09-26-architecture-design.md`).
- [ ] **Step 2:** The controller runs the final review of `git diff main...sp5b/saved-worlds` against the spec, this plan and Review Focus 1-5 (superpowers:requesting-code-review), the reviewer resolving its own cannot-verify items in the code at HEAD. Beyond the per-task reviews it checks what only the whole branch shows:
  - every `(plan)` decision is in the code as written, or its change is recorded in the spec; every Spec correction is reworded in the spec;
  - nothing writes the open world but the sim (the menu only through the lock, Export only reads); no write path skips `flushSeq`; no `indexedDB` outside `persist/idb.ts`;
  - nothing changes the parameters except through the session (`mapTool.ts:142-148`, the gestures, presets, the profile confirm, the notice's Undo), so `setWritable` covers every terrain edit (§4);
  - every disposer the autosave, the lock, the settings panel, the place dialog, the places tab and the menu add is reached from the page's teardown or the menu's `dispose`;
  - SP5a's rules still hold: zero allocation at rest, the layers, `data-renderer` once, no golden diff, D29's unsaved worlds unchanged (the bench's L1-L10 cells comparable with SP5a's files);
  - the CI time against §7 (Task 30's run) and the masterSpec block's pins against spec §9's list;
  - spec §10's hand-overs still true of the code as built (`ColumnDiffV1`'s trailer for SP7, the Audio tab for SP8c, the `meta` store and the persisted history for SP5c).
- [ ] **Step 3:** Each finding is fixed test-first in its module, one commit each (`fix(sp5b): …`); a finding that would loosen a gate or change the spec goes to the user.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, `npm run test:goldens && git diff --exit-code main -- test/goldens.json`, and the smoke again. Expected: PASS; no golden diff.

---

### Task 37: Exit: evidence and docs

**Files:**
- Modify: the SP5b spec (`## Exit evidence`, Status), `CLAUDE.md` (`:9`; the menus, `?world=<id>`, B and G; the smoke's new steps; `measure:chrome`'s `--route enter` and `assets/sp5b`), `README.md` (`:9`, an SP5b paragraph)

- [ ] **Step 1: Exit checks** (spec §12): `npm run build && npm test && npm run test:metrics:full` (E1-E7 and `E5.flush` on every tier, `E5.session` still 0); `git diff main -- test/goldens.json` empty; `GENERATOR_VERSION` 5; `npx --yes bun@1 test/tools/goldensJsc.ts` 59/59; `?selftest=1` 59/59 and the IndexedDB contract in Chrome (the smoke) and Firefox (Task 35); `node test/tools/uiSmoke.ts --shots "$(mktemp -d /tmp/wi10-shots-XXXX)"` green; `npm run bench` within its gates and +30 % (`persist.flush` p99 ≤ 2 ms).
- [ ] **Step 2: Exit evidence**, before the Threshold log: the first CI run; the early measurement and any lever (Tasks 17-18); `G2.flush`, `G1.enter` and every G1 cell with its file; the RTX files; the Firefox selftest and cross-profile import; E1-E7 per tier with `persist.json`'s recorded values; `persist.flush`; the smoke with the `pagehide` outcome; the review screenshots described against the mockups; the masterSpec pins of 'master spec amendments (SP5b §9)'; whether the "· n places" count shipped or was cut (§11); risk 1's wording.
- [ ] **Step 3:** Status "implemented, awaiting CI, the production check and the user's check"; `CLAUDE.md:9` and `README.md:9` the same.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(sp5b): exit evidence and docs` (`git add docs/superpowers/specs/2026-10-29-sp5b-saved-worlds-design.md CLAUDE.md README.md`).

---

### Task 38: Merge, production check, the user's check, SP5b complete

**STOP for the user's go-ahead** before Step 1.

- [ ] **Step 1:** Merge `sp5b/saved-worlds` to `main` and push; CI green, its wall recorded against §7's ≈ 2.8-3.1 min (above 3 min 30 s: the lever first, `persist.metric.ts` into a shard of its own).
- [ ] **Step 2: Production, headful** (spec §12), on the deployed build:
  - **Chrome** (RegionBatch; the agent's own headful Chrome on the Iris Xe, its own `mktemp -d` profile, `MESA_SHADER_CACHE_DISABLE=true` in its env only; **STOP** until the user confirms PRIME on-demand and the display awake and unlocked): create, build, reload, two tabs, export/import, places, the mode and its backup; `?selftest=1` 59/59 and the IndexedDB contract; page and console errors 0;
  - **Firefox** (RegionMesh; **STOP for the user**, in the user's own Firefox, by hand, as SP5a's `production-check.json` records `firefox.by`): the same steps and production's `?selftest=1`, with F5 on a saved world reopening it (D24's lock wait, which only Firefox's run checks there) and the outcome of an edit followed by a reload within 300 ms recorded (the `pagehide` commit, spec §3.2), never gated;
  - the controller commits `assets/sp5b/production-check.json` (`docs(sp5b): the production check`).
- [ ] **Step 3: The cut line:** the "· n places" count shipped (Task 21) → master §10's SP5b Cut line ends "It was not taken: the place count shipped in SP5b, so nothing moved." and the receivers read `SP5b worlds-menu polish (the Load list's place count) → SP10 (delivered in SP5b, so nothing moved)`, pinned in the SP5b describe; if it was cut, the receivers and SP10's "Received from SP5b" line say so.
- [ ] **Step 3b: STOP for the user's check** (§6.6): create worlds, build, reload and continue where left, rename and delete, export and import in another browser profile, saved places (B, the dots, the Places tab), the modification mode with its backup copy; and whether it "stutters", loses work or is slow to enter (the last criterion; D28: the user's check decides).
- [ ] **Step 4:** After the user's verdict (a finding goes back test-first, with another go-ahead before it reaches `main`), a final commit marks SP5b complete (`CLAUDE.md:9`, `README.md:9`, the spec's Status, the cut-line pin): `docs: SP5b complete`.

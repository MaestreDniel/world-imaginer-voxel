# SP4a — The world in 3D, loaded once: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user enters the generated world in 3D for the first time. A minimal start screen at `/` leads to a loading screen. Behind it the workers generate, light and mesh the RD12 disc around the spawn, and then the user flies through it in spectator mode. The world has flat colours, AO, smooth and exact sky light, translucent still water, a sky with the sun, day and night, fog, a HUD, a help overlay and a key map stored as data. It renders on RegionBatch in Chrome and on RegionMesh in Firefox, and the generated world does not change.

**Architecture:**
- **Workers.** The workers share one store, a growable `SharedArrayBuffer` created on the page and attached once. They run four column jobs in turn: T, then the D skeleton, then L (the exact light), then MESH_COLUMN, which builds one payload per column.
- **Coordinator.** A one-shot coordinator (`engine/coordinator.ts`) feeds the pool nearest-first under the prerequisite rules.
- **Rendering.** The page stages each column's payload into a `SectionRenderer`:
  - RegionBatch, with one `BatchedMesh` per region and pass;
  - RegionMesh, with merged buffers per region and pass, used wherever `WEBGL_multi_draw` is missing.

  Both render through custom GLSL3 materials (`render/materials/`, the only place GLSL lives). The page builds the regions within an upload budget and reveals the whole world in one frame.
- **Loading.** The order is start screen, then loading screen, then reveal.
- **Measurement.** It runs outside CI:
  - a spike page (`?spike=batch`) and a flight route (`?flight=sp4a`) produce JSON;
  - agents run the Chrome cells through `test/tools/measureChrome.ts`;
  - the user runs the Firefox cells by hand.

**Tech Stack:** TypeScript 7 (tsgo, strict, erasableSyntaxOnly, verbatimModuleSyntax), Vite 8, Vitest 5, Node 24 (`worker_threads`), three r186 (`~0.186.1`, already a dependency), Chrome 155 over CDP for the browser tools, Bun 1 for the JavaScriptCore golden check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-sp4a-static-world-renderer-design.md` (approved 2026-10-20). Master: `docs/superpowers/specs/2026-09-26-architecture-design.md`. Code maps behind the spec: `.superpowers/sp4/map-{code,master,tests}.md` (git-ignored; the controller has them).

**Plan form.** This is a compact plan: the user chose it on 2026-10-20 instead of the dry-run method of SP3c-SP3e. Each task gives:
- the files;
- the interfaces;
- the tests, with the spec's exact values;
- the decisions the spec leaves open, marked **(plan)**.

The implementer writes the bodies. The task reviewer checks each one against the spec section the task cites. GPU measurements are taken once, during execution.

**Spec corrections found while planning** (each folded in by the task named):
- **§2.1's ring counts.** The master's 491 / 573 / 660 / 755 are the disc areas π(R + 0.5)², not counts. The integer discs `dx² + dz² ≤ (R + 0.5)²` hold **489 / 577 / 665 / 749** columns at R 12 / 13 / 14 / 15. Task 20 pins the exact counts, states that they are within 1 % of the master's estimates, and rewords the §2.1 sentence in the spec.
- **§2.2's intake check, made exact.** A light job's 3 × 3 `lightVersion`s legitimately move while it runs: its own commit and its neighbours' L commits both bump them. L results are therefore compared on the `blockVersion`s only, and MESH results on all 18 values. Task 20 implements this and rewords §2.2's Intake bullet.
- **D14's palette change moves committed review slices.** `test/harness/png.ts` draws the review slices with `VOXEL_COLORS`, so packed_ice's new colour changes every committed slice that shows packed_ice. Task 5 regenerates exactly those slices, and only packed_ice pixels may change.

## Global Constraints

- **Language and tooling.**
  - TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax`.
  - ES2022 modules, extensionless relative imports in `src/`.
  - Tools under `test/tools/` run under plain Node (type stripping), so they cannot import `src/` modules. They mirror the values they need as literals, and unit tests pin those literals (the uiSmoke precedent).
  - **No new dependencies.**
- **Layers** (`test/arch/rules/imports.ts`):
  - three only in `render/`;
  - `render/materials/**` imported only from `render/`;
  - GLSL only as template literals in `render/materials/**/*.glsl.ts`, and no `ShaderMaterial`, `glslVersion`, `gl_Position` … outside it (`test/arch/rules/banned.ts`);
  - `render` value-imports core, world, light, mesh, textures, daynight, render and `workers/protocol.ts`, never engine, gen or ui;
  - `engine` value-imports core, world, engine and `workers/protocol.ts`, with type-only gen, light, mesh and textures, and never render;
  - `light` and `mesh` value-import core, `world/blocks/**`, `world/store/padded.ts`, gen, textures, light and mesh, with `world/store/api.ts` type-only;
  - `textures` value-imports core and textures only;
  - `player` value-imports core, world, daynight, player and `workers/protocol.ts`, with engine and render type-only;
  - only `engine/` spawns workers;
  - `ui` and `main` may import anything but `render/materials/**` and `*.worker.ts`.
- **Pure layers.** `light/`, `mesh/` and `daynight/` (with core, world, gen and textures) use no DOM, `window` or `localStorage`.
- **Determinism and aliasing.**
  - `world/blocks/**` and `gen/**` follow the Math allowlist, the ND bans and the top-level-alias rule for imported values.
  - `gen/**` exports no numeric constants.
- **The generated world does not change.**
  - `GENERATOR_VERSION` stays 5 and the stage registry is not touched (`decorate` stays version 1).
  - `test/goldens.json` stays byte-identical: `git diff --exit-code main -- test/goldens.json` is empty after every task.
  - `test/stateIds.lock.json` and `test/schema-shape.lock.json` never change.
  - Tasks 9-17 touch the store, gen or the harness, so each runs `npm run test:goldens` and then that diff. If the run rewrote anything, restore the file with `git checkout main -- test/goldens.json` and find the bug.
- **Governance.**
  - `test/thresholds.lock.json` changes only in Task 1 (`startedSps`), Task 18 (R1, R2, R4, R5), Task 19 (L1, L2, DT1's light part, S1's `grassSky0`) and Task 30 (G1), always through `npm run test:accept-thresholds`.
  - Each of those commits adds one line to the SP4a spec's `## Threshold log` (CI checks this per push).
  - `test/baselines.json` changes once, in Task 32 (`npm run bench:record`).
  - Master amendments land in the task that builds what they describe. Each task lists its own.
- **TDD.** Write the test, watch it fail for the stated reason, implement, then watch it pass. `npm run typecheck && npm test` is green before every commit.
- **GPU measurements** (spec §1.2, §9.5):
  - **Chrome cells:** run by agents with `npm run measure:chrome`, on the user's laptop, on a quiet machine (nothing else heavy running; the tool refuses to start when the 1-minute load average is above 2).
  - **Firefox cells:** run by the user by hand. The controller commits the JSON the user sends.
  - **Stops:**
    - The plan continues only after the Chrome/Iris Xe spike cell passes (Task 8). A failure there stops the plan for the user.
    - A G1 miss that tuning within §9.5 cannot fix stops for the user (Task 30).
    - A missed bench absolute gate stops for the user (Task 32).
    - A Firefox or RTX cell outside its criterion goes back to the user (Task 33).
- **Processes.**
  - Never kill, signal or touch a process you did not start. Never use `pkill`, `killall` or pattern kills.
  - The tools start their own `vite preview` on a free port (never 5183) and their own Chrome with a fresh `mktemp -d /tmp/wi10-XXXX` profile, and stop only those.
  - Never open, close or touch the user's own browsers.
- **Outward-facing actions.** Merging to `main` and pushing `main` happen at the exit, with the user's go-ahead. Pushing the branch so that the user can run the Firefox cells on a preview is the controller's call.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JbkJNEMpTrQS68LobuogBc`. **Staging:** `git add` with explicit paths only.
- **Task reviews.** The task reviewer checks each item it cannot verify from the diff itself, in the code at HEAD and in this plan's later tasks. A requirement missing at HEAD that no later task supplies is a blocking finding. No separate resolver agent is used.

## Review Focus

The spec implies these inputs, but no test in the spec exercises them. They are listed most likely first, and each line names the test that pins it and the task that owns that test.

1. **Ctrl held with a movement key, or with the wheel.** Flying with Ctrl (sprint) and D triggers Chrome's bookmark dialog (Ctrl+D). Ctrl+S, Ctrl+A and Ctrl+F do the same kind of thing, and Ctrl+wheel zooms the page instead of changing the speed. A person expects sprint-strafing and changing speed while sprinting to fly, never to open browser dialogs or zoom. Task 24 pins it with:
   - "keydown of a bound action while the world has focus calls preventDefault, Ctrl held included (Ctrl+D, Ctrl+S, Ctrl+A, Ctrl+F)";
   - "wheel with Ctrl held changes the speed and calls preventDefault (listener registered with passive: false)".
   Ctrl+W, Ctrl+T and Ctrl+N cannot be prevented, so the `beforeunload` guard covers Ctrl+W.
2. **The tab hidden while the world loads.** rAF stops in a background tab, so uploads pause while the workers keep going. When the user switches back, a wall-clock watchdog would show the "no progress for 30 s" failure panel even though nothing failed. A person expects the load to go on when they return. Task 26 pins it with "time while document.hidden does not count toward the 30 s watchdog, and the watchdog restarts its window on visibilitychange".
3. **"Enter the world" double-clicked, or R pressed twice.** A second click must not start a second pool and a second store of about 1.3 GB of reservations. A second R must not stack reloads. A person expects one load. Task 26 pins "a second click on Enter the world (or a double-click) calls onEnter once; the buttons are disabled after the first". Task 28 pins "R twice within the reload calls navigate once".
4. **The window resized, or moved to a monitor with another devicePixelRatio.** A stale camera aspect stretches the world, and a stale pixel ratio blurs it or over-renders it. A person expects the view to keep its proportions and its pixel-ratio cap. Task 23 pins "applyViewport: a host resize sets the camera aspect and the drawing-buffer size; a dpr change re-applies min(dpr, pixelRatioCap)".
5. **The WebGL context lost.** This happens on a GPU switch, a driver reset or a sleeping laptop. Without a handler, the page freezes on its last frame with no explanation. A person expects to be told and offered a way back. Task 28 pins "webglcontextlost stops the frame loop and shows 'The graphics context was lost' with a Reload link carrying ?at, y, yaw and pitch of the camera".

## Branch

Create `sp4a/static-world` from `main` before Task 1: `git switch main && git switch -c sp4a/static-world`.

## Task overview

| # | task | spec |
|---|---|---|
| 1 | Governance: split SP4, start SP4a | §12, §14 (the split) |
| 2 | `test/tools/cdp.ts` and `measureChrome.ts` | §1.2, §8.3, §9.5 |
| 3 | `mesh/packing.ts`, the column payload type, `packing.glsl.ts` | §5.5, §5.8, D11, D12 |
| 4 | `daynight/dayNight.ts` and `render/lightmap.ts` | §6.5, §6.7, D16 |
| 5 | `textures/flatColors.ts`, `render/textureArray.ts`, the Voxels palette | §6.3, D14 |
| 6 | Materials v1 and `graphicsPresets.ts` | §6.4, §6.6, §6.10, D15, D17 |
| 7 | `SectionRenderer`, RegionBatch and the contract suite | §6.2 |
| 8 | **The spike** (page, store spike, Chrome cells): **gate** | §1 |
| 9 | Store: `reopenColumn`, `setLight`, per-channel versions, attach asserts | §2.5, §2.6, D4 |
| 10 | `effOpacity`, the fall predicate, `world/store/padded.ts` | §4.1, §4.3, §5.1 |
| 11 | The D skeleton and the final heightmaps | §3, D7 |
| 12 | The light job | §4, D8, D9 |
| 13 | The greedy mesher (faces, AO, smooth light, merge) | §5.2-§5.4 |
| 14 | Still water and connectivity | §5.6, §5.7, D10 |
| 15 | The column mesh payload | §5.1, §5.8 |
| 16 | Protocol, task handler, pool, integration | §2.3 |
| 17 | Harness: upTo D/L/MESH, cache format 3, references | §9.2, D27 |
| 18 | `render.metric.ts`: R1, R2, R4, R5; the `render` shard | §9.1, §10, D28 |
| 19 | `light.metric.ts`: L1, L2, DT1.light, S1 `grassSky0` | §9.1, D26 |
| 20 | Rings, the coordinator's core, the upload budget | §2.1, §2.2, D3, D6 |
| 21 | Capabilities, the 3D page's rules, the default RD | §8.5, D23 |
| 22 | RegionMesh | §6.2, D2 |
| 23 | Renderer, sky, floating origin, FPS limiter | §6.1, §6.5, §6.8 |
| 24 | Key map, fly controller, input | §7.1-§7.3, D18, D19 |
| 25 | HUD and help overlay | §6.9, §7.4, D30, D31 |
| 26 | Start screen and loading screen | §8.1, §8.3, D21, D22 |
| 27 | The world page: boot to reveal | §8.1, §8.2, §8.4 |
| 28 | The world page: edge, reload, guards, notices, map links | §7.1, §7.5, §8.2, §8.5, D20 |
| 29 | Browser smoke: `start`, `world`, `world-mesh` | §9.6 |
| 30 | The flight route, the Chrome flights, G1 | §9.5, D24 |
| 31 | Panoramas (tool, route, assets) | §8.3, D22 |
| 32 | Bench rows `light.column` and `mesh.section` | §9.3 |
| 33 | Firefox cells, review assets, master §1, exit evidence | §11, §12, §14 |

The order follows spec §12. Tasks 3-7 come before the spike because the spike renders through the real packing, materials and RegionBatch (§1.4).

---

### Task 1: Governance: split SP4 into SP4a and SP4b, start SP4a

**Files:**
- Modify: `src/core/ids.ts` (`SubProjectId`, `SUB_PROJECTS` :6-14, doc comment, `CURRENT_SP` :21), `test/harness/sp.ts` (`SP_DEPS` :5-26, `STARTED_SPS` :33)
- Modify (pins): `test/arch/sp.test.ts` :18-22, :24-32, :34-38, :58, :63, :69-79; `test/unit/profiles.test.ts` :25-26; `test/arch/masterSpec.test.ts` :319, :499, :518; `test/unit/lock.test.ts` :75
- Modify: master spec, `test/thresholds.lock.json` (generated), SP4a spec `## Threshold log`, `CLAUDE.md:9`, `README.md:9`

**Interfaces:**
- Produces: `SubProjectId` includes `'SP4a' | 'SP4b'` (no `'SP4'`); `CURRENT_SP === 'SP4a'`; `STARTED_SPS` ends with `'SP4a'`.

- [ ] **Step 1: Update the pinned tests first.**
  - `sp.test.ts`:
    - the started list ends `…, 'SP3e', 'SP4a'` and `CURRENT_SP` is `'SP4a'`;
    - the `currentSpOf` cases written with `'SP4'` use `'SP4a'`;
    - `SP_ORDER` has `'SP4a', 'SP4b'` in place of `'SP4'`, and the title says "all 21 sub-projects";
    - the paths at :58, :63 and :69-79 use `'SP4a'`.
  - `profiles.test.ts`: `CURRENT_SP` is `'SP4a'`.
  - `masterSpec.test.ts`: `spEntry('SP3e', 'SP4a')`, and the same rename at :319 and :499.
  - `lock.test.ts:75`: the example id is `'SP4a'`.
- [ ] **Step 2: Run them.** `npx vitest run --project unit --project arch test/arch/sp.test.ts test/unit/profiles.test.ts test/arch/masterSpec.test.ts test/unit/lock.test.ts`. Expected: FAIL (the ids still say `'SP4'`).
- [ ] **Step 3: Implement.**
  - `ids.ts`:
    - `SUB_PROJECTS` replaces `'SP4'` with `'SP4a', 'SP4b'` in place;
    - `CURRENT_SP = 'SP4a'`;
    - the doc comment records the split ("SP4 was split on 2026-10-20 into SP4a and SP4b").
  - `sp.ts`:
    - `SP_DEPS` gains `SP4a: ['SP3b']` and `SP4b: ['SP4a']` and drops `SP4`;
    - `SP5` reads `['SP4b']`, and `SP8a`'s `'SP4'` becomes `'SP4a'` (its other deps are kept);
    - if any other entry names `'SP4'`, stop and report: the spec lists only these;
    - `STARTED_SPS` appends `'SP4a'`.
  - **Master amendments of the split** (spec §14):
    - §2.5's `SubProjectId`;
    - §10: the SP4 entry is replaced by the split paragraph and the SP4a and SP4b entries, with the exact text of spec §14;
    - SP5's header `(M; SP4b)` and its persistence bullet;
    - SP8a's and SP6's wording;
    - the critical path, the parallelism line, the "Visible value" line and "SP4a week 1";
    - the SP3 split paragraphs;
    - the cut-line receivers (SP0's "(→ SP4a)"; "SP4a loading-screen panoramas → SP4b" worded as planned, Task 33 rewords it);
    - the SP10 and SP11 additions;
    - the renames §3.7 "SP4-SP9" → "SP4b-SP9", §4.3 → "SP4b", §4.5 "the SP4a spike" (twice), §5.1 "Until SP4b" / "SP4b's Apply", §6.1 "until SP4a" and §8's risks 1 and 2.
  - **What stays.** `grep -n 'SP4\b' docs/superpowers/specs/2026-09-26-architecture-design.md` then lists only lines whose content amendment a later task makes: §2.2, §2.3, §3.0, §3.12, §4.4, §4.6, §4.8, §4.9, §4.16, §4.17, §5.8, §5.9, §6.3, §6.4 and §7. Put that list in the commit message.
  - Run `npm run test:accept-thresholds`. Add the Threshold-log line `2026-10-2X — SP4a Task 1: startedSps gains 'SP4a' (SP4 split into SP4a and SP4b, spec §12).`
  - `CLAUDE.md:9` and `README.md:9`: SP4a in progress (the world in 3D, loaded once), SP4b next.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS, including masterSpec's §10 header and `SP_DEPS` checks.
- [ ] **Step 5: Commit** `chore(sp4a): split SP4 into SP4a and SP4b; start SP4a`.

---

### Task 2: `test/tools/cdp.ts` and `test/tools/measureChrome.ts`

**Files:**
- Create: `test/tools/cdp.ts`, `test/tools/measureChrome.ts`, `test/unit/measureChrome.test.ts`
- Modify: `test/tools/uiSmoke.ts` (imports the moved helpers), `package.json` (`"measure:chrome": "node test/tools/measureChrome.ts"`)

**Interfaces:**
- Produces, in `cdp.ts`: the uiSmoke helpers moved unchanged and exported.
  - `freePort(): Promise<number>`, `npmBuild(): Promise<void>`, `startPreview(port: number): Promise<ChildProcess>`.
  - `startChrome(o: ChromeLaunch): Promise<ChromeHandle>`, where:
    - `ChromeLaunch` is `{ headless: boolean; profileDir: string; args: readonly string[]; wrapper: string | null }`;
    - `ChromeHandle` is `{ proc: ChildProcess; wsUrl: string }`.
  - `connect(wsUrl: string): Promise<Cdp>`, the `Page` class, and `stopChild(p: ChildProcess): Promise<void>`.
  - `mapLatency.ts` keeps its own copy (spec §8.3).
- Produces, in `measureChrome.ts`, these pure exports:
  - `parseMeasureArgs(argv: readonly string[]): MeasureArgs`, with `MeasureArgs` = `{ route: 'spike' | 'flight'; gpu: 'iris' | 'rtx'; workers: 4 | null; skipBuild: boolean; renderer: 'batch' | 'mesh' | null; probeOnly: boolean }`;
  - `outputName(a: MeasureArgs): string`;
  - `gpuMatches(gpu: 'iris' | 'rtx', renderer: string): boolean`;
  - `chromeArgs(a: MeasureArgs, profileDir: string): string[]`;
  - `MEASURE_LOAD_MAX = 2`.

- [ ] **Step 1: Write `test/unit/measureChrome.test.ts`.**
  - `parseMeasureArgs(['--route','flight','--gpu','rtx','--workers','4'])` gives `{route:'flight', gpu:'rtx', workers:4, skipBuild:false, renderer:null, probeOnly:false}`; `--probe-only` sets `probeOnly`.
  - An unknown flag, a missing `--route`, `--gpu amd` or `--workers 3` throws.
  - `outputName` gives `spike-chrome-iris.json`, `spike-chrome-rtx.json`, `flight-iris-chrome.json`, `flight-rtx-chrome.json` and, with workers 4, `flight-iris-chrome-w4.json`.
  - `gpuMatches('iris', 'ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6)')` is true. `gpuMatches('rtx', 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Laptop GPU/PCIe/SSE2, OpenGL 4.5)')` is true. Each is false for the other GPU's string and for `'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))'`.
  - `chromeArgs`:
    - contains `--window-size=1920,1080`, `--force-device-scale-factor=1`, `--ignore-gpu-blocklist` and `--disable-backgrounding-occluded-windows`;
    - contains no `swiftshader` flag and no `--headless`.
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/measureChrome.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - **Move the helpers.** Move uiSmoke's process and CDP helpers (`startChrome`, `connect`, `Page`, `freePort`, `startPreview`, `npmBuild` and the child stop) into `cdp.ts` and import them back. uiSmoke's behaviour and pure-part tests are unchanged.
  - **measureChrome's main** (guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`).
    1. Refuse without `DISPLAY` or `WAYLAND_DISPLAY` (headful only, because headless rAF is not tied to the display).
    2. Refuse when `os.loadavg()[0] > MEASURE_LOAD_MAX`, printing `uptime`.
    3. For `--gpu rtx`, refuse unless `prime-run` is on PATH, and use it as the wrapper.
    4. Build (unless `--skip-build`), start its own preview, then launch Chrome headful with `chromeArgs`.
    5. Probe the renderer through `Runtime.evaluate` of a webgl2 context's `UNMASKED_RENDERER_WEBGL`, and refuse unless `gpuMatches`. With `--probe-only`, print the renderer and stop here (exit 0).
    6. Navigate to `/?spike=batch` or `/?flight=sp4a`, adding `&workers=4` and `&renderer=` when given.
    7. Poll `window.__wiSpike.result` or `window.__wiFlight.result` every second (timeout 15 min).
    8. Add `measuredBy: 'measureChrome'`, `loadAvg1Before`, `loadAvg1After` and `chromeVersion` to the result.
    9. Write the result, pretty-printed, to `docs/superpowers/specs/assets/sp4a/<outputName>`, and print its `verdict`.
    10. Stop only its own Chrome and preview, then remove the profile.
  - The routes do not exist until Tasks 8 and 30. This task ships the tool; Step 4 checks it against a stub.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Then `node test/tools/uiSmoke.ts`: expected the same pass count as on `main`. Then, on a quiet machine, `npm run measure:chrome -- --route spike --gpu iris --probe-only` and `… --gpu rtx --probe-only`: expected the lines `renderer: …Iris…` and `renderer: …NVIDIA…RTX…`, exit 0. This shows the headful launch and the GPU check on both real GPUs.
- [ ] **Step 5: Commit** `test(sp4a): extract the CDP helpers; measureChrome tool`.

---

### Task 3: `mesh/packing.ts`, the column payload type, `packing.glsl.ts`

**Files:**
- Create: `src/mesh/packing.ts`, `src/mesh/column.ts` (payload types and checks only, the assembly is Task 15), `src/render/materials/glsl/packing.glsl.ts`, `test/unit/packing.test.ts`, `test/unit/meshPayload.test.ts`

**Interfaces:**
- Produces, in `mesh/packing.ts`:
  - `interface PackField { readonly offset: number; readonly bits: number }`;
  - `PACK_LAYOUT`, deep-frozen:
    - `solid`: `layer {0,10}`, `face {10,3}`, `ao {13,2}`, `sky {15,4}`, `block {19,4}`, `tint {23,3}`, `flags {26,4}`;
    - `fluid`: `layer {0,10}`, `face {10,3}`, `sky {13,4}`, `block {17,4}`, `depth {21,4}`, `tint {25,3}`, `cornerDrop {28,4}`;
  - `interface SolidFields { layer; face; ao; sky; block; tint; flags }` and `interface FluidFields { layer; face; sky; block; depth; tint; cornerDrop }` (all `number`);
  - `packSolid(f: SolidFields): number` and `packFluid(f: FluidFields): number`. Both return a u32 (`>>> 0`) and throw a RangeError naming the field when a value is outside `[0, 2^bits)` or not an integer;
  - `unpackSolid(word: number): SolidFields` and `unpackFluid(word: number): FluidFields`.
- Produces, in `mesh/column.ts`:
  - `MESH_PASS_OPAQUE = 0`, `MESH_PASS_CUTOUT = 1`, `MESH_PASS_TRANSLUCENT = 2`, `ROW_INTS = 6`;
  - `interface ColumnMeshPayload { readonly cx: number; readonly cz: number; readonly versions: Int32Array /* 18 */; readonly connectivity: Uint16Array /* 24 */; readonly position: Uint8Array /* 4 per vertex */; readonly data: Uint32Array; readonly index: Uint32Array; readonly rows: Int32Array /* ROW_INTS per row: sy, pass, vertexStart, vertexCount, indexStart, indexCount */; readonly spheres: Float32Array /* 4 per row: x, y, z, r in section-local blocks */ }`;
  - `payloadProblem(p: ColumnMeshPayload): string | null`.
- Produces, in `packing.glsl.ts`: `packingGlsl(): string`, generated from `PACK_LAYOUT`. For each variant `S` or `F` and field `NAME`, it holds:
  - `#define PK_<V>_<NAME>_OFFSET <n>u` and `#define PK_<V>_<NAME>_MASK <2^bits − 1>u`;
  - a function `uint pk<V>_<name>(uint d) { return (d >> PK_<V>_<NAME>_OFFSET) & PK_<V>_<NAME>_MASK; }`.

- [ ] **Step 1: Write the tests.**
  - `packing.test.ts`:
    - a round-trip of every field at 0 and at its maximum, both variants;
    - a RangeError at maximum + 1, at −1 and at 0.5;
    - the fields of each variant tile bits 0-29 (solid) or 0-31 (fluid) without overlap;
    - the defines: parse every `#define PK_…_OFFSET`/`_MASK` of `packingGlsl()` and check they equal `PACK_LAYOUT` (14 fields × 2 defines);
    - for 1,000 words from `testRng(4001)`, the JS port `(w >>> off) & mask` of each parsed define equals `unpackSolid` and `unpackFluid`.
  - `meshPayload.test.ts`, with `payloadProblem`:
    - null on a valid two-row payload;
    - a message for each of these:
      - `rows.length % 6 ≠ 0`;
      - `spheres.length ≠ 4·rows`;
      - a vertex range past `data.length` or `position.length / 4`;
      - an index range past `index.length`;
      - an index ≥ its row's `vertexCount`;
      - `sy` outside 0-23;
      - `pass` outside 0-2;
      - `versions.length ≠ 18`;
      - `connectivity.length ≠ 24`.
- [ ] **Step 2: Run them.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** as the interfaces say. `packingGlsl` is plain string building. The GLSL module imports `mesh/packing` (render may import mesh).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): PACK_LAYOUT, the column mesh payload type, the packing GLSL`.

---

### Task 4: `daynight/dayNight.ts` and `render/lightmap.ts`

**Files:**
- Create: `src/daynight/dayNight.ts`, `src/render/lightmap.ts`, `test/unit/dayNight.test.ts`, `test/unit/lightmap.test.ts`

**Interfaces:**
- Produces, in `daynight/dayNight.ts`:
  - constants `DAY_LENGTH_MS = 1_200_000`, `OPENING_T = 1 / 12` (08:00), `SUN_TILT_DEG = 20` and `TIME_SPEEDS = [1, 10, 60, 0] as const`;
  - `type Phase = 'day' | 'dawn' | 'dusk' | 'night'` and `type Rgb = readonly [number, number, number]` (sRGB 0-1);
  - `sunDirection(t: number): [number, number, number]`: `(cos 2πt, sin 2πt·cos 20°, sin 2πt·sin 20°)`;
  - `sunElevationDeg(t: number): number`;
  - `phaseOf(t: number): Phase`: day when e ≥ 10, night when e ≤ −6; otherwise dawn when rising (t < 0.25 or t > 0.75), else dusk;
  - `dayFactor(t: number): number`: `smoothstep(−6, 10, e)`;
  - `duskFactor(t: number): number` **(plan)**: `e ≤ 0 ? smoothstep(−6, 0, e) : 1 − smoothstep(0, 10, e)`, 0 outside (−6°, 10°). It peaks at e 0;
  - `skyColors(t: number): { zenith: Rgb; horizon: Rgb }` **(plan)**:
    - `zenith = mix(#04070F, #3D78D6, dayFactor)`;
    - `horizon = mix(mix(#0D1526, #A8CCF5, dayFactor), #E8914D, duskFactor)`;
  - `clockHours(t: number): number`: `(6 + 24t) mod 24`;
  - `advanceTime(t: number, dtMs: number, speed: number): number`: wraps into [0, 1).
- Produces, in `render/lightmap.ts`:
  - `lightCurve(l: number): number`: `(l/15) / (3(1 − l/15) + 1)`;
  - `lightmapRgba(day: number, dusk: number, brightness: number, out: Uint8Array /* 1024 */): void`. The texel is (x = block, y = sky). The value is the per-channel max of these two terms:
    - sky: `curve(s)·mix(0.15, 1, day)·tint`, where `tint = mix(mix([0.45,0.55,0.85], [1,1,1], day), [1,0.8,0.65], dusk)`;
    - block: `curve(b)·[1, 0.85, 0.65]`.

    Brightness then gives `c' = mix(c, 1 − (1 − c)⁴, β)`, and the result is `round(255c')` with alpha 255;
  - `createLightmap(): { texture: DataTexture; update(day: number, dusk: number, brightness: number): void }`, a 16 × 16 RGBA8 texture with `NoColorSpace`, `NearestFilter` and no mipmaps.

- [ ] **Step 1: Write the tests.**
  - `dayNight.test.ts`:
    - the elevation is 0 at t 0 and t 0.5, 70 ± 1e-9 at t 0.25, −70 at t 0.75, and ≈ 28 (27.9-28.1) at `OPENING_T`;
    - `clockHours(OPENING_T)` is 8 and `clockHours(0.25)` is 12;
    - phases: day at e ≥ 10, night at e ≤ −6, dawn and dusk in between, each with the sign rule above; the dawn window lasts `(asin(sin 10° / cos 20°) − asin(sin −6° / cos 20°)) / 2π` of a day (checked numerically, ± 1e-6);
    - `dayFactor` is 0 at e ≤ −6 and 1 at e ≥ 10;
    - `duskFactor` is 1 at e 0 and 0 at e ≤ −6 and e ≥ 10;
    - `advanceTime(0.99, DAY_LENGTH_MS·0.02, 1)` is ≈ 0.01, and speed 0 leaves t unchanged.
  - `lightmap.test.ts`:
    - (sky 0, block 0) has luminance `0.2126R + 0.7152G + 0.0722B ≤ 0.02·255` at every t in steps of 1/96 and every brightness in {0, 0.3, 1};
    - every block-only texel (sky 0) is identical at every t;
    - the sky-15 texel is brighter at noon than at midnight;
    - `lightCurve(0)` is 0 and `lightCurve(15)` is 1;
    - `createLightmap().texture.colorSpace === NoColorSpace`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): day/night time model and the lightmap`.

**Master amendment:** §4.9's sentence of spec §14 ("the sun on a path tilted 20°, t 0 at sunrise, the world opening at 08:00; T cycles the time speed").

---

### Task 5: Flat colours, the texture array, and the Voxels palette

**Files:**
- Create: `src/textures/flatColors.ts`, `src/render/textureArray.ts`, `test/unit/flatColors.test.ts`
- Modify: `src/ui/crossSection/voxels.ts` (block colours from `FLAT_COLORS`), the packed_ice literal in `test/tools/uiSmoke.ts` if it mirrors one, `test/unit/crossSectionVoxels.test.ts` and any pinned packed_ice value; the committed review slices that show packed_ice (regenerated)

**Interfaces:**
- Produces, in `textures/flatColors.ts`: `FLAT_COLORS: ReadonlyMap<string, readonly [number, number, number]>`, one sRGB colour per block type name. These are today's `VOXEL_COLORS` block entries, with **packed_ice `[100, 146, 226]`**.
- Produces, in `render/textureArray.ts`:
  - `flatColorLayers(nameOfState: readonly string[]): Uint8Array`: RGBA, layer = state id, and `[255, 0, 255, 255]` for a name missing from `FLAT_COLORS`;
  - `createFlatColorArray(): DataArrayTexture`: 1 × 1 × `stateCount`, from `REGISTRY`'s state → type name, with `SRGBColorSpace`, `NearestFilter` and no mipmaps.
- `VOXEL_COLORS` keeps `sky`, `seaLevel`, `water` and `unknown`, and reads every block entry from `FLAT_COLORS`. Its shape and every importer stay unchanged.

- [ ] **Step 1: Write the tests.** In `flatColors.test.ts`:
  - packed_ice is `[100,146,226]`;
  - its summed |ΔRGB| is 155 from the sky `[168,204,255]`, at least 24 from every other block colour and 36 from `seaLevel`;
  - every registry block type has an entry;
  - `VOXEL_COLORS[name]` equals `FLAT_COLORS.get(name)` for every block;
  - `flatColorLayers` gives layer `stateOf('packed_ice')` = `[100,146,226,255]` and magenta for a missing name;
  - `createFlatColorArray()` has depth `stateCount` and `SRGBColorSpace`.

  Update the existing pins that held `[142,180,250]`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Then:
  1. Run `npx vitest run --project unit test/unit/reviewSlices.test.ts test/unit/png.test.ts`. For every committed slice it reports as changed, regenerate it with the command that test file names (`npm run docs:review-slices` for `assets/sp3e`; the same env with the SP's directory for earlier ones).
  2. Check, with a short throwaway script, that every changed pixel was packed_ice's old colour and is now its new one.
  3. List the regenerated files in the commit message.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): one flat-colour table for 3D and Voxels; packed_ice ice blue`.

---

### Task 6: Materials v1 and `core/params/graphicsPresets.ts`

**Files:**
- Create: `src/core/params/graphicsPresets.ts`, `src/render/frameState.ts`, `src/render/materials/index.ts`, `src/render/materials/uniforms.ts`, `src/render/materials/glsl/{common,terrain,water,sky}.glsl.ts`, `test/unit/materials.test.ts`, `test/unit/graphicsPresets.test.ts`

**Interfaces:**
- Produces, in `graphicsPresets.ts`:
  - `interface GraphicsPreset { readonly rd: number; readonly uploadBudgetMs: number; readonly uploadSections: number; readonly ao: boolean; readonly smoothLight: boolean; readonly water: 'fast'; readonly pixelRatioCap: number; readonly fogBand: number }`;
  - `MEDIUM: GraphicsPreset = { rd: 12, uploadBudgetMs: 2, uploadSections: 32, ao: true, smoothLight: true, water: 'fast', pixelRatioCap: 1, fogBand: 64 }`, frozen.
- Produces, in `render/materials/index.ts`:
  - `type MaterialVariant = 'batch' | 'mesh'`;
  - `interface MaterialSettings { readonly variant: MaterialVariant; readonly ao: boolean; readonly smoothLight: boolean }`;
  - `FrameState` lives in `render/frameState.ts`, **(plan)** outside `render/materials/`, because `ui` may not import from there, not even types: `interface FrameState { readonly t: number; readonly brightness: number; readonly eyeSky: number /* 0-15 */; readonly rd: number; readonly fogBand: number; readonly edgeCentre: readonly [number, number] /* load centre minus origin, x z */ }`. Neither `ui` nor `main` ever constructs a material; `render/renderer.ts` does (Task 23);
  - `interface MaterialSystem { readonly variant: MaterialVariant; readonly terrainOpaque: ShaderMaterial; readonly terrainCutout: ShaderMaterial; readonly water: ShaderMaterial; readonly sky: ShaderMaterial; readonly decodeDebug: ShaderMaterial; readonly lightmap: ReturnType<typeof createLightmap>; setFrameUniforms(f: FrameState): void; dispose(): void }`;
  - `createMaterialSystem(s: MaterialSettings, albedo: DataArrayTexture): MaterialSystem`;
  - `fogRange(rd: number, band: number): { start: number; end: number }`: `end = (rd − 0.5)·16`, `start = max(0, end − band)`;
  - `EDGE_FADE = 24`.
- Shaders (spec §6.4-§6.6), all `glslVersion: GLSL3`:
  - **The terrain vertex shader:**
    - reads `in vec3 position` (Uint8 in 1/8-block units; the instance or mesh matrix scales by 1/8, Task 7) and `in uint data`;
    - with `variant 'batch'`, includes `#include <batching_pars_vertex>` and `#include <batching_vertex>`;
    - with `'mesh'`, has `#define REGION_MESH` and no batching chunks;
    - decodes with `packingGlsl()` and passes `flat` the layer and face, and smooth the sky, block and AO factor.
  - **The terrain fragment shader:** `texture(albedo, vec3(0.5, 0.5, layer)) × faceShade × AO × texture(lightmap, (block, sky))`, then fog, then `#include <colorspace_fragment>`.
    - faceShade: up 1, down 0.5, north and south 0.8, east and west 0.6, by `kinds.ts`' face ids;
    - AO factor from `ao2`: `[1, 0.8, 0.6, 0.45]`, or 1 when `ao` is off;
    - fog factor `max(smoothstep(fogStart, fogEnd, length(viewPos)), smoothstep(edge − 24, edge, horizontal distance from edgeCentre))`, colour `skyColor(horizonDir) × lightmap(eyeSky, 0)`.
  - **Water (Fast):**
    - transparent, `depthWrite` true, `side` DoubleSide;
    - alpha 0.72;
    - colour `mix(shallow [64,128,230], deep [16,40,96], depth/15)` (sRGB uniforms converted to linear on the CPU) × lightmap, then fog;
    - the top face sits at `y + 8/9` through `cornerDrop`'s ninths.
  - **Sky:** a full-screen triangle at the far plane (`gl_Position.z = gl_Position.w`), `depthWrite` false, view ray from the inverse projection, and `skyColor(dir)` from `common.glsl.ts`: the gradient between the `skyColors(t)` uniforms plus a sun disc of 2° radius with a glow to 12°.
  - **`decodeDebug`:** writes the `data` word's 4 bytes as RGBA (`flat out uint`), with no colour-space chunk, for the spike's exactness test.
  - **Uniform colour spaces:** `albedo` keeps `SRGBColorSpace` and `lightmap.texture` `NoColorSpace`.

- [ ] **Step 1: Write the tests.**
  - `graphicsPresets.test.ts`: `MEDIUM` equals the literal above and is frozen.
  - `materials.test.ts` (three in Node, no renderer):
    - every material has `glslVersion === GLSL3`;
    - batch terrain and water vertex shaders contain both batching includes; mesh ones contain `#define REGION_MESH` and neither include;
    - terrain and water fragments contain `#include <colorspace_fragment>` and `length(viewPos)`; `decodeDebug`'s contains no colour-space chunk;
    - every shader that decodes contains `packingGlsl()` verbatim;
    - the water material is transparent with `depthWrite` true and its alpha uniform 0.72;
    - `fogRange(12, 64)` is `{start:120, end:184}`, `fogRange(8, 64)` is `{56, 120}` and `fogRange(4, 64)` is `{0, 56}`;
    - after `setFrameUniforms` with rd 12, the edge uniform is 184 and its fade starts at 160;
    - the albedo uniform's texture has `SRGBColorSpace` and the lightmap's `NoColorSpace`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `uniforms.ts` holds the shared uniform objects, so every material sees one update per frame.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (arch: GLSL only under `render/materials/`).
- [ ] **Step 5: Commit** `feat(sp4a): materials v1 (terrain, Fast water, sky) and the Medium graphics preset`.

**Master amendments:** §4.6's fog values; §4.16 and §1's `graphicsPresets.ts` "created by SP4a with the Medium fields it uses; SP8c adds the audio rows, SP11 the other rows".

---

### Task 7: `SectionRenderer`, RegionBatch, and the contract suite

**Files:**
- Create: `src/render/sectionRenderer.ts`, `src/render/regionBatch.ts`, `test/unit/fixtures/payloads.ts`, `test/unit/sectionRendererContract.ts`, `test/unit/regionBatch.test.ts`

**Interfaces:**
- Consumes: `ColumnMeshPayload`, `ROW_INTS` and the `MESH_PASS_*` constants (Task 3); `createMaterialSystem` (Task 6).
- Produces, in `sectionRenderer.ts`:
  - `type SectionRendererKind = 'batch' | 'mesh'`;
  - `regionOf(cx: number, cz: number): [number, number]`: `[cx >> 3, cz >> 3]`;
  - `interface SectionRendererCounts { readonly expectedColumns: number; readonly stagedColumns: number; readonly regions: number; readonly builtRegions: number; readonly sections: number; readonly vertices: number; readonly indices: number; readonly mergeMs: number /* RegionMesh's merge time; 0 for RegionBatch */ }`;
  - `interface SectionRenderer`:
    - `readonly kind: SectionRendererKind`;
    - `readonly root: Group`;
    - `expect(columns: ReadonlyArray<readonly [number, number]>): void`;
    - `stage(p: ColumnMeshPayload): void`;
    - `buildNext(exhausted: () => boolean): number`;
    - `revealAll(): void`;
    - `setOrigin(x: number, y: number, z: number): void`;
    - `sortTranslucent(camX: number, camY: number, camZ: number): void`, a no-op for RegionBatch (BatchedMesh sorts itself) that RegionMesh fills in (Task 22);
    - `counts(): SectionRendererCounts`;
    - `dispose(): void`;
  - `selectSectionRenderer(report: { readonly multiDraw: boolean }, override: SectionRendererKind | null): SectionRendererKind`;
  - `createSectionRenderer(kind: SectionRendererKind, materials: MaterialSystem): SectionRenderer`. It throws unless `materials.variant` is `'batch'` for kind `'batch'` and `'mesh'` for kind `'mesh'`. The `'mesh'` branch throws "RegionMesh arrives in Task 22" until then.
- Semantics:
  - `buildNext` builds, nearest region first, every region whose expected columns are all staged. It checks `exhausted()` before each region and returns the number of sections added.
  - Every built object starts hidden (`root.visible` false until `revealAll`).
  - Section origin = `(cx·16, sy·16 − 64, cz·16)`.
  - Geometry units are 1/8 block. The instance or mesh matrix is `T(origin − floatingOrigin) · S(1/8)`, and `geometry.boundingSphere` is the payload sphere × 8.
- `regionBatch.ts` (spec §6.2):
  - per region, one `BatchedMesh` per pass that has geometry, sized exactly: instances = sections, vertices and indices = sums;
  - per section, a `BufferGeometry` with `position` = `BufferAttribute(Uint8Array subarray, 4)`, `data` = `BufferAttribute(Uint32Array subarray, 1)` and the index subarray. The bounding sphere and box are set **before** `addGeometry`; then `addInstance` and `setMatrixAt`;
  - `perObjectFrustumCulled` and `sortObjects` true;
  - the materials come from the system with `variant 'batch'`.

- [ ] **Step 1: Write the tests.**
  - `fixtures/payloads.ts`: `fakePayload(cx, cz, rows: Array<{ sy: number; pass: 0|1|2; quads: number }>): ColumnMeshPayload`, valid under `payloadProblem`.
  - `sectionRendererContract.ts` exports `sectionRendererContract(kind: SectionRendererKind)`, a describe block with these cases:
    - "nothing is built before every expected column of a region is staged";
    - "buildNext respects exhausted() between regions and returns the sections added";
    - "the root stays hidden until revealAll, then every built object is visible in the same call";
    - "counts: expected, staged, built, sections, vertices and indices equal the staged payloads' sums";
    - "setOrigin rebases every matrix: translation = section or region origin − origin, scale 1/8";
    - "dispose frees every geometry".
  - `regionBatch.test.ts` runs `sectionRendererContract('batch')`, plus:
    - "position is a Uint8 itemSize-4 attribute and data a Uint32 itemSize-1 attribute";
    - "each geometry's boundingSphere equals the payload sphere × 8 and is set before addGeometry" (spy on `addGeometry`);
    - "a region's BatchedMesh is sized exactly (maxInstanceCount, maxVertexCount, maxIndexCount)";
    - "no BatchedMesh for a pass without geometry";
    - "perObjectFrustumCulled and sortObjects are on".
  - In `selectSectionRenderer`: multiDraw true → `'batch'`, false → `'mesh'`, and the override wins both ways.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): SectionRenderer and RegionBatch, with the contract suite`.

---

### Task 8: The spike (`?spike=batch`): the page, the store spike, and the Chrome cells (gate)

**Files:**
- Create:
  - `src/render/frameTiming.ts`, `src/render/spike/stressScene.ts`, `src/render/spike/spikeBench.ts`;
  - `src/engine/spikeStore.ts`, `src/workers/spikeStore.worker.ts`;
  - `src/ui/spike/spikePage.ts`, `src/ui/spike/verdict.ts`;
  - `test/unit/frameTiming.test.ts`, `test/unit/stressScene.test.ts`, `test/unit/spikeVerdict.test.ts`, `test/unit/spikeStore.test.ts`.
- Modify: `src/main.ts` (route `?spike=batch`), `src/workers/protocol.ts` (the spike store messages, outside `ToWorker`)
- Commit: `docs/superpowers/specs/assets/sp4a/spike-chrome-iris.json` and `spike-chrome-rtx.json`; the spec's new "Spike evidence" section

**Interfaces:**
- Produces, in `render/frameTiming.ts`:
  - `snapFrameTime(delta: number, interval: number): number`. Within ±1 ms of a multiple k ≥ 1 of `interval` it returns k·interval; otherwise it returns `delta` unchanged;
  - `percentile(values: ArrayLike<number>, p: number): number`, by nearest rank;
  - `medianInterval(deltas: ArrayLike<number>): number`.
- Produces, in `render/spike/stressScene.ts`: `stressPayloads(seed?: number): ColumnMeshPayload[]`. It is deterministic and covers the RD12 mesh disc around (0, 0), 489 columns.
  - Per column: non-trivial sections at sy 3-10, and quads drawn so that the column median is 1,500 and the total is 0.70-0.80 M quads.
  - Mixed quad sizes 1-16 blocks; every packed field exercised; water rows (pass 2) on 30 % of the columns.
  - Spheres that contain their vertices.
- Produces, in `render/spike/spikeBench.ts`: `runRenderSpike(host: HTMLElement, o: { readonly kind: SectionRendererKind; readonly maskMultiDraw: boolean }): Promise<RenderSpikeResult>`. It covers items 1-5 of spec §1.2:
  1. **decode:** 1,024 known words drawn as 1,024 single-pixel quads into a 32 × 32 RGBA8 `WebGLRenderTarget` with `decodeDebug`, read back by `readRenderTargetPixels`; the result counts `mismatches`;
  2. **static:** a 1920 × 1080 canvas, pixel ratio 1, the camera at (0, 100, 0) with pitch −10° and yaw turning 360° over 600 frames after 120 warm-up frames. It records frame p50, p95 and max (snapped), draw calls (`renderer.info.render.calls` max), and main-thread ms p95 (from the callback start to `render()`'s return);
  3. **upload:** `addGeometry` ms per 1k quads, and the first-render upload ms. **(plan)** The projection is `projectedRd12Seconds = ceil((msPer1kQuads·750 + firstRenderMs) / 12) / 60`;
  4. **churn:** 32 `setGeometryAt` per frame for 120 frames (main p95), 32 deletes and re-adds, `optimize()` per region (ms, MB) and `setGeometrySize` ×1.5 (ms);
  5. **noMultiDraw:** the same static run on a renderer built over a wrapped `webgl2` context whose `getExtension('WEBGL_multi_draw')` returns null, recording draw calls and p95. Where `multiDraw` is false (Firefox), items 2 and 5 run on the section renderer the probe selects.
- Produces, in `engine/spikeStore.ts`: `runStoreSpike(workers = 6, columnsPerWorker = 32): Promise<StoreSpikeResult>`, where `StoreSpikeResult` is `{ reservedBlockMiB, reservedByteMiB, grewTo: { blockMiB, byteMiB }, crossReadsOk: number, crossReadsTotal: number, errors: string[] }`.
  - The page calls `createStore({shared: true})` with the default maxima and posts its handles to 6 module workers (`spikeStore.worker.ts`).
  - Each worker attaches and claims its own columns (worker i: cx = i, cz = 0 … 31). It writes 24 dense sections with a fill derived from (cx, cz), which forces pool growth, and commits 1.
  - Each worker then checksums a column written by worker (i + 1) mod 6, and the page checksums every column.
  - The message types live in `workers/protocol.ts` as `SpikeStoreToWorker` and `SpikeStoreFromWorker` (not in `ToWorker`).
- Produces, in `ui/spike/verdict.ts`: `spikeVerdict(r: SpikeResult): { gatePass: boolean; basicPass: boolean; failures: string[] }` (spec §1.3).
  - `basicPass` means decode mismatches 0 and no store error.
  - `gatePass` means basicPass, static p95 ≤ 16.7, draw calls ≤ 100, main p95 ≤ 3 and projected RD12 seconds ≤ 2.
- Produces, in `ui/spike/spikePage.ts`: `mountSpikePage(root)`.
  - It probes the capabilities and runs the store spike, then the render spike with `selectSectionRenderer(report, ?renderer)`.
  - It sets `window.__wiSpike.result` = `{ route: 'spike', capability report (renderer string as reported, multiDraw, timerQuery), sectionRenderer, userAgent, screen, dpr, items: {decode, static, upload, churn, noMultiDraw}, store, verdict }`.
  - It shows a "Download JSON" button.

- [ ] **Step 1: Write the tests.**
  - `frameTiming.test.ts`:
    - `snapFrameTime(16.9, 16.667)` is 16.667 and `snapFrameTime(33.0, 16.667)` is 33.333;
    - `snapFrameTime(20, 16.667)` is 20;
    - `percentile([1..100], 95)` is 95.
  - `stressScene.test.ts`:
    - 489 columns, each payload valid by `payloadProblem`;
    - section count 3,000-4,000, total quads 0.70-0.80 M, column median 1,400-1,600;
    - water rows on 25-35 % of columns;
    - the same seed gives byte-equal payloads.
  - `spikeVerdict.test.ts`:
    - a passing fixture gives `gatePass` true;
    - each single criterion breached (p95 16.8, draw calls 101, main 3.1, projected 2.1 s, one mismatch, a store error) fails with a message naming it;
    - `basicPass` ignores the frame criteria.
  - `spikeStore.test.ts` (Node, `worker_threads` through the existing `nodeWorker` bundling): `runStoreSpike`'s worker logic, with an injected worker factory, gives `crossReadsOk === crossReadsTotal`, no error, and the pools grow past 1 MiB.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `?spike=batch` route to `main.ts`; `?renderer=batch|mesh` passes through.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS. Then check the page by hand in the dev build with your own Chrome profile: `__wiSpike.result` appears and no console error.
- [ ] **Step 5: Measure the Chrome cells (quiet machine).**
  - Run `npm run measure:chrome -- --route spike --gpu iris`. Expected: `spike-chrome-iris.json` is written and its `verdict.gatePass` is true.
  - **If it is false: STOP.** Commit the JSON, and report the failures and the numbers to the controller. The controller takes spec §1.3's fail branches to the user before any other task. For a fail of item 2, also record the levers §1.3 lists (pixel ratio 0.85, no translucent pass, merged per-region buffers).
  - Then run `npm run measure:chrome -- --route spike --gpu rtx`. Expected: `spike-chrome-rtx.json` with `basicPass` true. Its frame figures are recorded. A false `basicPass` is reported to the controller (the user decides) but does not stop the plan.
- [ ] **Step 6: Spec evidence.** Add a "### Spike evidence" section to spec §1. It holds a table of the two Chrome cells: renderer string, section renderer, decode, static p50/p95/max, draw calls, main p95, projected upload seconds, churn, noMultiDraw and store. It also lists the Firefox cells as "pending (Task 33)".
- [ ] **Step 7: Commit** `feat(sp4a): the week-1 spike (?spike=batch) and its Chrome cells`.

**Gate:** the controller dispatches Task 9 only after `spike-chrome-iris.json` shows `gatePass` true.

---

### Task 9: Store: `reopenColumn`, `setLight`, per-channel versions, attach asserts

**Files:**
- Modify: `src/world/store/api.ts` (`ColumnWriter.setLight`, the thread-contract doc, `commit`'s doc), `src/world/store/store.ts`, `src/world/store/pool.ts` (`attachPool` assert)
- Test: `test/unit/storeReopen.test.ts` (new), plus the existing store tests as they are

**Interfaces:**
- Produces:
  - `VoxelStore.reopenColumn(cx: number, cz: number, from: 1 | 2): ColumnWriter`:
    - it throws `Error('reopenColumn: (cx, cz) is not at status <from>')` unless the record holds (cx, cz) at status `from`;
    - it clears nothing;
    - its `aux()` and `auxB()` return the record's existing slots, allocating only when there are none.
  - `ColumnWriter.setLight(sy: number, light: Uint8Array): void` stores the light channel (uniform or dense) and throws `Error('light already written')` when the entry holds a slot.
  - `commit(status)`:
    - `blockVersion += 1` when the writer called `setProto`, `setFinal` or `shareFinal`;
    - `lightVersion += 1` when it called `setFinal` or `setLight`, or `shareFinal` with any non-zero light byte;
    - then the status is stored, last.
  - `attachStore` and `attachPool` throw `TypeError` when `shared` and a buffer is not a `SharedArrayBuffer`, or when not shared and it is not an `ArrayBuffer`.

- [ ] **Step 1: Write `storeReopen.test.ts`.**
  - "T's commit: blockVersion 1, lightVersion 0".
  - "reopenColumn(1) on a Proto column; D's shareFinal with an all-zero light then commit(2): blockVersion 2, lightVersion 0, status 2".
  - "reopenColumn(2); 24 × setLight then commit(3): lightVersion 1, status 3, `final().light` reads the written bytes".
  - "reopenColumn throws on an absent column, on another column's record, and on a status other than `from`".
  - "reopenColumn clears nothing: proto and final entries and aux bytes unchanged".
  - "the reopened writer's aux() returns the record's existing slot (same bytes, no allocation: blockPool and bytePool used counts unchanged)".
  - "setLight over a dense light entry throws 'light already written'; over a uniform entry it frees no slot".
  - "attachStore with shared true and an ArrayBuffer table throws TypeError; with shared false and a SharedArrayBuffer throws".
  - "versions() reflects both channels".
- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/storeReopen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The writer keeps two flags (`wroteBlocks`, `wroteLight`). `bumpLightVersion` already exists (`columnTable.ts:173`). Reword the `api.ts` writer doc: one writer per column, chosen by the coordinator's states; no concurrent `freeColumn` during an SP4a session (spec §2.6).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check (Global Constraints). Expected: PASS, and no change to `goldens.json`.
- [ ] **Step 5: Commit** `feat(sp4a): reopenColumn, setLight, per-channel versions, attach asserts`.

**Master amendments:** §2.5's `setLight` line and `commit`'s comment (spec §14; the masterSpec test requires §2.5 to name every `api.ts` method); §2.3's "versions: Atomics.add on every committed change of that channel (SP4a)".

---

### Task 10: `effOpacity`, the fall predicate, `world/store/padded.ts`

**Files:**
- Modify: `src/world/blocks/light.ts`
- Create: `src/world/store/padded.ts`, `test/unit/effOpacity.test.ts`, `test/unit/padded.test.ts`

**Interfaces:**
- Produces, in `world/blocks/light.ts`:
  - `effOpacity(state: number, fluid: number): number`: `max(OPACITY[state], fluidType(fluid) ≠ 0 ? 1 : 0)`;
  - `effEmit(state: number, fluid: number): number`: `max(EMIT[state], fluidType = lava ? 15 : 0)`;
  - `fallBlocked(state: number, fluid: number, stateAbove: number): boolean`: true when `effOpacity > 0`, or `FULL_FACES[state]` has the up bit, or `FULL_FACES[stateAbove]` has the down bit.
  - Each takes optional tables `(…, t: { opacity, fullFaces, emit } = DEFAULT)` for the injected-table tests.
- Produces, in `world/store/padded.ts`:
  - **Section layout:**
    - `PAD = 18` and `PAD_VOXELS = 5832`;
    - `padIndex(x: number, y: number, z: number): number` for x, y, z in −1 … 16, returning `(y+1)·324 + (z+1)·18 + (x+1)`;
    - `interface PaddedSection { readonly blocks: Uint16Array; readonly light: Uint8Array; readonly fluid: Uint8Array }` and `createPaddedSection()`;
    - `copyPaddedSection(nb: NeighborhoodReader, sy: number, out: PaddedSection): void`. It reads the final sets of the 3 × 3 columns. Below y −64 the blocks are `BEDROCK`, the light is 0 and there is no fluid. Above y 319 the blocks are air with sky 15 (`0xF0`).
  - **Light region layout:**
    - `LIGHT_W = 46`, `LIGHT_H = 384` and `LIGHT_LO = −15`;
    - `lightIndex(x: number, y: number, z: number): number`, with x and z in [−15, 31) column-local and y in [−64, 320);
    - `interface LightRegion { readonly blocks: Uint16Array; readonly fluid: Uint8Array; readonly light: Uint8Array; readonly lightBlocking: Int16Array /* 46·46 */ }` and `createLightRegion()`;
    - `copyLightRegion(nb: NeighborhoodReader, out: LightRegion): void`, which reads the final blocks and fluid and each column's aux `lightBlocking`.
  - Uniform sections are copied with a fill.

- [ ] **Step 1: Write the tests.**
  - `effOpacity.test.ts`:
    - for air + water `effOpacity` is 1, for stone 15 and for air 0;
    - `effEmit` of air + lava is 15;
    - `fallBlocked`: true for water, true for stone, false for air under air;
    - with an injected table, a bottom slab (FULL_FACES down only) blocks the voxel below it through `stateAbove`'s down bit.
  - `padded.test.ts`, on a hand-built shared store whose 3 × 3 columns have distinct uniform and dense sections:
    - `copyPaddedSection` equals per-voxel `final().block/light/fluid` at every padded position, including the corners and edges;
    - below the world it reads BEDROCK with light 0; above it, air with light 0xF0;
    - `copyLightRegion` equals per-voxel reads at 2,000 random positions and the corners, and `lightBlocking` equals the aux values;
    - `padIndex(−1, −1, −1)` is 0 and `padIndex(16, 16, 16)` is 5831.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `world/blocks/**` uses top-level const aliases of imported values. `padded.ts` reads through `NeighborhoodReader` and `ColumnView.sectionBlocks` / `sectionFluid` (plus the final light entries through `light()`, or a section-light accessor if you add one to `ColumnView`; if you do, add it to master §2.5 too).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS (arch: `padded.ts` is the store file light and mesh may import).
- [ ] **Step 5: Commit** `feat(sp4a): effective opacity and the fall predicate; padded.ts`.

**Master amendments:** §2.2's sentence (spec §14); §4.8's "stepping −max(1, effective opacity)".

---

### Task 11: The D skeleton and the final heightmaps

**Files:**
- Create: `src/gen/pipeline/decorateStage.ts`, `src/gen/pipeline/finalHeightmaps.ts`, `src/workers/worldJobs.ts` (D only, for now), `test/unit/decorateStage.test.ts`, `test/unit/finalHeightmaps.test.ts`

**Interfaces:**
- Produces:
  - `decorateStage(ctx: GenContext, nb: NeighborhoodReader, w: ColumnWriter, stop: () => boolean): boolean`. It iterates the nine source columns and the (empty) step list, polling `stop` between steps. Then it calls `w.shareFinal(sy, ZERO_LIGHT)` for sy 0-23 and `writeFinalHeightmaps`. It returns false when stopped.
  - `writeFinalHeightmaps(blockAt: (lx: number, y: number, lz: number) => number, fluidAt: (lx: number, y: number, lz: number) => number, aux: AuxView): void`. It works top-down per position and gives `y + 1` of the highest qualifying voxel, or −64:
    - `worldSurface`: state ≠ air or fluid ≠ 0;
    - `oceanFloor`: `COLLIDE[state]` ≠ none;
    - `motionBlocking`: `COLLIDE` ≠ none or fluid ≠ 0;
    - `lightBlocking`: the highest voxel with `fallBlocked(state, fluid, stateAbove)`.
  - `fillColumnD(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean): boolean`, in `workers/worldJobs.ts`: `reopenColumn(cx, cz, 1)`, then `decorateStage` over `store.neighborhood(cx, cz)`, then `commit(2)`. A stop or a throw leaves the column at status 1, since the writer has written nothing before the shares.
- `tintTH` stays 0 and `decorate`'s version stays 1.

- [ ] **Step 1: Write the tests.**
  - `finalHeightmaps.test.ts`, on canned columns:
    - open sea: `motionBlocking` = water top + 1, `oceanFloor` = floor + 1, `lightBlocking` = water top + 1;
    - a floating run over air at y 200-210: all four are 211;
    - an all-air column: all −64;
    - bedrock only: 63 + … as computed (y −64 bedrock gives −63).
  - `decorateStage.test.ts`, on a 3 × 3 shared store filled to T by `fillColumnT`, then `fillColumnD` on the centre:
    - status 2, `blockVersion` 2, `lightVersion` 0;
    - final blocks and fluid equal proto at every voxel;
    - every dense proto slot now has refcount 2;
    - `worldSurface` equals `worldSurfaceWG` and `oceanFloor` equals `oceanFloorWG` at every position (zero features);
    - `tintTH` all 0;
    - a stop before the shares leaves status 1 and the versions unchanged;
    - `STAGES`' decorate version is 1.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** under gen's rules: aliases, no numeric exports, and `ZERO_LIGHT` local and unexported.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS, and `goldens.json` unchanged.
- [ ] **Step 5: Commit** `feat(sp4a): the D skeleton and the final heightmaps`.

**Master amendments:** §3.0 and §3.12's D sentence; §2.3's `LIGHT_BLOCKING` "1 + the highest voxel the fall does not enter" (spec §14).

---

### Task 12: The light job (`light/queue.ts`, `light/initial.ts`)

**Files:**
- Create: `src/light/queue.ts`, `src/light/initial.ts`, `test/harness/refs.ts` (the light reference; Task 17 adds the face count), `test/unit/lightQueue.test.ts`, `test/unit/lightInitial.test.ts`
- Modify: `src/workers/worldJobs.ts` (`fillColumnL`)

**Interfaces:**
- Produces, in `light/queue.ts`: `createLightQueue(capacity: number): LightQueue`, where `capacity` is a power of two and `LightQueue` is `{ push(i: number): void; pop(): number; readonly length: number; clear(): void }`. It is an Int32 ring; `push` throws on overflow.
- Produces, in `light/initial.ts`:
  - `interface LightTables { readonly opacity: Uint8Array; readonly fullFaces: Uint8Array; readonly emit: Uint8Array }` and `DEFAULT_LIGHT_TABLES`;
  - `interface LightScratch { readonly region: LightRegion; readonly queue: LightQueue; readonly out: Uint8Array /* 4096 */ }` and `createLightScratch()`, allocated once per worker;
  - `lightRegion(s: LightScratch, t?: LightTables): void`. It writes `s.region.light` (spec §4.2 steps 2-3):
    - sky 15 at y ≥ `lightBlocking` per position;
    - seeds only at the boundary (a 15 voxel with a non-15 enterable neighbour);
    - the sky BFS, then the block BFS from voxels with `effEmit > 0`;
    - crossing from u to v through face f unless `fullFaces[u]` has f or `fullFaces[v]` has the opposite face;
    - the level entering v is `level(u) − max(1, effOpacity(v))`, floored at 0;
  - `centreSection(s: LightScratch, sy: number): Uint8Array`, the centre column's section into `s.out`.
- Produces, in `workers/worldJobs.ts`: `fillColumnL(store: VoxelStore, cx: number, cz: number, s: LightScratch, stop: () => boolean): Int32Array | null`. It does, in order: read the 3 × 3 `versions()`, `reopenColumn(2)`, `copyLightRegion`, `lightRegion`, 24 × `setLight(sy, centreSection(s, sy))` and `commit(3)`. It returns the versions, or null when stopped (polling between the copy, the BFS and the writes).
- Produces, in `test/harness/refs.ts`: `referenceLight(box: { x0: number; z0: number; w: number; h: number }, blockAt: (x: number, y: number, z: number) => number, fluidAt: (x: number, y: number, z: number) => number, t?: LightTables): Uint8Array`. This is the global reference: the fall from y 319 per position by `fallBlocked`, then a plain FIFO BFS over the whole box, with no heightmaps and no padding, and the box's outside treated as opaque.

- [ ] **Step 1: Write the tests.**
  - `lightQueue.test.ts`: FIFO order through a wrap, `length`, and the overflow throw.
  - `lightInitial.test.ts`:
    - "open sky: every voxel at or above the surface + 1 reads sky 15";
    - "sky 14, 13, 12 at 1-3 blocks under open still water";
    - "a sealed cavity reads 0";
    - "a 1-wide shaft lights sideways by −1 per block";
    - "FULL_FACES crossing with an injected bottom-slab table";
    - "block BFS from an injected emitter (emit 14) and from air + lava (15) falls by 1 per block";
    - "the centre equals referenceLight on 3 × 3 synthetic columns (terrain with an overhang, water, a floating slab with its shadow)";
    - "uniform outputs: an open-sky section stores no slot (descriptor 0xF0), a sealed rock section 0";
    - "fillColumnL: status 3, lightVersion 1, and the returned versions equal the 3 × 3 versions read before".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Index arithmetic follows `lightIndex`. The queue holds voxel indices, and the six neighbours come from stride offsets with explicit bounds checks.
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then the goldens check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): the exact initial light job`.

---

### Task 13: The greedy mesher (`mesh/builder.ts`, `mesh/greedy.ts`)

**Files:**
- Create: `src/mesh/builder.ts`, `src/mesh/greedy.ts`, `test/unit/fixtures/padded.ts`, `test/unit/meshGreedy.test.ts`

**Interfaces:**
- Produces, in `mesh/builder.ts`: `createMeshBuilder(): MeshBuilder`, where `MeshBuilder` has:
  - `reset(): void`;
  - `quad(pass: 0 | 1 | 2, corners: ArrayLike<number> /* 12: x, y, z of v0…v3 in 1/8 units, CCW seen from the face's outside */, data: ArrayLike<number> /* 4 words */, flip: boolean): void`. It writes two triangles: (0,1,2)(0,2,3), or with `flip` (1,2,3)(1,3,0);
  - `view(pass): { position: Uint8Array; data: Uint32Array; index: Uint32Array; vertices: number; indices: number }`;
  - growable arrays with no per-call allocation.
- Produces, in `mesh/greedy.ts`:
  - `interface MeshTables { readonly pass: Uint8Array; readonly fullFaces: Uint8Array; readonly tint: Uint8Array }` and `DEFAULT_MESH_TABLES`;
  - `interface MeshOptions { readonly ao: boolean; readonly smoothLight: boolean }`;
  - `AO_FACTORS = [1, 0.8, 0.6, 0.45]`;
  - `meshSolid(p: PaddedSection, o: MeshOptions, b: MeshBuilder, t?: MeshTables): void`, covering spec §5.2-§5.5:
    - **visibility:** an opaque face is drawn against a non-occluder; a cutout face against a non-occluder of another block; the neighbour occludes when it is PASS opaque with the facing bit in `fullFaces`;
    - **AO:** `ao2 = (s1 ∧ s2) ? 3 : s1 + s2 + c` on the face's air side, where "opaque" means PASS opaque with `fullFaces` 63;
    - **smooth light:** per channel, `v = ⌊(2·sum + n) / (2n)⌋` over F and the non-opaque edge and corner voxels, the corner skipped when both edges are opaque;
    - **flip (plan):** split along v1-v3 when `AO_FACTORS[ao2 v1] + AO_FACTORS[ao2 v3] > AO_FACTORS[ao2 v0] + AO_FACTORS[ao2 v2]`, else along v0-v2 (project 09's rule, `09-density-terrain/src/mesher.ts:330-332`);
    - **merge:** per axis and slice, a 16 × 16 mask of two u32 keys, `(layer, tint, flags, face, ao×4)` and `(sky×4, block×4)`; a quad merges only when both keys are equal;
    - **with `ao` off:** `ao2` is 0; **with `smoothLight` off:** F's light on every vertex;
    - `layer` is the state id, `tint` is `TINT[state]` and `flags` is 0.

- [ ] **Step 1: Write the tests.** `fixtures/padded.ts` builds a `PaddedSection` from a small text map, or from a per-voxel function. `meshGreedy.test.ts`:
  - "one stone in air: 6 quads, faces 0-5, ao2 0, light from each air neighbour";
  - "a stone against an opaque neighbour has no face there";
  - "a 16 × 16 flat floor with uniform light merges into 1 top quad";
  - "a floor with one darker voxel does not merge across it (keys differ)";
  - "AO table: a canned 3 × 3 × 3 per case: (s1 s2 c) = (0 0 0) → 0, (1 0 0) → 1, (1 0 1) → 2, (1 1 0) → 3, (1 1 1) → 3";
  - "diagonal flip: corner ao2 (0, 3, 0, 3) splits along v0-v2 and (3, 0, 3, 0) along v1-v3";
  - "smooth light: samples F 15, edges 12 and 9, corner 6 give ⌊(2·42 + 4)/8⌋ = 11; with both edges opaque the corner is skipped (n = 1: 15)";
  - "a column-border seam: the face toward the neighbour column is culled against its opaque voxel and drawn against its air";
  - "below the world (y −1 padding) is opaque: no bottom faces at sy 0; above the world is sky 15";
  - "noAo: ao2 0 on every vertex and F's light";
  - "injected cutout table: leaves against leaves are drawn, cutout pass 1";
  - "every emitted word unpacks to in-range fields".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): the padded greedy mesher with AO and smooth light`.

---

### Task 14: Still water (`mesh/fluid.ts`) and connectivity (`mesh/connectivity.ts`)

**Files:**
- Create: `src/mesh/fluid.ts`, `src/mesh/connectivity.ts`, `test/unit/meshFluid.test.ts`, `test/unit/connectivity.test.ts`

**Interfaces:**
- Produces:
  - `meshFluid(p: PaddedSection, b: MeshBuilder, t?: MeshTables): void` (spec §5.6):
    - water faces are drawn against non-occluders that are not water; a surface voxel's top face sits at y + 8/9 (`cornerDrop` 1);
    - side top corners take the drop of the surface they meet;
    - `depth` is the count of fluid voxels from the surface down to the first non-fluid voxel, clamped to 15, read in the padded view;
    - greedy keys `(face, sky×4, block×4, depth, cornerDrop×4)`, pass 2.
  - `connectivity15(p: PaddedSection, t?: MeshTables): number` (spec §5.7). Bit k is set when a 6-connected path through non-opaque voxels of the section (opaque meaning PASS opaque with `fullFaces` 63) joins the k-th of the 15 unordered face pairs, in lexicographic pair order (0,1), (0,2) … (4,5) **(plan)**. All air gives `0x7FFF` and all opaque gives 0.

- [ ] **Step 1: Write the tests.**
  - `meshFluid.test.ts`:
    - "an open sea section: one merged top quad at y + 8/9 per 16 × 16 slice where depth > 15";
    - "a shore: sides against air only, none against water or stone";
    - "depth counts from the surface to the floor";
    - "pass 2 only";
    - "a still source's cornerDrop is 1 on its four top corners".
  - `connectivity.test.ts`:
    - all air → 0x7FFF; all stone → 0;
    - an x-axis tunnel through stone → only the west-east bit;
    - an L-shaped tunnel north → up → only that pair;
    - two separate pockets → no pair;
    - pair order pinned: bit 0 = (north, east).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): still-water mesher and section connectivity`.

---

### Task 15: The column mesh payload (`mesh/column.ts` assembly, `meshColumnJob`)

**Files:**
- Modify: `src/mesh/column.ts`, `src/workers/worldJobs.ts`
- Create: `test/unit/meshColumn.test.ts`

**Interfaces:**
- Produces, in `mesh/column.ts`:
  - `interface MeshScratch { readonly padded: PaddedSection; readonly builder: MeshBuilder }` and `createMeshScratch()`;
  - `isTrivial(nb: NeighborhoodReader, sy: number): 0 | 1 | 2` **(plan)**: 0 for a non-trivial section, 1 for all-air (uniform air without fluid, with its six neighbours the same), 2 for all-opaque (uniform opaque full cubes, with the six neighbours too). It reads the descriptors only, with no copy;
  - `meshColumnPayload(nb: NeighborhoodReader, s: MeshScratch, o: MeshOptions): ColumnMeshPayload`:
    - `versions` is read first;
    - per section: trivial → connectivity 0x7FFF or 0 and no rows; otherwise `copyPaddedSection`, `meshSolid`, `meshFluid` and `connectivity15`, with a row per non-empty pass and a bounding sphere around that pass's vertices (centre at the AABB centre, radius to the farthest corner) in section-local blocks;
    - one position, one data and one index buffer for the column; indices are relative to each row's `vertexStart`.
- Produces, in `workers/worldJobs.ts`: `meshColumnJob(store: VoxelStore, cx: number, cz: number, s: MeshScratch, o: MeshOptions): ColumnMeshPayload`. It throws unless the 3 × 3 are Published.

- [ ] **Step 1: Write `meshColumn.test.ts`.**
  - On a 3 × 3 store filled to L (`fillColumnT`, then `fillColumnD` and `fillColumnL` on the right sets):
    - `payloadProblem(p)` is null;
    - every row's sphere contains its vertices;
    - sections above the terrain are trivial (no rows, 0x7FFF) and the bedrock floor's lower sections are trivial opaque (0);
    - the payload equals `meshSolid`/`meshFluid` run per section by hand;
    - `versions` equals the 3 × 3 versions;
    - a seam check: the quads at the column's x = 15 border face only air of the east neighbour.
  - `meshColumnJob` throws on a neighbour below Published.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): one mesh payload per column`.

**Master amendments:** §4.4's field order and offsets, `cornerDrop` in ninths, the smooth-light rounding and the trivial-section rule; §2.5's `SectionMesh.connectivity`; §2.3's meta bits 17-31 sentence and "The connectivity bits and `padded.ts` are SP4a's".

---

### Task 16: Protocol, task handler, pool, and integration

**Files:**
- Modify: `src/workers/protocol.ts`, `src/workers/taskHandler.ts`, `src/workers/worldJobs.ts`, `src/engine/workerPool.ts`
- Create: `test/unit/worldProtocol.test.ts`, `test/unit/worldPool.test.ts`, `test/integration/worldJobs.test.ts`

**Interfaces:**
- Produces, in `protocol.ts`:
  - `AttachMsg { type: 'attach'; handles: StoreHandles }`, answered by `AttachedMsg { type: 'attached' }`;
  - `WorldJobMsg { type: 'terrain' | 'decorate' | 'light' | 'meshColumn'; jobId: number; epoch: number; cx: number; cz: number }`, all added to `ToWorker`;
  - the replies:
    - `ColumnDoneMsg { type: 'columnDone'; jobId; epoch; job: 'terrain' | 'decorate' | 'light'; cx; cz; ms: number; versions: ArrayBuffer | null /* Int32Array(18), light only */ }`;
    - `MeshColumnResultMsg { type: 'meshColumnResult'; jobId; epoch; cx; cz; ms: number; versions; connectivity; position; data; index; rows; spheres: ArrayBuffer }`, every buffer transferred;
  - `ErrorCode` gains `'NOT_ATTACHED'` and `'STORE_FULL'`;
  - every new message gets a guard, and each reply a `REPLY_CHECKS` entry with byte-length checks:
    - `versions` 72 bytes, `connectivity` 48;
    - `rows` a multiple of 24 bytes, `spheres` 16 per row;
    - `payloadProblem` over the rebuilt views;
    - the `attach` guard checks each buffer is a `SharedArrayBuffer`.
- Produces, in `taskHandler.ts`:
  - `attach` calls `attachStore` once and replies `attached`; a second attach replies `BAD_MESSAGE`;
  - the four job branches call `worldJobs.ts` with `stopFor(epoch)`;
  - a world job before attach replies `NOT_ATTACHED`; `StoreFull` maps to `STORE_FULL`;
  - per-worker scratch (`createLightScratch`, `createMeshScratch`) is allocated once;
  - `meshColumn` uses `MeshOptions` from `MEDIUM` (`ao`, `smoothLight`).
- Produces, in `workerPool.ts`:
  - `attachStore(h: StoreHandles): Promise<void>`, posted to every worker and awaited as `configure` is;
  - `terrain(cx, cz): Promise<ColumnDone>`, `decorate(cx, cz): Promise<ColumnDone>`, `light(cx, cz): Promise<ColumnDone>` and `meshColumn(cx, cz): Promise<ColumnMeshPayload>`, all at priority 0;
  - `class StoreFullError extends Error`, rejected for `STORE_FULL`;
  - `createBrowserPool(size, opts)` is unchanged (it already takes the size).

- [ ] **Step 1: Write the tests.**
  - `worldProtocol.test.ts`, the guards:
    - a valid attach, and attach with an `ArrayBuffer` refused;
    - job messages with non-integer cx;
    - `columnDone` with versions of 68 bytes refused;
    - `meshColumnResult` with rows of 20 bytes, or an index past its row, refused.
  - `worldPool.test.ts`, with fake workers:
    - `attachStore` awaits every worker;
    - `terrain` resolves with `{cx, cz, ms}`;
    - `meshColumn` rebuilds typed views over the transferred buffers;
    - `STORE_FULL` rejects with `StoreFullError`;
    - a reply of an old epoch is `JobCancelled`.
  - `integration/worldJobs.test.ts`, through a real Node worker built by `buildNodeTaskWorker`, on a shared store:
    - attach, configure seed '42', then T on the 7 × 7 around (0, 0), D on the 5 × 5, L on the 3 × 3, MESH on (0, 0);
    - the payload is valid, the versions match the store, and the light at (0, 0) equals `fillColumnL` run in process on a copy.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): T, D, L and MESH_COLUMN jobs on the attached shared store`.

---

### Task 17: Harness: upTo D/L/MESH, cache format 3, and the references

**Files:**
- Modify: `test/harness/cache.ts`, `test/harness/region.ts`, `test/harness/regionWorker.ts`, `test/harness/refs.ts`, `test/unit/regionCache.test.ts` (format, scope), plus the harness's region tests

**Interfaces:**
- Produces:
  - `RegionUpTo = 'T' | 'D' | 'L' | 'MESH'`, `REGION_CACHE_FORMAT = 3`;
  - `SRC_KEY_SCOPE` gains `'src/light/'`, `'src/mesh/'` and `'src/workers/worldJobs.ts'` **(plan: the D and L job bodies live there)**.
- `genRegion` with `upTo`:
  - T covers the region plus 3 columns on every side, D plus 2, L plus 1, and MESH the region itself;
  - each stage runs over its own set with `fillColumnD`, `fillColumnL` and `meshColumnJob`;
  - in 4-thread mode they go through `regionWorker.ts`'s new `decorate`, `light` and `meshColumn` messages on the shared store.
  - 'MESH' reads the 'L' dump and meshes in process; it is never dumped.
  - A dump holds the final light entries and the whole aux A.
- `RegionView` gains `light(x, y, z): number`, `aux(cx, cz): AuxView` and `mesh(cx, cz): ColumnMeshPayload | null` (MESH only).
- `refs.ts` gains:
  - `bruteFaces(view: RegionView, cx: number, cz: number): { opaque: number; water: number }`, every voxel face visible by §5.2's rules, counted per unit face;
  - `meshFaceCounts(p: ColumnMeshPayload): { opaque: number; water: number; quadsOpaque: number; quadsWater: number }`, unit faces covered by its quads, from the corner positions.

- [ ] **Step 1: Write the tests** (in the existing harness test files or `test/unit/regionHarness.test.ts`):
  - "genRegion upTo L, 1 vs 4 threads, spiral vs shuffled: equal light and aux at every voxel of a 4 × 4 region";
  - "upTo L writes a format-3 dump and a second call reads it (no worker spawned)";
  - "upTo MESH meshes the cached L region; mesh() is non-null exactly for the region's columns";
  - "SRC_KEY_SCOPE includes src/light/, src/mesh/ and src/workers/worldJobs.ts";
  - "a format-2 dump is ignored";
  - "bruteFaces equals meshFaceCounts' unit faces on a canned 3 × 3 store".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `rm -rf test/.cache/regions && npm run test:metrics` (the quick tier, whose earlier metrics must not change), then the goldens check. Expected: PASS.
- [ ] **Step 5: Commit** `test(sp4a): region harness up to D, L and MESH; cache format 3`.

**Master amendment:** §6.1's region-cache sentence (spec §14).

---

### Task 18: `render.metric.ts`: R1, R2, R4, R5, and the `render` shard

**Files:**
- Create: `test/metrics/render.metric.ts`
- Modify: `test/thresholds.ts`, `test/thresholds.lock.json` (generated), `.github/scripts/metricShards.mjs` (`SHARDS.render`), its unit test if it pins the list, the master §6.4 R rows, the SP4a spec Threshold log

**Interfaces:**
- Rows, from spec §9.1:
  - `R1: { hiddenEmitted: { max: 0, activeFrom: 'SP4a' }, visibleMissing: { max: 0, activeFrom: 'SP4a' } }`;
  - `R2: { quadsPerFaceAo: { max: 0.6, activeFrom: 'SP4a' }, quadsPerFaceNoAo: { max: 0.35, activeFrom: 'SP4a' } }`;
  - `R4: { medianQuads: { max: 2000, activeFrom: 'SP8b' }, p95Quads: { max: 4000, activeFrom: 'SP8b' } }`;
  - `R5: { waterQuadsPerFace: { max: 0.1, activeFrom: 'SP7' } }`.
- Regions per tier:
  - fast: one 6 × 6-column region of seed 42 at the spawn (interior 4 × 4);
  - quick: two seeds × 10 × 10, plus a 10 × 10 region at amplified's and at floating_islands' golden windows;
  - full: eight seeds.
- Measures, over the interior columns:
  - **R1:** `hiddenEmitted` and `visibleMissing` are the per-unit-face differences between `meshFaceCounts` and `bruteFaces`, opaque and water;
  - **R2:** quads per visible face, meshed with AO and then with `{ao: false, smoothLight: false}`;
  - **R4:** quads per column (median, p95);
  - **R5:** water quads per water face.

- [ ] **Step 1: Write `render.metric.ts`** with literal calls `metricTest('R1', ['hiddenEmitted', 'visibleMissing'], …)`, and likewise for R2, R4 and R5. Add `SHARDS.render = [`${DIR}/render.metric.ts`]`.
- [ ] **Step 2: Run** `npx vitest run --project metrics-fast test/metrics/render.metric.ts`. Expected: FAIL (coverage: parts missing from THRESHOLDS).
- [ ] **Step 3: Add the rows.** Run `npm run test:accept-thresholds`. Add the Threshold-log line `… Task 18: R1, R2 gated from SP4a; R4 (SP8b) and R5 (SP7) recorded.`. Master §6.4: R4 "measured in SP4a", R5 "recorded from SP4a", R7 "(SP4b)".
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then `node .github/scripts/metricShards.mjs check`. Expected: PASS, R1 0/0, R2 under its gates, and R4 and R5 recorded. Note R2, R4 and R5's quick values in the commit message.
- [ ] **Step 5: Commit** `test(sp4a): R1, R2 gates; R4, R5 recorded; the render CI shard`.

---

### Task 19: `light.metric.ts`: L1, L2, DT1.light, S1 `grassSky0`

**Files:**
- Create: `test/metrics/light.metric.ts`
- Modify: `test/thresholds.ts`, the lock (generated), `metricShards.mjs` (`render` gains `light.metric.ts`), master §6.4, the spec Threshold log

**Interfaces:**
- Rows:
  - `L1: { mismatches: { max: 0, activeFrom: 'SP4a' } }`;
  - `L2: { enclosedLit: { max: 0, activeFrom: 'SP4a' } }`;
  - `DT1` gains `lightMismatches: { max: 0, activeFrom: 'SP4a' }`;
  - `S1` gains `grassSky0: { max: 0.001, activeFrom: 'SP6' }`.
- Measures, with the same regions as Task 18:
  - **L1:** light bytes of the interior columns against `referenceLight` over the whole region;
  - **L2:** air not sky-connected, at least 16 below `WORLD_SURFACE`, with sky > 0;
  - **DT1.light** (`outName: 'DT1.light'`): `genRegion` upTo 'L' hashed (blocks, fluid, light, aux) over 1 vs 4 threads and spiral vs shuffled; mismatches count unequal pairs;
  - **S1 `grassSky0`:** the share of `grass_block` tops with sky 0 above (`outName: 'S1.light'`) **(plan: S1 already has a call)**.

- [ ] **Step 1: Write `light.metric.ts`** with literal calls, and extend the `render` shard.
- [ ] **Step 2: Run** `npx vitest run --project metrics-fast test/metrics/light.metric.ts`. Expected: FAIL (coverage).
- [ ] **Step 3: Add the parts.** Run `npm run test:accept-thresholds` and add the Threshold-log line. Master §6.4: L1 "(sky from SP4a; block light from the first emitters, unit-tested before)", DT1's SP4a part, and S1's row text (spec §14).
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:metrics`, then the shard check. Expected: PASS with L1, L2 and DT1.light at 0. Note `grassSky0` (quick, including floating_islands' window) and the `render` shard's wall time (quick, cold) in the commit message.
- [ ] **Step 5: Commit** `test(sp4a): L1, L2, DT1.light gates; S1 grassSky0 recorded`.

---

### Task 20: Rings, the coordinator's core, and the upload budget

**Files:**
- Create: `src/engine/rings.ts`, `src/engine/coordinator.ts`, `src/engine/uploadBudget.ts`, `test/unit/rings.test.ts`, `test/unit/coordinator.test.ts`, `test/unit/uploadBudget.test.ts`
- Modify: the SP4a spec §2.1 (the ring counts sentence, Spec corrections above)

**Interfaces:**
- Produces, in `rings.ts`:
  - `type Stage = 'T' | 'D' | 'L' | 'MESH'`;
  - `RING_EXTRA = { T: 3, D: 2, L: 1, MESH: 0 }`;
  - `discOffsets(r: number): ReadonlyArray<readonly [number, number]>`, the integer disc `dx² + dz² ≤ (r + 0.5)²` in spiral order (by `d²`, then angle), cached per r;
  - `neededSets(cx: number, cz: number, rd: number): Record<Stage, ReadonlySet<number>>`, of colKeys;
  - `assertTorusSafe(rd: number): void`, which throws when `2·(rd + 3) + 1 > 64`.
- Produces, in `coordinator.ts`:
  - `interface CoordinatorJobs { run(stage: Stage, cx: number, cz: number): Promise<JobOutcome> }`, where `JobOutcome` is `{ versions: Int32Array | null; payload: ColumnMeshPayload | null }`;
  - `interface CoordinatorOptions { readonly workers: number; readonly jobs: CoordinatorJobs; readonly versionsAt: (cx: number, cz: number) => Int32Array; readonly onMesh: (p: ColumnMeshPayload) => void; readonly onProgress: (p: LoadProgress) => void }`;
  - `interface LoadProgress { readonly needed: Record<Stage, number>; readonly done: Record<Stage, number>; readonly dropped: number }`;
  - `progressFraction(p: LoadProgress, uploadsDone: number, uploadsTotal: number): number`: `0.2·T + 0.05·D + 0.25·L + 0.35·MESH + 0.15·uploads`, each as done/needed;
  - `phaseName(p: LoadProgress, uploadsDone: number, uploadsTotal: number): 'Generating' | 'Lighting' | 'Meshing' | 'Preparing the view'`;
  - `class LoadError extends Error { readonly cause: unknown; readonly column: readonly [number, number] | null }`;
  - `createCoordinator(o: CoordinatorOptions): { load(cx: number, cz: number, rd: number): Promise<void> }`.
- Coordinator semantics (spec §2.2):
  - **States:** Absent → T → D → L → MESH.
  - **Readiness:**
    - D needs the 3 × 3 at ≥ T;
    - L needs the 3 × 3 at ≥ D;
    - MESH needs the 3 × 3 at L;
    - each job's column must be in its own stage's set.
  - **Heap:** a binary heap keyed by `d_h − bonus` (MESH 1.5, L 1.0, D 0.5, T 0), ties broken by colKey.
  - **Caps:**
    - T ≤ N − 1 in flight and MESH ≤ N;
    - at most N jobs in flight in total (one per free worker), so the pool's queue never holds more than N.
  - **Intake** **(plan, the spec's rule made exact)**: L reads its neighbours' blocks and fluid but not their light, and its own commit and its neighbours' L commits bump `lightVersion` legitimately. So an L result is compared on the nine `blockVersion`s only (even indices), and a MESH result on all 18 values (nothing writes a Published column). A mismatch with `versionsAt(cx, cz)` at intake counts in `dropped` and rejects the load with a `LoadError` ("dropped result", which cannot occur in SP4a). T and D results carry no versions. Any job rejection rejects the load with a `LoadError` carrying the column.
  - **Completion:** `load` resolves when every MESH column has delivered its payload to `onMesh`.
- Produces, in `uploadBudget.ts`: `createUploadBudget(budgetMs: number, now: () => number): { start(): void; exhausted(): boolean }`. During loading the page uses 12 ms; `MEDIUM.uploadBudgetMs` (2 ms) is SP4b's.

- [ ] **Step 1: Write the tests.**
  - `rings.test.ts`:
    - `discOffsets(12).length` is 489, 13 → 577, 14 → 665, 15 → 749, each within 1 % of π(r + 0.5)² (the master's 491 / 573 / 660 / 755);
    - the spiral order is non-decreasing in `d²`;
    - `assertTorusSafe(16)` passes and `assertTorusSafe(29)` throws;
    - no two colKeys of the T set at rd 16 share a torus record.
  - `coordinator.test.ts`, with fake jobs resolving on a manual tick:
    - "the first job is T at the centre; MESH at the centre is issued before any T at distance 13" (nearest-first with bonuses);
    - "D is never issued before its 3 × 3 are T-done, nor L before D-done, nor MESH before L-done" (an invariant checked at every issue);
    - "never more than N − 1 T and N MESH in flight, and never more than N in total";
    - "a MESH versions mismatch at intake rejects with LoadError 'dropped result'; an L result whose lightVersions moved but blockVersions did not is accepted";
    - "a job rejection rejects with LoadError carrying the column";
    - "progress counts reach needed; progressFraction is 1 with uploads done";
    - "onMesh is called once per MESH column, 489 at rd 12".
  - `uploadBudget.test.ts`: with a fake clock, `exhausted()` is false before 12 ms and true at 12 ms.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Also reword the spec's §2.2 Intake bullet as in the interface above, and correct its §2.1 sentence: "A unit test checks RD12's exact counts (mesh 489, L 577, D 665, T 749), within 1 % of master §7's disc-area estimates (491 / 573 / 660 / 755)."
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): rings, the one-shot coordinator core, the upload budget`.

**Master amendments:** §6.3's scheduler bullet "(SP4a: nearest-first, prerequisites, stale results; SP4b: cancel, zero allocation, Apply, throttle)"; §7's fill line gains "(exact discs: 489 / 577 / 665 / 749)".

---

### Task 21: Capabilities, the 3D page's rules, and the default render distance

**Files:**
- Modify: `src/engine/capabilities.ts`, `src/engine/capabilityRules.ts` (`no-multi-draw` text :44, the new causes)
- Create: `src/engine/renderDistance.ts`, `test/unit/renderDistance.test.ts`; extend `test/unit/capabilityRules.test.ts`

**Interfaces:**
- Produces, in `capabilities.ts`:
  - `probeGrowableSab(): boolean`, which creates `new SharedArrayBuffer(0, {maxByteLength: 1 << 20})`, checks `growable` and grows once;
  - `probeStoreReservation(): { blockBytes: number; byteBytes: number } | null`. It tries (768, 512) MiB, then halves, down to (192, 128) MiB. A reservation counts as accepted when constructing both buffers succeeds; they are dropped immediately;
  - `CapabilityReport` (defined in `capabilityRules.ts`) gains `growableSab: boolean` and `reservation: { blockBytes: number; byteBytes: number } | null`, which `probeCapabilities` fills; `CauseCode` gains the two new causes.
- Produces, in `capabilityRules.ts`:
  - `evaluateWorldCapabilities(r: CapabilityReport): Evaluation`: today's blocking causes plus `no-growable-sab`, and `no-reservation` when `reservation` is null;
  - the warning `no-multi-draw`: "WEBGL_multi_draw is missing: the world renders through the per-region path (RegionMesh)";
  - the warning `no-timer-query`: "GPU time unavailable; frame timing is CPU-side only".
- Produces, in `renderDistance.ts`:
  - `isSoftwareRenderer(renderer: string): boolean`, matching `/SwiftShader|llvmpipe|softpipe|Software/i`;
  - `defaultRenderDistance(r: CapabilityReport): number`:
    - 6 for a software renderer;
    - otherwise 8 when `hardwareConcurrency ≤ 4`, or when `deviceMemory` is present and ≤ 4;
    - otherwise 12;
    - then capped by the reservation: ≤ 8 at (384, 256) MiB and ≤ 6 below;
  - `clampRenderDistance(rd: number, cap: number): number`, an integer in [4, min(16, cap)];
  - `RD_MIN = 4`, `RD_MAX = 16`.

- [ ] **Step 1: Write the tests.**
  - `renderDistance.test.ts`:
    - "Mesa Intel Iris Xe" with 20 cores and no `deviceMemory` (Firefox) → 12;
    - 4 cores → 8;
    - `deviceMemory` 4 → 8;
    - a SwiftShader string → 6;
    - "NVIDIA GeForce GTX 980, or similar" (Firefox's mask) → 12;
    - reservation (384, 256) → 8 and (192, 128) → 6;
    - `clampRenderDistance(20, 16)` is 16 and `clampRenderDistance(2, 16)` is 4.
  - `capabilityRules.test.ts`:
    - `no-growable-sab` and `no-reservation` block the world page;
    - `no-multi-draw` is a warning whose text names RegionMesh;
    - the `?map` rules are unchanged.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): growable-SAB and reservation probes; world rules; default RD`.

---

### Task 22: RegionMesh (`render/regionMesh.ts`)

**Files:**
- Create: `src/render/regionMesh.ts`, `test/unit/regionMesh.test.ts`
- Modify: `src/render/sectionRenderer.ts` (the `'mesh'` branch)

**Interfaces:**
- Produces: `createRegionMesh(materials: MaterialSystem): SectionRenderer` (kind `'mesh'`), following spec §6.2's RegionMesh rules:
  - per region and pass, one `Mesh` over one merged `BufferGeometry`, sized exactly;
  - `position` is a `BufferAttribute(Uint16Array, 4)` of region-local 1/8 units: `x + lx·128`, `y + sy·128`, `z + lz·128`, with `w` 0;
  - `data` is copied unchanged, and the indices are rebased by each section's first vertex in the merged buffer;
  - the mesh matrix is `T(regionOrigin − floatingOrigin) · S(1/8)`, where `regionOrigin = (rx·128, −64, rz·128)`;
  - `boundingSphere` contains every section sphere (×8, shifted);
  - `frustumCulled` is on, and translucent meshes get `renderOrder` back to front by region centre, recomputed by `sortTranslucent`, which the renderer calls every frame (Task 7's interface);
  - the materials come from a `variant 'mesh'` system;
  - the merge runs inside `buildNext` and is timed into `counts().mergeMs`.

- [ ] **Step 1: Write `regionMesh.test.ts`.** It runs `sectionRendererContract('mesh')`, plus:
  - "the merged buffers equal the concatenated sections: Uint16 region-local positions at the corners of every section of a region, data unchanged, indices rebased, exact sizes";
  - "the region sphere contains every section sphere";
  - "one mesh per region and pass";
  - "the region matrix is relative to the origin, scale 1/8";
  - "the materials are the REGION_MESH variant";
  - "sortTranslucent orders translucent regions far to near";
  - `selectSectionRenderer({multiDraw:false}, null)` builds a RegionMesh.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): RegionMesh, the per-region fallback without WEBGL_multi_draw`.

**Master amendment:** §4.5's reservation sentence and the Fallback paragraph (spec §14).

---

### Task 23: The renderer, the sky, the floating origin, and the FPS limiter

**Files:**
- Create: `src/render/floatingOrigin.ts`, `src/render/fpsLimiter.ts`, `src/render/sky.ts`, `test/unit/floatingOrigin.test.ts`, `test/unit/fpsLimiter.test.ts`, `test/unit/viewport.test.ts`
- Modify: `src/render/renderer.ts` (`createWorldRenderer`; `startSkyRenderer` stays until Task 27 removes its only caller)

**Interfaces:**
- Produces, in `floatingOrigin.ts`: `createFloatingOrigin(x: number, y: number, z: number): { readonly x: number; readonly y: number; readonly z: number; update(camX: number, camY: number, camZ: number): boolean }`.
  - The origin snaps to multiples of 512.
  - `update` re-snaps to the camera and returns true when the camera is more than 1,024 blocks from the origin on any axis.
- Produces, in `fpsLimiter.ts`: `createFpsLimiter(cap: 0 | 30 | 60 | 120 | 144): { tick(now: number): boolean; setCap(c): void }`. Cap 0 means off.
  - The limiter keeps the median of the last 30 rAF deltas as the display interval, and `h` is half of it.
  - On each tick it adds Δ to `acc` and renders when `acc ≥ 1000/cap − h`, then sets `acc = clamp(acc − 1000/cap, 0, 1000/cap)`.
- Produces, in `sky.ts`: `createSky(m: MaterialSystem): Mesh`, a full-screen triangle with `frustumCulled` false and `renderOrder` drawn after the opaque pass.
- Produces, in `renderer.ts`:
  - `applyViewport(camera: PerspectiveCamera, w: number, h: number, dpr: number, cap: number, setSize: (w: number, h: number) => void, setPixelRatio: (r: number) => void): void`;
  - `interface WorldRenderer { readonly renderer: WebGLRenderer; readonly camera: PerspectiveCamera; readonly origin: ReturnType<typeof createFloatingOrigin>; readonly sections: SectionRenderer; compile(): Promise<void>; frame(state: FrameState): void; info(): { calls: number; triangles: number }; gpuTimer(): { begin(): void; end(): void; poll(): number | null } | null; onContextLost(fn: () => void): void; dispose(): void }`;
  - `createWorldRenderer(host: HTMLElement, o: { kind: SectionRendererKind; fov: number; rd: number; pixelRatioCap: number; ao: boolean; smoothLight: boolean; brightness: number }): WorldRenderer`. **(plan)** It builds the flat-colour array, `createMaterialSystem({variant: kind, ao, smoothLight}, albedo)`, the sky and `createSectionRenderer(kind, materials)` itself, because the page (`ui`) may not touch `render/materials/`. Further details:
    - `gpuTimer()` returns null without `EXT_disjoint_timer_query_webgl2`; with it, it wraps queries around `render()`, and `poll` returns the latest finished frame's GPU ms;
    - `frame` calls `sections.sortTranslucent` with the camera position, sets the frame uniforms and renders;
    - antialias off, `outputColorSpace` sRGB;
    - the camera has near 0.1 and far `(rd + 2)·16·1.5`;
    - pass order: opaque front to back, then the sky, then cutout, then translucent (spec §6.1);
    - a `ResizeObserver` on the host and a `matchMedia('(resolution: <dpr>dppx)')` change listener both call `applyViewport`;
    - `compile` runs `renderer.compileAsync(scene, camera)`;
    - the spike (Task 8) keeps its own renderer setup in `render/spike/`; it may share helpers with `renderer.ts`.

- [ ] **Step 1: Write the tests.**
  - `floatingOrigin.test.ts`:
    - a start at (500,000, 70, −500,000) snaps to (499,712, 0, −499,712) **(plan: y snaps too, to 0)**;
    - no rebase within 1,024;
    - a rebase at 1,025 that re-snaps;
    - the relative positions of two points 1 block apart at ±500,000 stay exactly 1 after rebasing (float32 math).
  - `fpsLimiter.test.ts`, on simulated 60 Hz timestamps with ±0.3 ms jitter over 600 ticks:
    - cap 60 renders ≥ 59.5 fps;
    - cap 30 renders 30 ± 0.5;
    - off renders every tick;
    - at 144 Hz, cap 60 gives 60 ± 0.5.
  - `viewport.test.ts` (Review Focus 4): "a host resize sets the camera aspect and the drawing-buffer size; a dpr change re-applies min(dpr, pixelRatioCap)". For example, w 1600, h 900 and dpr 2 with cap 1 give aspect 16/9, `setSize(1600, 900)` and `setPixelRatio(1)`, and cap 0.85 gives `setPixelRatio(0.85)`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): world renderer, sky dome, floating origin, FPS limiter`.

---

### Task 24: The key map, the fly controller, and input

**Files:**
- Create: `src/player/keymap.ts`, `src/player/fly.ts`, `src/player/input.ts`, `test/unit/keymap.test.ts`, `test/unit/fly.test.ts`, `test/unit/input.test.ts`

**Interfaces:**
- Produces, in `keymap.ts`:
  - `type Action = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down' | 'sprint' | 'speedUp' | 'speedDown' | 'timeSpeed' | 'help' | 'hud' | 'loadHere' | 'releasePointer'`;
  - `type Binding = { kind: 'code'; code: string } | { kind: 'key'; key: string } | { kind: 'wheel'; dir: 'up' | 'down' }`;
  - `interface KeyEntry { readonly action: Action; readonly bindings: readonly Binding[]; readonly label: string; readonly group: 'move' | 'speed' | 'world' | 'view'; readonly since: SubProjectId }`;
  - `DEFAULT_KEYMAP: readonly KeyEntry[]`, as spec §7.3 lists it:
    - movement: W, A, S and D as codes; Space; `ShiftLeft` and `ShiftRight`; `ControlLeft` and `ControlRight`;
    - speed: speedUp on the wheel up, `key:+` and `key:=`; speedDown on the wheel down and `key:-`;
    - world and view: T, H and F1, F3, R, and Escape (listed only);
  - `resolveKey(e: { code: string; key: string }, map?: readonly KeyEntry[]): Action | null`;
  - `resolveWheel(deltaY: number, map?): Action | null`;
  - `bindingLabel(b: Binding): string`.
- Produces, in `fly.ts`:
  - `interface FlyState { x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number; speed: number }`;
  - `SPEED_DEFAULT = 12`, `SPEED_MIN = 1`, `SPEED_MAX = 96`, `SPEED_STEP = 1.25`, `SPRINT = 4` and `TAU = 0.1`;
  - `stepFly(s: FlyState, held: ReadonlySet<Action>, dtS: number, bounds: FlyBounds): void`:
    - forward and back move along the full look vector, strafing along the horizontal right vector, up and down along world y;
    - the velocity approaches the target by `1 − exp(−dt/τ)`;
    - `FlyBounds` is `{ centreX: number; centreZ: number; radius: number /* (rd − 3)·16 */; yMin: −64; yMax: 400 }`; past the radius, the outward horizontal velocity component is removed and the position is clamped to the radius;
  - `atEdge(s: FlyState, b: FlyBounds): boolean`;
  - `look(s: FlyState, dx: number, dy: number, sensitivity: number): void`, with pitch clamped to ±89.9°;
  - `stepSpeed(s: FlyState, dir: 1 | −1): void`.
- Produces, in `input.ts`: `attachInput(target: HTMLElement, o: { onAction(a: Action): void; onLook(dx: number, dy: number): void; isTextFocus(): boolean; map?: readonly KeyEntry[] }): { held: ReadonlySet<Action>; dispose(): void }`.
  - Keydown of a bound action calls `preventDefault`, Ctrl held included, and adds the action to `held` (movement and sprint) or fires `onAction` (the rest).
  - `held` is cleared on blur and on `pointerlockchange` to unlocked. Events are ignored while `isTextFocus()`.
  - The wheel listener is registered with `{passive: false}` and calls `preventDefault`.
  - Pointer lock starts on a canvas click.

- [ ] **Step 1: Write the tests.**
  - `keymap.test.ts`:
    - every `Action` is bound or listed;
    - no binding is shared by two actions;
    - `resolveKey({code:'KeyW', key:'z'})` is `'forward'` (layout-independent);
    - on a Spanish layout, `resolveKey({code:'BracketRight', key:'+'})` is `'speedUp'` and `resolveKey({code:'Slash', key:'-'})` is `'speedDown'`;
    - `resolveWheel(−100)` is `'speedUp'`.
  - `fly.test.ts`:
    - "the same distance at 30 and 144 fps over 2 s of W" (within 1 %);
    - "sprint ×4";
    - "speed steps ×1.25 clamped to [1, 96]";
    - "pitch clamped to ±89.9°";
    - "W at pitch −45° descends (spectator: full look vector)";
    - "the edge clamp at (rd − 3)·16 removes only the outward component; atEdge true there";
    - "y clamped to −64 … 400".
  - `input.test.ts`, with a fake EventTarget:
    - **Review Focus 1:** "keydown of a bound action while the world has focus calls preventDefault, Ctrl held included (Ctrl+D, Ctrl+S, Ctrl+A, Ctrl+F)";
    - **Review Focus 1:** "wheel with Ctrl held changes the speed and calls preventDefault (listener registered with passive: false)";
    - "keys cleared on blur and on pointer unlock";
    - "ignored while a text input has focus";
    - "an unbound key is not prevented".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `player/` stays DOM-light: `input.ts` touches only the target it gets. The arch rules allow DOM in `player/`; it is not a pure layer.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): key map as data, spectator fly controller, input`.

**Master amendments:** §4.17 and §5.9 (spec §14).

---

### Task 25: The HUD and the help overlay

**Files:**
- Modify: `src/ui/hud.ts`
- Create: `src/ui/help.ts`, `src/ui/settings.ts`, `test/unit/help.test.ts`, `test/unit/settings.test.ts`, `test/unit/hud.test.ts` (extend if it exists)

**Interfaces:**
- Produces, in `ui/settings.ts`:
  - `interface WorldSettings { rd: number | null /* null: the default */; fpsCap: 0 | 30 | 60 | 120 | 144; fov: number; sensitivity: number; brightness: number }`;
  - `SETTINGS_DEFAULTS = { rd: null, fpsCap: 0, fov: 70, sensitivity: 1, brightness: 0.3 }`;
  - `loadSettings(storage: Pick<Storage, 'getItem'> | null): WorldSettings`. It reads the key `wi.world.settings`, parses JSON, and clamps each field to its range: rd 4-16, fov 50-100, sensitivity 0.1-5, brightness 0-1, and the cap one of the list. A field that is missing, non-numeric or of the wrong type falls back to its default. A throwing storage or bad JSON gives the defaults;
  - `saveSettings(storage, s): void`, which catches anything the storage throws.
- Produces, in `ui/help.ts`: `mountHelp(host: HTMLElement, o: { map: readonly KeyEntry[]; settings: WorldSettings; onSettings(s: WorldSettings): void; report: CapabilityReport; evaluation: Evaluation; mapHereHref: () => string; onFullscreen(): void; onClose(): void }): { open(): void; close(): void; readonly isOpen: boolean }`.
  - **Keys:** generated from the map, grouped.
  - **Settings:** an RD select (changing it calls `onSettings` and the page reloads), the FPS cap, FOV, sensitivity and brightness.
  - **System:** `renderCapabilityReport`, with "Copy as JSON" and the hidden `#capability-json`.
  - **Links:** "Open the map here" and "Fullscreen".
  - All text goes through `textContent`.
- Produces, in `ui/hud.ts`: `mountWorldHud(host: HTMLElement, read: () => HudData): { toggle(): void; dispose(): void }`.
  - `HudData` holds: fps line; T/D/L/meshed counts; uploaded sections; draw calls; triangles; position and column; speed; clock and time speed; rd; workers; section renderer; renderer string.
  - It updates every 250 ms, and F3 toggles it through the page.

- [ ] **Step 1: Write the tests.**
  - `settings.test.ts`:
    - defaults with a null storage, with a throwing storage and with bad JSON;
    - `{rd: 99, fov: 'x', brightness: 2, fpsCap: 75}` → `{rd: 16, fov: 70, brightness: 1, fpsCap: 0}`;
    - a round-trip.
  - `help.test.ts`, with a minimal DOM shim (the existing ui tests' pattern):
    - every key-map action appears in Keys with its binding labels;
    - `#capability-json` holds the report JSON;
    - changing RD calls `onSettings` with the new rd.
  - `hud.test.ts`: the text includes "batch" or "mesh", the clock `08:00` and `×10`, and the counts.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS (`uiText`, `uiDialogs`).
- [ ] **Step 5: Commit** `feat(sp4a): world HUD counts and the help overlay with settings`.

**Master amendment:** §5.8's HUD sentence.

---

### Task 26: The start screen and the loading screen

**Files:**
- Create: `src/ui/world/startScreen.ts`, `src/ui/loading/loadingScreen.ts`, `src/ui/loading/tips.ts`, `src/ui/loading/panoramas.ts`, `public/panoramas/.gitkeep`, `test/unit/startScreen.test.ts`, `test/unit/loadingScreen.test.ts`, `test/unit/tips.test.ts`

**Interfaces:**
- Produces, in `startScreen.ts`:
  - `startModeOf(query: URLSearchParams): 'start' | 'world'`. It returns `'world'` iff any of `at`, `rd` or `workers` is present;
  - `mountStartScreen(root: HTMLElement, o: { hash: string; onEnter(): void }): { dispose(): void }`:
    - it shows the title, the seed and the profile from `decodeMapState(hash)` (or `DEFAULT_MAP_STATE` when the hash is empty), "Enter the world" and "Open the map" (`?map#<hash>`);
    - a decode error shows the message and only "Open the map";
    - "Enter the world" calls `onEnter` once and disables both buttons.
- Produces, in `tips.ts`:
  - `TIP_TEMPLATES` covers move, rise and descend, sprint, change speed, time speed, help and HUD, load around you at the edge, shape the world on `?map` and "Open in 3D", the presets on the map, and click to look and Esc to free the mouse;
  - `tips(map: readonly KeyEntry[]): string[]`, which fills in `{forward}` and the like with `bindingLabel`s.
- Produces, in `panoramas.ts`:
  - `interface PanoramaEntry { id: string; file: string; seed: string; profile: string; x: number; z: number; yaw: number; pitch: number; time: number; commit: string; renderer: string }`;
  - `parseManifest(json: unknown): PanoramaEntry[]` (invalid entries dropped);
  - `pickPanorama(entries: PanoramaEntry[], rand: () => number): PanoramaEntry | null`.
- Produces, in `loadingScreen.ts`: `mountLoadingScreen(root: HTMLElement, o: { tips: string[]; now: () => number; doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>; onWatchdog(): void }): LoadingScreen`, where `LoadingScreen` is `{ progress(fraction: number, phase: string): void; fail(cause: string, details: string, links: { map: string; lowerRd: string | null }): void; fadeOut(ms: number): Promise<void>; dispose(): void }`.
  - **Background:** a neutral gradient from #3D78D6 to #A8CCF5. The page fetches `/panoramas/manifest.json`, picks an entry and fades it in on decode, with `object-fit: cover`. A missing manifest or a decode error keeps the gradient.
  - **Tips:** they rotate every 7 s, starting at a random one.
  - **Progress:** one thin bar and a phase line.
  - **Watchdog:** it fires `onWatchdog` after 30 s without a `progress` call that raised the fraction. Time while `doc.hidden` does not count, and `visibilitychange` restarts the window.

- [ ] **Step 1: Write the tests.**
  - `startScreen.test.ts`:
    - `startModeOf('')` and `startModeOf('#…')`-only give `'start'`;
    - `?at=1,2`, `?rd=8` and `?workers=4` give `'world'`;
    - `?renderer=mesh` alone gives `'start'`;
    - seed 42 and the default profile without a hash, the hash's seed with one;
    - a bad hash shows the error and keeps "Open the map";
    - the map link carries the hash;
    - **Review Focus 3:** "a second click on Enter the world (or a double-click) calls onEnter once; the buttons are disabled after the first".
  - `loadingScreen.test.ts`, with a fake clock and doc:
    - the watchdog fires at 30 s without progress, and not when the progress rises at 29 s;
    - **Review Focus 2:** "time while document.hidden does not count toward the 30 s watchdog, and the watchdog restarts its window on visibilitychange";
    - `fail` shows the cause, "Copy details" and both links;
    - `parseManifest` drops an entry without `file`, and `pickPanorama([])` is null.
  - `tips.test.ts`: every action of the key map that `TIP_TEMPLATES` names appears with its binding label, and no tip has a `{` left.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): start screen and loading screen (panorama, tips, progress, watchdog)`.

---

### Task 27: The world page: boot to reveal

**Files:**
- Create: `src/ui/world/worldPage.ts`, `src/ui/world/query.ts`, `src/ui/world/firstView.ts`, `test/unit/worldQuery.test.ts`, `test/unit/firstView.test.ts`
- Modify: `src/main.ts` (routes; the SP0 sky page goes), `src/render/renderer.ts` (remove `startSkyRenderer`)

**Interfaces:**
- Produces, in `query.ts`:
  - `parseWorldQuery(q: URLSearchParams): WorldQuery`, where `WorldQuery` is `{ at: { x: number; z: number } | null; y: number | null; yaw: number | null; pitch: number | null; rd: number | null; workers: number | null; renderer: SectionRendererKind | null }`;
  - the bounds:
    - x and z are integers clamped to ±500,000; y is clamped to −64 … 400;
    - rd is an integer clamped to 4 … 16 and workers to 2 … 6;
    - a malformed value is null.
- Produces, in `firstView.ts`: `firstView(motionBlockingAt: (x: number, z: number) => number, x: number, z: number, given: { y; yaw; pitch }): { y: number; yaw: number; pitch: number }`.
  - The default y is `MOTION_BLOCKING(x, z) + 2`, and the default pitch −10°.
  - The yaw points toward the lowest of eight samples at 48 blocks, at yaw 0°, 45° … 315°, with ties going to the smallest yaw.
- Produces, in `worldPage.ts`: `mountWorldPage(root: HTMLElement, q: WorldQuery, hash: string): Promise<WorldPage>`, following spec §8.4 steps 1-5:
  - **Setup:**
    - probe, then `evaluateWorldCapabilities` (blocking → the error screen with the table and a `?map` link);
    - the loading screen;
    - `createStore({shared: true, maxBlockBytes, maxByteBytes})` from the reservation;
    - `createBrowserPool(q.workers ?? poolSize)`, then `attachStore`, then `configure(seed, params)`. The session is `openMapSession(hash)` with `validateParamTrees`;
  - **Centre and load:**
    - the centre is `q.at`, else `pool.spawn()`;
    - `createWorldRenderer(host, {kind: selectSectionRenderer(report, q.renderer), …settings, MEDIUM})`, then `sections.expect(the mesh disc)`;
    - `coordinator.load(centreCx, centreCz, rd)`, with `onMesh` staging into `worldRenderer.sections`;
    - a rAF loop builds within `createUploadBudget(12, performance.now)` and feeds the loading screen's progress;
  - **Reveal:** when every column is meshed and every region built:
    - `compile()`;
    - place the camera with `firstView` (the store's `final(cx, cz).aux().motionBlocking`);
    - render three frames behind the opaque overlay;
    - `revealAll()` in one frame, then `fadeOut(300)`;
    - show "Click to fly" until the pointer locks;
  - **Recorded for Task 30:** the reveal ms, per-stage ms, long tasks (count and max, through `PerformanceObserver('longtask')` when supported) and the max of the first 120 frames, all in `WorldPage.loadStats`;
  - **Frame loop:** fly, the floating origin, time, the lightmap, `FrameState` (its `eyeSky` is the sky light of the camera's voxel read from the page's attached store, 0 inside terrain, 15 above y 319 or outside the loaded disc), the FPS limiter, the HUD and the help. Movement and look come from `attachInput`. `T` cycles `TIME_SPEEDS`, `F3` toggles the HUD, and `H` and `F1` open the help (`preventDefault`).
  - **Load errors** (`LoadError`, `StoreFullError`, `WorkerFailed`, the watchdog) show `fail(...)`. The `lowerRd` link is `/?rd=<rd−2>&at=<centre>#<hash>` when rd > 4.
- `main.ts`:
  - `/` runs `startModeOf(query)`: `'start'` mounts `mountStartScreen` and, on enter, `mountWorldPage` in the same page with no navigation; `'world'` mounts `mountWorldPage` directly;
  - `?spike`, `?map`, `?selftest` and `?lab` are unchanged;
  - `?flight` and `?pano` come in Tasks 30 and 31.

- [ ] **Step 1: Write the tests.**
  - `worldQuery.test.ts`:
    - `?at=12,-40&y=90&yaw=45&pitch=-20&rd=8&workers=4&renderer=mesh` parses fully;
    - `?at=900000,0` clamps x to 500,000; `?rd=30` → 16; `?workers=1` → 2;
    - `?at=abc` → null; `?y=999` → 400.
  - `firstView.test.ts`:
    - a flat MOTION_BLOCKING of 70 gives y 72, pitch −10 and yaw 0;
    - the lowest sample at 135° gives yaw 135;
    - a given y, yaw and pitch are kept.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Remove `startSkyRenderer`; its only caller, `boot`, goes with the SP0 sky page.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Then try it by hand with `npm run build && npx vite preview --port <free>` in your own Chrome profile: `/?rd=6` loads, reveals at once, flies, and the console stays clean.
- [ ] **Step 5: Commit** `feat(sp4a): the 3D world page from start screen to reveal`.

**Master amendment:** §3.7's teleport sentence ("SP4b; SP4a places the camera from the loaded `MOTION_BLOCKING`").

---

### Task 28: The world page: edge, reload, guards, notices, and map links

**Files:**
- Modify: `src/ui/world/worldPage.ts`, `src/ui/map/toolbar.ts` ("Open in 3D")
- Create: `src/ui/world/reload.ts`, `src/ui/world/frameNotice.ts`, `test/unit/worldReload.test.ts`, `test/unit/frameNotice.test.ts`, `test/unit/mapOpen3d.test.ts`

**Interfaces:**
- Produces, in `reload.ts`:
  - `hereUrl(s: { x: number; y: number; z: number; yaw: number; pitch: number }, rd: number | null, hash: string): string`, which gives `/?at=<round x>,<round z>&y=<round y>&yaw=<deg, 1 dp>&pitch=<deg, 1 dp>[&rd=]#<hash>`;
  - `createReloader(navigate: (url: string) => void): { reload(url: string): void }`, which calls `navigate` at most once.
- Produces, in `frameNotice.ts`: `createFrameNotice(onSuggest: (rd: number) => void, rd: number): { push(frameMs: number): void }`. After the first 300 frames following the reveal, if their snapped p95 is above 25 ms and rd > 4, it calls `onSuggest(rd − 2)` once. **(plan: the next lower RD is rd − 2, so that 12 → 10 → 8 matches the default ladder.)**
- In `worldPage.ts`:
  - **The edge (spec §7.5):** `atEdge` shows "Edge of the loaded world — press R to load the world around you". R reloads with `hereUrl` through the reloader at any time.
  - **The Ctrl+W guard:** a `beforeunload` handler is installed after the reveal. The help's "Fullscreen" requests fullscreen and calls `navigator.keyboard?.lock()` when it exists.
  - **The low-fps notice:** a dismissible notice "Frames are slow at RD <rd> — try RD <rd−2>", linking to the reload with `&rd=`.
  - **Context loss:** `webglcontextlost` (through `WorldRenderer.onContextLost`) stops the loop and shows "The graphics context was lost" with a Reload link from `hereUrl`.
  - The help's "Open the map here" is `?map#<hash with the view centred on the camera>` (through `encodeMapState` with the camera's x and z).
- In `toolbar.ts`: "Open in 3D" goes to `/?at=<pin, else the view centre>#<the map's hash>`, in the same tab.

- [ ] **Step 1: Write the tests.**
  - `worldReload.test.ts`:
    - `hereUrl({x: 10.6, y: 80.2, z: −3.4, yaw: 45.04, pitch: −10}, null, '#abc')` is `/?at=11,-3&y=80&yaw=45.0&pitch=-10.0#abc`;
    - **Review Focus 3:** "R twice within the reload calls navigate once";
    - **Review Focus 5:** "webglcontextlost stops the frame loop and shows 'The graphics context was lost' with a Reload link carrying ?at, y, yaw and pitch of the camera" (tested on the page's handler, with a fake renderer and DOM shim).
  - `frameNotice.test.ts`:
    - p95 26 ms over 300 frames at rd 12 suggests 10, once;
    - p95 24 ms suggests nothing;
    - nothing is suggested at rd 4;
    - nothing is suggested before 300 frames.
  - `mapOpen3d.test.ts`: the toolbar's link with a pin, and without one (the view centre); the hash is kept.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sp4a): world edge and R reload, Ctrl+W guard, slow-frame notice, context loss, map links`.

---

### Task 29: Browser smoke: the `start`, `world` and `world-mesh` steps

**Files:**
- Modify: `test/tools/uiSmoke.ts` (`SMOKE_STEPS` gains `start`, `world` and `world-mesh`; its Chrome gains `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`), `test/unit/uiSmoke.test.ts` (pure parts)

**Interfaces:**
- Produces: `pixelDiffShare(a: Uint8Array, b: Uint8Array, tol: number): number`, a pure export: the share of pixels where any channel differs by more than `tol`.
- The steps, from spec §9.6:
  - **`start`:**
    - bare `/` shows seed 42, the default profile and both buttons, with no console error, and saves `start.png`;
    - `/#<a hash with seed 7>` names seed 7;
    - "Enter the world" on a bare `/` brings up the loading screen with the URL unchanged, and the step stops there.
  - **`world`:** `/?rd=4` shows no start screen; the step waits for the reveal (`window.__wiWorld.revealed`, set by the page), checks the console stays clean and saves `world.png`.
  - **`world-mesh`:**
    - it loads `/?rd=4&renderer=mesh&at=<spawn>&y=<y>&yaw=<…>&pitch=<…>` and the same URL with `renderer=batch`, with the time fixed at 08:00 and the HUD hidden, through a `&shot=1` flag the page honours;
    - each is captured after the reveal plus three frames;
    - `pixelDiffShare(…, 2) ≤ 0.01`;
    - it saves `world-mesh.png`.

- [ ] **Step 1: Write the tests.** `uiSmoke.test.ts`:
  - `pixelDiffShare` is 0 on equal buffers, 0.5 when half the pixels differ by 3, and 0 when they differ by 2;
  - `SMOKE_STEPS` includes the three new steps in order, after `console`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add `&shot=1` to the page (time paused at 08:00, HUD hidden, and `__wiWorld.revealed`, plus a frame counter).
- [ ] **Step 4: Run** `npm run typecheck && npm test`, then `node test/tools/uiSmoke.ts --shots /tmp/wi10-shots-XXXX`. Expected: every step passes, including the parity check. Record the parity share in the commit message.
- [ ] **Step 5: Commit** `test(sp4a): browser smoke steps start, world, world-mesh (parity)`.

---

### Task 30: The flight route, the Chrome flights, and G1

**Files:**
- Create: `src/ui/world/flight.ts`, `test/unit/flight.test.ts`, `test/metrics/g1.metric.ts`
- Modify: `src/main.ts` (`?flight=sp4a`), `src/ui/world/worldPage.ts` (the flight hook), `test/thresholds.ts`, the lock, the master §6.4 G1 row and §5.8, the spec Threshold log
- Commit: `docs/superpowers/specs/assets/sp4a/flight-iris-chrome.json`, `flight-iris-chrome-w4.json` and `flight-rtx-chrome.json`

**Interfaces:**
- Produces, in `flight.ts`:
  - `flightWaypoints(spawn: { x: number; z: number }, rd: number, motionBlockingAt, hasWater: (x: number, z: number) => boolean): Array<{ x; y; z }>`:
    - eight waypoints on a deterministic loop within (rd − 4)·16 of the spawn, 20-80 blocks above `MOTION_BLOCKING`;
    - one leg low (20 blocks) over water when the disc has any;
  - `catmullRom(pts, u: number): { x; y; z; yaw; pitch }`, closed, with the yaw along the tangent;
  - `summarizeFlight(frames: Float64Array, mainMs: Float64Array, interval: number, extra: FlightExtra): FlightResult`, with every key spec §9.5 lists:
    - frames: p50, p95, p99, max and the count over 33 ms, all snapped;
    - main: p50, p95, max;
    - `gpuMs`: p50 and p95 from `WorldRenderer.gpuTimer()` when the timer query exists (Chrome), else null (Firefox);
    - draw calls (max, mean), triangles max, heap and SAB MB;
    - load: reveal ms, per-stage ms, merge ms, long tasks and the first-120 max;
    - route, seed, profile, rd, workers, section renderer, user agent, renderer and vendor as reported, `multiDraw`, `timerQuery`, screen, dpr, display interval.
- The route `?flight=sp4a` uses seed 42, the default profile, RD 12 and `?workers` (default N). After the reveal:
  1. 120 idle frames give the display interval (median rAF delta);
  2. a 60 s flight follows `catmullRom`, with the day running from 06:00 through one full cycle in 60 s;
  3. `window.__wiFlight.result` is set and the "Download JSON" button appears.
- G1 rows: `G1: { mediumStaticP95: { max: 16.7, activeFrom: 'SP4a' }, mediumStaticDrawCalls: { max: 100, activeFrom: 'SP4a' }, mediumStaticMainP95: { max: 6, activeFrom: 'SP4a' } }`.
- `g1.metric.ts` (every tier, ms):
  - it reads `flight-iris-chrome.json` and checks its shape: the renderer matches `/Iris/i`, the section renderer is `'batch'`, rd is 12 and the profile is `'default'`;
  - it asserts the three parts;
  - it records the w4, RTX and Firefox files when present, as `G1.others`.
  - It lands in the `render` shard.

- [ ] **Step 1: Write the tests.**
  - `flight.test.ts`:
    - eight waypoints, all within (rd − 4)·16 and 20-80 above the heightmap;
    - one at 20 when water exists;
    - `catmullRom` passes through every waypoint;
    - `summarizeFlight` on synthetic 60 Hz frames with jitter gives p95 exactly 16.667 (snapped), and `gpuMs` null when there is no timer query;
    - every key spec §9.5 lists is present.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement the route.
- [ ] **Step 3: Measure (quiet machine, an agent):**
  - `npm run measure:chrome -- --route flight --gpu iris`
  - `npm run measure:chrome -- --route flight --gpu iris --workers 4`
  - `npm run measure:chrome -- --route flight --gpu rtx`

  Expected: the three JSON files.
- [ ] **Step 4: Tune if G1 misses.** If `flight-iris-chrome.json` misses any of p95 ≤ 16.7, draw calls ≤ 100 or main p95 ≤ 6, tune within spec §9.5 and re-measure after each step: `pixelRatioCap` below 1, the upload budget, region size or merged passes, then fog end and band at RD12. Commit each step's JSON as `flight-iris-chrome-tune<k>.json`. **If it still misses, STOP** and report every JSON to the controller for the user. No gate changes.
- [ ] **Step 5: Add G1.** Write `g1.metric.ts` and the rows in one go. Run `npm run test:accept-thresholds` and add the Threshold-log line. Master §6.4 G1's SP4a sentence, and §5.8's bench-route sentence.
- [ ] **Step 6: Run** `npm run typecheck && npm test && npm run test:metrics`, then the shard check. Expected: PASS with G1 asserted.
- [ ] **Step 7: Commit** `feat(sp4a): ?flight=sp4a, the Chrome flights, G1's static cells`.

---

### Task 31: Panoramas (the tool, the `?pano` route, the assets)

**Files:**
- Create: `test/tools/panoramas.ts`, `test/unit/panoramas.test.ts`, `src/ui/world/panoramaRoute.ts`
- Modify: `src/main.ts` (`?pano=<id>`), `package.json` (`"assets:panoramas": "node test/tools/panoramas.ts"`)
- Commit: `public/panoramas/manifest.json` and six `.webp` files

**Interfaces:**
- Produces, in `panoramas.ts`:
  - `PANORAMAS: readonly PanoramaSpec[]`, six entries, where `PanoramaSpec` is `{ id: string; seed: string; profile: string; x: number; z: number; yawDeg: number; time: 8 | 17 }`:
    - seed 42 default at a coast, a mountain and a badlands site, taken from `REVIEW_SITES` (`test/harness/reviewSlices.ts:263`), copied as literals;
    - amplified's, archipelago's and floating_islands' golden window centres (`metrics/sp3eGoldens.ts:141`), copied as literals;
  - `parsePanoArgs(argv): { gpu: boolean; skipBuild: boolean }`;
  - `panoFile(id: string): string`, which gives `<id>.webp`;
  - `MAX_BYTES = 400 * 1024`.
- The tool:
  1. builds, starts its own preview on a free port, and launches its own headless Chrome with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (or the system GPU with `--gpu`);
  2. prints the probed renderer, and refuses without WebGL2;
  3. for each entry, opens `/?pano=<id>` at 1920 × 1080 (`Emulation.setDeviceMetricsOverride`, dpr 1) and waits for `window.__wiPano.ready`;
  4. captures WebP at quality 80 (lowering the quality in steps of 5 until the file fits `MAX_BYTES`);
  5. writes the images and `manifest.json` (`PanoramaEntry` with the commit's short SHA and the renderer);
  6. stops only what it started.
- The `?pano=<id>` route reads the entry from a copy of `PANORAMAS` built into the page. `panoramaRoute.ts` holds the literal table, and a test checks it equals the tool's. The route loads RD12 with no HUD, overlay or start screen, at a fixed time, 32 blocks above `MOTION_BLOCKING`, with pitch −10°. It sets `ready` after the reveal and three frames.

- [ ] **Step 1: Write the tests.** `panoramas.test.ts`:
  - six unique ids;
  - every entry's site equals its source (the review sites and the golden windows imported in the test);
  - the tool's table equals `panoramaRoute.ts`' table;
  - `panoFile('coast')` is `coast.webp`;
  - `parsePanoArgs(['--gpu'])` gives gpu true.
- [ ] **Step 2: Run it.** Expected: FAIL. Then implement.
- [ ] **Step 3: Run** `npm run typecheck && npm test`, then `npm run assets:panoramas`. Expected: six files, each ≤ 400 KB, and `manifest.json`. Open `/` in your own Chrome profile: the loading screen shows a panorama.
- [ ] **Step 4: Commit** `feat(sp4a): panorama capture tool, ?pano route, six panoramas` (the binary assets staged by explicit path).

If the tool cannot produce usable images (for example SwiftShader unavailable, or blank frames), report it to the controller. The cut line moves the panoramas to SP4b, and the neutral background stays.

---

### Task 32: The bench rows `light.column` and `mesh.section`

**Files:**
- Modify: `test/bench/gates.ts` (`BENCH_ROWS` appends both rows; `LIGHT_P50_MAX_MS = 4`, `LIGHT_P99_MAX_MS = 8`, `MESH_P50_MAX_MS = 1.0`, `MESH_P99_MAX_MS = 2.5`; `AbsoluteLatencies` and `absoluteGateFailures` extended; run options `LIGHT_RUN` and `MESH_RUN` = `{ iterations: 256 | 1024, time: 0, warmupIterations: 1, warmupTime: 0 }`), `test/bench/noise.bench.ts`, `test/unit/benchGates.test.ts`, `test/baselines.json` (recorded), the master §7 line, `test/arch/masterSpec.test.ts` (the §7 "Measured in SP4a" pin)

**Interfaces:**
- `light.column` covers spec §4.2's job (copy, BFS, output) on 256 interior columns of an 18 × 18 region of `terrain.real`'s candidates, generated to D outside the timing. Each column is timed once, and the calls are asserted as 1 probe + 1 warm-up + 256.
- `mesh.section` covers the padded copy plus the mesh on 1,024 non-trivial sections of that region lit to L, each timed once.

- [ ] **Step 1: Write the tests.** `benchGates.test.ts` pins the appended `BENCH_ROWS` and the four gates; `masterSpec.test.ts` checks that §7's "Measured in SP4a" line names both rows and that `BENCH_ROWS` contains them.
- [ ] **Step 2: Run them.** Expected: FAIL. Then implement.
- [ ] **Step 3: Measure on a quiet machine.**
  1. `npm run bench`. Every earlier row must be within +30 %, and `BENCH_EXEMPT` may name only the new rows for this first run.
  2. `npm run bench:record`.
  3. `npm run bench` again. Expected: every gate passes, and the four values go into master §7 ("Measured in SP4a: light.column p50 … p99 …, mesh.section …").
  - **A missed absolute gate: STOP** and report the numbers.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(sp4a): bench rows light.column and mesh.section; re-baselined`.

---

### Task 33: Firefox cells, review assets, master §1, and exit evidence

This task is mostly the controller's. The implementer prepares and the user measures.

**Files:**
- Commit:
  - `docs/superpowers/specs/assets/sp4a/spike-firefox-{iris,rtx}.json` and `flight-{iris,rtx}-firefox.json` (the user's downloads);
  - the review screenshots: the spawn by day, at sunset and at night; an ocean; amplified's peaks; floating_islands' shadow; the start screen; the loading screen with a panorama and with the neutral background;
  - `selftest-firefox.json`.
- Modify:
  - master §1 (the new files and the `SP4a:` test list, with its pinning test in `masterSpec.test.ts`), the cut-line wording, and every remaining `SP4` amendment of spec §14 not yet landed;
  - the SP4a spec (Spike evidence completed, `## Exit evidence`, Status);
  - `docs/backlog.md` (the Safari line), `CLAUDE.md` (routes, `assets:panoramas`, `measure:chrome`, the bench gates, the `render` shard), `README.md`.

- [ ] **Step 1: Firefox cells (the user).** The controller pushes the branch for a preview deploy and gives the user four URLs: `…/?spike=batch` and `…/?flight=sp4a`, each on the Iris Xe and under `prime-run` on the RTX. The user downloads each JSON, and the controller commits each one under the GPU the user names.
  - The spike cells must show `basicPass`.
  - The flights must show p95 ≤ 25 ms and draw calls ≤ 100 on RegionMesh (spec §9.5).
  - A cell outside its criterion goes back to the user with the numbers.
- [ ] **Step 2: Review assets.** Take the screenshots with `uiSmoke --shots`-style captures, or by hand in your own profile (`&shot=1` with `?at`, `y`, `yaw`, `pitch`, and the time set through the URL **(plan: `&time=<hours>` honoured with `shot=1`)**).
- [ ] **Step 3: Exit checks** (spec §11).
  - `npm run build && npm test && npm run test:metrics:full`;
  - `git diff main -- test/goldens.json` is empty;
  - `?selftest=1` passes 59/59 in Chrome (uiSmoke) and in Bun (`npx --yes bun@1 test/tools/goldensJsc.ts`);
  - `node test/tools/uiSmoke.ts --shots …`;
  - the bench is green (Task 32).
- [ ] **Step 4: Master and docs.**
  - Master §1: the new files, and the `test/` entry's `(SP4a: metrics/render.metric.ts, metrics/light.metric.ts, metrics/g1.metric.ts, tools/cdp.ts, tools/panoramas.ts, tools/measureChrome.ts)`, with a `describe('master spec amendments (SP4a §14)')` test that reads that list and checks each file exists.
  - The cut-line receivers, worded by what was built.
  - `grep -n 'SP4\b'` on the master returns no line that spec §14 amends.
  - Spec: complete "Spike evidence"; write `## Exit evidence` with the CI wall time and the slowest files from the job summaries, measured after the push, against §10's 3 min 40 s – 4 min. Status: "implemented, awaiting CI, the production check and the user's check".
  - `docs/backlog.md`: "Verify the 3D page in Safari and other browsers (SP4a §11)."
- [ ] **Step 5: Commit** `docs(sp4a): exit evidence, master §1, review assets`.
- [ ] **Step 6: The controller, with the user's go-ahead:**
  1. Merge to `main` and push.
  2. Check that CI is green, and record its wall time.
  3. Check production: the start screen, then the world in Chrome (batch) and in Firefox (mesh), and the Firefox selftest 59/59 (the user's JSON).
  4. The user's check: a full day/night cycle on the Iris Xe and on the RTX, on the default world and on floating_islands.
  5. A final commit marks SP4a complete.

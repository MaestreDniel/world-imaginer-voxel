# SP4a — The world in 3D, loaded once: renderer, light and meshing (Design)

Date: 2026-10-20
Status: Approved by the user (2026-10-20): the design in brainstorming (`.superpowers/sp4/design-brief.md`, incl. the SP4a/SP4b split), then this written spec after the builder check, with the user's answers (water light, island shadow, the start screen at `/`, who runs the measurements) and the user's capability check (Firefox lacks `WEBGL_multi_draw`: RegionMesh in SP4a).
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP4, which this spec splits into SP4a and SP4b (§14), and the SP5, SP6, SP7, SP8a, SP8c, SP10 and SP11 entries it hands work to;
- §2.2 (the light rule and the fluid byte's effective opacity), §2.3 (store: final heightmaps, meta connectivity, epoch cells), §2.5 (`ColumnWriter`, `SectionMesh`, `SubProjectId`), §3.0 and §3.12 (the D stage's skeleton);
- §4.1-§4.10, §4.15-§4.17 (threads, state machine, scheduling, meshing and vertex format, render structure, materials, textures, lighting, sky and day/night, water tiers, culling, presets, player);
- §5.1 (Apply, handed to SP4b), §5.6 (map, handed to SP4b), §5.8 (HUD and bench), §5.9 (controls);
- the testing sections §6.1 (harness), §6.3 (unit tests), §6.4 (R1, R2, R4, R5, R7, L1, L2, DT1, S1, P1, G1) and §7 (performance budget).
Previous SP: `2026-10-16-sp3e-draft-presets-design.md`. **Received from the earlier SPs**, and what this spec does with each item:
- SP0 (its spec §219, §226): the `no-multi-draw` warning and the renderer defaults (antialias off, pixel ratio min(dpr, 1), sRGB output): kept; the warning's text names the path SP4a takes (§1.5);
- SP2a (:39, :49, :578) and SP2b (:41, :501): teleport, the map mounted in game, Apply on the session's urgent commits, the climate-grid cache for the one-MAP-job cap: **SP4b** (§13.1); the keyboard help (SP2b :34): delivered (§7.4);
- SP3a (§10): `padded.ts`, the connectivity bits, the final heightmaps with `LIGHT_BLOCKING` pinned: delivered (§3-§5); shared streaming and the coordinator: the one-shot part here (§2), streaming in SP4b; replacing the pool-wide abort cell with the per-scope epoch cells: **SP4b** (D5); the store concurrency items: each fixed here or handed to SP4b with the reason it cannot occur in SP4a (§2.6);
- SP3b (:214, :239): water v0's still sources are what the still-water mesher draws (§5.6); `surfaceEst3` caching with its first consumer: SP4b's teleport (SP4a places the camera from the loaded heightmaps, §8.4);
- SP3c (:376, :449, :542): `VOXEL_COLORS` as the flat-colour source and packed_ice's colour: delivered (§6.3, D14); S1's grass at sky 0: recorded from SP4a, gated by SP6 (§9.1);
- SP3d (:547, :601): the dirty stages of a tree edit for Apply: **SP4b**; packed_ice: as SP3c's;
- SP3e (:35, :536, :684): the island shadow, the islands' undersides and amplified's peaks in 3D: delivered (§4.4, §5); the spawn-y rule for teleport: SP4b (§13.1).

References written "master §x" point to the master spec, "SP3a §x" (and SP0-SP3e) to those specs, and a bare "§x" to this document. Code is cited as it is at `main` 20f9976 (`GENERATOR_VERSION` 5, `CURRENT_SP` 'SP3e', 59 goldens), always with its directory under `src/` or `test/`; the maps behind the citations are `.superpowers/sp4/map-{code,master,tests}.md`. three is cited at the installed `0.186.1` (`node_modules/three/package.json`).

## Goal

The first time the user enters the generated world in 3D. From a minimal start screen at `/` (D21), the 3D page generates, lights and meshes the area around the spawn (render distance 12 by default) in the workers behind a loading screen (pre-rendered panoramas of the world, rotating tips, a discreet progress indicator), then shows it at once and lets the user fly through it in spectator mode: flat-coloured blocks with face shade, ambient occlusion and smooth light, exact sky light (the island shadow included), translucent still water, a sky dome with the sun, an elevation-based day/night cycle and spherical fog, with a HUD, a help overlay and the key map as data. SP4a opens with the master's week-1 renderer spike. There is no streaming: the loaded world is a disc around its centre; flying to its edge offers to load the world around the camera (§7.5). The user's own check is a full day/night cycle flown on the Iris Xe and on the RTX 3060 Mobile. The generated world does not change (`GENERATOR_VERSION` 5, the 59 goldens byte-identical).

## Non-goals

- **Streaming, unloading and the coordinator's moving parts** (re-centring, heap rebuilds on a crossing or a turn, cancellation of jobs leaving the needed set, unload hysteresis, proto retention and `T(protoOnly)`, the adaptive throttle, the upload budget while flying, per-column atomic reveal and R7): SP4b (§13.1).
- **The store concurrency fixes that only unloading and reuse make reachable** (claim generation, monotone versions, the protoFlags alive bit, seqlock or deferred reclamation, lock owners, the column-table race fuzz): SP4b (§2.6).
- **The M map overlay with click-to-teleport and the map-page refactor; Apply v1 live from the map; the `?bench` route with streaming; G1 at RD12 while streaming, the first-load and stutter cells:** SP4b. SP4a offers a cheap start at a chosen point instead (§8.2).
- LODs, graphics presets Low…Ultra, moon and stars, clouds, shadows, MSAA, Fancy and Fabulous water: SP11 (water Fancy: SP7). Textures, the tint texture and colormaps, cutout content, box shapes: SP8a. Flowing water, lava, underwater fog: SP7. Walking, collisions, editing, the settings panel and the remapping UI: SP5. Cave culling: SP6. The full F3 overlay and performance HUD: SP10.
- Verification in more browsers (Safari and others): `docs/backlog.md` (the exit adds the line, §11).
- Light and mesh goldens (D25).

## Decisions confirmed by the user (2026-10-20)

From the brief, played back and confirmed; the items marked "controller's call" were proposed and not objected to.
1. **Intent:** enter the generated world in 3D, moving like Minecraft's spectator mode (fly, pass through blocks, adjustable speed); the world should feel vast and immersive. Users: the user's laptop (Iris Xe and RTX 3060 Mobile, i7-12700H, 20 threads, 15 GB), Chromium-based browsers and Firefox; later invited testers on other machines, whose render distance depends on their machine.
2. **Scope baseline:** the master's SP4 entry (§10, §4), split by the user's decision of 2026-10-20: SP4a, the world in 3D loaded once (generate, light and mesh the RD12 area around the spawn behind the loading screen; fly through it with materials, AO and light, translucent water, sky with sun, day/night and fog, HUD, help and the key map as data; the week-1 spike; no streaming; the user's day/night check on both GPUs); SP4b, streaming and life (the store's concurrency fixes, the coordinator that loads and unloads while flying without stutter, the M overlay with teleport and the map-page refactor, live Apply, the measured flight route and the master's performance criteria at RD12).
3. **Render distance:** adjustable, starting at RD12 (controller's call); LODs are SP11's and must not be blocked. **Capability detection:** degrade gracefully instead of breaking (controller's call).
4. **Stack (not reopened):** three r186 WebGLRenderer with custom GLSL3 ShaderMaterials, all GLSL in one module (D7); `render/` is the only place three is imported; the engine runs on the main thread without three; workers generate, light and mesh.
5. **Priorities:** (1) no stutter when loading, above all the first load: the world is not shown until the area around the camera is generated, lit and meshed; meanwhile a loading screen; (2) nice to have, not blocking: invisible seams, light without blotches, no holes; a low, measured rate of visible artefacts is enough.
6. **Loading screen:** a panorama background, pre-made by a tool that opens SP4's own renderer in headless Chrome at a few viewpoints of a few chosen seeds and commits the screenshots, regenerated by the same tool when the look changes, with a neutral background when none exists (controller's proposal); rotating tips (how to move, change speed, customise the world from `?map`); a discreet progress indicator (controller's guess).
7. **Entering:** by default at the seed's spawn; picking another point with the map (M overlay, click teleports) is SP4b's by the split. Spectator controls: WASD, Space up, Shift down, Ctrl faster, wheel or keys to adjust speed, pointer lock (Esc releases), H/F1 help; walking is SP5's. **The key map ships as data** so remapping needs no code change; the remapping panel comes later (the user chose this).
8. **Success:** the user's check is a full day/night cycle flown on the Iris Xe and on the RTX 3060 Mobile; the master's automatic exit criteria, as the split assigns them (§9); a recorded flight that crosses the cycle and logs frame times (controller's addition); the generated world unchanged.
9. **CI:** most new tests are fast unit tests; anything needing a real GPU runs locally, outside CI; exact lighting is validated in CI on data. Expected CI growth under a minute (controller's estimate), stated here (§10) and measured at the exit.

## Decisions taken by this spec (for the user's review)

The brief and the maps left these open. The recommendation is the text of the section cited; the alternative is stated.
- **D1 The spike measures two risks, with pass/fail** (§1): the renderer (RegionBatch: one `BatchedMesh` per pass per 8×8-column region, a Uint8x4 `position` and a uint32 `data` attribute in a GLSL3 ShaderMaterial with the batching chunks) **and the shared store in the browser** (a growable `SharedArrayBuffer` store created on the page, attached and grown in six module workers, never done outside Node, `map-code.md` §5.5). Alternative: the renderer only, the store discovered during the load pipeline.
- **D2 The RegionMesh fallback is built in SP4a, because a target cell requires it** (§1.5, §6.2): the rule was "required when any of the four target cells (Chrome and Firefox × Iris Xe and RTX 3060 Mobile) lacks `WEBGL_multi_draw`, or when the batched path fails the spike's frame criterion where RegionMesh passes", and the user's capability check (2026-10-20, §1.5) shows Firefox without `WEBGL_multi_draw` (Firefox exposes it on no GPU). So RegionMesh is a second `SectionRenderer` implementation with its own tests, selected by the capability probe (`multiDraw` false → RegionMesh), and both Firefox cells run on it; RegionBatch stays the path wherever the extension exists, and G1 is gated on Chrome/Iris Xe with it (D24). The alternative the rule offered (RegionMesh cut to SP4b, a browser without the extension rendering through three's one-draw-per-instance loop, `WebGLRenderer.js:1317-1329`, at a lowered render distance) no longer applies: it would leave one of the user's two browsers on the slow path.
- **D3 The load is one-shot around a fixed centre** (§2.1): the master's rings (T at RD+3, D at RD+2, L at RD+1, mesh at RD; at RD12: mesh 489, L 593, D 705, T 825 (§2.1)) around the spawn or a chosen point, nothing freed during the session, RD from 4 to 16 (the torus holds 2·(16+3)+1 = 39 < 64 columns, so no two needed columns share a record). A new render distance or centre reloads the page behind the loading screen. Alternative: lowering RD in place by hiding regions (raising it would need streaming).
- **D4 The store changes SP4a needs, and only those** (§2.5): the shared store created in the browser with its maxima chosen by a reservation probe; `reopenColumn(cx, cz, from)`, a writer for a committed column that clears nothing; `ColumnWriter.setLight`; per-channel version bumps at commit (`blockVersion` when blocks or fluid were written, `lightVersion` when light was); the light-once invariant (`setLight` refuses an entry that already holds a slot); `attachStore`/`attachPool` asserting the buffer kind; the growable-buffer probe. Everything else of SP3a's list goes to SP4b with the reason it cannot occur in SP4a (§2.6). Alternative: fix all nine items now (they are untestable without unloading, SP4b's).
- **D5 One pool for the 3D page, the store attached once** (§2.3): a one-time `attach` message carries the `StoreHandles` to every worker; the pool keeps SP2b's 4-byte pool-wide abort cell (SP4a configures once); the per-scope epoch cells are wired by SP4b with Apply, their first consumer. Alternative: wire the per-scope cells now (no job of SP4a would read them differently).
- **D6 The coordinator's one-shot core** (§2.2): `engine/coordinator.ts` with the column states, the prerequisite rules, a binary heap ordered by `d_h − stageBonus` (no view term: nothing is on screen while loading), the caps T ≤ N−1 and MESH ≤ N, feeding the pool one job per free worker (so the pool's per-pump sort stays tiny, `workerPool.ts:225`), result intake with version checks (the epoch is enforced by the pool; `meshSeq` is SP4b's, §2.2), and progress counts. SP4b extends the same module. Alternative: a throwaway loader (SP4b would then rewrite the state machine).
- **D7 The D skeleton** (§3): the pull-model signature over the 3×3 proto with an empty feature list; it shares the proto into the final set (`shareFinal` with an all-zero light, which stores no slot) and writes the four final heightmaps; `tintTH` stays 0 (its only consumer is SP8a's tint texture, which pins its layout); no proto is freed (with zero features every final slot is a shared proto slot, so freeing protos would save nothing); the `decorate` stage version stays 1 (it feeds `genKey` and the `sp1` golden, `map-code.md` §8). Alternative: write T and H into `tintTH` now.
- **D8 The light rule for the fluid byte** (§4.1; confirmed by the user, 2026-10-20): the effective opacity is master §2.2's `max(OPACITY[b], fluid ? 1 : 0)`; **the straight sky fall stops at the first voxel of effective opacity > 0, so water stops it**, and `LIGHT_BLOCKING` is defined by the same predicate; **the BFS step entering a voxel is `max(1, effective opacity)`**, MC's rule, so light dims by 1 per block of water (14, 13, 12 … below the surface; an ocean floor deeper than 15 blocks is dark unless lit sideways). Alternatives: the master's literal "−1 plus the opacity" (−2 per water block: dark from 8 blocks down); the fall passing through water (every sea floor at 15, so water would never darken anything below it).
- **D9 The island shadow is exact, and the user judges it at the cycle check** (§4.4; exact, with no ambient floor, confirmed by the user, 2026-10-20): under a floating island the ground gets only the sky light that reaches it sideways, 15 minus the distance to the open sky, so the middle of a large island's footprint reads sky 0 (black in daylight but for face shade). Alternative, if the user dislikes it: an ambient floor in the lightmap (a Live look change, no light data change; it would break master §6.3's `(0, 0) ≤ 0.02` lightmap test, so it needs an amendment).
- **D10 Connectivity is computed by the mesh job** (§5.7): `mesh/connectivity.ts` computes each section's 15 face-to-face bits from the padded view and the column's mesh result carries them; the meta bits 17-31 stay 0, and SP6 (cave culling, their first consumer, on the main thread) decides whether the store needs them. Alternative: `computeMeta` with a second table (PASS opaque ∧ FULL_FACES 63) in `StoreHandles`, a flood per section on every final write (`map-code.md` R12).
- **D11 The packing is pinned bit by bit** (§5.5), and with it the still-water corner drop in ninths of a block and the smooth light's integer rounding. Alternative: leave the bit order to the plan (the packing↔GLSL test would still hold, but the spec would not fix the format SP7, SP8a and SP11's shadow pass decode).
- **D12 One mesh payload per column** (§5.8): one position, one data and one index buffer per `MESH_COLUMN` result, with a section table; the renderer wraps subarrays per section. Alternative: three transferable buffers per section and pass (up to ≈ 30 per column).
- **D13 Each region's batches are sized exactly** (§6.2): SP4a builds a region's three `BatchedMesh` (or, on RegionMesh, its merged buffers per pass) once all its columns are meshed, with the summed vertex and index counts; the reservation and ×1.5 growth policy of master §4.5 is SP4b's (the spike measures `setGeometrySize`). Alternative: master §4.5's reservations now (untested growth paths in a load-once world).
- **D14 One flat-colour table, shared with the Voxels mode** (§6.3): the block colours of `VOXEL_COLORS` (`ui/crossSection/voxels.ts:29-59`) move to `textures/flatColors.ts`, which both the Voxels slice and the 3D texture array read; packed_ice becomes a deeper ice blue (§6.3) so it no longer reads as the sky; a block's flat-colour layer is its state id until SP8a's `FACE_TEX` (no registry table changes, so no golden moves). Alternative: a render-only copy of the colours (two tables that can drift, packed_ice fixed in 3D only).
- **D15 Fog and the world-edge fade** (§6.6): fog end (RD − 0.5)·16 blocks (184 at RD12), fog start 64 blocks before it; and, SP4a only, a horizontal fade into the fog colour over the last 24 blocks before (RD − 0.5)·16 from the load centre, so the cut edge of the world is never seen. Alternative: MC's thin band (start ≈ end − RD·1.6) without an edge fade (the world's cut edge shows when the camera nears it).
- **D16 Day and night** (§6.5): a 20-minute day (master §4.9), the sun on a path tilted 20° (noon at elevation 70°), the world opening at 08:00, and a time-speed key (T: ×1, ×10, ×60, paused) so a full cycle takes 2 min at ×10 or 20 s at ×60. Alternative: a time slider in the help overlay only.
- **D17 `core/params/graphicsPresets.ts` is created by SP4a** (§6.10) with only the Medium fields SP4a uses; SP8c adds the audio rows and SP11 the other presets (master §1 has SP8c create it). Alternative: SP4a-local constants in `engine/` and `render/`, moved later.
- **D18 Spectator flight and speed keys** (§7.1-§7.2): forward along the full look vector (MC's spectator), strafe horizontal, Space and Shift along world up; a 0.1 s velocity time constant; speed 12 blocks/s by default (master), ×1.25 steps between 1 and 96, Ctrl ×4; **the plain wheel and the `+`/`-` keys change the speed**; Alt+wheel is not bound (Firefox's default Alt+wheel action and window managers use it) and SP5, whose hotbar takes the wheel, chooses its replacement. Ctrl as sprint makes Ctrl+W close the tab, so a `beforeunload` guard asks first while the world is open, and in fullscreen Chromium's Keyboard Lock captures it. Alternatives: master §4.17's Alt+wheel; a sprint key other than Ctrl (unlike MC).
- **D19 The key map is data keyed by physical key** (§7.3): `player/keymap.ts` binds actions to `KeyboardEvent.code` (layout-independent positions: WASD stay WASD on the user's Spanish layout) except `+`/`-`, matched by `KeyboardEvent.key` (on a Spanish keyboard both are unshifted keys at other positions); the help, the tips and the HUD's key hints are generated from it. Alternative: bindings by `key` throughout (WASD would move on AZERTY).
- **D20 The world edge** (§7.5): the camera is softly held within (RD − 3)·16 blocks horizontally of the load centre (144 at RD12, 16 blocks short of where the edge fade begins), a notice says the edge is reached, and R loads the world around the camera (the page reloads with its position and view in the URL). Alternatives: no clamp (the camera leaves the world and sees its cut edges and the void); a hard wall without a reload.
- **D21 Routes and the start screen** (§8.1-§8.2; changed by the user, 2026-10-20): the default route `/` shows a **minimal start screen** before anything is generated: "Enter the world", "Open the map", and the seed and profile the world will use (from the `#` hash in `?map`'s encoding, else `?map`'s defaults); "Enter the world" turns the same page into the loading screen and then the 3D world, with no route change. The SP0 sky page goes; its capability report moves into the help overlay, keeping the hidden `#capability-json`. `?at=x,z` (optionally `y`, `yaw`, `pitch`) starts at a chosen point, `?rd=` and `?workers=` set the render distance and the pool size, and **any of the three skips the start screen** (they come from a link, a reload or a tool: "Open in 3D", R at the world edge, the render-distance setting, the flight and smoke tools); `?map` keeps its "Open in 3D" link (`/?at=<its pin, else its view centre>#…`) and the help an "Open the map here" link. The full start and worlds menu (world list, create, load, settings) is designed later, with SP5's worlds menu (§13.2, §14). The user's words: "both can coexist at the root; we'll study it in detail later". Alternatives: `/` straight into the 3D world (this spec's first draft); a new `?world` route with the default page unchanged.
- **D22 Loading screen mechanics** (§8.3): panoramas in `public/panoramas/` with a `manifest.json` fetched at load (outside `src/`, so regenerating them does not invalidate CI's region caches keyed on `src/**`); six viewpoints; WebP at 1920 × 1080, each ≤ 400 KB; captured with SwiftShader by default (deterministic); tips generated from the key map; one progress bar weighted by stage; a 30 s no-progress watchdog; the reveal after the shaders are compiled and three warm-up frames rendered behind the overlay, then a 300 ms fade. Alternative: panoramas under `src/` imported through Vite (fingerprinted, but every regeneration is a cold CI cache).
- **D23 Capability rules for the 3D page** (§8.5): blocking without WebGL2, cross-origin isolation, a shared SAB or growable `SharedArrayBuffer` (each error screen links the 2D map, which needs none of them); the default render distance 12, 8 with ≤ 4 cores or ≤ 4 GB of `deviceMemory`, 6 on a software renderer; store maxima halved and RD capped when the full reservation fails; a dismissible notice suggesting a lower RD when the first 300 frames' p95 exceeds 25 ms. The renderer string is recorded as reported and never trusted on Firefox, whose fingerprinting protection masks it (the user's check, §1.5). Alternative: block weak machines (invited testers would see an error instead of a smaller world).
- **D24 The flight route and the static G1 cells** (§9.5): `?flight=sp4a`, a 60 s scripted flight inside the loaded disc across one full day (the day lasts 60 s during the route), producing a JSON with the renderer string as reported (read over CDP in Chrome, downloaded by a button in Firefox, §9.5); frame times are rAF deltas snapped to the display's refresh interval (an on-time frame at 60 Hz reads 16.7 ms, not 16.6-16.9 ms of jitter); **SP4a gates G1's three master SP4 cells on the static world** (p95 ≤ 16.7 ms, ≤ 100 draw calls, main thread ≤ 6 ms p95 at RD12 on the Iris Xe in Chrome, on RegionBatch) from the committed artifact; SP4b re-asserts them while streaming and adds the streaming cells. Agents run the Chrome cells on the user's laptop through their own Chrome over CDP and the user runs the Firefox cells by hand (§9.5); the Firefox cells run on RegionMesh and are recorded and checked at the exit, not gated by a threshold row. A G1 miss is tuned within this spec and re-measured; a miss after tuning comes back to the user with the measurements (§9.5). Alternative: record only, gate everything in SP4b (the riskiest number of the project, the iGPU frame time, would stay ungated for a whole SP).
- **D25 No light or mesh goldens** (§9.4): light is checked against an independent global BFS (L1) and meshing against a brute-force face count (R1) on every metric run, which is stronger than a hash; DT1 gains a light part (the lit region's hash equal over 1 vs 4 threads and spiral vs shuffled order on the shared store). Alternative: `sp4a.*` region hashes upTo L, extending `?selftest=1` and Bun (light and mesh would then join `DET_FILES` and master "Banned APIs").
- **D26 Recorded rows** (§9.1): R4 (activeFrom SP8b, the master's), R5 water surface quads (activeFrom SP7) and S1's grass at sky 0 (activeFrom SP6) are recorded from SP4a; R7 moves to SP4b (its definition is the streaming flight and a terrain Apply; SP4a's single reveal is a unit test). Alternative: leave R5 and S1 unmeasured until their SPs.
- **D27 Harness widening** (§9.2): `upTo` 'D' | 'L' | 'MESH' with the prerequisite rules; `REGION_CACHE_FORMAT` 3 (dumps hold the final light and heightmaps); upTo 'MESH' meshes a cached 'L' region in process and is not cached (so master §6.1's `stageHash('mesh')` key is not needed); `SRC_KEY_SCOPE` gains `src/light/`, `src/mesh/` (`world/store/padded.ts` is already under `src/world/`). Alternative: cache mesh dumps under the mesh stage hash.
- **D28 A named CI shard** (§10): the two new metric files run in a new `metrics-quick` shard `render` rather than the catch-all `rest` (≈ 190 s, already longer than `check`'s 170 s).
- **D29 The split's governance** (§12, §14): SP4a (L; SP3b), SP4b (L; SP4a); SP5 depends on SP4b (its sim worker writes Published columns that SP4b's concurrency fixes make safe), SP8a on SP4a (materials and mesher); `CURRENT_SP` becomes 'SP4a'.
- **D30 HUD** (§6.9): the always-on fps line plus counts, toggled with F3 (SP10 grows F3 into the full overlay).
- **D31 A small settings block in the help overlay** (§7.4): render distance (reloads), FPS cap, field of view 70°, mouse sensitivity, brightness, persisted in `localStorage` behind try/catch (master §4.16); SP5's settings panel replaces it.
- **D32 The first view** (§8.4): the camera opens 2 blocks above `MOTION_BLOCKING` at the spawn (or the chosen point), looking 10° down toward the lowest of eight heightmap samples 48 blocks away, so it looks out over the land rather than into a hill. Alternative: a fixed yaw (north).
- **D33 The spike page stays** (§1.4): `?spike=batch` keeps the stress scene for re-measuring on other GPUs and browsers (invited testers, SP4b's churn work); once RegionMesh exists the page renders the scene through the section renderer the probe selects, and `?renderer=batch|mesh` forces either (§1.2 item 5).

## Points decided by the user (2026-10-20)

The first draft asked the user to confirm or change seven points; a builder check then raised four questions. The user's answers and the controller's calls, as folded into the decisions above:
1. **Water dims light by 1 per block** (D8), MC's rule, instead of the master's literal 2: confirmed by the user.
2. **The island shadow stays exact**, with no ambient floor (D9): confirmed by the user; the user still judges the look at the cycle check.
3. **The start screen at the root** (D21): changed by the user. `/` shows a minimal start screen (enter the world, open the map, the seed and profile it will use); "enter" goes to the loading screen and the 3D world in the same page; `?at`, `?rd` and `?workers` skip it. The full start and worlds menu is designed later with SP5's worlds menu.
4. **Who measures** (D24, §1.2, §9.5): the user's answer. Agents run the Chrome cells themselves on the user's laptop, with their own Chrome over CDP, on the Iris Xe and on the RTX 3060 Mobile (`prime-run`), on a quiet machine, never touching the user's own browsers or processes; the user runs the Firefox cells by hand, a page button downloads the JSON, the user sends it and the controller commits it (as with the Firefox selftest). The plan continues once the Chrome/Iris Xe spike cell passes; the other spike cells are recorded before the exit, and a failure there comes back to the user.
5. **A G1 miss on the finished page** (D24, §9.5): controller's call (builder check Q4). The builder may tune within this spec and re-measure; if G1's static cells still miss, it stops for the user with the measurements, and no gate is loosened silently.
6. **`WEBGL_multi_draw` on Firefox and on the RTX** (D2, §1.5): the user's capability check (builder check Q3). Firefox on the RTX 3060 Mobile lacks it (and Firefox exposes it on no GPU), so under D2's rule RegionMesh comes into SP4a and both Firefox cells use it; the result is recorded in §1.5, and Chrome's two cells are read by the spike.
7. **Speed keys** (D18): the plain wheel and `+`/`-`, Ctrl as sprint with the Ctrl+W guard: the spec's recommendation, not objected.
8. **Fog and the world edge** (D15, D20): fog end (RD − 0.5)·16 with a 64-block band, the edge fade, the soft clamp and R to load around the camera: the spec's recommendation, not objected.
9. **Flat colours** (D14): one table shared with the Voxels mode, with packed_ice's new colour in both: the spec's recommendation, not objected.
10. **G1's three static cells gated in SP4a** (D24): the spec's recommendation, not objected; who runs the cells is point 4 and a miss after tuning is point 5.

## Changes after the builder check (2026-10-20)

- **D8, D9:** marked confirmed by the user; no text change.
- **D21, Goal, §8.1, §8.2, §8.4, §9.6, §9.7, §11, §13.2, §14:** the minimal start screen at `/` (`ui/world/startScreen.ts`), the rule that `?at`, `?rd` or `?workers` skips it, the capability report in the help overlay; uiSmoke's `start` step, the start screen's unit tests; the full start and worlds menu handed to SP5 (§13.2, §14).
- **§1.2, §1.3, §9.5, §12:** who runs which cell; how each JSON reaches `docs/superpowers/specs/assets/sp4a/` (a page cannot write files: the Chrome cells through the CDP tool `test/tools/measureChrome.ts`, the Firefox cells through the page's download button and the user); the plan continues on the Chrome/Iris Xe spike cell, the other three are recorded before the exit.
- **§9.5, D24:** the tuning allowed on a G1 miss (pixel ratio cap, upload budget, pass and draw-call batching, fog distance), then a stop for the user with the measurements.
- **D2, D13, D23, D33, §1.5, §6.1-§6.4, §6.9, §8.5, §9, §10, §11, §12-§14:** the user's capability check recorded; RegionMesh built in SP4a as the second `SectionRenderer`, selected when `multiDraw` is false (Firefox), with its tests and a parity check; the cut line loses RegionMesh; GPU time degrades to CPU-side frame timing where the timer query is missing (Firefox); the renderer string recorded as reported (masked on Firefox).
- **Points for the user's review** replaced by the points decided above. The status stays a draft for the user's review.

## Module layout after SP4a

```
src/core/ids.ts                    SubProjectId and SUB_PROJECTS with SP4a and SP4b; CURRENT_SP 'SP4a' (§12)
src/core/params/graphicsPresets.ts the Medium row's SP4a fields: rd 12, uploadBudgetMs, ao, smoothLight, water 'fast',
                                   pixelRatioCap 1, fog band (D17, §6.10)
src/world/blocks/light.ts          + effOpacity(state, fluid), effEmit(state, fluid) (§4.1)
src/world/store/api.ts             ColumnWriter + setLight; the doc of the writer's thread contract reworded (§2.5, §2.6)
src/world/store/store.ts           reopenColumn; per-channel version bumps; aux reuse on reopen; attach asserts (§2.5)
src/world/store/pool.ts            attachPool asserts the buffer kind (§2.6)
src/world/store/padded.ts          the 18³ section layout and copy; the 46 × 384 × 46 light region layout and copy (§4.3, §5.1)
src/gen/pipeline/decorateStage.ts  the D skeleton (§3)
src/gen/pipeline/finalHeightmaps.ts  WORLD_SURFACE, MOTION_BLOCKING, OCEAN_FLOOR, LIGHT_BLOCKING of a final column (§3.2)
src/light/initial.ts queue.ts      the initial light job and its Int32 ring queue (§4)
src/mesh/greedy.ts                 face visibility, AO, smooth light, greedy merge (§5.2-§5.4)
src/mesh/fluid.ts                  the still-water surface mesher (§5.6)
src/mesh/packing.ts                PACK_LAYOUT, pack/unpack (§5.5)
src/mesh/connectivity.ts           connectivity15 (§5.7)
src/mesh/column.ts                 one column's sections → the column payload (§5.8)
src/textures/flatColors.ts         the flat block colours (D14, §6.3)
src/daynight/dayNight.ts           time → sun direction, elevation, phase, day factor, sky colours (§6.5)
src/workers/protocol.ts            attach, terrain, decorate, light, meshColumn messages and replies with their guards (§2.3)
src/workers/taskHandler.ts         the store attached once; the four job branches (§2.3)
src/workers/worldJobs.ts           the T, D, L and MESH_COLUMN handlers over the attached store (§2.3)
src/engine/rings.ts                needed sets and spiral offsets (§2.1)
src/engine/coordinator.ts          the one-shot core: states, prerequisites, heap, caps, intake, progress (§2.2)
src/engine/uploadBudget.ts         the per-frame upload budget (§6.2)
src/engine/workerPool.ts           attach, terrain, decorate, light, meshColumn methods; the size override (§2.3)
src/engine/capabilities.ts, capabilityRules.ts  + growable SAB and store reservation probes; the 3D page's rules (§8.5)
src/engine/renderDistance.ts       defaultRenderDistance(report) (§8.5)
src/render/renderer.ts             replaces startSkyRenderer: renderer, scene, camera, frame loop (§6.1)
src/render/sectionRenderer.ts      the interface and selectSectionRenderer(report, override) (§6.2)
src/render/regionBatch.ts          the multi-draw implementation: BatchedMesh per region and pass (§6.2)
src/render/regionMesh.ts           the fallback implementation (no WEBGL_multi_draw: Firefox): merged buffers per region and pass (D2, §6.2)
src/render/floatingOrigin.ts lightmap.ts sky.ts textureArray.ts fpsLimiter.ts  (§6.4-§6.8)
src/render/materials/index.ts uniforms.ts glsl/{common,packing,terrain,water,sky}.glsl.ts  materials v1, each terrain and water material in a batched and a RegionMesh variant (§6.4)
src/render/spike/stressScene.ts    the spike's synthetic Medium-scale scene (§1)
src/player/keymap.ts fly.ts input.ts  the key map as data, the spectator controller, DOM input (§7)
src/ui/world/startScreen.ts        the minimal start screen of `/` and the rule that skips it (D21, §8.1)
src/ui/world/worldPage.ts          the 3D page: boot, wiring of pool, coordinator, renderer, player, HUD, help (§8)
src/ui/loading/loadingScreen.ts tips.ts panoramas.ts  (§8.3)
src/ui/help.ts                     the help overlay: keys, settings, system (§7.4)
src/ui/hud.ts                      + counts, F3 (§6.9)
src/ui/crossSection/voxels.ts      block colours from textures/flatColors.ts (D14)
src/ui/map/toolbar.ts              + "Open in 3D" (§8.2)
src/main.ts                        routes: / (start screen, then the world in the same page), ?flight, ?pano, ?spike (§8.1)
public/panoramas/                  manifest.json and the WebP panoramas (§8.3)
test/harness/region.ts cache.ts regionWorker.ts refs.ts  upTo D/L/MESH, prerequisites, format 3, the references (§9.2)
test/metrics/render.metric.ts      R1, R2, R4, R5 (§9.1)
test/metrics/light.metric.ts       L1, L2, DT1's light part, S1's grass at sky 0 (§9.1)
test/metrics/g1.metric.ts          G1's static parts from the committed flight artifact (§9.5)
test/bench/gates.ts, noise.bench.ts  + light.column, mesh.section and their absolute gates (§9.3)
test/tools/cdp.ts                  the Chrome/CDP helpers extracted from uiSmoke.ts (§8.3)
test/tools/panoramas.ts            the panorama capture tool (§8.3)
test/tools/measureChrome.ts        the agents' CDP driver for the Chrome spike and flight cells (§1.2, §9.5)
test/tools/uiSmoke.ts              + the `start`, `world` and `world-mesh` steps (§9.6)
.github/scripts/metricShards.mjs   + the `render` shard (§10)
docs/superpowers/specs/assets/sp4a/  spike and flight JSON (Chrome through measureChrome.ts, Firefox through the user's download), review screenshots (§9.6)
```

## 1. The week-1 spike

### 1.1 What it builds

- **The stress scene** (`render/spike/stressScene.ts`, the `?spike=batch` route): Medium scale as master risk 2 states it, ≈ 3.5k section instances and ≈ 0.75 M quads (RD12's 491 meshed columns × the 1500-quad median of master §2.6) in ≈ 21 regions × 3 batches. Section meshes are synthetic but realistic: greedy-like quads of mixed sizes, per-vertex AO and light values, `data` words with every packed field exercised, and a precomputed bounding sphere set before `addGeometry`.
- **The real attribute path:** `position` a `BufferAttribute(Uint8Array, 4)` read by three's `in vec3 position`; `data` a `BufferAttribute(Uint32Array, 1)`, bound as an integer attribute because it is a Uint32Array; a GLSL3 `ShaderMaterial` (in `render/materials/`, the only place GLSL lives, `test/arch/rules/banned.ts`) including `batching_pars_vertex` and `batching_vertex`, decoding `data` with the generated `#define`s of §5.5, applying face shade × AO × a lightmap lookup and spherical fog.
- **The shared store in the browser:** a store created on the page with `shared: true` and the default maxima (768 MiB blocks, 512 MiB bytes), its handles posted to six module workers that each claim, fill and commit columns (forcing pool growth), and the page reading their views back.

### 1.2 What it measures

Each run produces `spike-<browser>-<gpu>.json` (`<browser>` chrome or firefox, `<gpu>` iris or rtx) with the capability report (renderer string as reported, `multiDraw`, `timerQuery`) and the section renderer used. A page cannot write files, so the page exposes the JSON as `window.__wiSpike.result` and offers a "Download JSON" button: **the Chrome cells** are run by an agent with `test/tools/measureChrome.ts` (§9.5), which reads the result over CDP and writes it into `docs/superpowers/specs/assets/sp4a/`; **the Firefox cells** are run by the user by hand, the button downloads the file, the user sends it and the controller commits it there. The items:
1. **Decode exactness:** a debug mode renders 1024 known `data` words as colours and reads them back (`readPixels`): mismatches.
2. **Static frame** at 1920 × 1080, pixel ratio 1, frustum culling on, sorting on: rAF frame time p50/p95/max (snapped as in §9.5), draw calls (`renderer.info.render.calls`), main-thread ms per frame (callback start to `render()` return) p95.
3. **Upload throughput:** main-thread ms per 1k quads for `addGeometry`, and the first-render buffer upload, projected to RD12.
4. **Churn, for SP4b:** 32 `setGeometryAt` per frame (main-thread p95), delete and re-add, `optimize()` per region (ms and MB; master §4.5's < 1 ms claim), `setGeometrySize` growth.
5. **Without multi-draw:** the same scene with `WEBGL_multi_draw` masked (a context wrapper returning null for it): draw calls and p95 through three's per-instance loop, and, once RegionMesh exists (§6.2), through RegionMesh (`?renderer=mesh`). Where the extension is missing (Firefox) items 2 and 5 are RegionMesh's.
6. **Shared store:** reservations accepted, growth visible in every worker (length-tracking views), the page reading the workers' columns, errors.

### 1.3 Pass and fail

- **Pass** on the gate machine (Chrome, Iris Xe): 1 has 0 mismatches; 2 has p95 ≤ 16.7 ms, ≤ 100 draw calls and main thread p95 ≤ 3 ms (half of master §7's 6 ms, since the real page adds input, intake and uploads); 3 projects RD12's uploads to ≤ 2 s at ≤ 12 ms per frame; 6 has no error. **The plan continues once this cell passes.** Firefox on the Iris Xe and both browsers on the RTX 3060 Mobile must pass 1 and 6; their 2 is recorded. These three cells (Chrome/RTX by an agent; Firefox/Iris Xe and Firefox/RTX by the user, on RegionMesh, so after it lands) must be recorded before the exit, and a failure there comes back to the user. 4 and 5 are recorded for SP4b.
- **Fail of 1** in some browser: the integer attribute is the problem, so RegionMesh would not help; the spike tries the packed word as two `Uint16` attributes read as floats (exact below 2^24) and the spec comes back to the user with both numbers.
- **Fail of 2** on the Iris Xe: the spike measures the levers (pixel ratio 0.85, the scene without the translucent pass, merged per-region buffers in RegionMesh) and the spec comes back to the user before any other task: the renderer path is their decision.
- **Fail of 6** (a browser refusing the reservation or the growth): the maxima probe of §8.5 covers a refused reservation; a browser whose workers do not see growth makes the 3D page blocking there, and master risk 1's kill criterion (transferable snapshots) comes back to the user.

### 1.4 What stays

The stress scene and its route stay (D33); the attribute path, the materials and RegionBatch become the real renderer (§6). The spike's JSON files and a short "Spike evidence" section of this spec record the four cells: the plan's spike task writes the Chrome/Iris Xe cell, and each later cell is added when it arrives (before the exit).

### 1.5 The cut line it decided (D2), and the user's capability check

D2's rule built RegionMesh (master §4.5's fallback, §6.2) in SP4a if any target cell lacked `WEBGL_multi_draw`, or the batched path failed §1.3's frame criterion where RegionMesh passed; otherwise it moved to SP4b. The user's capability check decided it before the spike: Firefox lacks the extension, so **RegionMesh is built in SP4a** and selected by the probe wherever `multiDraw` is false. The `no-multi-draw` warning (`engine/capabilityRules.ts:44`) names the per-region path instead of SP4. The spike still records Chrome's two cells (`multiDraw` expected true there) and both Firefox cells.

**The user's capability check (2026-10-20), as reported by the user**, Firefox on the RTX 3060 Mobile (`prime-run`):

| field | value |
|---|---|
| `webgl2` | true |
| `multiDraw` (`WEBGL_multi_draw`) | **false** |
| `timerQuery` (`EXT_disjoint_timer_query_webgl2`) | **false** |
| `maxArrayTextureLayers` | 2048 |
| `maxTextureSize` | 32768 |
| renderer | "NVIDIA GeForce GTX 980, or similar" (masked by Firefox's fingerprinting protection) |
| `sabShared` | true |
| `hardwareConcurrency` | 20 |

Firefox exposes `WEBGL_multi_draw` on no GPU, so the Firefox/Iris Xe cell is taken to lack it as well (its spike report confirms it). What follows in this spec: both Firefox cells render on RegionMesh (§6.2); GPU-time measurements degrade to CPU-side frame timing where the timer query is missing (§9.5); the renderer string is recorded as reported and not trusted on Firefox (§8.5, §9.5); 2048 layers cover the flat-colour array (one layer per state id, §6.3).

### Spike evidence

The spike's cells (§1.2, §1.3), each JSON in `docs/superpowers/specs/assets/sp4a/`. The Chrome cells were measured on 2026-10-22 under the PRIME on-demand profile, with the user's session unlocked and the display awake, in a fullscreen window on the laptop panel **eDP-1 at 240 Hz** (the display's native rate, as the user chose on 2026-10-21; eDP-1 is the primary panel under on-demand). Frame times snap to the measured display interval, 4.165 ms, so 16.7 ms is four intervals, the 60 Hz budget the gate encodes; the thresholds stay as §1.3 states them. The two GPUs differ in ANGLE backend as well as hardware: the Iris Xe renders through ANGLE's default OpenGL backend, the RTX through ANGLE Vulkan under PRIME offload (`__NV_PRIME_RENDER_OFFLOAD=1`, `__GLX_VENDOR_LIBRARY_NAME=nvidia`, `__VK_LAYER_NV_optimus=NVIDIA_only`, `--use-angle=vulkan`), because ANGLE's GL backend fails `eglInitialize` there.

| | Chrome / Iris Xe (`spike-chrome-iris.json`), **the gate cell** | Chrome / RTX 3060 Mobile (`spike-chrome-rtx.json`) |
|---|---|---|
| renderer (as reported) | ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6) | ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520)), NVIDIA) |
| capability | `multiDraw` true, `timerQuery` true; Chrome 155.0.8059.39, 1920 × 1080 @ 1 | `multiDraw` true, `timerQuery` true; Chrome 155.0.8059.39, 1920 × 1080 @ 1 |
| display | eDP-1 at 240 Hz, interval 4.165 ms | eDP-1 at 240 Hz, interval 4.165 ms |
| section renderer | RegionBatch (`batch`) | RegionBatch (`batch`) |
| scene | 489 columns, 3,565 section rows, 734,109 quads, 15 regions | the same |
| 1 decode | 0 mismatches of 1,024 words | 0 mismatches of 1,024 words |
| 2 static p50 / p95 / max | 4.165 / 8.33 / 12.495 ms; 0 long frames in 600 | 4.165 / 4.165 / 4.165 ms; 0 long frames in 600 |
| 2 draw calls | 19 max, 16.0 mean | 19 max, 16.0 mean |
| 2 main thread p95 | 2.01 ms | 0.93 ms |
| 3 upload | 0.058 ms per 1k quads (build 42.4 ms), first render 33.2 ms; projected RD12 0.12 s | 0.060 ms per 1k quads (build 43.9 ms), first render 49.6 ms; projected RD12 0.13 s |
| 4 churn | 32 `setGeometryAt` per frame: main p95 2.68 ms, frame p95 8.33 ms; `optimize()` of region (0, 0) opaque: 3.21 ms over 7.47 MB; re-add of 32: 0.47 ms; `setGeometrySize` × 1.5: 3.47 ms | 32 `setGeometryAt` per frame: main p95 1.52 ms, frame p95 4.165 ms; `optimize()` of region (0, 0) opaque: 2.11 ms over 7.47 MB; re-add of 32: 0.50 ms; `setGeometrySize` × 1.5: 2.81 ms |
| 5 noMultiDraw | `WEBGL_multi_draw` masked: 1,202 draw calls max (1,069 mean), frame p50 / p95 / max 4.165 / 8.33 / 12.495 ms, main p95 2.27 ms | `WEBGL_multi_draw` masked: 1,202 draw calls max (1,069 mean), frame p50 / p95 / max 4.165 / 4.165 / 4.165 ms, main p95 1.51 ms |
| 6 store | 768 / 512 MiB reserved; grew to 36 / 18 MiB; 384 of 384 reads exact; no error | 768 / 512 MiB reserved; grew to 36 / 18 MiB; 384 of 384 reads exact; no error |
| console errors | none | none |
| verdict | `basicPass` true; **`gatePass` true** (no failure) | `basicPass` true; `gatePass` true (recorded, not gated) |

- **The gate (§1.3) passes on Chrome / Iris Xe:** 0 mismatches; static p95 8.33 ms ≤ 16.7, 19 draw calls ≤ 100, main thread p95 2.01 ms ≤ 3; RD12's uploads project to 0.12 s ≤ 2 s; no store error. The plan continues.
- **The Iris cell was run twice.** The first run also passed the gate (static p50 / p95 / max 4.165 / 8.33 / 154.1 ms, main p95 1.88 ms), but item 2 had one long frame (frame 522 of 600, 154 ms). A frame's delta is the gap that ends at its rAF, which the previous frame's work fills, so frame 522's own main time (0.49 ms) does not explain it. The run's main-thread max, 153.33 ms, does: any frame before the last with a main time that long makes the next frame long, and 522 is the only long frame, with a delta (154.1 ms) just over that main time, so frame 521's `render()` almost certainly stalled for about 153 ms on the page's main thread. That is a one-off stall in the page's own GL work on the Iris (a driver or compile stall, for example), not a locked session. With the session still unlocked, the re-run had no long frame and no stall (main max 3.04 ms), and its JSON is the committed one; the first run's JSON is kept as `spike-chrome-iris-run1.json`. SP4b's streaming gate (no frame > 33 ms while streaming, §13.1) should watch for a recurrence on the Iris.
- **The earlier Chrome / RTX run is replaced.** That run (2026-10-21, 06:20, PRIME 'nvidia', HDMI at 143.6 Hz, ANGLE OpenGL) found the user's session locked: GNOME's screensaver had been active since 06:03 and DPMS reported the monitor off, so rAF ran at about 1 Hz and its item-2 p95 read 1,002.96 ms. Its item 2 was invalid; its basic criteria (decode, store, console) stood. The new run, with the display awake, has 0 long frames in item 2 and in item 5 and a p95 of one interval, which confirms that the old figure was environmental (the throttled rAF of an unseen page), not the renderer's.
- **Firefox / Iris Xe, Firefox / RTX 3060 Mobile:** pending (Task 33).

## 2. The one-shot load

### 2.1 Rings (`engine/rings.ts`)

- Needed sets (master §4.3): mesh = the integer disc dx² + dz² ≤ (RD + 0.5)²; L, D and T are each the previous set grown by the 3 × 3, so every job's prerequisites lie in the previous stage's set; a unit test checks RD12's exact counts (mesh 489, L 593, D 705, T 825) and the 3 × 3 containment for every RD in [4, 16]. Spiral offsets (by d², then angle) are precomputed once per RD.
- RD is an integer in [4, 16] (D3); the centre is the spawn column or the chosen point's (§8.2). The loader asserts that no two columns of the T set share a torus record (true for every RD ≤ 28).

### 2.2 The coordinator's one-shot core (`engine/coordinator.ts`)

- **States** per needed column: Absent → Proto (T) → Decorated (D) → Published (L) → meshed (MESH_COLUMN), mirrored on the main thread from job results (the store's `status` is the truth the workers read).
- **Prerequisites** (master §4.2): D when the 3×3 are ≥ Proto, L when the 3×3 are ≥ Decorated, MESH_COLUMN when the 3×3 are Published; each job also needs its own column in its stage's needed set.
- **Order:** a binary heap keyed by `d_h − stageBonus` (MESH 1.5, L 1.0, D 0.5, T 0; master §4.3), ties by `colKey`, so the pipeline fills from the centre outward and later stages start as soon as their prerequisites exist. No view term (D6).
- **Caps:** T ≤ N − 1 and MESH ≤ N in flight (master §4.3), at most one job per free worker handed to the pool, so the pool's queue never holds more than N jobs.
- **Intake:** a result whose recorded 3×3 versions differ from the store's at intake (`NeighborhoodReader.versions()`) is dropped. An L job reads its neighbours' blocks and fluid but not their light, and its own commit and its neighbours' L commits bump `lightVersion` legitimately, so an L result is compared on the nine `blockVersion`s only (the even indices) and a MESH result on all 18 values (nothing writes a Published column); T and D results carry no versions. A drop counts in the progress's `dropped` and stops the load with a `LoadError` ("dropped result"), reported in the load's details; in SP4a none can occur (nothing writes after Published and there is one configure). The epoch is checked by the pool: a reply of an old epoch rejects as `JobCancelled` (Task 16), which the coordinator turns into a `LoadError` like any other job rejection. `meshSeq` is SP4b's: SP4a issues exactly one MESH_COLUMN per column, and its result settles once, so no out-of-date mesh can reach intake.
- **Progress:** counts per stage (done / needed), uploads (done / total section meshes) and the stage-weighted fraction of §8.3.
- **Errors:** any job error (`INTERNAL`, `StoreFull`, `WorkerFailed`, a dropped result) stops the load and shows the failure panel (§8.3): a load-once world has nothing to retry around, and `StoreFull` suggests a lower RD.
- SP4b adds re-centring, the heap rebuild on a crossing or turn, cancellation, unload and the throttle to this module (§13.1).

### 2.3 Jobs and protocol (`workers/protocol.ts`, `taskHandler.ts`, `worldJobs.ts`, `engine/workerPool.ts`)

- **`attach`** (once per worker, before `configure`): `{type: 'attach', handles: StoreHandles}`; the guard checks every buffer is a `SharedArrayBuffer` of the documented size; the worker calls `attachStore` and replies `attached`. The pool's `attachStore(handles)` posts it to every worker and awaits every reply, as `configure` does (`workerPool.ts:319-332`).
- **`configure`** is unchanged (seed, params, the pool-wide 4-byte abort cell, `protocol.ts:154`); the 3D page configures once.
- **Jobs** (each `{type, jobId, epoch, cx, cz}`, ≈ 100 B), handled in `worldJobs.ts` on the attached store, each returning `{msg, transfer} | null` (ABORTED) like `fieldSliceJob.ts`:
  - `terrain`: `fillColumnT(store, ctx, cx, cz, stop, epoch)` (`metrics/region.ts:31`; claims, runs T, commits 1, frees on stop or throw) → `{cx, cz, ms}`;
  - `decorate`: `reopenColumn(cx, cz, 1)`, the D skeleton over `store.neighborhood(cx, cz)` (§3), commit 2 → `{cx, cz, ms}`;
  - `light`: `reopenColumn(cx, cz, 2)`, the light job (§4), 24 × `setLight`, commit 3 → `{cx, cz, ms, versions}`;
  - `meshColumn`: the 3×3 Published, every non-trivial section meshed (§5.8) → the column payload, its buffers transferred.
- **Replies** get `REPLY_CHECKS` guards with byte-length checks (`protocol.ts:356`), the mesh payload's table checked against its buffers.
- **Pool:** methods for the four jobs at priority 0 (the coordinator orders them, so the pool's queue holds at most N); `createBrowserPool` takes an explicit size, so `?workers=4` gives master §7's 4-worker cap (`workerPool.ts:491`).

### 2.4 Who reads and writes what, and why it is safe in SP4a

The single-writer-by-status rule (master §4.1), with `status` stored last by `commit` (`store.ts:250-255`) and read with Atomics:
- **T of K** writes K's proto and aux under its claim; a neighbour's D reads K's proto only after K is committed at ≥ Proto (`store.proto`, `store.ts:280`).
- **D of K** writes K's final entries and the final heightmap fields of K's aux A at status 1; `final(K)` is null below status 2 (`store.ts:285`), and the neighbours' D jobs read K's proto entries, which `shareFinal` only retains (an Atomics add), and K's `_WG` heightmaps, other bytes of the same slot.
- **L of K** writes K's light entries at status 2; the neighbours' L jobs read K's final blocks, fluid and `LIGHT_BLOCKING`, which L does not touch; K's light is read only by mesh jobs, after K is Published.
- **MESH of K** and the main thread read Published columns only, which nothing writes in SP4a.
- **No slot is ever freed** during a session: no `freeColumn`, no `freeProto`, and every `setLight` replaces a uniform entry (the light-once invariant, §2.5), so `storeChannel` never frees an old slot (`section.ts:70-82`). Hence no reader can see a recycled slot.

### 2.5 Store changes (D4)

- **The shared store on the page:** `createStore({shared: true, maxBlockBytes, maxByteBytes})` with the maxima of §8.5; the page keeps its own attached view (camera placement and the eye's sky light read Published columns).
- **`store.reopenColumn(cx, cz, from: 1 | 2): ColumnWriter`:** throws unless the record holds (cx, cz) at status `from`; clears nothing; its `aux()` and `auxB()` return the record's existing slots (allocating only when the record has none), unlike a fresh claim's writer, which allocates on first call (`store.ts:232-248`).
- **`ColumnWriter.setLight(sy, light: Uint8Array)`:** stores the light channel (uniform or dense, `storeBytes`); throws `light already written` when the entry holds a slot (the light-once invariant of SP4a; SP5's relight replaces it under SP4b's reclamation protocol).
- **`commit(status)`** bumps `blockVersion` when the writer wrote blocks or fluid (`setProto`, `setFinal`, `shareFinal`), `lightVersion` when it wrote light (`setFinal`, `setLight`; `shareFinal`'s all-zero light of the D skeleton counts as no light change), then stores the status. T's commit is unchanged (blockVersion 1, lightVersion 0); D's makes blockVersion 2; L's makes lightVersion 1. Unit-tested, with `versions()` (`store.ts:307-319`).
- **`attachStore`/`attachPool`** assert a `SharedArrayBuffer` when `shared` and an `ArrayBuffer` otherwise (SP3a §10's item 7).

### 2.6 SP3a's store concurrency items (SP3a §10, nine bullets)

| item | SP4a | why it is safe until SP4b |
|---|---|---|
| ABA in `find`/`committed`/`check` (no claim generation) | SP4b | no record is unclaimed and reclaimed during a session (D3); the T set never shares a record (§2.1) |
| versions restart at 0 on every claim | SP4b | no re-claim, so versions are monotone per session |
| `proto()` after `freeProto` reads all air (alive bit) | SP4b | SP4a never calls `freeProto` (D7) |
| post-commit rewrite frees the old slot before the version bump (seqlock or limbo list) | SP4b | the only post-commit write is `setLight` over a uniform entry, which frees nothing (§2.4, §2.5) |
| `ColumnWriter` is single-thread; concurrent `freeColumn` can double-free | doc reworded in `api.ts`; cancellation through the epoch cells: SP4b | no `freeColumn` during a session; one writer per column by the coordinator's states |
| a worker terminated while holding a pool lock spins everyone | SP4b (owner id in the lock word) | the pool terminates a worker only after an `error` or `messageerror` event (`workerPool.ts:241`), when its task has ended and every critical section has released in `finally` (`pool.ts:166-215`); page teardown discards the world first; a hung load still ends at the 30 s watchdog (§8.3) |
| `attachStore`/`attachPool` assert the buffer kind | **SP4a** (§2.5) | — |
| slab fuzz: column-table races, cross-thread slot handoff | SP4b | no claim races in SP4a; cross-thread retains (D's `shareFinal` of T's slots) are Atomics adds, covered by the DT1 light part on 4 threads (§9.1) |
| growable SAB / resizable ArrayBuffer probe | **SP4a** (§8.5) | — |

## 3. The D skeleton (`gen/pipeline/decorateStage.ts`)

### 3.1 The stage

`decorateStage(ctx, nb: NeighborhoodReader, w: ColumnWriter, stop)` is the pull model of master §3.12 with an empty feature list: it iterates the nine source columns of the 3×3 proto and the steps in order, placing nothing; then, for each section, `w.shareFinal(sy, ZERO_LIGHT)` (final blocks and fluid share the proto slots, `store.ts:221-231`; the all-zero light is uniform and stores no slot); then the final heightmaps (§3.2). Settle (SP7), freeze_top_layer (SP8b) and the diff overlay (SP5) are its later steps. It polls `stop` between steps.

### 3.2 Final heightmaps (`gen/pipeline/finalHeightmaps.ts`)

A value is the absolute y of the highest qualifying voxel plus one, −64 when none qualifies (master §2.3), computed top-down per position over the final blocks and fluid:
- `WORLD_SURFACE`: state ≠ air or fluid type ≠ 0;
- `OCEAN_FLOOR`: `COLLIDE[state]` ≠ none;
- `MOTION_BLOCKING`: `COLLIDE[state]` ≠ none or fluid type ≠ 0;
- `LIGHT_BLOCKING`: the highest voxel the straight sky fall does not enter (§4.1's predicate N), plus one.
With zero features the first three equal the proto's `_WG` maps where they coincide; a unit test checks it on generated columns. Under a floating island all four are the island top + 1 (SP3e §3.5).

## 4. Light (`light/initial.ts`, `light/queue.ts`)

### 4.1 The rule, pinned (D8)

- **Effective opacity** `effOpacity(s, f) = max(OPACITY[s], fluidType(f) ≠ 0 ? 1 : 0)`; **effective emission** `effEmit(s, f) = max(EMIT[s], fluidType(f) = lava ? 15 : 0)` (`world/blocks/light.ts`, master §2.2).
- **The straight fall.** A voxel at y is not entered by the fall, N(y), when `effOpacity(y) > 0`, or its `FULL_FACES` has the up bit, or the voxel above has the down bit. `LIGHT_BLOCKING = 1 + max{y : N(y)}` (−64 when none); every voxel at y ≥ `LIGHT_BLOCKING` gets sky 15. This is master §2.2's FULL_FACES rule with water's opacity added: water stops the fall.
- **The BFS.** Light crosses from u to its neighbour v through face f unless `FULL_FACES[u]` has f or `FULL_FACES[v]` has the opposite face; the level entering v is `level(u) − max(1, effOpacity(v))`, never below 0; opaque full cubes are never entered. Sky and block light run as two BFS with the same step.
- **Below and above the world:** below y −64 is opaque; above y 319 is air with sky 15.
- Until SP8a every state is an opaque full cube or air (`world/blocks/defs.ts`), so in the real world the rule reduces to "air passes, water passes at −1 and stops the fall, everything else blocks"; the partial-face and emitter cases are unit-tested with injected tables (§9.7).

### 4.2 The job

1. Copy the 3×3 final blocks and fluid of the light region, 46 × 384 × 46 voxels (15 + 16 + 15; master §4.8), and the nine columns' `LIGHT_BLOCKING`, through `padded.ts` into worker-local scratch (≈ 1.6 MB blocks, 0.8 MB fluid, 0.8 MB light, allocated once per worker).
2. Seed sky 15 at and above `LIGHT_BLOCKING` per position; enqueue only boundary seeds (a 15 voxel with a non-15, enterable neighbour).
3. Run the sky BFS, then the block BFS from every voxel with `effEmit > 0` (none in SP4a's world; lava from SP7, emitters from SP8b), on the Int32 ring queue.
4. Write the centre 16 × 384 × 16 as 24 sections; `storeBytes` turns uniform sections into descriptors (0xF0 in open sky, 0 in sealed rock).
The 15-block padding is the maximum reach, so the result equals a global BFS over the same voxels (L1, §9.1).

### 4.3 `world/store/padded.ts`

Two layouts with their index functions and copy routines, the only store file light and mesh may value-import (`test/arch/rules/imports.ts:12`): the light region above (x, z in [−15, 31), y in [−64, 320)), and the mesh section of §5.1 (18³). The copies read through `ColumnView.sectionBlocks`/`sectionFluid` and the final light entries, writing uniform sections with a fill.

### 4.4 The island shadow (D9)

Floating islands are solid runs at y 193-263 over air (SP3e §3); `LIGHT_BLOCKING` at an island position is the island top + 1, so the ground and sea under an island get no straight fall. Sky light reaches them sideways only, losing 1 per block from the open sky around the footprint: ground within 14 blocks of the footprint's edge is dimly lit, and the middle of a large island reads sky 0. This is the exact result (L1 checks it on the floating_islands region, §9.1); grass under islands (SP3e D21 (b)) therefore sits at sky 0, which S1's recorded part measures (§9.1). The user judges the look at the cycle check (point 2).

## 5. Meshing (`mesh/`)

### 5.1 Input

Per section, an 18³ padded view of blocks (u16), light (u8) and fluid (u8) copied from the 3×3 Published columns (master §4.4): below the world opaque, above it air with sky 15. A section is **trivial**, and skipped, when its blocks are uniform air without fluid and its six face neighbours are uniform air without fluid, or uniform opaque full cubes and its six neighbours too; its connectivity is then all 15 bits or 0.

### 5.2 Face visibility and passes

As master §4.4: a neighbour occludes a face when it is PASS opaque with the facing bit in `FULL_FACES`; opaque faces against non-occluders; cutout faces against non-occluders that are a different block (leaves against leaves render); translucent and fluid faces against a non-occluder that is not the same fluid. A water voxel (air + water byte) is meshed by §5.6 into the translucent pass (pass 2); `META_TRANSLUCENT` stays 0 for water sections (meta counts PASS states, and water is a fluid byte; `META_FLUID` marks them). The cutout pass exists and is tested on injected tables; SP4a's world has no cutout state.

### 5.3 AO and smooth light

- "Opaque" here is PASS opaque with `FULL_FACES` 63 (master §4.4).
- **AO** per vertex from the two edge voxels s1, s2 and the corner c on the face's air side: `ao2 = (s1 ∧ s2) ? 3 : s1 + s2 + c`, factor `[1, 0.8, 0.6, 0.45][ao2]` (09's table); the quad's diagonal follows 09's flip rule (split along the diagonal with the larger corner AO sum), ported with its canned tests.
- **Smooth light** per vertex, per channel: the samples are the face voxel F and the edge and corner voxels on the air side that are not opaque, the corner skipped when both edges are opaque; `v = ⌊(2·sum + n) / (2n)⌋` over the n ≥ 1 samples (round half up, integers only, so every engine agrees).
- **AO and smooth light off** (the R2 `noAo` part; SP11's Low): `ao2` 0 and F's light on every vertex.

### 5.4 Greedy merge

Per axis and slice, a 16 × 16 mask of two u32 keys per face, `(layer, tint, flags, face, ao×4)` and `(sky×4, block×4)` (master §4.4): faces merge only when both keys are equal, so a merged quad's interpolated values are exact. Water's keys are §5.6's.

### 5.5 Vertex format and `PACK_LAYOUT` (D11)

- `position`: Uint8x4 `(x·8, y·8, z·8, 0)`, section-local in 1/8-block units (0 … 128).
- `data` (uint32), bit 0 first:
  - opaque and cutout: `layer` 0-9, `face` 10-12, `ao` 13-14, `sky` 15-18, `block` 19-22, `tint` 23-25, `flags` 26-29 (emissive, waving, randomRotate, upper), spare 30-31;
  - fluid: `layer` 0-9, `face` 10-12, `sky` 13-16, `block` 17-20, `depth` 21-24, `tint` 25-27, `cornerDrop` 28-31.
- `cornerDrop` counts ninths of a block below the voxel's top (0 full height; a still source's surface is 8/9, drop 1; flowing levels reach 8, SP7). `depth` is the count of fluid voxels from the surface down to the first non-fluid voxel, clamped to 15.
- In SP4a `layer` is the block state id (D14); `tint` is `TINT[state]`, packed and ignored by the shader until SP8a; `flags` are 0.
- `mesh/packing.ts` exports `PACK_LAYOUT` (offset and width per field, both variants); `render/materials/glsl/packing.glsl.ts` generates the `#define`s and the GLSL unpack expressions from it.

### 5.6 Still water (`mesh/fluid.ts`)

Water faces against non-occluders that are not water; the top face of a surface voxel (no water above) sits at y + 8/9 (`cornerDrop` 1 on its four corners), a side face's top corners take the drop of the surface they meet; faces carry the voxel's `depth`. Greedy keys `(face, sky×4, block×4, depth, cornerDrop×4)`: an ocean deeper than 15 merges into large quads, a sloping shore does not (R5 recorded, §9.1). Water runs only as still sources in T (`terrainStage.ts:162`), so this covers SP4a's world; flowing levels are SP7's.

### 5.7 Connectivity (D10)

`connectivity15`: for each of the 15 unordered pairs of distinct faces, whether a 6-connected path through non-opaque voxels of the section joins them (a flood over the 16³ per component, faces touched recorded). Computed in the mesh job for every section, trivial sections included (all-air 0x7FFF, all-opaque 0), and carried in the payload.

### 5.8 The column payload (`mesh/column.ts`, D12)

A `meshColumn` result carries `versions` (Int32Array(18) read before the copy), `connectivity` (Uint16Array(24)), one `position` (Uint8 × 4 per vertex), one `data` (Uint32 per vertex) and one `index` (Uint32, 6 per quad, relative to its section's first vertex) buffer, and a table of rows `(sy, pass, vertexStart, vertexCount, indexStart, indexCount)` with a bounding sphere `(x, y, z, r)` per row in section-local blocks. The renderer wraps subarrays per row (`new BufferAttribute(view, n)`); each row is master §2.5's `SectionMesh` (its `seq` the coordinator's, `emitters` absent until SP8c).

## 6. Rendering (`render/`)

### 6.1 The renderer (`render/renderer.ts`)

Replaces SP0's `startSkyRenderer` (`render/renderer.ts:9`): a `WebGLRenderer` with SP0's defaults (antialias off, pixel ratio min(dpr, 1), `outputColorSpace` sRGB), a perspective camera (FOV 70° by default, near 0.1, far (RD + 2)·16·1.5), the scene of the section renderer's regions (§6.2) and the sky, and a frame loop driven by the FPS limiter (§6.8). Pass order (master §4.5): opaque (front side, sorted front to back), the sky dome, cutout (double side, alpha test), translucent (blended, depth write on, back to front by section centre, by region centre on RegionMesh, water top double-sided). The LOD pass with its depth clear (SP11) goes first when it exists.

### 6.2 The section renderers: RegionBatch and RegionMesh (`render/sectionRenderer.ts`, `regionBatch.ts`, `regionMesh.ts`)

`SectionRenderer` is the interface the page talks to (stage a column payload, build a region, reveal all, set the origin, counts); `selectSectionRenderer(report, override)` returns RegionBatch when `multiDraw` is true and RegionMesh when it is false, `?renderer=batch|mesh` overriding it (tests and measurements); the HUD and the flight JSON name the one in use. Both share the payload, the materials' GLSL and the region grid; they differ only in how a region's sections reach the GPU.

**RegionBatch** (wherever `WEBGL_multi_draw` exists: Chrome):
- A region is 8 × 8 columns aligned to `cx >> 3`, `cz >> 3` (master §4.5); it owns up to three `BatchedMesh`, created only for passes that have geometry, sized exactly from its columns' payloads (D13). One instance per section and pass; the instance matrix translates to the section origin `(cx·16, sy·16 − 64, cz·16)` minus the floating origin; `geometry.boundingSphere` (and the box) set from the payload before `addGeometry`; `perObjectFrustumCulled` on.
- At RD12 the disc covers ≈ 21 regions, so ≈ 45-65 draw calls (opaque everywhere, translucent where there is water) plus the sky.

**RegionMesh** (D2; where `WEBGL_multi_draw` is missing: Firefox, on both GPUs):
- The same regions; per region and pass one `Mesh` over one merged `BufferGeometry`, sized exactly at load (D13): the sections' vertices concatenated, `position` rewritten to **Uint16x4 region-local** 1/8-block units (`x + lx·128`, `y + sy·128`, `z + lz·128` for the section at local column (lx, lz) and section sy; at most 1024 × 3072 × 1024, within u16), `data` copied unchanged, indices rebased by each section's first vertex. The merge runs on the main thread inside the loading upload budget (below) and is measured in the flight JSON.
- One draw per region and pass; the mesh's matrix is the region origin minus the floating origin; culling per region (`frustumCulled` on the union of its sections' spheres); translucent regions drawn back to front by region centre (no per-section sort inside a region: water writes depth, so the difference is limited to water seen through water of the same region, which the parity check bounds, §9.6).
- The terrain and water materials gain a RegionMesh variant (a `REGION_MESH` define: the Uint16 position path without the batching chunks), generated from the same GLSL module (D7).
- Master §4.5's sub-allocated ranges, `addUpdateRange` and per-region rebuilds serve churn while streaming: SP4b's. In SP4a a region's buffers are written once.
- Draw calls at RD12: ≈ 21 regions × (opaque + translucent where there is water) ≈ 25-45, plus the sky.

**Both renderers:**
- **Uploads** (`engine/uploadBudget.ts`): while the loading screen is up, `addGeometry` and instance setup (RegionBatch) or the merge and buffer creation (RegionMesh) run ≤ 12 ms per frame (the overlay keeps animating); master §4.3's 2 ms and 32 sections apply to SP4b's flight.
- **The reveal** (master §4.2's atomic reveal, for the whole world at once): every section or region is added hidden, then all are shown in one frame (§8.4).
- **Tests** (§9.7): one contract suite run against both implementations (staging, exact sizing, hidden until the reveal, origin rebase, counts), plus each one's own checks; the browser parity check renders the same view through both (§9.6).

### 6.3 Flat colours and the texture array (`textures/flatColors.ts`, `render/textureArray.ts`, D14)

- `textures/flatColors.ts` holds one sRGB colour per block type name (today's `VOXEL_COLORS` block entries, `ui/crossSection/voxels.ts:29-59`), with **packed_ice [100, 146, 226]** (was [142, 180, 250]: its summed |ΔRGB| from the sky colour [168, 204, 255] goes from 55 to 155; it stays ≥ 24 from every other block, SP3c §8's test, and 36 from the sea-level line). The Voxels palette keeps its own `sky`, `seaLevel`, `water` and `unknown` entries and reads the block colours from the new module.
- `textureArray.ts` builds a `DataArrayTexture` of 1 × 1 RGBA8 texels, one layer per state id (layer = state, D14), `SRGBColorSpace`, through `REGISTRY` (render may import world and textures). SP8a replaces it with the painted array and `FACE_TEX`.

### 6.4 Materials v1 (`render/materials/`)

- `createMaterialSystem(settings)` returns `terrainOpaque`, `terrainCutout`, `water('fast')`, `sky` and `setFrameUniforms(frame)` (master §4.6; lava, clouds, lod, shadowDepth and selection come with their SPs). All are `ShaderMaterial({glslVersion: GLSL3})`; the terrain and water materials with the batching chunks for RegionBatch, and in a `REGION_MESH` variant (Uint16 region-local position, no batching chunks) for RegionMesh (§6.2), both generated from the same GLSL.
- **Terrain:** `albedo(layer) × faceShade × AO × lightmap(sky, block)`, faceShade top 1, bottom 0.5, N/S 0.8, E/W 0.6; no Lambert, no sun term (master §4.6); sky and block interpolated per vertex (smooth light) and looked up in the lightmap; spherical fog (§6.6); output through three's colour-space chunk.
- **Water, Fast tier** (master §4.10): alpha 0.72, colour from shallow sRGB [64, 128, 230] to deep [16, 40, 96] by `depth / 15`, × the lightmap; one tint until SP8a's biome water tint.
- **Colour management:** the albedo array sRGB, the lightmap linear (`NoColorSpace`), output sRGB, colours converted to linear on the CPU where they are uniforms.
- The materials are compiled with `renderer.compileAsync` behind the loading screen (§8.4).

### 6.5 Sky and day/night (`daynight/dayNight.ts`, `render/sky.ts`, D16)

- **Time** t ∈ [0, 1): the sun's direction `(cos 2πt, sin 2πt · cos 20°, sin 2πt · sin 20°)` (x east, y up, z south), so elevation `e = asin(sin 2πt · cos 20°)`: t 0 sunrise (06:00), 0.25 noon (12:00, e 70°), 0.5 sunset, 0.75 midnight. The clock reads `(6 + 24t) mod 24`. A day lasts 20 min at ×1; the world opens at 08:00 (e ≈ 28°).
- **Phases** from elevation (master §4.9): day e ≥ 10°, night e ≤ −6°, dawn or dusk in between (rising or setting); day factor `smoothstep(−6°, 10°, e)`.
- **Sky dome:** a full-screen triangle drawn after the opaque pass at the far plane, the view ray from the inverse projection; a zenith-to-horizon gradient blended between day (zenith #3D78D6, horizon #A8CCF5), dusk (horizon #E8914D, as a bump peaked at e 0) and night (zenith #04070F, horizon #0D1526); a sun disc of 2° radius with a glow to 12°. `skyColor(dir)` lives in `common.glsl.ts`, shared with fog and water (master §4.6).
- **Time speed:** T cycles ×1, ×10, ×60, paused (D16); the HUD shows the clock and the speed.
- Moon, stars and clouds: SP11.

### 6.6 Fog and the world-edge fade (D15)

- Spherical fog `f = smoothstep(fogStart, fogEnd, length(viewPos))` (master §4.6) with fogEnd (RD − 0.5)·16 and fogStart max(0, fogEnd − 64) (RD12: 120-184; RD8: 56-120; RD4: 0-56), colour `skyColor(horizonDir)` darkened by the lightmap's sky value at the eye's sky light (read from the store at the camera's voxel; 0 inside terrain, so the fog goes dark there).
- **The edge fade (SP4a only):** `max(f, smoothstep(edge − 24, edge, horizontal distance from the load centre))`, edge (RD − 0.5)·16 (RD12: 160-184, inside the meshed disc's radius of about 200), in every terrain and water fragment, so the disc's cut edge is fogged from wherever the camera is; the clamp of §7.5 keeps the camera 16 blocks inside the fade. SP4b drops it (with streaming the needed disc follows the camera).

### 6.7 Lightmap (`render/lightmap.ts`)

A 16 × 16 RGBA8 `DataTexture` rebuilt on the CPU when time or brightness changes (master §4.8): `curve(l) = (l/15) / (3(1 − l/15) + 1)`; sky `curve(s) × mix(0.15, 1, dayFactor)` tinted from night [0.45, 0.55, 0.85] to white by the day factor and to warm [1, 0.8, 0.65] by the dusk bump; block `curve(b) × [1, 0.85, 0.65]`, independent of time; combined by per-channel max; brightness β ∈ [0, 1] (default 0.3): `c' = mix(c, 1 − (1 − c)⁴, β)`, which keeps (0, 0) at 0 for every β.

### 6.8 Floating origin and FPS limiter (`render/floatingOrigin.ts`, `fpsLimiter.ts`)

- **Floating origin** (master §2.1): snapped to 512 blocks, rebased when the camera is more than 1024 blocks from it (instance matrices re-set). The load centre sets the first origin; within SP4a's clamp a rebase does not trigger, but the rule is unit-tested at ±500,000.
- **FPS limiter** (master §4.17): caps off (the display's rate), 30, 60, 120, 144; on each rAF `acc += Δ`; a frame renders when `acc ≥ 1000/cap − h`, h half the display interval (median of recent rAF deltas), then `acc = clamp(acc − 1000/cap, −h, 1000/cap)` (the floor −h carries up to half an interval of deficit, so a cap that does not divide the display rate still averages the cap: 144 Hz at cap 60 gives 60 fps, where a floor of 0 gives about 72); frames that do not render skip input-free work.

### 6.9 HUD (`ui/hud.ts`, D30)

The fps line of today (`ui/hud.ts:9-12`) plus: columns T/D/L/meshed, section meshes uploaded, draw calls and triangles (`renderer.info`), position and column, speed, clock and time speed, RD, workers, the section renderer in use (batch or mesh, §6.2), the renderer string as reported (so the user sees which GPU runs; Firefox masks it, §1.5). F3 toggles it.

### 6.10 `core/params/graphicsPresets.ts` (D17)

A pure data module with one row, `MEDIUM`, holding the fields SP4a reads: `rd` 12, `uploadBudgetMs` 2 and `uploadSections` 32 (SP4b's flight), `ao` and `smoothLight` true, `water` 'fast', `pixelRatioCap` 1, `fogBand` 64. SP8c adds the audio rows, SP11 the Low, High and Ultra rows and the other fields (master §4.16).

## 7. Player and input (`player/`, `ui/help.ts`)

### 7.1 Spectator controller (`player/fly.ts`, D18)

- Pointer lock on a click of the canvas; mouse movement turns yaw and pitch (pitch within ±89.9°) by the sensitivity setting; Esc releases (the browser's).
- Movement: forward and back along the full look vector, strafe along the horizontal right vector, up and down along world y; the velocity approaches the input's target with `1 − exp(−Δ/0.1 s)` per frame, so the motion is dt-scaled and frame-rate independent; no collisions.
- Speed: 12 blocks/s by default, ×1.25 or ÷1.25 per step, clamped to [1, 96]; Ctrl ×4 while held; shown in the HUD.
- Keys are cleared on blur and on pointer unlock, and ignored while focus is in a text input (master §4.17).
- **Ctrl+W:** while the world is open, a `beforeunload` handler asks before the tab closes; in fullscreen (a help-overlay button), Chromium's `navigator.keyboard.lock()` captures it (Firefox has no Keyboard Lock and keeps the prompt).

### 7.2 Speed keys (D18)

The plain wheel (one step per notch), `+` (or `=`) and `-` change the speed. Alt+wheel is not bound: Firefox's default Alt+wheel action and some window managers take it. When SP5's hotbar takes the wheel, SP5 chooses the wheel's speed modifier; `+`/`-` stay.

### 7.3 The key map as data (`player/keymap.ts`, D19)

`DEFAULT_KEYMAP`: a readonly list of `{action, bindings, label, group, since}`; a binding is a `KeyboardEvent.code` (`KeyW`, `Space`, `ShiftLeft`, `ControlLeft`, `F1` …), a `key:` value (`key:+`) or a wheel direction. The input layer resolves events to actions through it and never names a key elsewhere; overrides would be a second list merged over it (SP5's remapping panel). SP4a's actions: forward, back, left, right (W A S D), up (Space), down (Shift), sprint (Ctrl), speedUp and speedDown (wheel, `+`/`=`, `-`), timeSpeed (T), help (H, F1), hud (F3), loadHere (R), releasePointer (Esc, listed only). A unit test checks every action is bound, no binding is shared, and the help and the tips name every action. Every later SP that adds keys extends this list (master §10 SP4).

### 7.4 Help overlay (`ui/help.ts`, D31)

H or F1 (default actions prevented) opens an overlay and releases the pointer: **Keys** (generated from the key map), **Settings** (render distance, which reloads the page; FPS cap; field of view 50-100°; mouse sensitivity; brightness; persisted in `localStorage` behind try/catch), **System** (the capability report with "Copy as JSON" and the hidden `#capability-json`), and the links "Open the map here" and "Fullscreen". Closing it and clicking the canvas re-locks the pointer.

### 7.5 The world edge (D20)

The camera's horizontal distance from the load centre is held to (RD − 3)·16 blocks (RD12: 144; RD4: 16): past it the outward velocity component is removed, and a notice says "Edge of the loaded world — press R to load the world around you". R (at any time) reloads the page with `?at=<x>,<z>&y=<y>&yaw=<deg>&pitch=<deg>` and the current `#` world, behind the loading screen. Vertically the camera stays within y −64 … 400. SP4b replaces both with streaming.

## 8. The 3D page

### 8.1 Routes (`main.ts`, D21)

- `/`: the start screen, then the 3D world in the same page (`ui/world/startScreen.ts`, `ui/world/worldPage.ts`), replacing SP0's sky page (`main.ts:10-22`); no tool visits the default route today (`test/tools/uiSmoke.ts`, `mapLatency.ts` open `?selftest=1` and `?map`).
- **The start screen (D21), kept minimal:** on the loading screen's background (§8.3), the title, the seed and the profile the world will use, and two buttons: "Enter the world" and "Open the map" (`?map#<the same hash>`). Nothing is probed, generated or allocated while it shows. "Enter the world" hides it and starts §8.4 in the same page, with no navigation and no history entry; the help's capability report and settings are reached from the world, not from here. The full start and worlds menu (saved worlds, create, load, settings) is SP5's (§13.2).
- **When it shows:** whenever none of `?at`, `?rd`, `?workers` is in the query (a `#` hash alone still shows it, with that hash's seed and profile). Any of the three goes straight to the loading screen: they are set by "Open in 3D", the R reload at the world edge (§7.5), the render-distance setting's reload, the failure panel's lower-RD link and the tools (uiSmoke, the flight and panorama tools). `startModeOf(query)` decides it and is unit-tested.
- The world comes from the `#` hash in `?map`'s encoding (`decodeMapState`, `ui/map/mapState.ts:72`; `openMapSession` with `validateParamTrees`, as `test/arch/uiSessions.test.ts` requires); without a hash, `?map`'s defaults (`DEFAULT_MAP_STATE`, seed '42', default profile, `mapState.ts:40`). The start screen reads the same state, so it names exactly the world that loads; an invalid hash shows the decode error on the start screen (with "Open the map") instead of the world.
- `?at=x,z` (integers clamped to ±500,000, master §2.1), optional `y` (−64 … 400), `yaw`, `pitch` in degrees; `?rd=` (4 … 16); `?workers=` (2 … 6); `?renderer=batch|mesh` (§6.2; a measurement and test override, it does not skip the start screen by itself).
- `?flight=sp4a` (§9.5), `?pano=<id>` (§8.3), `?spike=batch` (§1) are their own routes, without the start screen; `?map`, `?selftest=1`, `?lab=noise` unchanged.

### 8.2 With `?map` (SP4b builds the overlay)

`?map`'s toolbar gains "Open in 3D": `/?at=<pin, else view centre>#<the map's hash>`, in the same tab (with `?at`, it skips the start screen). The help's "Open the map here" opens `?map#…` centred on the camera. The M overlay, click-to-teleport and the shared session are SP4b's (§13.1).

### 8.3 Loading screen (`ui/loading/`, D22)

- **Background:** a panorama chosen at random from `public/panoramas/manifest.json` (fetched; same origin, so COEP is satisfied), shown with `object-fit: cover` and faded in when decoded; until then, or without a manifest or image, a neutral gradient from the day sky's zenith to its horizon colour (§6.5).
- **Foreground:** a tip rotating every 7 s, starting at a random one, generated from the key map and `ui/loading/tips.ts`'s templates (move, rise and descend, sprint, change speed, time speed, help and HUD, load around you at the edge, shape the world on `?map` and "Open in 3D", the presets on the map, click to look and Esc to free the mouse).
- **Progress:** one thin bar with the fraction `0.2·T + 0.05·D + 0.25·L + 0.35·MESH + 0.15·uploads` (each done/needed) and one small line naming the current phase (Generating, Lighting, Meshing, Preparing the view).
- **Failure:** any load error or 30 s without progress shows a panel with the cause, "Copy details" and links to the map and to a lower RD.
- **Panoramas tool** (`test/tools/panoramas.ts`, `npm run assets:panoramas`): the CDP helpers of uiSmoke move to `test/tools/cdp.ts` (uiSmoke imports them back; `mapLatency.ts` keeps its copy); the tool builds, starts its own `vite preview` on a free port (never 5183), launches its own Chrome with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (or the system GPU with `--gpu`), prints the probed renderer and refuses when WebGL2 is missing, opens `/?pano=<id>` for each entry of its `PANORAMAS` table, waits for `window.__wiPano.ready`, captures 1920 × 1080 WebP at quality 80, and writes the images and `manifest.json` (id, file, seed, profile, x, z, yaw, pitch, time, commit, renderer). It stops only what it started. The capture mode loads at RD12 without HUD or overlay, time fixed, and signals readiness after the reveal and three frames.
- **Viewpoints** (six; the table is data, unit-tested): seed 42 default at a coast, a mountain and a badlands site of `REVIEW_SITES` (`test/harness/reviewSlices.ts:263`); amplified's, archipelago's and floating_islands' golden windows (`metrics/sp3eGoldens.ts:141`, `sp3eWindow`); each 32 blocks above the site's `MOTION_BLOCKING`, pitch −10°, at 08:00 or 17:00.

### 8.4 First load

0. On a bare `/` the start screen first (§8.1); "Enter the world" starts step 1. With `?at`, `?rd` or `?workers` step 1 starts at once.
1. Probe and evaluate the capabilities (§8.5); show the loading screen at once.
2. Create the store, the pool (N = clamp(cores − 2, 2, 6) or `?workers`), `attachStore`, `configure`.
3. The centre: `?at`, or the pool's `spawn` job (`gen/column/spawn.ts`).
4. `coordinator.load(centre, rd)`; mesh payloads staged into region batches within the loading budget (§6.2).
5. When every needed column is meshed and every section uploaded: `compileAsync`, place the camera (D32: 2 blocks above `MOTION_BLOCKING` at the centre position unless `?at` gave y; yaw toward the lowest of eight `MOTION_BLOCKING` samples 48 blocks away; pitch −10° unless given), render three frames behind the opaque overlay, show every section in one frame, fade the overlay out over 300 ms, and show "Click to fly" until the pointer is locked.
Nothing of the world is visible before step 5 (the user's priority 1). The page records the reveal time, the main thread's long tasks during the load (count and max, `PerformanceObserver('longtask')` where available) and the first 120 frames' max, for the flight JSON (§9.5).

### 8.5 Capabilities and degradation (`engine/capabilities.ts`, `capabilityRules.ts`, `renderDistance.ts`, D23)

- **New probes:** growable `SharedArrayBuffer` (`new SharedArrayBuffer(0, {maxByteLength})`, `growable`, one `grow`); the store reservation (the default maxima, then halves, down to 192/128 MiB).
- **Blocking on the 3D page** (an error screen naming the cause, the capability table and a link to `?map`, which needs no SAB or WebGL2: its pool creates its abort cell only under isolation, `workerPool.ts:491-495`): today's causes (insecure context, page or worker not isolated, worker probe failed, SAB not shared, no WebGL2), plus no growable SAB.
- **Default render distance** (`defaultRenderDistance(report)`, unit-tested): 6 when the renderer string names a software rasteriser (SwiftShader, llvmpipe, softpipe, "Software"), else 8 when `hardwareConcurrency` ≤ 4 or `deviceMemory` ≤ 4, else 12; capped by the accepted reservation (RD ≤ 8 at 384/256 MiB, ≤ 6 below); `?rd` and the setting override it within the cap. `deviceMemory` is absent in Firefox and then counts as unknown. Firefox masks the renderer string (the user's check, §1.5: "NVIDIA GeForce GTX 980, or similar" on the RTX), so the software rule applies there only when the reported string names one; the run-time notice below is the backstop. Everywhere the string is recorded as reported, never used to identify the GPU of a measurement on Firefox.
- **Warnings:** no multi-draw (the per-region path, RegionMesh, is used; §1.5, §6.2); no timer query (GPU ms unavailable; frame timing is CPU-side only, as on Firefox).
- **At run time:** if the first 300 frames after the reveal have p95 > 25 ms, a dismissible notice suggests the next lower RD (a reload; never automatic).

## 9. Metrics and tests

### 9.1 Metric rows (`test/thresholds.ts`)

| row | parts | SP4a | file |
|---|---|---|---|
| R1 | `hiddenEmitted` max 0, `visibleMissing` max 0 (opaque and water faces of interior columns vs the brute-force count) | gated, every tier | render.metric.ts |
| R2 | `quadsPerFaceAo` max 0.85, `quadsPerFaceNoAo` max 0.55, retuned from the master's 0.6 / 0.35 by the user's decision of 2026-10-22: those came from world-imaginer 09's nearly flat terrain, while SP3b's density terrain measures 0.70-0.79 / 0.44-0.50 (Task 18, all tiers) with a mesher that R1 shows exact and that stays within 0.7 % of the exact minimum rectangle partition for its keys; the geometry alone gives 0.42-0.49, per-corner AO adds ≈ 0.26 (master §4.4) | gated, every tier | render.metric.ts |
| R4 | `medianQuads` max 2000, `p95Quads` max 4000 per column | recorded (activeFrom SP8b, the master's) | render.metric.ts |
| R5 | `waterQuadsPerFace` max 0.1 | recorded (activeFrom SP7, D26) | render.metric.ts |
| L1 | `mismatches` max 0: light bytes of interior columns vs the global reference BFS, sky and block (block is 0 everywhere until emitters exist; the block BFS is unit-tested, §9.7) | gated, every tier | light.metric.ts |
| L2 | `enclosedLit` max 0: air not sky-connected, ≥ 16 below `WORLD_SURFACE`, with sky > 0 | gated, every tier | light.metric.ts |
| DT1 | `lightMismatches` max 0 (`outName: 'DT1.light'`): the upTo 'L' region hash (blocks, fluid, light, aux) equal over 1 vs 4 threads and spiral vs shuffled | gated, every tier | light.metric.ts |
| S1 | `grassSky0` max 0.001: grass_block tops with sky 0 above | recorded (activeFrom SP6, which gates it, master §10 SP6) | light.metric.ts |
| P1 | bench rows `light.column`, `mesh.section` with absolute gates (§9.3) | gated by `npm run bench` | noise.bench.ts |
| G1 | `mediumStaticP95` max 16.7, `mediumStaticDrawCalls` max 100, `mediumStaticMainP95` max 6, from the committed Iris Xe Chrome flight | gated (D24), lands with the artifact | g1.metric.ts |
| R7 | — | SP4b (D26) | — |

Regions: fast tier one 6 × 6-column region (interior 4 × 4) of seed 42 at the spawn; quick tier two seeds × 10 × 10 plus a 10 × 10 region at amplified's and floating_islands' golden windows (peaks, overhangs, the island shadow); full tier eight seeds. L2 is trivially small before caves (SP6 re-asserts it with caves, master §10 SP6).

### 9.2 Harness (`test/harness/`, D27)

- `genRegion({…, upTo: 'T' | 'D' | 'L' | 'MESH'})` runs the real stage functions with the coordinator's prerequisite rules: T over the region plus 3 columns, D over plus 2, L over plus 1, mesh over the region; `regionWorker.ts` gains `decorate`, `light` and `meshColumn` messages (its test-only protocol); the 4-thread mode runs them on one shared store.
- `RegionView` gains `light(x, y, z)` and the mesh payloads per column.
- `cache.ts`: `RegionUpTo` widened; `REGION_CACHE_FORMAT` 3 (a dump holds the final light entries and the whole aux A); upTo 'MESH' reads the 'L' dump and meshes in process (not dumped); `SRC_KEY_SCOPE` gains `src/light/`, `src/mesh/`.
- `refs.ts`: the global reference light BFS (fall from y 319 per position by §4.1's N, then a plain FIFO BFS, without heightmaps or padding, over the whole region) and the brute-force visible-face count (every voxel face by §5.2's rules).

### 9.3 Bench (`test/bench/`)

- `light.column`: §4.2's job (copy, BFS, output arrays) on 256 interior columns of an 18 × 18 region of `terrain.real`'s candidates generated to D outside the timing, each timed once; gates p50 ≤ 4 ms, p99 ≤ 8 ms (p99 as the upper bound of p95, the column rows' precedent, `test/bench/gates.ts:96-98`).
- `mesh.section`: §5's padded copy and mesh on 1024 non-trivial sections of that region lit to L, each timed once; gates p50 ≤ 1.0 ms, p99 ≤ 2.5 ms.
- `BENCH_ROWS` appends both (`gates.ts:53-59`; `benchGates.test.ts` pins them); `npm run bench:record` on the reference machine re-baselines every row; master §7 gains a "Measured in SP4a" line with the values. A miss of an absolute gate comes back to the user with the numbers.

### 9.4 Goldens (D25)

None added; `GENERATOR_VERSION` stays 5 and the 59 keys byte-identical (`git diff main -- test/goldens.json` empty); `?selftest=1` and Bun are rerun at the exit unchanged (D20 evidence).

### 9.5 The flight route and G1's static cells (`?flight=sp4a`, D24)

- **Route:** seed 42, default profile, RD12, the default pool (and once with `?workers=4`); after the reveal, 120 idle frames measure the display interval (median rAF delta), then a 60 s Catmull-Rom flight through eight waypoints inside (RD − 4)·16 blocks of the spawn at 20-80 blocks above `MOTION_BLOCKING` (one leg low over water when the disc has any), the day running from 06:00 through one full cycle in 60 s. The section renderer is the one the probe selects: RegionBatch in Chrome, RegionMesh in Firefox (§6.2).
- **Frame time** is the rAF delta snapped to the nearest multiple of the display interval when within ±1 ms of it, so an on-time frame reads exactly one interval. Frame times and main-thread ms are CPU-side and exist in every browser; GPU ms exist only with the timer query, which Firefox lacks (§1.5), so a Firefox file has no GPU figures and says so (`gpuMs: null`), and nothing gated reads GPU ms.
- **JSON:** route, seed, profile, RD, workers, section renderer, user agent, renderer and vendor as reported (masked on Firefox), `multiDraw`, `timerQuery`, screen size and dpr, display interval; load (reveal ms, per-stage ms, RegionMesh merge ms where used, long tasks count and max, the first 120 frames' max); frames (count, p50, p95, p99, max, count over 33 ms); main-thread ms (p50, p95, max); GPU ms or null; draw calls (max, mean); triangles (max); JS heap (where exposed) and SAB MB. A page cannot write files: when the route ends the page sets `window.__wiFlight.result` and shows a "Download JSON" button.
- **Who runs which cell, and how its JSON reaches `docs/superpowers/specs/assets/sp4a/`** (the same for the spike's cells, §1.2):
  - **Chrome, Iris Xe and RTX 3060 Mobile (and the 4-worker run on the Iris Xe): an agent**, on the user's laptop, with `test/tools/measureChrome.ts` (`npm run measure:chrome -- --route flight|spike [--gpu iris|rtx] [--workers 4]`). The tool builds, starts its own `vite preview` on a free port (never 5183), and launches its own Chrome with a fresh temporary profile, headful (headless rAF is not tied to the display) at 1920 × 1080 on the hardware GPU (no SwiftShader flags), under `prime-run` for the RTX; it refuses when the reported renderer does not name the expected GPU (Iris, or RTX/NVIDIA), waits for the result, reads it over CDP (`Runtime.evaluate` of `window.__wiFlight.result` or `__wiSpike.result`) and writes `flight-<gpu>-chrome.json` (`flight-iris-chrome-w4.json` for the 4-worker run) or `spike-chrome-<gpu>.json`. The machine is kept quiet: the agent runs nothing else heavy alongside (no build, test or metric run), records the 1-minute load average in the JSON, and reruns a cell measured under load. The tool stops only the server and the Chrome it started; it never opens, closes or touches the user's own browsers or any other process.
  - **Firefox, Iris Xe and RTX 3060 Mobile: the user**, by hand, in the user's Firefox (under `prime-run` for the RTX), on the production deploy or a preview the controller names; the "Download JSON" button saves the file, the user sends it, and the controller commits it as `flight-<gpu>-firefox.json` or `spike-firefox-<gpu>.json`, the GPU named by the user's run (Firefox's masked renderer string cannot name it), as with the Firefox selftest.
- **G1 static** (`test/metrics/g1.metric.ts`, fast tier, milliseconds): reads `flight-iris-chrome.json`, checks its shape, that the renderer names Iris, the section renderer is RegionBatch, RD 12 and the default profile, and asserts the three parts of §9.1. The RTX and Firefox files are recorded in its output when present. SP4b's `?bench` and its streaming parts extend this (§13.1).
- **The Firefox cells (RegionMesh)** are checked at the exit, not gated by a threshold row: an acceptable frame time is p95 ≤ 25 ms (the threshold of §8.5's run-time notice, so the default RD does not trip its own notice) with ≤ 100 draw calls at RD12; no regression is the parity check (§9.6: RegionMesh draws what RegionBatch draws) and the Firefox selftest unchanged. A cell outside that comes back to the user with the numbers, after the tuning below.
- **Flight evidence** (the Chrome cells, measured 2026-10-22 by `measureChrome` under the PRIME on-demand profile, with the user's session unlocked and the display awake, in a fullscreen window on the laptop panel **eDP-1 at 240 Hz**, the display's native rate as the user chose on 2026-10-21; frame times snap to the measured interval, 4.165 ms, so 16.7 ms is four intervals, the 60 Hz budget the gate encodes). The Iris Xe renders through ANGLE's default OpenGL backend, the RTX 3060 Mobile through **ANGLE Vulkan** under PRIME offload (`__NV_PRIME_RENDER_OFFLOAD=1`, `__GLX_VENDOR_LIBRARY_NAME=nvidia`, `__VK_LAYER_NV_optimus=NVIDIA_only`, `--use-angle=vulkan`), since ANGLE's GL backend fails `eglInitialize` there; the GPUs differ in backend as well as hardware. Each flight: seed 42 at its spawn (0, 0), the default profile, RD 12, RegionBatch, the stored settings not read (no FPS cap, FOV 70); the eight waypoints are 40-80 blocks above `MOTION_BLOCKING` (the water search, a 4-block grid within 109 blocks of the spawn, finds no water, so no low leg); the camera faces along the tangent with its pitch damped to [−20°, 0°] (`cameraPitch`: a camera looking along a climb sees only sky); no console error, no frame over 33 ms in any cell.

  | | Iris Xe (`flight-iris-chrome.json`), **G1's cell** | Iris Xe, 4 workers (`flight-iris-chrome-w4.json`) | RTX 3060 Mobile (`flight-rtx-chrome.json`) |
  |---|---|---|---|
  | renderer (as reported) | ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL 4.6) | the same | ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520)), NVIDIA) |
  | workers | 6 | 4 | 6 |
  | frames (count, p50 / p95 / p99 / max) | 14,394; 4.165 / **4.165** / 4.165 / 8.33 ms | 14,391; 4.165 / 4.165 / 4.165 / 8.33 ms | 14,403; 4.165 / 4.165 / 4.165 / 4.165 ms |
  | main thread p50 / p95 / max | 0.46 / **0.93** / 3.40 ms | 0.46 / 0.93 / 2.01 ms | 0.21 / 0.45 / 1.63 ms |
  | GPU ms p50 / p95 (timer query) | 0.77 / 1.81 | 0.76 / 1.96 | 0.18 / 0.37 |
  | draw calls max / mean | **11** / 7.5 | 11 / 7.5 | 11 / 7.5 |
  | triangles max | 203,201 | 203,201 | 203,201 |
  | load: reveal; long tasks | 3.45 s; 1 (61 ms) | 3.39 s; 0 | 3.00 s; 2 (max 159 ms) |
  | JS heap / SAB | 18.5 / 40.5 MB | 22.3 / 40.5 MB | 19.3 / 40.5 MB |
  | load average before / after | 0.11 / 0.62 | 0.38 / 0.90 | 0.32 / 1.18 |

  **G1's static cells pass on the Iris Xe** without tuning: p95 4.165 ms ≤ 16.7, 11 draw calls ≤ 100, main thread p95 0.93 ms ≤ 6. The Firefox cells (RegionMesh) are the user's (Task 33).
- **A G1 miss on the finished page** (controller's call, builder check Q4): the builder may tune within this spec and re-measure with the same tool: the device pixel ratio cap (`pixelRatioCap`, below 1), the upload budget, pass and draw-call batching (region size, merged passes), the fog distance (fog end and band at RD12). If G1's static cells still miss after tuning, the builder stops for the user with the measurements (each tuning step's JSON committed); no gate is loosened silently, and a changed threshold is the user's decision, with its Threshold-log line.

### 9.6 Browser smoke and review assets

- `uiSmoke.ts` gains three steps, with SwiftShader flags for its Chrome:
  - `start`: bare `/`; the start screen shows seed 42 and the default profile, both buttons, no console error, `start.png`; then `/#<a hash with another seed>` names that seed; then "Enter the world" on a bare `/` brings up the loading screen in the same page (the URL unchanged; the step stops there, without waiting for the default RD's load);
  - `world`: `/?rd=4` (no start screen), wait for the reveal, no console error, `world.png`;
  - `world-mesh` (the parity check): `/?rd=4&renderer=mesh` and `/?rd=4&renderer=batch` at the same `?at`, `y`, `yaw`, `pitch` (time fixed at the opening 08:00, HUD hidden), each read back after the reveal; the two images may differ in at most 1 % of pixels by more than 2/255 per channel (translucent order inside a region, §6.2), and `world-mesh.png` is saved.
- `docs/superpowers/specs/assets/sp4a/`: the spike and flight JSON (§1.2, §9.5: Chrome through `measureChrome.ts`, Firefox through the user's download); screenshots at the spawn by day, at sunset and at night, over an ocean, of amplified's peaks and of floating_islands' shadow; the start screen; the loading screen with a panorama and with the neutral background.

### 9.7 Unit and integration tests (summary)

- **Packing:** round-trip of every field at its limits, both variants; the generated `#define`s and unpack expressions equal `PACK_LAYOUT` (string checks, no GPU).
- **Mesher:** face rules on canned neighbourhoods (opaque, water, injected cutout and partial-face tables); AO table and diagonal flip on canned 3 × 3 × 3; smooth-light samples, corner skip and rounding; greedy counts on canned slabs; seams: a section at a column border with real neighbour data; below the world opaque, above it sky 15; trivial-section skip; connectivity on canned sections (tunnel, sealed, all air).
- **Still water:** surface faces at drop 1, sides against air only, none against water or stone, `depth` from the floor, the translucent pass.
- **Light:** the fall and `LIGHT_BLOCKING` with water; the step: sky 14, 13, 12 at 1-3 blocks under open still water (master §6.3's "> 0"); `FULL_FACES` crossing with an injected slab table; block BFS from injected emitters and the lava rule; equal to the reference on small synthetic 3 × 3 columns; uniform outputs.
- **Lightmap and phase:** (0, 0) ≤ 0.02 luminance at every time and brightness; block light independent of time; phases match the sign of elevation; the dawn window.
- **FPS limiter:** ≥ 59.5 fps at cap 60 on simulated 60 Hz timestamps; 30 at cap 30; off renders every frame; jitter.
- **Rendering setup (three in Node, no `WebGLRenderer`):** output sRGB, albedo array sRGB, lightmap `NoColorSpace`; the colour-space chunk and `length(viewPos)` in the shaders; RegionBatch attributes (Uint8 × 4 position, Uint32 data), spheres set before `addGeometry`, instance matrices relative to the origin; RegionMesh (D2): the merged buffers equal the concatenated sections (Uint16 region-local positions at the corners of every section of a region, `data` unchanged, indices rebased, exact sizes), the region sphere contains every section sphere, one mesh per region and pass, region matrices relative to the origin, the `REGION_MESH` shader variant without the batching chunks; the `SectionRenderer` contract suite run on both implementations (staging, hidden until one reveal, origin rebase, counts); `selectSectionRenderer` on `multiDraw` true and false and the `?renderer` override; water meshed in pass 2 with `effOpacity` 1, `COLLIDE` none (air) and counted by `MOTION_BLOCKING`.
- **Engine:** rings and RD12's counts; the coordinator's order, prerequisites, caps, intake drops, progress, the single-frame reveal (no frame shows a column partly, the R7 rule SP4b measures); floating origin; `defaultRenderDistance`; the 3D page's capability rules.
- **Store:** `reopenColumn` (status check, aux reuse), `setLight` and the light-once refusal, per-channel versions, attach asserts.
- **D:** final heightmaps on canned columns; shared slots (refcount 2).
- **Player and UI:** key map invariants; fly controller (same distance at 30 and 144 fps, sprint, speed steps and clamps, keys cleared on blur, ignored in inputs, the edge clamp); `?at` parsing and clamps; `startModeOf` (a bare `/` and a hash alone show the start screen; any of `?at`, `?rd`, `?workers` skips it; `?renderer` alone does not), the start screen's seed and profile from the hash or the defaults, its decode-error state and its two actions (enter starts the load in the same page, the map link carries the hash); tips and help from the key map; loading progress, watchdog and panorama fallback; the panorama tool's and `measureChrome.ts`'s pure parts (arguments, file names, the expected-GPU check on renderer strings); `flatColors` and the Voxels palette's distances.
- **Protocol:** guards for every new message and reply.
- **Integration:** the four jobs through a real Node worker on a shared store (the existing integration pattern).

## 10. CI wall-time impact

- **`check`** (the critical path, 170 s at the reference run of 2026-10-20, 3 min 12 s wall): the unit tests above are small (canned neighbourhoods, a few 3 × 3-column fixtures, three geometry without a context, the `SectionRenderer` contract suite run twice): about +25-40 s; the integration test +5-10 s. Expected `check` ≈ 200-220 s.
- **`metrics-fast`** (parallel): the fast tiers of `render.metric.ts`, `light.metric.ts` and `g1.metric.ts`, about +10-20 s, still shorter than `check`.
- **`metrics-quick`:** the two new files in a new shard `render` (D28, `.github/scripts/metricShards.mjs` `SHARDS`), about 60-100 s with a cold region cache, below `check`.
- **Expected wall time** about 3 min 40 s - 4 min, within the brief's "under a minute" of growth. The docs-only path is unchanged; the panoramas live in `public/`, outside `src/**`, so regenerating them leaves the region caches warm. Nothing GPU-based runs in CI; the bench, the flight, the panoramas and uiSmoke stay local.
- The exit evidence records the CI run's wall time and each job's slowest files (the job summaries). If `check` passes 4 min, the backlog's "shard the unit project" (`docs/backlog.md`) is the lever, decided with the user.

## 11. Exit criteria

| criterion | checked by |
|---|---|
| the spike's four cells recorded (Chrome/Iris Xe passed before the plan went on; Chrome/RTX by an agent, both Chrome files written by `measureChrome.ts` over CDP; both Firefox cells by the user, on RegionMesh, through the page's download and committed by the controller), with the spike evidence and the user's capability check written into this spec | `assets/sp4a/spike-*.json`, §1.5 |
| RegionMesh built (D2): selected when `multiDraw` is false, its unit tests and the shared contract suite green, the parity check passed | `npm test`, `node test/tools/uiSmoke.ts --shots` (`world-mesh`) |
| build, tests and full metrics green with SP4a's rows active (R1, R2, L1, L2, DT1's light part) and R4, R5, S1's `grassSky0` recorded; every earlier metric unchanged | `npm run build && npm test && npm run test:metrics:full` |
| G1's static cells on the committed Iris Xe Chrome flight on RegionBatch (p95 ≤ 16.7 ms, ≤ 100 draw calls, main thread ≤ 6 ms p95), run by an agent through `measureChrome.ts`, tuned within §9.5 if needed, else back to the user; the Chrome RTX flight and the 4-worker run recorded (agent); the two Firefox flights recorded (the user's downloads) and within §9.5's Firefox check on RegionMesh (p95 ≤ 25 ms, ≤ 100 draw calls) | `g1.metric.ts`, `assets/sp4a/flight-*.json` |
| the first load recorded: reveal time at RD12 with 6 and 4 workers, long tasks while loading, the first frames' max | the flight JSON |
| bench: `light.column` p50 ≤ 4 ms, p99 ≤ 8 ms; `mesh.section` p50 ≤ 1.0 ms, p99 ≤ 2.5 ms; every earlier row within +30 %; re-baselined | `npm run bench`, `npm run bench:record`, `npm run bench` |
| the world unchanged: `GENERATOR_VERSION` 5, `test/goldens.json` untouched, `?selftest=1` 59/59 in Chrome and Firefox, Bun 59/59 | `git diff main -- test/goldens.json`, browsers, `npx --yes bun@1 test/tools/goldensJsc.ts` |
| CI green, its wall time recorded against §10's estimate | GitHub Actions |
| browser smoke with the `start`, `world` and `world-mesh` steps; the panoramas committed (six, each ≤ 400 KB; unless the cut line moved them) and the loading screen shown with one and without | `node test/tools/uiSmoke.ts --shots`, `npm run assets:panoramas` |
| production: the deployed build opens the start screen and, on "Enter the world", the 3D world in Chrome (RegionBatch) and Firefox (RegionMesh); the Firefox selftest 59/59 on it | screenshots, `assets/sp4a/selftest-firefox.json` |
| the user's check: a full day/night cycle flown on the Iris Xe and on the RTX 3060 Mobile (T speeds the day), on the default world and on floating_islands (the island shadow), and the review screenshots | the user's evaluation (the last criterion) |

The exit evidence goes under `## Exit evidence`, before the Threshold log. The exit commit adds the Safari line to `docs/backlog.md` and says in `CLAUDE.md:9` and `README.md:9` that SP4a is implemented and awaits CI, the production check and the user's check; the commit after them sets SP4a complete.

**Cut line.** The panorama tool and assets → SP4b; the loading screen then ships with its neutral background, tips and progress (§8.3). The RegionMesh fallback is no longer cuttable: D2's rule required it (the user's capability check, §1.5), since without it Firefox, one of the user's two browsers, would fall to the per-instance path. Nothing else is cuttable: the spike, the shared store, D, light, meshing, both section renderers, materials, sky and day/night, the controller, the key map, the start screen, the loading screen and the static G1 cells are the deliverable.

## 12. Governance

- **First commit** (with this spec's master amendments of the split, §14): `SubProjectId` and `SUB_PROJECTS` replace 'SP4' with 'SP4a', 'SP4b' (`src/core/ids.ts:6-14`, with the doc comment's split history); `SP_DEPS` gains `SP4a: ['SP3b']`, `SP4b: ['SP4a']`, `SP5: ['SP4b']`, `SP8a: ['SP4a']` (`test/harness/sp.ts:5-26`); `STARTED_SPS` appends 'SP4a' (`:33`); `CURRENT_SP` becomes 'SP4a' (`ids.ts:21`; `currentSpOf` gives it). Pins that move: `test/arch/sp.test.ts:18-22` (the started list and the current SP), `:24-32` (the `currentSpOf` cases written with 'SP4'), `:34-38` (`SP_ORDER` and the title's "all 20 sub-projects", now 21), `:58`, `:63`, `:69-79` (paths with 'SP4'); `test/unit/profiles.test.ts:25-26`; `test/arch/masterSpec.test.ts:319`, `:499`, `:518` (`spEntry('SP3e', 'SP4')` → 'SP4a'); `test/unit/lock.test.ts:75` (its example id). `npm run test:accept-thresholds` (the lock's `startedSps`) and a Threshold-log line. `CLAUDE.md:9` and `README.md:9`: SP4a in progress (the world in 3D, loaded once), SP4b next.
- **Order the gates constrain:** the spike first, with `measureChrome.ts` (§1; the plan continues once the Chrome/Iris Xe cell passes, and stops for the user on a fail of §1.3 there); then the store changes and the protocol; D, light and meshing with their unit tests; the harness widening; the metric rows with their files (`render.metric.ts`, `light.metric.ts`: each row's commit adds the rows and their metric file together, since appending 'SP4a' already activates any `activeFrom: 'SP4a'` part, `test/harness/metric.ts:164-166`); the renderer with RegionBatch, then RegionMesh behind the same `SectionRenderer` contract suite, materials, sky, player, the start screen and the page; the bench rows; the panoramas; the flight artifacts and `g1.metric.ts` with G1's rows in one commit (the rows cannot activate before the artifact exists).
- **Cells that wait on others:** the Chrome/RTX spike cell is run by an agent once the spike is in; the Firefox spike and flight cells are the user's, asked for once RegionMesh and the flight route are deployed (a preview or production), and committed by the controller when the user sends them. The plan does not wait on them task by task, but the exit does (§11); a Firefox or RTX cell outside its criterion comes back to the user.
- **Thresholds lock:** changes in the first commit (`startedSps`), in the commits that add R1/R2/R4/R5, L1/L2/DT1/S1 and G1's rows; each adds one Threshold-log line naming what it adds and touches this spec in the same push (`test/harness/governance.ts:54-56`). New parts are tightenings.
- **Master amendments** land with what they describe: the split's (§2.5's `SubProjectId`, §10's entries, headers, critical path and parallelism line) in the first commit, since `masterSpec.test.ts` checks them against `SUB_PROJECTS` and `SP_DEPS`; §2.5's `setLight` with `api.ts`'s; §1's file names and the `SP4a:` test list with the files; §6.4's rows with their thresholds; §7's "Measured in SP4a" line with the bench rows; the cut-line wording at the exit.
- **No other lock changes:** the schema-shape lock (no leaf: the graphics settings are not params), the state-id lock (no block types) and the goldens stay.
- **Docs:** `CLAUDE.md` gains the 3D page's routes (the start screen and what skips it, `?renderer`), `npm run assets:panoramas`, `npm run measure:chrome` (who runs which cell, §9.5), the bench rows' gates and the `render` shard, each with what it describes; `README.md` an SP4a paragraph at the exit.

## 13. Notes handed to later SPs

### 13.1 SP4b — Streaming and life

- **Coordinator:** re-centring on column crossings, the heap rebuild on a crossing or a turn > 30° with the view term, cancellation of queued jobs leaving the needed set (a keyed cancel in the pool, `map-code.md` R13), unload hysteresis (voxels beyond RD+5, meshes beyond RD+1), proto retention in RD+2..RD+3 with `freeProto` and `T(protoOnly)`, the adaptive throttle, the upload budget (2 ms and 32 sections per frame at Medium), per-column atomic reveal staged hidden and R7; live RD changes; dropping SP4a's edge fade, edge clamp and R reload (§6.6, §7.5).
- **Store concurrency** (§2.6): the claim generation in record int 12, monotone versions, the protoFlags alive bit, the post-commit reclamation protocol (seqlock or per-epoch limbo list) written into its spec before the sim worker (SP5) writes Published columns, the lock owner id, the column-table race fuzz; the per-scope epoch cells wired in place of the 4-byte abort cell (`protocol.ts:154`'s guard widened).
- **M overlay and teleport:** the map-page refactor (`mountMapPage` taking a host, a session, a pool and a click hook, `map-code.md` §10), `mapClickAction` gaining a teleport action, one pool shared by map tiles and world jobs (one epoch), the ≤ 1 MAP job cap with SP2b's climate-grid cache as the lever; teleport lands at `surfaceEst3 + 2` under a non-default tree (SP3e :684; master §3.7 says `surfaceEst + 2`) and snaps to `MOTION_BLOCKING` once published.
- **Apply v1 live:** the session's gestures and urgent commits (`engine/session.ts`), latest wins, dirty stages from the workers' `stageHashes`, old meshes kept and swapped atomically, the near area first.
- **Measurements:** the `?bench` route with streaming, the 4-worker cap and its CDP driver; G1 at RD12 while streaming (re-asserting SP4a's three static cells, plus no frame > 33 ms while streaming, RD12 fill ≤ 6 s with 4 workers, first playable RD4 ≤ 1 s, GPU ≤ 150 MB); the first-load and stutter cells. **To decide:** master G1's "first playable (RD4 meshed) ≤ 1 s" against the brief's "the world is not shown until the area around the camera is ready" (SP4a reveals the whole RD at once; SP4b chooses the first reveal's radius with the user).
- The spike's churn and `optimize` numbers (§1.2 item 4) for the reservation policy (D13); RegionMesh's streaming half (master §4.5's sub-allocated ranges, `addUpdateRange`, per-region rebuilds on churn), on the `SectionRenderer` contract suite SP4a leaves for both implementations, and the Firefox cells re-measured on it while streaming.
- The start screen stays as SP4a leaves it (D21); its replacement by the full start and worlds menu is SP5's (§13.2).

### 13.2 SP5

The sim worker writes Published columns only after SP4b's reclamation protocol; incremental relight reuses §4.1's rule and `effOpacity`; `setLight`'s light-once refusal is replaced by that protocol. The hotbar takes the plain wheel: SP5 picks the speed's wheel modifier (§7.2; Alt+wheel has Firefox and window-manager defaults); its settings panel replaces the help's settings block and adds key remapping over `DEFAULT_KEYMAP`; walk mode (F) uses `MOTION_BLOCKING` from D. **The full start and worlds menu** (D21; the user, 2026-10-20: "both can coexist at the root; we'll study it in detail later"): SP5's worlds menu (create, load, rename, duplicate, delete over IndexedDB `worlds`, master §2.7) grows out of SP4a's minimal start screen at `/`, designed in detail with the user in SP5's spec, including how the start screen's seed and profile (today from the `#` hash) meet the saved worlds, and whether `?at`, `?rd` and `?workers` still skip it.

### 13.3 SP6

`connectivity15` arrives with every column's mesh payload; the meta bits 17-31 are still 0, and SP6 decides whether cave culling reads them from the store (D10). S1's `grassSky0` is recorded from SP4a (its value on floating_islands includes the grass under islands, SP3e D21 (b)); SP6 gates it. L2 re-asserted with caves.

### 13.4 SP7

The fluid packing (`depth`, `cornerDrop` in ninths) and the still-water mesher are the base of the flowing mesher; R5 is recorded from SP4a; water's light step is `max(1, effOpacity)`; underwater fog has no SP4a code.

### 13.5 SP8a

Layer = state id in SP4a: `FACE_TEX` replaces it, the painted array replaces the 1 × 1 flat-colour array, the tint texture and colormaps feed the packed `tint` field (ignored until then) and Fast water's biome tint; D leaves `tintTH` 0 for SP8a to pin and write; the cutout pass and material exist, empty; `textures/flatColors.ts` stays available as an average colour (SP11's LOD).

### 13.6 SP8c, SP10, SP11

- SP8c: `SectionMesh.emitters` is absent in SP4a's payload; `graphicsPresets.ts` exists with the Medium row (D17).
- SP10: F3's counts grow into the full overlay.
- SP11: presets Low…Ultra on `graphicsPresets.ts`; RD up to 24 (SP4a caps at 16); the LOD fill mask flips at SP4b's per-column reveal; moon, stars, clouds after the sky dome; the fog band and the island shadow's look (D9) as Live settings.

## 14. Master-spec amendments made with this spec

Applied when the user approves this spec, each in the commit §12 assigns (the split's in the first commit).
- **§2.5:** `SubProjectId` lists `'SP4a'|'SP4b'` in place of `'SP4'`. `ColumnWriter` gains `setLight(sy:number, light:Uint8Array): void /* light only; refused over a dense light entry until SP4b's reclamation (SP4a) */` and `commit`'s comment becomes "blockVersion += 1 when blocks or fluid were written, lightVersion += 1 when light was, then status last" (the masterSpec test requires §2.5 to name every `api.ts` method). `SectionMesh` gains `connectivity:number /* connectivity15, the same on each pass of a section (SP4a) */`. `ColumnView` gains `sectionLight(sy:number): Uint8Array|number /* the final light entry; 0 on a proto view (SP4a: padded.ts copies through it) */` (§4.3).
- **§10:** the SP4 entry is replaced by:
  - a split paragraph: "SP4 was split on 2026-10-20 into SP4a (the world in 3D, loaded once) and SP4b (streaming and life), at the user's request, so the user sees the world in 3D early (the SP4a spec's Decisions confirmed by the user, item 2)."
  - `**SP4a — The world in 3D, loaded once** (L; SP3b). Spec: ` followed by this spec's backticked file name: the week-1 spike (RegionBatch, the shared store in the browser); RegionMesh as the second `SectionRenderer`, selected without `WEBGL_multi_draw` (Firefox); the one-shot load around the spawn or a chosen point (rings, the coordinator's core, T/D/L/MESH_COLUMN jobs on the shared store); the D skeleton with the final heightmaps; the exact light job (FULL_FACES-aware, water stopping the sky fall and dimming by 1 per block); the padded greedy mesher with `PACK_LAYOUT`, AO, smooth light and connectivity; the still-water mesher; materials v1 with Fast water, the flat-colour array, sky dome with sun, elevation-based day/night, fog; the spectator controller, floating origin, FPS limiter, HUD counts, `ui/help.ts` with the key map as data; a minimal start screen at `/` (the full start and worlds menu is SP5's); the loading screen with panoramas, tips and progress; the flight route. **Deliverable:** fly through the RD12 world around the spawn with day/night and translucent oceans, after a start screen and a loading screen, in Chrome and Firefox. **Exit:** as the SP4a spec §11. **Cut line:** the panoramas (→ SP4b); the RegionMesh fallback was required by the capability probe (Firefox lacks `WEBGL_multi_draw`), so it is not cuttable.
  - `**SP4b — Streaming and life** (L; SP4a)`: the store's concurrency fixes (SP3a §10, as the SP4a spec §2.6 hands them over) and the per-scope epoch cells; the streaming coordinator (statuses, rings, heap, epochs, versions, meshSeq, cancellation, unload hysteresis, proto retention, adaptive throttle, upload budget, atomic column reveal); RegionMesh's streaming half (sub-allocated ranges, `addUpdateRange`); the M map overlay with teleport (the map-page refactor); Apply v1 live; the `?bench` route with renderer-string capture and the optional 4-worker cap. **Deliverable:** fly anywhere without stutter while the world streams, and edit it live from the map. **Exit:** R7; G1 at RD12 while streaming as the SP4b spec sets it (at least the SP4a static cells re-asserted and the master's streaming cells); scheduler unit tests (cancel on leaving range, `update()` allocates 0 without movement, old meshes kept on Apply, the throttle). **Cut line:** set by the SP4b spec.
  - SP5's header becomes `(M; SP4b)`, and its persistence bullet gains "the full start and worlds menu at `/`, grown from SP4a's minimal start screen and designed with the user in SP5's spec (SP4a spec D21)"; SP8a's "(L; SP4 for textures and shape meshing, …)" becomes "SP4a", and "the pass exists since SP4" "since SP4a"; SP6's exit "once SP4's light exists" "once SP4a's light exists".
  - The critical path: `… → SP3b → SP4a → SP4b → SP5 → …`; the parallelism line: "SP8a's texture parts after SP4a (alongside SP4b-SP7; …)", "SP3c, SP3d and SP3e alongside SP4 (done before SP4a started)", "the cloud parts of SP11 after SP4a and its LOD parts after SP4b (the fill mask flips at SP4b's per-column reveal)"; the "Visible value" line: "flight in SP4a, streaming and live editing from the map in SP4b"; "BatchedMesh in SP4 week 1" → "SP4a week 1".
  - The SP3 split paragraphs' "SP4" read "SP4 (now SP4a and SP4b; SP4a depends on SP3b)".
  - **Cut-line receivers:** "SP0 Vercel preview check → SP4a (not needed: the production deploy was verified, so nothing moved)", and SP0's own cut line "(→ SP4)" reads "(→ SP4a)"; added "SP4a loading-screen panoramas → SP4b", worded at the exit by whether they were built (the RegionMesh fallback is not a receiver: SP4a builds it).
  - SP10 gains "teleport snap on the map (on SP4b's teleport)"; SP11 gains "(the LOD fill mask flips at SP4b's per-column reveal; RD up to 24, SP4a caps 16)".
- **§1:** the new files of the module layout (`world/store/padded.ts` "arrives in SP4a"; `gen/pipeline/finalHeightmaps.ts`; `mesh/column.ts`; `textures/flatColors.ts`; `engine/renderDistance.ts`; `render/fpsLimiter.ts`, `render/spike/`; `player/keymap.ts`, `input.ts`; `ui/world/*`, `ui/loading/*`; `workers/worldJobs.ts`; `public/panoramas/`; `core/params/graphicsPresets.ts` "created by SP4a with the Medium fields it uses; SP8c adds the audio rows, SP11 the other rows"); "the standalone ?map page (mounted in-game from SP4b)"; the `test/` entry gains "(SP4a: metrics/render.metric.ts, metrics/light.metric.ts, metrics/g1.metric.ts, tools/cdp.ts, tools/panoramas.ts, tools/measureChrome.ts)" in its own parentheses, with a pinning test landing with the last of them.
- **§2.2:** after "`LIGHT_BLOCKING` is defined the same way": "A fluid voxel has effective opacity 1, so water stops the straight sky fall, and every BFS step entering a voxel costs `max(1, effective opacity)` (SP4a spec §4.1)".
- **§2.3:** meta bits 17-31: "(0; SP4a computes connectivity15 in the mesh job and carries it in the mesh result; SP6 decides whether the meta holds it)"; "The connectivity bits and `padded.ts` are SP4a's"; `LIGHT_BLOCKING` "follows the §2.2 light rule (SP4a spec §4.1: 1 + the highest voxel the fall does not enter)"; the epoch cell "SP4b wires them"; versions "Atomics.add on every committed change of that channel (SP4a)".
- **§3.0 and §3.12:** the D stage "(SP4a: the skeleton shares the proto into the final set and writes the four final heightmaps; `tintTH` waits for SP8a)".
- **§3.7:** "teleport: SP4b; SP4a places the camera from the loaded `MOTION_BLOCKING`"; "SP4-SP9" → "SP4b-SP9".
- **§4.3:** "SP4 widens it to per-scope cells" → "SP4b"; the needed sets: mesh is the integer disc, and L, D and T are each the previous set grown by the 3 × 3, so every job's prerequisites lie in the previous stage's set (SP4a spec §2.1).
- **§4.4:** the `data` field order and offsets of the SP4a spec §5.5, `cornerDrop` in ninths of a block, the smooth light's rounding (§5.3) and the trivial-section rule (§5.1); the greedy ratios "about 0.56 / 0.28" become 09's flat-terrain figures beside SP3b's measured 0.70-0.79 / 0.44-0.50 (Task 18, the user's decision of 2026-10-22).
- **§4.5:** "the SP4 spike" → "the SP4a spike" (twice); "Vertex and index capacity are reserved per preset" gains "(SP4b; SP4a sizes each region exactly at load)"; the Fallback paragraph gains "(built in SP4a: Firefox exposes `WEBGL_multi_draw` on no GPU, the user's capability check of 2026-10-20; SP4a writes each region's merged buffers once with Uint16 region-local positions, and the sub-allocated ranges and `addUpdateRange` serve SP4b's streaming)".
- **§4.6:** fog values "(SP4a: end (RD − 0.5)·16, start 64 blocks before; an edge fade around the load centre until SP4b streams)".
- **§4.8:** step 3 "stepping −1 plus the opacity of filtering blocks" → "stepping −max(1, effective opacity)".
- **§4.9:** "Phases … The default cycle is 20 min" gains "(SP4a: the sun on a path tilted 20°, t 0 at sunrise, the world opening at 08:00; T cycles the time speed ×1, ×10, ×60, paused)".
- **§4.16:** `graphicsPresets.ts` created by SP4a (as §1).
- **§4.17:** "adjust with Alt+wheel" → "adjust with the wheel and `+`/`-` until SP5's hotbar takes the wheel, SP5 choosing its modifier (SP4a)"; "spectator: forward along the look vector".
- **§5.1:** "Until SP4" → "Until SP4b"; "SP4's Apply" → "SP4b's Apply".
- **§5.8:** "HUD counts: SP4a (F3 toggles them; SP10's overlay replaces them)"; the bench route "(SP4b; SP4a's `?flight=sp4a` measures the static world)".
- **§5.9:** gains "T (time speed, SP4a), R (load the world around you, SP4a until SP4b streams), `+`/`-` (fly speed)".
- **§6.1:** "no coordinator prerequisite rules until SP4" → "until SP4a"; the region cache: "plus `stageHash('mesh')` when upTo is 'MESH'" → "(SP4a: upTo 'MESH' meshes the cached 'L' region in process and is not cached; format 3 dumps the final light)".
- **§6.3:** the rendering-setup bullet's water clause becomes "water (a fluid byte on air) has effective opacity 1 and no collision, is meshed in the translucent pass, and sky light 3 blocks under open still water is 12"; the scheduler bullet gains "(SP4a: nearest-first, prerequisites, stale results; SP4b: cancel, zero allocation, Apply, throttle)".
- **§6.4:** R2 ≤ 0.85 / ≤ 0.55 (§9.1, the user's decision of 2026-10-22); R4 "measured in SP4a"; R5 "recorded from SP4a"; R7 "(SP4b)"; L1 "(sky from SP4a; block light from the first emitters, unit-tested before)"; DT1 gains "SP4a: the lit region hash over threads and orders (`DT1.light`)"; S1's "until SP4's light exists" reads "SP4a's" and the row gains "the grass at sky 0 part is recorded from SP4a and gated from SP6"; G1 gains "SP4a gates the Medium p95, draw-call and main-thread cells on the static world from the `?flight` artifact (frame times snapped to the display interval); SP4b gates them while streaming with the other cells".
- **§7:** "Measured in SP4a" with `light.column` and `mesh.section` (values from the bench); "R4 measures the quad assumption in SP4a"; the fill line gains "(exact sets: T 825 / D 705 / L 593 / mesh 489)".
- **§8:** risk 1 "SP3a-SP4" → "SP3a-SP4b"; risk 2 "an SP4 week-1 spike" → "an SP4a week-1 spike".

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)

- 2026-10-21 — SP4a Task 1: startedSps gains 'SP4a' (SP4 split into SP4a and SP4b, spec §12).
- 2026-10-21 — SP4a Task 18: R1 `hiddenEmitted` max 0 and `visibleMissing` max 0, and R2 `quadsPerFaceAo` max 0.85 and `quadsPerFaceNoAo` max 0.55, gated from SP4a on every tier; R2's parts are retuned (loosened from the master's 0.6 / 0.35) by the user's decision of 2026-10-22, on the exact-optimum study (a reference greedy and the exact minimum rectangle partition, independently verified: the mesher is within 0.7 % of the optimum for its keys, and SP3b's terrain measures 0.70-0.79 / 0.44-0.50; §9.1, master §4.4); R4 `medianQuads` max 2000 and `p95Quads` max 4000 (activeFrom SP8b) and R5 `waterQuadsPerFace` max 0.1 (activeFrom SP7) recorded, as planned.
- 2026-10-21 — SP4a Task 19: L1 `mismatches` max 0, L2 `enclosedLit` max 0 and DT1 `lightMismatches` max 0 (`DT1.light`), gated from SP4a on every tier; S1 `grassSky0` max 0.001 recorded (activeFrom SP6, D26); all new parts, as planned (§9.1, `light.metric.ts`).
- 2026-10-22 — SP4a Task 30: G1 `mediumStaticP95` max 16.7, `mediumStaticDrawCalls` max 100 and `mediumStaticMainP95` max 6, gated from SP4a on every tier from the committed Chrome flight on the Iris Xe (`flight-iris-chrome.json`, `g1.metric.ts`; §9.1, §9.5, D24); all new parts, as planned, no tuning needed (measured 4.165 ms / 11 / 0.93 ms on eDP-1 at 240 Hz).

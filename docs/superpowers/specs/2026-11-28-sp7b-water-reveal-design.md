# SP7b — The water is seen falling, and the surface is right (Design)

Date: 2026-11-28
Status: **Approved by the user 2026-11-28 ("Ok a todo. Vamos adelante con lo propuesto").** Size: **L** (about 34 plan tasks, realistic ceiling 40; Point 1), plus an optional stretch outside the 34 (D31, about 2-4 tasks, added after the approval at the user's request, without commitment). This spec turns what the user agreed in the SP7b brainstorm (`.superpowers/sp7b/design-brief.md`) into decisions, values and tests. Items the brief records as the user's words or the user's choices are treated as agreed. Every other decision was this spec's proposal (D1-D29, each with its alternative; D30 is the controller's call (ii)) and went to the user in eight questions: six Points (the size, D29; R5's bound, which the levers cannot bring to 0.1, D25; where the coast's fill goes, since it needs a generator change, D14; lava's light during its reveal, D6; whether "seen" survives a reload, D5; how far away a fall can start, D3), plus approach B as built (D20, D21) and the spills of standing water (D2). The user answered all eight with "Ok a todo. Vamos adelante con lo propuesto". So every recommendation is the user's decision, and so are the controller's two calls listed with them. "Points the user decided" records each answer and keeps the options not taken.
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10's SP7b entry (M:1989-1996), which this spec rewrites and splits into SP7b, SP7c and SP7d (the user: "Sí, de acuerdo con la división y el orden"), with its "Received from SP5c" and "Received from SP7a" lines (M:1992-1993); the split paragraphs (M:1923-1925); SP7a's "Received from SP6a" (M:1983); SP8a's and SP8b's headers (M:1998, M:2010); SP12's received lines (M:2069, M:2071); the Default receivers (M:1833); the critical path, parallelism and visible-value lines (M:2078-2082);
- D18 (M:40); §1's module layout (M:158); §2.3's column record and §2.5's `SubProjectId` (M:405); §3.14's contact wording (M:948); §4.4 (the fluid mesher); §4.8's incremental relight (M:1170); §4.11 (runtime fluids, M:1207-1227); §4.12 step 2 (M:1247); §4.16's sim-distance row (M:1291); the bench route (M:1445);
- §6.4: C7 (M:1550), A2 (M:1554), R5 (M:1578), F1-F3 (M:1583-1585); §8 risks 9, 10 and 15 (M:1786, M:1787, M:1792); the DoD (M:1826) and the size scale (M:1831).

Previous SP: `2026-11-17-sp7a-water-design.md` (complete, `GENERATOR_VERSION` 10, 68 goldens). **Received:** master §10's SP7b entry with its two "Received from" lines, SP7a's §17 notes (S7a:531) and the five items of SP7a's user check (S7a:1847-1867). The full list, with where each item lands, is `.superpowers/sp7b/recon-obligations.md` §1; §20 below is the table.

**Text this spec replaces** (each amendment is listed in §16 and pinned): master §10's SP7b entry (three entries: SP7b, SP7c, SP7d); D18's "Runtime fluids are **edit-triggered only**" (a sentence added for the reveal); §4.11's "always ≤ RD−2" (M:1223) and §4.8's "capped at ≤ RD−2" (M:1170) (≤ RD, a user setting; §4.16's row M:1291 is read as the presets' defaults); M:1993's "the shape is the SP7a spec §6.1-§6.2's heights, corners and sloped tops" for the coast (the cause is generated dry pits, §9.5); §4.4's "is drawn under an occluder too" (M:1065) for sources (ceiling-full, §9.2); every "SP7b" in the master that names the runtime sim (→ SP7c) or `C7.waterWall`'s final bound (→ SP7d).

References: "M:n" is the master spec's line n, "S7a:n" the SP7a spec's line n, a bare "§x" or "Dn" this document; "the brief" is `.superpowers/sp7b/design-brief.md`; "critic", "recon-reveal", "recon-surface" and "recon-obligations" are `.superpowers/sp7b/*.md`. Code is cited at `main` f267c5f (`GENERATOR_VERSION` 10, `src/core/constants.ts`; `CURRENT_SP` 'SP7a', `src/core/ids.ts:29`; `STARTED_SPS` ending 'SP7a', `test/harness/sp.ts:39`; 68 goldens). Figures marked **measured** come from the recons (recon-surface ran scratch vitest files over `test/harness/region.ts`' regions; recon-obligations parsed the logs of CI runs 46070335203 and 46082054948); nothing was run for this spec. Figures marked **estimate** are not measured; each names the task that measures it. "MC" marks recalled Minecraft behaviour.

## Points the user decided

The controller put eight questions to the user on 2026-11-28: the six Points below, approach B as built, and the spills of standing water. The user's reply, verbatim: **"Ok a todo. Vamos adelante con lo propuesto"**. So every recommendation below is the user's decision; where a question offered no option, the spec's own proposal stands; and the controller's two calls listed below were accepted with the same "Ok a todo". The options not taken are kept for the record. Nothing in the rest of this spec is conditional on an answer any more. The one later addition is Q2's stretch (D31): the user asked for it after the approval, without commitment, and the controller may drop it.

**Accepted with "Ok a todo"** (the questions besides the Points, and the controller's calls):
- **Q1. Approach B as built** (builder check 1; D20, D21, §4.5): the main thread writes triangle indices at each arrival step, and each column gets one static remesh after its reveal ends, for water and lava; the cost is measured in the LR bench leg on the Iris Xe (§13.4) and by `reveal.frame` (§13.3). The draft stated these as departures from the brief's wording of B ("the GPU reveals each part when its time comes … with no extra ticks or remeshes"); they are now accepted decisions:
  - **Index writes on the main thread.** D20 hides each animated quad's triangles, and the main thread writes them back at each arrival step (24 B per quad; water 4 Hz and lava 0.67 Hz per revealing spring). The GPU alone cannot do it because lava has no room in its vertex word for an arrival time. This is per-step main-thread work, the cost class approach A was rejected for, though far smaller (no tick, no remesh, no relight). The evidence that guards it is `reveal.frame` ≤ 0.25 ms p95 (§13.3), the LR leg and every G1 cell (§13.4).
    *Alternative, not taken:* a per-vertex arrival in the water word's 13 unread bits plus a time uniform. That reveals on the GPU alone, but it covers water only: lava would not animate.
  - **One static remesh per column after its reveal ends.** A column meshed while its spring is unseen or revealing keeps a reveal-keyed mesh: falls one quad per block per side, unmerged pool tops, spent caps as degenerate triangles. SP7b has no sim, so nothing else would remesh it in the session, and after a reveal you would never see the gated static mesh (R5, `mesh.section`). So when a spring's reveal ends, the manager queues one ordinary-priority static remesh of each column that lists its quads (§4.5). That is one remesh per column per reveal, never one per step.
    *Alternative, not taken:* keep the split mesh and gate `revealQuadRatio` instead.
- **Q2. Spills of standing water do not animate** (builder check 5; D2, §3.1). The brief says "lakes, the sea and flooded caves appear already full; only falling or flowing spring water animates". Some water is spilled over a step by a lake, the sea or a flooded cave: the coast's spill ramps, a lake rim's spill, a waterfall pouring out of a flooded cave. That water is fed by standing water, so it appears already flowing and never animates. Only what a spring feeds animates.
  This is D2 as written. The controller asked without a recommendation, and the user answered "con lo propuesto", that is, the spec as proposed. So it is the user's decision.
  **Added after the approval (2026-11-28): a stretch on top, without commitment (D31).** The controller told the user that Q2 had been read as "only spring flows animate". The user replied, verbatim: **"Vale, intentaremos que también se animen las cascadas de lagos y cuevas. De momento sin compromiso"**. The controller answered that this becomes an optional stretch goal of SP7b:
  - **The committed scope is unchanged.** Q2's decision stands for it: only spring flows animate, and SP7b is complete without the stretch.
  - **What the stretch is:** a bounded attempt near the end of SP7b (after the core reveal, the surface work and the R5 checkpoint, before the exit docs) to also animate falls spilled by standing water: lake-rim spills, waterfalls pouring out of aquifer-flooded caves, and lava spills likewise if they fall out of the same design. The coast's spill ramps are not part of it (the user named lakes and caves).
  - **Its outcome:** if it proves reasonable, it lands in SP7b. If it is costly or risky, it is dropped and handed as a note to a later SP (SP7c or SP11, §17). The controller may drop it without asking; the user is told the outcome.
  - **Its bounds:** it is not an exit criterion and gates nothing (no threshold row; any new metric part is recorded only). It must not change the generated world, the goldens or `GENERATOR_VERSION`. It must keep F4's other parts and the G1 and LR gates green; if it would push a gated row over, it is dropped.
- **(i) The order, the dependencies and the critical path** (builder check 4; §15.1, §16 item 20).
  - **The order** SP7b → SP7c → SP7d is the user's.
  - **The dependencies:** `SP_DEPS` SP7b `['SP7a']` (the paste and cut ticks it used to receive from SP5c move to SP7c), SP7c `['SP7b', 'SP5c']`, SP7d `['SP7c']`. SP8b is unchanged (`['SP7a', 'SP8a']`): it does **not** gain a dependency on SP7c.
  - **The critical path** is not lengthened by SP7c or SP7d. It stays "… SP6b → SP7a → SP8b → …". SP7b, SP7c and SP7d run after SP7a, in that order, alongside SP8a and SP8b. The master test (`test/arch/masterSpec.test.ts:370-382`) asks only that each edge of the path be a dependency, and the unchanged path still meets that.
  - **The MVP line** moves to after SP7c (SP7c's entry, §16 item 3).
  This reads the brief's "the critical path and the MVP line move to after SP7c" as the MVP line moving. The draft's literal reading, SP8b waiting for SP7c, is dropped.
- **(ii) Cutout faces beside a hidden flow** (builder check 6; D30, §4.2). A cutout solid face (leaves, glass) beside a fluid voxel on a reveal list is never culled against that voxel. So no hole shows in a tree or a pane while a flow is hidden. This adds a mesher rule, its test, and a small number of extra triangles in reveal meshes only, which go away at the static remesh.
- **R5's bound ahead of the checkpoint** (builder check 3): answered by Point 2's rounding rule.

1. **SP7b's size.** **The user's decision: the full L, about 34 tasks (realistic ceiling 40).** Counted as plan tasks: the first commit, which splits SP7b and moves the gates (1); the machine checks, the bench re-record, `measureChrome` on Wayland and the Chrome cells of f267c5f under the new OS, with your Firefox cell beside them (4); the CI work item, its shards and its sequencer (2); the reveal in D: the springs, the two-phase settle, the arrival ticks, the table and its storage (4); the replay reference and F4's parts (1); the mesher's reveal keys, front caps and the cutout rule (2); the reveal manager and its two backends (3); "seen", opening, teleporting and edits (1); what the player touches during a reveal (1); the simulation-distance setting (1); the surface: R5's split and the planar merge, ceiling-full, Fancy's facets, R5's gate (4); `riverMouth` (1); the bench rows, the reveal leg and the Chrome cells on SP7b's code (3); master pins and the obligations audit (1); review links, shots and the smoke (1); the full-tier run, CI at the exit with the exit, the production check and the user's check (4). About **34 tasks: L** (master's L is 2-3 weeks, M:1831; the brief's 30-35). Past SPs overran their plans by 6-8 tasks (critic C12), so 40 is the realistic ceiling.
   - **Chosen (the recommendation): build it as specified.**
   - **Not taken (trimmed, about 29 tasks):**
     - (a) the walk, the eye and aim read the final world during a reveal, so you could swim in a fall that has not appeared yet (D8; −1);
     - (b) Fancy's facets stay as they are at the coast (D13; −1);
     - (c) no reveal leg: G1 with reveals would be read only where the stream legs cross springs, which may be few (D24; −1);
     - (d) SP7b's Chrome cells not split from the OS's: no Chrome cells of f267c5f on the new OS (§1.4), your Firefox cell staying (−1);
     - (e) the task that adds R5's recorded `slopedShare` part (§13.2) and L1 folded into one task (−1).

   **What the choice settles:** D8, D13, D24 and D27 stand as written, and so do §1.4, §7, §13.4 and §18. The size in the header is L, about 34 tasks.

2. **R5's bound (D25).** **The user's decision: (a).** L1 and L2 are built in SP7b.
   - **The bound.** R5's bound on quick and full is the reading the R5 checkpoint measures, rounded **up** to the next 0.05. Fast is recorded only. The user approved this now, as a LOOSEN of the bound and of the tiers.
   - **The checkpoint** sets the bound without stopping for the user, unless a quick or full reading is above 0.35. In that case it stops for the user. Fast's reading (about 0.46) is recorded only and never stops it.
   - **What goes to SP11:** the 0.1 aim and the renderer lever.
   - **The first commit** parks R5 at `activeFrom` 'SP7c'. This answer approves that too.

   The record:
   - **The starting point.** R5 is SP7b's gate (≤ 0.1, the user, S7a:301; the brief: "R5 stays SP7b"). Measured at f267c5f: fast 0.7693, quick 0.5171, full 0.5605 (S7a:302).
   - **What each lever reaches.** The recon modelled every lever (recon-surface §1.3; the model reproduces the real counts within 3 %):
     - **L1, merging coplanar sloped tops** (§9.3), the lever SP7a named, gives quick about 0.49: sloped tops rarely repeat a corner pattern.
     - **L2, ceiling-full** (§9.2), stops drawing a water top pressed against a rock ceiling. It gives quick about 0.27, full about 0.29 and fast about 0.46; with L1, quick about 0.26.
       - Most of that drop is a smaller counted population, not fewer quads per face. R5 counts what is drawn (SP7a's R27 item 3), and the cave-ceiling source tops that L2 stops drawing leave both sides of the ratio. On quick the counted faces fall from 81,402 to 48,059 (−41 %), and the modelled quads from 43,320 to 14,374 (recon-surface §1.3).
       - L2 also brings back a source drawn full height under rock. That is the look R27 item 3 (71161d7) replaced after the slit you saw. Ceiling-full closes that slit from the other side, with a strip up to the rock (§9.2), and the `floodedCeiling` shot is taken at that very spot (§13.6).
     - **Below that, only a renderer change helps:** `depth` and light read in the shader from per-column textures instead of from the vertex word. With L1, L2 and both of these, quick reads 0.113 and fast 0.147.
   - **So ≤ 0.1 is not reachable on any tier**, even with every lever.

   The options:
   - **(a) (recommended; chosen):** L1 and L2 in SP7b.
     - R5 is gated on quick and full at the reading they reach, rounded up to the next 0.05 (about **0.30**). The value is set at the R5 checkpoint, never left loose for comfort.
     - Its definition is unchanged. It counts what is drawn, so L2 shrinks the counted population as above.
     - Fast is recorded. Its one 4 × 4-chunk coast window, 16 columns, reads about 0.46.
     - This is a LOOSEN of the bound and of the tiers. The 0.1 aim and the renderer lever go to SP11 as a proposal.
   - **(b) (not taken):** (a) plus the renderer lever in SP7b.
     - About +10 tasks (XL).
     - Quick about 0.12 and fast 0.15, so a bound above 0.1 would still be needed (about 0.15).
     - Water colour becomes a smooth gradient sampled by world position; the vertex word frees 8 bits; the Iris Xe's frame time must be proved again.
   - **(c) (not taken):** L1 and L2 in SP7b, with R5 kept at ≤ 0.1 and moved to SP11 together with the renderer lever. That means `activeFrom` 'SP7b' → 'SP11', a LOOSEN of when. SP7b records R5.

   **Under every option, R5 would turn red at once.** It reads 5× over its bound when SP7b's first commit appends 'SP7b' to `STARTED_SPS`.
   - So the first commit parks R5 at `activeFrom` 'SP7c', a LOOSEN (SP7a's own pattern, S7a:413, S7a:484).
   - The R5 checkpoint task moves it back to 'SP7b', with the bound set by the rounding rule above (a TIGHTEN).
   - The user's answer to this Point approves that parking.

   **What the choice settles:** D25, §9.1, §13.2, §15.1, §16 item 11 and §19. The size is unchanged.

3. **The coast's fill (D14).** **The user's decision: (a).** The coast's dry-pit fill goes to SP7d, with its `GENERATOR_VERSION` bump. SP7b only softens Fancy's facets (D13).

   The record:
   - **What the gaps are.** The gaps in your two screenshots (`assets/sp7a/user-coastFancy-gaps-1.png`, `-2.png`) are **dry voxels below the sea's surface, beside the sea** (recon-surface §2.1):
     - in the first shot, a pit 6 × 2 blocks under the eye, dry at y 61-63;
     - in the second, a hollow of about 18 × 20 blocks.
   - **Why they are dry.**
     - The aquifer gives untagged air sea water only where the nearest quarter-lattice corner is sea or river (`src/gen/fluids/aquifer.ts:666-671`, `src/gen/column/columnPoint.ts:52-56`), and the density terrain leaves ground below 63 on land corners.
     - The settle's spill then fills only the pit's edge: a rim 1-7 levels deep, set by the cap and the nearest-drop rule (`src/world/blocks/fluidRules.ts:225-236`, :291-300).
     - The slivers are those rims' sloped tops, drawn exactly (R1 0 / 0, S7a:764).
   - **Why SP7b cannot fill them.** No mesher change can fill a voxel that holds no water. The fill needs a generator change and a `GENERATOR_VERSION` bump, and option C ("Vamos con la C": no change to the generated world) excludes that from SP7b.

   The options:
   - **(a) (recommended; chosen):** the fill goes to SP7d, with its `GENERATOR_VERSION` bump.
     - **The rule:** the aquifer gives untagged air at or below 63 whose ground lies below the sea's level (63) when any of its 2 × 2 quarter corners is sea or river (recon-surface §2.3's G1).
     - **The look:** beaches below sea level become shallow lagoons up to the sand line, keeping Minecraft's 1/9 sand strip. It is the same family as wallFront5 (a spill that stops short).
     - **What SP7b does:** it softens the slivers' Fancy facets (D13) and shows you both positions again.
   - **(b) (not taken):** G1 in SP7b, with `GENERATOR_VERSION` 10 → 11, an exception to option C. About +3 tasks:
     - the generator push from its base, the goldens, A1, B4, `dryPitsBelowSea` and a re-read of the recorded `C7.waterWall`;
     - saved worlds opening with today's terrain.

   **What the choice settles:** D14, §9.5, §15.3, §17 (SP7d) and §19. The size is unchanged.

4. **Lava's light during its reveal (D6).** **The user's decision: (a), accept lava's pre-glow.** The walls are lit about 1-2.5 min (estimate) before the lava arrives.

   The record:
   - **Why the walls glow early.** The mesh bakes light per vertex, and light is computed once, for the final world (the settled flow). Lava emits 15 at every level (`src/world/blocks/light.ts:44-46`), so the walls around an abyss lava fall are lit at full block light for the whole reveal while the lava creeps down: about 1 min for a 40-block fall and 2.5 min for 100 blocks (lava steps every 1.5 s).
   - **What bounds the worst case.**
     - The lava falls' heights are not recorded yet: A5's `fallHeights` counts visible water falls only (`test/harness/water.ts:1348`). So the worst case is bounded only by §3.2 (under 768 s).
     - F4 records the longest lava reveal on the regions (`lavaRevealMaxS`, §13.1). One over 3 min is outside what the user accepted, so it goes back to the user before the reveal task closes.
   - **Water.** Water's effect is one sky level in a thin stripe, accepted without a Point.

   The options:
   - **(a) (recommended; chosen): accept.**
     - It is free.
     - Lava falls are abyss-only (`src/gen/fluids/springs.ts:28-32`) and rare (`A5.lavaFalls` ≥ 0.6 per 100,000 abyss air voxels).
     - It is shown in the shot sequence at `lavaFall` (§13.6).
   - **(b) (not taken): the glow arrives at the end.**
     - While a lava spring's reveal is pending, the sim worker relights its 3 × 3 as if the flow were dry, and the 3 × 3 is remeshed. At the reveal's end it relights back and remeshes again.
     - Light then no longer equals L's output for a while, so L1 and `DT1.light` would need a reveal mask.
     - The relight is capped at 4,096 seeds per 3 × 3 call (`src/light/relight.ts:105`), so a long fall takes several calls.
     - About +5 tasks, and a new stutter risk: two remeshes of nine columns per lava fall.
   - **(c) (not taken):** lava falls do not animate (they show complete, as today); water still does. −1 task.

   **What the choice settles:** D6, §6 and §18. The size is unchanged.

5. **"Seen" across reloads (D5).** **The user's decision: (a).** "Seen" is session memory plus the open rules:
   - on opening a saved world, every fall in the render-distance disc counts as seen;
   - so does every fall whose flow touches an edited column;
   - nothing is saved.

   The record: within a session nothing replays. A spring column, once revealed, stays done even after its columns are freed and regenerated. Across a reload, two rules of the brief that the user accepted pull apart:
   - "revisiting an already-seen area does not replay the animation";
   - "nothing changes in the generated world, the goldens or the saves".

   The options:
   - **(a) (recommended; chosen):** session memory, plus two rules that cover the common revisits.
     - **On opening a saved world,** every spring whose flow is in view when the loading screen lifts counts as seen. That is the render-distance disc, all of which is meshed before the lift. So nothing around where you stand replays on open, falls at the horizon included.
     - **A spring whose flow touches a column you edited** counts as seen.
     - **Nothing is saved.** A fall you saw in an earlier session, away from your edits and from where you reopened, falls again the first time you come near it in the new session.
   - **(b) (not taken):** a per-world record of the revealed spring columns, exact across sessions, at about +3 tasks.
     - It would be a key beside the world in IndexedDB, written by the 2-second autosave when it changes, plus an optional field in the `.wiworld` export that older builds ignore.
     - It is a save-format addition: view state rather than world content, but the brief's "nothing changes in the saves" would need the user to allow it.

   **What the choice settles:** D5, §5.3, §13.5 and §15.4. The size is unchanged.

6. **How far away a fall starts (D3).** **The user's decision: (a), Minecraft-like.**
   - An unseen fall stays hidden beyond the simulation distance; only the spring's notch shows.
   - Raising the simulation distance in Settings shows falls from farther away.
   - The default simulation distance is 6.

   The record:
   - **Today (SP7a),** every waterfall within the render distance is visible from afar.
   - **The accepted proposal** ties the reveal to the simulation distance: "the first time an area with a spring … enters the sim distance, the fluid visibly falls". So an unseen spring between the simulation distance and the render distance shows only its notch.
     - At the defaults (render distance 12, simulation distance 6), that is every spring between about 96 and 192 blocks away.
     - At render distance 16, it is everything between 96 and 256 blocks.
   - **Why the start is not at the render distance.** Terrain always appears first at the render distance's edge, so starting falls there, or showing distant flows complete, would mean you almost never see a fall start.
   - **The default of 6** was the controller's proposal. The draft raised this Point because nothing had shown the user that it hides distant waterfalls.

   The options:
   - **(a) (recommended; chosen):** as specified. A fall starts when its spring comes within the simulation distance, and is hidden before that.
     - You watch every fall you approach start close by.
     - A mountain-top view at the defaults shows the near falls, and dry notches beyond 6 chunks until you come closer.
     - Under Point 5 (a), reopening a world shows every fall in view complete.
   - **(b) (not taken):** the reveal starts as soon as the spring's ground has appeared (its 3 × 3 shown), at any distance up to the render distance.
     - The simulation distance would then bound only SP7c's sim.
     - Distant falls would be seen falling at the horizon, often unnoticed, and would be complete by the time you arrive.
     - It would change the brief's "in SP7b it bounds the reveal".
   - **(c) (not taken):** (a) with the default simulation distance equal to the render distance in SP7b. It is cheap, since the reveal does no relight, and the setting would still let you lower it.
     - At the defaults the look is (b)'s.
     - SP7c would re-decide the default once the sim's cost is known.

   **What the choice settles:** D3, D10, §5.2, §8 and §16 item 9. The size is unchanged.

## Goal

The first time you come near a spring, you see its water run out of the rock face and fall, block by block, at Minecraft's water speed (4 blocks per second), then spread over the ground below and stop exactly where it stands in today's world. Lava falls in the abyss do the same, six times slower. Lakes, the sea, rivers and flooded caves are already full when they appear, and so is the water they spill (an optional stretch, D31, may let the falls spilled by lakes and flooded caves fall too). A fall you have seen does not fall again. How near "near" is becomes a setting, the simulation distance, from 2 chunks to your render distance (6 by default). Flooded caves fill to their rock ceilings instead of leaving a lowered surface under the rock, and sloped water tops that lie in one plane merge. Underneath: the generator's settle, unchanged in what it writes, also records for every voxel of a spring's flow the step at which the flow reaches it; the mesh is built once, complete; the main thread reveals each part of it at its time by writing its triangles' indices, on both renderers, with no new tick, no remesh per step and no vertex-format change; once a spring's reveal ends, its columns are remeshed once, static. Also at SP7b's start: the machine is re-checked and the baselines re-recorded after the upgrade to Ubuntu 26.04 (a Wayland session), and CI is brought back to 6 min 0 s. The generated world, the goldens and the saves do not change (`GENERATOR_VERSION` stays 10). Water that moves when you touch it is SP7c; the generated water fronts are SP7d.

## Non-goals

- **Water that moves when you edit** (the brief, SP7c, XL): the runtime sim at 20 TPS on `fluidRules.ts`, finite and permanent water and draining lakes, reactions with `obsidian`, the bucket's one-block take, paste, cut and move ticks, the ghost drawing fluids, the current's push, the "lagos como Minecraft" option, the trailer's ticks, the bench's flood scenario (L15), F1, F2, F3, DT1 with the sim's diffs and P1's tick row. In SP7b, breaking a lake rim leaves a still water face and buckets place still sources, as in SP7a.
- **The generated water fronts** (SP7d): wallFront5, `C7.waterWall`'s final definition and bound, and the coast's fill (Point 3 (a), the user's), with a `GENERATOR_VERSION` bump.
- **A replay of real ticks** (the brief's rejected approach A) and a continuous-volume sim (rejected): the reveal replays the settle's result; it simulates nothing.
- **Animating standing water** (never), **or its spills as owed scope** (§3.1; the user's decision, Q2). The falls spilled by lakes and flooded caves are D31's optional stretch: not owed, not an exit criterion, gating nothing; if it is dropped, they go to SP7c or SP11 as a note (§17). The coast's spill ramps are not animated either way.
- **Animating anything after an edit:** an edit finishes the reveals it touches (D7).
- **R5's renderer lever** (`depth` and light out of the vertex word) and R5's 0.1 aim: SP11, as a proposal (Point 2 (a)).
- **Low, High and Ultra presets:** SP11 (`src/core/params/graphicsPresets.ts:1-3`); SP7b adds the simulation distance to Medium and to the settings.

## What was agreed earlier

From the brief, which records the user's words (quoted in Spanish as the user wrote them) and the user's choices.
1. **Scope of the master's SP7b entry: option C** (the user: "Vamos con la C"): the runtime sim plus the fluid-surface meshing (the coastFancy shore gaps and R5), with no change to the generated world. The generated water fronts (wallFront5, `C7.waterWall`) go to a later SP with a generator version bump. Moving `C7.waterWall`'s gate out of SP7b is a loosening the user accepted by choosing C.
2. **Natural simulation, the top priority** (the user): "creo que es interesante poder ver simulaciones que sucedan de forma natural. Es decir, se genera más mundo, más chunks, y suceden las simulaciones (por ejemplo, agua o lava cayendo desde sus manantiales o bloques de "fuente permanente"), así que la primera vez que pasas, puedes ver como cae el fluido. Este es el punto más prioritario para mí. Se parece a lo que ocurre cuando generas nuevo terreno en Minecraft." The controller's proposal, accepted ("Sí, me vale esa forma de simulación natural"): the generator still computes the settled water, unchanged; the first time an area with a spring or a waterfall (water or lava) enters the sim distance, the fluid visibly falls from its origin with the sim's rules and ends exactly in the generated state; nothing changes in the generated world, the goldens or the saves; lakes, the sea and flooded caves appear already full, and only falling or flowing spring water animates; revisiting an already-seen area does not replay the animation (the controller's proposal, accepted with the whole); this amends master D18 as the user's decision.
3. **How the reveal is built: approach B** (the user: "Sí, vamos con la B"): the generator's settle records, per fluid voxel of a spring's flow, the tick at which the water arrives (its path from the spring at the sim's speed); the fluid mesh is built once, complete; the GPU reveals each part when its time comes, so the stream advances block by block with no extra ticks or remeshes. Rejected: (A) the sim worker replaying real ticks and remeshing each step, for its cost while flying (the Iris Xe stutter risk, `docs/backlog.md:42`); a continuous-volume pressure sim. The accepted downside: it is a replay; if the user edits while a fall is still revealing, what is computed appears at once and the real sim (SP7c) continues from there.
4. **The simulation distance** (the user): "Todo ok con matiz en la distancia de simulación: permitiremos un rango entre lo mismo o menos que la distancia de renderizado". A user setting from a minimum up to the render distance, never above it (the master had "≤ RD−2", M:1222-1223, M:1170). Default 6 chunks (the master's Medium) clamped to RD: the controller's proposal. In SP7b it bounds the reveal; in SP7c it also bounds the sim.
5. **The split and its order** (the user: "Sí, de acuerdo con la división y el orden"): SP7b, the water is seen falling and the surface is right (L, about 30-35 tasks), with the CI work item and the post-Ubuntu-26.04 baselines and machine checks at its start, the natural reveal for water and lava not replayed on revisit, the fluid-surface meshing (the coastFancy gaps; R5 toward ≤ 0.1, with its population since SP7a's R27 item 3 and its remaining lever), the sim-distance setting, and the user's in-world check (waterfalls falling the first time; a `riverMouth` link); SP7c, the water moves when you touch it (XL, about 50-60 tasks: everything the master called SP7b); SP7d, the generated water fronts, wallFront5 ("en el wallFront5 todavía se nota que el agua se corta demasiado pronto cuando esperaría que siguiese fluyendo hacia abajo") and `C7.waterWall`'s final definition and bound, with a `GENERATOR_VERSION` bump.
6. **The master amendments the split implies** (the user's decisions): the `SubProjectId` union gains SP7c and SP7d; §10's SP7b entry is rewritten and SP7c and SP7d entries added; the "Received from SP7a" items are redistributed; the gates move (F1, F2, F3, DT1 with the sim's diffs and P1 → SP7c; `C7.waterWall`'s `activeFrom` 'SP7b' → 'SP7d', a loosening the user approved; R5 stays SP7b); the critical path and the MVP line move to after SP7c; D18 is amended for the natural reveal; the sim-distance rule becomes "≤ RD, user setting". (How "the critical path and the MVP line move to after SP7c" is carried out was the controller's call (i), accepted with "Ok a todo": the MVP line moves to after SP7c; SP8b gains no dependency on SP7c, so the critical path, which SP7b-SP7d are not on, is not lengthened; §16 item 20.)
7. **Decisions recorded for SP7c** (the user's; they are not SP7b work and are handed on in §17 and §16): finite water and draining lakes: "me gusta la idea de que se pueda vaciar, así que aquí tenemos una personalidad diferente de Minecraft donde ya no tendríamos los bloques de "fuente permanente". Es la regla que me gustaría tener por defecto. […] También es posible que alguien quiera poder jugarlo como si fuese Minecraft, activando una regla que permita cambiar esa generación a lagos que no se vacíen. Si tener la doble opción es muy caro, lo pasamos al backlog para más adelante y de primeras intentaremos tener lagos que se vacíen, sin la otra opción."; "Capas finas que se conservan; mar y manantiales permanentes, sí"; the waterfall into a drained pond, "Elijo la B" (a spring's flow keeps a fixed reach, accumulates nothing and recedes if cut); and the controller's proposals accepted with "Todo ok", as the brief records them (brief:48-55): lava follows the same model: lava springs and abyss falls are permanent, lava pools are finite, and lava is slower; the bucket takes one full block of standing water, so the lake drops a little, and places the same amount; from the sea or a spring it refills without lowering them; the thinnest layer is 1/8 block; a "lagos como Minecraft" world option, set at world creation, off by default and not changeable within a world (cheap under these rules: generated standing water is treated as permanent); speed is Minecraft's: water about 4 blocks/s, lava about 6× slower; undo reverts the user's edit but does not rewind moved water, and Ctrl+Z refuses with a notice where water now occupies the voxel; permanence (sea, springs and their flows) is derived from what the generator already knows, so the generated world is unchanged.
8. **What the user cares about** (from this and earlier SPs): no stutter, especially while flying, on the Iris Xe and the RTX; performance gates stay in force and a gate is never loosened without the user; the user checks visually in-world, in Firefox, and Chrome is run by the agent; CI wall time is watched; waterfalls visible but not everywhere; abrupt waterfall cuts minimised (SP7a).
9. **Process** (as SP7a, S7a:70): spec with reviews, Points for the user, approval, plan, subagent-driven execution, merge after the user's go-ahead, production check (Chrome by the agent under the GPU conditions, Firefox by the user), the user's check, "docs: SP7b complete".
10. **The answers to this spec's questions** (2026-11-28): "Ok a todo. Vamos adelante con lo propuesto". Each answer is recorded in "Points the user decided".

Everything below that is not one of items 1-9 was this spec's proposal. The user approved it with item 10's reply.

## Decisions (approved by the user 2026-11-28)

### Decisions with a visible effect

- **D1 Spring flows are seen falling the first time** (§3, §5; agreed, items 2-3). *You notice:* the first time a spring comes within the simulation distance (6 chunks, about 96 blocks, by default), its water runs out of the rock face and falls one block every quarter of a second (a 40-block fall takes 10 s; a floating island's 240-block fall about a minute), lands, and spreads over the ground below at the same pace until it stops exactly where it stands in today's world; lava falls in the abyss run the same way at one block every 1.5 s (a 40-block lava fall takes a minute). Each block appears with its final shape (its level, its slope toward the next block), so the leading block of a spill slopes toward ground the water has not reached yet. A new world's nearby falls start together when the loading screen lifts, as in a freshly generated Minecraft world. Alternative: approach A (real ticks replayed, rejected by the user).
- **D2 Only spring flows animate** (§3.1; agreed, item 2; the spills: the user's decision, Q2). *You notice:* the sea, lakes, rivers, flooded caves and the abyss's bottom lava are already full when they appear, and so is the water they spill: the coast's short spill ramps, a lake's spill over its rim, a waterfall out of a flooded cave. The spring's own source block, the notch in the rock face, is always there. Alternative: animate every voxel the settle adds, which would ripple every coastline and cave spill in on first view. D31's optional stretch, without commitment, may animate the falls spilled by lakes and flooded caves on top of this; the coast's ramps stay as here.
- **D3 An unseen spring's flow is hidden until its reveal starts** (§5.2; Point 6 (a), the user's: Minecraft-like). *You notice:* between the simulation distance and the render distance, a spring you have not yet seen shows only its source block in a dry rock face; when you come within the simulation distance (6 chunks by default), the water starts. Raising the simulation distance in Settings shows falls from farther; set to the render distance, falls start as soon as their ground appears. Today's distant waterfalls are hidden until you approach. Alternatives (not taken): Point 6 (b) or (c); or show unseen flows complete beyond the simulation distance, which makes a waterfall seen from afar vanish and fall again when you approach.
- **D4 When a reveal starts** (§5.2, §5.4). *You notice:* the water starts once the spring's column is within the simulation distance and all the ground its flow covers has appeared, so you never see a fall start into missing terrain; flying fast you may pass a spring before its fall has started, and it keeps falling behind you. Springs whose flows meet start together, so one stream never waits for or runs into another's. Alternative: start at the column's first mesh, which can start a fall into a neighbour still loading.
- **D5 Not replayed on revisit** (§5.3; Point 5 (a), the user's). *You notice:* within a session a fall you have seen never falls again, even after you fly far away and come back or teleport back; reopening a saved world, the falls around where you stand are already complete; after a reload, a fall you saw in an earlier session, away from where you reopened and from your edits, falls again the first time you come near it. Alternative (not taken): Point 5 (b).
- **D6 Light is final during a reveal** (§6; for lava Point 4 (a), the user's: the pre-glow accepted). *You notice:* behind a water fall that has not reached the ground, the rock and the pool floor read about one sky level darker in a thin stripe, as if the water were there; around an abyss lava fall, the walls glow before the lava reaches them, about 1-2.5 min (estimate) for a 40- to 100-block fall. Alternative (not taken): Point 4 (b) or (c).
- **D7 An edit finishes the reveals it touches** (§5.5; agreed, item 3). *You notice:* breaking or placing anything in a column a revealing flow covers, or in a column beside one, makes that whole flow appear at once in its final state. Alternative: let the reveal run on beside the edit (the edited voxels already show their new state, so the rest of the flow would be revealed around them).
- **D8 What you see is what you touch** (§7). *You notice:* you cannot swim in, or get the underwater fog from, water that has not appeared yet, nor take lava damage from lava that has not reached you; the crosshair passes through it. Alternative: the walk, the eye and aim read the final world (Point 1's trimmed (a), not taken), so an invisible fall can swim you or burn you.
- **D9 The leading edge is closed** (§4.2). *You notice:* while a fall or a spill is revealing, its leading block shows a face where the next block will appear, so you never look into the inside of the stream; a pool below a fall that has not landed yet shows a complete surface. Alternative: no caps: the leading edge of a water stream shows an open shell, and lava seen from below its front is see-through.
- **D10 The simulation distance setting** (§8; agreed, item 4). *You notice:* Settings › Graphics gains "Simulation distance" after "Render distance", offering 2 to your current render distance, "Default (6)" first; it changes at once (springs newly inside it start; reveals already running continue). Lowering the render distance below it lowers it with the render distance; raising the render distance back restores your choice. It is remembered in this browser like the render distance, for every world. The start screen's Settings shows it too. Alternative: a fixed 6 (the master's Medium), changed only by SP11's presets.
- **D11 Flooded caves fill to their ceiling** (§9.2). *You notice:* in a flooded cave the water meets the rock ceiling, instead of standing 1/9 of a block below it with a lowered surface showing under the rock; where a cave ceiling steps or overhangs the open sea, the open surface next to it rises to meet the rock's edge (Minecraft's look for water meeting water above). Judged in a shot. Alternative (not taken): keep the lowered tops (R5 cannot then fall below about 0.49 on quick, Point 2).
- **D12 Coplanar sloped water tops merge** (§9.3). *You notice:* nothing: the merged tops lie exactly in the same plane. Alternative: one quad per sloped top, as today.
- **D13 Fancy's spill facets are softened** (§9.4). *You notice:* at Fancy, the steep sloped triangles of a coast's spill rims (the bright and dark facets of your second screenshot) reflect and shade more like the flat sea around them; Fast is unchanged. Alternative: no change (the facets stay as in your screenshots).
- **D14 The coast's dry pits stay until SP7d** (§9.5; Point 3 (a), the user's). *You notice:* at your two screenshots' positions the dry pits and the spill rims remain in SP7b, with D13's softer facets; the lagoons come with SP7d. Alternative (not taken): Point 3 (b).
- **D15 Review links for the reveal and the water** (§13.6, §10). *You notice:* the review hands you links that open a fresh world at three mountain waterfalls, an island fall and an abyss lava fall (each falls once when the loading screen lifts), one link that starts outside the simulation distance so you can fly toward a spring and watch it start, your two coast screenshots' positions, a flooded cave for ceiling-full, a spring notch under a rock ceiling, and a river mouth (found by a wider search, §10). Alternative: flying with the map only.

### Technical decisions (no visible effect)

- **D16 The arrival tick is a layered breadth-first count over the settle's states from the springs, per spring column, computed in D** (§3.2-§3.3). The arrival hop h_s(v) is the first synchronous round in which a state derived from a spring of spring column s reaches voxel v, every voxel reached applying `ruleOffers` (`src/world/blocks/fluidRules.ts:265-305`) once per round from the spring sources at round 0; falls cost one hop per block. The table keeps the least h_s(v) with its spring column and records which spring columns' flows meet, so that meeting flows start together (§5.2). The arrival tick is 5·h for water and 30·h for lava at 20 TPS (M:1209). Alternative: hop counts read off the settle's own tables, which depend on its pop order (`src/gen/fluids/settle.ts:416-421`).
- **D17 A two-phase settle classifies standing water and spring flow** (§3.3). Phase 1 runs the settle's fixed point with the spring seeds withheld; phase 2 adds them and continues to convergence; the voxels that first gain fluid in phase 2 are spring flow, the only ones with arrival entries. The settled bytes are identical, since the least fixed point does not depend on order (`settle.ts:20-21`). Alternative: tag flows in T, which changes T's output.
- **D18 Springs are found in D by their shape** (§3.4). An AIR voxel with cave byte 0 holding a water or lava source, solid above and below, exactly three horizontal sides solid and the fourth passable and dry: the voxels T's `accepts` guarantees (`springs.ts:337-353`). No change to T or its stage version. A false hit would animate standing water, so the predicate is gated exact on the regions (`F4.springFalseHits` 0, §13.1); if it is not, the plan switches to the alternative. Alternative: T writes its spring list into aux B's free tail (exact, but changes T's aux output and raises a stage-version question).
- **D19 The reveal table: one byte-pool slot per column with entries, not hashed, `GENERATOR_VERSION` unchanged** (§3.5). One u32 per spring-flow voxel of the column (voxel index 17 bits, hop 10 bits, the spring's column offset 4 bits), sorted, after a 3-word header (the count, the truncated flag, the links between meeting spring columns), at most 1,021 per column, in a 4,096-byte slot referenced from the column record's int 14 (unassigned today, `src/world/store/columnTable.ts:10`). It is gen output under the determinism rules, read by the mesh jobs and never by a golden. Alternative: aux B's free tail (2,540 B, about 635 entries).
- **D20 The reveal writes triangle indices, on both backends** (§4). Animated quads are uploaded hidden: their six indices all name the row's own first vertex, a degenerate triangle that draws nothing and that every existing rebase (RegionMesh's compaction, three's `optimize`) keeps in range; their real indices are written back at their arrival, through `addUpdateRange`. A hidden quad is never a literal 0 inside a shown range (§4.3-§4.4). No vertex-format change, no shader change, no extra draw call, the same for water (pass 2) and lava (pass 0). Alternative: a per-vertex arrival in the water word's 13 unread bits with a T0 texture (recon-reveal §2.2), which does not fit lava: lava rides the opaque word with at most 7 spare bits. The writes are main-thread work at each arrival step, a departure from the brief's wording of B that the user accepted (Q1).
- **D21 Reveal keys only for springs not yet done; R5 is read on the static mesh** (§4.1, §9.1). A MESH request carries a 9-bit mask of the 3 × 3 spring columns already done; the mesher gives an animated quad its own merge key only for the others, so a column meshed after its reveals merges exactly as today, and a column meshed during them is remeshed static once they end (§4.5; accepted by the user, Q1). Alternative: reveal keys always, which splits merged pool tops forever and raises R5.
- **D22 A reveal manager on the main thread, on its own clock** (§4.5, §5). Per spring column: unseen, revealing (its start time T0 and its last arrival) or done; a clock that adds each drawn frame's dt (unwrapped, unlike `FrameState.seconds`, `src/ui/world/frameStep.ts:86-89`), so it pauses with the page. Zero allocation per frame. Alternative: the sim worker drives the reveal (a round-trip per step).
- **D23 F4: the reveal's metric id** (§13.1). Parts: arrival against a replay reference, standing water never animated, the final bytes, window independence, spring misses and false hits, truncated tables, the end faces, no overlapping caps; a master row beside F1-F3. Alternative: parts under DT1.
- **D24 A reveal leg `LR` in the bench** (§13.4), after LW, not L15 (the master's name for SP7c's flood, M:1993). Alternative: rely on the stream legs.
- **D25 R5: L1 and L2 here; the bound set by the user's rounding rule** (§9.1; Point 2 (a)). R5 is gated on quick and full at the R5 checkpoint's measured reading, rounded up to the next 0.05; fast is recorded only. The checkpoint stops for the user only if a quick or full reading is above 0.35 (fast is recorded only). The 0.1 aim and the renderer lever go to SP11.
- **D26 CI: the work item as ruled, plus a cost-ordered test sequencer** (§2). Quick's `params.metric.ts` moves out of `rest` into a `region-params` shard, fast's `terrain-caves` splits in two with `surface` and `persist` folded, 20 jobs kept; and vitest starts the costliest files first. Alternative: the shards alone, which leave `metrics-fast (rest)` at up to 7:08.
- **D27 The machine and the baselines first; `measureChrome` gated on frame pacing under Wayland** (§1). Alternative: re-record only the cells SP7b changes.
- **D28 The first commit splits SP7b and moves the gates** (§15.1).
- **D29 SP7b is L** (Point 1, the user's: the full L, about 34 tasks, realistic ceiling 40). D31's stretch is outside the 34 and the ceiling.
- **D30 Cutout faces are never culled against a hidden flow** (§4.2; the controller's call (ii), accepted by the user). In a reveal mesh, a CUTOUT solid face (leaves, glass) toward a fluid voxel listed for a not-done spring offset is emitted as if that voxel were air, so no hole shows in a tree or a pane while the flow is hidden. Static meshes cull as today. Alternative (not taken): reveal-conditioned solid caps in the cutout pass (more mesher, payload and test work), or accepting the holes.

### The stretch (added after the approval; no commitment)

- **D31 Stretch: falls spilled by standing water may animate (no commitment)** (§3.1, Q2). The user asked for it after the approval: "Vale, intentaremos que también se animen las cascadas de lagos y cuevas. De momento sin compromiso". The design below is the controller's. **Size:** stretch, about 2-4 tasks (estimate 3), outside the 34. The tasks would be: D's spill pass with its unit cases; the replay reference's spill rounds and F4's parts; the mesher and manager cases, plus a lake-fall and a cave-fall review link with shots.
  - *You would notice, if it lands:*
    - The first time a lake's spill over its rim or a waterfall out of a flooded cave comes within the simulation distance, its water runs out of the lake's or the cave's edge and falls as a spring's does.
    - Lava spilled by aquifer lava or the abyss's bottom lava does the same, six times slower, if it falls out of the same pass.
    - The lake and the cave themselves are full from the start.
    - Beyond the simulation distance such a fall is hidden (D3's rule), so the rock below a lake's rim or a cave's mouth shows dry until you approach.
    - The coast's spill ramps stay as they are.
  - *If it is dropped:* everything stays as D2.
  - **When:** after the core reveal (§3-§8), the surface work (§9) and the R5 checkpoint, before the exit docs. The core is never reordered or delayed for it.
  - **Which voxels count as a spill's flow:**
    - The voxels that first gain fluid in the settle's phase 1 (§3.3) but are not standing water: the flowing and falling voxels the settle derives from non-spring (proto) seeds.
    - Standing water itself still never animates: every proto fluid voxel, and (proposal, pinned by a unit case) a source the rules make in phase 1, which shows from the start.
    - Only spills fed by a lake or by aquifer-flooded cave water count. This is decided at the seed, from the proto's cave tag (tagged: aquifer water or lava) and the column sample's surface water (a lake's level, not the 63 of the sea or a river, `src/gen/fluids/aquifer.ts:11`); the plan confirms what D can read there. A spill fed by the sea or a river (the coast's ramps, river banks) stays static.
    - Proposal, for the task to settle: only spill components holding at least one falling voxel animate, since the user named "cascadas". A lake rim's short flat spill then stays static.
  - **Their arrival:**
    - A third layered pass in D: §3.2's BFS over phase 1's states, with round 0 the standing body's edge. That edge is the proto voxels whose offers are accepted into a spill voxel, each tagged with its own column, as a spring seed is tagged with its spring column.
    - Hops count from the edge, at 5 / 30 ticks per hop (water / lava). h < 512 still holds, since the cap bounds the horizontal distance. The seed lies within the cap of every voxel of its spill, so it is always in the voxel column's 3 × 3.
  - **Storage and transport:**
    - Spill entries share the column's slot (§3.5); bit 31 of the entry, free today, marks them.
    - Seed columns and spring columns are one namespace. A column that holds a spring and seeds a spill has one state and one T0 for both (§5.1), and meeting flows link as springs' flows do. So the payload's keys, `revealDone`, the manager and both backends do not change; bit 31 is read only by F4 and the tests.
    - `GENERATOR_VERSION`, the goldens and the table's not-hashed pins (§3.5) are unchanged.
  - **F4 reconsidered** (§13.1):
    - `standingAnimated` keeps its max 0, with its meaning widened. It counts listed voxels that are standing water (proto, or a source the rules make in phase 1), spring entries whose origin is not one of T's springs, and spill entries fed by the sea or a river. Standing water itself still never animates.
    - `truncatedColumns`, `endFaces`, `capOverlap` and `isolated` read the spill entries too, and must stay 0.
    - New parts, recorded only (no threshold row): `spillArrivalMismatch` (against the replay reference, whose phase 1 gains round counting from the standing edge; the same fixed point, so `DT1.settleReference` is unchanged), `spillIsolated`, `spillVoxels` (by feeding body), `spillColumnsShare` and `spillRevealMaxS`.
    - The stretch lands only if `spillArrivalMismatch` and `spillIsolated` read 0 on every region. Otherwise it is dropped.
  - **Risks** (each a reason to drop it, never to stop for the user):
    - **Cost.** Phase 1's pass runs wherever a window holds a lake or cave spill, far more windows than hold springs. `decorate.column`, every P1 gate, `reveal.frame` and the caves jobs' CI time (≤ 6:00, §14) must hold.
    - **Slot space.** Long cave waterfalls add entries, and `truncatedColumns` must stay 0.
    - **Classification.** The lake/sea boundary may blur, at a lake beside the sea or a river through a lake. A miss either animates a coast ramp or leaves a lake fall static.
    - **Few lakes spill.** SP7a sealed its lakes, so lake-rim spills may be rare; `spillVoxels` counts them by body first.
    - **Look and frame time.** Hiding distant lake and cave falls changes today's view from afar. More reveals in view raise the LR parts, whose gates must stay green.
    - **Lava.** If a lava spill's reveal passes 180 s (`spillRevealMaxS`), lava spills are dropped from the stretch while water's may still land. It does not go to the user, as a spring's would under Point 4 (a).
    - D18 (springs found by shape) is unchanged, and `springFalseHits` stays 0.
  - **If dropped:** a note to SP7c or SP11 (§17), with the reason and what was measured; worded at the exit (§16 items 7, 11 and 21).

## Module layout after SP7b

```
src/gen/fluids/reveal.ts                  the spring predicate, the arrival BFS, the table's packing (§3.2-§3.5)
src/gen/fluids/settle.ts                  the two-phase settle (spring seeds withheld, then added) (§3.3)
src/gen/pipeline/decorateStage.ts         step 2b: the reveal table after the settle, before the diff overlay (§3.3)
src/world/store/columnTable.ts store.ts api.ts   REC_REVEAL (int 14); revealTable(), setRevealTable(); freed with the column (§3.5)
src/mesh/fluid.ts column.ts               reveal keys, front caps, the payload's reveal lists; the done mask in the MESH request (§4.1-§4.2)
src/world/blocks/fluidRules.ts            surfaceHeight: "same fluid or an occluder above" for sources (ceiling-full) (§9.2)
src/mesh/greedy.ts (or fluid.ts)          the sloped tops' merge (L1) (§9.3)
src/mesh/greedy.ts                        cutout faces kept beside listed fluid voxels of not-done offsets (D30, §4.2)
src/render/reveal.ts                      the reveal manager: clock, spring-column states, T0, writes, masks (§4.5, §5, §7)
src/render/regionBatch.ts regionMesh.ts regionGrid.ts   index writes per backend; a listener list for shown columns (§4.3-§4.4)
src/render/materials/glsl/water.glsl.ts   Fancy's damped up-face normal (§9.4)
src/ui/settings.ts settingsPanel.ts       simDistance and its row (§8)
src/core/params/graphicsPresets.ts        GraphicsPreset.simDistance; Medium 6 (§8)
src/ui/world/frameStep.ts worldPage.ts teleport.ts   the reveal clock; the masked fluid readers; open and new-world rules (§5, §7)
src/player/walk.ts                        reads fluid through the masked reader (§7)
src/ui/world/bench.ts                     the LR leg (§13.4)
test/harness/refs.ts                      referenceReveal, the replay reference, sharing referenceSettle's phase 1 (§13.1)
test/harness/cache.ts                     the region cache dumps and checks REC_REVEAL (REGION_CACHE_FORMAT 6) (§3.5)
test/harness/water.ts riverMouth.ts       R5's counts with ceiling-full; the river-mouth prescan and tightened predicate (§9, §10)
test/metrics/caves.metric.ts render.metric.ts   F4's parts (§13.1)
test/tools/measureChrome.ts               Wayland: the pacing gate, assets/sp7b, the EGL offload (§1.3)
vitest.config.ts test/harness/fileCost.ts the cost-ordered sequencer (§2)
.github/scripts/metricShards.mjs fastShards.mjs   region-params; terrain, caves, surface-persist (§2)
```

## 1. The machine and the baselines after Ubuntu 26.04 (D27; the first tasks)

The machine moved from Ubuntu 24.04 with a GNOME Xorg session to 26.04.1 with Wayland on 2026-11-28 (the brief). Read-only on that date (recon-obligations §3.1): kernel 7.0.0-44-generic (unchanged), Node v24.21.0, `prime-select query` on-demand, NVIDIA 595.99.02, Chrome 158.0.8127.88 (SP7a's cells: 155.0.8059.39), Firefox 161.0, `free -m` total 15,197 MB with 11,572 available and `crashkernel` reserving 512 MB, AC online. Displays (Mutter, scale 1.0): eDP-1 1920 × 1080 at 240.001 Hz at (0, 0), **not primary**; HDMI-1 (no longer "HDMI-1-0") at 143.6 Hz at (1920, 0); XWayland's `xrandr` reports HDMI-1 as primary. In SP7a's Task 45 eDP-1 was primary in an X11 session (S7a:1347).

### 1.1 The machine checks (Task 2; read-only, recorded in Exit evidence)

In order, each recorded with its reading: the third-party apt sources (Chrome, NVIDIA) still present after the release upgrade; `free -m` ≥ 6,000 MB available and the kdump reservation; `/sys/class/power_supply/ADP1/online` = 1; `prime-select query` = on-demand; the displays and their rates (`gdbus` Mutter `GetCurrentState`); the 1-minute load below 1; and **the EC check**: a 16 s busy loop of 6 own threads, then 20, sampling `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq` at 5, 10 and 14 s **while the threads are busy**, averaging the top-N cores, with the package temperature. A cap (20 threads near 1.3 GHz below 70 °C, or 6 threads falling to 1.6-1.8 GHz) stops the task and asks the user for an EC reset (the global notes' procedure). This first run on 26.04 re-establishes the healthy readings (24.04's: 20 threads 2.2-2.3 GHz at 62-64 °C, 6 threads 2.9-3.1 GHz at about 70 °C, 2026-11-24); a reading that differs without a cap's signs is recorded as the new healthy one, not treated as a cap. The check runs again before every gated bench run and every Chrome run in SP7b.

### 1.2 The Node bench (Task 3)

`test/baselines.json` ("date" 2026-11-27, 45 rows, ratios to `calibration.fmix32` within +30 %, `test/bench/gates.ts:176-184`, absolutes :371-397) depends on the CPU, scheduler, power profile and EC state, not the graphics stack. Each command runs as `flock .superpowers/sdd/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=512M …`, after the EC check and with `free -m` ≥ 6,000 MB:
1. one `npm run bench` against the 2026-11-27 baselines, recording the upgrade's drift per row (evidence, not a gate);
2. `npm run bench:record` (it refuses while an absolute gate fails, `test/bench/noise.bench.ts:1365-1381`);
3. gated `npm run bench` runs until 3 consecutive passes within 6 runs (SP7a's rulings R22 protocol, S7a's Task 27l step 4), else STOP to the user;
4. commit `test/baselines.json` (only `date`, `kernels` and `killRatio` change; the machine string is the same CPU). `density.corner`'s ×1.089 (S7a:1830) resets with it.

The absolute gates in force are unchanged: every gate of `absoluteGateFailures` (`test/bench/gates.ts:371-397`), among them P1 column p50 / p95 0.7 / 1.2 ms (p95 gated through p99), `terrain.real` 13 / 20 ms, `terrain.islands` 14.5 / 26.5, `aquifer.column` 1.0 / 2.5, `light.column` and `light.column.lava` 4 / 8, `mesh.section` 1.0 / 2.5, `session.commitMaxTree`, `relight.edit` 3 ms (a p95 gated through p99, `gates.ts:54-58`), `persist.flush` p99 2, `paste.max` 800, `paste.maxLit` 1,600 and the slices. SP7b's own changes to D and the mesher are judged against these post-upgrade numbers (§13.3).

### 1.3 `measureChrome` under Wayland (Task 4)

`npm run measure:chrome -- --route flight|bench|enter --gpu iris [--workers 4]` starts its own Chrome and profile and stops only those (`test/tools/measureChrome.ts:12-33`); it never touches the user's browsers. Four changes, each confirmed with `--probe-only` first:
- **The assets directory:** `ASSETS` (:72) → `docs/superpowers/specs/assets/sp7b`; `test/metrics/g1.metric.ts` gains `ASSETS_SP7B` and its `othersDir` entry (:236-252); `test/unit/benchFiles.test.ts` follows.
- **The window and the display.** Chrome 158 with `WAYLAND_DISPLAY` set runs as a native Wayland client, which cannot position its window, so CDP `Browser.setWindowBounds`' left and top (`placeWindow`, :321-336) are ignored and `windowProblem`'s "(0, 0) is the panel eDP-1" rule (:256-264) would pass vacuously while the window may open on HDMI-1 at 143.6 Hz. The tool's gate becomes the frame pacing itself: it refuses a run whose measured display interval is not 4.165 ms ± 0.05 (240 Hz; ≈ 6.9 ms means HDMI-1), which is the protocol's real proof today (S7a:434). The user is asked, at the task, to make eDP-1 the primary display or to disconnect HDMI-1 while measuring (the user's action; the agent never changes the display configuration). `test/unit/measureChrome.test.ts` covers the new gate. Running Chrome on XWayland (`--ozone-platform=x11`) is the fallback if native Wayland pacing proves unstable, recorded in Exit evidence.
- **The RTX offload.** `NV_OFFLOAD` (:183) sets `__GLX_VENDOR_LIBRARY_NAME=nvidia`, which is GLX-only; native-Wayland Chrome uses EGL, so the offload adds `__NV_PRIME_RENDER_OFFLOAD=1` (and `__EGL_VENDOR_LIBRARY_FILENAMES` if the probe needs it). `gpuMatches` (:177-180) stays the gate; the ANGLE Vulkan reason (:215-218) is re-checked under EGL. RTX cells are not gated in SP7b (§13.4).
- **The conditions text:** "the seat0 x11 session `LockedHint=no`" and "HDMI-1-0" become the Wayland session and "HDMI-1" in the comments and the protocol. Scale is 1.0, so `viewportProblem` (:242-245) holds unchanged.

uiSmoke (`test/tools/uiSmoke.ts`, SwiftShader) and `mapLatency` are re-run once as a sanity check (Chrome 158); goldens are re-run, never re-recorded (Bun 68/68; `?selftest=1` in Chrome by the smoke).

### 1.4 The OS baseline cells (Task 5)

Every Iris Chrome route (`flight`, `bench`, `bench --workers 4`, `enter`) is measured on **f267c5f** under the new OS into `assets/sp7b/os-f267c5f/`, under §13.4's conditions. These cells separate the OS's effect from SP7b's, so that a G1 cell that moves on SP7b's code can be attributed (SP7a's D36 precedent: every cell re-measured). The brief requires the Firefox cells too (brief:7-9): the user is asked, at this task, for one Firefox bench run on production, which serves f267c5f until SP7b merges, saved as `assets/sp7b/os-f267c5f/bench-iris-firefox.json` (SP7a's protocol: the user's download, compared byte for byte, S7a:1406); the user runs Firefox on SP7b's code again at the production check (§13.6).

**An OS cell already over its gate.** If any f267c5f cell (Chrome or Firefox, under §13.4's conditions with the EC check) already fails its G1 gate on the new OS, the work stops before any SP7b code is measured and goes to the user, with the options: a re-record after an EC or display investigation, or a ruling on that cell. No gate is loosened without the user. Otherwise the OS cells gate nothing themselves, and every SP7b cell is judged against its gate and against its OS cell (§19).

## 2. The CI work item (D26; at SP7b's start)

**The owed item** (S7a:475, M:1993; SP7a's rulings R29): back to 6 min 0 s on cold runs: "split metrics-quick (rest)'s `params.metric.ts` and `noise.metric.ts`, and metrics-fast (terrain-caves), across jobs, with a fold to keep 20 jobs; no sample reductions", no gate loosened. **Today** (recon-obligations §2.1): cold walls 7:28, 6:28, 6:30 and main's merge run 5:58; the jobs past the line were `metrics-quick (rest)` 5:46 / 5:38, `metrics-fast (terrain-caves)` 5:53 and `metrics-fast (rest)` 7:08 (5:37 on the merge run). A 6:00 wall needs every metrics-quick job ≤ about 5:20 (vitest ≤ about 295 s; `metrics-merge` runs after them) and every other job ≤ about 5:38 (recon-obligations §2.2's arithmetic). `check` (5:27-5:35), `unit (liveness)` (5:18-5:22) and `unit (heavy-b)` (5:18-5:23) sit at the line, and the work item touches none of them.

**A cause the item's wording misses** (recon-obligations §2.3, measured from the logs): with no results cache in CI, vitest 5.0.2's sequencer starts "unknown first, larger files first" on `cpus − 1` = 3 workers; `params.metric.ts` (51 lines, the single-threaded U2 over every leaf, 132-257 s, tier-independent) is the second-smallest metric file, so it starts after the bigger files free a worker: about 64 s late in quick rest #3, about 172 s late in fast rest #1. That, more than file sizes, made fast rest's 7:08.

**The plan** (each step measured, nothing sampled less, no gate moved):
1. **Quick: `params.metric.ts` out of `rest`, folded with `region`** into a shard `region-params` (no env; region v177-226, U2 136-257 s, on 3 workers they start together): estimate v 226-295 s, job 4:10-5:20, marginal, so measured. If it measures past 5:20 (region's 3 workers and U2's thread contending for the runner's 4 CPUs), U2 moves instead to the quick shard with the most measured headroom other than `rest`, keeping 11 quick jobs and params apart from noise; no sample is cut. `rest` keeps `noise.metric.ts` (now in its first wave) with biomes, blocks, presets, relief and water: v 130-235 s. params and noise are then in different jobs, as ruled. Quick stays at 11 jobs.
2. **Fast: `terrain-caves` → `terrain` and `caves`**, folded `surface` + `persist` → `surface-persist` (surface, persist, clipboard; estimate 220-300 s, job 4:00-5:20). Fast stays at 4 jobs; the total stays 20. The cache step's `matrix.shard != 'surface'` condition (`.github/workflows/ci.yml:129`) then lets the folded shard cache (harmless).
3. **A cost-ordered sequencer** (lever S): `vitest.config.ts`' `test.sequence.sequencer` becomes a `BaseSequencer` subclass that starts files by a committed cost table (`test/harness/fileCost.ts`, keyed `project:file`, from the measured logs) longest first, falling back to today's order for files not in it. With U2 on its own worker from t = 0: quick rest about 136-257 s, fast rest about 144-258 s (estimates). It changes no shard, no sample and no gate. (Caching vitest's results directory in CI would do the same only after a first run per key, so the committed table is taken.)

**Expected cold wall** after 1-3: about 5:30-6:00 on slow runners, 5:00-5:20 on fast ones, bound by `check` (**estimate**). **Measure:** a push run plus two cold re-runs after deleting this branch's `regions-*` caches for the current key (S7a:1735), every job table recorded. **If missed, in order:** integration out of `check` into its own job, with a fold to keep 20; `livenessSp7a.test.ts` split by leaf group across the unit shards (SP6b's pattern, `.github/scripts/unitShards.mjs:26-31`); then the user. Gating U2 on quick and full only (`tiers: ['quick','full']`) would save 132-240 s of fast rest but is a LOOSEN (`test/harness/lock.ts:64-71`): offered to the user only if the levers above miss. **Tests and comments** with the change: `test/unit/shards.test.ts` (:43-44, :63-121, :151-172 including the literal `'terrain-caves'` at :153), the comments in `.github/scripts/metricShards.mjs:16-96` and `fastShards.mjs:15-34`. The master's §1 `ci.yml` line names no shard (M:68), so it does not change.

## 3. The arrival tick (D1, D2, D16-D19)

### 3.1 What animates and what never does

- **Animated:** the voxels a spring's flow adds, that is the voxels that hold fluid in the settled world and none after the settle's phase 1 (§3.3): the falls and spills of water springs in mountain faces, of island-edge springs, and of lava springs in the abyss (all three kinds, S7a §3), and water a spring's stream brings into the abyss (S7a:245).
- **Never animated** (the spills: the user's decision, Q2): every proto fluid voxel (the sea, rivers, lakes, sky-open water, aquifer water and lava, flooded caves, the bottom lava at `aquifer.lavaLevel`, and the spring's own source voxel, which shows from the start as the notch in the rock face); everything the settle derives from them (the coast's and lakes' spills, v0 walls flowing over a step, cave waterfalls out of flooded cells, coastFancy's rims), unless D31's stretch lands (below); a standing voxel whose level a spring's flow improves (it shows its final height from the start); a water/lava contact unless its lava is spring flow (§3.2).
- **The stretch, if it lands** (D31; the user's request after the approval, without commitment: "Vale, intentaremos que también se animen las cascadas de lagos y cuevas. De momento sin compromiso"):
  - **Also animated:** the falls spilled by lakes and by aquifer-flooded caves, that is, the flowing and falling voxels phase 1 derives from a lake's or a flooded cave's edge. Lava spilled by aquifer lava or the bottom lava is animated likewise if it falls out of the same pass.
  - **Still never animated:** standing water itself (every proto fluid voxel, and the sources the rules make in phase 1), and the spills of the sea and rivers (the coast's ramps, coastFancy's rims).
  - **If it is dropped,** the two lists above stand as written, and the spills go to SP7c or SP11 as a note (§17).

### 3.2 The definition

- **States** are the settle's: per voxel and fluid type a value code (source 0, falling 1, flowing k as 1 + k) and a horizontal distance (`settle.ts:8-14`, :185-188). The offers are `ruleOffers` unchanged: the fall at `dist` unchanged (`fluidRules.ts:273-275`), spreads at dist + 1 toward the nearest drop with nothing spreading at the cap (:276-291), new water sources at dist + 1 (:293-303). Every read is the proto's, so an offer depends only on static proto data and the voxel's own state (recon-reveal §1.1).
- **Spring columns:** a spring column is the column holding a spring (two springs in one column share it). Every state carries its spring column, and dominance applies only between states of the same spring column, so each spring column's flow is computed as if it were alone. Since every offer depends on one state and the proto (`ruleOffers`), the union of the per-column fixed points is the joint one, and the least per-column arrival equals the joint arrival from simultaneous starts.
- **Rounds:** round 0 holds every spring seed of the window (§3.4) as (source, 0), tagged with its spring column. Round r + 1 applies `ruleOffers` to every state accepted in round r. An offer (u, c, d) of spring column s is accepted when d is below the least distance over codes ≤ c among the states of spring column s at u accepted in rounds ≤ r + 1 (the settle's acceptance, `settle.ts:416-421`, restricted to one spring column's states and to earlier-or-equal rounds); rounds are double-buffered, so a state improved during a round is processed in the next, never early.
- **The arrival hop** h_s(v) is the first round in which a state of spring column s is accepted at v; the voxel's entry stores h(v) = the least h_s(v) and its spring column, ties going to the spring column with the lowest world key (cz, then cx), which does not depend on the window or on processing order. Two spring columns that both reach a voxel are **linked**, and each column's table records the links among its 3 × 3's spring columns (§3.5); linked spring columns start together (§5.2), which makes the stored joint hop exact for each of them. Water and lava run separately, each treating the other type's proto fluid as `block` (`fluidRules.ts:8-9`, :131-134), as the settle does.
- **Ticks:** water 5·h, lava 30·h at 20 TPS (M:1209): 0.25 s and 1.5 s per hop. A fall costs one hop per block, horizontal steps one hop each.
- **Bounds:** h ≤ the vertical drop + the horizontal distance; the drop ≤ 383, the horizontal distance ≤ the cap (12 water, 14 lava, `fluidRules.ts:288`), so **h < 512** (9 bits; 10 stored). The longest water reveal is under 128 s, the longest lava reveal under 768 s.
- **Why it is exact and order-free:** a state dominated by an earlier-or-equal-round state of the same spring column adds no earlier arrival, because offers are monotone in (code, distance), and same-round acceptance order changes no round number (recon-reveal §1.2). The tie-break is by world key, never by processing order. Standing states are ignored: a spring-derived state dominated by a standing state continues only to voxels the standing continuation reaches, which are standing and get no spring entry (recon-reveal §1.3; spill entries are D31's stretch only). So h does not depend on processing order, and the replay reference (§13.1) checks it against an independent synchronous replay from the settled standing water.
- **Contacts:** a voxel both types reach takes lava with `unsettled` (the merge, `settle.ts:474`); it is animated at the lava's arrival if the lava there is spring flow, else static.

### 3.3 Where it is computed: D, with a two-phase settle

- **The two phases** (D17), in `settleWindow` (`settle.ts:437-488`), per type: phase 1 runs `fixedPoint` (:352-427) with the spring seeds withheld (a withheld spring voxel can be touched as (source, 0) but never pushed, since nothing beats distance 0 at code 0); phase 2 pushes them and continues to convergence. The final bytes equal today's because the least fixed point does not depend on order (`settle.ts:20-21`); `DT1.settleReference`, `DT1.settleIsolated` (S7a:1876) and the golden `sp7a.region.D.water` (`test/unit/goldens.sp7a.test.ts:128-161`) stay as they are and are re-asserted.
- **The BFS** (§3.2) runs only when the window holds a spring seed within the cap of K (seeds farther than 12 / 14 from the box are skipped, as the settle skips them, :367-369), over the same 48 × 48 3 × 3 proto window D already reads (`src/gen/pipeline/decorateStage.ts:274-315`). Entries are kept for K's phase-2-only voxels (D31's stretch, if it lands, adds spill entries from phase 1; §3.1, D31).
- **Step 2b of D**, after the settle's writes and before the diff overlay (step 5, :359-369), so the table never sees edits: it is computed from the proto only, and it is identical for a column re-D'd after a free, after proto retention or after a reload.
- **Window independence:** every derivation reaching K starts within the cap of K and its searches read at most 4 further (S7a:244's radius), so K's table from its own window equals a wide window's (`F4.isolated`, §13.1).
- **Cost (estimate, measured by the bench rows' task, §13.3):** most windows hold no spring and pay only the predicate on seeds D already enumerates; a window rarely holds more than two spring columns, and each spring column's BFS covers only its own flow; a spring flow is about 10 + 28 voxels per fall and spill (S7a:403), a few hundred for long falls with pools. `decorate.column` is re-recorded (§13.3).

### 3.4 Finding the springs (D18)

The predicate runs on the 3 × 3 proto over D's proto source seeds (every spring is a seed, since its outlet is dry): an AIR voxel with cave byte 0 holding `WATER_SOURCE` or `LAVA_SOURCE`, solid above and below, exactly three horizontal sides solid and the fourth (the outlet) passable and dry. It matches every kind T places (`springs.ts:337-353`); aquifer lava is tagged, so untagged lava is always a spring. **Misses:** two adjacent springs ("two-faced", under 1 per 10 km², S7a:215) fail the shape and their flow shows complete (counted by the existing recorded `A5.adjacentSprings`, `test/metrics/caves.metric.ts:866`; F4 adds no count of its own). **False hits:** an untagged one-voxel notch of sky-open water at a quarter-lattice boundary, whose water really flows, would be withheld in phase 1, so its standing spill would animate and fail `F4.standingAnimated`. `F4.springMisses` and `F4.springFalseHits` (§13.1) compare the hits with T's springs (`terrainSpringsDebug`) on the caves regions, both gated at 0. The F4 task measures them first; a false hit on any region switches D18 to its alternative (T's spring list in aux B's free tail), with the stage-version question answered in that task against `src/core/stage/registry.ts`.

### 3.5 Storage and transport; `GENERATOR_VERSION` unchanged (D19)

- **The entry:** a u32 per spring-flow voxel of the column: bits 0-16 the column voxel index ((y + 64)·256 + z·16 + x; 98,304 voxels), bits 17-26 the hop, bits 27-30 the spring's column offset in the 3 × 3 ((dx + 1) + 3·(dz + 1), 0-8); bit 31 is left 0 (D31's stretch would use it to mark spill entries). The type comes from the voxel's own fluid byte. A spring lies within the cap (≤ 14 < 16 blocks) of every voxel of its flow, so it is always in the voxel column's 3 × 3.
- **The slot:** a byte-pool slot (4,096 B, `src/world/store/pool.ts:22`): a 3-word header, then up to 1,021 entries sorted by index (12 + 1,021 × 4 = 4,096 B). Header word 0: the count in bits 0-15, bit 16 "truncated". Words 1-2: the links, a 36-bit mask of unordered pairs (i < j) of 3 × 3 offsets whose spring columns both reach a voxel of this column (§3.2); two linked spring columns each reach such a voxel within the cap, so both lie in this column's 3 × 3. A column with more than 1,021 entries marks itself truncated and its flow shows complete, in code; `F4.truncatedColumns` is gated at 0 on the regions, and a miss goes to the controller, with chained slots as the lever. Columns with no entry hold no slot (most columns).
- **The record:** int 14 becomes `REC_REVEAL` (the slot, or −1), published with D's status as the descriptors are, retained and freed with the column (`freeColumn`) as aux slots are. `clearRecord` (`src/world/store/columnTable.ts:139-150`) sets it to −1 with aux A and aux B, so a fresh record never reads 0 (byte slot 0) as a table. D releases a reveal slot it already holds when it reruns on a live record (the `regenerating` path after an `apply`, `src/engine/coordinator.ts`, and retries). `columnTable.ts:9-10`'s layout comment and master §2.3's record line say so.
- **The test region cache** (`test/harness/cache.ts`) dumps record ints but rebuilds only aux A and aux B (:441-448) and checks only three ints (:491-493). `REGION_CACHE_FORMAT` goes 5 → 6: the reveal slot is dumped after aux B when int 14 ≥ 0 and restored into a fresh slot, and `REC_REVEAL`'s presence joins the rebuild check, so a cache hit (CI's `regions-*` caches) never hands the mesh parts a missing or foreign table. A unit test round-trips a dump with a spring column.
- **Memory (estimate):** a long fall's column holds 100-600 entries; with about 6 springs in view in mountain country at RD 12 (S7a:21), at most about 54 columns × 4 KB = 216 KB of slots.
- **To the renderer:** the mesh job reads K's and its 8 neighbours' tables from the shared store (the neighbours' for the padded border, §4.2) and puts its reveal lists in the payload (§4.1); the main thread holds only what the payload carries.
- **Not hashed, and pinned so:** no golden reads the table, and no key is added (`test/goldens.json` keeps its 68 keys); no generated voxel changes, so **`GENERATOR_VERSION` stays 10** and the decorate stage's version is unchanged (its generated output is unchanged; the plan confirms against `src/core/stage/registry.ts` and U4's `checkRegistry`). Pinned three ways: an arch rule on direct imports (`src/metrics/**` and every golden builder may not import `gen/fluids/reveal.ts` directly; the path through D, `src/metrics/sp7aGoldens.ts` → `metrics/region.ts` → D, imports it by design); `test/unit/revealTable.test.ts` asserting `GENERATOR_VERSION === 10`, the 68 keys, and that `sp7a.region.D.water`'s digest is unchanged when every `REC_REVEAL` of its region is set to −1 before hashing (no golden reads the table); and the governance check, which already refuses a golden change without a version bump (`test/harness/governance.ts:46-52`). The table's own determinism is gated by F4's parts (§13.1), not by a golden.

## 4. The reveal in the mesh and on the GPU (D9, D20, D21)

### 4.1 Reveal keys and the payload's reveal lists

- **The MESH request** gains `revealDone`, a 9-bit mask of the 3 × 3 offsets whose spring column is done (§5.1); the page fills it from the reveal manager when the coordinator issues the job. Where no manager exists (the harness, the Node bench, R5), the mask is all-done.
- **Reveal keys:** for each table entry whose spring offset is not done, every quad of that voxel gets a reveal key in merge key C: (offset, hop). Water's `kc` (`src/mesh/fluid.ts:315`) carries it in bits ≥ 13 and lava's (0 today) carries it outright; `fluidWords` masks `kc & 0x3FF` (:384), so no key bit reaches a vertex. An animated quad therefore never merges with a static quad or with another arrival; a falling column's side faces become one quad per block per side (about 400 quads for a 100-block fall). Entries whose voxel no longer holds fluid (a diff changed it) emit nothing. The quad index q is recorded at emit time as the row's index count / 6 minus the row's start, so lava's quads in the opaque pass count the terrain quads the builder appended to the same row before the fluid mesher (`builder.ts:94-112`).
- **The payload** (`src/mesh/column.ts:52-71`) gains:
  - `reveal: Uint32Array`, two u32 per listed quad: (row index << 16 | quad index in the row), then (show << 16 | hide), each a u16 of (offset << 12 | hop), with 0xFFFF meaning "always" (show) or "never" (hide). The builder writes 6 consecutive indices per quad (`src/mesh/builder.ts:94-112`), so quad q of a row lives at `indexStart + 6q`. Listed per row, sorted by (show offset, show hop), with a second per-row order (a u16 permutation) sorted by (hide offset, hide hop) for the hide events.
  - `revealVoxels: Uint32Array`: K's table entries for the not-done offsets (§7's masks).
  - `revealMax: Uint16Array(18)`: per offset, the largest water hop and the largest lava hop listed.
  - `revealLinks`: K's table's link mask (§3.5), for the manager's linked sets (§5.2).
- **R7 unchanged.** The column's rows are revealed atomically as today (`src/render/regionGrid.ts:246-259`); R7's probe reads reveal state, not indices (`regionGrid.ts:637-640`, `regionMesh.ts:47-49`), and excludes fluid remeshes (M:1576). A fluid reveal inside a revealed row is not a partial column, and §16 item 11 says so in R7's row.

### 4.2 Front caps (D9)

Same-fluid faces are culled (`fluid.ts:304`), so an arrived voxel's face toward a same-fluid neighbour not yet arrived is missing from the mesh, and so is a standing pool's top under a fall that has not landed. For every pair of adjacent same-fluid voxels (u, t) whose reveal keys differ, where t is listed (a standing voxel's key is "always"):
- **Which pairs:** with the same spring offset, a cap only where u's hop is less than t's; with different offsets, a cap in each direction, since their order depends on two start times the mesher does not know (§5.2). The manager shows a cap while show ≤ now < hide (§4.5), so a cap whose hide comes no later than its show never shows.
- **The face:** u's face toward t as it would be against a dry neighbour (a side from u's bottom to its two corner heights, a top at its corners, a full down face), listed with show = u's key and hide = t's key. Where u also has a strip toward t (u drawn full, t lower: `fluid.ts:318-319`, `stripOf` :203-221), the cap is only the part the strip does not cover, from u's bottom up to the strip's bottom vertices; the strip itself stays unconditional. Without this, every spring outlet under ceiling-full (§9.2), whose source is drawn full, would carry a coplanar strip and cap for its whole hidden period (z-fighting on lava, double blending on water), and so would every fall's landing for one step. `F4.capOverlap` gates that no two listed quads that can be visible at once overlap coplanar (§13.1).
- **Unmerged:** caps are emitted 1 × 1, like sloped tops (`fluid.ts:332-336`), never through the merge masks, so their (show, hide) pair needs no room in key C and a cap never merges with an ordinary face.
The neighbours' keys across the column border come from their tables (§3.5). **Count (estimate):** one per falling voxel, up to 4 per pool voxel, a few per landing. Corners are computed from the final neighbours (`fluid.ts:14-23`), so a leading voxel's top slopes toward the next one; accepted. Once every reveal of the row has ended its caps are degenerate triangles, until the static remesh that follows the reveal (§4.5) emits none.

**Cutout faces beside a hidden flow** (D30; builder check 6, the controller's call (ii), accepted by the user with "Ok a todo"):
- **The problem.** The cutout pass culls a CUTOUT block's face (leaves, glass, and the like) toward any WATER or LAVA voxel (`src/mesh/greedy.ts:179-182`). The final store holds the flow, so a leaf or glass face next to an unarrived fall or spill would be missing while the flow is hidden, and you would see into the block. Trees beside mountain falls and spills are common.
- **The rule.** In a reveal mesh, a CUTOUT face whose neighbour is a fluid voxel listed for a not-done offset is never culled against it.
  - "Listed" means listed in K's table or a neighbour's, the same tables the reveal keys and caps read (§3.5, §4.1).
  - The mesh job builds a bit mask over the padded window's voxels listed for not-done offsets. Greedy's CUTOUT test skips its fluid clause where the bit is set. The same-block rule for leaves and the glass/ice rule are unchanged.
  - The face is emitted as against air, unconditionally: it is neither listed nor hidden, so the payload, the manager and both backends are unchanged.
- **What you see.** The face shows while the flow is hidden. Once the flow arrives, it shows behind the translucent water, as a leaf or a pane inside water does. The static remesh after the reveal (§4.5) culls it as today.
- **Static meshes are unchanged:** every offset done means no bit set, and R1 stays 0 / 0.
- **Effect on triangles** (estimate, recorded by F4's `cutoutKept`, §13.1): a few faces per tree or pane beside a flow, in reveal meshes only, and gone at the static remesh. This is small beside the caps and the unmerged fall sides that `revealQuadRatio` already records.
- **Tested** by a mesher unit test (§13.5):
  - a leaf and a glass block beside a listed voxel of a not-done offset keep their faces, inside the column and across its border;
  - with the offset done, both faces are culled as today;
  - an unlisted fluid neighbour still culls.
- **F4's `endFaces`** (R1's `hiddenEmitted` on the revealing mesh) counts these faces in `cutoutKept` instead of as hidden faces emitted.

### 4.3 RegionBatch

- **The hidden state** of a quad, on both backends, is six copies of a vertex inside its own row's range: the row's rebased first vertex. It is never a literal 0, because every structural operation rebases a shown range's indices by adding the vertex move (three's `optimize`, `BatchedMesh.js:918-922`; RegionMesh's compaction, `regionMesh.ts:478`), and a literal 0 plus a negative move wraps in the `Uint32Array` to an index far past the arena; Firefox, which validates indexed fetch, would then skip the draw of a whole region and pass.
- **Upload:** before the row's geometry is added (`regionBatch.ts:12-24`), the listed quads' 6 indices are copied into the manager's store and set to 0 in the payload's index array. `setGeometryAt` rebases every index by the geometry's vertex start (`vertexStart + srcIndex.getX(i)`, `BatchedMesh.js:768-792`, :779), so a payload 0 is stored as `vertexStart`, the hidden state. The payload's index array is the mesh job's own transfer; RegionMesh's `reveal` and `swap` read it after upload (`regionMesh.ts:616`), which is what turns its zeros into the hidden state there too, and the harness and the edit probe mesh with every offset done, so they read no zeros. If any payload buffer is found to be pooled or shared, the backend copies instead of mutating.
- **Write:** at a quad's time, the manager writes its 6 original indices rebased by `getGeometryRangeAt(geometryId).vertexStart` into the batch's own index attribute at `indexStart + 6q` of the row's current range, and a hide writes six copies of `vertexStart`; one `addUpdateRange` per contiguous run, coalesced per batch per frame, and `needsUpdate`. The range is re-resolved at every write, since `optimize` moves ranges (`regionBatch.ts:26-35`); growth (`setGeometrySize`) and `optimize` copy the batch's current arrays, so written and hidden indices persist (`optimize` shifts a geometry's indices only when its `indexStart` moves, :911-926). **Spike first** (the RegionBatch task's first step): pin on three r186 that `optimize` and growth carry index writes, and assert max(index) < the vertex count after every structural operation and every reveal write; a failure goes to the controller before the backend is built.
- **Swap and removal:** a replacement row (SP4c spec §5.2) gets its own listed quads at upload, with the quads already due written at once; a removed row drops its entries. Cave culling's draw-list filter (`cullDrawList`, :92-117) and the translucent sort are untouched.

### 4.4 RegionMesh

- The span's indices stay literal zero until the column's reveal frame (`regionMesh.ts:20-22`), which is safe because compaction rebases only shown spans (`regionMesh.ts:478`). The reveal frame's writer lays a pass's rows out one after another from `s.v0` and rebases each row by its own first vertex (`regionMesh.ts:612-617`, `v += rows[o + 3]`); it writes each listed quad in its state at that moment (§4.5), the hidden state being six copies of that row's first vertex, never 0.
- The manager writes only shown spans; before a span is shown its pending states are applied by the reveal frame's writer. A later write rebases the 6 originals by the **row's** first vertex in the span (s.v0 plus the vertex counts of the pass's earlier rows), never by s.v0 alone, which would point the second and later rows' quads at the wrong vertices.
- Compaction (in place) and growth (a new geometry) copy the arena's current arrays, and compaction's rebase keeps hidden quads in range, so the state persists; the manager re-resolves the span's offsets through the backend at each write. Unit tests on both backends compact or `optimize` a span or geometry downward while it holds hidden and cap-hidden quads, and assert max(index) < the vertex count after every structural operation and every reveal write. A swap writes the new spans' indices through the same filter. `remove` zeroes the span; the manager drops the column. Every write is `addUpdateRange` plus `needsUpdate`, and the hidden-arena cap `HIDDEN_RANGES_MAX` applies unchanged. A reveal writes no draw range (`applyDrawRange` stays the only writer).

### 4.5 The reveal manager (D22)

`src/render/reveal.ts`, backend-neutral; each backend implements `writeQuads(column, row, quads, original | hidden)`. It subscribes to the staging's upload, swap, removal and shown-column events through a listener list added to `regionGrid.ts` (`onColumnRevealed` stays the bench's and the edit probe's single consumer, `regionGrid.ts:271`). Per frame, in the renderer's step before three's render (beside `sortTranslucent`):
- advance its clock by the drawn frame's dt (unwrapped f64; a hidden page draws no frame, so the clock pauses);
- run §5.2's start test over the unseen linked sets referenced by shown columns;
- for each revealing spring column, the current hop h* = ⌊(clock − T0) · 20 / rate⌋ (rate 5 water, 30 lava; T0 its linked set's), and for each row listing quads of that offset, write the quads whose show key or hide key lies in (the last h*, h*]: a pointer walk over each of the row's two orders, O(quads changed);
- mark done every linked set whose clock passed T0 + its members' largest listed arrival + one step (§5.1), and queue the static remesh below.
**State at "now", not by transitions.** Whenever a row's listed quads are first written (an upload, a swap, RegionMesh's reveal frame, a payload that arrives after some of its times have passed through generation lag), each quad is written in its state at that moment: visible iff show ≤ now < hide, a key of an unseen offset counting as never come. Transitions then follow by the pointer walks.
**The static remesh after done** (accepted by the user, Q1). When a linked set is done, the manager queues one remesh of every shown column whose payload lists quads of its members, with those offsets done, so the static mesh (merged, no caps; what R5 and `mesh.section` gate) replaces the reveal mesh. At most one column is requested per frame, on the ordinary MESH lane, never the edit lane (`EDIT_MESH_PRIORITY` −1000, `src/engine/workerPool.ts:415`). It swaps in like any remesh, atomically per column (R7 excludes it as a fluid remesh, §16 item 11). Measured in LR.
**Cost:** main-thread work only at arrival steps (water 4 Hz, lava 0.67 Hz per revealing spring), 24 B uploaded per quad written; memory per revealing row about 38 B per listed quad (the 6 original indices, the 2-u32 entry, the hide order's u16 and a pointer), freed when its reveals end. Zero allocation per frame (`test/unit/zeroAlloc.test.ts`'s pattern). Measured by the bench row `reveal.frame` and the leg LR (§13.3, §13.4).

## 5. When a reveal starts, and when it never replays (D3-D5, D7)

### 5.1 States

Per spring column (the column holding the spring; two springs in one column share it), keyed by its world column (cx, cz) in a session `Map`: **unseen** (no entry: its listed quads stay hidden), **revealing** (T0 and the largest arrival listed in any payload received, in seconds), **done**. A column freed outside RD+5 (`src/engine/rings.ts:99-100`) and regenerated later recomputes the same table (§3.3), and the state, kept by the spring column's world key, carries on: a done spring's flow meshes static, a revealing one resumes at the clock's hop. A payload that arrives after its spring is done is shown complete. **Linked sets:** spring columns linked by any payload's `revealLinks` (§3.5) are joined in a union-find over world keys; a set shares one T0 and is done as a whole. **A terrain Apply** regenerates the world with new terrain and new springs, so it clears the map: the regenerated world reveals as a new world does (§5.3), and no old state hides a new spring's reveal or plays a new table at an old T0.

### 5.2 T0

A linked set of spring columns (a single spring column when nothing links it, §5.1) starts (T0 = the clock) at the first frame where:
- the world view is live (the loading screen has lifted);
- some member lies within the simulation disc of the camera's column, dx² + dz² ≤ (sim + 0.5)², the rings' metric (`rings.ts:1-7`), with sim the effective simulation distance (§8);
- for every member, every column of its 3 × 3 that lies in the MESH disc is shown (its rows revealed). A column whose payload has no non-empty row counts as shown once staged (a void or floating_islands sky column; the listener list reports it, and a unit test pins it). A column of the 3 × 3 outside the MESH disc is not drawn; if it is meshed later, its part of the flow appears at its hop's time from T0, complete if that time has passed.
Until T0 the flow is hidden (D3; Point 6 (a): beyond the simulation distance only the spring's notch shows). T0 per spring column (not per voxel column) keeps a flow continuous across column borders: a per-column start would stall a flow crossing from A to B by |T0_A − T0_B| (recon-reveal §4.2). T0 per linked set does the same where two springs' flows meet: the stored hop is the joint one from simultaneous starts (§3.2), so neither stream stops at the meeting point or meets water ahead of it. A link found after its set has started (a meeting column meshed late) joins the new member at the set's T0; two started sets that become linked take the earlier T0, so the later one's parts already due appear at once (rare). Flows that do not meet need no shared start: a cap between them is decided at each moment by both start times (§4.2).

### 5.3 Seen (D5; Point 5 (a))

The user chose Point 5 (a): the session map is the memory; plus **the open disc**: when a saved world is opened (the worlds menu's open, or a reload of a saved world), every spring column referenced by a payload staged before the loading screen lifts (the render-distance disc, every column of which is meshed before the lift, `src/ui/world/worldPage.ts:29`, `firstFill`) is set done, with its linked set; plus **edited columns**: a column with DiffStore entries (the coordinator knows from its read-through, `src/engine/coordinator.ts:400-428`) sets every spring column its payload references done. A **new world** (created in this page session, including the review links' and the bench's fresh worlds) has no open disc: its spawn's falls start together when the loading screen lifts. Nothing is saved (Point 5 (b), a per-world record, was not taken; §15.4).

### 5.4 Opening, teleporting, flying fast, the X-ray

- **Teleport and saved places** (`src/ui/world/teleport.ts:1-15`): no special rule; unseen springs at the destination start as their 3 × 3s show; seen ones are done.
- **Fast flight** (96 and 384 blocks/s, M:1711): the 6-chunk disc is about 13 chunks (208 blocks) across, so the camera crosses it in about 2.2 s at 96 blocks/s and 0.5 s at 384; reveals keep running behind the camera at the cost of their writes only; generation lag delays T0, since it waits for the 3 × 3 to show, so nothing starts before it can be seen.
- **The start screen** shows the loading backdrop, not a world (`src/ui/worldsMenu.ts:1-8`): nothing to reveal.
- **The X-ray:** while on, the terrain and water passes draw nothing (`regionBatch.ts:36-41`; `water.glsl.ts:33`), so reveals are invisible but their clocks run. X-ray walls carry the hollow's final fluid (`src/mesh/xray.ts:9-18`), so an unarrived flow already tints its walls: accepted.
- **The bench and the Chrome cells** use the defaults (`src/ui/world/flight.ts:12-14`): simulation distance 6, a fresh world, so the stream legs reveal whatever springs they cross. The reveal clock is the accumulated frame dt (§4.5), so which block of a fall is showing at a given moment of LR varies from run to run with the frame pacing; this is accepted, since G1 reads pacing, not reveal positions, and the same springs reveal over the same pose and heading in every run.

### 5.5 Edits (D7)

`markEdited(colKeys)` (`src/engine/coordinator.ts:331`, called at `src/ui/world/editPath.ts:154`) also tells the manager, which sets done every linked set referenced by the current payloads of those columns and of their 3 × 3 neighbours (so a glass or ice block placed beside a hidden flow, whose face toward fluid the edit's static remesh culls, `greedy.ts:179-182`, never leaves a hole; D30 keeps such faces only in reveal meshes), and writes all their listed quads (shows on, caps off) at most 512 quads per frame, nearest columns first; finished quads only become visible, so the order is free. The edit's remesh (`regionGrid.ts:261-266`) is requested with those offsets done, so it meshes static, and the rest follow by §4.5's static remesh. The table is unchanged (D does not rerun); a voxel a bucket fills is not in it and shows at once. In SP7c the sim continues from what is shown.

## 6. Light (D6; Point 4 (a))

L lights the final store and the mesh bakes 4 + 4 bits of light per vertex, so light is final during a reveal. Water has opacity 1 and stops the sky's fall (`light.ts:38-41`, :53-55): behind a fall that has not landed, a thin stripe reads one sky level darker. Lava emits 15 at every level (`light.ts:44-46`): the walls around an abyss lava fall glow for the whole reveal. Both are accepted: water's stripe by this spec, and lava's pre-glow by the user (Point 4 (a), "Ok a todo"), with the walls lit about 1-2.5 min (estimate) before the lava arrives. Accepting them costs nothing, keeps L's output equal to the generated world's (L1 and `DT1.light` unchanged), and needs no relight or remesh, which approach B was chosen to avoid. A shader dimming of block light inside an unarrived flow's box is not offered: it needs per-spring uniforms and is wrong near other emitters.

## 7. What the player touches during a reveal (D8)

The walk reads `fluidAt` (`src/player/walk.ts:207-211`), the eye's fog `eyeFluidAt` (`src/ui/world/frameStep.ts:28`) and aim `fluidAt` (:116), all from the final store. Each reads through a masked reader: if the voxel's column is in the manager's set of columns with listed voxels not yet arrived, a binary search of its `revealVoxels` (§4.1) decides, and a voxel whose spring is unseen or whose hop has not come reads as no fluid. Columns without an active reveal pay one `Map` lookup. The teleport's walk-snap reads `heightAt('motionBlocking')`, which counts the fall (`src/player/walk.ts:24-27`; the hand-off, `teleport.ts:15-18`): a snap onto an unrevealed fall's top lands you on it and you then fall through it, since the walk reads it as air; accepted (rare). Edits need no mask: an edit finishes the reveal (§5.5).

## 8. The simulation distance (D10)

- **The setting:** `WorldSettings.simDistance: number` (`src/ui/settings.ts:9-36`), default `MEDIUM.simDistance` = 6, normalised to an integer in [`SIM_MIN`, `RD_MAX`] = [2, 16] (a stored object without the field takes the default, with no migration, as SP7a's water tier, `settings.ts:66-82`). Stored in `localStorage` `wi.world.settings`, shared by every world of the browser, never in a save.
- **The effective value** is min(stored, effective RD), taken at use, so lowering and then raising the render distance restores the choice. RD is live in 4-16 (`src/engine/renderDistance.ts:9-10`); `SIM_MIN` 2 leaves a range (2-4) even at RD 4, and lets a slow machine keep reveals (and SP7c's sim) close; SP7c re-checks the minimum for the sim.
- **The row:** "Simulation distance" after "Render distance" in Settings › Graphics (`src/ui/settingsPanel.ts:63-81`, :165-212), offering `SIM_MIN` … the current RD, "Default (6)" (or "Default (RD)" when RD < 6), rebuilt when RD changes; live (the manager reads the effective value each frame; nothing restarts). The start screen's Settings shows it, clamped to the stored RD.
- **The preset:** `GraphicsPreset.simDistance` (`src/core/params/graphicsPresets.ts:15-32`), Medium 6; SP11 adds Low 4, High 8, Ultra 8 (M:1291), each clamped to RD, the user's setting overriding.
- **How far falls start** (Point 6 (a), the user's: Minecraft-like): a reveal starts only within the effective simulation distance (§5.2), so an unseen fall beyond it shows only its spring's notch. Raising the setting shows falls from farther away. The default stays 6.
- **Why ≤ RD is safe for SP7b:** the reveal starts only at shown columns and does no relight. For SP7c the master's "≤ RD−2" reason (the relight's 3 × 3 Published columns, M:1170) is re-argued at RD: a column inside sim ≤ RD is in the MESH set, its 3 × 3 in the L set (RD+1) and therefore Published (critic B8; `src/sim/edits.ts:334-353`).

## 9. The fluid surface (D11-D14, D25)

### 9.1 R5 (D25; Point 2 (a))

- **Definition** (S7a §6.5, S7a's D27; S7a:302): water quads on the top faces of surface voxels over the distinct surface top faces, Medium meshing, on named water regions (`test/harness/water.ts:1628-1680`; `test/metrics/render.metric.ts:46-50`, :131-136, :336-345); since SP7a's R27 item 3 the population counts a lowered top under an opaque block, the surfaces of aquifer-flooded caves under their ceilings (41.6 % of quick's counted tops, 70.3 % of its top quads, 98.5 % of them sources). Unchanged.
- **Read on the static mesh** (D21): the harness meshes with every spring done, the steady state you see once reveals end, since every column meshed during a reveal is remeshed static when it ends (§4.5). `F4.revealQuadRatio` records the revealing mesh's quads against the static's (§13.1).
- **Readings** (measured, S7a:302 reproduced by recon-surface §1.2): fast 0.7693, quick 0.5171, full 0.5605.
- **What the levers reach** (recon-surface §1.3, quick pooled; the model reads +3 % above the real mesher with the light key): L1 (§9.3) about 0.49; L2 (§9.2) about 0.27 real (model 0.299; fast about 0.46, full about 0.29); L2 + L1 about 0.26 real; plus `depth` out of the key 0.205; plus light out of the key 0.113 (fast 0.147); every occluded top culled plus every lever 0.1045. The cave-ceiling tops alone cannot go below 0.72 while drawn, and the open tops need `depth` and light out of the vertex word (bands were rejected for their colour step, rulings R26 item 1, S7a:301; merging unequal lights mis-lights a quad, Spec correction 16, S7a:300).
- **So** (Point 2 (a), the user's): SP7b takes L1 and L2, with no visible cost beyond D11. The R5 checkpoint task measures the three tiers after both, then:
  - sets the bound on quick and full to the measured reading rounded **up** to the next 0.05 (⌈reading / 0.05⌉ × 0.05); the row holds one `max` for both tiers (`tiers: ['quick', 'full']`), so it is the larger of the two rounded readings;
  - records fast without a bound;
  - moves `activeFrom` back to 'SP7b' (§15.1).
  The bound and the tier change are a LOOSEN the user approved in advance. The checkpoint stops for the user only if a quick or full reading is above 0.35. The 0.1 aim and the renderer lever go to SP11 (§17).

### 9.2 Ceiling-full (L2, D11)

- **Rule:** a water or lava **source** whose voxel above is PASS opaque with a full down face is drawn full: its top is culled exactly as a falling top is (`fluid.ts:296-301`), and its corner code is `CORNER_FULL` for its neighbours (`fluid.ts:184-189`), as for "same fluid above". `stripOf`'s "drawn full" test (`fluid.ts:208-210`) counts it, so a lower open neighbour gets a strip up to the rock, which closes the slit SP7a's R27 item 3 fixed (71161d7) from the side it was seen. Lowered **flowing** tops under rock stay drawn, so a thin stream in a 1-high tunnel does not render as a full block.
- **One function:** in `fluidRules.ts`' `surfaceHeight(byte, sameAbove)` (:77-79) the condition becomes "the same fluid or, for a source, an occluder above", so the eye's fog test and the walk agree with the mesh (a change of at most 1/9 of a block). `surfaceHeight` feeds the mesher, the eye and the walk, not the settle (S7a:277), so no generated byte changes.
- **Lockstep:** R1's brute force (its corner rule `test/harness/refs.ts:168`, its occluder rule :208-211) and `surfaceTopWaterCounts`' `lowered` (`water.ts:1641-1655`); master §4.4's face rule and its pin, as 71161d7 moved them.
- **Effect** (measured model): R5 as §9.1; about −29.6k up quads (about 59k triangles) over quick's 472 R5 columns; 281 more sloped open tops on quick where the open surface rises to meet a stepped or overhanging ceiling. Judged in shots on both tiers (`floodedCeiling` at the spot of the slit 71161d7 fixed, and a spring notch, §13.6). Not a gate change (R5 counts what the mesher draws, as R27 item 3 set), but it shrinks R5's counted population (Point 2).
- **With the caps:** a spring's source is drawn full under ceiling-full, so its strip and its cap toward the outlet voxel would coincide until the outlet arrives; §4.2 cuts the cap to the part below the strip.

### 9.3 Coplanar sloped tops (L1, D12)

Sloped tops are emitted one per voxel before `MERGE_SLICE` (`fluid.ts:332-336`). L1 gives them a merge key holding their 4 corner drops and a "sloped" flag, so `mergeSlice` merges identical drop tuples (L1a, which are necessarily along the zero-gradient axis, 91 % of the gain), and grows a rectangle further only while its corner grid stays affine with uniform light and equal `depth` (L1b). Each merge is exactly coplanar: no visual change on either tier. −9.8 % of sloped quads on quick (28,188 → 25,426), −10 % of the occluded population (measured model). `mesh.section` re-measured (§13.3).

### 9.4 Fancy's facets (M4, D13)

Fancy takes each sloped triangle's normal from `dFdx`/`dFdy` and varies Fresnel and alpha per facet (`src/render/materials/glsl/water.glsl.ts:93-99`), which makes a spill rim's steep triangles stand out (screenshot 2's light-blue triangle; recon-surface §4). On up faces (the word's `face` field), the normal becomes `normalize(mix(up, n, k))` before the ripples and Fresnel, with k a constant tuned in the shots at the user's two positions (start 0.5, range 0.3-0.7). Shader-only: no R5, triangle or vertex change; Fast is unchanged; the water program is one program with the tier uniform (S7a D28), so no relink.

### 9.5 coastFancy: the cause, corrected (D14; Point 3 (a))

M:1993 and S7a:531/1855/1861 say the coast's shape is "§6.1-§6.2's heights, corners and sloped tops". The recon read the voxels at both screenshots (recon-surface §2): the gaps are **dry voxels below the sea surface beside the sea** (`dryPitsBelowSea` reads 0.118 / 0.057 / 0.319 for default / presets / biomes on quick after settle, S7a:874), filled only at their edge by the settle's capped spill (D8 of S7a, S7a:85); the slivers are those rims' sloped tops, which the mesher draws by its rules (R1 0 / 0). The amendment (§16 item 18) corrects the text. No mesher-only fix fills a dry voxel: a corner counting solids at full height makes every shore source sloped and raises R5 (R5_COAST's open tops 0.099 → about 0.2); a dry neighbour counted as solid turns the slivers into 7/9-tall water walls, the look the user disliked at wallFront5 (recon-surface §2.3, M1-M3). SP7b gives D13 and L1 at the coast. The fill goes to SP7d, with its `GENERATOR_VERSION` bump (Point 3 (a), the user's; §17).

## 10. riverMouth (D15)

SP7a found none because its seed-'42' caves regions hold no river mouth: river flags exist only on land columns (`src/gen/column/rivers.ts:76-79`), and the nearest mouths lie outside every region (recon-surface §3). The search:
1. **A 2-D prescan** of the column field on a 4-block lattice within 2,048 blocks of spawn (`test/harness/riverMouth.ts`): riverWet points with a 4-neighbour at `offset0` < 63 and no lake, clustered 64 apart; about 5 s per seed and profile.
2. **The nearest mouth per profile:** archipelago (64, 448), 453 blocks from spawn (the default candidate); default (−628, −932), 1,124 blocks.
3. **One region** generated there, `waterExamples` (`test/harness/water.ts:928-990`) run with the **tightened predicate**: the current one (`:962-972`) also fires on plain river banks, because a river's water is wider than its nearest-corner mask; it gains "a position within 2 blocks of q has `offset0` < 63". The archipelago mouth's first hit is (91, 63, 443), a 40-wide mouth opening north into open sea: eye 17 above, pitch −60.
4. **The pose** recorded in `assets/sp7b/water.examples.json` as `riverMouth`, with a shot.
A tool run, not a CI test (one extra region, about 4 s single-threaded). Rivers at 63 are surface water: not animated.

## 11. Failure modes and review focus

- **A fall that starts into missing terrain or stalls at a column border, or where two springs' flows meet:** T0 per linked set of spring columns, gated on every member's 3 × 3 shown (§5.2); a shot sequence at an approach link; the manager's unit cases with two spring columns at different start times.
- **A region's draw lost to an out-of-range index** (Firefox validates indexed fetch): hidden quads are never literal 0 (§4.3); max(index) < vertex count asserted after every structural operation in the backends' unit tests and the spike.
- **A warm region cache reading a missing table:** `REC_REVEAL` dumped and checked (`REGION_CACHE_FORMAT` 6, §3.5).
- **A reveal that ends in a state other than the generated one:** `F4.finalBytes` and `F4.endFaces` 0; the static remesh after done is the generated mesh.
- **Standing water rippling in:** `F4.standingAnimated` 0.
- **Arrival that depends on the window or the thread:** `F4.isolated` 0; `F4.arrivalMismatch` 0 against the replay.
- **The settle changing under the two phases:** `DT1.settleReference`, `DT1.settleIsolated` 0; goldens 68/68 with `GENERATOR_VERSION` 10.
- **Index writes lost or misplaced** (BatchedMesh `optimize`, growth, RegionMesh compaction, swaps): the spike (§4.3); unit tests on both backends with a fake arena that compacts mid-reveal; a review shot of a fall during an edit nearby.
- **An open shell or a holed pool at the leading edge:** front caps (§4.2); the shot sequence. **A cap fighting a strip:** caps cut below strips; `F4.capOverlap` 0.
- **The reveal mesh left in place after a reveal:** the static remesh (§4.5), measured in LR.
- **Stutter while flying with reveals** (the Iris Xe; `docs/backlog.md:42`): `reveal.frame`; LR and every G1 cell (§13.4); levers in order: coalesce writes to one `addUpdateRange` per batch per frame; cap the reveal's own writes per frame at 512 quads, as the edits' finishing writes are from the start (§5.5), so a reveal running late by a frame never shows partial blocks; fewer caps (side caps only toward air-adjacent faces).
- **Invisible water that swims you or burns you:** the masked readers (§7); unit tests on the walk and the eye at an unrevealed voxel.
- **A hole in a leaf or a pane beside a hidden flow:** D30's cutout rule (§4.2); its unit test; `cutoutKept` recorded.
- **A replay where none is wanted** (an open, an edit): §5.3's rules; unit tests on the manager.
- **Lava's pre-glow** (accepted by the user, Point 4 (a)): the `lavaFall` shot sequence; a lava reveal over 3 min (`lavaRevealMaxS`) goes back to the user.
- **R5 higher than expected at the checkpoint:** the bound is the reading rounded up (Point 2 (a)); a quick or full reading above 0.35 stops for the user.
- **Flooded caves looking wrong at ceiling steps (L2):** the `floodedCeiling` shot on both tiers.
- **CI past 6:00:** §2's levers in order, then the user.

## 12. What is kept

SP7a's generated world entire (aquifers, springs, the settle and its bytes, the generated-fluid layer; `GENERATOR_VERSION` 10, 68 goldens); the fluid byte, the vertex words (the fluid word's layout, the solid word's lava drops in `flags`), the draw calls and passes; SP7a's mesher rules except ceiling-full for sources under rock, the sloped-top merge and, in reveal meshes only, the reveal keys, caps and kept cutout faces (D30); Fancy and Fast except the damped up-face normal; the underwater fog; the walk's fluid-height rule; buckets placing still sources; SP5b's persistence (`wi10`; the diff trailer stays empty) and every saved world unchanged (Point 5 (a)); SP5c's editing and clipboard; the X-ray and the slice.

## 13. Metrics and tests

### 13.1 F4: the natural reveal (D23)

A new id with a master row (§16 item 11), every part `activeFrom` 'SP7b', gated from its commit (by construction or measured at 0), in the caves metric's region workers beside the settle reference (`test/harness/caveRegionWorker.ts`), over the default, presets (amplified for mountain falls, floating_islands for island falls) and biomes (abyss lava falls) groups, unless stated:
- **The replay reference** (`test/harness/refs.ts`, `referenceReveal`), sharing `referenceSettle`'s work so that no second global settle runs: over a region's T dump, phase 1 is the global settle with the spring seeds withheld (the standing world); phase 2 continues from it by synchronous double-buffered rounds of `ruleOffers` from the spring seeds, each tagged with its spring column, under the settle's acceptance against the whole current state (standing included), recording the first round each voxel gains fluid and which spring columns reach it. Phase 2's fixed point is the least fixed point, so it is also `DT1.settleReference`'s reference (`settle.ts:20-21`); `referenceSettle` becomes this two-phase computation, still slow, plain and independent of D's code (SP7a's pattern), and reusable by SP7c for F1. Within a linked set the replay's simultaneous start is what the manager plays (§5.2).
- `arrivalMismatch`: spring-flow voxels of the interior whose table hop differs from the replay's round, or whose stored spring column is not the replay's by §3.2's tie-break, or that one side lists and the other not, or whose links differ; max 0.
- `standingAnimated`: listed voxels whose origin, by the reference's origins (`referenceSettleOrigins`), is not one of T's springs; max 0 (widened if D31's stretch is attempted, below).
- `finalBytes`: spring-flow voxels whose replay fixed point differs from the settled byte; max 0.
- `isolated`: one column's table (entries and links) from its own 3 × 3 window against the region-wide computation, on columns holding entries; max 0 (DT1.settleIsolated's pattern).
- `springMisses`: T's springs (`terrainSpringsDebug`) the predicate does not find, adjacent springs excluded (they are `A5.adjacentSprings`, already recorded); max 0. `springFalseHits`: the predicate's hits that are not T's springs; max 0 (§3.4).
- `truncatedColumns`: columns whose entries exceed one slot; max 0. `tableBytesMax` (worst slot use), `tableColumnsShare`, `crossColumnMeets` (voxels reached by two or more spring columns) and `lavaRevealMaxS` (the longest lava reveal, largest lava hop × 1.5 s; one over 180 s goes to the user, beyond the 1-2.5 min of pre-glow the user accepted with Point 4 (a)) recorded.
- `endFaces` (in `render.metric.ts`, on R1's spring window): R1's `hiddenEmitted` and `visibleMissing` on the revealing mesh with every listed quad in its final state (shows on, caps off); max 0. CUTOUT faces kept by D30's rule beside listed voxels of not-done offsets are not counted as `hiddenEmitted`; they go to `cutoutKept`.
- `capOverlap` (render, the same window): pairs of listed or unconditional quads that are coplanar, overlap and can be visible at the same moment (every combination of start times in the window's linked sets); max 0.
- `revealQuadRatio` and `capsPerVoxel` (render): the revealing mesh's quads over the static mesh's, worst column and pooled; caps per animated voxel; recorded. `cutoutKept` (render): CUTOUT faces kept by D30 beside listed voxels, worst column and pooled; recorded.
- **D31's stretch, if attempted:** `standingAnimated` widened, and the spill parts recorded only, with no threshold row, as D31 states. The stretch is dropped if it would turn any gated part red.
- **Cost before hosts:** the F4 task first reads `referenceSettle`'s per-region cost from the logs of runs 46070335203 and 46082054948 and the added phase-2 rounds' cost from a local run, and places the caves parts so that no quick job passes about 5:20: if quick `caves-biomes-persist` (4:49 cold, recon-obligations §2.1) would, the biomes part runs in the lighter `caves` job or on full only, recorded on quick (a new part, so no loosening).

### 13.2 R5, R1, DT1 and the re-asserted parts

- **R5** (`test/thresholds.ts:228`; `render.metric.ts:415`): parked at 'SP7c' by the first commit; after L1 and L2 the checkpoint task reads fast, quick and full, then sets the row by Point 2 (a)'s rule (quick and full at the reading rounded up to the next 0.05; fast recorded; a quick or full reading above 0.35 stops for the user) and moves it to 'SP7b' (a TIGHTEN of when); `R5.slopedShare` recorded.
- **R1:** 0 / 0 with ceiling-full in the brute force and the static mesh (caps and D30's kept cutout faces are never in a static mesh).
- **DT1:** `settleReference`, `settleIsolated` (two-phase settle; the reference now two-phase too, §13.1), `DT1.lightMismatches` (`metricTest('DT1', ['lightMismatches'])`, `test/metrics/light.metric.ts:411`); goldens 68/68 (Bun, `?selftest=1` in Chrome and Firefox).
- **L1, L3, R3, R7, E1-E6** re-asserted unchanged (light final; the diff format untouched; R7's probe unchanged, §4.1).
- **F1-F3** move to 'SP7c' and **`C7.waterWall`** to 'SP7d' (§15.1); `C7.waterWall` is still computed and written to `.out` as today.

### 13.3 P1

On the re-recorded `test/baselines.json` (§1.2), the DoD's +30 % (M:1826) on every row, the gates in force. Re-measured: `mesh.section` (gate 1.0 / 2.5 ms) on the spring window with L1, L2 and the static path, the revealing path recorded beside it; `decorate.column` (the two-phase settle and the BFS) on its region and spring window, recorded against master's 3 / 8 ms target and +30 % (a rise by design is declared at the record, as SP7a did with `BENCH_EXEMPT`, `test/bench/gates.ts:266-301`). New: **`reveal.frame`**, the manager's per-frame step over a synthetic worst case (32 revealing spring columns, 1,000 listed quads each, one arrival step for all), **gated ≤ 0.25 ms p95** (a new gate, a TIGHTEN, approved with this spec); `reveal.table` (the BFS on the spring window) recorded. Both are new `BENCH_ROWS` rows, so they need baseline entries: the bench rows' task makes a second `test/baselines.json` record (or a partial add of the two rows), with a Threshold-log line.

### 13.4 Chrome cells and the reveal leg (D24)

- **Conditions** (S7a:434, adapted, §1.3): the agent's headful Chrome on the Iris Xe; eDP-1 at 240 Hz, proved by the frame pacing gate; PRIME on-demand; load ≤ 1.0; cold shader cache; the EC check right before each run (a cap stops the run and asks the user for an EC reset).
- **Every G1, G1.enter and G2 cell** re-measured on SP7b's code into `assets/sp7b/` (the stream legs now reveal what they cross at simulation distance 6), each judged against its gate and against its OS cell of §1.4 (the same protocol, cold cache, the EC check); a cell within its gate that moves beyond the OS cell's run-to-run spread is reported in Exit evidence with its cause.
- **LR** (after LW; the leg type gains `'LR'`, `src/ui/world/bench.ts:132`; `LEG_STARTS`, `BENCH_SECONDS` and G1's cells derive from it): from LW's end, the page teleports to `BENCH_REVEAL_POSE` (a literal pinned in `bench.test.ts`, found by a scan at seed '42' near `waterfall1`: at least 2 water springs within 6 chunks, none seen by earlier legs), waits for the RD disc's refill (at most 20 s, frames not counted), then 10 s hovering facing the falls while their reveals run and 10 s flying at 96 blocks/s on a pinned heading over steep land (first visits). New G1 parts at G1's bounds (no new bound): `revealP95` ≤ 16.7, `revealOver33` 0, `revealMainP95` ≤ 6, `revealGpuMB` ≤ 150; recorded: `revealWritesPerFrame`, `revealUploadKB` (the frame's reveal `bufferSubData` bytes, worst frame), `revealRemeshes` (§4.5's static remeshes during the leg), `revealMainKB` (the manager's peak). **The worst case, recorded once:** one `--route bench` run on the Iris with the simulation distance at the render distance (12; a bench-only URL parameter added with LR), its LR parts recorded beside the default run's, not gated.
- **Firefox (RegionMesh):** the index-write path differs there (CPU index validation after each `bufferSubData`, compaction), so the user's Firefox bench run on SP7b's code at the production check (§13.6) carries LR, recorded as SP7a's Firefox cell was (`bench-iris-firefox.json`), beside §1.4's OS Firefox cell.
- **RTX** (`bench-rtx-chrome.json`): recorded once on SP7b's code if the EGL offload works (§1.3), for the user's no-stutter check; not gated (High waits for SP11).

### 13.5 Unit tests and locks

- **Unit:** the predicate on hand-built columns (each spring kind; the two-faced miss; the sky-open notch); the two-phase settle's bytes equal to the one-phase settle's on random windows and processing orders; the BFS on synthetic windows (a straight fall; a fall onto a plane; a spill down a slope with the nearest-drop choice; a fall into a standing pool; a flow into a lake's flowing rim; two springs in one column whose flows meet; two springs in different spring columns whose flows meet, with their link recorded, and two reaching one voxel at the same hop, pinning the world-key tie-break; a water/lava contact; a flow crossing each of the 12 boundaries; a spring 14 blocks from K; hops monotone along feeders, arrival(v) ≥ arrival(feeder) + 1); the packing and the slot (1,021 entries; the truncated flag; the links); `REC_REVEAL` freed with the column and reset by `clearRecord`; the region cache's dump round trip with a spring column; the mesher's reveal keys (no merge across arrivals; static merges with every offset done), the list's quad indices against the index array (lava after terrain quads in one opaque row), caps (each pair kind; both directions between offsets; strip + cap at a spring outlet under ceiling-full and at a fall's landing, the cap cut below the strip), `endFaces`; the cutout rule (D30: leaf and glass faces kept beside a listed voxel of a not-done offset, inside the column and across its border; culled as today with the offset done; an unlisted fluid neighbour still culls); the manager with a fake backend (T0 rules, linked sets starting together when one member's 3 × 3 shows late, unlinked adjacent flows at different start times with their caps decided at "now", a late link, a payload arriving after some times have passed, done and the static remesh queued one column per frame, open disc, edited columns and their 3 × 3, new world, Apply clearing the map, a column with no non-empty row counting as shown, edits, a column freed and re-entered, zero allocation); both backends with a compaction or `optimize` moving a span or geometry down mid-reveal with hidden and cap-hidden quads, max(index) < the vertex count after every operation; the masked readers; the settings' normalisation and clamping, the row's options when RD changes; ceiling-full in `surfaceHeight`, the mesher and R1's brute force; the sloped merge's coplanarity; the river-mouth predicate.
- **Arch:** the golden-builder import rule (§3.5); `SP7B_MODULES` (§16).
- **Integration:** none added (`check` is at the line, §2).
- **Locks:** thresholds (the first commit; F4's parts; R5's checkpoint; the Chrome commit), each with a Threshold-log line and this spec in the push (`test/harness/governance.ts:53-55`); `test/baselines.json` re-recorded; `test/stateIds.lock.json` unchanged (`obsidian` is SP7c's); no schema leaf added (the reveal speeds are M:1209's constants, so no U2 witness).

### 13.6 Review links, the user's check and the production check (D15)

- **Links** (`docs/superpowers/specs/assets/sp7b/water.examples.json`, mirrored in `test/tools/uiSmoke.ts` as `SP7B_POSES`): `waterfall1`-`waterfall3`, `islandFall`, `lavaFall` (SP7a's poses; each opens a fresh world, so its fall plays when the loading screen lifts; night vision suggested at `lavaFall`); `approach1` (the eye 9 chunks from `waterfall1`, facing it, outside the default simulation distance: fly toward it and watch it start at 6 chunks); `coastFancy1`, `coastFancy2` (the user's screenshots' eyes, x 432.8 y 72.7 z 13.3 and x 209.2 y 65.6 z −76.3, archipelago, seed '42'); `floodedCeiling` (the flooded cave at the spot of the slit the user saw before 71161d7, whose ceiling steps; if no such spot is recorded, one found by the harness, and a second pose there if the slit's spot is small; if it is larger than `floodedUnderSea` it also serves SP7c's larger-example item); `springNotch` (a spring's outlet under a rock ceiling, where ceiling-full's strip meets the outlet's cap, §4.2); `riverMouth` (§10).
- **Shots** (`--shots`, RD 12): a sequence of 4 frames per fall link (0, 2, 5 and 12 s after the loading screen lifts; `lavaFall` at 0, 15, 40 and 70 s), one per other link, Fast and Fancy at the coast links, `floodedCeiling` and `springNotch` on both tiers (`springNotch` also at 0 and 2 s, during its reveal).
- **Smoke:** the Simulation distance row in step with RD and live; a reveal step at `waterfall1` (a pixel column below the outlet dry at 0.5 s and water at 12 s, SwiftShader tolerance).
- **The user's check** (in the user's own Firefox on production, from the links): waterfalls falling the first time (`waterfall1`-`3`, `islandFall`), and starting as you approach (`approach1`); a lava fall in the abyss falling (and the walls' glow, accepted, Point 4 (a)); a fall you watched not falling again when you fly away and come back; the coast at the screenshots' positions (`coastFancy1`, `coastFancy2`: the pits remain until SP7d, Point 3 (a); the facets softer at Fancy); a flooded cave meeting its ceiling (`floodedCeiling`); a river mouth (`riverMouth`); the Simulation distance setting (2 to RD, live, restored after RD goes down and up). A finding the user asks to fix in SP7b is a finding before `main`.
- **The production check** (as SP7a's Task 57): on production after the merge with the user's go-ahead. Step 0, before the merge: a world saved with the camera beside a waterfall, so that after the merge it opens with that fall already complete (§5.3's open disc). Then Chrome by the agent under §13.4's conditions, with the EC CPU-cap check before it: each link with its shot sequence, `approach1` flown, an edit beside a revealing fall (it completes at once), the Simulation distance row, the saved world opened, `?selftest=1` 68/68 and "IndexedDB contract: 10/10 passed", 0 page and console errors. Firefox by the user, by hand: the same links, `?selftest=1` and one bench run (with LR), saved as `assets/sp7b/bench-iris-firefox.json`. Recorded in `assets/sp7b/production-check.json`.

## 14. CI impact

**Today:** main's merge run 46082054948 at 5:58 cold (S7a:1843 reads 5:57); SP7a's last cold runs 7:28, 6:28, 6:30; 20 parallel test jobs.

| addition | where | wall effect (estimate) |
|---|---|---|
| the CI work item (§2) | quick `region-params` and `rest`; fast `terrain`, `caves`, `surface-persist`; the sequencer | long poles to about 5:30-6:00, bound by `check` |
| the two-phase settle and the BFS in D | every region-generating job, only where a window holds a spring | +0-5 s |
| `referenceReveal` (phase 2 of a two-phase `referenceSettle`, no second global settle) and F4's caves parts | the caves jobs' region workers (default, presets, biomes groups) | below +15-60 s on jobs at 3:10-4:49 (recon-obligations §2.5's guess for a separate reference, unmeasured; sharing phase 1 removes its second settle); measured and placed by §13.1's cost rule so no quick job passes about 5:20 |
| F4's mesh parts (`endFaces`, `capOverlap`, the ratios), L1, L2 in R5 and R1 | `render` (2:07-3:45) | +0-15 s |
| the region cache's format 6 | every job restoring `regions-*` caches | one cold miss per key after the change, then 0 |
| unit tests (predicate, BFS, packing, mesher, manager, settings) | `heavy-a` (v217-269, the most room), never `rest` or `liveness` | +10-30 s |
| arch pins and the import rule | `check` | a few seconds |
| D31's stretch, if attempted (the spill pass in D, the reference's spill rounds, the spill parts) | the region-generating and caves jobs | measured; held inside the budget below, or the stretch is dropped (D31) |
| integration | none | 0 |
| liveness | none (no new leaf) | 0 |

**Budget: ≤ 6 min 0 s** on the last two cold runs before the exit commit (the exit commit is docs-only; CI's docs-only path skips the metrics jobs), 20 jobs, no sample reduction, no gate loosened. **Levers if missed:** §2's, in order; then the user.

## 15. Governance

### 15.1 The first commit: the split and the gate moves (D28)

In one commit, with this spec and its `## Threshold log` (added by this commit) in the same push:
- **Ids:** `src/core/ids.ts:11-14` the union gains `'SP7c' | 'SP7d'` after 'SP7b'; `SUB_PROJECTS` (:17-20) 26 → 28; `CURRENT_SP` 'SP7b' (:29), which must equal `currentSpOf(STARTED_SPS)` (`test/arch/sp.test.ts:14-16`); the header comment (:1-10) gains "SP7b was split on 2026-11-28 into SP7b (the water is seen falling), SP7c (the water moves when you touch it) and SP7d (the generated water fronts)".
- **`test/harness/sp.ts`:** `SP_DEPS` (:4-31) SP7b `['SP7a']`, SP7c `['SP7b', 'SP5c']`, SP7d `['SP7c']` (the user's order); SP8b unchanged, `['SP7a', 'SP8a']` (the controller's call (i), accepted by the user: the critical path is not lengthened, §16 item 20); `STARTED_SPS` (:39) appends 'SP7b' (append-only; the lock's `startedSps`, `test/thresholds.lock.json:4`).
- **What goes red when 'SP7b' is appended** (`evaluate` skips a part unless its `activeFrom` has started, `test/harness/metric.ts:43`; `coverageErrors` fails an active part with no `metricTest`, :175-185), and how each is handled:
  1. `R5.waterQuadsPerFace` (quick 0.5171, fast 0.7693, full 0.5605 against 0.1; `thresholds.ts:228`): parked at 'SP7c', a LOOSEN the user approved with Point 2 (a) ("Ok a todo"). The R5 checkpoint moves it back to 'SP7b' (a TIGHTEN of when), with quick's and full's bound set to the measured reading rounded up to the next 0.05 and fast recorded only. That bound and tier change are a LOOSEN approved in advance by the same answer, and a quick or full reading above 0.35 stops for the user.
  2. `C7.waterWall` (fast 718.9, quick 435.1 / 463.4 per km² against 3.3; `thresholds.ts:140`; `caves.metric.ts:617`): `activeFrom` 'SP7b' → 'SP7d', a **LOOSEN the user approved** (the brief: option C and the split's gate moves).
  3. F1 `convergeTicks`, `tickLogDiffs`; F2 `updatesOverCap`, `diffBytesPerVoxel`, `remeshHz`, `tickP95Ms`; F3 `idleTicks`, `idleDiffEntries`, `idleUnsettledChanged`, `ticksOutsideFront` (`thresholds.ts:254-261`; no `metricTest`, so "is active but no metricTest covers it", `metric.ts:181-183`, run by `test/arch/thresholds.test.ts:29-31`): → 'SP7c', a **LOOSEN the user approved** (the brief).
  4. The literals: `test/arch/masterSpec.test.ts:3735` (`expect(STARTED_SPS).not.toContain('SP7b')`), `test/arch/sp.test.ts:18-22` ("SP7a has started and is the current SP"), `:34-49` ("covers all 26 sub-projects", the `SP_ORDER` literal, `SP_DEPS.SP7b`), `:87-94`; `test/unit/profiles.test.ts:31-32`.
  `partChanges` marks each move LOOSEN, since `spIndex` rises (`test/harness/lock.ts:72-74`); `npm run test:accept-thresholds` (`package.json:21`) rewrites the lock; `checkGovernance` requires a `docs/superpowers/specs/` change in the push (`test/harness/governance.ts:54-55`); one Threshold-log line per change, naming each LOOSEN and its approval (SP7a's format, S7a:1873).
- **The master** (§16 items 1-6 and 20, plus the pure SP-id renames the split makes true at once: item 9's §4.11 heading and §4.12's "(SP7c)"; item 12's first sentence; item 13's "SP7c the flood (L15)"; items 14 and 16; item 15's renames, its §18 wording waiting for the exit), with every MST pin that quotes SP7b's text (recon-obligations §1c's list: :201-205, :1410-1411, :1428-1430, :1449, :2037, :2050, :2136, :2163-2164, :2195, :2516/:2533, :3412-3413, :3472-3505, :3530/:3534, :3561, :3580-3582, :3600-3601, :3623-3637, :3723-3735, :3945, :4000, :4005-4032, :4043-4045, :4140-4207, :4268-4273); every `spEntry('SP7b', 'SP8a')` (:1411, :2037, :3495, :3561, :3581, :4145, :4175, :4191) becomes `spEntry('SP7b', 'SP7c')` or moves to SP7c/SP7d, since SP7c's and SP7d's headers now sit between (`spEntry`, MST:588-594); MST:4140-4165 checks S7a §17's SP7b phrases against the union of the SP7b, SP7c and SP7d entries.
- **Comments and status lines:** comments naming SP7b for the sim (`src/persist/diffCodec.ts:9`, :15, `test/integration/caveSavedWorld.test.ts:469` "no sim until SP7b", and the like) → SP7c; `CLAUDE.md` and `README.md` status lines.

### 15.2 Locks

As §13.5: the first commit (above); F4's parts gated from their commits; R5 at the checkpoint; the G1 reveal parts with the Chrome commit; the `reveal.frame` gate with the bench rows; `test/baselines.json` re-recorded at Task 3, and recorded again (or the two new rows added) by the bench rows' task, since `reveal.frame` and `reveal.table` are new `BENCH_ROWS` rows (§13.3), with a Threshold-log line.

### 15.3 `GENERATOR_VERSION` and goldens

`GENERATOR_VERSION` stays **10** and `test/goldens.json` keeps its **68 keys** with every value unchanged (the two-phase settle writes the same bytes; ceiling-full, L1 and M4 are mesh and shader changes; the reveal table is hashed nowhere; §3.5's pins). The coast's fill and its bump are SP7d's (Point 3 (a), the user's; §17).

### 15.4 Saved worlds and settings

Nothing changes in a save (Point 5 (a), the user's): `wi10`, the diff codec and its empty trailer, the `.wiworld` format and the E rows stay. The settings object gains `simDistance`, normalised with no migration (§8). Point 5 (b)'s per-world record was not taken. It would have been a `reveal:<worldId>` key in the world's IndexedDB store and an optional `revealedSprings` field of `.wiworld`.

## 16. Master-spec amendments made with this spec

Each item lands with the commit that makes it true. The first commit lands items 1-6 and 20, plus the renames the split makes true at once (§15.1): item 9's §4.11 heading and §4.12's "(SP7c)"; item 12's first sentence; item 13's "SP7c the flood (L15)"; items 14 and 16; item 15's renames. The "as built" parts land with their work: items 7, 8, the rest of 9, 10, 11, 12's second sentence, 13's LR, 15's §18 wording (at the exit), 17, 18, 19 and 21 (at the exit). Each is pinned in a new describe 'master spec amendments (SP7b §16)' in `test/arch/masterSpec.test.ts`, with an `SP7B_MODULES` table checked against the files and a completeness test reading this section between "## 16. Master-spec amendments made with this spec" and "## 17. Notes handed to later SPs" (SP7a's pattern, S7a:507). Pins reading SP7b's text move to the new describe or to SP7c's and SP7d's lines.

1. **§10: the split paragraph** after M:1925: "SP7b was split on 2026-11-28 into SP7b, SP7c and SP7d (the user: "Sí, de acuerdo con la división y el orden"): SP7b (the water is seen falling, and the surface is right), SP7c (the water moves when you touch it) and SP7d (the generated water fronts), after the user chose option C for SP7b's scope ("Vamos con la C") and the natural reveal built by approach B ("Sí, vamos con la B"); each is testable on its own (the SP7b spec's "What was agreed", items 1-5)."
2. **§10: SP7b's entry rewritten** (M:1989-1996): `**SP7b — The water is seen falling, and the surface is right** (L; SP7a). Spec: \`2026-11-28-sp7b-water-reveal-design.md\`.` Contents: at its start, the post-Ubuntu-26.04 machine checks and baselines and the CI work item (back to 6 min 0 s: split metrics-quick (rest)'s `params.metric.ts` and `noise.metric.ts`, and metrics-fast (terrain-caves), across jobs, with a fold to keep 20 jobs; no sample reductions); the natural reveal of spring flows (water and lava), not replayed on revisit; the simulation-distance setting; ceiling-full and the sloped-top merge; Fancy's damped facets; a `riverMouth` review link. **Deliverable:** "the first time a spring comes within the simulation distance, its water (or lava) is seen falling and ends in the generated state; flooded caves meet their ceilings". Received from SP7a (its spec §17; amended by SP7a; redistributed by SP7b): R5's gate and its lever; coastFancy (its cause corrected, §9.5; the fill → SP7d, Point 3 (a)); the `riverMouth` link; the CI work item. **Exit:** "as the SP7b spec §19". **Cut line:** §18's wording.
3. **§10: SP7c's entry, new:** `**SP7c — The water moves when you touch it** (XL; SP7b, SP5c)`: M:1990's contents with "sim distance" read as the SP7b setting; **Deliverable:** "break a lake rim and watch it drain"; M:1992's "Received from SP5c" line; "Received from SP7a (via the SP7b split)": every item of M:1993 except R5, coastFancy, `riverMouth`, the CI work item and `C7.waterWall`/wallFront5; "Received from SP7b": §17's SP7c notes, with the user's decisions on finite water quoted; **Exit:** M:1994's (F1, F2, F3; DT1 with the sim's diffs; P1 tick p95 ≤ 4 ms); **Cut line:** M:1995's ("lava reactions beyond obsidian and cobblestone (→ SP12)"); **MVP line:** M:1996's, "after SP7c the app is a complete explorer and editor with caves, entrances and real water".
4. **§10: SP7d's entry, new:** `**SP7d — The generated water fronts** (size set by the SP7d spec; SP7c)`: wallFront5 and the Task 47 fronts; `C7.waterWall`'s final definition and bound (its row `activeFrom` 'SP7d'); the coast's fill (§17; Point 3 (a)); a `GENERATOR_VERSION` bump. "Received from SP7a (via the SP7b split)": the `C7.waterWall` and wallFront5 items of M:1993 with the user's quotes.
5. **§2.5** (M:405): `'SP7c'|'SP7d'` after `'SP7b'`.
6. **§6.4 rows:** F1-F3's "(SP7b: `THRESHOLDS` rows from SP7a, inactive until SP7b starts; amended by SP7a)" → "(SP7c: … inactive until SP7c starts; amended by SP7a, SP7b)" (M:1583-1585); C7's "SP7b owning its final definition and bound" → "SP7d owning …" (M:1550); A2's "(`A2.contacts`, SP7b's reactions)" → SP7c (M:1554).
7. **D18** (M:40), appended: "Generated spring flows are **revealed**, not simulated: the first time a spring's column enters the simulation distance, its settled flow (water or lava) appears voxel by voxel at the tick the flow reaches it from the spring at the sim's speeds (water 5, lava 30 ticks a step at 20 TPS), and ends exactly in the generated state. Nothing is written to the world, the goldens or the saves; standing water and its spills are never animated; a revealed spring does not replay (SP7b; the user, 2026-11-28)." If D31's stretch lands, the sentence on spills is worded at the exit as "standing water is never animated, and of its spills only the falls spilled by lakes and flooded caves are revealed, as spring flows are". §9's row M:1809 ("natural ticks + lineage bit" rejected) stays, noted "the reveal replays generated state; it is not natural ticks".
8. **§4.8** (M:1170): "(the sim distance is capped at ≤ RD−2)" → "(the sim distance is ≤ RD, a user setting; SP7c checks that a tick's 3 × 3 stays Published at the RD ring)".
9. **§4.11** (M:1207-1227): the heading "(SP7c's sim worker; edit-triggered only; D18)"; a paragraph "**The reveal (SP7b).** …" summarising §3-§5; the limits' first line → "simulation distance: a user setting from 2 to the render distance, never above it (the user, SP7b), default 6 (Medium) clamped to RD; it bounds SP7b's reveal (an unseen fall beyond it shows only its spring's notch) and SP7c's ticks". The rules' wording is reconciled with §3.14 in SP7c. **§4.12** (M:1247): "(SP7b)" → "(SP7c)". **§4.16** (M:1291): "sim distance | 4 | 6 | 8 | 8" read as the presets' defaults, each clamped to RD, the user's setting overriding (only Medium exists until SP11).
10. **§4.4 as built:** ceiling-full for sources (the face rule and the corner code); the sloped-top merge; the reveal keys in key C, the front caps and the cutout faces kept beside listed voxels (reveal meshes only; D30); §4.6 `water(tier)`'s damped up-face normal at Fancy. **§2.3:** the column record's int 14 `REC_REVEAL` (a byte-pool slot of the reveal table, or −1).
11. **§6.4 new row F4** (the natural reveal; SP7b): `arrivalMismatch`, `standingAnimated`, `finalBytes`, `isolated`, `springMisses`, `springFalseHits`, `truncatedColumns`, `endFaces`, `capOverlap` 0; recorded `tableBytesMax`, `tableColumnsShare`, `crossColumnMeets`, `lavaRevealMaxS`, `revealQuadRatio`, `capsPerVoxel`, `cutoutKept` (adjacent springs stay A5's `adjacentSprings`); if D31's stretch lands, its recorded spill parts and `standingAnimated`'s widened meaning are added at the exit. **R5's row** (M:1578): "gated from SP7b on quick and full, fast recorded (amended by SP7a, SP7b)", with the bound set at the checkpoint by the user's rule (the reading rounded up to the next 0.05; Point 2 (a)), worded at the checkpoint. **G1:** the LR parts. **R7:** "(edit/fluid remeshes, including the static remesh after a reveal, and fluid reveals inside a revealed row excluded)".
12. **§3.14** (M:948): "for SP7b's reactions" → "for SP7c's reactions". **§3.14 as built:** "the settle runs in two phases (spring seeds withheld, then added; the same fixed point), and D's step 2b records each spring-flow voxel's arrival hop (SP7b)".
13. **The bench route** (M:1445): "SP6a adds the cave scenario, SP7b the flood" → "…, SP7b the reveal leg (LR), SP7c the flood (L15)".
14. **§8:** risk 9 unchanged in text (no SP id); risk 10's "policy B needs SP7b (the sim's ticks), which also owns `C7.waterWall`'s final definition and bound, with the user's verdict …" → "policy B needs SP7c (the sim's ticks); `C7.waterWall`'s final definition and bound are SP7d's, with the user's verdict …" (M:1787); risk 15 "After SP7b" → "After SP7c" (M:1792); a new **risk 16**: "Reveal cost while flying (SP7b): index writes and caps on the main thread and the iGPU; `reveal.frame`, the LR leg and every G1 cell (the Iris Xe; `docs/backlog.md:42`)".
15. **Default receivers** (M:1833): "SP7b extra lava reactions → SP12" → "SP7c extra lava reactions → SP12", plus §18's SP7b items worded at the exit by whether each was taken. **SP12** (M:2069, M:2071): "`C7.waterWall` (→ SP7b: …)" → "(→ SP7d: …)"; "extra lava reactions (via SP7b)" → "(via SP7c)".
16. **SP7a's "Received from SP6a"** (M:1983) holds two hand-offs to SP7b, both kept as history and amended: mid-line, `C7.waterWall`'s "its final definition and bound → SP7b" → "its final definition and bound → SP7b; SP7d since the SP7b split" (pinned by MST:3530); at the line's end, "the bench's flood scenario after L13 (→ SP7b)." → "the bench's flood scenario after L13 (→ SP7b; SP7c since the SP7b split)." (pinned by MST:2164's regex `\(→ SP7b\)\.$` and MST:3534, both updated).
17. **§1** (M:158): `sim/fluidSim.ts` "(SP7c)"; `gen/fluids/` gains `reveal.ts (SP7b)`; `render/` gains `reveal.ts (SP7b)`; the test entry gains "(SP7b: the replay reference in harness/refs.ts; F4 in metrics/caves.metric.ts and render.metric.ts)". Checked by `SP7B_MODULES`.
18. **§10 SP7b's received coastFancy wording** (M:1993: "the shape is the SP7a spec §6.1-§6.2's heights, corners and sloped tops (read from the screenshots, not measured)") and S7a §17's (S7a:531: "the shape is §6.1-§6.2's heights, corners and sloped tops (read from the screenshots, not measured)"): the parenthesis "(read from the screenshots, not measured)" → "(measured in SP7b: dry pits below sea level beside the sea, `dryPitsBelowSea`, filled only by the settle's capped spill; the slivers are those rims' sloped tops; the fill needs a generator change, → SP7d)" (S7a is amended by a dated note, not rewritten).
19. **§7:** a "Measured in SP7b" line (`reveal.frame`, `decorate.column` with the two phases, `mesh.section` with L1 and L2, the LR leg).
20. **§10 critical path, parallelism, visible value** (M:2078-2082; the controller's call (i), accepted by the user with "Ok a todo"):
    - **The critical-path line is unchanged:** "… SP6b → SP7a → SP8b → …". SP7b-SP7d are not on it, and SP8b's header (M:2010) keeps "(L; SP7a, SP8a)", so the path is not lengthened. MST:370-382 holds as it is.
    - **The parallelism line:** "SP7b after SP7a (alongside SP8a/SP8b)" → "SP7b, SP7c and SP7d after SP7a, in that order (alongside SP8a/SP8b; SP7d and SP8b both bump `GENERATOR_VERSION`, and whichever merges second records from the other's push)".
    - **SP8a:** "(alongside SP4b-SP7b …)" → "(alongside SP4b-SP7d …)" (M:2080), and its header's "SP5a-SP7b" → "SP5a-SP7d" (M:1998).
    - **The MVP line** moves to SP7c's entry (item 3).
    - **Visible value:** "… water in SP7a, the water seen falling in SP7b, fluids that flow when edited in SP7c, the water fronts in SP7d".
21. **The later SPs' "Received from SP7b" lines** (at the exit, as SP7a's §17 notes became received lines, M:2005-2071): SP8c gains "Received from SP7b (its spec §17; amended by SP7b): waterfall and lava-fall emitters can start their sound at the reveal (the reveal table gives each voxel's arrival)"; SP11 gains "Received from SP7b (its spec §17; amended by SP7b): R5's renderer lever (`depth` and light sampled in the shader from per-column textures) and R5's 0.1 aim, a proposal (the user's decision, the SP7b spec's Point 2 (a)); the Low, High and Ultra presets' simulation distance (4, 8, 8, clamped to RD)". SP7c's line is item 3's and SP7d's contents are item 4's. The spills' animation is not owed (§17). If D31's stretch is dropped, the line of the SP chosen at the exit (SP7c or SP11) gains it as a note, not an obligation; if it lands, no SP receives it.

## 17. Notes handed to later SPs

- **SP7c** (everything the master called SP7b, M:1990-1996, and the brief's SP7c list): the runtime sim on `fluidRules.ts` at 20 TPS with the 8k-updates cap; permanent and finite water and draining lakes, with the user's decisions quoted in "What was agreed" item 7 ("me gusta la idea de que se pueda vaciar …"; "Capas finas que se conservan; mar y manantiales permanentes, sí"; "Elijo la B"; "Todo ok") as its rules' brief; reactions with `obsidian` appended (`test/stateIds.lock.json`, `npm run test:accept-state-ids`); the bucket, paste, cut and move ticks; the ghost drawing fluids (`src/render/ghost.ts:19`); the current's push (no code exists, critic A6); the "lagos como Minecraft" option; the trailer's ticks; the bench flood (L15) with F1, F2, F3, DT1 with the sim's diffs and P1's tick p95 ≤ 4 ms (no `BENCH_ROWS` row today, `test/bench/gates.ts:176-184`); a larger flooded-cave review example (unless SP7b's `floodedCeiling` serves); truncated fronts waking on an edit; a pasted generated waterfall flowing; policy B if ever needed; the simulation distance bounding the sim, with M:1170's 3 × 3 reason re-argued at RD; SP7b's replay reference (`referenceReveal`) reusable for F1's tick log; how the reveal and the sim meet (an edit finishes the reveals it touches, §5.5, and the sim continues from the shown state). **Owed decisions** the recon found (critic §B): a reader serving current world fluid as "proto", a contact step for reactions and a drain step (`ruleOffers` is push-only and monotone, `fluidRules.ts:8-9`, :123-134; S7a:242); whether new sources may come from non-proto sources (settle allows proto only, :291-300), and so whether a woken generated fixed point may differ from settle's; whether the distance caps 12 / 14 apply at runtime (their `dist` lives outside the byte, `settle.ts:8-13`); the tick encoding (column-local `packedPos`, 17 bits; a cross-column tiebreak in the heap key for F1's identical log; `dueOffset`'s base; flush cadence for tick-dirty columns against Firefox's 160 ms commit, `docs/backlog.md:41`; whether trailer bytes count in F2's 5 B per voxel); ticks and sim-written diffs after a terrain Apply or an older-generator open (`src/sim/diffStore.ts:5-6`; the import already drops ticks, `src/persist/wiworld.ts:116-121`); relight budgets per tick (4,096 seeds, a 3 × 3 window, `relight.ts:105`, :415) beside `relight.edit` p95 3 ms and edit → visible ≤ 50 ms p95 (M:1764); remesh granularity (a whole column, `src/mesh/column.ts:309`, against "≤ 10 Hz per section", M:1227) and the edit lane's priority −1000 (`workerPool.ts:415`); undo against moving water (`'changed'`, `src/sim/edits.ts:334`) and whether sim changes enter history; old saves' dry pockets (`test/integration/caveSavedWorld.test.ts:23`, :469) and generated contacts bursting into reactions at depth; multiplayer stays out (M:61).
- **SP7d:** wallFront5 ("en el wallFront5 todavía se nota que el agua se corta demasiado pronto cuando esperaría que siguiese fluyendo hacia abajo") and the Task 47 fronts ("quedan aceptables, anotamos para SP7b"); `C7.waterWall`'s final definition and bound (its row `activeFrom` 'SP7d'; readings fast 718.9, quick 435.1 / 463.4, full 282.3 / 279.0 per km²); the coast's fill (Point 3 (a), the user's: recon-surface §2.3's G1 aquifer rule, or G2's sea-fed rule-made sources within the cap, keeping `DT1.settleReference` and `settleIsolated` 0), with `dryPitsBelowSea`, A1, B4 and the recorded `C7.waterWall` re-read; the `GENERATOR_VERSION` bump and its golden push, ordered against SP8b's; the reveal table recomputes with the generator (no SP7b part changes meaning).
- **SP8c:** waterfall and lava-fall emitters can start their sound at the reveal (the table gives each voxel's arrival).
- **SP11:** R5's renderer lever (`depth` and light sampled in the shader from per-column textures; recon-surface §1.3) and R5's 0.1 aim (Point 2 (a), the user's); the Low, High and Ultra presets' simulation distance (4, 8, 8, clamped to RD).
- **The spills of standing water: a note, not owed, only if D31's stretch is dropped** (SP7c or SP11):
  - SP7b's committed scope shows them already flowing (the user's decision, Q2; §3.1).
  - After the approval the user asked for the falls spilled by lakes and caves to be animated too, without commitment: "Vale, intentaremos que también se animen las cascadas de lagos y cuevas. De momento sin compromiso". So SP7b attempts it as D31's stretch.
  - **If the stretch lands,** nothing is handed on. The coast's spill ramps were not asked for and stay static.
  - **If it is dropped,** it goes as a note to SP7c (if it fits the sim's own classification of standing water) or to SP11 (otherwise); the controller picks at the exit. The note carries the reason it was dropped and what was measured (`spillVoxels`, the cost, the classification's misses). It needs D31's third pass beyond D17's two phases, and F4's `standingAnimated` widened.
- **SP12:** extra lava reactions (via SP7c).

## 18. Cut line

May slip, in this order, each named in master §10's Default receivers and worded at the exit by whether it was taken:
1. **Fancy's damped facets** (D13) → SP11. The coast's facets stay as in the screenshots. **Only with the user's approval:** under Point 3 (a), which the user chose, D13 is SP7b's only coastFancy work, and coastFancy is in the brief's SP7b scope.
2. **The reveal leg LR** (D24) → SP11's performance pass. G1 with reveals is still read on every stream cell.
3. **The masked readers** (D8) → SP7c. The walk, the eye and aim read the final world during a reveal.
4. **Lava's reveal** → SP7c. Lava falls show complete, as in SP7a; water still reveals. **Only with the user's approval** (it would be Point 4 (c), which the user did not take): the brief's SP7b scope is "the natural reveal (approach B) for water and lava".

Each is cut whole. The plan builds all four unless one is cut: items 2 and 3 (this spec's proposals, approved with the cut line) by the controller, items 1 and 4 only by the user. The user chose the full L (Point 1), so the trimmed scope is not a path.

**The stretch (D31)** is outside this list and outside the 34 tasks. The controller may drop it at any point without the user, whole or in part (lava spills alone), and the user is told the outcome. It is dropped, not delayed, if the core runs late. Dropping it cuts no owed scope, and it is not named in the Default receivers; if dropped, it goes to SP7c or SP11 as a note (§17).

Not cuttable (the brief and master §10): the water reveal on both backends with its front caps, D30's cutout rule and the "not replayed" rules; the simulation-distance setting; the CI work item; the baselines and machine checks; R5's gate by the user's rounding rule (Point 2 (a)), with L1 and L2; the `riverMouth` link; F4; DT1 and the goldens unchanged; the Chrome cells.

## 19. Exit criteria

| criterion | checked by |
|---|---|
| the machine checks recorded (repos, memory, AC, PRIME, displays, load, the EC check with 26.04's healthy readings); `test/baselines.json` re-recorded with three consecutive gated passes; the OS baseline cells of f267c5f in `assets/sp7b/os-f267c5f/` (Chrome by the agent, Firefox by the user), none over its gate or each ruled by the user (§1.4) | Exit evidence; `npm run bench` |
| spring flows revealed and exact: F4's `arrivalMismatch`, `standingAnimated`, `finalBytes`, `isolated`, `springMisses`, `springFalseHits`, `truncatedColumns`, `endFaces`, `capOverlap` 0 | `npm run test:metrics:full`, CI |
| the generated world unchanged: `GENERATOR_VERSION` 10, 68 goldens unchanged (Bun, `?selftest=1` in Chrome and Firefox), `DT1.settleReference`, `settleIsolated` 0 | `git diff f267c5f -- test/goldens.json`; browsers; Bun |
| R5 on quick and full at the bound set at the checkpoint by Point 2 (a)'s rule (the measured reading rounded up to the next 0.05; a quick or full reading above 0.35 stopped for the user), `activeFrom` 'SP7b'; fast recorded; R1 0 with ceiling-full | metrics; the lock |
| L1, L3, R3, R7, E1-E6 and every other active part within its bounds; F1-F3 at 'SP7c', `C7.waterWall` at 'SP7d' (logged) | metrics; the lock |
| P1: every row within its gate and +30 % of the re-recorded baselines; `mesh.section` ≤ 1.0 / 2.5 ms; `reveal.frame` ≤ 0.25 ms p95; `decorate.column` recorded | `npm run bench` |
| no stutter: every G1, G1.enter and G2 cell re-measured on SP7b's code into `assets/sp7b/`, within its gate and judged against its OS cell (§13.4); LR's `revealP95` ≤ 16.7, `revealOver33` 0, `revealMainP95` ≤ 6, `revealGpuMB` ≤ 150; the sim = RD run recorded; Firefox recorded with LR (the user's run) | `g1.metric.ts`, `assets/sp7b/*.json` |
| the simulation distance: 2 to RD, default 6 clamped, live, restored after RD changes; on the start screen | unit tests; the smoke |
| the smoke's reveal and settings steps green | `node test/tools/uiSmoke.ts` |
| build, tests and full metrics green with SP7b's rows active | `npm run build && npm test && npm run test:metrics:full` |
| CI ≤ 6 min 0 s on the last two cold runs before the exit commit, 20 jobs, no sample reduction, no gate loosened; each run's job table recorded | GitHub Actions |
| production, headful: Chrome by the agent under §13.4's conditions with the EC CPU-cap check; Firefox by the user | §13.6 |
| the review links and shot sequences in `assets/sp7b/`, `riverMouth` included | Exit evidence; `uiSmoke.ts --shots` |
| the master amendments pinned in 'master spec amendments (SP7b §16)'; every obligation of §20 placed | `npm test` (arch); §20 |
| **the user's check:** waterfalls and an abyss lava fall seen falling the first time and not again; the coast at the screenshots' positions; a flooded cave meeting its ceiling; a river mouth; the Simulation distance setting (§13.6) | the user's evaluation |

**Not an exit criterion: D31's stretch.** Whether it lands or is dropped, no row above depends on it, and its spill parts gate nothing. Every row above must hold with it in place; if it would turn one red, it is dropped. Exit evidence records the outcome: if it landed, its recorded parts and its links; if it was dropped, the reason and the SP that receives the note (§17).

The exit commit says in `CLAUDE.md` and `README.md` that SP7b is implemented and awaits CI, the production check and the user's check; the commit after them sets SP7b complete ("docs: SP7b complete").

## 20. Where every obligation lands

Ids: O1-O50 are recon-obligations §1's rows; B1-B14 are critic §B's gaps; V1-V5 are recon-reveal §7's hard problems; S1-S3 are recon-surface §5's items; BC1-BC6 are the builder check's questions (`.superpowers/sp7b/builder-check.md`); "→ X" means handed on, with the reason.

| id | obligation | lands |
|---|---|---|
| O1 | SP7b's header (M:1989) | rewritten: §16 item 2 (L; SP7a); SP7c takes the old title, item 3; deps §15.1 |
| O2 | M:1990's contents | → SP7c (§16 item 3); "sim distance" in SP7b as the setting (§8) |
| O3 | "break a lake rim and watch it drain" (M:1991) | → SP7c's deliverable; SP7b's own: §16 item 2 |
| O4 | Received from SP5c (M:1992) | → SP7c (§16 item 3); MST:2037, :3499, :4145 moved (§15.1) |
| O5 | the runtime sim on `fluidRules.ts` | → SP7c (§17) |
| O6 | drains | → SP7c (§17; critic B1) |
| O7 | reactions and `obsidian` | → SP7c (§17) |
| O8 | the caps (12 / 14; 8k) | → SP7c (§17; critic B2) |
| O9 | sim distance | §8, D10 (the setting, bounding the reveal; default 6, Point 6 (a)); → SP7c bounding the sim; §16 items 8-9 |
| O10 | the trailer's ticks | → SP7c (§17; critic B4) |
| O11 | coalescing and the remesh throttle | → SP7c; the reveal needs no remesh (D20) |
| O12 | paste, cut and move ticks, the 8k cap | → SP7c |
| O13 | the ghost drawing fluids | → SP7c |
| O14 | the flood scenario (L15), F1's tick log, F2, F3 | → SP7c; SP7b's leg is LR (D24, §16 item 13); M:1983's "(→ SP7b)." for the flood amended (§16 item 16) |
| O15 | truncated fronts wake on an edit | → SP7c |
| O16 | the current's push | → SP7c (no code exists) |
| O17 | buckets placing flowing water (scheduling ticks) | → SP7c |
| O18 | policy B; risk 10's wording | → SP7c (not needed); §16 item 14 |
| O19 | a pasted generated waterfall flows | → SP7c (SP7b shows it static: no table entries) |
| O20 | `C7.waterWall`'s final definition and bound; Task 47's fronts; wallFront5 | → SP7d (§17, §16 item 4); `activeFrom` 'SP7d' (§15.1, the user's LOOSEN); M:1983's mid-line hand-off amended (§16 item 16) |
| O21 | R5's gate and lever | §9.1-§9.3, D25, Point 2 (a) (the bound by the rounding rule; the 0.1 aim and the renderer lever → SP11); §13.2; §16 item 11 |
| O22 | coastFancy | §9.4-§9.5, D13, D14, Point 3 (a): the fill → SP7d; §16 item 18 |
| O23 | a larger flooded-cave example | → SP7c (the brief); SP7b's `floodedCeiling` may serve (§13.6) |
| O24 | a `riverMouth` link | §10, D15 |
| O25 | the CI work item | §2, D26 |
| O26 | cut line "lava reactions beyond obsidian and cobblestone"; receivers; SP12's line | → SP7c (§16 items 3, 15); SP7b's own cut line §18 |
| O27 | the MVP line | → after SP7c (§16 item 3) |
| O28 | the exit F1-F3, DT1 sim, P1 tick | → SP7c (§15.1, §16 items 3, 6); SP7b's exit §19 |
| O29 | D18 | §16 item 7 |
| O30 | §4.11 | §16 item 9 (heading, the reveal paragraph, the limits); rules → SP7c |
| O31 | §4.12 step 2 "(SP7b)" | §16 item 9 → SP7c |
| O32 | F1-F3 rows | → 'SP7c' (§15.1); §16 item 6 |
| O33 | DT1 with the sim's diffs | → SP7c; SP7b keeps DT1's settle parts at 0 (§13.2) |
| O34 | P1 tick; the DoD's +30 % | tick → SP7c; +30 % on the re-recorded baselines (§1.2, §13.3) |
| O35 | critical path, parallelism, visible value | §16 item 20: the critical path unchanged, SP8b's dependencies unchanged, the MVP line after SP7c (the controller's call (i), accepted with "Ok a todo") |
| O36 | risk 15 | §16 item 14 |
| O37 | risk 9; a reveal risk | risk 9 unchanged; risk 16 new (§16 item 14) |
| O38 | §3.14 "for SP7b's reactions" | §16 item 12 |
| O39 | A2's row | §16 item 6 |
| O40 | SP8a's "SP5a-SP7b" | §16 item 20 |
| O41 | §1's module layout | §16 item 17; the module layout above |
| O42 | §4.4 as built | §9.2-§9.3, §4.1-§4.2; §16 item 10 |
| O43 | fluid rule unit tests (drain, reactions) | → SP7c |
| O44 | the HUD's sim TPS and tick ms | → SP7c |
| O45 | S7a's cut item 3 | delivered in SP7a; nothing moved |
| O46 | S7a §20's sim rows (O8, O10, O11, O13-O16, O26, O42, O62-O64, O71, O73, O79, O80, O90-O92) | → SP7c |
| O47 | SP7a's user check items 1-5 | 1 coastFancy: §9.5, Point 3 (a); 2 wallFront5: → SP7d; 3 flooded-cave example: → SP7c; 4 night-vision fog: SP11 (unchanged); 5 `riverMouth`: §10 |
| O48 | `SubProjectId` gains SP7c, SP7d | §15.1; §16 item 5 |
| O49 | the split paragraph | §16 item 1 |
| O50 | the brief's master amendments | §16 items 1-21 |
| B1 | runtime reader, contacts, drain; non-proto sources | → SP7c (§17) |
| B2 | runtime distance caps | → SP7c (§17) |
| B3 | items the sim cannot fix (waterWall, wallFront5, R5, coastFancy) | R5 and coastFancy's facets by the mesher here (§9); waterWall, wallFront5, the coast's fill → SP7d |
| B4 | tick encoding | → SP7c (§17) |
| B5 | Apply and older generators vs ticks | → SP7c (§17); the reveal table recomputes with D (§3.3) |
| B6 | relight budgets | → SP7c (§17); the reveal does no relight (§6) |
| B7 | remesh granularity and priority | → SP7c (§17); the reveal remeshes nothing (D20) |
| B8 | sim distance has no home in code | §8 (`WorldSettings.simDistance`, `GraphicsPreset.simDistance`) |
| B9 | undo and history | → SP7c (§17) |
| B10 | old saves' dry pockets; contacts | → SP7c (§17); comments updated (§15.1) |
| B11 | X-ray tint during flow | accepted (§5.4) |
| B12 | master pins | §15.1, §16 |
| B13 | multiplayer | out (M:61) |
| B14 | buckets "flowing water" | → SP7c (O17) |
| V1 | an exact, window-independent arrival without goldens | §3.2-§3.5, D16-D19; F4 (§13.1) |
| V2 | the GPU mechanism for both fluids | §4, D20 (index writes) |
| V3 | light is final | §6, D6, Point 4 (a) |
| V4 | "first time" without changing saves; T0 | §5, D3-D5, Points 5 (a) and 6 (a) |
| V5 | consistency with what the player touches; the bench's clock | §7, D8; §4.5; the clock is frame dt, not deterministic, accepted for G1 (§5.4) |
| S1 | coastFancy's cause corrected | §9.5; §16 item 18; Point 3 (a) |
| S2 | R5 to the user | Point 2 (a), decided; §9.1 |
| S3 | the riverMouth search | §10 |
| BC1 | approach B as built: index writes per arrival step, one static remesh per column after its reveal | Q1, accepted; D20, D21, §4.3-§4.5; cost in LR (§13.4) and `reveal.frame` (§13.3) |
| BC2 | the six Points | "Points the user decided" (Points 1-6, the recommendations) |
| BC3 | R5's bound ahead of the checkpoint | Point 2 (a)'s rounding rule, pre-approved; a quick or full reading above 0.35 stops for the user (§9.1, §15.1) |
| BC4 | the critical path and the dependencies | the controller's call (i), accepted: §15.1 `SP_DEPS`, §16 item 20 |
| BC5 | spills of standing water | Q2, the user's: not animated in the committed scope (D2, §3.1); the falls spilled by lakes and caves are D31's optional stretch (the row below) |
| Q2+ | the user's request after the approval, without commitment: "Vale, intentaremos que también se animen las cascadas de lagos y cuevas. De momento sin compromiso" | D31, an optional stretch (about 2-4 tasks, outside the 34), attempted after the core reveal, the surface work and the R5 checkpoint, before the exit docs; §3.1; F4's `standingAnimated` widened and the spill parts recorded only (§13.1); not an exit criterion (§19); the controller may drop it without the user (§18); if dropped → SP7c or SP11 as a note (§17, §16 item 21); the user is told the outcome |
| BC6 | cutout faces beside a hidden flow | the controller's call (ii), accepted: D30, §4.2; `cutoutKept` and `endFaces` (§13.1); the unit test (§13.5) |
| brief | baselines after Ubuntu 26.04 (the bench; the Chrome and Firefox cells) | §1, D27; the Firefox cell §1.4 |
| brief | "Waterfalls visible but not everywhere"; "abrupt cuts" | unchanged generation (SP7a's gates stand); the reveal ends in the generated state (F4) |

# world-imaginer-voxel — Master Architecture Design

Date: 2026-09-26
Status: Approved (brainstorming + written spec review, 2026-09-26). Moved from the world-imaginer repository (where it was drafted as project "10-voxel-sandbox") into this repository on the same day.
Scope of this document: the **umbrella architecture** of world-imaginer-voxel — "project 10" of the [world-imaginer](https://github.com/MaestreDniel/world-imaginer) lineage; both names mean this repository — its cross-cutting contracts and its decomposition into sub-projects. Every sub-project (SP0…SP12, §10) gets its own spec → plan → implementation cycle that refines the relevant sections here. Where a sub-project spec needs to deviate from this document, it amends this document explicitly.

## Context

[world-imaginer](https://github.com/MaestreDniel/world-imaginer)'s `09-density-terrain` is the reference. A headless analysis (20k+ chunks across several seeds, every claim adversarially re-verified against the code) found these root causes behind the user's pain points:

- **Predictability.** Noise seeds are `seed + k`, so humidity(seed S) is identical to temperature(seed S+1). Every field is exactly 0 at the world origin (all seeds spawn on the same Beach). The 256-entry permutation makes worlds exactly periodic (trees repeat every 640 blocks). Climate fields only span ±0.45 while splines and biome boxes assume ±1 (StonyPeaks 0 %, Mountains 0.33 %, Ocean 37 %, Birch Forest 16 %). The erosion and PV splines contribute < 1 block of sd (placebo). The biome terrain profile flattens all lowlands to y≈13 and creates border steps; terrain is effectively 2.5D (0.14 % of land columns overhang). "Surface" is derived per 16³ chunk (buried grass every 16 blocks, grass on cave floors, iron never generates, coal banded). Trees sit on the Perlin lattice with parity-derived heights; structures always sit at chunk centres.
- **Caves.** Carving strength scales with depth, leaving a sealed 15-19 block shell under the whole surface: **0 real entrances in 20,736 chunks**. With a -16..104 world and land at y≈15 the cave band is y -6..0, and every void ≤ y0 is flooded with flat opaque water. One morphology only; the noodle term never wins; lava is unreachable; cave biomes are defined but unwired.
- **Water.** An opaque solid block that you walk on and that blocks light.
- **Rendering.** 75 % of emitted quads are hidden chunk-seam faces (neighbours meshed as air), no greedy meshing, ~2.3k draw calls at RD16, chunk-local light (sky 15 in 16 % of deep cave air), Lambert sun lighting caves, flat sky, planar fog, white-noise textures, no colour management, FIFO bottom-up streaming, empty chunks as expensive as surface ones, full world teardown on any parameter change (71 s at RD16).
- **Process.** Verification was `npm run build` plus eyeballing; several silent defects survived multiple projects (iron never generated, ice never generated in 07/08, skylight leaks).

Worth keeping from 09: the 6D multi-noise box picker (matches MC's; in practice 5 axes + a constant depth), nested splines + SVG editor, the map view, uniform-driven day/night, the worker pool with transferables, vertex AO with the diagonal flip, presets with export/import, walk mode, the lake-basin idea.

## Decisions log (confirmed by the user, 2026-09-26)

| # | Decision |
|---|---|
| D1 | Project 10 is an **explorer + editing** sandbox (break/place, real-time flowing water after edits). |
| D2 | Edits persist in **IndexedDB** as per-column diffs over the generated world, multiple saves, plus **export/import** of a world file. |
| D3 | **Procedural textures** (high quality, variants) by default + loadable **resource packs**. |
| D4 | **Scalable graphics presets** Low…Ultra + **far-terrain LOD**; 60 fps at Medium on an iGPU. |
| D5 | World **y -64..319** (384 tall), sea level **63**. |
| D6 | **vitest** as a devDependency (unit + metric tests). world-imaginer 01-09 had no tests; this repository is test-gated from SP0. |
| D7 | **three r186 WebGLRenderer + custom GLSL3 ShaderMaterials**; all GLSL isolated in one module (TSL/WebGPU port seam). |
| D8 | Scope includes **rivers, cave biomes, composite (jigsaw-lite) structures, extreme terrains**. |
| D9 | Architecture: **hybrid synthesis** (typed column stage + data-driven 3D density composition, surface rules, features and structure pools as preset data; tooling-first build order). |
| D10 | **Audio is in scope**: block SFX, environmental ambience, positional 3D sources, music. **Procedural by default + loadable sound packs**. Music frequency setting: Always / Frequent / Standard / Never. |
| D11 | Hosting: Vite dev/preview, Docker, and **Vercel** (static, headers via `vercel.json`, project linked to the repository root). No header-less hosting. |
| D12 | **u16 block-state ids** (orientation states for stairs, slabs, doors, fences, logs…). |
| D13 | Rivers at sea level + elevated lakes; highland rivers fade into gorges. Mountain streams with local levels are out of scope (seam: `surfaceWaterLevel`). |
| D14 | No sculk. The deep cave biome is the project's own **Abyss**: dark stone variants, an exclusive mineral, faintly glowing dark crystals, suspense-oriented decoration and ambience. |
| D15 | A **creative block palette** (E) assigns any placeable block/state to the hotbar. |
| D16 | Reference machine for performance gates: the developer's laptop — **i7-12700H**, **Intel Iris Xe** (Medium/iGPU gate) and **RTX 3060 Mobile** (High/dGPU gate). |
| D17 | Fresh scaffold; 09 modules are ported deliberately (§1), never copied wholesale. The copyrighted C418 `.ogg` files are **not** copied into this repository. |
| D18 | Runtime fluids are **edit-triggered only**; truncated generation fronts stay frozen until an edit touches them (fallback policy in §8). |
| D19 | **Separate public repository** `MaestreDniel/world-imaginer-voxel` (default branch `main`), independent of world-imaginer, with **GitHub Actions CI** (build, `npm test`, quick metrics) on push and PR. |
| D20 | **Determinism references** (confirmed 2026-09-27): V8 (Chrome, Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari). Goldens must match bit-for-bit in all three. Every SP exit checks V8 and SpiderMonkey in the browser and JavaScriptCore through Bun (no dependency added); Safari itself is checked by hand when a Mac is available. XS and QuickJS are not references. |

D1-D20 are decisions. Metric IDs (N*, T*, B*, C*, A*, S*, O*, V*, X*, DT*, R*, L*, F*, E*, U*, P*, G*, M*, AU*, Z*) are listed in §6.4. The single letter D alone denotes the decorate stage.

## 0. Principles and scope

1. **Terrain shape depends only on climate. Biomes only classify.** Biomes choose surface blocks, features and tint; they never reshape terrain. There is no biome-driven profile and no smoothing kernel.
2. **Every stage is a pure function** of (seed, params, column), plus explicitly declared, immutable neighbour inputs. The result does not depend on generation order or on which worker ran the job, and a shuffled-order hash test proves it.
3. **One formulation, two evaluators.** Every field has a bulk (column) path and a point path. The map, LOD, teleport, probe, inspector and structures use the point path, and a batch == point test keeps them equal to the world.
4. **Exact early-outs only.** Work is skipped only when interval bounds prove the result. The probe == bulk test enforces this.
5. **No hidden constants.** Every number that shapes the world lives in `ParamSchema`, with metadata and a regeneration scope. An arch test fails on exported numeric constants in `gen/`.
6. **Every 09 pain point maps to a mechanism and to a metric ID (locked threshold) or a named unit/arch test** (section 6.5). UI-only items (CSS-grid layout) are covered by the SP visual review.
7. **YAGNI exclusions:**
   - mobs and entities, crafting, survival inventory (only a hotbar plus the creative palette);
   - ore veins, MC terrain blending, RGB light, hydraulic erosion;
   - a visual node-graph editor, and `new Function` codegen unless its kill criterion fires;
   - a downhill highland river network / mountain streams (D13);
   - sculk and other MC-signature deep-dark content (D14);
   - region editing tools (sphere fill, copy/paste);
   - WebGPU/TSL (the materials module is the seam for it), multiplayer, and the C418 music.

## 1. Module layout

```
world-imaginer-voxel/          (repository root)
  README.md CLAUDE.md .gitignore
  .github/workflows/ci.yml   npm ci → build → npm test → npm run test:metrics (quick, cached) on push and PR
  docker-compose.yml         service world-imaginer-voxel, port 5183, default compose network
  docs/superpowers/specs/ plans/   this spec and every SP spec/plan
  package.json        deps: three@~0.186.1 | dev: vite, typescript, vitest, @types/three, @types/node (tests/arch/worker_threads; amended by SP0)
  vite.config.ts      server+preview headers COOP=same-origin, COEP=require-corp; worker.format='es'; port 5183
  vercel.json         the same COOP/COEP headers for all routes (static Vercel deploy linked to the repository root)
  vitest.config.ts    projects: unit | arch | metrics-fast | metrics-quick | metrics-full | bench (amended by SP0)
  Dockerfile          node:24-slim, `npx vite --host 0.0.0.0 --port 5183` (headers from vite.config)
  index.html          CSS-grid shell (toolbar | canvas | side panel), ResizeObserver-driven; no fixed 80px
  src/
    core/                       L0 pure: no DOM, three, worker APIs, Math.random, Date.now, console.*
      constants.ts coords.ts    MIN_Y=-64, HEIGHT=384, SECTIONS=24, SEA=63; keys, voxel/quart index math, torus slots
                                (SP3a: coords.ts holds x/y/z ↔ cx/cz/sy/lx/ly/lz, voxel and column indices, colKey, sectionKey,
                                torus slot, quart coordinates and the window check, SP3a spec §1)
      hash.ts rng.ts seed.ts    fmix32, axis pre-mix, hash2/3/4, fnv1a32/64, hashF64, deriveSeed(world,name); xoshiro128** streams; seed text;
                                (SP3a) a streaming FNV-1a 64 equal to fnv1a64 over the concatenated bytes
      detMath.ts                detSin/detCos/detExp/detExp2/detErf/detSmoothstep (pinned domains; SP1 spec §1.5); the only transcendentals allowed in gen
      noise/lattice3.ts         hashed-lattice 3D gradient noise, 12 balanced edge gradients, quintic fade, no table, no period
      noise/octave.ts normal.ts cdf.ts   OctaveNoise (per-octave seed + fractional origin), NormalNoise (337/331), CDF remap
      spline/types.ts validate.ts hermite.ts tangents.ts   nested cubic-Hermite splines compiled to Int32Array code + Float64Array numbers,
                                evaluated by a zero-allocation register-file interpreter; one validator; authoring-time auto tangents
      spline/edit.ts weights.ts (SP2b) pure editor operations (insert, delete, set, nest, flatten, clamped auto tangents) and Hermite path weights
      params/kit.ts schema.ts meta.ts defaults.ts noises.ts profiles.ts presets.ts migrate.ts canonical.ts graphicsPresets.ts
                                ParamSchema = single source (types, defaults, UI, scope); defaults referenced by the schema live in core/params
                                (core cannot import gen/); graphicsPresets.ts = the §4.16 preset table as pure data (graphics + audio rows)
      stage/registry.ts hash.ts StageDef, stageHash, genKey, dirty-stage computation
    world/                      L1 (core only)
      blocks/kinds.ts registry.ts defs.ts index.ts fluid.ts light.ts   (SP3a) u16 block-state ids (<= 4096 used): property kinds
                                and codes, buildRegistry (ids, SoA per-state tables, keys, rotations, mirrors), the definitions, REGISTRY
                                and its table aliases, fluid and light bytes; states.ts, shapes.ts (shape boxes), tags.ts and fluidRules.ts
                                (rules shared by settle + sim) arrive with the SPs that need them (amended by SP3a)
      store/pool.ts columnTable.ts section.ts aux.ts epochs.ts store.ts api.ts   (SP3a) SAB store: slab pools over growable buffers
                                (pool.ts replaces slab.ts), the torus table (it holds the versions; no versions.ts), section descriptors,
                                aux slots, per-scope epoch cells; ColumnWriter/ColumnView/NeighborhoodReader; padded.ts arrives in SP4
    gen/                        L1 pure (core + world/api types only)
      context.ts                GenContext per (epoch, paramsHash): noises, splines, compiled density, biome tables, templates, LRUs
      column/climate.ts shape.ts rivers.ts lakes.ts steep.ts columnPoint.ts columnStage.ts columnCache.ts surfaceEstimate.ts spawn.ts
      map/layers.ts tile.ts palette.ts   pure map-tile painting (SP2a)
      density/expr.ts nodes.ts compile.ts bounds.ts reference.ts defaults.ts beardifier.ts
                                (SP3b: + context.ts, the DensityContext of the compiled expression and its caches, and probe.ts;
                                beardifier.ts arrives with SP9; amended by SP3b)
      caves/carvers.ts carverCache.ts
      fluids/aquifer.ts settle.ts
      biomes/registry.ts picker.ts zoom.ts
      surface/rules.ts compile.ts scan.ts defaults.ts
      features/placement.ts modifiers.ts decorate.ts priority.ts kinds/{tree,foliage,patch,simpleBlock,ore,disk,boulder,
                dripstone,glowLichen,caveVines,mossPatch,abyssCrystal,deadRoots,fossil,spring,lavaLake,freezeTop}.ts
      structures/sets.ts jigsaw.ts startCache.ts stamp.ts templates/*.ts
      pipeline/terrainStage.ts decorateStage.ts status.ts
    textures/painters/*.ts palette.ts layers.ts resourcePack.ts   pure RGBA byte painters + manifest parsing
    light/initial.ts relight.ts queue.ts           L2
    mesh/greedy.ts cross.ts fluid.ts shapes.ts packing.ts connectivity.ts lodTile.ts   L2 (packing exports PACK_LAYOUT; render/materials turns it into #defines;
                                shapes.ts meshes non-cube states, deriving fence/pane/stair connections from neighbours)
    audio/synth/*.ts                                L2 pure DSP → Float32Array (no WebAudio; node-testable, runs in workers)
    audio/soundPack.ts                              pure manifest parsing (wi10-sounds)
    audio/model/ambienceModel.ts emitterCluster.ts footstepCadence.ts musicScheduler.ts   pure decision logic used by sound/
                                and by metrics AU2-AU4 (injected clock, NeighborhoodReader-like voxel/light view)
    sim/fluidSim.ts edits.ts diffStore.ts          L2
    persist/kv.ts idb.ts memory.ts diffCodec.ts wiworld.ts saves.ts   L2 (IStorage adapter; MemoryKV for tests)
    metrics/*.ts                                    pure metric definitions shared by vitest and the in-app dashboard (SP1: noiseStats.ts,
                                sp1Fixtures.ts, sp1Goldens.ts; SP2a: columnStats.ts, sp2aGoldens.ts; SP2b: biomeShares.ts,
                                splineStats.ts, liveness.ts, crossSection.ts, also run by the workers' stats job; SP3a: region.ts
                                (fillColumnT, genRegionInProcess, regionHash) and sp3aGoldens.ts; SP3b: sp3bGoldens.ts)
    workers/protocol.ts taskHandler.ts task.worker.ts sim.worker.ts   (taskHandler: pure message handler, SP2a; SP3a: sliceJob.ts,
                                the slice job with its worker-local store and LRU; SP3b splits a slice across the workers)
    engine/                     main thread, no three
      coordinator.ts scheduler.ts rings.ts workerPool.ts throttle.ts uploadBudget.ts session.ts invalidation.ts capabilities.ts
    render/                     the only place three is imported (ui canvases are 2D; amended by SP0)
      renderer.ts sectionRenderer.ts (interface) regionBatch.ts regionMesh.ts (fallback) floatingOrigin.ts selection.ts
      materials/index.ts uniforms.ts glsl/*.glsl.ts   THE ONLY module that creates ShaderMaterial/GLSL (TSL port seam)
      lightmap.ts sky.ts clouds.ts shadows.ts textureArray.ts tintTexture.ts colormap.ts
      lod/rings.ts fillMask.ts  culling/frustum.ts caveCulling.ts
    player/fly.ts walk.ts physics.ts raycast.ts interaction.ts hotbar.ts
    daynight/dayNight.ts
    sound/                      main thread, the only place WebAudio is used
      engine.ts buses.ts        AudioContext (resumed on first user gesture), master/music/sfx/ambient buses, settings
      sfx.ts footsteps.ts ambience.ts emitters.ts music.ts reverb.ts
    ui/map/* ui/selftest/*       (SP2a) the standalone ?map page (mounted in-game from SP4) and ?selftest=1; SP2b makes ?map the editor
    ui/common/* paramPanel/* splineEditor/* biomeTable/* presets/* crossSection/*   (SP2b) shared DOM helpers, notices and shortcuts;
                                the parameter panel, spline drawer, biome table, presets tab and cross-section (pure models beside thin DOM);
                                SP3a adds the cross-section's Voxels mode
    ui/lab/* seedBox.ts          (SP1) the ?lab=noise research page; DOM-free seed-box logic
    ui/shell.ts styles.css inspector/* sliceView.ts probe.ts mapView/*   (paramPanel, splineEditor and biomeTable became directories in SP2b)
       metricsDashboard.ts jsonEditor.ts worldsMenu.ts settingsPanel.ts palette.ts hud.ts debugOverlay.ts help.ts
    main.ts
  tools/detmath-oracle.py       (SP1) CPython port of detMath, a manual oracle for the detMath goldens
  test/ unit/ metrics/ bench/ arch/ harness/{region,refs,cache,stats,flood}.ts fixtures/ tools/ (SP2b: tools/mapLatency.ts, tools/uiSmoke.ts)
        (SP3a: harness/{region,cache,png,regionWorker,fuzzWorker}.ts; SP3b: harness/densityFuzz.ts, metrics/terrain.metric.ts)
        schema-shape.lock.json (SP1) stateIds.lock.json (SP3a)
        thresholds.ts thresholds.lock.json goldens.json baselines.json
```

### Dependency rules

The authoritative layer table (value and type-only edges, worker edges, `light`/`mesh` isolation from the SAB implementation files) is in the SP0 spec `2026-09-26-sp0-scaffold-guardrails-design.md`, §"Dependency table"; the bullets below summarise it.

`test/arch/imports.test.ts` enforces these by regex-scanning imports.

- **Layer order:** `core` ← `world` ← `gen`, then `light`, `mesh`, `sim`, `persist` and `metrics` (L2). `textures` and `audio` depend on `core` only (`audio` may also import `world/blocks` for sound groups and `world/store/api.ts` types). `sound/` (WebAudio) is main-thread only and never imported by workers or pure layers.
- **Pure layers:** none of the layers above imports three, `document`, `window` or `indexedDB`. The exception is `persist/idb.ts`, which runs in the sim worker.
- **`gen/`** imports only `world/store/api.ts` types. It never imports the store implementation, so the harness runs it on plain ArrayBuffers.
- **`workers/*`** import L0-L2.
- **`engine/`** imports L0-L2 types and `workers/protocol`, and never imports three.
- **`render/`** never imports `gen/`. Only `render/materials/**` may reference ShaderMaterial, RawShaderMaterial or GLSL.
- **`ui/`** never imports `render/materials`.

### Banned APIs

`test/arch/banned.test.ts` enforces these:

- In `core`, `world` and `gen`, and in the determinism files of the next rule: `Math.random`, `Date.now`, `performance.now` and `console.*` (amended by SP2b).
- In `core/`, `gen/`, `world/blocks/**` (its ids and tables are hashed into goldens; `world/store/**` keeps only the bans of the previous rule) and the determinism files (`DET_FILES` in `test/arch/rules/banned.ts`: `metrics/sp1Goldens.ts`, `metrics/sp1Fixtures.ts`, `metrics/sp2aGoldens.ts`, the SP2b metrics shared by the tests, the workers and the UI, `metrics/splineStats.ts`, `metrics/biomeShares.ts`, `metrics/liveness.ts` and `metrics/crossSection.ts`, and the SP3a region core and goldens, `metrics/region.ts` and `metrics/sp3aGoldens.ts`): only exactly-specified `Math` members (the SP0 allowlist minus `fround`), no `**`; no `Intl`, `localeCompare`, `toLocale*`, `String.prototype.normalize`, `TextEncoder` or `TextDecoder` (amended by SP1, SP2a, SP2b and SP3a).
- In `core/noise/**`, `core/spline/**`, `metrics/**`, `gen/**` and `world/blocks/**`: imported value bindings are referenced only through top-level `const` aliases (vitest's transform turns them into getters; amended by SP1, SP2a and SP3a).
- Exported numeric consts anywhere in `gen/` (fixed world constants live only in `core/constants.ts`).
- Anywhere in the repository: no `.ogg`/`.mp3`/`.wav` files (sound packs are user-supplied, D17) and no import specifier resolving outside the repository (no copy-forward imports from world-imaginer).

### Deliberate ports from 09

These are rewritten against new tests. Everything else is written fresh:

- the AO rule and diagonal flip (`mesher.ts`);
- the interval-distance box fitness (`biomeBoxes.ts`), with ties broken by priority;
- the SVG interaction skeleton of `splineEditor.ts`, re-targeted to nested Hermite splines;
- the uniform-driven day/night concept, with phases re-derived;
- the `walkController.ts` skeleton, rewritten as swept collision;
- the progressive-tile idea of the map view, moved to workers;
- the warped-Voronoi lake basins, redesigned in 3.5.

## 2. Data model

### 2.1 Coordinates and keys

- **World coordinates:** x and z are integers; teleport is clamped to ±500,000 blocks. y ∈ [-64, 319].
- **Indices:** `cx = x>>4` and `sy = (y+64)>>4`. The voxel index inside a section is `ly<<8 | lz<<4 | lx`. Quarts are `qx = x>>2` and `qy = (y+64)>>2`, giving 96 vertical quarts.
- **Column key:** `colKey = (cx+32768)*65536 + (cz+32768)`, a plain number below 2^32. The section key is `colKey*32 + sy`. No string keys are used anywhere.
- **Loaded-column table:** a torus of W = 64 ≥ 2·(24+5)+1 = 59 (RD ≤ 24 plus the unload margin of 5, with slack for teleport prefetch; a power of two so `mod` is `& 63`). `slot = (cx & 63) + 64*(cz & 63)`, and each record stores cx and cz for validation.
- **Directions and faces** (amended by SP3a): north = −z, south = +z, east = +x, west = −x, up = +y. A clockwise quarter turn seen from +y maps a horizontal offset (x, z) to (−z, x): north → east → south → west → north. A face index i ∈ 0..5 follows the `facing6` order: 0 north, 1 east, 2 south, 3 west, 4 up, 5 down; `FULL_FACES` bit i is face i and `FACE_TEX[state·6 + i]` is face i's texture.
- **Terminology:** a *column* (also *chunk*) is one 16×16 block footprint over the full height; a *section* is 16³; a *render region* is 8×8 columns (§4.5); a *structure region* is a spacing cell (§3.13); a *harness region* is a rectangle of columns whose size each metric states (default 32×32).
- **Rendering precision:** a floating render origin snaps to 512 blocks and rebases once the camera is more than 1024 blocks away.

### 2.2 Block registry and voxel encoding

**Block state id (u16, D12).** The registry declares *block types*; each type declares its **intrinsic properties** and the registry assigns contiguous state ids per type (a global palette, as in MC):

| property | values | used by |
|---|---|---|
| `axis` | x / y / z | logs, basalt-like pillars |
| `facing` | n / e / s / w (4) or +up/down (6) | stairs, doors, trapdoors, wall torches, ladders, furnace-like blocks |
| `half` | bottom / top | stairs, trapdoors, double plants, doors (slabs use only `slabType`) |
| `open` | false / true | doors, trapdoors, fence gates |
| `hinge` | left / right | doors |
| `slabType` | bottom / top / double | slabs |

- **Connection-derived shapes are not stored.** Fence/pane connections and stair inner/outer corners are computed by the mesher (and collision/raycast) from neighbours, so edits never need neighbour state updates.
- Waterlogging is not a property: it is the separate fluid byte.
- **Append-only ids.** State ids are assigned append-only: `test/stateIds.lock.json` records every `(typeName, props) → id` ever published, and a unit test fails if an existing entry changes (new types and props only append: new types with their full property sets append, and a locked type never gains a property or a value; a variant that needs one is a new type, and `withType` converts between them; amended by SP3a). Each `worlds` record stores `stateTable` (the mapping at save time); load and import remap diffs through it (hotbar slots are stored by type name, §4.12); states whose type no longer exists become AIR, with a warning showing the count.
- A per-type `PLACEABLE` flag and a `category` (from `tags.ts`) drive the creative palette.
- A test asserts at most **4096 used states** (`MAX_STATES`); per-state SoA tables are sized to it. `STATE_TYPE: Uint16Array` maps state → type; `stateOf(type, props)`, `propsOf(state)`, `withProp(state, prop, v)` and `withType(state, type)` (keeps the props both types share, defaults the rest; used by per-biome structure palettes) are pure table lookups; `rotateState(state, quarterTurns)` and `mirrorState` serve structure pieces and placement.

Per-state SoA tables:
- `OPACITY`: 0 transparent, 1 filters sky (leaves, ice, water), 15 opaque;
- `PASS`: none / opaque / cutout / translucent;
- `SHAPE`: none (air; amended by SP3a) / cube / cross / fluid / pointed / **box model** (index into `SHAPE_BOXES`, a per-state table built at registry init by transforming the model's canonical boxes — facing north, half bottom, closed, hinge left — by the state's props; connection-derived models store one box list per variant: fence and pane 16 arm masks, stairs straight / inner-left / inner-right / outer-left / outer-right). The 11 models: slab, stairs, door, trapdoor, fence, fence gate, pane, torch, wall torch, lantern, ladder;
- `FULL_FACES` (6-bit mask of faces that fully occlude a neighbour; drives face culling and light blocking for partial shapes). For connection-derived models it is the intersection over all derived variants (stairs: only the full half face, i.e. down for half=bottom and up for half=top; fences, panes and fence gates: 0), so culling never depends on a neighbour's neighbours;
- `EMIT` (0-15), `CARVABLE`, `REPLACEABLE`;
- `COLLIDE`: none / cube / boxes (`boxes` uses `SHAPE_BOXES`, except that fence and closed fence-gate posts extend to 1.5 blocks; torches, wall torches, lanterns, cross, pointed, ladders and open fence gates are none);
- `FLUID_MODE` (shared by settle, the sim and the fluid mesher): `block` (fluid never enters: full solids, double slabs, doors), `hold` (keeps its state and takes the fluid byte: kelp, seagrass, leaves, slabs, stairs, fences, fence gates, panes, trapdoors, ladders), `displace` (flow replaces it with AIR plus fluid: torches, lanterns, plants, snow layers);
- `TINT`: none / grass / foliage / water / fixed;
- `SOUND`: sound group (none, stone, dirt, grass, sand, gravel, wood, snow, glass, leaves, metal, abyss) used by `audio`/`sound`; none is air's and is never played (amended by SP3a).

`FACE_TEX` is a `Uint16Array(MAX_STATES*6)` of base texture-array layers. This splits 09's overloaded `solid/transparent` into render pass, light opacity, face culling (opaque full faces only) and collision:
- water: pass translucent, opacity 1, no collision;
- glass: cutout;
- leaves: cutout with opacity 1;
- slabs/stairs: opaque pass, OPACITY 0, culling via `FULL_FACES`. **Light never crosses a face that is set in `FULL_FACES`** of the voxel it leaves or of the voxel it enters — in the initial BFS, the straight-down sky fall, incremental relight and the L1/L3 reference BFS. The sky fall enters a voxel unless its up face is full and stops below a voxel whose down face is full; `LIGHT_BLOCKING` is defined the same way. `slabType=double` is a plain full cube (SHAPE cube, OPACITY 15, FULL_FACES 63).
- **Until SP8a** box-model states use SHAPE cube and FULL_FACES 63, and `COLLIDE: boxes` falls back to cube; OPACITY and `COLLIDE: none` (torches, ladders, …) already have their final values.

**Encoding details** (amended by SP3a; SP3a spec §2.1-2.3, frozen from SP3a):
- **Property kinds and values**, in kind order: `axis` (x, y, z), `facing4` (north, east, south, west), `facing6` (north, east, south, west, up, down), `half` (bottom, top), `open` (false, true), `hinge` (left, right), `slabType` (bottom, top, double). A property's code is its value's 0-based index.
- **Enum codes:** every enum table stores the 0-based index of its value in the order written above: `PASS` none 0, opaque 1, cutout 2, translucent 3; `SHAPE` none 0, cube 1, cross 2, fluid 3, pointed 4, box 5; `COLLIDE` none 0, cube 1, boxes 2; `FLUID_MODE` block 0, hold 1, displace 2; `TINT` none 0, grass 1, foliage 2, water 3, fixed 4; `SOUND` none 0, stone 1 … abyss 11.
- **Id order:** type and state ids start at 0 in definition order; a type's states are contiguous with the default first. With the property combinations numbered in mixed radix (properties in declaration order, values in kind order, the last property fastest), combination k of a type whose default is d takes id `base + (k = d ? 0 : k < d ? k + 1 : k)`, and `DEFAULT_STATE[type] = base`.
- **Canonical key:** the bare type name for a type without properties; otherwise `name[p1=v1,p2=v2,…]` with every property in declaration order, defaults included, no spaces, each value spelled as its kind value name. Keys are ASCII and unique, and `parseStateKey(stateKey(s)) = s`; the lock and `stateTable` use them.
- **`withType(state, type)`** keeps a property only when the target declares one with the same name and kind; every other property takes the target's default. **`rotateState(state, q)`** turns clockwise seen from +y by ((q mod 4) + 4) mod 4 quarter turns: horizontal `facing4`/`facing6` values step north → east → south → west, up and down stay, `axis` swaps x ↔ z on odd turns. **`mirrorState(state, 'x' | 'z')`** negates that axis (x: east ↔ west; z: north ↔ south), keeps up and down and flips `hinge`. `half`, `open` and `slabType` never change under either.
- **The table set only grows:** later SPs add block types, the per-state values of new states and new tables (`PLACEABLE` and `category` in SP5, `SHAPE_BOXES` in SP8a); an existing table never changes its encoding.

**Fluid byte (u8).**

| bits | meaning |
|---|---|
| 0-2 | level (0 = source … 7) |
| 3 | falling |
| 4-5 | type (0 none, 1 water, 2 lava) |
| 6 | `unsettled` (a truncated generation front) |
| 7 | reserved |

A pure fluid voxel is AIR plus a fluid byte. Waterlogging comes free: a state whose `FLUID_MODE` is `hold` plus a fluid byte. Effective opacity is `max(OPACITY[b], fluid?1:0)`, and lava emits 15.

**Light byte (u8):** `sky<<4 | block`.

### 2.3 SharedArrayBuffer store (`world/store`)

**Slabs.** Two slab pools share one allocator implementation parameterised by slot size: the **block pool** (8 KiB slots, one u16 per voxel) and the **byte pool** (4 KiB slots, for light, fluid and the two aux slots). Each pool's slots live in **one growable buffer** (amended by SP3a): a `SharedArrayBuffer` created with `maxByteLength` (default 768 MiB for blocks, 512 MiB for bytes: reserved address space, not committed memory), or, with the same code, a resizable `ArrayBuffer`. A slot id is the slot's index in its pool.
- Allocation uses an Int32 free stack per pool in a growable buffer, guarded by a CAS spinlock whose critical section is about 10 instructions. Workers allocate and free slots themselves.
- Whichever thread finds the free stack empty grows its pool by 1 MiB (128 block or 256 byte slots) inside the same lock; length-tracking views see the growth in every thread, so there is no page broadcast (amended by SP3a). A pool at its maximum throws `StoreFull`.
- A per-slot `Int32Array` refcount (Atomics) lets proto and final section sets share unmodified slots. Every non-negative descriptor entry and every allocated aux slot holds one reference; one free per reference.

**Final section descriptor**, 4 × int32 per section:

| field | encoding |
|---|---|
| blocks | block-pool slot ≥ 0, or `-1-uniformStateId` |
| light | slot, or `-1-uniformByte` (all 0 in sealed rock and dark caves, all 0xF0 in open sky) |
| fluid | slot, or `-1-uniformByte`; -1 is "no fluid" (byte 0), so a full water section of an ocean costs no slot (amended by SP3a) |
| meta | bits 0-12 nonAir (0-4096), 13 hasOpaque, 14 hasCutout, 15 hasTranslucent (any voxel whose `PASS` is that pass), 16 hasFluid (any fluid type ≠ 0), 17-31 face-to-face connectivity (0 until SP4) (amended by SP3a) |

Each channel is stored on its own: uniform when every value of that channel is equal (no slot), dense otherwise; rewriting a descriptor releases what it held. Unwritten descriptors are −1 (uniform air, light byte 0, no fluid). The connectivity bits and `padded.ts` are SP4's (amended by SP3a).

**Proto section descriptor**, 2 × int32: blocks and fluid. This is the pre-decoration state (terrain, aquifer, surface rules, carvers). It is immutable once T finishes.

**Column record** (160 × int32 = 640 B; the 64² torus is about 2.6 MB):

| ints | fields |
|---|---|
| 0-3 | cx, cz, `status` (Atomics: 0 Absent, 1 Proto, 2 Decorated, 3 Published), `epoch` |
| 4-5 | `blockVersion`, `lightVersion` (Atomics.add on every committed change) |
| 6 | protoFlags (alive, pinnedByTuning) |
| 7-8 | auxSlotA, auxSlotB |
| 9-10 | unsettledCount, diffFlag |
| 11 | `claimed` (Atomics: 0 free, 1 held; claiming a held record throws `SlotBusy`, and a read of a record that holds another column returns absent; amended by SP3a) |
| 16-111 | final descriptors |
| 112-159 | proto descriptors |

**Aux slot A (exactly 4 KiB):**
- proto heightmaps `WORLD_SURFACE_WG` and `OCEAN_FLOOR_WG` (Int16[256] ×2);
- final heightmaps `WORLD_SURFACE`, `MOTION_BLOCKING`, `OCEAN_FLOOR` and `LIGHT_BLOCKING` (Int16[256] ×4);
- `surfaceBiome` Uint8[256], taken after the Voronoi zoom;
- `tintTH` Uint8[3·256]: T, H and an override per block.

Byte offsets (amended by SP3a): `WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WORLD_SURFACE` 1024, `MOTION_BLOCKING` 1536, `OCEAN_FLOOR` 2048, `LIGHT_BLOCKING` 2560, `surfaceBiome` 3072, `tintTH` 3328; per-position arrays use the column index `lz·16 + lx`, and Int16 values are little-endian. A heightmap value is the absolute y of the highest qualifying voxel plus one, −64 when none qualifies: `WORLD_SURFACE_WG` and `WORLD_SURFACE` count a state ≠ air or a fluid type ≠ 0; `OCEAN_FLOOR_WG` and `OCEAN_FLOOR` count `COLLIDE` ≠ none (the fluid byte is ignored); `MOTION_BLOCKING` counts `COLLIDE` ≠ none or a fluid type ≠ 0; `LIGHT_BLOCKING` follows the §2.2 light rule, pinned by SP4.

**Aux slot B:** `caveBiomeQ` Uint8[4·96·4 = 1536] at 0 and `surfaceBiomeQ` Uint8[16] at 1536 (offsets amended by SP3a). The index orders are `surfaceBiomeQ[qz·4 + qx]` (the quart's 2D biome before the zoom) and `caveBiomeQ[(qy·4 + qz)·4 + qx]` with `qy = (y + 64) >> 2`; SP3b's T writes `surfaceBiomeQ` and leaves `caveBiomeQ` 0 until SP6 (amended by SP3b; the SP3b spec §4). Both aux slots are zero-filled when allocated (a recycled slot included), so a field no stage has written reads 0.

**Epoch cell.** A SAB `Int32Array` epoch cell per scope is checked by workers between phases, so a job can abort mid-run. SP3a builds the per-scope cells (terrain 0, decorate 1, light 2, mesh 3); SP4 wires them in place of SP2b's pool-wide cell (amended by SP3a).

### 2.4 ColumnSample (worker-local LRU of 1024, not in the SAB)

- **Lattice:** a 7×7 quart grid, the column's 5×5 quart corners plus a one-quart halo for gradients.
- **Raw climate** (kept separately so a spline edit re-derives shape without resampling noise): `C E W T H R` (uniform on [−uMax, uMax], uMax = 0.9973), `PV`.
- **Derived fields:** `offset, sigma, jag, riverDist, riverStrength, lakeMask, lakeLevel, lakeFloor, surfaceWaterLevel, steep, surfaceEst, islandMask`, and `surfaceBiomeQ[49]`.
- **Size:** about 6.5 KB.
- **Readout:** fields are bilinear between quart points, so values at 4-aligned corners are exact and every column sharing a corner computes it identically.

### 2.5 Key TypeScript types

```ts
type Seed64 = readonly [lo: number, hi: number];   // u32 words, value = hi·2^32 + lo, normalised with >>> 0 (SP1); Hash64 alike
type RegenScope = 'live' | 'remesh' | 'decorate' | 'terrain' | 'climate';
type SubProjectId = 'SP0'|'SP1'|'SP2a'|'SP2b'|'SP3a'|'SP3b'|'SP3c'|'SP3d'|'SP4'|'SP5'|'SP6'|'SP7'|'SP8a'|'SP8b'|'SP8c'|'SP9'|'SP10'|'SP11'|'SP12';
type StageId = 'climate'|'shape'|'surfaceEst'|'biome2d'|'terrain'|'decorate'|'light'|'mesh'|'lod'|'map';
interface ParamMeta { path: string; label: string; doc: string; unit?: string;
  kind: 'number'|'int'|'bool'|'enum'|'noise'|'spline'|'expr'|'boxTable'|'ruleTree'|'featureList'|'structureSets';
  min?: number; max?: number; step?: number; options?: readonly string[]; dims?: 2|3; coords?: readonly SplineCoord[];
  scope: RegenScope; stage?: StageId /* present exactly when scope !== 'live' (SP1) */; effectMetric?: MetricId; }
interface StageDef { id: StageId; version: number; reads: StageId[]; params: string[] /* path prefixes */;
  checkpoint: 'columnSample'|'proto'|'final'|'none'; }
// stageHash = fnv1a64(`${id}|${version}|${canonicalJSON(slice)}|${reads.map(r => hex64(H[r])).join(',')}`) (SP1 spec §5)
interface NoiseDef { wavelength: number; octaves: number; persistence?: number; lacunarity?: number; amplitudes?: number[] | null;
  yScale?: number; double?: boolean /* default true */; remap?: 'none'|'uniform'; clampSigma?: number /* default 3 */ }
// Validated params always hold the complete NoiseDef (persistence 0.5, lacunarity 2, amplitudes null, yScale 1, double true,
// remap 'none', clampSigma 3); only patches may be partial (SP1).
interface SplinePoint { x: number; y: number | NestedSpline; d: number }   // d = dy/dx per unit of the node's coord (explicit data)
interface NestedSpline { coord: 'C'|'E'|'W'|'PV'|'T'|'H'; points: SplinePoint[] }
type ColField = 'C'|'E'|'W'|'PV'|'T'|'H'|'offset'|'sigma'|'jag'|'riverStrength'|'lakeMask'|'lakeFloor'|'islandMask';   // islandMask = the §3.15 cluster mask m (0 outside floating_islands), a derived ColumnSample field
type Expr =                                  // 3D density composition (preset data), ~22 node types
  | { op:'const'; v:number } | { op:'y' } | { op:'col'; f:ColField }
  | { op:'noise'; name:string } | { op:'noise2'; name:string } | { op:'beard' }
  | { op:'add'|'mul'|'min'|'max'; a:Expr; b:Expr }
  | { op:'neg'|'abs'|'square'|'cube'|'halfNeg'|'quarterNeg'|'squeeze'; a:Expr }
  | { op:'clamp'; a:Expr; lo:number; hi:number } | { op:'smoothstep'; a:Expr; e0:number; e1:number }
  | { op:'yGrad'; y0:number; v0:number; y1:number; v1:number }
  | { op:'rangeChoice'; input:Expr; lo:number; hi:number; inside:Expr; outside:Expr }
  | { op:'intervalSelect'; input:Expr; edges:number[]; cases:Expr[] }
  | { op:'rarityScaled'; noise:string; rarity:Expr; edges:number[]; coordScale:number[]; valueScale:number[] }
  | { op:'interpolated'; a:Expr }            // subgraph evaluated at 4x8x4 corners + trilerp
  | { op:'tap'; name:string; a:Expr; mute?:number }   // named intermediate for inspector/probe/mute
  | { op:'ref'; id:string };
// SP3b implements const, y, col, noise2, noise, add, mul, min, max, neg, abs, square, clamp, slide (x · a piecewise linear s(y)),
// interpolated, rangeChoice, tap and ref, with the field names of its spec §1.1 (col.field, noise.id, the child of a one-child op
// is x, slide.knots: [y, v][], ref.name); the other ops arrive with the SPs that need them (amended by SP3b).
interface CompiledDensity { cornerFn(ctx, x:number, y:number, z:number): number; voxelFn(ctx, i:number, interp:Float64Array): number;
  boundsCell(ctx, cellX:number, cellY:number, cellZ:number): [number, number]; point(x:number, y:number, z:number, tap?:string): number; }
// SP3b's compileDensity(expr, noises) emits columnFn, positionFn, cornerFn, voxelFn and tapFn closures over its own typed scratch;
// the cell bounds live in bounds.ts and the point evaluation in probe.ts (the SP3b spec §2; amended by SP3b).
// From store.claimColumn(cx, cz, epoch) (amended by SP3a; SP3a spec §3.5). Each setter copies its 4096-entry arrays.
interface ColumnWriter { setProto(sy:number, blocks:Uint16Array, fluid:Uint8Array): void;
  setFinal(sy:number, blocks:Uint16Array, light:Uint8Array, fluid:Uint8Array): void;
  shareFinal(sy:number, light:Uint8Array): void /* final blocks and fluid share the proto slots */;
  aux(): AuxView; auxB(): AuxBView; commit(status: 1|2|3): void /* blockVersion += 1, then status last */ }
interface ColumnView { block(lx:number, y:number, lz:number): number; fluid(lx:number, y:number, lz:number): number;
  light(lx:number, y:number, lz:number): number; sectionBlocks(sy:number): Uint16Array|number; sectionFluid(sy:number): Uint8Array|number;
  aux(): AuxView | null; auxB(): AuxBView | null /* null when the column has no such slot; auxB amended by SP3b */ }
interface NeighborhoodReader { proto(dx:number, dz:number): ColumnView | null; final(dx:number, dz:number): ColumnView | null;
  versions(): Int32Array /* 3x3 in (dz, dx) order, blockVersion then lightVersion, -1 when absent */ }
interface SectionMesh { secKey:number; pass:0|1|2; quads:number; position:Uint8Array /*Uint8x4*/; data:Uint32Array; index:Uint32Array;
  bounds:[number,number,number,number] /*sphere*/; seq:number; versions:Int32Array /*3x3 block+light*/;
  emitters?: Float32Array /* audio candidates: kind, x, y, z, strength (§4.18) */ }
interface MetricDef { id: MetricId; run(region: RegionView): Record<string, number> /* value per threshold part */; scope:'column'|'voxel'|'render'|'audio' }
// Thresholds and per-part activeFrom live only in the locked test/thresholds.ts (SP0); SubProjectId and MetricId are declared in src/core/ids.ts.
```

### 2.6 Byte budgets

| item | size |
|---|---|
| non-uniform section channel | blocks 8 KiB (u16); light 4 KiB; fluid 4 KiB |
| column record + aux | 0.64 + 8 KiB |
| typical final column (~13 block + ~5 light + ~1.5 fluid slots + aux) | ≈ 138 KiB (104 + 20 + 6 + 8) |
| extra proto slots (sections D modified, mostly ore-bearing; ~7 block + ~1.5 fluid slots) | ≈ 62 KiB, kept only in the outer rings RD+2..RD+3 (≈ 11.5 MB at RD12), or everywhere in tuning mode (+≈ 45 MB at RD12) |
| SAB store at RD12 / RD16 / RD24 (T ring = RD+3: 755 / 1195 / 2376 columns) | ≈ 115 / 180 / 350 MB (≈ +55-60 % vs a u8 store; ≈ +20 % of total app memory) |
| SAB store worst case inside the RD+4..RD+5 unload hysteresis (962 / 1452 / 2734 columns) | ≈ 145 / 213 / 390 MB |
| vertex | 8 B: `position` Uint8x4 + `data` uint32 |
| quad, indexed | 56 B (4 × 8 B + 6 × Uint32 index, since BatchedMesh copies per-geometry indices) |
| terrain GPU at a median of 1500 quads per column (assumption; R4 permits up to 2000, which would raise these rows by 33 %) (RD12 / RD16 / RD24 meshed: 491 / 855 / 1886 columns) | ≈ 41 / 72 / 158 MB, ×1.3 reservation slack, plus the same again as the CPU copy BatchedMesh keeps |
| texture array (16 px, ≈ 320 layers incl. variants and frames, mips) | ≈ 0.45 MB (1.8 MB at 32 px) |
| tint texture (RGBA8 1024² torus) / fill mask (R8 64²) / lightmap (16² RGBA8) | 4 MB / 4 KB / 1 KB |

### 2.7 Edits, saves, export, presets, session

**Diffs.** Diffs hold **absolute final states** per voxel (block state u16, fluid u8), never deltas. The sim worker's `DiffStore` is authoritative: `Map<colKey, Map<sy, Map<voxelIdx, u32 = state<<8 | fluid>>>>`. On a voxel's first edit its generated value is remembered, so reverting removes the entry.

`ColumnDiffV1` codec, per column:
- header `{v:1, genKey:u32x2, sections:u8}`;
- per section `u8 sy, u8 fmt, u16 n`:
  - fmt 0 (sparse): n × `{u16 idx, u16 state, u8 fluid}` (5 B);
  - fmt 1 (dense, used when n ≥ 2560): a 512 B edit bitmask, then 8192 B of states and 4096 B of fluid; voxels outside the mask are not edits;
- trailer: a u16 count, then pending runtime fluid ticks `{u32 packedPos, u16 dueOffset}`.

Sparse entries are sorted by idx, sections by sy, and trailer ticks by packedPos, so encoding is canonical. All multi-byte integers in ColumnDiffV1 and `.wiworld` are **little-endian** (DataView calls pass `littleEndian = true`). Block-state ids follow the append-only rule of §2.2, and every save and export carries its `stateTable`.

**IndexedDB `wi10` v1:**
- `worlds`: `{id, name, seedText, seed, params, paramsHash, generatorVersion, genKey, created, updated, flushSeq, player:{pos,yaw,pitch,mode}, hotbar, stateTable, time}`;
- `diffs`: key `[worldId, colKey]`;
- `packs`: resource-pack and sound-pack blobs plus manifests, with `kind: 'textures'|'sounds'`;
- `presets`;
- `meta`.

`genKey = fnv1a64(utf8(`${GENERATOR_VERSION}|${seed[0]}|${seed[1]}|${hex64(stageHash('decorate'))}`))` (seed words as decimal u32, lo first; `hex64` = 16 lower-case hex digits, hi first), where the decorate stageHash covers exactly the decorate-, terrain- and climate-scope params (§5.1). Live and Remesh params never affect genKey. A save is valid only for its genKey.

**Fork dialog.** It appears (a) on opening a world whose stored genKey differs from the one recomputed with the current GENERATOR_VERSION, and (b) on the first Apply of a decorate-, terrain- or climate-scope change in a world that has diffs. Auto-apply is suspended until the user answers, and the choice holds for the rest of the session. Options:
1. **Fork:** a new world id with the new genKey and no diffs; the original save is untouched.
2. **Rebase:** a new world id with the new genKey and a copy of the diffs (absolute states, remapped through `stateTable`); entries equal to the newly generated value are dropped at the next D.
3. **Read-only:** the original save rendered with the current generator and its diffs, never flushed, with export offered.
4. **Cancel:** reverts the pending param change (case b) or returns to the worlds menu (case a).

During development this dialog is expected often, since every SP changes the generator.

**Export `.wiworld`.** A gzip `CompressionStream` over:
- `"WI10"`, `u32 version`, `u32 headerLen`;
- header JSON: the world record, the full params and the block-state table `(typeName, props) → id`;
- records `i32 cx, i32 cz, u32 len, bytes`.

Import validates the magic and version, runs `migrate`, recomputes genKey, and creates a new world id.

**Presets.** Format `{format:'wi10-preset', schemaVersion, name, profile, params}`, where `params` is the minimal patch over `resolveProfile(profile)`. Import checks format → name (profile ids are reserved) → profile → schemaVersion (newer is rejected) → migrate → applyPatch over the profile, showing every error path inline; unknown keys are errors. Import *loads* the preset; export writes the *current draft*. Saves and `.wiworld` store full params and load as migrate → applyPatch over the defaults (SP1 spec §4.5).

**Session.** Settings, last world and panel layout go to localStorage behind try/catch. The world URL `?map#base64url(canonicalJSON({v: 1, seed, profile, patch, view}))` makes a world shareable: `patch` is the session's minimal patch over the profile and there is no gzip (a full 52-knot offset edit is about 2.3 KB). It replaces `#seed=…&profile=<ProfileId>&p=<base64url(gzip(params diff vs profile))>` (amended by SP2b).

## 3. Generation

### 3.0 Stage contract and rings

| stage | input | output | neighbour needs | budget p50 / p95 (Node, dev machine) |
|---|---|---|---|---|
| Column | seed, params, (cx,cz) | `ColumnSample` (cached) | none; the halo is recomputed locally | 0.7 / 1.2 ms (0 on cache hit) |
| T (terrain) | ColumnSample, carver sources, structure starts (all pure) | proto sections (blocks+fluid), proto heightmaps, biome quarts, aux | none | ≤ 10 / 20 ms |
| D (decorate) | 3×3 **proto** (read-only), own diff | final blocks+fluid, final heightmaps, tint | 3×3 at ≥ Proto | ≤ 3 / 8 ms |
| L (light) | 3×3 **final** (read-only) | own light | 3×3 at ≥ Decorated | ≤ 4 / 8 ms |
| Mesh | initial: a whole column (all non-trivial sections, each with its 26 neighbours) in one `MESH_COLUMN` job; edits: single sections | SectionMesh × 3 passes + connectivity | 3×3 at ≥ Published | ≤ 1.0 / 2.5 ms per non-trivial section |

Visible radius RD therefore needs L at RD+1, D at RD+2 and T at RD+3. Unload uses hysteresis at RD+5.

### 3.1 Noise core and seeding (fixes the origin, lattice-zero, aliasing, period and diagonal vices)

Amended by SP1; the SP1 spec (§1-2 there) holds the exact formulas, constants and vectors.

**Seeds.**
- `Seed64 = [lo, hi]` (u32 words). `seedFromInput(text)`: trim only (no Unicode normalisation); an integer in [−2^63, 2^64 − 1] maps to its value mod 2^64, anything else to fnv1a64 of its UTF-8 bytes. An empty box gets a random seed in the UI, written back into the box.
- Every noise gets `deriveSeed(world, name) = fmix32(world[0] ^ fmix32(world[1] ^ fnv1a32(name)))`. Names come from the ParamSchema path (`"climate.T"`; octaves append `#i`, stack B appends `'`, warp components `.x`/`.z`; a leaf's `seedName` keeps an old name after a rename). No `seed+k` derivation remains.
- Positional hashes pre-mix each axis, `ax(v,K) = imul(t ^ (t>>>15), 0x85ebca6b)` with `t = imul(v,K)`: `hash2(s,x,z)`, `hash3(s,x,y,z) = fmix32(s ^ ax(x,KX) ^ ax(y,KY) ^ ax(z,KZ))` and `hash4(s,salt,x,z)`. The plain xor of products was unchanged under (x,z) → (−x,−z) for a third of positions. Feature RNG streams are xoshiro128** seeded via splitmix32.

**`lattice3(s,x,y,z)`.**
- Quintic fade; interpolation along x, then y, then z.
- The corner gradient is one of the **12 cube edges, balanced**: index `((hash3(s,ix,iy,iz) & 0xffff)·12) >>> 16`. GRAD16's 4 repeats gave the vertical derivative 8 % more variance (vertical-plane N5 up to 1.22).
- There is no permutation table and therefore no period.
- 2D fields are 3D noise on a fixed slice: octave i samples at `y = floor(oy_i) + 0.5` (a random integer part, fraction ½). A random fraction made the slice sd vary by ±9 %.
- Closed-form constants: `PERLIN3_SD = √(35054270/480729249)` (3D) and `PERLIN2_SD = √(2052359/24972948)` (2D slice).

**`OctaveNoise`.** `f_0 = 1/wavelength`, `f_i = f_{i−1}·lacunarity`; `a_0 = 1`, `a_i = a_{i−1}·persistence` (or `amplitudes[i]`). Each octave gets its own `deriveSeed(name#i)` and a fractional origin `splitmix32(seed_i)·2^−20` per axis, in lattice units in [0,4096)³, added after frequency scaling. The origin is never special and integer points never align with the lattice.

**`NormalNoise`.**
- `v = A(p) + B(p·R)`, `R = 337/331`; B's octaves are named `name'#i`; `double` defaults to true.
- `S = sqrt(ΣaA² + ΣaB²)`; `z = clamp(v · 1/(SD·S), −clampSigma, clampSigma)` with `SD = PERLIN2_SD` (2D) or `PERLIN3_SD` (3D) and a default clamp of 3, which gives exact interval bounds. A unit test pins both SDs within ±0.5 %.
- Climate fields go through `u = detErf(z * Math.SQRT1_2)`, approximately uniform on [−uMax, uMax] with uMax = detErf(3·SQRT1_2) = 0.9973; `remap: 'uniform'` requires a double stack.
- Density and cave noises use z directly (unit sd).

**Kill criterion (SP1 bench).** If `lattice3` is more than 1.6× slower than a 512-entry per-octave permutation variant (measured in the same bench run, locally aliased), SP1 does not exit and this section is revisited. The permutation variant exists only as a bench comparator: its octave 0 repeats with period 256·λ, so it cannot pass N3.

### 3.2 Climate (column stage, per quart point)

Warps:
- A shared shift warp: `(x,z) += 48·(Nwx,Nwz)` with λ 256 and 3 octaves.
- C gets an extra warp of 180 at λ 1024 with 2 octaves (bays and peninsulas).
- R gets an extra warp of 120 at λ 512 with 2 octaves (meanders).
- Warp noises are NormalNoise z values (unit sd, no remap). Every climate noise uses persistence 0.5 and lacunarity 2 (SP1).

| field | λ₀ (blocks) | octaves | notes |
|---|---|---|---|
| C continentalness | 2400 | 6 | ocean ↔ inland |
| E erosion | 1600 | 5 | flat ↔ mountainous |
| W weirdness | 900 | 5 | `PV = 1 − \|3\|W\| − 2\|` (ridges at \|W\| = 2/3); sign(W) selects variants |
| T temperature | 5000 | 4 | zones about 2× larger than H (09 used 480 for both) |
| H humidity | 2400 | 4 | |
| R rivers | 1000 | 4 | its zero set gives the river lines |

- All six fields are **CDF-uniform** (chosen over MC's 3σ normal so shares are authorable) on [−uMax, uMax] with uMax = 0.9973, so a band inside that range has area share width / 2. Spline knots at ±1 act as end knots. (`X_u` and `X` denote the same uniform field; the suffix is only emphasis.)
- `climate.scaleMul` divides the climate stage's input coordinates before warping, `(x,z) → (x/s, z/s)`: an exact zoom of every climate λ, warp λ and warp amplitude; `large_biomes` sets it to 4.
- The altitude lapse `T_eff(y) = T − 0.006·max(0, y − 80)` is used by surface rules and freezing.
- The depth axis for cave biomes is `depth = (surfaceEst − y)/128`.

### 3.3 Shape (nested cubic-Hermite splines C → E → PV, outputs in blocks)

**`offset`: target surface y in blocks.** Defaults:
- Ocean and shelf: C −1 → 16, −0.6 → 26, −0.4 → 40, −0.24 → 52 (shelf), −0.16 → 60.
- Coast (C −0.10): E −1 → 70, E 0 → 64, E 1 → 63.
- Near inland (C 0.05): E −1 → PV{−1:72, 0:96, 1:130}; E −0.4 → PV{68, 82, 100}; E 0.2 → PV{65, 72, 80}; E 1 → 66.
- Mid inland (C 0.30): E −1 → PV{80, 125, 175}; E −0.4 → PV{72, 92, 120}; E 0.2 → PV{66, 76, 88}; E 0.6 → 70; E 1 → 66.
- Far inland (C 0.60): E −1 → PV{90, 150, 210}; E −0.4 → PV{76, 104, 140}; E 0.2 → PV{68, 82, 96}; E 1 → 70.

**`sigma` (overhang σ):** the sd, in blocks, of the 3D displacement of the surface. Ocean 3, coast 1.5; inland E −1 → PV{−1:4, 1:16}, E 0 → 3, E 1 → 1.2.

**`jag` (jaggedness, blocks):** 0 except inland with E ≤ −0.5, where it follows PV{0.3:0, 0.7:30, 1.0:55}.

**`steep`:** `|∇offset|` by central differences on the quart halo. It is continuous across columns, which fixes 09's chunk-edge clamped slope, and it feeds surface rules.

There are no downstream multipliers: the editor's y-axis *is* the terrain.

**Spline semantics (SP1).** Outside the end knots the end value holds (no linear extension, unlike MC). Between knots, `f = y0 + t·dy + t(1−t)((1−t)(d0·h − dy) + t(dy − d1·h))` with `h = x1 − x0`, `t = (q − x0)/h`, `dy = y1 − y0`; a nested knot evaluates only the two bracketing children. Tangents are explicit data, never re-derived at compile or evaluation time. The defaults above get their tangents from the hybrid rule when SP2a authors them (PCHIP inside numeric runs; d = 0 at nested knots, their neighbours and end knots inside (−1,1)); it stays inside the hull of each segment's end values up to rounding (≤ 4 ulp), so consumers that need jag, σ ≥ 0 clamp with `max(0, ·)`. Validation: 1-32 points, strictly increasing x with |x| ≤ 2, y within the leaf's range, finite d with |d| ≤ 1e5, no coordinate reused along a path, ≤ 4096 spline objects; with these bounds a spline without issues evaluates finite everywhere (amended by SP2b).

### 3.4 Rivers (column stage; exact on the map and LOD)

- **Distance:** `riverDist = |R_z| / max(|∇R_z|, 1e-4)` in blocks, with ±2-block central differences.
- **Width:** `w = 8 + 12·u2`, where u2 comes from a λ 600 noise (5 + 9·u2 until the SP2a fix of 2026-09-30). `valleyWidth = 30 + 45·(1+E)`.
- **Strengths:** the coastal factor `s = smoothstep(−0.12, −0.02, C)` fades only the valley, so the channel reaches the shore with its floor (rivers stay out of the ocean through the land rule below); the altitude factor `s_alt = 1 − smoothstep(120, 170, offset0)` fades the channel into mountain gorges.
- **Valley:** `t = 1 − detExp(−(max(0, riverDist − w/2)/valleyWidth)²)`. Then `valleyOffset = lerp(min(offset0, 64 + 2t), offset0, t)`, and σ and jag are scaled by t (by s·t overall).
- **Channel** (riverDist < w/2): `channelOffset = 63 − (3 + 3·u2)·(1 − (2·riverDist/w)²)`, σ = 0.5, jag = 0.
- **SP2a amendment:** the valley's strength is `s·s_alt`, so valleys fade on high ground; there the channel cuts a dry gorge `gorgeDepth` (12) below offset0 instead of a valley pulled to sea level (SP2a spec §2.4).
- **Final:** outside the channel `offset = lerp(offset0, valleyOffset, s)`; in the channel `offset = min(lerp(offset0, valleyOffset, s), lerp(offset0, channelOffset, s_alt))`, so the channel keeps its floor of 57-60 all the way to the ocean and continues onto shelves shallower than its floor.
- **Land only** (SP2a fix of 2026-09-30): a river, wet or gorge, exists only where `offset0 ≥ 63`. On the sea floor the channel still lowers shallower shelves (a drowned mouth), but the column stays sea and gets its climate biome (SP2a spec §2.4).
- `surfaceWaterLevel = 63` and the River or Frozen River biome apply only where `offset0 ≥ 63`, `riverDist < w/2 + 2` **and** the channel-centre offset ≤ 62, so rivers are guaranteed wet (08 rivers were 94% dry). Where `s_alt ∈ (0,1)` leaves the channel above 62, the column is a dry **gorge**: it keeps its land biome and surfaceWaterLevel stays −∞.

### 3.5 Lakes at elevation (09 basins [keep], improved with a local water level)

**Cells.** Warped Voronoi: cell 320 blocks, warp amplitude 80 at λ 360. A cell is enabled with p = 0.12 (hash) when its centre has C_u > −0.1, offset0 in [66, 200], and no river.

**Level.** `Lw = floor(min over 8 ring samples at 0.55·R of (offset0 + jag·J)) − 1`. This is deterministic per cell.

**Masks.** The basin mask m comes from the F1 distance, with the rim roughened by a λ 48 noise. Depth is `4 + 10·hash`.
- **Inside** (m ≥ 1): `offset = min(offset, Lw − depth·profile(r))`, σ ×0.3, jag = 0.
- **Rim band** (0 < m < 1): `offset = max(offset, Lw + 2 + 3·σ_rim)` blended toward offset0 at the outer edge, with `σ_rim ≤ 0.5`. Containment then holds by construction: the 3σ-clamped noise cannot breach the rim.

**Water.** `surfaceWaterLevel = Lw` inside the mask, and `lakeFloor = Lw − depth`. The default density DAG suppresses caves, and carvers skip voxels, where `lakeMask > 0 and y > lakeFloor − 8`.

### 3.6 Density DAG (D9: typed column stage + data-driven 3D composition)

**Units.** Density is in blocks; a voxel is solid iff f > 0.

**Compiler (`density/compile.ts`, closures, no `new Function`):**
1. Resolve `ref`s and deduplicate by structural hash (CSE).
2. Classify each node:
   - COLUMN: depends only on `col`, `noise2` or `const`. Evaluated once per column on the 5×5 corners (exact on quarts).
   - CELL: inside `interpolated`. Evaluated at 5×49×5 corners and trilinearly interpolated.
   - VOXEL: everything else (`noise` outside interpolation, `beard`).
3. Validate that `interpolated` contains no VOXEL leaves.
4. Emit `cornerFn` and `voxelFn` closures over typed scratch arrays.

A reference point interpreter (`reference.ts`) must equal the compiled closures bit-exactly: only IEEE `+ − × ÷ √`, `floor` and detMath are used, with fixed evaluation order.

**Exact early-outs (`bounds.ts`).** Every node implements interval evaluation:
- `col` → exact min/max over the cell's 4 corner columns (bilinear, so exact);
- `noise` → ±clampSigma × amplitude;
- `y` → the cell's y range;
- `interpolated` → the hull of its corner bounds;
- arithmetic, min/max, clamp and `rangeChoice` → standard interval rules; `rangeChoice` prunes to one branch when its input interval is decisive.

Per 4×8×4 cell:
- if `hi < 0`, the cell is air (or fluid, by the aquifer) with no corner work;
- if `lo > 0` for the terrain tap *and* the cave taps are bounded ≥ 0, the cell is solid;
- otherwise evaluate corners, and VOXEL nodes only in cells whose interpolated bound straddles 0.

Sky costs about 0, and the probe == bulk test (DT2) proves no voxel changes.

**Default expression (`density/defaults.ts`, shown as formulas):**

```
terrain   = tap('terrain', interpolated( col.offset + col.jag·J − y + col.sigma·N3·slide(y) ))
            J = (1 − |u|)², u = noise2('jag') / clampSigma (λ 28, 2 oct)     N3 = noise('overhang') λ 32, λy 32, 2 oct, persistence 0.65
            slide(y) = 1 on [−40,240], linear to 0 at −64 and 320; + 2·max(0,−56−y) − 2·max(0,y−296)
detail    = noise('detail') λ 10, 1 oct × amp(E) 0.6-1.5            (VOXEL, only in straddling cells)
cheese    = 4·L² + clamp(Nch + 0.27, −1, 1) + clamp((12 − terrain)/24, 0, 0.5)    Nch λxz 96 λy 144, 4 oct; L λxz 96 λy 12
pillars   = (2·Np − 1 − rare)·(0.55 + 0.55·thk)³                                  Np λxz 30 λy 400
spag3D    = rough + clamp(max(|S1|,|S2|)·rm − 0.0765 − 0.0115·thk, −1, 1)          rarityScaled λ 64, scales {0.75,1,1.5,2}
spag2D    = horizontal tunnels, centre y = 8·Nel(x,z) + yGrad(−64→8, 320→−40), λ 128
noodle    = Nt < 0 ? +64 : −0.075 − 0.025·thk + 1.5·max(|Ra|,|Rb|)                  Nt λ 64, Ra/Rb λ 18, y ∈ [−60, 64]
entr      = min(Ne + 0.37 + yGrad(−10→0.3, 30→0), rough + clamp(max(|E1|,|E2|) − 0.08, −1, 1))   Ne amps [0.4,0.5,1.0]
under     = max(min(cheese, spag2D, spag3D, entr), pillars ≥ 0.03 ? pillars : −1e6)
lakeRoof  = rangeChoice(y − col.lakeFloor, −8, 1e9, +1e6, −1e6)   (caves disabled under lakes)
caves     = interpolated(rangeChoice(terrain, −1e9, 8, 16·entr, 16·under))      (entrances NOT depth-ramped)
final     = max( min( min(terrain + detail, max(caves, lakeRoof)), 16·noodle ), islands ) + beard
```

- Entrance air appears wherever `16·entr < terrain`, even one block below the surface, and the same field continues downward. This replaces 09's `|base|·cs`, which made carving impossible shallower than 15-19 blocks.
- Noodle is a separate `min` applied after interpolation, which fixes 09's dead `max()`.
- The cheese roof term keeps big caverns about 12 blocks below the surface; entrances, noodles and carvers still breach it.
- `islands` is `−1e6` except in the floating_islands preset.
- `beard` is the structure term (3.13), evaluated per voxel only near pieces.
- Every term is a `tap`, so the inspector, probe and mutes work on it. In the harness, a debug channel records the winning cave term per carved voxel.

**As built by SP3b** (amended by SP3b; the SP3b spec §1-§3 hold the exact rules):
- **Ops.** `const`, `y`, `col`, `noise2`, `noise`, `add`, `mul`, `min`, `max`, `neg`, `abs`, `square`, `clamp`, `slide`, `interpolated`, `rangeChoice`, `tap` and `ref`; caves add their ops on the same base in SP6. `slide` is `x · s(y)` with s piecewise linear over half-open segments [y_k, y_{k+1}), constant outside the knots.
- **Evaluation order.** Every binary op evaluates a, then b; arithmetic is IEEE double in the written order, never fused or reassociated. `min(a, b)` is `b < a ? b : a` and `max(a, b)` is `b > a ? b : a`, so ties (+0 against −0 included) return a; −0 is a valid density. Trilinear interpolation lerps along x, then z, then y, with `lerp(a, b, t) = a + t·(b − a)`.
- **Placement.** COLUMN nodes depend only on `const`, `col` and `noise2`; CELL nodes are the other nodes inside `interpolated`, VOXEL nodes the other nodes outside it; `y` and `slide` are never COLUMN. CSE is keyed by (structure, inside-`interpolated` flag). The closures are `columnFn` (the COLUMN nodes CELL nodes read, at the 5 × 5 corner columns, reading lattice values exactly), `positionFn` (the COLUMN nodes VOXEL nodes read, at the 16 × 16 block positions: `col` as the bilinear readout, `noise2` at the integer position), `cornerFn` and `voxelFn`. `interpolated` is never nested.
- **Interval rules.** `noise` and `noise2` are ±clampSigma (amplitude is a `mul`); `col` inside `interpolated` takes the hull of the cell's 4 corner columns; a COLUMN value read at voxel level takes the hull of its 16 position values; `slide` takes s at the cell's ends and at each interior knot. Every interval leaving `interpolated`, and every voxel-level COLUMN interval, is widened by `1e-9 · (1 + max(|lo|, |hi|))`. A cell is non-solid when hi < 0 and solid when lo > 0 (no cave taps before SP6).
- **`col`** reads finite fields only until SP6, which adds the level fields' −∞ interval rule.
- **Noises.** Density noises sample unscaled world block coordinates (`large_biomes`' `scaleMul` stretches climate only) and have `remap: 'none'`. J uses `u = z / clampSigma`. Jag has 2 octaves, because a third at λ 7 would alias on the 4-block corner lattice. The overhang noise was retuned with the user's approval (SP3b spec §8.4) to λ 32, 2 octaves, persistence 0.65 and yScale 1: its octaves at λy 32 and 16 stay ≥ 2 × the 8-block vertical corner step.
- **Code, not data, until SP3d:** `SLIDE`, the floor and ceiling terms and `islands` = −1e6; `density.defs` becomes an editable leaf in SP3d.

### 3.7 surfaceEstimate and surfaceWaterLevel (shared by map, LOD, aquifer, structures, spawn and teleport)

SP2a uses the 2D estimate `surfaceEst = offset` (after rivers and lakes). SP3b adds the 3D estimate below as `surfaceEst3` (`gen/column/surfaceEstimate.ts`), used by T5 and by later consumers (aquifers, structures, spawn, teleport). The ColumnSample's `surfaceEst`, which the map, the biome picker and the column stage read, stays the 2D `offset`, so the `surfaceEst` stage version is not bumped (amended by SP3b; the SP3b spec's Decision 2 and §5).

- **surfaceEstimate(x,z)** (`surfaceEst3`): start at ⌊`offset`⌋ (the bilinear ColumnSample value, clamped to [−64, 319]) and step ±8 blocks through the probe of the `terrain` tap (interpolated, without `detail`) until the sign changes, then bisect the 8-block bracket 3 times to one block. No sign change up to 319 returns 319, none down to −64 returns −64. An 8-step scan can cross a gap and return an overhang's underside; T5 measures single-surface positions only (amended by SP3b).
- Caching on the quart lattice comes with its first consumer (aquifers, structures, spawn, teleport: SP4-SP9; amended by SP3b, which caches nothing).
- T5 holds `|est − true top|` to median ≤ 1, p90 ≤ 2, p99 ≤ 6.
- **surfaceWaterLevel:** 63 for ocean and river, Lw for lakes, otherwise −∞.
- **Teleport:** go to `surfaceEst + 2`, then snap to `MOTION_BLOCKING` once the column is published. While unloaded, the player hovers.

### 3.8 Carvers (stage T, after density)

**Sources.** Each column within 8 columns (a 17×17 set) rolls `rngFor(seed,'carver.cave',sx,sz)`:
- cave carver: p = 0.15, plus an underground-only carver with p = 0.07 and y ≤ 40;
- canyon carver: p = 0.015.

**Paths** are computed once per source and cached in a worker LRU of 1024 entries, as lists of `{x,y,z,rh,rv}` ellipsoids with an AABB.

**Worm caves:**
- start y uniform in [−56, 180]; length 112 − rand(28);
- radius `(2·rand+rand)·[0.7,1.4]`, vertical ratio 0.8-1.3, yScale 0.1-0.9;
- floor_level in [−1, −0.4], giving flat floors;
- a branch at the midpoint with 25% chance;
- yaw and pitch drift using detSin/detCos.

**Canyons:** start y 10-72, yScale 3, vertical rotation ±0.125, trapezoid thickness 0-6 with plateau 2, width smoothness 3, length 84-112.

**Carving rules:**
- Only `CARVABLE` blocks are carved.
- Voxels inside structure piece boxes and under lakes (3.5) are skipped.
- Each carved voxel asks `aquifer.fluidAt` whether it becomes water, lava or air.
- "Carved dirt below grass becomes grass."
- Carvers cut the surface, which gives guaranteed openings and all ravines.

### 3.9 Aquifers (per non-solid voxel; replaces "everything ≤ sea level is water")

**Cells.** 16×12×16 cells offset (5,1,5), each with a centre jittered by (0-9, 0-8, 0-9) via `hash4`. Each voxel takes the 4 nearest centres out of the 2×3×2 neighbourhood.

**Cell level:**
- If the centre is within 12 blocks of `surfaceEst` and the column has a surfaceWaterLevel, the level is that surfaceWaterLevel (sea, river or lake).
- Otherwise it comes from floodedness Nf in [−1,1], with thresholds interpolated between inland and under-ocean:
  - fully flooded if Nf > 0.8 inland (> −0.3 under ocean): global level 63;
  - partially flooded if Nf > 0.4 (> −0.8): `floor(y/40)·40 + 20 + 3·round(Nspread·10/3)`;
  - otherwise empty (−∞).
- **Lava:** a cell whose level ≤ −10 and `|Nlava| > 0.3` becomes lava, with Nlava sampled once per 64×40×64 block. Everything below y −54 is lava.

**Barriers.** When the two nearest centres have different levels and `d2 − d1 < 25`, MC's pressure formula plus barrier noise decides; a positive result places stone.

**Abyss.** Aquifers are disabled where E_u ≤ −0.5, C_u > −0.1 and depth > 0.9, i.e. the abyss box of §3.10 widened by a 0.1 depth margin (the Abyss stays dry and dark).

**Fast path.** Cell statuses are cached per job, together with the maximum level of each neighbourhood. If y is above that maximum, the voxel is air immediately.

**Borders.** Fluid voxels with an air neighbour are flagged `unsettled` for settle (3.14).

### 3.10 Biomes

**Surface registry (28; volcano added by SP2a, 2026-09-29):**
- oceans: ocean, deep ocean, warm ocean, frozen ocean;
- coast: beach, snowy beach, stony shore;
- rivers: river, frozen river;
- lowlands: plains, meadow, forest, birch forest, dark forest, taiga, snowy taiga, snowy plains, desert, savanna, swamp, jungle, badlands;
- hills and peaks: windswept hills, snowy slopes, stony peaks, jagged peaks, frozen peaks, volcano (hot peaks: T_u ≥ 0.6, PV > 0.7, low E; its cone is a later column-stage term, SP12 by default).

**Cave registry (3):**
- lush: H_u ≥ 0.4 and depth 0.2-0.9;
- dripstone: C_u ≥ 0.6 and depth 0.2-0.9;
- abyss (D14): E_u ≤ −0.5, C_u > −0.1 and depth ≥ 1.0, so never under oceans.

Anything else is plain cave.

**Boxes** are authored in uniform bands:
- T and H edges −0.6 / −0.2 / 0.2 / 0.6;
- C: deep ocean < −0.55, ocean < −0.1, coast −0.22..−0.04, then near / mid / far inland. Oceans and coast overlap on the shore band, and the height filter below decides between them (SP2a fix of 2026-09-30: before it, 84 % of coast biomes lay under water);
- E in 7 bands;
- PV valleys < −0.6 up to peaks > 0.7;
- sign(W) selects variants.

Two verifier fixes:
- Windswept and peaks boxes **bound T** (no spruce hills in deserts).
- Beach covers the whole coast band **without a PV restriction** (fixes the coastal mismatch).

**Height filter** (SP2a, 2026-09-30). A column whose offset0 is below sea level takes only the ocean-family boxes; any other column takes only the rest. The shoreline itself, not a C threshold, separates sea biomes from coast and land biomes (the shoreline's C depends on E).

**Fitness.** The unweighted sum of squared overshoots, with ties broken by an explicit `priority` field, not registry order; the table has no weights (amended by SP2b).

**Evaluation:**
- Surface biomes per quart from the ColumnSample; per block via a jittered-Voronoi zoom (hash2-jittered quart centres, nearest of 4).
- Cave biomes per 3D quart, only for quarts that contain air.

**Tint.** Per-block T/H (quart-bilinear) plus the override go into `tintTH` in aux, which feeds the tint texture.

### 3.11 Surface rules (data condition tree compiled to closures; whole-column scan)

**Scan.** One top-down pass per (x,z) over all 384 voxels of the proto. For every voxel it knows:
- `floorDepth` and `ceilDepth` (distance to the top and bottom of its solid run);
- `runIsSkyOpen`, `waterAbove`, `waterHeight`;
- `steep`, `T_eff(y)`, the biome and the cave biome.

**Conditions:** `biome`, `caveBiome`, `stoneDepth{floor|ceiling, offset, addSurfaceDepth, secondaryDepthRange}`, `water{offset, mult}`, `yAbove`, `verticalGradient{trueAtAndBelow, falseAtAndAbove}` (hash dither), `steep{min}`, `noiseThreshold{noise, min, max}`, `temperatureBelow`, `abovePreliminarySurface`, `skyOpen`, `not`, `sequence`, `bandlands`.

**Default rules** (first match wins):
1. Bedrock at y −64, dithered over −63..−60.
2. Deepslate where y < 0, dithered over 0..8. This uses absolute y, so strata stay coherent under mountains.
3. Open-sky top run:
   - `surfaceDepth = floor(3 + 2.75·Ns + 0.25·hash01)`.
   - Under fluid: sand (warm ocean, beach, lake shallows), gravel (deep or cold), clay patches, dirt (rivers).
   - `steep > 1.2` and y ≥ 90 gives stone, or packed ice in frozen peaks.
   - Snowline: `T_eff < −0.6` gives snow.
   - Otherwise the biome palette supplies top / under / sandstone ×4, with noise patches (coarse dirt, podzol, gravel, calcite) and badlands terracotta bands.
4. Lower runs use cave-biome floor and ceiling rules: moss ×2 plus clay under water (lush), dripstone blocks (dripstone), the abyss palette (dark abyss stone with faint veins, cracked variants, shale strata, ash floors) in the abyss, otherwise stone or deepslate with gravel under cave water. **Grass never appears below the open-sky run.**
5. Ice forms only on sky-exposed water where `T_eff < −0.45`, and snow layers only on sky-exposed ground. This runs in D (freeze_top_layer) using a MOTION_BLOCKING computed from K's scratch (§3.12).

### 3.12 Decorate stage (pull model; ores, vegetation, cave decoration, structure stamping)

**Placed feature** = `{kind, config, placement: Modifier[]}`, all preset data. Modifiers:
- counts: `count`, `noiseBasedCount{ratio, factor, offset}`, `rarity{chance}`;
- positions: `inSquare`, `jitteredGrid{cell, minSpacing}`, `heightRange{uniform|triangle|trapezoid}`, `heightmap{WORLD_SURFACE_WG|OCEAN_FLOOR_WG}`, `environmentScan{dir, target, maxSteps}`;
- density: `noiseDensity{noise, lo, hi, gamma}`;
- filters: `biome`, `surfaceWaterDepth{max}`, `blockPredicate`, `survives`.

**Steps:** raw_generation, lakes (lava lakes underground), local_modifications, underground_structures, surface_structures, underground_ores, underground_decoration, fluid_springs, vegetal_decoration, top_layer_modification.

**Pull model.** `decorate(K)` receives the 3×3 **proto** (read-only) and the diff of K. For every source chunk S in the 3×3, every step and every feature of the biomes present in S, it computes placements with `rng = xoshiro(hash(seed, S.cx, S.cz, step·1000 + featureIdx))`.

Consistency rules, asserted in dev and proven by DT1:
1. Whole-feature decisions (place or not, height, crown, species) read only S's own proto (heightmaps, blocks, biome) and pure functions (structure pieces, column stage). Every receiver sees the same S.
2. Per-voxel decisions (replace-if-air, ore air-exposure discard) read the target voxel and its 1-voxel halo from the proto of K's 3×3.
3. Writes go only to K's scratch column, by the rule `write if prio(new) > prio(cur)` with `prio = step<<24 | featurePriority<<16 | (hash(S, featureIdx, placementIdx) & 0xFFFF)`. Structure blocks beat features within their step, and logs beat leaves.
4. Feature reach is at most 16 blocks outside S.

The result is order-independent and identical in every receiving column. Canopies are never cut, and trees stand on S's real `WORLD_SURFACE_WG` heightmap, so they never float or get buried.

**Trees:**
- Jittered grid with cell 4 and jitter within `1 − minSpacing/cell`.
- Acceptance `p = biomeDensity·(s·√s)` with `s = 0.25 + 0.75·detSmoothstep(−0.5, 0.7, Nforest)` (no `**`) and Nforest at λ 160, which creates groves and clearings. Declared densities are true probabilities.
- Species per biome: oak, fancy oak, birch, spruce, pine, acacia, jungle, dark oak (2×2), swamp oak with vines.
- Shape parameters come from `hash4(seed, species, x, z)`.
- Ground check: the top block is grass, dirt, podzol or snowy grass; water depth is 0; the tree AABB does not intersect any structure piece.

**Plants:**
- Patches of 32 tries within radius 7: flowers, tall grass, ferns.
- Per-surface chances: cactus, sugar cane, lily pad, seagrass, kelp, boulders, mushrooms, dead bush.
- The whole 16×16 is covered, including borders.

**Cave decoration:**
- glow lichen (emits 7), placed by 3D hashing on walls and ceilings (this replaces 09's glowstone columns);
- lush: cave vines with glow berries (emit 14), moss carpet;
- dripstone: pointed dripstone 1-4 long;
- abyss: dark crystal clusters (`abyssCrystal`, emit 2-3, faint violet), hanging dead roots, fossils embedded in walls, and the exclusive abyss mineral (an ore feature restricted to the abyss cave biome). The abyss surface-palette blocks (stone variants, shale, ash) are decided in the SP6 spec; the decoration blocks (crystals, dead roots, fossils, the exclusive mineral) in the SP8b spec;
- springs and lava lakes are fluid-producing features (3.14).

**Ores** (count per chunk; each replaces stone, or deepslate below y 0 with the deepslate variant):

| ore | count / size | height | discard on air |
|---|---|---|---|
| coal | 20 / 15 | triangle 0..192 | 0.5 |
| iron | 10 / 9 | triangle −24..56 | |
| iron (upper) | 45 / 9 | triangle 80..320 | |
| copper | 16 / 10 | triangle −16..112 | |
| gold | 4 / 9 | triangle −64..32 | 0.5 |
| redstone | 4 / 8 | uniform −64..15 | |
| redstone (lower) | 8 / 8 | triangle −96..−32 | |
| lapis | 2 / 7 | triangle −32..32 | |
| diamond | 7 / 4 | triangle −144..16 | 0.5 |

**Order inside D:**
1. Compute placements for the fluid-producing features (springs, lava lakes).
2. Settle (3.14).
3. Run all other steps.
4. top_layer_modification: freeze_top_layer on K's own scratch using a MOTION_BLOCKING computed from the scratch (the same routine step 6 writes).
5. Overlay K's diff (absolute states).
6. Write the final heightmaps.

### 3.13 Structures (random_spread sets, jigsaw-lite, beardifier)

**Placement.** `region = floor(chunk/spacing)`, `rng = hash(seed, rx, rz, salt)`, and an offset in `[0, spacing − separation)` (linear) or the mean of two draws (triangular). A start is checked against biome, frequency, exclusion zones and `prelim slope ≤ 6` over its footprint.

| set | spacing / separation | biomes | pieces |
|---|---|---|---|
| village | 34 / 8 | plains, meadow, savanna, desert, taiga, snowy plains (4 palettes: plains/meadow, savanna, desert, taiga/snowy plains) | depth ≤ 6, radius ≤ 80: plaza or well, streets (terrain-matching), houses S/M/L, farm, lamp, tower, terminators |
| ruins | 24 / 6 | land except peaks | 2-5 pieces, `bury` 1-4 |
| desert temple | 32 / 8 | desert | 4 pieces, `beard_box` |
| jungle temple | 32 / 8 | jungle | 3 pieces, `beard_box` |
| igloo | 32 / 8 | snowy biomes | 1 piece, `beard_thin` |

**Templates** are TS builders that produce `PieceTemplate{size, palette, blocks: Uint16Array /* block states */, connectors[{pos, facing, pool, target}], projection:'rigid'|'terrain_matching', adaptation, weight}`. Pools are JSON. Pieces use stairs, slabs, doors, fences, panes, lanterns and torches (D12); rotating or mirroring a piece applies `rotateState`/`mirrorState` to every block, so orientations stay correct.

**Assembly.** A BFS over connectors: each tries up to 8 weighted candidates × 4 rotations from the piece RNG. A candidate is accepted if its AABB overlaps no placed piece and stays within depth and radius. Rigid piece y is `surfaceEst` at the piece centre, a pure column function, so every column computes the same layout. Starts are cached per worker (LRU 256 regions).

**Beardifier (a VOXEL `beard` leaf):** `+12·clamp(1 − sdfFoundation/8, 0, 1) − 12·clamp(1 − sdfClear/6, 0, 1)` summed over pieces within 12 blocks. It is evaluated only in columns overlapping an inflated piece AABB. `bury` sinks the piece.

**Stamping** happens in D, step surface_structures, clipped to K. Terrain-matching streets replace K's own top block.

Map markers come from the same start function. Structure starts never lie below `surfaceEst − 4`, so no structures spawn in caves.

### 3.14 Gen-time fluid settle (inside D; exact and neighbour-consistent)

**Input:** the 3×3 proto fluid plus the spring and lava-lake sources from step 1 of D.

**Rules** (shared `fluidRules.ts`):
- falling is unlimited;
- horizontal spread adds level+1 per step, up to 7 for water and 3 for lava;
- flow prefers the nearest drop within 4 (water) or 2 (lava);
- a new source forms between ≥ 2 horizontal sources over solid ground.

**Exactness.** Each front carries the cumulative horizontal distance from its origin and **stops at 16**. Any fluid reaching K therefore originated inside K's 3×3, so the result is exact and identical from any receiver.

**Truncation.** A front that reaches the cap keeps `unsettled = 1`. The runtime sim does not tick it until a user-caused block update touches it (D18). A2 bounds the share of unsettled voxels.

**Budget:** at most 20k voxel visits per job.

### 3.15 Extreme presets (data only: splines + climate params + DAG terms)

The built-in presets are the `PROFILES` entries of `core/params/profiles.ts` (SP1): overlays over the defaults, each hidden in the UI until its `readyFrom` sub-project.

| preset | changes |
|---|---|
| default | as above |
| large_biomes | `climate.scaleMul = 4` |
| amplified | `offset' = 64 + 1.9·(offset − 64)` where offset > 64; σ ×1.6; jag ×1.6; top slide moved to 300-316 |
| archipelago | C λ ×0.35; offset spline remapped so C_u < 0.2 is ocean (about 60%); only the coast and near-inland E splines are used |
| floating_islands | `islands = 20·(NI − 0.35·((y − 230)/40)² + m − 1)` on y ∈ [190, 270], where NI has λxz 72 and λy 36 over 2 octaves and `m = smoothstep(0.55, 0.8, u(λ 700))` clusters islands; plus its own surface-rule branch (grass tops, stone undersides) and island-edge springs |
| cave_heavy | cheese offset 0.27 → 0.20, entrance offset 0.37 → 0.30, noodle band widened to y ≤ 120, carver p ×1.5 |

### 3.16 Cross-column consistency contract

| kind | decided from | reads | writes | why every column agrees |
|---|---|---|---|---|
| density, noise caves, beardifier, islands | world-space pure functions on a world-aligned 4×8×4 lattice | nothing | own proto | shared corners are identical; bounds are exact |
| carvers | source RNG + path (detMath) | nothing | own proto | paths are pure functions of the source |
| aquifer | cell hashes + noise + surfaceEst | nothing | own proto | pure |
| surface rules | own column (whole 384) + column stage | own proto | own proto | column-global depth; steep from the halo |
| features and ores | source-chunk RNG + S's proto (rule 1) | 3×3 proto (rule 2) | own final | priority writes are order-independent |
| structures | region RNG + surfaceEst | pure | own final (stamp) + beard in T | layout is a pure function |
| settle | 3×3 proto + feature sources | 3×3 proto | own final | distance cap 16 ≤ window margin |
| light | 3×3 final | neighbours at ≥ Decorated (immutable until Published) | own light | light reach ≤ 14 < 15-block padding |
| runtime (edits, fluids, relight) | sim worker, the single writer of Published columns | SAB | SAB + diffs | versions discard stale job results |

### 3.17 Determinism rules

- `gen/` uses float64 only, with no `Math.fround`.
- Arithmetic is limited to what ECMA-262 specifies exactly: `+ − × ÷` (roundTiesToEven per operation, so no FMA contraction), correctly rounded `Math.sqrt`, and the exact `Math` allowlist; `**` and `Math.pow` are implementation-approximated and banned. Transcendentals come only from detMath. Formulas keep their written operation order; a reciprocal multiply is not a substitute for a division unless the formula says so.
- Coefficient literals in detMath and any polynomial kernel are shortest round-trip decimals (≤ 17 significant digits), with their bit patterns pinned by tests.
- There is no iteration over Map or Set in any output path, and plain-object keys in generator output paths are iterated only after sorting; iteration is always over sorted arrays.
- NaN: generator outputs are NaN-free (asserted by DT1/DT2 and the SP1 unit tests); every golden hasher reads Float64 values little-endian and writes any NaN as `0x7FF8000000000000`, because x86 and ARM produce different NaN bits.
- `core/` and `gen/` never call `Intl`, `localeCompare`, `toLocale*`, `String.prototype.normalize`, `TextEncoder` or `TextDecoder`; hashing uses a hand-written UTF-8 encoder (arch-tested).
- Every validated parameter number is normalised with `q15(x) = x === 0 ? 0 : Number(x.toPrecision(15))` (unique printed form, −0 → +0); canonical JSON is RFC 8785 and throws on NaN, ±Infinity and −0.
- Caches are pure memoisation of pure functions.

Proof suite (DT1/DT2):
- shuffled vs spiral order, 1 vs 4 `worker_threads`, cold vs warm cache, two runs, and goldens;
- compiled vs reference bit-exact; probe == bulk; batch == point;
- a browser self-test page (`?selftest=1`), built in SP2a and extended by every later SP with its stage, that recomputes golden hashes (column stage and map tiles from SP2a, proto regions from SP3a, …) in a real module worker, run at every SP exit from SP2a on.

## 4. Engine

### 4.1 Thread topology and ownership

```
Main thread: render (three), input/physics/raycast (reads SAB), Coordinator (state machine + heap), upload budget, UI, sound (WebAudio)
  │ SAB: growable slab pools, slot refcounts, column table, free stacks, epoch cells
  ├─ Task pool: N = clamp(hardwareConcurrency − 2, 2, 6) module workers, each with GenContext + LRUs
  │    jobs: T, D, L, MESH, MESH_COLUMN, LOD_TILE, MAP_TILE, SLICE, METRIC, TEXTURES, AUDIO_SYNTH   (message = {jobId, kind, cx, cz, epoch, versions, diff?})
  └─ Sim worker (1): edits, runtime fluid ticks (20 TPS), incremental relight, DiffStore + IndexedDB (single writer of Published columns)
```

**Configuration.** Params and seed are sent once per epoch (`configure`), and every worker builds its GenContext from them. Jobs carry about 200 B.

**Single-writer ownership:**
- A column with status < Published belongs to the one T, D or L job currently processing it; stages run strictly in sequence.
- A Published column belongs to the sim worker.
- Mesh jobs and the main thread only read.

**Optimistic concurrency.** Every job records the `blockVersion` and `lightVersion` of the 3×3 it read. The coordinator discards and requeues any result whose versions changed. Every section also carries a monotonically increasing `meshSeq`, and older mesh results are dropped. The only lock is the slab allocator.

### 4.2 Column state machine, rings and proto retention

**States:** `Absent → Proto(T) → Decorated(D) → Published(L) → sections meshed`.
- D becomes eligible when all 3×3 are at ≥ Proto.
- L becomes eligible when all 3×3 are at ≥ Decorated.
- A column is meshed (one `MESH_COLUMN` job covering every section that has, or borders, geometry) when its 3×3 are Published.
- **Atomic column reveal.** A column never becomes visible section by section. Its section meshes are uploaded hidden (`setVisibleAt(false)`) and are shown together in one frame once every non-empty section of that column is uploaded; the LOD fill-mask texel flips in the same frame. Streaming therefore grows in horizontal rings of complete columns, never bottom-up or top-down, so the underground is never revealed before the surface that covers it. After the reveal, cave culling (§4.15) keeps unreachable underground sections undrawn.
- **Re-generation swaps atomically too.** On Apply, a column's new-epoch meshes are staged hidden while the old ones stay visible; when the new set is complete, old instances are hidden and deleted and new ones shown in the same frame. Edit and fluid remeshes of individual sections replace already visible geometry and are exempt.

**Proto retention.** A proto set stays alive while the column lies in the ring RD+2..RD+3, or while any neighbour within the D radius is below Decorated. In tuning mode it stays alive for every loaded column. Otherwise it is freed by dropping refcounts on its slots. If a proto is ever missing when needed (after a big teleport, say), a `T(protoOnly)` job regenerates it; T is pure, so this is safe.

**Unload.** Voxels are freed beyond RD+5, meshes beyond RD+1. The column's diff stays in the sim worker's DiffStore.

### 4.3 Scheduling

**Needed sets** come from integer rings `dist² ≤ (R + 0.5)²`. They are recomputed only on a column crossing or an RD change, using the precomputed spiral offsets and zero allocations.

**Priority** (lower runs first): `score = d_h − 3·max(0, cos θ)·[d_h > 2] − stageBonus`.
- stageBonus: MESH 1.5, L 1.0, D 0.5, T 0.
- Edit remeshes get −1000.
- The heap is rebuilt in O(n) (n ≤ 5k) on a crossing or a turn of more than 30°.

**Caps:**
- In flight per type: T ≤ N−1, MESH ≤ N.
- LOD, MAP, SLICE, METRIC and AUDIO_SYNTH ≤ 1 while any T is pending within RD.

**Adaptive throttle (`engine/throttle.ts`).** If frame p95 over 60 frames exceeds 16.7 ms while generation is in flight, the generation cap drops by 1 (minimum 1). After 120 frames under 13 ms it rises by 1.

**Cancellation.**
- Queued jobs that leave the needed set are dropped.
- In-flight jobs check their epoch cell between phases and abort. SP2b implements the epoch cell as one pool-wide `SharedArrayBuffer` cell for map, spawn and stats jobs (a stopped job replies `ABORTED`); SP4 widens it to per-scope cells (amended by SP2b).
- Stale results are discarded.

**Uploads** are capped at 2 ms and 32 section-meshes per frame (Medium). They are served from a distance-ordered ready queue of whole columns; a column's uploads may span several frames, but its reveal happens in one (§4.2).

**HUD counts** come straight from heap and in-flight maps, so nothing is double-counted.

### 4.4 Meshing and vertex format

**Input.** The job copies an 18³ padded view of blocks, light and fluid from the SAB (about 20 µs). Below the world counts as opaque; above it counts as air with sky 15. Neighbours are always real data, so there are zero seam faces and AO and light are correct at borders.

**Face visibility.** A neighbour *occludes* a face when it is PASS opaque and its `FULL_FACES` has the facing bit (all six for cubes):
- opaque faces are emitted only against a neighbour that does not occlude them — a partial shape never hides a neighbour's face;
- cutout faces against a neighbour that does not occlude them and is a different block, except that cutout leaves also render faces against leaves (opaque leaves at Low do not);
- translucent faces against a non-same-fluid neighbour that does not occlude them.

In AO, smooth light and connectivity15, "opaque" means PASS opaque with `FULL_FACES` = 63 (`hasOpaque` stays "contains any PASS-opaque state"); slabs, stairs, doors, fences and other partial states count as open.

**Greedy meshing.** Per axis slice with a 16×16 mask of two u32 keys: `(layer, tint, flags, ao×4)` and `(sky×4, block×4)`. The measured ratio is about 0.56 quads per face.
- AO uses 09's 3-sample table [1, .8, .6, .45] with the diagonal flip.
- Smooth light (MC "Maximum"): average the 4 air-side voxels per vertex, skipping the corner when both edges are opaque.
- With AO and smooth light off (Low preset), the key is block-only, giving about 0.28.

**Cross sprites** are 2 quads with a hashed ±0.25 xz offset.

**Box-model shapes** (`mesh/shapes.ts`, D12): each state's `SHAPE_BOXES` entry is a list of axis-aligned boxes; connection-derived variants (fence/pane arms, stair corners) are selected from the 6 neighbours at mesh time. Box faces carry no UVs: like cubes, they sample the position projected onto the face plane (UV-lock) from layer `FACE_TEX[state*6+face]`, so each shape's textures are painted (and resource-pack images remapped at load) at the texels its box faces project onto. Faces are culled against a neighbour only where the neighbour occludes them (above); a box face on the voxel boundary is also culled when the neighbour is the same model with the same `half`/`slabType` and a coplanar face covers it (slab–slab, stair–stair sides), and R1's brute-force reference applies the same rule (any other hidden shape face is allowed and excluded from R1). Shape quads are never merged greedily; AO uses the cube rule on the box's outer faces and 1.0 inside.

**Shape grid.** Box coordinates are multiples of 1/8 block (1/16 would overflow the Uint8 position, and 2 spare bits cannot hold a 3-axis offset). Quantisation rule: centred thin parts (torch, pane, fence arms, fence-gate bars) are 2/8 thick and span 3/8..5/8; wall-hugging thin parts (door, trapdoor, ladder) are 1/8 thick and flush with their side; the lantern body spans 2/8..6/8; the wall torch is an upright 2/8 stick touching the wall, not tilted. The SP8a spec lists every box, and M1 enforces the grid.

**Fluid mesh:**
- Top corner height is the average of neighbouring levels (a source is 8/9; full height when the same fluid is above).
- Sides are emitted only against non-fluid neighbours that do not occlude them (predicate above).
- Still surfaces merge greedily (about 0.06 quads per face).

**Vertex = 8 B** (`mesh/packing.ts` exports the bit layout as a plain constant object `PACK_LAYOUT`; `render/materials/glsl/packing.glsl.ts` generates the `#define` block from it, and a test checks they match):
- `position`: Uint8x4 of `(x·8, y·8, z·8, 0)` in section-local 1/8-block units. Three's ShaderMaterial prefix declares `in vec3 position`, which also keeps BatchedMesh vertex counts and bounds working.
- `data`: uint32, bound as an integer automatically because it is a Uint32Array.
  - opaque/cutout: `layer10 | face3 | ao2 | sky4 | block4 | tint3 | flags4 (emissive, waving, randomRotate, upper) | 2 spare`;
  - fluid: `layer10 | face3 | sky4 | block4 | depth4 | tint3 | cornerDrop4`.
- UVs are derived in the fragment shader from the interpolated position projected onto the face plane, so greedy quads tile.

**Output.** Up to 3 SectionMeshes per section, each with its own index (Uint32), a precomputed bounding sphere and connectivity15. Buffers are transferred and wrapped with `new BufferAttribute(typed, n)`.

### 4.5 Render structure

**RegionBatch** covers 8×8 columns × full height. It owns 3 BatchedMesh objects (opaque, cutout, translucent), with one instance per section; the instance matrix translates to the section origin relative to the floating origin.
- Vertex and index capacity are reserved per preset; opaque starts at a reservation sized so the sum over regions matches §7 (≈ 100k vertices for a typical region) and grows ×1.5 via `setGeometrySize`.
- Remeshes go through `setGeometryAt` when they fit their power-of-two reservation; otherwise the geometry is deleted and re-added.
- `optimize()` runs when fragmentation exceeds 40%. It is per region, up to about 5 MB at 1500 quads/column (the < 1 ms claim is re-measured in the SP4 spike).
- `geometry.boundingSphere` is set before `addGeometry`, so three clones it instead of scanning positions.

**Fallback.** `capabilities.ts` detects `WEBGL_multi_draw` at startup. If it is missing, or the SP4 spike fails, the `SectionRenderer` interface switches to `RegionMesh`: one merged buffer per region per pass with sub-allocated ranges and `addUpdateRange`, and culling per region.

**Pass order:**
1. LOD tiles (own near/far), then clear depth.
2. Opaque regions (FrontSide, no discard, sorted front to back by region centre).
3. Sky dome.
4. Cutout (DoubleSide; alphaTest, or alphaToCoverage under MSAA).
5. Translucent (blending with depthWrite on; `customSort` back to front by section centre; double-sided water top).
6. Clouds.
7. Selection box.

On Ultra, passes 2-4 (after the LOD depth clear) render into a `WebGLRenderTarget` with a `DepthTexture` for Fabulous water.

**Draw calls:** about 16-20 regions × 3 plus LOD 4, sky 2, clouds 1 and selection 1, roughly 60 at Medium (target ≤ 100). 09 had about 2.3k at RD16. High adds RD16 regions and the shadow depth pass; its draw calls are recorded, not gated.

### 4.6 Materials (`render/materials`, the only GLSL boundary)

`createMaterialSystem(settings)` returns `terrainOpaque`, `terrainCutout`, `water(tier)`, `lava`, `sky`, `clouds`, `lod`, `shadowDepth` and `selection`, plus `setFrameUniforms(frame)`. All are `ShaderMaterial({glslVersion: GLSL3})` and include `batching_pars_vertex` and `batching_vertex`.

**terrain.frag:**
- `layer = base + hash(floor(worldPos)) % variantCount`, where the variant count comes from a layer-info `usampler2D`;
- a hash rotation or mirror for `randomRotate` top faces;
- `textureGrad(sampler2DArray)` for albedo;
- ±5% macro variation from λ 64 world noise;
- tint via `texelFetch(tintTexture, floor(xz) mod 1024)` into a colormap, masked by the texture's alpha tint mask (no double tint; the grass side is tinted only in its strip);
- `albedo × faceShade(top 1, bottom 0.5, N/S 0.8, E/W 0.6) × AO × lightmap(sky, block)`;
- the emissive flag bypasses lighting.

**No Lambert and no sun term on terrain.** Caves go dark and block light does not dim at night.

**Fog** is spherical, `f = smoothstep(fogStart, fogEnd, length(viewPos))`. Its colour comes from `skyColor(horizonDir)` in `common.glsl` and is darkened by the eye's sky light. When the eye is in water, fog switches to exponential (about 48-60 blocks) with a screen tint.

**Colour management:** textures use `SRGBColorSpace`, output is sRGB, and tints are converted to linear on the CPU.

### 4.7 Textures and resource packs

**Procedural painters** (pure, run in a worker in about 15 ms) write 16×16 RGBA:
- tileable (period-16) value or Worley noise quantised to a 4-6 colour palette with ordered dither;
- real features: cracks, pebbles, sand ripples, ore specks over stone or deepslate, log rings and bark, plank seams, leaves with holes, grayscale grass with a tint-mask alpha;
- 16-frame water and lava animation;
- 2-4 variants per block.

**Layout.** A `DataArrayTexture` with one layer per tile, variant or frame, mipmapped per layer. Anisotropy follows the preset.

**Resource packs.** Loaded through `<input webkitdirectory>` or multiple files. The manifest is `{format:'wi10-pack', resolution:16|32, textures:{name: file|[files]}, overlays:{name: file}, colormaps:{grass, foliage}}`.
- Images are decoded with `createImageBitmap` into an OffscreenCanvas and resampled to the tile size.
- Overlays are composited into the tint-mask alpha.
- Missing keys fall back to procedural textures.
- Packs are stored in IDB. Switching is Live: the array is rebuilt, and a remesh happens only if the layer count changes.

### 4.8 Lighting

**Initial light job:**
1. Copy the 3×3 final blocks and fluids for a 46×384×46 region (about 1-2 ms).
2. Seed 15 above `LIGHT_BLOCKING` and let it fall straight down at 15. Propagation (here and in every BFS below) never crosses a face set in `FULL_FACES` of the voxel it leaves or enters (§2.2).
3. Run the BFS with an Int32 ring queue, stepping −1 plus the opacity of filtering blocks. Only boundary seeds are enqueued.
4. Run the block-light BFS from emitters: lava 15, glow berries 14, torch 14, glow lichen 7, abyss crystal 2-3.
5. Write only the centre 16×384×16, turning uniform sections into descriptors.

Because the 15-block padding covers the maximum light reach, the result equals a global BFS (L1).

**Incremental relight** (sim worker, after edits or fluid changes):
- the standard removal BFS followed by a re-add BFS, per channel;
- sky gets a re-seed from the `LIGHT_BLOCKING` delta, so opening or closing a shaft propagates the full height of the shaft;
- it spans at most the 3×3 Published columns (the sim distance is capped at ≤ RD−2);
- it returns the set of dirty sections.

This replaces the ±15-block slab relight rejected in §9. L3 includes shaft cases.

**Lightmap.** A 16×16 `DataTexture` rebuilt on the CPU every frame:
- curve `f/(3(1−f)+1)`;
- the sky axis scaled by the day factor, with a blue night tint and a moon floor;
- warm block light, max-combined;
- a brightness setting.

**Shadows:**
- High: 1 cascade 1024² over 64 blocks, updated every 2nd frame.
- Ultra: 2 cascades 2048² over 160 blocks.

This is a custom depth pass (the `shadowDepth` material decodes the same vertex format), with an orthographic sun camera snapped to texels and normal-offset bias. The sun term multiplies sky light only, so caves stay dark.

### 4.9 Sky, day/night, clouds

- **Phases** come from sun elevation: dawn and dusk are elevation ∈ (−6°, 10°). This fixes 09's dusk-after-sunset. The default cycle is 20 min, with controls for cycle length, time, pause and night floor.
- **Sky dome:** zenith and horizon gradient, sun disc with glow, a moon quad opposite the sun with 8 phases, and 1500 stars as Points fading with elevation. `skyColor(dir)` is shared with fog and water.
- **Clouds:** a seeded 256² cell bitmap with 12-block cells at y 192-196, scrolling. Flat and translucent at Medium, greedy boxes 4 blocks thick at High+. Clouds fade with fog.

### 4.10 Water tiers

| tier | technique |
|---|---|
| Fast | alpha 0.72, biome water tint, shallow-to-deep colour from the mesher's depth-to-floor |
| Fancy | adds Schlick Fresnel (F0 0.02) toward `skyColor`, 2 scrolling ripple-normal octaves, animated texture, vertex waves on ungreedy near-camera water (High+) |
| Fabulous | adds refraction and Beer-Lambert absorption from the opaque colour/depth copy |

MeshPhysicalMaterial transmission and Reflector are never used.

### 4.11 Runtime fluids (sim worker; edit-triggered only; D18)

**Ticks.** 20 TPS; water acts every 5 ticks, lava every 30.

**Scheduled ticks** sit in a heap keyed by `(dueTick, packedPos)` and are deduplicated with a Map.

**Rules** (`fluidRules.ts`, shared with settle):
- falling is unlimited; spread follows the level rules;
- flow prefers the nearest drop;
- a new source forms between two sources;
- unsupported flow drains;
- lava source + water → obsidian, flowing lava + water → cobblestone, water onto lava → stone.

**Activation.** Only block updates caused by user edits (and their consequences) schedule ticks. Truncated `unsettled` generation fronts wake only when such an update touches them. Every change the sim makes is edit-caused and goes into the DiffStore, so the world is always generated state plus diffs, with no lineage bit.

**Limits:**
- simulation distance by preset (Low 4, Medium 6, High 8), always ≤ RD−2;
- at most 8k updates per tick (about 4 ms), with overflow deferred;
- ticks for columns outside sim distance are kept in the DiffStore trailer and resume when the column re-enters;
- changes coalesce per tick into dirty sections plus relight;
- sim-driven remeshes are throttled to ≤ 10 Hz per section.

### 4.12 Editing

**Raycast.** Amanatides-Woo DDA against the SAB: reach 6 in walk mode, 10 in fly mode. It passes through fluids and hits cross sprites via their AABB.

**Actions.** LMB breaks, RMB places, MMB picks (the type and its non-orientation props). Hotbar 1-9 (defaults: stone, dirt, grass, planks, glass, log, torch, water bucket, lava bucket) or the scroll wheel. Placement is refused when the new state's collision boxes intersect the player AABB.

**Interactions.** RMB on a door, trapdoor or fence gate toggles `open` (both door halves) instead of placing; Shift+RMB always places. A torch item places `torch` on a top face and `wall_torch` with `facing` on a side face, and is refused on a bottom face. Two-voxel states (door, double plant) are placed and broken as one atomic `{edits:[…]}` message, recorded as two diff entries. There are no support checks: blocks whose support is removed stay in place.

**Orientation on place:** logs take the axis of the clicked face; stairs, doors, trapdoors, wall torches and ladders take `facing` from the player's yaw (and the clicked face); stairs and trapdoors take `half`, and slabs take `slabType`: bottom when clicking a top face, top when clicking a bottom face, and on a side face top iff the hit point's y within the clicked block is ≥ 0.5; placing a slab into the empty half of a same-type slab turns it into `slabType=double`; doors take `hinge` from the neighbouring door or the hit point, and place both halves.

**Creative palette (E, D15):** a searchable grid of every block type flagged `PLACEABLE`, grouped by `category`; clicking assigns the selection to the active hotbar slot. A hotbar slot is `{type, pinned: Partial<props>} | {fluid:'water'|'lava'} | {tool:'emptyBucket'}`. Placement computes the orientation props (axis, facing, half, hinge) by the rules above and uses `pinned` only for non-orientation props (e.g. slabType); a small variant picker sets `pinned`. MMB pick stores the type and its non-orientation props. The empty bucket's ray stops at the first fluid voxel and removes that fluid. Hotbar slots persist per world by type name, never by state id.

**Pipeline:**
1. The main thread posts `{edits:[…]}` to the sim worker (two entries for doors and double plants, applied atomically).
2. The sim worker, immediately and not on a tick: validates, writes block and fluid, bumps `blockVersion`, updates heightmaps, relights incrementally, schedules fluid ticks for the 6 neighbours, and records the diff.
3. It posts `{dirty: secKeys}`.
4. The coordinator queues priority −1000 mesh jobs with a new `meshSeq`.
5. Upload happens next frame.

Target: edit → visible ≤ 50 ms p95, measured in the HUD.

### 4.13 Persistence flow

- **World open:** the sim worker loads the `diffs` key index with `getAllKeys`.
- **Prefetch:** as columns enter the T ring, the sim worker prefetches their diffs into its in-memory DiffStore.
- **Read-through:** the coordinator obtains the diff for a D job from the sim worker and transfers it in the job. Edits followed by unload and reload within the flush window can therefore never regenerate from a stale IDB diff (E5).
- **Flush:** every 2 s, and on `visibilitychange` / `pagehide`, the sim worker writes all dirty diffs plus the `worlds` record (player, time, `flushSeq`) in **one readwrite transaction**. Commit is confirmed by `oncomplete`, so at most 2 s of edits can be lost. `navigator.storage.persist()` is requested once.
- **Durable backup:** `.wiworld` export.

### 4.14 Far-terrain LOD (Medium short ring; High and Ultra)

**Clipmap rings** centred on the player and snapped to cell size: L0 4 blocks, L1 8, L2 16, L3 32. Tiles are 64×64 cells.

**Tile job** (low priority, ≤ 60 ms): samples `surfaceEstimate`, the biome, `surfaceWaterLevel` and, in floating_islands, the island top and bottom (a coarse 8-block scan of the islands tap). These are the same functions the map uses.

**Mesh.** Blocky column tops merged by equal height and colour, with skirts where heights differ. Vertices are Int16x4 plus a palette index. Colour comes from the biome's top-block average texture colour × tint. There are water planes at each surfaceWaterLevel.

**Fill mask.** An R8 64×64 torus with one texel per column, set in the same frame as the column's atomic reveal (§4.2). LOD fragments discard where the mask is set, so there is no z-fighting and no hole while streaming.

**Depth.** LOD uses its own near/far (depth partition), then depth is cleared. Fog blends the seam.

### 4.15 Culling

- **Frustum:** per instance via BatchedMesh `perObjectFrustumCulled`, using the precomputed spheres.
- **Cave culling (Checchi):** a main-thread BFS from the camera section through connected faces with `dot(face, fromCamera) ≥ 0`, inside the frustum. The result drives `setVisibleAt`. It re-runs on a section change or a turn of more than 10°, with a budget of 1.5 ms, time-sliced across frames.

### 4.16 Graphics presets

| | Low | **Medium (iGPU 60 fps target)** | High | Ultra |
|---|---|---|---|---|
| render distance | 8 | 12 | 16 | 24 |
| LOD | off | 512 (L0-L1) | 1024 | 2048 |
| AO + smooth light | off | on | on | on |
| leaves | opaque | cutout | cutout + waving | cutout + waving |
| water | Fast | Fancy | Fancy | Fabulous |
| clouds | off | flat | 3D | 3D |
| shadows | – | – | 1 cascade | 2 cascades |
| MSAA / pixel ratio | off / 0.85·min(dpr,1) | off / min(dpr,1) | 4× / min(dpr,1.5) | 4× / min(dpr,2) |
| anisotropy | 1 | 4 | 8 | 16 |
| sim distance | 4 | 6 | 8 | 8 |
| audio: emitter+SFX voice cap / spatialisation / reverb | 16 / equal-power / off | 24 / equal-power / on | 32 / HRTF / on | 48 / HRTF / on |
| upload budget | 1.5 ms | 2 ms | 3 ms | 4 ms |

- Every setting can be overridden individually: RD, LOD, FOV, brightness, fog start, resolution scale, FPS cap, anisotropy, biome blend, water tier, shadows, clouds, AO.
- Changes are Live, except MSAA (a controlled renderer rebuild that keeps the world store) and AO or leaves (a remesh of loaded sections through mesh jobs).
- Settings persist in localStorage (try/catch).

### 4.17 Player

- **Fly:** first-person pointer lock, dt-scaled 12 blocks/s (adjust with Alt+wheel), Ctrl sprint ×4.
- **Ladders:** while the player AABB overlaps a ladder, vertical speed is clamped to ±2.35 blocks/s and Space climbs.
- **Walk:**
  - 0.6×1.8 swept AABB with per-axis substeps ≤ 0.35 blocks, terminal velocity 78, step-up 0.6;
  - swimming: fluids never collide, buoyancy 0.02, drag 0.8;
  - an unloaded column freezes vertical motion instead of counting as solid;
  - unstuck scan upward at spawn; near plane 0.05.
- **FPS limiter:** an accumulator with a ½-frame tolerance, so a cap of 60 on a 60 Hz display renders 60.
- **Keys:** cleared on blur, and ignored while focus is in a text input.

### 4.18 Audio (D10)

**Split.** `audio/` is pure (no WebAudio): deterministic DSP generators that write `Float32Array` samples, plus the decision logic in `audio/model/` (ambience weights, emitter clustering and voice selection, footstep cadence, music scheduling on an injected clock). Both are unit-testable in Node and back the AU metrics. `sound/` is the main-thread WebAudio layer: it only wires `audio/model` decisions to nodes and plays buffers.

**Synthesis jobs.** Generators run as `AUDIO_SYNTH` jobs on the pool. The SFX and ambience bank is synthesised once per page load, after first playable. Music is synthesised on demand as 8-16 s phrases, requested at least one phrase ahead and scheduled with `AudioBufferSourceNode.start(when)` on the context clock (pads are short loops). AUDIO_SYNTH obeys the same ≤ 1-in-flight cap as LOD/MAP while any T is pending within RD (§4.3). All buffers are synthesised at 48000 Hz, mono except the stereo reverb IRs, and wrapped in AudioBuffers of that rate (WebAudio resamples).

**Engine (`sound/engine.ts`).** One `AudioContext`, buses master → {music, sfx, ambient}, each with a persisted volume. The context is **resumed on the first user gesture** (click / pointer lock / key); until then a muted indicator shows (09's context was never resumed). Settings persist in localStorage.

**Procedural synthesis (`audio/synth/*`).** Up to 4 variants per sound, seeded from `deriveSeed(AUDIO_SEED, 'audio.<key>')` with a fixed `AUDIO_SEED`, so the bank is independent of the world; music phrases use `deriveSeed(world, 'audio.music')`; playback applies ±6 % pitch and ±2 dB gain jitter (runtime randomness is allowed outside `core/world/gen`).
- Block sounds per `SOUND` group × event (`break`, `place`, `step`, `hit`): filtered-noise bursts shaped by group (stone: bright short clicks; dirt/grass: dull low-passed thuds; sand/gravel: granular crunch; wood: resonant knock; snow: soft squeak; glass: bright shatter; leaves: rustle; metal: bright ringing clank; abyss: dark low knock). One-shots are ≤ 0.5 s.
- Fluids: splash (enter/exit water), swim strokes, lava pop.
- Ambience beds: each is one seamless 8 s mono loop — wind (band-passed noise, gain ∝ altitude and openness), surf (slow-modulated noise), cave drone, abyss drone — plus one-shot grains scheduled by the ambience layer: drips (sine plucks through reverb), birds (FM chirps, day, forest/plains biomes), crickets (night, warm biomes), abyss rumbles and sparse drips.
- Reverb impulse responses generated procedurally (exponentially decaying noise): three fixed IRs (open 0.4 s, room 1.2 s, cave 2.5 s) in three ConvolverNodes, always running while the preset enables reverb. Enclosure only cross-fades their send gains over 1 s; buffers are never swapped at runtime.

**SFX (`sound/sfx.ts`, `footsteps.ts`).** Break/place from `interaction`; footsteps triggered by distance walked (every ~1.6 blocks at walk speed) using the `SOUND` group of the block under the feet (or the fluid when swimming).

**Ambience (`sound/ambience.ts`).** At 4 Hz the listener context is estimated: enclosure (eye sky light + 8 short probe rays against the SAB), altitude, biome and cave biome at the feet, time of day, and the distance to the nearest ocean, beach or river column (found at 1 Hz by scanning the aux `surfaceBiome` of loaded columns on a 4-block grid within 64 blocks of the listener; ∞ beyond). Beds cross-fade (2-4 s) by weights from `audio/model/ambienceModel.ts`; the reverb sends follow enclosure.

**Positional sources (`sound/emitters.ts`).** Mesh jobs are the only producer; a sim fluid change reaches them through the remesh it triggers. Emitters ride on the section's translucent-pass SectionMesh (an empty one if needed). Kinds: `waterfall` = a run of ≥ 3 falling water voxels counted within the section plus padding (a run crossing a section border is reported by both sections and merged by clustering); `river` = water surface voxels at y 63 in columns whose aux `surfaceBiome` is river or frozen river (the job copies the centre column's aux surfaceBiome); `flow` = non-source water surfaces; `lava` = lava surfaces. Each is reported as `{secKey, kind, centroid, strength}`. `audio/model/emitterCluster.ts` yields exactly 1 candidate per 8-block cluster per kind, and the nearest candidates up to the voice cap (§4.16) play looping sources through `PannerNode` (HRTF at High+, equal-power below) with distance attenuation and occlusion approximated by the listener's enclosure.

**Music (`sound/music.ts`).** Generative: scale/mode chosen from `(seed, biome family, time of day)`, sparse piano phrases (additive/FM with a soft envelope) over slow pads, 2-5 min per piece. The **music frequency** setting schedules the gap between pieces: **Always** = the next piece starts right after the previous one; **Frequent** = gaps of 3-5 min; **Standard** (default) = gaps of 10-15 min; **Never** = music disabled. The first piece starts after one gap drawn from the setting's range, counted from the first user gesture (Always: 5-10 s). Gaps are uniform in the range, drawn from the music RNG. Sound-pack tracks join the rotation with the same weight as procedural pieces. Changing the setting redraws the pending gap.

**Sound packs.** Manifest `{format:'wi10-sounds', sounds:{'block.stone.break':[files], 'ambient.cave':[files], …}, music:[files]}`, loaded like resource packs (directory or files), parsed by `audio/soundPack.ts`, decoded with `decodeAudioData` in `sound/`, and stored through `persist/` in IndexedDB `packs` (`kind: 'sounds'`). Keys are exactly `block.<soundGroup>.<break|place|step|hit>`, `fluid.<splash|swim|lavaPop>`, `ambient.<wind|surf|cave|birds|crickets|abyss>` and `emitter.<waterfall|river|flow|lava>`; unknown keys are ignored with a warning, and fallback to procedural is per key. Switching is Live.

## 5. Customization and UI

### 5.1 Parameter model, scopes and invalidation

`core/params/schema.ts` is the single source of types, defaults and `ParamMeta` (label, doc, unit, range, step, scope, stage, effectMetric). The panel, import merge, migrations, stage slicing and the README parameter reference are all generated from it. The U4 `readmeStale` metric part (active since SP1) fails when the README's generated block is stale.

**Stage hashes.** `stageHash = fnv1a64(`${id}|${version}|${canonicalJSON(slice)}|${reads.map(r => hex64(H[r])).join(',')}`)`, with `slice = {[prefix]: getPath(params, prefix)}` over the stage's param prefixes (matched on dot boundaries). It does not depend on the seed and decides exactly which stages re-run; live leaves have no stage and are hashed by none. Real checkpoints are:
- raw climate (in ColumnSample);
- derived shape (in ColumnSample);
- proto (in the outer rings, or everywhere in tuning mode);
- final.

| scope (badge) | examples | re-runs | kept |
|---|---|---|---|
| Live | time of day, fog, graphics, biome blend radius, colours, tint colormaps, packs (same layer count), audio | nothing (uniforms, textures) | all |
| Remesh | AO/smooth light, leaves mode | mesh | all voxels |
| Decorate | features, ores, vegetation, structure sets without beard | D → L → mesh (T re-runs only where the proto is gone; tuning mode keeps every proto) | ColumnSample, proto |
| Terrain | splines, rivers, lakes, density DAG, caves, carvers, aquifer, surface rules, biome tables, cave biomes, beard-carrying structures | derived shape → T → … | raw climate noise |
| Climate | seed¹, climate noise defs, warps, scaleMul | everything | nothing |

¹ The seed is WorldSession state, not a leaf; it enters genKey directly. A profile is an overlay, not a leaf: switching profile has the scope of the earliest stage it dirties (`dirtyStages`).

**Apply.** An explicit button, or auto-apply with a 500 ms debounce. It bumps the epoch *from the dirty stage onward* and re-queues loaded columns nearest-first.
- **Old meshes stay visible until replaced**, column by column and atomically (§4.2). There is no teardown and no worker restart; workers get one `configure` message.
- Meshing waits until all 3×3 columns share the epoch.
- Each control shows a scope badge and a modified dot. A header shows "n unapplied changes" plus per-stage progress (`stale/total`).

**Preview.** Column-scope edits re-render the map and LOD coarse-first within about 300 ms, before Apply.

**Until SP4** (amended by SP2b): the map previews the draft and there is no Apply. The session's gestures (a drag is one gesture whose edits are not urgent; its release is urgent) and its urgent commits are the hooks SP4's Apply and SP5's fork dialog attach to.

### 5.2 Panels (CSS grid shell)

- **World:** seed (typed seed is authoritative; separate "Regenerate same seed" and "New seed" buttons), profile, presets, worlds.
- **Parameters:** sections collapsed by default, slider plus numeric input, reset per parameter and per section, tooltips. Inline dialogs replace `prompt()` and `alert()`.
- **Settings:** graphics and audio (master, music, sfx and ambient volumes; music frequency Always / Frequent / Standard / Never; sound pack).
- **Help:** key map (H / F1).

### 5.3 Spline editor (nested Hermite)

- A tree navigator with breadcrumbs, e.g. `offset › C=0.30 › E=−0.40`.
- SVG with draggable points and tangent handles, numeric entry, add, delete, nest and flatten (editor operations), reset per spline.
- **Tangents are data** (amended by SP2b): moving a knot never changes a tangent; tangents change only by their handle, their numeric field or an explicit auto-tangents action, per node or per spline. A new knot gets the automatic tangent. Automatic tangents are clamped to ±1e5, the validator's bound (§3.3).
- **Undo and redo are global over the draft** (amended by SP2b): one history of 100 steps for every editor, the seed, the profile and preset loads, instead of 50 steps per spline; one drag is one step.
- The axis comes from the typed `NestedSpline.coord`, so there is no title sniffing.
- Overlays show the **histogram of the coordinate's sampled distribution** and per-segment area shares ("covers 7.3% of land"). Under CDF-uniform climate the histogram is flat only for C, E, W, T and H: PV is folded from W, and nested nodes are conditional on their bracket (amended by SP2b).
- The y-axis is in blocks.
- A 1D cross-section profile along a line through the view shows offset ± σ, jag, rivers and lakes from the column stage (SP2b: a two-click line on the map, profiled in a drawer tab).
- The map updates live. Shapes export and import as `{format: 'wi10-shape', leaf, spline}`; `leaf` is optional on import, and a file naming another leaf imports with a notice if it validates against the open leaf (amended by SP2b).

### 5.4 Biome table

- Editable boxes (amended by SP2b): `[lo, hi]` on 5 axes (C, E, PV, T and H, within [−1, 1]), `wSign` (−1, 0, +1) and a unique priority, no weights, for the 26 box rows of the surface biomes. River and frozen river come from the river flag, the height filter narrows the boxes by sea level (§3.10), and the 3 cave biomes arrive in SP6.
- A share preview samples 100k column-stage points on the pool (≈ 270 ms on 6 workers; amended by SP2b) and shows a bar chart.
- Warnings for unreachable (< 0.1%), dominant (> 16%) and tied biomes, an ocean family outside 25-45 % and more than 2 % outside every box (B1's limits).
- Hovering a row highlights that biome on the map.

### 5.5 Density inspector, taps, mutes, probe, slice view

- **Inspector:** a tree of `density.defs` and taps, with a param form per node and a JSON text editor with schema validation.
  - Slice preview: XZ@y, XY@z or ZY@x; extent 256-8192; diverging colormap with a 0-contour and a sea-level line.
  - Histogram: p1/p50/p99, sd and % < 0.
  - Up to 3 pinned slices side by side, and a mute toggle per tap.
- **Slice view (L):** any 3D field (final density, each cave term, carver mask, aquifer level and status, biome3d, stone depth, blocks, cave-type tint, light for loaded columns). It re-renders on param edits.
- **Probe:** at the crosshair, map hover or slice hover. It shows climate, shape, every tap, carver hit, aquifer cell / level / status, biome 2D and 3D, the **surface-rule branch path taken**, light and stage hashes. A button copies it as JSON.
- **JSON editors** (textarea plus validation) cover surface rules, placed features and structure sets/pools. A visual editor is out of scope.

### 5.6 Map view (M; worker tiles)

- **Tiles:** 256² px, rendered as `MAP_TILE` jobs on the pool through the same column-stage functions, cached by `(layer, zoom, tile, stageHash)` in an LRU, and transferred as ImageBitmap. The LRU holds `max(256, 3 × (visible target-level tiles + visible preview tiles))` entries (the view's level counted once when it is the preview level), recomputed on resize and on every view change, and biome-layer entries hold `{bitmap, ids}` (amended by SP2b).
- **Refinement is coarse-first:** a 256 blocks/px preview (climate, shape and biome only), then 64 → 16 → 4 blocks/px (amended by SP2a). Zoom is continuous from 1/4 to 256 blocks/px, anchored at the cursor.
- **Layers:**
  - biome, shaded relief (surfaceEst), rivers, lakes;
  - raw T/H/C/E/W/PV/R;
  - offset, σ, jag;
  - cave slice at y (final < 0 plus aquifer fluid), cave-biome slice;
  - structure starts and pieces, carver tunnels;
  - spawn, player with view cone, grid, column-status heatmap, bookmarks per save.
- **Hover** uses a sampler cached per epoch. **Click** teleports (3.7).
- The 3D view keeps streaming at reduced priority while the map is open.

### 5.7 Metrics dashboard

- Runs the `src/metrics` functions that vitest uses, in workers, over a chosen region (default 32×32 chunks at the camera).
- Shows pass/fail against the locked thresholds, histograms, and a "compare with previous params" delta.
- **Seed sweep** (up to 16 seeds) is available for column-scope metrics only: biome shares, heights, rivers, lakes.

### 5.8 Debug HUD and bench

**F3 overlay:**
- position, column, section;
- biome (surface and quart), T/H/C/E/W/PV/depth at the feet;
- sky and block light at the eye;
- block state (id, type and properties) and fluid byte under the cursor.

**Performance HUD (4 Hz):**
- FPS and a frame graph, main-thread ms, GPU ms per pass (`EXT_disjoint_timer_query_webgl2`);
- `renderer.info` draw calls and triangles;
- queues per job type and stage p50/p95;
- column-status histogram, slab usage, SAB and heap MB;
- sim TPS and tick ms, edit latency p95, throttle level.

**Toggles:** chunk / section / region borders, wireframe per pass, freeze culling, light false colour, LOD tint.

**Bench route `?bench=<preset>`:** a fixed seed and a 60 s scripted flight (plains, mountains, ocean, cave, flood scenario). It downloads JSON (frame p50/p95/p99, max, fill time, draw calls, GPU ms, memory), which the vitest file check G1 asserts.

### 5.9 Controls

WASD; Space (up/jump); Shift (down/sneak); Ctrl (sprint); F (walk/fly); M (map); L (slice); I (inspector); P (params); G (graphics); E (creative palette); F3 (debug); H/F1 (help); 1-9 and wheel (hotbar); LMB / RMB / MMB (break / place / pick); Esc (release pointer). Audio volumes and music frequency live in Settings.

## 6. Testing

### 6.1 Harness and suites

**Harness** (`test/harness/region.ts`): `genRegion({seed, params, cx0, cz0, w, h, upTo:'T'|'D'|'L'|'MESH', order:'spiral'|'shuffled', threads?:1|4, debugTags?})`.
- It runs the **real stage functions and coordinator prerequisite rules** in-process, on a real SAB store (or a plain ArrayBuffer), with `worker_threads` for the thread matrix.
- It returns a `RegionView` (block, fluid, light, fields, biome, tags) plus per-stage timings. The view reads through the store per column and is never stitched into one array (a 32 × 32 region would be about 300 MB; amended by SP3a).
- SP3a's `genRegion` has `upTo: 'T'` only, plus `cache?` and `shuffleSeed?`, and no coordinator prerequisite rules until SP4 (amended by SP3a).

**References** (`refs.ts`):
- global reference light BFS;
- brute-force visible-face count;
- flood from sky and connected components;
- a raycast visibility reference for cave culling.

**Region cache** (`cache.ts`): binary dumps keyed by `genKey + srcKey + REGION_CACHE_FORMAT + region + upTo`, plus `stageHash('mesh')` when upTo is 'MESH', in `test/.cache/regions`. `srcKey` hashes the generator sources and the format version is bumped when the dump layout changes, because `genKey` does not track code changes made without a stage bump (amended by SP3a). Format 2 stores each column's aux A and then aux B, and the region hash covers aux B too; CI restores `test/.cache/regions` with `actions/cache` before `npm run test:metrics` (amended by SP3b).

**Suites:**

| command | contents | time |
|---|---|---|
| `npm test` | unit + arch + fast metrics | < 60 s |
| `npm run test:metrics` | 2 seeds, cached | < 5 min, every SP |
| `npm run test:metrics:full` | 8 seeds | SP exit |
| `npm run bench` | vitest bench vs `baselines.json` (each kernel as a ratio to a calibration kernel measured in the same run, ≥ 4096 evaluations per call; `npm run bench:record` writes the baseline on the reference machine); fails on > 30% regression and prints absolute targets | |

Metric values are written to `test/metrics/.out/*.json` for trends. The harness exports PNG slices and map snapshots for the visual review each SP requires.

### 6.2 Governance

- **Thresholds** live in `test/thresholds.ts`. `thresholds.test.ts` compares a hash against `thresholds.lock.json`, so changing one requires `npm run test:accept-thresholds` and a spec amendment. Agents cannot silently loosen a gate. A part may list the metric tiers it gates on (`tiers`, absent = every tier); on the other tiers its value is recorded, never gated, and dropping a tier counts as loosening (amended by SP3b, whose T3 gates on the full tier only).
- **Goldens** (region hashes per built-in preset, per stage) change only via `npm run test:goldens`. A golden change requires a `GENERATOR_VERSION` bump, which a test checks.
- **Dev saves** whose genKey no longer matches (stale generatorVersion or params) go through the fork dialog of §2.7 (option 3 is read-only with a warning).

### 6.3 Unit tests (selection)

- **Hash/RNG:** published vectors; avalanche 50 ± 2% (fmix32 at 100k per bit, hash2/3/4 at ≥ 20k per word and bit); no hash2 reflection pairs; `deriveSeed` bijective in world[0] and collision-free over all schema names × octaves; `nextInt` has no modulo bias (χ² p > 0.01, modulo as negative control).
- **detMath:** acceptance error ≤ 2e-6; design bounds, special values, symmetry, monotonicity, literal bits and a CPython oracle as in the SP1 spec (T-DM1-T-DM7).
- **Splines:** C0 at every knot of every node (1 ulp either side, < 1e-9); C1 at interior knots on a fixture with non-zero tangents; hold semantics; compiled == reference bit-exact; batch == point; knot-raise linearity; validation paths; zero allocation.
- **Packing:** round-trip, and the GLSL defines equal the TS constants.
- **Store:** slab fuzz (4 threads × 100k alloc/free, 0 double allocations); uniform ↔ dense promotion; refcounted proto/final sharing.
- **Compiler:** DAG validation errors carry the node path; compiled == reference bit-exactly on 100k points for every built-in preset.
- **Scheduler:**
  - nearest-first;
  - no D before 3×3 T, no L before 3×3 D, no mesh before 3×3 L;
  - stale epoch, version or `meshSeq` results are dropped;
  - cancel on leaving range;
  - `update()` without movement allocates 0;
  - old meshes are kept on Apply;
  - the throttle reacts to a simulated frame p95.
- **Fluid rules:** diamond of radius 7; fall; infinite source; drain; reactions; the settle distance cap.
- **Lightmap:** (0,0) ≤ 0.02 luminance; block light independent of time; phases match the sign of sun elevation.
- **Rendering setup:** colour-space assertion; glass meshed in the cutout pass; the fog shader uses `length(viewPos)`; water has OPACITY 1, PASS translucent and no collision, is meshed in the translucent pass, and sky light 3 blocks under open still water is > 0.
- **Mesher AO:** the per-vertex 3-sample table [1, .8, .6, .45] and the diagonal flip (quad split chosen by AO sums) on canned 3×3×3 neighbourhoods.
- **FPS limiter:** ≥ 59.5 fps at cap 60 on simulated 60 Hz timestamps.
- **Physics:** swept, step-up, swim, sink in water, unloaded ≠ solid.
- **Presets:** migrations via an injected v1 → v2 list, patch over the profile, reserved names, import order and error paths, import loads, export writes the current draft.
- **Session:** the typed seed is used; "same seed" regenerates the same world; URL round-trip.
- **Invalidation:** stage-run counters per scope (U1).
- **Persistence:** codec, `.wiworld` and fault-injection round-trips (E1-E6).
- **Resource-pack manifest:** fallbacks and overlays.
- **Painters:** determinism hash; tileability (wrap-edge gradient ≤ 1.2 × interior mean gradient); ≥ 2 variants per block with mean |Δ| ≥ 4/255 between variants; ≤ 6 palette colours per base tile.
- **Block states:** property table round-trips; `rotateState` for every property kind; placement orientation from yaw/hit point; connection-derived fence/pane/stair shapes from neighbour masks; box-model culling against `FULL_FACES`; collision and raycast against boxes.
- **Audio:** DSP generator determinism and peak bounds; sound-pack manifest fallbacks; music scheduler per frequency setting; footstep cadence; ambience weights for canned contexts; `sound/engine` calls `resume()` on the first click, keydown or pointer lock (fake AudioContext) and clears the muted indicator on `running`.
- **Palette:** every placeable type and state is reachable through the grid and variant picker; assigning writes the active hotbar slot; hotbar round-trips by type name.

### 6.4 Metric tests (IDs; thresholds locked)

| id | metric | threshold |
|---|---|---|
| N1 | climate CDF-uniformity: per (seed, field) KS D of u vs U(−1,1), 16 seeds × 50k random points in [−2^19, 2^19)²; per-seed \|sd(z) − 1\| | ≤ 0.015; ±2% |
| N2 | \|r\| between schema noises at the same seed, and f([b,0]) vs g([b+k,0]), k = 1..64, n ≥ 100k random points | ≤ 0.02 |
| N3 | aperiodicity: mean\|f(p) − f(p+P·λ0·e)\| for P ∈ {256…4096}, e ∈ {x, z, xz} (+y), all noises incl. single-stack | ≥ 0.9 × random-pair mean |
| N4 | origin: sd of each field at (0,0) over 64 seeds / spawn | ≥ 0.8 × global sd; most common spawn biome ≤ 30%; ≥ 8 distinct spawn biomes; spawn on land 100% |
| N5 | 16-bin gradient-direction histogram (central differences, h = λ_min/128), max/min, noises with ≥ 2 lattice terms; horizontal plane and vertical plane of 3D noises, the vertical one in lattice coordinates (the gradient of z3(x, y / yScale, z), so a noise with yScale ≠ 1 is not failed by construction; amended by SP3b) | ≤ 1.15 each |
| N6 | lattice zeros: P(\|z\| < 1e-6) at integer points and 4×8×4 corners, incl. adversarial single-stack small-λ defs | ≤ 0.1% |
| T1 | land heights: largest 10-block band / p5..p95 span / share y > 120 / share y > 200 | ≤ 25% / ≥ 60 blocks / ≥ 6% / ≥ 0.5% |
| T1lowland | share of land columns with offset0 in [66, 76) on the pure offset (SP2a) | ≤ 40% |
| T2 | land columns with ≥ 2 solid→air transitions above surface − 30 (pre-cave) | ≥ 1.5%, ≥ 10% in peaks/windswept (amplified: Z1) |
| T3 | P(\|Δh\| ≥ 4 across a border between two lowland biomes) / P(within those biomes), stratified by the pair's biomes (SP3b spec §8.2); gates on the full metrics tier only, fast and quick record it | ≤ 1.5 |
| T4 | ocean floor sd per 256² / exposed bedrock under water / floor ≤ −50 | ≥ 3 / 0 / 0 |
| T5 | surfaceEst vs true top (single-surface, no canopy); SP3b: `surfaceEst3` vs the voxels' true top at land positions with exactly one solid→air transition above y −56 (amended by SP3b) | median ≤ 1, p90 ≤ 2, p99 ≤ 6 |
| T6 | spline gain: raising a knot by 10 blocks, `gain = ΣΔoffset_col / Σw_col` over columns with w_col > 0 (w_col = product of Hermite value-basis weights along the knot path, tangents fixed), one knot per depth | 10 ± 1.5 |
| T7 | steep continuity: border/interior gradient ratio | 0.9-1.1 |
| T8 | per-axis relief in the default profile: sd of land `offset` from varying E_u over [−1,1] (resp. W) at sampled C, W (resp. C, E), on the column-stage point path | E ≥ 10 blocks / PV ≥ 10 blocks |
| B1 | surface biome shares | each ≥ 0.3% (rare ≥ 0.1%); largest land biome ≤ 16%; ocean family 25-45%; exact ties 0; outside all boxes ≤ 2% |
| B2 | rivers: water at surface / median connected length / share of land / river-biome columns without surface water (SP2a's 2D statement, kept 2D by SP3b; a voxel river-water check comes with SP3c) / river components ≥ 300 blocks that touch ocean water / gorge columns cut ≥ 8 blocks below offset0 per 100 km² of land with offset0 ≥ 120 | ≥ 95% / ≥ 300 blocks / 2-7% / 0 / ≥ 50% / ≥ 1 |
| B3 | cave biomes per 8×8 km | lush, dripstone, abyss each ≥ 0.5% of cave air |
| B4 | hot/cold columns in windswept or spruce / snow in desert / coast-band land columns that are beach, stony shore or snowy beach / land-biome tops below sea level outside rivers and lakes | < 1% / 0 / ≥ 70% / ≤ 1% |
| B5 | lakes per km² of land / share with Lw ≥ 70 / lake water with air horizontally adjacent | 0.2-2 / ≥ 30% / 0 |
| C1 | cave void / underground (y −56..surface − 8) | 5-15%; cave_heavy 10-22% |
| C2 | sky-connected components reaching ≥ 8 below the pre-cave top / sky-connected share of cave air within 40 blocks of the surface | ≥ 20 per km² / ≥ 20% |
| C3 | per-type volume share (debug tags) / pillars / ravines | cheese ≥ 20%, spaghetti ≥ 10%, noodle ≥ 2%, carvers ≥ 10%, entrances ≥ 2%; pillars in ≥ 90% of 8×8-chunk blocks; ravines ≥ 10/km² (sky-exposed ≥ 3/km²) |
| C4 | carve per 16-block y band −56..40 / largest single y of large-component floors | ≥ 2% each / ≤ 10% |
| C5 | largest component / land columns with carved voxels / median thinnest axis | < 60% of void / ≥ 60% / ≥ 4 |
| C6 | lattice-plane bias: max y-plane carve rate / mean | ≤ 1.1 |
| A1 | dry share of cave air below y 63 not connected to sea or rivers | ≥ 40% |
| A2 | fluid voxels unsupported below or sideways after settle, **counting unsettled** / unsettled share | ≤ 0.1% / ≤ 0.1% of fluid voxels |
| A3 | 32×32-column harness regions with lava below −54 / aquifer lava above −10 / lava with support / regions where lava touches sky-connected cave air | ≥ 50% / 0 / ≥ 99% / ≥ 25% |
| A4 | aquifer water bodies per 32×32-column harness region | ≥ 1 |
| S1 | buried surface blocks / grass at sky 0 / surface y mod 16 χ² | 0 / ≤ 0.1% / p ≥ 0.001 |
| S2 | deepslate share of stone below 0 / above 8 / bedrock at −64 | ≥ 95% / ≤ 1% / 100% |
| S3 | ice or snow not sky-exposed / snow at or above snowline(T) / sky-exposed still-water surface voxels with T_eff < −0.45 that are ice / frozen ocean and frozen river columns with an ice top | 0 / ≥ 90% / ≥ 95% / ≥ 90% |
| O1 | each ore in its band per 4×4-column block / iron voxels per column / diamond below 16 / y mod 16 χ² | ≥ 95% / ≥ 30 / ≥ 90% / p ≥ 0.001 |
| O2 | abyss mineral: 8×8-column blocks containing abyss cave air that contain the mineral / mineral voxels outside the abyss cave biome | ≥ 90% / 0 |
| V1 | forest Clark-Evans R / VMR at 64-block quadrats / (x mod 5, z mod 5) residues | 0.9-1.2 / > 1.2 / χ² p ≥ 0.01 |
| V2 | floating trees / buried trunks / missing canopy voxels across borders | 0 / 0 / 0 |
| V3 | border-strip (x mod 16 ∈ {0,15}) vs interior density of trees and decorations | 0.85-1.15 |
| V4 | realised vs declared per placed feature (incl. glow lichen) | ±20% |
| V5 | trunk height vs (x+z)&3 | χ² p ≥ 0.01 |
| V6 | `vegetation.enabled = false` | 0 trees, 0 plants |
| X1 | villages per 100 km² / start x mod 16 / piece overlaps / median pieces per village | ±35% of analytic / χ² p ≥ 0.01 / 0 / ≥ 8 |
| X2 | rigid floor cells supported / clearance above / starts below surfaceEst − 4 | ≥ 95% / ≥ 95% / 0 |
| DT1 | region hash: spiral vs shuffled, 1 vs 4 threads, cold vs warm, 2 runs, goldens | exact |
| DT2 | probe == bulk / compiled == reference / batch == point (column stage, at quart corners). SP3b's parts: `probeBulk` counts voxels whose probe solidity differs from the block, and voxels the bulk evaluated where `Object.is(probe, bulk)` fails; `compiledReference` counts corner and voxel values where compiled ≠ reference; batch == point stays a unit test (amended by SP3b) | 0 mismatches / bit-exact / bit-exact (tightened by SP2a) |
| R1 | hidden seam faces emitted / visible faces missing vs brute force | 0 / 0 |
| R2 | greedy quads per visible face (AO on / off) | ≤ 0.6 / ≤ 0.35 |
| R3 | wrongly culled sections vs raycast reference / culled from an underground camera | 0 / ≥ 50% |
| R7 | atomic reveal during the bench flight and a terrain Apply: frames in which a column shows some but not all of its non-empty sections, or mixes old- and new-epoch sections (edit/fluid remeshes excluded) | 0 |
| R4 | quads per column, incl. cave walls, leaves, water | median ≤ 2000, p95 ≤ 4000 (measured in SP4; asserted with full content in SP8b; sets the GPU budget) |
| R5 | water surface quads per face | ≤ 0.1 |
| R6 | fill-mask consistency during the bench flight: columns with the mask set but unmeshed non-empty sections / columns in LOD range with neither mask nor an uploaded LOD tile / LOD island top and bottom vs voxel (floating_islands) | 0 / 0 / ±8 blocks |
| L1 | light vs global reference BFS (sky + block), interior columns | 0 mismatches |
| L2 | enclosed cave air ≥ 16 deep with sky > 0 | 0 |
| L3 | 500 random edits incl. shaft open/close: incremental vs full recompute | 0 mismatches |
| F1 | fluid rules: 1 source converges to a radius-7 diamond / tick log over 2 runs | ≤ 40 ticks / identical |
| F2 | worst-case flood (ocean wall into a 100k-voxel cave net) | updates ≤ cap per tick; diff ≤ 5 B per changed voxel; remesh ≤ 10 Hz per section; tick p95 ≤ 4 ms |
| F3 | D18: region loaded with the sim running 2000 ticks and no edits → ticks executed / DiffStore entries / unsettled voxels changed; one edit adjacent to an unsettled front → ticks scheduled only within that front's connected fluid | 0 / 0 / 0; exact |
| E1-E6 | diff codec; `.wiworld` round-trip hash; reload with edits hash; fault-injected aborted flush consistent (flushSeq); edit→unload→reload returns the latest diff; genKey mismatch shows the fork dialog and each option (including Cancel) yields its specified world state | exact |
| E7 | two worlds with the same genKey: edits in one never appear in the other / delete removes every `diffs` key of that worldId / hotbar and player restored per world / `stateTable` remap on load | exact |
| U1 | stage-run counters: decorate edit re-runs only {D, L, mesh}; terrain edit spares raw climate; climate re-runs all | exact |
| U2 | param liveness: ±15% on each non-live param changes its stage output hash in ≥ 1 of 16 columns. SP2b (its spec §7): perturbations per kind (number and int ±15 % of \|v\| or of the range span, noise wavelength, every numeric spline knot by 15 % of the y span, box intervals shrunk and grown by 15 %); the stage output hash of the leaf's home stage (climate, shape or biome2d); 16 class columns chosen by the lattice conditions under which leaves act (land, coast, channel, gorge, basin, rim and one per lake gate), and bounded witnesses for leaves no class column decides (amended by SP2b). SP3b adds the `terrain` stage: its output hash is the region hash of one column after `fillColumnT`, tried at the land and coast class columns only, with no witness search, and every `density.*` leaf must be decided (amended by SP3b) | 100% |
| U3 | no-placebo: params with `effectMetric` move that metric by > 0.5% at ±15% | 100% |
| U4 | registry invariants (every leaf has meta and scope, every non-live leaf a covering stage); migration invariant, fixtures and export → import identity; schema-shape lock; README generated block is fresh | exact (0 issues each) |
| Z1 | amplified: land columns with ≥ 2 transitions (T2) / p99 land height | ≥ 8% / ≥ 250 |
| Z2 | archipelago: ocean share / islands ≥ 1 km² per 100 km² | 60-75% / ≥ 20 |
| Z3 | floating_islands: 8×8 km columns with solid ground at y 190-270 / island top runs that are grass | ≥ 3% / ≥ 90% |
| Z4 | large_biomes: mean surface-biome patch area vs default | ≥ 8× |
| P1 | stage bench vs baselines | ≤ +30% regression; targets per section 7 |
| G1 | bench JSON at Medium on the reference Iris Xe, and at High on the reference RTX 3060 Mobile (asserted from the committed artifacts, which record the WebGL renderer string) | Medium: p95 ≤ 16.7 ms, no frame > 33 ms while streaming, draw calls ≤ 100, RD12 fill ≤ 6 s with the 4-worker cap, first playable (RD4 meshed) ≤ 1 s, GPU estimate ≤ 150 MB, main thread ≤ 6 ms p95. High: p95 ≤ 16.7 ms, no frame > 33 ms while streaming, JS heap + SAB ≤ 450 MB (draw calls recorded, not gated) |
| G2 | edit → visible p95 / terrain Apply: first visible change near the player | ≤ 50 ms / ≤ 0.5 s |
| M1 | block-state registry: used states / shape boxes on the 1/8 grid / `rotateState` 4× identity and `withProp` round-trip / `stateIds.lock.json` entries unchanged | ≤ 4096 / 100 % / exact / exact |
| AU1 | procedural synthesis determinism: buffer hash per (seed, key, variant) over 2 runs and 2 workers; no NaN/clipping (peak ≤ 0.99) | identical / 0 |
| AU2 | voices under the worst-case scene (waterfall field + river + lava lake + footsteps) | voices playing ≤ preset cap (the cap counts positional emitters and one-shot SFX; music and ambience beds are exempt); clustering yields exactly 1 candidate per 8-block cluster per kind, and the nearest candidates up to the cap play |
| AU3 | ambience classifier at 2000 random air or water positions in harness regions (upTo 'L'), against independent labels: underwater = eye voxel has water; abyss = cave biome abyss at the eye; cave interior = eye in an air component that is not sky-connected (refs flood); open surface = eye within 3 blocks above WORLD_SURFACE with sky 15 | ≥ 95 % correct labels |
| AU4 | footstep group for the block under the feet (all placeable states); music scheduler gaps per frequency setting on a simulated clock | 100 % / within the stated ranges, 0 pieces when Never |

### 6.5 Pain-point traceability (09 defect → mechanism → test)

**Noise and seeding:**
- Same beach spawn, lattice zeros, 480-block Birch grid → random octave origins, hashed lattice, different T/H wavelengths, spawn search → N4, N6, B1.
- seed+k aliasing and LCG-biased shuffle → `deriveSeed` (no permutation table) → N2.
- ±0.45 range, dead spline ends and biomes → NormalNoise + CDF → N1, B1.
- 256-periodicity → hashed lattice → N3.
- Diagonal bias → 12 balanced-gradient 3D noise → N5.

**Terrain shape:**
- Lowland shelf and biome-owned shape → climate-only splines in blocks → T1.
- 2.5D terrain → σ overhang + jag → T2.
- Border steps and the 25-tap blur → no biome shaping → T3.
- Flat bedrock ocean floors → ocean splines + σ, world down to −64 → T4.
- Blobby identical fBm everywhere → warps, PV fold, ridged jag, rivers, lakes → T1, B2, B5, PNG review.
- Placebo splines and hidden constants → direct outputs, arch ban on tunables → T6, T8, U2, U3.
- Chunk-edge-clamped slope → steep from the quart halo → T7.

**Performance and duplication:**
- 2D work recomputed per vertical chunk and costly sky chunks → column jobs, uniform sections, interval early-outs → P1, DT2.
- Map height ≠ world, 5 copy-pasted classifiers → one column stage + surfaceEst → T5, DT2.
- No altitude lapse → `T_eff` → S3, B4.

**Caves and underground:**
- Sealed 15-19 block shell, scratch entrance gate → non-ramped entrances + carvers → C2.
- One percolating morphology and dead noodle → cave family, noodle as a separate min → C3, C5.
- Floor at −6 → −64..320 world, slides → C4.
- Lattice-plane cave bias → random origins → C6.
- Global flood and opaque water → aquifers, fluid byte, translucent pass → A1, R5, physics tests, water pass and water light unit tests.
- No-op or uncontained aquifers → barriers + exact settle → A2, A4.
- Unreachable or 2D lava → lava aquifers + lava lakes → A3.
- Chunk-local depth (buried grass, no deepslate, no iron, banding) → whole-column scan + ore features → S1, S2, O1.
- Unused cave biomes and dead depth axis → 3D quart picker → B3.
- Glowstone columns → 3D glow lichen → V4.
- Underground ice → freeze on sky-exposed only → S3.
- Ice never generated (07/08) → freeze_top_layer in D → S3 (ice-presence parts).
- Abyss content (D14) → abyss cave biome + exclusive ore feature → B3, O2, V4, AU3.
- Chunk-local skylight leaks → exact 3×3 light → L1, L2.

**Biomes, vegetation, structures:**
- Order-dependent ties and unreachable biomes → priority tie-break + uniform climate → B1.
- Windswept in deserts, coastal mismatch → T-bounded boxes, beach band → B4.
- Tree lattice, 640-block repeat, parity heights, density ≠ slider, bare borders, cut spruce, floating trees, vegetation toggle ignoring trees → jittered grid on hashes, pull model, real heightmaps → V1-V6.
- Grid-aligned, rare, terrain-unaware structures, structures in caves → sets, jigsaw, beardifier, surfaceEst starts → X1, X2.

**Rendering:**
- 71-77% seam faces → padded 18³ → R1.
- Seams, AO and light at borders → exact light + padded mesh → L1, R1.
- Lighting model (lit caves, sun in caves, block light dims at night, double shading) → lightmap shader with no Lambert → lightmap unit tests.
- NoColorSpace → sRGB assertion.
- FIFO streaming, per-frame Sets, stale results → heap, torus, epochs, versions → scheduler tests.
- 52 B vertices, double copies, DoubleSide + alphaTest everywhere, invisible glass, about 2.3k draw calls → 8 B vertices, 3 passes, RegionBatch → R2, packing test, pass test, G1.
- Planar fog, flat sky, dusk timing → spherical fog, dome, elevation phases → fog and phase unit tests.
- Weak textures and double tint → painters + tint mask → painter hash and quality unit tests, pack tests, visual checklist.
- No LOD or graphics options → presets + LOD + fill mask → T5 on LOD samples, G1.
- FPS limiter and fly speed tied to frame rate → accumulator, dt → unit test.

**UI and history:**
- Full teardown per change → stage hashes, old meshes kept → U1.
- Title sniffing → typed coords → unit test.
- Dead controls → U2, U3.
- Seed, map-refresh and preset bugs → WorldSession, map keyed by stageHash, migrate/applyPatch → session and preset tests.
- Hard-coded 80 px layout → CSS grid.
- Monolithic panel and duplicated schema → ParamSchema → U4.
- Slow main-thread map → worker tiles.
- Walk physics → unit tests.
- All-air memory → uniform sections.
- Music never playing (suspended AudioContext, broken `../public` paths) and copyrighted tracks → `sound/engine` resumes on first gesture, procedural generative music, C418 files not copied → AU4, engine-resume unit test, arch no-audio-assets and no-external-import tests.
- No tests, copy-forward, `Math.random` log in the hot path, stale docs → fresh scaffold, arch bans, generated README, thresholds lock.

## 7. Performance budget

**Targets:**
- 60 fps at 1080p at Medium (RD12 + LOD 512) on the reference **Intel Iris Xe** of the developer's i7-12700H laptop (D16), launched on the integrated GPU (Linux PRIME default). The bench route can cap the pool to 4 workers (overriding N) to emulate a smaller laptop, since the reference CPU has 20 threads.
- No frame over 33 ms while streaming; main thread ≤ 6 ms per frame.
- High (RD16 + 1 km LOD, 1 shadow cascade) is the dGPU target.

**Worker CPU per column** (Node on the reference i7-12700H, D16):

| stage | work | p50 / p95 |
|---|---|---|
| Column | 49 quart points × about 60 noise evaluations + surfaceEst (8 µs × 49) | 0.7 / 1.2 ms |
| T: density corners | up to 1225 corners; about 60% underground or mixed after bounds | 1.5 / 3 |
| T: cave corners | about 700 corners × about 40 evaluations | 3 / 6 |
| T: fill / combine / VOXEL nodes | straddling cells only | 1.2 / 2.5 |
| T: carvers | 17×17 sources, AABB reject, cached | 0.5 / 1.5 |
| T: aquifer | non-solid voxels, fast path | 1.0 / 2.5 |
| T: biomes + surface scan + write | 25 surface + about 300 cave quarts; 98k-voxel scan | 1.3 / 2 |
| **T gate** | expected 6-9 ms | **≤ 10 / 20** (09: 150-270 ms per column) |
| D | pull model over 9 sources + settle + stamp + diff | ≤ 3 / 8 |
| L | region copy 1-2 ms + BFS | ≤ 4 / 8 |
| Mesh | about 9 non-trivial sections × ≤ 1.0 ms | ≈ 9 / 20 |
| **Total** | | **≈ 26 ms per column** |

- **Measured in SP3b** (amended by SP3b): the column stage's ColumnSample p50 0.34 ms (it keeps the 2D surfaceEst, so the row's surfaceEst cost moves to `surfaceEst3`'s consumers); T without caves (`terrain.real`: ColumnSample, density with early-outs, water, 24 sections, aux A and B) p50 1.42-1.46 ms, p99 2.2-2.4 ms, gated at ≤ 4 ms p50 by `TERRAIN_P50_MAX_MS`; one corner of the default expression ≈ 0.19 µs.
- **Kill criterion:** if DAG closure overhead exceeds 25% of T (measured by bench against a hand-inlined default expression), add `new Function` codegen behind a CSP probe, keeping `reference.ts` as the oracle.
- **Fill:** RD12 needs T 755 / D 660 / L 573 / mesh 491 columns ≈ 16-17 CPU-seconds.
  - Wall time ≤ 6 s on the reference laptop with the bench cap of 4 workers and the throttle; ≤ 4 s with the default 6 workers (09 took 71 s at RD16).
  - First playable (RD4 meshed) ≤ 1 s.
  - RD16 ≈ 28 CPU-s, ≤ 6 s on 6 workers.
- **Streaming:** flight at 20 blocks/s at RD12 is about 31 new columns/s, about 0.8 of a worker.

**Main thread per frame (Medium):**

| item | budget |
|---|---|
| input, physics, raycast | 0.3 ms |
| coordinator (≤ 1 ms on a crossing) | 0.2 ms |
| result intake and dispatch | 0.3 ms |
| uploads (`setGeometryAt` / `addUpdateRange`) | ≤ 2.0 ms |
| BatchedMesh per-instance culling (about 3k) | 0.6 ms |
| cave BFS (on change, time-sliced) | ≤ 1.0 ms amortised |
| three.js submit (about 60 draws) | 1.5 ms |
| lightmap, uniforms, HUD | 0.2 ms |
| **total** | **≈ 6 ms**, with no per-frame allocation in hot paths |

**GPU per frame (iGPU, Medium, 1080p):**

| pass | budget |
|---|---|
| opaque | ≤ 5 ms |
| cutout | ≤ 1.5 ms |
| water (Fancy) | ≤ 1.2 ms |
| LOD | ≤ 1.0 ms |
| sky and flat clouds | ≤ 0.6 ms |
| **total** | **≤ 9.5-12 ms** |

High adds MSAA, a shadow cascade (about 2 ms), LOD 1 km and RD16 (dGPU target). Fabulous water adds about 1.5 ms.

**Memory:**

| item | Medium | High | Ultra |
|---|---|---|---|
| SAB store (u16 blocks) | ≈ 115 MB (+45 MB tuning mode) | ≈ 180 MB | ≈ 350 MB |
| SAB store, hysteresis worst case | ≈ 145 MB | ≈ 213 MB | ≈ 390 MB |
| terrain GPU (1500 quads/col × 56 B × 1.3) | ≈ 53 MB | ≈ 94 MB | ≈ 205 MB |
| BatchedMesh CPU copy | ≈ 41 MB | ≈ 72 MB | ≈ 158 MB |
| worker caches | ≈ 10 MB each | same | same |
| LOD | ≤ 20 MB | ≤ 25 MB | ≤ 25 MB |
| textures + tint + masks | ≈ 6 MB | ≈ 10 MB | ≈ 40 MB |

- Medium GPU total ≈ 80 MB, against a brief target < 150 MB.
- JS heap + SAB ≤ 450 MB at High, including the hysteresis worst case (gated by G1). Ultra is desktop-only.
- Audio: one-shots ≈ 3-6 MB (≤ 4 variants × ~60 sounds, 48 kHz mono, ≤ 0.5 s each); 4 ambience loops of 8 s ≈ 6 MB; 3 reverb IRs (0.4 / 1.2 / 2.5 s stereo) ≈ 1.6 MB; at most 2 resident music phrases ≈ 6 MB. Audio total ≤ 24 MB.
- R4 measures the quad assumption in SP4 and gates it with full content in SP8b.

**Map, inspector and LOD throughput** (honest figures):
- A 256² map tile at 4 blocks/px with relief ≈ 0.9 s CPU; biome-only ≈ 0.4 s.
- First full-screen coarse image (32 blocks/px) ≤ 0.3 s; full refinement ≤ 6 s on 4 idle workers.
- Inspector slice: 128² first in ≤ 300 ms, refined to 256².
- LOD L0 ring at 512 ≈ 44k samples ≈ 0.5 s CPU; tile ≤ 60 ms.

**Latency:**
- edit → visible ≤ 50 ms p95; relight ≤ 3 ms;
- decorate-scope Apply at RD12 in tuning mode ≤ 3 s;
- terrain Apply: first visible change near the player ≤ 0.5 s;
- map preview after a spline edit ≤ 300 ms coarse: from the input event to the draw in which every visible level-256 tile of the draft (or a newer one) is drawn, measured as in the SP2b spec §2.8 (amended by SP2b).

## 8. Risks (with mitigations and kill criteria)

1. **COOP/COEP needed for the SAB.**
   - Mitigation: headers in vite.config for dev and preview; Docker runs vite; `vercel.json` sets the same headers on Vercel (D11); a startup `crossOriginIsolated` check with an error screen; packs load from local files only; no cross-origin subresources anywhere (COEP `require-corp`). Isolation also requires a **secure context**: dev, preview and Docker must be opened via `http://localhost:<port>` (or 127.0.0.1) or over HTTPS, and a reverse proxy in front of the container must terminate TLS and pass COOP/COEP through unchanged. When `isSecureContext` is false, the error screen names this cause. Every worker script response (Vite dev `?worker_file` modules, `/node_modules/.vite/deps/*`, built `assets/*.js`) must carry the headers too.
   - Kill: if SP3a-SP4 shows an unfixable isolation or concurrency problem, switch to transferable snapshots. gen/light/mesh already run on plain ArrayBuffers in the harness, so only `store` and the transport change.
2. **BatchedMesh with custom GLSL3 and an integer `data` attribute.**
   - Mitigation: an SP4 week-1 spike (stress test at Medium scale: ≈ 3.5k section instances, ≈ 0.75 M quads; remesh churn; `optimize`); pin three to `~0.186.1`; `WEBGL_multi_draw` detection; RegionMesh fallback behind the `SectionRenderer` interface.
3. **T cost of the full cave family in JS, plus DAG closures.**
   - Mitigation: interval early-outs, bench gates per SP, and the codegen kill criterion.
   - Knobs in reserve: octave pruning via amplitude arrays, and 4×8×4 cells for noodles (thinnest-axis metric C5 guards against blurring).
4. **Hashed-lattice noise cost.** Kill criterion in 3.1 (measured at 1.06-1.27× the permutation variant in the SP1 spike).
5. **Thread oversubscription on 4-core laptops.** Adaptive throttle, pool ≤ 6, map/LOD/metric jobs ≤ 1 while generating.
6. **Cross-browser determinism.** detMath, IEEE-only arithmetic, arch bans, golden checks in the browser (the SP1 `?lab=noise` determinism panel, then `?selftest=1` from SP2a), a Bun (JavaScriptCore) golden check at every SP exit (D20), and absolute-state diffs.
7. **Concurrency bugs in the shared store.** Single writer by status, version and meshSeq discard, slab fuzz, edits-during-light fuzz in the harness (L3).
8. **Memory at High and Ultra.** Uniform elision, proto retention limited to the outer rings, unload hysteresis, HUD slab usage, Ultra documented as desktop-only.
9. **Fluid runaway** (breaking an ocean wall into a cave net). Caps, sim distance, remesh throttle, dense diff format, F2.
10. **Truncated settle fronts that look like walls.** A2 counts them; tune the cap and barriers. Fallback (policy B, only if A2 cannot be met): natural ticks inside sim distance with a lineage bit so only edit-caused flows persist (D18).
11. **Tuning labour, or "tests pass but it looks bad".** Visual review of PNG slices, map snapshots and bench screenshots in every SP exit; the metrics dashboard; thresholds changed only by spec amendment.
12. **Metric-suite runtime growth.** Region cache keyed by genKey, and tiered suites.
13. **Save and golden churn during development.** generatorVersion policy (6.2).
14. **LOD mismatch** (overhangs, islands). T5 on LOD samples, fill mask, island terms, fog.
15. **Scope creep.** YAGNI list plus a cut line per SP (see the decomposition). After SP7 the app is a complete explorer and editor with water.
16. **u16 block states.** +55-60 % store memory and non-cube meshing/collision work. Mitigation: uniform-section elision, 4096-state cap, connection shapes derived rather than stored, `SHAPE_BOXES` restricted to the 11 listed models, shape quads excluded from greedy merging only.
17. **Audio autoplay and CPU.** Browsers suspend AudioContext until a gesture: `sound/engine` resumes on the first pointer-lock/click and shows a muted indicator until then. Synthesis runs in workers after first playable (music on demand, phrase by phrase); the voice cap and emitter clustering bound runtime cost (AU2).

## 9. Contradictions resolved

| topic | chosen | rejected (why) |
|---|---|---|
| voxel store | SAB, 8 KiB block / 4 KiB byte channels, worker allocation | main-thread canonical store (main-thread gathers, fluid sim on main thread); fixed 16 KB slots with residency eviction (thrash and memory contradiction) |
| decorate contract | pull model over 3×3 proto with priority writes | own column + T-summaries (cannot do cross-border settle or ores) |
| settle | 3×3 with distance cap 16 | own column (water walls); 2-cycle CA (not exact) |
| relight | removal/add BFS with heightmap re-seed | ±15 slab (wrong for sky shafts) |
| batching | per-region BatchedMesh, 56 B/quad, real `position` | one batch per pass (whole-world `optimize` stalls); shared index (impossible) |
| tint | tint texture + colormap | per-section UBO (impossible under multi-draw) |
| density | typed column stage + closure DAG for the 3D composition | fixed formula (no structural experiments); full router with codegen (framework-first critical path) |
| noise | hashed lattice with axis pre-mix and 12 balanced gradients (kill criterion) | 256/512-permutation (single-stack periodicity; kept only as a bench comparator); GRAD16 (vertical anisotropy) |
| map | pool jobs, coarse-first | dedicated map worker (idle thread, oversubscription) |
| runtime fluids | edit-triggered only | natural ticks + lineage bit (sim storms entering sim distance; world ≠ gen + diffs) |
| shadows | custom depth pass inside materials | SunLight (no shadow chunks for custom ShaderMaterial) |
| AO | preset-scaled (off at Low) | always on (the user listed AO as a preset setting) |
| save binding | (generatorVersion, seed, stageHash('decorate'), i.e. generation-scope params only) | (seed, paramsHash) only (silent misalignment after generator changes) |
| block ids | u16 states, connection shapes derived (user decision D12) | u8 ids without states (crude structures) |
| hosting | Vite / Docker / Vercel with headers | coi-sw.js service worker (not needed once Vercel headers are available) |

## 10. Decomposition into sub-projects

Each sub-project runs its own cycle:

1. **Spec** in `docs/superpowers/specs/YYYY-MM-DD-sp<N>-<topic>-design.md`, refining the sections of this document it touches.
2. **Plan** in `docs/superpowers/plans/…`, one checkbox task per commit.
3. **Implementation** with TDD (vitest), conventional commits scoped by area (`feat(gen):`, `feat(render):`, `fix(store):`, `test(metrics):`, `docs(spec):`, …).

**Definition of done** for every sub-project:
- `npm run build`, `npm test` and `npm run test:metrics:full` pass for **every metric ID active at this SP**. Each ID (or ID part) carries `activeFrom: 'SPn'` in `test/thresholds.ts`, set to the first SP that lists it in its exit; once active it stays gated in every later SP. Metrics not yet active are skipped, not failed.
- The bench stays within +30 % of `baselines.json`.
- The visual review is done (PNG slices, map snapshots and screenshots attached to the SP spec).
- From SP2a on, `?selftest=1` matches the goldens in the browser (SP1: the `?lab=noise` determinism panel over the SP1 goldens).
- The app still runs.

Thresholds are locked (`thresholds.lock.json`) and goldens are gated (§6.2). Sizes: S ≈ 2-4 days, M ≈ 1-2 weeks, L ≈ 2-3 weeks of focused work.

**Cut lines.** Every SP names a cut line: what may slip if it overruns. A slipped item moves to a named receiving SP by amending this section, and the receiving SP adds it to its exit. Default receivers: SP0 Vercel preview check → SP4; SP2b share preview and cross-section → SP10 (both delivered in SP2b, so nothing moved); SP3b worker-split slice → SP3d; SP3d inspector pins → SP10; SP5 worlds-menu polish and palette search → SP10; SP7 vertex waves → SP11; SP8a animation frames → SP11; SP8a fence gates and trapdoors → SP12; SP8b giant trees, boulders and fossils → SP12; SP8c HRTF → SP11; SP9 jungle temple and village depth > 4 → SP12; SP11 Ultra shadows, 3D clouds and Fabulous water → SP12; SP6 underground-only carver and spaghetti-2D rarity bands → SP12; SP7 extra lava reactions → SP12; SP10 seed sweep and column-status heatmap → SP12. SP12's exit requires no open cut-line items, unless the user explicitly dropped one and the impact on its D-decision is recorded.

**SP0 — Scaffold and guardrails** (S; no dependencies)
- Repository scaffold at the root: Vite, TS strict, three `~0.186.1`, vitest projects (unit / arch / metrics-fast / metrics-quick / metrics-full / bench; see the SP0 spec).
- Headers exactly `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, set in vite.config `server.headers` and `preview.headers` and in `vercel.json` with `source: "/(.*)"`. Dockerfile and the repository's own `docker-compose.yml` (service `world-imaginer-voxel`, port 5183, default compose network); README and CLAUDE.md updated with the real commands; GitHub Actions CI (`.github/workflows/ci.yml`: `npm ci`, `npm run build`, `npm test`, `npm run test:metrics`, on push and PR; the region-cache step for `npm run test:metrics` arrives in SP3b, caching `test/.cache/regions` only; amended by SP3a).
- Arch tests (imports, banned APIs, no numeric tunables in `gen/`, no audio assets, no imports outside the project); thresholds-lock (with `activeFrom`) and goldens commands.
- Capability probe: `isSecureContext`, `crossOriginIsolated` in the page **and in a module worker** sharing one SAB, `WEBGL_multi_draw`, timer query, max texture layers, WebGL renderer string; an error screen that names the missing condition.
- CSS-grid shell and HUD.
- **Deliverable:** a page with a sky-coloured three.js canvas and the capability report.
- **Exit:** arch tests green; CI green on `main`; SAB round-trip test across 2 `worker_threads`; thresholds-lock test; build passes; manual check in dev, preview and a Vercel preview deployment (triggered by the user) that both the page and a module worker report `crossOriginIsolated === true` and share one SAB.
- **Cut line:** the Vercel preview check (→ SP4).

**SP1 — Deterministic math core** (M; SP0)
- hash, rng, seed text, detMath; hashed-lattice `lattice3`, OctaveNoise, NormalNoise, CDF; nested Hermite splines; ParamSchema + meta, profiles skeleton, presets envelope, migrate, canonical JSON, genKey; stage registry and stageHash (spec `2026-09-27-sp1-deterministic-math-core-design.md`).
- **Deliverable:** `?lab=noise` page: inspector and A/B comparison of any schema noise field with its histogram, gradient rose and statistics, plus a browser determinism panel over the SP1 goldens.
- **Exit:** N1, N2, N3, N5, N6, U4 (all parts, including README freshness); detMath error ≤ 2e-6 and its design bounds; spline tests; `PERLIN3_SD` and `PERLIN2_SD` pinned; SP1 goldens recorded; bench baseline recorded; noise kill criterion evaluated (§3.1); the lab's determinism panel green in Chrome and Firefox and the Bun (JavaScriptCore) golden check green (D20).
- **Cut line:** the lab's A/B mode (→ SP10).

**SP2a — Column stage, worker pool and map** (L; SP1). Spec: `2026-09-28-sp2a-column-stage-map-design.md` (the 2026-09-28 split of the former SP2).
- Climate with warps and CDF, PV fold; offset / σ / jag splines in blocks; steep from the halo; rivers (channel, valley, gorges) and lakes (column terms); a 2D `surfaceEst = offset` (SP3b keeps it for the map, the biome picker and the column stage; its 3D `surfaceEst3` is used by the voxel metrics and later consumers; amended by SP3b); surface biome registry, picker and zoom; spawn search; ColumnSample LRU; point reference `columnPoint` and batched `buildColumnSample`, bit-exact at quart corners.
- Task pool and protocol (`MAP_TILE`, `point`, `selftest`); the standalone `?map` page (coarse-first tiles; biome, relief, rivers, lakes, raw fields and offset/σ/jag layers; hover; spawn marker; click shows a coordinate); seed box, ready-profile select and a JSON patch box over `WorldSession`, in the URL hash.
- `?selftest=1` page: recomputes column-stage and map-tile golden hashes in a real module worker.
- **Deliverable:** an interactive world map of the default and large_biomes worlds, parameterised by URL patch.
- **Exit:** B1, B4 (climate parts), N4, T6, T7, T8, T1lowland; a unit test that the terrain does not depend on the biomes (in place of T3 on 2D relief; SP2a spec §12); B2 (length, share, mouths, gorges) and B5 (lakes per km², share with Lw ≥ 70) on the column stage; DT2 batch == point (column stage, bit-exact); two workers produce byte-identical map tiles; P1 Column ≤ 0.7 / 1.2 ms; first coarse map image ≤ 0.3 s; session unit tests; `?selftest=1` green in Chrome and Firefox.
- Received from SP1 (its spec §10): author the `shape.*` defaults with `autoTangents`; clamp jag and σ with `max(0, ·)`; check the lowland band (≈ 34 % of land in [66, 76) on the pure offset) as a diagnostic; add `CURRENT_SP` that hides profiles before their `readyFrom`; put the profile id in the world URL hash.
- **Cut line:** the raw W/T/H/R layers and the spawn fallback refinement (→ SP2b).

**SP2b — Parameter tooling** (M; SP2a)
- Schema-driven parameter panel with scope badges; nested Hermite spline editor (typed coords, histogram overlay, area shares, blocks y-axis, cross-section); biome table with share preview; presets UI over the SP1 envelope (import loads, export writes the draft), all editing `WorldSession`.
- **Deliverable:** the SP2a map updates live while splines and biome boxes are edited; a 1-10 biome-size slider drives `climate.scaleMul = 4^((v − 5)/5)` (5 = default, 10 = large_biomes; user request 2026-09-29).
- **Exit:** U2 for column-scope params; spline-edit map preview ≤ 300 ms; preset unit tests; the SP1 deferred minors reachable through the editor (spline knot/tangent bounds, tiny amplitudes).
- Received from SP2a (amended by SP2b): the raw W/T/H/R layers and the grid overlay exist; the spawn fallback refinement is closed as not needed (N4 spawnOnLand is 100 % over 64 seeds with the SP2a fallback).
- Handed on (SP2b spec Appendix A): SP2a minors 5 and 6 → SP3 (SP3b after the split; SP3b moves minor 6 on to SP3c); the `?lab=noise` minors → SP10.
- **Cut line:** the biome share preview and the cross-section profile (→ SP10). Both were delivered in SP2b, so nothing moved to SP10.

SP3 was split on 2026-10-02 into SP3a, SP3b and SP3c (amended by SP3a; the SP3a spec's Decisions): the context review sized it at 9-12 weeks, three to four times an "L". SP4 and SP6 depend on SP3b; SP3c can run alongside SP4.

SP3b was split on 2026-10-07 into SP3b (density and terrain shape) and a new SP3c (surface rules and terrain palette), and the former SP3c (draft presets, inspector and slice viewer) became SP3d (amended by SP3b; the SP3b spec's Decision 1 and §12). SP4 depends on SP3b and SP6 on SP3c; SP3c and SP3d can run alongside SP4.

**SP3a — Block registry, voxel store and region harness** (M; SP2b). Spec: `2026-10-02-sp3a-blocks-store-harness-design.md`.
- SAB store (two slab pools over growable buffers, CAS free stacks, refcounts, torus table, section descriptors, aux, per-scope epoch cells), on a SharedArrayBuffer or a plain ArrayBuffer; the block registry with air, stone and bedrock and `test/stateIds.lock.json`. **The u16 block-state encoding, the fluid byte and the light byte are frozen here, together with the property model, the registry API and the append-only id rule (§2.2).** Frozen means the encoding, the property kinds and the API; later SPs still add block types, SoA columns and per-state values (the block list grows in SP6, SP8a, SP8b and SP9).
- A provisional T stage that fills columns from the 2D world (bedrock, stone, water up to surfaceWaterLevel, air) through the store API.
- Harness `genRegion` (orders, 1 or 4 threads, region cache keyed by genKey + srcKey + format, PNG slices); the slice job and a Voxels mode in the `?map` cut-line cross-section; `?selftest=1` extended to proto region hashes (`sp3a.*`).
- **Deliverable:** real voxels: the vertical slice of the provisional terrain under the cut line, and the harness PNG slices.
- **Exit:** DT1 on the provisional T; M1 (registry parts); slab fuzz extended to promotion, sharing and the torus (4 threads × 100k ops, both pools, growth; 0 double allocations, 0 lost slots, exact refcounts); `?selftest=1` with the sp3a region hashes.
- **Cut line:** none named by the SP3a spec.

**SP3b — Density and terrain shape** (L; SP3a). Spec: `2026-10-07-sp3b-density-terrain-design.md`.
- Density: Expr, closure compiler with stage placement, reference interpreter, interval bounds with early-outs, probe; the default terrain expression without caves, with the `islands` DAG term (−1e6 by default).
- `surfaceEst3`: the 3D surfaceEstimate by bisection on the `terrain` tap, used by T5 and later consumers; the map, the biome picker and the column stage keep the 2D `surfaceEst` (amended by SP3b).
- The real T stage (air, stone, bedrock and water) with the general v0 water fill so oceans, rivers and lakes are visible early (air with top − 12 < y ≤ surfaceWaterLevel, `top` being the position's highest stone, becomes water sources; everything else stays dry; SP3a's provisional T is its no-overhang case); it writes aux B and bumps the `terrain` stage and `GENERATOR_VERSION`.
- The slice job split across workers; the CI `actions/cache` step for `test/.cache/regions` before `npm run test:metrics` (moved from SP3a, whose provisional T regenerates a 32 × 32 region in about a second).
- **Deliverable:** 3D voxel terrain from the density DAG with water, in the harness slices and the Voxels mode.
- **Exit:** as the SP3b spec §11: DT1 on the real T, DT2 (probe == bulk, compiled == reference bit-exact); T1, T2, T3 (stratified over lowland borders, gated on the full tier), T4 and T5 on voxel terrain (true top from WORLD_SURFACE_WG); every 2D metric still passes; P1 bench: T without caves ≤ 4 ms p50.
- Received from SP3a (its spec §10): T3's redefinition before it gates and T1's lowland band; the cost of the biome height filter on the real `surfaceEst` (settled by keeping the 2D estimate there); the Expr ops' exact semantics and interval rules; SP2a minor 5 (handed to SP3 by SP2b; minor 6 moves to SP3c); the ocean-floor σ/jag stripe.
- **Cut line:** the worker-split slice (→ SP3d).

**SP3c — Surface rules and terrain palette** (M; SP3b)
- Surface-rule data tree, compiler and whole-column scan (§3.11: bedrock, deepslate, palettes, snowline, cliffs); bedrock dithered over −63 … −60.
- The terrain palette appends to the registry and the lock, with an `sp3c.registry` golden over the appended states.
- B4's voxel parts (snow in desert, coast-band beach/stony shore/snowy beach share, land-biome tops below sea level outside rivers and lakes), a voxel river-water check (SP2a minor 6) and S1 (buried surface blocks and y mod 16 parts), S2, S3 (snowline part).
- **Deliverable:** set by the SP3c spec.
- Received from SP3b (its spec §13): the `sp3b.registry` golden named by SP3a, renamed `sp3c.registry`; SP2a minor 6; lake-rim islets and the shoreline zoom fringe.
- **Exit:** set by the SP3c spec.
- **Cut line:** set by the SP3c spec.

**SP3d — Draft presets, inspector and slice viewer** (M; SP3c)
- Draft `floating_islands`, `amplified` and `archipelago` presets (terms, splines and params; surface-rule branch for islands), so per-preset goldens and SP11's LOD island scan have a target; their profiles become selectable (`readyFrom: 'SP3d'`).
- In-app slice viewer and density node inspector; `density.defs` as an editable JSON leaf with mutes, and SP3b's `SLIDE`, floor and ceiling terms as data (the SP3b spec §13).
- **Deliverable:** live terrain cross-sections and the node inspector.
- Received from SP3a (its spec §10): archipelago (≈ 60 % ocean) against B1's 45 % ocean-family cap (decide per-preset gating); amplified's offset multiplier and the 320 range.
- **Exit:** set by the SP3d spec.
- **Cut line:** inspector pins (→ SP10).

**SP4 — Streaming renderer and light** (L; SP3b)
- **Week-1 spike:** RegionBatch with a Uint8x4 `position` plus a uint32 `data` attribute in a custom GLSL3 ShaderMaterial with batching chunks, precomputed spheres, `setGeometryAt` churn, per-region `optimize`, and the multi_draw fallback to RegionMesh, stressed at Medium scale.
- Coordinator (statuses, rings, heap, epochs, versions, meshSeq, cancellation, unload hysteresis, adaptive throttle, upload budget); D-stage skeleton (pull-model infrastructure, zero features, proto retention); exact light job (FULL_FACES-aware); padded greedy mesher with `PACK_LAYOUT` and connectivity bits; still-water surface mesher.
- Materials v1 (opaque / cutout / translucent passes; face shade × AO × smooth light × lightmap; spherical fog; Fast water); placeholder flat-colour DataArrayTexture; sky dome with sun; elevation-based day/night.
- Fly controller, floating origin, FPS limiter, HUD counts; `ui/help.ts` key map (H/F1; each SP that adds keys extends it); Apply v1 (epoch bump, old meshes kept); bench route with renderer-string capture and optional 4-worker cap.
- **Deliverable:** fly through RD12 terrain with day/night and translucent oceans.
- **Exit:** R1, R2, R7, L1, L2; R4 measured and recorded, not gated (activeFrom SP8b; sets the GPU memory budget); coordinator, lightmap, phase, FPS-limiter, colour-space, water pass/light, mesher AO and packing↔GLSL unit tests; P1 L ≤ 4 / 8 ms and Mesh ≤ 1.0 / 2.5 ms per non-trivial section; G1 (Medium, terrain-only at RD12 on the reference Iris Xe: p95 ≤ 16.7 ms, ≤ 100 draw calls, main thread ≤ 6 ms p95).
- **Cut line:** the RegionMesh fallback, unless the spike or the capability probe requires it.

**SP5 — Editing and persistence vertical slice** (M; SP4)
- Sim worker owning Published columns; DDA raycast with outline; hotbar; break, place and pick; **creative palette (E)**; orientation rules and interactions of §4.12 (shapes render as cubes until SP8a); edit-priority remesh (−1000, §4.3).
- Incremental removal/re-add relight with the sky heightmap re-seed.
- Persistence: DiffStore (in memory, authoritative, read-through), diff codec (u16 states, canonical order, little-endian), IDB KV with a single-transaction flush every 2 s and on pagehide, create/load/rename/duplicate/delete worlds, genKey binding plus the fork dialog (§2.7), `stateTable` remap, `.wiworld` export/import.
- Walk controller: swept AABB, step-up, ladders, unloaded ≠ solid, unstuck.
- **Deliverable:** break and place blocks, reload and get the same world, export and import in another browser profile — the cross-cutting formats proven end to end.
- **Exit:** L3 (including shafts); E1-E7 (including the fault-injected flush and the unload/reload race); G2 (edit part: edit → visible p95 ≤ 50 ms); relight ≤ 3 ms p95; physics and palette unit tests.
- **Cut line:** worlds-menu polish (rename, duplicate, thumbnails) and palette search (→ SP10).

**SP6 — Caves, carvers and cave biomes** (L; SP3c, SP5 for in-game review)
- Cave family terms in the default DAG (cheese / layer / pillars, spaghetti 2D and 3D with rarity, noodle, entrances, roughness, cheese roof term, lake roof); worm and canyon carvers (detMath, LRU); 3D quart cave-biome picker (lush, dripstone, **abyss**) with cave floor and ceiling surface rules; the abyss surface-palette blocks (decided in this SP's spec); debug cave-type tag channel, cave-type tint in the slice viewer, map cave slice and cave-biome layers; `cave_heavy` preset; cave culling.
- **Deliverable:** explorable caves with visible surface entrances and ravines.
- **Exit:** C1-C6, B3, R3; re-asserted with caves: L2, S1 (grass at sky 0), DT1, DT2 (probe == bulk); P1: T ≤ 10 ms p50; DAG closure overhead vs a hand-inlined default expression measured and recorded (codegen kill criterion, §7).
- **Cut line:** the extra underground-only carver; spaghetti-2D rarity bands.

**SP7 — Water and fluids** (L; SP6, SP5)
- MC-style aquifers (water, lava, barriers, abyss exclusion, fast path); wet rivers and lakes via surfaceWaterLevel; exact 3×3 settle with the distance cap, `FLUID_MODE` and the unsettled flag; flowing-water mesher (levels, corner heights, sides) and lava rendering; water tiers Fast and Fancy; underwater fog and tint; swimming; runtime fluid sim (edit-triggered, 20 TPS, rules, reactions, caps, sim distance, diffs); water and lava buckets and the empty bucket.
- **Deliverable:** translucent oceans, rivers and elevated lakes; dry caves below sea level; deep lava; waterfalls at aquifer borders; break a lake rim and watch it drain.
- **Exit:** A1-A4, B2 (voxel), B5, F1, F2, F3, R5; DT1 with settle; P1: T still ≤ 10 ms.
- **Cut line:** vertex waves (→ SP11); lava reactions beyond obsidian and cobblestone.
- **MVP line:** after SP7 the app is a complete explorer and editor with caves, entrances and real water.

**SP8a — Textures, cutout content and block shapes** (L; SP4 for textures and shape meshing, SP5 for collision/raycast/orientation against boxes; the texture parts can run in parallel with SP5-SP7)
- Procedural painters v1 (variants, hash rotation, macro tint, tint-mask alpha); colormaps and the tint texture; cutout content for leaves, glass and plants (the pass exists since SP4); anisotropy.
- **Block shapes (D12):** `SHAPE_BOXES` for the 11 models on the 1/8 grid, the shape mesher with neighbour-derived connections, `FULL_FACES` culling and light blocking, `COLLIDE` boxes, raycast against boxes.
- **Deliverable:** a textured, biome-tinted world where stairs, slabs, doors, fences, panes, torches, lanterns and ladders render, collide and orient correctly.
- **Exit:** painter determinism and quality unit tests; texture array ≤ 2 MB; glass meshed in the cutout pass; M1 (shape parts); block-state unit tests; R1 with shapes (same-model culling rule); visual checklist.
- **Cut line:** animation frames (→ SP11); fence gates and trapdoors (→ SP12).

**SP8b — Decorate content: features, ores, vegetation, cave decoration** (L; SP7, SP8a)
- Placed-feature data, modifiers and pull-model priority writes; trees (9 species families) and plant patches; cave decoration (glow lichen, cave vines with berries, moss, dripstone, and the **abyss** decoration set: dark crystals, dead roots, fossils, the exclusive mineral — concrete list in this SP's spec); ores; freeze_top_layer; springs, lava lakes and island-edge springs feeding settle; tuning mode (keep every proto) and the decorate-scope Apply path.
- **Deliverable:** forests with groves and clearings; decorated lush, dripstone and abyss caves; ores everywhere.
- **Exit:** O1, O2, V1-V6, S3 (all parts); R4 asserted with caves, water and leaves (if it fails, §2.6 and §7 memory budgets are re-derived by amendment); DT1 with features; U1 (a decorate edit re-runs only D, L and mesh in tuning mode); P1: D ≤ 3 ms p50; AU4 re-run over the SP8b block states if SP8c is already done.
- **Cut line:** jungle and dark-oak giant trees, boulders, fossils (→ SP12).

**SP8c — Audio** (M; SP7, SP5; can run in parallel with SP8a/SP8b)
- `audio/synth` DSP generators and `AUDIO_SYNTH` jobs; `audio/model` pure decision logic; `sound/engine` with buses, gesture resume and persisted volumes; block SFX by `SOUND` group and footsteps; splash/swim/lava; ambience estimator, beds (wind, surf, cave, abyss) and grains (drips, birds, crickets, abyss rumbles) with the three fixed reverbs; positional emitters from mesh jobs with clustering and voice caps; generative music with the frequency setting (Always / Frequent / Standard / Never); sound packs (`wi10-sounds`) in IndexedDB.
- Creates `ui/settingsPanel.ts` with the **Audio** section (master/music/sfx/ambient volumes, music frequency, sound pack) and `core/params/graphicsPresets.ts` as pure data with the audio rows, applying the Medium audio row until SP11 adds the graphics rows.
- **Deliverable:** an immersive soundscape that follows biome, depth, time and water, with spaced generative music.
- **Exit:** AU1-AU4; audio unit tests (including engine resume); manual listening checklist (cave, surface, underwater, abyss, waterfall, footsteps on every group). If SP8b finishes later, the abyss items of the checklist and the abyss footstep group are re-checked at SP8b's exit.
- **Cut line:** HRTF spatialisation (equal-power only; → SP11). Sound packs (D10) are **not** cuttable; if they overrun they move to SP11 next to resource packs (same directory loader, same IDB `packs` store), and SP11's exit adds the sound-pack manifest fallback tests.

**SP9 — Structures** (L; SP8b, SP8a)
- random_spread sets; jigsaw-lite with a start cache; templates using block states (village with 4 palettes via `withType`, ruins, desert temple, jungle temple, igloo); state rotation/mirroring per piece; the beardifier DAG leaf; stamping in D; map markers.
- **Deliverable:** villages whose streets follow the terrain; temples with foundations.
- **Exit:** X1, X2; DT1 with structures; T overhead in beard columns ≤ +15 %.
- **Cut line:** jungle temple; village depth > 4 (→ SP12).

**SP10 — Research tooling completion** (M; SP9)
- Full stage-hash invalidation for every scope with badges and progress; probe of all stage outputs including the surface-rule branch; slice view of every 3D field; inspector mutes and pins; metrics dashboard (shared metric definitions, compare with previous params, seed sweep for column metrics); complete map layers (structures, carvers, aquifer, status heatmap, bookmarks, teleport snap); JSON editors with validation; full F3 overlay and performance HUD; plus received cut-line items (the generated README parameter reference is already gated since SP1).
- **Deliverable:** the research workbench — tweak, preview, measure and compare without leaving the app.
- **Exit:** U1-U4 (U4 active in full since SP1); G2 (Apply part: first visible change near the player ≤ 0.5 s); dashboard metric == vitest metric (same function, same value); decorate-scope Apply at RD12 ≤ 3 s; inspector slice ≤ 300 ms at 128².
- **Cut line:** seed sweep; the column-status heatmap (→ SP12).

**SP11 — Graphics scale-up** (L; SP10 for integration, most parts need only SP8a)
- Presets Low to Ultra: adds the **Graphics** section to `ui/settingsPanel.ts` and the graphics rows to `core/params/graphicsPresets.ts` (AO scaled by preset); moon and stars; flat and 3D clouds; Fabulous water (colour and depth copy); custom shadow depth pass (High 1 cascade, Ultra 2); MSAA rebuild path; painters v2 with animation; resource packs with overlays and colormaps; LOD clipmap with fill mask and island terms; plus received cut-line items.
- **Deliverable:** 1-2 km vistas; presets that switch live; a user-supplied texture pack.
- **Exit:** G1 in full (Medium on the reference Iris Xe with LOD 512; High on the reference RTX 3060 Mobile); R6; T5 on LOD samples; pack-parser and settings-mapping unit tests.
- **Cut line:** Ultra shadows, 3D clouds, Fabulous water (→ SP12).

**SP12 — Extreme presets and final tuning** (M; SP11)
- Finalise amplified, archipelago, floating_islands, large_biomes and cave_heavy; goldens per preset; profile gallery in docs; baselines refreshed; README; received cut-line items.
- A "continental" profile (user request, 2026-09-29): large continents with islands in open ocean, via a much longer C wavelength (about 8000) and deep-ocean-dominated low C; it may move to SP3b or SP3d by amending this section. With it (user request, 2026-09-30): small islands or archipelagos at extremely low C, with no rivers on islets.
- The volcanic cone (reserved by SP2a, its spec §10): sparse cells in hot high ground add a cone and crater to `offset` and assign the volcano biome by mask; lava in the crater uses SP7's fluids. It may move to an earlier SP by amending this section.
- **Exit:** Z1-Z4; cave_heavy C1 10-22 %; every other active metric green per preset; DT1 goldens stable; no open cut-line items (unless explicitly dropped by the user with the D-decision impact recorded).

### Critical path and parallelism

Critical path: SP0 → SP1 → SP2a → SP2b → SP3a → SP3b → SP4 → SP5 → SP6 → SP7 → SP8b → SP9 → SP10 → SP11 → SP12.

In parallel: SP8a's texture parts after SP4 (alongside SP5-SP7; its shape collision/raycast parts after SP5); SP8c after SP7 (alongside SP8a/SP8b); the persistence codec and `.wiworld` format after SP3a; SP3c and SP3d alongside SP4; the LOD and cloud parts of SP11 after SP4.

Visible value in every SP: a map in SP2a (edited live in SP2b), voxel slices in SP3a, terrain in SP3b, flight in SP4, editing in SP5, caves in SP6, water in SP7. The riskiest integrations sit early: the SAB store and the u16 state format in SP3a, BatchedMesh in SP4 week 1, and fluid byte → light → mesh → edit → diff → IDB → reload in SP3a-SP5.

## 11. Relationship with world-imaginer

- world-imaginer (projects 01-09) stays untouched as the research history. Its README gets one row pointing to this repository as the successor of `09-density-terrain`, and its copy of this spec is removed so there is a single source of truth.
- This repository's `CLAUDE.md` holds its conventions: vitest is mandatory (D6); the app requires cross-origin isolation (COOP/COEP) in a secure context — open it via `http://localhost:<port>` or HTTPS, and a reverse proxy must terminate TLS and pass the headers through; Vercel is linked to the repository root; the D-decisions of this spec are authoritative.
- Code from 09 is ported by rewriting against tests (§1 "Deliberate ports"); nothing is imported or copied wholesale, and the arch tests forbid imports from outside the repository.
- The C418 `.ogg` files remain a world-imaginer matter and never enter this repository (arch test, D17).

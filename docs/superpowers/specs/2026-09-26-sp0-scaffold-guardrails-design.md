# SP0 — Scaffold and guardrails (Design)

Date: 2026-09-26
Status: Draft for review (verified by a throwaway toolchain spike and an adversarial consistency review)
Parent: master spec `2026-09-26-architecture-design.md` — §10 SP0 and Definition of done, §1 (layout, dependency rules, banned APIs), §2.5, §6.1-6.2, §8 risk 1, decisions D6, D7, D11, D17, D19.

## Goal

Stand up the repository so that every later sub-project lands on working rails. By the end of SP0 we have:

- a Vite + TypeScript + three.js app that shows a sky-coloured canvas inside the final CSS-grid shell, plus a **capability report**;
- the test infrastructure (vitest projects and tiers), the **arch tests** that enforce the layer rules and banned APIs, and the **governance mechanisms** (locked thresholds with per-part `activeFrom`, started-SP list, gated goldens, CI governance check);
- the delivery rails: Dockerfile + `docker-compose.yml`, `vercel.json`, and **GitHub Actions CI**.

## Non-goals

- No noise, parameters, generation, voxel store, meshing or workers beyond the probe worker. The SAB test in SP0 validates the platform, not the store (SP3).
- No metric definitions: SP0 ships the registry mechanism empty; each SP registers the IDs it gates.
- No bench baselines (the bench project exists but is empty until SP1).

## Toolchain (versions checked on npm on 2026-09-26; installed and exercised in the spike)

| package | range | role |
|---|---|---|
| `three` | `~0.186.1` | the only runtime dependency (D7) |
| `vite` | `^8.3.1` | dev server, build (Rolldown), module workers |
| `vitest` | `^5.0.2` | all test tiers via `test.projects` |
| `typescript` | `^7.0.2` | **type-check only** (`tsc --noEmit`); Vite transpiles |
| `@types/three` | `~0.186.0` | three typings |
| `@types/node` | `^24` | typings for tests, arch scans and `worker_threads` (**amends §1**) |

- Install with `npm install --save-prefix='~' three@~0.186.1` and `npm install -D --save-prefix='~' @types/three@~0.186.0` (for 0.x, `^` and `~` are equivalent; `~` keeps package.json literal).
- TypeScript 7 is the native (Go) compiler; it ships per-platform binaries that `npm ci` resolves on `ubuntu-latest` and `node:24-slim` (verified in the lockfile). **Kill criterion:** if a required option or a three typing does not type-check under it, pin `typescript@~5.9` and record the reason here. The spike found no blocker.
- Node **24 LTS**: `.nvmrc` = `24`, `"engines": { "node": "24.x" }` (keeps Vercel, CI and Docker on the same major), npm, `"type": "module"`.

## TypeScript configuration

TypeScript 7 defaults `types` to `[]` and enables `noUncheckedSideEffectImports`, so every config lists `types` explicitly. Three configs, because the DOM and WebWorker libs conflict:

| file | include / exclude | lib | types |
|---|---|---|---|
| `tsconfig.json` | `src/**/*.ts`; exclude `src/workers/**` | `ES2023`, `DOM` | `["vite/client"]` (declares `*.css` imports and `import.meta.env`) |
| `tsconfig.worker.json` | `src/workers/**/*.ts` (the pure layers they import come in through the import graph) | `ES2023`, `WebWorker` | `[]` |
| `tsconfig.test.json` | `test/**/*.ts`, `vite.config.ts`, `vitest.config.ts`; exclude `test/arch/fixtures/**` | `ES2023`, `DOM` | `["node", "vite/client"]` |

Shared options: `strict`, `target: ES2023`, `module: ESNext`, `moduleResolution: bundler`, `noEmit`, `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `forceConsistentCasingInFileNames`. `noUncheckedIndexedAccess` stays **off** (typed-array hot loops). No `paths` or `baseUrl` (arch-checked). `npm run typecheck` runs the three configs in sequence (≈ 0.8 s in the spike). Logic that unit tests exercise lives in DOM-free modules (`capabilityRules.ts`, `frameStats.ts`), so tests never need a real DOM.

## Repository layout after SP0

```
.github/workflows/ci.yml
.nvmrc  .gitignore  .dockerignore
Dockerfile  docker-compose.yml  vercel.json
index.html  package.json  package-lock.json
tsconfig.json  tsconfig.worker.json  tsconfig.test.json  tsconfig.base.json     shared compiler options
vite.config.ts  vitest.config.ts
src/
  main.ts                           boot: probe → error screen, or shell + renderer + HUD
  core/constants.ts                 GENERATOR_VERSION = 0 (world constants join it in SP1+)
  core/ids.ts                       types only: SubProjectId, MetricId (every §6.4 ID, E1-E6 expanded)
  engine/capabilityRules.ts         pure: declares CapabilityReport; report → {ok, blocking[], warnings[]}
  engine/capabilities.ts            probeCapabilities(): Promise<CapabilityReport> (no three)
  render/renderer.ts                three WebGLRenderer, sky clear colour, ResizeObserver-driven size
  ui/shell.ts  ui/styles.css        CSS-grid shell: toolbar | canvas | side panel
  ui/frameStats.ts                  pure: ring buffer of frame times, FPS, p50/p95
  ui/hud.ts                         DOM: renders frameStats at 4 Hz
  ui/capabilityReport.ts            side-panel report (copy as JSON) + full-screen error screen
  workers/probe.worker.ts           module worker: SAB write-back, reports crossOriginIsolated
test/
  harness/sp.ts                     STARTED_SPS, SP_DEPS
  harness/metric.ts                 metricTest(id, parts, fn)
  harness/goldens.ts                createGoldenStore(), expectGolden()
  harness/lock.ts                   canonical JSON + sha256 + diff (LOOSEN/TIGHTEN)
  thresholds.ts  thresholds.lock.json  goldens.json
  unit/…  unit/fixtures/sabWorker.mjs
  arch/scan.ts  arch/*.test.ts  arch/fixtures/<rule>/{bad,good}/…
  metrics/README.md  bench/README.md
docs/superpowers/specs/assets/sp0/  capability-report screenshots (visual review)
```

## package.json scripts

| script | command | notes |
|---|---|---|
| `dev` | `vite` | port 5183, strict port |
| `build` | `npm run typecheck && vite build` | |
| `preview` | `vite preview` | port 5183 |
| `typecheck` | `tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json` | |
| `test` | `vitest run --project unit --project arch --project metrics-fast` | < 60 s budget (§6.1) |
| `test:metrics` | `vitest run --project metrics-quick` | 2 seeds, cached |
| `test:metrics:full` | `vitest run --project metrics-full` | 8 seeds, SP exit |
| `bench` | `vitest bench --run --project "bench (bench)"` | vitest 5 runs benches in a derived project named `<project> (bench)` |
| `test:accept-thresholds` | `ACCEPT_THRESHOLDS=1 vitest run --project arch test/arch/thresholds.test.ts` | rewrites the lock and prints the diff; its commit must amend the spec (§6.2, checked in CI) |
| `test:goldens` | `UPDATE_GOLDENS=1 vitest run --project unit --project metrics-quick` | lists every project that calls `expectGolden` |

There is no `scripts/` folder: acceptance runs through vitest, which avoids Node type stripping's explicit-`.ts`-extension requirement.

## vitest configuration (`vitest.config.ts`)

`defineConfig` from `vitest/config` with root `test: { environment: 'node', passWithNoTests: true, projects: [...] }`. `passWithNoTests` is root-only in Vitest 5 (ignored inside projects), and inline projects inherit the root config, so each project sets only `name`, `include`, `env` (and `benchmark` for bench):

| project | include | env |
|---|---|---|
| `unit` | `test/unit/**/*.test.ts` | — |
| `arch` | `test/arch/**/*.test.ts` | — |
| `metrics-fast` | `test/metrics/**/*.metric.ts` | `METRICS_TIER=fast` |
| `metrics-quick` | same | `METRICS_TIER=quick` |
| `metrics-full` | same | `METRICS_TIER=full` |
| `bench` | `include: []`; `benchmark.include: ['test/bench/**/*.bench.ts']` | — |

- Vitest 5 benches use the test-context fixture — `test('<id>', async ({ bench }) => { await bench('<name>', fn).run() })` — not a top-level `bench` export; bench files are reachable only through the derived `bench (bench)` project. Baselines (`baselines.json`, §6.1) are wired in SP1.
- Fixture files are never named `*.test.ts`, `*.metric.ts` or `*.bench.ts`, so no project collects them.
- **Amends §1 and §10 SP0**, which listed four projects (`unit | metrics | metrics-full | bench`); the six above replace them, and both master lines are edited with this spec.

## Governance mechanisms

**Shared ids.** `src/core/ids.ts` exports only types: `SubProjectId` (§2.5) and `MetricId` (every §6.4 ID, with E1-E6 expanded to E1…E6). `test/` imports them with `import type`. This **amends §2.5**: `MetricDef` drops `threshold` and `activeFrom` (they live only in the locked `THRESHOLDS`), and `run(region)` returns `Record<string, number>` keyed by part.

**Started sub-projects.** `test/harness/sp.ts` exports `STARTED_SPS: readonly SubProjectId[]` (`['SP0']` now), an append-only list of every SP whose first commit has landed, and `SP_DEPS` transcribed from the §10 headers (SP1←SP0, SP2←SP1, SP3←SP2, SP4←SP3, SP5←SP4, SP6←SP3+SP5, SP7←SP6+SP5, SP8a←SP4, SP8b←SP7+SP8a, SP8c←SP7+SP5, SP9←SP8b+SP8a, SP10←SP9, SP11←SP10, SP12←SP11). A linear "current SP" cannot represent the parallel SPs of §10 (SP8a with SP5-SP7, SP8c with SP8a/SP8b); a started-set can. Each SP appends its id in its first commit. `test/arch/sp.test.ts` checks that ids are unique and that every entry's dependencies appear before it.

**Thresholds.** `test/thresholds.ts` exports `THRESHOLDS: Partial<Record<MetricId, Record<string, ThresholdPart>>>` with `interface ThresholdPart { min?: number; max?: number; activeFrom: SubProjectId }` (empty in SP0). Part keys are stable slugs, one per threshold cell of the §6.4 row (e.g. `T1: {band, span, share120, share200}`, `G1: {mediumP95, …, highHeap}`); a single-cell row uses `value`. `activeFrom` is **per part**, as the master Definition of done requires.

- A part is **active** iff `STARTED_SPS.includes(part.activeFrom)`. Only active parts are asserted.
- An inactive part whose metric already exists still **runs and records** its value to `test/metrics/.out/<ID>.json`, then calls `ctx.skip(true, 'inactive until <activeFrom> (value recorded)')` and never fails. This is how R4 is "measured and recorded, not gated" in SP4.
- Metric tests register through one helper, `metricTest(id, parts, fn)` (`test/harness/metric.ts`). `test/arch/thresholds.test.ts` scans `test/metrics/**/*.metric.ts` for `metricTest('<ID>', [...])` calls and fails when an active part is not covered by exactly one call, or a call names an ID/part that `THRESHOLDS` lacks.

**Lock.** `test/thresholds.lock.json` stores `{ sha256, canonical }`, where `canonical` is the canonical JSON (keys sorted, `undefined` dropped) of `{ thresholds: THRESHOLDS, startedSps: STARTED_SPS }`. `thresholds.test.ts` fails when `canonical` differs from the live value or the hash does not match, printing for each ID/part `added | removed | min a→b | max a→b | activeFrom a→b` tagged **LOOSEN** (lower min, higher max, later activeFrom, removed active part, removed started SP) or **TIGHTEN**. With `ACCEPT_THRESHOLDS=1` it rewrites both fields and prints the same diff instead of failing.

**Goldens.** `test/goldens.json` is `{ generatorVersion, entries }`. `expectGolden(key, hash)` uses a store from `createGoldenStore(path = 'test/goldens.json')`; `goldens.test.ts` passes a temporary copy.
- Normal mode: `goldens.generatorVersion !== GENERATOR_VERSION` → fail ("run `npm run test:goldens`"); missing entry → fail with the same hint; mismatch → fail.
- `UPDATE_GOLDENS=1`: every `expectGolden` call writes its observation to `test/.cache/goldens-obs/`; `npm run test:goldens` then runs `MERGE_GOLDENS=1 vitest run --project arch test/arch/goldensMerge.test.ts`, which merges them once: new keys are added; changed existing entries are accepted only if `GENERATOR_VERSION > goldens.generatorVersion`, otherwise the run fails listing every such key and writes nothing; `generatorVersion` is set once, at the end. (A root `globalSetup` was dropped because inline vitest projects inherit it and would run it once per project.)

**CI governance check.** `test/arch/governance.test.ts` runs when `GOVERNANCE_BASE` is set (CI) and is otherwise skipped ("no base ref"). Using `git show` / `git diff --name-only` against that ref:
- if a key present in the base `test/goldens.json` changed or disappeared, `GENERATOR_VERSION` (parsed from `src/core/constants.ts` at both refs) must have increased — this also catches hand-edited goldens;
- if `test/thresholds.lock.json` changed, some file under `docs/superpowers/specs/` must have changed in the same range.

## Arch tests

### Scanner (`test/arch/scan.ts`)

- Takes a root directory (fixtures pass their own) and lists `**/*.{ts,mts,cts,js,mjs,cjs,css,html,glsl,vert,frag,wgsl}` under `src/`, plus `index.html`.
- Extracts edges from: static `import … from` / `import '…'` / `export … from` (multi-line included); dynamic `import('…')` (a non-literal argument is itself a violation); `new Worker|SharedWorker(new URL('…', import.meta.url))` (a **worker** edge) and any other `new URL('…', import.meta.url)`; `import.meta.glob('…')`; `/// <reference path="…">`; CSS `@import` / `url(…)`; HTML `src` / `href`.
- An edge is **type-only** only for `import type …` and `export type … from`. `import { type X } from` is a value edge (verbatimModuleSyntax keeps `import {} from`, which Vite still loads — verified). TypeScript `import('…')` type expressions are banned; write `import type`.
- Specifiers are extracted first; the token rules then run on the text with comments and string/template contents blanked (the GLSL rule blanks only comments).
- A file's layer is its first path segment under `src/`; `src/main.ts` is the layer `main`. Any other unclassified path fails until the table below is amended.
- **Hardening done during implementation:** a dynamic `import()` with a non-literal or interpolated argument yields `dynamic-nonliteral` (a literal argument plus an import-attributes second argument still counts as a literal edge); a bare `import('…')` type expression is classified as `type-import-expr` only when it has no member access and sits after `typeof`, after `extends`, or inside a `type X = …` alias — a plain value-position annotation like `let v: import('…')` is accepted as a value edge; `blankJs` recognises regex literals (so a `/…/` after an operator or keyword is not mistaken for a comment start) and keeps `${…}` template expressions live as code while still blanking the surrounding template text; a match whose start position lies inside string or template text (rather than real code) is discarded by comparing the comments-only blank against the strings-blanked-too pass; and file extensions are compared case-insensitively throughout.

### Dependency table (`imports.test.ts`) — refines §1 "Dependency rules"

Rules apply to value and type-only edges alike unless the cell says type-only.

| layer | may import | type-only |
|---|---|---|
| core | core | — |
| world | core, world | — |
| gen | core, gen, `world/blocks/**` | `world/store/api.ts` (no other `world/store/*` file) |
| textures | core, textures | — |
| audio | core, audio, `world/blocks/**` | `world/store/api.ts` |
| light, mesh | core, `world/blocks/**`, `world/store/padded.ts`, gen, textures, audio, light, mesh | `world/store/api.ts` (never `slab.ts`, `columnTable.ts`, `section.ts`, `aux.ts`, `versions.ts`) |
| sim, persist | core, world, gen, textures, audio, light, mesh, sim, persist | — |
| metrics | the sim/persist row plus metrics | — |
| daynight | core, daynight | — |
| workers | core, world, gen, textures, audio, light, mesh, sim, persist, metrics, daynight, workers | — |
| engine | core, world, engine, `workers/protocol.ts` | gen, textures, audio, light, mesh, sim, persist, metrics |
| render | core, world, light, mesh, textures, daynight, render, `workers/protocol.ts` | — (never gen, types included) |
| player | core, world, daynight, player, `workers/protocol.ts` | engine, render (not `render/materials/**`) |
| sound | core, world, audio, daynight, sound, `workers/protocol.ts` | engine |
| ui | every layer except `render/materials/**` and `*.worker.ts` | — |
| main | every layer except `*.worker.ts` | — |

Additional edges:
- `render/materials/**` is imported only from `render/**`.
- `three` and `three/*` (type-only included) are imported only from `render/**`. This resolves §1's "(plus ui canvases)": ui canvases are 2D and never import three; §1 is amended to drop the parenthetical.
- A `*.worker.ts` file is never imported; it is referenced only from `engine/**` through a worker edge (`new Worker(new URL('../workers/<name>.worker.ts', import.meta.url), { type: 'module' })`). A worker edge anywhere else is a violation.
- No `src/` file imports `test/**`, except `test/goldens.json` (SP2 `?selftest=1`, from `main` or `ui`) and `test/thresholds.ts` (from `ui/metricsDashboard.ts`, SP10).
- **§8 risk 1 tightening:** `light/` and `mesh/` never import the SAB implementation files (see the table); SAB-backed `ColumnWriter`/`NeighborhoodReader` are built in `workers/*` and `engine/` and injected, so the snapshot-transport fallback stays local to the store.

### Resolution and dependencies

Every edge target must resolve inside the repository root: relative specifiers are resolved and passed through `fs.realpathSync` (symlinks cannot escape); bare specifiers are resolved with Node resolution plus realpath and must land under `<root>/node_modules`; URL schemes (`http:`, `https:`, `file:`, `data:`, `blob:`), protocol-relative `//…` and absolute paths fail. This scan covers `src/**`, `test/**` (except `test/arch/fixtures/**`), `index.html` and the root config files. Also checked: no `resolve.alias` in the Vite/Vitest configs and no `paths`/`baseUrl` in the tsconfigs; every `package.json` dependency is a registry semver range; `dependencies` has exactly one key, `three` (D7), and bare specifiers under `src/` are only `three` or `three/*`.

### Banned APIs (`banned.test.ts`)

- In `core/`, `world/`, `gen/`: `Math.random`, `Date.now`, `performance.now`, `console.`.
- In `gen/` and `core/noise/`: the only `Math` members allowed are `abs`, `floor`, `ceil`, `round`, `trunc`, `sign`, `min`, `max`, `imul`, `fround`, `clz32`, `sqrt` and the constants `PI`, `E`, `LN2`, `LN10`, `LOG2E`, `LOG10E`, `SQRT2`, `SQRT1_2`. Any other `Math.<name>`, computed `Math[…]`, `Math` used as a value (destructuring, aliasing) and the `**` / `**=` operators fail. Transcendentals come from `core/detMath`.
- In `gen/`: no exported binding whose initializer is a numeric expression (any literal form, unary/binary arithmetic of literals, parenthesised, `as const`/`satisfies`, annotated), covering `export const|let|var`, multi-declarator exports, `export default <numeric>` and `export { X }` of a module-level numeric binding. Exported objects/arrays containing numbers are allowed only in `gen/**/defaults.ts` and `gen/structures/templates/**` (preset data referenced by ParamSchema).
- In the pure layers `core/`, `world/`, `gen/`, `textures/`, `audio/`, `light/`, `mesh/`, `sim/`, `persist/`, `metrics/`, `daynight/`: no reference to `document`, `window`, `indexedDB`, `localStorage`, `sessionStorage`; the only exception is `indexedDB`/`IDB*` in `persist/idb.ts` (runs in the sim worker). In `core/` additionally no worker APIs (`self`, `postMessage`, `importScripts`, `onmessage`, `new Worker`, `new SharedWorker`).
- `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile`, `ShaderChunk`, `ShaderLib`, `glslVersion` and the GLSL markers `#version`, `gl_Position`, `gl_FragColor`, `gl_FragCoord`, `precision (highp|mediump|lowp)` appear only under `render/materials/**` (GLSL lives in `*.glsl.ts` template literals). Raw shader files (`.glsl`, `.vert`, `.frag`, `.wgsl`) and `?raw` imports are not allowed anywhere.
- WebAudio (`AudioContext`, `webkitAudioContext`, `OfflineAudioContext`, `AudioWorklet`, `AudioWorkletNode`, `AudioWorkletProcessor`, `registerProcessor`, `decodeAudioData`) appears only under `sound/`; three's audio classes (`Audio`, `AudioListener`, `PositionalAudio`, `AudioLoader`, `AudioAnalyser`) are never imported.
- Anywhere in the repository: no file whose extension (case-insensitive) is `.ogg`, `.oga`, `.mp3`, `.wav`, `.flac`, `.m4a`, `.aac`, `.opus` or `.weba` (D17). Files checked: `git ls-files --cached --others --exclude-standard`, or, without git, a walk that skips `node_modules/`, `dist/`, `.git/`, `test/.cache/`.
- **Hardening done during implementation:** numeric-export detection covers multi-declarator statements (`export const a = 1, b = 2`), `export { X }` of a module-level numeric binding, an initializer wrapped onto the next line, and `0b`/`0o` numeric literals, in addition to the forms already listed above; the three audio classes are also caught when imported through a namespace import (`import * as THREE from 'three'`), a default import, or re-exported by name from `'three'` (`export { Audio } from 'three'`), not only through a direct named import.

### Headers and subresources (`headers.test.ts`)

- Imports `vite.config.ts` and parses `vercel.json`: `server.headers`, `preview.headers` and the `vercel.json` entry with `source: "/(.*)"` each equal exactly `{ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }`; `server.port === preview.port === 5183` with `strictPort: true`; `worker.format === 'es'` (Vite 8 still defaults to `'iife'`).
- No cross-origin subresources (§8 risk 1): `index.html`, `src/**/*.css` and `src/**/*.ts` contain no `http(s)://` or `//` URL in `<script src>`, `<link href>`, `<img src>`, CSS `@import`/`url()`, `fetch(`, `import(`, `new URL(`, `new Worker(` or `importScripts(`. Plain text (e.g. the capability report's "open via http://localhost:<port>") is allowed.

### Self-tests

Each rule has `test/arch/fixtures/<rule>/bad/` (must be reported with exact file and line) and `good/` (must pass). The good trees include at least: `gen/` with `import type { ColumnWriter } from '../world/store/api'` and a value import of `world/blocks/registry`; `persist/idb.ts` using `indexedDB`; `engine/workerPool.ts` spawning `task.worker.ts`; `workers/sim.worker.ts` importing `persist/idb.ts`, `sim/`, `textures/`, `audio/`; `render/` importing values from `mesh/packing`; `core/` with a comment and a string mentioning `Math.random` and `console.log`; `gen/` using `Math.floor` and `Math.imul`; an exported `Expr` object in `gen/density/defaults.ts`. The bad trees include `import { type X } from '../world/store/api'` in `gen/`. Fixtures are excluded from `tsconfig.test.json` and from the repository-wide scans; audio-file fixtures are created in a temporary directory at test time and never committed.

## Capability probe and report

`CapabilityReport` is declared in `engine/capabilityRules.ts` (DOM-free); `engine/capabilities.ts` fills it:

| field | how |
|---|---|
| `secureContext` | `isSecureContext` |
| `pageIsolated` | `crossOriginIsolated` |
| `workerProbe`, `workerIsolated`, `sabShared` | spawn `probe.worker.ts` via `new Worker(new URL('../workers/probe.worker.ts', import.meta.url), { type: 'module' })`. If `typeof SharedArrayBuffer !== 'function'`, post `{ sab: null }` and set `sabShared = false`; otherwise post a `SharedArrayBuffer(8)`, the worker does `Atomics.store(view, 0, 42)` and replies `{ isolated: crossOriginIsolated }`, and the page checks `Atomics.load(view, 0) === 42`. `workerProbe: 'ok' \| 'not-isolated' \| 'load-error' \| 'timeout'` (`error`/`messageerror` → load-error; no reply within 5 s → timeout). `workerIsolated: boolean \| null` (null unless the worker replied) |
| `webgl2` | `canvas.getContext('webgl2')`; the context is released with `WEBGL_lose_context` after reading |
| `multiDraw`, `timerQuery` | `WEBGL_multi_draw`, `EXT_disjoint_timer_query_webgl2` |
| `maxArrayTextureLayers`, `maxTextureSize` | `gl.getParameter` |
| `renderer`, `vendor` | `WEBGL_debug_renderer_info` (unmasked when available) |
| `hardwareConcurrency`, `deviceMemory` | `navigator`; `deviceMemory: number \| null` via `(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null` |

`capabilityRules.ts` (pure, unit-tested) produces:
- **blocking causes:** not a secure context ("open via http://localhost:<port> or HTTPS"); page not isolated ("COOP/COEP headers missing on the page"); worker not isolated ("worker scripts are missing the COOP/COEP headers"); worker load error ("worker script failed to load (see console)"); worker timeout ("worker did not answer within 5 s"); SAB not shared; no WebGL2;
- **warnings:** no multi-draw (RegionMesh fallback from SP4); no timer query (GPU ms unavailable).

Blocking causes show a full-screen error screen naming each one; otherwise the shell starts and the report sits in the side panel with a "copy as JSON" button.

## Shell, renderer and HUD

- `index.html` + `ui/shell.ts`: CSS grid `toolbar / canvas / side panel`, sized by the viewport (no fixed pixel header), `ResizeObserver` on the canvas cell; `styles.css` imported from TS (typed through `vite/client`).
- `render/renderer.ts`: `WebGLRenderer` (antialias off for now; presets arrive in SP11), `setPixelRatio(min(devicePixelRatio, 1))`, `outputColorSpace = SRGBColorSpace`, clear colour a sky blue, a `requestAnimationFrame` loop that only clears; resize from the observer.
- `ui/frameStats.ts` (pure) keeps the last 120 frame times and computes FPS, p50 and p95; `ui/hud.ts` renders them at 4 Hz.

## Delivery rails

- **`vite.config.ts`**: `server` and `preview` on port 5183 with `strictPort` and the exact COOP/COEP headers; `worker.format = 'es'`; `build.chunkSizeWarningLimit = 1024` (three alone is ≈ 520 kB minified); `server.allowedHosts = ['world-imaginer-voxel', ...(process.env.VITE_ALLOWED_HOSTS?.split(',') ?? [])]` (localhost and IPs are allowed by default; Vite 8 answers other hosts with 403).
- **`vercel.json`**: the same two headers for `source: "/(.*)"`; build `npm run build`, output `dist`. The user links the Vercel project to the repository root.
- **Dockerfile**: `node:24-slim`, `npm ci`, `npx vite --host 0.0.0.0 --port 5183`. **`.dockerignore`**: `node_modules`, `dist`, `.git`, `test/.cache`. **`docker-compose.yml`**: service `world-imaginer-voxel`, container `world_imaginer_voxel`, `5183:5183`, bind mount plus a `node_modules` volume, external network `maestre-web_app-network`. Open it through `http://localhost:5183` to keep the secure context; a reverse proxy must forward its host via `VITE_ALLOWED_HOSTS`, terminate TLS and pass COOP/COEP through unchanged.
- **CI** (`.github/workflows/ci.yml`): on `push` (all branches) and `pull_request` (D19); `permissions: { contents: read }`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; `ubuntu-latest`; `actions/checkout@v7` with `fetch-depth: 0`; `actions/setup-node@v7` with `node-version-file: .nvmrc` and `cache: npm`; `npm ci`; `npm run build`; `npm test` with `GOVERNANCE_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}` (an all-zero `before` skips the governance test); `npm run test:metrics`. The `actions/cache@v6` step for `test/.cache` is added in SP3, when the region cache exists (before that its post step would log a warning on every run). Action inputs were checked against their `action.yml`.
- **README / CLAUDE.md**: replace the "no code yet" notes with the real commands (`npm run dev|build|typecheck|test|test:metrics|test:metrics:full|bench|test:accept-thresholds|test:goldens`, `docker compose up world-imaginer-voxel`); the CLAUDE.md dev-dependency list adds `@types/node`; both status sections say SP0 is complete.

## Tests and exit criteria

Automated (in `npm test`, and in CI):
- arch rules with their good/bad fixture self-tests; headers and subresource checks; SP list checks; thresholds lock and coverage; goldens rules on a temporary copy; governance (CI only);
- `capabilityRules` unit tests (every blocking cause and warning from canned reports); `frameStats` maths;
- **SAB round-trip across 2 `worker_threads`**: the test allocates a `SharedArrayBuffer`, starts two workers from `test/unit/fixtures/sabWorker.mjs`; each does 100k `Atomics.add` on a shared counter, then a 50-round `Atomics.wait/notify` ping-pong logged into the SAB; the total (200 000) and the alternating sequence must be exact. Every `Atomics.wait` uses a 5000 ms timeout and a `'timed-out'` result fails the test; both workers are terminated in `afterEach`. (Verified in the spike: passes 20/20 repeats under both vitest pools.)

Exit (master §10 SP0):
- arch tests green; CI green on `main`; SAB round-trip green; thresholds-lock test green; `npm run build` passes; `npm test`, `npm run test:metrics`, `npm run test:metrics:full` and `npm run bench` exit 0 (the last three with no files);
- **manual**: in `npm run dev`, `npm run preview`, `docker compose up` (via `http://localhost:5183`) and a Vercel preview deployment (triggered by the user), the capability report shows `secureContext`, `pageIsolated`, `workerIsolated` and `sabShared` all true; screenshots saved under `docs/superpowers/specs/assets/sp0/` (the spike already confirmed dev and preview in headless Chrome);
- visual review: the shell at desktop size with the sky canvas and the report.

Cut line: the Vercel preview check (→ SP4).

## Master-spec amendments made with this spec

- §1 package.json dev deps add `@types/node`.
- §1 and §10 SP0 vitest projects become `unit | arch | metrics-fast | metrics-quick | metrics-full | bench`.
- §1 dependency rules are refined by the table above (including the `light`/`mesh` store isolation and the worker-edge rule); the "(plus ui canvases)" parenthetical is dropped.
- §2.5 `MetricDef` loses `threshold`/`activeFrom` (locked `THRESHOLDS` is the single source) and `run()` returns per-part values; `SubProjectId`/`MetricId` live in `src/core/ids.ts`.

## Open items handed to later SPs

- **Running TypeScript in `worker_threads` for the harness (SP3).** Node type stripping needs explicit `.ts` extensions, while the codebase uses bundler-style extensionless imports. SP3 decides between bundling harness worker entry points (Vite/Rolldown) and switching to explicit `.ts` extensions with `allowImportingTsExtensions`. SP0 sidesteps it with a plain `.mjs` fixture and by running acceptance through vitest.
- **Metric registry shape.** `MetricDef.run(region)` and `RegionView` arrive with the harness (SP2/SP3); SP0 fixes only `THRESHOLDS`, per-part `activeFrom`, the lock and `metricTest`.

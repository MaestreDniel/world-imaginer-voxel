# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.

**Status:** SP0 complete (2026-09-27), SP1 complete (2026-09-28), SP2a complete (2026-09-30, GENERATOR_VERSION 3), SP2b complete (2026-10-02, GENERATOR_VERSION 3), SP3a complete (2026-10-03, GENERATOR_VERSION 3). SP3b (density and terrain shape) in progress.

## Source of truth

- `docs/superpowers/specs/2026-09-26-architecture-design.md` is the master spec. Its **Decisions log (D1-D20) is authoritative** and overrides any other text.
- Every sub-project (SP0-SP12, spec §10) runs spec → plan → TDD implementation. SP specs live in `docs/superpowers/specs/YYYY-MM-DD-sp<N>-<topic>-design.md`, plans in `docs/superpowers/plans/`. A deviation from the master spec is made by amending it explicitly.

## Commands

- `npm run dev` / `npm run preview` — http://localhost:5183 (COOP/COEP headers; open via localhost or HTTPS)
- `npm run build` — `typecheck` (three tsconfigs) + `vite build`
- `npm test` — vitest projects `unit`, `arch`, `metrics-fast`, then `integration` (real worker threads, one file at a time); `npm run test:metrics` (quick, CI), `npm run test:metrics:full` (SP exit), `npm run bench`
- `npm run bench:record` — write `test/baselines.json` on the reference machine (per-kernel ratios to a calibration kernel, plus the lattice3/perm512 kill ratio); `npm run bench` gates +30 % per kernel and kill ratio ≤ 1.6
- `npm run test:accept-thresholds` — rewrite `test/thresholds.lock.json` (needs a spec amendment in the same change; CI checks it)
- `npm run test:goldens` — record and merge goldens (refuses changed goldens without a `GENERATOR_VERSION` bump)
- `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
- `npm run test:accept-state-ids` — append the states of new block types to `test/stateIds.lock.json` (append-only: refuses a changed id, a removed entry or a new state of a locked type; the commit message says the lock changed)
- `npm run docs:params` — regenerate the README parameter table from the schema
- `npm run docs:review-slices` — write the SP3a review PNG slices of the provisional terrain (a coast, a lake and a river, and y 62; seed 42) into `docs/superpowers/specs/assets/sp3a/` through the region harness
- `npx --yes bun@1 test/tools/goldensJsc.ts` — recompute every golden (SP1, SP2a and SP3a) under JavaScriptCore (D20; SP exit evidence); `?selftest=1` does the same in a real module worker in Chrome and Firefox, and `?lab=noise` keeps the SP1 panel
- `?map` — the world map (SP2a) and the parameter editor (SP2b): toolbar, parameter panel, spline drawer, biome table and share chart, presets, cut-line cross-section with its Profile | Voxels toggle (SP3a: the real vertical slice of voxels), global undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), P toggles the panel
- `?map&perf=edit` — the same page with the SP2b latency hook (`src/ui/map/perfHook.ts`, `globalThis.__wiPerf`): pins the canvas to 1100 × 825 at seed 42, default profile, view (0, 0, 64 bpp)
- `node test/tools/mapLatency.ts [--profile-dir DIR]` — the SP2b §2.8 edit → preview latency runner (not in CI; about 35 min): builds, serves `dist` on its own free port (never 5183), drives its own headless Chrome and writes `docs/superpowers/specs/assets/sp2b/latency-*.json`; `--quick` for a short run
- `node test/tools/uiSmoke.ts [--profile-dir DIR] [--shots DIR]` — the SP2b UI smoke test (not in CI; about 1 min; SP3a adds the Voxels toggle): `?selftest=1`, then every editor driven with real pointer and key input and checked through the DOM and the URL, no console errors; `--shots` also writes the spec §12 screenshots
- `docker compose up world-imaginer-voxel`
- Each sub-project appends its id to `STARTED_SPS` in `test/harness/sp.ts` in its first commit. Appending changes the lock (`test/thresholds.lock.json`), so run `npm run test:accept-thresholds` and amend the spec in the same change.

## Conventions

- TypeScript strict. Runtime dependency: `three` only. Dev dependencies: `vite`, `typescript`, `vitest`, `@types/three`, `@types/node`.
- Tests are mandatory (vitest): unit, arch and metric tests. Metric thresholds are locked (`test/thresholds.lock.json`); never loosen one without amending the spec. Golden changes require a `GENERATOR_VERSION` bump.
- Layer rules (spec §1) are enforced by arch tests: `core` ← `world` ← `gen` ← L2 (`light`, `mesh`, `sim`, `persist`, `metrics`); `render/` is the only place three is imported and `render/materials/**` the only place GLSL lives; `sound/` is the only place WebAudio is used.
- In `core/`, `world/` and `gen/`: no `Math.random`, `Date.now`, `performance.now` or `console.*`; in `gen/` no `Math.sin/cos/exp/...` (use `core/detMath`) and no exported numeric constants (tunables live in `ParamSchema`).
- No audio files (`.ogg`/`.mp3`/`.wav`) in the repository; sound packs are user-supplied.
- Conventional commits scoped by area: `feat(gen):`, `feat(render):`, `fix(store):`, `test(metrics):`, `docs(spec):`, …
- Determinism (SP1): in `core/noise/**`, `core/spline/**`, `metrics/**` and `world/blocks/**` (SP3a) an imported value binding is used only through a top-level `const` alias (vitest turns imports into getters; arch-tested); `core/`, `gen/` and `world/blocks/**` never call `Intl`, `localeCompare`, `toLocale*`, `.normalize(`, `TextEncoder` or `TextDecoder`; `Math.fround` is banned in `core/`, `gen/` and `world/blocks/**`.
- Generator outputs are NaN-free; every golden hasher writes NaN as `0x7FF8000000000000` (`hashF64`). Every validated parameter number goes through `q15`; canonical JSON throws on NaN, ±Infinity and −0.
- A noise leaf's seed name is its path; renaming the path needs `seedName` to keep the same worlds.

## Runtime and deployment

- SharedArrayBuffer needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page **and** every worker script, in a secure context (`http://localhost:<port>` or HTTPS; a reverse proxy must terminate TLS and pass the headers through).
- Vercel is linked to the repository root and sets the headers via `vercel.json`. Docker: own `docker-compose.yml`, port 5183, default compose network (no external network). Production: Vercel project `world-imaginer-voxel` (https://world-imaginer-voxel.vercel.app), separate from maestre-web-next.

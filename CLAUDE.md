# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.

**Status:** SP0 complete (2026-09-27). SP1 (deterministic math core) in implementation on branch `sp1/math-core`.

## Source of truth

- `docs/superpowers/specs/2026-09-26-architecture-design.md` is the master spec. Its **Decisions log (D1-D20) is authoritative** and overrides any other text.
- Every sub-project (SP0-SP12, spec §10) runs spec → plan → TDD implementation. SP specs live in `docs/superpowers/specs/YYYY-MM-DD-sp<N>-<topic>-design.md`, plans in `docs/superpowers/plans/`. A deviation from the master spec is made by amending it explicitly.

## Commands

- `npm run dev` / `npm run preview` — http://localhost:5183 (COOP/COEP headers; open via localhost or HTTPS)
- `npm run build` — `typecheck` (three tsconfigs) + `vite build`
- `npm test` — vitest projects `unit`, `arch`, `metrics-fast`; `npm run test:metrics` (quick, CI), `npm run test:metrics:full` (SP exit), `npm run bench`
- `npm run bench:record` — write `test/baselines.json` on the reference machine (per-kernel ratios to a calibration kernel, plus the lattice3/perm512 kill ratio); `npm run bench` gates +30 % per kernel and kill ratio ≤ 1.6
- `npm run test:accept-thresholds` — rewrite `test/thresholds.lock.json` (needs a spec amendment in the same change; CI checks it)
- `npm run test:goldens` — record and merge goldens (refuses changed goldens without a `GENERATOR_VERSION` bump)
- `npm run test:accept-schema` — rewrite `test/schema-shape.lock.json` (refuses a removed, renamed or re-kinded leaf unless `SCHEMA_VERSION` was bumped with a migration)
- `npm run docs:params` — regenerate the README parameter table from the schema
- `docker compose up world-imaginer-voxel`
- Each sub-project appends its id to `STARTED_SPS` in `test/harness/sp.ts` in its first commit. Appending changes the lock (`test/thresholds.lock.json`), so run `npm run test:accept-thresholds` and amend the spec in the same change.

## Conventions

- TypeScript strict. Runtime dependency: `three` only. Dev dependencies: `vite`, `typescript`, `vitest`, `@types/three`, `@types/node`.
- Tests are mandatory (vitest): unit, arch and metric tests. Metric thresholds are locked (`test/thresholds.lock.json`); never loosen one without amending the spec. Golden changes require a `GENERATOR_VERSION` bump.
- Layer rules (spec §1) are enforced by arch tests: `core` ← `world` ← `gen` ← L2 (`light`, `mesh`, `sim`, `persist`, `metrics`); `render/` is the only place three is imported and `render/materials/**` the only place GLSL lives; `sound/` is the only place WebAudio is used.
- In `core/`, `world/` and `gen/`: no `Math.random`, `Date.now`, `performance.now` or `console.*`; in `gen/` no `Math.sin/cos/exp/...` (use `core/detMath`) and no exported numeric constants (tunables live in `ParamSchema`).
- No audio files (`.ogg`/`.mp3`/`.wav`) in the repository; sound packs are user-supplied.
- Conventional commits scoped by area: `feat(gen):`, `feat(render):`, `fix(store):`, `test(metrics):`, `docs(spec):`, …
- Determinism (SP1): in `core/noise/**`, `core/spline/**` and `metrics/**` an imported value binding is used only through a top-level `const` alias (vitest turns imports into getters; arch-tested); `core/` and `gen/` never call `Intl`, `localeCompare`, `toLocale*`, `.normalize(`, `TextEncoder` or `TextDecoder`; `Math.fround` is banned in `core/` and `gen/`.
- Generator outputs are NaN-free; every golden hasher writes NaN as `0x7FF8000000000000` (`hashF64`). Every validated parameter number goes through `q15`; canonical JSON throws on NaN, ±Infinity and −0.
- A noise leaf's seed name is its path; renaming the path needs `seedName` to keep the same worlds.

## Runtime and deployment

- SharedArrayBuffer needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page **and** every worker script, in a secure context (`http://localhost:<port>` or HTTPS; a reverse proxy must terminate TLS and pass the headers through).
- Vercel is linked to the repository root and sets the headers via `vercel.json`. Docker: own `docker-compose.yml`, port 5183, default compose network (no external network). Production: Vercel project `world-imaginer-voxel` (https://world-imaginer-voxel.vercel.app), separate from maestre-web-next.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Browser voxel explorer + editor (TypeScript, Vite, three.js r186 WebGL2 with custom GLSL3 ShaderMaterials). Successor of `09-density-terrain` in [world-imaginer](https://github.com/MaestreDniel/world-imaginer); nothing is imported or copied wholesale from there.

**Status:** design approved, no code yet. SP0 (scaffold, guardrails, CI) is next. Update the Commands section when SP0 lands.

## Source of truth

- `docs/superpowers/specs/2026-09-26-architecture-design.md` is the master spec. Its **Decisions log (D1-D19) is authoritative** and overrides any other text.
- Every sub-project (SP0-SP12, spec §10) runs spec → plan → TDD implementation. SP specs live in `docs/superpowers/specs/YYYY-MM-DD-sp<N>-<topic>-design.md`, plans in `docs/superpowers/plans/`. A deviation from the master spec is made by amending it explicitly.

## Commands

None yet. SP0 adds: `npm run dev`, `npm run build`, `npm test` (unit + arch + fast metrics), `npm run test:metrics`, `npm run test:metrics:full`, `npm run bench`, `npm run test:accept-thresholds`, `npm run test:goldens`.

## Conventions

- TypeScript strict. Runtime dependency: `three` only. Dev dependencies: `vite`, `typescript`, `vitest`, `@types/three`.
- Tests are mandatory (vitest): unit, arch and metric tests. Metric thresholds are locked (`test/thresholds.lock.json`); never loosen one without amending the spec. Golden changes require a `GENERATOR_VERSION` bump.
- Layer rules (spec §1) are enforced by arch tests: `core` ← `world` ← `gen` ← L2 (`light`, `mesh`, `sim`, `persist`, `metrics`); `render/` is the only place three is imported and `render/materials/**` the only place GLSL lives; `sound/` is the only place WebAudio is used.
- In `core/`, `world/` and `gen/`: no `Math.random`, `Date.now`, `performance.now` or `console.*`; in `gen/` no `Math.sin/cos/exp/...` (use `core/detMath`) and no exported numeric constants (tunables live in `ParamSchema`).
- No audio files (`.ogg`/`.mp3`/`.wav`) in the repository; sound packs are user-supplied.
- Conventional commits scoped by area: `feat(gen):`, `feat(render):`, `fix(store):`, `test(metrics):`, `docs(spec):`, …

## Runtime and deployment

- SharedArrayBuffer needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page **and** every worker script, in a secure context (`http://localhost:<port>` or HTTPS; a reverse proxy must terminate TLS and pass the headers through).
- Vercel is linked to the repository root and sets the headers via `vercel.json`. Docker: own `docker-compose.yml`, port 5183, external network `maestre-web_app-network`.
